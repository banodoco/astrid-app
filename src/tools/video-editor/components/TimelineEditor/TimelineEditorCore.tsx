import { getEffectiveClipVolume } from '@/tools/video-editor/lib/clip-volume.ts';
import { useOptionalVideoEditorRuntime as useMarqueeEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import type { DataLaneView } from '@/tools/video-editor/data/typed/envelope.ts';
// Layer map & invariants: docs/structure_detail/tool_video_editor.md
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { shallow } from 'zustand/shallow';
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import type { Shot } from '@/domains/generation/types/index.ts';
import { userSelectTimelineClip } from '@/shared/state/selectionStore.ts';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import '@/tools/video-editor/components/TimelineEditor/timeline-overrides.css';
import { useRenderDiagnostic } from '@/tools/video-editor/hooks/usePerfDiagnostics.ts';
import { ClipAction } from '@/tools/video-editor/components/TimelineEditor/ClipAction.tsx';
import { DropIndicator } from '@/tools/video-editor/components/TimelineEditor/DropIndicator.tsx';
import { TimelineCanvas } from '@/tools/video-editor/components/TimelineEditor/TimelineCanvas.tsx';
import { ROW_HEIGHT, getTimelineLabelWidth } from '@/tools/video-editor/lib/coordinate-utils.ts';
import { EDIT_AREA_SELECTOR } from '@/tools/video-editor/lib/timeline-dom.ts';
import { computeTimelineExtent, maxClipEndSeconds } from '@/tools/video-editor/lib/timeline-scale.ts';
import type { ClipMeta } from '@/tools/video-editor/lib/timeline-data.ts';
import {
  useTimelineChromeSelector,
  useTimelineDataSelector,
  useTimelineOpsSelector,
} from '@/tools/video-editor/hooks/timelineStore.ts';
import { useClipDrag } from '@/tools/video-editor/hooks/useClipDrag.ts';
import { useActiveTaskClips } from '@/tools/video-editor/hooks/useActiveTaskClips.ts';
import { useMarqueeSelect } from '@/tools/video-editor/hooks/useMarqueeSelect.ts';
import { maxShotGroupEndSeconds, projectCanonicalShotRows, type ShotGroup } from '@/tools/video-editor/hooks/useShotGroups.ts';
import type { CanonicalShotOccurrence } from '@/tools/video-editor/data/shotCompositionAdapter.ts';
import { useStaleVariants } from '@/tools/video-editor/hooks/useStaleVariants.ts';
import { useAddVariantAsGeneration } from '@/tools/video-editor/hooks/useAddVariantAsGeneration.ts';
import { useTimelineScale } from '@/tools/video-editor/hooks/useTimelineScale.ts';
import {
  clampClipToMediaDuration,
  convertOverhangToHold,
  detectClipOverhang,
} from '@/tools/video-editor/lib/overhang.ts';
import { insertEffectLayerAt } from '@/tools/video-editor/lib/external-drop-utils.ts';
import { getTimelinePostprocessShader } from '@/tools/video-editor/lib/timeline-domain.ts';
import { getAssetFileLocator } from '@/tools/video-editor/lib/asset-registry.ts';
import type { TimelineActionResizeStart, TimelineClipEdgeResizeEnd } from '@/tools/video-editor/hooks/useTimelineState.types.ts';
import type { ResolvedTimelineClip, TimelinePostprocessShaderMetadata, TrackDefinition } from '@/tools/video-editor/types/index.ts';
import type { TimelineAction, TimelineRow } from '@/tools/video-editor/types/timeline-canvas.ts';
import type { PositionedShotGroup } from '@/tools/video-editor/components/TimelineEditor/ShotGroupOverlay.tsx';

const EMPTY_ASSET_GENERATION_MAP: Record<string, string> = {};
const EMPTY_CLIP_IDS = new Set<string>();
const EMPTY_SHOT_GROUPS: ShotGroup[] = [];
const EMPTY_FINAL_VIDEO_MAP = new Map<string, DoubleClickFinalVideo>();
const EMPTY_SHOTS: Shot[] = [];
const EMPTY_ROWS: TimelineRow[] = [];

function shotNameForAction(clipId: string, shotGroups: readonly ShotGroup[]): string | undefined {
  const canonicalOwner = shotGroups.find((group) => (
    group.canonicalIdentity
    && (clipId === group.canonicalIdentity.occurrenceId
      || clipId.startsWith(`${group.canonicalIdentity.occurrenceId}:`))
  ));
  if (canonicalOwner) return canonicalOwner.shotName;

  const explicitLegacyOwners = shotGroups.filter((group) => (
    !group.canonicalIdentity && group.clipIds.includes(clipId)
  ));
  return explicitLegacyOwners.length === 1 ? explicitLegacyOwners[0].shotName : undefined;
}

interface DoubleClickPinnedGroup {
  shotId: string;
  clipIds: string[];
}

interface DoubleClickFinalVideo {
  id: string;
  location?: string | null;
}

type VideoClipDoubleClickResolution =
  | { type: 'lightbox'; assetKey: string; generationId?: string }
  | { type: 'video-modal'; shotId: string; reason: 'pinned-group' | 'final-video-file' }
  | { type: 'none' };

export function resolveVideoClipDoubleClickResolution({
  clipId,
  assetKey,
  generationId,
  fileUrl,
  pinnedShotGroups,
  finalVideoMap,
}: {
  clipId: string;
  assetKey?: string;
  generationId?: string;
  fileUrl?: string;
  pinnedShotGroups: DoubleClickPinnedGroup[];
  finalVideoMap: Map<string, DoubleClickFinalVideo>;
}): VideoClipDoubleClickResolution {
  if (assetKey) {
    return { type: 'lightbox', assetKey, generationId };
  }

  const pinnedGroup = pinnedShotGroups.find((group) => group.clipIds.includes(clipId));
  if (pinnedGroup) {
    return { type: 'video-modal', shotId: pinnedGroup.shotId, reason: 'pinned-group' };
  }

  if (fileUrl) {
    for (const [shotId, finalVideo] of finalVideoMap.entries()) {
      if (finalVideo.location === fileUrl) {
        return { type: 'video-modal', shotId, reason: 'final-video-file' };
      }
    }
  }

  return { type: 'none' };
}

function hasResolvableCanonicalTimeline(occurrence: CanonicalShotOccurrence): boolean {
  const internal = occurrence.revision.internal_timeline_revision;
  if (!internal || typeof internal !== 'object' || Array.isArray(internal)) return false;
  const timeline = (internal as Record<string, unknown>).timeline;
  if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) return false;
  const clips = (timeline as Record<string, unknown>).clips;
  return Array.isArray(clips) && clips.some((clip) => (
    clip !== null && typeof clip === 'object' && !Array.isArray(clip)
  ));
}

export function resolveSelectedGenerationIdsForShotCreation({
  rows,
  meta,
  assetGenerationMap,
  selectedClipIds,
}: {
  rows: TimelineRow[];
  meta: Record<string, ClipMeta>;
  assetGenerationMap: Record<string, string>;
  selectedClipIds: Iterable<string>;
}) {
  const selectedSet = new Set(selectedClipIds);
  if (selectedSet.size === 0) {
    return {
      canCreateShot: false,
      generationIds: [] as string[],
      orderedClipIds: [] as string[],
      trackId: undefined as string | undefined,
    };
  }

  const orderedSelections = rows
    .flatMap((row, trackIndex) => row.actions
      .filter((action) => selectedSet.has(action.id))
      .map((action) => {
        const assetKey = meta[action.id]?.asset;
        const generationId = assetKey ? assetGenerationMap[assetKey] : undefined;

        return {
          clipId: action.id,
          trackId: row.id,
          trackIndex,
          start: action.start,
          generationId,
        };
      }))
    .sort((left, right) => left.trackIndex - right.trackIndex || left.start - right.start);

  const generationIds = orderedSelections
    .map((selection) => selection.generationId)
    .filter((generationId): generationId is string => typeof generationId === 'string' && generationId.length > 0);

  return {
    // Non-generation clips (text/import/effect clips) are still valid shot
    // selection members; the shot simply starts with the generations present.
    canCreateShot: orderedSelections.length > 0,
    generationIds,
    orderedClipIds: orderedSelections.map((selection) => selection.clipId),
    trackId: orderedSelections[0]?.trackId,
  };
}

export function resolveWaveformAudioSrc(
  clip: ResolvedTimelineClip | undefined,
  track: TrackDefinition | undefined,
): string | undefined {
  if (!clip || !track || !clip.assetEntry?.src) {
    return undefined;
  }

  if (clip.clipType === 'text' || clip.clipType === 'effect-layer') {
    return undefined;
  }

  if (track.kind === 'audio') {
    return getEffectiveClipVolume(clip) > 0 ? clip.assetEntry.src : undefined;
  }

  if (
    track.kind === 'visual'
    && clip.assetEntry.type?.startsWith('video/')
    && getEffectiveClipVolume(clip) > 0
  ) {
    return clip.assetEntry.src;
  }

  return undefined;
}

/** Installed hosts keep existing audio behavior; a public host may skip only hash-verified silent visual clips. */
export function resolveHostWaveformAudioSrc(
  clip: ResolvedTimelineClip | undefined,
  track: TrackDefinition | undefined,
  silentVideoAssetHashes?: Readonly<Record<string, string>>,
): string | undefined {
  const silentHash = clip?.asset ? silentVideoAssetHashes?.[clip.asset] : undefined;
  if (
    track?.kind === 'visual'
    && clip?.assetEntry?.type?.startsWith('video/')
    && silentHash
    && clip.assetEntry.content_sha256 === silentHash
  ) {
    return undefined;
  }
  return resolveWaveformAudioSrc(clip, track);
}

export interface TimelineEditorCoreProps {
  onOpenSequenceCreator?: () => void;
  onOpenExtensionManager?: () => void;
  onOpenElementCreationPrompt?: (prompt: string) => void;
  finalVideoMap?: Map<string, DoubleClickFinalVideo>;
  shotGroups?: ShotGroup[];
  canonicalOccurrences?: readonly CanonicalShotOccurrence[];
  staleShotGroupIds?: Set<string>;
  activeTaskClipIds?: Set<string>;
  shotGroupClipIds?: Set<string>;
  onShotGroupNavigate?: (shotId: string) => void;
  onShotGroupOpen?: (occurrence: CanonicalShotOccurrence) => void;
  onShotGroupGenerateVideo?: (shotId: string) => void;
  onShotGroupSwitchToFinalVideo?: (group: { shotId: string; clipIds: string[]; rowId: string; canonicalIdentity?: CanonicalShotOccurrence }) => void;
  onShotGroupExportManagedOutput?: (group: { shotId: string; clipIds: string[]; rowId: string; canonicalIdentity?: CanonicalShotOccurrence }) => void | Promise<void>;
  onShotGroupSwitchToImages?: (group: { shotId: string; rowId: string }) => void;
  onShotGroupUpdateToLatestVideo?: (group: { shotId: string; rowId: string }) => void;
  onShotGroupUnpin?: (group: { shotId: string; trackId: string }) => void;
  onShotGroupDelete?: (group: { shotId: string; trackId: string; clipIds: string[] }) => void;
  onShotGroupDuplicate?: (group: { shotId: string; trackId: string; canonicalIdentity?: CanonicalShotOccurrence }) => void;
  onShotGroupPromotePrimary?: (group: { shotId: string; trackId: string }) => void;
  canCreateShotFromSelection?: boolean;
  existingShots?: Shot[];
  onCreateShotFromSelection?: () => Promise<Shot | null>;
  onGenerateVideoFromSelection?: () => void | Promise<void>;
  onNavigateToShot?: (shot: Shot) => void;
  onOpenGenerateVideo?: (shot: Shot) => void;
  isCreatingShot?: boolean;
  duplicatingClipId?: string | null;
  onDuplicateGenerationClip?: (clipId: string) => void | Promise<void>;
  onOpenShotVideoModal?: (shotId: string, reason: 'pinned-group' | 'final-video-file') => void;
  /** Fixed output duration for an embedded shot timeline, in seconds. */
  durationLimitSeconds?: number;
  /** Start of the next shot relative to this shot, in seconds. */
  hardDurationSeconds?: number;
}

function TimelineEditorCoreComponent({
  onOpenSequenceCreator,
  onOpenExtensionManager,
  onOpenElementCreationPrompt,
  finalVideoMap = EMPTY_FINAL_VIDEO_MAP,
  shotGroups = EMPTY_SHOT_GROUPS,
  canonicalOccurrences = [],
  staleShotGroupIds,
  activeTaskClipIds,
  shotGroupClipIds = EMPTY_CLIP_IDS,
  onShotGroupNavigate,
  onShotGroupOpen,
  onShotGroupGenerateVideo,
  onShotGroupSwitchToFinalVideo,
  onShotGroupExportManagedOutput,
  onShotGroupSwitchToImages,
  onShotGroupUpdateToLatestVideo,
  onShotGroupUnpin,
  onShotGroupDelete,
  onShotGroupDuplicate,
  onShotGroupPromotePrimary,
  canCreateShotFromSelection = false,
  existingShots = EMPTY_SHOTS,
  onCreateShotFromSelection,
  onGenerateVideoFromSelection,
  onNavigateToShot,
  onOpenGenerateVideo,
  isCreatingShot = false,
  duplicatingClipId = null,
  onDuplicateGenerationClip,
  onOpenShotVideoModal,
  durationLimitSeconds,
  hardDurationSeconds,
}: TimelineEditorCoreProps) {
  useRenderDiagnostic('TimelineEditorCore');
  const [newTrackDropLabel, setNewTrackDropLabel] = useState<string | null>(null);
  const {
    data,
    resolvedConfig,
    timelineRef,
    timelineWrapperRef,
    dataRef,
    deviceClass,
    inputModality,
    interactionMode,
    gestureOwner,
    primaryClipId,
    selectedClipIds,
    scale,
    scaleWidth,
    indicatorRef,
    editAreaRef,
    selectedTrackId,
    inspectorTarget,
    interactionStateRef,
  } = useTimelineDataSelector((timeline) => ({
    data: timeline.data,
    resolvedConfig: timeline.resolvedConfig,
    timelineRef: timeline.timelineRef,
    timelineWrapperRef: timeline.timelineWrapperRef,
    dataRef: timeline.dataRef,
    deviceClass: timeline.deviceClass,
    inputModality: timeline.inputModality,
    interactionMode: timeline.interactionMode,
    gestureOwner: timeline.gestureOwner,
    primaryClipId: timeline.primaryClipId,
    selectedClipIds: timeline.selectedClipIds,
    scale: timeline.scale,
    scaleWidth: timeline.scaleWidth,
    indicatorRef: timeline.indicatorRef,
    editAreaRef: timeline.editAreaRef,
    selectedTrackId: timeline.selectedTrackId,
    inspectorTarget: timeline.inspectorTarget,
    interactionStateRef: timeline.interactionStateRef,
  }), shallow);
  const renderRows = useMemo(
    () => projectCanonicalShotRows(
      data?.rows ?? EMPTY_ROWS,
      shotGroups,
      new Set(Object.entries(data?.meta ?? {})
        .filter(([, clip]) => clip.clipType === 'shot')
        .map(([clipId]) => clipId)),
    ),
    [data?.meta, data?.rows, shotGroups],
  );
  const {
    applyEdit,
    selectClips,
    clearSelection,
    isClipSelected,
    setSelectedTrackId,
    handleTrackPopoverChange,
    handleMoveTrack,
    handleRemoveTrack,
    handleSplitClipAtTime,
    handleSplitClipsAtPlayhead,
    handleDeleteClips,
    handleDeleteClip,
    handleToggleMuteClips,
    onCursorDrag,
    onClickTimeArea,
    setGestureOwner,
    setInputModalityFromPointerType,
    setContextTarget,
    setInspectorTarget,
    onActionResizeStart,
    onClipEdgeResizeEnd,
    onTimelineDragOver,
    onTimelineDragLeave,
    onTimelineDrop,
    onDoubleClickAsset,
    patchRegistry,
  } = useTimelineOpsSelector((ops) => ({
    applyEdit: ops.applyEdit,
    selectClips: ops.selectClips,
    clearSelection: ops.clearSelection,
    isClipSelected: ops.isClipSelected,
    setSelectedTrackId: ops.setSelectedTrackId,
    handleTrackPopoverChange: ops.handleTrackPopoverChange,
    handleMoveTrack: ops.handleMoveTrack,
    handleRemoveTrack: ops.handleRemoveTrack,
    handleSplitClipAtTime: ops.handleSplitClipAtTime,
    handleSplitClipsAtPlayhead: ops.handleSplitClipsAtPlayhead,
    handleDeleteClips: ops.handleDeleteClips,
    handleDeleteClip: ops.handleDeleteClip,
    handleToggleMuteClips: ops.handleToggleMuteClips,
    onCursorDrag: ops.onCursorDrag,
    onClickTimeArea: ops.onClickTimeArea,
    setGestureOwner: ops.setGestureOwner,
    setInputModalityFromPointerType: ops.setInputModalityFromPointerType,
    setContextTarget: ops.setContextTarget,
    setInspectorTarget: ops.setInspectorTarget,
    onActionResizeStart: ops.onActionResizeStart,
    onClipEdgeResizeEnd: ops.onClipEdgeResizeEnd,
    onTimelineDragOver: ops.onTimelineDragOver,
    onTimelineDragLeave: ops.onTimelineDragLeave,
    onTimelineDrop: ops.onTimelineDrop,
    onDoubleClickAsset: ops.onDoubleClickAsset,
    patchRegistry: ops.patchRegistry,
  }), shallow);
  const {
    handleAddTrack,
    handleClearUnusedTracks,
    setScaleWidth,
    unusedTrackCount,
  } = useTimelineChromeSelector((chrome) => ({
    handleAddTrack: chrome.handleAddTrack,
    handleClearUnusedTracks: chrome.handleClearUnusedTracks,
    setScaleWidth: chrome.setScaleWidth,
    unusedTrackCount: chrome.unusedTrackCount,
  }), shallow);
  const handleAddEffectLayerAt = useCallback((trackId: string, time: number) => {
    insertEffectLayerAt({ dataRef, trackId, time, selectedTrackId, applyEdit });
  }, [applyEdit, dataRef, selectedTrackId]);
  const trackSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const resizeStartHandler: TimelineActionResizeStart = onActionResizeStart;
  const clipEdgeResizeEndHandler: TimelineClipEdgeResizeEnd = onClipEdgeResizeEnd;

  const { dragSessionRef, isDragging, dragPreview } = useClipDrag();

  const marqueeOwner = useMarqueeEditorRuntime()?.agentSelectionOwner;
  const { marqueeRect, onPointerDown: onMarqueePointerDown } = useMarqueeSelect({
    selectionOwner: marqueeOwner,
    editAreaRef,
    onClearSelection: clearSelection,
    deviceClass,
    gestureOwner,
    setGestureOwner,
    setInputModalityFromPointerType,
  });

  const { staleAssetKeys, dismissedAssetKeys, generationAssetKeys, dismissAsset, updateAssetToCurrentVariant, applyVariantToAsset } = useStaleVariants({
    registry: resolvedConfig?.registry,
    patchRegistry,
  });
  const { addVariantAsGenerationAfterClip, isPending: isAddingVariantAsGenerationPending } = useAddVariantAsGeneration();
  const { activeTaskAssetKeys } = useActiveTaskClips({ registry: resolvedConfig?.registry });

  useLayoutEffect(() => {
    const wrapper = timelineWrapperRef.current;
    const nextEditArea = wrapper?.querySelector<HTMLElement>(EDIT_AREA_SELECTOR) ?? null;
    editAreaRef.current = nextEditArea;

    return () => {
      if (editAreaRef.current === nextEditArea) {
        editAreaRef.current = null;
      }
    };
  }, [data, editAreaRef, timelineWrapperRef]);

  // One geometry owner: the canvas (ruler, grid, scroll content) and the overlay
  // host below both size themselves from this.
  const timelineExtent = useMemo(() => computeTimelineExtent({
    maxEndSeconds: Math.max(
      maxClipEndSeconds(renderRows),
      maxShotGroupEndSeconds(shotGroups),
      durationLimitSeconds ?? 0,
      hardDurationSeconds ?? 0,
    ),
    scale,
    scaleWidth,
    startLeft: getTimelineLabelWidth(deviceClass),
  }), [deviceClass, durationLimitSeconds, hardDurationSeconds, renderRows, scale, scaleWidth, shotGroups]);

  const thumbnailMap = useMemo<Record<string, string>>(() => {
    if (!resolvedConfig) {
      return {};
    }

    return resolvedConfig.clips.reduce<Record<string, string>>((acc, clip) => {
      if (clip.clipType === 'text' || !clip.assetEntry) {
        return acc;
      }

      if (clip.assetEntry.type?.startsWith('image')) {
        acc[clip.id] = clip.assetEntry.src;
      } else if (clip.assetEntry.type?.startsWith('video') && clip.assetEntry.thumbnailUrl) {
        acc[clip.id] = clip.assetEntry.thumbnailUrl;
      }

      return acc;
    }, {});
  }, [resolvedConfig]);

  const handleClipSelect = useCallback((clipId: string, trackId: string) => {
    userSelectTimelineClip(clipId, { additive: false }, marqueeOwner);
    setSelectedTrackId(trackId);
  }, [marqueeOwner, setSelectedTrackId]);
  const handleShotGroupSelect = useCallback((group: PositionedShotGroup) => {
    clearSelection();
    setSelectedTrackId(group.rowId);
    if (group.canonicalIdentity) {
      setInspectorTarget({
        kind: 'shotOccurrence',
        occurrenceId: group.canonicalIdentity.occurrenceId,
        shotId: group.canonicalIdentity.shotId,
        revisionId: group.canonicalIdentity.revisionId,
        parentDocumentId: group.canonicalIdentity.parentDocumentId,
        shotName: group.shotName,
        trackId: group.rowId,
        start: group.start,
        end: group.end,
      });
      return;
    }
    setInspectorTarget(null);
    selectClips(group.clipIds);
  }, [clearSelection, selectClips, setInspectorTarget, setSelectedTrackId]);
  const postprocessShader = resolvedConfig
    ? getTimelinePostprocessShader(resolvedConfig)
    : undefined;
  const handlePostprocessShaderSelect = useCallback((shader: TimelinePostprocessShaderMetadata) => {
    clearSelection();
    setSelectedTrackId(null);
    const target = {
      kind: 'shader' as const,
      shaderScope: 'postprocess' as const,
      shaderId: shader.shaderId,
      extensionId: shader.extensionId,
      contributionId: shader.contributionId,
    };
    setContextTarget(target);
    setInspectorTarget(target);
  }, [clearSelection, setContextTarget, setInspectorTarget, setSelectedTrackId]);

  const { pixelToTime } = useTimelineScale({
    scale,
    scaleWidth,
    startLeft: getTimelineLabelWidth(deviceClass),
  });

  const assetGenerationMap = useMemo<Record<string, string>>(() => {
    const assets = data?.registry?.assets;
    if (!assets) {
      return EMPTY_ASSET_GENERATION_MAP;
    }

    return Object.entries(assets).reduce<Record<string, string>>((acc, [assetKey, assetEntry]) => {
      if (typeof assetEntry?.generationId === 'string' && assetEntry.generationId.length > 0) {
        acc[assetKey] = assetEntry.generationId;
      }
      return acc;
    }, {});
  }, [data?.registry?.assets]);
  const resolvedClipMap = useMemo(() => {
    if (!resolvedConfig) {
      return new Map<string, ResolvedTimelineClip>();
    }

    return new Map(resolvedConfig.clips.map((clip) => [clip.id, clip]));
  }, [resolvedConfig]);
  const trackMap = useMemo(() => {
    if (!resolvedConfig) {
      return new Map<string, TrackDefinition>();
    }

    return new Map(resolvedConfig.tracks.map((track) => [track.id, track]));
  }, [resolvedConfig]);
  const nestedAudioTrackIds = useMemo(() => {
    if (!data) return new Set<string>();
    const hasNestedShots = Object.values(data.meta).some((clip) => clip.clipType === 'shot');
    if (!hasNestedShots) return new Set<string>();
    const emptyAudioTracks = new Set(
      data.rows
        .filter((row) => row.actions.length === 0)
        .map((row) => row.id),
    );
    return new Set(
      data.tracks
        .filter((track) => (
          track.kind === 'audio'
          && emptyAudioTracks.has(track.id)
          && /^(vo|voiceover)$/i.test(track.id)
        ))
        .map((track) => track.id),
    );
  }, [data]);

  const clientXToTime = useCallback((clientX: number): number => {
    const wrapper = timelineWrapperRef.current;
    if (!wrapper) return 0;
    const editArea = wrapper.querySelector<HTMLElement>(EDIT_AREA_SELECTOR);
    const grid = editArea;
    const rect = (editArea ?? wrapper).getBoundingClientRect();
    const scrollLeft = grid?.scrollLeft ?? 0;
    return Math.max(0, pixelToTime(clientX - rect.left + scrollLeft));
  }, [pixelToTime, timelineWrapperRef]);

  const handleDoubleClickVideoClip = useCallback((clipId: string) => {
    const canonicalGroup = shotGroups.find((group) => (
      group.canonicalIdentity && group.clipIds.includes(clipId)
    ));
    const canonicalOccurrence = canonicalGroup?.canonicalIdentity
      ?? canonicalOccurrences.find((occurrence) => (
        clipId === occurrence.occurrenceId
        || clipId.startsWith(`${occurrence.occurrenceId}:`)
      ));
    if (
      canonicalOccurrence
      && hasResolvableCanonicalTimeline(canonicalOccurrence)
      && onShotGroupOpen
    ) {
      onShotGroupOpen(canonicalOccurrence);
      return;
    }
    const assetKey = data?.meta[clipId]?.asset;
    const generationId = assetKey ? data?.registry?.assets[assetKey]?.generationId : undefined;
    const fileUrl = assetKey ? getAssetFileLocator(data?.registry?.assets[assetKey]) : undefined;
    const resolution = resolveVideoClipDoubleClickResolution({
      clipId,
      assetKey,
      generationId,
      fileUrl,
      pinnedShotGroups: dataRef.current?.config.pinnedShotGroups ?? [],
      finalVideoMap,
    });

    if (resolution.type === 'lightbox') {
      onDoubleClickAsset?.(resolution.assetKey, clipId);
      return;
    }

    if (resolution.type === 'video-modal') {
      onOpenShotVideoModal?.(resolution.shotId, resolution.reason);
    }
  }, [canonicalOccurrences, data?.meta, data?.registry?.assets, dataRef, finalVideoMap, onDoubleClickAsset, onOpenShotVideoModal, onShotGroupOpen, shotGroups]);

  const handleSplitClipHere = useCallback((clipId: string, clientX: number) => {
    const time = clientXToTime(clientX);
    handleSplitClipAtTime(clipId, time);
  }, [clientXToTime, handleSplitClipAtTime]);

  const handleExpandTinyClip = useCallback((clipId: string) => {
    const current = dataRef.current;
    if (!current) return;
    const row = current.rows.find((r) => r.actions.some((a) => a.id === clipId));
    const action = row?.actions.find((a) => a.id === clipId);
    if (!row || !action) return;
    const duration = action.end - action.start;
    if (duration >= 0.5) return;
    const newEnd = action.start + 0.5;
    const clipMeta = current.meta[clipId];
    const metaUpdates: Record<string, Partial<ClipMeta>> = {};
    if (clipMeta && typeof clipMeta.hold === 'number') {
      metaUpdates[clipId] = { hold: 0.5 };
    }
    applyEdit({
      type: 'rows',
      rows: current.rows.map((r) =>
        r.id !== row.id ? r : {
          ...r,
          actions: r.actions.map((a) =>
            a.id !== clipId ? a : { ...a, end: newEnd },
          ),
        },
      ),
      ...(Object.keys(metaUpdates).length > 0 ? { metaUpdates } : {}),
    });
  }, [applyEdit, dataRef]);

  const handleTrimClipToMediaEnd = useCallback((clipId: string) => {
    const current = dataRef.current;
    if (!current) {
      return;
    }

    const clipMeta = current.meta[clipId];
    const assetKey = clipMeta?.asset;
    const assetEntry = assetKey ? current.registry.assets[assetKey] : undefined;
    if (!clipMeta || !assetEntry?.type?.startsWith('video') || typeof assetEntry.duration !== 'number') {
      return;
    }

    const sourceRow = current.rows.find((row) => row.actions.some((action) => action.id === clipId));
    const sourceAction = sourceRow?.actions.find((action) => action.id === clipId);
    if (!sourceRow || !sourceAction) {
      return;
    }

    const clamped = clampClipToMediaDuration({
      action: sourceAction,
      clipMeta,
      sourceDurationSeconds: assetEntry.duration,
    });
    if (!clamped) {
      return;
    }

    applyEdit({
      type: 'rows',
      rows: current.rows.map((row) => {
        if (row.id !== sourceRow.id) {
          return row;
        }

        return {
          ...row,
          actions: row.actions.map((action) => (
            action.id === clipId ? clamped.nextAction : action
          )),
        };
      }),
      metaUpdates: {
        [clipId]: clamped.metaPatch,
      },
    }, {
      selectedClipId: clipId,
      selectedTrackId: clipMeta.track,
      semantic: true,
    });
  }, [applyEdit, dataRef]);

  const handleConvertClipOverhangToHold = useCallback((clipId: string) => {
    const current = dataRef.current;
    if (!current) {
      return;
    }

    const clipMeta = current.meta[clipId];
    const assetKey = clipMeta?.asset;
    const assetEntry = assetKey ? current.registry.assets[assetKey] : undefined;
    if (!clipMeta || !assetEntry?.type?.startsWith('video') || typeof assetEntry.duration !== 'number') {
      return;
    }

    const conversion = convertOverhangToHold({
      current,
      clipId,
      sourceDurationSeconds: assetEntry.duration,
      frameRate: assetEntry.fps,
    });
    if (!conversion) {
      return;
    }

    applyEdit({
      type: 'rows',
      rows: conversion.rows,
      metaUpdates: conversion.metaUpdates,
      clipOrderOverride: conversion.clipOrderOverride,
    }, {
      selectedClipId: conversion.holdClipId,
      selectedTrackId: conversion.trackId,
      semantic: true,
    });
  }, [applyEdit, dataRef]);

  const shouldStackOverlappingActions = useCallback((action: TimelineAction) => {
    // Text clips are duration-driven labels and are commonly generated in
    // short overlapping bursts (for example transcript captions). Their
    // minimum visual width can otherwise make one full-row hit target cover
    // the previous one. Keep video/audio/effect clips on the legacy geometry.
    return data?.meta[action.id]?.clipType === 'text';
  }, [data?.meta]);

  const getActionPaintLayer = useCallback((action: TimelineAction) => {
    if (selectedClipIds.has(action.id)) return 'selected' as const;
    if (resolvedClipMap.get(action.id)?.elementRef?.kind === 'effect'
      || data?.meta[action.id]?.clipType === 'effect-layer') return 'overlay' as const;
    return undefined;
  }, [selectedClipIds, resolvedClipMap, data?.meta]);

  const getActionRender = useCallback((action: TimelineAction, _row: TimelineRow, clipWidth: number) => {
    const clipMeta = data?.meta[action.id];
    if (!clipMeta) {
      return null;
    }

    const resolvedClip = resolvedClipMap.get(action.id);
    const track = resolvedClip ? trackMap.get(resolvedClip.track) : undefined;
    const clipWidthPx = clipWidth;
    const thumbnailSrc = clipWidthPx >= 40 ? thumbnailMap[action.id] : undefined;
    const assetKey = clipMeta.asset;
    const audioSrc = resolveWaveformAudioSrc(resolvedClip, track);
    const isStale = assetKey ? staleAssetKeys.has(assetKey) : false;
    const isDismissed = assetKey ? dismissedAssetKeys.has(assetKey) : false;
    const isGenAsset = assetKey ? generationAssetKeys.has(assetKey) : false;
    const isTaskActive = assetKey && !shotGroupClipIds.has(action.id) ? activeTaskAssetKeys.has(assetKey) : false;
    const assetEntry = assetKey ? data?.registry?.assets[assetKey] : undefined;
    const assetType = assetEntry?.type;
    const isVideoClip = typeof assetType === 'string' && assetType.startsWith('video');
    const clipOverhang = isVideoClip
      ? detectClipOverhang({
          clipMeta,
          timelineDurationSeconds: action.end - action.start,
          sourceDurationSeconds: assetEntry?.duration,
        })
      : null;

    return (
      <ClipAction
        action={action}
        clipMeta={clipMeta}
        shotName={shotNameForAction(action.id, shotGroups)}
        isVideoClip={isVideoClip}
        isInPinnedShotGroup={shotGroupClipIds.has(action.id)}
        isSelected={isClipSelected(action.id)}
        isPrimary={primaryClipId === action.id}
        selectedClipIds={[...selectedClipIds]}
        thumbnailSrc={thumbnailSrc}
        audioSrc={audioSrc}
        clipWidth={clipWidthPx}
        onSelect={handleClipSelect}
        onDoubleClickAsset={onDoubleClickAsset}
        onDoubleClickVideoClip={handleDoubleClickVideoClip}
        onExpandTinyClip={handleExpandTinyClip}
        onSplitHere={handleSplitClipHere}
        onSplitClipsAtPlayhead={handleSplitClipsAtPlayhead}
        onTrimToMediaEnd={clipOverhang ? handleTrimClipToMediaEnd : undefined}
        onConvertOverhangToHold={clipOverhang ? handleConvertClipOverhangToHold : undefined}
        onDeleteClips={handleDeleteClips}
        onDeleteClip={handleDeleteClip}
        onToggleMuteClips={handleToggleMuteClips}
        onOpenSequenceCreator={onOpenSequenceCreator}
        isTaskActive={isTaskActive}
        isVariantStale={isStale && !isDismissed}
        isGenerationAsset={isGenAsset}
        isDuplicatingGeneration={duplicatingClipId === action.id}
        onDuplicateGeneration={isGenAsset ? onDuplicateGenerationClip : undefined}
        onUpdateVariant={isGenAsset && assetKey ? () => void updateAssetToCurrentVariant(assetKey) : undefined}
        onDismissStale={isStale && assetKey ? () => dismissAsset(assetKey) : undefined}
        variantPickerGenerationId={assetEntry?.generationId}
        variantPickerCurrentVariantId={assetEntry?.variantId ?? null}
        onApplyVariant={isGenAsset && assetKey ? (variant) => applyVariantToAsset(assetKey, variant) : undefined}
        onAddVariantAsGeneration={isGenAsset ? (variant) => addVariantAsGenerationAfterClip(action.id, variant) : undefined}
        isAddingVariantAsGeneration={(variantId) => isAddingVariantAsGenerationPending(action.id, variantId)}
        canCreateShotFromSelection={canCreateShotFromSelection}
        existingShots={existingShots}
        onCreateShotFromSelection={onCreateShotFromSelection}
        onGenerateVideoFromSelection={onGenerateVideoFromSelection}
        onNavigateToShot={onNavigateToShot}
        onOpenGenerateVideo={onOpenGenerateVideo}
        isCreatingShot={isCreatingShot}
        overhangDurationSeconds={clipOverhang?.overhangTimelineDurationSeconds}
        overhangEndFraction={clipOverhang?.mediaEndFraction}
      />
    );
  }, [
    activeTaskAssetKeys,
    addVariantAsGenerationAfterClip,
    applyVariantToAsset,
    canCreateShotFromSelection,
    data,
    deviceClass,
    dismissAsset,
    dismissedAssetKeys,
    duplicatingClipId,
    existingShots,
    generationAssetKeys,
    handleClipSelect,
    handleConvertClipOverhangToHold,
    handleDeleteClip,
    handleDeleteClips,
    handleDoubleClickVideoClip,
    handleExpandTinyClip,
    handleSplitClipHere,
    handleSplitClipsAtPlayhead,
    handleToggleMuteClips,
    handleTrimClipToMediaEnd,
    isAddingVariantAsGenerationPending,
    isClipSelected,
    isCreatingShot,
    onCreateShotFromSelection,
    onDoubleClickAsset,
    onDuplicateGenerationClip,
    onGenerateVideoFromSelection,
    onNavigateToShot,
    onOpenGenerateVideo,
    onOpenSequenceCreator,
    primaryClipId,
    resolvedClipMap,
    selectedClipIds,
    shotGroups,
    shotGroupClipIds,
    staleAssetKeys,
    thumbnailMap,
    trackMap,
    updateAssetToCurrentVariant,
  ]);

  const handleTrackDragEnd = useCallback(({ active, over }: DragEndEvent, lanes?: readonly DataLaneView[]) => {
    if (!over) {
      return;
    }

    if (lanes) {
      handleMoveTrack(String(active.id), String(over.id), lanes);
      return;
    }
    const activeSortableId = String(active.id);
    const overSortableId = String(over.id);
    if (
      activeSortableId === overSortableId ||
      !activeSortableId.startsWith('track-') ||
      !overSortableId.startsWith('track-')
    ) {
      return;
    }

    const activeTrackId = activeSortableId.slice('track-'.length);
    const overTrackId = overSortableId.slice('track-'.length);
    handleMoveTrack(activeTrackId, overTrackId);
  }, [handleMoveTrack]);

  if (!data) {
    // The card and its ruler band are there from the shell's first frame; the tracks fill it in.
    return (
      <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card/95" aria-busy="true">
        <div className="h-[30px] shrink-0 border-b border-border bg-card/80" />
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden rounded-xl border border-border bg-card/95">
      <div
        ref={timelineWrapperRef as React.RefObject<HTMLDivElement>}
        className="timeline-wrapper relative min-w-0 flex-1 overflow-hidden"
        onDragOver={onTimelineDragOver}
        onDragLeave={onTimelineDragLeave}
        onDrop={onTimelineDrop}
      >
        <TimelineCanvas
          ref={timelineRef as React.RefObject<import('@/tools/video-editor/types/timeline-canvas').TimelineCanvasHandle>}
          rows={renderRows}
          tracks={data.tracks}
          nestedAudioTrackIds={nestedAudioTrackIds}
          deviceClass={deviceClass}
          inputModality={inputModality}
          interactionMode={interactionMode}
          gestureOwner={gestureOwner}
          scale={scale}
          scaleWidth={scaleWidth}
          scaleSplitCount={5}
          startLeft={getTimelineLabelWidth(deviceClass)}
          rowHeight={ROW_HEIGHT}
          minScaleCount={timelineExtent.scaleCount}
          maxScaleCount={timelineExtent.scaleCount}
          selectedTrackId={selectedTrackId}
          getActionRender={getActionRender}
          getActionPaintLayer={getActionPaintLayer}
          shouldStackOverlappingActions={shouldStackOverlappingActions}
          onOpenExtensionManager={onOpenExtensionManager}
          onSelectTrack={(trackId) => { clearSelection(); setSelectedTrackId(trackId); }}
          onTrackChange={handleTrackPopoverChange}
          onRemoveTrack={handleRemoveTrack}
          onTrackDragEnd={handleTrackDragEnd}
          trackSensors={trackSensors}
          onCursorDrag={onCursorDrag}
          onClickTimeArea={onClickTimeArea}
          setInputModalityFromPointerType={setInputModalityFromPointerType}
          setGestureOwner={setGestureOwner}
          onActionResizeStart={resizeStartHandler}
          onClipEdgeResizeEnd={clipEdgeResizeEndHandler}
          shotGroups={shotGroups}
          finalVideoMap={finalVideoMap}
          staleShotGroupIds={staleShotGroupIds}
          activeTaskClipIds={activeTaskClipIds}
          onShotGroupNavigate={onShotGroupNavigate}
          onShotGroupOpen={onShotGroupOpen}
          onShotGroupGenerateVideo={onShotGroupGenerateVideo}
          onShotGroupExportManagedOutput={onShotGroupExportManagedOutput}
          onShotGroupUnpin={onShotGroupUnpin}
          onShotGroupDelete={onShotGroupDelete}
          onShotGroupDuplicate={onShotGroupDuplicate}
          onShotGroupPromotePrimary={onShotGroupPromotePrimary}
          selectedCanonicalOccurrenceId={selectedClipIds.size === 0 && inspectorTarget?.kind === 'shotOccurrence'
            ? inspectorTarget.occurrenceId
            : null}
          onShotGroupSelect={handleShotGroupSelect}
          onShotGroupSwitchToFinalVideo={onShotGroupSwitchToFinalVideo}
          onShotGroupSwitchToImages={onShotGroupSwitchToImages}
          onShotGroupUpdateToLatestVideo={onShotGroupUpdateToLatestVideo}
          onSelectClips={selectClips}
          dragSessionRef={dragSessionRef}
          interactionStateRef={interactionStateRef}
          marqueeRect={marqueeRect}
          onEditAreaPointerDown={onMarqueePointerDown}
          onAddTrack={handleAddTrack}
          onAddEffectLayerAt={handleAddEffectLayerAt}
          onOpenElementCreationPrompt={onOpenElementCreationPrompt}
          onScaleWidthChange={setScaleWidth}
          unusedTrackCount={unusedTrackCount}
          onClearUnusedTracks={handleClearUnusedTracks}
          newTrackDropLabel={newTrackDropLabel}
          postprocessShader={postprocessShader}
          onSelectPostprocessShader={handlePostprocessShaderSelect}
          onCreateShotFromSelection={onCreateShotFromSelection}
          canCreateShotFromSelection={canCreateShotFromSelection}
          isCreatingShot={isCreatingShot}
          selectedClipCount={selectedClipIds.size}
          isDragging={isDragging}
          dragPreview={dragPreview}
          durationLimitSeconds={durationLimitSeconds}
          hardDurationSeconds={hardDurationSeconds}
        />
        <DropIndicator ref={indicatorRef} editAreaRef={editAreaRef} onNewTrackLabel={setNewTrackDropLabel} />
      </div>
    </div>
  );
}

export const TimelineEditorCore = memo(TimelineEditorCoreComponent);

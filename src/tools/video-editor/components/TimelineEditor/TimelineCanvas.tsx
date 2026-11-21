import { publishMarqueePlane } from '@/tools/video-editor/lib/marquee-geometry.ts';
import { systemPruneTimelineDataItems } from '@/shared/state/selectionStore.ts';
import type { DataLaneView } from '@/tools/video-editor/data/typed/envelope.ts';
import { buildTimelineRowLayout, resolveTimelineLaneHeight } from '@/tools/video-editor/lib/timeline-row-layout.ts';
import { publishTimelineRowLayout } from '@/tools/video-editor/lib/drop-position.ts';
// Layer map & invariants: docs/structure_detail/tool_video_editor.md
import React, {
  useContext,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type UIEvent,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { type DragEndEvent, useSensors } from '@dnd-kit/core';
import { FolderPlus, Sparkles } from 'lucide-react';
import type { Shot } from '@/domains/generation/types/index.ts';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import { usePortalMousedownGuard } from '@/shared/hooks/usePortalMousedownGuard.ts';
import {
  ExtensionContextMenuItems,
  hasEligibleExtensionContextMenuItems,
} from '@/tools/video-editor/components/TimelineEditor/ExtensionContextMenuItems.tsx';
import {
  ShotGroupBorders,
  ShotGroupLabels,
  type PositionedShotGroup,
} from '@/tools/video-editor/components/TimelineEditor/ShotGroupOverlay.tsx';
import {
  ShotGroupContextMenu,
  type ShotGroupMenuState,
} from '@/tools/video-editor/components/TimelineEditor/ShotGroupContextMenu.tsx';
import {
  buildGridBackground,
  TimelineRulerAndGrid,
} from '@/tools/video-editor/components/TimelineEditor/TimelineRulerAndGrid.tsx';
import { DataLaneList } from '@/tools/video-editor/components/TimelineEditor/DataLaneList.tsx';
import {
  AI_GENERATION_DRAFT,
  EFFECT_OR_ANIMATION_DRAFT,
  EXTENSION_DRAFT,
  TimelineCreateTools,
} from '@/tools/video-editor/components/TimelineEditor/TimelineCreateTools.tsx';
import { visibleDataLanes } from '@/tools/video-editor/data-kinds/visibleDataLanes.ts';
import { TrackListRenderer } from '@/tools/video-editor/components/TimelineEditor/TrackListRenderer.tsx';
import { TimelineGhostLayer } from '@/tools/video-editor/components/TimelineEditor/TimelineGhostLayer.tsx';
import { TimelineDurationGuide } from '@/tools/video-editor/components/TimelineEditor/TimelineDurationGuide.tsx';
import { VideoEditorRuntimeContext } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import { EDITOR_TOUR_ANCHORS, EDITOR_TOUR_ANCHOR_ATTRIBUTE } from '@/tools/video-editor/tour/anchors.ts';
import type { TimelineGhostEntry } from '@/tools/video-editor/types/timeline-canvas.ts';
import { useClipResizeGesture } from '@/tools/video-editor/hooks/useClipResizeGesture.ts';
import { shotGroupEndSeconds, shotGroupVideoKey, type ShotGroup } from '@/tools/video-editor/hooks/useShotGroups.ts';
import type { CanonicalShotOccurrence } from '@/tools/video-editor/data/shotCompositionAdapter.ts';
import { useTimelineEditorDataSafe, useTimelineMutableAdapters } from '@/tools/video-editor/hooks/timelineStore.ts';
import { useDataLanePlane } from '@/tools/video-editor/data-kinds/useDataLanes.ts';
import { useTimelineSelectionStore } from '@/shared/state/selectionStore.ts';
import {
  EDIT_AREA_CLASS,
  ROW_ID_ATTR,
  TIMELINE_AREA_CONTEXT_MENU_IGNORE_SELECTOR,
  touchGestureModeAttrs,
} from '@/tools/video-editor/lib/timeline-dom.ts';
import {
  resolveArmedTouchGesture,
  shouldEnableTimelinePinchZoom,
  shouldExpandTouchTrimHandles,
  type TimelineDeviceClass,
  type TimelineGestureOwner,
  type TimelineInputModality,
  type TimelineInteractionMode,
} from '@/tools/video-editor/lib/mobile-interaction-model.ts';
import {
  clampTimelineScaleWidth,
  computeTimelineExtent,
} from '@/tools/video-editor/lib/timeline-scale.ts';
import { createTimelineOverlayGeometry } from '@astrid/editor-sdk';
import { createTimelineOverlayStores } from '@/tools/video-editor/lib/timeline-overlay-stores.ts';
import {
  type ResizeDir,
} from '@/tools/video-editor/lib/resize-math.ts';
import { useRenderDiagnostic } from '@/tools/video-editor/hooks/usePerfDiagnostics.ts';
import { useTimelineScale } from '@/tools/video-editor/hooks/useTimelineScale.ts';
import { useRenderBudget } from '@/shared/dev/useRenderBudget.ts';
import {
  TIMELINE_CENTER_CLIP_EVENT,
  type TimelineCenterClipEventDetail,
  SOURCE_NAVIGATE_TO_TIMELINE_EVENT,
  type SourceNavigateToTimelineDetail,
} from '@/tools/video-editor/lib/timeline-viewport-events.ts';
import { VIDEO_EDITOR_THEME_VARS } from '@/tools/video-editor/lib/themeTokens.ts';
import type { TimelinePostprocessShaderMetadata, TrackDefinition } from '@/tools/video-editor/types/index.ts';
import type { TimelineAction, TimelineCanvasHandle, TimelineRow } from '@/tools/video-editor/types/timeline-canvas.ts';
import type { DragSession } from '@/tools/video-editor/hooks/useClipDrag.ts';
import type { ClipEdgeResizeEndTarget } from '@/tools/video-editor/hooks/useClipResize.ts';
import type { MarqueeRect } from '@/tools/video-editor/hooks/useMarqueeSelect.ts';
import type { TargetContextPayload } from '@astrid/editor-sdk';
import { TimelineExtensionOverlayHost } from './TimelineExtensionOverlayHost.tsx';
import {
  ACTION_VERTICAL_MARGIN,
  CURSOR_WIDTH,
  EMPTY_RESIZE_PREVIEW_SNAPSHOT,
  MIN_ACTION_WIDTH_PX,
  RESIZE_HANDLE_WIDTH,
  TOUCH_RESIZE_HANDLE_WIDTH,
  type ResizeOverride,
} from './timeline-canvas-constants.ts';

export interface TimelineCanvasProps {
  rows: TimelineRow[];
  tracks: TrackDefinition[];
  /** Empty parent audio lanes whose actual clips are owned by nested shots. */
  nestedAudioTrackIds?: ReadonlySet<string>;
  deviceClass: TimelineDeviceClass;
  inputModality: TimelineInputModality;
  interactionMode: TimelineInteractionMode;
  gestureOwner: TimelineGestureOwner;
  scale: number;
  scaleWidth: number;
  scaleSplitCount: number;
  startLeft: number;
  rowHeight: number;
  minScaleCount: number;
  maxScaleCount: number;
  selectedTrackId: string | null;
  getActionRender?: (action: TimelineAction, row: TimelineRow, width: number) => ReactNode;
  getActionPaintLayer?: (action: TimelineAction, row: TimelineRow) => 'overlay' | 'selected' | undefined;
  /** Selects action kinds that need vertical hit-target lanes when their minimum widths overlap. */
  shouldStackOverlappingActions?: (action: TimelineAction, row: TimelineRow) => boolean;
  onOpenExtensionManager?: () => void;
  onSelectTrack: (trackId: string) => void;
  onTrackChange: (trackId: string, patch: Partial<TrackDefinition>) => void;
  onRemoveTrack: (trackId: string) => void;
  onTrackDragEnd: (event: DragEndEvent, lanes?: readonly DataLaneView[]) => void;
  readOnly?: boolean;
  showReadOnlyTrackName?: boolean;
  trackSensors: ReturnType<typeof useSensors>;
  onCursorDrag: (time: number) => void;
  onClickTimeArea: (time: number) => void;
  setInputModalityFromPointerType: (pointerType: string | null | undefined) => TimelineInputModality;
  setGestureOwner: (owner: TimelineGestureOwner) => void;
  onActionResizeStart?: (params: {
    action: TimelineAction;
    row: TimelineRow;
    dir: ResizeDir;
  }) => void;
  onActionResizing?: (params: { action: TimelineAction; row: TimelineRow; start: number; end: number; dir: ResizeDir }) => void;
  onClipEdgeResizeEnd?: (params: ClipEdgeResizeEndTarget) => void;
  shotGroups?: ShotGroup[];
  finalVideoMap?: Map<string, unknown>;
  staleShotGroupIds?: Set<string>;
  activeTaskClipIds?: Set<string>;
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
  selectedCanonicalOccurrenceId?: string | null;
  onShotGroupSelect?: (group: PositionedShotGroup) => void;
  onSelectClips?: (clipIds: string[]) => void;
  dragSessionRef?: MutableRefObject<DragSession | null>;
  interactionStateRef?: import('@/tools/video-editor/lib/interaction-state').InteractionStateRef;
  marqueeRect?: MarqueeRect | null;
  onEditAreaPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onAddTrack?: (kind: 'visual' | 'audio') => void;
  onAddEffectLayerAt?: (trackId: string, time: number) => void;
  onOpenElementCreationPrompt?: (prompt: string) => void;
  /** Applies a new timeline zoom (px per `scale` seconds); drives the touch pinch gesture. */
  onScaleWidthChange?: (scaleWidth: number) => void;
  unusedTrackCount?: number;
  onClearUnusedTracks?: () => void;
  newTrackDropLabel?: string | null;
  /** Ghost preview entries for rendering proposal previews over the timeline. */
  ghostEntries?: readonly TimelineGhostEntry[];
  /** Set of clip IDs that have stale source-map entries (for stale badge rendering). */
  sourceMapStaleClipIds?: ReadonlySet<string>;
  /** Active timeline-scoped postprocess shader shown as a selectable timeline badge. */
  postprocessShader?: TimelinePostprocessShaderMetadata;
  /** Selects the timeline-scoped postprocess shader inspector target. */
  onSelectPostprocessShader?: (shader: TimelinePostprocessShaderMetadata) => void;
  /** Creates a shot from the selected clips. */
  onCreateShotFromSelection?: () => Promise<Shot | null>;
  canCreateShotFromSelection?: boolean;
  isCreatingShot?: boolean;
  selectedClipCount?: number;
  /** Reactive drag state so floating cross-track ghosts cannot leave labels behind. */
  isDragging?: boolean;
  dragPreview?: {
    clipIds: readonly string[];
    start: number;
    end: number;
    trackId: string;
    rejected: boolean;
  } | null;
  /** Fixed output duration for an embedded shot timeline, in seconds. */
  durationLimitSeconds?: number;
  /** Start of the next shot relative to this shot, in seconds. */
  hardDurationSeconds?: number;
}

/** The pinned footer row that holds the desktop create tools is at least one 24px button (`TimelineCreateTools`)
 *  plus 4px above and below tall, so the buttons take layout space instead of covering a track. */
const TOOL_CLUSTER_FOOTER_HEIGHT_PX = 24 + 4 * 2;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const MENU_VIEWPORT_MARGIN = 8;

interface TimelineAreaContextMenuState {
  x: number;
  y: number;
  time: number;
  trackId?: string;
  target: TargetContextPayload;
}

function TimelineAreaExtensionContextMenu({
  menu,
  menuRef,
  closeMenu,
  onCreateShotFromSelection,
  canCreateShotFromSelection,
  isCreatingShot,
  selectedClipCount,
}: {
  menu: TimelineAreaContextMenuState;
  menuRef: React.RefObject<HTMLDivElement>;
  closeMenu: () => void;
  onCreateShotFromSelection?: TimelineCanvasProps['onCreateShotFromSelection'];
  canCreateShotFromSelection?: boolean;
  isCreatingShot?: boolean;
  selectedClipCount?: number;
}) {
  const [adjusted, setAdjusted] = useState<{ x: number; y: number } | null>(null);
  const runtime = useContext(VideoEditorRuntimeContext);
  const commandRegistry = runtime?.commandRegistry;
  const extensions = runtime?.extensionRuntime?.extensions ?? [];
  const items = commandRegistry
    ? commandRegistry.getSnapshot().contextMenuItems.filter((item) => item.target === menu.target.target)
    : [];
  const hasExtensionItems = hasEligibleExtensionContextMenuItems(commandRegistry, extensions, menu.target);
  const showSelectionItem = Boolean(
    canCreateShotFromSelection && (selectedClipCount ?? 0) >= 2 && onCreateShotFromSelection,
  );
  const hasBuiltInItems = showSelectionItem;

  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node) {
      setAdjusted(null);
      return;
    }

    const recompute = () => {
      const rect = node.getBoundingClientRect();
      setAdjusted({
        x: Math.max(MENU_VIEWPORT_MARGIN, Math.min(menu.x, window.innerWidth - rect.width - MENU_VIEWPORT_MARGIN)),
        y: Math.max(MENU_VIEWPORT_MARGIN, Math.min(menu.y, window.innerHeight - rect.height - MENU_VIEWPORT_MARGIN)),
      });
    };

    recompute();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(recompute);
    observer.observe(node);
    return () => observer.disconnect();
  }, [menu.x, menu.y, menuRef]);

  usePortalMousedownGuard(menuRef);

  const pos = adjusted ?? menu;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
      style={{ left: pos.x, top: pos.y, visibility: adjusted ? 'visible' : 'hidden' }}
    >
      {showSelectionItem && (
        <button type="button" role="menuitem" className="relative flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent disabled:opacity-50" disabled={isCreatingShot} onClick={() => { void onCreateShotFromSelection!(); closeMenu(); }}>
          <FolderPlus className="h-4 w-4" />
          Create Shot from selection
        </button>
      )}
      {hasBuiltInItems && hasExtensionItems && <div className="my-1 h-px bg-border" />}
      <ExtensionContextMenuItems
        items={items}
        target={menu.target}
        extensions={extensions}
        commandRegistry={commandRegistry}
        closeMenu={closeMenu}
        validateTarget={() => null}
      />
    </div>,
    document.body,
  );
}

export const TimelineCanvas = forwardRef<TimelineCanvasHandle, TimelineCanvasProps>(function TimelineCanvas({
  rows,
  tracks,
  nestedAudioTrackIds,
  deviceClass,
  inputModality,
  interactionMode,
  gestureOwner,
  scale,
  scaleWidth,
  scaleSplitCount,
  startLeft,
  rowHeight,
  minScaleCount,
  maxScaleCount,
  selectedTrackId,
  getActionRender,
  getActionPaintLayer,
  shouldStackOverlappingActions,
  onOpenExtensionManager,
  onSelectTrack,
  onTrackChange,
  onRemoveTrack,
  onTrackDragEnd,
  readOnly = false,
  showReadOnlyTrackName = false,
  trackSensors,
  onCursorDrag,
  onClickTimeArea,
  setInputModalityFromPointerType,
  setGestureOwner,
  onActionResizeStart,
  onActionResizing,
  onClipEdgeResizeEnd,
  shotGroups = [],
  finalVideoMap,
  staleShotGroupIds,
  activeTaskClipIds,
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
  selectedCanonicalOccurrenceId,
  onShotGroupSelect,
  onSelectClips,
  dragSessionRef,
  interactionStateRef,
  marqueeRect,
  onEditAreaPointerDown,
  onAddTrack,
  onAddEffectLayerAt,
  onOpenElementCreationPrompt,
  onScaleWidthChange,
  unusedTrackCount = 0,
  onClearUnusedTracks,
  newTrackDropLabel,
  ghostEntries,
  sourceMapStaleClipIds,
  postprocessShader,
  onSelectPostprocessShader,
  onCreateShotFromSelection,
  canCreateShotFromSelection,
  isCreatingShot,
  selectedClipCount = 0,
  isDragging,
  dragPreview,
  durationLimitSeconds,
  hardDurationSeconds,
}: TimelineCanvasProps, ref) {
  useRenderBudget('TimelineCanvas', 3);
  // dataKind V2: reactive base TimelineData → assembled duration-neutral
  // lanes (render-side merge via useDataLanes; the store's data is never
  // written, so lanes stay inert to duration/rows/export). Segment fetches
  // run through the single assembly authority shared with PropertiesPanel —
  // co-mounting both surfaces triggers one fetch per asset.
  const mountedEditorData = useTimelineEditorDataSafe();
  const { data: laneData, resolved: lanePlaneResolved } = useDataLanePlane({ base: mountedEditorData?.data ?? null });
  const showDataLanes = mountedEditorData?.preferences?.showDataLanes ?? false;
  const legacyTranscriptLaneVisible = mountedEditorData?.preferences?.showTranscriptLane ?? true;
  const kindVisibility = mountedEditorData?.preferences?.showDataLanesByKind;
  const showDataLanesByKind = useMemo<Record<string, boolean>>(() => ({
    'astrid.transcript': legacyTranscriptLaneVisible,
    ...kindVisibility,
  }), [legacyTranscriptLaneVisible, kindVisibility]);
  const laneDataForDisplay = useMemo(() => laneData ? {
    ...laneData,
    dataLanes: (laneData.dataLanes ?? [])
      .filter((lane) => showDataLanesByKind[lane.kindId] ?? showDataLanes)
      .map((lane) => ({ ...lane, height: resolveTimelineLaneHeight(lane, rowHeight) })),
  } : null, [laneData, rowHeight, showDataLanes, showDataLanesByKind]);
  const { dataRef, selectedClipIdsRef, ops, previewRef } = useTimelineMutableAdapters();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const latestScrollMetricsRef = useRef({ scrollLeft: 0, scrollTop: 0, viewportWidth: 0 });
  const [overlayScrollContainer, setOverlayScrollContainer] = useState<HTMLDivElement | null>(null);
  const [contentOverlayRoot, setContentOverlayRoot] = useState<HTMLDivElement | null>(null);
  const [rulerOverlayRoot, setRulerOverlayRoot] = useState<HTMLDivElement | null>(null);
  const [rulerOverlayStrip, setRulerOverlayStrip] = useState<HTMLDivElement | null>(null);
  const [overlayStores] = useState(createTimelineOverlayStores);
  const cursorRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef(0);
  const playRateRef = useRef(1);
  const pendingCenterClipIdRef = useRef<string | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [scrollDirection, setScrollDirection] = useState<'backward' | 'forward'>('forward');
  const [shotGroupMenu, setShotGroupMenu] = useState<ShotGroupMenuState>(null);
  const [timelineAreaMenu, setTimelineAreaMenu] = useState<TimelineAreaContextMenuState | null>(null);
  const shotGroupMenuRef = useRef<HTMLDivElement>(null);
  const timelineAreaMenuRef = useRef<HTMLDivElement>(null);
  const runtime = useContext(VideoEditorRuntimeContext);
  const commandRegistry = runtime?.commandRegistry;
  const extensions = runtime?.extensionRuntime?.extensions ?? [];
  useRenderDiagnostic('TimelineCanvas');

  const setScrollContainer = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node;
    latestScrollMetricsRef.current = {
      scrollLeft: node?.scrollLeft ?? 0,
      scrollTop: node?.scrollTop ?? 0,
      viewportWidth: node?.clientWidth ?? 0,
    };
    setOverlayScrollContainer(node);
    setViewportWidth(node?.clientWidth ?? 0);
  }, []);

  useLayoutEffect(() => {
    if (!overlayScrollContainer) return;
    const syncWidth = () => {
      const nextWidth = overlayScrollContainer.clientWidth;
      setViewportWidth((current) => current === nextWidth ? current : nextWidth);
    };
    syncWidth();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', syncWidth);
      return () => window.removeEventListener('resize', syncWidth);
    }
    const observer = new ResizeObserver(syncWidth);
    observer.observe(overlayScrollContainer);
    return () => observer.disconnect();
  }, [overlayScrollContainer]);

  const timelineViewStore = runtime?.timelineViewStore;
  useEffect(() => () => {
    overlayStores.viewport.dispose();
    overlayStores.playhead.dispose();
    // The timeline surface is gone: extensions reading the provider-owned
    // store must observe surfaceMounted=false instead of stale layout.
    timelineViewStore?.publish({
      surfaceMounted: false,
      viewport: null,
      geometry: null,
    });
  }, [overlayStores, timelineViewStore]);

  usePortalMousedownGuard(shotGroupMenuRef, Boolean(shotGroupMenu));

  useEffect(() => {
    if (!shotGroupMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (shotGroupMenuRef.current && !shotGroupMenuRef.current.contains(e.target as Node)) {
        setShotGroupMenu(null);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShotGroupMenu(null);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [shotGroupMenu]);

  useEffect(() => {
    if (!timelineAreaMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (timelineAreaMenuRef.current && !timelineAreaMenuRef.current.contains(e.target as Node)) {
        setTimelineAreaMenu(null);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTimelineAreaMenu(null);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [timelineAreaMenu]);

  const { pixelsPerSecond, pixelToTime, timeToPixel } = useTimelineScale({ scale, scaleWidth, startLeft });
  const resizeHandleWidth = shouldExpandTouchTrimHandles(deviceClass, inputModality, interactionMode)
    ? TOUCH_RESIZE_HANDLE_WIDTH
    : RESIZE_HANDLE_WIDTH;
  const touchGestureMode = resolveArmedTouchGesture(deviceClass, interactionMode);
  const minDuration = MIN_ACTION_WIDTH_PX / pixelsPerSecond;
  const { resizePreviewSnapshot, resizeClampedActionId } = useClipResizeGesture({
    timelineWrapperRef: scrollContainerRef,
    dataRef,
    rows,
    shotGroups,
    gestureOwner,
    setGestureOwner,
    onActionResizeStart,
    onActionResizing,
    onClipEdgeResizeEnd,
    onSelectClips,
    interactionStateRef,
    setInputModalityFromPointerType,
    timeToPixel,
    pixelToTime,
    pixelsPerSecond,
    minDuration,
    hardDurationSeconds,
  });
  const actionHeight = Math.max(12, rowHeight - ACTION_VERTICAL_MARGIN * 2);
  // Only the same visible lanes that DataLaneList mounts may affect viewport
  // geometry. Their temporal extent expands scrollable canvas space without
  // changing the project's authoritative duration or export range.
  const mountedDataLanes = useMemo(
    () => visibleDataLanes(laneDataForDisplay?.dataLanes),
    [laneDataForDisplay?.dataLanes],
  );
  const rowLayout = useMemo(() => buildTimelineRowLayout({
    tracks, lanes: laneDataForDisplay?.dataLanes,
    placement: mountedEditorData?.data?.resolvedConfig?.app?.timelineDataLanePlacement,
    mediaRowHeight: rowHeight,
  }), [tracks, laneDataForDisplay?.dataLanes, mountedEditorData?.data?.resolvedConfig?.app?.timelineDataLanePlacement, rowHeight]);
  useLayoutEffect(() => {
    const node = scrollContainerRef.current;
    if (!node) return;
    return publishTimelineRowLayout(node, rowLayout, mountedEditorData?.data ?? dataRef.current);
  }, [rowLayout, mountedEditorData?.data, dataRef]);
  const maxDataLaneEnd = useMemo(
    () => mountedDataLanes.reduce((laneMaximum, lane) => lane.items.reduce(
      (itemMaximum, item) => Math.max(itemMaximum, item.timelineStart, item.timelineEnd),
      laneMaximum,
    ), 0),
    [mountedDataLanes],
  );
  useLayoutEffect(() => {
    const node = overlayScrollContainer;
    if (!node) return;
    const dataItems = (laneDataForDisplay?.dataLanes ?? []).flatMap((lane) =>
      lane.items.map((view) => ({ laneId: lane.laneId, itemId: view.item.id })));
    const layoutKey = JSON.stringify([runtime?.timelineId, pixelsPerSecond,
      rowLayout.rows.map((row) => [row.sortableId, row.top, row.height])]);
    return publishMarqueePlane(node, { layoutKey, dataItems, clipIds: rows.flatMap((row) => row.actions.map((action) => action.id)) });
  }, [overlayScrollContainer, laneDataForDisplay, rowLayout, pixelsPerSecond, runtime?.timelineId, rows]);

  useEffect(() => {
    // Hidden lanes are an explicit removal from selection, even while their
    // source is loading. Item deletion is authoritative only after assembly.
    const selected = mountedEditorData?.selectedDataItems ?? [];
    if (!selected.length) return;
    const hidden = new Set((laneData?.dataLanes ?? []).filter((lane) =>
      !(showDataLanesByKind[lane.kindId] ?? showDataLanes)).map((lane) => lane.laneId));
    const valid = lanePlaneResolved
      ? (laneDataForDisplay?.dataLanes ?? []).flatMap((lane) => lane.items.map((view) => ({ laneId: lane.laneId, itemId: view.item.id })))
      : selected.filter((ref) => !hidden.has(ref.laneId));
    systemPruneTimelineDataItems(valid, runtime?.agentSelectionOwner);
    if (!valid.length && !(mountedEditorData?.selectedClipIds?.size)) ops?.clearSelection?.();
  }, [lanePlaneResolved, laneDataForDisplay, laneData, mountedEditorData?.selectedDataItems, runtime?.agentSelectionOwner, showDataLanesByKind, showDataLanes, mountedEditorData?.selectedClipIds?.size, ops]);

  /** A touch timeline (phone or tablet) is for seeing the cut and tapping a
   *  clip: adding elements and tracks, and tidying tracks, is the agent's job there. */
  const isTouch = deviceClass !== 'desktop';
  // The AI generation, extension and effect tools open the agent chat with a draft, so they need a prompt host.
  const hasPromptHost = Boolean(onOpenElementCreationPrompt);
  const hasEffectCreationTool = hasPromptHost || Boolean(onAddEffectLayerAt);
  const hasToolCluster = hasPromptHost || hasEffectCreationTool;
  // Desktop only. The create buttons live in the footer row, pinned to the bottom of the scroll viewport; the row is
  // as tall as a track or, when the buttons need more, one button plus padding; the scroll content ends with it.
  const canvasHostsCluster = !isTouch && hasToolCluster;
  const footerHeight = canvasHostsCluster ? Math.max(rowHeight, TOOL_CLUSTER_FOOTER_HEIGHT_PX) : rowHeight;
  const scrollContentHeight = rowLayout.totalHeight + footerHeight;
  const maxClipEnd = useMemo(() => rows.reduce((currentMax, row) => row.actions.reduce(
    (rowMax, action) => Math.max(rowMax, resizePreviewSnapshot[action.id]?.end ?? action.end),
    currentMax,
  ), 0), [resizePreviewSnapshot, rows]);
  const maxShotGroupEnd = useMemo(() => shotGroups.reduce(
    (currentMax, group) => Math.max(
      currentMax,
      resizePreviewSnapshot[`${shotGroupVideoKey(group)}:${group.rowId}`]?.end ?? shotGroupEndSeconds(group),
    ),
    0,
  ), [resizePreviewSnapshot, shotGroups]);
  const proposedMaxClipEnd = useMemo(() => {
    if (dragPreview) {
      const draggedIds = new Set(dragPreview.clipIds);
      const remainingEnd = rows.reduce((currentMax, row) => row.actions.reduce(
        (rowMax, action) => draggedIds.has(action.id) ? rowMax : Math.max(rowMax, action.end),
        currentMax,
      ), 0);
      return Math.max(remainingEnd, dragPreview.end);
    }
    // Resize previews already replace the rendered action end. Expose the
    // same proposed boundary line while that transient snapshot is active.
    return Object.keys(resizePreviewSnapshot).length > 0 ? maxClipEnd : undefined;
  }, [dragPreview, maxClipEnd, resizePreviewSnapshot, rows]);
  const maxEnd = Math.max(maxClipEnd, maxDataLaneEnd, maxShotGroupEnd);
  const dataLaneScaleCount = Math.ceil(
    maxDataLaneEnd / Math.max(scale, Number.EPSILON),
  ) + 1;
  const effectiveMaxScaleCount = maxScaleCount === undefined
    ? undefined
    : Math.max(maxScaleCount, dataLaneScaleCount);
  // Content-only derivation: the trailing runway is the owner's call and reaches
  // us as minScaleCount/maxScaleCount (TimelineEditorCore pins both to one value).
  const { totalWidth } = computeTimelineExtent({
    maxEndSeconds: Math.max(maxEnd, durationLimitSeconds ?? 0, hardDurationSeconds ?? 0),
    scale,
    scaleWidth,
    startLeft,
    trailingRunwaySeconds: 0,
    minScaleCount,
    maxScaleCount: effectiveMaxScaleCount,
  });
  const scrollDataLaneItemIntoView = useCallback((timelineStart: number, timelineEnd: number) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const measuredWidth = container.clientWidth || viewportWidth;
    const canvasViewportWidth = Math.max(1, measuredWidth - startLeft);
    const itemLeft = Math.max(0, timelineStart * pixelsPerSecond);
    const itemRight = Math.max(itemLeft + 2, timelineEnd * pixelsPerSecond);
    const visibleLeft = container.scrollLeft;
    const visibleRight = visibleLeft + canvasViewportWidth;
    let nextScrollLeft = visibleLeft;
    if (itemRight - itemLeft > canvasViewportWidth) {
      nextScrollLeft = itemLeft + (itemRight - itemLeft - canvasViewportWidth) / 2;
    } else if (itemLeft < visibleLeft) {
      nextScrollLeft = itemLeft;
    } else if (itemRight > visibleRight) {
      nextScrollLeft = itemRight - canvasViewportWidth;
    }
    const maximumScrollLeft = Math.max(0, totalWidth - measuredWidth);
    nextScrollLeft = clamp(nextScrollLeft, 0, maximumScrollLeft);
    if (nextScrollLeft === visibleLeft) return;
    if (typeof container.scrollTo === 'function') {
      container.scrollTo({ left: nextScrollLeft, top: container.scrollTop, behavior: 'auto' });
    } else {
      container.scrollLeft = nextScrollLeft;
    }
    // Do not wait for the browser's scroll event: the target must mount in the
    // same interaction turn so focus restoration cannot observe a blank lane.
    latestScrollMetricsRef.current = {
      scrollLeft: nextScrollLeft,
      scrollTop: container.scrollTop,
      viewportWidth: measuredWidth,
    };
    setScrollDirection(nextScrollLeft < visibleLeft ? 'backward' : 'forward');
    setScrollLeft(nextScrollLeft);
  }, [pixelsPerSecond, startLeft, totalWidth, viewportWidth]);
  const overlayGeometry = useMemo(() => createTimelineOverlayGeometry({
    scale,
    scaleWidth,
    startLeft,
    extentStart: 0,
    extentEnd: Math.max(0, pixelToTime(totalWidth)),
  }), [pixelToTime, scale, scaleWidth, startLeft, totalWidth]);
  // Reactive selection from the module-level selection store (the adapter's
  // selectedClipIdsRef is a render-lagging mirror updated in a layout effect;
  // reading it during render would publish stale selection).
  const timelineSelection = useTimelineSelectionStore(runtime?.agentSelectionOwner);
  const overlaySelectedClipIds = selectedClipIdsRef.current;
  const overlaySelection = useMemo(() => Object.freeze({
    selectedClipIds: overlaySelectedClipIds,
    hasSelection: overlaySelectedClipIds.size > 0,
  }), [overlaySelectedClipIds]);
  const overlayFps = dataRef.current?.output?.fps ?? 24;

  // Publish selection changes into the provider-owned TimelineViewStore so
  // `ctx.creative.timelineView` reflects live selection for commands. Keyed
  // on the reactive store value, not the ref, so it cannot lag.
  useEffect(() => {
    const ids = timelineSelection.selectedClipIds;
    runtime?.timelineViewStore?.publish({
      selection: Object.freeze({
        selectedClipIds: ids,
        hasSelection: ids.size > 0,
      }),
    });
  }, [runtime, timelineSelection.selectedClipIds]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    const viewportSnapshot = {
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
      viewportWidth: container.clientWidth,
      viewportHeight: container.clientHeight,
      totalWidth,
      totalHeight: scrollContentHeight,
    };
    overlayStores.viewport.update(viewportSnapshot);
    overlayStores.frameTime.publish({
      timestamp: typeof performance === 'undefined' ? Date.now() : performance.now(),
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    });
    // Provider-owned TimelineViewStore: publish layout regardless of the
    // overlay flag so `ctx.creative.timelineView` stays live for commands.
    runtime?.timelineViewStore?.publish({
      viewport: viewportSnapshot,
      geometry: overlayGeometry,
      surfaceMounted: true,
    });
  }, [overlayScrollContainer, overlayStores, runtime, scrollContentHeight, totalWidth, overlayGeometry]);
  const rowResizePreview = useMemo(
    () => rows.map<Readonly<Record<string, ResizeOverride>>>((row) => {
      let previewForRow: Record<string, ResizeOverride> | null = null;
      for (const action of row.actions) {
        const override = resizePreviewSnapshot[action.id];
        if (!override) {
          continue;
        }

        if (!previewForRow) {
          previewForRow = {};
        }
        previewForRow[action.id] = override;
      }

      return previewForRow ?? EMPTY_RESIZE_PREVIEW_SNAPSHOT;
    }),
    [resizePreviewSnapshot, rows],
  );
  const positionedShotGroups = useMemo(() => {
    return shotGroups.flatMap<PositionedShotGroup>((group) => {
      const row = rows[group.rowIndex];
      if (!row || row.id !== group.rowId) {
        return [];
      }

      const lastChild = group.children[group.children.length - 1];
      if (!lastChild && group.end === undefined) {
        return [];
      }

      const groupKey = `${shotGroupVideoKey(group)}:${group.rowId}`;
      const preview = resizePreviewSnapshot[groupKey];
      const start = preview?.start ?? group.start;
      const end = preview?.end ?? group.end ?? (group.start + lastChild!.offset + lastChild!.duration);
      const finalVideo = finalVideoMap?.get(shotGroupVideoKey(group));

      return [{
        key: `${shotGroupVideoKey(group)}:${group.rowId}:${group.clipIds.join(',')}`,
        shotId: group.shotId,
        shotName: group.shotName,
        clipIds: group.clipIds,
        start,
        end,
        rowId: group.rowId,
        color: group.color,
        mode: group.mode,
        hasFinalVideo: finalVideoMap?.has(shotGroupVideoKey(group)) ?? false,
        hasManagedOutput: Boolean(finalVideo && typeof finalVideo === 'object' && (finalVideo as { managedOutput?: unknown }).managedOutput),
        hasStaleVideo: staleShotGroupIds?.has(`${group.shotId}:${group.rowId}`) ?? false,
        hasActiveTask: activeTaskClipIds ? group.clipIds.some((id) => activeTaskClipIds.has(id)) : false,
        ...(group.thumbnailSrc ? { thumbnailSrc: group.thumbnailSrc } : {}),
        ...(group.pending ? { pending: true } : {}),
        left: timeToPixel(start),
        top: (rowLayout.trackRects.get(group.rowId)?.top ?? 0) + ACTION_VERTICAL_MARGIN,
        width: Math.max((end - start) * pixelsPerSecond, 1),
        height: actionHeight,
        ...(group.canonicalIdentity ? { canonicalIdentity: group.canonicalIdentity } : {}),
      }];
    });
  }, [actionHeight, activeTaskClipIds, finalVideoMap, pixelsPerSecond, resizePreviewSnapshot, rowLayout, rowHeight, rows, tracks, shotGroups, staleShotGroupIds, timeToPixel]);
  const [hoveredShotGroupKey, setHoveredShotGroupKey] = useState<string | null>(null);
  const updateHoveredShotGroup = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;
    // Labels float outside the scroll container. Treat both the label and
    // its complete shot body as one hover surface without covering clips
    // with another pointer target (which would steal drag/resize gestures).
    const label = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-shot-group-key]') : null;
    if (label) {
      setHoveredShotGroupKey(label.dataset.shotGroupKey ?? null);
      return;
    }
    const scroller = scrollContainerRef.current;
    if (!scroller || !scroller.contains(event.target as Node)) {
      setHoveredShotGroupKey(null);
      return;
    }
    const bounds = scroller.getBoundingClientRect();
    const viewportX = event.clientX - bounds.left;
    const x = viewportX + scroller.scrollLeft;
    const y = event.clientY - bounds.top + scroller.scrollTop;
    const group = viewportX >= startLeft && positionedShotGroups.find((candidate) => (
      x >= candidate.left && x < candidate.left + candidate.width
      && y >= candidate.top && y < candidate.top + candidate.height
    ));
    setHoveredShotGroupKey(group ? group.key : null);
  }, [positionedShotGroups, startLeft]);
  const handleSelectShotGroup = useCallback((group: PositionedShotGroup) => {
    if (onShotGroupSelect) {
      onShotGroupSelect(group);
      return;
    }
    onSelectTrack?.(group.rowId);
    if (group.canonicalIdentity) {
      ops?.clearSelection?.();
      ops?.setInspectorTarget?.({
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
    ops?.setInspectorTarget?.(null);
    onSelectClips?.(group.clipIds);
  }, [onSelectClips, onShotGroupSelect, onSelectTrack, ops]);

  const centerClipInViewport = useCallback((clipId: string): boolean => {
    const container = scrollContainerRef.current;
    if (!container) {
      return false;
    }

    // Plain loop, not rows.some(): assignments inside a callback are invisible
    // to control-flow narrowing, which collapsed targetAction to `never` below.
    let targetAction: TimelineAction | null = null;
    let targetRowIndex = -1;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const found = rows[rowIndex].actions.find((candidate) => candidate.id === clipId);
      if (found) {
        targetAction = found;
        targetRowIndex = rowIndex;
        break;
      }
    }
    if (!targetAction || targetRowIndex < 0) {
      return false;
    }

    const viewportWidth = container.clientWidth || container.getBoundingClientRect().width;
    const viewportHeight = container.clientHeight || container.getBoundingClientRect().height;
    const clipCenterX = startLeft + ((targetAction.start + targetAction.end) / 2) * pixelsPerSecond;
    const targetRect = rowLayout.trackRects.get(tracks[targetRowIndex]?.id);
    if (!targetRect) return false;
    const clipCenterY = targetRect.top + targetRect.height / 2;
    const maxScrollLeft = Math.max(0, totalWidth - viewportWidth);
    const maxScrollTop = Math.max(0, scrollContentHeight - viewportHeight);
    const nextScrollLeft = clamp(clipCenterX - viewportWidth / 2, 0, maxScrollLeft);
    const nextScrollTop = clamp(clipCenterY - viewportHeight / 2, 0, maxScrollTop);

    container.scrollTo({
      left: nextScrollLeft,
      top: nextScrollTop,
      behavior: 'smooth',
    });
    return true;
  }, [pixelsPerSecond, rowLayout, rows, tracks, scrollContentHeight, startLeft, totalWidth]);

  const scheduleCenterClipInViewport = useCallback((clipId: string) => {
    pendingCenterClipIdRef.current = clipId;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (pendingCenterClipIdRef.current !== clipId) {
          return;
        }
        if (centerClipInViewport(clipId)) {
          pendingCenterClipIdRef.current = null;
        }
      });
    });
  }, [centerClipInViewport]);

  useEffect(() => {
    const handleCenterClip = (event: Event) => {
      const detail = (event as CustomEvent<TimelineCenterClipEventDetail>).detail;
      if (!detail?.clipId) {
        return;
      }
      scheduleCenterClipInViewport(detail.clipId);
    };
    window.addEventListener(TIMELINE_CENTER_CLIP_EVENT, handleCenterClip);
    return () => window.removeEventListener(TIMELINE_CENTER_CLIP_EVENT, handleCenterClip);
  }, [scheduleCenterClipInViewport]);

  // ── Source → Timeline navigation ───────────────────────────────────
  useEffect(() => {
    const handleSourceNavigate = (event: Event) => {
      const detail = (event as CustomEvent<SourceNavigateToTimelineDetail>).detail;
      if (!detail?.extensionId) return;

      // If a specific target is requested, center on it
      if (detail.targetId) {
        scheduleCenterClipInViewport(detail.targetId);
      }
      // Dispatch event for source-panel listeners
      window.dispatchEvent(
        new CustomEvent('astrid:source-navigate-to-timeline-handled', {
          detail: { ...detail, handled: true },
        }),
      );
    };
    window.addEventListener(SOURCE_NAVIGATE_TO_TIMELINE_EVENT, handleSourceNavigate);
    return () => window.removeEventListener(SOURCE_NAVIGATE_TO_TIMELINE_EVENT, handleSourceNavigate);
  }, [scheduleCenterClipInViewport]);

  useEffect(() => {
    const pendingClipId = pendingCenterClipIdRef.current;
    if (pendingClipId) {
      scheduleCenterClipInViewport(pendingClipId);
    }
  }, [rows, scheduleCenterClipInViewport]);
  const hideShotGroups = isDragging ?? dragSessionRef?.current !== null;
  const showTouchShotGroupActions = deviceClass !== 'desktop';
  const openShotGroupMenu = useCallback((
    x: number,
    y: number,
    group: Pick<PositionedShotGroup, 'shotId' | 'shotName' | 'clipIds' | 'rowId' | 'hasFinalVideo' | 'hasStaleVideo' | 'mode' | 'canonicalIdentity'>,
  ) => {
    setShotGroupMenu({ x, y, ...group, trackId: group.rowId });
  }, []);

  const handleTimelineAreaContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const eventTarget = event.target instanceof Element ? event.target : null;
    if (eventTarget?.closest(TIMELINE_AREA_CONTEXT_MENU_IGNORE_SELECTOR)) {
      return;
    }

    if (marqueeRect) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const container = scrollContainerRef.current;
    const containerRect = container?.getBoundingClientRect();
    const time = container && containerRect
      ? Math.max(0, pixelToTime(container.scrollLeft + (event.clientX - containerRect.left)))
      : 0;
    const rowElement = eventTarget?.closest(`[${ROW_ID_ATTR}]`);
    const trackId = rowElement instanceof HTMLElement ? rowElement.dataset.rowId : undefined;

    const target: TargetContextPayload = { target: 'timeline-area' };
    const hasSelectionActions = Boolean(
      canCreateShotFromSelection && selectedClipCount >= 2 && onCreateShotFromSelection,
    );
    const hasBuiltInActions = hasSelectionActions;
    if (!hasBuiltInActions && !hasEligibleExtensionContextMenuItems(commandRegistry, extensions, target)) {
      // The editor owns this surface: no actions means no menu, not the browser's.
      event.preventDefault();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setTimelineAreaMenu({
      x: event.clientX,
      y: event.clientY,
      time,
      trackId,
      target,
    });
  }, [canCreateShotFromSelection, commandRegistry, extensions, marqueeRect, onCreateShotFromSelection, pixelToTime, selectedClipCount]);

  const handlePostprocessShaderBadgeClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!postprocessShader) {
      return;
    }
    onSelectPostprocessShader?.(postprocessShader);
  }, [onSelectPostprocessShader, postprocessShader]);

  const syncCursor = useCallback((time = timeRef.current) => {
    const cursor = cursorRef.current;
    if (!cursor) {
      return;
    }

    const left = timeToPixel(time);
    cursor.style.transform = `translateX(${left}px)`;
  }, [timeToPixel]);

  const handleSetTime = useCallback((time: number) => {
    timeRef.current = Math.max(0, time);
    syncCursor(timeRef.current);
    overlayStores.playhead.set(timeRef.current, false);
    // Provider-owned TimelineViewStore: keep `ctx.creative.timelineView`
    // playhead fresh for renderer-independent commands (B key etc.). The
    // playback flag comes from the live player handle, not a hardcode.
    const isPlaying = previewRef.current?.isPlaying ?? false;
    runtime?.timelineViewStore?.publish({
      playhead: { time: timeRef.current, isPlaying },
    });
  }, [overlayStores.playhead, previewRef, runtime, syncCursor]);

  useEffect(() => {
    syncCursor();
  }, [syncCursor]);

  useImperativeHandle(ref, () => ({
    get target() {
      return scrollContainerRef.current;
    },
    listener: null,
    isPlaying: false,
    isPaused: true,
    setTime: handleSetTime,
    getTime: () => timeRef.current,
    setPlayRate: (rate: number) => {
      playRateRef.current = rate;
    },
    getPlayRate: () => playRateRef.current,
    reRender: () => syncCursor(),
    play: ({ toTime }) => {
      if (typeof toTime === 'number') {
        handleSetTime(toTime);
      }
      return false;
    },
    pause: () => {},
    setScrollLeft: (value: number) => {
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollLeft = Math.max(0, value);
      }
    },
  }), [handleSetTime, syncCursor]);

  // The effect-layer insert falls back to the first visual
  // track when the id does not resolve, so an empty id is a safe "pick for me".
  const firstVisualTrackId = useMemo(
    () => tracks.find((track) => track.kind === 'visual')?.id ?? '',
    [tracks],
  );
  const openDraft = useCallback((draft: string) => {
    onOpenElementCreationPrompt?.(draft);
  }, [onOpenElementCreationPrompt]);

  const handleCreateEffect = useCallback(() => {
    if (onOpenElementCreationPrompt) {
      openDraft(EFFECT_OR_ANIMATION_DRAFT);
      return;
    }
    onAddEffectLayerAt?.(firstVisualTrackId, timeRef.current);
  }, [firstVisualTrackId, onAddEffectLayerAt, onOpenElementCreationPrompt, openDraft]);

  // ── Touch: two-finger pinch zoom ───────────────────────────────────────
  const pinchSessionRef = useRef<{ startDistance: number; startScaleWidth: number; time: number; offsetX: number } | null>(null);
  const pinchAnchorRef = useRef<{ time: number; offsetX: number } | null>(null);
  const pinchInputsRef = useRef({ scaleWidth, pixelsPerSecond, startLeft, onScaleWidthChange });
  pinchInputsRef.current = { scaleWidth, pixelsPerSecond, startLeft, onScaleWidthChange };
  const pinchGestureOwnerRef = useRef(gestureOwner);
  pinchGestureOwnerRef.current = gestureOwner;
  const pinchEnabled = shouldEnableTimelinePinchZoom(deviceClass) && Boolean(onScaleWidthChange);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!pinchEnabled || !container) {
      return;
    }

    const spread = (touches: TouchList) => Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );

    const handleTouchStart = (event: TouchEvent) => {
      if (pinchGestureOwnerRef.current === 'overlay') {
        pinchSessionRef.current = null;
        return;
      }
      if (event.touches.length !== 2) {
        pinchSessionRef.current = null;
        return;
      }

      const { pixelsPerSecond: currentPps, scaleWidth: currentScaleWidth, startLeft: currentStartLeft } = pinchInputsRef.current;
      const offsetX = (event.touches[0].clientX + event.touches[1].clientX) / 2
        - container.getBoundingClientRect().left;
      pinchSessionRef.current = {
        startDistance: Math.max(1, spread(event.touches)),
        startScaleWidth: currentScaleWidth,
        time: (container.scrollLeft + offsetX - currentStartLeft) / currentPps,
        offsetX,
      };
      // Claims the gesture from native pan/pinch-zoom for its whole lifetime.
      event.preventDefault();
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (pinchGestureOwnerRef.current === 'overlay') {
        pinchSessionRef.current = null;
        return;
      }
      const session = pinchSessionRef.current;
      if (!session || event.touches.length !== 2) {
        return;
      }

      event.preventDefault();
      const nextScaleWidth = clampTimelineScaleWidth(
        session.startScaleWidth * (Math.max(1, spread(event.touches)) / session.startDistance),
      );
      if (nextScaleWidth === pinchInputsRef.current.scaleWidth) {
        return;
      }

      pinchAnchorRef.current = { time: session.time, offsetX: session.offsetX };
      pinchInputsRef.current.onScaleWidthChange?.(nextScaleWidth);
    };

    const endPinch = () => {
      pinchSessionRef.current = null;
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: false });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', endPinch);
    container.addEventListener('touchcancel', endPinch);
    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', endPinch);
      container.removeEventListener('touchcancel', endPinch);
    };
  }, [pinchEnabled]);

  // Trackpad pinch (a ctrl-wheel in Chrome) and Ctrl/Cmd+wheel zoom the timeline around the pointer, the same
  // anchor as touch pinch. Non-passive so Chrome's page zoom never takes it.
  const hasScaleWidthChange = Boolean(onScaleWidthChange);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!hasScaleWidthChange || !container) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      const { pixelsPerSecond: currentPps, scaleWidth: currentScaleWidth, startLeft: currentStartLeft } = pinchInputsRef.current;
      const lineScale = event.deltaMode === 1 ? 16 : 1;
      const delta = Math.max(-60, Math.min(60, event.deltaY * lineScale));
      const nextScaleWidth = clampTimelineScaleWidth(currentScaleWidth * Math.exp(-delta * 0.01));
      if (nextScaleWidth === currentScaleWidth) {
        return;
      }
      const offsetX = event.clientX - container.getBoundingClientRect().left;
      pinchAnchorRef.current = {
        time: (container.scrollLeft + offsetX - currentStartLeft) / currentPps,
        offsetX,
      };
      pinchInputsRef.current.onScaleWidthChange?.(nextScaleWidth);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [hasScaleWidthChange]);

  // Keeps the pinched-at time under the gesture midpoint once the new zoom lands.
  useLayoutEffect(() => {
    const anchor = pinchAnchorRef.current;
    const container = scrollContainerRef.current;
    if (!anchor || !container) {
      return;
    }

    pinchAnchorRef.current = null;
    container.scrollLeft = Math.max(0, startLeft + anchor.time * pixelsPerSecond - anchor.offsetX);
  }, [pixelsPerSecond, startLeft]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    setHoveredShotGroupKey(null);
    const nextMetrics = {
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
    };
    const viewportWidth = event.currentTarget.clientWidth;
    const previousScrollLeft = latestScrollMetricsRef.current.scrollLeft;
    latestScrollMetricsRef.current = { ...nextMetrics, viewportWidth };
    // Scroll is a continuous browser event, but the native scroll position can
    // paint before a concurrent React update. Commit the virtual-window
    // coordinates synchronously so a stale window cannot produce a blank
    // frame. The lane itself retains directional runway for the next frame.
    flushSync(() => {
      setScrollLeft(nextMetrics.scrollLeft);
      setScrollTop(nextMetrics.scrollTop);
      setViewportWidth(viewportWidth);
      if (nextMetrics.scrollLeft !== previousScrollLeft) {
        setScrollDirection(nextMetrics.scrollLeft < previousScrollLeft ? 'backward' : 'forward');
      }
    });
    overlayStores.viewport.update({
      ...nextMetrics,
      viewportWidth: event.currentTarget.clientWidth,
      viewportHeight: event.currentTarget.clientHeight,
      totalWidth,
      totalHeight: scrollContentHeight,
    });
    overlayStores.frameTime.publish({
      timestamp: typeof performance === 'undefined' ? Date.now() : performance.now(),
      ...nextMetrics,
    });
    // Keep the provider-owned TimelineViewStore viewport live on scroll
    // (the layout effect only publishes initial/zoom layout).
    runtime?.timelineViewStore?.publish({
      viewport: {
        ...nextMetrics,
        viewportWidth: event.currentTarget.clientWidth,
        viewportHeight: event.currentTarget.clientHeight,
        totalWidth,
        totalHeight: scrollContentHeight,
      },
    });
    syncCursor();
  };

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-background/70"
      {...{ [EDITOR_TOUR_ANCHOR_ATTRIBUTE]: EDITOR_TOUR_ANCHORS.timeline }}
      style={VIDEO_EDITOR_THEME_VARS}
      onPointerOverCapture={updateHoveredShotGroup}
      onPointerMoveCapture={updateHoveredShotGroup}
      onPointerLeave={() => setHoveredShotGroupKey(null)}
    >
      <TimelineRulerAndGrid
        scale={scale}
        scaleWidth={scaleWidth}
        scaleSplitCount={scaleSplitCount}
        startLeft={startLeft}
        scrollLeft={scrollLeft}
        totalWidth={totalWidth}
        gestureOwner={gestureOwner}
        onClickTimeArea={onClickTimeArea}
        onCursorDrag={onCursorDrag}
        setGestureOwner={setGestureOwner}
        setInputModalityFromPointerType={setInputModalityFromPointerType}
        unusedTrackCount={unusedTrackCount}
        onClearUnusedTracks={isTouch ? undefined : onClearUnusedTracks}
        compactLabels={isTouch}
      />
      <div
        ref={setRulerOverlayRoot}
        data-testid="timeline-extension-ruler-overlay-root"
        className="pointer-events-none absolute inset-x-0 top-0 z-20 h-[30px] overflow-hidden"
      >
        <div
          ref={setRulerOverlayStrip}
          data-testid="timeline-extension-ruler-overlay-strip"
          className="pointer-events-none absolute left-0 top-0 h-full"
          style={{ width: totalWidth }}
        />
      </div>
      {postprocessShader && onSelectPostprocessShader && (
        <button
          type="button"
          className="absolute top-1 z-30 flex max-w-[min(24rem,calc(100%-12rem))] items-center gap-1.5 rounded-md border border-emerald-400/50 bg-emerald-500/15 px-2 py-1 text-[10px] font-medium text-emerald-100 shadow-sm transition-colors hover:border-emerald-300 hover:bg-emerald-500/25"
          style={{ left: startLeft + 8 }}
          data-postprocess-shader-badge="true"
          data-shader-scope="postprocess"
          data-shader-id={postprocessShader.shaderId}
          data-extension-id={postprocessShader.extensionId}
          aria-label={`Open postprocess shader controls for ${postprocessShader.label ?? postprocessShader.shaderId}`}
          title={`Postprocess shader: ${postprocessShader.label ?? postprocessShader.shaderId}`}
          onClick={handlePostprocessShaderBadgeClick}
        >
          <Sparkles className="h-3 w-3 shrink-0" />
          <span className="shrink-0 uppercase tracking-[0.12em]">Postprocess</span>
          <span className="truncate text-foreground/90">{postprocessShader.label ?? postprocessShader.shaderId}</span>
        </button>
      )}
      <ShotGroupLabels
        positionedShotGroups={positionedShotGroups}
        labelWidth={startLeft}
        hidden={hideShotGroups}
        showTouchActions={showTouchShotGroupActions}
        scrollLeft={scrollLeft}
        scrollTop={scrollTop}
        openShotGroupMenu={openShotGroupMenu}
        onSelectClips={onSelectClips}
        onSelectTrack={onSelectTrack}
        onSelectShotGroup={handleSelectShotGroup}
        selectedCanonicalOccurrenceId={selectedCanonicalOccurrenceId}
        hoveredShotGroupKey={hoveredShotGroupKey}
        onShotGroupNavigate={onShotGroupNavigate}
        onShotGroupOpen={onShotGroupOpen}
      />
      <div
        ref={setScrollContainer}
        data-timeline-row-layout="managed"
        data-device-class={deviceClass}
        className={`${EDIT_AREA_CLASS} timeline-scroll relative min-h-0 flex-1 overflow-auto overscroll-contain overscroll-x-contain bg-background/70`}
        {...touchGestureModeAttrs(touchGestureMode)}
        style={{ '--label-width': `${startLeft}px` } as React.CSSProperties}
        onPointerDown={onEditAreaPointerDown}
        onScroll={handleScroll}
      >
        <div
          className="relative flex flex-col"
          onContextMenu={handleTimelineAreaContextMenu}
          style={{
            width: totalWidth,
            minWidth: '100%',
            minHeight: '100%',
            backgroundImage: buildGridBackground(startLeft, scaleWidth, scaleSplitCount),
            backgroundPosition: `${startLeft}px 0, ${startLeft}px 0`,
          }}
        >
          {marqueeRect && (
            <div
              className="pointer-events-none absolute z-30 border border-[color:var(--video-editor-accent-border-strong)] bg-[var(--video-editor-accent-bg)]"
              style={{
                left: marqueeRect.x,
                top: marqueeRect.y,
                width: marqueeRect.width,
                height: marqueeRect.height,
              }}
            />
          )}
          {durationLimitSeconds !== undefined && (
            <TimelineDurationGuide
              durationSeconds={durationLimitSeconds}
              hardDurationSeconds={hardDurationSeconds}
              maxClipEndSeconds={maxClipEnd}
              proposedMaxClipEndSeconds={proposedMaxClipEnd}
              proposalRejected={Boolean(dragPreview?.rejected || resizeClampedActionId)}
              startLeft={startLeft}
              pixelsPerSecond={pixelsPerSecond}
              totalWidth={totalWidth}
              height={scrollContentHeight}
            />
          )}
          {newTrackDropLabel?.includes('at top') && (
            <div className="pointer-events-none absolute left-0 right-0 top-0 z-10 h-1 bg-[var(--video-editor-accent-text-soft)]" style={{ marginLeft: startLeft }} />
          )}
          <ShotGroupBorders
            positionedShotGroups={positionedShotGroups}
            hidden={hideShotGroups}
          />
          <ShotGroupContextMenu
            menu={shotGroupMenu}
            menuRef={shotGroupMenuRef}
            closeMenu={() => setShotGroupMenu(null)}
            onNavigate={onShotGroupNavigate}
            onGenerateVideo={onShotGroupGenerateVideo}
            onSwitchToFinalVideo={onShotGroupSwitchToFinalVideo}
            onExportManagedOutput={onShotGroupExportManagedOutput}
            onSwitchToImages={onShotGroupSwitchToImages}
            onUpdateToLatestVideo={onShotGroupUpdateToLatestVideo}
            onUnpinGroup={onShotGroupUnpin}
            onDeleteShot={onShotGroupDelete}
            onDuplicateGroup={onShotGroupDuplicate}
            onPromotePrimary={onShotGroupPromotePrimary}
          />
          {timelineAreaMenu && (
            <TimelineAreaExtensionContextMenu
              menu={timelineAreaMenu}
              menuRef={timelineAreaMenuRef}
              closeMenu={() => setTimelineAreaMenu(null)}
              onCreateShotFromSelection={onCreateShotFromSelection}
              canCreateShotFromSelection={canCreateShotFromSelection}
              isCreatingShot={isCreatingShot}
              selectedClipCount={selectedClipCount}
            />
          )}
          <TimelineGhostLayer
            ghosts={ghostEntries ?? []}
            rowLayout={rowLayout}
            rows={rows}
            rowHeight={rowHeight}
            startLeft={startLeft}
            pixelsPerSecond={pixelsPerSecond}
          />
          <TrackListRenderer
            rows={rows}
            tracks={tracks}
            rowLayout={rowLayout}
            readOnly={readOnly}
            showReadOnlyTrackName={showReadOnlyTrackName}
            renderDataLane={(laneId) => (
          <DataLaneList
            data={laneDataForDisplay}
            laneId={laneId}
            selectedTarget={mountedEditorData?.inspectorTarget}
            selectedDataItems={mountedEditorData?.selectedDataItems}
            selectionOwner={runtime?.agentSelectionOwner}
            onOpenExtensionManager={onOpenExtensionManager}
            sortable
            readOnly={readOnly}
            timelineViewStore={runtime?.timelineViewStore}
            startLeft={startLeft}
            pixelsPerSecond={pixelsPerSecond}
            viewport={{ scrollLeft, clientWidth: viewportWidth, scrollDirection }}
            onRequestItemIntoView={scrollDataLaneItemIntoView}
            clearSelection={ops?.clearSelection}
            setSelectedTrackId={ops?.setSelectedTrackId}
            setContextTarget={ops?.setContextTarget}
            setInspectorTarget={ops?.setInspectorTarget}
          />
            )}
            nestedAudioTrackIds={nestedAudioTrackIds}
            rowHeight={rowHeight}
            startLeft={startLeft}
            pixelsPerSecond={pixelsPerSecond}
            selectedTrackId={selectedTrackId}
            deviceClass={deviceClass}
            resizeClampedActionId={resizeClampedActionId}
            rowResizePreview={rowResizePreview}
            resizeHandleWidth={resizeHandleWidth}
            getActionRender={getActionRender}
            getActionPaintLayer={getActionPaintLayer}
            shouldStackOverlappingActions={shouldStackOverlappingActions}
            onSelectTrack={onSelectTrack}
            onTrackChange={onTrackChange}
            onRemoveTrack={onRemoveTrack}
            onTrackDragEnd={(event) => onTrackDragEnd(event, laneDataForDisplay?.dataLanes ?? [])}
            trackSensors={trackSensors}
          />
          <div
            ref={setContentOverlayRoot}
            data-testid="timeline-extension-content-overlay-root"
            className="pointer-events-none absolute inset-0 z-20"
          />
        </div>
        {/* Footer: + Video / + Audio split buttons and the desktop create tools, outside the grid background div.
            The tools are in the layout flow, below the last row, so no track is ever under a button. */}
        <div
          data-testid="timeline-footer-row"
          className={cn('relative mt-auto flex shrink-0', !isTouch && 'sticky bottom-0 z-20 border-t border-border bg-background')}
          style={{ height: footerHeight, width: totalWidth, minWidth: '100%' }}
        >
          <div
            className={cn('z-20 flex', !isTouch && 'bg-card')}
            style={{ width: startLeft, position: 'sticky', left: 0 }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {onAddTrack && !isTouch && (
              <>
                <button
                  type="button"
                  className="flex flex-1 items-center justify-center gap-0.5 border-r border-border/50 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => onAddTrack('visual')}
                >
                  + Video
                </button>
                <button
                  type="button"
                  className="flex flex-1 items-center justify-center gap-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => onAddTrack('audio')}
                >
                  + Audio
                </button>
              </>
            )}
          </div>
          {canvasHostsCluster && (
            <TimelineCreateTools
              labelWidth={startLeft}
              onCreateImageGeneration={hasPromptHost ? () => openDraft(AI_GENERATION_DRAFT) : undefined}
              onCreateExtension={hasPromptHost ? () => openDraft(EXTENSION_DRAFT) : undefined}
              onCreateEffect={hasEffectCreationTool ? handleCreateEffect : undefined}
              effectDragSource={!onOpenElementCreationPrompt}
            />
          )}
          <div className="flex flex-1 items-center gap-2 px-2" style={{ position: 'sticky', left: startLeft }}>
            {newTrackDropLabel && newTrackDropLabel.includes('at bottom') ? (
              <div className="pointer-events-none h-1 flex-1 rounded-full bg-[var(--video-editor-accent-text-soft)]" />
            ) : null}
          </div>
        </div>
        <div
          ref={cursorRef}
          data-testid="timeline-playhead"
          className="pointer-events-none absolute left-0 top-0 z-[5] bg-[var(--video-editor-accent-border-strong)] shadow-[0_0_10px_var(--video-editor-accent-shadow)]"
          style={{
            width: CURSOR_WIDTH,
            height: scrollContentHeight,
            transform: `translateX(${startLeft}px)`,
          }}
        />
      </div>
      {runtime?.timelineOverlaysEnabled === true && ops && (
        <TimelineExtensionOverlayHost
          contentPortalRoot={contentOverlayRoot}
          rulerPortalRoot={rulerOverlayRoot}
          rulerStripRoot={rulerOverlayStrip}
          scrollContainer={overlayScrollContainer}
          geometry={overlayGeometry}
          stores={overlayStores}
          selection={overlaySelection}
          fps={overlayFps}
          gestureOwner={gestureOwner}
          setGestureOwner={setGestureOwner}
          setContextTarget={ops.setContextTarget}
          setInspectorTarget={ops.setInspectorTarget}
        />
      )}
    </div>
  );
});

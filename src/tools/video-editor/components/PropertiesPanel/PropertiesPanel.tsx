import { getEffectiveClipVolume } from '@/tools/video-editor/lib/clip-volume.ts';
import { TimelineItemSelectionSummary } from './TimelineItemSelectionSummary.tsx';
import { EMPTY_TIMELINE_DATA_ITEMS } from '@/shared/state/selectionStore.ts';
import { useOptionalAgentChatBridge } from '@/shared/contexts/AgentChatContext.tsx';
import { memo, useEffect, useMemo, useRef, type ComponentType, type ReactNode } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import { BulkClipPanel } from '@/tools/video-editor/components/PropertiesPanel/BulkClipPanel.tsx';
import { TrackInspector } from './TrackInspector.tsx';
import { ClipPanel, getVisibleClipTabs, NO_EFFECT } from '@/tools/video-editor/components/PropertiesPanel/ClipPanel.tsx';
import { OpaqueDataItemInspector } from '@/tools/video-editor/components/PropertiesPanel/OpaqueDataItemInspector';
import type { DataItemInspectorProps } from '@/sdk/video/families/dataKind';
import type { DataLaneItemView, DataLaneView } from '@/tools/video-editor/data/typed/envelope';
import { useDataLanes } from '@/tools/video-editor/data-kinds/useDataLanes';
import { ShaderInspector } from '@/tools/video-editor/components/ShaderInspector/ShaderInspector.tsx';
import {
  useTimelineEditorData,
  useTimelineEditorOps,
  useTimelineChromeContext,
  useTimelinePlaybackContext,
} from '@/tools/video-editor/hooks/timelineStore.ts';
import { useShaderEffectRegistrySnapshot } from '@/tools/video-editor/shaders/registry/ShaderEffectRegistryContext.tsx';
import { useStaleVariants } from '@/tools/video-editor/hooks/useStaleVariants.ts';
import { useAddVariantAsGeneration } from '@/tools/video-editor/hooks/useAddVariantAsGeneration.ts';
import { useRenderDiagnostic } from '@/tools/video-editor/hooks/usePerfDiagnostics.ts';
import { getFallbackClipTab, getSelectionDefaultClipTab, getTrackMoveTargets } from '@/tools/video-editor/lib/clip-inspector.ts';
import { getBulkVisibleTabs, getSharedNestedValue, getSharedValue } from '@/tools/video-editor/lib/bulk-utils.ts';
import { getTimelinePostprocessShader } from '@/tools/video-editor/lib/timeline-domain.ts';
import { VIDEO_EDITOR_THEME_VARS } from '@/tools/video-editor/lib/themeTokens.ts';
import {
  useVideoEditorPanelRegistry,
  useVideoEditorRenderContext,
} from '@/tools/video-editor/runtime/useVideoEditorRenderContext.ts';
import { useOptionalVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import {
  getInspectorContributions,
  findContributionOwnerId,
  type InspectorSelectionSnapshot,
} from '@/tools/video-editor/runtime/extensionSurface.ts';
import {
  HostContributionErrorBoundary,
  type ContributionErrorInfo,
} from '@/tools/video-editor/runtime/ContributionErrorBoundary.tsx';
import type { TimelineInspectorTarget } from '@/tools/video-editor/lib/mobile-interaction-model.ts';

export function InspectorRegistrySections({
  placement,
  selection,
}: {
  placement: 'before-default' | 'after-default';
  selection: InspectorSelectionSnapshot | null;
}) {
  const renderContext = useVideoEditorRenderContext();
  const registry = useVideoEditorPanelRegistry();
  const runtime = useOptionalVideoEditorRuntime();
  const contributionIndex = runtime?.extensionRuntime?.contributionIndex;
  const contributions = useMemo(
    () => getInspectorContributions(registry, renderContext, selection),
    [registry, renderContext, selection],
  );

  const sections =
    placement === 'before-default'
      ? contributions.beforeDefault
      : contributions.afterDefault;

  if (sections.length === 0) {
    return null;
  }

  const handleContributionError = (info: ContributionErrorInfo) => {
    if (typeof console !== 'undefined') {
      console.warn(
        '[PropertiesPanel] Inspector section error captured by boundary:',
        info,
      );
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {sections.map((section) => (
        <HostContributionErrorBoundary
          key={section.id}
          contributionId={section.id}
          extensionId={findContributionOwnerId(contributionIndex, 'inspectorSection', section.id)}
          kind="inspectorSection"
          onError={handleContributionError}
        >
          <div data-video-editor-inspector-section-id={section.id}>
            {section.render(renderContext, selection)}
          </div>
        </HostContributionErrorBoundary>
      ))}
    </div>
  );
}

type DataKindInspectorComponent = ComponentType<DataItemInspectorProps>;

/**
 * Inspector body for a selected lane item: the kind's bound inspector when
 * one is registered (contained by the host boundary), otherwise the opaque
 * fallback that renders only frozen envelope facts.
 */
export function DataItemInspectorSection({ lane, view }: { lane: DataLaneView; view: DataLaneItemView }) {
  const { item } = view;

  if (!lane.inspector) {
    return <OpaqueDataItemInspector item={item} />;
  }

  const KindInspector = lane.inspector as unknown as DataKindInspectorComponent;

  return (
    <HostContributionErrorBoundary
      contributionId={`dataItem:${item.id}`}
      kind="inspectorSection"
      label={`Data item (${lane.kindId}): ${item.id}`}
    >
      <KindInspector
        kindId={lane.kindId}
        schemaRef={item.schemaRef}
        shape={item.shape}
        domain={item.domain}
        item={{
          id: item.id,
          ...(item.sourceItemId ? { sourceItemId: item.sourceItemId } : {}),
          timelineStart: view.timelineStart,
          timelineEnd: view.timelineEnd,
          clipId: view.clipId,
          ...(item.sourceArtifactRef ? { sourceArtifactRef: item.sourceArtifactRef } : {}),
          provenance: item.provenance,
          payload: item.payload,
        }}
      />
    </HostContributionErrorBoundary>
  );
}

/**
 * Host summary for a selected lane (dataKind V1 rework R3d): the frozen
 * envelope facts the host owns — label, schemaRef, shape, item count.
 * Styling mirrors OpaqueDataItemInspector; payloads are never interpreted.
 */
export function DataLaneSummarySection({ lane }: { lane: DataLaneView }) {
  return (
    <div
      data-testid="data-lane-summary"
      className="rounded-xl border bg-card/80 p-3 text-xs"
    >
      <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        Data lane
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">label</dt>
        <dd data-testid="data-lane-summary-label">{lane.label}</dd>
        <dt className="text-muted-foreground">schemaRef</dt>
        <dd className="break-all font-mono" data-testid="data-lane-summary-schema-ref">{lane.schemaRef}</dd>
        <dt className="text-muted-foreground">shape</dt>
        <dd data-testid="data-lane-summary-shape">{lane.shape}</dd>
        <dt className="text-muted-foreground">items</dt>
        <dd className="font-mono" data-testid="data-lane-summary-item-count">{lane.items.length}</dd>
      </dl>
    </div>
  );
}

function ShotOccurrenceInspectorSection({ target }: { target: NonNullable<TimelineInspectorTarget> }) {
  return (
    <div data-testid="shot-occurrence-inspector" className="rounded-xl border bg-card/80 p-3 text-xs">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        Canonical shot occurrence
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {target.shotName && <><dt className="text-muted-foreground">shot</dt><dd>{target.shotName}</dd></>}
        <dt className="text-muted-foreground">occurrence</dt>
        <dd data-testid="shot-occurrence-inspector-id" className="break-all font-mono">{target.occurrenceId}</dd>
        {target.revisionId && <><dt className="text-muted-foreground">revision</dt><dd className="break-all font-mono">{target.revisionId}</dd></>}
        {target.trackId && <><dt className="text-muted-foreground">track</dt><dd>{target.trackId}</dd></>}
        {typeof target.start === 'number' && typeof target.end === 'number' && (
          <><dt className="text-muted-foreground">interval</dt><dd>{target.start.toFixed(3)}–{target.end.toFixed(3)}s</dd></>
        )}
      </dl>
    </div>
  );
}

export interface PropertiesPanelProps {
  /** Retained panels can reopen without changing the selected clip. */
  visible?: boolean;
  /** @deprecated Kept for host compatibility; the editor no longer renders an Assets panel. */
  assetPanel?: ReactNode;
}

function PropertiesPanelComponent({ visible = true }: PropertiesPanelProps) {
  useRenderDiagnostic('PropertiesPanel');
  const elementOwner = useOptionalAgentChatBridge()?.editorContext;
  const {
    data,
    resolvedConfig,
    selectedClip,
    selectedClipIds,
    selectedDataItems: selectedDataItemsSnapshot,
    deviceClass,
    selectedTrack,
    selectedTrackId,
    selectedClipHasPredecessor,
    compositionSize,
    preferences,
    inspectorTarget,
  } = useTimelineEditorData();
  const { currentTime } = useTimelinePlaybackContext();
  const { handleAddTrack } = useTimelineChromeContext();
  const trackReadOnly = useOptionalVideoEditorRuntime()?.timelineEditability?.checkTimeline?.().allowed === false;
  const {
    clearSelection,
    handleUpdateClips,
    handleUpdateClipsDeep,
    handleDeleteClip,
    handleDeleteClips,
    handleTrackPopoverChange,
    handleRemoveTrack,
    handleSelectedClipChange,
    handleResetClipPosition,
    handleResetClipsPosition,
    handleSplitClipsAtPlayhead,
    handleSplitSelectedClip,
    handleToggleMuteClips,
    handleToggleMute,
    handleDetachAudioClip,
    moveSelectedClipsToTrack,
    setContextTarget,
    setActiveClipTab,
    setInspectorTarget,
    setInteractionMode,
    patchRegistry,
    setSelectedTrackId,
    applyEdit,
  } = useTimelineEditorOps();
  const shaderSnapshot = useShaderEffectRegistrySnapshot();
  const { staleAssetKeys, dismissedAssetKeys, dismissAsset, updateAssetToCurrentVariant, applyVariantToAsset } = useStaleVariants({
    registry: resolvedConfig?.registry,
    patchRegistry,
  });
  const { addVariantAsGenerationAfterClip, isPending: isAddingVariantAsGenerationPending } = useAddVariantAsGeneration();
  // Touch starts on the clip's own tab, including an initial selection in the retained panel.
  const prevClipIdRef = useRef(deviceClass === 'desktop' ? selectedClip?.id : undefined);
  const wasVisibleRef = useRef(false);
  const selectedDataItems = selectedDataItemsSnapshot ?? EMPTY_TIMELINE_DATA_ITEMS;
  const selectedClipIdsList = useMemo(() => [...selectedClipIds], [selectedClipIds]);
  // dataKind V2: resolve lane items from the SAME patched lane plane the
  // canvas renders — the render-side `useDataLanes` merge — never the
  // store's frozen-empty `dataLanes` default. Fetching goes through the
  // single assembly authority shared with TimelineCanvas (no second cache);
  // no store writes here, so duration/rows/export neutrality is untouched.
  const lanePlane = useDataLanes({ base: data });
  const inspectorSelectionTarget = useMemo(() => {
    if (selectedDataItems.length) {
      if (selectedDataItems.length + selectedClipIdsList.length > 1) return { kind: 'selection' as const, clipIds: selectedClipIdsList, dataItems: selectedDataItems };
      return { kind: 'dataItem' as const, ...selectedDataItems[0] };
    }
    if (inspectorTarget?.kind === 'shotOccurrence' && selectedClipIdsList.length === 0) {
      return {
        kind: 'shotOccurrence' as const,
        occurrenceId: inspectorTarget.occurrenceId ?? undefined,
        shotId: inspectorTarget.shotId ?? undefined,
        revisionId: inspectorTarget.revisionId ?? undefined,
        parentDocumentId: inspectorTarget.parentDocumentId ?? undefined,
        shotName: inspectorTarget.shotName ?? undefined,
        trackId: inspectorTarget.trackId ?? undefined,
        start: inspectorTarget.start,
        end: inspectorTarget.end,
      };
    }
    if (
      inspectorTarget?.kind === 'shader'
      && inspectorTarget.shaderScope === 'postprocess'
      && selectedClipIdsList.length === 0
      && !selectedTrackId
    ) {
      return {
        kind: 'shader' as const,
        shaderScope: 'postprocess' as const,
        shaderId: inspectorTarget.shaderId ?? undefined,
        extensionId: inspectorTarget.extensionId ?? undefined,
        contributionId: inspectorTarget.contributionId ?? undefined,
      };
    }

    // Rework round-2 F4: an explicit dataItem/dataLane target wins over a
    // bulk clip selection — data inspection must not be masked by whatever
    // clips happen to be multi-selected when the lane is pressed.
    if (selectedDataItemsSnapshot === undefined && inspectorTarget?.kind === 'dataItem') {
      return {
        kind: 'dataItem' as const,
        laneId: inspectorTarget.laneId ?? undefined,
        itemId: inspectorTarget.itemId ?? undefined,
      };
    }

    if (inspectorTarget?.kind === 'dataLane') {
      return {
        kind: 'dataLane' as const,
        laneId: inspectorTarget.laneId ?? undefined,
      };
    }

    if (selectedClipIdsList.length > 1) {
      return { kind: 'selection' as const, clipIds: selectedClipIdsList };
    }

    if (selectedClip) {
      return { kind: 'clip' as const, clipId: selectedClip.id };
    }

    if (selectedTrackId) {
      return { kind: 'track' as const, trackId: selectedTrackId };
    }

    return { kind: 'timeline' as const };
  }, [inspectorTarget, selectedClip, selectedClipIdsList, selectedTrackId, selectedDataItems, selectedDataItemsSnapshot]);
  const dataInspectorTargetKind = inspectorTarget?.kind;
  useEffect(() => {
    if (selectedDataItemsSnapshot !== undefined) return;
    if (dataInspectorTargetKind !== 'dataItem' && dataInspectorTargetKind !== 'dataLane') {
      return;
    }

    // Lane dispatch has already cleared media selection. Do not clear its
    // newly published target again when this retained inspector mounts/renders.
    if (selectedClipIds.size === 0 && !selectedTrackId) return;
    // Overlay/legacy dispatch may still leave a media selection behind. Clear
    // that stale selection while preserving the data target that owns this body.
    clearSelection();
    setSelectedTrackId(null);
    setContextTarget(inspectorTarget);
    setInspectorTarget(inspectorTarget);
  }, [selectedDataItemsSnapshot, dataInspectorTargetKind, clearSelection, inspectorTarget, selectedClipIds.size, selectedTrackId, setContextTarget, setInspectorTarget, setSelectedTrackId]);
  const selectedPostprocessShader = useMemo(() => {
    if (inspectorSelectionTarget.kind !== 'shader' || inspectorSelectionTarget.shaderScope !== 'postprocess') {
      return undefined;
    }

    return resolvedConfig ? getTimelinePostprocessShader(resolvedConfig) : undefined;
  }, [inspectorSelectionTarget, resolvedConfig]);
  const selectedDataItemView = useMemo(() => {
    const target = inspectorSelectionTarget;
    if (target.kind !== 'dataItem' || !target.laneId || !target.itemId) {
      return undefined;
    }

    const { laneId, itemId } = target;
    // Read from the patched lane plane (see `lanePlane` above), not the
    // store's TimelineData: the store never carries assembled lanes.
    const lane = (lanePlane?.dataLanes ?? []).find((candidate) => candidate.laneId === laneId);
    if (!lane) {
      return undefined;
    }

    const view = lane.items.find((candidate) => candidate.item.id === itemId);
    return view ? { lane, view } : undefined;
  }, [inspectorSelectionTarget, lanePlane]);
  const selectedDataLaneView = useMemo(() => {
    const target = inspectorSelectionTarget;
    if (target.kind !== 'dataLane' || !target.laneId) {
      return undefined;
    }

    // Same patched lane plane as the dataItem path (see `lanePlane` above).
    const lane = (lanePlane?.dataLanes ?? []).find((candidate) => candidate.laneId === target.laneId);
    return lane ?? undefined;
  }, [inspectorSelectionTarget, lanePlane]);
  const bulkSelectedClips = resolvedConfig?.clips.filter((clip) => selectedClipIds.has(clip.id)) ?? [];
  const bulkVisibleTabs = getBulkVisibleTabs(bulkSelectedClips, data?.resolvedConfig?.tracks ?? []);
  const bulkEntrance = getSharedNestedValue(bulkSelectedClips, (clip) => clip.entrance);
  const bulkExit = getSharedNestedValue(bulkSelectedClips, (clip) => clip.exit);
  const bulkContinuous = getSharedNestedValue(bulkSelectedClips, (clip) => clip.continuous);
  const bulkText = getSharedNestedValue(bulkSelectedClips, (clip) => clip.text);
  const bulkEntranceType = getSharedValue(bulkSelectedClips.map((clip) => clip.entrance?.type ?? NO_EFFECT));
  const bulkExitType = getSharedValue(bulkSelectedClips.map((clip) => clip.exit?.type ?? NO_EFFECT));
  const bulkContinuousType = getSharedValue(bulkSelectedClips.map((clip) => clip.continuous?.type ?? NO_EFFECT));
  const bulkSpeed = getSharedValue(bulkSelectedClips.map((clip) => clip.speed ?? 1));
  const bulkFrom = getSharedValue(bulkSelectedClips.map((clip) => clip.from ?? 0));
  const bulkTo = getSharedValue(bulkSelectedClips.map((clip) => clip.to ?? clip.assetEntry?.duration ?? 5));
  const bulkX = getSharedValue(bulkSelectedClips.map((clip) => clip.x ?? 0));
  const bulkY = getSharedValue(bulkSelectedClips.map((clip) => clip.y ?? 0));
  const bulkWidth = getSharedValue(bulkSelectedClips.map((clip) => clip.width ?? compositionSize.width));
  const bulkHeight = getSharedValue(bulkSelectedClips.map((clip) => clip.height ?? compositionSize.height));
  const bulkOpacity = getSharedValue(bulkSelectedClips.map((clip) => clip.opacity ?? 1));
  const bulkVolume = getSharedValue(bulkSelectedClips.map((clip) => getEffectiveClipVolume(clip)));
  const bulkFontSize = getSharedValue(bulkSelectedClips.map((clip) => clip.text?.fontSize ?? 64));
  const bulkTextColor = getSharedValue(bulkSelectedClips.map((clip) => clip.text?.color ?? '#ffffff'));
  const bulkTransition = getSharedNestedValue(bulkSelectedClips, (clip) => clip.transition);
  const bulkTransitionType = getSharedValue(bulkSelectedClips.map((clip) => clip.transition?.type ?? NO_EFFECT));
  const bulkTransitionDuration = getSharedValue(bulkSelectedClips.map((clip) => clip.transition?.duration ?? 0.5));

  useEffect(() => {
    const reopenedOnTouch = deviceClass !== 'desktop' && visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (selectedClipIds.size > 1) {
      if (!bulkVisibleTabs.includes(preferences.activeClipTab)) {
        setActiveClipTab('effects');
      }
      return;
    }

    const nextVisibleTabs = getVisibleClipTabs(selectedClip, selectedTrack);
    const isClipChange = selectedClip?.id !== prevClipIdRef.current;

    if ((isClipChange || reopenedOnTouch) && selectedClip) {
      setActiveClipTab(getSelectionDefaultClipTab(selectedClip, selectedTrack, deviceClass !== 'desktop'));
    } else if (!nextVisibleTabs.includes(preferences.activeClipTab)) {
      setActiveClipTab(getFallbackClipTab(preferences.activeClipTab, nextVisibleTabs));
    }

    prevClipIdRef.current = selectedClip?.id;
  }, [
    bulkVisibleTabs,
    deviceClass,
    preferences.activeClipTab,
    selectedClip,
    selectedClipIds.size,
    selectedTrack,
    setActiveClipTab,
    visible,
  ]);

  // Touch: a new pick starts at its top (header and actions), not where the last one was scrolled.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pickKey = `${inspectorSelectionTarget.kind}:${selectedClip?.id ?? ('trackId' in inspectorSelectionTarget ? inspectorSelectionTarget.trackId : '')}`;
  useEffect(() => {
    if (deviceClass !== 'desktop' && scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [deviceClass, pickKey]);

  if (!data) {
    return null;
  }
  const trackMoves = getTrackMoveTargets(resolvedConfig?.tracks ?? [], selectedClip?.track);
  const inspectedTrack = deviceClass !== 'desktop' && inspectorSelectionTarget.kind === 'track'
    ? resolvedConfig?.tracks.find((track) => track.id === inspectorSelectionTarget.trackId)
    : undefined;

  const hasSelection = selectedClipIds.size + selectedDataItems.length > 0;
  const readOnlyItemSelection = selectedDataItems.length > 0 && selectedDataItems.length + selectedClipIds.size > 1;
  const showInspectorActions = !selectedDataItems.length && deviceClass !== 'desktop' && selectedClipIds.size > 1;

  const focusInspectorMode = (mode: 'move' | 'trim', tab: 'timing' | 'position' = 'timing') => {
    setInteractionMode(mode);
    setInspectorTarget(inspectorSelectionTarget);
    setContextTarget(inspectorSelectionTarget);
    setActiveClipTab(tab);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" style={VIDEO_EDITOR_THEME_VARS}>
          {showInspectorActions && (
        <div className="rounded-xl border border-[color:var(--video-editor-accent-border)] bg-[var(--video-editor-accent-bg)] p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-foreground">Selection actions</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Use explicit inspector controls for touch editing instead of relying on timeline gestures.
              </div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button type="button" variant="secondary" size="sm" className="justify-start" onClick={() => focusInspectorMode('trim')}>
              Trim in inspector
            </Button>
            <Button type="button" variant="secondary" size="sm" className="justify-start" onClick={() => focusInspectorMode('move')}>
              Move in inspector
            </Button>
            <Button type="button" variant="outline" size="sm" className="justify-start" onClick={() => moveSelectedClipsToTrack('up', selectedClipIds)}>
              Track up
            </Button>
            <Button type="button" variant="outline" size="sm" className="justify-start" onClick={() => moveSelectedClipsToTrack('down', selectedClipIds)}>
              Track down
            </Button>
            <Button type="button" variant="outline" size="sm" className="justify-start" onClick={() => handleSplitClipsAtPlayhead(selectedClipIdsList)}>
              Split at playhead
            </Button>
            <Button type="button" variant="outline" size="sm" className="justify-start" onClick={() => handleToggleMuteClips(selectedClipIdsList)}>
              Mute or unmute
            </Button>
            <Button type="button" variant="destructive" size="sm" className="justify-start" onClick={() => handleDeleteClips(selectedClipIdsList)}>
              Delete selection
            </Button>
          </div>
        </div>
      )}
      {!readOnlyItemSelection && <InspectorRegistrySections placement="before-default" selection={inspectorSelectionTarget} />}
      {/* Touch uses the shared panel frame without a second card inside it, and scrolls up
          to the tab row's edge (the frame pads only the sides). */}
      <div ref={scrollRef} className={deviceClass !== 'desktop'
        ? 'min-h-0 flex-1 overflow-auto py-3'
        : `min-h-0 flex-1 overflow-auto rounded-xl border bg-card/80 p-3 transition-colors ${hasSelection ? 'border-[color:var(--video-editor-accent-border)] ring-1 ring-[var(--video-editor-accent-ring)]' : 'border-border'}`}>
        {/* dataKind V1 rework R3c: a data target owns the body — the data
            inspector / lane summary renders INSTEAD of the clip panels. The
            multi-select check deliberately comes after this branch. */}
        {readOnlyItemSelection ? (
          <TimelineItemSelectionSummary clipCount={selectedClipIds.size} dataItems={selectedDataItems} lanes={lanePlane?.dataLanes ?? []} />
        ) : inspectorSelectionTarget.kind === 'shotOccurrence' ? (
          <ShotOccurrenceInspectorSection target={inspectorSelectionTarget} />
        ) : selectedDataItemView ? (
          <DataItemInspectorSection
            lane={selectedDataItemView.lane}
            view={selectedDataItemView.view}
          />
        ) : selectedDataLaneView ? (
          <DataLaneSummarySection lane={selectedDataLaneView} />
        ) : inspectedTrack ? (
          <TrackInspector
            key={inspectedTrack.id}
            track={inspectedTrack}
            hasClips={resolvedConfig?.clips.some((clip) => clip.track === inspectedTrack.id) ?? false}
            readOnly={trackReadOnly}
            onChange={handleTrackPopoverChange}
            onAddTrack={handleAddTrack}
            onRemove={handleRemoveTrack}
          />
        ) : selectedClipIds.size > 1 ? (
          <BulkClipPanel
            clips={bulkSelectedClips}
            visibleTabs={bulkVisibleTabs}
            compositionWidth={compositionSize.width}
            compositionHeight={compositionSize.height}
            sharedEntrance={bulkEntrance}
            sharedExit={bulkExit}
            sharedContinuous={bulkContinuous}
            sharedText={bulkText}
            sharedEntranceType={bulkEntranceType}
            sharedExitType={bulkExitType}
            sharedContinuousType={bulkContinuousType}
            sharedSpeed={bulkSpeed}
            sharedFrom={bulkFrom}
            sharedTo={bulkTo}
            sharedX={bulkX}
            sharedY={bulkY}
            sharedWidth={bulkWidth}
            sharedHeight={bulkHeight}
            sharedOpacity={bulkOpacity}
            sharedVolume={bulkVolume}
            sharedFontSize={bulkFontSize}
            sharedTextColor={bulkTextColor}
            sharedTransition={bulkTransition}
            sharedTransitionType={bulkTransitionType}
            sharedTransitionDuration={bulkTransitionDuration}
            onChange={(patch) => handleUpdateClips(selectedClipIdsList, patch)}
            onChangeDeep={(patchFn) => handleUpdateClipsDeep(selectedClipIdsList, patchFn)}
            onResetPosition={() => handleResetClipsPosition(selectedClipIdsList)}
            onToggleMute={() => handleToggleMuteClips(selectedClipIdsList)}
            onClose={clearSelection}
            activeTab={preferences.activeClipTab}
            setActiveTab={setActiveClipTab}
          />
        ) : (
          <ClipPanel
            clip={selectedClip}
            track={selectedTrack}
            deviceClass={deviceClass}
            hasPredecessor={selectedClipHasPredecessor}
            onChange={patch => handleSelectedClipChange(patch, elementOwner)}
            onResetPosition={handleResetClipPosition}
            onClose={clearSelection}
            onDelete={selectedClip ? () => {
              handleDeleteClip(selectedClip.id);
              // Touch: a deleted clip is done with, like a closed one; its track stays unpicked.
              if (deviceClass !== 'desktop') clearSelection();
            } : undefined}
            onToggleMute={handleToggleMute}
            onDetachAudio={selectedClip ? () => handleDetachAudioClip(selectedClip.id) : undefined}
            onSplitAtPlayhead={() => {
              setInspectorTarget(inspectorSelectionTarget);
              setContextTarget(inspectorSelectionTarget);
              handleSplitSelectedClip();
            }}
            onMoveTrackUp={trackMoves.up ? () => moveSelectedClipsToTrack('up', selectedClipIds) : undefined}
            onMoveTrackDown={trackMoves.down ? () => moveSelectedClipsToTrack('down', selectedClipIds) : undefined}
            onSetInteractionMode={(mode) => {
              setInspectorTarget(inspectorSelectionTarget);
              setContextTarget(inspectorSelectionTarget);
              setInteractionMode(mode);
            }}
            compositionWidth={compositionSize.width}
            compositionHeight={compositionSize.height}
            registry={resolvedConfig?.registry ?? {}}
            elementRegistry={resolvedConfig?.app}
            activeTab={preferences.activeClipTab}
            setActiveTab={setActiveClipTab}
            isVariantStale={selectedClip?.asset ? staleAssetKeys.has(selectedClip.asset) && !dismissedAssetKeys.has(selectedClip.asset) : false}
            onUpdateVariant={selectedClip?.asset ? () => void updateAssetToCurrentVariant(selectedClip.asset!) : undefined}
            onDismissStale={selectedClip?.asset && staleAssetKeys.has(selectedClip.asset) ? () => dismissAsset(selectedClip.asset!) : undefined}
            onApplyVariant={selectedClip?.asset ? (variant) => applyVariantToAsset(selectedClip.asset!, variant) : undefined}
            onAddVariantAsGeneration={selectedClip ? (variant) => addVariantAsGenerationAfterClip(selectedClip.id, variant) : undefined}
            isAddingVariantAsGeneration={selectedClip ? (variantId) => isAddingVariantAsGenerationPending(selectedClip.id, variantId) : undefined}
            timelineFps={resolvedConfig?.output.fps}
            currentTime={currentTime}
          />
        )}
      </div>
      {!selectedDataItems.length && selectedClipIds.size === 1 && (
        <ShaderInspector
          clip={selectedClip}
          resolvedConfig={resolvedConfig}
          shaderSnapshot={shaderSnapshot}
          applyEdit={applyEdit}
        />
      )}
      {selectedPostprocessShader && (
        <ShaderInspector
          clip={null}
          postprocessShader={selectedPostprocessShader}
          resolvedConfig={resolvedConfig}
          shaderSnapshot={shaderSnapshot}
          applyEdit={applyEdit}
        />
      )}
      {!readOnlyItemSelection && <InspectorRegistrySections placement="after-default" selection={inspectorSelectionTarget} />}

    </div>
  );
}

export const PropertiesPanel = memo(PropertiesPanelComponent);

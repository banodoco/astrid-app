import { getEffectiveClipVolume } from '@/tools/video-editor/lib/clip-volume.ts';
import { TimelineItemSelectionSummary } from './TimelineItemSelectionSummary.tsx';
import { EMPTY_TIMELINE_DATA_ITEMS } from '@/shared/state/selectionStore.ts';
import { memo, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import { BulkClipPanelBody, type BulkClipPanelProps } from '@/tools/video-editor/components/PropertiesPanel/BulkClipPanelBody.tsx';
import { ClipPanelBody, type ClipPanelBodyProps } from '@/tools/video-editor/components/PropertiesPanel/ClipPanelBody.tsx';
import { getVisibleClipTabs } from '@/tools/video-editor/lib/clip-inspector.ts';
import { NO_EFFECT } from '@/tools/video-editor/components/PropertiesPanel/clip-panel-primitives.tsx';
import { useDataLanes } from '@/tools/video-editor/data-kinds/useDataLanes';
import { ShaderInspector } from '@/tools/video-editor/components/ShaderInspector/ShaderInspector.tsx';
import {
  useTimelineEditorData,
  useTimelineEditorOps,
  useTimelinePlaybackContext,
} from '@/tools/video-editor/hooks/timelineStore.ts';
import { useShaderEffectRegistrySnapshot } from '@/tools/video-editor/shaders/registry/ShaderEffectRegistryContext.tsx';
import type { EditorVariantPicker, VariantObservations } from '@/tools/video-editor/runtime/editorHostObservations.ts';
import type { VideoEditorEffectCatalog } from '@/tools/video-editor/lib/effect-catalog.ts';
import type { EffectCreatorPanelProps } from '@/tools/video-editor/components/EffectCreatorPanel.tsx';
import { useRenderDiagnostic } from '@/tools/video-editor/hooks/usePerfDiagnostics.ts';
import { getFallbackClipTab, getSelectionDefaultClipTab, getTrackMoveTargets } from '@/tools/video-editor/lib/clip-inspector.ts';
import { getBulkVisibleTabs, getSharedNestedValue, getSharedValue } from '@/tools/video-editor/lib/bulk-utils.ts';
import { getTimelinePostprocessShader } from '@/tools/video-editor/lib/timeline-domain.ts';
import { VIDEO_EDITOR_THEME_VARS } from '@/tools/video-editor/lib/themeTokens.ts';
import { useOptionalVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs.tsx';
import {
  DataItemInspectorSection,
  DataLaneSummarySection,
  InspectorRegistrySections,
} from './PropertiesPanel.tsx';

export interface PropertiesPanelProps {
  /** Timeline-scoped assets live behind this tab so they do not hide the editor tabs. */
  assetPanel?: ReactNode;
}

export interface PropertiesPanelBodyProps extends PropertiesPanelProps {
  hostObservations: VariantObservations;
  effectResources: VideoEditorEffectCatalog;
  VariantPicker?: EditorVariantPicker;
  EffectCreator?: ComponentType<EffectCreatorPanelProps>;
  extensionManager?: ReactNode;
  processDashboard?: ReactNode;
  ClipInspector?: ComponentType<ClipPanelBodyProps>;
  BulkInspector?: ComponentType<BulkClipPanelProps & {effectResources: VideoEditorEffectCatalog}>;
}

function PropertiesPanelComponent({
  hostObservations,
  effectResources,
  VariantPicker,
  EffectCreator,
  extensionManager,
  ClipInspector = ClipPanelBody,
  BulkInspector = BulkClipPanelBody,
}: PropertiesPanelBodyProps) {
  useRenderDiagnostic('PropertiesPanel');
  const readOnly = useOptionalVideoEditorRuntime()?.timelineEditability?.checkTimeline?.().allowed === false;
  const [activePanelTab, setActivePanelTab] = useState<'inspector' | 'extensions'>('inspector');

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
  const {
    clearSelection,
    handleUpdateClips,
    handleUpdateClipsDeep,
    handleDeleteClip,
    handleDeleteClips,
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
    setSelectedTrackId,
    applyEdit,
  } = useTimelineEditorOps();
  const shaderSnapshot = useShaderEffectRegistrySnapshot();
  const {
    staleAssetKeys,
    dismissedAssetKeys,
    dismissAsset,
    updateAssetToCurrentVariant,
    applyVariantToAsset,
    addVariantAsGenerationAfterClip,
    isAddingVariantAsGenerationPending,
  } = hostObservations;
  // At a desk the panel stays mounted and a new clip is a change it sees. On touch the clip sheet
  // mounts the panel for the clip just tapped, so that clip counts as new and opens on its own tab.
  const prevClipIdRef = useRef(deviceClass === 'desktop' ? selectedClip?.id : undefined);
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
    if (selectedClipIds.size > 1) {
      if (!bulkVisibleTabs.includes(preferences.activeClipTab)) {
        setActiveClipTab('effects');
      }
      return;
    }

    const nextVisibleTabs = getVisibleClipTabs(selectedClip, selectedTrack);
    const isClipChange = selectedClip?.id !== prevClipIdRef.current;

    if (isClipChange && selectedClip) {
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
  ]);

  if (!data) {
    return null;
  }
  const trackMoves = getTrackMoveTargets(resolvedConfig?.tracks ?? [], selectedClip?.track);

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
      <Tabs
        value={activePanelTab}
        onValueChange={(value) => setActivePanelTab(value as 'inspector' | 'extensions')}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className={`grid w-full bg-muted/60 ${readOnly || !extensionManager ? 'grid-cols-1' : 'grid-cols-2'}`}>
          <TabsTrigger value="inspector">Inspector</TabsTrigger>
          {!readOnly && extensionManager && <TabsTrigger value="extensions">Extensions</TabsTrigger>}
        </TabsList>
        <TabsContent value="inspector" className="mt-3 flex min-h-0 flex-1 flex-col gap-3">
          {!readOnly && showInspectorActions && (
        <div
          className="rounded-xl border border-[color:var(--video-editor-accent-border)] bg-[var(--video-editor-accent-bg)] p-3"
          data-astrid-inspector-actions="selection"
        >
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
      <div className={`min-h-0 flex-1 overflow-auto rounded-xl border bg-card/80 p-3 transition-colors ${hasSelection ? 'border-[color:var(--video-editor-accent-border)] ring-1 ring-[var(--video-editor-accent-ring)]' : 'border-border'}`}>
        {/* dataKind V1 rework R3c: a data target owns the body — the data
            inspector / lane summary renders INSTEAD of the clip panels. The
            multi-select check deliberately comes after this branch. */}
        {readOnlyItemSelection ? (
          <TimelineItemSelectionSummary clipCount={selectedClipIds.size} dataItems={selectedDataItems} lanes={lanePlane?.dataLanes ?? []} />
        ) : selectedDataItemView ? (
          <DataItemInspectorSection
            lane={selectedDataItemView.lane}
            view={selectedDataItemView.view}
          />
        ) : selectedDataLaneView ? (
          <DataLaneSummarySection lane={selectedDataLaneView} />
        ) : selectedClipIds.size > 1 ? (
          <BulkInspector
            effectResources={effectResources}
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
            onChange={(patch) => { if (!readOnly) handleUpdateClips(selectedClipIdsList, patch); }}
            onChangeDeep={(patchFn) => { if (!readOnly) handleUpdateClipsDeep(selectedClipIdsList, patchFn); }}
            onResetPosition={() => { if (!readOnly) handleResetClipsPosition(selectedClipIdsList); }}
            onToggleMute={() => { if (!readOnly) handleToggleMuteClips(selectedClipIdsList); }}
            onClose={clearSelection}
            activeTab={preferences.activeClipTab}
            setActiveTab={setActiveClipTab}
          />
        ) : (
          <ClipInspector
            readOnly={readOnly}
            effectResources={effectResources}
            VariantPicker={VariantPicker}
            EffectCreator={EffectCreator}
            clip={selectedClip}
            track={selectedTrack}
            deviceClass={deviceClass}
            hasPredecessor={selectedClipHasPredecessor}
            onChange={readOnly ? () => {} : handleSelectedClipChange}
            onResetPosition={readOnly ? () => {} : handleResetClipPosition}
            onClose={clearSelection}
            onDelete={!readOnly && selectedClip ? () => handleDeleteClip(selectedClip.id) : undefined}
            onToggleMute={readOnly ? () => {} : handleToggleMute}
            onDetachAudio={!readOnly && selectedClip ? () => handleDetachAudioClip(selectedClip.id) : undefined}
            onSplitAtPlayhead={() => {
              setInspectorTarget(inspectorSelectionTarget);
              setContextTarget(inspectorSelectionTarget);
              if (!readOnly) handleSplitSelectedClip();
            }}
            onMoveTrackUp={trackMoves.up ? () => { if (!readOnly) moveSelectedClipsToTrack('up', selectedClipIds); } : undefined}
            onMoveTrackDown={trackMoves.down ? () => { if (!readOnly) moveSelectedClipsToTrack('down', selectedClipIds); } : undefined}
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
            onUpdateVariant={!readOnly && selectedClip?.asset ? () => void updateAssetToCurrentVariant(selectedClip.asset!) : undefined}
            onDismissStale={!readOnly && selectedClip?.asset && staleAssetKeys.has(selectedClip.asset) ? () => dismissAsset(selectedClip.asset!) : undefined}
            onApplyVariant={!readOnly && selectedClip?.asset ? (variant) => applyVariantToAsset(selectedClip.asset!, variant) : undefined}
            onAddVariantAsGeneration={!readOnly && selectedClip ? (variant) => addVariantAsGenerationAfterClip(selectedClip.id, variant) : undefined}
            isAddingVariantAsGeneration={selectedClip ? (variantId) => isAddingVariantAsGenerationPending(selectedClip.id, variantId) : undefined}
            timelineFps={resolvedConfig?.output.fps}
            currentTime={currentTime}
          />
        )}
      </div>
      {!readOnly && !selectedDataItems.length && selectedClipIds.size === 1 && (
        <ShaderInspector
          clip={selectedClip}
          resolvedConfig={resolvedConfig}
          shaderSnapshot={shaderSnapshot}
          applyEdit={applyEdit}
        />
      )}
      {!readOnly && selectedPostprocessShader && (
        <ShaderInspector
          clip={null}
          postprocessShader={selectedPostprocessShader}
          resolvedConfig={resolvedConfig}
          shaderSnapshot={shaderSnapshot}
          applyEdit={applyEdit}
        />
      )}
      {!readOnlyItemSelection && <InspectorRegistrySections placement="after-default" selection={inspectorSelectionTarget} />}
        </TabsContent>
        {!readOnly && extensionManager && <TabsContent value="extensions" className="mt-3 min-h-0 flex-1 overflow-auto">
          {extensionManager}
        </TabsContent>}
      </Tabs>
    </div>
  );
}

export const PropertiesPanelBody = memo(PropertiesPanelComponent);

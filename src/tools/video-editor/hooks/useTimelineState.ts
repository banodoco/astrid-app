import { areShotsSettling } from '@/tools/video-editor/lib/shots-settling.ts';
import { useProjectTranscriptHost } from './useProjectTranscriptHost.ts';
import { createDataKindItemsHost } from '@/tools/video-editor/data-kinds/dataKindItems.ts';
import { createPendingWorkRegistry } from '@/tools/video-editor/runtime/pendingWorkRegistry.ts';
import { transcriptRepositoryFromDocuments } from '@/tools/video-editor/data/typed/projectTranscript.ts';
import { isDataProviderPersistenceEnabled } from '@/tools/video-editor/data/DataProvider.ts';
import { createEditorAssetSurface, loadEditorAssetProfile } from '@/tools/video-editor/runtime/editorAssetSurface.ts';
import { playedAssetRegistry, playedShotComposition } from '@/tools/video-editor/lib/timeline-shot-summaries.ts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { isTabletHardware, useIsMobile, useIsTablet, useViewportWidth } from '@/shared/hooks/mobile/index.ts';
import {
  editorClearTimelineSelection,
  systemResetTimelineSelection,
  useTimelineMultiSelect,
  getSelectedTimelineDataItems,
  userSelectTimelineClip,
  userSelectTimelineClips,
  type SelectClipOptions,
} from '@/shared/state/selectionStore.ts';
import { createInteractionState, type InteractionStateRef } from '@/tools/video-editor/lib/interaction-state.ts';
import { useVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import { ROW_HEIGHT, getTimelineLabelWidth } from '@/tools/video-editor/lib/coordinate-utils.ts';
import type { UseAssetManagementResult } from '@/tools/video-editor/hooks/useAssetManagement.ts';
import { useAssetOperations } from '@/tools/video-editor/hooks/useAssetOperations.ts';
import { useClipEditing } from '@/tools/video-editor/hooks/useClipEditing.ts';
import { useClipResize } from '@/tools/video-editor/hooks/useClipResize.ts';
import { useDerivedTimeline } from '@/tools/video-editor/hooks/useDerivedTimeline.ts';
import { useDragCoordinator } from '@/tools/video-editor/hooks/useDragCoordinator.ts';
import { useEditorPreferences } from '@/tools/video-editor/hooks/useEditorPreferences.ts';
import { useExternalDrop } from '@/tools/video-editor/hooks/useExternalDrop.ts';
import { useTimelinePlayback } from '@/tools/video-editor/hooks/useTimelinePlayback.ts';
import { useRenderState } from '@/tools/video-editor/hooks/useRenderState.ts';
import { useTimelineHistory } from '@/tools/video-editor/hooks/useTimelineHistory.ts';
import { useTimelineQueries } from '@/tools/video-editor/hooks/useTimelineQueries.ts';
import { useTimelineSave } from '@/tools/video-editor/hooks/useTimelineSave.ts';
import { useTimelineSelection } from '@/tools/video-editor/hooks/useTimelineSelection.ts';
import {
  createTimelineStore,
  seedTimelineStoreBeforeRender,
} from '@/tools/video-editor/hooks/timelineStore.ts';
import {
  provisionRegisteredTimelineMedia,
} from '@/tools/video-editor/commands/index.ts';
import type {
  TimelineChromeContextValue,
  TimelineEditorContextValue,
  TimelineEditorCommands,
  TimelinePlaybackContextValue,
  UseTimelineStateResult,
} from '@/tools/video-editor/hooks/useTimelineState.types.ts';
import type {
  TimelineQueuedRender,
  TimelineRenderRequest,
} from '@/tools/video-editor/hooks/timeline-state-types.ts';
import {
  createMobileInteractionPolicy,
  getDefaultInteractionMode,
  resolveInputModalityFromPointerType,
  resolveTimelineDeviceClass,
} from '@/tools/video-editor/lib/mobile-interaction-model.ts';
import { buildTimelineData, type TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import type { ResolvedTimelineConfig } from '@/tools/video-editor/types/index.ts';
import { useTimelineTrackManagement } from '@/tools/video-editor/hooks/useTimelineTrackManagement.ts';
import { useTimelineOps } from '@/tools/video-editor/hooks/useTimelineOps';
import type { TimelineHostServiceHooks } from '@/tools/video-editor/runtime/timelineHostServiceHooks.ts';

export type { EditorPreferences } from '@/tools/video-editor/hooks/useEditorPreferences.ts';
export type { RenderStatus } from '@/tools/video-editor/hooks/useRenderState.ts';
export type { SaveStatus } from '@/tools/video-editor/hooks/useTimelineSave.ts';

type SelectionHook = ReturnType<typeof useTimelineSelection>;
type MultiSelectHook = ReturnType<typeof useTimelineMultiSelect>;
type DragCoordinatorHook = ReturnType<typeof useDragCoordinator>;
type TimelinePlaybackHook = ReturnType<typeof useTimelinePlayback>;
type TimelineTrackManagementHook = ReturnType<typeof useTimelineTrackManagement>;
type AssetManagementHook = UseAssetManagementResult;
type ClipResizeHook = ReturnType<typeof useClipResize>;
type ClipEditingHook = ReturnType<typeof useClipEditing>;
type ExternalDropHook = ReturnType<typeof useExternalDrop>;
type TimelineHistoryHook = ReturnType<typeof useTimelineHistory>;
type RenderStateHook = ReturnType<typeof useRenderState>;

export function useTimelineRenderRequest(
  timelineId: string,
  assetRegistry: TimelineRenderRequest['assetRegistry'],
  resolvedConfig: TimelineRenderRequest['resolvedConfig'],
  renderMetadata: TimelineRenderRequest['renderMetadata'],
  projectId: string,
): TimelineRenderRequest {
  return useMemo(() => ({
    timelineId,
    assetRegistry,
    resolvedConfig,
    renderMetadata,
    renderRuntime: { projectId },
  }), [assetRegistry, projectId, renderMetadata, resolvedConfig, timelineId]);
}

function useTimelineEditorContextValue({
  data,
  interactionPolicy,
  selection,
  multiSelect,
  selectionOwner,
  selectedTrackId,
  compositionSize,
  trackScaleMap,
  scale,
  scaleWidth,
  isLoading,
  dataRef,
  pendingOpsRef,
  interactionStateRef,
  editorPreferences,
  setSelectedTrackId,
  setActiveClipTab,
  setAssetPanelState,
  setSelectedRightPanelId,
  setRightPanelLayoutSlot,
  setShowDataLanes,
  setShowTranscriptLane,
  dragCoordinator,
  playback,
  assetManagement,
  clipResize,
  clipEditing,
  externalDrop,
  trackManagement,
  uploadFiles,
  applyEdit,
  commands,
  patchRegistry,
  unpatchRegistry,
  registerAsset,
  setInputModality,
  setInputModalityFromPointerType,
  setInteractionMode,
  setGestureOwner,
  setContextTarget,
  setInspectorTarget,
}: {
  data: TimelineData | null;
  interactionPolicy: ReturnType<typeof createMobileInteractionPolicy>;
  selection: SelectionHook;
  multiSelect: MultiSelectHook;
  selectionOwner?: symbol;
  selectedTrackId: string | null;
  compositionSize: { width: number; height: number };
  trackScaleMap: Record<string, number>;
  scale: number;
  scaleWidth: number;
  isLoading: boolean;
  dataRef: ReturnType<typeof useTimelineSave>['dataRef'];
  pendingOpsRef: ReturnType<typeof useTimelineSave>['pendingOpsRef'];
  interactionStateRef: InteractionStateRef;
  editorPreferences: ReturnType<typeof useEditorPreferences>['preferences'];
  setSelectedTrackId: ReturnType<typeof useTimelineSave>['setSelectedTrackId'];
  setActiveClipTab: ReturnType<typeof useEditorPreferences>['setActiveClipTab'];
  setAssetPanelState: ReturnType<typeof useEditorPreferences>['setAssetPanelState'];
  setSelectedRightPanelId: ReturnType<typeof useEditorPreferences>['setSelectedRightPanelId'];
  setRightPanelLayoutSlot: ReturnType<typeof useEditorPreferences>['setRightPanelLayoutSlot'];
  setShowDataLanes: ReturnType<typeof useEditorPreferences>['setShowDataLanes'];
  setShowTranscriptLane: ReturnType<typeof useEditorPreferences>['setShowTranscriptLane'];
  dragCoordinator: DragCoordinatorHook;
  playback: TimelinePlaybackHook;
  assetManagement: AssetManagementHook;
  clipResize: ClipResizeHook;
  clipEditing: ClipEditingHook;
  externalDrop: ExternalDropHook;
  trackManagement: TimelineTrackManagementHook;
  uploadFiles: ReturnType<typeof useAssetOperations>['uploadFiles'];
  applyEdit: ReturnType<typeof useTimelineSave>['applyEdit'];
  commands: TimelineEditorCommands;
  patchRegistry: ReturnType<typeof useTimelineSave>['patchRegistry'];
  unpatchRegistry: ReturnType<typeof useTimelineSave>['unpatchRegistry'];
  registerAsset: ReturnType<typeof useAssetOperations>['registerAsset'];
  setInputModality: Dispatch<SetStateAction<ReturnType<typeof createMobileInteractionPolicy>['inputModality']>>;
  setInputModalityFromPointerType: (pointerType: string | null | undefined) => ReturnType<typeof createMobileInteractionPolicy>['inputModality'];
  setInteractionMode: Dispatch<SetStateAction<ReturnType<typeof createMobileInteractionPolicy>['interactionMode']>>;
  setGestureOwner: Dispatch<SetStateAction<ReturnType<typeof createMobileInteractionPolicy>['gestureOwner']>>;
  setContextTarget: Dispatch<SetStateAction<ReturnType<typeof createMobileInteractionPolicy>['contextTarget']>>;
  setInspectorTarget: Dispatch<SetStateAction<ReturnType<typeof createMobileInteractionPolicy>['inspectorTarget']>>;
}): TimelineEditorContextValue {
  const onActionResizeStart = clipResize.onActionResizeStart;
  const onClipEdgeResizeEnd = clipResize.onClipEdgeResizeEnd;

  const handleSelectedClipChange = clipEditing.handleSelectedClipChange;
  const handleResetClipPosition = clipEditing.handleResetClipPosition;
  const handleSplitSelectedClip = clipEditing.handleSplitSelectedClip;
  const handleToggleMute = clipEditing.handleToggleMute;
  const moveSelectedClipToTrack = trackManagement.moveSelectedClipToTrack;
  const moveSelectedClipsToTrack = trackManagement.moveSelectedClipsToTrack;

  return useMemo<TimelineEditorContextValue>(() => ({
    data,
    resolvedConfig: selection.resolvedConfig,
    deviceClass: interactionPolicy.deviceClass,
    inputModality: interactionPolicy.inputModality,
    interactionMode: interactionPolicy.interactionMode,
    gestureOwner: interactionPolicy.gestureOwner,
    contextTarget: interactionPolicy.contextTarget,
    inspectorTarget: interactionPolicy.inspectorTarget,
    interactionPolicy,
    selectedClipId: selection.primaryClipId,
    selectedDataItems: selection.selectedDataItems,
    selectedClipIds: selection.selectedClipIds,
    selectedClipIdsRef: selection.selectedClipIdsRef,
    additiveSelectionRef: selection.additiveSelectionRef,
    selectedTrackId,
    primaryClipId: selection.primaryClipId,
    selectedClip: selection.selectedClip,
    selectedTrack: selection.selectedTrack,
    selectedClipHasPredecessor: selection.selectedClipHasPredecessor,
    compositionSize,
    trackScaleMap,
    scale,
    scaleWidth,
    isLoading,
    dataRef,
    pendingOpsRef,
    interactionStateRef,
    coordinator: dragCoordinator.coordinator,
    indicatorRef: dragCoordinator.indicatorRef,
    editAreaRef: dragCoordinator.editAreaRef,
    preferences: editorPreferences,
    timelineRef: playback.timelineRef,
    timelineWrapperRef: playback.timelineWrapperRef,
    setInputModality,
    setInputModalityFromPointerType,
    setInteractionMode,
    setGestureOwner,
    setContextTarget,
    setInspectorTarget,
    isClipSelected: multiSelect.isClipSelected,
    selectClip: (clipId, opts) => userSelectTimelineClip(clipId, {
      additive: Boolean(opts?.toggle),
      preserveIfSelected: opts?.preserveSelection,
    }, selectionOwner),
    selectClips: (clipIds) => userSelectTimelineClips(clipIds, { additive: false }, selectionOwner),
    addToSelection: (clipIds) => userSelectTimelineClips(clipIds, { additive: true }, selectionOwner),
    clearSelection: () => {
      editorClearTimelineSelection(selectionOwner);
      setSelectedTrackId(null);
      setContextTarget(null);
      setInspectorTarget(null);
    },
    setSelectedTrackId,
    setActiveClipTab,
    setAssetPanelState,
    setSelectedRightPanelId,
    setRightPanelLayoutSlot,
    setShowDataLanes,
    setShowTranscriptLane,
    prepareGenerationAsset: assetManagement.prepareGenerationAsset,
    registerGenerationAsset: assetManagement.registerGenerationAsset,
    onCursorDrag: playback.onCursorDrag,
    onClickTimeArea: playback.onClickTimeArea,
    onActionResizeStart,
    onClipEdgeResizeEnd,
    onOverlayChange: clipEditing.onOverlayChange,
    onTimelineDragOver: externalDrop.onTimelineDragOver,
    onTimelineDragLeave: externalDrop.onTimelineDragLeave,
    onTimelineDrop: externalDrop.onTimelineDrop,
    addMediaFiles: externalDrop.addMediaFiles,
    handleAssetDrop: assetManagement.handleAssetDrop,
    handleUpdateClips: clipEditing.handleUpdateClips,
    handleUpdateClipsDeep: clipEditing.handleUpdateClipsDeep,
    handleDeleteClips: clipEditing.handleDeleteClips,
    handleDeleteClip: clipEditing.handleDeleteClip,
    handleSelectedClipChange: (...args) => { if (!getSelectedTimelineDataItems(selectionOwner).length) return handleSelectedClipChange(...args); },
    handleResetClipPosition: (...args) => { if (!getSelectedTimelineDataItems(selectionOwner).length) return handleResetClipPosition(...args); },
    handleResetClipsPosition: clipEditing.handleResetClipsPosition,
    handleSplitSelectedClip: (...args) => { if (!getSelectedTimelineDataItems(selectionOwner).length) return handleSplitSelectedClip(...args); },
    handleSplitClipAtTime: clipEditing.handleSplitClipAtTime,
    handleSplitClipsAtPlayhead: clipEditing.handleSplitClipsAtPlayhead,
    handleToggleMuteClips: clipEditing.handleToggleMuteClips,
    handleToggleMute: (...args) => { if (!getSelectedTimelineDataItems(selectionOwner).length) return handleToggleMute(...args); },
    handleDetachAudioClip: clipEditing.handleDetachAudioClip,
    handleTrackPopoverChange: trackManagement.handleTrackPopoverChange,
    handleMoveTrack: trackManagement.handleMoveTrack,
    handleRemoveTrack: trackManagement.handleRemoveTrack,
    moveSelectedClipToTrack: (...args) => { if (!getSelectedTimelineDataItems(selectionOwner).length) return moveSelectedClipToTrack(...args); },
    moveSelectedClipsToTrack: (...args) => { if (!getSelectedTimelineDataItems(selectionOwner).length) return moveSelectedClipsToTrack(...args); },
    moveClipToRow: trackManagement.moveClipToRow,
    applyResolvedClipMove: trackManagement.applyResolvedClipMove,
    createTrackAndMoveClip: trackManagement.createTrackAndMoveClip,
    uploadFiles,
    applyEdit,
    commands,
    patchRegistry,
    unpatchRegistry,
    registerAsset,
  }), [
    applyEdit,
    commands,
    assetManagement.handleAssetDrop,
    assetManagement.registerGenerationAsset,
    assetManagement.prepareGenerationAsset,
    clipEditing.handleDeleteClip,
    clipEditing.handleDeleteClips,
    clipEditing.handleDetachAudioClip,
    handleResetClipPosition,
    clipEditing.handleResetClipsPosition,
    handleSelectedClipChange,
    clipEditing.handleSplitClipAtTime,
    clipEditing.handleSplitClipsAtPlayhead,
    handleSplitSelectedClip,
    handleToggleMute,
    clipEditing.handleToggleMuteClips,
    clipEditing.handleUpdateClips,
    clipEditing.handleUpdateClipsDeep,
    clipEditing.onOverlayChange,
    compositionSize,
    data,
    dataRef,
    dragCoordinator.coordinator,
    dragCoordinator.editAreaRef,
    dragCoordinator.indicatorRef,
    editorPreferences,
    externalDrop.onTimelineDragLeave,
    externalDrop.onTimelineDragOver,
    externalDrop.onTimelineDrop,
    externalDrop.addMediaFiles,
    interactionPolicy,
    interactionStateRef,
    isLoading,
    selectionOwner,
    multiSelect.isClipSelected,
    onActionResizeStart,
    onClipEdgeResizeEnd,
    patchRegistry,
    pendingOpsRef,
    playback.onClickTimeArea,
    playback.onCursorDrag,
    playback.timelineRef,
    playback.timelineWrapperRef,
    registerAsset,
    scale,
    scaleWidth,
    selectedTrackId,
    selection.additiveSelectionRef,
    selection.primaryClipId,
    selection.resolvedConfig,
    selection.selectedClip,
    selection.selectedClipHasPredecessor,
    selection.selectedDataItems,
    selection.selectedClipIds,
    selection.selectedClipIdsRef,
    selection.selectedTrack,
    setActiveClipTab,
    setAssetPanelState,
    setSelectedRightPanelId,
    setRightPanelLayoutSlot,
    setShowDataLanes,
    setShowTranscriptLane,
    setContextTarget,
    setGestureOwner,
    setInputModality,
    setInputModalityFromPointerType,
    setInspectorTarget,
    setInteractionMode,
    setSelectedTrackId,
    trackManagement.createTrackAndMoveClip,
    trackManagement.handleMoveTrack,
    trackManagement.handleRemoveTrack,
    trackManagement.handleTrackPopoverChange,
    trackManagement.moveClipToRow,
    trackManagement.applyResolvedClipMove,
    moveSelectedClipToTrack,
    moveSelectedClipsToTrack,
    trackScaleMap,
    unpatchRegistry,
    uploadFiles,
  ]);
}

function useTimelineChromeContextValue({
  timelineName,
  saveStatus,
  isConflictExhausted,
  schemaIncompatible,
  render,
  queuedRender,
  renderRequest,
  history,
  setScaleWidth,
  trackManagement,
  clipEditing,
  reloadFromServer,
  retrySaveAfterConflict,
  startRender,
  loadError,
  retryLoad,
  watchdogTripped,
  watchdogReason,
  retryWatchdog,
  retryPendingSave,
  flushPendingSave,
  recoveryDraft,
  retryRecoveredDraft,
  discardRecoveredDraft,
}: {
  timelineName: string | null;
  saveStatus: ReturnType<typeof useTimelineSave>['saveStatus'];
  isConflictExhausted: boolean;
  schemaIncompatible: ReturnType<typeof useTimelineSave>['schemaIncompatible'];
  loadError: Error | null;
  retryLoad: () => void;
  render: Pick<RenderStateHook, 'renderStatus' | 'renderLog' | 'renderDirty' | 'renderProgress' | 'renderResultUrl' | 'renderResultFilename' | 'renderResultInfo' | 'activeRenderTaskId' | 'renderDestination' | 'setRenderDestination' | 'cancelRender' | 'visualSeamReport' | 'canDeclareSeamsAsHardCuts' | 'declareSeamsAsHardCuts' | 'canAcknowledgeVisualCues' | 'acknowledgeVisualCuesAsSynchronized'>;
  queuedRender: TimelineQueuedRender;
  renderRequest: TimelineRenderRequest;
  history: Pick<TimelineHistoryHook, 'undo' | 'redo' | 'canUndo' | 'canRedo' | 'historyPausedForUploads' | 'checkpoints' | 'jumpToCheckpoint' | 'createManualCheckpoint' | 'canonicalHistory' | 'canonicalHistorySupported' | 'canonicalHistoryError' | 'refreshCanonicalHistory' | 'restoringCanonicalRevisionId' | 'restoreCanonicalRevision'>;
  setScaleWidth: ReturnType<typeof useEditorPreferences>['setScaleWidth'];
  trackManagement: Pick<TimelineTrackManagementHook, 'handleAddTrack' | 'handleClearUnusedTracks' | 'unusedTrackCount'>;
  clipEditing: Pick<ClipEditingHook, 'handleAddText' | 'handleAddTextAt'>;
  reloadFromServer: ReturnType<typeof useTimelineSave>['reloadFromServer'];
  retrySaveAfterConflict: ReturnType<typeof useTimelineSave>['retrySaveAfterConflict'];
  startRender: ReturnType<typeof useRenderState>['startRender'];
  watchdogTripped: boolean;
  watchdogReason: 'timeout' | 'lost-edit' | null;
  retryWatchdog: () => void;
  retryPendingSave: () => void;
  flushPendingSave: () => Promise<number>;
  recoveryDraft: ReturnType<typeof useTimelineSave>['recoveryDraft'];
  retryRecoveredDraft: ReturnType<typeof useTimelineSave>['retryRecoveredDraft'];
  discardRecoveredDraft: ReturnType<typeof useTimelineSave>['discardRecoveredDraft'];
}): TimelineChromeContextValue {
  return useMemo<TimelineChromeContextValue>(() => ({
    timelineName,
    saveStatus,
    isConflictExhausted,
    schemaIncompatible,
    renderStatus: render.renderStatus,
    renderLog: render.renderLog,
    visualSeamReport: render.visualSeamReport,
    canDeclareSeamsAsHardCuts: render.canDeclareSeamsAsHardCuts,
    declareSeamsAsHardCuts: render.declareSeamsAsHardCuts,
    canAcknowledgeVisualCues: render.canAcknowledgeVisualCues,
    acknowledgeVisualCuesAsSynchronized: render.acknowledgeVisualCuesAsSynchronized,
    renderDirty: render.renderDirty,
    renderProgress: render.renderProgress,
    queuedRender,
    renderResultUrl: render.renderResultUrl,
    renderResultFilename: render.renderResultFilename,
    renderResultInfo: render.renderResultInfo,
    activeRenderTaskId: render.activeRenderTaskId,
    renderDestination: render.renderDestination,
    setRenderDestination: render.setRenderDestination,
    cancelRender: render.cancelRender,
    renderRequest,
    undo: history.undo,
    redo: history.redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    historyPausedForUploads: history.historyPausedForUploads,
    checkpoints: history.checkpoints,
    jumpToCheckpoint: history.jumpToCheckpoint,
    createManualCheckpoint: history.createManualCheckpoint,
    canonicalHistory: history.canonicalHistory,
    canonicalHistorySupported: history.canonicalHistorySupported,
    canonicalHistoryError: history.canonicalHistoryError,
    refreshCanonicalHistory: history.refreshCanonicalHistory,
    restoringCanonicalRevisionId: history.restoringCanonicalRevisionId,
    restoreCanonicalRevision: history.restoreCanonicalRevision,
    setScaleWidth,
    handleAddTrack: trackManagement.handleAddTrack,
    handleClearUnusedTracks: trackManagement.handleClearUnusedTracks,
    unusedTrackCount: trackManagement.unusedTrackCount,
    handleAddText: clipEditing.handleAddText,
    handleAddTextAt: clipEditing.handleAddTextAt,
    reloadFromServer,
    retrySaveAfterConflict,
    watchdogTripped,
    watchdogReason,
    retryWatchdog,
    retryPendingSave,
    flushPendingSave,
    recoveryDraft,
    retryRecoveredDraft,
    discardRecoveredDraft,
    startRender,
    loadError,
    retryLoad,
  }), [
    clipEditing.handleAddText,
    loadError,
    retryLoad,
    clipEditing.handleAddTextAt,
    history.canRedo,
    history.canUndo,
    history.historyPausedForUploads,
    history.checkpoints,
    history.createManualCheckpoint,
    history.jumpToCheckpoint,
    history.canonicalHistory,
    history.canonicalHistorySupported,
    history.canonicalHistoryError,
    history.refreshCanonicalHistory,
    history.restoringCanonicalRevisionId,
    history.restoreCanonicalRevision,
    history.redo,
    history.undo,
    isConflictExhausted,
    schemaIncompatible,
    reloadFromServer,
    render.renderDirty,
    render.renderLog,
    render.renderProgress,
    render.renderResultFilename,
    render.renderResultInfo,
    render.renderResultUrl,
    render.renderStatus,
    render.visualSeamReport,
    render.canDeclareSeamsAsHardCuts,
    render.declareSeamsAsHardCuts,
    render.canAcknowledgeVisualCues,
    render.acknowledgeVisualCuesAsSynchronized,
    queuedRender,
    renderRequest,
    render.activeRenderTaskId,
    render.renderDestination,
    render.setRenderDestination,
    render.cancelRender,
    retrySaveAfterConflict,
    retryWatchdog,
    retryPendingSave,
    flushPendingSave,
    saveStatus,
    setScaleWidth,
    startRender,
    timelineName,
    trackManagement.handleAddTrack,
    trackManagement.handleClearUnusedTracks,
    trackManagement.unusedTrackCount,
    watchdogReason,
    watchdogTripped,
    recoveryDraft,
    retryRecoveredDraft,
    discardRecoveredDraft,
  ]);
}

function useTimelinePlaybackContextValue({
  playback,
}: {
  playback: Pick<TimelinePlaybackHook, 'currentTime' | 'previewRef' | 'playerContainerRef' | 'onPreviewTimeUpdate' | 'formatTime'>;
}): TimelinePlaybackContextValue {
  return useMemo<TimelinePlaybackContextValue>(() => ({
    currentTime: playback.currentTime,
    previewRef: playback.previewRef,
    playerContainerRef: playback.playerContainerRef,
    onPreviewTimeUpdate: playback.onPreviewTimeUpdate,
    formatTime: playback.formatTime,
  }), [
    playback.currentTime,
    playback.formatTime,
    playback.onPreviewTimeUpdate,
    playback.playerContainerRef,
    playback.previewRef,
  ]);
}

export function useTimelineState(services: TimelineHostServiceHooks, initialTimelineData?: TimelineData): UseTimelineStateResult {
  const runtime = useVideoEditorRuntime();
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const finalVideoMap = services.useFinalVideoMap();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  const viewportWidth = useViewportWidth();
  // Shared gate observed by drag/resize writers and read by save/persistence/poll.
  const interactionStateRef = useRef(createInteractionState());
  const storeRef = useRef<ReturnType<typeof createTimelineStore> | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createTimelineStore();
  }
  // Non-null alias: closures below (effects, memo bodies) lose the narrowing
  // that the lazy-init guard above establishes on `storeRef.current`.
  const store = storeRef.current;
  const playback = useTimelinePlayback();
  const preferences = useEditorPreferences(runtime.timelineId, viewportWidth, { persist: isDataProviderPersistenceEnabled(runtime.provider) });
  const resolveAssetUrl = useCallback(async (file: string) => {
    if (runtime.assetResolver) {
      return await runtime.assetResolver.resolveAssetUrl(file);
    }

    return await runtime.provider.resolveAssetUrl(file);
  }, [runtime.assetResolver, runtime.provider]);
  // Pass the resolver object through the initial-load path so head-aware
  // providers can assemble against the immutable registry snapshot returned
  // with the timeline, rather than their mutable active registry.
  const queries = useTimelineQueries(runtime.provider, runtime.timelineId, runtime.assetResolver, initialTimelineData);
  // A rejected load query is otherwise consumed by nobody: `isLoading` goes
  // false, no render throws, and the shell mounts an empty editor. Surfaced on
  // the chrome slice so the shell can put an error card where the timeline goes.
  const timelineLoadError = queries.timelineQuery.error ?? null;
  const refetchTimeline = queries.timelineQuery.refetch;
  const retryLoad = useCallback(() => {
    void refetchTimeline();
  }, [refetchTimeline]);
  const deviceClass = useMemo(
    // `isTabletHardware` reads UA/platform, which never changes for the life of
    // the document — the reactive inputs are the two signals and the width.
    () => resolveTimelineDeviceClass({
      isMobile,
      isTablet,
      viewportWidth,
      isTabletHardware: isTabletHardware(),
    }),
    [isMobile, isTablet, viewportWidth],
  );
  const defaultInteractionMode = getDefaultInteractionMode(deviceClass);
  const initialInteractionPolicyRef = useRef(createMobileInteractionPolicy(deviceClass));
  const previousDefaultInteractionModeRef = useRef(defaultInteractionMode);
  const [inputModality, setInputModality] = useState(initialInteractionPolicyRef.current.inputModality);
  const [interactionMode, setInteractionMode] = useState(initialInteractionPolicyRef.current.interactionMode);
  const [gestureOwner, setGestureOwner] = useState(initialInteractionPolicyRef.current.gestureOwner);
  const [contextTarget, setContextTarget] = useState(initialInteractionPolicyRef.current.contextTarget);
  const [inspectorTarget, setInspectorTarget] = useState(initialInteractionPolicyRef.current.inspectorTarget);
  const save = useTimelineSave(queries, runtime.provider, interactionStateRef, store, initialTimelineData);
  const pendingWorkRegistry = useMemo(createPendingWorkRegistry, []);
  if (store.getState().pendingWorkRegistry !== pendingWorkRegistry) {
    store.setState({ pendingWorkRegistry });
  }
  const itemCommitRef = useRef(save.commitData);
  itemCommitRef.current = save.commitData;
  const dataKindItemsHost = useMemo(() => createDataKindItemsHost({
    dataRef: save.dataRef,
    commitData: (next, options) => itemCommitRef.current(next, options),
  }), [save.dataRef]);
  if (store.getState().dataKindItemsHost !== dataKindItemsHost) {
    store.setState({ dataKindItemsHost });
  }
  const history = useTimelineHistory({
    dataRef: save.dataRef,
    commitData: save.commitData,
    interactionStateRef,
    pendingOpsRef: save.pendingOpsRef,
    editability: runtime.timelineEditability,
    remoteHistory: save.localDocumentSave,
  });
  const derived = useDerivedTimeline(save.data, save.selectedClipId, save.selectedTrackId);
  const timelineDataRef = save.dataRef;
  const commitTimelineData = save.commitData;
  const flushTimelineSave = save.flushPendingSave;
  const canPersistVisualSeamConfig = runtime.timelineEditability?.checkTimeline?.().allowed ?? true;
  const persistVisualSeamConfig = useCallback(async (acknowledgedConfig: ResolvedTimelineConfig) => {
    const current = timelineDataRef.current;
    if (!current) throw new Error('Timeline data is no longer available.');
    const permission = runtime.timelineEditability?.checkTimeline?.();
    if (permission && !permission.allowed) {
      throw new Error(`Timeline edits are temporarily unavailable (${permission.reason ?? 'read-only'}).`);
    }
    const contract = acknowledgedConfig.app?.visualSeamContract;
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
      throw new Error('Visual seam declarations are missing from the acknowledged configuration.');
    }
    const config = {
      ...current.config,
      app: { ...current.config.app, visualSeamContract: contract },
    };
    const nextData = await buildTimelineData(
      config,
      current.registry,
      resolveAssetUrl,
      current.configVersion,
      current.sourceItemsBySchemaRef,
      current.head,
      current.transcriptReferences,
    );
    if (timelineDataRef.current !== current) throw new Error('Timeline changed while saving visual boundary declarations.');
    commitTimelineData(nextData, { save: true, semantic: true });
    await flushTimelineSave();
  }, [commitTimelineData, flushTimelineSave, resolveAssetUrl, runtime.timelineEditability, timelineDataRef]);
  const render = useRenderState(
    derived.resolvedConfig,
    derived.renderMetadata,
    runtime.exporter ?? null,
    runtime.extensionRuntime,
    save.flushPendingSave,
    persistVisualSeamConfig,
    canPersistVisualSeamConfig,
  );
  const assetOperations = useAssetOperations(
    runtime.provider,
    runtime.timelineId,
    runtime.userId,
    queryClient,
    save.pendingOpsRef,
    undefined,
    save.patchRegistry,
    resolveAssetUrl,
    save.registrationOwner,
  );
  const {
    data,
    dataRef,
    eventBus,
    isConflictExhausted,
    selectedTrackId,
    saveStatus,
    setSelectedTrackId,
    applyEdit,
    patchRegistry,
    unpatchRegistry,
    reloadFromServer,
    retrySaveAfterConflict,
    pendingOpsRef,
    isLoading,
  } = save;
  const {
    compositionSize,
    trackScaleMap,
  } = derived;
  const {
    renderStatus,
    renderLog,
    renderDirty,
    renderProgress,
    renderResultUrl,
    renderResultFilename,
    renderResultInfo,
    activeRenderTaskId,
    renderDestination,
    setRenderDestination,
    cancelRender,
    visualSeamReport,
    canDeclareSeamsAsHardCuts,
    declareSeamsAsHardCuts,
    canAcknowledgeVisualCues,
    acknowledgeVisualCuesAsSynchronized,
    setRenderDirty,
    startRender,
  } = render;
  const {
    canUndo,
    canRedo,
    historyPausedForUploads,
    checkpoints,
    undo,
    redo,
    jumpToCheckpoint,
    createManualCheckpoint,
    onBeforeCommit,
    onRemoteData,
  } = history;

  // Wire TimelineOps (atomic mutation adapter) into the host runtime context.
  // The adapter is stable (memoized on its callback deps) and delegates to
  // the existing commitData/history path without replacing the command facade.
  // The canonical version getter reads the store's ack-tracked field (outside
  // the data object) so receipt-only acks invalidate stale patches without
  // committing a new data object.
  const getConfigVersion = useCallback(
    () => store.getState().configVersion,
    [store],
  );
  const timelineOps = useTimelineOps({
    commitData: save.commitData,
    dataRef: save.dataRef,
    getConfigVersion,
    flushPendingSave: save.flushPendingSave,
    createManualCheckpoint,
    jumpToCheckpoint,
    checkpoints,
    editability: runtime.timelineEditability,
  });

  const {
    scale,
    scaleWidth,
    preferences: editorPreferences,
    setScaleWidth,
    setActiveClipTab,
    setAssetPanelState,
    setSelectedRightPanelId,
    setRightPanelLayoutSlot,
    setShowDataLanes,
    setShowTranscriptLane,
  } = preferences;
  const {
    registerAsset,
    prepareAssetUpload,
    uploadFiles,
    invalidateAssetRegistry,
  } = assetOperations;
  const selectedProjectId = runtime.hostContext?.projectId ?? runtime.project.projectId;
  const selection = useTimelineSelection({
    data,
    selectedTrackId,
    owner: runtime.agentSelectionOwner,
  });
  const multiSelect = useTimelineMultiSelect(runtime.agentSelectionOwner);
  // useTimelineMultiSelect exposes selection *state*; the select action lives on
  // the store module. Passing `multiSelect.selectClip` here left every consumer
  // with `undefined` and crashed the add-text flows after insert.
  const selectClip = useCallback((clipId: string, opts?: SelectClipOptions) => {
    userSelectTimelineClip(clipId, {
      additive: Boolean(opts?.toggle),
      preserveIfSelected: opts?.preserveSelection,
    }, runtime.agentSelectionOwner);
  }, [runtime.agentSelectionOwner]);

  useEffect(() => {
    systemResetTimelineSelection(runtime.agentSelectionOwner);
  }, [runtime.timelineId, runtime.agentSelectionOwner]);
  const setInputModalityFromPointerType = useCallback((pointerType: string | null | undefined) => {
    const nextModality = resolveInputModalityFromPointerType(pointerType);
    setInputModality(nextModality);
    return nextModality;
  }, []);

  const interactionPolicy = useMemo(() => ({
    deviceClass,
    inputModality,
    interactionMode,
    gestureOwner,
    contextTarget,
    inspectorTarget,
  }), [
    contextTarget,
    deviceClass,
    gestureOwner,
    inputModality,
    inspectorTarget,
    interactionMode,
  ]);

  useEffect(() => {
    return eventBus.on('beforeCommit', onBeforeCommit);
  }, [eventBus, onBeforeCommit]);

  useEffect(() => {
    return eventBus.on('remoteCommit', onRemoteData);
  }, [eventBus, onRemoteData]);

  useEffect(() => {
    return eventBus.on('pruneSelection', selection.pruneSelection);
  }, [eventBus, selection.pruneSelection]);

  useEffect(() => {
    return eventBus.on('saveSuccess', () => {
      setRenderDirty(true);
    });
  }, [eventBus, setRenderDirty]);

  useEffect(() => {
    setInteractionMode((currentMode) => (
      currentMode === previousDefaultInteractionModeRef.current
        ? defaultInteractionMode
        : currentMode
    ));
    previousDefaultInteractionModeRef.current = defaultInteractionMode;
  }, [defaultInteractionMode]);

  const dragCoordinator = useDragCoordinator({
    dataRef,
    scale,
    scaleWidth,
    startLeft: getTimelineLabelWidth(deviceClass),
    rowHeight: ROW_HEIGHT,
    editability: runtime.timelineEditability,
  });

  const assetManagement = services.useAssetManagement({
    store,
    dataRef,
    selectedTrackId,
    selectedProjectId,
    selectClip,
    setSelectedTrackId,
    applyEdit,
    patchRegistry,
    invalidateAssetRegistry,
    resolveAssetUrl,
  });

  const clipResize = useClipResize({
    dataRef,
    applyEdit,
    editability: runtime.timelineEditability,
  });

  const clipEditing = useClipEditing({
    dataRef,
    resolvedConfig: selection.resolvedConfig,
    selectedClipId: selection.primaryClipId,
    selectedTrack: selection.selectedTrack,
    currentTime: playback.currentTime,
    selectClip,
    setSelectedTrackId,
    applyEdit,
  });

  const externalDrop = useExternalDrop({
    store,
    dataRef,
    pendingOpsRef,
    scale,
    scaleWidth,
    selectedTrackId,
    applyEdit,
    prepareAssetUpload,
    invalidateAssetRegistry,
    resolveAssetUrl,
    coordinator: dragCoordinator.coordinator,
    registerGenerationAsset: assetManagement.registerGenerationAsset,
    prepareGenerationAsset: assetManagement.prepareGenerationAsset,
    uploadImageGeneration: assetManagement.uploadImageGeneration,
    uploadVideoGeneration: assetManagement.uploadVideoGeneration,
    handleAssetDrop: assetManagement.handleAssetDrop,
    handleAssetBatchDrop: assetManagement.handleAssetBatchDrop,
    onSeekToTime: playback.onClickTimeArea,
    finalVideoMap,
  });

  const canonicalShotTrackIds = useMemo(
    () => {
      const ids = new Set<string>();
      for (const occurrence of runtime.shots?.canonicalOccurrences ?? []) {
        if (typeof occurrence.trackId === 'string' && occurrence.trackId.length > 0) ids.add(occurrence.trackId);
        const internal = occurrence.revision.internal_timeline_revision as { timeline?: { clips?: unknown[] } } | undefined;
        for (const raw of internal?.timeline?.clips ?? []) {
          if (raw && typeof raw === 'object' && typeof (raw as { track?: unknown }).track === 'string') {
            ids.add((raw as { track: string }).track);
          }
        }
      }
      return ids;
    },
    [runtime.shots?.canonicalOccurrences],
  );
  // The tracks the clear-unused count protects arrive with the canonical shots. Until
  // they have, the count would offer tracks that are about to hold shots.
  const shotTracksSettling = areShotsSettling(runtime.shots);
  const trackManagement = useTimelineTrackManagement({
    dataRef,
    resolvedConfig: selection.resolvedConfig,
    selectedClipId: selection.primaryClipId,
    setSelectedTrackId,
    applyEdit,
    eventBus: save.eventBus,
    editability: runtime.timelineEditability,
    protectedTrackIds: canonicalShotTrackIds,
  });

  const timelineCommands = useMemo<TimelineEditorCommands>(() => {
    const getCurrentData = () => {
      const current = dataRef.current ?? data;
      if (!current) {
        throw new Error('Timeline data is not ready.');
      }
      return current;
    };

    const buildAddMediaCommand = ({ trackId, at, assetKey }: { trackId: string; at: number; assetKey: string }) => {
      const current = getCurrentData();
      const asset = provisionRegisteredTimelineMedia(assetKey, current.registry.assets[assetKey]);
      if (!asset) {
        return null;
      }

      return {
        type: 'add-media' as const,
        payload: {
          trackId,
          at,
          asset,
        },
      };
    };

    const buildSwapCommand = ({ clipId, assetKey }: { clipId: string; assetKey: string }) => {
      const current = getCurrentData();
      const asset = provisionRegisteredTimelineMedia(assetKey, current.registry.assets[assetKey]);
      if (!asset) {
        return null;
      }

      return {
        type: 'swap' as const,
        payload: {
          clipId,
          asset,
        },
      };
    };

    return {
      buildAddMediaCommand,
      buildSwapCommand,
    };
  }, [data, dataRef]);

  const editor = useTimelineEditorContextValue({
    data,
    interactionPolicy,
    selection,
    multiSelect,
    selectionOwner: runtime.agentSelectionOwner,
    selectedTrackId,
    compositionSize,
    trackScaleMap,
    scale,
    scaleWidth,
    isLoading,
    dataRef,
    pendingOpsRef,
    interactionStateRef,
    editorPreferences,
    setSelectedTrackId,
    setActiveClipTab,
    setAssetPanelState,
    setSelectedRightPanelId,
    setRightPanelLayoutSlot,
    setShowDataLanes,
    setShowTranscriptLane,
    dragCoordinator,
    playback,
    assetManagement,
    clipResize,
    clipEditing,
    externalDrop,
    trackManagement,
    uploadFiles,
    applyEdit,
    commands: timelineCommands,
    patchRegistry,
    unpatchRegistry,
    registerAsset,
    setInputModality,
    setInputModalityFromPointerType,
    setInteractionMode,
    setGestureOwner,
    setContextTarget,
    setInspectorTarget,
  });

  const editorData = useMemo(() => ({
    data: editor.data,
    resolvedConfig: editor.resolvedConfig,
    deviceClass: editor.deviceClass,
    inputModality: editor.inputModality,
    interactionMode: editor.interactionMode,
    gestureOwner: editor.gestureOwner,
    contextTarget: editor.contextTarget,
    inspectorTarget: editor.inspectorTarget,
    interactionPolicy: editor.interactionPolicy,
    selectedClipId: editor.selectedClipId,
    selectedDataItems: editor.selectedDataItems,
    selectedClipIds: editor.selectedClipIds,
    selectedClipIdsRef: editor.selectedClipIdsRef,
    additiveSelectionRef: editor.additiveSelectionRef,
    selectedTrackId: editor.selectedTrackId,
    primaryClipId: editor.primaryClipId,
    selectedClip: editor.selectedClip,
    selectedTrack: editor.selectedTrack,
    selectedClipHasPredecessor: editor.selectedClipHasPredecessor,
    compositionSize: editor.compositionSize,
    trackScaleMap: editor.trackScaleMap,
    scale: editor.scale,
    scaleWidth: editor.scaleWidth,
    isLoading: editor.isLoading,
    dataRef: editor.dataRef,
    pendingOpsRef: editor.pendingOpsRef,
    interactionStateRef: editor.interactionStateRef,
    coordinator: editor.coordinator,
    indicatorRef: editor.indicatorRef,
    editAreaRef: editor.editAreaRef,
    preferences: editor.preferences,
    timelineRef: editor.timelineRef,
    timelineWrapperRef: editor.timelineWrapperRef,
  }), [editor]);

  const onActionResizeStart = editor.onActionResizeStart;
  const onClipEdgeResizeEnd = editor.onClipEdgeResizeEnd;

  const transcriptPreferencesRef = useRef(preferences);
  transcriptPreferencesRef.current = preferences;
  const transcriptDocuments = useMemo(() => runtime.provider.documents && selectedProjectId
    ? transcriptRepositoryFromDocuments(runtime.provider.documents, selectedProjectId)
    : undefined, [runtime.provider.documents, selectedProjectId]);
  const transcriptAssets = useMemo(() => createEditorAssetSurface(
    () => save.dataRef.current,
    (assetId) => loadEditorAssetProfile(runtime.assetResolver, assetId, runtime.timelineId),
    () => playedAssetRegistry(
      playedShotComposition(runtimeRef.current.userId, runtimeRef.current.shots),
      save.dataRef.current?.resolvedConfig,
    ),
  ), [runtime.assetResolver, runtime.timelineId, save.dataRef]);
  const transcriptPendingWork = useMemo(() => ({
    report: (state: import('@/sdk/context.ts').ExtensionPendingWorkState) =>
      pendingWorkRegistry.report('haus.astrid.transcript-lane', state),
  }), [pendingWorkRegistry]);
  const transcriptHost = useProjectTranscriptHost({
    dataRef: save.dataRef,
    commitData: save.commitData,
    editability: runtime.timelineEditability,
    repository: transcriptDocuments,
    assets: transcriptAssets,
    items: dataKindItemsHost,
    pendingWork: transcriptPendingWork,
    getTimelineLaneVisible: () => transcriptPreferencesRef.current.preferences.showDataLanesByKind?.['astrid.transcript'] ?? true,
    setTimelineLaneVisible: (visible) => transcriptPreferencesRef.current.setDataKindLaneVisible('astrid.transcript', visible),
    flushPendingSave: save.flushPendingSave,
  }, runtime.provider, runtime.timelineId);
  useEffect(() => { void transcriptHost.refreshSources(); }, [transcriptHost, save.data?.transcriptReferences]);

  const editorOps = useMemo(() => ({
    transcriptHost,
    setInputModality: editor.setInputModality,
    setInputModalityFromPointerType: editor.setInputModalityFromPointerType,
    setInteractionMode: editor.setInteractionMode,
    setGestureOwner: editor.setGestureOwner,
    setContextTarget: editor.setContextTarget,
    setInspectorTarget: editor.setInspectorTarget,
    isClipSelected: editor.isClipSelected,
    selectClip: editor.selectClip,
    selectClips: editor.selectClips,
    addToSelection: editor.addToSelection,
    clearSelection: editor.clearSelection,
    setSelectedTrackId: editor.setSelectedTrackId,
    setActiveClipTab: editor.setActiveClipTab,
    setAssetPanelState: editor.setAssetPanelState,
    setSelectedRightPanelId: editor.setSelectedRightPanelId,
    setRightPanelLayoutSlot: editor.setRightPanelLayoutSlot,
    setShowDataLanes: editor.setShowDataLanes,
    setShowTranscriptLane: editor.setShowTranscriptLane,
    prepareGenerationAsset: editor.prepareGenerationAsset,
    registerGenerationAsset: editor.registerGenerationAsset,
    onCursorDrag: editor.onCursorDrag,
    onClickTimeArea: editor.onClickTimeArea,
    onActionResizeStart,
    onClipEdgeResizeEnd,
    onOverlayChange: editor.onOverlayChange,
    onTimelineDragOver: editor.onTimelineDragOver,
    onTimelineDragLeave: editor.onTimelineDragLeave,
    onTimelineDrop: editor.onTimelineDrop,
    addMediaFiles: editor.addMediaFiles,
    handleAssetDrop: editor.handleAssetDrop,
    handleUpdateClips: editor.handleUpdateClips,
    handleUpdateClipsDeep: editor.handleUpdateClipsDeep,
    handleDeleteClips: editor.handleDeleteClips,
    handleDeleteClip: editor.handleDeleteClip,
    handleSelectedClipChange: editor.handleSelectedClipChange,
    handleResetClipPosition: editor.handleResetClipPosition,
    handleResetClipsPosition: editor.handleResetClipsPosition,
    handleSplitSelectedClip: editor.handleSplitSelectedClip,
    handleSplitClipAtTime: editor.handleSplitClipAtTime,
    handleSplitClipsAtPlayhead: editor.handleSplitClipsAtPlayhead,
    handleToggleMuteClips: editor.handleToggleMuteClips,
    handleToggleMute: editor.handleToggleMute,
    handleDetachAudioClip: editor.handleDetachAudioClip,
    handleTrackPopoverChange: editor.handleTrackPopoverChange,
    handleMoveTrack: editor.handleMoveTrack,
    handleRemoveTrack: editor.handleRemoveTrack,
    moveSelectedClipToTrack: editor.moveSelectedClipToTrack,
    moveSelectedClipsToTrack: editor.moveSelectedClipsToTrack,
    moveClipToRow: editor.moveClipToRow,
    applyResolvedClipMove: editor.applyResolvedClipMove,
    createTrackAndMoveClip: editor.createTrackAndMoveClip,
    uploadFiles: editor.uploadFiles,
    applyEdit: editor.applyEdit,
    commands: timelineCommands,
    patchRegistry: editor.patchRegistry,
    unpatchRegistry: editor.unpatchRegistry,
    registerAsset: editor.registerAsset,
  }), [editor, onActionResizeStart, onClipEdgeResizeEnd, timelineCommands, transcriptHost]);

  const renderRequest = useTimelineRenderRequest(
    runtime.timelineId,
    data?.registry ?? null,
    selection.resolvedConfig,
    derived.renderMetadata,
    selectedProjectId ?? '',
  );

  const chrome = useTimelineChromeContextValue({
    timelineName: runtime.timelineName ?? null,
    saveStatus,
    isConflictExhausted,
    schemaIncompatible: save.schemaIncompatible,
    render: {
      renderStatus,
      renderLog,
      renderDirty,
      renderProgress,
      renderResultUrl,
      renderResultFilename,
      renderResultInfo,
      activeRenderTaskId,
      renderDestination,
      setRenderDestination,
      cancelRender,
      visualSeamReport,
      canDeclareSeamsAsHardCuts,
      declareSeamsAsHardCuts,
      canAcknowledgeVisualCues,
      acknowledgeVisualCuesAsSynchronized,
    },
    queuedRender: null,
    renderRequest,
    history: {
      undo,
      redo,
      canUndo,
      canRedo,
      historyPausedForUploads,
      checkpoints,
      jumpToCheckpoint,
      createManualCheckpoint,
      canonicalHistory: history.canonicalHistory,
      canonicalHistorySupported: history.canonicalHistorySupported,
      canonicalHistoryError: history.canonicalHistoryError,
      refreshCanonicalHistory: history.refreshCanonicalHistory,
      restoringCanonicalRevisionId: history.restoringCanonicalRevisionId,
      restoreCanonicalRevision: history.restoreCanonicalRevision,
    },
    setScaleWidth,
    trackManagement: {
      handleAddTrack: trackManagement.handleAddTrack,
      handleClearUnusedTracks: trackManagement.handleClearUnusedTracks,
      unusedTrackCount: shotTracksSettling ? 0 : trackManagement.unusedTrackCount,
    },
    clipEditing: {
      handleAddText: clipEditing.handleAddText,
      handleAddTextAt: clipEditing.handleAddTextAt,
    },
    reloadFromServer,
    retrySaveAfterConflict,
    watchdogTripped: save.watchdogTripped,
    watchdogReason: save.watchdogReason,
    retryWatchdog: save.retryWatchdog,
    retryPendingSave: save.retryPendingSave,
    flushPendingSave: save.flushPendingSave,
    recoveryDraft: save.recoveryDraft,
    retryRecoveredDraft: save.retryRecoveredDraft,
    discardRecoveredDraft: save.discardRecoveredDraft,
    startRender,
    loadError: timelineLoadError,
    retryLoad,
  });

  const playbackValue = useTimelinePlaybackContextValue({ playback });

  // Seed the external store before descendants render for the first time so
  // mounted-provider readers such as AgentChat and pending-add helpers do not
  // observe the placeholder slice values from createTimelineStore().
  seedTimelineStoreBeforeRender(store, {
    data: editorData,
    ops: editorOps,
    chrome,
    playback: playbackValue,
    timelineOps,
  });

  useLayoutEffect(() => {
    store.getState().syncSlices({
      data: editorData,
      ops: editorOps,
      chrome,
      playback: playbackValue,
      timelineOps,
    });
  }, [chrome, editorData, editorOps, playbackValue, store, timelineOps]);

  return {
    store,
    editor: { ...editor, elementTimelineRoutes: save.elementTimelineRoutes },
    editorData,
    editorOps,
    chrome,
    playback: playbackValue,
  };
}

import type { TranscriptPanelHost } from '@/tools/video-editor/lib/transcript-panel-host.ts';
import type { useAssetManagement } from '@/tools/video-editor/hooks/useAssetManagement.ts';
import type { useClipEditing } from '@/tools/video-editor/hooks/useClipEditing.ts';
import type { useClipResize } from '@/tools/video-editor/hooks/useClipResize.ts';
import type { useDragCoordinator } from '@/tools/video-editor/hooks/useDragCoordinator.ts';
import type { useExternalDrop } from '@/tools/video-editor/hooks/useExternalDrop.ts';
import type { TimelineStoreApi } from '@/tools/video-editor/hooks/timelineStore.ts';
import type { useTimelinePlayback } from '@/tools/video-editor/hooks/useTimelinePlayback.ts';
import type { useTimelineTrackManagement } from '@/tools/video-editor/hooks/useTimelineTrackManagement.ts';
import type {
  AddMediaCommand,
  SwapMediaCommand,
} from '@/tools/video-editor/commands/index.ts';
import type {
  TimelineApplyEdit,
  TimelineCheckpoints,
  TimelineCanonicalHistory,
  TimelineCreateManualCheckpoint,
  TimelineDataRef,
  TimelineJumpToCheckpoint,
  TimelinePatchRegistry,
  TimelinePendingOpsRef,
  TimelineQueuedRender,
  TimelineRegisterAsset,
  TimelineRenderRequest,
  TimelineReloadFromServer,
  TimelineRenderProgress,
  TimelineRefreshCanonicalHistory,
  TimelineResolvedConfig,
  TimelineRetrySaveAfterConflict,
  TimelineRestoreCanonicalRevision,
  TimelineSelectedClip,
  TimelineSelectedTrack,
  TimelineSetScaleWidth,
  TimelineSetSelectedTrackId,
  TimelineStartRender,
  TimelineUnpatchRegistry,
  TimelineUploadFiles,
} from '@/tools/video-editor/hooks/timeline-state-types.ts';
import type { ClipTab, EditorPreferences, RightPanelLayoutSlot } from '@/tools/video-editor/hooks/useEditorPreferences.ts';
import type { RenderStatus } from '@/tools/video-editor/hooks/useRenderState.ts';
import type { RenderExportDestination } from '@/tools/video-editor/lib/renderRouter.ts';
import type { VisualSeamReport } from '@/tools/video-editor/data/visualSeamContract.ts';
import type { SaveStatus } from '@/tools/video-editor/hooks/useTimelineSave.ts';
import type { TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import type { SelectClipOptions, UseTimelineMultiSelectResult } from '@/shared/state/selectionStore.ts';
import type {
  MobileInteractionPolicy,
  TimelineContextTarget,
  TimelineGestureOwner,
  TimelineInputModality,
  TimelineInspectorTarget,
  TimelineInteractionMode,
} from '@/tools/video-editor/lib/mobile-interaction-model.ts';

type DragCoordinatorHook = ReturnType<typeof useDragCoordinator>;
type TimelinePlaybackHook = ReturnType<typeof useTimelinePlayback>;
type TimelineTrackManagementHook = ReturnType<typeof useTimelineTrackManagement>;
type AssetManagementHook = ReturnType<typeof useAssetManagement>;
type ClipResizeHook = ReturnType<typeof useClipResize>;
type ClipEditingHook = ReturnType<typeof useClipEditing>;
type ExternalDropHook = ReturnType<typeof useExternalDrop>;
type TimelineSetActiveClipTab = (tab: ClipTab) => void;
type TimelineSetAssetPanelState = (patch: Partial<EditorPreferences['assetPanel']>) => void;
type TimelineSetRightPanelId = (panelId: string | null) => void;
type TimelineSetRightPanelLayoutSlot = (panelId: string, slot: RightPanelLayoutSlot) => void;
type TimelineSetShowDataLanes = (show: boolean) => void;
export type TimelineActionResizeStart = ClipResizeHook['onActionResizeStart'];
export type TimelineClipEdgeResizeEnd = ClipResizeHook['onClipEdgeResizeEnd'];
export type TimelineEditorCommands = {
  buildAddMediaCommand: (input: { trackId: string; at: number; assetKey: string }) => AddMediaCommand | null;
  buildSwapCommand: (input: { clipId: string; assetKey: string }) => SwapMediaCommand | null;
};

export interface TimelineEditorDataContextValue {
  data: TimelineData | null;
  resolvedConfig: TimelineResolvedConfig;
  deviceClass: MobileInteractionPolicy['deviceClass'];
  inputModality: TimelineInputModality;
  interactionMode: TimelineInteractionMode;
  gestureOwner: TimelineGestureOwner;
  contextTarget: TimelineContextTarget;
  inspectorTarget: TimelineInspectorTarget;
  interactionPolicy: MobileInteractionPolicy;
  selectedClipId: string | null;
  selectedDataItems: UseTimelineMultiSelectResult['selectedDataItems'];
  selectedClipIds: UseTimelineMultiSelectResult['selectedClipIds'];
  selectedClipIdsRef: UseTimelineMultiSelectResult['selectedClipIdsRef'];
  additiveSelectionRef: UseTimelineMultiSelectResult['additiveSelectionRef'];
  selectedTrackId: string | null;
  primaryClipId: UseTimelineMultiSelectResult['primaryClipId'];
  selectedClip: TimelineSelectedClip;
  selectedTrack: TimelineSelectedTrack;
  selectedClipHasPredecessor: boolean;
  compositionSize: { width: number; height: number };
  trackScaleMap: Record<string, number>;
  scale: number;
  scaleWidth: number;
  isLoading: boolean;
  dataRef: TimelineDataRef;
  pendingOpsRef: TimelinePendingOpsRef;
  interactionStateRef: import('@/tools/video-editor/lib/interaction-state').InteractionStateRef;
  coordinator: DragCoordinatorHook['coordinator'];
  indicatorRef: DragCoordinatorHook['indicatorRef'];
  editAreaRef: DragCoordinatorHook['editAreaRef'];
  preferences: EditorPreferences;
  timelineRef: TimelinePlaybackHook['timelineRef'];
  timelineWrapperRef: TimelinePlaybackHook['timelineWrapperRef'];
}

export interface TimelineEditorOpsContextValue {
  setInputModality: (inputModality: TimelineInputModality) => void;
  setInputModalityFromPointerType: (pointerType: string | null | undefined) => TimelineInputModality;
  setInteractionMode: (mode: TimelineInteractionMode) => void;
  setGestureOwner: (owner: TimelineGestureOwner) => void;
  setContextTarget: (target: TimelineContextTarget) => void;
  setInspectorTarget: (target: TimelineInspectorTarget) => void;
  isClipSelected: UseTimelineMultiSelectResult['isClipSelected'];
  selectClip: (clipId: string, opts?: SelectClipOptions) => void;
  selectClips: (clipIds: Iterable<string>) => void;
  addToSelection: (clipIds: Iterable<string>) => void;
  clearSelection: () => void;
  setSelectedTrackId: TimelineSetSelectedTrackId;
  setActiveClipTab: TimelineSetActiveClipTab;
  setAssetPanelState: TimelineSetAssetPanelState;
  setSelectedRightPanelId: TimelineSetRightPanelId;
  setRightPanelLayoutSlot: TimelineSetRightPanelLayoutSlot;
  setShowDataLanes: TimelineSetShowDataLanes;
  setShowTranscriptLane: TimelineSetShowDataLanes;
  prepareGenerationAsset: AssetManagementHook['prepareGenerationAsset'];
  registerGenerationAsset: AssetManagementHook['registerGenerationAsset'];
  onCursorDrag: TimelinePlaybackHook['onCursorDrag'];
  onClickTimeArea: TimelinePlaybackHook['onClickTimeArea'];
  onActionResizeStart: TimelineActionResizeStart;
  onClipEdgeResizeEnd: TimelineClipEdgeResizeEnd;
  onOverlayChange: ClipEditingHook['onOverlayChange'];
  onTimelineDragOver: ExternalDropHook['onTimelineDragOver'];
  onTimelineDragLeave: ExternalDropHook['onTimelineDragLeave'];
  onTimelineDrop: ExternalDropHook['onTimelineDrop'];
  addMediaFiles: ExternalDropHook['addMediaFiles'];
  handleAssetDrop: AssetManagementHook['handleAssetDrop'];
  handleUpdateClips: ClipEditingHook['handleUpdateClips'];
  handleUpdateClipsDeep: ClipEditingHook['handleUpdateClipsDeep'];
  handleDeleteClips: ClipEditingHook['handleDeleteClips'];
  handleDeleteClip: ClipEditingHook['handleDeleteClip'];
  handleSelectedClipChange: ClipEditingHook['handleSelectedClipChange'];
  handleResetClipPosition: ClipEditingHook['handleResetClipPosition'];
  handleResetClipsPosition: ClipEditingHook['handleResetClipsPosition'];
  handleSplitSelectedClip: ClipEditingHook['handleSplitSelectedClip'];
  handleSplitClipAtTime: ClipEditingHook['handleSplitClipAtTime'];
  handleSplitClipsAtPlayhead: ClipEditingHook['handleSplitClipsAtPlayhead'];
  handleToggleMuteClips: ClipEditingHook['handleToggleMuteClips'];
  handleToggleMute: ClipEditingHook['handleToggleMute'];
  handleDetachAudioClip: ClipEditingHook['handleDetachAudioClip'];
  handleTrackPopoverChange: TimelineTrackManagementHook['handleTrackPopoverChange'];
  handleMoveTrack: TimelineTrackManagementHook['handleMoveTrack'];
  handleRemoveTrack: TimelineTrackManagementHook['handleRemoveTrack'];
  moveSelectedClipToTrack: TimelineTrackManagementHook['moveSelectedClipToTrack'];
  moveSelectedClipsToTrack: TimelineTrackManagementHook['moveSelectedClipsToTrack'];
  moveClipToRow: TimelineTrackManagementHook['moveClipToRow'];
  applyResolvedClipMove: TimelineTrackManagementHook['applyResolvedClipMove'];
  createTrackAndMoveClip: TimelineTrackManagementHook['createTrackAndMoveClip'];
  uploadFiles: TimelineUploadFiles;
  /** Host-only transcript mutations; canonical references never enter extension props. */
  transcriptHost?: TranscriptPanelHost;
  applyEdit: TimelineApplyEdit;
  commands: TimelineEditorCommands;
  patchRegistry: TimelinePatchRegistry;
  unpatchRegistry: TimelineUnpatchRegistry;
  registerAsset: TimelineRegisterAsset;
  onDoubleClickAsset?: (assetKey: string, clipId?: string) => void;
  setLightboxAssetKey?: (assetKey: string | null) => void;
}

/**
 * @deprecated Prefer `TimelineEditorDataContextValue` and `TimelineEditorOpsContextValue`.
 */
export interface TimelineEditorContextValue extends TimelineEditorDataContextValue, TimelineEditorOpsContextValue {}

export interface TimelineChromeContextValue {
  timelineName: string | null;
  saveStatus: SaveStatus;
  isConflictExhausted: boolean;
  schemaIncompatible: ReadonlyArray<{ pointer?: string; code?: string; message?: string }> | null;
  /**
   * The timeline load query's error, or null. A load failure never reaches
   * `TimelineErrorBoundary` (it happens before any render), so without this the
   * shell mounts an empty editor whose badge reads `saved`.
   */
  loadError: Error | null;
  /** Refetch the timeline load query — the retry affordance on the error card. */
  retryLoad: () => void;
  renderStatus: RenderStatus;
  renderLog: string;
  visualSeamReport: VisualSeamReport | null;
  canDeclareSeamsAsHardCuts: boolean;
  declareSeamsAsHardCuts: () => Promise<void>;
  canAcknowledgeVisualCues: boolean;
  acknowledgeVisualCuesAsSynchronized: () => Promise<void>;
  renderDirty: boolean;
  renderProgress: TimelineRenderProgress;
  queuedRender: TimelineQueuedRender;
  renderResultUrl: string | null;
  renderResultFilename: string | null;
  renderResultInfo: { revision: number | null; completedAt: number } | null;
  activeRenderTaskId: string | null;
  renderDestination: RenderExportDestination;
  setRenderDestination: (destination: RenderExportDestination) => void;
  cancelRender: () => Promise<void>;
  renderRequest: TimelineRenderRequest;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * True while undo/redo are paused because media uploads are in flight
   * (`pendingOps > 0`). The toolbar uses it for the "Undo is paused while
   * media uploads finish" affordance; `canUndo`/`canRedo` are already false
   * during the pause.
   */
  historyPausedForUploads: boolean;
  checkpoints: TimelineCheckpoints;
  jumpToCheckpoint: TimelineJumpToCheckpoint;
  createManualCheckpoint: TimelineCreateManualCheckpoint;
  canonicalHistory: TimelineCanonicalHistory;
  canonicalHistorySupported: boolean;
  canonicalHistoryError: string | null;
  refreshCanonicalHistory: TimelineRefreshCanonicalHistory;
  restoringCanonicalRevisionId: string | null;
  restoreCanonicalRevision: TimelineRestoreCanonicalRevision;
  setScaleWidth: TimelineSetScaleWidth;
  handleAddTrack: TimelineTrackManagementHook['handleAddTrack'];
  handleClearUnusedTracks: TimelineTrackManagementHook['handleClearUnusedTracks'];
  unusedTrackCount: TimelineTrackManagementHook['unusedTrackCount'];
  handleAddText: ClipEditingHook['handleAddText'];
  handleAddTextAt: ClipEditingHook['handleAddTextAt'];
  reloadFromServer: TimelineReloadFromServer;
  retrySaveAfterConflict: TimelineRetrySaveAfterConflict;
  /**
   * Write-ack watchdog: true when an edit went unacknowledged past the grace
   * period or was dropped on the null-data path. The shell renders a
   * persistent, actionable banner — never a silent badge.
   */
  watchdogTripped: boolean;
  watchdogReason: 'timeout' | 'lost-edit' | null;
  retryWatchdog: () => void;
  /**
   * Astrid answered again after a stop: sends the save that never got an answer now (does nothing when none waits, or
   * when a conflict, reload or recovery choice owns the timeline).
   */
  retryPendingSave: () => void;
  /** Sends the latest unsaved edit now and resolves once it is acknowledged (immediately when nothing is pending). */
  flushPendingSave: () => Promise<number>;
  /**
   * One-slot recovery draft (plan-v5 B9): non-null when a previous session
   * left unsaved work. The shell offers Retry / Discard.
   */
  recoveryDraft: { updatedAt: string; baseVersion: number; retryAllowed?: boolean } | null;
  retryRecoveredDraft: () => void;
  discardRecoveredDraft: () => void;
  startRender: TimelineStartRender;
}

export interface TimelinePlaybackContextValue {
  currentTime: number;
  previewRef: TimelinePlaybackHook['previewRef'];
  playerContainerRef: TimelinePlaybackHook['playerContainerRef'];
  onPreviewTimeUpdate: TimelinePlaybackHook['onPreviewTimeUpdate'];
  formatTime: TimelinePlaybackHook['formatTime'];
}

export interface UseTimelineStateResult {
  store: TimelineStoreApi;
  editor: TimelineEditorContextValue & { elementTimelineRoutes?: import('../runtime/element-adapter.ts').ElementTimelineRoutes };
  editorData: TimelineEditorDataContextValue;
  editorOps: TimelineEditorOpsContextValue;
  chrome: TimelineChromeContextValue;
  playback: TimelinePlaybackContextValue;
}

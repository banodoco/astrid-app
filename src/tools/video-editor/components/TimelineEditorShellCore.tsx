import { useDataLanes } from '@/tools/video-editor/data-kinds/useDataLanes.ts';
import { EDITOR_TOUR_ANCHOR_ATTRIBUTE, EDITOR_TOUR_ANCHORS } from '@/tools/video-editor/tour/anchors';
import { useDataKindRegistrySnapshot } from '@/tools/video-editor/data-kinds/DataKindRegistryContext.tsx';
// Layer map & invariants: docs/structure_detail/tool_video_editor.md
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { CommandPalette } from '@/tools/video-editor/components/CommandPalette/CommandPalette.tsx';
import { Images, Loader2, Maximize2, Sparkles } from 'lucide-react';
import { VIDEO_EDITOR_THEME_VARS } from '@/tools/video-editor/lib/themeTokens.ts';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/shared/components/ui/alert-dialog.tsx';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/components/ui/dialog.tsx';
import { Button } from '@/shared/components/ui/button.tsx';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import { COARSE_TOUCH_TARGET } from '@/shared/components/ui/contracts/touchTarget.ts';
import { safeAreaCalc } from '@/shared/lib/safeArea.ts';
import { dispatchAppEvent } from '@/shared/lib/typedEvents.ts';
import { acquirePaneControlsHost } from '@/shared/state/paneControlsHost.ts';
import { Slider } from '@/shared/components/ui/slider.tsx';
import { activateTimelineClipData, editorReplaceTimelineSelection } from '@/shared/state/selectionStore.ts';
import { usePanesStore } from '@/shared/state/panesStore.ts';
import { useAgentChatActions, useOptionalAgentChatBridge } from '@/shared/contexts/AgentChatContext.tsx';
import { PreviewPanel } from '@/tools/video-editor/components/PreviewPanel/PreviewPanel.tsx';
import { useVideoEditorPreviewSurface } from '@/tools/video-editor/components/PreviewPanel/useVideoEditorPreviewSurface.tsx';
import { PropertiesPanel } from '@/tools/video-editor/components/PropertiesPanel/PropertiesPanel.tsx';
import { ExtensionManager } from '@/tools/video-editor/components/ExtensionManager';
import {
  HOST_PROPERTIES_PANEL_KEY,
  VideoEditorRightPanelDock,
  type VideoEditorRightPanelTab,
} from '@/tools/video-editor/components/PropertiesPanel/VideoEditorRightPanelDock.tsx';
import { TimelineEditor } from '@/tools/video-editor/components/TimelineEditor/TimelineEditor.tsx';
import { CREATE_ANIMATION_PROMPT } from '@/tools/video-editor/components/TimelineEditor/TimelineCreateTools.tsx';
import { TimelineErrorBoundary } from '@/tools/video-editor/components/TimelineEditor/TimelineErrorBoundary.tsx';
import {
  useTimelineChromeContext,
  useTimelineEditorData,
  useTimelineEditorOps,
  useTimelinePlaybackSelector,
  useTimelineStoreApi,
  useProposalRuntimeFromStoreSafe,
  useProposalImportDiagnosticsFromStoreSafe,
} from '@/tools/video-editor/hooks/timelineStore.ts';
import { isEditorKeyboardEvent, useKeyboardShortcuts } from '@/tools/video-editor/hooks/useKeyboardShortcuts.ts';
import { useEditorBrowserDefaults } from '@/tools/video-editor/hooks/useEditorBrowserDefaults.ts';
import { useTimelineRealtime } from '@/tools/video-editor/hooks/useTimelineRealtime.ts';
import { getTimelineDurationInFrames, parseResolution } from '@/tools/video-editor/lib/config-utils.ts';
import { buildKeyboardDeleteMutation } from '@/tools/video-editor/lib/keyboard-delete.ts';
import { buildKeyboardTimeNudgeMutation } from '@/tools/video-editor/lib/keyboard-nudge.ts';
import {
  areTimelineInteractionTargetsEqual,
  getDefaultInteractionMode,
  resolveArmedTouchGesture,
  type TimelineInspectorTarget,
} from '@/tools/video-editor/lib/mobile-interaction-model.ts';
import { bootDiagnostics, MemoryPressureDetector } from '@/tools/video-editor/lib/perf-diagnostics.ts';
import { CLIP_ACTION_CLASS, CLIP_SELECTED_ATTR, TRACK_LABEL_ATTR, shellRegionAttrs } from '@/tools/video-editor/lib/timeline-dom.ts';
import { useRenderDiagnostic } from '@/tools/video-editor/hooks/usePerfDiagnostics.ts';
import { useElementWidth } from '@/shared/hooks/layout/useElementWidth.ts';
import { projectOutputTimelineConfig } from '@/tools/video-editor/data/timelineOutputProjection.ts';
import { ExtensionActivityRegion, type ExtensionStatusEvent } from '@/tools/video-editor/components/ExtensionActivityRegion';
import { ProposalPanel } from '@/tools/video-editor/components/ProposalPanel/ProposalPanel.tsx';
import { TimelineEditorShellToolbar, TimelineUndoRedo } from './TimelineEditorShellToolbar.tsx';
import { TimelineExportMenu } from './TimelineExportMenu.tsx';
import { TimelineLoadErrorCard } from './TimelineLoadErrorCard.tsx';
import { useOnRecoveryCardCleared, useRecoveryCardShowing } from '@/integrations/runtime/recoveryCard.ts';
import { TimelineRenderControls } from './TimelineRenderControls.tsx';
import { VideoEditorPanelDisplayControl } from './PropertiesPanel/VideoEditorPanelDisplayControl.tsx';
import {
  CHROME_OVERHEAD,
  MIN_PREVIEW_HEIGHT,
  useTimelineShellDividerDrag,
} from './useTimelineShellDividerDrag.ts';
import { useVideoEditorShellSlots } from './useVideoEditorShellSlots.tsx';
import { useVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import {
  AppHeader,
  type AppHeaderNavigationMode,
} from '@/shared/components/AppHeader.tsx';

/** The thumb bar's round buttons: 44px, quiet until pressed. */
const THUMB_BAR_CIRCLE_CLASS = 'h-11 w-11 shrink-0 rounded-full border-border bg-card/95 text-muted-foreground shadow-sm hover:text-foreground';

function PlaybackTimecode() {
  const currentTime = useTimelinePlaybackSelector((playback) => playback.currentTime);
  const formatTime = useTimelinePlaybackSelector((playback) => playback.formatTime);
  return <>{formatTime(currentTime)}</>;
}

function PlaybackSlider({ max, onUserSeek }: { max: number; onUserSeek?: () => void }) {
  const currentTime = useTimelinePlaybackSelector((playback) => playback.currentTime);
  const previewRef = useTimelinePlaybackSelector((playback) => playback.previewRef);

  return (
    <Slider
      value={[currentTime]}
      min={0}
      max={max}
      step={0.05}
      // The slider reports only the person's drags and keys, never playback moving `value`.
      onValueChange={(value) => {
        onUserSeek?.();
        previewRef.current?.seek(value);
      }}
    />
  );
}

/**
 * The touch shell's grid, for phones and tablets alike. It stacks the document
 * row, the picture, the timeline and the Astrid bar. A short landscape screen
 * (a phone on its side, under 500px tall) has no height to stack, so it puts the
 * picture and the bar beside the document row and the timeline. A tablet in
 * landscape has the height, and its timeline wants the full width: it stacks.
 * The variant is spelled out in full on each class (`[@media(orientation:landscape)_and_(max-height:500px)]:`)
 * because Tailwind only sees literal class names.
 */
const TOUCH_GRID = [
  "grid-cols-1 grid-rows-[auto_auto_minmax(120px,1fr)_auto] [grid-template-areas:'toolbar'_'preview'_'timeline'_'agent']",
  "[@media(orientation:landscape)_and_(max-height:500px)]:grid-cols-2 [@media(orientation:landscape)_and_(max-height:500px)]:grid-rows-[auto_minmax(0,1fr)_auto] [@media(orientation:landscape)_and_(max-height:500px)]:[grid-template-areas:'preview_toolbar'_'preview_timeline'_'agent_timeline']",
].join(' ');
const TOUCH_GRID_WITH_ACTIVITY = [
  "grid-cols-1 grid-rows-[auto_auto_auto_minmax(120px,1fr)_auto] [grid-template-areas:'toolbar'_'activity'_'preview'_'timeline'_'agent']",
  "[@media(orientation:landscape)_and_(max-height:500px)]:grid-cols-2 [@media(orientation:landscape)_and_(max-height:500px)]:grid-rows-[auto_auto_minmax(0,1fr)_auto] [@media(orientation:landscape)_and_(max-height:500px)]:[grid-template-areas:'preview_toolbar'_'preview_activity'_'preview_timeline'_'agent_timeline']",
].join(' ');

export interface TimelineEditorShellCoreProps {
  timelineId: string;
  /** Replace the app-specific timeline body while retaining the shared editor shell. */
  renderTimeline?: (actions: TimelineEditorRenderActions) => ReactNode;
  forceCondensed?: boolean;
  isOnEditorPage?: boolean;
  isEditorPaneLocked?: boolean;
  isGenerationsPaneLocked?: boolean;
  isGenerationsPaneOpen?: boolean;
  onSetGenerationsPaneLocked?: (locked: boolean) => void;
  onNavigateHome?: () => void;
  onOpenEditorRoute?: (timelineId: string) => void;
  /** Project controls rendered once in the app/editor header. */
  headerNavigationControls?: ReactNode;
  /** Timeline controls rendered once in the preview context row. */
  previewNavigationControls?: ReactNode;
  /** @deprecated Use the explicit placement props. Legacy controls stay preview-only. */
  navigationControls?: ReactNode;
  navigationMode?: AppHeaderNavigationMode;
  showHeader?: boolean;
}

export interface TimelineEditorRenderActions {
  readonly onOpenSequenceCreator: () => void;
  readonly onOpenElementCreationPrompt: (prompt: string) => void;
  readonly onOpenExtensionManager: () => void;
}

// The preview row's timeline picker keeps at least 160px before Render drops to its icon:
// the row's gutters and gap (32px) and the full-screen button with the "Render" label (150px) are the rest.
const PICKER_MIN_PX = 160;
const PREVIEW_ROW_CHROME_PX = 32 + 150;
const RENDER_ICON_ONLY_BELOW_PX = PICKER_MIN_PX + PREVIEW_ROW_CHROME_PX;

/** The save conflict dialog and its inline banner say the same thing with the same two buttons. */
const TIMELINE_CONFLICT_SENTENCE = 'Keep your changes, or switch to the latest version.';
const TIMELINE_CONFLICT_KEEP_MINE = 'Keep my changes';
const TIMELINE_CONFLICT_USE_LATEST = 'Use latest version';

/** "10:48 PM": when the recovered draft was last written. */
function formatDraftTime(updatedAt: number | string | Date): string {
  return new Date(updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Kinds whose LIVE target owns the inspector until the user picks real
 * content (groken round-4 LIVE-1): extension dispatches (`dataItem` /
 * `dataLane`) and host preview/shader/overlay targets must not be snapped
 * back to the selection-derived placeholder when the selection is empty.
 */
const INSPECTOR_HOST_OWNED_KINDS: ReadonlySet<string> = new Set([
  'dataItem',
  'dataLane',
  'shader',
  'preview',
  'overlay',
  'shotOccurrence',
]);
/**
 * Pane geometry animates only in response to the person: the first layout, and every change while
 * the timeline, panels and preferences arrive, lands at its final size. Ends at the first pointer
 * or key input anywhere in the page.
 */
/** The longest the boot screen (or the connection panel on its way out) waits for the first timeline load; past it the
 *  editor shows its own loading panes rather than keeping the page covered. */
const FIRST_LOAD_HOLD_MAX_MS = 6000;

/** Whether the editor still holds the boot screen over itself: until its first load answers, at most for a while. */
function useFirstLoadHold(answered: boolean): boolean {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setExpired(true), FIRST_LOAD_HOLD_MAX_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return !answered && !expired;
}

function useLayoutSettlingUntilInput(): boolean {
  const [settling, setSettling] = useState(true);
  useEffect(() => {
    if (!settling) return undefined;
    const settle = () => setSettling(false);
    window.addEventListener('pointerdown', settle, { capture: true });
    window.addEventListener('keydown', settle, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', settle, { capture: true });
      window.removeEventListener('keydown', settle, { capture: true });
    };
  }, [settling]);
  return settling;
}

/**
 * True while index.html's boot layer still covers the page. Its dissolve then reveals the shell
 * together with the header, so the shell skips its own entrance fade (a second fade would lag
 * the cards behind the header). Later mounts (switching project or timeline) keep the fade.
 */
const isBootLayerUp = (): boolean => (
  typeof document !== 'undefined' && document.querySelector('#boot:not(.boot-done):not(.boot-flying)') !== null
);

function getInspectorTargetForSelection(
  selectedClipIds: string[],
  selectedTrackId: string | null,
  dataItems: readonly import('@/shared/state/selectionStore.ts').TimelineDataItemRef[] = [],
): TimelineInspectorTarget {
  if (dataItems.length) {
    if (dataItems.length + selectedClipIds.length > 1) return { kind: 'selection', clipIds: selectedClipIds, dataItems };
    return { kind: 'dataItem', ...dataItems[0] };
  }
  if (selectedClipIds.length > 1) {
    return { kind: 'selection', clipIds: selectedClipIds };
  }

  if (selectedClipIds.length === 1) {
    return { kind: 'clip', clipId: selectedClipIds[0] };
  }

  if (selectedTrackId) {
    return { kind: 'track', trackId: selectedTrackId };
  }

  return { kind: 'timeline' };
}

function TimelineEditorShellCoreComponent({
  timelineId,
  renderTimeline,
  forceCondensed = false,
  isOnEditorPage = false,
  isEditorPaneLocked = false,
  isGenerationsPaneLocked = false,
  isGenerationsPaneOpen = false,
  onSetGenerationsPaneLocked,
  onNavigateHome,
  onOpenEditorRoute,
  headerNavigationControls,
  previewNavigationControls,
  navigationControls,
  navigationMode,
  showHeader = true,
}: TimelineEditorShellCoreProps) {
  const previewControls = previewNavigationControls ?? navigationControls;
  useRenderDiagnostic('TimelineEditorShellCore');
  const [previewRowRef, previewRowWidth] = useElementWidth<HTMLDivElement>();
  const renderIconOnly = previewRowWidth !== null && previewRowWidth < RENDER_ICON_ONLY_BELOW_PX;
  const runtime = useVideoEditorRuntime();
  const editorData = useTimelineEditorData();
  const editorOps = useTimelineEditorOps();
  const chrome = useTimelineChromeContext();
  const previewRef = useTimelinePlaybackSelector((playback) => playback.previewRef);
  const timelineStore = useTimelineStoreApi();
  /** Phones and tablets share one touch editor; only desktop differs. */
  const touchChrome = editorData.deviceClass !== 'desktop';
  /** Extension activity region status events (placeholder state). */
  const [activityEvents, setActivityEvents] = useState<readonly ExtensionStatusEvent[]>([]);
  /** Proposal runtime and import diagnostics from timelineStore. */
  const proposalRuntime = useProposalRuntimeFromStoreSafe();
  const proposalImportDiagnostics = useProposalImportDiagnosticsFromStoreSafe();
  const hasProposals = proposalRuntime !== null && proposalRuntime.list().length > 0;
  const hasDiagnostics = proposalImportDiagnostics !== null && (
    proposalImportDiagnostics.diagnostics.length > 0 ||
    proposalImportDiagnostics.imported > 0 ||
    proposalImportDiagnostics.skipped > 0 ||
    proposalImportDiagnostics.rejected > 0
  );
  const showProposalPanel = proposalRuntime !== null && (hasProposals || hasDiagnostics);
  const hasActivityRegion = activityEvents.length > 0 || showProposalPanel;
  const {
    containerRef,
    dividerRef,
    timelineRef,
    isTimelineMaximized,
    setIsTimelineMaximized,
    onDividerPointerDown,
    onDividerPointerMove,
    onDividerPointerUp,
    onDividerPointerCancel,
    onDividerLostPointerCapture,
    gridTemplateRows,
  } = useTimelineShellDividerDrag(hasActivityRegion);
  const [condensedRightPanel, setCondensedRightPanel] = useState<VideoEditorRightPanelTab>('video');
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isExtensionManagerOpen, setIsExtensionManagerOpen] = useState(false);
  const openExtensionManager = useCallback(() => setIsExtensionManagerOpen(true), []);
  const agentChatBridge = useOptionalAgentChatBridge();
  const requestComposerPrompt = agentChatBridge?.requestComposerPrompt;
  // Opens the chat locked, the same as the lock button: a temporary open would leave the lock icon, layout push and
  // hover-close out of step with the pane.
  const setIsTasksPaneLocked = usePanesStore((state) => state.setIsTasksPaneLocked);
  const openElementCreationPrompt = useCallback((prompt: string) => {
    runtime.agentChat?.activateTimeline?.();
    if (runtime.agentSelectionOwner) activateTimelineClipData(runtime.agentSelectionOwner);
    requestComposerPrompt?.(prompt);
    setIsTasksPaneLocked(true);
  }, [requestComposerPrompt, setIsTasksPaneLocked, runtime.agentChat, runtime.agentSelectionOwner]);
  const handleActivityDismiss = useCallback((eventId: string) => {
    setActivityEvents((prev) => prev.filter((e) => e.id !== eventId));
  }, []);

  // A refetch that fails keeps the last loaded timeline (and the local draft on top of it). While the Astrid stopped /
  // restarted card is up, that timeline stays mounted behind it: the card says the changes are kept, so they stay in view.
  const hasLoadedTimeline = Boolean(editorData.resolvedConfig);
  const holdsBoot = useFirstLoadHold(hasLoadedTimeline || Boolean(chrome.loadError));
  const recoveryCardShowing = useRecoveryCardShowing();
  // Astrid answering again clears the card. What failed while it was stopped is retried here, so the page carries on as
  // the card promised ("Your changes are kept"): a timeline read that failed is read again, and an edit that was never
  // saved is saved now, without waiting for another edit.
  useOnRecoveryCardCleared(() => {
    if (chrome.loadError) chrome.retryLoad();
    if (chrome.saveStatus === 'error' || chrome.saveStatus === 'dirty') chrome.retryPendingSave();
  });
  const conflict = useTimelineRealtime({
    timelineId,
    conflictExhausted: chrome.isConflictExhausted,
    onKeepLocalChanges: chrome.retrySaveAfterConflict,
    onDiscardRemoteChanges: chrome.reloadFromServer,
  });

  useEffect(() => {
    bootDiagnostics();
    MemoryPressureDetector.start();
    return MemoryPressureDetector.stop;
  }, []);

  // Host-reserved command palette keyboard shortcut (CtrlOrCmd+Shift+P).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Don't trigger when the palette is already open — the cmdk dialog
      // owns keyboard handling in that case.
      if (isCommandPaletteOpen) return;
      if (runtime.shellRootRef && !isEditorKeyboardEvent(event, runtime.shellRootRef.current)) return;

      const isModifierPressed = event.metaKey || event.ctrlKey;
      if (isModifierPressed && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        event.stopPropagation();
        setIsCommandPaletteOpen(true);
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [isCommandPaletteOpen, runtime.shellRootRef]);

  const handleKeyboardDelete = useCallback(() => {
    if (editorData.selectedDataItems?.length) return;
    const mutation = buildKeyboardDeleteMutation(editorData.dataRef.current, editorData.selectedClipIds);
    if (mutation) {
      editorOps.applyEdit(mutation, { semantic: true });
      return;
    }

    editorOps.handleDeleteClips([...editorData.selectedClipIds]);
  }, [editorData.dataRef, editorData.selectedClipIds, editorData.selectedDataItems, editorOps]);

  const handleKeyboardTimeNudge = useCallback((deltaSeconds: number) => {
    if (editorData.selectedDataItems?.length) return;
    const mutation = buildKeyboardTimeNudgeMutation(
      editorData.dataRef.current,
      editorData.selectedClipIds,
      deltaSeconds,
      runtime.timelineEditability,
    );
    if (mutation) {
      editorOps.applyEdit(mutation, { semantic: true });
    }
  }, [editorData.dataRef, editorData.selectedClipIds, editorData.selectedDataItems, editorOps]);

  useKeyboardShortcuts({
    hasSelectedClip: !editorData.selectedDataItems?.length && editorData.selectedClipIds.size > 0,
    canMoveSelectedClipToTrack: !editorData.selectedDataItems?.length && editorData.selectedClipIds.size >= 1,
    selectedClipIds: editorData.selectedClipIds,
    moveSelectedClipsToTrack: editorOps.moveSelectedClipsToTrack,
    nudgeSelectedClipsInTime: handleKeyboardTimeNudge,
    undo: chrome.undo,
    redo: chrome.redo,
    selectAllClips: () => editorReplaceTimelineSelection(Object.keys(editorData.data?.meta ?? {}), runtime.agentSelectionOwner),
    togglePlayPause: () => previewRef.current?.togglePlayPause(),
    toggleFullscreen: () => previewRef.current?.toggleFullscreen(),
    seekRelative: (deltaSeconds) => previewRef.current?.seek(Math.max(
      0,
      timelineStore.getState().playback.currentTime + deltaSeconds,
    )),
    toggleMute: () => { if (!editorData.selectedDataItems?.length) editorOps.handleToggleMuteClips([...editorData.selectedClipIds]); },
    splitSelectedClip: () => { if (!editorData.selectedDataItems?.length) editorOps.handleSplitSelectedClip(); },
    deleteSelectedClip: handleKeyboardDelete,
    clearSelection: editorOps.clearSelection,
  });

  const outputResolution = editorData.resolvedConfig?.output?.resolution;
  const aspectRatio = useMemo(() => {
    if (!outputResolution) {
      return 16 / 9;
    }

    const { width, height } = parseResolution(outputResolution);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return 16 / 9;
    }

    return width / height;
  }, [outputResolution]);
  const [tooSmall, setTooSmall] = useState(false);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const [shellRootNode, setShellRootNode] = useState<HTMLDivElement | null>(null);
  const setShellRoot = useCallback((node: HTMLDivElement | null) => {
    if (runtime.shellRootRef && (node || runtime.shellRootRef.current === outerRef.current)) {
      runtime.shellRootRef.current = node;
    }
    outerRef.current = node;
    setShellRootNode(node);
  }, [runtime.shellRootRef]);
  useEditorBrowserDefaults({
    shellRoot: shellRootNode,
    saveStatus: chrome.saveStatus,
    flushPendingSave: chrome.flushPendingSave,
    preserveTimelineDraftForReload: chrome.preserveTimelineDraftForReload,
    isTimelineDraftDurableForReload: chrome.isTimelineDraftDurableForReload,
  });
  const activateInstance = useCallback(() => {
    runtime.agentChat?.activateTimeline?.();
    if (runtime.agentSelectionOwner) activateTimelineClipData(runtime.agentSelectionOwner);
  }, [runtime.agentChat, runtime.agentSelectionOwner]);
  const selectedClipIdsList = useMemo(() => [...editorData.selectedClipIds], [editorData.selectedClipIds]);
  const lanePlane = useDataLanes({ base: editorData.data });
  const kindRecords = useDataKindRegistrySnapshot();
  const inspectorTarget = useMemo(() => {
    const target = getInspectorTargetForSelection(selectedClipIdsList, editorData.selectedTrackId, editorData.selectedDataItems);
    if (target?.kind === 'dataItem') {
      const lane = lanePlane?.dataLanes.find((candidate) => candidate.laneId === target.laneId);
      const record = lane?.kindId ? kindRecords.get(lane.kindId) : undefined;
      return { ...target, extensionId: record?.ownerExtensionId, contributionId: record?.contributionId };
    }
    return target;
  }, [editorData.selectedTrackId, editorData.selectedDataItems, selectedClipIdsList, lanePlane, kindRecords]);

  useEffect(() => {
    const el = outerRef.current;
    if (!el || forceCondensed) return;

    const observer = new ResizeObserver(([entry]) => {
      const minPreviewHeight = isTimelineMaximized
        ? MIN_PREVIEW_HEIGHT
        : Math.max(MIN_PREVIEW_HEIGHT, Math.min(360, entry.contentRect.width * 0.35) / aspectRatio);
      setTooSmall(entry.contentRect.height < minPreviewHeight + CHROME_OVERHEAD);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [forceCondensed, aspectRatio, isTimelineMaximized]);

  const mobileSinglePane = touchChrome;
  // Give the timeline the available height and move Video into the sidebar
  // when the generations pane is pinned or there isn't room to stack both.
  const condensed = forceCondensed || tooSmall || (isGenerationsPaneOpen && isGenerationsPaneLocked) || mobileSinglePane || (isOnEditorPage && isEditorPaneLocked);
  // Touch controls match the header: 36px with a 44px touch target. On the desktop
  // picture they match the timeline picker beside them: 32px, 12px type.
  const previewActionButtonClass = touchChrome
    ? cn('h-9 min-w-9 px-3 text-xs', COARSE_TOUCH_TARGET)
    : 'h-8 px-3 text-xs';
  const interactionStatusLabel = [
    `Timeline mode ${editorData.interactionMode}.`,
    editorData.gestureOwner === 'preview'
      ? 'Preview transform active.'
      : (touchChrome ? 'Touch controls are available for shell, timeline, and preview actions.' : 'Desktop pointer controls are active.'),
  ].join(' ');

  useEffect(() => {
    // groken LIVE-1: when a host-owned target (extension dataItem/dataLane,
    // shader, preview, overlay) is live, an empty selection's derived
    // `{kind:'timeline'}` placeholder must NOT overwrite it. Real content
    // picks (clip/selection/track) still write through.
    const liveKind = editorData.inspectorTarget?.kind;
    if (
      liveKind === 'shotOccurrence'
      && selectedClipIdsList.length === 0
      && editorData.inspectorTarget?.trackId === editorData.selectedTrackId
    ) {
      return;
    }
    if (
      typeof liveKind === 'string'
      && INSPECTOR_HOST_OWNED_KINDS.has(liveKind)
      && inspectorTarget?.kind === 'timeline'
    ) {
      return;
    }
    if (!areTimelineInteractionTargetsEqual(editorData.inspectorTarget, inspectorTarget)) {
      editorOps.setInspectorTarget(inspectorTarget);
      if (editorData.selectedDataItems?.length) editorOps.setContextTarget(inspectorTarget);
    }
  }, [editorData.inspectorTarget, editorData.selectedTrackId, editorData.selectedDataItems, editorOps, inspectorTarget, selectedClipIdsList]);

  useEffect(() => {
    if (condensed && !touchChrome) setCondensedRightPanel('video');
  }, [condensed, touchChrome, isGenerationsPaneOpen, isGenerationsPaneLocked]);

  // Touch: Inspector shows what was picked. Once nothing is (the clip was closed or
  // deleted), the picture comes back rather than an empty Inspector.
  const inspectorKind = inspectorTarget?.kind ?? 'timeline';
  const previousInspectorKindRef = useRef(inspectorKind);
  useEffect(() => {
    const previous = previousInspectorKindRef.current;
    previousInspectorKindRef.current = inspectorKind;
    if (touchChrome && inspectorKind === 'timeline' && previous !== 'timeline') {
      setCondensedRightPanel((current) => (current === 'inspector' ? 'video' : current));
    }
  }, [inspectorKind, touchChrome]);

  // Touch: moving the playhead by hand brings the picture back, so the frame is in
  // view. The hand's ways are the scrubber and the timeline ruler (a ruler gesture
  // owns the pointer); playback and agent edits move the playhead without either.
  // Jump to beginning sits on the picture, so Video is already showing there.
  const showVideoForUserSeek = useCallback(() => {
    if (touchChrome) setCondensedRightPanel('video');
  }, [touchChrome]);
  const rulerGesture = editorData.gestureOwner === 'ruler';
  useEffect(() => {
    if (rulerGesture) showVideoForUserSeek();
  }, [rulerGesture, showVideoForUserSeek]);

  const previewSurface = useVideoEditorPreviewSurface({ compact: condensed, touchChrome });
  // The shell owns the portal outside the changing layout branches. Panels
  // only provide slots, so moving the host preserves the mounted player.
  const previewPanelSurface = useMemo(() => ({ ...previewSurface, portal: null }), [previewSurface]);

  const {
    compileOnlyExportFormats,
    renderDependentExportFormats,
    hasAnyExportFormat,
    headerSlot,
    toolbarSlot,
    inspectorPanelSlot,
    timelineFooterSlot,
    statusBarSlot,
    leftPanelSlot,
    rightPanelSlot,
    codePanelSlot,
    writingPanelSlot,
    stagePanelSlot,
    dialogsSlot,
  } = useVideoEditorShellSlots();

  const savedPanelId = editorData.preferences?.selectedRightPanelId === undefined
    ? HOST_PROPERTIES_PANEL_KEY
    : editorData.preferences.selectedRightPanelId;
  // Only "Closed" (null) closes the pane. A selected extension panel that is not
  // registered (disabled in the Extension Manager, or not activated yet on boot)
  // keeps the pane open on the Extensions tab; the dock falls back to another panel.
  const rightPanelOpen = savedPanelId !== null;
  const rightPanelLayoutSlots = editorData.preferences?.rightPanelLayoutSlotsByPanelId ?? {};
  // The host slot is the shared placement for the whole right-panel surface.
  // Per-panel values remain as a migration fallback for older saved settings,
  // but switching between Inspector and Extensions must not change the mode.
  const rightPanelLayout = rightPanelLayoutSlots[HOST_PROPERTIES_PANEL_KEY]
    ?? (savedPanelId ? rightPanelLayoutSlots[savedPanelId] : undefined)
    ?? 'dock';
  const hasCustomRightPanelSlot = Boolean(rightPanelSlot || inspectorPanelSlot);
  const hostPaneClosed = !hasCustomRightPanelSlot && !rightPanelOpen;
  const showFullHeightHostDock = !hasCustomRightPanelSlot
    && rightPanelOpen
    && rightPanelLayout === 'dock';
  const showCompactHostDock = !hasCustomRightPanelSlot
    && !condensed
    && !mobileSinglePane
    && rightPanelOpen
    && rightPanelLayout === 'compact';
  const workAreaGridColumn = leftPanelSlot ? '2 / span 2' : '1 / span 2';
  const hostPanelInset = showFullHeightHostDock
    ? 'calc(min(360px, 32vw, calc(100vw - 24px)) + 12px)'
    : '0px';
  const previewAreaRef = useRef<HTMLDivElement>(null);
  const layoutSettling = useLayoutSettlingUntilInput();
  const [revealedByBoot] = useState(isBootLayerUp);
  const shellEntrance = revealedByBoot ? '' : 'animate-in fade-in';
  const [panelHeights, setPanelHeights] = useState({ compact: 0, full: 0 });
  useLayoutEffect(() => {
    if (condensed || mobileSinglePane || hasCustomRightPanelSlot) return;
    const container = containerRef.current;
    const preview = previewAreaRef.current;
    if (!container || !preview) return;
    const measure = () => {
      const style = getComputedStyle(container);
      const compact = preview.getBoundingClientRect().height;
      const full = Math.max(0, container.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0));
      setPanelHeights((previous) => Math.abs(previous.compact - compact) < 0.5 && Math.abs(previous.full - full) < 0.5
        ? previous : { compact, full });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(container);
    observer?.observe(preview);
    return () => observer?.disconnect();
  }, [condensed, mobileSinglePane, hasCustomRightPanelSlot, containerRef, hasActivityRegion, gridTemplateRows]);

  const totalSeconds = useMemo(() => {
    if (!editorData.resolvedConfig) return 1;
    const outputConfig = projectOutputTimelineConfig(editorData.resolvedConfig).config;
    return getTimelineDurationInFrames(outputConfig, outputConfig.output.fps) / outputConfig.output.fps;
  }, [editorData.resolvedConfig]);

  // The condensed desktop/tablet layout hosts Video in the right dock, whose
  // tabs replace the overlay's Inspector button and panel reopen control.
  const sidebarVideo = condensed && !mobileSinglePane;
  // Expand returns Video to the main area: unlock the pinned gallery on the
  // editor page, or open the editor from elsewhere. Otherwise there's no bigger view.
  const expandsByUnlocking = Boolean(isOnEditorPage && isGenerationsPaneLocked && onSetGenerationsPaneLocked);
  const showExpandVideo = sidebarVideo && (expandsByUnlocking || (!isOnEditorPage && Boolean(onOpenEditorRoute)));
  const expandVideoLabel = expandsByUnlocking ? 'Expand video' : 'Open editor';

  /** Touch has no mode switcher: a clip's Move/Trim arms the gesture and Done releases it. */
  const armedGesture = resolveArmedTouchGesture(editorData.deviceClass, editorData.interactionMode);
  const releaseArmedGesture = useCallback(() => {
    editorOps.setInteractionMode(getDefaultInteractionMode(editorData.deviceClass));
  }, [editorData.deviceClass, editorOps]);

  // The touch shell carries chat and the gallery in its own bottom bar, so the app's
  // floating pane tabs step aside instead of covering the picture and the timeline.
  useEffect(() => (mobileSinglePane ? acquirePaneControlsHost() : undefined), [mobileSinglePane]);
  const openAgentComposer = useCallback(() => {
    runtime.agentChat?.activateTimeline?.();
    if (runtime.agentSelectionOwner) activateTimelineClipData(runtime.agentSelectionOwner);
    dispatchAppEvent('openAgentComposer');
  }, [runtime.agentChat, runtime.agentSelectionOwner]);
  const agentWorking = useAgentChatActions()?.isAgentWorking ?? false;
  // Touch picks open the shared Inspector, including a repeat tap on the same
  // clip/track. Controls inside a clip keep their own action. While Move/Trim
  // is armed, tapping the selected clip releases the gesture.
  const openInspectorFromTap = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!(event.target instanceof Element)) return;
    const clip = event.target.closest(`.${CLIP_ACTION_CLASS}`);
    const track = event.target.closest(`[${TRACK_LABEL_ATTR}]`);
    const control = event.target.closest('button, a, input, textarea, select, [role="menuitem"], [data-no-clip-drag]');
    if ((!clip && !track) || (control && (clip ?? track)?.contains(control))) return;
    if (clip && armedGesture) {
      if (clip.getAttribute(CLIP_SELECTED_ATTR) !== 'true') return;
      releaseArmedGesture();
    }
    setCondensedRightPanel('inspector');
  }, [armedGesture, releaseArmedGesture]);

  /** Desktop's 10px pane grips fit in regular padding; touch uses its own bottom bar. */
  const mainPadding: CSSProperties | undefined = touchChrome
    ? undefined
    : {
      paddingBottom: safeAreaCalc.paddingBottom('12px'),
    };

  const renderControls = (
    <>
      {hasAnyExportFormat && (
        <TimelineExportMenu
          compileOnlyExportFormats={compileOnlyExportFormats}
          renderDependentExportFormats={renderDependentExportFormats}
          previewActionButtonClass={previewActionButtonClass}
        />
      )}
      <TimelineRenderControls
        compact={mobileSinglePane}
        iconOnly={!mobileSinglePane && renderIconOnly}
        previewActionButtonClass={previewActionButtonClass}
        afterRenderControl={!mobileSinglePane && !hasCustomRightPanelSlot && !sidebarVideo ? <VideoEditorPanelDisplayControl visible={hostPaneClosed} className="video-editor-panel-reopen-motion" /> : undefined}
      />
    </>
  );

  // The touch shell names its timeline in the document row, not on the picture:
  // the picker's own 36px chip with a 44px touch ring. New timeline is in its list.
  const touchTimelineControls = previewControls ? (
    <div
      className="flex min-w-0 items-center gap-2"
      data-testid="video-editor-editor-navigation-controls"
    >
      {previewControls}
    </div>
  ) : null;

  const toolbar = (
    <TimelineEditorShellToolbar
      timelineLoaded={Boolean(editorData.data)}
      touchChrome={touchChrome}
      condensed={condensed}
      documentRow={mobileSinglePane}
      armedGesture={armedGesture}
      onReleaseArmedGesture={releaseArmedGesture}
      leading={mobileSinglePane ? touchTimelineControls : undefined}
      trailing={mobileSinglePane ? renderControls : undefined}
      onDividerPointerDown={onDividerPointerDown}
      onDividerPointerMove={onDividerPointerMove}
      onDividerPointerUp={onDividerPointerUp}
      onDividerPointerCancel={onDividerPointerCancel}
      onDividerLostPointerCapture={onDividerLostPointerCapture}
      isTimelineMaximized={isTimelineMaximized}
      setIsTimelineMaximized={setIsTimelineMaximized}
    />
  );

  /** Mount extension activity only when it has visible content. */
  const activityRegion = hasActivityRegion ? (
    <ExtensionActivityRegion
      statusEvents={activityEvents}
      onDismiss={handleActivityDismiss}
      isExpanded={false}
    >
      {showProposalPanel && proposalRuntime ? (
        <ProposalPanel
          proposalRuntime={proposalRuntime}
          proposalImportDiagnostics={proposalImportDiagnostics}
        />
      ) : null}
    </ExtensionActivityRegion>
  ) : null;

  const reservedSlots = codePanelSlot || writingPanelSlot || stagePanelSlot ? (
    <div
      className="flex max-h-32 w-full min-w-0 max-w-full shrink-0 flex-wrap items-start gap-2 overflow-y-auto border-t border-border/40 px-3 py-2"
      {...shellRegionAttrs('reservedSlots')}
    >
      {codePanelSlot}
      {writingPanelSlot}
      {stagePanelSlot}
    </div>
  ) : null;

  // The touch shell keeps the picture clear: the timeline picker and Render sit in the
  // document row above it, the readout with the scrubber below it.
  const previewOverlay = mobileSinglePane ? null : (
    <div
      ref={previewRowRef}
      className={cn(
        'pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 px-3 py-3',
        // Keep Render clear of the app's pane tab in the touch sidebar.
        sidebarVideo && touchChrome && 'pr-10',
      )}
      data-shell-interaction="true"
    >
      <div className="pointer-events-auto flex min-w-0 max-w-[min(75%,32rem)] flex-col items-start gap-1">
        {previewControls && (
          <div
            className="flex min-w-0 max-w-full items-center gap-2"
            data-testid="video-editor-editor-navigation-controls"
          >
            {previewControls}
          </div>
        )}
        {/* The picker's own surface, quieter: a readout, not a control. */}
        <span className="shrink-0 rounded-md border border-border/70 bg-card/90 px-1.5 py-0.5 font-mono text-[11px] tabular-nums tracking-[0.08em] text-muted-foreground backdrop-blur-md">
          <PlaybackTimecode />
        </span>
      </div>
      <div className="pointer-events-auto flex shrink-0 items-center justify-end gap-1">
        {showExpandVideo && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={expandVideoLabel}
            title={expandVideoLabel}
            className={cn(previewActionButtonClass, 'aspect-square px-0')}
            onClick={() => {
              if (expandsByUnlocking) {
                onSetGenerationsPaneLocked?.(false);
              } else {
                onOpenEditorRoute?.(timelineId);
              }
            }}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        )}
        {renderControls}
      </div>
    </div>
  );

  /** Write-ack watchdog banner: an edit went unacknowledged (or was dropped on
   *  the null-data path). Persistent and actionable — never a silent badge. */
  const watchdogBanner = chrome.watchdogTripped ? (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <span>
        {chrome.watchdogReason === 'lost-edit'
          ? 'Your edits could not be applied — the timeline is not loaded yet. Reload the timeline before editing.'
          : 'Your changes have not been saved: the save never got a confirmation.'}
      </span>
      <Button type="button" size="sm" variant="outline" onClick={chrome.retryWatchdog}>
        {chrome.watchdogReason === 'lost-edit' ? 'Dismiss' : 'Retry save'}
      </Button>
    </div>
  ) : null;

  /** Diverged banner (B4): a 409 means the document changed elsewhere. No
   *  silent overwrite — explicit Reload or Save as copy. */
  // A save conflict is a choice between two versions, not an error: neutral, not destructive red.
  // The dialog and this bar offer the same two buttons: the dialog is the one place while it is open, and this bar is
  // the way back to the choice once it was dismissed.
  const conflictBanner = chrome.isConflictExhausted && !conflict.isOpen ? (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-3 py-2 text-sm text-foreground"
    >
      <span>{TIMELINE_CONFLICT_SENTENCE}</span>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => void chrome.reloadFromServer()}>
          {TIMELINE_CONFLICT_USE_LATEST}
        </Button>
        <Button type="button" size="sm" onClick={chrome.retrySaveAfterConflict}>
          {TIMELINE_CONFLICT_KEEP_MINE}
        </Button>
      </div>
    </div>
  ) : null;

  /** Schema rejection banner: the server could not validate the payload.
   *  Freeze autosave until the user explicitly adopts the server version. */
  const incompatibleBanner = chrome.schemaIncompatible ? (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <span>
        The timeline could not be saved because the payload is incompatible with the server schema.
        {chrome.schemaIncompatible.length > 0 && (
          <span className="ml-2 text-xs opacity-80">
            {chrome.schemaIncompatible.map((issue) => {
              const location = issue.pointer ? ` at ${issue.pointer}` : '';
              const detail = issue.message ? `: ${issue.message}` : '';
              return `${issue.code ?? 'schema_error'}${location}${detail}`;
            }).join('; ')}
          </span>
        )}
      </span>
      <Button type="button" size="sm" variant="outline" onClick={() => void chrome.reloadFromServer()}>
        Reload
      </Button>
    </div>
  ) : null;

  /** Recovery draft banner (B9): a previous session left unsaved work in the
   *  one-slot draft. Offer Retry (re-POST the draft) or Discard. */
  const recoveryBanner = chrome.recoveryDraft && !conflict.isOpen && !chrome.isConflictExhausted ? (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <span>
        You have unsaved changes from {formatDraftTime(chrome.recoveryDraft.updatedAt)}.
        {chrome.recoveryDraft.retryAllowed === false && ' The original editing head is unknown. This draft is preserved; discard it or resolve it explicitly before saving.'}
      </span>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={chrome.recoveryDraft.retryAllowed === false} onClick={() => void chrome.retryRecoveredDraft()}>
          Save them
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void chrome.discardRecoveredDraft()}>
          Discard
        </Button>
      </div>
    </div>
  ) : null;

  /** The timeline region, contained so a render throw under it cannot take the
   *  toolbar (and therefore undo) down with it. Shared by all three layout
   *  branches — the boundary is per-branch instance, which is what we want: a
   *  layout switch re-mounts the timeline anyway.
   *
   *  A *load* failure cannot reach that boundary (it happens before the first
   *  render, so nothing throws during rendering); it takes the explicit branch
   *  below, which is the only thing standing between a malformed backend
   *  payload and a blank editor whose badge claims `saved`. */
  const timelineRegion = (
    <>
      {conflictBanner}
      {incompatibleBanner}
      {watchdogBanner}
      {recoveryBanner}
      {chrome.loadError && !(recoveryCardShowing && hasLoadedTimeline) ? (
        // The hosted build's "Astrid stopped" / "restarted" card already says what to do about the same failure.
        recoveryCardShowing ? null : <TimelineLoadErrorCard message={chrome.loadError.message} onRetry={chrome.retryLoad} />
      ) : (
        <TimelineErrorBoundary>
          {renderTimeline
            ? renderTimeline({
              onOpenSequenceCreator: () => openElementCreationPrompt(CREATE_ANIMATION_PROMPT),
              onOpenElementCreationPrompt: openElementCreationPrompt,
              onOpenExtensionManager: openExtensionManager,
            })
            : <TimelineEditor
              onOpenSequenceCreator={() => openElementCreationPrompt(CREATE_ANIMATION_PROMPT)}
              onOpenElementCreationPrompt={openElementCreationPrompt}
              onOpenExtensionManager={openExtensionManager}
            />}
        </TimelineErrorBoundary>
      )}
    </>
  );

  const previewPortal = previewSurface.portal;

  return (
    <>
      <div ref={setShellRoot} data-video-editor-instance={runtime.instanceScope?.instanceId ?? ''} tabIndex={-1} onFocusCapture={activateInstance} onPointerDownCapture={() => {
        activateInstance();
        if (!outerRef.current?.contains(document.activeElement)) outerRef.current?.focus({ preventScroll: true });
      }} className={cn(
        'relative flex h-full w-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden bg-transparent text-foreground',
        // The page draws edge to edge (viewport-fit=cover): keep touch chrome clear of the notch and rounded corners.
        mobileSinglePane && 'pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]',
      )}>
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {interactionStatusLabel}
        </div>
        {/* Until the first load answers, the boot screen (or the connection panel on its way out) stays over the
            editor, so it opens on the timeline rather than on empty panes (`bootLayer.ts`). */}
        {holdsBoot && <span data-boot-hold="" hidden />}
        {headerSlot ?? (showHeader ? (
          <AppHeader
            navigationMode={navigationMode}
            onNavigate={onNavigateHome}
            navigationControls={headerNavigationControls}
          />
        ) : null)}

        {mobileSinglePane ? (
          <main
            data-layout-settling={layoutSettling ? '' : undefined}
            data-shell-layout="touch"
            className={cn(
              'relative grid h-full w-full min-h-0 min-w-0 max-w-full flex-1 duration-200 motion-reduce:animate-none motion-reduce:transition-none gap-3 overflow-x-clip p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-opacity [@media(orientation:landscape)_and_(max-height:500px)]:gap-2',
              shellEntrance,
              hasActivityRegion ? TOUCH_GRID_WITH_ACTIVITY : TOUCH_GRID,
            )}
          >
            <div className="min-w-0 [grid-area:toolbar]">
              {toolbar}
            </div>

            {/* Extension activity region — only mounted when it has content. */}
            {hasActivityRegion && <div className="min-w-0 [grid-area:activity]">{activityRegion}</div>}

            <div className="flex min-h-0 min-w-0 flex-col gap-2 [grid-area:preview]">
              {/* The shared Video | Inspector | Extensions surface occupies the picture area.
                  Its retained Video slot keeps the portalled player mounted. Stacked: the tab
                  row sits above a box in the film's own shape (see the dock's `touch`), as wide
                  as the column allows while at most 42dvh tall, centred; never narrower than
                  20rem, so a tall film still leaves room for the tabs and the Inspector.
                  Short landscape: fills the column beside the timeline. */}
              <div
                className="relative mx-auto w-[min(100%,max(20rem,calc(42dvh*var(--film-aspect))))] [@media(orientation:landscape)_and_(max-height:500px)]:min-h-0 [@media(orientation:landscape)_and_(max-height:500px)]:w-full [@media(orientation:landscape)_and_(max-height:500px)]:flex-1"
                style={{ '--film-aspect': String(aspectRatio) } as CSSProperties}
              >
                <VideoEditorRightPanelDock
                  leftPanelPresent={false}
                  touch
                  video={{
                    activeTab: condensedRightPanel,
                    onTabChange: setCondensedRightPanel,
                    content: <div className="relative min-h-0 flex-1" style={VIDEO_EDITOR_THEME_VARS} {...shellRegionAttrs('preview')}>
                      <PreviewPanel surface={previewPanelSurface} panelClassName="rounded-none border-0 bg-transparent" surfaceClassName="bg-[var(--video-editor-stage-bg)]" />
                    </div>,
                  }}
                  onOpenExtensionManager={openExtensionManager}
                  extensionManagerOpen={isExtensionManagerOpen}
                />
              </div>
              {/* Undo, redo, the readout and the scrubber, under the picture they change. */}
              <div className="-ml-3 flex min-h-11 min-w-0 items-center gap-1" data-testid="touch-playback-row">
                <TimelineUndoRedo buttonClassName="h-11 w-11 shrink-0 text-muted-foreground" iconClassName="h-4 w-4" />
                <span className="shrink-0 pl-1 font-mono text-[11px] tabular-nums tracking-[0.08em] text-muted-foreground">
                  <PlaybackTimecode />
                </span>
                <div className="min-w-0 flex-1 px-3">
                  <PlaybackSlider max={Math.max(1, totalSeconds)} onUserSeek={showVideoForUserSeek} />
                </div>
              </div>
            </div>

            <div className="relative min-h-0 min-w-0 overflow-hidden [grid-area:timeline]" onClick={openInspectorFromTap}>
              {timelineRegion}
            </div>

            {/* The touch shell's way to Astrid and to what goes into the film (gallery
                media): a bar at the thumb, in place of the app's floating pane tabs
                (see paneControlsHost). While Astrid answers, the bar says so. */}
            <div className="flex min-w-0 items-center gap-2 [grid-area:agent]" data-testid="touch-agent-bar">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className={THUMB_BAR_CIRCLE_CLASS}
                onClick={() => dispatchAppEvent('openGenerationsPane')}
                aria-label="Open gallery"
                title="Gallery"
              >
                <Images className="h-4 w-4" />
              </Button>
              <button
                type="button"
                className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border border-border bg-card/95 px-4 text-left text-sm text-muted-foreground shadow-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={openAgentComposer}
              >
                {agentWorking ? (
                  <>
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
                    <span className="truncate text-foreground" role="status">Astrid is working…</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    <span className="truncate">Ask Astrid…</span>
                  </>
                )}
              </button>
            </div>
          </main>
        ) : condensed ? (
          <main
            data-layout-settling={layoutSettling ? '' : undefined}
            className={cn(
              'relative grid h-full w-full min-h-0 min-w-0 max-w-full flex-1 duration-200 motion-reduce:animate-none motion-reduce:transition-none gap-y-3 overflow-x-clip p-3 transition-opacity',
              shellEntrance,
              hasActivityRegion ? 'grid-rows-[auto_auto_minmax(0,1fr)]' : 'grid-rows-[auto_minmax(0,1fr)]',
            )}
            style={{
              ...mainPadding,
              gridTemplateColumns: 'minmax(0,1fr) minmax(0, calc(min(360px, 32vw, calc(100vw - 24px)) + 12px))',
            }}
          >
            <div style={{ gridColumn: 1, gridRow: 1 }}>
              {toolbarSlot ?? toolbar}
            </div>

            {/* Extension activity region — only mounted when it has content. */}
            {hasActivityRegion && <div style={{ gridColumn: 1, gridRow: 2 }}>{activityRegion}</div>}

            <div className="relative min-h-0 min-w-0 overflow-hidden" {...shellRegionAttrs('timeline')} style={{ gridColumn: 1, gridRow: hasActivityRegion ? 3 : 2 }}>
              {timelineRegion}
              {timelineFooterSlot}
            </div>

            <VideoEditorRightPanelDock
              key="video-editor-right-panel-dock"
              leftPanelPresent={false}
              video={{
                activeTab: condensedRightPanel,
                onTabChange: setCondensedRightPanel,
                content: <>
                  {/* One continuous stage: letterbox bars share the frame's
                      black instead of showing slivers of panel. */}
                  <div className="relative min-h-0 flex-1 bg-[var(--video-editor-stage-bg)]" style={VIDEO_EDITOR_THEME_VARS} {...shellRegionAttrs('preview')} {...{ [EDITOR_TOUR_ANCHOR_ATTRIBUTE]: EDITOR_TOUR_ANCHORS.preview }}>
                    {previewOverlay}
                    <div ref={previewSurface.slotRef} data-testid="video-editor-preview-surface" className="flex h-full w-full min-h-0 items-center justify-center" />
                  </div>
                  {/* Pointer layouts scrub on the adjacent timeline, as the
                      main preview does; touch keeps a larger scrub target. */}
                  {touchChrome && <div className="shrink-0 border-t border-border px-3 py-2">
                    <PlaybackSlider max={Math.max(1, totalSeconds)} />
                  </div>}
                </>,
              }}
              onOpenExtensionManager={openExtensionManager}
              extensionManagerOpen={isExtensionManagerOpen}
            />

          </main>
        ) : (
          <main
            data-layout-settling={layoutSettling ? '' : undefined}
            ref={containerRef}
            className={`video-editor-panel-grid relative grid h-full min-h-0 flex-1 ${shellEntrance} motion-reduce:animate-none motion-reduce:transition-none gap-3 p-3 transition-[grid-template-columns,grid-template-rows] duration-200 ease-out`}
            style={{
              gridTemplateRows,
              gridTemplateColumns: hasCustomRightPanelSlot
                ? (leftPanelSlot ? 'auto minmax(0,1fr) 360px' : 'minmax(0,1fr) 360px')
                : `${leftPanelSlot ? 'auto ' : ''}minmax(0,1fr) ${showFullHeightHostDock || showCompactHostDock
                  ? 'minmax(0, calc(min(360px, 32vw, calc(100vw - 24px)) + 12px))'
                  : 'minmax(0, 0px)'}`,
              // Keep the trailing track in both states so CSS can interpolate
              // its width. Its 12px gutter is inside the track, not a phantom
              // column gap left behind when the track reaches zero.
              columnGap: hasCustomRightPanelSlot ? undefined : 0,
              ...mainPadding,
            }}
          >
            {/* Left panel surface slot — host-owned placement */}
            {leftPanelSlot && (
              <div
                className="row-span-2 min-h-0 w-14 overflow-hidden"
                style={{ marginInlineEnd: hasCustomRightPanelSlot ? undefined : 12 }}
                {...shellRegionAttrs('leftPanel')}
              >
                {leftPanelSlot}
              </div>
            )}

            <div ref={previewAreaRef} className="relative min-h-0" {...shellRegionAttrs('preview')} style={{ gridColumn: leftPanelSlot ? '2' : '1', gridRow: '1' }}>
              {previewOverlay}
              <PreviewPanel surface={previewPanelSurface} />
            </div>

            {hasCustomRightPanelSlot && (
              <div className="row-span-2 min-h-0 overflow-hidden" {...shellRegionAttrs('rightPanel')}>
                {rightPanelSlot ?? inspectorPanelSlot ?? <PropertiesPanel />}
              </div>
            )}

            <div ref={dividerRef} className="video-editor-panel-work-area min-w-0" style={{ gridRow: 2, gridColumn: hasCustomRightPanelSlot ? (leftPanelSlot ? '2' : '1') : workAreaGridColumn, marginInlineEnd: hasCustomRightPanelSlot ? undefined : hostPanelInset }}>
              {toolbarSlot ?? toolbar}
            </div>

            {/* Extension activity region — between toolbar and timeline */}
              {hasActivityRegion && (
              <div className="video-editor-panel-work-area min-w-0" style={{ gridRow: 3, gridColumn: workAreaGridColumn, marginInlineEnd: hasCustomRightPanelSlot ? undefined : hostPanelInset }}>
                {activityRegion}
              </div>
            )}

            <div ref={timelineRef} className="video-editor-panel-work-area relative min-h-0 min-w-0 overflow-hidden" {...shellRegionAttrs('timeline')} style={{ gridRow: hasActivityRegion ? 4 : 3, gridColumn: workAreaGridColumn, marginInlineEnd: hasCustomRightPanelSlot ? undefined : hostPanelInset }}>
              {timelineRegion}
              {timelineFooterSlot}
            </div>

            <VideoEditorRightPanelDock
              key="video-editor-right-panel-dock"
              leftPanelPresent={Boolean(leftPanelSlot)}
              enabled={!hasCustomRightPanelSlot}
              compactDock={rightPanelLayout === 'compact'}
              measuredHeight={rightPanelLayout === 'compact' ? panelHeights.compact : panelHeights.full}
              onOpenExtensionManager={openExtensionManager}
              extensionManagerOpen={isExtensionManagerOpen}
            />

          </main>
        )}
        {/* Extension strips remain desktop surfaces; touch panels live in Extensions. */}
        {!mobileSinglePane && statusBarSlot}

        {!mobileSinglePane && reservedSlots}
      </div>
      {previewPortal}
      {/* Extension-contributed dialog slot */}
      {dialogsSlot}
      <Dialog open={isExtensionManagerOpen} onOpenChange={setIsExtensionManagerOpen}>
        <DialogContent className="max-h-[85dvh] overflow-auto">
          <DialogHeader><DialogTitle>Extensions</DialogTitle></DialogHeader>
          <ExtensionManager />
        </DialogContent>
      </Dialog>

      {/* Host command palette overlay — only mount when open to avoid
          unnecessary context lookups that break in tests without providers. */}
      {isCommandPaletteOpen && (
        <CommandPalette
          open={isCommandPaletteOpen}
          onOpenChange={setIsCommandPaletteOpen}
        />
      )}

      <AlertDialog open={conflict.isOpen} onOpenChange={conflict.setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>This timeline changed somewhere else</AlertDialogTitle>
            <AlertDialogDescription>{TIMELINE_CONFLICT_SENTENCE}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => void conflict.discardAndReload()}>{TIMELINE_CONFLICT_USE_LATEST}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void conflict.keepLocalChanges()}>{TIMELINE_CONFLICT_KEEP_MINE}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export const TimelineEditorShellCore = memo(TimelineEditorShellCoreComponent);

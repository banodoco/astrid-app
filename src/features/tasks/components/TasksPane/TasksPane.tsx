import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { shallow } from 'zustand/shallow';
import { useRenderLogger } from '@/shared/lib/debug/debugRendering';
import { TaskList } from './TaskList';
import { RuntimeTaskList } from './RuntimeTaskList';
import { RuntimeActivityDock, type RuntimeTaskInspectionRequest } from './RuntimeActivityDock';
import { cn } from '@/shared/components/ui/contracts/cn';
import { Button } from '@/shared/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip';
import { ListTodo, Loader2, Lock, MessageSquareText, Mic, Square, Unlock } from 'lucide-react';
import { CHAT_VOICE_ENABLED } from '@/tools/video-editor/hooks/chatVoice';
import { PaneControlTab } from '@/shared/components/PaneControlTab';
import { useAgentChatActions, useOptionalAgentChatBridge } from '@/shared/contexts/AgentChatContext';
import { AgentChatPanel } from '@/tools/video-editor/components/AgentChat';
import { useProjectAgentTaskLinks } from '@/tools/video-editor/hooks/useAgentSession';
import { useProjectCrudContext, useProjectSelectionContext } from '@/shared/contexts/ProjectContext';
import { useIncomingTasks } from '@/shared/contexts/IncomingTasksContext';
import { useBottomOffset } from '@/shared/hooks/layout/useBottomOffset';
import { MediaLightbox } from '@/domains/media-lightbox/MediaLightbox';
import { useShots } from '@/shared/contexts/ShotsContext';
import { useLastAffectedShot } from '@/shared/hooks/shots/useLastAffectedShot';
import { useCurrentShot } from '@/shared/state/selectionStore';
import { usePaneInteractionLifecycle } from '@/shared/components/panes/usePaneInteractionLifecycle';
import { PaneBackdrop } from '@/shared/components/panes/PaneBackdrop';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectSeparator } from '@/shared/components/ui/select';

// Import from new modules
import { STATUS_GROUPS, type FilterGroup } from './constants';
import { PaginationControls } from './components/PaginationControls';
import { TasksPaneSurface, TasksPaneChatSlot } from './components/TasksPaneSurface';
import { useTasksLightbox } from './hooks/useTasksLightbox';
import { useShotActions } from './hooks/useShotActions';
import { useTasksPaneController } from './hooks/useTasksPaneController';
import { runtimeTaskStatusGroup } from './hooks/useRuntimeTasks';
import { useTasksPaneSlidingPane } from './hooks/useTasksPaneSlidingPane';
import { useRenderBudget } from '@/shared/dev/useRenderBudget';
import { UI_Z_LAYERS } from '@/shared/lib/uiLayers';
import { usePanesStore } from '@/shared/state/panesStore';
import { usePaneControlsHosted } from '@/shared/state/paneControlsHost';
import { isElementWithinKnownOverlay } from '@/shared/components/ui/overlay';
import { tasksPaneExpandedHalf, tasksPaneRuntimeHistoryPinned } from '@/shared/settings/declarations';
import { useSetting } from '@/shared/settings/useSetting';
import { useAppEventListener } from '@/shared/lib/typedEvents';

type ExpandedHalf = 'chat' | null;

/** How long the temporary history peek survives the pointer or focus leaving it. */
const RUNTIME_PEEK_CLOSE_GRACE_MS = 150;

const TasksPaneComponent: React.FC = () => {
  useRenderBudget('TasksPane', 5);
  const { pathname, search } = useLocation();
  const paneControlsHosted = usePaneControlsHosted();
  const selectedEditor = useOptionalAgentChatBridge()?.editorContext;
  const runtimeProjectId = selectedEditor?.projectId ?? null;
  const runtimeTimelineId = selectedEditor?.projectId ? selectedEditor.timelineId : null;
  const {
    isTasksPaneLocked,
    setIsTasksPaneLocked,
    tasksPaneWidth,
    activeTaskId,
    setActiveTaskId,
    isTasksPaneOpenProgrammatic,
    setIsTasksPaneOpenProgrammatic,
  } = usePanesStore((state) => ({
    isTasksPaneLocked: state.isTasksPaneLocked,
    setIsTasksPaneLocked: state.setIsTasksPaneLocked,
    tasksPaneWidth: state.tasksPaneWidth,
    activeTaskId: state.activeTaskId,
    setActiveTaskId: state.setActiveTaskId,
    isTasksPaneOpenProgrammatic: state.isTasksPaneOpen,
    setIsTasksPaneOpenProgrammatic: state.setIsTasksPaneOpen,
  }), shallow);

  // Project context & task helpers
  const { selectedProjectId } = useProjectSelectionContext();
  const { projects } = useProjectCrudContext();

  // Shots data for lightbox
  // Read shots from the context. This pane is mounted in the global shell, so
  // it must not call the relational shots query directly.
  const { shots } = useShots();
  const { currentShotId } = useCurrentShot();
  const { lastAffectedShotId } = useLastAffectedShot();

  // Get incoming/placeholder tasks for count calculation + cancellation
  const { incomingTasks, cancelAllIncoming } = useIncomingTasks();

  const {
    selectedFilter,
    selectedTaskType,
    projectScope,
    currentPage,
    mobileActiveTaskId,
    setProjectScope,
    setMobileActiveTaskId,
    handleFilterChange,
    handleTaskTypeChange,
    handlePageChange,
    handleCancelAllPending,
    isCancelAllPending,
    paginatedData,
    isPaginatedLoading,
    displayStatusCounts,
    isStatusCountsDegraded,
    failedStatusQueries,
    taskTypeOptions,
    totalTasks,
    totalPages,
    cancellableTaskCount,
    isAllProjectsMode,
    projectNameMap,
    isRuntimeMode,
    runtimeTaskData,
    runtimeActivityTasks,
    runtimeTaskError,
    runtimeTaskActionError,
    runtimeTaskActions,
  } = useTasksPaneController({
    selectedProjectId,
    runtimeProjectId,
    projects,
    incomingTasks,
    cancelAllIncoming,
  });
  const isToolRoute = pathname.startsWith('/tools') || pathname === '/shots' || pathname === '/art';
  const isRuntimeActivityDock = isRuntimeMode && isToolRoute && Boolean(runtimeProjectId);
  const agentTaskLinks = useProjectAgentTaskLinks(isRuntimeActivityDock ? runtimeProjectId : null);

  // Simplified shot options for MediaLightbox
  const simplifiedShotOptions = useMemo(() => shots?.map(s => ({ id: s.id, name: s.name })) || [], [shots]);

  // Use extracted lightbox hook
  const {
    lightboxData,
    lightboxSelectedShotId,
    setLightboxSelectedShotId,
    taskDetailsData,
    lightboxProps,
    handleOpenImageLightbox,
    handleOpenVideoLightbox,
    handleCloseLightbox,
    handleOpenExternalGeneration,
  } = useTasksLightbox({
    selectedProjectId,
    currentShotId,
    lastAffectedShotId,
    setActiveTaskId,
    setIsTasksPaneOpen: setIsTasksPaneOpenProgrammatic,
  });

  // Use extracted shot actions hook
  const {
    optimisticPositionedIds,
    optimisticUnpositionedIds,
    handleAddToShot,
    handleAddToShotWithoutPosition,
    handleOptimisticPositioned,
    handleOptimisticUnpositioned,
  } = useShotActions({
    lightboxSelectedShotId,
    currentShotId,
    lastAffectedShotId,
    selectedProjectId,
  });

  useRenderLogger('TasksPane', { cancellableCount: cancellableTaskCount });

  const [agentSessionSelectorOpen, setAgentSessionSelectorOpen] = useState(false);
  const { isLocked, isOpen, toggleLock, openPane, paneProps, transformClass, handlePaneEnter, handlePaneLeave, showBackdrop, closePane } = useTasksPaneSlidingPane({
    isTasksPaneLocked,
    setIsTasksPaneLocked,
    isTasksPaneOpenProgrammatic,
    setIsTasksPaneOpenProgrammatic,
    overlayOpen: agentSessionSelectorOpen,
  });

  const { isPointerEventsEnabled } = usePaneInteractionLifecycle({
    isOpen: Boolean(isOpen),
  });

  // Adapter boundary: AgentChatPanel remains app-owned in TasksPane
  // instead of moving into the editor shell. The core talks to chat through
  // registration bridges; this pane still owns when chat is mounted and how the
  // composer-button affordance drives it on Astrid App routes.
  // Agent chat lives inside the action pane only on tool routes (where a timeline
  // makes sense). On other routes the pane is task-only.
  // null until AgentChatPanel mounts and registers; the composer button stays hidden
  // until then so it can't be clicked before its handlers exist.
  const agentChatActions = useAgentChatActions();
  const readyAgentChatActions = isToolRoute ? agentChatActions : null;

  // Keep the established stored preference: chat = compact tasks; split =
  // tasks pinned at their normal half-height. Legacy tasks-full maps to split.
  const [savedExpandedHalf, saveExpandedHalf] = useSetting(tasksPaneExpandedHalf);
  const expandedHalf: ExpandedHalf = savedExpandedHalf === 'chat' ? 'chat' : null;
  const setExpandedHalf = useCallback((next: ExpandedHalf) => saveExpandedHalf(next === 'chat' ? 'chat' : 'split'), [saveExpandedHalf]);
  const [runtimeHistoryPinned, setRuntimeHistoryPinned] = useSetting(tasksPaneRuntimeHistoryPinned);
  const [runtimeHistoryOpen, setRuntimeHistoryOpen] = useState(runtimeHistoryPinned);
  const [runtimeTaskInspectionRequest, setRuntimeTaskInspectionRequest] = useState<RuntimeTaskInspectionRequest | null>(null);
  const clearRuntimeTaskInspectionRequest = useCallback(() => setRuntimeTaskInspectionRequest(null), []);
  const showChatHalf = isToolRoute;
  const [isTasksPeeking, setIsTasksPeeking] = useState(false);
  const compactTasks = isToolRoute;
  const isTasksPinned = isRuntimeActivityDock ? runtimeHistoryPinned : expandedHalf === null;
  const showTasksHalf = isRuntimeActivityDock
    ? runtimeHistoryOpen
    : !isToolRoute || isTasksPinned || isTasksPeeking;
  const toggleTasksPinned = () => setExpandedHalf(isTasksPinned ? 'chat' : null);
  const toggleRuntimeHistoryPinned = () => {
    cancelPeekClose();
    const nextPinned = !runtimeHistoryPinned;
    setRuntimeHistoryPinned(nextPinned);
    if (nextPinned) setRuntimeHistoryOpen(true);
  };
  const toggleRuntimeHistoryOpen = () => {
    if (runtimeHistoryOpen) {
      setRuntimeHistoryOpen(false);
      return;
    }
    const latestTask = [...runtimeActivityTasks].sort((left, right) =>
      Date.parse(right.updated_at || right.created_at) - Date.parse(left.updated_at || left.created_at),
    )[0];
    if (latestTask) handleFilterChange(runtimeTaskStatusGroup(latestTask));
    setRuntimeHistoryOpen(true);
  };
  // The temporary peek closes a beat after the pointer or focus leaves the dock-and-history
  // container, so crossing a gap or a diagonal to the inspector does not drop it.
  const peekCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPeekClose = useCallback(() => {
    if (peekCloseTimer.current === null) return;
    clearTimeout(peekCloseTimer.current);
    peekCloseTimer.current = null;
  }, []);
  useEffect(() => cancelPeekClose, [cancelPeekClose]);
  const leaveTemporaryRuntimeHistory = (event: React.MouseEvent | React.FocusEvent) => {
    if (runtimeHistoryPinned) return;
    const next = event.relatedTarget;
    if (event.type === 'blur' && !(next instanceof Element)) return;
    cancelPeekClose();
    if (next instanceof Element && (
      next.closest('[data-runtime-peek-container]')
      || next.closest('[data-activity-inspector]')
      || isElementWithinKnownOverlay(next)
    )) return;
    peekCloseTimer.current = setTimeout(() => {
      peekCloseTimer.current = null;
      setRuntimeHistoryOpen(false);
    }, RUNTIME_PEEK_CLOSE_GRACE_MS);
  };
  useEffect(() => { setIsTasksPeeking(false); }, [expandedHalf, isOpen]);
  useEffect(() => { setAgentSessionSelectorOpen(false); }, [pathname, runtimeProjectId]);
  const leaveTaskPeek = (event: React.MouseEvent | React.FocusEvent) => {
    if (event.relatedTarget instanceof Element && (
      event.relatedTarget.closest('[data-task-peek-surface]')
      || isElementWithinKnownOverlay(event.relatedTarget)
    )) return;
    setIsTasksPeeking(false);
  };

  // Open the pane on the chat with the composer focused: the tab's message
  // button, and pages that host their own entry point (`openAgentComposer`).
  const openAgentComposer = useCallback(() => {
    // markEngaged signals the auto-create-session gate inside the panel
    // WITHOUT writing to panesStore.isTasksPaneOpen (which would
    // short-circuit useSlidingPane.setOpen(false)).
    readyAgentChatActions?.markEngaged();
    openPane();
    // Focus inside the tap: iOS raises the keyboard only for a focus made while handling
    // the gesture. The next frame tries again for a composer the open has just enabled.
    // focusComposer is ref-backed, so a panel that unmounts meanwhile makes it a no-op.
    if (readyAgentChatActions) {
      readyAgentChatActions.focusComposer();
      requestAnimationFrame(() => readyAgentChatActions.focusComposer());
    }
  }, [openPane, readyAgentChatActions]);
  useAppEventListener('openAgentComposer', openAgentComposer);

  return (
    <>
      {/* Backdrop overlay for mobile - z-index just below TasksPane content (100016) */}
      <PaneBackdrop show={showBackdrop} zIndex={100000} onClose={closePane} />
      
      <PaneControlTab
        position={{ side: "right", paneDimension: tasksPaneWidth, bottomOffset: useBottomOffset() }}
        state={{ isLocked, isOpen: !!isOpen }}
        handlers={{ toggleLock, openPane, handlePaneEnter, handlePaneLeave }}
        display={{ paneIcon: "tasks", paneTooltip: "Open Action pane", allowMobileLock: true, shortcutHint: '⌥D' }}
        actions={{
          thirdButton: {
            onClick: openPane,
            ariaLabel: `Open Action pane (${cancellableTaskCount} active tasks)`,
            content: <span className="text-xs font-light">{cancellableTaskCount}</span>,
            tooltip: `${cancellableTaskCount} active task${cancellableTaskCount === 1 ? '' : 's'}`,
          },
          composerButton: readyAgentChatActions
            ? {
                onClick: openAgentComposer,
                ariaLabel: 'Open message composer',
                tooltip: 'Open message',
                content: <MessageSquareText className="h-4 w-4" />,
                // Chat voice is switched off: the cell shows only Message.
                secondary: CHAT_VOICE_ENABLED
                  ? {
                      onClick: () => readyAgentChatActions.toggleRecording(),
                      ariaLabel: readyAgentChatActions.isRecording ? 'Stop recording' : 'Start voice recording',
                      tooltip: readyAgentChatActions.isRecording ? 'Stop' : 'Voice (⌘⇧R)',
                      content: readyAgentChatActions.isRecording
                        ? <Square className="h-4 w-4" />
                        : <Mic className="h-4 w-4" />,
                    }
                  : undefined,
              }
            : undefined,
        }}
      />
      
      <div
        className="pointer-events-none"
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          bottom: 0,
          // A page that hosts the pane (the touch editor) opens it as a temporary sheet: wide
          // enough to read and type in (a 300px drawer is a slot on an iPad or a phone on its
          // side), with a strip of the page left to tap to close it.
          width: paneControlsHosted ? 'min(28rem, calc(100vw - 3rem))' : `${tasksPaneWidth}px`,
          // Content must sit above MediaLightbox and GenerationsPane; see UI_Z_LAYERS.
          zIndex: UI_Z_LAYERS.TASKS_PANE_CONTENT,
        }}
      >
        <TasksPaneSurface {...paneProps}
          className={cn('absolute top-0 right-0 transform transition-transform duration-300 ease-smooth', transformClass)}
        >
          {/* The pane-open-transition pointer-events gate is applied only to
              the tasks half (the original gated content). The chat half is the
              former popup — it lived outside the pane and was never gated, so
              we keep it always interactive to preserve that. Otherwise the
              attachment X buttons drop clicks during the 300ms slide-in. */}
          <div
            className="relative flex flex-col h-full"
            onPointerDownCapture={(event) => {
              if (event.target instanceof Element && !event.target.closest('[data-task-peek-surface]') && !isElementWithinKnownOverlay(event.target)) setIsTasksPeeking(false);
            }}
          >
            <div
              className="contents"
              data-runtime-peek-container={isRuntimeActivityDock ? 'true' : undefined}
              onMouseEnter={isRuntimeActivityDock ? cancelPeekClose : undefined}
              onFocus={isRuntimeActivityDock ? cancelPeekClose : undefined}
              onMouseLeave={isRuntimeActivityDock ? leaveTemporaryRuntimeHistory : undefined}
              onBlur={isRuntimeActivityDock ? leaveTemporaryRuntimeHistory : undefined}
            >
            {isRuntimeActivityDock && runtimeProjectId ? (
              <RuntimeActivityDock
                projectId={runtimeProjectId}
                timelineId={runtimeTimelineId}
                tasks={runtimeActivityTasks}
                links={agentTaskLinks.data ?? []}
                isLoading={isPaginatedLoading}
                error={runtimeTaskError}
                actionError={runtimeTaskActionError}
                isPinned={isTasksPinned}
                isHistoryOpen={runtimeHistoryOpen}
                onTogglePinned={toggleRuntimeHistoryPinned}
                onToggleHistory={toggleRuntimeHistoryOpen}
                onOpenHistory={() => {
                  const latestTask = [...runtimeActivityTasks].sort((left, right) =>
                    Date.parse(right.updated_at) - Date.parse(left.updated_at),
                  )[0];
                  if (latestTask) handleFilterChange(runtimeTaskStatusGroup(latestTask));
                  setRuntimeHistoryOpen(true);
                }}
                requestedTaskInspection={runtimeTaskInspectionRequest}
                onTaskInspectionRequestHandled={clearRuntimeTaskInspectionRequest}
                onCancelTask={runtimeTaskActions.cancelTask}
                onRetryTask={runtimeTaskActions.retryTask}
                isTaskActionPending={runtimeTaskActions.isTaskActionPending}
                onExportManagedOutput={runtimeTaskActions.exportManagedOutput}
                isExportTaskPending={runtimeTaskActions.isExportTaskPending}
              />
            ) : compactTasks && (
              <div
                data-task-peek-surface="header"
                role="region"
                aria-label="Tasks"
                className="group/tasks-header z-30 flex h-20 shrink-0 flex-col justify-center gap-1 border-b border-sidebar-border/70 bg-sidebar/80 px-2 py-2"
                onMouseEnter={() => setIsTasksPeeking(true)}
                onMouseLeave={leaveTaskPeek}
                onFocus={() => setIsTasksPeeking(true)}
                onBlur={leaveTaskPeek}
              >
                <div className="flex h-6 items-center justify-between pl-1">
                  <h2 className="flex items-center gap-1.5 text-xs font-medium text-sidebar-foreground">
                    <ListTodo className="h-3.5 w-3.5 text-sidebar-foreground/70" aria-hidden="true" />
                    Tasks
                  </h2>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 text-sidebar-foreground/70 opacity-0 transition-opacity [&_svg]:size-3 group-hover/tasks-header:opacity-100 group-focus-within/tasks-header:opacity-100 focus-visible:opacity-100"
                    aria-label={isTasksPinned ? 'Unlock tasks' : 'Lock tasks open'}
                    aria-pressed={isTasksPinned}
                    title={isTasksPinned ? 'Unlock tasks' : 'Lock tasks open'}
                    onClick={toggleTasksPinned}
                  >
                    {isTasksPinned ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                  </Button>
                </div>
                <div className="flex items-center gap-1 rounded-md bg-sidebar-accent/40 p-0.5">
                {(['Processing', 'Succeeded', 'Failed'] as FilterGroup[]).map((filter) => {
                  const count = filter === 'Processing' ? cancellableTaskCount
                    : filter === 'Succeeded' ? (displayStatusCounts?.recentSuccesses ?? 0)
                      : (displayStatusCounts?.recentFailures ?? 0);
                  return (
                    <Button
                      key={filter}
                      variant="ghost"
                      size="sm"
                      aria-pressed={selectedFilter === filter}
                      aria-label={`Show ${filter.toLowerCase()} tasks (${count})`}
                      onClick={() => { handleFilterChange(filter); setIsTasksPeeking(true); }}
                      className={cn('min-w-0 flex-1 gap-1 px-1 text-[11px]', selectedFilter === filter ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/70')}
                    >
                      <span className="truncate">{filter}</span>
                      <span className="tabular-nums opacity-70">({count})</span>
                    </Button>
                  );
                })}
                </div>
              </div>
            )}
            {/* Header plus task body reserve exactly half the pane while
                peeking or pinned, so chat resizes without being remounted. */}
            {showTasksHalf && (
            <div
              data-task-peek-surface="tasks"
              onMouseEnter={() => { if (compactTasks) setIsTasksPeeking(true); }}
              onMouseLeave={leaveTaskPeek}
              onFocus={() => { if (compactTasks) setIsTasksPeeking(true); }}
              onBlur={leaveTaskPeek}
              className={cn(
              'min-h-0 flex flex-col overflow-hidden',
              isToolRoute
                ? isRuntimeActivityDock
                  ? 'relative h-[calc(50%_-_3rem)] shrink-0 bg-sidebar'
                  : 'relative h-[calc(50%_-_5rem)] shrink-0 bg-sidebar'
                : 'relative flex-1',
              isPointerEventsEnabled ? 'pointer-events-auto' : 'pointer-events-none'
            )}>
            {isRuntimeActivityDock && !isPaginatedLoading && runtimeActivityTasks.length === 0 && runtimeTaskData?.total === 0 && !runtimeTaskError ? (
              <div className="flex min-h-24 flex-1 items-center justify-center px-4 text-sm text-muted-foreground" role="status" data-testid="runtime-task-history-empty" data-runtime-task-history-empty="true">
                No tasks yet
              </div>
            ) : (
            <>
            {/* Status Filter Toggle — three buttons side-by-side, count inline as (N) so the row never overflows */}
            <div className="p-2 border-b border-sidebar-border flex-shrink-0">
              {(!compactTasks || (isRuntimeActivityDock && isTasksPinned)) && <div className="bg-sidebar-accent rounded-lg p-1">
                <div className="flex gap-1">
                  {(['Processing', 'Succeeded', 'Failed'] as FilterGroup[]).map((filter) => {
                    const count = filter === 'Processing'
                      ? cancellableTaskCount
                      : filter === 'Succeeded'
                        ? (displayStatusCounts?.recentSuccesses || 0)
                        : (displayStatusCounts?.recentFailures || 0);

                    return (
                      <Button
                        key={filter}
                        variant={selectedFilter === filter ? "default" : "ghost"}
                        size="sm"
                        onClick={() => handleFilterChange(filter)}
                        className={cn(
                          "flex-1 text-xs flex items-center justify-center gap-1 px-2 min-w-0",
                          selectedFilter === filter
                            ? "bg-sidebar-primary text-sidebar-primary-foreground md:hover:bg-sidebar-primary/90"
                            : "text-sidebar-foreground/70 md:hover:text-sidebar-foreground md:hover:bg-sidebar-accent"
                        )}
                      >
                        <span className="truncate">{filter}</span>
                        <span className={cn(
                          'font-light tabular-nums',
                          count === 0 ? 'opacity-40' : 'opacity-80'
                        )}>
                          ({count})
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </div>}

              {isStatusCountsDegraded && (
                <p className="mt-2 text-[11px] text-amber-300">
                  Task counters are partially degraded
                  {failedStatusQueries ? ` (${failedStatusQueries})` : ''}.
                </p>
              )}
              
              {/* Task Type + Project Scope Filters */}
              <div className={cn('flex items-center gap-1', (!compactTasks || isRuntimeActivityDock) && 'mt-2')}>
                <Select
                  value={selectedTaskType || 'all'}
                  onValueChange={(value) => handleTaskTypeChange(value === 'all' ? null : value)}
                >
                  <SelectTrigger variant="default" size="sm" className="h-7 !text-xs flex-1 min-w-0">
                    <SelectValue placeholder="All task types" />
                  </SelectTrigger>
                  <SelectContent variant="default">
                    <SelectItem variant="default" value="all" className="!text-xs">All task types</SelectItem>
                    {taskTypeOptions.length > 0 && <SelectSeparator className="bg-border" />}
                    {taskTypeOptions.map((type) => (
                      <SelectItem variant="default" key={type.value} value={type.value} className="!text-xs">
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                
                {isRuntimeMode ? (
                  <div
                    className="flex h-7 min-w-0 flex-1 items-center rounded-md border border-sidebar-border px-2 text-xs text-sidebar-foreground/80"
                    data-runtime-task-project={runtimeProjectId ?? ''}
                    title={runtimeProjectId ?? undefined}
                  >
                    <span className="truncate">Runtime project</span>
                  </div>
                ) : (
                  <Select
                    value={projectScope}
                    onValueChange={(value) => {
                      setProjectScope(value ?? 'current');
                      handlePageChange(1);
                    }}
                  >
                    <SelectTrigger variant="default" size="sm" className="h-7 !text-xs flex-1 min-w-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent variant="default">
                      <SelectItem variant="default" value="current" className="!text-xs">This project</SelectItem>
                      <SelectItem variant="default" value="all" className="!text-xs">All projects</SelectItem>
                      {projects.filter(p => p.id !== selectedProjectId).length > 0 && <SelectSeparator className="bg-border" />}
                      {projects
                        .filter(p => p.id !== selectedProjectId)
                        .sort((a, b) => {
                          const aDate = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                          const bDate = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                          return bDate - aDate;
                        })
                        .map((project) => (
                          <SelectItem variant="default" key={project.id} value={project.id} className="!text-xs">
                            {project.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleCancelAllPending}
                      disabled={isCancelAllPending || cancellableTaskCount === 0}
                      className="h-7 shrink-0 gap-1 px-2 text-[10px]"
                    >
                      {isCancelAllPending && <Loader2 className="h-3 w-3 animate-spin" />}
                      Cancel All
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Cancel all queued tasks</TooltipContent>
                </Tooltip>
              </div>
            </div>

            <PaginationControls
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={handlePageChange}
              totalItems={totalTasks}
              isLoading={isPaginatedLoading}
              filterType={selectedFilter}
              recentCount={
                selectedFilter === 'Succeeded' ? displayStatusCounts?.recentSuccesses :
                selectedFilter === 'Failed' ? displayStatusCounts?.recentFailures :
                undefined
              }
            />

            {/* Task list area — relative wrapper hosts the absolute-positioned
                bottom fade so scrolled-out content visibly trails off rather
                than hard-clipping at the divider. */}
            <div className="relative flex-grow overflow-hidden">
              <div
                className="absolute inset-0 overflow-y-auto"
                data-scroll-lock-scrollable="true"
              >
                {isRuntimeMode ? (
                  <RuntimeTaskList
                    showComplete={isRuntimeActivityDock}
                    tasks={runtimeTaskData?.tasks ?? []}
                    isLoading={isPaginatedLoading}
                    error={runtimeTaskError}
                    actionFailures={runtimeTaskActions.actionFailures}
                    exportedTo={runtimeTaskActions.exportedTo}
                    onDismissActionError={runtimeTaskActions.dismissActionError}
                    onCancelTask={runtimeTaskActions.cancelTask}
                    onRetryTask={runtimeTaskActions.retryTask}
                    isTaskActionPending={runtimeTaskActions.isTaskActionPending}
                    timelineId={runtimeTimelineId}
                    onExportManagedOutput={runtimeTaskActions.exportManagedOutput}
                    isExportTaskPending={runtimeTaskActions.isExportTaskPending}
                    onInspectTask={(taskId, anchor) => setRuntimeTaskInspectionRequest({ taskId, anchor })}
                  />
                ) : (
                <TaskList
                  filterStatuses={STATUS_GROUPS[selectedFilter]}
                  activeFilter={selectedFilter}
                  statusCounts={displayStatusCounts}
                  paginatedData={paginatedData}
                  isLoading={isPaginatedLoading}
                  currentPage={currentPage}
                  activeTaskId={activeTaskId}
                  onOpenImageLightbox={handleOpenImageLightbox}
                  onOpenVideoLightbox={handleOpenVideoLightbox}
                  onCloseLightbox={handleCloseLightbox}
                  mobileActiveTaskId={mobileActiveTaskId}
                  onMobileActiveTaskChange={setMobileActiveTaskId}
                  taskTypeFilter={selectedTaskType ?? undefined}
                  showProjectIndicator={isAllProjectsMode}
                  projectNameMap={projectNameMap}
                />
                )}
              </div>
              {/* Bottom fade — only visible when the chat half sits below */}
              {showChatHalf && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-sidebar via-sidebar/70 to-transparent" />
              )}
            </div>
            </>
            )}
            </div>
            )}
            </div>
            {/* Chat remains mounted while tasks peek, pin, or collapse. */}
            {showChatHalf && (
              <TasksPaneChatSlot>
                <AgentChatPanel
                  isExpanded={!showTasksHalf}
                  onSessionSelectorOpenChange={setAgentSessionSelectorOpen}
                />
              </TasksPaneChatSlot>
            )}
          </div>
        </TasksPaneSurface>
      </div>

      {/* Centralized MediaLightbox */}
      {lightboxData && lightboxProps && createPortal(
        <MediaLightbox
          media={lightboxProps.media}
          onClose={handleCloseLightbox}
          navigation={{
            onNext: lightboxProps.onNext,
            onPrevious: lightboxProps.onPrevious,
            showNavigation: lightboxProps.showNavigation,
            hasNext: lightboxProps.hasNext,
            hasPrevious: lightboxProps.hasPrevious,
          }}
          features={{
            showDownload: true,
            showTaskDetails: true,
          }}
          taskDetailsData={taskDetailsData ?? undefined}
          shotWorkflow={{
            allShots: simplifiedShotOptions,
            selectedShotId: lightboxSelectedShotId || currentShotId || lastAffectedShotId || undefined,
            onShotChange: setLightboxSelectedShotId,
            onAddToShot: handleAddToShot,
            onAddToShotWithoutPosition: handleAddToShotWithoutPosition,
            optimisticPositionedIds,
            optimisticUnpositionedIds,
            onOptimisticPositioned: handleOptimisticPositioned,
            onOptimisticUnpositioned: handleOptimisticUnpositioned,
            onShowTick: async () => {},
          }}
          showTickForImageId={undefined}
          onOpenExternalGeneration={handleOpenExternalGeneration}
          tasksPaneOpen={true}
          tasksPaneWidth={tasksPaneWidth}
          initialVariantId={lightboxProps.initialVariantId}
          videoProps={{ fetchVariantsForSelf: lightboxProps.fetchVariantsForSelf }}
        />,
        document.body
      )}
    </>
  );
};

// Memoize TasksPane with custom comparison
export const TasksPane = React.memo(TasksPaneComponent);

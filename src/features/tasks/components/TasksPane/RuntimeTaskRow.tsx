import React from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/components/ui/contracts/cn';
import type { Task as RuntimeTask } from '@/integrations/runtime/generated.ts';
import {
  runtimeTaskIsCancellable,
  runtimeTaskIsRetryable,
  runtimeTaskIsSelectedTimelineRender,
  type RuntimeTaskAction,
  type RuntimeTaskActionFailure,
} from './hooks/useRuntimeTasks';
import {
  runtimeActionErrorMessage,
  runtimeTaskDetail,
  runtimeTaskLabel,
  runtimeTaskProgress,
  runtimeTaskRelativeTime,
  runtimeTaskStateLabel,
} from './activityPresentation';

export interface RuntimeTaskRowActions {
  timelineId: string | null;
  onCancelTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
  isTaskActionPending: (taskId: string, action: RuntimeTaskAction) => boolean;
  onExportManagedOutput: (taskId: string, timelineId: string) => void;
  isExportTaskPending: (taskId: string) => boolean;
  onInspectTask: (taskId: string, anchor: { top: number; right: number }) => void;
  actionFailures: Record<string, RuntimeTaskActionFailure>;
  exportedTo: Record<string, { label: string; title: string }>;
  onDismissActionError: (taskId: string) => void;
}

interface RuntimeTaskRowProps {
  task: RuntimeTask;
  actions: RuntimeTaskRowActions;
  /** A collapsed group: the row names the group and toggles its members instead of inspecting. */
  group?: { count: number; expanded: boolean; onToggle: () => void };
  nested?: boolean;
}

function StatusText({ task }: { task: RuntimeTask }) {
  if (task.state === 'succeeded') {
    const time = runtimeTaskRelativeTime(task.updated_at);
    return <span className="whitespace-nowrap text-muted-foreground"><span>Complete</span>{time && <> · <span>{time}</span></>}</span>;
  }
  const progress = runtimeTaskProgress(task);
  const state = runtimeTaskStateLabel(task.state);
  const tone = task.state === 'failed' ? 'text-destructive' : 'text-muted-foreground';
  return (
    <span className={cn('whitespace-nowrap', tone, task.state === 'cancelled' && 'opacity-70')}>
      {progress ? `${state} · ${Math.round(progress.percent)}%` : state}
    </span>
  );
}

export function RuntimeTaskRow({ task, actions, group, nested = false }: RuntimeTaskRowProps) {
  const { timelineId, actionFailures, exportedTo } = actions;
  const label = runtimeTaskLabel(task);
  const detail = runtimeTaskDetail(task);
  const cancelPending = actions.isTaskActionPending(task.task_id, 'cancel');
  const retryPending = actions.isTaskActionPending(task.task_id, 'retry');
  const exportPending = actions.isExportTaskPending(task.task_id);
  const canExport = !group && runtimeTaskIsSelectedTimelineRender(task, timelineId);
  const failure = group ? undefined : actionFailures[task.task_id];
  const saved = group ? undefined : exportedTo[task.task_id];
  const Chevron = group ? ChevronDown : ChevronRight;

  const activate = (element: HTMLElement) => {
    if (group) return group.onToggle();
    const rect = element.getBoundingClientRect();
    actions.onInspectTask(task.task_id, { top: rect.top, right: rect.right });
  };
  const stop = (run: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    run();
  };

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={group ? `${label}, ${group.count} tasks` : `${label} activity details`}
      aria-expanded={group ? group.expanded : undefined}
      data-runtime-task-row="true"
      data-runtime-task-id={task.task_id}
      onClick={(event) => activate(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        activate(event.currentTarget);
      }}
      className={cn(
        'group cursor-pointer rounded-md border border-border bg-card/60 px-3 py-2 text-xs text-card-foreground',
        'transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        nested && 'bg-transparent',
      )}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">
            {label}
            {group && <span className="ml-1 font-normal text-muted-foreground">×{group.count}</span>}
          </div>
          {detail && !group && <div className="truncate text-muted-foreground">{detail}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <StatusText task={task} />
          {canExport && timelineId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={stop(() => actions.onExportManagedOutput(task.task_id, timelineId))}
              disabled={cancelPending || retryPending || exportPending}
              aria-label={`Export ${label} as a video file`}
              className="h-6 px-2 text-primary"
            >
              {exportPending ? 'Exporting…' : 'Export'}
            </Button>
          )}
          {!group && runtimeTaskIsCancellable(task) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={stop(() => actions.onCancelTask(task.task_id))}
              disabled={cancelPending || retryPending}
              aria-label={`Cancel ${label}`}
              className="h-6 px-2 text-destructive"
            >
              {cancelPending ? 'Cancelling…' : 'Cancel'}
            </Button>
          )}
          {!group && runtimeTaskIsRetryable(task) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={stop(() => actions.onRetryTask(task.task_id))}
              disabled={cancelPending || retryPending}
              aria-label={`Retry ${label}`}
              className="h-6 px-2"
            >
              {retryPending ? 'Retrying…' : 'Retry'}
            </Button>
          )}
          <Chevron
            className={cn(
              'h-3.5 w-3.5 text-muted-foreground transition-opacity',
              group?.expanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
            )}
            aria-hidden="true"
          />
        </div>
      </div>
      {saved && !failure && (
        <div className="mt-1 truncate text-muted-foreground" title={saved.title}>Saved to {saved.label}</div>
      )}
      {failure && (
        <div className="mt-1 flex items-start gap-1 text-destructive" role="alert">
          <span className="min-w-0 flex-1 break-words">{runtimeActionErrorMessage(failure.action, failure.message)}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            className="shrink-0 rounded p-0.5 hover:bg-destructive/10"
            onClick={stop(() => actions.onDismissActionError(task.task_id))}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      )}
    </article>
  );
}

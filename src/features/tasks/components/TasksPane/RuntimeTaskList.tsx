import React, { useMemo, useState } from 'react';
import { Button } from '@/shared/components/ui/button';
import type { Task as RuntimeTask } from '@/integrations/runtime/generated.ts';
import type { RuntimeTaskAction, RuntimeTaskActionFailure } from './hooks/useRuntimeTasks';
import { RuntimeTaskGroup } from './RuntimeTaskGroup';
import { RuntimeTaskRow, type RuntimeTaskRowActions } from './RuntimeTaskRow';
import { sectionRuntimeTasks } from './runtimeTaskGroups';

interface RuntimeTaskListProps {
  tasks: RuntimeTask[];
  isLoading: boolean;
  error: Error | null;
  actionFailures: Record<string, RuntimeTaskActionFailure>;
  exportedTo: Record<string, { label: string; title: string }>;
  onDismissActionError: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
  isTaskActionPending: (taskId: string, action: RuntimeTaskAction) => boolean;
  timelineId: string | null;
  onExportManagedOutput: (taskId: string, timelineId: string) => void;
  isExportTaskPending: (taskId: string) => boolean;
  onInspectTask: (taskId: string, anchor: { top: number; right: number }) => void;
  showComplete?: boolean;
}

export function RuntimeTaskList({ tasks, isLoading, error, showComplete = false, ...actions }: RuntimeTaskListProps) {
  const [showOlder, setShowOlder] = useState(false);
  const sections = useMemo(() => sectionRuntimeTasks(tasks, actions.timelineId), [tasks, actions.timelineId]);

  if (error) {
    return (
      <div className="p-4 text-sm text-destructive" role="alert" data-runtime-task-error="true">
        Couldn't load tasks: {error.message}
      </div>
    );
  }

  if (isLoading && tasks.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">Loading tasks…</div>;
  }

  if (tasks.length === 0) {
    return <p className="p-4 text-center text-sm text-muted-foreground">No tasks yet</p>;
  }

  const rowActions: RuntimeTaskRowActions = actions;
  const { active, failed, recent, older } = sections;
  return (
    <div className="space-y-1 p-4 text-sidebar-foreground" data-runtime-task-list="true">
      {active.map((task) => <RuntimeTaskRow key={task.task_id} task={task} actions={rowActions} />)}
      {failed.map((group) => <RuntimeTaskGroup key={group.key} group={group} actions={rowActions} />)}
      {recent.map((group) => <RuntimeTaskGroup key={group.key} group={group} actions={rowActions} showComplete={showComplete} />)}
      {older.length > 0 && (
        <>
          {showOlder && older.map((group) => <RuntimeTaskGroup key={group.key} group={group} actions={rowActions} showComplete={showComplete} />)}
          <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={() => setShowOlder((open) => !open)}>
            {showOlder ? 'Hide older' : `Show ${older.length} older`}
          </Button>
        </>
      )}
    </div>
  );
}

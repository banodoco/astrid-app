import React, { useState } from 'react';
import { RuntimeTaskRow, type RuntimeTaskRowActions } from './RuntimeTaskRow';
import type { RuntimeTaskGroup as Group } from './runtimeTaskGroups';

/** One history row: a single task, or a collapsed run of same-label tasks that expands to its members. */
export function RuntimeTaskGroup({ group, actions, showComplete }: { group: Group; actions: RuntimeTaskRowActions; showComplete?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [newest] = group.tasks;
  if (group.tasks.length === 1) return <RuntimeTaskRow task={newest} actions={actions} showComplete={showComplete} />;
  return (
    <div className="space-y-1">
      <RuntimeTaskRow
        task={newest}
        actions={actions}
        showComplete={showComplete}
        group={{ count: group.tasks.length, expanded, onToggle: () => setExpanded((open) => !open) }}
      />
      {expanded && (
        <div className="ml-3 space-y-1 border-l border-border pl-2">
          {group.tasks.map((task) => <RuntimeTaskRow key={task.task_id} task={task} actions={actions} nested showComplete={showComplete} />)}
        </div>
      )}
    </div>
  );
}

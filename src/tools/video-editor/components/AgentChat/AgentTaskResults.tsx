import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AstridRuntimeClient } from '@/integrations/runtime/client';
import { runtimeGenerationToGalleryItem, listAllRuntimeVariants } from '@/integrations/runtime/generationAccess';
import { mediaCrossOrigin } from '@/shared/lib/media/mediaCrossOrigin';
import { Button } from '@/shared/components/ui/button.tsx';
import type { Generation, ManagedOutput, Page, Task } from '@/integrations/runtime/generated';
import type { AstridTaskRef } from '../../runtime/agentTaskLinks';
import { EditorErrorMessage } from '../EditorErrorMessage.tsx';

export type LinkedTaskResult = { id: string; name: string; url: string; mediaType: string; generationId?: string };

type LinkedTask = { task: Task; results: LinkedTaskResult[] };

const TERMINAL_TASK_STATES = new Set<Task['state']>(['succeeded', 'failed', 'cancelled']);

function isTaskTerminal(task: Task | undefined): boolean {
  return Boolean(task && TERMINAL_TASK_STATES.has(task.state));
}

async function collectPages<T>(fetch: (cursor?: string) => Promise<Page<T>>): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await fetch(cursor);
    rows.push(...page.items);
    const next = page.next_cursor;
    if (next !== null && seen.has(next)) throw new Error('Runtime result pagination repeated a cursor');
    if (next !== null) seen.add(next);
    cursor = next ?? undefined;
  } while (cursor);
  return rows;
}

/** Verify the whole admitted identity before showing canonical Runtime output. */
export async function loadLinkedTaskResults(ref: AstridTaskRef, client = new AstridRuntimeClient()): Promise<LinkedTaskResult[]> {
  const task = await client.getTask(ref.task_id);
  if (task.project_id !== ref.project_id || task.run_id !== ref.run_id || task.capability_id !== ref.capability_id) {
    throw new Error('The linked task does not belong to this chat action.');
  }
  const [generations, outputs] = await Promise.all([
    collectPages<Generation>(cursor => client.listGenerations(ref.project_id, cursor, 200)),
    collectPages<ManagedOutput>(cursor => client.listManagedOutputs(ref.task_id, cursor, 200)),
  ]);
  const results: LinkedTaskResult[] = [];
  const objects = new Set<string>();
  for (const generation of generations) {
    if (generation.project_id !== ref.project_id || generation.source_task_id !== ref.task_id) continue;
    const variants = await listAllRuntimeVariants(client, generation.generation_id);
    const item = runtimeGenerationToGalleryItem(client, generation, variants);
    if (!item.url) continue;
    results.push({ id: generation.generation_id, generationId: generation.generation_id,
      name: typeof generation.metadata.name === 'string' ? generation.metadata.name : 'Generated result',
      url: item.url, mediaType: item.contentType ?? (item.isVideo ? 'video/*' : 'image/*') });
    for (const variant of variants) if (variant.object_id) objects.add(variant.object_id);
  }
  for (const output of outputs) {
    if (output.project_id !== ref.project_id || output.run_id !== ref.run_id || output.task_id !== ref.task_id
      || output.state !== 'available' || output.role === 'thumbnail' || objects.has(output.object_id)) continue;
    results.push({ id: output.association_id, name: output.filename,
      url: client.objectContentUrl(output.object_id), mediaType: output.media_type });
  }
  return results;
}

async function loadLinkedTask(ref: AstridTaskRef, client = new AstridRuntimeClient()): Promise<LinkedTask> {
  const task = await client.getTask(ref.task_id);
  if (task.project_id !== ref.project_id || task.run_id !== ref.run_id || task.capability_id !== ref.capability_id) {
    throw new Error('The linked task does not belong to this chat action.');
  }
  const results = task.state === 'succeeded' ? await loadLinkedTaskResults(ref, client) : [];
  return { task, results };
}

function elapsedTime(createdAt: string): string {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return 'Elapsed time unavailable';
  const seconds = Math.max(0, Math.floor((Date.now() - created) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s elapsed` : `${seconds}s elapsed`;
}

function taskFailure(task: Task): { message: string; nextAction?: string } {
  const result = task.result && typeof task.result === 'object' ? task.result : {};
  const error = result.error && typeof result.error === 'object' ? result.error as Record<string, unknown> : {};
  const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  const message = typeof result.error === 'string'
    ? result.error
    : typeof error.message === 'string'
      ? error.message
      : typeof error.detail === 'string'
        ? error.detail
        : 'Task failed.';
  const nextAction = [details.next_action, details.recovery_text, details.recovery_command, error.next_action, result.next_action]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return { message, ...(nextAction ? { nextAction } : {}) };
}

function cancelKey(taskId: string, version: number): string {
  return `astrid.agent-chat.cancel-${taskId}-${version}`;
}

function LinkedTaskResults({ taskRef }: { taskRef: AstridTaskRef }) {
  const queryClient = useQueryClient();
  const queryKey = ['agent-linked-task-results', taskRef.project_id, taskRef.run_id, taskRef.task_id, taskRef.capability_id] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => loadLinkedTask(taskRef),
    refetchInterval: current => isTaskTerminal(current.state.data?.task) ? false : 3_000,
    retry: false,
  });
  const cancel = useMutation({
    mutationFn: async (task: Task) => new AstridRuntimeClient().cancelTask(task.task_id, cancelKey(task.task_id, task.version), task.version),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  if (query.error) return <p className="text-xs text-muted-foreground" role="status">Linked task status is unavailable.</p>;
  const task = query.data?.task;
  if (!task) return null;
  if (task.state === 'failed') {
    const failure = taskFailure(task);
    return <div className="mt-2 text-xs" data-linked-task-id={taskRef.task_id} role="status">
      <EditorErrorMessage message={failure.message} nextAction={failure.nextAction} headlinePrefix="Task failed: " fixLabel="Next" />
    </div>;
  }
  if (task.state === 'cancelled') {
    return <p className="mt-2 text-xs text-muted-foreground" data-linked-task-id={taskRef.task_id} role="status">Task cancelled.</p>;
  }
  if (!isTaskTerminal(task)) {
    const cancelling = cancel.isPending && cancel.variables?.task_id === task.task_id;
    return <div className="mt-2 flex items-center gap-2 text-xs" data-linked-task-id={taskRef.task_id} role="status">
      <span className="text-muted-foreground">{task.state} · {elapsedTime(task.created_at)}</span>
      <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={cancelling} onClick={() => cancel.mutate(task)}>
        {cancelling ? 'Cancelling…' : 'Cancel'}
      </Button>
    </div>;
  }
  const results = query.data?.results ?? [];
  if (!results.length) return null;
  return <div className="flex flex-wrap gap-2" data-linked-task-id={taskRef.task_id}>
    {results.map(result => <figure key={result.id} className="max-w-full rounded-lg border border-border bg-card/60 p-2" data-linked-result-id={result.id}>
      {result.mediaType.startsWith('video/') ? <video src={result.url} crossOrigin={mediaCrossOrigin(result.url)} controls preload="metadata" className="max-h-40 max-w-full rounded" />
        : result.mediaType.startsWith('image/') ? <img src={result.url} crossOrigin={mediaCrossOrigin(result.url)} alt={result.name} className="max-h-40 max-w-full rounded" />
          : result.mediaType.startsWith('audio/') ? <audio src={result.url} crossOrigin={mediaCrossOrigin(result.url)} controls preload="metadata" /> : null}
      <figcaption className="mt-1 truncate text-xs"><a href={result.url} draggable={false} target="_blank" rel="noreferrer" className="underline">{result.name}</a></figcaption>
    </figure>)}
  </div>;
}

export function AgentTaskResults({ refs, projectId }: { refs: readonly AstridTaskRef[]; projectId: string | null }) {
  const scoped = useMemo(() => refs.filter(ref => ref.project_id === projectId), [refs, projectId]);
  return <>{scoped.map(ref => <LinkedTaskResults key={`${ref.run_id}:${ref.task_id}`} taskRef={ref} />)}</>;
}

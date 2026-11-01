import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import type { Task as RuntimeTask } from '@/integrations/runtime/generated.ts';
import { mapWithConcurrency } from '@/shared/lib/async/mapWithConcurrency';

const EVENT_PAGE_LIMIT = 50;
const VISIBLE_POLL_MS = 2_000;
const HIDDEN_POLL_MS = 15_000;
const TASK_BATCH_MS = 300;
const FOCUS_RESYNC_MS = 60_000;
const FULL_LIST_RESYNC_MS = 5 * 60_000;

export const runtimeTaskQueryKey = (projectId: string | null) =>
  ['runtime-tasks', projectId ?? '__no-project__'] as const;

/** Wake durable continuations from task reads; cached tasks grant no commit authority. */
export function subscribeRuntimeTaskUpdates(queryClient: QueryClient, projectId: string, notify: () => void): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (event.type === 'updated' && event.action.type === 'success'
      && key[0] === runtimeTaskQueryKey(projectId)[0] && key[1] === projectId) notify();
  });
}

type EventClient = Pick<AstridRuntimeClient, 'listEvents' | 'getTask'>;
type Timer = ReturnType<typeof setTimeout>;

interface TaskEventPoller {
  refs: number;
  ready: Promise<void>;
  start(): void;
  stop(): void;
}

const pollers = new WeakMap<QueryClient, Map<string, TaskEventPoller>>();

function createTaskEventPoller(
  queryClient: QueryClient,
  projectId: string,
  client: EventClient,
): TaskEventPoller {
  const queryKey = runtimeTaskQueryKey(projectId);
  const pendingIds = new Set<string>();
  const readFailures = new Map<string, number>(); // a task that cannot be read is retried at most 3 times
  let active = false;
  let cursor: string | undefined;
  let pollTimer: Timer | undefined;
  let batchTimer: Timer | undefined;
  let fullListTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let flushing = false;
  let hiddenAt: number | null = null;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });

  function schedulePoll(delay: number) {
    clearTimeout(pollTimer);
    if (active && !polling) pollTimer = setTimeout(() => void poll(), delay);
  }

  function scheduleBatch() {
    if (active && !batchTimer && !flushing && pendingIds.size > 0) {
      batchTimer = setTimeout(() => {
        batchTimer = undefined;
        void flushTasks();
      }, TASK_BATCH_MS);
    }
  }

  async function flushTasks() {
    if (!active || flushing || pendingIds.size === 0) return;
    flushing = true;
    const ids = [...pendingIds];
    pendingIds.clear();
    try {
      const results = await mapWithConcurrency(ids, 4, async (id) => {
        try {
          return { id, task: await client.getTask(id) };
        } catch {
          return { id, task: null };
        }
      });
      if (!active) return;
      const updates: RuntimeTask[] = [];
      for (const { id, task } of results) {
        if (!task) {
          const failures = (readFailures.get(id) ?? 0) + 1;
          if (failures < 3) { readFailures.set(id, failures); pendingIds.add(id); }
          else readFailures.delete(id);
          continue;
        }
        readFailures.delete(id);
        if (task.project_id === projectId) updates.push(task);
      }
      if (updates.length > 0) {
        queryClient.setQueryData<RuntimeTask[]>(queryKey, (current) => {
          const next = current ? [...current] : [];
          const positions = new Map(next.map((task, index) => [task.task_id, index]));
          for (const task of updates) {
            const index = positions.get(task.task_id);
            if (index === undefined) {
              positions.set(task.task_id, next.length);
              next.push(task);
            } else if (task.version >= next[index].version) {
              next[index] = task;
            }
          }
          return next;
        });
      }
    } finally {
      flushing = false;
      // Failed task reads retry on the next event poll, avoiding a tight loop.
      if (active && pendingIds.size > 0 && !polling && !pollTimer) schedulePoll(VISIBLE_POLL_MS);
    }
  }

  async function poll() {
    if (!active || polling) return;
    pollTimer = undefined;
    polling = true;
    try {
      let nextCursor = cursor;
      while (active) {
        const page = await client.listEvents(nextCursor, nextCursor === undefined);
        if (!active) return;
        if (!page.next_cursor) throw new Error('Workspace Runtime event feed did not return a polling cursor');
        for (const event of page.items) {
          if (event.aggregate_type === 'task' && event.event_type.startsWith('task.')) {
            pendingIds.add(event.aggregate_id);
          }
        }
        scheduleBatch();
        const previousCursor = nextCursor;
        nextCursor = page.next_cursor;
        cursor = nextCursor;
        markReady();
        if (page.items.length < EVENT_PAGE_LIMIT || nextCursor === previousCursor) break;
      }
    } catch {
      // Retain the last successful cursor and retry at the normal cadence.
    } finally {
      polling = false;
      if (active) {
        scheduleBatch();
        schedulePoll(document.visibilityState === 'hidden' ? HIDDEN_POLL_MS : VISIBLE_POLL_MS);
      }
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      if (!polling) schedulePoll(HIDDEN_POLL_MS);
      return;
    }
    if (hiddenAt !== null && Date.now() - hiddenAt > FOCUS_RESYNC_MS) {
      void queryClient.invalidateQueries({ queryKey });
    }
    hiddenAt = null;
    if (!polling) schedulePoll(0);
  }

  return {
    refs: 0,
    ready,
    start() {
      if (active) return;
      active = true;
      hiddenAt = document.visibilityState === 'hidden' ? Date.now() : null;
      document.addEventListener('visibilitychange', onVisibilityChange);
      window.addEventListener('focus', onVisibilityChange);
      fullListTimer = setInterval(() => {
        void queryClient.invalidateQueries({ queryKey });
      }, FULL_LIST_RESYNC_MS);
      // A remounted consumer can have a cached list from a period with no poller.
      if (queryClient.getQueryData(queryKey) !== undefined
        && queryClient.getQueryState(queryKey)?.fetchStatus === 'idle') {
        void queryClient.invalidateQueries({ queryKey });
      }
      schedulePoll(0);
    },
    stop() {
      active = false;
      clearTimeout(pollTimer);
      clearTimeout(batchTimer);
      clearInterval(fullListTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onVisibilityChange);
      pendingIds.clear();
      markReady();
    },
  };
}

function taskEventPoller(queryClient: QueryClient, projectId: string): TaskEventPoller {
  let byProject = pollers.get(queryClient);
  if (!byProject) {
    byProject = new Map();
    pollers.set(queryClient, byProject);
  }
  let poller = byProject.get(projectId);
  if (!poller) {
    poller = createTaskEventPoller(queryClient, projectId, new AstridRuntimeClient());
    byProject.set(projectId, poller);
  }
  return poller;
}

/** Fence the first full-list snapshot behind a feed cursor so admission cannot fall into a startup gap. */
export function readyRuntimeTaskEvents(queryClient: QueryClient, projectId: string): Promise<void> {
  const poller = taskEventPoller(queryClient, projectId);
  poller.start();
  return poller.ready;
}

/** One cursor and request loop per project and QueryClient, shared by all consumers. */
export function useRuntimeTaskEvents(projectId: string | null): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!projectId) return;
    const poller = taskEventPoller(queryClient, projectId);
    poller.refs += 1;
    poller.start();
    return () => {
      poller.refs -= 1;
      if (poller.refs === 0) {
        poller.stop();
        pollers.get(queryClient)?.delete(projectId);
      }
    };
  }, [projectId, queryClient]);
}

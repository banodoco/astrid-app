import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import { buildProvenanceRecords } from './provenanceModel.ts';
import type { ProvenanceRecord, ProvenanceSnapshot, ProvenanceUse } from './types.ts';

/** A viewer is a read: it must never stall on a workspace with thousands of objects. */
const MAX_OBJECTS = 100;
const MAX_GENERATIONS = 40;
const MAX_VARIANTS_LOOKUPS = 25;
const MAX_TIMELINES = 8;

const provenanceKey = (kind: string, projectId: string | null) => ['provenance', kind, projectId] as const;

function timelineLabel(timeline: Record<string, unknown>, index: number): string {
  const name = typeof timeline.name === 'string' && timeline.name.trim() ? timeline.name.trim() : null;
  const id = typeof timeline.timeline_id === 'string' ? timeline.timeline_id : '';
  return name ?? (id ? `Timeline ${id.slice(0, 6)}` : `Timeline ${index + 1}`);
}

/**
 * Which timelines mention an object. The Runtime has no object→usage query yet, so this
 * reads each timeline head and looks for the object id inside it — bounded, and every
 * failure is dropped rather than shown as "unused".
 */
async function loadUsage(
  client: AstridRuntimeClient,
  projectId: string,
  objectIds: string[],
): Promise<{ usage: Map<string, ProvenanceUse[]>; scanned: number }> {
  const usage = new Map<string, ProvenanceUse[]>();
  if (!objectIds.length) return { usage, scanned: 0 };

  let timelines: Record<string, unknown>[];
  try {
    timelines = await client.listTimelines(projectId);
  } catch {
    return { usage, scanned: 0 };
  }

  const heads = await Promise.all(timelines.slice(0, MAX_TIMELINES).map(async (timeline, index) => {
    const timelineId = typeof timeline.timeline_id === 'string' ? timeline.timeline_id : null;
    if (!timelineId) return null;
    try {
      const payload = await client.getProjectTimeline(projectId, timelineId);
      return { timelineId, name: timelineLabel(timeline, index), haystack: JSON.stringify(payload) };
    } catch {
      return null;
    }
  }));

  let scanned = 0;
  for (const head of heads) {
    if (!head) continue;
    scanned += 1;
    for (const objectId of objectIds) {
      if (!head.haystack.includes(objectId)) continue;
      const existing = usage.get(objectId) ?? [];
      existing.push({ timelineId: head.timelineId, timelineName: head.name });
      usage.set(objectId, existing);
    }
  }
  return { usage, scanned };
}

export interface ProvenanceData {
  records: ProvenanceRecord[];
  total: number;
  /** Objects past the first page are not listed; the caption says so. */
  truncated: boolean;
  timelinesScanned: number;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useProvenance(projectId: string | null, enabled: boolean): ProvenanceData {
  const client = useMemo(() => new AstridRuntimeClient({ readOnly: true }), []);
  const ready = enabled && Boolean(projectId);

  const objectsQuery = useQuery({
    queryKey: provenanceKey('objects', projectId),
    enabled: ready,
    queryFn: async () => {
      return client.listProjectObjects(projectId as string, undefined, MAX_OBJECTS);
    },
  });

  const generationsQuery = useQuery({
    queryKey: provenanceKey('generations', projectId),
    enabled: ready,
    queryFn: async () => {
      const page = await client.listGenerations(projectId as string, undefined, MAX_GENERATIONS);
      const generations = page.items;
      const lookups = generations.slice(0, MAX_VARIANTS_LOOKUPS);
      const variantPages = await Promise.all(lookups.map(async (generation) => {
        try {
          const variants = await client.listVariants(generation.generation_id, undefined, 50);
          return variants.items;
        } catch {
          return [];
        }
      }));
      return { generations, variants: variantPages.flat() };
    },
  });

  const tasksQuery = useQuery({
    queryKey: provenanceKey('tasks', projectId),
    enabled: ready,
    queryFn: async () => {
      const page = await client.listProjectTasks(projectId as string, undefined, MAX_OBJECTS);
      return page.items;
    },
  });

  const objectIds = useMemo(
    () => (objectsQuery.data?.items ?? []).map(object => object.object_id),
    [objectsQuery.data],
  );

  const usageQuery = useQuery({
    queryKey: provenanceKey('usage', projectId),
    enabled: ready && objectIds.length > 0,
    queryFn: () => loadUsage(client, projectId as string, objectIds),
  });

  const snapshot: ProvenanceSnapshot | null = useMemo(() => {
    if (!objectsQuery.data || !generationsQuery.data || !tasksQuery.data) return null;
    return {
      objects: objectsQuery.data.items,
      generations: generationsQuery.data.generations,
      variants: generationsQuery.data.variants,
      tasks: tasksQuery.data,
      usage: usageQuery.data?.usage ?? new Map<string, ProvenanceUse[]>(),
    };
  }, [generationsQuery.data, objectsQuery.data, tasksQuery.data, usageQuery.data]);

  const records = useMemo(() => (snapshot ? buildProvenanceRecords(snapshot) : []), [snapshot]);

  const error = (objectsQuery.error ?? generationsQuery.error ?? tasksQuery.error) as Error | null;

  return {
    records,
    total: objectsQuery.data?.items.length ?? 0,
    truncated: Boolean(objectsQuery.data?.next_cursor),
    timelinesScanned: usageQuery.data?.scanned ?? 0,
    isLoading: ready && !snapshot && !error,
    error,
    refetch: () => {
      void objectsQuery.refetch();
      void generationsQuery.refetch();
      void tasksQuery.refetch();
      void usageQuery.refetch();
    },
  };
}

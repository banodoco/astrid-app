import { AstridRuntimeClient } from './client.ts';
import { ApiError } from './generated.ts';
import { generateUUID } from '@/shared/lib/taskCreation/ids.ts';

type RuntimeTimeline = Record<string, unknown> & {
  timeline_id?: unknown;
  timeline_ulid?: unknown;
  head_revision_id?: unknown;
  archived?: unknown;
  is_default?: unknown;
  slug?: unknown;
};

function timelineId(value: RuntimeTimeline | undefined): string | undefined {
  return typeof value?.timeline_id === 'string' && value.timeline_id.length > 0
    ? value.timeline_id
    : undefined;
}

function resolveTimelineId(
  timelines: RuntimeTimeline[],
  reference: string | undefined,
): string | undefined {
  if (!reference) return undefined;
  const active = timelines.filter((timeline) => timeline.archived !== true);
  return timelineId(active.find((timeline) => timeline.timeline_id === reference)
    ?? active.find((timeline) => timeline.timeline_ulid === reference));
}

function chooseTimeline(timelines: RuntimeTimeline[]): RuntimeTimeline | undefined {
  const active = timelines.filter((timeline) => timeline.archived !== true);
  const preferred = (candidates: RuntimeTimeline[]) => candidates.find((timeline) => timeline.is_default === true)
    ?? candidates.find((timeline) => timeline.slug === 'main')
    ?? candidates.find((timeline) => timeline.slug === 'rough-cut')
    ?? candidates[0];
  return preferred(active.filter((timeline) => (
    typeof timeline.head_revision_id === 'string' && timeline.head_revision_id.length > 0
  ))) ?? preferred(active);
}

async function stableUuid(seed: string): Promise<string> {
  const input = new TextEncoder().encode(seed);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input)).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Catalog creation atomically installs Runtime's empty canonical bootstrap. */
export async function createCanonicalTimeline(
  projectId: string,
  options: { name?: string; timelineId?: string; idempotencyKey?: string } = {},
  client: AstridRuntimeClient = new AstridRuntimeClient(),
): Promise<string> {
  const targetTimelineId = options.timelineId
    ?? (options.idempotencyKey
      ? await stableUuid(`astrid-timeline:${options.idempotencyKey}`)
      : generateUUID());
  await client.createTimeline(
    projectId,
    targetTimelineId,
    options.idempotencyKey ?? `astrid-timeline-create-${projectId}-${targetTimelineId}`,
    options.name ?? 'Timeline',
  );
  return targetTimelineId;
}

/** Ensure a project has a canonical Runtime composition, repairing an existing headless shell. */
export async function ensureProjectHasTimeline(
  projectId: string,
  client: AstridRuntimeClient = new AstridRuntimeClient(),
): Promise<string> {
  const timelines = await client.listTimelines(projectId) as RuntimeTimeline[];
  const project = await client.getProject(projectId);
  const currentDefault = project.metadata.default_timeline_id;
  const defaultTimeline = typeof currentDefault === 'string'
    ? timelines.filter((timeline) => timeline.archived !== true)
      .find((timeline) => timeline.timeline_id === currentDefault)
      ?? timelines.filter((timeline) => timeline.archived !== true)
        .find((timeline) => timeline.timeline_ulid === currentDefault)
    : undefined;
  const existing = defaultTimeline ?? chooseTimeline(timelines);
  let target = timelineId(existing);
  if (target) {
    if (typeof existing?.head_revision_id !== 'string' || !existing.head_revision_id) {
      // Omit name when adopting a shell so its existing catalog name survives.
      await client.createTimeline(projectId, target, `astrid-first-timeline-${projectId}`);
    }
  } else {
    target = await createCanonicalTimeline(projectId, {
      name: 'Main',
      timelineId: await stableUuid(`astrid-first-timeline:${projectId}`),
      idempotencyKey: `astrid-first-timeline-${projectId}`,
    }, client);
  }
  // A concurrent Main reassignment wins. Merge metadata against the latest
  // project version, preserving chat state and all unrelated settings.
  for (let attempt = 0; attempt < 12; attempt++) {
    const latest = await client.getProject(projectId);
    const assigned = latest.metadata.default_timeline_id;
    if (typeof assigned === 'string' && assigned) {
      if (assigned !== currentDefault) {
        const refreshedTimelines = await client.listTimelines(projectId) as RuntimeTimeline[];
        const refreshedId = resolveTimelineId(refreshedTimelines, assigned);
        if (refreshedId) return refreshedId;
        const confirmed = await client.getProject(projectId);
        if (confirmed.metadata.default_timeline_id !== assigned) continue;
        throw new Error('Runtime selected a primary timeline that could not be resolved to a canonical timeline ID; retry.');
      }
      const resolved = resolveTimelineId(timelines, assigned);
      if (resolved) return resolved;
    }
    try {
      const updated = await client.updateProject(projectId, generateUUID(), latest.version, undefined, {
        ...latest.metadata, default_timeline_id: target,
      });
      const updatedRef = updated.metadata.default_timeline_id;
      if (typeof updatedRef === 'string' && updatedRef !== target) {
        const resolved = resolveTimelineId(timelines, updatedRef);
        if (resolved) return resolved;
        const refreshedTimelines = await client.listTimelines(projectId) as RuntimeTimeline[];
        const refreshedId = resolveTimelineId(refreshedTimelines, updatedRef);
        if (refreshedId) return refreshedId;
        throw new Error('Runtime saved a primary timeline that could not be resolved to a canonical timeline ID; retry.');
      }
      return target;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) throw error;
    }
  }
  throw new Error('Project changed repeatedly while choosing Main timeline; retry.');
}

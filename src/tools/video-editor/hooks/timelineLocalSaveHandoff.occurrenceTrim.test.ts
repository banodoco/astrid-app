// A shot's own start or end edge is an intent: the handoff sends `occurrence.trim` and proves nothing about the editor's
// preview (the Runtime owns anchor, bounds and neighbours). Empty and populated documents.
import { describe, expect, it } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { createCommitOutbox, toOutboxJson } from '../commands/commitOutbox.ts';
import { createLocalSaveSession } from '../commands/localSaveSession.ts';
import { withDefaultTimelineOutput } from '../lib/defaults.ts';
import { buildTimelineData } from '../lib/timeline-data.ts';
import type { AssetRegistry, TimelineConfig } from '../types/index.ts';
import { createTimelineLocalSaveHandoff, type TimelineGestureReadBasis, type TimelineSaveSource } from './timelineLocalSaveHandoff.ts';

interface StoredDocument { config: Record<string, unknown>; clips?: Array<Record<string, unknown>>; registry: AssetRegistry; occurrences: Array<Record<string, unknown>> }
const corpus = Object.entries(import.meta.glob('./__fixtures__/corpus/*.json', { eager: true, import: 'default' }) as Record<string, StoredDocument>)
  .map(([path, document]) => ({ name: path.split('/').pop()!, document }));

async function mount(stored: StoredDocument, options: { omitOccurrences?: boolean } = {}) {
  const head = { projectId: 'project-commit', timelineId: 'timeline-commit', headRevisionId: 'r0', headPublicationId: 'p0' };
  const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }, { children: false }).data.canonical_document;
  document.parent_revision.payload = structuredClone(stored) as never;
  document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
  // Every occurrence is backed by the exact shot and internal timeline images the Runtime closure requires.
  for (const [index, occurrence] of stored.occurrences.entries()) {
    const internalId = `internal-${index}`;
    const internalPayload = { tracks: [{ id: 'v1', kind: 'visual', label: 'Track' }], clips: [] };
    const shotPayload = { name: 'Shot', internal_timeline_revision_id: internalId, timing: { duration_ms: 1000 }, assets: [] };
    const shot = { shot_id: occurrence.shot_id as string, revision_id: occurrence.shot_revision_id as string, internal_timeline_revision_id: internalId,
      content_digest: fixtureDigest(shotPayload), payload: shotPayload };
    const internal = { timeline_id: `internal-timeline-${index}`, revision_id: internalId, content_digest: fixtureDigest(internalPayload), payload: internalPayload };
    document.shot_revisions.push(shot as never);
    document.internal_timeline_revisions.push(internal as never);
    document.dependency_manifest.shots.push({ shot_id: shot.shot_id, revision_id: shot.revision_id, internal_timeline_revision_id: internalId, content_digest: shot.content_digest });
    document.dependency_manifest.internal_timelines.push({ timeline_id: internal.timeline_id, revision_id: internalId, content_digest: internal.content_digest });
  }
  // The same load the editor performs (useTimelineSave prepareDisplay).
  const config = { ...structuredClone(stored.config), ...(stored.config.clips ? {} : { clips: structuredClone(stored.clips) }) };
  const built = await buildTimelineData({ ...config, ...withDefaultTimelineOutput(config as never) } as TimelineConfig, structuredClone(stored.registry));
  const source: TimelineSaveSource = { config: built.config, registry: built.registry, head };
  const initial = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
  const scope = { realmId: 'realm', actorId: 'actor', projectId: head.projectId, timelineId: head.timelineId };
  const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (_k, work) => work() });
  const session = await createLocalSaveSession({ scope, initial, document: toOutboxJson(document), outboxes, send: async () => { throw new Error('no send'); },
    loadLatest: async () => initial, changed: () => {}, prepareDisplay: async () => { throw new Error('no adoption'); } } as never);
  const handoff = createTimelineLocalSaveHandoff({ initial, source, session, adopted: (() => {}) as never });
  return { built, source, handoff, session, outboxes, scope, stored: document.parent_revision.payload as unknown as StoredDocument };
}
type Env = Awaited<ReturnType<typeof mount>>;


const trim = (env: Env, occurrenceId: string, edge: 'start' | 'end', toMs: number) => env.handoff.capture(
  { ...env.source }, { kind: 'occurrence-trim', occurrenceId, edge, toMs, config: env.source.config, registry: env.source.registry } as TimelineGestureReadBasis);
const sent = async (env: Env) => (await env.outboxes.list(env.scope)).flatMap(record => record.intents)
  .flatMap(intent => (intent.payload as { commands?: unknown[] }).commands ?? []);

describe.each(corpus)('shot edge trim on stored document $name', ({ document }) => {
  it.each(['start', 'end'] as const)('sends one occurrence.trim for the %s edge and leaves the document alone', async edge => {
    const env = await mount(document);
    const target = document.occurrences[0].occurrence_id as string;
    const before = structuredClone(env.session.getDocument());
    await trim(env, target, edge, edge === 'start' ? 2500 : 9500);
    expect(await sent(env)).toEqual([expect.objectContaining({ op: 'occurrence.trim', version: '1', select: `occurrence:${target}`,
      args: { occurrence_id: target, edge, to_ms: edge === 'start' ? 2500 : 9500 }, intent: { ownership: 'occurrence' } })]);
    expect(env.session.getDocument()).toEqual(before);
  });

  it('refuses a shot that is not on the timeline, a negative time and a fractional time, and sends nothing', async () => {
    const env = await mount(document);
    const target = document.occurrences[0].occurrence_id as string;
    await expect(trim(env, 'no-such-occurrence', 'end', 5000)).rejects.toThrow(/not on this timeline/);
    await expect(trim(env, target, 'end', -1)).rejects.toThrow(/invalid time/);
    await expect(trim(env, target, 'end', 1000.5)).rejects.toThrow(/invalid time/);
    expect(await sent(env)).toEqual([]);
  });
});

describe('shot edge trim on an empty document', () => {
  it('is refused by name and sends nothing', async () => {
    const env = await mount({ config: { clips: [], tracks: [] }, registry: { assets: {} } as never, clips: [], occurrences: [] });
    await expect(trim(env, 'occ-0', 'end', 5000)).rejects.toThrow(/not on this timeline/);
    expect(await sent(env)).toEqual([]);
  });
});

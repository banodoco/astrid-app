import { describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { CommitRequest } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelineCommandBasis, TimelineCommitResult } from '../data/DataProvider.ts';
import type { TimelineSaveSource } from '../hooks/timelineLocalSaveHandoff.ts';
import { createTimelineLocalSaveHandoff } from '../hooks/timelineLocalSaveHandoff.ts';
import { createDefaultTimelineConfig } from '../lib/defaults.ts';
import type { TimelineConfig } from '../types/index.ts';
import { createCommitOutbox, toOutboxJson } from './commitOutbox.ts';
import { createLocalSaveSession } from './localSaveSession.ts';

const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-commit' };
const h0 = { revisionId: 'r0', publicationId: 'p0' };

function documentPair() {
  const config = createDefaultTimelineConfig();
  config.clips = [
    { id: 'x', track: 'V1', at: 1, hold: 2, clipType: 'video' },
    { id: 'sibling', track: 'V1', at: 4, hold: 2, clipType: 'video' },
  ];
  const registry = { assets: {} };
  const parent = { config, registry, clips: config.clips, tracks: config.tracks,
    occurrences: [], opaque: { keep: [null, false] } };
  const document = acceptedCommit({ revision_id: h0.revisionId, publication_id: h0.publicationId },
    { revision_id: h0.revisionId, publication_id: h0.publicationId }).data.canonical_document;
  document.parent_revision.payload = parent;
  document.parent_revision.content_digest = fixtureDigest(parent);
  return { document, config, registry };
}

async function environment() {
  const pair = documentPair();
  const initial: TimelineCommandBasis = { head: h0, canonicalDocument: pair.document };
  const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (_key, work) => work() });
  const send = vi.fn<(request: CommitRequest, key: string) => Promise<TimelineCommitResult>>();
  const prepareDisplay = vi.fn(async (basis: TimelineCommandBasis, draft?: ReturnType<typeof toOutboxJson>) => ({
    document: structuredClone(draft ?? toOutboxJson(basis.canonicalDocument)), adopt() {},
  }));
  const session = await createLocalSaveSession({ scope, initial, document: toOutboxJson(pair.document), outboxes,
    send, loadLatest: async () => initial, prepareDisplay, changed: () => {} });
  const source: TimelineSaveSource = { config: structuredClone(pair.config) as TimelineConfig,
    registry: structuredClone(pair.registry), head: { projectId: scope.projectId, timelineId: scope.timelineId,
      headRevisionId: h0.revisionId, headPublicationId: h0.publicationId } };
  const handoff = createTimelineLocalSaveHandoff({ initial, source, session,
    adopted: (basis) => ({ receipt: { configVersion: 0, head: { projectId: scope.projectId, timelineId: scope.timelineId,
      headRevisionId: basis.head.revisionId, headPublicationId: basis.head.publicationId } }, source: {
        ...source, head: { ...source.head!, headRevisionId: basis.head.revisionId, headPublicationId: basis.head.publicationId },
      } }) });
  return { pair, initial, source, outboxes, send, prepareDisplay, session, handoff };
}

function trackChange(owner: { payload: { documentIntent?: { changes?: unknown[] } } }) {
  return owner.payload.documentIntent?.changes;
}

describe('local save track-label refusal declarations', () => {
  it('drains a label-only edit on close into the same outbox without starting a request', async () => {
    const env = await environment();
    const next = structuredClone(env.source);
    next.config.tracks[0].label = 'Closed draft';
    await env.handoff.capture(next);
    await env.session.dispose();

    expect(env.send).not.toHaveBeenCalled();
    const [stored] = await env.outboxes.list(scope);
    expect(stored.intents).toHaveLength(1);
    expect(trackChange(stored.intents[0])).toEqual([
      { op: 'set', ref: 'parent', path: ['tracks', 'id:V1', 'label'],
        before: { state: 'present', value: 'V1' }, value: 'Closed draft' },
    ]);
    expect(stored.intents[0].payload.documentIntent).toMatchObject({
      roots: [{ ref: 'parent', revisionId: h0.revisionId, contentDigest: env.initial.canonicalDocument.parent_revision.content_digest }],
      step: { label: 'Edit timeline' },
    });
    expect(env.session.getDocument()).toMatchObject({ parent_revision: { payload: {
      config: { tracks: [{ id: 'V1', label: 'Closed draft' }, { id: 'A1', label: 'A1' }] },
      opaque: { keep: [null, false] }, clips: [{ id: 'x' }, { id: 'sibling' }],
    } } });
  });

  it('keeps a pending label request unchanged when a newer move is authored', async () => {
    const env = await environment();
    const label = structuredClone(env.source);
    label.config.tracks[0].label = 'First label';
    await env.handoff.capture(label);
    env.send.mockRejectedValueOnce(new Error('Lost acknowledgement'));
    await expect(env.handoff.flush()).rejects.toThrow('draft retained');
    const [pendingBefore] = await env.outboxes.list(scope);
    const original = structuredClone(pendingBefore.pending!.request);

    const moved = structuredClone(label);
    moved.config.clips[0].at = 5;
    await env.handoff.capture(moved);
    const [pendingAfter] = await env.outboxes.list(scope);
    expect(pendingAfter.pending?.request).toEqual(original);
    expect(pendingAfter.pending?.request.key).toBe(original.key);
    expect(trackChange(pendingAfter.intents[1])).toEqual([
      { op: 'set', ref: 'parent', path: ['clips', 'id:x', 'at'],
        before: { state: 'present', value: 1 }, value: 5 },
    ]);
    expect(pendingAfter.intents[1].basis).toEqual({ after: pendingAfter.intents[0].id });
    expect(JSON.parse(pendingAfter.pending!.request.body)).toEqual(JSON.parse(original.body));
    const [request, key] = env.send.mock.calls[0];
    const firstDocumentIntent = pendingAfter.intents[0].payload.documentIntent as unknown as {
      step: { id: string; label: string; intent: string; tags: string[] };
    };
    expect(request).toMatchObject({
      api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
      base_revision_id: h0.revisionId, base_publication_id: h0.publicationId,
      label: 'Edit timeline', merge: 'atomic', dry_run: false, source: { via: 'app' },
      commands: [{ schema_version: 1, op: 'doc.patch', version: '1', select: null,
        args: { changes: trackChange(pendingAfter.intents[0]) } }],
      steps: [{ id: firstDocumentIntent.step.id, label: 'Edit timeline', intent: 'Save local editor changes', tags: [], command_ordinals: [0] }],
    });
    expect(request.steps?.[0].patch).toEqual(request.commands[0].args.changes);
    expect(request).not.toHaveProperty('reads');
    expect(key).toBe(original.key);
    expect(env.send).toHaveBeenCalledTimes(1);
    await env.session.dispose();
  });

  it('refuses synthetic or ambiguous track ownership and unprepared commands atomically', async () => {
    for (const kind of ['ambiguous', 'synthetic'] as const) {
      const env = await environment();
      const badSource = structuredClone(env.source);
      if (kind === 'ambiguous') badSource.config.tracks.push(structuredClone(badSource.config.tracks[0]));
      else badSource.config.tracks[0].id = 'display-only';
      const badHandoff = createTimelineLocalSaveHandoff({ initial: env.initial, source: badSource, session: env.session,
        adopted: (basis) => ({ receipt: { configVersion: 0, head: { projectId: scope.projectId, timelineId: scope.timelineId,
          headRevisionId: basis.head.revisionId, headPublicationId: basis.head.publicationId } }, source: badSource }) });
      await expect(badHandoff.capture(badSource)).rejects.toThrow();
      expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
      expect((await env.outboxes.list(scope))[0].intents).toHaveLength(0);
      expect(env.send).not.toHaveBeenCalled();
      expect(() => env.session.append({ before: toOutboxJson(env.initial.canonicalDocument),
        after: toOutboxJson(env.initial.canonicalDocument), label: 'Unprepared', commands: [] })).toThrow('nonempty commands');
      expect((await env.outboxes.list(scope))[0].intents).toHaveLength(0);
      await env.session.dispose();
    }
  });

  it.each(['project', 'timeline', 'publication', 'synthetic'] as const)('refuses a mismatched %s display basis', async (mismatch) => {
    const env = await environment();
    const next = structuredClone(env.source);
    if (mismatch === 'project') next.head!.projectId = 'other-project';
    if (mismatch === 'timeline') next.head!.timelineId = 'other-timeline';
    if (mismatch === 'publication') delete next.head!.headPublicationId;
    if (mismatch === 'synthetic') {
      const badSource = structuredClone(env.source);
      badSource.config.tracks[0].id = 'display-only';
      const badHandoff = createTimelineLocalSaveHandoff({ initial: env.initial, source: badSource, session: env.session,
        adopted: (basis) => ({ receipt: { configVersion: 0, head: { projectId: scope.projectId, timelineId: scope.timelineId,
          headRevisionId: basis.head.revisionId, headPublicationId: basis.head.publicationId } }, source: badSource }) });
      await expect(badHandoff.capture(badSource)).rejects.toThrow();
    } else await expect(env.handoff.capture(next)).rejects.toThrow();
    expect(env.session.getDocument()).toEqual(env.initial.canonicalDocument);
    expect((await env.outboxes.list(scope))[0].intents).toHaveLength(0);
    expect(env.send).not.toHaveBeenCalled();
    await env.session.dispose();
  });

  it('refuses mixed previews atomically and keeps the original capture available', async () => {
    const env = await environment();
    const captured = structuredClone(env.source);
    captured.config.tracks[0].label = 'Only label';
    await env.handoff.capture(captured);
    const badSource = structuredClone(env.source);
    badSource.config.tracks[0].id = 'display-only';
    (badSource.config.tracks[0] as TimelineConfig['tracks'][number] & { muted?: boolean }).muted = true;
    const badHandoff = createTimelineLocalSaveHandoff({ initial: env.initial, source: badSource, session: env.session,
      adopted: (basis) => ({ receipt: { configVersion: 0, head: { projectId: scope.projectId, timelineId: scope.timelineId,
        headRevisionId: basis.head.revisionId, headPublicationId: basis.head.publicationId } }, source: badSource }) });
    await expect(badHandoff.capture(badSource)).rejects.toThrow();
    const [stored] = await env.outboxes.list(scope);
    expect(stored.intents).toHaveLength(1);
    expect(trackChange(stored.intents[0])).toEqual([
      { op: 'set', ref: 'parent', path: ['tracks', 'id:V1', 'label'],
        before: { state: 'present', value: 'V1' }, value: 'Only label' },
    ]);
    expect(env.session.getDocument()).toMatchObject({ parent_revision: { payload: {
      config: { tracks: expect.arrayContaining([expect.objectContaining({ id: 'V1', label: 'Only label' })]) },
      opaque: { keep: [null, false] }, clips: [{ id: 'x' }, { id: 'sibling' }],
    } } });
    await env.session.dispose();
  });

  it('refuses a typing capture invalidated by a newer local move without changing the pending request', async () => {
    const env = await environment();
    const staleHandoff = createTimelineLocalSaveHandoff({ initial: env.initial, source: env.source, session: env.session,
      adopted: (basis) => ({ receipt: { configVersion: 0, head: { projectId: scope.projectId, timelineId: scope.timelineId,
        headRevisionId: basis.head.revisionId, headPublicationId: basis.head.publicationId } }, source: env.source }) });
    const moved = structuredClone(env.source);
    moved.config.clips[0].at = 5;
    env.send.mockRejectedValueOnce(new Error('Lost acknowledgement'));
    await env.handoff.capture(moved);
    await expect(env.handoff.flush()).rejects.toThrow('draft retained');
    const [before] = await env.outboxes.list(scope);
    const original = structuredClone(before.pending!.request);
    const typed = structuredClone(env.source);
    typed.config.tracks[0].label = 'Kept input';
    await expect(staleHandoff.capture(typed)).rejects.toThrow('local authored document changed outside this handoff');
    const [after] = await env.outboxes.list(scope);
    expect(after.intents).toHaveLength(1);
    expect(after.pending?.request).toEqual(original);
    expect(after.pending?.request.key).toBe(original.key);
    expect(JSON.parse(after.pending!.request.body)).toEqual(JSON.parse(original.body));
    expect(env.send).toHaveBeenCalledTimes(1);
    await env.session.dispose();
  });
});

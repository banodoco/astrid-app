import { describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { CommitRequest } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelineCommandBasis, TimelineCommitResult } from '../data/DataProvider.ts';
import { createCommitOutbox, toOutboxJson, type OutboxJson } from './commitOutbox.ts';
import { createLocalSaveSession, type LocalSave, type LocalSaveSession } from './localSaveSession.ts';

const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-commit' };
const h0 = { revisionId: 'r0', publicationId: 'p0' };
const h1 = { revisionId: 'r1', publicationId: 'p1' };
const h2 = { revisionId: 'r2', publicationId: 'p2' };

function canonical(at = 1, revision = h0.revisionId, publication = h0.publicationId) {
  const document = acceptedCommit({ revision_id: revision, publication_id: publication },
    { revision_id: h0.revisionId, publication_id: h0.publicationId }).data.canonical_document;
  const parent = document.parent_revision.payload as Record<string, OutboxJson>;
  const clip = { id: 'x', track: 'V1', at, hold: 1, opaque: { keep: null } };
  parent.config = { clips: [structuredClone(clip)], tracks: [{ id: 'V1', label: 'Picture' }] };
  parent.clips = [structuredClone(clip)];
  parent.tracks = structuredClone(parent.config.tracks);
  parent.registry = { assets: {} };
  parent.occurrences = [];
  parent.opaque = { sibling: [null, false] };
  document.parent_revision.content_digest = fixtureDigest(parent);
  return document;
}

function result(document: ReturnType<typeof canonical>, head = h1, base = h0): TimelineCommitResult {
  const response = acceptedCommit({ revision_id: head.revisionId, publication_id: head.publicationId },
    { revision_id: base.revisionId, publication_id: base.publicationId });
  response.data.canonical_document = structuredClone(document);
  response.data.canonical_document.parent_revision.revision_id = head.revisionId;
  response.data.canonical_document.parent_revision.content_digest = fixtureDigest(
    response.data.canonical_document.parent_revision.payload,
  );
  response.data.document_digest = fixtureDigest(response.data.canonical_document);
  return { response, accepted: head, canonicalDocument: response.data.canonical_document,
    graph: {}, receipt: response.receipt };
}

function moveSave(before: ReturnType<typeof canonical>, after: ReturnType<typeof canonical>, at: number): LocalSave {
  return { before: toOutboxJson(before), after: toOutboxJson(after), label: 'Move clip', commands: [{
    schema_version: 1, op: 'clip.move', version: '1', select: 'parent/clip:x',
    args: { on: at }, expect: { 'parent/clip:x::at': { state: 'present', value: (before.parent_revision.payload as { clips: [{ at: number }] }).clips[0].at } },
  }] };
}

function environment() {
  const initialDocument = canonical();
  const initial: TimelineCommandBasis = { head: h0, canonicalDocument: initialDocument };
  const factory = createFakeIndexedDB();
  const outboxes = createCommitOutbox({ indexedDB: factory, exclusiveLock: async (_key, work) => work() });
  const send = vi.fn<(request: CommitRequest, key: string) => Promise<TimelineCommitResult>>();
  const prepareDisplay = vi.fn(async (basis: TimelineCommandBasis, draft?: OutboxJson) => {
    const document = structuredClone(draft ?? toOutboxJson(basis.canonicalDocument));
    return { document, adopt: vi.fn() };
  });
  const mount = (basis = initial) => createLocalSaveSession({ scope, initial: basis,
    document: toOutboxJson(basis.canonicalDocument), outboxes, send, loadLatest: async () => initial,
    prepareDisplay, changed: () => {} });
  const appendMove = async (session: LocalSaveSession, before: ReturnType<typeof canonical>, at: number) => {
    const after = canonical(at);
    await session.append(moveSave(before, after, at));
    return after;
  };
  return { initial, outboxes, send, mount, appendMove };
}

describe('local save replay protocol', () => {
  it('retains an unsaved B preview after uncertain A without an ephemeral transmission', async () => {
    const env = environment();
    const first = await env.mount();
    const afterA = await env.appendMove(first, env.initial.canonicalDocument, 5);
    env.send.mockRejectedValueOnce(new Error('Lost acknowledgement'));
    await expect(first.flush()).rejects.toThrow('unacknowledged');
    const [original] = await env.outboxes.list(scope);
    const wireA = structuredClone(env.send.mock.calls[0]);
    const afterB = await env.appendMove(first, afterA, 7);
    expect(first.getDocument()).toEqual(afterB);
    expect(env.send.mock.calls).toEqual([wireA]);
    const [retained] = await env.outboxes.list(scope);
    expect(retained.intents).toHaveLength(2);
    expect(retained.pending).toEqual(original.pending);
    await first.dispose();

    const recovered = await env.mount();
    env.send.mockImplementationOnce(async (request, key) => {
      expect([request, key]).toEqual(wireA);
      return result(afterA, h1);
    }).mockImplementationOnce(async (request) => {
      expect(request).toMatchObject({ base_revision_id: h1.revisionId, base_publication_id: h1.publicationId,
        commands: [{ args: { on: 7 }, expect: { 'parent/clip:x::at': { state: 'present', value: 5 } } }] });
      return result(afterB, h2, h1);
    });
    await recovered.recover(retained.ownerId);
    expect(env.send.mock.calls[1]).toEqual(wireA);
    expect(recovered.getState().status).toBe('saved');
    await recovered.dispose();
  });

});

import { describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { ApiError } from '@/integrations/runtime/generated.ts';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { CanonicalDocument, CommitRequest } from '@/integrations/runtime/generated.ts';
import type { TimelineCommandBasis, TimelineCommitResult } from '../data/DataProvider.ts';
import { createTimelineLocalSaveHandoff } from '../hooks/timelineLocalSaveHandoff.ts';
import { createDefaultTimelineConfig } from '../lib/defaults.ts';
import { createCommitOutbox, toOutboxJson, type OutboxRecord } from './commitOutbox.ts';
import { createLocalSaveSession } from './localSaveSession.ts';

const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-commit' };
const h0 = { revisionId: 'r0', publicationId: 'p0' };
const h1 = { revisionId: 'r1', publicationId: 'p1' };

function documentPair() {
  const document = acceptedCommit({ revision_id: h0.revisionId, publication_id: h0.publicationId },
    { revision_id: h0.revisionId, publication_id: h0.publicationId }, { children: true }).data.canonical_document;
  const payload = document.parent_revision.payload as Record<string, unknown>;
  payload.config = { tracks: [{ id: 'V1', label: 'Initial' }] };
  payload.tracks = [{ id: 'V1', label: 'Initial' }];
  payload.clips = [];
  payload.registry = { assets: {} };
  document.parent_revision.content_digest = fixtureDigest(payload);
  const afterA = structuredClone(document);
  (afterA.parent_revision.payload as Record<string, unknown>).tracks = [{ id: 'V1', label: 'A' }];
  (afterA.parent_revision.payload as Record<string, unknown>).config = { tracks: [{ id: 'V1', label: 'A' }] };
  const afterB = structuredClone(afterA);
  (afterB.parent_revision.payload as Record<string, unknown>).tracks = [{ id: 'V1', label: 'B' }];
  (afterB.parent_revision.payload as Record<string, unknown>).config = { tracks: [{ id: 'V1', label: 'B' }] };
  return { document, afterA, afterB };
}

function acceptedResult(document: CanonicalDocument, head = h1): TimelineCommitResult {
  const response = acceptedCommit({ revision_id: head.revisionId, publication_id: head.publicationId },
    { revision_id: h0.revisionId, publication_id: h0.publicationId });
  response.data.canonical_document = structuredClone(document);
  response.data.canonical_document.parent_revision.revision_id = head.revisionId;
  response.data.canonical_document.parent_revision.content_digest = fixtureDigest(
    response.data.canonical_document.parent_revision.payload,
  );
  response.data.document_digest = fixtureDigest(response.data.canonical_document);
  return { response, accepted: head, canonicalDocument: response.data.canonical_document,
    graph: {}, receipt: response.receipt };
}

async function editOwner(factory: IDBFactory, change: (record: OutboxRecord) => void) {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open('astrid.command-outbox', 1);
    request.addEventListener('error', () => reject(request.error));
    request.addEventListener('success', () => {
      const db = request.result;
      const tx = db.transaction('owners', 'readwrite');
      const store = tx.objectStore('owners');
      const read = store.getAll();
      read.addEventListener('success', () => {
        for (const record of read.result as OutboxRecord[]) {
          change(record);
          store.put(record, JSON.stringify([scope.realmId, scope.actorId, scope.projectId, scope.timelineId, record.ownerId]));
        }
      });
      tx.addEventListener('complete', () => { db.close(); resolve(); });
      tx.addEventListener('abort', () => { db.close(); reject(tx.error); });
    });
  });
}

function environment() {
  const pair = documentPair();
  const initial: TimelineCommandBasis = { head: h0, canonicalDocument: pair.document };
  const factory = createFakeIndexedDB();
  const locks = new Set<string>();
  const outboxes = createCommitOutbox({ indexedDB: factory, exclusiveLock: async (key, work) => {
    if (locks.has(key)) throw new Error('Outbox is already claimed');
    locks.add(key);
    try { return await work(); }
    finally { locks.delete(key); }
  } });
  const send = vi.fn<(request: CommitRequest, key: string) => Promise<TimelineCommitResult>>();
  const adopt = vi.fn();
  const changed = vi.fn();
  const prepareDisplay = vi.fn(async (basis: TimelineCommandBasis, draft?: ReturnType<typeof toOutboxJson>) => ({
    document: draft ?? toOutboxJson(basis.canonicalDocument), adopt,
  }));
  const mount = (basis = initial) => createLocalSaveSession({ scope, initial: basis, document: toOutboxJson(basis.canonicalDocument), outboxes, send,
    loadLatest: async () => initial, prepareDisplay, changed });
  return { pair, initial, factory, outboxes, send, prepareDisplay, adopt, changed, mount };
}

describe('local save recovery basis refusals', () => {
  it.each(['missing dependent display basis', 'missing revision', 'empty revision', 'missing publication',
    'empty publication', 'missing document', 'mismatched revision'] as const)(
    'retains work without projecting or sending when recovery has a %s', async (fault) => {
      const env = environment();
      const session = await env.mount();
      const before = structuredClone(env.pair.document);
      const afterA = structuredClone(env.pair.afterA);
      const afterB = structuredClone(env.pair.afterB);
      const roots = [{ ref: 'parent' as const, revisionId: h0.revisionId,
        contentDigest: before.parent_revision.content_digest }];
      await session.appendDocument({ before, after: afterA, roots, label: 'A',
        step: { id: 'a-step', label: 'A', intent: 'A', tags: [] } });
      await session.appendDocument({ before: afterA, after: afterB, roots, label: 'B',
        step: { id: 'b-step', label: 'B', intent: 'B', tags: [] } });
      // A's cached ACK must arrive before B's retryable refusal.
      env.send.mockResolvedValueOnce(acceptedResult(afterA)).mockRejectedValueOnce(
        new ApiError(409, 'conflict', 'busy', '', { status: 'refused', reason: 'head_busy' }),
      );
      await expect(session.flush()).rejects.toThrow('unacknowledged');
      const [saved] = await env.outboxes.list(scope);
      expect(saved.accepted).toBeDefined();
      expect(saved.pending).toBeDefined();
      expect(saved.intents).toHaveLength(1);
      const original = { pending: structuredClone(saved.pending),
        accepted: structuredClone(saved.accepted) };
      const projectionCount = env.prepareDisplay.mock.calls.length;
      const adoptionCount = env.adopt.mock.calls.length;
      const sendCount = env.send.mock.calls.length;
      expect(sendCount).toBe(2);
      const originalPayload = saved.intents[0].payload as Record<string, unknown>;
      const originalBasis = originalPayload.displayBasis as { head: { revisionId?: string; publicationId?: string }; canonicalDocument?: unknown };
      expect(originalBasis).toMatchObject({ head: h0, canonicalDocument: before });
      await session.dispose();
      await editOwner(env.factory, (record) => {
        const payload = record.intents[0].payload as Record<string, unknown>;
        if (fault === 'missing dependent display basis') delete payload.displayBasis;
        else {
          const basis = payload.displayBasis as { head: { revisionId?: string; publicationId?: string }; canonicalDocument?: unknown };
          if (fault === 'missing publication') delete basis.head.publicationId;
          else if (fault === 'empty publication') basis.head.publicationId = '';
          else if (fault === 'missing revision') delete basis.head.revisionId;
          else if (fault === 'empty revision') basis.head.revisionId = '';
          else if (fault === 'missing document') delete basis.canonicalDocument;
          else basis.head.revisionId = 'another-revision';
        }
      });
      const [corrupted] = await env.outboxes.list(scope);
      const refreshed = acceptedResult(before, { revisionId: 'r2', publicationId: 'p2' });
      const reopened = await env.mount({ head: refreshed.accepted, canonicalDocument: refreshed.canonicalDocument });
      const message = 'Local saves require a verified original display basis for recovery';
      const refusal = { status: 'error', recoverableOwners: [corrupted.ownerId], error: { message } };
      await expect(reopened.recover(corrupted.ownerId)).rejects.toThrow(message);
      expect(reopened.getState()).toEqual(refusal);
      expect(env.changed).toHaveBeenLastCalledWith(refusal);
      expect(reopened.getDocument()).toEqual(refreshed.canonicalDocument);
      expect(env.prepareDisplay).toHaveBeenCalledTimes(projectionCount);
      expect(env.send).toHaveBeenCalledTimes(sendCount);
      expect(() => reopened.append({ before: afterB, after: afterB, label: 'C', commands: [{
        schema_version: 1, op: 'doc.patch', version: '1', select: null, args: { changes: [] },
      }] })).toThrow(message);
      expect(() => reopened.appendDocument({ before: afterB, after: afterB, roots, label: 'C',
        step: { id: 'c-step', label: 'C', intent: 'C', tags: [] } }))
        .toThrow(message);
      // Recovery is the current API's explicit retry while no owner is claimed.
      await expect(reopened.recover(corrupted.ownerId)).rejects.toThrow(message);
      await expect(reopened.flush()).rejects.toThrow(message);
      // Undo availability belongs to the production handoff, not session state.
      const handoff = createTimelineLocalSaveHandoff({ initial: { head: refreshed.accepted,
        canonicalDocument: refreshed.canonicalDocument, history: {
          head: { revision_id: 'r2', publication_id: 'p2' }, next_cursor: null,
          items: [{ revision_id: 'r2', publication_id: 'p2', previous: null, intent: 'recorded',
            records: { schema_version: 1, commands: [], undo_of: [], restored_from: null },
            receipt: refreshed.receipt, provider_version: null, compiler_version: null, publisher: scope.actorId }],
        } }, source: { config: createDefaultTimelineConfig(), registry: { assets: {} }, head: {
          projectId: scope.projectId, timelineId: scope.timelineId, headRevisionId: 'r2', headPublicationId: 'p2',
        } }, session: reopened, adopted: () => { throw new Error('Refused recovery cannot adopt'); } });
      expect(handoff.remoteHistoryAvailable()).toBe(false);
      expect(handoff.canUndo()).toBe(false);
      await expect(handoff.undo()).rejects.toThrow('durable timeline history is not settled');
      expect(reopened.getState()).toEqual(refusal);
      expect(reopened.getDocument()).toEqual(refreshed.canonicalDocument);
      expect(env.prepareDisplay).toHaveBeenCalledTimes(projectionCount);
      expect(env.adopt).toHaveBeenCalledTimes(adoptionCount);
      expect(env.send).toHaveBeenCalledTimes(sendCount);
      const [retained] = await env.outboxes.list(scope);
      expect(retained.intents).toEqual(corrupted.intents);
      expect(JSON.stringify(retained.intents)).toBe(JSON.stringify(corrupted.intents));
      expect(retained.pending).toEqual(original.pending);
      expect(retained.accepted).toEqual(original.accepted);
      expect(JSON.stringify(retained.pending)).toBe(JSON.stringify(original.pending));
      expect(JSON.stringify(retained.accepted)).toBe(JSON.stringify(original.accepted));
      // Repair only the authoritative stored basis through the same storage path.
      await editOwner(env.factory, (record) => {
        (record.intents[0].payload as Record<string, unknown>).displayBasis = structuredClone(originalBasis);
      });
      env.send.mockRejectedValueOnce(new ApiError(409, 'conflict', 'busy', '', { status: 'refused', reason: 'head_busy' }));
      const recovering = reopened.recover(corrupted.ownerId);
      await expect(reopened.recover(corrupted.ownerId)).rejects.toThrow('already claimed');
      await recovering;
      expect(reopened.getState().status).toBe('retry');
      expect(env.send.mock.lastCall).toEqual(env.send.mock.calls[1]);
      await expect(reopened.recover(corrupted.ownerId)).rejects.toThrow('Choose an explicitly listed local save owner');
      const competing = await env.mount();
      await expect(competing.recover(corrupted.ownerId)).rejects.toThrow('already claimed');
      expect(env.send).toHaveBeenCalledTimes(sendCount + 1);
      await competing.dispose();
      env.send.mockResolvedValueOnce(acceptedResult(afterB));
      await reopened.flush();
      expect(env.send.mock.lastCall).toEqual(env.send.mock.calls[1]);
      expect(reopened.getState().status).toBe('saved');
      expect(handoff.canUndo()).toBe(true);
      await reopened.dispose();
    });

  it('replays a valid dependent at its accepted prefix despite a refreshed mount', async () => {
    const env = environment();
    const session = await env.mount();
    const { document: before, afterA, afterB } = env.pair;
    const roots = [{ ref: 'parent' as const, revisionId: h0.revisionId,
      contentDigest: before.parent_revision.content_digest }];
    await session.appendDocument({ before, after: afterA, roots, label: 'A',
      step: { id: 'a-step', label: 'A', intent: 'A', tags: [] } });
    await session.appendDocument({ before: afterA, after: afterB, roots, label: 'B',
      step: { id: 'b-step', label: 'B', intent: 'B', tags: [] } });
    const acceptedA = acceptedResult(afterA);
    env.send.mockResolvedValueOnce(acceptedA).mockRejectedValueOnce(
      new ApiError(409, 'conflict', 'busy', '', { status: 'refused', reason: 'head_busy' }),
    );
    await expect(session.flush()).rejects.toThrow('unacknowledged');
    const [saved] = await env.outboxes.list(scope);
    const exact = structuredClone(env.send.mock.calls[1]);
    expect(saved.intents[0].payload).toMatchObject({ displayBasis: { head: h0 },
      documentIntent: { basis: { after: saved.accepted!.intentId } } });
    await session.dispose();
    const h2 = { revisionId: 'r2', publicationId: 'p2' };
    const refreshed = acceptedResult(before, h2);
    const reopened = await env.mount({ head: h2, canonicalDocument: refreshed.canonicalDocument });
    const acceptedB = acceptedResult(afterB, h2);
    env.send.mockImplementationOnce(async (request, key) => {
      expect([request, key]).toEqual(exact);
      expect(request).toMatchObject({ base_revision_id: h1.revisionId, base_publication_id: h1.publicationId });
      expect(env.prepareDisplay.mock.lastCall).toEqual([{ head: h1,
        canonicalDocument: acceptedA.canonicalDocument, graph: acceptedA.graph }]);
      expect(reopened.getDocument()).toEqual(acceptedA.canonicalDocument);
      expect(() => reopened.append({ before: toOutboxJson(acceptedA.canonicalDocument),
        after: toOutboxJson(afterB), label: 'C' })).toThrow('revalidation');
      return acceptedB;
    });
    await reopened.recover(saved.ownerId);
    expect(env.send).toHaveBeenCalledTimes(3);
    expect(reopened.getState().status).toBe('saved');
    expect(reopened.getDocument()).toEqual(acceptedB.canonicalDocument);
    expect(acceptedB.canonicalDocument.shot_revisions).toEqual(before.shot_revisions);
    expect(acceptedB.canonicalDocument.internal_timeline_revisions).toEqual(before.internal_timeline_revisions);
    expect(acceptedB.canonicalDocument.parent_revision.payload.unknown).toEqual(before.parent_revision.payload.unknown);
    await reopened.dispose();
  });
});

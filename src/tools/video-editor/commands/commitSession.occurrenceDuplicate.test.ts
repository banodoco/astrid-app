import { createFakeIndexedDB } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { CanonicalDocument, CommitRequest } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelineCommandBasis, TimelineCommitResult } from '../data/DataProvider.ts';
import { buildTimelineData } from '../lib/timeline-data.ts';
import type { AssetRegistry, TimelineConfig } from '../types/index.ts';
import { copy } from './clipMovePrimitives.ts';
import { createCommitOutbox } from './commitOutbox.ts';
import { createTimelineCommandSession } from './commitSession.ts';
import { captureOccurrenceDuplicateEdit, submitOccurrenceDuplicateEdit } from './occurrenceDuplicateGesture.ts';
import fixture from './fixtures/recipe_m2_app_occurrence_duplicate.json';

const initialDocument = fixture.bundle.source_mapping._runtime_document as unknown as CanonicalDocument;
const acceptedDocument = fixture.after_document as unknown as CanonicalDocument;
const scope = { projectId: 'project-1', timelineId: 'film', realmId: 'realm-1', actorId: 'actor-1' };
const args = { occurrence_id: 'occ-copy', shot_id: 'shot-copy' };
const owner = 'occurrence:occ-0';
const initialHead = { revisionId: initialDocument.parent_revision.revision_id, publicationId: 'p0' };

async function setup() {
  const held = new Set<string>();
  const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (key, work) => {
    if (held.has(key)) throw new Error('claimed');
    held.add(key);
    try { return await work(); } finally { held.delete(key); }
  } });
  const initial: TimelineCommandBasis = { head: initialHead, canonicalDocument: copy(initialDocument) };
  const display = (basis: TimelineCommandBasis) => {
    const parent = basis.canonicalDocument.parent_revision.payload;
    return buildTimelineData(parent.config as TimelineConfig, parent.registry as AssetRegistry, undefined, 1, undefined, {
      projectId: scope.projectId, timelineId: scope.timelineId,
      headRevisionId: basis.head.revisionId, headPublicationId: basis.head.publicationId,
    });
  };
  let current = await display(initial);
  const calls: { body: string; request: CommitRequest; key: string }[] = [];
  const previews = vi.fn();
  let result: TimelineCommitResult | undefined;
  let inverseResult: TimelineCommitResult | undefined;
  let lost = false;
  const send = async (request: CommitRequest, key: string): Promise<TimelineCommitResult> => {
    calls.push({ body: JSON.stringify(request), request: copy(request), key });
    if (request.commands[0]?.op === 'timeline.inverse') {
      if (!inverseResult) {
        const response = acceptedCommit({ revision_id: 'rev-undo', publication_id: 'p2' },
          { revision_id: request.base_revision_id, publication_id: request.base_publication_id }, {
            projectId: scope.projectId, timelineId: scope.timelineId, commands: request.commands,
          });
        response.data.canonical_document = copy(initialDocument);
        response.data.document_digest = fixtureDigest(initialDocument);
        response.receipt.result = response.data;
        response.receipt.idempotency_key = key;
        inverseResult = { response, canonicalDocument: copy(initialDocument), graph: {}, receipt: response.receipt,
          accepted: { revisionId: 'rev-undo', publicationId: 'p2' } };
      }
      return copy(inverseResult);
    }
    if (!result) {
      expect(request.commands).toEqual([fixture.command]);
      const response = acceptedCommit({ revision_id: acceptedDocument.parent_revision.revision_id, publication_id: 'p1' },
        { revision_id: request.base_revision_id, publication_id: request.base_publication_id }, {
          projectId: scope.projectId, timelineId: scope.timelineId, commands: request.commands,
        });
      response.data.canonical_document = copy(acceptedDocument);
      response.data.document_digest = fixtureDigest(acceptedDocument);
      response.receipt.result = response.data;
      response.receipt.idempotency_key = key;
      result = { response, canonicalDocument: copy(acceptedDocument), graph: {}, receipt: response.receipt,
        accepted: { revisionId: acceptedDocument.parent_revision.revision_id, publicationId: 'p1' } };
    } else expect(calls.at(-1)).toEqual(calls[0]);
    if (lost) { lost = false; throw new Error('lost acknowledgement'); }
    return copy(result);
  };
  const mount = () => createTimelineCommandSession({ scope, initial, outboxes, send, changed: () => {}, preview: previews,
    project: async (basis, patches) => {
      expect(patches).toEqual([]);
      current = await display(basis);
    },
  });
  return { mount, outboxes, calls, previews, current: () => current, loseAck: () => { lost = true; } };
}

describe('occurrence duplicate through the command session', () => {
  it('refuses a stale displayed head before creating an outbox intent', async () => {
    const env = await setup();
    const session = await env.mount();
    const stale = { ...env.current(), head: { ...env.current().head!, headRevisionId: 'stale-revision' } };

    expect(() => captureOccurrenceDuplicateEdit(session.occurrenceDuplicatePort, stale, owner, args))
      .toThrow('Displayed timeline does not match the raw authoring basis');
    expect((await env.outboxes.list(scope))[0].intents).toEqual([]);
    await session.dispose();
  });

  it('keeps one outbox intent and retries the exact request after a lost acknowledgement and restart', async () => {
    const env = await setup();
    const session = await env.mount();
    env.loseAck();
    submitOccurrenceDuplicateEdit(captureOccurrenceDuplicateEdit(session.occurrenceDuplicatePort, env.current(), owner, args));
    await vi.waitFor(() => expect(session.getState().status).toBe('retry'));

    const [stored] = await env.outboxes.list(scope);
    expect(stored.intents).toHaveLength(1);
    expect(stored.pending?.request.body).toBe(env.calls[0].body);
    expect(stored.pending?.request.key).toBe(env.calls[0].key);
    expect(env.calls[0].request.commands).toEqual([fixture.command]);
    expect(env.previews).not.toHaveBeenCalled();

    await session.dispose();
    const reopened = await env.mount();
    expect(reopened.getState().status).toBe('recovery');
    await reopened.recover(stored.ownerId);
    await reopened.flush();

    expect(env.calls).toHaveLength(2);
    expect(env.calls[1]).toEqual(env.calls[0]);
    expect((await env.outboxes.list(scope))[0].intents).toEqual([]);
    await reopened.dispose();
  });

  it('uses the existing guarded inverse for the accepted duplicate', async () => {
    const env = await setup();
    const session = await env.mount();
    submitOccurrenceDuplicateEdit(captureOccurrenceDuplicateEdit(session.occurrenceDuplicatePort, env.current(), owner, args));
    await session.flush();

    await session.undo();
    await session.flush();

    expect(env.calls).toHaveLength(2);
    expect(env.calls[1].request.commands).toEqual([{
      schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
      args: { publications: ['p1'] },
    }]);
    expect((await env.outboxes.list(scope))[0].intents).toEqual([]);
    await session.dispose();
  });
});

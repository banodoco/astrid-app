import { describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { WorkspaceClient, type Transport } from '@/integrations/runtime/generated.ts';
import type { CommitRequest } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelineCommandBasis, TimelineCommitResult } from '../data/DataProvider.ts';
import { createCommitOutbox, toOutboxJson } from './commitOutbox.ts';
import { createLocalSaveSession } from './localSaveSession.ts';

vi.mock('@/integrations/runtime/generated-contract-metadata.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/integrations/runtime/generated-contract-metadata.ts')>(),
  SCHEMA_DIGEST: 'sha256:35c2d9c5e0b51ab8d8b7a4f4dbafbdfcb13d232d7bd22fff21cf73e250398d4c',
}));

describe('official full-v2 local document transport', () => {
  it('restarts the exact request with reads and step metadata, then sends the original new-ID dependent at the accepted pair', async () => {
    const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-commit' };
    const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (_name, work) => work() });
    const head = { revisionId: 'r0', publicationId: 'p0' };
    const before = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }).data.canonical_document;
    before.parent_revision.payload = { clips: [{ id: 'left', at: 0, hold: 4 }], opaque: { keep: null } };
    before.parent_revision.content_digest = fixtureDigest(before.parent_revision.payload);
    const split = structuredClone(before);
    split.parent_revision.payload.clips = [{ id: 'left', at: 0, hold: 2 }, { id: 'right', at: 2, hold: 2 }];
    const trimmed = structuredClone(split);
    (trimmed.parent_revision.payload.clips as Array<Record<string, unknown>>)[1].hold = 1;
    const initial: TimelineCommandBasis = { head, canonicalDocument: before };
    const reads = [{ kind: 'field', ref: 'parent', path: ['opaque', 'keep'], state: { state: 'present', value: null } }];
    const step = { id: 'split-step', label: 'Split', intent: 'Split the authored clip', tags: ['editing'], reads };
    const roots = [{ ref: 'parent' as const, revisionId: 'r0', contentDigest: before.parent_revision.content_digest }];
    const send = vi.fn<(request: CommitRequest, key: string) => Promise<TimelineCommitResult>>();
    const sent: Parameters<Transport>[] = [];
    const client = new WorkspaceClient('http://runtime.test', 'token', async (...args) => {
      sent.push(args);
      throw new Error('Lost acknowledgement');
    });
    const visible: unknown[] = [];
    const mount = () => createLocalSaveSession({ scope, initial, document: toOutboxJson(before), outboxes, send,
      loadLatest: async () => initial, changed: () => {}, prepareDisplay: async (basis, draft) => ({
        document: draft ?? toOutboxJson(basis.canonicalDocument), adopt() { visible.push(basis.canonicalDocument); },
      }) });
    const first = await mount();
    await first.appendDocument({ before, after: split, roots, label: 'Split', step, merge: 'fields', reads });
    await first.appendDocument({ before: split, after: trimmed, roots, label: 'Trim',
      step: { id: 'trim-step', label: 'Trim', intent: 'Trim the new clip', tags: [] } });
    send.mockImplementationOnce(async (request, key) => {
      await client.commitTimeline(scope.projectId, scope.timelineId, request, key);
      throw new Error('Transport must lose the acknowledgement');
    });
    await expect(first.flush()).rejects.toThrow('unacknowledged');
    const [stored] = await outboxes.list(scope);
    const exact = stored.pending!.request;
    const request = JSON.parse(exact.body);
    expect(request).toMatchObject({ label: 'Split', merge: 'fields', reads, dry_run: false,
      steps: [{ ...step, command_ordinals: [0], patch: request.commands[0].args.changes }] });
    expect(request.commands[0]).toEqual({ schema_version: 1, op: 'doc.patch', version: '1', select: null,
      created: ['parent/clip:right'], args: { changes: request.steps[0].patch } });
    expect(send.mock.calls[0][0]).toEqual(request);
    expect(sent[0].slice(0, 2)).toEqual(['POST', exact.path]);
    expect(sent[0][2]['Idempotency-Key']).toBe(exact.key);
    expect(new TextDecoder().decode(sent[0][3])).toBe(exact.body);
    expect(stored.intents[0].payload).toMatchObject({ documentIntent: { created: ['parent/clip:right'] } });
    const suffix = structuredClone(stored.intents[1].payload);
    await first.dispose();
    const recovered = await mount();
    const reply = (document: typeof before, revision: string, publication: string): TimelineCommitResult => {
      const response = acceptedCommit({ revision_id: revision, publication_id: publication }, { revision_id: 'r0', publication_id: 'p0' });
      response.data.canonical_document = structuredClone(document);
      response.data.canonical_document.parent_revision.revision_id = revision;
      response.data.canonical_document.parent_revision.payload.opaque = { keep: null, agent: true };
      Object.assign(response.data, { status: 'merged', merge_mode: 'atomic', steps: [{ ...step,
        command_ordinals: [0], patch: request.commands[0].args.changes, dependencies: reads }] });
      return { response, accepted: { revisionId: revision, publicationId: publication },
        canonicalDocument: response.data.canonical_document, graph: {}, receipt: response.receipt };
    };
    send.mockImplementationOnce(async (retry, key) => {
      expect(JSON.stringify(retry)).toBe(exact.body);
      expect(retry.commands[0].created).toEqual(['parent/clip:right']);
      expect(key).toBe(exact.key);
      await expect(client.commitTimeline(scope.projectId, scope.timelineId, retry, key)).rejects.toThrow('Lost acknowledgement');
      expect(sent[1]).toEqual(sent[0]);
      return reply(split, 'r1', 'p1');
    }).mockImplementationOnce(async (dependent) => {
      expect(visible.at(-1)).toMatchObject({ parent_revision: { revision_id: 'r1', payload: {
        clips: split.parent_revision.payload.clips, opaque: { keep: null, agent: true },
      } } });
      expect(recovered.getDocument()).toMatchObject({ parent_revision: { revision_id: 'r1' } });
      expect(dependent).not.toHaveProperty('reads');
      expect(dependent.commands[0].created).toEqual([]);
      expect(dependent).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p1', merge: 'atomic',
        commands: [{ args: { changes: [{ op: 'set', ref: 'parent', path: ['clips', 'id:right', 'hold'],
          before: { state: 'present', value: 2 }, value: 1 }] } }] });
      expect((await outboxes.list(scope))[0].intents[0].payload).toEqual(suffix);
      expect((await outboxes.list(scope))[0].accepted?.value).toMatchObject({ response: { data: {
        status: 'merged', steps: [{ dependencies: reads }],
      } } });
      return reply(trimmed, 'r2', 'p2');
    });
    await recovered.recover(stored.ownerId);
    expect(recovered.getState().status).toBe('saved');
    expect(visible.at(-1)).toMatchObject({ parent_revision: { revision_id: 'r2', payload: { opaque: { keep: null, agent: true } } } });
    await recovered.dispose();
  });
});

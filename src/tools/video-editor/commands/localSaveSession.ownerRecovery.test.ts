import { describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { CanonicalDocument, CommitRequest } from '@/integrations/runtime/generated.ts';
import { createCommitOutbox, toOutboxJson, type OutboxExclusiveLock, type OutboxRequest } from './commitOutbox.ts';
import { createLocalSaveSession } from './localSaveSession.ts';
import { environment, h0, scope } from './__tests__/localSaveSessionEnvironment.ts';

function statefulExclusiveLock() {
  type LockRequest = { name: string; held: boolean; released: Promise<void> };
  const active = new Map<string, LockRequest>();
  const history: LockRequest[] = [];
  const exclusiveLock: OutboxExclusiveLock = async (name, work) => {
    if (active.has(name)) throw new Error('claimed');
    let release!: () => void;
    const request: LockRequest = { name, held: true, released: new Promise<void>((resolve) => { release = resolve; }) };
    active.set(name, request);
    history.push(request);
    try {
      return await work();
    } finally {
      request.held = false;
      active.delete(name);
      release();
    }
  };
  const requestsFor = (ownerId: string) => history.filter((request) => request.name.endsWith(`${JSON.stringify(ownerId)}]`));
  return {
    exclusiveLock,
    heldFor(ownerId: string) { return requestsFor(ownerId).at(-1)?.held === true; },
    async releasedFor(ownerId: string) { await requestsFor(ownerId).at(-1)?.released; },
  };
}

function ownerRecoveryEnvironment() {
  const env = environment();
  const initial = env.initial.canonicalDocument as CanonicalDocument;
  const payload = initial.parent_revision.payload as Record<string, unknown>;
  const clip = { id: 'x', track: 'V1', at: 1, hold: 1, text: { content: 'keep' }, app: { opaque: null } };
  payload.clips = [clip];
  (payload.config as Record<string, unknown>).clips = [structuredClone(clip)];
  payload.opaque = { preserved: null, nested: [false, null] };
  initial.parent_revision.content_digest = fixtureDigest(payload);

  const authored: CanonicalDocument[] = [];
  const requests: Array<{ request: OutboxRequest; body: CommitRequest }> = [];
  env.send.mockImplementation(async (body, key) => {
    requests.push({ request: { method: 'POST', path: `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`,
      body: JSON.stringify(body), key }, body: structuredClone(body) });
    if (requests.length === 1) throw new Error('lost acknowledgement');
    const document = authored[requests.length - 2];
    if (!document) throw new Error('Missing authored owner-recovery document');
    return env.accepted(document, { revisionId: `r${requests.length - 1}`, publicationId: `p${requests.length - 1}` });
  });

  const lock = statefulExclusiveLock();
  const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: lock.exclusiveLock });
  const mount = (basis = env.initial) => createLocalSaveSession({ scope, initial: basis,
    document: toOutboxJson(basis.canonicalDocument), outboxes, send: env.send,
    loadLatest: async () => basis, prepareDisplay: env.prepareDisplay, changed: () => {} });

  const move = async (session: Awaited<ReturnType<typeof env.mount>>, on: number) => {
    const before = session.getDocument() as unknown as CanonicalDocument;
    const after = structuredClone(before);
    const next = after.parent_revision.payload as Record<string, unknown>;
    const nextClip = (next.clips as Array<Record<string, unknown>>)[0];
    nextClip.at = on;
    ((next.config as Record<string, unknown>).clips as Array<Record<string, unknown>>)[0].at = on;
    authored.push(after);
    await session.appendDocument({ before, after, roots: [{ ref: 'parent', revisionId: h0.revisionId,
      contentDigest: initial.parent_revision.content_digest }], label: 'Move clip',
    step: { id: `move-${on}`, label: 'Move clip', intent: `Move clip to ${on}`, tags: ['editing'] } });
    return after;
  };

  return { ...env, authored, requests, move, outboxes, mount, lock };
}

describe('local save owner recovery', () => {
  it('recovers an explicitly chosen owner and retries the exact pending A before B', async () => {
    const env = ownerRecoveryEnvironment();
    const first = await env.mount();
    const before = structuredClone(env.initial.canonicalDocument);
    const afterA = await env.move(first, 5);
    const afterB = await env.move(first, 7);
    await expect(first.flush()).rejects.toThrow('unacknowledged');
    await vi.waitFor(() => expect(first.getState().status).toBe('retry'));
    const owner = first.getState().ownerId!;
    expect(env.lock.heldFor(owner)).toBe(true);
    const [stored] = await env.outboxes.list(scope);
    const originalA = { ...env.requests[0], body: structuredClone(env.requests[0].body) };

    expect(first.getDocument()).toEqual(afterB);
    expect(stored.pending?.request).toMatchObject(originalA.request);
    expect(JSON.parse(stored.pending!.request.body)).toEqual(originalA.body);
    expect(stored.intents).toHaveLength(2);
    expect(stored.intents[1].basis).toEqual({ after: stored.intents[0].id });
    expect(stored.intents[1].payload).toMatchObject({
      displayBasis: { head: h0 },
      documentIntent: { basis: { after: stored.intents[0].id }, before: afterA, after: afterB,
        changes: expect.arrayContaining([{ op: 'set', ref: 'parent', path: ['clips', 'id:x', 'at'],
          before: { state: 'present', value: 5 }, value: 7 }]) },
    });
    expect((stored.intents[1].payload as { displayBasis: { canonicalDocument: CanonicalDocument } }).displayBasis.canonicalDocument)
      .toEqual(before);
    expect((before.parent_revision.payload as Record<string, unknown>)).not.toHaveProperty('bundle');
    expect(((before.parent_revision.payload as Record<string, unknown>).clips as Array<Record<string, unknown>>)[0].app)
      .toEqual({ opaque: null });
    expect((before.parent_revision.payload as Record<string, unknown>).opaque).toEqual({ preserved: null, nested: [false, null] });
    const documentIntent = (stored.intents[1].payload as { documentIntent: { before: CanonicalDocument; after: CanonicalDocument } }).documentIntent;
    expect(documentIntent.before).toEqual(afterA);
    expect(documentIntent.after).toEqual(afterB);
    expect((before.parent_revision.payload as Record<string, unknown>)).not.toHaveProperty('absent');

    await first.dispose();
    const reopened = await env.mount();
    expect(reopened.getState()).toMatchObject({ status: 'recovery', recoverableOwners: [owner] });
    expect(env.requests).toHaveLength(1);
    await reopened.recover(owner);

    expect(env.requests[1]).toEqual(originalA);
    expect(env.requests).toHaveLength(3);
    const retryA = env.requests[1];
    const retryB = env.requests[2];
    expect(retryB.body.base_revision_id).toBe('r1');
    expect(retryB.body.base_publication_id).toBe('p1');
    expect(retryB.request.key).not.toBe(retryA.request.key);
    expect(retryB.body.commands[0]).toMatchObject({ op: 'doc.patch', args: { changes: expect.arrayContaining([
      expect.objectContaining({ op: 'set', path: ['clips', 'id:x', 'at'],
        before: { state: 'present', value: 5 }, value: 7 }),
    ]) } });
    expect(env.requests.map(({ request }) => request.key)).toEqual([
      originalA.request.key, originalA.request.key, retryB.request.key,
    ]);
    expect(env.requests.every(({ request }) => request.path.endsWith('/commit'))).toBe(true);
    expect(env.requests.every(({ body }) => body.source?.via === 'app'
      && body.commands.every((command) => command.op === 'doc.patch'))).toBe(true);
    expect(env.visible()).toMatchObject({
      parent_revision: { payload: afterB.parent_revision.payload, revision_id: 'r2' },
      shot_revisions: before.shot_revisions,
      internal_timeline_revisions: before.internal_timeline_revisions,
      dependency_manifest: before.dependency_manifest,
    });
    expect(reopened.getState().status).toBe('saved');
    await reopened.dispose();
  });

  it('keeps recovery explicit and permits a later claim after the live owner releases its lock', async () => {
    const env = ownerRecoveryEnvironment();
    const first = await env.mount();
    await env.move(first, 5);
    await expect(first.flush()).rejects.toThrow('unacknowledged');
    await vi.waitFor(() => expect(first.getState().status).toBe('retry'));
    const owner = first.getState().ownerId!;
    const originalA = { ...env.requests[0], body: structuredClone(env.requests[0].body) };
    const second = await env.mount();

    expect(second.getState()).toMatchObject({ status: 'recovery', recoverableOwners: [owner] });
    expect(env.lock.heldFor(owner)).toBe(true);
    await expect(second.recover(owner)).rejects.toThrow('claimed');
    expect(env.requests).toHaveLength(1);
    await first.dispose();
    await env.lock.releasedFor(owner);
    expect(env.lock.heldFor(owner)).toBe(false);
    await second.recover(owner);
    expect(env.requests[1]).toEqual(originalA);
    expect(env.requests).toHaveLength(2);
    expect(second.getState().status).toBe('saved');
    await second.dispose();
  });
});

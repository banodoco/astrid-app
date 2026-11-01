import { describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { CanonicalDocument } from '@/integrations/runtime/generated.ts';
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

function lifecycleEnvironment() {
  const env = environment();
  const lock = statefulExclusiveLock();
  const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: lock.exclusiveLock });
  const mount = (basis = env.initial) => createLocalSaveSession({ scope, initial: basis,
    document: toOutboxJson(basis.canonicalDocument), outboxes, send: env.send,
    loadLatest: async () => basis, prepareDisplay: env.prepareDisplay, changed: () => {} });
  const initial = env.initial.canonicalDocument as CanonicalDocument;
  const payload = initial.parent_revision.payload as Record<string, unknown>;
  const clip = { id: 'x', track: 'V1', at: 1, hold: 1, text: { content: 'keep' }, app: { opaque: null } };
  payload.clips = [clip];
  (payload.config as Record<string, unknown>).clips = [structuredClone(clip)];
  initial.parent_revision.content_digest = fixtureDigest(payload);
  const authored: CanonicalDocument[] = [];
  const requests: Array<{ request: OutboxRequest; body: Record<string, unknown> }> = [];
  env.send.mockImplementation(async (body, key) => {
    requests.push({ request: { method: 'POST', path: `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`, body: JSON.stringify(body), key }, body });
    const document = authored.at(Math.min(requests.length - 1, authored.length - 1));
    if (!document) throw new Error('Missing authored lifecycle document');
    return env.accepted(document, { revisionId: `r${requests.length}`, publicationId: `p${requests.length}` });
  });
  const move = async (session: Awaited<ReturnType<typeof mount>>, on: number) => {
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
  const commits = () => requests.map(({ body, request }) => ({ path: request.path, method: request.method, body, key: request.key }));
  return { ...env, outboxes, mount, lock, initial, authored, requests, move, commits };
}

describe('local save session close and recovery lifecycle', () => {
  it('drains a just-submitted gesture on dispose without flushing or starting a request', async () => {
    const env = lifecycleEnvironment();
    const session = await env.mount();
    const owner = session.getState().ownerId!;
    await env.move(session, 5);
    await session.dispose();
    expect(env.commits()).toHaveLength(0);
    const [saved] = await env.outboxes.list(scope);
    expect(saved.intents).toHaveLength(1);
    expect(saved.intents[0].payload).toMatchObject({ documentIntent: { changes: [
      { op: 'set', ref: 'parent', path: ['clips', 'id:x', 'at'], value: 5 },
    ] } });
    await expect(env.move(session, 7)).rejects.toThrow('closed or awaiting recovery');
    const reopened = await env.mount();
    expect(reopened.getState().recoverableOwners).toEqual([owner]);
    await reopened.recover(owner);
    expect(env.commits()[0].body?.commands[0].args.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['clips', 'id:x', 'at'], before: { state: 'present', value: 1 }, value: 5 }),
    ]));
    expect((reopened.getDocument() as unknown as CanonicalDocument).parent_revision.payload.clips[0].at).toBe(5);
    await reopened.dispose();
  });

  it('holds the claim until an already-started durable append finishes', async () => {
    const env = lifecycleEnvironment();
    let finishAppend!: () => void;
    const gate = new Promise<void>((resolve) => { finishAppend = resolve; });
    const create = env.outboxes.create;
    const appending = vi.fn();
    env.outboxes.create = (outboxScope, work) => create(outboxScope, (box, owner) => work({ ...box, append: async (...args) => {
      appending();
      await gate;
      return box.append(...args);
    } }, owner));
    const session = await env.mount();
    const owner = session.getState().ownerId!;
    expect(env.lock.heldFor(owner)).toBe(true);
    const moving = env.move(session, 5);
    await vi.waitFor(() => expect(appending).toHaveBeenCalledOnce());
    expect(env.lock.heldFor(owner)).toBe(true);
    const closed = vi.fn();
    const closing = session.dispose().then(closed);
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    await expect(env.outboxes.recover(scope, owner, async () => {})).rejects.toThrow('claimed');
    finishAppend();
    await moving;
    await closing;
    await env.lock.releasedFor(owner);
    expect(env.lock.heldFor(owner)).toBe(false);
    let contenderClaimed = false;
    await env.outboxes.recover(scope, owner, async () => { contenderClaimed = true; });
    expect(contenderClaimed).toBe(true);
    expect((await env.outboxes.list(scope))[0].intents).toHaveLength(1);
    expect(env.commits()).toHaveLength(0);
  });

  it.each(['accepted', 'error'] as const)('releases without A network completion, retains queued B and fences late %s', async (outcome) => {
    const env = lifecycleEnvironment();
    const session = await env.mount();
    let finishNetwork!: (result: void | PromiseLike<void>) => void;
    let failNetwork!: (error: Error) => void;
    const network = new Promise<void>((resolve, reject) => { finishNetwork = resolve; failNetwork = reject; });
    env.send.mockImplementationOnce(async (body, key) => {
      env.requests.push({ request: { method: 'POST', path: `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`, body: JSON.stringify(body), key }, body });
      await network;
      if (outcome === 'error') throw new Error('late network error');
      return env.accepted(env.authored[0], { revisionId: 'r1', publicationId: 'p1' });
    });
    const a = await env.move(session, 5);
    const firstFlush = session.flush();
    await vi.waitFor(() => expect(env.commits()).toHaveLength(1));
    const original = structuredClone(env.commits()[0]);
    const b = await env.move(session, 7);
    await session.dispose();
    const [saved] = await env.outboxes.list(scope);
    expect(saved.intents).toHaveLength(2);
    expect(saved.pending?.request.key).toBe(original.key);
    expect(JSON.parse(saved.pending!.request.body)).toEqual(original.body);
    expect(saved.intents[1].payload).toMatchObject({ documentIntent: { changes: [
      { op: 'set', path: ['clips', 'id:x', 'at'], before: { state: 'present', value: 5 }, value: 7 },
    ] } });
    const closedState = session.getState();
    env.send.mockImplementationOnce(async (body, key) => {
      env.requests.push({ request: { method: 'POST', path: `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`, body: JSON.stringify(body), key }, body });
      return env.accepted(a, { revisionId: 'r1', publicationId: 'p1' });
    }).mockImplementationOnce(async (body, key) => {
      env.requests.push({ request: { method: 'POST', path: `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`, body: JSON.stringify(body), key }, body });
      return env.accepted(b, { revisionId: 'r2', publicationId: 'p2' });
    });
    const reopened = await env.mount();
    const recovery = reopened.recover(saved.ownerId);
    await vi.waitFor(() => expect(env.commits().length).toBeGreaterThanOrEqual(2));
    expect(env.commits()[1]).toEqual(original);
    await vi.waitFor(() => expect(env.commits()).toHaveLength(3));
    if (outcome === 'error') failNetwork(new Error('late network error'));
    else finishNetwork();
    await expect(firstFlush).rejects.toThrow('Stale outbox claim');
    await recovery;
    expect(env.commits()[2].body).toMatchObject({ base_publication_id: 'p1', commands: [{ args: { changes: [
      { path: ['clips', 'id:x', 'at'], value: 7 },
    ] } }] });
    expect(env.commits()[2].key).not.toBe(original.key);
    expect((reopened.getDocument() as unknown as CanonicalDocument).parent_revision.payload.clips[0].at).toBe(7);
    expect(session.getState()).toEqual(closedState);
    expect(reopened.getState().status).toBe('saved');
    await reopened.dispose();
  });

  it('reports a durable failure during close and never transmits the ephemeral preview', async () => {
    const env = lifecycleEnvironment();
    const create = env.outboxes.create;
    env.outboxes.create = (outboxScope, work) => create(outboxScope, (box, owner) => work({ ...box,
      append: async () => { throw new Error('Unsaved move: disk full'); },
    }, owner));
    const session = await env.mount();
    const moving = env.move(session, 5);
    await moving.catch(() => {});
    expect(session.getState()).toMatchObject({ status: 'error',
      error: { message: 'Local edit could not be persisted: Unsaved move: disk full' } });
    await expect(session.dispose()).rejects.toThrow('Unsaved move: disk full');
    expect(env.commits()).toHaveLength(0);
  });

  it('never starts a reserved transmission after close and lets a new claimant retry it exactly', async () => {
    const env = lifecycleEnvironment();
    let finishReservation!: () => void;
    const gate = new Promise<void>((resolve) => { finishReservation = resolve; });
    const reserved = vi.fn();
    const create = env.outboxes.create;
    env.outboxes.create = (outboxScope, work) => create(outboxScope, (box, owner) => work({ ...box, dispatch: (build, transmit) =>
      box.dispatch(build, async (request) => {
        reserved(request);
        await gate;
        return transmit(request);
      }) }, owner));
    const session = await env.mount();
    await env.move(session, 5);
    const finished = expect(session.flush()).rejects.toThrow('Stale outbox claim');
    await vi.waitFor(() => expect(reserved).toHaveBeenCalledOnce());
    await session.dispose();
    expect(env.commits()).toHaveLength(0);
    const reopened = await env.mount();
    const recovering = reopened.recover(session.getState().ownerId!);
    const request = reserved.mock.calls[0][0] as OutboxRequest;
    finishReservation();
    await recovering;
    await finished;
    expect(env.commits()[0]).toMatchObject({ path: request.path, method: request.method,
      body: JSON.parse(request.body), key: request.key });
    expect(env.commits()).toHaveLength(1);
    expect(reopened.getState().status).toBe('saved');
    await reopened.dispose();
  });
});

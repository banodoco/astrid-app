import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import {
  createCommitOutbox,
  type ClaimedOutbox,
  type OutboxExclusiveLock,
  type OutboxHead,
  type OutboxIntent,
  type OutboxOutcome,
  type OutboxRequest,
} from './commitOutbox.ts';

const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project', timelineId: 'timeline' };
const h0 = { revisionId: 'R0', publicationId: 'P0' };
const ha = { revisionId: 'RA', publicationId: 'PA' };
const path = '/v1/projects/project/timelines/timeline/commit';
const move = (on: number) => ({
  commands: [{
    schema_version: 1, op: 'clip.move', version: '1', select: 'parent/clip:X', args: { on },
    expect: [{ state: { present: true, value: null } }, { state: { present: false } }],
    created: [{ id: 'allocated-once' }],
  }],
});
const build = (intent: OutboxIntent, base: OutboxHead) => ({
  method: 'POST', path,
  body: { base_revision_id: base.revisionId, base_publication_id: base.publicationId, proposal: intent.payload },
});
const accepted = (head = ha): Extract<OutboxOutcome, { kind: 'accepted' }> => ({
  kind: 'accepted', head, value: { receipt: { receipt_id: head.publicationId }, closure: { opaque: null } },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function exclusiveLocks(): OutboxExclusiveLock {
  const held = new Set<string>();
  return async (name, work) => {
    if (held.has(name)) throw new Error('Outbox is already claimed');
    held.add(name);
    try { return await work(); } finally { held.delete(name); }
  };
}

function environment() {
  const factory = createFakeIndexedDB();
  const exclusiveLock = exclusiveLocks();
  const fault = { abortNextWrite: false, commits: 0 };
  const originalOpen = factory.open.bind(factory);
  // The vendored fake does not implement rollback or suppress complete after abort.
  // Add those semantics for fault injection, without changing production storage.
  factory.open = (...args: unknown[]) => {
    const request = originalOpen(...args);
    request.addEventListener('success', () => {
      const db = request.result;
      const originalTransaction = db.transaction.bind(db);
      db.transaction = (store: string, mode: string) => {
        const tx = originalTransaction(store, mode);
        const records = db.recordsByStore.get(store);
        const before = new Map(records);
        const dispatch = tx.dispatch.bind(tx);
        let aborted = false;
        tx.dispatch = (type: string, event: unknown) => {
          if (type === 'complete' && !aborted && mode === 'readwrite' && fault.abortNextWrite) {
            fault.abortNextWrite = false;
            tx.abort();
            return;
          }
          if (type === 'abort') {
            aborted = true;
            records.clear();
            for (const [key, value] of before) records.set(key, value);
          }
          if (type === 'complete') {
            if (aborted) return;
            fault.commits += 1;
          }
          dispatch(type, event);
        };
        return tx;
      };
    });
    return request;
  };
  return { factory, exclusiveLock, fault, open: () => createCommitOutbox({ indexedDB: factory, exclusiveLock }) };
}

afterEach(() => vi.unstubAllGlobals());

describe('durable command outbox', () => {
  it('checkpoints the original init atomically and keeps it after later edits, inverse ACKs and reopen', async () => {
    const env = environment();
    let owner = '';
    let initialization: Awaited<ReturnType<ClaimedOutbox['read']>>['initialization'];
    await env.open().create(scope, async (box, id) => {
      owner = id;
      const init = await box.append({ kind: 'timeline-init', commands: ['original-guards'] }, { head: h0 });
      const dependent = await box.append(move(7), { after: init });
      let original!: OutboxRequest;
      await expect(box.dispatch(build, async (request) => {
        original = request;
        env.fault.abortNextWrite = true;
        return accepted();
      })).rejects.toThrow('aborted');
      const before = await box.read();
      expect(before.initialization).toBeUndefined();
      expect(before.pending!.request).toEqual(original);
      expect(before.intents.map((intent) => intent.id)).toEqual([init, dependent]);
      const after = await box.dispatch(() => { throw new Error('Must retry exact init'); }, async (request) => {
        expect(request).toEqual(original);
        return accepted();
      });
      initialization = structuredClone(after.initialization);
      expect(initialization).toEqual({ intent: before.intents[0], request: original, head: ha, value: accepted().value });
      expect(after.intents[0].readyBase).toEqual(ha);
      after.initialization!.request.key = 'detached-mutation';
      await box.dispatch(build, async () => accepted({ revisionId: 'RB', publicationId: 'PB' }));
      expect((await box.read()).initialization).toEqual(initialization);
      await box.append({ commands: ['timeline.inverse'] }, { after: dependent });
      await box.dispatch(build, async () => accepted({ revisionId: h0.revisionId, publicationId: 'inverse-p3' }));
      expect((await box.read()).accepted?.head).toEqual({ revisionId: h0.revisionId, publicationId: 'inverse-p3' });
    });
    await env.open().recover(scope, owner, async (box) => {
      expect((await box.read()).initialization).toEqual(initialization);
      expect((await box.read()).intents).toEqual([]);
    });
  });

  it('preserves existing render and placement continuation JSON during init and later ACKs', async () => {
    const env = environment();
    let owner = '';
    await env.open().create(scope, async (box, id) => {
      owner = id;
      await box.append({ kind: 'timeline-init' }, { head: h0 });
    });
    const continuations = {
      renderContinuations: [{ intent: { opaque: [null, 'render'] }, accepted: { intentId: 'older', head: h0, value: {} } }],
      placementContinuations: [{ id: 'placement', input: { opaque: [null, 'placement'] },
        placement: { intentId: 'cancelled-placement', cancelled: true } }],
    };
    // Older/future owner fields are opaque to this bounded storage branch.
    await new Promise<void>((resolve) => {
      const request = env.factory.open('astrid.command-outbox', 1);
      request.addEventListener('success', () => {
        const db = request.result;
        const records = db.recordsByStore.get('owners');
        for (const [key, record] of records) records.set(key, { ...record, ...structuredClone(continuations) });
        db.close();
        resolve();
      });
    });
    await env.open().recover(scope, owner, async (box) => {
      const init = await box.dispatch(build, async () => accepted());
      expect(init).toMatchObject(continuations);
      const link = init.initialization;
      await box.append(move(9), { after: init.accepted!.intentId });
      const later = await box.dispatch(build, async () => accepted({ revisionId: 'later', publicationId: 'later-p' }));
      expect(later).toMatchObject(continuations);
      expect(later.initialization).toEqual(link);
    });
  });

  const createRequest: OutboxRequest = { method: 'POST', path: '/v1/projects/project/timelines',
    body: '{"timeline_id":"timeline","name":"Main"}', key: 'astrid-first-timeline-project' };

  it('persists pre-create identity and defaults before sending, including a lost or unpersisted create ACK', async () => {
    const env = environment();
    const defaults = { name: 'Main', output: { background: null }, tracks: ['V1', 'A1'] };
    let owner = '';
    let original!: OutboxRequest;
    await env.open().create(scope, async (box, id) => {
      owner = id;
      await box.reserveCreate(defaults, createRequest);
      original = (await box.read()).pending!.request;
      await box.dispatch(() => { throw new Error('No invented head'); }, async (request) => {
        expect((await env.open().list(scope))[0].pending!.request).toEqual(request);
        throw new Error('ACK lost');
      });
    });
    await env.open().recover(scope, owner, async (box) => {
      const before = await box.read();
      await expect(box.dispatch(() => { throw new Error('No recapture'); }, async (request) => {
        expect(request).toEqual(original);
        env.fault.abortNextWrite = true;
        return accepted(h0);
      })).rejects.toThrow('aborted');
      expect(await box.read()).toEqual(before);
    });
    await env.open().recover(scope, owner, async (box) => {
      const next = await box.dispatch(() => { throw new Error('No recapture'); }, async (request) => {
        expect(request).toEqual(original);
        return accepted(h0);
      });
      expect(next.accepted).toMatchObject({ head: h0, creation: { request: original, payload: defaults } });
      expect(next.pending).toBeUndefined();
      expect(next.intents).toEqual([]);
      const a = await box.append(move(5), { after: next.accepted!.intentId });
      expect((await box.read()).intents[0]).toMatchObject({ id: a, readyBase: h0 });
    });
  });

  it('does not send or lose earlier work if the pre-create reservation cannot persist', async () => {
    const env = environment();
    await env.open().create(scope, async (box) => {
      const original = await box.read();
      env.fault.abortNextWrite = true;
      await expect(box.reserveCreate({ defaults: null }, createRequest)).rejects.toThrow('aborted');
      expect(await box.read()).toEqual(original);
      const transmit = vi.fn(async () => accepted(h0));
      await expect(box.dispatch(build, transmit)).rejects.toThrow('empty');
      expect(transmit).not.toHaveBeenCalled();
      await box.reserveCreate({ defaults: null }, createRequest);
      const reserved = await box.read();
      await expect(box.reserveCreate({}, createRequest)).rejects.toThrow('unused');
      await expect(box.cancel(reserved.pending!.intentId)).rejects.toThrow('uncertain');
      expect(await box.read()).toEqual(reserved);
    });
  });

  it('refuses cross-scope, changed-route, extra-wire-field and fabricated-head creation reservations', async () => {
    const env = environment();
    await env.open().create(scope, async (box) => {
      const original = await box.read();
      for (const request of [
        { ...createRequest, path: '/v1/projects/other/timelines' },
        { ...createRequest, method: 'PUT' },
        { ...createRequest, key: 'invalid key' },
        { ...createRequest, body: '{"timeline_id":"other"}' },
        { ...createRequest, body: '{"timeline_id":"timeline","head_revision_id":"fake"}' },
      ]) await expect(box.reserveCreate({}, request)).rejects.toThrow('Noncanonical');
      await expect(box.append({}, { create: true })).rejects.toThrow('reserved');
      expect(await box.read()).toEqual(original);
    });
  });

  it('never disposes an unknown flight, including before transmission completes', async () => {
    const env = environment();
    await env.open().create(scope, async (box) => {
      const a = await box.append(move(5), { head: h0 });
      const started = deferred<void>();
      const done = deferred<OutboxOutcome>();
      const flight = box.dispatch(build, async () => { started.resolve(); return done.promise; });
      await started.promise;
      const original = await box.read();
      await expect(box.resolveRejected([a])).rejects.toThrow('definitively rejected');
      expect(await box.read()).toEqual(original);
      done.resolve({ kind: 'retry', error: 'ACK unknown' });
      await flight;
      const unknown = await box.read();
      await expect(box.resolveRejected([a], { payload: move(9), head: ha })).rejects.toThrow('definitively rejected');
      expect(await box.read()).toEqual(unknown);
    });
  });

  it('requires an explicit complete disposition of a rejected prefix and its retained dependents', async () => {
    const env = environment();
    await env.open().create(scope, async (box) => {
      const a = await box.append(move(5), { head: h0 });
      const b = await box.append(move(7), { after: a });
      await box.dispatch(build, async () => ({ kind: 'rejected', error: 'conflict' }));
      const original = await box.read();
      await expect(box.resolveRejected([a])).rejects.toThrow('Retained work changed');
      await expect(box.resolveRejected([a, b], { payload: move(9), head: ha })).rejects.toThrow('predecessor');
      await expect(box.resolveRejected([a, b], undefined, () => false)).rejects.toThrow('closed');
      env.fault.abortNextWrite = true;
      await expect(box.resolveRejected([a, b])).rejects.toThrow('aborted');
      expect(await box.read()).toEqual(original);
      const cleared = await box.resolveRejected([a, b]);
      expect(cleared.intents).toEqual([]);
      expect(cleared.pending).toBeUndefined();
      expect((await env.open().list(scope))[0]).toEqual(cleared);
    });
  });

  it('atomically replaces only a single rejected intent and allocates a fresh exact retry identity', async () => {
    const env = environment();
    let owner = '';
    let replacementRequest!: OutboxRequest;
    await env.open().create(scope, async (box, id) => {
      owner = id;
      const a = await box.append(move(5), { head: h0 });
      await box.dispatch(build, async () => ({ kind: 'rejected', error: 'changed' }));
      const old = await box.read();
      env.fault.abortNextWrite = true;
      await expect(box.resolveRejected([a], { payload: move(9), head: ha })).rejects.toThrow('aborted');
      expect(await box.read()).toEqual(old);
      const next = await box.resolveRejected([a], { payload: move(9), head: ha });
      expect(next.intents[0].id).not.toBe(a);
      expect(next.intents[0]).toMatchObject({ payload: move(9), basis: { head: ha }, readyBase: ha });
      expect(next.pending).toBeUndefined();
      await box.dispatch(build, async (request) => {
        replacementRequest = request;
        expect(request.key).not.toBe(old.pending!.request.key);
        return { kind: 'retry', error: 'lost' };
      });
      expect(old.intents[0].payload).toEqual(move(5));
      expect(JSON.parse(old.pending!.request.body)).toEqual(build(old.intents[0], h0).body);
    });
    await env.open().recover(scope, owner, async (box) => {
      await box.dispatch(() => { throw new Error('Must retry exact request'); }, async (request) => {
        expect(request).toEqual(replacementRequest);
        return accepted();
      });
    });
  });

  it('fences a stale resolver when a new owner generation has claimed the rejected work', async () => {
    const env = environment();
    const service = createCommitOutbox({ indexedDB: env.factory, exclusiveLock: async (_name, work) => work() });
    await service.create(scope, async (old, owner) => {
      const a = await old.append(move(5), { head: h0 });
      await old.dispatch(build, async () => ({ kind: 'rejected', error: 'changed' }));
      await service.recover(scope, owner, async (current) => {
        const original = await current.read();
        await expect(old.resolveRejected([a], { payload: move(9), head: ha })).rejects.toThrow('Stale');
        expect(await current.read()).toEqual(original);
        await current.resolveRejected([a]);
      });
    });
  });

  it('reopens exact A before dependent B, then gives B a fresh key/base with original guards and IDs', async () => {
    const env = environment();
    const first = env.open();
    let owner = '';
    let requestA!: OutboxRequest;
    let b = '';
    await first.create(scope, async (box, ownerId) => {
      owner = ownerId;
      const a = await box.append(move(5), { head: h0 });
      await box.dispatch(build, async (request) => {
        requestA = request;
        b = await box.append(move(7), { after: a });
        throw new Error('ACK lost');
      });
    });
    const reopened = env.open();
    const [recovery] = await reopened.list(scope);
    expect(recovery.ownerId).toBe(owner);
    expect(recovery.pending?.request).toEqual(requestA);
    expect(recovery.intents[1]).toMatchObject({ id: b, payload: move(7) });
    await reopened.recover(scope, owner, async (box) => {
      const mustNotBuild = vi.fn(() => { throw new Error('Retry must not be rebuilt'); });
      const afterA = await box.dispatch(mustNotBuild, async (request) => {
        expect(request).toEqual(requestA);
        return accepted();
      });
      expect(mustNotBuild).not.toHaveBeenCalled();
      expect(afterA.intents).toHaveLength(1);
      expect(afterA.intents[0]).toMatchObject({ id: b, payload: move(7), readyBase: ha });
      expect(afterA.accepted).toEqual({ intentId: recovery.pending!.intentId, head: ha, value: accepted().value });
      await box.dispatch(build, async (requestB) => {
        expect(requestB.key).not.toBe(requestA.key);
        expect(JSON.parse(requestB.body)).toEqual({
          base_revision_id: 'RA', base_publication_id: 'PA', proposal: move(7),
        });
        return accepted({ revisionId: 'RB', publicationId: 'PB' });
      });
      expect((await box.read()).intents).toEqual([]);
    });
  });

  it.each(['same claim', 'recovered claim'] as const)(
    'retains B captured over A when A ACK commits before B append in the %s', async (claim) => {
      const env = environment();
      let owner = '';
      let requestA!: OutboxRequest;
      let basis!: { after: string };
      let payload!: ReturnType<typeof move>;
      let b = '';
      const appendCaptured = async (box: ClaimedOutbox) => {
        b = await box.append(payload, basis);
        expect((await box.read()).intents).toEqual([{ id: b, basis, payload: move(7), readyBase: ha }]);
      };
      await env.open().create(scope, async (box, ownerId) => {
        owner = ownerId;
        const a = await box.append(move(5), { head: h0 });
        const started = deferred<void>();
        const response = deferred<OutboxOutcome>();
        const sending = box.dispatch(build, async (request) => {
          requestA = request;
          started.resolve();
          return response.promise;
        });
        await started.promise;
        // Capture B's authoring basis while A is still optimistic; persist B after A's ACK.
        basis = { after: a };
        payload = move(7);
        response.resolve(accepted());
        const afterA = await sending;
        expect(afterA.intents).toEqual([]);
        expect(afterA.accepted).toEqual({ intentId: a, head: ha, value: accepted().value });
        if (claim === 'same claim') await appendCaptured(box);
      });
      if (claim === 'recovered claim') await env.open().recover(scope, owner, appendCaptured);
      await env.open().recover(scope, owner, async (box) => {
        expect((await box.read()).intents[0]).toEqual({ id: b, basis, payload: move(7), readyBase: ha });
        let requestB!: OutboxRequest;
        await box.dispatch(build, async (request) => {
          requestB = request;
          expect(request.key).not.toBe(requestA.key);
          expect(request.body).toBe(JSON.stringify({
            base_revision_id: ha.revisionId, base_publication_id: ha.publicationId, proposal: payload,
          }));
          return { kind: 'retry', error: 'lost B ACK' };
        });
        const mustNotBuild = vi.fn(() => { throw new Error('Retry must not be rebuilt'); });
        await box.dispatch(mustNotBuild, async (request) => {
          expect(request).toEqual(requestB);
          return accepted({ revisionId: 'RB', publicationId: 'PB' });
        });
        expect(mustNotBuild).not.toHaveBeenCalled();
      });
    },
  );

  it('refuses unknown, cancelled, non-tail and superseded accepted predecessors', async () => {
    const env = environment();
    await env.open().create(scope, async (box) => {
      const cancelled = await box.append(move(3), { head: h0 });
      await box.cancel(cancelled);
      await expect(box.append(move(5), { after: cancelled })).rejects.toThrow('predecessor');
      await expect(box.append(move(5), { after: 'unknown' })).rejects.toThrow('predecessor');
      const a = await box.append(move(5), { head: h0 });
      await box.dispatch(build, async () => accepted());
      const b = await box.append(move(7), { after: a });
      await expect(box.append(move(9), { after: a })).rejects.toThrow('predecessor');
      const hb = { revisionId: 'RB', publicationId: 'PB' };
      await box.dispatch(build, async () => accepted(hb));
      // Only B's acceptance remains; neither the original nor a remote head can stand in for A.
      expect((await box.read()).accepted).toEqual({ intentId: b, head: hb, value: accepted(hb).value });
      await expect(box.append(move(9), { after: a })).rejects.toThrow('predecessor');
      const remote = { revisionId: 'REMOTE', publicationId: 'REMOTE' };
      const independent = await box.append(move(11), { head: remote });
      await box.cancel(independent);
      await expect(box.append(move(13), { after: a })).rejects.toThrow('predecessor');
      const c = await box.append(move(9), { after: b });
      expect((await box.read()).intents).toEqual([
        { id: c, basis: { after: b }, payload: move(9), readyBase: hb },
      ]);
    });
  });

  it('commits the reservation before transmit, and aborting it never sends or loses intent', async () => {
    const env = environment();
    const service = env.open();
    await service.create(scope, async (box) => {
      await box.append(move(5), { head: h0 });
      const transmit = vi.fn(async () => accepted());
      await expect(box.dispatch((intent, base) => {
        env.fault.abortNextWrite = true;
        return build(intent, base);
      }, transmit)).rejects.toThrow('aborted');
      expect(transmit).not.toHaveBeenCalled();
      expect((await box.read()).pending).toBeUndefined();
      expect((await box.read()).intents[0].payload).toEqual(move(5));
      const before = env.fault.commits;
      await box.dispatch(build, async (request) => {
        expect(env.fault.commits).toBeGreaterThan(before);
        expect((await service.list(scope))[0].pending?.request).toEqual(request);
        return accepted();
      });
    });
  });

  it('ACK is atomic: abort retains A and B; retry removes only A and stores its exact acceptance', async () => {
    const env = environment();
    await env.open().create(scope, async (box) => {
      const a = await box.append(move(5), { head: h0 });
      const b = await box.append(move(7), { after: a });
      let original!: OutboxRequest;
      await expect(box.dispatch(build, async (request) => {
        original = request;
        env.fault.abortNextWrite = true;
        return accepted();
      })).rejects.toThrow('aborted');
      const retained = await box.read();
      expect(retained.intents.map((intent) => intent.id)).toEqual([a, b]);
      expect(retained.pending?.request).toEqual(original);
      expect(retained.accepted).toBeUndefined();
      const result = await box.dispatch(build, async (request) => {
        expect(request).toEqual(original);
        return accepted();
      });
      expect(result.intents).toEqual([{ ...retained.intents[1], readyBase: ha }]);
      expect(result.pending).toBeUndefined();
      expect(result.accepted).toEqual({ intentId: a, head: ha, value: accepted().value });
    });
  });

  it('retains B authored during transmission and permits cancelling only an unsent leaf', async () => {
    const env = environment();
    await env.open().create(scope, async (box) => {
      const a = await box.append(move(5), { head: h0 });
      const started = deferred<void>();
      const response = deferred<OutboxOutcome>();
      const sending = box.dispatch(build, async () => { started.resolve(); return response.promise; });
      await started.promise;
      const b = await box.append(move(7), { after: a });
      await expect(box.cancel(a)).rejects.toThrow('uncertain');
      await expect(box.dispatch(build, async () => accepted())).rejects.toThrow('already');
      await box.cancel(b);
      const replacement = await box.append(move(9), { after: a });
      response.resolve(accepted());
      const result = await sending;
      expect(result.intents).toEqual([expect.objectContaining({ id: replacement, payload: move(9), readyBase: ha })]);
    });
  });

  it('serializes a dependent chain but leaves an independent base unchanged', async () => {
    const env = environment();
    await env.open().create(scope, async (box) => {
      const a = await box.append(move(5), { head: h0 });
      const b = await box.append(move(7), { after: a });
      await box.append(move(9), { after: b });
      await box.append(move(11), { head: h0 });
      await expect(box.cancel(b)).rejects.toThrow('predecessor');
      await box.dispatch(build, async () => accepted());
      const afterA = await box.read();
      expect(afterA.intents[0].readyBase).toEqual(ha);
      expect(afterA.intents[1].readyBase).toBeUndefined();
      const hb = { revisionId: 'RB', publicationId: 'PB' };
      await box.dispatch(build, async () => accepted(hb));
      expect((await box.read()).intents[0].readyBase).toEqual(hb);
      await box.dispatch(build, async () => accepted({ revisionId: 'RC', publicationId: 'PC' }));
      await box.dispatch(build, async (request) => {
        expect(JSON.parse(request.body).base_publication_id).toBe('P0');
        return accepted();
      });
    });
  });

  it('rejected A retains the original dependent suffix as conflict across reopen', async () => {
    const env = environment();
    let owner = '';
    const error = { status: 'conflict', reason: 'changed_read', state: { present: false } };
    await env.open().create(scope, async (box, ownerId) => {
      owner = ownerId;
      const a = await box.append(move(5), { head: h0 });
      const b = await box.append(move(7), { after: a });
      await box.append(move(9), { after: b });
      await box.dispatch(build, async () => ({ kind: 'rejected', error }));
    });
    await env.open().recover(scope, owner, async (box) => {
      const state = await box.read();
      expect(state.intents.map((intent) => intent.payload)).toEqual([move(5), move(7), move(9)]);
      expect(state.intents.every((intent) => JSON.stringify(intent.conflict) === JSON.stringify(error))).toBe(true);
      expect(state.accepted).toBeUndefined();
      const transmit = vi.fn(async () => accepted());
      await expect(box.dispatch(build, transmit)).rejects.toThrow('rejected prefix');
      expect(transmit).not.toHaveBeenCalled();
    });
  });

  it.each(['before', 'after'] as const)('keeps an independent suffix appended %s A rejection free of A conflict', async (when) => {
    const env = environment();
    let owner = '';
    const error = { reason: 'changed_read' };
    await env.open().create(scope, async (box, ownerId) => {
      owner = ownerId;
      const a = await box.append(move(5), { head: h0 });
      const appendSuffix = async () => {
        const b = await box.append(move(7), { after: a });
        await box.append(move(9), { after: b });
        const independent = await box.append(move(11), { head: h0 });
        await box.append(move(13), { after: independent });
      };
      if (when === 'before') await appendSuffix();
      await box.dispatch(build, async () => ({ kind: 'rejected', error }));
      if (when === 'after') await appendSuffix();
    });
    await env.open().recover(scope, owner, async (box) => {
      const state = await box.read();
      expect(state.intents.map((intent) => intent.payload)).toEqual([move(5), move(7), move(9), move(11), move(13)]);
      expect(state.intents.map((intent) => intent.conflict)).toEqual([error, error, error, undefined, undefined]);
      expect(state.intents[3].readyBase).toEqual(h0);
      expect(state.intents[4].readyBase).toBeUndefined();
      const transmit = vi.fn(async () => accepted());
      await expect(box.dispatch(build, transmit)).rejects.toThrow('rejected prefix');
      expect(transmit).not.toHaveBeenCalled();
    });
  });

  it('scopes explicit claims by realm/actor/project/timeline and excludes a second claimant', async () => {
    const env = environment();
    const service = env.open();
    await service.create(scope, async (box, ownerId) => {
      await box.append(move(5), { head: h0 });
      await expect(service.recover(scope, ownerId, async () => undefined)).rejects.toThrow('claimed');
      for (const field of ['realmId', 'actorId', 'projectId', 'timelineId']) {
        const otherScope = { ...scope, [field]: 'other' };
        expect(await service.list(otherScope)).toEqual([]);
        await expect(service.recover(otherScope, ownerId, async () => undefined)).rejects.toThrow('explicit claim');
      }
      sessionStorage.setItem('ownerId', ownerId);
      await service.create(scope, async (other, otherId) => {
        expect(otherId).not.toBe(ownerId);
        expect((await other.read()).intents).toEqual([]);
        await other.append(move(11), { head: h0 });
      });
      expect((await service.list(scope)).map((record) => record.ownerId)).toContain(ownerId);
      expect((await box.read()).intents).toHaveLength(1);
    });
    expect(await service.list(scope)).toHaveLength(2);
    sessionStorage.clear();
  });

  it('uses the browser exclusive lock for the whole claim and refuses unavailable locks', async () => {
    const env = environment();
    let held = false;
    const request = vi.fn(async (_name, options, work) => {
      expect(options).toEqual({ mode: 'exclusive', ifAvailable: true });
      if (held) return work(null);
      held = true;
      try { return await work({ name: _name, mode: 'exclusive' }); } finally { held = false; }
    });
    vi.stubGlobal('navigator', { locks: { request } });
    const service = createCommitOutbox({ indexedDB: env.factory });
    let owner = '';
    await service.create(scope, async (box, ownerId) => {
      owner = ownerId;
      expect(held).toBe(true);
      await box.append(move(5), { head: h0 });
      await expect(service.recover(scope, ownerId, async () => undefined)).rejects.toThrow('claimed');
      await box.dispatch(build, async () => {
        expect(held).toBe(true);
        return { kind: 'retry', error: null };
      });
      expect(held).toBe(true);
    });
    expect(held).toBe(false);
    await service.recover(scope, owner, async (box) => {
      expect((await box.read()).generation).toBe(2);
      await box.dispatch(build, async () => accepted());
    });
    expect(held).toBe(false);
  });

  it.each(['accepted', 'rejected', 'retry', 'throw'] as const)(
    'persisted generation fences a late %s even if exclusion is lost', async (kind) => {
      const env = environment();
      // Simulate a lost browser lock while the old page still has a live callback.
      const service = createCommitOutbox({ indexedDB: env.factory, exclusiveLock: async (_name, work) => work() });
      const started = deferred<string>();
      const late = deferred<OutboxOutcome>();
      let oldBox!: ClaimedOutbox;
      const old = service.create(scope, async (box, ownerId) => {
        oldBox = box;
        await box.append(move(5), { head: h0 });
        return box.dispatch(build, async () => {
          started.resolve(ownerId);
          const value = await late.promise;
          if (kind === 'throw') throw new Error('old transport error');
          return value;
        });
      });
      const ownerId = await started.promise;
      await service.recover(scope, ownerId, async (box) => {
        await expect(oldBox.append(move(99), { head: h0 })).rejects.toThrow('Stale');
        const b = await box.append(move(7), { after: (await box.read()).intents[0].id });
        await box.dispatch(build, async () => accepted());
        const expected = await box.read();
        const stale = expect(old).rejects.toThrow('Stale');
        late.resolve(kind === 'accepted' ? accepted({ revisionId: 'OLD', publicationId: 'OLD' })
          : { kind: kind === 'rejected' ? 'rejected' : 'retry', error: 'old' });
        await stale;
        expect(await box.read()).toEqual(expected);
        expect(expected.generation).toBe(2);
        expect(expected.intents[0].id).toBe(b);
      });
    },
  );

  it('a released capability cannot write, and a late ACK cannot mutate a recovered owner', async () => {
    const env = environment();
    const service = env.open();
    const late = deferred<OutboxOutcome>();
    const started = deferred<void>();
    let old!: ClaimedOutbox;
    let pending!: Promise<unknown>;
    let owner = '';
    await service.create(scope, async (box, ownerId) => {
      old = box;
      owner = ownerId;
      await box.append(move(5), { head: h0 });
      pending = box.dispatch(build, async () => { started.resolve(); return late.promise; });
      await started.promise;
    });
    await expect(old.cancel('anything')).rejects.toThrow('Stale');
    await service.recover(scope, owner, async (box) => {
      await box.dispatch(build, async () => accepted());
      const state = await box.read();
      const stale = expect(pending).rejects.toThrow('Stale');
      late.resolve(accepted());
      await stale;
      expect(await box.read()).toEqual(state);
    });
  });

  it('does not start transmit when the claim returns before the reservation transaction completes', async () => {
    const env = environment();
    const service = env.open();
    let owner = '';
    let sending!: Promise<unknown>;
    const transmit = vi.fn(async () => accepted());
    await service.create(scope, async (box, ownerId) => {
      owner = ownerId;
      await box.append(move(5), { head: h0 });
      const reserving = deferred<void>();
      sending = box.dispatch((intent, base) => {
        reserving.resolve();
        return build(intent, base);
      }, transmit);
      await reserving.promise;
    });
    await expect(sending).rejects.toThrow('Stale');
    expect(transmit).not.toHaveBeenCalled();
    const [state] = await service.list(scope);
    expect(state.intents[0].payload).toEqual(move(5));
    expect(state.pending?.request.body).toBe(JSON.stringify(build(state.intents[0], h0).body));
    await service.recover(scope, owner, async (box) => {
      const mustNotBuild = vi.fn(() => { throw new Error('Reservation must not be rebuilt'); });
      await box.dispatch(mustNotBuild, async (request) => {
        expect(request).toEqual(state.pending!.request);
        return accepted();
      });
      expect(mustNotBuild).not.toHaveBeenCalled();
    });
  });

  it('detaches caller inputs, builder inputs, transmitted requests, returned records and tagged states', async () => {
    const env = environment();
    const service = env.open();
    const callerScope = { ...scope, credential: 'must not persist' };
    await service.create(callerScope, async (box) => {
      const payload = move(5);
      const basis = { head: { ...h0 } };
      await box.append(payload, basis);
      payload.commands[0].args.on = 999;
      basis.head.publicationId = 'mutated';
      callerScope.actorId = 'mutated';
      let exact!: OutboxRequest;
      await box.dispatch((intent, base) => {
        const request = build(intent, base);
        intent.payload = 'mutated';
        return request;
      }, async (request) => {
        exact = { ...request };
        request.body = 'mutated';
        request.key = 'mutated';
        return { kind: 'retry', error: { status: 'refused', reason: 'head_busy' } };
      });
      const state = await box.read();
      expect(state.scope).toEqual(scope);
      expect(state.intents[0].payload).toEqual(move(5));
      expect(JSON.parse(exact.body).proposal).toEqual(move(5));
      expect(state.pending?.request).toEqual(exact);
      state.intents.length = 0;
      const [listed] = await service.list(scope);
      listed.pending!.request.key = 'mutated';
      await box.dispatch(build, async (request) => {
        expect(request).toEqual(exact);
        return accepted();
      });
    });
  });

  it('accepts same content with a new publication and never conflates those acceptances', async () => {
    const env = environment();
    await env.open().create(scope, async (box) => {
      const a = await box.append(move(5), { head: h0 });
      await box.append(move(5), { after: a });
      await box.dispatch(build, async () => accepted({ revisionId: 'R0', publicationId: 'P1' }));
      expect((await box.read()).accepted?.head).toEqual({ revisionId: 'R0', publicationId: 'P1' });
      await box.dispatch(build, async (request) => {
        expect(JSON.parse(request.body).base_publication_id).toBe('P1');
        return accepted({ revisionId: 'R0', publicationId: 'P2' });
      });
      expect((await box.read()).accepted?.head).toEqual({ revisionId: 'R0', publicationId: 'P2' });
    });
  });

  it('refuses sending on lock or persistence failure and leaves previously durable work inspectable', async () => {
    const env = environment();
    let owner = '';
    await env.open().create(scope, async (box, ownerId) => {
      owner = ownerId;
      await box.append(move(5), { head: h0 });
    });
    const before = await env.open().list(scope);
    const work = vi.fn(async () => undefined);
    const brokenLock = createCommitOutbox({ indexedDB: env.factory, exclusiveLock: async () => { throw new Error('lock failed'); } });
    await expect(brokenLock.recover(scope, owner, work)).rejects.toThrow('lock failed');
    expect(work).not.toHaveBeenCalled();
    expect(await brokenLock.list(scope)).toEqual(before);
    env.fault.abortNextWrite = true;
    await expect(env.open().recover(scope, owner, work)).rejects.toThrow('aborted');
    expect(work).not.toHaveBeenCalled();
    expect(await env.open().list(scope)).toEqual(before);
    vi.stubGlobal('navigator', {});
    await expect(createCommitOutbox({ indexedDB: env.factory }).recover(scope, owner, work)).rejects.toThrow('locks');
    vi.stubGlobal('indexedDB', undefined);
    await expect(createCommitOutbox({ exclusiveLock: env.exclusiveLock }).list(scope)).rejects.toThrow('storage');
  });

  it('refuses invalid JSON, orphan dependencies and noncanonical requests without sending', async () => {
    const env = environment();
    await env.open().create(scope, async (box) => {
      await expect(box.append({ number: Infinity }, { head: h0 })).rejects.toThrow('finite JSON');
      await expect(box.append({ absent: undefined } as any, { head: h0 })).rejects.toThrow('finite JSON');
      await expect(box.append(move(5), { after: 'unknown' })).rejects.toThrow('predecessor');
      await box.append(move(5), { head: h0 });
      const send = vi.fn(async () => accepted());
      await expect(box.dispatch((intent, base) => ({ ...build(intent, base), path: `/api/runtime${path}` }), send))
        .rejects.toThrow('Noncanonical');
      expect(send).not.toHaveBeenCalled();
      expect((await box.read()).pending).toBeUndefined();
    });
  });
});

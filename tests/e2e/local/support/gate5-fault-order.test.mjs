import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { createCommitOutbox } from '../../../../src/tools/video-editor/commands/commitOutbox.ts';
import { classifyGate5FaultOrder, sameGate5CommitIdentity } from './gate5-fault-order.ts';

const A = { key: 'key-a', body: '{"commands":["A"]}' };
const B = { key: 'key-b', body: '{"commands":["B"]}' };

test('fast and slow callbacks order held retry, stale-page close, restart, exact recovery and B', async () => {
  for (const schedule of [{ name: 'fast', retry: 0, close: 1, reload: 0, restart: 1 }, { name: 'slow', retry: 4, close: 3, reload: 2, restart: 3 }]) {
    const observed = [];
    const forwarded = [];
    const events = [];
    let initial;
    let staged;
    let stagedRetryObserved = false;
    let recoveryForwarded = false;
    let held;
    const routeFor = (identity, page) => ({ identity, page, state: 'open',
      async fetch() { assert.equal(this.state, 'open'); this.state = 'fetched'; events.push(`fetch:${identity.key}`); },
      async fulfill() { assert.equal(this.state, 'fetched'); this.state = 'fulfilled'; events.push(`fulfill:${identity.key}`); },
      async abort() { assert.ok(this.state === 'open' || this.state === 'fetched'); this.state = 'aborted'; events.push(`abort:${identity.key}`); },
    });
    const intercept = async (identity, page) => {
      observed.push(identity);
      const action = classifyGate5FaultOrder({ initial, candidate: identity,
        automaticRetryStaged: stagedRetryObserved, recoveryForwarded });
      events.push(`observe:${identity.key}:${action}`);
      const route = routeFor(identity, page);
      if (action === 'reject-early-dependent' || action === 'reject-unexpected-duplicate') {
        await route.abort();
        return;
      }
      if (action === 'stage-automatic-retry') {
        staged = route;
        stagedRetryObserved = true;
        events.push(`stage:${identity.key}`);
        return;
      }
      if (!initial) initial = identity;
      if (staged && identity.key === A.key) {
        await staged.abort();
        staged = undefined;
      }
      await route.fetch();
      forwarded.push(identity);
      if (forwarded.length === 1) held = route;
      else await route.fulfill();
      if (identity.key === A.key && observed.length > 1) recoveryForwarded = true;
    };
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const page = { name: `${schedule.name}-page` };
    const reopened = { name: `${schedule.name}-reopened` };

    await intercept(A, page);
    assert.equal(held.state, 'fetched');
    await held.abort();
    await wait(schedule.retry);
    await intercept(A, page);
    assert.deepEqual(observed.slice(0, 2), [A, A]);
    assert.deepEqual(forwarded, [A]);
    events.push('close-old-page');
    await wait(schedule.close);
    await staged.abort();
    staged = undefined;
    events.push('reload');
    await wait(schedule.reload);
    events.push('restart');
    await wait(schedule.restart);
    await intercept(A, reopened);
    await intercept(B, reopened);

    assert.deepEqual(observed, [A, A, A, B], schedule.name);
    assert.deepEqual(forwarded, [A, A, B], schedule.name);
    assert.ok(events.indexOf('close-old-page') < events.indexOf('restart'), schedule.name);
    assert.ok(events.indexOf('restart') < events.indexOf('observe:key-a:forward-dependent-or-recovery'), schedule.name);
    assert.ok(events.findIndex((event) => event === 'observe:key-b:forward-dependent-or-recovery') > events.findIndex((event) => event === 'observe:key-a:forward-dependent-or-recovery'), schedule.name);
  }
});

test('different body/key traffic remains visible instead of being staged as A', () => {
  assert.equal(classifyGate5FaultOrder({ initial: A, candidate: B, automaticRetryStaged: false, recoveryForwarded: false }), 'reject-early-dependent');
  assert.equal(classifyGate5FaultOrder({ initial: A, candidate: { key: A.key, body: B.body }, automaticRetryStaged: false, recoveryForwarded: false }), 'reject-early-dependent');
  assert.equal(classifyGate5FaultOrder({ initial: A, candidate: { key: B.key, body: A.body }, automaticRetryStaged: false, recoveryForwarded: false }), 'reject-early-dependent');
  assert.equal(classifyGate5FaultOrder({ initial: A, candidate: B, automaticRetryStaged: true, recoveryForwarded: true }), 'forward-dependent-or-recovery');
  assert.equal(sameGate5CommitIdentity(A, { ...A }), true);
  assert.equal(sameGate5CommitIdentity(A, B), false);
});

test('a real outbox retry reuses A identity and settles one accepted owner result', async () => {
  const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (_name, work) => work() });
  const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project', timelineId: 'timeline' };
  const sent = [];
  let acknowledgements = 0;
  await outboxes.create(scope, async (owner) => {
    await owner.append({ commands: [{ op: 'doc.patch', args: { changes: [] } }] }, {
      head: { revisionId: 'revision-before', publicationId: 'publication-before' },
    });
    const build = () => ({ method: 'POST', path: '/v1/projects/project/timelines/timeline/commit',
      body: { commands: [{ op: 'doc.patch', args: { changes: [] } }] } });
    const transmit = (request) => {
      sent.push({ body: JSON.stringify(request.body), key: request.key });
      if (sent.length === 1) return { kind: 'retry', error: { code: 'offline-control' } };
      acknowledgements++;
      return { kind: 'accepted', head: { revisionId: 'revision-after', publicationId: 'publication-after' },
        value: { response: { data: { status: 'accepted' }, receipt: { receipt_id: 'publication-after' } } } };
    };
    await owner.dispatch(build, transmit);
    await owner.dispatch(() => { throw new Error('An exact pending retry must reuse its request'); }, transmit);
    const settled = await owner.read();
    assert.equal(settled.intents.length, 0);
    assert.equal(settled.pending, undefined);
    assert.equal(settled.accepted.head.revisionId, 'revision-after');
    assert.equal(settled.accepted.value.response.data.status, 'accepted');
    assert.equal(acknowledgements, 1);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].key, sent[1].key);
    assert.equal(sent[0].body, sent[1].body);
  });
});

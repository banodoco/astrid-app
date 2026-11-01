import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test, { before } from 'node:test';
import { createFakeIndexedDB } from 'fake-indexeddb';
import ts from 'typescript';
import { acceptedCommit, fixtureDigest } from '../../../../src/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { createLocalSaveSession } from '../../../../src/tools/video-editor/commands/localSaveSession.ts';
import { createCommitOutbox } from '../../../../src/tools/video-editor/commands/commitOutbox.ts';
import { dragTimelineClip } from './app.ts';
import { assertGate5ResetPrecondition, expectedGate5MoveReads } from './gate5-reset-precondition.ts';

// Offline control only: these request/response/outbox objects are mocked and do not prove a browser or Runtime journey.
const base = { revisionId: 'revision-before', publicationId: 'publication-before' };
const scope = { projectId: 'project-f2', timelineId: 'timeline-f2' };
const clipId = 'f2-app-clip';
const trackId = 'V1';
const changes = [{ op: 'set', ref: 'parent', path: ['clips', `id:${clipId}`, 'at'], before: { state: 'present', value: 0 }, value: 5 }];
// This is the immutable parent payload captured before the gesture. The top-level
// clip/registry mirrors match the mounted producer's authored shape, rather than
// deriving expected reads from the submitted request.
const preGestureParent = {
  config: { output: { fps: 30 }, tracks: [{ id: trackId, kind: 'visual' }] },
  clips: [
    { id: clipId, track: trackId, at: 0, clipType: 'media', from: 0, to: 3, speed: 1, asset: 'f2-app' },
    { id: 'f2-transition-clip', track: trackId, at: 15, clipType: 'media', from: 0, to: 3, speed: 1, asset: 'f2-video' },
  ],
  registry: { assets: { 'f2-app': { file: 'f2-app.png', type: 'image/png' }, 'f2-video': { file: 'f2-video.mp4', type: 'video/mp4' } } },
};
// Reuse the documented full DTO/closure fixture, including opaque children.
const template = acceptedCommit({ revision_id: base.revisionId, publication_id: base.publicationId },
  { revision_id: base.revisionId, publication_id: base.publicationId }, { ...scope, children: true });
const preGestureDocument = structuredClone(template.data.canonical_document);
preGestureDocument.parent_revision.payload = { ...preGestureDocument.parent_revision.payload, ...preGestureParent };
preGestureDocument.parent_revision.content_digest = fixtureDigest(preGestureDocument.parent_revision.payload);
const moved = structuredClone(preGestureDocument);
moved.parent_revision.payload.clips[0].at = 5;

// Execute the actual mounted read planner slice, without loading its browser-only
// virtual modules. Geometry, provider replies and UI assembly remain mocked.
const handoffSource = readFileSync(new URL('../../../../src/tools/video-editor/hooks/timelineLocalSaveHandoff.ts', import.meta.url), 'utf8');
const plannerStart = handoffSource.lastIndexOf('          const read =', handoffSource.indexOf('          reads = timingReads(clip);'));
const plannerEnd = handoffSource.indexOf('          } else if (!Object.keys(gestureBasis.patch)', plannerStart);
assert.ok(plannerStart > 0 && plannerEnd > plannerStart);
const planner = ts.transpileModule('let reads;\n' + handoffSource.slice(plannerStart, plannerEnd) + '\n}\nreturn reads;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const reads = new Function('config', 'parent', 'clips', 'clipPath', 'clip', 'gestureBasis', 'authoredJson', 'object', 'refuse', planner)(
  preGestureParent.config, preGestureParent, preGestureParent.clips, ['clips'], preGestureParent.clips[0], { kind: 'move', clipId, trackId },
  structuredClone, value => !!value && typeof value === 'object' && !Array.isArray(value), message => { throw new Error(message); });
assert.equal(reads.length, 25);
assert.deepEqual(reads, expectedGate5MoveReads({ preGestureDocument, clipId, expectedTrackId: trackId }));

// Build and persist the request with the actual document encoder/save session.
// No transport runs: send captures its input then reports an offline lost ACK.
const ownerScope = { realmId: 'realm', actorId: 'actor', ...scope };
const nativeRef = `parent/clip:${clipId}`;
const nativeRead = { ref: nativeRef, path: ['at'], state: { state: 'present', value: 0 } };
let request, durableKey, command, data, response, acceptedValue, settled, authoritativeHead, authoritativeRevision, valid, authoritativeHistory;
before(async () => {
  const initial = { head: base, canonicalDocument: preGestureDocument };
  const sourceOutboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (_name, work) => work() });
  const sourceSession = await createLocalSaveSession({ scope: ownerScope, initial, document: preGestureDocument,
    outboxes: sourceOutboxes, loadLatest: async () => initial, changed() {},
    prepareDisplay: async (_basis, document) => ({ document, adopt() {} }),
    send: async (body, key) => { request = body; durableKey = key; throw new Error('offline control ACK loss'); } });
  await sourceSession.appendDocument({ before: preGestureDocument, after: moved,
    roots: [{ ref: 'parent', revisionId: base.revisionId, contentDigest: preGestureDocument.parent_revision.content_digest }],
    label: 'Edit timeline', step: { id: 'setup-step', label: 'Edit timeline', intent: `Move ${clipId} on ${trackId}`, tags: [], reads },
    merge: 'fields', reads });
  await assert.rejects(sourceSession.flush());
  assert.ok(request && durableKey);
  await sourceSession.dispose();
  command = request.commands[0];
  assert.deepEqual(command.args.changes, changes);
  // Provider projection follows commands.py/Recording.finish, not a simplified
  // presence-only reply. Runtime is still a double; this is source/control proof.
  const responseCommand = { ...command, intent: {}, resolved: [], expect: { [`${nativeRef}::at`]: nativeRead.state },
    authorship: { [`${nativeRef}::at`]: 'direct' }, reads: [nativeRead], selections: [], bindings: {} };
  const canonicalDocument = structuredClone(moved);
  canonicalDocument.parent_revision.revision_id = 'revision-after';
  canonicalDocument.parent_revision.content_digest = fixtureDigest(canonicalDocument.parent_revision.payload);
  const normalizedReads = reads.map(read => ({ ...read, path: read.path[0] === 'clips' ? ['config', ...read.path] : read.path }));
  const dependencies = [...normalizedReads, ...normalizedReads];
  const acceptedStep = { ...request.steps[0], patch: [{ ...changes[0], path: ['config', ...changes[0].path] }], dependencies };
  data = { ...template.data, accepted_revision_id: 'revision-after', commands: [responseCommand],
    canonical_document: canonicalDocument, document_digest: fixtureDigest(canonicalDocument),
    provider_version: 'astrid-v1', compiler_version: 'authoring-bundle-1',
    publisher: ownerScope.actorId, merge_mode: 'fields', label: request.label, source: request.source, steps: [acceptedStep] };
  response = { data, receipt: { ...template.receipt, receipt_id: 'publication-after', idempotency_key: durableKey,
    request_hash: fixtureDigest({ operation: 'commitTimeline', path: `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`,
      publisher: ownerScope.actorId, request }).slice(7), result: data } };
  const boundary = { base_revision_id: base.revisionId, base_publication_id: base.publicationId,
    evaluated_head: { revision_id: base.revisionId, publication_id: base.publicationId }, step_id: request.steps[0].id, command_ordinal: 0, phase: 'input' };
  const readBindings = ['batch-read', 'input'].flatMap(phase => normalizedReads.map(read => ({
    ref: 'parent', physical_ref: 'parent', revision_id: base.revisionId, content_digest: preGestureDocument.parent_revision.content_digest,
    boundary: { ...boundary, phase }, key: 'commit.read', policy: 'fixed', dependencies: [], path: read.path, dependency: read,
  })));
  const recordReads = [];
  for (const read of normalizedReads) {
    if (read.kind === 'collection') continue;
    const path = read.path;
    const native = path[1] === 'clips' || path[1] === 'tracks'
      ? { ref: `parent/${path[1] === 'clips' ? 'clip' : 'track'}:${path[2].slice(3)}`, path: path.slice(3), state: read.state }
      : { ref: 'parent', path: path[1] === 'registry' ? path.slice(1) : path, state: read.state };
    if (!recordReads.some(prior => JSON.stringify(prior) === JSON.stringify(native))) recordReads.push(native);
  }
  const authoredPath = ['config', ...changes[0].path];
  const record = { ordinal: 0, command: responseCommand,
    writes: [{ ref: nativeRef, path: ['at'], before: nativeRead.state, after: { state: 'present', value: 5 } }],
    reads: recordReads, selections: [], bindings: [...readBindings,
      { ref: 'parent', physical_ref: 'parent', revision_id: base.revisionId, content_digest: preGestureDocument.parent_revision.content_digest,
        boundary: { ...boundary, change_ordinal: 0 }, key: 'doc.patch:0', policy: 'fixed', dependencies: [], path: authoredPath, change: changes[0], write_range: [0, 1] },
      ...[['before', preGestureDocument.parent_revision], ['after', canonicalDocument.parent_revision]].map(([side, image]) => ({
        ref: 'parent', physical_ref: 'parent', revision_id: image.revision_id, content_digest: image.content_digest,
        boundary: { ...boundary, phase: 'effect', side }, key: 'commit.effect', policy: 'fixed', dependencies: [],
        path: authoredPath, step_id: request.steps[0].id, effect_ordinal: 0,
      }))], created: [], dependencies: [], derived_writes: [] };
  authoritativeHistory = { publication_id: 'publication-after', revision_id: 'revision-after',
    previous: { revision_id: base.revisionId, publication_id: base.publicationId }, receipt: response.receipt, intent: 'recorded',
    provider_version: data.provider_version, compiler_version: data.compiler_version, recorder_abi: 2, publisher: ownerScope.actorId,
    source: request.source, label: request.label, merge: request.merge, merge_mode: data.merge_mode, reads, steps: data.steps,
    records: { schema_version: 1, commands: [record], undo_of: [], restored_from: null, undo_steps: null,
      label: request.label, merge_mode: data.merge_mode, steps: data.steps } };
  acceptedValue = { response, accepted: { revisionId: 'revision-after', publicationId: 'publication-after' },
    canonicalDocument: data.canonical_document, receipt: response.receipt, graph: {} };
  settled = [{ scope: ownerScope, ownerId: 'owner-setup', generation: 1,
    pending: undefined, intents: [], accepted: { intentId: 'setup-intent', head: acceptedValue.accepted, value: acceptedValue } }];
  authoritativeHead = { revision_id: 'revision-after', publication_id: 'publication-after' };
  authoritativeRevision = { ...scope, project_id: scope.projectId, timeline_id: scope.timelineId,
    revision_id: 'revision-after', payload: canonicalDocument.parent_revision.payload };
  valid = {
    request, requestIdentity: request, responseRequest: request, requestIdempotencyKey: durableKey,
    expectedOwnerId: 'owner-setup', expectedOwnerScope: ownerScope, authoritativeHistory, preGestureDocument,
    responseStatus: 200, responseBody: response, expectedBase: base, expectedScope: scope,
    clipId, expectedTrackId: trackId, expectedPreviousPosition: 0, expectedPosition: 5, settledOutboxes: settled, authoritativeHead, authoritativeRevision,
  };
});

const responseFor = (nextData) => ({ ...response, data: nextData, receipt: { ...response.receipt, result: nextData } });

// Keep the forged acceptance internally correlated, so negatives exercise the
// qualification oracle rather than merely disagreeing with the outbox double.
function inputWithReply(reply) {
  const input = structuredClone(valid);
  input.responseBody = reply;
  const value = input.settledOutboxes[0].accepted.value;
  value.response = reply;
  value.receipt = reply.receipt;
  value.canonicalDocument = reply.data.canonical_document;
  input.authoritativeHistory.receipt = reply.receipt;
  input.requestIdentity = input.responseRequest = request;
  return input;
}

test('Gate5 requires the real 0→5 response before the original reset', () => {
  assert.doesNotThrow(() => assertGate5ResetPrecondition(valid));
});

test('the isolated 0-start cannot satisfy a 5→0 reset precondition without a setup mutation', () => {
  const oldStartData = { ...data, canonical_document: { ...data.canonical_document,
    parent_revision: { ...data.canonical_document.parent_revision,
      payload: { ...data.canonical_document.parent_revision.payload,
        clips: [{ ...preGestureParent.clips[0], at: 0 }, preGestureParent.clips[1]] } } } };
  assert.throws(() => assertGate5ResetPrecondition({
    ...valid, responseStatus: 200, responseBody: { data: oldStartData, receipt: { receipt_id: 'publication-old', result: oldStartData } },
    request: { ...request, commands: [{ ...command, args: { changes: [{ ...changes[0], value: 0 }] } }] },
  }), /requested position mismatch/);
});

test('Gate5 fails closed for non-200, missing response, invalid receipt, and mismatched position', () => {
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, responseStatus: 409 }), /response status 409/);
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, responseStatus: undefined, responseBody: undefined }), /response status/);
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, expectedPosition: 4 }), /requested position mismatch/);
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, responseBody: { ...response, receipt: { ...response.receipt, result: {} } } }), /receipt does not match/);
  const mismatchedData = { ...data, canonical_document: { ...data.canonical_document, project_id: scope.projectId, timeline_id: scope.timelineId,
    parent_revision: { ...data.canonical_document.parent_revision, revision_id: 'revision-after',
      payload: { ...data.canonical_document.parent_revision.payload,
        config: { ...data.canonical_document.parent_revision.payload.config, clips: [{ id: clipId, at: 4 }] },
        clips: [{ id: clipId, at: 4 }] } } } };
  assert.throws(() => assertGate5ResetPrecondition({
    ...valid, responseBody: responseFor(mismatchedData),
  }), /canonical position mismatch/);
});

test('Gate5 rejects unrelated responses and wrong scope, head, base, previous, key, or command identity', () => {
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, responseRequest: {} }), /not for the setup request/);
  const wrongScopeRequest = { ...request, project_id: 'other-project' };
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, request: wrongScopeRequest, requestIdentity: wrongScopeRequest, responseRequest: wrongScopeRequest }), /project scope/);
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, authoritativeHead: { revision_id: 'other', publication_id: authoritativeHead.publication_id } }), /authoritative head/);
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, request: { ...request, base_revision_id: 'other' }, requestIdentity: request, responseRequest: request }), /base revision/);
  const wrongPrevious = { ...data, previous_revision_id: 'other' };
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, responseBody: responseFor(wrongPrevious) }), /previous head/);
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, requestIdempotencyKey: 'other-key' }), /idempotency/);
  const wrongCommand = { ...request, commands: [{ ...command, op: 'track.create' }] };
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, request: wrongCommand, requestIdentity: wrongCommand, responseRequest: wrongCommand }), /mounted document patch/);
});

test('Gate5 rejects an authoritative readback with the wrong scope or position', () => {
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, authoritativeRevision: { ...authoritativeRevision, timeline_id: 'other-timeline' } }), /authoritative revision scope/);
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, authoritativeRevision: { ...authoritativeRevision, payload: { ...authoritativeRevision.payload,
    config: { clips: [{ id: clipId, at: 4 }] }, clips: [{ id: clipId, at: 4 }] } } }), /authoritative position/);
});

test('Gate5 refuses queued and pending records from the real outbox until acknowledgement settles them', async () => {
  const outbox = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (_name, work) => work() });
  await outbox.create({ ...scope, realmId: 'realm', actorId: 'actor' }, async (box) => {
    const check = async () => {
      const record = await box.read();
      return { ...valid, expectedOwnerId: record.ownerId, settledOutboxes: [record] };
    };
    const initial = await check();
    assert.throws(() => assertGate5ResetPrecondition(initial), /accepted owner result/);
    const intentId = await box.append({ commands: request.commands }, { head: base });
    const queued = await check();
    assert.equal(queued.settledOutboxes[0].pending, undefined);
    assert.equal(queued.settledOutboxes[0].intents[0].id, intentId);
    assert.throws(() => assertGate5ResetPrecondition(queued), /owner is not settled/);
    await box.dispatch(() => ({ method: 'POST', path: `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`, body: request }),
      async () => ({ kind: 'retry', error: { code: 'offline-control' } }));
    const pending = await check();
    assert.equal(pending.settledOutboxes[0].pending.intentId, intentId);
    assert.throws(() => assertGate5ResetPrecondition(pending), /owner is still pending/);
    await box.dispatch(() => { throw new Error('An exact pending retry must reuse its request'); },
      async () => ({ kind: 'accepted', head: { revisionId: 'revision-after', publicationId: 'publication-after' }, value: acceptedValue }));
    const acknowledged = await check();
    assert.doesNotThrow(() => assertGate5ResetPrecondition(acknowledged));
    assert.throws(() => assertGate5ResetPrecondition({ ...acknowledged, settledOutboxes: [...acknowledged.settledOutboxes, ...pending.settledOutboxes] }), /owner is missing or ambiguous/);
  });
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, settledOutboxes: [] }), /owner is missing/);
});

test('Gate5 refuses a mismatched authoritative publication, revision identity, or project', () => {
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, authoritativeHead: { ...authoritativeHead, publication_id: 'other-publication' } }), /authoritative head mismatch/);
  for (const mismatch of [{ project_id: 'other-project' }, { revision_id: 'other-revision' }]) {
    assert.throws(() => assertGate5ResetPrecondition({ ...valid, authoritativeRevision: { ...authoritativeRevision, ...mismatch } }), /authoritative revision scope mismatch/);
  }
});

test('Gate5 refuses successful HTTP replies with non-accepted outcomes or mismatched response identity', () => {
  for (const status of ['merged', 'rebased', 'conflict', 'invalid', 'preview']) {
    assert.throws(() => assertGate5ResetPrecondition({ ...valid, responseBody: responseFor({ ...data, status }) }), /was not accepted/);
  }
  for (const mismatch of [
    { base_revision_id: 'other-revision' }, { base_publication_id: 'other-publication' },
    { previous_revision_id: 'other-revision' }, { previous_publication_id: 'other-publication' },
    { commands: [{ ...command, args: { changes: [{ ...changes[0], value: 0 }] } }] },
  ]) {
    assert.throws(() => assertGate5ResetPrecondition({ ...valid, responseBody: responseFor({ ...data, ...mismatch }) }), /response (base|previous head|command) mismatch/);
  }
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, responseStatus: 200, responseBody: undefined }), /response is missing/);
});

test('Gate5 refuses missing or invalid receipts and idempotency keys', () => {
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, responseBody: { data } }), /receipt is missing/);
  for (const [mismatch, error] of [
    [{ receipt_id: '' }, /receipt id is missing/],
    [{ idempotency_key: 'other-key' }, /receipt idempotency mismatch/],
    [{ command_kind: 'timeline.undo' }, /receipt command mismatch/],
    [{ project_id: 'other-project' }, /receipt project mismatch/],
    [{ result: { ...data, accepted_revision_id: 'other-revision' } }, /receipt does not match/],
  ]) {
    assert.throws(() => assertGate5ResetPrecondition({ ...valid, responseBody: { ...response, receipt: { ...response.receipt, ...mismatch } } }), error);
  }
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, requestIdempotencyKey: '' }), /request idempotency key is missing/);
});

test('Gate5 refuses wrong canonical scope, accepted revision, or clip even with a matching receipt', () => {
  for (const mismatch of [{ project_id: 'other-project' }, { timeline_id: 'other-timeline' }]) {
    const canonical_document = { ...data.canonical_document, ...mismatch };
    assert.throws(() => assertGate5ResetPrecondition({ ...valid, responseBody: responseFor({ ...data, canonical_document }) }), /canonical scope mismatch/);
  }
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, responseBody: responseFor({ ...data, accepted_revision_id: 'other-revision' }) }), /canonical revision mismatch/);
  const canonical_document = { ...data.canonical_document, parent_revision: { ...data.canonical_document.parent_revision,
    payload: { ...data.canonical_document.parent_revision.payload, config: { ...data.canonical_document.parent_revision.payload.config, clips: [{ id: 'other-clip', at: 5 }] }, clips: [{ id: 'other-clip', at: 5 }] } } };
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, responseBody: responseFor({ ...data, canonical_document }) }), /canonical clip is missing/);
});

test('Gate5 refuses setup requests with the wrong timeline, publication, or target clip', () => {
  for (const [mismatch, error] of [
    [{ timeline_id: 'other-timeline' }, /timeline scope mismatch/],
    [{ base_publication_id: 'other-publication' }, /base publication mismatch/],
    [{ commands: [{ ...command, args: { changes: [{ ...changes[0], path: ['clips', 'id:other-clip', 'at'] }] } }] }, /clip mismatch/],
  ]) {
    assert.throws(() => assertGate5ResetPrecondition({ ...valid, request: { ...request, ...mismatch } }), error);
  }
});

test('Gate5 refuses an authentic-looking setup with wrong before/value, readset, or claims', () => {
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, request: {
    ...request, commands: [{ ...command, args: { changes: [{ ...changes[0], before: { state: 'present', value: 1 } }] } }],
  } }), /previous position/);
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, request: {
    ...request, commands: [{ ...command, args: { changes: [{ ...changes[0], value: 4 }] } }],
  } }), /requested position/);
  const wrongRead = { ...reads[0], path: ['clips', 'id:other-clip', 'at'] };
  const wrongReads = [wrongRead, ...reads.slice(1)];
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, request: { ...request, reads: wrongReads,
    steps: [{ ...request.steps[0], reads: wrongReads }] } }), /move read dependencies/);
  const wrongStateReads = [{ ...reads[0], state: { state: 'present', value: 1 } }, ...reads.slice(1)];
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, request: { ...request, reads: wrongStateReads,
    steps: [{ ...request.steps[0], reads: wrongStateReads }] } }), /move read dependencies/);
  for (const mutation of [{ path: ['clips', `id:${clipId}`, 'from'] }, { state: { state: 'absent' } },
    { state: { state: 'present', value: clipId, foreign: true } }]) {
    const wrong = [{ ...reads[0], ...mutation }, ...reads.slice(1)];
    assert.throws(() => assertGate5ResetPrecondition({ ...valid, request: { ...request, reads: wrong,
      steps: [{ ...request.steps[0], reads: wrong }] } }), /move read dependencies/);
  }
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, request: {
    ...request, steps: [{ ...request.steps[0], intent: 'Save local editor changes' }],
  } }), /step claims/);
});

test('Gate5 binds the settled owner to scope, identity, accepted head, receipt, and key', () => {
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, settledOutboxes: [{ ...settled[0], scope: { ...settled[0].scope, projectId: 'other-project' } }] }), /owner scope/);
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, settledOutboxes: [{ ...settled[0], ownerId: 'other-owner' }] }), /owner identity/);
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, settledOutboxes: [{ ...settled[0], accepted: { ...settled[0].accepted, head: { revisionId: 'stale', publicationId: 'publication-after' } } }] }), /owner head/);
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, settledOutboxes: [{ ...settled[0], accepted: { ...settled[0].accepted,
    value: { ...settled[0].accepted.value, receipt: { ...settled[0].accepted.value.receipt, idempotency_key: 'wrong-key' } } } }] }), /owner receipt/);
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, settledOutboxes: [{ ...settled[0], accepted: { ...settled[0].accepted,
    value: { ...settled[0].accepted.value, receipt: { ...settled[0].accepted.value.receipt, receipt_id: 'wrong-receipt' } } } }] }), /owner receipt/);
});

test('the actual opening boundary returns the fresh scoped owner with an older settled owner first', async () => {
  const spec = readFileSync(new URL('../three-products.spec.ts', import.meta.url), 'utf8');
  const start = spec.indexOf('async function openCommandTimeline(');
  const end = spec.indexOf('\nasync function prepareDependentMoves(', start);
  const compiled = ts.transpileModule(spec.slice(start, end) + '\nreturn openCommandTimeline(page, harness, seed);',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const old = { ...settled[0], ownerId: 'historical-owner' };
  let opened = false;
  const check = value => ({ toHaveLength: count => assert.equal(value.length, count) });
  check.poll = callback => ({ toMatchObject: async () => assert.equal((await callback()).ready, true) });
  const run = new (Object.getPrototypeOf(async () => {}).constructor)(
    'page', 'harness', 'seed', 'ASTRID_PYTHON', 'CEILING', 'commandOutboxes', 'openApp', 'expectConnected', 'openSeededTimeline', 'expect', compiled);
  const claimed = await run({ url: () => 'https://offline.invalid/', goto: async (url) => assert.equal(url, 'https://offline.invalid/__blank.html'),
    getByTestId: () => ({ allTextContents: async () => [] }) },
    { origin: 'https://offline.invalid', seed: scope, enableTimelineAuthoring: async () => {} }, scope, 'offline-python', {},
    async () => opened ? [old, settled[0]] : [old], async () => { opened = true; }, async () => {}, async () => {}, check);
  assert.deepEqual(claimed, { ownerId: settled[0].ownerId, scope: ownerScope });
  assert.ok(spec.includes('const preconditionOwner = await openCommandTimeline(page, harness, seed3);'));
  assert.ok(spec.includes('expectedOwnerScope: preconditionOwner.scope'));
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, expectedOwnerId: claimed.ownerId, settledOutboxes: [old] }), /owner identity/);
  assert.doesNotThrow(() => assertGate5ResetPrecondition({ ...valid, expectedOwnerId: claimed.ownerId,
    settledOutboxes: [old, settled[0]].filter(owner => owner.ownerId === claimed.ownerId) }));
});

test('the actual opening helper reads historical durable owners from a fresh blank page before mounting', async () => {
  const spec = readFileSync(new URL('../three-products.spec.ts', import.meta.url), 'utf8');
  const start = spec.indexOf('async function openCommandTimeline(');
  const end = spec.indexOf('\nasync function prepareDependentMoves(', start);
  const compiled = ts.transpileModule(spec.slice(start, end) + '\nreturn openCommandTimeline(page, harness, seed);',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const run = new (Object.getPrototypeOf(async () => {}).constructor)(
    'page', 'harness', 'seed', 'ASTRID_PYTHON', 'CEILING', 'commandOutboxes', 'openApp', 'expectConnected', 'openSeededTimeline', 'expect', compiled);
  let indexedDB, outboxes;
  const initial = { head: base, canonicalDocument: preGestureDocument };
  let lastAccepted;
  const accept = async (body, key) => {
    const reply = responseFor(data);
    reply.receipt = { ...reply.receipt, idempotency_key: key, request_hash: fixtureDigest({ operation: 'commitTimeline',
      path: `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`, publisher: ownerScope.actorId, request: body }).slice(7) };
    lastAccepted = { body, key, reply };
    return { ...acceptedValue, response: reply, receipt: reply.receipt };
  };
  const createSession = (sessionScope = ownerScope, send = accept) => {
    const document = { ...preGestureDocument, project_id: sessionScope.projectId };
    return createLocalSaveSession({ scope: sessionScope, initial: { ...initial, canonicalDocument: document }, document,
      outboxes, loadLatest: async () => initial, changed() {}, send,
      prepareDisplay: async (basis, document = basis.canonicalDocument) => ({ document, adopt() {} }) });
  };
  let mounted;
  try {
    for (const scenario of ['old-only', 'new', 'foreign', 'nonempty', 'pending']) {
      indexedDB = createFakeIndexedDB();
      outboxes = createCommitOutbox({ indexedDB, exclusiveLock: async (_name, work) => work() });
      // Persist the historical acceptance through the real encoder/session/outbox.
      const old = await createSession();
      await old.appendDocument({ before: preGestureDocument, after: moved,
        roots: [{ ref: 'parent', revisionId: base.revisionId, contentDigest: preGestureDocument.parent_revision.content_digest }],
        label: request.label, step: request.steps[0], merge: 'fields', reads });
      await old.flush();
      const oldId = old.getState().ownerId;
      await old.dispose();
      const calls = [];
      let url = 'about:blank';
      const page = { url: () => url,
        goto: async (target) => { assert.equal(target, 'https://offline.invalid/__blank.html'); url = target; calls.push('origin'); },
        getByTestId: () => ({ allTextContents: async () => [] }) };
      const check = value => ({ toHaveLength: count => assert.equal(value.length, count) });
      check.poll = callback => ({ toMatchObject: async () => assert.equal((await callback()).ready, true) });
      const readOwners = async (_page, timelineId) => {
        assert.equal(new URL(url).origin, 'https://offline.invalid');
        calls.push('read');
        // Real durable rows; only the browser inspection transport is replaced.
        const owners = await outboxes.list({ realmId: ownerScope.realmId, actorId: ownerScope.actorId, timelineId });
        // Exercise old-first ordering with actual durable records, not invented owners.
        return owners.sort((left, right) => left.ownerId === oldId ? -1 : right.ownerId === oldId ? 1 : 0);
      };
      const open = async () => {
        assert.deepEqual(calls, ['origin', 'read']);
        calls.push('mount');
        if (scenario === 'old-only') return;
        mounted = await createSession(scenario === 'foreign' ? { ...ownerScope, projectId: 'foreign-project' } : ownerScope,
          scenario === 'pending' ? async () => { throw new Error('offline ACK loss'); } : undefined);
        if (scenario === 'nonempty' || scenario === 'pending') {
          await mounted.append({ before: preGestureDocument, after: moved, label: request.label, commands: request.commands,
            steps: request.steps, reads });
          if (scenario === 'pending') await assert.rejects(mounted.flush());
        }
      };
      const opening = run(page, { origin: 'https://offline.invalid', seed: scope, enableTimelineAuthoring: async () => {} },
        scope, 'offline-python', { timeout: 90_000 }, readOwners, open,
        async () => { calls.push('connected'); }, async () => { calls.push('selected'); }, check);
      if (scenario === 'new') {
        const claimed = await opening;
        assert.deepEqual(claimed, { ownerId: mounted.getState().ownerId, scope: ownerScope });
        assert.notEqual(claimed.ownerId, oldId);
        assert.deepEqual(calls.slice(0, 5), ['origin', 'read', 'mount', 'connected', 'selected']);
        const historical = (await readOwners(page, scope.timelineId)).filter(owner => owner.ownerId === oldId);
        assert.throws(() => assertGate5ResetPrecondition({ ...valid, expectedOwnerId: claimed.ownerId,
          settledOutboxes: historical }), /owner identity/);
        await mounted.appendDocument({ before: preGestureDocument, after: moved,
          roots: [{ ref: 'parent', revisionId: base.revisionId, contentDigest: preGestureDocument.parent_revision.content_digest }],
          label: request.label, step: request.steps[0], merge: 'fields', reads });
        await mounted.flush();
        const input = { ...inputWithReply(lastAccepted.reply), request: lastAccepted.body,
          requestIdentity: lastAccepted.body, responseRequest: lastAccepted.body, requestIdempotencyKey: lastAccepted.key,
          expectedOwnerId: claimed.ownerId, expectedOwnerScope: claimed.scope,
          settledOutboxes: (await readOwners(page, scope.timelineId)).filter(owner => owner.ownerId === claimed.ownerId) };
        assert.doesNotThrow(() => assertGate5ResetPrecondition(input));
        assert.throws(() => assertGate5ResetPrecondition({ ...input, settledOutboxes: historical }), /owner identity/);
      } else await assert.rejects(opening, /false !== true/);
      await mounted?.dispose();
      mounted = undefined;
    }
  } finally {
    await mounted?.dispose();
  }
});

test('Gate5 accepts source-generated supplied annotations and binds their request, reply, history and owner forwarding', async () => {
  const annotations = { rationale: 'Move the selected clip to five seconds', group_id: 'setup-annotation-group' };
  const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (_name, work) => work() });
  const initial = { head: base, canonicalDocument: preGestureDocument };
  let suppliedRequest, suppliedKey, suppliedReply;
  const session = await createLocalSaveSession({ scope: ownerScope, initial, document: preGestureDocument,
    outboxes, loadLatest: async () => initial, changed() {},
    prepareDisplay: async (basis, document = basis.canonicalDocument) => ({ document, adopt() {} }),
    send: async (body, key) => {
      suppliedRequest = body;
      suppliedKey = key;
      const nextData = { ...data, rationale: body.rationale, group_id: body.group_id };
      suppliedReply = responseFor(nextData);
      suppliedReply.receipt = { ...suppliedReply.receipt, idempotency_key: key,
        request_hash: fixtureDigest({ operation: 'commitTimeline',
          path: `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`, publisher: ownerScope.actorId, request: body }).slice(7) };
      return { ...acceptedValue, response: suppliedReply, receipt: suppliedReply.receipt };
    } });
  try {
    // localSaveSession.append forwards caller annotations; appendDocument does not.
    await session.append({ before: preGestureDocument, after: moved, label: request.label, commands: request.commands,
      steps: request.steps, reads, ...annotations });
    await session.flush();
    assert.deepEqual(suppliedRequest, { ...request, ...annotations });
    const input = { ...inputWithReply(suppliedReply), request: suppliedRequest,
      requestIdentity: suppliedRequest, responseRequest: suppliedRequest, requestIdempotencyKey: suppliedKey,
      expectedRequestAnnotations: annotations, expectedOwnerId: session.getState().ownerId,
      settledOutboxes: await outboxes.list(ownerScope), authoritativeHistory: { ...authoritativeHistory,
        ...annotations, receipt: suppliedReply.receipt } };
    assert.doesNotThrow(() => assertGate5ResetPrecondition(input));
    for (const key of ['rationale', 'group_id']) {
      for (const value of [null, 1, {}, 'different']) {
        assert.throws(() => assertGate5ResetPrecondition({ ...input, request: { ...suppliedRequest, [key]: value } }), /request .* mismatch/);
        const reply = responseFor({ ...suppliedReply.data, [key]: value });
        assert.throws(() => assertGate5ResetPrecondition({ ...input, responseBody: reply }), /response .* mismatch/);
      }
      const missing = { ...suppliedRequest };
      delete missing[key];
      assert.throws(() => assertGate5ResetPrecondition({ ...input, request: missing }), /request keys/);
      const missingData = { ...suppliedReply.data };
      delete missingData[key];
      assert.throws(() => assertGate5ResetPrecondition({ ...input, responseBody: responseFor(missingData) }), /response data keys/);
      const history = { ...input.authoritativeHistory, [key]: 'different' };
      assert.throws(() => assertGate5ResetPrecondition({ ...input, authoritativeHistory: history }), /authoritative history/);
      assert.throws(() => assertGate5ResetPrecondition({ ...input, expectedRequestAnnotations: { ...annotations, [key]: 1 } }), /producer annotations/);
    }
    assert.throws(() => assertGate5ResetPrecondition({ ...input, request: { ...suppliedRequest, foreign: true } }), /request keys/);
    assert.throws(() => assertGate5ResetPrecondition({ ...input, responseBody: responseFor({ ...suppliedReply.data, foreign: true }) }), /response data keys/);
    assert.throws(() => assertGate5ResetPrecondition({ ...input, expectedRequestAnnotations: undefined }), /request keys/);
    assert.throws(() => assertGate5ResetPrecondition({ ...valid, responseBody: suppliedReply }), /response data keys/);
    assert.throws(() => assertGate5ResetPrecondition({ ...input, expectedRequestAnnotations: { ...annotations, group_id: '' } }), /producer annotations/);
  } finally { await session.dispose(); }
});

test('Gate5 refuses missing, extra, or wrong normalized command claims and accepted steps', () => {
  for (const field of ['intent', 'resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created']) {
    const extra = structuredClone(data);
    extra.commands[0][field] = Array.isArray(extra.commands[0][field]) ? [...extra.commands[0][field], 'foreign'] : { ...extra.commands[0][field], foreign: true };
    assert.throws(() => assertGate5ResetPrecondition(inputWithReply(responseFor(extra))), /response command/);
    const missing = structuredClone(data);
    delete missing.commands[0][field];
    assert.throws(() => assertGate5ResetPrecondition(inputWithReply(responseFor(missing))), /response command/);
  }
  for (const [field, wrong] of [['id', 'other-step'], ['label', 'Other'], ['intent', 'Other'], ['tags', ['other']],
    ['command_ordinals', [1]], ['patch', []], ['reads', []], ['dependencies', []]]) {
    for (const remove of [false, true]) {
      const next = structuredClone(data);
      if (remove) delete next.steps[0][field];
      else next.steps[0][field] = wrong;
      assert.throws(() => assertGate5ResetPrecondition(inputWithReply(responseFor(next))), /response step/);
    }
  }
  const wrong = structuredClone(data);
  wrong.commands[0].expect[`${nativeRef}::at`].value = 1;
  assert.throws(() => assertGate5ResetPrecondition(inputWithReply(responseFor(wrong))), /response command claims/);
});

test('Gate5 rejects arbitrary transport keys and forged receipt correlation', () => {
  for (const path of [[], ['data'], ['receipt'], ['data', 'commands', 0], ['data', 'steps', 0],
    ['data', 'commands', 0, 'args'], ['data', 'commands', 0, 'args', 'changes', 0]]) {
    const next = structuredClone(response);
    let target = next;
    for (const token of path) target = target[token];
    target.foreign = true;
    next.receipt.result = next.data;
    assert.throws(() => assertGate5ResetPrecondition(inputWithReply(next)), /keys mismatch|response command|step claims/);
  }
  for (const [key, value] of [['created_at', 'invalid'], ['request_hash', '0'.repeat(64)], ['project_seq', [2, 1]],
    ['event_ids', []]]) {
    const next = structuredClone(response);
    next.receipt[key] = value;
    assert.throws(() => assertGate5ResetPrecondition(inputWithReply(next)), /receipt/);
    delete next.receipt[key];
    assert.throws(() => assertGate5ResetPrecondition(inputWithReply(next)), /receipt keys/);
  }
  for (const path of [[], ['commands', 0], ['commands', 0, 'args'], ['steps', 0]]) {
    const next = structuredClone(request);
    let target = next;
    for (const token of path) target = target[token];
    target.foreign = true;
    assert.throws(() => assertGate5ResetPrecondition({ ...valid, request: next }), /keys/);
  }
});

test('Gate5 checks full canonical closure, digest, history records, effects, dependencies and undo metadata', () => {
  for (const mutate of [
    value => { value.canonical_document.shot_revisions[0].payload.metadata.extension.nested[0] = false; },
    value => { value.document_digest = 'sha256:' + '0'.repeat(64); },
    value => { value.id_map.foreign = 'id'; },
    value => { value.publisher = 'other-actor'; },
  ]) {
    const next = structuredClone(data);
    mutate(next);
    assert.throws(() => assertGate5ResetPrecondition(inputWithReply(responseFor(next))), /canonical closure|document digest|id map|publisher/);
  }
  const wrongAbi = structuredClone(authoritativeHistory);
  wrongAbi.recorder_abi = 1;
  assert.throws(() => assertGate5ResetPrecondition({ ...valid, authoritativeHistory: wrongAbi }), /authoritative history/);
  for (const mutate of [
    entry => { entry.foreign = true; }, entry => { entry.records.foreign = true; },
    entry => { entry.records.commands[0].foreign = true; },
    entry => { entry.records.commands[0].bindings[0].boundary.foreign = true; },
    entry => { entry.records.commands[0].writes[0].after.value = 4; },
    entry => { entry.records.commands[0].reads[0].state.value = 'other-clip'; },
    entry => { entry.records.commands[0].bindings[0].revision_id = 'stale'; },
    entry => { entry.steps[0].dependencies[0].state.value = 'other-clip'; },
    entry => { entry.records.undo_of = ['other-publication']; },
    entry => { delete entry.records.undo_steps; },
    entry => { entry.receipt.idempotency_key = 'wrong-key'; },
  ]) {
    const next = structuredClone(authoritativeHistory);
    mutate(next);
    assert.throws(() => assertGate5ResetPrecondition({ ...valid, authoritativeHistory: next }), /authoritative history/);
  }
});

test('the actual Gate5 setup listens before the real drag helper drops, and ignores another POST reply', async () => {
  // Execute the caller's waiter/gesture slice, not a copy of its scheduling logic. Page events and geometry are offline doubles.
  const spec = readFileSync(new URL('../three-products.spec.ts', import.meta.url), 'utf8');
  const start = spec.indexOf('  const preconditionRequest =');
  const end = spec.indexOf('  const setupBody = await setupResponse.json();', start);
  assert.ok(start > 0 && end > start);
  const source = spec.slice(start, end) + '\nreturn { setupRequest, setupResponse };';
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const run = new (Object.getPrototypeOf(async () => {}).constructor)(
    'page', 'preconditionBase', 'timelineBase', 'harness', 'seed3', 'CEILING', 'dragTimelineClip', 'THREE_PRODUCTS_REFERENCE_AT', compiled);
  const events = new EventEmitter();
  const wait = (event, predicate) => new Promise((resolve, reject) => {
    const listener = async (value) => {
      try {
        if (await predicate(value)) { events.off(event, listener); resolve(value); }
      } catch (error) { reject(error); }
    };
    events.on(event, listener);
  });
  const setupRequest = { method: () => 'POST', url: () => 'https://offline.invalid/api/runtime/v1/projects/project-f2/timelines/timeline-f2/commit', postDataJSON: () => request };
  const wrongMoveRequest = { ...setupRequest, postDataJSON: () => ({ ...request, commands: [{ ...request.commands[0], args: { on: 0 } }] }) };
  const unrelatedRequest = { ...setupRequest }; // An already in-flight POST with identical bytes still has a different identity.
  const setupResponse = { request: () => setupRequest };
  const geometry = (x) => ({ _apiName: 'Locator', _expect: async () => ({ matches: true }), first() { return this; }, boundingBox: async () => ({ x, y: 0, width: 40, height: 20 }) });
  const page = {
    locator: (selector) => geometry(selector.includes('f2-app-clip') ? 0 : 100),
    waitForRequest: (predicate) => wait('request', predicate),
    waitForResponse: (predicate) => wait('response', predicate),
    mouse: {
      move: async () => {}, down: async () => {},
      up: async () => {
        assert.equal(events.listenerCount('response'), 1, 'A fast mounted reply can arrive during mouse.up before dragTimelineClip returns');
        events.emit('request', wrongMoveRequest);
        events.emit('response', { request: () => unrelatedRequest });
        events.emit('request', setupRequest);
        events.emit('response', setupResponse);
      },
    },
  };
  const result = await run(page, { head: { revision_id: base.revisionId, publication_id: base.publicationId } },
    () => '/v1/projects/project-f2/timelines/timeline-f2', {}, { appClipId: 'f2-app-clip', transitionClipId: 'reference' }, {}, dragTimelineClip, 10);
  assert.equal(result.setupRequest, setupRequest);
  assert.equal(result.setupResponse, setupResponse);
});

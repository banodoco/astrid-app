// Pure controls for the mounted P2 parent-move request assertion; no browser or Runtime execution.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import { expect } from '@playwright/test';
import ts from 'typescript';

const source = readFileSync(new URL('../three-products.p2-tour.spec.ts', import.meta.url), 'utf8');
const parentHelper = source.match(/^function assertParentMoveRequestV2\([^]*?^}/m)?.[0];
const requestHelper = source.match(/^function assertRequestV2\([^]*?^}/m)?.[0];
const documentPatchHelper = source.match(/^function assertDocumentPatchRequest\([^]*?^}/m)?.[0];
const transitionHelper = source.match(/^function assertTransitionRequestV2\([^]*?^}/m)?.[0];
const objectHelper = source.match(/^function object\([^]*?^}/m)?.[0];
const normalizedCommandsHelper = source.match(/^function assertNormalizedCommands\([^]*?^}/m)?.[0];
const replyHelper = source.match(/^function assertReplyShape\([^]*?^}/m)?.[0];
const historyHelper = source.match(/^function assertAuthoritativeHistoryPublication\([^]*?^}/m)?.[0];
const historyMetadataHelper = source.match(/^function assertHistoryMetadata\([^]*?^}/m)?.[0];
const headHelper = source.match(/^function assertAuthoritativeHead\([^]*?^}/m)?.[0];
const inverseHelper = source.match(/^function assertInverseTargetsPublication\([^]*?^}/m)?.[0];
const undoHelper = source.match(/^function assertUndoHistoryPublication\([^]*?^}/m)?.[0];
assert.ok(parentHelper, 'exercise the actual mounted parent-move assertion helper');
assert.ok(requestHelper, 'exercise the actual mounted v2 request assertion helper');
assert.ok(documentPatchHelper && transitionHelper, 'exercise the actual mounted transition request assertions');
assert.ok(replyHelper, 'exercise the actual mounted reply assertion helper');
assert.ok(historyHelper && headHelper && inverseHelper && undoHelper, 'exercise actual publication binding helpers');
assert.ok(historyMetadataHelper, 'exercise the actual mounted history metadata assertion helper');
const check = compileFunction(`${ts.transpileModule(parentHelper, {}).outputText}\nreturn assertParentMoveRequestV2;`, ['expect'])(expect);
const checkRequest = compileFunction(`${ts.transpileModule(requestHelper, {}).outputText}\nreturn assertRequestV2;`, ['expect'])(expect);
const checkDocumentPatch = compileFunction(`${ts.transpileModule(documentPatchHelper, {}).outputText}\nreturn assertDocumentPatchRequest;`, ['expect'])(expect);
const checkTransition = compileFunction(`${ts.transpileModule(transitionHelper, {}).outputText}\nreturn assertTransitionRequestV2;`, ['expect'])(expect);
const checkReply = compileFunction([
  objectHelper, normalizedCommandsHelper, replyHelper,
].map((helper) => ts.transpileModule(helper, {}).outputText).join('\n') + '\nreturn assertReplyShape;', ['expect'])(expect);
const checkBindings = compileFunction([
  historyHelper, headHelper, inverseHelper, undoHelper,
].map((helper) => ts.transpileModule(helper, {}).outputText).join('\n') + '\nreturn { assertAuthoritativeHistoryPublication, assertAuthoritativeHead, assertInverseTargetsPublication, assertUndoHistoryPublication };', ['expect'])(expect);
const checkHistoryMetadata = compileFunction([
  historyHelper, normalizedCommandsHelper, historyMetadataHelper,
].map((helper) => ts.transpileModule(helper, {}).outputText).join('\n') + '\nreturn assertHistoryMetadata;', ['expect'])(expect);

const original = {
  project_id: 'project',
  timeline_id: 'timeline',
  parent_revision: {
    payload: {
      config: {
        clips: [
          { id: 'f2-app-clip', at: 0, track: 'V1', clipType: 'media', from: 0, to: 3, speed: 1, asset: 'f2-app' },
          { id: 'f2-transition-clip', at: 15, track: 'V1', clipType: 'media', from: 0, to: 3, speed: 1, asset: 'f2-video' },
        ],
        tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
        output: { fps: 30 },
      },
      registry: { assets: { 'f2-app': { object_id: 'sha256:image' }, 'f2-video': { object_id: 'sha256:video' } } },
    },
  },
};

const reads = [
  ['id', 'f2-app-clip', { state: 'present', value: 'f2-app-clip' }],
  ['track', 'f2-app-clip', { state: 'present', value: 'V1' }],
  ['at', 'f2-app-clip', { state: 'present', value: 0 }],
  ['clipType', 'f2-app-clip', { state: 'present', value: 'media' }],
  ['hold', 'f2-app-clip', { state: 'absent' }],
  ['from', 'f2-app-clip', { state: 'present', value: 0 }],
  ['to', 'f2-app-clip', { state: 'present', value: 3 }],
  ['speed', 'f2-app-clip', { state: 'present', value: 1 }],
  ['asset', 'f2-app-clip', { state: 'present', value: 'f2-app' }],
  ['fps', 'output', { state: 'present', value: 30 }],
  ['f2-app', 'assets', { state: 'present', value: original.parent_revision.payload.registry.assets['f2-app'] }],
  ['kind', 'V1', { state: 'present', value: 'visual' }],
  ['pinnedShotGroups', 'config', { state: 'absent' }],
  ['collection', 'clips', null],
  ['track', 'f2-transition-clip', { state: 'present', value: 'V1' }],
  ['id', 'f2-transition-clip', { state: 'present', value: 'f2-transition-clip' }],
  ['track', 'f2-transition-clip', { state: 'present', value: 'V1' }],
  ['at', 'f2-transition-clip', { state: 'present', value: 15 }],
  ['clipType', 'f2-transition-clip', { state: 'present', value: 'media' }],
  ['hold', 'f2-transition-clip', { state: 'absent' }],
  ['from', 'f2-transition-clip', { state: 'present', value: 0 }],
  ['to', 'f2-transition-clip', { state: 'present', value: 3 }],
  ['speed', 'f2-transition-clip', { state: 'present', value: 1 }],
  ['asset', 'f2-transition-clip', { state: 'present', value: 'f2-video' }],
  ['f2-video', 'assets', { state: 'present', value: original.parent_revision.payload.registry.assets['f2-video'] }],
];

function fieldRead(path, state) {
  return { kind: 'field', ref: 'parent', path, state };
}

function fixture() {
  const collection = { kind: 'collection', ref: 'parent', path: ['config', 'clips'], members: ['f2-app-clip', 'f2-transition-clip'], order: ['f2-app-clip', 'f2-transition-clip'] };
  const expectedReads = reads.map(([key, owner, state]) => {
    if (key === 'collection') return collection;
    if (key === 'fps') return fieldRead(['config', 'output', 'fps'], state);
    if (key === 'f2-app' || key === 'f2-video') return fieldRead(['config', 'registry', 'assets', key], state);
    if (key === 'kind') return fieldRead(['config', 'tracks', `id:${owner}`, 'kind'], state);
    if (key === 'pinnedShotGroups') return fieldRead(['config', key], state);
    return fieldRead(['config', 'clips', `id:${owner}`, key], state);
  });
  const changes = [{ op: 'set', ref: 'parent', path: ['clips', 'id:f2-app-clip', 'at'], before: { state: 'present', value: 0 }, value: 5 }];
  return {
    post: {
      key: 'receipt',
      body: {
        api_version: 1, project_id: 'project', timeline_id: 'timeline',
        base_revision_id: 'revision', base_publication_id: 'publication',
        commands: [{ schema_version: 1, op: 'doc.patch', version: '1', select: null, created: [], args: { changes } }],
        label: 'Edit timeline',
        steps: [{ id: '0f3c4b3a-2e1d-4c5b-8a79-8123456789ab', label: 'Edit timeline', intent: 'Move f2-app-clip on V1', tags: [], command_ordinals: [0], patch: changes, reads: expectedReads }],
        merge: 'fields', reads: expectedReads, dry_run: false, source: { via: 'app' },
      },
    },
    expectedReads,
  };
}

test('actual helper accepts the exact parent move request shape', () => {
  const { post } = fixture();
  check(post, { revision_id: 'revision', publication_id: 'publication' }, original, 'f2-app-clip', 5);
});

test('actual helper refuses malformed, missing, and extra parent move variants', () => {
  const { post } = fixture();
  const variants = [
    (candidate) => { delete candidate.body.commands[0].created; },
    (candidate) => { candidate.body.commands[0].created = ['parent/clip:unexpected']; },
    (candidate) => { delete candidate.body.reads; },
    (candidate) => { candidate.body.reads = [...candidate.body.reads, { kind: 'scope', ref: 'timeline', path: [] }]; },
    (candidate) => { candidate.body.steps[0].reads = candidate.body.steps[0].reads.slice(0, -1); },
    (candidate) => { candidate.body.reads[0].path[3] = 'wrong'; },
    (candidate) => { candidate.body.steps[0].reads[0].path[3] = 'wrong'; },
    (candidate) => { candidate.body.reads[0].state.value = 'wrong'; },
    (candidate) => { candidate.body.steps[0].reads[0].state.value = 'wrong'; },
    (candidate) => { candidate.body.reads[0].state.state = 'absent'; },
    (candidate) => { candidate.body.steps[0].reads[0].state.state = 'absent'; },
    (candidate) => { candidate.body.extra = true; },
    (candidate) => { candidate.body.commands[0].extra = true; },
    (candidate) => { candidate.body.steps[0].extra = true; },
    (candidate) => { candidate.body.commands[0].select = { extra: true }; },
    (candidate) => { candidate.body.commands[0].args.extra = true; },
    (candidate) => { candidate.body.base_revision_id = 'other-revision'; },
    (candidate) => { candidate.body.base_publication_id = 'other-publication'; },
    (candidate) => { candidate.body.merge = 'atomic'; },
    (candidate) => { candidate.body.commands[0].op = 'clip.move'; },
    (candidate) => { candidate.body.commands[0].args.changes[0].value = 4; },
    (candidate) => { candidate.body.steps[0].intent = 'Save local editor changes'; },
    (candidate) => { candidate.body.rationale = 'extra'; },
  ];
  for (const mutate of variants) {
    const candidate = structuredClone(post);
    mutate(candidate);
    assert.throws(() => check(candidate, { revision_id: 'revision', publication_id: 'publication' }, original, 'f2-app-clip', 5));
  }
});

function transitionFixture(ids) {
  const original = {
    project_id: 'project',
    timeline_id: 'timeline',
    parent_revision: {
      payload: {
        config: {
          clips: [
            { id: 'f2-app-clip', transition: { type: 'crossfade', duration: 0.5 } },
            { id: 'f2-transition-clip', transition: { type: 'fade', duration: 0.75 } },
          ],
        },
      },
    },
  };
  const changes = ids.map((id) => ({
    op: 'remove', ref: 'parent', path: ['clips', `id:${id}`, 'transition'],
    before: { state: 'present', value: original.parent_revision.payload.config.clips.find((clip) => clip.id === id).transition },
  }));
  const reads = ids.flatMap((id) => [
    { kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${id}`, 'id'], state: { state: 'present', value: id } },
    { kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${id}`, 'transition'], state: { state: 'present', value: original.parent_revision.payload.config.clips.find((clip) => clip.id === id).transition } },
  ]);
  reads.push({ kind: 'field', ref: 'parent', path: ['config', 'pinnedShotGroups'], state: { state: 'absent' } });
  return {
    original,
    changes,
    post: {
      key: 'receipt',
      body: {
        api_version: 1, project_id: 'project', timeline_id: 'timeline',
        base_revision_id: 'revision', base_publication_id: 'publication',
        commands: [{ schema_version: 1, op: 'doc.patch', version: '1', select: null, created: [], args: { changes } }],
        label: 'Edit timeline',
        steps: [{ id: '0f3c4b3a-2e1d-4c5b-8a79-8123456789ab', label: 'Edit timeline',
          intent: `Clear transitions: ${ids.join(', ')}`, tags: [], command_ordinals: [0], patch: changes, reads }],
        merge: 'fields', reads, dry_run: false, source: { via: 'app' },
      },
    },
    before: { revision_id: 'revision', publication_id: 'publication' },
  };
}

test('actual transition helper accepts exact single and bulk clear requests', () => {
  for (const ids of [['f2-transition-clip'], ['f2-app-clip', 'f2-transition-clip']]) {
    const fixture = transitionFixture(ids);
    checkTransition(fixture.post, fixture.before, fixture.original, ids, fixture.changes);
  }
});

test('retired generic transition intent is red against the exact authored action', () => {
  const fixture = transitionFixture(['f2-transition-clip']);
  assert.throws(() => checkDocumentPatch(fixture.post.body, fixture.changes, [], 'Save local editor changes'));
  checkTransition(fixture.post, fixture.before, fixture.original, ['f2-transition-clip'], fixture.changes);
});

test('transition helpers refuse wrong single intent/label and bulk value/label', () => {
  const single = transitionFixture(['f2-transition-clip']);
  const wrongSingleIntent = structuredClone(single.post);
  wrongSingleIntent.body.steps[0].intent = 'Save local editor changes';
  assert.throws(() => checkTransition(wrongSingleIntent, single.before, single.original, ['f2-transition-clip'], single.changes));
  const wrongSingleLabel = structuredClone(single.post);
  wrongSingleLabel.body.label = 'Wrong label';
  assert.throws(() => checkTransition(wrongSingleLabel, single.before, single.original, ['f2-transition-clip'], single.changes));

  const bulk = transitionFixture(['f2-app-clip', 'f2-transition-clip']);
  const wrongBulkValue = structuredClone(bulk.post);
  wrongBulkValue.body.commands[0].args.changes[0].before.value.type = 'wrong-transition';
  assert.throws(() => checkTransition(wrongBulkValue, bulk.before, bulk.original, ['f2-app-clip', 'f2-transition-clip'], bulk.changes));
  const wrongBulkLabel = structuredClone(bulk.post);
  wrongBulkLabel.body.steps[0].label = 'Wrong label';
  assert.throws(() => checkTransition(wrongBulkLabel, bulk.before, bulk.original, ['f2-app-clip', 'f2-transition-clip'], bulk.changes));
});

function inverseFixture() {
  const command = {
    schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
    args: { publications: ['publication'] },
  };
  const body = {
    api_version: 1, project_id: 'project', timeline_id: 'timeline',
    base_revision_id: 'revision', base_publication_id: 'publication',
    commands: [command], label: 'Undo timeline',
    steps: [{ id: '0f3c4b3a-2e1d-4c5b-8a79-8123456789ab', label: 'Undo timeline', intent: 'Undo timeline',
      tags: [], command_ordinals: [0], patch: [] }],
    merge: 'fields', reads: [], dry_run: false, source: { via: 'app' },
  };
  return {
    post: { key: 'request-key', body },
    before: { revision_id: 'revision', publication_id: 'publication' },
    expected: { projectId: 'project', timelineId: 'timeline', publicationId: 'publication', action: 'Undo' },
  };
}

test('actual shared request helper accepts the full v2 Undo envelope', () => {
  const { post, before, expected } = inverseFixture();
  checkRequest(post, before, expected);
});

test('actual shared request helper accepts the source-derived full v2 Redo envelope', () => {
  const { post, before, expected } = inverseFixture();
  post.body.label = 'Redo timeline';
  post.body.steps[0].label = 'Redo timeline';
  post.body.steps[0].intent = 'Redo timeline';
  checkRequest(post, before, { ...expected, action: 'Redo' });
});

test('the retired minimal Undo envelope is red against the genuine full request', () => {
  const { post, before, expected } = inverseFixture();
  assert.throws(() => assert.deepEqual(post.body, {
    api_version: 1, project_id: expected.projectId, timeline_id: expected.timelineId,
    base_revision_id: before.revision_id, base_publication_id: before.publication_id,
    commands: post.body.commands, source: { via: 'app' },
  }));
  checkRequest(post, before, expected);
});

test('actual shared request helper refuses Undo envelope mutations', () => {
  const { post, before, expected } = inverseFixture();
  const variants = [
    (candidate) => { candidate.body.label = 'Edit timeline'; },
    (candidate) => { candidate.body.steps[0].id = 'wrong-step'; },
    (candidate) => { candidate.body.steps[0].tags = ['wrong-tag']; },
    (candidate) => { candidate.body.steps[0].patch = [{ op: 'set' }]; },
    (candidate) => { candidate.body.reads = [{ kind: 'scope', ref: 'timeline', path: [] }]; },
    (candidate) => { delete candidate.body.reads; },
    (candidate) => { delete candidate.body.steps; },
    (candidate) => { candidate.body.extra = true; },
    (candidate) => { candidate.body.commands[0].args.publications[0] = 'other-publication'; },
    (candidate) => { candidate.body.commands[0].op = 'doc.patch'; },
    (candidate) => { candidate.body.base_revision_id = 'other-revision'; },
    (candidate) => { candidate.body.base_publication_id = 'other-publication'; },
  ];
  for (const mutate of variants) {
    const candidate = structuredClone(post);
    mutate(candidate);
    assert.throws(() => checkRequest(candidate, before, expected));
  }
});

function historyMetadataFixture(declaredReads, includeRequestReads = true) {
  const key = '0f3c4b3a-2e1d-4c5b-8a79-0123456789ab';
  const receiptId = 'txn-0123456789abcdef0123456789abcdef';
  const command = {
    schema_version: 1, op: 'doc.patch', version: '1', select: null,
    created: [], args: { changes: [] }, intent: {}, resolved: [], expect: {},
    authorship: {}, reads: [], selections: [], bindings: {},
  };
  const step = {
    id: 'step', label: 'Edit timeline', intent: 'Edit timeline', tags: [],
    command_ordinals: [0], patch: [{ op: 'set' }], dependencies: [{ kind: 'scope' }],
  };
  const body = {
    api_version: 1, project_id: 'project', timeline_id: 'timeline',
    base_revision_id: 'revision', base_publication_id: 'publication',
    commands: [command], label: 'Edit timeline', steps: [step], merge: 'fields',
    dry_run: false, source: { via: 'app' },
    ...(includeRequestReads ? { reads: declaredReads } : {}),
  };
  const data = {
    status: 'accepted', base_revision_id: 'revision', base_publication_id: 'publication',
    previous_revision_id: 'revision', previous_publication_id: 'publication',
    accepted_revision_id: 'revision-next', rebased_onto: null, canonical_document: {},
    document_digest: 'sha256:document', commands: [command], id_map: {},
    provider_version: 'provider', compiler_version: 'compiler', merge_mode: 'fields',
    steps: [step], publisher: 'publisher', source: body.source, label: body.label,
  };
  const receipt = {
    receipt_id: receiptId, command_kind: 'timeline.commit', idempotency_key: key,
    request_hash: 'hash', project_id: 'project', project_seq: [1, 1], event_ids: ['event'],
    result: data, created_at: '2026-10-24T00:00:00Z',
  };
  const entry = {
    publication_id: receiptId, revision_id: 'revision-next',
    previous: { revision_id: 'revision', publication_id: 'publication' }, receipt,
    intent: 'recorded', records: {
      commands: [{ ordinal: 0, command, writes: [{ ref: 'parent', path: ['clips'] }],
        reads: [{ kind: 'field' }], bindings: [{ key: 'doc.patch:0' }], dependencies: [] }],
      steps: [step], label: 'Edit timeline', merge_mode: 'fields',
    },
    provider_version: 'provider', compiler_version: 'compiler', publisher: 'publisher',
    source: body.source, label: body.label, merge: 'fields', merge_mode: 'fields', steps: [step],
    ...(includeRequestReads ? { reads: declaredReads } : {}),
  };
  return { post: { key, body }, result: { data, receipt }, entry };
}

test('actual history helper preserves exact declared reads and omitted-read absence', () => {
  const declaredReads = [{ kind: 'field', ref: 'parent', path: ['config', 'clips'], state: { state: 'present', value: 'base' } }];
  const declared = historyMetadataFixture(declaredReads);
  assert.doesNotThrow(() => checkHistoryMetadata(declared.entry, declared.post, declared.result));

  const mismatched = structuredClone(declared);
  mismatched.entry.reads = [...declaredReads, { kind: 'scope', ref: 'timeline', path: [] }];
  assert.throws(() => checkHistoryMetadata(mismatched.entry, mismatched.post, mismatched.result));

  const omitted = historyMetadataFixture([] , false);
  assert.doesNotThrow(() => checkHistoryMetadata(omitted.entry, omitted.post, omitted.result));
  const forged = structuredClone(omitted);
  forged.entry.reads = [];
  assert.throws(() => checkHistoryMetadata(forged.entry, forged.post, forged.result));
});

function replyFixture() {
  const key = '0f3c4b3a-2e1d-4c5b-8a79-0123456789ab';
  const receiptId = 'txn-0123456789abcdef0123456789abcdef';
  const command = {
    schema_version: 1, op: 'doc.patch', version: '1', select: null,
    created: [], args: { changes: [] }, intent: {}, resolved: [], expect: {},
    authorship: {}, reads: [], selections: [], bindings: {},
  };
  const body = {
    api_version: 1, project_id: 'project', timeline_id: 'timeline',
    base_revision_id: 'revision', base_publication_id: 'publication',
    commands: [command], label: 'Edit timeline', steps: [{
      id: 'step', label: 'Edit timeline', intent: 'Edit timeline', tags: [],
      command_ordinals: [0], patch: [{ op: 'set' }], dependencies: [{ kind: 'scope' }],
    }], merge: 'fields', dry_run: false, source: { via: 'app' },
  };
  const data = {
    status: 'accepted', base_revision_id: 'revision', base_publication_id: 'publication',
    previous_revision_id: 'revision', previous_publication_id: 'publication',
    accepted_revision_id: 'revision-next', rebased_onto: null, canonical_document: {},
    document_digest: 'sha256:document', commands: [command], id_map: {},
    provider_version: 'provider', compiler_version: 'compiler', merge_mode: 'fields',
    steps: body.steps, publisher: 'publisher', source: body.source, label: body.label,
  };
  const receipt = {
    receipt_id: receiptId, command_kind: 'timeline.commit', idempotency_key: key,
    request_hash: 'hash', project_id: 'project', project_seq: [1, 1], event_ids: ['event'],
    result: data, created_at: '2026-10-24T00:00:00Z',
  };
  const envelope = { data, receipt };
  return {
    post: {
      key, body, json: envelope,
      response: { status: () => 200 },
    },
    result: envelope,
  };
}

function inverseReplyFixture(action) {
  const fixture = replyFixture();
  const command = {
    schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
    args: { publications: ['publication'] },
  };
  const submittedStep = {
    id: 'inverse-step', label: `${action} timeline`, intent: `${action} timeline`, tags: [],
    command_ordinals: [0], patch: [],
  };
  const authoritativeCommand = {
    ...command, intent: {}, resolved: [], expect: {}, authorship: {}, reads: [], selections: [], bindings: {}, created: [],
  };
  const authoritativeStep = {
    ...submittedStep, patch: [{ op: 'set' }], dependencies: [{ kind: 'scope' }],
  };
  fixture.post.body.commands = [command];
  fixture.post.body.label = `${action} timeline`;
  fixture.post.body.steps = [submittedStep];
  fixture.post.body.merge = 'fields';
  fixture.post.body.reads = [];
  fixture.post.json.data.commands = [authoritativeCommand];
  fixture.post.json.data.label = `${action} timeline`;
  fixture.post.json.data.steps = [authoritativeStep];
  fixture.post.json.data.merge_mode = 'fields';
  fixture.post.json.receipt.command_kind = 'timeline.inverse';
  return fixture;
}

test('actual reply helper uses explicit native Undo/Redo metadata and keeps omission fallback exact', () => {
  for (const action of ['Undo', 'Redo']) {
    const fixture = inverseReplyFixture(action);
    assert.doesNotThrow(() => checkReply(fixture.post, { revision_id: 'revision', publication_id: 'publication' }));
  }

  const legacy = replyFixture();
  delete legacy.post.body.label;
  delete legacy.post.body.steps;
  legacy.post.json.data.label = 'Timeline edit';
  legacy.post.json.data.steps = [{
    id: 'edit', label: 'Timeline edit', intent: '', tags: [], command_ordinals: [0],
    patch: [{ op: 'set' }], dependencies: [{ kind: 'scope' }],
  }];
  assert.doesNotThrow(() => checkReply(legacy.post, { revision_id: 'revision', publication_id: 'publication' }));
});

test('actual reply helper refuses wrong, missing, and extra explicit native metadata', () => {
  const variants = [
    (candidate) => { candidate.post.body.label = 'Timeline edit'; },
    (candidate) => { delete candidate.post.body.steps; },
    (candidate) => { candidate.post.body.steps[0].intent = 'wrong intent'; },
    (candidate) => { candidate.post.json.data.label = 'Timeline edit'; },
    (candidate) => { candidate.post.json.data.steps[0].unexpected = true; },
    (candidate) => { candidate.post.json.data.steps[0].dependencies = []; },
  ];
  for (const mutate of variants) {
    const candidate = inverseReplyFixture('Undo');
    mutate(candidate);
    assert.throws(() => checkReply(candidate.post, { revision_id: 'revision', publication_id: 'publication' }));
  }
});

test('actual reply helper accepts a distinct UUID request key and txn receipt identity', () => {
  const { post, result } = replyFixture();
  checkReply(post, { revision_id: 'revision', publication_id: 'publication' });
  assert.equal(result.receipt.receipt_id, 'txn-0123456789abcdef0123456789abcdef');
  assert.notEqual(result.receipt.receipt_id, post.key);
});

test('actual reply helper refuses wrong receipt identity, request key, and head', () => {
  const variants = [
    (candidate) => { candidate.result.receipt.receipt_id = candidate.post.key; },
    (candidate) => { candidate.result.receipt.idempotency_key = 'other-request-key'; },
    (candidate) => { candidate.result.data.previous_publication_id = 'wrong-publication'; },
  ];
  for (const mutate of variants) {
    const candidate = replyFixture();
    mutate(candidate);
    assert.throws(() => checkReply(candidate.post, { revision_id: 'revision', publication_id: 'publication' }));
  }
});

test('actual publication helpers accept exact history, head, inverse, and undo bindings', () => {
  const { result } = replyFixture();
  const publicationId = result.receipt.receipt_id;
  const entry = { publication_id: publicationId, records: { undo_of: [publicationId] } };
  const inverse = { body: { commands: [{
    schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
    args: { publications: [publicationId] },
  }] } };
  checkBindings.assertAuthoritativeHistoryPublication(entry, result);
  checkBindings.assertAuthoritativeHead({ revision_id: 'revision-next', publication_id: publicationId }, result);
  checkBindings.assertInverseTargetsPublication(inverse, publicationId);
  checkBindings.assertUndoHistoryPublication(entry, publicationId);
});

test('actual publication helpers refuse wrong history, head, inverse, and undo bindings', () => {
  const { result } = replyFixture();
  const publicationId = result.receipt.receipt_id;
  const wrong = [
    () => checkBindings.assertAuthoritativeHistoryPublication({ publication_id: 'wrong-publication' }, result),
    () => checkBindings.assertAuthoritativeHead({ revision_id: 'revision-next', publication_id: 'wrong-publication' }, result),
    () => checkBindings.assertInverseTargetsPublication({ body: { commands: [{
      schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
      args: { publications: ['wrong-publication'] },
    }] } }, publicationId),
    () => checkBindings.assertUndoHistoryPublication({ records: { undo_of: ['wrong-publication'] } }, publicationId),
  ];
  for (const checkWrong of wrong) assert.throws(checkWrong);
});

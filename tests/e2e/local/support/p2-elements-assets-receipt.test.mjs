// Pure controls for the actual mounted elements/assets receipt helpers; no browser or Runtime execution.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import { expect } from '@playwright/test';
import ts from 'typescript';

const source = readFileSync(new URL('../three-products.p2-elements-assets.spec.ts', import.meta.url), 'utf8');
const extract = (name) => {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `exercise the actual ${name} helper`);
  return match[0];
};
const requestHelper = extract('assertRequestV2');
const helperSource = [
  'object', 'exactKeys', 'digest', 'nativeImages', 'nativeChild', 'nativeState', 'nativeConfig', 'nativeRows',
  'nativeValue', 'nativeSite', 'nativeAssetReads', 'nativeSelection', 'nativeBinding', 'nativeEffects', 'nativeUndoExpected',
  'canonicalJson', 'materializedIdentity', 'assertRequestV2', 'acceptedMutation', 'publicationId', 'assertNativeAcceptedReply', 'assertNativeHistoryEntry',
  'assertAcceptedReply', 'assertHistoryEntry', 'assertUndoHistoryEntry', 'assertOccurrenceParentProjection',
  'projectedPlacementClipId', 'assertMountedPlacementIdentity',
].map(extract).join('\n');
const transpile = (input) => {
  const result = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  assert.deepEqual(result.diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error), [], 'exercise valid source without parser recovery');
  return result.outputText;
};
const sha256Hex = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const helpers = compileFunction(`${transpile(helperSource)}\nreturn { assertAcceptedReply, assertHistoryEntry, assertUndoHistoryEntry, assertOccurrenceParentProjection, projectedPlacementClipId, assertMountedPlacementIdentity };`, ['expect', 'sha256Hex'])(expect, sha256Hex);
const checkRequest = compileFunction(`${transpile([extract('object'), requestHelper].join('\n'))}\nreturn assertRequestV2;`, ['expect'])(expect);

const command = {
  schema_version: 1,
  op: 'doc.patch',
  version: '1',
  select: null,
  args: { changes: [{ op: 'set', ref: 'parent', path: ['clips', 'id:clip-1', 'at'], before: { state: 'present', value: 0 }, value: 5 }] },
};
const step = { id: 'step-1', label: 'Edit timeline', intent: 'Edit timeline', tags: [], command_ordinals: [0], patch: command.args.changes };
const requestId1 = '6d8f4e2a-7c41-4b9e-8d03-5a6f1c2e7b90';
const requestId2 = 'b1c2d3e4-f567-4890-ab12-cd34ef567890';
const receiptId1 = 'txn-9a7b6c5d4e3f2a10b9c8d7e6f5a40321';
const receiptId2 = 'txn-1234567890abcdef1234567890abcdef';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const receiptPattern = /^txn-[0-9a-f]{32}$/i;

function acceptedPost() {
  const data = {
    status: 'accepted', base_revision_id: 'revision-0', base_publication_id: 'publication-0',
    previous_revision_id: 'revision-0', previous_publication_id: 'publication-0',
    accepted_revision_id: 'revision-1', rebased_onto: null, canonical_document: {}, document_digest: 'digest',
    commands: [command], id_map: {}, provider_version: 'provider', compiler_version: 'compiler',
    merge_mode: 'atomic', steps: [step], publisher: 'publisher', source: { via: 'app' }, label: 'Edit timeline',
  };
  const receipt = {
    receipt_id: receiptId1, command_kind: 'timeline.commit', idempotency_key: requestId1, request_hash: 'hash',
    project_id: 'project', project_seq: [1, 1], event_ids: ['event'], result: data, created_at: '2026-10-24T00:00:00Z',
  };
  const body = {
    api_version: 1, project_id: 'project', timeline_id: 'timeline',
    base_revision_id: 'revision-0', base_publication_id: 'publication-0', commands: [command],
    label: 'Edit timeline', steps: [step], merge: 'atomic', dry_run: false, source: { via: 'app' },
  };
  return { request: {}, response: { status: () => 200 }, body, json: { data, receipt }, key: requestId1 };
}

function historyFor(post, { publication = receiptId1, receipt = post.json.receipt, revision = 'revision-1' } = {}) {
  return { head: { revision_id: revision, publication_id: publication }, next_cursor: null, items: [{
    publication_id: publication, revision_id: revision, receipt, intent: 'recorded',
    records: { commands: [{ ordinal: 0, command, writes: ['parent'], reads: ['parent'], bindings: ['parent'], dependencies: [], derived_writes: [] }],
      steps: [{ patch: [{ op: 'set' }], dependencies: ['parent'] }], undo_steps: [], undo_of: [] },
    previous: { revision_id: 'revision-0', publication_id: 'publication-0' },
    provider_version: 'provider', compiler_version: 'compiler', merge: 'atomic', merge_mode: 'atomic',
    steps: [step], publisher: 'publisher', source: { via: 'app' }, label: 'Edit timeline',
  }] };
}

function fixtureDigest(value) {
  return sha256Hex(Buffer.from(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)));
}

function occurrenceProjectionFixture() {
  const beforeParent = {
    config: { output: { fps: 30 }, opaque: 'retained' },
    occurrences: [
      { occurrence_id: 'occ', shot_id: 'shot', shot_revision_id: 'shot-old', duration_ms: 20000 },
      { occurrence_id: 'sibling', shot_id: 'sibling-shot', shot_revision_id: 'sibling-old', duration_ms: 10000 },
    ],
    opaque: { retained: true },
  };
  const source = {
    objectId: `sha256:${'a'.repeat(64)}`,
    digest: `sha256:${'b'.repeat(64)}`,
    mediaType: 'image/png',
    generationId: 'generation-1',
    variantId: 'variant-1',
  };
  const row = { id: 'clip-added', track: 'V1', at: 5, hold: 5, asset: 'asset-new', clipType: 'hold' };
  const normalized = { media_id: source.objectId, type: 'image', generationId: source.generationId, variantId: source.variantId };
  const beforeChildPayload = {
    output: { fps: 30 }, tracks: [{ id: 'V1', kind: 'visual' }],
    clips: [{ id: 'clip-existing', track: 'V1', at: 0, hold: 5, asset: 'asset-existing', clipType: 'hold' }],
    registry: { assets: { 'asset-existing': { media_id: `sha256:${'e'.repeat(64)}`, type: 'image' } } },
    opaque: { keep: ['x', null] },
  };
  const beforeShotPayload = { name: 'Shot', internal_timeline_revision_id: 'child-old', metadata: { keep: true }, opaque: { keep: null } };
  const expectedChildPayload = structuredClone(beforeChildPayload);
  expectedChildPayload.clips.push(row);
  expectedChildPayload.registry.assets['asset-new'] = normalized;
  const internalRevisionId = 'authoring-timeline-revision-4768f43a29fe6fdb3b0c25d8a804863a6ece9212964adb9fa23d6f893b22f6f3';
  const shotRevisionId = 'authoring-shot-revision-7c7a18d5cff6af7edb176720a27c7ac8dfff2405ea411e2bbadc76f7ffca8a46';
  const expectedShotPayload = { ...beforeShotPayload, internal_timeline_revision_id: internalRevisionId };
  const afterParent = structuredClone(beforeParent);
  afterParent.occurrences[0].shot_revision_id = shotRevisionId;
  const before = {
    schema_version: 1, project_id: 'project', timeline_id: 'timeline',
    parent_revision: { revision_id: 'parent-old', content_digest: fixtureDigest(beforeParent), payload: beforeParent },
    shot_revisions: [{ shot_id: 'shot', revision_id: 'shot-old', internal_timeline_revision_id: 'child-old', timeline_id: 'timeline', content_digest: fixtureDigest(beforeShotPayload), payload: beforeShotPayload }],
    internal_timeline_revisions: [{ revision_id: 'child-old', timeline_id: 'timeline', content_digest: fixtureDigest(beforeChildPayload), payload: beforeChildPayload }],
    dependency_manifest: {
      shots: [{ shot_id: 'shot', revision_id: 'shot-old', internal_timeline_revision_id: 'child-old', content_digest: fixtureDigest(beforeShotPayload) }],
      internal_timelines: [{ timeline_id: 'timeline', revision_id: 'child-old', content_digest: fixtureDigest(beforeChildPayload) }],
      media: [{ media_id: source.objectId, content_digest: source.digest }], documents: [],
    },
  };
  const after = {
    schema_version: 1, project_id: 'project', timeline_id: 'timeline',
    parent_revision: { revision_id: 'parent-new', content_digest: fixtureDigest(afterParent), payload: afterParent },
    shot_revisions: [{ shot_id: 'shot', revision_id: shotRevisionId, internal_timeline_revision_id: internalRevisionId, timeline_id: 'timeline', content_digest: fixtureDigest(expectedShotPayload), payload: expectedShotPayload }],
    internal_timeline_revisions: [{ revision_id: internalRevisionId, timeline_id: 'timeline', content_digest: fixtureDigest(expectedChildPayload), payload: expectedChildPayload }],
    dependency_manifest: {
      shots: [{ shot_id: 'shot', revision_id: shotRevisionId, internal_timeline_revision_id: internalRevisionId, content_digest: fixtureDigest(expectedShotPayload) }],
      internal_timelines: [{ timeline_id: 'timeline', revision_id: internalRevisionId, content_digest: fixtureDigest(expectedChildPayload) }],
      media: [{ media_id: source.objectId, content_digest: source.digest }], documents: [],
    },
  };
  const result = { data: { accepted_revision_id: 'parent-new', document_digest: fixtureDigest(after), canonical_document: after, steps: [{ patch: [
    { op: 'set', ref: `internal-revision:${internalRevisionId}`, path: [], before: { state: 'absent' }, value: expectedChildPayload },
    { op: 'set', ref: `shot-revision:${shotRevisionId}`, path: [], before: { state: 'absent' }, value: expectedShotPayload },
    { op: 'set', ref: 'parent', path: ['occurrences', 'occurrence_id:occ', 'shot_revision_id'],
      before: { state: 'present', value: 'shot-old' }, value: shotRevisionId },
    { op: 'remove', ref: 'shot-revision:shot-old', path: [], before: { state: 'present', value: beforeShotPayload } },
    { op: 'remove', ref: 'internal-revision:child-old', path: [], before: { state: 'present', value: beforeChildPayload } },
  ] }] } };
  return { before, after, result, occurrenceId: 'occ', row, source };
}

test('actual occurrence parent projection rejects the stale whole-parent expectation', () => {
  const fixture = occurrenceProjectionFixture();
  assert.throws(() => expect(fixture.after.parent_revision.payload).toEqual(fixture.before.parent_revision.payload));
  assert.doesNotThrow(() => helpers.assertOccurrenceParentProjection(
    fixture.before, fixture.after, fixture.result, fixture.occurrenceId, fixture.row, fixture.source,
  ));
});

function mountedPlacementFixture() {
  const fixture = occurrenceProjectionFixture();
  const rawClipId = String(fixture.row.id);
  const occurrenceId = fixture.occurrenceId;
  const child = fixture.after.internal_timeline_revisions.find((image) => image.revision_id === fixture.result.data.steps[0].patch[0].ref.slice('internal-revision:'.length));
  assert.ok(child, 'mounted fixture has the projected child revision');
  const payloadDigest = fixtureDigest(child.payload);
  return {
    ...fixture,
    occurrenceId,
    rawClipId,
    payloadDigest,
    mounted: [{
      clipId: helpers.projectedPlacementClipId(occurrenceId, rawClipId),
      occurrenceId,
      rawClipId,
      physicalRef: `occurrence:${occurrenceId}`,
      payloadDigest,
    }],
  };
}

function canonicalPlacementDigest(fixture) {
  return fixtureDigest({ before: fixture.before, after: fixture.after, result: fixture.result });
}

test('actual mounted placement identity accepts one occurrence-scoped canonical child', () => {
  const fixture = mountedPlacementFixture();
  assert.doesNotThrow(() => helpers.assertMountedPlacementIdentity(
    fixture.mounted, fixture.occurrenceId, fixture.rawClipId, fixture.payloadDigest, true,
  ));
});

for (const [name, mutate] of [
  ['wrong occurrence', (fixture) => {
    fixture.mounted[0].occurrenceId = 'other-occurrence';
    fixture.mounted[0].physicalRef = 'occurrence:other-occurrence';
    fixture.mounted[0].clipId = helpers.projectedPlacementClipId('other-occurrence', fixture.rawClipId);
  }],
  ['sibling physical owner', (fixture) => {
    fixture.mounted[0].occurrenceId = 'sibling';
    fixture.mounted[0].physicalRef = 'occurrence:sibling';
  }],
  ['raw fallback', (fixture) => { fixture.mounted[0].clipId = fixture.rawClipId; }],
  ['duplicate', (fixture) => { fixture.mounted.push(structuredClone(fixture.mounted[0])); }],
  ['same-bytes sibling', (fixture) => fixture.mounted.push({
    clipId: helpers.projectedPlacementClipId('sibling', fixture.rawClipId),
    occurrenceId: 'sibling',
    rawClipId: fixture.rawClipId,
    physicalRef: 'occurrence:sibling',
    payloadDigest: fixture.payloadDigest,
  })],
]) test(`actual mounted placement identity rejects byte-identical ${name}`, () => {
  const fixture = mountedPlacementFixture();
  const canonical = canonicalPlacementDigest(fixture);
  mutate(fixture);
  assert.equal(canonicalPlacementDigest(fixture), canonical, `${name} changes no canonical bytes`);
  assert.throws(() => helpers.assertMountedPlacementIdentity(
    fixture.mounted, fixture.occurrenceId, fixture.rawClipId, fixture.payloadDigest, true,
  ));
});

test('fixed inverse rejects projected residue that the old raw inverse accepts', () => {
  const fixture = mountedPlacementFixture();
  const oldRawInverse = () => assert.equal(
    fixture.mounted.filter((candidate) => candidate.clipId === fixture.rawClipId).length, 0,
  );
  assert.doesNotThrow(oldRawInverse);
  assert.throws(() => helpers.assertMountedPlacementIdentity(
    fixture.mounted, fixture.occurrenceId, fixture.rawClipId, fixture.payloadDigest, false,
  ));
  fixture.mounted = [];
  assert.doesNotThrow(() => helpers.assertMountedPlacementIdentity(
    fixture.mounted, fixture.occurrenceId, fixture.rawClipId, fixture.payloadDigest, false,
  ));
});

for (const [name, mutate] of [
  ['wrong physical shot', (fixture) => { fixture.after.shot_revisions[0].shot_id = 'sibling-shot'; }],
  ['sibling parent field', (fixture) => { fixture.after.parent_revision.payload.occurrences[1].duration_ms = 10001; }],
  ['opaque parent field', (fixture) => { fixture.after.parent_revision.payload.opaque.retained = false; }],
]) test(`actual occurrence parent projection rejects ${name}`, () => {
  const fixture = occurrenceProjectionFixture();
  mutate(fixture);
  assert.throws(() => helpers.assertOccurrenceParentProjection(
    fixture.before, fixture.after, fixture.result, fixture.occurrenceId, fixture.row, fixture.source,
  ));
});

for (const [name, mutate] of [
  ['fabricated shot payload', (fixture) => { fixture.after.shot_revisions[0].payload.name = 'fabricated'; }],
  ['extra child fields', (fixture) => { fixture.after.internal_timeline_revisions[0].payload.extra = true; }],
  ['extra shot records', (fixture) => { fixture.after.shot_revisions.push({ shot_id: 'extra', revision_id: 'extra', internal_timeline_revision_id: 'extra', payload: {}, content_digest: fixtureDigest({}) }); }],
  ['changed existing child rows', (fixture) => { fixture.after.internal_timeline_revisions[0].payload.clips[0].hold = 99; }],
  ['wrong child owner', (fixture) => { fixture.after.internal_timeline_revisions[0].timeline_id = 'wrong-timeline'; }],
  ['missing shot image', (fixture) => { fixture.after.shot_revisions.splice(0, 1); }],
  ['missing child payload', (fixture) => { delete fixture.after.internal_timeline_revisions[0].payload; }],
  ['missing existing child row', (fixture) => { fixture.after.internal_timeline_revisions[0].payload.clips.splice(0, 1); }],
]) test(`actual occurrence parent projection rejects ${name}`, () => {
  const fixture = occurrenceProjectionFixture();
  mutate(fixture);
  assert.throws(() => helpers.assertOccurrenceParentProjection(
    fixture.before, fixture.after, fixture.result, fixture.occurrenceId, fixture.row, fixture.source,
  ));
});

test('actual accepted helper preserves distinct publication and idempotency identities', () => {
  const post = acceptedPost();
  assert.match(post.key, uuidPattern);
  assert.match(post.json.receipt.receipt_id, receiptPattern);
  assert.notEqual(post.key, post.json.receipt.receipt_id);
  assert.doesNotThrow(() => helpers.assertAcceptedReply(post, { revision_id: 'revision-0', publication_id: 'publication-0' }));
  assert.throws(() => helpers.assertAcceptedReply({ ...post, json: { ...post.json, receipt: { ...post.json.receipt, receipt_id: post.key } } }, { revision_id: 'revision-0', publication_id: 'publication-0' }));
  assert.throws(() => helpers.assertAcceptedReply({ ...post, json: { ...post.json, receipt: { ...post.json.receipt, idempotency_key: 'wrong-request' } } }, { revision_id: 'revision-0', publication_id: 'publication-0' }));
});

test('actual history helper joins by authoritative publication and guards the head', () => {
  const post = acceptedPost();
  const result = post.json;
  assert.doesNotThrow(() => helpers.assertHistoryEntry(historyFor(post), post, result));
  assert.throws(() => helpers.assertHistoryEntry(historyFor(post, { publication: post.key }), post, result));
  assert.throws(() => helpers.assertHistoryEntry({ ...historyFor(post), head: { revision_id: 'revision-1', publication_id: post.key } }, post, result));
  assert.throws(() => helpers.assertHistoryEntry(historyFor(post, { receipt: { ...post.json.receipt, receipt_id: 'wrong-receipt' } }), post, result));
});

test('actual mounted asset helper accepts the exact native inverse envelope and rejects policy drift', () => {
  const post = {
    key: requestId2,
    body: {
      api_version: 1, project_id: 'project', timeline_id: 'timeline',
      base_revision_id: 'revision-1', base_publication_id: receiptId1,
      commands: [{ schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: [receiptId1] } }],
      label: 'Undo timeline',
      steps: [{ id: '6d8f4e2a-7c41-4b9e-8d03-5a6f1c2e7b90', label: 'Undo timeline', intent: 'Undo timeline', tags: [], command_ordinals: [0], patch: [] }],
      merge: 'fields', reads: [], dry_run: false, source: { via: 'app' },
    },
  };
  assert.doesNotThrow(() => checkRequest(post, { revision_id: 'revision-1', publication_id: receiptId1 }, { project_id: 'project', timeline_id: 'timeline' }, receiptId1));
  const variants = [
    (candidate) => { candidate.body.project_id = 'wrong-project'; },
    (candidate) => { candidate.body.timeline_id = 'wrong-timeline'; },
    (candidate) => { candidate.body.merge = 'atomic'; },
    (candidate) => { delete candidate.body.reads; },
    (candidate) => { candidate.body.reads = [{ kind: 'scope', ref: 'timeline', path: [] }]; },
    (candidate) => { candidate.body.commands[0].args.publications[0] = 'wrong-publication'; },
    (candidate) => { candidate.body.commands[0].extra = true; },
    (candidate) => { candidate.body.commands[0].select = {}; },
    (candidate) => { candidate.body.steps[0].patch = [{ op: 'set' }]; },
    (candidate) => { candidate.body.steps[0].reads = []; },
    (candidate) => { candidate.body.steps[0].label = 'Edit timeline'; },
    (candidate) => { candidate.body.base_revision_id = 'wrong-revision'; },
    (candidate) => { candidate.body.base_publication_id = 'wrong-publication'; },
    (candidate) => { candidate.body.extra = true; },
  ];
  for (const mutate of variants) {
    const candidate = structuredClone(post);
    mutate(candidate);
    assert.throws(() => checkRequest(candidate, { revision_id: 'revision-1', publication_id: receiptId1 }, { project_id: 'project', timeline_id: 'timeline' }, receiptId1));
  }
});

// Independent inputs and a hand-derived native transcript. No expected record is built from post.json,
// and none of the helpers under test constructs the positive fixture.
const hash = (value) => sha256Hex(Buffer.from(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)));
const present = (value) => ({ state: 'present', value: structuredClone(value) });
const absent = { state: 'absent' };
const initialRow = { id: 'clip-1', track: 'V1', at: 0, hold: 5, params: { bob: 3 } };
const addedRow = { id: 'clip-new', track: 'V1', at: 5, hold: 5, asset: 'asset-new', clipType: 'hold' };
const asset = { media_id: `sha256:${'a'.repeat(64)}`, type: 'image', generationId: 'generation-1', variantId: 'variant-1' };
const tracks = [{ id: 'V1', kind: 'visual' }];
const shapeClips = { members: present([]), config: present({}), payload_members: present([]) };
const shapeTracks = { members: present([]), config: present({}) };
const shapeAssets = { 0: { registry: present({}), assets: present({}) }, 1: { registry: absent, assets: absent } };
const read = (ref, path, value) => ({ ref, path, state: value });
const write = (ref, path, before, after) => ({ ref, path, before, after });
const select = (key, owner, members, boundaries = members) => ({ key, query_version: 1, owner, members, order: members, boundaries, policy: 'guard-membership' });

function document(parent, revision, childRevision = null) {
  const children = childRevision ? [{ timeline_id: 'child', revision_id: childRevision,
    payload: { output: { fps: 30 }, tracks, clips: childRevision === 'child-0' ? [initialRow] : [initialRow, addedRow],
      registry: { assets: childRevision === 'child-0' ? {} : { 'asset-new': asset } } } }] : [];
  const shots = childRevision ? [{ shot_id: 'shot', revision_id: childRevision === 'child-0' ? 'shot-0' : 'shot-1',
    internal_timeline_revision_id: childRevision, payload: { internal_timeline_revision_id: childRevision, items: [] } }] : [];
  for (const image of [...children, ...shots]) image.content_digest = hash(image.payload);
  return { schema_version: 1, project_id: 'project', timeline_id: 'timeline',
    parent_revision: { revision_id: revision, content_digest: hash(parent), payload: parent },
    shot_revisions: shots, internal_timeline_revisions: children,
    dependency_manifest: {
      shots: shots.map(({ shot_id, revision_id, internal_timeline_revision_id, content_digest }) => ({ shot_id, revision_id, internal_timeline_revision_id, content_digest })),
      internal_timelines: children.map(({ timeline_id, revision_id, content_digest }) => ({ timeline_id, revision_id, content_digest })),
      media: childRevision === 'child-1' || parent.registry.assets['asset-new'] ? [{ media_id: asset.media_id, content_digest: asset.media_id }] : [], documents: [],
    } };
}

function nativeFixture(kind = 'params') {
  const originalParent = { config: { output: { fps: 30 }, tracks, clips: [initialRow] }, clips: [initialRow], registry: { assets: {} }, occurrences: [] };
  const landedParent = structuredClone(originalParent);
  if (kind === 'params') {
    landedParent.clips[0].params.bob = 12;
    landedParent.config.clips[0].params.bob = 12;
  } else if (kind === 'element' || kind === 'asset') {
    landedParent.clips.push(addedRow); landedParent.config.clips.push(addedRow);
    if (kind === 'asset') landedParent.registry.assets['asset-new'] = asset;
  } else {
    originalParent.occurrences = [{ occurrence_id: 'occ', shot_id: 'shot', shot_revision_id: 'shot-0', duration_ms: 20000 }];
    landedParent.occurrences = [{ occurrence_id: 'occ', shot_id: 'shot', shot_revision_id: 'shot-1', duration_ms: 20000 }];
  }
  const restored = document(originalParent, 'revision-0', kind === 'child' ? 'child-0' : null);
  const before = document(landedParent, 'revision-1', kind === 'child' ? 'child-1' : null);
  const pins = kind === 'params' ? [{ document_id: 'config:retained', version: 2, content_digest: hash({ fps: 30 }) },
    { document_id: 'transcript:retained', version: 1, content_digest: hash({ words: [] }) }] : [];
  before.dependency_manifest.documents = structuredClone(pins);
  restored.dependency_manifest.documents = structuredClone(pins);
  let sourceReads, sourceWrites, sourceSelections, reads, writes, selections, patch, dependencies, derived;
  const bindings = [], commandBindings = {};
  const base = { revision_id: 'revision-1', publication_id: receiptId1 };
  const submitted = { id: requestId1, label: 'Undo timeline', intent: 'Undo timeline', tags: [], command_ordinals: [0], patch: [] };
  const boundary = { base_revision_id: 'revision-1', base_publication_id: receiptId1, evaluated_head: base,
    step_id: requestId1, command_ordinal: 0, phase: 'input' };
  if (kind === 'params') {
    sourceReads = [read('parent/clip:clip-1', ['params'], present({ bob: 3 }))];
    sourceWrites = [write('parent/clip:clip-1', ['params'], present({ bob: 3 }), present({ bob: 12 }))];
    sourceSelections = [];
    reads = [read('parent/clip:clip-1', ['params'], present({ bob: 12 }))];
    writes = [write('parent/clip:clip-1', ['params'], present({ bob: 12 }), present({ bob: 3 }))];
    selections = [];
    patch = [{ op: 'set', ref: 'parent', path: ['config', 'clips', 'id:clip-1', 'params', 'bob'], before: present(12), value: 3 }];
    dependencies = [{ kind: 'field', ref: 'parent', path: ['config', 'clips', 'id:clip-1', 'params'], state: present({ bob: 12 }) }];
    derived = [{ ...write('parent', ['config', 'clips'], present(landedParent.clips), present(originalParent.clips)), cause: 0 }];
  } else if (kind === 'element') {
    sourceReads = []; sourceSelections = [];
    sourceWrites = [write('parent', ['clips'], present(originalParent.clips), present(landedParent.clips)),
      write('parent', ['config', 'clips'], present(originalParent.clips), present(landedParent.clips))];
    reads = [read('parent', ['config', 'clips'], present(landedParent.clips)), read('parent', ['clips'], present(landedParent.clips))];
    writes = [write('parent', ['config', 'clips'], present(landedParent.clips), present(originalParent.clips)),
      write('parent', ['clips'], present(landedParent.clips), present(originalParent.clips))];
    selections = []; derived = [];
    patch = [{ op: 'set', ref: 'parent', path: ['config', 'clips'], before: present(landedParent.clips), value: originalParent.clips }];
    dependencies = [{ kind: 'field', ref: 'parent', path: ['config', 'clips'], state: present(landedParent.clips) }];
  } else if (kind === 'asset') {
    sourceReads = [read('parent', ['config', 'output', 'fps'], present(30)), read('parent/source', ['source_window'], absent),
      read('parent/collection:track', [], present(shapeTracks)), read('parent/track:V1', [], present(tracks[0])),
      read('parent/collection:occurrence', [], present({ container: 'array' })), read('parent/collection:asset', [], present(shapeAssets)),
      read('parent/asset:asset-new', [], absent), read('parent/collection:clip', [], present(shapeClips)), read('parent/clip:clip-new', [], absent)];
    sourceSelections = [select('collection.tracks', 'parent', ['parent/track:V1']), select('collection.occurrences', 'parent', []), select('collection.clips', 'parent', ['parent/clip:clip-1'])];
    sourceWrites = [write('parent/asset:asset-new', [], absent, present(asset)), write('parent/clip:clip-new', [], absent, present(addedRow))];
    reads = [read('parent/collection:clip', [], present(shapeClips)), ...sourceReads.slice(0, 6),
      read('parent/asset:asset-new', [], present(asset)), read('parent/clip:clip-new', [], present(addedRow))];
    writes = [write('parent/clip:clip-new', [], present(addedRow), absent), write('parent/asset:asset-new', [], present(asset), absent)];
    selections = [select('collection.clips', 'parent', ['parent/clip:clip-1', 'parent/clip:clip-new']), ...sourceSelections.slice(0, 2)];
    patch = [{ op: 'set', ref: 'parent', path: ['config', 'clips'], before: present(landedParent.clips), value: originalParent.clips },
      { op: 'remove', ref: 'parent', path: ['config', 'registry', 'assets', 'asset-new'], before: present(asset) }];
    dependencies = [
      { kind: 'collection', ref: 'parent', path: ['config', 'clips'], members: ['clip-1', 'clip-new'], order: ['clip-1', 'clip-new'] },
      { kind: 'field', ref: 'parent', path: ['config', 'output', 'fps'], state: present(30) },
      { kind: 'field', ref: 'parent', path: ['config', 'source_window'], state: absent },
      { kind: 'collection', ref: 'parent', path: ['config', 'tracks'], members: ['V1'], order: ['V1'] },
      { kind: 'field', ref: 'parent', path: ['config', 'tracks', 'id:V1'], state: present(tracks[0]) },
      { kind: 'collection', ref: 'parent', path: ['occurrences'], members: [], order: [] },
      { kind: 'field', ref: 'parent', path: ['registry'], state: present(landedParent.registry) },
      { kind: 'field', ref: 'parent', path: ['config', 'registry'], state: absent },
      { kind: 'field', ref: 'parent', path: ['config', 'registry', 'assets', 'asset-new'], state: present(asset) },
      { kind: 'field', ref: 'parent', path: ['config', 'clips', 'id:clip-new'], state: present(addedRow) },
    ];
    derived = [{ ...write('parent', ['config', 'clips'], present(landedParent.clips), present(originalParent.clips)), cause: 0 }];
  } else {
    const owner = 'occurrence:occ';
    sourceReads = [read('parent/collection:occurrence', [], present({ container: 'array' })), read(owner, ['occurrence_id'], present('occ')),
      read(`${owner}/shot`, ['shot_id'], present('shot')), read(`${owner}/source`, ['output', 'fps'], present(30)),
      read(`${owner}/collection:clip`, [], present({ members: present([]) })), read(`${owner}/collection:track`, [], present({ members: present([]) })),
      read(`${owner}/asset:asset-new`, [], absent), read(`${owner}/clip:clip-new`, [], absent)];
    sourceSelections = [select('collection.occurrences', 'parent', [owner]), select('placement.owners', owner, [owner], ['shot:shot']),
      select('collection.clips', owner, [`${owner}/clip:clip-1`]), select('collection.tracks', owner, [`${owner}/track:V1`])];
    sourceWrites = [write(`${owner}/asset:asset-new`, [], absent, present(asset)), write(`${owner}/clip:clip-new`, [], absent, present(addedRow))];
    reads = [read(`${owner}/collection:clip`, [], present({ members: present([]) })), sourceReads[1], sourceReads[2], sourceReads[0], sourceReads[3], sourceReads[5],
      read(`${owner}/asset:asset-new`, [], present(asset)), read(`${owner}/clip:clip-new`, [], present(addedRow))];
    writes = [write(`${owner}/clip:clip-new`, [], present(addedRow), absent), write(`${owner}/asset:asset-new`, [], present(asset), absent)];
    selections = [select('collection.clips', owner, [`${owner}/clip:clip-1`, `${owner}/clip:clip-new`]), ...sourceSelections.slice(0, 2), sourceSelections[3]];
    for (const key of ['collection.clips', 'collection.tracks']) {
      bindings.push({ key: `collection.owner:${key}`, ref: owner, policy: 'fixed', dependencies: [], physical_ref: 'parent',
        revision_id: 'revision-1', content_digest: before.parent_revision.content_digest, boundary, path: ['occurrences', 'occurrence_id:occ'] });
      commandBindings[`collection.owner:${key}`] = owner;
    }
    const child0 = restored.internal_timeline_revisions[0], child1 = before.internal_timeline_revisions[0];
    const shot0 = restored.shot_revisions[0], shot1 = before.shot_revisions[0];
    patch = [
      { op: 'set', ref: 'internal-revision:child-0', path: [], before: absent, value: child0.payload },
      { op: 'set', ref: 'shot-revision:shot-0', path: [], before: absent, value: shot0.payload },
      { op: 'set', ref: 'parent', path: ['occurrences', 'occurrence_id:occ', 'shot_revision_id'], before: present('shot-1'), value: 'shot-0' },
      { op: 'remove', ref: 'shot-revision:shot-1', path: [], before: present(shot1.payload) },
      { op: 'remove', ref: 'internal-revision:child-1', path: [], before: present(child1.payload) },
    ];
    dependencies = [
      { kind: 'collection', ref: 'internal-revision:child-1', path: ['clips'], members: ['clip-1', 'clip-new'], order: ['clip-1', 'clip-new'] },
      { kind: 'field', ref: 'parent', path: ['occurrences', 'occurrence_id:occ', 'occurrence_id'], state: present('occ') },
      { kind: 'field', ref: 'parent', path: ['occurrences', 'occurrence_id:occ', 'shot_id'], state: present('shot') },
      { kind: 'collection', ref: 'parent', path: ['occurrences'], members: ['occ'], order: ['occ'] },
      { kind: 'field', ref: 'internal-revision:child-1', path: ['output', 'fps'], state: present(30) },
      { kind: 'collection', ref: 'internal-revision:child-1', path: ['tracks'], members: ['V1'], order: ['V1'] },
      { kind: 'field', ref: 'internal-revision:child-1', path: ['registry', 'assets', 'asset-new'], state: present(asset) },
      { kind: 'field', ref: 'internal-revision:child-1', path: ['clips', 'id:clip-new'], state: present(addedRow) },
    ];
    derived = [];
  }
  const targetChanges = kind === 'params' ? [{ op: 'set', ref: 'parent', path: ['clips', 'id:clip-1', 'params'], before: present({ bob: 3 }), value: { bob: 12 } }]
    : kind === 'element' ? [{ op: 'list.insert', ref: 'parent', path: ['clips'], before: absent, id: 'clip-new',
      order_before: ['clip-1'], after_id: 'clip-1', value: addedRow }] : [];
  const targetCommand = { schema_version: 1, op: kind === 'asset' ? 'clip.add-media' : kind === 'child' ? 'occurrence.add-media' : 'doc.patch', version: '1',
    select: kind === 'asset' ? 'parent' : kind === 'child' ? 'occurrence:occ' : null,
    args: targetChanges.length ? { changes: targetChanges } : { row: addedRow, media: {
      asset: 'asset-new', object_id: asset.media_id, generation_id: asset.generationId, variant_id: asset.variantId, catalog_digest: hash(asset),
    } } };
  const forwardEffects = patch.map((effect) => ({ ref: effect.ref, path: effect.path,
    before: effect.op === 'remove' ? absent : present(effect.value),
    op: effect.before.state === 'absent' ? 'remove' : 'set', ...(effect.before.state === 'absent' ? {} : { value: effect.before.value }) }));
  const targetStep = { id: 'target-step', label: 'Edit timeline', intent: 'Edit timeline', tags: [], command_ordinals: [0],
    patch: targetChanges.length ? targetChanges.map((change) => ({ ...change, path: ['config', ...change.path] }))
      : kind === 'child' ? [...forwardEffects].reverse() : forwardEffects, dependencies: [] };
  const targetData = { accepted_revision_id: 'revision-1', canonical_document: before, document_digest: hash(before) };
  const targetReceipt = { receipt_id: receiptId1, command_kind: 'timeline.commit', idempotency_key: requestId1, request_hash: 'target-hash', project_id: 'project', project_seq: [1, 1], event_ids: ['target-event'], result: targetData, created_at: '2026-10-24T00:00:00Z' };
  const targetEntry = { publication_id: receiptId1, revision_id: 'revision-1', previous: { revision_id: 'revision-0', publication_id: 'publication-0' }, receipt: targetReceipt, intent: 'recorded',
    records: { commands: [{ ordinal: 0, command: targetCommand, reads: sourceReads, writes: sourceWrites, selections: sourceSelections, bindings: [], derived_writes: [], created: [], dependencies: [] }], steps: [targetStep] },
    provider_version: 'astrid-v1', compiler_version: 'authoring-bundle-1', publisher: 'app-actor' };
  const priorHistory = { head: base, next_cursor: null, items: [targetEntry] };
  const guards = {}, authorship = {};
  for (const item of writes) {
    const key = `${item.ref}::${item.path.join('.')}`;
    guards[key] = item.before;
    authorship[key] = 'direct';
  }
  const nativeCommand = { schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: [receiptId1] }, intent: {}, resolved: [], expect: guards, authorship, reads, selections, bindings: commandBindings, created: [] };
  const nativeStep = { ...submitted, patch, dependencies };
  bindings.push({ key: 'inverse.stage', ref: 'parent', policy: 'fixed', dependencies: [], boundary: { publication_id: receiptId1, step_id: 'target-step', command_ordinals: [0], native_write_range: [0, writes.length], effect_range: [0, patch.length] } });
  // Literal effect endpoints are fixture inputs, independent of the actual accepted result/history.
  const endpointImages = (doc) => ({ parent: doc.parent_revision,
    ...Object.fromEntries(doc.shot_revisions.map((image) => [`shot-revision:${image.revision_id}`, image])),
    ...Object.fromEntries(doc.internal_timeline_revisions.map((image) => [`internal-revision:${image.revision_id}`, image])) });
  for (const [index, effect] of patch.entries()) for (const [side, doc] of [['before', before], ['after', restored]]) {
    const image = endpointImages(doc)[effect.ref];
    if (image) bindings.push({ ref: effect.ref, physical_ref: effect.ref, revision_id: image.revision_id, content_digest: image.content_digest,
      boundary: { ...boundary, phase: 'effect', side }, ...(effect.ref === 'parent' ? {} : { owners: ['occurrence:occ/shot'] }), key: 'commit.effect', policy: 'fixed', dependencies: [], path: effect.path, step_id: requestId1, effect_ordinal: index });
  }
  const data = { status: 'accepted', base_revision_id: 'revision-1', base_publication_id: receiptId1, previous_revision_id: 'revision-1', previous_publication_id: receiptId1,
    accepted_revision_id: 'revision-0', rebased_onto: null, canonical_document: restored, document_digest: hash(restored), commands: [nativeCommand], id_map: {}, provider_version: 'astrid-v1', compiler_version: 'authoring-bundle-1', publisher: 'app-actor', label: 'Undo timeline', source: { via: 'app' }, merge_mode: 'fields', steps: [nativeStep] };
  const body = { api_version: 1, project_id: 'project', timeline_id: 'timeline', base_revision_id: 'revision-1', base_publication_id: receiptId1,
    commands: [{ schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: [receiptId1] } }], label: 'Undo timeline', steps: [submitted], merge: 'fields', reads: [], dry_run: false, source: { via: 'app' } };
  const receipt = { receipt_id: receiptId2, command_kind: 'timeline.commit', idempotency_key: requestId2,
    request_hash: hash({ operation: 'commitTimeline', path: '/v1/projects/project/timelines/timeline/commit', publisher: 'app-actor', request: body }).slice(7),
    project_id: 'project', project_seq: [2, 2], event_ids: ['inverse-event'], result: data, created_at: '2026-10-24T00:01:00Z' };
  const entry = { publication_id: receiptId2, revision_id: 'revision-0', previous: base, receipt, intent: 'recorded',
    records: { schema_version: 1, commands: [{ ordinal: 0, command: nativeCommand, writes, reads, selections, bindings, created: [],
      dependencies: pins.map((pin) => ({ key: `compile.document:${hash(pin)}`, kind: pin.document_id.startsWith('transcript:') ? 'transcript' : 'source', pin, policy: 'exact' })),
      derived_writes: derived }], undo_of: [receiptId1], restored_from: null, label: 'Undo timeline', steps: [nativeStep], merge_mode: 'fields', undo_steps: null },
    provider_version: 'astrid-v1', compiler_version: 'authoring-bundle-1', publisher: 'app-actor', source: { via: 'app' }, label: 'Undo timeline', merge: 'fields', merge_mode: 'fields', reads: [], steps: [nativeStep], recorder_abi: 2 };
  const history = { head: { revision_id: 'revision-0', publication_id: receiptId2 }, next_cursor: null, items: [targetEntry, entry] };
  return { post: { request: {}, response: { status: () => 200 }, body, json: structuredClone({ data, receipt }), key: requestId2 },
    context: structuredClone({ before, restored, targetPublication: receiptId1, priorHistory, history, readback: restored }),
    target: { key: requestId1, json: { data: targetData, receipt: targetReceipt } } };
}

for (const kind of ['params', 'element', 'asset', 'child']) test(`actual native oracle accepts independent ${kind} inverse transcript`, () => {
  const { post, context, target } = nativeFixture(kind);
  assert.doesNotThrow(() => helpers.assertAcceptedReply(post, context.priorHistory.head, context));
  assert.doesNotThrow(() => helpers.assertHistoryEntry(context.history, post, post.json, context));
  assert.doesNotThrow(() => helpers.assertUndoHistoryEntry(context.history, post, target, context));
});

function checkNative(fixture) {
  return helpers.assertAcceptedReply(fixture.post, fixture.context.priorHistory.head, fixture.context);
}

// Mutate a producer claim in BOTH the reply and authenticated-history projection so
// cross-echo equality cannot hide a missing source-derived predicate.
function mutateReply(fixture, mutate) {
  mutate(fixture.post.json.data);
  fixture.post.json.receipt.result = structuredClone(fixture.post.json.data);
  const entry = fixture.context.history.items.at(-1);
  entry.receipt = structuredClone(fixture.post.json.receipt);
  entry.steps = structuredClone(fixture.post.json.data.steps);
  entry.records.steps = structuredClone(fixture.post.json.data.steps);
  entry.records.commands[0].command = structuredClone(fixture.post.json.data.commands[0]);
}

for (const [name, mutate] of [
  ['read path', (data) => { data.commands[0].reads[0].path = ['opacity']; }],
  ['read value', (data) => { data.commands[0].reads[0].state.value = { bob: 11 }; }],
  ['read scope', (data) => { data.commands[0].reads[0].ref = 'parent/clip:other'; }],
  ['read DTO kind', (data) => { data.commands[0].reads[0].kind = 'field'; }],
  ['expect path', (data) => { data.commands[0].expect['parent/clip:clip-1::opacity'] = data.commands[0].expect['parent/clip:clip-1::params']; delete data.commands[0].expect['parent/clip:clip-1::params']; }],
  ['expect value', (data) => { data.commands[0].expect['parent/clip:clip-1::params'].value.bob = 11; }],
  ['authorship value', (data) => { data.commands[0].authorship['parent/clip:clip-1::params'] = 'derived'; }],
  ['patch ref', (data) => { data.steps[0].patch[0].ref = 'internal-revision:unrelated'; }],
  ['patch path', (data) => { data.steps[0].patch[0].path = ['config', 'clips', 'id:clip-1', 'opacity']; }],
  ['patch before', (data) => { data.steps[0].patch[0].before.value = 11; }],
  ['patch after', (data) => { data.steps[0].patch[0].value = 4; }],
  ['patch operation', (data) => { data.steps[0].patch[0].op = 'remove'; delete data.steps[0].patch[0].value; }],
  ['step dependency path', (data) => { data.steps[0].dependencies[0].path = ['config', 'unrelated']; }],
  ['step dependency value', (data) => { data.steps[0].dependencies[0].state.value.bob = 11; }],
  ['step dependency scope', (data) => { data.steps[0].dependencies[0].ref = 'internal-revision:unrelated'; }],
  ['canonical document', (data) => { data.canonical_document.parent_revision.payload.clips[0].params.bob = 4; data.document_digest = hash(data.canonical_document); }],
  ['canonical digest', (data) => { data.document_digest = hash({ plausible: 'other' }); }],
  ['id map', (data) => { data.id_map = { unexpected: 'identity' }; }],
  ['provider', (data) => { data.provider_version = 'wrong-provider'; }],
  ['publisher', (data) => { data.publisher = 'other-principal'; }],
]) test(`native source oracle rejects correlated wrong-but-valid ${name}`, () => {
  const fixture = nativeFixture(); mutateReply(fixture, mutate);
  assert.throws(() => checkNative(fixture));
});

for (const [name, mutate] of [
  ['write path', (record) => { record.writes[0].path = ['opacity']; }],
  ['write ref', (record) => { record.writes[0].ref = 'parent/clip:other'; }],
  ['write before', (record) => { record.writes[0].before.value.bob = 11; }],
  ['write after', (record) => { record.writes[0].after.value.bob = 4; }],
  ['read path', (record) => { record.reads[0].path = ['opacity']; }],
  ['dependency', (record) => { record.dependencies = [{ key: 'media.new', kind: 'media', pin: asset, policy: 'exact' }]; }],
  ['derived path', (record) => { record.derived_writes[0].path = ['clips']; }],
  ['derived value', (record) => { record.derived_writes[0].after.value = []; }],
  ['binding revision', (record) => { record.bindings[1].revision_id = 'revision-other'; }],
  ['binding digest', (record) => { record.bindings[1].content_digest = hash({ other: true }); }],
  ['binding boundary', (record) => { record.bindings[1].boundary.evaluated_head.publication_id = receiptId2; }],
  ['binding physical ref', (record) => { record.bindings[1].physical_ref = 'shot-revision:other'; }],
  ['binding effect ordinal', (record) => { record.bindings[1].effect_ordinal = 1; }],
  ['inverse target', (record) => { record.bindings[0].boundary.publication_id = receiptId2; }],
  ['inverse target step', (record) => { record.bindings[0].boundary.step_id = requestId1; }],
  ['inverse range', (record) => { record.bindings[0].boundary.native_write_range = [0, 2]; }],
]) test(`native source oracle rejects recorded ${name}`, () => {
  const fixture = nativeFixture(); mutate(fixture.context.history.items.at(-1).records.commands[0]);
  assert.throws(() => checkNative(fixture));
});

for (const kind of ['asset', 'child']) for (const field of ['key', 'owner', 'members', 'order', 'boundaries', 'policy']) test(`native ${kind} source oracle rejects correlated selection ${field}`, () => {
  const fixture = nativeFixture(kind);
  mutateReply(fixture, (data) => { data.commands[0].selections[0][field] = ['members', 'order', 'boundaries'].includes(field) ? [] : `wrong-${field}`; });
  assert.throws(() => checkNative(fixture));
});

for (const [name, mutate] of [
  ['command binding', (fixture) => { mutateReply(fixture, (data) => { data.commands[0].bindings['collection.owner:collection.clips'] = 'occurrence:wrong'; }); }],
  ['owner binding path', (fixture) => { fixture.context.history.items.at(-1).records.commands[0].bindings[0].path = ['occurrences', 'occurrence_id:other']; }],
  ['effect owner', (fixture) => { fixture.context.history.items.at(-1).records.commands[0].bindings[3].owners = ['occurrence:other/shot']; }],
  ['readback document', (fixture) => { fixture.context.readback.parent_revision.payload.occurrences[0].duration_ms = 21000; }],
  ['readback digest', (fixture) => { fixture.context.readback.internal_timeline_revisions[0].content_digest = hash({ other: true }); }],
]) test(`native child source oracle rejects ${name}`, () => {
  const fixture = nativeFixture('child'); mutate(fixture); assert.throws(() => checkNative(fixture));
});

for (const field of ['reads', 'selections', 'expect', 'authorship', 'bindings', 'resolved', 'created']) for (const mutation of ['missing', 'extra', 'empty']) test(`native command metadata ${field}: ${mutation}`, () => {
  const fixture = nativeFixture('child');
  mutateReply(fixture, (data) => {
    const value = data.commands[0][field];
    if (mutation === 'missing') delete data.commands[0][field];
    else if (mutation === 'empty') data.commands[0][field] = Array.isArray(value) ? [] : {};
    else if (Array.isArray(value)) value.push(field === 'reads' ? read('parent', ['config', 'output', 'fps'], present(30)) : 'unexpected');
    else value.extra = 'unexpected';
  });
  // Empty resolved/created are prescribed by source; retaining them must pass.
  if (mutation === 'empty' && ['resolved', 'created'].includes(field)) assert.doesNotThrow(() => checkNative(fixture));
  else assert.throws(() => checkNative(fixture));
});

for (const field of ['patch', 'dependencies']) for (const mutation of ['missing', 'empty', 'extra']) test(`native step metadata ${field}: ${mutation}`, () => {
  const fixture = nativeFixture();
  mutateReply(fixture, (data) => {
    if (mutation === 'missing') delete data.steps[0][field];
    else if (mutation === 'empty') data.steps[0][field] = [];
    else data.steps[0][field].push(structuredClone(data.steps[0][field][0]));
  });
  assert.throws(() => checkNative(fixture));
});

for (const [name, mutate] of [
  ['missing canonical input', (fixture) => { delete fixture.context.restored; }],
  ['missing history input', (fixture) => { fixture.context.priorHistory.items = []; }],
  ['target idempotency identity', (fixture) => { fixture.context.targetPublication = requestId1; }],
  ['wrong undo publication', (fixture) => { fixture.context.history.head.publication_id = requestId2; }],
  ['wrong undo_of', (fixture) => { fixture.context.history.items.at(-1).records.undo_of = [requestId1]; }],
  ['whole undo steps', (fixture) => { fixture.context.history.items.at(-1).records.undo_steps = []; }],
  ['changed prior history', (fixture) => { fixture.context.history.items[0].publisher = 'forged'; }],
  ['request hash', (fixture) => { fixture.post.json.receipt.request_hash = 'a'.repeat(64); fixture.context.history.items.at(-1).receipt.request_hash = 'a'.repeat(64); }],
  ['extra result field', (fixture) => { mutateReply(fixture, (data) => { data.extra = true; }); }],
  ['extra record field', (fixture) => { fixture.context.history.items.at(-1).records.commands[0].extra = true; }],
]) test(`native whole-path oracle rejects ${name}`, () => {
  const fixture = nativeFixture(); mutate(fixture); assert.throws(() => checkNative(fixture));
});

for (const field of ['writes', 'reads', 'selections', 'bindings', 'created', 'dependencies', 'derived_writes']) for (const mutation of ['missing', 'extra', 'empty']) test(`native recorder metadata ${field}: ${mutation}`, () => {
  const fixture = nativeFixture(field === 'selections' || field === 'bindings' ? 'child' : 'params');
  const record = fixture.context.history.items.at(-1).records.commands[0];
  if (mutation === 'missing') delete record[field];
  else if (mutation === 'empty') record[field] = [];
  else record[field].push(record[field].length ? structuredClone(record[field][0]) : 'unexpected');
  if (mutation === 'empty' && field === 'created') assert.doesNotThrow(() => checkNative(fixture));
  else assert.throws(() => checkNative(fixture));
});

test('native request keeps the target separate from the later landing publication', () => {
  const { post } = nativeFixture('element');
  post.body.base_publication_id = 'txn-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.doesNotThrow(() => checkRequest(post, { revision_id: 'revision-1', publication_id: post.body.base_publication_id }, { project_id: 'project', timeline_id: 'timeline' }, receiptId1));
  assert.throws(() => checkRequest(post, { revision_id: 'revision-1', publication_id: post.body.base_publication_id }, { project_id: 'project', timeline_id: 'timeline' }, post.body.base_publication_id));
});

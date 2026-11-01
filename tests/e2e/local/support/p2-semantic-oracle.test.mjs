import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { assertSemanticAddMediaRequest, expectedImageDropRow } from './p2-semantic-oracle.ts';
import { producePreparedImageRequest } from '../../../../src/tools/video-editor/commands/fixtures/preparedImageRequestProducer.ts';
import { buildPlacePreparedMediaCommand } from '../../../../src/tools/video-editor/hooks/useAssetManagement.ts';
import { previewPreparedMediaCommand } from '../../../../src/tools/video-editor/commands/media.ts';
import { buildTimelineData } from '../../../../src/tools/video-editor/lib/timeline-data.ts';
import { sanitizeTimelineClipSnapshot } from '../../../../src/tools/video-editor/lib/timeline-domain.ts';
import { createShotTimelineDataProvider } from '../../../../src/tools/travel-between-images/components/shotTimelineDataProvider.ts';
import { createShotCompositionAdapter } from '../../../../src/tools/video-editor/data/shotCompositionAdapter.ts';
import { projectCanonicalComposition } from '../../../../src/tools/video-editor/data/shotCompositionProjection.ts';
import { createFakeIndexedDB } from '../../../../vendor/fake-indexeddb/index.js';
import { ApiError } from '../../../../src/integrations/runtime/generated.ts';
import fixture from '../../../../src/tools/video-editor/data/shotComposition.fixture.json';

const before = {
  schema_version: 1,
  project_id: 'project',
  timeline_id: 'timeline',
  parent_revision: { revision_id: 'r0', content_digest: 'sha256:parent', payload: {
    config: { output: { fps: 30, resolution: '1920x1080' }, tracks: [{ id: 'V1', kind: 'visual' }], clips: [], registry: { assets: {} } },
    tracks: [{ id: 'V1', kind: 'visual' }], clips: [],
    registry: { assets: {} },
    occurrences: [],
  } },
  shot_revisions: [],
  internal_timeline_revisions: [],
  dependency_manifest: { shots: [], internal_timelines: [], media: [], documents: [] },
};

const base = { revision_id: 'r0', publication_id: 'p0' };
const row = { id: 'clip-0', asset: 'asset-new', track: 'V1', at: 5, hold: 5, clipType: 'hold', opacity: 1 };
const media = {
  asset: 'asset-new', generation_id: 'generation-new', variant_id: 'variant-new',
  object_id: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  catalog_digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
};

function post(overrides = {}) {
  const body = {
    api_version: 1,
    project_id: 'project',
    timeline_id: 'timeline',
    base_revision_id: 'r0',
    base_publication_id: 'p0',
    commands: [{ schema_version: 1, op: 'clip.add-media', version: '1', select: 'parent', args: { row: structuredClone(row), media: structuredClone(media) }, intent: {}, created: ['parent/asset:asset-new', 'parent/clip:clip-0'] }],
    label: 'Add media',
    steps: [{ id: 'place-media', label: 'Add media', intent: 'Add media', tags: [], command_ordinals: [0], patch: [] }],
    merge: 'fields',
    dry_run: false,
    source: { via: 'app' },
    ...overrides,
  };
  return { key: 'edit-1', body };
}

function accepts(value) {
  assert.doesNotThrow(() => assertSemanticAddMediaRequest(value, base, before, {
    op: 'clip.add-media', owner: 'parent', select: 'parent', label: 'Add media', row, media,
  }));
}

test('semantic media oracle accepts the exact source shape and refuses the old shape', () => {
  accepts(post());
  assert.throws(() => assertSemanticAddMediaRequest(post({ merge: 'atomic' }), base, before, {
    op: 'clip.add-media', owner: 'parent', select: 'parent', label: 'Add media', row, media,
  }));
  assert.throws(() => assertSemanticAddMediaRequest(post({ steps: [{ id: 'place-media', label: 'Place media', intent: 'Place media', tags: [], command_ordinals: [0], patch: [{}] }] }), base, before, {
    op: 'clip.add-media', owner: 'parent', select: 'parent', label: 'Add media', row, media,
  }));
});

function refusesDrift(value, authored, expected) {
  assertSemanticAddMediaRequest(value, base, authored, expected);
  const mutations = {
    opacity: (body) => { body.commands[0].args.row.opacity = 0.5; },
    'missing opacity': (body) => { delete body.commands[0].args.row.opacity; },
    'null opacity': (body) => { body.commands[0].args.row.opacity = null; },
    'extra row field': (body) => { body.commands[0].args.row.unsupported = true; },
    'extra null field': (body) => { body.commands[0].args.row.from = null; },
    'wrong row id': (body) => { body.commands[0].args.row.id = 'forged'; },
    'wrong row asset': (body) => { body.commands[0].args.row.asset = 'forged'; },
    'wrong track': (body) => { body.commands[0].args.row.track = 'forged'; },
    'wrong timing': (body) => { body.commands[0].args.row.at += 1; },
    'wrong hold': (body) => { body.commands[0].args.row.hold += 1; },
    'wrong clip type': (body) => { body.commands[0].args.row.clipType = 'media'; },
    'missing claim': (body) => { body.commands[0].created.shift(); },
    'extra claim': (body) => { body.commands[0].created.push(`${expected.owner}/clip:extra`); },
    'wrong claim': (body) => { body.commands[0].created[0] = `${expected.owner}/asset:forged`; },
    'reordered claims': (body) => { body.commands[0].created.reverse(); },
    'request reads': (body) => { body.reads = []; },
    'command reads': (body) => { body.commands[0].reads = []; },
    'command resolved': (body) => { body.commands[0].resolved = {}; },
    'command rationale': (body) => { body.commands[0].rationale = 'extra'; },
    'step reads': (body) => { body.steps[0].reads = []; },
    merge: (body) => { body.merge = 'atomic'; },
    patch: (body) => { body.steps[0].patch = [{}]; },
    select: (body) => { body.commands[0].select = 'parent/clip:forged'; },
    args: (body) => { body.commands[0].args.extra = true; },
    'missing args': (body) => { delete body.commands[0].args.media; },
    'wrong media': (body) => { body.commands[0].args.media.catalog_digest = `sha256:${'f'.repeat(64)}`; },
    'extra media': (body) => { body.commands[0].args.media.extra = true; },
    intent: (body) => { body.commands[0].intent = { ownership: 'shared' }; },
    'intent extra': (body) => { body.commands[0].intent.extra = true; },
    'command extra': (body) => { body.commands[0].metadata = {}; },
    'extra command': (body) => { body.commands.push(structuredClone(body.commands[0])); },
    'missing command': (body) => { body.commands = []; },
    'extra step': (body) => { body.steps.push(structuredClone(body.steps[0])); },
    'missing step': (body) => { body.steps = []; },
    'step extra': (body) => { body.steps[0].metadata = {}; },
    'step label': (body) => { body.steps[0].label = 'wrong'; },
    'step intent': (body) => { body.steps[0].intent = 'wrong'; },
    'step tags': (body) => { body.steps[0].tags = ['extra']; },
    ordinals: (body) => { body.steps[0].command_ordinals = [1]; },
    label: (body) => { body.label = 'wrong'; },
    'top metadata': (body) => { body.metadata = {}; },
    rationale: (body) => { body.rationale = 'extra'; },
    group: (body) => { body.group_id = 'extra'; },
    source: (body) => { body.source.via = 'agent'; },
    'source extra': (body) => { body.source.extra = true; },
    head: (body) => { body.base_revision_id = 'stale'; },
    publication: (body) => { body.base_publication_id = 'stale'; },
    project: (body) => { body.project_id = 'foreign'; },
    timeline: (body) => { body.timeline_id = 'foreign'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const changed = structuredClone(value);
    mutate(changed.body);
    assert.throws(() => assertSemanticAddMediaRequest(changed, base, authored, expected), name);
  }
}

const prepared = {
  assetKey: media.asset, mediaType: 'image', durationSeconds: null, source: 'registered',
  entry: { file: 'image.png', type: 'image/png', generationId: media.generation_id, variantId: media.variant_id },
  mediaSelection: media,
};

test.each([['contain', false], ['manual', false], ['contain', true]])('genuine prepared parent producer satisfies the helper with %s geometry, snapping=%s', async (fit, snapping) => {
  const authored = structuredClone(before);
  authored.parent_revision.payload.config.tracks[0].fit = fit;
  authored.parent_revision.payload.tracks[0].fit = fit;
  authored.parent_revision.payload.opaque = { keep: [null, false] };
  if (snapping) {
    const clips = [{ id: 'first', track: 'V1', at: 3, hold: 3 }, { id: 'second', track: 'V1', at: 6, hold: 3 }];
    authored.parent_revision.payload.clips = structuredClone(clips);
    authored.parent_revision.payload.config.clips = structuredClone(clips);
  }
  const original = JSON.stringify(authored);
  const expectedRow = { ...row, at: snapping ? 9 : 5, ...(fit === 'manual' ? { x: 100, y: 100, width: 320, height: 240 } : {}) };
  assert.deepEqual(await expectedImageDropRow(authored, 'parent', media.asset, 'V1', 5), expectedRow);
  const produced = await producePreparedImageRequest({
    projectId: 'project', timelineId: 'timeline', head: { revisionId: 'r0', publicationId: 'p0' },
    canonicalDocument: authored, preparedAsset: structuredClone(prepared), placement: { trackId: 'V1', at: 5 },
  });
  const value = { key: produced.idempotency_key, body: JSON.parse(JSON.stringify(produced.request)) };
  refusesDrift(value, authored, {
    op: 'clip.add-media', owner: 'parent', select: 'parent', label: 'Add media', row: expectedRow, media,
  });
  assert.equal(JSON.stringify(authored), original);
});

test('genuine embedded image-drop producer satisfies the occurrence helper', async () => {
  const graph = structuredClone(fixture);
  graph.primary_timeline.head.revision_id = 'r0';
  graph.occurrences.find((occurrence) => occurrence.occurrence_id === 'occ-3').at_ms = 0;
  const rawShot = graph.shot_revisions.find((shot) => shot.shot_id === 'shot-alpha' && shot.revision_id === 'rev-b');
  const internal = rawShot.internal_timeline_revision;
  internal.timeline.clips = [{ id: 'existing', track: 'video', at: 0, hold: 2, clipType: 'media', asset: 'alpha-image', app: { opaque: null } }];
  internal.timeline.registry = { assets: { 'alpha-image': { file: 'existing.png', type: 'image/png' } } };
  internal.timeline.app = { opaque: { keep: [null, false] } };
  const authored = structuredClone(before);
  authored.project_id = graph.project.project_id;
  authored.timeline_id = graph.primary_timeline.document_id;
  authored.parent_revision.payload.occurrences = [{ occurrence_id: 'occ-3', shot_id: rawShot.shot_id, shot_revision_id: rawShot.revision_id }];
  authored.shot_revisions = [{ shot_id: rawShot.shot_id, revision_id: rawShot.revision_id,
    internal_timeline_revision_id: internal.revision_id, content_digest: rawShot.content_digest,
    payload: { internal_timeline_revision_id: internal.revision_id } }];
  authored.internal_timeline_revisions = [{ timeline_id: 'timeline-alpha', revision_id: internal.revision_id,
    content_digest: internal.content_digest, payload: structuredClone(internal.timeline) }];
  authored.dependency_manifest.shots = authored.shot_revisions.map(({ payload: _payload, ...pin }) => pin);
  authored.dependency_manifest.internal_timelines = authored.internal_timeline_revisions.map(({ payload: _payload, ...pin }) => pin);
  // The real embedded provider keeps raw absent/null/opaque values in this basis.
  const original = JSON.stringify(authored);
  const adapter = createShotCompositionAdapter({ load: vi.fn(), publish: vi.fn() });
  const composition = adapter.prepare(graph);
  const occurrence = composition.occurrences.find((candidate) => candidate.occurrenceId === 'occ-3');
  const projected = projectCanonicalComposition({ ...composition, occurrences: [occurrence] }).config;
  const config = { ...projected, clips: projected.clips.map(sanitizeTimelineClipSnapshot) };
  const factory = createFakeIndexedDB();
  vi.stubGlobal('indexedDB', factory);
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name, _options, work) => work({}),
  } });
  let value;
  const provider = createShotTimelineDataProvider(config, composition, 'occ-3', adapter, vi.fn(), undefined, 0, undefined, {
    loadTimelineCommandBasis: async () => ({ head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: authored, graph }),
    getRecoverableIdentity: async () => ({ realmId: 'p2', actorId: 'p2', projectId: authored.project_id, timelineId: authored.timeline_id }),
    getProjectMediaSelection: async () => structuredClone(media),
    commitTimeline: async (body, key) => {
      value = { body: JSON.parse(JSON.stringify(body)), key };
      throw new ApiError(422, 'fixture_capture_stop', 'stop before Runtime acceptance');
    },
  });
  try {
    const current = await buildTimelineData(config, await provider.loadAssetRegistry('popup-timeline'));
    const command = buildPlacePreparedMediaCommand({
      prepared: structuredClone(prepared), trackId: config.tracks.find((track) => track.kind === 'visual').id,
      time: 5, forceNewTrack: false, insertAtTop: false,
    });
    const preview = previewPreparedMediaCommand(current, command);
    assert.ok(preview);
    await provider.localDocumentSave.capture({
      head: { projectId: composition.projectId, timelineId: composition.parentDocumentId, headRevisionId: 'r0', headPublicationId: 'p0' },
      config: preview.nextData.config, registry: preview.nextData.registry,
    });
    await assert.rejects(provider.localDocumentSave.flush());
    assert.ok(value, 'the real save path reached its send boundary');
    const expectedRow = { ...row, track: 'video' };
    assert.deepEqual(await expectedImageDropRow(authored, 'occurrence:occ-3', media.asset, 'video', 5), expectedRow);
    refusesDrift(value, authored, {
      op: 'occurrence.add-media', owner: 'occurrence:occ-3', select: 'occurrence:occ-3', label: 'Edit shot timeline', row: expectedRow, media,
    });
    assert.equal(JSON.stringify(authored), original);
  } finally {
    await provider.dispose();
    vi.unstubAllGlobals();
  }
});

test('semantic media oracle refuses command, created, read, and submitted-patch drift', () => {
  const expected = { op: 'clip.add-media', owner: 'parent', select: 'parent', label: 'Add media', row, media };
  for (const mutate of [
    (value) => { value.body.commands = []; },
    (value) => { value.body.commands.push(structuredClone(value.body.commands[0])); },
    (value) => { value.body.commands[0].op = 'doc.patch'; },
    (value) => { value.body.commands[0].created = ['parent/clip:clip-0']; },
    (value) => { value.body.commands[0].created = ['parent/asset:asset-new', 'parent/clip:clip-0', 'parent/clip:extra']; },
    (value) => { delete value.body.commands[0].created; },
    (value) => { value.body.reads = []; },
    (value) => { value.body.unexpected = 'metadata'; },
    (value) => { value.body.commands[0].reads = []; },
    (value) => { value.body.commands[0].resolved = { extra: true }; },
    (value) => { value.body.commands[0].rationale = 123; },
    (value) => { value.body.commands[0].args.row.extra = true; },
    (value) => { value.body.commands[0].args.media.extra = true; },
    (value) => { value.body.label = 'Place media'; },
    (value) => { value.body.steps[0].reads = []; },
    (value) => { delete value.body.steps[0].patch; },
    (value) => { value.body.steps[0].patch = [{}]; },
  ]) {
    const value = post();
    mutate(value);
    assert.throws(() => assertSemanticAddMediaRequest(value, base, before, expected));
  }
});

test('semantic media oracle derives asset birth from the pregesture registry', () => {
  const authored = structuredClone(before);
  authored.parent_revision.payload.config.registry.assets['asset-new'] = { media_id: 'existing' };
  const value = post();
  value.body.commands[0].created = ['parent/clip:clip-0'];
  assert.doesNotThrow(() => assertSemanticAddMediaRequest(value, base, authored, {
    op: 'clip.add-media', owner: 'parent', select: 'parent', label: 'Add media', row, media,
  }));
  value.body.commands[0].created = ['parent/asset:asset-new', 'parent/clip:clip-0'];
  assert.throws(() => assertSemanticAddMediaRequest(value, base, authored, {
    op: 'clip.add-media', owner: 'parent', select: 'parent', label: 'Add media', row, media,
  }));
});

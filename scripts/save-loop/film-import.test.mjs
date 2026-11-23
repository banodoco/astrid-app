import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {filmShape} from './film-shape.mjs';
import {canonicalJson, prepareFilmImport, revisionDigest} from './film-import.mjs';

const pins = ['a', 'b', 'c'].map((name, n) => ({asset: name, generation_id: `generation-${name}`,
  variant_id: `variant-${name}`, object_id: `sha256:${String(n + 1).repeat(64)}`}));

test('prepared import carries clip and media closures and a historical overrun', () => {
  const shape = filmShape();
  const {publication} = prepareFilmImport({projectId: 'project', timelineId: 'film', shape, selections: pins});
  const {parent_composition: parent, internal_timeline_revisions: internal, shot_revisions: shots, dependency_manifest: manifest} = publication;
  assert.equal(internal.flatMap(r => r.payload.clips).length + parent.clips.length, 621);
  assert.equal(parent.occurrences.length, shape.shots.length);
  assert.equal(shots.length, internal.length);
  assert.deepEqual(new Set(manifest.media.map(m => m.media_id)), new Set(pins.map(p => p.object_id)));
  for (const [n, overlay] of shape.overlays.entries()) {
    const source = internal[overlay.shotIndex].payload.clips[overlay.childIndex];
    assert.equal(parent.clips[n].at, shape.shots[overlay.shotIndex].on + source.at);
    assert.equal(parent.clips[n].hold, source.hold);
    assert.deepEqual(parent.clips[n].entrance, {type: 'fade', duration: 0.2, params: {easing: n ? 'in' : 'out'}});
  }
  const last = parent.occurrences.at(-1);
  assert.ok(internal.at(-1).payload.clips.some(c => (c.at + c.hold) * 1000 > last.duration_ms));
  assert.equal(publication.content_digest, revisionDigest(parent));
  for (const r of [...internal, ...shots]) assert.equal(r.content_digest, revisionDigest(r.payload));
});

test('canonical fixture JSON matches Python Runtime encoding after transport', () => {
  const request = prepareFilmImport({projectId: 'project', timelineId: 'film', shape: filmShape(), selections: pins});
  const python = spawnSync('python3', ['-c', "import json,sys; x=json.load(sys.stdin); print(json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False),end='')"],
    {input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024});
  assert.equal(python.status, 0, python.stderr);
  assert.equal(canonicalJson(request), python.stdout);
});

test('rejects malformed selection and unsafe JSON number', () => {
  assert.throws(() => prepareFilmImport({projectId: 'p', timelineId: 't', shape: filmShape(), selections: [{}]}));
  assert.throws(() => canonicalJson(0.00001));
});

test('registry retains measured image, video and audio metadata', () => {
  const video = {...pins[0], metadata: {width: 1280, height: 720, duration_seconds: 90}};
  const image = {...pins[1], metadata: {width: 640, height: 360}};
  const audio = {...pins[2], metadata: {duration_seconds: 90}};
  const narration = {selection: audio, image, words: ['a', 'b', 'c', 'd'].map((text, i) => ({text, at: i / 10}))};
  const request = prepareFilmImport({projectId: 'p', timelineId: 't', shape: filmShape(), selections: [video], narration});
  const assets = request.publication.internal_timeline_revisions[0].payload.registry.assets;
  assert.deepEqual(assets[image.asset], {media_id: image.object_id, type: 'image', generationId: image.generation_id,
    variantId: image.variant_id, resolution: '640x360'});
  assert.deepEqual(assets[video.asset], {media_id: video.object_id, type: 'video', generationId: video.generation_id,
    variantId: video.variant_id, resolution: '1280x720', duration: 90});
  assert.deepEqual(assets[audio.asset], {media_id: audio.object_id, type: 'audio', generationId: audio.generation_id,
    variantId: audio.variant_id, duration: 90});
  for (const metadata of [{width: 1280}, {width: 0, height: 720}, {duration_seconds: 0}, {duration_seconds: Infinity}])
    assert.throws(() => prepareFilmImport({projectId: 'p', timelineId: 't', shape: filmShape(),
      selections: [{...video, metadata}]}), /invalid media/);
});

test('footage structure can be composed into an import at a nonzero shot offset', async () => {
  const {prepareFilmFootage} = await import('./film-import.mjs');
  const shape = filmShape();
  const shot = shape.shots[1];
  const child = shot.children[0];
  shape.overlays = [{shotIndex: shot.index, childIndex: child.index, hold: child.hold}];
  const parts = prepareFilmFootage({timelineId: 'film', shape, selections: pins});
  const {publication} = prepareFilmImport({projectId: 'project', timelineId: 'film', shape, selections: pins});
  const original = parts.internal[1].payload.clips[0];
  assert.ok(shot.on > 0);
  assert.equal(parts.clips[0].at, shot.on + original.at);
  assert.equal(parts.clips[0].hold, original.hold);
  assert.deepEqual(publication.internal_timeline_revisions, parts.internal);
  assert.deepEqual(publication.parent_composition.clips[0], parts.clips[0]);
  assert.deepEqual(publication.parent_composition.registry.assets, parts.parentAssets);
  assert.deepEqual(publication.dependency_manifest.media.map(row => row.media_id), [...parts.used].sort());
});


test('film output profiles use configured dimensions on parent and every shot', () => {
  const request = prepareFilmImport({projectId: 'p', timelineId: 't', shape: filmShape(), selections: pins,
    mediaSize: {width: 640, height: 360}});
  const expected = {resolution: '640x360', fps: 30, file: 'output.mp4'};
  assert.deepEqual(request.publication.parent_composition.config.output, expected);
  for (const shot of request.publication.internal_timeline_revisions)
    assert.deepEqual(shot.payload.output, expected);
  assert.throws(() => prepareFilmImport({projectId: 'p', timelineId: 't', shape: filmShape(), selections: pins,
    mediaSize: {width: 641, height: 360}}), /invalid film output dimensions/);
});

test('film swap overlays use different media of the same kind as their originals', () => {
  const video1 = {...pins[0], metadata: {width: 640, height: 360, duration_seconds: 90}};
  const video2 = {...video1, asset: 'video-2', object_id: `sha256:${'2'.repeat(64)}`, generation_id: 'vg2', variant_id: 'vv2'};
  const image1 = {...pins[0], metadata: {width: 640, height: 360}, asset: 'image-1', object_id: `sha256:${'3'.repeat(64)}`, generation_id: 'ig1', variant_id: 'iv1'};
  const image2 = {...image1, asset: 'image-2', object_id: `sha256:${'4'.repeat(64)}`, generation_id: 'ig2', variant_id: 'iv2'};
  const audio = {...pins[0], asset: 'audio', object_id: `sha256:${'5'.repeat(64)}`, generation_id: 'ag', variant_id: 'av'};
  const narration = {selection: audio, image: image1, overlayImage: image2,
    words: [{text:'a',at:0.1},{text:'b',at:1.1},{text:'c',at:0.01},{text:'c',at:0.05}]};
  const request = prepareFilmImport({projectId:'p', timelineId:'t', shape:filmShape(), selections:[video1, video2], narration});
  const parent = request.publication.parent_composition;
  const shot = request.publication.internal_timeline_revisions[0].payload;
  for (let i = 0; i < 2; i++) {
    const original = shot.clips.find(c => c.id === `footage-0-${i}`);
    const overlay = parent.clips.find(c => c.id === `overlay-${i}`);
    const a = shot.registry.assets[original.asset], b = parent.registry.assets[overlay.asset];
    assert.equal(a.type, i ? 'video' : 'image');
    assert.equal(b.type, a.type);
    assert.notEqual(b.media_id, a.media_id);
    assert.equal(a.resolution, '640x360');
    assert.equal(b.resolution, '640x360');
    if (i) { assert.equal(a.duration, 90); assert.equal(b.duration, 90); }
  }
});

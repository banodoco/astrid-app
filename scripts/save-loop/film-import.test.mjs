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

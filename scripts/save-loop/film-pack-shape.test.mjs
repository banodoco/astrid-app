import test from 'node:test';
import assert from 'node:assert/strict';
import {filmShape} from './film-shape.mjs';
import {prepareFilmImport, revisionDigest} from './film-import.mjs';

test('film pack import pins the collection and covers animations without adding clips', () => {
  const shape = filmShape({clipCount: 619});
  const collectionElement = {packId: 'astrid_motion', id: 'am-type', kind: 'effect', revision: 'real-descriptor-revision'};
  const pin = {asset: 'asset', generation_id: 'generation', variant_id: 'variant', object_id: `sha256:${'a'.repeat(64)}`};
  const result = prepareFilmImport({projectId: 'project', timelineId: 'film', shape, selections: [pin], collectionElement});
  const pub = result.publication;
  const collection = pub.parent_composition.clips.find(row => row.id === 'element-collection-pack');
  assert.deepEqual(collection.elementRef, collectionElement);
  assert.deepEqual(collection.params, {text: 'Generated fixture'});
  const children = pub.internal_timeline_revisions.flatMap(row => row.payload.clips);
  assert.equal(children.length + pub.parent_composition.clips.length, 619);
  assert.deepEqual(children.filter(row => row.entrance || row.exit).map(row => (row.entrance || row.exit).type),
    ['fade', 'fade-up', 'scale-in', 'slide-left', 'slide-up', 'type-on', 'fade', 'fade', 'fade', 'fade']);
  assert.deepEqual(children.filter(row => row.entrance?.params).map(row => row.entrance.params.easing), ['in', 'out', 'in-out', 'step']);
  for (const row of pub.internal_timeline_revisions) assert.equal(row.content_digest, revisionDigest(row.payload));
});

test('project placement uses admitted descriptor and the exact accepted head', async () => {
  const {spawnSync} = await import('node:child_process');
  const {fileURLToPath} = await import('node:url');
  const python = String.raw`
import importlib.util, sys, types
spec = importlib.util.spec_from_file_location('film_packs', sys.argv[1])
film = importlib.util.module_from_spec(spec); spec.loader.exec_module(film)
ref = dict(packId='project_test', id='fixture_project', kind='effect', revision='sha256:actual')
packs = types.SimpleNamespace(init_project_pack=lambda *a, **k: {}, admit_project_pack=lambda *a, **k: dict(elements=[dict(descriptor=ref)], documentId='doc', documentVersion=3))
for name in ('astrid', 'astrid.core', 'astrid.core.element'):
    sys.modules[name] = types.ModuleType(name)
sys.modules['astrid.core.element'].project_packs = packs
film._write_effect = lambda *a: None
calls = []
def place(*args, **kwargs):
    calls.append((args, kwargs)); return types.SimpleNamespace(ok=True, data={'new_head': 'head-2'})
client = types.SimpleNamespace(timelines=types.SimpleNamespace(place_element=place))
head, result = film.place_project(client, 'realm', 'project', 'timeline', 'head-1')
assert head == 'head-2' and result['element'] == ref
assert calls[0][0] == ('project', 'timeline')
assert calls[0][1]['target'] == 'parent/clip:element-project-pack'
assert calls[0][1]['expected_head'] == 'head-1' and calls[0][1]['element'] == ref
`;
  const result = spawnSync('python3', ['-c', python, fileURLToPath(new URL('./film_packs.py', import.meta.url))], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
});

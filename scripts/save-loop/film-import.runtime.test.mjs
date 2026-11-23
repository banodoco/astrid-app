import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {filmShape} from './film-shape.mjs';

// Opt in only with a Python that already has the pinned Runtime installed.
// This exercises import acceptance in a disposable embedded realm, not render.
test('Runtime accepts the prepared historical closure', {skip: !process.env.SAVE_LOOP_TEST_PYTHON}, () => {
  const sources = ['generated-fixture-a', 'generated-fixture-b', 'generated-fixture-c'];
  const pins = sources.map((source, i) => ({asset: `asset-${i}`, generation_id: `generation-${i}`,
    variant_id: `variant-${i}`, object_id: `sha256:${createHash('sha256').update(source).digest('hex')}`}));
  const python = String.raw`
import json, sys, tempfile, subprocess
from runtime_protocol.service import RuntimeService
from runtime_protocol.store import RealmStore
from astrid.core.timeline.authoring_bundle import _digest
from astrid.sdk.media_transcript import build_transcript, transcript_document_id
from astrid.sdk.timeline.commit import bundle_from_document
from astrid.sdk.timeline.native_word_anchor import capture_anchor
from astrid.core.timeline.clip_fields import coerce
from astrid.sdk.timeline import commit
from runtime_protocol.timeline_commit_port import route_path
request = json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='save-loop-import-') as root:
    RealmStore.initialize(root).close()
    service = RuntimeService(root)
    service.register_timeline_commit_provider(commit.create_runtime_commit_service())
    project = service.create_project({'slug': 'fixture', 'name': 'Fixture'}, idempotency_key='project')['id']
    for i, source in enumerate(request['sources']):
        result = service.ingest(project, source.encode(), media_type='video/mp4', original_name=f'{i}.mp4', idempotency_key=f'media-{i}')
        assert result['data']['object_id'] == request['pins'][i]['object_id']
    content = build_transcript(request['pins'][0]['object_id'], 'film-line', 'fixture', [[0.1, 0.2, 'fixture']])
    doc_id = transcript_document_id(project, content['media_id'], content['source_id'])
    # Dynamic import keeps the same JS builder path used by the fixture.
    build = '''const {prepareFilmImport} = await import(process.argv[1]); let s=''; for await (const x of process.stdin) s+=x; console.log(JSON.stringify(prepareFilmImport(JSON.parse(s))));'''
    spec = {'projectId': project, 'timelineId': 'film-test', 'shape': request['shape'], 'selections': request['pins'],
            'legacyWord': {'documentId': doc_id, 'text': 'fixture', 'at': 0.1, 'content': content}}
    prepared = json.loads(subprocess.run([request['node'], '--input-type=module', '-e', build, request['module']],
                                         input=json.dumps(spec), text=True, capture_output=True, check=True).stdout)
    result = service.import_timeline(project, prepared, idempotency_key='import')
    document = service.get_document(project, doc_id)
    pin = {'document_id': doc_id, 'version': document['version'], 'content_digest': _digest(content)}
    assert result['data']['timeline_id'] == 'film-test'
    head = service.get_project_timeline(project, 'film-test')
    assert head['head_revision_id'] == prepared['publication']['parent_revision_id']
    # Capture a real generated transcript pin against one shot source and a
    # parent target. This checks capture only; the caller must still commit it.
    commits, _ = service._timeline_commits()
    closure = commits.revision_closure(project, 'film-test', head['head_revision_id'])
    bundle = bundle_from_document(closure)
    # Check both the public field coercion and the retained imported payload.
    # Import alone is historical and does not validate authoring semantics.
    retained_clips = closure['parent_revision']['payload']['clips']
    for i, easing in enumerate(('out', 'in')):
        entrance = next(row for row in retained_clips if row['id'] == f'overlay-{i}')['entrance']
        assert coerce('entrance', entrance, fps=30) == ('entrance', entrance)
        assert entrance == {'type': 'fade', 'duration': 0.2, 'params': {'easing': easing}}
    bundle['source_mapping']['pinned_documents'] = [{'pin': pin, 'document': document}]
    choice = {'source': 'occurrence:film-test-occ-0/clip:footage-0-0', 'document': pin,
              'word_ids': [content['segments'][0]['words'][0]['id']]}
    anchor = capture_anchor(bundle, 'parent/clip:element-built-in', 'on', '"fixture"', choice)
    assert anchor['args']['choice'] == choice
    accepted = service.commit_timeline(project, 'film-test', {
        'api_version': 1, 'project_id': project, 'timeline_id': 'film-test',
        'base_revision_id': head['head_revision_id'], 'base_publication_id': head['head_publication_id'],
        'commands': [anchor],
    }, idempotency_key='anchor', publisher='author', invocation_path=route_path(project, 'film-test'), authorize=lambda: None)
    accepted_doc = accepted['data']['canonical_document']
    assert pin in accepted_doc['dependency_manifest']['documents']
    fresh = service.get_project_timeline(project, 'film-test')
    closure = commits.revision_closure(project, 'film-test', fresh['head_revision_id'])
    saved = bundle_from_document(closure)
    parent_clip = next(row for row in saved['parent']['clips'] if row['id'] == 'element-built-in')
    assert parent_clip['app']['astrid']['word_anchors']['on']['document'] == pin
    shot = saved['shots']['film-test-shot-0000']['internal_timeline']
    child = next(row for row in shot['clips'] if row['id'] == 'footage-0-1')
    assert child['app']['astrid']['on'] == '"fixture"' and child['at'] == 0.1
    assert pin in closure['dependency_manifest']['documents']
    overlays = [row for row in saved['parent']['clips'] if row['id'].startswith('overlay-')]
    originals = {row['id']: row for row in shot['clips']}
    assert len(overlays) == 2
    for i, overlay in enumerate(overlays):
        original = originals[f'footage-0-{i}']
        assert overlay['at'] == original['at'] and overlay['hold'] == original['hold']
    last = saved['placements'][-1]
    last_shot = saved['shots'][last['shot_id']]['internal_timeline']
    assert any(row['at'] + row['hold'] > last['duration_ms'] / 1000 for row in last_shot['clips'])
    print('accepted')
`;
  const result = spawnSync(process.env.SAVE_LOOP_TEST_PYTHON, ['-c', python],
    {input: JSON.stringify({shape: filmShape(), sources, pins, node: process.execPath,
      module: new URL('./film-import.mjs', import.meta.url).href}), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /accepted/);
});

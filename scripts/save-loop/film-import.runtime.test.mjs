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
import copy, json, sys, tempfile, subprocess
from runtime_protocol.service import RuntimeService
from runtime_protocol.store import RealmStore
from astrid.core.timeline.authoring_bundle import _digest
from astrid.sdk.media_transcript import build_transcript, transcript_document_id
from astrid.sdk.timeline.commit import bundle_from_document
from astrid.sdk.timeline.native_word_anchor import capture_anchor, legacy_binding
from astrid.sdk.timeline.compiler import TimingCompileError
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
    # Legacy lookup must reject repeated matching media; demonstrate a unique
    # result only after restricting a copy to one literal source clip.
    captures = bundle['source_mapping']['pinned_documents']
    try:
        legacy_binding(bundle, 'parent/clip:element-built-in', 'on', '"fixture"', captures)
    except TimingCompileError as exc:
        assert 'ambiguous' in str(exc)
    else:
        raise AssertionError('reused media unexpectedly resolved uniquely')
    unique = copy.deepcopy(bundle)
    unique['placements'] = unique['placements'][:1]
    internal = unique['shots'][unique['placements'][0]['shot_id']]['internal_timeline']
    internal['clips'] = [row for row in internal['clips'] if row['id'] == 'footage-0-0']
    resolved = legacy_binding(unique, 'parent/clip:element-built-in', 'on', '"fixture"', captures)
    assert resolved.document_id == doc_id and resolved.version == pin['version']
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
    assert document['content'] == content
    assert pin['version'] == document['version'] and pin['content_digest'] == _digest(document['content'])
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
    # A separate full closure has exactly one narration source and distinct
    # visual targets; two repeated tokens remain intentionally ambiguous.
    audio = service.ingest(project, b'generated-narration', media_type='audio/wav', original_name='voice.wav', idempotency_key='voice')['data']['object_id']
    image = service.ingest(project, b'generated-still', media_type='image/png', original_name='still.png', idempotency_key='still')['data']['object_id']
    def selection(asset, media):
        return {'asset': asset, 'object_id': media, 'generation_id': 'generated', 'variant_id': 'original'}
    word_rows = [[0.1, 0.2, 'w0001'], [0.3, 0.4, 'w0002'], [0.5, 0.6, 'repeat'], [0.7, 0.8, 'repeat']]
    voice_content = build_transcript(audio, 'narration', 'w0001 w0002 repeat repeat', word_rows)
    voice_id = transcript_document_id(project, audio, voice_content['source_id'])
    voice_spec = {'projectId': project, 'timelineId': 'voice-test', 'shape': request['shape'], 'selections': request['pins'],
                  'legacyWord': {'documentId': voice_id, 'text': 'w0001', 'at': 0.1, 'content': voice_content},
                  'narration': {'selection': selection('voice', audio), 'image': selection('still', image),
                                'words': [{'text': row[2], 'at': row[0]} for row in word_rows]}}
    voice_prepared = json.loads(subprocess.run([request['node'], '--input-type=module', '-e', build, request['module']],
                                    input=json.dumps(voice_spec), text=True, capture_output=True, check=True).stdout)
    service.import_timeline(project, voice_prepared, idempotency_key='voice-import')
    voice_head = service.get_project_timeline(project, 'voice-test')
    voice_doc = service.get_document(project, voice_id)
    voice_pin = {'document_id': voice_id, 'version': voice_doc['version'], 'content_digest': _digest(voice_content)}
    voice_closure = commits.revision_closure(project, 'voice-test', voice_head['head_revision_id'])
    voice_bundle = bundle_from_document(voice_closure)
    voice_captures = [{'pin': voice_pin, 'document': voice_doc}]
    voice_bundle['source_mapping']['pinned_documents'] = voice_captures
    for text in ('w0001', 'w0002'):
        hit = legacy_binding(voice_bundle, 'parent/clip:element-built-in', 'on', f'"{text}"', voice_captures)
        assert hit.document_id == voice_id and hit.source[2] == 'narration'
    for _ in range(2):
        try:
            legacy_binding(voice_bundle, 'parent/clip:element-built-in', 'on', '"repeat"', voice_captures)
        except TimingCompileError as exc:
            assert 'ambiguous' in str(exc)
        else:
            raise AssertionError('repeated narration word unexpectedly resolved')
    voice_choice = {'source': 'occurrence:voice-test-occ-0/clip:narration', 'document': voice_pin,
                    'word_ids': [voice_content['segments'][0]['words'][0]['id']]}
    voice_anchor = capture_anchor(voice_bundle, 'parent/clip:element-built-in', 'on', '"w0001"', voice_choice)
    service.commit_timeline(project, 'voice-test', {
        'api_version': 1, 'project_id': project, 'timeline_id': 'voice-test',
        'base_revision_id': voice_head['head_revision_id'], 'base_publication_id': voice_head['head_publication_id'],
        'commands': [voice_anchor],
    }, idempotency_key='voice-anchor', publisher='author', invocation_path=route_path(project, 'voice-test'), authorize=lambda: None)
    voice_head = service.get_project_timeline(project, 'voice-test')
    voice_closure = commits.revision_closure(project, 'voice-test', voice_head['head_revision_id'])
    assert voice_pin in voice_closure['dependency_manifest']['documents']
    voice_saved = bundle_from_document(voice_closure)
    voice_saved['source_mapping']['pinned_documents'] = voice_captures
    from astrid.sdk.timeline._shot_word_retime import ShotWordRetimeInputs
    retime = ShotWordRetimeInputs(voice_saved)
    shot = voice_saved['shots']['voice-test-shot-0000']['internal_timeline']
    assert len([row for row in shot['clips'] if row['id'] == 'narration']) == 1
    assert next(row for row in shot['tracks'] if row['id'] == 'LA1')['kind'] == 'audio'
    for i, text in enumerate(('w0001', 'w0002')):
        child = next(row for row in shot['clips'] if row['id'] == f'footage-0-{i}')
        assert shot['registry']['assets'][child['asset']]['type'] == ('image' if i == 0 else 'video')
        binding, edge, interval = retime.resolve(('voice-test-occ-0', 'voice-test-shot-0000', child['id']), child, 'on', f'"{text}"')
        assert binding.document_id == voice_id and binding.word_ids == (voice_content['segments'][0]['words'][i]['id'],)
    for i in (2, 3):
        child = next(row for row in shot['clips'] if row['id'] == f'footage-0-{i}')
        try:
            retime.resolve(('voice-test-occ-0', 'voice-test-shot-0000', child['id']), child, 'on', '"repeat"')
        except (TimingCompileError, ValueError):
            pass
        else:
            raise AssertionError('TE3 unexpectedly resolved a repeated word')
    print('accepted')
`;
  const result = spawnSync(process.env.SAVE_LOOP_TEST_PYTHON, ['-c', python],
    {input: JSON.stringify({shape: filmShape(), sources, pins, node: process.execPath,
      module: new URL('./film-import.mjs', import.meta.url).href}), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /accepted/);
});

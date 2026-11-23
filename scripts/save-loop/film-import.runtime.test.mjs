import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {filmShape} from './film-shape.mjs';
import {prepareFilmImport} from './film-import.mjs';

// Opt in only with a Python that already has the pinned Runtime installed.
// This exercises import acceptance in a disposable embedded realm, not render.
test('Runtime accepts the prepared historical closure', {skip: !process.env.SAVE_LOOP_TEST_PYTHON}, () => {
  const sources = ['generated-fixture-a', 'generated-fixture-b', 'generated-fixture-c'];
  const pins = sources.map((source, i) => ({asset: `asset-${i}`, generation_id: `generation-${i}`,
    variant_id: `variant-${i}`, object_id: `sha256:${createHash('sha256').update(source).digest('hex')}`}));
  const prepared = prepareFilmImport({projectId: 'PROJECT', timelineId: 'film-test', shape: filmShape(), selections: pins});
  const python = String.raw`
import json, sys, tempfile
from runtime_protocol.service import RuntimeService
from runtime_protocol.store import RealmStore
from astrid.core.timeline.authoring_bundle import _digest
from astrid.sdk.media_transcript import build_transcript, transcript_document_id
from astrid.sdk.timeline.commit import bundle_from_document
from astrid.sdk.timeline.native_word_anchor import capture_anchor
request = json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='save-loop-import-') as root:
    RealmStore.initialize(root).close()
    service = RuntimeService(root)
    project = service.create_project({'slug': 'fixture', 'name': 'Fixture'}, idempotency_key='project')['id']
    prepared = request['prepared']
    prepared['publication']['project_id'] = project
    for i, source in enumerate(request['sources']):
        result = service.ingest(project, source.encode(), media_type='video/mp4', original_name=f'{i}.mp4', idempotency_key=f'media-{i}')
        assert result['data']['object_id'] == request['pins'][i]['object_id']
    result = service.import_timeline(project, prepared, idempotency_key='import')
    assert result['data']['timeline_id'] == 'film-test'
    head = service.get_project_timeline(project, 'film-test')
    assert head['head_revision_id'] == prepared['publication']['parent_revision_id']
    # Capture a real generated transcript pin against one shot source and a
    # parent target. This checks capture only; the caller must still commit it.
    content = build_transcript(request['pins'][0]['object_id'], 'film-line', 'fixture', [[0.1, 0.2, 'fixture']])
    doc_id = transcript_document_id(project, content['media_id'], content['source_id'])
    document = service.create_document(project, {'document_id': doc_id, 'kind': 'media.transcript', 'content': content}, idempotency_key='transcript')['data']
    pin = {'document_id': doc_id, 'version': document['version'], 'content_digest': _digest(content)}
    commits, _ = service._timeline_commits()
    closure = commits.revision_closure(project, 'film-test', head['head_revision_id'])
    bundle = bundle_from_document(closure)
    bundle['source_mapping']['pinned_documents'] = [{'pin': pin, 'document': document}]
    choice = {'source': 'occurrence:film-test-occ-0/clip:footage-0-0', 'document': pin,
              'word_ids': [content['segments'][0]['words'][0]['id']]}
    anchor = capture_anchor(bundle, 'parent/clip:element-built-in', 'on', '"fixture"', choice)
    assert anchor['args']['choice'] == choice
    print('accepted')
`;
  const result = spawnSync(process.env.SAVE_LOOP_TEST_PYTHON, ['-c', python],
    {input: JSON.stringify({prepared, sources, pins}), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /accepted/);
});

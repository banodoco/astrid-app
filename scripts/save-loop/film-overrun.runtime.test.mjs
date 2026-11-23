import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {filmShape} from './film-shape.mjs';

// The imported closure is real; candidate edits below exercise the TE-2
// validator directly, not a Runtime commit or render.
test('imported legacy overrun allows only non-worsening start shifts', {skip: !process.env.SAVE_LOOP_TEST_PYTHON}, () => {
  const sources = ['generated-fixture-a', 'generated-fixture-b', 'generated-fixture-c'];
  const pins = sources.map((source, i) => ({asset: `asset-${i}`, generation_id: `generation-${i}`,
    variant_id: `variant-${i}`, object_id: `sha256:${createHash('sha256').update(source).digest('hex')}`}));
  const python = String.raw`
import copy, json, subprocess, sys, tempfile
from runtime_protocol.service import RuntimeService
from runtime_protocol.store import RealmStore
from astrid.core.timeline.authoring_bundle import AuthoringBundleError
from astrid.sdk.timeline import commit
from astrid.sdk.timeline.commit import bundle_from_document
from astrid.sdk.timeline.validation import validate_final_candidate
request = json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='save-loop-overrun-') as root:
    RealmStore.initialize(root).close()
    service = RuntimeService(root)
    service.register_timeline_commit_provider(commit.create_runtime_commit_service())
    project = service.create_project({'slug': 'fixture', 'name': 'Fixture'}, idempotency_key='project')['id']
    for i, source in enumerate(request['sources']):
        result = service.ingest(project, source.encode(), media_type='video/mp4', original_name=f'{i}.mp4', idempotency_key=f'media-{i}')
        assert result['data']['object_id'] == request['pins'][i]['object_id']
    build = '''const {prepareFilmImport} = await import(process.argv[1]); let s=''; for await (const x of process.stdin) s+=x; console.log(JSON.stringify(prepareFilmImport(JSON.parse(s))));'''
    spec = {'projectId': project, 'timelineId': 'film-test', 'shape': request['shape'], 'selections': request['pins']}
    prepared = json.loads(subprocess.run([request['node'], '--input-type=module', '-e', build, request['module']], input=json.dumps(spec), text=True, capture_output=True, check=True).stdout)
    service.import_timeline(project, prepared, idempotency_key='import')
    head = service.get_project_timeline(project, 'film-test')
    commits, _ = service._timeline_commits()
    baseline = bundle_from_document(commits.revision_closure(project, 'film-test', head['head_revision_id']))
    occurrence = baseline['placements'][-1]
    shot_id = occurrence['shot_id']
    clips = baseline['shots'][shot_id]['internal_timeline']['clips']
    bound = occurrence['duration_ms'] / 1000
    overrun = [row for row in clips if row['at'] + row['hold'] > bound + 1e-9]
    assert overrun, 'full imported fixture must have a historical overrun'
    target = overrun[0]
    old = target['at'] + target['hold'] - bound
    assert old > 0.05 and target['at'] >= 0.05
    validate_final_candidate(baseline, baseline=baseline)
    def edit():
        candidate = copy.deepcopy(baseline)
        return candidate, next(row for row in candidate['shots'][shot_id]['internal_timeline']['clips'] if row['id'] == target['id'])
    candidate, clip = edit()
    clip['at'] -= 0.05
    assert 0 < clip['at'] + clip['hold'] - bound < old
    validate_final_candidate(candidate, baseline=baseline)
    def rejected(candidate):
        try:
            validate_final_candidate(candidate, baseline=baseline)
        except AuthoringBundleError as exc:
            assert 'half-open bounds' in str(exc), str(exc)
        else:
            raise AssertionError('invalid legacy edit was accepted')
    candidate, clip = edit()
    clip['at'] += 0.05
    rejected(candidate)
    candidate, clip = edit()
    clip['at'] -= 0.05
    clip['from'] += 0.01
    rejected(candidate)
    print('full imported baseline accepted; reduced overrun accepted; increased overrun and changed source rejected')
`;
  const result = spawnSync(process.env.SAVE_LOOP_TEST_PYTHON, ['-c', python],
    {input: JSON.stringify({shape: filmShape(), sources, pins, node: process.execPath,
      module: new URL('./film-import.mjs', import.meta.url).href}), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /full imported baseline accepted; reduced overrun accepted; increased overrun and changed source rejected/);
});

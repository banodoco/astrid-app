import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('generated effect is declared in the pack with its implementation', () => {
  const helper = fileURLToPath(new URL('./film_packs.py', import.meta.url));
  const python = String.raw`
import importlib.util, pathlib, sys, tempfile, yaml
spec = importlib.util.spec_from_file_location('film_packs', sys.argv[1])
film = importlib.util.module_from_spec(spec)
spec.loader.exec_module(film)
with tempfile.TemporaryDirectory(prefix='film-pack-source-') as temporary:
    root = pathlib.Path(temporary)
    (root / 'pack.yaml').write_text(yaml.safe_dump({'id': 'test-pack', 'rendering': {}}))
    film._write_effect({'packRoot': temporary, 'packId': 'test-pack'}, 'fixture_project')
    manifest = yaml.safe_load((root / 'pack.yaml').read_text())
    entry = manifest['rendering']['effects/fixture_project']
    definition = yaml.safe_load((root / entry['path']).read_text())
    assert definition['id'] == 'fixture_project' and definition['pack_id'] == 'test-pack'
    assert definition['kind'] == 'effect'
    assert entry['type'] == 'element'
    assert len(entry['resources']) == 1 and entry['resources'][0]['kind'] == 'implementation'
    assert (root / entry['resources'][0]['path']).read_text().strip()
`;
  const result = spawnSync(process.env.SAVE_LOOP_TEST_PYTHON || 'python3', ['-c', python, helper],
    {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
});

// Opt in only with the pinned Runtime and its already-installed Remotion toolchain.
// This proves admission and retained source objects, not placement or rendering.
test('Runtime admits both generated film packs', {skip: !process.env.SAVE_LOOP_TEST_PACKS_PYTHON}, () => {
  const helper = fileURLToPath(new URL('./film_packs.py', import.meta.url));
  const python = String.raw`
import importlib.util, json, os, sys, tempfile
from types import SimpleNamespace
from runtime_protocol.errors import NotFoundError
from runtime_protocol.service import RuntimeService
from runtime_protocol.store import RealmStore
from astrid.core.element import project_packs as packs
from astrid.sdk.contracts import DomainResult, ErrorObject

spec = importlib.util.spec_from_file_location('film_packs', sys.argv[1])
film = importlib.util.module_from_spec(spec)
spec.loader.exec_module(film)
with tempfile.TemporaryDirectory(prefix='film-pack-test-') as root:
    os.environ[packs.ROOT_ENV] = os.path.join(root, 'source')
    os.environ[packs.ARTIFACT_ENV] = os.path.join(root, 'artifacts')
    realm_root = os.path.join(root, 'realm')
    RealmStore.initialize(realm_root, realm_id='realm').close()
    service = RuntimeService(realm_root)
    project = service.create_project({'slug': 'film-packs', 'name': 'Film packs'})['id']
    class Documents:
        def _identity(self): return {'realm_id': 'realm'}
        def show(self, document, *, project):
            try: return DomainResult.success(service.get_document(project, document))
            except NotFoundError: return DomainResult.failure(ErrorObject('not_found', 'missing', {}))
        def create(self, *, project, kind, document_id, content, idempotency_key):
            return DomainResult.success(service.create_document(project, {'kind': kind, 'document_id': document_id, 'content': content}, idempotency_key=idempotency_key)['data'])
        def update(self, document, *, project, content, expected_version, idempotency_key):
            return DomainResult.success(service.update_document(project, document, {'content': content, 'expected_version': expected_version}, idempotency_key=idempotency_key)['data'])
    class Media:
        def import_bytes(self, *, project, data, filename, media_type, idempotency_key):
            return DomainResult.success(service.ingest(project, data, media_type=media_type, idempotency_key=idempotency_key)['data'])
        def read_bytes(self, object_id): return service.cas.read(object_id.removeprefix('sha256:'))
    client = SimpleNamespace(documents=Documents(), media=Media())
    found = []
    try:
        for label, collection in [('project', 'default'), ('collection', 'fixture_collection')]:
            context = packs.init_project_pack('realm', project, client=client, collection=collection)
            film._write_effect(context, 'fixture_' + label)
            admitted = packs.admit_project_pack('realm', project, client=client, collection=collection)
            rows = [row for row in admitted['elements'] if row['descriptor']['id'] == 'fixture_' + label]
            assert len(rows) == 1
            descriptor = rows[0]['descriptor']
            reference = {k: descriptor[k] for k in ('packId', 'id', 'kind', 'revision')}
            document = service.get_document(project, admitted['documentId'])
            assert document['version'] == admitted['documentVersion']
            matching = [row for row in document['content']['admissions'] if row['id'] == reference['id'] and row['revision'] == reference['revision']]
            assert len(matching) == 1
            snapshot = matching[0]['snapshot_object']
            assert service.cas.read(snapshot['object_id'].removeprefix('sha256:'))
            resolved = packs.resolve_admitted_element('realm', project, reference, client=client)
            assert all(resolved['descriptor'][k] == v for k, v in reference.items())
            found.append(reference['packId'])
        assert len(set(found)) == 2
        print(json.dumps({'admitted': 2}))
    finally:
        service.close()
`;
  const result = spawnSync(process.env.SAVE_LOOP_TEST_PACKS_PYTHON, ['-c', python, helper],
    {encoding: 'utf8', maxBuffer: 10 * 1024 * 1024});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {admitted: 2});
});

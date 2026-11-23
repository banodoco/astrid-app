"""Resolve the collection element and admit the generated project effect.

The project target must already be a built-in effect clip on the timeline.
"""
from pathlib import Path


def _write_effect(context, element_id):
    import yaml

    root = Path(context['packRoot'])
    relative = f'rendering/elements/effects/{element_id}'
    directory = root / relative
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'component.tsx').write_text(
        "import React from 'react';\n"
        "import {AbsoluteFill} from 'remotion';\n"
        "export default function FixtureEffect(){return <AbsoluteFill style={{backgroundColor:'rgba(32,96,160,0.2)'}}/>;}\n",
        encoding='utf-8',
    )
    definition = {
        'schema_version': 1, 'id': element_id, 'kind': 'effect',
        'pack_id': context['packId'], 'short_description': 'Generated fixture effect.',
        'defaults': {}, 'schema': {'type': 'object', 'properties': {}},
        'runtime': {'adapter': 'remotion'},
    }
    (directory / 'element.yaml').write_text(yaml.safe_dump(definition), encoding='utf-8')
    manifest_path = root / 'pack.yaml'
    manifest = yaml.safe_load(manifest_path.read_text(encoding='utf-8'))
    manifest.setdefault('rendering', {})[f'effects/{element_id}'] = {
        'type': 'element', 'path': f'{relative}/element.yaml',
        'resources': [{'kind': 'implementation', 'path': f'{relative}/component.tsx'}],
    }
    manifest_path.write_text(yaml.safe_dump(manifest, sort_keys=False), encoding='utf-8')


def place_project(client, realm, project, timeline, head):
    """Admit the generated project effect and replace its existing placeholder."""
    from astrid.core.element import project_packs
    context = project_packs.init_project_pack(realm, project, client=client)
    _write_effect(context, 'fixture_project')
    admitted = project_packs.admit_project_pack(realm, project, client=client)
    candidates = [row['descriptor'] for row in admitted['elements']
                  if row['descriptor']['id'] == 'fixture_project']
    if len(candidates) != 1:
        raise RuntimeError('project pack did not admit exactly one fixture element')
    element = {key: candidates[0][key] for key in ('packId', 'id', 'kind', 'revision')}
    target = 'parent/clip:element-project-pack'
    result = client.timelines.place_element(project, timeline, realm=realm, target=target,
        element=element, expected_head=head, idempotency_key=f'film-pack-project-{timeline}')
    if not result.ok or not result.data.get('new_head'):
        raise RuntimeError('project pack placement did not return an accepted head')
    return result.data['new_head'], {'target': target, 'element': element,
        'document_id': admitted['documentId'], 'document_version': admitted['documentVersion']}


def collection_reference(pack_path):
    """Resolve the revision from the supplied installed astrid_motion source."""
    from astrid.core.element.registry import load_default_registry
    from astrid.core.element.catalog import _element_descriptor
    registry = load_default_registry(extra_pack_roots=(str(Path(pack_path).resolve()),))
    descriptor = _element_descriptor(registry.get('effects', 'am-type', pack_id='astrid_motion'))
    ref = {key: descriptor[key] for key in ('packId', 'id', 'kind', 'revision')}
    if not all(isinstance(value, str) and value for value in ref.values()):
        raise RuntimeError('collection descriptor is incomplete')
    return ref

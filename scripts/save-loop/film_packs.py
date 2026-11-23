"""Generate and admit the two owned effect packs used by the film-shaped fixture.

The target clips must already be built-in effect clips accepted on the timeline.
Admission and placement use the same isolated Runtime client as the builder.
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


def create_and_place(client, realm, project, timeline, head, targets):
    """Admit two generated effects and place them, returning the new head and refs.

    ``targets`` maps ``project`` and ``collection`` to exact parent or occurrence
    clip selectors. Each placement is a separate accepted Runtime publication.
    """
    from astrid.core.element import project_packs

    if set(targets) != {'project', 'collection'}:
        raise ValueError('film packs require project and collection target clips')
    placed = {}
    for label, collection in (('project', 'default'), ('collection', 'fixture_collection')):
        context = project_packs.init_project_pack(realm, project, client=client, collection=collection)
        element_id = f'fixture_{label}'
        _write_effect(context, element_id)
        admitted = project_packs.admit_project_pack(realm, project, client=client, collection=collection)
        candidates = [row['descriptor'] for row in admitted['elements'] if row['descriptor']['id'] == element_id]
        if len(candidates) != 1:
            raise RuntimeError(f'{label} pack did not admit exactly one fixture element')
        element = {key: candidates[0][key] for key in ('packId', 'id', 'kind', 'revision')}
        result = client.timelines.place_element(
            project, timeline, realm=realm, target=targets[label], element=element,
            expected_head=head, idempotency_key=f'film-pack-{label}-{timeline}',
        )
        if not result.ok:
            raise RuntimeError(f'{label} pack placement failed: {result.error}')
        head = result.data.get('new_head')
        if not head:
            raise RuntimeError(f'{label} pack placement omitted the accepted head')
        placed[label] = {'target': targets[label], 'element': element,
                         'document_id': admitted['documentId'], 'document_version': admitted['documentVersion']}
    return head, placed

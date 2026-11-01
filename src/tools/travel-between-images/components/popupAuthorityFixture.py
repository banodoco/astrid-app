"""Offline A3 fixture: real provider execution, no Runtime service or acceptance.

Source: Agent 0ff3d103fb892977b0853829f42b748a5d567851 (provider files also
unchanged at 67d5f19716d1e6b2f30445e14bfdcbf3927108de).
Uses the public Agent checkout and dependency-only environment in place. Input is
an independently specified scenario, never the mounted caller's submitted body.
The receipt/landing status are transport mocks, not authenticated Runtime proof.
"""
import json
import sys

from astrid.sdk.timeline.commands import execute
from astrid.sdk.timeline.commit import (
    COMPILER_VERSION, PROVIDER_VERSION, _digest, _verify_document,
    bundle_from_document, document_from_bundle,
)
from astrid.sdk.timeline._commit_patch import Closure, effect_diff, rebase_patch
from astrid.sdk.timeline._commit_preview import prepared_records
from astrid.sdk.timeline.validation import validate_final_candidate

scenario = json.load(sys.stdin)
document, request = scenario['document'], scenario['request']
input_digest = _digest(document)
base = {'revision_id': request['base_revision_id'],
        'publication_id': request['base_publication_id']}
bundle = bundle_from_document(document)
selection = request['commands'][1]['args']['media']
verified = [{'selection': selection, 'media_type': 'image/png', 'size': 1234,
             'duration_seconds': None}]
plan = execute(bundle, request['commands'], verified_media=verified,
               commit_request=request, evaluated_head=base)
original = plan
previous = base
landing = bundle
if scenario['status'] == 'merged':
    change = {'op': 'set', 'ref': 'parent', 'path': ['meta'],
              'before': {'state': 'absent'},
              'value': {'org.example.peer': {'retained': [None, False]}}}
    peer_call = {'schema_version': 1, 'op': 'doc.patch', 'version': '1',
                 'select': None, 'args': {'changes': [change]}, 'created': []}
    peer_request = {**request, 'commands': [peer_call], 'label': 'Peer metadata',
                    'reads': [], 'steps': [{'id': 'peer', 'label': 'Peer metadata',
                        'intent': 'disjoint peer edit', 'tags': [],
                        'command_ordinals': [0], 'patch': [change]}]}
    peer = execute(bundle, [peer_call], commit_request=peer_request, evaluated_head=base)
    peer_document = document_from_bundle(peer.bundle)
    landing = bundle_from_document(peer_document)
    previous = {'revision_id': peer_document['parent_revision']['revision_id'],
                'publication_id': 'pub-intervening'}
    entry = {'publication_id': previous['publication_id'], 'revision_id': previous['revision_id'],
             'previous': base, 'records': prepared_records(peer, undo_of=[], restored_from=None)}
    try:
        bindings = rebase_patch(original, [entry], landing, load_boundary=lambda _: (bundle, landing))
    except Exception as exc:
        print('REBASE_REF=' + str(getattr(exc, 'ref', None)), file=sys.stderr)
        raise
    plan = execute(landing, original.commands, verified_media=verified,
                   commit_request=request, evaluated_head=previous,
                   replay_bindings=bindings, intervening_records=peer.records)
# This is the same final-candidate adapter used by commit.py for shared roots.
validation = bundle_from_document(document_from_bundle(plan.bundle))
validate_final_candidate(validation, baseline=landing, schema_inputs=[], realm_id=None)
output = document_from_bundle(plan.bundle)
_verify_document(output)
assert _digest(document) == input_digest
assert plan.steps[0]['patch'] == effect_diff(Closure(landing), Closure(plan.bundle))
assert len(plan.steps[0]['patch']) > 1 and plan.steps[0]['dependencies']
assert all(record['bindings'] and record['reads'] for record in plan.records)
assert plan.records[0]['created'] and plan.records[1]['created']
# The sibling's complete immutable closure survives, not just its visible clip.
sibling = document['parent_revision']['payload']['occurrences'][1]
assert output['parent_revision']['payload']['occurrences'][1] == sibling
assert all(image in output['shot_revisions'] for image in document['shot_revisions'])
assert all(image in output['internal_timeline_revisions'] for image in document['internal_timeline_revisions'])
fork = next(image for image in output['shot_revisions']
            if image['shot_id'] == request['commands'][0]['args']['shot_id'])
internal = next(image for image in output['internal_timeline_revisions']
                if image['revision_id'] == fork['internal_timeline_revision_id'])
assert output['parent_revision']['payload']['occurrences'][0]['shot_revision_id'] == fork['revision_id']
assert internal['payload']['clips'][-1] == request['commands'][1]['args']['row']
source_shot = next(image for image in document['shot_revisions']
                   if image['revision_id'] == document['parent_revision']['payload']['occurrences'][0]['shot_revision_id'])
source_internal = next(image['payload'] for image in document['internal_timeline_revisions']
                       if image['revision_id'] == source_shot['internal_timeline_revision_id'])
assert internal['payload']['clips'][:-1] == source_internal['clips']
assert internal['payload']['meta'] == source_internal['meta']
raw_v2 = next(row for row in internal['payload']['clips'] if row['id'] == 'raw-v2-occupied')
assert raw_v2['track'] == 'V2' and raw_v2['params'] is None and 'from' not in raw_v2
assert internal['payload']['registry']['assets'][selection['asset']] == {
    'media_id': selection['object_id'], 'type': 'image',
    'generationId': selection['generation_id'], 'variantId': selection['variant_id']}
assert {effect['ref'] for effect in plan.steps[0]['patch'] if effect['path'] == []} >= {
    'shot-revision:' + fork['revision_id'], 'internal-revision:' + internal['revision_id']}
if scenario['status'] == 'merged':
    assert output['parent_revision']['payload']['meta'] == {'org.example.peer': {'retained': [None, False]}}
print(json.dumps({'document': output, 'commands': plan.commands, 'steps': plan.steps,
                  'records': plan.records, 'merge_mode': plan.merge_mode,
                  'provider_version': PROVIDER_VERSION, 'compiler_version': COMPILER_VERSION,
                  'previous': previous, 'document_digest': _digest(output)}, allow_nan=False))

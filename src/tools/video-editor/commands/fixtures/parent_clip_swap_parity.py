"""Check PARENT_SWAP_PARITY_OUTPUT from Vitest against private014 Agent on PYTHONPATH.

Run from App's root with the JSON export path as the sole argument. Only pure
native commands are used; this never loads a Runtime provider or opens a Door.
"""
import copy
import json
import sys
from pathlib import Path

from astrid.sdk.timeline._command_state import CommandError, present
from astrid.sdk.timeline.commands import Plan, execute
from astrid.sdk.timeline.native_occurrence_media_commands import capture_parent_swap_media
from astrid.sdk.timeline.rebase import replay

samples = json.loads(Path(sys.argv[1]).read_text())
assert len(samples) == 4, 'expected replacement, absent/null hold and main registry samples'
for sample in samples:
    original, command, inputs = sample['original'], sample['command'], sample['inputs']
    before = copy.deepcopy(original)
    native_command = capture_parent_swap_media(
        original, command['select'], command['args']['old_media'], command['args']['media'], verified_media=inputs)
    assert native_command == command, 'App command differs from authoritative capture'
    plan = execute(original, [command], verified_media=inputs)
    assert plan.bundle == sample['bundle'], 'App result differs from native'
    assert plan.records == [sample['record']], 'App recorder differs from native'
    assert original == before, 'input mutated'
print(f'{len(samples)} exact App/native commands, records and authored bundles')

sample = samples[0]
original, command, inputs = sample['original'], sample['command'], sample['inputs']
# Reconstitute accepted records from App JSON, rather than native objects.
plan = Plan(copy.deepcopy(sample['bundle']), [copy.deepcopy(sample['record'])])
inverse = execute(plan.bundle, [{'schema_version': 1, 'op': 'timeline.inverse', 'version': '1',
    'select': None, 'args': {'publications': ['accepted-publication']}}], inverse_records=plan.records)
assert inverse.bundle == original, 'App JSON record failed exact native inverse'
assert replay(plan, original, verified_media=inputs).records == plan.records
head = copy.deepcopy(original)
head['parent']['clips'][1]['opaque'] = {'peer': 'changed'}
head['parent']['config']['clips'] = copy.deepcopy(head['parent']['clips'])
peer = {'writes': [{'ref': 'parent/clip:clip-b', 'path': ['opaque'],
    'before': present({'peer': True}), 'after': present({'peer': 'changed'})}]}
rebased = replay(plan, head, verified_media=inputs, intervening_records=[peer])
expected = copy.deepcopy(sample['bundle'])
expected['parent']['clips'][1]['opaque'] = {'peer': 'changed'}
expected['parent']['config']['clips'] = copy.deepcopy(expected['parent']['clips'])
assert rebased.bundle == expected, 'replay lost unrelated peer edit'
assert rebased.commands == [command], 'replay changed original claims'
print('App JSON record: exact inverse, deterministic replay and unrelated peer replay passed')

for failure in ('stale-source', 'wrong-old-selection', 'wrong-new-selection', 'occupied-alias', 'old-duration'):
    candidate, call, verified = copy.deepcopy(original), copy.deepcopy(command), copy.deepcopy(inputs)
    if failure == 'stale-source':
        for registry in (candidate['parent']['registry'], candidate['parent']['config']['registry']):
            registry['assets']['reserved-old']['media_id'] = 'sha256:' + '3' * 64
    elif failure.startswith('wrong-'):
        key = 'old_media' if failure == 'wrong-old-selection' else 'media'
        call['args'][key]['catalog_digest'] = 'sha256:' + 'c' * 64
    elif failure == 'occupied-alias':
        call = {key: value for key, value in call.items() if key in ('schema_version', 'op', 'version', 'select', 'args', 'intent')}
        call['args']['media']['asset'] = 'reserved-old'
        verified[1]['selection']['asset'] = 'reserved-old'
    else:
        call = {key: value for key, value in call.items() if key in ('schema_version', 'op', 'version', 'select', 'args', 'intent')}
        verified[0]['duration_seconds'] = 5
    before = copy.deepcopy(candidate)
    try:
        execute(candidate, [call], verified_media=verified)
    except CommandError as exc:
        assert exc.kind == ('unsupported_timing' if failure == 'old-duration' else 'dependency_changed'), (failure, exc)
    else:
        raise AssertionError(f'{failure} was accepted')
    assert candidate == before, failure
print('stale source, wrong old/new selections, occupied alias and short old source refused atomically')

"""Check or regenerate portable move goldens using Agent on PYTHONPATH."""
import json
import sys
from pathlib import Path

from astrid.sdk.timeline.capture import capture_move
from astrid.sdk.timeline.commands import execute

path = Path(__file__).with_name('recipe_m1_move.json')
data = json.loads(path.read_text())
cases = [data, *data['cases']]
update = sys.argv[1:] == ['--update']
if sys.argv[1:] and not update:
    raise SystemExit('usage: clip_move_parity.py [--update]')
for case in cases:
    command = capture_move(case['bundle'], case['select'], case['on'])
    plan = execute(case['bundle'], [command])
    expected = {'command': command, 'after_bundle': plan.bundle, 'record': plan.records[0]}
    if update:
        case.update(expected)
    else:
        for key, value in expected.items():
            assert case[key] == value, (case['name'], key)
    if 'head_bundle' in case:
        replayed = execute(case['head_bundle'], [command])
        assert replayed.commands == [command], (case['name'], 'original claims')
        if update:
            case['rebased_bundle'], case['rebased_record'] = replayed.bundle, replayed.records[0]
        else:
            assert replayed.bundle == case['rebased_bundle'], (case['name'], 'rebased bundle')
            assert replayed.records[0] == case['rebased_record'], (case['name'], 'rebased record')
if update:
    path.write_text(json.dumps(data, separators=(',', ':'), ensure_ascii=False, allow_nan=False) + '\n')
print(f'{len(cases)}/{len(cases)} exact commands, after_bundle and records ' + ('regenerated' if update else 'verified'))

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {filmShape} from './film-shape.mjs';
import {prepareFilmImport} from './film-import.mjs';

test('all film animations satisfy Agent clip field coercion', () => {
  const pin = {asset: 'asset', generation_id: 'generation', variant_id: 'variant', object_id: `sha256:${'a'.repeat(64)}`};
  const collectionElement = {packId: 'astrid_motion', id: 'am-type', kind: 'effect', revision: 'descriptor'};
  const prepared = prepareFilmImport({projectId: 'project', timelineId: 'film', shape: filmShape({clipCount: 619}), selections: [pin], collectionElement});
  const rows = prepared.publication.internal_timeline_revisions.flatMap(row => row.payload.clips)
    .filter(row => row.entrance || row.exit).map(row => row.exit ? ['exit', row.exit] : ['entrance', row.entrance]);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map(([phase, value]) => [phase, value.type]), [
    ['entrance', 'fade'], ['entrance', 'fade-up'], ['entrance', 'scale-in'],
    ['entrance', 'slide-left'], ['exit', 'slide-up'], ['entrance', 'type-on'],
    ['entrance', 'fade'], ['entrance', 'fade'], ['entrance', 'fade'], ['entrance', 'fade'],
  ]);
  const code = String.raw`
import json, sys
from astrid.core.timeline import clip_fields
rows = json.load(sys.stdin)
for phase, value in rows:
    field, actual = clip_fields.coerce(phase, value, fps=30)
    assert field == phase and actual == value, (phase, value, actual)
try:
    clip_fields.coerce('entrance', {'type': 'slide-up', 'duration': 0.2}, fps=30)
except clip_fields.ClipFieldError:
    pass
else:
    raise AssertionError('slide-up entrance must be refused')
`;
  const result = spawnSync(process.env.SAVE_LOOP_TEST_PYTHON || 'python3', ['-c', code], {
    input: JSON.stringify(rows), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

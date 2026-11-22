import assert from 'node:assert/strict';
import test from 'node:test';
import {expectedFixtureIds, first15FixtureIds, sameIds} from './readiness.mjs';

test('empty quick fixture has an exact empty clip inventory', () => {
  const fixture = {measurement: {clip_count: 0, accepted_prefix_asset_counts: {image: 0, video: 0, audio: 0}}};
  assert.deepEqual(expectedFixtureIds(fixture), []);
  assert.deepEqual(first15FixtureIds(fixture), []);
  assert.equal(sameIds([], []), true);
});

test('small quick fixtures retain exact generated clip identity ordering', () => {
  for (const [clip_count, counts] of [
    [10, {image: 3, video: 1, audio: 6}],
    [100, {image: 25, video: 6, audio: 69}],
  ]) {
    const ids = expectedFixtureIds({measurement: {clip_count, accepted_prefix_asset_counts: counts}});
    assert.equal(ids.length, clip_count);
    assert.equal(new Set(ids).size, clip_count);
    assert.equal(ids[0], 'fixture-image-0000');
    assert.equal(ids.at(-1), `fixture-audio-${String(clip_count - 1).padStart(4, '0')}`);
    assert.ok(first15FixtureIds({measurement: {clip_count, accepted_prefix_asset_counts: counts}}).length > 0);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {filmShape, parseFixtureOptions} from './film-shape.mjs';

test('film options have useful defaults and explicit options override environment', () => {
  assert.deepEqual(parseFixtureOptions(['--variant', 'film-shaped']),
    {variant: 'film-shaped', clipCount: 621, mediaSize: {width: 1280, height: 720}});
  assert.deepEqual(parseFixtureOptions(['--variant', 'film-shaped', '--clips', '42', '--media-size', '640x360'],
    {SAVE_LOOP_VARIANT: 'standard', SAVE_LOOP_CLIPS: '616'}),
    {variant: 'film-shaped', clipCount: 42, mediaSize: {width: 640, height: 360}});
});

test('options reject malformed or incompatible input', () => {
  for (const args of [['--variant'], ['--variant', 'other'], ['--clips', '2'],
    ['--variant', 'film-shaped', '--clips', '1.5'], ['--media-size', '641x360'],
    ['--media-size', '0x720'], ['--bogus', 'x'], ['--clips', '616', '--clips', '617']]) {
    assert.throws(() => parseFixtureOptions(args));
  }
});

test('default shape accounts for every child and parent overlay over 196 seconds', () => {
  const shape = filmShape();
  assert.equal(shape.shots.length, 46);
  assert.equal(shape.shots.flatMap(s => s.children).length + shape.overlays.length + shape.elements.length, 621);
  assert.equal(shape.shots.at(-1).on + shape.shots.at(-1).duration, 196);
  for (const [i, shot] of shape.shots.entries()) {
    if (i) assert.ok(Math.abs(shot.on - (shape.shots[i - 1].on + shape.shots[i - 1].duration)) < 1e-9);
    for (const child of shot.children) {
      assert.ok(child.at >= 0 && child.hold > 0 && child.at + child.hold <= shot.duration + 1e-9);
    }
  }
  for (const overlay of shape.overlays) {
    const shot = shape.shots[overlay.shotIndex], original = shot.children[overlay.childIndex];
    assert.equal(overlay.at, shot.on + original.at);
    assert.equal(overlay.hold, original.hold);
  }
});

test('configurable counts preserve total and duration', () => {
  for (const clipCount of [8, 42, 622, 1000]) {
    const shape = filmShape({clipCount});
    assert.equal(shape.shots.flatMap(s => s.children).length + shape.overlays.length + shape.elements.length, clipCount);
    assert.equal(shape.durationSeconds, 196);
  }
  assert.throws(() => filmShape({clipCount: 7}));
  assert.throws(() => filmShape({shotCount: 0}));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
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
    ['--media-size', '0x720'], ['--bogus', 'x'], ['--clips', '616', '--clips', '617'],
    ['--prepare-media'], ['--variant', 'film-shaped', '--prepare-media', '--prepare-media']]) {
    assert.throws(() => parseFixtureOptions(args));
  }
});

test('builder refuses an incomplete film fixture before stack or media creation', () => {
  const builder = fileURLToPath(new URL('./build-fixture.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [builder, '--variant', 'film-shaped'], {encoding: 'utf8', env: {}});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture construction is incomplete.*word provenance.*packs.*overlays.*legacy overrun/);
});

test('builder prepares generated film media without claiming a fixture', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'film-media-test-'));
  try {
    const builder = fileURLToPath(new URL('./build-fixture.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [builder, '--variant', 'film-shaped', '--clips', '42',
      '--media-size', '16x16', '--prepare-media'],
    {encoding: 'utf8', env: {PATH: process.env.PATH, SAVE_LOOP_SCRATCH: scratch}});
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'media-only');
    assert.equal(report.clip_count, 42);
    assert.deepEqual(report.media_size, {width: 16, height: 16});
    for (const file of [report.video, report.audio]) assert.ok(fs.statSync(file).size > 0);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height', '-of', 'csv=s=x:p=0', report.video], {encoding: 'utf8'});
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout.trim(), '16x16');
    assert.equal(new Set(report.object_ids).size, 2);
  } finally { fs.rmSync(scratch, {recursive: true, force: true}); }
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

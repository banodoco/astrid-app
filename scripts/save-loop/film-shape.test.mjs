import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {filmShape, filmFixtureShape, parseFixtureOptions} from './film-shape.mjs';

test('production ripple shapes support small requested counts with valid geometry', () => {
  for (const count of [23, 24, 36, 42, 621]) {
    const shape = filmFixtureShape(count);
    assert.equal(shape.shots.flatMap(shot => shot.children).length + shape.overlays.length + shape.elements.length + 3, count);
    assert.equal(shape.shots[0].duration, 4.2);
    for (const [i, shot] of shape.shots.entries()) {
      if (i) assert.ok(Math.abs(shot.on - shape.shots[i - 1].on - shape.shots[i - 1].duration) < 1e-9);
      for (const child of shot.children) assert.ok(child.at >= 0 && child.hold > 0 && child.at + child.hold <= shot.duration + 1e-9);
    }
  }
});

test('invalid film geometry fails before media creation', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'film-invalid-test-'));
  try {
    const builder = fileURLToPath(new URL('./build-fixture.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [builder, '--variant', 'film-shaped', '--clips', '1000000', '--prepare-media'],
      {encoding: 'utf8', env: {PATH: process.env.PATH, SAVE_LOOP_SCRATCH: scratch}});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /too many clips/);
    assert.deepEqual(fs.readdirSync(scratch), []);
  } finally { fs.rmSync(scratch, {recursive: true, force: true}); }
});

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

test('builder requires an owned isolated stack before film fixture creation', () => {
  const builder = fileURLToPath(new URL('./build-fixture.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [builder, '--variant', 'film-shaped'], {encoding: 'utf8', env: {}});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /set SAVE_LOOP_ROOT and SAVE_LOOP_BASE_URL for the isolated SL-1 stack/);
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
    for (const file of [report.video, report.audio, report.image]) assert.ok(fs.statSync(file).size > 0);
    for (const file of [report.video, report.image]) {
      const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
        'stream=width,height', '-of', 'csv=s=x:p=0', file], {encoding: 'utf8'});
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(probe.stdout.trim(), '16x16');
    }
    assert.equal(new Set(report.object_ids).size, 3);
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

test('film fixture minimum is enforced before creating media', () => {
  const shape = filmFixtureShape(23);
  assert.equal(shape.shots.length, 2);
  assert.equal(shape.shots[0].children.length, 11);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'film-minimum-test-'));
  try {
    const builder = fileURLToPath(new URL('./build-fixture.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [builder, '--variant', 'film-shaped', '--clips', '22', '--prepare-media'],
      {encoding: 'utf8', env: {PATH: process.env.PATH, SAVE_LOOP_SCRATCH: scratch}});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /minimum.*23/i);
    assert.deepEqual(fs.readdirSync(scratch), []);
  } finally { fs.rmSync(scratch, {recursive: true, force: true}); }
});

test('film media budget follows shape duration and constrains both videos', async () => {
  const {filmMediaCommands, filmMediaDurations} = await import('./film-shape.mjs');
  for (const [count, expected] of [[23, 192], [621, 90]]) {
    const durations = filmMediaDurations(filmFixtureShape(count));
    assert.equal(durations.videoDuration, expected);
    const commands = filmMediaCommands({width: 1280, height: 720}, 'a.mp4', 'a.wav', 'a.png', 'b.mp4', 'b.png', durations.audioDuration, durations.videoDuration);
    for (const command of [commands[0], commands[3]]) {
      const bitrate = Number(command[command.indexOf('-maxrate') + 1]);
      assert.ok(bitrate > 0 && bitrate * expected / 8 <= 48 * 1024 ** 2);
      assert.ok(command.includes('-bufsize'));
    }
  }
});

test('generated media precheck enforces the import margin per file', async () => {
  const {checkFilmMediaSizes} = await import('./film-shape.mjs');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'film-budget-test-'));
  try {
    const small = path.join(scratch, 'small');
    const large = path.join(scratch, 'large');
    fs.writeFileSync(small, 'ok');
    fs.writeFileSync(large, '');
    fs.truncateSync(large, 60 * 1024 ** 2);
    assert.doesNotThrow(() => checkFilmMediaSizes([small, large]));
    fs.truncateSync(large, 60 * 1024 ** 2 + 1);
    assert.throws(() => checkFilmMediaSizes([small, large]), /large.*64 MiB.*4 MiB/);
  } finally { fs.rmSync(scratch, {recursive: true, force: true}); }
});

test('generated small film videos retain the required duration under the import margin', async () => {
  const {filmMediaCommands, filmMediaDurations, checkFilmMediaSizes} = await import('./film-shape.mjs');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'film-duration-test-'));
  try {
    for (const count of [23, 621]) {
      const {audioDuration, videoDuration} = filmMediaDurations(filmFixtureShape(count));
      const video = path.join(scratch, `${count}.mp4`);
      const commands = filmMediaCommands({width: 320, height: 180}, video, 'unused.wav', 'unused.png', undefined, undefined, audioDuration, videoDuration);
      const encode = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...commands[0]], {encoding: 'utf8'});
      assert.equal(encode.status, 0, encode.stderr);
      checkFilmMediaSizes([video]);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', video], {encoding: 'utf8'});
      assert.equal(probe.status, 0, probe.stderr);
      assert.ok(Math.abs(Number(probe.stdout) - videoDuration) < 0.1);
    }
  } finally { fs.rmSync(scratch, {recursive: true, force: true}); }
});

test('film videos have a sub-10 MiB duration-based rate budget and short GOP', async () => {
  const {filmMediaCommands, filmMediaDurations} = await import('./film-shape.mjs');
  for (const count of [23, 621]) {
    const {audioDuration, videoDuration} = filmMediaDurations(filmFixtureShape(count));
    const commands = filmMediaCommands({width: 1280, height: 720}, 'a.mp4', 'a.wav', 'a.png', 'b.mp4', 'b.png', audioDuration, videoDuration);
    for (const command of [commands[0], commands[3]]) {
      const rate = Number(command[command.indexOf('-maxrate') + 1]);
      assert.ok(rate * videoDuration / 8 <= 8 * 1024 ** 2);
      assert.equal(command[command.indexOf('-g') + 1], '15');
    }
  }
});

test('default-resolution film videos stay under 10 MiB with every frame', async () => {
  const {filmMediaCommands, filmMediaDurations} = await import('./film-shape.mjs');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'film-default-budget-test-'));
  try {
    for (const count of [23, 621]) {
      const {audioDuration, videoDuration} = filmMediaDurations(filmFixtureShape(count));
      const video = path.join(scratch, `${count}.mp4`);
      const [command] = filmMediaCommands({width: 1280, height: 720}, video, 'unused.wav', 'unused.png', undefined, undefined, audioDuration, videoDuration);
      const encode = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...command], {encoding: 'utf8'});
      assert.equal(encode.status, 0, encode.stderr);
      assert.ok(fs.statSync(video).size < 10 * 1024 ** 2);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
        'stream=width,height,r_frame_rate,nb_read_frames,duration', '-of', 'json', video], {encoding: 'utf8'});
      assert.equal(probe.status, 0, probe.stderr);
      const stream = JSON.parse(probe.stdout).streams[0];
      assert.equal(stream.width, 1280);
      assert.equal(stream.height, 720);
      assert.equal(stream.r_frame_rate, '15/1');
      assert.equal(Number(stream.nb_read_frames), videoDuration * 15);
      assert.ok(Math.abs(Number(stream.duration) - videoDuration) < 0.1);
    }
  } finally { fs.rmSync(scratch, {recursive: true, force: true}); }
});

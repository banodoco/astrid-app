import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { test } from 'node:test';
import { generatePlayableVideo, PARITY_FPS, PARITY_HEIGHT, PARITY_WIDTH, readFrameMarker } from './media';

const exec = promisify(execFile);

test('deterministic VP8 source passes ffprobe and decodes unique exact-frame markers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frame-parity-source-test-'));
  try {
    const source = await generatePlayableVideo(directory);
    const again = await generatePlayableVideo(directory);
    assert.equal(source.id, again.id);
    for (const [index, frame] of source.metadata.frames.entries()) {
      const clock = index / PARITY_FPS;
      assert.ok(Number(frame.pts_time) <= clock, `source frame ${index} must start by its nominal seek`);
      assert.ok(clock < Number(source.metadata.frames[index + 1]?.pts_time ?? source.metadata.format.duration));
    }
    for (const frame of [0, 1, 15, 23, 44]) {
      const { stdout } = await exec('ffmpeg', [
        '-v', 'error', '-i', source.path, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
      ], { encoding: 'buffer', maxBuffer: PARITY_WIDTH * PARITY_HEIGHT * 3 + 1024 });
      assert.equal(stdout.length, PARITY_WIDTH * PARITY_HEIGHT * 3);
      assert.equal(readFrameMarker(stdout), frame);
    }
    console.log('PLAYABLE_SOURCE', source.id, JSON.stringify(source.metadata));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('empty or unmarked media cannot prove requested frame readiness', () => {
  assert.equal(readFrameMarker(new Uint8Array()), null);
  assert.equal(readFrameMarker(new Uint8Array(PARITY_WIDTH * 48 * 3)), null);
  assert.equal(readFrameMarker(new Uint8Array(PARITY_WIDTH * 48 * 3).fill(128)), null);
});

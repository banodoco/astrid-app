import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Page, TestInfo } from '@playwright/test';
import { capturePlayerFrame, decodeExportFrame, decodePlayerCapture } from './frames';
import { assertFrameWithinBound, compareRgbFrames } from './compare';
import { NORMAL_PROFILE_NATIVE1920 } from './canvas';
import { PARITY_HEIGHT, PARITY_WIDTH } from './media';

const exec = promisify(execFile);
const NATIVE_WIDTH = 1920;
const NATIVE_HEIGHT = 1080;

// Stop at the existing Player-ref inspection: these tests exercise capture
// preparation only, without a browser, replacement pixels or decoder stubs.
const playerInspection = new Error('actual Player-ref inspection reached');

test('decodes generated native-size PNG and lossless video before comparator rejects oversized frames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frame-parity-native-decode-test-'));
  const png = join(directory, 'native.png');
  const video = join(directory, 'native-lossless.mkv');
  try {
    await exec('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${NATIVE_WIDTH}x${NATIVE_HEIGHT}:rate=1`,
      '-frames:v', '1', png,
    ]);
    await exec('ffmpeg', [
      '-v', 'error', '-y', '-loop', '1', '-i', png, '-frames:v', '1',
      '-c:v', 'ffv1', '-pix_fmt', 'rgb24', video,
    ]);

    const player = await decodePlayerCapture(png);
    const exported = await decodeExportFrame(video, 0);
    assert.deepEqual({ width: player.width, height: player.height }, { width: NATIVE_WIDTH, height: NATIVE_HEIGHT });
    assert.deepEqual({ width: exported.width, height: exported.height }, { width: NATIVE_WIDTH, height: NATIVE_HEIGHT });
    assert.equal(player.bytes.length, NATIVE_WIDTH * NATIVE_HEIGHT * 3);
    assert.deepEqual(player.bytes, exported.bytes);
    assertFrameWithinBound(compareRgbFrames(player, exported, 0, NORMAL_PROFILE_NATIVE1920), NORMAL_PROFILE_NATIVE1920);

    const parityFrame = { width: PARITY_WIDTH, height: PARITY_HEIGHT, bytes: Buffer.alloc(PARITY_WIDTH * PARITY_HEIGHT * 3) };
    assert.throws(() => compareRgbFrames(player, parityFrame, 0), /invalid Player RGB frame dimensions\/bytes/);
    assert.throws(() => compareRgbFrames(parityFrame, exported, 0), /invalid export RGB frame dimensions\/bytes/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function pageWithRenderResult({ open = true, closeFailure = false, lingeringBackdrop = false } = {}) {
  const events: string[] = [];
  let backdrop = open;
  const dialog = {
    isVisible: async () => open,
    getByRole: (role: string, options: unknown) => {
      assert.equal(role, 'button');
      assert.deepEqual(options, { name: 'Close', exact: true });
      return { click: async () => {
        events.push('close');
        if (closeFailure) throw new Error('Close failed');
        open = false;
        backdrop = lingeringBackdrop;
      } };
    },
    waitFor: async (options: unknown) => {
      assert.deepEqual(options, { state: 'detached' });
      assert.equal(open, false);
      events.push('dialog detached');
    },
  };
  const page = {
    getByRole: (role: string, options: unknown) => {
      assert.equal(role, 'dialog');
      assert.deepEqual(options, { name: 'Rendered film', exact: true });
      return dialog;
    },
    locator: (selector: string) => {
      assert.equal(selector, '[data-dialog-backdrop]');
      return { waitFor: async (options: unknown) => {
        assert.deepEqual(options, { state: 'detached' });
        if (backdrop) throw new Error('Backdrop still covers Player');
        events.push('backdrop detached');
      } };
    },
    evaluate: async () => {
      if (open || backdrop) throw new Error('Rendered film obscures actual Player');
      events.push('inspect Player');
      throw playerInspection;
    },
  } as unknown as Page;
  return { page, events };
}

test('dismisses the completed render and waits for its backdrop before inspecting the actual Player', async () => {
  const { page, events } = pageWithRenderResult();
  await assert.rejects(capturePlayerFrame(page, 0, {} as TestInfo, 'positive'), error => error === playerInspection);
  assert.deepEqual(events, ['close', 'dialog detached', 'backdrop detached', 'inspect Player']);
});

test('keeps fixture-only captures on the existing Player path when no result dialog is open', async () => {
  const { page, events } = pageWithRenderResult({ open: false });
  await assert.rejects(capturePlayerFrame(page, 0, {} as TestInfo, 'fixture'), error => error === playerInspection);
  assert.deepEqual(events, ['backdrop detached', 'inspect Player']);
});

test('does not inspect or capture the Player if normal dialog dismissal fails', async () => {
  const { page, events } = pageWithRenderResult({ closeFailure: true });
  await assert.rejects(capturePlayerFrame(page, 0, {} as TestInfo, 'positive'), /Close failed/);
  assert.deepEqual(events, ['close']);
});

test('does not inspect or capture the Player while the closing backdrop remains', async () => {
  const { page, events } = pageWithRenderResult({ lingeringBackdrop: true });
  await assert.rejects(capturePlayerFrame(page, 0, {} as TestInfo, 'positive'), /Backdrop still covers Player/);
  assert.deepEqual(events, ['close', 'dialog detached']);
});

test('propagates a failed native probe instead of accepting partial frame bytes', async () => {
  await assert.rejects(decodePlayerCapture('/no-such-parity-input.png'), /ffprobe/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertFrameWithinBound, compareRgbFrames, formatTerminalTaskFailure, type RgbFrame } from './compare';
import { PARITY_HEIGHT, PARITY_WIDTH } from './media';

function image(): RgbFrame {
  return { width: PARITY_WIDTH, height: PARITY_HEIGHT, bytes: Buffer.alloc(PARITY_WIDTH * PARITY_HEIGHT * 3, 64) };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    task_id: 'task-render-1', attempt_id: 'attempt-render-1', state: 'running', result: null,
    ...overrides,
  } as Parameters<typeof formatTerminalTaskFailure>[0];
}

test('planted terminal task failure fails with bounded fields and no executor message', () => {
  const diagnostic = formatTerminalTaskFailure(task({
    state: 'failed',
    result: {
      error: {
        type: 'BundleError', location: 'render.bundle', code: 'module_not_found',
        message: 'secret /home/user/project and raw stderr must never be shown',
        stderr: 'secret stderr /var/lib/renderer',
        path: '/var/lib/renderer/bundle.js',
      },
      input_body: { token: 'secret', inputs: ['/var/lib/renderer/input.json'] },
    },
  }));
  assert.equal(diagnostic, 'Render task terminal failure: task_id=task-render-1 attempt_id=attempt-render-1 error_type=BundleError error_location=render.bundle code=module_not_found');
  assert.doesNotMatch(diagnostic ?? '', /secret|home|stderr|token|message|renderer|var|input/);
  assert.equal(formatTerminalTaskFailure(task({
    task_id: '/tmp/task', attempt_id: 'attempt\n', state: 'failed', result: {
      error: { code: 'C:/secret', location: '/home/user/project', message: 'Module not found' },
    },
  })), 'Render task terminal failure: task_id=unknown attempt_id=unknown error_type=unknown error_location=unknown code=task_failed');
});

test('successful task remains on the existing completion path', () => {
  assert.equal(formatTerminalTaskFailure(task({ state: 'succeeded', result: { outputs: [] } })), null);
});

test('cancelled task fails with the bounded cancellation code', () => {
  assert.equal(formatTerminalTaskFailure(task({ state: 'cancelled', result: { error: { message: 'cancelled by secret input' } } })),
    'Render task terminal failure: task_id=task-render-1 attempt_id=attempt-render-1 error_type=unknown error_location=unknown code=task_cancelled');
});

test('same comparator accepts baseline then rejects an opaque one-host patch with pixel metric', () => {
  const reference = image();
  const player = image();
  assertFrameWithinBound(compareRgbFrames(player, reference, 52));
  player.bytes.fill(255, 0, 30 * 30 * 3);
  assert.throws(() => assertFrameWithinBound(compareRgbFrames(player, reference, 52)), /900\/230400 pixels exceed 2\/255; max channel error=191\/255/);
  assert.equal(reference.bytes.every(value => value === 64), true);
});

test('strict RGB threshold and 0.1 percent boundary remain unchanged', () => {
  const reference = image();
  const player = image();
  player.bytes.fill(66);
  assertFrameWithinBound(compareRgbFrames(player, reference, 0));
  for (let pixel = 0; pixel < 230; pixel++) player.bytes[pixel * 3] = 67;
  assertFrameWithinBound(compareRgbFrames(player, reference, 0));
  player.bytes[230 * 3] = 67;
  assert.throws(() => assertFrameWithinBound(compareRgbFrames(player, reference, 0)), /231\/230400 pixels exceed 2\/255/);
});

test('rejects empty, truncated, extra and wrong-dimension images on either host', () => {
  const invalid = [
    { width: 0, height: 0, bytes: Buffer.alloc(0) },
    { ...image(), bytes: Buffer.alloc(1) },
    { ...image(), bytes: Buffer.alloc(PARITY_WIDTH * PARITY_HEIGHT * 3 + 1) },
    { ...image(), width: 360, height: 640 },
  ];
  for (const frame of invalid) {
    assert.throws(() => compareRgbFrames(frame, image(), 0), /invalid Player RGB frame/);
    assert.throws(() => compareRgbFrames(image(), frame, 0), /invalid export RGB frame/);
  }
});

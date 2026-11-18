import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { it } from 'node:test';
import vm from 'node:vm';

// Execute the installed runner's function, not a second implementation of it.
const require = createRequire(import.meta.url);
const file = path.join(path.dirname(require.resolve('@vitest/runner/package.json')), 'dist/chunk-artifact.js');
const source = readFileSync(file, 'utf8');
const start = source.indexOf('function throttle(fn, ms) {');
const end = source.indexOf('// throttle based on summary reporter', start);
assert.ok(start >= 0 && end > start, 'installed Vitest task-update throttle must be present');

function runnerClock() {
  let now = 1000;
  let nextTimer = 1;
  const timers = new Map();
  const sent = [];
  const throttle = vm.runInNewContext(`${source.slice(start, end)}; throttle`, {
    unixNow: () => now,
    setTimeout: (callback) => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const update = throttle((event) => sent.push(event), 100);
  update('initial');
  now = 1001;
  update('finished test');
  return {
    sent, timers,
    fire(at) {
      now = at;
      const [id, callback] = [...timers][0];
      timers.delete(id); // A timer is expired before its callback executes.
      callback();
    },
  };
}

it('flushes a completed task when the installed runner timer fires at exactly 100ms', () => {
  const runner = runnerClock();
  runner.fire(1100);
  assert.deepEqual(runner.sent, ['initial', 'finished test']);
  assert.equal(runner.timers.size, 0);
});

it('reschedules an early timer instead of retaining an expired handle', () => {
  const runner = runnerClock();
  runner.fire(1099);
  assert.deepEqual(runner.sent, ['initial']);
  assert.equal(runner.timers.size, 1);
  runner.fire(1199);
  assert.deepEqual(runner.sent, ['initial', 'finished test']);
  assert.equal(runner.timers.size, 0);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertCurrent014Gate3Result, assertCurrent014Gate3Selection, checkRuntimeLock, checkRuntimeProducerManifest,
  CURRENT014_GATE3, CURRENT014_GATE3_CASE,
} from './current014-gate3.mjs';

const testSource = readFileSync(new URL('../../tests/e2e/local/three-products.spec.ts', import.meta.url), 'utf8');
const appRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const runtimeProducer = process.env.TIMELINE_CURRENT014_GATE3_RUNTIME_PRODUCER_CHECKOUT
  ?? '/home/user/work/wt/rt-pin-95bd3c5f';
const agentRoot = process.env.ASTRID_CHECKOUT ?? '/home/user/work/wt/agt-pin-6efc8150';
const agentPython = process.env.ASTRID_PYTHON ?? '/home/user/work/venv-agent/bin/python';
const runtimePython = process.env.ASTRID_RUNTIME_PYTHON ?? '/home/user/work/venv-runtime/bin/python';
const RETAINED_EXECUTOR_OUTPUT = [
  '> vite_react_shadcn_ts@0.0.0 test:e2e:three-products',
  `> playwright test --config playwright.three-products.config.ts --grep ${CURRENT014_GATE3_CASE.grep}`,
  `  ✓  1 tests/e2e/local/three-products.spec.ts:2248:1 › ${CURRENT014_GATE3_CASE.fullTitle} (24.3s)`,
  '  1 passed (1.8m)',
].join('\n');

test('pins the current014 tuple, public Composition13, and exact one-case argv', () => {
  assert.equal(CURRENT014_GATE3.agent.commit, '6efc81500a0e0688c2bb41e736503f0fc3e04abb');
  assert.equal(CURRENT014_GATE3.agent.tree, '2ed2b8a12b5b3391ca221ba6ff05390f71a73556');
  assert.equal(CURRENT014_GATE3.runtime.commit, '95bd3c5f6d00e9bc8cc8cbe5ef510b68ed660f3c');
  assert.equal(CURRENT014_GATE3.runtime.artifactCount, 76);
  assert.equal(CURRENT014_GATE3.vendor.commit, '091aa23ec83ea05ffd3b0115a640230d51c8c429');
  assert.equal(CURRENT014_GATE3.vendor.tree, 'e3ae90fe482ba6cad6c3f94069127faf76ebceb6');
  assert.equal(CURRENT014_GATE3.composition.fileCount, 77);
  assert.equal(CURRENT014_GATE3_CASE.grep, '^.*M2 native None single:');
  assert.equal(CURRENT014_GATE3_CASE.fullTitle, 'M2 native None single: ordinary default crossfade clears raw mirrors, reloads, retries exactly after restart and undoes through Runtime');
  assert.deepEqual(CURRENT014_GATE3_CASE.argv, [
    'run', 'test:e2e:three-products', '--', '--grep', '^.*M2 native None single:',
  ]);
});

test('discovers exactly the existing native-None single case in source', () => {
  const cases = [...testSource.matchAll(/nativeNoneTest\('([^']+)'/g)].map((match) => match[1]);
  assert.equal(cases.filter((title) => title === CURRENT014_GATE3_CASE.fullTitle).length, 1);
  assert.match(testSource, /expectFreshPreviewUnavailable/);
});

test('the exact child argv accepts one real listing and rejects zero, multiple, or wrong-file listings', () => {
  assert.deepEqual([...CURRENT014_GATE3_CASE.argv, '--list'], [
    'run', 'test:e2e:three-products', '--', '--grep', '^.*M2 native None single:', '--list',
  ]);
  const listed = `Listing tests:\n  three-products.spec.ts:2248:1 › ${CURRENT014_GATE3_CASE.fullTitle}\nTotal: 1 test in 1 file`;
  assert.doesNotThrow(() => assertCurrent014Gate3Selection(0, listed));
  const zero = 'Error: No tests found\nListing tests:\nTotal: 0 tests in 0 files';
  assert.throws(() => assertCurrent014Gate3Selection(1, zero), /--list selection/);
  const multiple = `Listing tests:\n  three-products.spec.ts:2248:1 › ${CURRENT014_GATE3_CASE.fullTitle}\n  three-products.spec.ts:2250:1 › ${CURRENT014_GATE3_CASE.fullTitle}\nTotal: 2 tests in 1 file`;
  assert.throws(() => assertCurrent014Gate3Selection(0, multiple), /--list selected 2 tests/);
  const wrongFile = `Listing tests:\n  unrelated.spec.ts:1:1 › ${CURRENT014_GATE3_CASE.fullTitle}\nTotal: 1 test in 1 file`;
  assert.throws(() => assertCurrent014Gate3Selection(0, wrongFile), /--list selected 1 tests/);
});

test('checks the real App and Agent locks through their normal producer checkers', () => {
  assert.doesNotThrow(() => checkRuntimeLock(appRoot, 'App', runtimeProducer));
  assert.doesNotThrow(() => checkRuntimeLock(agentRoot, 'Agent', runtimeProducer, agentPython));
  assert.doesNotThrow(() => checkRuntimeProducerManifest(runtimeProducer, runtimePython));
});

test('rejects swapped consumer/source roles before any Gate3 child launch', () => {
  assert.throws(
    () => checkRuntimeLock(appRoot, 'App', agentRoot),
    /vendor-lock check failed/,
  );
  assert.throws(
    () => checkRuntimeLock(agentRoot, 'Agent', appRoot, agentPython),
    /vendor-lock check failed/,
  );
});

test('counts the retained executor result instead of the npm command echo', () => {
  assert.doesNotThrow(() => assertCurrent014Gate3Result(0, RETAINED_EXECUTOR_OUTPUT));
});

test('rejects zero, multiple, wrong-file, wrong-title, failing, or expected-failure results', () => {
  const actual = `  ✓  1 tests/e2e/local/three-products.spec.ts:2248:1 › ${CURRENT014_GATE3_CASE.fullTitle} (24.3s)`;
  for (const output of [
    'No tests found',
    '  1 passed (1.2s)',
    `${actual}\n${actual}\n2 passed`,
    `  ✓  1 tests/e2e/local/unrelated.spec.ts:1:1 › ${CURRENT014_GATE3_CASE.fullTitle} (1ms)\n1 passed`,
    `  ✓  1 tests/e2e/local/three-products.spec.ts:2248:1 › M2 native None single: wrong title (1ms)\n1 passed`,
    `  ✘  1 tests/e2e/local/three-products.spec.ts:2248:1 › ${CURRENT014_GATE3_CASE.fullTitle} (1ms)\n1 failed`,
    `${actual}\n1 passed\n1 expected failure`,
  ]) assert.throws(() => assertCurrent014Gate3Result(0, output));
});

test('preserves a real executor failure instead of upgrading it from flags', () => {
  assert.doesNotThrow(() => assertCurrent014Gate3Result(7, 'M2 native None single:\n1 failed'));
});

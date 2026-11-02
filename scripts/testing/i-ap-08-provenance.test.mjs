import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyBuildIdentity } from './i-ap-08-build-identity.mjs';

const runner = readFileSync(new URL('./run-i-ap-08-real-bridge.sh', import.meta.url));

test('runner binds a clean merge HEAD and refuses caller builds', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'iap08-provenance-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'proof@example.invalid');
    git('config', 'user.name', 'Proof');
    mkdirSync(path.join(root, 'scripts/testing'), { recursive: true });
    writeFileSync(path.join(root, 'scripts/testing/runner.sh'), runner);
    writeFileSync(path.join(root, 'base'), 'base');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    git('switch', '-qc', 'side');
    writeFileSync(path.join(root, 'side'), 'side');
    git('add', '.');
    git('commit', '-qm', 'side');
    git('switch', '-q', '-');
    writeFileSync(path.join(root, 'main'), 'main');
    git('add', '.');
    git('commit', '-qm', 'main');
    git('merge', '-q', '--no-ff', 'side', '-m', 'merge');
    const head = git('rev-parse', 'HEAD');
    assert.equal(git('rev-list', '--parents', '-n', '1', head).split(' ').length, 3);
    const invoke = (extra = {}) => spawnSync('bash', ['scripts/testing/runner.sh'], {
      cwd: root, encoding: 'utf8', env: {
        ...process.env, I_AP_08_TASK_DIR: root, I_AP_08_RUNTIME_SOURCE: root,
        I_AP_08_AGENT_SOURCE: root, I_AP_08_APP_SHA: head, ...extra,
      },
    });
    const accepted = invoke();
    assert.equal(accepted.status, 65);
    assert.match(accepted.stderr, /Runtime source HEAD/); // App gate passed for the merge.
    const mismatch = invoke({ I_AP_08_APP_SHA: base });
    assert.equal(mismatch.status, 65);
    assert.match(mismatch.stderr, /App HEAD does not match/);
    for (const input of ['I_AP_08_APP_DIST', 'ASTRID_APP_DIRECT_DIST']) {
      const external = invoke({ [input]: root });
      assert.equal(external.status, 65);
      assert.match(external.stderr, /Caller-supplied App dist/);
    }
    writeFileSync(path.join(root, 'base'), 'changed');
    const dirty = invoke();
    assert.equal(dirty.status, 65);
    assert.match(dirty.stderr, /checkout must be clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hosted build identity must match the exact source commit', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'iap08-build-'));
  try {
    const build = path.join(root, 'build.json');
    const head = 'a'.repeat(40);
    writeFileSync(build, JSON.stringify({ app: head }));
    assert.doesNotThrow(() => verifyBuildIdentity(head, build));
    assert.throws(() => verifyBuildIdentity('b'.repeat(40), build), /does not match/);
    writeFileSync(build, JSON.stringify({ app: 'b'.repeat(40) }));
    assert.throws(() => verifyBuildIdentity(head, build), /does not match/);
    writeFileSync(build, '{}');
    assert.throws(() => verifyBuildIdentity(head, build), /does not match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

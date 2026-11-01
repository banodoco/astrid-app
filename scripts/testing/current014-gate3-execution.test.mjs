import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { after, mock, test } from 'node:test';
import { execFileSync as hostExecFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import {
  CURRENT014_GATE3, CURRENT014_GATE3_CASE, runCurrent014Gate3,
} from './current014-gate3.mjs';

const appRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const scratch = mkdtempSync(path.join(os.tmpdir(), 'current014-gate3-execution-'));
const graph = path.join(scratch, 'graph');
const graphNodeModules = path.join(graph, 'node_modules');
const composition = path.join(graphNodeModules, '@banodoco', 'timeline-composition');
const archive = path.join(appRoot, 'vendor/artifacts', CURRENT014_GATE3.composition.archive);
const appSha = 'a'.repeat(40);
const appTree = 'b'.repeat(40);
const agentRoot = '/home/user/work/wt/agt-pin-6efc8150';
const runtimeRoot = '/home/user/work/wt/rt-pin-95bd3c5f';
const vendorRoot = '/home/user/work/wt/agt-pin-091aa23e';
const appKeeper = path.join(scratch, 'app-keeper');
const ready = path.join(scratch, 'graph.ready');
const lease = path.join(scratch, 'graph.lease');

mkdirSync(graphNodeModules, { recursive: true });
try {
  hostExecFileSync('tar', ['-xzf', archive, '-C', scratch]);
} catch (error) {
  if (error.status !== 0) throw error;
}
mkdirSync(path.dirname(composition), { recursive: true });
renameSync(path.join(scratch, 'package'), composition);
mkdirSync(appKeeper);
writeFileSync(ready, 'READY\n');
writeFileSync(lease, `status=READY\ngraph=${graphNodeModules}\narchive_sha256=${CURRENT014_GATE3.composition.sha256.slice('sha256:'.length)}\n`);

after(() => rmSync(scratch, { recursive: true, force: true }));

function controlledGate3(fn) {
  const previousEnv = { ...process.env };
  const previousArgv = process.argv;
  const previousExitCode = process.exitCode;
  const calls = [];
  const originalExecFileSync = childProcess.execFileSync;
  const identities = new Map([
    [appRoot, { commit: appSha, tree: appTree }],
    [appKeeper, { commit: appSha, tree: appTree }],
    [agentRoot, CURRENT014_GATE3.agent],
    [runtimeRoot, CURRENT014_GATE3.runtime],
    [vendorRoot, CURRENT014_GATE3.vendor],
  ]);
  const gateEnv = {
    TIMELINE_CURRENT014_GATE3_RUN: '1',
    TIMELINE_CURRENT014_GATE3_MANAGER_APPROVED: '1',
    TIMELINE_CURRENT014_GATE3_CURRENT_FULL_TERMINAL: '1',
    TIMELINE_CURRENT014_GATE3_APP_SHA: appSha,
    TIMELINE_CURRENT014_GATE3_APP_TREE: appTree,
    TIMELINE_CURRENT014_GATE3_AGENT_SHA: CURRENT014_GATE3.agent.commit,
    TIMELINE_CURRENT014_GATE3_RUNTIME_SHA: CURRENT014_GATE3.runtime.commit,
    ASTRID_CHECKOUT: agentRoot,
    ASTRID_RUNTIME_CHECKOUT: runtimeRoot,
    TIMELINE_CURRENT014_GATE3_RUNTIME_PRODUCER_CHECKOUT: runtimeRoot,
    TIMELINE_CURRENT014_GATE3_VENDOR_SOURCE_CHECKOUT: vendorRoot,
    TIMELINE_CURRENT014_GATE3_APP_KEEPER: appKeeper,
    ASTRID_PYTHON: '/home/user/work/venv-agent/bin/python',
    ASTRID_RUNTIME_PYTHON: '/home/user/work/venv-runtime/bin/python',
    TIMELINE_CURRENT014_GATE3_GRAPH_NODE_MODULES: graphNodeModules,
    TIMELINE_CURRENT014_GATE3_GRAPH_READY: ready,
    TIMELINE_CURRENT014_GATE3_GRAPH_LEASE: lease,
  };
  Object.assign(process.env, gateEnv);
  delete process.env.ASTRID_APP_DIRECT_DIST;
  process.argv = [process.execPath, path.join(appRoot, 'scripts/testing/current014-gate3.mjs')];
  mock.method(process, 'cwd', () => appRoot);
  mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (command !== 'git') {
      try { return originalExecFileSync(command, args, options); }
      catch (error) { if (error.status === 0) return error.stdout; throw error; }
    }
    const root = args[1];
    const operation = args.slice(2).join(' ');
    const identity = identities.get(root);
    assert.ok(identity, `unexpected Git root: ${root}`);
    if (operation === 'rev-parse --show-toplevel') return root;
    if (operation === 'rev-parse HEAD') return identity.commit;
    if (operation === 'rev-parse HEAD^{tree}') return identity.tree;
    if (operation === 'status --porcelain --untracked-files=normal') return '';
    throw new Error(`unexpected Git operation: ${operation}`);
  });
  mock.method(childProcess, 'spawnSync', (command, args, options) => {
    calls.push({ command, args: [...args], options });
    assert.equal(command, CURRENT014_GATE3_CASE.command);
    const listing = calls.length === 1;
    return {
      status: 0,
      stdout: listing
        ? `Listing tests:\n  three-products.spec.ts:2248:1 › ${CURRENT014_GATE3_CASE.fullTitle}\nTotal: 1 test in 1 file`
        : `  ✓  1 tests/e2e/local/three-products.spec.ts:2248:1 › ${CURRENT014_GATE3_CASE.fullTitle} (1.2s)\n1 passed`,
      stderr: '',
    };
  });
  syncBuiltinESMExports();
  try {
    fn(calls);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    process.env = previousEnv;
    process.argv = previousArgv;
    process.exitCode = previousExitCode;
  }
}

test('executes the selected Gate3 case with the same original argv used by --list', () => {
  controlledGate3((calls) => {
    runCurrent014Gate3();
    assert.equal(process.exitCode, 0);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, [...CURRENT014_GATE3_CASE.argv, '--list']);
    assert.deepEqual(calls[1].args, CURRENT014_GATE3_CASE.argv);
    assert.deepEqual(calls[1].args, calls[0].args.slice(0, -1));
    assert.equal(calls[1].options.cwd, appRoot);
  });
});

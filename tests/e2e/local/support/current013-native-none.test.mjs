// Launcher controls only: no Runtime, browser, vendor subprocess or paired proof.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const launcher = new URL('../../../../scripts/testing/current013-native-none.mjs', import.meta.url);
const source = readFileSync(launcher, 'utf8');
const input = { app: '/snapshot', agent: '/retained/agent', runtime: '/retained/runtime',
  agentPython: '/venv-agent/bin/python', runtimePython: '/venv-runtime/bin/python',
  agentSha: 'a'.repeat(40), runtimeSha: 'b'.repeat(40) };

async function load({ enabled = true, status = 0, moved = false, preflightFailure = false, launchFailure = false } = {}) {
  const calls = [];
  const process = { env: enabled ? { TIMELINE_CURRENT013_RUN: '1' } : {}, argv: [], exitCode: undefined };
  const context = createContext({ process });
  const module = new SourceTextModule(source, { context, identifier: launcher.href });
  let checks = 0;
  await module.link((specifier) => {
    let exports;
    if (specifier === 'node:child_process') exports = { spawnSync: (...args) => {
      calls.push(args);
      if (launchFailure) throw new Error('child launch failed');
      return { status };
    } };
    else if (specifier === 'node:url') exports = { pathToFileURL };
    else {
      assert.equal(specifier, './current013-integration.mjs');
      exports = { readCurrent013Inputs: () => input, checkCurrent013Sources: (received) => {
        assert.equal(received, input);
        checks++;
        if (preflightFailure) throw new Error('source guard refused');
        return { tree: moved && checks > 1 ? 'changed' : 'original' };
      } };
    }
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return { run: module.namespace.runCurrent013NativeNone, process, calls, checks: () => checks };
}

test('requires explicit current-pair enablement before guards or child launch', async () => {
  const probe = await load({ enabled: false });
  assert.throws(probe.run, /manager-approved/);
  assert.equal(probe.checks(), 0);
  assert.equal(probe.calls.length, 0);
});

test('source guard refusal never delegates', async () => {
  const probe = await load({ preflightFailure: true });
  assert.throws(probe.run, /source guard refused/);
  assert.equal(probe.calls.length, 0);
});

test('delegates only the two named cases with validated identities and checks both boundaries', async () => {
  const probe = await load();
  probe.run();
  assert.equal(probe.checks(), 2);
  assert.equal(probe.calls.length, 1);
  const [command, args, options] = probe.calls[0];
  assert.equal(command, 'npm');
  assert.equal(JSON.stringify(args), JSON.stringify(['run', 'test:e2e:three-products', '--', '--grep', 'M2 native None']));
  assert.equal(options.cwd, input.app);
  assert.equal(options.shell, false);
  assert.equal(options.env.TIMELINE_BUNDLE_AGENT_HEAD, input.agentSha);
  assert.equal(options.env.TIMELINE_BUNDLE_RUNTIME_HEAD, input.runtimeSha);
  assert.equal(options.env.ASTRID_PYTHON, input.agentPython);
  assert.equal(options.env.ASTRID_RUNTIME_PYTHON, input.runtimePython);
  assert.equal(options.env.ASTRID_CHECKOUT, input.agent);
  assert.equal(options.env.ASTRID_RUNTIME_CHECKOUT, input.runtime);
  assert.equal(probe.process.exitCode, 0);
});

test('preserves child failure and treats missing child status as failure', async () => {
  for (const status of [7, null]) {
    const probe = await load({ status });
    probe.run();
    assert.equal(probe.process.exitCode, status ?? 1);
    assert.equal(probe.checks(), 2);
  }
});

test('changed postflight fingerprint fails after successful delegation', async () => {
  const probe = await load({ moved: true });
  assert.throws(probe.run, /sources changed/);
  assert.equal(probe.checks(), 2);
});

test('postflight still runs when child launch throws', async () => {
  const probe = await load({ launchFailure: true });
  assert.throws(probe.run, /child launch failed/);
  assert.equal(probe.checks(), 2);
});

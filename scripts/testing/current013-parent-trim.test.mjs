// Launcher controls only; no browser, Runtime, build or vendor subprocess is run.
import assert from 'node:assert/strict';
import { readFileSync as hostReadFileSync } from 'node:fs';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const launcher = new URL('./current013-parent-trim.mjs', import.meta.url);
const source = hostReadFileSync(launcher, 'utf8');
const input = { app: '/snapshot', appTree: 'a'.repeat(40), agent: '/retained/agent', runtime: '/retained/runtime',
  agentPython: '/venv-agent/bin/python', runtimePython: '/venv-runtime/bin/python',
  agentSha: '8130a401bf44a518d5a40ae274d398b8c560be55', runtimeSha: '2c4ac180c2220bdad966bc01e95ad230e99ce26a' };

async function load({ enabled = true, status = 0, moved = false, preflightFailure = false, launchFailure = false, cacheId, env = {} } = {}) {
  const calls = [];
  const process = { env: enabled ? { TIMELINE_CURRENT013_RUN: '1' } : {}, argv: [], exitCode: undefined, cwd: () => '/snapshot' };
  const context = createContext({ process, URL });
  const module = new SourceTextModule(source, { context, identifier: launcher.href,
    initializeImportMeta(meta) { meta.url = launcher.href; } });
  let checks = 0;
  await module.link((specifier) => {
    let exports;
    if (specifier === 'node:crypto') exports = { createHash: () => ({ update() { return this; }, digest: () => '9412ae25c306d5118241f4d631e8eecc6eef9b2fb5a98302d40938e9f6d54738' }) };
    else if (specifier === 'node:fs') exports = { readFileSync: () => Buffer.from('fixture'), accessSync() {}, constants: { X_OK: 1 }, existsSync: () => true, realpathSync: (value) => value, statSync: () => ({ isFile: () => true, isDirectory: () => true }) };
    else if (specifier === 'node:child_process') exports = { execFileSync: () => Array.from({ length: 77 }, (_, index) => `package/file${index}`).join('\n'), spawnSync: (...args) => {
      calls.push(args);
      if (launchFailure) throw new Error('child launch failed');
      return { status };
    } };
    else if (specifier === 'node:path') exports = { default: { isAbsolute: () => true, join: (...parts) => parts.join('/') } };
    else if (specifier === 'node:url') exports = { pathToFileURL };
    else {
      assert.equal(specifier, './current013-integration.mjs');
      exports = { CURRENT013_COMPOSITION: { sha256: 'sha256:composition12' }, readCurrent013Inputs: () => input,
        checkCurrent013Sources: (received) => { assert.equal(received, input); checks++; if (preflightFailure) throw new Error('source guard refused'); return moved && checks > 1 ? 'changed' : 'original'; } };
    }
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  process.env.TIMELINE_CURRENT013_PUBLIC_SOURCE_SHA256 = '9412ae25c306d5118241f4d631e8eecc6eef9b2fb5a98302d40938e9f6d54738';
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = '/browser/chrome';
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/browser';
  process.env.PRIVATE13_NODE_MODULES = '/private/node_modules';
  process.env.TIMELINE_CURRENT013_SHORT_TMPDIR = '/tmp/trim';
  Object.assign(process.env, env);
  process.env.TIMELINE_CURRENT013_CACHE_ID = cacheId ?? module.namespace.parentTrimCacheIdentity(input);
  return { run: module.namespace.runCurrent013ParentTrim, process, calls, checks: () => checks, cacheIdentity: module.namespace.parentTrimCacheIdentity };
}

test('requires explicit enablement and the literal approved Agent before delegation', async () => {
  const probe = await load({ enabled: false });
  assert.throws(probe.run, /manager-approved/);
  assert.equal(probe.calls.length, 0);
});

test('cache identity binds the App tree, pair, public13 archive, runner and helper', async () => {
  const probe = await load({ cacheId: 'old-cache' });
  assert.throws(probe.run, /CACHE_ID/);
  const expected = probe.cacheIdentity(input);
  assert.match(expected, /parent-trim-treea{40}-agent8130a401.*runtime2c4ac180.*public13-9412ae25/);
  assert.notEqual(probe.cacheIdentity({ ...input, appTree: 'b'.repeat(40) }), expected);
});

test('source guard refusal never launches the browser lane', async () => {
  const probe = await load({ preflightFailure: true });
  assert.throws(probe.run, /source guard refused/);
  assert.equal(probe.calls.length, 0);
});

test('public13, browser and private dependency guards refuse mismatched inputs', async () => {
  const publicSource = await load({ env: { TIMELINE_CURRENT013_PUBLIC_SOURCE_SHA256: 'wrong' } });
  assert.throws(publicSource.run, /public13 Composition source digest/);
  const browser = await load({ env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE: '' } });
  assert.throws(browser.run, /PLAYWRIGHT_CHROMIUM_EXECUTABLE is required/);
  const modules = await load({ env: { PRIVATE13_NODE_MODULES: '/home/user/work/app/node_modules' } });
  assert.throws(modules.run, /shared install/);
});

test('delegates only the parent-trim config and checks both source boundaries', async () => {
  const probe = await load();
  probe.run();
  assert.equal(probe.checks(), 2);
  assert.equal(probe.calls.length, 1);
  const [command, args, options] = probe.calls[0];
  assert.equal(command, 'npm');
  assert.deepEqual(Array.from(args), ['run', 'test:e2e:three-products', '--', '--config', 'playwright.parent-trim.config.ts']);
  assert.equal(options.cwd, input.app);
  assert.equal(options.shell, false);
  assert.equal(options.env.TIMELINE_BUNDLE_AGENT_HEAD, input.agentSha);
  assert.equal(options.env.TIMELINE_BUNDLE_RUNTIME_HEAD, input.runtimeSha);
});

test('propagates child failure and rejects postflight source movement', async () => {
  const failed = await load({ status: 7 });
  failed.run();
  assert.equal(failed.process.exitCode, 7);
  assert.equal(failed.checks(), 2);
  const moved = await load({ moved: true });
  assert.throws(moved.run, /source checks changed/);
  assert.equal(moved.checks(), 2);
});

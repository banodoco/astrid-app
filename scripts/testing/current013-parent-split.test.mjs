// Launcher controls only; no browser, Runtime, build or vendor subprocess is run.
import assert from 'node:assert/strict';
import { readFileSync as hostReadFileSync } from 'node:fs';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const launcher = new URL('./current013-parent-split.mjs', import.meta.url);
const source = hostReadFileSync(launcher, 'utf8');
const input = { app: '/snapshot', appSha: 'c'.repeat(40), appTree: 'a'.repeat(40), agent: '/retained/agent', agentVendor: '/retained/agent-vendor', runtime: '/retained/runtime', runtimeProducer: '/retained/producer',
  agentPython: '/venv-agent/bin/python', runtimePython: '/venv-runtime/bin/python', privateModules: '/private/node_modules', ready: '/private/READY', lease: '/private/LEASE', shortTemp: '/tmp/parent-split', config: '/config/playwright.parent-split.config.ts', browser: '/browser/chrome', credential: '/private/product-credential.json',
  agentSha: '6efc81500a0e0688c2bb41e736503f0fc3e04abb', runtimeSha: '95bd3c5f6d00e9bc8cc8cbe5ef510b68ed660f3c' };

async function load({ enabled = true, status = 0, moved = false, preflightFailure = false, launchFailure = false, cacheId,
  credential = { version: 1, scope: 'astrid', actor_id: 'app', token: 'test-token' } } = {}) {
  const calls = [];
  const process = { env: enabled ? { TIMELINE_CURRENT013_RUN: '1' } : {}, argv: [], exitCode: undefined, cwd: () => '/snapshot' };
  const context = createContext({ process, URL });
  const module = new SourceTextModule(source, { context, identifier: launcher.href, initializeImportMeta(meta) { meta.url = launcher.href; } });
  let checks = 0;
  await module.link((specifier) => {
    let exports;
    if (specifier === 'node:crypto') exports = { createHash: () => ({ update() { return this; }, digest: () => '9412ae25c306d5118241f4d631e8eecc6eef9b2fb5a98302d40938e9f6d54738' }) };
    else if (specifier === 'node:fs') exports = { readFileSync: (file) => {
      if (String(file).includes('provenance.json')) return Buffer.from(JSON.stringify({ astrid_commit: '091aa23ec83ea05ffd3b0115a640230d51c8c429', astrid_tree: 'e3ae90fe482ba6cad6c3f94069127faf76ebceb6' }));
      if (String(file).endsWith('runtime.lock.json')) return Buffer.from(JSON.stringify({ source_commit: input.runtimeSha, producer_version: 'sha256:54205b3ecb55038e416b31af936c9af26afa30dc1b05da16157ee4d861fe05ac' }));
      if (String(file).includes('product-credential.json')) return Buffer.from(JSON.stringify(credential));
      return Buffer.from(JSON.stringify({ producer: 'astrid-runtime', version: 'sha256:54205b3ecb55038e416b31af936c9af26afa30dc1b05da16157ee4d861fe05ac', artifacts: Object.fromEntries(Array.from({ length: 76 }, (_, i) => [`a${i}`, {}])) }));
    }, accessSync() {}, constants: { X_OK: 1 }, existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => false }), realpathSync: (value) => value, statSync: (file) => ({ mode: String(file).includes('product-credential.json') ? 0o600 : 0o700, isFile: () => true, isDirectory: () => true }) };
    else if (specifier === 'node:child_process') exports = { execFileSync: (command, args = []) => {
      if (command === 'git' && args[2] === 'rev-parse') {
        const root = args[1]; const tree = args[3] === 'HEAD^{tree}';
        if (tree) return root.includes('vendor') ? 'e3ae90fe482ba6cad6c3f94069127faf76ebceb6' : root.includes('agent') ? '2ed2b8a12b5b3391ca221ba6ff05390f71a73556' : root.includes('runtime') || root.includes('producer') ? 'd3a290b407fa61e6ab2d476f50c068073f70df00' : input.appTree;
        return root.includes('vendor') ? '091aa23ec83ea05ffd3b0115a640230d51c8c429' : root.includes('agent') ? input.agentSha : root.includes('runtime') || root.includes('producer') ? input.runtimeSha : input.appSha;
      }
      if (command === 'git' && args[2] === 'status') return '';
      if (command === 'tar') return Array.from({ length: 77 }, (_, i) => `package/file${i}`).join('\n');
      throw new Error(`unexpected command ${command}`);
    }, spawnSync: (...args) => { calls.push(args); const [command, argv] = args; if (command === 'npm' && argv.includes('--list')) return { status: 0, stdout: 'M2 native parent split preserves raw closure through lost ACK, restart, retry and Runtime inverse\nparent-split-command.spec.ts\nTotal: 1 test in 1 file\n', stderr: '' }; if (launchFailure && command === 'npm') throw new Error('child launch failed'); return { status: command === 'npm' ? status : 0, stdout: '', stderr: '' }; } };
    else if (specifier === 'node:path') exports = { default: { basename: (value) => String(value).split('/').pop(), dirname: (value) => String(value).split('/').slice(0, -1).join('/') || '/', isAbsolute: () => true, join: (...parts) => parts.join('/') } };
    else if (specifier === 'node:url') exports = { pathToFileURL };
    else throw new Error(`unexpected import ${specifier}`);
    return new SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
  });
  await module.evaluate();
  process.env.TIMELINE_CURRENT013_APP_SHA = input.appSha;
  process.env.TIMELINE_CURRENT013_APP_TREE = preflightFailure ? 'b'.repeat(40) : input.appTree;
  process.env.TIMELINE_CURRENT013_AGENT_SHA = input.agentSha;
  process.env.TIMELINE_CURRENT013_RUNTIME_SHA = input.runtimeSha;
  process.env.ASTRID_CHECKOUT = input.agent; process.env.ASTRID_RUNTIME_CHECKOUT = input.runtime;
  process.env.TIMELINE_CURRENT013_AGENT_VENDOR_CHECKOUT = input.agentVendor;
  process.env.TIMELINE_CURRENT013_RUNTIME_PRODUCER_CHECKOUT = input.runtimeProducer;
  process.env.ASTRID_PYTHON = input.agentPython; process.env.ASTRID_RUNTIME_PYTHON = input.runtimePython;
  process.env.PRIVATE13_NODE_MODULES = input.privateModules; process.env.TIMELINE_CURRENT013_PRIVATE13_READY = input.ready; process.env.TIMELINE_CURRENT013_PRIVATE13_LEASE = input.lease; process.env.TIMELINE_CURRENT013_SHORT_TMPDIR = input.shortTemp; process.env.TIMELINE_CURRENT013_CONFIG_PATH = input.config; process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = input.browser; process.env.WORKSPACE_RUNTIME_TOKEN_FILE = input.credential;
  process.env.TIMELINE_CURRENT013_CACHE_ID = cacheId ?? module.namespace.parentSplitCacheIdentity(input);
  return { run: module.namespace.runCurrent013ParentSplit, readInputs: () => module.namespace.readCurrent013ParentSplitInputs(), process, calls, checks: () => checks, cacheIdentity: module.namespace.parentSplitCacheIdentity };
}

test('requires explicit enablement and binds cache identity to source and pair', async () => {
  const disabled = await load({ enabled: false });
  assert.throws(disabled.run, /manager-approved/);
  const stale = await load({ cacheId: 'old-cache' });
  assert.throws(stale.run, /CACHE_ID/);
  assert.notEqual(stale.cacheIdentity({ ...input, appTree: 'b'.repeat(40) }), stale.cacheIdentity(input));
});

test('source guard refusal never launches the browser lane', async () => {
  const probe = await load({ preflightFailure: true });
  assert.throws(probe.run, /App source SHA\/tree/);
  assert.equal(probe.calls.length, 0);
});

test('accepts trimmed valid credentials and rejects forbidden or blank credentials', async () => {
  const valid = await load({ credential: { version: 1, scope: 'astrid', actor_id: ' app ', token: ' test-token ' } });
  assert.doesNotThrow(valid.readInputs);
  for (const actorId of ['owner', 'astrid-pack-host', 'admin', 'worker']) {
    const probe = await load({ credential: { version: 1, scope: 'astrid', actor_id: actorId, token: 'test-token' } });
    assert.throws(probe.readInputs, /existing Runtime product credential/);
  }
  for (const credential of [
    { version: 1, scope: 'astrid', actor_id: ' \t', token: 'test-token' },
    { version: 1, scope: 'astrid', actor_id: 'app', token: ' \n' },
  ]) {
    const probe = await load({ credential });
    assert.throws(probe.readInputs, /existing Runtime product credential/);
  }
});

test('delegates only the named parent-split config and preserves child status', async () => {
  const probe = await load();
  probe.run();
  const actual = probe.calls.find(([, args]) => args?.[0] === 'run' && args?.includes('playwright.parent-split.config.ts') && !args?.includes('--list'));
  assert.ok(actual);
  assert.equal(JSON.stringify(actual[1]), JSON.stringify(['run', 'test:e2e:three-products', '--', '--config', 'playwright.parent-split.config.ts']));
  const list = probe.calls.find(([, args]) => args?.includes('--list'));
  assert.ok(list);
  assert.equal(JSON.stringify(list[1]), JSON.stringify(['run', 'test:e2e:three-products', '--', '--config', 'playwright.parent-split.config.ts', '--list']));
  assert.equal(probe.process.exitCode, 0);
});

test('cache remains source-bound when the child fails', async () => {
  const probe = await load({ status: 7 });
  assert.equal(probe.cacheIdentity(input).includes('agent6efc8150'), true);
  assert.equal(probe.process.exitCode, undefined);
});

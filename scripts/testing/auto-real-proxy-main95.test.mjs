import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { after, test } from 'node:test';
import { createRuntimeProxyServer, readWorkspaceRuntimeConfig } from '../runtime-discovery-proxy.mjs';
import { normalAcpEnvironment, preparePrivateRunTempRoot, REAL_PROXY_RUNTIME, prepareNodeModulesOverlay, readRealProxyInputs, resolveFailureRecordRoot } from './auto-real-proxy-main95.mjs';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'auto-real-proxy-current-root-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const roots = Object.fromEntries(['app', 'agent', 'runtime', 'producer', 'deps', 'private'].map((name) => [name, path.join(scratch, name)]));
for (const root of Object.values(roots)) mkdirSync(root, { recursive: true });
const browser = path.join(scratch, 'chrome');
writeFileSync(browser, '#!/bin/sh\nprintf Chromium\n');
chmodSync(browser, 0o755);

function values() {
  return {
    TIMELINE_AUTO_REAL_PROXY_APP_SHA: 'a'.repeat(40),
    TIMELINE_AUTO_REAL_PROXY_APP_TREE: 'b'.repeat(40),
    TIMELINE_AUTO_REAL_PROXY_AGENT_SHA: 'c'.repeat(40),
    TIMELINE_AUTO_REAL_PROXY_AGENT_TREE: 'd'.repeat(40),
    TIMELINE_AUTO_REAL_PROXY_RUNTIME_SHA: REAL_PROXY_RUNTIME.commit,
    TIMELINE_AUTO_REAL_PROXY_RUNTIME_TREE: REAL_PROXY_RUNTIME.tree,
    TIMELINE_AUTO_REAL_PROXY_RUNNER_SHA256: 'sha256:' + 'e'.repeat(64),
    ASTRID_CHECKOUT: roots.agent,
    ASTRID_RUNTIME_CHECKOUT: roots.runtime,
    TIMELINE_AUTO_REAL_PROXY_RUNTIME_PRODUCER_CHECKOUT: roots.producer,
    TIMELINE_AUTO_REAL_PROXY_DEPENDENCY_ROOT: roots.deps,
    TIMELINE_AUTO_REAL_PROXY_PRIVATE_ROOT: roots.private,
    ASTRID_PYTHON: process.execPath,
    ASTRID_RUNTIME_PYTHON: process.execPath,
    PLAYWRIGHT_CHROMIUM_EXECUTABLE: browser,
  };
}

test('requires every literal source, runner, dependency, and browser input', () => {
  for (const name of Object.keys(values())) {
    const input = values();
    delete input[name];
    assert.throws(() => readRealProxyInputs(input, roots.app), new RegExp(`${name} is required`));
  }
});

test('pins Runtime95 and rejects stale public/direct overrides', () => {
  assert.throws(() => readRealProxyInputs({ ...values(), TIMELINE_AUTO_REAL_PROXY_RUNTIME_SHA: 'f'.repeat(40) }, roots.app), /published Main95/);
  assert.throws(() => readRealProxyInputs({ ...values(), ASTRID_PUBLIC_CHECKOUT: roots.agent }, roots.app), /overrides are forbidden/);
  assert.throws(() => readRealProxyInputs({ ...values(), ASTRID_APP_DIRECT_DIST: path.join(scratch, 'dist') }, roots.app), /overrides are forbidden/);
});

test('runner always resolves an absolute worker-owned failure record directory', () => {
  const privateRoot = path.join(scratch, 'private-record-owner');
  const runRoot = path.join(privateRoot, 'real-proxy-123');
  assert.equal(resolveFailureRecordRoot({}, privateRoot, runRoot), path.join(privateRoot, 'recorded-evidence'));
  assert.equal(resolveFailureRecordRoot({ TIMELINE_AUTO_REAL_PROXY_RECORD_DIR: path.join(scratch, 'worker-record') }, privateRoot, runRoot), path.join(scratch, 'worker-record'));
  assert.throws(() => resolveFailureRecordRoot({ TIMELINE_AUTO_REAL_PROXY_RECORD_DIR: 'relative-record' }, privateRoot, runRoot), /absolute path/);
  assert.throws(() => resolveFailureRecordRoot({ TIMELINE_AUTO_REAL_PROXY_RECORD_DIR: runRoot }, privateRoot, runRoot), /outside the disposable run root/);
});

test('runner refuses a planted file where the private TMPDIR must be a directory', () => {
  const runRoot = path.join(scratch, 'file-as-temp-run');
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(path.join(runRoot, 'tmpdir'), 'record-file');
  assert.throws(() => preparePrivateRunTempRoot(runRoot), /private run TMPDIR must be a physical directory/);
});

test('runner creates a real private TMPDIR under the disposable run root', () => {
  const runRoot = path.join(scratch, 'physical-temp-run');
  const tempRoot = preparePrivateRunTempRoot(runRoot);
  assert.equal(statSync(tempRoot).isDirectory(), true);
  assert.equal(lstatSync(tempRoot).isSymbolicLink(), false);
  assert.equal(path.dirname(tempRoot), runRoot);
});

function normalParserFixture(overrides = {}) {
  const directory = mkdtempSync(path.join(scratch, 'normal-parser-'));
  const realm = path.join(directory, 'realm');
  mkdirSync(realm);
  const credential = path.join(directory, 'credential.json');
  const credentialValue = {
    version: 1,
    scope: 'astrid',
    actor_id: 'astrid-product-test',
    token: 'synthetic-normal-parser-token',
    ...(overrides.credential ?? {}),
  };
  for (const key of overrides.removeCredential ?? []) delete credentialValue[key];
  writeFileSync(credential, JSON.stringify(credentialValue), { mode: 0o600 });
  const discovery = path.join(directory, 'discovery.json');
  const discoveryValue = {
    endpoint: 'http://127.0.0.1:17336',
    credential_file: credential,
    active_realm: 'realm',
    runtime_instance_id: 'runtime-instance-test',
    realm_root: realm,
    ...(overrides.discovery ?? {}),
  };
  for (const key of overrides.removeDiscovery ?? []) delete discoveryValue[key];
  writeFileSync(discovery, JSON.stringify(discoveryValue), { mode: 0o600 });
  writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify({
    selected_realm_id: 'realm',
    realms: [{ realm_id: 'realm', source_profile: 'astrid', data_root: realm }],
  }), { mode: 0o600 });
  return { directory, discovery, credential, credentialValue };
}

test('normal automatic fixture parser accepts the established scoped credential file', () => {
  const fixture = normalParserFixture();
  assert.deepEqual(readWorkspaceRuntimeConfig(fixture.discovery), {
    schemaVersion: 1,
    endpoint: 'http://127.0.0.1:17336',
    actorId: 'astrid-product-test',
    realmId: 'realm',
    runtimeInstanceId: 'runtime-instance-test',
  });
  assert.equal(statSync(fixture.credential).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(fixture.credential, 'utf8')), fixture.credentialValue);
});

test('normal automatic fixture parser rejects missing or wrong product identity fields', () => {
  const cases = [
    ['missing version', { removeCredential: ['version'] }],
    ['wrong version', { credential: { version: 2 } }],
    ['missing scope', { removeCredential: ['scope'] }],
    ['wrong scope', { credential: { scope: 'owner' } }],
    ['missing token', { removeCredential: ['token'] }],
    ['missing actor', { removeCredential: ['actor_id'] }],
    ['missing discovery realm', { removeDiscovery: ['active_realm'] }],
    ['missing discovery instance', { removeDiscovery: ['runtime_instance_id'] }],
    ['missing discovery credential file', { removeDiscovery: ['credential_file'] }],
  ];
  for (const [label, overrides] of cases) {
    const fixture = normalParserFixture(overrides);
    assert.throws(() => readWorkspaceRuntimeConfig(fixture.discovery), label);
    const error = (() => {
      try { readWorkspaceRuntimeConfig(fixture.discovery); return ''; }
      catch (caught) { return caught instanceof Error ? caught.message : String(caught); }
    })();
    assert(!error.includes(fixture.credentialValue.token), `${label}: synthetic credential leaked in parser error`);
  }
});

test('automatic fixture registers the normal ACP environment and forwards the exact discovery-proxy request', async () => {
  assert.deepEqual(normalAcpEnvironment(17335), {
    VITE_ASTRID_ACP_BRIDGE_PORT: '17335',
    ASTRID_ACP_VIA_DISCOVERY_PROXY: '1',
  });
  const fixture = normalParserFixture();
  const upstreamRequests = [];
  const chatToken = 'synthetic-acp-forward-token';
  writeFileSync(path.join(fixture.directory, 'chat.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:17337', token: chatToken }), { mode: 0o600 });
  const body = Buffer.from('{"prompt":"synthetic ACP request"}');
  const upstream = new PassThrough();
  upstream.setTimeout = () => upstream;
  const upstreamResponse = Readable.from(['{"ok":true}']);
  upstreamResponse.statusCode = 200;
  upstreamResponse.headers = { 'content-type': 'application/json' };
  const proxy = createRuntimeProxyServer({
    discoveryPath: fixture.discovery,
    request(options, callback) {
      upstreamRequests.push({ options });
      process.nextTick(() => callback(upstreamResponse));
      return upstream;
    },
  });
  const incoming = Readable.from([body]);
  Object.assign(incoming, {
    method: 'POST',
    url: '/acp/projects/project-test/chat',
    headers: { host: '127.0.0.1:17338', authorization: 'Bearer browser-secret', 'x-astrid-bridge-version': 'browser-version',
      'content-type': 'application/json', 'content-length': String(body.length) },
    aborted: false,
  });
  const response = new PassThrough();
  let statusCode;
  response.writeHead = (status) => { statusCode = status; return response; };
  const responseBody = new Promise((resolve) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.once('end', () => resolve(Buffer.concat(chunks)));
  });
  const upstreamBody = new Promise((resolve) => {
    const chunks = [];
    upstream.on('data', (chunk) => chunks.push(chunk));
    upstream.once('end', () => resolve(Buffer.concat(chunks)));
  });
  proxy.emit('request', incoming, response);
  assert.deepEqual(await responseBody, Buffer.from('{"ok":true}'));
  assert.equal(statusCode, 200);
  assert.equal(upstreamRequests.length, 1);
  const forwarded = upstreamRequests[0].options;
  assert.equal(forwarded.method, 'POST');
  assert.equal(forwarded.path, '/projects/project-test/chat');
  assert.equal(forwarded.headers.authorization, `Bearer ${chatToken}`);
  assert.equal(forwarded.headers['x-astrid-bridge-version'], 'v1');
  assert.equal(forwarded.headers['content-type'], 'application/json');
  assert.equal(forwarded.headers.host, undefined);
  assert.deepEqual(await upstreamBody, body);
});

test('overlay copies Vite and Rollup resolvers while linking the rest read-only', () => {
  const source = path.join(scratch, 'overlay-deps');
  const app = path.join(scratch, 'overlay-app');
  const privateRoot = path.join(scratch, 'overlay-private');
  mkdirSync(path.join(source, 'vite'), { recursive: true });
  mkdirSync(path.join(source, 'rollup'), { recursive: true });
  mkdirSync(path.join(source, '@rollup', 'plugin'), { recursive: true });
  writeFileSync(path.join(source, 'vite', 'package.json'), '{}');
  writeFileSync(path.join(source, 'rollup', 'package.json'), '{}');
  writeFileSync(path.join(source, '@rollup', 'plugin', 'package.json'), '{}');
  mkdirSync(app, { recursive: true });
  mkdirSync(privateRoot, { recursive: true });
  const shared = path.join(scratch, 'shared-node-modules');
  mkdirSync(shared, { recursive: true });
  symlinkSync(shared, path.join(app, 'node_modules'), 'junction');
  const restore = prepareNodeModulesOverlay(app, source, privateRoot);
  try {
    assert.equal(lstatSync(path.join(app, 'node_modules/vite')).isSymbolicLink(), false);
    assert.equal(lstatSync(path.join(app, 'node_modules/rollup')).isSymbolicLink(), false);
    assert.equal(lstatSync(path.join(app, 'node_modules/@rollup/plugin')).isSymbolicLink(), true);
    assert.equal(lstatSync(path.join(app, 'node_modules/.vite')).isSymbolicLink(), false);
  } finally { restore(); }
});

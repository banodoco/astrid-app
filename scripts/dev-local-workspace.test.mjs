import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it, test } from 'node:test';
import { readGeneratedSchemaDigest } from './runtime-schema-guard.mjs';
import { RUNTIME_ACCEPTED_SCHEMA_DIGESTS } from '../src/integrations/runtime/contract-metadata.ts';
import { SOURCE_SCHEMA_MISMATCH_ACTION } from '../src/integrations/runtime/runtime-update-contract.mjs';
import { terminateProcessTree } from './terminate-process-tree.mjs';
import { listenOnTestPort } from './test-port.mjs';

import {
  parseDevLocalWorkspaceArgs,
  validatePreviewOutputDirectory,
  viteChildArgs,
  resolveWorkspaceDiscoveryPath,
  resolveRuntimeDataRoot,
  resolveRuntimeCommand,
  loadLocalRuntimeEnvironment,
  LOCAL_RUNTIME_ENV_KEYS,
  shellQuote,
} from './dev-local-workspace-options.mjs';

const temporaryDirectories = [];

test('local launcher settings persist without importing app secrets or overriding the shell', () => {
  const directory = mkdtempSync(join(tmpdir(), 'astrid-local-settings-'));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, '.env.local'), [
    'ASTRID_RUNTIME_DATA_ROOT="/existing/workspace with spaces"',
    'ASTRID_RUNTIME_PYTHON=/existing/python', 'ASTRID_APP_ACP_ENABLED=1',
    'ASTRID_ENV_FILE=/existing/credentials.env', 'ASTRID_PACK_HOST_PYTHON=/existing/python',
    'PORT=9999', 'UNRELATED_SECRET=synthetic-test-secret',
  ].join('\n'));
  const env = { ASTRID_RUNTIME_PYTHON: '/shell/python' };
  loadLocalRuntimeEnvironment(directory, env);
  assert.deepEqual(env, {
    ASTRID_RUNTIME_DATA_ROOT: '/existing/workspace with spaces',
    ASTRID_RUNTIME_PYTHON: '/shell/python', ASTRID_APP_ACP_ENABLED: '1',
    ASTRID_ENV_FILE: '/existing/credentials.env', ASTRID_PACK_HOST_PYTHON: '/existing/python',
  });
  assert.equal(parseDevLocalWorkspaceArgs([], env).acp, true);
  assert.equal(parseDevLocalWorkspaceArgs([], { ASTRID_APP_ACP_ENABLED: '0' }).acp, false);
  assert.equal(parseDevLocalWorkspaceArgs(['--data-root', '/explicit'], env).dataRoot, '/explicit');
});

test('launcher shell snippets quote command paths containing spaces', () => {
  assert.equal(shellQuote('/installed/Astrid App/start', 'linux'), "'/installed/Astrid App/start'");
  assert.equal(shellQuote('npm-run_dev:local', 'linux'), 'npm-run_dev:local');
  assert.equal(shellQuote("C:\\Users\\Ada's App\\start.cmd", 'win32'), "'C:\\Users\\Ada''s App\\start.cmd'");
});

test('Runtime Python and data roots follow the selected platform', () => {
  const windowsPython = 'C:\\Users\\Ada Lovelace\\Astrid Runtime';
  assert.deepEqual(resolveRuntimeCommand({
    runtimeCheckout: windowsPython,
    platform: 'win32',
    exists: (path) => path === 'C:\\Users\\Ada Lovelace\\Astrid Runtime\\.venv\\Scripts\\python.exe',
  }), {
    command: 'C:\\Users\\Ada Lovelace\\Astrid Runtime\\.venv\\Scripts\\python.exe',
    args: ['-m', 'astrid_runtime.cli'],
    cwd: windowsPython,
  });
  assert.throws(() => resolveRuntimeCommand({
    runtimeCheckout: windowsPython, platform: 'win32', exists: () => false,
  }), /\.venv\/Scripts\/python\.exe/);
  assert.equal(resolveRuntimeDataRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' }, home: 'C:\\Users\\Ada' }),
    'C:\\Users\\Ada\\AppData\\Local\\Astrid Runtime');
  assert.equal(resolveWorkspaceDiscoveryPath({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' }, home: 'C:\\Users\\Ada' }),
    'C:\\Users\\Ada\\AppData\\Local\\Astrid Runtime\\runtime\\discovery.json');
  assert.equal(resolveRuntimeDataRoot({ platform: 'linux', env: { XDG_DATA_HOME: '/home/ada/data' }, home: '/home/ada' }), '/home/ada/data/astrid-runtime');
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function emittedDirectory({ entry = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'astrid-dev-local-preview-test-'));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<!doctype html>');
  if (entry) await writeFile(join(directory, 'assets', 'index-test.js'), '');
  return directory;
}

describe('dev-local preview options', () => {
  it('parses preview mode only with an explicit output directory', () => {
    assert.deepEqual(parseDevLocalWorkspaceArgs(['--preview', '--preview-dir', '/tmp/emitted']), {
      checkOnly: false,
      paired: false,
      resetPairing: false,
      acp: false,
      preview: true,
      previewDir: '/tmp/emitted',
    });
    assert.throws(
      () => parseDevLocalWorkspaceArgs(['--preview']),
      /--preview requires --preview-dir/,
    );
    assert.throws(
      () => parseDevLocalWorkspaceArgs(['--preview-dir', '/tmp/emitted']),
      /--preview requires --preview-dir/,
    );
    assert.equal(parseDevLocalWorkspaceArgs(['--historical-ignored-arg']).preview, false);
  });

  it('turns ACP on only with --acp', () => {
    assert.equal(parseDevLocalWorkspaceArgs([]).acp, false);
    assert.equal(parseDevLocalWorkspaceArgs(['--hosted-origin', 'https://hosted.test']).acp, false);
    assert.equal(parseDevLocalWorkspaceArgs(['--acp']).acp, true);
  });

  it('rejects missing, relative, and non-emitted output directories', async () => {
    assert.throws(
      () => validatePreviewOutputDirectory('relative/dist'),
      /must be an absolute path/,
    );
    assert.throws(
      () => validatePreviewOutputDirectory('/tmp/astrid-no-such-preview-output'),
      /does not exist/,
    );
    const missingEntry = await emittedDirectory({ entry: false });
    assert.throws(
      () => validatePreviewOutputDirectory(missingEntry),
      /missing assets\/index-\*\.js/,
    );
  });

  it('accepts an emitted layout and canonicalizes its explicit directory', async () => {
    const directory = await emittedDirectory();
    assert.equal(validatePreviewOutputDirectory(directory), realpathSync(directory));
  });

  it('dispatches preview and dev to loopback with strict ports', () => {
    assert.deepEqual(viteChildArgs({ preview: false, previewDir: null }), [
      'run', 'dev', '--', '--host', '127.0.0.1', '--strictPort',
    ]);
    assert.deepEqual(viteChildArgs({ preview: true, previewDir: '/tmp/emitted' }), [
      'run', 'preview', '--', '--host', '127.0.0.1', '--strictPort', '--outDir', '/tmp/emitted',
    ]);
  });

  it('silences npm and Vite when quiet, and only then', () => {
    assert.deepEqual(viteChildArgs({ preview: false, previewDir: null, quiet: true }), [
      '--silent', 'run', 'dev', '--', '--host', '127.0.0.1', '--strictPort', '--logLevel', 'warn',
    ]);
    assert.deepEqual(viteChildArgs({ preview: true, previewDir: '/tmp/emitted', quiet: true }), [
      '--silent', 'run', 'preview', '--', '--host', '127.0.0.1', '--strictPort', '--outDir', '/tmp/emitted', '--logLevel', 'warn',
    ]);
    assert(!viteChildArgs({ preview: false, previewDir: null, quiet: false }).includes('--silent'));
  });
});

describe('dev-local Runtime options', () => {
  it('parses the four Runtime and checkout paths, leaving relative resolution to the launcher', () => {
    assert.deepEqual(parseDevLocalWorkspaceArgs([
      '--data-root', 'state/runtime', '--runtime', '../Runtime', '--astrid', '../Astrid', '--source-manifest', 'profiles/astrid.json',
    ]), {
      checkOnly: false,
      paired: false,
      resetPairing: false,
      acp: false,
      preview: false,
      previewDir: null,
      dataRoot: 'state/runtime',
      runtimeCheckout: '../Runtime',
      astridCheckout: '../Astrid',
      sourceManifest: 'profiles/astrid.json',
    });
    // Existing callers keep the original result shape when no new option is used.
    assert.deepEqual(Object.keys(parseDevLocalWorkspaceArgs([])), [
      'checkOnly', 'paired', 'resetPairing', 'acp', 'preview', 'previewDir',
    ]);
  });

  it('rejects missing values and duplicate value flags', () => {
    for (const option of ['--data-root', '--runtime', '--astrid', '--source-manifest']) {
      assert.throws(() => parseDevLocalWorkspaceArgs([option]), new RegExp(`${option} requires a path`));
      assert.throws(() => parseDevLocalWorkspaceArgs([option, '--check']), new RegExp(`${option} requires a path`));
      assert.throws(() => parseDevLocalWorkspaceArgs([option, 'first', option, 'second']), new RegExp(`${option} may be provided only once`));
    }
  });

  it('uses explicit Runtime Python, then the selected checkout venv, then PATH', () => {
    assert.deepEqual(resolveRuntimeCommand({ runtimePython: 'python-from-env' }), {
      command: 'python-from-env', args: ['-m', 'astrid_runtime.cli'],
    });

    const checkout = mkdtempSync(join(tmpdir(), 'astrid-runtime-command-test-'));
    temporaryDirectories.push(checkout);
    const python = join(checkout, '.venv', 'bin', 'python');
    mkdirSync(join(checkout, '.venv', 'bin'), { recursive: true });
    writeFileSync(python, '');
    assert.deepEqual(resolveRuntimeCommand({ runtimeCheckout: checkout }), {
      command: python, args: ['-m', 'astrid_runtime.cli'], cwd: checkout,
    });
    assert.deepEqual(resolveRuntimeCommand({ runtimeCheckout: checkout, runtimePython: 'selected-python' }), {
      command: 'selected-python', args: ['-m', 'astrid_runtime.cli'], cwd: checkout,
    });

    assert.deepEqual(resolveRuntimeCommand({}), { command: 'astrid-runtime', args: [], cwd: undefined });
  });

  it('prefers the selected Astrid checkout venv, which shares the Runtime client, over the Runtime checkout venv', () => {
    const checkout = mkdtempSync(join(tmpdir(), 'astrid-runtime-command-test-'));
    const astrid = mkdtempSync(join(tmpdir(), 'astrid-agent-command-test-'));
    temporaryDirectories.push(checkout, astrid);
    for (const root of [checkout, astrid]) {
      mkdirSync(join(root, '.venv', 'bin'), { recursive: true });
      writeFileSync(join(root, '.venv', 'bin', 'python'), '');
    }
    assert.deepEqual(resolveRuntimeCommand({ runtimeCheckout: checkout, astridCheckout: astrid }), {
      command: join(astrid, '.venv', 'bin', 'python'), args: ['-m', 'astrid_runtime.cli'], cwd: checkout,
    });
    assert.deepEqual(resolveRuntimeCommand({ runtimeCheckout: checkout, astridCheckout: join(astrid, 'missing') }), {
      command: join(checkout, '.venv', 'bin', 'python'), args: ['-m', 'astrid_runtime.cli'], cwd: checkout,
    });
    assert.deepEqual(resolveRuntimeCommand({ runtimeCheckout: checkout, astridCheckout: astrid, runtimePython: 'selected-python' }), {
      command: 'selected-python', args: ['-m', 'astrid_runtime.cli'], cwd: checkout,
    });
  });

  it('requires an explicit Python override when a selected Runtime checkout lacks its venv', () => {
    const checkout = mkdtempSync(join(tmpdir(), 'astrid-runtime-no-venv-test-'));
    temporaryDirectories.push(checkout);
    assert.throws(() => resolveRuntimeCommand({ runtimeCheckout: checkout }), /no \.venv\/bin\/python/);
  });
});
const TEST_DATA_ENV_KEYS = [
  'BANODOCO_LOCAL_DATA_ROOT', 'BANODOCO_LOCAL_SOURCE_MANIFEST', 'ASTRID_LOCAL_DATA_ROOT',
  'ASTRID_RUNTIME_DATA_ROOT', 'ASTRID_LOCAL_SOURCE_MANIFEST', 'BANODOCO_RUNTIME_DATA_ROOT',
  'ASTRID_DATA_ROOT', 'ASTRID_SUPPORT_ROOT', 'ASTRID_RUNTIME_PYTHON',
  'ASTRID_RUNTIME_CHECKOUT', 'ASTRID_RUNTIME_SOURCE_MANIFEST', 'ASTRID_START_COMMAND', 'ASTRID_INSTALL_MANAGED_BY',
];

function cleanInheritedEnvironment(source = process.env) {
  const clean = { ...source };
  for (const key of TEST_DATA_ENV_KEYS) delete clean[key];
  // The developer's persisted installation is never a test fixture.
  for (const key of LOCAL_RUNTIME_ENV_KEYS) clean[key] = '';
  return clean;
}

const run = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/dev-local-workspace.mjs', ...args], { env: { ...cleanInheritedEnvironment(), ...env } });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
  child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
});

async function launchFixture(overrides = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'astrid-local-launch-check-'));
  const token = 'synthetic-runtime-test-token';
  const actorId = 'astrid-product-r3';
  const realmId = 'realm-r3';
  const runtimeInstanceId = 'runtime-instance-r3';
  const realmRoot = join(fixture, 'realm-root');
  mkdirSync(realmRoot);
  const credential = join(fixture, 'astrid.json');
  writeFileSync(credential, JSON.stringify({ version: 1, scope: 'astrid', actor_id: actorId, token }), { mode: 0o600 });
  const catalog = join(fixture, 'catalog.json');
  writeFileSync(catalog, JSON.stringify({
    selected_realm_id: realmId,
    realms: [{ realm_id: realmId, source_profile: 'astrid', data_root: realmRoot }],
  }));
  const noSpawnBin = join(fixture, 'bin');
  mkdirSync(noSpawnBin);
  const spawnMarker = join(fixture, 'unexpected-child-spawn');
  const fakeNpm = join(noSpawnBin, 'npm');
  writeFileSync(fakeNpm, `#!/bin/sh\nprintf spawned > '${spawnMarker}'\nexit 0\n`, { mode: 0o700 });
  chmodSync(fakeNpm, 0o700);
  let available = true;
  const requests = [];
  const runtime = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (!available) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'offline' }));
      return;
    }
    const digest = readGeneratedSchemaDigest(resolve('src/integrations/runtime/generated-contract-metadata.ts'));
    const responseDigest = (key) => Object.hasOwn(overrides, key) ? overrides[key] : digest;
    const json = (value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/v1/health') return json({
      status: 'ok', protocol: overrides.healthProtocol ?? 'workspace.v1', schema_digest: responseDigest('healthDigest'),
      runtime_instance_id: overrides.healthInstanceId ?? runtimeInstanceId,
    });
    if (req.url === '/v1/handshake') return json({
      protocol: overrides.handshakeProtocol ?? 'workspace.v1', schema_digest: responseDigest('handshakeDigest'), session_id: 'session-r3',
      actor_id: overrides.handshakeActorId ?? actorId,
      realm_id: overrides.handshakeRealmId ?? realmId,
      scopes: overrides.handshakeScopes ?? ['handshake', 'projects:read', 'projects:write', 'objects:read', 'objects:write', 'tasks:read', 'tasks:write'],
    });
    if (req.url === '/v1/realm') return json({ realm_id: overrides.realmResponseId ?? realmId, display_name: 'Astrid test realm', version: 1, created_at: '2026-09-11T00:00:00Z' });
    res.writeHead(404); res.end();
  });
  await listenOnTestPort(runtime);
  // The Runtime's browser door: a stand-in listener on its own port, recorded in discovery as the hosted page's door.
  const door = createServer((_req, res) => { res.writeHead(404); res.end(); });
  await listenOnTestPort(door);
  const discovery = join(fixture, 'discovery.json');
  const discoveryDocument = JSON.stringify({
    endpoint: `http://127.0.0.1:${runtime.address().port}`,
    credential_file: credential,
    runtime_instance_id: runtimeInstanceId,
    active_realm: overrides.discoveryRealmId ?? realmId,
    realm_root: overrides.discoveryRealmRoot ?? realmRoot,
    ...(overrides.door === false ? {} : {
      door_endpoint: `http://127.0.0.1:${door.address().port}`,
      door_origin: overrides.doorOrigin ?? overrides.configuredOrigin ?? 'https://hosted.test',
    }),
  });
  writeFileSync(discovery, discoveryDocument);
  if (overrides.discoveryState === 'missing') rmSync(discovery, { force: true });
  if (overrides.discoveryState === 'stale') {
    const unusedPort = await freePort();
    writeFileSync(discovery, JSON.stringify({
      endpoint: `http://127.0.0.1:${unusedPort}`, credential_file: credential,
      runtime_instance_id: 'stale-runtime', active_realm: realmId, realm_root: realmRoot,
    }));
  }
  if (overrides.credential) writeFileSync(credential, typeof overrides.credential === 'string' ? overrides.credential : JSON.stringify(overrides.credential), { mode: 0o600 });
  if (overrides.catalogSelectedRealmId || overrides.catalogRealmId || overrides.catalogRoot || overrides.sourceProfile) {
    writeFileSync(catalog, JSON.stringify({
      selected_realm_id: overrides.catalogSelectedRealmId ?? realmId,
      realms: [{ realm_id: overrides.catalogRealmId ?? realmId, source_profile: overrides.sourceProfile ?? 'astrid', data_root: overrides.catalogRoot ?? realmRoot }],
    }));
  }
  // A fixture config, never the shipped one: no default origin unless a case names one.
  const hostedConfig = join(fixture, 'hosted-origin.json');
  writeFileSync(hostedConfig, overrides.hostedOriginConfigRaw ?? JSON.stringify({ origin: overrides.configuredOrigin ?? null }));
  const env = {
    HOME: fixture,
    USERPROFILE: fixture,
    LOCALAPPDATA: join(fixture, 'AppData', 'Local'),
    XDG_DATA_HOME: join(fixture, '.local', 'share'),
    ASTRID_WORKSPACE_DISCOVERY: discovery,
    ASTRID_APP_LOOPBACK_ORIGIN: '',
    ASTRID_APP_HOSTED_ORIGIN_CONFIG: overrides.hostedOriginConfigPath ?? hostedConfig,
    PATH: noSpawnBin,
    FAKE_RUNTIME_CLI_LOG: join(fixture, 'runtime-cli.log'),
    FAKE_RUNTIME_LIFECYCLE_LOG: join(fixture, 'lifecycle.log'),
    FAKE_RUNTIME_DISCOVERY_JSON: discoveryDocument,
    FAKE_RUNTIME_CATALOG_JSON: readFileSync(catalog, 'utf8'),
    FAKE_RUNTIME_DISCOVERY_PATH: discovery,
    FAKE_RUNTIME_APP_ENV: join(fixture, 'app-env.json'),
    npm_execpath: join(noSpawnBin, 'npm-cli.js'),
  };
  writeFileSync(env.npm_execpath, `require('node:fs').writeFileSync(${JSON.stringify(spawnMarker)}, 'spawned');\n`);
  writeFileSync(env.FAKE_RUNTIME_LIFECYCLE_LOG, '');
  const fakeRuntimeCli = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const log = process.env.FAKE_RUNTIME_CLI_LOG;
const action = args[0] || 'unknown';
fs.appendFileSync(log, JSON.stringify({ args, action, cwd: process.cwd(), astridCheckout: process.env.ASTRID_CHECKOUT || null }) + '\\n');
if (action === 'up' && process.env.FAKE_RUNTIME_UP_ERROR) {
  console.log(JSON.stringify({ ok: false, error: process.env.FAKE_RUNTIME_UP_ERROR }));
  process.exit(1);
}
if (action === 'up' && process.env.FAKE_RUNTIME_UP_EXIT !== '1') {
  const dataRootIndex = args.indexOf('--data-root');
  const dataRoot = dataRootIndex >= 0 ? args[dataRootIndex + 1] : null;
  const discovery = process.env.FAKE_RUNTIME_DISCOVERY_PATH || process.env.ASTRID_WORKSPACE_DISCOVERY;
  const target = dataRoot ? path.join(dataRoot, 'runtime', 'discovery.json') : discovery;
  const publish = () => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, process.env.FAKE_RUNTIME_DISCOVERY_JSON + '\\n');
    fs.writeFileSync(path.join(path.dirname(target), 'catalog.json'), process.env.FAKE_RUNTIME_CATALOG_JSON + '\\n');
    console.log(JSON.stringify({ status: process.env.FAKE_RUNTIME_UP_STATUS || 'started', discovery_path: target }));
    process.exit(0);
  };
  const gate = process.env.FAKE_RUNTIME_UP_RELEASE_FILE;
  if (!gate) publish();
  else {
    const released = () => fs.readFileSync(gate, 'utf8').includes('release Runtime up');
    const watcher = fs.watch(gate, () => {
      if (released()) {
        watcher.close();
        publish();
      }
    });
    fs.writeFileSync(process.env.FAKE_RUNTIME_UP_STARTED_FILE, 'up is waiting for release\\n');
    if (released()) {
      watcher.close();
      publish();
    }
  }
} else if (action === 'down' && process.env.FAKE_RUNTIME_DOWN_EXIT !== '1') {
  const net = require('node:net');
  const listening = (port) => new Promise((resolve) => {
    if (!port) return resolve(false);
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
  Promise.all([
    listening(process.env.PORT),
    listening(process.env.VITE_ASTRID_DYNAMIC_PROXY_PORT),
  ]).then(([vite, proxy]) => {
    fs.appendFileSync(process.env.FAKE_RUNTIME_LIFECYCLE_LOG, 'runtime:down viteOpen=' + vite + ' proxyOpen=' + proxy + '\\n');
    console.log(JSON.stringify({ status: 'stopped' }));
    process.exit(0);
  });
} else {
  process.stderr.write('fake Runtime CLI failure\\n');
  process.exit(7);
}
`;
  writeFileSync(join(noSpawnBin, 'astrid-runtime'), fakeRuntimeCli, { mode: 0o700 });
  return {
    fixture, token, actorId, realmId, runtimeInstanceId, realmRoot, catalog, discoveryDocument,
    discovery, spawnMarker, requests, runtime, door, env,
    setAvailable(value) { available = value; },
    async close() {
      await new Promise(r => runtime.close(r));
      await new Promise(r => door.close(r));
      rmSync(fixture, { recursive: true, force: true });
    },
  };
}

test('local launcher binds the selected Astrid product credential and profile before startup', async () => {
  const fixture = await launchFixture();
  try {
    const valid = await run(['--check', '--hosted-origin', 'https://hosted.test'], fixture.env);
    assert.equal(valid.code, 0); assert.equal(valid.stdout, 'Astrid is ready.\n'); assert(!valid.stdout.includes(fixture.token));
    assert.deepEqual(fixture.requests.map(({ method, path }) => `${method} ${path}`), [
      'GET /v1/health', 'POST /v1/handshake', 'GET /v1/realm',
    ]);
    assert.deepEqual(fixture.requests[1].body.requested_scopes, ['handshake', 'projects:read', 'projects:write', 'objects:read', 'objects:write', 'tasks:read', 'tasks:write']);
    assert.equal(existsSync(fixture.spawnMarker), false, '--check must not start ACP or Vite');
    for (const args of [['--check', '--hosted-origin'], ['--check', '--hosted-origin', '--paired'], ['--check', '--hosted-origin', 'http://hosted.test'], ['--check', '--hosted-origin', 'https://hosted.test/path']]) {
      const invalid = await run(args, fixture.env); assert.equal(invalid.code, 1); assert.match(invalid.stderr, /origin/); assert(!invalid.stderr.includes(fixture.token));
    }
    // The technical line is still there for an agent that asks for it.
    const verboseCheck = await run(['--check', '--verbose', '--hosted-origin', 'https://hosted.test'], fixture.env);
    assert.equal(verboseCheck.code, 0); assert.match(verboseCheck.stdout, /workspace\.v1 runtime healthy/);
    const badOrigin = await run(['--check', '--hosted-origin', 'http://hosted.test'], fixture.env);
    assert.equal(badOrigin.stderr.split('\n')[0], 'Astrid: --hosted-origin must be an https:// address, like https://astrid.haus');
    assert.match(badOrigin.stderr.split('\n')[1], /^Details: /);
    fixture.setAvailable(false);
    const offline = await run(['--check'], fixture.env); assert.equal(offline.code, 1); assert.match(offline.stderr, /HTTP 503/);
    assert.equal(offline.stderr.split('\n')[0], "Astrid's engine isn't running. Start it first: astrid-runtime up --profile astrid");
    assert.match(offline.stderr.split('\n')[1], /^Details: .*HTTP 503/);
    assert(!offline.stderr.includes('dev:local:'), offline.stderr);
  } finally { await fixture.close(); }
});

test('local launcher rejects credential, profile, and Runtime identity substitutions before launch', async () => {
  const cases = [
    ['raw owner token', { credential: 'synthetic-owner-token' }, /scoped Astrid product credential/],
    ['owner-scoped credential', { credential: { version: 1, scope: 'owner', actor_id: 'owner', token: 'synthetic-owner-token' } }, /version 1 astrid product scope/],
    ['credential with owner actor', { credential: { version: 1, scope: 'astrid', actor_id: 'owner', token: 'synthetic-owner-token' } }, /forbidden or missing product actor/],
    ['discovery selects a different realm than catalog', { discoveryRealmId: 'other-realm' }, /selected realm in catalog/],
    ['catalog selects a different realm', { catalogSelectedRealmId: 'other-realm' }, /selected realm in catalog/],
    ['catalog has no matching selected realm row', { catalogRealmId: 'other-realm' }, /not one Astrid profile/],
    ['catalog root differs from discovery', { catalogRoot: '/tmp' }, /realm root does not match/],
    ['non-Astrid profile row', { sourceProfile: 'worker' }, /not one Astrid profile/],
    ['health reports another Runtime instance', { healthInstanceId: 'other-runtime' }, /instance does not match/],
    ['handshake reports another actor', { handshakeActorId: 'owner' }, /actor, realm, protocol, or product scopes/],
    ['handshake reports another realm', { handshakeRealmId: 'other-realm' }, /actor, realm, protocol, or product scopes/],
    ['handshake grants an extra admin scope', { handshakeScopes: ['handshake', 'projects:read', 'projects:write', 'objects:read', 'objects:write', 'tasks:read', 'tasks:write', 'admin'] }, /actor, realm, protocol, or product scopes/],
    ['realm endpoint reports another realm', { realmResponseId: 'other-realm' }, /realm does not match/],
  ];
  for (const [label, overrides, expectedError] of cases) {
    const fixture = await launchFixture(overrides);
    try {
      const result = await run(['--check'], fixture.env);
      assert.equal(result.code, 1, `${label}: expected failure`);
      assert.match(result.stderr, expectedError, label);
      assert(!result.stderr.includes(fixture.token), `${label}: credential leaked to stderr`);
      if (label === 'health reports another Runtime instance') {
        assert.equal(result.stderr.split('\n')[0], 'Astrid changed on this computer. Restart its engine: astrid-runtime up --profile astrid');
        assert.match(result.stderr.split('\n')[1], /^Details: Runtime health instance does not match/);
      }
      assert.equal(existsSync(fixture.spawnMarker), false, `${label}: launched a child`);
    } finally { await fixture.close(); }
  }
});


test('Runtime discovery selection ignores source checkout and rejects ambiguous roots', () => {
  const home = '/home/fixture';
  assert.equal(resolveWorkspaceDiscoveryPath({ home, env: {}, platform: 'linux' }), '/home/fixture/.local/share/astrid-runtime/runtime/discovery.json');
  assert.equal(resolveWorkspaceDiscoveryPath({ home, supportRoot: '/selected/root', dataRoot: '/selected/root' }), '/selected/root/runtime/discovery.json');
  assert.equal(resolveWorkspaceDiscoveryPath({ home, discovery: '/selected/discovery.json', supportRoot: '/unused/root' }), '/selected/discovery.json');
  assert.throws(() => resolveWorkspaceDiscoveryPath({ home, supportRoot: '/one', dataRoot: '/two' }), /different roots/);
  assert.throws(() => resolveWorkspaceDiscoveryPath({ home, discovery: 'relative/discovery.json' }), /absolute path/);
});

test('build handoff carries verified identity and gives only builds a 4 GB heap default', async () => {
  for (const [existingNodeOptions, expectedNodeOptions] of [
    ['', '--max-old-space-size=4096'],
    ['--trace-warnings', '--trace-warnings --max-old-space-size=4096'],
    ['--max-old-space-size=2048', '--max-old-space-size=2048'],
  ]) {
    const fixture = await launchFixture();
    const captured = join(fixture.fixture, 'build-environment.json');
    const fakeNpm = join(fixture.fixture, 'bin', 'npm');
    const fakeNpmJs = join(fixture.fixture, 'bin', 'npm-cli.js');
    const fakeNpmScript = `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify({args:process.argv.slice(2), actor:process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_ACTOR_ID, realm:process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID, instance:process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_INSTANCE_ID, nodeOptions:process.env.NODE_OPTIONS}));
`;
    writeFileSync(fakeNpm, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(captured)}, JSON.stringify({args:process.argv.slice(2), actor:process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_ACTOR_ID, realm:process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID, instance:process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_INSTANCE_ID, nodeOptions:process.env.NODE_OPTIONS}));
`, { mode: 0o700 });
    writeFileSync(fakeNpmJs, fakeNpmScript);
    fixture.env.npm_execpath = fakeNpmJs;
    fixture.env.NODE_OPTIONS = existingNodeOptions;
    try {
      const result = await run(['--build'], fixture.env);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(captured, 'utf8')), {
        args: ['run', 'build'], actor: fixture.actorId, realm: fixture.realmId,
        instance: fixture.runtimeInstanceId, nodeOptions: expectedNodeOptions,
      });
      assert.equal(existsSync(fixture.spawnMarker), false);
      assert(!result.stdout.includes(fixture.token));
    } finally { await fixture.close(); }
  }
});


test('build handoff rejects a Runtime instance change during compilation', async () => {
  let healthReads = 0;
  const fixture = await launchFixture({
    get healthInstanceId() { return ++healthReads === 1 ? undefined : 'restarted-instance'; },
  });
  try {
    const result = await run(['--build'], fixture.env);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /instance does not match/);
    assert.equal(healthReads, 2);
    assert.equal(existsSync(fixture.spawnMarker), true, 'fixture compiler must run between identity checks');
    assert(!result.stdout.includes(fixture.token));
  } finally { await fixture.close(); }
});


// The whole launcher against a fake Runtime, with a fake long-lived `npm` for ACP and Vite. The fake Vite listens on the app's
// port (PORT), so the launcher's Open block, which waits for it, is reached; it also records every spawn.
async function freePort() {
  const server = createServer();
  const port = await listenOnTestPort(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const FAKE_NPM = (spawnLog) => `#!${process.execPath}
const args = process.argv.slice(2);
const fs = require('node:fs');
const kind = args.includes('dev:astrid-acp') ? 'acp' : (args.includes('dev') || args.includes('preview') ? 'vite' : 'other');
fs.appendFileSync(${JSON.stringify(spawnLog)}, args.join(' ') + '\\n');
fs.appendFileSync(process.env.FAKE_RUNTIME_LIFECYCLE_LOG, kind + ':start\\n');
if (kind === 'vite') fs.writeFileSync(process.env.FAKE_RUNTIME_APP_ENV, JSON.stringify({ args, astridCheckout: process.env.ASTRID_CHECKOUT, dataRoot: process.env.ASTRID_RUNTIME_DATA_ROOT, supportRoot: process.env.ASTRID_SUPPORT_ROOT, discovery: process.env.ASTRID_WORKSPACE_DISCOVERY, localUpdateStatus: process.env.ASTRID_LOCAL_UPDATE_STATUS, viteLocalUpdateStatus: process.env.VITE_ASTRID_LOCAL_UPDATE_STATUS }));
console.log(['fake-npm', ...args].join(' '));
if (kind === 'vite' && process.env.FAKE_NPM_VITE_EXIT) process.exit(Number(process.env.FAKE_NPM_VITE_EXIT));
if (process.env.FAKE_NPM_TREE_PIDS) {
  fs.appendFileSync(process.env.FAKE_NPM_TREE_PIDS, process.pid + '\\n');
  const server = ${JSON.stringify(`
    const fs = require('node:fs');
    fs.appendFileSync(process.env.FAKE_NPM_TREE_PIDS, process.pid + String.fromCharCode(10));
    require('node:http').createServer((_request, response) => response.end('descendant server')).listen(Number(process.env.PORT), '127.0.0.1', () => fs.writeFileSync(process.env.FAKE_NPM_TREE_READY, 'ready'));
  `)};
  const middle = 'require("node:fs").appendFileSync(process.env.FAKE_NPM_TREE_PIDS, process.pid + String.fromCharCode(10)); require("node:child_process").spawn(process.execPath, ["-e", ' + JSON.stringify(server) + '], { stdio: "inherit" });';
  require('node:child_process').spawn(process.execPath, ['-e', middle], { stdio: 'inherit' });
} else if (args.includes('dev') || args.includes('preview')) require('node:http').createServer((request, response) => {
  if (request.url !== '/runtime-config/v1/workspace.json') { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ realmId: process.env.FAKE_VITE_REALM_ID || process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID }));
}).listen(Number(process.env.PORT), '127.0.0.1');
if (args.includes('dev:astrid-acp') && process.env.FAKE_ACP_EXIT_MS) setTimeout(() => process.exit(3), Number(process.env.FAKE_ACP_EXIT_MS));
// The chat bridge answers its health route only with its own credential, as the real one does; a taken port ends it.
if (kind === 'acp' && !process.env.FAKE_ACP_EXIT_MS) {
  const bridge = require('node:http').createServer((request, response) => {
    const ours = request.url === '/health' && request.headers.authorization === 'Bearer ' + process.env.ASTRID_ACP_BRIDGE_TOKEN;
    response.writeHead(ours ? 200 : 401, { 'Content-Type': 'application/json' });
    response.end(ours ? '{"status":"ok"}' : '{"error":"unauthorized"}');
  });
  bridge.on('error', () => process.exit(1));
  bridge.listen(Number(process.env.ASTRID_ACP_BRIDGE_PORT), '127.0.0.1');
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { fs.appendFileSync(process.env.FAKE_RUNTIME_LIFECYCLE_LOG, kind + ':stop\\n'); process.exit(0); });
setInterval(() => {}, 1000);
`;

const OPEN_BLOCK_END = 'Keep this window open while you work. Press Ctrl+C to stop.';
// Windows kill(SIGINT/SIGTERM) forcibly exits Node; deliver the event inside the
// launcher there. POSIX tests continue sending real signals.
const SIGNAL_CONTROL = `data:text/javascript,${encodeURIComponent(`
process.on('message', (signal) => {
  process.emit(signal);
  process.send(signal);
});
process.channel.unref();
`)}`;

/**
 * The launcher against a fake Runtime. Resolves once `until(stdout, stderr, exitCode)` holds, with what it printed; `stop()`
 * ends it and cleans up. The default free ports keep a developer's own app (2222) out of it.
 */
async function startLauncher({ args = [], env: overrides = {}, shippedConfig = false, until = (stdout) => stdout.includes(OPEN_BLOCK_END) || stdout.includes('Local App: http://127.0.0.1:'), fixture: given, ...fixtureOverrides } = {}) {
  const fixture = given ?? await launchFixture(fixtureOverrides);
  const spawnLog = join(fixture.fixture, 'spawn.log');
  writeFileSync(spawnLog, '');
  const fakeNpm = FAKE_NPM(spawnLog);
  writeFileSync(join(fixture.fixture, 'bin', 'npm'), fakeNpm, { mode: 0o700 });
  const fakeNpmJs = join(fixture.fixture, 'bin', 'npm-cli.js');
  writeFileSync(fakeNpmJs, fakeNpm.slice(fakeNpm.indexOf('\n') + 1));
  const { ASTRID_VERBOSE: _verbose, ...inherited } = cleanInheritedEnvironment();
  const env = {
    ...inherited,
    ...fixture.env,
    npm_execpath: fakeNpmJs,
    PORT: String(await freePort()),
    VITE_ASTRID_DYNAMIC_PROXY_PORT: String(await freePort()),
    VITE_ASTRID_ACP_BRIDGE_PORT: String(await freePort()),
    ...overrides,
  };
  // The shipped config/hosted-origin.json is read only when a case asks for it; the fixture config is the default otherwise.
  if (shippedConfig) delete env.ASTRID_APP_HOSTED_ORIGIN_CONFIG;
  const controlArgs = process.platform === 'win32' ? ['--import', SIGNAL_CONTROL] : [];
  const child = spawn(process.execPath, [...controlArgs, 'scripts/dev-local-workspace.mjs', ...args], { env, stdio: process.platform === 'win32' ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const seen = { stdout: '', stderr: '' };
  child.stdout.on('data', c => { seen.stdout += c; }); child.stderr.on('data', c => { seen.stderr += c; });
  const closed = new Promise(resolveClose => child.once('close', resolveClose));
  const requestSignal = (name) => new Promise((resolveSignal, reject) => {
    if (child.exitCode !== null) return resolveSignal();
    if (process.platform !== 'win32') { child.kill(name); return resolveSignal(); }
    child.once('message', resolveSignal);
    child.send(name, (error) => { if (error) reject(error); });
  });
  const stop = async () => {
    await requestSignal('SIGTERM');
    await closed;
    if (!given) await fixture.close();
  };
  const signal = async (name) => {
    await requestSignal(name);
    await closed;
  };
  try {
    const deadline = Date.now() + 60_000;
    while (!until(seen.stdout, seen.stderr, child.exitCode)) {
      if (Date.now() > deadline || (child.exitCode !== null && !until(seen.stdout, seen.stderr, child.exitCode))) {
        throw new Error(`launcher did not get there (exit ${child.exitCode}): ${seen.stdout}${seen.stderr}`);
      }
      await new Promise(r => setTimeout(r, 50));
    }
    return { stdout: seen.stdout, stderr: seen.stderr, child, closed, env, fixture, spawnLog, stop, signal, requestSignal, seen };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Runs the launcher to its end (a refusal, or `already running`), resolving with its exit code and output. */
async function launcherEnds(options) {
  const started = await startLauncher({ ...options, until: (_stdout, _stderr, exitCode) => exitCode !== null });
  await started.closed;
  const result = { code: started.child.exitCode, stdout: started.seen.stdout, stderr: started.seen.stderr, spawned: readFileSync(started.spawnLog, 'utf8') };
  await started.stop();
  return result;
}

function runtimeCliCalls(fixture) {
  if (!existsSync(fixture.env.FAKE_RUNTIME_CLI_LOG)) return [];
  return readFileSync(fixture.env.FAKE_RUNTIME_CLI_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

// What a person sees on a healthy start: three lines and the address, nothing else.
const HEALTHY_OUTPUT = (origin) => ['Starting Astrid…', '', `  Open ${origin}`, '', OPEN_BLOCK_END, ''].join('\n');

test('a healthy start prints exactly the Open block, once Astrid is reachable, and nothing else', async () => {
  const started = await startLauncher({ configuredOrigin: 'https://hosted.test' });
  try {
    assert.equal(started.stdout, HEALTHY_OUTPUT(`http://127.0.0.1:${started.env.PORT}/tools/video-editor`));
    assert.equal(started.stderr, '');
    // npm is asked to be silent, and Vite to log warnings only.
    const spawned = readFileSync(started.spawnLog, 'utf8').split('\n').filter(Boolean);
    assert(spawned.every(line => line.startsWith('--silent ')), spawned.join('\n'));
    assert(spawned.some(line => line.includes('--logLevel warn')), spawned.join('\n'));
  } finally { await started.stop(); }
});

test('the Open block is bold on a terminal only', async () => {
  // The launcher decides from process.stdout.isTTY; piped output (as here) carries no escape codes.
  const started = await startLauncher({ configuredOrigin: 'https://hosted.test' });
  try { assert(!started.stdout.includes('\x1b['), JSON.stringify(started.stdout)); } finally { await started.stop(); }
});

test('--verbose prints the technical lines after the Open block, and ASTRID_VERBOSE=1 remains supported', async () => {
  for (const options of [{ args: ['--verbose'], env: {} }, { args: [], env: { ASTRID_VERBOSE: '1' } }]) {
    const fixture = await launchFixture({ configuredOrigin: 'https://hosted.test' });
    const doorEndpoint = JSON.parse(fixture.discoveryDocument).door_endpoint;
    let started;
    try {
      started = await startLauncher({
        fixture,
        args: options.args,
        env: options.env,
        until: (stdout) => stdout.includes(OPEN_BLOCK_END) && stdout.includes('browser door') && stdout.includes('fake-npm run dev --') && stdout.includes('Runtime discovery proxy listening'),
      });
      const { stdout } = started;
      assert(stdout.startsWith(HEALTHY_OUTPUT(`http://127.0.0.1:${started.env.PORT}/tools/video-editor`)), stdout);
      const rest = stdout.slice(HEALTHY_OUTPUT(`http://127.0.0.1:${started.env.PORT}/tools/video-editor`).length);
      assert.match(rest, /workspace\.v1 runtime healthy at http:\/\/127\.0\.0\.1:\d+; Astrid App will use port \d+/);
      assert(rest.includes('Runtime discovery proxy listening on 127.0.0.1:'), rest);
      assert(rest.includes(`browser door ${doorEndpoint} for https://hosted.test`), rest);
      assert(rest.includes('fake-npm run dev --'), rest);
      assert(!rest.includes('--silent'), 'verbose runs npm as it always did');
    } finally {
      if (started) await started.stop();
      await fixture.close();
    }
  }
});

test('a running Runtime without a door for this hosted page is not attached: it is named, nothing starts, no Open', async () => {
  const cases = [
    ['another page', { doorOrigin: 'https://other.test' }, 'the running Runtime\'s browser door serves https://other.test', undefined],
    ['no door at all', { door: false }, 'the running Runtime\'s browser door serves no hosted page', undefined],
    ['Pinokio-managed app', { door: false }, 'the running Runtime\'s browser door serves no hosted page', { ASTRID_INSTALL_MANAGED_BY: 'pinokio', ASTRID_START_COMMAND: '/Pinokio/Astrid/start' }],
  ];
  for (const [label, overrides, details, env] of cases) {
    const fixture = await launchFixture({ configuredOrigin: 'https://hosted.test', ...overrides });
    try {
      const result = await launcherEnds({ fixture, env });
      assert.equal(result.code, 1, label);
      assert.deepEqual(result.stderr.split('\n').slice(0, 2), [
        env
          ? "Astrid's engine isn't accepting https://hosted.test. Stop and start Astrid in Pinokio."
          : "Astrid's engine is running without a door for https://hosted.test. Restart it: astrid-runtime restart --profile astrid --hosted-origin https://hosted.test",
        `Details: ${details}`,
      ], label);
      assert.equal(result.stdout, '', `${label}: printed something`);
      assert.deepEqual(runtimeCliCalls(fixture), [], `${label}: Runtime CLI invoked`);
      assert.equal(result.spawned, '', `${label}: launched a child`);
    } finally { await fixture.close(); }
  }
});

test('the app port taken by another program: one friendly line, the details, no Open block, and nothing started', async () => {
  // Something that is not Astrid's app already listens on the app's port. Vite would not start, and whatever answers must
  // never be taken for it: the launcher refuses before it prints "Starting Astrid…" or an address.
  const holder = createServer((_req, res) => { res.writeHead(200); res.end('not the app'); });
  await listenOnTestPort(holder);
  const appPort = String(holder.address().port);
  try {
    const result = await launcherEnds({ configuredOrigin: 'https://hosted.test', env: { PORT: appPort } });
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.deepEqual(result.stderr.split('\n').slice(0, 2), [
      "Astrid: Another program is in the way, so Astrid can't start. Close it and try again.",
      `Details: port ${appPort} is in use`,
    ]);
    assert(!result.stderr.includes('Agent chat stopped'), result.stderr);
    assert(!result.stdout.includes('Open '), result.stdout);
    assert(!result.stdout.includes('Starting Astrid'), result.stdout);
    assert.equal(result.spawned, '', 'no proxy, ACP bridge or Vite was started');
  } finally { await new Promise(r => holder.close(r)); }
});

test('a second launcher for the same Astrid says so, prints the same Open block, starts nothing and exits 0', async () => {
  const first = await startLauncher({ configuredOrigin: 'https://hosted.test' });
  try {
    writeFileSync(first.spawnLog, '');
    const second = await launcherEnds({ fixture: first.fixture, env: { PORT: first.env.PORT } });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout, ['Astrid is already running in another window.', '', `  Open http://127.0.0.1:${first.env.PORT}/tools/video-editor`, '', OPEN_BLOCK_END, ''].join('\n'));
    assert.equal(second.stderr, '');
    assert.equal(second.spawned, '', 'no discovery proxy, ACP bridge or Vite for the second launcher');
  } finally { await first.stop(); }
});

test('a Runtime whose door port is held by another Astrid says so', async () => {
  const cases = [
    ['another Astrid', 'Runtime daemon exited during startup: port 17340 is already served by another Astrid Runtime for realm "Other" (r2); stop that one first (astrid-runtime down) (see /x/runtime.log).', /already served by another Astrid Runtime/],
    ['another program', 'Runtime daemon exited during startup: port 17340 is already in use by a program that is not an Astrid Runtime; stop it, then start Astrid again (see /x/runtime.log).', /already in use by a program that is not an Astrid Runtime/],
  ];
  for (const [label, upError, detailsPattern] of cases) {
    const fixture = await launchFixture({ discoveryState: 'missing', configuredOrigin: 'https://hosted.test' });
    try {
      const result = await launcherEnds({ fixture, env: { FAKE_RUNTIME_UP_ERROR: upError } });
      assert.equal(result.code, 1, `${label}: ${result.stdout}${result.stderr}`);
      assert.equal(result.stderr.split('\n')[0], label === 'another Astrid'
        ? 'Astrid: Another Astrid is already running in another window. Stop it there with Ctrl+C first.'
        : "Astrid: Another program is in the way, so Astrid can't start. Close it and try again.", label);
      assert.match(result.stderr.split('\n')[1], /^Details: Runtime up failed: /, label);
      assert.match(result.stderr.split('\n')[1], detailsPattern, label);
      assert.equal(result.stdout, '', label);
      assert.equal(result.spawned, '', `${label}: launched a child`);
    } finally { await fixture.close(); }
  }
});

test('a second launcher for another Astrid says to stop the first one', async () => {
  const first = await startLauncher({ configuredOrigin: 'https://hosted.test' });
  const other = await launchFixture({ configuredOrigin: 'https://hosted.test', discoveryRealmId: 'realm-other', catalogSelectedRealmId: 'realm-other', catalogRealmId: 'realm-other', handshakeRealmId: 'realm-other', realmResponseId: 'realm-other' });
  try {
    const second = await launcherEnds({ fixture: other, env: { PORT: first.env.PORT } });
    assert.equal(second.code, 1, second.stdout + second.stderr);
    assert.equal(second.stderr.split('\n')[0], 'Astrid: Another Astrid is already running in another window. Stop it there with Ctrl+C first.');
    assert.equal(second.stderr.split('\n')[1], `Details: port ${first.env.PORT} is in use by Astrid's app for another realm`);
    assert(!second.stdout.includes('Open '), second.stdout);
    assert.equal(second.spawned, '');
  } finally {
    await first.stop();
    await other.close();
  }
});

test('agent chat is supervised independently of the app launcher', async () => {
  const started = await startLauncher({ configuredOrigin: 'https://hosted.test',
    env: { FAKE_ACP_EXIT_MS: '200', ASTRID_START_COMMAND: '/installed/Astrid App/start' } });
  try { assert(!readFileSync(started.spawnLog, 'utf8').includes('dev:astrid-acp')); }
  finally { await started.stop(); }
});

test('a failed app start recommends --verbose with the installed start command', async () => {
  const result = await launcherEnds({
    configuredOrigin: 'https://hosted.test',
    env: { ASTRID_START_COMMAND: '/installed/Astrid/start', FAKE_NPM_VITE_EXIT: '7' },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stderr.split('\n')[0], "Astrid couldn't start. Run /installed/Astrid/start --verbose to see why.");
});

test('a failed app start recommends a portable verbose npm command', async () => {
  const result = await launcherEnds({
    configuredOrigin: 'https://hosted.test',
    env: { FAKE_NPM_VITE_EXIT: '7' },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stderr.split('\n')[0], "Astrid couldn't start. Run npm run dev:local -- --verbose to see why.");
});

test('a machine without Astrid set up points to the install guide, and every error line names Astrid once', async () => {
  const fixture = await launchFixture();
  try {
    const result = await run(['--check'], { ...fixture.env, ASTRID_WORKSPACE_DISCOVERY: join(fixture.fixture, 'no-such-dir', 'discovery.json') });
    assert.equal(result.code, 1);
    const lines = result.stderr.split('\n');
    assert.equal(lines[0], "Astrid isn't set up on this computer yet. Install guide: https://github.com/banodoco/astrid-agent/blob/main/docs/setup/local-source-install.md");
    assert.match(lines[1], /^Details: cannot read runtime discovery at .*discovery\.json: /);
    assert(!result.stderr.includes('dev:local:'), result.stderr);
    assert.equal(result.stdout, '');
  } finally { await fixture.close(); }
});

test('a stopped Runtime points to the command that starts it', async () => {
  const fixture = await launchFixture();
  try {
    // The discovery file still names a Runtime, but nothing listens there any more.
    await new Promise(r => fixture.runtime.close(r));
    const noHelperDirectory = join(fixture.fixture, 'pinokio-entry');
    const withHelperDirectory = join(fixture.fixture, 'installed-entry');
    mkdirSync(noHelperDirectory);
    mkdirSync(withHelperDirectory);
    const withEnv = join(withHelperDirectory, 'with-env');
    writeFileSync(withEnv, '');
    const cases = [
      ['default CLI', {}, "Astrid's engine isn't running. Start it first: astrid-runtime up --profile astrid", false],
      ['missing with-env', { ASTRID_START_COMMAND: join(noHelperDirectory, 'start') }, "Astrid's engine isn't running. Start it first: astrid-runtime up --profile astrid", false],
      ['available with-env', { ASTRID_START_COMMAND: join(withHelperDirectory, 'start') }, `Astrid's engine isn't running. Start it first: ${shellQuote(withEnv)} astrid-runtime up --profile astrid`, true],
      ['Pinokio environment', { ASTRID_INSTALL_MANAGED_BY: 'pinokio' }, "Astrid's engine isn't running. Start Astrid in Pinokio.", false],
      ['Pinokio run entry', { ASTRID_START_COMMAND: join(noHelperDirectory, 'run') }, "Astrid's engine isn't running. Start Astrid in Pinokio.", false],
      ['Pinokio Windows run entry', { ASTRID_START_COMMAND: join(noHelperDirectory, 'run.cmd') }, "Astrid's engine isn't running. Start Astrid in Pinokio.", false],
    ];
    for (const [label, env, friendly, hasWithEnv] of cases) {
      const result = await run(['--check'], { ...fixture.env, ...env });
      assert.equal(result.code, 1, label);
      assert.equal(result.stderr.split('\n')[0], friendly, label);
      assert.match(result.stderr.split('\n')[1], /^Details: runtime is unavailable at http:\/\/127\.0\.0\.1:\d+ /, label);
      assert.equal(result.stderr.includes('with-env'), hasWithEnv, label);
    }
  } finally {
    await new Promise(r => fixture.door.close(r));
    rmSync(fixture.fixture, { recursive: true, force: true });
  }
});

test('a Pinokio Runtime that changed points back to Pinokio', async () => {
  const fixture = await launchFixture({ healthInstanceId: 'unexpected-runtime-instance' });
  try {
    const result = await launcherEnds({ fixture, env: { ASTRID_INSTALL_MANAGED_BY: 'pinokio' } });
    assert.equal(result.code, 1);
    assert.equal(result.stderr.split('\n')[0], 'Astrid changed on this computer. Stop and start Astrid in Pinokio.');
    assert.equal(result.stderr.split('\n')[1], 'Details: Runtime health instance does not match the selected Astrid profile');
  } finally { await fixture.close(); }
});

test('a Pinokio Runtime with an incompatible schema points to a Pinokio restart', async () => {
  const fixture = await launchFixture({ healthProtocol: 'workspace.v0' });
  try {
    const result = await launcherEnds({ fixture, env: { ASTRID_INSTALL_MANAGED_BY: 'pinokio' } });
    assert.equal(result.code, 1);
    assert.match(result.stderr.split('\n')[0], /; restart: Stop and start Astrid in Pinokio$/);
  } finally { await fixture.close(); }
});

test('the launcher accepts every page-compatible digest from health and handshake', async () => {
  for (const digest of RUNTIME_ACCEPTED_SCHEMA_DIGESTS) {
    for (const endpoint of ['health', 'handshake']) {
      const fixture = await launchFixture({ [`${endpoint}Digest`]: digest });
      try {
        const result = await launcherEnds({ fixture, args: ['--check'] });
        assert.equal(result.code, 0, `${endpoint} ${digest}: ${result.stderr}`);
        assert.equal(result.spawned, '', `${endpoint} ${digest}: app unexpectedly spawned during --check`);
        assert.deepEqual(runtimeCliCalls(fixture), []);
      } finally { await fixture.close(); }
    }
  }
});

test('health and handshake schema mismatches include A1 source action and stop before app start', async () => {
  for (const [endpoint, digest] of [
    ['health', 'sha256:unsupported-health'],
    ['handshake', 'sha256:unsupported-handshake'],
    ['health', undefined],
    ['handshake', ''],
  ]) {
    const fixture = await launchFixture({ [`${endpoint}Digest`]: digest });
    try {
      const result = await launcherEnds({ fixture });
      assert.equal(result.code, 1, `${endpoint} ${digest}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(SOURCE_SCHEMA_MISMATCH_ACTION));
      assert.match(result.stderr, /App workspace\.v1 schema sha256:[0-9a-f]+/);
      assert.match(result.stderr, /restart: astrid-runtime restart --profile astrid --data-root/);
      assert.equal(result.spawned, '', `${endpoint} ${digest}: app/bridge spawned`);
      assert.deepEqual(runtimeCliCalls(fixture), []);
    } finally { await fixture.close(); }
  }
});

function assertOpenAfterStart(started) {
  assert.equal(started.stdout, HEALTHY_OUTPUT(`http://127.0.0.1:${started.env.PORT}/tools/video-editor`));
}

test('the launcher leaves agent chat registration and lifecycle to the Runtime', async () => {
  for (const args of [[], ['--acp']]) {
    const fixture = await launchFixture({ configuredOrigin: 'https://hosted.test' });
    const chatFile = join(fixture.fixture, 'chat.json');
    const registration = { endpoint: 'http://127.0.0.1:17335', token: 'agent-service-token' };
    writeFileSync(chatFile, JSON.stringify(registration), { mode: 0o600 });
    let started;
    try {
      started = await startLauncher({ fixture, args });
      assert(!readFileSync(started.spawnLog, 'utf8').includes('dev:astrid-acp'));
      assert.deepEqual(JSON.parse(readFileSync(chatFile, 'utf8')), registration);
      await started.stop();
      assert.deepEqual(JSON.parse(readFileSync(chatFile, 'utf8')), registration);
      assert(!started.stdout.includes(registration.token) && !started.stderr.includes(registration.token));
    } finally { if (started) await started.stop(); await fixture.close(); }
  }
});

test('the default keeps the hosted door available while opening the source editor', async () => {
  const started = await startLauncher({ shippedConfig: true, doorOrigin: 'https://astrid.haus' });
  try { assertOpenAfterStart(started); } finally { await started.stop(); }
});

test('ASTRID_APP_LOOPBACK_ORIGIN=off requires no door and prints no Open line, even with a configured origin', async () => {
  const started = await startLauncher({ configuredOrigin: 'https://astrid.haus', env: { ASTRID_APP_LOOPBACK_ORIGIN: 'off' }, until: (stdout) => stdout.includes('fake-npm run dev --') });
  try {
    assert(!started.stdout.includes('browser door'), started.stdout);
    assert(!started.stdout.includes('Open '), started.stdout);
  } finally { await started.stop(); }
});

test('--check starts nothing, even with the production origin as the default', async () => {
  const fixture = await launchFixture({ configuredOrigin: 'https://astrid.haus' });
  try {
    const result = await run(['--check'], fixture.env);
    assert.equal(result.code, 0, result.stderr);
    assert(!result.stdout.includes('browser door'), result.stdout);
    assert(!result.stdout.includes('Open '), result.stdout);
    assert.equal(existsSync(fixture.spawnMarker), false, '--check must not start the door, ACP or Vite');
  } finally { await fixture.close(); }
});

test("a null configured origin keeps today's behaviour: no door unless one is given", async () => {
  const started = await startLauncher({ configuredOrigin: null, until: (stdout) => stdout.includes('fake-npm run dev --') });
  try {
    assert(!started.stdout.includes('browser door'), started.stdout);
    assert(!started.stdout.includes('Open '), started.stdout);
  } finally { await started.stop(); }
});

test('an explicit origin wins over the configured one, from ASTRID_APP_LOOPBACK_ORIGIN or --hosted-origin', async () => {
  const fromEnvironment = await startLauncher({ configuredOrigin: 'https://astrid.haus', doorOrigin: 'https://hosted.test', env: { ASTRID_APP_LOOPBACK_ORIGIN: 'https://hosted.test' } });
  try {
    assertOpenAfterStart(fromEnvironment);
    assert(!fromEnvironment.stdout.includes('astrid.haus'), fromEnvironment.stdout);
  } finally { await fromEnvironment.stop(); }
  const fromArgument = await startLauncher({ configuredOrigin: 'https://astrid.haus', doorOrigin: 'https://hosted.test', args: ['--hosted-origin', 'https://hosted.test'] });
  try {
    assertOpenAfterStart(fromArgument);
    assert(!fromArgument.stdout.includes('astrid.haus'), fromArgument.stdout);
  } finally { await fromArgument.stop(); }
});

test('ASTRID_APP_LOOPBACK_ORIGIN=off and --hosted-origin cannot both be set', async () => {
  const fixture = await launchFixture({ configuredOrigin: 'https://astrid.haus' });
  try {
    const result = await run(['--check', '--hosted-origin', 'https://hosted.test'], { ...fixture.env, ASTRID_APP_LOOPBACK_ORIGIN: 'off' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot both be set/);
    assert.equal(existsSync(fixture.spawnMarker), false);
  } finally { await fixture.close(); }
});

test('a broken hosted origin config stops the launch before the Runtime is checked', async () => {
  const cases = [
    ['not JSON', { hostedOriginConfigRaw: 'origin: https://astrid.haus' }],
    ['no origin key', { hostedOriginConfigRaw: '{}' }],
    ['http origin', { configuredOrigin: 'http://astrid.haus' }],
    ['trailing slash', { configuredOrigin: 'https://astrid.haus/' }],
    ['non-string origin', { hostedOriginConfigRaw: '{"origin": 7}' }],
    ['missing file', { hostedOriginConfigPath: '/astrid-no-such-dir/hosted-origin.json' }],
  ];
  for (const [label, overrides] of cases) {
    const fixture = await launchFixture(overrides);
    try {
      const result = await run(['--check'], fixture.env);
      assert.equal(result.code, 1, `${label}: expected failure`);
      assert.match(result.stderr, /hosted origin/, label);
      assert(!result.stdout.includes('runtime healthy'), `${label}: reached the Runtime check`);
      assert.equal(existsSync(fixture.spawnMarker), false, `${label}: launched a child`);
    } finally { await fixture.close(); }
  }
});

test('an explicit origin does not read a broken config', async () => {
  const fixture = await launchFixture({ hostedOriginConfigRaw: 'not JSON' });
  try {
    const result = await run(['--check'], { ...fixture.env, ASTRID_APP_LOOPBACK_ORIGIN: 'https://hosted.test' });
    assert.equal(result.code, 0, result.stderr);
  } finally { await fixture.close(); }
});

test('normal launch auto-starts with the selected Runtime, Astrid, data root and source manifest', async () => {
  const fixture = await launchFixture({ discoveryState: 'missing' });
  const dataRoot = join(fixture.fixture, 'selected-data');
  const ambientRoot = join(fixture.fixture, 'ambient-data');
  const runtimeCheckout = join(fixture.fixture, 'Runtime');
  const astridCheckout = join(fixture.fixture, 'Astrid');
  const sourceManifest = join(fixture.fixture, 'source-manifest.json');
  mkdirSync(join(runtimeCheckout, '.venv', 'bin'), { recursive: true });
  mkdirSync(astridCheckout);
  writeFileSync(sourceManifest, '{}\n');
  writeFileSync(join(runtimeCheckout, '.venv', 'bin', 'python'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const result = spawnSync('astrid-runtime', process.argv.slice(4), { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  let started;
  try {
    started = await startLauncher({
      fixture,
      args: ['--data-root', dataRoot, '--runtime', runtimeCheckout, '--astrid', astridCheckout, '--source-manifest', sourceManifest],
      env: { ASTRID_APP_LOOPBACK_ORIGIN: 'off', ASTRID_RUNTIME_DATA_ROOT: ambientRoot },
    });
    assert.deepEqual(runtimeCliCalls(fixture).map(({ action }) => action), ['up']);
    assert.deepEqual(runtimeCliCalls(fixture)[0].args, [
      'up', '--profile', 'astrid', '--data-root', dataRoot, '--source-manifest', sourceManifest, '--hosted-origin', 'off', '--json',
    ]);
    assert.equal(runtimeCliCalls(fixture)[0].cwd, realpathSync(runtimeCheckout));
    assert.equal(JSON.parse(readFileSync(fixture.env.FAKE_RUNTIME_APP_ENV, 'utf8')).astridCheckout, astridCheckout);
    const childEnvironment = JSON.parse(readFileSync(fixture.env.FAKE_RUNTIME_APP_ENV, 'utf8'));
    assert.equal(childEnvironment.dataRoot, dataRoot);
    assert.equal(childEnvironment.supportRoot, dataRoot);
    assert.equal(childEnvironment.discovery, join(dataRoot, 'runtime', 'discovery.json'));
    assert.equal(childEnvironment.localUpdateStatus, '1');
    assert.equal(childEnvironment.viteLocalUpdateStatus, '1');
    assert.equal(existsSync(join(dataRoot, 'runtime', 'discovery.json')), true);
    assert.equal(existsSync(join(ambientRoot, 'runtime', 'discovery.json')), false);
    await started.stop();
    assert.deepEqual(runtimeCliCalls(fixture).map(({ action }) => action), ['up', 'down']);
    assert.deepEqual(runtimeCliCalls(fixture)[1].args, [
      'down', '--profile', 'astrid', '--data-root', dataRoot, '--source-manifest', sourceManifest, '--json',
    ]);
  } finally {
    if (started) await started.stop();
    await fixture.close();
  }
});

test('Runtime environment selectors choose temporary data, checkout, Python, source manifest and Astrid paths', async () => {
  const fixture = await launchFixture({ discoveryState: 'missing' });
  const dataRoot = join(fixture.fixture, 'env-selected-data');
  const runtimeCheckout = join(fixture.fixture, 'Runtime env checkout');
  const astridCheckout = join(fixture.fixture, 'Astrid env checkout');
  const runtimePython = join(fixture.fixture, 'python with spaces');
  const sourceManifest = join(fixture.fixture, 'env-source-manifest.json');
  mkdirSync(runtimeCheckout);
  mkdirSync(astridCheckout);
  writeFileSync(sourceManifest, '{}\n');
  writeFileSync(runtimePython, `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const result = spawnSync('astrid-runtime', process.argv.slice(4), { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  let started;
  try {
    started = await startLauncher({
      fixture,
      env: {
        ASTRID_APP_LOOPBACK_ORIGIN: 'off',
        ASTRID_RUNTIME_DATA_ROOT: dataRoot,
        ASTRID_RUNTIME_CHECKOUT: runtimeCheckout,
        ASTRID_RUNTIME_PYTHON: runtimePython,
        ASTRID_RUNTIME_SOURCE_MANIFEST: sourceManifest,
        ASTRID_CHECKOUT: astridCheckout,
        ASTRID_WORKSPACE_DISCOVERY: join(dataRoot, 'runtime', 'discovery.json'),
      },
    });
    assert.deepEqual(runtimeCliCalls(fixture).map(({ action }) => action), ['up']);
    assert.deepEqual(runtimeCliCalls(fixture)[0].args, [
      'up', '--profile', 'astrid', '--data-root', dataRoot, '--source-manifest', sourceManifest, '--hosted-origin', 'off', '--json',
    ]);
    assert.equal(runtimeCliCalls(fixture)[0].cwd, realpathSync(runtimeCheckout));
    assert.equal(runtimeCliCalls(fixture)[0].astridCheckout, astridCheckout);
    await started.stop();
    assert.deepEqual(runtimeCliCalls(fixture).map(({ action }) => action), ['up', 'down']);
    assert.equal(runtimeCliCalls(fixture)[1].astridCheckout, astridCheckout);
  } finally { if (started) await started.stop(); await fixture.close(); }
});

test('a Runtime data root conflicting with legacy discovery is rejected before attach or CLI control', async () => {
  const fixture = await launchFixture();
  try {
    const result = await launcherEnds({
      fixture,
      args: ['--check'],
      env: { ASTRID_RUNTIME_DATA_ROOT: join(fixture.fixture, 'other-data-root') },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /ASTRID_WORKSPACE_DISCOVERY and ASTRID_RUNTIME_DATA_ROOT select different roots/);
    assert.deepEqual(runtimeCliCalls(fixture), []);
    assert.equal(result.spawned, '');
  } finally { await fixture.close(); }
});

test('a compatible live Runtime is attached without CLI up or down', async () => {
  const fixture = await launchFixture();
  let started;
  try {
    started = await startLauncher({ fixture, env: { ASTRID_APP_LOOPBACK_ORIGIN: 'off' } });
    assert.deepEqual(runtimeCliCalls(fixture), []);
    await started.stop();
    assert.deepEqual(runtimeCliCalls(fixture), []);
  } finally { if (started) await started.stop(); await fixture.close(); }
});

test('missing and stale discovery plus a dead endpoint trigger up, then full Runtime validation', async () => {
  for (const discoveryState of ['missing', 'stale']) {
    const fixture = await launchFixture({ discoveryState });
    let started;
    try {
      started = await startLauncher({ fixture, env: { ASTRID_APP_LOOPBACK_ORIGIN: 'off' } });
      assert.deepEqual(runtimeCliCalls(fixture).map(({ action }) => action), ['up']);
      assert.deepEqual(fixture.requests.slice(-3).map(({ method, path }) => `${method} ${path}`), [
        'GET /v1/health', 'POST /v1/handshake', 'GET /v1/realm',
      ]);
      await started.stop();
      assert.deepEqual(runtimeCliCalls(fixture).map(({ action }) => action), ['up', 'down']);
    } finally { if (started) await started.stop(); await fixture.close(); }
  }

  const dead = await launchFixture();
  let started;
  try {
    const staleEndpoint = JSON.parse(dead.discoveryDocument);
    staleEndpoint.endpoint = `http://127.0.0.1:${await freePort()}`;
    writeFileSync(dead.discovery, JSON.stringify(staleEndpoint));
    started = await startLauncher({ fixture: dead, env: { ASTRID_APP_LOOPBACK_ORIGIN: 'off' } });
    assert.deepEqual(runtimeCliCalls(dead).map(({ action }) => action), ['up']);
    await started.stop();
    assert.deepEqual(runtimeCliCalls(dead).map(({ action }) => action), ['up', 'down']);
  } finally { if (started) await started.stop(); await dead.close(); }
});

test('an exited Runtime owner PID is treated as stale discovery and replaced by up', async () => {
  const fixture = await launchFixture();
  const exitedOwner = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: cleanInheritedEnvironment() });
  const deadPid = exitedOwner.pid;
  await new Promise((resolveExit) => exitedOwner.once('exit', resolveExit));
  try {
    writeFileSync(fixture.discovery, JSON.stringify({ ...JSON.parse(fixture.discoveryDocument), pid: deadPid }));
    const started = await startLauncher({ fixture, env: { ASTRID_APP_LOOPBACK_ORIGIN: 'off' } });
    assert.deepEqual(runtimeCliCalls(fixture).map(({ action }) => action), ['up']);
    await started.stop();
    assert.deepEqual(runtimeCliCalls(fixture).map(({ action }) => action), ['up', 'down']);
  } finally { await fixture.close(); }
});

test('live protocol, schema and scope incompatibilities stop before app start with an actionable one-line diagnostic', async () => {
  const expectedDigest = readGeneratedSchemaDigest(resolve('src/integrations/runtime/generated-contract-metadata.ts'));
  const cases = [
    ['protocol', { healthProtocol: 'workspace.v0' }, 'workspace.v0'],
    ['schema', { healthDigest: 'sha256:runtime-old-schema' }, 'sha256:runtime-old-schema'],
    ['scopes', { handshakeScopes: ['handshake', 'projects:read', 'projects:write', 'objects:read', 'objects:write', 'tasks:read', 'tasks:write', 'admin'] }, 'workspace.v1'],
  ];
  for (const [label, overrides, actual] of cases) {
    const fixture = await launchFixture(overrides);
    const runtimeEnv = { ASTRID_APP_LOOPBACK_ORIGIN: 'off' };
    let expectedRestart;
    try {
      if (label === 'protocol') {
        const dataRoot = join(fixture.fixture, "data root's");
        const runtimeCheckout = join(fixture.fixture, "Runtime checkout's");
        const runtimePython = join(fixture.fixture, "Python runner's");
        const sourceManifest = join(fixture.fixture, "source manifest's.json");
        const discoveryDirectory = join(dataRoot, 'runtime');
        mkdirSync(discoveryDirectory, { recursive: true });
        writeFileSync(join(discoveryDirectory, 'discovery.json'), fixture.discoveryDocument);
        writeFileSync(join(discoveryDirectory, 'catalog.json'), readFileSync(fixture.catalog, 'utf8'));
        const shellQuote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
        runtimeEnv.ASTRID_RUNTIME_DATA_ROOT = dataRoot;
        runtimeEnv.ASTRID_WORKSPACE_DISCOVERY = join(discoveryDirectory, 'discovery.json');
        runtimeEnv.ASTRID_RUNTIME_CHECKOUT = runtimeCheckout;
        runtimeEnv.ASTRID_RUNTIME_PYTHON = runtimePython;
        runtimeEnv.ASTRID_RUNTIME_SOURCE_MANIFEST = sourceManifest;
        expectedRestart = `restart: cd ${shellQuote(runtimeCheckout)} && ${shellQuote(runtimePython)} -m astrid_runtime.cli restart --profile astrid --data-root ${shellQuote(dataRoot)} --source-manifest ${shellQuote(sourceManifest)}`;
      }
      const result = await launcherEnds({ fixture, env: runtimeEnv });
      assert.equal(result.code, 1, `${label}: ${result.stderr}`);
      const lines = result.stderr.trim().split('\n');
      assert.equal(lines.length, 1, `${label}: ${result.stderr}`);
      assert.match(lines[0], new RegExp(actual.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(lines[0], /App workspace\.v1 schema/);
      assert.match(lines[0], new RegExp(expectedDigest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      if (expectedRestart) assert(lines[0].includes(expectedRestart), lines[0]);
      else assert.match(lines[0], /restart: astrid-runtime restart --profile astrid --data-root/);
      assert.deepEqual(runtimeCliCalls(fixture), []);
      assert.equal(result.spawned, '', `${label}: app/bridge spawned`);
    } finally { await fixture.close(); }
  }
});

test('only a Runtime newly started by this launcher is stopped on exit', async () => {
  for (const status of ['started', 'reconnected']) {
    const fixture = await launchFixture({ discoveryState: 'missing' });
    let started;
    try {
      started = await startLauncher({ fixture, env: { ASTRID_APP_LOOPBACK_ORIGIN: 'off', FAKE_RUNTIME_UP_STATUS: status } });
      await started.stop();
      assert.deepEqual(runtimeCliCalls(fixture).map(({ action }) => action), status === 'started' ? ['up', 'down'] : ['up']);
    } finally { if (started) await started.stop(); await fixture.close(); }
  }
});

test('shutdown stops Vite and bridge services before Runtime down', async () => {
  const fixture = await launchFixture({ discoveryState: 'missing' });
  let started;
  try {
    started = await startLauncher({ fixture, args: ['--acp'], env: { ASTRID_APP_LOOPBACK_ORIGIN: 'off' } });
    await started.stop();
    const lifecycle = readFileSync(fixture.env.FAKE_RUNTIME_LIFECYCLE_LOG, 'utf8').trim().split('\n');
    assert(lifecycle.includes('vite:start'), lifecycle.join('\n'));
    assert.equal(lifecycle.indexOf('acp:stop'), -1, 'chat is owned by the Runtime');
    const down = lifecycle.find((line) => line.startsWith('runtime:down '));
    assert(down, lifecycle.join('\n'));
    // taskkill forcibly terminates Windows children; their signal handlers cannot log a stop.
    if (process.platform === 'win32') assert.equal(lifecycle.includes('vite:stop'), false);
    else assert(lifecycle.indexOf('vite:stop') >= 0 && lifecycle.indexOf('vite:stop') < lifecycle.indexOf(down), lifecycle.join('\n'));
    assert.equal(down, 'runtime:down viteOpen=false proxyOpen=false');
  } finally { if (started) await started.stop(); await fixture.close(); }
});

test('startup timeout closes the real child/grandchild server and inherited pipes on native platforms', { timeout: 20_000 }, async () => {
  const fixture = await launchFixture({ configuredOrigin: 'https://hosted.test' });
  const pidsFile = join(fixture.fixture, 'tree-pids');
  const ready = join(fixture.fixture, 'tree-ready');
  // The Runtime passes validation, but its browser door becomes unavailable.
  // That startup failure triggers shutdown internally, without console Ctrl+C.
  await new Promise((resolve) => fixture.door.close(resolve));
  let started;
  const pids = () => existsSync(pidsFile) ? readFileSync(pidsFile, 'utf8').trim().split('\n').map(Number) : [];
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  try {
    started = await startLauncher({ fixture, args: ['--verbose'], env: { FAKE_NPM_TREE_PIDS: pidsFile, FAKE_NPM_TREE_READY: ready }, until: () => existsSync(ready) });
    assert.equal(pids().length, 3, 'the owned process must have a real child and grandchild');
    assert(pids().every(alive), 'all three processes must be alive before cleanup');
    assert.equal(await (await fetch(`http://127.0.0.1:${started.env.PORT}`)).text(), 'descendant server');
    const deadline = Date.now() + 10_000;
    while (started.child.exitCode === null || pids().some(alive)) {
      assert(Date.now() < deadline, `tree cleanup did not finish: ${started.seen.stdout}${started.seen.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await started.closed;
    assert.equal(started.child.exitCode, 1, started.seen.stderr);
    assert.match(started.seen.stderr, /nothing listened on/);
    await assert.rejects(fetch(`http://127.0.0.1:${started.env.PORT}`, { signal: AbortSignal.timeout(1000) }));
    await assert.rejects(fetch(`http://127.0.0.1:${started.env.VITE_ASTRID_DYNAMIC_PROXY_PORT}`, { signal: AbortSignal.timeout(1000) }));
  } finally {
    for (const pid of pids()) if (alive(pid)) await terminateProcessTree({ pid, exitCode: null, signalCode: null });
    if (started) await started.stop();
    await fixture.close();
  }
});

test('SIGINT stops services and then shuts down the Runtime this launcher started', async () => {
  const fixture = await launchFixture({ discoveryState: 'missing' });
  let started;
  try {
    started = await startLauncher({ fixture, env: { ASTRID_APP_LOOPBACK_ORIGIN: 'off' } });
    await started.signal('SIGINT');
    assert.deepEqual(runtimeCliCalls(fixture).map(({ action }) => action), ['up', 'down']);
    const lifecycle = readFileSync(fixture.env.FAKE_RUNTIME_LIFECYCLE_LOG, 'utf8').trim().split('\n');
    assert(lifecycle.includes('vite:start'), lifecycle.join('\n'));
    const down = lifecycle.find((line) => line.startsWith('runtime:down '));
    assert(down, lifecycle.join('\n'));
    if (process.platform === 'win32') assert.equal(lifecycle.includes('vite:stop'), false);
    else assert(lifecycle.indexOf('vite:stop') >= 0 && lifecycle.indexOf('vite:stop') < lifecycle.indexOf(down), lifecycle.join('\n'));
    assert.equal(down, 'runtime:down viteOpen=false proxyOpen=false');
  } finally { if (started) await started.stop(); await fixture.close(); }
});

test('SIGINT during Runtime up waits for ownership handoff, then brings that Runtime down before app startup', async () => {
  const fixture = await launchFixture({ discoveryState: 'missing' });
  const startedMarker = join(fixture.fixture, 'up-waiting');
  const releaseFile = join(fixture.fixture, 'release-up');
  writeFileSync(releaseFile, 'hold');
  let started;
  try {
    started = await startLauncher({
      fixture,
      env: {
        ASTRID_APP_LOOPBACK_ORIGIN: 'off',
        FAKE_RUNTIME_UP_STARTED_FILE: startedMarker,
        FAKE_RUNTIME_UP_RELEASE_FILE: releaseFile,
      },
      until: () => existsSync(startedMarker),
    });
    assert.deepEqual(runtimeCliCalls(fixture).map(({ action }) => action), ['up']);
    if (process.platform === 'win32') await started.requestSignal('SIGINT');
    else process.kill(-started.child.pid, 'SIGINT');
    appendFileSync(releaseFile, ' release Runtime up');
    await started.closed;
    assert.equal(started.child.exitCode, 130, started.seen.stderr);
    assert.deepEqual(runtimeCliCalls(fixture).map(({ action }) => action), ['up', 'down']);
    assert.equal(readFileSync(started.spawnLog, 'utf8'), '', 'Vite and ACP must not start after interrupted up');
    assert.equal(readFileSync(fixture.env.FAKE_RUNTIME_LIFECYCLE_LOG, 'utf8'), 'runtime:down viteOpen=false proxyOpen=false\n', 'only Runtime down should run');
  } finally {
    if (started && started.child.exitCode === null) {
      appendFileSync(releaseFile, ' release Runtime up');
      await started.signal('SIGINT');
    }
    await fixture.close();
  }
});

test('Runtime identity replacement prevents the launcher from stopping the replacement', async () => {
  const fixture = await launchFixture({ discoveryState: 'missing' });
  let started;
  try {
    started = await startLauncher({ fixture, env: { ASTRID_APP_LOOPBACK_ORIGIN: 'off' } });
    const replacement = JSON.parse(fixture.discoveryDocument);
    replacement.runtime_instance_id = 'replacement-instance';
    writeFileSync(join(fixture.fixture, 'runtime', 'discovery.json'), JSON.stringify(replacement));
    await started.stop();
    assert.deepEqual(runtimeCliCalls(fixture).map(({ action }) => action), ['up']);
  } finally { if (started) await started.stop(); await fixture.close(); }
});

test('--check and --build do not auto-start a missing Runtime', async () => {
  const fixture = await launchFixture({ discoveryState: 'missing' });
  try {
    for (const args of [['--check'], ['--build']]) {
      const result = await launcherEnds({ fixture, args });
      assert.equal(result.code, 1);
      assert.deepEqual(runtimeCliCalls(fixture), []);
      assert.equal(result.spawned, '', `${args[0]} launched an app child`);
    }
  } finally { await fixture.close(); }
});

test('a failed Runtime up leaves the App and bridges stopped', async () => {
  const fixture = await launchFixture({ discoveryState: 'missing' });
  try {
    const result = await launcherEnds({ fixture, env: { FAKE_RUNTIME_UP_EXIT: '1' } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Runtime up failed: fake Runtime CLI failure/);
    assert.deepEqual(runtimeCliCalls(fixture).map(({ action }) => action), ['up']);
    assert.equal(result.spawned, '');
    assert.equal(readFileSync(fixture.env.FAKE_RUNTIME_LIFECYCLE_LOG, 'utf8'), '');
  } finally { await fixture.close(); }
});

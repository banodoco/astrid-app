import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { readGeneratedSchemaDigest } from './runtime-schema-guard.mjs';

const execFileAsync = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = join(REPO, 'scripts/dev-local-workspace.mjs');
const UPDATE_CLI = join(REPO, 'scripts/local-update.mjs');
const digest = readGeneratedSchemaDigest(join(REPO, 'src/integrations/runtime/generated-contract-metadata.ts'));
const actorId = 'astrid-product-update-test';
const realmId = 'realm-update-test';
const runtimeInstanceId = 'runtime-update-test';
const token = 'synthetic-update-runtime-token';
const TEST_ENV_KEYS = [
  'BANODOCO_LOCAL_DATA_ROOT', 'BANODOCO_LOCAL_SOURCE_MANIFEST', 'ASTRID_LOCAL_DATA_ROOT',
  'ASTRID_RUNTIME_DATA_ROOT', 'ASTRID_LOCAL_SOURCE_MANIFEST', 'BANODOCO_RUNTIME_DATA_ROOT',
  'ASTRID_DATA_ROOT', 'ASTRID_SUPPORT_ROOT', 'ASTRID_RUNTIME_PYTHON', 'ASTRID_RUNTIME_CHECKOUT',
  'ASTRID_RUNTIME_SOURCE_MANIFEST', 'ASTRID_START_COMMAND', 'ASTRID_INSTALL_MANAGED_BY',
  'ASTRID_CHECKOUT', 'ASTRID_PUBLIC_CHECKOUT', 'ASTRID_APP_ACP_ENABLED', 'ASTRID_APP_PAIRED_RELAY_ORIGIN',
  'ASTRID_APP_LOOPBACK_ORIGIN', 'ASTRID_APP_HOSTED_ORIGIN_CONFIG', 'ASTRID_WORKSPACE_DISCOVERY',
];
const git = async (cwd, ...args) => execFileAsync('git', args, { cwd, encoding: 'utf8' });
const gitSha = async (cwd, ref = 'HEAD') => (await git(cwd, 'rev-parse', ref)).stdout.trim();

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.listen(0, '127.0.0.1', resolveListen).once('error', reject));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return String(port);
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, { encoding: 'utf8', ...options });
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function writeFileTree(root, relative, contents, mode) {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, mode ? { mode } : undefined);
}

const preloader = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
const originalSpawn = childProcess.spawn;
const samePath = (left, right) => typeof left === 'string' && typeof right === 'string' && resolve(left) === resolve(right);
childProcess.spawn = (command, args = [], options) => {
  if (samePath(String(command), process.env.FAKE_BACKEND_PYTHON_PATH) && args[0] === '-I' && args[1] === '-m') {
    return originalSpawn(process.execPath, [process.env.FAKE_PYTHON_SCRIPT, ...args], options);
  }
  return originalSpawn(command, args, options);
};
syncBuiltinESMExports();
import fs from 'node:fs';
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  if (String(input) === 'https://astrid.haus/build.json') {
    return Promise.resolve(new Response(process.env.FAKE_SERVED_BUILD, { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }
  return originalFetch(input, options);
};
`;

const fakeNpm = `
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ cwd: process.cwd(), args, runtimeNode: process.execPath, viteAppBuild: process.env.VITE_APP_BUILD || null, railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null }) + '\\n');
if (args.includes('ci')) {
  fs.mkdirSync(path.join(process.cwd(), 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'fixture-installed.txt'), 'installed');
  process.exit(0);
}
if (args[0] === 'run' && args[1] === 'build') {
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/install-manifest.json'), 'utf8'));
  const app = process.env.VITE_APP_BUILD || process.env.RAILWAY_GIT_COMMIT_SHA;
  if (app !== process.env.RAILWAY_GIT_COMMIT_SHA) throw new Error('VITE and RAILWAY build ids differ');
  const dist = path.join(process.cwd(), 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'build.json'), JSON.stringify({ app, release: manifest.release }));
  fs.writeFileSync(path.join(dist, 'index.html'), '<div id="root"></div>');
  fs.writeFileSync(path.join(dist, 'assets', 'index-fixture.js'), '');
  process.exit(0);
}
const preview = args.includes('preview');
const mode = preview ? 'preview' : 'dev';
const outDir = preview ? args[args.indexOf('--outDir') + 1] : path.join(process.cwd(), 'dist');
fs.appendFileSync(process.env.FAKE_VITE_LOG, JSON.stringify({ mode, cwd: process.cwd(), outDir, pid: process.pid }) + '\\n');
const server = http.createServer((request, response) => {
  if (request.url === '/build.json') {
    try { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(fs.readFileSync(path.join(outDir, 'build.json'))); }
    catch { response.writeHead(404); response.end(); }
    return;
  }
  if (request.url === '/runtime-config/v1/workspace.json') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ realmId: process.env.VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID }));
    return;
  }
  response.writeHead(404); response.end();
});
server.listen(Number(process.env.PORT), '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
setInterval(() => {}, 1000);
`;

const fakePython = `
(async () => {
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const args = process.argv.slice(2);
const moduleName = args[args.indexOf('-m') + 1];
if (moduleName === 'astrid_runtime.cli') {
  console.log(JSON.stringify({ status: 'ok' }));
  process.exit(0);
}
const backendRoot = args[args.indexOf('--root') + 1];
const journalPath = path.join(backendRoot, 'update-transaction.json');
const releasePath = process.env.FAKE_RUNTIME_RELEASE_FILE;
const log = (entry) => fs.appendFileSync(process.env.FAKE_BACKEND_LOG, JSON.stringify(entry) + '\\n');
const input = readline.createInterface({ input: process.stdin });
const iterator = input[Symbol.asyncIterator]();
const version = (release) => ({ root: path.join(backendRoot, 'versions', release === 1 ? 'v1' : 'v2'), python: process.env.ASTRID_RUNTIME_PYTHON, profile: 'astrid', env: { ASTRID_NODE_EXECUTABLE: process.env.FAKE_NODE_EXECUTABLE }, identity: { release, managed_by: null } });
const sendHook = async (id, name, app, release, rollback = false) => {
  process.stdout.write(JSON.stringify({ id, hook: name, app, version: version(release), rollback }) + '\\n');
  const { value } = await iterator.next();
  if (!value) throw new Error('launcher ended callback stream');
  const reply = JSON.parse(value);
  if (!reply.ok) throw new Error(reply.error || 'hook failed');
};
const first = await iterator.next();
if (!first.value) process.exit(2);
const action = JSON.parse(first.value);
log({ action: action.action, pid: process.pid });
if (action.action === 'recover') {
  let journal;
  try { journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch {}
  if (!journal || ['complete', 'rolled_back'].includes(journal.step) || journal.transaction_context?.owner !== 'local-update') {
    process.stdout.write(JSON.stringify({ result: { status: 'clean' } }) + '\\n');
    process.exit(0);
  }
  const app = journal.transaction_context.app;
  fs.writeFileSync(releasePath, '1');
  let id = 1;
  for (const name of ['stop-editor', 'restore-checkout', 'start-editor', 'verify-editor', 'release-app']) {
    await sendHook(id++, name, app, 1, name === 'start-editor' || name === 'verify-editor');
    if (name === 'release-app') {
      journal.step = 'rolled_back';
      fs.writeFileSync(journalPath, JSON.stringify(journal));
    }
  }
  process.stdout.write(JSON.stringify({ result: { status: 'recovered' } }) + '\\n');
  process.exit(0);
}
if (action.action !== 'update') process.exit(3);
const app = action.app;
const pending = { step: 'applying', transaction_context: { owner: 'local-update', app } };
fs.writeFileSync(journalPath, JSON.stringify(pending));
let id = 1;
for (const name of ['stop-editor', 'move-checkout']) await sendHook(id++, name, app, 2);
fs.writeFileSync(releasePath, '2');
await sendHook(id++, 'start-editor', app, 2);
if (process.env.FAKE_FAIL_AFTER_START === '1') {
  process.stdout.write(JSON.stringify({ error: 'simulated interruption after candidate start', step: 'verify-editor', code: 'simulated_failure' }) + '\\n');
  process.exit(0);
}
await sendHook(id++, 'verify-editor', app, 2);
await sendHook(id++, 'release-app', app, 2);
pending.step = 'complete';
fs.writeFileSync(journalPath, JSON.stringify(pending));
process.stdout.write(JSON.stringify({ result: { status: 'updated' } }) + '\\n');
process.exit(0);
})().catch((error) => { process.stderr.write(String(error.stack || error) + '\\n'); process.exit(1); });
`;

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'astrid-local-update-launcher-'));
  const app = join(root, 'app');
  const seed = join(root, 'seed');
  const remote = join(root, 'origin.git');
  const runtimeRoot = join(root, 'runtime');
  const versionRoot = join(runtimeRoot, 'versions', 'v1');
  const python = join(versionRoot, 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  const dataRoot = join(root, 'runtime-data');
  const discoveryPath = join(dataRoot, 'runtime', 'discovery.json');
  const credentialPath = join(root, 'runtime-credential.json');
  const realmRoot = join(root, 'realm-data');
  const preloadPath = join(root, 'fetch-preload.mjs');
  const npmPath = join(root, 'npm-cli.js');
  const nodeShim = join(root, process.platform === 'win32' ? 'pinned-node.exe' : 'pinned-node');
  const npmBin = join(root, 'bin');
  const fakePythonPath = join(root, 'fake-python.cjs');

  await run('git', ['init', '--bare', '--initial-branch=main', remote]);
  await run('git', ['init', '--initial-branch=main', seed]);
  await git(seed, 'config', 'user.name', 'Launcher Test');
  await git(seed, 'config', 'user.email', 'launcher-test@example.invalid');
  await writeFileTree(seed, 'README.md', 'launcher fixture\n');
  await writeFileTree(seed, '.gitignore', 'dist/\nnode_modules/\n');
  await writeFileTree(seed, 'public/install-manifest.json', '{"release":1}\n');
  await writeFileTree(seed, 'scripts/runtime-discovery-proxy.mjs', await readFile(join(REPO, 'scripts/runtime-discovery-proxy.mjs')));
  await writeFileTree(seed, 'config/vite/objectCachePolicy.mjs', await readFile(join(REPO, 'config/vite/objectCachePolicy.mjs')));
  await writeFileTree(seed, 'src/integrations/runtime/generated-contract-metadata.ts', await readFile(join(REPO, 'src/integrations/runtime/generated-contract-metadata.ts')));
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'old App');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', '-u', 'origin', 'main');
  await run('git', ['clone', remote, app]);
  await git(app, 'config', 'user.name', 'Launcher Test');
  await git(app, 'config', 'user.email', 'launcher-test@example.invalid');
  const oldSha = await gitSha(app);
  await writeFileTree(seed, 'public/install-manifest.json', '{"release":2}\n');
  await writeFileTree(seed, 'release.txt', 'target App\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'served release');
  await git(seed, 'push', 'origin', 'main');
  const targetSha = await gitSha(seed);
  await writeFileTree(app, 'dist/build.json', JSON.stringify({ app: oldSha, release: 1 }));
  await writeFileTree(app, 'dist/index.html', '<div id="root"></div>');
  await writeFileTree(app, 'dist/assets/index-old.js', '');
  await writeFileTree(app, 'node_modules/old.txt', 'old deps');
  const initialStage = (await git(app, 'status', '--porcelain')).stdout.trim();
  assert.equal(initialStage, '');

  await mkdir(join(runtimeRoot, 'versions', 'v1', 'bin'), { recursive: true });
  await mkdir(join(runtimeRoot, 'versions', 'v1', 'lib'), { recursive: true });
  await writeFileTree(runtimeRoot, 'install.json', JSON.stringify({ owner: 'haus.astrid.runtime', managed_by: null }));
  await writeFileTree(runtimeRoot, 'current', 'v1\n');
  await writeFileTree(versionRoot, 'version.json', JSON.stringify({ root: versionRoot, python, profile: 'astrid' }));
  await writeFile(fakePythonPath, fakePython);
  await copyFile(process.execPath, python);
  await chmod(python, 0o700);
  await copyFile(process.execPath, nodeShim);
  await chmod(nodeShim, 0o700);
  await writeFileTree(root, 'fetch-preload.mjs', preloader);
  await writeFileTree(root, 'npm-cli.js', fakeNpm);
  await mkdir(npmBin, { recursive: true });
  if (process.platform === 'win32') {
    await writeFile(join(npmBin, 'npm.cmd'), '@echo off\r\n');
    await copyFile(npmPath, join(npmBin, 'npm-cli.js'));
  } else await symlink(npmPath, join(npmBin, 'npm'));
  await writeFileTree(root, 'runtime-hosted-origin.json', '{"origin":null}\n');
  await writeFileTree(root, 'runtime-release.txt', '1');
  await writeFile(credentialPath, JSON.stringify({ version: 1, scope: 'astrid', actor_id: actorId, token }), { mode: 0o600 });
  await mkdir(realmRoot, { recursive: true });
  await mkdir(join(dataRoot, 'runtime'), { recursive: true });
  const catalog = join(dataRoot, 'runtime', 'catalog.json');
  await writeFileTree(dataRoot, 'runtime/catalog.json', JSON.stringify({
    selected_realm_id: realmId,
    realms: [{ realm_id: realmId, source_profile: 'astrid', data_root: realmRoot }],
  }));

  const runtime = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) return json(response, { error: 'unauthorized' }, 401);
    const path = request.url;
    if (path === '/v1/health') return json(response, {
      status: 'ok', protocol: 'workspace.v1', schema_digest: digest,
      runtime_instance_id: runtimeInstanceId,
      release: Number((await readFile(join(root, 'runtime-release.txt'), 'utf8')).trim()), managed_by: null,
    });
    if (path === '/v1/handshake') return json(response, {
      protocol: 'workspace.v1', schema_digest: digest, session_id: 'local-update-test-session',
      actor_id: actorId, realm_id: realmId,
      scopes: ['handshake', 'projects:read', 'projects:write', 'objects:read', 'objects:write', 'tasks:read', 'tasks:write'],
    });
    if (path === '/v1/realm') return json(response, { realm_id: realmId, display_name: 'Update Test Realm', version: 1, created_at: '2026-10-27T00:00:00Z' });
    json(response, { error: 'not found' }, 404);
  });
  await new Promise((resolveListen, reject) => runtime.listen(0, '127.0.0.1', resolveListen).once('error', reject));
  const discovery = {
    endpoint: `http://127.0.0.1:${runtime.address().port}`,
    credential_file: credentialPath,
    runtime_instance_id: runtimeInstanceId,
    active_realm: realmId,
    realm_root: realmRoot,
  };
  await writeFileTree(dataRoot, 'runtime/discovery.json', JSON.stringify(discovery));
  const appPort = await freePort();
  const proxyPort = await freePort();
  const runtimeReleasePath = join(root, 'runtime-release.txt');
  const inherited = { ...process.env };
  for (const key of TEST_ENV_KEYS) delete inherited[key];
  const env = {
    ...inherited,
    HOME: root,
    USERPROFILE: root,
    XDG_DATA_HOME: join(root, 'xdg'),
    PATH: `${npmBin}${delimiter}${process.env.PATH}`,
    PORT: appPort,
    ASTRID_RUNTIME_DATA_ROOT: dataRoot,
    ASTRID_SUPPORT_ROOT: dataRoot,
    ASTRID_WORKSPACE_DISCOVERY: discoveryPath,
    ASTRID_RUNTIME_PYTHON: python,
    ASTRID_APP_LOOPBACK_ORIGIN: 'off',
    ASTRID_APP_HOSTED_ORIGIN_CONFIG: join(root, 'runtime-hosted-origin.json'),
    VITE_ASTRID_DYNAMIC_PROXY_PORT: proxyPort,
    npm_execpath: npmPath,
    ASTRID_NODE_EXECUTABLE: nodeShim,
    NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
    FAKE_SERVED_BUILD: JSON.stringify({ app: targetSha, release: 2 }),
    FAKE_NPM_LOG: join(root, 'fake-npm.log'),
    FAKE_VITE_LOG: join(root, 'fake-vite.log'),
    FAKE_BACKEND_LOG: join(root, 'fake-backend.log'),
    FAKE_NODE_EXECUTABLE: nodeShim,
    FAKE_BACKEND_PYTHON_PATH: python,
    FAKE_PYTHON_SCRIPT: fakePythonPath,
    FAKE_RUNTIME_RELEASE_FILE: runtimeReleasePath,
  };
  await writeFileTree(root, 'fake-npm.log', '');
  await writeFileTree(root, 'fake-vite.log', '');
  await writeFileTree(root, 'fake-backend.log', '');
  for (const key of ['RAILWAY_GIT_COMMIT_SHA', 'VITE_APP_BUILD', 'ASTRID_RUNTIME_CHECKOUT', 'ASTRID_RUNTIME_SOURCE_MANIFEST', 'ASTRID_CHECKOUT', 'ASTRID_INSTALL_MANAGED_BY']) delete env[key];

  return {
    root, app, seed, remote, oldSha, targetSha, runtimeRoot, versionRoot, python, dataRoot, discoveryPath,
    runtime, env, runtimeReleasePath, catalog,
    async close() {
      await new Promise((resolveClose) => runtime.close(resolveClose));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function launch(fixture, args = []) {
  let commandArgs = [LAUNCHER, ...args];
  let stdio = ['ignore', 'pipe', 'pipe'];
  if (process.platform === 'win32') {
    const signalControl = join(fixture.root, 'launcher-signal-control.mjs');
    writeFileSync(signalControl, `process.on('message', signal => { process.emit(signal); process.send(signal); }); process.channel.unref();`);
    commandArgs = ['--import', signalControl, ...commandArgs];
    stdio = ['ignore', 'pipe', 'pipe', 'ipc'];
  }
  const child = spawn(process.execPath, commandArgs, { cwd: fixture.app, env: fixture.env, detached: process.platform !== 'win32', stdio });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  const closed = new Promise((resolveClose) => child.once('close', resolveClose));
  const waitFor = async (predicate, timeout = 25_000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (child.exitCode !== null) throw new Error(`launcher exited ${child.exitCode}: ${output.stdout}${output.stderr}`);
      if (Date.now() > deadline) throw new Error(`launcher did not become ready: ${output.stdout}${output.stderr}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    }
  };
  const sendSignal = async (signal) => {
    if (child.exitCode !== null) return;
    if (process.platform !== 'win32') { process.kill(-child.pid, signal); return; }
    await new Promise((resolveSignal, reject) => {
      child.once('message', resolveSignal);
      child.send(signal, (error) => { if (error) reject(error); });
    });
  };
  const stop = async () => {
    if (child.exitCode !== null) return closed;
    await sendSignal('SIGTERM');
    await closed;
  };
  return { child, output, closed, waitFor, stop, sendSignal };
}

async function invokeUpdate(fixture) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [UPDATE_CLI], { cwd: fixture.app, env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolveResult({ code, stdout, stderr }));
  });
}

async function invokeLauncher(fixture, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], { cwd: fixture.app, env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolveResult({ code, stdout, stderr }));
  });
}

async function waitForBuild(port, expectedApp, expectedRelease) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/build.json`, { signal: AbortSignal.timeout(500) });
      const build = await response.json();
      if (response.ok && build.app === expectedApp && build.release === expectedRelease) return build;
    } catch { /* Vite is restarting or not ready. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  throw new Error(`App build ${expectedApp}/${expectedRelease} did not become available`);
}

for (const mode of ['dev', 'preview']) {
  test(`running ${mode} launcher updates its App tree and restarts on the served build`, { timeout: 60_000 }, async (t) => {
    const fixture = await createFixture(); t.after(fixture.close);
    const args = mode === 'preview' ? ['--preview', '--preview-dir', join(fixture.app, 'dist')] : [];
    const started = launch(fixture, args); t.after(started.stop);
    await started.waitFor(() => started.output.stdout.includes('Local App:'));
    assert.deepEqual(await waitForBuild(fixture.env.PORT, fixture.oldSha, 1), { app: fixture.oldSha, release: 1 });
    const result = await invokeUpdate(fixture);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Astrid is updated and running/);
    assert.equal(await gitSha(fixture.app), fixture.targetSha);
    assert.deepEqual(await waitForBuild(fixture.env.PORT, fixture.targetSha, 2), { app: fixture.targetSha, release: 2 });
    const starts = (await readFile(fixture.env.FAKE_VITE_LOG, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.deepEqual(starts.map(({ mode: childMode }) => childMode), [mode, mode]);
    const calls = (await readFile(fixture.env.FAKE_NPM_LOG, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const candidateBuild = calls.find(({ args }) => args[0] === 'run' && args[1] === 'build');
    assert.equal(candidateBuild.viteAppBuild, fixture.targetSha);
    assert.equal(candidateBuild.railwayCommit, fixture.targetSha);
    assert.equal(candidateBuild.runtimeNode, fixture.env.ASTRID_NODE_EXECUTABLE);
    await started.stop();
  });
}

test('a new launcher controller recovers a retained failed activation before serving the old App again', { timeout: 90_000 }, async (t) => {
  const fixture = await createFixture(); t.after(fixture.close);
  fixture.env.FAKE_FAIL_AFTER_START = '1';
  const first = launch(fixture);
  t.after(first.stop);
  await first.waitFor(() => first.output.stdout.includes('Local App:'));
  await waitForBuild(fixture.env.PORT, fixture.oldSha, 1);
  const failed = await invokeUpdate(fixture);
  assert.equal(failed.code, 1, failed.stdout);
  assert.match(failed.stderr, /simulated interruption after candidate start/);
  assert.equal(await gitSha(fixture.app), fixture.targetSha);
  await waitForBuild(fixture.env.PORT, fixture.targetSha, 2);
  const journalPath = join(fixture.runtimeRoot, 'update-transaction.json');
  const pending = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(pending.step, 'applying');
  assert.equal(pending.transaction_context.owner, 'local-update');
  const retainedRoot = pending.transaction_context.app.preparationRoot;
  assert.equal(dirname(retainedRoot), fixture.runtimeRoot, 'recovery copies use the persistent program root');
  assert.equal(await readFile(join(retainedRoot, 'previous-dist', 'build.json'), 'utf8'), JSON.stringify({ app: fixture.oldSha, release: 1 }));
  await first.stop();

  delete fixture.env.FAKE_FAIL_AFTER_START;
  const second = launch(fixture);
  t.after(second.stop);
  await second.waitFor(() => second.output.stdout.includes('Local App:'));
  assert.equal(await gitSha(fixture.app), fixture.oldSha);
  assert.deepEqual(await waitForBuild(fixture.env.PORT, fixture.oldSha, 1), { app: fixture.oldSha, release: 1 });
  const recoveredJournal = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(recoveredJournal.step, 'rolled_back');
  await assert.rejects(readFile(retainedRoot), { code: 'ENOENT' });
  const backend = (await readFile(fixture.env.FAKE_BACKEND_LOG, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(backend.map(({ action }) => action), ['update', 'recover']);
  await second.stop();
});

test('the live launcher controller recovers a failed activation after its candidate editor exits', { timeout: 90_000 }, async (t) => {
  const fixture = await createFixture(); t.after(fixture.close);
  fixture.env.FAKE_FAIL_AFTER_START = '1';
  const first = launch(fixture);
  t.after(first.stop);
  await first.waitFor(() => first.output.stdout.includes('Local App:'));
  await waitForBuild(fixture.env.PORT, fixture.oldSha, 1);

  const failed = await invokeUpdate(fixture);
  assert.equal(failed.code, 1, failed.stdout);
  assert.match(failed.stderr, /simulated interruption after candidate start/);
  assert.equal(await gitSha(fixture.app), fixture.targetSha);
  const starts = (await readFile(fixture.env.FAKE_VITE_LOG, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(starts.length, 2);
  const candidate = starts[1];
  assert.equal(candidate.mode, 'dev');
  await new Promise((resolveExit, reject) => {
    try { process.kill(candidate.pid, 'SIGTERM'); }
    catch (error) { reject(error); return; }
    const deadline = Date.now() + 10_000;
    const poll = () => {
      try { process.kill(candidate.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') { resolveExit(); return; } reject(error); return; }
      if (Date.now() >= deadline) { reject(new Error(`candidate editor process ${candidate.pid} did not exit`)); return; }
      setTimeout(poll, 25);
    };
    poll();
  });

  const journalPath = join(fixture.runtimeRoot, 'update-transaction.json');
  const pending = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(pending.step, 'applying');
  const retainedRoot = pending.transaction_context.app.preparationRoot;
  const retry = await invokeUpdate(fixture);
  assert.equal(retry.code, 0, retry.stderr);
  assert.match(retry.stdout, /interrupted update was restored and Astrid is running/);
  assert.equal(await gitSha(fixture.app), fixture.oldSha);
  assert.deepEqual(await waitForBuild(fixture.env.PORT, fixture.oldSha, 1), { app: fixture.oldSha, release: 1 });
  assert.equal(await readFile(join(fixture.app, 'dist', 'build.json'), 'utf8'), JSON.stringify({ app: fixture.oldSha, release: 1 }));
  const recoveredJournal = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(recoveredJournal.step, 'rolled_back');
  await assert.rejects(readFile(retainedRoot), { code: 'ENOENT' });
  const backend = (await readFile(fixture.env.FAKE_BACKEND_LOG, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(backend.map(({ action }) => action), ['update', 'recover']);
  await first.stop();
});

test('a fresh preview launcher restores retained dist before validating its output directory', { timeout: 90_000 }, async (t) => {
  const fixture = await createFixture(); t.after(fixture.close);
  fixture.env.FAKE_FAIL_AFTER_START = '1';
  const previewArgs = ['--preview', '--preview-dir', join(fixture.app, 'dist')];
  const first = launch(fixture, previewArgs);
  t.after(first.stop);
  await first.waitFor(() => first.output.stdout.includes('Local App:'));
  const failed = await invokeUpdate(fixture);
  assert.equal(failed.code, 1, failed.stdout);
  await first.stop();

  const journalPath = join(fixture.runtimeRoot, 'update-transaction.json');
  const pending = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(pending.step, 'applying');
  const appContext = pending.transaction_context.app;
  const retainedRoot = appContext.preparationRoot;
  assert.equal(await readFile(join(retainedRoot, 'previous-dist', 'build.json'), 'utf8'), JSON.stringify({ app: fixture.oldSha, release: 1 }));

  // Model interruption after dist was retained but before a replacement was installed.
  const { rename } = await import('node:fs/promises');
  await rename(join(fixture.app, 'dist'), appContext.buildDir);
  await assert.rejects(readFile(join(fixture.app, 'dist', 'build.json')), { code: 'ENOENT' });
  delete fixture.env.FAKE_FAIL_AFTER_START;

  const second = launch(fixture, previewArgs);
  t.after(second.stop);
  await second.waitFor(() => second.output.stdout.includes('Local App:'));
  assert.equal(await gitSha(fixture.app), fixture.oldSha);
  assert.deepEqual(await waitForBuild(fixture.env.PORT, fixture.oldSha, 1), { app: fixture.oldSha, release: 1 });
  assert.equal(await readFile(join(fixture.app, 'dist', 'build.json'), 'utf8'), JSON.stringify({ app: fixture.oldSha, release: 1 }));
  const recoveredJournal = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(recoveredJournal.step, 'rolled_back');
  await assert.rejects(readFile(retainedRoot), { code: 'ENOENT' });
  const backend = (await readFile(fixture.env.FAKE_BACKEND_LOG, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(backend.map(({ action }) => action), ['update', 'recover']);
  await second.stop();
});

test('preview launcher still refuses a missing output directory without retained recovery state', { timeout: 60_000 }, async (t) => {
  const fixture = await createFixture(); t.after(fixture.close);
  await rm(join(fixture.app, 'dist'), { recursive: true, force: true });
  const result = await invokeLauncher(fixture, ['--preview', '--preview-dir', join(fixture.app, 'dist')]);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /--preview-dir does not exist/);
  assert.deepEqual((await readFile(fixture.env.FAKE_BACKEND_LOG, 'utf8')).trim(), '');
});

async function pageUpdate(fixture, token = undefined, requestId = 'a1'.repeat(16)) {
  const receipt = JSON.parse(await readFile(join(fixture.app, (await git(fixture.app, 'rev-parse', '--git-path', 'astrid-local-update.json')).stdout.trim()), 'utf8'));
  const body = JSON.stringify({ requestId });
  const response = await fetch(receipt.page.url, { method: 'POST', headers: {
    Origin: receipt.origin, Authorization: `Bearer ${token ?? receipt.page.token}`, 'Content-Type': 'application/json',
  }, body });
  return { receipt, status: response.status, body: await response.json() };
}

test('the page route updates through the launcher, restarts the fake editor on the new build and rotates its secret', { timeout: 60_000 }, async (t) => {
  const fixture = await createFixture(); t.after(fixture.close);
  const started = launch(fixture); t.after(started.stop);
  await started.waitFor(() => started.output.stdout.includes('Local App:'));
  await waitForBuild(fixture.env.PORT, fixture.oldSha, 1);
  const first = JSON.parse(await readFile(join(fixture.app, (await git(fixture.app, 'rev-parse', '--git-path', 'astrid-local-update.json')).stdout.trim()), 'utf8'));
  const wrongSecret = await pageUpdate(fixture, 'wrong');
  assert.equal(wrongSecret.status, 403);
  assert.equal(await gitSha(fixture.app), fixture.oldSha);

  const result = await pageUpdate(fixture);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result.status, 'updated');
  assert.equal(await gitSha(fixture.app), fixture.targetSha);
  assert.deepEqual(await waitForBuild(fixture.env.PORT, fixture.targetSha, 2), { app: fixture.targetSha, release: 2 });
  const starts = (await readFile(fixture.env.FAKE_VITE_LOG, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].pid, starts[1].pid);
  assert.throws(() => process.kill(starts[0].pid, 0), { code: 'ESRCH' }, 'the old editor was stopped before the update');
  const after = JSON.parse(await readFile(join(fixture.app, (await git(fixture.app, 'rev-parse', '--git-path', 'astrid-local-update.json')).stdout.trim()), 'utf8'));
  assert.notEqual(after.page.token, first.page.token, 'restarting the editor rotates the page secret');
  assert.equal((await pageUpdate(fixture, first.page.token, 'b2'.repeat(16))).status, 403);
  await started.stop();
});

test('the page route refuses overlapping local edits as dirty and leaves the tree and editor alone', { timeout: 60_000 }, async (t) => {
  const fixture = await createFixture(); t.after(fixture.close);
  const started = launch(fixture); t.after(started.stop);
  await started.waitFor(() => started.output.stdout.includes('Local App:'));
  await waitForBuild(fixture.env.PORT, fixture.oldSha, 1);
  await writeFile(join(fixture.app, 'public/install-manifest.json'), '{"release":1,"edited":true}\n');
  const refused = await pageUpdate(fixture);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.refusal, 'dirty');
  assert.equal(refused.body.code, 'local_edits_conflict');
  assert.equal(await gitSha(fixture.app), fixture.oldSha);
  assert.equal(await readFile(join(fixture.app, 'public/install-manifest.json'), 'utf8'), '{"release":1,"edited":true}\n');
  assert.equal((await readFile(fixture.env.FAKE_VITE_LOG, 'utf8')).trim().split('\n').length, 1, 'the editor was not restarted');
  await started.stop();
});

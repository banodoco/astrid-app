#!/usr/bin/env node

/**
 * Source-pinned launcher for the existing automatic-placement real-proxy gate.
 *
 * This file owns only preflight, child dependency resolution, and postflight.
 * The browser journey remains tests/e2e/local/auto-real-proxy.spec.ts; it is
 * intentionally not copied or reimplemented here.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REAL_PROXY_RUNTIME = Object.freeze({
  commit: '95bd3c5f6d00e9bc8cc8cbe5ef510b68ed660f3c',
  tree: 'd3a290b407fa61e6ab2d476f50c068073f70df00',
  version: '0.2.14',
  producerVersion: 'sha256:54205b3ecb55038e416b31af936c9af26afa30dc1b05da16157ee4d861fe05ac',
  schemaDigest: 'sha256:7d4afa05962b8cd61643213fc79cdde41e16046c4e2a777bd299b48af0f31816',
  componentManifest: 'sha256:1ad76db27c1d9716bb234f811bf63e1f5898cb3d5f9b835a821765e6cad895e5',
  artifactCount: 76,
});

export const REAL_PROXY_COMPOSITIONS = Object.freeze({
  App: Object.freeze({
    archive: 'banodoco-timeline-composition-0.0.13.tgz',
    sha256: 'sha256:9412ae25c306d5118241f4d631e8eecc6eef9b2fb5a98302d40938e9f6d54738',
    version: '0.0.13',
  }),
  Agent: Object.freeze({
    archive: 'banodoco-timeline-composition-0.0.12.tgz',
    sha256: 'sha256:0a7b61529099ce994f807c6d7b1078303a09e7c0219144cc4b07467977f0f1a3',
    version: '0.0.12',
  }),
  fileCount: 77,
});

export const REAL_PROXY_BROWSER = Object.freeze({
  version: '141.0.7390.37',
  executable: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  sha256: 'sha256:85918a9937192b78da8edb51c38a7af4920ac6bd9ba19939ecb0bb724d5a1a95',
});

export function normalAcpEnvironment(proxyPort) {
  return Object.freeze({
    VITE_ASTRID_ACP_BRIDGE_PORT: String(proxyPort),
    ASTRID_ACP_VIA_DISCOVERY_PROXY: '1',
  });
}

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const APP_METADATA = 'src/integrations/runtime/generated-contract-metadata.ts';
const AGENT_METADATA = 'astrid_runtime_client/contract_metadata.py';
const RUNNER = realpathSync(new URL(import.meta.url));
const SAFE_HTTP_FACT = /^[A-Za-z0-9._:/-]{1,160}$/;

function fail(message) {
  throw new Error(`[auto-real-proxy-main95] ${message}`);
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) fail(`${name} is required; no moving-repo default is allowed`);
  return value;
}

function requiredSha(env, name) {
  const value = required(env, name);
  if (!SHA.test(value)) fail(`${name} must be a full 40-character lowercase SHA`);
  return value;
}

function requiredDigest(env, name) {
  const value = required(env, name);
  if (!DIGEST.test(value)) fail(`${name} must be a sha256 digest`);
  return value;
}

function requiredDirectory(env, name) {
  const value = required(env, name);
  if (!path.isAbsolute(value)) fail(`${name} must be absolute`);
  if (!existsSync(value) || !statSync(value).isDirectory()) fail(`${name} must name an existing directory`);
  return realpathSync(value);
}

function requiredExecutable(env, name) {
  const value = required(env, name);
  if (!path.isAbsolute(value) || !existsSync(value) || !statSync(value).isFile()) fail(`${name} must name an absolute file`);
  try { accessSync(value, constants.X_OK); } catch { fail(`${name} must be executable`); }
  return value;
}

function git(root, ...args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    fail(`git ${args.join(' ')} failed in ${root}: ${error.message}`);
  }
}

function json(file, label) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { fail(`${label} is not valid JSON: ${error.message}`); }
}

function digest(file) {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

function sourceStatus(root, label) {
  const status = git(root, 'status', '--porcelain', '--untracked-files=normal');
  if (status) fail(`${label} source is dirty:\n${status}`);
  return status;
}

function safeHttpFact(value) {
  return typeof value === 'string' && SAFE_HTTP_FACT.test(value) ? value : undefined;
}

function safeHttpPath(value) {
  if (typeof value !== 'string') return undefined;
  let pathname = value;
  try { pathname = new URL(value).pathname; } catch { pathname = value.split(/[?#]/, 1)[0]; }
  return pathname.startsWith('/') && pathname.length <= 320 && !/[\u0000-\u001f\u007f]/.test(pathname) ? pathname : undefined;
}

export function resolveFailureRecordRoot(env, privateRoot, runRoot) {
  const recordRoot = env.TIMELINE_AUTO_REAL_PROXY_RECORD_DIR ?? path.join(privateRoot, 'recorded-evidence');
  if (!path.isAbsolute(recordRoot) || recordRoot === runRoot || recordRoot.startsWith(`${runRoot}${path.sep}`)) {
    fail('TIMELINE_AUTO_REAL_PROXY_RECORD_DIR must be an absolute path outside the disposable run root');
  }
  return recordRoot;
}

export function sanitizeHttpFailureFacts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 80).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const item = candidate;
    if (!Number.isInteger(item.status) || item.status < 400 || item.status > 599) return [];
    const pathName = safeHttpPath(item.path ?? item.url);
    if (!pathName) return [];
    const fact = { method: safeHttpFact(item.method) ?? 'UNKNOWN', path: pathName, status: item.status };
    for (const key of ['code', 'type', 'location']) {
      const field = safeHttpFact(item[key]);
      if (field) fact[key] = field;
    }
    return [fact];
  });
}

function findFile(root, filename) {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === filename) return candidate;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const found = findFile(candidate, filename);
      if (found) return found;
    }
  }
  return undefined;
}

export function recordFailureEvidence(runRoot, recordRoot, status, sourceIdentity = undefined) {
  if (!path.isAbsolute(runRoot) || !path.isAbsolute(recordRoot)) fail('failure evidence roots must be absolute');
  const run = realpathSync(runRoot);
  mkdirSync(recordRoot, { recursive: true, mode: 0o700 });
  const record = realpathSync(recordRoot);
  if (record === run || record.startsWith(`${run}${path.sep}`)) fail('failure evidence must not be inside the disposable run root');
  const source = findFile(path.join(run, 'browser-artifacts'), 'auto-http-failures.json');
  let failures = [];
  if (source) {
    try { failures = sanitizeHttpFailureFacts(json(source, 'automatic HTTP failure evidence').httpFailures); }
    catch { failures = []; }
  }
  const trace = findFile(path.join(run, 'browser-artifacts'), 'trace.zip');
  writeFileSync(path.join(record, 'auto-http-failures.json'), JSON.stringify({ runner_status: status, failures }, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(path.join(record, 'trace-presence.json'), JSON.stringify({ present: Boolean(trace), bytes: trace ? statSync(trace).size : 0 }) + '\n', { mode: 0o600 });
  writeFileSync(path.join(record, 'runner-result.json'), JSON.stringify({ status, source_identity: sourceIdentity, evidence_recorded_before_cleanup: true }) + '\n', { mode: 0o600 });
}

export function readRealProxyInputs(env = process.env, appRoot = process.cwd()) {
  const appSha = requiredSha(env, 'TIMELINE_AUTO_REAL_PROXY_APP_SHA');
  const appTree = requiredSha(env, 'TIMELINE_AUTO_REAL_PROXY_APP_TREE');
  const agentSha = requiredSha(env, 'TIMELINE_AUTO_REAL_PROXY_AGENT_SHA');
  const agentTree = requiredSha(env, 'TIMELINE_AUTO_REAL_PROXY_AGENT_TREE');
  const runtimeSha = requiredSha(env, 'TIMELINE_AUTO_REAL_PROXY_RUNTIME_SHA');
  const runtimeTree = requiredSha(env, 'TIMELINE_AUTO_REAL_PROXY_RUNTIME_TREE');
  if (runtimeSha !== REAL_PROXY_RUNTIME.commit || runtimeTree !== REAL_PROXY_RUNTIME.tree) {
    fail(`Runtime must be the published Main95 source ${REAL_PROXY_RUNTIME.commit}/${REAL_PROXY_RUNTIME.tree}`);
  }
  const runnerSha = requiredDigest(env, 'TIMELINE_AUTO_REAL_PROXY_RUNNER_SHA256');
  if (!path.isAbsolute(appRoot)) fail('App root must be absolute');
  const app = realpathSync(appRoot);
  const agent = requiredDirectory(env, 'ASTRID_CHECKOUT');
  const runtime = requiredDirectory(env, 'ASTRID_RUNTIME_CHECKOUT');
  const runtimeProducer = requiredDirectory(env, 'TIMELINE_AUTO_REAL_PROXY_RUNTIME_PRODUCER_CHECKOUT');
  const dependencyRoot = requiredDirectory(env, 'TIMELINE_AUTO_REAL_PROXY_DEPENDENCY_ROOT');
  const privateRoot = requiredDirectory(env, 'TIMELINE_AUTO_REAL_PROXY_PRIVATE_ROOT');
  const agentPython = requiredExecutable(env, 'ASTRID_PYTHON');
  const runtimePython = requiredExecutable(env, 'ASTRID_RUNTIME_PYTHON');
  const browser = requiredExecutable(env, 'PLAYWRIGHT_CHROMIUM_EXECUTABLE');
  if (env.ASTRID_PUBLIC_CHECKOUT || env.ASTRID_APP_DIRECT_DIST) {
    fail('ASTRID_PUBLIC_CHECKOUT and ASTRID_APP_DIRECT_DIST overrides are forbidden');
  }
  for (const [root, label] of [[app, 'App'], [agent, 'Agent'], [runtime, 'Runtime'], [runtimeProducer, 'Runtime producer'], [dependencyRoot, 'dependency']]) {
    if (privateRoot === root || privateRoot.startsWith(`${root}${path.sep}`)) fail(`private root must be outside ${label}`);
  }
  return Object.freeze({
    app,
    appSha,
    appTree,
    agent,
    agentSha,
    agentTree,
    runtime,
    runtimeSha,
    runtimeTree,
    runtimeProducer,
    agentPython,
    runtimePython,
    dependencyRoot,
    privateRoot,
    browser,
    runnerSha,
  });
}

function checkIdentity(root, expectedHead, expectedTree, label) {
  if (git(root, 'rev-parse', 'HEAD') !== expectedHead) fail(`${label} HEAD does not match the literal source pin`);
  if (git(root, 'rev-parse', 'HEAD^{tree}') !== expectedTree) fail(`${label} tree does not match the literal source pin`);
  sourceStatus(root, label);
  return { head: expectedHead, tree: expectedTree };
}

function checkLock(root, label) {
  const value = json(path.join(root, 'runtime.lock.json'), `${label} runtime.lock.json`);
  if (value.producer !== 'astrid-runtime') fail(`${label} Runtime lock producer is not astrid-runtime`);
  if (value.source_commit !== REAL_PROXY_RUNTIME.commit) fail(`${label} Runtime lock source pin changed`);
  if (value.producer_version !== REAL_PROXY_RUNTIME.producerVersion) fail(`${label} Runtime artifact pin changed`);
  return { sha256: digest(path.join(root, 'runtime.lock.json')), sourceCommit: value.source_commit, producerVersion: value.producer_version };
}

function checkMetadata(root, label, relative) {
  const file = path.join(root, relative);
  const text = readFileSync(file, 'utf8');
  const value = (name) => text.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`))?.[1] ?? fail(`${label} metadata lacks ${name}`);
  if (value('SCHEMA_DIGEST') !== REAL_PROXY_RUNTIME.schemaDigest) fail(`${label} schema digest changed`);
  if (value('COMPONENT_MANIFEST_SHA256') !== REAL_PROXY_RUNTIME.componentManifest) fail(`${label} component manifest changed`);
  if (label === 'App' && value('CONTRACT_VERSION') !== REAL_PROXY_RUNTIME.version) fail(`${label} contract version changed`);
  return { sha256: digest(file), schemaDigest: value('SCHEMA_DIGEST'), componentManifest: value('COMPONENT_MANIFEST_SHA256') };
}

function tarRegular(file) {
  return execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n')
    .filter((member) => member && !member.endsWith('/'));
}

function checkArchive(root, label) {
  const expected = REAL_PROXY_COMPOSITIONS[label];
  const relative = label === 'App' ? 'vendor/artifacts' : 'remotion/artifacts';
  const file = path.join(root, relative, expected.archive);
  if (digest(file) !== expected.sha256) fail(`${label} Composition archive hash changed`);
  const members = tarRegular(file);
  if (members.length !== REAL_PROXY_COMPOSITIONS.fileCount || new Set(members).size !== members.length
    || members.some((member) => !member.startsWith('package/') || member.split('/').includes('..'))) {
    fail(`${label} Composition archive must contain exactly 77 safe regular files`);
  }
  return { sha256: expected.sha256, fileCount: members.length };
}

function checkManifest(input) {
  const file = path.join(input.runtimeProducer, 'contract/artifacts.json');
  const value = json(file, 'Runtime artifact manifest');
  if (value.producer !== 'astrid-runtime' || value.version !== REAL_PROXY_RUNTIME.producerVersion) fail('Runtime artifact manifest pin changed');
  const artifactCount = Object.keys(value.artifacts ?? {}).length;
  if (artifactCount !== REAL_PROXY_RUNTIME.artifactCount) fail(`Runtime artifact manifest has ${artifactCount} entries, expected 76`);
  return { sha256: digest(file), version: value.version, artifactCount };
}

function checkPublicSource(root) {
  const file = path.join(root, 'vendor/astrid-browser/provenance.json');
  const value = json(file, 'normal vendor/astrid-browser provenance');
  if (!SHA.test(value.astrid_commit ?? '') || !SHA.test(value.astrid_tree ?? '')) fail('normal public source attribution is incomplete');
  const files = Object.entries(value.files ?? {});
  if (!files.length) fail('normal public source attribution contains no files');
  for (const [relative, expected] of files) {
    const target = path.join(root, 'vendor/astrid-browser', relative);
    if (!path.resolve(target).startsWith(`${path.resolve(root, 'vendor/astrid-browser')}${path.sep}`)) fail(`public source escapes its root: ${relative}`);
    if (!existsSync(target) || digest(target).slice('sha256:'.length) !== expected) fail(`public source digest mismatch: ${relative}`);
  }
  const sourceDigest = digest(file);
  return { provenanceSha256: sourceDigest, astridCommit: value.astrid_commit, astridTree: value.astrid_tree, fileCount: files.length };
}

function checkPublicVendor(root) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/build/verify-astrid-vendor-sources.mjs')], {
    cwd: root, env: process.env, stdio: 'inherit', shell: false,
  });
  if (result.status !== 0) fail(`normal public source verifier failed (exit ${result.status ?? 'signal'})`);
}

function checkDependencyRoot(input) {
  const packageRoot = path.join(input.dependencyRoot, '@banodoco/timeline-composition');
  const packageFile = path.join(packageRoot, 'package.json');
  const packageValue = json(packageFile, 'private13 Composition package');
  if (packageValue.version !== REAL_PROXY_COMPOSITIONS.App.version) fail('private dependency root is not public13');
  const archive = path.join(input.app, 'vendor/artifacts', REAL_PROXY_COMPOSITIONS.App.archive);
  for (const member of tarRegular(archive)) {
    const relative = member.slice('package/'.length);
    const installed = path.join(packageRoot, relative);
    if (!existsSync(installed) || digest(installed) !== digestFromArchive(archive, member)) fail(`private13 Composition byte mismatch: ${relative}`);
  }
  const peers = { react: '18.3.1', 'react-dom': '18.3.1', remotion: '4.0.509', '@remotion/player': '4.0.509', '@remotion/three': '4.0.509' };
  for (const [name, version] of Object.entries(peers)) {
    if (json(path.join(input.dependencyRoot, name, 'package.json'), `${name} package`).version !== version) fail(`private dependency peer changed: ${name}`);
  }
  return {
    root: input.dependencyRoot,
    composition: digest(packageFile),
    vite: digest(path.join(input.dependencyRoot, 'vite/package.json')),
    rollup: digest(path.join(input.dependencyRoot, 'rollup/package.json')),
  };
}

function digestFromArchive(archive, member) {
  return `sha256:${createHash('sha256').update(execFileSync('tar', ['-xOzf', archive, member])).digest('hex')}`;
}

function checkBrowser(browser) {
  if (realpathSync(browser) !== REAL_PROXY_BROWSER.executable) fail(`Chromium must be ${REAL_PROXY_BROWSER.executable}`);
  if (digest(browser) !== REAL_PROXY_BROWSER.sha256) fail('Chromium 141 executable hash changed');
  const version = execFileSync(browser, ['--version'], { encoding: 'utf8' }).trim();
  if (!version.includes(REAL_PROXY_BROWSER.version)) fail(`Chromium version is not ${REAL_PROXY_BROWSER.version}`);
  return { executable: browser, sha256: REAL_PROXY_BROWSER.sha256, version };
}

function checkVendorLock(input, root, command, label) {
  const script = command === 'node' ? path.join(input.app, 'scripts/vendor-lock.mjs') : path.join(input.agent, 'scripts/vendor_lock.py');
  const result = spawnSync(command, [script, 'check', path.join(root, 'runtime.lock.json'), '--producer', input.runtimeProducer], {
    cwd: root, env: process.env, stdio: 'inherit', shell: false,
  });
  if (result.status !== 0) fail(`${label} vendor-lock check failed (exit ${result.status ?? 'signal'})`);
}

function ensurePhysicalDirectory(directory, label) {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    fail(`${label} must be a physical directory: ${error.message}`);
  }
  let stats;
  try { stats = lstatSync(directory); }
  catch (error) { fail(`${label} must be a physical directory: ${error.message}`); }
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail(`${label} must be a physical directory`);
  return directory;
}

export function preparePrivateRunTempRoot(runRoot) {
  if (!path.isAbsolute(runRoot)) fail('private run root must be absolute');
  ensurePhysicalDirectory(runRoot, 'private run root');
  return ensurePhysicalDirectory(path.join(runRoot, 'tmpdir'), 'private run TMPDIR');
}

export function checkRealProxySources(input) {
  if (git(input.app, 'rev-parse', '--show-toplevel') !== input.app) fail('App root is not the current checkout');
  if (git(input.app, 'rev-parse', `${input.appSha}^{tree}`) !== input.appTree) fail('declared App commit does not map to the declared tree');
  const result = {
    app: checkIdentity(input.app, git(input.app, 'rev-parse', 'HEAD'), input.appTree, 'App'),
    agent: checkIdentity(input.agent, input.agentSha, input.agentTree, 'Agent'),
    runtime: checkIdentity(input.runtime, input.runtimeSha, input.runtimeTree, 'Runtime'),
    runtimeProducer: checkIdentity(input.runtimeProducer, input.runtimeSha, input.runtimeTree, 'Runtime producer'),
    appLock: checkLock(input.app, 'App'),
    agentLock: checkLock(input.agent, 'Agent'),
    appMetadata: checkMetadata(input.app, 'App', APP_METADATA),
    agentMetadata: checkMetadata(input.agent, 'Agent', AGENT_METADATA),
    manifest: checkManifest(input),
    appComposition: checkArchive(input.app, 'App'),
    agentComposition: checkArchive(input.agent, 'Agent'),
    publicSource: checkPublicSource(input.app),
    dependencyRoot: checkDependencyRoot(input),
    browser: checkBrowser(input.browser),
    runnerSha256: digest(RUNNER),
  };
  if (result.runnerSha256 !== input.runnerSha) fail('runner source hash does not match the literal suite input');
  checkPublicVendor(input.app);
  checkVendorLock(input, input.app, 'node', 'App');
  checkVendorLock(input, input.agent, input.agentPython, 'Agent');
  return Object.freeze(result);
}

function privateEnvironment(input, env, runRoot) {
  const tempRoot = preparePrivateRunTempRoot(runRoot);
  const value = {
    ...env,
    ASTRID_CHECKOUT: input.agent,
    ASTRID_RUNTIME_CHECKOUT: input.runtime,
    ASTRID_PYTHON: input.agentPython,
    ASTRID_RUNTIME_PYTHON: input.runtimePython,
    TIMELINE_BUNDLE_AGENT_HEAD: input.agentSha,
    TIMELINE_BUNDLE_RUNTIME_HEAD: input.runtimeSha,
    npm_config_cache: path.join(runRoot, 'npm-cache'),
    npm_config_offline: 'true',
    TMPDIR: tempRoot,
    PWTEST_CACHE_DIR: path.join(runRoot, 'playwright-cache'),
    PLAYWRIGHT_OUTPUT_DIR: path.join(runRoot, 'browser-artifacts'),
    TIMELINE_AUTO_REAL_PROXY_RECORD_DIR: resolveFailureRecordRoot(env, input.privateRoot, runRoot),
    VITE_CACHE_DIR: path.join(runRoot, 'vite-cache'),
    XDG_CACHE_HOME: path.join(runRoot, 'xdg-cache'),
    TSX_DISABLE_CACHE: '1',
  };
  for (const directory of [value.npm_config_cache, value.PWTEST_CACHE_DIR, value.PLAYWRIGHT_OUTPUT_DIR, value.VITE_CACHE_DIR, value.XDG_CACHE_HOME]) mkdirSync(directory, { recursive: true });
  return value;
}

export function prepareNodeModulesOverlay(appRoot, dependencyRoot, privateRoot) {
  const link = path.join(appRoot, 'node_modules');
  if (!lstatSync(link).isSymbolicLink()) fail('App node_modules must remain the shared dependency symlink');
  const shared = realpathSync(link);
  const overlay = path.join(privateRoot, 'node_modules');
  if (realpathSync(privateRoot) === shared || overlay.startsWith(`${shared}${path.sep}`)) fail('private overlay may not be inside shared dependencies');
  rmSync(overlay, { recursive: true, force: true });
  mkdirSync(overlay, { recursive: true });
  for (const name of readdirSync(dependencyRoot)) {
    if (name === '.vite' || name === '.vite-temp') continue;
    const source = path.join(dependencyRoot, name);
    const destination = path.join(overlay, name);
    if (name === 'vite' || name === 'rollup') {
      cpSync(source, destination, { dereference: false, recursive: true });
    } else if (name.startsWith('@') || name === '.bin') {
      mkdirSync(destination, { recursive: true });
      for (const child of readdirSync(source)) symlinkSync(path.join(source, child), path.join(destination, child), 'junction');
    } else {
      symlinkSync(source, destination, 'junction');
    }
  }
  mkdirSync(path.join(overlay, '.vite'), { recursive: true });
  mkdirSync(path.join(overlay, '.vite-temp'), { recursive: true });
  unlinkSync(link);
  symlinkSync(overlay, link, 'junction');
  return () => {
    unlinkSync(link);
    symlinkSync(shared, link, 'junction');
    rmSync(overlay, { recursive: true, force: true });
  };
}

export function runRealProxyStartupOnly(env = process.env, appRoot = process.cwd()) {
  if (env.TIMELINE_AUTO_REAL_PROXY_RUN !== '1') fail('set TIMELINE_AUTO_REAL_PROXY_RUN=1 only for manager-authorized central execution');
  const input = readRealProxyInputs(env, appRoot);
  const runRoot = path.join(input.privateRoot, `real-proxy-startup-${process.pid}`);
  const recordRoot = resolveFailureRecordRoot(env, input.privateRoot, runRoot);
  mkdirSync(recordRoot, { recursive: true, mode: 0o700 });
  const result = checkRealProxySources(input);
  writeFileSync(path.join(recordRoot, 'runner-result.json'), JSON.stringify({
    mode: 'startup-only',
    status: 0,
    source_identity: {
      app: { head: input.appSha, tree: input.appTree },
      agent: { head: input.agentSha, tree: input.agentTree },
      runtime: { head: input.runtimeSha, tree: input.runtimeTree },
      runner: input.runnerSha,
    },
    record_directory: recordRoot,
    argv: ['npm', 'exec', '--', 'playwright', 'test', '--config', 'playwright.auto-real-proxy.config.ts'],
    test_path: 'tests/e2e/local/auto-real-proxy.spec.ts',
    browser_or_task_started: false,
  }, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({
    mode: 'startup-only',
    status: 0,
    source_identity: result,
    record_directory: recordRoot,
    argv: ['npm', 'exec', '--', 'playwright', 'test', '--config', 'playwright.auto-real-proxy.config.ts'],
    test_path: 'tests/e2e/local/auto-real-proxy.spec.ts',
    browser_or_task_started: false,
  }) + '\n');
  return result;
}

export function runRealProxyGate(env = process.env, appRoot = process.cwd()) {
  if (env.TIMELINE_AUTO_REAL_PROXY_RUN !== '1') fail('set TIMELINE_AUTO_REAL_PROXY_RUN=1 only for manager-authorized central execution');
  const input = readRealProxyInputs(env, appRoot);
  const runRoot = path.join(input.privateRoot, `real-proxy-${process.pid}`);
  const recordRoot = resolveFailureRecordRoot(env, input.privateRoot, runRoot);
  ensurePhysicalDirectory(runRoot, 'private run root');
  const before = checkRealProxySources(input);
  const childEnv = privateEnvironment(input, env, runRoot);
  const restoreModules = prepareNodeModulesOverlay(input.app, input.dependencyRoot, input.privateRoot);
  let status = 1;
  try {
    status = spawnSync('npm', ['exec', '--', 'playwright', 'test', '--config', 'playwright.auto-real-proxy.config.ts'], {
      cwd: input.app,
      env: childEnv,
      stdio: 'inherit',
      shell: false,
    }).status ?? 1;
  } finally {
    try {
      restoreModules();
      const after = checkRealProxySources(input);
      if (JSON.stringify(before) !== JSON.stringify(after)) fail('source, normal attribution, dependency, browser, or runner inputs changed during the gate');
    } finally {
      if (recordRoot) {
        try {
          recordFailureEvidence(runRoot, recordRoot, status, {
            app: { head: input.appSha, tree: input.appTree },
            agent: { head: input.agentSha, tree: input.agentTree },
            runtime: { head: input.runtimeSha, tree: input.runtimeTree },
            runner: input.runnerSha,
          });
        }
        catch (error) { console.error(`[auto-real-proxy-main95] failure evidence was not retained: ${error.message}`); }
      }
      rmSync(runRoot, { recursive: true, force: true });
    }
  }
  process.exitCode = status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.TIMELINE_AUTO_REAL_PROXY_STARTUP_ONLY === '1') runRealProxyStartupOnly();
  else runRealProxyGate();
}

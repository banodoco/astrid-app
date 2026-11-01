#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const CURRENT013_PARENT_SPLIT_AGENT = '6efc81500a0e0688c2bb41e736503f0fc3e04abb';
export const CURRENT013_PARENT_SPLIT_AGENT_TREE = '2ed2b8a12b5b3391ca221ba6ff05390f71a73556';
export const CURRENT013_PARENT_SPLIT_AGENT_VENDOR = '091aa23ec83ea05ffd3b0115a640230d51c8c429';
export const CURRENT013_PARENT_SPLIT_AGENT_VENDOR_TREE = 'e3ae90fe482ba6cad6c3f94069127faf76ebceb6';
export const CURRENT013_PARENT_SPLIT_RUNTIME = '95bd3c5f6d00e9bc8cc8cbe5ef510b68ed660f3c';
export const CURRENT013_PARENT_SPLIT_RUNTIME_TREE = 'd3a290b407fa61e6ab2d476f50c068073f70df00';
export const CURRENT013_PARENT_SPLIT_RUNTIME_VERSION = 'sha256:54205b3ecb55038e416b31af936c9af26afa30dc1b05da16157ee4d861fe05ac';
export const PUBLIC13_ARCHIVE_SHA256 = '9412ae25c306d5118241f4d631e8eecc6eef9b2fb5a98302d40938e9f6d54738';
export const PARENT_SPLIT_TITLE = 'M2 native parent split preserves raw closure through lost ACK, restart, retry and Runtime inverse';
export const PARENT_SPLIT_FILE = 'parent-split-command.spec.ts';

function fail(message) { throw new Error(`[current013/parent-split] ${message}`); }
function required(env, name) {
  const value = env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}
function requiredPath(env, name) {
  const value = required(env, name);
  if (!path.isAbsolute(value) || !existsSync(value) || !statSync(value).isDirectory()) fail(`${name} must be an absolute directory`);
  if (lstatSync(value).isSymbolicLink()) fail(`${name} must be a physical directory`);
  return realpathSync(value);
}
function requiredFile(env, name) {
  const value = required(env, name);
  if (!path.isAbsolute(value) || !existsSync(value) || !statSync(value).isFile()) fail(`${name} must be an absolute file`);
  if (lstatSync(value).isSymbolicLink()) fail(`${name} must be a physical file`);
  return realpathSync(value);
}
function requiredCredential(env) {
  const file = requiredFile(env, 'WORKSPACE_RUNTIME_TOKEN_FILE');
  if ((statSync(file).mode & 0o777) !== 0o600) fail('WORKSPACE_RUNTIME_TOKEN_FILE must be a physical mode-0600 file');
  let credential;
  try { credential = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { fail(`WORKSPACE_RUNTIME_TOKEN_FILE is not valid JSON: ${error.message}`); }
  const actorId = typeof credential?.actor_id === 'string' ? credential.actor_id.trim() : '';
  const token = typeof credential?.token === 'string' ? credential.token.trim() : '';
  if (credential?.version !== 1 || credential?.scope !== 'astrid'
    || !actorId || ['owner', 'astrid-pack-host', 'admin', 'worker'].includes(actorId) || !token) {
    fail('WORKSPACE_RUNTIME_TOKEN_FILE is not an existing Runtime product credential');
  }
  return file;
}
function requiredExecutable(env, name) {
  const value = required(env, name);
  if (!path.isAbsolute(value) || !existsSync(value) || !statSync(value).isFile()) fail(`${name} must be an executable file`);
  try { accessSync(value, constants.X_OK); } catch { fail(`${name} must be executable`); }
  return value;
}
function git(root, ...args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { fail(`git ${args.join(' ')} failed in ${root}: ${error.message}`); }
}
function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function safeArchive(file) {
  const members = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n').filter((member) => member && !member.endsWith('/'));
  if (members.length !== 77 || new Set(members).size !== members.length || members.some((member) => !member.startsWith('package/') || member.split('/').includes('..'))) {
    fail('public13 Composition archive must contain exactly 77 safe regular files');
  }
}

export function readCurrent013ParentSplitInputs(env = process.env, appRoot = process.cwd()) {
  const appSha = required(env, 'TIMELINE_CURRENT013_APP_SHA');
  const appTree = required(env, 'TIMELINE_CURRENT013_APP_TREE');
  const agentSha = required(env, 'TIMELINE_CURRENT013_AGENT_SHA');
  const runtimeSha = required(env, 'TIMELINE_CURRENT013_RUNTIME_SHA');
  if (![appSha, appTree, agentSha, runtimeSha].every((value) => /^[0-9a-f]{40}$/.test(value))) fail('source identities must be full lowercase SHA values');
  if (agentSha !== CURRENT013_PARENT_SPLIT_AGENT) fail(`requires Agent ${CURRENT013_PARENT_SPLIT_AGENT}`);
  if (runtimeSha !== CURRENT013_PARENT_SPLIT_RUNTIME) fail(`requires Runtime ${CURRENT013_PARENT_SPLIT_RUNTIME}`);
  if (!path.isAbsolute(appRoot)) fail('App root must be absolute');
  const privateModules = requiredPath(env, 'PRIVATE13_NODE_MODULES');
  if (privateModules === realpathSync('/home/user/work/app/node_modules')) fail('private13 node_modules resolves to a shared install');
  const ready = requiredFile(env, 'TIMELINE_CURRENT013_PRIVATE13_READY');
  const lease = requiredFile(env, 'TIMELINE_CURRENT013_PRIVATE13_LEASE');
  const shortTemp = requiredPath(env, 'TIMELINE_CURRENT013_SHORT_TMPDIR');
  if (path.dirname(shortTemp) !== '/tmp' || (statSync(shortTemp).mode & 0o777) !== 0o700) fail('short temp must be an owned direct /tmp directory with mode 0700');
  const config = requiredFile(env, 'TIMELINE_CURRENT013_CONFIG_PATH');
  if (path.basename(config) !== 'playwright.parent-split.config.ts') fail('config must be the parent-split config');
  const browser = requiredExecutable(env, 'PLAYWRIGHT_CHROMIUM_EXECUTABLE');
  const credential = requiredCredential(env);
  return Object.freeze({
    app: realpathSync(appRoot), appSha, appTree, agentSha, runtimeSha,
    agent: requiredPath(env, 'ASTRID_CHECKOUT'), runtime: requiredPath(env, 'ASTRID_RUNTIME_CHECKOUT'),
    agentVendor: requiredPath(env, 'TIMELINE_CURRENT013_AGENT_VENDOR_CHECKOUT'),
    runtimeProducer: requiredPath(env, 'TIMELINE_CURRENT013_RUNTIME_PRODUCER_CHECKOUT'),
    agentPython: requiredExecutable(env, 'ASTRID_PYTHON'), runtimePython: requiredExecutable(env, 'ASTRID_RUNTIME_PYTHON'),
    privateModules, ready, lease, shortTemp, config, browser, credential,
  });
}

function runExistingChecker(command, args, cwd, label) {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: false });
  if (result.status !== 0) fail(`${label} checker failed (exit ${result.status ?? 'signal'})`);
}

function checkList1(input, env = process.env) {
  const result = spawnSync('npm', ['run', 'test:e2e:three-products', '--', '--config', 'playwright.parent-split.config.ts', '--list'], {
    cwd: input.app,
    env: { ...env, ASTRID_CHECKOUT: input.agent, ASTRID_RUNTIME_CHECKOUT: input.runtime,
      ASTRID_PYTHON: input.agentPython, ASTRID_RUNTIME_PYTHON: input.runtimePython,
      TIMELINE_BUNDLE_AGENT_HEAD: input.agentSha, TIMELINE_BUNDLE_RUNTIME_HEAD: input.runtimeSha },
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: false,
  });
  if (result.status !== 0) fail(`same-runtime --list failed (exit ${result.status ?? 'signal'})`);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const titleCount = output.split(PARENT_SPLIT_TITLE).length - 1;
  const fileCount = output.split(PARENT_SPLIT_FILE).length - 1;
  if (titleCount !== 1 || fileCount !== 1 || !/Total:\s*1 test in 1 file/.test(output)) {
    fail('same-runtime --list must select exactly original1 parent-split test in one file');
  }
  return { title: PARENT_SPLIT_TITLE, file: PARENT_SPLIT_FILE };
}

export function checkCurrent013ParentSplitSources(input, env = process.env) {
  if (git(input.app, 'rev-parse', 'HEAD') !== input.appSha || git(input.app, 'rev-parse', 'HEAD^{tree}') !== input.appTree) fail('App source SHA/tree is not the selected current source');
  if (git(input.agent, 'rev-parse', 'HEAD') !== input.agentSha || git(input.agent, 'rev-parse', 'HEAD^{tree}') !== CURRENT013_PARENT_SPLIT_AGENT_TREE) fail('Agent execution HEAD/tree is not the approved Agent6ef source');
  if (git(input.agentVendor, 'rev-parse', 'HEAD') !== CURRENT013_PARENT_SPLIT_AGENT_VENDOR || git(input.agentVendor, 'rev-parse', 'HEAD^{tree}') !== CURRENT013_PARENT_SPLIT_AGENT_VENDOR_TREE) fail('Agent vendor HEAD/tree is not the approved Agent091 source');
  if (git(input.runtime, 'rev-parse', 'HEAD') !== input.runtimeSha || git(input.runtime, 'rev-parse', 'HEAD^{tree}') !== CURRENT013_PARENT_SPLIT_RUNTIME_TREE) fail('Runtime HEAD/tree is not the approved Runtime source');
  if (git(input.runtimeProducer, 'rev-parse', 'HEAD') !== CURRENT013_PARENT_SPLIT_RUNTIME || git(input.runtimeProducer, 'rev-parse', 'HEAD^{tree}') !== CURRENT013_PARENT_SPLIT_RUNTIME_TREE) fail('Runtime producer HEAD/tree is not the approved Runtime95 source');
  for (const [root, label] of [[input.app, 'App'], [input.agent, 'Agent execution'], [input.agentVendor, 'Agent vendor'], [input.runtime, 'Runtime'], [input.runtimeProducer, 'Runtime producer']]) {
    if (git(root, 'status', '--porcelain', '--untracked-files=normal')) fail(`${label} source is dirty`);
  }
  const provenance = JSON.parse(readFileSync(path.join(input.app, 'vendor/astrid-browser/provenance.json'), 'utf8'));
  if (provenance.astrid_commit !== CURRENT013_PARENT_SPLIT_AGENT_VENDOR || provenance.astrid_tree !== CURRENT013_PARENT_SPLIT_AGENT_VENDOR_TREE) fail('App Agent vendor provenance is not Agent091');
  const runtimeLock = JSON.parse(readFileSync(path.join(input.app, 'runtime.lock.json'), 'utf8'));
  if (runtimeLock.source_commit !== CURRENT013_PARENT_SPLIT_RUNTIME || runtimeLock.producer_version !== CURRENT013_PARENT_SPLIT_RUNTIME_VERSION) fail('App public014 Runtime lock is not Runtime95/all76');
  const manifest = JSON.parse(readFileSync(path.join(input.runtimeProducer, 'contract/artifacts.json'), 'utf8'));
  if (manifest.producer !== 'astrid-runtime' || manifest.version !== CURRENT013_PARENT_SPLIT_RUNTIME_VERSION || Object.keys(manifest.artifacts ?? {}).length !== 76) fail('Runtime producer artifact manifest is not public014/all76');
  const archive = path.join(input.app, 'vendor/artifacts/banodoco-timeline-composition-0.0.13.tgz');
  if (!existsSync(archive) || sha256(archive) !== PUBLIC13_ARCHIVE_SHA256) fail('public13 archive is not 9412');
  safeArchive(archive);
  runExistingChecker('node', [path.join(input.app, 'scripts/build/verify-astrid-vendor-sources.mjs')], input.app, 'App13/Agent15 vendor');
  runExistingChecker('node', [path.join(input.app, 'scripts/vendor-lock.mjs'), 'check', path.join(input.app, 'runtime.lock.json'), '--producer', input.runtimeProducer], input.app, 'App public014');
  runExistingChecker(input.agentPython, [path.join(input.agent, 'scripts/vendor_lock.py'), 'check', path.join(input.agent, 'runtime.lock.json'), '--producer', input.runtimeProducer], input.agent, 'Agent public014');
  return { app: input.appSha, appTree: input.appTree, agent: input.agentSha, agentTree: CURRENT013_PARENT_SPLIT_AGENT_TREE, agentVendor: CURRENT013_PARENT_SPLIT_AGENT_VENDOR, runtime: input.runtimeSha, runtimeTree: CURRENT013_PARENT_SPLIT_RUNTIME_TREE, archive: PUBLIC13_ARCHIVE_SHA256, artifactCount: 76 };
}

export function parentSplitCacheIdentity(input) {
  const hash = (file) => createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex');
  return `parent-split-app${input.appSha}-tree${input.appTree}-agent${input.agentSha}-vendor${CURRENT013_PARENT_SPLIT_AGENT_VENDOR}-runtime${input.runtimeSha}-public014-${CURRENT013_PARENT_SPLIT_RUNTIME_VERSION}-public13-${PUBLIC13_ARCHIVE_SHA256}-all76-all77-runner${hash('./current013-parent-split.mjs')}`;
}

export function runCurrent013ParentSplit() {
  if (process.env.TIMELINE_CURRENT013_RUN !== '1') fail('set TIMELINE_CURRENT013_RUN=1 only for the manager-approved gate');
  const input = readCurrent013ParentSplitInputs();
  checkCurrent013ParentSplitSources(input);
  if (process.env.TIMELINE_CURRENT013_CACHE_ID !== parentSplitCacheIdentity(input)) fail('TIMELINE_CURRENT013_CACHE_ID does not identify this exact split source/pair');
  const list = checkList1(input);
  const before = checkCurrent013ParentSplitSources(input);
  let status = 1;
  try {
    status = spawnSync('npm', ['run', 'test:e2e:three-products', '--', '--config', 'playwright.parent-split.config.ts'], {
      cwd: input.app,
      env: { ...process.env, ASTRID_CHECKOUT: input.agent, ASTRID_RUNTIME_CHECKOUT: input.runtime,
        ASTRID_PYTHON: input.agentPython, ASTRID_RUNTIME_PYTHON: input.runtimePython,
        TIMELINE_CURRENT013_APP_SHA: input.appSha, TIMELINE_CURRENT013_APP_TREE: input.appTree,
        TIMELINE_CURRENT013_AGENT_VENDOR_CHECKOUT: input.agentVendor,
        TIMELINE_BUNDLE_AGENT_HEAD: input.agentSha, TIMELINE_BUNDLE_RUNTIME_HEAD: input.runtimeSha },
      stdio: 'inherit', shell: false,
    }).status ?? 1;
  } finally {
    const after = checkCurrent013ParentSplitSources(input);
    if (JSON.stringify(after) !== JSON.stringify(before)) fail('source checks changed during the browser gate');
  }
  if (list.file !== PARENT_SPLIT_FILE) fail('parent-split list selection changed');
  process.exitCode = status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCurrent013ParentSplit();

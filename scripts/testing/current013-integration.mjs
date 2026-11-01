#!/usr/bin/env node

/**
 * Central current013 M1/Gate-5 launcher.
 *
 * This is deliberately a preflight around the existing three-products suite;
 * it does not add a second journey or a second source-evidence system.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync, constants, existsSync, readFileSync, realpathSync, statSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const CURRENT013_RUNTIME = Object.freeze({
  serverCommit: '8f105c26e3b62f9c2683f717a9773a12bc775a8e',
  producerCommit: '2c4ac180c2220bdad966bc01e95ad230e99ce26a',
  version: '0.2.13',
  producerVersion: 'sha256:6f000bc615a9cb24fb00cc69a97af75eae71006ebfe87e3caa272fcdbbb1af56',
  schemaDigest: 'sha256:8de823011a121359b9ad021e283b45afb6baeabc8a154a02bd086d1260a8b8f4',
  componentManifest: 'sha256:1ad76db27c1d9716bb234f811bf63e1f5898cb3d5f9b835a821765e6cad895e5',
  artifactCount: 75,
});

export const CURRENT013_AGENT = Object.freeze({
  commit: 'd0a5072bbe7b7ce9489f43aa0a81027ec400343b',
  tree: '6adb4a1190dfb2874e101565f37eccd392b1ae2f',
  lock: 'sha256:c4d7030bd5418d35f2246269b5aba7952d0ed69ccd0084815a0043dfbb7a4e24',
});

export const CURRENT013_COMPOSITION = Object.freeze({
  archive: 'banodoco-timeline-composition-0.0.13.tgz',
  sha256: 'sha256:9412ae25c306d5118241f4d631e8eecc6eef9b2fb5a98302d40938e9f6d54738',
  fileCount: 77,
});

const FULL_SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const APP_METADATA = 'src/integrations/runtime/generated-contract-metadata.ts';
const AGENT_METADATA = 'astrid_runtime_client/contract_metadata.py';

function fail(message) {
  throw new Error(`[current013] ${message}`);
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) fail(`${name} is required; no moving-repo default is allowed`);
  return value;
}

function requiredSha(env, name) {
  const value = required(env, name);
  if (!FULL_SHA.test(value)) fail(`${name} must be a full 40-character lowercase SHA`);
  return value;
}

function requiredPath(env, name) {
  const value = required(env, name);
  if (!path.isAbsolute(value)) fail(`${name} must be an absolute path`);
  if (!existsSync(value)) fail(`${name} does not exist: ${value}`);
  if (!statSync(value).isDirectory()) fail(`${name} must name a directory: ${value}`);
  return realpathSync(value);
}

function requiredExecutable(env, name) {
  const value = required(env, name);
  if (!path.isAbsolute(value)) fail(`${name} must be an absolute path`);
  if (!existsSync(value) || !statSync(value).isFile()) fail(`${name} must name a file: ${value}`);
  try { accessSync(value, constants.X_OK); }
  catch { fail(`${name} must be executable: ${value}`); }
  // Invoking the supplied venv entry point preserves its sys.prefix.
  return value;
}

function git(root, ...args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    fail(`git ${args.join(' ')} failed in ${root}: ${error.message}`);
  }
}

function sha256File(file) {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

function jsonFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { fail(`cannot read JSON ${file}: ${error.message}`); }
}

export function readCurrent013Inputs(env = process.env, appRoot = process.cwd()) {
  const appTree = requiredSha(env, 'TIMELINE_CURRENT013_APP_TREE');
  const agentSha = requiredSha(env, 'TIMELINE_CURRENT013_AGENT_SHA');
  const runtimeSha = requiredSha(env, 'TIMELINE_CURRENT013_RUNTIME_SHA');
  if (agentSha !== CURRENT013_AGENT.commit) {
    fail(`TIMELINE_CURRENT013_AGENT_SHA must be the frozen Agent ${CURRENT013_AGENT.commit}`);
  }
  if (runtimeSha !== CURRENT013_RUNTIME.serverCommit) {
    fail(`TIMELINE_CURRENT013_RUNTIME_SHA must be the frozen Runtime server ${CURRENT013_RUNTIME.serverCommit}`);
  }
  if (!path.isAbsolute(appRoot)) fail(`App root must be absolute: ${appRoot}`);
  const app = realpathSync(appRoot);
  const agent = requiredPath(env, 'ASTRID_CHECKOUT');
  const runtime = requiredPath(env, 'ASTRID_RUNTIME_CHECKOUT');
  const runtimeProducer = requiredPath(env, 'TIMELINE_CURRENT013_RUNTIME_PRODUCER_CHECKOUT');
  const agentPython = requiredExecutable(env, 'ASTRID_PYTHON');
  const runtimePython = requiredExecutable(env, 'ASTRID_RUNTIME_PYTHON');
  if (env.ASTRID_APP_DIRECT_DIST) {
    fail('ASTRID_APP_DIRECT_DIST is forbidden; the existing current three-products default build helper must decide dist freshness');
  }
  return Object.freeze({ app, appTree, agent, agentSha, runtime, runtimeSha, runtimeProducer, agentPython, runtimePython });
}

function checkHead(root, expected, label) {
  const actual = git(root, 'rev-parse', 'HEAD');
  if (actual !== expected) fail(`${label} HEAD changed: expected ${expected}, got ${actual}`);
  return actual;
}

function checkClean(root, label) {
  const status = git(root, 'status', '--porcelain', '--untracked-files=normal');
  if (status) fail(`${label} source is dirty:\n${status}`);
}

function checkLock(root, label) {
  const file = path.join(root, 'runtime.lock.json');
  const lock = jsonFile(file);
  if (lock.producer !== 'astrid-runtime') fail(`${label} Runtime lock producer is ${lock.producer}, expected astrid-runtime`);
  if (lock.source_commit !== CURRENT013_RUNTIME.producerCommit) fail(`${label} Runtime artifact producer pin is ${lock.source_commit}, expected ${CURRENT013_RUNTIME.producerCommit}`);
  if (lock.producer_version !== CURRENT013_RUNTIME.producerVersion) fail(`${label} Runtime artifact pin is ${lock.producer_version}, expected ${CURRENT013_RUNTIME.producerVersion}`);
  return { file: sha256File(file), sourceCommit: lock.source_commit, producerVersion: lock.producer_version };
}

function checkMetadata(root, label, metadataFile) {
  const file = path.join(root, metadataFile);
  const source = readFileSync(file, 'utf8');
  const get = (name) => {
    const match = source.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`));
    if (!match) fail(`${label} metadata is missing ${name}: ${file}`);
    return match[1];
  };
  const schemaDigest = get('SCHEMA_DIGEST');
  const componentManifest = get('COMPONENT_MANIFEST_SHA256');
  if (schemaDigest !== CURRENT013_RUNTIME.schemaDigest) fail(`${label} schema is ${schemaDigest}, expected ${CURRENT013_RUNTIME.schemaDigest}`);
  if (componentManifest !== CURRENT013_RUNTIME.componentManifest) fail(`${label} component manifest is ${componentManifest}, expected ${CURRENT013_RUNTIME.componentManifest}`);
  if (label === 'App' && get('CONTRACT_VERSION') !== CURRENT013_RUNTIME.version) fail(`App contract is not ${CURRENT013_RUNTIME.version}`);
  return { file: sha256File(file), schemaDigest, componentManifest };
}

function checkRuntimeManifest(root) {
  const file = path.join(root, 'contract/artifacts.json');
  const manifest = jsonFile(file);
  if (manifest.producer !== 'astrid-runtime') fail(`Runtime manifest producer is ${manifest.producer}`);
  if (manifest.version !== CURRENT013_RUNTIME.producerVersion) fail(`Runtime manifest version is ${manifest.version}, expected ${CURRENT013_RUNTIME.producerVersion}`);
  const count = Object.keys(manifest.artifacts ?? {}).length;
  if (count !== CURRENT013_RUNTIME.artifactCount) fail(`Runtime manifest has ${count} artifacts, expected ${CURRENT013_RUNTIME.artifactCount}`);
  return { file: sha256File(file), version: manifest.version, artifactCount: count };
}

function checkCompositionArchive(root, label) {
  let file = path.join(root, 'remotion/artifacts', CURRENT013_COMPOSITION.archive);
  if (label === 'App') file = path.join(root, 'vendor/artifacts', CURRENT013_COMPOSITION.archive);
  if (!existsSync(file)) fail(`${label} Composition archive is missing: ${file}`);
  const digest = sha256File(file);
  if (digest !== CURRENT013_COMPOSITION.sha256) fail(`${label} Composition archive is ${digest}, expected ${CURRENT013_COMPOSITION.sha256}`);
  const members = execFileSync('tar', ['-tzf', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n')
    .filter((member) => member && !member.endsWith('/'));
  if (members.length !== CURRENT013_COMPOSITION.fileCount || new Set(members).size !== members.length) {
    fail(`${label} Composition archive must contain exactly ${CURRENT013_COMPOSITION.fileCount} regular files, found ${members.length}`);
  }
  if (members.some((member) => !member.startsWith('package/') || member.slice('package/'.length).split('/').includes('..'))) {
    fail(`${label} Composition archive contains an unsafe member`);
  }
  return { file: digest, fileCount: members.length };
}

function runVendorCheck(input, root, command, label) {
  const script = command === 'node' ? path.join(input.app, 'scripts/vendor-lock.mjs') : path.join(input.agent, 'scripts/vendor_lock.py');
  const lock = path.join(root, 'runtime.lock.json');
  const result = spawnSync(command, [script, 'check', lock, '--producer', input.runtimeProducer], {
    cwd: root, env: process.env, stdio: 'inherit', shell: false,
  });
  if (result.status !== 0) fail(`${label} normal Runtime vendor-lock check failed (exit ${result.status ?? 'signal'})`);
}

export function checkCurrent013Sources(input, { vendor = true } = {}) {
  if (git(input.app, 'rev-parse', '--show-toplevel') !== input.app) fail(`App root is not the current checkout: ${input.app}`);
  if (git(input.app, 'rev-parse', 'HEAD^{tree}') !== input.appTree) fail(`App source tree changed: expected ${input.appTree}`);
  const agentTree = git(input.agent, 'rev-parse', 'HEAD^{tree}');
  const runtimeTree = git(input.runtime, 'rev-parse', 'HEAD^{tree}');
  const producerTree = git(input.runtimeProducer, 'rev-parse', 'HEAD^{tree}');
  checkHead(input.agent, input.agentSha, 'Agent');
  checkHead(input.runtime, input.runtimeSha, 'Runtime');
  checkHead(input.runtimeProducer, CURRENT013_RUNTIME.producerCommit, 'Runtime artifact producer');
  checkClean(input.app, 'App');
  checkClean(input.agent, 'Agent');
  checkClean(input.runtime, 'Runtime');
  checkClean(input.runtimeProducer, 'Runtime producer');
  const appLock = checkLock(input.app, 'App');
  const agentLock = checkLock(input.agent, 'Agent');
  const appMetadata = checkMetadata(input.app, 'App', APP_METADATA);
  const agentMetadata = checkMetadata(input.agent, 'Agent', AGENT_METADATA);
  const runtimeManifest = checkRuntimeManifest(input.runtimeProducer);
  const appComposition = checkCompositionArchive(input.app, 'App');
  const agentComposition = checkCompositionArchive(input.agent, 'Agent');
  if (vendor) {
    runVendorCheck(input, input.app, 'node', 'App');
    runVendorCheck(input, input.agent, input.agentPython, 'Agent');
  }
  return Object.freeze({
    app: { root: input.app, tree: input.appTree, lock: appLock, metadata: appMetadata, composition: appComposition },
    agent: { root: input.agent, commit: input.agentSha, tree: agentTree, lock: agentLock, metadata: agentMetadata, composition: agentComposition },
    runtime: { root: input.runtime, commit: input.runtimeSha, tree: runtimeTree },
    runtimeProducer: { root: input.runtimeProducer, commit: CURRENT013_RUNTIME.producerCommit, tree: producerTree, manifest: runtimeManifest },
  });
}

export function runCurrent013Integration() {
  if (process.env.TIMELINE_CURRENT013_RUN !== '1') {
    fail('set TIMELINE_CURRENT013_RUN=1 only when the manager has supplied the final exact pair');
  }
  const input = readCurrent013Inputs();
  const before = checkCurrent013Sources(input);
  console.log('[current013] exact source preflight passed; running existing M1/Gate-5 three-products suite');
  const childEnv = {
    ...process.env,
    ASTRID_CHECKOUT: input.agent,
    ASTRID_RUNTIME_CHECKOUT: input.runtime,
    ASTRID_PYTHON: input.agentPython,
    ASTRID_RUNTIME_PYTHON: input.runtimePython,
    TIMELINE_BUNDLE_AGENT_HEAD: input.agentSha,
    TIMELINE_BUNDLE_RUNTIME_HEAD: input.runtimeSha,
  };
  let status = 1;
  try {
    status = spawnSync('npm', ['run', 'test:e2e:three-products'], { cwd: input.app, env: childEnv, stdio: 'inherit', shell: false }).status ?? 1;
  } finally {
    const after = checkCurrent013Sources(input);
    if (JSON.stringify(after) !== JSON.stringify(before)) fail('source checks changed between the start and end of the browser gate');
    console.log('[current013] exact source postflight passed');
  }
  process.exitCode = status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCurrent013Integration();

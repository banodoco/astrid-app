#!/usr/bin/env node

/**
 * Main95 prompt/settings central integration launcher.
 *
 * The browser journey remains the existing SettingsAutoDisable case. This
 * wrapper owns its exact source tuple and the private public13 dependency
 * graph, so a central snapshot cannot silently fall back to an old runner.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAIN95_AGENT = Object.freeze({
  commit: '6efc81500a0e0688c2bb41e736503f0fc3e04abb',
  tree: '2ed2b8a12b5b3391ca221ba6ff05390f71a73556',
});

// The public browser vendor is a separately qualified source role. It is not
// the frozen Agent checkout used for execution and must never be compared to
// MAIN95_AGENT as an equality shortcut.
export const MAIN95_VENDOR = Object.freeze({
  commit: '091aa23ec83ea05ffd3b0115a640230d51c8c429',
  tree: 'e3ae90fe482ba6cad6c3f94069127faf76ebceb6',
  fileCount: 145,
  module: 'astrid/packs/rendering/elements/catalog.ts',
  moduleSha256: 'fc53e754326cd9fc9bc3e5233026fbc70ac6a4c5fd81a9d0b2c857665f13c661',
});

export const MAIN95_RUNTIME = Object.freeze({
  commit: '95bd3c5f6d00e9bc8cc8cbe5ef510b68ed660f3c',
  tree: 'd3a290b407fa61e6ab2d476f50c068073f70df00',
  version: '0.2.14',
  producerVersion: 'sha256:54205b3ecb55038e416b31af936c9af26afa30dc1b05da16157ee4d861fe05ac',
  schemaDigest: 'sha256:7d4afa05962b8cd61643213fc79cdde41e16046c4e2a777bd299b48af0f31816',
  componentManifest: 'sha256:1ad76db27c1d9716bb234f811bf63e1f5898cb3d5f9b835a821765e6cad895e5',
  artifactCount: 76,
  timelineBundle: 'sha256:6d707cb84a232f6ecd7e17c09c8722a379bb76b6a9d2869efea691d6bd8366e3',
});

export const MAIN95_COMPOSITION = Object.freeze({
  archive: 'banodoco-timeline-composition-0.0.13.tgz',
  sha256: 'sha256:9412ae25c306d5118241f4d631e8eecc6eef9b2fb5a98302d40938e9f6d54738',
  fileCount: 77,
  version: '0.0.13',
  vite: '5.4.21',
  playwright: '1.60.0',
});

export const MAIN95_NESTED_COHORT = Object.freeze({
  TIMELINE_CURRENT013_AGENT_SHA: MAIN95_AGENT.commit,
  TIMELINE_CURRENT013_RUNTIME_SHA: MAIN95_RUNTIME.commit,
  TIMELINE_CURRENT013_PUBLIC_SOURCE_SHA256: MAIN95_COMPOSITION.sha256.slice('sha256:'.length),
});

export const SETTINGS_CASE = 'M2 real embedded settings prompt: native shot.set preserves exact raw settings, retries after restart, and undoes through Runtime';
export const MAIN95_BROWSER = Object.freeze({
  executable: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  sha256: 'sha256:85918a9937192b78da8edb51c38a7af4920ac6bd9ba19939ecb0bb724d5a1a95',
  version: /^Chromium 141\.0\.7390\.37\s*$/,
});

const FULL_SHA = /^[a-f0-9]{40}$/;
const FULL_DIGEST = /^sha256:[a-f0-9]{64}$/;
const APP_METADATA = 'src/integrations/runtime/generated-contract-metadata.ts';
const AGENT_METADATA = 'astrid_runtime_client/contract_metadata.py';
const SHARED_ROOTS = ['/home/user/work/app/node_modules', '/home/user/work/runtimes/'];

function fail(message) {
  throw new Error(`[main95-prompt-settings] ${message}`);
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

function requiredDigest(env, name) {
  const value = required(env, name);
  if (!FULL_DIGEST.test(value)) fail(`${name} must be a sha256 digest`);
  return value;
}

export function validateMain95NestedCohort(env) {
  for (const [name, expected] of Object.entries(MAIN95_NESTED_COHORT)) {
    const value = env[name];
    if (!value) fail(`${name} is required; no moving-repo default is allowed`);
    if (value !== expected) fail(`${name} must match the validated Main95 current tuple`);
  }
  return Object.freeze({ ...MAIN95_NESTED_COHORT });
}

function requiredPath(env, name) {
  const value = required(env, name);
  if (!path.isAbsolute(value)) fail(`${name} must be an absolute path`);
  if (!existsSync(value)) fail(`${name} does not exist: ${value}`);
  if (!lstatSync(value).isDirectory()) fail(`${name} must name a directory: ${value}`);
  return realpathSync(value);
}

function requiredExecutable(env, name) {
  const value = required(env, name);
  if (!path.isAbsolute(value)) fail(`${name} must be an absolute path`);
  if (!existsSync(value) || !statSync(value).isFile()) fail(`${name} must name a file: ${value}`);
  try { accessSync(value, constants.X_OK); } catch { fail(`${name} must be executable: ${value}`); }
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

function metadata(root, label, file) {
  const source = readFileSync(path.join(root, file), 'utf8');
  const value = (name) => {
    const match = source.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`));
    if (!match) fail(`${label} metadata is missing ${name}`);
    return match[1];
  };
  const result = {
    contractVersion: value('CONTRACT_VERSION'),
    schemaDigest: value('SCHEMA_DIGEST'),
    componentManifest: value('COMPONENT_MANIFEST_SHA256'),
  };
  if (result.contractVersion !== MAIN95_RUNTIME.version) fail(`${label} contract is ${result.contractVersion}, expected ${MAIN95_RUNTIME.version}`);
  if (result.schemaDigest !== MAIN95_RUNTIME.schemaDigest) fail(`${label} schema is ${result.schemaDigest}, expected ${MAIN95_RUNTIME.schemaDigest}`);
  if (result.componentManifest !== MAIN95_RUNTIME.componentManifest) fail(`${label} component manifest is ${result.componentManifest}, expected ${MAIN95_RUNTIME.componentManifest}`);
  return result;
}

function checkClean(root, label) {
  const status = git(root, 'status', '--porcelain', '--untracked-files=normal');
  if (status) fail(`${label} source is dirty:\n${status}`);
}

function checkLock(root, label) {
  const lock = jsonFile(path.join(root, 'runtime.lock.json'));
  if (lock.producer !== 'astrid-runtime') fail(`${label} Runtime lock producer is ${lock.producer}`);
  if (lock.source_commit !== MAIN95_RUNTIME.commit) fail(`${label} Runtime source is ${lock.source_commit}, expected ${MAIN95_RUNTIME.commit}`);
  if (lock.producer_version !== MAIN95_RUNTIME.producerVersion) fail(`${label} Runtime producer version is ${lock.producer_version}, expected ${MAIN95_RUNTIME.producerVersion}`);
  return { sha256: sha256File(path.join(root, 'runtime.lock.json')) };
}

function checkManifest(runtime) {
  const file = path.join(runtime, 'contract/artifacts.json');
  const manifest = jsonFile(file);
  if (manifest.producer !== 'astrid-runtime') fail(`Runtime manifest producer is ${manifest.producer}`);
  if (manifest.version !== MAIN95_RUNTIME.producerVersion) fail(`Runtime manifest version is ${manifest.version}`);
  const artifacts = manifest.artifacts ?? {};
  if (Object.keys(artifacts).length !== MAIN95_RUNTIME.artifactCount) fail(`Runtime manifest has ${Object.keys(artifacts).length} artifacts, expected ${MAIN95_RUNTIME.artifactCount}`);
  for (const [relative, digest] of Object.entries(artifacts)) {
    const artifact = path.join(runtime, relative);
    if (!existsSync(artifact) || !lstatSync(artifact).isFile()) fail(`Runtime artifact is missing: ${relative}`);
    if (sha256File(artifact) !== digest) fail(`Runtime artifact changed: ${relative}`);
  }
  const bundle = 'runtime_protocol/schemas/timeline-commit-bundle.json';
  if (sha256File(path.join(runtime, bundle)) !== MAIN95_RUNTIME.timelineBundle) fail(`Runtime timeline bundle is not the Main95 artifact`);
  return { sha256: sha256File(file), artifactCount: Object.keys(artifacts).length };
}

function compositionArchive(root, label, relative) {
  const file = path.join(root, relative, MAIN95_COMPOSITION.archive);
  if (!existsSync(file)) fail(`${label} Composition archive is missing: ${file}`);
  if (sha256File(file) !== MAIN95_COMPOSITION.sha256) fail(`${label} Composition archive is not the approved 0.0.13 artifact`);
  const members = execFileSync('tar', ['-tzf', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n')
    .filter((member) => member && !member.endsWith('/'));
  if (members.length !== MAIN95_COMPOSITION.fileCount || new Set(members).size !== members.length) fail(`${label} Composition archive must contain exactly 77 regular files`);
  if (members.some((member) => !member.startsWith('package/') || member.slice('package/'.length).split('/').includes('..'))) fail(`${label} Composition archive contains an unsafe member`);
  return { sha256: MAIN95_COMPOSITION.sha256, fileCount: members.length };
}

function runNormalVendorCheck(input) {
  const app = spawnSync(process.execPath, [path.join(input.app, 'scripts/vendor-lock.mjs'), 'check', path.join(input.app, 'runtime.lock.json'), '--producer', input.runtimeProducer], {
    cwd: input.app, env: input.env, stdio: 'inherit', shell: false,
  });
  if (app.error) fail(`App normal Runtime vendor-lock check could not start: ${app.error.message}`);
  if (app.status !== 0) fail(`App normal Runtime vendor-lock check failed (exit ${app.status ?? 'signal'})`);
  const agent = spawnSync(input.agentPython, [path.join(input.agent, 'scripts/vendor_lock.py'), 'check', path.join(input.agent, 'runtime.lock.json'), '--producer', input.runtimeProducer], {
    cwd: input.agent, env: input.env, stdio: 'inherit', shell: false,
  });
  if (agent.error) fail(`Agent normal Runtime vendor-lock check could not start: ${agent.error.message}`);
  if (agent.status !== 0) fail(`Agent normal Runtime vendor-lock check failed (exit ${agent.status ?? 'signal'})`);
  const vendor = spawnSync(process.execPath, [path.join(input.app, 'scripts/build/verify-astrid-vendor-sources.mjs')], {
    cwd: input.app, env: input.env, stdio: 'inherit', shell: false,
  });
  if (vendor.error) fail(`normal Astrid vendor verifier could not start: ${vendor.error.message}`);
  if (vendor.status !== 0) fail(`normal Astrid vendor verifier failed (exit ${vendor.status ?? 'signal'})`);
}

function checkPythonImports(input) {
  const env = {
    ...input.env,
    PYTHONPATH: [input.agent, input.runtime].join(path.delimiter),
    PYTHONDONTWRITEBYTECODE: '1',
  };
  const result = spawnSync(input.agentPython, ['-B', '-c', [
    'import astrid_runtime_client, runtime_protocol',
    'from astrid_runtime_client import contract_metadata',
    `assert contract_metadata.SCHEMA_DIGEST == ${JSON.stringify(MAIN95_RUNTIME.schemaDigest)}`,
    `assert contract_metadata.COMPONENT_MANIFEST_SHA256 == ${JSON.stringify(MAIN95_RUNTIME.componentManifest)}`,
    'print(astrid_runtime_client.__file__)',
    'print(runtime_protocol.__file__)',
  ].join('; ')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) fail(`Agent/Runtime Python import could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`Agent/Runtime Python import failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
  const lines = result.stdout.trim().split('\n');
  if (!lines[0]?.startsWith(input.agent)) fail(`Agent import escaped the exact checkout: ${lines[0]}`);
  if (!lines[1]?.startsWith(input.runtime)) fail(`Runtime import escaped the exact checkout: ${lines[1]}`);
  const runtimeEnv = { ...env, PYTHONPATH: [input.runtime, input.agent].join(path.delimiter) };
  const runtimeResult = spawnSync(input.runtimePython, ['-B', '-c', 'import runtime_protocol; print(runtime_protocol.__file__)'], {
    env: runtimeEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (runtimeResult.error) fail(`Runtime Python import could not start: ${runtimeResult.error.message}`);
  if (runtimeResult.status !== 0) fail(`Runtime Python import failed: ${runtimeResult.stderr?.trim() || `exit ${runtimeResult.status}`}`);
  if (!runtimeResult.stdout.trim().startsWith(input.runtime)) fail(`Runtime Python import escaped the exact checkout: ${runtimeResult.stdout.trim()}`);
}

export function validateMain95Vendor(provenance, moduleBytes) {
  if (provenance?.astrid_commit !== MAIN95_VENDOR.commit || provenance?.astrid_tree !== MAIN95_VENDOR.tree) {
    fail(`public Astrid vendor provenance is not the independently qualified ${MAIN95_VENDOR.commit}/${MAIN95_VENDOR.tree}`);
  }
  const files = provenance?.files ?? {};
  if (Object.keys(files).length !== MAIN95_VENDOR.fileCount) fail(`public Astrid vendor has ${Object.keys(files).length} files, expected ${MAIN95_VENDOR.fileCount}`);
  if (files[MAIN95_VENDOR.module] !== MAIN95_VENDOR.moduleSha256) fail('public Astrid vendor module provenance hash changed');
  const moduleSha256 = createHash('sha256').update(moduleBytes).digest('hex');
  if (moduleSha256 !== MAIN95_VENDOR.moduleSha256) fail('public Astrid vendor module bytes changed');
  if (provenance.astrid_commit === MAIN95_AGENT.commit && provenance.astrid_tree === MAIN95_AGENT.tree) fail('public Astrid vendor must not be the frozen execution Agent role');
  return Object.freeze({ commit: provenance.astrid_commit, tree: provenance.astrid_tree, fileCount: Object.keys(files).length, module: MAIN95_VENDOR.module, moduleSha256 });
}

function checkPublicVendor(app) {
  const provenancePath = path.join(app, 'vendor/astrid-browser/provenance.json');
  const provenance = jsonFile(provenancePath);
  validateMain95Vendor(provenance, readFileSync(path.join(app, 'vendor/astrid-browser', MAIN95_VENDOR.module)));
}

function countRegularFiles(root) {
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) count += countRegularFiles(full);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function checkPrivateGraph(input) {
  const graph = input.privateGraph;
  for (const shared of SHARED_ROOTS) {
    if (graph === shared || graph.startsWith(shared)) fail(`private graph resolves into shared dependency storage: ${graph}`);
  }
  if (lstatSync(graph).isSymbolicLink()) fail('private graph root must not be a symlink');
  const ready = readFileSync(input.privateReady, 'utf8');
  if (!ready.includes('all 77 archive files')) fail('private graph READY record does not certify the 77-file Composition archive');
  const composition = path.join(graph, '@banodoco/timeline-composition');
  const compositionPackage = jsonFile(path.join(composition, 'package.json'));
  if (compositionPackage.version !== MAIN95_COMPOSITION.version) fail(`private Composition version is ${compositionPackage.version}`);
  if (countRegularFiles(composition) !== MAIN95_COMPOSITION.fileCount) fail('private Composition graph is not the all-77-file artifact');
  for (const [name, version] of [['vite', MAIN95_COMPOSITION.vite], ['@playwright/test', MAIN95_COMPOSITION.playwright]]) {
    const packageJson = jsonFile(path.join(graph, name, 'package.json'));
    if (packageJson.version !== version) fail(`private ${name} is ${packageJson.version}, expected ${version}`);
  }
  const viteBin = realpathSync(path.join(graph, '.bin/vite'));
  if (!viteBin.startsWith(graph + path.sep)) fail('private Vite executable escaped the private graph');
}

function checkResolvedPrivatePackages(app, graph) {
  const script = "for (const name of ['vite','@playwright/test','@banodoco/timeline-composition']) console.log(require.resolve(name + '/package.json'))";
  const result = spawnSync(process.execPath, ['-e', script], { cwd: app, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) fail(`private Node package resolution could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`private Node package resolution failed: ${result.stderr?.trim()}`);
  for (const resolved of result.stdout.trim().split('\n')) {
    if (!resolved.startsWith(graph + path.sep)) fail(`Node package resolved outside private graph: ${resolved}`);
  }
}

export function readMain95Inputs(env = process.env, appRoot = process.cwd()) {
  const appTree = requiredSha(env, 'TIMELINE_MAIN95_PROMPT_APP_TREE');
  const agentSha = requiredSha(env, 'TIMELINE_MAIN95_PROMPT_AGENT_SHA');
  const runtimeSha = requiredSha(env, 'TIMELINE_MAIN95_PROMPT_RUNTIME_SHA');
  const runnerSha256 = requiredDigest(env, 'TIMELINE_MAIN95_PROMPT_RUNNER_SHA256');
  if (agentSha !== MAIN95_AGENT.commit) fail(`TIMELINE_MAIN95_PROMPT_AGENT_SHA must be the frozen Agent ${MAIN95_AGENT.commit}`);
  if (runtimeSha !== MAIN95_RUNTIME.commit) fail(`TIMELINE_MAIN95_PROMPT_RUNTIME_SHA must be the frozen Runtime ${MAIN95_RUNTIME.commit}`);
  const nestedCohort = validateMain95NestedCohort(env);
  const app = realpathSync(appRoot);
  const agent = requiredPath(env, 'ASTRID_CHECKOUT');
  const vendor = requiredPath(env, 'TIMELINE_MAIN95_PROMPT_VENDOR_CHECKOUT');
  const runtime = requiredPath(env, 'ASTRID_RUNTIME_CHECKOUT');
  const runtimeProducer = requiredPath(env, 'TIMELINE_MAIN95_PROMPT_RUNTIME_PRODUCER_CHECKOUT');
  const agentPython = requiredExecutable(env, 'ASTRID_PYTHON');
  const runtimePython = requiredExecutable(env, 'ASTRID_RUNTIME_PYTHON');
  const browser = requiredExecutable(env, 'PLAYWRIGHT_CHROMIUM_EXECUTABLE');
  const browsersPath = requiredPath(env, 'PLAYWRIGHT_BROWSERS_PATH');
  const privateGraph = requiredPath(env, 'TIMELINE_MAIN95_PROMPT_PRIVATE13_NODE_MODULES');
  const privateReady = required(env, 'TIMELINE_MAIN95_PROMPT_PRIVATE13_READY');
  if (!path.isAbsolute(privateReady) || !existsSync(privateReady)) fail(`TIMELINE_MAIN95_PROMPT_PRIVATE13_READY does not name an existing absolute file`);
  if (env.ASTRID_PUBLIC_CHECKOUT || env.ASTRID_APP_DIRECT_DIST) fail('public checkout and direct dist overrides are forbidden');
  if ((env.NODE_OPTIONS ?? '').split(/\s+/).some((value) => ['--require', '--import', '--loader'].includes(value) || value.startsWith('--require=') || value.startsWith('--import=') || value.startsWith('--loader='))) fail('NODE_OPTIONS preload/loader overrides are forbidden');
  if (browser !== MAIN95_BROWSER.executable || sha256File(browser) !== MAIN95_BROWSER.sha256) fail('PLAYWRIGHT_CHROMIUM_EXECUTABLE is not the frozen Chromium 141 binary');
  if (browsersPath !== '/opt/pw-browsers') fail(`PLAYWRIGHT_BROWSERS_PATH must be /opt/pw-browsers, got ${browsersPath}`);
  const browserVersion = execFileSync(browser, ['--version'], { encoding: 'utf8' }).trim();
  if (!MAIN95_BROWSER.version.test(browserVersion)) fail(`Chromium version is ${browserVersion}, expected Chromium 141.0.7390.37`);
  return Object.freeze({ app, appTree, agent, agentSha, vendor, runtime, runtimeSha, runtimeProducer, agentPython, runtimePython, browser, browsersPath, privateGraph, privateReady, runnerSha256, nestedCohort, env });
}

export function checkMain95Sources(input, { vendor = true } = {}) {
  if (git(input.app, 'rev-parse', '--show-toplevel') !== input.app) fail(`App root is not the current checkout: ${input.app}`);
  if (git(input.app, 'rev-parse', 'HEAD^{tree}') !== input.appTree) fail(`App source tree changed: expected ${input.appTree}`);
  if (git(input.agent, 'rev-parse', 'HEAD') !== input.agentSha || git(input.agent, 'rev-parse', 'HEAD^{tree}') !== MAIN95_AGENT.tree) fail('Agent is not exact Main95 Agent6ef');
  if (git(input.vendor, 'rev-parse', 'HEAD') !== MAIN95_VENDOR.commit || git(input.vendor, 'rev-parse', 'HEAD^{tree}') !== MAIN95_VENDOR.tree) fail('Vendor source is not exact Main95 vendor Agent091aa');
  if (git(input.runtime, 'rev-parse', 'HEAD') !== input.runtimeSha || git(input.runtime, 'rev-parse', 'HEAD^{tree}') !== MAIN95_RUNTIME.tree) fail('Runtime is not exact Main95 Runtime95');
  if (git(input.runtimeProducer, 'rev-parse', 'HEAD') !== MAIN95_RUNTIME.commit || git(input.runtimeProducer, 'rev-parse', 'HEAD^{tree}') !== MAIN95_RUNTIME.tree) fail('Runtime producer is not exact Main95 Runtime95');
  if (sha256File(new URL(import.meta.url)) !== input.runnerSha256) fail('prompt/settings runner source hash changed');
  checkClean(input.app, 'App');
  checkClean(input.agent, 'Agent');
  checkClean(input.vendor, 'Vendor source');
  checkClean(input.runtime, 'Runtime');
  checkClean(input.runtimeProducer, 'Runtime producer');
  checkLock(input.app, 'App');
  checkLock(input.agent, 'Agent');
  metadata(input.app, 'App', APP_METADATA);
  metadata(input.agent, 'Agent', AGENT_METADATA);
  checkManifest(input.runtimeProducer);
  compositionArchive(input.app, 'App', 'vendor/artifacts');
  compositionArchive(input.agent, 'Agent', 'remotion/artifacts');
  const vendorModule = path.join(input.vendor, MAIN95_VENDOR.module);
  if (sha256File(vendorModule) !== `sha256:${MAIN95_VENDOR.moduleSha256}`) fail('vendor source module bytes changed');
  checkPublicVendor(input.app);
  checkPrivateGraph(input);
  checkPythonImports(input);
  if (vendor) runNormalVendorCheck(input);
  return Object.freeze({ appTree: input.appTree, agent: MAIN95_AGENT, runtime: MAIN95_RUNTIME });
}

function prepareOverlay(input, root) {
  const overlay = path.join(root, 'node_modules');
  mkdirSync(overlay, { recursive: true });
  for (const entry of readdirSync(input.privateGraph)) {
    if (entry === '.vite' || entry === '.vite-temp') continue;
    symlinkSync(path.join(input.privateGraph, entry), path.join(overlay, entry));
  }
  mkdirSync(path.join(overlay, '.vite'), { recursive: true });
  mkdirSync(path.join(overlay, '.vite-temp'), { recursive: true });
  return overlay;
}

function swapAppNodeModules(app, overlay) {
  const link = path.join(app, 'node_modules');
  const stat = lstatSync(link);
  if (!stat.isSymbolicLink() || realpathSync(link) !== '/home/user/work/app/node_modules') fail('App node_modules is not the expected shared symlink; refusing to replace it');
  const target = `${path.relative(app, overlay)}`;
  unlinkSync(link);
  symlinkSync(target, link);
  return () => {
    unlinkSync(link);
    symlinkSync('/home/user/work/app/node_modules', link);
  };
}

function runResolver(input) {
  const result = spawnSync(process.execPath, ['--test', 'config/vite/timelineCompositionPackage.test.mjs'], {
    cwd: input.app, env: input.env, stdio: 'inherit', shell: false,
  });
  if (result.error) fail(`private Node/Vite resolver check could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`private Node/Vite resolver check failed (exit ${result.status ?? 'signal'})`);
}

export function buildMain95ChildEnv(input, outputDir) {
  return {
    ...input.env,
    ASTRID_CHECKOUT: input.agent,
    ASTRID_RUNTIME_CHECKOUT: input.runtime,
    ASTRID_PYTHON: input.agentPython,
    ASTRID_RUNTIME_PYTHON: input.runtimePython,
    TIMELINE_BUNDLE_AGENT_HEAD: input.agentSha,
    TIMELINE_BUNDLE_RUNTIME_HEAD: input.runtimeSha,
    ...input.nestedCohort,
    PLAYWRIGHT_OUTPUT_DIR: outputDir,
    VITEST_CACHE_DIR: path.join(outputDir, 'vitest-cache'),
    TMPDIR: path.join(outputDir, 'tmp'),
  };
}

function runPlaywright(input, outputDir) {
  const env = buildMain95ChildEnv(input, outputDir);
  mkdirSync(env.TMPDIR, { recursive: true });
  const list = spawnSync(process.execPath, [path.join(input.privateGraph, '.bin/playwright'), 'test', '--config', 'playwright.shot-name.config.ts', '--grep', SETTINGS_CASE, '--list'], {
    cwd: input.app, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  const discovery = `${list.stdout}\n${list.stderr}`;
  if (list.error) fail(`Main95 SettingsAutoDisable discovery could not start: ${list.error.message}`);
  if (list.status !== 0) fail(`Main95 SettingsAutoDisable discovery failed (exit ${list.status ?? 'signal'}): ${discovery}`);
  if (!/Total:\s+1 test in 1 file/.test(discovery) || (discovery.match(/shot-name-command\.spec\.ts:/g) || []).length !== 1) fail(`Main95 SettingsAutoDisable discovery did not select exactly one test: ${discovery}`);
  console.log('[main95-prompt-settings] discovery selected exactly one SettingsAutoDisable case');
  if (process.env.TIMELINE_MAIN95_PROMPT_SKIP_BROWSER === '1') return 0;
  const run = spawnSync(process.execPath, [path.join(input.privateGraph, '.bin/playwright'), 'test', '--config', 'playwright.shot-name.config.ts', '--grep', SETTINGS_CASE], {
    cwd: input.app, env, stdio: 'inherit', shell: false,
  });
  if (run.error) fail(`Main95 SettingsAutoDisable browser run could not start: ${run.error.message}`);
  return run.status ?? 1;
}

export function runMain95PromptSettingsIntegration() {
  if (process.env.TIMELINE_MAIN95_PROMPT_RUN !== '1') fail('set TIMELINE_MAIN95_PROMPT_RUN=1 only for the registered Main95 central suite');
  const input = readMain95Inputs();
  const before = checkMain95Sources(input);
  const runRoot = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'timeline-main95-prompt-'));
  const outputDir = path.join(runRoot, 'playwright-output');
  mkdirSync(outputDir, { recursive: true });
  const overlay = prepareOverlay(input, runRoot);
  let restore;
  let status = 1;
  try {
    restore = swapAppNodeModules(input.app, overlay);
    checkResolvedPrivatePackages(input.app, input.privateGraph);
    runResolver(input);
    status = runPlaywright(input, outputDir);
    if (process.env.TIMELINE_MAIN95_PROMPT_SKIP_BROWSER === '1') console.log('[main95-prompt-settings] browser execution explicitly skipped by caller');
  } finally {
    if (restore) restore();
    const after = checkMain95Sources(input);
    if (JSON.stringify(after) !== JSON.stringify(before)) fail('Main95 source checks changed between preflight and postflight');
    rmSync(runRoot, { recursive: true, force: true });
    console.log('[main95-prompt-settings] exact source postflight passed');
  }
  process.exitCode = status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMain95PromptSettingsIntegration();

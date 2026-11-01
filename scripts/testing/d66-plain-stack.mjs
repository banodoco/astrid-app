import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const orch = '/tmp/claude-0/-home-user-repo/7dc61be1-7066-52e0-a5d0-94f90e61430a/scratchpad/orch';
const nodeDir = '/home/user/work/runtimes/agent-remotion-app-p1-787-2a9-1830/.toolchain/node-v20.19.4-linux-x64/bin';
const node = path.join(nodeDir, 'node');
const readiness = 'tests/e2e/local/three-products.mounted-readiness.spec.ts';
export const suites = {
  p1: { files: ['tests/e2e/local/three-products.p1-chain.spec.ts'], count: 2 },
  p2: {
    files: ['tests/e2e/local/three-products.p2-tour.spec.ts', 'tests/e2e/local/three-products.p2-elements-assets.spec.ts'],
    count: 6,
    retainRuntimeLogs: true,
  },
  'p2-element': {
    files: ['tests/e2e/local/three-products.p2-elements-assets.spec.ts'], count: 1,
    grep: 'P2 mounted element edit: real catalog apply, exact params patch, reload and guarded Undo$',
    retainRuntimeLogs: true,
  },
  'p2-element-verify': {
    files: ['tests/e2e/local/three-products.p2-elements-assets.spec.ts'], count: 1,
    grep: 'P2 mounted element edit: real catalog apply, exact params patch, reload and guarded Undo$',
    retainRuntimeLogs: true,
    verificationOnly: true,
  },
  'p2-register-asset': {
    files: ['tests/e2e/local/three-products.p2-elements-assets.spec.ts'], count: 1,
    grep: 'P2 mounted registerAsset save: real file drop, exact media/registry fields, reload and guarded Undo$',
    retainRuntimeLogs: true,
  },
  'p2-automatic-child-placement': {
    files: ['tests/e2e/local/three-products.p2-elements-assets.spec.ts'], count: 1,
    grep: 'P2 mounted automatic child placement: embedded shot file gesture, occurrence command, closure and guarded Undo$',
    retainRuntimeLogs: true,
  },
  'p2-parent-move': {
    files: ['tests/e2e/local/three-products.p2-tour.spec.ts'], count: 1,
    grep: 'P2 mounted single parent move: v2 commit, exact field delta, reload and guarded Undo$',
    retainRuntimeLogs: true,
  },
  'p2-transition-none-single': {
    files: ['tests/e2e/local/three-products.p2-tour.spec.ts'], count: 1,
    grep: 'P2 mounted transition None single: raw clear preserves opaque data/order and guarded Undo$',
    retainRuntimeLogs: true,
  },
  'p2-transition-none-bulk': {
    files: ['tests/e2e/local/three-products.p2-tour.spec.ts'], count: 1,
    grep: 'P2 mounted transition None bulk: atomic raw clears preserve unknown fields/order and guarded Undo$',
    retainRuntimeLogs: true,
  },
  p3: { files: ['tests/e2e/local/three-products.spec.ts'], count: 1,
    grep: 'M2 real gate 5 \\(M1 real mounted path\\): Agent edit, lost ACK, newer local gesture, exact retry, restart and undo preserve intent$' },
  'live-edit-smoke': { files: ['tests/e2e/local/three-products.live-edit-smoke.spec.ts'], count: 1,
    grep: 'D79 live-edit smoke: Agent edit arrives during a held drag and remote undo stays safe$' },
};

const normalHomes = {
  app: root,
  agent: process.env.D66_NORMAL_AGENT_HOME ?? '/home/user/work/agent',
  runtime: process.env.D66_NORMAL_RUNTIME_HOME ?? '/home/user/work/runtime',
  composition: process.env.D66_NORMAL_COMPOSITION_HOME ?? '/home/user/work/composition',
};

const sourceRoles = ['app', 'agent', 'runtime', 'composition'];
const checkoutPrefixes = { app: 'app-pin', agent: 'agt-pin', runtime: 'rt-pin', composition: 'vw-pin' };
const P2_PHASE_CAPTURE_HELPER = 'tests/helpers/p2_commit_phase_capture.py';
export const D66_PHASE_CAPTURE_HELPER_ENV = 'D66_P2_COMMIT_PHASE_CAPTURE_HELPER';
export const D66_PHASE_CAPTURE_HELPER_SHA256_ENV = 'D66_P2_COMMIT_PHASE_CAPTURE_HELPER_SHA256';
export const D66_ELEMENT_VERIFICATION_ENV = 'D66_ELEMENT_VERIFICATION_ONLY';
const ASTRID_PHASE_CAPTURE_HELPER_ENV = 'ASTRID_P2_COMMIT_PHASE_CAPTURE_HELPER';
const ASTRID_PHASE_CAPTURE_HELPER_SHA256_ENV = 'ASTRID_P2_COMMIT_PHASE_CAPTURE_HELPER_SHA256';

const selectedEnvironment = {
  app: ['D66_APP_CHECKOUT'],
  agent: ['D66_AGENT_CHECKOUT', 'ASTRID_CHECKOUT'],
  runtime: ['D66_RUNTIME_CHECKOUT', 'ASTRID_RUNTIME_CHECKOUT'],
  composition: ['D66_COMPOSITION_CHECKOUT'],
};

const pinEnvironment = {
  app: ['D66_APP_SHA', 'D66_APP_TREE'],
  agent: ['D66_AGENT_SHA', 'D66_AGENT_TREE'],
  runtime: ['D66_RUNTIME_SHA', 'D66_RUNTIME_TREE'],
  composition: ['D66_COMPOSITION_SHA', 'D66_COMPOSITION_TREE'],
};

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function optionalGit(dir, args) {
  try { return git(dir, args); } catch { return null; }
}

export function exactCheckoutPath(role, head, checkoutRoot = '/home/user/work/wt') {
  return path.join(checkoutRoot, `${checkoutPrefixes[role]}-${head.slice(0, 8)}`);
}

function missingCheckoutError(role, head, checkout) {
  return new Error(`D66 ${role} exact checkout is unavailable at ${checkout}; request-checkout ${role} ${head} "D66 exact ${role} source"`);
}

/** Pure control shared by the launcher and its focused tests. */
export function validateSelectedSource({ role, selected, normal, normalState, selectedState }) {
  if (!selected || selected === normal) throw new Error(`D66 ${role} source must be a per-request checkout, not its mutable normal home`);
  if (selectedState.root !== selected) throw new Error(`D66 ${role} source root mismatch: ${selectedState.root}`);
  if (selectedState.branch) throw new Error(`D66 ${role} source must be detached: ${selected}`);
  if (selectedState.dirty) throw new Error(`D66 ${role} source is dirty: ${selected}`);
  if (selectedState.head !== normalState.head || selectedState.tree !== normalState.tree) {
    throw new Error(`D66 ${role} source is not the current normal head: selected ${selectedState.head}/${selectedState.tree}, current ${normalState.head}/${normalState.tree}; use detached exact checkout ${exactCheckoutPath(role, normalState.head)}`);
  }
  return { checkout: selected, head: selectedState.head, tree: selectedState.tree, normal_home: normal, normal_head: normalState.head, normal_tree: normalState.tree };
}

function validateObjectId(value, label) {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) throw new Error(`D66 ${label} must be a full 40-character SHA`);
  return value;
}

/** Validate one immutable source against the submit-time pin, without reading its normal home. */
export function validatePinnedSource({ role, selected, normal, expectedHead, expectedTree, selectedState }) {
  validateObjectId(expectedHead, `${role} SHA`);
  validateObjectId(expectedTree, `${role} tree`);
  if (!selected || !path.isAbsolute(selected)) throw new Error(`D66 ${role} source must be an absolute exact checkout path`);
  if (selected === normal) throw new Error(`D66 ${role} source must be a per-request checkout, not its mutable normal home`);
  if (selectedState.root !== selected) throw new Error(`D66 ${role} source root mismatch: ${selectedState.root}`);
  if (selectedState.branch) throw new Error(`D66 ${role} source must be detached: ${selected}`);
  if (selectedState.dirty) throw new Error(`D66 ${role} source is dirty: ${selected}`);
  if (selectedState.head !== expectedHead || selectedState.tree !== expectedTree) {
    throw new Error(`D66 ${role} source does not match its submit-time pin: selected ${selectedState.head}/${selectedState.tree}, pinned ${expectedHead}/${expectedTree}`);
  }
  return { checkout: selected, head: expectedHead, tree: expectedTree, normal_home: normal };
}

export function validatePinnedSources({ sources, appRootState = null }) {
  for (const role of sourceRoles) {
    const source = sources?.[role];
    if (!source) throw new Error(`D66 ${role} exact source is required`);
    validatePinnedSource({ role, selected: source.checkout, normal: source.normal_home,
      expectedHead: source.head, expectedTree: source.tree,
      selectedState: source.state ?? { root: source.checkout, head: source.head, tree: source.tree, branch: null, dirty: false } });
  }
  if (appRootState) {
    const exactHead = appRootState.head === sources.app.head;
    // test-run always wraps the target tree in a commit with the target HEAD as its sole parent.
    const snapshot = appRootState.parents?.length === 1 && appRootState.parents[0] === sources.app.head;
    if (appRootState.tree !== sources.app.tree || (!exactHead && !snapshot)) {
      throw new Error(`D66 App service source does not match its submit-time pin or direct unchanged-tree snapshot: ${appRootState.head}/${appRootState.tree}, pinned ${sources.app.head}/${sources.app.tree}`);
    }
  }
  if (appRootState?.dirty) throw new Error('D66 App service source is dirty');
  return sources;
}

function checkoutState(checkout) {
  const resolved = realpathSync(checkout);
  if (!statSync(resolved).isDirectory()) throw new Error(`D66 source is not a directory: ${checkout}`);
  const rootPath = realpathSync(git(resolved, ['rev-parse', '--show-toplevel']));
  const state = {
    root: rootPath,
    head: git(resolved, ['rev-parse', 'HEAD']),
    tree: git(resolved, ['rev-parse', 'HEAD^{tree}']),
    parents: git(resolved, ['show', '-s', '--format=%P', 'HEAD']).split(' ').filter(Boolean),
    branch: optionalGit(resolved, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    dirty: Boolean(git(resolved, ['status', '--porcelain=v1', '--untracked-files=all'])),
  };
  if (state.root !== resolved) throw new Error(`D66 source Git root differs from path: ${resolved}`);
  return state;
}

export function selectPinnedSources(env = process.env, homes = normalHomes, appRoot = root) {
  const selected = {};
  // Refuse incomplete tuples before touching any selected checkout.
  for (const role of sourceRoles) {
    for (const key of pinEnvironment[role]) validateObjectId(env[key]?.trim(), `${role} ${key.endsWith('_SHA') ? 'SHA' : 'tree'}`);
  }
  for (const role of sourceRoles) {
    const [headKey, treeKey] = pinEnvironment[role];
    const expectedHead = env[headKey]?.trim();
    const expectedTree = env[treeKey]?.trim();
    const normal = realpathSync(homes[role]);
    const key = selectedEnvironment[role].find((candidate) => env[candidate]?.trim());
    const requested = key ? env[key].trim() : exactCheckoutPath(role, expectedHead);
    if (!key && !existsSync(requested)) throw missingCheckoutError(role, expectedHead, requested);
    if (!path.isAbsolute(requested)) throw new Error(`D66 ${role} source must be an absolute checkout path: ${requested}`);
    const selectedRoot = realpathSync(requested);
    const state = checkoutState(selectedRoot);
    selected[role] = validatePinnedSource({
      role, selected: selectedRoot, normal, expectedHead, expectedTree, selectedState: state,
    });
    selected[role].state = state;
  }
  validatePinnedSources({ sources: selected, appRootState: checkoutState(appRoot) });
  return selected;
}

function assertSourcesUnchanged(sources) {
  for (const role of sourceRoles) {
    const state = checkoutState(sources[role].checkout);
    assert.equal(state.head, sources[role].head, `D66 ${role} checkout HEAD changed during run`);
    assert.equal(state.tree, sources[role].tree, `D66 ${role} checkout tree changed during run`);
    assert.equal(state.branch, null, `D66 ${role} checkout became attached during run`);
    assert.equal(state.dirty, false, `D66 ${role} checkout became dirty during run`);
  }
  validatePinnedSources({ sources, appRootState: checkoutState(root) });
}

function requireExecutable(file, label) {
  if (!path.isAbsolute(file) || !existsSync(file) || !statSync(file).isFile()) throw new Error(`D66 ${label} is unavailable: ${file}`);
  return file;
}

function helperSha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function validateDiagnosticHelper({ path: helperPath, sha256, required = true, explicit = true }) {
  if (!helperPath) {
    if (!required) return null;
    throw new Error('D66 diagnostic helper path is required');
  }
  if (!path.isAbsolute(helperPath)) throw new Error(`D66 diagnostic helper path must be absolute: ${helperPath}`);
  if (!existsSync(helperPath) || !lstatSync(helperPath).isFile() || lstatSync(helperPath).isSymbolicLink()) throw new Error(`D66 diagnostic helper file is unavailable: ${helperPath}`);
  if (explicit && !/^[0-9a-f]{64}$/.test(sha256 ?? '')) {
    throw new Error('D66 diagnostic helper SHA256 must be a 64-character lowercase hex digest');
  }
  const actual = helperSha256(helperPath);
  if (sha256 && actual !== sha256) throw new Error(`D66 diagnostic helper SHA256 mismatch: ${helperPath}`);
  return { path: helperPath, sha256: actual, source: explicit ? 'explicit' : 'runtime-checkout' };
}

function diagnosticHelperOverride(env = process.env) {
  const helperPath = (env[D66_PHASE_CAPTURE_HELPER_ENV] ?? env[ASTRID_PHASE_CAPTURE_HELPER_ENV])?.trim();
  const sha256 = (env[D66_PHASE_CAPTURE_HELPER_SHA256_ENV] ?? env[ASTRID_PHASE_CAPTURE_HELPER_SHA256_ENV])?.trim();
  if (!helperPath && !sha256) return null;
  return { path: helperPath, sha256 };
}

/** Resolve the existing pinned helper by default, or an explicitly reviewed helper with its identity. */
export function diagnosticHelperIdentity({ runtimeCheckout, env = process.env, required = false } = {}) {
  const override = diagnosticHelperOverride(env);
  if (override) return validateDiagnosticHelper({ ...override, explicit: true });
  if (!required) return null;
  const defaultPath = path.join(runtimeCheckout, P2_PHASE_CAPTURE_HELPER);
  // Offline D66 controls use source-only Runtime fixtures. The real harness still fails closed
  // when it prepares the existing hook if the selected pinned helper is absent.
  return existsSync(defaultPath) ? validateDiagnosticHelper({ path: defaultPath, explicit: false }) : null;
}

function importReadback(sources, python, pythonpath) {
  const probe = [
    'import astrid, astrid_runtime, astrid_runtime_client, runtime_protocol, json',
    'print(json.dumps({"astrid": {"file": astrid.__file__, "version": getattr(astrid, "__version__", None)}, "astrid_runtime": {"file": astrid_runtime.__file__, "version": getattr(astrid_runtime, "__version__", None)}, "astrid_runtime_client": {"file": astrid_runtime_client.__file__, "version": getattr(astrid_runtime_client, "__version__", None)}, "runtime_protocol": {"file": runtime_protocol.__file__, "version": getattr(runtime_protocol, "__version__", None)}}))',
  ].join('; ');
  const env = { ...process.env,
    ASTRID_CHECKOUT: sources.agent.checkout, ASTRID_RUNTIME_CHECKOUT: sources.runtime.checkout,
    PYTHONPATH: pythonpath.join(path.delimiter),
    PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' };
  const value = JSON.parse(execFileSync(python, ['-c', probe], { cwd: sources.runtime.checkout, env, encoding: 'utf8' }).trim());
  const under = (file, checkout) => typeof file === 'string' && file.startsWith(checkout + path.sep);
  if (!under(value.astrid.file, sources.agent.checkout) || !under(value.astrid_runtime_client.file, sources.agent.checkout)
    || !under(value.astrid_runtime.file, sources.runtime.checkout) || !under(value.runtime_protocol.file, sources.runtime.checkout)) {
    throw new Error(`D66 import readback escaped selected sources: ${JSON.stringify(value)}`);
  }
  return value;
}

function repoHeads(sources) {
  return Object.fromEntries(sourceRoles.map((role) => [role, sources[role].head]));
}

function repoTrees(sources) {
  return Object.fromEntries(sourceRoles.map((role) => [role, sources[role].tree]));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function playwrightLaunchEnv({ suite, suiteName, output, junit, stage, baseEnv = process.env }) {
  assert(!suite.verificationOnly || suiteName === 'p2-element-verify', 'D66 verification arm is only supported for p2-element-verify');
  const env = configureRuntimeLogEnv({ suite, output, phaseLaunchOrdinal: stage === suiteName ? 2 : 1, env: {
    ...baseEnv,
    PLAYWRIGHT_OUTPUT_DIR: path.join(output, stage),
    PLAYWRIGHT_JUNIT_OUTPUT_FILE: junit[stage === 'readiness' ? 'readiness' : 'original'],
  } });
  delete env.D66_RUNTIME_LOG_DIR;
  delete env.D66_RUNTIME_PHASE_LAUNCH_ORDINAL;
  if (suite.retainRuntimeLogs && stage === suiteName) {
    env.D66_RUNTIME_LOG_DIR = path.join(output, 'runtime-private');
    env.D66_RUNTIME_PHASE_LAUNCH_ORDINAL = '2';
  }
  delete env[D66_ELEMENT_VERIFICATION_ENV];
  if (suite.verificationOnly && stage === suiteName) env[D66_ELEMENT_VERIFICATION_ENV] = '1';
  if (stage === suiteName) {
    env.D79_HUNG_STACK_EVIDENCE_DIR = path.join(output, 'hung-request-stacks');
    env.D79_HUNG_STACK_RUN_ID = `${suiteName}-${stage}`;
  }
  return env;
}

/** Configure the existing Runtime sink before the direct harness is constructed. */
export function configureRuntimeLogEnv({ suite, output, phaseLaunchOrdinal = 1, env = process.env }) {
  delete env.D66_RUNTIME_LOG_DIR;
  delete env.D66_RUNTIME_PHASE_LAUNCH_ORDINAL;
  if (suite.retainRuntimeLogs) {
    env.D66_RUNTIME_LOG_DIR = path.join(output, 'runtime-private');
    env.D66_RUNTIME_PHASE_LAUNCH_ORDINAL = String(phaseLaunchOrdinal);
  }
  return env;
}

function receiptPath(role, head) {
  return path.join(orch, 'queue', 'done', `checkout-${role}-${head}`);
}

/** Capture the four source identities once, before requesting any checkout. */
export function captureSubmitPins(paths = normalHomes) {
  const pins = {};
  for (const role of sourceRoles) {
    const checkout = realpathSync(paths[role]);
    const state = checkoutState(checkout);
    if (state.dirty) throw new Error(`D66 ${role} submit source is dirty: ${checkout}`);
    pins[role] = { checkout, head: state.head, tree: state.tree };
  }
  return pins;
}

function explicitSubmitTuple(env, homes, appRoot) {
  const tupleKeys = sourceRoles.flatMap((role) => [
    `D66_${role.toUpperCase()}_SHA`, `D66_${role.toUpperCase()}_TREE`, `D66_${role.toUpperCase()}_CHECKOUT`,
  ]);
  if (!tupleKeys.some((key) => env[key]?.trim())) return null;

  const sources = selectPinnedSources(env, homes, appRoot);
  const pins = {};
  const checkouts = {};
  for (const role of sourceRoles) {
    pins[role] = { checkout: sources[role].normal_home, head: sources[role].head, tree: sources[role].tree };
    checkouts[role] = sources[role].checkout;
  }
  return { pins, checkouts };
}

export function buildSubmitPlan({ name, target, paths = normalHomes, pins: fixedPins, checkouts: fixedCheckouts,
  checkoutRoot = '/home/user/work/wt', receiptRoot = path.join(orch, 'queue', 'done') } = {}) {
  assert(suites[name], 'choose p1, p2, p2-element or p3');
  if (target?.startsWith('integration:')) throw new Error('D66 submit requires the stable exact App checkout target');
  const pins = fixedPins ?? captureSubmitPins(paths);
  const checkouts = fixedCheckouts ?? Object.fromEntries(sourceRoles.map((role) => [role, exactCheckoutPath(role, pins[role].head, checkoutRoot)]));
  const checkoutRequests = sourceRoles.map((role) => ({
    role, head: pins[role].head, checkout: checkouts[role],
    command: [path.join(orch, 'bin', 'request-checkout'), role, pins[role].head, `D66 exact ${role} source`],
    receipt: path.join(receiptRoot, `checkout-${role}-${pins[role].head}`),
  }));
  return { name, target, pins, checkouts, checkoutRequests };
}

export function serviceRecipe({ name, pins, checkouts, preflight = false, diagnosticHelper = null }) {
  assert(suites[name], 'choose p1, p2, p2-element or p3');
  for (const role of sourceRoles) {
    validateObjectId(pins[role]?.head, `${role} SHA`);
    validateObjectId(pins[role]?.tree, `${role} tree`);
    assert(path.isAbsolute(checkouts[role]), `D66 ${role} checkout must be absolute`);
  }
  const env = sourceRoles.flatMap((role) => [
    `D66_${role.toUpperCase()}_SHA=${shellQuote(pins[role].head)}`,
    `D66_${role.toUpperCase()}_TREE=${shellQuote(pins[role].tree)}`,
    `D66_${role.toUpperCase()}_CHECKOUT=${shellQuote(checkouts[role])}`,
  ]);
  if (diagnosticHelper) {
    const reviewedHelper = validateDiagnosticHelper({ path: diagnosticHelper.path, sha256: diagnosticHelper.sha256, explicit: true });
    env.push(`${D66_PHASE_CAPTURE_HELPER_ENV}=${shellQuote(reviewedHelper.path)}`);
    env.push(`${D66_PHASE_CAPTURE_HELPER_SHA256_ENV}=${shellQuote(reviewedHelper.sha256)}`);
  }
  if (suites[name].verificationOnly) env.push(`${D66_ELEMENT_VERIFICATION_ENV}='1'`);
  const watchdogSeconds = name === 'p2-element' ? '2' : name === 'p2' ? '20' : '';
  env.push(`ASTRID_P2_COMMIT_PHASE_CAPTURE_WATCHDOG_SECONDS=${shellQuote(watchdogSeconds)}`);
  return `${env.join(' ')} ${shellQuote(node)} --max-old-space-size=6144 --import tsx scripts/testing/d66-plain-stack.mjs ${shellQuote(name)}${preflight ? ' --preflight' : ''}`;
}

function bytesEqual(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

function appendRegistryRows(before, rows) {
  const insertion = `${before.length > 0 && before.at(-1) !== 10 ? '\n' : ''}${rows.join('\n')}\n`;
  return Buffer.concat([Buffer.from(before), Buffer.from(insertion)]);
}

/** Add only the requested rows, retaining every existing registry byte verbatim. */
export function registerSubmitRecipes({ registryPath, rows, readRegistry = () => readFileSync(registryPath),
  writeRegistry = atomicReplace, beforeCommit = () => {} }) {
  assert(path.isAbsolute(registryPath), 'D73 suite registry must be an absolute path');
  assert(Array.isArray(rows) && rows.length === 2, 'D73 requires preflight and normal suite rows');
  const names = rows.map((row) => row.trim().split(/\s+/, 3)[1]);
  assert(names.every(Boolean) && new Set(names).size === names.length, 'D73 suite rows must have unique names');
  const before = Buffer.from(readRegistry());
  const existing = new Set(before.toString('utf8').split('\n')
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
    .map((line) => line.trim().split(/\s+/, 3)[1]).filter(Boolean));
  for (const name of names) {
    if (existing.has(name)) throw new Error(`D73 suite registry already contains ${name}; resume the existing submit plan`);
  }
  const after = appendRegistryRows(before, rows);
  beforeCommit();
  if (!bytesEqual(before, readRegistry())) throw new Error('D73 suite registry changed concurrently; refusing to queue');
  writeRegistry(registryPath, after);
  return { names, before, after };
}

function atomicReplace(file, bytes) {
  const temporary = `${file}.d73-${process.pid}-${Date.now()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function receiptCheckout(receipt, role, head) {
  const text = readFileSync(receipt, 'utf8').trim();
  const match = text.match(/(?:created|exists):?\s+(\S+)(?:\s+\(detached at |\s+at\s+)([0-9a-f]{40})/);
  if (!match || match[2] !== head) throw new Error(`D66 ${role} checkout receipt is missing or tampered: ${receipt}`);
  return match[1];
}

/** request-checkout registers its stable detached checkout as a service target. */
export function appCheckoutTarget(checkout, head, { target = path.basename(checkout), workerRoot = path.join(orch, 'workers') } = {}) {
  const expected = `${checkoutPrefixes.app}-${head.slice(0, 8)}`;
  if (target !== expected || path.basename(checkout) !== expected) throw new Error(`D66 service target must be the stable exact App checkout ${expected}`);
  const metadata = Object.fromEntries(readFileSync(path.join(workerRoot, target, 'meta'), 'utf8').trim().split('\n')
    .map((line) => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
  if (metadata.name !== target || metadata.repo !== 'app' || realpathSync(metadata.worktree) !== checkout) {
    throw new Error(`D66 App checkout target metadata does not match ${checkout}`);
  }
  return target;
}

export function preflightSources(env = process.env, homes = normalHomes, appRoot = root, {
  receiptRoot = path.join(orch, 'queue', 'done'), workerRoot = path.join(orch, 'workers'),
} = {}) {
  const sources = selectPinnedSources(env, homes, appRoot);
  for (const role of sourceRoles) {
    const source = sources[role];
    const receipt = path.join(receiptRoot, `checkout-${role}-${source.head}`);
    assert.equal(realpathSync(receiptCheckout(receipt, role, source.head)), source.checkout, `D66 ${role} receipt selected the wrong checkout`);
  }
  const target = appCheckoutTarget(sources.app.checkout, sources.app.head, { workerRoot });
  return { sources, target, service_source: checkoutState(appRoot) };
}

export async function waitForSubmitReceipts(plan, { waitMs = 300_000, pollMs = 250 } = {}) {
  const deadline = Date.now() + waitMs;
  const resolved = {};
  for (const request of plan.checkoutRequests) {
    while (!existsSync(request.receipt) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (!existsSync(request.receipt)) throw new Error(`D66 ${request.role} checkout receipt did not arrive: ${request.receipt}`);
    const receiptCheckoutPath = realpathSync(receiptCheckout(request.receipt, request.role, request.head));
    assert.equal(receiptCheckoutPath, request.checkout, `D66 ${request.role} receipt selected the wrong checkout`);
    const state = checkoutState(receiptCheckoutPath);
    validatePinnedSource({ role: request.role, selected: receiptCheckoutPath, normal: plan.pins[request.role].checkout,
      expectedHead: plan.pins[request.role].head, expectedTree: plan.pins[request.role].tree, selectedState: state });
    resolved[request.role] = receiptCheckoutPath;
  }
  return resolved;
}

function submitOutput(name, env) {
  return env.D66_OUTPUT_DIR ?? path.join(env.TMPDIR ?? '/tmp', `d66-${name}`);
}

function submitPlanPath(name, env) {
  return env.D66_SUBMIT_PLAN_PATH ?? path.join(submitOutput(name, env), `${name}-submit-plan.json`);
}

function readSubmitArtifact(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
    throw new Error(`D73 submit plan is unreadable at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveSubmitArtifact(file, artifact) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
}

const submitLocks = new Map();

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function acquireSubmitFileLock(artifactPath) {
  const lockPath = `${artifactPath}.lock`;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid })}\n`);
      closeSync(descriptor);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { unlinkSync(lockPath); } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { owner = null; }
      if (Number.isInteger(owner?.pid) && !processIsAlive(owner.pid)) {
        try { unlinkSync(lockPath); } catch (staleError) {
          if (staleError?.code !== 'ENOENT') throw staleError;
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function withSubmitLock(artifactPath, work) {
  const key = path.resolve(artifactPath);
  const previous = submitLocks.get(key) ?? Promise.resolve();
  const current = previous.then(work, work);
  submitLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (submitLocks.get(key) === current) submitLocks.delete(key);
  }
}

function commandResult(file, args) {
  const result = spawn(file, args, { encoding: 'utf8' });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    result.stdout?.on('data', (chunk) => { stdout += chunk; });
    result.stderr?.on('data', (chunk) => { stderr += chunk; });
    result.once('error', reject);
    result.once('close', (status, signal) => resolve({ status: status ?? (signal ? 128 : 1), stdout, stderr }));
  });
}

function resultId(result) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const testLine = text.match(/(?:^|\n)TEST\s+([A-Za-z0-9_.-]+)/);
  if (testLine) return { id: testLine[1], resultDir: path.join(orch, 'tests', testLine[1]) };
  const directory = text.match(/(?:^|\/)tests\/([A-Za-z0-9_.-]+)\/?(?:\n|$)/);
  if (directory) return { id: directory[1], resultDir: path.join(orch, 'tests', directory[1]) };
  throw new Error(`D73 request-test did not return a result ID: ${text.trim()}`);
}

function terminalStatus(resultDir, readStatus = (file) => readFileSync(path.join(file, 'status'), 'utf8').trim()) {
  let status;
  try { status = readStatus(resultDir); } catch { throw new Error(`D73 preflight result status is UNKNOWN: ${resultDir}`); }
  if (!['pass', 'fail', 'timeout', 'error', 'cancelled'].includes(status)) {
    throw new Error(`D73 preflight result status is UNKNOWN: ${status || '(empty)'}`);
  }
  return status;
}

async function waitForPreflight({ id, resultDir }, { runWait, readStatus, waitArgs = [] } = {}) {
  const wait = runWait ?? ((args) => commandResult(path.join(orch, 'bin', 'wait-test'), args));
  for (;;) {
    const result = await wait([id, ...waitArgs]);
    if (result.status === 124) {
      let observed;
      try { observed = (readStatus ?? ((file) => readFileSync(path.join(file, 'status'), 'utf8').trim()))(resultDir); } catch {
        throw new Error(`D73 preflight result status is UNKNOWN: ${resultDir}`);
      }
      if (['fail', 'timeout', 'error', 'cancelled'].includes(observed)) {
        throw new Error(`D73 preflight refused: wait-test exit=124 status=${observed}`);
      }
      continue;
    }
    const status = terminalStatus(resultDir, readStatus);
    if (result.status !== 0 || status !== 'pass') {
      throw new Error(`D73 preflight refused: wait-test exit=${result.status} status=${status}`);
    }
    return { id, resultDir, status };
  }
}

function pinnedEnvironment(plan) {
  return Object.fromEntries(sourceRoles.flatMap((role) => [
    [`D66_${role.toUpperCase()}_SHA`, plan.pins[role].head],
    [`D66_${role.toUpperCase()}_TREE`, plan.pins[role].tree],
    [`D66_${role.toUpperCase()}_CHECKOUT`, plan.checkouts[role]],
  ]));
}

function submitSuiteNames(name, pins, env) {
  const normal = env.D66_SUBMIT_SUITE?.trim() || `d73-${name}-${pins.app.head.slice(0, 8)}-submit`;
  return { normal, preflight: `${normal}-preflight` };
}

function submitPlainPlan(artifact) {
  return [
    `D73 submit PASS preflight_id=${artifact.preflight.id} normal_id=${artifact.normal.id}`,
    `D73 plan: ${path.join(orch, 'bin', 'request-test')} ${artifact.target} ${artifact.suites.preflight} --no-cache`,
    `D73 plan: ${path.join(orch, 'bin', 'wait-test')} ${artifact.preflight.id}`,
    `D73 plan: ${path.join(orch, 'bin', 'request-test')} ${artifact.target} ${artifact.suites.normal} --no-cache`,
  ].join('\n');
}

async function submitUnlocked(name, { env = process.env, homes = normalHomes, appRoot = root,
  registryPath = env.D66_SUITE_REGISTRY ?? path.join(orch, 'tests', 'suites.conf'), receiptRoot = path.join(orch, 'queue', 'done'),
  workerRoot = path.join(orch, 'workers'), checkoutRoot = env.D66_CHECKOUT_ROOT ?? '/home/user/work/wt', runCommand = commandResult, runWait, readStatus,
  beforeRegistryCommit = () => {} } = {}) {
  const artifactPath = submitPlanPath(name, env);
  const prior = readSubmitArtifact(artifactPath);
  if (prior) {
    assert.equal(prior.suite, name, `D73 submit plan suite mismatch: ${artifactPath}`);
    if (prior.normal) { console.log(submitPlainPlan(prior)); return prior; }
    if (!prior.preflight) {
      const queued = await runCommand(path.join(orch, 'bin', 'request-test'), [prior.target, prior.suites.preflight, '--no-cache']);
      if (queued.status !== 0) throw new Error(`D73 preflight request refused: exit=${queued.status}`);
      prior.preflight = resultId(queued);
      saveSubmitArtifact(artifactPath, prior);
    }
    const waited = await waitForPreflight(prior.preflight, { runWait, readStatus });
    prior.preflight = waited;
    const normalResult = await runCommand(path.join(orch, 'bin', 'request-test'), [prior.target, prior.suites.normal, '--no-cache']);
    if (normalResult.status !== 0) throw new Error(`D73 normal request refused: exit=${normalResult.status}`);
    prior.normal = resultId(normalResult);
    saveSubmitArtifact(artifactPath, prior);
    console.log(submitPlainPlan(prior));
    return prior;
  }

  const target = env.D66_SUBMIT_TARGET?.trim();
  // Validate an explicit reviewed helper before requesting any source checkout or registering a recipe.
  const requestedDiagnosticHelper = diagnosticHelperOverride(env);
  if (requestedDiagnosticHelper) validateDiagnosticHelper({ ...requestedDiagnosticHelper, explicit: true });
  const explicit = explicitSubmitTuple(env, homes, appRoot);
  const plan = buildSubmitPlan({ name, target, paths: homes, checkoutRoot, receiptRoot,
    pins: explicit?.pins, checkouts: explicit?.checkouts });
  for (const request of plan.checkoutRequests) {
    const result = await runCommand(request.command[0], request.command.slice(1));
    if (result.status !== 0) throw new Error(`D73 ${request.role} request-checkout refused: exit=${result.status}`);
  }
  const checkouts = await waitForSubmitReceipts(plan, { waitMs: Number(env.D66_CHECKOUT_WAIT_MS ?? 300_000) });
  plan.checkouts = checkouts;
  const exactEnv = { ...env, ...pinnedEnvironment(plan) };
  const preflight = preflightSources(exactEnv, homes, appRoot, { receiptRoot, workerRoot });
  const serviceTarget = appCheckoutTarget(checkouts.app, plan.pins.app.head, { target: target || preflight.target, workerRoot });
  const suitesForSubmit = submitSuiteNames(name, plan.pins, env);
  const diagnosticHelper = diagnosticHelperIdentity({ runtimeCheckout: checkouts.runtime, env });
  const recipes = {
    preflight: serviceRecipe({ name, pins: plan.pins, checkouts, diagnosticHelper, preflight: true }),
    normal: serviceRecipe({ name, pins: plan.pins, checkouts, diagnosticHelper }),
  };
  const rows = [`app ${suitesForSubmit.preflight} ${recipes.preflight}`, `app ${suitesForSubmit.normal} ${recipes.normal}`];
  registerSubmitRecipes({ registryPath, rows, beforeCommit: beforeRegistryCommit });
  const artifact = { version: 1, suite: name, pins: plan.pins, checkouts, target: serviceTarget,
    suites: suitesForSubmit, recipes, preflight: null, normal: null };
  saveSubmitArtifact(artifactPath, artifact);

  const preflightResult = await runCommand(path.join(orch, 'bin', 'request-test'), [serviceTarget, suitesForSubmit.preflight, '--no-cache']);
  if (preflightResult.status !== 0) throw new Error(`D73 preflight request refused: exit=${preflightResult.status}`);
  artifact.preflight = resultId(preflightResult);
  saveSubmitArtifact(artifactPath, artifact);
  await waitForPreflight(artifact.preflight, { runWait, readStatus });
  const normalResult = await runCommand(path.join(orch, 'bin', 'request-test'), [serviceTarget, suitesForSubmit.normal, '--no-cache']);
  if (normalResult.status !== 0) throw new Error(`D73 normal request refused: exit=${normalResult.status}`);
  artifact.normal = resultId(normalResult);
  saveSubmitArtifact(artifactPath, artifact);
  console.log(submitPlainPlan(artifact));
  return artifact;
}

export async function submit(name, options = {}) {
  const env = options.env ?? process.env;
  const artifactPath = submitPlanPath(name, env);
  return withSubmitLock(artifactPath, async () => {
    const release = await acquireSubmitFileLock(path.resolve(artifactPath));
    try { return await submitUnlocked(name, options); } finally { release(); }
  });
}

export async function main(sourceOptions = {}) {
  const [name, mode = 'run'] = process.argv.slice(2);
  assert(suites[name], 'choose p1, p2, p2-element or p3');
  assert(['run', '--collect', '--launch', '--submit', '--preflight'].includes(mode), 'unknown mode');
  const verificationOnly = suites[name].verificationOnly === true;
  assert((process.env[D66_ELEMENT_VERIFICATION_ENV] === '1') === verificationOnly,
    'D66 element verification requires the explicit p2-element-verify route');
  if (mode === '--submit') return submit(name);
  const suite = suites[name];
  // Collection is a source-independent descriptor check; both service modes verify the same captured inputs.
  const preflight = mode === '--collect' ? null : preflightSources(process.env, normalHomes, root, sourceOptions);
  const sources = preflight?.sources;
  if (sources) assertSourcesUnchanged(sources);
  const diagnosticHelper = sources ? diagnosticHelperIdentity({ runtimeCheckout: sources.runtime.checkout, required: suite.retainRuntimeLogs }) : null;
  const snapshot = path.basename(root);
  const output = process.env.D66_OUTPUT_DIR ?? (snapshot.startsWith('.test-')
    ? path.join(orch, 'tests', snapshot.slice(6), 'd66')
    : path.join(process.env.TMPDIR ?? '/tmp', `d66-${name}`));
  mkdirSync(output, { recursive: true });
  configureRuntimeLogEnv({ suite, output });
  if (mode === '--preflight') {
    const manifest = { suite: name, mode, repo_heads: repoHeads(sources), repo_trees: repoTrees(sources),
      source_checkouts: sources, service_source: preflight.service_source, service_target: preflight.target,
      diagnostic_helper: diagnosticHelper };
    writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`D66 source preflight PASS: ${path.join(output, 'manifest.json')}`);
    return;
  }
  const agentPython = requireExecutable(process.env.ASTRID_PYTHON ?? '/home/user/work/venv-agent/bin/python', 'Agent Python');
  const runtimePython = requireExecutable(process.env.ASTRID_RUNTIME_PYTHON ?? '/home/user/work/venv-runtime/bin/python', 'Runtime Python');
  const importVersions = sources ? {
    runtime: importReadback(sources, runtimePython, [sources.runtime.checkout, sources.agent.checkout]),
    agent: importReadback(sources, agentPython, [sources.agent.checkout, sources.runtime.checkout]),
  } : undefined;

  for (const key of ['NODE_PATH', 'ASTRID_QUICK_DESCRIPTOR', 'ASTRID_APP_DIRECT_DIST', 'APP_DIRECT_DIST',
    'ASTRID_LOCAL_DATA_ROOT', 'ASTRID_RUNTIME_DATA_ROOT', 'ASTRID_LOCAL_SOURCE_MANIFEST', 'ASTRID_RUNTIME_SOURCE_MANIFEST',
    'BANODOCO_LOCAL_DATA_ROOT', 'BANODOCO_RUNTIME_DATA_ROOT', 'BANODOCO_LOCAL_SOURCE_MANIFEST', 'BANODOCO_RUNTIME_SOURCE_MANIFEST']) delete process.env[key];
  if (sources) Object.assign(process.env, {
    PATH: `${nodeDir}:${root}/node_modules/.bin:${process.env.PATH}`,
    ASTRID_CHECKOUT: sources.agent.checkout, ASTRID_PYTHON: agentPython,
    ASTRID_RUNTIME_CHECKOUT: sources.runtime.checkout, ASTRID_RUNTIME_PYTHON: runtimePython,
    ASTRID_REMOTION_PROJECT_DIR: '/home/user/work/runtimes/agent-remotion-app-p1-787-2a9-1830',
    ASTRID_NODE_EXECUTABLE: node,
    ASTRID_TIMELINE_SCHEMA_PYTHONPATH: process.env.ASTRID_TIMELINE_SCHEMA_PYTHONPATH ?? '/home/user/work/venv-agent/lib/python3.13/site-packages',
    PYTHONDONTWRITEBYTECODE: '1', NODE_OPTIONS: '--max-old-space-size=6144',
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/home/user/work/pw-browsers',
    TIMELINE_BUNDLE_AGENT_HEAD: sources.agent.head, TIMELINE_BUNDLE_RUNTIME_HEAD: sources.runtime.head,
  });
  if (diagnosticHelper) {
    process.env[D66_PHASE_CAPTURE_HELPER_ENV] = diagnosticHelper.path;
    process.env[D66_PHASE_CAPTURE_HELPER_SHA256_ENV] = diagnosticHelper.sha256;
  }
  const hashes = () => Object.fromEntries([...suite.files, readiness].map((file) =>
    [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]));
  const manifest = {
    suite: name, started_at: new Date().toISOString(),
    repo_heads: sources ? repoHeads(sources) : { app: git(root, ['rev-parse', 'HEAD']), composition: git('/home/user/work/composition', ['rev-parse', 'HEAD']) },
    repo_trees: sources ? repoTrees(sources) : { app: git(root, ['rev-parse', 'HEAD^{tree}']), composition: git('/home/user/work/composition', ['rev-parse', 'HEAD^{tree}']) },
    ...(sources ? { source_checkouts: sources, service_source: preflight.service_source, service_target: preflight.target } : {}),
    diagnostic_helper: diagnosticHelper,
    test_sha256_before: hashes(), service_versions: importVersions ? { imports: importVersions } : {},
    junit: { readiness: path.join(output, 'readiness.xml'), original: path.join(output, `${name}.xml`) },
  };
  const save = () => writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  let stage = 'collection';
  save();

  function playwright(files, { grep, list = false, stage = name } = {}) {
    const args = [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'playwright.three-products.config.ts', ...files];
    if (grep) args.push('--grep', grep);
    args.push('--reporter', list ? 'list' : 'list,./config/testing/playwrightSkipGuard.ts,junit');
    if (list) args.push('--list');
    const env = playwrightLaunchEnv({ suite, suiteName: name, output, junit: manifest.junit, stage });
    return { args, env };
  }

  async function run(command, args, env = process.env) {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    });
  }

  async function launch() {
    stage = 'hosted-build';
    process.env.ASTRID_APP_DIRECT_DOOR_PORT = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(String(port))); });
    });
    const { resolveHostedRuntimeOrigin } = await import('../hosted-build-origin.mjs');
    Object.assign(process.env, {
      VITE_RUNTIME_ORIGIN: resolveHostedRuntimeOrigin(),
      VITE_WORKSPACE_RUNTIME_EXPECTED_ACTOR_ID: '', VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID: '', VITE_WORKSPACE_RUNTIME_EXPECTED_INSTANCE_ID: '',
      ASTRID_APP_DIRECT_DIST: path.join(output, 'dist'),
    });
    const { build } = await import('vite');
    await build({ configFile: path.join(root, 'config/vite/vite.config.ts'), cacheDir: path.join(output, 'vite-cache'), build: { outDir: process.env.ASTRID_APP_DIRECT_DIST, emptyOutDir: false } });
    const { startDirectHarness } = await import('../../tests/e2e/local/support/harness.ts');
    const { AstridCli } = await import('../../tests/e2e/local/support/astrid.ts');
    const { expect } = await import('@playwright/test');
    assertSourcesUnchanged(sources);
    manifest.repo_heads = repoHeads(sources);
    manifest.repo_trees = repoTrees(sources);
    manifest.service_versions.imports = {
      runtime: importReadback(sources, runtimePython, [sources.runtime.checkout, sources.agent.checkout]),
      agent: importReadback(sources, agentPython, [sources.agent.checkout, sources.runtime.checkout]),
    };
    process.env.TIMELINE_BUNDLE_AGENT_HEAD = manifest.repo_heads.agent;
    process.env.TIMELINE_BUNDLE_RUNTIME_HEAD = manifest.repo_heads.runtime;
    stage = 'normal-service-start';
    save();
    const harness = await startDirectHarness({ deferTimelineInitialization: true });
    try {
      const healthResponse = await fetch(`${harness.runtimeUrl}/v1/health`);
      assert.equal(healthResponse.status, 200);
      const health = await healthResponse.json();
      manifest.service_versions = { ...manifest.service_versions, node: process.version,
        npm: execFileSync(path.join(nodeDir, 'npm'), ['--version'], { encoding: 'utf8' }).trim(),
        runtime_server: healthResponse.headers.get('server'), protocol: health.protocol, schema_digest: health.schema_digest };
      stage = 'native-seed';
      save();
      const seed = await harness.seedThreeProducts();
      stage = 'agent-preflight';
      const astrid = await AstridCli.create(harness);
      const identity = await astrid.preflight();
      assert.equal(identity.astrid_head, sources.agent.head, 'Agent identity must be the selected current checkout');
      const packets = readdirSync(harness.tmp).filter((file) => file.startsWith('seed-') && file.endsWith('-accepted.json'))
        .map((file) => JSON.parse(readFileSync(path.join(harness.tmp, file), 'utf8')));
      const result = packets.find((packet) => packet.data?.accepted_revision_id === seed.headRevisionId);
      expect(result).toBeTruthy();
      const { data, receipt, request } = result;
      const history = await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50`);
      expect(history.status).toBe(200);
      expect(history.body.head).toEqual({ revision_id: data.accepted_revision_id, publication_id: receipt.receipt_id });
      const entry = history.body.items.find((item) => item.publication_id === receipt.receipt_id);
      expect(entry).toMatchObject({ publication_id: receipt.receipt_id, revision_id: data.accepted_revision_id,
        previous: { revision_id: data.previous_revision_id, publication_id: data.previous_publication_id }, receipt,
        intent: 'recorded', provider_version: data.provider_version, compiler_version: data.compiler_version,
        merge: request.merge, merge_mode: data.merge_mode, steps: data.steps, publisher: data.publisher, label: data.label,
        records: { schema_version: 1, label: data.label, merge_mode: data.merge_mode, steps: data.steps,
          commands: expect.any(Array), undo_of: [], restored_from: null } });
      expect(data.commands).toEqual(entry.records.commands.map((record) => record.command));
      expect(entry.reads).toEqual(request.reads);
      expect(entry.steps).toEqual(data.steps);
      expect(entry.records.steps).toEqual(data.steps);
      expect(entry.records.commands).toHaveLength(request.commands.length);
      expect(data.steps).toHaveLength(request.steps.length);
      Object.assign(manifest.service_versions, {
        agent_head: identity.astrid_head, agent_schema_digest: identity.schema_digest,
        provider: data.provider_version, compiler: data.compiler_version });
      assertSourcesUnchanged(sources);
      save();
      console.log('D66 normal launch, native seed, Agent identity and authoritative history PASS');
    } finally {
      await harness.stop();
    }
  }

  try {
    const collection = playwright(suite.files, { grep: suite.grep, list: true });
    const listed = execFileSync(node, collection.args, { cwd: root, env: collection.env, encoding: 'utf8' });
    writeFileSync(path.join(output, 'collection.txt'), listed);
    assert.match(listed, new RegExp(`Total: ${suite.count} tests? in `));
    console.log(listed.trim());
    if (mode !== '--collect') await launch();
    if (mode === 'run') {
      stage = 'mounted-readiness';
      const ready = playwright([readiness], { stage: 'readiness' });
      manifest.readiness_exit = await run(node, ready.args, ready.env);
      if (manifest.readiness_exit === 0) {
        stage = name;
        const original = playwright(suite.files, { grep: suite.grep });
        manifest.original_exit = await run(node, original.args, original.env);
      }
      process.exitCode = manifest.readiness_exit || manifest.original_exit || 0;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const mismatch = message.match(/runtime health schema digest sha256:[a-f0-9]+ does not match this Astrid client's expected sha256:[a-f0-9]+|contract mismatch: the App vendors schema sha256:[a-f0-9]+ but Astrid vendors sha256:[a-f0-9]+/);
    manifest.failure = { stage, error: error?.name ?? 'Error', message: mismatch?.[0] ?? message };
    console.error(`D66 ${stage}: ${manifest.failure.message}`);
    process.exitCode = 1;
  } finally {
    manifest.test_sha256_after = hashes();
    assert.deepEqual(manifest.test_sha256_after, manifest.test_sha256_before);
    manifest.finished_at = new Date().toISOString();
    save();
    console.log(`D66 manifest: ${path.join(output, 'manifest.json')}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`D66 source selection: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

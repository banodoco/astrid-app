import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { appCheckoutTarget, buildSubmitPlan, captureSubmitPins, configureRuntimeLogEnv, D66_ELEMENT_VERIFICATION_ENV, D66_PHASE_CAPTURE_HELPER_ENV, D66_PHASE_CAPTURE_HELPER_SHA256_ENV, diagnosticHelperIdentity, exactCheckoutPath, playwrightLaunchEnv, preflightSources, receiptCheckout, registerSubmitRecipes, selectPinnedSources, serviceRecipe, suites, submit, validatePinnedSource, validatePinnedSources, validateSelectedSource, waitForSubmitReceipts } from './d66-plain-stack.mjs';

const require = createRequire(import.meta.url);
const state = (overrides = {}) => ({
  root: '/snapshot/agent', head: 'a'.repeat(40), tree: 'b'.repeat(40), branch: null, dirty: false, ...overrides,
});

test('D66 full P2 launch retains bounded Runtime phase logs while other suites stay opt-in', () => {
  const junit = { readiness: '/tmp/readiness.xml', original: '/tmp/original.xml' };
  const launch = (suiteName, stage = suiteName, output = `/tmp/d66-${suiteName}-launch`) => playwrightLaunchEnv({
    suite: suites[suiteName], suiteName, output, junit, stage,
    baseEnv: { NODE_ENV: 'test', D66_RUNTIME_LOG_DIR: '/tmp/inherited-observer-must-not-leak' },
  });

  assert.equal(launch('p2').D66_RUNTIME_LOG_DIR, path.join('/tmp/d66-p2-launch', 'runtime-private'));
  assert.equal(launch('p2').D66_RUNTIME_PHASE_LAUNCH_ORDINAL, '2');
  assert.equal(launch('p2', 'readiness').D66_RUNTIME_LOG_DIR, undefined);
  assert.equal(launch('p2', 'readiness').D66_RUNTIME_PHASE_LAUNCH_ORDINAL, undefined);
  assert.equal(launch('p2-element').D66_RUNTIME_LOG_DIR, path.join('/tmp/d66-p2-element-launch', 'runtime-private'));
  assert.equal(launch('p2-element').D66_RUNTIME_PHASE_LAUNCH_ORDINAL, '2');
  assert.equal(launch('p2-element').D66_ELEMENT_VERIFICATION_ONLY, undefined);
  assert.equal(launch('p2-element-verify').D66_RUNTIME_LOG_DIR, path.join('/tmp/d66-p2-element-verify-launch', 'runtime-private'));
  assert.equal(launch('p2-element-verify').D66_RUNTIME_PHASE_LAUNCH_ORDINAL, '2');
  assert.equal(launch('p2-element-verify').D66_ELEMENT_VERIFICATION_ONLY, '1');
  assert.equal(launch('p2-element-verify', 'readiness').D66_ELEMENT_VERIFICATION_ONLY, undefined);
  assert.throws(() => playwrightLaunchEnv({ suite: suites['p2-element-verify'], suiteName: 'p2-element', output: '/tmp/invalid-verification-route', junit, stage: 'p2-element' }), /only supported for p2-element-verify/);
  assert.equal(launch('p1').D66_RUNTIME_LOG_DIR, undefined);
  assert.equal(launch('p3').D66_RUNTIME_LOG_DIR, undefined);
  assert.notEqual(launch('p2').D66_RUNTIME_LOG_DIR, launch('p2-element').D66_RUNTIME_LOG_DIR);
});

test('D102 configures the existing Runtime sink before native seed and preserves stage isolation', () => {
  const output = '/tmp/d66-native-seed-launch';
  const inherited = { NODE_ENV: 'test', D66_RUNTIME_LOG_DIR: '/tmp/inherited-observer-must-not-leak' };
  const nativeSeedEnv = configureRuntimeLogEnv({ suite: suites.p2, output, env: { ...inherited } });

  assert.equal(nativeSeedEnv.D66_RUNTIME_LOG_DIR, path.join(output, 'runtime-private'));
  assert.equal(nativeSeedEnv.D66_RUNTIME_PHASE_LAUNCH_ORDINAL, '1');
  assert.equal(playwrightLaunchEnv({ suite: suites.p2, suiteName: 'p2', output,
    junit: { readiness: '/tmp/readiness.xml', original: '/tmp/original.xml' }, stage: 'p2', baseEnv: inherited }).D66_RUNTIME_LOG_DIR,
  nativeSeedEnv.D66_RUNTIME_LOG_DIR);
  assert.equal(playwrightLaunchEnv({ suite: suites.p2, suiteName: 'p2', output,
    junit: { readiness: '/tmp/readiness.xml', original: '/tmp/original.xml' }, stage: 'p2', baseEnv: inherited }).D66_RUNTIME_PHASE_LAUNCH_ORDINAL,
  '2');
  assert.equal(playwrightLaunchEnv({ suite: suites.p2, suiteName: 'p2', output,
    junit: { readiness: '/tmp/readiness.xml', original: '/tmp/original.xml' }, stage: 'readiness', baseEnv: inherited }).D66_RUNTIME_LOG_DIR,
  undefined);

  const disabledEnv = configureRuntimeLogEnv({ suite: suites.p1, output, env: { ...inherited } });
  assert.equal(disabledEnv.D66_RUNTIME_LOG_DIR, undefined);
  assert.equal(disabledEnv.D66_RUNTIME_PHASE_LAUNCH_ORDINAL, undefined);
});

async function loadD102Module(source, sourceUrl, { modules, controlProcess, fetch }) {
  // Transpile whole production modules; substitute imports, never start/spawn/buffer/stop bodies.
  const { outputText } = ts.transpileModule(source.replaceAll('import.meta.url', JSON.stringify(sourceUrl)), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowJs: true },
  });
  const controlRequire = (specifier) => {
    if (Object.hasOwn(modules, specifier)) return modules[specifier];
    if (specifier.startsWith('node:')) return require(specifier);
    throw new Error(`unexpected D102 import: ${specifier}`);
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const module = { exports: {} };
  return new AsyncFunction('require', 'module', 'exports', 'process', 'fetch', `${outputText}\nreturn module.exports;`)(
    controlRequire, module, module.exports, controlProcess, fetch);
}

async function runD102LauncherControl(f, { source, failure, suiteName = 'p2', inheritedEnv = {}, harnessSource = null }) {
  const sourceFile = path.join(f.snapshot, 'scripts/testing/d66-plain-stack.mjs');
  const output = mkdtempSync(path.join(f.base, `d102-${failure}-`));
  const runtimeLogDir = path.join(output, 'runtime-private');
  const stderr = 'runtime stderr: not_ready runtime_unavailable request_id=offline-control\n';
  const shutdown = 'runtime stderr: offline-control stopped\n';
  const children = [];
  let tempRoot;
  let seedEnv;
  let hostedClosed = false;
  const controlProcess = {
    ...process,
    env: { PATH: process.env.PATH, ...f.env, ...inheritedEnv, D66_OUTPUT_DIR: output, D66_NORMAL_AGENT_HOME: f.homes.agent,
      D66_NORMAL_RUNTIME_HOME: f.homes.runtime, D66_NORMAL_COMPOSITION_HOME: f.homes.composition,
      ASTRID_PYTHON: process.execPath, ASTRID_RUNTIME_PYTHON: process.execPath, TMPDIR: os.tmpdir() },
    argv: [process.execPath, path.join(f.snapshot, 'not-the-launcher.mjs')],
    exitCode: undefined,
    cwd: () => f.snapshot,
    on() { return this; },
  };
  const net = () => ({
    once() { return this; },
    listen(_port, _host, callback) { callback(); return this; },
    address() { return { port: 45454 }; },
    close(callback) { callback?.(); },
  });
  const objects = new Map();
  const response = (status, body) => ({ status, ok: status < 400, headers: { get: () => 'offline-control' },
    json: async () => body, arrayBuffer: async () => Buffer.from('offline media') });
  const fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/v1/health') return response(200, { runtime_instance_id: 'offline-instance' });
    if (pathname === '/v1/credentials') return response(201, {});
    if (pathname === '/v1/projects') return response(201, { data: { project_id: 'offline-project' } });
    if (pathname === '/v1/projects/offline-project') return response(200, { slug: 'offline-project' });
    if (pathname === '/v1/projects/offline-project/timelines') return response(201, {});
    if (/^\/v1\/projects\/offline-project\/timelines\/[^/]+$/.test(pathname)) {
      return response(200, { head_revision_id: 'offline-revision', head_publication_id: 'offline-publication' });
    }
    if (pathname === '/v1/projects/offline-project/objects') {
      const objectId = init.headers['X-Original-Name'];
      objects.set(objectId, { object_id: objectId, digest: `sha256:${createHash('sha256').update(init.body).digest('hex')}` });
      return response(201, { data: objects.get(objectId) });
    }
    if (pathname.startsWith('/v1/objects/')) return response(200, {});
    if (pathname === '/v1/projects/offline-project/media-imports') {
      return response(201, { variant_id: init.headers['X-Original-Name'], generation_id: 'offline-generation' });
    }
    if (pathname.startsWith('/v1/projects/offline-project/media-selection')) {
      return response(200, { object_id: searchParams.get('asset') === 'f2-image.png' ? 'gradient.png' : 'clip.webm',
        asset: searchParams.get('asset'), generation_id: 'offline-generation', variant_id: searchParams.get('asset') });
    }
    throw new Error(`unexpected D102 fetch: ${pathname}`);
  };
  const childProcess = {
    execFileSync(command, args, options) {
      if (command === 'git') return execFileSync(command, args, options);
      if (args.includes('--list')) return `offline collection control\nTotal: ${suites[suiteName].count} tests in ${suites[suiteName].files.length} files\n`;
      if (path.basename(command) === 'npm') { assert.deepEqual(args, ['--version']); return 'offline-npm\n'; }
      if (command === 'openssl') {
        for (const flag of ['-keyout', '-out']) writeFileSync(args[args.indexOf(flag) + 1], 'offline TLS');
        return '';
      }
      if (command === 'ffmpeg') { writeFileSync(args.at(-1), 'offline video'); return ''; }
      assert.equal(command, process.execPath, 'only fixture Python invocations may be substituted');
      if (args[1] === 'runtime_protocol.cli') {
        assert.equal(args[2], 'create');
        return JSON.stringify({ realm_id: 'offline-realm' });
      }
      assert.equal(args[0], '-c');
      if (args[1].includes('from astrid.sdk.client import AstridClient')) {
        assert.equal(JSON.parse(args[2]).fixture, 'three-products');
        seedEnv = options.env;
        throw new Error('offline native seed refusal: not_ready runtime_unavailable');
      }
      assert.match(args[1], /^import astrid, astrid_runtime, astrid_runtime_client, runtime_protocol, json;/);
      return JSON.stringify(Object.fromEntries(['astrid', 'astrid_runtime', 'astrid_runtime_client', 'runtime_protocol'].map((name) =>
        [name, { file: path.join(f.checkouts[name === 'astrid' || name === 'astrid_runtime_client' ? 'agent' : 'runtime'], name, '__init__.py'), version: null }])));
    },
    spawn(command, args, options) {
      assert.equal(command, process.execPath);
      assert.deepEqual(args.slice(0, 3), ['-m', 'runtime_protocol.cli', 'start']);
      assert.equal(options.cwd, tempRoot);
      mkdirSync(path.join(tempRoot, 'support/credentials'), { recursive: true });
      writeFileSync(path.join(tempRoot, 'support/credentials/owner.token'), 'offline-owner');
      // A stdio-only child supplies the real spawnGroup streams and exit/close events. No listener is opened.
      const script = [
        `if (process.env.ASTRID_P2_COMMIT_PHASE_CAPTURE === '1') { const fd = require('node:fs').openSync(process.env.ASTRID_P2_COMMIT_PHASE_CAPTURE_SINK, 'wx', 0o600); require('node:fs').writeSync(fd, JSON.stringify({ schema_version: 2, request: 1, phase: 'offline', state: 'final', at_ms: 0, count: 1 }) + '\\n'); require('node:fs').closeSync(fd); }`,
        `process.stderr.write(${JSON.stringify(stderr)});`,
        ...(failure === 'startup' ? [] : [
          `process.stdout.write('${JSON.stringify({ endpoint: 'http://127.0.0.1:45455' })}\\n');`,
          `process.on('SIGTERM', () => process.stderr.write(${JSON.stringify(shutdown)}, () => process.exit(0)));`,
          'setInterval(() => {}, 1000);',
        ]),
      ].join('\n');
      const child = spawn(command, ['-e', script], options);
      children.push({ child, env: options.env });
      return child;
    },
  };
  const modules = {
    'node:child_process': childProcess,
    'node:net': { createServer: net },
    'node:https': { createServer: () => ({ ...net(), close(callback) { hostedClosed = true; callback(); } }) },
    'node:http': { request() { throw new Error('D102 must not open HTTP sockets'); } },
    'node:os': { tmpdir: () => controlProcess.env.TMPDIR },
    'node:crypto': { ...require('node:crypto'), X509Certificate: class {
      publicKey = { export: () => Buffer.from('offline SPKI') };
    } },
    'node:fs': { ...require('node:fs'), mkdtempSync(prefix) { tempRoot = mkdtempSync(prefix); return tempRoot; } },
    '../../../../config/testing/skipConditions.mjs': { RUNTIME_CHECKOUT: f.checkouts.runtime, DIST_DIR: output, ffmpegUnavailableReason: () => null },
    '../../../../src/shared/lib/editorTourVersion.ts': { EDITOR_TOUR_VERSION: 1 },
    './quick-descriptor.ts': {},
    './hung-request-stack.ts': {},
    '../hosted-build-origin.mjs': { resolveHostedRuntimeOrigin: () => 'https://offline.invalid' },
    vite: { build: async () => {} },
    '../../tests/e2e/local/support/astrid.ts': { AstridCli: class {} },
    '@playwright/test': { expect() { assert.fail('D102 must stop before original assertions'); } },
  };
  const harnessUrl = new URL('../../tests/e2e/local/support/harness.ts', import.meta.url);
  const selectedHarnessSource = harnessSource ?? readFileSync(harnessUrl, 'utf8');
  modules['../../tests/e2e/local/support/harness.ts'] = await loadD102Module(selectedHarnessSource, harnessUrl.href,
    { modules, controlProcess, fetch });
  const namespace = await loadD102Module(source, pathToFileURL(sourceFile).href, { modules, controlProcess, fetch });
  try {
    controlProcess.argv = [process.execPath, sourceFile, suiteName, '--launch'];
    await namespace.main({ receiptRoot: f.receiptRoot, workerRoot: f.workerRoot });
    assert.equal(controlProcess.exitCode, 1);
    assert.equal(children.length, failure === 'startup' ? 1 : 2, 'real startRuntime must spawn each Runtime incarnation');
    assert(children.every(({ child }) => child.exitCode !== null), 'actual stop must reap every child');
    assert.equal(hostedClosed, true);
    assert.equal(existsSync(tempRoot), false, 'actual stop must remove the harness temporary directory');
  } finally {
    for (const { child } of children) if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL');
  }
  const manifest = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.failure.stage, failure === 'startup' ? 'normal-service-start' : 'native-seed');
  assert.match(manifest.failure.message, failure === 'startup' ? /Runtime exited before endpoint readiness/ : /offline native seed refusal/);
  assert.equal(seedEnv === undefined, failure === 'startup');
  assert.equal(existsSync(path.join(output, 'readiness.xml')), false);
  assert.equal(existsSync(path.join(output, 'p2.xml')), false);
  return { runtimeLogDir, stderr: stderr + (failure === 'startup' ? '' : shutdown), children, seedEnv, env: controlProcess.env,
    harnessNamespace: modules['../../tests/e2e/local/support/harness.ts'] };
}

test('D102 actual launcher/start/spawn/stop retains startup and native-seed failures offline', async (t) => {
  const f = serviceFixture();
  const beforeEnv = { ...process.env };
  const newSource = readFileSync(new URL('./d66-plain-stack.mjs', import.meta.url), 'utf8');
  const retained = (control) => {
    assert.equal(readFileSync(path.join(control.runtimeLogDir, 'runtime.stderr.log'), 'utf8'), control.stderr);
    assert.equal(statSync(control.runtimeLogDir).mode & 0o777, 0o700);
    for (const stream of ['stdout', 'stderr']) assert.equal(statSync(path.join(control.runtimeLogDir, `runtime.${stream}.log`)).mode & 0o777, 0o600);
  };
  for (const failure of ['startup', 'native-seed']) {
    const newControl = await runD102LauncherControl(f, { source: newSource, failure });
    assert.equal(newControl.env.D66_RUNTIME_LOG_DIR, newControl.runtimeLogDir);
    assert(newControl.children.every(({ env }) => env.D66_RUNTIME_LOG_DIR === newControl.runtimeLogDir));
    retained(newControl);
    t.diagnostic(`${failure}: private streams survive real cleanup`);
  }
  const canary = path.join(f.base, 'inherited-sink-must-not-exist');
  const disabled = await runD102LauncherControl(f, { source: newSource, failure: 'startup', suiteName: 'p1',
    inheritedEnv: { D66_RUNTIME_LOG_DIR: canary } });
  assert.equal(disabled.env.D66_RUNTIME_LOG_DIR, undefined);
  assert.equal(existsSync(disabled.runtimeLogDir), false);
  assert.equal(existsSync(canary), false);
  const unsafeInherited = await runD102LauncherControl(f, { source: newSource, failure: 'startup',
    inheritedEnv: { D66_RUNTIME_LOG_DIR: 'relative-unsafe-canary' } });
  assert.equal(unsafeInherited.env.D66_RUNTIME_LOG_DIR, unsafeInherited.runtimeLogDir);
  retained(unsafeInherited);
  assert.equal(JSON.stringify({ ...process.env }) === JSON.stringify(beforeEnv), true,
    'controls must not configure or leak the host environment');
  t.diagnostic(`current launcher SHA256 ${createHash('sha256').update(newSource).digest('hex')}`);
});

test('D127d verification arm retains private streams while scrubbing inherited Runtime measurement env', async () => {
  const f = serviceFixture();
  const launcherSource = readFileSync(new URL('./d66-plain-stack.mjs', import.meta.url), 'utf8');
  const helper = path.join(f.base, 'inherited-helper.py');
  writeFileSync(helper, 'inherited helper fixture\n');
  const helperSha256 = createHash('sha256').update(readFileSync(helper)).digest('hex');
  const launchEnv = playwrightLaunchEnv({
    suite: suites['p2-element-verify'], suiteName: 'p2-element-verify', output: path.join(f.base, 'launch-output'),
    junit: { readiness: path.join(f.base, 'readiness.xml'), original: path.join(f.base, 'verify.xml') }, stage: 'p2-element-verify',
    baseEnv: { [D66_PHASE_CAPTURE_HELPER_ENV]: helper, [D66_PHASE_CAPTURE_HELPER_SHA256_ENV]: helperSha256 },
  });
  const control = await runD102LauncherControl(f, {
    source: launcherSource,
    failure: 'native-seed',
    suiteName: 'p2-element-verify',
    inheritedEnv: {
      ...launchEnv,
      D79_HUNG_STACK_EVIDENCE_DIR: undefined,
      D79_HUNG_STACK_RUN_ID: undefined,
      ASTRID_P2_COMMIT_PHASE_CAPTURE: '1',
      ASTRID_P2_COMMIT_PHASE_CAPTURE_SINK: '/tmp/inherited-phase-sink-must-not-leak',
      [D66_PHASE_CAPTURE_HELPER_ENV]: helper,
      [D66_PHASE_CAPTURE_HELPER_SHA256_ENV]: helperSha256,
      ASTRID_P2_COMMIT_PHASE_CAPTURE_WATCHDOG_SECONDS: '2',
    },
  });
  assert.equal(control.children.length, 2);
  for (const { env } of control.children) {
    assert.equal(env[D66_ELEMENT_VERIFICATION_ENV], undefined);
    assert.equal(env.ASTRID_P2_COMMIT_PHASE_CAPTURE, undefined);
    assert.equal(env.ASTRID_P2_COMMIT_PHASE_CAPTURE_SINK, undefined);
    assert.equal(env.ASTRID_P2_COMMIT_PHASE_CAPTURE_HELPER, undefined);
    assert.equal(env.ASTRID_P2_COMMIT_PHASE_CAPTURE_HELPER_SHA256, undefined);
    assert.equal(env.ASTRID_P2_COMMIT_PHASE_CAPTURE_WATCHDOG_SECONDS, undefined);
    assert.equal(env.D66_RUNTIME_LOG_DIR, undefined);
    assert.equal(env.D66_RUNTIME_PHASE_LAUNCH_ORDINAL, undefined);
    assert.equal(env.PYTHONPATH.includes('scripts/testing'), false);
  }
  assert.equal(statSync(control.runtimeLogDir).mode & 0o777, 0o700);
  for (const stream of ['stdout', 'stderr']) {
    assert.equal(statSync(path.join(control.runtimeLogDir, `runtime.${stream}.log`)).mode & 0o777, 0o600);
  }
  assert.equal(readFileSync(path.join(control.runtimeLogDir, 'runtime.stderr.log'), 'utf8'), control.stderr);
});

test('D105 actual two-start production caller keeps independent private evidence', async () => {
  const f = serviceFixture();
  const launcherSource = readFileSync(new URL('./d66-plain-stack.mjs', import.meta.url), 'utf8');
  const harnessUrl = new URL('../../tests/e2e/local/support/harness.ts', import.meta.url);
  const newHarnessSource = readFileSync(harnessUrl, 'utf8');

  const control = await runD102LauncherControl(f, { source: launcherSource, failure: 'native-seed', harnessSource: newHarnessSource });
  const phaseOne = path.join(control.runtimeLogDir, 'p2-commit-phase.jsonl');
  assert.equal(existsSync(phaseOne), true, 'first production start must create its phase sink');
  const seedPhase = readFileSync(phaseOne, 'utf8');
  control.env.D66_RUNTIME_PHASE_LAUNCH_ORDINAL = '2';
  const stageStarts = [];
  for (let start = 0; start < 2; start += 1) {
    let harness;
    let error;
    try {
      harness = await control.harnessNamespace.startDirectHarness({ deferTimelineInitialization: true });
      await harness.enableTimelineAuthoring(process.execPath);
    } catch (caught) {
      error = caught;
    } finally {
      await harness?.stop();
    }
    stageStarts.push({ harness, error });
  }
  assert.equal(stageStarts.every(({ error }) => error === undefined), true);
  const launchDirectories = readdirSync(control.runtimeLogDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('launch-'))
    .map((entry) => path.join(control.runtimeLogDir, entry.name));
  assert.equal(launchDirectories.length, 2);
  for (const launchDirectory of launchDirectories) {
    assert.equal(statSync(launchDirectory).mode & 0o777, 0o700);
    assert.equal(existsSync(path.join(launchDirectory, 'p2-commit-phase-2.jsonl')), true);
    assert.equal(statSync(path.join(launchDirectory, 'p2-commit-phase-2.jsonl')).mode & 0o777, 0o600);
    assert.equal(existsSync(path.join(launchDirectory, 'runtime.stdout-2.log')), true);
    assert.equal(existsSync(path.join(launchDirectory, 'runtime.stderr-2.log')), true);
    assert.equal(statSync(path.join(launchDirectory, 'runtime.stdout-2.log')).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(launchDirectory, 'runtime.stderr-2.log')).mode & 0o777, 0o600);
  }
  assert.equal(existsSync(path.join(control.runtimeLogDir, 'runtime.stderr.log')), true);
  assert.equal(existsSync(path.join(control.runtimeLogDir, 'runtime.stdout.log')), true);
  assert.equal(readFileSync(path.join(control.runtimeLogDir, 'runtime.stderr.log'), 'utf8'), control.stderr);
  assert.equal(readFileSync(phaseOne, 'utf8'), seedPhase);
  assert.equal(new Set(launchDirectories).size, 2);
});

test('D83 focused P2 descriptors select one exact original test each and retain the six-test tour', () => {
  const expected = {
    'p2-element': ['tests/e2e/local/three-products.p2-elements-assets.spec.ts', 'P2 mounted element edit: real catalog apply, exact params patch, reload and guarded Undo$'],
    'p2-register-asset': ['tests/e2e/local/three-products.p2-elements-assets.spec.ts', 'P2 mounted registerAsset save: real file drop, exact media/registry fields, reload and guarded Undo$'],
    'p2-automatic-child-placement': ['tests/e2e/local/three-products.p2-elements-assets.spec.ts', 'P2 mounted automatic child placement: embedded shot file gesture, occurrence command, closure and guarded Undo$'],
    'p2-parent-move': ['tests/e2e/local/three-products.p2-tour.spec.ts', 'P2 mounted single parent move: v2 commit, exact field delta, reload and guarded Undo$'],
    'p2-transition-none-single': ['tests/e2e/local/three-products.p2-tour.spec.ts', 'P2 mounted transition None single: raw clear preserves opaque data/order and guarded Undo$'],
    'p2-transition-none-bulk': ['tests/e2e/local/three-products.p2-tour.spec.ts', 'P2 mounted transition None bulk: atomic raw clears preserve unknown fields/order and guarded Undo$'],
  };
  for (const [name, [file, grep]] of Object.entries(expected)) {
    assert.deepEqual(suites[name].files, [file]);
    assert.equal(suites[name].count, 1);
    assert.equal(suites[name].grep, grep);
    assert.equal(suites[name].retainRuntimeLogs, true);
  }
  assert.deepEqual(suites['p2-element-verify'].files, suites['p2-element'].files);
  assert.equal(suites['p2-element-verify'].count, suites['p2-element'].count);
  assert.equal(suites['p2-element-verify'].grep, suites['p2-element'].grep);
  assert.equal(suites['p2-element-verify'].retainRuntimeLogs, true);
  assert.equal(suites['p2-element-verify'].verificationOnly, true);
  assert.deepEqual(suites.p2.files, [
    'tests/e2e/local/three-products.p2-tour.spec.ts',
    'tests/e2e/local/three-products.p2-elements-assets.spec.ts',
  ]);
  assert.equal(suites.p2.count, 6);
  assert.equal(suites.p3.count, 1);
});

test('D66 accepts a detached clean checkout matching the normal head and tree', () => {
  assert.deepEqual(validateSelectedSource({
    role: 'agent', selected: '/snapshot/agent', normal: '/home/user/work/agent',
    normalState: state(), selectedState: state(),
  }), {
    checkout: '/snapshot/agent', head: 'a'.repeat(40), tree: 'b'.repeat(40),
    normal_home: '/home/user/work/agent', normal_head: 'a'.repeat(40), normal_tree: 'b'.repeat(40),
  });
});

test('D66 refuses a source that is the mutable normal home', () => {
  assert.throws(() => validateSelectedSource({
    role: 'runtime', selected: '/home/user/work/runtime', normal: '/home/user/work/runtime',
    normalState: state(), selectedState: state({ root: '/home/user/work/runtime' }),
  }), /per-request checkout/);
});

test('D66 refuses a selected source after the normal home advances', () => {
  assert.throws(() => validateSelectedSource({
    role: 'agent', selected: '/snapshot/agent', normal: '/home/user/work/agent',
    normalState: state({ head: 'c'.repeat(40), tree: 'd'.repeat(40) }), selectedState: state(),
  }), /not the current normal head/);
});

test('D66 refuses attached or dirty source checkouts', () => {
  assert.throws(() => validateSelectedSource({
    role: 'agent', selected: '/snapshot/agent', normal: '/home/user/work/agent',
    normalState: state(), selectedState: state({ branch: 'tl/integration' }),
  }), /must be detached/);
  assert.throws(() => validateSelectedSource({
    role: 'runtime', selected: '/snapshot/runtime', normal: '/home/user/work/runtime',
    normalState: state(), selectedState: state({ root: '/snapshot/runtime', dirty: true }),
  }), /dirty/);
});

test('D66 derives the supported detached route from the captured normal head', () => {
  assert.equal(exactCheckoutPath('app', 'c'.repeat(40)), '/home/user/work/wt/app-pin-cccccccc');
  assert.equal(exactCheckoutPath('agent', 'a'.repeat(40)), '/home/user/work/wt/agt-pin-aaaaaaaa');
  assert.equal(exactCheckoutPath('runtime', 'b'.repeat(40), '/tmp/checkouts'), '/tmp/checkouts/rt-pin-bbbbbbbb');
  assert.equal(exactCheckoutPath('composition', 'd'.repeat(40)), '/home/user/work/wt/vw-pin-dddddddd');
});

const pinned = (role, head, tree) => ({
  checkout: `/snapshot/${role}`, normal_home: `/home/user/work/${role}`,
  head, tree, state: state({ root: `/snapshot/${role}`, head, tree }),
});

test('D73 accepts one immutable four-repository tuple and does not consult moving normal heads', () => {
  const sources = {
    app: pinned('app', 'a'.repeat(40), '1'.repeat(40)),
    agent: pinned('agent', 'b'.repeat(40), '2'.repeat(40)),
    runtime: pinned('runtime', 'c'.repeat(40), '3'.repeat(40)),
    composition: pinned('composition', 'd'.repeat(40), '4'.repeat(40)),
  };
  assert.deepEqual(validatePinnedSources({ sources, appRootState: state({ tree: sources.app.tree }) }), sources);
  assert.throws(() => validatePinnedSources({ sources, appRootState: state({ head: 'f'.repeat(40), tree: sources.app.tree }) }), /App service source/);
  // A normal-home movement after this validation is irrelevant: launch uses the tuple above.
  assert.deepEqual(validatePinnedSource({ role: 'agent', selected: sources.agent.checkout,
    normal: sources.agent.normal_home, expectedHead: sources.agent.head, expectedTree: sources.agent.tree,
    selectedState: sources.agent.state }), {
    checkout: sources.agent.checkout, head: sources.agent.head, tree: sources.agent.tree, normal_home: sources.agent.normal_home,
  });
});

test('D73 refuses stale, missing, tampered, or wrong selected pins before any gesture can run', () => {
  const source = pinned('composition', 'd'.repeat(40), '4'.repeat(40));
  assert.throws(() => validatePinnedSource({ role: 'composition', selected: source.checkout,
    normal: source.normal_home, expectedHead: 'e'.repeat(40), expectedTree: source.tree, selectedState: source.state }), /does not match/);
  assert.throws(() => validatePinnedSource({ role: 'composition', selected: source.checkout,
    normal: source.normal_home, expectedHead: source.head, expectedTree: '5'.repeat(40), selectedState: source.state }), /does not match/);
  assert.throws(() => validatePinnedSource({ role: 'composition', selected: source.normal_home,
    normal: source.normal_home, expectedHead: source.head, expectedTree: source.tree, selectedState: source.state }), /per-request checkout/);
  assert.throws(() => validatePinnedSources({ sources: { app: source } }), /agent exact source is required/);
});

test('D73 service recipe carries full SHA/tree and all four exact checkout paths', () => {
  const pins = {
    app: { head: 'a'.repeat(40), tree: '1'.repeat(40) }, agent: { head: 'b'.repeat(40), tree: '2'.repeat(40) },
    runtime: { head: 'c'.repeat(40), tree: '3'.repeat(40) }, composition: { head: 'd'.repeat(40), tree: '4'.repeat(40) },
  };
  const recipe = serviceRecipe({ name: 'p3', target: 'app-P-D73', pins, checkouts: {
    app: '/snapshot/app', agent: '/snapshot/agent', runtime: '/snapshot/runtime', composition: '/snapshot/composition',
  } });
  for (const role of ['APP', 'AGENT', 'RUNTIME', 'COMPOSITION']) {
    assert.match(recipe, new RegExp(`D66_${role}_SHA='[a-f0-9]{40}'`));
    assert.match(recipe, new RegExp(`D66_${role}_TREE='[a-f0-9]{40}'`));
    assert.match(recipe, new RegExp(`D66_${role}_CHECKOUT='[^']+'`));
  }
  assert.doesNotMatch(recipe, /current normal|gesture|POST|publish/);
  assert.equal(serviceRecipe({ name: 'p3', pins, checkouts: {
    app: '/snapshot/app', agent: '/snapshot/agent', runtime: '/snapshot/runtime', composition: '/snapshot/composition',
  }, preflight: true }), `${recipe} --preflight`);
});

test('D78 service recipes select the Runtime watchdog only for the intended P2 route', () => {
  const pins = {
    app: { head: 'a'.repeat(40), tree: '1'.repeat(40) }, agent: { head: 'b'.repeat(40), tree: '2'.repeat(40) },
    runtime: { head: 'c'.repeat(40), tree: '3'.repeat(40) }, composition: { head: 'd'.repeat(40), tree: '4'.repeat(40) },
  };
  const checkouts = { app: '/snapshot/app', agent: '/snapshot/agent', runtime: '/snapshot/runtime', composition: '/snapshot/composition' };
  const watchdog = (name) => serviceRecipe({ name, pins, checkouts }).match(/ASTRID_P2_COMMIT_PHASE_CAPTURE_WATCHDOG_SECONDS='([^']*)'/)?.[1];
  assert.equal(watchdog('p2-element'), '2');
  assert.equal(watchdog('p2'), '20');
  assert.equal(watchdog('p1'), '');
  assert.equal(watchdog('p3'), '');
  const verification = serviceRecipe({ name: 'p2-element-verify', pins, checkouts });
  assert.match(verification, new RegExp(`${D66_ELEMENT_VERIFICATION_ENV}='1'`));
  assert.match(verification, /ASTRID_P2_COMMIT_PHASE_CAPTURE_WATCHDOG_SECONDS=''/);
});

test('D124 requires and carries the reviewed diagnostic helper path and SHA256 without changing the default helper route', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'd124-helper-identity-'));
  const helper = path.join(base, 'p2_commit_phase_capture.py');
  writeFileSync(helper, 'reviewed helper\n');
  const sha256 = createHash('sha256').update(readFileSync(helper)).digest('hex');
  const env = { [D66_PHASE_CAPTURE_HELPER_ENV]: helper, [D66_PHASE_CAPTURE_HELPER_SHA256_ENV]: sha256 };
  assert.deepEqual(diagnosticHelperIdentity({ runtimeCheckout: base, env, required: true }), {
    path: helper, sha256, source: 'explicit',
  });
  const pins = {
    app: { head: 'a'.repeat(40), tree: '1'.repeat(40) }, agent: { head: 'b'.repeat(40), tree: '2'.repeat(40) },
    runtime: { head: 'c'.repeat(40), tree: '3'.repeat(40) }, composition: { head: 'd'.repeat(40), tree: '4'.repeat(40) },
  };
  const checkouts = { app: '/snapshot/app', agent: '/snapshot/agent', runtime: '/snapshot/runtime', composition: '/snapshot/composition' };
  const recipe = serviceRecipe({ name: 'p2', pins, checkouts, diagnosticHelper: { path: helper, sha256 } });
  assert.match(recipe, new RegExp(`${D66_PHASE_CAPTURE_HELPER_ENV}='${helper.replaceAll('/', '\\/')}'`));
  assert.match(recipe, new RegExp(`${D66_PHASE_CAPTURE_HELPER_SHA256_ENV}='${sha256}'`));
  assert.doesNotMatch(serviceRecipe({ name: 'p2', pins, checkouts }), new RegExp(`${D66_PHASE_CAPTURE_HELPER_ENV}=`));
  assert.throws(() => diagnosticHelperIdentity({ runtimeCheckout: base, env: { [D66_PHASE_CAPTURE_HELPER_ENV]: helper }, required: true }), /SHA256/);
  assert.throws(() => diagnosticHelperIdentity({ runtimeCheckout: base, env: { ...env, [D66_PHASE_CAPTURE_HELPER_SHA256_ENV]: '0'.repeat(64) }, required: true }), /mismatch/);
  assert.throws(() => diagnosticHelperIdentity({ runtimeCheckout: base, env: { ...env, [D66_PHASE_CAPTURE_HELPER_ENV]: path.join(base, 'missing.py') }, required: true }), /unavailable/);
});

test('D124 normal submit recipe carries the reviewed helper identity before service startup', async () => {
  const f = serviceFixture();
  const helper = path.join(f.base, 'reviewed-p2-helper.py');
  writeFileSync(helper, 'reviewed helper\n');
  const sha256 = createHash('sha256').update(readFileSync(helper)).digest('hex');
  const registryPath = path.join(f.base, 'suites.conf');
  writeFileSync(registryPath, 'app existing-suite existing-command\n');
  const env = { ...f.env, D66_OUTPUT_DIR: f.base, D66_SUBMIT_SUITE: 'd124-helper-submit',
    [D66_PHASE_CAPTURE_HELPER_ENV]: helper, [D66_PHASE_CAPTURE_HELPER_SHA256_ENV]: sha256 };
  const io = submitIo(f);
  await submit('p1', { env, homes: f.homes, appRoot: f.snapshot, receiptRoot: f.receiptRoot,
    workerRoot: f.workerRoot, checkoutRoot: f.base, registryPath, runCommand: io.runCommand,
    runWait: io.runWait, readStatus: io.readStatus });
  const registered = readFileSync(registryPath, 'utf8');
  assert.equal((registered.match(new RegExp(`${D66_PHASE_CAPTURE_HELPER_ENV}=`, 'g')) ?? []).length, 2);
  assert.match(registered, new RegExp(`${D66_PHASE_CAPTURE_HELPER_SHA256_ENV}='${sha256}'`));
});

function runGit(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
}

function fixtureRepo(directory, name) {
  mkdirSync(directory, { recursive: true });
  runGit(directory, 'init', '-q');
  runGit(directory, 'config', 'user.email', 'd73@example.test');
  runGit(directory, 'config', 'user.name', 'D73 fixture');
  writeFileSync(path.join(directory, `${name}.txt`), `${name}\n`);
  if (name === 'app') {
    mkdirSync(path.join(directory, 'scripts/testing'), { recursive: true });
    writeFileSync(path.join(directory, 'scripts/testing/d66-plain-stack.mjs'), readFileSync(new URL('./d66-plain-stack.mjs', import.meta.url)));
    for (const file of [
      'tests/e2e/local/three-products.p1-chain.spec.ts',
      'tests/e2e/local/three-products.p2-tour.spec.ts',
      'tests/e2e/local/three-products.p2-elements-assets.spec.ts',
      'tests/e2e/local/three-products.mounted-readiness.spec.ts',
    ]) {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), 'offline descriptor fixture\n');
    }
  }
  runGit(directory, 'add', '.');
  runGit(directory, 'commit', '-qm', 'fixture');
  return { head: runGit(directory, 'rev-parse', 'HEAD'), tree: runGit(directory, 'rev-parse', 'HEAD^{tree}') };
}

function detachedFixture(normal, checkout) {
  execFileSync('git', ['clone', '-q', normal, checkout]);
  runGit(checkout, 'config', 'user.email', 'd73@example.test');
  runGit(checkout, 'config', 'user.name', 'D73 fixture');
  runGit(checkout, 'checkout', '--detach', '-q', 'HEAD');
}

test('D73 dry-preflight selects env paths and parses genuine checkout receipts before launch', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'd73-preflight-'));
  const homes = Object.fromEntries(['app', 'agent', 'runtime', 'composition'].map((role) => [role, path.join(base, `${role}-normal`)]));
  const checkouts = Object.fromEntries(Object.keys(homes).map((role) => [role, path.join(base, `${role}-checkout`)]));
  const pins = Object.fromEntries(Object.entries(homes).map(([role, home]) => [role, fixtureRepo(home, role)]));
  for (const role of Object.keys(homes)) detachedFixture(homes[role], checkouts[role]);
  const env = Object.fromEntries(Object.keys(homes).flatMap((role) => [
    [`D66_${role.toUpperCase()}_SHA`, pins[role].head], [`D66_${role.toUpperCase()}_TREE`, pins[role].tree],
    [`D66_${role.toUpperCase()}_CHECKOUT`, `  ${checkouts[role]}  `],
  ]));
  const selected = selectPinnedSources(env, homes, checkouts.app);
  assert.deepEqual(Object.fromEntries(Object.entries(selected).map(([role, source]) => [role, source.checkout])), checkouts);
  writeFileSync(path.join(base, 'created-receipt'), `created ${checkouts.agent} (detached at ${pins.agent.head}, KEEP)\n`);
  writeFileSync(path.join(base, 'exists-receipt'), `exists: ${checkouts.runtime} at ${pins.runtime.head}\n`);
  assert.equal(receiptCheckout(path.join(base, 'created-receipt'), 'agent', pins.agent.head), checkouts.agent);
  assert.equal(receiptCheckout(path.join(base, 'exists-receipt'), 'runtime', pins.runtime.head), checkouts.runtime);
  assert.throws(() => selectPinnedSources({ ...env, D66_AGENT_CHECKOUT: checkouts.runtime }, homes, checkouts.app), /does not match/);
  const missingPinEnv = { ...env };
  delete missingPinEnv.D66_RUNTIME_TREE;
  assert.throws(() => selectPinnedSources(missingPinEnv, homes, checkouts.app), /runtime tree must be a full 40-character SHA/);
});

function serviceFixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'd73-service-'));
  const roles = ['app', 'agent', 'runtime', 'composition'];
  const homes = Object.fromEntries(roles.map((role) => [role, path.join(base, `${role}-normal`)]));
  for (const role of roles) fixtureRepo(homes[role], role);
  const pins = captureSubmitPins(homes);
  const checkouts = Object.fromEntries(roles.map((role) => [role, exactCheckoutPath(role, pins[role].head, base)]));
  const receiptRoot = path.join(base, 'receipts');
  const workerRoot = path.join(base, 'workers');
  mkdirSync(receiptRoot);
  for (const role of roles) {
    detachedFixture(homes[role], checkouts[role]);
    const receipt = role === 'runtime'
      ? `exists: ${checkouts[role]} at ${pins[role].head}\n`
      : `created ${checkouts[role]} (detached at ${pins[role].head}, KEEP)\n`;
    writeFileSync(path.join(receiptRoot, `checkout-${role}-${pins[role].head}`), receipt);
  }
  const target = path.basename(checkouts.app);
  mkdirSync(path.join(workerRoot, target), { recursive: true });
  writeFileSync(path.join(workerRoot, target, 'meta'), `name=${target}\nrepo=app\nworktree=${checkouts.app}\n`);
  // Match bin/test-run: commit-tree <target tree> -p HEAD, then a detached worktree.
  const snapshot = path.join(base, '.test-fixture');
  const snapshotHead = runGit(checkouts.app, 'commit-tree', pins.app.tree, '-p', 'HEAD', '-m', 'test snapshot fixture');
  runGit(checkouts.app, 'worktree', 'add', '-q', '--detach', snapshot, snapshotHead);
  const env = Object.fromEntries(roles.flatMap((role) => [
    [`D66_${role.toUpperCase()}_SHA`, pins[role].head], [`D66_${role.toUpperCase()}_TREE`, pins[role].tree],
    [`D66_${role.toUpperCase()}_CHECKOUT`, checkouts[role]],
  ]));
  return { base, roles, homes, pins, checkouts, env, snapshot, snapshotHead, target, receiptRoot, workerRoot };
}

test('D73 verifies a real service snapshot, receipts and target after mutable homes move', async () => {
  const f = serviceFixture();
  const plan = buildSubmitPlan({ name: 'p1', paths: f.homes });
  assert.deepEqual(plan.pins, f.pins);
  assert.equal(plan.target, undefined);
  for (const role of f.roles) {
    writeFileSync(path.join(f.homes[role], `${role}.txt`), 'normal home advanced\n');
    runGit(f.homes[role], 'add', '.');
    runGit(f.homes[role], 'commit', '-qm', 'advance normal home');
  }
  const result = preflightSources(f.env, f.homes, f.snapshot, f);
  assert.equal(result.target, f.target);
  assert.equal(result.sources.app.head, f.pins.app.head);
  assert.equal(result.service_source.head, f.snapshotHead);
  assert.equal(result.service_source.tree, f.pins.app.tree);
  assert.deepEqual(result.service_source.parents, [f.pins.app.head]);
  assert.equal(preflightSources(f.env, f.homes, f.checkouts.app, f).service_source.head, f.pins.app.head);
  const checkoutRequests = f.roles.map((role) => ({ role, head: f.pins[role].head, checkout: f.checkouts[role],
    receipt: path.join(f.receiptRoot, `checkout-${role}-${f.pins[role].head}`) }));
  assert.deepEqual(await waitForSubmitReceipts({ pins: f.pins, checkoutRequests }, { waitMs: 0 }), f.checkouts);
});

test('D73 refuses same-tree worker finalization parents, grandparents, multiple parents and changed snapshot trees', () => {
  const f = serviceFixture();
  const finalized = runGit(f.checkouts.app, 'commit-tree', f.pins.app.tree, '-p', f.pins.app.head, '-m', 'worker finalization');
  const wrongTree = runGit(f.checkouts.agent, 'rev-parse', 'HEAD^{tree}');
  // Import only this tiny fixture tree into the App fixture object store.
  runGit(f.checkouts.app, 'fetch', '-q', f.checkouts.agent, 'HEAD');
  const cases = [
    [f.pins.app.tree, '-p', finalized],
    [f.pins.app.tree, '-p', f.pins.app.head, '-p', finalized],
    [f.pins.app.tree],
    [wrongTree, '-p', f.pins.app.head],
  ];
  for (const args of cases) {
    const head = runGit(f.checkouts.app, 'commit-tree', ...args, '-m', 'bad service snapshot');
    // Only HEAD changes; every same-tree counterexample has identical tracked files.
    runGit(f.snapshot, 'update-ref', '--no-deref', 'HEAD', head);
    assert.throws(() => preflightSources(f.env, f.homes, f.snapshot, f), /App service source/);
  }
  runGit(f.snapshot, 'update-ref', '--no-deref', 'HEAD', f.snapshotHead);
  runGit(f.checkouts.app, 'update-ref', '--no-deref', 'HEAD', finalized);
  assert.throws(() => preflightSources(f.env, f.homes, f.snapshot, f), /app source does not match its submit-time pin/);
});

test('D73 refuses wrong App selection, attached or dirty selected checkouts, and dirty service roots', () => {
  const f = serviceFixture();
  assert.throws(() => preflightSources({ ...f.env, D66_APP_CHECKOUT: f.snapshot }, f.homes, f.snapshot, f), /does not match its submit-time pin/);
  for (const role of f.roles) {
    runGit(f.checkouts[role], 'update-ref', 'refs/heads/d73-attached', f.pins[role].head);
    runGit(f.checkouts[role], 'symbolic-ref', 'HEAD', 'refs/heads/d73-attached');
    assert.throws(() => preflightSources(f.env, f.homes, f.snapshot, f), /must be detached/);
    runGit(f.checkouts[role], 'update-ref', '--no-deref', 'HEAD', f.pins[role].head);
    writeFileSync(path.join(f.checkouts[role], `${role}.txt`), 'dirty\n');
    assert.throws(() => preflightSources(f.env, f.homes, f.snapshot, f), /dirty/);
    writeFileSync(path.join(f.checkouts[role], `${role}.txt`), `${role}\n`);
  }
  writeFileSync(path.join(f.snapshot, 'app.txt'), 'dirty service root\n');
  assert.throws(() => preflightSources(f.env, f.homes, f.snapshot, f), /App service source is dirty/);
});

test('D73 refuses missing pins before checkout access, missing/wrong receipts and target metadata mismatches', () => {
  const f = serviceFixture();
  for (const role of f.roles) {
    for (const kind of ['SHA', 'TREE']) {
      const env = { ...f.env, D66_APP_CHECKOUT: '/unavailable/should-not-be-read' };
      delete env[`D66_${role.toUpperCase()}_${kind}`];
      assert.throws(() => preflightSources(env, f.homes, f.snapshot, f), /must be a full 40-character SHA/);
    }
  }
  assert.throws(() => preflightSources(f.env, f.homes, f.snapshot, { ...f, receiptRoot: path.join(f.base, 'missing-receipts') }), /ENOENT/);
  const receipt = path.join(f.receiptRoot, `checkout-agent-${f.pins.agent.head}`);
  writeFileSync(receipt, `exists: ${f.checkouts.runtime} at ${f.pins.agent.head}\n`);
  assert.throws(() => preflightSources(f.env, f.homes, f.snapshot, f), /receipt selected the wrong checkout/);
  writeFileSync(receipt, `exists: ${f.checkouts.agent} at ${f.pins.runtime.head}\n`);
  assert.throws(() => preflightSources(f.env, f.homes, f.snapshot, f), /receipt is missing or tampered/);
  assert.throws(() => appCheckoutTarget(f.checkouts.app, f.pins.app.head, { ...f, target: 'app-proof-worker' }), /stable exact App checkout/);
  writeFileSync(path.join(f.workerRoot, f.target, 'meta'), `name=${f.target}\nrepo=app\nworktree=${f.snapshot}\n`);
  assert.throws(() => appCheckoutTarget(f.checkouts.app, f.pins.app.head, f), /target metadata does not match/);
});

test('D73 preflight entrypoint records actual snapshot separately and stops before imports, build or collection', () => {
  const f = serviceFixture();
  const script = path.join(f.snapshot, 'scripts/testing/d66-plain-stack.mjs');
  const output = path.join(f.base, 'output');
  const invoke = (pins, mode = '--preflight') => spawnSync(process.execPath, ['--input-type=module', '-e', [
    `import { main } from ${JSON.stringify(script)};`,
    `process.argv = [process.execPath, ${JSON.stringify(script)}, 'p1', ${JSON.stringify(mode)}];`,
    `await main(${JSON.stringify({ receiptRoot: f.receiptRoot, workerRoot: f.workerRoot })});`,
  ].join('\n')], {
    cwd: f.snapshot, encoding: 'utf8', env: { ...process.env, ...pins, D66_OUTPUT_DIR: output,
      D66_NORMAL_AGENT_HOME: f.homes.agent, D66_NORMAL_RUNTIME_HOME: f.homes.runtime,
      D66_NORMAL_COMPOSITION_HOME: f.homes.composition,
      ASTRID_PYTHON: '/missing/no-python-in-preflight', ASTRID_RUNTIME_PYTHON: '/missing/no-python-in-preflight' },
  });
  // The fixture has no node_modules, build config or specs. Python paths deliberately do not exist.
  const result = invoke(f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /source preflight PASS/);
  const manifest = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.repo_heads.app, f.pins.app.head);
  assert.equal(manifest.service_source.head, f.snapshotHead);
  assert.deepEqual(manifest.service_source.parents, [f.pins.app.head]);
  assert.equal(manifest.service_target, f.target);
  assert.equal(manifest.service_versions, undefined);
  const poisoned = invoke({ ...f.env, D66_RUNTIME_SHA: '' });
  assert.equal(poisoned.status, 1);
  assert.match(poisoned.stderr, /runtime SHA must be a full 40-character SHA/);
  assert.doesNotMatch(poisoned.stdout, /PASS/);
  const poisonedRun = invoke({ ...f.env, D66_RUNTIME_SHA: '' }, 'run');
  assert.equal(poisonedRun.status, 1);
  assert.match(poisonedRun.stderr, /runtime SHA must be a full 40-character SHA/);
});

function submitIo(f, waitStatuses = ['pass']) {
  const calls = [];
  let requestNumber = 0;
  let waitNumber = 0;
  const runCommand = async (file, args) => {
    calls.push({ type: path.basename(file), args });
    if (file.endsWith('request-test')) {
      requestNumber += 1;
      const id = `${args[1]}-${requestNumber}`;
      return { status: 0, stdout: `${f.base}/tests/${id}/\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const runWait = async (args) => {
    calls.push({ type: 'wait-test', args });
    const status = waitStatuses[Math.min(waitNumber++, waitStatuses.length - 1)];
    return { status: status === 'timeout' ? 124 : status === 'pass' ? 0 : 1, stdout: '', stderr: '' };
  };
  return { calls, runCommand, runWait, readStatus: () => waitStatuses.at(-1) };
}

test('D73 --submit queues one preflight, waits it, then one normal request with the same tuple', async () => {
  const f = serviceFixture();
  const registryPath = path.join(f.base, 'suites.conf');
  const artifactPath = path.join(f.base, 'submit-plan.json');
  const original = Buffer.from('app existing-suite existing-command\n# preserve this comment\n');
  writeFileSync(registryPath, original);
  writeFileSync(path.join(f.homes.agent, 'agent.txt'), 'normal home advanced before submit\n');
  runGit(f.homes.agent, 'add', '.');
  runGit(f.homes.agent, 'commit', '-qm', 'advance mutable normal home');
  const io = submitIo(f);
  const order = [];
  const env = { ...f.env, D66_SUBMIT_SUITE: 'd73-submit-fixture', D66_OUTPUT_DIR: f.base };
  const options = { env, homes: f.homes, appRoot: f.snapshot, receiptRoot: f.receiptRoot,
    workerRoot: f.workerRoot, checkoutRoot: f.base, registryPath, runCommand: async (file, args) => {
      order.push(['command', path.basename(file), ...args]);
      return io.runCommand(file, args);
    }, runWait: async (args) => { order.push(['wait', ...args]); return io.runWait(args); }, readStatus: io.readStatus };
  const result = await submit('p1', options);
  assert.deepEqual(result.pins, f.pins, 'an explicit tuple must survive mutable normal-home movement');
  assert.deepEqual(io.calls.filter((call) => call.type === 'request-checkout').map((call) => call.args.slice(0, 2)),
    f.roles.map((role) => [role, f.pins[role].head]));
  assert.equal(result.preflight.id, 'd73-submit-fixture-preflight-1');
  assert.equal(result.normal.id, 'd73-submit-fixture-2');
  assert.deepEqual(order.slice(0, 6).map((entry) => entry[0]), ['command', 'command', 'command', 'command', 'command', 'wait']);
  assert.deepEqual(order.slice(-2).map((entry) => entry[0]), ['wait', 'command']);
  assert.deepEqual(order.at(-1).slice(2), [f.target, 'd73-submit-fixture', '--no-cache']);
  const registered = readFileSync(registryPath);
  assert.ok(registered.subarray(0, original.length).equals(original));
  assert.match(registered.toString(), /app d73-submit-fixture-preflight .* --preflight\napp d73-submit-fixture /s);
  assert.doesNotMatch(registered.toString(), /\$\{node\}/);

  const beforeRetry = order.length;
  await submit('p1', options);
  assert.equal(order.length, beforeRetry, 'a completed plan must not queue another original');
});

test('D73 default --submit captures moving normal homes once when no explicit tuple is supplied', async () => {
  const f = serviceFixture();
  const registryPath = path.join(f.base, 'suites.conf');
  writeFileSync(registryPath, 'app existing-suite existing-command\n');
  const env = { ...f.env, D66_SUBMIT_SUITE: 'd73-submit-default', D66_OUTPUT_DIR: f.base };
  for (const role of f.roles) {
    delete env[`D66_${role.toUpperCase()}_SHA`];
    delete env[`D66_${role.toUpperCase()}_TREE`];
    delete env[`D66_${role.toUpperCase()}_CHECKOUT`];
  }
  const io = submitIo(f);
  let advanced = false;
  const runCommand = async (file, args) => {
    const result = await io.runCommand(file, args);
    if (!advanced && path.basename(file) === 'request-checkout' && args[0] === 'agent') {
      advanced = true;
      writeFileSync(path.join(f.homes.agent, 'agent.txt'), 'normal home advanced during submit\n');
      runGit(f.homes.agent, 'add', '.');
      runGit(f.homes.agent, 'commit', '-qm', 'advance mutable normal home during submit');
    }
    return result;
  };
  const result = await submit('p1', { env, homes: f.homes, appRoot: f.snapshot, receiptRoot: f.receiptRoot,
    workerRoot: f.workerRoot, checkoutRoot: f.base, registryPath, runCommand, runWait: io.runWait, readStatus: io.readStatus });
  assert.deepEqual(result.pins, f.pins);
});

test('D73 incomplete or wrong explicit tuples refuse before any checkout request', async () => {
  const f = serviceFixture();
  const registryPath = path.join(f.base, 'suites.conf');
  writeFileSync(registryPath, 'app existing-suite existing-command\n');
  const calls = [];
  const runCommand = async (...args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; };
  const options = { homes: f.homes, appRoot: f.snapshot, receiptRoot: f.receiptRoot, workerRoot: f.workerRoot,
    checkoutRoot: f.base, registryPath, runCommand, runWait: async () => ({ status: 0, stdout: '', stderr: '' }),
    readStatus: () => 'pass' };

  const partial = { ...f.env, D66_AGENT_TREE: undefined, D66_OUTPUT_DIR: f.base, D66_SUBMIT_SUITE: 'd73-submit-partial' };
  await assert.rejects(() => submit('p1', { ...options, env: partial }), /agent tree must be a full 40-character SHA/);
  assert.equal(calls.length, 0);

  const wrongPin = { ...f.env, D66_RUNTIME_TREE: 'e'.repeat(40), D66_OUTPUT_DIR: f.base, D66_SUBMIT_SUITE: 'd73-submit-wrong-pin' };
  await assert.rejects(() => submit('p1', { ...options, env: wrongPin }), /does not match its submit-time pin/);
  assert.equal(calls.length, 0);
});

test('D73 --submit stops after a refused preflight and never queues the normal body', async () => {
  const f = serviceFixture();
  const registryPath = path.join(f.base, 'suites.conf');
  writeFileSync(registryPath, 'app existing-suite existing-command\n');
  const io = submitIo(f, ['fail']);
  const env = { ...f.env, D66_SUBMIT_SUITE: 'd73-submit-refused', D66_OUTPUT_DIR: f.base };
  await assert.rejects(() => submit('p1', { env, homes: f.homes, appRoot: f.snapshot, receiptRoot: f.receiptRoot,
    workerRoot: f.workerRoot, checkoutRoot: f.base, registryPath, runCommand: io.runCommand, runWait: io.runWait, readStatus: io.readStatus }), /preflight refused/);
  assert.equal(io.calls.filter((call) => call.type === 'request-test').length, 1);
  assert.equal(io.calls.filter((call) => call.type === 'request-test' && call.args[1] === 'd73-submit-refused').length, 0);
});

test('D73 timeout resumes the same preflight ID without duplicating either request', async () => {
  const f = serviceFixture();
  const registryPath = path.join(f.base, 'suites.conf');
  writeFileSync(registryPath, 'app existing-suite existing-command\n');
  const io = submitIo(f, ['timeout', 'pass']);
  const env = { ...f.env, D66_SUBMIT_SUITE: 'd73-submit-timeout', D66_OUTPUT_DIR: f.base };
  const result = await submit('p1', { env, homes: f.homes, appRoot: f.snapshot, receiptRoot: f.receiptRoot,
    workerRoot: f.workerRoot, checkoutRoot: f.base, registryPath, runCommand: io.runCommand, runWait: io.runWait, readStatus: io.readStatus });
  const waits = io.calls.filter((call) => call.type === 'wait-test');
  assert.deepEqual(waits.map((call) => call.args), [['d73-submit-timeout-preflight-1'], ['d73-submit-timeout-preflight-1']]);
  assert.equal(io.calls.filter((call) => call.type === 'request-test').length, 2);
  assert.equal(result.normal.id, 'd73-submit-timeout-2');
});

test('D79 serializes concurrent same-plan callers and preserves one normal ID across a 124 resume', async () => {
  const f = serviceFixture();
  const registryPath = path.join(f.base, 'suites.conf');
  writeFileSync(registryPath, 'app existing-suite existing-command\n');
  const io = submitIo(f);
  let releaseWait;
  let enteredWait;
  const waitEntered = new Promise((resolve) => { enteredWait = resolve; });
  const blocked = new Promise((resolve) => { releaseWait = resolve; });
  let waits = 0;
  const env = { ...f.env, D66_SUBMIT_SUITE: 'd79-submit-race', D66_OUTPUT_DIR: f.base };
  const options = {
    env, homes: f.homes, appRoot: f.snapshot, receiptRoot: f.receiptRoot,
    workerRoot: f.workerRoot, checkoutRoot: f.base, registryPath,
    runCommand: io.runCommand,
    runWait: async (args) => {
      waits += 1;
      if (waits === 1) {
        enteredWait();
        await blocked;
        io.calls.push({ type: 'wait-test', args });
        return { status: 124, stdout: '', stderr: '' };
      }
      return io.runWait(args);
    },
    readStatus: io.readStatus,
  };

  const first = submit('p1', options);
  await waitEntered;
  const second = submit('p1', options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(io.calls.filter((call) => call.type === 'request-test').length, 1,
    'the queued caller must not submit while the first caller owns the plan');
  releaseWait();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.normal.id, 'd79-submit-race-2');
  assert.equal(secondResult.normal.id, firstResult.normal.id);
  assert.deepEqual(io.calls.filter((call) => call.type === 'request-test').map((call) => call.args[1]), [
    'd79-submit-race-preflight', 'd79-submit-race',
  ]);
  assert.deepEqual(io.calls.filter((call) => call.type === 'wait-test').map((call) => call.args), [
    ['d79-submit-race-preflight-1'], ['d79-submit-race-preflight-1'],
  ]);
});

test('D73 registry registration refuses a concurrent outside-byte change', () => {
  const base = Buffer.from('app old old-command\n');
  let reads = 0;
  assert.throws(() => registerSubmitRecipes({ registryPath: '/tmp/d73-registry-fixture', rows: [
    'app d73-preflight preflight-command', 'app d73-normal normal-command'],
  readRegistry: () => (reads++ === 0 ? base : Buffer.from(`${base}app concurrent changed\n`)), writeRegistry: () => assert.fail('must not write after a concurrent change') }), /changed concurrently/);
});

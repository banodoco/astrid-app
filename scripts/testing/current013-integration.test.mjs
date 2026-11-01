import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, mock, test } from 'node:test';
import {
  checkCurrent013Sources, CURRENT013_AGENT, CURRENT013_COMPOSITION, CURRENT013_RUNTIME,
  readCurrent013Inputs, runCurrent013Integration,
} from './current013-integration.mjs';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'current013-wrapper-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const roots = Object.fromEntries(['app', 'agent', 'runtime', 'producer'].map((name) => [name, path.join(scratch, name)]));
for (const root of Object.values(roots)) mkdirSync(root);

function env() {
  return {
    TIMELINE_CURRENT013_APP_TREE: 'a'.repeat(40),
    TIMELINE_CURRENT013_AGENT_SHA: CURRENT013_AGENT.commit,
    TIMELINE_CURRENT013_RUNTIME_SHA: CURRENT013_RUNTIME.serverCommit,
    ASTRID_CHECKOUT: roots.agent,
    ASTRID_RUNTIME_CHECKOUT: roots.runtime,
    TIMELINE_CURRENT013_RUNTIME_PRODUCER_CHECKOUT: roots.producer,
    ASTRID_PYTHON: process.execPath,
    ASTRID_RUNTIME_PYTHON: process.execPath,
  };
}

function write(root, file, contents) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

for (const root of [roots.app, roots.agent]) {
  write(root, 'runtime.lock.json', JSON.stringify({
    producer: 'astrid-runtime', source_commit: CURRENT013_RUNTIME.producerCommit,
    producer_version: CURRENT013_RUNTIME.producerVersion,
  }));
  const metadata = root === roots.app
    ? 'src/integrations/runtime/generated-contract-metadata.ts'
    : 'astrid_runtime_client/contract_metadata.py';
  write(root, metadata, `SCHEMA_DIGEST = '${CURRENT013_RUNTIME.schemaDigest}'\nCOMPONENT_MANIFEST_SHA256 = '${CURRENT013_RUNTIME.componentManifest}'\nCONTRACT_VERSION = '${CURRENT013_RUNTIME.version}'\n`);
  const archive = path.join(root, root === roots.app ? 'vendor/artifacts' : 'remotion/artifacts', CURRENT013_COMPOSITION.archive);
  mkdirSync(path.dirname(archive), { recursive: true });
  copyFileSync(new URL(`../../vendor/artifacts/${CURRENT013_COMPOSITION.archive}`, import.meta.url), archive);
}
write(roots.producer, 'contract/artifacts.json', JSON.stringify({
  producer: 'astrid-runtime', version: CURRENT013_RUNTIME.producerVersion,
  artifacts: Object.fromEntries(Array.from({ length: CURRENT013_RUNTIME.artifactCount }, (_, i) => [`file${i}`, 'fixture'])),
}));

// Git and child execution are controlled; these fixtures only exercise the launcher.
// They neither replace nor qualify the unchanged seven three-products journeys.
function controlled(fn, { dirty = '', childStatus = 0, mutate = () => {} } = {}) {
  const originalExec = childProcess.execFileSync;
  const previousEnv = { ...process.env };
  const previousExit = process.exitCode;
  const calls = [];
  let appStatus = dirty;
  Object.assign(process.env, env(), { TIMELINE_CURRENT013_RUN: '1' });
  delete process.env.ASTRID_APP_DIRECT_DIST;
  mock.method(process, 'cwd', () => roots.app);
  mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (command !== 'git') return originalExec(command, args, options);
    const root = args[1];
    const op = args.slice(2).join(' ');
    calls.push({ root, op });
    if (op === 'rev-parse --show-toplevel') return roots.app;
    if (op === 'rev-parse HEAD^{tree}') return root === roots.agent ? CURRENT013_AGENT.tree : env().TIMELINE_CURRENT013_APP_TREE;
    // A central snapshot's App commit deliberately differs from the App tree.
    if (op === 'rev-parse HEAD') return root === roots.app ? 'd'.repeat(40)
      : root === roots.agent ? CURRENT013_AGENT.commit
        : root === roots.runtime ? CURRENT013_RUNTIME.serverCommit : CURRENT013_RUNTIME.producerCommit;
    if (op === 'status --porcelain --untracked-files=normal') return root === roots.app ? appStatus : '';
    throw new Error(`unexpected git ${op}`);
  });
  mock.method(childProcess, 'spawnSync', (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'npm') {
      mutate({ dirtyApp: (status) => { appStatus = status; } });
      return { status: childStatus };
    }
    assert.ok(command === 'node' || command === process.execPath);
    assert.equal(args[1], 'check');
    return { status: 0 };
  });
  syncBuiltinESMExports();
  try { fn(calls); }
  finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    process.env = previousEnv;
    process.exitCode = previousExit;
  }
}

test('requires the exact App tree and does not infer a moving source path', () => {
  const values = env();
  delete values.TIMELINE_CURRENT013_APP_TREE;
  assert.throws(() => readCurrent013Inputs(values), /TIMELINE_CURRENT013_APP_TREE is required/);
});

test('accepts an App snapshot identity by tree and pins Runtime to the published SHA', () => {
  const input = readCurrent013Inputs(env());
  assert.equal(input.appTree, 'a'.repeat(40));
  assert.equal(input.runtimeSha, CURRENT013_RUNTIME.serverCommit);
});

test('refuses a different Runtime publication before any child launch', () => {
  const values = env();
  values.TIMELINE_CURRENT013_RUNTIME_SHA = 'c'.repeat(40);
  assert.throws(() => readCurrent013Inputs(values), /must be the frozen Runtime server/);
});

test('requires all eight inputs and full identities', () => {
  for (const name of Object.keys(env())) {
    const values = env();
    delete values[name];
    assert.throws(() => readCurrent013Inputs(values), new RegExp(`${name} is required`));
  }
  for (const name of ['TIMELINE_CURRENT013_APP_TREE', 'TIMELINE_CURRENT013_AGENT_SHA', 'TIMELINE_CURRENT013_RUNTIME_SHA']) {
    assert.throws(() => readCurrent013Inputs({ ...env(), [name]: '2c4' }), /full 40-character/);
  }
});

test('refuses relative/absent source paths and caller dist overrides', () => {
  assert.throws(() => readCurrent013Inputs({ ...env(), ASTRID_CHECKOUT: '.' }), /absolute path/);
  assert.throws(() => readCurrent013Inputs({ ...env(), ASTRID_CHECKOUT: path.join(scratch, 'absent') }), /does not exist/);
  assert.throws(() => readCurrent013Inputs({ ...env(), ASTRID_APP_DIRECT_DIST: '/stale/dist' }), /ASTRID_APP_DIRECT_DIST is forbidden/);
});

test('preserves both symlinked venv entry points and their actual sys.prefix', async () => {
  const execFile = promisify(childProcess.execFile);
  const python = (await execFile('python3', ['-I', '-B', '-c', 'import sys; print(sys.executable)'])).stdout.trim();
  const values = env();
  for (const [name, label] of [['ASTRID_PYTHON', 'agent-venv'], ['ASTRID_RUNTIME_PYTHON', 'runtime-venv']]) {
    const venv = path.join(scratch, label);
    write(venv, 'pyvenv.cfg', `home = ${path.dirname(python)}\ninclude-system-site-packages = false\n`);
    mkdirSync(path.join(venv, 'bin'));
    values[name] = path.join(venv, 'bin/python');
    symlinkSync(python, values[name]);
    assert.notEqual(realpathSync(values[name]), values[name]);
  }
  const input = readCurrent013Inputs(values);
  for (const [name, key] of [['ASTRID_PYTHON', 'agentPython'], ['ASTRID_RUNTIME_PYTHON', 'runtimePython']]) {
    assert.equal(input[key], values[name]);
    const prefix = (await execFile(input[key], ['-I', '-B', '-c', 'import sys; print(sys.prefix)'])).stdout.trim();
    assert.equal(prefix, path.dirname(path.dirname(values[name])));
  }
});

test('Python inputs must be absolute executable files', () => {
  write(roots.app, 'not-executable', 'fixture');
  for (const name of ['ASTRID_PYTHON', 'ASTRID_RUNTIME_PYTHON']) {
    for (const [value, error] of [
      ['python3', /absolute path/], [roots.app, /must name a file/],
      [path.join(scratch, 'missing-python'), /must name a file/],
      [path.join(roots.app, 'not-executable'), /must be executable/],
    ]) assert.throws(() => readCurrent013Inputs({ ...env(), [name]: value }), error);
  }
});

test('same-tree snapshot and ignored output pass both boundaries; original command and inputs are forwarded', () => {
  controlled((calls) => {
    runCurrent013Integration();
    assert.equal(process.exitCode, 0);
    const child = calls.find(({ command }) => command === 'npm');
    assert.deepEqual(child.args, ['run', 'test:e2e:three-products']);
    assert.equal(child.options.cwd, roots.app);
    assert.equal(child.options.env.ASTRID_PYTHON, env().ASTRID_PYTHON);
    assert.equal(child.options.env.ASTRID_RUNTIME_PYTHON, env().ASTRID_RUNTIME_PYTHON);
    assert.equal(child.options.env.TIMELINE_BUNDLE_AGENT_HEAD, env().TIMELINE_CURRENT013_AGENT_SHA);
    assert.equal(child.options.env.TIMELINE_BUNDLE_RUNTIME_HEAD, CURRENT013_RUNTIME.serverCommit);
    assert.equal(calls.filter(({ root, op }) => root === roots.app && op?.startsWith('status ')).length, 2);
    assert.equal(calls.some(({ root, op }) => root === roots.app && op === 'rev-parse HEAD'), false);
  }, { mutate: () => write(roots.app, 'dist/ignored-output', 'normal build output') });
});

for (const status of [' M src/app/App.tsx', 'M  tests/e2e/local/three-products.spec.ts', '?? scripts/untracked.mjs']) {
  test(`refuses dirty App before delegation: ${status}`, () => {
    controlled((calls) => {
      assert.throws(() => checkCurrent013Sources(readCurrent013Inputs(env(), roots.app)), /App source is dirty/);
      assert.equal(calls.some(({ command }) => command), false);
    }, { dirty: status });
  });
}

test('postflight refuses App mutation even after a successful child', () => {
  controlled(() => assert.throws(() => runCurrent013Integration(), /App source is dirty/), {
    mutate: ({ dirtyApp }) => dirtyApp(' M scripts/helper.mjs'),
  });
});

test('child nonzero and null status remain failures after successful postflight', () => {
  for (const childStatus of [7, null]) controlled(() => {
    runCurrent013Integration();
    assert.equal(process.exitCode, childStatus ?? 1);
  }, { childStatus });
});

test('postflight metadata failure propagates, including when the child also fails', () => {
  const file = path.join(roots.app, 'src/integrations/runtime/generated-contract-metadata.ts');
  const original = readFileSync(file);
  try {
    controlled(() => assert.throws(() => runCurrent013Integration(), /App schema is .*expected/), {
      childStatus: 7,
      mutate: () => writeFileSync(file, original.toString().replace(CURRENT013_RUNTIME.schemaDigest, 'wrong')),
    });
  } finally { writeFileSync(file, original); }
});

test('postflight fingerprints refuse changed bytes even with unchanged metadata values', () => {
  const file = path.join(roots.app, 'runtime.lock.json');
  const original = readFileSync(file);
  try {
    controlled(() => assert.throws(() => runCurrent013Integration(), /source checks changed/), {
      mutate: () => writeFileSync(file, `${original}\n`),
    });
  } finally { writeFileSync(file, original); }
});

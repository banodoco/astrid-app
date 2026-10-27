import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createPinnedRepo, failure, fixture, observe, preparation, repo, terminalInterrupt } from './fixture.mjs';

async function scenario(fn) {
  const context = await fixture();
  try { await fn(context); } finally { await context.cleanup(); }
}
const run = (context, args = [], env = {}) => context.run('/bin/sh', [path.join(repo, 'public/install'), ...args], env);

test('POSIX explains first-run preparation before Python setup completes', () => scenario(async (context) => {
  const release = path.join(context.root, 'release-python');
  const child = await context.start('/bin/sh', [path.join(repo, 'public/install')], { MOCK_PYTHON_RELEASE: release });
  const output = observe(child);
  try {
    await output.until(preparation);
    assert.equal(child.exitCode, null);
  } finally { await writeFile(release, 'continue'); }
  assert.equal((await output.result).code, 0);
}));

test('POSIX uses developer manifest, the per-OS data layout (HOME-based on macOS, XDG on Linux), exact local commits and Python without external shims', () => scenario(async (context) => {
  context.manifest.agent.repo = path.join(context.root, 'source with spaces');
  context.manifest.runtime.repo = pathToFileURL(path.join(context.root, 'runtime source')).href;
  const committedSource = '# committed source\n';
  context.manifest.agent.sha = await createPinnedRepo(context.manifest.agent.repo, committedSource);
  await writeFile(path.join(context.manifest.agent.repo, 'source-marker.txt'), '# changed checkout source\n');
  const result = await run(context, ['--update', '--data-root', '/a path/with spaces', '--managed-by', 'pinokio', '--root', '/Pinokio Apps/Astrid']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${preparation}\nAstrid is ready.`);
  assert.equal(await readFile(context.env.MOCK_FETCHED, 'utf8'), context.env.ASTRID_INSTALL_MANIFEST_URL);
  const calls = await context.calls();
  assert.deepEqual(calls.find((args) => args[0] === 'python'), ['python', 'install', '3.11.13', '--no-bin']);
  const core = calls.at(-1);
  assert.deepEqual(core.slice(-7), ['--update', '--data-root', '/a path/with spaces', '--managed-by', 'pinokio', '--root', '/Pinokio Apps/Astrid']);
  assert.equal(calls.filter((args) => args[0] === 'pip').length, 1, 'bootstrap installs first-party packages once');
  assert.ok(calls.every((args) => !args.includes('--require-hashes')), 'bootstrap must not install third-party dependencies');
  const localInstall = calls.find((args) => args[0] === 'pip' && args.includes('--no-deps'));
  assert.ok(localInstall, 'pinned local packages must be installed without resolving dependencies');
  for (const name of ['runtime', 'agent']) {
    assert.ok(localInstall.includes(`git+${pathToFileURL(path.join(context.root, name === 'agent' ? 'source with spaces' : 'runtime source')).href}@${context.manifest[name].sha}`));
  }
  assert.ok(localInstall.some((arg) => arg.endsWith('#subdirectory=packages/python')), JSON.stringify(localInstall));
  assert.ok(!core.includes('--with'));
}));

for (const manifestFlag of ['--manifest', '--manifest=']) {
  test(`POSIX uses a supplied local manifest (${manifestFlag}) for bootstrap pins and core without downloading`, () => scenario(async (context) => {
    const localManifest = path.join(context.root, 'local manifest.json');
    const localPins = structuredClone(context.manifest);
    localPins.agent.sha = 'a'.repeat(40);
    localPins.runtime.sha = 'b'.repeat(40);
    await writeFile(localManifest, JSON.stringify(localPins));
    const supplied = manifestFlag === '--manifest' ? [manifestFlag, localManifest] : [`${manifestFlag}${localManifest}`];
    const managerArgs = ['--managed-by', 'pinokio', '--root', '/Pinokio Apps/Astrid'];
    const result = await run(context, [...managerArgs, ...supplied]);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(readFile(context.env.MOCK_FETCHED), { code: 'ENOENT' });
    const core = (await context.calls()).at(-1);
    assert.deepEqual(core.slice(-managerArgs.length - supplied.length), [...managerArgs, ...supplied]);
    assert.equal(core.filter((argument) => argument === '--manifest' || argument.startsWith('--manifest=')).length, 1);
    const localInstall = (await context.calls()).find((args) => args[0] === 'pip' && args.includes('--no-deps'));
    assert.ok(localInstall.includes(`https://github.com/banodoco/astrid-agent/archive/${localPins.agent.sha}.tar.gz`));
    assert.ok(localInstall.includes(`https://github.com/banodoco/astrid-runtime/archive/${localPins.runtime.sha}.tar.gz#subdirectory=packages/python`));
  }));
}

test('POSIX defaults to hosted manifest and pinned source archive URLs', () => scenario(async (context) => {
  const result = await run(context, [], { ASTRID_INSTALL_MANIFEST_URL: '' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(context.env.MOCK_FETCHED, 'utf8'), 'https://astrid.haus/install-manifest.json');
  const localInstall = (await context.calls()).find((args) => args[0] === 'pip' && args.includes('--no-deps'));
  for (const name of ['runtime', 'agent']) assert.ok(localInstall.includes(`https://github.com/banodoco/astrid-${name}/archive/${context.manifest[name].sha}.tar.gz`));
}));

test('POSIX bootstrap accepts unknown top-level manifest keys', () => scenario(async (context) => {
  context.manifest.release = 1;
  context.manifest.required = { release: 1, reason: 'Required update' };
  const result = await run(context);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await context.calls()).at(-1)[0], 'run');
}));

for (const repoValue of ['relative/path', '', null, 'https://example.com/source', 'file://remote/tmp/repo', 'file:///tmp/repo?branch=main', 'file:///tmp/repo#main', 'file://user@localhost/tmp/repo', 'file://localhost:123/tmp/repo', 'file://localhost:-1/tmp/repo', 'file://localhost']) {
  test(`POSIX rejects invalid developer source ${JSON.stringify(repoValue)} before core`, () => scenario(async (context) => {
    context.manifest.agent.repo = repoValue;
    const result = await run(context);
    assert.equal(result.code, 1);
    assert.equal((result.stderr.match(/Astrid couldn't finish\. Your work is kept\./g) || []).length, 1);
    assert.equal((await context.calls()).filter((args) => args.includes('--with')).length, 0);
  }));
}

test('POSIX rejects invalid commit pins before core', () => scenario(async (context) => {
  context.manifest.agent.sha = 'main';
  assert.equal((await run(context)).code, 1);
  assert.equal((await context.calls()).filter((args) => args.includes('--with')).length, 0);
}));

test('POSIX rejects a mismatching manifest tool pin', () => scenario(async (context) => {
  context.manifest.tools.uv.version = '0.8.22';
  assert.equal((await run(context)).code, 1);
  assert.equal((await context.calls()).filter((args) => args.includes('--with')).length, 0);
}));

for (const env of [{ MOCK_FETCH_EXIT: '7' }, { MOCK_PYTHON_EXIT: '17' }]) {
  test(`POSIX reports one pre-core failure for ${JSON.stringify(env)}`, () => scenario(async (context) => {
    const result = await run(context, [], env);
    assert.equal(result.code, 1);
    assert.equal((result.stderr.match(/Astrid couldn't finish\. Your work is kept\./g) || []).length, 1);
    assert.equal((result.stderr.match(/Details:/g) || []).length, 1);
  }));
}

test('POSIX preserves the core failure paragraph and nonzero status once', () => scenario(async (context) => {
  const result = await run(context, [], { MOCK_CORE_EXIT: '23' });
  assert.equal(result.code, 23);
  assert.equal((result.stdout.match(new RegExp(failure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
  assert.equal((result.stdout.match(/Details:/g) || []).length, 1);
  assert.doesNotMatch(result.stderr, /Astrid could not get ready/);
}));

test('POSIX preserves the installer low-space failure without adding a second error', () => scenario(async (context) => {
  const result = await run(context, [], { MOCK_CORE_DISK_FAILURE: '1' });
  assert.equal(result.code, 1);
  assert.equal((result.stdout.match(/Astrid couldn't finish\. Your work is kept\./g) || []).length, 1);
  assert.match(result.stdout, /Your work is kept\.\r?\nThere is not enough free disk space to back up your workspace\.\r?\nDetails:/);
  assert.equal((result.stdout.match(/Details:/g) || []).length, 1);
  assert.doesNotMatch(result.stderr, /Astrid could not get ready/);
}));

test('POSIX preserves success output when uninstall removes bootstrap', () => scenario(async (context) => {
  const result = await run(context, ['--uninstall'], { MOCK_REMOVE_BOOTSTRAP: '1' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${preparation}\nAstrid was uninstalled.`);
}));

test('POSIX also accepts uv version output without build metadata', () => scenario(async (context) => {
  const result = await run(context, [], { MOCK_UV_VERSION: 'uv 0.11.32' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${preparation}\nAstrid is ready.`);
}));

test('POSIX accepts localhost file URLs as local pinned repositories', () => scenario(async (context) => {
  const local = pathToFileURL(path.join(context.root, 'local source with spaces')).href;
  context.manifest.agent.repo = local.replace('file:///', 'file://localhost/');
  const committedSource = '# committed local source\n';
  context.manifest.agent.sha = await createPinnedRepo(path.join(context.root, 'local source with spaces'), committedSource);
  await writeFile(path.join(context.root, 'local source with spaces/source-marker.txt'), '# changed checkout source\n');
  const result = await run(context);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${preparation}\nAstrid is ready.`);
  const localInstall = (await context.calls()).find((args) => args[0] === 'pip' && args.includes('--no-deps'));
  assert.ok(localInstall.includes(`git+${local}@${context.manifest.agent.sha}`));
}));

test('POSIX streams an unbuffered installer stage before the transaction can finish', () => scenario(async (context) => {
  const release = path.join(context.root, 'release-stage');
  const child = await context.start('/bin/sh', [path.join(repo, 'public/install')], { MOCK_STAGE_RELEASE: release });
  const output = observe(child);
  try {
    await output.until('Installing Astrid.');
    assert.equal(child.exitCode, null);
  } finally { await writeFile(release, 'continue'); }
  const result = await output.result;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Astrid is ready\./);
  assert.ok((await context.calls()).at(-1).includes('-u'));
}));

test('POSIX keeps the log directory private, even when it already exists with looser permissions', () => scenario(async (context) => {
  const logDirectory = path.dirname(context.env.MOCK_LOG);
  await mkdir(logDirectory, { recursive: true });
  await chmod(logDirectory, 0o755);
  const result = await run(context, []);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await stat(logDirectory)).mode & 0o777, 0o700);
}));

test('POSIX preserves a native core exit code without the core failure paragraph', () => scenario(async (context) => {
  const result = await run(context, [], { MOCK_CORE_RAW_EXIT: '27' });
  assert.equal(result.code, 27);
  assert.equal((result.stderr.match(/Astrid couldn't finish\. Your work is kept\./g) || []).length, 1);
  assert.equal((result.stderr.match(/Details:/g) || []).length, 1);
  assert.match(await readFile(context.env.MOCK_LOG, 'utf8'), /raw core diagnostic/);
}));

test('POSIX terminal Ctrl+C reaches the installer and waits for cooperative recovery', () => scenario(async (context) => {
  const receipt = path.join(context.root, 'interrupted');
  const result = await context.run('python3', ['-c', terminalInterrupt, '/bin/sh', path.join(repo, 'public/install')], {
    MOCK_STAGE_RELEASE: path.join(context.root, 'never-release'), MOCK_INTERRUPTED: receipt,
  }, 120_000);
  assert.equal(result.code, 0, result.stderr);
  const terminal = JSON.parse(result.stdout);
  assert.equal(terminal.interrupted, true);
  assert.equal(terminal.code, 19, terminal.output);
  assert.match(await readFile(receipt, 'utf8'), /KeyboardInterrupt reached installer/);
  assert.equal(terminal.output.split(failure).length - 1, 1);
  assert.equal((terminal.output.match(/Details:/g) || []).length, 1);
  assert.doesNotMatch(terminal.output, /Astrid could not get ready/);
}));

test('POSIX piped bootstrap preserves terminal stdin for uv cancellation', () => scenario(async (context) => {
  const receipt = path.join(context.root, 'interrupted');
  const result = await context.run('python3', ['-c', terminalInterrupt, '/bin/bash', '--noprofile', '--norc', '-i', '-c', 'cat "$1" | sh', 'piped-installer', path.join(repo, 'public/install')], {
    MOCK_STAGE_RELEASE: path.join(context.root, 'never-release'), MOCK_INTERRUPTED: receipt, MOCK_REQUIRE_TTY: '1',
  }, 120_000);
  assert.equal(result.code, 0, result.stderr);
  const terminal = JSON.parse(result.stdout);
  assert.equal(terminal.interrupted, true);
  assert.equal(terminal.code, 19, terminal.output);
  assert.match(await readFile(receipt, 'utf8'), /KeyboardInterrupt reached installer/);
  assert.equal(terminal.output.split(failure).length - 1, 1);
  assert.equal((terminal.output.match(/Details:/g) || []).length, 1);
}));

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createLocalUpdater,
  installPreparedResources,
  restorePreparedResources,
  validateAppContext,
} from './local-update-runner.mjs';

const OLD_SHA = '1'.repeat(40);
const TARGET_SHA = '2'.repeat(40);
const manifest = { release: 2 };

async function tempRoot(prefix = 'astrid-runner-test-') {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  return { cwd, close: () => rm(cwd, { recursive: true, force: true }) };
}

async function createApp(t, cwd, { previous = true, symlinked = false } = {}) {
  const preparationRoot = await mkdtemp(join(tmpdir(), 'astrid-app-update-runner-'));
  t.after(() => rm(preparationRoot, { recursive: true, force: true }));
  const worktree = join(preparationRoot, 'checkout');
  const buildDir = join(worktree, 'dist');
  const dependenciesDir = join(worktree, 'node_modules');
  await mkdir(buildDir, { recursive: true });
  await mkdir(dependenciesDir, { recursive: true });
  await writeFile(join(buildDir, 'candidate.txt'), 'new build');
  await writeFile(join(dependenciesDir, 'candidate.txt'), 'new dependencies');
  if (previous) {
    if (symlinked) {
      const oldDist = join(preparationRoot, 'old-dist-target');
      const oldDependencies = join(preparationRoot, 'old-node-modules-target');
      await mkdir(oldDist); await mkdir(oldDependencies);
      await writeFile(join(oldDist, 'old.txt'), 'old build');
      await writeFile(join(oldDependencies, 'old.txt'), 'old dependencies');
      await symlink(oldDist, join(cwd, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
      await symlink(oldDependencies, join(cwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      await mkdir(join(cwd, 'dist'), { recursive: true });
      await mkdir(join(cwd, 'node_modules'), { recursive: true });
      await writeFile(join(cwd, 'dist', 'old.txt'), 'old build');
      await writeFile(join(cwd, 'node_modules', 'old.txt'), 'old dependencies');
    }
  }
  return {
    cwd,
    oldSha: OLD_SHA,
    targetSha: TARGET_SHA,
    release: 2,
    manifest,
    preparationRoot,
    worktree,
    buildDir,
    dependenciesDir,
    oldBuildExisted: previous,
    oldDependenciesExisted: previous,
    previousMode: 'local',
    previousPreviewDirectory: join(cwd, 'dist'),
  };
}

test('resource swap retains the prior build and dependencies, including symlinks, until restore', async (t) => {
  const root = await tempRoot(); t.after(root.close);
  const app = await createApp(t, root.cwd, { symlinked: true });
  validateAppContext(app, root.cwd);
  await installPreparedResources(app);
  assert.equal((await lstat(join(root.cwd, 'dist'))).isSymbolicLink(), false);
  assert.equal((await lstat(join(root.cwd, 'node_modules'))).isSymbolicLink(), false);
  assert.equal(await readFile(join(root.cwd, 'dist', 'candidate.txt'), 'utf8'), 'new build');
  assert.equal(await readFile(join(root.cwd, 'node_modules', 'candidate.txt'), 'utf8'), 'new dependencies');
  assert.equal((await lstat(join(app.preparationRoot, 'previous-dist'))).isSymbolicLink(), true);
  assert.equal((await lstat(join(app.preparationRoot, 'previous-node_modules'))).isSymbolicLink(), true);
  assert.equal(await readFile(join(app.preparationRoot, 'previous-dist', 'old.txt'), 'utf8'), 'old build');
  await restorePreparedResources(app);
  assert.equal((await lstat(join(root.cwd, 'dist'))).isSymbolicLink(), true);
  assert.equal((await lstat(join(root.cwd, 'node_modules'))).isSymbolicLink(), true);
  assert.equal(await readlink(join(root.cwd, 'dist')), join(app.preparationRoot, 'old-dist-target'));
  assert.equal(await readFile(join(root.cwd, 'dist', 'old.txt'), 'utf8'), 'old build');
  assert.equal(await readFile(join(root.cwd, 'node_modules', 'old.txt'), 'utf8'), 'old dependencies');
});

test('restore removes newly installed resources when there was no prior build or node_modules', async (t) => {
  const root = await tempRoot(); t.after(root.close);
  const app = await createApp(t, root.cwd, { previous: false });
  await installPreparedResources(app);
  assert.equal(await readFile(join(root.cwd, 'dist', 'candidate.txt'), 'utf8'), 'new build');
  await restorePreparedResources(app);
  await assert.rejects(lstat(join(root.cwd, 'dist')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(root.cwd, 'node_modules')), { code: 'ENOENT' });
});

test('recovery runs before target selection, and a completed recovery stops this invocation', async (t) => {
  const root = await tempRoot(); t.after(root.close);
  const calls = [];
  const updater = createLocalUpdater({
    cwd: root.cwd,
    backend: { root: root.cwd },
    editor: {},
    session: {},
    backendUpdate: async ({ action }) => { calls.push(action.action); return { status: 'recovered' }; },
    selectTarget: async () => { calls.push('select'); throw new Error('must not select after recovery'); },
  });
  const result = await updater();
  assert.deepEqual(calls, ['recover']);
  assert.equal(result.status, 'recovered');
});

test('normal recovery check precedes selection and an up-to-date result is a no-op', async (t) => {
  const root = await tempRoot(); t.after(root.close);
  const calls = [];
  const updater = createLocalUpdater({
    cwd: root.cwd,
    backend: { root: root.cwd },
    editor: {},
    session: {},
    backendUpdate: async ({ action }) => { calls.push(`backend:${action.action}`); return { status: 'clean' }; },
    selectTarget: async () => { calls.push('select'); return { upToDate: true }; },
    preflight: async () => { calls.push('preflight'); },
    prepare: async () => { calls.push('prepare'); },
  });
  const result = await updater();
  assert.deepEqual(calls, ['backend:recover', 'select']);
  assert.equal(result.status, 'up-to-date');
});

test('backend transaction hooks run in order and retain the old build through verification', async (t) => {
  const root = await tempRoot(); t.after(root.close);
  const events = [];
  const appBase = await createApp(t, root.cwd);
  const prepared = { ...appBase };
  const editor = {
    mode: 'local', previewDirectory: join(root.cwd, 'dist'),
    stop: async () => { events.push('editor.stop'); },
    start: async ({ rollback }) => { events.push(`editor.start:${rollback}`); },
    verify: async () => {
      events.push('editor.verify');
      assert.equal(await readFile(join(root.cwd, 'dist', 'candidate.txt'), 'utf8'), 'new build');
      assert.equal(await readFile(join(appBase.preparationRoot, 'previous-dist', 'old.txt'), 'utf8'), 'old build');
    },
  };
  const session = {
    begin: async () => { events.push('session.begin'); },
    end: async () => { events.push('session.end'); },
  };
  let releaseCalls = 0;
  const updater = createLocalUpdater({
    cwd: root.cwd, backend: { root: root.cwd }, editor, session,
    backendUpdate: async ({ action, hook }) => {
      events.push(`backend:${action.action}`);
      if (action.action === 'recover') return { status: 'clean' };
      for (const name of ['stop-editor', 'move-checkout', 'start-editor', 'verify-editor', 'release-app']) {
        await hook({ hook: name, app: action.app, version: { release: 2 } });
      }
      return { status: 'complete' };
    },
    selectTarget: async () => { events.push('select'); return { ...manifest, manifest, oldSha: OLD_SHA, targetSha: TARGET_SHA, release: 2, upToDate: false }; },
    preflight: async () => { events.push('preflight'); },
    prepare: async () => prepared,
    move: async () => { events.push('move'); },
    release: async ({ state }) => { events.push('release'); releaseCalls += 1; assert.equal(state.targetSha, TARGET_SHA); },
  });
  const result = await updater();
  assert.deepEqual(events, [
    'backend:recover', 'select', 'preflight', 'backend:update', 'session.begin', 'editor.stop',
    'move', 'editor.start:false', 'editor.verify', 'session.end', 'release',
  ]);
  assert.equal(releaseCalls, 1);
  assert.equal(result.status, 'updated');
});

test('failed transaction with a pending journal retains its worktree and prior resources for recovery', async (t) => {
  const root = await tempRoot(); t.after(root.close);
  const events = [];
  const prepared = await createApp(t, root.cwd);
  const editor = {
    mode: 'local', previewDirectory: join(root.cwd, 'dist'),
    stop: async () => { events.push('stop'); },
    start: async () => { events.push('start'); throw new Error('candidate did not start'); },
    verify: async () => { events.push('verify'); },
  };
  let ended = 0;
  let released = 0;
  const updater = createLocalUpdater({
    cwd: root.cwd, backend: { root: root.cwd }, editor,
    session: { begin: async () => {}, end: async () => { ended += 1; } },
    backendUpdate: async ({ action, hook }) => {
      if (action.action === 'recover') return { status: 'clean' };
      await hook({ hook: 'stop-editor', app: action.app });
      await hook({ hook: 'move-checkout', app: action.app });
      await writeFile(join(root.cwd, 'update-transaction.json'), JSON.stringify({ step: 'applying' }));
      await hook({ hook: 'start-editor', app: action.app });
    },
    selectTarget: async () => ({ manifest, oldSha: OLD_SHA, targetSha: TARGET_SHA, release: 2, upToDate: false }),
    preflight: async () => {},
    prepare: async () => prepared,
    move: async () => {},
    release: async () => { released += 1; },
  });
  await assert.rejects(updater(), /candidate did not start/);
  assert.deepEqual(events, ['stop', 'start']);
  assert.equal(ended, 0);
  assert.equal(released, 0);
  assert.equal(JSON.parse(await readFile(join(root.cwd, 'update-transaction.json'), 'utf8')).step, 'applying');
  assert.equal(await readFile(join(root.cwd, 'dist', 'candidate.txt'), 'utf8'), 'new build');
  assert.equal(await readFile(join(prepared.preparationRoot, 'previous-dist', 'old.txt'), 'utf8'), 'old build');
  assert.equal(await readFile(join(root.cwd, 'node_modules', 'candidate.txt'), 'utf8'), 'new dependencies');
  assert.equal(await readFile(join(prepared.preparationRoot, 'previous-node_modules', 'old.txt'), 'utf8'), 'old dependencies');
});

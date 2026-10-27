import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  moveCheckout,
  preflightUpdate,
  prepareUpdate,
  releasePreparation,
  restoreCheckout,
  selectUpdateTarget,
  UpdateError,
} from './local-update-checkout.mjs';

const execFileAsync = promisify(execFile);
const git = async (cwd, ...args) => {
  const { stdout = '', stderr = '' } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return { stdout: stdout.trimEnd(), stderr };
};
const sha = async (cwd, ref = 'HEAD') => (await git(cwd, 'rev-parse', ref)).stdout;
const write = async (root, path, contents) => {
  const absolute = join(root, path);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, contents);
};

async function fixture({ files = { 'README.md': 'base\n', 'public/install-manifest.json': '{"release":1}\n' } } = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'astrid-checkout-test-'));
  const remote = join(parent, 'origin.git');
  const seed = join(parent, 'seed');
  const cwd = join(parent, 'checkout');
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remote]);
  await execFileAsync('git', ['init', '--initial-branch=main', seed]);
  await git(seed, 'config', 'user.name', 'Checkout Test');
  await git(seed, 'config', 'user.email', 'checkout-test@example.invalid');
  for (const [path, contents] of Object.entries(files)) await write(seed, path, contents);
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'base');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', '-u', 'origin', 'main');
  await execFileAsync('git', ['clone', remote, cwd]);
  await git(cwd, 'config', 'user.name', 'Checkout Test');
  await git(cwd, 'config', 'user.email', 'checkout-test@example.invalid');
  const oldSha = await sha(cwd);

  async function commitRemote(changes, message = 'release') {
    for (const [path, contents] of Object.entries(changes)) {
      if (contents === null) await unlink(join(seed, path));
      else await write(seed, path, contents);
    }
    await git(seed, 'add', '-A');
    await git(seed, 'commit', '-m', message);
    await git(seed, 'push', 'origin', 'main');
    return sha(seed);
  }

  async function close() { await rm(parent, { recursive: true, force: true }); }
  return { parent, remote, seed, cwd, oldSha, commitRemote, close };
}

async function candidate(f, changes = { 'released.txt': 'release\n', 'public/install-manifest.json': '{"release":2}\n' }) {
  const targetSha = await f.commitRemote(changes);
  await git(f.cwd, 'fetch', '--no-tags', 'origin', 'main');
  const mainSha = await sha(f.cwd, 'origin/main');
  const manifest = JSON.parse((await git(f.cwd, 'show', `${targetSha}:public/install-manifest.json`)).stdout);
  return { oldSha: f.oldSha, targetSha, mainSha, release: manifest.release, manifest, launcherChanged: false };
}

const buildRequest = (app, release = 2, onRequest = () => {}) => async (url, options) => {
  onRequest(url, options);
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ app, release }) };
};

test('selects the served build once, fetches origin once, and freezes the manifest at that SHA', async (t) => {
  const f = await fixture(); t.after(f.close);
  const targetSha = await f.commitRemote({ 'released.txt': 'release\n', 'public/install-manifest.json': '{"release":2}\n' });
  let requests = 0;
  const calls = [];
  const runGit = async ({ cwd, args }) => { calls.push(args); return git(cwd, ...args); };
  const target = await selectUpdateTarget({ cwd: f.cwd, request: buildRequest(targetSha, 2, () => { requests += 1; }), runGit });
  assert.equal(requests, 1);
  assert.equal(calls.filter((args) => args[0] === 'fetch').length, 1);
  assert.equal(target.targetSha, targetSha);
  assert.equal(target.release, 2);
  assert.deepEqual(target.manifest, { release: 2 });
  assert.equal(Object.isFrozen(target.manifest), true);
  assert.equal(target.mainSha, targetSha);
});

test('select reports up to date when local HEAD is the served public-main commit', async (t) => {
  const f = await fixture(); t.after(f.close);
  const targetSha = await f.commitRemote({ 'released.txt': 'release\n', 'public/install-manifest.json': '{"release":2}\n' });
  await git(f.cwd, 'fetch', '--no-tags', 'origin', 'main');
  await git(f.cwd, 'merge', '--ff-only', targetSha);
  let requestCount = 0;
  const selected = await selectUpdateTarget({ cwd: f.cwd, request: buildRequest(targetSha, 2, () => { requestCount += 1; }) });
  assert.equal(requestCount, 1);
  assert.equal(selected.oldSha, targetSha);
  assert.equal(selected.upToDate, true);
});

test('select treats a local public-main checkout ahead of the served target as up to date', async (t) => {
  const f = await fixture(); t.after(f.close);
  const servedSha = await f.commitRemote({ 'released.txt': 'served release\n', 'public/install-manifest.json': '{"release":2}\n' });
  await git(f.cwd, 'fetch', '--no-tags', 'origin', 'main');
  await git(f.cwd, 'merge', '--ff-only', servedSha);
  const mainSha = await f.commitRemote({ 'later.txt': 'later public-main commit\n', 'public/install-manifest.json': '{"release":3}\n' });
  const selected = await selectUpdateTarget({ cwd: f.cwd, request: buildRequest(servedSha, 2) });
  assert.equal(selected.targetSha, servedSha);
  assert.equal(selected.oldSha, servedSha);
  assert.equal(selected.mainSha, mainSha);
  assert.equal(selected.upToDate, true);
});

test('select marks a changed loaded local launcher helper for a convenient restart', async (t) => {
  const f = await fixture({ files: {
    'README.md': 'base\n',
    'public/install-manifest.json': '{"release":1}\n',
    'scripts/local-update-control.mjs': 'old loaded helper\n',
  } }); t.after(f.close);
  const targetSha = await f.commitRemote({
    'public/install-manifest.json': '{"release":2}\n',
    'scripts/local-update-control.mjs': 'new loaded helper\n',
  });
  const selected = await selectUpdateTarget({ cwd: f.cwd, request: buildRequest(targetSha, 2) });
  assert.equal(selected.launcherChanged, true);
});

test('refuses private commits before asking whether HEAD contains the served target', async (t) => {
  const f = await fixture(); t.after(f.close);
  const targetSha = await f.commitRemote({ 'released.txt': 'release\n', 'public/install-manifest.json': '{"release":2}\n' });
  await write(f.cwd, 'private.txt', 'private\n');
  await git(f.cwd, 'add', 'private.txt');
  await git(f.cwd, 'commit', '-m', 'private local commit');
  const calls = [];
  const runGit = async ({ cwd, args }) => { calls.push(args); return git(cwd, ...args); };
  await assert.rejects(
    selectUpdateTarget({ cwd: f.cwd, request: buildRequest(targetSha), runGit }),
    (error) => error instanceof UpdateError && error.code === 'private_commits',
  );
  const privateCount = calls.findIndex((args) => args[0] === 'rev-list');
  const currentSha = await sha(f.cwd);
  const targetInHead = calls.findIndex((args) => args[0] === 'merge-base' && args[1] === '--is-ancestor' && args[2] === targetSha && args[3] === currentSha);
  assert.notEqual(privateCount, -1);
  assert.equal(targetInHead, -1);
});

test('preflight and fast-forward preserve unrelated staged, unstaged, and untracked edits', async (t) => {
  const f = await fixture({ files: { 'README.md': 'base\n', 'public/install-manifest.json': '{"release":1}\n', 'tracked.txt': 'original\n' } }); t.after(f.close);
  const target = await candidate(f);
  await write(f.cwd, 'staged.txt', 'staged\n');
  await git(f.cwd, 'add', 'staged.txt');
  const stagedBefore = (await git(f.cwd, 'diff', '--cached', '--name-status')).stdout;
  await write(f.cwd, 'tracked.txt', 'unstaged\n');
  await write(f.cwd, 'untracked/deep.txt', 'untracked\n');
  const result = await preflightUpdate({ cwd: f.cwd, targetSha: target.targetSha, oldSha: target.oldSha, mainSha: target.mainSha });
  assert.deepEqual(result.conflicts, []);
  const moved = await moveCheckout({ cwd: f.cwd, state: { cwd: f.cwd, ...target } });
  assert.equal(moved.moved, true);
  assert.equal(await sha(f.cwd), target.targetSha);
  assert.equal(await readFile(join(f.cwd, 'staged.txt'), 'utf8'), 'staged\n');
  assert.equal(await readFile(join(f.cwd, 'tracked.txt'), 'utf8'), 'unstaged\n');
  assert.equal(await readFile(join(f.cwd, 'untracked/deep.txt'), 'utf8'), 'untracked\n');
  assert.equal((await git(f.cwd, 'diff', '--cached', '--name-status')).stdout, stagedBefore);
  assert.match((await git(f.cwd, 'diff', '--cached', '--', 'staged.txt')).stdout, /staged/);
});

test('preflight directly refuses a diverged history as non-fast-forward', async (t) => {
  const f = await fixture(); t.after(f.close);
  const target = await candidate(f);
  await write(f.cwd, 'private-branch.txt', 'local divergence\n');
  await git(f.cwd, 'add', 'private-branch.txt');
  await git(f.cwd, 'commit', '-m', 'local divergence');
  const localSha = await sha(f.cwd);
  await assert.rejects(
    preflightUpdate({ cwd: f.cwd, targetSha: target.targetSha, oldSha: localSha, mainSha: target.mainSha }),
    (error) => error instanceof UpdateError && error.code === 'non_fast_forward',
  );
  assert.equal(await sha(f.cwd), localSha);
});

const conflictCases = [
  {
    name: 'incoming add',
    changes: { 'local.txt': 'from origin\n', 'public/install-manifest.json': '{"release":2}\n' },
    local: async (cwd) => write(cwd, 'local.txt', 'untracked local\n'),
    expected: 'local.txt',
  },
  {
    name: 'incoming delete',
    initial: { 'README.md': 'base\n', 'public/install-manifest.json': '{"release":1}\n', 'removed.txt': 'base\n' },
    changes: { 'removed.txt': null, 'public/install-manifest.json': '{"release":2}\n' },
    local: async (cwd) => { await write(cwd, 'removed.txt', 'local edit\n'); await git(cwd, 'add', 'removed.txt'); },
    expected: 'removed.txt',
  },
  {
    name: 'incoming rename destination',
    initial: { 'README.md': 'base\n', 'public/install-manifest.json': '{"release":1}\n', 'before.txt': 'rename me\n' },
    changes: { 'before.txt': null, 'after.txt': 'rename me\n', 'public/install-manifest.json': '{"release":2}\n' },
    local: async (cwd) => write(cwd, 'after.txt', 'local collision\n'),
    expected: 'after.txt',
  },
  {
    name: 'file-directory collision',
    changes: { 'folder': 'incoming file\n', 'public/install-manifest.json': '{"release":2}\n' },
    local: async (cwd) => write(cwd, 'folder/child.txt', 'local child\n'),
    expected: 'folder',
  },
  {
    name: 'directory-file collision',
    initial: { 'README.md': 'base\n', 'public/install-manifest.json': '{"release":1}\n', 'node': 'base file\n' },
    changes: { 'node': null, 'node/child.txt': 'incoming child\n', 'public/install-manifest.json': '{"release":2}\n' },
    local: async (cwd) => { await git(cwd, 'rm', 'node'); await mkdir(join(cwd, 'node')); await write(cwd, 'node/local.txt', 'local child\n'); },
    expected: 'node/child.txt',
  },
];

for (const item of conflictCases) {
  test(`preflight refuses ${item.name} conflicts`, async (t) => {
    const f = await fixture({ ...(item.initial ? { files: item.initial } : {}) }); t.after(f.close);
    const target = await candidate(f, item.changes);
    await item.local(f.cwd);
    await assert.rejects(
      preflightUpdate({ cwd: f.cwd, targetSha: target.targetSha, oldSha: target.oldSha, mainSha: target.mainSha }),
      (error) => error instanceof UpdateError && error.code === 'local_edits_conflict' && error.message.includes(item.expected),
    );
    assert.equal(await sha(f.cwd), target.oldSha);
  });
}

test('prepare builds the exact candidate in a retained, JSON-serializable worktree', async (t) => {
  const f = await fixture(); t.after(f.close);
  const target = await candidate(f);
  const before = await sha(f.cwd);
  const commands = [];
  const environment = { ...process.env, VITE_APP_BUILD: 'inherited-old-sha', RAILWAY_GIT_COMMIT_SHA: 'inherited-old-sha' };
  const selectedNode = join(tmpdir(), 'node-from-updated-backend');
  const state = await prepareUpdate({
    cwd: f.cwd,
    target,
    environment,
    execPath: selectedNode,
    runCommand: async (command, args, options) => {
      commands.push({ command, args, cwd: options.cwd, step: options.step, env: options.env });
      if (options.step === 'prepare-build') {
        await mkdir(join(options.cwd, 'dist'), { recursive: true });
        await writeFile(join(options.cwd, 'dist/build.json'), JSON.stringify({ app: target.targetSha, release: target.release }));
      }
    },
  });
  assert.deepEqual(commands.map(({ step }) => step), ['prepare-install', 'prepare-build']);
  assert.match(commands[0].args.join(' '), /npm-cli\.js ci/);
  assert.match(commands[1].args.join(' '), /npm-cli\.js run build/);
  assert.equal(commands[0].cwd, state.worktree);
  assert.equal(commands[1].cwd, state.worktree);
  assert.equal(commands[0].command, selectedNode);
  assert.equal(commands[1].command, selectedNode);
  assert.equal(commands[0].env.VITE_APP_BUILD, target.targetSha);
  assert.equal(commands[0].env.RAILWAY_GIT_COMMIT_SHA, target.targetSha);
  assert.equal(commands[0].env, commands[1].env);
  assert.equal(JSON.parse(JSON.stringify(state)).targetSha, target.targetSha);
  assert.equal(JSON.parse(await readFile(join(state.buildDir, 'build.json'), 'utf8')).app, target.targetSha);
  assert.equal(await sha(f.cwd), before);
  assert.ok((await git(f.cwd, 'worktree', 'list', '--porcelain')).stdout.includes(state.worktree));
  await releasePreparation({ cwd: f.cwd, state });
});

test('prepare failure removes only its candidate and leaves the active checkout untouched', async (t) => {
  const f = await fixture(); t.after(f.close);
  const target = await candidate(f);
  const before = await sha(f.cwd);
  await assert.rejects(
    prepareUpdate({ cwd: f.cwd, target, runCommand: async (_command, _args, options) => {
      if (options.step === 'prepare-build') {
        await mkdir(join(options.cwd, 'dist'), { recursive: true });
        await writeFile(join(options.cwd, 'dist/build.json'), JSON.stringify({ app: 'wrong', release: target.release }));
      }
    } }),
    (error) => error instanceof UpdateError && error.step === 'prepare-build' && error.code === 'prepare_build_failed',
  );
  assert.equal(await sha(f.cwd), before);
  assert.equal((await git(f.cwd, 'status', '--porcelain')).stdout, '');
  assert.equal((await git(f.cwd, 'worktree', 'list', '--porcelain')).stdout.split('worktree ').length, 2);
});

test('npm ci failure cleans its worktree and leaves the active checkout unchanged', async (t) => {
  const f = await fixture(); t.after(f.close);
  const target = await candidate(f);
  const before = await sha(f.cwd);
  await assert.rejects(
    prepareUpdate({ cwd: f.cwd, target, runCommand: async () => { throw new Error('fixture npm ci failure'); } }),
    (error) => error instanceof UpdateError && error.step === 'prepare-install' && error.code === 'prepare_install_failed',
  );
  assert.equal(await sha(f.cwd), before);
  assert.equal((await git(f.cwd, 'status', '--porcelain')).stdout, '');
  assert.equal((await git(f.cwd, 'worktree', 'list', '--porcelain')).stdout.split('worktree ').length, 2);
});

test('move rechecks local edits immediately before changing HEAD', async (t) => {
  const f = await fixture(); t.after(f.close);
  const target = await candidate(f);
  const state = await prepareUpdate({
    cwd: f.cwd,
    target,
    runCommand: async (_command, _args, options) => {
      if (options.step === 'prepare-build') {
        await mkdir(join(options.cwd, 'dist'), { recursive: true });
        await writeFile(join(options.cwd, 'dist/build.json'), JSON.stringify({ app: target.targetSha, release: target.release }));
      }
    },
  });
  await write(f.cwd, 'released.txt', 'changed after prepare\n');
  await assert.rejects(moveCheckout({ cwd: f.cwd, state }), (error) => error instanceof UpdateError && error.code === 'local_edits_conflict');
  assert.equal(await sha(f.cwd), target.oldSha);
  await releasePreparation({ cwd: f.cwd, state });
});

test('restore returns the checkout to its prior commit with reset --keep', async (t) => {
  const f = await fixture(); t.after(f.close);
  const target = await candidate(f);
  const preparationRoot = await mkdtemp(join(tmpdir(), 'astrid-app-update-restore-'));
  const state = { cwd: f.cwd, preparationRoot, ...target };
  await write(f.cwd, 'staged.txt', 'staged before move\n');
  await git(f.cwd, 'add', 'staged.txt');
  const stagedBefore = (await git(f.cwd, 'diff', '--cached', '--name-status')).stdout;
  await moveCheckout({ cwd: f.cwd, state });
  assert.equal((await git(f.cwd, 'diff', '--cached', '--name-status')).stdout, stagedBefore);
  await write(f.cwd, 'unrelated.txt', 'keep during restore\n');
  const restored = await restoreCheckout({ cwd: f.cwd, state });
  assert.equal(restored.restored, true);
  assert.equal(await sha(f.cwd), target.oldSha);
  assert.equal(await readFile(join(f.cwd, 'unrelated.txt'), 'utf8'), 'keep during restore\n');
  assert.equal((await git(f.cwd, 'diff', '--cached', '--name-status')).stdout, stagedBefore);
  await rm(preparationRoot, { recursive: true, force: true });
});

test('restore refuses to reset a commit created after the update moved', async (t) => {
  const f = await fixture(); t.after(f.close);
  const target = await candidate(f);
  const preparationRoot = await mkdtemp(join(tmpdir(), 'astrid-app-update-race-'));
  const state = { cwd: f.cwd, preparationRoot, ...target };
  await moveCheckout({ cwd: f.cwd, state });
  await write(f.cwd, 'user-commit.txt', 'keep user commit\n');
  await git(f.cwd, 'add', 'user-commit.txt');
  await git(f.cwd, 'commit', '-m', 'user commit during activation');
  const racedSha = await sha(f.cwd);
  await assert.rejects(
    restoreCheckout({ cwd: f.cwd, state }),
    (error) => error instanceof UpdateError && error.code === 'checkout_changed',
  );
  assert.equal(await sha(f.cwd), racedSha);
  assert.equal(await readFile(join(f.cwd, 'user-commit.txt'), 'utf8'), 'keep user commit\n');
  await rm(preparationRoot, { recursive: true, force: true });
});

test('restore refuses rollback when a new staged edit appeared after activation', async (t) => {
  const f = await fixture(); t.after(f.close);
  const target = await candidate(f);
  const preparationRoot = await mkdtemp(join(tmpdir(), 'astrid-app-update-late-stage-'));
  const state = { cwd: f.cwd, preparationRoot, ...target };
  await moveCheckout({ cwd: f.cwd, state });
  await write(f.cwd, 'late-stage.txt', 'staged content unavailable in worktree\n');
  await git(f.cwd, 'add', 'late-stage.txt');
  await write(f.cwd, 'late-stage.txt', 'later unstaged content\n');
  const stagedBlob = (await git(f.cwd, 'show', ':late-stage.txt')).stdout;
  const stagedSummary = (await git(f.cwd, 'diff', '--cached', '--name-status')).stdout;
  await assert.rejects(
    restoreCheckout({ cwd: f.cwd, state }),
    (error) => error instanceof UpdateError && error.code === 'checkout_changed',
  );
  assert.equal(await sha(f.cwd), target.targetSha);
  assert.equal((await git(f.cwd, 'show', ':late-stage.txt')).stdout, stagedBlob);
  assert.equal((await git(f.cwd, 'diff', '--cached', '--name-status')).stdout, stagedSummary);
  assert.equal(await readFile(join(f.cwd, 'late-stage.txt'), 'utf8'), 'later unstaged content\n');
  await rm(preparationRoot, { recursive: true, force: true });
});

test('restore recovers the original staged index if activation stopped before saving its post-move tree', async (t) => {
  const f = await fixture(); t.after(f.close);
  const target = await candidate(f);
  const preparationRoot = await mkdtemp(join(tmpdir(), 'astrid-app-update-index-crash-'));
  const state = { cwd: f.cwd, preparationRoot, ...target };
  await write(f.cwd, 'staged.txt', 'staged before move\n');
  await git(f.cwd, 'add', 'staged.txt');
  const stagedBefore = (await git(f.cwd, 'diff', '--cached', '--name-status')).stdout;
  await moveCheckout({ cwd: f.cwd, state });
  await rm(join(preparationRoot, 'post-update-index-tree'));
  await restoreCheckout({ cwd: f.cwd, state });
  assert.equal(await sha(f.cwd), target.oldSha);
  assert.equal((await git(f.cwd, 'diff', '--cached', '--name-status')).stdout, stagedBefore);
  await rm(preparationRoot, { recursive: true, force: true });
});

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { packageManagerInvocation } from './node-package-manager.mjs';

const execFileAsync = promisify(execFile);
const BUILD_URL = 'https://astrid.haus/build.json';
const MAX_BUILD_JSON = 16_384;
const SHA_RE = /^[0-9a-f]{40}$/i;
const PRIVATE_COMMITS_MESSAGE = 'This checkout has commits that are not on origin/main. Push or preserve those commits in another checkout, then retry the Astrid update.';
const freezeJson = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
};

export class UpdateError extends Error {
  constructor(step, message, options = {}) {
    super(message, options);
    this.name = 'UpdateError';
    this.step = step;
    this.code = options.code ?? 'update_failed';
  }
}

function updateError(step, message, code, cause) {
  return new UpdateError(step, message, { code, ...(cause ? { cause } : {}) });
}

async function git(cwd, args, runGit) {
  if (runGit) return runGit({ cwd, args });
  const { stdout = '', stderr = '' } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return { stdout, stderr };
}

function stdoutOf(result) {
  if (typeof result === 'string') return result;
  return result?.stdout ?? '';
}

async function gitText(cwd, args, runGit) {
  return stdoutOf(await git(cwd, args, runGit));
}

async function isAncestor(cwd, ancestor, descendant, runGit) {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], runGit);
    return true;
  } catch (error) {
    if (error?.code === 1 || error?.exitCode === 1) return false;
    // Test and injected runners may expose Git's status in a structured result.
    if (error?.status === 1) return false;
    throw error;
  }
}

async function fetchBuild(request) {
  let response;
  try {
    response = await request(BUILD_URL, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    throw updateError('select-target', `Could not fetch ${BUILD_URL}: ${error instanceof Error ? error.message : String(error)}`, 'build_fetch_failed', error);
  }
  if (!response?.ok) throw updateError('select-target', `Astrid update check returned HTTP ${response?.status ?? 'unknown'}`, 'build_fetch_failed');
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BUILD_JSON) {
    throw updateError('select-target', 'Astrid build information response was too large', 'build_response_invalid');
  }
  let raw;
  try {
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      raw = '';
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BUILD_JSON) {
          await reader.cancel();
          throw new Error('response was too large');
        }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } else {
      raw = await response.text();
      if (Buffer.byteLength(raw) > MAX_BUILD_JSON) throw new Error('response was too large');
    }
  } catch (error) {
    throw updateError('select-target', `Could not read Astrid build information: ${error instanceof Error ? error.message : String(error)}`, 'build_response_invalid', error);
  }
  let body;
  try { body = JSON.parse(raw); } catch (error) {
    throw updateError('select-target', 'Astrid build information was not valid JSON', 'build_response_invalid', error);
  }
  if (!body || typeof body !== 'object' || !SHA_RE.test(body.app ?? '')
      || !Number.isSafeInteger(body.release) || body.release < 0) {
    throw updateError('select-target', 'Astrid build information did not include a valid App commit and release', 'build_response_invalid');
  }
  return Object.freeze({ app: body.app, release: body.release });
}

/** Fetch the served build once and freeze it with the single origin/main fetch. */
export async function selectUpdateTarget({ cwd, request = fetch, runGit } = {}) {
  const root = resolve(cwd ?? process.cwd());
  const served = await fetchBuild(request);
  try {
    await git(root, ['fetch', '--no-tags', 'origin', 'main'], runGit);
  } catch (error) {
    throw updateError('select-target', `Could not fetch origin/main: ${error instanceof Error ? error.message : String(error)}`, 'git_fetch_failed', error);
  }
  try {
    const oldSha = (await gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}'], runGit)).trim();
    const mainSha = (await gitText(root, ['rev-parse', '--verify', 'origin/main^{commit}'], runGit)).trim();
    if (!SHA_RE.test(oldSha) || !SHA_RE.test(mainSha)) throw new Error('Git returned an invalid commit id');
    const targetSha = served.app.toLowerCase();
    const targetExists = await git(root, ['cat-file', '-e', `${targetSha}^{commit}`], runGit).then(() => true, () => false);
    if (!targetExists) throw updateError('select-target', 'The served App commit is not available from origin/main yet. Retry after the release is available.', 'target_missing');
    if (!(await isAncestor(root, targetSha, mainSha, runGit))) {
      throw updateError('select-target', 'The served App commit is not on origin/main. Refusing to update from an unmerged build.', 'target_not_on_main');
    }
    const privateCommits = Number((await gitText(root, ['rev-list', '--count', `${mainSha}..${oldSha}`], runGit)).trim());
    if (!Number.isSafeInteger(privateCommits) || privateCommits < 0) throw new Error('Git returned an invalid commit count');
    if (privateCommits > 0) throw updateError('select-target', PRIVATE_COMMITS_MESSAGE, 'private_commits');
    const manifestText = await gitText(root, ['show', `${targetSha}:public/install-manifest.json`], runGit);
    const manifest = JSON.parse(manifestText);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('target manifest is not an object');
    const release = manifest.release === undefined ? 0 : manifest.release;
    if (!Number.isSafeInteger(release) || release < 0 || release !== served.release) {
      throw updateError('select-target', 'The served release does not match the manifest at the served App commit. Refusing to prepare a mismatched build.', 'target_manifest_mismatch');
    }
    const upToDate = await isAncestor(root, targetSha, oldSha, runGit);
    const launcherChanged = oldSha !== targetSha && (await git(root, ['diff', '--quiet', oldSha, targetSha, '--',
      'scripts/dev-local-workspace.mjs', 'scripts/dev-local-workspace-options.mjs',
      'scripts/local-update*.mjs', 'scripts/node-package-manager.mjs',
      'scripts/terminate-process-tree.mjs', 'scripts/runtime-schema-guard.mjs',
      'src/integrations/runtime/runtime-update-contract.mjs',
    ], runGit).then(() => false, (error) => {
      if (error?.code === 1 || error?.exitCode === 1 || error?.status === 1) return true;
      throw error;
    }));
    return Object.freeze({ oldSha, targetSha, mainSha, release, manifest: freezeJson(manifest), upToDate, launcherChanged });
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw updateError('select-target', `Could not select the served App commit: ${error instanceof Error ? error.message : String(error)}`, 'target_selection_failed', error);
  }
}

function pathsFromNameStatus(raw) {
  const fields = raw.split('\0');
  const paths = new Set();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    if (/^[RC]/.test(status)) {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      if (oldPath) paths.add(oldPath);
      if (newPath) paths.add(newPath);
    } else {
      const path = fields[index++];
      if (path) paths.add(path);
    }
  }
  return paths;
}

function pathsFromPorcelain(raw) {
  const fields = raw.split('\0');
  const paths = new Set();
  for (let index = 0; index < fields.length;) {
    const entry = fields[index++];
    if (!entry) continue;
    // Porcelain v1 -z puts the original name after the destination for a rename.
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) paths.add(path);
    if (status.includes('R') || status.includes('C')) {
      const original = fields[index++];
      if (original) paths.add(original);
    }
  }
  return paths;
}

async function editedPaths(cwd, runGit) {
  const [porcelain, untracked] = await Promise.all([
    gitText(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], runGit),
    gitText(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], runGit),
  ]);
  const paths = pathsFromPorcelain(porcelain);
  for (const path of untracked.split('\0')) if (path) paths.add(path);
  return [...paths].sort();
}

/** Refuse non-fast-forward or overlapping changes while allowing unrelated edits. */
export async function preflightUpdate({ cwd, targetSha, oldSha, mainSha, runGit } = {}) {
  const root = resolve(cwd ?? process.cwd());
  if (!SHA_RE.test(targetSha ?? '')) throw updateError('preflight', 'A valid served App commit is required', 'invalid_target');
  try {
    const currentSha = (await gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}'], runGit)).trim();
    if (!SHA_RE.test(currentSha)) throw new Error('Git returned an invalid current commit id');
    if (oldSha && currentSha !== oldSha) throw updateError('preflight', 'The checkout changed after the update check. Run the update again.', 'checkout_changed');
    if (mainSha) {
      const currentMain = (await gitText(root, ['rev-parse', '--verify', 'origin/main^{commit}'], runGit)).trim();
      if (currentMain !== mainSha) throw updateError('preflight', 'origin/main changed after the update check. Run the update again.', 'main_changed');
    }
    const fastForward = await isAncestor(root, currentSha, targetSha, runGit);
    const currentContainsTarget = await isAncestor(root, targetSha, currentSha, runGit);
    if (!fastForward && !currentContainsTarget) {
      throw updateError('preflight', 'The served App commit is not a fast-forward from this checkout. Preserve your checkout and resolve its branch history before updating.', 'non_fast_forward');
    }
    const [edited, incomingRaw] = await Promise.all([
      editedPaths(root, runGit),
      currentContainsTarget ? '' : gitText(root, ['diff', '--name-status', '-z', '--find-renames', currentSha, targetSha], runGit),
    ]);
    const incoming = [...pathsFromNameStatus(incomingRaw)].sort();
    // Git can reject a fast-forward when a local file or directory occupies a
    // path that the incoming tree needs as a file (or vice versa). Compare
    // path components as well as exact names so `cache/item` conflicts with an
    // incoming `cache`, and `cache` conflicts with an incoming `cache/item`.
    const conflicts = incoming.filter((incomingPath) => edited.some((editedPath) => (
      editedPath === incomingPath
      || editedPath.startsWith(`${incomingPath}/`)
      || incomingPath.startsWith(`${editedPath}/`)
    )));
    if (conflicts.length) {
      throw updateError('preflight', `Local edits overlap files changed by the update: ${conflicts.join(', ')}. Commit or move those edits, then retry.`, 'local_edits_conflict');
    }
    return Object.freeze({ oldSha: currentSha, targetSha: targetSha.toLowerCase(), mainSha, upToDate: currentContainsTarget, editedPaths: edited, incomingPaths: incoming, conflicts: [] });
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw updateError('preflight', `Could not check the local checkout: ${error instanceof Error ? error.message : String(error)}`, 'preflight_failed', error);
  }
}

async function defaultRunCommand(command, args, options = {}) {
  try {
    await execFileAsync(command, args, { cwd: options.cwd, env: options.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: options.timeout });
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed: ${error.stderr?.trim() || error.message}`, { cause: error });
  }
}

/** Build the exact served commit in an isolated detached worktree. */
export async function prepareUpdate({ cwd, target, runGit, runCommand = defaultRunCommand,
  environment = process.env, execPath = process.execPath, preparationDirectory = tmpdir() } = {}) {
  const root = resolve(cwd ?? process.cwd());
  if (!target || !SHA_RE.test(target.targetSha ?? '') || !Number.isSafeInteger(target.release) || target.release < 0) {
    throw updateError('prepare', 'A selected update target is required', 'invalid_target');
  }
  let parent;
  let worktree;
  try {
    parent = await mkdtemp(join(preparationDirectory, 'astrid-app-update-'));
    worktree = join(parent, 'checkout');
    await git(root, ['worktree', 'add', '--detach', worktree, target.targetSha], runGit);
  } catch (error) {
    if (parent) await rm(parent, { recursive: true, force: true }).catch(() => {});
    throw updateError('prepare-worktree', `Could not create the temporary update worktree: ${error instanceof Error ? error.message : String(error)}`, 'prepare_worktree_failed', error);
  }
  const state = Object.freeze({
    cwd: root,
    oldSha: target.oldSha,
    targetSha: target.targetSha.toLowerCase(),
    mainSha: target.mainSha,
    release: target.release,
    manifest: target.manifest,
    launcherChanged: Boolean(target.launcherChanged),
    worktree,
    buildDir: join(worktree, 'dist'),
    dependenciesDir: join(worktree, 'node_modules'),
    preparationRoot: parent,
  });
  const env = { ...environment, VITE_APP_BUILD: state.targetSha, RAILWAY_GIT_COMMIT_SHA: state.targetSha };
  try {
    const install = packageManagerInvocation('npm', ['ci'], { env, execPath });
    await runCommand(install.command, install.args, { cwd: worktree, env, step: 'prepare-install' });
  } catch (error) {
    await releasePreparation({ cwd: root, state, runGit }).catch(() => {});
    throw updateError('prepare-install', `Could not install dependencies for the update: ${error instanceof Error ? error.message : String(error)}`, 'prepare_install_failed', error);
  }
  try {
    const build = packageManagerInvocation('npm', ['run', 'build'], { env, execPath });
    await runCommand(build.command, build.args, { cwd: worktree, env, step: 'prepare-build' });
    const built = JSON.parse(await readFile(join(state.buildDir, 'build.json'), 'utf8'));
    if (built.app !== state.targetSha || built.release !== state.release) {
      throw new Error('candidate build identity does not match the selected commit and release');
    }
  } catch (error) {
    await releasePreparation({ cwd: root, state, runGit }).catch(() => {});
    throw updateError('prepare-build', `Could not build the update candidate: ${error instanceof Error ? error.message : String(error)}`, 'prepare_build_failed', error);
  }
  return state;
}

/** Recheck frozen refs and local edits immediately before the fast-forward. */
export async function moveCheckout({ cwd, state, runGit } = {}) {
  const root = resolve(cwd ?? state?.cwd ?? process.cwd());
  if (!state || !SHA_RE.test(state.targetSha ?? '') || !SHA_RE.test(state.oldSha ?? '')) {
    throw updateError('move-checkout', 'A prepared update state is required', 'invalid_state');
  }
  try {
    const checked = await preflightUpdate({ cwd: root, targetSha: state.targetSha, oldSha: state.oldSha, mainSha: state.mainSha, runGit });
    if (checked.upToDate) return Object.freeze({ ...state, moved: false, upToDate: true });
    if (state.preparationRoot) {
      const indexTree = (await gitText(root, ['write-tree'], runGit)).trim();
      if (!/^[0-9a-f]{40,64}$/.test(indexTree)) throw new Error('Git returned an invalid staged-index tree id');
      await writeFile(join(state.preparationRoot, 'pre-update-index-tree'), `${indexTree}\n`, { mode: 0o600 });
    }
    await git(root, ['merge', '--ff-only', state.targetSha], runGit);
    const movedSha = (await gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}'], runGit)).trim();
    if (movedSha !== state.targetSha) throw new Error('checkout did not move to the selected App commit');
    if (state.preparationRoot) {
      const indexTree = (await gitText(root, ['write-tree'], runGit)).trim();
      if (!/^[0-9a-f]{40,64}$/.test(indexTree)) throw new Error('Git returned an invalid activated-index tree id');
      await writeFile(join(state.preparationRoot, 'post-update-index-tree'), `${indexTree}\n`, { mode: 0o600 });
    }
    return Object.freeze({ ...state, moved: true, upToDate: false });
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw updateError('move-checkout', `Could not fast-forward the checkout: ${error instanceof Error ? error.message : String(error)}`, 'checkout_move_failed', error);
  }
}

/** Roll back only with Git's keep-preserving reset mode. */
export async function restoreCheckout({ cwd, state, runGit } = {}) {
  const root = resolve(cwd ?? state?.cwd ?? process.cwd());
  if (!state || !SHA_RE.test(state.oldSha ?? '') || !SHA_RE.test(state.targetSha ?? '')) {
    throw updateError('rollback', 'A prepared update state is required', 'invalid_state');
  }
  try {
    const currentSha = (await gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}'], runGit)).trim();
    if (currentSha !== state.oldSha && currentSha !== state.targetSha) {
      throw updateError('rollback', 'The checkout moved to another commit during update. Preserving it for recovery.', 'checkout_changed');
    }
    const treePath = state.preparationRoot && join(state.preparationRoot, 'pre-update-index-tree');
    const postTreePath = state.preparationRoot && join(state.preparationRoot, 'post-update-index-tree');
    let savedIndexTree;
    let postIndexTree;
    if (treePath) {
      try { savedIndexTree = (await readFile(treePath, 'utf8')).trim(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (postTreePath) {
      try { postIndexTree = (await readFile(postTreePath, 'utf8')).trim(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (savedIndexTree && !/^[0-9a-f]{40,64}$/.test(savedIndexTree)) throw new Error('The saved staged-index tree id is invalid');
    if (postIndexTree && !/^[0-9a-f]{40,64}$/.test(postIndexTree)) throw new Error('The activated staged-index tree id is invalid');

    const currentIndexTree = (await gitText(root, ['write-tree'], runGit)).trim();
    const oldHeadTree = (await gitText(root, ['rev-parse', `${state.oldSha}^{tree}`], runGit)).trim();
    if (currentSha === state.targetSha) {
      if (postIndexTree) {
        if (currentIndexTree !== postIndexTree) {
          throw updateError('rollback', 'The staged index changed during update. Preserving it and the checkout for recovery.', 'checkout_changed');
        }
      } else if (savedIndexTree) {
        // The process may die after the fast-forward but before recording the
        // post-move tree. Compare staged deltas instead; target and old trees
        // differ, while the original staged file paths/content remain distinct.
        const [beforeDelta, currentDelta] = await Promise.all([
          gitText(root, ['diff', '--binary', state.oldSha, savedIndexTree], runGit),
          gitText(root, ['diff', '--cached', '--binary', state.targetSha], runGit),
        ]);
        if (beforeDelta !== currentDelta) {
          throw updateError('rollback', 'The staged index changed during update. Preserving it and the checkout for recovery.', 'checkout_changed');
        }
      } else {
        const targetTree = (await gitText(root, ['rev-parse', `${state.targetSha}^{tree}`], runGit)).trim();
        if (currentIndexTree !== targetTree) {
          throw updateError('rollback', 'The staged index has no saved update snapshot. Preserving it and the checkout for recovery.', 'checkout_changed');
        }
      }
      await git(root, ['reset', '--keep', state.oldSha], runGit);
    } else if (savedIndexTree && currentIndexTree !== savedIndexTree && currentIndexTree !== oldHeadTree) {
      throw updateError('rollback', 'The staged index changed during recovery. Preserving it and the checkout.', 'checkout_changed');
    }
    const restoredSha = (await gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}'], runGit)).trim();
    if (restoredSha !== state.oldSha) throw new Error('checkout did not return to its prior commit');
    if (savedIndexTree && currentIndexTree !== savedIndexTree) {
      await git(root, ['read-tree', savedIndexTree], runGit);
    }
    return Object.freeze({ ...state, moved: false, restored: true });
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw updateError('rollback', `Could not restore the prior checkout with reset --keep: ${error instanceof Error ? error.message : String(error)}`, 'checkout_rollback_failed', error);
  }
}

/** Remove the candidate only after the caller has completed verification or rollback. */
export async function releasePreparation({ cwd, state, runGit } = {}) {
  const root = resolve(cwd ?? state?.cwd ?? process.cwd());
  if (!state?.worktree || !state?.preparationRoot) return;
  try {
    await git(root, ['worktree', 'remove', '--force', state.worktree], runGit);
  } catch (error) {
    // A worktree already removed by an interrupted cleanup is harmless; still remove its temp root.
    if (error?.code !== 128 && error?.exitCode !== 128 && error?.status !== 128) {
      throw updateError('cleanup', `Could not remove the prepared worktree: ${error instanceof Error ? error.message : String(error)}`, 'prepare_cleanup_failed', error);
    }
  }
  await rm(state.preparationRoot, { recursive: true, force: true });
}


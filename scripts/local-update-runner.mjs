import { lstat, rename, rm, cp } from 'node:fs/promises';
import { resolve, join, basename, relative, isAbsolute, sep } from 'node:path';
import {
  UpdateError, selectUpdateTarget, preflightUpdate, prepareUpdate,
  moveCheckout, restoreCheckout, releasePreparation,
} from './local-update-checkout.mjs';
import { journalSettled, readUpdateJournal } from './local-update-backend.mjs';

const exists = async (path) => lstat(path).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
const containsPath = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  return !path || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};

export function validateAppContext(app, cwd) {
  if (!app || typeof app.cwd !== 'string' || resolve(app.cwd) !== resolve(cwd) || !/^[0-9a-f]{40}$/.test(app.oldSha ?? '')
      || !/^[0-9a-f]{40}$/.test(app.targetSha ?? '') || !app.preparationRoot
      || resolve(app.worktree ?? '') !== join(resolve(app.preparationRoot), 'checkout')
      || resolve(app.buildDir ?? '') !== join(resolve(app.worktree), 'dist')
      || resolve(app.dependenciesDir ?? '') !== join(resolve(app.worktree), 'node_modules')
      || !basename(app.preparationRoot).startsWith('astrid-app-update-')
      || containsPath(cwd, app.preparationRoot) || containsPath(app.preparationRoot, cwd)
      || typeof app.oldBuildExisted !== 'boolean' || typeof app.oldDependenciesExisted !== 'boolean') {
    throw new UpdateError('recover-app', 'The retained App update context is invalid; keep the recovery material and repair the journal.');
  }
  return app;
}

const partialPath = (destination, app) => `${destination}.${basename(app.preparationRoot)}.partial`;
async function transfer(source, destination, app) {
  try { await rename(source, destination); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    const partial = partialPath(destination, app);
    await rm(partial, { recursive: true, force: true });
    await cp(source, partial, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    await rename(partial, destination);
    await rm(source, { recursive: true, force: true });
  }
}

/** Rename preserves symlink installs and exact prior output until verification. */
export async function installPreparedResources(app) {
  for (const [name, hadOld] of [['node_modules', app.oldDependenciesExisted], ['dist', app.oldBuildExisted]]) {
    const active = join(app.cwd, name), candidate = join(app.worktree, name), prior = join(app.preparationRoot, `previous-${name}`);
    if (await exists(candidate)) {
      if (hadOld && !(await exists(prior))) await transfer(active, prior, app);
      else if (!hadOld && await exists(active)) throw new UpdateError('install-app', `A new ${name} appeared while preparing; keeping it for recovery.`);
      await transfer(candidate, active, app);
    }
  }
}

export async function restorePreparedResources(app) {
  for (const [name, hadOld] of [['node_modules', app.oldDependenciesExisted], ['dist', app.oldBuildExisted]]) {
    const active = join(app.cwd, name), candidate = join(app.worktree, name), prior = join(app.preparationRoot, `previous-${name}`);
    if (await exists(prior)) {
      await rm(active, { recursive: true, force: true });
      await transfer(prior, active, app);
    } else if (!hadOld && !(await exists(candidate))) await rm(active, { recursive: true, force: true });
    await rm(partialPath(active, app), { recursive: true, force: true });
  }
}

/** All mutation callbacks execute under the backend's existing C2 journal. */
export function createLocalUpdater({ cwd, backend, editor, session, backendUpdate,
  selectTarget = selectUpdateTarget, preflight = preflightUpdate, prepare = prepareUpdate,
  move = moveCheckout, restore = restoreCheckout, release = releasePreparation }) {
  let retained;
  const hook = async (message) => {
    const app = validateAppContext(message.app, cwd);
    retained = app;
    const version = message.version;
    try {
      switch (message.hook) {
        case 'stop-editor':
          await session?.begin();
          await editor.stop();
          break;
        case 'move-checkout':
          await move({ cwd, state: app });
          await installPreparedResources(app);
          break;
        case 'start-editor':
          await editor.start({ app, version, rollback: message.rollback === true });
          break;
        case 'verify-editor': await editor.verify({ app, version, rollback: message.rollback === true }); break;
        case 'restore-checkout':
          await restore({ cwd, state: app });
          await restorePreparedResources(app);
          break;
        case 'pinokio-start': await session.start(version, message.operationId); break;
        case 'release-app':
          await session?.end();
          await release({ cwd, state: app });
          retained = undefined;
          break;
        default: throw new Error(`Unknown backend callback ${message.hook}`);
      }
    } catch (error) {
      if (!error.step) error.step = message.hook;
      throw error;
    }
  };
  return async function update() {
    // The same journal must be recovered before selecting any served target.
    const recovered = await backendUpdate({ backend, action: { action: 'recover' }, hook });
    if (recovered.status === 'recovered') return { status: 'recovered', message: 'The interrupted update was restored and Astrid is running. Run npm run update again to check for a new release.' };
    const target = await selectTarget({ cwd });
    if (target.upToDate) return { status: 'up-to-date', message: 'Astrid is up to date.' };
    await preflight({ cwd, ...target });
    const prepared = await prepare({ cwd, target });
    let priorBuild;
    try { priorBuild = await editor.captureIdentity?.(); }
    catch (error) { await release({ cwd, state: prepared }); throw error; }
    const app = { ...prepared,
      oldBuildExisted: await exists(join(cwd, 'dist')),
      oldDependenciesExisted: await exists(join(cwd, 'node_modules')),
      previousMode: editor.mode,
      previousPreviewDirectory: editor.previewDirectory,
      oldAppBuild: priorBuild?.app ?? target.oldSha,
      oldAppRelease: priorBuild?.release ?? 0,
    };
    retained = app;
    try {
      await backendUpdate({ backend, action: { action: 'update', manifest: target.manifest, app }, hook });
      // Cleanup is after C2 has durably recorded completion/rollback.
      if (retained) { await session?.end(); await release({ cwd, state: app }); retained = undefined; }
      return { status: 'updated', app: target.targetSha, release: target.release,
        message: `Astrid is updated and running.${target.launcherChanged ? ' Restart Astrid when convenient.' : ''}` };
    } catch (error) {
      // A journal may have been written before the process failed. Retain the
      // prepared tree and old resources until a fresh controller recovers it.
      let journal;
      try { journal = await readUpdateJournal(backend.root); } catch { /* unreadable journal: nothing to keep */ }
      if (journalSettled(journal)) {
        await session?.end().catch(() => {});
        if (retained) await release({ cwd, state: app }).catch(() => {});
        retained = undefined;
      }
      throw error;
    }
  };
}

import { chromium, test as base, type Browser } from '@playwright/test';
import { deepStrictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { DirectHarness, harnessUnavailableReason, REPO_ROOT } from '../../local/support/harness';
import { resolveReviewedPackHostHelper, startRealPackHost } from './bootstrap';
import { nativeFrameParitySetup, prepareFrameParityFixture, prepareNativeFrameParityRealm, type FrameParityFixture, readRuntimeJson } from './fixture';
import { mediaHash } from './media';
import { ORIGINAL_640, type ParityCanvas } from './canvas';
import type { Capability } from '../../../../src/integrations/runtime/generated';
import { assertFrameSourceTuple, type SourcePin } from './source-tuple';
import { browserExecutableHash, playerBrowserProfile, verifyPlayerBrowser } from './browser-profile';

export const INSTALLED_BROWSER = '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
export const PLAYER_BROWSER = playerBrowserProfile().executablePath;
const EXPORT_BROWSER_HASH = '63eca986a3fe7f523d2d6e79d9f13daf4f1c73c1d9013c2c4a05b123510145b4';
const COMPOSITION_HASH = 'sha256:9412ae25c306d5118241f4d631e8eecc6eef9b2fb5a98302d40938e9f6d54738';
const COMPOSITION_FILE_COUNT = 77;
const EXPECTED_PACKAGE_VERSIONS = {
  react: '18.3.1',
  'react-dom': '18.3.1',
  remotion: '4.0.509',
  '@remotion/player': '4.0.509',
  '@banodoco/timeline-composition': '0.0.13',
} as const;

type FileManifest = Readonly<Record<string, string>>;

function assertSafeRelativePath(path: string): void {
  if (!path || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`unsafe expected package member: ${path}`);
  }
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute));
      else throw new Error(`expected regular package file: ${absolute}`);
    }
  }
  await visit(root);
  return files.sort();
}

/** Verify an explicit byte manifest; expected hashes must come from a release source. */
export async function verifyFileGraph(root: string, expected: FileManifest, label: string,
  options: { exact?: boolean } = {}): Promise<FileManifest> {
  const expectedPaths = Object.keys(expected).sort();
  if (!expectedPaths.length) throw new Error(`${label}: empty expected file manifest`);
  expectedPaths.forEach(assertSafeRelativePath);
  if (options.exact) {
    const actualPaths = await listFiles(root);
    if (actualPaths.length !== expectedPaths.length || actualPaths.some((path, index) => path !== expectedPaths[index])) {
      throw new Error(`${label}: installed file set differs (expected ${expectedPaths.length} files, found ${actualPaths.length})`);
    }
  }
  const verified: Record<string, string> = {};
  await Promise.all(expectedPaths.map(async path => {
    const absolute = resolve(root, path);
    const file = await lstat(absolute).catch(() => null);
    if (!file?.isFile() || file.isSymbolicLink()) throw new Error(`${label}: missing or non-regular target ${path}`);
    const digest = mediaHash(await readFile(absolute));
    if (digest !== expected[path]) throw new Error(`${label}: ${path} has ${digest}, expected ${expected[path]}`);
    verified[path] = digest;
  }));
  return verified;
}

function archiveMembers(archive: string): string[] {
  return execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n')
    .filter(name => name && !name.endsWith('/')).map(name => {
      if (!name.startsWith('package/')) throw new Error(`unexpected public package member ${name}`);
      const path = name.slice('package/'.length);
      assertSafeRelativePath(path);
      return path;
    });
}

async function compositionManifest(archive: string): Promise<FileManifest> {
  const archiveBytes = await readFile(archive);
  if (mediaHash(archiveBytes) !== COMPOSITION_HASH) {
    throw new Error(`Composition artifact is not the approved 0.0.13 source: ${archive}`);
  }
  const members = archiveMembers(archive);
  if (members.length !== COMPOSITION_FILE_COUNT || new Set(members).size !== members.length) {
    throw new Error(`Composition artifact must contain exactly ${COMPOSITION_FILE_COUNT} files, found ${members.length}`);
  }
  return Object.fromEntries(members.map(path => [path,
    mediaHash(execFileSync('tar', ['-xOf', archive, `package/${path}`], { stdio: ['ignore', 'pipe', 'pipe'] }))]));
}

async function verifyCompositionPackage(artifact: string, packageRoot: string, consumer: string) {
  const manifest = await compositionManifest(artifact);
  return verifyFileGraph(packageRoot, manifest, `${consumer} Composition`, { exact: true });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must name the manager-frozen source tuple`);
  return resolve(value);
}

export async function assertRunBoundary(): Promise<void> {
  await assertQuietAbsent();
  deepStrictEqual(process.env.VIEWING_BROWSER_FLOCK_HELD, '1', 'central browser flock marker required');
  deepStrictEqual(spawnSync('flock', ['-n', '/tmp/timeline-viewing-browser.lock', 'true'], { stdio: 'ignore' }).status,
    1, 'central browser flock must remain held');
}

async function assertQuietAbsent(): Promise<void> {
  try {
    await access('/tmp/claude-0/-home-user-repo/7dc61be1-7066-52e0-a5d0-94f90e61430a/scratchpad/orch/managers/viewing/QUIET.md');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Viewing QUIET marker is present');
}

const git = (root: string, ...args: string[]) => execFileSync('git', args,
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Content survives the central service's synthetic snapshot commit. */
export async function sourceContent(root: string) {
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean).sort();
  const files = [];
  for (const name of names) {
    const path = join(root, name);
    const info = await lstat(path);
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`unexpected source member ${name}`);
    files.push([name, info.isSymbolicLink() ? 'symlink' : info.mode & 0o111 ? 'executable' : 'file',
      mediaHash(info.isSymbolicLink() ? Buffer.from(await readlink(path)) : await readFile(path))]);
  }
  return { files: files.length, sha256: mediaHash(Buffer.from(JSON.stringify(files))) };
}

export async function sourceVersions(profile?: unknown) {
  playerBrowserProfile(profile);
  await assertQuietAbsent();
  const tuple = JSON.parse(await readFile(requiredEnv('VIEWING_FRAME_SOURCE_TUPLE'), 'utf8'));
  assertFrameSourceTuple(tuple);
  deepStrictEqual(process.version, 'v20.19.4', 'selected gate requires Node 20.19.4');
  const playerBrowser = await verifyPlayerBrowser(profile);
  const exportBrowserHash = await browserExecutableHash(INSTALLED_BROWSER);
  deepStrictEqual(exportBrowserHash, EXPORT_BROWSER_HASH, 'CPU export browser bytes changed');
  const roots = {
    app: REPO_ROOT, agent: requiredEnv('ASTRID_CHECKOUT'), runtime: requiredEnv('ASTRID_RUNTIME_CHECKOUT'),
    composition: requiredEnv('TIMELINE_COMPOSITION_CHECKOUT'),
  };
  await resolveReviewedPackHostHelper(roots.agent);
  const sourceState: Record<string, unknown> = {};
  for (const [name, root] of Object.entries(roots)) {
    const pin: SourcePin = tuple.sources[name as keyof typeof roots];
    if (name === 'app') deepStrictEqual(await sourceContent(root), tuple.appSource, 'App differs from final source freeze');
    else {
      deepStrictEqual(await realpath(root), await realpath(pin.root), `${name} root changed`);
      deepStrictEqual(git(root, 'rev-parse', 'HEAD'), pin.commit, `${name} commit changed`);
      deepStrictEqual(git(root, 'rev-parse', 'HEAD^{tree}'), pin.tree, `${name} tree changed`);
      deepStrictEqual(git(root, 'status', '--porcelain', '--untracked-files=normal'), '', `${name} source is dirty`);
    }
    const directory = await lstat(root);
    const gitPath = join(root, '.git');
    const gitInfo = await lstat(gitPath);
    sourceState[name] = { commit: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}'),
      dev: directory.dev, ino: directory.ino, gitDev: gitInfo.dev, gitIno: gitInfo.ino,
      gitFile: gitInfo.isFile() ? mediaHash(await readFile(gitPath)) : null };
  }
  await verifyFileGraph(roots.app, tuple.client.files, 'official Runtime client');
  const artifacts = [resolve(roots.app, 'vendor/artifacts/banodoco-timeline-composition-0.0.13.tgz'),
    resolve(roots.agent, 'remotion/artifacts/banodoco-timeline-composition-0.0.13.tgz')];
  const hashes = await Promise.all(artifacts.map(async path => mediaHash(await readFile(path))));
  if (hashes.some(hash => hash !== COMPOSITION_HASH)) throw new Error(`both consumers require exact public 0.0.13 artifact ${COMPOSITION_HASH}: ${hashes}`);
  const remotionProject = await realpath(requiredEnv('ASTRID_REMOTION_PROJECT_DIR'));
  deepStrictEqual(remotionProject, await realpath(tuple.remotionProject), 'selected Agent Remotion project changed');
  const packages: Record<string, string> = {};
  const installedCompositionHashes: Record<string, string> = {};
  const compositionFiles: Record<string, FileManifest> = {};
  const renderGraphHashes: Record<string, FileManifest> = {};
  for (const [index, [consumer, root]] of [['app', roots.app], ['agent', remotionProject]].entries()) {
    const artifact = artifacts[index];
    const compositionRoot = resolve(root, 'node_modules/@banodoco/timeline-composition');
    const installed = await verifyCompositionPackage(artifact, compositionRoot, consumer);
    compositionFiles[consumer] = installed;
    installedCompositionHashes[consumer] = mediaHash(Buffer.concat(await Promise.all(Object.keys(installed).sort()
      .map(path => readFile(resolve(compositionRoot, path))))));
    renderGraphHashes[consumer] = await verifyFileGraph(root, tuple.peers[consumer as 'app' | 'agent'], `${consumer} Remotion/Player graph`);
    for (const [name, expected] of Object.entries(EXPECTED_PACKAGE_VERSIONS)) {
      const pkg = JSON.parse(await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8'));
      if (pkg.version !== expected) throw new Error(`${consumer} ${name}: ${pkg.version} != ${expected}`);
      packages[`${consumer}:${name}`] = pkg.version;
    }
  }
  if (process.env.ASTRID_REMOTION_BROWSER_EXECUTABLE !== INSTALLED_BROWSER) {
    throw new Error('Agent parent must select the installed headless_shell 1194 through ASTRID_REMOTION_BROWSER_EXECUTABLE');
  }
  return {
    revisions: Object.fromEntries(Object.entries(roots).map(([name, root]) => [name,
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()])),
    roots, remotionProject, artifacts, hashes, installedCompositionHashes, compositionFiles, renderGraphHashes,
    selectedInstalls: {
      app: resolve(roots.app, 'node_modules'),
      agent: resolve(remotionProject, 'node_modules'),
    },
    sourceState, sourceTupleHash: mediaHash(await readFile(requiredEnv('VIEWING_FRAME_SOURCE_TUPLE'))),
    packages, browserExecutable: INSTALLED_BROWSER, exportBrowserHash,
    playerBrowserExecutable: playerBrowser.executablePath, playerBrowser, node: process.version,
  };
}

export type SourceVersionGraph = Pick<Awaited<ReturnType<typeof sourceVersions>>,
  'compositionFiles' | 'renderGraphHashes' | 'playerBrowser' | 'exportBrowserHash'> &
  Partial<Pick<Awaited<ReturnType<typeof sourceVersions>>, 'sourceState' | 'sourceTupleHash'>>;

/** Keep the release-declared package files and Remotion/Player targets immutable during browser setup/use. */
export function assertSourceVersionsUnchanged(before: SourceVersionGraph, after: SourceVersionGraph): void {
  for (const field of ['compositionFiles', 'renderGraphHashes', 'playerBrowser', 'exportBrowserHash', 'sourceState', 'sourceTupleHash'] as const) {
    try {
      deepStrictEqual(after[field], before[field]);
    } catch {
      throw new Error(`source dependency graph changed during browser fixture: ${field}`);
    }
  }
}

function safeFailureReason(failure: unknown): string {
  if (!(failure instanceof Error)) return 'non-Error failure';
  return failure.message || 'Error without a message';
}

/** Keep fixture diagnostics useful without serializing arbitrary error data. */
export function aggregateFixtureFailures(message: string, failures: readonly unknown[]): AggregateError {
  const reasons = failures.map((failure, index) => `${index + 1}: ${safeFailureReason(failure)}`).join('; ');
  return new AggregateError(failures, reasons ? `${message}: ${reasons}` : message);
}

export async function readyRenderCapability(harness: DirectHarness): Promise<Capability> {
  let cursor: string | null = null;
  do {
    const page: { items: Capability[]; next_cursor: string | null } = await readRuntimeJson(harness,
      `/v1/capabilities?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const capability = page.items.find(item => item.capability_id === 'rendering.render');
    if (capability) {
      if (capability.status !== 'ready' || !/^sha256:[0-9a-f]{64}$/.test(capability.definition_digest)) {
        throw new Error(`production rendering.render is unavailable: ${JSON.stringify(capability)}`);
      }
      return capability;
    }
    cursor = page.next_cursor;
  } while (cursor);
  throw new Error('production rendering.render is absent from the real Runtime catalog');
}

export const test = base.extend<object, {
  harness: DirectHarness; fixture: FrameParityFixture; browser: Browser; parityCanvas: ParityCanvas;
}>({
  parityCanvas: [ORIGINAL_640, { scope: 'worker', option: true }],
  harness: [async ({ parityCanvas }, provide, workerInfo) => {
    await assertRunBoundary();
    const reason = harnessUnavailableReason();
    if (reason) throw new Error(reason);
    const profile = workerInfo.project.metadata.viewingParityBrowserProfile;
    const preflight = await sourceVersions(profile);
    const harness = new DirectHarness();
    const failures: unknown[] = [];
    try {
      await harness.start({ seed: false, beforeRuntimeStart: async current => {
        await prepareNativeFrameParityRealm(current, parityCanvas);
      }});
      await provide(harness);
    } catch (error) { failures.push(error); }
    finally {
      try { await harness.stop(); } catch (error) { failures.push(error); }
      try {
        await assertRunBoundary();
        assertSourceVersionsUnchanged(preflight, await sourceVersions(profile));
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw aggregateFixtureFailures('Runtime fixture or final source postflight failed', failures);
  }, { scope: 'worker', timeout: 240_000 }],
  fixture: [async ({ harness, parityCanvas }, provide) => {
    await harness.enableTimelineAuthoring(requiredEnv('ASTRID_PYTHON'));
    const fixture = await prepareFrameParityFixture(harness, parityCanvas, nativeFrameParitySetup(harness));
    // Browser/export qualification still requires the approved Agent helper
    // and adoption of the frozen consumer graph.
    const host = await startRealPackHost(harness, () => readyRenderCapability(harness));
    try {
      await provide(fixture);
    } finally { await host.stop(); }
  }, { scope: 'worker', timeout: 240_000 }],
  browser: [async ({ harness, fixture }, provide, workerInfo) => {
    void fixture;
    const profile = workerInfo.project.metadata.viewingParityBrowserProfile;
    const preflight = await sourceVersions(profile);
    let browser: Browser | undefined;
    const failures: unknown[] = [];
    try {
      browser = await chromium.launch({ args: harness.chromiumArgs, executablePath: preflight.playerBrowserExecutable });
      deepStrictEqual(browser.version(), preflight.playerBrowser.version, 'selected Player browser version changed');
      console.log('[viewing-parity] Player browser', preflight.playerBrowser.profile, browser.version(), preflight.playerBrowserExecutable);
      await provide(browser);
    } catch (error) {
      failures.push(error);
    } finally {
      try { await browser?.close(); } catch (error) { failures.push(error); }
      try {
        await assertRunBoundary();
        assertSourceVersionsUnchanged(preflight, await sourceVersions(profile));
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw aggregateFixtureFailures('Player fixture or final source postflight failed', failures);
  }, { scope: 'worker' }],
  context: async ({ browser, harness, parityCanvas }, provide) => {
    const context = await browser.newContext({ ...harness.contextOptions,
      viewport: parityCanvas.viewport, deviceScaleFactor: 1, acceptDownloads: true });
    try { await provide(context); } finally { await context.close(); }
  },
});

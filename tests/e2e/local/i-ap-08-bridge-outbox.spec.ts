/**
 * I-AP-08: production App -> real Runtime browser door.
 *
 * The runner supplies an installer-shaped Runtime fixture below I_AP_08_INSTALL_ROOT.
 * It is deliberately private and disposable: the final Update POST is made against the
 * real door, but the fixture is invalidated immediately before it so the Runtime rejects
 * before any updater input may be fetched or a host installation can be touched.
 */
import { expect, type Page, type Request, type Route, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { commandOutboxes, dragTimelineClip, expectConnected, holdCommandRequests, openApp, openSeededTimeline, test as appTest } from './support/app.ts';
import { harnessUnavailableReason, RUNTIME_CHECKOUT, type DirectHarness } from './support/harness.ts';

const RUNTIME_SHA = '47e5949465cb6f3afdfd1cb8a0e90009fd9d4020';
const AGENT_SHA = 'af5ae8afdb9829beb2bba4f811dbe97765bd72b2';
const APP_SHA = 'a55bec9ff384b5bbfee5535962880084ab2adb1b';
const INSTALL_OWNER = 'haus.astrid.runtime';
const RECOVERY_OPERATION = 'a'.repeat(32);
const CEILING = { timeout: 60_000 };

type RequestFact = {
  at: string;
  method: string;
  path: string;
  idempotencyKey?: string;
  status?: number;
};

type RuntimeProcess = { stdout?: string; stderr?: string };

function evidence(testInfo: TestInfo, name: string, value: unknown): void {
  const target = testInfo.outputPath(name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function installerFixtureRoot(): string {
  const value = process.env.I_AP_08_INSTALL_ROOT;
  if (!value || !path.isAbsolute(value)) throw new Error('I_AP_08_INSTALL_ROOT must be an absolute task-local path');
  return path.resolve(value);
}

function selectionPath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (!xdg || !path.isAbsolute(xdg)) throw new Error('XDG_DATA_HOME must be an absolute task-local path');
  return path.join(xdg, 'astrid-install.json');
}

/** Byte-level selected-installer state used to prove status reads are observational. */
function statusState(): { digest: string; files: Record<string, string> } {
  const root = installerFixtureRoot();
  const version = path.join(root, 'versions', 'old');
  const paths = [
    selectionPath(), path.join(root, 'install.json'), path.join(root, 'current'),
    path.join(version, 'manifest.json'), path.join(version, 'profile.json'), path.join(version, 'version.json'),
  ];
  const files = Object.fromEntries(paths.map((file) => [file, readFileSync(file, 'utf8')]));
  return { digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

/** Durable Runtime realm files must remain byte-identical across status reads. */
function realmState(root: string): { digest: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files[path.relative(root, target)] = createHash('sha256').update(readFileSync(target)).digest('hex');
      else if (entry.isSymbolicLink()) throw new Error(`Runtime realm state must not traverse symlink: ${target}`);
    }
  };
  if (!statSync(root).isDirectory()) throw new Error(`Runtime realm root is not a directory: ${root}`);
  visit(root);
  return { digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

/** Make the Runtime's own selected-installation validation point at this harness only. */
function prepareInstallerFixture(harness: DirectHarness): void {
  const root = installerFixtureRoot();
  const versionRoot = path.join(root, 'versions', 'old');
  const runtime = path.resolve(RUNTIME_CHECKOUT);
  const configuredAgent = process.env.ASTRID_CHECKOUT;
  if (!configuredAgent || !path.isAbsolute(configuredAgent)) throw new Error('ASTRID_CHECKOUT must be an absolute selected Agent checkout');
  const agent = path.resolve(configuredAgent);
  if (runtime !== path.join(versionRoot, 'runtime') || agent !== path.join(versionRoot, 'agent')) {
    throw new Error('I-AP-08 selected Runtime and Agent must be physical children of the selected version');
  }
  const identity = { release: 3, managed_by: null };
  const record = {
    owner: INSTALL_OWNER,
    program_root: root,
    data_root: path.dirname(harness.supportDir),
    realm_id: harness.realmId,
    realm_root: harness.realmDir,
    identity,
  };
  mkdirSync(path.dirname(selectionPath()), { recursive: true });
  mkdirSync(path.join(root, 'logs'), { recursive: true });
  writeFileSync(selectionPath(), JSON.stringify(record));
  writeFileSync(path.join(root, 'current'), 'old\n');
  writeFileSync(path.join(versionRoot, 'manifest.json'), JSON.stringify({ release: 3 }));
  writeFileSync(path.join(versionRoot, 'profile.json'), JSON.stringify({ profile: 'astrid', source_checkout: agent, runtime_checkout: runtime }));
  writeFileSync(path.join(versionRoot, 'version.json'), JSON.stringify({
    root: versionRoot,
    python: path.join(runtime, '.venv', 'bin', 'python'),
    profile: path.join(versionRoot, 'profile.json'),
    identity,
    env: { ASTRID_INSTALL_RELEASE: '3', ASTRID_INSTALL_MANAGED_BY: '' },
  }));
  // The status endpoint must report recovery-needed before any user action. That
  // exposes the App's real guarded Update button without calling an updater.
  writeFileSync(path.join(root, 'install.json'), JSON.stringify({
    ...record,
    update_job: { format: 'astrid-update-job/v1', operation_id: RECOVERY_OPERATION, state: 'recovery-needed', message: 'Recovery needed.' },
  }));
}

function observe(page: Page, facts: RequestFact[], browserLog: string[]): void {
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    const pathName = url.pathname;
    if (request.method() === 'POST' && (pathName === '/api/runtime/v1/update' || /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/.test(pathName))) {
      facts.push({ at: new Date().toISOString(), method: request.method(), path: pathName, idempotencyKey: request.headers()['idempotency-key'] });
    }
  });
  page.on('response', (response) => {
    const request = response.request();
    const pathName = new URL(response.url()).pathname;
    const fact = [...facts].reverse().find((candidate) => candidate.method === request.method()
      && candidate.path === pathName && candidate.status === undefined);
    if (fact) fact.status = response.status();
  });
  page.on('console', (message) => browserLog.push(`${message.type()} ${message.text()}`));
  page.on('pageerror', (error) => browserLog.push(`pageerror ${error.name}: ${error.message}`));
}

function updatePosts(facts: RequestFact[]) { return facts.filter((fact) => fact.path === '/api/runtime/v1/update'); }
function commitPosts(facts: RequestFact[]) { return facts.filter((fact) => /\/commit$/.test(fact.path)); }

/**
 * Let the real Runtime accept one command, then lose only its browser
 * acknowledgement. The persisted outbox remains a retry with its original
 * idempotency key, which is the restart/replay case (rather than the separate
 * recovered-draft path used for a request that never left the browser).
 */
async function loseCommandAcknowledgement(page: Page): Promise<{
  requests: Request[];
  accepted: Promise<{ status: number }>;
  release: () => Promise<void>;
}> {
  const commits = /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/;
  const requests: Request[] = [];
  let releaseAck!: () => void;
  let acceptedResolve!: (value: { status: number }) => void;
  let acceptedReject!: (reason: unknown) => void;
  let abortedResolve!: () => void;
  const acknowledgement = new Promise<void>((resolve) => { releaseAck = resolve; });
  const accepted = new Promise<{ status: number }>((resolve, reject) => { acceptedResolve = resolve; acceptedReject = reject; });
  const aborted = new Promise<void>((resolve) => { abortedResolve = resolve; });
  const intercept = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    requests.push(route.request());
    try {
      const response = await route.fetch({ maxRetries: 0 });
      acceptedResolve({ status: response.status() });
    } catch (error) {
      acceptedReject(error);
      throw error;
    }
    await acknowledgement;
    await route.abort('connectionreset').catch(() => {});
    abortedResolve();
  };
  await page.route(commits, intercept);
  return {
    requests,
    accepted,
    release: async () => {
      releaseAck();
      await aborted;
      await page.unroute(commits, intercept);
    },
  };
}

function runtimeStreams(harness: DirectHarness): RuntimeProcess {
  const process = (harness as unknown as { runtime?: RuntimeProcess }).runtime;
  return { stdout: process?.stdout ?? '', stderr: process?.stderr ?? '' };
}

async function openUpdates(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#settings-updates')).toBeVisible();
  await expect(page.locator('#settings-updates').getByRole('button', { name: 'Update', exact: true })).toBeVisible();
}

/** Closing Settings leaves its presentation-only URL parameter in place. */
async function closeSettings(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('settings');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  });
  expect(new URL(page.url()).searchParams.has('settings')).toBe(false);
}

appTest.beforeAll(() => {
  const unavailable = harnessUnavailableReason();
  if (unavailable) throw new Error(`I-AP-08 real bridge harness unavailable: ${unavailable}`);
});

appTest('I-AP-08 real browser bridge: guarded Update and one durable Timeline replay', async ({ page, harness }, testInfo) => {
  testInfo.setTimeout(180_000);
  const browserLog: string[] = [];
  const beforeRestartWire: RequestFact[] = [];
  observe(page, beforeRestartWire, browserLog);

  // Command commits require the published Agent authoring profile. The selected
  // Python remains inside the same task-local Runtime fixture.
  const seed = await harness.seedThreeProducts();
  prepareInstallerFixture(harness);
  // DirectHarness intentionally starts from a checkout so it can create the
  // real Timeline seed.  A fresh Runtime is required after publishing the
  // selected installer record: Runtime captures this identity once at start
  // and must never discover it lazily on a status GET.
  const installerIdentityStart = await harness.restartRuntime();
  const installerHealth = await harness.doorRequest('/v1/health');
  expect(installerHealth.status).toBe(200);
  expect(installerHealth.json()).toMatchObject({ identity: { release: 3, managed_by: null } });
  evidence(testInfo, 'tuple.json', {
    app: APP_SHA, runtime: RUNTIME_SHA, agent: AGENT_SHA,
    runtimeCheckout: RUNTIME_CHECKOUT, agentCheckout: process.env.ASTRID_CHECKOUT,
    installerIdentityStart, installerHealth: installerHealth.json(),
  });

  // The update route is intentionally reachable only through the production
  // browser door. Repeated GETs retain every selected-installation record
  // byte-for-byte and admit neither an update nor a Timeline mutation.
  const statusBefore = statusState();
  const realmBefore = realmState(harness.realmDir);
  const auditAtStatusStart = harness.audit().length;
  const firstStatus = await harness.doorRequest('/v1/update/status');
  const secondStatus = await harness.doorRequest('/v1/update/status');
  const statusAfter = statusState();
  const realmAfter = realmState(harness.realmDir);
  expect(firstStatus.status).toBe(200);
  expect(secondStatus.status).toBe(200);
  expect(secondStatus.json()).toEqual(firstStatus.json());
  expect(statusAfter.digest).toBe(statusBefore.digest);
  expect(realmAfter.digest).toBe(realmBefore.digest);
  const statusAudit = harness.audit().slice(auditAtStatusStart)
    .map(({ method, path: requestPath, status }) => ({ method, path: requestPath, status }));
  expect(statusAudit).toEqual([
    { method: 'GET', path: '/v1/update/status', status: 200 },
    { method: 'GET', path: '/v1/update/status', status: 200 },
  ]);
  evidence(testInfo, 'runtime-status-observational.json', {
    firstStatus: firstStatus.json(), secondStatus: secondStatus.json(), statusBefore, statusAfter, realmBefore, realmAfter, statusAudit,
  });

  await openApp(page, harness);
  await expectConnected(page);
  await openSeededTimeline(page, harness);

  /** Queue a real App drag while retaining its outbound command in the browser. */
  const queueAppMove = async (requests: Request[]) => {
    const heads = await harness.runtimeJson<any>('GET',
      `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/composition-revisions?limit=50`);
    expect(heads.status).toBe(200);
    const head = heads.body.items.find((item: { is_current_head?: boolean }) => item.is_current_head);
    if (!head) throw new Error('three-product seed has no current composition head');
    const revision = await harness.runtimeJson<any>('GET',
      `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/composition-revisions/${head.revision_id}`);
    expect(revision.status).toBe(200);
    const clips = revision.body.payload.config.clips as Array<{ id: string; at: number }>;
    const appClip = clips.find((clip) => clip.id === seed.appClipId);
    const referenceClip = clips.find((clip) => clip.id === seed.transitionClipId);
    if (!appClip || !referenceClip) throw new Error('three-product seed has no App-owned clip pair');
    await dragTimelineClip(page, seed.appClipId, seed.transitionClipId, appClip.at, appClip.at + 1, referenceClip.at);
    await expect.poll(() => requests.length, CEILING).toBe(1);
    let owner: Awaited<ReturnType<typeof commandOutboxes>>[number] | undefined;
    await expect.poll(async () => {
      const owners = await commandOutboxes(page, seed.timelineId);
      owner = owners.find((candidate) => candidate.pending?.request.key === requests[0].headers()['idempotency-key']);
      return Boolean(owner);
    }, CEILING).toBe(true);
    if (!owner) throw new Error('held command did not enter the browser command outbox');
    return owner;
  };

  const firstHeld = await holdCommandRequests(page);
  const firstMove = await queueAppMove(firstHeld.requests);
  evidence(testInfo, 'outbox-before-guard.json', firstMove);

  // An explicit Update attempt with the real unresolved save still present
  // must fail closed. Its durable request identity remains untouched and no
  // installer POST is allowed through the browser door.
  await openUpdates(page);
  const blockedUpdate = page.locator('#settings-updates').getByRole('button', { name: 'Update', exact: true });
  await blockedUpdate.click();
  await page.waitForTimeout(400);
  expect(updatePosts(beforeRestartWire), 'unresolved save must block installer Update').toHaveLength(0);
  const blockedOwner = (await commandOutboxes(page, seed.timelineId)).find((owner) => owner.ownerId === firstMove.ownerId)!;
  expect(blockedOwner.pending?.request).toEqual(firstMove.pending?.request);
  await closeSettings(page);

  // Complete the first explicit save normally. This makes the following
  // admission check a real settled App state, instead of a mocked transition.
  const firstCommit = page.waitForResponse((response) => response.request().method() === 'POST'
    && /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/.test(new URL(response.url()).pathname), CEILING);
  await firstHeld.release(true);
  expect((await firstCommit).status()).toBe(200);
  await expect.poll(async () => {
    const owner = (await commandOutboxes(page, seed.timelineId)).find((candidate) => candidate.ownerId === firstMove.ownerId);
    return !owner?.pending;
  }, CEILING).toBe(true);
  evidence(testInfo, 'outbox-after-explicit-save.json', await commandOutboxes(page, seed.timelineId));

  // The successful save admits exactly one real Update POST. The Runtime
  // fixture is a selected, task-local recovery installation, and its private
  // user-service shim cannot start or alter any host installation.
  await openUpdates(page);
  const explicitUpdate = page.locator('#settings-updates').getByRole('button', { name: 'Update', exact: true });
  await expect(explicitUpdate).toBeEnabled();
  const updateResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/runtime/v1/update', CEILING);
  await explicitUpdate.click();
  // A recovery-needed fixture is deliberately terminal at Runtime admission;
  // 409 here proves the one real POST reached the pinned Runtime without
  // attempting an updater launch.
  expect((await updateResponse).status()).toBe(409);
  expect(updatePosts(beforeRestartWire), 'settled explicit save permits exactly one installer Update POST').toHaveLength(1);
  expect(updatePosts(beforeRestartWire)[0].status).toBe(409);
  await closeSettings(page);

  // Restore task-local installer data for the independent restart/replay
  // journey. It cannot produce another Update request.
  prepareInstallerFixture(harness);
  await page.reload();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectConnected(page);
  await openSeededTimeline(page, harness);

  const historyBefore = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50`);
  expect(historyBefore.status).toBe(200);
  const replayAck = await loseCommandAcknowledgement(page);
  const beforeRestart = await queueAppMove(replayAck.requests);
  expect((await replayAck.accepted).status).toBe(200);
  const acceptedBeforeRestart = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50`);
  expect(acceptedBeforeRestart.status).toBe(200);
  expect(acceptedBeforeRestart.body.items).toHaveLength(historyBefore.body.items.length + 1);
  await replayAck.release();
  await expect.poll(async () => (await commandOutboxes(page, seed.timelineId))
    .find((owner) => owner.ownerId === beforeRestart.ownerId)?.pending?.outcome?.kind, CEILING).toBe('retry');
  const retryBeforeRestart = (await commandOutboxes(page, seed.timelineId))
    .find((owner) => owner.ownerId === beforeRestart.ownerId)!;
  expect(retryBeforeRestart.pending?.request).toEqual(beforeRestart.pending?.request);
  expect(retryBeforeRestart.pending?.outcome?.kind).toBe('retry');
  evidence(testInfo, 'outbox-before-restart.json', retryBeforeRestart);
  evidence(testInfo, 'runtime-before-restart.json', runtimeStreams(harness));
  const replayFactStart = beforeRestartWire.length;

  // A real Runtime restart is surfaced through the product restart card. Its
  // visible Reload action remounts the durable owner and must re-post the
  // exact uncertain request once.
  const restart = await harness.restartRuntime();
  expect(restart.oldInstanceId).not.toBe(harness.runtimeInstanceId);
  await expect(page.getByRole('heading', { name: 'Astrid restarted' })).toBeVisible(CEILING);
  const replayResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/.test(new URL(response.url()).pathname), CEILING);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  const recovered = (await commandOutboxes(page, seed.timelineId)).find((owner) => owner.ownerId === beforeRestart.ownerId) ?? null;
  expect(recovered).not.toBeNull();
  evidence(testInfo, 'outbox-after-restart.json', recovered);

  expect((await replayResponse).status()).toBe(200);
  await expect.poll(() => commitPosts(beforeRestartWire.slice(replayFactStart)).length, CEILING).toBe(1);
  const replayWire = commitPosts(beforeRestartWire.slice(replayFactStart));
  expect(commitPosts(replayWire), 'restart must replay the durable Timeline outbox exactly once').toHaveLength(1);
  expect(commitPosts(replayWire)[0].idempotencyKey).toBe(beforeRestart.pending?.request.key);
  expect(replayWire[0].status).toBe(200);
  await expect.poll(async () => (await commandOutboxes(page, seed.timelineId))
    .every((owner) => !owner.pending && owner.intents.length === 0), CEILING).toBe(true);
  const settled = (await commandOutboxes(page, seed.timelineId)).find((owner) => owner.ownerId === beforeRestart.ownerId) ?? null;
  evidence(testInfo, 'outbox-settled.json', settled);

  const history = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50`);
  expect(history.status).toBe(200);
  expect(history.body.items, 'one Runtime history entry must settle the durable replay').toHaveLength(historyBefore.body.items.length + 1);
  evidence(testInfo, 'runtime-history.json', history.body);

  evidence(testInfo, 'request-trace.json', {
    beforeRestart: beforeRestartWire,
    replay: replayWire,
    installerUpdatePosts: updatePosts(beforeRestartWire).length,
    timelineCommitPosts: commitPosts(beforeRestartWire).length,
    restart,
  });
  evidence(testInfo, 'browser.log.json', browserLog);
  evidence(testInfo, 'runtime-after-restart.json', runtimeStreams(harness));
  evidence(testInfo, 'door-audit.json', harness.audit());
  evidence(testInfo, 'fixture-selection.json', JSON.parse(readFileSync(selectionPath(), 'utf8')));
});

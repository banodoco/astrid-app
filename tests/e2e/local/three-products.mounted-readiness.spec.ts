/**
 * D28 mounted-readiness preflight. The native fixture is seeded by the real Runtime,
 * then the production hosted editor must connect and claim a fresh durable owner.
 * This is deliberately before, and separate from, every gesture and commit journey.
 */
import { expect, type Page, type TestInfo } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { harnessUnavailableReason, runtimePython, startDirectHarness, type DirectHarness, type ThreeProductsSeed } from './support/harness.ts';
import { bootstrapMountedBaseline, commandOutboxes, expectConnected, installMountedBootstrapDiagnostics, openApp, openSeededTimeline, test as appTest, UI } from './support/app.ts';
import { hasFreshSettledOwner, isFreshlyConnected, readExistingReadonly, readMountedBootstrapFailure, type MountedBootstrapFailure, type ReadonlyOutboxRead } from './mounted-readiness-safety.ts';
import { createD21Environment, observeD21Harness, observeD21Page, persistD21Environment, recordD21Error, recordD21Readiness, recordD21Stage, type D21EnvironmentArtifact } from './d21-environment.ts';

const CEILING = { timeout: 90_000 };
const UNKNOWN = 'UNKNOWN' as const;
const MAX_STAGES = 3;
const MAX_ROUTE_STATUS_ERRORS = 16;
const DIAGNOSTIC_FILE = 'mounted-readiness-diagnostics.json';

type Unknownable<T> = T | typeof UNKNOWN;

interface OutboxSummary {
  success: boolean;
  newOwnerCount: Unknownable<number>;
  pendingCount: Unknownable<number>;
  intentsCount: Unknownable<number>;
}

interface ConnectionSummary {
  attached: Unknownable<boolean>;
  state: string;
}

interface StageSnapshot {
  stage: string;
  status: ConnectionSummary;
  actualConnected: Unknownable<boolean>;
  readonlyOutbox: OutboxSummary;
  selectionEquality: Unknownable<boolean>;
}

interface MountedReadinessDiagnostics {
  version: 1;
  endpoints: ReturnType<typeof endpointComponents>;
  stages: StageSnapshot[];
  notRunStages: string[];
  routeStatusErrors: Array<{ stage: string; route: string; status: number; code: string; class: 'route-status' }>;
  failure?: MountedBootstrapFailure | { stage: string; code: 'assertion' | 'timeout' | 'setup'; class: 'assertion' | 'timeout' | 'setup' };
}

function observeHarnessEnvironment(environment: D21EnvironmentArtifact, harness: DirectHarness): void {
  observeD21Harness(environment, {
    runtimeUrl: harness.runtimeUrl,
    doorBase: harness.doorBase,
    doorPrefix: harness.doorPrefix,
    editorOrigin: harness.origin,
    productCredentialPresent: Boolean(harness.productToken),
    authoringProfile: harness.lifecycleObservation?.launchProfile === 'astrid' ? 'astrid' : 'UNKNOWN',
    distPath: process.env.ASTRID_APP_DIRECT_DIST ?? 'dist',
    agentCommit: process.env.TIMELINE_BUNDLE_AGENT_HEAD,
    runtimeCommit: process.env.TIMELINE_BUNDLE_RUNTIME_HEAD,
    backendInterpreterPath: runtimePython() ?? undefined,
    lifecycle: harness.lifecycleObservation,
  });
}

const test = appTest.extend<object, { environment: D21EnvironmentArtifact; harness: DirectHarness; seed3: ThreeProductsSeed }>({
  // Persist a bounded carrier before worker setup so harness/seed failures retain setup evidence.
  // eslint-disable-next-line no-empty-pattern
  environment: [async ({}, use, workerInfo) => {
    const environment = createD21Environment();
    await persistD21Environment(workerInfo, environment);
    await use(environment);
  }, { scope: 'worker' }],
  // Keep the same P3 bootstrap: defer the empty timeline, then let the native full seed create the fixture.
  harness: [async ({ environment }, use, workerInfo) => {
    let harness: DirectHarness | undefined;
    try {
      harness = await startDirectHarness({ deferTimelineInitialization: true });
      observeHarnessEnvironment(environment, harness);
      await persistD21Environment(workerInfo, environment);
    } catch (error) {
      environment.status = 'failed';
      recordD21Error(environment, { code: 'setup_failed', class: 'setup', stage: 'harness' });
      await persistD21Environment(workerInfo, environment).catch(() => {});
      throw error;
    }
    try { await use(harness); }
    finally {
      if (harness) {
        try { await harness.stop(); } catch { /* Preserve the primary setup or leaf result. */ }
      }
    }
  }, { scope: 'worker', timeout: process.env.ASTRID_QUICK_DESCRIPTOR ? 0 : 240_000 }],
  seed3: [async ({ environment, harness }, use, workerInfo) => {
    let seed: ThreeProductsSeed;
    try {
      seed = await harness.seedThreeProducts();
      observeHarnessEnvironment(environment, harness);
      await persistD21Environment(workerInfo, environment);
    } catch (error) {
      environment.status = 'failed';
      observeHarnessEnvironment(environment, harness);
      recordD21Error(environment, { code: 'setup_failed', class: 'setup', stage: 'seed' });
      await persistD21Environment(workerInfo, environment).catch(() => {});
      throw error;
    }
    await use(seed);
  }, { scope: 'worker', timeout: 240_000 }],
});

test.beforeAll(async ({ environment }, testInfo) => {
  await persistD21Environment(testInfo, environment);
});

test.beforeAll(() => {
  const reason = harnessUnavailableReason();
  if (reason) throw new Error(`mounted-readiness preflight cannot run: ${reason}`);
});

function safeRoute(url: string): string | undefined {
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { return undefined; }
  if (pathname === '/api/runtime/v1/health') return '/health';
  if (pathname === '/api/runtime/v1/realm') return '/realm';
  if (/^\/api\/runtime\/v1\/projects$/.test(pathname)) return '/projects';
  if (/^\/api\/runtime\/v1\/projects\/[^/]+$/.test(pathname)) return '/projects/:project';
  if (/^\/api\/runtime\/v1\/projects\/[^/]+\/timelines$/.test(pathname)) return '/projects/:project/timelines';
  if (/^\/api\/runtime\/v1\/projects\/[^/]+\/timelines\/[^/]+$/.test(pathname)) return '/projects/:project/timelines/:timeline';
  if (/^\/api\/runtime\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commits$/.test(pathname)) return '/projects/:project/timelines/:timeline/commits';
  if (/^\/api\/runtime\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/.test(pathname)) return '/projects/:project/timelines/:timeline/commit';
  return undefined;
}

function endpointComponents(harness: DirectHarness) {
  const parsedRuntime = new URL(harness.runtimeUrl);
  return {
    hosted: { host: new URL(harness.origin).hostname, port: Number(new URL(harness.origin).port), path: '/tools/video-editor' },
    door: { host: '127.0.0.1', port: harness.doorPort, prefix: harness.doorPrefix },
    runtime: { host: parsedRuntime.hostname, port: Number(parsedRuntime.port), path: parsedRuntime.pathname || '/' },
  };
}

function blankOutboxSummary(): OutboxSummary {
  return { success: false, newOwnerCount: UNKNOWN, pendingCount: UNKNOWN, intentsCount: UNKNOWN };
}

function blankConnection(): ConnectionSummary {
  return { attached: UNKNOWN, state: UNKNOWN };
}

function createDiagnostics(harness: DirectHarness): MountedReadinessDiagnostics {
  return {
    version: 1,
    endpoints: endpointComponents(harness),
    stages: [],
    notRunStages: ['connected-selection', 'fresh-owner-reconnected'],
    routeStatusErrors: [],
  };
}

function persistDiagnostics(testInfo: TestInfo, diagnostics: MountedReadinessDiagnostics): void {
  try {
    writeFileSync(testInfo.outputPath(DIAGNOSTIC_FILE), JSON.stringify(diagnostics));
  } catch {
    // Diagnostics must never replace the original assertion or make the preflight fail differently.
  }
}

function failureProjection(error: unknown, stage: string): MountedReadinessDiagnostics['failure'] {
  const bootstrapFailure = readMountedBootstrapFailure();
  if (bootstrapFailure && stage === 'before-load') return bootstrapFailure;
  const timeout = error instanceof Error && error.name === 'TimeoutError';
  return { stage, code: timeout ? 'timeout' : stage === 'before-load' ? 'setup' : 'assertion', class: timeout ? 'timeout' : stage === 'before-load' ? 'setup' : 'assertion' };
}

function stageSnapshot(diagnostics: MountedReadinessDiagnostics, snapshot: StageSnapshot): void {
  diagnostics.notRunStages = diagnostics.notRunStages.filter((stage) => stage !== snapshot.stage);
  const index = diagnostics.stages.findIndex((item) => item.stage === snapshot.stage);
  if (index >= 0) diagnostics.stages[index] = snapshot;
  else if (diagnostics.stages.length < MAX_STAGES) diagnostics.stages.push(snapshot);
}

async function connectionSummary(page: Page): Promise<ConnectionSummary> {
  try {
    const locator = page.locator(UI.status);
    const attached = (await locator.count()) > 0;
    if (!attached) return { attached, state: 'MISSING' };
    const state = (await locator.getAttribute('data-state', { timeout: 1_000 })) ?? 'MISSING';
    return { attached, state: ['connected', 'connecting', 'disconnected', 'MISSING'].includes(state) ? state : UNKNOWN };
  } catch {
    return blankConnection();
  }
}

async function commandOutboxDatabaseExists(page: Page): Promise<boolean> {
  return page.evaluate(async () => (await indexedDB.databases()).some((database) => database.name === 'astrid.command-outbox'));
}

async function readExistingCommandOutboxes(page: Page, timelineId: string): Promise<ReadonlyOutboxRead<Awaited<ReturnType<typeof commandOutboxes>>>> {
  return readExistingReadonly(
    () => commandOutboxDatabaseExists(page),
    () => commandOutboxes(page, timelineId),
  );
}

async function selectionEquality(page: Page, harness: DirectHarness): Promise<Unknownable<boolean>> {
  try {
    const project = page.getByRole('combobox', { name: 'Select project' });
    const timeline = page.getByRole('combobox', { name: 'Select timeline' });
    const track = page.getByRole('textbox', { name: 'Track name' }).first();
    const projectText = await project.textContent({ timeout: 1_000 });
    return Boolean(projectText?.includes(harness.seed.projectName))
      && await timeline.isVisible({ timeout: 1_000 })
      && await track.isVisible({ timeout: 1_000 });
  } catch {
    return UNKNOWN;
  }
}

async function outboxSummary(page: Page, timelineId: string, previousOwnerIds: ReadonlySet<string>): Promise<OutboxSummary> {
  const read = await readExistingCommandOutboxes(page, timelineId);
  if (read.status === 'unknown') return blankOutboxSummary();
  const owners = read.value;
  return {
    success: true,
    newOwnerCount: owners.filter((owner) => !previousOwnerIds.has(owner.ownerId)).length,
    pendingCount: owners.filter((owner) => Boolean(owner.pending)).length,
    intentsCount: owners.reduce((total, owner) => total + owner.intents.length, 0),
  };
}

function attachRouteStatusErrors(page: Page, diagnostics: MountedReadinessDiagnostics, currentStage: () => string): void {
  page.on('response', (response) => {
    if (response.status() < 400 || diagnostics.routeStatusErrors.length >= MAX_ROUTE_STATUS_ERRORS) return;
    const route = safeRoute(response.url());
    if (!route) return;
    diagnostics.routeStatusErrors.push({
      stage: currentStage(), route, status: response.status(), code: `http_${response.status()}`, class: 'route-status',
    });
  });
}

appTest.beforeEach(async ({ context }, testInfo) => {
  await installMountedBootstrapDiagnostics(context, testInfo);
});

async function snapshot(
  page: Page,
  seed: ThreeProductsSeed,
  previousOwnerIds: ReadonlySet<string>,
  stage: string,
  diagnostics: MountedReadinessDiagnostics,
  testInfo: TestInfo,
  values: Partial<Pick<StageSnapshot, 'status' | 'actualConnected' | 'readonlyOutbox' | 'selectionEquality'>> = {},
): Promise<StageSnapshot> {
  const result: StageSnapshot = {
    stage,
    status: values.status ?? blankConnection(),
    actualConnected: values.actualConnected ?? UNKNOWN,
    readonlyOutbox: values.readonlyOutbox ?? await outboxSummary(page, seed.timelineId, previousOwnerIds),
    selectionEquality: values.selectionEquality ?? UNKNOWN,
  };
  stageSnapshot(diagnostics, result);
  persistDiagnostics(testInfo, diagnostics);
  return result;
}

test('D28 mounted readiness: connected editor claims a fresh scoped owner before any gesture', async ({ page, harness, seed3, environment }, testInfo) => {
  const diagnostics = createDiagnostics(harness);
  observeHarnessEnvironment(environment, harness);
  recordD21Stage(environment, 'before-load', 'NOTRUN');
  await persistD21Environment(testInfo, environment);
  let currentStage = 'before-load';
  attachRouteStatusErrors(page, diagnostics, () => currentStage);
  const websocketUrls: string[] = [];
  page.on('websocket', (socket) => { websocketUrls.push(socket.url()); });
  stageSnapshot(diagnostics, { stage: 'before-load', status: blankConnection(), actualConnected: UNKNOWN, readonlyOutbox: blankOutboxSummary(), selectionEquality: UNKNOWN });
  persistDiagnostics(testInfo, diagnostics);
  let initialOutboxRead: ReadonlyOutboxRead<Awaited<ReturnType<typeof commandOutboxes>>> = { status: 'unknown', reason: 'unavailable' };
  try {
    // A fresh context has no IndexedDB until the real editor mounts a verified timeline.
    // This is the production bootstrap boundary; the subsequent blank-page read remains readonly.
    await bootstrapMountedBaseline(page.context(), harness);
    await page.goto(`${harness.origin}/__blank.html`);
    observeD21Page(environment, { url: page.url() });
    recordD21Stage(environment, 'before-load', 'OBSERVED');
    await persistD21Environment(testInfo, environment);
    initialOutboxRead = await readExistingCommandOutboxes(page, seed3.timelineId);
  } catch {
    // The setup read is intentionally readonly; the diagnostics retain UNKNOWN rather than exposing an error.
  }
  const previousOwners = initialOutboxRead.status === 'verified' ? initialOutboxRead.value : [];
  const previousOwnerIds = new Set(previousOwners.map((owner) => owner.ownerId));

  await snapshot(page, seed3, previousOwnerIds, currentStage, diagnostics, testInfo, {
    readonlyOutbox: initialOutboxRead.status === 'verified'
      ? { success: true, newOwnerCount: 0, pendingCount: previousOwners.filter((owner) => Boolean(owner.pending)).length, intentsCount: previousOwners.reduce((total, owner) => total + owner.intents.length, 0) }
      : blankOutboxSummary(),
  });
  try {
    expect(initialOutboxRead.status, 'the mounted preflight must verify the scoped outbox before loading the editor').toBe('verified');
  } catch (error) {
    diagnostics.failure = failureProjection(error, currentStage);
    recordD21Error(environment, diagnostics.failure);
    persistDiagnostics(testInfo, diagnostics);
    await persistD21Environment(testInfo, environment).catch(() => {});
    throw error;
  }

  try {
    currentStage = 'connected-selection';
    await openApp(page, harness);
    observeD21Page(environment, { url: page.url() });
    const connected = await connectionSummary(page);
    await snapshot(page, seed3, previousOwnerIds, currentStage, diagnostics, testInfo, {
      status: connected,
      actualConnected: connected.attached === true && connected.state === 'connected',
      selectionEquality: await selectionEquality(page, harness),
    });
    await expectConnected(page);
    await openSeededTimeline(page, harness);
    const selected = await connectionSummary(page);
    const selectedEquality = await selectionEquality(page, harness);
    await snapshot(page, seed3, previousOwnerIds, currentStage, diagnostics, testInfo, {
      status: selected,
      actualConnected: isFreshlyConnected(selected),
      selectionEquality: selectedEquality,
    });
    expect(isFreshlyConnected(selected), 'the mounted editor must remain connected after selection').toBe(true);
    expect(selectedEquality, 'the mounted editor must show the selected seeded timeline').toBe(true);
    recordD21Readiness(environment, true, 'UNKNOWN');
    recordD21Stage(environment, 'connected-selection', 'OBSERVED');
    await persistD21Environment(testInfo, environment);

    currentStage = 'fresh-owner-reconnected';
    await snapshot(page, seed3, previousOwnerIds, currentStage, diagnostics, testInfo);
    await expect.poll(async () => {
      const read = await readExistingCommandOutboxes(page, seed3.timelineId);
      const owners = read.status === 'verified' ? read.value : [];
      const ready = read.status === 'verified' && hasFreshSettledOwner(owners, previousOwnerIds);
      await snapshot(page, seed3, previousOwnerIds, currentStage, diagnostics, testInfo, {
        readonlyOutbox: read.status === 'verified'
          ? {
            success: true,
            newOwnerCount: owners.filter((owner) => !previousOwnerIds.has(owner.ownerId)).length,
            pendingCount: owners.filter((owner) => Boolean(owner.pending)).length,
            intentsCount: owners.reduce((total, owner) => total + owner.intents.length, 0),
          }
          : blankOutboxSummary(),
      });
      return ready;
    }, { ...CEILING, message: 'the mounted editor must claim a new durable command owner before the gesture' }).toBe(true);
    const reconnected = await connectionSummary(page);
    await snapshot(page, seed3, previousOwnerIds, currentStage, diagnostics, testInfo, {
      status: reconnected,
      actualConnected: reconnected.attached === true && reconnected.state === 'connected',
    });
    await expectConnected(page);
    observeD21Page(environment, { url: page.url(), websocket: websocketUrls[0] });
    recordD21Readiness(environment, true, true);
    recordD21Stage(environment, 'fresh-owner-reconnected', 'OBSERVED');
    await persistD21Environment(testInfo, environment);
  } catch (error) {
    diagnostics.failure = failureProjection(error, currentStage);
    recordD21Stage(environment, currentStage, 'FAILED');
    environment.status = 'failed';
    if (websocketUrls.length > 0) observeD21Page(environment, { url: page.url(), websocket: websocketUrls[0] });
    await persistD21Environment(testInfo, environment).catch(() => {});
    throw error;
  } finally {
    persistDiagnostics(testInfo, diagnostics);
    await persistD21Environment(testInfo, environment).catch(() => {});
  }
});

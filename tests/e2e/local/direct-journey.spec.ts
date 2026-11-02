/**
 * Plan A journey harness (phase A0): the hosted app used from a browser on the same machine as the
 * user's Runtime, through the Runtime's own browser door (tasks/2026-10-16-plan-a-same-machine-direct.md §3;
 * astrid-runtime `runtime_protocol/door.py`). Nothing from this repo runs between the page and the Runtime.
 *
 *   npm run test:e2e:direct            # builds dist if it is stale, then runs this file
 *
 * Not part of `npm test`. CI runs it from .github/workflows/direct-journey.yml (pull requests touching the launcher,
 * runtime integration or media helpers; nightly; on demand), which expects exactly the expected failures below.
 *
 * What runs: a production build served over HTTPS at https://astrid.test:<port> (test certificate made at
 * run time, host mapped by Chromium's --host-resolver-rules, the page marked "public" with
 * --ip-address-space-overrides so Chromium applies its public -> loopback rules), and a real Runtime daemon on a
 * throwaway SQLite realm whose door listens on its well-known port (17340, override with ASTRID_APP_DIRECT_DOOR_PORT).
 * See support/harness.ts for how each is started and torn down.
 *
 * Design: tasks/2026-10-16-plan-a-same-machine-direct.md (revision 3): the App reaches the door at
 * http://127.0.0.1:17340/api/runtime and /api/astrid with the hosted Origin as the only credential, probes with
 * /api/runtime/v1/health, and asks Chrome for the local-network permission only after a Connect click.
 *
 * Expected failures: cases that need App or door behaviour that does not exist yet are marked as expected
 * failures, each with a `known-failure:` comment naming the cause (file:line) and the card that fixes it
 * (tasks/2026-10-16-plan-a-execution.md). When the card lands, the case starts passing, Playwright reports it as
 * an unexpected pass, and the marker comes off in the same commit that lowers the budget in
 * scripts/quality/check-known-failures.mjs. The budget must equal the number of markers in this file.
 *
 * App contract the UI cases assert (A2.S and A2.P chose these names):
 *   [data-testid="runtime-connection-status"][data-state="connected"]   the status container: nothing visible while connected (screen-reader text only)
 *   [data-testid="runtime-not-connected"]                               the connection panel (permission, blocked, unanswered, update needed)
 *   a button named "Connect" in the permission panel                    triggers Chrome's local-network prompt
 *   a visible install/update command and a button named "Copy" inside that panel
 *   a button named "Reload" in the "Astrid restarted" card; the "Astrid stopped" card clears by itself
 */
import { expect, type Page, type Route } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BIG_DOWNLOAD_BYTES, BIG_UPLOAD_BYTES, DirectHarness, DOOR_PORT, rawRequest, sha256Hex, compositionPublication } from './support/harness.ts';
import { APP_ENTRY_ROUTE, UI, currentHead, editFirstTrackName, expectConnected, firstTrackName, holdTimelineSaves, openApp, openSeededTimeline, revisionBody, test, waitForAudit } from './support/app.ts';
import { skipWhen } from '../support/declaredSkip.ts';
import { SpeedTable } from './support/measure.ts';
import { LOCAL_NETWORK_PERMISSION, readLocalNetworkState, setLocalNetworkPermission } from './support/permission.ts';

/** The Runtime's RSS (it serves the door) may grow by at most this much while streaming a 60 or 200 MB body ("bounded" means well under the file size). */
const RUNTIME_RSS_GROWTH_LIMIT = 100 * 1024 * 1024;
/** The realm's display name (harness.ts creates the realm and starts the Runtime with it); the Runtime reports it, the page no longer shows it. */
const REALM_DISPLAY_NAME = 'Direct Journey';

test.describe.configure({ mode: 'serial' });
test.beforeEach(() => {
  skipWhen('direct-journey-harness');
});

const speed = new SpeedTable();
let lastDownload: Buffer | undefined;

// ---------------------------------------------------------------------------------------------
// Helpers

interface PageResponse { status: number; headers: Record<string, string>; text: string }

/** fetch() executed inside the page, so CORS, preflights and local-network rules apply as in a real visit. */
async function pageFetch(page: Page, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<PageResponse> {
  return page.evaluate(async ({ url, init }) => {
    const response = await fetch(url, init);
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), text: await response.text() };
  }, { url, init });
}

const json = <T = any>(response: PageResponse): T => JSON.parse(response.text);

async function openHostedPage(page: Page, harness: DirectHarness) {
  await page.goto(`${harness.origin}/__blank.html`);
}

function reportRss(what: string, baselineBytes: number, growthBytes: number) {
  const description = `${what}: Runtime RSS baseline ${(baselineBytes / 1048576).toFixed(0)} MB, peak growth ${(growthBytes / 1048576).toFixed(0)} MB (limit ${RUNTIME_RSS_GROWTH_LIMIT / 1048576} MB)`;
  test.info().annotations.push({ type: 'runtime-rss', description });
}

/**
 * Nothing rides in the URL: the visit opened the bare workspace route, and nothing is added to it but the editor's own
 * project and timeline selection (the editor writes that once it has picked a project). No hash, no token, no link.
 */
function expectBareUrl(page: Page, harness: DirectHarness) {
  const url = new URL(page.url());
  expect(url.origin).toBe(harness.origin);
  expect(url.pathname).toBe(APP_ENTRY_ROUTE);
  expect(url.hash).toBe('');
  expect([...url.searchParams.keys()].filter((key) => !['project', 'timeline'].includes(key))).toEqual([]);
}

/** The App's probe, as a raw request: `GET /api/runtime/v1/health` with the hosted Origin (or the given Origin and Host). */
function healthProbe(harness: DirectHarness, options: { origin?: string | null; host?: string; path?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.origin !== null) headers.Origin = options.origin ?? harness.origin;
  return rawRequest({ port: harness.doorPort, path: options.path ?? '/api/runtime/v1/health', headers, host: options.host });
}

// ---------------------------------------------------------------------------------------------
// 1. Zero-click connection

test.describe('zero-click connection (App)', () => {
  test('opening the hosted origin connects to the local Runtime with nothing in the URL', async ({ page, harness }) => {
    const doorRequests = await openApp(page, harness);
    await expectConnected(page);
    expectBareUrl(page, harness);
    // The probe is the existing health route under /api/runtime; there is no /v1/connect.
    expect(doorRequests.some((request) => request.startsWith('GET ') && request.endsWith('/api/runtime/v1/health'))).toBe(true);
    expect(doorRequests.some((request) => request.endsWith('/v1/connect'))).toBe(false);
    // Nothing about the connection is visible while it holds: the editor already shows the project.
    await expect(page.locator(UI.status)).toHaveText('Connected to Astrid');
    await expect(page.locator(UI.status)).toHaveClass(/sr-only/);
    await expect(page.getByText(harness.seed.projectName)).toBeVisible();
    await expect(page.getByText(/Connected ·/)).toHaveCount(0);
  });

  test('a reload stays connected', async ({ page, harness }) => {
    await openApp(page, harness);
    await expectConnected(page);
    await page.reload();
    await expectConnected(page);
    expectBareUrl(page, harness);
  });

  test('with Astrid stopped the panel offers the install line, then connects by itself once it starts', async ({ page, harness, context }) => {
    // grantPermissions replaces the origin's grants, so the local-network permission the fixture context holds is listed again.
    await context.grantPermissions(['clipboard-read', 'clipboard-write', LOCAL_NETWORK_PERMISSION], { origin: harness.origin });
    await harness.stopRuntime(); // the door goes with it
    try {
      await openApp(page, harness);
      await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
      const panel = page.locator(UI.panel);
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('code')).toHaveText('curl -fsSL https://astrid.haus/install | sh');
      await panel.getByRole('button', { name: UI.copy }).click();
      await expect(panel.getByRole('button', { name: 'Command copied' })).toBeVisible();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toBe('curl -fsSL https://astrid.haus/install | sh');
      await harness.startRuntime();
      await expect(page.locator(UI.status)).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
      // The card shows that it worked, then leaves by itself once the editor beneath has opened.
      await expect(panel.getByText('Connected to Astrid')).toBeVisible();
      await expect(page.locator(UI.panel)).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
    } finally {
      await harness.resetToHealthy();
    }
  });
});

// The bare domain keeps its two faces: the public landing page for a first visit, the app for someone who has connected
// before (src/app/entryClassification.ts). Connecting to the Runtime for the first time is what makes a visitor a returning one.
test.describe('the bare domain (App)', () => {
  test('a first visit to the bare domain shows the landing page and sends nothing to the door', async ({ page, harness }) => {
    const doorRequests: string[] = [];
    page.on('request', (request) => { if (request.url().startsWith(`http://127.0.0.1:${DOOR_PORT}/`)) doorRequests.push(`${request.method()} ${request.url()}`); });
    const auditedBefore = harness.audit().length;
    await page.goto(`${harness.origin}/`);
    await expect(page.getByRole('heading', { level: 1, name: /creative limits/i })).toBeVisible();
    await page.waitForLoadState('load');
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator(UI.panel)).toHaveCount(0);
    await expect(page.locator(UI.status)).toHaveCount(0);
    expect(doorRequests, 'the landing page does not talk to the local Runtime').toEqual([]);
    expect(harness.audit().length, 'the door saw nothing').toBe(auditedBefore);
  });

  test('the installer root URL enters the app, connects, and preserves its other URL parts', async ({ page, harness }) => {
    const doorRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith(`http://127.0.0.1:${DOOR_PORT}/`)) {
        doorRequests.push(`${request.method()} ${request.url()}`);
      }
    });

    const initialSearch = new URLSearchParams({
      connect: '1',
      project: harness.seed.projectId,
      timeline: harness.seed.timelineId,
      source: 'installer',
    });
    await page.goto(`${harness.origin}/?${initialSearch}#continue`);
    await expectConnected(page);
    await openSeededTimeline(page, harness);

    const url = new URL(page.url());
    expect(url.pathname).toBe(APP_ENTRY_ROUTE);
    const expectedSearch = new URLSearchParams({
      project: harness.seed.projectId,
      timeline: harness.seed.timelineId,
      source: 'installer',
    });
    expect(url.search).toBe(`?${expectedSearch}`);
    expect(url.hash).toBe('#continue');
    expect(doorRequests.some((request) => request.startsWith('GET ') && request.endsWith('/api/runtime/v1/health'))).toBe(true);
  });

  test('a returning visitor at the bare domain goes straight into the app and connects with no click', async ({ page, harness }) => {
    // Connecting once is what marks this browser as one that chose the app; the context (and its localStorage) is the same for both visits.
    await openApp(page, harness);
    await expectConnected(page);

    await page.goto(`${harness.origin}/`);
    await expect(page.locator(UI.status)).toHaveAttribute('data-state', 'connected');
    // Nothing is asked of the visitor: not the landing page, not the panel, no demo project that this Runtime does not have.
    await expect(page.getByRole('heading', { level: 1, name: /creative limits/i })).toHaveCount(0);
    await expect(page.locator(UI.panel)).toHaveCount(0);
    await openSeededTimeline(page, harness);
    await expect(page.getByText('Project not found')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expectBareUrl(page, harness);
  });
});

test.describe('first time and returning panels (App)', () => {
  test('a fresh granted profile and a returning profile see the same single unanswered card', async ({ page, harness }) => {
    // Same context for both phases, so localStorage carries over; the fixture context is fresh, so nothing is remembered at the start.
    await harness.stopRuntime();
    try {
      await openApp(page, harness);
      const panel = page.locator(UI.panel);
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('heading', { name: "Astrid isn't answering on this computer" })).toBeVisible();
      await expect(panel.getByText("Your coding agent can start it, or install it if it isn't there yet.")).toBeVisible();
      await expect(panel.getByRole('code')).toHaveText('curl -fsSL https://astrid.haus/install | sh');
      await expect(panel.getByRole('button', { name: UI.copy })).toBeVisible();

      await harness.startRuntime();
      await expect(page.locator(UI.status)).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });

      await harness.stopRuntime();
      await page.reload();
      await expect(panel.getByRole('heading', { name: "Astrid isn't answering on this computer" })).toBeVisible();
      await expect(panel.getByText("Your coding agent can start it, or install it if it isn't there yet.")).toBeVisible();
      await expect(panel.getByRole('button', { name: UI.copy })).toBeVisible();
      await expect(panel.getByRole('code')).toHaveText('curl -fsSL https://astrid.haus/install | sh');
      await expect(panel.getByText('Set up Astrid on this computer')).toHaveCount(0);
    } finally {
      await harness.resetToHealthy();
    }
  });
});

// Fresh profiles see the permission explanation before any door request. The installer handoff starts the same prompt automatically.
test.describe('permission gate and readiness (App)', () => {
  test('a fresh profile sees the permission explanation before Connect asks Chrome, and the installer handoff still starts it', async ({ browser, harness }) => {
    const context = await browser.newContext({ storageState: harness.contextOptions.storageState }); // no grant: the permission reads `prompt`
    try {
      const page = await context.newPage();
      const doorRequests = await openApp(page, harness);
      expect(await readLocalNetworkState(page)).toBe('prompt');
      const panel = page.locator(UI.panel);
      await expect(panel).toHaveAttribute('data-state', 'permission');
      await expect(panel.getByRole('heading', { name: 'Connect to Astrid on this computer' })).toBeVisible();
      await expect(panel.getByText('Chrome will ask to let astrid.haus reach Astrid on this computer. Choose Allow.')).toBeVisible();
      await expect(panel.getByRole('button', { name: UI.connect })).toBeVisible();
      await expect(panel.getByRole('code')).toHaveCount(0);
      expect(doorRequests, 'a fresh profile does not probe the door before Connect').toEqual([]);

      // Connect asks Chrome. Chrome holds the door request until the person answers its prompt, and headless
      // Chromium has no prompt (it fails the request instead, leaving the permission screen in place), so the test holds the request
      // the way the prompt does and releases it with the grant.
      const heldRequests: Route[] = [];
      let promptOpen = true;
      await page.route(`http://127.0.0.1:${DOOR_PORT}/**`, (route) => (promptOpen ? void heldRequests.push(route) : void route.continue()));
      await panel.getByRole('button', { name: UI.connect }).click();
      await expect(panel).toHaveAttribute('data-state', 'pending');
      await expect(panel.getByRole('heading', { name: 'Choose Allow in Chrome' })).toBeVisible();
      await expect.poll(() => heldRequests.length, { message: 'Connect asked the door while Chrome’s prompt is open' }).toBeGreaterThan(0);
      promptOpen = false;
      await context.grantPermissions([LOCAL_NETWORK_PERMISSION], { origin: harness.origin });
      await Promise.all(heldRequests.splice(0).map((route) => route.continue().catch(() => undefined)));
      await expectConnected(page);
      expect(doorRequests.length).toBeGreaterThan(0);

      // Clearing the grant simulates a fresh permission prompt for the installer handoff. Its URL flag starts Connect itself.
      await context.clearPermissions();
      const installerRequests: Route[] = [];
      let installerPromptOpen = true;
      await page.unroute(`http://127.0.0.1:${DOOR_PORT}/**`);
      await page.route(`http://127.0.0.1:${DOOR_PORT}/**`, (route) => (installerPromptOpen ? void installerRequests.push(route) : void route.continue()));
      await page.goto(`${harness.origin}/?connect=1#continue`);
      await expect(page.locator(UI.panel)).toHaveAttribute('data-state', 'pending');
      await expect(page.locator(UI.panel).getByRole('heading', { name: 'Choose Allow in Chrome' })).toBeVisible();
      await expect.poll(() => installerRequests.length, { message: 'the installer handoff starts the permission request' }).toBeGreaterThan(0);
      installerPromptOpen = false;
      await context.grantPermissions([LOCAL_NETWORK_PERMISSION], { origin: harness.origin });
      await Promise.all(installerRequests.splice(0).map((route) => route.continue().catch(() => undefined)));
      await expectConnected(page);
      expect(installerRequests.length).toBe(0);
    } finally {
      await context.close();
    }
  });

  test('a denied local-network permission shows how to allow Astrid in Chrome', async ({ browser, harness }, testInfo) => {
    const context = await browser.newContext({ storageState: harness.contextOptions.storageState });
    let override: Awaited<ReturnType<typeof setLocalNetworkPermission>> | undefined;
    try {
      const page = await context.newPage();
      // Browser.setPermission needs the browser context id, which Playwright does not expose: support/permission.ts reads it
      // from this page's target, so the page first goes to a URL that is its own.
      await page.goto(`${harness.origin}/__blank.html?permission=denied`);
      override = await setLocalNetworkPermission(browser, page, harness.origin, 'denied');
      expect(await readLocalNetworkState(page)).toBe('denied');
      const doorRequests = await openApp(page, harness);
      const panel = page.locator(UI.panel);
      await expect(panel.getByRole('heading', { name: 'Allow Astrid in Chrome' })).toBeVisible();
      await expect(panel.getByText('Local network access')).toBeVisible();
      await expect(panel.getByText('Come back here and it opens by itself.')).toBeVisible();
      await expect(panel.getByText('Connect Astrid on this computer')).toHaveCount(0);
      expect(doorRequests, 'a denied permission is not retried as if nothing were listening').toEqual([]);
      // Phone width (CP3): the steps wrap inside the card instead of scrolling the page sideways.
      await page.setViewportSize({ width: 360, height: 740 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await testInfo.attach('panel-blocked-360.png', { body: await page.screenshot(), contentType: 'image/png' });
    } finally {
      await override?.detach().catch(() => {});
      await context.close();
    }
  });

  test('G1 browser half: a door that listens before Astrid is ready shows one unanswered card, then connects by itself', async ({ page, harness }) => {
    // Listening is not readiness: without the product credential the door answers `runtime_unavailable`, as it does
    // between the daemon starting and `astrid-runtime up` provisioning that credential.
    harness.withdrawProductCredential();
    try {
      await openApp(page, harness);
      await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
      const panel = page.locator(UI.panel);
      await expect(panel.getByRole('heading', { name: "Astrid isn't answering on this computer" })).toBeVisible();
      await expect(panel.getByText("Your coding agent can start it, or install it if it isn't there yet.")).toBeVisible();
      await expect(panel.getByText('Set up Astrid on this computer')).toHaveCount(0);
      await expect(panel).not.toContainText(/Runtime|workspace|realm|gateway|door|reload/i);
      const notReadyReadings = harness.audit().filter((entry) => entry.path === '/v1/health' && entry.status === 503).length;
      expect(notReadyReadings, 'the listening door answered the health checks it could not serve yet').toBeGreaterThan(0);
      harness.restoreProductCredential();
      await expect(page.locator(UI.status)).toHaveAttribute('data-state', 'connected', { timeout: 20_000 });
      expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
      expect(harness.runtimeRunning).toBe(true);
    } finally {
      await harness.resetToHealthy();
    }
  });
});

// Revision 3 has no /v1/connect: the App probes the existing health route under /api/runtime with the hosted Origin as
// its only credential. These cases pin who the probe answers: the configured origin at Host 127.0.0.1:<port>, nobody else.
test.describe('probe through the door (door)', () => {
  test('answers the configured origin at /api/runtime/v1/health with the realm and Runtime instance', async ({ harness }) => {
    const response = await healthProbe(harness);
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(harness.origin);
    expect(response.json()).toMatchObject({ status: 'ok', protocol: 'workspace.v1', runtime_instance_id: harness.runtimeInstanceId });
    const realm = await healthProbe(harness, { path: '/api/runtime/v1/realm' });
    expect(realm.status).toBe(200);
    expect(realm.json()).toMatchObject({ realm_id: harness.realmId, display_name: REALM_DISPLAY_NAME });
    // The Astrid prefix answers the same probe; neither answer carries a secret or a link.
    const astrid = await healthProbe(harness, { path: '/api/astrid/v1/health' });
    expect(astrid.status).toBe(200);
    for (const text of [response.text, realm.text, astrid.text]) {
      expect(text).not.toContain(harness.productToken);
      expect(text).not.toContain('/session/');
    }
  });

  test('refuses another origin', async ({ harness }) => {
    expect((await healthProbe(harness)).status).toBe(200);
    const refused = await healthProbe(harness, { origin: harness.otherOrigin });
    expect(refused.status).toBe(403);
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
    expect(refused.text).not.toContain(harness.runtimeInstanceId);
    expect(refused.text).not.toContain(harness.realmId);
  });

  test('refuses a rebinding Host, including localhost', async ({ harness }) => {
    expect((await healthProbe(harness)).status).toBe(200);
    const port = harness.doorPort;
    for (const host of [`evil.test:${port}`, '127.0.0.1', 'localhost', `localhost:${port}`, `[::1]:${port}`, `127.0.0.1:${port + 1}`, `127.0.0.1.evil.test:${port}`]) {
      const refused = await healthProbe(harness, { host });
      expect(refused.status, `Host ${host}`).toBe(403);
      expect(refused.json().error, `Host ${host}`).toBe('invalid_host');
      expect(refused.text).not.toContain(harness.runtimeInstanceId);
    }
  });

  test('refuses a request without an Origin', async ({ harness }) => {
    expect((await healthProbe(harness)).status).toBe(200);
    const refused = await healthProbe(harness, { origin: null });
    expect(refused.status).toBe(403);
    expect(refused.json().error).toBe('hosted_origin_required');
    expect(refused.text).not.toContain(harness.runtimeInstanceId);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Core journey

test.describe('core journey', () => {
  test('App: open the seeded project, edit, save, reload byte-identical', async ({ page, harness }) => {
    await openApp(page, harness);
    await expectConnected(page);
    await openSeededTimeline(page, harness);
    const headBefore = await currentHead(harness);
    await editFirstTrackName(page, 'Edited in the App');
    // The editor saves by itself: the Runtime's head moves to the revision the App published.
    await expect.poll(() => currentHead(harness), { timeout: 20_000 }).not.toBe(headBefore);
    const before = await revisionBody(harness, await currentHead(harness));
    await page.reload();
    await expectConnected(page);
    await openSeededTimeline(page, harness);
    await expect(firstTrackName(page)).toHaveValue('Edited in the App');
    const after = await revisionBody(harness, await currentHead(harness));
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test('App: a second writer saves first, the App shows the conflict and keeps the draft', async ({ page, harness }) => {
    await openApp(page, harness);
    await expectConnected(page);
    await openSeededTimeline(page, harness);
    const head = await currentHead(harness);
    const second = await harness.runtimeJson('POST', `/v1/projects/${harness.seed.projectId}/timelines/${harness.seed.timelineId}/composition-revisions`, compositionPublication(harness.seed, head, 'Second writer', 24));
    expect(second.status).toBe(200);
    await editFirstTrackName(page, 'Draft from the first writer');
    const conflict = page.getByRole('alertdialog', { name: 'This timeline changed somewhere else' });
    await expect(conflict).toBeVisible({ timeout: 20_000 });
    await expect(conflict.getByText('Keep your changes, or switch to the latest version.')).toBeVisible();
    await expect(conflict.getByRole('button', { name: 'Keep my changes' })).toBeVisible();
    await expect(conflict.getByRole('button', { name: 'Use latest version' })).toBeVisible();
    // The dialog is modal, so the editor behind it is hidden from the accessibility tree but still holds the draft.
    const draftField = page.getByRole('textbox', { name: 'Track name', includeHidden: true }).first();
    await expect(draftField).toHaveValue('Draft from the first writer');
    // The stale save was refused, not applied: the second writer's revision is still the head.
    expect(await currentHead(harness)).toBe(second.body.data.new_head);
  });

  test('through the hosted origin: open, read the timeline, save with the expected head, reload byte-identical', async ({ page, harness }) => {
    const { projectId, timelineId } = harness.seed;
    await openHostedPage(page, harness);
    const call = (suffix: string, init?: Parameters<typeof pageFetch>[2]) => pageFetch(page, `${harness.doorBase}${suffix}`, init);

    const projects = await call('/v1/projects?limit=100');
    expect(projects.status).toBe(200);
    expect(json(projects).items.map((item: any) => item.project_id)).toContain(projectId);

    const inspectPath = `/v1/projects/${projectId}/timelines/${timelineId}/inspect`;
    const read = await call(inspectPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(read.status).toBe(200);
    const direct = await harness.runtimeFetch(inspectPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(read.text).toBe(await direct.text());

    const head = await currentHead(harness);
    const publication = compositionPublication(harness.seed, head, 'Main (edited through the door)', 24);
    const saved = await call(`/v1/projects/${projectId}/timelines/${timelineId}/composition-revisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(publication),
    });
    expect(saved.status, saved.text).toBe(200);
    const newHead: string = json(saved).data.new_head;
    expect(newHead).not.toBe(head);

    const revisionPath = `/v1/projects/${projectId}/timelines/${timelineId}/composition-revisions/${newHead}`;
    const beforeReload = await call(revisionPath);
    expect(beforeReload.status).toBe(200);
    expect(beforeReload.text).toContain('Main (edited through the door)');
    const afterReadInspect = await call(inspectPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

    await page.reload();
    const afterReload = await call(revisionPath);
    expect(afterReload.text).toBe(beforeReload.text);
    expect((await call(inspectPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).text).toBe(afterReadInspect.text);
    // And the bytes the Runtime holds are the same bytes the page saw.
    expect(await (await harness.runtimeFetch(revisionPath)).text()).toBe(afterReload.text);
  });

  test('through the hosted origin: a second writer saves first, the stale save is refused and the first writer keeps its draft', async ({ page, harness }) => {
    const { projectId, timelineId } = harness.seed;
    await openHostedPage(page, harness);
    const publishUrl = `${harness.doorBase}/v1/projects/${projectId}/timelines/${timelineId}/composition-revisions`;
    const head = await currentHead(harness);
    const draft = compositionPublication(harness.seed, head, 'First writer draft', 12); // held by the caller

    const second = await harness.runtimeJson('POST', `/v1/projects/${projectId}/timelines/${timelineId}/composition-revisions`, compositionPublication(harness.seed, head, 'Second writer', 24));
    expect(second.status).toBe(200);

    const refused = await pageFetch(page, publishUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'journey-stale-save' }, body: JSON.stringify(draft) });
    expect(refused.status).toBe(409);
    expect(json(refused).details).toMatchObject({ reason: 'stale_head', expected_head: head, actual_head: second.body.data.new_head });
    // Nothing of the draft reached the Runtime; the draft object itself is untouched for a retry.
    expect(await currentHead(harness)).toBe(second.body.data.new_head);
    expect(draft.expected_head).toBe(head);
    expect(draft.parent_composition.name).toBe('First writer draft');
    const rebased = await pageFetch(page, publishUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'journey-rebased-save' }, body: JSON.stringify({ ...draft, expected_head: second.body.data.new_head }) });
    expect(rebased.status, rebased.text).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Media and big files

test.describe('media', () => {
  const objectUrl = (harness: DirectHarness, objectId: string) => `${harness.doorBase}/v1/objects/${encodeURIComponent(objectId)}`;

  test('an image element loads with crossorigin=anonymous (Origin), and without it is refused', async ({ page, harness }) => {
    await openHostedPage(page, harness);
    const src = objectUrl(harness, harness.seed.image.objectId);
    const load = (variant: 'cors' | 'plain' | 'referrer-origin') => page.evaluate(({ src, variant }) => new Promise<number[] | string>((resolve) => {
      const image = new Image();
      if (variant === 'cors') image.crossOrigin = 'anonymous';
      if (variant === 'referrer-origin') image.referrerPolicy = 'origin';
      image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
      image.onerror = () => resolve('error');
      image.src = `${src}?${variant}=1`;
    }), { src, variant });
    expect(await load('cors'), 'crossorigin=anonymous').toEqual([64, 48]);
    // Plan A D5: the default referrer policy sends no Referer on https -> http, and the door accepts no Referer in
    // place of Origin (A3.R removed that fallback), so media must say crossorigin; even a Referer sent on purpose is refused.
    expect(await load('plain'), 'no crossorigin attribute, default referrer policy').toBe('error');
    expect(await load('referrer-origin'), 'no crossorigin attribute, referrerpolicy=origin').toBe('error');
    const objectPath = `/v1/objects/${harness.seed.image.objectId}`;
    const served = await waitForAudit(harness, (entry) => entry.path === objectPath && entry.status === 200);
    expect(served.some((entry) => entry.origin === harness.origin)).toBe(true); // browser sent Origin
    expect(served.every((entry) => entry.origin === harness.origin), 'every success carried the hosted Origin').toBe(true);
    const refused = harness.audit().filter((entry) => entry.path === objectPath && entry.origin === null && entry.status === 403);
    expect(refused.length, 'the plain and the referrer-policy requests').toBe(2);
  });

  test('a video poster follows the video\'s crossorigin: with it the door sees Origin, without it the poster is refused', async ({ page, harness }) => {
    await openHostedPage(page, harness);
    const src = objectUrl(harness, harness.seed.image.objectId);
    const objectPath = `/v1/objects/${harness.seed.image.objectId}`;
    // The poster is an image the video element fetches, so the video's attribute decides whether it sends Origin.
    // Each variant is a fresh URL, and the door's audit entry for it is the one new request on this object.
    const posterRequest = async (variant: 'cors' | 'plain') => {
      const before = harness.audit().length;
      await page.evaluate(({ src, variant }) => {
        const video = document.createElement('video');
        if (variant === 'cors') video.crossOrigin = 'anonymous';
        video.poster = `${src}?poster-${variant}=1`;
        document.body.append(video);
      }, { src, variant });
      await expect.poll(() => harness.audit().slice(before).filter((entry) => entry.path === objectPath).length, { message: `the ${variant} poster reached the door` }).toBe(1);
      return harness.audit().slice(before).find((entry) => entry.path === objectPath)!;
    };
    expect(await posterRequest('cors'), 'poster of a video with crossorigin=anonymous').toMatchObject({ origin: harness.origin, status: 200 });
    expect(await posterRequest('plain'), 'poster of a video without crossorigin').toMatchObject({ origin: null, status: 403 });
  });

  test('a video loads, and seeking it is a 206 Range read', async ({ page, harness }) => {
    const { video } = harness.seed;
    skipWhen('direct-journey-ffmpeg');
    await openHostedPage(page, harness);
    const result = await page.evaluate(({ src }) => new Promise<{ duration: number; seekedTo: number } | string>((resolve) => {
      const element = document.createElement('video');
      element.crossOrigin = 'anonymous';
      element.muted = true;
      element.preload = 'auto';
      element.onerror = () => resolve(`error ${element.error?.code}`);
      element.onloadedmetadata = () => { element.currentTime = element.duration * 0.6; };
      element.onseeked = () => resolve({ duration: element.duration, seekedTo: element.currentTime });
      element.src = src;
      document.body.append(element);
    }), { src: objectUrl(harness, video.objectId) });
    expect(typeof result).toBe('object');
    const outcome = result as { duration: number; seekedTo: number };
    expect(outcome.duration).toBeGreaterThan(10);
    expect(outcome.seekedTo).toBeGreaterThan(5);
    const ranged = await waitForAudit(harness, (entry) => entry.path === `/v1/objects/${video.objectId}` && entry.status === 206);
    expect(ranged.length).toBeGreaterThan(0);
  });

  test('Range reads return 206 with the exact bytes, an unsatisfiable range is refused', async ({ page, harness }) => {
    const { video } = harness.seed;
    await openHostedPage(page, harness);
    const url = objectUrl(harness, video.objectId);
    const whole = Buffer.from(await (await harness.runtimeFetch(`/v1/objects/${encodeURIComponent(video.objectId)}`)).arrayBuffer());
    expect(sha256Hex(whole)).toBe(video.digest);

    const slice = await page.evaluate(async ({ url }) => {
      const response = await fetch(url, { headers: { Range: 'bytes=100-1123' } });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return { status: response.status, contentRange: response.headers.get('content-range'), acceptRanges: response.headers.get('accept-ranges'), length: bytes.length, digest: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('') };
    }, { url });
    expect(slice.status).toBe(206);
    expect(slice.contentRange).toBe(`bytes 100-1123/${whole.length}`);
    expect(slice.length).toBe(1024);
    expect(slice.digest).toBe(createHash('sha256').update(whole.subarray(100, 1124)).digest('hex'));

    const tail = await pageFetch(page, url, { headers: { Range: 'bytes=-64' } });
    expect(tail.status).toBe(206);
    expect(tail.headers['content-range']).toBe(`bytes ${whole.length - 64}-${whole.length - 1}/${whole.length}`);
    const beyond = await pageFetch(page, url, { headers: { Range: `bytes=${whole.length + 10}-` } });
    expect(beyond.status).toBe(416);
  });

  test('a 60 MB download keeps its digest and the door streams it in bounded memory', async ({ page, harness }) => {
    const { big } = harness.seed;
    await openHostedPage(page, harness);
    const { result, growthBytes, baselineBytes } = await harness.withRssSampling(() => page.evaluate(async ({ url }) => {
      const response = await fetch(url);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return { status: response.status, length: bytes.length, contentLength: response.headers.get('content-length'), digest: `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}` };
    }, { url: objectUrl(harness, big.objectId) }));
    expect(result.status).toBe(200);
    expect(result.length).toBe(BIG_DOWNLOAD_BYTES);
    expect(result.contentLength).toBe(String(BIG_DOWNLOAD_BYTES));
    expect(result.digest).toBe(big.digest);
    reportRss('60 MB download', baselineBytes, growthBytes);
    expect(growthBytes).toBeLessThan(RUNTIME_RSS_GROWTH_LIMIT);
  });

  test('a 200 MB upload from the page keeps its digest and the door streams it in bounded memory', async ({ page, harness }) => {
    await openHostedPage(page, harness);
    const { result, growthBytes, baselineBytes } = await harness.withRssSampling(() => page.evaluate(async ({ url, bytes, projectUrl }) => {
      const chunk = new Uint8Array(1024 * 1024);
      const parts: Uint8Array[] = [];
      for (let i = 0; i < bytes / chunk.length; i++) {
        const part = new Uint8Array(chunk.length);
        for (let offset = 0; offset < part.length; offset += 65536) crypto.getRandomValues(part.subarray(offset, offset + 65536));
        parts.push(part);
      }
      const blob = new Blob(parts as BlobPart[], { type: 'application/octet-stream' });
      const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
      const response = await fetch(`${url}${projectUrl}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': crypto.randomUUID(), 'X-Original-Name': 'upload-200mb.bin' }, body: blob });
      const body = await response.json();
      return { status: response.status, digest: body?.data?.digest, size: body?.data?.size, expected: `sha256:${Array.from(expected, (b) => b.toString(16).padStart(2, '0')).join('')}` };
    }, { url: harness.doorBase, bytes: BIG_UPLOAD_BYTES, projectUrl: `/v1/projects/${harness.seed.projectId}/objects` }));
    expect(result.status).toBe(201);
    expect(result.size).toBe(BIG_UPLOAD_BYTES);
    expect(result.digest).toBe(result.expected);
    reportRss('200 MB upload', baselineBytes, growthBytes);
    expect(growthBytes).toBeLessThan(RUNTIME_RSS_GROWTH_LIMIT);
    // The Runtime holds exactly those bytes.
    const stored = await harness.runtimeFetch(`/v1/objects/${encodeURIComponent(result.digest)}`, { method: 'HEAD' });
    expect(stored.status).toBe(200);
    expect(stored.headers.get('content-length')).toBe(String(BIG_UPLOAD_BYTES));
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Restarts

test.describe('restarts', () => {
  test.afterEach(async ({ harness }) => { await harness.resetToHealthy(); });

  test('the Runtime comes back on a new port with the same realm, data and credential', async ({ harness }) => {
    const { oldPort, oldInstanceId } = await harness.restartRuntime();
    expect(harness.runtimePort).not.toBe(oldPort);
    expect(harness.runtimeInstanceId).not.toBe(oldInstanceId);
    const realm = await harness.runtimeJson('GET', '/v1/realm');
    expect(realm.status).toBe(200);
    expect(JSON.stringify(realm.body)).toContain(harness.realmId);
    const projects = await harness.runtimeJson('GET', '/v1/projects?limit=100');
    expect(projects.body.items.map((item: any) => item.project_id)).toContain(harness.seed.projectId);
    const image = await harness.runtimeFetch(`/v1/objects/${encodeURIComponent(harness.seed.image.objectId)}`);
    expect(sha256Hex(Buffer.from(await image.arrayBuffer()))).toBe(harness.seed.image.digest);
  });

  test('the door comes back on its fixed port when the Runtime restarts on a new one', async ({ harness }) => {
    await harness.restartRuntime();
    const response = await harness.doorRequest('/v1/health');
    expect(response.status).toBe(200);
    expect(response.json().runtime_instance_id).toBe(harness.runtimeInstanceId);
  });

  test('App: an Astrid restart on a new port shows the restart card, and Reload reconnects with the draft kept', async ({ page, harness }) => {
    await openApp(page, harness);
    await expectConnected(page);
    await openSeededTimeline(page, harness);
    const releaseSaves = await holdTimelineSaves(page);
    await editFirstTrackName(page, 'Draft kept across the restart');
    await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });

    // The Runtime comes back on a new port, and its door on the same fixed one.
    await harness.restartRuntime();
    await expect(page.getByRole('heading', { name: 'Astrid restarted' })).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), 'the page does not reload by itself').toBe(true);
    // One recovery path: the editor's own technical cards stay out of the way, and the save badge is neutral.
    await expect(page.getByText('Workspace connection unavailable')).toHaveCount(0);
    await expect(page.getByText('Reload needed')).toHaveCount(0);
    await expect(page.getByText('Not saved', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: UI.reload }).click();
    await expectConnected(page);
    await expect(page.getByRole('heading', { name: 'Astrid restarted' })).toHaveCount(0);
    // The draft survives the reload: the editor offers it back as a recovered draft, and Save them saves it.
    await openSeededTimeline(page, harness);
    const recovered = page.getByRole('alert').filter({ hasText: 'You have unsaved changes' });
    await expect(recovered).toBeVisible();
    const headBefore = await currentHead(harness);
    await releaseSaves();
    await recovered.getByRole('button', { name: 'Save them' }).click();
    await expect.poll(() => currentHead(harness), { timeout: 20_000 }).not.toBe(headBefore);
    await expect(firstTrackName(page)).toHaveValue('Draft kept across the restart');
  });

  test('App: a stale-build reload waits for a durable timeline save before reloading', async ({ page, harness }) => {
    await page.route('**/build.json', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ app: 'older-or-newer-app-build', release: 0 }) }));
    await openApp(page, harness);
    await expectConnected(page);
    await openSeededTimeline(page, harness);
    const headBefore = await currentHead(harness);
    const reloadButton = page.getByRole('status').getByRole('button', { name: 'Reload' });
    await expect(reloadButton).toBeVisible();
    let release!: () => void;
    let signalRequest!: () => void;
    const saveStarted = new Promise<void>((resolve) => { signalRequest = resolve; });
    await page.route(/\/timelines\/[^/]+\/composition-revisions$/, async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      signalRequest();
      await new Promise<void>((resolve) => { release = resolve; });
      await route.continue();
    });
    await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
    await editFirstTrackName(page, 'Saved before App reload');
    await reloadButton.click();
    await saveStarted;
    await expect(page.getByRole('status').getByRole('button', { name: 'Saving drafts…' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), 'reload waits while the save is unacknowledged').toBe(true);
    const pageReload = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    release();
    await pageReload;
    await expectConnected(page);
    await openSeededTimeline(page, harness);
    await expect.poll(() => currentHead(harness), { timeout: 20_000 }).not.toBe(headBefore);
    await expect(firstTrackName(page)).toHaveValue('Saved before App reload');
    await expect(page.getByRole('alert').filter({ hasText: 'You have unsaved changes' })).toHaveCount(0);
    await page.unroute('**/build.json');
  });

  test('App: a stale-build reload stays open and shows an error when timeline persistence fails', async ({ page, harness }) => {
    await page.route('**/build.json', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ app: 'older-or-newer-app-build', release: 0 }) }));
    await openApp(page, harness);
    await expectConnected(page);
    await openSeededTimeline(page, harness);
    const headBefore = await currentHead(harness);
    await page.route(/\/timelines\/[^/]+\/composition-revisions$/, async route => {
      if (route.request().method() === 'POST') return route.abort('failed');
      return route.fallback();
    });
    await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
    await editFirstTrackName(page, 'Keep this unsaved draft');
    const reloadButton = page.getByRole('status').getByRole('button', { name: 'Reload' });
    await expect(reloadButton).toBeVisible();
    await reloadButton.click();
    const reloadError = page.getByRole('alert').filter({ hasText: 'Could not safely reload' });
    await expect(reloadError).toContainText('Timeline:');
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), 'failed persistence prevents navigation').toBe(true);
    await expect(firstTrackName(page)).toHaveValue('Keep this unsaved draft');
    expect(await currentHead(harness)).toBe(headBefore);
    await page.unroute('**/build.json');
  });

  test('App: Astrid stopping while the page is connected shows "Astrid stopped", and the card clears by itself when it is back', async ({ page, harness }) => {
    await openApp(page, harness);
    await expectConnected(page);
    await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });

    // The same Runtime stops being usable and becomes usable again: a Runtime that restarts is a new instance and
    // shows the restart card (above), so this is its door losing the product credential and getting it back.
    harness.withdrawProductCredential();
    try {
      await expect(page.getByRole('heading', { name: 'Astrid stopped' })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('Give these instructions to your coding agent to start Astrid again. Your changes are kept.')).toBeVisible();
      await expect(page.getByRole('button', { name: UI.copy })).toBeVisible();
      // The status no longer claims "Connected", and the editor's own technical recovery card is not there.
      await expect(page.locator(UI.status)).toHaveAttribute('data-state', 'stopped');
      await expect(page.locator(UI.status)).not.toContainText('Connected');
      await expect(page.getByText('Workspace connection unavailable')).toHaveCount(0);
      harness.restoreProductCredential();
      await expect(page.getByRole('heading', { name: 'Astrid stopped' })).toHaveCount(0, { timeout: 20_000 });
      await expectConnected(page);
      expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), 'the page carries on without a reload').toBe(true);
    } finally {
      await harness.resetToHealthy();
    }
  });

  test('a stopped Runtime takes its door with it (Node and the page are refused); started again it serves on the same fixed port', async ({ page, harness }) => {
    await openHostedPage(page, harness);
    const before = harness.doorBase;
    await harness.stopRuntime();
    await expect(rawRequest({ port: harness.doorPort, path: '/api/runtime/v1/health', headers: { Origin: harness.origin } })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    const fromPage = await page.evaluate(async (url) => { try { await fetch(url); return 'responded'; } catch { return 'failed'; } }, `${before}/v1/health`);
    expect(fromPage).toBe('failed');

    await harness.startRuntime();
    expect(harness.doorBase).toBe(before);
    expect(new URL(before).port).toBe(String(DOOR_PORT));
    const health = await pageFetch(page, `${before}/v1/health`);
    expect(health.status).toBe(200);
    expect(json(health).runtime_instance_id).toBe(harness.runtimeInstanceId);
    const projects = await harness.doorRequest('/v1/projects?limit=100');
    expect(projects.json().items.map((item: any) => item.project_id)).toContain(harness.seed.projectId);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Security

test.describe('security', () => {
  test('another origin is refused by the door (Node) and cannot read anything from a page', async ({ page, harness }) => {
    const refused = await harness.doorRequest('/v1/projects?limit=100', { origin: harness.otherOrigin });
    expect(refused.status).toBe(403);
    expect(refused.json().error).toBe('hosted_origin_required');
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
    expect(refused.text).not.toContain(harness.seed.projectId);
    const sameSite = await harness.doorRequest('/v1/projects?limit=100', { origin: `https://${'astrid.test'}.evil.test:${harness.originPort}` });
    expect(sameSite.status).toBe(403);
    const plainHttp = await harness.doorRequest('/v1/projects?limit=100', { origin: harness.origin.replace('https:', 'http:') });
    expect(plainHttp.status).toBe(403);

    // A page on another origin: the browser may send the request, but the page can read nothing back.
    await page.goto(`${harness.otherOrigin}/__blank.html`);
    const outcomes = await page.evaluate(async (base) => {
      const results: Record<string, string> = {};
      try { await fetch(`${base}/v1/projects?limit=100`); results.cors = 'responded'; } catch { results.cors = 'blocked'; }
      try { const response = await fetch(`${base}/v1/projects?limit=100`, { mode: 'no-cors' }); results.noCors = `${response.type}/${response.status}`; } catch { results.noCors = 'blocked'; }
      return results;
    }, harness.doorBase);
    expect(outcomes.cors).toBe('blocked');
    expect(['blocked', 'opaque/0']).toContain(outcomes.noCors);
    const fromEvil = harness.audit().filter((entry) => entry.origin === harness.otherOrigin);
    expect(fromEvil.every((entry) => entry.status === 403)).toBe(true);
    // The no-cors request carries no Origin and a foreign Referer: it must not have reached the Runtime either.
    expect(harness.audit().filter((entry) => entry.origin === null && entry.path.startsWith('/v1/projects') && entry.status === 200)).toHaveLength(0);
  });

  test('a rebinding Host is refused on the product routes', async ({ harness }) => {
    const port = harness.doorPort;
    for (const host of [`evil.test:${port}`, `127.0.0.1.evil.test:${port}`, '127.0.0.1', 'localhost', `localhost:${port}`, `127.0.0.1:${port + 1}`, `[::1]:${port}`, `astrid.test:${port}`]) {
      for (const requestPath of ['/api/runtime/v1/health', '/api/astrid/v1/health']) {
        const refused = await harness.doorRequest(requestPath, { host, fromRoot: true });
        expect(refused.status, `Host ${host} ${requestPath}`).toBe(403);
        expect(refused.json().error).toBe('invalid_host');
      }
    }
    expect((await harness.doorRequest('/v1/health', { host: `127.0.0.1:${port}` })).status).toBe(200);
  });

  test('the old /session/ paths and paths outside /api/runtime and /api/astrid are refused', async ({ harness }) => {
    const port = harness.doorPort;
    const capability = 'A'.repeat(43);
    for (const requestPath of ['/v1/health', '/v1/connect', `/session/${capability}/api/runtime/v1/health`, `/session/${capability}/api/astrid/v1/health`, '/session//api/runtime/v1/health', '/api/runtime', '/api/runtime/', '/api/other/v1/health', '/']) {
      // The hosted origin gets a plain 404 from the door, so the refusals below are the Origin check and not a missing route.
      const own = await rawRequest({ port, path: requestPath, headers: { Origin: harness.origin } });
      expect(own.status, requestPath).toBe(404);
      expect(own.json().error).toBe('route_not_allowed');
      // Another origin, or none, is refused before the route is looked at: it learns nothing about which paths exist.
      const foreign = await rawRequest({ port, path: requestPath, headers: { Origin: harness.otherOrigin } });
      expect(foreign.status, `another origin ${requestPath}`).toBe(403);
      expect(foreign.json().error).toBe('hosted_origin_required');
      expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
      expect((await rawRequest({ port, path: requestPath })).status, `no origin ${requestPath}`).toBe(403);
    }
    // The control: the product paths themselves are served for the same origin.
    for (const requestPath of ['/api/runtime/v1/health', '/api/astrid/v1/health']) {
      expect((await rawRequest({ port, path: requestPath, headers: { Origin: harness.origin } })).status, requestPath).toBe(200);
    }
  });

  test('admin, worker, credential, compose, ACP and unlisted routes are refused with the right origin', async ({ harness }) => {
    const refusals: Array<[string, string]> = [
      ['POST', '/v1/credentials'], ['GET', '/v1/credentials'],
      ['POST', '/v1/doctor'], ['GET', '/v1/doctor'], ['POST', '/v1/backup'], ['POST', '/v1/restore'], ['POST', '/v1/export'],
      ['POST', '/v1/realm/tombstone'], ['POST', '/v1/realm/purge'], ['POST', '/v1/realm/recover'],
      ['POST', '/v1/tasks/claim'], ['POST', '/v1/attempts/x/complete'], ['GET', '/v1/executors'], ['POST', '/v1/executors/register'],
      ['POST', '/v1/recovery/x'], ['POST', '/v1/control/local-worker/start'],
      ['DELETE', '/v1/projects/abc'], ['PUT', '/v1/projects'], ['GET', '/v1/health/../doctor'],
      ['GET', '/v1/projects/%2e%2e/doctor'], ['GET', '/v1/projects/a%252fb'], ['GET', '/v1/projects/a%2fb'], ['GET', '//v1/health'],
    ];
    for (const [method, requestPath] of refusals) {
      const init = { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' };
      const response = await harness.doorRequest(requestPath, init);
      expect(response.status, `${method} ${requestPath}`).toBe(404);
      expect(response.json().error).toBe('route_not_allowed');
      // Beside the 404 for the hosted origin: another origin and no origin are refused by the Origin check, whatever the route.
      expect((await harness.doorRequest(requestPath, { ...init, origin: harness.otherOrigin })).status, `another origin ${method} ${requestPath}`).toBe(403);
      expect((await harness.doorRequest(requestPath, { ...init, origin: null })).status, `no origin ${method} ${requestPath}`).toBe(403);
    }
    // Compose is a local-dev route, and chat lives only under /api/astrid: neither is served here.
    const notServed: Array<[string, string]> = [
      ['POST', '/api/astrid/generation/compose'], ['POST', '/api/runtime/generation/compose'], ['POST', '/api/runtime/acp/connect'],
    ];
    for (const [method, requestPath] of notServed) {
      const init = { method, fromRoot: true, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' };
      const response = await harness.doorRequest(requestPath, init);
      expect(response.status, `${method} ${requestPath}`).toBe(404);
      expect(response.json().error).toBe('route_not_allowed');
      expect((await harness.doorRequest(requestPath, { ...init, origin: harness.otherOrigin })).status, `another origin ${method} ${requestPath}`).toBe(403);
      expect((await harness.doorRequest(requestPath, { ...init, origin: null })).status, `no origin ${method} ${requestPath}`).toBe(403);
    }
    // Chat routes exist, but no chat service runs on this computer: a refusal the page can read and show calmly.
    for (const [method, requestPath] of [['POST', '/api/astrid/acp/connect'], ['GET', '/api/astrid/acp/health'], ['POST', '/api/astrid/acp/c1/rpc'], ['GET', '/api/astrid/acp/c1/events']] as const) {
      const init = { method, fromRoot: true, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' };
      const response = await harness.doorRequest(requestPath, init);
      expect(response.status, `${method} ${requestPath}`).toBe(503);
      expect(response.json().error).toBe('acp_unavailable');
      expect(response.headers['access-control-allow-origin']).toBe(harness.origin);
      expect((await harness.doorRequest(requestPath, { ...init, origin: harness.otherOrigin })).status, `another origin ${method} ${requestPath}`).toBe(403);
    }
    // The door answered every one itself (404, 403 or 503) and still serves allowed routes.
    expect((await harness.doorRequest('/v1/projects?limit=1')).status).toBe(200);
    expect((await harness.runtimeJson('GET', '/v1/projects?limit=1')).status).toBe(200);
  });

  test('browser credentials, a foreign Referer and the Private Network preflight', async ({ harness }) => {
    const withAuthorization = await harness.doorRequest('/v1/health', { headers: { Authorization: `Bearer ${harness.productToken}` } });
    expect(withAuthorization.status).toBe(403);
    expect(withAuthorization.json().error).toBe('browser_credentials_forbidden');
    const withCookie = await harness.doorRequest('/v1/health', { headers: { Cookie: 'a=b' } });
    expect(withCookie.status).toBe(403);

    // A media-style request without Origin is refused, whatever its Referer: the hosted one included.
    const asMedia = (referer?: string) => harness.doorRequest(`/v1/objects/${encodeURIComponent(harness.seed.image.objectId)}`, { origin: null, headers: referer ? { Referer: referer } : {} });
    expect((await asMedia(`${harness.origin}/`)).status).toBe(403);
    expect((await asMedia(`${harness.origin}/tools/video-editor`)).status).toBe(403);
    expect((await asMedia(`${harness.otherOrigin}/`)).status).toBe(403);
    expect((await asMedia()).status).toBe(403);
    expect((await harness.doorRequest('/v1/projects', { origin: null, method: 'POST', headers: { Referer: `${harness.origin}/`, 'Content-Type': 'application/json' }, body: '{"name":"x"}' })).status).toBe(403);

    const preflight = (origin: string, requestHeaders: string) => harness.doorRequest('/v1/projects', {
      method: 'OPTIONS', origin,
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': requestHeaders, 'Access-Control-Request-Private-Network': 'true' },
    });
    const allowed = await preflight(harness.origin, 'content-type, idempotency-key');
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-private-network']).toBe('true');
    expect(allowed.headers['access-control-allow-origin']).toBe(harness.origin);
    const foreign = await preflight(harness.otherOrigin, 'content-type');
    expect(foreign.status).toBe(403);
    expect(foreign.headers['access-control-allow-private-network']).toBeUndefined();
    expect((await preflight(harness.origin, 'authorization')).status).toBe(403);
    expect((await preflight(harness.origin, 'x-forwarded-for')).status).toBe(403);
  });

  test('from the hosted page, a request carrying an Authorization header cannot be sent', async ({ page, harness }) => {
    await openHostedPage(page, harness);
    const blocked = await page.evaluate(async (base) => {
      try { await fetch(`${base}/v1/projects`, { headers: { Authorization: 'Bearer owner' } }); return 'responded'; } catch { return 'blocked'; }
    }, harness.doorBase);
    expect(blocked).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Pack extensions on the hosted build (design D5a)

/**
 * The second timeline the harness seeds for the pack extensions (made here, after the cases that open the seeded timeline,
 * so none of them sees a second timeline). Opened by URL with canonical project and timeline IDs.
 */
async function openSeededTimelineByUrl(page: Page, harness: DirectHarness, seed: { projectSlug: string; timelineId: string }) {
  const doorRequests: string[] = [];
  page.on('request', (request) => { if (request.url().startsWith(`http://127.0.0.1:${DOOR_PORT}/`)) doorRequests.push(`${request.method()} ${request.url()}`); });
  await page.goto(`${harness.origin}${APP_ENTRY_ROUTE}?project=${encodeURIComponent(harness.seed.projectId)}&timeline=${encodeURIComponent(seed.timelineId)}`);
  await expectConnected(page);
  await expect(firstTrackName(page)).toBeVisible();
  return { seed, doorRequests };
}

async function openExtensionsTimeline(page: Page, harness: DirectHarness) {
  return openSeededTimelineByUrl(page, harness, await harness.seedExtensions());
}

test.describe('pack extensions (App)', () => {
  test('extensions: the transcript lane renders its words from the door', async ({ page, harness }) => {
    const { seed } = await openExtensionsTimeline(page, harness);
    // The lane is the bundled transcript extension's: one chip per segment of the bundle read from the Runtime.
    const lane = page.locator('[data-lane-kind="astrid.transcript"]');
    await expect(lane).toBeVisible();
    const chips = lane.getByTestId('transcript-lane-occurrence');
    await expect(chips).toHaveCount(seed.transcriptTexts.length);
    for (const text of seed.transcriptTexts) {
      await expect(lane.getByLabel(`Transcript segment: ${text}`, { exact: false })).toHaveCount(1);
    }
    // The words came through the door with the hosted Origin: the timeline's composition read is in its audit.
    const reads = await waitForAudit(harness, (entry) => entry.method === 'GET' && entry.path.includes(`/timelines/${seed.timelineId}/composition-revisions`) && entry.status === 200 && entry.origin === harness.origin);
    expect(reads.length, 'the composition (with its transcript bundle) was read through the door with the hosted Origin').toBeGreaterThan(0);
  });

  test('extensions: a live scene previews from a Runtime object in its sandboxed iframe', async ({ page, harness }) => {
    const { seed } = await openExtensionsTimeline(page, harness);
    // The clip's package is a Runtime project object: the Runtime holds those exact bytes under the object id the clip names.
    const stored = await harness.runtimeFetch(`/v1/objects/${encodeURIComponent(seed.scenePackage.objectId)}`);
    expect(stored.status).toBe(200);
    expect(sha256Hex(new Uint8Array(await stored.arrayBuffer()))).toBe(seed.scenePackage.digest);

    const entry = page.getByTestId('astrid-live-scene-entry');
    await expect(entry).toHaveAttribute('data-phase', 'ready', { timeout: 30_000 });
    await expect(entry).toHaveAttribute('data-revision', seed.scenePackage.digest);
    const iframe = page.locator('iframe[title^="Live scene"][data-scene-role="displayed"]');
    await expect(iframe).toHaveCount(1);
    // Scripts run, but in an opaque origin: allow-scripts alone, never allow-same-origin.
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    const frame = await (await iframe.elementHandle())!.contentFrame();
    expect(frame, 'the scene frame is reachable').not.toBeNull();
    await expect(frame!.locator('#scene')).toContainText(seed.sceneMarker);
    // From inside the frame: no network (the document's CSP is connect-src 'none') and no reach into the hosting page.
    const inside = await frame!.evaluate(async (doorBase) => {
      const network = await fetch(`${doorBase}/v1/health`).then(() => 'reached', () => 'blocked');
      let parentAccess = 'blocked';
      try { void (window.parent.document.title); parentAccess = 'reached'; } catch { /* cross-origin */ }
      let storage = 'blocked';
      try { void window.localStorage.length; storage = 'reached'; } catch { /* opaque origin */ }
      return { network, parentAccess, storage };
    }, harness.doorBase);
    expect(inside).toEqual({ network: 'blocked', parentAccess: 'blocked', storage: 'blocked' });
    expect(harness.audit().filter((entry) => entry.origin === 'null'), 'the scene frame sent nothing to the door').toEqual([]);
  });

  test('extensions ship without fetching a deployment config', async ({ page, harness }) => {
    const configRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/runtime-config/v1/extensions.json') configRequests.push(request.url());
    });
    await openExtensionsTimeline(page, harness);
    await expect(page.locator('[data-lane-kind="astrid.transcript"]')).toBeVisible();
    await expect(page.getByTestId('astrid-live-scene-entry')).toHaveAttribute('data-phase', 'ready');
    expect(configRequests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 6b. Media on the hosted build (design D4)

// Media elements need crossorigin="anonymous" so the browser sends the hosted Origin (`mediaCrossOrigin`, applied on each element).
// The seeded timeline has no clips, so this case opens the harness's media timeline (an image clip and a video clip, both Runtime objects).
test.describe('media (App)', () => {
  test('App: the seeded image and video thumbnail render from the door', async ({ page, harness }) => {
    skipWhen('direct-journey-ffmpeg');
    const { image, video } = harness.seed;
    const { seed } = await openSeededTimelineByUrl(page, harness, await harness.seedMedia());
    const doorObject = (objectId: string) => `/v1/objects/${encodeURIComponent(objectId)}`;
    // The audit records the decoded path (the id's colon is not escaped).
    const auditPath = (objectId: string) => `/v1/objects/${objectId}`;

    // The image clip's thumbnail is an <img> on the door URL; it decodes only if the door answered the hosted Origin.
    const thumbnail = page.locator(`[data-clip-id="${seed.imageClipId}"] img[src*="${doorObject(image.objectId)}"]`).first();
    await expect(thumbnail).toBeVisible();
    await expect(thumbnail).toHaveAttribute('crossorigin', 'anonymous');
    await expect.poll(() => thumbnail.evaluate((element: HTMLImageElement) => [element.naturalWidth, element.naturalHeight])).toEqual([64, 48]);
    const imageAudit = await waitForAudit(harness, (entry) => entry.path === auditPath(image.objectId) && entry.status === 200 && entry.origin === harness.origin);
    expect(imageAudit.length, 'the browser sent the hosted Origin for the image').toBeGreaterThan(0);

    // The video clip is drawn too (it has no thumbnail of its own), and its bytes come from the door with the hosted Origin.
    await expect(page.locator(`[data-clip-id="${seed.videoClipId}"]`).first()).toBeVisible();
    const videoAudit = await waitForAudit(harness, (entry) => entry.path === auditPath(video.objectId) && [200, 206].includes(entry.status) && entry.origin === harness.origin);
    expect(videoAudit.length, 'the browser sent the hosted Origin for the video').toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. Speed table (reported, never judged)

test('speed table: each step through the door against the Runtime directly', async ({ harness }, testInfo) => {
  test.setTimeout(300_000);
  const { projectId, timelineId, image, video, big } = harness.seed;
  const idem = () => randomBytes(8).toString('hex');
  const viaDoor = (pathUnderBase: string, init: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}) => harness.doorRequest(pathUnderBase, init);
  const viaRuntime = (pathUnderBase: string, init: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}) =>
    rawRequest({ port: harness.runtimePort, path: pathUnderBase, method: init.method, headers: { Authorization: `Bearer ${harness.productToken}`, ...init.headers }, body: init.body });
  const sides = { runtime: viaRuntime, door: viaDoor } as const;
  const SMALL = 9;
  const jsonHeaders = { 'Content-Type': 'application/json' };

  for (const via of ['runtime', 'door'] as const) {
    const call = sides[via];
    await speed.time('handshake (POST)', via, SMALL, async () => {
      const response = await call('/v1/handshake', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ protocol: 'workspace.v1', client_name: 'journey', client_version: '1', requested_scopes: ['handshake'] }) });
      expect(response.status).toBe(200);
    });
    await speed.time('list projects', via, SMALL, async () => { expect((await call('/v1/projects?limit=100')).status).toBe(200); });
    await speed.time('read timeline (inspect)', via, SMALL, async () => {
      expect((await call(`/v1/projects/${projectId}/timelines/${timelineId}/inspect`, { method: 'POST', headers: jsonHeaders, body: '{}' })).status).toBe(200);
    });
    await speed.time('save timeline (publish revision)', via, SMALL, async () => {
      const head = await currentHead(harness);
      const response = await call(`/v1/projects/${projectId}/timelines/${timelineId}/composition-revisions`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': idem() }, body: JSON.stringify(compositionPublication(harness.seed, head, `speed ${via}`, 30)) });
      expect(response.status, response.text).toBe(200);
    });
    await speed.time('image GET (small)', via, SMALL, async () => {
      const response = await call(`/v1/objects/${encodeURIComponent(image.objectId)}`);
      expect(response.status).toBe(200);
    });
    await speed.time('video Range read (64 KiB)', via, SMALL, async () => {
      const response = await call(`/v1/objects/${encodeURIComponent(video.objectId)}`, { headers: { Range: 'bytes=0-65535' } });
      expect(response.status).toBe(206);
    });
    await speed.time(`video full GET (${(video.size / 1048576).toFixed(1)} MB)`, via, SMALL, async () => {
      const response = await call(`/v1/objects/${encodeURIComponent(video.objectId)}`);
      expect(response.status).toBe(200);
    }, video.size);
    // Big transfers: three downloads and two uploads per side. With fewer than 20 samples p95 is the slowest sample.
    let digestOk = true;
    await speed.time('60 MB download', via, 3, async () => {
      const response = await call(`/v1/objects/${encodeURIComponent(big.objectId)}`);
      expect(response.status).toBe(200);
      digestOk &&= response.body.length === BIG_DOWNLOAD_BYTES;
      lastDownload = response.body;
    }, BIG_DOWNLOAD_BYTES);
    expect(digestOk).toBe(true);
    expect(sha256Hex(lastDownload!)).toBe(big.digest);
    lastDownload = undefined;
  }

  // Uploads: a fresh 200 MB body per repetition (the store is content-addressed, so a repeat would dedupe).
  const payload = randomBytes(BIG_UPLOAD_BYTES);
  for (const via of ['runtime', 'door'] as const) {
    const call = sides[via];
    const bodies: Array<{ body: Buffer; digest: string }> = [];
    for (let rep = 0; rep < 2; rep++) {
      randomBytes(64).copy(payload, 0);
      bodies.push({ body: Buffer.from(payload), digest: sha256Hex(payload) });
    }
    await speed.time('200 MB upload', via, 2, async (rep) => {
      const response = await call(`/v1/projects/${projectId}/objects`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': idem(), 'X-Original-Name': `speed-${via}-${rep}.bin` }, body: bodies[rep].body });
      expect(response.status, response.text.slice(0, 300)).toBe(201);
      expect(response.json().data.digest).toBe(bodies[rep].digest);
    }, BIG_UPLOAD_BYTES);
  }

  const table = speed.render();
  const outDir = testInfo.project.outputDir;
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'direct-measurements.json');
  writeFileSync(file, JSON.stringify(speed.toJSON(), null, 2));
  await testInfo.attach('direct-measurements.json', { path: file, contentType: 'application/json' });
  await testInfo.attach('direct-measurements.txt', { body: table, contentType: 'text/plain' });
});

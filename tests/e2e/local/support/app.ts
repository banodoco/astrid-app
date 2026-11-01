/**
 * Shared support for the direct journey (Plan A): the Chromium resolution, the worker-scoped fixtures, and the App
 * helpers that drive the hosted page. Moved out of direct-journey.spec.ts without changes (card F2-A).
 */
import { chromium, expect, test as base, type Browser, type BrowserContext, type Page, type Request, type Response } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DirectHarness, DOOR_PORT, startDirectHarness } from './harness.ts';
import type { TimelineConfig } from '../../../../src/tools/video-editor/types/index.ts';
import type { TimelineDraftRecord } from '../../../../src/tools/video-editor/data/timelineDraftIndexedDb.ts';
import type { OutboxRecord } from '../../../../src/tools/video-editor/commands/commitOutbox.ts';
import { DEFAULT_VISIBLE_CLIP_SPAN_SECONDS } from '../../../../src/tools/video-editor/lib/timeline-asset-durations.ts';
import { clearMountedBootstrapFailure, MountedBootstrapError, recordMountedBootstrapFailure, retainMountedBootstrapDiagnostics, type MountedBootstrapDiagnosticTestInfo, type MountedBootstrapStage } from '../mounted-readiness-safety.ts';
import { MOUNTED_DIAGNOSTIC_MAX_RECORDS, mountedDiagnosticInitScript } from '../p1-diagnostic-safety.ts';
import { closeElementApplyDiagnosticContext, elementApplyDiagnosticPageFixture } from './p2-element-diagnostic.ts';

export const UI = {
  status: '[data-testid="runtime-connection-status"]',
  panel: '[data-testid="runtime-not-connected"]',
  copy: 'Copy command',
  copySetup: 'Copy setup steps for your agent',
  copySteps: 'Copy steps for your agent',
  connect: 'Connect',
  reload: 'Reload',
};

/** The workspace route a visitor opens on the hosted origin. `/` itself is the public landing page in the WEB build (src/app/routes.tsx:77). */
export const APP_ENTRY_ROUTE = '/tools/video-editor';

const mountedBootstrapDiagnosticTargets = new WeakMap<BrowserContext, MountedBootstrapDiagnosticTestInfo>();

/** Opt the real bootstrap page into the reviewed producer and retain its snapshot before teardown. */
export async function installMountedBootstrapDiagnostics(context: BrowserContext, testInfo: MountedBootstrapDiagnosticTestInfo): Promise<void> {
  mountedBootstrapDiagnosticTargets.set(context, testInfo);
  await context.addInitScript({ content: mountedDiagnosticInitScript({ buffer: 'mounted-bootstrap', maxRecords: MOUNTED_DIAGNOSTIC_MAX_RECORDS }) });
}

type MountedBootstrapConnectionRoute = 'health' | 'handshake' | 'realm';
type MountedBootstrapDiagnosticDetail =
  | { phase: 'connection-route'; connectionRoute: MountedBootstrapConnectionRoute; connectionStatus?: number; connectionOutcome: 'ok' | 'redirect' | 'http-error' | 'transport-failure' | 'unknown' }
  | { phase: 'page-error'; pageErrorClass: string; pageErrorCategory: 'runtime' };

function mountedBootstrapConnectionRoute(url: string): MountedBootstrapConnectionRoute | undefined {
  try {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/v1/health')) return 'health';
    if (pathname.endsWith('/v1/handshake')) return 'handshake';
    if (pathname.endsWith('/v1/realm')) return 'realm';
  } catch { /* Diagnostic route classification is disposable. */ }
  return undefined;
}

function mountedBootstrapConnectionOutcome(status: number): 'ok' | 'redirect' | 'http-error' | 'transport-failure' | 'unknown' {
  if (!Number.isInteger(status) || status < 100 || status > 599) return 'unknown';
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'redirect';
  return 'http-error';
}

function mountedBootstrapPageErrorClass(error: Error): string {
  try {
    return typeof error.name === 'string' && error.name.length > 0 ? error.name : 'Error';
  } catch {
    return 'UNKNOWN';
  }
}

/** Add bounded connection/page-error observations to the already-installed mounted producer. */
export function installMountedBootstrapPageDiagnostics(page: Page): () => Promise<void> {
  const pending = new Set<Promise<void>>();
  const emit = (detail: MountedBootstrapDiagnosticDetail): Promise<void> | undefined => {
    try {
      const operation = page.evaluate((eventDetail) => {
        try { window.dispatchEvent(new CustomEvent('timeline:save-diagnostic', { detail: { version: 1, ...eventDetail } })); }
        catch { /* Diagnostic collection is disposable. */ }
      }, detail).catch(() => {});
      pending.add(operation);
      void operation.finally(() => pending.delete(operation));
      return operation;
    } catch { /* Diagnostic collection is disposable. */ return undefined; }
  };
  const onResponse = (response: Response) => {
    try {
      const connectionRoute = mountedBootstrapConnectionRoute(response.url());
      if (!connectionRoute) return;
      const status = response.status();
      const outcome = mountedBootstrapConnectionOutcome(status);
      return emit({ phase: 'connection-route', connectionRoute, connectionStatus: Number.isInteger(status) ? status : undefined,
        connectionOutcome: outcome });
    } catch { /* Diagnostic collection is disposable. */ }
  };
  const onRequestFailed = (request: Request) => {
    try {
      const connectionRoute = mountedBootstrapConnectionRoute(request.url());
      if (!connectionRoute) return;
      return emit({ phase: 'connection-route', connectionRoute, connectionOutcome: 'transport-failure' });
    } catch { /* Diagnostic collection is disposable. */ }
  };
  const onPageError = (error: Error) => {
    try { return emit({ phase: 'page-error', pageErrorClass: mountedBootstrapPageErrorClass(error), pageErrorCategory: 'runtime' }); }
    catch { /* Diagnostic collection is disposable. */ }
  };
  try {
    page.on('response', onResponse);
    page.on('requestfailed', onRequestFailed);
    page.on('pageerror', onPageError);
  } catch {
    try { page.off('response', onResponse); page.off('requestfailed', onRequestFailed); page.off('pageerror', onPageError); } catch { /* Diagnostic cleanup is disposable. */ }
    return async () => {};
  }
  return async () => {
    try { page.off('response', onResponse); page.off('requestfailed', onRequestFailed); page.off('pageerror', onPageError); }
    catch { /* Diagnostic cleanup is disposable. */ }
    await Promise.all([...pending]);
  };
}

/** QUICK shares the F1 browser/runtime boundary, so teardown verifies the Playwright server group is gone. */
export async function closeQuickBrowser(browser: Browser | undefined, browserServer: Awaited<ReturnType<typeof chromium.launchServer>>): Promise<void> {
  const child: ChildProcess = browserServer.process();
  const pid = child.pid;
  if (!pid) throw new Error('Playwright browser server has no child PID');
  let cleanupError: unknown;
  if (browser) try { await browser.close(); } catch (error) { cleanupError = error; }
  try { await browserServer.close(); } catch (error) { cleanupError ??= error; }
  if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (child.signalCode === 'SIGKILL') cleanupError ??= new Error(`QUICK Chromium process ${pid} exited after SIGKILL`);
  let groupRemains = false;
  try { process.kill(-pid, 0); groupRemains = true; } catch { /* browser group exited */ }
  if (groupRemains) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* exited between check and cleanup */ }
    cleanupError ??= new Error(`QUICK Chromium process group ${pid} remained after browser server close and was force-cleaned`);
  }
  if (cleanupError) throw cleanupError;
}

function resolveChromium(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  // The installed Playwright may expect a newer browser build than the one in the image; use what is there.
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const found = existsSync(browsers) ? readdirSync(browsers).filter((name) => /^chromium-\d+$/.test(name)).sort().pop() : undefined;
  const candidate = found ? path.join(browsers, found, 'chrome-linux', 'chrome') : undefined;
  return candidate && existsSync(candidate) ? candidate : undefined;
}

export const test = base.extend<object, { harness: DirectHarness; browser: Browser; hungStackLifecycle: undefined }>({
  // Playwright reads fixture dependencies from the destructuring pattern, so the empty pattern is required.
  // eslint-disable-next-line no-empty-pattern
  harness: [async ({}, use) => {
    const harness = await startDirectHarness();
    try { await use(harness); } finally { await harness.stop(); }
  }, { scope: 'worker', timeout: process.env.ASTRID_QUICK_DESCRIPTOR ? 0 : 240_000 }],
  browser: [async ({ harness }, use) => {
    if (process.env.ASTRID_QUICK_DESCRIPTOR) {
      const args = [...harness.chromiumArgs];
      const downloadsPath = process.env.PLAYWRIGHT_DOWNLOADS_PATH;
      if (downloadsPath) mkdirSync(downloadsPath, { recursive: true, mode: 0o700 });
      const installedChrome = process.env.PLAYWRIGHT_USE_INSTALLED_CHROME === '1';
      const browserServer = await chromium.launchServer({ args, ...(installedChrome ? { channel: 'chrome' as const } : { executablePath: resolveChromium() }), ...(downloadsPath ? { downloadsPath } : {}) });
      let browser: Browser | undefined;
      try { browser = await chromium.connect(browserServer.wsEndpoint()); await use(browser); }
      finally { await closeQuickBrowser(browser, browserServer); }
    } else {
      const browser = await chromium.launch({ args: harness.chromiumArgs, executablePath: resolveChromium() });
      try { await use(browser); } finally { await browser.close(); }
    }
  }, { scope: 'worker' }],
  context: async ({ browser, harness }, use) => {
    const context = await browser.newContext(harness.contextOptions as Parameters<Browser['newContext']>[0]);
    try { await use(context); } finally { await closeElementApplyDiagnosticContext(context); }
  },
  page: elementApplyDiagnosticPageFixture,
  hungStackLifecycle: [async ({ page, harness }, use) => {
    const detach = harness.installHungRequestCapture(page);
    try { await use(undefined); } finally { detach(); }
  }, { auto: true }],
});

export async function currentHead(harness: DirectHarness): Promise<string> {
  const timelines = await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}/timelines/${harness.seed.timelineId}/composition-revisions?limit=1`);
  return timelines.body.items.find((item: any) => item.is_current_head).revision_id;
}

export async function waitForAudit(harness: DirectHarness, predicate: (entry: ReturnType<DirectHarness['audit']>[number]) => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = harness.audit().filter(predicate);
    if (hit.length || Date.now() > deadline) return hit;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Opens the App at the hosted origin with nothing in the URL and returns the requests it made to the door. */
export async function openApp(page: Page, harness: DirectHarness) {
  const doorRequests: string[] = [];
  page.on('request', (request) => { if (request.url().startsWith(`http://127.0.0.1:${DOOR_PORT}/`)) doorRequests.push(`${request.method()} ${request.url()}`); });
  await page.goto(`${harness.origin}${APP_ENTRY_ROUTE}`);
  return doorRequests;
}

/** Mounts the real editor once so a fresh context can establish its own durable outbox baseline. */
export async function bootstrapMountedBaseline(context: BrowserContext, harness: DirectHarness): Promise<OutboxRecord[]> {
  clearMountedBootstrapFailure();
  let page: Page | undefined;
  let detachPageDiagnostics: (() => Promise<void>) | undefined;
  let outcome: 'completed' | 'failed' = 'failed';
  const run = async <T>(stage: MountedBootstrapStage, operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (cause) {
      throw new MountedBootstrapError({ stage, code: 'mounted-bootstrap', class: 'mounted-bootstrap' }, cause);
    }
  };
  try {
    page = await run('context', () => context.newPage());
    detachPageDiagnostics = installMountedBootstrapPageDiagnostics(page);
    await run('navigation', () => openApp(page!, harness).then(() => undefined));
    await run('connection', () => expectConnected(page!));
    await run('selection', () => openSeededTimeline(page!, harness));
    return await run('outbox-read', async () => {
      let owners: OutboxRecord[] = [];
      // Track visibility precedes the verified basis/identity reads and durable
      // session claim. Keep the real editor alive until that claim has persisted.
      await expect.poll(async () => {
        const exists = await page!.evaluate(async () => (await indexedDB.databases()).some((db) => db.name === 'astrid.command-outbox'));
        if (!exists) return false;
        owners = await commandOutboxes(page!, harness.seed.timelineId);
        return owners.some((owner) => owner.scope.projectId === harness.seed.projectId && !owner.pending && owner.intents.length === 0);
      }, { message: 'the bootstrap editor must persist its scoped command owner before closing' }).toBe(true);
      outcome = 'completed';
      return owners;
    });
  } catch (error) {
    recordMountedBootstrapFailure(error);
    throw error;
  } finally {
    if (detachPageDiagnostics) {
      try { await detachPageDiagnostics(); } catch { /* Diagnostic cleanup is disposable. */ }
    }
    const testInfo = mountedBootstrapDiagnosticTargets.get(context);
    if (testInfo) {
      try { await retainMountedBootstrapDiagnostics(testInfo, page, outcome); } catch { /* Diagnostic retention is disposable. */ }
    }
    await page?.close();
  }
}

export const expectConnected = (page: Page) => expect(page.locator(UI.status)).toHaveAttribute('data-state', 'connected');

/** The editor's first track-name field: the smallest real edit the App offers on the seeded timeline. */
export const firstTrackName = (page: Page) => page.getByRole('textbox', { name: 'Track name' }).first();

/** Waits for the editor to show the seeded project's timeline (the editor picks the only project by itself). */
export async function openSeededTimeline(page: Page, harness: DirectHarness) {
  await expect(page.getByRole('combobox', { name: 'Select project' })).toContainText(harness.seed.projectName);
  await expect(page.getByRole('combobox', { name: 'Select timeline' })).toBeVisible();
  await expect(firstTrackName(page)).toBeVisible();
  // The editor mounts beneath the connection card and is inert until the card has left: an edit before that is dropped.
  await expect(page.locator(UI.panel)).toHaveCount(0);
}

/** Opens the production embedded canonical ShotEditorView from the parent editor's shot-group label. */
export async function openEmbeddedCanonicalShot(page: Page, occurrenceId: string, shotName: string) {
  const label = page.locator('[data-shot-group-key]').filter({ hasText: shotName }).first();
  await expect(label).toBeVisible();
  await label.dblclick();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator(`[data-canonical-occurrence-id="${occurrenceId}"]`)).toBeVisible();
  return dialog;
}

/** The visible native header input inside an embedded ShotEditorView.
 * The mounted timeline also contains track labels and combobox inputs, so the
 * production desktop header width identifies the shot-name field precisely.
 */
export const embeddedShotNameInput = (dialog: import('@playwright/test').Locator) => (
  dialog.locator('input[class*="w-[200px]"]:visible').first()
);

export async function editFirstTrackName(page: Page, name: string) {
  const field = firstTrackName(page);
  await field.fill(name);
  await field.press('Enter');
  await field.blur();
}

/** Hold command delivery before the Runtime sees it; persisted request identity remains product-owned. */
export async function holdCommandRequests(page: Page) {
  const commits = /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/;
  const requests: Request[] = [];
  let release!: (send: boolean) => void;
  const gate = new Promise<boolean>((resolve) => { release = resolve; });
  const intercept = async (route: import('@playwright/test').Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    requests.push(route.request());
    const send = await gate;
    // Reload may have already cancelled the held browser request.
    await (send ? route.continue() : route.abort('connectionreset')).catch(() => {});
  };
  await page.route(commits, intercept);
  return {
    requests,
    async release(send = false) {
      await page.unroute(commits, intercept);
      release(send);
    },
  };
}

/** Hold the native timeline create long enough to inspect its reserved bootstrap owner. */
export async function holdTimelineCreation(page: Page) {
  const creates = /\/v1\/projects\/[^/]+\/timelines$/;
  const requests: Request[] = [];
  let release!: (send: boolean) => void;
  const gate = new Promise<boolean>((resolve) => { release = resolve; });
  const intercept = async (route: import('@playwright/test').Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    requests.push(route.request());
    const send = await gate;
    await (send ? route.continue() : route.abort('connectionreset')).catch(() => {});
  };
  await page.route(creates, intercept);
  return {
    requests,
    async release(send = false) {
      await page.unroute(creates, intercept);
      release(send);
    },
  };
}

/**
 * Holds every save of a composition revision in flight, so the Runtime never receives it and an edit stays an unsaved
 * draft by construction. The editor autosaves 500 ms after an edit, so without this a restart that follows the edit
 * only keeps the draft when it happens to win that race. Returns the release (later saves go through).
 */
export async function holdTimelineSaves(page: Page) {
  const saves = /\/timelines\/[^/]+\/composition-revisions$/;
  await page.route(saves, (route) => (route.request().method() === 'POST' ? new Promise<void>(() => {}) : route.fallback()));
  return () => page.unroute(saves);
}

export async function revisionBody(harness: DirectHarness, revisionId: string) {
  return (await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}/timelines/${harness.seed.timelineId}/composition-revisions/${revisionId}`)).body;
}

/** Read the real browser outbox without creating, claiming or modifying an owner. */
export async function commandOutboxes(page: Page, timelineId: string): Promise<OutboxRecord[]> {
  // Playwright's by-value result decoder intentionally omits __proto__ keys;
  // carry the browser's JSON bytes across the inspection boundary instead.
  const encoded = await page.evaluate(async (id) => {
    if (!(await indexedDB.databases()).some((db) => db.name === 'astrid.command-outbox')) return '[]';
    return new Promise<string>((resolve, reject) => {
      const opening = indexedDB.open('astrid.command-outbox');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const tx = db.transaction('owners', 'readonly');
        const read = tx.objectStore('owners').getAll();
        tx.oncomplete = () => { db.close(); resolve(JSON.stringify((read.result as OutboxRecord[]).filter((record) => record.scope.timelineId === id))); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }, timelineId);
  return JSON.parse(encoded) as OutboxRecord[];
}

/** Actual pointerdown/move/drop: scale comes from the two rendered parent clips. */
export async function dragTimelineClip(page: Page, clipId: string, referenceId: string, from: number, to: number, referenceAt: number, beforeDrop?: () => void | Promise<void>) {
  const clip = page.locator(`.clip-action[data-clip-id="${clipId}"]`).first();
  const reference = page.locator(`.clip-action[data-clip-id="${referenceId}"]`).first();
  await expect(clip).toBeVisible();
  await expect(reference).toBeVisible();
  const box = await clip.boundingBox();
  const other = await reference.boundingBox();
  if (!box || !other || referenceAt === from) throw new Error('Cannot measure timeline clip scale');
  const pixelsPerSecond = (other.x - box.x) / (referenceAt - from);
  expect(pixelsPerSecond).toBeGreaterThan(0);
  const x = box.x + Math.min(box.width / 2, 24);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (to - from) * pixelsPerSecond, y, { steps: 12 });
  await beforeDrop?.();
  await page.mouse.up();
}

/**
 * External file drops have no asset duration at dragover time, so the real
 * coordinator previews the production default span and interprets the
 * pointer as the preview centre. Keep the helper's requested time as the
 * preview's left edge while deriving the centre offset from that source
 * contract.
 */
export function timelineFileDropClientX({
  clipLeft,
  from,
  time,
  pixelsPerSecond,
  previewDurationSeconds = DEFAULT_VISIBLE_CLIP_SPAN_SECONDS,
}: {
  clipLeft: number;
  from: number;
  time: number;
  pixelsPerSecond: number;
  previewDurationSeconds?: number;
}): number {
  return clipLeft + (time - from + previewDurationSeconds / 2) * pixelsPerSecond;
}

/** Dispatch the mounted timeline's real external-file drop with a browser File. */
export async function dropFileOnTimeline(
  page: Page,
  file: { name: string; type: string; bytesBase64: string },
  clipId: string,
  referenceId: string,
  from: number,
  referenceAt: number,
  time: number,
) {
  const clip = page.locator(`.clip-action[data-clip-id="${clipId}"]`).first();
  const reference = page.locator(`.clip-action[data-clip-id="${referenceId}"]`).first();
  const wrapper = page.locator('.timeline-wrapper').first();
  await expect(clip).toBeVisible();
  await expect(reference).toBeVisible();
  const box = await clip.boundingBox();
  const other = await reference.boundingBox();
  const wrapperBox = await wrapper.boundingBox();
  if (!box || !other || !wrapperBox || referenceAt === from) throw new Error('Cannot measure timeline file-drop scale');
  const pixelsPerSecond = (other.x - box.x) / (referenceAt - from);
  // The P2 image call declares `time` as the desired left edge. Keep the
  // established center-pointer contract for the existing video/audio calls.
  const previewDurationSeconds = file.type.startsWith('image/') ? DEFAULT_VISIBLE_CLIP_SPAN_SECONDS : 0;
  const clientX = timelineFileDropClientX({ clipLeft: box.x, from, time, pixelsPerSecond, previewDurationSeconds });
  const clientY = box.y + box.height / 2;
  if (clientX < wrapperBox.x || clientX > wrapperBox.x + wrapperBox.width) {
    throw new Error(`Timeline file drop at ${time}s is outside the mounted timeline viewport`);
  }

  await page.evaluate(({ name, type, bytesBase64, clientX: x, clientY: y }) => {
    const target = document.querySelector<HTMLElement>('.timeline-wrapper');
    if (!target) throw new Error('Mounted timeline wrapper is missing');
    const binary = atob(bytesBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name, { type }));
    const event = (eventType: 'dragover' | 'drop') => target.dispatchEvent(new DragEvent(eventType, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      dataTransfer: transfer,
    }));
    event('dragover');
    event('drop');
  }, { ...file, clientX, clientY });
}

/** Read the legacy one-slot draft without creating or modifying recovery state. */
export async function timelineDraft(page: Page, timelineId: string): Promise<(TimelineDraftRecord & { draft: { config?: TimelineConfig } }) | null> {
  return page.evaluate(async (id) => {
    if (!(await indexedDB.databases()).some((db) => db.name === 'astrid.timeline-drafts')) return null;
    return new Promise<(TimelineDraftRecord & { draft: { config?: TimelineConfig } }) | null>((resolve, reject) => {
      const opening = indexedDB.open('astrid.timeline-drafts');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const tx = db.transaction('timeline-drafts', 'readonly');
        const read = tx.objectStore('timeline-drafts').get(id);
        tx.oncomplete = () => { db.close(); resolve(read.result ?? null); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }, timelineId);
}

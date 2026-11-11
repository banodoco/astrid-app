/**
 * The editor's first-run tour, end to end on the fake Runtime: auto-start on the first editor mount, the
 * welcome, three acts of Send / Next / Next, the finale, the clean exit, and no restart after a reload.
 * It runs on an empty timeline, as a real first-run user has it (the fake Runtime's `empty` seed, set for
 * this spec only and put back to the demo seed afterwards).
 *
 * Keys are the driver (Enter is the tour's primary action on every beat), so the spec holds for any card
 * that offers "Next". Beats are awaited on the tour store and the card's `data-settled`, never
 * on fixed sleeps. Set EDITOR_TOUR_SHOTS_DIR to save one 2x full-page screenshot per step.
 *
 * Run: PLAYWRIGHT_TIMELINE_DEVICES=1 npx playwright test --project=timeline-devices --workers=1 tests/e2e/timeline/editor-tour.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { astridOnboardedStorageState } from '../fixtures/astridOnboardedStorageState';
import { BASE_URL, EDITOR_URL, FAKE_RUNTIME_ORIGIN, collectPageLogs, fakeRuntimeAuthHeaders } from './support';

const SHOTS_DIR = process.env.EDITOR_TOUR_SHOTS_DIR;
const SEEN_KEY = 'astrid-editor-tour-v1';
const STORE_MODULE = '/src/shared/state/editorTourStore.ts';
const COMPOSER = '[data-editor-tour="chat-composer"]';
const SHIELD = '[data-editor-tour-shield]';

type Beat = 'welcome' | 'compose' | 'respond' | 'land' | 'finale' | 'feedback';

test.use({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  storageState: astridOnboardedStorageState(BASE_URL, { editorTourSeen: true, activityPaneUnlocked: false }),
});

interface TourSnapshot {
  status: string;
  act: number;
  beat: Beat;
  ready: { chat: boolean; timeline: boolean; card: boolean };
}

/** The tour store of the running app (the same module instance the app imports). */
function tourState(page: Page): Promise<TourSnapshot> {
  return page.evaluate(async (module) => (await import(/* @vite-ignore */ module)).getEditorTourState(), STORE_MODULE);
}

/** The beat is presented: its ready flags are set, the card has settled and nothing in the overlay is moving. */
async function waitSettled(page: Page, act: number, beat: Beat): Promise<void> {
  await expect.poll(async () => {
    const state = await tourState(page);
    const ready = beat === 'compose' || beat === 'respond' ? state.ready.chat
      : beat === 'land' ? state.ready.timeline && state.ready.card
        : state.ready.card; // welcome, finale, feedback
    return state.status === 'running' && state.act === act && state.beat === beat && ready;
  }, { message: `act ${act} ${beat} is ready`, timeout: 60_000 }).toBe(true);
  await page.locator(`[data-editor-tour-card="${beat}"][data-settled]`).waitFor({ timeout: 10_000 });
  await page.waitForFunction((shield) => {
    const overlay = [document.querySelector(shield), document.querySelector('[data-editor-tour-card-host]')];
    return overlay.every((el) => !el || el.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  }, SHIELD, { timeout: 10_000 });
}

/**
 * The chat column shows no error banner: an alert (the red "Astrid bridge … failed" banner above the composer is
 * one) lying in the composer's column. The tour's own card and the preview's media alerts sit elsewhere.
 */
async function expectNoChatError(page: Page, name: string): Promise<void> {
  const alerts = await page.evaluate((composerSelector) => {
    const composer = document.querySelector(composerSelector);
    if (!composer) return [];
    const columnLeft = composer.getBoundingClientRect().left - 24;
    return [...document.querySelectorAll('[role="alert"]')]
      .filter((el) => !el.closest('[data-editor-tour-card-host]') && el.getBoundingClientRect().left >= columnLeft)
      .map((el) => el.textContent?.trim().slice(0, 160) ?? '');
  }, COMPOSER);
  expect(alerts, `${name}: no error banner in the chat`).toEqual([]);
}

/** Product-only shots go beside the annotated ones, in `<EDITOR_TOUR_SHOTS_DIR>-clean`. */
const CLEAN_SHOTS_DIR = SHOTS_DIR ? `${SHOTS_DIR.replace(/\/$/, '')}-clean` : undefined;

/**
 * One annotated shot, then a clean one: the same moment with the tour's shield and card hidden by a temporary
 * style (visibility only, so nothing re-measures and the tour's state is untouched), removed again straight after.
 */
async function shot(page: Page, name: string): Promise<void> {
  await expectNoChatError(page, name);
  if (!SHOTS_DIR || !CLEAN_SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  mkdirSync(CLEAN_SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`), fullPage: true });
  const hide = await page.addStyleTag({ content: '[data-editor-tour-shield], [data-editor-tour-card-host] { visibility: hidden !important; }' });
  try {
    await page.screenshot({ path: join(CLEAN_SHOTS_DIR, `${name}.png`), fullPage: true });
  } finally {
    await hide.evaluate((style) => style.remove());
  }
}

/**
 * Act 1 puts a live Three.js scene in the preview, which boots slowly under software GL: wait (for the
 * screenshot's sake only, never as a failure) until the preview holds a picture rather than a black frame.
 */
async function waitForScenePicture(page: Page): Promise<void> {
  if (!SHOTS_DIR) return;
  const surface = page.locator('[data-testid="video-editor-preview-surface"]');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if ((await surface.screenshot()).length > 100_000) return;
    await page.waitForTimeout(500);
  }
}

/**
 * Screenshots only: this suite's Chromium cannot decode H.264, so the placeholder video would show "Video
 * failed to load". With EDITOR_TOUR_SHOTS_DIR set, the mp4 is transcoded to VP9 WebM once (ffmpeg) and
 * the page swaps the mp4 URL for a blob of its WebM as the media element receives it. (Not `page.route`:
 * intercepting requests stalls this dev server's page load.) The product keeps H.264, and without the env var
 * nothing changes. If ffmpeg lacks libvpx-vp9 the swap is skipped and the shots show the failed-to-load frame.
 */
async function swapMp4ForWebm(page: Page): Promise<void> {
  if (!SHOTS_DIR) return;
  const webm: Record<string, string> = {};
  try {
    const dir = mkdtempSync(join(tmpdir(), 'editor-tour-webm-'));
    for (const name of ['video']) {
      const out = join(dir, `${name}.webm`);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(process.cwd(), 'src/tools/video-editor/tour/assets', `${name}.mp4`), '-c:v', 'libvpx-vp9', '-b:v', '600k', '-an', out]);
      webm[name] = readFileSync(out).toString('base64');
    }
  } catch (error) {
    console.warn(`[editor-tour] WebM transcode unavailable, leaving the mp4s as they are: ${(error as Error).message}`);
    return;
  }
  await page.addInitScript((files: Record<string, string>) => {
    const blobs = new Map<string, string>();
    const swap = (value: string): string => {
      const name = /\/tour\/assets\/(video)\.mp4(\?|#|$)/.exec(value)?.[1];
      if (!name || !files[name]) return value;
      if (!blobs.has(name)) {
        const bytes = Uint8Array.from(atob(files[name]), (c) => c.charCodeAt(0));
        blobs.set(name, URL.createObjectURL(new Blob([bytes], { type: 'video/webm' })));
      }
      // Remotion trims with a media fragment (#t=…), which a blob URL keeps.
      return blobs.get(name)! + (/#.*$/.exec(value)?.[0] ?? '');
    };
    for (const proto of [HTMLMediaElement.prototype, HTMLSourceElement.prototype]) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'src')!;
      Object.defineProperty(proto, 'src', { ...descriptor, set(value: string) { descriptor.set!.call(this, swap(String(value))); } });
    }
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name: string, value: string) {
      return setAttribute.call(this, name, name === 'src' && /^(VIDEO|SOURCE)$/.test(this.tagName) ? swap(String(value)) : value);
    };
  }, webm);
}

/** Enter finishes a still-running animation first, then acts: press it until the beat has moved on. */
async function pressPrimary(page: Page, from: { act: number; beat: Beat }): Promise<void> {
  await page.keyboard.press('Enter');
  await expect.poll(async () => {
    const state = await tourState(page);
    return state.status !== 'running' || state.act !== from.act || state.beat !== from.beat;
  }, { timeout: 15_000 }).toBe(true);
}

/**
 * Load the editor over the fake Runtime and wait for its toolbar and a settled chat. (Not `openEditor`, whose
 * nine-second settle and network audit this spec does not need.)
 */
async function loadEditor(page: Page): Promise<void> {
  // The first load of a cold dev server compiles the whole editor, which can take over a minute.
  await page.goto(EDITOR_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.getByRole('button', { name: 'Render', exact: true }).waitFor({ state: 'visible', timeout: 120_000 });
  // The chat is settled once it has made its session and opened its composer; a failed create leaves it disabled.
  await expect(page.locator(`${COMPOSER} textarea`).first()).toBeEnabled({ timeout: 30_000 });
}

/** The real composer is back (not the tour's read-only one), enabled, and holds focus. */
async function expectRealComposerFocused(page: Page): Promise<void> {
  const composer = page.locator(`${COMPOSER} textarea`).first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(composer).not.toHaveAttribute('readonly', /.*/);
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await expect(composer).toBeFocused({ timeout: 15_000 });
}

async function expectRealEditor(page: Page): Promise<void> {
  await expect(page.locator(SHIELD)).toHaveCount(0);
  expect((await tourState(page)).status).toBe('idle');
  const tourTracks = await page.locator('[data-track-id^="tour-"]').count();
  expect(tourTracks).toBe(0);
}

/** The user's own timeline is a new one: its rows are there and nothing is on them. */
async function expectEmptyTimeline(page: Page): Promise<void> {
  await page.locator('[data-track-id]').first().waitFor({ timeout: 30_000 });
  await expect(page.locator('[data-clip-id]')).toHaveCount(0);
}

/** Restart the fake Runtime's world from a seed: `empty` (a new timeline) for this spec, `demo` for everyone else. */
async function resetFakeRuntime(seed: 'empty' | 'demo'): Promise<void> {
  const response = await fetch(`${FAKE_RUNTIME_ORIGIN}/__test/reset`, {
    method: 'POST',
    headers: { ...fakeRuntimeAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ seed }),
  });
  expect(response.ok, `fake Runtime reset (${seed})`).toBe(true);
  expect((await response.json()).seed).toBe(seed);
}

/** What the fake Runtime holds for this user's `editor-tour` app-state record (the Runtime-side "seen"). */
async function runtimeTourRecord(): Promise<{ version: number; content: { version: number; outcome: string; step: string; at: string } | null }> {
  const response = await fetch(`${FAKE_RUNTIME_ORIGIN}/v1/app-state/user/editor-tour`, { headers: fakeRuntimeAuthHeaders() });
  expect(response.ok, 'fake Runtime app-state read').toBe(true);
  return response.json();
}

/** The editor is up and has asked the Runtime about the tour (the answer decides the auto-start). */
async function reloadEditorAndAwaitRuntimeAnswer(page: Page): Promise<void> {
  const answered = page.waitForResponse((response) => response.url().includes('/v1/app-state/user/editor-tour') && response.request().method() === 'GET', { timeout: 60_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await answered;
  await page.getByRole('button', { name: 'Render', exact: true }).waitFor({ state: 'visible', timeout: 45_000 });
  await page.locator('[data-track-id]').first().waitFor({ timeout: 30_000 });
}

test.describe('editor tour', () => {
  test.beforeEach(async () => { await resetFakeRuntime('empty'); });
  test.afterEach(async () => { await resetFakeRuntime('demo'); });

  test('runs the whole tour once, leaves the real editor with the composer focused, and never restarts', async ({ page }) => {
    test.setTimeout(300_000);
    const logs = collectPageLogs(page);

    // A first-run user's editor: a new, empty timeline (tour already seen, so it stays idle for this shot).
    await loadEditor(page);
    await expectRealEditor(page);
    await expectEmptyTimeline(page);
    const realTracks = await page.locator('[data-track-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-track-id')));
    await shot(page, '00-editor-before');

    await swapMp4ForWebm(page);

    // Forget the flag: the next load is a first run and starts the tour on its own.
    await page.evaluate((key) => window.localStorage.removeItem(key), SEEN_KEY);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Astrid says hello first, centred over the dimmed editor.
    await waitSettled(page, 1, 'welcome');
    await expect(page.locator(SHIELD)).toBeVisible();
    await expect(page.locator(`${COMPOSER} textarea`).first()).toHaveValue('');
    await shot(page, '01-welcome');
    await pressPrimary(page, { act: 1, beat: 'welcome' }); // OK

    const names = [
      ['02-act1-compose', '03-act1-respond', '04-act1-land'],
      ['05-act2-compose', '06-act2-respond', '07-act2-land'],
      ['08-act3-compose', '09-act3-respond', '10-act3-land'],
    ];
    for (const [index, [composeShot, respondShot, landShot]] of names.entries()) {
      const act = index + 1;
      await waitSettled(page, act, 'compose');
      await expect(page.locator(SHIELD)).toBeVisible();
      await shot(page, composeShot);
      await pressPrimary(page, { act, beat: 'compose' }); // Send

      // Act 1 explains the reply on respond; acts 2 and 3 go straight from Send to land.
      if (act === 1) {
        await waitSettled(page, act, 'respond');
        await shot(page, respondShot);
        await pressPrimary(page, { act, beat: 'respond' }); // Next
      }

      await waitSettled(page, act, 'land');
      await expect(page.locator(`[data-track-id="tour-${['scene', 'stills', 'videos'][index]}"]`)).toHaveCount(1);
      if (act === 1) await waitForScenePicture(page);
      await shot(page, landShot);
      await pressPrimary(page, { act, beat: 'land' }); // Next
    }

    await waitSettled(page, 3, 'finale');
    // The demo leaves nothing behind in storage: no preferences blob for its timeline id.
    expect(await page.evaluate(() => Object.keys(window.localStorage).filter((key) => key.includes('tour-timeline')))).toEqual([]);
    await shot(page, '11-finale');
    await pressPrimary(page, { act: 3, beat: 'finale' }); // Next
    await waitSettled(page, 3, 'feedback');
    await pressPrimary(page, { act: 3, beat: 'feedback' }); // Start creating

    await expectRealEditor(page);
    await expectRealComposerFocused(page);
    await expect.poll(() => page.locator('[data-track-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-track-id'))))
      .toEqual(realTracks);
    await expectEmptyTimeline(page);
    await shot(page, '12-editor-after');

    // The Runtime now holds the outcome, so it outlives this browser's storage.
    await expect.poll(async () => (await runtimeTourRecord()).content?.outcome).toBe('completed');
    expect((await runtimeTourRecord()).content).toMatchObject({ version: 1, outcome: 'completed', step: 'act3/feedback' });

    // "Seen" was stored at the start: a reload goes straight to the editor.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Render', exact: true }).waitFor({ state: 'visible', timeout: 45_000 });
    await page.locator('[data-track-id]').first().waitFor({ timeout: 30_000 });
    await expectRealEditor(page);

    // Forget the browser's flag (a new browser, another origin, cleared storage): the Runtime's record keeps the tour away.
    await page.evaluate((key) => window.localStorage.removeItem(key), SEEN_KEY);
    await reloadEditorAndAwaitRuntimeAnswer(page);
    await expectRealEditor(page);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), SEEN_KEY)).not.toBeNull();
    // (This Chromium cannot decode the H.264 placeholders, so play() rejects with "no supported sources".)
    expect(logs.filter((line) => line.startsWith('[pageerror]') && !line.includes('no supported sources'))).toEqual([]);
  });

  test('Esc leaves mid-tour, and a reload mid-tour does not bring it back', async ({ page }) => {
    test.setTimeout(180_000);
    await loadEditor(page);
    await page.evaluate((key) => window.localStorage.removeItem(key), SEEN_KEY);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitSettled(page, 1, 'welcome');
    await pressPrimary(page, { act: 1, beat: 'welcome' });
    await waitSettled(page, 1, 'compose');

    // Clicks outside the card are swallowed; keys other than Enter / Esc do nothing.
    await page.mouse.click(10, 10);
    await page.keyboard.press('Space');
    expect(await tourState(page)).toMatchObject({ status: 'running', act: 1, beat: 'compose' });

    await page.keyboard.press('Escape');
    await expectRealEditor(page);
    await expectRealComposerFocused(page);

    // Esc recorded "skipped" in the Runtime, and a record keeps the tour away on its own.
    await expect.poll(async () => (await runtimeTourRecord()).content?.outcome).toBe('skipped');
    expect((await runtimeTourRecord()).content).toMatchObject({ version: 1, outcome: 'skipped', step: 'act1/compose' });

    // Mid-tour reload: start again as a new user (no Runtime record, no flag), then reload once the tour is running.
    await resetFakeRuntime('empty');
    await page.evaluate((key) => window.localStorage.removeItem(key), SEEN_KEY);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitSettled(page, 1, 'welcome');
    // Starting recorded "started" in the Runtime, so the reload mid-tour, even with the flag gone, never re-traps anyone.
    await expect.poll(async () => (await runtimeTourRecord()).content?.outcome).toBe('started');
    await page.evaluate((key) => window.localStorage.removeItem(key), SEEN_KEY);
    await reloadEditorAndAwaitRuntimeAnswer(page);
    await expectRealEditor(page);
  });

  test('a skip at the welcome is remembered by the Runtime: with the browser flag gone, the tour stays away', async ({ page }) => {
    test.setTimeout(180_000);
    await loadEditor(page);
    expect((await runtimeTourRecord()).content).toBeNull();
    await page.evaluate((key) => window.localStorage.removeItem(key), SEEN_KEY);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitSettled(page, 1, 'welcome');

    await page.keyboard.press('Escape');
    await expectRealEditor(page);
    await expect.poll(async () => (await runtimeTourRecord()).content?.outcome).toBe('skipped');
    expect((await runtimeTourRecord()).content).toMatchObject({ version: 1, outcome: 'skipped', step: 'act1/welcome' });

    await page.evaluate((key) => window.localStorage.removeItem(key), SEEN_KEY);
    await reloadEditorAndAwaitRuntimeAnswer(page);
    await expectRealEditor(page);
  });

  test('Settings > Replay tour runs the whole tour again, and a reload after it does not restart it', async ({ page }) => {
    test.setTimeout(180_000);
    // Seen already (the project default): the editor is idle, as for any returning user.
    await loadEditor(page);
    await expectRealEditor(page);
    const realTracks = await page.locator('[data-track-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-track-id')));

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Replay tour', exact: true }).click();

    // Settings closes and the tour starts from the welcome card.
    await expect(dialog).toHaveCount(0);
    await waitSettled(page, 1, 'welcome');
    await expect(page.locator(SHIELD)).toBeVisible();
    await pressPrimary(page, { act: 1, beat: 'welcome' });
    await waitSettled(page, 1, 'compose');

    // Leave with Esc: the user's own timeline is back, untouched.
    await page.keyboard.press('Escape');
    await expectRealEditor(page);
    await expectRealComposerFocused(page);
    await expect.poll(() => page.locator('[data-track-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-track-id'))))
      .toEqual(realTracks);

    // Replay records its own outcome the same way.
    await expect.poll(async () => (await runtimeTourRecord()).content?.outcome).toBe('skipped');
    expect((await runtimeTourRecord()).content).toMatchObject({ version: 1, step: 'act1/compose' });

    // Replay never changes "seen": a reload does not start the tour.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Render', exact: true }).waitFor({ state: 'visible', timeout: 45_000 });
    await page.locator('[data-track-id]').first().waitFor({ timeout: 30_000 });
    await expectRealEditor(page);
  });
});

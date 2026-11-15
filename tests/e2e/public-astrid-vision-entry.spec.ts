import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { PublicVisionContent } from '../../src/pages/Home/publicVisionContent';

test.setTimeout(90_000);

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';
const folder = 'test-results/vision-captures';
function record(name: string, value: unknown) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(`${folder}/${name}.json`, JSON.stringify(value, null, 2));
}
async function hero(page: Page) {
  return page.locator('.astrid-vision-hero-copy h1').evaluate(node => {
    const style = getComputedStyle(node);
    return { height: (node as HTMLElement).offsetHeight, width: (node as HTMLElement).offsetWidth,
      font: style.font, spacing: style.letterSpacing, text: node.textContent };
  });
}

for (const width of [390, 1440]) {
  test.describe(`header continuity at ${width}px`, () => {
    // A desktop-sized WebKit window should not retain an iPhone's 3x raster
    // and mobile screen. Phone coverage keeps the project's real device profile.
    if (width === 1440) test.use({ isMobile: false, deviceScaleFactor: 1, hasTouch: false });
    test(`opening every popup keeps the header and background stationary at ${width}px`, async ({ page, request }, info) => {
      const response = await request.get(FEED); expect(response.ok()).toBe(true);
      const feed = await response.json() as PublicVisionContent;
      await page.route(FEED, route => route.fulfill({ json: feed }));
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/vision', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.astrid-vision')).toBeVisible({ timeout: 20000 });
      await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
      await page.evaluate(() => document.fonts.ready);
      const trace = [];
      for (const kind of ['pillar', 'principle', 'gaps', 'projects']) {
        const opener = kind === 'pillar' ? page.locator('.astrid-vision-principles > li').last().getByRole('button')
          : kind === 'principle' ? page.locator('.astrid-vision-standards-list > li').last().getByRole('button')
          : page.getByRole('button', { name: 'See all ' + kind, exact: true });
        await opener.scrollIntoViewIfNeeded();
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.evaluate(() => {
          const read = () => {
            const header = document.querySelector<HTMLElement>('.astrid-vision-bar')!;
            const box = header.getBoundingClientRect();
            const main = document.querySelector<HTMLElement>('.astrid-vision')!;
            return { y: box.y, x: box.x, width: box.width, height: box.height,
              opacity: getComputedStyle(header).opacity, visibility: getComputedStyle(header).visibility,
              colour: getComputedStyle(main).backgroundColor,
              condensed: header.hasAttribute('data-condensed') };
          };
          const state = window as unknown as { headerTrace: ReturnType<typeof read>[] };
          document.addEventListener('pointerdown', () => {
            state.headerTrace = [read()];
            let remaining = 24;
            const sample = () => { state.headerTrace.push(read()); if (--remaining) requestAnimationFrame(sample); };
            requestAnimationFrame(sample);
          }, { once: true, capture: true });
        });
        await opener.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toHaveAttribute('data-ready', 'true');
        await expect.poll(() => page.evaluate(() => (window as unknown as { headerTrace: unknown[] }).headerTrace.length), { timeout: 20000 }).toBe(25);
        const samples = await page.evaluate(() => (window as unknown as { headerTrace: { y: number; x: number; width: number; height: number; opacity: string; visibility: string; colour: string; condensed: boolean }[] }).headerTrace);
        trace.push({ kind, samples });
        record(`header-continuity-${info.project.name}-${width}`, { source: feed.source, trace });
        const start = samples[0];
        expect.soft(Math.max(...samples.map(sample => Math.abs(sample.y - start.y))), kind + ' header Y drift').toBeLessThan(1);
        expect.soft(samples.every(sample => sample.visibility === 'visible' && sample.opacity === '1')).toBe(true);
        expect.soft(samples.every(sample => sample.colour === start.colour && sample.condensed === start.condensed)).toBe(true);
        await page.screenshot({ path: `${folder}/header-behind-${kind}-${info.project.name}-${width}.png` });
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(page.locator('[data-vision-header-space]')).toHaveCount(0);
        expect.soft(await page.locator('.astrid-vision-bar').evaluate(node => node.getBoundingClientRect().y)).toBeCloseTo(start.y, 0);
      }
    });
  });
}

test('cold skeleton and loaded hero share layout without restarting a text entrance', async ({ page, request }, info) => {
  const response = await request.get(FEED); expect(response.ok()).toBe(true);
  const feed = await response.json() as PublicVisionContent;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(FEED, async route => { await gate; await route.fulfill({ json: feed }); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('status', { name: "Loading Astrid's vision" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const before = await hero(page);
  release();
  await expect(page.locator('#astrid-vision-title')).toHaveText(feed.vision.title);
  const after = await hero(page);
  const motion = await page.locator('#astrid-vision-title').evaluate(node => node.getAnimations().map(animation => ({ playState: animation.playState, time: animation.currentTime })));
  record(`cold-entry-${info.project.name}`, { source: feed.source, before, after, motion });
  expect.soft(after.height).toBe(before.height);
  expect.soft(after.width).toBe(before.width);
  expect.soft(motion.filter(animation => animation.playState === 'running')).toHaveLength(0);
});

test('Home to Vision joins its pending preload and keeps headline line boxes stable', async ({ page, request }, info) => {
  const response = await request.get(FEED); expect(response.ok()).toBe(true);
  const feed = await response.json() as PublicVisionContent;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route(FEED, async route => { requests++; await gate; await route.fulfill({ json: feed }); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home', { waitUntil: 'domcontentloaded' });
  const link = page.getByRole('link', { name: 'Vision', exact: true });
  await expect(link).toBeVisible();
  await expect.poll(() => requests, { timeout: 20000 }).toBeGreaterThan(0);
  await link.click();
  await expect(page.locator('.astrid-vision')).toBeVisible();
  await page.waitForTimeout(250);
  const requestsBeforeRelease = requests;
  await page.evaluate(() => {
    const state = window as unknown as { arrival: { height: number; width: number; text: string | null }[] };
    state.arrival = [];
    const read = () => {
      const title = document.querySelector<HTMLElement>('#astrid-vision-title');
      if (title) state.arrival.push({ height: title.offsetHeight, width: title.offsetWidth, text: title.textContent });
    };
    const observer = new MutationObserver(read);
    observer.observe(document.querySelector('.astrid-vision-hero-copy')!, { childList: true, attributes: true, subtree: true });
    let count = 0;
    const sample = () => { read(); if (++count < 120) requestAnimationFrame(sample); else observer.disconnect(); };
    requestAnimationFrame(sample);
  });
  release();
  await expect(page.locator('#astrid-vision-title')).toHaveText(feed.vision.title);
  const frames = await page.locator('#astrid-vision-title').evaluate(node => new Promise<{ height: number; width: number; font: string; transform: string; parentWidth: number }[]>(resolve => {
    const samples: { height: number; width: number; font: string; transform: string; parentWidth: number }[] = [];
    const sample = () => {
      const style = getComputedStyle(node);
      samples.push({ height: (node as HTMLElement).offsetHeight, width: (node as HTMLElement).offsetWidth,
        font: style.font, transform: style.transform, parentWidth: node.parentElement!.getBoundingClientRect().width });
      if (samples.length < 72) requestAnimationFrame(sample); else resolve(samples);
    };
    sample();
  }));
  const arrival = await page.evaluate(() => (window as unknown as { arrival: { height: number; width: number; text: string | null }[] }).arrival);
  record(`home-vision-entry-${info.project.name}`, { source: feed.source, requestsBeforeRelease, frames, arrival });
  expect.soft(arrival.length).toBeGreaterThan(0);
  expect.soft(new Set(arrival.map(frame => `${frame.height}/${frame.width}`)).size).toBe(1);
  expect.soft(requestsBeforeRelease).toBe(1);
  expect.soft(new Set(frames.map(frame => `${frame.height}/${frame.width}/${frame.font}`)).size).toBe(1);
  await page.getByRole('link', { name: 'Astrid home', exact: true }).click();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.locator('#astrid-vision-title')).toHaveText(feed.vision.title);
  await expect(page.getByRole('status', { name: "Loading Astrid's vision" })).toHaveCount(0);
});

// Use tablet emulation explicitly rather than resizing a 3x phone context.
test('iPad single-screen Home rejects document overflow and remains fitted', async ({ browser, baseURL, request }, info) => {
  const response = await request.get(FEED); expect(response.ok()).toBe(true);
  const feed = await response.json() as PublicVisionContent;
  const context = await browser.newContext({ baseURL, viewport: { width: 820, height: 1180 },
    screen: { width: 820, height: 1180 }, isMobile: true, hasTouch: true,
    deviceScaleFactor: 1, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.route(FEED, route => route.fulfill({ json: feed }));
    await page.goto('/home', { waitUntil: 'domcontentloaded' });
    const home = page.locator('.astrid-public-site');
    await expect(home).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const samples = [];
    for (const viewport of [{ width: 820, height: 1180 }, { width: 820, height: 1024 },
      { width: 834, height: 1194 }, { width: 768, height: 1024 }, { width: 1024, height: 1366 }]) {
      await page.setViewportSize(viewport);
      for (const audience of ['App', 'Agent']) {
        await home.getByRole('button', { name: audience, exact: true }).click();
        await expect(home).toHaveAttribute('data-audience', audience.toLowerCase());
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).toBe('clip');
        await page.evaluate(() => window.scrollTo({ left: 0, top: 3000, behavior: 'instant' }));
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        const geometry = await home.evaluate(node => ({
          height: innerHeight, y: scrollY, scrollHeight: document.documentElement.scrollHeight,
          bodyHeight: document.body.scrollHeight, home: node.getBoundingClientRect().toJSON(),
          controls: ['.astrid-brand', 'h1', '.astrid-audience-switch', '.astrid-hero-actions'].map(selector => {
            const box = node.querySelector(selector)!.getBoundingClientRect();
            return { selector, top: box.top, bottom: box.bottom, left: box.left, right: box.right };
          }),
        }));
        expect(geometry.scrollHeight).toBeLessThanOrEqual(viewport.height + 1);
        expect(geometry.bodyHeight).toBeLessThanOrEqual(viewport.height + 1);
        expect(geometry.home.y).toBe(0);
        for (const box of geometry.controls) {
          expect(box.top).toBeGreaterThanOrEqual(-1);
          expect(box.bottom).toBeLessThanOrEqual(viewport.height + 1);
          expect(box.left).toBeGreaterThanOrEqual(-1);
          expect(box.right).toBeLessThanOrEqual(viewport.width + 1);
        }
        samples.push({ viewport, audience, ...geometry });
      }
    }
    record(`ipad-home-fit-${info.project.name}`, { source: feed.source, samples });
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.screenshot({ path: `${folder}/ipad-home-fit-${info.project.name}.png` });
  } finally { await context.close(); }
});

test('iPad returns from scrolled Vision at the top without a second adjustment', async ({ browser, baseURL, request }, info) => {
  const response = await request.get(FEED); expect(response.ok()).toBe(true);
  const feed = await response.json() as PublicVisionContent;
  const context = await browser.newContext({ baseURL, viewport: { width: 820, height: 1180 },
    screen: { width: 820, height: 1180 }, isMobile: true, hasTouch: true,
    deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  try {
    const page = await context.newPage();
    await page.route(FEED, route => route.fulfill({ json: feed }));
    await page.goto('/home', { waitUntil: 'domcontentloaded' });
    const home = page.locator('.astrid-public-site');
    await expect(home).toBeVisible();
    const traces = [];
    for (const height of [1180, 1024, 1180]) {
      await page.setViewportSize({ width: 820, height });
      await home.getByRole('link', { name: 'Vision', exact: true }).click();
      await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).not.toBe('clip');
      await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(899);
      await page.getByRole('link', { name: 'Astrid home', exact: true }).click();
      await expect(page.locator('.astrid-vision')).toHaveCount(0);
      await expect(home).toHaveAttribute('data-astrid-lifecycle', 'active');
      const frames = await page.evaluate(() => new Promise<{ y: number; top: number; overflow: number }[]>(resolve => {
        const samples: { y: number; top: number; overflow: number }[] = [];
        const sample = () => {
          samples.push({ y: scrollY, top: document.querySelector('.astrid-public-site')!.getBoundingClientRect().top,
            overflow: document.documentElement.scrollHeight - innerHeight });
          if (samples.length < 16) requestAnimationFrame(sample); else resolve(samples);
        };
        sample();
      }));
      expect(frames.every(frame => frame.y === 0 && Math.abs(frame.top) < 1 && frame.overflow <= 1)).toBe(true);
      traces.push({ height, frames });
    }
    // A direct Vision entry has no previous Home scroll or retained DOM.
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
    await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }));
    await page.getByRole('link', { name: 'Astrid home', exact: true }).click();
    await expect(home).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    record(`ipad-home-return-${info.project.name}`, { source: feed.source, traces });
    await page.screenshot({ path: `${folder}/ipad-home-return-${info.project.name}.png` });
  } finally { await context.close(); }
});

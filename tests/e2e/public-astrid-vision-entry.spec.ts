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

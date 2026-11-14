import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { PublicVisionContent } from '../../src/pages/Home/publicVisionContent';

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';
const folder = 'test-results/vision-captures';
test.use({ hasTouch: true, isMobile: true });

async function live(page: Page) {
  const response = await page.request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const feed = await response.json() as PublicVisionContent;
  await page.route(FEED, route => route.fulfill({ json: feed }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const feedLoaded = page.waitForResponse(response => response.url() === FEED);
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await feedLoaded;
  await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  return feed;
}

test('mobile sky keeps its raster size when browser controls change innerHeight', async ({ page }, info) => {
  const feed = await live(page);
  const canvases = page.locator('.astrid-vision .astrid-sky canvas');
  // A canvas defaults to 300×150 before paint; buffer height alone is not readiness.
  await expect.poll(() => canvases.evaluateAll(nodes => nodes.length === 4 && nodes.every(node => {
    const canvas = node as HTMLCanvasElement;
    return canvas.style.width !== '' && canvas.style.height !== '';
  }))).toBe(true);
  const dimensions = () => canvases.evaluateAll(nodes => nodes.map(node => {
    const canvas = node as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height, cssWidth: canvas.style.width, cssHeight: canvas.style.height };
  }));
  const initial = await dimensions();
  await page.evaluate(() => {
    (window as typeof window & { __heightDescriptor?: PropertyDescriptor }).__heightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  });
  const samples = [];
  for (const height of [650, 780, 700, 844]) {
    await page.evaluate(height => new Promise<void>(resolve => {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
      window.dispatchEvent(new Event('resize'));
      window.visualViewport?.dispatchEvent(new Event('resize'));
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }), height);
    const sample = await dimensions(); samples.push({ innerHeight: height, canvases: sample });
    expect(sample).toEqual(initial);
  }
  await page.evaluate(() => {
    const descriptor = (window as typeof window & { __heightDescriptor?: PropertyDescriptor }).__heightDescriptor;
    if (descriptor) Object.defineProperty(window, 'innerHeight', descriptor);
  });
  // Embedded iOS browsers can resize their actual frame as well as innerHeight.
  for (const height of [680, 844]) {
    await page.setViewportSize({ width: 390, height });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await dimensions()).toEqual(initial);
  }
  // A real orientation/layout-width change still gets a newly sized scene.
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(async () => (await dimensions())[0].width).not.toBe(initial[0].width);
  mkdirSync(folder, { recursive: true });
  writeFileSync(`${folder}/stable-sky-${info.project.name}.json`, JSON.stringify({ source: feed.source, initial, samples }, null, 2));
});

test('partially visible first-row pillars show on arrival without scrolling', async ({ page }, info) => {
  const feed = await live(page);
  const card = page.locator('.astrid-vision-principles > li').first();
  const top = (await card.boundingBox())!.y;
  // Put a small but clearly visible part of the card above the browser edge.
  // This used to be in the observer's excluded bottom 8% until the user scrolled.
  const height = Math.ceil(top + 32);
  expect(height).toBeGreaterThan(300);
  await page.setViewportSize({ width: 390, height });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(card).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  const visibleCards = () => page.locator('.astrid-vision-principles > li').evaluateAll(nodes => nodes
    .filter(node => node.getBoundingClientRect().top < window.innerHeight && node.getBoundingClientRect().bottom > 0)
    .map(node => ({ shown: node.hasAttribute('data-shown'), opacity: getComputedStyle(node).opacity })));
  await expect.poll(async () => {
    const visible = await visibleCards();
    return visible.length > 0 && visible.every(node => node.shown && node.opacity === '1');
  }).toBe(true);
  const visible = await visibleCards();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: `${folder}/real-arrival-pillars-${info.project.name}.png` });
  writeFileSync(`${folder}/arrival-pillars-${info.project.name}.json`, JSON.stringify({ source: feed.source, height, visible }, null, 2));
});

test('deep-scrolled catalogs open once with no internal reveal or vertical slide', async ({ page }, info) => {
  const feed = await live(page);
  await page.evaluate(() => {
    type Sample = { y: number; height: number; scroll: number; rowY: number; rowOpacity: string; rowTranslate: string; rowPositions: number[] };
    const state = window as typeof window & { __catalogOpenings: Sample[][] };
    state.__catalogOpenings = [];
    const original = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () {
      const samples: Sample[] = [];
      state.__catalogOpenings.push(samples);
      original.call(this);
      const sample = () => {
        if (!this.open) return;
        const b = this.getBoundingClientRect();
        const row = this.querySelector('.astrid-vision-part, .astrid-vision-project-row')!;
        const style = getComputedStyle(row);
        samples.push({ y: b.y, height: b.height, scroll: this.querySelector('.astrid-vision-details-scroll')!.scrollTop,
          rowY: row.getBoundingClientRect().y - b.y, rowOpacity: style.opacity, rowTranslate: style.translate,
          rowPositions: [...this.querySelectorAll('.astrid-vision-part, .astrid-vision-project-row')].slice(0, 3).map(item => item.getBoundingClientRect().y - b.y) });
        if (samples.length < 18) requestAnimationFrame(sample);
      };
      sample();
    };
  });
  mkdirSync(folder, { recursive: true });
  for (const [index, name] of ['See all gaps', 'See all projects', 'See all gaps', 'See all projects'].entries()) {
    const opener = page.getByRole('button', { name, exact: true });
    await opener.scrollIntoViewIfNeeded();
    await opener.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS('opacity', '1');
    await expect.poll(() => page.evaluate(index => (window as typeof window & {
      __catalogOpenings: unknown[][] }).__catalogOpenings[index]?.length ?? 0, index)).toBe(18);
    const samples = await page.evaluate(index => (window as typeof window & { __catalogOpenings: {
      y: number; height: number; scroll: number; rowY: number; rowOpacity: string; rowTranslate: string; rowPositions: number[] }[][] }).__catalogOpenings[index], index);
    expect(Math.max(...samples.map(s => s.y)) - Math.min(...samples.map(s => s.y))).toBeLessThan(2);
    expect(Math.max(...samples.map(s => s.rowY)) - Math.min(...samples.map(s => s.rowY))).toBeLessThan(2);
    for (let row = 0; row < samples[0].rowPositions.length; row += 1) {
      const positions = samples.map(s => s.rowPositions[row]);
      expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(2);
    }
    expect(samples.every(s => s.scroll === 0 && s.rowOpacity === '1' && ['none', '0px', '0px 0px'].includes(s.rowTranslate))).toBe(true);
    await expect(dialog.locator('[data-reveal]')).toHaveCount(0);
    if (index < 2) await page.screenshot({ path: `${folder}/real-stable-catalog-${index}-${info.project.name}.png` });
    await dialog.getByRole('button', { name: 'Close details', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.dataset.astridScrollLockY)).toBeUndefined();
  }
  const openings = await page.evaluate(() => (window as typeof window & { __catalogOpenings: unknown[] }).__catalogOpenings);
  expect(openings).toHaveLength(4);
  mkdirSync(folder, { recursive: true });
  writeFileSync(`${folder}/catalog-stability-${info.project.name}.json`, JSON.stringify({ source: feed.source, openings }, null, 2));
});

test('bottom mink sparks animate in view without an entrance and pause when hidden', async ({ page }, info) => {
  const feed = await live(page);
  const visual = page.locator('.astrid-vision-tinkerer');
  const sparks = visual.locator('.astrid-vision-sparks');
  await visual.scrollIntoViewIfNeeded();
  await expect(sparks).toHaveCSS('animation-name', 'astrid-vision-sparks');
  await expect(sparks).toHaveCSS('animation-play-state', 'running');
  const first = await sparks.evaluate(node => getComputedStyle(node).backgroundPositionX);
  await expect.poll(() => sparks.evaluate(node => getComputedStyle(node).backgroundPositionX)).not.toBe(first);
  expect(await visual.evaluate(node => {
    for (let element: Element | null = node; element; element = element.parentElement) {
      if (element.hasAttribute('data-reveal') || getComputedStyle(element).opacity !== '1') return false;
    }
    return true;
  })).toBe(true);
  mkdirSync(folder, { recursive: true });
  await visual.screenshot({ path: `${folder}/real-working-mink-${info.project.name}.png` });
  await page.getByRole('button', { name: 'See all gaps', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(sparks).toHaveCSS('animation-play-state', 'paused');
  await page.keyboard.press('Escape');
  await expect(sparks).toHaveCSS('animation-play-state', 'running');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(sparks).toHaveCSS('display', 'none');
  await expect(sparks).toHaveCSS('animation-play-state', 'paused');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(sparks).toHaveCSS('animation-play-state', 'paused');
  writeFileSync(`${folder}/working-mink-${info.project.name}.json`, JSON.stringify({ source: feed.source, sampledFrame: first }));
});

test('latest wording, quiet empty previews, straight faded underline and optical sigil offsets', async ({ page }, info) => {
  const feed = await live(page);
  await expect(page.locator('#astrid-vision-north-star-title')).toHaveText('What we’re building');
  const underline = page.locator('#astrid-vision-title .pixel-underline');
  await expect(underline.locator('path')).toHaveAttribute('d', 'M1 7H99');
  await expect(underline.locator('path')).toHaveAttribute('stroke-linecap', 'square');
  await expect(underline.locator('svg')).toHaveCSS('opacity', '0.55');
  const controls = page.locator('[data-principle="in-the-creators-control"]');
  const wrangling = page.locator('[data-principle="eliminate-needless-technical-wrangling"]');
  for (const card of [controls, wrangling]) {
    const delta = await card.evaluate(node => {
      const frame = node.querySelector('.astrid-vision-principle-sigil')!.getBoundingClientRect();
      const art = node.querySelector('.astrid-vision-sigil-art')!.getBoundingClientRect();
      return { x: art.x - frame.x, y: art.y - frame.y, height: art.height - frame.height };
    });
    expect(delta.x).toBeGreaterThan(5);
    expect(Math.abs(delta.y)).toBeLessThan(1);
    expect(Math.abs(delta.height)).toBeLessThan(1);
  }
  mkdirSync(folder, { recursive: true });
  await page.locator('.astrid-vision-manifesto').screenshot({ path: `${folder}/real-straight-underline-${info.project.name}.png` });
  await page.locator('.astrid-vision-standards').screenshot({ path: `${folder}/real-optical-sigils-${info.project.name}.png` });
  for (const subject of feed.pillars) {
    await page.getByRole('button', { name: 'Explore ' + subject.title + ': gaps and projects', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveCSS('opacity', '1');
    await expect(dialog.locator('.astrid-vision-details-eyebrow')).toHaveText('What we’re building');
    await expect(dialog.getByText('No project yet', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText('No current projects linked yet.', { exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close details' }).click();
    await expect(dialog).toHaveCount(0);
  }
});

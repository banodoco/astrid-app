import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { PublicVisionContent } from '../../src/pages/Home/publicVisionContent';
import { visionFixture } from '../fixtures/public-vision';

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';
const folder = 'test-results/vision-captures';
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function live(page: Page) {
  const response = await page.request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const feed = await response.json() as PublicVisionContent;
  await page.route(FEED, route => route.fulfill({ json: feed }));
  return feed;
}

// Above-the-fold content must not depend on an intersection callback or scroll.
test('already-visible pillars paint on arrival without intersection or scroll delivery', async ({ page }, info) => {
  const feed = await live(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    window.IntersectionObserver = class implements IntersectionObserver {
      root = null; rootMargin = '0px'; thresholds = [0];
      observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
    };
  });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const cards = page.locator('.astrid-vision-principles > li');
  await expect(cards).toHaveCount(4);
  const initial = await cards.evaluateAll(nodes => nodes.map(node => {
    const b = node.getBoundingClientRect();
    const s = getComputedStyle(node);
    return { top: b.top, bottom: b.bottom, opacity: s.opacity, shown: node.getAttribute('data-shown') };
  }));
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const visible = initial.filter(card => card.top < 844 && card.bottom > 0);
  expect(visible.length).toBeGreaterThanOrEqual(2);
  for (const card of visible) { expect(card.opacity).toBe('1'); expect(card.shown).toBe('initial'); }
  mkdirSync(folder, { recursive: true });
  writeFileSync(`${folder}/initial-pillars-${info.project.name}.json`, JSON.stringify({ source: feed.source, initial }, null, 2));
  await page.screenshot({ path: `${folder}/real-first-paint-${info.project.name}.png` });
});

// Controlled toolbar-sized inputs, not a physical iPhone compositor simulation.
test('mobile sky keeps the same scene extent through toolbar height oscillation', async ({ page }, info) => {
  const feed = await live(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  const sky = page.locator('.astrid-vision .astrid-sky');
  await expect.poll(() => sky.locator('canvas').evaluateAll(nodes => nodes.length > 0 && nodes.every(node => (node as HTMLCanvasElement).style.width !== ''))).toBe(true);
  const size = () => sky.locator('canvas').evaluateAll(nodes => nodes.map(node => {
    const canvas = node as HTMLCanvasElement;
    return { layer: canvas.dataset.layer, width: canvas.width, height: canvas.height,
      cssWidth: canvas.style.width, cssHeight: canvas.style.height, top: canvas.style.top, transform: canvas.style.transform };
  }));
  const original = await size();
  await page.evaluate(() => {
    (window as typeof window & { __originalInnerHeight?: PropertyDescriptor }).__originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  });
  const samples = [];
  for (const height of [650, 790, 710, 844]) {
    await page.evaluate(height => {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
      if (window.visualViewport) {
        Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: height });
        window.visualViewport.dispatchEvent(new Event('resize'));
      }
      window.dispatchEvent(new Event('resize'));
    }, height);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const current = await size();
    samples.push({ height, current });
    expect(current).toEqual(original);
  }
  await page.evaluate(() => {
    const original = (window as typeof window & { __originalInnerHeight?: PropertyDescriptor }).__originalInnerHeight;
    if (original) Object.defineProperty(window, 'innerHeight', original);
    else delete (window as Partial<Window>).innerHeight;
    if (window.visualViewport) delete (window.visualViewport as Partial<VisualViewport>).height;
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(async () => (await size())[0].width).not.toBe(original[0].width);
  mkdirSync(folder, { recursive: true });
  writeFileSync(`${folder}/stable-sky-${info.project.name}.json`, JSON.stringify({ source: feed.source, original, samples, rotated: await size() }, null, 2));
});

test('bottom catalogs open once without translated or revealing inner content', async ({ page }, info) => {
  const feed = await live(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    type Frame = { panelY: number; height: number; rowY: number; translate: string; scroll: number };
    type Opening = { title: string; frames: Frame[] };
    const state = window as typeof window & { __catalogPaints: Opening[] };
    state.__catalogPaints = [];
    const native = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () {
      native.call(this);
      if (!this.classList.contains('astrid-vision-catalog')) return;
      const record: Opening = { title: this.querySelector('h2')!.textContent!, frames: [] };
      state.__catalogPaints.push(record);
      const sample = () => {
        if (!this.open) return;
        const panel = this.getBoundingClientRect();
        const row = this.querySelector('.astrid-vision-part, .astrid-vision-project-row')!;
        record.frames.push({ panelY: panel.y, height: panel.height, rowY: row.getBoundingClientRect().y - panel.y,
          translate: getComputedStyle(row).translate, scroll: this.querySelector('.astrid-vision-details-scroll')!.scrollTop });
        if (record.frames.length < 24) requestAnimationFrame(sample);
      };
      sample();
    };
  });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  for (const [index, name] of ['See all gaps', 'See all projects', 'See all gaps', 'See all projects'].entries()) {
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    await page.getByRole('button', { name, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-reveal]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(index => (window as typeof window & {
      __catalogPaints: { frames: unknown[] }[];
    }).__catalogPaints[index]?.frames.length ?? 0, index)).toBe(24);
    const records = await page.evaluate(() => (window as typeof window & {
      __catalogPaints: { title: string; frames: { panelY: number; height: number; rowY: number; translate: string; scroll: number }[] }[];
    }).__catalogPaints);
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${folder}/catalog-first-paint-${info.project.name}.json`, JSON.stringify({ source: feed.source, records }, null, 2));
    expect(records).toHaveLength(index + 1);
    const frames = records[index].frames;
    for (const key of ['panelY', 'height', 'rowY'] as const) {
      expect(Math.max(...frames.map(f => f[key])) - Math.min(...frames.map(f => f[key]))).toBeLessThan(2);
    }
    expect(frames.every(frame => frame.scroll === 0 && ['none', '0px', '0px 0px'].includes(frame.translate))).toBe(true);
    if (index < 2) await page.screenshot({ path: `${folder}/real-stable-${index === 0 ? 'gaps' : 'projects'}-${info.project.name}.png` });
    await dialog.getByRole('button', { name: 'Close details' }).click();
    await expect(dialog).toHaveCount(0);
  }
});

test('empty project counts are silent while desired state and existing projects remain', async ({ page }) => {
  const feed = visionFixture();
  await page.route(FEED, route => route.fulfill({ json: feed }));
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Explore Artistic ambition: gaps and projects', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const empty = dialog.locator('[data-gap-id="AA-002"]');
  await expect(empty.locator('.astrid-vision-details-gap-preview')).toHaveCount(0);
  await expect(dialog.getByText('No project yet', { exact: true })).toHaveCount(0);
  await empty.locator(':scope > summary').click();
  await expect(empty.locator('.astrid-vision-details-gap-description')).toBeVisible();
  await expect(empty.locator('.astrid-vision-details-projects')).toHaveCount(0);
  await expect(dialog.locator('[data-gap-id="AA-001"] .astrid-vision-details-gap-preview')).toContainText('3 projects');
});

test('straight faded emphasis and optically shifted mobile sigils preserve the reading layout', async ({ page }, info) => {
  const feed = await live(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#astrid-vision-north-star-title')).toHaveText('What we’re building');
  const underline = page.locator('#astrid-vision-title .pixel-underline-mark');
  await expect(underline.locator('path')).toHaveAttribute('d', 'M1 6H99');
  await expect(underline.locator('path')).toHaveAttribute('stroke-linecap', 'square');
  await expect(underline).toHaveCSS('opacity', '0.55');
  const positions = await page.locator('.astrid-vision-standards-list > li').evaluateAll(nodes => nodes.map(node => {
    const frame = node.querySelector('.astrid-vision-principle-sigil')!.getBoundingClientRect();
    const art = node.querySelector('.astrid-vision-sigil-art')!.getBoundingClientRect();
    return { id: (node as HTMLElement).dataset.principle, offset: (art.x - frame.x) / frame.width, frame: frame.toJSON() };
  }));
  expect(positions).toHaveLength(4);
  for (const mark of positions) {
    const shifted = ['in-the-creators-control', 'eliminate-needless-technical-wrangling'].includes(mark.id!);
    expect(mark.offset).toBeCloseTo(shifted ? .08 : 0, 2);
  }
  await expect(page.locator('.astrid-vision-standards-list .astrid-vision-principle-statement')).toHaveText(feed.principles.map(p => p.statement!));
  mkdirSync(folder, { recursive: true });
  await page.locator('.astrid-vision-manifesto').screenshot({ path: `${folder}/real-straight-underline-${info.project.name}.png` });
  await page.locator('.astrid-vision-standards').screenshot({ path: `${folder}/real-optical-sigils-${info.project.name}.png` });
});

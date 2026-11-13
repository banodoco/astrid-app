import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { PublicVisionContent } from '../../src/pages/Home/publicVisionContent';
import { aspirationsForSubject } from '../../src/pages/Home/visionHierarchy';

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';
const folder = 'test-results/vision-captures';

async function expectContained(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  const dialog = page.getByRole('dialog');
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(901);
  if (width <= 760) {
    expect(Math.abs(bounds!.x)).toBeLessThan(1);
    expect(Math.abs(bounds!.width - width)).toBeLessThan(1);
    expect(await dialog.evaluate(el => Number.parseFloat(getComputedStyle(el).maxHeight))).toBeGreaterThan(830);
  }
}

for (const width of [320, 390, 760, 1440]) {
  test(`real vision grid, counts and on-demand catalogs at ${width}px`, async ({ page, request }, info) => {
    const response = await request.get(FEED);
    expect(response.ok()).toBeTruthy();
    const feed = await response.json() as PublicVisionContent;
    await page.route(FEED, route => route.fulfill({ json: feed }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    const cards = page.locator('.astrid-vision-principles > li');
    await expect(cards).toHaveCount(4);
    await expect(page.locator('.astrid-vision-source-attribution')).toHaveText('Populated by the Astrid Dev repository.');
    await expect(page.locator('#astrid-vision-parts, #astrid-vision-projects')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Vision page sections' }).getByRole('link')).toHaveCount(4);
    for (const [i, pillar] of feed.pillars.entries()) {
      const hierarchy = aspirationsForSubject(feed, { kind: 'pillar', id: pillar.id });
      const groups = [...hierarchy.aspirations.flatMap(item => item.gaps), ...hierarchy.legacyGaps];
      const gaps = new Set(groups.map(item => item.gap.id)).size;
      const projects = new Set(groups.flatMap(item => item.projects.map(project => project.id))).size;
      await expect(cards.nth(i).locator('.astrid-vision-subject-counts'))
        .toHaveText(`${gaps} ${gaps === 1 ? 'gap' : 'gaps'} · ${projects} ${projects === 1 ? 'project' : 'projects'}`);
      await expect(cards.nth(i).locator('h3')).toHaveText(pillar.title);
      await expect(cards.nth(i).locator(':scope > p')).toHaveText(pillar.descriptor);
      expect(await cards.nth(i).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    const boxes = await cards.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
    if (width <= 760) {
      expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(2);
      expect(Math.abs(boxes[2].y - boxes[3].y)).toBeLessThan(2);
      expect(boxes[1].x).toBeGreaterThan(boxes[0].x + boxes[0].width);
      expect(boxes[2].y).toBeGreaterThan(boxes[0].y + boxes[0].height);
      for (const card of await cards.all()) {
        const art = await card.locator('.astrid-vision-pillar-stage').boundingBox();
        const title = await card.locator('h3').boundingBox();
        expect(art!.y + art!.height).toBeLessThanOrEqual(title!.y + 1);
      }
      const principles = await page.locator('.astrid-vision-standards-list > li').evaluateAll(nodes =>
        nodes.map(node => node.getBoundingClientRect().toJSON()));
      for (let i = 1; i < principles.length; i++) {
        expect(principles[i].y - principles[i - 1].y - principles[i - 1].height).toBeGreaterThanOrEqual(15);
      }
    }
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${folder}/mobile-catalogs-${info.project.name}-${width}-source.json`, JSON.stringify(feed.source));
    await page.locator('.astrid-vision-north-star').screenshot({ path: `${folder}/real-mobile-grid-${info.project.name}-${width}.png` });
    await cards.first().getByRole('button').click();
    await expectContained(page, width);
    await page.screenshot({ path: `${folder}/real-roomy-pillar-${info.project.name}-${width}.png` });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const contribution = page.locator('.astrid-vision-contribute');
    const copy = contribution.getByRole('button', { name: 'Copy instructions for agents', exact: true });
    const actions = contribution.locator('.astrid-vision-catalog-actions');
    await actions.scrollIntoViewIfNeeded();
    const copyBounds = await copy.boundingBox();
    const actionsBounds = await actions.boundingBox();
    expect(actionsBounds!.y).toBeGreaterThanOrEqual(copyBounds!.y + copyBounds!.height);
    await contribution.screenshot({ path: `${folder}/real-catalog-buttons-${info.project.name}-${width}.png` });
    for (const kind of ['projects', 'gaps'] as const) {
      const trigger = page.getByRole('button', { name: 'See all ' + kind, exact: true });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'All ' + kind });
      await expect(dialog).toBeVisible();
      await expectContained(page, width);
      const selector = dialog.getByRole('combobox', { name: 'Filter ' + kind + ' by status' });
      await expect(selector).toHaveValue('all');
      const rows = dialog.locator(kind === 'projects' ? '.astrid-vision-project-row' : '.astrid-vision-part');
      await expect(rows).toHaveCount(feed[kind].length);
      await page.screenshot({ path: `${folder}/real-catalog-${kind}-${info.project.name}-${width}.png` });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(page.locator('#astrid-vision-parts, #astrid-vision-projects')).toHaveCount(0);
    }
  });
}

test('legacy section bookmarks open the right dialog and leave no dead hash on dismissal', async ({ page }) => {
  for (const [hash, label] of [['astrid-vision-parts', 'All gaps'], ['astrid-vision-projects', 'All projects']]) {
    await page.goto('/vision#' + hash, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('dialog', { name: label })).toBeVisible();
    await page.getByRole('button', { name: 'Close details' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe('');
  }
});

test('catalog backdrop consumes the closing tap without activating the button beneath', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'See all gaps', exact: true }).tap();
    const behind = page.getByRole('button', { name: 'See all projects', exact: true });
    await behind.evaluate(node => {
      document.getElementById('root')!.appendChild(node);
      (node as HTMLElement).style.cssText = 'position:fixed;left:0;top:0;width:18px;height:6px;min-height:0;padding:0;z-index:2147483647;transform:none';
      node.addEventListener('click', () => node.setAttribute('data-test-clicked', 'true'));
    });
    await page.touchscreen.tap(4, 2);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.waitForTimeout(350);
    await expect(behind).not.toHaveAttribute('data-test-clicked', 'true');
    await page.touchscreen.tap(4, 2);
    await expect(page.getByRole('dialog', { name: 'All projects' })).toBeVisible();
  } finally {
    await context.close();
  }
});

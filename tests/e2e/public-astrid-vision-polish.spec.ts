import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { PublicVisionContent } from '../../src/pages/Home/publicVisionContent';
import { visionFixture } from '../fixtures/public-vision';

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';
const folder = 'test-results/vision-captures';

async function pinLive(page: Page) {
  const response = await page.request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const feed = await response.json() as PublicVisionContent;
  await page.route(FEED, route => route.fulfill({ json: feed }));
  return feed;
}

// This also runs against the previous source in the focused baseline reproduction.
// It measures real native-dialog opening; it is not an iPhone toolbar simulation.
test('opening prepares viewport before the native top layer and never double-opens', async ({ page }, info) => {
  const feed = await pinLive(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    type Opening = { prepared: boolean; autofocus: boolean; frames: { y: number; height: number; scroll: number }[] };
    const state = window as typeof window & { __visionOpenings: Opening[] };
    state.__visionOpenings = [];
    const original = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () {
      const record: Opening = {
        prepared: !!this.style.getPropertyValue('--vision-viewport-height') && !!this.style.getPropertyValue('--vision-viewport-top'),
        autofocus: !!this.querySelector('h2[autofocus]'), frames: [],
      };
      state.__visionOpenings.push(record);
      original.call(this);
      const sample = () => {
        if (!this.open) return;
        const b = this.getBoundingClientRect();
        record.frames.push({ y: b.y, height: b.height, scroll: this.querySelector('.astrid-vision-details-scroll')!.scrollTop });
        if (record.frames.length < 12) requestAnimationFrame(sample);
      };
      sample();
    };
  });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  const names = [
    'Explore ' + feed.pillars[0].title + ': gaps and projects',
    'Explore ' + feed.principles[3].title + ': gaps and projects',
    'See all projects', 'See all gaps',
  ];
  for (const [index, name] of [...names, names[0]].entries()) {
    const opener = page.getByRole('button', { name, exact: true });
    await opener.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => window.scrollY);
    await opener.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('h2')).toBeFocused();
    await expect.poll(() => page.evaluate(i => {
      const log = (window as typeof window & { __visionOpenings: { frames: unknown[] }[] }).__visionOpenings;
      return log[i]?.frames.length ?? 0;
    }, index)).toBe(12);
    const log = await page.evaluate(() => (window as typeof window & {
      __visionOpenings: { prepared: boolean; autofocus: boolean; frames: { y: number; height: number; scroll: number }[] }[];
    }).__visionOpenings);
    // Keep the frame trace even when a first-paint regression fails below.
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${folder}/opening-frames-${info.project.name}.json`,
      JSON.stringify({ source: feed.source, openings: log }, null, 2));
    expect(log).toHaveLength(index + 1);
    expect(log[index].prepared).toBe(true);
    expect(log[index].autofocus).toBe(true);
    const frames = log[index].frames;
    expect(Math.max(...frames.map(f => f.y)) - Math.min(...frames.map(f => f.y))).toBeLessThan(2);
    expect(Math.max(...frames.map(f => f.height)) - Math.min(...frames.map(f => f.height))).toBeLessThan(2);
    expect(frames.every(f => f.scroll === 0)).toBe(true);
    expect(await dialog.evaluate(node => getComputedStyle(node, '::backdrop').backdropFilter)).toBe('none');
    await dialog.getByRole('button', { name: 'Close details' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(before, 0);
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(`${folder}/opening-frames-${info.project.name}.json`, JSON.stringify({ source: feed.source,
    openings: await page.evaluate(() => (window as typeof window & { __visionOpenings: unknown }).__visionOpenings) }, null, 2));
});

for (const width of [390, 1440]) {
  test(`quiet arrows, intro rule and direct project links at ${width}px`, async ({ page }, info) => {
    const feed = await pinLive(page);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Explore ' + feed.pillars[0].title + ': gaps and projects', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await page.mouse.move(0, 0);
    const enabled = dialog.locator('.astrid-vision-details-next');
    const disabled = dialog.locator('.astrid-vision-details-previous');
    await expect(enabled).toBeEnabled();
    await expect(disabled).toBeDisabled();
    await expect(enabled).toHaveCSS('opacity', '0.36');
    await expect(disabled).toHaveCSS('opacity', '0.25');
    await expect(enabled).toHaveCSS('border-top-width', '2px');
    await expect(disabled).toHaveCSS('border-top-width', '1px');
    await expect(enabled.locator('svg')).toHaveCSS('stroke-width', '3px');
    await expect(disabled.locator('svg')).toHaveCSS('stroke-width', '1.5px');
    const intro = dialog.locator('.astrid-vision-details-description');
    await expect(intro).toHaveCSS('border-bottom-width', '1px');
    const introBox = (await intro.boundingBox())!;
    const restBox = (await dialog.locator('.astrid-vision-details-characteristics').boundingBox())!;
    expect(restBox.y - introBox.y - introBox.height).toBeGreaterThanOrEqual(20);
    mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: `${folder}/real-polished-popup-${info.project.name}-${width}.png` });
    await page.keyboard.press('Escape');
    const gap = feed.gaps.find(g => g.assessment !== 'closed' && g.aspiration && g.primaryAppliesTo?.startsWith('pillar:') &&
      feed.projects.some(p => (p.primaryGapId ?? p.gapIds[0]) === g.id))!;
    const pillar = feed.pillars.find(p => 'pillar:' + p.id === gap.primaryAppliesTo)!;
    await page.getByRole('button', { name: 'Explore ' + pillar.title + ': gaps and projects', exact: true }).click();
    const row = dialog.locator(`[data-gap-id="${gap.id}"]`);
    await row.locator(':scope > summary').click();
    const cards = row.locator('.astrid-vision-project');
    expect(await cards.count()).toBeGreaterThan(0);
    await expect(cards.locator('summary, details, .astrid-vision-project-body, .astrid-vision-project-metadata')).toHaveCount(0);
    for (const card of await cards.all()) {
      await expect(card.locator('.astrid-vision-project-title')).not.toBeEmpty();
      await expect(card.locator('.astrid-vision-project-intro')).not.toBeEmpty();
      await expect(card.getByRole('link', { name: /^Read the full project plan:/ })).toBeVisible();
    }
    await expect(dialog.getByText('No current projects linked yet.', { exact: true })).toHaveCount(0);
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${folder}/real-direct-project-links-${info.project.name}-${width}.png` });
    writeFileSync(`${folder}/polish-${info.project.name}-${width}-source.json`, JSON.stringify(feed.source));
  });
}

test('optional aspiration commitments are separately collapsed and empty projects stay silent', async ({ page }, info) => {
  const feed = visionFixture();
  await page.route(FEED, route => route.fulfill({ json: feed }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Explore Artistic ambition: gaps and projects' }).click();
  const dialog = page.getByRole('dialog');
  const aspirations = dialog.locator('.astrid-vision-details-characteristic');
  const first = aspirations.first();
  await expect(first.locator('.astrid-vision-guidance > summary')).toBeHidden();
  await first.locator(':scope > summary').click();
  const guidance = first.locator('.astrid-vision-guidance');
  await expect(guidance).not.toHaveAttribute('open', '');
  await expect(guidance.locator('.astrid-vision-guidance-body')).toBeHidden();
  await guidance.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(guidance.locator('.astrid-vision-guidance-body')).toBeVisible();
  await expect(guidance.locator('strong')).toHaveText(['We should:', 'We should never:']);
  await expect(guidance.locator('ul')).toHaveCount(2);
  await page.keyboard.press('Space');
  await expect(guidance.locator('.astrid-vision-guidance-body')).toBeHidden();
  await expect(first).toHaveAttribute('open', '');
  await expect(aspirations.nth(1).locator('.astrid-vision-guidance')).toHaveCount(0);
  const emptyGap = dialog.locator('[data-gap-id="AA-002"]');
  await emptyGap.locator(':scope > summary').click();
  await expect(emptyGap.locator('.astrid-vision-details-gap-description')).toBeVisible();
  await expect(emptyGap.locator('.astrid-vision-details-projects, .astrid-vision-details-empty')).toHaveCount(0);
  await expect(dialog.getByText('No current projects linked yet.', { exact: true })).toHaveCount(0);
  mkdirSync(folder, { recursive: true });
  await guidance.locator('summary').click();
  await guidance.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${folder}/fixture-optional-guidance-${info.project.name}.png` });
});

test('mobile sigils share full-height alignment and the footer illustration needs no entrance', async ({ page }, info) => {
  const feed = await pinLive(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  const visual = page.locator('.astrid-vision-tinkerer');
  expect(await visual.evaluate(node => {
    for (let current: Element | null = node; current; current = current.parentElement) {
      if (current.hasAttribute('data-reveal') || getComputedStyle(current).opacity !== '1') return false;
    }
    return true;
  })).toBe(true);
  const underline = page.locator('#astrid-vision-title .pixel-underline');
  await expect(underline).toHaveText('artistic potential');
  await expect(underline.locator('svg')).toHaveAttribute('shape-rendering', 'crispEdges');
  await expect(underline.locator('path')).toHaveAttribute('stroke-linecap', 'square');
  await expect(page.locator('#astrid-vision-title')).toHaveText(feed.vision.title);
  await expect(page.locator('#astrid-vision-standards-title')).toHaveText('What guides us');
  await expect(page.locator('#astrid-vision-north-star-title')).toHaveText('What we’re building towards');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const cards = page.locator('.astrid-vision-standards-list > li');
  const layouts = await cards.evaluateAll(nodes => nodes.map(card => {
    const sigil = card.querySelector('.astrid-vision-principle-sigil')!;
    return { card: card.getBoundingClientRect().toJSON(), sigil: sigil.getBoundingClientRect().toJSON() };
  }));
  for (const { card, sigil } of layouts) {
    expect(Math.abs(sigil.y - card.y)).toBeLessThan(2);
    expect(Math.abs(sigil.height - card.height)).toBeLessThan(3);
    expect(Math.abs(card.x + card.width - sigil.x - sigil.width - 9)).toBeLessThan(2);
  }
  expect(Math.max(...layouts.map(x => x.sigil.height)) - Math.min(...layouts.map(x => x.sigil.height))).toBeLessThan(2);
  mkdirSync(folder, { recursive: true });
  await page.locator('.astrid-vision-manifesto').screenshot({ path: `${folder}/real-pixel-hero-${info.project.name}.png` });
  await page.locator('.astrid-vision-standards').screenshot({ path: `${folder}/real-aligned-sigils-${info.project.name}.png` });
  await page.locator('.astrid-vision-contribute').screenshot({ path: `${folder}/real-static-footer-${info.project.name}.png` });
});

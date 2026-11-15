#!/usr/bin/env node
/**
 * Assert that the *served production page*, not merely the JSON exporter,
 * renders its current GitHub-authored vision after a successful deployment.
 */
import { chromium, expect } from '@playwright/test';

const PAGE = 'https://astrid.haus/vision';
const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';
const attempts = 4;
const delayMs = 15_000;

async function publishedVision() {
  const response = await fetch(FEED, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Public vision feed HTTP ${response.status}`);
  const json = await response.json();
  if (json.schemaVersion !== 1 || !json.vision?.title ||
      !Array.isArray(json.pillars) || !Array.isArray(json.principles) ||
      !Array.isArray(json.gaps)) {
    throw new Error('Published vision feed is incomplete');
  }
  return json;
}

async function checkPage(browser, content) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    const response = await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    if (!response?.ok()) throw new Error(`Production vision page HTTP ${response?.status() ?? 'no response'}`);
    // The current failure is a *rendered error state*, despite HTTP 200.
    await expect(page.locator('main.astrid-vision h1')).toHaveText(content.vision.title, { timeout: 15_000 });
    await expect(page.locator('.astrid-vision-principles h3')).toHaveCount(content.pillars.length);
    await expect(page.locator('.astrid-vision-standards-list h3')).toHaveCount(content.principles.length);
    await expect(page.locator('.astrid-vision > #astrid-vision-parts')).toHaveCount(0);
    const firstPillar = page.locator('.astrid-vision-principles > li').first();
    const goalCount = content.pillars[0].characteristics?.length ?? 0;
    await expect(firstPillar.locator('.astrid-vision-subject-counts')).toContainText(`${goalCount} ${goalCount === 1 ? 'goal' : 'goals'}`);
    await page.evaluate(() => {
      const original = HTMLDialogElement.prototype.showModal;
      window.__visionShadeStarts = [];
      HTMLDialogElement.prototype.showModal = function () {
        original.call(this);
        const style = getComputedStyle(this, '::backdrop');
        window.__visionShadeStarts.push({ ready: this.dataset.ready ?? null,
          colour: style.backgroundColor, opacity: style.opacity,
          animation: style.animationName, transition: style.transitionDuration });
      };
    });
    await firstPillar.getByRole('button').click();
    const subjectDialog = page.getByRole('dialog');
    await expect(subjectDialog.getByRole('heading', { name: 'Goals', exact: true })).toBeVisible();
    await expect(subjectDialog).toHaveAttribute('data-exterior-nav', '');
    const navigation = await subjectDialog.evaluate(node => ({
      left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
      previous: node.querySelector('.astrid-vision-details-previous').getBoundingClientRect().right,
      next: node.querySelector('.astrid-vision-details-next').getBoundingClientRect().left,
    }));
    expect(navigation.previous).toBeLessThan(navigation.left);
    expect(navigation.next).toBeGreaterThan(navigation.right);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog.astrid-vision-details')).toHaveCount(0);
    console.log('Production subject cards show goal counts; Goals and exterior desktop arrows are present.');
    await page.getByRole('button', { name: 'See all gaps', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'All gaps' })).toBeVisible();
    const gapDialog = page.getByRole('dialog', { name: 'All gaps' });
    await expect(gapDialog).toHaveCSS('opacity', '1');
    await expect.poll(() => gapDialog.evaluate(node => node.style.getPropertyValue('--vision-open-progress'))).toBe('1');
    await expect(gapDialog.locator('.astrid-vision-details-shell')).toHaveCSS('opacity', '1');
    await expect.poll(() => gapDialog.evaluate(node => getComputedStyle(node, '::backdrop').opacity)).toBe('1');
    await expect.poll(() => gapDialog.evaluate(node => getComputedStyle(node, '::backdrop').backgroundColor)).toBe('rgba(22, 20, 18, 0.58)');
    console.log('Production popup uses an opaque native layer, inner-surface reveal and constant backdrop shading.');
    await expect(page.locator('#gap-aa-001')).toBeAttached();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'See all projects', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'All projects' })).toBeVisible();
    await expect(page.locator('.astrid-vision-project-row')).toHaveCount(content.projects.length);
    await expect(page.getByRole('alert')).toHaveCount(0);
    const initialShades = await page.evaluate(() => window.__visionShadeStarts);
    expect(initialShades).toHaveLength(3);
    for (const shade of initialShades) {
      expect(shade).toEqual({ ready: null, colour: 'rgba(22, 20, 18, 0.58)',
        opacity: '1', animation: 'none', transition: '0s' });
    }
    console.log('Production dimmer is already fixed at native opening, before popup readiness.');
    console.log(`Production vision page renders ${content.pillars.length} pillars, ${content.principles.length} principles, and the first live gap.`);
  } finally {
    await page.close();
  }
}

async function checkHeadlineEntry(browser, content) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const response = await page.goto(new URL('/', PAGE).href, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    if (!response?.ok()) throw new Error(`Production Home HTTP ${response?.status() ?? 'no response'}`);
    for (let trip = 0; trip < 2; trip++) {
      const link = page.getByRole('link', { name: 'Vision', exact: true });
      await expect(link).toBeVisible({ timeout: 30_000 });
      await link.click();
      const title = page.locator('#astrid-vision-title');
      await expect(title).toHaveText(content.vision.title, { timeout: 15_000 });
      await expect(title).toHaveCSS('text-wrap', 'wrap');
      await expect.poll(() => title.evaluate(node => Math.abs(
        node.getBoundingClientRect().width - node.closest('.astrid-vision-hero-copy').getBoundingClientRect().width
      ))).toBeLessThan(1);
      await page.getByRole('link', { name: 'Astrid home', exact: true }).click();
      await expect(page.locator('.astrid-vision')).toHaveCount(0);
    }
    console.log('Production Home → Vision uses full-column, non-balanced heading flow on first entry and cached return at 390px.');
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch();
  try {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const content = await publishedVision();
        await checkPage(browser, content);
        await checkHeadlineEntry(browser, content);
        return;
      } catch (error) {
        lastError = error;
        console.error(`Production vision check ${attempt}/${attempts}: ${error instanceof Error ? error.message : error}`);
        if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    throw new Error(`Production vision never rendered the current feed after ${attempts} checks: ${lastError?.message ?? 'unknown error'}`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

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

async function checkPlayerReturn(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
  try {
    const response = await page.goto(new URL('/', PAGE).href, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    if (!response?.ok()) throw new Error(`Production Home HTTP ${response?.status() ?? 'no response'}`);
    await expect(page.locator('.astrid-callouts > article')).toHaveCount(3, { timeout: 60_000 });
    await expect(page.locator('.astrid-editor-stage')).toHaveAttribute('data-revealed', 'true');
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1800);
    const reference = await page.locator('.astrid-player-surface').evaluate(async node => {
      const read = () => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
      let previous = read(), stable = 0;
      for (let n = 0; n < 300; n++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const next = read();
        stable = next.every((value, i) => Math.abs(value - previous[i]) < .02) ? stable + 1 : 0;
        previous = next;
        if (stable >= 12) return next;
      }
      throw new Error('Production player did not settle');
    });
    await page.getByRole('link', { name: 'Vision', exact: true }).click();
    await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
    await expect(page.locator('html')).not.toHaveAttribute('data-astrid-page-transition');
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(500);
    await page.evaluate(() => {
      const trace = window.__playerReturn = { frames: [], done: false };
      let finished = 0;
      const started = performance.now();
      const read = () => {
        const home = document.querySelector('.astrid-public-site[data-astrid-lifecycle="active"]');
        if (!home) return;
        const r = home.querySelector('.astrid-player-surface').getBoundingClientRect();
        trace.frames.push({ rect: [r.x, r.y, r.width, r.height], scroll: scrollY,
          phase: document.documentElement.getAttribute('data-astrid-page-transition-style'),
          wordmark: getComputedStyle(home.querySelector('.astrid-brand-name')).viewTransitionName,
          beta: getComputedStyle(home.querySelector('.astrid-beta')).viewTransitionName,
          betaTransform: getComputedStyle(document.documentElement, '::view-transition-group(astrid-brand-beta)').transform,
          wordmarkTransform: getComputedStyle(document.documentElement, '::view-transition-group(astrid-brand-name)').transform });
      };
      const observer = new MutationObserver(read);
      observer.observe(document.documentElement, { attributes: true, subtree: true,
        attributeFilter: ['data-astrid-page-transition', 'data-astrid-page-transition-style', 'data-astrid-lifecycle'] });
      const sample = () => {
        read();
        if (trace.frames.length && !document.documentElement.hasAttribute('data-astrid-page-transition')) finished++;
        if (finished >= 8 || performance.now() - started > 12000) {
          observer.disconnect(); trace.done = true; return;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.getByRole('link', { name: 'Astrid home', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__playerReturn.done), { timeout: 20000 }).toBe(true);
    const { frames } = await page.evaluate(() => window.__playerReturn);
    const movingBrand = frames.filter(frame => frame.phase === 'brand');
    expect(movingBrand.length).toBeGreaterThan(5);
    expect(movingBrand.every(frame => frame.wordmark === 'astrid-brand-name')).toBe(true);
    expect(movingBrand.every(frame => frame.beta === 'astrid-brand-beta')).toBe(true);
    expect(new Set(movingBrand.map(frame => frame.betaTransform).filter(value => value !== 'none')).size).toBeGreaterThan(3);
    expect(new Set(movingBrand.map(frame => frame.wordmarkTransform).filter(value => value !== 'none')).size).toBeGreaterThan(3);
    expect(frames.some(frame => frame.phase === null)).toBe(true);
    for (const frame of frames) {
      expect(frame.scroll).toBe(0);
      for (const [i, value] of frame.rect.entries()) expect(Math.abs(value - reference[i])).toBeLessThan(1);
    }
    console.log('Production desktop player keeps its bounds throughout bottom-of-Vision return and transition cleanup.');
    console.log('Production Astrid wordmark travels with the mink instead of appearing in the root crossfade.');
    console.log('Production Beta/Vision badge travels with the brand instead of appearing at its destination early.');

    // Wide landscape tablets use this composition, outside the <=1099px layout.
    // Read the delivered sizing rule too: headless Chromium has no browser bars,
    // so its vh and dvh would otherwise look identical in a settled screenshot.
    await page.setViewportSize({ width: 1180, height: 700 });
    const dynamicMinimum = await page.evaluate(() => {
      const find = rules => Array.from(rules).some(rule =>
        (rule instanceof CSSStyleRule && rule.selectorText === '.astrid-public-site' && rule.style.minHeight === '100dvh') ||
        ('cssRules' in rule && find(rule.cssRules)));
      return Array.from(document.styleSheets).filter(sheet => !sheet.href || new URL(sheet.href).origin === location.origin)
        .some(sheet => find(sheet.cssRules));
    });
    expect(dynamicMinimum, 'served wide Home uses the visible viewport minimum').toBe(true);
    for (const audience of ['App', 'Agent']) {
      await page.locator('.astrid-public-site').getByRole('button', { name: audience, exact: true }).click();
      await expect(page.locator('.astrid-public-site')).toHaveAttribute('data-audience', audience.toLowerCase());
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
      await page.evaluate(() => scrollTo({ top: 10000, behavior: 'instant' }));
      expect(await page.evaluate(() => scrollY)).toBe(0);
      await page.getByRole('link', { name: 'Vision', exact: true }).click();
      await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
      await expect(page.locator('html')).not.toHaveAttribute('data-astrid-page-transition');
      await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
      expect(await page.evaluate(() => scrollY)).toBeGreaterThan(500);
      await page.getByRole('link', { name: 'Astrid home', exact: true }).click();
      await expect(page.locator('.astrid-vision')).toHaveCount(0);
      await expect(page.locator('html')).not.toHaveAttribute('data-astrid-page-transition');
      const fit = await page.locator('.astrid-public-site').evaluate(node => ({ y: scrollY, top: node.getBoundingClientRect().top,
        overflow: document.documentElement.scrollHeight - innerHeight }));
      expect(fit.y).toBe(0);
      expect(Math.abs(fit.top)).toBeLessThan(1);
      expect(fit.overflow).toBeLessThanOrEqual(1);
    }
    console.log('Production landscape Home uses the dynamic viewport minimum; App and Agent fit and return from scrolled Vision at zero.');
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
        await checkPlayerReturn(browser);
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

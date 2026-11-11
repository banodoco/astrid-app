import { expect, test, type Page } from '@playwright/test';

const site = '.astrid-public-site';
const cards = '.astrid-mobile-feature';

async function openHome(page: Page, width = 390, height = 664) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => localStorage.removeItem('astrid:prefers-app'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator(site)).toBeVisible();
  await expect(page.locator('.astrid-editor-stage')).toHaveAttribute('data-revealed', 'true', { timeout: 60_000 });
}

async function assertViewportFit(page: Page) {
  const size = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
  }));
  expect(size.width).toBeLessThanOrEqual(size.viewportWidth + 1);
  expect(size.height).toBeLessThanOrEqual(size.viewportHeight + 1);
  const cta = await page.getByRole('link', { name: 'Get Started', exact: true }).boundingBox();
  expect(cta).not.toBeNull();
  expect(cta!.y + cta!.height).toBeLessThanOrEqual(size.viewportHeight);
}

async function stableBoxes(page: Page) {
  return page.locator('.astrid-audience-switch, .astrid-mobile-footer, .astrid-editor-stage, .astrid-player-surface, .astrid-timeline-surface').evaluateAll(elements => elements.map(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  }));
}

test.describe('single-screen phone homepage', () => {
  test.setTimeout(120_000);

  for (const viewport of [{ width: 375, height: 640 }, { width: 390, height: 664 }, { width: 430, height: 800 }]) {
    test(`fits ${viewport.width}×${viewport.height} with both audiences and open cards`, async ({ page }, testInfo) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openHome(page, viewport.width, viewport.height);
      for (const audience of ['App', 'Agent']) {
        await page.getByRole('navigation', { name: 'Explore Astrid' }).getByRole('button', { name: audience, exact: true }).click();
        await expect(page.locator(site)).toHaveAttribute('data-audience', audience.toLowerCase());
        await expect(page.locator(cards)).toHaveCount(3);
        await assertViewportFit(page);
        const before = await stableBoxes(page);
        for (const trigger of await page.locator(`${cards} button[aria-expanded]`).all()) {
          await trigger.click();
          await expect(trigger).toHaveAttribute('aria-expanded', 'true');
          await expect(page.locator(`${cards}[data-open="true"]`)).toHaveCount(1);
          await expect(page.locator('[data-astrid-feature-highlight]')).toHaveCount(1);
          expect(await stableBoxes(page)).toEqual(before);
          await assertViewportFit(page);
        }
        await page.screenshot({ path: testInfo.outputPath(`${audience.toLowerCase()}-${viewport.width}.png`) });
        await page.keyboard.press('Escape');
        await expect(page.locator(`${cards}[data-open="true"]`)).toHaveCount(0);
      }
    });
  }

  test('animates without shifting the page and dismisses by outside tap', async ({ page }, testInfo) => {
    await openHome(page);
    const trigger = page.getByRole('button', { name: 'Live-code effects' });
    const before = await stableBoxes(page);
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('region', { name: 'Live-code effects' })).toBeVisible();
    // Wait for the actual reveal transition rather than only its React state.
    await expect.poll(() => page.locator('[data-callout="effects"] .astrid-mobile-feature-detail').evaluate(el => getComputedStyle(el).opacity)).toBe('1');
    expect(await stableBoxes(page)).toEqual(before);
    await page.screenshot({ path: testInfo.outputPath('effects-expanded.png') });
    await page.locator('#astrid-hero-title').click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('preserves integration navigation, resets on audience changes, and respects reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openHome(page);
    const nav = page.getByRole('navigation', { name: 'Explore Astrid' });
    await nav.getByRole('button', { name: 'Agent', exact: true }).click();
    const tools = page.getByRole('button', { name: 'Connected to open-source tools' });
    await tools.click();
    const link = page.getByRole('link', { name: 'ComfyUI', exact: true });
    await expect(link).toBeVisible();
    await link.focus();
    await page.keyboard.press('Escape');
    await expect(tools).toBeFocused();
    await expect(link).not.toBeVisible();
    await tools.click();
    await nav.getByRole('button', { name: 'App', exact: true }).click();
    await nav.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(page.locator(`${cards}[data-open="true"]`)).toHaveCount(0);
    expect(await page.locator('.astrid-mobile-feature-reveal').first().evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
  });

  test('permits scrolling on short screens and keeps the desktop presentation', async ({ page }) => {
    await openHome(page, 320, 480);
    await page.getByRole('link', { name: 'Get Started', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('link', { name: 'Get Started', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.astrid-mobile-callouts')).toHaveCount(0);
    await expect(page.locator('.astrid-callout-connectors').first()).toBeVisible();
    expect(await page.locator('.astrid-mobile-footer').evaluate(el => getComputedStyle(el).display)).toBe('contents');
    await page.setViewportSize({ width: 390, height: 664 });
    await expect(page.locator('.astrid-mobile-callouts')).toHaveCount(1);
    await page.evaluate(() => scrollTo(0, 0));
    await assertViewportFit(page);
  });
});

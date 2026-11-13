import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const folder = 'test-results/vision-captures';

async function capture(page: import('@playwright/test').Page, selector: string, name: string) {
  const target = page.locator(selector);
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeVisible();
  // Reveal every scroll-triggered child before taking a full-section screenshot.
  // The live page animates each item as a visitor scrolls, so a single instant
  // element screenshot would otherwise capture content still hidden off-screen.
  const metrics = await target.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { top: window.scrollY + rect.top, height: rect.height, viewport: window.innerHeight };
  });
  const step = Math.max(160, Math.floor(metrics.viewport * 0.55));
  for (let y = metrics.top; y <= metrics.top + metrics.height; y += step) {
    await page.evaluate(top => window.scrollTo(0, top), y);
    await page.waitForTimeout(100);
  }
  await page.evaluate(top => window.scrollTo(0, top), metrics.top);
  await page.waitForTimeout(450); // let entrance animation settle
  await target.screenshot({ path: join(folder, name), animations: 'disabled' });
}

test('capture actual vision page on desktop and phone', async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(folder, { recursive: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('main.astrid-vision')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await capture(page, '.astrid-vision-manifesto', 'desktop-hero.png');
  await capture(page, '.astrid-vision-north-star', 'desktop-pillars.png');
  await capture(page, '.astrid-vision-standards', 'desktop-principles.png');
  await page.getByRole('button', { name: 'See all gaps', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: join(folder, 'desktop-gaps.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'See all projects', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: join(folder, 'desktop-projects.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('main.astrid-vision')).toBeVisible();
  await capture(page, '.astrid-vision-manifesto', 'phone-hero.png');
  await capture(page, '.astrid-vision-north-star', 'phone-pillars.png');
  await capture(page, '.astrid-vision-standards', 'phone-principles.png');
  await page.getByRole('button', { name: 'See all gaps', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: join(folder, 'phone-gaps.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'See all projects', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: join(folder, 'phone-projects.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
});

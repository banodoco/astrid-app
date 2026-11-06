import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const folder = 'test-results/vision-captures';

async function capture(page: import('@playwright/test').Page, selector: string, name: string) {
  const target = page.locator(selector);
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeVisible();
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
  await capture(page, '.astrid-vision-parts', 'desktop-gaps.png');
  await capture(page, '.astrid-vision-projects', 'desktop-projects.png');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('main.astrid-vision')).toBeVisible();
  await capture(page, '.astrid-vision-manifesto', 'phone-hero.png');
  await capture(page, '.astrid-vision-north-star', 'phone-pillars.png');
  await capture(page, '.astrid-vision-standards', 'phone-principles.png');
  await capture(page, '.astrid-vision-parts', 'phone-gaps.png');
  await capture(page, '.astrid-vision-projects', 'phone-projects.png');
});

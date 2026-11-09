import { expect, test } from '@playwright/test';

async function waitForPublicSurface(page: import('@playwright/test').Page) {
  await expect(page.locator('main.astrid-public-site, main.astrid-vision').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
}

test('keeps one coherent sky and palette across Home ↔ Vision', async ({ page }) => {
  await page.goto('/home', { waitUntil: 'domcontentloaded' });
  await waitForPublicSurface(page);
  await expect(page.locator('main.astrid-public-site')).toBeVisible();
  await expect(page.locator('.astrid-sky canvas')).toHaveCount(4);
  const homePaper = await page.locator('html').evaluate((element) => getComputedStyle(element).getPropertyValue('--astrid-root-paper'));

  await page.getByRole('link', { name: 'Vision' }).click();
  await expect(page).toHaveURL(/\/vision$/);
  await waitForPublicSurface(page);
  await expect(page.locator('main.astrid-vision')).toBeVisible();
  await expect(page.locator('.astrid-sky canvas')).toHaveCount(4);
  const visionPaper = await page.locator('html').evaluate((element) => getComputedStyle(element).getPropertyValue('--astrid-root-paper'));
  expect(visionPaper).toBe(homePaper);

  await page.goBack();
  await expect(page).toHaveURL(/\/home$/);
  await waitForPublicSurface(page);
  await expect(page.locator('main.astrid-public-site')).toBeVisible();
  await expect(page.locator('.astrid-sky canvas')).toHaveCount(4);
});

test('loads Vision directly with its sky and dusk palette', async ({ page }) => {
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await waitForPublicSurface(page);
  await expect(page.locator('main.astrid-vision')).toBeVisible();
  await expect(page.locator('.astrid-sky canvas')).toHaveCount(4);
  const paper = await page.locator('html').evaluate((element) => getComputedStyle(element).getPropertyValue('--astrid-root-paper'));
  expect(paper.trim()).not.toBe('');
});

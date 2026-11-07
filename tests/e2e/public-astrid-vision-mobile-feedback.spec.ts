import { expect, test } from '@playwright/test';

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';

test('mobile gaps start collapsed and can be opened and closed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const first = page.locator('#gap-aa-001');
  const body = first.locator('.astrid-vision-part-body');
  const toggle = first.locator('h3 button');

  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(body).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(body).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(body).toBeHidden();
});

test('show all gaps reveals previously unseen rows, and can show fewer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const firstSix = page.locator('.astrid-vision-part');
  await expect(firstSix).toHaveCount(6);
  const all = page.getByRole('button', { name: /Show all \d+ gaps/ });
  const total = Number((await all.textContent())?.match(/\d+/)?.[0]);
  expect(total).toBeGreaterThan(6);
  await all.click();
  await expect(page.locator('.astrid-vision-part')).toHaveCount(total);
  const added = page.locator('#gap-ls-003');
  await added.scrollIntoViewIfNeeded();
  await expect(added).toBeVisible();
  await expect.poll(() => added.evaluate(el => getComputedStyle(el).opacity)).toBe('1');
  await page.getByRole('button', { name: 'Show featured gaps only' }).click();
  await expect(page.locator('.astrid-vision-part')).toHaveCount(6);
});

test('pillars are numbered 1–4 and use deliberate mobile title wrapping', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const numbers = page.locator('.astrid-vision-pillar-number');
  await expect(numbers).toHaveText(['1.', '2.', '3.', '4.']);
  const title = page.locator('.astrid-vision-principles h3').first();
  const lines = await title.evaluate(el => {
    const css = getComputedStyle(el);
    const lineHeight = Number.parseFloat(css.lineHeight);
    return el.getBoundingClientRect().height / lineHeight;
  });
  expect(lines).toBeGreaterThan(1.5);
});

test('contribution invitation is rendered from the same live vision feed', async ({ page, request }) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const live = await response.json() as Record<string, unknown>;
  const vision = live.vision as Record<string, unknown>;
  const message = 'You and your agents can contribute. The ownership model is being worked out.';
  const link = '[Give these instructions to your agent](https://github.com/banodoco/astrid-dev#instructions)';
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({
      ...live,
      vision: { ...vision, contributeMarkdown: message + '\n\n' + link },
    }),
  }));
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const contribution = page.locator('.astrid-vision-contribute');
  await expect(contribution.getByRole('heading', { name: 'Want to help build Astrid?' })).toBeVisible();
  await expect(contribution).toContainText(message);
  await expect(contribution.getByRole('link', { name: 'Give these instructions to your agent' }))
    .toHaveAttribute('href', 'https://github.com/banodoco/astrid-dev#instructions');
});

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

test('current gaps show a compact list; status filter reveals all and closed', async ({ page, request }) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const data = await response.json() as { gaps: { assessment: string }[] };
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(data),
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const items = page.locator('.astrid-vision-part');
  const current = data.gaps.filter(gap => gap.assessment !== 'closed').length;
  const filter = page.getByRole('combobox', { name: 'Filter gaps by status' });
  await expect(filter).toHaveValue('current');
  await expect(items).toHaveCount(Math.min(10, current));
  await expect(items.first().locator('.astrid-vision-part-body')).toBeHidden();
  const showAll = page.getByRole('button', { name: 'Show all gaps' });
  await expect(showAll).toHaveAttribute('aria-expanded', 'false');
  await showAll.click();
  await expect(items).toHaveCount(current);
  await expect(page.locator('#gap-ls-004')).toBeVisible();
  await page.getByRole('button', { name: 'Show fewer gaps' }).click();
  await expect(items).toHaveCount(Math.min(10, current));
  await expect(page.locator('#gap-ls-004')).toHaveCount(0);
  await filter.selectOption('all');
  await expect(items).toHaveCount(Math.min(10, data.gaps.length));
  await showAll.click();
  await expect(items).toHaveCount(data.gaps.length);
  await filter.selectOption('closed');
  await expect(items).toHaveCount(data.gaps.filter(gap => gap.assessment === 'closed').length);
  await filter.selectOption('current');
  await expect(items).toHaveCount(Math.min(10, current));
  await expect(showAll).toHaveAttribute('aria-expanded', 'false');
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
  await expect(contribution.getByRole('link', { name: 'Give these instructions to your agent' })).toHaveCount(0);
  await expect(contribution.getByRole('button', { name: 'Copy instructions for agents' })).toBeVisible();
});

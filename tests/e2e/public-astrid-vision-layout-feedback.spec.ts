import { expect, test } from '@playwright/test';


async function openCatalog(page: import('@playwright/test').Page, kind: 'gaps' | 'projects', current = true) {
  if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'See all ' + kind, exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'All ' + kind })).toBeVisible();
  if (current) await page.getByRole('combobox', { name: 'Filter ' + kind + ' by status' }).selectOption('current');
}

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';

test('desktop shows eight preloaded cards plus a view-all tile, then all without stale reveal', async ({page, request}) => {
  await page.setViewportSize({width: 1440, height: 900});
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const data = await response.json() as {projects: {status: string}[]};
  const total = data.projects.filter(p => p.status !== 'done' && p.status !== 'cancelled').length;
  // Pin the response being asserted; a live publish can happen between API and browser requests.
  await page.route(FEED, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: {'access-control-allow-origin': '*'},
    body: JSON.stringify(data),
  }));
  await page.goto('/vision', {waitUntil: 'domcontentloaded'});
  await openCatalog(page, 'projects', true);
  const grid = page.locator('.astrid-vision-project-list');
  const cards = grid.locator('.astrid-vision-project-row');
  await expect(cards).toHaveCount(8);
  const columns = await grid.evaluate(e => getComputedStyle(e).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(3);
  const button = grid.getByRole('button', {name: /View all .*current projects/});
  await button.click();
  await expect(cards).toHaveCount(total);
  const last = cards.last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeVisible();
  await expect.poll(() => last.evaluate(e => getComputedStyle(e).opacity)).toBe('1');
  await page.getByRole('button', {name: 'Show fewer projects'}).click();
  await expect(cards).toHaveCount(8);
});

test('expanded mobile gap details occupy the entire row, including the ID column', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/vision', {waitUntil: 'domcontentloaded'});
  await openCatalog(page, 'gaps', true);
  const gap = page.locator('#gap-aa-001');
  await gap.locator('h3 button').click();
  const body = gap.locator('.astrid-vision-part-body');
  await expect(body).toBeVisible();
  const rect = await gap.evaluate(element => {
    const details = element.querySelector('.astrid-vision-part-body')!;
    const outer = element.getBoundingClientRect();
    const inner = details.getBoundingClientRect();
    return {left: inner.left - outer.left, right: outer.right - inner.right};
  });
  expect(Math.abs(rect.left)).toBeLessThan(3);
  expect(Math.abs(rect.right)).toBeLessThan(3);
});

test('gap IDs remain on one line alongside titles on phone and desktop', async ({page}) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({width, height: 900});
    await page.goto('/vision', {waitUntil: 'domcontentloaded'});
  await openCatalog(page, 'gaps', true);
    await page.getByRole('button', { name: 'Show all gaps' }).click();
    for (const id of ['AA-001', 'F-003'] as const) {
      const item = page.locator('#gap-' + id.toLowerCase());
      const label = item.locator('.astrid-vision-part-number');
      const title = item.locator('.astrid-vision-part-title');
      await expect(label).toHaveText(id);
      await expect(item.locator('h3 button')).toHaveAttribute('aria-expanded', 'false');
      const [numberBox, titleBox] = await Promise.all([label.boundingBox(), title.boundingBox()]);
      expect(numberBox).not.toBeNull();
      expect(titleBox).not.toBeNull();
      expect(numberBox!.x + numberBox!.width).toBeLessThan(titleBox!.x);
      expect(numberBox!.height).toBeLessThan(28);
      expect(Math.abs(numberBox!.y + numberBox!.height / 2 -
        (titleBox!.y + titleBox!.height / 2))).toBeLessThan(14);
    }
  }
});

test('first visit paints stable text skeletons until GitHub content becomes available', async ({page, request}) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  await page.route(FEED, async route => {
    await new Promise(resolve => setTimeout(resolve, 1100));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {'access-control-allow-origin': '*'},
      body: JSON.stringify(data),
    });
  });
  await page.goto('/vision', {waitUntil: 'domcontentloaded'});
  await expect(page.locator('.astrid-vision-skeleton-hero')).toBeVisible();
  await expect(page.locator('.astrid-vision-loading-pillars .astrid-vision-loading-pillar')).toHaveCount(4);
  await expect(page.locator('.astrid-vision-loading-projects')).toHaveCount(0);
  await expect(page.locator('.astrid-vision-principles h3')).toHaveCount(4);
  await expect(page.locator('.astrid-vision-loading-sections')).toHaveCount(0);
});

test('only the new contribution section and workbench mink remain after the projects', async ({page, request}) => {
  const r = await request.get(FEED);
  const raw = await r.json() as Record<string, any>;
  await page.route(FEED, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: {'access-control-allow-origin': '*'},
    body: JSON.stringify({...raw, vision: {...raw.vision,
      contributeMarkdown: 'You and your agents can help build Astrid.\n\n[Give these instructions to your agent](https://github.com/banodoco/astrid-dev#people)'
    }})
  }));
  await page.goto('/vision', {waitUntil: 'domcontentloaded'});
  const section = page.locator('.astrid-vision-contribute');
  await expect(section).toContainText('You and your agents');
  await expect(section.locator('.astrid-vision-tinkerer')).toHaveCount(1);
  await expect(section.getByRole('link', {name: 'Give these instructions to your agent'})).toHaveCount(0);
  await expect(section.getByRole('button', {name: 'Copy instructions for agents'})).toBeVisible();
  await expect(page.locator('.astrid-vision-shift')).toHaveCount(0);
  await expect(page.locator('.astrid-vision-mobile-juggler')).toHaveCount(0);
  await expect(page.locator('.astrid-vision-content-source')).toHaveCount(0);
});

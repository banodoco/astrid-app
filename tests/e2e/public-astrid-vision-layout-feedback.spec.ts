import { expect, test } from '@playwright/test';

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
  const grid = page.locator('.astrid-vision-project-list');
  const cards = grid.locator('.astrid-vision-project-row');
  await expect(cards).toHaveCount(8);
  const columns = await grid.evaluate(e => getComputedStyle(e).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(3);
  const button = grid.getByRole('button', {name: /View all .*open projects/});
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

test('gap IDs stay on one line and disclosures begin closed on phone and desktop', async ({page}) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({width, height: 900});
    await page.goto('/vision', {waitUntil: 'domcontentloaded'});
    const first = page.locator('#gap-aa-001');
    const toggle = first.locator('h3 button');
    const id = first.locator('.astrid-vision-part-number');
    await expect(id).toHaveText('AA-001');
    await expect.poll(() => id.evaluate(el => getComputedStyle(el).whiteSpace)).toBe('nowrap');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(first.locator('.astrid-vision-part-body')).toBeHidden();
    const compactHeight = await first.evaluate(el => el.getBoundingClientRect().height);
    expect(compactHeight).toBeLessThan(width < 500 ? 110 : 100);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(first.locator('.astrid-vision-part-body')).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(first.locator('.astrid-vision-part-body')).toBeHidden();
  }
});

test('four vision sections share one header system without explanatory paragraphs', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 900});
  await page.goto('/vision', {waitUntil: 'domcontentloaded'});
  const sections = page.locator('.astrid-vision-north-star, .astrid-vision-standards, .astrid-vision-parts, .astrid-vision-projects');
  await expect(sections).toHaveCount(4);
  const headers = sections.locator('.astrid-vision-section-head');
  await expect(headers).toHaveCount(4);
  await expect(headers.locator('h2')).toHaveText([
    "What we're building towards", "The principles that drive us",
    "What's still missing", "Help us build what's next",
  ]);
  const styles = await headers.evaluateAll(elements => elements.map(el => {
    const css = getComputedStyle(el);
    const title = el.querySelector('h2')!;
    return {
      rule: css.borderBottomStyle,
      width: css.borderBottomWidth,
      color: css.borderBottomColor,
      pad: css.paddingBottom,
      headingSize: getComputedStyle(title).fontSize,
      eyebrowOnly: el.querySelectorAll(':scope > p').length === 1,
      x: el.getBoundingClientRect().left,
    };
  }));
  expect(styles.every(s => s.rule === 'solid' && s.width === '1px' && s.eyebrowOnly)).toBeTruthy();
  expect(new Set(styles.map(s => s.color)).size).toBe(1);
  expect(new Set(styles.map(s => s.pad)).size).toBe(1);
  expect(new Set(styles.map(s => s.headingSize)).size).toBe(1);
  expect(Math.max(...styles.map(s => s.x)) - Math.min(...styles.map(s => s.x))).toBeLessThan(2);
  await expect(page.locator('.astrid-vision-parts-head')).not.toContainText('The vision is ambitious');
  await expect(page.locator('.astrid-vision-issues-head')).not.toContainText('These projects come directly');
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
  await expect(page.locator('.astrid-vision-loading-projects .astrid-vision-loading-project')).toHaveCount(9);
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
      contributeMarkdown: 'You and your agents can help build Astrid. [Give your agent these instructions](https://github.com/banodoco/astrid-dev#people).'
    }})
  }));
  await page.goto('/vision', {waitUntil: 'domcontentloaded'});
  const section = page.locator('.astrid-vision-contribute');
  await expect(section).toContainText('You and your agents');
  await expect(section.locator('.astrid-vision-tinkerer')).toHaveCount(1);
  await expect(section.getByRole('link', {name: 'Give your agent these instructions'})).toHaveAttribute('href', 'https://github.com/banodoco/astrid-dev#people');
  await expect(page.locator('.astrid-vision-shift')).toHaveCount(0);
  await expect(page.locator('.astrid-vision-mobile-juggler')).toHaveCount(0);
  await expect(page.locator('.astrid-vision-content-source')).toHaveCount(0);
});

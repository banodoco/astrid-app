import { expect, test } from '@playwright/test';

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';

async function pinnedFeed(page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext) {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const content = await response.json();
  await page.route(FEED, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(content),
  }));
}

test('the four principles show distinct in-page pixel sigils, with no raster images or placeholder frames', async ({ page, request }) => {
  await pinnedFeed(page, request);
  for (const width of [390, 1440, 1720]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    const cards = page.locator('.astrid-vision-standards-list > li');
    await expect(cards).toHaveCount(4);
    const sigils = cards.locator('.astrid-vision-principle-sigil');
    await expect(sigils).toHaveCount(4);
    await expect(sigils.locator('svg[viewBox="0 0 40 40"]')).toHaveCount(4);
    await expect(sigils.locator('img')).toHaveCount(0);
    const colors = await sigils.evaluateAll(elements =>
      elements.map(element => getComputedStyle(element).color));
    expect(new Set(colors).size).toBe(4);
    const structure = [
      '.astrid-vision-sigil-orbit',
      '.astrid-vision-sigil-open-ring',
      '.astrid-vision-sigil-hand',
      '.astrid-vision-sigil-knot',
    ];
    for (let index = 0; index < 4; index++) {
      await expect(cards.nth(index).locator(structure[index])).toHaveCount(1);
      const mark = await sigils.nth(index).boundingBox();
      const card = await cards.nth(index).boundingBox();
      expect(mark).not.toBeNull();
      expect(card).not.toBeNull();
      expect(mark!.x).toBeGreaterThanOrEqual(card!.x);
      expect(mark!.x + mark!.width).toBeLessThanOrEqual(card!.x + card!.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  }
});

test('each principle animates a different part of its sigil on hover and respects reduced motion', async ({ page, request }) => {
  await pinnedFeed(page, request);
  await page.setViewportSize({ width: 1720, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const cards = page.locator('.astrid-vision-standards-list > li');
  const motions = [
    ['.astrid-vision-sigil-orbit', 'astrid-vision-sigil-orbit'],
    ['.astrid-vision-sigil-open-ring', 'astrid-vision-sigil-ring'],
    ['.astrid-vision-sigil-spark', 'astrid-vision-sigil-spark-rise'],
    ['.astrid-vision-sigil-clear-path', 'astrid-vision-sigil-clear'],
  ] as const;
  for (let i = 0; i < motions.length; i++) {
    await cards.nth(i).hover();
    await expect(cards.nth(i).locator(motions[i][0])).toHaveCSS('animation-name', motions[i][1]);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (let i = 0; i < motions.length; i++) {
    await expect(cards.nth(i).locator(motions[i][0])).toHaveCSS('animation-name', 'none');
  }
});

test('sticky header navigation tracks sections and folds the wordmark to its icon', async ({ page, request }) => {
  await pinnedFeed(page, request);
  await page.setViewportSize({ width: 1720, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const nav = page.getByRole('navigation', { name: 'Vision page sections' });
  await expect(nav).toBeVisible();
  const header = page.locator('.astrid-vision > header.astrid-vision-bar');
  const wordmark = header.locator('.astrid-vision-brand-name');
  await expect(header).toHaveCSS('position', 'sticky');
  await expect(header.locator('nav')).toHaveCount(1);
  await expect(nav).toHaveCSS('position', 'relative');
  await expect(wordmark).toHaveCSS('max-width', '100px');
  await expect(nav.getByRole('link')).toHaveCount(6);
  expect(await nav.locator('a').evaluateAll(elements => elements.map(el => el.getAttribute('href'))))
    .toEqual([
      '#astrid-vision-manifesto', '#astrid-vision-pillars', '#astrid-vision-standards',
      '#astrid-vision-parts', '#astrid-vision-projects', '#astrid-vision-contribute',
    ]);
  const brand = header.locator('.astrid-vision-brand');
  const brandRect = await brand.boundingBox();
  const navRect = await nav.boundingBox();
  expect(brandRect).not.toBeNull();
  expect(navRect).not.toBeNull();
  expect(navRect!.x).toBeGreaterThanOrEqual(brandRect!.x + brandRect!.width);
  await expect(nav.getByRole('link', { name: /Vision$/ })).toHaveAttribute('aria-current', 'location');

  for (const [label, id] of [
    ['Pillars', 'astrid-vision-pillars'],
    ['Principles', 'astrid-vision-standards'],
    ['Gaps', 'astrid-vision-parts'],
    ['Projects', 'astrid-vision-projects'],
    ['Help us build', 'astrid-vision-contribute'],
  ]) {
    const link = nav.getByRole('link', { name: new RegExp(label + '$') });
    await link.click();
    await expect(link).toHaveAttribute('href', '#' + id);
    await expect(link).toHaveAttribute('aria-current', 'location');
    await expect(page.locator('#' + id)).toBeVisible();
  }

  await expect(header).toHaveAttribute('data-condensed', 'true');
  await expect(wordmark).toHaveCSS('max-width', '0px');
  await expect(wordmark).toHaveCSS('opacity', '0');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(header).not.toHaveAttribute('data-condensed', 'true');
  await expect(wordmark).toHaveCSS('opacity', '1');
});

test('phones get one compact sticky header with navigation beside a folding Astrid wordmark', async ({ page, request }) => {
  await pinnedFeed(page, request);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const nav = page.getByRole('navigation', { name: 'Vision page sections' });
  const header = page.locator('.astrid-vision > header.astrid-vision-bar');
  const brand = header.locator('.astrid-vision-brand');
  await expect(header).toHaveCSS('position', 'sticky');
  await expect(nav).toHaveCSS('position', 'relative');
  await expect(header.locator('nav')).toHaveCount(1);
  const brandBox = await brand.boundingBox();
  const navBox = await nav.boundingBox();
  expect(brandBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(navBox!.x).toBeGreaterThanOrEqual(brandBox!.x + brandBox!.width);
  const size = await nav.boundingBox();
  expect(size).not.toBeNull();
  expect(size!.x).toBeGreaterThanOrEqual(0);
  expect(size!.x + size!.width).toBeLessThanOrEqual(391);
  const link = nav.getByRole('link', { name: /Gaps$/ });
  await link.click();
  await expect(link).toHaveAttribute('aria-current', 'location');
  await expect(page).toHaveURL(/#astrid-vision-parts$/);
  await expect(page.locator('#astrid-vision-parts')).toBeVisible();
  await expect(header).toHaveAttribute('data-condensed', 'true');
  await expect(header.locator('.astrid-vision-brand-name')).toHaveCSS('max-width', '0px');
  const icon = header.locator('.astrid-vision-brand img');
  await expect(icon).toBeVisible();
  const active = await link.boundingBox();
  const navBounds = await nav.boundingBox();
  expect(active).not.toBeNull();
  expect(navBounds).not.toBeNull();
  expect(active!.x).toBeGreaterThanOrEqual(navBounds!.x - 1);
  expect(active!.x + active!.width).toBeLessThanOrEqual(navBounds!.x + navBounds!.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});


test('principle sigils use softer faded page colors while retaining delicate hover effects', async ({ page, request }) => {
  await pinnedFeed(page, request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const cards = page.locator('.astrid-vision-standards-list > li');
  const marks = cards.locator('.astrid-vision-principle-sigil');
  for (let index = 0; index < 4; index++) {
    await expect(marks.nth(index)).toHaveCSS('opacity', '0.58');
    await expect(marks.nth(index)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }
  const colors = await marks.evaluateAll(elements => elements.map(element => getComputedStyle(element).color));
  expect(new Set(colors).size).toBe(4);
  await cards.nth(0).hover();
  await expect(marks.nth(0)).toHaveCSS('opacity', '0.82');
  await expect(cards.nth(0).locator('.astrid-vision-sigil-orbit'))
    .toHaveCSS('animation-name', 'astrid-vision-sigil-orbit');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(cards.nth(0).locator('.astrid-vision-sigil-orbit')).toHaveCSS('animation-name', 'none');
});


test('the enlarged header spans the viewport while navigation stays aligned in one bar', async ({ page, request }) => {
  await pinnedFeed(page, request);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [390, 760, 1200, 1720]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    const header = page.locator('.astrid-vision > header.astrid-vision-bar');
    const nav = header.getByRole('navigation', { name: 'Vision page sections' });
    const bounds = await header.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(-1);
    expect(bounds!.x).toBeLessThanOrEqual(1);
    expect(bounds!.x + bounds!.width).toBeGreaterThanOrEqual(width - 1);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    expect(bounds!.height).toBeGreaterThanOrEqual(width <= 760 ? 68 : 86);
    await expect(header).toHaveCSS('position', 'sticky');
    await expect(nav.getByRole('link')).toHaveCount(6);
    const pillars = nav.getByRole('link', { name: /Pillars$/ });
    await expect(pillars).toHaveAttribute('href', '#astrid-vision-pillars');
    await pillars.click();
    await expect(pillars).toHaveAttribute('aria-current', 'location');
    await expect(page.getByRole('heading', { name: 'The four pillars of our vision' })).toBeVisible();
    await expect(page).toHaveURL(/#astrid-vision-pillars$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  }
});

test('the joined principle panels and corner arrows never gain light fills, even on hover in dusk', async ({ page, request }) => {
  await pinnedFeed(page, request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const cards = page.locator('.astrid-vision-standards-list > li');
  await expect(cards).toHaveCount(4);
  const checkTransparent = async () => {
    const surfaces = await cards.evaluateAll(elements => elements.map(el => ({
      card: getComputedStyle(el).backgroundColor,
      arrow: getComputedStyle(el.querySelector('.astrid-vision-principle-corner')!).backgroundColor,
    })));
    expect(surfaces).toEqual(Array.from({ length: 4 }, () =>
      ({ card: 'rgba(0, 0, 0, 0)', arrow: 'rgba(0, 0, 0, 0)' })));
  };
  await checkTransparent();
  await page.locator('main.astrid-vision').evaluate(element => {
    element.style.setProperty('--astrid-dusk', '1');
    element.style.setProperty('--astrid-dusk-ink', '1');
    element.style.setProperty('--astrid-dusk-firm', '1');
  });
  await checkTransparent();
  await cards.last().hover();
  await checkTransparent();
});

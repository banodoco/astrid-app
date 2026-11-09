import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';
async function pinFeed(page: Page, request: APIRequestContext) {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const content = await response.json();
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(content),
  }));
  return content;
}
const sections = [
  ['Vision', 'astrid-vision-overview'],
  ['Principles', 'astrid-vision-principles'],
  ['Gaps', 'astrid-vision-gaps'],
  ['Projects', 'astrid-vision-projects'],
  ['Help us', 'astrid-vision-contribute'],
] as const;

test('four background-free pixel sigils preserve the page palette and animate only on hover', async ({ page, request }) => {
  await pinFeed(page, request);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/vision');
  const cards = page.locator('.astrid-vision-standards-list > li');
  const marks = cards.locator('[data-sigil]');
  await expect(marks).toHaveCount(4);
  expect(await marks.evaluateAll(elements => elements.map(el => el.getAttribute('data-sigil'))))
    .toEqual(['core', 'open', 'hand', 'threads']);
  await expect(marks.locator('svg')).toHaveCount(4);
  await expect(marks.locator('image, img, filter')).toHaveCount(0);
  const colors = await marks.evaluateAll(elements => elements.map(el => getComputedStyle(el).color));
  expect(new Set(colors).size).toBe(4);
  const animatedParts = ['.vision-sigil-satellite', '.vision-sigil-orbit', '.vision-sigil-spark', '.vision-sigil-thread-tangle'];
  const names = ['vision-sigil-local-orbit', 'vision-sigil-open-orbit', 'vision-sigil-lift', 'vision-sigil-untangle'];
  for (let index = 0; index < 4; index++) {
    const card = cards.nth(index);
    const mark = marks.nth(index);
    await expect(mark).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(mark).toHaveCSS('border-top-width', '0px');
    await expect(mark.locator('svg')).toHaveAttribute('shape-rendering', 'crispEdges');
    await page.mouse.move(0, 0);
    await expect(mark.locator(animatedParts[index])).toHaveCSS('animation-name', 'none');
    await card.hover();
    await expect(mark.locator(animatedParts[index])).toHaveCSS('animation-name', names[index]);
    await expect(card.locator('h3')).toHaveCSS('text-decoration-line', 'none');
  }
  await page.mouse.move(0, 0);
  await page.getByRole('navigation', { name: 'Vision page sections' }).getByRole('link', { name: 'Principles', exact: true }).click();
  await expect.poll(() => page.locator('#astrid-vision-principles').evaluate(el => Math.round(el.getBoundingClientRect().top))).toBeLessThan(80);
  await page.screenshot({ path: 'test-results/vision-captures/pixel-sigils-desktop.png' });
});

test('reduced-motion keeps every sigil still including keyboard focus', async ({ page, request }) => {
  await pinFeed(page, request);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/vision');
  const cards = page.locator('.astrid-vision-standards-list > li');
  for (let index = 0; index < 4; index++) {
    const card = cards.nth(index);
    await card.hover();
    await card.locator('button').focus();
    const animations = await card.locator('[data-sigil] *').evaluateAll(elements =>
      elements.map(el => getComputedStyle(el).animationName));
    expect(animations.every(name => name === 'none')).toBeTruthy();
  }
});

test('section links track scroll, highlight hovered sections and keep out of the cards', async ({ page, request }) => {
  await pinFeed(page, request);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/vision');
  const nav = page.getByRole('navigation', { name: 'Vision page sections' });
  await expect(nav).toHaveCSS('position', 'fixed');
  await expect(nav.getByRole('link')).toHaveCount(5);
  await expect(nav.getByRole('link', { name: 'Vision', exact: true })).toHaveAttribute('aria-current', 'location');
  for (const [label, id] of sections) {
    const link = nav.getByRole('link', { name: label, exact: true });
    await expect(link).toHaveAttribute('href', '#' + id);
    await link.click();
    await expect(link).toHaveAttribute('aria-current', 'location');
    await expect(nav.locator('[aria-current="location"]')).toHaveCount(1);
    await expect(page).toHaveURL(new RegExp('#' + id + '$'));
  }
  // Manual scrolling must also update the marker, not just menu clicks.
  await page.locator('#astrid-vision-gaps').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await expect(nav.getByRole('link', { name: 'Gaps', exact: true })).toHaveAttribute('aria-current', 'location');
  await page.locator('#astrid-vision-principles').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.locator('.astrid-vision-standards-list > li').first().hover();
  await expect(nav.getByRole('link', { name: 'Principles', exact: true })).toHaveAttribute('data-section-hovered', 'true');
  const n = await nav.boundingBox();
  const cards = await page.locator('.astrid-vision-standards-list').boundingBox();
  expect(n).not.toBeNull(); expect(cards).not.toBeNull();
  expect(n!.y).toBeGreaterThanOrEqual(0);
  expect(n!.y + n!.height).toBeLessThanOrEqual(900);
  expect(n!.x + n!.width).toBeLessThan(cards!.x);
  const gaps = nav.getByRole('link', { name: 'Gaps', exact: true });
  await gaps.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#astrid-vision-gaps')).toBeFocused();
  await expect(gaps).toHaveAttribute('aria-current', 'location');
});

test('section deep links survive loading and list expansion without losing the active section', async ({ page, request }) => {
  await pinFeed(page, request);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/vision#astrid-vision-gaps');
  const nav = page.getByRole('navigation', { name: 'Vision page sections' });
  await expect(nav.getByRole('link', { name: 'Gaps', exact: true })).toHaveAttribute('aria-current', 'location');
  await expect(page.locator('.astrid-vision-part')).toHaveCount(10);
  await page.getByRole('button', { name: 'Show all gaps', exact: true }).click();
  await page.locator('#astrid-vision-projects').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await expect(nav.getByRole('link', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'location');
  await page.reload();
  await expect(nav.getByRole('link', { name: 'Gaps', exact: true })).toHaveAttribute('aria-current', 'location');
});

test('phone navigation fits the viewport and the first backdrop tap cannot navigate behind a dialog', async ({ browser, request, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    await pinFeed(page, request);
    await page.goto('/vision');
    const nav = page.getByRole('navigation', { name: 'Vision page sections' });
    await expect(nav).toHaveCSS('position', 'fixed');
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const rect = await nav.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.x).toBeGreaterThanOrEqual(10);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(width - 10);
      expect(rect!.y).toBeGreaterThan(740);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await nav.getByRole('link', { name: 'Principles', exact: true }).tap();
    await expect(nav.getByRole('link', { name: 'Principles', exact: true })).toHaveAttribute('aria-current', 'location');
    await page.screenshot({ path: 'test-results/vision-captures/pixel-sigils-mobile.png' });
    // Capture the fixed navigation position while it is still accessible; a
    // native modal correctly removes its inert background from the a11y tree.
    const projects = await nav.getByRole('link', { name: 'Projects', exact: true }).boundingBox();
    expect(projects).not.toBeNull();
    const opener = page.locator('.astrid-vision-standards-list > li').first().getByRole('button');
    await opener.tap();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const url = page.url();
    await page.touchscreen.tap(projects!.x + projects!.width / 2, projects!.y + projects!.height / 2);
    await expect(dialog).toHaveCount(0);
    expect(page.url()).toBe(url);
    await nav.getByRole('link', { name: 'Projects', exact: true }).tap();
    await expect(nav.getByRole('link', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'location');
  } finally { await context.close(); }
});

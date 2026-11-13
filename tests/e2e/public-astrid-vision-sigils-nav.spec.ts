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

test('technical wrangling takes three seconds to resolve and one second to return', async ({ page, request }) => {
  await pinnedFeed(page, request);
  await page.setViewportSize({ width: 1720, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const card = page.locator('.astrid-vision-standards-list > li').last();
  const knot = card.locator('.astrid-vision-sigil-knot');
  const fragments = card.locator('.astrid-vision-sigil-knot-fragments');
  const arrow = card.locator('.astrid-vision-sigil-clear-path');
  await expect(card).toBeVisible();
  await expect(knot).toHaveCSS('opacity', '1');
  await expect(fragments).toHaveCSS('opacity', '1');
  await expect(arrow).toHaveCSS('opacity', '0.26');
  for (const part of [knot, fragments, arrow]) {
    await expect(part).toHaveCSS('transition-duration', '1s');
    await expect(part).toHaveCSS('animation-name', 'none');
  }
  await card.hover();
  for (const part of [knot, fragments, arrow]) {
    await expect(part).toHaveCSS('transition-duration', '3s');
  }
  await page.waitForTimeout(450);
  const halfway = await card.evaluate(el => {
    const opacity = (selector: string) => Number(getComputedStyle(el.querySelector(selector)!).opacity);
    return {
      knot: opacity('.astrid-vision-sigil-knot'),
      fragments: opacity('.astrid-vision-sigil-knot-fragments'),
      arrow: opacity('.astrid-vision-sigil-clear-path'),
    };
  });
  for (const value of Object.values(halfway)) {
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1);
  }
  await expect(knot).toHaveCSS('opacity', '0.16', { timeout: 4500 });
  await expect(fragments).toHaveCSS('opacity', '0.16', { timeout: 4500 });
  await expect(arrow).toHaveCSS('opacity', '1', { timeout: 4500 });

  await page.mouse.move(0, 3);
  for (const part of [knot, fragments, arrow]) {
    await expect(part).toHaveCSS('transition-duration', '1s');
  }
  await page.waitForTimeout(330);
  const reversing = Number(await arrow.evaluate(el => getComputedStyle(el).opacity));
  expect(reversing).toBeGreaterThan(0);
  expect(reversing).toBeLessThan(1);
  await expect(arrow).toHaveCSS('opacity', '0.26', { timeout: 1800 });
  await expect(knot).toHaveCSS('opacity', '1', { timeout: 1800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(arrow).toHaveCSS('transition-duration', '0s');
  await expect(knot).toHaveCSS('transition-duration', '0s');
});


test('mobile hero gets breathing room and the editorial cues and pillar numbers use pixel type', async ({ page, request }) => {
  await pinnedFeed(page, request);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    const hero = page.locator('#astrid-vision-manifesto');
    const heroPadding = await hero.evaluate(el => Number.parseFloat(getComputedStyle(el).paddingTop));
    if (width === 390) expect(heroPadding).toBeGreaterThanOrEqual(34);
    else expect(heroPadding).toBeLessThan(20);
    const pixelNumbers = page.locator('.astrid-vision-pillar-number');
    await expect(pixelNumbers).toHaveCount(4);
    await expect(pixelNumbers.first()).toHaveCSS('font-family', /Departure Mono/);
    const arrows = page.locator('.astrid-vision-standards-list > li .astrid-vision-principle-corner');
    await expect(arrows).toHaveCount(4);
    const cues = page.locator('.astrid-vision-principles .astrid-vision-pillar-details, .astrid-vision-standards-list .astrid-vision-principle-corner');
    await expect(cues).toHaveCount(8);
    for (let index = 0; index < 8; index++) {
      const cue = cues.nth(index);
      await expect(cue.locator('.astrid-vision-card-arrow svg[viewBox="0 0 18 18"]')).toHaveCount(1);
      await expect(cue).toHaveText(/\d+ gaps?.*\d+ projects?/i);
      await expect(cue).toHaveCSS('font-family', /Departure Mono/);
      await expect(cue).toHaveCSS('font-size', '11px');
      await expect(cue).toHaveCSS('border-top-width', '0px');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  }
});

test('pillars put the art on a stage above the copy, beside it in one column, with a left-aligned cue', async ({ page, request }) => {
  await pinnedFeed(page, request);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [390, 760, 800, 1179, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    const cards = page.locator('.astrid-vision-principles > li');
    await expect(cards).toHaveCount(4);
    const items = await cards.evaluateAll(elements => elements.map(card => {
      const box = (selector: string) => card.querySelector(selector)!.getBoundingClientRect().toJSON();
      return {
        card: card.getBoundingClientRect().toJSON(),
        number: box('.astrid-vision-pillar-number'),
        heading: box('h3'),
        copy: box('p'),
        art: box('.astrid-vision-principle-art'),
        detail: box('.astrid-vision-pillar-details'),
      };
    }));
    const columns = width >= 1180 ? 4 : 2;
    const rowCount = 4 / columns;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      expect(Math.abs(item.number.x - item.heading.x)).toBeLessThan(2);
      expect(Math.abs(item.heading.x - item.copy.x)).toBeLessThan(2);
      // The details cue sits under the copy on the same left edge, not off to the right.
      expect(Math.abs(item.detail.x - item.copy.x)).toBeLessThan(2);
      expect(item.detail.y).toBeGreaterThanOrEqual(item.copy.y + item.copy.height - 2);
      expect(item.card.y + item.card.height - (item.detail.y + item.detail.height)).toBeLessThan(32);
      expect(item.art.x + item.art.width).toBeLessThanOrEqual(item.card.x + item.card.width - 6);
      if (width > 760) {
        expect(item.card.height).toBeLessThan(width >= 1180 ? 520 : 470);
        // Art is directly above the title, so copy and illustration stay together.
        expect(item.art.y + item.art.height).toBeLessThanOrEqual(item.heading.y);
        expect(item.heading.y - (item.art.y + item.art.height)).toBeLessThan(48);
        expect(Math.abs(item.art.x + item.art.width / 2 - (item.card.x + item.card.width / 2))).toBeLessThan(12);
      } else {
        // Two narrow columns keep the complete copy; art now sits above it.
        expect(item.art.y + item.art.height).toBeLessThanOrEqual(item.heading.y + 1);
        expect(item.art.x).toBeGreaterThanOrEqual(item.card.x);
        expect(Math.abs(item.art.x + item.art.width / 2 - (item.card.x + item.card.width / 2))).toBeLessThan(12);
      }
    }
    for (let i = 0; i < items.length; i++) {
      if (i % columns !== 0) {
        expect(items[i].card.x).toBeGreaterThan(items[i - 1].card.x + items[i - 1].card.width - 1);
        expect(Math.abs(items[i].card.y - items[i - 1].card.y)).toBeLessThan(2);
      } else if (i > 0) {
        expect(items[i].card.y).toBeGreaterThan(items[i - columns].card.y + items[i - columns].card.height - 1);
      }
    }
    expect(rowCount).toBe(width >= 1180 ? 1 : 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await cards.first().getByRole('button', { name: /Explore .*: gaps and projects/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
  }
});

test('principles sit in the reading column: copy and cue on the left, a larger sigil on the right', async ({ page, request }) => {
  await pinnedFeed(page, request);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [390, 800, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    const cards = page.locator('.astrid-vision-standards-list > li');
    await expect(cards).toHaveCount(4);
    const boxes = await cards.evaluateAll(elements => elements.map(card => {
      const rect = (selector: string) => card.querySelector(selector)!.getBoundingClientRect().toJSON();
      return {
        card: card.getBoundingClientRect().toJSON(),
        text: rect('.astrid-vision-principle-statement, .astrid-vision-markdown'),
        sigil: rect('.astrid-vision-principle-sigil'),
        arrow: rect('.astrid-vision-principle-corner'),
        radius: getComputedStyle(card).borderTopLeftRadius,
        border: getComputedStyle(card).borderLeftWidth,
      };
    }));
    for (const box of boxes) {
      expect(box.card.height).toBeLessThan(width <= 760 ? 310 : 285);
      expect(box.sigil.x).toBeGreaterThanOrEqual(box.text.x + box.text.width - 2);
      expect(box.arrow.y).toBeGreaterThanOrEqual(box.text.y + box.text.height - 2);
      expect(Math.abs(box.arrow.x - box.text.x)).toBeLessThan(2);
      expect(box.sigil.width).toBeGreaterThanOrEqual(width <= 760 ? 72 : 96);
      expect(box.sigil.x + box.sigil.width).toBeLessThanOrEqual(box.card.x + box.card.width - 6);
      expect(box.radius).toBe('14px');
      expect(box.border).toBe('1px');
    }
    const first = boxes[0].card, second = boxes[1].card, third = boxes[2].card;
    // The grid shares the section heading's column instead of bleeding past it.
    const head = await page.locator('.astrid-vision-standards > .astrid-vision-section-head').boundingBox();
    expect(Math.abs(first.x - head!.x)).toBeLessThan(2);
    expect(Math.abs(second.x + second.width - (head!.x + head!.width))).toBeLessThan(2);
    if (width > 760) {
      expect(second.x).toBeGreaterThan(first.x + first.width);
      expect(Math.abs(second.y - first.y)).toBeLessThan(2);
      expect(third.y).toBeGreaterThan(first.y + first.height - 1);
    } else {
      expect(Math.abs(second.x - first.x)).toBeLessThan(2);
      expect(second.y).toBeGreaterThan(first.y + first.height - 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await cards.last().getByRole('button', { name: /Explore .*: gaps and projects/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
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
  await expect(nav.getByRole('link')).toHaveCount(4);
  expect(await nav.locator('a').evaluateAll(elements => elements.map(el => el.getAttribute('href'))))
    .toEqual([
      '#astrid-vision-manifesto', '#astrid-vision-pillars', '#astrid-vision-standards',
      '#astrid-vision-contribute',
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
    ['Help', 'astrid-vision-contribute'],
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
  const link = nav.getByRole('link', { name: /Help$/ });
  await link.click();
  await expect(link).toHaveAttribute('aria-current', 'location');
  await expect(page).toHaveURL(/#astrid-vision-contribute$/);
  await expect(page.locator('#astrid-vision-contribute')).toBeVisible();
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


test('principle sigils use softer faded page colors while their readable cue stays solid', async ({ page, request }) => {
  await pinnedFeed(page, request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const cards = page.locator('.astrid-vision-standards-list > li');
  const marks = cards.locator('.astrid-vision-principle-sigil');
  const cornerArrows = cards.locator('.astrid-vision-principle-corner');
  for (let index = 0; index < 4; index++) {
    await expect(marks.nth(index)).toHaveCSS('opacity', '0.58');
    await expect(cornerArrows.nth(index)).toHaveCSS('opacity', '1');
    await expect(marks.nth(index)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(cornerArrows.nth(index)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }
  const colors = await marks.evaluateAll(elements => elements.map(element => getComputedStyle(element).color));
  expect(new Set(colors).size).toBe(4);
  for (let index = 0; index < 4; index++) {
    await cards.nth(index).hover();
    await expect(marks.nth(index)).toHaveCSS('opacity', '0.82');
    await expect(cornerArrows.nth(index)).toHaveCSS('opacity', '1');
  }
  await cards.nth(0).hover();
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
    await expect(nav.getByRole('link')).toHaveCount(4);
    const pillars = nav.getByRole('link', { name: /Pillars$/ });
    await expect(pillars).toHaveAttribute('href', '#astrid-vision-pillars');
    await pillars.click();
    await expect(pillars).toHaveAttribute('aria-current', 'location');
    await expect(page.getByRole('heading', { name: 'The pillars of our vision' })).toBeVisible();
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


test('phone scroll activates each principle sigil through the middle of the viewport', async ({ page, request }) => {
  await pinnedFeed(page, request);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const cards = page.locator('.astrid-vision-standards-list > li');
  await expect(cards).toHaveCount(4);
  const motions = [
    ['.astrid-vision-sigil-orbit', 'astrid-vision-sigil-orbit'],
    ['.astrid-vision-sigil-open-ring', 'astrid-vision-sigil-ring'],
    ['.astrid-vision-sigil-spark', 'astrid-vision-sigil-spark-rise'],
    ['.astrid-vision-sigil-clear-path', 'none'],
  ] as const;
  for (let index = 0; index < motions.length; index++) {
    const card = cards.nth(index);
    await card.evaluate(el => {
      const rect = el.getBoundingClientRect();
      window.scrollBy(0, rect.top + rect.height / 2 - window.innerHeight / 2);
    });
    await expect(card).toHaveAttribute('data-sigil-active', 'true');
    await expect(card.locator(motions[index][0])).toHaveCSS('animation-name', motions[index][1]);
    if (index === 3) {
      await expect(card.locator('.astrid-vision-sigil-knot')).toHaveCSS('transition-duration', '3s');
      await expect(card.locator('.astrid-vision-sigil-clear-path')).toHaveCSS('transition-duration', '3s');
    }
    await expect(card.locator('.astrid-vision-principle-sigil')).toHaveCSS('opacity', '0.82');
    await expect(card.locator('.astrid-vision-principle-corner')).toHaveCSS('opacity', '1');
    if (index > 0) await expect(cards.nth(index - 1)).not.toHaveAttribute('data-sigil-active', 'true');
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(cards.last()).not.toHaveAttribute('data-sigil-active', 'true');
  await expect(cards.last().locator('.astrid-vision-sigil-clear-path')).toHaveCSS('animation-name', 'none');
});

test('touch modal never starts with an X outline and dismissal clears card focus; keyboard still restores focus', async ({ browser, request }) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const content = await response.json();
  const context = await browser.newContext({
    viewport: { width: 390, height: 780 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  try {
    await page.route(FEED, route => route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(content),
    }));
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    const card = page.locator('.astrid-vision-standards-list > li').nth(1);
    const trigger = card.getByRole('button', { name: /Explore .*: gaps and projects/ });
    await trigger.tap();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Close details' })).not.toBeFocused();

    await dialog.getByRole('button', { name: 'Close details' }).tap();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).not.toBeFocused();
    await expect.poll(() => trigger.evaluate(el => el.matches(':focus-visible'))).toBe(false);
    await expect.poll(() => card.evaluate(el => getComputedStyle(el, '::after').opacity)).toBe('0');

    // Restoring focus is correct when the opening action used a keyboard.
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    await context.close();
  }
});

test('phone header centers the active section when horizontal scroll bounds permit', async ({ page, request }) => {
  await pinnedFeed(page, request);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const nav = page.getByRole('navigation', { name: 'Vision page sections' });
  await expect(nav).toBeVisible();

  for (const label of ['Pillars', 'Principles', 'Help']) {
    const active = nav.getByRole('link', { name: new RegExp(label + '$') });
    await active.click();
    await expect(active).toHaveAttribute('aria-current', 'location');
    // Four links can all fit, or leave only edge-clamped positions. Assert the
    // actual bounded center rather than requiring a fictitious interior slot.
    await expect.poll(() => nav.evaluate(el => {
      const selected = el.querySelector('a[aria-current="location"]')!;
      const a = selected.getBoundingClientRect();
      const n = el.getBoundingClientRect();
      const desired = el.scrollLeft + a.left - n.left + a.width / 2 - el.clientWidth / 2;
      const bounded = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, desired));
      return Math.abs(el.scrollLeft - bounded);
    })).toBeLessThan(10);
    const activeBox = await active.boundingBox();
    const navBox = await nav.boundingBox();
    expect(activeBox!.x).toBeGreaterThanOrEqual(navBox!.x - 1);
    expect(activeBox!.x + activeBox!.width).toBeLessThanOrEqual(navBox!.x + navBox!.width + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
});


test('desktop section clicks keep the chosen highlight throughout smooth page scrolling', async ({ page, request }) => {
  await pinnedFeed(page, request);
  await page.setViewportSize({ width: 1720, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const nav = page.getByRole('navigation', { name: 'Vision page sections' });
  await expect(nav.getByRole('link', { name: /Vision$/ })).toHaveAttribute('aria-current', 'location');

  await page.evaluate(() => {
    const monitor = window as typeof window & { __astridNavSelections?: string[] };
    monitor.__astridNavSelections = [];
    const nav = document.querySelector('.astrid-vision-section-nav')!;
    new MutationObserver(() => {
      const selected = nav.querySelector('a[aria-current="location"]');
      if (selected) monitor.__astridNavSelections?.push(selected.getAttribute('href') ?? '');
    }).observe(nav, { subtree: true, attributes: true, attributeFilter: ['aria-current'] });
  });

  const destination = nav.getByRole('link', { name: /Help$/ });
  await destination.click();
  await expect(destination).toHaveAttribute('aria-current', 'location');
  await expect.poll(() => page.evaluate(() => {
    const target = document.getElementById('astrid-vision-contribute')!;
    const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
    const requested = window.scrollY + target.getBoundingClientRect().top - margin;
    const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    return Math.abs(window.scrollY - Math.min(maximum, Math.max(0, requested)));
  })).toBeLessThan(3);
  await page.waitForTimeout(200);
  const selections = await page.evaluate(() =>
    (window as typeof window & { __astridNavSelections?: string[] }).__astridNavSelections ?? []);
  expect(selections.length).toBeGreaterThan(0);
  expect(selections.every(id => id === '#astrid-vision-contribute'), selections.join(' → ')).toBe(true);

  // After the smooth jump completes, ordinary user scrolling can update the
  // active section again; the clicked item must not remain locked.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(nav.getByRole('link', { name: /Vision$/ })).toHaveAttribute('aria-current', 'location');
});

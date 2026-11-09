import { expect, test } from '@playwright/test';

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';

test('pillars and principles open current gaps with correctly linked GitHub project plans', async ({ page, request }) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const content = await response.json() as {
    pillars: { id: string; title: string }[];
    principles: { id: string; title: string }[];
    gaps: { id: string; title: string; assessment: string; appliesTo: string[]; githubUrl: string }[];
    projects: { id: string; title: string; status: string; gapIds: string[]; githubUrl: string }[];
  };
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(content),
  }));

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    for (const kind of ['pillar', 'principle'] as const) {
      const entry = (kind === 'pillar' ? content.pillars : content.principles)[0];
      const trigger = page.getByRole('button', { name: 'Explore ' + entry.title + ': gaps and projects' });
      await trigger.click();
      const modal = page.getByRole('dialog', { name: entry.title });
      await expect(modal).toBeVisible();
      const expectedGaps = content.gaps.filter(gap =>
        gap.assessment !== 'closed' && gap.appliesTo.includes(kind + ':' + entry.id));
      await expect(modal.locator('.astrid-vision-details-gap h4')).toHaveText(expectedGaps.map(gap => gap.title));

      for (const gap of expectedGaps) {
        const row = modal.locator('.astrid-vision-details-gap')
          .filter({ has: page.getByRole('link', { name: gap.title }) });
        await expect(row.locator('h4 a')).toHaveAttribute('href', gap.githubUrl);
        const plans = content.projects.filter(project =>
          project.status !== 'done' && project.status !== 'cancelled' && project.gapIds.includes(gap.id));
        await expect(row.locator('.astrid-vision-details-project-heading a'))
          .toHaveCount(plans.length);
        for (const [index, plan] of plans.entries()) {
          await expect(row.locator('.astrid-vision-details-project-heading a').nth(index))
            .toHaveAttribute('href', plan.githubUrl);
        }
      }

      const bounds = await modal.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      // A visible backdrop with an off-screen dialog was the iOS regression.
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(901);
      await expect(modal).toHaveCSS('position', 'fixed');
      await page.keyboard.press('Escape');
      await expect(modal).toHaveCount(0);
    }
  }
});

test('a dialog can be dismissed via its close button and returns focus to the card', async ({ page, request }) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const content = await response.json();
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(content),
  }));
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const trigger = page.getByRole('button', { name: 'Explore ' + content.pillars[0].title + ': gaps and projects' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: 'Close details' }).click();
  await expect(modal).toHaveCount(0);
  await expect(trigger).toBeFocused();
});


test('mobile principle card has no redundant footer CTA, fills the touch target and keeps scroll on close', async ({ page, request }) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const content = await response.json();
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(content),
  }));
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });

  const principle = page.locator('.astrid-vision-standards-list > li').last();
  const trigger = principle.getByRole('button', { name: /Explore .*: gaps and projects/ });
  await expect(principle.locator('.astrid-vision-principle-open')).toHaveCount(0);
  const cardBounds = await principle.boundingBox();
  const triggerBounds = await trigger.boundingBox();
  expect(cardBounds).not.toBeNull();
  expect(triggerBounds).not.toBeNull();
  expect(Math.abs(triggerBounds!.y - cardBounds!.y)).toBeLessThan(2);
  expect(Math.abs(triggerBounds!.height - cardBounds!.height)).toBeLessThan(2);

  await trigger.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(400);
  await trigger.click();
  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
  await expect(modal).toHaveCSS('position', 'fixed');
  const bounds = await modal.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(781);

  await modal.getByRole('button', { name: 'Close details' }).click();
  await expect(modal).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before - 4);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(before + 4);
  // Pointer-driven dismissal should not leave WebKit's huge full-card outline.
  await expect(trigger).not.toBeFocused();
  await expect.poll(() => trigger.evaluate(el => el.matches(':focus-visible'))).toBe(false);
});


test('principle cards use four reserved sigil colors, transparent panels and border-only hover feedback', async ({ page, request }) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const content = await response.json();
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(content),
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const cards = page.locator('.astrid-vision-standards-list > li');
  await expect(cards).toHaveCount(4);
  const marks = cards.locator('.astrid-vision-principle-sigil');
  await expect(marks).toHaveCount(4);
  const colors = await marks.evaluateAll(elements =>
    elements.map(el => getComputedStyle(el).color));
  expect(new Set(colors).size).toBe(4);
  expect(await cards.first().evaluate(el => getComputedStyle(el).backgroundColor))
    .toBe('rgba(0, 0, 0, 0)');
  const first = cards.first();
  await first.hover();
  await expect(first.locator('h3')).toHaveCSS('text-decoration-line', 'none');
  await expect.poll(() => first.evaluate(el => getComputedStyle(el, '::after').opacity)).toBe('1');
  const border = await first.evaluate(el => getComputedStyle(el, '::after').borderLeftWidth);
  expect(border).toBe('1px');
});

test('mobile modal keeps the X fixed, scrolls within the panel and closes from top and bottom backdrop', async ({ page, request }) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const content = await response.json();
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(content),
  }));
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  // This principle has many related gaps/projects, ensuring the dialog must scroll.
  const trigger = page.getByRole('button', {
    name: 'Explore ' + content.principles.find((item: { id: string }) => item.id === 'in-the-creators-control').title + ': gaps and projects',
  });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  const close = dialog.getByRole('button', { name: 'Close details' });
  const scroll = dialog.locator('.astrid-vision-details-scroll');
  await expect(dialog).toBeVisible();
  await expect(scroll).toHaveCSS('overflow-y', 'auto');
  const rect = await dialog.boundingBox();
  expect(rect).not.toBeNull();
  expect(rect!.x).toBeGreaterThanOrEqual(18);
  expect(rect!.y).toBeGreaterThanOrEqual(35);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(745);
  const initial = await close.boundingBox();
  expect(initial).not.toBeNull();
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
  expect(await scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  const scrolled = await close.boundingBox();
  expect(scrolled).not.toBeNull();
  expect(Math.abs(scrolled!.y - initial!.y)).toBeLessThan(2);
  expect(Math.abs(scrolled!.x - initial!.x)).toBeLessThan(2);

  await page.mouse.click(rect!.x + rect!.width / 2, rect!.y - 14);
  await expect(dialog).toHaveCount(0);

  await trigger.click();
  await expect(dialog).toBeVisible();
  const again = await dialog.boundingBox();
  expect(again).not.toBeNull();
  await page.mouse.click(again!.x + again!.width / 2, again!.y + again!.height + 14);
  await expect(dialog).toHaveCount(0);
});


test('first touch outside the dialog only dismisses it and cannot click through to cards', async ({ browser, request }) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const content = await response.json() as { principles: { id: string; title: string }[] };
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
    const title = content.principles.find(p => p.id === 'in-the-creators-control')?.title
      ?? content.principles[0].title;
    const opener = page.getByRole('button', { name: 'Explore ' + title + ': gaps and projects' });
    await opener.tap();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await page.evaluate(() => {
      const marker = window as typeof window & { __visionCardClicks?: number };
      marker.__visionCardClicks = 0;
      document.addEventListener('click', event => {
        if (event.target instanceof Element &&
            event.target.closest('.astrid-vision-card-open')) {
          marker.__visionCardClicks = (marker.__visionCardClicks ?? 0) + 1;
        }
      }, true);
    });

    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    await page.touchscreen.tap(bounds!.x + bounds!.width / 2, bounds!.y - 14);
    await expect(dialog).toHaveCount(0);
    // A delayed synthetic click from the same touch must not reach the card below.
    await page.waitForTimeout(350);
    expect(await page.evaluate(() =>
      (window as typeof window & { __visionCardClicks?: number }).__visionCardClicks)).toBe(0);

    // A *new* deliberate tap still opens the card, rather than the first tap
    // being allowed to operate both the backdrop and the underlying UI.
    await opener.tap();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close details' }).tap();
    await expect(dialog).toHaveCount(0);
  } finally {
    await context.close();
  }
});


test('compact principle cards remain readable and open from title or sigil', async ({ page, request }) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const content = await response.json() as { principles: { id: string; title: string }[] };
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(content),
  }));

  for (const width of [1200, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    const cards = page.locator('.astrid-vision-standards-list > li');
    await expect(cards).toHaveCount(4);

    const rects = await cards.evaluateAll(elements => elements.map(el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }));
    // Two columns with their own breathing room, rather than one joined
    // four-up strip. The second row returns to the first column.
    expect(rects[1].left).toBeGreaterThan(rects[0].right);
    expect(Math.abs(rects[1].top - rects[0].top)).toBeLessThan(2);
    expect(Math.abs(rects[2].left - rects[0].left)).toBeLessThan(2);
    expect(rects[2].top).toBeGreaterThan(rects[0].bottom);
    expect(Math.abs(rects[3].left - rects[1].left)).toBeLessThan(2);
    const fourthTitle = cards.last().locator('h3');
    const lines = await fourthTitle.evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return [...range.getClientRects()].filter(rect => rect.width > 0).length;
    });
    expect(lines, 'the fourth principle title must fit within two lines').toBeLessThanOrEqual(2);
    const titleToCopy = await cards.last().evaluate(el => {
      const heading = el.querySelector('h3')!.getBoundingClientRect();
      const copy = el.querySelector('.astrid-vision-principle-statement, .astrid-vision-markdown')!.getBoundingClientRect();
      return copy.top - heading.bottom;
    });
    expect(titleToCopy).toBeLessThan(16);
    await expect(cards.last().locator('.astrid-vision-principle-open')).toHaveCount(0);
    const hitarea = cards.last().getByRole('button', { name: /Explore .*: gaps and projects/ });
    const areaRect = await hitarea.boundingBox();
    const cardRect = await cards.last().boundingBox();
    expect(areaRect).not.toBeNull();
    expect(cardRect).not.toBeNull();
    expect(Math.abs(areaRect!.width - cardRect!.width)).toBeLessThan(2);
    expect(Math.abs(areaRect!.height - cardRect!.height)).toBeLessThanOrEqual(2);

    // Mouse coordinates are viewport-relative: bring the card on-screen first.
    // The entire surface, including where the title and sigil are drawn, opens the dialog.
    await cards.last().scrollIntoViewIfNeeded();
    const titleRect = await fourthTitle.boundingBox();
    expect(titleRect).not.toBeNull();
    await page.mouse.click(titleRect!.x + 10, titleRect!.y + titleRect!.height / 2);
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close details' }).click();
    await cards.last().scrollIntoViewIfNeeded();
    const sigilRect = await cards.last().locator('.astrid-vision-principle-sigil').boundingBox();
    expect(sigilRect).not.toBeNull();
    await page.mouse.click(sigilRect!.x + 8, sigilRect!.y + 8);
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
});

test('aspiration hover animates only its arrow without underlining the title', async ({ page, request }) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const content = await response.json();
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(content),
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const card = page.locator('.astrid-vision-standards-list > li').first();
  await card.hover();
  await expect(card.locator('h3')).toHaveCSS('text-decoration-line', 'none');
  await expect(card.locator('.astrid-vision-card-arrow'))
    .toHaveCSS('animation-name', 'astrid-vision-arrow-nudge');
  const pillar = page.locator('.astrid-vision-principles > li').first();
  await pillar.hover();
  await expect(pillar.locator('.astrid-vision-card-arrow'))
    .toHaveCSS('animation-name', 'astrid-vision-arrow-nudge');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(pillar.locator('.astrid-vision-card-arrow')).toHaveCSS('animation-name', 'none');
});


test('gap headers and their projects share distinct stable color families', async ({ page, request }) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const content = await response.json() as {
    pillars: { id: string; title: string }[];
    principles: { id: string; title: string }[];
  };
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(content),
  }));
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });

  const pillar = content.pillars.find(item => item.id === 'artistic-ambition')!;
  await page.getByRole('button', { name: 'Explore ' + pillar.title + ': gaps and projects' }).click();
  const dialog = page.getByRole('dialog');
  const gaps = dialog.locator('.astrid-vision-details-gap');
  const appearances = await gaps.evaluateAll(elements => elements.map(el => ({
    tone: el.getAttribute('data-tone'),
    title: el.querySelector('h4')?.textContent,
    headerBackground: getComputedStyle(el.querySelector('.astrid-vision-details-gap-heading')!).backgroundColor,
    projectBackground: el.querySelector('.astrid-vision-details-projects')
      ? getComputedStyle(el.querySelector('.astrid-vision-details-projects')!).backgroundColor
      : null,
  })));
  expect(appearances.length).toBeGreaterThanOrEqual(2);
  expect(new Set(appearances.map(item => item.tone)).size).toBe(appearances.length);
  expect(appearances.every(item => item.headerBackground !== 'rgba(0, 0, 0, 0)')).toBeTruthy();
  expect(appearances.filter(item => item.projectBackground)
    .every(item => item.projectBackground !== item.headerBackground)).toBeTruthy();
  const sharedGap = gaps.filter({ hasText: "Artists can't yet sustain ambitious work end to end" });
  const firstTone = await sharedGap.getAttribute('data-tone');
  await dialog.getByRole('button', { name: 'Close details' }).click();

  const principle = content.principles.find(item => item.id === 'in-the-creators-control')!;
  await page.getByRole('button', { name: 'Explore ' + principle.title + ': gaps and projects' }).click();
  const sameGap = page.getByRole('dialog').locator('.astrid-vision-details-gap')
    .filter({ hasText: "Artists can't yet sustain ambitious work end to end" });
  await expect(sameGap).toHaveAttribute('data-tone', firstTone!);
});


test('every joined principle, including interior cards without physical left borders, gains a full hover box', async ({ page, request }) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const content = await response.json();
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(content),
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const cards = page.locator('.astrid-vision-standards-list > li');
  for (let i = 0; i < 4; i++) {
    const card = cards.nth(i);
    await card.hover();
    await expect.poll(() => card.evaluate(el => getComputedStyle(el, '::after').opacity)).toBe('1');
    const outline = await card.evaluate(el => {
      const css = getComputedStyle(el, '::after');
      return [css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth];
    });
    expect(outline).toEqual(['1px', '1px', '1px', '1px']);
    await expect(card.locator('h3')).toHaveCSS('text-decoration-line', 'none');
  }
});


test('principle arrow is a subtle boxed control in the bottom-right corner at every layout width', async ({ page, request }) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const content = await response.json();
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(content),
  }));
  for (const width of [390, 880, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    const cards = page.locator('.astrid-vision-standards-list > li');
    for (let index = 0; index < 4; index++) {
      const card = cards.nth(index);
      const arrow = card.locator('.astrid-vision-principle-corner');
      const cardBounds = await card.boundingBox();
      const arrowBounds = await arrow.boundingBox();
      expect(cardBounds).not.toBeNull();
      expect(arrowBounds).not.toBeNull();
      expect(cardBounds!.x + cardBounds!.width - (arrowBounds!.x + arrowBounds!.width))
        .toBeGreaterThanOrEqual(12);
      expect(cardBounds!.x + cardBounds!.width - (arrowBounds!.x + arrowBounds!.width))
        .toBeLessThan(27);
      expect(cardBounds!.y + cardBounds!.height - (arrowBounds!.y + arrowBounds!.height))
        .toBeGreaterThanOrEqual(12);
      expect(cardBounds!.y + cardBounds!.height - (arrowBounds!.y + arrowBounds!.height))
        .toBeLessThan(27);
      await expect(arrow).toHaveCSS('border-top-width', '1px');
      await expect(arrow).toHaveCSS('position', 'relative');
      // A single full-card button remains the actual keyboard-accessible hit area.
      await expect(card.getByRole('button', { name: /Explore .*: gaps and projects/ })).toHaveCount(1);
    }
  }
});

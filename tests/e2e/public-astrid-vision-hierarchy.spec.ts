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


test('mobile principle action sits beneath its description, modal stays on screen and scroll survives dismissal', async ({ page, request }) => {
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
  await expect(trigger).toContainText('Explore gaps and projects');
  const copyBounds = await principle.locator(':scope > div').boundingBox();
  const triggerBounds = await trigger.boundingBox();
  expect(copyBounds).not.toBeNull();
  expect(triggerBounds).not.toBeNull();
  expect(triggerBounds!.y).toBeGreaterThanOrEqual(copyBounds!.y + copyBounds!.height);

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
  await expect(trigger).toBeFocused();
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
    elements.map(el => getComputedStyle(el).borderColor));
  expect(new Set(colors).size).toBe(4);
  expect(await cards.first().evaluate(el => getComputedStyle(el).backgroundColor))
    .toBe('rgba(0, 0, 0, 0)');
  const first = cards.first();
  const before = await first.evaluate(el => getComputedStyle(el).borderColor);
  await first.hover();
  const after = await first.evaluate(el => getComputedStyle(el).borderColor);
  expect(after).not.toBe(before);
  await expect(first.locator('h3')).toHaveCSS('text-decoration-line', 'none');
  await expect(first.locator('.astrid-vision-principle-open')).toHaveCSS('font-weight', '700');
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
            event.target.closest('.astrid-vision-principle-open, .astrid-vision-card-open')) {
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

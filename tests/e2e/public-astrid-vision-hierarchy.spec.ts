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
  await expect(trigger).toHaveText('Explore gaps and projects ↗');
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

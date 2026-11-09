import { expect, test } from '@playwright/test';

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';

test('pillars and principles use the same progressive disclosure of characteristics', async ({ page, request }) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const live = await response.json();
  // Test the candidate structured projection even while the old public
  // schema-v1 feed is live. The real published feed owns the copy.
  const enrich = (subject: { id: string; title: string }) => ({
    ...subject,
    statement: 'A single defining sentence.',
    explanationMarkdown: 'This paragraph explains the overarching intent without listing the characteristics again.',
    characteristics: [
      { id: 'agency', title: 'Creator agency', summary: 'Creators retain meaningful decisions.',
        detailsMarkdown: 'Detailed control remains available throughout the work.' },
      { id: 'continuity', title: 'Sustained practice', summary: 'Projects stay editable over time.',
        detailsMarkdown: 'More extensive notes describe how a session retains its creative history.' },
    ],
  });
  const feed = {
    ...live,
    pillars: live.pillars.map(enrich),
    principles: live.principles.map(enrich),
  };
  await page.route(FEED, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(feed),
  }));
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    const cards = page.locator('.astrid-vision-standards-list > li');
    await expect(cards).toHaveCount(4);
    await expect(cards.first().locator('.astrid-vision-principle-statement'))
      .toHaveText('A single defining sentence.');

    for (const entry of [feed.pillars[0], feed.principles[0]]) {
      const opener = page.getByRole('button', { name: 'Explore ' + entry.title + ': gaps and projects' });
      await opener.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.astrid-vision-details-statement'))
        .toHaveText(entry.statement);
      await expect(dialog.getByRole('region', { name: 'Characteristics' })).toBeVisible();
      const characteristics = dialog.locator('.astrid-vision-details-characteristic');
      await expect(characteristics).toHaveCount(2);
      await expect(characteristics.locator('summary')).toContainText([
        'Creator agencyCreators retain meaningful decisions.',
        'Sustained practiceProjects stay editable over time.',
      ]);
      await expect(characteristics.first()).not.toHaveAttribute('open', '');
      await expect(characteristics.first().locator('.astrid-vision-details-characteristic-body')).toBeHidden();
      await characteristics.first().locator('summary').click();
      await expect(characteristics.first()).toHaveAttribute('open', '');
      await expect(characteristics.first().locator('.astrid-vision-details-characteristic-body'))
        .toContainText('Detailed control remains available');
      await expect(dialog.getByRole('region', { name: 'Current gaps and projects' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  }
});

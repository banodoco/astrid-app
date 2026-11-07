import { expect, test } from '@playwright/test';

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';

async function feed(request: import('@playwright/test').APIRequestContext) {
  const response = await request.get(FEED);
  expect(response.ok(), 'public GitHub feed must be accessible').toBeTruthy();
  const data = await response.json();
  expect(data.schemaVersion).toBe(1);
  return data as {
    vision: { title: string };
    pillars: { title: string }[];
    principles: { title: string }[];
    gaps: { id: string; title: string; assessment: string; githubUrl: string }[];
    projects: { title: string; status: string; githubUrl: string }[];
  };
}

test('vision displays the GitHub-published pillars and operating principles', async ({ page, request }) => {
  const content = await feed(request);
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('main.astrid-vision')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(content.vision.title);
  const pillars = page.locator('.astrid-vision-principles h3');
  await expect(pillars).toHaveCount(content.pillars.length);
  for (const [index, pillar] of content.pillars.entries()) {
    await expect(pillars.nth(index)).toHaveText(pillar.title);
  }
  await expect(page.locator('.astrid-vision-standards .astrid-vision-eyebrow')).toHaveText('Our aspirations');
  await expect(page.getByRole('heading', { name: 'The principles that drive us' })).toBeVisible();
  await expect(page.locator('.astrid-vision-standards-list h3')).toHaveCount(content.principles.length);
});

test('source attribution is website copy, separate from editorial vision', async ({ page, request }) => {
  const content = await feed(request);
  const contributionGuide = 'https://github.com/banodoco/astrid-dev#want-to-contribute-give-this-to-your-agent';
  const intro = [
    'Astrid aims to help individuals and the community as a whole pursue artistic work beyond what they thought possible.',
    'The collective inspires ambitious work; adaptable tools and shared knowledge help realize it.',
  ].join('\n\n');
  await page.route(FEED, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ ...content, vision: { ...content.vision, introMarkdown: intro } }),
  }));
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const paragraphs = page.locator('.astrid-vision-lead p');
  await expect(paragraphs).toHaveCount(2);
  await expect(paragraphs.nth(1)).toContainText('The collective inspires ambitious work');
  await expect(page.locator('.astrid-vision-lead')).not.toContainText('published from the Astrid Dev repository');

  const attribution = page.locator('.astrid-vision-attribution');
  await expect(attribution).toContainText('This vision is published from the');
  await expect(attribution.getByRole('link', { name: 'Astrid Dev repository' }))
    .toHaveAttribute('href', 'https://github.com/banodoco/astrid-dev/blob/' + content.source.revision + '/vision/README.md');
  await expect(attribution.getByRole('link', { name: 'Contribute with your agent' }))
    .toHaveAttribute('href', contributionGuide);
  await expect.poll(() => attribution.evaluate(element => getComputedStyle(element).fontSize)).toBe('14px');
});

test('published projects retain their status and link directly to GitHub', async ({ page, request }) => {
  const content = await feed(request);
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const open = content.projects.filter(project => !['done', 'cancelled'].includes(project.status));
  const initial = open.slice(0, 8);
  const rows = page.locator('.astrid-vision-project-row');
  await expect(rows).toHaveCount(initial.length);
  await expect(rows.first().locator('h3')).toHaveText(initial[0].title);
  await expect(rows.first().locator('.astrid-vision-project-status')).toHaveText(initial[0].status);
  await expect(rows.first().getByRole('link', { name: 'Project details on GitHub' }))
    .toHaveAttribute('href', initial[0].githubUrl);
  await page.getByRole('button', { name: 'View all ' + open.length + ' open projects' }).click();
  await expect(rows).toHaveCount(open.length);
});

test('phone gap disclosures show live assessments and source links', async ({ page, request }) => {
  const content = await feed(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const first = content.gaps.find(g => g.id === 'AA-001')!;
  const gap = page.locator('#gap-aa-001');
  await expect(gap).toBeVisible();
  await gap.getByRole('button', { name: first.title }).click();
  await expect(gap.locator('.astrid-vision-gap-state')).toHaveText(first.assessment);
  await expect(gap.getByRole('link', { name: 'Read full gap and evidence on GitHub' }))
    .toHaveAttribute('href', first.githubUrl);
  await page.getByRole('button', { name: 'Show all ' + content.gaps.length + ' gaps' }).click();
  await expect(page.locator('.astrid-vision-part')).toHaveCount(content.gaps.length);
});

test('different valid feed content renders without rebuilding the app', async ({ page, request }) => {
  const content = await feed(request);
  const changed = {
    ...content,
    vision: { ...content.vision, title: 'Dynamic vision heading from published data' },
  };
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(changed),
    headers: { 'access-control-allow-origin': '*' },
  }));
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(changed.vision.title);
});

test('feed errors are explained and offer a retry', async ({ page }) => {
  await page.route(FEED, route => route.fulfill({ status: 503, body: 'temporarily unavailable' }));
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Read on GitHub' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Read on GitHub' }))
    .toHaveAttribute('href', 'https://github.com/banodoco/astrid-dev/blob/main/vision/README.md');
});

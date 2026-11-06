import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const content = JSON.parse(readFileSync(new URL('../../src/pages/Home/vision.generated.json', import.meta.url), 'utf8')) as {
  vision: { title: string };
  pillars: { title: string }[];
  principles: { title: string }[];
  gaps: { id: string; title: string; assessment: string; githubUrl: string }[];
  projects: { title: string; status: string; githubUrl: string }[];
};

test('vision displays the GitHub-authored pillars and operating principles', async ({ page }) => {
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('main.astrid-vision')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(content.vision.title);
  const pillars = page.locator('.astrid-vision-principles h3');
  await expect(pillars).toHaveCount(content.pillars.length);
  for (const [index, pillar] of content.pillars.entries()) {
    await expect(pillars.nth(index)).toHaveText(pillar.title);
  }
  await expect(page.locator('.astrid-vision-standards-list h3')).toHaveCount(content.principles.length);
});

test('vision shows source-linked prioritized projects without mislabeling queued work', async ({ page }) => {
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const open = content.projects.filter(project => !['done', 'cancelled'].includes(project.status));
  const initial = open.slice(0, 12);
  const projectRows = page.locator('.astrid-vision-project-row');
  await expect(projectRows).toHaveCount(initial.length);
  await expect(projectRows.first().locator('h3')).toHaveText(initial[0].title);
  await expect(projectRows.first().locator('.astrid-vision-project-status')).toHaveText(initial[0].status);
  await expect(projectRows.first().getByRole('link', { name: 'Project details on GitHub' }))
    .toHaveAttribute('href', initial[0].githubUrl);
  await expect(projectRows.nth(1).locator('.astrid-vision-project-status')).toHaveText('queued');
  await page.getByRole('button', { name: 'Show all ' + open.length + ' open projects' }).click();
  await expect(projectRows).toHaveCount(open.length);
});

test('phone disclosures expose real gap status and GitHub evidence links', async ({ page }) => {
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

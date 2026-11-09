import { expect, test } from '@playwright/test';

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';

async function feed(request: import('@playwright/test').APIRequestContext) {
  const response = await request.get(FEED);
  expect(response.ok(), 'public GitHub feed must be accessible').toBeTruthy();
  const data = await response.json();
  expect(data.schemaVersion).toBe(1);
  return data as {
    vision: { title: string; agentPrompt?: string; contributeMarkdown?: string };
    pillars: { title: string }[];
    principles: { title: string }[];
    gaps: { id: string; title: string; assessment: string; githubUrl: string }[];
    projects: { title: string; status: string; githubUrl: string }[];
  };
}

async function pinnedFeed(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext) {
  const data = await feed(request);
  // The live feed can be republished between the API request and page navigation.
  // Render against one exact, verified response rather than two different revisions.
  await page.route(FEED, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(data),
  }));
  return data;
}

test('vision displays the GitHub-published pillars and operating principles', async ({ page, request }) => {
  const content = await pinnedFeed(page, request);
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('main.astrid-vision')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Vision');
  const pillars = page.locator('.astrid-vision-principles h3');
  await expect(pillars).toHaveCount(content.pillars.length);
  for (const [index, pillar] of content.pillars.entries()) {
    await expect(pillars.nth(index)).toHaveText(pillar.title);
  }
  await expect(page.locator('.astrid-vision-standards .astrid-vision-eyebrow')).toHaveText('Principles');
  await expect(page.getByRole('heading', { name: 'The principles that drive us' })).toBeVisible();
  await expect(page.locator('.astrid-vision-standards-list h3')).toHaveCount(content.principles.length);
  const principleCards = page.locator('.astrid-vision-standards-list > li');
  const cardSurfaces = await principleCards.evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return { border: style.borderTopStyle, background: style.backgroundColor };
  }));
  expect(cardSurfaces).toHaveLength(4);
  expect(cardSurfaces.every(card => card.border === 'solid' && card.background === 'rgba(0, 0, 0, 0)')).toBeTruthy();
  await expect(principleCards.locator('.astrid-vision-principle-sigil')).toHaveCount(4);
});

test('desktop vision has compact, accessible gaps and aligned principle headings', async ({ page, request }) => {
  const content = await pinnedFeed(page, request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'The pillars of our vision' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The principles that drive us' })).toBeVisible();

  const principleTitles = page.locator('.astrid-vision-standards-list h3');
  await expect(principleTitles).toHaveText(content.principles.map(principle => principle.title));
  const principleHeights = await principleTitles.evaluateAll(elements =>
    elements.map(element => element.getBoundingClientRect().height));
  expect(Math.max(...principleHeights) - Math.min(...principleHeights)).toBeLessThan(4);

  const current = content.gaps.filter(gap => gap.assessment !== 'closed');
  const gapRows = page.locator('.astrid-vision-part');
  await expect(gapRows).toHaveCount(Math.min(10, current.length));
  await expect(page.getByRole('button', { name: 'Show all gaps' })).toBeVisible();
  const first = gapRows.first();
  const trigger = first.locator('h3 button');
  const body = first.locator('.astrid-vision-part-body');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(body).toBeHidden();
  const collapsed = await first.evaluate(element => element.getBoundingClientRect().height);
  expect(collapsed).toBeLessThan(105);
  const gapChevronInset = await first.evaluate(element => {
    const button = element.querySelector('h3 button')!;
    const chevron = button.querySelector('svg')!;
    return button.getBoundingClientRect().right - chevron.getBoundingClientRect().right;
  });
  expect(gapChevronInset).toBeGreaterThanOrEqual(12);
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(body).toBeVisible();
  const expanded = await first.evaluate(element => element.getBoundingClientRect().height);
  expect(expanded).toBeGreaterThan(collapsed + 100);
  await trigger.click();
  await expect(body).toBeHidden();

  await expect(page.locator('.astrid-vision-parts-head > p')).toHaveCount(1);
  await expect(page.locator('.astrid-vision-issues-head > p')).toHaveCount(1);
  const gapContext = page.locator('.astrid-vision-parts .astrid-vision-context-row > .astrid-vision-section-context');
  await expect(gapContext).toContainText("These are the gaps between where we are now and where we want to get to, and the evidence we're using to assess our progress.");
  const gapDefinition = gapContext.getByRole('link', { name: 'What makes a gap?' });
  await expect(gapDefinition).toHaveAttribute('href',
    'https://github.com/banodoco/astrid-dev/blob/main/docs/contribution-workflow.md#define-or-reassess-a-vision-gap');
  const catalogLink = page.locator('.astrid-vision-projects .astrid-vision-context-row > .astrid-vision-section-context a');
  await expect(catalogLink).toHaveText('Astrid Dev catalog');
  await expect(catalogLink).toHaveAttribute('href', /github\.com\/banodoco\/astrid-dev\/tree\/[0-9a-f]{40}\/plans$/);
  expect(await catalogLink.evaluate(element => getComputedStyle(element).textDecorationLine)).toContain('underline');
  await expect(page.getByRole('link', { name: 'Astrid on GitHub' }))
    .toHaveAttribute('href', 'https://github.com/banodoco/astrid-dev');
  const gapFilter = page.getByRole('combobox', { name: 'Filter gaps by status' });
  const projectFilter = page.getByRole('combobox', { name: 'Filter projects by status' });
  for (const section of ['.astrid-vision-parts', '.astrid-vision-projects']) {
    const row = page.locator(section + ' .astrid-vision-context-row');
    const description = await row.locator('.astrid-vision-section-context').boundingBox();
    const filter = await row.locator('.astrid-vision-filter-bar').boundingBox();
    expect(description).not.toBeNull();
    expect(filter).not.toBeNull();
    expect(description!.x + description!.width).toBeLessThan(filter!.x);
    expect(Math.abs(description!.y + description!.height / 2 -
      (filter!.y + filter!.height / 2))).toBeLessThan(2);
  }
  for (const select of [gapFilter, projectFilter]) {
    const style = await select.evaluate(element => {
      const css = getComputedStyle(element);
      return { appearance: css.appearance, paddingRight: Number.parseFloat(css.paddingRight), image: css.backgroundImage };
    });
    expect(style.appearance).toBe('none');
    expect(style.paddingRight).toBeGreaterThanOrEqual(36);
    expect(style.image).toContain('data:image/svg+xml');
  }
});

test('phone status controls stay right-aligned under descriptions and within half the viewport', async ({ page, request }) => {
  await pinnedFeed(page, request);
  for (const width of [320, 390, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    for (const section of ['.astrid-vision-parts', '.astrid-vision-projects']) {
      const row = page.locator(section + ' .astrid-vision-context-row');
      const description = await row.locator('.astrid-vision-section-context').boundingBox();
      const filter = await row.locator('.astrid-vision-filter-bar').boundingBox();
      const select = await row.locator('select').boundingBox();
      expect(description).not.toBeNull();
      expect(filter).not.toBeNull();
      expect(select).not.toBeNull();
      expect(filter!.y).toBeGreaterThanOrEqual(description!.y + description!.height);
      expect(filter!.width).toBeLessThanOrEqual(width / 2 + 1);
      expect(filter!.x + filter!.width).toBeLessThanOrEqual(width + 1);
      expect(Math.abs(filter!.x + filter!.width - (description!.x + description!.width))).toBeLessThan(2);
      expect(select!.x + select!.width).toBeLessThanOrEqual(filter!.x + filter!.width + 1);
    }
  }
});

test('all editorial section headers share a consistent divider and title system', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const sections = page.locator('.astrid-vision-north-star, .astrid-vision-standards, .astrid-vision-parts, .astrid-vision-projects');
  await expect(sections).toHaveCount(4);
  const headers = sections.locator('.astrid-vision-section-head');
  await expect(headers).toHaveCount(4);
  const styles = await headers.evaluateAll(elements => elements.map(element => {
    const css = getComputedStyle(element);
    return {
      borderStyle: css.borderBottomStyle,
      borderWidth: css.borderBottomWidth,
      borderColor: css.borderBottomColor,
      padding: css.paddingBottom,
      headingSize: getComputedStyle(element.querySelector('h2')!).fontSize,
      childParagraphs: element.querySelectorAll(':scope > p').length,
      x: element.getBoundingClientRect().left,
    };
  }));
  expect(styles.every(s => s.borderStyle === 'solid' && s.borderWidth === '1px' && s.childParagraphs === 1)).toBeTruthy();
  expect(new Set(styles.map(s => s.borderColor)).size).toBe(1);
  expect(new Set(styles.map(s => s.padding)).size).toBe(1);
  expect(new Set(styles.map(s => s.headingSize)).size).toBe(1);
  expect(Math.max(...styles.map(s => s.x)) - Math.min(...styles.map(s => s.x))).toBeLessThan(2);
});

test('hero keeps the vision narrative separate from website source attribution', async ({ page, request }) => {
  const content = await feed(request);
  const source = 'https://github.com/banodoco/astrid-dev';
  const intro = 'Astrid aims to help individuals and the community as a whole pursue artistic work beyond what they thought possible.';
  await page.route(FEED, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ ...content, vision: { ...content.vision, introMarkdown: intro } }),
  }));
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const paragraphs = page.locator('.astrid-vision-lead p');
  await expect(paragraphs).toHaveCount(1);
  await expect(paragraphs.first()).toHaveText(intro);
  const attribution = page.locator('.astrid-vision-source-attribution');
  await expect(attribution).toContainText('Astrid Dev repository');
  await expect(attribution.getByRole('link', { name: 'Astrid Dev repository' })).toHaveAttribute('href', source);
  await expect(attribution.getByRole('link', { name: 'Help us build it' })).toHaveCount(0);
  await expect.poll(() => attribution.evaluate(element => getComputedStyle(element).fontSize)).toBe('14px');
});

test('the copy button confirms in place, preserves its dimensions, and resets', async ({ page, request }) => {
  const content = await pinnedFeed(page, request);
  expect(content.vision.agentPrompt).toBeTruthy();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          (window as typeof window & { __copiedAgentPrompt?: string }).__copiedAgentPrompt = value;
          return Promise.resolve();
        },
      },
    });
  });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: 'Help us build it' })).toHaveCount(0);
    const contribution = page.locator('#astrid-vision-contribute');
    await expect(contribution.getByRole('link', { name: 'Give these instructions to your agent' })).toHaveCount(0);
    const button = contribution.getByRole('button', { name: 'Copy instructions for agents' });
    await button.scrollIntoViewIfNeeded();
    const before = await button.boundingBox();
    expect(before).not.toBeNull();
    await button.click();
    const successButton = contribution.getByRole('button', { name: 'Instructions copied for your agent' });
    await expect(successButton).toBeVisible();
    const after = await successButton.boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.width - before!.width)).toBeLessThan(1);
    expect(Math.abs(after!.height - before!.height)).toBeLessThan(1);
    await expect(contribution.locator('.astrid-vision-copy-agent-status')).toHaveCount(0);
    const copied = await page.evaluate(() => (window as typeof window & { __copiedAgentPrompt?: string }).__copiedAgentPrompt);
    expect(copied).toBe(content.vision.agentPrompt);
    await expect(contribution.getByRole('button', { name: 'Copy instructions for agents' })).toBeVisible({ timeout: 6000 });
  }
});

test('failed copy shows an honest GitHub fallback', async ({ page, request }) => {
  await pinnedFeed(page, request);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('Clipboard denied')) },
    });
  });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const contribution = page.locator('#astrid-vision-contribute');
  await contribution.getByRole('button', { name: 'Copy instructions for agents' }).click();
  await expect(contribution.getByRole('alert')).toContainText('Couldn’t copy.');
  await expect(contribution.getByRole('link', { name: 'Open instructions on GitHub' })).toBeVisible();
  await expect(contribution.getByRole('button', { name: 'Copy instructions for agents' })).toBeVisible();
});

test('projects filter current work by default and can reveal every historic project', async ({ page, request }) => {
  const content = await pinnedFeed(page, request);
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const current = content.projects.filter(project => !['done', 'cancelled'].includes(project.status));
  const initial = current.slice(0, 8);
  const rows = page.locator('.astrid-vision-project-row');
  const selector = page.getByRole('combobox', { name: 'Filter projects by status' });
  await expect(selector).toHaveValue('current');
  await expect(rows).toHaveCount(initial.length);
  await expect(rows.first().locator('h3')).toHaveText(initial[0].title);
  await expect(rows.first().locator('.astrid-vision-project-status')).toHaveText(initial[0].status);
  await expect(rows.first().getByRole('link', { name: 'Project details on GitHub' }))
    .toHaveAttribute('href', initial[0].githubUrl);
  await page.getByRole('button', { name: 'View all ' + current.length + ' current projects' }).click();
  await expect(rows).toHaveCount(current.length);
  await selector.selectOption('all');
  await expect(rows).toHaveCount(content.projects.length);
  await selector.selectOption('queued');
  await expect(rows).toHaveCount(content.projects.filter(project => project.status === 'queued').length);
  await selector.selectOption('done');
  await expect(rows).toHaveCount(content.projects.filter(project => project.status === 'done').length);
  await selector.selectOption('current');
  await expect(rows).toHaveCount(initial.length);
});

test('phone gap disclosures start collapsed, open evidence, and filter all statuses', async ({ page, request }) => {
  const content = await pinnedFeed(page, request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const current = content.gaps.filter(gap => gap.assessment !== 'closed');
  const first = content.gaps.find(g => g.id === 'AA-001')!;
  const gap = page.locator('#gap-aa-001');
  const selector = page.getByRole('combobox', { name: 'Filter gaps by status' });
  await expect(selector).toHaveValue('current');
  await expect(page.locator('.astrid-vision-part')).toHaveCount(Math.min(10, current.length));
  await expect(gap).toBeVisible();
  await expect(gap.getByRole('button', { name: first.title })).toHaveAttribute('aria-expanded', 'false');
  await gap.getByRole('button', { name: first.title }).click();
  await expect(gap.locator('.astrid-vision-gap-state')).toHaveText(first.assessment);
  const source = gap.getByRole('link', { name: 'Read full gap and evidence on GitHub' });
  await expect(source).toHaveAttribute('href', first.githubUrl);
  expect(await source.evaluate(element => getComputedStyle(element).borderTopStyle)).toBe('solid');
  await selector.selectOption('all');
  await expect(page.locator('.astrid-vision-part')).toHaveCount(Math.min(10, content.gaps.length));
  await page.getByRole('button', { name: 'Show all gaps' }).click();
  await expect(page.locator('.astrid-vision-part')).toHaveCount(content.gaps.length);
  await selector.selectOption('closed');
  await expect(page.locator('.astrid-vision-part')).toHaveCount(content.gaps.filter(gap => gap.assessment === 'closed').length);
  if (!content.gaps.some(gap => gap.assessment === 'closed')) {
    await expect(page.locator('.astrid-vision-filter-empty')).toHaveText('No gaps with this status yet.');
  }
  await selector.selectOption('current');
  await expect(page.locator('.astrid-vision-part')).toHaveCount(Math.min(10, current.length));
});

test('status filters include closed gaps and completed projects from a valid feed', async ({ page, request }) => {
  const content = await feed(request);
  const altered = {
    ...content,
    gaps: content.gaps.map((gap, i) => i === content.gaps.length - 1 ? { ...gap, assessment: 'closed' } : gap),
    projects: content.projects.map((project, i) => i === 0 ? { ...project, status: 'done' } : project),
  };
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(altered),
  }));
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const gapFilter = page.getByRole('combobox', { name: 'Filter gaps by status' });
  const projectFilter = page.getByRole('combobox', { name: 'Filter projects by status' });
  await expect(page.locator('.astrid-vision-part')).toHaveCount(
    Math.min(10, altered.gaps.filter(gap => gap.assessment !== 'closed').length));
  await gapFilter.selectOption('closed');
  await expect(page.locator('.astrid-vision-part')).toHaveCount(altered.gaps.filter(gap => gap.assessment === 'closed').length);
  await gapFilter.selectOption('all');
  await expect(page.locator('.astrid-vision-part')).toHaveCount(Math.min(10, altered.gaps.length));
  await page.getByRole('button', { name: 'Show all gaps' }).click();
  await expect(page.locator('.astrid-vision-part')).toHaveCount(altered.gaps.length);
  await projectFilter.selectOption('all');
  await expect(page.locator('.astrid-vision-project-row')).toHaveCount(altered.projects.length);
  await projectFilter.selectOption('done');
  await expect(page.locator('.astrid-vision-project-row')).toHaveCount(altered.projects.filter(project => project.status === 'done').length);
});

test('different valid feed content renders without rebuilding the app', async ({ page, request }) => {
  const content = await feed(request);
  const changed = {
    ...content,
    vision: { ...content.vision, title: 'Dynamic source title', introMarkdown: 'A new published ambition, without rebuilding the app.' },
  };
  await page.route(FEED, route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(changed),
    headers: { 'access-control-allow-origin': '*' },
  }));
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Vision');
  await expect(page.locator('.astrid-vision-lead')).toContainText('A new published ambition');
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

import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { PublicVisionContent } from '../../src/pages/Home/publicVisionContent';
import { legacyVisionFixture, visionFixture } from '../fixtures/public-vision';

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';

async function openVision(page: Page, feed = visionFixture()) {
  await page.route(FEED, route => route.fulfill({ json: feed }));
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Explore Artistic ambition: gaps and projects' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function expectGapPresentation(row: Locator) {
  const heading = row.locator('.astrid-vision-details-gap-heading');
  await expect(heading.locator('.astrid-vision-details-gap-label')).toHaveCount(0);
  const group = await row.evaluate(node => {
    const group = node.closest('.astrid-vision-details-gap-group, .astrid-vision-details-gaps')!;
    const label = group.querySelector('.astrid-vision-details-gap-group-label')!;
    const first = group.querySelector('.astrid-vision-details-gap')!;
    return { text: label.textContent, count: group.querySelectorAll('.astrid-vision-details-gap').length,
      before: label.getBoundingClientRect().bottom <= first.getBoundingClientRect().top + 1 };
  });
  expect(group.text).toBe(group.count === 1 ? 'Gap' : 'Gaps');
  expect(group.before).toBe(true);
  await expect(row.locator('.astrid-vision-details-gap-description dt')).toHaveText(['Desired state']);
  await expect(row.locator('.astrid-vision-details-gap-assessment, .astrid-vision-details-supporting')).toHaveCount(0);
  // Assert both reading order and visual order, including the empty-project case.
  expect(await row.evaluate(node => {
    const desired = node.querySelector('.astrid-vision-details-gap-description')!;
    const projects = node.querySelector('.astrid-vision-details-projects, .astrid-vision-details-empty')!;
    return Boolean(desired.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      desired.getBoundingClientRect().bottom <= projects.getBoundingClientRect().top + 1;
  })).toBe(true);
  expect(await heading.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}

for (const width of [1440, 390]) {
  test(`aspiration → gap → independent project disclosures at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const feed = visionFixture();
    const intros = [
      'Keep every camera and sound cue together while composing a scene.',
      'Share reusable tools without losing their original settings.',
      'Preserve earlier creative decisions across editing sessions.',
    ];
    feed.projects.forEach((project, index) => {
      project.goalMarkdown = intros[index] + (index === 0 ? '\n\nA separate detailed explanation stays behind the project disclosure.' : '');
      project.owner = 'Project owner ' + index;
      project.estimate = (index + 1) + ' days';
      project.waitingOn = 'Dependency ' + index;
    });
    feed.projects[2].status = 'done';
    await openVision(page, feed);
    const dialog = page.getByRole('dialog');
    const aspirations = dialog.locator('.astrid-vision-details-aspiration');
    await expect(aspirations).toHaveCount(3);
    const aspiration = aspirations.first();
    const disclosure = aspiration.locator('.astrid-vision-details-characteristic');
    await expect(disclosure).not.toHaveAttribute('open', '');
    const gaps = aspiration.locator('.astrid-vision-details-gap');
    await expect(gaps).toHaveCount(2);
    const gapSummary = gaps.first().locator(':scope > summary');
    await expect(gapSummary).toContainText('Finish ambitious work');
    await expect(gapSummary).toContainText('3 projects');
    await expect(gapSummary).not.toContainText('Live composition');
    await expect(aspiration.locator('.astrid-vision-details-gap-group-label')).toHaveText('Gaps');
    await expect(gaps.nth(1).locator(':scope > summary')).toContainText('No project yet');
    await expect(dialog.locator('.astrid-vision-details-aspiration-empty')).toHaveCount(0);
    await expect(aspirations.nth(1).locator('.astrid-vision-details-gap-group')).toHaveCount(0);
    await expect(aspirations.nth(2).locator('.astrid-vision-details-gap-group')).toHaveCount(0);
    await expect(dialog.getByRole('region', { name: 'Current gaps and projects' })).toHaveCount(0);
    await expect(gaps.first().locator('.astrid-vision-details-gap-body')).toBeHidden();
    await expect(gaps.first().locator('.astrid-vision-project-summary').first()).toBeHidden();

    await disclosure.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(disclosure).toHaveAttribute('open', '');
    await expect(disclosure.locator('.astrid-vision-details-characteristic-body strong')).toHaveText(['We should:', 'We should never:']);
    await expect(disclosure.locator('ul').first()).toHaveCSS('list-style-type', 'disc');
    await gapSummary.click();
    await expect(gaps.first()).toHaveAttribute('open', '');
    await expectGapPresentation(gaps.first());
    await expect(gaps.first().locator('.astrid-vision-details-gap-description dd')).toHaveText(feed.gaps[0].desiredMarkdown);
    // Gap summaries remain the full toggle, including when there are no projects.
    await gaps.nth(1).locator(':scope > summary').click();
    await expect(gaps.nth(1)).toHaveAttribute('open', '');
    await expectGapPresentation(gaps.nth(1));
    await expect(gaps.nth(1).locator('.astrid-vision-project')).toHaveCount(0);
    await expect(gaps.nth(1).locator('.astrid-vision-details-gap-description dd')).toHaveText(feed.gaps[1].desiredMarkdown);
    await gaps.nth(1).locator(':scope > summary').click();
    const projects = gaps.first().locator('.astrid-vision-project');
    await expect(projects).toHaveCount(3);
    await expect(projects.locator('.astrid-vision-project-title'))
      .toHaveText(['Live composition', 'Reusable tools', 'Editable history']);
    for (const [index, project] of feed.projects.entries()) {
      const card = projects.nth(index);
      await expect(card).toHaveAttribute('data-project-id', project.id);
      await expect(card).not.toHaveAttribute('open', '');
      await expect(card.locator('.astrid-vision-project-intro')).toHaveText(intros[index]);
      await expect(card.locator('.astrid-vision-project-intro')).toBeVisible();
      await expect(card.locator('.astrid-vision-project-body')).toBeHidden();
      await expect(card.locator('summary a')).toHaveCount(0);
      await expect(card.locator('.astrid-vision-details-project-heading a')).toHaveAttribute('href', project.githubUrl);
    }
    await projects.first().locator('summary').click();
    await expect(projects.first()).toHaveAttribute('open', '');
    await expect(projects.first().locator('.astrid-vision-project-body')).toBeVisible();
    await expect(projects.first().locator('.astrid-vision-details-project-goal'))
      .toHaveText('A separate detailed explanation stays behind the project disclosure.');
    await expect(projects.first().locator('.astrid-vision-project-metadata dt'))
      .toHaveText(['Status', 'Owner', 'Estimate', 'Waiting on']);
    await expect(projects.first().locator('.astrid-vision-project-metadata dd'))
      .toHaveText(['queued', 'Project owner 0', '1 days', 'Dependency 0']);
    await expect(gaps.first()).toHaveAttribute('open', '');
    await expect(projects.nth(1)).not.toHaveAttribute('open', '');
    await projects.nth(1).locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(projects.nth(1)).toHaveAttribute('open', '');
    await expect(projects.first()).toHaveAttribute('open', '');
    await expect(projects.nth(2)).not.toHaveAttribute('open', '');
    await projects.first().locator('summary').focus();
    await page.keyboard.press('Space');
    await expect(projects.first()).not.toHaveAttribute('open', '');
    await expect(projects.nth(1)).toHaveAttribute('open', '');
    await expect(dialog.locator('[data-gap-id="AA-001"]')).toHaveCount(1);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    for (const card of await projects.all()) {
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    mkdirSync('test-results/vision-captures', { recursive: true });
    await projects.first().locator('summary').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/vision-captures/fixture-project-disclosures-${info.project.name}-${width}.png` });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Explore Open by design: gaps and projects' }).click();
    await expect(page.getByRole('dialog').locator('[data-gap-id="AA-001"]')).toHaveCount(0);
  });

  test(`published project titles and introductions stay together at ${width}px`, async ({ page, request }, info) => {
    const response = await request.get(FEED);
    expect(response.ok()).toBeTruthy();
    const feed = await response.json() as PublicVisionContent;
    const projectsFor = (id: string) => feed.projects
      .filter(project => (project.primaryGapId ?? project.gapIds[0]) === id)
      .sort((a, b) => a.priorityOrder - b.priorityOrder);
    const gap = feed.gaps.find(item => item.assessment !== 'closed' && item.aspiration &&
      item.primaryAppliesTo?.startsWith('pillar:') && projectsFor(item.id).length >= 2);
    expect(gap).toBeDefined();
    const pillar = feed.pillars.find(item => 'pillar:' + item.id === gap!.primaryAppliesTo)!;
    const plans = projectsFor(gap!.id);
    await page.route(FEED, route => route.fulfill({ json: feed }));
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Explore ' + pillar.title + ': gaps and projects' }).click();
    const dialog = page.getByRole('dialog');
    const row = dialog.locator('[data-gap-id="' + gap!.id + '"]');
    await expect(row.locator(':scope > summary')).not.toContainText(plans[0].title);
    await row.locator(':scope > summary').click();
    await expectGapPresentation(row);
    const cards = row.locator('.astrid-vision-project');
    await expect(cards).toHaveCount(plans.length);
    await expect(cards.locator('.astrid-vision-project-title')).toHaveText(plans.map(plan => plan.title));
    for (const [index, plan] of plans.entries()) {
      const card = cards.nth(index);
      await expect(card).not.toHaveAttribute('open', '');
      await expect(card.locator('.astrid-vision-project-intro')).not.toBeEmpty();
      await expect(card.locator('.astrid-vision-details-project-heading a')).toHaveAttribute('href', plan.githubUrl);
    }
    // Screenshots use the published source unchanged, never the dummy fixture.
    mkdirSync('test-results/vision-captures', { recursive: true });
    writeFileSync(`test-results/vision-captures/real-projects-${info.project.name}-${width}-source.json`,
      JSON.stringify({ source: feed.source, gapId: gap!.id, desiredMarkdown: gap!.desiredMarkdown, projects: plans }, null, 2));
    await row.evaluate(node => {
      const viewport = node.closest('.astrid-vision-details-scroll')!;
      viewport.scrollTop += node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 8;
    });
    await page.screenshot({ path: `test-results/vision-captures/real-projects-${info.project.name}-${width}.png` });
    await cards.first().locator('summary').click();
    await expect(cards.first().locator('.astrid-vision-project-body')).toBeVisible();
    await expect(cards.first().locator('.astrid-vision-project-metadata dd')).toHaveText([
      plans[0].status, plans[0].owner, plans[0].estimate, plans[0].waitingOn,
    ]);
    await expect(row).toHaveAttribute('open', '');
    await expect(cards.nth(1)).not.toHaveAttribute('open', '');
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await cards.first().evaluate(node => {
      const viewport = node.closest('.astrid-vision-details-scroll')!;
      viewport.scrollTop += node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 8;
    });
    await page.screenshot({ path: `test-results/vision-captures/real-project-expanded-${info.project.name}-${width}.png` });
  });
}

test('legacy gap cards also label the gap and put only desired state before projects', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const feed = legacyVisionFixture();
  await openVision(page, feed);
  const rows = page.getByRole('dialog').locator('.astrid-vision-details-gap-list > li');
  await expect(rows).toHaveCount(2);
  for (const [index, row] of (await rows.all()).entries()) {
    await expectGapPresentation(row);
    await expect(row.locator('.astrid-vision-details-gap-description dd')).toHaveText(feed.gaps[index].desiredMarkdown);
  }
});

test('exported candidate feed renders real Packs rules and real aspiration links', async ({ page }, info) => {
  // The fixture fallback also keeps this test runnable without a sibling checkout.
  // Cross-repository CI always supplies the exact candidate source export.
  const file = process.env.PUBLIC_VISION_FEED_FILE;
  const feed = file ? JSON.parse(readFileSync(file, 'utf8')) : visionFixture();
  await page.route(FEED, route => route.fulfill({ json: feed }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const pillar = feed.pillars.find((item: { id: string }) => item.id === 'liquid-software') ?? feed.pillars[0];
  await page.getByRole('button', { name: 'Explore ' + pillar.title + ': gaps and projects' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('region', { name: 'Aspirations', exact: true })).toBeVisible();
  const expected = feed.gaps.filter((gap: { assessment: string; primaryAppliesTo: string }) =>
    gap.assessment !== 'closed' && gap.primaryAppliesTo === 'pillar:' + pillar.id);
  await expect(dialog.locator('[data-gap-id]')).toHaveCount(expected.length);
  const packs = pillar.characteristics.find((item: { title: string }) => item.title.startsWith('Packs')) ?? pillar.characteristics[0];
  const aspiration = dialog.locator('.astrid-vision-details-aspiration').filter({ has: page.locator('summary strong', { hasText: packs.title }) });
  await aspiration.locator('.astrid-vision-details-characteristic > summary').click();
  await expect(aspiration.locator('.astrid-vision-details-characteristic-body')).toContainText('We should never:');
  await expect(aspiration.locator('.astrid-vision-details-characteristic-body ul')).toHaveCount(2);
  mkdirSync('test-results/vision-captures', { recursive: true });
  await page.screenshot({ path: `test-results/vision-captures/${file ? 'candidate' : 'fixture'}-packs-${info.project.name}.png` });
});

test.describe('a dismissal consumes precisely one gesture', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('keeps the modal top layer alive until a delayed final click has been consumed', async ({ page }) => {
    await openVision(page);
    const dialog = page.getByRole('dialog');
    await dialog.evaluate(node => {
      for (const type of ['pointerdown', 'pointerup']) node.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true,
        clientX: 2, clientY: 2, button: 0, buttons: type === 'pointerdown' ? 1 : 0,
      }));
    });
    // Regression proof: the old pointerup RAF removes the top layer during this interval.
    await page.waitForTimeout(150);
    await expect(dialog).toBeVisible();
    await dialog.evaluate(node => node.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, clientX: 2, clientY: 2,
    })));
    await expect(dialog).toHaveCount(0);
  });

  test('a real touch over another card dismisses only; a new touch opens that card', async ({ page }) => {
    await openVision(page);
    const second = page.getByRole('button', { name: 'Explore Liquid software: gaps and projects' });
    await second.evaluate(node => {
      // Put a real React card opener exactly underneath the exposed backdrop.
      document.getElementById('root')!.appendChild(node);
      (node as HTMLElement).style.cssText = 'position:fixed;left:0;top:0;width:18px;height:18px;z-index:2147483647;pointer-events:auto;transform:none';
      node.addEventListener('click', () => node.setAttribute('data-test-clicked', 'true'));
    });
    const dialog = page.getByRole('dialog');
    await page.touchscreen.tap(4, 4);
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(350);
    await expect(second).not.toHaveAttribute('data-test-clicked', 'true');
    await page.touchscreen.tap(4, 4);
    await expect(second).toHaveAttribute('data-test-clicked', 'true');
    await expect(page.getByRole('dialog', { name: 'Liquid software' })).toBeVisible();
  });

  test('drags, cancellation and keyboard disclosure activation do not dismiss the modal', async ({ page }) => {
    await openVision(page);
    const dialog = page.getByRole('dialog');
    for (const ending of ['pointercancel', 'pointerup']) {
      await dialog.evaluate((node, end) => {
        const emit = (type: string, x: number, y: number) => node.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 8, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y,
        }));
        emit('pointerdown', 2, 2);
        emit('pointermove', 2, 35);
        emit(end, 2, 35);
        node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 2, clientY: 35 }));
      }, ending);
      await expect(dialog).toBeVisible();
    }
    const disclosure = dialog.locator('.astrid-vision-details-characteristic').first();
    await disclosure.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('open', '');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close details' }).tap();
    await expect(dialog).toHaveCount(0);
  });
});


test('gap groups use singular labels and empty aspirations stay quiet', async ({ page }) => {
  const feed = visionFixture();
  feed.gaps = [feed.gaps[0]];
  await openVision(page, feed);
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.astrid-vision-details-gap-group-label')).toHaveText(['Gap']);
  await expect(dialog.locator('.astrid-vision-details-gap-label, .astrid-vision-details-aspiration-empty')).toHaveCount(0);
  await expect(dialog).not.toContainText('No gap is measured');
  await dialog.locator('.astrid-vision-details-gap > summary').click();
  await expectGapPresentation(dialog.locator('.astrid-vision-details-gap'));
  await page.keyboard.press('Escape');
  feed.gaps = [];
  await openVision(page, feed);
  await expect(page.getByRole('dialog').locator('.astrid-vision-details-gap-group-label, .astrid-vision-details-gaps')).toHaveCount(0);
  await expect(page.getByRole('dialog')).not.toContainText('No current gaps');
});

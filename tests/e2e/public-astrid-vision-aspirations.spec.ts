import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { visionFixture } from '../fixtures/public-vision';

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';

async function openVision(page: Page) {
  await page.route(FEED, route => route.fulfill({ json: visionFixture() }));
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Explore Artistic ambition: gaps and projects' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

for (const width of [1440, 390]) {
  test(`aspiration → gap → projects is readable before expanding at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await openVision(page);
    const dialog = page.getByRole('dialog');
    const aspirations = dialog.locator('.astrid-vision-details-aspiration');
    await expect(aspirations).toHaveCount(3);
    const aspiration = aspirations.first();
    const disclosure = aspiration.locator('.astrid-vision-details-characteristic');
    await expect(disclosure).not.toHaveAttribute('open', '');
    const gaps = aspiration.locator('.astrid-vision-details-gap');
    await expect(gaps).toHaveCount(2);
    await expect(gaps.first().locator('summary')).toContainText('Finish ambitious work');
    await expect(gaps.first().locator('summary')).toContainText('3 projects');
    await expect(gaps.first().locator('summary')).toContainText('Live composition');
    await expect(gaps.nth(1).locator('summary')).toContainText('No project yet');
    await expect(aspirations.nth(1)).toContainText('No current gaps are measured against this.');
    await expect(aspirations.nth(2)).toContainText('No gap is measured against this yet.');
    await expect(dialog.getByRole('region', { name: 'Current gaps and projects' })).toHaveCount(0);
    await expect(gaps.first().locator('.astrid-vision-details-gap-body')).toBeHidden();
    mkdirSync('test-results/vision-captures', { recursive: true });
    await page.screenshot({ path: `test-results/vision-captures/aspirations-${info.project.name}-${width}.png` });

    await disclosure.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(disclosure).toHaveAttribute('open', '');
    await expect(disclosure.locator('strong')).toHaveText(['We should:', 'We should never:']);
    await expect(disclosure.locator('ul').first()).toHaveCSS('list-style-type', 'disc');
    await gaps.first().locator('summary').click();
    await expect(gaps.first()).toHaveAttribute('open', '');
    await expect(gaps.first().locator('dt')).toHaveText(['Desired state', 'Current state', 'What is missing', 'Closure evidence']);
    await expect(gaps.first().locator('.astrid-vision-details-project-heading a'))
      .toHaveText(['Live composition', 'Reusable tools', 'Editable history']);
    await expect(gaps.first().locator('.astrid-vision-details-supporting')).toHaveText('Also relates to Creative agency');
    await expect(dialog.locator('[data-gap-id="AA-001"]')).toHaveCount(1);
    const noOverflow = await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1);
    expect(noOverflow).toBe(true);
    await gaps.first().locator('summary').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/vision-captures/aspirations-expanded-${info.project.name}-${width}.png` });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Explore Open by design: gaps and projects' }).click();
    await expect(page.getByRole('dialog').locator('[data-gap-id="AA-001"]')).toHaveCount(0);
  });
}

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
  await page.screenshot({ path: `test-results/vision-captures/packs-${info.project.name}.png` });
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

import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { PublicVisionContent } from '../../src/pages/Home/publicVisionContent';
import { aspirationsForSubject } from '../../src/pages/Home/visionHierarchy';

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';
const folder = 'test-results/vision-captures';

async function expectContained(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  const dialog = page.getByRole('dialog');
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(901);
  if (width <= 760) {
    expect(Math.abs(bounds!.x)).toBeLessThan(1);
    expect(Math.abs(bounds!.width - width)).toBeLessThan(1);
    expect(await dialog.evaluate(el => Number.parseFloat(getComputedStyle(el).maxHeight))).toBeGreaterThan(830);
  }
}

for (const width of [320, 390, 760, 1440]) {
  test(`real vision grid, counts and on-demand catalogs at ${width}px`, async ({ page, request }, info) => {
    const response = await request.get(FEED);
    expect(response.ok()).toBeTruthy();
    const feed = await response.json() as PublicVisionContent;
    await page.route(FEED, route => route.fulfill({ json: feed }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    const cards = page.locator('.astrid-vision-principles > li');
    await expect(cards).toHaveCount(4);
    await expect(page.locator('.astrid-vision-source-attribution')).toHaveText('Populated by the Astrid Dev repository.');
    await expect(page.locator('#astrid-vision-parts, #astrid-vision-projects')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Vision page sections' }).getByRole('link')).toHaveCount(4);
    for (const [i, pillar] of feed.pillars.entries()) {
      const hierarchy = aspirationsForSubject(feed, { kind: 'pillar', id: pillar.id });
      const groups = [...hierarchy.aspirations.flatMap(item => item.gaps), ...hierarchy.legacyGaps];
      const gaps = new Set(groups.map(item => item.gap.id)).size;
      const projects = new Set(groups.flatMap(item => item.projects.map(project => project.id))).size;
      await expect(cards.nth(i).locator('.astrid-vision-subject-counts'))
        .toHaveText(`${gaps} ${gaps === 1 ? 'gap' : 'gaps'} · ${projects} ${projects === 1 ? 'project' : 'projects'}`);
      await expect(cards.nth(i).locator('h3')).toHaveText(pillar.title);
      await expect(cards.nth(i).locator(':scope > p')).toHaveText(pillar.descriptor);
      expect(await cards.nth(i).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    const boxes = await cards.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
    if (width <= 760) {
      expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(2);
      expect(Math.abs(boxes[2].y - boxes[3].y)).toBeLessThan(2);
      expect(boxes[1].x).toBeGreaterThan(boxes[0].x + boxes[0].width);
      expect(boxes[2].y).toBeGreaterThan(boxes[0].y + boxes[0].height);
      for (const card of await cards.all()) {
        const art = await card.locator('.astrid-vision-pillar-stage').boundingBox();
        const title = await card.locator('h3').boundingBox();
        expect(art!.y + art!.height).toBeLessThanOrEqual(title!.y + 1);
      }
      const principles = await page.locator('.astrid-vision-standards-list > li').evaluateAll(nodes =>
        nodes.map(node => node.getBoundingClientRect().toJSON()));
      for (let i = 1; i < principles.length; i++) {
        expect(principles[i].y - principles[i - 1].y - principles[i - 1].height).toBeGreaterThanOrEqual(15);
      }
    }
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${folder}/mobile-catalogs-${info.project.name}-${width}-source.json`, JSON.stringify(feed.source));
    await page.locator('.astrid-vision-north-star').screenshot({ path: `${folder}/real-mobile-grid-${info.project.name}-${width}.png` });
    await cards.first().getByRole('button').click();
    await expectContained(page, width);
    await page.screenshot({ path: `${folder}/real-roomy-pillar-${info.project.name}-${width}.png` });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const contribution = page.locator('.astrid-vision-contribute');
    const copy = contribution.getByRole('button', { name: 'Copy instructions for agents', exact: true });
    const actions = contribution.locator('.astrid-vision-catalog-actions');
    await actions.scrollIntoViewIfNeeded();
    const copyBounds = await copy.boundingBox();
    const actionsBounds = await actions.boundingBox();
    expect(actionsBounds!.y).toBeGreaterThanOrEqual(copyBounds!.y + copyBounds!.height);
    await contribution.screenshot({ path: `${folder}/real-catalog-buttons-${info.project.name}-${width}.png` });
    for (const kind of ['projects', 'gaps'] as const) {
      const trigger = page.getByRole('button', { name: 'See all ' + kind, exact: true });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'All ' + kind });
      await expect(dialog).toBeVisible();
      await expectContained(page, width);
      const selector = dialog.getByRole('combobox', { name: 'Filter ' + kind + ' by status' });
      await expect(selector).toHaveValue('all');
      const rows = dialog.locator(kind === 'projects' ? '.astrid-vision-project-row' : '.astrid-vision-part');
      await expect(rows).toHaveCount(feed[kind].length);
      await page.screenshot({ path: `${folder}/real-catalog-${kind}-${info.project.name}-${width}.png` });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(page.locator('#astrid-vision-parts, #astrid-vision-projects')).toHaveCount(0);
    }
  });
}

test('legacy section bookmarks open the right dialog and leave no dead hash on dismissal', async ({ page }) => {
  for (const [hash, label] of [['astrid-vision-parts', 'All gaps'], ['astrid-vision-projects', 'All projects']]) {
    await page.goto('/vision#' + hash, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('dialog', { name: label })).toBeVisible();
    await page.getByRole('button', { name: 'Close details' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Native close removes the dialog from the accessibility tree before its
    // asynchronous close event finishes the route cleanup. Assert that outcome.
    await expect(page).toHaveURL(/\/vision$/);
  }
});

test('catalog backdrop consumes the closing tap without activating the button beneath', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'See all gaps', exact: true }).tap();
    const behind = page.getByRole('button', { name: 'See all projects', exact: true });
    await behind.evaluate(node => {
      document.getElementById('root')!.appendChild(node);
      (node as HTMLElement).style.cssText = 'position:fixed;left:0;top:0;width:18px;height:6px;min-height:0;padding:0;z-index:2147483647;transform:none';
      node.addEventListener('click', () => node.setAttribute('data-test-clicked', 'true'));
    });
    await page.touchscreen.tap(4, 2);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.waitForTimeout(350);
    await expect(behind).not.toHaveAttribute('data-test-clicked', 'true');
    await page.touchscreen.tap(4, 2);
    await expect(page.getByRole('dialog', { name: 'All projects' })).toBeVisible();
  } finally {
    await context.close();
  }
});


async function expectReachableFrame(page: Page, width: number) {
  const dialog = page.getByRole('dialog');
  const header = dialog.locator('.astrid-vision-details-header');
  const frame = dialog.locator('.astrid-vision-details-scroll-frame');
  const close = dialog.getByRole('button', { name: 'Close details' });
  const [panelBox, headerBox, frameBox, closeBox] = await Promise.all([
    dialog.boundingBox(), header.boundingBox(), frame.boundingBox(), close.boundingBox(),
  ]);
  expect(panelBox).not.toBeNull(); expect(headerBox).not.toBeNull();
  expect(frameBox).not.toBeNull(); expect(closeBox).not.toBeNull();
  if (width <= 760) {
    expect(frameBox!.y + frameBox!.height).toBeLessThanOrEqual(headerBox!.y + 1);
    expect(Math.abs(headerBox!.y + headerBox!.height - panelBox!.y - panelBox!.height)).toBeLessThan(2);
    expect(closeBox!.y).toBeGreaterThan(page.viewportSize()!.height - 150);
    expect(closeBox!.width).toBeGreaterThanOrEqual(44);
    expect(closeBox!.height).toBeGreaterThanOrEqual(44);
  } else {
    expect(headerBox!.y + headerBox!.height).toBeLessThanOrEqual(frameBox!.y + 1);
  }
  const before = closeBox!.y;
  await dialog.locator('.astrid-vision-details-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
  expect(Math.abs((await close.boundingBox())!.y - before)).toBeLessThan(1);
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}

for (const width of [320, 390]) {
  test(`compact principles, text catalogs and reachable bottom controls at ${width}px`, async ({ page, request }, info) => {
    const response = await request.get(FEED);
    expect(response.ok()).toBeTruthy();
    const feed = await response.json() as PublicVisionContent;
    await page.route(FEED, route => route.fulfill({ json: feed }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    const nav = page.getByRole('navigation', { name: 'Vision page sections' });
    await expect(nav.getByRole('link', { name: 'Help', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Help us', exact: true })).toHaveCount(0);
    const cards = page.locator('.astrid-vision-standards-list > li');
    await cards.first().scrollIntoViewIfNeeded();
    // Measure after the wordmark has finished folding. The final link
    // shares the header's right inset, rather than leaving spare space.
    await expect.poll(async () => nav.evaluate(node => {
      const bar = node.closest('.astrid-vision-bar')!;
      const last = node.querySelector('a:last-child')!;
      return Math.abs(last.getBoundingClientRect().right -
        (bar.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(bar).paddingRight)));
    })).toBeLessThan(2);
    for (const [index, principle] of feed.principles.entries()) {
      const card = cards.nth(index);
      const hierarchy = aspirationsForSubject(feed, { kind: 'principle', id: principle.id });
      const groups = [...hierarchy.aspirations.flatMap(item => item.gaps), ...hierarchy.legacyGaps];
      const gaps = new Set(groups.map(item => item.gap.id)).size;
      const projects = new Set(groups.flatMap(item => item.projects.map(project => project.id))).size;
      await expect(card.locator('.astrid-vision-subject-counts'))
        .toHaveText(`${gaps} ${gaps === 1 ? 'gap' : 'gaps'} · ${projects} ${projects === 1 ? 'project' : 'projects'}`);
      await expect(card.locator('h3')).toHaveText(principle.title);
      await expect(card.locator('.astrid-vision-principle-statement')).toHaveText(principle.statement!);
      const geometry = await card.evaluate(node => {
        const title = node.querySelector('h3')!;
        const copy = node.querySelector('.astrid-vision-principle-statement')!;
        const sigil = node.querySelector('.astrid-vision-principle-sigil')!;
        return { card: node.getBoundingClientRect().toJSON(), title: title.getBoundingClientRect().toJSON(),
          copy: copy.getBoundingClientRect().toJSON(), sigil: sigil.getBoundingClientRect().toJSON(),
          titleLine: Number.parseFloat(getComputedStyle(title).lineHeight),
          copyLine: Number.parseFloat(getComputedStyle(copy).lineHeight),
          clamp: getComputedStyle(copy).webkitLineClamp,
          noOverflow: node.scrollWidth <= node.clientWidth + 1 };
      });
      expect(geometry.title.height).toBeLessThanOrEqual(geometry.titleLine + 1);
      expect(Math.abs(geometry.title.width - geometry.copy.width)).toBeLessThan(2);
      expect(geometry.copy.height).toBeLessThanOrEqual(geometry.copyLine * 2 + 1);
      expect(geometry.clamp).toBe('2');
      expect(geometry.sigil.x).toBeLessThan(geometry.copy.x + geometry.copy.width);
      expect(geometry.sigil.width).toBeGreaterThanOrEqual(140);
      await expect(card.locator('.astrid-vision-principle-sigil')).toHaveCSS('opacity', '0.13');
      await expect(card.locator('.astrid-vision-principle-sigil')).toHaveCSS('pointer-events', 'none');
      if (width === 390) {
        expect(await card.locator('.astrid-vision-principle-statement').evaluate(node =>
          node.scrollHeight <= Number.parseFloat(getComputedStyle(node).lineHeight) * 2 + 1)).toBe(true);
      }
      expect(geometry.card.height).toBeLessThan(175);
      expect(geometry.noOverflow).toBe(true);
    }
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${folder}/thumb-controls-${info.project.name}-${width}-source.json`, JSON.stringify(feed.source));
    await page.locator('.astrid-vision-standards').screenshot({ path: `${folder}/real-compact-principles-${info.project.name}-${width}.png` });
    await cards.first().getByRole('button').click();
    await expectReachableFrame(page, width);
    // Preview clamping does not shorten or replace the complete source in the popup.
    await expect(page.getByRole('dialog').locator('.astrid-vision-details-statement')).toHaveText(feed.principles[0].statement!);
    await page.getByRole('dialog').locator('.astrid-vision-details-scroll').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: `${folder}/real-bottom-principle-${info.project.name}-${width}.png` });
    await page.getByRole('button', { name: 'Close details' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const actions = page.locator('.astrid-vision-catalog-actions');
    await actions.scrollIntoViewIfNeeded();
    await expect(actions.locator('.astrid-vision-catalog-divider')).toHaveText('|');
    await expect(actions.locator('.astrid-vision-catalog-divider')).toHaveAttribute('aria-hidden', 'true');
    await expect(actions.locator('button')).toHaveText(['See all projects', 'See all gaps']);
    for (const button of await actions.locator('button').all()) {
      await expect(button).toHaveCSS('border-top-width', '0px');
      await expect(button).toHaveCSS('border-left-width', '0px');
      await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await actions.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.locator('.astrid-vision-contribute').screenshot({ path: `${folder}/real-text-catalog-actions-${info.project.name}-${width}.png` });
    for (const kind of ['gaps', 'projects'] as const) {
      const trigger = actions.getByRole('button', { name: 'See all ' + kind, exact: true });
      await trigger.focus(); await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: 'All ' + kind })).toBeVisible();
      await expectReachableFrame(page, width);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  });
}

test('desktop dialog headings remain above their scrolling content', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await page.locator('.astrid-vision-standards-list > li').first().getByRole('button').click();
  await expectReachableFrame(page, 1440);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});


// Simulate toolbar/keyboard viewport changes; this is not a physical iPhone UI test.
test('mobile panels keep equal visible-viewport margins through resize and offset changes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await page.locator('.astrid-vision-principles > li').first().getByRole('button').click();
  const dialog = page.getByRole('dialog');
  const header = dialog.locator('.astrid-vision-details-header');
  const close = dialog.getByRole('button', { name: 'Close details' });
  for (const { height, top } of [{ height: 700, top: 0 }, { height: 800, top: 12 },
    { height: 620, top: 28 }, { height: 700, top: 0 }]) {
    await page.evaluate(({ height, top }) => {
      const viewport = window.visualViewport!;
      Object.defineProperties(viewport, {
        height: { configurable: true, value: height }, offsetTop: { configurable: true, value: top },
      });
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    }, { height, top });
    await expect.poll(async () => {
      const b = (await dialog.boundingBox())!;
      return Math.max(Math.abs(b.y - top - 24), Math.abs(top + height - b.y - b.height - 24));
    }).toBeLessThan(2);
    expect((await header.boundingBox())!.height).toBeGreaterThanOrEqual(112);
    expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(52);
    const before = (await close.boundingBox())!.y;
    await dialog.locator('.astrid-vision-details-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
    expect(Math.abs((await close.boundingBox())!.y - before)).toBeLessThan(1);
  }
  // Pinch zoom must not be undone by shrinking the panel to the zoomed viewport.
  const heightBeforeZoom = (await dialog.boundingBox())!.height;
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport!, {
      height: { configurable: true, value: 350 }, scale: { configurable: true, value: 2 },
    });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(100);
  expect((await dialog.boundingBox())!.height).toBe(heightBeforeZoom);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('mobile panel retains viewport bounds without the VisualViewport API', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'visualViewport', { value: undefined }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'See all gaps', exact: true }).click();
  for (const height of [844, 650, 844]) {
    await page.setViewportSize({ width: 390, height });
    await expect.poll(async () => {
      const b = (await page.getByRole('dialog').boundingBox())!;
      return Math.max(Math.abs(b.y - 24), Math.abs(height - b.y - b.height - 24));
    }).toBeLessThan(2);
  }
});

for (const width of [390, 1440]) {
  test(`next subject cycles inside one modal with reset content at ${width}px`, async ({ page, request }, info) => {
    const response = await request.get(FEED);
    expect(response.ok()).toBeTruthy();
    const feed = await response.json() as PublicVisionContent;
    await page.route(FEED, route => route.fulfill({ json: feed }));
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'The principles that guide us', exact: true })).toBeVisible();
    for (const kind of ['pillar', 'principle'] as const) {
      const subjects = kind === 'pillar' ? feed.pillars : feed.principles;
      const opener = page.getByRole('button', { name: 'Explore ' + subjects[0].title + ': gaps and projects' });
      await opener.focus(); await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await dialog.evaluate(node => node.setAttribute('data-same-modal', 'yes'));
      for (let index = 0; index < subjects.length; index++) {
        await expect(dialog).toHaveAccessibleName(subjects[index].title);
        await expect(dialog).toHaveAttribute('data-same-modal', 'yes');
        await expect(dialog.locator('.astrid-vision-details-statement')).toHaveText(subjects[index].statement!);
        await expect.poll(() => dialog.locator('.astrid-vision-details-scroll').evaluate(node => node.scrollTop)).toBe(0);
        const next = dialog.getByRole('button', { name: 'Next ' + kind + ': ' + subjects[(index + 1) % subjects.length].title });
        const b = (await next.boundingBox())!, panel = (await dialog.boundingBox())!;
        const frame = (await dialog.locator('.astrid-vision-details-scroll-frame').boundingBox())!;
        expect(panel.x + panel.width - b.x - b.width).toBeLessThan(16);
        expect(Math.abs(b.y + b.height / 2 - frame.y - frame.height / 2)).toBeLessThan(2);
        expect(b.width).toBeGreaterThanOrEqual(44);
        // The rail is separate from the text, not a floating button obscuring it.
        const textRight = await dialog.locator('.astrid-vision-details-scroll-inner').evaluate(node => node.getBoundingClientRect().right);
        expect(textRight).toBeLessThanOrEqual(b.x + 1);
        if (index === 0) {
          mkdirSync(folder, { recursive: true });
          await page.screenshot({ path: `${folder}/real-next-${kind}-${info.project.name}-${width}.png` });
        }
        await dialog.locator('.astrid-vision-details-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await next.click();
      }
      await expect(dialog).toHaveAccessibleName(subjects[0].title);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
    }
  });
}

test('two-column mobile pillars animate in reading order as scroll advances and reverses', async ({ page, request }, info) => {
  const response = await request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const feed = await response.json() as PublicVisionContent;
  await page.route(FEED, route => route.fulfill({ json: feed }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const cards = page.locator('.astrid-vision-principles > li');
  await expect(cards).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  // Exercise actual forward/backward scrolling, not coordinates copied from
  // the selection algorithm. At page top the first row is already visible.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(cards.first()).toHaveAttribute('data-play', 'true');
  const end = await cards.last().evaluate(node => {
    const box = node.getBoundingClientRect();
    return Math.max(0, box.bottom + window.scrollY - window.innerHeight / 2);
  });
  const samples: { direction: string; scrollY: number; active: number }[] = [];
  const sweep = async (direction: 'down' | 'up') => {
    const observed: number[] = [];
    const steps = Math.ceil(end / 32);
    for (let step = 0; step <= steps; step++) {
      const top = end * (direction === 'down' ? step / steps : 1 - step / steps);
      await page.evaluate(top => new Promise<void>(resolve => {
        window.scrollTo({ top, behavior: 'instant' });
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }), top);
      const selected = await cards.evaluateAll(nodes => nodes.flatMap((node, i) => node.hasAttribute('data-play') ? [i] : []));
      expect(selected).toHaveLength(1);
      const active = selected[0];
      if (observed.at(-1) !== active) {
        observed.push(active);
        samples.push({ direction, scrollY: await page.evaluate(() => window.scrollY), active });
        await expect(cards.nth(active).locator('.astrid-vision-art-layer').first()).toHaveCSS('animation-play-state', 'running');
      }
    }
    return observed;
  };
  expect(await sweep('down')).toEqual([0, 1, 2, 3]);
  expect(await sweep('up')).toEqual([3, 2, 1, 0]);
  mkdirSync(folder, { recursive: true });
  writeFileSync(`${folder}/pillar-sequence-${info.project.name}.json`, JSON.stringify({ source: feed.source, samples }, null, 2));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => cards.evaluateAll(nodes => nodes.some(node => node.hasAttribute('data-play')))).toBe(false);
});

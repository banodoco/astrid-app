from pathlib import Path
r = Path('.')
p = r/'tests/e2e/public-astrid-vision-mobile-catalogs.spec.ts'
s = p.read_text()
s = s.replace('expect(geometry.title.width).toBeGreaterThan(geometry.copy.width + 60);', 'expect(Math.abs(geometry.title.width - geometry.copy.width)).toBeLessThan(2);')
s = s.replace('expect(geometry.sigil.x).toBeGreaterThanOrEqual(geometry.copy.x + geometry.copy.width);', '''expect(geometry.sigil.x).toBeLessThan(geometry.copy.x + geometry.copy.width);
      expect(geometry.sigil.width).toBeGreaterThanOrEqual(140);
      await expect(card.locator('.astrid-vision-principle-sigil')).toHaveCSS('opacity', '0.13');
      await expect(card.locator('.astrid-vision-principle-sigil')).toHaveCSS('pointer-events', 'none');
      if (width === 390) {
        expect(await card.locator('.astrid-vision-principle-statement').evaluate(node =>
          node.scrollHeight <= Number.parseFloat(getComputedStyle(node).lineHeight) * 2 + 1)).toBe(true);
      }''')
s += r'''

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

test('two-column mobile pillars animate in reading order as scroll advances and reverses', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const cards = page.locator('.astrid-vision-principles > li');
  await expect(cards).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  // Measure stable layout coordinates, not the card reveal transform.
  const positions = await cards.evaluateAll(nodes => {
    const first = nodes[0] as HTMLElement;
    const top = first.parentElement!.getBoundingClientRect().top + window.scrollY;
    return nodes.map(node => top + (node as HTMLElement).offsetTop - first.offsetTop);
  });
  for (const index of [0, 1, 2, 3, 2, 1, 0]) {
    const target = positions[index] - 844 * (index % 2 === 0 ? .75 : .5);
    await page.evaluate(top => window.scrollTo({ top, behavior: 'instant' }), target);
    await expect.poll(() => cards.evaluateAll(nodes => nodes.flatMap((node, i) => node.hasAttribute('data-play') ? [i] : []))).toEqual([index]);
    await expect(cards.nth(index).locator('.astrid-vision-art-layer').first()).toHaveCSS('animation-play-state', 'running');
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(cards.locator('[data-play]')).toHaveCount(0);
  await expect.poll(() => cards.evaluateAll(nodes => nodes.some(node => node.hasAttribute('data-play')))).toBe(false);
});
'''
p.write_text(s)
p = r/'tests/e2e/public-astrid-vision-sigils-nav.spec.ts'
s = p.read_text().replace('      expect(box.sigil.x).toBeGreaterThanOrEqual(box.text.x + box.text.width - 2);', '''      if (width <= 760) {
        expect(box.sigil.x).toBeLessThan(box.text.x + box.text.width);
        expect(box.sigil.width).toBeGreaterThanOrEqual(140);
      } else expect(box.sigil.x).toBeGreaterThanOrEqual(box.text.x + box.text.width - 2);''')
p.write_text(s)
p = r/'tests/e2e/public-astrid-vision-hierarchy.spec.ts'
s = p.read_text().replace('''      // The sigil stays beside the secondary copy. On mobile the title
      // now deliberately spans both columns; desktop keeps the original layout.
      expect(sigilBounds!.x).toBeGreaterThan(copyBounds!.x + copyBounds!.width - 1);''', '''      // Phone copy now spans the whole card over a quiet background sigil.
      // Desktop keeps its separate reading column and illustration.''')
s = s.replace('        expect(titleBounds!.x + titleBounds!.width).toBeGreaterThanOrEqual(sigilBounds!.x + sigilBounds!.width - 1);', '''        expect(Math.abs(titleBounds!.width - copyBounds!.width)).toBeLessThan(2);
        expect(sigilBounds!.x).toBeLessThan(copyBounds!.x + copyBounds!.width);
        await expect(card.locator('.astrid-vision-principle-sigil')).toHaveCSS('opacity', '0.13');''')
s = s.replace('''      } else {
        expect(sigilBounds!.x).toBeGreaterThan(titleBounds!.x + titleBounds!.width - 1);''', '''      } else {
        expect(sigilBounds!.x).toBeGreaterThan(copyBounds!.x + copyBounds!.width - 1);
        expect(sigilBounds!.x).toBeGreaterThan(titleBounds!.x + titleBounds!.width - 1);''')
p.write_text(s)

from pathlib import Path

def edit(path, old, new):
    p = Path(path)
    text = p.read_text()
    assert text.count(old) == 1, (path, old[:100], text.count(old))
    p.write_text(text.replace(old, new))

base = 'src/pages/Home/'
p = base + 'VisionDialog.tsx'
edit(p, "import { ChevronRight, X }", "import { ChevronLeft, ChevronRight, X }")
edit(p, 'children, onClose, next }: {', 'children, onClose, previous, next }: {')
edit(p, '  next?: { label: string; onClick: () => void };', '  previous?: { label: string; onClick: () => void };\n  next?: { label: string; onClick: () => void };')
edit(p, '  const titleId = useId();', '  const titleId = useId();\n  const releasePageRef = useRef<(() => void) | null>(null);')
edit(p, "  useLayoutEffect(() => {\n    if (dialogRef.current && !dialogRef.current.open) {", """  // Native modality makes the page inert, but does not itself lock scrolling.
  // Freeze its exact visual position on iOS as well as desktop, and restore
  // only the inline properties we own. Next/previous never release this lock.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const scroller = scrollRef.current;
    if (!dialog || !scroller) return;
    const root = document.documentElement;
    const body = document.body;
    const x = window.scrollX, y = window.scrollY;
    const changes: { style: CSSStyleDeclaration; key: string; value: string; priority: string }[] = [];
    const set = (style: CSSStyleDeclaration, key: string, value: string) => {
      changes.push({ style, key, value: style.getPropertyValue(key), priority: style.getPropertyPriority(key) });
      style.setProperty(key, value);
    };
    const gap = window.innerWidth - root.clientWidth;
    const padding = Number.parseFloat(getComputedStyle(body).paddingRight) || 0;
    set(root.style, 'scroll-behavior', 'auto');
    set(root.style, 'overflow', 'hidden');
    set(root.style, 'overscroll-behavior', 'none');
    set(body.style, 'position', 'fixed');
    set(body.style, 'top', -y + 'px');
    set(body.style, 'left', -x + 'px');
    set(body.style, 'width', '100%');
    set(body.style, 'overflow', 'hidden');
    if (gap > 0) set(body.style, 'padding-right', padding + gap + 'px');

    // A gesture starting on the stationary controls or backdrop does nothing.
    // Do not cancel taps, content scrolling, or the user's two-finger zoom.
    const inContent = (target: EventTarget | null) => target instanceof Node && scroller.contains(target);
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !inContent(event.target) && event.cancelable) event.preventDefault();
    };
    const touchmove = (event: TouchEvent) => {
      if (event.touches.length === 1 && !inContent(event.target) && event.cancelable) event.preventDefault();
    };
    dialog.addEventListener('wheel', wheel, { passive: false });
    dialog.addEventListener('touchmove', touchmove, { passive: false });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      dialog.removeEventListener('wheel', wheel);
      dialog.removeEventListener('touchmove', touchmove);
      // Keep instant restoration until the old page position is back in place.
      for (const item of changes.slice(1).reverse()) {
        if (item.value) item.style.setProperty(item.key, item.value, item.priority);
        else item.style.removeProperty(item.key);
      }
      window.scrollTo({ left: x, top: y, behavior: 'instant' });
      const behavior = changes[0];
      if (behavior.value) behavior.style.setProperty(behavior.key, behavior.value, behavior.priority);
      else behavior.style.removeProperty(behavior.key);
    };
    releasePageRef.current = release;
    return () => { release(); releasePageRef.current = null; };
  }, []);

  useLayoutEffect(() => {
    if (dialogRef.current && !dialogRef.current.open) {""")
edit(p, '  useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [identity]);', """  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    const active = document.activeElement;
    // At an endpoint, move keyboard focus off the now-disabled arrow.
    if (active instanceof HTMLButtonElement && active.disabled &&
        active.classList.contains('astrid-vision-details-navigation')) {
      dialogRef.current?.querySelector<HTMLButtonElement>('.astrid-vision-details-navigation:not(:disabled)')?.focus({ preventScroll: true });
    }
  }, [identity]);""")
edit(p, '      data-has-next={Boolean(next) || undefined}\n      onClose={onClose}', """      onClose={() => { releasePageRef.current?.(); onClose(); }}""")
edit(p, """          {next && <button type="button" className="astrid-vision-details-next"
            aria-label={next.label} title={next.label}
            onClick={event => { event.stopPropagation(); next.onClick(); }}>
            <ChevronRight size={24} aria-hidden="true" />
          </button>}""", """          {(previous || next) && <>
            <button type="button" className="astrid-vision-details-navigation astrid-vision-details-previous"
              disabled={!previous} aria-label={previous?.label ?? 'Previous item'} title={previous?.label}
              onClick={event => { event.stopPropagation(); previous?.onClick(); }}>
              <ChevronLeft size={24} aria-hidden="true" />
            </button>
            <button type="button" className="astrid-vision-details-navigation astrid-vision-details-next"
              disabled={!next} aria-label={next?.label ?? 'Next item'} title={next?.label}
              onClick={event => { event.stopPropagation(); next?.onClick(); }}>
              <ChevronRight size={24} aria-hidden="true" />
            </button>
          </>}""")

p = base + 'VisionDetailDialog.tsx'
edit(p, '  const next = siblings[(index + 1) % siblings.length];', '  const previous = siblings[index - 1];\n  const next = siblings[index + 1];')
edit(p, "      next={siblings.length > 1 ? { label: 'Next ' + subject.kind + ': ' + next.title,", """      previous={previous ? { label: 'Previous ' + subject.kind + ': ' + previous.title,
        onClick: () => onSelect({ kind: subject.kind, id: previous.id }) } : undefined}
      next={next ? { label: 'Next ' + subject.kind + ': ' + next.title,""")
edit(p, '        <span className="astrid-vision-details-gap-label">Gap</span>\n', '')
edit(p, '({ aspiration, gaps, hasMeasuredGap })', '({ aspiration, gaps })')
edit(p, """                          {gaps.length > 0 ? (
                            <ul className="astrid-vision-details-aspiration-gaps" aria-label={'Gaps for ' + aspiration.title}>
                              {gaps.map(item => <li key={item.gap.id}><AspirationGap content={content} item={item} /></li>)}
                            </ul>
                          ) : hierarchy.hasAspirationLinks ? (
                            <p className="astrid-vision-details-aspiration-empty">
                              {hasMeasuredGap ? 'No current gaps are measured against this.' : 'No gap is measured against this yet.'}
                            </p>
                          ) : null}""", """                          {gaps.length > 0 && (
                            <div className="astrid-vision-details-gap-group">
                              <h4 className="astrid-vision-details-gap-group-label">{gaps.length === 1 ? 'Gap' : 'Gaps'}</h4>
                              <ul className="astrid-vision-details-aspiration-gaps" aria-label={'Gaps for ' + aspiration.title}>
                                {gaps.map(item => <li key={item.gap.id}><AspirationGap content={content} item={item} /></li>)}
                              </ul>
                            </div>
                          )}""")
edit(p, """              {(!hierarchy.hasAspirationLinks || hierarchy.legacyGaps.length > 0) && (
                <section className="astrid-vision-details-gaps" aria-label="Current gaps and projects">
                  <h3>Gaps preventing this</h3>
                  {hierarchy.legacyGaps.length === 0 ? (
                    <p className="astrid-vision-details-empty">No current gaps are linked to this {subject.kind}.</p>
                  ) : (
                    <ul className="astrid-vision-details-gap-list">""", """              {hierarchy.legacyGaps.length > 0 && (
                <section className="astrid-vision-details-gaps" aria-label="Current gaps and projects">
                  <h3 className="astrid-vision-details-gap-group-label">{hierarchy.legacyGaps.length === 1 ? 'Gap' : 'Gaps'}</h3>
                    <ul className="astrid-vision-details-gap-list">""")
edit(p, 'className="astrid-vision-details-gap-heading astrid-vision-details-gap-heading--labelled"', 'className="astrid-vision-details-gap-heading"')
edit(p, '                            <span className="astrid-vision-details-gap-label">Gap</span>\n', '')
edit(p, '                    </ul>\n                  )}\n                </section>', '                    </ul>\n                </section>')

p = base + 'VisionProjectDisclosure.css'
t = Path(p).read_text()
a = t.index('/* Projects are a distinct disclosure')
rest = t[a:]
Path(p).write_text("""/* Label the relationship once above the group, not inside every gap title. */
.astrid-vision-details-gap-group-label {
  margin: 2px 0 8px 24px;
  color: var(--astrid-muted);
  font: 500 11px/1.5 Inter, ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.astrid-vision-details-gaps > .astrid-vision-details-gap-group-label { margin-left: 0; }
.astrid-vision-details-gap-description > div:last-child { margin-bottom: 0; }
.astrid-vision-details-gap-body > .astrid-vision-details-empty { margin: 0; padding: 14px 18px 16px; }

""" + rest)

p = base + 'VisionMobileLayout.css'
edit(p, '/* Navigation has a dedicated narrow rail, never covering the reading text. */\n.astrid-vision-details[data-has-next] .astrid-vision-details-scroll { padding-right: 64px; }\n.astrid-vision-details-next {', '/* Floating navigation never changes the reading column or its padding. */\n.astrid-vision-details-navigation {')
edit(p, '  position: absolute; right: 8px; top: 50%; transform: translateY(-50%);', '  position: absolute; top: 50%; transform: translateY(-50%);')
edit(p, '  background: var(--astrid-paper); color: var(--astrid-ink); cursor: pointer;\n}', '  background: color-mix(in oklab, var(--astrid-paper) 92%, transparent);\n  color: var(--astrid-ink); cursor: pointer; box-shadow: 0 2px 10px rgba(0, 0, 0, .12);\n}')
edit(p, '.astrid-vision-details-next:hover { color: var(--astrid-accent); border-color: var(--astrid-accent); }\n.astrid-vision-details-next:focus-visible { outline: 2px solid var(--astrid-accent); outline-offset: 2px; }', """.astrid-vision-details-previous { left: 8px; }
.astrid-vision-details-next { right: 8px; }
.astrid-vision-details-navigation:disabled { opacity: .25; cursor: default; }
.astrid-vision-details-navigation:not(:disabled):hover { color: var(--astrid-accent); border-color: var(--astrid-accent); }
.astrid-vision-details-navigation:focus-visible { outline: 2px solid var(--astrid-accent); outline-offset: 2px; }
.astrid-vision-details-scroll { overscroll-behavior: none; }
.astrid-vision-details-header,
.astrid-vision-details-navigation,
.astrid-vision-details::backdrop { touch-action: pinch-zoom; }""")
edit(p, '  .astrid-vision-details[data-has-next] .astrid-vision-details-scroll { padding-right: max(54px, env(safe-area-inset-right)); }\n', '')
edit(p, '  .astrid-vision-details-next { right: 4px; }', '  .astrid-vision-details-next { right: 4px; }\n  .astrid-vision-details-previous { left: 4px; }')

p = base + 'PublicAstridVision.tsx'
edit(p, '    const update = () => setHeaderCondensed(window.scrollY > 72);', """    const update = () => {
      if (!document.querySelector('.astrid-vision-details[open]')) setHeaderCondensed(window.scrollY > 72);
    };""")
edit(p, '      const cards = Array.from(list.children) as HTMLElement[];', """      if (document.querySelector('.astrid-vision-details[open]')) return;
      const cards = Array.from(list.children) as HTMLElement[];""")
edit(p, 'const step = Math.min(row.height / row.indices.length, viewportHeight * .18);', """// Give each card a longer share of scroll travel, rather than
        // switching as soon as two adjacent cards enter the same screen band.
        const step = Math.min(row.height * .6, viewportHeight * .30);""")
edit(p, 'row.top + window.scrollY - viewportHeight * .84', 'row.top + window.scrollY - viewportHeight * .76')

p = 'tests/e2e/public-astrid-vision-aspirations.spec.ts'
t = Path(p).read_text()
a=t.index('  const label = heading.locator('); b=t.index("  await expect(row.locator('.astrid-vision-details-gap-description dt'))",a)
t=t[:a]+"""  await expect(heading.locator('.astrid-vision-details-gap-label')).toHaveCount(0);
  const group = await row.evaluate(node => {
    const group = node.closest('.astrid-vision-details-gap-group, .astrid-vision-details-gaps')!;
    const label = group.querySelector('.astrid-vision-details-gap-group-label')!;
    const first = group.querySelector('.astrid-vision-details-gap')!;
    return { text: label.textContent, count: group.querySelectorAll('.astrid-vision-details-gap').length,
      before: label.getBoundingClientRect().bottom <= first.getBoundingClientRect().top + 1 };
  });
  expect(group.text).toBe(group.count === 1 ? 'Gap' : 'Gaps');
  expect(group.before).toBe(true);
"""+t[b:]
Path(p).write_text(t)
edit(p, "    await expect(gapSummary.locator('.astrid-vision-details-gap-label')).toHaveText('Gap');", "    await expect(aspiration.locator('.astrid-vision-details-gap-group-label')).toHaveText('Gaps');")
edit(p, "    await expect(aspirations.nth(1)).toContainText('No current gaps are measured against this.');\n    await expect(aspirations.nth(2)).toContainText('No gap is measured against this yet.');", """    await expect(dialog.locator('.astrid-vision-details-aspiration-empty')).toHaveCount(0);
    await expect(aspirations.nth(1).locator('.astrid-vision-details-gap-group')).toHaveCount(0);
    await expect(aspirations.nth(2).locator('.astrid-vision-details-gap-group')).toHaveCount(0);""")
edit(p, "    // The label is part of the same gap toggle, including when there are no projects.\n    await gaps.nth(1).locator('.astrid-vision-details-gap-label').click();", "    // Gap summaries remain the full toggle, including when there are no projects.\n    await gaps.nth(1).locator(':scope > summary').click();")
Path(p).write_text(Path(p).read_text()+"""

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
""")

p = 'tests/e2e/public-astrid-vision-mobile-catalogs.spec.ts'
t=Path(p).read_text(); a=t.index('for (const width of [390, 1440]) {\n  test(`next subject cycles'); b=t.index("test('two-column mobile pillars",a)
t=t[:a]+"""for (const width of [390, 1440]) {
  test(`next subject cycles inside one modal with reset content at ${width}px`, async ({ page, request }, info) => {
    // Same regression case, now with the owner's bounded back/forward contract.
    const response = await request.get(FEED);
    expect(response.ok()).toBeTruthy();
    const feed = await response.json() as PublicVisionContent;
    await page.route(FEED, route => route.fulfill({ json: feed }));
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    for (const kind of ['pillar', 'principle'] as const) {
      const subjects = kind === 'pillar' ? feed.pillars : feed.principles;
      const opener = page.getByRole('button', { name: 'Explore ' + subjects[0].title + ': gaps and projects' });
      await opener.focus(); await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await dialog.evaluate(node => node.setAttribute('data-same-modal', 'yes'));
      const scroll = dialog.locator('.astrid-vision-details-scroll');
      const next = dialog.locator('.astrid-vision-details-next');
      const previous = dialog.locator('.astrid-vision-details-previous');
      const initialWidth = await scroll.evaluate(node => node.clientWidth);
      for (let index = 0; index < subjects.length; index++) {
        await expect(dialog).toHaveAccessibleName(subjects[index].title);
        await expect(dialog).toHaveAttribute('data-same-modal', 'yes');
        await expect(dialog.locator('.astrid-vision-details-statement')).toHaveText(subjects[index].statement!);
        await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(0);
        expect(await scroll.evaluate(node => node.clientWidth)).toBe(initialWidth);
        expect(await scroll.evaluate(node => {
          const css = getComputedStyle(node);
          return Math.abs(parseFloat(css.paddingLeft) - parseFloat(css.paddingRight));
        })).toBeLessThan(1);
        if (index === 0) await expect(previous).toBeDisabled();
        else await expect(previous).toHaveAccessibleName('Previous ' + kind + ': ' + subjects[index - 1].title);
        if (index === subjects.length - 1) await expect(next).toBeDisabled();
        else await expect(next).toHaveAccessibleName('Next ' + kind + ': ' + subjects[index + 1].title);
        const frame = (await dialog.locator('.astrid-vision-details-scroll-frame').boundingBox())!;
        for (const arrow of [previous, next]) {
          const box = (await arrow.boundingBox())!;
          expect(Math.abs(box.y + box.height / 2 - frame.y - frame.height / 2)).toBeLessThan(2);
          expect(box.width).toBeGreaterThanOrEqual(44);
          await expect(arrow).toHaveCSS('position', 'absolute');
        }
        // The overlay must not reserve a rail or change the underlying text width.
        const text = (await dialog.locator('.astrid-vision-details-scroll-inner').boundingBox())!;
        expect(text.x).toBeLessThan((await previous.boundingBox())!.x + 44);
        expect(text.x + text.width).toBeGreaterThan((await next.boundingBox())!.x);
        if (index === 1) {
          mkdirSync(folder, { recursive: true });
          await page.screenshot({ path: `${folder}/real-floating-${kind}-${info.project.name}-${width}.png` });
        }
        if (index < subjects.length - 1) {
          await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
          await next.click();
        }
      }
      // Native disabled click cannot wrap the fourth item around to the first.
      await next.evaluate(node => (node as HTMLButtonElement).click());
      await expect(dialog).toHaveAccessibleName(subjects.at(-1)!.title);
      for (let index = subjects.length - 2; index >= 0; index--) {
        await previous.click();
        await expect(dialog).toHaveAccessibleName(subjects[index].title);
        await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(0);
        await expect(dialog).toHaveAttribute('data-same-modal', 'yes');
      }
      await expect(previous).toBeDisabled();
      await previous.evaluate(node => (node as HTMLButtonElement).click());
      await expect(dialog).toHaveAccessibleName(subjects[0].title);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
    }
  });
}

"""+t[b:]
Path(p).write_text(t)
edit(p, "  expect(await sweep('down')).toEqual([0, 1, 2, 3]);\n  expect(await sweep('up')).toEqual([3, 2, 1, 0]);", """  expect(await sweep('down')).toEqual([0, 1, 2, 3]);
  // Each of the first three cards gets a substantial visible scroll interval.
  const down = samples.filter(sample => sample.direction === 'down');
  for (let i = 1; i < down.length; i++) expect(down[i].scrollY - down[i - 1].scrollY).toBeGreaterThan(180);
  expect(end - down[3].scrollY).toBeGreaterThan(100);
  expect(await sweep('up')).toEqual([3, 2, 1, 0]);""")
Path(p).write_text(Path(p).read_text()+"""

for (const width of [390, 1440]) {
  test(`all popup types lock the page and ignore control-bar scrolling at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    const openers = [
      page.locator('.astrid-vision-principles > li').first().getByRole('button'),
      page.locator('.astrid-vision-standards-list > li').first().getByRole('button'),
      page.getByRole('button', { name: 'See all gaps', exact: true }),
      page.getByRole('button', { name: 'See all projects', exact: true }),
    ];
    const records = [];
    for (const [index, opener] of openers.entries()) {
      await opener.scrollIntoViewIfNeeded();
      await opener.focus();
      const before = await page.evaluate(() => ({ x: scrollX, y: scrollY, body: document.body.style.cssText,
        overflow: document.documentElement.style.overflow, behavior: document.documentElement.style.scrollBehavior }));
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      const scroll = dialog.locator('.astrid-vision-details-scroll');
      const header = dialog.locator('.astrid-vision-details-header');
      await expect(dialog).toBeVisible();
      await expect(page.locator('body')).toHaveCSS('position', 'fixed');
      const anchor = await opener.boundingBox();
      const lockedY = await page.evaluate(() => scrollY);
      const h = (await header.boundingBox())!;
      const originalInner = await scroll.evaluate(node => node.scrollTop);
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      for (const delta of [360, -360]) {
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => scrollY)).toBe(lockedY);
        expect(await scroll.evaluate(node => node.scrollTop)).toBe(originalInner);
      }
      // Touch cancellation is checked directly in WebKit as well as Chromium.
      // Synthetic touches do not claim to reproduce physical iPhone momentum.
      const touch = await header.evaluate(node => {
        const one = new Touch({ identifier: 1, target: node, clientX: 100, clientY: 300 });
        const two = new Touch({ identifier: 2, target: node, clientX: 130, clientY: 300 });
        const drag = new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [one] });
        node.dispatchEvent(drag);
        const pinch = new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [one, two] });
        node.dispatchEvent(pinch);
        return { drag: drag.defaultPrevented, pinch: pinch.defaultPrevented };
      });
      expect(touch).toEqual({ drag: true, pinch: false });
      const contentBox = (await scroll.boundingBox())!;
      await page.mouse.move(contentBox.x + contentBox.width / 2, contentBox.y + contentBox.height / 2);
      await page.mouse.wheel(0, 280);
      await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      // No chaining at either end of the actual content scroller.
      for (const bottom of [true, false]) {
        await scroll.evaluate((node, bottom) => { node.scrollTop = bottom ? node.scrollHeight : 0; }, bottom);
        await page.mouse.wheel(0, bottom ? 500 : -500);
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => scrollY)).toBe(lockedY);
      }
      await page.mouse.move(2, 2);
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => scrollY)).toBe(lockedY);
      expect(Math.abs((await opener.boundingBox())!.y - anchor!.y)).toBeLessThan(1);
      records.push({ kind: index, before: before.y, lockedY, touch });
      if (index % 2 === 0) await dialog.getByRole('button', { name: 'Close details' }).click();
      else await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(before.y);
      const after = await page.evaluate(() => ({ body: document.body.style.cssText,
        overflow: document.documentElement.style.overflow, behavior: document.documentElement.style.scrollBehavior }));
      expect(after).toEqual({ body: before.body, overflow: before.overflow, behavior: before.behavior });
      await expect(opener).toBeFocused();
    }
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${folder}/scroll-lock-${info.project.name}-${width}.json`, JSON.stringify(records, null, 2));
    // The ordinary page becomes scrollable again after repeated modal closes.
    await page.mouse.move(width / 2, 100);
    const start = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, -300);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeLessThan(start);
  });
}
""")

print('Applied bounded navigation, floating controls, grouped gaps, extended scroll intervals and shared modal scroll lock.')

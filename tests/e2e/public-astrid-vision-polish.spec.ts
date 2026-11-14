import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { PublicVisionContent } from '../../src/pages/Home/publicVisionContent';
import { visionFixture } from '../fixtures/public-vision';

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';
const folder = 'test-results/vision-captures';

async function pinLive(page: Page) {
  const response = await page.request.get(FEED);
  expect(response.ok()).toBeTruthy();
  const feed = await response.json() as PublicVisionContent;
  await page.route(FEED, route => route.fulfill({ json: feed }));
  return feed;
}

// This also runs against the previous source in the focused baseline reproduction.
// It measures real native-dialog opening; it is not an iPhone toolbar simulation.
test('opening prepares viewport before the native top layer and never double-opens', async ({ page }, info) => {
  const feed = await pinLive(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    type Opening = { prepared: boolean; autofocus: boolean; frames: { y: number; height: number; scroll: number }[] };
    const state = window as typeof window & { __visionOpenings: Opening[] };
    state.__visionOpenings = [];
    const original = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () {
      const record: Opening = {
        prepared: !!this.style.getPropertyValue('--vision-viewport-height') && !!this.style.getPropertyValue('--vision-viewport-top'),
        autofocus: !!this.querySelector('h2[autofocus]'), frames: [],
      };
      state.__visionOpenings.push(record);
      original.call(this);
      const sample = () => {
        if (!this.open) return;
        const b = this.getBoundingClientRect();
        record.frames.push({ y: b.y, height: b.height, scroll: this.querySelector('.astrid-vision-details-scroll')!.scrollTop });
        if (record.frames.length < 12) requestAnimationFrame(sample);
      };
      sample();
    };
  });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  const names = [
    'Explore ' + feed.pillars[0].title + ': gaps and projects',
    'Explore ' + feed.principles[3].title + ': gaps and projects',
    'See all projects', 'See all gaps',
  ];
  for (const [index, name] of [...names, names[0]].entries()) {
    const opener = page.getByRole('button', { name, exact: true });
    await opener.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => window.scrollY);
    await opener.evaluate(node => {
      node.addEventListener('pointerdown', () => {
        (window as typeof window & { __openerScroll?: number }).__openerScroll = window.scrollY;
      }, { once: true, capture: true });
    });
    await opener.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('h2')).toBeFocused();
    await expect.poll(() => page.evaluate(i => {
      const log = (window as typeof window & { __visionOpenings: { frames: unknown[] }[] }).__visionOpenings;
      return log[i]?.frames.length ?? 0;
    }, index)).toBe(12);
    const log = await page.evaluate(() => (window as typeof window & {
      __visionOpenings: { prepared: boolean; autofocus: boolean; frames: { y: number; height: number; scroll: number }[] }[];
    }).__visionOpenings);
    // Keep the frame trace even when a first-paint regression fails below.
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${folder}/opening-frames-${info.project.name}.json`,
      JSON.stringify({ source: feed.source, openings: log }, null, 2));
    expect(log).toHaveLength(index + 1);
    expect(log[index].prepared).toBe(true);
    expect(log[index].autofocus).toBe(true);
    const frames = log[index].frames;
    expect(Math.max(...frames.map(f => f.y)) - Math.min(...frames.map(f => f.y))).toBeLessThan(2);
    expect(Math.max(...frames.map(f => f.height)) - Math.min(...frames.map(f => f.height))).toBeLessThan(2);
    expect(frames.every(f => f.scroll === 0)).toBe(true);
    expect(await dialog.evaluate(node => getComputedStyle(node, '::backdrop').backdropFilter)).toBe('none');
    await dialog.getByRole('button', { name: 'Close details' }).click();
    await expect(dialog).toHaveCount(0);
    writeFileSync(`${folder}/closing-restoration-${info.project.name}-${index}.json`, JSON.stringify({ before, state: await page.evaluate(() => ({ scrollY: window.scrollY, openerScroll: (window as typeof window & { __openerScroll?: number }).__openerScroll, maxScroll: document.documentElement.scrollHeight - window.innerHeight, active: document.activeElement?.outerHTML.slice(0, 300), body: document.body.getAttribute('style') })) }, null, 2));
    // Playwright may scroll again while making the opener actionable. The
    // modal must restore the page position at the actual opening gesture,
    // not the earlier scrollIntoView helper's intermediate position.
    const openedAt = await page.evaluate(() => (window as typeof window & { __openerScroll?: number }).__openerScroll);
    expect(typeof openedAt).toBe('number');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(openedAt!, 0);
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(`${folder}/opening-frames-${info.project.name}.json`, JSON.stringify({ source: feed.source,
    openings: await page.evaluate(() => (window as typeof window & { __visionOpenings: unknown }).__visionOpenings) }, null, 2));
});

for (const width of [390, 1440]) {
  test(`quiet arrows, intro rule and direct project links at ${width}px`, async ({ page }, info) => {
    const feed = await pinLive(page);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Explore ' + feed.pillars[0].title + ': gaps and projects', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await page.mouse.move(0, 0);
    const enabled = dialog.locator('.astrid-vision-details-next');
    const disabled = dialog.locator('.astrid-vision-details-previous');
    await expect(enabled).toBeEnabled();
    await expect(disabled).toBeDisabled();
    await expect(enabled).toHaveCSS('opacity', '0.36');
    await expect(disabled).toHaveCSS('opacity', '0.25');
    await expect(enabled).toHaveCSS('border-top-width', '2px');
    await expect(disabled).toHaveCSS('border-top-width', '1px');
    await expect(enabled.locator('svg')).toHaveCSS('stroke-width', '3px');
    await expect(disabled.locator('svg')).toHaveCSS('stroke-width', '1.5px');
    const intro = dialog.locator('.astrid-vision-details-description');
    await expect(intro).toHaveCSS('border-bottom-width', '1px');
    const introBox = (await intro.boundingBox())!;
    const restBox = (await dialog.locator('.astrid-vision-details-characteristics').boundingBox())!;
    expect(restBox.y - introBox.y - introBox.height).toBeGreaterThanOrEqual(20);
    mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: `${folder}/real-polished-popup-${info.project.name}-${width}.png` });
    await page.keyboard.press('Escape');
    const gap = feed.gaps.find(g => g.assessment !== 'closed' && g.aspiration && g.primaryAppliesTo?.startsWith('pillar:') &&
      feed.projects.some(p => (p.primaryGapId ?? p.gapIds[0]) === g.id))!;
    const pillar = feed.pillars.find(p => 'pillar:' + p.id === gap.primaryAppliesTo)!;
    await page.getByRole('button', { name: 'Explore ' + pillar.title + ': gaps and projects', exact: true }).click();
    const row = dialog.locator(`[data-gap-id="${gap.id}"]`);
    await row.locator(':scope > summary').click();
    const cards = row.locator('.astrid-vision-project');
    expect(await cards.count()).toBeGreaterThan(0);
    await expect(cards.locator('summary, details, .astrid-vision-project-body, .astrid-vision-project-metadata')).toHaveCount(0);
    for (const card of await cards.all()) {
      await expect(card.locator('.astrid-vision-project-title')).not.toBeEmpty();
      await expect(card.locator('.astrid-vision-project-intro')).not.toBeEmpty();
      await expect(card.getByRole('link', { name: /^Read the full project plan:/ })).toBeVisible();
    }
    await expect(dialog.getByText('No current projects linked yet.', { exact: true })).toHaveCount(0);
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${folder}/real-direct-project-links-${info.project.name}-${width}.png` });
    writeFileSync(`${folder}/polish-${info.project.name}-${width}-source.json`, JSON.stringify(feed.source));
  });
}

test('optional aspiration commitments are separately collapsed and empty projects stay silent', async ({ page }, info) => {
  const feed = visionFixture();
  await page.route(FEED, route => route.fulfill({ json: feed }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Explore Artistic ambition: gaps and projects' }).click();
  const dialog = page.getByRole('dialog');
  const aspirations = dialog.locator('.astrid-vision-details-characteristic');
  const first = aspirations.first();
  await expect(first.locator('.astrid-vision-guidance > summary')).toBeHidden();
  await first.locator(':scope > summary').click();
  const guidance = first.locator('.astrid-vision-guidance');
  await expect(guidance).not.toHaveAttribute('open', '');
  await expect(guidance.locator('.astrid-vision-guidance-body')).toBeHidden();
  await guidance.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(guidance.locator('.astrid-vision-guidance-body')).toBeVisible();
  await expect(guidance.locator('strong')).toHaveText(['We should:', 'We should never:']);
  await expect(guidance.locator('ul')).toHaveCount(2);
  await page.keyboard.press('Space');
  await expect(guidance.locator('.astrid-vision-guidance-body')).toBeHidden();
  await expect(first).toHaveAttribute('open', '');
  await expect(aspirations.nth(1).locator('.astrid-vision-guidance')).toHaveCount(0);
  const emptyGap = dialog.locator('[data-gap-id="AA-002"]');
  await emptyGap.locator(':scope > summary').click();
  await expect(emptyGap.locator('.astrid-vision-details-gap-description')).toBeVisible();
  await expect(emptyGap.locator('.astrid-vision-details-projects, .astrid-vision-details-empty')).toHaveCount(0);
  await expect(dialog.getByText('No current projects linked yet.', { exact: true })).toHaveCount(0);
  mkdirSync(folder, { recursive: true });
  await guidance.locator('summary').click();
  await guidance.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${folder}/fixture-optional-guidance-${info.project.name}.png` });
});

test('mobile sigils share full-height alignment and the footer illustration needs no entrance', async ({ page }, info) => {
  const feed = await pinLive(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  const visual = page.locator('.astrid-vision-tinkerer');
  expect(await visual.evaluate(node => {
    for (let current: Element | null = node; current; current = current.parentElement) {
      if (current.hasAttribute('data-reveal') || getComputedStyle(current).opacity !== '1') return false;
    }
    return true;
  })).toBe(true);
  const underline = page.locator('#astrid-vision-title .pixel-underline');
  await expect(underline).toHaveText('artistic potential');
  await expect(underline.locator('svg')).toHaveAttribute('shape-rendering', 'crispEdges');
  await expect(underline.locator('path')).toHaveAttribute('stroke-linecap', 'square');
  await expect(page.locator('#astrid-vision-title')).toHaveText(feed.vision.title);
  await expect(page.locator('#astrid-vision-standards-title')).toHaveText('What guides us');
  await expect(page.locator('#astrid-vision-north-star-title')).toHaveText('What we’re building towards');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const cards = page.locator('.astrid-vision-standards-list > li');
  const layouts = await cards.evaluateAll(nodes => nodes.map(card => {
    const sigil = card.querySelector('.astrid-vision-principle-sigil')!;
    return { card: card.getBoundingClientRect().toJSON(), sigil: sigil.getBoundingClientRect().toJSON() };
  }));
  for (const { card, sigil } of layouts) {
    expect(Math.abs(sigil.y - card.y)).toBeLessThan(2);
    expect(Math.abs(sigil.height - card.height)).toBeLessThan(3);
    expect(Math.abs(card.x + card.width - sigil.x - sigil.width - 9)).toBeLessThan(2);
  }
  expect(Math.max(...layouts.map(x => x.sigil.height)) - Math.min(...layouts.map(x => x.sigil.height))).toBeLessThan(2);
  mkdirSync(folder, { recursive: true });
  await page.locator('.astrid-vision-manifesto').screenshot({ path: `${folder}/real-pixel-hero-${info.project.name}.png` });
  await page.locator('.astrid-vision-standards').screenshot({ path: `${folder}/real-aligned-sigils-${info.project.name}.png` });
  await page.locator('.astrid-vision-contribute').screenshot({ path: `${folder}/real-static-footer-${info.project.name}.png` });
});


for (const width of [390, 1440]) {
  test(`principles retain four translucent colour identities and readable text at ${width}px`, async ({ page }, info) => {
    const feed = await pinLive(page);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    const cards = page.locator('.astrid-vision-standards-list > li');
    await expect(cards).toHaveCount(4);
    await page.evaluate(() => document.fonts.ready);
    mkdirSync(folder, { recursive: true });
    await page.locator('.astrid-vision-standards').screenshot({ path: `${folder}/real-coloured-principles-${info.project.name}-${width}.png` });
    const measurements: unknown[] = [];
    for (const mode of ['light', 'dark'] as const) {
      const paper = mode === 'light' ? '#f7f5ef' : '#0d0e17';
      const ink = mode === 'light' ? '#25241f' : '#f3eee4';
      const dusk = mode === 'light' ? 0 : 1;
      const control = await page.addStyleTag({ content: `main.astrid-vision { --astrid-paper: ${paper} !important; --astrid-ink: ${ink} !important; --astrid-dusk-ink: ${dusk} !important; --astrid-dusk-firm: 0 !important; }` });
      const colours = await cards.evaluateAll((nodes, paper) => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        const rgba = (value: string) => {
          ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
          const data = ctx.getImageData(0, 0, 1, 1).data;
          return [data[0], data[1], data[2], data[3] / 255];
        };
        const over = (fg: number[], bg: number[]) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
        const luminance = (rgb: number[]) => rgb.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
        const contrast = (fg: number[], bg: number[]) => (Math.max(luminance(fg), luminance(bg)) + .05) / (Math.min(luminance(fg), luminance(bg)) + .05);
        return nodes.map(node => {
          const style = getComputedStyle(node);
          const fill = rgba(style.backgroundColor);
          const heading = rgba(getComputedStyle(node.querySelector('h3')!).color);
          const body = rgba(getComputedStyle(node.querySelector('.astrid-vision-principle-statement, .astrid-vision-markdown')!).color);
          const mark = getComputedStyle(node.querySelector('.astrid-vision-principle-sigil')!);
          const sigil = rgba(mark.color); sigil[3] *= Number(mark.opacity);
          const background = over(fill, rgba(paper));
          const markedBackground = over(sigil, background);
          return { fill, heading, body, headingLuminance: luminance(heading), bodyLuminance: luminance(body), headingContrast: contrast(heading, background), bodyContrast: contrast(body, background), bodyOverSigilContrast: contrast(body, markedBackground) };
        });
      }, paper);
      expect(new Set(colours.map(c => JSON.stringify(c.fill))).size).toBe(4);
      expect(new Set(colours.map(c => JSON.stringify(c.heading))).size).toBe(4);
      expect(new Set(colours.map(c => JSON.stringify(c.body))).size).toBe(4);
      for (const c of colours) {
        expect(c.fill[3]).toBeGreaterThan(.04); expect(c.fill[3]).toBeLessThan(.16);
        expect(c.heading[3]).toBe(1); expect(c.body[3]).toBe(1);
        if (mode === 'light') expect(c.headingLuminance).toBeLessThan(c.bodyLuminance);
        else expect(c.headingLuminance).toBeGreaterThan(c.bodyLuminance);
        expect(c.headingContrast).toBeGreaterThanOrEqual(4.5);
        expect(c.bodyContrast).toBeGreaterThanOrEqual(4.5);
        if (width === 390) expect(c.bodyOverSigilContrast).toBeGreaterThanOrEqual(4.5);
      }
      measurements.push({ mode, colours });
      await control.evaluate(node => node.remove());
    }
    await expect(cards.locator('h3')).toHaveText(feed.principles.map(p => p.title));
    await expect(cards.locator('.astrid-vision-principle-statement')).toHaveText(feed.principles.map(p => p.statement!));
    writeFileSync(`${folder}/principle-colours-${info.project.name}-${width}.json`, JSON.stringify({ source: feed.source, measurements }, null, 2));
  });
}


for (const width of [390, 1440]) {
  test(`scrolled Vision returns to the retained main page without moving its snapshot at ${width}px`, async ({ page }, info) => {
    await pinLive(page);
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.addInitScript(() => {
      type Frame = { scroll: number; top: number };
      type Record = { destination?: string; presentation?: string; outgoing: number; snapshot?: Frame; frames: Frame[]; named: string[] };
      const state = window as typeof window & { __roomTransitions: Record[]; __homeTapY?: number };
      state.__roomTransitions = [];
      document.addEventListener('pointerdown', event => {
        if ((event.target as Element)?.closest('.astrid-public-site a[href="/vision"]')) state.__homeTapY = window.scrollY;
      }, true);
      const native = document.startViewTransition?.bind(document);
      if (!native) return;
      document.startViewTransition = ((callback: () => void) => {
        const record: Record = { destination: document.documentElement.dataset.astridPageTransition,
          presentation: document.documentElement.dataset.astridPageTransitionStyle,
          outgoing: window.scrollY, frames: [], named: [] };
        state.__roomTransitions.push(record);
        return native(() => {
          callback();
          const home = document.querySelector<HTMLElement>('.astrid-public-site');
          if (record.destination !== 'home' || !home) return;
          const read = () => ({ scroll: window.scrollY, top: home.getBoundingClientRect().top });
          record.snapshot = read();
          record.named = [home, ...home.querySelectorAll('*')].map(node => getComputedStyle(node).viewTransitionName)
            .filter(name => name && name !== 'none');
          const sample = () => {
            record.frames.push(read());
            if (record.frames.length < 12) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
      }) as typeof document.startViewTransition;
    });
    await page.goto('/home', { waitUntil: 'domcontentloaded' });
    const home = page.locator('.astrid-public-site');
    await expect(home).toBeVisible();
    await home.evaluate(node => node.setAttribute('data-retained-proof', 'same'));
    await page.addStyleTag({ content: 'html { scroll-behavior: smooth !important; }' });
    await page.getByRole('link', { name: 'Vision', exact: true }).first().click();
    await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
    await expect(page.locator('html')).not.toHaveAttribute('data-astrid-page-transition');
    const expectedHomeY = await page.evaluate(() => (window as typeof window & { __homeTapY: number }).__homeTapY);
    expect(Number.isFinite(expectedHomeY)).toBe(true);
    const outgoing = await page.evaluate(() => new Promise<number>(resolve => {
      window.scrollTo({ top: 900, behavior: 'instant' });
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.scrollY)));
    }));
    expect(outgoing).toBeGreaterThan(500);
    await page.getByRole('link', { name: 'Astrid home', exact: true }).click();
    await expect(home).toBeVisible();
    await expect(home).toHaveAttribute('data-retained-proof', 'same');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(expectedHomeY, 0);
    const supported = await page.evaluate(() => typeof document.startViewTransition === 'function');
    if (supported) {
      await expect.poll(() => page.evaluate(() => (window as typeof window & {
        __roomTransitions: { destination?: string; frames: unknown[] }[];
      }).__roomTransitions.filter(r => r.destination === 'home').at(-1)?.frames.length ?? 0)).toBe(12);
      const record = await page.evaluate(() => (window as typeof window & {
        __roomTransitions: { destination?: string; presentation?: string; outgoing: number;
          snapshot: { scroll: number; top: number }; frames: { scroll: number; top: number }[]; named: string[] }[];
      }).__roomTransitions.filter(r => r.destination === 'home').at(-1)!);
      expect(record.presentation).toBe('crossfade');
      expect(record.outgoing).toBeGreaterThan(500);
      expect(record.snapshot.scroll).toBeCloseTo(expectedHomeY, 0);
      expect(record.named).toEqual([]);
      for (const frame of record.frames) {
        expect(frame.scroll).toBeCloseTo(expectedHomeY, 0);
        expect(Math.abs(frame.top - record.snapshot.top)).toBeLessThan(1);
      }
      mkdirSync(folder, { recursive: true });
      writeFileSync(`${folder}/room-transition-${info.project.name}-${width}.json`, JSON.stringify(record, null, 2));
    }
    await expect(page.locator('html')).not.toHaveAttribute('data-astrid-page-transition');
    await expect(page.locator('html')).not.toHaveAttribute('data-astrid-page-transition-style');
    expect(await page.evaluate(() => history.scrollRestoration)).toBe('manual');
    mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: `${folder}/real-main-after-vision-${info.project.name}-${width}.png` });
  });
}

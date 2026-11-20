import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { PublicVisionContent } from '../../src/pages/Home/publicVisionContent';

test.setTimeout(90_000);

const FEED = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';
const folder = 'test-results/vision-captures';
function record(name: string, value: unknown) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(`${folder}/${name}.json`, JSON.stringify(value, null, 2));
}
async function hero(page: Page) {
  return page.locator('.astrid-vision-hero-copy h1').evaluate(node => {
    const style = getComputedStyle(node);
    return { height: (node as HTMLElement).offsetHeight, width: (node as HTMLElement).offsetWidth,
      font: style.font, spacing: style.letterSpacing, text: node.textContent };
  });
}

for (const width of [390, 1440]) {
  test.describe(`header continuity at ${width}px`, () => {
    // A desktop-sized WebKit window should not retain an iPhone's 3x raster
    // and mobile screen. Phone coverage keeps the project's real device profile.
    if (width === 1440) test.use({ isMobile: false, deviceScaleFactor: 1, hasTouch: false });
    test(`opening every popup keeps the header and background stationary at ${width}px`, async ({ page, request }, info) => {
      const response = await request.get(FEED); expect(response.ok()).toBe(true);
      const feed = await response.json() as PublicVisionContent;
      await page.route(FEED, route => route.fulfill({ json: feed }));
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/vision', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.astrid-vision')).toBeVisible({ timeout: 20000 });
      await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
      await page.evaluate(() => document.fonts.ready);
      const trace = [];
      for (const kind of ['pillar', 'principle', 'gaps', 'projects']) {
        const opener = kind === 'pillar' ? page.locator('.astrid-vision-principles > li').last().getByRole('button')
          : kind === 'principle' ? page.locator('.astrid-vision-standards-list > li').last().getByRole('button')
          : page.getByRole('button', { name: 'See all ' + kind, exact: true });
        await opener.scrollIntoViewIfNeeded();
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.evaluate(() => {
          const read = () => {
            const header = document.querySelector<HTMLElement>('.astrid-vision-bar')!;
            const box = header.getBoundingClientRect();
            const main = document.querySelector<HTMLElement>('.astrid-vision')!;
            return { y: box.y, x: box.x, width: box.width, height: box.height,
              opacity: getComputedStyle(header).opacity, visibility: getComputedStyle(header).visibility,
              colour: getComputedStyle(main).backgroundColor,
              condensed: header.hasAttribute('data-condensed') };
          };
          const state = window as unknown as { headerTrace: ReturnType<typeof read>[] };
          document.addEventListener('pointerdown', () => {
            state.headerTrace = [read()];
            let remaining = 24;
            const sample = () => { state.headerTrace.push(read()); if (--remaining) requestAnimationFrame(sample); };
            requestAnimationFrame(sample);
          }, { once: true, capture: true });
        });
        await opener.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toHaveAttribute('data-ready', 'true');
        await expect.poll(() => page.evaluate(() => (window as unknown as { headerTrace: unknown[] }).headerTrace.length), { timeout: 20000 }).toBe(25);
        const samples = await page.evaluate(() => (window as unknown as { headerTrace: { y: number; x: number; width: number; height: number; opacity: string; visibility: string; colour: string; condensed: boolean }[] }).headerTrace);
        trace.push({ kind, samples });
        record(`header-continuity-${info.project.name}-${width}`, { source: feed.source, trace });
        const start = samples[0];
        expect.soft(Math.max(...samples.map(sample => Math.abs(sample.y - start.y))), kind + ' header Y drift').toBeLessThan(1);
        expect.soft(samples.every(sample => sample.visibility === 'visible' && sample.opacity === '1')).toBe(true);
        expect.soft(samples.every(sample => sample.colour === start.colour && sample.condensed === start.condensed)).toBe(true);
        await page.screenshot({ path: `${folder}/header-behind-${kind}-${info.project.name}-${width}.png` });
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(page.locator('[data-vision-header-space]')).toHaveCount(0);
        expect.soft(await page.locator('.astrid-vision-bar').evaluate(node => node.getBoundingClientRect().y)).toBeCloseTo(start.y, 0);
      }
    });
  });
}

test('cold skeleton and loaded hero share layout without restarting a text entrance', async ({ page, request }, info) => {
  const response = await request.get(FEED); expect(response.ok()).toBe(true);
  const feed = await response.json() as PublicVisionContent;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(FEED, async route => { await gate; await route.fulfill({ json: feed }); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('status', { name: "Loading Astrid's vision" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const before = await hero(page);
  release();
  await expect(page.locator('#astrid-vision-title')).toHaveText(feed.vision.title);
  const after = await hero(page);
  const motion = await page.locator('#astrid-vision-title').evaluate(node => node.getAnimations().map(animation => ({ playState: animation.playState, time: animation.currentTime })));
  record(`cold-entry-${info.project.name}`, { source: feed.source, before, after, motion });
  expect.soft(after.height).toBe(before.height);
  expect.soft(after.width).toBe(before.width);
  expect.soft(motion.filter(animation => animation.playState === 'running')).toHaveLength(0);
});

test('Home to Vision joins its pending preload and keeps headline line boxes stable', async ({ page, request }, info) => {
  const response = await request.get(FEED); expect(response.ok()).toBe(true);
  const feed = await response.json() as PublicVisionContent;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route(FEED, async route => { requests++; await gate; await route.fulfill({ json: feed }); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home', { waitUntil: 'domcontentloaded' });
  const link = page.getByRole('link', { name: 'Vision', exact: true });
  await expect(link).toBeVisible();
  await expect.poll(() => requests, { timeout: 20000 }).toBeGreaterThan(0);
  await link.click();
  await expect(page.locator('.astrid-vision')).toBeVisible();
  await page.waitForTimeout(250);
  const requestsBeforeRelease = requests;
  await page.evaluate(() => {
    const state = window as unknown as { arrival: { height: number; width: number; text: string | null }[] };
    state.arrival = [];
    const read = () => {
      const title = document.querySelector<HTMLElement>('#astrid-vision-title');
      if (title) state.arrival.push({ height: title.offsetHeight, width: title.offsetWidth, text: title.textContent });
    };
    const observer = new MutationObserver(read);
    observer.observe(document.querySelector('.astrid-vision-hero-copy')!, { childList: true, attributes: true, subtree: true });
    let count = 0;
    const sample = () => { read(); if (++count < 120) requestAnimationFrame(sample); else observer.disconnect(); };
    requestAnimationFrame(sample);
  });
  release();
  await expect(page.locator('#astrid-vision-title')).toHaveText(feed.vision.title);
  const frames = await page.locator('#astrid-vision-title').evaluate(node => new Promise<{ height: number; width: number; font: string; transform: string; parentWidth: number }[]>(resolve => {
    const samples: { height: number; width: number; font: string; transform: string; parentWidth: number }[] = [];
    const sample = () => {
      const style = getComputedStyle(node);
      samples.push({ height: (node as HTMLElement).offsetHeight, width: (node as HTMLElement).offsetWidth,
        font: style.font, transform: style.transform, parentWidth: node.parentElement!.getBoundingClientRect().width });
      if (samples.length < 72) requestAnimationFrame(sample); else resolve(samples);
    };
    sample();
  }));
  const arrival = await page.evaluate(() => (window as unknown as { arrival: { height: number; width: number; text: string | null }[] }).arrival);
  record(`home-vision-entry-${info.project.name}`, { source: feed.source, requestsBeforeRelease, frames, arrival });
  expect.soft(arrival.length).toBeGreaterThan(0);
  expect.soft(new Set(arrival.map(frame => `${frame.height}/${frame.width}`)).size).toBe(1);
  expect.soft(requestsBeforeRelease).toBe(1);
  expect.soft(new Set(frames.map(frame => `${frame.height}/${frame.width}/${frame.font}`)).size).toBe(1);
  await page.getByRole('link', { name: 'Astrid home', exact: true }).click();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.locator('#astrid-vision-title')).toHaveText(feed.vision.title);
  await expect(page.getByRole('status', { name: "Loading Astrid's vision" })).toHaveCount(0);
});

// Use tablet emulation explicitly rather than resizing a 3x phone context.
test('iPad single-screen Home rejects document overflow and remains fitted', async ({ browser, baseURL, request }, info) => {
  const response = await request.get(FEED); expect(response.ok()).toBe(true);
  const feed = await response.json() as PublicVisionContent;
  const context = await browser.newContext({ baseURL, viewport: { width: 820, height: 1180 },
    screen: { width: 820, height: 1180 }, isMobile: true, hasTouch: true,
    deviceScaleFactor: 1, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.route(FEED, route => route.fulfill({ json: feed }));
    await page.goto('/home', { waitUntil: 'domcontentloaded' });
    const home = page.locator('.astrid-public-site');
    // Cold Vite compilation is not layout readiness. Keep geometry assertions
    // strict, but wait explicitly for the application to mount first.
    await expect(home).toBeVisible({ timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    const samples = [];
    for (const viewport of [{ width: 820, height: 1180 }, { width: 820, height: 1024 },
      { width: 834, height: 1194 }, { width: 768, height: 1024 }, { width: 1024, height: 1366 }]) {
      await page.setViewportSize(viewport);
      for (const audience of ['App', 'Agent']) {
        await home.getByRole('button', { name: audience, exact: true }).click();
        await expect(home).toHaveAttribute('data-audience', audience.toLowerCase());
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).toBe('clip');
        await page.evaluate(() => window.scrollTo({ left: 0, top: 3000, behavior: 'instant' }));
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        const geometry = await home.evaluate(node => ({
          height: innerHeight, y: scrollY, scrollHeight: document.documentElement.scrollHeight,
          bodyHeight: document.body.scrollHeight, home: node.getBoundingClientRect().toJSON(),
          controls: ['.astrid-brand', 'h1', '.astrid-audience-switch', '.astrid-hero-actions'].map(selector => {
            const box = node.querySelector(selector)!.getBoundingClientRect();
            return { selector, top: box.top, bottom: box.bottom, left: box.left, right: box.right };
          }),
        }));
        expect(geometry.scrollHeight).toBeLessThanOrEqual(viewport.height + 1);
        expect(geometry.bodyHeight).toBeLessThanOrEqual(viewport.height + 1);
        expect(geometry.home.y).toBe(0);
        for (const box of geometry.controls) {
          expect(box.top).toBeGreaterThanOrEqual(-1);
          expect(box.bottom).toBeLessThanOrEqual(viewport.height + 1);
          expect(box.left).toBeGreaterThanOrEqual(-1);
          expect(box.right).toBeLessThanOrEqual(viewport.width + 1);
        }
        samples.push({ viewport, audience, ...geometry });
      }
    }
    record(`ipad-home-fit-${info.project.name}`, { source: feed.source, samples });
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.screenshot({ path: `${folder}/ipad-home-fit-${info.project.name}.png` });
  } finally { await context.close(); }
});

test('iPad returns from scrolled Vision at the top without a second adjustment', async ({ browser, baseURL, request }, info) => {
  const response = await request.get(FEED); expect(response.ok()).toBe(true);
  const feed = await response.json() as PublicVisionContent;
  const context = await browser.newContext({ baseURL, viewport: { width: 820, height: 1180 },
    screen: { width: 820, height: 1180 }, isMobile: true, hasTouch: true,
    deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  try {
    const page = await context.newPage();
    await page.route(FEED, route => route.fulfill({ json: feed }));
    await page.goto('/home', { waitUntil: 'domcontentloaded' });
    const home = page.locator('.astrid-public-site');
    await expect(home).toBeVisible({ timeout: 30000 });
    const traces = [];
    for (const height of [1180, 1024, 1180]) {
      await page.setViewportSize({ width: 820, height });
      await home.getByRole('link', { name: 'Vision', exact: true }).click();
      await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).not.toBe('clip');
      await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(899);
      await page.getByRole('link', { name: 'Astrid home', exact: true }).click();
      await expect(page.locator('.astrid-vision')).toHaveCount(0);
      await expect(home).toHaveAttribute('data-astrid-lifecycle', 'active');
      const frames = await page.evaluate(() => new Promise<{ y: number; top: number; overflow: number }[]>(resolve => {
        const samples: { y: number; top: number; overflow: number }[] = [];
        const sample = () => {
          samples.push({ y: scrollY, top: document.querySelector('.astrid-public-site')!.getBoundingClientRect().top,
            overflow: document.documentElement.scrollHeight - innerHeight });
          if (samples.length < 16) requestAnimationFrame(sample); else resolve(samples);
        };
        sample();
      }));
      expect(frames.every(frame => frame.y === 0 && Math.abs(frame.top) < 1 && frame.overflow <= 1)).toBe(true);
      traces.push({ height, frames });
    }
    // A direct Vision entry has no previous Home scroll or retained DOM.
    await page.goto('/vision', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
    await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }));
    await page.getByRole('link', { name: 'Astrid home', exact: true }).click();
    await expect(home).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    record(`ipad-home-return-${info.project.name}`, { source: feed.source, traces });
    await page.screenshot({ path: `${folder}/ipad-home-return-${info.project.name}.png` });
  } finally { await context.close(); }
});

// The previous entry test deliberately held the feed pending. Cover a
// ready preload too, starting before the incoming title is inserted.
async function beginHeadlineTrace(page: Page) {
  await page.evaluate(() => {
    type Sample = { source: string; text: string; width: number; column: number; height: number; wrap: string; lines: string[]; transition: string | null };
    const samples: Sample[] = [];
    let stopped = false;
    let frame = 0;
    const read = (source: string) => {
      const title = document.querySelector<HTMLElement>('.astrid-vision-hero-copy h1');
      if (!title || !title.getBoundingClientRect().width) return;
      const rows: { y: number; words: string[] }[] = [];
      const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        for (const match of (node.textContent ?? '').matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index!);
          range.setEnd(node, match.index! + match[0].length);
          const box = range.getBoundingClientRect();
          if (!box.width) continue;
          let row = rows.find(item => Math.abs(item.y - box.y) < 2);
          if (!row) { row = { y: box.y, words: [] }; rows.push(row); }
          row.words.push(match[0]);
        }
      }
      samples.push({ source, text: title.textContent ?? '', width: title.offsetWidth,
        column: title.closest<HTMLElement>('.astrid-vision-hero-copy')!.clientWidth,
        height: title.offsetHeight, wrap: getComputedStyle(title).getPropertyValue('text-wrap'),
        lines: rows.map(row => row.words.join(' ')),
        transition: document.documentElement.getAttribute('data-astrid-page-transition') });
    };
    const observer = new MutationObserver(() => read('mutation'));
    observer.observe(document.body, { childList: true, subtree: true });
    const tick = () => { if (stopped) return; read('frame'); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    (window as unknown as { finishHeadlineTrace: () => Sample[]; headlineSamples: Sample[] }).headlineSamples = samples;
    (window as unknown as { finishHeadlineTrace: () => Sample[] }).finishHeadlineTrace = () => {
      stopped = true; cancelAnimationFrame(frame); observer.disconnect(); return samples;
    };
  });
}

for (const width of [375, 390, 414]) {
  test(`ready Home entry keeps full-width headline word lines at ${width}px`, async ({ page, request }, info) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width, height: 844 });
    const response = await request.get(FEED); expect(response.ok()).toBe(true);
    const feed = await response.json() as PublicVisionContent;
    await page.route(FEED, route => route.fulfill({ json: feed }));
    const preloaded = page.waitForResponse(FEED);
    await page.goto('/home', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: 'Vision', exact: true })).toBeVisible({ timeout: 30000 });
    await (await preloaded).finished();
    // Let the completed response reach the shared cache, not a pending-feed fixture.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const traces = [];
    for (let trip = 0; trip < 2; trip++) {
      await beginHeadlineTrace(page);
      await page.getByRole('link', { name: 'Vision', exact: true }).click();
      await expect(page.locator('#astrid-vision-title')).toHaveText(feed.vision.title);
      await expect(page.getByRole('status', { name: "Loading Astrid's vision" })).toHaveCount(0);
      await expect.poll(() => page.evaluate(() =>
        (window as unknown as { headlineSamples: { source: string }[] }).headlineSamples.filter(s => s.source === 'frame').length),
        { timeout: 20000 }).toBeGreaterThanOrEqual(72);
      const samples = await page.evaluate(() => (window as unknown as { finishHeadlineTrace: () => {
        source: string; text: string; width: number; column: number; height: number; wrap: string; lines: string[]; transition: string | null;
      }[] }).finishHeadlineTrace());
      traces.push({ trip, samples });
      record(`ready-headline-${info.project.name}-${width}`, { source: feed.source, traces });
      expect.soft(samples.some(sample => sample.source === 'mutation'), 'observe first insertion, not only settled frames').toBe(true);
      expect.soft(samples.every(sample => sample.wrap === 'wrap'), 'never invoke paragraph balancing for this heading').toBe(true);
      expect.soft(samples.every(sample => Math.abs(sample.width - sample.column) <= 1), 'use the whole mobile reading column').toBe(true);
      expect.soft(new Set(samples.map(sample => JSON.stringify(sample.lines))).size, 'word-to-line assignment is invariant from insertion').toBe(1);
      expect.soft(samples.every(sample => sample.text === feed.vision.title)).toBe(true);
      expect.soft(samples.every(sample => sample.lines.join(' ') === feed.vision.title)).toBe(true);
      if (width === 390) await page.screenshot({ path: `${folder}/ready-headline-${info.project.name}-${trip}.png` });
      await page.getByRole('link', { name: 'Astrid home', exact: true }).click();
      await expect(page.locator('.astrid-vision')).toHaveCount(0);
    }
  });
}

test('headline remains normal full-column flow on cold entry, reload and viewport changes', async ({ page, request }, info) => {
  const response = await request.get(FEED); expect(response.ok()).toBe(true);
  const feed = await response.json() as PublicVisionContent;
  await page.route(FEED, route => route.fulfill({ json: feed }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const snapshots = [];
  for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 664 },
    { width: 320, height: 664 }, { width: 414, height: 844 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(page.locator('#astrid-vision-title')).toHaveText(feed.vision.title);
    const before = await hero(page);
    const style = await page.locator('#astrid-vision-title').evaluate(node => ({
      wrap: getComputedStyle(node).getPropertyValue('text-wrap'),
      width: (node as HTMLElement).offsetWidth,
      column: node.closest<HTMLElement>('.astrid-vision-hero-copy')!.clientWidth,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    }));
    expect.soft(style.wrap).toBe('wrap');
    expect.soft(Math.abs(style.width - style.column)).toBeLessThanOrEqual(1);
    expect.soft(style.overflow).toBe(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#astrid-vision-title')).toHaveText(feed.vision.title);
    const after = await hero(page);
    expect.soft(after).toEqual(before);
    snapshots.push({ viewport, before, after, style });
  }
  record(`cold-headline-flow-${info.project.name}`, { source: feed.source, snapshots });
});

// Track the shade itself, not only the panel's settled geometry. The
// previous native-opacity fade reversed in WebKit while every sky pixel
// and page colour stayed unchanged (owner's light/dark flash).
for (const scenario of [
  { width: 390, hour: '10', label: 'phone-day', touch: false },
  { width: 390, hour: '01', label: 'phone-night', touch: false },
  { width: 1440, hour: '10', label: 'desktop-day', touch: false },
  { width: 390, hour: '10', label: 'phone-touch', touch: true },
]) {
  test.describe(`backdrop continuity ${scenario.label}`, () => {
    test.use({ timezoneId: 'Europe/Berlin', ...(scenario.width === 1440
      ? { isMobile: false, deviceScaleFactor: 1, hasTouch: false } : scenario.touch ? { isMobile: true, hasTouch: true } : {}) });
    test('popup shading never reverses or repaints the underlying page', async ({ page, request }, info) => {
      test.setTimeout(150000);
      await page.setViewportSize({ width: scenario.width, height: 844 });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.clock.setFixedTime(new Date(`2026-11-15T${scenario.hour}:00:00Z`));
      const response = await request.get(FEED); expect(response.ok()).toBe(true);
      const feed = await response.json() as PublicVisionContent;
      await page.route(FEED, route => route.fulfill({ json: feed }));
      await page.goto('/vision', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4, { timeout: 30000 });
      await page.evaluate(() => document.fonts.ready);
      await expect.poll(() => page.locator('.astrid-sky canvas').first().evaluate(c => c.style.width)).not.toBe('');
      // Allow the existing initial sky reveal to complete before opening.
      await page.waitForTimeout(2000);
      const results = [];
      for (const kind of ['pillar', 'principle', 'gaps', 'projects', 'pillar']) {
        const opener = kind === 'pillar' ? page.locator('.astrid-vision-principles > li').last().getByRole('button')
          : kind === 'principle' ? page.locator('.astrid-vision-standards-list > li').last().getByRole('button')
          : page.getByRole('button', { name: 'See all ' + kind, exact: true });
        await opener.scrollIntoViewIfNeeded();
        if (!scenario.touch) {
          const bounds = await opener.boundingBox();
          expect(bounds).not.toBeNull();
          await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
        }
        // Scrolling reveals nearby reading text; let that earlier gesture finish
        // before measuring a new opening. Ignore ongoing decorative loops.
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await expect.poll(() => page.evaluate(() => document.querySelector('.astrid-vision')!
          .getAnimations({ subtree: true }).filter(animation =>
            (animation.playState === 'running' || animation.pending) &&
            Number.isFinite(animation.effect?.getComputedTiming().iterations ?? 1)).length),
          { timeout: 10000 }).toBe(0);
        // Finish the preceding scroll/pointer parallax before measuring a new
        // action. A fixed delay can leave subpixel easing in the first frame.
        await page.evaluate(() => new Promise<void>((resolve, reject) => {
          let previous = '', stable = 0, attempts = 0;
          const settle = () => {
            const transforms = JSON.stringify(Array.from(document.querySelectorAll<HTMLCanvasElement>('.astrid-vision .astrid-sky canvas')).map(canvas => {
              let hash = 2166136261;
              for (const pixel of canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data)
                hash = Math.imul(hash ^ pixel, 16777619);
              return [canvas.style.transform, canvas.width, canvas.height, hash >>> 0];
            }));
            stable = transforms === previous ? stable + 1 : 0;
            previous = transforms;
            if (stable >= 4) resolve();
            else if (++attempts >= 240) reject(new Error('Sky parallax did not settle before the opening gesture'));
            else requestAnimationFrame(settle);
          };
          requestAnimationFrame(settle);
        }));
        await page.evaluate(() => {
          type Frame = { t: number; native: number | null; shade: number; surface: number;
            colours: string; headerY: number; sky: string };
          const state = window as unknown as { backdropFrames: Frame[]; backdropInput: string };
          state.backdropFrames = [];
          const read = () => {
            const main = document.querySelector<HTMLElement>('.astrid-vision')!;
            const dialog = main.querySelector<HTMLDialogElement>('dialog');
            const backdrop = dialog?.open ? getComputedStyle(dialog, '::backdrop') : null;
            const rgba = backdrop?.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
            const alpha = rgba.length === 4 ? rgba[3] : rgba.length === 3 ? 1 : 0;
            const shell = dialog?.querySelector('.astrid-vision-details-shell');
            const sky = Array.from(main.querySelectorAll<HTMLCanvasElement>('.astrid-sky canvas')).map(canvas => {
              const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
              let hash = 2166136261;
              for (const pixel of pixels) hash = Math.imul(hash ^ pixel, 16777619);
              const rect = canvas.getBoundingClientRect();
              return [canvas.dataset.layer, hash >>> 0, canvas.width, canvas.height, rect.x, rect.y, canvas.style.transform];
            });
            state.backdropFrames.push({ t: performance.now(),
              native: dialog?.open ? Number(getComputedStyle(dialog).opacity) : null,
              shade: alpha * Number(backdrop?.opacity ?? 0),
              surface: dialog?.open && shell ? Number(getComputedStyle(shell).opacity) : 0,
              colours: [main, document.body, document.documentElement].map(e => getComputedStyle(e).backgroundColor).join('|'),
              headerY: main.querySelector('.astrid-vision-bar')!.getBoundingClientRect().y,
              sky: JSON.stringify(sky) });
          };
          document.addEventListener('pointerdown', event => {
            state.backdropInput = event.pointerType;
            read();
            let count = 0;
            const tick = () => { read(); if (++count < 40) requestAnimationFrame(tick); };
            requestAnimationFrame(tick);
          }, { once: true, capture: true });
        });
        if (scenario.touch) await opener.tap();
        else await opener.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toHaveAttribute('data-ready', 'true');
        await expect.poll(() => page.evaluate(() => (window as unknown as { backdropFrames: unknown[] }).backdropFrames.length), { timeout: 20000 }).toBe(41);
        const frames = await page.evaluate(() => (window as unknown as { backdropFrames: {
          t: number; native: number | null; shade: number; surface: number; colours: string; headerY: number; sky: string;
        }[] }).backdropFrames);
        results.push({ kind, frames });
        const input = await page.evaluate(() => (window as unknown as { backdropInput: string }).backdropInput);
        expect.soft(input).toBe(scenario.touch ? 'touch' : 'mouse');
        record(`backdrop-continuity-${info.project.name}-${scenario.label}`, { source: feed.source, input, results });
        expect.soft(frames.filter(f => f.native !== null).every(f => f.native === 1), 'native dialog opacity is never animated').toBe(true);
        expect.soft(frames.every((f, i) => !i || f.shade + .002 >= frames[i - 1].shade), 'the page never gets lighter during opening').toBe(true);
        expect.soft(frames.every((f, i) => !i || f.surface + .002 >= frames[i - 1].surface), 'the inner surface never fades backwards').toBe(true);
        expect.soft(frames.at(-1)!.shade).toBeCloseTo(.58, 2);
        expect.soft(frames.at(-1)!.surface).toBe(1);
        expect.soft(new Set(frames.map(f => f.colours)).size, 'page palette remains unchanged').toBe(1);
        const skies = frames.map(f => JSON.parse(f.sky) as [string, number, number, number, number, number, string][]);
        expect.soft(new Set(skies.map(layers => JSON.stringify(layers.map(layer => layer.slice(0, 4))))).size,
          'raster bytes and dimensions remain exactly unchanged').toBe(1);
        // Viewport coordinates lose a few binary digits when body scroll is
        // locked; pre-click pointer easing may also advance by <0.001px.
        for (let layer = 0; layer < skies[0].length; layer++) {
          for (const axis of [4, 5]) {
            const values = skies.map(sky => sky[layer][axis] as number);
            expect.soft(Math.max(...values) - Math.min(...values), 'no visible canvas displacement').toBeLessThan(.01);
          }
        }
        const modalTransforms = frames.flatMap((f, i) => f.native === null ? [] :
          [JSON.stringify(skies[i].map(layer => layer[6]))]);
        expect.soft(new Set(modalTransforms).size, 'compositor transforms freeze while open').toBe(1);
        expect.soft(Math.max(...frames.map(f => f.headerY)) - Math.min(...frames.map(f => f.headerY))).toBeLessThan(1);
        if (kind === 'gaps') await page.screenshot({ path: `${folder}/stable-backdrop-${info.project.name}-${scenario.label}.png` });
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
      }
    });
  });
}


test('shared popup reveal respects reduced motion and cancels on early close', async ({ page, request }) => {
  const response = await request.get(FEED); expect(response.ok()).toBe(true);
  const feed = await response.json() as PublicVisionContent;
  await page.route(FEED, route => route.fulfill({ json: feed }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const opener = page.getByRole('button', { name: 'See all gaps', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAttribute('data-ready', 'true');
  expect(await dialog.evaluate(node => node.style.getPropertyValue('--vision-open-progress'))).toBe('1');
  await expect(dialog.locator('.astrid-vision-details-shell')).toHaveCSS('opacity', '1');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // End native modality before its pending geometry/reveal callback runs.
  await page.evaluate(() => {
    const original = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () {
      HTMLDialogElement.prototype.showModal = original;
      original.call(this);
      this.close();
    };
  });
  await opener.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-vision-header-space]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.dataset.astridScrollLockY)).toBeUndefined();
  await opener.click();
  await expect(dialog).toHaveAttribute('data-ready', 'true');
  await expect(dialog.locator('.astrid-vision-details-shell')).toHaveCSS('opacity', '1');
  expect(await dialog.evaluate(node => node.style.getPropertyValue('--vision-open-progress'))).toBe('1');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

// Follow-up feedback: closed capability chips, scrolled brand return, exterior
// navigation and explicit Goals counts. Sample motion, not just its end state.
test.describe('feedback follow-up desktop navigation', () => {
  test.use({ isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  test('scrolled Vision return keeps a visible shared mink without shifting Home', async ({ page, request }, info) => {
    const response = await request.get(FEED); expect(response.ok()).toBe(true);
    const feed = await response.json() as PublicVisionContent;
    await page.route(FEED, route => route.fulfill({ json: feed }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/home', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: 'Vision', exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('link', { name: 'Vision', exact: true }).click();
    await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
    await expect(page.locator('html')).not.toHaveAttribute('data-astrid-page-transition');
    await page.evaluate(() => window.scrollTo({ top: 1000, behavior: 'instant' }));
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      type Native = { ready: Promise<void>; finished: Promise<void> };
      const doc = document as unknown as { startViewTransition: (update: () => void | Promise<void>) => Native };
      const original = doc.startViewTransition.bind(doc);
      const state = window as unknown as { brandTrace: Record<string, unknown> };
      const trace: Record<string, unknown> = { frames: [], done: false };
      state.brandTrace = trace;
      doc.startViewTransition = update => {
        const old = document.querySelector<HTMLElement>('.astrid-vision-brand img')!;
        trace.style = document.documentElement.dataset.astridPageTransitionStyle;
        trace.oldName = getComputedStyle(old).viewTransitionName;
        trace.oldBox = old.getBoundingClientRect().toJSON();
        const transition = original(async () => {
          await update();
          const next = document.querySelector<HTMLElement>('.astrid-public-site[data-astrid-lifecycle="active"] .astrid-brand-mink:not(.astrid-brand-mink-glint)')!;
          trace.newName = getComputedStyle(next).viewTransitionName;
          trace.newBox = next.getBoundingClientRect().toJSON();
        });
        void transition.ready.then(() => {
          trace.ready = true;
          const sample = () => {
            const css = getComputedStyle(document.documentElement, '::view-transition-group(astrid-brand-mink)');
            (trace.frames as unknown[]).push({ scroll: scrollY, transform: css.transform, duration: css.animationDuration,
              homeTop: document.querySelector('.astrid-public-site')!.getBoundingClientRect().top });
            if (!trace.done) requestAnimationFrame(sample);
          };
          sample();
        }, error => { trace.error = String(error); });
        void transition.finished.then(() => { trace.done = true; }, error => { trace.done = true; trace.error = String(error); });
        return transition;
      };
    });
    await page.getByRole('link', { name: 'Astrid home', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { brandTrace: { done: boolean } }).brandTrace.done), { timeout: 15000 }).toBe(true);
    const trace = await page.evaluate(() => (window as unknown as { brandTrace: { style: string; oldName: string; newName: string; ready: boolean; error?: string; oldBox: { y: number; height: number }; newBox: { y: number; height: number }; frames: { scroll: number; homeTop: number; transform: string; duration: string }[] } }).brandTrace);
    record(`feedback-scrolled-brand-${info.project.name}`, trace);
    expect.soft(trace.style).toBe('brand');
    expect.soft(trace.oldName).toBe('astrid-brand-mink');
    expect.soft(trace.newName).toBe('astrid-brand-mink');
    expect.soft(trace.ready).toBe(true);
    expect.soft(trace.error).toBeUndefined();
    expect.soft(trace.oldBox.height).toBeGreaterThan(1);
    expect.soft(trace.newBox.height).toBeGreaterThan(1);
    expect.soft(trace.oldBox.y).toBeGreaterThanOrEqual(0);
    expect.soft(trace.newBox.y).toBeGreaterThanOrEqual(0);
    expect.soft(trace.frames.length).toBeGreaterThan(5);
    expect.soft(new Set(trace.frames.map(frame => frame.transform)).size, 'mink travels through intermediate positions').toBeGreaterThan(3);
    expect.soft(trace.frames.some(frame => frame.duration.split(',').some(value => parseFloat(value) > .5))).toBe(true);
    expect.soft(trace.frames.every(frame => frame.scroll === 0)).toBe(true);
    expect.soft(Math.max(...trace.frames.map(frame => frame.homeTop)) - Math.min(...trace.frames.map(frame => frame.homeTop))).toBeLessThan(1);
    await page.screenshot({ path: `${folder}/feedback-scrolled-home-${info.project.name}.png` });
  });
});

test('feedback follow-up arrows use free gutters and fall back on narrow screens', async ({ page, request }, info) => {
  const response = await request.get(FEED); expect(response.ok()).toBe(true);
  const feed = await response.json() as PublicVisionContent;
  await page.route(FEED, route => route.fulfill({ json: feed }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  await page.locator('.astrid-vision-principles > li').first().getByRole('button').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAttribute('data-ready', 'true');
  const records = [];
  for (const width of [1440, 920, 820, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const beforePaint = await dialog.evaluate(node => ({
      exterior: node.hasAttribute('data-exterior-nav'),
      panel: node.getBoundingClientRect().toJSON(),
      previous: node.querySelector('.astrid-vision-details-previous')!.getBoundingClientRect().toJSON(),
      next: node.querySelector('.astrid-vision-details-next')!.getBoundingClientRect().toJSON(),
    }));
    // Resize/observer delivery belongs to rendering, not a guessed wall-clock
    // interval on a busy 3x WebKit runner. Retain the pre-paint measurements.
    await page.evaluate(() => new Promise<void>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const rects = await dialog.evaluate(node => {
      const rect = (element: Element) => element.getBoundingClientRect().toJSON();
      return { dialog: rect(node), previous: rect(node.querySelector('.astrid-vision-details-previous')!),
        next: rect(node.querySelector('.astrid-vision-details-next')!), exterior: node.hasAttribute('data-exterior-nav'),
        textWidth: node.querySelector('.astrid-vision-details-scroll')!.clientWidth };
    });
    records.push({ width, beforePaint, ...rects });
    const wide = width >= 920;
    expect.soft(rects.exterior).toBe(wide);
    if (wide) {
      expect.soft(rects.previous.right).toBeLessThan(rects.dialog.left - 8);
      expect.soft(rects.next.left).toBeGreaterThan(rects.dialog.right + 8);
    } else {
      expect.soft(rects.previous.left).toBeGreaterThanOrEqual(rects.dialog.left);
      expect.soft(rects.next.right).toBeLessThanOrEqual(rects.dialog.right);
    }
    expect.soft(rects.previous.left).toBeGreaterThanOrEqual(0);
    expect.soft(rects.next.right).toBeLessThanOrEqual(width);
    expect.soft(Math.abs(rects.previous.y - rects.next.y)).toBeLessThan(1);
  }
  record(`feedback-arrow-gutters-${info.project.name}`, records);
  await dialog.locator('.astrid-vision-details-next').click();
  await expect(dialog).toHaveAccessibleName(feed.pillars[1].title);
  await dialog.locator('.astrid-vision-details-previous').click();
  await expect(dialog).toHaveAccessibleName(feed.pillars[0].title);
  await expect(dialog.locator('.astrid-vision-details-previous')).toBeDisabled();
  await page.screenshot({ path: `${folder}/feedback-exterior-arrows-${info.project.name}.png` });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('feedback follow-up every pillar and principle counts Goals and labels the popup', async ({ page, request }, info) => {
  const response = await request.get(FEED); expect(response.ok()).toBe(true);
  const feed = await response.json() as PublicVisionContent;
  await page.route(FEED, route => route.fulfill({ json: feed }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  for (const kind of ['pillar', 'principle'] as const) {
    const entries = kind === 'pillar' ? feed.pillars : feed.principles;
    const cards = page.locator(kind === 'pillar' ? '.astrid-vision-principles > li' : '.astrid-vision-standards-list > li');
    await expect(cards).toHaveCount(entries.length);
    for (const [index, entry] of entries.entries()) {
      const count = entry.goals?.length ?? 0;
      await expect.soft(cards.nth(index).locator('.astrid-vision-subject-counts')).toContainText(`${count} ${count === 1 ? 'goal' : 'goals'}`);
      expect.soft(await cards.nth(index).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    await cards.first().getByRole('button').click();
    const dialog = page.getByRole('dialog');
    await expect.soft(dialog.getByRole('region', { name: 'Goals', exact: true })).toBeVisible();
    await expect.soft(dialog.getByRole('heading', { name: 'Goals', exact: true })).toBeVisible();
    await expect(dialog.locator('.astrid-vision-details-goal')).toHaveCount(entries[0].goals!.length);
    await page.keyboard.press('Escape');
  }
  await page.locator('.astrid-vision-standards-list').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${folder}/feedback-goals-counts-${info.project.name}.png` });
});


test('closing native dialog preserves a subsequent explicit focus handoff', async ({ page, request }, info) => {
  const response = await request.get(FEED); expect(response.ok()).toBe(true);
  const feed = await response.json() as PublicVisionContent;
  await page.route(FEED, route => route.fulfill({ json: feed }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/vision', { waitUntil: 'domcontentloaded' });
  const opener = page.locator('.astrid-vision-principles > li').first().getByRole('button');
  const target = page.locator('.astrid-vision-standards-list > li').first().getByRole('button');
  await expect(target).toBeAttached({ timeout: 30000 });
  await opener.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveAttribute('data-ready', 'true');
  const handoff = await page.evaluate(() => {
    const target = document.querySelector<HTMLButtonElement>('.astrid-vision-standards-list > li button')!;
    const dialog = document.querySelector<HTMLDialogElement>('dialog')!;
    dialog.close();
    target.focus({ preventScroll: true });
    return { focused: document.activeElement === target, open: dialog.open };
  });
  expect(handoff).toEqual({ focused: true, open: false });
  // Wait for React removal, not just the disappearance of native modality.
  await expect(page.locator('dialog.astrid-vision-details')).toHaveCount(0);
  const result = await target.evaluate(node => ({ active: document.activeElement?.getAttribute('aria-label'), intended: node.getAttribute('aria-label'), preserved: document.activeElement === node }));
  record(`focus-handoff-${info.project.name}`, result);
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveAccessibleName(feed.principles[0].title);
});


// The page dimmer must not depend on readiness or the surface animation.
// Capture the native open call, before data-ready or any later RAF.
for (const width of [390, 1440]) {
  test.describe(`steady shade at ${width}px`, () => {
    test.use(width === 1440 ? { isMobile: false, hasTouch: false, deviceScaleFactor: 1 }
      : { isMobile: true, hasTouch: true });
    test('shade is independent of popup readiness and surface progress', async ({ page, request }, info) => {
      test.setTimeout(150000);
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const response = await request.get(FEED); expect(response.ok()).toBe(true);
      const feed = await response.json() as PublicVisionContent;
      await page.route(FEED, route => route.fulfill({ json: feed }));
      await page.goto('/vision', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4, { timeout: 30000 });
      const records = [];
      for (const [index, kind] of ['pillar', 'principle', 'gaps', 'projects', 'pillar'].entries()) {
        const opener = kind === 'pillar' ? page.locator('.astrid-vision-principles > li').first().getByRole('button')
          : kind === 'principle' ? page.locator('.astrid-vision-standards-list > li').first().getByRole('button')
          : page.getByRole('button', { name: 'See all ' + kind, exact: true });
        await opener.scrollIntoViewIfNeeded();
        await page.evaluate(() => {
          const original = HTMLDialogElement.prototype.showModal;
          const state = window as unknown as { steadyShade: { first?: Record<string, unknown>; frames: Record<string, unknown>[]; done: boolean } };
          state.steadyShade = { frames: [], done: false };
          HTMLDialogElement.prototype.showModal = function () {
            HTMLDialogElement.prototype.showModal = original;
            original.call(this);
            const read = () => {
              const shade = getComputedStyle(this, '::backdrop');
              return { ready: this.dataset.ready ?? null, progress: this.style.getPropertyValue('--vision-open-progress'),
                shade: shade.backgroundColor, opacity: shade.opacity, transition: shade.transitionDuration,
                animation: shade.animationName, native: getComputedStyle(this).opacity,
                surface: getComputedStyle(this.querySelector('.astrid-vision-details-shell')!).opacity };
            };
            state.steadyShade.first = read();
            let count = 0;
            const tick = () => {
              if (!this.open) { state.steadyShade.done = true; return; }
              state.steadyShade.frames.push(read());
              if (++count < 40) requestAnimationFrame(tick);
              else state.steadyShade.done = true;
            };
            requestAnimationFrame(tick);
          };
        });
        if (width === 390) await opener.tap(); else await opener.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toHaveAttribute('data-ready', 'true');
        await expect.poll(() => page.evaluate(() => (window as unknown as { steadyShade: { done: boolean } }).steadyShade.done), { timeout: 30000 }).toBe(true);
        const trace = await page.evaluate(() => (window as unknown as { steadyShade: { first: { ready: string | null; progress: string; shade: string; surface: string }; frames: { shade: string; opacity: string; native: string; transition: string; animation: string; surface: string }[] } }).steadyShade);
        records.push({ kind, trace });
        record(`steady-shade-${info.project.name}-${width}`, { source: feed.source, records });
        expect.soft(trace.first.ready, 'measure before panel readiness').toBeNull();
        expect.soft(trace.first.progress).toBe('0');
        expect.soft(trace.first.shade, 'native dimmer is already complete at showModal').toBe('rgba(22, 20, 18, 0.58)');
        expect.soft(trace.frames).toHaveLength(40);
        for (const frame of trace.frames) {
          expect.soft(frame.shade).toBe('rgba(22, 20, 18, 0.58)');
          expect.soft(frame.opacity).toBe('1');
          expect.soft(frame.native).toBe('1');
          expect.soft(frame.animation).toBe('none');
          expect.soft(frame.transition).toBe('0s');
        }
        expect.soft(trace.first.surface, 'the panel still has its own reveal').toBe('0');
        await expect(dialog.locator('.astrid-vision-details-shell')).toHaveCSS('opacity', '1');
        if (index === 0) {
          // Compare actual painted backdrop pixels, not just computed styles.
          // The top-left gutter is outside the surface at both widths.
          // Isolate the native dimmer from the intentional foreground/shadow fade.
await dialog.locator('.astrid-vision-details-shell').evaluate(node => (node as HTMLElement).style.opacity = '1');
const reference = await page.screenshot({ clip: { x: 0, y: 0, width: 8, height: 8 }, scale: 'css' });
          const painted = [];
          for (const state of [{ ready: false, progress: '0' }, { ready: true, progress: '0.5' }, { ready: true, progress: '1' }]) {
            await dialog.evaluate((node, state) => {
              if (state.ready) node.setAttribute('data-ready', 'true'); else node.removeAttribute('data-ready');
              (node as HTMLElement).style.setProperty('--vision-open-progress', state.progress);
            }, state);
            const pixels = await page.screenshot({ clip: { x: 0, y: 0, width: 8, height: 8 }, scale: 'css' });
            const unchanged = pixels.equals(reference);
            painted.push({ ...state, unchanged });
            expect.soft(unchanged, 'surface readiness/progress cannot change painted dimmer pixels').toBe(true);
          }
          record(`steady-shade-pixels-${info.project.name}-${width}`, painted);
await dialog.locator('.astrid-vision-details-shell').evaluate(node => (node as HTMLElement).style.removeProperty('opacity'));
          await page.screenshot({ path: `${folder}/steady-shade-${info.project.name}-${width}.png` });
        }
        await page.keyboard.press('Escape');
        await expect(page.locator('dialog.astrid-vision-details')).toHaveCount(0);
      }
    });
  });
}


type BrandFollowFrame = { minkY: number; wordY: number; minkTransform: string; wordTransform: string;
  minkDuration: string; wordDuration: string; minkCurve: string; wordCurve: string; wordOpacity: number; scroll: number };
type BrandFollowBox = { x: number; y: number; width: number; height: number; right: number };
type BrandFollowTrace = { ready: boolean; done: boolean; error?: string; frames: BrandFollowFrame[];
  old?: { name: string; opacity: string; box: BrandFollowBox; mink: BrandFollowBox; headerWidth: number };
  incoming?: { names: string[]; word: BrandFollowBox; mink: BrandFollowBox } };
test.describe('paired scrolled desktop brand', () => {
  test.use({ isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  test('wordmark accompanies the mink from the condensed Vision header', async ({ page, request }, info) => {
    test.setTimeout(120000);
    const response = await request.get(FEED); expect(response.ok()).toBe(true);
    const feed = await response.json();
    await page.route(FEED, route => route.fulfill({ json: feed }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/home', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: 'Vision', exact: true })).toBeVisible({ timeout: 30000 });
    const records = [];
    for (const fraction of [1, .5]) {
      await page.getByRole('link', { name: 'Vision', exact: true }).click();
      await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
      await expect(page.locator('html')).not.toHaveAttribute('data-astrid-page-transition');
      await page.evaluate(fraction => window.scrollTo({ top: (document.documentElement.scrollHeight - innerHeight) * fraction,
        behavior: 'instant' }), fraction);
      const header = page.locator('.astrid-vision-bar');
      await expect(header).toHaveAttribute('data-condensed');
      await expect(header.locator('.astrid-vision-brand-name')).toHaveCSS('opacity', '0');
      await expect(header.locator('.astrid-vision-brand-name')).toHaveCSS('max-width', '0px');
      const before = await header.locator('.astrid-vision-brand').evaluate(node => ({
        width: node.getBoundingClientRect().width,
        mink: node.querySelector('img')!.getBoundingClientRect().toJSON(),
      }));
      await page.evaluate(() => {
        const state = window as unknown as { brandFollow: BrandFollowTrace };
        const trace: BrandFollowTrace = { ready: false, done: false, frames: [] };
        state.brandFollow = trace;
        type Native = { ready: Promise<void>; finished: Promise<void> };
        const doc = document as unknown as { startViewTransition: (update: () => void | Promise<void>) => Native };
        const original = doc.startViewTransition.bind(doc);
        doc.startViewTransition = update => {
          doc.startViewTransition = original;
          const name = document.querySelector<HTMLElement>('.astrid-vision-brand-name')!;
          const mink = document.querySelector<HTMLElement>('.astrid-vision-brand img')!;
          trace.old = { name: getComputedStyle(name).viewTransitionName, opacity: getComputedStyle(name).opacity,
            box: name.getBoundingClientRect().toJSON(), mink: mink.getBoundingClientRect().toJSON(),
            headerWidth: name.parentElement!.getBoundingClientRect().width };
          const transition = original(async () => {
            await update();
            const home = document.querySelector('.astrid-public-site[data-astrid-lifecycle="active"]')!;
            trace.incoming = {
              names: [home, ...home.querySelectorAll('*')].map(n => getComputedStyle(n).viewTransitionName)
                .filter(n => n && n !== 'none'),
              word: home.querySelector('.astrid-brand-name')!.getBoundingClientRect().toJSON(),
              mink: home.querySelector('.astrid-brand-mink:not(.astrid-brand-mink-glint)')!.getBoundingClientRect().toJSON(),
            };
          });
          void transition.ready.then(() => {
            trace.ready = true;
            const sample = () => {
              if (trace.done) return;
              const root = document.documentElement;
              const mink = getComputedStyle(root, '::view-transition-group(astrid-brand-mink)');
              const word = getComputedStyle(root, '::view-transition-group(astrid-brand-name)');
              const image = getComputedStyle(root, '::view-transition-new(astrid-brand-name)');
              trace.frames.push({ minkY: new DOMMatrix(mink.transform).f, wordY: new DOMMatrix(word.transform).f,
                minkTransform: mink.transform, wordTransform: word.transform,
                minkDuration: mink.animationDuration, wordDuration: word.animationDuration,
                minkCurve: mink.animationTimingFunction, wordCurve: word.animationTimingFunction,
                wordOpacity: Number(image.opacity), scroll: scrollY });
              requestAnimationFrame(sample);
            };
            sample();
          }, error => { trace.error = String(error); });
          void transition.finished.then(() => { trace.done = true; }, error => {
            trace.error = String(error); trace.done = true;
          });
          return transition;
        };
      });
      await page.getByRole('link', { name: 'Astrid home', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { brandFollow: BrandFollowTrace }).brandFollow.ready)).toBe(true);
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${folder}/wordmark-moving-${info.project.name}-${fraction}.png` });
      await expect.poll(() => page.evaluate(() => (window as unknown as { brandFollow: BrandFollowTrace }).brandFollow.done), { timeout: 15000 }).toBe(true);
      const trace = await page.evaluate(() => (window as unknown as { brandFollow: BrandFollowTrace }).brandFollow);
      records.push({ fraction, before, trace });
      record(`wordmark-follow-${info.project.name}`, records);
      expect(trace.error).toBeUndefined();
      expect(trace.old!.name, 'the hidden wordmark needs an outgoing capture origin').toBe('astrid-brand-name');
      expect(trace.incoming!.names).toEqual(['astrid-brand-mink', 'astrid-brand-name']);
      expect(trace.old!.opacity, 'do not flash the collapsed header text before the transition').toBe('0');
      expect(trace.old!.box.width, 'avoid a zero-width wordmark morph').toBeGreaterThan(30);
      expect(Math.abs(trace.old!.headerWidth - before.width), 'no header expansion at capture').toBeLessThan(.5);
      for (const axis of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(trace.old!.mink[axis] - before.mink[axis])).toBeLessThan(.5);
      expect(Math.abs(trace.old!.box.x - trace.old!.mink.right), 'wordmark starts beside the current mink').toBeLessThan(24);
      const frames = trace.frames.filter(f => f.minkTransform !== 'none' && f.wordTransform !== 'none'
        && f.minkDuration === '0.9s' && f.wordDuration === '0.9s');
      expect(frames.length).toBeGreaterThan(5);
      expect(new Set(frames.map(f => f.wordTransform)).size).toBeGreaterThan(4);
      const first = frames[0], last = frames.at(-1)!;
      expect(Math.abs(last.wordY - first.wordY)).toBeGreaterThan(30);
      expect(Math.abs(first.wordY - trace.old!.box.y)).toBeLessThan(5);
      expect(Math.abs(last.wordY - trace.incoming!.word.y)).toBeLessThan(2);
      for (const frame of frames) {
        expect(frame.scroll).toBe(0);
        expect(frame.wordCurve).toBe(frame.minkCurve);
        const minkProgress = (frame.minkY - first.minkY) / (last.minkY - first.minkY);
        const wordProgress = (frame.wordY - first.wordY) / (last.wordY - first.wordY);
        expect(Math.abs(wordProgress - minkProgress), 'wordmark and mink travel together').toBeLessThan(.04);
      }
      expect(frames.some(f => f.wordOpacity > .99)).toBe(true);
      await expect(page.locator('html')).not.toHaveAttribute('data-astrid-page-transition');
      await expect(page.locator('html')).not.toHaveAttribute('data-astrid-page-transition-style');
    }
  });
});

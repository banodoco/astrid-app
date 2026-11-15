import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

// Exercise the production Home and original decoded media. Apple WebKit owns
// this gate because Linux WebKitGTK currently cannot decode the source's colour
// metadata (astrid-dev#668); do not bypass the real readiness gate.
const folder = 'test-results/vision-captures';
function record(name: string, value: unknown) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(`${folder}/${name}.json`, JSON.stringify(value, null, 2));
}

test.describe('feedback follow-up mobile capability cards', () => {
  test.use({ isMobile: true, hasTouch: true });
  test('other chips do not inherit an open disclosure during App Agent switches', async ({ page }, info) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => errors.push(request.url() + ': ' + request.failure()?.errorText));
    await page.goto('/home', { waitUntil: 'domcontentloaded' });
    try {
      await expect(page.locator('.astrid-callouts > article')).toHaveCount(3, { timeout: 60000 });
    } catch (error) {
      const readiness = await page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>('.astrid-editor-stage');
        return { stage: stage?.outerHTML, phase: stage?.dataset, text: document.body.innerText,
          visibility: document.visibilityState,
          videos: Array.from(document.querySelectorAll('video')).map(video => ({
            src: video.currentSrc, ready: video.readyState, network: video.networkState,
            error: video.error?.message, width: video.videoWidth, height: video.videoHeight,
          })) };
      });
      record(`feedback-home-readiness-${info.project.name}`, { errors, readiness });
      await page.screenshot({ path: `${folder}/feedback-home-not-ready-${info.project.name}.png` });
      throw error;
    }
    const pairs = [['effects', 'community'], ['timeline', 'workflows'], ['models', 'tools']];
    const records = [];
    for (const direction of [0, 1]) {
      const from = direction === 0 ? 'app' : 'agent';
      const to = direction === 0 ? 'agent' : 'app';
      for (const pair of pairs) {
        await page.locator(`.astrid-audience-switch button[data-audience="${from}"]`).tap();
        await expect(page.locator('.astrid-public-site')).toHaveAttribute('data-audience', from);
        await page.waitForTimeout(1300);
        const chip = page.locator(`article[data-callout="${pair[direction]}"]`);
        await chip.locator('.astrid-callout-toggle').tap();
        await expect(chip).toHaveAttribute('data-open', 'true');
        await page.waitForTimeout(300);
        await page.evaluate(() => {
          const w = window as unknown as { chipTrace: { mode: string; cards: { id: string; height: number; body: number; expanded: string | null }[] }[]; chipTraceDone: boolean };
          w.chipTrace = []; w.chipTraceDone = false;
          const read = () => ({ mode: document.querySelector<HTMLElement>('.astrid-public-site')!.dataset.audience!,
            cards: Array.from(document.querySelectorAll<HTMLElement>('.astrid-callouts > article')).map(card => ({
              id: card.dataset.callout!, height: card.getBoundingClientRect().height,
              body: card.querySelector<HTMLElement>(':scope > .astrid-callout-content .astrid-callout-body')!.getBoundingClientRect().height,
              expanded: card.querySelector('.astrid-callout-toggle')!.getAttribute('aria-expanded'),
            })) });
          document.addEventListener('pointerdown', () => {
            const started = performance.now();
            const sample = () => {
              w.chipTrace.push(read());
              if (performance.now() - started < 1400) requestAnimationFrame(sample);
              else w.chipTraceDone = true;
            };
            sample();
          }, { capture: true, once: true });
        });
        await page.locator(`.astrid-audience-switch button[data-audience="${to}"]`).tap();
        await expect.poll(() => page.evaluate(() => (window as unknown as { chipTraceDone: boolean }).chipTraceDone), { timeout: 15000 }).toBe(true);
        const frames = await page.evaluate(() => (window as unknown as { chipTrace: { mode: string; cards: { id: string; height: number; body: number; expanded: string | null }[] }[] }).chipTrace);
        const incoming = frames.filter(frame => frame.mode === to);
        records.push({ from, to, opened: pair[direction], frames });
        record(`feedback-chip-switch-${info.project.name}`, records);
        expect.soft(incoming.length).toBeGreaterThan(10);
        expect.soft(incoming.every(frame => frame.cards.every(card => card.expanded === 'false')), 'incoming subjects start closed').toBe(true);
        expect.soft(Math.max(...incoming.flatMap(frame => frame.cards.map(card => card.body))), 'no incoming disclosure inherits a closing grid transition').toBeLessThan(1);
        for (const card of incoming.at(-1)!.cards) {
          if (card.id === pair[1 - direction]) continue;
          const heights = incoming.flatMap(frame => frame.cards.filter(item => item.id === card.id).map(item => item.height));
          expect.soft(Math.max(...heights), `unrelated ${card.id} must not balloon`).toBeLessThanOrEqual(card.height + 1);
        }
      }
    }
    await page.screenshot({ path: `${folder}/feedback-home-chips-${info.project.name}.png` });
    await page.locator('.astrid-audience-switch button[data-audience="app"]').tap();
    await page.waitForTimeout(1000);
    await page.locator('article[data-callout="effects"] .astrid-callout-toggle').tap();
    await page.waitForTimeout(300);
    await page.locator('.astrid-audience-switch button[data-audience="agent"]').tap();
    await page.waitForTimeout(70);
    await page.locator('.astrid-audience-switch button[data-audience="app"]').tap();
    await page.waitForTimeout(1100);
    await expect(page.locator('.astrid-callouts > article[data-open="true"]')).toHaveCount(0);
    expect(await page.locator('.astrid-callout-content .astrid-callout-body').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height < 1))).toBe(true);
  });
});

// Removing a view-transition name must not change the scene's 3D projection.
// These use original decoded Home media, both audiences, actual pointer input,
// and real scrolled Vision -> Home navigation rather than a mocked editor.
type PlayerProjection = { rect: number[]; tilt: string; name: string; scroll: number; phase: string | null };
async function stablePlayerProjection(page: import('@playwright/test').Page): Promise<PlayerProjection> {
  return page.locator('.astrid-player-surface').evaluate(async node => {
    const tilt = document.querySelector<HTMLElement>('.astrid-editor-tilt')!;
    const read = () => {
      const r = node.getBoundingClientRect();
      return { rect: [r.x, r.y, r.width, r.height], tilt: tilt.style.transform,
        name: getComputedStyle(tilt).viewTransitionName, scroll: scrollY,
        phase: document.documentElement.getAttribute('data-astrid-page-transition-style') };
    };
    let prior = read(), stable = 0;
    for (let n = 0; n < 300; n++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const next = read();
      stable = next.rect.every((v, i) => Math.abs(v - prior.rect[i]) < .02) && next.tilt === prior.tilt ? stable + 1 : 0;
      prior = next;
      if (stable >= 12) return next;
    }
    throw new Error('Player did not reach stable geometry');
  });
}
test.describe('desktop player projection', () => {
  test.use({ isMobile: false, hasTouch: false, deviceScaleFactor: 1, viewport: { width: 1440, height: 900 } });
  for (const audience of ['app', 'agent']) {
    test(`player projection stays steady on scrolled ${audience} return`, async ({ page, request }, info) => {
      test.setTimeout(180000);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const feedUrl = 'https://raw.githubusercontent.com/banodoco/astrid-dev/vision-published/vision.json';
      const response = await request.get(feedUrl);
      expect(response.ok()).toBe(true);
      const feed = await response.json();
      await page.route(feedUrl, route => route.fulfill({ json: feed }));
      await page.goto('/home', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.astrid-callouts > article')).toHaveCount(3, { timeout: 60000 });
      await expect(page.locator('.astrid-editor-stage')).toHaveAttribute('data-revealed', 'true');
      if (audience === 'agent') await page.locator('.astrid-audience-switch button[data-audience="agent"]').click();
      await expect(page.locator('.astrid-public-site')).toHaveAttribute('data-audience', audience);
      await page.mouse.move(0, 0);
      await page.evaluate(() => document.fonts.ready);
      // Let the existing entrance/audience choreography finish, then verify actual stability.
      await page.waitForTimeout(1800);
      const neutral = await stablePlayerProjection(page);
      const records: unknown[] = [];
      const save = () => record(`player-projection-${info.project.name}-${audience}`, { source: feed.source, records });
      for (const hovered of [false, true]) {
        if (hovered) {
          const stage = await page.locator('.astrid-editor-stage').boundingBox();
          expect(stage).not.toBeNull();
          await page.mouse.move(stage!.x + stage!.width * .72, stage!.y + stage!.height * .77);
        }
        const before = await stablePlayerProjection(page);
        if (hovered) expect(before.tilt, 'ordinary pointer parallax remains available').not.toBe(neutral.tilt);
        for (const mode of ['brand', 'crossfade']) {
          await page.evaluate(mode => {
            document.documentElement.dataset.astridPageTransition = 'home';
            document.documentElement.dataset.astridPageTransitionStyle = mode;
          }, mode);
          const during = await stablePlayerProjection(page);
          await page.evaluate(() => {
            delete document.documentElement.dataset.astridPageTransition;
            delete document.documentElement.dataset.astridPageTransitionStyle;
          });
          const after = await stablePlayerProjection(page);
          records.push({ kind: 'snapshot-name-boundary', hovered, mode, before, during, after }); save();
          expect.soft(during.tilt, 'naming must not alter the pointer pose').toBe(before.tilt);
          for (const sample of [during, after]) for (const [i, value] of sample.rect.entries()) {
            expect.soft(Math.abs(value - before.rect[i]), `projection changed ${audience}/${mode}/hover=${hovered}/axis=${i}`).toBeLessThan(.75);
          }
        }
      }
      await page.mouse.move(0, 0);
      const reference = await stablePlayerProjection(page);
      for (const fraction of [1, .5]) {
        await page.getByRole('link', { name: 'Vision', exact: true }).click();
        await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);
        await expect(page.locator('html')).not.toHaveAttribute('data-astrid-page-transition');
        await page.evaluate(fraction => window.scrollTo({ top: (document.documentElement.scrollHeight - innerHeight) * fraction, behavior: 'instant' }), fraction);
        await page.waitForTimeout(350);
        expect(await page.evaluate(() => scrollY)).toBeGreaterThan(500);
        await page.evaluate(() => {
          const state = window as unknown as { playerReturn: { frames: (PlayerProjection & { source: string })[]; done: boolean } };
          const trace = state.playerReturn = { frames: [], done: false };
          let finishedFrames = 0, frame = 0;
          const read = (source: string) => {
            const home = document.querySelector('.astrid-public-site[data-astrid-lifecycle="active"]');
            if (!home) return;
            const player = home.querySelector('.astrid-player-surface')!;
            const tilt = home.querySelector<HTMLElement>('.astrid-editor-tilt')!;
            const r = player.getBoundingClientRect();
            trace.frames.push({ source, rect: [r.x, r.y, r.width, r.height], tilt: tilt.style.transform,
              name: getComputedStyle(tilt).viewTransitionName, scroll: scrollY,
              phase: document.documentElement.getAttribute('data-astrid-page-transition-style') });
          };
          const observer = new MutationObserver(() => read('mutation'));
          observer.observe(document.documentElement, { attributes: true, subtree: true,
            attributeFilter: ['data-astrid-page-transition', 'data-astrid-page-transition-style', 'data-astrid-lifecycle'] });
          const start = performance.now();
          const tick = () => {
            read('frame');
            if (trace.frames.length && !document.documentElement.hasAttribute('data-astrid-page-transition')) finishedFrames++;
            if (finishedFrames >= 8 || performance.now() - start > 12000) {
              observer.disconnect(); cancelAnimationFrame(frame); trace.done = true; return;
            }
            frame = requestAnimationFrame(tick);
          };
          frame = requestAnimationFrame(tick);
        });
        await page.getByRole('link', { name: 'Astrid home', exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { playerReturn: { done: boolean } }).playerReturn.done), { timeout: 20000 }).toBe(true);
        const trace = await page.evaluate(() => (window as unknown as { playerReturn: { frames: (PlayerProjection & { source: string })[]; done: boolean } }).playerReturn);
        const settled = await stablePlayerProjection(page);
        records.push({ kind: 'real-return', fraction, reference, settled, trace }); save();
        expect.soft(trace.frames.filter(s => s.phase === 'brand').length, 'sample the actual scrolled transition').toBeGreaterThan(5);
        expect.soft(trace.frames.some(s => s.phase === null), 'include the final layer-name restoration').toBe(true);
        for (const sample of [...trace.frames, settled]) {
          expect.soft(sample.scroll).toBe(0);
          for (const [i, value] of sample.rect.entries()) {
            expect.soft(Math.abs(value - reference.rect[i]), `projection changed on ${audience} actual return fraction=${fraction}/axis=${i}`).toBeLessThan(.75);
          }
        }
        await page.screenshot({ path: `${folder}/player-return-${info.project.name}-${audience}-${fraction}.png` });
      }
    });
  }
});

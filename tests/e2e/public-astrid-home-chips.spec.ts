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


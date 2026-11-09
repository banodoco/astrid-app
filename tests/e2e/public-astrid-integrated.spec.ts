import { expect, test, type Page, type TestInfo } from '@playwright/test';

async function surface(page: Page, name: 'home' | 'vision') {
  await expect(page.locator(name === 'home' ? 'main.astrid-public-site' : 'main.astrid-vision')).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-astrid-page-transition');
}

async function hours(page: Page, value: number) {
  const whole = Math.floor(value);
  await page.clock.setFixedTime(new Date(2026, 9, 20, whole, (value - whole) * 60));
}

async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: false });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const counters = { homeRects: 0, visionRects: 0, homeRanges: 0, visionRanges: 0, retainedReads: 0, skyWrites: {} as Record<string, number>, skyAllocations: 0, rootPaperWrites: 0 };
    const classify = (node: Node | null, range: boolean) => {
      const element = node instanceof Element ? node : node?.parentElement;
      if (element?.closest('main.astrid-public-site')) {
        counters[range ? 'homeRanges' : 'homeRects'] += 1;
        const stack = new Error().stack ?? '';
        // Playwright's locator/trace bridge walks the DOM and can measure hidden
        // Remotion nodes. Those calls are harness instrumentation, not page work.
        if (element.closest('[data-astrid-page-away]') && !stack.includes('visitNode') && !stack.includes('visitChild')) counters.retainedReads += 1;
      }
      if (element?.closest('main.astrid-vision')) counters[range ? 'visionRanges' : 'visionRects'] += 1;
    };
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { classify(this, false); return rect.call(this); };
    const ranges = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function () { classify(this.commonAncestorContainer, true); return ranges.call(this); };
    const put = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (...args: Parameters<typeof put>) {
      const layer = this.canvas.dataset.layer;
      if (layer) counters.skyWrites[layer] = (counters.skyWrites[layer] ?? 0) + 1;
      return put.apply(this, args);
    };
    const create = CanvasRenderingContext2D.prototype.createImageData;
    CanvasRenderingContext2D.prototype.createImageData = function (...args: Parameters<typeof create>) {
      if (this.canvas.dataset.layer) counters.skyAllocations += 1;
      return create.apply(this, args);
    };
    const set = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (...args: Parameters<typeof set>) {
      if (this === document.documentElement.style && args[0] === '--astrid-root-paper') counters.rootPaperWrites += 1;
      return set.apply(this, args);
    };
    Object.assign(window, { __f08: counters });
  });
});

test.afterEach(async ({ page }, info) => {
  if (!page.isClosed()) await info.attach('resource-counters', { body: JSON.stringify(await page.evaluate(() => (window as unknown as { __f08: unknown }).__f08), null, 2), contentType: 'application/json' });
});

test('A01/A02/A03/A10/A13 production entries and repeated retained-state history', async ({ page }, info) => {
  // Four settled-editor entries plus twelve animated page transitions: more than the 30s default allows. Hang ceiling only.
  test.setTimeout(120_000);
  const editorRuntimeRequests: string[] = [];
  page.on('request', (request) => {
    // `publicAstridExampleSelection.ts` is shell-safe metadata, statically used for
    // the preview label. Only the lazy editor component and full example payload
    // count as editor runtime on a page that does not mount Home.
    if (/\/PublicAstridMountedEditor\.tsx(?:\?|$)|\/content\/light-study-v1\/public-example\.ts(?:\?|$)/.test(request.url())) {
      editorRuntimeRequests.push(request.url());
    }
  });
  await page.goto('/vision');
  await surface(page, 'vision');
  await page.waitForTimeout(700);
  expect(editorRuntimeRequests).toEqual([]);
  await expect(page.locator('main.astrid-public-site')).toHaveCount(0);
  await shot(page, info, 'direct-vision');
  // App is the default public landing audience; explicit App and Agent links remain supported.
  // '/home?experience=agent' stays last so the retained-history trips below return to the agent audience.
  for (const [route, audience, label] of [
    ['/', 'app', 'root'],
    ['/home', 'app', 'home'],
    ['/home?experience=app', 'app', 'app'],
    ['/home?experience=agent', 'agent', 'agent'],
  ] as const) {
    await page.goto(route);
    await surface(page, 'home');
    await expect(page.locator('main.astrid-public-site')).toHaveAttribute('data-audience', audience);
    // Every entry is a cold load of the dev-served editor: module, media, inspector and timeline signals,
    // then the 850 ms loader retirement, take 4-5.5 s in order (module-ready, usable, presenting, settled)
    // and more under load. One hang ceiling for all audiences; it asserts that settling happens, not when.
    await expect(page.locator('.astrid-editor-stage')).toHaveAttribute('data-astrid-readiness', 'settled', { timeout: 30_000 });
    await shot(page, info, `entry-${label}`);
  }
  expect(editorRuntimeRequests.some((url) => url.includes('/PublicAstridMountedEditor.tsx'))).toBe(true);
  expect(editorRuntimeRequests.some((url) => url.includes('/content/light-study-v1/public-example.ts'))).toBe(true);
  const editor = page.locator('.astrid-editor-stage');
  await editor.evaluate((element) => element.setAttribute('data-f08-identity', 'retained'));
  for (let trip = 0; trip < 3; trip += 1) {
    await page.getByRole('link', { name: 'Vision' }).click();
    await surface(page, 'vision');
    await expect(page.locator('main.astrid-public-site')).toHaveAttribute('data-astrid-lifecycle', 'retained');
    await expect(page.locator('[data-astrid-page-away]')).toHaveAttribute('inert');
    await expect(page.locator('.astrid-sky canvas')).toHaveCount(4);
    await page.waitForTimeout(700);
    const reads = await page.evaluate(() => (window as unknown as { __f08: { retainedReads: number } }).__f08.retainedReads);
    await page.evaluate(() => { window.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize')); });
    await page.waitForTimeout(700);
    expect.soft(await page.evaluate(() => (window as unknown as { __f08: { retainedReads: number } }).__f08.retainedReads)).toBe(reads);
    await shot(page, info, `trip-${trip}-vision`);
    await page.goBack();
    await surface(page, 'home');
    await expect(editor).toHaveAttribute('data-f08-identity', 'retained');
    await expect(page.locator('main.astrid-public-site')).toHaveAttribute('data-audience', 'agent');
    await page.goForward();
    await surface(page, 'vision');
    await page.getByRole('link', { name: 'Astrid home' }).click();
    await surface(page, 'home');
  }
  await page.getByRole('button', { name: 'App', exact: true }).click();
  await expect(page.locator('main.astrid-public-site')).toHaveAttribute('data-audience', 'app');
  await shot(page, info, 'returned-app');
});

test('A04/A05/A06/A07/A08 daylight palettes, resize, disclosure and live motion', async ({ page }, info) => {
  await page.goto('/vision');
  await surface(page, 'vision');
  const samples: unknown[] = [];
  for (const time of [12, 17, 18, 18.5, 19, 19.5, 20, 0]) {
    await hours(page, time);
    await page.waitForTimeout(180);
    samples.push(await page.locator('main.astrid-vision').evaluate((element, sampleTime) => ({
      time: sampleTime,
      theme: element.getAttribute('data-theme'),
      paper: getComputedStyle(element).getPropertyValue('--astrid-paper'),
      rootPaper: getComputedStyle(document.documentElement).getPropertyValue('--astrid-root-paper'),
      ink: getComputedStyle(element).getPropertyValue('--astrid-ink'),
      background: getComputedStyle(element).backgroundColor,
      headingInk: getComputedStyle(element.querySelector('h1')!).color,
    }), time));
    await shot(page, info, `dusk-${time}`);
  }
  for (const sample of samples as { paper: string; rootPaper: string }[]) expect(sample.paper.trim()).toBe(sample.rootPaper.trim());
  await info.attach('palette-samples', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await hours(page, 0);
  for (const size of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(400);
    await expect(page.locator('.astrid-sky canvas')).toHaveCount(4);
    // Touch screens get the sky 120px past both edges (TOUCH_SKY_BLEED, e59243855): 2 * ceil(120 / 6) extra rows.
    const bleedRows = (await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)) ? 2 * Math.ceil(120 / 6) : 0;
    const dimensions = await page.locator('.astrid-sky canvas').evaluateAll((elements) => elements.map((element) => ({ width: (element as HTMLCanvasElement).width, height: (element as HTMLCanvasElement).height })));
    expect(new Set(dimensions.map((value) => JSON.stringify(value))).size).toBe(1);
    expect(dimensions[0].width).toBe(Math.ceil((size.width + 48) / 6));
    expect(dimensions[0].height).toBe(Math.ceil((size.height + 48) / 6) + bleedRows);
    await shot(page, info, `resize-${size.width}`);
  }
  const issue = page.locator('.astrid-vision-part h3 button').first();
  await expect(issue).toHaveAttribute('aria-expanded', 'false');
  await issue.click();
  await expect(issue).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.astrid-vision-part-body').first()).toBeVisible();
  await shot(page, info, 'disclosure');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('A03/A08/A11/A12 Get Started entry, route focus and transition fallback', async ({ page }, info) => {
  await page.addInitScript(() => Object.defineProperty(document, 'startViewTransition', { configurable: true, value: undefined }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Enter Home as App, leave for Vision and return through history, which restores App.
  await page.goto('/home?experience=app');
  await surface(page, 'home');
  await expect(page.locator('main.astrid-public-site')).toHaveAttribute('data-audience', 'app');
  await page.getByRole('link', { name: 'Vision' }).click();
  await surface(page, 'vision');
  await page.getByRole('link', { name: 'Astrid home' }).click();
  await surface(page, 'home');
  await expect(page.locator('main.astrid-public-site')).toHaveAttribute('data-audience', 'app');
  await expect(page.locator('.astrid-editor-stage')).toHaveAttribute('data-astrid-readiness', 'settled', { timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Get Started', exact: true })).toHaveAttribute('href', '/tools/video-editor');
  await expect(page.getByRole('button', { name: 'Get the app', exact: true })).toHaveCount(0);
  await expect(page.locator('dialog')).toHaveCount(0);
  await shot(page, info, 'get-started-entry');
  await page.goForward();
  await surface(page, 'vision');
  await expect(page.locator('dialog')).not.toBeVisible();
  await expect(page.locator('main.astrid-vision')).toBeFocused();
  await shot(page, info, 'fallback-departure');
});

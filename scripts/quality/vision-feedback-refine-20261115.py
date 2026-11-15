from pathlib import Path
import sys

p=Path('tests/e2e/public-astrid-vision-entry.spec.ts')
s=p.read_text()
if '--baseline' in sys.argv:
    needle="""    await page.goto('/home', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.astrid-callouts > article')).toHaveCount(3, { timeout: 60000 });"""
    replacement="""    const errors: string[] = [];
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
    }"""
    assert s.count(needle)==1;s=s.replace(needle,replacement)
    s=s.replace("const doc = document as Document & { startViewTransition: (update: () => void | Promise<void>) => Native };", "const doc = document as unknown as { startViewTransition: (update: () => void | Promise<void>) => Native };")
    needle="    expect.soft(trace.frames.length).toBeGreaterThan(5);"
    assert s.count(needle)==1
    s=s.replace(needle,needle+"\n    expect.soft(new Set(trace.frames.map(frame => frame.transform)).size, 'mink travels through intermediate positions').toBeGreaterThan(3);\n    expect.soft(trace.frames.some(frame => frame.duration.split(',').some(value => parseFloat(value) > .5))).toBe(true);")
    p.write_text(s)
    raise SystemExit(0)

# External navigation is deliberately outside the surface. Preserve a stronger
# no-horizontal-reading-overflow contract, not the old outer decoration box.
for name in ['public-astrid-vision-aspirations.spec.ts', 'public-astrid-vision-mobile-catalogs.spec.ts']:
    p=Path('tests/e2e')/name;s=p.read_text()
    count=0
    for argument in ['el','node']:
        needle=f'dialog.evaluate({argument} => {argument}.scrollWidth <= {argument}.clientWidth + 1)'
        count+=s.count(needle)
        replacement="""dialog.evaluate(dialog => {
      const surfaces = Array.from(dialog.querySelectorAll<HTMLElement>('.astrid-vision-details-shell, .astrid-vision-details-scroll, .astrid-vision-details-scroll-inner'));
      return surfaces.length === 3 && surfaces.every(surface => surface.scrollWidth <= surface.clientWidth + 1)
        && document.documentElement.scrollWidth <= window.innerWidth + 1;
    })"""
        s=s.replace(needle,replacement)
    assert count==(2 if 'aspirations' in name else 1),(name,count)
    p.write_text(s)

p=Path('tests/e2e/public-astrid-vision-polish.spec.ts');s=p.read_text()
old="      expect(record.presentation).toBe('crossfade');"
assert s.count(old)==1
s=s.replace(old,"      const sharedBrand = width > 640 && expectedHomeY <= 72;\n      expect(record.presentation).toBe(sharedBrand ? 'brand' : 'crossfade');")
old="      expect(record.named).toEqual([]);"
assert s.count(old)==1
s=s.replace(old,"      expect(record.named).toEqual(sharedBrand ? ['astrid-brand-mink'] : []);")
p.write_text(s)

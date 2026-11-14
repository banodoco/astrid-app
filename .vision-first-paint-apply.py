from pathlib import Path

def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    assert s.count(old) == count, (path, old[:100], s.count(old))
    p.write_text(s.replace(old, new))

p = 'src/pages/Home/PublicAstridVision.tsx'
s = Path(p).read_text()
a = s.index('function useScrollReveal(')
b = s.index('\n\n\n\nfunction GapPoint', a)
s = s[:a] + '''function useScrollReveal(active: boolean, reducedMotion: boolean, contentRevision: string | undefined) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const targets = [...(ref.current?.querySelectorAll<HTMLElement>('[data-reveal]') ?? [])]
      .filter(target => !target.closest('.astrid-vision-details'));
    const show = (element: Element) => element.setAttribute('data-shown', 'true');
    if (reducedMotion || typeof IntersectionObserver !== 'function') { targets.forEach(show); return; }
    if (!active) return;
    // Content can arrive after the loading skeleton. Anything already visible
    // must be present on that first paint, without waiting for a scroll/IO tick.
    const top = window.visualViewport?.offsetTop ?? 0;
    const bottom = top + (window.visualViewport?.height ?? window.innerHeight);
    for (const target of targets) {
      const bounds = target.getBoundingClientRect();
      if (bounds.bottom > top && bounds.top < bottom) target.setAttribute('data-shown', 'initial');
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        show(entry.target);
        observer.unobserve(entry.target);
      }
    });
    targets.filter(target => !target.hasAttribute('data-shown')).forEach(target => observer.observe(target));
    return () => observer.disconnect();
  }, [active, reducedMotion, contentRevision]);
  return ref;
}''' + s[b:]
Path(p).write_text(s)
replace(p, "  // Newly filtered rows must still receive reveal observation.\n  const pageRef = useScrollReveal(visible, reducedMotion, content?.source.revision,\n    gapFilter + ':' + showAllGaps + ':' + projectFilter + ':' + showAllProjects + ':' + selectedCatalog);", "  // Catalogs are modal content, not part of the page's scroll-reveal sequence.\n  const pageRef = useScrollReveal(visible, reducedMotion, content?.source.revision);")
replace(p, "id={'gap-' + gap.id.toLowerCase()} data-reveal data-open", "id={'gap-' + gap.id.toLowerCase()} data-open")
replace(p, 'className="astrid-vision-issues-more" data-reveal', 'className="astrid-vision-issues-more"')
replace(p, 'What we’re building towards', 'What we’re building')
replace('src/pages/Home/PublicAstridVision.css', '.astrid-vision [data-reveal]:not([data-shown]) { opacity: 0; translate: 0 14px; }', '.astrid-vision [data-reveal]:not([data-shown]) { opacity: 0; translate: 0 14px; }\n/* Initial-viewport content is rendered before paint, not animated in late. */\n.astrid-vision [data-reveal][data-shown="initial"] { transition: none; }')

p = 'src/pages/Home/VisionMobileLayout.css'
replace(p, '.astrid-vision-catalog [data-reveal] { opacity: 1; transform: none; }', '.astrid-vision .astrid-vision-catalog [data-reveal] {\n  opacity: 1; translate: none; transform: none; transition: none; animation: none;\n}')
replace(p, '  .astrid-vision .astrid-vision-standards-list > li .astrid-vision-sigil-art { width: 100%; height: 100%; }', '''  .astrid-vision .astrid-vision-standards-list > li .astrid-vision-sigil-art { width: 100%; height: 100%; }
  /* Optical, not box alignment: these drawings carry more ink on the left.
     Move only their artwork; all four full-height frames remain identical. */
  .astrid-vision .astrid-vision-standards-list > li:is(
    [data-principle="in-the-creators-control"],
    [data-principle="eliminate-needless-technical-wrangling"]
  ) .astrid-vision-sigil-art { translate: 8% 0; }''')

p = 'src/pages/Home/VisionDetailDialog.tsx'
replace(p, '''          <span className="astrid-vision-details-gap-preview">
            {projects.length > 0 ? (
              <strong>{projects.length} {projects.length === 1 ? 'project' : 'projects'}</strong>
            ) : 'No project yet'}
          </span>''', '''          {projects.length > 0 && (
            <span className="astrid-vision-details-gap-preview">
              <strong>{projects.length} {projects.length === 1 ? 'project' : 'projects'}</strong>
            </span>
          )}''')
replace(p, 'What we’re building towards', 'What we’re building')
replace('src/shared/components/PixelUnderline.tsx', 'An out-of-flow, square-stepped underline.', 'An out-of-flow, straight underline with square pixel ends.')
replace('src/shared/components/PixelUnderline.tsx', 'd="M1 8H9V6H27V5H53V6H75V4H91V5H99"', 'd="M1 6H99"')
replace('src/shared/components/PixelUnderline.css', '  color: var(--pixel-underline-color, currentColor);', '  color: var(--pixel-underline-color, currentColor); opacity: .55;')

p = 'src/pages/Home/VisionDialog.tsx'
s = Path(p).read_text()
a = s.index('  useLayoutEffect(() => {\n    // Locking the body resets document scroll.')
b = s.index('\n\n  // Keep the native modal/top layer', a)
s = s[:a] + '''  useLayoutEffect(() => {
    // A RAF runs *before* paint, so a single RAF can still open in the body's
    // scroll-lock rendering turn. Cross a painted frame before creating the
    // native top layer, particularly when opening catalogs from the page bottom.
    let alive = true;
    let frame = window.requestAnimationFrame(() => {
      if (!alive) return;
      frame = window.requestAnimationFrame(() => {
        if (!alive) return;
        const dialog = dialogRef.current;
        if (!dialog?.isConnected || dialog.open) return;
        const viewport = window.visualViewport;
        if (!viewport || viewport.scale <= 1.05) {
          dialog.style.setProperty('--vision-viewport-top', (viewport?.offsetTop ?? 0) + 'px');
          dialog.style.setProperty('--vision-viewport-height', (viewport?.height ?? window.innerHeight) + 'px');
        }
        // Native focusing chooses the heading directly, not the footer X first.
        titleRef.current?.setAttribute('autofocus', '');
        dialog.showModal();
        if (document.activeElement !== titleRef.current) titleRef.current?.focus({ preventScroll: true });
      });
    });
    return () => { alive = false; window.cancelAnimationFrame(frame); };
  }, []);''' + s[b:]
Path(p).write_text(s)

p = 'src/pages/Home/PublicAstridSky.tsx'
replace(p, '  const skyRef = useRef<HTMLDivElement>(null);', '  const skyRef = useRef<HTMLDivElement>(null);\n  const viewportRef = useRef<HTMLSpanElement>(null);')
replace(p, '      const viewRows = Math.ceil((window.innerHeight + 2 * PARALLAX_MARGIN) / PUBLIC_ASTRID_SKY_PIXEL);', '''      // A toolbar changes innerHeight, not the scene. A CSS large-viewport
      // probe is stable through that change, yet follows real rotation/resizing.
      // Keep desktop resizing dynamic and retain a fallback for older engines.
      const sceneHeight = bleed > 0
        ? viewportRef.current?.clientHeight || window.innerHeight
        : window.innerHeight;
      const viewRows = Math.ceil((sceneHeight + 2 * PARALLAX_MARGIN) / PUBLIC_ASTRID_SKY_PIXEL);''')
replace(p, '    <div ref={skyRef} className="astrid-sky" aria-hidden="true">\n      {SKY_LAYERS.map(renderLayer)}', '    <div ref={skyRef} className="astrid-sky" aria-hidden="true">\n      <span ref={viewportRef} className="astrid-sky-viewport" />\n      {SKY_LAYERS.map(renderLayer)}')
replace('src/pages/Home/PublicAstridSky.css', '.astrid-sky canvas {', '''/* Measure the stable scene extent independently of mobile browser controls.
   The probe never participates in layout or receives input. */
.astrid-sky-viewport {
  position: absolute; width: 0; height: 100vh; height: 100lvh;
  visibility: hidden; pointer-events: none;
}
.astrid-sky canvas {''')

for p in Path('tests/e2e').glob('public-astrid-vision*.spec.ts'):
    s = p.read_text().replace('What we’re building towards', 'What we’re building')
    s = s.replace("await expect(gaps.nth(1).locator(':scope > summary')).toContainText('No project yet');", "await expect(gaps.nth(1).locator('.astrid-vision-details-gap-preview')).toHaveCount(0);")
    p.write_text(s)
replace('src/shared/components/PixelUnderline.test.tsx', "    expect(path.getAttribute('d')).not.toMatch(/[CQSA]/i);", "    expect(path).toHaveAttribute('d', 'M1 6H99');\n    expect(path.getAttribute('d')).not.toMatch(/[CQSA]/i);")

p = Path('src/pages/Home/PublicAstridSky.scheduling.test.tsx')
p.write_text(p.read_text() + '''

it('holds mobile sky raster dimensions through toolbar resizes but follows orientation changes', () => {
  const owner = session();
  owner.setEnvironment({ visible: true, reducedMotion: true, phone: true });
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
    media, matches: media === '(pointer: coarse)', onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => true,
  }));
  let largeHeight = 844;
  const originalHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')?.get;
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('astrid-sky-viewport') ? largeHeight : originalHeight?.call(this) ?? 0;
  });
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('innerHeight', 700);
  const view = render(<PublicAstridSky session={owner} />);
  settle();
  const sizes = () => [...view.container.querySelectorAll('canvas')].map(canvas => [canvas.width, canvas.height]);
  const initial = sizes();
  for (const height of [630, 790, 700]) {
    vi.stubGlobal('innerHeight', height);
    act(() => window.dispatchEvent(new Event('resize')));
    settle();
    expect(sizes()).toEqual(initial);
  }
  largeHeight = 390;
  vi.stubGlobal('innerWidth', 844);
  vi.stubGlobal('innerHeight', 390);
  act(() => window.dispatchEvent(new Event('resize')));
  settle();
  expect(sizes()).not.toEqual(initial);
  view.unmount();
  expect(frames.size).toBe(0);
  owner.destroy();
});
''')
replace('playwright.vision.config.ts', "'**/public-astrid-vision-polish.spec.ts'", "'**/public-astrid-vision-polish.spec.ts', '**/public-astrid-vision-first-paint.spec.ts'")
p = '.github/workflows/public-vision.yml'
replace(p, '    paths:\n', '''    paths:
      - "src/pages/Home/PublicAstridSky.tsx"
      - "src/pages/Home/PublicAstridSky.css"
      - "src/pages/Home/PublicAstridSky.scheduling.test.tsx"
      - "tests/e2e/public-astrid-vision-first-paint.spec.ts"
''')
replace(p, 'npx eslint ', 'npx eslint src/pages/Home/PublicAstridSky.tsx ')
replace(p, '      - name: Build the hosted website', '''      - name: Verify sky resize scheduling
        run: npx vitest run --config config/testing/vitest.config.ts src/pages/Home/PublicAstridSky.scheduling.test.tsx
      - name: Build the hosted website''')
replace(p, 'tests/e2e/public-astrid-vision-polish.spec.ts --project=', 'tests/e2e/public-astrid-vision-polish.spec.ts tests/e2e/public-astrid-vision-first-paint.spec.ts --project=')
print('Applied all seven scoped changes; no source prose or feed fields rewritten.')

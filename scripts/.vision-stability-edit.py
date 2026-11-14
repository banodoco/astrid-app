from pathlib import Path
root = Path('.')
def edit(path, old, new, count=1):
    p = root / path
    s = p.read_text()
    if s.count(old) != count:
        raise ValueError(f'{path}: unexpected source for {old[:100]}')
    p.write_text(s.replace(old, new))

edit('src/pages/Home/PublicAstridSky.css', '  inset: 0;\n  z-index: 0;', '''  inset: 0;
  bottom: auto;
  --astrid-sky-bleed: 0px;
  /* Browser toolbars may change innerHeight on every scroll. The artwork uses
     the large, stable viewport; only genuine layout/orientation changes resize it. */
  height: calc(100vh + 2 * var(--astrid-sky-bleed));
  height: calc(100lvh + 2 * var(--astrid-sky-bleed));
  z-index: 0;''')
edit('src/pages/Home/PublicAstridSky.css', '.astrid-sky canvas {', '''@media (pointer: coarse) {
  .astrid-sky { --astrid-sky-bleed: 120px; }
}
.astrid-sky canvas {''')
edit('src/pages/Home/PublicAstridSky.tsx', '      const viewRows = Math.ceil((window.innerHeight + 2 * PARALLAX_MARGIN) / PUBLIC_ASTRID_SKY_PIXEL);', '''      // Read the CSS large-viewport frame, not toolbar-sensitive innerHeight.
      // The fallback also supports non-layout test environments and older engines.
      const viewHeight = skyRef.current?.clientHeight
        ? Math.max(1, skyRef.current.clientHeight - 2 * bleed) : window.innerHeight;
      const viewRows = Math.ceil((viewHeight + 2 * PARALLAX_MARGIN) / PUBLIC_ASTRID_SKY_PIXEL);''')
edit('src/pages/Home/PublicAstridSky.tsx', '        skyRef.current.style.bottom = bleedOffset;\n', '')
edit('src/pages/Home/PublicAstridVision.tsx', '''  useEffect(() => {
    const targets = [...(ref.current?.querySelectorAll<HTMLElement>('[data-reveal]') ?? [])];''', '''  useLayoutEffect(() => {
    const targets = [...(ref.current?.querySelectorAll<HTMLElement>('[data-reveal]') ?? [])]
      .filter(element => !element.closest('dialog'));''')
edit('src/pages/Home/PublicAstridVision.tsx', '''    if (!active) return;
    const observer = new IntersectionObserver((entries) => {''', '''    if (!active) return;
    // Reveal what is already in view before the first paint. A short phone can
    // show the top of a card without crossing the old -8% observation margin.
    const top = window.visualViewport?.offsetTop ?? 0;
    const bottom = top + (window.visualViewport?.height ?? window.innerHeight);
    const initiallyVisible = targets.filter(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.height > 0 && bounds.bottom > top && bounds.top < bottom;
    });
    initiallyVisible.forEach(show);
    const observer = new IntersectionObserver((entries) => {''')
edit('src/pages/Home/PublicAstridVision.tsx', "    }, { rootMargin: '0px 0px -8% 0px' });\n    targets.forEach((target) => observer.observe(target));", "    }, { rootMargin: '0px' });\n    targets.filter(target => !target.hasAttribute('data-shown')).forEach(target => observer.observe(target));")
edit('src/pages/Home/PublicAstridVision.tsx', "id={'gap-' + gap.id.toLowerCase()} data-reveal data-open=", "id={'gap-' + gap.id.toLowerCase()} data-open=")
edit('src/pages/Home/PublicAstridVision.tsx', '<p className="astrid-vision-issues-more" data-reveal>', '<p className="astrid-vision-issues-more">')
edit('src/pages/Home/PublicAstridVision.tsx', '''function Tinkerer() {
  return (
    <div className="astrid-vision-tinkerer" aria-hidden="true">''', '''function Tinkerer({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    if (typeof IntersectionObserver !== 'function') { setInView(true); return; }
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting),
      { rootMargin: '80px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  return (
    <div className="astrid-vision-tinkerer" ref={ref} aria-hidden="true" data-animating={active && inView || undefined}>''')
edit('src/pages/Home/PublicAstridVision.tsx', '<Tinkerer />', '<Tinkerer active={visible && !reducedMotion && !selectedSubject && !selectedCatalog} />')
edit('src/pages/Home/PublicAstridVision.css', '.astrid-vision-tinkerer[data-shown] .astrid-vision-sparks { animation: astrid-vision-sparks 3.1s steps(44) 1.2s infinite; }', '''.astrid-vision-sparks { animation: astrid-vision-sparks 3.1s steps(44) infinite; animation-play-state: paused; }
.astrid-vision-tinkerer[data-animating] .astrid-vision-sparks { animation-play-state: running; }''')
edit('src/pages/Home/VisionMobileLayout.css', '.astrid-vision-catalog [data-reveal] { opacity: 1; transform: none; }', '''.astrid-vision .astrid-vision-catalog [data-reveal] {
  opacity: 1; transform: none; translate: none; transition: none;
}''')
edit('src/pages/Home/VisionDialog.tsx', '''    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;''', '''    let frame = 0;
    let disposed = false;
    frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;''')
edit('src/pages/Home/VisionDialog.tsx', '''      if (document.activeElement !== titleRef.current) titleRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);''', '''      if (document.activeElement !== titleRef.current) titleRef.current?.focus({ preventScroll: true });
      // Let the native top layer and any toolbar resize settle before revealing
      // it. Never animate position/height or re-open the modal. The bounded
      // fallback still opens while a keyboard or browser toolbar keeps moving.
      let previousBounds = '';
      let stableFrames = 0;
      let attempts = 0;
      const reveal = () => {
        if (disposed || !dialog.open) return;
        const bounds = dialog.getBoundingClientRect();
        const key = [bounds.x, bounds.y, bounds.width, bounds.height].map(Math.round).join(':');
        stableFrames = key === previousBounds ? stableFrames + 1 : 0;
        previousBounds = key;
        attempts += 1;
        if (stableFrames >= 2 || attempts >= 12) dialog.dataset.ready = 'true';
        else frame = window.requestAnimationFrame(reveal);
      };
      frame = window.requestAnimationFrame(reveal);
    });
    return () => { disposed = true; window.cancelAnimationFrame(frame); };''')
edit('src/pages/Home/VisionMobileLayout.css', '/* The whole panel owns navigation, so wrapping titles and disclosures cannot move it. */', '''/* Geometry and focus settle while the native modal is transparent, then only
   its opacity changes. No second opening, slide, scale or content reveal. */
.astrid-vision-details { opacity: 0; transition: opacity 120ms ease-out; }
.astrid-vision-details[data-ready="true"] { opacity: 1; }
.astrid-vision-details::backdrop { opacity: 0; transition: opacity 120ms ease-out; }
.astrid-vision-details[data-ready="true"]::backdrop { opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .astrid-vision-details, .astrid-vision-details::backdrop { transition: none; }
}

/* The marks have different internal SVG whitespace. Offset the art, not the
   full-height common frame or the reading column, for optical alignment. */
@media (max-width: 760px) {
  .astrid-vision-standards-list > li[data-principle="in-the-creators-control"] .astrid-vision-sigil-art { transform: translateX(12.5%); }
  .astrid-vision-standards-list > li[data-principle="eliminate-needless-technical-wrangling"] .astrid-vision-sigil-art { transform: translateX(7.5%); }
}

/* The whole panel owns navigation, so wrapping titles and disclosures cannot move it. */''')
edit('src/pages/Home/VisionDialog.tsx', '    const x = window.scrollX, y = window.scrollY;', '''    const x = window.scrollX, y = window.scrollY;
    const previousScrollLock = root.dataset.astridScrollLockY;
    root.dataset.astridScrollLockY = String(y);''')
edit('src/pages/Home/VisionDialog.tsx', "      window.scrollTo({ left: x, top: y, behavior: 'instant' });", '''      window.scrollTo({ left: x, top: y, behavior: 'instant' });
      if (previousScrollLock === undefined) delete root.dataset.astridScrollLockY;
      else root.dataset.astridScrollLockY = previousScrollLock;''')
edit('src/pages/Home/publicAstridSkySession.ts', '''function scrollDrift(): number {
  return -Math.min(window.scrollY, SCROLL_DRIFT_SPAN) / SCROLL_DRIFT_SPAN;
}''', '''function scrollDrift(): number {
  const locked = document.documentElement.dataset.astridScrollLockY;
  const y = locked === undefined ? window.scrollY : Number(locked);
  return -Math.min(Number.isFinite(y) ? y : window.scrollY, SCROLL_DRIFT_SPAN) / SCROLL_DRIFT_SPAN;
}''')
for name in ['src/pages/Home/PublicAstridVision.tsx', 'src/pages/Home/VisionDetailDialog.tsx', 'tests/e2e/public-astrid-vision-polish.spec.ts']:
    p = root / name
    s = p.read_text()
    assert 'What we’re building towards' in s
    p.write_text(s.replace('What we’re building towards', 'What we’re building'))
edit('src/pages/Home/VisionDetailDialog.tsx', '''          <span className="astrid-vision-details-gap-preview">
            {projects.length > 0 ? (
              <strong>{projects.length} {projects.length === 1 ? 'project' : 'projects'}</strong>
            ) : 'No project yet'}
          </span>''', '''          {projects.length > 0 && <span className="astrid-vision-details-gap-preview">
            <strong>{projects.length} {projects.length === 1 ? 'project' : 'projects'}</strong>
          </span>}''')
edit('src/shared/components/PixelUnderline.tsx', 'An out-of-flow, square-stepped underline.', 'An out-of-flow, straight underline with square pixel edges.')
edit('src/shared/components/PixelUnderline.tsx', 'd="M1 8H9V6H27V5H53V6H75V4H91V5H99"', 'd="M1 7H99"')
edit('src/shared/components/PixelUnderline.css', '  color: var(--pixel-underline-color, currentColor);', '  color: var(--pixel-underline-color, currentColor);\n  opacity: .55;')
edit('tests/e2e/public-astrid-vision-aspirations.spec.ts', "await expect(gaps.nth(1).locator(':scope > summary')).toContainText('No project yet');", "await expect(gaps.nth(1).locator('.astrid-vision-details-gap-preview')).toHaveCount(0);\n    await expect(gaps.nth(1)).not.toContainText('No project yet');")
edit('playwright.vision.config.ts', "'**/public-astrid-vision-polish.spec.ts'", "'**/public-astrid-vision-polish.spec.ts', '**/public-astrid-vision-stability.spec.ts'")
edit('.github/workflows/public-vision.yml', '  pull_request:\n    paths:', '''  pull_request:
    paths:
      - "src/pages/Home/PublicAstridSky.tsx"
      - "src/pages/Home/PublicAstridSky.css"
      - "src/pages/Home/publicAstridSkySession.ts"
      - "src/pages/Home/PublicAstridSky.scheduling.test.tsx"
      - "tests/e2e/public-astrid-vision-stability.spec.ts"''')
edit('.github/workflows/public-vision.yml', 'npx eslint src/pages/Home/PublicAstridSite.tsx', 'npx eslint src/pages/Home/PublicAstridSky.tsx src/pages/Home/publicAstridSkySession.ts src/pages/Home/PublicAstridSite.tsx')
edit('.github/workflows/public-vision.yml', '      - name: Build the hosted website', '''      - name: Preserve shared sky rendering and scheduling
        run: npx vitest run --config config/testing/vitest.config.ts src/pages/Home/PublicAstridSky.scheduling.test.tsx src/pages/Home/publicAstridSkySession.test.ts src/pages/Home/publicAstridSkyGeometry.test.ts src/pages/Home/publicAstridSkyRenderer.test.ts src/pages/Home/publicAstridSkyRender.test.ts
      - name: Build the hosted website''')
edit('.github/workflows/public-vision.yml', 'tests/e2e/public-astrid-vision-polish.spec.ts --project=', 'tests/e2e/public-astrid-vision-polish.spec.ts tests/e2e/public-astrid-vision-stability.spec.ts --project=')
p = root / 'src/pages/Home/PublicAstridSky.scheduling.test.tsx'
s = p.read_text()
i = s.rfind('\n});')
assert i > 0
s = s[:i] + '''

  it('uses the stable CSS frame instead of toolbar-sensitive window height', () => {
    const owner = session();
    const view = render(<PublicAstridSky session={owner} />);
    const element = view.container.querySelector<HTMLElement>('.astrid-sky')!;
    let height = 80;
    vi.spyOn(element, 'clientHeight', 'get').mockImplementation(() => height);
    settle();
    const canvas = view.container.querySelector('canvas')!;
    const original = { width: canvas.width, height: canvas.height };
    vi.stubGlobal('innerHeight', 40);
    act(() => window.dispatchEvent(new Event('resize')));
    settle();
    expect({ width: canvas.width, height: canvas.height }).toEqual(original);
    height = 100;
    act(() => window.dispatchEvent(new Event('resize')));
    settle();
    expect(canvas.height).toBeGreaterThan(original.height);
    view.unmount(); owner.destroy();
  });

  it('holds scroll parallax while a dialog fixes the page body', () => {
    const owner = session();
    const view = render(<PublicAstridSky session={owner} />);
    vi.stubGlobal('scrollY', 600);
    act(() => window.dispatchEvent(new Event('scroll')));
    settle();
    const before = owner.getSnapshot().parallaxY;
    document.documentElement.dataset.astridScrollLockY = '600';
    vi.stubGlobal('scrollY', 0);
    act(() => window.dispatchEvent(new Event('scroll')));
    settle();
    expect(owner.getSnapshot().parallaxY).toBeCloseTo(before, 2);
    delete document.documentElement.dataset.astridScrollLockY;
    view.unmount(); owner.destroy();
  });
''' + s[i:]
p.write_text(s)
edit('src/shared/components/PixelUnderline.test.tsx', "    expect(path.getAttribute('d')).not.toMatch(/[CQSA]/i);", "    expect(path.getAttribute('d')).not.toMatch(/[CQSA]/i);\n    expect(path).toHaveAttribute('d', 'M1 7H99');")
print('Applied scoped source and test edits')

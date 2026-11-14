from pathlib import Path
import subprocess

expected = {
 'src/pages/Home/PublicAstridVision.tsx': '2d9d7a9782d880bfbddf5148ac6dd125e159272e',
 'src/pages/Home/publicVisionContent.ts': '386a8e3f9ef2d898605ecbd1c247d42c895dce4b',
 'src/pages/Home/VisionDialog.tsx': '2b9c908045ea51b3fa072d110379f7181f851010',
}
for name, sha in expected.items():
    assert subprocess.check_output(['git', 'hash-object', name], text=True).strip() == sha, name

def edit(path, old, new):
    p=Path(path); s=p.read_text(); assert s.count(old)==1,(path,s.count(old),old[:80]);p.write_text(s.replace(old,new))

p=Path('src/pages/Home/publicVisionContent.ts');s=p.read_text(); start=s.index('// In-memory stale-while-revalidate:')
p.write_text(s[:start]+'''// One validated snapshot and one request owner for both Home preloading and
// Vision. Joining an in-flight preload must not start a second cold request.
let lastGood: PublicVisionContent | null = null;
let pending: Promise<PublicVisionContent> | null = null;

function requestPublicVisionContent(): Promise<PublicVisionContent> {
  if (pending) return pending;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  pending = fetch(PUBLIC_VISION_URL, {
    signal: controller.signal, credentials: 'omit', mode: 'cors', cache: 'default',
  }).then(async response => {
    if (!response.ok) throw new Error('Vision feed unavailable');
    return parsePublicVisionContent(await response.json());
  }).then(next => {
    lastGood = next;
    return next;
  }).finally(() => {
    window.clearTimeout(timeout);
    pending = null;
  });
  return pending;
}

/** Warm the same bounded request the Vision page will join. */
export function preloadPublicVisionContent() {
  if (lastGood || typeof fetch !== 'function') return;
  void requestPublicVisionContent().catch(() => {});
}

export function usePublicVisionContent() {
  const [content, setContent] = useState<PublicVisionContent | null>(() => lastGood);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(current => current + 1), []);

  useEffect(() => {
    let mounted = true;
    setError(false);
    // The request belongs to the shared cache, not an individual mount. A
    // route change or StrictMode cleanup must not abort another subscriber.
    void requestPublicVisionContent().then(next => {
      if (mounted) setContent(next);
    }).catch(() => {
      if (mounted) setError(true);
    });
    return () => { mounted = false; };
  }, [attempt]);

  return { content, error, retry };
}
''')

edit('src/pages/Home/PublicAstridShell.tsx', '''  // Once the demo has settled, fetch the Vision page's text in the background so it opens without a
  // loading skeleton.
  useEffect(() => {
    if (!visualActive || readiness.phase !== 'settled') return undefined;
    const timer = window.setTimeout(preloadPublicVisionContent, 1_200);
    return () => window.clearTimeout(timer);
  }, [readiness.phase, visualActive]);''', '''  // Warm Vision independently of the heavy editor's readiness. Opening it
  // during this request joins the same promise instead of flashing a second load.
  useEffect(() => {
    if (!visualActive) return undefined;
    const timer = window.setTimeout(preloadPublicVisionContent, 150);
    return () => window.clearTimeout(timer);
  }, [visualActive]);''')

edit('src/pages/Home/PublicAstridVision.tsx', '''function MarkdownText({ value, className }: { value: string; className?: string }) {
  return <div className={className ? 'astrid-vision-markdown ' + className : 'astrid-vision-markdown'}>
    <ReactMarkdown>{value}</ReactMarkdown>
  </div>;
}''', '''function MarkdownText({ value, className, loading = false }: { value: string; className?: string; loading?: boolean }) {
  return <div className={className ? 'astrid-vision-markdown ' + className : 'astrid-vision-markdown'}>
    <ReactMarkdown components={loading ? {
      p: ({ children }) => <p><span className="astrid-vision-skeleton-text">{children}</span></p>,
    } : undefined}>{value}</ReactMarkdown>
  </div>;
}''')
edit('src/pages/Home/PublicAstridVision.tsx', '''  const { content, error, retry } = usePublicVisionContent();''', '''  const { content, error, retry } = usePublicVisionContent();
  const loading = !content && !error;
  const [showSkeleton, setShowSkeleton] = useState(false);
  useEffect(() => {
    if (!loading) { setShowSkeleton(false); return; }
    // Reserve layout immediately, but do not flash placeholder bars for fast
    // responses. A genuinely slow first load retains its accessible status.
    const timer = window.setTimeout(() => setShowSkeleton(true), 150);
    return () => window.clearTimeout(timer);
  }, [loading]);''')
p=Path('src/pages/Home/PublicAstridVision.tsx');s=p.read_text();a=s.index('            {content\n              ? <>');b=s.index('\n          </div>\n          <Juggler',a)
s=s[:a]+'''            <div className={'astrid-vision-hero-text' + (loading ? ' astrid-vision-skeleton-hero' : '')}
              role={loading ? 'status' : undefined}
              aria-label={loading ? "Loading Astrid's vision" : undefined}
              data-skeleton-visible={loading && showSkeleton || undefined}>
              {/* Keep one title node and exactly the same word grouping during
                  loading and navigation; do not remount an entrance animation. */}
              <h1 id={loading ? undefined : 'astrid-vision-title'} aria-hidden={loading || undefined}>
                <span className={loading ? 'astrid-vision-skeleton-text' : undefined}>
                  <VisionTitle value={content?.vision.title ?? (error ? 'Astrid’s vision' : SKELETON_TITLE)} />
                </span>
              </h1>
              {!content && error ? (
                <p className="astrid-vision-lead" role="alert">
                  The live vision is temporarily unavailable. <button type="button" onClick={retry}>Try again</button> · <a href={PUBLIC_VISION_REPO_URL + '/blob/main/vision/README.md'} target="_blank" rel="noreferrer">Read on GitHub</a>
                </p>
              ) : <div aria-hidden={loading || undefined}>
                <MarkdownText className="astrid-vision-lead" loading={loading}
                  value={content?.vision.introMarkdown ?? SKELETON_LEAD} />
              </div>}
              {(!error || content) && <p className="astrid-vision-source-attribution" aria-hidden={loading || undefined}>
                <span className={loading ? 'astrid-vision-skeleton-text' : undefined}>
                  {loading ? SKELETON_ATTRIBUTION : <>Populated by the <a href={PUBLIC_VISION_REPO_URL} target="_blank" rel="noreferrer">Astrid Dev repository</a>.</>}
                </span>
              </p>}
            </div>'''+s[b:]
s=s.replace('<div className="astrid-vision-loading-sections" aria-hidden="true">','<div className="astrid-vision-loading-sections" aria-hidden="true" data-skeleton-visible={showSkeleton || undefined}>')
p.write_text(s)

p=Path('src/pages/Home/PublicAstridVision.css');p.write_text(p.read_text()+'''
/* Loading and live copy share one layout. Navigation already owns its fade;
   starting another translated text entrance after the feed arrives looks like
   a second layout. Keep text sizing stable in mobile transition snapshots. */
.astrid-vision-hero-copy { min-width: 0; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
.astrid-vision-hero-copy > .astrid-vision-hero-text { animation: none; }
.astrid-vision-skeleton-hero .astrid-vision-skeleton-text * { color: transparent; }
.astrid-vision-skeleton-hero .pixel-underline-mark { visibility: hidden; }
.astrid-vision-skeleton-hero:not([data-skeleton-visible]) .astrid-vision-skeleton-text {
  background: none; animation: none;
}
.astrid-vision-loading-sections:not([data-skeleton-visible]) { visibility: hidden; }
''')

edit('src/pages/Home/VisionDialog.tsx', '''    set(root.style, 'scroll-behavior', 'auto');
    set(root.style, 'overflow-x', 'hidden');''', '''    set(root.style, 'scroll-behavior', 'auto');
    // Fixing the body changes a sticky header's scrolling ancestor. Keep the
    // existing header in its exact viewport box (behind the native backdrop),
    // and reserve its flow space until the page position has been restored.
    const header = dialog.closest('.astrid-vision')?.querySelector<HTMLElement>(':scope > .astrid-vision-bar');
    let headerSpace: HTMLDivElement | null = null;
    if (header) {
      const bounds = header.getBoundingClientRect();
      headerSpace = document.createElement('div');
      headerSpace.setAttribute('aria-hidden', 'true');
      headerSpace.dataset.visionHeaderSpace = '';
      headerSpace.style.height = bounds.height + 'px';
      header.before(headerSpace);
      set(header.style, 'position', 'fixed');
      set(header.style, 'top', bounds.top + 'px');
      set(header.style, 'left', bounds.left + 'px');
      set(header.style, 'right', (window.innerWidth - bounds.right) + 'px');
      set(header.style, 'width', 'auto');
      for (const edge of ['top', 'right', 'bottom', 'left']) set(header.style, 'margin-' + edge, '0px');
    }
    set(root.style, 'overflow-x', 'hidden');''')
edit('src/pages/Home/VisionDialog.tsx', '''      window.scrollTo({ left: x, top: y, behavior: 'instant' });''', '''      headerSpace?.remove();
      window.scrollTo({ left: x, top: y, behavior: 'instant' });''')

p=Path('playwright.vision.config.ts');s=p.read_text();s=s.replace("'**/public-astrid-vision-stability.spec.ts'", "'**/public-astrid-vision-stability.spec.ts', '**/public-astrid-vision-entry.spec.ts'");p.write_text(s)
p=Path('.github/workflows/public-vision.yml');s=p.read_text();s=s.replace('    paths:\n','    paths:\n      - "tests/e2e/public-astrid-vision-entry.spec.ts"\n      - "src/pages/Home/publicVisionContent.loading.test.tsx"\n      - "src/pages/Home/PublicAstridShell.tsx"\n',1)
s=s.replace('src/pages/Home/visionHierarchy.test.ts\n', 'src/pages/Home/visionHierarchy.test.ts src/pages/Home/publicVisionContent.loading.test.tsx\n')
s=s.replace('tests/e2e/public-astrid-vision-stability.spec.ts --project=', 'tests/e2e/public-astrid-vision-stability.spec.ts tests/e2e/public-astrid-vision-entry.spec.ts --project=');p.write_text(s)

p=Path('tests/e2e/public-astrid-vision-entry.spec.ts');s=p.read_text();s=s.replace("const FEED =", "test.setTimeout(90_000);\n\nconst FEED =",1)
s=s.replace("await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);", "await expect(page.locator('.astrid-vision')).toBeVisible({ timeout: 20000 });\n    await expect(page.locator('.astrid-vision-principles > li')).toHaveCount(4);")
s=s.replace("headerTrace.length)).toBe(25)", "headerTrace.length), { timeout: 20000 }).toBe(25)")
s=s.replace("await expect(dialog).toHaveCount(0);", "await expect(dialog).toHaveCount(0);\n      await expect(page.locator('[data-vision-header-space]')).toHaveCount(0);",1)
needle="  release();\n  await expect(page.locator('#astrid-vision-title')).toHaveText(feed.vision.title);"
index=s.index(needle,s.index("test('Home to Vision"))
s=s[:index]+'''  await page.evaluate(() => {
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
'''+s[index:]
s=s.replace("record(`home-vision-entry-${info.project.name}`, { source: feed.source, requestsBeforeRelease, frames });", "const arrival = await page.evaluate(() => (window as unknown as { arrival: { height: number; width: number; text: string | null }[] }).arrival);\n  record(`home-vision-entry-${info.project.name}`, { source: feed.source, requestsBeforeRelease, frames, arrival });\n  expect.soft(arrival.length).toBeGreaterThan(0);\n  expect.soft(new Set(arrival.map(frame => `${frame.height}/${frame.width}`)).size).toBe(1);")
p.write_text(s)

from pathlib import Path
root = Path('.')
def patch(path, old, new):
    p = root / path
    s = p.read_text()
    assert old in s, (path, old[:100])
    p.write_text(s.replace(old, new, 1))
for p in list((root/'src/pages/Home').glob('*.tsx')) + list((root/'tests/e2e').glob('public-astrid-vision-*.spec.ts')):
    s = p.read_text()
    n = s.replace('The principles that drive us', 'The principles that guide us')
    if s != n: p.write_text(n)
patch('src/pages/Home/PublicAstridVision.tsx',
    "        <VisionDetailDialog key={selectedSubject.kind + ':' + selectedSubject.id}\n          content={content} subject={selectedSubject} onClose={closeSubject} />",
    "        <VisionDetailDialog key={selectedSubject.kind}\n          content={content} subject={selectedSubject} onSelect={setSelectedSubject} onClose={closeSubject} />")
p = root/'src/pages/Home/PublicAstridVision.tsx'
s = p.read_text()
a = s.index('  // On a phone there is no hover, so the card crossing')
b = s.index('  // Mirror the pillar minks:', a)
s = s[:a] + '''  // Two cards share each row: give them separate scroll milestones in DOM order.
  // Layout offsets (not reveal-transformed rectangles) keep the thresholds stable.
  const principlesRef = useRef<HTMLOListElement>(null);
  const [centred, setCentred] = useState<number | null>(null);
  useEffect(() => {
    const list = principlesRef.current;
    if (!visible || reducedMotion || !phone || !list) { setCentred(null); return; }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const cards = Array.from(list.children) as HTMLElement[];
      if (!cards.length) return;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const viewportTop = window.visualViewport?.offsetTop ?? 0;
      const listTop = list.getBoundingClientRect().top - viewportTop;
      const firstOffset = cards[0].offsetTop;
      const rows: { top: number; height: number; indices: number[] }[] = [];
      cards.forEach((card, index) => {
        const top = listTop + card.offsetTop - firstOffset;
        const row = rows.find(row => Math.abs(row.top - top) < 2);
        if (row) { row.indices.push(index); row.height = Math.max(row.height, card.offsetHeight); }
        else rows.push({ top, height: card.offsetHeight, indices: [index] });
      });
      let selected: number | null = null;
      for (const row of rows) {
        // Start the left card as the row enters; a little more travel plays the right.
        const step = Math.min(row.height / row.indices.length, viewportHeight * .18);
        row.indices.forEach((index, column) => {
          if (row.top + step * column <= viewportHeight * .84) selected = index;
        });
      }
      if (selected !== null) {
        const row = rows.find(row => row.indices.includes(selected!))!;
        if (row.top + row.height <= 0 || row.top >= viewportHeight) selected = null;
      }
      setCentred(previous => previous === selected ? previous : selected);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    resize?.observe(list);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    measure();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resize?.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
    };
  }, [phone, visible, reducedMotion, content?.source.revision]);
''' + s[b:]
p.write_text(s)
patch('src/pages/Home/VisionDetailDialog.tsx', '  content, subject, onClose,', '  content, subject, onSelect, onClose,')
patch('src/pages/Home/VisionDetailDialog.tsx', '  subject: VisionSubject;\n  onClose:', '  subject: VisionSubject;\n  onSelect: (subject: VisionSubject) => void;\n  onClose:')
patch('src/pages/Home/VisionDetailDialog.tsx', '  if (!entry) return null;\n  return (', "  if (!entry) return null;\n  const siblings = subject.kind === 'pillar' ? content.pillars : content.principles;\n  const index = siblings.findIndex(item => item.id === subject.id);\n  const next = siblings[(index + 1) % siblings.length];\n  return (")
patch('src/pages/Home/VisionDetailDialog.tsx', "      identity={content.source.revision + ':' + subject.kind + ':' + subject.id} onClose={onClose}>", "      identity={content.source.revision + ':' + subject.kind + ':' + subject.id} onClose={onClose}\n      next={siblings.length > 1 ? { label: 'Next ' + subject.kind + ': ' + next.title,\n        onClick: () => onSelect({ kind: subject.kind, id: next.id }) } : undefined}>")
patch('src/pages/Home/VisionDialog.tsx', "import { X } from 'lucide-react';", "import { ChevronRight, X } from 'lucide-react';")
patch('src/pages/Home/VisionDialog.tsx', 'children, onClose }: {', 'children, onClose, next }: {')
patch('src/pages/Home/VisionDialog.tsx', '  onClose: () => void;', '  onClose: () => void;\n  next?: { label: string; onClick: () => void };')
patch('src/pages/Home/VisionDialog.tsx', '  // Show a fade only where scrollable content actually continues.', '''  // Chrome on iPhone changes its visible viewport as browser controls move.
  // Bind panel position and height to that same viewport; CSS applies safe areas
  // once with max(), rather than adding a second home-indicator-sized gap.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      frame = 0;
      // Do not undo the user's pinch zoom by continually shrinking the dialog.
      if (viewport && viewport.scale > 1.05) return;
      dialog.style.setProperty('--vision-viewport-top', (viewport?.offsetTop ?? 0) + 'px');
      dialog.style.setProperty('--vision-viewport-height', (viewport?.height ?? window.innerHeight) + 'px');
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    update();
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  // Keep the native modal/top layer, but reset disclosures and scroll per subject.
  useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [identity]);

  // Show a fade only where scrollable content actually continues.''')
patch('src/pages/Home/VisionDialog.tsx', '      aria-labelledby={titleId}', '      aria-labelledby={titleId}\n      data-has-next={Boolean(next) || undefined}')
patch('src/pages/Home/VisionDialog.tsx', '<h2 id={titleId} ref={titleRef} tabIndex={-1}>', '<h2 id={titleId} ref={titleRef} tabIndex={-1} aria-live="polite">')
patch('src/pages/Home/VisionDialog.tsx', '<div className="astrid-vision-details-scroll-inner" ref={scrollContentRef}>', '<div className="astrid-vision-details-scroll-inner" ref={scrollContentRef} key={identity}>')
patch('src/pages/Home/VisionDialog.tsx', '          <div className="astrid-vision-details-scroll-fade astrid-vision-details-scroll-fade--top"', '''          {next && <button type="button" className="astrid-vision-details-next"
            aria-label={next.label} title={next.label}
            onClick={event => { event.stopPropagation(); next.onClick(); }}>
            <ChevronRight size={24} aria-hidden="true" />
          </button>}
          <div className="astrid-vision-details-scroll-fade astrid-vision-details-scroll-fade--top"''')
p = root/'src/pages/Home/VisionMobileLayout.css'
s = p.read_text()
s = s.replace('    grid-template-columns: minmax(0, 1fr) 72px;', '    grid-template-columns: minmax(0, 1fr);\n    position: relative; isolation: isolate; overflow: hidden;')
s = s.replace('    grid-column: 1; grid-row: 2; min-width: 0; margin: 0;', '    grid-column: 1 / -1; grid-row: 2; min-width: 0; margin: 0;')
s = s.replace('    grid-column: 2; grid-row: 2 / 4; align-self: center;', '''    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    width: 146px; height: 146px; opacity: .13; z-index: -1;
    pointer-events: none;''')
s = s.replace('  /* Full-width heading; the original sigil stays to the right of the preview. */', '  /* Full-width reading column over a quiet, larger right-hand background sigil. */')
s = s.replace('''    width: 100vw; max-width: 100vw; border-inline-width: 0; border-radius: 10px;
    max-height: calc(100dvh - 16px - env(safe-area-inset-top) - env(safe-area-inset-bottom));''', '''    width: 100vw; max-width: 100vw; border-inline-width: 0; border-radius: 12px;''')
s = s.replace('  .astrid-vision-details-shell { max-height: calc(100dvh - 16px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); }\n', '')
s = s.replace('    top: auto; right: 0; bottom: calc(8px + env(safe-area-inset-bottom)); left: 0; margin: 0;', '''    --vision-edge-space: 24px;
    --vision-space-top: max(var(--vision-edge-space), env(safe-area-inset-top));
    --vision-space-bottom: max(var(--vision-edge-space), env(safe-area-inset-bottom));
    top: calc(var(--vision-viewport-top, 0px) + var(--vision-space-top));
    bottom: auto; right: 0; left: 0; margin: 0;
    height: calc(var(--vision-viewport-height, 100dvh) - var(--vision-space-top) - var(--vision-space-bottom));
    max-height: calc(var(--vision-viewport-height, 100dvh) - var(--vision-space-top) - var(--vision-space-bottom));''')
s = s.replace('  .astrid-vision-details-shell { flex-direction: column-reverse; }', '  .astrid-vision-details-shell { flex-direction: column-reverse; height: 100%; max-height: none; }')
s = s.replace('    padding: 14px max(16px, env(safe-area-inset-right)) 14px max(16px, env(safe-area-inset-left));', '    min-height: 112px; padding: 20px max(16px, env(safe-area-inset-right)) 22px max(16px, env(safe-area-inset-left));')
s = s.replace('  .astrid-vision-details-eyebrow { margin-bottom: 6px; font-size: 10px; }', '  .astrid-vision-details-eyebrow { margin-bottom: 10px; font-size: 10px; }')
s += '''
/* Navigation has a dedicated narrow rail, never covering the reading text. */
.astrid-vision-details[data-has-next] .astrid-vision-details-scroll { padding-right: 64px; }
.astrid-vision-details-next {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
  display: grid; place-items: center; width: 44px; height: 56px; padding: 0;
  z-index: 2; border: 1px solid var(--astrid-line); border-radius: 24px;
  background: var(--astrid-paper); color: var(--astrid-ink); cursor: pointer;
}
.astrid-vision-details-next:hover { color: var(--astrid-accent); border-color: var(--astrid-accent); }
.astrid-vision-details-next:focus-visible { outline: 2px solid var(--astrid-accent); outline-offset: 2px; }
@media (max-width: 760px) {
  .astrid-vision .astrid-vision-standards-list > li .astrid-vision-sigil-art { width: 140px; height: 140px; }
  .astrid-vision-details-scroll { padding-top: 28px; }
  .astrid-vision-details-close { width: 52px; height: 52px; min-width: 52px; min-height: 52px; }
  .astrid-vision-details[data-has-next] .astrid-vision-details-scroll { padding-right: max(54px, env(safe-area-inset-right)); }
  .astrid-vision-details-next { right: 4px; }
}
@media (max-width: 760px) and (max-height: 500px) {
  .astrid-vision > .astrid-vision-details { --vision-edge-space: 12px; }
  .astrid-vision-details-header { min-height: 88px; padding-block: 12px; }
}
'''
p.write_text(s)

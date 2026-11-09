import { useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';

export const VISION_SECTIONS = [
  { id: 'astrid-vision-overview', label: 'Vision' },
  { id: 'astrid-vision-principles', label: 'Principles' },
  { id: 'astrid-vision-gaps', label: 'Gaps' },
  { id: 'astrid-vision-projects', label: 'Projects' },
  { id: 'astrid-vision-contribute', label: 'Help us' },
] as const;

export function VisionSectionNav({ rootRef, active, reducedMotion, includeContribute, contentKey }: {
  rootRef: RefObject<HTMLElement>;
  active: boolean;
  reducedMotion: boolean;
  includeContribute: boolean;
  contentKey: string;
}) {
  const entries = useMemo(() => VISION_SECTIONS.filter(entry =>
    includeContribute || entry.id !== 'astrid-vision-contribute'), [includeContribute]);
  const [current, setCurrent] = useState<string>(VISION_SECTIONS[0].id);
  const [hovered, setHovered] = useState<string | null>(null);
  const appliedInitialHash = useRef(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!active || !root) return;
    const targets = entries.flatMap(entry => {
      const element = root.querySelector<HTMLElement>('#' + entry.id);
      return element ? [{ ...entry, element }] : [];
    });
    if (!targets.length) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      // Prefer the section crossing the reading line, even for very tall lists.
      const readingLine = Math.min(200, window.innerHeight * 0.28);
      let next = targets[0].id;
      for (const target of targets) {
        if (target.element.getBoundingClientRect().top <= readingLine) next = target.id;
      }
      const last = targets[targets.length - 1];
      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
      if (atBottom && last.element.getBoundingClientRect().top < window.innerHeight) next = last.id;
      setCurrent(previous => previous === next ? previous : next);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const followHash = () => {
      const target = targets.find(item => '#' + item.id === window.location.hash);
      if (target) {
        target.element.scrollIntoView({ block: 'start', behavior: 'instant' });
        setCurrent(target.id);
      }
      schedule();
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('hashchange', followHash);
    // Expanding gaps/projects and responsive reflows change section boundaries.
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    targets.forEach(target => resize?.observe(target.element));
    resize?.observe(root);
    const regions = [...root.querySelectorAll<HTMLElement>('[data-vision-section]')];
    const enter = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      setHovered((event.currentTarget as HTMLElement).dataset.visionSection ?? null);
    };
    const leave = () => setHovered(null);
    regions.forEach(region => {
      region.addEventListener('pointerenter', enter);
      region.addEventListener('pointerleave', leave);
    });
    if (!appliedInitialHash.current) {
      appliedInitialHash.current = true;
      followHash();
    } else schedule();
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('hashchange', followHash);
      resize?.disconnect();
      regions.forEach(region => {
        region.removeEventListener('pointerenter', enter);
        region.removeEventListener('pointerleave', leave);
      });
    };
  }, [active, contentKey, entries, rootRef]);

  const navigate = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = rootRef.current?.querySelector<HTMLElement>('#' + id);
    if (!target) return;
    event.preventDefault();
    // Keep router state intact; section selection does not create extra page history.
    window.history.replaceState(window.history.state, '', '#' + id);
    if (event.detail === 0) target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'instant' : 'smooth' });
    setCurrent(id);
  };

  if (!active) return null;
  return <nav className="astrid-vision-section-nav" aria-label="Vision page sections" data-current-section={current}>
    <ol>
      {entries.map(entry => <li key={entry.id}>
        <a href={'#' + entry.id} aria-current={current === entry.id ? 'location' : undefined}
          data-section-hovered={hovered === entry.id || undefined}
          onClick={event => navigate(event, entry.id)}>
          <span className="astrid-vision-nav-mark" aria-hidden="true" />
          <span>{entry.label}</span>
        </a>
      </li>)}
    </ol>
  </nav>;
}

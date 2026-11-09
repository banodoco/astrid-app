import { useEffect, useMemo, useRef, useState } from 'react';

const SECTIONS = [
  { id: 'astrid-vision-manifesto', label: 'Vision' },
  { id: 'astrid-vision-pillars', label: 'Pillars' },
  { id: 'astrid-vision-standards', label: 'Principles' },
  { id: 'astrid-vision-parts', label: 'Gaps' },
  { id: 'astrid-vision-projects', label: 'Projects' },
  { id: 'astrid-vision-contribute', label: 'Help us build' },
] as const;

/** On wide screens this is a small editorial side rail; on phones it becomes
 * a compact horizontal strip rather than covering the reading column. */
export function VisionSectionNav({ reducedMotion, includeHelp }: {
  reducedMotion: boolean;
  includeHelp: boolean;
}) {
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id);
  const navRef = useRef<HTMLElement>(null);
  const pendingJumpRef = useRef<string | null>(null);
  const finishJumpRef = useRef<() => void>(() => {});
  const jumpFallbackRef = useRef<number | undefined>(undefined);
  const sections = useMemo(() => SECTIONS.filter(section => includeHelp || section.id !== 'astrid-vision-contribute'), [includeHelp]);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      // A programmatic smooth jump passes through several sections. Do not
      // light up each intermediate link before arriving at the clicked one.
      if (pendingJumpRef.current) return;
      const targets = sections.map(({ id }) => document.getElementById(id)).filter(
        (element): element is HTMLElement => element !== null);
      if (!targets.length) return;
      const threshold = Math.min(window.innerHeight * .34, 260);
      let current = targets[0].id;
      for (const element of targets) {
        if (element.getBoundingClientRect().top <= threshold) current = element.id;
      }
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >=
          document.documentElement.scrollHeight - 8) current = targets[targets.length - 1].id;
      setActiveId(previous => previous === current ? previous : current);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    const finishJump = (force = false) => {
      const pending = pendingJumpRef.current;
      if (!pending) return;
      const target = document.getElementById(pending);
      if (!force && target) {
        const scrollMargin = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
        const top = target.getBoundingClientRect().top;
        const atBottom = window.scrollY + window.innerHeight >=
          document.documentElement.scrollHeight - 8;
        // An unrelated scrollend (or a layout transition) may fire while
        // the long smooth jump is still passing through other sections.
        if (!atBottom && Math.abs(top - scrollMargin) > 36) return;
      }
      pendingJumpRef.current = null;
      window.clearTimeout(jumpFallbackRef.current);
      schedule();
    };
    finishJumpRef.current = finishJump;
    const onPageScrollEnd = (event: Event) => {
      // The nested nav also scrolls horizontally; its scrollend must not
      // release our lock on a still-running *document* smooth-scroll.
      if (event.target === document || event.target === window) finishJump();
    };
    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('scrollend', onPageScrollEnd);
    window.addEventListener('resize', schedule);
    // A real user interruption should immediately restore scroll tracking.
    const interrupted = () => finishJump(true);
    window.addEventListener('wheel', interrupted, { passive: true });
    window.addEventListener('touchstart', interrupted, { passive: true });
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('scrollend', onPageScrollEnd);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('wheel', interrupted);
      window.removeEventListener('touchstart', interrupted);
      window.clearTimeout(jumpFallbackRef.current);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [sections]);

  // On phones, position the active section in the middle as far as the
  // horizontal scroll bounds allow. The first/last links naturally clamp.
  // Recenter as the Astrid wordmark folds and the nav gains more width.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const alignActive = (behavior: ScrollBehavior) => {
      const active = nav.querySelector<HTMLAnchorElement>('a[aria-current="location"]');
      if (!active || nav.scrollWidth <= nav.clientWidth) return;
      const navBox = nav.getBoundingClientRect();
      const linkBox = active.getBoundingClientRect();
      const desired = nav.scrollLeft + linkBox.left - navBox.left +
        linkBox.width / 2 - nav.clientWidth / 2;
      const bounded = Math.max(0, Math.min(nav.scrollWidth - nav.clientWidth, desired));
      nav.scrollTo({ left: bounded, behavior });
    };
    alignActive(reducedMotion ? 'auto' : 'smooth');
    const resize = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => alignActive('auto')) : null;
    resize?.observe(nav);
    return () => resize?.disconnect();
  }, [activeId, reducedMotion]);

  return (
    <nav ref={navRef} className="astrid-vision-section-nav" aria-label="Vision page sections">
      {sections.map(({ id, label }, index) => (
        <a key={id} href={'#' + id}
          aria-current={activeId === id ? 'location' : undefined}
          onClick={event => {
            const target = document.getElementById(id);
            if (!target) return;
            event.preventDefault();
            pendingJumpRef.current = id;
            // Update the highlight synchronously, then let the browser scroll.
            // While the jump runs, the scroll spy intentionally stays quiet.
            setActiveId(id);
            target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
            window.history.replaceState(window.history.state, '', '#' + id);
            window.clearTimeout(jumpFallbackRef.current);
            if (reducedMotion) {
              window.requestAnimationFrame(() => {
                if (pendingJumpRef.current === id) finishJumpRef.current();
              });
            } else {
              // Scrollend is widely supported, but a finite fallback protects
              // older WebKit and jumps that end without dispatching an event.
              jumpFallbackRef.current = window.setTimeout(() => {
                if (pendingJumpRef.current === id) finishJumpRef.current();
              }, 2500);
            }
          }}>
          <span className="astrid-vision-section-nav-index" aria-hidden="true">
            {String(index + 1).padStart(2, '0')}
          </span>
          <span>{label}</span>
        </a>
      ))}
    </nav>
  );
}

import { useEffect, useMemo, useState } from 'react';

const SECTIONS = [
  { id: 'astrid-vision-manifesto', label: 'Vision' },
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
  const sections = useMemo(() => SECTIONS.filter(section => includeHelp || section.id !== 'astrid-vision-contribute'), [includeHelp]);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
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
    schedule();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [sections]);

  return (
    <nav className="astrid-vision-section-nav" aria-label="Vision page sections">
      {sections.map(({ id, label }, index) => (
        <a key={id} href={'#' + id}
          aria-current={activeId === id ? 'location' : undefined}
          onClick={event => {
            const target = document.getElementById(id);
            if (!target) return;
            event.preventDefault();
            target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
            window.history.replaceState(window.history.state, '', '#' + id);
            setActiveId(id);
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

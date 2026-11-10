import { useLayoutEffect, useId, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ChevronDown, ExternalLink, X } from 'lucide-react';
import type { PublicVisionContent } from './publicVisionContent';
import { currentGapsForSubject, type VisionSubject } from './visionHierarchy';

// Keep each gap's palette identity stable across pillar and principle dialogs.
// These are editorial accents, not gap status colors; the actual status remains text.
const GAP_TONES = ['clay', 'ochre', 'sage', 'teal', 'blue', 'plum'] as const;

export function VisionDetailDialog({
  content, subject, onClose,
}: {
  content: PublicVisionContent;
  subject: VisionSubject;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const [scrollEdges, setScrollEdges] = useState({ top: false, bottom: false });
  const titleId = useId();
  const entry = subject.kind === 'pillar'
    ? content.pillars.find(pillar => pillar.id === subject.id)
    : content.principles.find(principle => principle.id === subject.id);
  const gaps = currentGapsForSubject(content, subject);

  useLayoutEffect(() => {
    if (dialogRef.current && !dialogRef.current.open) {
      dialogRef.current.showModal();
      // Focus the descriptive heading rather than the X: Safari otherwise
      // paints a strong focus ring on the auto-focused close button at open.
      titleRef.current?.focus({ preventScroll: true });
    }
  }, []);

  // Show a fade only where scrollable content actually continues. Observe both the
  // viewport and its content so expanded characteristics update the edges too.
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const inner = scrollContentRef.current;
    if (!viewport || !inner) return;

    const updateEdges = () => {
      const remaining = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const top = remaining > 2 && viewport.scrollTop > 2;
      const bottom = remaining > 2 && viewport.scrollTop < remaining - 2;
      setScrollEdges(previous =>
        previous.top === top && previous.bottom === bottom ? previous : { top, bottom });
    };

    viewport.addEventListener('scroll', updateEdges, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateEdges);
    observer?.observe(viewport);
    observer?.observe(inner);
    updateEdges();
    return () => {
      viewport.removeEventListener('scroll', updateEdges);
      observer?.disconnect();
    };
  }, [content.source.revision, subject.id, subject.kind]);

  const backdropPointerRef = useRef<number | null>(null);
  const closeScheduledRef = useRef(false);
  const isOutsidePanel = (clientX: number, clientY: number) => {
    const dialog = dialogRef.current;
    if (!dialog?.open) return false;
    const bounds = dialog.getBoundingClientRect();
    return clientX < bounds.left || clientX > bounds.right ||
      clientY < bounds.top || clientY > bounds.bottom;
  };
  const closeAfterGesture = () => {
    if (closeScheduledRef.current) return;
    closeScheduledRef.current = true;
    // Do not remove the modal during pointerdown: mobile Safari can retarget
    // the subsequent synthetic click to the underlying card.
    window.requestAnimationFrame(() => {
      closeScheduledRef.current = false;
      dialogRef.current?.close();
    });
  };

  if (!entry) return null;
  return (
    <dialog
      ref={dialogRef}
      className="astrid-vision-details"
      aria-labelledby={titleId}
      onClose={onClose}
      onPointerDownCapture={event => {
        if (!isOutsidePanel(event.clientX, event.clientY)) return;
        backdropPointerRef.current = event.pointerId;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerUpCapture={event => {
        if (backdropPointerRef.current !== event.pointerId) return;
        backdropPointerRef.current = null;
        event.preventDefault();
        event.stopPropagation();
        closeAfterGesture();
      }}
      onPointerCancelCapture={event => {
        if (backdropPointerRef.current === event.pointerId) backdropPointerRef.current = null;
      }}
      onClickCapture={event => {
        if (!isOutsidePanel(event.clientX, event.clientY)) return;
        event.preventDefault();
        event.stopPropagation();
        closeAfterGesture();
      }}
    >
      <div className="astrid-vision-details-shell">
        <header className="astrid-vision-details-header">
          <div className="astrid-vision-details-header-copy">
            <p className="astrid-vision-details-eyebrow">
              {subject.kind === 'pillar' ? 'What we’re building towards' : 'The principles that drive us'}
            </p>
            <h2 id={titleId} ref={titleRef} tabIndex={-1}>{entry.title}</h2>
          </div>
          <button
            type="button"
            className="astrid-vision-details-close"
            aria-label="Close details"
            onClick={() => dialogRef.current?.close()}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="astrid-vision-details-scroll-frame">
          <div className="astrid-vision-details-scroll" ref={scrollRef}>
            <div className="astrid-vision-details-scroll-inner" ref={scrollContentRef}>
          {entry.statement && entry.explanationMarkdown && entry.characteristics ? (
            <>
              <div className="astrid-vision-details-description">
                <p className="astrid-vision-details-statement">{entry.statement}</p>
                <ReactMarkdown>{entry.explanationMarkdown}</ReactMarkdown>
              </div>
              <section className="astrid-vision-details-characteristics" aria-label="Characteristics">
                <h3>What defines this</h3>
                <div className="astrid-vision-details-characteristic-list">
                  {entry.characteristics.map(characteristic => (
                    <details className="astrid-vision-details-characteristic" key={characteristic.id}>
                      <summary>
                        <span className="astrid-vision-details-characteristic-copy">
                          <strong>{characteristic.title}</strong>
                          <span>{characteristic.summary}</span>
                        </span>
                        <ChevronDown size={18} strokeWidth={1.75} aria-hidden="true" />
                      </summary>
                      <div className="astrid-vision-details-characteristic-body">
                        <ReactMarkdown>{characteristic.detailsMarkdown}</ReactMarkdown>
                      </div>
                    </details>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <div className="astrid-vision-details-description">
              <ReactMarkdown>{entry.bodyMarkdown}</ReactMarkdown>
            </div>
          )}
          <section className="astrid-vision-details-gaps" aria-label="Current gaps and projects">
          <h3>Gaps preventing this</h3>
          {gaps.length === 0 ? (
            <p className="astrid-vision-details-empty">No current gaps are linked to this {subject.kind}.</p>
          ) : (
            <ul className="astrid-vision-details-gap-list">
              {gaps.map(({ gap, projects }) => (
                <li key={gap.id} className="astrid-vision-details-gap"
                  data-tone={GAP_TONES[content.gaps.findIndex(item => item.id === gap.id) % GAP_TONES.length]}>
                  <div className="astrid-vision-details-gap-heading">
                    <h4>
                      <a href={gap.githubUrl} target="_blank" rel="noreferrer">
                        {gap.title}
                        <ExternalLink size={14} aria-hidden="true" />
                      </a>
                    </h4>
                  </div>
                  {projects.length > 0 ? (
                    <div className="astrid-vision-details-projects">
                      <p>Projects addressing this gap</p>
                      <ul>
                        {projects.map(project => (
                          <li key={project.id}>
                            <div className="astrid-vision-details-project-heading">
                              <a href={project.githubUrl} target="_blank" rel="noreferrer">
                                {project.title}
                                <ExternalLink size={14} aria-hidden="true" />
                              </a>
                              <span>{project.status}</span>
                            </div>
                            <div className="astrid-vision-details-project-goal">
                              <ReactMarkdown>{project.goalMarkdown}</ReactMarkdown>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="astrid-vision-details-empty">No current projects linked yet.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          </section>
            </div>
          </div>
          <div className="astrid-vision-details-scroll-fade astrid-vision-details-scroll-fade--top"
            data-visible={scrollEdges.top || undefined} aria-hidden="true" />
          <div className="astrid-vision-details-scroll-fade astrid-vision-details-scroll-fade--bottom"
            data-visible={scrollEdges.bottom || undefined} aria-hidden="true" />
        </div>
      </div>
    </dialog>
  );
}

import { useLayoutEffect, useId, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ChevronDown, ExternalLink, X } from 'lucide-react';
import type { PublicVisionContent, PublicVisionProject } from './publicVisionContent';
import { aspirationsForSubject, findAspiration, type VisionGapProjects, type VisionSubject } from './visionHierarchy';
import './VisionProjectDisclosure.css';

// Editorial accents retain the same identity across pillar and principle dialogs.
const GAP_TONES = ['clay', 'ochre', 'sage', 'teal', 'blue', 'plum'] as const;

function GapProjects({ projects }: { projects: PublicVisionProject[] }) {
  if (projects.length === 0) {
    return <p className="astrid-vision-details-empty">No current projects linked yet.</p>;
  }
  return (
    <div className="astrid-vision-details-projects astrid-vision-project-disclosures">
      <p>Projects addressing this gap</p>
      <ul>
        {projects.map(project => {
          // Use the authored introduction, not a rewritten slogan or a clipped sentence.
          const [intro, ...remaining] = project.goalMarkdown.trim().split(/\r?\n\s*\r?\n/);
          return (
            <li key={project.id}>
              <details className="astrid-vision-project" data-project-id={project.id}>
                <summary className="astrid-vision-project-summary">
                  <span className="astrid-vision-project-summary-copy">
                    <strong className="astrid-vision-project-title">{project.title}</strong>
                    <span className="astrid-vision-project-intro">
                      <ReactMarkdown
                        allowedElements={['p', 'strong', 'em', 'del', 'code', 'a', 'br']}
                        unwrapDisallowed
                        components={{
                          p: ({ children }) => <span>{children}</span>,
                          // The entire summary toggles the project; source links belong below it.
                          a: ({ children }) => <span>{children}</span>,
                        }}
                      >{intro}</ReactMarkdown>
                    </span>
                  </span>
                  <ChevronDown size={17} strokeWidth={1.75} aria-hidden="true" />
                </summary>
                <div className="astrid-vision-project-body">
                  {remaining.length > 0 && (
                    <div className="astrid-vision-details-project-goal">
                      <ReactMarkdown>{remaining.join('\n\n')}</ReactMarkdown>
                    </div>
                  )}
                  <dl className="astrid-vision-project-metadata">
                    {([
                      ['Status', project.status],
                      ['Owner', project.owner],
                      ['Estimate', project.estimate],
                      ['Waiting on', project.waitingOn],
                    ] as const).map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd><ReactMarkdown>{value}</ReactMarkdown></dd>
                      </div>
                    ))}
                  </dl>
                  <div className="astrid-vision-details-project-heading">
                    <a href={project.githubUrl} target="_blank" rel="noreferrer"
                      aria-label={'Read the full project plan: ' + project.title}>
                      Read the full project plan<ExternalLink size={14} aria-hidden="true" />
                    </a>
                  </div>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AspirationGap({ content, item }: { content: PublicVisionContent; item: VisionGapProjects }) {
  const { gap, projects } = item;
  const supporting = (gap.supportingAspirations ?? [])
    .map(ref => findAspiration(content, ref)?.title).filter(Boolean);
  const tone = GAP_TONES[content.gaps.findIndex(candidate => candidate.id === gap.id) % GAP_TONES.length];
  return (
    <details className="astrid-vision-details-gap" data-tone={tone} data-gap-id={gap.id}>
      <summary className="astrid-vision-details-gap-heading astrid-vision-details-gap-summary">
        <span className="astrid-vision-details-gap-summary-copy">
          <span className="astrid-vision-details-gap-title">{gap.title}</span>
          <span className="astrid-vision-details-gap-preview">
            {projects.length > 0 ? (
              <strong>{projects.length} {projects.length === 1 ? 'project' : 'projects'}</strong>
            ) : 'No project yet'}
          </span>
        </span>
        <ChevronDown size={17} strokeWidth={1.75} aria-hidden="true" />
      </summary>
      <div className="astrid-vision-details-gap-body">
        <div className="astrid-vision-details-gap-assessment">
          <span>{gap.assessment}</span>
          <a href={gap.githubUrl} target="_blank" rel="noreferrer">Gap on GitHub<ExternalLink size={13} aria-hidden="true" /></a>
        </div>
        <GapProjects projects={projects} />
        <dl className="astrid-vision-details-gap-description">
          {([
            ['Desired state', gap.desiredMarkdown],
            ['Current state', gap.currentMarkdown],
            ['What is missing', gap.missingMarkdown],
            ['Closure evidence', gap.closureEvidenceMarkdown],
          ] as const).map(([label, markdown]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd><ReactMarkdown>{markdown}</ReactMarkdown></dd>
            </div>
          ))}
        </dl>
        {supporting.length > 0 && (
          <p className="astrid-vision-details-supporting"><strong>Also relates to</strong> {supporting.join(' · ')}</p>
        )}
      </div>
    </details>
  );
}

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
  const hierarchy = aspirationsForSubject(content, subject);

  useLayoutEffect(() => {
    if (dialogRef.current && !dialogRef.current.open) {
      dialogRef.current.showModal();
      // Focus the descriptive heading rather than the X: Safari otherwise
      // paints a strong focus ring on the auto-focused close button at open.
      titleRef.current?.focus({ preventScroll: true });
    }
  }, []);

  // Show a fade only where scrollable content actually continues. Observe both the
  // viewport and its content so expanded aspirations, gaps and projects update the edges too.
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

  const backdropPointerRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const isOutsidePanel = (clientX: number, clientY: number) => {
    const dialog = dialogRef.current;
    if (!dialog?.open) return false;
    const bounds = dialog.getBoundingClientRect();
    return clientX < bounds.left || clientX > bounds.right ||
      clientY < bounds.top || clientY > bounds.bottom;
  };

  if (!entry) return null;
  return (
    <dialog
      ref={dialogRef}
      className="astrid-vision-details"
      aria-labelledby={titleId}
      onClose={onClose}
      onPointerDownCapture={event => {
        // Keep the native modal top layer until the gesture's final click.
        // A requestAnimationFrame after pointerup can precede Safari's click.
        backdropPointerRef.current = event.isPrimary && event.button === 0 &&
          event.target === event.currentTarget && isOutsidePanel(event.clientX, event.clientY)
          ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false } : null;
        if (backdropPointerRef.current) event.stopPropagation();
      }}
      onPointerMoveCapture={event => {
        const gesture = backdropPointerRef.current;
        if (gesture?.pointerId === event.pointerId &&
            Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) {
          gesture.moved = true;
        }
      }}
      onPointerUpCapture={event => {
        const gesture = backdropPointerRef.current;
        if (gesture?.pointerId !== event.pointerId) return;
        if (gesture.moved || !isOutsidePanel(event.clientX, event.clientY)) backdropPointerRef.current = null;
        event.stopPropagation();
        // Do not cancel the default action: consume the compatibility click below.
      }}
      onPointerCancelCapture={event => {
        if (backdropPointerRef.current?.pointerId === event.pointerId) backdropPointerRef.current = null;
      }}
      onClickCapture={event => {
        const beganOnBackdrop = backdropPointerRef.current !== null;
        backdropPointerRef.current = null;
        // Keyboard activation of a child can report (0, 0); coordinates alone
        // would mistake it for a backdrop click and break disclosures and links.
        if (event.target !== event.currentTarget || !isOutsidePanel(event.clientX, event.clientY)) return;
        event.preventDefault();
        event.stopPropagation();
        // This click already has a fixed target. It cannot activate a card beneath.
        if (beganOnBackdrop) dialogRef.current?.close();
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
          <button type="button" className="astrid-vision-details-close" aria-label="Close details"
            onClick={event => { event.stopPropagation(); dialogRef.current?.close(); }}>
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
                  <section className="astrid-vision-details-characteristics" aria-label="Aspirations">
                    <h3>Aspirations</h3>
                    <div className="astrid-vision-details-characteristic-list">
                      {hierarchy.aspirations.map(({ aspiration, gaps, hasMeasuredGap }) => (
                        <section className="astrid-vision-details-aspiration" key={aspiration.id} data-aspiration-id={aspiration.id}>
                          <details className="astrid-vision-details-characteristic">
                            <summary>
                              <span className="astrid-vision-details-characteristic-copy">
                                <strong>{aspiration.title}</strong><span>{aspiration.summary}</span>
                              </span>
                              <ChevronDown size={18} strokeWidth={1.75} aria-hidden="true" />
                            </summary>
                            <div className="astrid-vision-details-characteristic-body">
                              <ReactMarkdown>{aspiration.detailsMarkdown}</ReactMarkdown>
                            </div>
                          </details>
                          {gaps.length > 0 ? (
                            <ul className="astrid-vision-details-aspiration-gaps" aria-label={'Gaps for ' + aspiration.title}>
                              {gaps.map(item => <li key={item.gap.id}><AspirationGap content={content} item={item} /></li>)}
                            </ul>
                          ) : hierarchy.hasAspirationLinks ? (
                            <p className="astrid-vision-details-aspiration-empty">
                              {hasMeasuredGap ? 'No current gaps are measured against this.' : 'No gap is measured against this yet.'}
                            </p>
                          ) : null}
                        </section>
                      ))}
                    </div>
                  </section>
                </>
              ) : (
                <div className="astrid-vision-details-description"><ReactMarkdown>{entry.bodyMarkdown}</ReactMarkdown></div>
              )}
              {(!hierarchy.hasAspirationLinks || hierarchy.legacyGaps.length > 0) && (
                <section className="astrid-vision-details-gaps" aria-label="Current gaps and projects">
                  <h3>Gaps preventing this</h3>
                  {hierarchy.legacyGaps.length === 0 ? (
                    <p className="astrid-vision-details-empty">No current gaps are linked to this {subject.kind}.</p>
                  ) : (
                    <ul className="astrid-vision-details-gap-list">
                      {hierarchy.legacyGaps.map(({ gap, projects }) => (
                        <li key={gap.id} className="astrid-vision-details-gap"
                          data-tone={GAP_TONES[content.gaps.findIndex(item => item.id === gap.id) % GAP_TONES.length]}>
                          <div className="astrid-vision-details-gap-heading">
                            <h4><a href={gap.githubUrl} target="_blank" rel="noreferrer">{gap.title}<ExternalLink size={14} aria-hidden="true" /></a></h4>
                          </div>
                          <GapProjects projects={projects} />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
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

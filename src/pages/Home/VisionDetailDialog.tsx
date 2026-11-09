import { useEffect, useId, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { ExternalLink, X } from 'lucide-react';
import type { PublicVisionContent } from './publicVisionContent';
import { currentGapsForSubject, type VisionSubject } from './visionHierarchy';

export function VisionDetailDialog({
  content, subject, onClose,
}: {
  content: PublicVisionContent;
  subject: VisionSubject;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const entry = subject.kind === 'pillar'
    ? content.pillars.find(pillar => pillar.id === subject.id)
    : content.principles.find(principle => principle.id === subject.id);
  const gaps = currentGapsForSubject(content, subject);

  useEffect(() => {
    if (dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal();
  }, []);

  const closeIfOutside = (clientX: number, clientY: number) => {
    const dialog = dialogRef.current;
    if (!dialog || !dialog.open) return;
    const bounds = dialog.getBoundingClientRect();
    if (clientX < bounds.left || clientX > bounds.right ||
        clientY < bounds.top || clientY > bounds.bottom) dialog.close();
  };

  if (!entry) return null;
  return (
    <dialog
      ref={dialogRef}
      className="astrid-vision-details"
      aria-labelledby={titleId}
      onClose={onClose}
      // Backdrop events are dispatched to the dialog itself in native dialogs.
      // Coordinates work even when mobile Safari retargets a backdrop tap.
      onPointerDown={event => closeIfOutside(event.clientX, event.clientY)}
      onClick={event => {
        if (event.target === event.currentTarget) {
          closeIfOutside(event.clientX, event.clientY);
        }
      }}
    >
      <div className="astrid-vision-details-shell">
        <header className="astrid-vision-details-header">
          <div className="astrid-vision-details-header-copy">
            <p className="astrid-vision-details-eyebrow">
              {subject.kind === 'pillar' ? 'What we’re building towards' : 'The principles that drive us'}
            </p>
            <h2 id={titleId}>{entry.title}</h2>
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
        <div className="astrid-vision-details-scroll">
          <div className="astrid-vision-details-description">
            <ReactMarkdown>{entry.bodyMarkdown}</ReactMarkdown>
          </div>
          <section className="astrid-vision-details-gaps" aria-label="Current gaps and projects">
          <h3>Gaps preventing this</h3>
          {gaps.length === 0 ? (
            <p className="astrid-vision-details-empty">No current gaps are linked to this {subject.kind}.</p>
          ) : (
            <ul className="astrid-vision-details-gap-list">
              {gaps.map(({ gap, projects }) => (
                <li key={gap.id} className="astrid-vision-details-gap">
                  <h4>
                    <a href={gap.githubUrl} target="_blank" rel="noreferrer">
                      {gap.title}
                      <ExternalLink size={14} aria-hidden="true" />
                    </a>
                  </h4>
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
    </dialog>
  );
}

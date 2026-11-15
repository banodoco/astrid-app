import { VisionDialog } from './VisionDialog';
import ReactMarkdown from 'react-markdown';
import { ChevronDown, ExternalLink } from 'lucide-react';
import type { PublicVisionContent, PublicVisionProject } from './publicVisionContent';
import { aspirationsForSubject, splitAspirationDetails, type VisionGapProjects, type VisionSubject } from './visionHierarchy';
import './VisionProjectDisclosure.css';

// Editorial accents retain the same identity across pillar and principle dialogs.
const GAP_TONES = ['clay', 'ochre', 'sage', 'teal', 'blue', 'plum'] as const;

function GapProjects({ projects }: { projects: PublicVisionProject[] }) {
  if (projects.length === 0) return null;
  return (
    <div className="astrid-vision-details-projects astrid-vision-project-disclosures">
      <p>Projects addressing this gap</p>
      <ul>{projects.map(project => {
        const [intro] = project.goalMarkdown.trim().split(/\r?\n\s*\r?\n/);
        return <li key={project.id}>
          <article className="astrid-vision-project" data-project-id={project.id}>
            <div className="astrid-vision-project-summary-copy">
              <strong className="astrid-vision-project-title">{project.title}</strong>
              <div className="astrid-vision-project-intro"><ReactMarkdown>{intro}</ReactMarkdown></div>
            </div>
            <div className="astrid-vision-details-project-heading">
              <a href={project.githubUrl} target="_blank" rel="noreferrer"
                aria-label={'Read the full project plan: ' + project.title}>
                Read the full project plan<ExternalLink size={14} aria-hidden="true" />
              </a>
            </div>
          </article>
        </li>;
      })}</ul>
    </div>
  );
}

function AspirationDetails({ markdown }: { markdown: string }) {
  const { explanation, guidance, label } = splitAspirationDetails(markdown);
  return <>
    {explanation && <ReactMarkdown>{explanation}</ReactMarkdown>}
    {guidance && <details className="astrid-vision-guidance">
      <summary><span>{label}</span><ChevronDown size={16} aria-hidden="true" /></summary>
      <div className="astrid-vision-guidance-body"><ReactMarkdown>{guidance}</ReactMarkdown></div>
    </details>}
  </>;
}

function GapDesiredState({ markdown }: { markdown: string }) {
  return (
    <dl className="astrid-vision-details-gap-description">
      <div>
        <dt>Desired state</dt>
        <dd><ReactMarkdown>{markdown}</ReactMarkdown></dd>
      </div>
    </dl>
  );
}

function AspirationGap({ content, item }: { content: PublicVisionContent; item: VisionGapProjects }) {
  const { gap, projects } = item;
  const tone = GAP_TONES[content.gaps.findIndex(candidate => candidate.id === gap.id) % GAP_TONES.length];
  return (
    <details className="astrid-vision-details-gap" data-tone={tone} data-gap-id={gap.id}>
      <summary className="astrid-vision-details-gap-heading astrid-vision-details-gap-summary">
        <span className="astrid-vision-details-gap-summary-copy">
          <span className="astrid-vision-details-gap-title">{gap.title}</span>
          {projects.length > 0 && <span className="astrid-vision-details-gap-preview">
            <strong>{projects.length} {projects.length === 1 ? 'project' : 'projects'}</strong>
          </span>}
        </span>
        <ChevronDown size={17} strokeWidth={1.75} aria-hidden="true" />
      </summary>
      <div className="astrid-vision-details-gap-body">
        <GapDesiredState markdown={gap.desiredMarkdown} />
        <GapProjects projects={projects} />
      </div>
    </details>
  );
}

export function VisionDetailDialog({
  content, subject, onSelect, onClose,
}: {
  content: PublicVisionContent;
  subject: VisionSubject;
  onSelect: (subject: VisionSubject) => void;
  onClose: () => void;
}) {
  const entry = subject.kind === 'pillar'
    ? content.pillars.find(pillar => pillar.id === subject.id)
    : content.principles.find(principle => principle.id === subject.id);
  const hierarchy = aspirationsForSubject(content, subject);
  if (!entry) return null;
  const siblings = subject.kind === 'pillar' ? content.pillars : content.principles;
  const index = siblings.findIndex(item => item.id === subject.id);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  return (
    <VisionDialog title={entry.title}
      eyebrow={subject.kind === 'pillar' ? 'What we’re building' : 'What guides us'}
      identity={content.source.revision + ':' + subject.kind + ':' + subject.id} onClose={onClose}
      previous={previous ? { label: 'Previous ' + subject.kind + ': ' + previous.title,
        onClick: () => onSelect({ kind: subject.kind, id: previous.id }) } : undefined}
      next={next ? { label: 'Next ' + subject.kind + ': ' + next.title,
        onClick: () => onSelect({ kind: subject.kind, id: next.id }) } : undefined}>
              {entry.statement && entry.explanationMarkdown && entry.characteristics ? (
                <>
                  <div className="astrid-vision-details-description">
                    <p className="astrid-vision-details-statement">{entry.statement}</p>
                    <ReactMarkdown>{entry.explanationMarkdown}</ReactMarkdown>
                  </div>
                  <section className="astrid-vision-details-characteristics" aria-label="Goals">
                    <h3>Goals</h3>
                    <div className="astrid-vision-details-characteristic-list">
                      {hierarchy.aspirations.map(({ aspiration, gaps }) => (
                        <section className="astrid-vision-details-aspiration" key={aspiration.id} data-aspiration-id={aspiration.id}>
                          <details className="astrid-vision-details-characteristic">
                            <summary>
                              <span className="astrid-vision-details-characteristic-copy">
                                <strong>{aspiration.title}</strong><span>{aspiration.summary}</span>
                              </span>
                              <ChevronDown size={18} strokeWidth={1.75} aria-hidden="true" />
                            </summary>
                            <div className="astrid-vision-details-characteristic-body">
                              <AspirationDetails markdown={aspiration.detailsMarkdown} />
                            </div>
                          </details>
                          {gaps.length > 0 && (
                            <div className="astrid-vision-details-gap-group">
                              <h4 className="astrid-vision-details-gap-group-label">{gaps.length === 1 ? 'Gap' : 'Gaps'}</h4>
                              <ul className="astrid-vision-details-aspiration-gaps" aria-label={'Gaps for ' + aspiration.title}>
                                {gaps.map(item => <li key={item.gap.id}><AspirationGap content={content} item={item} /></li>)}
                              </ul>
                            </div>
                          )}
                        </section>
                      ))}
                    </div>
                  </section>
                </>
              ) : (
                <div className="astrid-vision-details-description"><ReactMarkdown>{entry.bodyMarkdown}</ReactMarkdown></div>
              )}
              {hierarchy.legacyGaps.length > 0 && (
                <section className="astrid-vision-details-gaps" aria-label="Current gaps and projects">
                  <h3 className="astrid-vision-details-gap-group-label">{hierarchy.legacyGaps.length === 1 ? 'Gap' : 'Gaps'}</h3>
                    <ul className="astrid-vision-details-gap-list">
                      {hierarchy.legacyGaps.map(({ gap, projects }) => (
                        <li key={gap.id} className="astrid-vision-details-gap"
                          data-tone={GAP_TONES[content.gaps.findIndex(item => item.id === gap.id) % GAP_TONES.length]}>
                          <div className="astrid-vision-details-gap-heading">
                            <h4><a href={gap.githubUrl} target="_blank" rel="noreferrer">{gap.title}<ExternalLink size={14} aria-hidden="true" /></a></h4>
                          </div>
                          <GapDesiredState markdown={gap.desiredMarkdown} />
                          <GapProjects projects={projects} />
                        </li>
                      ))}
                    </ul>
                </section>
              )}
    </VisionDialog>
  );
}

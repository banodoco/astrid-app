import { VisionDialog } from './VisionDialog';
import ReactMarkdown from 'react-markdown';
import { ChevronDown, ExternalLink } from 'lucide-react';
import type { PublicVisionContent, PublicVisionProject } from './publicVisionContent';
import { aspirationsForSubject, type VisionGapProjects, type VisionSubject } from './visionHierarchy';
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
          <span className="astrid-vision-details-gap-preview">
            {projects.length > 0 ? (
              <strong>{projects.length} {projects.length === 1 ? 'project' : 'projects'}</strong>
            ) : 'No project yet'}
          </span>
        </span>
        <span className="astrid-vision-details-gap-label">Gap</span>
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
  content, subject, onClose,
}: {
  content: PublicVisionContent;
  subject: VisionSubject;
  onClose: () => void;
}) {
  const entry = subject.kind === 'pillar'
    ? content.pillars.find(pillar => pillar.id === subject.id)
    : content.principles.find(principle => principle.id === subject.id);
  const hierarchy = aspirationsForSubject(content, subject);
  if (!entry) return null;
  return (
    <VisionDialog title={entry.title}
      eyebrow={subject.kind === 'pillar' ? 'What we’re building towards' : 'The principles that drive us'}
      identity={content.source.revision + ':' + subject.kind + ':' + subject.id} onClose={onClose}>
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
                          <div className="astrid-vision-details-gap-heading astrid-vision-details-gap-heading--labelled">
                            <h4><a href={gap.githubUrl} target="_blank" rel="noreferrer">{gap.title}<ExternalLink size={14} aria-hidden="true" /></a></h4>
                            <span className="astrid-vision-details-gap-label">Gap</span>
                          </div>
                          <GapDesiredState markdown={gap.desiredMarkdown} />
                          <GapProjects projects={projects} />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
    </VisionDialog>
  );
}

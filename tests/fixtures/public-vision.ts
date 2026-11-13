import type { PublicVisionContent, PublicVisionSubject } from '../../src/pages/Home/publicVisionContent';

/** Offline fixture: every relationship is intentional, independent of today's live roadmap. */
export function visionFixture(): PublicVisionContent {
  const revision = 'a'.repeat(40);
  const base = `https://github.com/banodoco/astrid-dev/blob/${revision}/`;
  const subject = (id: string, title: string): PublicVisionSubject => ({
    id, title, bodyMarkdown: 'An open creative workspace.', statement: 'Creators shape the tools they use.',
    explanationMarkdown: 'Our tools should support ambitious work while keeping decisions in the hands of the people creating it.',
    characteristics: [
      { id: 'agency', title: 'Creative agency', summary: 'Creators direct their work.',
        detailsMarkdown: 'People can shape the tools around their work, inspect their choices and return to earlier decisions as they learn.\n\n**We should:**\n\n- Keep choices reversible.\n\n**We should never:**\n\n- Hide an irreversible choice.' },
      { id: 'continuity', title: 'Sustained practice', summary: 'Work stays editable over time.',
        detailsMarkdown: 'Projects preserve the context of creative decisions so a person or agent can continue the work in a later session.' },
      { id: 'exploration', title: 'Room to explore', summary: 'Trying a new direction stays possible.',
        detailsMarkdown: 'Creators can explore unfamiliar directions without losing the work they have already made or the tools they understand.' },
    ],
  });
  const gap = (id: string, title: string, aspiration: string) => ({
    id, title, assessment: 'open', assessmentDetail: 'Open',
    appliesTo: ['pillar:art'], primaryAppliesTo: 'pillar:art', aspiration, supportingAspirations: [] as string[],
    desiredMarkdown: 'The creator can make the complete work.', currentMarkdown: 'A manual workaround is still required.',
    missingMarkdown: 'The reusable connection is missing.', closureEvidenceMarkdown: 'A creator completes the journey without the workaround.',
    githubUrl: base + 'vision/gaps/' + id + '-example.md',
  });
  return {
    schemaVersion: 1, source: { repository: 'banodoco/astrid-dev', revision },
    vision: { title: 'A tool for artistic ambition', introMarkdown: 'A shared foundation for ambitious creative work.',
      agentPrompt: 'Read the contribution guide and find the smallest useful contribution.', contributeMarkdown: 'Help build the next part of Astrid.' },
    pillars: [['art', 'Artistic ambition'], ['tools', 'Liquid software'], ['learning', 'Compounding intelligence'], ['community', 'Shared endeavour']]
      .map(([id, title]) => ({ ...subject(id, title), descriptor: 'A shared creative foundation' })),
    principles: [['open-by-design', 'Open by design'], ['in-the-creators-control', 'Creator control'],
      ['local-first-cloud-capable', 'Local and cloud by choice'], ['eliminate-needless-technical-wrangling', 'Less technical wrangling']]
      .map(([id, title]) => subject(id, title)),
    gaps: [
      { ...gap('AA-001', 'Finish ambitious work', 'pillar:art/agency'),
        supportingAspirations: ['principle:open-by-design/agency'], appliesTo: ['pillar:art', 'principle:open-by-design'] },
      gap('AA-002', 'Explore new media', 'pillar:art/agency'),
      { ...gap('AA-003', 'Keep creative history', 'pillar:art/continuity'), assessment: 'closed' },
    ],
    projects: ['Live composition', 'Reusable tools', 'Editable history'].map((title, index) => ({
      id: '0' + (index + 1) + '-example', title, goalMarkdown: 'Make the complete creative journey work reliably without an extra manual step.',
      status: 'queued', owner: 'Unassigned', estimate: 'TBD', waitingOn: '—', priorityOrder: index + 1,
      gapIds: ['AA-001'], primaryGapId: 'AA-001', githubUrl: base + 'plans/0' + (index + 1) + '-example/plan.md',
    })),
  };
}

export function legacyVisionFixture(): PublicVisionContent {
  const value = visionFixture();
  for (const gap of value.gaps) { delete gap.aspiration; delete gap.supportingAspirations; }
  return value;
}

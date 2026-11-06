import { describe, expect, it } from 'vitest';
import { parsePublicVisionContent } from './publicVisionContent';

const sha = 'a'.repeat(40);
const blob = 'https://github.com/banodoco/astrid-dev/blob/' + sha + '/';
const fixture = () => ({
  schemaVersion: 1,
  source: { repository: 'banodoco/astrid-dev', revision: sha },
  vision: { title: 'A purpose', introMarkdown: 'Creative tools for people' },
  pillars: ['art', 'tools', 'learning', 'community'].map(id => ({
    id, title: 'Pillar ' + id, descriptor: 'A meaningful descriptor', bodyMarkdown: 'Details',
  })),
  principles: [{ id: 'open', title: 'Open', bodyMarkdown: 'Built in the open' }],
  gaps: [{
    id: 'AA-001', title: 'Missing outcome', assessment: 'open',
    assessmentDetail: 'Open (evidence under review)',
    appliesTo: ['pillar:art'], desiredMarkdown: 'The target', currentMarkdown: 'Current reality',
    missingMarkdown: 'What is missing', closureEvidenceMarkdown: 'Proof',
    githubUrl: blob + 'visions/gaps/AA-001-creative.md',
  }],
  projects: [{
    id: '01-example', title: 'An open project', goalMarkdown: 'A bounded improvement',
    status: 'queued', owner: 'Unassigned', estimate: 'TBD', waitingOn: '—',
    priorityOrder: 1, gapIds: ['AA-001'],
    githubUrl: blob + 'plans/01-example/plan.md',
  }],
});

describe('public vision live data contract', () => {
  it('accepts an approved versioned feed', () => {
    expect(parsePublicVisionContent(fixture()).projects).toHaveLength(1);
  });
  it('allows legitimate project additions and completion without reauthoring the app', () => {
    const value = fixture();
    value.projects[0].status = 'done';
    value.projects.push({
      ...value.projects[0], id: '02-next', priorityOrder: 2, status: 'queued',
      githubUrl: blob + 'plans/02-next/plan.md',
    });
    expect(parsePublicVisionContent(value).projects).toHaveLength(2);
  });
  it('rejects incompatible schema or invalid origin', () => {
    expect(() => parsePublicVisionContent({ ...fixture(), schemaVersion: 2 })).toThrow();
    expect(() => parsePublicVisionContent({ ...fixture(), source: { repository: 'other/repo', revision: sha } })).toThrow();
  });
  it('rejects missing evidence and broken relationships', () => {
    const value = fixture();
    value.gaps[0].appliesTo = ['pillar:nonexistent'];
    expect(() => parsePublicVisionContent(value)).toThrow();
    value.gaps[0].appliesTo = ['pillar:art'];
    value.projects[0].gapIds = ['XX-999'];
    expect(() => parsePublicVisionContent(value)).toThrow();
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePublicVisionContent } from './publicVisionContent';
import { visionFixture, legacyVisionFixture } from '../../../tests/fixtures/public-vision';

const sha = 'a'.repeat(40);
const blob = 'https://github.com/banodoco/astrid-dev/blob/' + sha + '/';
const fixture = () => ({
  schemaVersion: 1,
  source: { repository: 'banodoco/astrid-dev', revision: sha },
  vision: { title: 'A purpose', introMarkdown: 'Creative tools for people', agentPrompt: 'Exact prompt from the root README' },
  pillars: ['art', 'tools', 'learning', 'community'].map(id => ({
    id, title: 'Pillar ' + id, descriptor: 'A meaningful descriptor', bodyMarkdown: 'Details',
  })),
  principles: [{ id: 'open', title: 'Open', bodyMarkdown: 'Built in the open' }],
  gaps: [{
    id: 'AA-001', title: 'Missing outcome', assessment: 'open',
    assessmentDetail: 'Open (evidence under review)',
    appliesTo: ['pillar:art'], primaryAppliesTo: 'pillar:art', desiredMarkdown: 'The target', currentMarkdown: 'Current reality',
    missingMarkdown: 'What is missing', closureEvidenceMarkdown: 'Proof',
    githubUrl: blob + 'vision/gaps/AA-001-creative.md',
  }],
  projects: [{
    id: '01-example', title: 'An open project', goalMarkdown: 'A bounded improvement',
    status: 'queued', owner: 'Unassigned', estimate: 'TBD', waitingOn: '—',
    priorityOrder: 1, gapIds: ['AA-001'], primaryGapId: 'AA-001',
    githubUrl: blob + 'plans/01-example/plan.md',
  }],
});

describe('public vision live data contract', () => {
  it('accepts an approved versioned feed', () => {
    expect(parsePublicVisionContent(fixture()).projects).toHaveLength(1);
  });
  it('accepts the exact optional root README agent prompt, and rejects a malformed one', () => {
    const withPrompt = fixture();
    expect(parsePublicVisionContent(withPrompt).vision.agentPrompt).toBe('Exact prompt from the root README');
    const oldFeed = { ...withPrompt, vision: { title: withPrompt.vision.title, introMarkdown: withPrompt.vision.introMarkdown } };
    expect(parsePublicVisionContent(oldFeed).vision.agentPrompt).toBeUndefined();
    expect(() => parsePublicVisionContent({ ...withPrompt, vision: { ...withPrompt.vision, agentPrompt: '' } })).toThrow();
  });

  it('accepts the published paths after visions/ was renamed to vision/', () => {
    expect(parsePublicVisionContent(fixture()).gaps[0].githubUrl)
      .toBe(blob + 'vision/gaps/AA-001-creative.md');
    const legacy = fixture();
    legacy.gaps[0].githubUrl = blob + 'visions/gaps/AA-001-creative.md';
    expect(parsePublicVisionContent(legacy).gaps).toHaveLength(1);
    const unrelated = fixture();
    unrelated.gaps[0].githubUrl = blob + 'unrelated/gaps/AA-001-creative.md';
    expect(() => parsePublicVisionContent(unrelated)).toThrow();
  });

  it('accepts the exact Astrid Dev exporter candidate when supplied by cross-repo CI', () => {
    const file = process.env.PUBLIC_VISION_FEED_FILE;
    if (!file) return; // Ordinary App unit tests use the local fixture.
    const candidate = JSON.parse(readFileSync(file, 'utf8'));
    const result = parsePublicVisionContent(candidate);
    expect(result.source.repository).toBe('banodoco/astrid-dev');
    expect(result.pillars).toHaveLength(4);
    expect(result.principles).toHaveLength(4);
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  it('accepts a consistent goal hierarchy on both pillars and principles', () => {
    const value = fixture();
    const addStructure = <T extends { id: string; title: string }>(subject: T) => ({
      ...subject,
      statement: 'An opening statement.',
      explanationMarkdown: 'A short explanation of the underlying commitment.',
      goals: [
        { id: 'agency', title: 'Artistic agency', summary: 'Creators direct their work.', detailsMarkdown: 'People can inspect and adjust their tools.' },
        { id: 'continuity', title: 'Continuity', summary: 'Work stays editable.', detailsMarkdown: 'Projects retain their history across sessions.' },
      ],
    });
    const candidate = {
      ...value,
      pillars: value.pillars.map(addStructure),
      principles: value.principles.map(addStructure),
    };
    expect(parsePublicVisionContent(candidate).pillars[0].goals).toHaveLength(2);
    expect(() => parsePublicVisionContent({
      ...candidate, principles: [value.principles[0]],
    })).toThrow(/structured/);
    expect(() => parsePublicVisionContent({
      ...candidate,
      pillars: [{ ...candidate.pillars[0], goals: [{ id: 'x', title: 'Only one', summary: 'One sentence.', detailsMarkdown: 'More.' }] }, ...candidate.pillars.slice(1)],
    })).toThrow(/structured/);
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
  it('rejects inconsistent primary gap and subject relationships', () => {
    const value = fixture();
    value.gaps[0].primaryAppliesTo = 'principle:open';
    expect(() => parsePublicVisionContent(value)).toThrow();
    value.gaps[0].primaryAppliesTo = 'pillar:art';
    value.projects[0].primaryGapId = 'XX-999';
    expect(() => parsePublicVisionContent(value)).toThrow();
    value.projects[0].primaryGapId = 'AA-001';
    expect(parsePublicVisionContent(value).projects).toHaveLength(1);
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


describe('schema-v1 goal compatibility', () => {
  it('normalizes legacy wire fields into the canonical Goals model', () => {
    const snapshot = visionFixture();
    for (const subject of [...snapshot.pillars, ...snapshot.principles]) {
      subject.characteristics = subject.goals;
      delete subject.goals;
    }
    for (const gap of snapshot.gaps) {
      gap.aspiration = gap.goal;
      gap.supportingAspirations = gap.supportingGoals;
      delete gap.goal;
      delete gap.supportingGoals;
    }
    const parsed = parsePublicVisionContent(snapshot);
    expect(parsed.pillars[0].goals).toHaveLength(3);
    expect(parsed.gaps[0].goal).toBe('pillar:art/agency');
    expect(parsed.gaps[0].supportingGoals).toEqual(['principle:open-by-design/agency']);
  });
  it('rejects contradictory old and new goal identities', () => {
    const subjectMismatch = visionFixture();
    subjectMismatch.pillars[0].characteristics = [{ id: 'other', title: 'Changed', summary: 'Different', detailsMarkdown: 'Different' }];
    expect(() => parsePublicVisionContent(subjectMismatch)).toThrow(/compatibility fields disagree/);
    const gapMismatch = visionFixture();
    gapMismatch.gaps[0].aspiration = 'pillar:art/continuity';
    expect(() => parsePublicVisionContent(gapMismatch)).toThrow(/compatibility fields disagree/);
  });
});

describe('goal references in schema v1', () => {
  it('accepts new links and legacy feeds without renaming goals', () => {
    expect(parsePublicVisionContent(visionFixture()).gaps[0].goal).toBe('pillar:art/agency');
    expect(parsePublicVisionContent(legacyVisionFixture()).gaps[0].goal).toBeUndefined();
    const candidate = visionFixture();
    delete candidate.gaps[1].supportingGoals;
    expect(parsePublicVisionContent(candidate).pillars[0].goals).toHaveLength(3);
  });
  it('rejects a missing goal, an unresolved primary or supporting reference, and duplicates', () => {
    for (const invalid of ['pillar:missing/agency', 'pillar:art/missing', 'pillar:art']) {
      const candidate = visionFixture(); candidate.gaps[0].goal = invalid;
      expect(() => parsePublicVisionContent(candidate)).toThrow(/goals/);
    }
    const missing = visionFixture(); delete missing.gaps[0].goal;
    expect(() => parsePublicVisionContent(missing)).toThrow(/goals/);
    for (const refs of [['principle:open-by-design/missing'], ['pillar:art/agency'],
      ['principle:open-by-design/agency', 'principle:open-by-design/agency']]) {
      const candidate = visionFixture(); candidate.gaps[0].supportingGoals = refs;
      expect(() => parsePublicVisionContent(candidate)).toThrow(/goals/);
    }
  });
  it('rejects null rather than treating it as an omitted supporting list', () => {
    const candidate = visionFixture();
    const invalid = { ...candidate, gaps: candidate.gaps.map(gap => ({ ...gap, supportingGoals: null })) };
    expect(() => parsePublicVisionContent(invalid)).toThrow(/goals/);
  });
  it('requires the same primary and deduplicated supporting elements in old and new fields', () => {
    const candidate = visionFixture();
    candidate.gaps[0].supportingGoals!.push('pillar:art/continuity', 'principle:open-by-design/continuity');
    expect(parsePublicVisionContent(candidate).gaps[0].appliesTo).toHaveLength(2);
    candidate.gaps[0].appliesTo = ['pillar:art'];
    expect(() => parsePublicVisionContent(candidate)).toThrow(/disagree/);
    const moved = visionFixture(); moved.gaps[0].goal = 'pillar:tools/agency';
    expect(() => parsePublicVisionContent(moved)).toThrow(/disagree/);
  });
});

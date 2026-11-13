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

  it('accepts a consistent characteristic hierarchy on both pillars and principles', () => {
    const value = fixture();
    const addStructure = <T extends { id: string; title: string }>(subject: T) => ({
      ...subject,
      statement: 'An opening statement.',
      explanationMarkdown: 'A short explanation of the underlying commitment.',
      characteristics: [
        { id: 'agency', title: 'Artistic agency', summary: 'Creators direct their work.', detailsMarkdown: 'People can inspect and adjust their tools.' },
        { id: 'continuity', title: 'Continuity', summary: 'Work stays editable.', detailsMarkdown: 'Projects retain their history across sessions.' },
      ],
    });
    const candidate = {
      ...value,
      pillars: value.pillars.map(addStructure),
      principles: value.principles.map(addStructure),
    };
    expect(parsePublicVisionContent(candidate).pillars[0].characteristics).toHaveLength(2);
    expect(() => parsePublicVisionContent({
      ...candidate, principles: [value.principles[0]],
    })).toThrow(/structured/);
    expect(() => parsePublicVisionContent({
      ...candidate,
      pillars: [{ ...candidate.pillars[0], characteristics: [{ id: 'x', title: 'Only one', summary: 'One sentence.', detailsMarkdown: 'More.' }] }, ...candidate.pillars.slice(1)],
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


describe('aspiration references in schema v1', () => {
  it('accepts new links and legacy feeds without renaming characteristics', () => {
    expect(parsePublicVisionContent(visionFixture()).gaps[0].aspiration).toBe('pillar:art/agency');
    expect(parsePublicVisionContent(legacyVisionFixture()).gaps[0].aspiration).toBeUndefined();
    const candidate = visionFixture();
    delete candidate.gaps[1].supportingAspirations;
    expect(parsePublicVisionContent(candidate).pillars[0].characteristics).toHaveLength(3);
  });
  it('rejects a missing aspiration, an unresolved primary or supporting reference, and duplicates', () => {
    for (const invalid of ['pillar:missing/agency', 'pillar:art/missing', 'pillar:art']) {
      const candidate = visionFixture(); candidate.gaps[0].aspiration = invalid;
      expect(() => parsePublicVisionContent(candidate)).toThrow(/aspirations/);
    }
    const missing = visionFixture(); delete missing.gaps[0].aspiration;
    expect(() => parsePublicVisionContent(missing)).toThrow(/aspirations/);
    for (const refs of [['principle:open-by-design/missing'], ['pillar:art/agency'],
      ['principle:open-by-design/agency', 'principle:open-by-design/agency']]) {
      const candidate = visionFixture(); candidate.gaps[0].supportingAspirations = refs;
      expect(() => parsePublicVisionContent(candidate)).toThrow(/aspirations/);
    }
  });
  it('requires the same primary and deduplicated supporting elements in old and new fields', () => {
    const candidate = visionFixture();
    candidate.gaps[0].supportingAspirations!.push('pillar:art/continuity', 'principle:open-by-design/continuity');
    expect(parsePublicVisionContent(candidate).gaps[0].appliesTo).toHaveLength(2);
    candidate.gaps[0].appliesTo = ['pillar:art'];
    expect(() => parsePublicVisionContent(candidate)).toThrow(/disagree/);
    const moved = visionFixture(); moved.gaps[0].aspiration = 'pillar:tools/agency';
    expect(() => parsePublicVisionContent(moved)).toThrow(/disagree/);
  });
});

import { visionFixture, legacyVisionFixture } from '../../../tests/fixtures/public-vision';
import { describe, expect, it } from 'vitest';
import type { PublicVisionContent } from './publicVisionContent';
import { goalsForSubject, findGoal, currentGapsForSubject, splitGoalDetails } from './visionHierarchy';

const content = {
  gaps: [
    { id: 'G1', title: 'First gap', assessment: 'open', appliesTo: ['pillar:art', 'principle:open'] },
    { id: 'G2', title: 'Second gap', assessment: 'partially evidenced', appliesTo: ['pillar:art'] },
    { id: 'G3', title: 'Closed gap', assessment: 'closed', appliesTo: ['pillar:art'] },
    { id: 'G4', title: 'Other gap', assessment: 'open', appliesTo: ['principle:open'] },
  ],
  projects: [
    { id: 'P1', status: 'queued', gapIds: ['G1', 'G2'] },
    { id: 'P2', status: 'active', gapIds: ['G1'] },
    { id: 'P3', status: 'done', gapIds: ['G1'] },
    { id: 'P4', status: 'cancelled', gapIds: ['G2'] },
    { id: 'P5', status: 'blocked', gapIds: ['G3', 'G4'] },
    { id: 'P6', status: 'paused', gapIds: ['G4'] },
  ],
} as unknown as PublicVisionContent;

describe('public vision hierarchy', () => {
  it('connects pillar gaps to current project plans without duplicates or completed work', () => {
    const entries = currentGapsForSubject(content, { kind: 'pillar', id: 'art' });
    expect(entries.map(({ gap }) => gap.title)).toEqual(['First gap', 'Second gap']);
    expect(entries.map(({ projects }) => projects.map(project => project.id)))
      .toEqual([['P1', 'P2'], []]);
  });

  it('uses only primary gap and subject relationships, keeping secondary connections out of repeated cards', () => {
    const entries = currentGapsForSubject(content, { kind: 'principle', id: 'open' });
    expect(entries.map(({ gap }) => gap.id)).toEqual(['G4']);
    expect(entries[0].projects.map(project => project.id)).toEqual(['P6']);
    expect(currentGapsForSubject(content, { kind: 'pillar', id: 'missing' })).toEqual([]);
    const withoutProjects = { ...content, projects: [] } as PublicVisionContent;
    expect(currentGapsForSubject(withoutProjects, { kind: 'pillar', id: 'art' })[0].projects).toEqual([]);
  });
});


describe('goal grouping', () => {
  it('shows each gap once under its primary goal, not its supporting goal', () => {
    const value = visionFixture();
    const grouped = goalsForSubject(value, { kind: 'pillar', id: 'art' });
    expect(grouped.goals.map(row => row.gaps.map(item => item.gap.id)))
      .toEqual([['AA-001', 'AA-002'], [], []]);
    expect(grouped.legacyGaps).toEqual([]);
    expect(goalsForSubject(value, { kind: 'principle', id: 'open-by-design' })
      .goals.every(row => row.gaps.length === 0)).toBe(true);
  });
  it('counts all primary projects and chooses the lowest priority order, including legacy gapIds fallback', () => {
    const value = visionFixture();
    value.projects.reverse();
    delete value.projects[0].primaryGapId;
    value.projects[1].status = 'done';
    const [first, empty] = goalsForSubject(value, { kind: 'pillar', id: 'art' }).goals[0].gaps;
    expect(first.projects.map(item => item.title)).toEqual(['Live composition', 'Reusable tools', 'Editable history']);
    expect(empty.projects).toEqual([]);
  });
  it('distinguishes no measured gap from a closed measured gap and keeps older feeds flat', () => {
    const grouped = goalsForSubject(visionFixture(), { kind: 'pillar', id: 'art' });
    expect(grouped.goals.map(item => item.hasMeasuredGap)).toEqual([true, true, false]);
    const legacy = goalsForSubject(legacyVisionFixture(), { kind: 'pillar', id: 'art' });
    expect(legacy.hasGoalLinks).toBe(false);
    expect(legacy.legacyGaps).toHaveLength(2);
    expect(legacy.goals.every(row => row.gaps.length === 0)).toBe(true);
  });
  it('resolves supporting labels without inventing a name for a broken reference', () => {
    expect(findGoal(visionFixture(), 'principle:open-by-design/agency')?.title).toBe('Creative agency');
    expect(findGoal(visionFixture(), 'pillar:art/missing')).toBeUndefined();
  });
});


describe('optional goal guidance', () => {
  const prose = 'Keep the full authored explanation, including its examples and tradeoffs.';
  const rules = '**We should:**\n\n- Preserve [the source](https://example.com).\n\n**We should never:**\n\n- Hide a consequential decision.';
  it('separates both terminal lists without rewriting either block', () => {
    expect(splitGoalDetails(prose + '\n\n' + rules)).toEqual({
      explanation: prose, guidance: rules, label: 'We should / We should never',
    });
  });
  it('leaves a plain explanation untouched with no empty disclosure', () => {
    expect(splitGoalDetails(prose)).toEqual({ explanation: prose, guidance: '', label: '' });
  });
  it('does not interpret inline, quoted, indented or fenced examples as guidance', () => {
    for (const text of [prose + ' **We should:** keep this inline.', '> **We should:**\n> - A quoted example.',
      '    **We should:**\n    - An indented example.', '```md\n' + rules + '\n```', '~~~~md\n' + rules + '\n~~~~']) {
      expect(splitGoalDetails(text)).toEqual({ explanation: text, guidance: '', label: '' });
    }
  });
  it('recognizes real lists following a fenced example and normalizes CRLF safely', () => {
    const introduction = '```md\n**We should:**\n```\n\n' + prose;
    expect(splitGoalDetails((introduction + '\n\n' + rules).replaceAll('\n', '\r\n')))
      .toEqual({ explanation: introduction, guidance: rules, label: 'We should / We should never' });
  });
  it('preserves a partial legacy guidance block and ignores empty labels', () => {
    const legacy = '**We should never:**\n\n- Lose the artist’s work.';
    expect(splitGoalDetails(prose + '\n\n' + legacy)).toEqual({ explanation: prose, guidance: legacy, label: 'We should never' });
    const empty = prose + '\n\n**We should:**';
    expect(splitGoalDetails(empty).guidance).toBe('');
    expect(splitGoalDetails(empty).explanation).toBe(empty);
  });
});

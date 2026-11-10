import { describe, expect, it } from 'vitest';
import type { PublicVisionContent } from './publicVisionContent';
import { currentGapsForSubject } from './visionHierarchy';

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

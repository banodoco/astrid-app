import { describe, expect, it } from 'vitest';

import conformance from './__fixtures__/occurrence-window/start-trimmed-multi-clip.json';
import fixture from './shotComposition.fixture.json';
import { createShotCompositionAdapter } from './shotCompositionAdapter.ts';
import { projectCanonicalComposition } from './shotCompositionProjection.ts';

// The fixture is the cross-repo conformance vector (byte-identical copy of the Agent/Runtime file).
const start = conformance.occurrence.source_offset.start;

/** Run the fixture's occurrence and clips through the App adapter + projection. */
function project(sourceOffset: unknown) {
  const graph = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
  const first = graph.occurrences[0]!;
  graph.occurrences[0] = {
    ...first,
    at_ms: conformance.occurrence.placement.start_ms,
    duration_ms: conformance.occurrence.duration_ms,
    speed: conformance.occurrence.speed,
    source_offset: sourceOffset,
    track: conformance.occurrence.placement.track,
  } as typeof first;
  const revision = graph.shot_revisions.find((row) => row.shot_id === first.shot_id && row.revision_id === first.revision_id)!;
  const timeline = revision.internal_timeline_revision.timeline as Record<string, unknown>;
  timeline.tracks = [{ id: 'picture', kind: 'visual' }];
  timeline.clips = conformance.clips;
  const composition = createShotCompositionAdapter({ load: async () => graph }).prepare(graph);
  return projectCanonicalComposition(composition).config.clips.filter((clip) => clip.id.startsWith(`${first.occurrence_id}:`));
}

describe('occurrence window conformance (source_offset is the window origin)', () => {
  it.each([
    ['scalar ms', start],
    // `end` is legacy and never read: a nonsense value must not change the result.
    ['{start, end} mapping', { start, end: 99999 }],
    ['the fixture mapping as stored', conformance.occurrence.source_offset],
  ])('projects the fixture positions for the %s form', (_label, sourceOffset) => {
    const clips = project(sourceOffset);
    const byId = new Map(clips.map((clip) => [clip.id.split(':')[1], clip]));
    for (const id of conformance.hidden) expect(byId.has(id), `${id} is hidden`).toBe(false);
    expect([...byId.keys()].sort()).toEqual(conformance.expected.map((row) => row.id).sort());
    for (const expected of conformance.expected) {
      const clip = byId.get(expected.id)!;
      expect(clip.at, `${expected.id}.at`).toBeCloseTo(expected.at, 6);
      expect(clip.hold, `${expected.id}.hold`).toBeCloseTo(expected.hold, 6);
      expect(clip.from, `${expected.id}.from`).toBeCloseTo(expected.from, 6);
    }
  });
});

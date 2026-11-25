import { describe, expect, it } from 'vitest';
import type { CanonicalDocument } from './generated.ts';
import { acceptedCommit, fixtureDigest } from './__tests__/timelineCommitFixture.ts';
import {
  RuntimeDataProvider,
  runtimeGraphToContractFromCanonicalDocument,
  toRuntimePublication,
} from './dataProvider.ts';
import { authoringBundleFromDocument } from '@/tools/video-editor/commands/authoringBundle.ts';
import { captureClipMove, finishClipMove, type AuthoredBundle } from '@/tools/video-editor/commands/clipMoveCapture.ts';
import { validateShotComposition, type ShotCompositionContract } from '@/tools/video-editor/data/shotComposition.ts';
import { updateCanonicalShotTimeline } from '@/tools/video-editor/data/shotCompositionEditor.ts';
import { PROJECT_ID, TIMELINE_ID, runtimeFixture } from '@/test/fakeWorkspaceRuntime.ts';

type Row = Record<string, unknown>;
const STORED = 4266.666666666667;
const VALUES: Array<[unknown, unknown]> = [
  [STORED, 4267], [4266.5, 4266], [4267.5, 4268],
  [2500, 2500], [0, 0], [-4266.5, -4266.5], ['4266.5', '4266.5'],
];
const clipsOf = (timeline: Row) => timeline.clips as Row[];
const parentOf = (graph: Row) => graph.parent_composition as Row;
const internalOf = (graph: Row) => ((graph.shot_revisions as Row[])[0].internal_timeline_revision as Row);

function release14Document(start: unknown = STORED, wrapped = false): CanonicalDocument {
  const document = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' },
    { revision_id: 'r0', publication_id: 'p0' }, { children: true }).data.canonical_document;
  const parent = document.parent_revision.payload as Row;
  const parentClip = clipsOf(parent)[0];
  delete parentClip.at;
  parentClip.at_ms = start;
  (parent.config as Row).clips = structuredClone(parent.clips);
  const internal = document.internal_timeline_revisions[0];
  const timeline = internal.payload as Row;
  delete clipsOf(timeline)[0].at;
  clipsOf(timeline)[0].at_ms = start;
  if (wrapped) internal.payload = { timeline } as typeof internal.payload;
  const shot = document.shot_revisions[0];
  (shot.payload.timing as Row).duration_ms = 10000;
  for (const [index, occurrence] of (parent.occurrences as Row[]).entries()) {
    occurrence.duration_ms = 10000;
    (occurrence.placement as Row).start_ms = index * 10000;
  }
  for (const image of [document.parent_revision, shot, internal]) {
    image.content_digest = fixtureDigest(image.payload);
  }
  document.dependency_manifest.shots[0].content_digest = shot.content_digest;
  document.dependency_manifest.internal_timelines[0].content_digest = internal.content_digest;
  return document;
}

const graphOf = (document: CanonicalDocument) => runtimeGraphToContractFromCanonicalDocument(
  document.project_id, document.timeline_id, document, 'p1',
);

const publish = (graph: Row, document: CanonicalDocument) => toRuntimePublication(
  graph, document.project_id, document.timeline_id, document.parent_revision.revision_id,
);

describe('Release 14 clip and placement at_ms read compatibility', () => {
  it.each(VALUES)('normalizes a fractional stored at_ms on clips (%s -> %s)', (stored, expected) => {
    const document = release14Document(stored);
    const before = structuredClone(document);
    const graph = graphOf(document);
    expect(clipsOf(parentOf(graph))[0].at_ms).toBe(expected);
    expect(clipsOf(parentOf(graph).config as Row)[0].at_ms).toBe(expected);
    expect(clipsOf(graph.raw_parent_composition as Row)[0].at_ms).toBe(stored);
    expect(graph.canonical_document).toBe(document);
    expect(document).toEqual(before);
    if (typeof stored === 'number' && stored >= 0) expect(Number.isInteger(expected)).toBe(true);
  });

  describe.each([false, true])('internal payload wrapped: %s', (wrapped) => {
    it.each(VALUES)('normalizes a fractional stored at_ms on placements (%s -> %s)', (stored, expected) => {
      const document = release14Document(stored, wrapped);
      const before = structuredClone(document);
      const graph = graphOf(document);
      const internal = internalOf(graph);
      expect(clipsOf(internal.timeline as Row)[0].at_ms).toBe(expected);
      expect(clipsOf(internal.rawJson as Row)[0].at_ms).toBe(stored);
      expect(graph.canonical_document).toBe(document);
      expect(document).toEqual(before);
      if (typeof stored === 'number' && stored >= 0) expect(Number.isInteger(expected)).toBe(true);
    });
  });

  it('opens the adapted graph while retaining the canonical capture and save diff basis', async () => {
    const document = release14Document();
    const before = structuredClone(document);
    const graph = graphOf(document);
    expect(() => validateShotComposition(graph)).not.toThrow();
    const bundle = await authoringBundleFromDocument(document);
    expect(clipsOf(bundle.parent)[0].at_ms).toBe(STORED);
    for (const shot of Object.values(bundle.shots)) {
      expect(clipsOf(shot.base_internal_timeline)[0].at_ms).toBe(STORED);
      expect(clipsOf(shot.internal_timeline)[0].at_ms).toBe(STORED);
    }
    for (const ref of ['parent/clip:x', 'occurrence:occ-0/clip:child-title']) {
      const result = finishClipMove(captureClipMove(bundle as AuthoredBundle, ref), 5);
      expect(result.command.reads).toContainEqual({ ref, path: ['at_ms'],
        state: { state: 'present', value: STORED } });
    }
    expect(document).toEqual(before);
  });

  it.each(['top-level', 'config', 'both'] as const)(
    'normalizes direct and referenced reads from %s clips without mutating storage', async (shape) => {
      const document = release14Document();
      const parent = document.parent_revision.payload as Row;
      if (shape === 'top-level') (parent.config as Row).clips = [];
      if (shape === 'config') delete parent.clips;
      const before = structuredClone(parent);
      const fixture = runtimeFixture({ parentComposition: parent });
      const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: fixture.transport });
      const loaded = await provider.loadTimeline(TIMELINE_ID);
      const referenced = await provider.loadReferencedTimeline(TIMELINE_ID);
      expect(loaded.config.clips[0]).toMatchObject({ id: 'x', at_ms: 4267 });
      expect(referenced.timeline.config.clips).toEqual(loaded.config.clips);
      expect(fixture.read().parentComposition).toEqual(before);
      expect(parent).toEqual(before);
    },
  );

  it('compares duplicate canonical clip authorities before rounding them', () => {
    const document = release14Document();
    const parent = document.parent_revision.payload as Row;
    clipsOf(parent.config as Row)[0].at_ms = 4267;
    document.parent_revision.content_digest = fixtureDigest(parent);
    expect(() => graphOf(document)).toThrow('canonical parent clips and config.clips disagree');
  });

  it('does not round an untouched parent clip into a full publication', async () => {
    const document = release14Document();
    const graph = graphOf(document);
    const before = structuredClone(graph);
    const publication = await publish(graph, document);
    const parent = publication.parent_composition as Row;
    expect(clipsOf(parent)[0].at_ms).toBe(STORED);
    expect(clipsOf(parent.config as Row)[0].at_ms).toBe(STORED);
    expect(publication).not.toHaveProperty('raw_parent_composition');
    expect(graph).toEqual(before);
  });

  it('retains an actual new integer parent start in a full publication', async () => {
    const document = release14Document();
    const before = structuredClone(document);
    const graph = graphOf(document);
    const parent = parentOf(graph);
    clipsOf(parent)[0].at_ms = 4400;
    clipsOf(parent.config as Row)[0].at_ms = 4400;
    const publication = await publish(graph, document);
    expect(clipsOf(publication.parent_composition as Row)[0].at_ms).toBe(4400);
    expect(clipsOf((publication.parent_composition as Row).config as Row)[0].at_ms).toBe(4400);
    expect(document).toEqual(before);
  });

  it.each([false, true])('preserves child starts through a shared-shot fork (clip moved: %s)', async (moved) => {
    const document = release14Document();
    const before = structuredClone(document);
    const graph = graphOf(document);
    const timeline = internalOf(graph).timeline as Row;
    const nextTimeline = {
      ...timeline,
      clips: clipsOf(timeline).map((clip) => ({ ...clip, text: { content: 'Edited child' },
        ...(moved ? { at_ms: 4400 } : {}) })),
    };
    const edited = await updateCanonicalShotTimeline(graph as unknown as ShotCompositionContract,
      'occ-0', nextTimeline, 'p87-clip-start');
    const publication = await publish(edited as unknown as Row, document);
    const internals = publication.internal_timeline_revisions as Row[];
    expect(internals).toHaveLength(1);
    const published = internals[0].payload as Row;
    expect(clipsOf(published)[0].id).not.toBe('child-title');
    expect(clipsOf(published)[0].at_ms).toBe(moved ? 4400 : STORED);
    expect(clipsOf(published)[0].text).toEqual({ content: 'Edited child' });
    expect(published).not.toHaveProperty('rawJson');
    expect(clipsOf(publication.parent_composition as Row)[0].at_ms).toBe(STORED);
    expect(document).toEqual(before);
  });

  it.each([false, true])('keeps the raw parent save basis without reopening the retired route (moved: %s)', async (moved) => {
    const parent = release14Document().parent_revision.payload;
    const before = structuredClone(parent);
    const fixture = runtimeFixture({ parentComposition: parent });
    const requests: Row[] = [];
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: async (...args) => {
      if (args[0] === 'POST' && args[1].endsWith('/composition-revisions')) {
        requests.push(JSON.parse(new TextDecoder().decode(args[3] as Uint8Array)) as Row);
      }
      return fixture.transport(...args);
    } });
    const loaded = await provider.loadTimeline(TIMELINE_ID);
    const config = { ...loaded.config, clips: loaded.config.clips.map((clip) => ({ ...clip,
      ...(moved ? { at_ms: 4400 } : {}) })) };
    await expect(provider.saveTimelineAtHead(TIMELINE_ID, config, loaded.head!))
      .rejects.toMatchObject({ code: 'schema_incompatible' });
    expect(requests).toHaveLength(1);
    const submitted = requests[0].parent_composition as Row;
    expect(clipsOf(submitted)[0].at_ms).toBe(moved ? 4400 : STORED);
    expect(clipsOf(submitted.config as Row)[0].at_ms).toBe(moved ? 4400 : STORED);
    expect(fixture.read().parentComposition).toEqual(before);
  });
});

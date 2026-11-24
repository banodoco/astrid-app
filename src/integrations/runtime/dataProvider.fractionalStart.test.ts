import { describe, expect, it } from 'vitest';
import type { CanonicalDocument } from './generated.ts';
import { acceptedCommit, fixtureDigest } from './__tests__/timelineCommitFixture.ts';
import {
  normalizedStoredStartMs,
  runtimeGraphToContractFromCanonicalDocument,
  toRuntimePublication,
} from './dataProvider.ts';
import { validateShotComposition, type ShotCompositionContract } from '@/tools/video-editor/data/shotComposition.ts';
import { moveCanonicalOccurrence } from '@/tools/video-editor/data/shotCompositionEditor.ts';
import { authoringBundleFromDocument } from '@/tools/video-editor/commands/authoringBundle.ts';
import { captureClipMove, finishClipMove, occurrenceStart, type AuthoredBundle } from '@/tools/video-editor/commands/clipMoveCapture.ts';

// Release 14 Agents stored occurrence.create starts as frame-snapped float ms:
// on=4.25 s at 30 fps -> frame 128 -> 4266.666666666667 ms. Such a project must open.
const STORED = 4266.666666666667;
const projectId = 'project-commit';
const timelineId = 'timeline-commit';

function release14Document(start: unknown = STORED, mutate?: (occurrence: Record<string, unknown>) => void): CanonicalDocument {
  const document = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' },
    { children: true }).data.canonical_document;
  const occurrences = document.parent_revision.payload.occurrences as Record<string, unknown>[];
  occurrences[0].duration_ms = 4000.0;
  occurrences[1].duration_ms = 4000.0;
  (occurrences[1].placement as Record<string, unknown>).start_ms = start;
  mutate?.(occurrences[1]);
  document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
  return document;
}

const graphOf = (document: CanonicalDocument) =>
  runtimeGraphToContractFromCanonicalDocument(projectId, timelineId, document, 'p1');

const storedStart = (document: CanonicalDocument, index: number) =>
  ((document.parent_revision.payload.occurrences as Record<string, unknown>[])[index].placement as Record<string, unknown>).start_ms;

async function published(graph: Record<string, unknown>) {
  const publication = await toRuntimePublication(graph, projectId, timelineId, 'r1');
  const occurrences = (publication.parent_composition as { occurrences: Record<string, unknown>[] }).occurrences;
  return new Map(occurrences.map((occurrence) => [occurrence.occurrence_id as string, occurrence]));
}

describe('Release 14 fractional occurrence start_ms (read-time normalisation)', () => {
  it('passes shot-composition validation after the adapter, rounding at_ms and placement.start_ms together', () => {
    const document = release14Document();
    const graph = graphOf(document);
    expect(() => validateShotComposition(graph)).not.toThrow();
    const occurrence = (graph.occurrences as Record<string, unknown>[])[1];
    expect(occurrence.at_ms).toBe(4267);
    expect((occurrence.placement as Record<string, unknown>).start_ms).toBe(4267);
    expect(occurrence.duration_ms).toBe(4000);
    // The two start codecs agree, so no capture sees contradictory starts.
    expect(occurrenceStart(occurrence as never)).toBe(4.267);
    // The canonical document (capture/save diff base) is not mutated.
    expect(storedStart(document, 1)).toBe(STORED);
  });

  it('lets a move capture run on the same project without throwing', async () => {
    const document = release14Document();
    const bundle = await authoringBundleFromDocument(document) as AuthoredBundle;
    // Inside the fractional occurrence, and inside its neighbour (whose boundary is the fractional start).
    for (const [select, on] of [['occurrence:occ-1/clip:child-title', 4.5], ['occurrence:occ-0/clip:child-title', 1]] as const) {
      const basis = captureClipMove(bundle, select);
      expect(() => finishClipMove(basis, on)).not.toThrow();
    }
  });

  it('does not rewrite an untouched occurrence on save', async () => {
    const document = release14Document();
    // Command save path: the move writes only its own clip; reads carry the stored start the Runtime holds.
    const bundle = await authoringBundleFromDocument(document) as AuthoredBundle;
    const result = finishClipMove(captureClipMove(bundle, 'occurrence:occ-0/clip:child-title'), 1);
    expect(result.record.writes.every((write) => (write as { ref: string }).ref === 'occurrence:occ-0/clip:child-title')).toBe(true);
    expect(result.command.reads).toContainEqual({ ref: 'occurrence:occ-1', path: ['placement', 'start_ms'],
      state: { state: 'present', value: STORED } });
    // Full publication path: an unedited graph and a graph with another occurrence moved
    // both write the untouched occurrence back with its stored start.
    const graph = graphOf(document);
    expect((await published(graph)).get('occ-1')!.placement).toEqual({ ...(document.parent_revision.payload.occurrences as Record<string, unknown>[])[1].placement as object });
    const moved = moveCanonicalOccurrence(graph as unknown as ShotCompositionContract, { occurrenceId: 'occ-0', atMs: 100 });
    const byId = await published(moved as unknown as Record<string, unknown>);
    expect((byId.get('occ-1')!.placement as Record<string, unknown>).start_ms).toBe(STORED);
    expect((byId.get('occ-0')!.placement as Record<string, unknown>).start_ms).toBe(100);
  });

  it('gives a moved fractional occurrence an integer start_ms', async () => {
    const graph = graphOf(release14Document());
    const moved = moveCanonicalOccurrence(graph as unknown as ShotCompositionContract, { occurrenceId: 'occ-1', atMs: 4300 });
    const start = ((await published(moved as unknown as Record<string, unknown>)).get('occ-1')!.placement as Record<string, unknown>).start_ms;
    expect(start).toBe(4300);
    expect(Number.isInteger(start)).toBe(true);
  });

  it('still rejects shapes outside the narrow rule', () => {
    for (const start of [-STORED, Number.NaN, String(STORED)]) {
      expect(() => validateShotComposition(graphOf(release14Document(start))), String(start))
        .toThrow('occurrences[1].at_ms: must be a non-negative integer');
    }
    // A fractional at_ms that does not come from placement.start_ms is not normalised.
    const legacy = release14Document(STORED, (occurrence) => {
      delete (occurrence.placement as Record<string, unknown>).start_ms;
      occurrence.at_ms = STORED;
    });
    expect(() => validateShotComposition(graphOf(legacy))).toThrow('occurrences[1].at_ms: must be a non-negative integer');
  });

  it('rounds half to even and accepts nothing else', () => {
    expect([4266.5, 4267.5, 0.5, 1.5, 4266.4, STORED, 12766.666666666668].map(normalizedStoredStartMs))
      .toEqual([4266, 4268, 0, 2, 4266, 4267, 12767]);
    for (const value of [4267, 0, -0.5, Number.NaN, Number.POSITIVE_INFINITY, '4266.5', null, undefined]) {
      expect(normalizedStoredStartMs(value)).toBeUndefined();
    }
  });
});

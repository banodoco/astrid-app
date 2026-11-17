import { describe, expect, it, vi } from 'vitest';

import fixture from './shotComposition.fixture.json';
import {
  canonicalSourceFrameRequest,
  createShotCompositionAdapter,
  ShotCompositionUnavailableError,
} from './shotCompositionAdapter.ts';
import { StaleWriteError } from './shotComposition.ts';

describe('shot-composition product adapter', () => {
  it('keeps linked occurrences distinct while sharing their pinned revision', async () => {
    const port = { load: vi.fn().mockResolvedValue(fixture) };
    const composition = await createShotCompositionAdapter(port).load({
      projectId: 'project-001',
      parentDocumentId: 'document-primary',
    });

    expect(composition.occurrences[0]?.occurrenceId).not.toBe(composition.occurrences[1]?.occurrenceId);
    expect(composition.occurrences[0]?.revisionId).toBe(composition.occurrences[1]?.revisionId);
    expect(composition.occurrences[0]?.revision).toBe(composition.occurrences[1]?.revision);
    expect(composition.occurrences[4]?.shotId).toBe('shot-alpha-copy');
    expect(composition.occurrences[4]?.revision).not.toBe(composition.occurrences[0]?.revision);
    expect(port.load).toHaveBeenCalledWith({ projectId: 'project-001', parentDocumentId: 'document-primary' });
  });

  it('keeps a nonnegative source offset and refuses a negative one instead of clamping it', () => {
    const adapter = createShotCompositionAdapter({ load: vi.fn() });
    const withOffset = (offset: number) => ({ ...fixture,
      occurrences: fixture.occurrences.map((occurrence, index) => index === 0 ? { ...occurrence, source_offset: offset } : occurrence) });
    expect(adapter.prepare(withOffset(1500)).occurrences[0]?.sourceOffsetMs).toBe(1500);
    expect(adapter.prepare(withOffset(0)).occurrences[0]?.sourceOffsetMs).toBe(0);
    expect(() => adapter.prepare(withOffset(-250))).toThrow(ShotCompositionUnavailableError);
  });

  it('allows the editor host and Travel Between Images to share one injected port', async () => {
    const port = { load: vi.fn().mockResolvedValue(fixture) };
    const editorAdapter = createShotCompositionAdapter(port);
    const travelAdapter = createShotCompositionAdapter(port);
    await Promise.all([
      editorAdapter.load({ projectId: 'project-001', parentDocumentId: 'document-primary' }),
      travelAdapter.load({ projectId: 'project-001', parentDocumentId: 'document-primary' }),
    ]);
    expect(port.load).toHaveBeenCalledTimes(2);
    expect(editorAdapter.prepare(fixture).occurrences[0]?.occurrenceId)
      .toBe(travelAdapter.prepare(fixture).occurrences[0]?.occurrenceId);
  });

  it('publishes with an explicit expected head and maps Runtime 409 to StaleWriteError', async () => {
    const publish = vi.fn().mockRejectedValue(Object.assign(new Error('head moved'), { status: 409 }));
    const adapter = createShotCompositionAdapter({ load: vi.fn(), publish });

    await expect(adapter.publish({
      projectId: 'project-001',
      parentDocumentId: 'document-primary',
      expectedHeadRevisionId: 'timeline-rev-2',
      graph: fixture,
    })).rejects.toMatchObject({ status: 409, code: 'stale_write' });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      expectedHeadRevisionId: 'timeline-rev-2',
      graph: fixture,
    }));
  });

  it('resolves an explicitly requested immutable head and exposes the publication receipt', async () => {
    const loadAtHead = vi.fn().mockResolvedValue({
      ...fixture,
      publication_receipt: {
        receipt_id: 'receipt-1',
        idempotency_key: 'retry-1',
        expected_head: 'timeline-rev-1',
        new_head: 'timeline-rev-2',
        changed_identities: ['shot-revision-2'],
        diff: { changed: ['occ-1'] },
      },
    });
    const adapter = createShotCompositionAdapter({ load: vi.fn(), loadAtHead });
    const composition = await adapter.loadAtHead!({
      projectId: 'project-001',
      parentDocumentId: 'document-primary',
      headRevisionId: 'timeline-rev-2',
    });
    expect(loadAtHead).toHaveBeenCalledWith(expect.objectContaining({ headRevisionId: 'timeline-rev-2' }));
    expect(composition.headRevisionId).toBe('timeline-rev-2');
    expect(composition.publicationReceipt).toMatchObject({
      newHead: 'timeline-rev-2',
      idempotencyKey: 'retry-1',
      changedIdentities: ['shot-revision-2'],
    });
  });

  it('rejects a submitted graph whose project or timeline identity does not match the request', async () => {
    const publish = vi.fn();
    const graph = JSON.parse(JSON.stringify(fixture)) as Record<string, any>;
    graph.project.project_id = 'project-foreign';

    await expect(createShotCompositionAdapter({ load: vi.fn(), publish }).publish({
      projectId: 'project-001',
      parentDocumentId: 'document-primary',
      expectedHeadRevisionId: null,
      graph,
    })).rejects.toThrow(/project|timeline/);
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes an explicitly null expected head', async () => {
    const publish = vi.fn().mockResolvedValue(fixture);
    const adapter = createShotCompositionAdapter({ load: vi.fn(), publish });

    await adapter.publish({
      projectId: 'project-001',
      parentDocumentId: 'document-primary',
      expectedHeadRevisionId: null,
      graph: fixture,
    });

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadRevisionId: null }));
  });

  it('admits the authored parent pause intervals and rejects an unrelated gap before publication', async () => {
    const publish = vi.fn().mockResolvedValue(fixture);
    const adapter = createShotCompositionAdapter({load: vi.fn(), publish});
    const request = {projectId: 'project-001', parentDocumentId: 'document-primary', expectedHeadRevisionId: null};
    const graph = structuredClone(fixture);
    await adapter.publish({...request, graph});
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({graph}));
    const wrong = structuredClone(graph);
    wrong.parent_composition.config.app.visualSeamContract.gaps[0]!.endFrame += 1;
    publish.mockClear();
    await expect(adapter.publish({...request, graph: wrong})).rejects.toMatchObject({code: 'visual_seam_admission_blocked'});
    expect(publish).not.toHaveBeenCalled();
  });

  it('reports a typed read-only failure when the provider has no publish port', async () => {
    const adapter = createShotCompositionAdapter({ load: vi.fn() });
    await expect(adapter.publish({
      projectId: 'project-001',
      parentDocumentId: 'document-primary',
      expectedHeadRevisionId: 'timeline-rev-2',
      graph: fixture,
    })).rejects.toBeInstanceOf(ShotCompositionUnavailableError);
  });

  it('maps the canonical midpoint to one source-frame key with trim and speed applied once', () => {
    const graph = JSON.parse(JSON.stringify(fixture)) as Record<string, any>;
    const revision = graph.shot_revisions.find((item: Record<string, any>) => item.shot_id === 'shot-alpha' && item.revision_id === 'rev-a')!;
    revision.internal_timeline_revision.timeline = {
      tracks: [{ id: 'video', kind: 'visual' }],
      clips: [
        { id: 'gap', clip_type: 'gap', track: 'video', at_ms: 0, duration_ms: 1000 },
        { id: 'video-clip', clip_type: 'media', track: 'video', at_ms: 2000, duration_ms: 4000, from: 3, speed: 2, asset_id: 'video-source' },
      ],
    };
    revision.assets = [{
      asset_id: 'video-source',
      object_id: `sha256:${'a'.repeat(64)}`,
      media_type: 'video/mp4',
    }];
    graph.occurrences[0].duration_ms = 7000;

    const occurrence = createShotCompositionAdapter({ load: vi.fn() }).prepare(graph).occurrences[0]!;
    expect(canonicalSourceFrameRequest(occurrence)).toMatchObject({
      projectId: 'project-001',
      sourceObjectId: `sha256:${'a'.repeat(64)}`,
      sourceTimeSeconds: 6,
      recipeVersion: 1,
    });
  });
});

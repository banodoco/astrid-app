import React from 'react';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ShotEditorView } from '../../src/tools/travel-between-images/pages/ShotEditorView.tsx';
import { createShotCompositionAdapter, type PreparedShotComposition } from '../../src/tools/video-editor/data/shotCompositionAdapter.ts';
import { createEntityStore } from '../../src/shared/state/createEntityStore.ts';
import { normalizeVideoTravelSettings, type VideoTravelSettings } from '../../src/tools/travel-between-images/settings.ts';
import type { ShotSettingsPersistenceOptions } from '../../src/tools/travel-between-images/hooks/settings/useShotSettings.ts';
import type { Shot } from '../../src/domains/generation/types';
import { RuntimeDataProvider } from '../../src/integrations/runtime/dataProvider.ts';
import type { CommitAcceptedMutation, Transport } from '../../src/integrations/runtime/generated.ts';
import { DirectHarness } from '../e2e/local/support/harness.ts';
import { ASTRID_PYTHON, AstridCli, revisionSet } from '../e2e/local/support/astrid.ts';

const capture = vi.hoisted(() => ({ persistence: null as ShotSettingsPersistenceOptions['customLoadSave'] | null, onName: null as ((name: string) => void) | null, errors: vi.fn() }));
vi.mock('@/tools/travel-between-images/components/ShotEditor', () => ({ ShotSettingsEditor: (props: { onUpdateShotName?: (name: string) => void }) => { capture.onName = props.onUpdateShotName ?? null; return null; } }));
vi.mock('@/tools/travel-between-images/providers', () => ({
  VideoTravelSettingsProvider: (props: { shotSettingsPersistence?: ShotSettingsPersistenceOptions['customLoadSave']; children: React.ReactNode }) => { capture.persistence = props.shotSettingsPersistence; return props.children; },
  useVideoTravelSettingsMutations: () => ({ settings: {}, status: 'loading' }),
}));
vi.mock('@/tools/travel-between-images/components/ShotTimelinePreview.tsx', () => ({ ShotTimelinePreview: () => null }));
vi.mock('@/tools/travel-between-images/components/VideoTravelFloatingOverlay', () => ({ VideoTravelFloatingOverlay: () => null }));
vi.mock('@/shared/state/selectionStore', () => ({ useCurrentShot: () => ({ setCurrentShotId: vi.fn() }) }));
vi.mock('@/shared/hooks/mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/shared/hooks/shots/useShotNavigation', () => ({ useShotNavigation: () => ({ navigateToPreviousShot: vi.fn(), navigateToNextShot: vi.fn() }) }));
vi.mock('@/shared/hooks/shots', () => ({ useUpdateShotName: () => ({ mutate: vi.fn() }) }));
vi.mock('@/shared/hooks/shots/useShotImages', () => ({ usePrimeShotImagesCache: () => undefined }));
vi.mock('@/shared/hooks/invalidation/useGenerationInvalidation', () => ({ useEnqueueGenerationsInvalidation: () => vi.fn() }));
vi.mock('@/shared/hooks/projects/useProjectVideoCountsCache', () => ({ useProjectVideoCountsCache: () => ({ getFinalVideoCount: vi.fn(), getHasStructureVideo: vi.fn() }) }));
vi.mock('@/shared/hooks/projects/useProjectGenerationModesCache', () => ({ useProjectGenerationModesCache: () => ({ updateShotMode: vi.fn() }) }));
vi.mock('@/shared/hooks/gallery/useVideoGalleryPreloader', () => ({ useVideoGalleryPreloader: () => undefined }));
vi.mock('@/tools/travel-between-images/hooks/useStickyHeader', () => ({ useStickyHeader: () => ({}) }));
vi.mock('@/tools/travel-between-images/hooks/navigation/useNavigationState', () => ({ useNavigationState: () => ({ sortedShots: [], hasPrevious: false, hasNext: false }) }));
vi.mock('@/tools/travel-between-images/hooks/useOperationTracking', () => ({ useOperationTracking: () => ({ setIsDraggingInTimeline: vi.fn(), signalShotOperation: vi.fn() }) }));
vi.mock('@/shared/state/panesStore', () => ({ usePanesStore: (select: (state: Record<string, unknown>) => unknown) => select({}) }));
vi.mock('@/shared/lib/errorHandling/runtimeError.ts', () => ({ normalizeAndPresentError: capture.errors }));

afterEach(() => { cleanup(); capture.errors.mockClear(); capture.persistence = null; capture.onName = null; });

it('M1 App restoreHistory uses the actual head pair and preserves the exact immutable closure through the Runtime door', async () => {
  const harness = new DirectHarness();
  try {
    await harness.start();
    const seed = await harness.seedThreeProducts();
    await harness.enableTimelineAuthoring(ASTRID_PYTHON);
    const astrid = await AstridCli.create(harness);
    const identity = await astrid.preflight();
    console.info('Restore integration source tuple:', revisionSet(identity));
    const projectId = harness.seed.projectId;
    const timelinePath = `/v1/projects/${projectId}/timelines/${seed.timelineId}`;
    const wire: Array<{ method: string; path: string; body: unknown; response: unknown }> = [];
    const transport: Transport = async (method, path, headers, body) => {
      const bytes = body instanceof Blob ? Buffer.from(await body.arrayBuffer()) : body ? Buffer.from(body) : undefined;
      const response = await harness.doorRequest(path, { method, headers, body: bytes });
      wire.push({ method, path, body: bytes ? JSON.parse(bytes.toString('utf8')) : undefined, response: response.json() });
      return { status: response.status, headers: {}, body: new Uint8Array(response.body) };
    };
    const provider = new RuntimeDataProvider({ projectId, baseUrl: harness.doorBase, transport });
    const before = await provider.loadTimelineCommandBasis(seed.timelineId);
    expect(before.head.revisionId).toBe(seed.headRevisionId);
    expect(before.canonicalDocument.shot_revisions).toHaveLength(1);
    expect(before.canonicalDocument.internal_timeline_revisions).toHaveLength(1);
    expect(before.canonicalDocument.parent_revision.payload.config).toMatchObject({ x_f2_opaque: seed.opaque.config });
    expect(before.canonicalDocument.internal_timeline_revisions[0].payload.clips).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: seed.agentClipId, app: { f2Opaque: seed.opaque.clip } }),
    ]));

    const moved = await astrid.commitCaptured(projectId, seed.timelineId,
      { revision_id: before.head.revisionId, publication_id: before.head.publicationId },
      { kind: 'move', clipId: seed.appClipId, on: 5 }, 'restore-intervening-move');
    expect(moved.data.accepted_revision_id).not.toBe(before.head.revisionId);
    const restoreStart = wire.length;
    const result = await provider.shotComposition.restoreHistory!({
      projectId, parentDocumentId: seed.timelineId, revisionId: before.head.revisionId,
    });
    const restoreWire = wire.slice(restoreStart);
    expect(restoreWire.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: timelinePath },
      { method: 'GET', path: '/v1/health' },
      { method: 'POST', path: `${timelinePath}/composition-revisions/${before.head.revisionId}/restore` },
    ]);
    const [timelineRead, healthPreflight, restorePost] = restoreWire;
    expect(healthPreflight.response).toMatchObject({ status: 'ok' });
    const head = timelineRead.response;
    expect(head).toMatchObject({ project_id: projectId, timeline_id: seed.timelineId,
      head_revision_id: moved.data.accepted_revision_id, head_publication_id: moved.receipt.receipt_id });
    expect(restorePost.body).toEqual({
      expected_head: moved.data.accepted_revision_id, expected_publication_id: moved.receipt.receipt_id,
    });
    const accepted = restorePost.response as CommitAcceptedMutation;
    expect(accepted.data.status).toBe('accepted');
    expect(accepted.data.accepted_revision_id).toBe(before.head.revisionId);
    expect(result).toEqual({ newHead: before.head.revisionId });
    expect(accepted.receipt.receipt_id).toBeTruthy();
    expect(accepted.receipt.receipt_id).not.toBe(before.head.publicationId);
    expect(accepted.receipt.receipt_id).not.toBe(moved.receipt.receipt_id);
    expect(accepted.data.canonical_document).toEqual(before.canonicalDocument);

    // Read every immutable child through the App consumer as well as its restored parent.
    const readback = await new RuntimeDataProvider({ projectId, baseUrl: harness.doorBase, transport })
      .loadTimelineCommandBasis(seed.timelineId);
    expect(readback.head).toEqual({ revisionId: before.head.revisionId, publicationId: accepted.receipt.receipt_id });
    expect(readback.canonicalDocument).toEqual(before.canonicalDocument);
    const entry = readback.history?.items.find((item) => item.publication_id === accepted.receipt.receipt_id);
    expect(entry?.receipt).toEqual(accepted.receipt);
    expect(entry?.revision_id).toBe(before.head.revisionId);
    expect(wire.filter(({ method }) => method === 'POST').map(({ path }) => path)).toEqual([
      '/v1/handshake', restorePost.path, '/v1/handshake',
    ]);
  } finally {
    await harness.stop();
  }
});

it('ShotEditor reads, edits and saves Runtime-valid raw settings without changing unrelated immutable payload data', async () => {
  const harness = new DirectHarness();
  try {
    await harness.start();
    const seed = await harness.seedThreeProducts(3);
    const projectId = harness.seed.projectId;
    const timelinePath = `/v1/projects/${projectId}/timelines/${seed.timelineId}`;
    const shotPath = `/v1/projects/${projectId}/shots/${seed.shotId}/revisions`;
    const scope = { projectId, parentDocumentId: seed.timelineId };
    const rawGet = async (path: string) => {
      const response = await harness.runtimeJson('GET', path);
      expect(response.status, path).toBe(200);
      return response.body;
    };
    const initialParent = await rawGet(`${timelinePath}/composition-revisions/${seed.headRevisionId}`);
    const initialShot = await rawGet(`${shotPath}/${initialParent.payload.occurrences[0].shot_revision_id}`);
    const initialInternal = await rawGet(`${timelinePath}/revisions/${initialShot.internal_timeline_revision_id}`);
    const opaque = JSON.parse('{"not_namespaced":{"nested":[null,false,0,"f2-agent-clip"]},"nullable":null,"ordered":[3,1,2,1],"__proto__":{"literal":true},"constructor":{"prototype":0},"prototype":false}');
    const objectSettings = {
      ...opaque, prompt: 'Original', negativePrompt: null,
      pairConfigs: [{ id: 'pair-1', prompt: 'Pair', frames: 61, ...opaque }],
      modelSettingsByModel: { 'wan-2.2': { batchVideoFrames: 61, batchVideoSteps: 6, ...opaque }, future_model: null },
    };
    const wire: Array<{ method: string; path: string; body: { shot_revisions: Array<{ payload: Record<string, unknown> }> } | undefined; status: number; response: unknown }> = [];
    const transport: Transport = async (method, path, headers, body) => {
      const bytes = body instanceof Blob ? Buffer.from(await body.arrayBuffer()) : body ? Buffer.from(body) : undefined;
      const response = await harness.doorRequest(path, { method, headers, body: bytes });
      wire.push({ method, path, body: bytes ? JSON.parse(bytes.toString('utf8')) : undefined, status: response.status, response: response.json() });
      return { status: response.status, headers: {}, body: new Uint8Array(response.body) };
    };
    const openEditor = async (headRevisionId: string) => {
      cleanup();
      capture.errors.mockClear();
      const provider = new RuntimeDataProvider({ projectId, baseUrl: harness.doorBase, transport });
      const adapter = createShotCompositionAdapter(provider.shotComposition);
      // Resolve only the selected immutable closure, with no mutable-head fallback.
      const base = await adapter.loadAtHead!({ ...scope, headRevisionId });
      const published: PreparedShotComposition[] = [];
      render(React.createElement(MemoryRouter, {
        initialEntries: [`/tools/travel-between-images?localProject=${projectId}&localTimeline=${seed.timelineId}`],
      }, React.createElement(ShotEditorView, {
        shotToEdit: { id: seed.shotId, name: 'Original', images: [] } as unknown as Shot,
        selectedProjectId: projectId, isNewlyCreatedShot: false, shotFromState: undefined,
        shots: [], availableLoras: [], canonicalComposition: base, canonicalShotComposition: adapter,
        canonicalOccurrence: base.occurrences[0],
        onCanonicalCompositionPublished: (value: PreparedShotComposition) => { published.push(value); },
      })));
      return { base, published, persistence: capture.persistence! };
    };
    const readClosure = async (head: string) => {
      const parent = await rawGet(`${timelinePath}/composition-revisions/${head}`);
      const shot = await rawGet(`${shotPath}/${parent.payload.occurrences[0].shot_revision_id}`);
      const internal = await rawGet(`${timelinePath}/revisions/${shot.internal_timeline_revision_id}`);
      return { parent, shot, internal };
    };
    const posts = () => wire.filter((entry) => entry.method === 'POST' && entry.path === `${timelinePath}/composition-revisions`);
    let head = seed.headRevisionId;
    for (const shape of ['absent', 'null', 'scalar', 'array', 'object'] as const) {
      const internalId = randomUUID();
      const shotRevisionId = randomUUID();
      const payload = {
        ...initialShot.payload, ...opaque,
        metadata: { ...initialShot.payload.metadata, ...opaque },
        provenance: { ...initialShot.payload.provenance, ...opaque },
        ...(shape === 'absent' ? {} : { settings: shape === 'null' ? null : shape === 'scalar' ? 0 : shape === 'array' ? ['opaque-root', null] : objectSettings }),
      };
      const publication = {
        project_id: projectId, timeline_id: seed.timelineId, expected_head: head, parent_revision_id: randomUUID(),
        parent_composition: {
          ...initialParent.payload, ...opaque,
          config: { ...initialParent.payload.config, ...opaque },
          occurrences: initialParent.payload.occurrences.map((occurrence: Record<string, unknown>) => ({ ...occurrence, ...opaque, shot_revision_id: shotRevisionId })),
        },
        shot_revisions: [{ shot_id: seed.shotId, revision_id: shotRevisionId, internal_timeline_revision_id: internalId, payload }],
        internal_timeline_revisions: [{ timeline_id: seed.timelineId, revision_id: internalId, payload: {
          ...initialInternal.payload, ...opaque, output: { ...opaque }, config: { ...opaque },
          tracks: initialInternal.payload.tracks.map((track: Record<string, unknown>) => ({ ...track, ...opaque })),
          clips: initialInternal.payload.clips.map((clip: Record<string, unknown>) => ({ ...clip, ...opaque })),
        } }],
      };
      const seeded = await harness.runtimeJson('POST', `${timelinePath}/composition-revisions`, publication);
      expect(seeded.status, `${shape}: ${JSON.stringify(seeded.body)}`).toBe(200);
      head = seeded.body.data.new_head;
      const before = await readClosure(head);
      assert.deepStrictEqual(before.shot.payload, { ...payload, internal_timeline_revision_id: internalId });
      expect(Object.hasOwn(before.shot.payload, 'settings')).toBe(shape !== 'absent');
      const sourceSnapshot = structuredClone(before);

      let editor = await openEditor(head);
      assert.deepStrictEqual(editor.base.occurrences[0].revision.rawJson, before.shot.payload);
      const loaded = await editor.persistence.load(seed.shotId);
      const form = loaded ?? normalizeVideoTravelSettings(null);
      const count = posts().length;
      await editor.persistence.save(seed.shotId, form);
      expect(posts()).toHaveLength(count);
      assert.deepStrictEqual(await readClosure(head), sourceSnapshot);

      capture.onName!(`Renamed ${shape}`);
      await waitFor(() => expect(editor.published.length + capture.errors.mock.calls.length).toBeGreaterThan(0), { timeout: 30_000 });
      expect(editor.published).toHaveLength(1);
      expect(capture.errors).not.toHaveBeenCalled();
      head = editor.published[0].headRevisionId;
      const renamed = await readClosure(head);
      const expectedNamePayload = { ...before.shot.payload, provenance: { ...before.shot.payload.provenance, name: `Renamed ${shape}` } };
      assert.deepStrictEqual(posts().at(-1)!.body!.shot_revisions[0].payload, expectedNamePayload);
      assert.deepStrictEqual(renamed.shot.payload, expectedNamePayload);
      expect(Object.hasOwn(renamed.shot.payload, 'settings')).toBe(shape !== 'absent');
      assert.deepStrictEqual(renamed.internal, before.internal);
      assert.deepStrictEqual(renamed.parent.payload.config, before.parent.payload.config);
      for (const key of Object.keys(opaque)) {
        assert.deepStrictEqual(renamed.parent.payload[key], before.parent.payload[key]);
        assert.deepStrictEqual(renamed.parent.payload.occurrences[0][key], before.parent.payload.occurrences[0][key]);
      }
      assert.deepStrictEqual(await readClosure(sourceSnapshot.parent.revision_id), sourceSnapshot);

      editor = await openEditor(head);
      const savedForm = await editor.persistence.load(seed.shotId) ?? normalizeVideoTravelSettings(null);
      if (shape === 'scalar' || shape === 'array') {
        const rejectedCount = posts().length;
        await expect(editor.persistence.save(seed.shotId, { ...savedForm, prompt: 'Pending' })).rejects.toThrow('Cannot safely replace shot settings');
        expect(posts()).toHaveLength(rejectedCount);
        expect(capture.errors).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ toastTitle: 'Shot settings draft kept' }));
        assert.deepStrictEqual(await readClosure(head), renamed);
      } else {
        await editor.persistence.save(seed.shotId, { ...savedForm, prompt: 'Saved prompt' });
        expect(editor.published).toHaveLength(1);
        expect(capture.errors).not.toHaveBeenCalled();
        head = editor.published[0].headRevisionId;
        const saved = await readClosure(head);
        const expected = { ...renamed.shot.payload, settings: { ...(shape === 'object' ? objectSettings : {}), prompt: 'Saved prompt' } };
        assert.deepStrictEqual(posts().at(-1)!.body!.shot_revisions[0].payload, expected);
        assert.deepStrictEqual(saved.shot.payload, expected);
        assert.deepStrictEqual(saved.internal, renamed.internal);
        assert.deepStrictEqual(saved.parent.payload.config, renamed.parent.payload.config);
        assert.deepStrictEqual(await readClosure(renamed.parent.revision_id), renamed);
        const fresh = await openEditor(head);
        assert.deepStrictEqual(fresh.base.occurrences[0].revision.rawJson, expected);
      }
      console.info(`Raw ShotEditor roundtrip ${shape}: Runtime accepted input; neutral save/name/prompt or refusal checked`);
    }

    // A malformed known field is not a valid authoring fixture.
    const current = await readClosure(head);
    const invalidShotRevisionId = randomUUID();
    const selectedOccurrenceId = current.parent.payload.occurrences[0].occurrence_id;
    const invalid = await harness.runtimeJson('POST', `${timelinePath}/composition-revisions`, {
      project_id: projectId, timeline_id: seed.timelineId, expected_head: head, parent_revision_id: randomUUID(),
      parent_composition: {
        ...current.parent.payload,
        occurrences: current.parent.payload.occurrences.map((occurrence: Record<string, unknown>) => occurrence.occurrence_id === selectedOccurrenceId
          ? { ...occurrence, shot_revision_id: invalidShotRevisionId } : occurrence),
      },
      shot_revisions: [{ shot_id: seed.shotId, revision_id: invalidShotRevisionId, internal_timeline_revision_id: current.shot.internal_timeline_revision_id, payload: { ...current.shot.payload, metadata: [] } }],
      internal_timeline_revisions: [],
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body).toMatchObject({
      code: 'validation_error',
      message: 'shot revision payload cannot be projected losslessly',
    });
    expect((await rawGet(timelinePath)).head_revision_id).toBe(head);

    await harness.enableTimelineAuthoring(ASTRID_PYTHON);
    const astrid = await AstridCli.create(harness);
    const identity = await astrid.preflight();
    console.info('ShotEditor historical safety integration source tuple:', revisionSet(identity));
    const provider = new RuntimeDataProvider({ projectId, baseUrl: harness.doorBase, transport });
    const basis = await provider.loadTimelineCommandBasis(seed.timelineId);
    const movedClip = await astrid.commitCaptured(projectId, seed.timelineId,
      { revision_id: basis.head.revisionId, publication_id: basis.head.publicationId },
      { kind: 'move', clipId: seed.appClipId, on: 5 }, 'settings-tracked-move');
    // Keep the crossfade contiguous so these writes reach Runtime's tracked-head guard.
    const moved = await astrid.commitCaptured(projectId, seed.timelineId,
      { revision_id: movedClip.data.accepted_revision_id, publication_id: movedClip.receipt.receipt_id },
      { kind: 'move', clipId: seed.transitionClipId, on: 8 }, 'settings-tracked-successor-move');
    const trackedHead = moved.data.accepted_revision_id;
    const trackedBefore = await readClosure(trackedHead);
    const editor = await openEditor(trackedHead);
    const loaded = await editor.persistence.load(seed.shotId);
    const store = createEntityStore<VideoTravelSettings>({
      toolId: 'real-runtime-shot-settings', defaults: normalizeVideoTravelSettings(null),
      load: async () => ({ db: loaded, lastUsed: null }), save: editor.persistence.save,
    });
    await store.getState().ensureEntity(seed.shotId);
    store.getState().updateFields(seed.shotId, { prompt: 'Tracked pending prompt' });
    const draft = structuredClone(store.getState().entities[seed.shotId].settings);
    await expect(store.getState().saveImmediate(seed.shotId)).rejects.toThrow();
    expect(posts().at(-1)!.status).toBe(409);
    expect(JSON.stringify(posts().at(-1)!.response)).toContain('timeline_commit_required');
    expect(store.getState().entities[seed.shotId].status).toBe('error');
    expect(store.getState().isDirty(seed.shotId)).toBe(true);
    assert.deepStrictEqual(store.getState().entities[seed.shotId].settings, draft);
    assert.deepStrictEqual(store.getState().entities[seed.shotId].cleanSnapshot, loaded);
    expect(editor.published).toHaveLength(0);
    capture.onName!('Tracked pending name');
    await waitFor(() => expect(capture.errors).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ toastTitle: 'Failed to save shot name' })), { timeout: 30_000 });
    expect(posts().at(-1)!.status).toBe(409);
    expect(JSON.stringify(posts().at(-1)!.response)).toContain('timeline_commit_required');
    expect(editor.published).toHaveLength(0);
    expect((await rawGet(timelinePath)).head_revision_id).toBe(trackedHead);
    assert.deepStrictEqual(await readClosure(trackedHead), trackedBefore);
  } finally {
    cleanup();
    await harness.stop();
  }
});

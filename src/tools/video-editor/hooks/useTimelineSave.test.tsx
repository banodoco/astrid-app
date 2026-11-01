// @vitest-environment jsdom
import { AstridElementOperationAdapter, createElementTimelineRoutes } from '../runtime/element-adapter.ts';
import { ASTRID_EFFECT_CATALOG } from '../runtime/astrid-element-catalog.ts';
import { buildAstridAgentElementContext } from '../runtime/element-contract.ts';
import React from 'react';
import { act, fireEvent, renderHook, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB, resetFakeIndexedDB } from 'fake-indexeddb';
import { useTimelineHistory } from './useTimelineHistory';
import { RuntimeDataProvider } from '@/integrations/runtime/dataProvider.ts';
import { json, runtimeFixture } from '@/test/fakeWorkspaceRuntime.ts';
import type { HistoryEntry, HistoryPage, CommitRequest } from '@/integrations/runtime/timeline-commit-types.ts';
import { bindElementParameterOwner, useTimelineSave } from './useTimelineSave';
import type { UsePollSyncQueries } from './usePollSync';
import { useClipEditing } from './useClipEditing';
import { useVideoEditorRuntime, VideoEditorRuntimeProvider } from '../contexts/VideoEditorRuntimeContext';
import { createTimelineStore, TimelineStoreProvider, useTimelineEditorData, useTimelineEditorOps } from './timelineStore';
import { useAssetManagement } from './useAssetManagement';
import { useTimelineCommandsService } from './useTimelineCommandsService';
import { createInteractionState, type InteractionStateRef } from '../lib/interaction-state';
import { buildTimelineData, buildTimelineDataWithResolver, configToRows, type TimelineData } from '../lib/timeline-data';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { getConfigSignature, getStableConfigSignature } from '../lib/config-utils';
import { createDefaultTimelineConfig } from '../lib/defaults';
import { TimelineSaveError, TimelineVersionConflictError, type DataProvider } from '../data/DataProvider';
import { loadTimelineDraft, saveTimelineDraft } from '../data/timelineDraftIndexedDb';
import type { AssetRegistry } from '../types/index.ts';
import type { VideoEditorRuntimeContextValue } from '../contexts/VideoEditorRuntimeContext';
import type { TimelineEditability } from '../lib/timeline-editability';
import { createCommitOutbox } from '../commands/commitOutbox.ts';
import { ApiError } from '@/integrations/runtime/generated.ts';
import * as timelineDiagnostics from '../lib/timeline-diagnostics';
import { compileFunction } from 'node:vm';
import ts from 'typescript';
import p2TourSource from '../../../../tests/e2e/local/three-products.p2-tour.spec.ts?raw';

vi.mock('@/integrations/runtime/generated-contract-metadata.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/integrations/runtime/generated-contract-metadata.ts')>(),
  SCHEMA_DIGEST: 'sha256:35c2d9c5e0b51ab8d8b7a4f4dbafbdfcb13d232d7bd22fff21cf73e250398d4c',
}));

vi.stubGlobal('indexedDB', createFakeIndexedDB());
vi.mock('@/tools/video-editor/compositions/TimelineRenderer.tsx', () => ({
  invalidateReferencedTimelineCache: vi.fn(),
}));
// jsdom has no video decoder; media authority still comes from the selector transport.
vi.mock('@/shared/lib/media/videoMetadata.ts', () => ({
  extractVideoMetadata: vi.fn(async () => ({ duration_seconds: 8 })),
}));

function makeTimelineData(label: string): TimelineData {
  const base = createDefaultTimelineConfig();
  const config = {
    ...base,
    output: { ...base.output, file: `output-${label}.mp4` },
    tracks: (base.tracks ?? []).map((track) => ({ ...track })),
    clips: [{
      id: `clip-${label}`,
      at: 0,
      track: 'V1' as const,
      clipType: 'hold' as const,
      hold: 1,
    }],
  };
  const rowData = configToRows(config);
  const resolvedConfig = {
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((track) => ({ ...track })),
    clips: config.clips.map((clip) => ({ ...clip, assetEntry: undefined })),
    registry: {},
  };
  return {
    config,
    configVersion: 1,
    registry: { assets: {} },
    resolvedConfig,
    rows: rowData.rows,
    meta: rowData.meta,
    effects: rowData.effects,
    assetMap: {},
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((track) => ({ ...track })),
    clipOrder: rowData.clipOrder,
    signature: getConfigSignature(resolvedConfig),
    stableSignature: getStableConfigSignature(config, { assets: {} }),
  };
}

interface SetupResult {
  hook: {
    result: { current: ReturnType<typeof useTimelineSave> & { history: ReturnType<typeof useTimelineHistory> } };
    unmount: () => void;
  };
  saveTimeline: ReturnType<typeof vi.fn>;
  poll: (data: TimelineData) => void;
  toast: { error: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn> };
  rerenderRuntime: (changes: Partial<VideoEditorRuntimeContextValue>) => void;
}

function PreparedMediaCommandHarness({
  mode,
  afterClipId,
  time,
}: {
  mode: 'image' | 'video';
  afterClipId?: string;
  time: number;
}) {
  const runtime = useVideoEditorRuntime();
  const editor = useTimelineEditorData();
  const ops = useTimelineEditorOps();
  const commands = useTimelineCommandsService();
  const [error, setError] = React.useState<string | null>(null);
  const visualTracks = editor.resolvedConfig?.tracks.filter(track => track.kind === 'visual' && track.role !== 'source') ?? [];
  const selectedClip = afterClipId
    ? editor.resolvedConfig?.clips.find(clip => clip.id === afterClipId)
    : undefined;
  const assets = useAssetManagement({
    dataRef: editor.dataRef,
    selectedTrackId: editor.selectedTrackId,
    selectedProjectId: runtime.project.projectId,
    selectClip: ops.selectClip,
    setSelectedTrackId: ops.setSelectedTrackId,
    applyEdit: ops.applyEdit,
    patchRegistry: ops.patchRegistry,
    invalidateAssetRegistry: async () => {},
    resolveAssetUrl: async file => runtime.assetResolver.resolveAssetUrl(file),
  });

  const importMedia = async (file: File) => {
    setError(null);
    try {
      const uploaded = mode === 'image'
        ? await assets.uploadImageGeneration(file)
        : await assets.uploadVideoGeneration(file);
      let oldMediaSelection: Awaited<ReturnType<NonNullable<typeof runtime.provider.getProjectMediaSelection>>> | undefined;
      if (afterClipId && selectedClip?.asset && runtime.provider.getProjectMediaSelection) {
        const sourceEntry = editor.dataRef.current?.registry?.assets[selectedClip.asset];
        if (sourceEntry?.generationId && sourceEntry.variantId) {
          const query = { asset: selectedClip.asset, generation_id: sourceEntry.generationId, variant_id: sourceEntry.variantId };
          try {
            oldMediaSelection = await runtime.provider.getProjectMediaSelection(runtime.project.projectId, query);
            if (oldMediaSelection.asset !== query.asset || oldMediaSelection.generation_id !== query.generation_id
              || oldMediaSelection.variant_id !== query.variant_id) oldMediaSelection = undefined;
          } catch {
            // The command path retains the local preview and refuses the unverified draft on flush.
          }
        }
      }
      let preparedAsset = assets.prepareGenerationAsset(uploaded);
      if (!preparedAsset) throw new Error('Could not resolve the registered project media selection.');
      if (afterClipId && preparedAsset.mediaSelection) preparedAsset = { ...preparedAsset, assetKey: preparedAsset.mediaSelection.asset };
      const result = commands.addClip({
        preparedAsset,
        trackId: selectedClip?.track ?? visualTracks[0]?.id,
        time: selectedClip?.at ?? time,
        ...(afterClipId ? { afterClipId, oldMediaSelection } : {
          placementPolicy: { kind: 'occurrence-raw-track' as const, trackId: visualTracks[0]?.id ?? editor.selectedTrackId ?? '' },
        }),
      });
      if (!result.ok) throw new Error(result.error.message);
      if (afterClipId && !oldMediaSelection) setError('Could not resolve the source Runtime project media selection. Draft retained; reload the timeline, then import the media again.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not place media.');
    }
  };

  return <>
    <input
      type="file"
      aria-label="Test prepared media"
      onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) void importMedia(file);
      }}
    />
    {error ? <p role="alert">{error}</p> : null}
  </>;
}

function setup(
  saveTimelineImpl: DataProvider['saveTimeline'],
  timelineEditability?: TimelineEditability,
  original?: { data: TimelineData; loadBasis: DataProvider['loadTimelineCommandBasis']; capabilities?: Partial<DataProvider>; strict?: boolean; mediaHarness?: { mode: 'image' | 'video'; afterClipId?: string; time?: number }; provider?: DataProvider; suspend?: () => Promise<void> | undefined },
): SetupResult {
  const saveTimeline = vi.fn(saveTimelineImpl);
  const provider: DataProvider = original?.provider ?? {
    persistenceEnabled: true,
    loadTimeline: vi.fn(async () => ({ config: createDefaultTimelineConfig(), configVersion: 1 })),
    loadAssetRegistry: vi.fn(async () => ({ assets: {} })),
    saveTimeline,
    resolveAssetUrl: vi.fn(async (file: string) => file),
    ...(original ? { loadTimelineCommandBasis: original.loadBasis } : {}),
    ...original?.capabilities,
  };
  const queries: UsePollSyncQueries = {
    timelineQuery: { data: undefined, isLoading: false },
    assetRegistryQuery: { data: undefined },
  };
  const interactionStateRef: InteractionStateRef = { current: createInteractionState() };
  const store = createTimelineStore();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const toast = { error: vi.fn(), success: vi.fn() };
  const runtime = {
    provider,
    project: { projectId: 'project-commit' },
    toast,
    timelineId: 'timeline-1',
    shots: { canonicalDraft: null },
    assetResolver: { resolveAssetUrl: vi.fn(async (file: string) => file) },
    shots: {
      shots: undefined,
      isLoading: false,
      error: null,
      refetchShots: vi.fn(),
    },
    timelineEditability,
  } as unknown as VideoEditorRuntimeContextValue;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <VideoEditorRuntimeProvider value={runtime}>
        <TimelineStoreProvider store={store}>
          {original?.strict ? <React.StrictMode>{children}</React.StrictMode> : original?.suspend ? <React.Suspense fallback={null}>{children}</React.Suspense> : children}
          {original?.mediaHarness ? <PreparedMediaCommandHarness {...original.mediaHarness} time={original.mediaHarness.time ?? 1.25} /> : null}
        </TimelineStoreProvider>
      </VideoEditorRuntimeProvider>
    </QueryClientProvider>
  );
  const hook = renderHook(
    () => {
      const save = useTimelineSave(queries, provider, interactionStateRef, store, original?.data);
      const history = useTimelineHistory({ dataRef: save.dataRef, commitData: save.commitData,
        interactionStateRef, pendingOpsRef: save.pendingOpsRef, remoteHistory: save.localDocumentSave });
      React.useLayoutEffect(() => {
        if (!original?.mediaHarness) return;
        const state = store.getState();
        state.syncSlices({
          data: { ...state.data, data: save.data, dataRef: save.dataRef,
            resolvedConfig: save.data?.resolvedConfig ?? null, selectedTrackId: 'V1', selectedClipIds: new Set(original.mediaHarness?.afterClipId ? [original.mediaHarness.afterClipId] : []) },
          ops: { ...state.ops, applyEdit: save.applyEdit, patchRegistry: save.patchRegistry,
            selectClip: vi.fn(), setSelectedTrackId: save.setSelectedTrackId },
          chrome: { ...state.chrome, saveStatus: save.saveStatus },
            playback: { ...state.playback, currentTime: original.mediaHarness.time ?? 1.25 },
        });
      }, [save.data, save.saveStatus]);
      const suspended = original?.suspend?.();
      if (suspended) throw suspended;
      return { ...save, history };
    },
    { wrapper },
  );
  return { hook, saveTimeline, toast, rerenderRuntime(changes) {
    Object.assign(runtime, changes);
    hook.rerender();
  }, poll(data) {
    queries.timelineQuery.data = data;
    hook.rerender();
  } };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// The hook freezes writes (including owned flushes) until its one-time
// IndexedDB recovery check settles. IndexedDB requests complete in issue
// order, so a read issued after the hook's read resolves only once that check
// has resolved; flush the check's trailing promise handlers afterwards.
async function settleInitialRecoveryCheck() {
  await loadTimelineDraft('timeline-1');
  await flush();
}

describe('useTimelineSave — recovered draft durability', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFakeIndexedDB();
    vi.stubGlobal('indexedDB', createFakeIndexedDB());
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps supported browser element saves on the current mounted persistence path', async () => {
    const harness = setup(async () => 2, undefined, { data: makeTimelineData('browser'), loadBasis: undefined });
    try {
      await settleInitialRecoveryCheck();
      const routes = createElementTimelineRoutes(harness.hook.result.current.elementTimelineRoutes);
      const adapter = new AstridElementOperationAdapter(buildAstridAgentElementContext({}), routes, 'browser');
      let result: Awaited<ReturnType<typeof adapter.execute>> | undefined;
      await act(async () => { result = await adapter.execute({ name: 'timeline.set_clip_fade', project: 'browser',
        timeline: 'timeline-1', expected_version: 1, clip_id: 'clip-browser', fade_in: 0.25 }); });
      expect(harness.saveTimeline).toHaveBeenCalledOnce();
      expect(harness.saveTimeline).toHaveBeenCalledWith('timeline-1', expect.objectContaining({ clips: [
        expect.objectContaining({ id: 'clip-browser', entrance: { type: 'fade', duration: 0.25 } }),
      ] }), 1, expect.anything(), undefined);
      expect(result).toMatchObject({ config_version: 2, config: { clips: [expect.objectContaining({ entrance: { type: 'fade', duration: 0.25 } })] } });
    } finally { harness.hook.unmount(); }
  });

  it.each((['image', 'video'] as const).flatMap(mode =>
    (['accepted', 'merged', 'conflict', 'missing selection', 'retry', 'dependent conflict', ...(mode === 'video' ? ['missing old selection', 'mismatched old selection', 'extra old selection', 'missing old metadata', 'missing selector', 'existing asset', 'rebased', 'invalid'] as const : [])] as const)
      .flatMap(outcome => [[mode, outcome, false] as const,
        ...(['accepted', 'merged', 'conflict', 'retry', 'missing selection', 'invalid'].includes(outcome)
          ? [[mode, outcome, true] as const] : [])])))(
    'routes mounted shot prepared %s through the persisted semantic outbox: %s (children: %s)', async (mode, outcome, children) => {
      // Transport fixtures prove App routing/adoption, not Runtime media authority or Python execution.
      const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
      Object.defineProperty(navigator, 'locks', { configurable: true, value: {
        request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}),
      } });
      const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-1' };
      const head = { projectId: scope.projectId, timelineId: scope.timelineId, headRevisionId: 'r0', headPublicationId: 'p0' };
      const config = createDefaultTimelineConfig();
      if (mode === 'image') {
        // Same untouched canonical track shape as the historical IMAGE input.
        config.tracks = [{ id: 'V1', kind: 'visual', role: 'output', ...{ opaque: [null, false] } },
          { id: 'A1', kind: 'audio', ...{ label: null, app: null } }];
      }
      const oldMedia = { asset: 'old-video', generation_id: 'generation-old', variant_id: 'variant-old',
        object_id: `sha256:${'c'.repeat(64)}`, catalog_digest: `sha256:${'d'.repeat(64)}` };
      const registry: AssetRegistry = { assets: mode === 'video' ? { 'old-video': { media_id: oldMedia.object_id, type: 'video',
        generationId: oldMedia.generation_id, variantId: oldMedia.variant_id } } : {} };
      if (outcome === 'missing old metadata') delete registry.assets[oldMedia.asset].variantId;
      if (outcome === 'existing asset') registry.assets['variant-new'] = { type: 'video', media_id: `sha256:${'a'.repeat(64)}`, generationId: 'generation-new', variantId: 'variant-new' };
      if (mode === 'video') {
        config.tracks.push({ id: 'V2', kind: 'visual' });
        config.clips = [
          { id: 'source', track: 'V1', at: 0, asset: oldMedia.asset, clipType: 'media', from: 1, to: 5, speed: 2,
            transition: { type: 'crossfade', duration: .5 }, params: { opaque: [null, false] } },
          { id: 'later', track: 'V1', at: 4, asset: oldMedia.asset, clipType: 'media', hold: 2 },
          { id: 'unrelated', track: 'V2', at: 1, asset: oldMedia.asset, clipType: 'media', hold: 2 },
        ];
      }
      const initialReply = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }, { timelineId: scope.timelineId, children });
      const document = initialReply.data.canonical_document;
      if (children) {
        config.tracks.push({ id: 'picture', kind: 'visual' });
        for (const occurrence of document.parent_revision.payload.occurrences as Array<Record<string, unknown>>) {
          occurrence.track = 'picture';
          (occurrence.placement as Record<string, unknown>).track = 'picture';
        }
      }
      document.parent_revision.payload = { config: JSON.parse(JSON.stringify(config)), clips: JSON.parse(JSON.stringify(config.clips)), registry, occurrences: document.parent_revision.payload.occurrences,
        metadata: { opaque: [null, false], absent: null } };
      document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
      const originalDocument = JSON.stringify(document);
      const closure = (value: typeof document) => JSON.stringify({ shots: value.shot_revisions, internals: value.internal_timeline_revisions,
        pins: value.dependency_manifest, occurrences: value.parent_revision.payload.occurrences });
      const originalClosure = closure(document);
      const initial = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
      const data = mode === 'image'
        ? await buildTimelineDataWithResolver(config, registry, { resolveAssetUrl: file => file }, 1, scope.timelineId, undefined, head)
        : await buildTimelineData(config, registry, undefined, 1, undefined, head);
      const media = { asset: 'variant-new', generation_id: 'generation-new', variant_id: 'variant-new',
        object_id: `sha256:${'a'.repeat(64)}`, catalog_digest: `sha256:${'b'.repeat(64)}` };
      const entry = { file: `runtime-import.${mode === 'video' ? 'mp4' : 'png'}`, type: `${mode}/${mode === 'video' ? 'mp4' : 'png'}`, media_id: media.object_id };
      const instance = runtimeFixture();
      const posts: Array<{ body: string; key: string }> = [];
      let harness: SetupResult | undefined;
      let landed: ReturnType<typeof acceptedCommit> | undefined;
      let imports = 0;
      const canonicalAt = children ? 2.2 : 2.25;
      const runtime = new RuntimeDataProvider({ projectId: scope.projectId, transport: async (method, path, headers, body) => {
        if (method === 'GET' && path.includes('/media-selection?')) {
          const query = new URL(path, 'http://runtime.test').searchParams;
          expect(Object.fromEntries(query)).toEqual({ asset: oldMedia.asset, generation_id: oldMedia.generation_id, variant_id: oldMedia.variant_id });
          return outcome === 'missing old selection' ? { status: 404, headers: {}, body: json({ code: 'not_found', message: 'Selection unavailable' }) }
            : { status: 200, headers: {}, body: json(outcome === 'mismatched old selection' ? { ...oldMedia, variant_id: 'changed' }
              : outcome === 'extra old selection' ? { ...oldMedia, extra: true } : oldMedia) };
        }
        if (method !== 'POST' || !path.endsWith('/commit')) return instance.transport(method, path, headers, body);
        posts.push({ body: new TextDecoder().decode(body), key: headers['Idempotency-Key'] });
        const [durable] = await createCommitOutbox().list(scope);
        expect(durable.pending?.request).toMatchObject(posts.at(-1)!);
        if (posts.length === 1) expect(durable.intents[0].payload).toHaveProperty('before', document);
        const metadata = children && outcome === 'accepted' && posts.length > 1 ? { provider: 'canonical result' } : document.parent_revision.payload.metadata;
        for (const intent of durable.intents) {
          for (const image of ['before', 'after'] as const) {
            expect(closure((intent.payload as unknown as Record<string, typeof document>)[image])).toBe(originalClosure);
          }
          expect(intent.payload).toMatchObject({ before: { parent_revision: { payload: {
            config: { tracks: config.tracks }, metadata,
          } } }, after: { parent_revision: { payload: {
            config: { tracks: config.tracks }, metadata,
          } } } });
          expect(intent.payload).toHaveProperty('before.parent_revision.payload.config.tracks', config.tracks);
          expect(intent.payload).toHaveProperty('after.parent_revision.payload.config.tracks', config.tracks);
        }
        expect(JSON.stringify(document)).toBe(originalDocument);
        if (outcome === 'invalid') return { status: 422, headers: {}, body: json({ code: 'invalid', message: 'Media selection changed',
          details: { status: 'invalid', code: 'selection_changed', path: ['commands', '0', 'args', 'old_media'], hint: 'Reload media', suggested_command: 'timeline show' } }) };
        if (outcome === 'conflict' || (outcome === 'dependent conflict' && posts.length === 2)) return { status: 409, headers: {}, body: json({ code: 'conflict',
          message: 'Media track changed; draft retained', details: { status: 'conflict', reason: 'dependency_changed',
            base: { revision_id: 'r0', publication_id: 'p0' }, current: { revision_id: 'agent-r', publication_id: 'agent-p' }, conflicts: [] } }) };
        if (!landed || (children && outcome === 'accepted' && posts.length === 2)) {
          const request = JSON.parse(posts.at(-1)!.body) as CommitRequest;
          landed = acceptedCommit({ revision_id: `r${posts.length}`, publication_id: `p${posts.length}` },
            { revision_id: request.base_revision_id, publication_id: request.base_publication_id }, { timelineId: scope.timelineId, commands: request.commands });
          const canonical = landed.data.canonical_document;
          canonical.shot_revisions = structuredClone(document.shot_revisions);
          canonical.internal_timeline_revisions = structuredClone(document.internal_timeline_revisions);
          canonical.dependency_manifest = structuredClone(document.dependency_manifest);
          const local = harness!.hook.result.current.dataRef.current!;
          const canonicalConfig = JSON.parse(JSON.stringify(local.config)) as typeof config;
          // Fixture replies preserve canonical fields the display does not model.
          canonicalConfig.tracks = structuredClone(config.tracks);
          const born = canonicalConfig.clips.find(clip => clip.asset !== oldMedia.asset)!;
          born.at = canonicalAt;
          canonical.parent_revision.payload = { config: canonicalConfig, clips: canonicalConfig.clips,
            registry: JSON.parse(JSON.stringify(local.registry)), occurrences: structuredClone(document.parent_revision.payload.occurrences), metadata: { provider: 'canonical result' } };
          canonical.parent_revision.content_digest = fixtureDigest(canonical.parent_revision.payload);
          landed.data.document_digest = fixtureDigest(canonical);
          landed.data.label = request.label;
          landed.data.steps = request.steps;
          landed.data.merge_mode = request.merge;
          if (outcome === 'merged' || outcome === 'rebased') Object.assign(landed.data, { status: outcome, previous_revision_id: 'agent-r',
            previous_publication_id: 'agent-p', rebased_onto: { revision_id: 'agent-r', publication_id: 'agent-p' } });
          landed.receipt.idempotency_key = posts.at(-1)!.key;
        }
        if (outcome === 'retry' && posts.length === 1) throw new Error('Acknowledgement lost');
        return { status: 200, headers: {}, body: json(landed) };
      } });
      try {
        harness = setup(async () => { throw new Error('No legacy save'); }, undefined, { data,
          loadBasis: async () => landed ? { head: { revisionId: landed.data.accepted_revision_id, publicationId: landed.receipt.receipt_id }, canonicalDocument: landed.data.canonical_document } : initial,
          mediaHarness: { mode, ...(mode === 'video' ? { afterClipId: 'source' } : {}), time: children ? (imports ? 10 : 1.25) : 1.25 }, capabilities: {
            ...(outcome === 'missing selector' ? {} : { getProjectMediaSelection: runtime.getProjectMediaSelection.bind(runtime) }),
            getRecoverableIdentity: async () => ({ realmId: scope.realmId, actorId: scope.actorId }),
            commitTimeline: (request, key) => runtime.commitTimeline(request, key),
            prepareMediaImport: vi.fn(async () => {
              const second = ++imports === 2;
              const selection = second ? { ...media, asset: 'variant-second', generation_id: 'generation-second', variant_id: 'variant-second', object_id: `sha256:${'e'.repeat(64)}` } : media;
              return { provider: 'runtime', project: scope.projectId, importOperationId: second ? 'import-second' : 'import-new',
                generationId: selection.generation_id, variantId: selection.variant_id, assetId: second ? 'import-second' : 'import-alias',
                entry: second ? { ...entry, file: `runtime-second.${mode === 'video' ? 'mp4' : 'png'}`, media_id: selection.object_id } : entry,
                ...(outcome === 'missing selection' ? {} : { mediaSelection: selection }) };
            }),
          } });
        await vi.waitFor(() => expect(harness!.hook.result.current.localSaveState?.ownerId).toBeTruthy());
        await settleInitialRecoveryCheck();
        if (mode === 'image') {
          expect(data.config.tracks[0]).not.toHaveProperty('opaque');
          expect(data.resolvedConfig.tracks[0]).not.toHaveProperty('opaque');
          expect(config.tracks[0]).toHaveProperty('opaque', [null, false]);
          expect(config.tracks[0]).not.toHaveProperty('label');
          expect(config.tracks[1]).toMatchObject({ label: null, app: null });
        }
        await act(async () => {
          fireEvent.change(screen.getByLabelText('Test prepared media'), {
            target: { files: [new File([mode], `new.${mode === 'video' ? 'mp4' : 'png'}`, { type: entry.type })] },
          });
        });
        if (outcome === 'missing selection') {
          await vi.waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Runtime project media selection'));
          expect(screen.getByRole('alert')).toHaveTextContent('Import the media again');
          expect(harness.hook.result.current.dataRef.current!.config.clips).toEqual(data.config.clips);
          await act(async () => { await harness!.hook.result.current.flushPendingSave(); });
          expect(posts).toEqual([]);
          expect((await createCommitOutbox().list(scope))[0].intents).toEqual([]);
          return;
        }
        await vi.waitFor(() => expect(harness!.hook.result.current.dataRef.current!.config.clips).toHaveLength(mode === 'video' ? 4 : 1));
        const bornId = harness.hook.result.current.dataRef.current!.config.clips[mode === 'video' ? 1 : 0].id;
        if (mode === 'video') {
          const preview = harness.hook.result.current.dataRef.current!.config.clips;
          expect(preview[1]).toMatchObject({ asset: media.asset, at: 2, from: 1, to: 5, speed: 2, transition: config.clips[0].transition, params: config.clips[0].params });
          expect(preview[2]).toMatchObject({ id: 'later', at: 6 });
          expect(preview[3]).toEqual(data.config.clips[2]);
        }
        if (['missing old selection', 'mismatched old selection', 'extra old selection', 'missing old metadata', 'missing selector'].includes(outcome)) {
          if (outcome !== 'extra old selection') await vi.waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('source Runtime project media selection. Draft retained'));
          await act(async () => { await expect(harness!.hook.result.current.flushPendingSave()).rejects.toThrow('both exact Runtime'); });
          const [draft] = await createCommitOutbox().list(scope);
          expect(draft.intents).toEqual([]);
          expect(draft.pending).toBeUndefined();
          expect(posts).toEqual([]);
          return;
        }
        if (outcome === 'dependent conflict') {
          const editing = renderHook(() => useClipEditing({ dataRef: harness!.hook.result.current.dataRef,
            resolvedConfig: harness!.hook.result.current.dataRef.current!.resolvedConfig,
            selectedClipId: harness!.hook.result.current.selectedClipId, selectedTrack: null, currentTime: 0,
            selectClip: vi.fn(), setSelectedTrackId: vi.fn(), applyEdit: harness!.hook.result.current.applyEdit }));
          await act(async () => { editing.result.current.handleSelectedClipChange({ hold: 1 }); });
          editing.unmount();
        }
        await act(async () => {
          const saving = harness!.hook.result.current.flushPendingSave();
          if (['conflict', 'invalid', 'retry', 'dependent conflict'].includes(outcome)) await expect(saving).rejects.toThrow();
          else await saving;
        });
        const [stored] = await createCommitOutbox().list(scope);
        const request = JSON.parse(posts[0].body) as CommitRequest;
        expect(JSON.stringify(document)).toBe(originalDocument);
        if (mode === 'video') {
          expect(request).toMatchObject({ api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
            base_revision_id: 'r0', base_publication_id: 'p0', label: 'Add video after clip', merge: 'fields', dry_run: false, source: { via: 'app' },
            commands: [{ schema_version: 1, op: 'clip.duplicate-media', version: '1', select: 'parent/clip:source',
              args: { id: bornId, old_media: oldMedia, media }, intent: { ownership: 'parent' },
              created: [...(outcome === 'existing asset' ? [] : [`parent/asset:${media.asset}`]), `parent/clip:${bornId}`] }],
            reads: [{ kind: 'collection', ref: 'parent', path: ['config', 'clips'], members: ['later', 'source', 'unrelated'], order: ['source', 'later', 'unrelated'] }],
            steps: [{ id: expect.any(String), label: 'Add video after clip', intent: 'Duplicate selected parent video', tags: [], command_ordinals: [0], patch: [],
              reads: [{ kind: 'field', ref: 'parent', path: ['config', 'clips', 'id:source'], state: { state: 'present', value: config.clips[0] } }] }] });
          expect(request.commands[0].args).toEqual({ id: bornId, old_media: oldMedia, media });
          expect(request.rationale).toBe('Duplicate selected parent video');
          expect(request.group_id).toBe(request.steps![0].id);
          expect(Object.keys(request.commands[0].args.old_media as object).sort()).toEqual(Object.keys(oldMedia).sort());
        } else {
          expect(request).toMatchObject({ api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
            base_revision_id: 'r0', base_publication_id: 'p0', label: 'Add media', merge: 'fields', dry_run: false,
            source: { via: 'app' }, steps: [{ id: expect.any(String), label: 'Add media', intent: 'Add media', tags: [], command_ordinals: [0], patch: [] }],
            commands: [{ schema_version: 1, op: 'clip.add-media', version: '1', select: 'parent', intent: {},
              args: { media, row: { asset: 'import-alias', at: 1.2667, track: 'V1' } } }] });
          expect(request.commands).toHaveLength(1);
          // clip.add-media's registered operation policy is a closed empty object.
          expect(request.commands[0].intent).toEqual({});
          expect(request.commands[0].args.media).toEqual(media);
          expect(request).not.toHaveProperty('reads');
        }
        expect(posts[0].key).toBeTruthy();
        expect(harness.saveTimeline).not.toHaveBeenCalled();
        if (outcome === 'dependent conflict') {
          expect(posts).toHaveLength(2);
          const suffix = JSON.parse(posts[1].body) as CommitRequest;
          expect(suffix).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p1', merge: 'fields',
            commands: [{ op: 'doc.patch' }], reads: expect.arrayContaining([
              { kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${mode === 'video' ? request.commands[0].args.id : request.commands[0].args.row.id}`, 'at'],
                state: { state: 'present', value: mode === 'video' ? 2 : 1.2667 } },
            ]) });
          expect(suffix.steps![0].patch).toEqual(suffix.commands[0].args.changes);
          expect(JSON.stringify(suffix.commands[0].args.changes)).not.toContain('tracks');
          expect(stored.intents).toHaveLength(1);
          expect(stored.intents[0].basis).toEqual({ after: stored.accepted!.intentId });
          expect(stored.pending?.outcome).toMatchObject({ kind: 'rejected', error: { details: { reason: 'dependency_changed' } } });
          expect(stored.intents[0].payload).toMatchObject({ after: { parent_revision: { payload: { config: { clips: mode === 'video'
            ? [expect.any(Object), expect.objectContaining({ hold: .5, at: 2 }), expect.any(Object), expect.any(Object)]
            : [{ hold: 1, at: 1.2667 }] } } } } });
          expect(harness.hook.result.current.dataRef.current!.config.clips[mode === 'video' ? 1 : 0].at).toBe(canonicalAt);
          expect(harness.hook.result.current.localSaveState?.error).toMatchObject({ message: expect.stringContaining('Media track changed') });
          return;
        }
        if (outcome === 'invalid') {
          expect(stored.pending?.outcome).toMatchObject({ kind: 'rejected', error: { details: { code: 'selection_changed', path: ['commands', '0', 'args', 'old_media'], hint: 'Reload media', suggested_command: 'timeline show' } } });
          expect(harness.hook.result.current.dataRef.current!.config.clips).toEqual(data.config.clips);
          return;
        }
        if (outcome === 'conflict') {
          expect(stored.pending?.outcome).toMatchObject({ kind: 'rejected', error: { details: { reason: 'dependency_changed',
            current: { revision_id: 'agent-r', publication_id: 'agent-p' } } } });
          expect(stored.intents).toHaveLength(1);
          expect(stored.intents[0].payload).toMatchObject({ after: { parent_revision: { payload: { config: { clips: mode === 'video'
            ? [expect.any(Object), expect.any(Object), expect.any(Object), expect.any(Object)] : [expect.any(Object)] } } } } });
          expect(harness.hook.result.current.dataRef.current!.config.clips).toEqual(data.config.clips);
          expect(harness.hook.result.current.localSaveState?.error).toMatchObject({ message: expect.stringContaining('Media track changed') });
          return;
        }
        if (outcome === 'retry') {
          expect(stored.pending?.request).toMatchObject(posts[0]);
          await act(async () => { await harness!.hook.result.current.localDocumentSave!.flush(); });
          expect(posts).toHaveLength(2);
          expect(posts[1]).toEqual(posts[0]);
        }
        expect(harness.hook.result.current.dataRef.current!.config.clips[mode === 'video' ? 1 : 0].at).toBe(canonicalAt);
        const [settled] = await createCommitOutbox().list(scope);
        expect(settled.intents).toEqual([]);
        expect(settled.accepted?.value).toMatchObject({ response: landed, receipt: landed!.receipt,
          canonicalDocument: landed!.data.canonical_document });
        expect(landed!.data.canonical_document.parent_revision.payload.config).toMatchObject({ tracks: config.tracks });
        expect(closure(landed!.data.canonical_document)).toBe(originalClosure);
        if (children && outcome === 'accepted') {
          const accepted = structuredClone(landed!.data.canonical_document);
          const capture = vi.spyOn(harness.hook.result.current.localDocumentSave!, 'capture');
          await act(async () => {
            fireEvent.change(screen.getByLabelText('Test prepared media'), {
              target: { files: [new File([mode], `second.${mode === 'video' ? 'mp4' : 'png'}`, { type: entry.type })] },
            });
          });
          await vi.waitFor(() => expect(capture).toHaveBeenCalled());
          await capture.mock.results[0].value;
          await vi.waitFor(async () => expect((await createCommitOutbox().list(scope))[0].intents).toHaveLength(1));
          const [dependent] = await createCommitOutbox().list(scope);
          expect(dependent.intents[0].basis).toEqual({ after: dependent.accepted!.intentId });
          expect(dependent.intents[0].payload).toHaveProperty('before', accepted);
          expect(closure((dependent.intents[0].payload as unknown as { after: typeof document }).after)).toBe(originalClosure);
          await act(async () => { await harness!.hook.result.current.localDocumentSave!.flush(); });
          expect(posts).toHaveLength(2);
          const suffix = JSON.parse(posts[1].body) as CommitRequest;
          expect(suffix).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p1', merge: 'fields',
            commands: [{ op: mode === 'video' ? 'clip.duplicate-media' : 'clip.add-media', args: { media: { asset: 'variant-second' } } }] });
          expect(suffix.commands).toHaveLength(1);
          expect(harness.hook.result.current.dataRef.current!.head?.headRevisionId).toBe('r2');
          expect(closure(landed!.data.canonical_document)).toBe(originalClosure);
          const [complete] = await createCommitOutbox().list(scope);
          expect(complete.intents).toEqual([]);
          expect(complete.accepted?.value).toMatchObject({ response: landed, receipt: landed!.receipt,
            canonicalDocument: landed!.data.canonical_document });
        }
        if (!children && mode === 'image' && outcome === 'accepted') {
          const editing = renderHook(() => useClipEditing({ dataRef: harness!.hook.result.current.dataRef,
            resolvedConfig: harness!.hook.result.current.dataRef.current!.resolvedConfig,
            selectedClipId: bornId, selectedTrack: null, currentTime: 0,
            selectClip: vi.fn(), setSelectedTrackId: vi.fn(), applyEdit: harness!.hook.result.current.applyEdit }));
          await act(async () => { editing.result.current.handleSelectedClipChange({ hold: 1 }); });
          editing.unmount();
          const [trimmed] = await createCommitOutbox().list(scope);
          expect(trimmed.intents).toHaveLength(1);
          expect(trimmed.intents[0].payload).toHaveProperty('before', landed!.data.canonical_document);
          expect(trimmed.intents[0].payload).toHaveProperty('after.parent_revision.payload.config.tracks', config.tracks);
          expect(trimmed.intents[0].payload).toMatchObject({ documentIntent: { changes: [
            { op: 'set', path: ['clips', `id:${bornId}`, 'at'], value: 2.2667 },
            { op: 'set', path: ['clips', `id:${bornId}`, 'hold'], value: 1 },
          ] } });
        }
      } finally {
        harness?.hook.unmount();
        if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
        else Reflect.deleteProperty(navigator, 'locks');
      }
    });

  it.each(['before poll adoption', 'during original read', 'after owner ready'] as const)(
    'traces split ACK -> Agent head -> inspector Source In at %s', async (boundary) => {
      const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
      const locks = new Set<string>();
      Object.defineProperty(navigator, 'locks', { configurable: true, value: {
        request: async (name: string, _options: unknown, work: (lock: object | null) => Promise<unknown>) => {
          if (locks.has(name)) return work(null);
          locks.add(name);
          try { return await work({}); } finally { locks.delete(name); }
        },
      } });
      const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-1' };
      const head = { projectId: scope.projectId, timelineId: scope.timelineId, headRevisionId: 'r0', headPublicationId: 'p0' };
      const config = createDefaultTimelineConfig();
      config.clips = [{ id: 'p1-chain-source', at: 0, track: 'V1', clipType: 'media', asset: 'p1-video', from: 0, to: 8, speed: 1, hold: 8,
        app: { opaque: { keep: null, ordered: [false, 0, ''] }, astrid: { for: 8 }, 'org.example': { clear: null } } }];
      const registry = { assets: { 'p1-video': { file: 'p1-video.mp4', type: 'video/mp4', duration: 8 } } };
      const reply = (value: typeof config, revision: string, publication: string, baseRevision: string, basePublication: string) => {
        const response = acceptedCommit({ revision_id: revision, publication_id: publication },
          { revision_id: baseRevision, publication_id: basePublication }, { timelineId: scope.timelineId });
        const document = response.data.canonical_document;
        document.parent_revision.payload = { config: JSON.parse(JSON.stringify(value)), clips: JSON.parse(JSON.stringify(value.clips)), registry, occurrences: [] };
        document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
        response.data.document_digest = fixtureDigest(document);
        return { response, accepted: { revisionId: revision, publicationId: publication },
          canonicalDocument: document, graph: {}, receipt: response.receipt };
      };
      const initial = reply(config, 'r0', 'p0', 'r0', 'p0');
      let latest = { head: initial.accepted, canonicalDocument: initial.canonicalDocument };
      let finishRead: (() => void) | undefined;
      const loadBasis = vi.fn(async () => latest);
      const send = vi.fn<NonNullable<DataProvider['commitTimeline']>>();
      let acknowledge!: (value: Awaited<ReturnType<NonNullable<DataProvider['commitTimeline']>>>) => void;
      send.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
      const data = await buildTimelineData(config, registry, undefined, 1, undefined, head);
      const harness = setup(async () => { throw new Error('Legacy save must not be called'); }, undefined, {
        data, loadBasis, capabilities: { commitTimeline: send,
          getRecoverableIdentity: vi.fn(async () => ({ actorId: scope.actorId, realmId: scope.realmId })) },
      });
      const editing = renderHook(() => useClipEditing({
        dataRef: harness.hook.result.current.dataRef,
        resolvedConfig: harness.hook.result.current.dataRef.current?.resolvedConfig ?? null,
        selectedClipId: harness.hook.result.current.selectedClipId,
        selectedTrack: null, currentTime: 2, selectClip: vi.fn(), setSelectedTrackId: vi.fn(),
        applyEdit: harness.hook.result.current.applyEdit,
      }));
      try {
        await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.ownerId).toBeTruthy());
        await settleInitialRecoveryCheck();
        expect(harness.hook.result.current.originalLocalSaveBasis).toMatchObject({ status: 'ready', value: { initial: latest } });
        await act(async () => { editing.result.current.handleSplitClipAtTime('p1-chain-source', 2); });
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
        const rightId = harness.hook.result.current.selectedClipId!;
        expect(rightId).not.toBe(config.clips[0].id);
        const splitConfig = structuredClone(harness.hook.result.current.dataRef.current!.config);
        const split = reply(splitConfig, 'r1', 'p1', 'r0', 'p0');
        latest = { head: split.accepted, canonicalDocument: split.canonicalDocument };
        await act(async () => { acknowledge(split); });
        await vi.waitFor(() => expect(harness.hook.result.current.localSaveState).toMatchObject({ status: 'saved' }));
        expect(harness.hook.result.current.dataRef.current?.head?.headRevisionId).toBe('r1');
        const oldOwner = harness.hook.result.current.localSaveState!.ownerId;
        const [acceptedOwner] = await createCommitOutbox().list(scope);
        expect(acceptedOwner.intents).toHaveLength(0);

        // Exact native-move output established by P1's real Agent run; no local executor.
        const agentConfig = structuredClone(splitConfig);
        const right = agentConfig.clips.find((clip) => clip.id === rightId)!;
        Object.assign(right, { at: 3, app: { ...right.app, astrid: { fixed_start: true, for: 6 } } });
        const agent = reply(agentConfig, 'ra', 'pa', 'r1', 'p1');
        latest = { head: agent.accepted, canonicalDocument: agent.canonicalDocument };
        const agentData = await buildTimelineData(agentConfig, registry, undefined, 2, undefined,
          { ...head, headRevisionId: 'ra', headPublicationId: 'pa' });
        expect(agentData.config.clips).toEqual(agentConfig.clips);
        expect(agent.canonicalDocument.parent_revision.payload.clips).toEqual(agentConfig.clips);
        if (boundary === 'during original read') loadBasis.mockImplementationOnce(() => new Promise((resolve) => {
          finishRead = () => resolve(latest);
        }));
        act(() => harness.poll(agentData));
        if (boundary === 'before poll adoption') {
          expect(harness.hook.result.current.dataRef.current?.head?.headRevisionId).toBe('r1');
          expect(harness.hook.result.current.localSaveState?.ownerId).toBe(oldOwner);
        }
        if (boundary !== 'before poll adoption') {
          await act(async () => { await vi.advanceTimersByTimeAsync(0); });
          expect(harness.hook.result.current.dataRef.current?.head?.headRevisionId).toBe('ra');
          if (boundary === 'during original read') {
            expect(finishRead).toBeTypeOf('function');
            expect(harness.hook.result.current.originalLocalSaveBasis).toEqual({ status: 'loading' });
          } else {
            await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.ownerId).not.toBe(oldOwner));
            expect(harness.hook.result.current.originalLocalSaveBasis).toMatchObject({ status: 'ready', value: { initial: latest } });
          }
        }
        const capture = vi.spyOn(harness.hook.result.current.localDocumentSave!, 'capture');
        editing.rerender();
        const displayed = structuredClone(harness.hook.result.current.dataRef.current!);
        expect(displayed.config.clips.find((clip) => clip.id === rightId)).toMatchObject({ from: 0, to: 8, hold: 6, speed: 1 });
        await act(async () => { editing.result.current.handleSelectedClipChange({ from: 3 }); });
        expect(capture).toHaveBeenCalledTimes(1);
        expect(capture.mock.calls[0][1]).toMatchObject({ kind: 'trim', clipId: rightId, patch: { from: 3 },
          config: displayed.config, registry: displayed.registry });
        expect(harness.hook.result.current.dataRef.current?.config.clips.find((clip) => clip.id === rightId))
          .toEqual({ ...displayed.config.clips.find((clip) => clip.id === rightId), from: 3 });
        if (boundary === 'during original read') {
          await act(async () => { finishRead!(); });
          await expect(capture.mock.results[0].value).rejects.toThrow('Local edits preceded the original verified read');
          await act(async () => {
            await expect(harness.hook.result.current.flushPendingSave()).rejects.toThrow('Local edits preceded the original verified read');
          });
          expect(harness.hook.result.current.originalLocalSaveBasis).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('Local edits preceded completion') });
          expect(harness.hook.result.current.localSaveState).toMatchObject({ status: 'error', error: {
            message: 'Local edits preceded the original verified read; draft retained' } });
          expect((await createCommitOutbox().list(scope)).every((owner) => !owner.intents.length && !owner.pending)).toBe(true);
          expect(send).toHaveBeenCalledTimes(1);
          expect((await loadTimelineDraft(scope.timelineId))?.draft.config.clips.find((clip) => clip.id === rightId)?.from).toBe(3);
        } else {
          await capture.mock.results[0].value;
          const owners = await createCommitOutbox().list(scope);
          const owner = owners.find((value) => value.intents.length)!;
          expect(owner.ownerId).toBe(boundary === 'before poll adoption' ? oldOwner : harness.hook.result.current.localSaveState?.ownerId);
          const intent = owner.intents[0];
          expect(intent.basis).toEqual(boundary === 'before poll adoption'
            ? { after: acceptedOwner.accepted!.intentId } : { head: agent.accepted });
          const patch = (intent.payload as unknown as { documentIntent: { changes: unknown[]; reads: unknown[]; step: { id: string } } }).documentIntent;
          expect(patch.changes).toEqual([{ op: 'set', ref: 'parent', path: ['clips', `id:${rightId}`, 'from'],
            before: { state: 'present', value: 0 }, value: 3 }]);
          expect(intent.payload).toMatchObject({ after: { parent_revision: { payload: {
            config: { clips: expect.arrayContaining([expect.objectContaining({ id: rightId, from: 3, hold: 6 })]) },
            clips: expect.arrayContaining([expect.objectContaining({ id: rightId, from: 3, hold: 6 })]),
          } } } });
          expect(patch.reads).toEqual(expect.arrayContaining([{ kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${rightId}`, 'at'],
            state: { state: 'present', value: boundary === 'before poll adoption' ? 2 : 3 } },
          { kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${rightId}`, 'from'], state: { state: 'present', value: 0 } }]));
          let finishSend!: () => void;
          send.mockImplementationOnce(() => new Promise((resolve, reject) => {
            finishSend = () => boundary === 'before poll adoption'
              ? reject(new ApiError(409, 'conflict', 'Agent changed the captured timing read', '', { status: 'conflict', reason: 'dependency_changed' }))
              : resolve(reply(harness.hook.result.current.dataRef.current!.config, 'r2', 'p2', 'ra', 'pa'));
          }));
          await act(async () => { await vi.advanceTimersByTimeAsync(500); });
          await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
          const [request, key] = send.mock.calls[1];
          expect(request).toMatchObject({ api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
            base_revision_id: boundary === 'before poll adoption' ? 'r1' : 'ra',
            base_publication_id: boundary === 'before poll adoption' ? 'p1' : 'pa', merge: 'fields', dry_run: false,
            source: { via: 'app' }, label: 'Edit timeline', commands: [{ op: 'doc.patch', args: { changes: patch.changes } }],
            reads: patch.reads, steps: [{ id: patch.step.id, command_ordinals: [0], patch: patch.changes }] });
          const pending = (await createCommitOutbox().list(scope)).find((value) => value.ownerId === owner.ownerId)!;
          expect(pending.pending?.request.key).toBe(key);
          expect(pending.pending?.request.body).toBe(JSON.stringify(request));
          expect(pending.intents[0]).toEqual(intent);
          await act(async () => { finishSend(); });
          await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.status)
            .toBe(boundary === 'before poll adoption' ? 'conflict' : 'saved'));
          expect(harness.hook.result.current.dataRef.current?.config.clips.find((clip) => clip.id === rightId))
            .toEqual({ ...right, from: boundary === 'before poll adoption' ? 0 : 3 });
        }
        expect(harness.saveTimeline).not.toHaveBeenCalled();
      } finally {
        finishRead?.();
        editing.unmount();
        harness.hook.unmount();
        await vi.waitFor(() => expect(locks.size).toBe(0));
        if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
        else Reflect.deleteProperty(navigator, 'locks');
      }
    });

  it.each([
    ['accepted', 'absent'], ['merged', 'absent'], ['accepted', 'null'], ['merged', 'null'],
  ] as const)('chains Source In after a mounted %s split with %s background fields', async (outcome, fields) => {
    // Synthetic canonical replies exercise App transport/adoption, not Runtime execution.
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}),
    } });
    const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-1' };
    const head = { projectId: scope.projectId, timelineId: scope.timelineId, headRevisionId: 'r0', headPublicationId: 'p0' };
    const config = { ...createDefaultTimelineConfig(), opaque: { keep: [null, false, 0, ''] } };
    config.clips = [{ id: 'source', at: 0, track: 'V1', clipType: 'media', asset: 'video', from: 0, to: 8, speed: 1, hold: 8,
      app: { 'org.example': { clear: null } } }];
    const registry = { assets: { video: { file: 'video.mp4', type: 'video/mp4', duration: 8 } } };
    const bootstrap = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' },
      { timelineId: scope.timelineId });
    bootstrap.data.canonical_document.parent_revision.payload = { config, clips: config.clips, registry, occurrences: [], opaque: { keep: null } };
    bootstrap.data.canonical_document.parent_revision.content_digest = fixtureDigest(bootstrap.data.canonical_document.parent_revision.payload);
    const initial = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: bootstrap.data.canonical_document };
    const data = await buildTimelineData(config, registry, undefined, 1, undefined, head);
    const instance = runtimeFixture();
    const posts: Array<{ body: string; key: string }> = [];
    const replies: Array<typeof bootstrap> = [];
    const runtime = new RuntimeDataProvider({ projectId: scope.projectId, transport: async (method, path, headers, body) => {
      if (method !== 'POST' || !path.endsWith('/commit')) return instance.transport(method, path, headers, body);
      posts.push({ body: new TextDecoder().decode(body), key: headers['Idempotency-Key'] });
      const request = JSON.parse(posts.at(-1)!.body) as CommitRequest;
      const [durable] = await createCommitOutbox().list(scope);
      expect(durable.pending?.request).toMatchObject(posts.at(-1)!);
      if (posts.length === 2) {
        expect(durable.accepted?.head).toEqual({ revisionId: 'r1', publicationId: 'p1' });
        expect(durable.intents[0].basis).toEqual({ after: durable.accepted!.intentId });
      }
      const local = JSON.parse(JSON.stringify(harness!.hook.result.current.dataRef.current!.config)) as typeof config;
      const raw = { ...local, output: { resolution: config.output.resolution, fps: config.output.fps, file: config.output.file,
        ...(fields === 'null' ? { background: null, background_scale: null } : {}) } };
      if (outcome === 'merged') raw.tracks[0].label = 'Merged track';
      const reply = acceptedCommit({ revision_id: `r${posts.length}`, publication_id: `p${posts.length}` },
        { revision_id: request.base_revision_id, publication_id: request.base_publication_id },
        { timelineId: scope.timelineId, commands: request.commands });
      const document = reply.data.canonical_document;
      document.parent_revision.payload = { ...structuredClone(initial.canonicalDocument.parent_revision.payload),
        config: raw, clips: raw.clips };
      document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
      reply.data.document_digest = fixtureDigest(document);
      Object.assign(reply.data, { label: request.label, steps: request.steps, merge_mode: request.merge });
      if (outcome === 'merged') Object.assign(reply.data, { status: 'merged', previous_revision_id: 'agent-r',
        previous_publication_id: 'agent-p', rebased_onto: { revision_id: 'agent-r', publication_id: 'agent-p' } });
      reply.receipt.idempotency_key = posts.at(-1)!.key;
      replies.push(reply);
      return { status: 200, headers: {}, body: json(reply) };
    } });
    const harness = setup(async () => { throw new Error('No legacy save'); }, undefined, { data, loadBasis: async () => initial,
      capabilities: { getRecoverableIdentity: async () => ({ realmId: scope.realmId, actorId: scope.actorId }),
        commitTimeline: (request, key) => runtime.commitTimeline(request, key) } });
    const editing = renderHook(() => useClipEditing({ dataRef: harness!.hook.result.current.dataRef,
      resolvedConfig: harness!.hook.result.current.dataRef.current?.resolvedConfig ?? null,
      selectedClipId: harness!.hook.result.current.selectedClipId, selectedTrack: null, currentTime: 2,
      selectClip: vi.fn(), setSelectedTrackId: vi.fn(), applyEdit: harness!.hook.result.current.applyEdit }));
    try {
      await vi.waitFor(() => expect(harness!.hook.result.current.localSaveState?.ownerId).toBeTruthy());
      await settleInitialRecoveryCheck();
      await act(async () => { editing.result.current.handleSplitClipAtTime('source', 2); });
      const rightId = harness.hook.result.current.selectedClipId!;
      expect(rightId).not.toBe('source');
      await act(async () => { await harness!.hook.result.current.flushPendingSave(); });
      expect(posts).toHaveLength(1);
      const splitBytes = JSON.stringify(replies[0].data.canonical_document);
      expect(harness.hook.result.current.dataRef.current?.head).toEqual({ ...head, headRevisionId: 'r1', headPublicationId: 'p1' });
      if (outcome === 'merged') expect(harness.hook.result.current.dataRef.current?.config.tracks[0].label).toBe('Merged track');
      editing.rerender();
      await act(async () => { editing.result.current.handleSelectedClipChange({ from: 3 }); });
      await act(async () => { await harness!.hook.result.current.flushPendingSave(); });
      expect(posts).toHaveLength(2);
      expect(posts[1].key).not.toBe(posts[0].key);
      const request = JSON.parse(posts[1].body) as CommitRequest;
      expect(request).toMatchObject({ api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
        base_revision_id: 'r1', base_publication_id: 'p1', label: 'Edit timeline', merge: 'fields', dry_run: false,
        source: { via: 'app' }, commands: [{ schema_version: 1, op: 'doc.patch', version: '1', select: null, created: [] }],
        reads: expect.arrayContaining([{ kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${rightId}`, 'from'],
          state: { state: 'present', value: 0 } }]),
        steps: [{ id: expect.any(String), label: expect.any(String), intent: expect.any(String), tags: [], command_ordinals: [0] }],
      });
      expect(request.steps![0].patch).toEqual(request.commands[0].args.changes);
      expect(request.commands[0].args.changes).toEqual([
        { op: 'set', ref: 'parent', path: ['clips', `id:${rightId}`, 'from'], before: { state: 'present', value: 0 }, value: 3 },
      ]);
      expect(JSON.stringify(replies[0].data.canonical_document)).toBe(splitBytes);
      const [saved] = await createCommitOutbox().list(scope);
      expect(saved.intents).toEqual([]);
      expect(saved.pending).toBeUndefined();
      expect(saved.accepted?.head).toEqual({ revisionId: 'r2', publicationId: 'p2' });
      const accepted = saved.accepted!.value as unknown as { canonicalDocument: typeof initial.canonicalDocument };
      expect(JSON.stringify(accepted.canonicalDocument)).toBe(JSON.stringify(replies[1].data.canonical_document));
      const payload = accepted.canonicalDocument.parent_revision.payload;
      const raw = payload.config as unknown as typeof config;
      expect(raw.output).toEqual({ resolution: config.output.resolution, fps: config.output.fps, file: config.output.file,
        ...(fields === 'null' ? { background: null, background_scale: null } : {}) });
      expect(Object.hasOwn(raw.output, 'background')).toBe(fields === 'null');
      expect(Object.hasOwn(raw.output, 'background_scale')).toBe(fields === 'null');
      expect(raw.opaque).toEqual(config.opaque);
      expect(payload.opaque).toEqual({ keep: null });
      expect(harness.hook.result.current.dataRef.current?.head).toEqual({ ...head, headRevisionId: 'r2', headPublicationId: 'p2' });
      expect(harness.hook.result.current.dataRef.current?.config.clips.find(clip => clip.id === rightId)).toMatchObject({ from: 3, to: 8, at: 2, hold: 6 });
      expect(harness.hook.result.current.localSaveState?.status).toBe('saved');
      expect(harness.toast.error).not.toHaveBeenCalled();
      expect(harness.saveTimeline).not.toHaveBeenCalled();
    } finally {
      editing.unmount();
      harness.hook.unmount();
      if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
      else Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it('persists an inspector trim of the locally split new ID while its split is awaiting acceptance', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}),
    } });
    const head = { projectId: 'project-commit', timelineId: 'timeline-1', headRevisionId: 'r0', headPublicationId: 'p0' };
    const config = createDefaultTimelineConfig();
    config.clips = [{ id: 'p1-chain-source', at: 0, track: 'V1', clipType: 'media', asset: 'p1-video', from: 0, to: 8, speed: 1, hold: 8,
      app: { opaque: { keep: null }, astrid: { for: 8 }, 'org.example': { clear: null } } }];
    const registry = { assets: { 'p1-video': { file: 'p1-video.mp4', type: 'video/mp4', duration: 8 } } };
    const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' },
      { timelineId: 'timeline-1' }).data.canonical_document;
    document.parent_revision.payload = { config, clips: config.clips, registry, occurrences: [] };
    document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
    const initial = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
    const data = await buildTimelineData(config, registry, undefined, 1, undefined, head);
    let acknowledge!: (value: Awaited<ReturnType<NonNullable<DataProvider['commitTimeline']>>>) => void;
    const send = vi.fn<NonNullable<DataProvider['commitTimeline']>>().mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    const harness = setup(async () => { throw new Error('Legacy save must not be called'); }, undefined, {
      data, loadBasis: vi.fn(async () => initial), capabilities: {
        commitTimeline: send, getRecoverableIdentity: vi.fn(async () => ({ actorId: 'actor', realmId: 'realm' })),
      },
    });
    const editing = renderHook(() => useClipEditing({
      dataRef: harness.hook.result.current.dataRef,
      resolvedConfig: harness.hook.result.current.dataRef.current?.resolvedConfig ?? null,
      selectedClipId: harness.hook.result.current.selectedClipId,
      selectedTrack: null, currentTime: 2, selectClip: vi.fn(), setSelectedTrackId: vi.fn(),
      applyEdit: harness.hook.result.current.applyEdit,
    }));
    try {
      await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.ownerId).toBeTruthy());
      await settleInitialRecoveryCheck();
      await act(async () => { editing.result.current.handleSplitClipAtTime('p1-chain-source', 2); });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      const rightId = harness.hook.result.current.selectedClipId!;
      expect(rightId).not.toBe('p1-chain-source');
      const splitConfig = structuredClone(harness.hook.result.current.dataRef.current!.config);
      editing.rerender();
      await act(async () => { editing.result.current.handleSelectedClipChange({ from: 3 }); });
      const [owner] = await createCommitOutbox().list({ realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-1' });
      expect(owner.intents).toHaveLength(2);
      expect(owner.intents[1].basis).toEqual({ after: owner.intents[0].id });
      expect(owner.intents[1].payload).toMatchObject({ documentIntent: {
        changes: expect.arrayContaining([{ op: 'set', ref: 'parent', path: ['clips', `id:${rightId}`, 'from'],
          before: { state: 'present', value: 0 }, value: 3 }]),
        reads: expect.arrayContaining([{ kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${rightId}`, 'from'],
          state: { state: 'present', value: 0 } }]),
      } });
      const trimmedConfig = structuredClone(harness.hook.result.current.dataRef.current!.config);
      const reply = (config: typeof splitConfig, revision: string, publication: string) => {
        const response = acceptedCommit({ revision_id: revision, publication_id: publication },
          { revision_id: 'r0', publication_id: 'p0' }, { timelineId: 'timeline-1' });
        response.data.canonical_document = structuredClone(document);
        response.data.canonical_document.parent_revision.revision_id = revision;
        response.data.canonical_document.parent_revision.payload.config = JSON.parse(JSON.stringify(config));
        response.data.canonical_document.parent_revision.payload.clips = JSON.parse(JSON.stringify(config.clips));
        response.data.canonical_document.parent_revision.content_digest = fixtureDigest(response.data.canonical_document.parent_revision.payload);
        return { response, accepted: { revisionId: revision, publicationId: publication },
          canonicalDocument: response.data.canonical_document, graph: {}, receipt: response.receipt };
      };
      let adopted: TimelineData | null = null;
      send.mockImplementationOnce(async () => {
        adopted = harness.hook.result.current.dataRef.current;
        return reply(trimmedConfig, 'r2', 'p2');
      });
      await act(async () => { acknowledge(reply(splitConfig, 'r1', 'p1')); });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.status).toBe('saved'));
      expect(send).toHaveBeenCalledTimes(2);
      expect(adopted!.head?.headRevisionId).toBe('r1');
      expect(adopted!.config.clips).toEqual(splitConfig.clips);
      const request = send.mock.calls[1][0];
      expect(request).toMatchObject({ api_version: 1, project_id: head.projectId, timeline_id: head.timelineId,
        base_revision_id: 'r1', base_publication_id: 'p1', merge: 'fields', dry_run: false,
        commands: [{ op: 'doc.patch', args: { changes: expect.arrayContaining([
          { op: 'set', ref: 'parent', path: ['clips', `id:${rightId}`, 'from'],
            before: { state: 'present', value: 0 }, value: 3 },
        ]) } }],
        reads: expect.arrayContaining([{ kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${rightId}`, 'from'],
          state: { state: 'present', value: 0 } }]),
      });
      expect(request.steps?.[0].patch).toEqual(request.commands[0].args.changes);
      expect(harness.saveTimeline).not.toHaveBeenCalled();
      expect(harness.hook.result.current.dataRef.current?.head?.headRevisionId).toBe('r2');
      expect(harness.hook.result.current.dataRef.current?.config.clips.find((clip) => clip.id === rightId)).toEqual({
        ...config.clips[0], id: rightId, at: 2, hold: 6, from: 3,
      });
      const [saved] = await createCommitOutbox().list({ realmId: 'realm', actorId: 'actor', projectId: head.projectId, timelineId: head.timelineId });
      expect(saved.intents).toHaveLength(0);
    } finally {
      // Settle the held transport before releasing this mounted durable owner.
      if (acknowledge) {
        send.mockRejectedValue(new ApiError(409, 'conflict', 'Consumed read changed', '', { path: ['hold'], hint: 'Read latest' }));
        const response = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' }, { timelineId: 'timeline-1' });
        response.data.canonical_document = structuredClone(document);
        response.data.canonical_document.parent_revision.revision_id = 'r1';
        await act(async () => { acknowledge({ response, accepted: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: response.data.canonical_document, graph: {}, receipt: response.receipt }); });
      }
      editing.unmount();
      harness.hook.unmount();
      if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
      else Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it.each(['accepted', 'merged', 'lost acknowledgement', 'later_write', 'aba_write', 'history_unavailable', 'invalid', 'legacy_unknown'] as const)(
    'mounted Undo uses the public client, authoritative history and reload (%s)', async (outcome) => {
      const helper = p2TourSource.match(/^function assertRequestV2\([^]*?^}/m)?.[0];
      expect(helper).toBeTruthy();
      const checkUndo = compileFunction(`${ts.transpileModule(helper!, {}).outputText}\nreturn assertRequestV2;`, ['expect'])(expect);
      const locks = new Set<string>();
      const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
      Object.defineProperty(navigator, 'locks', { configurable: true, value: {
        request: async (name: string, _options: unknown, work: (lock: object | null) => Promise<unknown>) => {
          if (locks.has(name)) return work(null);
          locks.add(name);
          try { return await work({}); } finally { locks.delete(name); }
        },
      } });
      const fixture = runtimeFixture();
      const timelineId = 'timeline-1';
      const projectId = 'project-commit';
      const baseConfig = createDefaultTimelineConfig();
      const authoredConfig = { ...baseConfig, output: { ...baseConfig.output, file: 'authored.mp4' } };
      const makeResponse = (ordinal: number, config = authoredConfig) => {
        const response = acceptedCommit({ revision_id: `r${ordinal}`, publication_id: `p${ordinal}` },
          { revision_id: `r${Math.max(0, ordinal - 1)}`, publication_id: `p${Math.max(0, ordinal - 1)}` }, { timelineId });
        response.data.canonical_document.parent_revision.payload = { config: structuredClone(config), clips: [],
          occurrences: [], registry: { assets: {} }, opaque: { keep: null, agent: true } };
        response.data.canonical_document.parent_revision.content_digest = fixtureDigest(response.data.canonical_document.parent_revision.payload);
        response.data.document_digest = fixtureDigest(response.data.canonical_document);
        return response;
      };
      const bootstrap = makeResponse(0, baseConfig);
      let current = bootstrap;
      const images = new Map([['r0', bootstrap.data.canonical_document]]);
      const entry = (response: typeof current, undoOf: string[] = []): HistoryEntry => ({
        publication_id: response.receipt.receipt_id, revision_id: response.data.accepted_revision_id,
        previous: response.receipt.receipt_id === 'p0' ? null
          : { revision_id: response.data.previous_revision_id, publication_id: response.data.previous_publication_id },
        receipt: response.receipt, intent: response.receipt.receipt_id === 'p0' ? 'bootstrap' : 'recorded',
        records: { schema_version: 1, commands: [], steps: response.data.steps, undo_of: undoOf, undo_steps: null, restored_from: null },
        publisher: response.data.publisher, provider_version: response.data.provider_version,
        compiler_version: response.data.compiler_version, label: response.data.label,
      });
      const items = [entry(bootstrap)];
      const posted: { body: string; key: string; path: string }[] = [];
      const assertInverseRequest = (post: typeof posted[number], ordinal: number, label: string) => {
        const body = JSON.parse(post.body) as CommitRequest;
        if (label === 'Undo timeline') checkUndo({ key: post.key, body },
          { revision_id: `r${ordinal}`, publication_id: `p${ordinal}` },
          { projectId, timelineId, publicationId: `p${ordinal}`, action: 'Undo' });
        expect(post.key).toBeTruthy();
        expect(post.path).toBe(`/v1/projects/${projectId}/timelines/${timelineId}/commit`);
        expect(Object.hasOwn(body, 'reads')).toBe(true);
        expect(body).toEqual({
          api_version: 1, project_id: projectId, timeline_id: timelineId,
          base_revision_id: `r${ordinal}`, base_publication_id: `p${ordinal}`,
          commands: [{ schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
            args: { publications: [`p${ordinal}`] } }],
          label, steps: [{ id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
            label, intent: label, tags: [], command_ordinals: [0], patch: [] }],
          merge: 'fields', reads: [], dry_run: false, source: { via: 'app' },
        });
      };
      let lost = false;
      const refused = ['later_write', 'aba_write', 'history_unavailable', 'invalid'].includes(outcome);
      const transport: typeof fixture.transport = async (method, path, headers, body) => {
        if (method === 'GET' && path.includes('/commits?')) {
          const history: HistoryPage = { items, next_cursor: null,
            head: { revision_id: current.data.accepted_revision_id, publication_id: current.receipt.receipt_id } };
          return { status: 200, headers: {}, body: json(history) };
        }
        if (method === 'GET' && path.includes('/composition-revisions/')) {
          const document = images.get(decodeURIComponent(path.split('/').at(-1)!))!;
          return { status: 200, headers: {}, body: json({ project_id: projectId, timeline_id: timelineId,
            revision_id: document.parent_revision.revision_id, payload: document.parent_revision.payload,
            content_digest: document.parent_revision.content_digest, dependency_manifest: document.dependency_manifest }) };
        }
        if (method === 'POST' && path.endsWith('/commit')) {
          const bytes = new TextDecoder().decode(body as Uint8Array);
          const request = JSON.parse(bytes) as CommitRequest;
          if (request.commands[0].op === 'doc.patch') {
            expect(request).toMatchObject({ api_version: 1, project_id: projectId, timeline_id: timelineId,
              base_revision_id: 'r0', base_publication_id: 'p0', label: 'Edit timeline', merge: 'atomic', dry_run: false,
              steps: [{ command_ordinals: [0], patch: request.commands[0].args.changes }] });
            current = makeResponse(1);
            current.data.commands = request.commands;
            current.data.steps = request.steps;
            current.receipt.idempotency_key = headers['Idempotency-Key'];
            images.set('r1', current.data.canonical_document);
            items.push(entry(current));
            if (outcome === 'legacy_unknown') { items[1].intent = 'legacy_unknown'; items[1].records = null; }
            return { status: 200, headers: {}, body: json(current) };
          }
          posted.push({ body: bytes, key: headers['Idempotency-Key'], path });
          if (refused) return { status: outcome === 'invalid' ? 422 : 409, headers: {}, body: json({
            code: outcome, message: 'Guarded inverse refused', request_id: 'undo-refusal', details: {
              status: outcome === 'invalid' ? 'invalid' : 'refused', reason: outcome, code: outcome,
              path: ['config', 'output', 'file'], hint: 'Reload authoritative history',
              base: { revision_id: 'r1', publication_id: 'p1' }, current: { revision_id: 'r1', publication_id: 'p1' }, conflicts: [],
            },
          }) };
          if (!(lost && posted.length === 2)) {
            const ordinal = items.length;
            current = makeResponse(ordinal, ordinal % 2 === 0 ? baseConfig : authoredConfig);
            current.data.commands = request.commands;
            current.data.label = request.label;
            current.data.steps = request.steps;
            current.data.merge_mode = 'fields';
            if (outcome === 'merged') {
              current.data.status = 'merged';
              current.data.rebased_onto = { revision_id: 'agent-r', publication_id: 'agent-p' };
            }
            current.receipt.idempotency_key = headers['Idempotency-Key'];
            images.set(current.data.accepted_revision_id, current.data.canonical_document);
            items.push(entry(current, request.commands[0].args.publications as string[]));
          }
          if (outcome === 'lost acknowledgement' && !lost) { lost = true; throw new Error('Lost acknowledgement'); }
          return { status: 200, headers: {}, body: json(current) };
        }
        return fixture.transport(method, path, headers, body);
      };
      const runtime = new RuntimeDataProvider({ projectId, transport });
      const scope = { actorId: 'actor', realmId: 'realm', projectId, timelineId };
      const mount = async () => {
        const basis = await runtime.loadTimelineCommandBasis(timelineId);
        const head = { projectId, timelineId, headRevisionId: basis.head.revisionId, headPublicationId: basis.head.publicationId };
        const data = await buildTimelineData(basis.canonicalDocument.parent_revision.payload.config as unknown as typeof baseConfig,
          { assets: {} }, undefined, 1, undefined, head);
        return setup(async () => { throw new Error('No snapshot save'); }, undefined, { data,
          loadBasis: () => runtime.loadTimelineCommandBasis(timelineId), capabilities: {
            commitTimeline: (request, key) => runtime.commitTimeline(request, key), getRecoverableIdentity: async () => scope,
          } });
      };
      let harness: Awaited<ReturnType<typeof mount>> | undefined;
      try {
        harness = await mount();
        await vi.waitFor(() => expect(harness!.hook.result.current.localSaveState?.ownerId).toBeTruthy());
        expect(harness.hook.result.current.history.canUndo).toBe(false);
        const edited = await buildTimelineData(authoredConfig, { assets: {} }, undefined, 1, undefined,
          { projectId, timelineId, headRevisionId: 'r0', headPublicationId: 'p0' });
        await act(async () => {
          harness!.hook.result.current.commitData(edited, { save: true });
          await harness!.hook.result.current.flushPendingSave();
        });
        if (outcome === 'legacy_unknown') {
          expect(harness.hook.result.current.history.canUndo).toBe(false);
          act(() => harness!.hook.result.current.history.undo());
          expect(posted).toHaveLength(0);
          expect(harness.saveTimeline).not.toHaveBeenCalled();
          return;
        }
        await vi.waitFor(() => expect(harness!.hook.result.current.history.canUndo).toBe(true));
        act(() => harness!.hook.result.current.history.undo());
        await vi.waitFor(() => expect(posted).toHaveLength(1));
        assertInverseRequest(posted[0], 1, 'Undo timeline');
        if (outcome === 'accepted') {
          const variants: ((candidate: { key: string; body: CommitRequest }) => void)[] = [
            candidate => { delete candidate.body.reads; },
            candidate => { candidate.body.reads = null as unknown as CommitRequest['reads']; },
            candidate => { candidate.body.reads = [{ kind: 'scope', ref: 'timeline', path: [] }]; },
            candidate => { Object.assign(candidate.body, { extra: true }); },
            candidate => { candidate.body.project_id = 'foreign-project'; },
            candidate => { candidate.body.timeline_id = 'foreign-timeline'; },
            candidate => { candidate.body.base_revision_id = 'wrong-revision'; },
            candidate => { candidate.body.base_publication_id = 'wrong-publication'; },
            candidate => { candidate.key = ''; },
            candidate => { candidate.body.commands[0].op = 'doc.patch'; },
            candidate => { candidate.body.commands[0].args.publications = ['wrong-publication']; },
          ];
          for (const mutate of variants) {
            const candidate = { key: posted[0].key, body: JSON.parse(posted[0].body) as CommitRequest };
            mutate(candidate);
            expect(() => checkUndo(candidate, { revision_id: 'r1', publication_id: 'p1' }, false,
              { projectId, timelineId, publicationId: 'p1' })).toThrow();
          }
        }
        if (refused || lost) {
          await vi.waitFor(() => expect(harness!.toast.error).toHaveBeenCalled());
          expect(harness.hook.result.current.history.canUndo).toBe(false);
          expect(harness.hook.result.current.history.canRedo).toBe(false);
          const [stored] = await createCommitOutbox().list(scope);
          expect(stored.pending!.request).toMatchObject({ body: posted[0].body, key: posted[0].key });
          if (refused) {
            expect(stored.pending!.outcome).toMatchObject({ kind: 'rejected', error: { code: outcome,
              details: { code: outcome, path: ['config', 'output', 'file'], hint: 'Reload authoritative history' } } });
            expect(harness.hook.result.current.dataRef.current?.config.output.file).toBe('authored.mp4');
            expect(harness.hook.result.current.localSaveState?.status).toBe('conflict');
            expect(harness.hook.result.current.saveStatus).toBe('error');
            harness.hook.unmount();
            await vi.waitFor(() => expect(locks.size).toBe(0));
            harness = await mount();
            await vi.waitFor(() => expect(harness!.hook.result.current.localSaveState?.status).toBe('conflict'));
            expect(harness.hook.result.current.history.canUndo).toBe(false);
            expect(posted).toHaveLength(1);
            const [retained] = await createCommitOutbox().list(scope);
            expect(retained.pending).toEqual(stored.pending);
            expect(harness.saveTimeline).not.toHaveBeenCalled();
            return;
          }
          expect(harness.hook.result.current.saveStatus).toBe('error');
        } else {
          await vi.waitFor(() => expect(harness!.hook.result.current.history.canRedo).toBe(true));
          expect(harness.hook.result.current.dataRef.current?.config.output.file).toBe(baseConfig.output.file);
          expect(harness.hook.result.current.dataRef.current?.head?.headPublicationId).toBe('p2');
          const [stored] = await createCommitOutbox().list(scope);
          expect(stored.accepted!.value).toMatchObject({ response: current, receipt: current.receipt,
            canonicalDocument: current.data.canonical_document });
        }
        harness.hook.unmount();
        await vi.waitFor(() => expect(locks.size).toBe(0));
        harness = await mount();
        await vi.waitFor(() => expect(harness!.hook.result.current.history.canRedo).toBe(true));
        if (lost) expect(posted[1]).toEqual(posted[0]);
        act(() => harness!.hook.result.current.history.redo());
        await vi.waitFor(() => expect(harness!.hook.result.current.history.canUndo).toBe(true));
        assertInverseRequest(posted.at(-1)!, 2, 'Redo timeline');
        expect(posted.at(-1)!.key).not.toBe(posted[0].key);
        expect(harness.hook.result.current.dataRef.current?.config.output.file).toBe('authored.mp4');
        harness.hook.unmount();
        await vi.waitFor(() => expect(locks.size).toBe(0));
        harness = await mount();
        await vi.waitFor(() => expect(harness!.hook.result.current.history.canUndo).toBe(true));
        act(() => harness!.hook.result.current.history.undo());
        await vi.waitFor(() => expect(harness!.hook.result.current.history.canRedo).toBe(true));
        assertInverseRequest(posted.at(-1)!, 3, 'Undo timeline');
        expect(harness.saveTimeline).not.toHaveBeenCalled();
      } finally {
        harness?.hook.unmount();
        await vi.waitFor(() => expect(locks.size).toBe(0));
        if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
        else Reflect.deleteProperty(navigator, 'locks');
      }
    });

  it.each([
    ['accepted', 'before reload'], ['merged', 'before reload'],
    ['accepted', 'after replay'], ['merged', 'after replay'],
  ] as const)('automatically replays a mounted lost-ACK %s with Runtime restart %s, before a late observer', async (outcome, restartAt) => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    const locks = new Set<string>();
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (name: string, _options: unknown, work: (lock: object | null) => Promise<unknown>) => {
        if (locks.has(name)) return work(null);
        locks.add(name);
        try { return await work({}); } finally { locks.delete(name); }
      },
    } });
    const projectId = 'project-commit';
    const timelineId = 'timeline-1';
    const config = createDefaultTimelineConfig();
    config.clips = [{ id: 'replay-clip', track: 'V1', clipType: 'hold', at: 0, hold: 4 }];
    let trimmed = structuredClone(config);
    const makeReply = (revision: string, publication: string, nextConfig: typeof config) => {
      const reply = acceptedCommit({ revision_id: revision, publication_id: publication },
        { revision_id: 'r0', publication_id: 'p0' }, { projectId, timelineId });
      reply.data.canonical_document.parent_revision.payload = { config: structuredClone(nextConfig),
        clips: structuredClone(nextConfig.clips), registry: { assets: {} }, occurrences: [], opaque: { keep: null } };
      reply.data.canonical_document.parent_revision.content_digest = fixtureDigest(reply.data.canonical_document.parent_revision.payload);
      reply.data.document_digest = fixtureDigest(reply.data.canonical_document);
      return reply;
    };
    const bootstrap = makeReply('r0', 'p0', config);
    let splitReply = bootstrap;
    let landed = bootstrap;
    const entry = (reply: typeof bootstrap): HistoryEntry => ({
      publication_id: reply.receipt.receipt_id, revision_id: reply.data.accepted_revision_id,
      previous: reply === bootstrap ? null : { revision_id: reply.data.previous_revision_id, publication_id: reply.data.previous_publication_id },
      receipt: reply.receipt, intent: reply === bootstrap ? 'bootstrap' : 'recorded',
      records: { schema_version: 1, commands: reply.data.commands, steps: reply.data.steps, undo_of: [], undo_steps: null, restored_from: null },
      publisher: reply.data.publisher, provider_version: reply.data.provider_version, compiler_version: reply.data.compiler_version,
      label: reply.data.label,
    });
    let current = bootstrap;
    const history = [entry(bootstrap)];
    let instance = runtimeFixture({ runtimeInstanceId: 'replay-instance-1' });
    const posts: { body: string; key: string; path: string }[] = [];
    const lateObserved: string[] = [];
    let observerArmed = false;
    const transport: typeof instance.transport = async (method, path, headers, body) => {
      if (method === 'GET' && path.includes('/commits?')) return { status: 200, headers: {}, body: json({
        items: history, next_cursor: null,
        head: { revision_id: current.data.accepted_revision_id, publication_id: current.receipt.receipt_id },
      }) };
      if (method === 'GET' && path.includes('/composition-revisions/')) {
        const document = current.data.canonical_document;
        expect(decodeURIComponent(path.split('/').at(-1)!)).toBe(document.parent_revision.revision_id);
        return { status: 200, headers: {}, body: json({ project_id: projectId, timeline_id: timelineId,
          revision_id: document.parent_revision.revision_id, payload: document.parent_revision.payload,
          content_digest: document.parent_revision.content_digest, dependency_manifest: document.dependency_manifest }) };
      }
      if (method === 'POST' && path.endsWith('/commit')) {
        const bytes = new TextDecoder().decode(body as Uint8Array);
        posts.push({ body: bytes, key: headers['Idempotency-Key'], path });
        if (observerArmed) lateObserved.push(bytes);
        if (posts.length <= 2) {
          const request = JSON.parse(bytes) as CommitRequest;
          const reply = posts.length === 1 ? splitReply : landed;
          reply.data.commands = request.commands;
          reply.data.steps = request.steps;
          reply.data.label = request.label;
          reply.data.merge_mode = request.merge;
          reply.receipt.idempotency_key = headers['Idempotency-Key'];
          reply.receipt.request_hash = fixtureDigest({ operation: 'commitTimeline', path,
            publisher: reply.data.publisher, request }).slice(7);
          if (posts.length === 1) {
            current = splitReply;
            history.push(entry(splitReply));
            return { status: 200, headers: {}, body: json(splitReply) };
          }
          if (outcome === 'merged') {
            const agentConfig = structuredClone(splitReply.data.canonical_document.parent_revision.payload.config) as unknown as typeof config;
            agentConfig.tracks = trimmed.tracks;
            const agent = makeReply('agent-r', 'agent-p', agentConfig);
            Object.assign(agent.data, { base_revision_id: 'split-r', base_publication_id: 'split-p',
              previous_revision_id: 'split-r', previous_publication_id: 'split-p' });
            history.push(entry(agent));
          }
          current = landed;
          history.push(entry(landed));
          throw new Error('Runtime accepted; acknowledgement lost');
        }
        expect(posts.at(-1)).toEqual(posts[1]);
        return { status: 200, headers: {}, body: json(landed) };
      }
      return instance.transport(method, path, headers, body);
    };
    const mount = async () => {
      const runtime = new RuntimeDataProvider({ projectId, transport });
      await runtime.reconnect();
      const identity = await runtime.getRecoverableIdentity();
      const basis = await runtime.loadTimelineCommandBasis(timelineId);
      const head = { projectId, timelineId, headRevisionId: basis.head.revisionId, headPublicationId: basis.head.publicationId };
      const data = await buildTimelineData(basis.canonicalDocument.parent_revision.payload.config as unknown as typeof config,
        { assets: {} }, undefined, 1, undefined, head);
      const harness = setup(async () => { throw new Error('No legacy save'); }, undefined, { data,
        loadBasis: () => runtime.loadTimelineCommandBasis(timelineId), capabilities: {
          commitTimeline: (request, key) => runtime.commitTimeline(request, key),
          getRecoverableIdentity: () => runtime.getRecoverableIdentity(),
        } });
      return { ...harness, runtime, identity, basis };
    };
    let harness: Awaited<ReturnType<typeof mount>> | undefined;
    let editing: ReturnType<typeof renderHook<ReturnType<typeof useClipEditing>, unknown>> | undefined;
    try {
      harness = await mount();
      const identity = harness.identity;
      const scope = { ...identity, projectId, timelineId };
      await vi.waitFor(() => expect(harness!.hook.result.current.localSaveState?.ownerId).toBeTruthy());
      await settleInitialRecoveryCheck();
      editing = renderHook(() => useClipEditing({
        dataRef: harness!.hook.result.current.dataRef,
        resolvedConfig: harness!.hook.result.current.dataRef.current!.resolvedConfig,
        selectedClipId: harness!.hook.result.current.selectedClipId, selectedTrack: null, currentTime: 0,
        selectClip: vi.fn(), setSelectedTrackId: vi.fn(), applyEdit: harness!.hook.result.current.applyEdit,
      }));
      await act(async () => { editing!.result.current.handleSplitClipAtTime('replay-clip', 2); });
      const rightId = harness.hook.result.current.selectedClipId!;
      expect(rightId).not.toBe('replay-clip');
      const splitConfig = JSON.parse(JSON.stringify(harness.hook.result.current.dataRef.current!.config)) as typeof config;
      splitReply = makeReply('split-r', 'split-p', splitConfig);
      await act(async () => { await harness!.hook.result.current.flushPendingSave(); });
      expect(posts).toHaveLength(1);
      const [prefix] = await createCommitOutbox().list(scope);
      expect(prefix.accepted?.head).toEqual({ revisionId: 'split-r', publicationId: 'split-p' });
      expect(prefix.pending).toBeUndefined();
      trimmed = structuredClone(splitConfig);
      trimmed.clips.find((clip) => clip.id === rightId)!.hold = 1;
      if (outcome === 'merged') trimmed.tracks[0].label = 'Intervening Agent edit';
      landed = makeReply('r1', 'p1', trimmed);
      Object.assign(landed.data, { base_revision_id: 'split-r', base_publication_id: 'split-p',
        previous_revision_id: 'split-r', previous_publication_id: 'split-p' });
      if (outcome === 'merged') Object.assign(landed.data, { status: 'merged',
        previous_revision_id: 'agent-r', previous_publication_id: 'agent-p',
        rebased_onto: { revision_id: 'agent-r', publication_id: 'agent-p' } });
      editing.rerender();
      await act(async () => { editing!.result.current.handleSelectedClipChange({ hold: 1 }); });
      await act(async () => { await expect(harness!.hook.result.current.flushPendingSave()).rejects.toThrow(); });
      expect(posts).toHaveLength(2);
      const [pending] = await createCommitOutbox().list(scope);
      expect(pending.ownerId).toBe(prefix.ownerId);
      expect(pending.accepted).toEqual(prefix.accepted);
      expect(pending.pending).toMatchObject({ request: posts[1], outcome: { kind: 'retry' } });
      expect(pending.pending?.request.method).toBe('POST');
      expect(pending.pending?.request.path).toBe(`/v1/projects/${projectId}/timelines/${timelineId}/commit`);
      expect(posts[1].key).not.toBe(posts[0].key);
      expect(pending.intents).toHaveLength(1);
      expect(pending.intents[0].basis).toEqual({ after: prefix.accepted!.intentId });
      const request = JSON.parse(posts[1].body) as CommitRequest;
      expect(request).toMatchObject({ api_version: 1, project_id: projectId, timeline_id: timelineId,
        base_revision_id: 'split-r', base_publication_id: 'split-p', label: 'Edit timeline', merge: 'fields', dry_run: false,
        source: { via: 'app' }, commands: [{ op: 'doc.patch', schema_version: 1, version: '1', select: null, created: [] }],
        reads: expect.arrayContaining([{ kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${rightId}`, 'hold'],
          state: { state: 'present', value: 2 } }]),
        steps: [{ id: expect.any(String), label: expect.any(String), intent: expect.any(String), tags: [], command_ordinals: [0] }],
      });
      expect(request.steps![0].patch).toEqual(request.commands[0].args.changes);
      expect(request.commands[0].args.changes).toEqual(expect.arrayContaining([
        { op: 'set', ref: 'parent', path: ['clips', `id:${rightId}`, 'hold'],
          before: { state: 'present', value: 2 }, value: 1 },
      ]));
      expect(harness.saveTimeline).not.toHaveBeenCalled();
      editing.unmount();
      editing = undefined;
      harness.hook.unmount();
      await vi.waitFor(() => expect(locks.size).toBe(0));
      if (restartAt === 'before reload') instance = runtimeFixture({ runtimeInstanceId: 'replay-instance-2' });
      // Reopen through the authenticated client and current canonical read, not the stale optimistic image.
      harness = await mount();
      expect(harness.identity).toEqual(identity);
      expect(harness.basis.head).toEqual({ revisionId: 'r1', publicationId: 'p1' });
      await vi.waitFor(() => expect(harness!.hook.result.current.localSaveState?.status).toBe('saved'));
      expect(posts).toHaveLength(3);
      expect(posts[2]).toEqual(posts[1]);
      expect(harness.hook.result.current.localSaveState?.ownerId).toBe(pending.ownerId);
      const [replayed] = await createCommitOutbox().list(scope);
      expect(replayed.ownerId).toBe(pending.ownerId);
      expect(replayed.generation).toBeGreaterThan(pending.generation);
      expect(replayed.intents).toEqual([]);
      expect(replayed.pending).toBeUndefined();
      expect(replayed.accepted?.intentId).toBe(pending.intents[0].id);
      expect(replayed.accepted?.value).toMatchObject({ canonicalDocument: landed.data.canonical_document, receipt: landed.receipt });
      expect(harness.hook.result.current.dataRef.current?.head).toMatchObject({ headRevisionId: 'r1', headPublicationId: 'p1' });
      const canonicalDisplay = await buildTimelineData(trimmed, { assets: {} });
      expect(harness.hook.result.current.dataRef.current?.config).toEqual(canonicalDisplay.config);
      expect(harness.hook.result.current.recoveryDraft).toBeNull();
      expect(harness.saveTimeline).not.toHaveBeenCalled();
      // The original P1 observer was armed only after reload, restart and reconnect.
      if (restartAt === 'after replay') {
        harness.hook.unmount();
        await vi.waitFor(() => expect(locks.size).toBe(0));
        instance = runtimeFixture({ runtimeInstanceId: 'replay-instance-2' });
        harness = await mount();
        expect(harness.identity).toEqual(identity);
        await vi.waitFor(() => expect(harness!.hook.result.current.localSaveState?.ownerId).toBeTruthy());
      }
      observerArmed = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(posts).toHaveLength(3);
      expect(lateObserved).toEqual([]);
      expect((await harness.runtime.loadTimelineCommandBasis(timelineId)).history?.items).toHaveLength(outcome === 'merged' ? 4 : 3);
      expect(harness.saveTimeline).not.toHaveBeenCalled();
    } finally {
      editing?.unmount();
      harness?.hook.unmount();
      await vi.waitFor(() => expect(locks.size).toBe(0));
      if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
      else Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it.each(['accepted', 'merged', 'conflict', 'invalid', 'restart', 'restart after cleanup', 'dependent', 'merged dependent', 'late reply', 'strict'] as const)(
    'the production caller uses it: mounted local document %s', async (outcome) => {
      const dependent = outcome === 'dependent' || outcome === 'merged dependent';
      const restart = outcome === 'restart' || outcome === 'restart after cleanup';
      const locks = new Set<string>();
      const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
      Object.defineProperty(navigator, 'locks', { configurable: true, value: {
        request: async (name: string, _options: unknown, work: (lock: object | null) => Promise<unknown>) => {
          if (locks.has(name)) return work(null);
          locks.add(name);
          try { return await work({}); } finally { locks.delete(name); }
        },
      } });
      const head = { projectId: 'project-commit', timelineId: 'timeline-1', headRevisionId: 'r0', headPublicationId: 'p0' };
      const config = createDefaultTimelineConfig();
      const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' },
        { timelineId: 'timeline-1' }).data.canonical_document;
      document.parent_revision.payload = { config, clips: [], registry: { assets: {} }, occurrences: [], opaque: { keep: null } };
      document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
      const data = await buildTimelineData(config, { assets: {} }, undefined, 1, undefined, head);
      const initial = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
      const edited = await buildTimelineData({ ...config, output: { ...config.output, file: 'authored.mp4' } }, data.registry,
        undefined, 1, undefined, head);
      const response = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' },
        { timelineId: 'timeline-1' });
      response.data.canonical_document = structuredClone(document);
      response.data.canonical_document.parent_revision.revision_id = 'r1';
      response.data.canonical_document.parent_revision.payload.config = JSON.parse(JSON.stringify(edited.config));
      response.data.canonical_document.parent_revision.payload.opaque = { keep: null, agent: outcome === 'merged' || outcome === 'merged dependent' };
      if (outcome === 'merged' || outcome === 'merged dependent') Object.assign(response.data, { status: 'merged' });
      const accepted = { response, accepted: { revisionId: 'r1', publicationId: 'p1' },
        canonicalDocument: response.data.canonical_document, graph: {}, receipt: response.receipt };
      const send = vi.fn<DataProvider['commitTimeline'] & object>().mockResolvedValue(accepted);
      let acknowledge!: () => void;
      if (dependent || outcome === 'late reply') {
        send.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = () => resolve(accepted); }));
      }
      if (outcome === 'conflict' || outcome === 'invalid') send.mockRejectedValueOnce(new ApiError(
        outcome === 'conflict' ? 409 : 422, outcome, 'Retain original intent', '', { status: outcome, path: ['output'], hint: 'Read latest' }));
      if (restart) send.mockRejectedValueOnce(new Error('Lost acknowledgement'));
      const original = { data, loadBasis: vi.fn(async () => initial), strict: outcome === 'strict', capabilities: {
        commitTimeline: send, getRecoverableIdentity: vi.fn(async () => ({ actorId: 'actor', realmId: 'realm' })),
      } };
      const harness = setup(async () => { throw new Error('Legacy save must not be called'); }, undefined, original);
      try {
        await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.ownerId).toBeTruthy());
        await act(async () => { harness.hook.result.current.commitData(edited, { save: true }); });
        if (dependent) {
          const second = await buildTimelineData({ ...edited.config, output: { ...edited.config.output, file: 'dependent.mp4' } },
            data.registry, undefined, 1, undefined, head);
          await act(async () => { harness.hook.result.current.commitData(second, { save: true }); });
          const next = structuredClone(accepted);
          next.accepted = { revisionId: 'r2', publicationId: 'p2' };
          next.canonicalDocument.parent_revision.revision_id = 'r2';
          next.canonicalDocument.parent_revision.payload.config = JSON.parse(JSON.stringify(second.config));
          send.mockImplementationOnce(async (request) => {
            // Observe the mounted assembly at transmission, before B can ACK.
            expect(harness.hook.result.current.dataRef.current?.head?.headRevisionId).toBe('r1');
            expect(harness.hook.result.current.dataRef.current?.config.output.file).toBe('authored.mp4');
            expect(request).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p1',
              commands: [{ args: { changes: [{ before: { state: 'present', value: 'authored.mp4' }, value: 'dependent.mp4' }] } }] });
            return next;
          });
        }
        if (dependent || outcome === 'late reply') {
          await act(async () => { await vi.advanceTimersByTimeAsync(500); });
          await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
          if (outcome === 'late reply') {
            const visible = harness.hook.result.current.dataRef.current;
            harness.hook.unmount();
            await vi.waitFor(() => expect(locks.size).toBe(0));
            await act(async () => { acknowledge(); await Promise.resolve(); });
            expect(harness.hook.result.current.dataRef.current).toBe(visible);
            const [durable] = await createCommitOutbox().list({ realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-1' });
            expect(durable.pending?.request.key).toBe(send.mock.calls[0][1]);
            expect(durable.accepted).toBeUndefined();
            return;
          }
          await act(async () => { acknowledge(); await Promise.resolve(); });
        }
        const flushing = act(async () => {
          if (outcome === 'conflict' || outcome === 'invalid' || restart) {
            await expect(harness.hook.result.current.flushPendingSave()).rejects.toThrow();
          } else await harness.hook.result.current.flushPendingSave();
        });
        await flushing;
        const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-1' };
        const [stored] = await createCommitOutbox().list(scope);
        expect(harness.saveTimeline).not.toHaveBeenCalled();
        expect(send.mock.calls[0][0]).toMatchObject({ base_revision_id: 'r0', base_publication_id: 'p0',
          label: 'Edit timeline', merge: 'atomic', dry_run: false,
          commands: [{ op: 'doc.patch', args: { changes: [{ op: 'set', ref: 'parent', path: ['config', 'output', 'file'],
            before: { state: 'present', value: config.output.file }, value: 'authored.mp4' }] } }],
          steps: [{ command_ordinals: [0], intent: 'Save local editor changes' }] });
        if (outcome === 'conflict' || outcome === 'invalid') {
          expect(stored.intents).toHaveLength(1);
          expect(harness.hook.result.current.dataRef.current?.config.output.file).toBe(config.output.file);
          expect(harness.hook.result.current.localSaveState?.status).toBe(outcome === 'conflict' ? 'conflict' : 'error');
        } else if (restart) {
          const exact = structuredClone(send.mock.calls[0]);
          const pending = structuredClone(stored.pending?.request);
          harness.hook.unmount();
          await vi.waitFor(() => expect(locks.size).toBe(0));
          let finishRead: (() => void) | undefined;
          if (outcome === 'restart after cleanup') original.loadBasis.mockImplementationOnce(() => new Promise(resolve => {
            finishRead = () => resolve(initial);
          }));
          const recovered = setup(async () => { throw new Error('Legacy save must not be called'); }, undefined, original);
          try {
            if (finishRead) {
              act(() => recovered.rerenderRuntime({ assetResolver: { resolveAssetUrl: async file => file } }));
              await act(async () => { finishRead!(); });
            }
            await vi.waitFor(() => expect(recovered.hook.result.current.localSaveState?.status).toBe('saved'));
            expect(send.mock.calls[1]).toEqual(exact);
            expect(JSON.stringify(send.mock.calls[1][0])).toBe(pending?.body);
            expect(recovered.hook.result.current.dataRef.current?.head?.headRevisionId).toBe('r1');
            expect(recovered.hook.result.current.localSaveState?.ownerId).toBe(stored.ownerId);
            const [replayed] = await createCommitOutbox().list(scope);
            expect(replayed.pending).toBeUndefined();
            expect(replayed.intents).toEqual([]);
            expect(replayed.generation).toBeGreaterThan(stored.generation);
          } finally { recovered.hook.unmount(); }
        } else {
          expect(stored.intents).toHaveLength(0);
          expect(stored.accepted?.value).toMatchObject({ canonicalDocument: dependent
            ? { parent_revision: { revision_id: 'r2' } } : accepted.canonicalDocument });
          expect(harness.hook.result.current.dataRef.current?.head?.headRevisionId).toBe(dependent ? 'r2' : 'r1');
          expect(harness.hook.result.current.dataRef.current?.config.output.file).toBe(dependent ? 'dependent.mp4' : 'authored.mp4');
          if (dependent) {
            expect(send.mock.calls[1][0]).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p1',
              commands: [{ args: { changes: [{ before: { state: 'present', value: 'authored.mp4' }, value: 'dependent.mp4' }] } }] });
          }
        }
      } finally {
        harness.hook.unmount();
        await vi.waitFor(() => expect(locks.size).toBe(0));
        if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
        else Reflect.deleteProperty(navigator, 'locks');
      }
    });

  it.each(['basis', 'identity', 'basis failure', 'identity failure', 'claim', 'claim failure'] as const)(
    'restarts a cancelled pending verified read for the same mounted owner (%s)', async (boundary) => {
    // Deferred provider responses and Web Locks stand in for browser I/O; the
    // hook, verified closure, session and IndexedDB outbox are production code.
    const duringClaim = boundary.startsWith('claim');
    let finishClaim!: () => void;
    let claimActive = false;
    const claimGate = new Promise<void>((resolve, reject) => {
      finishClaim = () => boundary === 'claim failure' ? reject(new Error('Superseded claim failed')) : resolve();
    });
    // Observe the rejection immediately even when this boundary uses no gate.
    void claimGate.catch(() => {});
    const request = vi.fn(async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => {
      expect(claimActive).toBe(false);
      if (duringClaim && request.mock.calls.length === 1) await claimGate;
      claimActive = true;
      try { return await work({}); } finally { claimActive = false; }
    });
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request,
    } });
    const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-1' };
    const head = { projectId: scope.projectId, timelineId: scope.timelineId, headRevisionId: 'r0', headPublicationId: 'p0' };
    const config = createDefaultTimelineConfig();
    const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' },
      { timelineId: scope.timelineId }).data.canonical_document;
    document.parent_revision.payload = { config, clips: [], registry: { assets: {} }, occurrences: [] };
    document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
    const initial = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
    const data = await buildTimelineData(config, { assets: {} }, undefined, 1, undefined, head);
    const duringIdentity = boundary.startsWith('identity');
    let finishRead!: () => void;
    const loadBasis = vi.fn(async () => initial);
    const identity = vi.fn(async () => ({ realmId: scope.realmId, actorId: scope.actorId }));
    if (duringIdentity) identity.mockImplementationOnce(() => new Promise((resolve, reject) => {
      finishRead = () => boundary.endsWith('failure') ? reject(new Error('Superseded identity failed'))
        : resolve({ realmId: 'stale-realm', actorId: 'stale-actor' });
    }));
    else if (!duringClaim) loadBasis.mockImplementationOnce(() => new Promise((resolve, reject) => {
      finishRead = () => boundary.endsWith('failure') ? reject(new Error('Superseded history failed')) : resolve(initial);
    }));
    const send = vi.fn();
    const harness = setup(async () => { throw new Error('No legacy save'); }, undefined, { data, loadBasis,
      capabilities: { getRecoverableIdentity: identity, commitTimeline: send } });
    try {
      if (duringClaim) await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      else if (duringIdentity) await vi.waitFor(() => expect(identity).toHaveBeenCalledTimes(1));
      else expect(harness.hook.result.current.originalLocalSaveBasis).toEqual({ status: 'loading' });
      expect(await createCommitOutbox().list(scope)).toEqual([]);
      const handoff = harness.hook.result.current.localDocumentSave!;
      const changed = { config: { ...config, output: { ...config.output, file: 'restarted.mp4' } }, registry: data.registry, head };
      const staleCapture = handoff.capture(changed).then(() => 'captured', () => 'rejected');
      // Replacing a context resolver legitimately cleans up and reruns the
      // effect without replacing the provider/timeline owner. This is a
      // controlled trigger, not an attribution of the historical P2 cleanup.
      act(() => harness.rerenderRuntime({ assetResolver: { resolveAssetUrl: async file => file } }));
      expect(harness.hook.result.current.localDocumentSave).toBe(handoff);
      if (duringClaim) {
        await flush();
        expect(request).toHaveBeenCalledTimes(1);
        expect(harness.hook.result.current.localSaveState?.ownerId).toBeUndefined();
        await act(async () => { finishClaim(); });
      } else if (!duringIdentity) {
        await act(async () => { finishRead(); });
        if (boundary === 'basis failure') {
          await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.status).toBe('error'));
          act(() => harness.rerenderRuntime({ assetResolver: { resolveAssetUrl: async file => file } }));
        }
      }
      await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.ownerId).toBeTruthy(), { timeout: 1000 });
      const currentState = harness.hook.result.current.localSaveState;
      await act(async () => { if (!duringClaim) finishRead(); expect(await staleCapture).toBe('rejected'); });
      expect(harness.hook.result.current.localSaveState).toEqual(currentState);
      expect(loadBasis).toHaveBeenCalledTimes(boundary === 'basis' ? 1 : 2);
      expect(identity).toHaveBeenCalledTimes(duringIdentity || duringClaim ? 2 : 1);
      expect(await createCommitOutbox().list({ ...scope, realmId: 'stale-realm', actorId: 'stale-actor' })).toEqual([]);
      expect(harness.hook.result.current.originalLocalSaveBasis).toMatchObject({ status: 'ready', value: { initial } });
      const owners = await createCommitOutbox().list(scope);
      expect(owners).toHaveLength(boundary === 'claim' ? 2 : 1);
      const currentOwner = owners.find(owner => owner.ownerId === harness.hook.result.current.localSaveState?.ownerId)!;
      expect(currentOwner).toBeDefined();
      expect(owners.every(owner => owner.intents.length === 0)).toBe(true);
      await act(async () => { await handoff.capture(changed); });
      const captured = (await createCommitOutbox().list(scope)).find(owner => owner.ownerId === currentOwner.ownerId)!;
      expect(captured.ownerId).toBe(currentOwner.ownerId);
      expect(captured.intents).toHaveLength(1);
      expect(captured.intents[0].payload).toMatchObject({ before: document, after: { parent_revision: { payload: {
        config: { output: { file: 'restarted.mp4' } },
      } } } });
      expect(send).not.toHaveBeenCalled();
      expect(harness.saveTimeline).not.toHaveBeenCalled();
    } finally {
      harness.hook.unmount();
      if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
      else Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it.each(['unmount', 'scope', 'head', 'publication', 'basis failure', 'identity failure', 'closure mismatch'] as const)(
    'does not let a cancelled bootstrap claim or overwrite its replacement (%s)', async (boundary) => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}),
    } });
    const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-1' };
    const head = { projectId: scope.projectId, timelineId: scope.timelineId, headRevisionId: 'r0', headPublicationId: 'p0' };
    const config = createDefaultTimelineConfig();
    const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' },
      { timelineId: scope.timelineId }).data.canonical_document;
    document.parent_revision.payload = { config, clips: [], registry: { assets: {} }, occurrences: [] };
    document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
    const initial = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
    const data = await buildTimelineData(config, { assets: {} }, undefined, 1, undefined, head);
    const nextScope = { ...scope, timelineId: boundary === 'scope' ? 'timeline-2' : scope.timelineId };
    const nextHead = { ...head, timelineId: nextScope.timelineId,
      headRevisionId: boundary === 'head' ? 'r1' : 'r0',
      headPublicationId: boundary === 'head' || boundary === 'publication' ? 'p1' : 'p0' };
    const nextDocument = structuredClone(document);
    nextDocument.timeline_id = nextScope.timelineId;
    nextDocument.parent_revision.revision_id = nextHead.headRevisionId;
    if (boundary === 'closure mismatch') nextDocument.parent_revision.payload.config.output.file = 'unverified.mp4';
    nextDocument.parent_revision.content_digest = fixtureDigest(nextDocument.parent_revision.payload);
    const next = { head: { revisionId: nextHead.headRevisionId, publicationId: nextHead.headPublicationId }, canonicalDocument: nextDocument };
    const nextData = await buildTimelineData(config, data.registry, undefined, 1, undefined, nextHead);
    let finishRead!: (value: typeof initial) => void;
    let rejectRead!: (error: Error) => void;
    const loadBasis = vi.fn(async () => next).mockImplementationOnce(() => new Promise((resolve, reject) => {
      finishRead = resolve;
      rejectRead = reject;
    }));
    const identity = vi.fn(async () => ({ realmId: scope.realmId, actorId: scope.actorId }));
    if (boundary === 'identity failure') identity.mockRejectedValueOnce(new Error('Current identity failed'));
    const send = vi.fn();
    const harness = setup(async () => { throw new Error('No legacy save'); }, undefined, { data, loadBasis,
      capabilities: { getRecoverableIdentity: identity, commitTimeline: send } });
    try {
      const oldHandoff = harness.hook.result.current.localDocumentSave!;
      const staleCapture = oldHandoff.capture({ config, registry: data.registry, head }).then(() => 'captured', () => 'rejected');
      if (boundary === 'unmount') harness.hook.unmount();
      else act(() => {
        if (boundary === 'scope' || boundary === 'head' || boundary === 'publication' || boundary === 'closure mismatch') harness.hook.result.current.commitData(nextData,
          { save: false, skipHistory: true, updateLastSavedSignature: true });
        harness.rerenderRuntime({ timelineId: nextScope.timelineId, assetResolver: { resolveAssetUrl: async file => file } });
      });
      if (boundary === 'basis failure') await act(async () => { rejectRead(new Error('Current history failed')); });
      else if (boundary === 'identity failure') await act(async () => { finishRead(initial); });
      if (boundary === 'scope' || boundary === 'head' || boundary === 'publication') {
        await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.ownerId).toBeTruthy());
      } else if (boundary !== 'unmount') {
        await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.status).toBe('error'));
      }
      const replacement = harness.hook.result.current.localSaveState;
      await act(async () => { if (boundary !== 'basis failure' && boundary !== 'identity failure') finishRead(initial); expect(await staleCapture).toBe('rejected'); });
      expect(harness.hook.result.current.localSaveState).toEqual(replacement);
      if (boundary === 'scope' || boundary === 'head' || boundary === 'publication') {
        expect(loadBasis).toHaveBeenCalledTimes(2);
        expect(harness.hook.result.current.originalLocalSaveBasis).toMatchObject({ status: 'ready', value: { initial: next } });
        expect(harness.hook.result.current.dataRef.current?.head).toEqual(nextHead);
        const owners = await createCommitOutbox().list(nextScope);
        expect(owners).toHaveLength(1);
        expect(owners[0].ownerId).toBe(replacement?.ownerId);
        expect(owners[0].intents).toEqual([]);
        expect(identity).toHaveBeenCalledTimes(1);
        if (boundary === 'scope') expect(await createCommitOutbox().list(scope)).toEqual([]);
      } else {
        expect(await createCommitOutbox().list(scope)).toEqual([]);
        expect(identity).toHaveBeenCalledTimes(boundary === 'identity failure' ? 1 : 0);
        expect(loadBasis).toHaveBeenCalledTimes(boundary === 'closure mismatch' ? 2 : 1);
      }
      expect(send).not.toHaveBeenCalled();
      expect(harness.saveTimeline).not.toHaveBeenCalled();
    } finally {
      harness.hook.unmount();
      if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
      else Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it.each(['original', 'head moved', 'edited during read'])('stages the original verified closure in the real mounted hook (%s)', async (kind) => {
    const head = { projectId: 'project-commit', timelineId: 'timeline-1', headRevisionId: 'r0', headPublicationId: 'p0' };
    const config = createDefaultTimelineConfig();
    const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' },
      { timelineId: 'timeline-1' }).data.canonical_document;
    document.parent_revision.payload = { config, clips: [], registry: { assets: {} }, occurrences: [], opaque: { keep: null } };
    document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
    const data = await buildTimelineData(config, { assets: {} }, undefined, 1, undefined, head);
    const basis = { head: { revisionId: kind === 'head moved' ? 'newer-r' : 'r0', publicationId: kind === 'head moved' ? 'newer-p' : 'p0' }, canonicalDocument: document };
    let finishRead!: (value: typeof basis) => void;
    const loadBasis = vi.fn(() => kind === 'edited during read'
      ? new Promise<typeof basis>((resolve) => { finishRead = resolve; }) : Promise.resolve(basis));
    const harness = setup(async () => 2, undefined, { data, loadBasis });
    await settleInitialRecoveryCheck();
    if (kind === 'edited during read') {
      const edited = await buildTimelineData({ ...config, clips: [{ id: 'new', track: 'V1', at: 0, hold: 1 }] },
        { assets: {} }, undefined, 1, undefined, head);
      act(() => harness.hook.result.current.commitData(edited));
      await act(async () => { finishRead(basis); });
      expect(harness.hook.result.current.originalLocalSaveBasis).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('Local edits preceded completion') });
      expect(harness.hook.result.current.dataRef.current?.config).toEqual(edited.config);
    } else if (kind === 'head moved') {
      expect(harness.hook.result.current.originalLocalSaveBasis).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('original verified authoring head') });
    } else {
      expect(harness.hook.result.current.originalLocalSaveBasis).toMatchObject({ status: 'ready', value: {
        initial: basis, source: { config: data.config, head },
        authoringBundle: { source_mapping: { _runtime_document: document } },
      } });
    }
    expect(loadBasis).toHaveBeenCalledExactlyOnceWith('timeline-1');
    expect(harness.saveTimeline).not.toHaveBeenCalled();
    if (kind === 'edited during read') {
      // Finish this test's actual pending draft/save before the next mount.
      await act(async () => { await harness.hook.result.current.flushPendingSave(); });
    }
    harness.hook.unmount();
  });

  it('passes the exact owned registration target through the existing durable save pipeline', async () => {
    let acknowledge!: (version: number) => void;
    const harness = setup(() => new Promise<number>((resolve) => { acknowledge = resolve; }));
    act(() => harness.hook.result.current.commitData(makeTimelineData('baseline'), { save: false }));
    await settleInitialRecoveryCheck();
    let receipt!: ReturnType<typeof harness.hook.result.current.registrationOwner.patchRegistryOwned>;
    let target!: ReturnType<typeof harness.hook.result.current.registrationOwner.captureSaveTarget>;
    let barrier!: Promise<number>;
    let settled = false;
    await act(async () => {
      const owner = harness.hook.result.current.registrationOwner;
      receipt = owner.patchRegistryOwned('asset-registered', { file: 'registered.png' });
      target = owner.captureSaveTarget(receipt.editSeq);
      barrier = owner.flushSaveTarget(target).then((version) => { settled = true; return version; });
    });
    expect(settled).toBe(false);
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.saveTimeline.mock.calls[0][3]?.assets['asset-registered'].file).toBe('registered.png');
    await act(async () => { acknowledge(2); await barrier; });
    expect(settled).toBe(true);
    expect(harness.hook.result.current.registrationOwner.rollbackRegistration(receipt, target, new Error('late unknown'))).toBe(false);
    harness.hook.unmount();
  });

  it('rolls back a proven no-write registry mutation and never sends its old queued payload', async () => {
    const cause = new TimelineVersionConflictError('CAS denied');
    const harness = setup(async () => { throw cause; });
    act(() => harness.hook.result.current.commitData(makeTimelineData('baseline'), { save: false }));
    await settleInitialRecoveryCheck();
    let receipt!: ReturnType<typeof harness.hook.result.current.registrationOwner.patchRegistryOwned>;
    let target!: ReturnType<typeof harness.hook.result.current.registrationOwner.captureSaveTarget>;
    let failure: unknown;
    await act(async () => {
      const owner = harness.hook.result.current.registrationOwner;
      receipt = owner.patchRegistryOwned('asset-registered', { file: 'registered.png' });
      target = owner.captureSaveTarget(receipt.editSeq);
      failure = await owner.flushSaveTarget(target).catch((error) => error);
    });
    expect(failure).toMatchObject({ target, certainty: 'definitely-uncommitted' });
    act(() => { expect(harness.hook.result.current.registrationOwner.rollbackRegistration(receipt, target, failure)).toBe(true); });
    expect(harness.hook.result.current.dataRef.current?.registry.assets['asset-registered']).toBeUndefined();
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    await flush();
    const draft = await loadTimelineDraft('timeline-1');
    expect((draft?.draft.registry as TimelineData['registry'] | undefined)?.assets['asset-registered']).toBeUndefined();
    harness.hook.unmount();
  });

  it('silently clears a recovery slot that already matches the loaded server snapshot', async () => {
    const harness = setup(async () => 2);
    const server = makeTimelineData('already-saved');
    await saveTimelineDraft(
      'timeline-1',
      { config: server.config, registry: server.registry },
      server.configVersion,
    );

    act(() => {
      harness.hook.result.current.commitData(server, { save: false });
    });
    await flush();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.hook.result.current.recoveryDraft).toBeNull();
    expect(await loadTimelineDraft('timeline-1')).toBeNull();
    harness.hook.unmount();
  });

  it('does not offer a draft created by an edit after the one-time recovery check began', async () => {
    const harness = setup(async () => 2);
    const baseline = makeTimelineData('baseline-before-edit');
    act(() => {
      harness.hook.result.current.commitData(baseline, { save: false });
    });
    await flush();
    expect(harness.hook.result.current.recoveryDraft).toBeNull();

    const edited = makeTimelineData('current-session-edit');
    act(() => {
      harness.hook.result.current.commitData(edited);
    });
    await flush();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await loadTimelineDraft('timeline-1')).not.toBeNull();
    expect(harness.hook.result.current.recoveryDraft).toBeNull();
    harness.hook.unmount();
  });

  it('uses the draft baseVersion for CAS and clears only after a successful ACK', async () => {
    const harness = setup(async () => 8);
    const recovered = makeTimelineData('recovered');
    await saveTimelineDraft('timeline-1', { config: recovered.config, registry: recovered.registry }, 7);
    act(() => {
      harness.hook.result.current.commitData(makeTimelineData('server'), { save: false });
    });
    await flush();

    await act(async () => {
      await harness.hook.result.current.retryRecoveredDraft();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await flush();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.saveTimeline.mock.calls[0]?.[0]).toBe('timeline-1');
    expect(harness.saveTimeline.mock.calls[0]?.[1].output.file).toBe('output-recovered.mp4');
    expect(harness.saveTimeline.mock.calls[0]?.[2]).toBe(7);
    expect(await loadTimelineDraft('timeline-1')).toBeNull();
    harness.hook.unmount();
  });

  it('does not retry a recovered draft while whole-timeline editing is denied', async () => {
    const harness = setup(async () => 8, {
      checkTimeline: () => ({ allowed: false, reason: 'timeline_read_only' }),
    });
    const recovered = makeTimelineData('blocked-recovery');
    await saveTimelineDraft('timeline-1', { config: recovered.config, registry: recovered.registry }, 7);
    act(() => {
      harness.hook.result.current.commitData(makeTimelineData('server'), { save: false });
    });
    await flush();

    await act(async () => {
      await harness.hook.result.current.retryRecoveredDraft();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await flush();
    });

    expect(harness.saveTimeline).not.toHaveBeenCalled();
    expect(harness.hook.result.current.data?.config.output.file).toBe('output-server.mp4');
    expect(await loadTimelineDraft('timeline-1')).not.toBeNull();
    harness.hook.unmount();
  });

  it.each([
    ['409', async () => { throw new TimelineVersionConflictError(); }],
    ['transport failure', async () => { throw new Error('bridge unavailable'); }],
  ])('retains the recovered draft after a %s', async (_label, saveImpl) => {
    const harness = setup(saveImpl);
    const recovered = makeTimelineData('failed-recovery');
    await saveTimelineDraft('timeline-1', { config: recovered.config, registry: recovered.registry }, 7);
    act(() => {
      harness.hook.result.current.commitData(makeTimelineData('server'), { save: false });
    });
    await flush();

    await act(async () => {
      await harness.hook.result.current.retryRecoveredDraft();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await flush();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.saveTimeline.mock.calls[0]?.[0]).toBe('timeline-1');
    expect(harness.saveTimeline.mock.calls[0]?.[1].output.file).toBe('output-failed-recovery.mp4');
    expect(harness.saveTimeline.mock.calls[0]?.[2]).toBe(7);
    expect(await loadTimelineDraft('timeline-1')).not.toBeNull();
    harness.hook.unmount();
  });
});

describe('useTimelineSave mounted save diagnostics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFakeIndexedDB();
    vi.stubGlobal('indexedDB', createFakeIndexedDB());
    vi.stubGlobal('__timelineSaveDiagnosticsEnabled', true);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('joins delayed production history and immutable completion to the cancelled generation and committed resolver change', async () => {
    const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}),
    } });
    const fixture = runtimeFixture();
    const projectId = 'project-commit';
    const timelineId = 'timeline-1';
    const config = createDefaultTimelineConfig();
    const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' },
      { revision_id: 'r0', publication_id: 'p0' }, { projectId, timelineId }).data.canonical_document;
    document.parent_revision.payload = { config, clips: [], occurrences: [], registry: { assets: {} } };
    document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
    let releaseHistory!: () => void;
    let releaseParent!: () => void;
    const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
    const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
    let histories = 0;
    let parents = 0;
    const records: Array<Record<string, unknown>> = [];
    const listener = (event: Event) => records.push((event as CustomEvent).detail);
    window.addEventListener('timeline:save-diagnostic', listener);
    const provider = new RuntimeDataProvider({ projectId, transport: async (...args) => {
      const [, path] = args;
      if (path.includes('/commits?')) {
        if (++histories === 1) await historyGate;
        return { status: 200, headers: {}, body: json({ items: [], next_cursor: null, head: { revision_id: 'r0', publication_id: 'p0' } }) };
      }
      if (path.includes('/composition-revisions/')) {
        if (++parents === 1) await parentGate;
        return { status: 200, headers: {}, body: json({ ...document.parent_revision,
          project_id: projectId, timeline_id: timelineId, dependency_manifest: document.dependency_manifest }) };
      }
      return fixture.transport(...args);
    } });
    const data = await buildTimelineData(config, { assets: {} }, undefined, 1, undefined,
      { projectId, timelineId, headRevisionId: 'r0', headPublicationId: 'p0' });
    let abortRender = false;
    const pendingRender = new Promise<void>(() => {});
    const harness = setup(async () => { throw new Error('No snapshot save'); }, undefined,
      { data, provider, loadBasis: provider.loadTimelineCommandBasis.bind(provider), suspend: () => abortRender ? pendingRender : undefined });
    try {
      await vi.waitFor(() => expect(histories).toBe(1));
      const first = records.find(record => record.phase === 'basis-read')!;
      const beforeAbortedRender = records.length;
      abortRender = true;
      act(() => harness.rerenderRuntime({ assetResolver: { resolveAssetUrl: async file => file } }));
      expect(records).toHaveLength(beforeAbortedRender);
      expect(histories).toBe(1);
      abortRender = false;
      act(() => harness.rerenderRuntime({ assetResolver: { resolveAssetUrl: async file => file } }));
      await vi.waitFor(() => expect(histories).toBe(1));
      const basisReads = records.filter(record => record.phase === 'basis-read');
      expect(basisReads).toHaveLength(1);
      const changes = records.filter(record => record.phase === 'basis-dependencies-committed');
      expect(changes[0]).toMatchObject({ dependencyBaselinePresent: false, resolverChanged: 'UNKNOWN' });
      expect(changes[1]).toMatchObject({ dependencyBaselinePresent: true, resolverChanged: true,
        providerChanged: false, timelineChanged: false, headChanged: false, dataRefChanged: false,
        editSeqRefChanged: false, adoptionChanged: false, ownerChanged: false, localSaveChanged: false });
      expect(records.find(record => record.phase === 'lifecycle-cancel')).toMatchObject({ generation: first.generation, basisReadOrdinal: first.basisReadOrdinal });
      await act(async () => { releaseHistory(); });
      await vi.waitFor(() => expect(parents).toBe(1));
      await vi.waitFor(() => expect(records.some(record => record.operation === 'parent' && record.basisReadOrdinal === first.basisReadOrdinal)).toBe(true));
      await act(async () => { releaseParent(); });
      await vi.waitFor(() => expect(harness.hook.result.current.originalLocalSaveBasis?.status).toBe('ready'));
      await vi.waitFor(() => expect(harness.hook.result.current.localSaveState).toMatchObject({ ownerId: expect.any(String) }));
      const handoff = records.find(record => record.phase === 'handoff-ready')!;
      expect(handoff.ownerAlias).toBe(first.ownerAlias);
      expect(handoff.generation).not.toBe(first.generation);
      const phases = records.filter(record => record.phase === 'basis-operation' && record.basisReadOrdinal === first.basisReadOrdinal);
      expect(phases.map(record => `${record.operation}:${record.operationState}`)).toEqual([
        'loader:start', 'history:start', 'history:end', 'parent:start', 'parent:end', 'loader:end',
      ]);
      expect(phases.every(record => record.ownerAlias === first.ownerAlias && record.generation === first.generation)).toBe(true);
      expect(records.find(record => record.operation === 'loader' && record.operationState === 'end' && record.basisReadOrdinal === first.basisReadOrdinal)).toMatchObject({ current: false });
      expect(histories).toBe(1);
      // The hook coalesces the same-head pending basis read; the provider also
      // coalesces its immutable parent read within that one operation.
      expect(parents).toBe(1);
      expect(harness.saveTimeline).not.toHaveBeenCalled();
    } finally {
      releaseHistory(); releaseParent(); harness.hook.unmount();
      window.removeEventListener('timeline:save-diagnostic', listener);
      if (locksDescriptor) Object.defineProperty(navigator, 'locks', locksDescriptor);
      else Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it.each(['resolved', 'rejected'] as const)('observes real mounted capture %s and preserves basis/adoption order', async (outcome) => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}),
    } });
    const records: Array<{ phase: string; sequence: number; ownerAlias: number; [key: string]: unknown }> = [];
    const listener = (event: Event) => records.push((event as CustomEvent).detail);
    window.addEventListener('timeline:save-diagnostic', listener);
    const head = { projectId: 'project-commit', timelineId: 'timeline-1', headRevisionId: 'r0', headPublicationId: 'p0' };
    const config = createDefaultTimelineConfig();
    config.clips = [{ id: 'diagnostic-clip', at: 0, track: 'V1', clipType: 'media', asset: 'diagnostic-video',
      from: 0, to: 8, hold: 8, speed: 1, app: { astrid: { for: 8 } } }];
    const registry = { assets: { 'diagnostic-video': { file: 'diagnostic.mp4', type: 'video/mp4', duration: 8 } } };
    const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' },
      { timelineId: 'timeline-1' }).data.canonical_document;
    document.parent_revision.payload = { config, clips: config.clips, registry, occurrences: [] };
    document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
    const data = await buildTimelineData(config, registry, undefined, 1, undefined, head);
    const initial = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
    const send = vi.fn<NonNullable<DataProvider['commitTimeline']>>();
    let completeRead!: (value: typeof initial) => void;
    const loadBasis = outcome === 'rejected'
      ? vi.fn(() => new Promise<typeof initial>((resolve) => { completeRead = resolve; }))
      : vi.fn(async () => initial);
    const harness = setup(async () => { throw new Error('Legacy save must not be called'); }, undefined, {
      data, loadBasis, capabilities: { commitTimeline: send,
        getRecoverableIdentity: vi.fn(async () => ({ actorId: 'private-actor', realmId: 'private-realm' })) },
    });
    const editing = renderHook(() => useClipEditing({
      dataRef: harness.hook.result.current.dataRef,
      resolvedConfig: harness.hook.result.current.dataRef.current?.resolvedConfig ?? null,
      selectedClipId: 'diagnostic-clip', selectedTrack: null, currentTime: 0,
      selectClip: vi.fn(), setSelectedTrackId: vi.fn(), applyEdit: harness.hook.result.current.applyEdit,
    }));
    try {
      if (outcome === 'resolved') await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.ownerId).toBeTruthy());
      await settleInitialRecoveryCheck();
      const capture = vi.spyOn(harness.hook.result.current.localDocumentSave!, 'capture');
      await act(async () => { editing.result.current.handleSelectedClipChange({ from: 3 }); });
      const edited = harness.hook.result.current.dataRef.current!;
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.calls[0][1]).toMatchObject({ kind: 'trim', clipId: 'diagnostic-clip', patch: { from: 3 } });
      expect(edited.config.clips[0].app).toEqual({ astrid: { for: 8 } });
      const captured = capture.mock.results[0].value as Promise<void>;
      if (outcome === 'rejected') {
        await act(async () => { completeRead(initial); });
        await expect(captured).rejects.toThrow('Local edits preceded the original verified read');
        expect(send).not.toHaveBeenCalled();
        expect(records.find((record) => record.phase === 'capture-rejected')).toMatchObject({
          errorCode: 'owner-original-read-invalidated', errorClass: 'TimelineSaveError', errorStage: 'capture' });
        expect(harness.hook.result.current.originalLocalSaveBasis?.status).toBe('unavailable');
      } else {
        await act(async () => { await captured; });
        const response = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' },
          { timelineId: 'timeline-1' });
        response.data.canonical_document = structuredClone(document);
        response.data.canonical_document.parent_revision.revision_id = 'r1';
        response.data.canonical_document.parent_revision.payload.config = JSON.parse(JSON.stringify(edited.config));
        response.data.canonical_document.parent_revision.payload.clips = JSON.parse(JSON.stringify(edited.config.clips));
        response.data.canonical_document.parent_revision.content_digest = fixtureDigest(response.data.canonical_document.parent_revision.payload);
        send.mockResolvedValue({ response, accepted: { revisionId: 'r1', publicationId: 'p1' },
          canonicalDocument: response.data.canonical_document, graph: {}, receipt: response.receipt });
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.status).toBe('saved'));
        expect(send).toHaveBeenCalledTimes(1);
        expect(harness.hook.result.current.dataRef.current?.head?.headRevisionId).toBe('r1');
        const phases = records.map((record) => record.phase);
        expect(phases.indexOf('basis-read')).toBeLessThan(phases.indexOf('basis-ready'));
        expect(phases.indexOf('basis-ready')).toBeLessThan(phases.indexOf('handoff-ready'));
        expect(phases.indexOf('capture-resolved')).toBeLessThan(phases.indexOf('adoption-start'));
        expect(phases.indexOf('adoption-start')).toBeLessThan(phases.indexOf('adoption-complete'));
        expect(phases.indexOf('adoption-complete')).toBeLessThan(phases.indexOf('adopted-read'));
        expect(records.find((record) => record.phase === 'basis-ready')).toMatchObject({
          originalHead: { revisionId: 'r0', publicationId: 'p0' } });
      }
      const start = records.find((record) => record.phase === 'capture-called')!;
      const finish = records.find((record) => record.phase === `capture-${outcome}`)!;
      expect(start.sequence).toBeLessThan(finish.sequence);
      expect(start.ownerAlias).toBe(finish.ownerAlias);
      expect(records.find((record) => record.phase === 'schedule')).toMatchObject({ ownerAlias: start.ownerAlias,
        generation: start.generation, closed: start.closed, sessionPresent: start.sessionPresent });
      expect(records.find((record) => record.phase === 'schedule')).toMatchObject({
        clipId: 'diagnostic-clip', patch: { from: 3 }, mountedHead: { revisionId: 'r0', publicationId: 'p0' },
        mountedClip: { from: 3, hold: 8 }, gestureClip: { from: 0, hold: 8 } });
      expect(JSON.stringify(records)).not.toMatch(/private-actor|private-realm|ownerId|output\.mp4/);
      expect(harness.saveTimeline).not.toHaveBeenCalled();
    } finally {
      editing.unmount();
      harness.hook.unmount();
      expect(records.some((record) => record.phase === 'owner-closed')).toBe(true);
      window.removeEventListener('timeline:save-diagnostic', listener);
      if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
      else Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it.each(['head', 'gesture', 'closed owner'] as const)('preserves real mounted %s capture refusals with diagnostics enabled, disabled or failing', async (kind) => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}),
    } });
    const messages: string[] = [];
    try {
      for (const enabled of [false, true, 'dispatch failure'] as const) {
        resetFakeIndexedDB();
        vi.stubGlobal('indexedDB', createFakeIndexedDB());
        vi.stubGlobal('__timelineSaveDiagnosticsEnabled', enabled !== false);
        const data = makeTimelineData('guard');
        data.head = { projectId: 'project-commit', timelineId: 'timeline-1', headRevisionId: 'r0', headPublicationId: 'p0' };
        const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' },
          { timelineId: 'timeline-1' }).data.canonical_document;
        document.parent_revision.payload = { config: data.config, clips: data.config.clips, registry: data.registry, occurrences: [] };
        document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
        const send = vi.fn<NonNullable<DataProvider['commitTimeline']>>();
        const harness = setup(async () => { throw new Error('Legacy save must not be called'); }, undefined, {
          data, loadBasis: vi.fn(async () => ({ head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document })),
          capabilities: { commitTimeline: send, getRecoverableIdentity: vi.fn(async () => ({ actorId: 'private', realmId: 'private' })) },
        });
        try {
          await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.ownerId).toBeTruthy());
          const save = harness.hook.result.current.localDocumentSave!;
          const next = structuredClone({ config: data.config, registry: data.registry, head: data.head });
          const gesture = structuredClone({ kind: 'trim' as const, clipId: 'clip-guard', patch: { hold: 3 },
            config: data.config, registry: data.registry });
          if (kind === 'head') next.head.headRevisionId = 'other';
          if (kind === 'gesture') gesture.config.clips[0].at = 9;
          if (kind === 'closed owner') harness.hook.unmount();
          const mark = vi.spyOn(timelineDiagnostics, 'markTimelineSaveRejection');
          const dispatch = vi.spyOn(window, 'dispatchEvent').mockImplementation(() => {
            if (enabled === 'dispatch failure') throw new Error('diagnostic failure');
            return true;
          });
          const error = await save.capture(next, gesture).catch((caught: unknown) => caught);
          expect(error).toBeInstanceOf(kind === 'head' ? TimelineVersionConflictError : TimelineSaveError);
          expect(mark.mock.calls.some(([original]) => original === error)).toBe(true);
          const code = kind === 'head' ? 'capture-input-head-unavailable' : kind === 'gesture' ? 'gesture-basis-mismatch' : 'capture-owner-unavailable';
          if (enabled) {
            const events = dispatch.mock.calls.map(([event]) => (event as CustomEvent).detail);
            expect(events.find((event) => event.phase === 'capture-rejected')).toMatchObject({
              errorCode: code, errorClass: kind === 'head' ? 'TimelineVersionConflictError' : 'TimelineSaveError', errorStage: 'capture' });
          } else expect(dispatch).not.toHaveBeenCalled();
          dispatch.mockRestore();
          mark.mockRestore();
          messages.push((error as Error).message);
          expect(send).not.toHaveBeenCalled();
          expect(harness.saveTimeline).not.toHaveBeenCalled();
          expect(harness.hook.result.current.localSaveState?.status).toBe('saved');
          expect(harness.hook.result.current.dataRef.current?.head).toEqual(data.head);
        } finally { harness.hook.unmount(); }
      }
      expect(messages[1]).toBe(messages[0]);
      expect(messages[2]).toBe(messages[0]);
    } finally {
      vi.restoreAllMocks();
      if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
      else Reflect.deleteProperty(navigator, 'locks');
    }
  });
});


it.each(['valid', 'wrong source', 'stale head'] as const)('forwards parameter gestures through its own element route: %s', async control => {
  const data = makeTimelineData('params');
  data.head = { projectId: 'project-commit', timelineId: 'timeline-1', headRevisionId: 'r0', headPublicationId: 'p0' };
  const context = buildAstridAgentElementContext({ astridEffects: ASTRID_EFFECT_CATALOG });
  const entry = context.catalog.find(item => item.id === 'text-card' && item.packId === 'rendering')!;
  const elementRef = { id: entry.id, kind: entry.kind, packId: entry.packId, revision: entry.revision };
  data.config.clips[0] = { ...data.config.clips[0], elementRef, params: { value: 2 } };
  data.resolvedConfig.clips[0] = { ...data.resolvedConfig.clips[0], elementRef, params: { value: 2 } };
  const harness = setup(async () => 1, undefined, { data, loadBasis: vi.fn() });
  try {
    const current = harness.hook.result.current.dataRef.current!;
    const routes = harness.hook.result.current.elementTimelineRoutes;
    const adapter = new AstridElementOperationAdapter(context, routes, 'project-commit', {
      timelineId: 'timeline-1', assertAuthority: () => {}, getHead: () => current.head,
    });
    bindElementParameterOwner(routes, context, adapter);
    const original = { config: current.config, registry: current.registry, config_version: current.configVersion, head: current.head };
    if (control === 'wrong source') vi.spyOn(routes, 'get').mockResolvedValue({ ...original, config: { ...current.config, clips: [] } });
    if (control === 'stale head') vi.spyOn(routes, 'get').mockResolvedValue({ ...original, head: { ...current.head!, headPublicationId: 'another' } });
    const saved = vi.spyOn(routes, 'save').mockResolvedValue(original);
    const params = { value: 3 };
    act(() => harness.hook.result.current.applyEdit({ type: 'config', resolvedConfig: { ...current.resolvedConfig,
      clips: current.resolvedConfig.clips.map(clip => ({ ...clip, params })) } }, { gestureBasis: {
      kind: 'element', clipId: 'clip-params', config: current.config, registry: current.registry, context,
      operation: { name: 'timeline.update_element', project: 'project-commit', timeline: 'timeline-1', expected_version: current.configVersion, clip_id: 'clip-params', params },
    } }));
    if (control === 'valid') {
      await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
      expect(saved.mock.calls[0]).toEqual(['timeline-1', expect.objectContaining({ original,
        expectedHead: current.head, expectedVersion: current.configVersion,
        config: { ...current.config, clips: [{ ...current.config.clips[0], params }] },
      })]);
    } else {
      await vi.waitFor(() => expect(harness.toast.error).toHaveBeenCalledWith('Element parameter owner changed; draft retained'));
      expect(harness.toast.error).toHaveBeenCalledTimes(1);
      expect(saved).not.toHaveBeenCalled();
    }
    expect(harness.saveTimeline).not.toHaveBeenCalled();
  } finally { harness.hook.unmount(); }
});

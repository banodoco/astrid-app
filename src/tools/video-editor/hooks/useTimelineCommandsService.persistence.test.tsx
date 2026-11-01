// @vitest-environment jsdom
import React, { useLayoutEffect, useMemo } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import { RUNTIME_SCHEMA_DIGEST } from '@/integrations/runtime/contract-metadata.ts';
import { RuntimeDataProvider } from '@/integrations/runtime/dataProvider.ts';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { Transport } from '@/integrations/runtime/generated.ts';
import type { CommitRequest, MediaSelection } from '@/integrations/runtime/timeline-commit-types.ts';
import type { DataProvider, TimelineCommandBasis, TimelineCommitResult } from '../data/DataProvider.ts';
import { VideoEditorRuntimeProvider, type VideoEditorRuntimeContextValue } from '../contexts/VideoEditorRuntimeContext.tsx';
import { createDefaultTimelineConfig } from '../lib/defaults.ts';
import { createInteractionState } from '../lib/interaction-state.ts';
import { buildTimelineData } from '../lib/timeline-data.ts';
import { applyPreparedMediaCommand, type PlacePreparedMediaCommand } from '../commands/media.ts';
import { createCommitOutbox } from '../commands/commitOutbox.ts';
import type { AssetRegistry, TimelineConfig } from '../types/index.ts';
import { TimelineStoreProvider, createTimelineStore } from './timelineStore.ts';
import { useTimelineCommandsService } from './useTimelineCommandsService.ts';
import { useTimelineSave } from './useTimelineSave.ts';

vi.stubGlobal('indexedDB', createFakeIndexedDB());
vi.mock('@/tools/video-editor/compositions/TimelineRenderer.tsx', () => ({ invalidateReferencedTimelineCache: vi.fn() }));
vi.mock('@/integrations/runtime/generated-contract-metadata.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/integrations/runtime/generated-contract-metadata.ts')>(),
  SCHEMA_DIGEST: 'sha256:35c2d9c5e0b51ab8d8b7a4f4dbafbdfcb13d232d7bd22fff21cf73e250398d4c',
}));

const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-1' };
const head = { revisionId: 'r0', publicationId: 'p0' };
const runtimeHead = { projectId: scope.projectId, timelineId: scope.timelineId,
  headRevisionId: head.revisionId, headPublicationId: head.publicationId };

function preparedMediaSelection(asset: string, generationId: string, variantId: string): MediaSelection {
  const sourceMedia = asset === 'asset-source';
  return {
    asset, generation_id: generationId, variant_id: variantId,
    object_id: `sha256:${(sourceMedia ? 'a' : 'c').repeat(64)}`,
    catalog_digest: `sha256:${(sourceMedia ? 'b' : 'd').repeat(64)}`,
  };
}

const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
beforeEach(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}),
  } });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (locksDescriptor) Object.defineProperty(navigator, 'locks', locksDescriptor);
  else Reflect.deleteProperty(navigator, 'locks');
});

function authoredConfig(): TimelineConfig {
  return {
    ...createDefaultTimelineConfig(),
    tracks: [
      { id: 'V1', kind: 'visual', label: 'V1' },
      { id: 'V2', kind: 'visual', label: 'V2' },
    ],
    clips: [
      {
        id: 'anchor', at: 1, track: 'V1', clipType: 'media', asset: 'asset-source',
        from: 2, to: 6, speed: 2, opacity: 0.5,
        effects: { glow: 1 },
        transition: { type: 'crossfade', duration: 0.5, params: { opaque: [null, false] } },
        params: { opaque: { ordered: [null, false, 0] } },
        app: { opaque: { keep: null, ordered: [false, 0, ''] } },
      },
      { id: 'later', at: 5, track: 'V1', clipType: 'hold', hold: 1, asset: 'asset-peer' },
      { id: 'sibling', at: 5, track: 'V2', clipType: 'hold', hold: 1, asset: 'asset-peer' },
    ],
  };
}

function authoredDocument(config: TimelineConfig) {
  const payload = {
    config: structuredClone(config),
    clips: structuredClone(config.clips),
    registry: {
      assets: {
        'asset-source': { file: 'source.mp4', type: 'video/mp4', media_id: 'media-source' },
        'asset-peer': { file: 'peer.png', type: 'image/png' },
      },
    },
    occurrences: [],
    opaque: { keep: null },
  };
  const document = acceptedCommit({ revision_id: head.revisionId, publication_id: head.publicationId },
    { revision_id: head.revisionId, publication_id: head.publicationId }, { projectId: scope.projectId, timelineId: scope.timelineId })
    .data.canonical_document;
  document.parent_revision.payload = payload;
  document.parent_revision.content_digest = fixtureDigest(payload);
  return document;
}

function adoptedDocument(document: ReturnType<typeof authoredDocument>, data: Awaited<ReturnType<typeof buildTimelineData>>, revision: string) {
  const next = structuredClone(document);
  const payload = next.parent_revision.payload as Record<string, unknown>;
  payload.config = structuredClone(data.config);
  payload.clips = structuredClone(data.config.clips);
  payload.registry = structuredClone(data.registry);
  next.parent_revision.revision_id = revision;
  next.parent_revision.content_digest = fixtureDigest(payload);
  return next;
}

function acceptedReply(request: CommitRequest, document: ReturnType<typeof authoredDocument>, revision: string, key: string): TimelineCommitResult {
  const response = acceptedCommit({ revision_id: revision, publication_id: `p-${revision}` },
    { revision_id: request.base_revision_id, publication_id: request.base_publication_id }, {
      projectId: scope.projectId, timelineId: scope.timelineId, commands: request.commands,
    });
  response.data.canonical_document = document;
  response.data.document_digest = fixtureDigest(document);
  Object.assign(response.data, {
    status: 'accepted',
    merge_mode: request.merge,
    steps: request.steps,
    label: request.label,
    source: request.source,
  });
  response.receipt.idempotency_key = key;
  response.receipt.result = response.data;
  return {
    response,
    accepted: { revisionId: revision, publicationId: `p-${revision}` },
    canonicalDocument: document,
    graph: {},
    receipt: response.receipt,
  };
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function runtimeDiscoveryTransport(
  transportCalls: Array<{ method: string; path: string; headers: Record<string, string>; rawBody?: string; body?: unknown }>,
  commit: (request: CommitRequest, key: string, path: string) => { status: number; headers: Record<string, string>; body: Uint8Array },
): Transport {
  return async (method, path, headers, body) => {
    const rawBody = body ? new TextDecoder().decode(body as Uint8Array) : undefined;
    transportCalls.push({ method, path, headers, ...(rawBody === undefined ? {} : { rawBody, body: JSON.parse(rawBody) }) });
    if (path === '/v1/health') {
      return { status: 200, headers: {}, body: json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST,
        runtime_epoch: 1, runtime_session_id: 'session-commit', runtime_instance_id: 'instance-commit' }) };
    }
    if (path === '/v1/handshake') {
      return { status: 200, headers: {}, body: json({ protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST,
        session_id: 'session-commit', actor_id: scope.actorId, realm_id: scope.realmId,
        scopes: ['handshake', 'projects:read', 'projects:write', 'objects:read', 'objects:write', 'tasks:read', 'tasks:write'],
        capabilities: ['execution_binding.targeted.v1'] }) };
    }
    if (path === '/v1/realm') {
      return { status: 200, headers: {}, body: json({ realm_id: scope.realmId, display_name: 'commit fixture', version: 1,
        created_at: '2026-10-23T00:00:00Z' }) };
    }
    if (method === 'POST' && path === `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`) {
      return commit(JSON.parse(rawBody!) as CommitRequest, headers['Idempotency-Key']!, path);
    }
    throw new Error(`Unexpected Runtime request: ${method} ${path}`);
  };
}

function useMountedCommands(
  store: ReturnType<typeof createTimelineStore>,
  provider: DataProvider,
  initialData: Awaited<ReturnType<typeof buildTimelineData>>,
) {
  const interactionStateRef = useMemo(() => ({ current: createInteractionState() }), []);
  const save = useTimelineSave(
    { timelineQuery: { data: undefined, isLoading: false }, assetRegistryQuery: { data: undefined } },
    provider,
    interactionStateRef,
    store,
    initialData,
  );
  const data = useMemo(() => ({ ...store.getState().data, data: save.data, dataRef: save.dataRef,
    selectedClipId: save.selectedClipId, selectedTrackId: save.selectedTrackId }),
  [save.data, save.dataRef, save.selectedClipId, save.selectedTrackId, store]);
  const ops = useMemo(() => ({ ...store.getState().ops, applyEdit: save.applyEdit,
    patchRegistry: save.patchRegistry, unpatchRegistry: save.unpatchRegistry }),
  [save.applyEdit, save.patchRegistry, save.unpatchRegistry, store]);
  useLayoutEffect(() => { store.getState().syncSlices({ data, ops }); }, [data, ops, store]);
  return { save, commands: useTimelineCommandsService() };
}

function wrapperFor(store: ReturnType<typeof createTimelineStore>, provider: DataProvider) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const runtime = { provider, timelineId: scope.timelineId, shots: { canonicalDraft: null },
    assetResolver: { resolveAssetUrl: async (file: string) => file } } as unknown as VideoEditorRuntimeContextValue;
  return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queryClient}>
    <VideoEditorRuntimeProvider value={runtime}>
      <TimelineStoreProvider store={store}>{children}</TimelineStoreProvider>
    </VideoEditorRuntimeProvider>
  </QueryClientProvider>;
}

describe('mounted prepared-media command persistence', () => {
  beforeEach(async () => {
    const { clearTimelineDraft } = await import('../data/timelineDraftIndexedDb.ts');
    await clearTimelineDraft(scope.timelineId);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('astrid.command-outbox');
      request.addEventListener('success', () => resolve());
      request.addEventListener('error', () => reject(request.error));
      request.addEventListener('blocked', () => reject(new Error('Outbox database remained open during test isolation')));
    });
  });

  it('retains the prepared-media refusal diagnostic on the mounted command result', async () => {
    const current = await buildTimelineData(authoredConfig(), {
      assets: {
        'asset-source': { file: 'source.mp4', type: 'video/mp4' },
        'asset-peer': { file: 'peer.png', type: 'image/png' },
      },
    });
    const baseStore = createTimelineStore();
    const applyEdit = vi.fn();
    const store = createTimelineStore({
      data: {
        ...baseStore.getState().data,
        data: current,
        resolvedConfig: current.resolvedConfig,
        selectedTrackId: 'V1',
        dataRef: { current },
      },
      ops: {
        ...baseStore.getState().ops,
        applyEdit,
      },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <TimelineStoreProvider store={store}>{children}</TimelineStoreProvider>
    );
    const mounted = renderHook(() => useTimelineCommandsService(), { wrapper });

    const response = mounted.result.current.addClip({
      preparedAsset: {
        assetKey: 'asset-new', mediaType: 'image', durationSeconds: 2,
        entry: { file: 'new.png', type: 'image/png' }, source: 'registered',
      },
      time: 0,
      replaceClipId: 'missing-clip',
    });

    expect(response).toEqual({
      ok: false,
      error: {
        code: 'mutation_failed',
        message: 'Failed to place the prepared asset on the timeline.',
        diagnostic: { stage: 'placement', reason: 'invalid-placement', fieldCategory: 'placement' },
      },
    });
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it('preserves an occupied captured V2 through the mounted command service and A2 outbox', async () => {
    const config = authoredConfig();
    const document = authoredDocument(config);
    const initial: TimelineCommandBasis = { head, canonicalDocument: document };
    const initialData = await buildTimelineData(config, document.parent_revision.payload.registry as unknown as AssetRegistry,
      async (file) => file, 1, undefined, runtimeHead);
    const preparedAsset = {
      assetKey: 'asset-occupied-v2', mediaType: 'image' as const, durationSeconds: 5,
      entry: { file: 'occupied-v2.png', type: 'image/png', media_id: 'media-occupied-v2', generationId: 'generation-occupied-v2' },
      source: 'registered' as const,
      mediaSelection: preparedMediaSelection('asset-occupied-v2', 'generation-occupied-v2', 'variant-occupied-v2'),
    };
    const preparedCommand: PlacePreparedMediaCommand = {
      type: 'place-prepared-media',
      payload: {
        asset: preparedAsset, trackId: 'V2', selectedTrackId: 'V2', at: 0,
        placementPolicy: { kind: 'occurrence-raw-track', trackId: 'V2' },
      },
    };
    const preparedPreview = applyPreparedMediaCommand(initialData, preparedCommand);
    expect(preparedPreview).not.toBeNull();
    expect(preparedPreview?.nextData.config.clips).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'clip-0', asset: preparedAsset.assetKey, track: 'V2', at: 0, hold: 5 }),
    ]));
    let latest = initial;
    const transportCalls: Array<{ method: string; path: string; headers: Record<string, string>; rawBody?: string; body?: unknown }> = [];
    const transport = runtimeDiscoveryTransport(transportCalls, (request, key, path) => {
      const accepted = acceptedReply(request, adoptedDocument(document, preparedPreview!.nextData, 'r-occupied-v2'), 'r-occupied-v2', key);
      accepted.receipt.request_hash = fixtureDigest({ operation: 'commitTimeline', path,
        publisher: accepted.response.data.publisher, request }).slice(7);
      accepted.receipt.result = accepted.response.data;
      latest = { head: accepted.accepted, canonicalDocument: accepted.canonicalDocument };
      return { status: 200, headers: {}, body: json(accepted.response) };
    });
    const runtimeClient = new AstridRuntimeClient({ baseUrl: 'http://runtime.test', token: 'runtime-token', transport });
    const provider = new RuntimeDataProvider({ projectId: scope.projectId, runtimeClient });
    vi.spyOn(provider, 'loadTimelineCommandBasis').mockImplementation(async () => structuredClone(latest));
    const actualCommit = provider.commitTimeline.bind(provider);
    const send = vi.fn<NonNullable<DataProvider['commitTimeline']>>().mockImplementation(
      (request, key) => actualCommit(request, key),
    );
    provider.commitTimeline = send;
    const store = createTimelineStore();
    const mounted = renderHook(() => useMountedCommands(store, provider, initialData), { wrapper: wrapperFor(store, provider) });
    try {
      await waitFor(() => expect(mounted.result.current.save.localSaveState).toMatchObject({ status: 'saved', ownerId: expect.any(String) }));
      let result: ReturnType<typeof mounted.result.current.commands.addClip>;
      act(() => {
        result = mounted.result.current.commands.addClip({
          preparedAsset, trackId: 'V2', time: 0,
          placementPolicy: { kind: 'occurrence-raw-track', trackId: 'V2' },
        });
      });
      expect(result!).toEqual({ ok: true, data: { clipId: 'clip-0', trackId: 'V2' } });
      expect(mounted.result.current.save.dataRef.current?.config.clips).toEqual(preparedPreview!.nextData.config.clips);
      expect(mounted.result.current.save.dataRef.current?.config.clips.find((clip) => clip.id === 'clip-0'))
        .toMatchObject({ asset: preparedAsset.assetKey, track: 'V2', at: 0, hold: 5 });

      await act(async () => { await mounted.result.current.save.flushPendingSave(); });
      expect(send).toHaveBeenCalledOnce();
      const [request] = send.mock.calls[0]!;
      expect(request).toMatchObject({
        api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
        base_revision_id: 'r0', base_publication_id: 'p0', label: 'Add media', merge: 'fields', dry_run: false,
        source: { via: 'app' },
        commands: [{ schema_version: 1, op: 'clip.add-media', version: '1', select: 'parent',
          args: { row: expect.objectContaining({ id: 'clip-0', asset: preparedAsset.assetKey, track: 'V2', at: 0, hold: 5 }),
            media: preparedAsset.mediaSelection }, intent: {}, created: ['parent/asset:asset-occupied-v2', 'parent/clip:clip-0'] }],
      });
      expect(request.commands?.[0]?.args.row).not.toMatchObject({ track: 'V3' });
      expect(transportCalls.filter((call) => call.path.endsWith('/commit'))).toHaveLength(1);
    } finally {
      mounted.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it('adopts an after-anchor prepared duplicate through the real v2 outbox request', async () => {
    const config = authoredConfig();
    const document = authoredDocument(config);
    const initial: TimelineCommandBasis = { head, canonicalDocument: document };
    const initialData = await buildTimelineData(config, document.parent_revision.payload.registry as unknown as AssetRegistry,
      async (file) => file, 1, undefined, runtimeHead);
    const preparedData = applyPreparedMediaCommand(initialData, {
      type: 'place-prepared-media',
      payload: {
        asset: { assetKey: 'asset-copy', mediaType: 'video', durationSeconds: 2,
          entry: { file: 'copy.mp4', type: 'video/mp4', media_id: 'media-copy', generationId: 'generation-copy' },
          source: 'registered', mediaSelection: preparedMediaSelection('asset-copy', 'generation-copy', 'variant-copy') },
        selectedTrackId: null, at: 0, afterClipId: 'anchor', forceNewTrack: false, insertAtTop: false,
      },
    } satisfies PlacePreparedMediaCommand);
    expect(preparedData).not.toBeNull();
    let latest = initial;
    const transportCalls: Array<{ method: string; path: string; headers: Record<string, string>; rawBody?: string; body?: unknown }> = [];
    const transport = runtimeDiscoveryTransport(transportCalls, (request, key, path) => {
      const accepted = acceptedReply(request, adoptedDocument(document, preparedData!.nextData, 'r1'), 'r1', key);
      accepted.receipt.request_hash = fixtureDigest({ operation: 'commitTimeline', path,
        publisher: accepted.response.data.publisher, request }).slice(7);
      accepted.receipt.result = accepted.response.data;
      latest = { head: accepted.accepted, canonicalDocument: accepted.canonicalDocument };
      return { status: 200, headers: {}, body: json(accepted.response) };
    });
    const runtimeClient = new AstridRuntimeClient({ baseUrl: 'http://runtime.test', token: 'runtime-token', transport });
    const provider = new RuntimeDataProvider({ projectId: scope.projectId, runtimeClient });
    vi.spyOn(provider, 'loadTimelineCommandBasis').mockImplementation(async () => structuredClone(latest));
    const actualCommit = provider.commitTimeline.bind(provider);
    const send = vi.fn<NonNullable<DataProvider['commitTimeline']>>().mockImplementation(
      (request, key) => actualCommit(request, key),
    );
    provider.commitTimeline = send;
    const store = createTimelineStore();
    const mounted = renderHook(() => useMountedCommands(store, provider, initialData), { wrapper: wrapperFor(store, provider) });
    try {
      await waitFor(() => expect(mounted.result.current.save.localSaveState).not.toBeNull());
      expect(mounted.result.current.save.localSaveState).toMatchObject({ status: 'saved', ownerId: expect.any(String) });
      let result: ReturnType<typeof mounted.result.current.commands.addClip>;
      act(() => {
        result = mounted.result.current.commands.addClip({
          preparedAsset: { assetKey: 'asset-copy', mediaType: 'video', durationSeconds: 2,
            entry: { file: 'copy.mp4', type: 'video/mp4', media_id: 'media-copy', generationId: 'generation-copy' },
            source: 'registered', mediaSelection: preparedMediaSelection('asset-copy', 'generation-copy', 'variant-copy') },
          oldMediaSelection: preparedMediaSelection('asset-source', 'generation-source', 'variant-source'),
          trackId: 'V1', afterClipId: 'anchor', time: 0,
        });
      });
      expect(result!).toEqual({ ok: true, data: { clipId: 'clip-0', trackId: 'V1' } });
      expect(mounted.result.current.save.dataRef.current?.config.clips).toEqual(preparedData!.nextData.config.clips);
      expect(mounted.result.current.save.dataRef.current?.config.clips.map((clip) => clip.id))
        .toEqual(['anchor', 'clip-0', 'later', 'sibling']);
      expect(mounted.result.current.save.dataRef.current?.config.clips.find((clip) => clip.id === 'clip-0'))
        .toMatchObject({ from: 2, to: 6, speed: 2, opacity: 0.5,
          transition: { type: 'crossfade', duration: 0.5, params: { opaque: [null, false] } },
          params: { opaque: { ordered: [null, false, 0] } }, app: { opaque: { keep: null, ordered: [false, 0, ''] } } });
      expect(mounted.result.current.save.dataRef.current?.config.clips.find((clip) => clip.id === 'clip-0'))
        .not.toHaveProperty('hold');
      await act(async () => { await mounted.result.current.save.flushPendingSave(); });
      expect(send).toHaveBeenCalledOnce();
      const [request, key] = send.mock.calls[0]!;
      expect(request).toMatchObject({ api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
        base_revision_id: 'r0', base_publication_id: 'p0', label: 'Add video after clip', merge: 'fields', dry_run: false,
        rationale: 'Duplicate selected parent video', group_id: expect.any(String), source: { via: 'app' },
        commands: [{ schema_version: 1, op: 'clip.duplicate-media', version: '1', select: 'parent/clip:anchor',
          args: { id: 'clip-0', old_media: preparedMediaSelection('asset-source', 'generation-source', 'variant-source'),
            media: preparedMediaSelection('asset-copy', 'generation-copy', 'variant-copy') },
          intent: { ownership: 'parent' }, created: ['parent/asset:asset-copy', 'parent/clip:clip-0'] }],
        steps: [{ id: expect.any(String), label: 'Add video after clip', intent: 'Duplicate selected parent video', tags: [],
          command_ordinals: [0], patch: [], reads: [{ kind: 'field', ref: 'parent', path: ['config', 'clips', 'id:anchor'],
            state: { state: 'present', value: config.clips.find((clip) => clip.id === 'anchor') } }] }],
      });
      expect(request.reads).toEqual([{ kind: 'collection', ref: 'parent', path: ['config', 'clips'],
        members: ['anchor', 'later', 'sibling'], order: ['anchor', 'later', 'sibling'] }]);
      expect(request.steps?.[0]?.id).toBe(request.group_id);
      const commitCalls = transportCalls.filter((call) => call.path.endsWith('/commit'));
      expect(commitCalls).toHaveLength(1);
      const [wire] = commitCalls;
      expect(wire.method).toBe('POST');
      expect(wire.path).toBe(`/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`);
      expect(wire.headers).toMatchObject({
        Accept: 'application/json', Authorization: 'Bearer runtime-token', 'Content-Type': 'application/json',
        'Idempotency-Key': key,
      });
      expect(wire.rawBody).toBe(JSON.stringify(request));
      expect(wire.body).toEqual(request);
      const accepted = await send.mock.results[0]!.value as TimelineCommitResult;
      expect(accepted.response.data).toMatchObject({
        status: 'accepted', base_revision_id: 'r0', base_publication_id: 'p0',
        previous_revision_id: 'r0', previous_publication_id: 'p0', accepted_revision_id: 'r1', rebased_onto: null,
        document_digest: fixtureDigest(accepted.canonicalDocument), commands: request.commands,
        merge_mode: 'fields', steps: request.steps, label: 'Add video after clip', source: { via: 'app' },
      });
      expect(accepted.response.data.canonical_document).toEqual(accepted.canonicalDocument);
      expect(accepted.response.data.canonical_document.parent_revision).toMatchObject({
        revision_id: 'r1', content_digest: fixtureDigest(accepted.canonicalDocument.parent_revision.payload),
      });
      expect(accepted.receipt).toMatchObject({
        receipt_id: 'p-r1', command_kind: 'timeline.commit', idempotency_key: key,
        project_id: scope.projectId, project_seq: [1, 1], event_ids: ['event-p-r1'],
        request_hash: fixtureDigest({ operation: 'commitTimeline', path: wire.path,
          publisher: accepted.response.data.publisher, request }).slice(7),
      });
      expect(accepted.receipt.result).toEqual(accepted.response.data);
      const [stored] = await createCommitOutbox().list(scope);
      expect(stored.intents).toEqual([]);
      expect(stored.accepted?.value).toMatchObject({ response: { data: { status: 'accepted', merge_mode: 'fields' } } });
      expect(key).toBe(stored.accepted?.value && stored.accepted?.value !== null ? stored.accepted?.value.response?.receipt?.idempotency_key : undefined);
      expect(mounted.result.current.save.dataRef.current?.config.clips).toEqual(preparedData!.nextData.config.clips);
      expect(mounted.result.current.save.dataRef.current?.config.clips.find((clip) => clip.id === 'later')?.at).toBe(7);
      expect(mounted.result.current.save.dataRef.current?.config.clips.find((clip) => clip.id === 'sibling')?.at).toBe(5);
    } finally {
      mounted.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it('rolls back an accepted preview when the mounted save receives a real conflict', async () => {
    const config = authoredConfig();
    const document = authoredDocument(config);
    const initial: TimelineCommandBasis = { head, canonicalDocument: document };
    const initialData = await buildTimelineData(config, document.parent_revision.payload.registry as unknown as AssetRegistry,
      async (file) => file, 1, undefined, runtimeHead);
    const latestConfig = structuredClone(config);
    latestConfig.clips = latestConfig.clips.map((clip) => clip.id === 'later' ? { ...clip, at: 6 } : clip);
    const latestDocument = adoptedDocument(document, {
      config: latestConfig,
      registry: document.parent_revision.payload.registry,
    } as Awaited<ReturnType<typeof buildTimelineData>>, 'agent-r');
    let latest = initial;
    const transportCalls: Array<{ method: string; path: string; headers: Record<string, string>; rawBody?: string; body?: unknown }> = [];
    const transport = runtimeDiscoveryTransport(transportCalls, (request) => {
      latest = { head: { revisionId: 'agent-r', publicationId: 'agent-p' }, canonicalDocument: latestDocument };
      return { status: 409, headers: {}, body: json({
        code: 'dependency_changed', message: 'The prepared after-anchor source changed', request_id: 'request-prepared',
        details: {
          status: 'conflict', reason: 'dependency_changed',
          base: { revision_id: request.base_revision_id, publication_id: request.base_publication_id },
          current: { revision_id: 'agent-r', publication_id: 'agent-p' }, conflicts: [],
          code: 'dependency_changed', path: ['parent', 'clips', 'id:anchor', 'at'],
          hint: 'Reload the timeline and retry the prepared placement.', suggested_command: 'show timeline',
        },
      }) };
    });
    const runtimeClient = new AstridRuntimeClient({ baseUrl: 'http://runtime.test', token: 'runtime-token', transport });
    const provider = new RuntimeDataProvider({ projectId: scope.projectId, runtimeClient });
    vi.spyOn(provider, 'loadTimelineCommandBasis').mockImplementation(async () => structuredClone(latest));
    const actualCommit = provider.commitTimeline.bind(provider);
    const send = vi.fn<NonNullable<DataProvider['commitTimeline']>>().mockImplementation(
      (request, key) => actualCommit(request, key),
    );
    provider.commitTimeline = send;
    const store = createTimelineStore();
    const mounted = renderHook(() => useMountedCommands(store, provider, initialData), { wrapper: wrapperFor(store, provider) });
    try {
      await waitFor(() => expect(mounted.result.current.save.localSaveState).not.toBeNull());
      expect(mounted.result.current.save.localSaveState).toMatchObject({ status: 'saved', ownerId: expect.any(String) });
      act(() => mounted.result.current.commands.addClip({
        preparedAsset: { assetKey: 'asset-copy', mediaType: 'video', durationSeconds: 2,
          entry: { file: 'copy.mp4', type: 'video/mp4', media_id: 'media-copy', generationId: 'generation-copy' },
          source: 'registered', mediaSelection: preparedMediaSelection('asset-copy', 'generation-copy', 'variant-copy') },
        oldMediaSelection: preparedMediaSelection('asset-source', 'generation-source', 'variant-source'),
        trackId: 'V1', afterClipId: 'anchor', time: 0,
      }));
      expect(mounted.result.current.save.dataRef.current?.config.clips.some((clip) => clip.id === 'clip-0')).toBe(true);
      await waitFor(() => expect(mounted.result.current.save.localSaveState?.status).toBe('dirty'));
      const ownerId = mounted.result.current.save.localSaveState!.ownerId!;
      await waitFor(async () => expect((await createCommitOutbox().list(scope)).find((record) => record.ownerId === ownerId)?.intents).toHaveLength(1));
      latest = { head: { revisionId: 'agent-r', publicationId: 'agent-p' }, canonicalDocument: latestDocument };
      await act(async () => { await expect(mounted.result.current.save.flushPendingSave()).rejects.toThrow('draft retained'); });
      await waitFor(() => expect(mounted.result.current.save.localSaveState?.status).toBe('conflict'));
      expect(mounted.result.current.save.dataRef.current?.config.clips.some((clip) => clip.id === 'clip-0')).toBe(false);
      expect(mounted.result.current.save.dataRef.current?.config.clips.find((clip) => clip.id === 'later')?.at).toBe(6);
      expect(send).toHaveBeenCalledOnce();
      const refusal = await send.mock.results[0]!.value.catch((error: unknown) => error);
      expect(refusal).toMatchObject({ status: 409, code: 'dependency_changed', details: {
        status: 'conflict', reason: 'dependency_changed',
        base: { revision_id: 'r0', publication_id: 'p0' }, current: { revision_id: 'agent-r', publication_id: 'agent-p' },
        conflicts: [], code: 'dependency_changed', path: ['parent', 'clips', 'id:anchor', 'at'],
        hint: 'Reload the timeline and retry the prepared placement.', suggested_command: 'show timeline',
      } });
      expect(refusal.details).not.toHaveProperty('head');
      const commitCalls = transportCalls.filter((call) => call.path.endsWith('/commit'));
      expect(commitCalls).toHaveLength(1);
      const [wire] = commitCalls;
      expect(wire).toMatchObject({ method: 'POST', path: `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`,
        headers: { Accept: 'application/json', Authorization: 'Bearer runtime-token', 'Content-Type': 'application/json',
          'Idempotency-Key': expect.any(String) } });
      expect(wire.body).toMatchObject({ base_revision_id: 'r0', base_publication_id: 'p0', merge: 'fields' });
      expect((await createCommitOutbox().list(scope)).find((record) => record.ownerId === ownerId)?.pending?.outcome).toMatchObject({
        kind: 'rejected', error: { kind: 'conflict', code: 'dependency_changed',
          message: 'dependency_changed: The prepared after-anchor source changed', details: {
            status: 'conflict', reason: 'dependency_changed', current: { revision_id: 'agent-r', publication_id: 'agent-p' },
          } },
      });
    } finally {
      mounted.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
});

type MountedAfterAnchorPositiveCase = {
  name: string;
  configure: (config: TimelineConfig) => void;
  expectedSource: Record<string, unknown>;
  expectedInserted: Record<string, unknown>;
  expectedLaterAt: number;
};

const mountedAfterAnchorPositiveCases: MountedAfterAnchorPositiveCase[] = [
  {
    name: 'old video with missing hold',
    configure: (config) => {
      const anchor = config.clips.find((clip) => clip.id === 'anchor')!;
      anchor.clipType = 'video';
      delete anchor.hold;
    },
    expectedSource: { clipType: 'video' },
    expectedInserted: { clipType: 'video', from: 2, to: 6, speed: 2 },
    expectedLaterAt: 7,
  },
  {
    name: 'old video with explicit null hold',
    configure: (config) => {
      const anchor = config.clips.find((clip) => clip.id === 'anchor')!;
      anchor.clipType = 'video';
      anchor.hold = null;
    },
    expectedSource: { clipType: 'video', hold: null },
    expectedInserted: { clipType: 'video', hold: null, from: 2, to: 6, speed: 2 },
    expectedLaterAt: 7,
  },
  {
    name: 'old video with subminimum duration',
    configure: (config) => {
      const anchor = config.clips.find((clip) => clip.id === 'anchor')!;
      anchor.clipType = 'video';
      // The mounted editor supplies the normalized zero-hold form. The raw
      // 0.01-to-zero legacy normalization remains covered by the dormant
      // parent-after-anchor capture test.
      anchor.hold = 0;
      delete anchor.from;
      delete anchor.to;
      delete anchor.speed;
    },
    expectedSource: { clipType: 'video', hold: 0 },
    expectedInserted: { clipType: 'video', hold: 0.0667 },
    expectedLaterAt: 5.0667,
  },
  {
    name: 'old video with incoming transition',
    configure: (config) => {
      const anchor = config.clips.find((clip) => clip.id === 'anchor')!;
      anchor.clipType = 'video';
      delete anchor.hold;
      anchor.transition = { type: 'crossfade', duration: 0.5, opaque: [false, null] };
    },
    expectedSource: {
      clipType: 'video',
      transition: { type: 'crossfade', duration: 0.5, opaque: [false, null] },
    },
    expectedInserted: {
      clipType: 'video', from: 2, to: 6, speed: 2,
      transition: { type: 'crossfade', duration: 0.5, opaque: [false, null] },
    },
    expectedLaterAt: 7,
  },
];

const mountedAfterAnchorPackets: Array<Record<string, unknown>> = [];

afterAll(async () => {
  const packetPath = process.env.A4_AFTER_POSITIVE_PACKET;
  if (!packetPath) return;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(packetPath, `${JSON.stringify({ cases: mountedAfterAnchorPackets }, null, 2)}\n`);
});

describe('mounted prepared-media after-anchor positive parity', () => {
  beforeEach(async () => {
    const { clearTimelineDraft } = await import('../data/timelineDraftIndexedDb.ts');
    await clearTimelineDraft(scope.timelineId);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('astrid.command-outbox');
      request.addEventListener('success', () => resolve());
      request.addEventListener('error', () => reject(request.error));
      request.addEventListener('blocked', () => reject(new Error('Outbox database remained open during test isolation')));
    });
  });

  it.each(mountedAfterAnchorPositiveCases)('$name emits the normalized v2 semantic command through A2', async (testCase) => {
    const config = authoredConfig();
    testCase.configure(config);
    const document = authoredDocument(config);
    const initial: TimelineCommandBasis = { head, canonicalDocument: document };
    const initialData = await buildTimelineData(config, document.parent_revision.payload.registry as unknown as AssetRegistry,
      async (file) => file, 1, undefined, runtimeHead);
    const assetSuffix = testCase.name.replaceAll(' ', '-');
    const preparedAsset = {
      assetKey: `asset-${assetSuffix}`,
      mediaType: 'video' as const,
      durationSeconds: 2,
      entry: {
        file: `${assetSuffix}.mp4`, type: 'video/mp4',
        media_id: `media-${assetSuffix}`, generationId: `generation-${assetSuffix}`,
      },
      source: 'registered' as const,
      mediaSelection: preparedMediaSelection(`asset-${assetSuffix}`, `generation-${assetSuffix}`, `variant-${assetSuffix}`),
    };
    const preparedCommand: PlacePreparedMediaCommand = {
      type: 'place-prepared-media',
      payload: {
        asset: preparedAsset, selectedTrackId: null, at: 0, afterClipId: 'anchor',
        forceNewTrack: false, insertAtTop: false,
      },
    };
    const preparedPreview = applyPreparedMediaCommand(initialData, preparedCommand);
    expect(preparedPreview).not.toBeNull();
    const expectedPreview = preparedPreview!.nextData.config.clips;
    let latest = initial;
    const transportCalls: Array<{ method: string; path: string; headers: Record<string, string>; rawBody?: string; body?: unknown }> = [];
    const transport = runtimeDiscoveryTransport(transportCalls, (request, key, path) => {
      const revision = `r-${assetSuffix}`;
      const accepted = acceptedReply(request, adoptedDocument(document, preparedPreview!.nextData, revision), revision, key);
      accepted.receipt.request_hash = fixtureDigest({ operation: 'commitTimeline', path,
        publisher: accepted.response.data.publisher, request }).slice(7);
      accepted.receipt.result = accepted.response.data;
      latest = { head: accepted.accepted, canonicalDocument: accepted.canonicalDocument };
      return { status: 200, headers: {}, body: json(accepted.response) };
    });
    const runtimeClient = new AstridRuntimeClient({ baseUrl: 'http://runtime.test', token: 'runtime-token', transport });
    const provider = new RuntimeDataProvider({ projectId: scope.projectId, runtimeClient });
    vi.spyOn(provider, 'loadTimelineCommandBasis').mockImplementation(async () => structuredClone(latest));
    const actualCommit = provider.commitTimeline.bind(provider);
    const send = vi.fn<NonNullable<DataProvider['commitTimeline']>>().mockImplementation(
      (request, key) => actualCommit(request, key),
    );
    provider.commitTimeline = send;
    const store = createTimelineStore();
    const mounted = renderHook(() => useMountedCommands(store, provider, initialData), { wrapper: wrapperFor(store, provider) });
    try {
      await waitFor(() => expect(mounted.result.current.save.localSaveState).not.toBeNull());
      expect(mounted.result.current.save.localSaveState).toMatchObject({ status: 'saved', ownerId: expect.any(String) });
      let result: ReturnType<typeof mounted.result.current.commands.addClip>;
      act(() => {
        result = mounted.result.current.commands.addClip({
          preparedAsset, oldMediaSelection: preparedMediaSelection('asset-source', 'generation-source', 'variant-source'),
          trackId: 'V1', afterClipId: 'anchor', time: 0,
        });
      });
      expect(result!).toEqual({ ok: true, data: { clipId: 'clip-0', trackId: 'V1' } });
      const previewClips = mounted.result.current.save.dataRef.current?.config.clips ?? [];
      expect(previewClips).toEqual(expectedPreview);
      expect(previewClips.find((clip) => clip.id === 'anchor')).toMatchObject(testCase.expectedSource);
      expect(previewClips.find((clip) => clip.id === 'clip-0')).toMatchObject({
        id: 'clip-0', asset: preparedAsset.assetKey, at: expect.any(Number), track: 'V1', ...testCase.expectedInserted,
      });
      expect(previewClips.map((clip) => clip.id)).toEqual(['anchor', 'clip-0', 'later', 'sibling']);
      expect(previewClips.find((clip) => clip.id === 'later')?.at).toBe(testCase.expectedLaterAt);
      expect(previewClips.find((clip) => clip.id === 'sibling')?.at).toBe(5);

      await act(async () => { await mounted.result.current.save.flushPendingSave(); });
      expect(send).toHaveBeenCalledOnce();
      const [request, key] = send.mock.calls[0]!;
      expect(request).toMatchObject({
        api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
        base_revision_id: 'r0', base_publication_id: 'p0', label: 'Add video after clip', merge: 'fields', dry_run: false,
        rationale: 'Duplicate selected parent video', group_id: expect.any(String), source: { via: 'app' },
        commands: [{ schema_version: 1, op: 'clip.duplicate-media', version: '1', select: 'parent/clip:anchor',
          args: { id: 'clip-0', old_media: preparedMediaSelection('asset-source', 'generation-source', 'variant-source'),
            media: preparedAsset.mediaSelection }, intent: { ownership: 'parent' },
          created: [`parent/asset:${preparedAsset.assetKey}`, 'parent/clip:clip-0'] }],
        steps: [{ id: expect.any(String), label: 'Add video after clip', intent: 'Duplicate selected parent video', tags: [],
          command_ordinals: [0], patch: [], reads: [{ kind: 'field', ref: 'parent', path: ['config', 'clips', 'id:anchor'],
            state: { state: 'present', value: config.clips.find((clip) => clip.id === 'anchor') } }] }],
      });
      expect(request.reads).toEqual([{ kind: 'collection', ref: 'parent', path: ['config', 'clips'],
        members: ['anchor', 'later', 'sibling'], order: ['anchor', 'later', 'sibling'] }]);
      expect(request.steps?.[0]?.id).toBe(request.group_id);
      const [wire] = transportCalls.filter((call) => call.path.endsWith('/commit'));
      expect(wire.rawBody).toBe(JSON.stringify(request));
      expect(wire.body).toEqual(request);
      expect(key).toEqual(expect.any(String));
      const accepted = await send.mock.results[0]!.value as TimelineCommitResult;
      expect(accepted.response.data.canonical_document).toEqual(accepted.canonicalDocument);
      expect(mounted.result.current.save.dataRef.current?.config.clips).toEqual(expectedPreview);

      const requestBytes = JSON.stringify(request);
      const { createHash } = await import('node:crypto');
      mountedAfterAnchorPackets.push({
        source_case: testCase.name,
        actual_production_call_binding: 'useMountedCommands(...).commands.addClip({ preparedAsset, trackId: V1, afterClipId: anchor, time: 0 }) -> useTimelineSave.applyEdit -> localSaveSession/outbox -> RuntimeDataProvider.commitTimeline -> AstridRuntimeClient/generated transport',
        request_json: request,
        request_bytes: requestBytes,
        request_byte_length: new TextEncoder().encode(requestBytes).byteLength,
        request_sha256: createHash('sha256').update(requestBytes).digest('hex'),
        canonical_base_closure: document,
        source_pins: {
          anchor: config.clips.find((clip) => clip.id === 'anchor'),
          later: config.clips.find((clip) => clip.id === 'later'),
          sibling: config.clips.find((clip) => clip.id === 'sibling'),
          source_asset: (document.parent_revision.payload.registry as AssetRegistry).assets['asset-source'],
        },
      });
    } finally {
      mounted.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
});

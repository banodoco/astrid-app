// @vitest-environment jsdom
import type React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { RuntimeDataProvider } from '@/integrations/runtime/dataProvider.ts';
import type { Transport } from '@/integrations/runtime/generated.ts';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { json, runtimeFixture } from '@/test/fakeWorkspaceRuntime.ts';
import { VideoEditorRuntimeProvider, type VideoEditorRuntimeContextValue } from '../contexts/VideoEditorRuntimeContext.tsx';
import type { DataProvider } from '../data/DataProvider.ts';
import { loadTimelineDraft } from '../data/timelineDraftIndexedDb.ts';
import { createCommitOutbox } from '../commands/commitOutbox.ts';
import { createInteractionState } from '../lib/interaction-state.ts';
import { createDefaultTimelineConfig } from '../lib/defaults.ts';
import { buildTimelineData } from '../lib/timeline-data.ts';
import { AstridElementOperationAdapter, applyTimelineOperation } from '../runtime/element-adapter.ts';
import { buildAstridAgentElementContext } from '../runtime/element-contract.ts';
import { ASTRID_EFFECT_CATALOG } from '../runtime/astrid-element-catalog.ts';
import { createTimelineStore, TimelineStoreProvider } from './timelineStore.ts';
import { useClipEditing } from './useClipEditing.ts';
import { useTimelineSave } from './useTimelineSave.ts';

vi.mock('../compositions/TimelineRenderer.tsx', () => ({ invalidateReferencedTimelineCache: vi.fn() }));

it('sends a mounted split through the durable outbox with the current generated contract', async () => {
  // Keep generated metadata real: a stale capability allowlist must fail before transport.
  vi.stubGlobal('indexedDB', createFakeIndexedDB());
  const locks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}),
  } });
  const scope = { projectId: 'project-commit', timelineId: 'timeline-current-contract', realmId: 'realm', actorId: 'actor' };
  const head = { projectId: scope.projectId, timelineId: scope.timelineId, headRevisionId: 'r0', headPublicationId: 'p0' };
  const config = createDefaultTimelineConfig();
  config.clips = [{ id: 'source', at: 0, track: 'V1', clipType: 'media', asset: 'video', from: 0, to: 8, speed: 1, hold: 8,
    app: { astrid: { for: 8 }, 'org.example': { clear: null } } }];
  const registry = { assets: { video: { file: 'video.webm', type: 'video/webm', duration: 8 } } };
  const original = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }, scope);
  original.data.canonical_document.parent_revision.payload = { config, registry, clips: config.clips, occurrences: [] };
  original.data.canonical_document.parent_revision.content_digest = fixtureDigest(original.data.canonical_document.parent_revision.payload);
  const data = await buildTimelineData(config, registry, undefined, 1, undefined, head);
  const fixture = runtimeFixture();
  const transmit = vi.fn<Transport>(async (method, path, headers, body) => {
    if (method !== 'POST' || !path.endsWith('/commit')) return fixture.transport(method, path, headers, body);
    const raw = new TextDecoder().decode(body instanceof Blob ? await body.arrayBuffer() : body);
    const request = JSON.parse(raw);
    const [durable] = await createCommitOutbox().list(scope);
    expect(durable.pending?.request).toMatchObject({ body: raw, key: headers['Idempotency-Key'] });
    const reply = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' }, { revision_id: 'r0', publication_id: 'p0' },
      { ...scope, commands: request.commands });
    reply.data.canonical_document = structuredClone(original.data.canonical_document);
    reply.data.canonical_document.parent_revision.revision_id = 'r1';
    const local = JSON.parse(JSON.stringify(save.result.current.dataRef.current!.config));
    reply.data.canonical_document.parent_revision.payload.config = local;
    reply.data.canonical_document.parent_revision.payload.clips = local.clips;
    reply.data.canonical_document.parent_revision.content_digest = fixtureDigest(reply.data.canonical_document.parent_revision.payload);
    reply.data.document_digest = fixtureDigest(reply.data.canonical_document);
    Object.assign(reply.data, { label: request.label, steps: request.steps, merge_mode: request.merge });
    reply.receipt.idempotency_key = headers['Idempotency-Key'];
    return { status: 200, headers: {}, body: json(reply) };
  });
  const runtime = new RuntimeDataProvider({ projectId: scope.projectId, transport: transmit });
  const legacySave = vi.fn(async () => { throw new Error('No legacy save'); });
  const provider: DataProvider = {
    persistenceEnabled: true, loadTimeline: async () => ({ config, configVersion: 1 }),
    loadAssetRegistry: async () => registry, resolveAssetUrl: async file => file, saveTimeline: legacySave,
    loadTimelineCommandBasis: async () => ({ head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: original.data.canonical_document }),
    getRecoverableIdentity: async () => ({ realmId: scope.realmId, actorId: scope.actorId }),
    commitTimeline: (request, key) => runtime.commitTimeline(request, key),
  };
  const store = createTimelineStore();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const context = { provider, timelineId: scope.timelineId, project: { projectId: scope.projectId },
    shots: {}, toast: { error: vi.fn() } } as unknown as VideoEditorRuntimeContextValue;
  const interaction = { current: createInteractionState() };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <VideoEditorRuntimeProvider value={context}>
        <TimelineStoreProvider store={store}>{children}</TimelineStoreProvider>
      </VideoEditorRuntimeProvider>
    </QueryClientProvider>
  );
  const save = renderHook(() => useTimelineSave({ timelineQuery: { data: undefined, isLoading: false },
    assetRegistryQuery: { data: undefined } }, provider, interaction, store, data), { wrapper });
  const editing = renderHook(() => useClipEditing({ dataRef: save.result.current.dataRef,
    resolvedConfig: save.result.current.dataRef.current?.resolvedConfig ?? null,
    selectedClipId: null, selectedTrack: null, currentTime: 2,
    selectClip: vi.fn(), setSelectedTrackId: vi.fn(), applyEdit: save.result.current.applyEdit }));
  try {
    await vi.waitFor(() => expect(save.result.current.localSaveState?.ownerId).toBeTruthy());
    await act(async () => { await loadTimelineDraft(scope.timelineId); });
    await act(async () => { editing.result.current.handleSplitClipAtTime('source', 2); });
    expect(save.result.current.dataRef.current?.config.clips).toHaveLength(2);
    await act(async () => { await save.result.current.flushPendingSave(); });
    const posts = transmit.mock.calls.filter(([method, path]) => method === 'POST' && path.endsWith('/commit'));
    expect(posts).toHaveLength(1);
    const body = posts[0][3];
    const request = JSON.parse(new TextDecoder().decode(body instanceof Blob ? await body.arrayBuffer() : body));
    expect(request).toMatchObject({ base_revision_id: 'r0', base_publication_id: 'p0', merge: 'fields', dry_run: false,
      commands: [{ op: 'doc.patch', args: { changes: expect.arrayContaining([expect.objectContaining({ op: 'list.insert' })]) } }],
      steps: [{ command_ordinals: [0], patch: expect.any(Array) }], reads: expect.any(Array) });
    expect(save.result.current.localSaveState?.status).toBe('saved');
    expect(save.result.current.dataRef.current?.head?.headPublicationId).toBe('p1');
    expect((await createCommitOutbox().list(scope))[0].intents).toEqual([]);
    expect(legacySave).not.toHaveBeenCalled();
  } finally {
    editing.unmount();
    save.unmount();
    queryClient.clear();
    if (locks) Object.defineProperty(navigator, 'locks', locks);
    else Reflect.deleteProperty(navigator, 'locks');
    vi.unstubAllGlobals();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it.each(['late acceptance', 'exact replay'] as const)(
  'keeps an element pending until durable Runtime acceptance: %s', async outcome => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB());
    const locks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}),
    } });
    const scope = { projectId: 'project-commit', timelineId: 'timeline-element-pending', realmId: 'realm', actorId: 'actor' };
    const head = { projectId: scope.projectId, timelineId: scope.timelineId, headRevisionId: 'r0', headPublicationId: 'p0' };
    const config = createDefaultTimelineConfig();
    config.clips = [{ id: 'source', at: 0, track: 'V1', clipType: 'hold', hold: 2 }];
    const registry = { assets: {} };
    const seed = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }, scope);
    const original = seed.data.canonical_document;
    original.parent_revision.payload = { config, registry, clips: structuredClone(config.clips), occurrences: [] };
    original.parent_revision.content_digest = fixtureDigest(original.parent_revision.payload);
    const data = await buildTimelineData(config, registry, undefined, 1, undefined, head);
    const initial = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: original };
    const context = buildAstridAgentElementContext({ astridEffects: ASTRID_EFFECT_CATALOG });
    const entry = context.catalog.find(item => item.id === 'text-card' && item.packId === 'rendering')!;
    const operation = { name: 'timeline.apply_element' as const, project: scope.projectId, timeline: scope.timelineId,
      expected_version: 1, clip_id: 'source', placement: 'clip' as const,
      element: { id: entry.id, kind: entry.kind, packId: entry.packId, revision: entry.revision } };
    const nextConfig = applyTimelineOperation(context, config, operation);
    let latest = initial;
    const fixture = runtimeFixture();
    const releases: Array<(value: Awaited<ReturnType<Transport>>) => void> = [];
    const transmit = vi.fn<Transport>(async (method, path, headers, body) => {
      if (method !== 'POST' || !path.endsWith('/commit')) return fixture.transport(method, path, headers, body);
      const gate = deferred<Awaited<ReturnType<Transport>>>();
      releases.push(gate.resolve);
      return gate.promise;
    });
    const posts = () => transmit.mock.calls.filter(([, path]) => path.endsWith('/commit'));
    const runtime = new RuntimeDataProvider({ projectId: scope.projectId, transport: transmit });
    const provider: DataProvider = {
      persistenceEnabled: true, loadTimeline: async () => ({ config, configVersion: 1, head }),
      loadAssetRegistry: async () => registry, resolveAssetUrl: async file => file,
      saveTimeline: vi.fn(async () => { throw new Error('Legacy save route used'); }),
      loadTimelineCommandBasis: async () => latest,
      getRecoverableIdentity: async () => ({ realmId: scope.realmId, actorId: scope.actorId }),
      commitTimeline: (request, key) => runtime.commitTimeline(request, key),
    };
    const store = createTimelineStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const contextValue = { provider, timelineId: scope.timelineId, project: { projectId: scope.projectId },
      shots: {}, toast: { error: vi.fn() } } as unknown as VideoEditorRuntimeContextValue;
    const interaction = { current: createInteractionState() };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <VideoEditorRuntimeProvider value={contextValue}>
          <TimelineStoreProvider store={store}>{children}</TimelineStoreProvider>
        </VideoEditorRuntimeProvider>
      </QueryClientProvider>
    );
    const save = renderHook(() => useTimelineSave({ timelineQuery: { data: undefined, isLoading: false },
      assetRegistryQuery: { data: undefined } }, provider, interaction, store, data), { wrapper });
    const makeReply = (revision: string, publication: string) => {
      const reply = acceptedCommit({ revision_id: revision, publication_id: publication }, { revision_id: 'r0', publication_id: 'p0' }, scope);
      const canonical = structuredClone(original);
      canonical.parent_revision.revision_id = revision;
      canonical.parent_revision.payload.config = structuredClone(nextConfig);
      canonical.parent_revision.payload.clips = structuredClone(nextConfig.clips);
      canonical.parent_revision.content_digest = fixtureDigest(canonical.parent_revision.payload);
      reply.data.canonical_document = canonical;
      reply.data.document_digest = fixtureDigest(canonical);
      return reply;
    };
    try {
      await vi.waitFor(() => expect(save.result.current.localSaveState?.ownerId).toBeTruthy());
      const adapter = new AstridElementOperationAdapter(context, save.result.current.elementTimelineRoutes, scope.projectId, {
        timelineId: scope.timelineId, assertAuthority: () => {}, getHead: () => save.result.current.dataRef.current?.head,
      });
      const execution = adapter.captureForTurn().execute(operation);
      await vi.waitFor(() => expect(posts()).toHaveLength(1));
      expect(save.result.current.dataRef.current?.config.clips[0]).not.toHaveProperty('elementRef');
      expect(save.result.current.localSaveState?.status).toBe('saving');
      const firstPost = posts()[0];
      const firstBody = firstPost[3];
      const firstKey = firstPost[2]['Idempotency-Key'];
      if (outcome === 'late acceptance') {
        const accepted = makeReply('r1', 'p1');
        accepted.receipt.idempotency_key = firstKey;
        latest = { head: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: accepted.data.canonical_document };
        releases[0]({ status: 200, headers: {}, body: json(accepted) });
      } else {
        releases[0]({ status: 503, headers: {}, body: json({ code: 'unavailable', message: 'Acknowledgement lost' }) });
        await expect(execution).rejects.toThrow();
        expect(save.result.current.dataRef.current?.config.clips[0]).not.toHaveProperty('elementRef');
        const replay = save.result.current.localDocumentSave!.flush();
        await vi.waitFor(() => expect(posts()).toHaveLength(2));
        expect(posts()[1][2]['Idempotency-Key']).toBe(firstKey);
        expect(posts()[1][3]).toEqual(firstBody);
        const accepted = makeReply('r1', 'p1');
        accepted.receipt.idempotency_key = firstKey;
        latest = { head: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: accepted.data.canonical_document };
        releases[1]({ status: 200, headers: {}, body: json(accepted) });
        await replay;
      }
      if (outcome === 'late acceptance') await execution;
      await vi.waitFor(() => expect(save.result.current.dataRef.current?.head?.headRevisionId).toBe('r1'));
      expect(save.result.current.dataRef.current?.config.clips.filter(clip => clip.elementRef)).toHaveLength(1);
      expect((await createCommitOutbox().list(scope))[0].intents).toHaveLength(0);
    } finally {
      save.unmount();
      queryClient.clear();
      if (locks) Object.defineProperty(navigator, 'locks', locks);
      else Reflect.deleteProperty(navigator, 'locks');
      vi.unstubAllGlobals();
    }
  },
);

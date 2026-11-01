// @vitest-environment jsdom
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB, resetFakeIndexedDB } from 'fake-indexeddb';
import { type Transport } from '@/integrations/runtime/generated.ts';
import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import { RUNTIME_SCHEMA_DIGEST } from '@/integrations/runtime/contract-metadata.ts';
import { RuntimeDataProvider } from '@/integrations/runtime/dataProvider.ts';
import type { CanonicalDocument, CommitRequest } from '@/integrations/runtime/timeline-commit-types.ts';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { DataProvider, TimelineCommandBasis, TimelineCommitResult, TimelineHeadRevision } from '@/tools/video-editor/data/DataProvider.ts';
import { VideoEditorRuntimeProvider, type VideoEditorRuntimeContextValue } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import { createTimelineStore } from '@/tools/video-editor/hooks/timelineStore.ts';
import { useTimelineSave } from '@/tools/video-editor/hooks/useTimelineSave.ts';
import { useTimelineTrackManagement } from '@/tools/video-editor/hooks/useTimelineTrackManagement.ts';
import { createInteractionState } from '@/tools/video-editor/lib/interaction-state.ts';
import { buildTimelineData, type TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import type { TimelineConfig } from '@/tools/video-editor/types/index.ts';
import { createCommitOutbox } from '@/tools/video-editor/commands/commitOutbox.ts';

vi.mock('@/integrations/runtime/generated-contract-metadata.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/integrations/runtime/generated-contract-metadata.ts')>(),
  SCHEMA_DIGEST: 'sha256:9628bb5fd6e1dbbec392dd39f2e01031622dcf52d7ccff7cd1f0ad10743dcb1c',
}));
vi.mock('@/tools/video-editor/compositions/TimelineRenderer.tsx', () => ({
  invalidateReferencedTimelineCache: vi.fn(),
}));
vi.mock('@/tools/video-editor/hooks/usePollSync.ts', () => ({ usePollSync: vi.fn() }));

const scope = { realmId: 'realm-track', actorId: 'actor-track', projectId: 'project-track', timelineId: 'timeline-track' };
const initialHead: TimelineHeadRevision = {
  projectId: scope.projectId,
  timelineId: scope.timelineId,
  headRevisionId: 'r0',
  headPublicationId: 'p0',
};

const trackOrder = ['picture', 'audio', 'overlay'];
const reorderedTrackOrder = ['overlay', 'picture', 'audio'];

function authoredConfig(): TimelineConfig {
  return {
    output: { resolution: '1280x720', fps: 30, file: 'tracks.mp4', background: null, background_scale: null },
    tracks: [
      { id: 'picture', kind: 'visual', label: 'Picture', scaleAppliesToPositionedClips: true, app: { lane: 'main', opaque: { keep: null }, scaleAppliesToPositionedClips: true } },
      { id: 'audio', kind: 'audio', label: 'Audio', scaleAppliesToPositionedClips: true, app: { nullValue: null, falseValue: false, zeroValue: 0, scaleAppliesToPositionedClips: true } },
      { id: 'overlay', kind: 'visual', label: 'Overlay', scaleAppliesToPositionedClips: true, app: { opaque: [null, false, 0], scaleAppliesToPositionedClips: true } },
    ],
    clips: [{
      id: 'clip-picture', track: 'picture', clipType: 'hold', at: 0, hold: 2,
      app: { opaque: { keep: null, false: false, zero: 0 } },
    }],
    app: { timelineDataLanePlacement: { 'data-1': 'between' }, opaque: { keep: null, sibling: [false, 0] } },
  };
}

function makeCanonicalDocument(config: TimelineConfig, revisionId = 'r0'): CanonicalDocument {
  const parentPayload = {
    config: structuredClone(config),
    clips: structuredClone(config.clips),
    registry: { assets: {} },
    occurrences: [],
    opaque_parent: { keep: null, sibling: [false, 0] },
  };
  const response = acceptedCommit(
    { revision_id: revisionId, publication_id: revisionId === 'r0' ? 'p0' : 'p1' },
    { revision_id: 'r0', publication_id: 'p0' },
    { projectId: scope.projectId, timelineId: scope.timelineId },
  );
  const document = structuredClone(response.data.canonical_document) as CanonicalDocument;
  document.project_id = scope.projectId;
  document.timeline_id = scope.timelineId;
  document.parent_revision.revision_id = revisionId;
  document.parent_revision.payload = parentPayload;
  document.parent_revision.content_digest = fixtureDigest(parentPayload);
  return document;
}

function makeBasis(config: TimelineConfig, revisionId = 'r0', publicationId = 'p0'): TimelineCommandBasis {
  return { head: { revisionId, publicationId }, canonicalDocument: makeCanonicalDocument(config, revisionId) };
}

function acceptedResult(request: CommitRequest, before: TimelineCommandBasis): TimelineCommitResult {
  const nextConfig = structuredClone(before.canonicalDocument.parent_revision.payload.config) as TimelineConfig;
  nextConfig.tracks = reorderedTrackOrder.map((id) => nextConfig.tracks!.find((track) => track.id === id)!);
  const canonicalDocument = structuredClone(before.canonicalDocument);
  canonicalDocument.parent_revision.revision_id = 'r1';
  canonicalDocument.parent_revision.payload.config = nextConfig as unknown as Record<string, unknown>;
  canonicalDocument.parent_revision.payload.clips = structuredClone(nextConfig.clips);
  canonicalDocument.parent_revision.content_digest = fixtureDigest(canonicalDocument.parent_revision.payload);
  const response = acceptedCommit(
    { revision_id: 'r1', publication_id: 'p1' },
    { revision_id: 'r0', publication_id: 'p0' },
    { projectId: scope.projectId, timelineId: scope.timelineId, commands: request.commands },
  );
  response.data.canonical_document = canonicalDocument;
  response.data.document_digest = fixtureDigest(canonicalDocument);
  response.data.label = request.label;
  response.data.steps = request.steps;
  response.data.merge_mode = request.merge;
  response.data.source = request.source;
  response.receipt.idempotency_key = 'mounted-track-key';
  response.receipt.result = response.data;
  return {
    response,
    accepted: { revisionId: 'r1', publicationId: 'p1' },
    canonicalDocument,
    graph: {},
    receipt: response.receipt,
  };
}

type MountedHarness = {
  hook: ReturnType<typeof renderHook<{
    save: ReturnType<typeof useTimelineSave>;
    tracks: ReturnType<typeof useTimelineTrackManagement>;
  }, unknown>>;
  provider: DataProvider;
  send: ReturnType<typeof vi.fn<NonNullable<DataProvider['commitTimeline']>>>;
  basis: TimelineCommandBasis;
  data: TimelineData;
  transportCalls: Array<{ method: string; path: string; headers: Record<string, string>; rawBody?: string; body?: unknown }>;
};

async function mountHarness(outcome: 'accepted' | 'refused') : Promise<MountedHarness> {
  const config = authoredConfig();
  const basis = makeBasis(config);
  let latest = basis;
  const transportCalls: MountedHarness['transportCalls'] = [];
  const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
  const transport: Transport = async (method, path, headers, body) => {
    const rawBody = body ? new TextDecoder().decode(body as Uint8Array) : undefined;
    transportCalls.push({ method, path, headers, ...(rawBody === undefined ? {} : { rawBody, body: JSON.parse(rawBody) }) });
    if (path === '/v1/health') {
      return { status: 200, headers: {}, body: json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST,
        runtime_epoch: 1, runtime_session_id: 'session-track', runtime_instance_id: 'instance-track' }) };
    }
    if (path === '/v1/handshake') {
      return { status: 200, headers: {}, body: json({ protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST,
        session_id: 'session-track', actor_id: scope.actorId, realm_id: scope.realmId,
        scopes: ['handshake', 'projects:read', 'projects:write', 'objects:read', 'objects:write', 'tasks:read', 'tasks:write'],
        capabilities: ['execution_binding.targeted.v1'] }) };
    }
    if (path === '/v1/realm') {
      return { status: 200, headers: {}, body: json({ realm_id: scope.realmId, display_name: 'track fixture', version: 1, created_at: '2026-10-19T00:00:00Z' }) };
    }
    if (method === 'POST' && path === `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`) {
      if (outcome === 'refused') {
        const remoteConfig = authoredConfig();
        remoteConfig.tracks = [remoteConfig.tracks![0], remoteConfig.tracks![2], remoteConfig.tracks![1]];
        latest = makeBasis(remoteConfig, 'remote-r2', 'remote-p2');
        return { status: 409, headers: {}, body: json({
          code: 'selection_changed', message: 'Track order changed at the Runtime head', request_id: 'request-track',
          details: {
            status: 'conflict', reason: 'selection_changed',
            base: { revision_id: 'r0', publication_id: 'p0' },
            current: { revision_id: 'remote-r2', publication_id: 'remote-p2' },
            conflicts: [], code: 'selection_changed', path: ['parent', 'config', 'tracks'],
            hint: 'Reload the timeline and retry the reorder.', suggested_command: 'show timeline',
          },
        }) };
      }
      const request = JSON.parse(rawBody!) as CommitRequest;
      const result = acceptedResult(request, basis);
      result.receipt.idempotency_key = headers['Idempotency-Key']!;
      result.receipt.request_hash = fixtureDigest({ operation: 'commitTimeline', path,
        publisher: result.response.data.publisher, request }).slice(7);
      result.receipt.result = result.response.data;
      latest = { head: result.accepted, canonicalDocument: result.canonicalDocument, graph: result.graph };
      return { status: 200, headers: {}, body: json(result.response) };
    }
    throw new Error(`Unexpected Runtime request: ${method} ${path}`);
  };
  const runtimeClient = new AstridRuntimeClient({ baseUrl: 'http://runtime.test', token: 'runtime-token', transport });
  const provider = new RuntimeDataProvider({ projectId: scope.projectId, runtimeClient });
  vi.spyOn(provider, 'loadTimelineCommandBasis').mockImplementation(async () => structuredClone(latest));
  const actualCommit = provider.commitTimeline.bind(provider);
  const send = vi.fn<NonNullable<DataProvider['commitTimeline']>>().mockImplementation(
    (request, key) => actualCommit(request, key),
  );
  provider.commitTimeline = send;
  const data = await buildTimelineData(config, { assets: {} }, provider.resolveAssetUrl, 1, undefined, initialHead);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const store = createTimelineStore();
  const interactionStateRef = { current: createInteractionState() };
  const queries = { timelineQuery: { data: undefined, isLoading: false }, assetRegistryQuery: { data: undefined } } as never;
  const runtime = {
    project: { projectId: scope.projectId },
    timelineId: scope.timelineId,
    assetResolver: null,
    shots: { shots: undefined, isLoading: false, error: null, refetchShots: vi.fn(), canonicalDraft: null },
  } as unknown as VideoEditorRuntimeContextValue;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <VideoEditorRuntimeProvider value={runtime}>{children}</VideoEditorRuntimeProvider>
    </QueryClientProvider>
  );
  const hook = renderHook(() => {
    const save = useTimelineSave(queries, provider, interactionStateRef, store, data);
    const tracks = useTimelineTrackManagement({
      dataRef: save.dataRef,
      resolvedConfig: save.dataRef.current?.resolvedConfig ?? null,
      selectedClipId: null,
      setSelectedTrackId: save.setSelectedTrackId,
      applyEdit: save.applyEdit,
    });
    return { save, tracks };
  }, { wrapper });
  await waitFor(() => expect(hook.result.current.save.localSaveState?.ownerId).toBeTruthy());
  await waitFor(() => expect(hook.result.current.save.localSaveState?.status).toBe('saved'));
  return { hook, provider, send, basis, data, transportCalls };
}

async function settlePromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('mounted track reorder persistence through A2', () => {
  beforeEach(() => {
    resetFakeIndexedDB();
    vi.stubGlobal('indexedDB', createFakeIndexedDB());
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}) } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the real hook consumer and persists a guarded generic doc.patch list.move', async () => {
    const mounted = await mountHarness('accepted');
    try {
      act(() => mounted.hook.result.current.tracks.handleMoveTrack('overlay', 'picture'));
      await waitFor(() => expect(mounted.send).toHaveBeenCalledTimes(1), { timeout: 3000 });
      await waitFor(() => expect(mounted.hook.result.current.save.localSaveState?.status).toBe('saved'));

      const [request, key] = mounted.send.mock.calls[0];
      expect(request).toMatchObject({
        api_version: 1,
        project_id: scope.projectId,
        timeline_id: scope.timelineId,
        base_revision_id: 'r0',
        base_publication_id: 'p0',
        label: 'Edit timeline',
        merge: 'atomic',
        dry_run: false,
        source: { via: 'app' },
      });
      expect(request).not.toHaveProperty('reads');
      expect(key).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.commands).toHaveLength(1);
      const command = request.commands[0];
      expect(command).toMatchObject({ schema_version: 1, op: 'doc.patch', version: '1', select: null, created: [] });
      const change = command.args.changes[0];
      expect(change).toMatchObject({
        op: 'list.move', ref: 'parent', path: ['config', 'tracks'], id: 'overlay',
        order_before: trackOrder, after_id: null,
      });
      expect(change.before).toEqual({ state: 'present', value: mounted.basis.canonicalDocument.parent_revision.payload.config.tracks![2] });
      expect(request.steps).toEqual([{
        id: expect.any(String), label: 'Edit timeline', intent: 'Save local editor changes', tags: [],
        command_ordinals: [0], patch: [change],
      }]);

      const commitCalls = mounted.transportCalls.filter((call) => call.path.endsWith('/commit'));
      expect(commitCalls).toHaveLength(1);
      const [wire] = commitCalls;
      expect(wire.method).toBe('POST');
      expect(wire.path).toBe(`/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`);
      expect(wire.headers).toMatchObject({
        Accept: 'application/json', Authorization: 'Bearer runtime-token',
        'Content-Type': 'application/json', 'Idempotency-Key': key,
      });
      expect(wire.rawBody).toBe(JSON.stringify(request));
      expect(wire.body).toEqual(request);

      const accepted = await mounted.send.mock.results[0]!.value as TimelineCommitResult;
      expect(accepted.response.data).toMatchObject({
        status: 'accepted',
        base_revision_id: 'r0', base_publication_id: 'p0',
        previous_revision_id: 'r0', previous_publication_id: 'p0',
        accepted_revision_id: 'r1', rebased_onto: null,
        document_digest: fixtureDigest(accepted.canonicalDocument),
        commands: request.commands, merge_mode: 'atomic', steps: request.steps,
        label: 'Edit timeline', source: { via: 'app' },
      });
      expect(accepted.response.data.canonical_document).toEqual(accepted.canonicalDocument);
      expect(accepted.response.data.canonical_document.parent_revision).toMatchObject({
        revision_id: 'r1', content_digest: fixtureDigest(accepted.canonicalDocument.parent_revision.payload),
      });
      expect(accepted.receipt).toMatchObject({
        receipt_id: 'p1', command_kind: 'timeline.commit', idempotency_key: key,
        project_id: scope.projectId, project_seq: [1, 1], event_ids: ['event-p1'],
        request_hash: fixtureDigest({ operation: 'commitTimeline', path: wire.path,
          publisher: accepted.response.data.publisher, request }).slice(7),
      });
      expect(accepted.receipt.result).toEqual(accepted.response.data);

      expect(mounted.hook.result.current.save.dataRef.current?.head).toMatchObject({ headRevisionId: 'r1', headPublicationId: 'p1' });
      expect(mounted.hook.result.current.save.dataRef.current?.config.tracks?.map((track) => track.id)).toEqual(reorderedTrackOrder);
      expect(mounted.hook.result.current.save.dataRef.current?.config.app).toEqual(authoredConfig().app);
      expect(mounted.hook.result.current.save.dataRef.current?.config.clips?.[0]?.app)
        .toEqual({ opaque: { keep: null, false: false, zero: 0 } });
      expect(mounted.hook.result.current.save.dataRef.current?.config.tracks?.find((track) => track.id === 'audio')?.app)
        .toEqual({ nullValue: null, falseValue: false, zeroValue: 0, scaleAppliesToPositionedClips: true });
      expect(mounted.hook.result.current.save.dataRef.current?.config.tracks?.find((track) => track.id === 'overlay')?.app)
        .toEqual({ opaque: [null, false, 0], scaleAppliesToPositionedClips: true });
      expect(request.steps?.[0]).not.toHaveProperty('reads');

      const [stored] = await createCommitOutbox().list(scope);
      expect(stored.intents).toHaveLength(0);
      expect(stored.accepted?.value).toMatchObject({
        accepted: { revisionId: 'r1', publicationId: 'p1' },
        response: { data: { status: 'accepted', label: 'Edit timeline', merge_mode: 'atomic' } },
      });
      expect((stored.accepted?.value as any).canonicalDocument.parent_revision.payload.opaque_parent)
        .toEqual({ keep: null, sibling: [false, 0] });
    } finally {
      mounted.hook.unmount();
      await settlePromises();
    }
  });

  it('retains the durable intent and revalidates the mounted UI on a structured refusal', async () => {
    const mounted = await mountHarness('refused');
    try {
      act(() => mounted.hook.result.current.tracks.handleMoveTrack('overlay', 'picture'));
      await waitFor(() => expect(mounted.send).toHaveBeenCalledTimes(1), { timeout: 3000 });
      await waitFor(() => expect(mounted.hook.result.current.save.localSaveState?.status).toBe('conflict'));
      await waitFor(() => expect(mounted.hook.result.current.save.dataRef.current?.head)
        .toMatchObject({ headRevisionId: 'remote-r2', headPublicationId: 'remote-p2' }));

      expect(mounted.hook.result.current.save.saveStatus).toBe('error');
      expect(mounted.hook.result.current.save.localSaveState?.error).toMatchObject({
        kind: 'conflict', code: 'selection_changed',
        message: expect.stringContaining('selection_changed'),
        details: {
          status: 'conflict', reason: 'selection_changed',
          base: { revision_id: 'r0', publication_id: 'p0' },
          current: { revision_id: 'remote-r2', publication_id: 'remote-p2' },
          conflicts: [], code: 'selection_changed', path: ['parent', 'config', 'tracks'],
          hint: 'Reload the timeline and retry the reorder.', suggested_command: 'show timeline',
        },
      });
      expect(mounted.hook.result.current.save.localSaveState?.error?.details).not.toHaveProperty('head');
      const refusal = await mounted.send.mock.results[0]!.value.catch((error: unknown) => error);
      expect(refusal).toMatchObject({ status: 409, code: 'selection_changed' });
      expect(refusal).not.toHaveProperty('receipt');
      expect(mounted.hook.result.current.save.dataRef.current?.config.tracks?.map((track) => track.id))
        .toEqual(['picture', 'overlay', 'audio']);
      expect(mounted.hook.result.current.save.dataRef.current?.config.app).toEqual(authoredConfig().app);
      expect(mounted.hook.result.current.save.dataRef.current?.config.clips?.[0]?.app)
        .toEqual({ opaque: { keep: null, false: false, zero: 0 } });

      const commitCalls = mounted.transportCalls.filter((call) => call.path.endsWith('/commit'));
      expect(commitCalls).toHaveLength(1);
      const [wire] = commitCalls;
      expect(wire.method).toBe('POST');
      expect(wire.path).toBe(`/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`);
      expect(wire.headers).toMatchObject({
        Accept: 'application/json', Authorization: 'Bearer runtime-token',
        'Content-Type': 'application/json', 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
      expect(wire.body).toMatchObject({ base_revision_id: 'r0', base_publication_id: 'p0', merge: 'atomic' });

      const [stored] = await createCommitOutbox().list(scope);
      expect(stored.intents).toHaveLength(1);
      expect(stored.pending?.outcome).toMatchObject({ kind: 'rejected', error: { code: 'selection_changed' } });
      const intent = stored.intents[0].payload as any;
      expect(intent.label).toBe('Edit timeline');
      expect(intent.documentIntent.changes[0]).toMatchObject({
        op: 'list.move', ref: 'parent', path: ['config', 'tracks'], id: 'overlay',
        before: { state: 'present', value: mounted.basis.canonicalDocument.parent_revision.payload.config.tracks![2] },
        order_before: trackOrder, after_id: null,
      });
      expect(intent.documentIntent.after.parent_revision.payload.config.tracks.map((track: { id: string }) => track.id))
        .toEqual(reorderedTrackOrder);
      expect(intent.documentIntent.after.parent_revision.payload.config.clips[0].app)
        .toEqual({ opaque: { keep: null, false: false, zero: 0 } });
      expect(intent.documentIntent.after.parent_revision.payload.opaque_parent)
        .toEqual({ keep: null, sibling: [false, 0] });
    } finally {
      mounted.hook.unmount();
      await settlePromises();
    }
  });

  it('classifies same-order legacy explicit write separately: the current mounted UI is a no-op', async () => {
    const mounted = await mountHarness('accepted');
    try {
      act(() => mounted.hook.result.current.tracks.handleMoveTrack('picture', 'picture'));
      await settlePromises();
      expect(mounted.send).not.toHaveBeenCalled();
      expect(mounted.hook.result.current.save.dataRef.current?.config.tracks?.map((track) => track.id)).toEqual(trackOrder);
      const records = await createCommitOutbox().list(scope);
      expect(records[0]?.intents).toHaveLength(0);
    } finally {
      mounted.hook.unmount();
      await settlePromises();
    }
  });
});

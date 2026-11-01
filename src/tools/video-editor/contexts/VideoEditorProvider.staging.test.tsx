// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { AgentChatProvider, useAgentChatBridge } from '@/shared/contexts/AgentChatContext';
import { toast } from '@/shared/components/ui/runtime/sonner';
import { systemResetSelectionForProjectChange } from '@/shared/state/selectionStore';
import { RuntimeDataProvider } from '@/integrations/runtime/dataProvider';
import { RUNTIME_SCHEMA_DIGEST } from '@/integrations/runtime/contract-metadata';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture';
import { ApiError } from '@/integrations/runtime/generated';
import { createCommitOutbox } from '../commands/commitOutbox';
import type { MediaSelection } from '@/integrations/runtime/timeline-commit-types';
import type { DataProvider, TimelineCommandBasis } from '../data/DataProvider';
import type { AssetRegistry, TimelineClip, TimelineConfig } from '../types';
import { createDefaultTimelineConfig, withDefaultTimelineOutput } from '../lib/defaults';
import { buildTimelineData } from '../lib/timeline-data';
import { MEDIA_COMMAND_DESCRIPTORS, PLACE_PREPARED_MEDIA_COMMAND_DESCRIPTOR } from '../commands/media';
import { useTimelineChromeContext, useTimelineEditorData, useTimelineEditorOps } from '../hooks/timelineStore';
import { VideoEditorProvider } from './VideoEditorProvider';
import { ADD_GENERATION_QUERY_PARAM, readPendingAdds, writePendingAdds } from '@/domains/media-lightbox/hooks/addToVideoEditorConstants';

vi.mock('../hooks/useEffects.ts', () => ({ useEffects: () => ({ data: [] }) }));
vi.mock('../hooks/useFinalVideoAvailable.ts', () => ({ useFinalVideoAvailable: () => ({ finalVideoMap: new Map() }) }));
vi.mock('../compositions/TimelineRenderer.tsx', () => ({ invalidateReferencedTimelineCache: vi.fn() }));

const projectId = 'project-staging';
const timelineId = 'timeline-staging';
const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
beforeEach(() => {
  vi.stubGlobal('indexedDB', createFakeIndexedDB());
  localStorage.clear();
  systemResetSelectionForProjectChange();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}),
  } });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (locksDescriptor) Object.defineProperty(navigator, 'locks', locksDescriptor);
  else Reflect.deleteProperty(navigator, 'locks');
});

async function mountStaged(ids: string[], selectionRead?: (selection: MediaSelection) => Promise<MediaSelection>, stage = true) {
  const config = { ...createDefaultTimelineConfig(),
    tracks: [{ id: 'V1', kind: 'visual' as const, label: 'Picture' }],
    clips: [{ id: 'existing', track: 'V1', at: 0, hold: 2, text: { content: 'Keep me' } }],
  };
  const base = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' },
    { revision_id: 'r0', publication_id: 'p0' }, { projectId, timelineId }).data.canonical_document;
  base.parent_revision.payload = { config, clips: config.clips, registry: { assets: {} }, occurrences: [] };
  base.parent_revision.content_digest = fixtureDigest(base.parent_revision.payload);
  let basis: TimelineCommandBasis = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: base };
  const initialData = await buildTimelineData(config, { assets: {} }, async file => file, 1, undefined,
    { projectId, timelineId, headRevisionId: 'r0', headPublicationId: 'p0' });
  let editor!: ReturnType<typeof useTimelineEditorData>;
  let chrome!: ReturnType<typeof useTimelineChromeContext>;
  let location!: ReturnType<typeof useLocation>;
  function Consumer() {
    editor = useTimelineEditorData();
    chrome = useTimelineChromeContext();
    location = useLocation();
    return <span>{editor.resolvedConfig?.clips.length}</span>;
  }
  const selections = new Map<string, MediaSelection>();
  const calls: string[] = [];
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const runtime = new RuntimeDataProvider({ projectId, baseUrl: 'http://runtime.test', token: 'fixture-token',
    transport: async (_method, path) => {
      calls.push(path);
      const json = (value: unknown) => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) });
      if (path === '/v1/health') return json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST,
        runtime_epoch: 1, runtime_session_id: 'session', runtime_instance_id: 'instance-staging' });
      if (path === '/v1/handshake') return json({ protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST,
        session_id: 'session', actor_id: 'actor', realm_id: 'realm',
        scopes: ['handshake', 'projects:read', 'projects:write', 'objects:read', 'objects:write', 'tasks:read', 'tasks:write'],
        capabilities: ['execution_binding.targeted.v1'] });
      if (path === '/v1/realm') return json({ realm_id: 'realm', display_name: 'Staging fixture', version: 1,
        created_at: '2026-10-24T00:00:00Z' });
      const generationId = ids.find(id => path === `/v1/generations/${id}` || path.startsWith(`/v1/generations/${id}/variants?`));
      if (generationId) {
        await ready;
        if (path.endsWith(`/generations/${generationId}`)) return json({ generation_id: generationId, project_id: projectId,
          type: 'image', status: 'completed', metadata: { name: `Name ${generationId}`, prompt: 'Preserve prompt' },
          version: 1, created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z' });
        return json({ items: [{ variant_id: `variant-${generationId}`, generation_id: generationId,
          object_id: `sha256:${'a'.repeat(64)}`, variant_type: 'original', metadata: { is_primary: true, media_type: 'image/png' },
          created_at: '2026-10-24T00:00:00Z' }], next_cursor: null });
      }
      if (path.startsWith(`/v1/projects/${projectId}/media-selection?`)) {
        const query = new URLSearchParams(path.split('?')[1]);
        const selection = { asset: query.get('asset')!, generation_id: query.get('generation_id')!, variant_id: query.get('variant_id')!,
          object_id: `sha256:${'a'.repeat(64)}`, catalog_digest: `sha256:${'b'.repeat(64)}` };
        selections.set(selection.generation_id, selection);
        return json(selectionRead ? await selectionRead(selection) : selection);
      }
      throw new Error(`Unexpected Runtime read: ${path}`);
    },
  });
  const preparedAssets: AssetRegistry['assets'] = {};
  const commit = vi.fn<NonNullable<DataProvider['commitTimeline']>>(async (request, key) => {
    const revision = `r${commit.mock.calls.length}`;
    const response = acceptedCommit({ revision_id: revision, publication_id: `p-${revision}` },
      { revision_id: request.base_revision_id, publication_id: request.base_publication_id }, { projectId, timelineId, commands: request.commands });
    const document = structuredClone(basis.canonicalDocument);
    const current = editor.dataRef.current!;
    Object.assign(preparedAssets, structuredClone(current.registry.assets));
    const payload = document.parent_revision.payload;
    const nextConfig = payload.config as unknown as TimelineConfig;
    const registry = payload.registry as unknown as AssetRegistry;
    for (const command of request.commands) {
      expect(command.op).toBe('clip.add-media');
      nextConfig.clips.push(structuredClone(command.args.row) as unknown as TimelineClip);
      const asset = (command.args.media as unknown as MediaSelection).asset;
      registry.assets[asset] = structuredClone(preparedAssets[asset]);
    }
    payload.clips = structuredClone(nextConfig.clips);
    document.parent_revision.revision_id = revision;
    document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
    response.data.canonical_document = document;
    response.data.document_digest = fixtureDigest(document);
    Object.assign(response.data, { status: 'accepted', merge_mode: request.merge, steps: request.steps, label: request.label, source: request.source });
    response.receipt.idempotency_key = key;
    response.receipt.result = response.data;
    basis = { head: { revisionId: revision, publicationId: `p-${revision}` }, canonicalDocument: document };
    return { response, accepted: basis.head, canonicalDocument: document, graph: {}, receipt: response.receipt };
  });
  const provider: DataProvider & Pick<RuntimeDataProvider, 'getProjectMediaSelection'> = {
    loadTimeline: vi.fn(async () => ({ config, configVersion: 1, head: initialData.head })),
    loadAssetRegistry: vi.fn(async () => ({ assets: {} })), resolveAssetUrl: async file => file,
    saveTimeline: vi.fn(), loadTimelineCommandBasis: vi.fn(async () => structuredClone(basis)),
    getRecoverableIdentity: async () => ({ realmId: 'realm', actorId: 'actor' }), commitTimeline: commit,
    loadGenerationForLightbox: runtime.loadGenerationForLightbox.bind(runtime),
    getProjectMediaSelection: runtime.getProjectMediaSelection.bind(runtime),
  };
  if (stage) writePendingAdds(ids);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<MemoryRouter initialEntries={[`/?timeline=${timelineId}&${ADD_GENERATION_QUERY_PARAM}=${ids[0]}`]}>
    <QueryClientProvider client={client}><AgentChatProvider>
      <VideoEditorProvider dataProvider={provider} projectId={projectId} timelineId={timelineId} userId={null} initialTimelineData={initialData}>
        <Consumer />
      </VideoEditorProvider>
    </AgentChatProvider></QueryClientProvider>
  </MemoryRouter>);
  return { view, commit, provider, calls, selections, release, getEditor: () => editor, getChrome: () => chrome, getLocation: () => location };
}

describe('mounted provider staged generation persistence', () => {
  it('drains URL and staged images once, in timeline order, through prepared media and the v2 outbox', async () => {
    const descriptors = [...MEDIA_COMMAND_DESCRIPTORS, PLACE_PREPARED_MEDIA_COMMAND_DESCRIPTOR];
    const executions = descriptors.flatMap(descriptor => [vi.spyOn(descriptor, 'apply'), vi.spyOn(descriptor, 'dryRun')]);
    const mounted = await mountStaged(['first', 'second']);
    try {
      await act(async () => { mounted.release(); });
      await waitFor(() => expect(readPendingAdds()).toEqual([]));
      const clips = mounted.getEditor().dataRef.current!.config.clips;
      expect(clips).toEqual([
        expect.objectContaining({ id: 'existing', at: 0, hold: 2, text: { content: 'Keep me' } }),
        expect.objectContaining({ asset: 'variant-first', at: 2, hold: 5, track: 'V1' }),
        expect.objectContaining({ asset: 'variant-second', at: 7, hold: 5, track: 'V1' }),
      ]);
      expect(mounted.getEditor().selectedClipId).toBe(clips[2].id);
      expect(mounted.getEditor().selectedTrackId).toBe('V1');
      expect(mounted.getEditor().dataRef.current!.registry.assets['variant-first']).toMatchObject({
        generationId: 'first', variantId: 'variant-first', name: 'Name first', prompt: 'Preserve prompt', type: 'image/png',
      });
      await act(async () => { await mounted.getChrome().flushPendingSave(); });
      expect(mounted.commit).toHaveBeenCalled();
      const requests = mounted.commit.mock.calls.map(([request]) => request);
      expect(requests.flatMap(request => request.commands).map(command => command.op)).toEqual(['clip.add-media', 'clip.add-media']);
      expect(requests.flatMap(request => request.commands).map(command => command.args.media)).toEqual([
        mounted.selections.get('first'), mounted.selections.get('second'),
      ]);
      for (const [request, key] of mounted.commit.mock.calls) {
        expect(request).toMatchObject({ api_version: 1, project_id: projectId, timeline_id: timelineId,
          base_revision_id: expect.any(String), base_publication_id: expect.any(String), merge: 'fields', dry_run: false, source: { via: 'app' } });
        expect(request.commands.every(command => JSON.stringify(command.intent) === '{}')).toBe(true);
        expect(key).toEqual(expect.any(String));
      }
      expect(mounted.provider.saveTimeline).not.toHaveBeenCalled();
      expect(mounted.calls.filter(path => path === '/v1/generations/first')).toHaveLength(1);
      expect(mounted.calls.filter(path => path === '/v1/generations/second')).toHaveLength(1);
      expect(new URLSearchParams(mounted.getLocation().search).has(ADD_GENERATION_QUERY_PARAM)).toBe(false);
      executions.forEach(execution => expect(execution).not.toHaveBeenCalled());
      expect(mounted.getEditor().dataRef.current?.config.clips).toEqual(clips);
    } finally { mounted.view.unmount(); }
  });

  it.each(['asset', 'generation_id', 'variant_id', 'object_id'] as const)('refuses a mismatched Runtime %s before placement', async field => {
    const notice = vi.spyOn(toast, 'error');
    const mounted = await mountStaged(['first'], async selection => ({ ...selection, [field]: 'mismatched' }));
    try {
      await act(async () => { mounted.release(); });
      await waitFor(() => expect(readPendingAdds()).toEqual([]));
      expect(mounted.getEditor().dataRef.current?.config.clips).toHaveLength(1);
      expect(mounted.getEditor().dataRef.current?.registry.assets).toEqual({});
      expect(mounted.commit).not.toHaveBeenCalled();
      expect(notice).toHaveBeenCalledWith('Runtime media selection does not match the loaded generation. Import the media again.');
    } finally { mounted.view.unmount(); }
  });

  it('retains a staged item when the provider unmounts during selection so another mount can retry', async () => {
    let resolveSelection!: (selection: MediaSelection) => void;
    let captured!: MediaSelection;
    const mounted = await mountStaged(['first'], selection => {
      captured = selection;
      return new Promise(resolve => { resolveSelection = resolve; });
    });
    await act(async () => { mounted.release(); });
    await waitFor(() => expect(resolveSelection).toBeDefined());
    mounted.view.unmount();
    await act(async () => { resolveSelection(captured); });
    expect(readPendingAdds()).toEqual(['first']);
    expect(mounted.commit).not.toHaveBeenCalled();
    const retry = await mountStaged(['first'], undefined, false);
    try {
      await act(async () => { retry.release(); });
      await waitFor(() => expect(readPendingAdds()).toEqual([]));
      expect(retry.getEditor().dataRef.current?.config.clips).toHaveLength(2);
      await act(async () => { await retry.getChrome().flushPendingSave(); });
      expect(retry.commit).toHaveBeenCalledOnce();
    } finally { retry.view.unmount(); }
  });
});


async function mountElement(outcome: 'accepted' | 'merged' | 'conflict' | 'invalid' = 'accepted') {
  const config = { ...createDefaultTimelineConfig(), output: { fps: 30, resolution: null, file: null },
    clips: [{ id: 'parent', track: 'V1', at: 0, hold: 2, opaque: { keep: null } },
      { id: 'sibling', track: 'V1', at: 3, hold: 2 }], opaque: { absent: null } } as unknown as TimelineConfig;
  const base = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' },
    { projectId, timelineId, children: true }).data.canonical_document;
  const registry = { assets: {}, opaque: { keep: null } };
  base.parent_revision.payload = { ...base.parent_revision.payload, config, clips: config.clips, registry };
  base.parent_revision.content_digest = fixtureDigest(base.parent_revision.payload);
  let basis: TimelineCommandBasis = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: base };
  const initialData = await buildTimelineData({ ...config, ...withDefaultTimelineOutput(config) }, registry, async file => file, 1, undefined,
    { projectId, timelineId, headRevisionId: 'r0', headPublicationId: 'p0' });
  let editor!: ReturnType<typeof useTimelineEditorData>;
  let chat!: ReturnType<typeof useAgentChatBridge>;
  let ops!: ReturnType<typeof useTimelineEditorOps>;
  function Consumer() {
    editor = useTimelineEditorData(); chat = useAgentChatBridge(); ops = useTimelineEditorOps();
    return null;
  }
  const commit = vi.fn<NonNullable<DataProvider['commitTimeline']>>(async (request, key) => {
    if (outcome === 'conflict' || outcome === 'invalid') throw new ApiError(outcome === 'conflict' ? 409 : 422,
      outcome, 'Element dependency changed', '', { status: outcome, reason: 'dependency_changed', head: basis.head,
        code: 'element_invalid', path: ['config', 'clips'], hint: 'Read latest', suggested_command: 'timeline.show' });
    const document = structuredClone(basis.canonicalDocument);
    for (const command of request.commands) {
      expect(command.op).toBe('doc.patch');
      for (const change of command.args.changes as Array<{ op: string; path: string[]; value?: unknown }>) {
        let target: unknown = document.parent_revision.payload;
        for (const part of change.path.slice(0, -1)) target = part.startsWith('id:')
          ? (target as Array<{ id: string }>).find(row => row.id === part.slice(3)) : (target as Record<string, unknown>)[part];
        const key = change.path.at(-1)!;
        if (change.op === 'remove') delete (target as Record<string, unknown>)[key];
        else (target as Record<string, unknown>)[key] = structuredClone(change.value);
      }
    }
    // The Runtime's canonical result, including unrelated landed edits, wins.
    const raw = document.parent_revision.payload.config as unknown as TimelineConfig;
    raw.clips[0].hold = 4;
    if (outcome === 'merged') raw.clips[1].at = 9;
    document.parent_revision.payload.clips = structuredClone(raw.clips);
    document.parent_revision.revision_id = 'r1';
    document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
    const response = acceptedCommit({ revision_id: 'r1', publication_id: 'p1' },
      { revision_id: request.base_revision_id, publication_id: request.base_publication_id }, { projectId, timelineId, commands: request.commands });
    Object.assign(response.data, { status: outcome, canonical_document: document, document_digest: fixtureDigest(document),
      merge_mode: request.merge, steps: request.steps, label: request.label, source: request.source });
    response.receipt.idempotency_key = key; response.receipt.result = response.data;
    basis = { head: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: document };
    return { response, accepted: basis.head, canonicalDocument: document, graph: {}, receipt: response.receipt };
  });
  const provider: DataProvider = { loadTimeline: vi.fn(async () => ({ config: initialData.config, configVersion: 1, head: initialData.head })),
    loadAssetRegistry: vi.fn(async () => initialData.registry), resolveAssetUrl: async file => file, saveTimeline: vi.fn(), saveTimelineAtHead: vi.fn(),
    loadTimelineCommandBasis: vi.fn(async () => structuredClone(basis)), getRecoverableIdentity: async () => ({ realmId: 'realm', actorId: 'actor' }), commitTimeline: commit };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<MemoryRouter><QueryClientProvider client={client}><AgentChatProvider>
    <VideoEditorProvider dataProvider={provider} projectId={projectId} projectSlug="element-project" timelineId={timelineId} userId={null}>
      <Consumer />
    </VideoEditorProvider>
  </AgentChatProvider></QueryClientProvider></MemoryRouter>);
  await waitFor(() => expect(chat.editorContext?.elementOperationAdapter).toBeDefined());
  await waitFor(() => expect(chat.editorContext?.timelineSummary).toMatchObject({ configVersion: 1 }));
  const entry = chat.editorContext!.elementContext!.catalog.find(item => item.id === 'text-card' && item.packId === 'rendering')!;
  expect(entry.admitted).toBe(true);
  return { view, provider, commit, base, getBasis: () => basis, getEditor: () => editor, getOps: () => ops,
    capture: () => chat.editorContext!.elementOperationAdapter!.captureForTurn(),
    operation: { name: 'timeline.apply_element', project: 'element-project', timeline: timelineId, expected_version: 1, clip_id: 'parent', placement: 'clip',
      element: { id: entry.id, kind: entry.kind, packId: entry.packId, revision: entry.revision }, params: { color: 'red' } } };
}


describe('registered parent element outbox handoff', () => {
  it.each(['accepted', 'merged', 'conflict', 'invalid'] as const)('saves a child-bearing parent with a retained original basis: %s', async outcome => {
    const mounted = await mountElement(outcome);
    try {
      let result: unknown;
      await act(async () => {
        const pending = mounted.capture().execute(mounted.operation);
        if (outcome === 'conflict' || outcome === 'invalid') await expect(pending).rejects.toThrow('draft retained');
        else result = await pending;
      });
      expect(mounted.commit).toHaveBeenCalledOnce();
      const [request, key] = mounted.commit.mock.calls[0];
      expect(request).toMatchObject({ api_version: 1, project_id: projectId, timeline_id: timelineId,
        base_revision_id: 'r0', base_publication_id: 'p0', label: 'Edit timeline', merge: 'atomic', dry_run: false, source: { via: 'app' },
        steps: [{ id: expect.any(String), label: 'Edit timeline', intent: 'timeline.apply_element', tags: [], command_ordinals: [0], patch: expect.any(Array) }],
        reads: expect.arrayContaining([{ kind: 'field', ref: 'parent', path: ['config', 'clips', 'id:parent', 'params'],
          state: { state: 'absent' } }]) });
      expect(key).toEqual(expect.any(String));
      expect(request.steps![0].patch).toEqual(request.commands[0].args.changes);
      const outboxes = createCommitOutbox({ indexedDB, exclusiveLock: async (_key, work) => work() });
      const [stored] = await outboxes.list({ realmId: 'realm', actorId: 'actor', projectId, timelineId });
      if (outcome === 'conflict' || outcome === 'invalid') {
        expect(stored.intents).toHaveLength(1);
        expect(stored.pending?.outcome).toMatchObject({ kind: 'rejected', error: { details: { reason: 'dependency_changed' } } });
        expect(mounted.getEditor().dataRef.current?.config.clips[0].elementRef).toBeUndefined();
      } else {
        expect(stored.intents).toHaveLength(0);
        expect(result).toMatchObject({ head: { headRevisionId: 'r1', headPublicationId: 'p1' }, config: { clips: [
          expect.objectContaining({ id: 'parent', hold: 4, elementRef: mounted.operation.element, params: { color: 'red' } }),
          expect.objectContaining({ id: 'sibling', at: outcome === 'merged' ? 9 : 3 }),
        ] } });
        const document = mounted.getBasis().canonicalDocument;
        expect(document.shot_revisions).toEqual(mounted.base.shot_revisions);
        expect(document.internal_timeline_revisions).toEqual(mounted.base.internal_timeline_revisions);
        expect(document.parent_revision.payload.occurrences).toEqual(mounted.base.parent_revision.payload.occurrences);
        expect(document.parent_revision.payload.registry).toEqual(mounted.base.parent_revision.payload.registry);
        expect(document.parent_revision.payload.registry).toHaveProperty('opaque.keep', null);
        expect(document.parent_revision.payload.config.output).toEqual({ fps: 30, resolution: null, file: null });
        expect(document.parent_revision.payload.config.clips[0].opaque).toEqual({ keep: null });
        expect(document.parent_revision.payload.config.clips[0]).not.toHaveProperty('asset');
      }
      expect(mounted.provider.saveTimeline).not.toHaveBeenCalled();
      expect(mounted.provider.saveTimelineAtHead).not.toHaveBeenCalled();
    } finally { mounted.view.unmount(); }
  });

  it('refuses a captured turn after a local dependent preview changes under the same head', async () => {
    const mounted = await mountElement();
    try {
      const captured = mounted.capture();
      await act(async () => { const current = mounted.getEditor().dataRef.current!;
        // Model an upstream gesture before this captured turn executes.
        const resolvedConfig = structuredClone(current.resolvedConfig);
        resolvedConfig.clips[0].at = 7;
        mounted.getOps().applyEdit({ type: 'config', resolvedConfig }, { save: false });
      });
      await act(async () => { await expect(captured.execute(mounted.operation)).rejects.toThrow('captured local timeline changed'); });
      expect(mounted.commit).not.toHaveBeenCalled();
      expect(mounted.provider.saveTimeline).not.toHaveBeenCalled();
    } finally { mounted.view.unmount(); }
  });
});

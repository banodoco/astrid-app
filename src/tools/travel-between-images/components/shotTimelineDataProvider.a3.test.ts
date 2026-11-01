// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import fixture from '@/tools/video-editor/data/shotComposition.fixture.json';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { ApiError } from '@/integrations/runtime/generated.ts';
import { RuntimeDataProvider } from '@/integrations/runtime/dataProvider.ts';
import { json, runtimeFixture } from '@/test/fakeWorkspaceRuntime.ts';
import { createShotCompositionAdapter } from '@/tools/video-editor/data/shotCompositionAdapter.ts';
import { projectCanonicalComposition } from '@/tools/video-editor/data/shotCompositionProjection.ts';
import type { DataProvider, TimelineCommandBasis, TimelineCommitResult } from '@/tools/video-editor/data/DataProvider.ts';
import type { CanonicalDocument, CommitRequest, MediaSelection, MediaSelectionQuery } from '@/integrations/runtime/timeline-commit-types.ts';
import { createCommitOutbox, type OutboxRecord } from '@/tools/video-editor/commands/commitOutbox.ts';
import { createShotTimelineDataProvider, createShotTimelineInitialData, projectShotTimelineRenderConfig } from './shotTimelineDataProvider.ts';
import { buildTimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import { TimelineSaveError } from '@/tools/video-editor/data/DataProvider.ts';

function canonicalDocument(): CanonicalDocument {
  const occurrence = fixture.occurrences.find((value) => value.occurrence_id === 'occ-3')!;
  const shot = fixture.shot_revisions.find((value) => value.shot_id === 'shot-alpha' && value.revision_id === 'rev-b')!;
  const internal = shot.internal_timeline_revision;
  const timeline = structuredClone(internal.timeline);
  const rawClip = timeline.clips.find((value) => value.id === 'alpha-video-b')!;
  Object.assign(rawClip, {
    params: null,
    effects: null,
    keyframes: null,
    text: null,
    elementRef: null,
    app: {
      ...rawClip.app,
      opaqueFutureState: { preserve: null },
    },
  });
  return {
    schema_version: 1,
    project_id: 'project-001',
    timeline_id: 'document-primary',
    parent_revision: {
      revision_id: fixture.primary_timeline.head.revision_id,
      content_digest: 'sha256:parent',
      payload: {
        config: { clips: [], tracks: [] },
        occurrences: [{
          occurrence_id: occurrence.occurrence_id,
          shot_id: occurrence.shot_id,
          shot_revision_id: occurrence.revision_id,
        }],
      },
    },
    shot_revisions: [{
      shot_id: shot.shot_id,
      revision_id: shot.revision_id,
      internal_timeline_revision_id: internal.revision_id,
      content_digest: 'sha256:shot',
      payload: { name: 'raw-shot', internal_timeline_revision_id: internal.revision_id },
    }],
    internal_timeline_revisions: [{
      timeline_id: 'timeline-alpha',
      revision_id: internal.revision_id,
      content_digest: internal.content_digest,
      payload: timeline,
    }],
    dependency_manifest: {
      shots: [{ shot_id: shot.shot_id, revision_id: shot.revision_id,
        internal_timeline_revision_id: internal.revision_id, content_digest: 'sha256:shot' }],
      internal_timelines: [{ timeline_id: 'timeline-alpha', revision_id: internal.revision_id, content_digest: internal.content_digest }],
      media: [], documents: [],
    },
  } as CanonicalDocument;
}

const scope = { actorId: 'actor-a3', realmId: 'realm-a3', projectId: 'project-001', timelineId: 'document-primary' };
const internalRef = 'internal-revision:timeline-alpha-b';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: createFakeIndexedDB() });
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}) },
  });
});

function harness(before = canonicalDocument(), graph = fixture) {
  const oldPublish = vi.fn();
  const adapter = createShotCompositionAdapter({ load: vi.fn(), publish: oldPublish });
  const composition = adapter.prepare(graph);
  const occurrence = composition.occurrences.find((value) => value.occurrenceId === 'occ-3')!;
  const config = projectCanonicalComposition({ ...composition, occurrences: [occurrence] }).config;
  const initial: TimelineCommandBasis = {
    head: { revisionId: fixture.primary_timeline.head.revision_id, publicationId: 'pub-0' },
    canonicalDocument: before, graph,
  };
  const outboxes = createCommitOutbox();
  const send = vi.fn<(request: CommitRequest, key: string) => Promise<TimelineCommitResult>>();
  const load = vi.fn(async () => initial);
  const transport = { loadTimelineCommandBasis: load,
    getRecoverableIdentity: vi.fn(async () => scope), commitTimeline: send } as DataProvider & {
      getProjectMediaSelection?: (query: MediaSelectionQuery) => Promise<MediaSelection>;
    };
  const published = vi.fn();
  const mount = (timelineDataProvider: DataProvider = transport) => createShotTimelineDataProvider(config, composition, occurrence.occurrenceId,
    adapter, published, undefined, 0, undefined, timelineDataProvider);
  const records = () => outboxes.list(scope);
  const add = () => {
    const { app: _app, ...base } = config.clips[0];
    return { ...config, clips: [...config.clips, { ...base, id: 'popup-added-a3', at: config.clips[0].at + 1 }] };
  };
  const reply = (request: CommitRequest, key: string, document: CanonicalDocument,
    status: 'accepted' | 'merged' = 'accepted'): TimelineCommitResult => {
    const response = acceptedCommit({ revision_id: 'rev-a3-accepted', publication_id: 'pub-a3-accepted' },
      { revision_id: request.base_revision_id, publication_id: request.base_publication_id },
      { projectId: scope.projectId, timelineId: scope.timelineId, commands: request.commands });
    const canonical = structuredClone(document);
    canonical.parent_revision.revision_id = 'rev-a3-accepted';
    Object.assign(response.data, { status, canonical_document: canonical, document_digest: fixtureDigest(canonical),
      merge_mode: 'atomic', steps: request.steps!.map((step) => ({ ...step, dependencies: request.reads })),
      ...(status === 'merged' ? { previous_revision_id: 'rev-agent', previous_publication_id: 'pub-agent',
        rebased_onto: { revision_id: 'rev-agent', publication_id: 'pub-agent' } } : {}) });
    response.receipt.idempotency_key = key;
    response.receipt.request_hash = fixtureDigest({ operation: 'commitTimeline',
      path: `/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`, publisher: response.data.publisher, request }).slice(7);
    response.receipt.result = response.data;
    const graph = structuredClone(fixture);
    graph.primary_timeline.head.revision_id = 'rev-a3-accepted';
    // This fixture supplies the authoritative graph; the App never executes a patch.
    if (status === 'merged') graph.shot_revisions.find((shot) => shot.revision_id === 'rev-b')!.provenance.source = 'agent-change';
    return { response, accepted: { revisionId: 'rev-a3-accepted', publicationId: 'pub-a3-accepted' },
      canonicalDocument: canonical, graph, receipt: response.receipt };
  };
  return { adapter, oldPublish, composition, config, initial, before, send, load, mount, published, records, reply, add, transport };
}

function savedDocument(record: OutboxRecord): CanonicalDocument {
  return (record.intents[0].payload as unknown as { after: CanonicalDocument }).after;
}

describe('shot popup A3 save ingress', () => {
  it('keeps initial-load and reload rendering in parity with film effects and child Source visuals', async () => {
    const graph = structuredClone(fixture);
    const shot = graph.shot_revisions.find((value) => value.revision_id === 'rev-b')!;
    const timeline = shot.internal_timeline_revision.timeline;
    const clipEffects = [{ type: 'blur', params: { radius: 2 } }];
    const shotEffects = [{ type: 'brightness', params: { amount: 0.5 } }];
    Object.assign(timeline, { effects: shotEffects });
    Object.assign(timeline.tracks[0], { role: 'source' });
    Object.assign(timeline.clips[0], { effects: clipEffects });
    const before = canonicalDocument();
    before.internal_timeline_revisions[0].payload = structuredClone(timeline);
    const h = harness(before, graph);
    vi.spyOn(h.adapter, 'load').mockResolvedValue(h.composition);
    const provider = h.mount();
    const initial = createShotTimelineInitialData(h.config, 1, h.composition, 'occ-3');
    const originalGraph = structuredClone(graph);
    try {
      const reload = await provider.loadCanonicalTimeline!('popup-timeline');
      const rebuilt = await buildTimelineData(reload.config, await provider.loadAssetRegistry(), provider.resolveAssetUrl);
      for (const data of [initial, rebuilt]) {
        expect(data.config.effects).toEqual(shotEffects);
        expect(data.config.clips[0]).toMatchObject({ id: 'alpha-video-b', effects: clipEffects });
        expect(data.config.tracks[0]).toMatchObject({ id: 'video', role: 'source' });
        const render = projectShotTimelineRenderConfig(data.resolvedConfig);
        expect(render.clips[0].effects).toEqual(h.config.clips[0].effects);
        expect(render.clips[0].effects).toEqual([...clipEffects, ...shotEffects]);
        expect(render.tracks[0]).toMatchObject({ id: 'video', role: 'output' });
        expect(render.effects).toBeUndefined();
        expect(data.config.clips[0].effects).toEqual(clipEffects);
        expect(data.config.tracks[0].role).toBe('source');
      }
      h.send.mockImplementation(async (request, key) => h.reply(request, key, savedDocument((await h.records())[0])));
      await provider.saveTimeline('popup-timeline', {
        ...initial.config, clips: initial.config.clips.map((clip) => ({ ...clip, label: 'Authored edit' })),
      }, 1, initial.registry);
      const [request] = h.send.mock.calls[0];
      expect(request.commands[0].args.changes).toEqual([{
        op: 'set', ref: internalRef, path: ['clips', 'id:alpha-video-b', 'label'],
        before: { state: 'absent' }, value: 'Authored edit',
      }]);
      expect(graph).toEqual(originalGraph);
    } finally { await provider.dispose(); }
  });

  it.each(['add', 'replace'] as const)('resolves the accepted %s asset after canonical reload/discard', async (kind) => {
    const h = harness();
    h.before.internal_timeline_revisions[0].payload.registry = { assets: JSON.parse(JSON.stringify(h.config.registry)) };
    const provider = h.mount();
    const loaded = await provider.loadTimeline('popup-timeline');
    const originalAsset = loaded.config.clips[0].asset!;
    const asset = kind === 'add' ? 'popup-added-asset' : originalAsset;
    const objectId = `sha256:${'a'.repeat(64)}`;
    const registryBefore = await provider.loadAssetRegistry();
    const nextRegistry = { ...registryBefore,
      assets: { ...registryBefore.assets, [asset]: { file: objectId, type: 'video' } } };
    const next = { ...loaded.config, clips: kind === 'add'
      ? [...loaded.config.clips, { ...loaded.config.clips[0], id: 'added-asset-clip', asset }]
      : loaded.config.clips.map((clip) => ({ ...clip, label: 'Replaced media' })) };
    h.send.mockImplementation(async (request, key) => {
      const accepted = h.reply(request, key, savedDocument((await h.records())[0]));
      const shot = accepted.graph!.shot_revisions.find((value) => value.revision_id === 'rev-b')!;
      const canonicalAsset = { ...shot.assets[0], asset_id: asset, object_id: objectId };
      shot.assets = kind === 'add' ? [...shot.assets, canonicalAsset] : [canonicalAsset];
      if (kind === 'add') {
        const timeline = shot.internal_timeline_revision.timeline;
        timeline.clips.push({ ...timeline.clips[0], id: 'added-asset-clip', asset_id: asset });
      }
      vi.spyOn(h.adapter, 'load').mockResolvedValue(h.adapter.prepare(accepted.graph!));
      return accepted;
    });
    try {
      await expect(provider.saveTimeline('popup-timeline', next, 1, nextRegistry)).resolves.toBe(2);
      expect((await provider.loadAssetRegistry()).assets[asset]).toMatchObject({ file: objectId });
      const reload = await provider.loadCanonicalTimeline!('popup-timeline');
      const registry = await provider.loadAssetRegistry();
      const data = await buildTimelineData(reload.config, registry, provider.resolveAssetUrl);
      expect(registry.assets[asset]).toMatchObject({ file: objectId, media_id: objectId });
      expect(data.resolvedConfig.clips.find((clip) => clip.asset === asset)?.assetEntry).toMatchObject({
        src: `/api/astrid/v1/objects/${encodeURIComponent(objectId)}`,
      });
      expect(reload.config.clips.some((clip) => clip.asset === asset)).toBe(true);
    } finally { await provider.dispose(); }
  });

  it('captures dependent popup edits into the persisted owner before any flush or legacy save', async () => {
    const h = harness();
    const provider = h.mount();
    const legacy = vi.spyOn(provider, 'saveTimeline');
    const first = h.add();
    const dependent = { ...first, clips: first.clips.map(clip => clip.id === 'popup-added-a3'
      ? { ...clip, label: 'Captured dependent' } : clip) };
    try {
      const captured = provider.localDocumentSave!.capture({ head: { projectId: scope.projectId, timelineId: scope.timelineId,
        headRevisionId: h.initial.head.revisionId, headPublicationId: h.initial.head.publicationId }, config: first, registry: (await provider.loadAssetRegistry()) });
      first.clips.at(-1)!.id = 'mutated-after-capture';
      await captured;
      await provider.localDocumentSave!.capture({ head: { projectId: scope.projectId, timelineId: scope.timelineId,
        headRevisionId: h.initial.head.revisionId, headPublicationId: h.initial.head.publicationId }, config: dependent, registry: (await provider.loadAssetRegistry()) });
      const [record] = await h.records();
      expect(record.intents).toHaveLength(2);
      expect(record.intents[0].basis).toEqual({ head: h.initial.head });
      expect(record.intents[1].basis).toEqual({ after: record.intents[0].id });
      const document = savedDocument(record);
      expect(document.parent_revision).toEqual(h.before.parent_revision);
      expect(document.shot_revisions).toEqual(h.before.shot_revisions);
      expect(document.dependency_manifest).toEqual(h.before.dependency_manifest);
      expect(JSON.stringify(record)).toContain('popup-added-a3');
      expect(JSON.stringify(record)).not.toContain('mutated-after-capture');
      expect(h.send).not.toHaveBeenCalled();
      h.send.mockImplementation(async (request, key) => h.reply(request, key, savedDocument((await h.records())[0])));
      await provider.localDocumentSave!.flush();
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.send.mock.calls[1][0]).toMatchObject({ base_revision_id: 'rev-a3-accepted', base_publication_id: 'pub-a3-accepted' });
      expect(h.send.mock.calls[1][0].commands[0].args.changes).toEqual([{ op: 'set', ref: internalRef,
        path: ['clips', 'id:popup-added-a3', 'label'], before: { state: 'absent' }, value: 'Captured dependent' }]);
      expect(legacy).not.toHaveBeenCalled();
    } finally { await provider.dispose(); }
  });

  it.each(['missing', 'project', 'timeline', 'revision', 'publication'] as const)(
    'refuses a %s source head before popup outbox admission', async (kind) => {
      const h = harness();
      const provider = h.mount();
      const head = { projectId: scope.projectId, timelineId: scope.timelineId,
        headRevisionId: h.initial.head.revisionId, headPublicationId: h.initial.head.publicationId };
      if (kind === 'project') head.projectId = 'another-project';
      if (kind === 'timeline') head.timelineId = 'another-timeline';
      if (kind === 'revision') head.headRevisionId = 'another-revision';
      if (kind === 'publication') head.headPublicationId = 'another-publication';
      try {
        const expectedCode = kind === 'revision' || kind === 'publication'
          ? 'timeline_version_conflict' : 'timeline_save_refused';
        await expect(provider.localDocumentSave!.capture({ config: h.add(),
          registry: await provider.loadAssetRegistry(), head: kind === 'missing' ? undefined : head }))
          .rejects.toMatchObject({ code: expectedCode, message: expect.stringContaining('Popup canonical') });
        expect((await h.records()).flatMap(record => record.intents)).toEqual([]);
        expect(h.send).not.toHaveBeenCalled();
        expect(h.oldPublish).not.toHaveBeenCalled();
      } finally { await provider.dispose(); }
    },
  );

  it.each(['scope', 'projection'] as const)('refuses an unbound %s despite a matching parent head', async (kind) => {
    const h = harness();
    if (kind === 'scope') {
      (h.before.parent_revision.payload.occurrences as Array<Record<string, unknown>>)[0].occurrence_id = 'another-occurrence';
    } else {
      h.before.internal_timeline_revisions[0].content_digest = 'sha256:another-physical-image';
      h.before.dependency_manifest.internal_timelines[0].content_digest = 'sha256:another-physical-image';
    }
    const provider = h.mount();
    try {
      await expect(provider.localDocumentSave!.capture({ config: h.add(), registry: await provider.loadAssetRegistry(),
        head: { projectId: scope.projectId, timelineId: scope.timelineId,
          headRevisionId: h.initial.head.revisionId, headPublicationId: h.initial.head.publicationId } }))
        .rejects.toThrow(kind === 'scope' ? 'unique physical occurrence binding' : 'verified physical closure pin');
      expect((await h.records()).flatMap(record => record.intents)).toEqual([]);
      expect(h.send).not.toHaveBeenCalled();
      expect(h.oldPublish).not.toHaveBeenCalled();
    } finally { await provider.dispose(); }
  });

  it('retains a popup edit with a concrete basis need when the verified publication pin is missing', async () => {
    const h = harness();
    h.initial.head.publicationId = '';
    const provider = h.mount();
    try {
      await expect(provider.localDocumentSave!.capture({ config: h.add(), registry: await provider.loadAssetRegistry() }))
        .rejects.toBeInstanceOf(TimelineSaveError);
      expect(h.send).not.toHaveBeenCalled();
      expect(await h.records()).toEqual([]);
    } finally { await provider.dispose().catch(() => {}); }
  });

  it.each(['add', 'swap'] as const)('preserves the real Runtime provider receiver for shared media %s', async (kind) => {
    const before = canonicalDocument();
    const occurrences = before.parent_revision.payload.occurrences as Array<Record<string, unknown>>;
    occurrences.push({ ...occurrences[0], occurrence_id: 'occ-sibling' });
    const h = harness(before);
    const originalAsset = h.config.clips[0].asset;
    const replacementAsset = 'popup-shared-replacement';
    h.config.registry[originalAsset] = { ...h.config.registry[originalAsset], generationId: 'generation-old', variantId: 'variant-old' };
    h.config.registry[replacementAsset] = { file: replacementAsset, type: 'image', generationId: 'generation-new', variantId: 'variant-new' };
    const runtime = runtimeFixture({ projectId: scope.projectId, timelineId: scope.timelineId });
    const selections: MediaSelectionQuery[] = [];
    const runtimeProvider = new RuntimeDataProvider({
      projectId: scope.projectId,
      transport: async (method, path, headers, body) => {
        const url = new URL(path, 'http://runtime.test');
        if (method === 'GET' && url.pathname === `/v1/projects/${scope.projectId}/media-selection`) {
          const query = Object.fromEntries(url.searchParams) as MediaSelectionQuery;
          selections.push(query);
          return { status: 200, headers: {}, body: json({ ...query,
            object_id: `sha256:${'1'.repeat(64)}`, catalog_digest: `sha256:${'2'.repeat(64)}` }) };
        }
        return runtime.transport(method, path, headers, body);
      },
    });
    // Keep the canonical basis/replies controlled; leave the media method and
    // its authenticated Runtime client intact so an unbound call fails here.
    vi.spyOn(runtimeProvider, 'loadTimelineCommandBasis').mockImplementation(h.load);
    vi.spyOn(runtimeProvider, 'getRecoverableIdentity').mockResolvedValue(scope);
    vi.spyOn(runtimeProvider, 'commitTimeline').mockImplementation(h.send);
    let captured!: OutboxRecord;
    h.send.mockImplementation(async (request, key) => {
      [captured] = await h.records();
      expect(JSON.parse(captured.pending!.request.body)).toEqual(request);
      expect(captured.pending!.request.key).toBe(key);
      return JSON.parse(JSON.stringify(h.reply(request, key, savedDocument(captured))));
    });
    const provider = h.mount(runtimeProvider);
    const next = kind === 'add' ? h.add()
      : { ...h.config, clips: h.config.clips.map((clip, index) => index === 0
        ? { ...clip, asset: replacementAsset } : clip) };
    try {
      await expect(provider.saveTimeline('popup-timeline', next, 1)).resolves.toBe(2);
      expect(selections).toContainEqual({ asset: kind === 'add' ? originalAsset : replacementAsset,
        generation_id: kind === 'add' ? 'generation-old' : 'generation-new',
        variant_id: kind === 'add' ? 'variant-old' : 'variant-new' });
      expect(runtime.requests.map(({ path }) => path)).toContain('/v1/handshake');
      expect(h.send).toHaveBeenCalledTimes(1);
      const [request] = h.send.mock.calls[0];
      expect(request.commands.map(({ op }) => op)).toEqual([
        'occurrence.fork', kind === 'add' ? 'occurrence.add-media' : 'occurrence.swap-media',
      ]);
      expect(request.commands[0].select).toBe('occurrence:occ-3');
      expect(request.commands[1].select).not.toContain('occ-3:');
      if (kind === 'add') {
        const row = request.commands[1].args.row as Record<string, unknown>;
        expect(row.id).toBe('popup-added-a3');
        expect(row.track).not.toContain('~');
        expect(row).not.toHaveProperty('app.group');
      }
      expect(captured.intents[0].payload).toMatchObject({ commands: request.commands });
      expect(provider.getTimelineDraftRecoveryMetadata()).toMatchObject({ baseHeadRevisionId: 'rev-a3-accepted' });
      expect(h.oldPublish).not.toHaveBeenCalled();
    } finally {
      await provider.dispose();
    }
  });

  it('uses the registered occurrence media carrier for an unshared child ADD', async () => {
    const h = harness();
    const asset = h.config.clips[0].asset;
    h.config.registry[asset] = { ...h.config.registry[asset], generationId: 'generation-old', variantId: 'variant-old' };
    const selection = { asset, generation_id: 'generation-old', variant_id: 'variant-old',
      object_id: `sha256:${'1'.repeat(64)}`, catalog_digest: `sha256:${'2'.repeat(64)}` };
    h.transport.getProjectMediaSelection = vi.fn(async (query: MediaSelectionQuery) => ({ ...query,
      object_id: selection.object_id, catalog_digest: selection.catalog_digest }));
    let captured!: OutboxRecord;
    h.send.mockImplementation(async (request, key) => {
      [captured] = await h.records();
      return JSON.parse(JSON.stringify(h.reply(request, key, savedDocument(captured))));
    });
    const provider = h.mount();
    try {
      await expect(provider.saveTimeline('popup-timeline', h.add(), 1)).resolves.toBe(2);
      expect(h.transport.getProjectMediaSelection).toHaveBeenCalledWith({ asset,
        generation_id: 'generation-old', variant_id: 'variant-old' });
      const [request] = h.send.mock.calls[0];
      expect(request).toMatchObject({ base_revision_id: h.initial.head.revisionId, base_publication_id: 'pub-0',
        source: { via: 'app' }, label: 'Edit shot timeline', merge: 'fields', dry_run: false,
        commands: [{ schema_version: 1, op: 'occurrence.add-media', version: '1', select: 'occurrence:occ-3',
          intent: { ownership: 'occurrence' }, created: ['occurrence:occ-3/clip:popup-added-a3'] }] });
      expect(request.commands).toHaveLength(1);
      expect(request.commands[0].args).toEqual({ row: expect.objectContaining({ id: 'popup-added-a3', asset,
        clipType: 'media' }), media: selection });
      expect(request.commands[0].args.row).not.toHaveProperty('asset_id');
      expect(request.steps).toEqual([expect.objectContaining({ label: 'Edit shot timeline', command_ordinals: [0], patch: [] })]);
      expect(captured.intents[0].payload).toMatchObject({ commands: request.commands });
      expect((await provider.loadTimeline('popup-timeline')).config.clips).toHaveLength(h.config.clips.length);
      expect(h.published).toHaveBeenCalledWith(expect.objectContaining({ headRevisionId: 'rev-a3-accepted' }), 0,
        fixture.primary_timeline.head.revision_id);
    } finally {
      await provider.dispose();
    }
  });

  it('refuses a gallery ADD onto a new shot track before any fork or durable mutation', async () => {
    const beforeDocument = canonicalDocument();
    const selected = (beforeDocument.parent_revision.payload.occurrences as Array<Record<string, unknown>>)[0]!;
    (beforeDocument.parent_revision.payload.occurrences as unknown[]).push({ ...selected, occurrence_id: 'occ-sibling' });
    const h = harness(beforeDocument);
    const asset = h.config.clips[0].asset;
    h.config.registry[asset] = { ...h.config.registry[asset], generationId: 'generation-old', variantId: 'variant-old' };
    h.transport.getProjectMediaSelection = vi.fn(async (query: MediaSelectionQuery) => ({
      ...query, object_id: `sha256:${'1'.repeat(64)}`, catalog_digest: `sha256:${'2'.repeat(64)}`,
    }));
    const provider = h.mount();
    const loadedBefore = await provider.loadTimeline('popup-timeline');
    const added = h.add();
    const next = {
      ...added,
      tracks: [...(h.config.tracks ?? []), { id: 'overlay', kind: 'visual' as const, label: 'Overlay' }],
      clips: added.clips.map((clip) => clip.id === 'popup-added-a3' ? { ...clip, track: 'overlay' } : clip),
    };
    try {
      await expect(provider.saveTimeline('popup-timeline', next, 1)).rejects.toMatchObject({
        code: 'timeline_save_refused',
        message: 'Gallery drops onto a new shot track are not supported yet. Drop the gallery item onto an existing shot track; nothing was saved.',
      });
      expect(h.transport.getProjectMediaSelection).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
      const records = await h.records();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ intents: [] });
      expect(records[0].pending).toBeUndefined();
      expect((await provider.loadTimeline('popup-timeline')).config.clips).toEqual(loadedBefore.config.clips);
    } finally {
      await provider.dispose();
    }
  });

  it('claims a newly registered asset before the added occurrence clip in Agent order', async () => {
    const h = harness();
    const asset = 'popup-new-asset';
    const entry = { file: asset, type: 'image', generationId: 'generation-new', variantId: 'variant-new' };
    const selection = { asset, generation_id: 'generation-new', variant_id: 'variant-new',
      object_id: `sha256:${'3'.repeat(64)}`, catalog_digest: `sha256:${'4'.repeat(64)}` };
    h.transport.getProjectMediaSelection = vi.fn(async (query: MediaSelectionQuery) => ({ ...query,
      object_id: selection.object_id, catalog_digest: selection.catalog_digest }));
    let captured!: OutboxRecord;
    h.send.mockImplementation(async (request, key) => {
      [captured] = await h.records();
      return JSON.parse(JSON.stringify(h.reply(request, key, savedDocument(captured))));
    });
    const provider = h.mount();
    const added = h.add();
    const next = { ...added, clips: added.clips.map((clip) => clip.id === 'popup-added-a3'
      ? { ...clip, asset } : clip) };
    const registry = await provider.loadAssetRegistry('popup-timeline');
    const nextRegistry = { ...registry, assets: { ...registry.assets, [asset]: entry } };
    try {
      await expect(provider.saveTimeline('popup-timeline', next, 1, nextRegistry)).resolves.toBe(2);
      const [request] = h.send.mock.calls[0];
      expect(request.commands[0]).toMatchObject({ op: 'occurrence.add-media', created: [
        'occurrence:occ-3/asset:popup-new-asset', 'occurrence:occ-3/clip:popup-added-a3',
      ] });
      expect(h.transport.getProjectMediaSelection).toHaveBeenCalledWith({ asset,
        generation_id: 'generation-new', variant_id: 'variant-new' });
      expect(captured.intents[0].payload).toMatchObject({ commands: request.commands });
    } finally {
      await provider.dispose();
    }
  });

  it.each(['add', 'swap'] as const)('forks a shared occurrence before the existing media %s command in one durable request', async (kind) => {
    const before = canonicalDocument();
    const parent = before.parent_revision.payload;
    const selected = (parent.occurrences as Array<Record<string, unknown>>)[0];
    (parent.occurrences as unknown[]).push({ ...selected, occurrence_id: 'occ-sibling' });
    const h = harness(before);
    const originalAsset = h.config.clips[0].asset;
    const replacementAsset = 'popup-shared-replacement';
    h.config.registry[originalAsset] = { ...h.config.registry[originalAsset], generationId: 'generation-old', variantId: 'variant-old' };
    h.config.registry[replacementAsset] = { file: replacementAsset, type: 'image', generationId: 'generation-new', variantId: 'variant-new' };
    h.transport.getProjectMediaSelection = vi.fn(async (query: MediaSelectionQuery) => ({
      ...query, object_id: `sha256:${'1'.repeat(64)}`, catalog_digest: `sha256:${'2'.repeat(64)}`,
    }));
    let captured!: OutboxRecord;
    h.send.mockImplementation(async (request, key) => {
      [captured] = await h.records();
      return JSON.parse(JSON.stringify(h.reply(request, key, savedDocument(captured))));
    });
    const provider = h.mount();
    const next = kind === 'add'
      ? h.add()
      : { ...h.config, clips: h.config.clips.map((clip, index) => index === 0
        ? { ...clip, asset: replacementAsset } : clip) };
    await expect(provider.saveTimeline('popup-timeline', next, 1)).resolves.toBe(2);
    const [request] = h.send.mock.calls[0];
    expect(request.commands.map((command) => command.op)).toEqual([
      'occurrence.fork', kind === 'add' ? 'occurrence.add-media' : 'occurrence.swap-media',
    ]);
    expect(request.commands[0]).toMatchObject({ select: 'occurrence:occ-3', args: { shot_id: expect.stringMatching(/^shot-fork-/) },
      intent: { ownership: 'occurrence' }, created: [expect.stringMatching(/^shot:shot-fork-/)] });
    expect(request.commands[1]).toMatchObject({ select: kind === 'add' ? 'occurrence:occ-3' : 'occurrence:occ-3/clip:alpha-video-b',
      intent: { ownership: 'occurrence' } });
    expect(request.commands[1].select).not.toContain('occ-3:');
    if (kind === 'add') expect(request.commands[1].created).toEqual([
      `occurrence:occ-3/clip:popup-added-a3`,
    ]);
    if (kind === 'add') {
      const row = request.commands[1].args.row as Record<string, unknown>;
      expect(row.id).toBe('popup-added-a3');
      expect(row.track).not.toContain('~');
      expect(row).not.toHaveProperty('app.group');
    }
    if (kind === 'swap') expect(request.commands[1].created).toEqual([]);
    expect(captured.intents[0].payload).toMatchObject({ commands: request.commands });
    expect(h.transport.getProjectMediaSelection).toHaveBeenCalled();
    await provider.dispose();
  });

  it('claims a newly registered occurrence asset before a shared media SWAP', async () => {
    const before = canonicalDocument();
    const parent = before.parent_revision.payload;
    const selected = (parent.occurrences as Array<Record<string, unknown>>)[0];
    (parent.occurrences as unknown[]).push({ ...selected, occurrence_id: 'occ-sibling' });
    const h = harness(before);
    const originalAsset = h.config.clips[0].asset;
    const replacementAsset = 'popup-new-swap-asset';
    h.config.registry[originalAsset] = { ...h.config.registry[originalAsset], generationId: 'generation-old', variantId: 'variant-old' };
    h.transport.getProjectMediaSelection = vi.fn(async (query: MediaSelectionQuery) => ({
      ...query, object_id: `sha256:${'5'.repeat(64)}`, catalog_digest: `sha256:${'6'.repeat(64)}`,
    }));
    let captured!: OutboxRecord;
    h.send.mockImplementation(async (request, key) => {
      [captured] = await h.records();
      return JSON.parse(JSON.stringify(h.reply(request, key, savedDocument(captured))));
    });
    const provider = h.mount();
    const next = { ...h.config, clips: h.config.clips.map((clip, index) => index === 0
      ? { ...clip, asset: replacementAsset } : clip) };
    const registry = await provider.loadAssetRegistry('popup-timeline');
    const nextRegistry = { ...registry, assets: {
      ...registry.assets,
      [replacementAsset]: { file: replacementAsset, type: 'image', generationId: 'generation-new', variantId: 'variant-new' },
    } };
    try {
      await expect(provider.saveTimeline('popup-timeline', next, 1, nextRegistry)).resolves.toBe(2);
      const [request] = h.send.mock.calls[0];
      expect(request.commands[1]).toMatchObject({ op: 'occurrence.swap-media',
        select: 'occurrence:occ-3/clip:alpha-video-b',
        created: ['occurrence:occ-3/asset:popup-new-swap-asset'] });
      expect(request.commands[1].args).toEqual(expect.objectContaining({ old_media: expect.any(Object), media: expect.any(Object) }));
      expect(captured.intents[0].payload).toMatchObject({ commands: request.commands });
    } finally {
      await provider.dispose();
    }
  });

  it('uses the A2 session for a uniquely owned child root and publishes its accepted closure', async () => {
    const h = harness();
    let captured!: OutboxRecord;
    h.send.mockImplementation(async (request, key) => {
      [captured] = await h.records();
      return h.reply(request, key, savedDocument(captured));
    });
    const provider = h.mount();
    const nextConfig = { ...h.config, clips: h.config.clips.map((clip, index) => index === 0
      ? { ...clip, hold: (clip.hold ?? 0) + 0.25 } : clip) };
    await expect(provider.saveTimeline('popup-timeline', nextConfig, 1)).resolves.toBe(2);
    const save = captured.intents[0].payload as unknown as Record<string, unknown>;
    expect(save.documentIntent).toMatchObject({
      label: 'Edit shot timeline',
      roots: [{ ref: internalRef, revisionId: 'timeline-alpha-b', contentDigest: 'sha256:5555555555555555555555555555555555555555555555555555555555555555' }],
      before: h.before,
      after: expect.objectContaining({ internal_timeline_revisions: [expect.objectContaining({
        revision_id: 'timeline-alpha-b', payload: expect.objectContaining({ clips: [expect.objectContaining({
          id: 'alpha-video-b', app: expect.objectContaining({ visualBoundary: { intentionalPause: true },
            opaqueFutureState: { preserve: null } }),
          params: null, effects: null, keyframes: null, text: null, elementRef: null,
        })] }),
      })] }),
    });
    expect(h.published).toHaveBeenCalledWith(expect.objectContaining({ headRevisionId: 'rev-a3-accepted' }), 0, fixture.primary_timeline.head.revision_id);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.oldPublish).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it.each(['accepted', 'merged'] as const)('sends a guarded popup add through the real durable session and adopts %s', async (status) => {
    const h = harness();
    let captured!: OutboxRecord;
    h.send.mockImplementation(async (request, key) => {
      [captured] = await h.records();
      expect(JSON.stringify(request)).toBe(captured.pending!.request.body);
      expect(key).toBe(captured.pending!.request.key);
      return h.reply(request, key, savedDocument(captured), status);
    });
    const provider = h.mount();
    await expect(provider.saveTimeline('popup-timeline', h.add(), 1)).resolves.toBe(2);
    expect(h.send).toHaveBeenCalledTimes(1);
    const [request] = h.send.mock.calls[0];
    expect(request).toMatchObject({ api_version: 1, project_id: scope.projectId, timeline_id: scope.timelineId,
      base_revision_id: h.initial.head.revisionId, base_publication_id: 'pub-0', label: 'Edit shot timeline',
      merge: 'atomic', dry_run: false,
      commands: [{ schema_version: 1, op: 'doc.patch', version: '1', select: null,
        created: ['occurrence:occ-3/clip:popup-added-a3'] }] });
    const changes = request.commands[0].args.changes;
    expect(changes).toEqual(expect.arrayContaining([expect.objectContaining({
      op: 'list.insert', ref: internalRef, path: ['clips'], id: 'popup-added-a3',
      before: { state: 'absent' }, order_before: ['alpha-video-b'], after_id: 'alpha-video-b',
    })]));
    expect(request.steps![0]).toMatchObject({ id: expect.any(String), label: 'Edit shot timeline',
      intent: 'Save shot-local timeline changes', tags: ['shot-popup'], command_ordinals: [0], patch: changes,
      reads: request.reads });
    expect(request.reads).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'field', ref: 'parent', path: ['occurrences'] }),
      { kind: 'field', ref: 'shot-revision:rev-b', path: ['internal_timeline_revision_id'],
        state: { state: 'present', value: 'timeline-alpha-b' } },
      { kind: 'scope', ref: internalRef, path: [] },
    ]));
    expect(provider.getTimelineDraftRecoveryMetadata()).toMatchObject({ baseHeadRevisionId: 'rev-a3-accepted' });
    const [stored] = await h.records();
    expect(stored.accepted!.value).toMatchObject({ response: { data: { status, merge_mode: 'atomic',
      steps: [{ patch: changes, dependencies: request.reads }] } } });
    expect(stored.intents).toEqual([]);
    // The canonical reply is authoritative even when it differs from the local preview.
    expect((await provider.loadTimeline('popup-timeline')).config.clips).toHaveLength(h.config.clips.length);
    if (status === 'merged') expect(h.published.mock.calls[0][0].contract.shot_revisions
      .find((shot: { revision_id: string }) => shot.revision_id === 'rev-b').provenance.source).toBe('agent-change');
    await provider.dispose();
  });

  it.each(['child', 'parent', 'config'] as const)('keeps deliberate registry removals and omitted raw values in the %s registry', async (location) => {
    const before = canonicalDocument();
    const h = harness(before);
    const source = { assets: { ...JSON.parse(JSON.stringify(h.config.registry)), hidden: { foreign: null } },
      future: { nullable: null, ordered: ['z', null, 'a'] } };
    const visibleId = Object.keys(h.config.registry)[0];
    Object.assign(source.assets[visibleId], { future: null });
    const parent = before.parent_revision.payload;
    const child = before.internal_timeline_revisions[0].payload;
    if (location === 'child') child.registry = source;
    else if (location === 'parent') {
      parent.registry = source;
      (parent.config as Record<string, unknown>).registry = structuredClone(source);
    } else (parent.config as Record<string, unknown>).registry = source;
    let captured!: OutboxRecord;
    h.send.mockImplementation(async (request, key) => {
      [captured] = await h.records();
      return h.reply(request, key, savedDocument(captured));
    });
    const provider = h.mount();
    const registry = await provider.loadAssetRegistry('popup-timeline');
    const assets = { ...registry.assets };
    delete assets[visibleId];
    await provider.saveTimeline('popup-timeline', h.config, 1, { ...registry, assets });
    const after = savedDocument(captured);
    const result = location === 'child' ? after.internal_timeline_revisions[0].payload.registry
      : location === 'parent' ? after.parent_revision.payload.registry
        : (after.parent_revision.payload.config as Record<string, unknown>).registry;
    const expected = structuredClone(source);
    delete expected.assets[visibleId];
    expect(result).toEqual(expected);
    if (location === 'parent') expect((after.parent_revision.payload.config as Record<string, unknown>).registry).toEqual(expected);
    const [request] = h.send.mock.calls[0];
    expect(request.commands[0].args.changes).toContainEqual({ op: 'remove', ref: location === 'child' ? internalRef : 'parent',
      path: [...(location === 'config' ? ['config'] : []), 'registry', 'assets', visibleId],
      before: { state: 'present', value: source.assets[visibleId] } });
    expect(Object.hasOwn(after.internal_timeline_revisions[0].payload, 'not-present')).toBe(false);
    await provider.dispose();
  });

  it('sends media swap and track add/reorder without losing foreign rows or nullable fields', async () => {
    const before = canonicalDocument();
    const child = before.internal_timeline_revisions[0].payload;
    (child.clips as unknown[]).push({ id: 'foreign-clip', foreign: null, order: [2, null, 1] });
    const h = harness(before);
    let captured!: OutboxRecord;
    h.send.mockImplementation(async (request, key) => {
      [captured] = await h.records();
      return h.reply(request, key, savedDocument(captured));
    });
    const provider = h.mount();
    await provider.saveTimeline('popup-timeline', { ...h.config,
      tracks: [{ id: 'new-track', kind: 'visual' }, ...h.config.tracks.slice().reverse()],
      clips: h.config.clips.map((clip) => ({ ...clip, asset: 'replacement-verified-asset' })),
    }, 1);
    const after = savedDocument(captured).internal_timeline_revisions[0].payload;
    expect((after.clips as unknown[])[1]).toEqual({ id: 'foreign-clip', foreign: null, order: [2, null, 1] });
    expect((after.clips as Array<Record<string, unknown>>)[0]).toMatchObject({ asset_id: 'replacement-verified-asset', params: null,
      effects: null, keyframes: null, text: null, elementRef: null });
    const changes = h.send.mock.calls[0][0].commands[0].args.changes;
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'list.insert', ref: internalRef, path: ['tracks'], id: 'new-track' }),
      expect.objectContaining({ op: 'list.move', ref: internalRef, path: ['tracks'] }),
    ]));
    await provider.dispose();
  });

  it('removes only the authored clip and track while preserving rows omitted by projection', async () => {
    const before = canonicalDocument();
    const timeline = before.internal_timeline_revisions[0].payload;
    const foreign = { id: 'foreign-clip', foreign: null, ordered: [null, 2, 1] };
    (timeline.clips as unknown[]).push(foreign);
    const h = harness(before);
    let captured!: OutboxRecord;
    h.send.mockImplementation(async (request, key) => {
      [captured] = await h.records();
      return h.reply(request, key, savedDocument(captured));
    });
    const provider = h.mount();
    await provider.saveTimeline('popup-timeline', { ...h.config, clips: [], tracks: h.config.tracks.slice(0, 1) }, 1);
    const after = savedDocument(captured).internal_timeline_revisions[0].payload;
    expect(after.clips).toEqual([foreign]);
    expect(after.tracks).toEqual((timeline.tracks as unknown[]).slice(0, 1));
    expect(h.send.mock.calls[0][0].commands[0].args.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'list.remove', ref: internalRef, path: ['clips'], id: 'alpha-video-b',
        order_before: ['alpha-video-b', 'foreign-clip'] }),
      expect.objectContaining({ op: 'list.remove', ref: internalRef, path: ['tracks'], id: 'audio',
        order_before: ['video', 'audio'] }),
    ]));
    await provider.dispose();
  });

  it('binds the selected physical revision when another reachable image has the same timeline ID', async () => {
    const before = canonicalDocument();
    const otherInternal = { ...structuredClone(before.internal_timeline_revisions[0]), revision_id: 'other-internal' };
    const otherShot = { ...structuredClone(before.shot_revisions[0]), shot_id: 'other-shot', revision_id: 'other-shot-rev',
      internal_timeline_revision_id: otherInternal.revision_id,
      payload: { internal_timeline_revision_id: otherInternal.revision_id, nullable: null } };
    before.internal_timeline_revisions.unshift(otherInternal);
    before.shot_revisions.unshift(otherShot);
    before.dependency_manifest.internal_timelines.unshift({ timeline_id: otherInternal.timeline_id,
      revision_id: otherInternal.revision_id, content_digest: otherInternal.content_digest });
    before.dependency_manifest.shots.unshift({ shot_id: otherShot.shot_id, revision_id: otherShot.revision_id,
      internal_timeline_revision_id: otherInternal.revision_id, content_digest: otherShot.content_digest });
    (before.parent_revision.payload.occurrences as unknown[]).unshift({ occurrence_id: 'other-occurrence',
      shot_id: otherShot.shot_id, shot_revision_id: otherShot.revision_id });
    const h = harness(before);
    let captured!: OutboxRecord;
    h.send.mockImplementation(async (request, key) => {
      [captured] = await h.records();
      return h.reply(request, key, savedDocument(captured));
    });
    const provider = h.mount();
    await provider.saveTimeline('popup-timeline', h.add(), 1);
    const after = savedDocument(captured);
    expect(after.internal_timeline_revisions[0]).toEqual(otherInternal);
    expect(after.shot_revisions).toEqual(before.shot_revisions);
    expect(after.parent_revision).toEqual(before.parent_revision);
    expect(h.send.mock.calls[0][0].commands[0].args.changes).toEqual([
      expect.objectContaining({ op: 'list.insert', ref: internalRef, path: ['clips'] }),
    ]);
    await provider.dispose();
  });

  it.each(['child', 'parent', 'config'] as const)('declares created asset ownership in an existing empty %s registry', async (location) => {
    const before = canonicalDocument();
    if (location === 'child') before.internal_timeline_revisions[0].payload.registry = {};
    else if (location === 'parent') before.parent_revision.payload.registry = {};
    else (before.parent_revision.payload.config as Record<string, unknown>).registry = {};
    const h = harness(before);
    h.send.mockImplementation(async (request, key) => h.reply(request, key, savedDocument((await h.records())[0])));
    const provider = h.mount();
    const registry = await provider.loadAssetRegistry('popup-timeline');
    await provider.saveTimeline('popup-timeline', h.config, 1, { assets: { ...registry.assets,
      registered: { file: 'existing-verified-object', type: 'image', future: null },
    } });
    const request = h.send.mock.calls[0][0];
    expect(request.commands[0].created).toEqual([`${location === 'child' ? 'occurrence:occ-3' : 'parent'}/asset:registered`]);
    expect(request.commands[0].args.changes).toEqual([
      expect.objectContaining({ op: 'set', ref: location === 'child' ? internalRef : 'parent',
        path: [...(location === 'config' ? ['config'] : []), 'registry', 'assets'], before: { state: 'absent' },
        value: { registered: { file: 'existing-verified-object', type: 'image', future: null } } }),
    ]);
    await provider.dispose();
  });

  it('retries the same mounted popup save without appending a new intent or key', async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(new Error('Lost acknowledgement'));
    const provider = h.mount();
    const next = h.add();
    await expect(provider.saveTimeline('popup-timeline', next, 1)).rejects.toThrow('unacknowledged');
    const [stored] = await h.records();
    h.send.mockImplementationOnce(async (request, key) => {
      expect(JSON.stringify(request)).toBe(stored.pending!.request.body);
      expect(key).toBe(stored.pending!.request.key);
      expect((await h.records())[0].intents).toEqual(stored.intents);
      return h.reply(request, key, savedDocument(stored));
    });
    await expect(provider.saveTimeline('popup-timeline', next, 1)).resolves.toBe(2);
    expect(h.send).toHaveBeenCalledTimes(2);
    await provider.dispose();
  });

  it.each(['same-shot', 'different-shot', 'duplicate-root', 'bad-manifest'] as const)('refuses unsafe ownership: %s', async (kind) => {
    const before = canonicalDocument();
    const parent = before.parent_revision.payload;
    const original = (parent.occurrences as Array<Record<string, unknown>>)[0];
    if (kind === 'same-shot') (parent.occurrences as unknown[]).push({ ...original, occurrence_id: 'other' });
    if (kind === 'different-shot') {
      (parent.occurrences as unknown[]).push({ ...original, occurrence_id: 'other', shot_id: 'other-shot', shot_revision_id: 'other-rev' });
      const shot = { ...structuredClone(before.shot_revisions[0]), shot_id: 'other-shot', revision_id: 'other-rev' };
      before.shot_revisions.push(shot);
      before.dependency_manifest.shots.push({ ...before.dependency_manifest.shots[0], shot_id: 'other-shot', revision_id: 'other-rev' });
    }
    if (kind === 'duplicate-root') before.internal_timeline_revisions.push(structuredClone(before.internal_timeline_revisions[0]));
    if (kind === 'bad-manifest') before.dependency_manifest.internal_timelines[0].content_digest = 'sha256:wrong';
    const h = harness(before);
    const provider = h.mount();
    await expect(provider.saveTimeline('popup-timeline', h.add(), 1)).rejects.toThrow(/isolation|unique|pin/);
    expect(h.send).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('chains a changed popup draft behind an unknown add outcome using the original durable request first', async () => {
    const h = harness();
    const provider = h.mount();
    const next = h.add();
    h.send.mockRejectedValueOnce(new Error('Lost acknowledgement'));
    await expect(provider.saveTimeline('popup-timeline', next, 1)).rejects.toThrow('unacknowledged');
    const [original] = await h.records();
    h.send.mockImplementationOnce(async (request, key) => {
      expect(JSON.stringify(request)).toBe(original.pending!.request.body);
      expect(key).toBe(original.pending!.request.key);
      expect((await h.records())[0].intents).toHaveLength(2);
      return h.reply(request, key, savedDocument(original));
    }).mockImplementationOnce(async (request, key) => {
      expect(key).not.toBe(original.pending!.request.key);
      expect(request).toMatchObject({ base_revision_id: 'rev-a3-accepted', base_publication_id: 'pub-a3-accepted' });
      expect(request.commands[0].args.changes).toEqual([{ op: 'set', ref: internalRef,
        path: ['clips', 'id:popup-added-a3', 'label'], before: { state: 'absent' }, value: 'Dependent' }]);
      return h.reply(request, key, savedDocument((await h.records())[0]));
    });
    const dependent = { ...next, clips: next.clips.map((clip) => clip.id === 'popup-added-a3'
      ? { ...clip, label: 'Dependent' } : clip) };
    await expect(provider.saveTimeline('popup-timeline', dependent, 1)).resolves.toBe(2);
    expect(h.send).toHaveBeenCalledTimes(3);
    expect((await h.records())[0].intents).toEqual([]);
    await provider.dispose();
  });

  it('reopens the explicitly selected real outbox owner and retries its exact persisted request and key', async () => {
    const h = harness();
    h.send.mockRejectedValueOnce(new Error('Lost acknowledgement'));
    const first = h.mount();
    await expect(first.saveTimeline('popup-timeline', h.add(), 1)).rejects.toThrow('unacknowledged');
    const [stored] = await h.records();
    const exact = structuredClone(stored.pending!.request);
    expect(h.send.mock.calls[0]).toEqual([JSON.parse(exact.body), exact.key]);
    await first.dispose();
    const reopened = h.mount();
    expect(await reopened.getLocalSaveState()).toMatchObject({ status: 'recovery', recoverableOwners: [stored.ownerId] });
    await expect(reopened.recoverLocalSaves('unlisted-owner')).rejects.toThrow('explicitly listed');
    h.send.mockImplementationOnce(async (request, key) => {
      expect(JSON.stringify(request)).toBe(exact.body);
      expect(key).toBe(exact.key);
      return h.reply(request, key, savedDocument(stored), 'merged');
    });
    await reopened.recoverLocalSaves(stored.ownerId);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(await reopened.getLocalSaveState()).toMatchObject({ status: 'saved' });
    expect((await h.records())[0].intents).toEqual([]);
    await reopened.dispose();
  });

  it('keeps generated-only clip metadata out of the durable outbox across reopen and retry', async () => {
    const graph = structuredClone(fixture);
    const timeline = graph.shot_revisions.find((shot) => shot.revision_id === 'rev-b')!.internal_timeline_revision.timeline;
    for (const clip of timeline.clips) Reflect.deleteProperty(clip, 'app');
    const before = canonicalDocument();
    for (const clip of before.internal_timeline_revisions[0].payload.clips as Array<Record<string, unknown>>) {
      Reflect.deleteProperty(clip, 'app');
    }
    const h = harness(before, graph);
    const next: typeof h.config = h.add();
    next.clips = next.clips.map((clip) => ({
      ...clip, label: 'Authored label',
      app: {
        ...clip.app,
        canonical: clip.app?.canonical ?? { occurrenceId: 'occ-3' },
        canonicalTiming: clip.app?.canonicalTiming ?? { storedOccurrenceDurationMs: 1200 },
        canonicalEffects: { inherited: true },
      },
    }));
    const original = structuredClone(next);
    h.send.mockRejectedValueOnce(new Error('Lost acknowledgement'));
    const first = h.mount();
    try {
      await expect(first.saveTimeline('popup-timeline', next, 1)).rejects.toThrow('unacknowledged');
      const [stored] = await h.records();
      const saved = savedDocument(stored).internal_timeline_revisions[0].payload.clips as Array<Record<string, unknown>>;
      expect(saved.map((clip) => clip.id)).toEqual(['alpha-video-b', 'popup-added-a3']);
      for (const clip of saved) {
        expect(clip.label).toBe('Authored label');
        expect(clip).not.toHaveProperty('app');
      }
      const exact = structuredClone(stored.pending!.request);
      expect(exact.body).not.toMatch(/canonical(?:Timing|Effects)?/);
      expect(next).toStrictEqual(original);
      await first.dispose();
      const reopened = h.mount();
      try {
        expect(await reopened.getLocalSaveState()).toMatchObject({ status: 'recovery', recoverableOwners: [stored.ownerId] });
        h.send.mockImplementationOnce(async (request, key) => {
          expect(JSON.stringify(request)).toBe(exact.body);
          expect(key).toBe(exact.key);
          expect(savedDocument((await h.records())[0])).toEqual(savedDocument(stored));
          return h.reply(request, key, savedDocument(stored));
        });
        await reopened.recoverLocalSaves(stored.ownerId);
        expect(h.send).toHaveBeenCalledTimes(2);
        expect(await reopened.getLocalSaveState()).toMatchObject({ status: 'saved' });
        expect((await h.records())[0].intents).toEqual([]);
      } finally { await reopened.dispose(); }
    } finally { await first.dispose(); }
  });

  it.each(['conflict', 'invalid'] as const)('rolls back a %s reply, retaining the exact rejected request through recovery', async (code) => {
    const h = harness();
    const details = code === 'conflict' ? { status: 'conflict', head: { revision_id: 'agent-head', publication_id: 'agent-pub' }, reason: 'dependency_changed' }
      : { code: 'invalid_media', path: ['clips', 'id:popup-added-a3'], hint: 'Choose verified media' };
    h.send.mockRejectedValueOnce(new ApiError(code === 'conflict' ? 409 : 422, code, code, '', details));
    const first = h.mount();
    await expect(first.saveTimeline('popup-timeline', h.add(), 1)).rejects.toMatchObject({
      code: code === 'conflict' ? 'timeline_version_conflict' : 'timeline_save_refused', message: `${code}: ${code}`,
    });
    expect((await first.loadTimeline('popup-timeline')).config.clips).toHaveLength(h.config.clips.length);
    expect(h.load).toHaveBeenCalledTimes(2);
    const [stored] = await h.records();
    expect(stored.pending!.outcome).toMatchObject({ kind: 'rejected', error: { code, details } });
    expect(stored.intents).toHaveLength(1);
    await first.dispose();
    const second = h.mount();
    await expect(second.recoverLocalSaves(stored.ownerId)).rejects.toMatchObject({
      code: code === 'conflict' ? 'timeline_version_conflict' : 'timeline_save_refused', message: `${code}: ${code}`,
    });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect((await h.records())[0].pending!.request).toEqual(stored.pending!.request);
    expect(h.published).not.toHaveBeenCalled();
    await second.dispose();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';

import { createFakeRuntimeRouter, type FakeRuntimeRouter } from '@/test/fakeRuntimeRouter.ts';
import { ApiError } from '@/integrations/runtime/generated.ts';
import { createCommitOutbox } from '@/tools/video-editor/commands/commitOutbox.ts';
import { createDefaultTimelineConfig } from '@/tools/video-editor/lib/defaults';
import { createElement } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGalleryPageState } from '@/features/gallery/hooks/useGalleryPageState';
import { __resetSelectionStoreForTests, setTimelineClipData, userSelectTimelineClips } from '@/shared/state/selectionStore';
import { createShotCompositionAdapter } from '@/tools/video-editor/data/shotCompositionAdapter';
import compositionFixture from '@/tools/video-editor/data/shotComposition.fixture.json';

vi.mock('@/shared/contexts/ProjectContext', () => ({
  useProjectSelectionContext: () => ({ selectedProjectId: 'demo-project' }),
}));
vi.mock('@/shared/contexts/ShotsContext', () => ({ useShots: () => ({ shots: [] }) }));
vi.mock('@/shared/hooks/projects/useProjectGenerations', () => ({
  useProjectGenerations: () => ({ data: { items: [], total: 0 }, isLoading: false, isFetching: false }),
}));

import {
  batchUpdatePlacementFrames,
  buildOccurrenceForkCommand,
  fetchGalleryRows,
  fetchProjectPlacements,
  placeGeneration,
  unplaceGeneration,
} from '../placementService';

/**
 * Placement round-trips over workspace.v1: the timeline list is a `/v1/projects/…`
 * route; placement writes use the Runtime canonical basis and the same
 * LocalSaveSession/doc.patch outbox as the editor. Gallery and generation reads
 * come from the canonical fake router; the Runtime head is the in-memory fake below.
 */

const PROJECT = 'demo-project';
const TIMELINE = 'timeline-v1';
const SHOT = 'shot-e2e-1';
const FAKE_ORIGIN = 'http://bridge.fake';

const runtime = vi.hoisted(() => ({
  head: 'rev-1',
  version: 1,
  config: null as unknown,
  registry: { assets: {} } as unknown,
  occurrences: [] as Array<Record<string, unknown>>,
  shotRevisions: [] as Array<Record<string, unknown>>,
  internalTimelineRevisions: [] as Array<Record<string, unknown>>,
  publishes: [] as string[],
  commits: [] as Array<{ body: unknown; key: string }>,
  /** Runs once after a basis read, before local authoring: simulates a sibling publish. */
  beforePublish: null as null | (() => void),
}));

function canonicalDocument() {
  return {
    schema_version: 1 as const,
    project_id: PROJECT,
    timeline_id: TIMELINE,
    parent_revision: { revision_id: runtime.head, content_digest: 'parent-digest', payload: {
      config: structuredClone(runtime.config), registry: structuredClone(runtime.registry),
      occurrences: structuredClone(runtime.occurrences),
      opaque: { nested: [null, false] },
    } },
    shot_revisions: structuredClone(runtime.shotRevisions),
    internal_timeline_revisions: structuredClone(runtime.internalTimelineRevisions),
    dependency_manifest: {
      shots: runtime.shotRevisions.map((shot) => ({ shot_id: shot.shot_id, revision_id: shot.revision_id,
        internal_timeline_revision_id: shot.internal_timeline_revision_id, content_digest: shot.content_digest })),
      internal_timelines: runtime.internalTimelineRevisions.map((internal) => ({ timeline_id: internal.timeline_id,
        revision_id: internal.revision_id, content_digest: internal.content_digest })),
      media: [], documents: [],
    },
  };
}

function applyOccurrenceFork(document: any, command: any) {
  const occurrenceId = command.select.slice('occurrence:'.length);
  const occurrence = document.parent_revision.payload.occurrences.find((row: any) => row.occurrence_id === occurrenceId);
  const sourceShot = document.shot_revisions.find((shot: any) => shot.revision_id === occurrence.shot_revision_id);
  const sourceInternal = document.internal_timeline_revisions.find((internal: any) =>
    internal.revision_id === sourceShot.internal_timeline_revision_id);
  const shotId = command.args.shot_id;
  const shotRevision = structuredClone(sourceShot);
  shotRevision.shot_id = shotId;
  shotRevision.revision_id = `${shotId}-revision`;
  shotRevision.content_digest = `${shotId}-digest`;
  shotRevision.internal_timeline_revision_id = `${shotId}-internal-revision`;
  const internalRevision = structuredClone(sourceInternal);
  internalRevision.revision_id = shotRevision.internal_timeline_revision_id;
  internalRevision.content_digest = `${shotId}-internal-digest`;
  occurrence.shot_id = shotId;
  occurrence.shot_revision_id = shotRevision.revision_id;
  document.shot_revisions.push(shotRevision);
  document.internal_timeline_revisions.push(internalRevision);
  const referencedShots = new Set(document.parent_revision.payload.occurrences.map((row: any) => row.shot_revision_id));
  const retainedShots = document.shot_revisions.filter((shot: any) => referencedShots.has(shot.revision_id));
  const referencedInternals = new Set(retainedShots.map((shot: any) => shot.internal_timeline_revision_id));
  document.shot_revisions = retainedShots;
  document.internal_timeline_revisions = document.internal_timeline_revisions.filter((internal: any) =>
    referencedInternals.has(internal.revision_id));
  document.dependency_manifest.shots = document.dependency_manifest.shots.filter((pin: any) =>
    referencedShots.has(pin.revision_id));
  document.dependency_manifest.internal_timelines = document.dependency_manifest.internal_timelines.filter((pin: any) =>
    referencedInternals.has(pin.revision_id));
  document.dependency_manifest.shots.push({ shot_id: shotRevision.shot_id, revision_id: shotRevision.revision_id,
    internal_timeline_revision_id: shotRevision.internal_timeline_revision_id, content_digest: shotRevision.content_digest });
  document.dependency_manifest.internal_timelines.push({ timeline_id: internalRevision.timeline_id,
    revision_id: internalRevision.revision_id, content_digest: internalRevision.content_digest });
}

function container(root: any, path: string[]): { owner: any; key: string } {
  let owner = root;
  for (const token of path.slice(0, -1)) owner = token.startsWith('id:')
    ? owner.find((row: any) => row.id === token.slice(3)) : owner[token];
  return { owner, key: path[path.length - 1]! };
}

function applyChanges(document: any, changes: any[]) {
  const payload = document.parent_revision.payload;
  for (const change of changes) {
    const { owner, key } = container(payload, change.path);
    if (change.op === 'set') owner[key] = structuredClone(change.value);
    else if (change.op === 'remove') delete owner[key];
    else if (change.op === 'list.insert') {
      const list = owner[key] as any[];
      const index = change.after_id === null ? 0 : list.findIndex((row) => row.id === change.after_id) + 1;
      list.splice(index, 0, structuredClone(change.value));
    } else if (change.op === 'list.remove') {
      const list = owner[key] as any[];
      const index = list.findIndex((row) => row.id === change.id);
      if (index >= 0) list.splice(index, 1);
    } else if (change.op === 'list.move') {
      const list = owner[key] as any[];
      const index = list.findIndex((row) => row.id === change.id);
      const [row] = list.splice(index, 1);
      const after = change.after_id === null ? -1 : list.findIndex((item) => item.id === change.after_id);
      list.splice(after + 1, 0, row);
    }
  }
}

vi.mock('@/integrations/runtime/dataProvider', () => ({
  RuntimeDataProvider: class {
    constructor(readonly options: { projectId: string }) {}
    async loadTimeline(timelineId: string) {
      return {
        config: structuredClone(runtime.config),
        configVersion: runtime.version,
        head: { projectId: this.options.projectId, timelineId, headRevisionId: runtime.head },
      };
    }
    async loadAssetRegistry() {
      return structuredClone(runtime.registry);
    }
    async loadTimelineCommandBasis() {
      const document = canonicalDocument();
      const basis = { head: { revisionId: runtime.head, publicationId: `pub-${runtime.head}` }, canonicalDocument: document, graph: {} };
      // Sibling publication after this immutable read, before local authoring.
      const hook = runtime.beforePublish;
      runtime.beforePublish = null;
      hook?.();
      return basis;
    }
    async getRecoverableIdentity() {
      return { realmId: 'realm', actorId: 'actor' };
    }
    async commitTimeline(request: any, key: string) {
      runtime.commits.push({ body: structuredClone(request), key });
      if (request.base_revision_id !== runtime.head) {
        throw new ApiError(409, 'conflict', 'intervening_write', '', { status: 'conflict' });
      }
      const document = canonicalDocument();
      const nextHead = `rev-${runtime.publishes.length + 2}`;
      if (request.commands[0].op === 'occurrence.fork') applyOccurrenceFork(document, request.commands[0]);
      else applyChanges(document, request.commands[0].args.changes);
      document.parent_revision.revision_id = nextHead;
      runtime.config = structuredClone(document.parent_revision.payload.config);
      runtime.registry = structuredClone(document.parent_revision.payload.registry);
      runtime.occurrences = structuredClone(document.parent_revision.payload.occurrences);
      runtime.shotRevisions = structuredClone(document.shot_revisions);
      runtime.internalTimelineRevisions = structuredClone(document.internal_timeline_revisions);
      runtime.version += 1;
      runtime.head = nextHead;
      runtime.publishes.push(runtime.head);
      const accepted = { revisionId: runtime.head, publicationId: `pub-${runtime.head}` };
      return { response: { data: { status: 'accepted', canonical_document: document }, receipt: { receipt_id: accepted.publicationId } },
        accepted, canonicalDocument: document, graph: {}, receipt: { receipt_id: accepted.publicationId } };
    }
  },
}));

function installRuntime(router: FakeRuntimeRouter): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw.startsWith(FAKE_ORIGIN) ? raw : `${FAKE_ORIGIN}${raw}`);
    const path = url.pathname.replace(/^\/api\/astrid/, '');
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const json = (body: unknown) => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    if (path === `/v1/projects/${PROJECT}/timelines`) {
      return json({ items: [{ timeline_id: TIMELINE, name: 'main', is_default: true }] });
    }
    return await router.handle(new Request(url, init));
  }));
  return calls;
}

function firstSeededGenerationId(router: FakeRuntimeRouter): string {
  const detail = router.state.galleryDetails[0] as { generation_id: string };
  return detail.generation_id;
}

describe('placementService: CAS round-trips over workspace.v1', () => {
  beforeEach(() => {
    runtime.head = 'rev-1';
    runtime.version = 1;
    runtime.config = createDefaultTimelineConfig();
    runtime.registry = { assets: {} };
    runtime.occurrences = [{
      occurrence_id: 'occurrence-1', shot_id: 'shot-child', shot_revision_id: 'shot-r1', revision_id: 'occurrence-r1',
    }];
    runtime.shotRevisions = [{ shot_id: 'shot-child', revision_id: 'shot-r1', internal_timeline_revision_id: 'internal-r1',
      content_digest: 'shot-digest', payload: { items: [] } }];
    runtime.internalTimelineRevisions = [{ timeline_id: 'child-timeline', revision_id: 'internal-r1',
      content_digest: 'internal-digest', payload: { items: [] } }];
    runtime.publishes = [];
    runtime.commits = [];
    runtime.beforePublish = null;
    __resetSelectionStoreForTests();
    vi.stubGlobal('indexedDB', createFakeIndexedDB());
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}) } });
  });
  afterEach(() => {
    __resetSelectionStoreForTests();
    vi.unstubAllGlobals();
  });

  it.each(['add', 'position', 'pooled'] as const)('carries the mounted gallery %s selection through fork and placement', async (action) => {
    const router = createFakeRuntimeRouter();
    installRuntime(router);
    const generationId = firstSeededGenerationId(router);
    const fixture = JSON.parse(JSON.stringify(compositionFixture)
      .replaceAll('project-001', PROJECT).replaceAll('document-primary', TIMELINE));
    const composition = createShotCompositionAdapter({ load: async () => fixture }).prepare(fixture);
    runtime.occurrences = [
      { occurrence_id: 'occ-1', shot_id: 'shot-alpha', shot_revision_id: 'shot-r1' },
      { occurrence_id: 'occ-2', shot_id: 'shot-alpha', shot_revision_id: 'shot-r1' },
    ];
    runtime.shotRevisions[0].shot_id = 'shot-alpha';
    const sibling = structuredClone(runtime.occurrences[0]);
    const owner = Symbol('mounted-editor');
    const release = setTimelineClipData([], owner, { projectId: PROJECT, timelineId: TIMELINE, composition });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const { result, unmount } = renderHook(() => useGalleryPageState({ enableDataLoading: false }), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
    });
    act(() => userSelectTimelineClips(['occ-2:alpha-video'], {}, owner));
    if (action === 'position') {
      act(() => result.current.setSelectedShotFilter('shot-alpha'));
      expect(result.current.selectedShotFilter).toBe('shot-alpha');
    }
    let succeeded = false;
    await act(async () => {
      succeeded = await (action === 'pooled' ? result.current.handleAddToShotWithoutPosition : result.current.handleAddToShot)('shot-alpha', generationId);
    });
    expect(succeeded).toBe(true);
    expect(runtime.commits).toHaveLength(2);
    const destination = runtime.occurrences[1].shot_id;
    expect(destination).not.toBe('shot-alpha');
    expect(runtime.commits[0].body).toMatchObject({
      commands: [{ op: 'occurrence.fork', select: 'occurrence:occ-2', args: { shot_id: destination } }],
    });
    expect(runtime.commits[1].body.commands[0].op).toBe('doc.patch');
    expect(runtime.occurrences[0]).toEqual(sibling);
    const read = await fetchProjectPlacements(PROJECT);
    expect(read.byShot.get(destination as string)?.map((row) => row.generationId)).toEqual([generationId]);
    unmount();
    client.clear();
    release();
  });

  it('builds the registered fork from the explicit canonical occurrence owner', () => {
    const document = canonicalDocument();
    expect(buildOccurrenceForkCommand(document, {
      projectSlug: PROJECT,
      timelineRef: TIMELINE,
      configVersion: 1,
      ownerRef: 'occurrence:occurrence-1',
      shotId: 'shot-fork',
    })).toEqual({
      schema_version: 1,
      op: 'occurrence.fork',
      version: '1',
      select: 'occurrence:occurrence-1',
      args: { shot_id: 'shot-fork' },
      intent: { ownership: 'occurrence' },
      created: ['shot:shot-fork'],
    });
    expect(() => buildOccurrenceForkCommand(document, {
      projectSlug: PROJECT,
      timelineRef: TIMELINE,
      configVersion: 1,
      ownerRef: 'occurrence:shot-child',
      shotId: 'shot-fork',
    })).toThrow(expect.objectContaining({ code: 'timeline_save_refused', message: expect.stringContaining('uniquely bound canonical occurrence') }));
  });

  it('refuses an ambiguous canonical occurrence owner', () => {
    const document = canonicalDocument();
    document.parent_revision.payload.occurrences.push({
      occurrence_id: 'occurrence-1', shot_id: 'shot-child', shot_revision_id: 'shot-r1', revision_id: 'occurrence-r2',
    });

    expect(() => buildOccurrenceForkCommand(document, {
      projectSlug: PROJECT,
      timelineRef: TIMELINE,
      configVersion: 1,
      ownerRef: 'occurrence:occurrence-1',
      shotId: 'shot-fork',
    })).toThrow(expect.objectContaining({ code: 'timeline_save_refused', message: expect.stringContaining('uniquely bound canonical occurrence') }));
  });

  it('uses the explicit occurrence owner in the production placement caller', async () => {
    const router = createFakeRuntimeRouter();
    installRuntime(router);
    const generationId = firstSeededGenerationId(router);
    const sibling = { occurrence_id: 'occurrence-2', shot_id: 'shot-child', shot_revision_id: 'shot-r1', revision_id: 'occurrence-r2' };
    runtime.occurrences.push(sibling);

    const placed = await placeGeneration({
      projectSlug: PROJECT,
      shotId: 'shot-fork',
      generationId,
      ownerRef: 'occurrence:occurrence-1',
    });

    expect(placed.shotId).toBe('shot-fork');
    expect(runtime.commits).toHaveLength(2);
    expect(runtime.commits[0]?.body).toMatchObject({
      commands: [{ op: 'occurrence.fork', select: 'occurrence:occurrence-1', args: { shot_id: 'shot-fork' },
        intent: { ownership: 'occurrence' }, created: ['shot:shot-fork'] }],
    });
    expect(runtime.commits[1]?.body.commands[0].op).toBe('doc.patch');
    expect(runtime.occurrences).toEqual([{
      occurrence_id: 'occurrence-1', shot_id: 'shot-fork', shot_revision_id: 'shot-fork-revision', revision_id: 'occurrence-r1',
    }, sibling]);
    expect(runtime.shotRevisions.map((shot) => shot.revision_id)).toEqual(['shot-r1', 'shot-fork-revision']);
  });

  it('fails closed for an explicitly supplied malformed occurrence owner', async () => {
    const router = createFakeRuntimeRouter();
    installRuntime(router);
    const generationId = firstSeededGenerationId(router);

    await expect(placeGeneration({
      projectSlug: PROJECT,
      shotId: SHOT,
      generationId,
      ownerRef: '' as `occurrence:${string}`,
    })).rejects.toThrow('one explicit canonical occurrence owner');
    expect(runtime.commits).toHaveLength(0);
  });

  it('refuses a selected occurrence from another editor timeline before submitting a fork', async () => {
    const router = createFakeRuntimeRouter();
    installRuntime(router);
    await expect(placeGeneration({
      projectSlug: PROJECT, shotId: 'reserved-shot', generationId: firstSeededGenerationId(router),
      ownerRef: 'occurrence:occurrence-1', timelineRef: 'foreign-timeline',
    })).rejects.toMatchObject({ code: 'timeline_save_refused', message: expect.stringContaining('differs from the selected editor timeline') });
    expect(runtime.commits).toHaveLength(0);
  });

  it('keeps every raw root at the provider boundary across placement, frame update, pooling and removal', async () => {
    const router = createFakeRuntimeRouter();
    installRuntime(router);
    const generationId = firstSeededGenerationId(router);
    const roots = JSON.parse('{"opaque":{"nested":[null,false,[]]},"nullable":null,"ordered":[3,1,2],"__proto__":{"literal":true},"constructor":{"prototype":0},"prototype":false}');
    runtime.config = { ...createDefaultTimelineConfig(), ...roots };
    const assertRoots = () => {
      for (const [key, value] of Object.entries(roots)) {
        expect(Object.hasOwn(runtime.config as object, key), key).toBe(true);
        expect(Reflect.get(runtime.config as object, key), key).toEqual(value);
      }
      expect(Object.hasOwn(runtime.config as object, 'absent')).toBe(false);
    };
    const placed = await placeGeneration({ projectSlug: PROJECT, shotId: SHOT, generationId });
    assertRoots();
    await batchUpdatePlacementFrames({ projectSlug: PROJECT, shotId: SHOT, updates: [{ entryId: placed.entryId, timelineFrame: 30 }] });
    assertRoots();
    await unplaceGeneration({ projectSlug: PROJECT, shotId: SHOT, generationId, entryId: placed.entryId, keepAsPooled: true });
    assertRoots();
    await unplaceGeneration({ projectSlug: PROJECT, shotId: SHOT, generationId, entryId: placed.entryId });
    assertRoots();
    expect(runtime.publishes).toHaveLength(4);
  });

  it('places a completed generation into the document and the placement survives a fresh read', async () => {
    const router = createFakeRuntimeRouter();
    const calls = installRuntime(router);
    const generationId = firstSeededGenerationId(router);

    const placed = await placeGeneration({ projectSlug: PROJECT, shotId: SHOT, generationId });
    expect(placed.timelineFrame).toBe(0);
    expect(runtime.publishes).toEqual(['rev-2']);
    expect(calls.some((call) => call.endsWith('/save'))).toBe(false);

    // Fresh read: what a page load sees after refresh.
    const read = await fetchProjectPlacements(PROJECT);
    const rows = read.byShot.get(SHOT) ?? [];
    expect(rows.map((r) => r.generationId)).toEqual([generationId]);
    expect(rows[0]?.timelineFrame).toBe(0);
    expect(read.config.pinnedShotGroups?.[0]?.shotId).toBe(SHOT);

    // The placed clip is a REAL editor clip on the group track with a registry asset.
    const group = read.config.pinnedShotGroups?.[0];
    const clip = read.config.clips.find((c) => c.id === `clip-${placed.entryId}`);
    expect(clip?.track).toBe(group?.trackId);
    expect(clip?.clipType).toBe('media');
    const asset = read.registry.assets[clip?.asset ?? ''] as { generationId?: string } | undefined;
    expect(asset).toBeDefined();
  });

  it('pooled add keeps membership without a clip; batch update promotes it', async () => {
    const router = createFakeRuntimeRouter();
    installRuntime(router);
    const generationId = firstSeededGenerationId(router);

    const pooled = await placeGeneration({ projectSlug: PROJECT, shotId: SHOT, generationId, timelineFrame: null });
    let read = await fetchProjectPlacements(PROJECT);
    expect(read.config.clips.find((c) => c.id === `clip-${pooled.entryId}`)).toBeUndefined();
    expect(pooled.timelineFrame).toBeNull();

    const [promoted] = await batchUpdatePlacementFrames({
      projectSlug: PROJECT,
      shotId: SHOT,
      updates: [{ entryId: pooled.entryId, timelineFrame: 3 }],
    });
    expect(promoted.timelineFrame).toBe(3);
    read = await fetchProjectPlacements(PROJECT);
    expect(read.config.clips.some((c) => c.source_uuid === pooled.entryId)).toBe(true);
  });

  it('unplacing with keepAsPooled drops the clip but keeps membership', async () => {
    const router = createFakeRuntimeRouter();
    installRuntime(router);
    const generationId = firstSeededGenerationId(router);

    const placed = await placeGeneration({ projectSlug: PROJECT, shotId: SHOT, generationId });
    await unplaceGeneration({
      projectSlug: PROJECT,
      shotId: SHOT,
      entryId: placed.entryId,
      generationId,
      keepAsPooled: true,
    });

    const read = await fetchProjectPlacements(PROJECT);
    expect(read.config.clips.some((c) => c.source_uuid === placed.entryId)).toBe(false);
    expect(read.byShot.get(SHOT)?.[0]?.timelineFrame).toBeNull();
  });

  it('a concurrent publish between load and save engages the stale-head retry, not a lost update', async () => {
    const router = createFakeRuntimeRouter();
    installRuntime(router);
    const generationId = firstSeededGenerationId(router);

    // A sibling publish lands after our load and before our publish.
    runtime.beforePublish = () => {
      const sibling = structuredClone(runtime.config) as { clips: unknown[] };
      sibling.clips = [{ id: 'sibling', track: 'V1', at: 0, hold: 1 }];
      runtime.config = sibling;
      runtime.head = 'rev-sibling';
    };

    const placed = await placeGeneration({ projectSlug: PROJECT, shotId: SHOT, generationId });
    expect(placed.entryId).toContain(SHOT);
    expect(runtime.publishes).toHaveLength(1);
    const read = await fetchProjectPlacements(PROJECT);
    expect(read.config.clips.map((clip) => clip.id)).toContain('sibling');
    expect(read.byShot.get(SHOT)?.map((r) => r.generationId)).toEqual([generationId]);
  });

  it('gallery rows walk the R12 pages for the merge view', async () => {
    const router = createFakeRuntimeRouter();
    installRuntime(router);
    const rows = await fetchGalleryRows(PROJECT);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.primaryMediaId).toBeTruthy();
  });
});

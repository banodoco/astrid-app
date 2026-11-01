import { describe, expect, it, vi } from 'vitest';
import { AstridRuntimeClient, RuntimeAuthenticationError, RUNTIME_CLIENT_SCOPES } from './client.ts';
import { acceptedCommit, fixtureDigest } from './__tests__/timelineCommitFixture.ts';
import { RuntimeDataProvider, toRuntimePublication } from './dataProvider.ts';
import { TimelineSaveError, TimelineSchemaIncompatibleError } from '@/tools/video-editor/data/DataProvider.ts';
import { createTimelineReader } from '@/tools/video-editor/lib/timeline-reader.ts';
import { buildTimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import {
  RUNTIME_SCHEMA_DIGEST,
  RUNTIME_TARGETED_EXECUTION_CAPABILITY,
} from './contract-metadata.ts';
import { createDefaultTimelineConfig } from '@/tools/video-editor/lib/defaults.ts';
import type { ProjectObjectMetadata } from '@astrid/editor-sdk';
import { MANAGED_OBJECT_DIGEST, MANAGED_OBJECT_ID, PROJECT_ID, TIMELINE_ID, json, runtimeFixture } from '@/test/fakeWorkspaceRuntime.ts';
import type { MediaSelection, MediaSelectionQuery, VerifiedMedia } from './generated.ts';

const MANAGED_OBJECT_URL = `http://runtime.test/v1/objects/${encodeURIComponent(MANAGED_OBJECT_ID)}`;

function publicTimelineTransport(
  fixture: ReturnType<typeof runtimeFixture>,
  delegate: ReturnType<typeof runtimeFixture>['transport'] = fixture.transport,
): ReturnType<typeof runtimeFixture>['transport'] {
  const path = `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`;
  return async (method, requestPath, headers, body) => {
    if (method === 'GET' && requestPath === path) {
      try {
        return await delegate(method, requestPath, headers, body);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('retired mutable timeline GET')) throw error;
        const current = fixture.read();
        return { status: 200, headers: {}, body: json({
          project_id: PROJECT_ID,
          timeline_id: TIMELINE_ID,
          head_revision_id: current.headRevisionId,
          head_publication_id: 'publication-current',
        }) };
      }
    }
    return delegate(method, requestPath, headers, body);
  };
}

function restoreHeadResource(overrides: Record<string, unknown> = {}) {
  return {
    project_id: PROJECT_ID, timeline_id: TIMELINE_ID, version: 1, name: 'Main',
    archived: false, shots: [], references: [],
    head_revision_id: 'parent-r1', head_publication_id: 'publication-current',
    ...overrides,
  };
}

function preparedMediaSelection(overrides: Partial<MediaSelection> = {}): MediaSelection {
  return {
    asset: 'prepared-video',
    generation_id: 'generation-prepared',
    variant_id: 'variant-prepared',
    object_id: MANAGED_OBJECT_DIGEST,
    catalog_digest: `sha256:${'c'.repeat(64)}`,
    ...overrides,
  };
}

function verifiedMediaPath(projectId: string, selection: MediaSelection): string {
  return `/v1/projects/${encodeURIComponent(projectId)}/media-selection/verified?asset=${encodeURIComponent(selection.asset)}&generation_id=${encodeURIComponent(selection.generation_id)}&variant_id=${encodeURIComponent(selection.variant_id)}&object_id=${encodeURIComponent(selection.object_id)}&catalog_digest=${encodeURIComponent(selection.catalog_digest)}`;
}

// Saved R5 compact composition: 320x180/30 fps, three ordinary parent clips,
// no child occurrences (L3-managed-reconcile-normal-retry-result.md).
function compactParentComposition() {
  const config = {
    ...createDefaultTimelineConfig(),
    output: { ...createDefaultTimelineConfig().output, resolution: '320x180', fps: 30 },
    tracks: [...createDefaultTimelineConfig().tracks!, { id: 'Overlay', kind: 'visual' as const, label: 'Overlay' }],
    app: { extensionSentinel: { enabled: true } },
    customConfig: { sentinel: 'keep-config' },
  };
  const clips = [
    {
      id: 'l3-scene', track: 'V1', at: 0, from: 63, to: 65, speed: 1,
      clipType: 'haus.astrid.liveScene',
      app: { liveScene: { revision: 'sha256:7c036c46ba2c4fedbf911a72b694c8c6ab2f5dd3211d4023857809a4bbc7fe6b', html: '<html>scene fixture</html>' } },
    },
    { id: 'l3-label', track: 'Overlay', at: 0.5, hold: 1, text: 'Maple Hollow' },
    { id: 'l3-tone', track: 'A1', at: 0.4, from: 0, to: 0.6, volume: 0.8, asset: 'tone' },
  ];
  const registry = {
    assets: { tone: {
      file: 'tone.wav', type: 'audio' as const, duration: 0.6,
      media_id: 'sha256:fa17b6d0dc1e6ca7aed9833b0ceded944644f12b22964f081d7a982427f8ac29',
      content_sha256: 'sha256:fa17b6d0dc1e6ca7aed9833b0ceded944644f12b22964f081d7a982427f8ac29',
      metadata: { provenance: { sourceProvider: 'runtime-fixture' } },
    } },
    customRegistry: { sentinel: 'keep-registry' },
  };
  return { config, registry, clips, occurrences: [], tracks: config.tracks, provenance: { sentinel: 'keep-parent' } };
}

describe('RuntimeDataProvider', () => {
  it('reads exact verified media through the project-scoped Runtime facade without writing canonical state', async () => {
    const fixture = runtimeFixture();
    const selection = preparedMediaSelection();
    const verified: VerifiedMedia = {
      selection: { ...selection },
      media_type: 'video/mp4',
      size: 123,
      duration_seconds: 4,
      width: 1920,
      height: 1080,
    };
    const path = verifiedMediaPath(PROJECT_ID, selection);
    const verifiedRequests: string[] = [];
    const transport: typeof fixture.transport = async (method, requestPath, headers, body) => {
      if (method === 'GET' && requestPath === path) {
        verifiedRequests.push(requestPath);
        return { status: 200, headers: {}, body: json(verified) };
      }
      return fixture.transport(method, requestPath, headers, body);
    };
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: publicTimelineTransport(fixture, transport) });

    await expect(provider.getProjectVerifiedMedia(PROJECT_ID, selection)).resolves.toEqual(verified);
    expect(verifiedRequests).toEqual([path]);
    expect(fixture.requests.filter(({ method, path: requestPath }) => method !== 'GET'
      && requestPath !== '/v1/handshake')).toEqual([]);
  });

  it('reads the exact project media selection through the authenticated Runtime facade', async () => {
    const fixture = runtimeFixture();
    const query: MediaSelectionQuery = {
      asset: 'asset-popup', generation_id: 'generation-popup', variant_id: 'variant-popup',
    };
    const selected: MediaSelection = {
      ...query,
      object_id: MANAGED_OBJECT_DIGEST,
      catalog_digest: `sha256:${'d'.repeat(64)}`,
    };
    const path = `/v1/projects/${encodeURIComponent(PROJECT_ID)}/media-selection?asset=${encodeURIComponent(query.asset)}&generation_id=${encodeURIComponent(query.generation_id)}&variant_id=${encodeURIComponent(query.variant_id)}`;
    const selectionRequests: string[] = [];
    const transport: typeof fixture.transport = async (method, requestPath, headers, body) => {
      if (method === 'GET' && requestPath === path) {
        selectionRequests.push(requestPath);
        return { status: 200, headers: {}, body: json(selected) };
      }
      return fixture.transport(method, requestPath, headers, body);
    };
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: publicTimelineTransport(fixture, transport) });

    await expect(provider.getProjectMediaSelection(PROJECT_ID, query)).resolves.toEqual(selected);
    expect(selectionRequests).toEqual([path]);
    expect(fixture.requests.filter(({ method, path: requestPath }) => method !== 'GET'
      && requestPath !== '/v1/handshake')).toEqual([]);
  });

  it('refreshes the immutable basis when polling sees a new publication at the same revision', async () => {
    const fixture = runtimeFixture();
    let publicationId = 'publication-p1';
    const publicPath = `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`;
    const transport: typeof fixture.transport = async (method, path, headers, body) => {
      if (method === 'GET' && path === publicPath) {
        return { status: 200, headers: {}, body: json({
          project_id: PROJECT_ID,
          timeline_id: TIMELINE_ID,
          head_revision_id: 'parent-r1',
          head_publication_id: publicationId,
        }) };
      }
      return fixture.transport(method, path, headers, body);
    };
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport });

    const initial = await provider.loadTimeline(TIMELINE_ID);
    publicationId = 'publication-p2';
    const polled = await provider.loadTimeline(TIMELINE_ID, { poll: true });

    expect(initial.head).toEqual({ projectId: PROJECT_ID, timelineId: TIMELINE_ID, headRevisionId: 'parent-r1', headPublicationId: 'publication-p1' });
    expect(polled.head).toEqual({ projectId: PROJECT_ID, timelineId: TIMELINE_ID, headRevisionId: 'parent-r1', headPublicationId: 'publication-p2' });
    expect(polled.config).toEqual(initial.config);
    expect(polled.configVersion).toBe(2);
    expect(fixture.requests.filter((request) => request.path.endsWith('/composition-revisions/parent-r1'))).toHaveLength(2);
  });

  it('freezes the original five-field selection before an asynchronous read', async () => {
    const fixture = runtimeFixture();
    const selection = preparedMediaSelection();
    const original = { ...selection };
    const path = verifiedMediaPath(PROJECT_ID, selection);
    let releaseRead!: () => void;
    const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
    const transport: typeof fixture.transport = async (method, requestPath, headers, body) => {
      if (method === 'GET' && requestPath === path) {
        await readReleased;
        return { status: 200, headers: {}, body: json({ selection: original, media_type: 'video/mp4', size: 123 }) };
      }
      return fixture.transport(method, requestPath, headers, body);
    };
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: publicTimelineTransport(fixture, transport) });
    const pending = provider.getProjectVerifiedMedia(PROJECT_ID, selection);
    selection.asset = 'mutated-after-read-start';
    releaseRead();

    await expect(pending).resolves.toMatchObject({ selection: original });
    expect(selection).toEqual({ ...original, asset: 'mutated-after-read-start' });
  });

  it('rejects a verified response with a different selection', async () => {
    const fixture = runtimeFixture();
    const selection = preparedMediaSelection();
    const path = verifiedMediaPath(PROJECT_ID, selection);
    const transport: typeof fixture.transport = async (method, requestPath, headers, body) => {
      if (method === 'GET' && requestPath === path) {
        return { status: 200, headers: {}, body: json({
          selection: { ...selection, variant_id: 'variant-other' }, media_type: 'video/mp4', size: 123,
        }) };
      }
      return fixture.transport(method, requestPath, headers, body);
    };
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: publicTimelineTransport(fixture, transport) });

    await expect(provider.getProjectVerifiedMedia(PROJECT_ID, selection)).rejects.toThrow(
      'Workspace Runtime verified media read returned a mismatched selection',
    );
  });

  it('propagates the existing Runtime read failure without a fallback', async () => {
    const fixture = runtimeFixture();
    const selection = preparedMediaSelection();
    const path = verifiedMediaPath(PROJECT_ID, selection);
    const transport: typeof fixture.transport = async (method, requestPath, headers, body) => {
      if (method === 'GET' && requestPath === path) {
        return { status: 409, headers: {}, body: json({ code: 'selection_mismatch', message: 'original selection is stale' }) };
      }
      return fixture.transport(method, requestPath, headers, body);
    };
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: publicTimelineTransport(fixture, transport) });

    await expect(provider.getProjectVerifiedMedia(PROJECT_ID, selection)).rejects.toThrow(
      'selection_mismatch: original selection is stale',
    );
  });

  it('rejects another project before using the verified read transport', async () => {
    const fixture = runtimeFixture();
    const selection = preparedMediaSelection();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: publicTimelineTransport(fixture) });

    await expect(provider.getProjectVerifiedMedia('project-other', selection)).rejects.toThrow(
      `Workspace Runtime verified media read requires project ${PROJECT_ID}, got project-other`,
    );
    expect(fixture.requests).toEqual([]);
  });

  it('reads placements from the parent payload already used by timeline rows', async () => {
    const fixture = runtimeFixture({ parentComposition: {
      ...compactParentComposition(),
      occurrences: [{
        occurrence_id: 'occ-opening', shot_id: 'chapter-opening',
        shot_revision_id: 'shot-revision-1', ordinal: 0,
        at_ms: 1_000, placement: { start_ms: 1_250, track: 'old-track' },
        duration_ms: 2_000, track: 'picture',
      }],
    } });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: publicTimelineTransport(fixture) });
    await provider.loadTimeline(TIMELINE_ID);
    const placements = await provider.shotComposition.loadPlacements!({
      projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID, poll: true,
    });

    expect(placements).toEqual([{
      occurrenceId: 'occ-opening', shotId: 'chapter-opening', ordinal: 0,
      atMs: 1_250, durationMs: 2_000, trackId: 'picture',
    }]);
    expect(fixture.requests.filter((request) => request.method === 'GET'
      && request.path.endsWith(`/composition-revisions/parent-r1`))).toHaveLength(1);
  });

  it('shares the in-flight parent revision between placements and the graph', async () => {
    const fixture = runtimeFixture();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: publicTimelineTransport(fixture) });
    const request = { projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID, poll: true };

    await Promise.all([
      provider.shotComposition.loadPlacements!(request),
      provider.shotComposition.load(request),
    ]);

    expect(fixture.requests.filter((item) => item.method === 'GET'
      && item.path.endsWith('/composition-revisions/parent-r1'))).toHaveLength(1);
  });

  it('lets both polling readers observe an external head within one poll interval', async () => {
    const fixture = runtimeFixture();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: publicTimelineTransport(fixture) });
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const inspections = () => fixture.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/inspect')).length;
    try {
      await provider.loadTimeline(TIMELINE_ID, { poll: true });
      await provider.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID, poll: true });
      expect(inspections()).toBe(1);

      fixture.setHead('parent-external', {
        ...compactParentComposition(),
        config: { ...createDefaultTimelineConfig(), customConfig: { external: true } },
      });
      now = 2_000;
      const timeline = await provider.loadTimeline(TIMELINE_ID, { poll: true });
      const composition = await provider.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID, poll: true });

      expect(timeline.config.customConfig).toEqual({ external: true });
      expect(composition).toMatchObject({ primary_timeline: { head: { revision_id: 'parent-external' } } });
      expect(inspections()).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('fetches each pinned shot and internal timeline revision once across repeated loads', async () => {
    const shotId = 'shot-cache';
    const shotRevisionId = 'shot-revision-cache';
    const internalRevisionId = 'timeline-revision-cache';
    const parentComposition = {
      ...compactParentComposition(),
      occurrences: [{
        occurrence_id: 'occ-cache',
        shot_id: shotId,
        shot_revision_id: shotRevisionId,
        at_ms: 0,
        duration_ms: 2000,
      }],
    };
    const fixture = runtimeFixture({ parentComposition });
    const revisionReads: string[] = [];
    const provider = new RuntimeDataProvider({
      projectId: PROJECT_ID,
      baseUrl: 'http://runtime.test',
      token: 'fixture-token',
      transport: publicTimelineTransport(fixture, async (method, path, headers, body) => {
        if (method === 'GET' && path === `/v1/projects/${PROJECT_ID}/shots/${shotId}/revisions/${shotRevisionId}`) {
          revisionReads.push(path);
          return { status: 200, headers: {}, body: json({
            project_id: PROJECT_ID,
            shot_id: shotId,
            revision_id: shotRevisionId,
            timeline_id: TIMELINE_ID,
            internal_timeline_revision_id: internalRevisionId,
            content_digest: 'sha256:shot-cache',
            payload: { timing: { duration_ms: 2000 } },
          }) };
        }
        if (method === 'GET' && path === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/revisions/${internalRevisionId}`) {
          revisionReads.push(path);
          return { status: 200, headers: {}, body: json({
            project_id: PROJECT_ID,
            timeline_id: TIMELINE_ID,
            revision_id: internalRevisionId,
            content_digest: 'sha256:timeline-cache',
            payload: { timeline: { clips: [] } },
          }) };
        }
        return fixture.transport(method, path, headers, body);
      }),
    });

    await Promise.all(Array.from({ length: 3 }, () => provider.shotComposition.loadAtHead!({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID, headRevisionId: 'parent-r1' })));
    await provider.shotComposition.loadAtHead!({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID, headRevisionId: 'parent-r1' });

    expect(revisionReads).toEqual([
      `/v1/projects/${PROJECT_ID}/shots/${shotId}/revisions/${shotRevisionId}`,
      `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/revisions/${internalRevisionId}`,
    ]);
  });

  it('reuses an unchanged parent revision payload and fetches a changed head', async () => {
    const fixture = runtimeFixture();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'fixture-token', transport: publicTimelineTransport(fixture) });
    const revisionPath = `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/composition-revisions/`;
    const revisionReads = (revisionId: string) => fixture.requests.filter((request) => (
      request.method === 'GET' && request.path === `${revisionPath}${revisionId}`
    )).length;

    await provider.loadTimeline(TIMELINE_ID);
    await provider.loadTimeline(TIMELINE_ID);
    expect(revisionReads('parent-r1')).toBe(1);

    fixture.setHead('parent-r2', {
      ...compactParentComposition(),
      config: { ...createDefaultTimelineConfig(), customConfig: { revision: 2 } },
    });
    await provider.loadTimeline(TIMELINE_ID);
    expect(revisionReads('parent-r2')).toBe(1);
    expect((await provider.loadTimeline(TIMELINE_ID)).config.customConfig).toEqual({ revision: 2 });
    // A fresh explicit read must also move the shared poll head forward.
    expect((await provider.loadTimeline(TIMELINE_ID, { poll: true })).config.customConfig).toEqual({ revision: 2 });
    expect(revisionReads('parent-r2')).toBe(1);
  });

  it('retries an immutable revision read after the in-flight request is rejected', async () => {
    const shotId = 'shot-retry';
    const shotRevisionId = 'shot-revision-retry';
    const internalRevisionId = 'timeline-revision-retry';
    const parentComposition = {
      ...compactParentComposition(),
      occurrences: [{ occurrence_id: 'occ-retry', shot_id: shotId, shot_revision_id: shotRevisionId, at_ms: 0, duration_ms: 2000 }],
    };
    const fixture = runtimeFixture({ parentComposition });
    let shotReads = 0;
    const provider = new RuntimeDataProvider({
      projectId: PROJECT_ID,
      transport: async (method, path, headers, body) => {
        if (method === 'GET' && path.endsWith(`/shots/${shotId}/revisions/${shotRevisionId}`)) {
          shotReads += 1;
          if (shotReads === 1) return { status: 503, headers: {}, body: json({ code: 'unavailable', message: 'try again' }) };
          return { status: 200, headers: {}, body: json({
            project_id: PROJECT_ID, shot_id: shotId, revision_id: shotRevisionId, timeline_id: TIMELINE_ID,
            internal_timeline_revision_id: internalRevisionId, content_digest: 'sha256:retry', payload: { timing: { duration_ms: 2000 } },
          }) };
        }
        if (method === 'GET' && path.endsWith(`/timelines/${TIMELINE_ID}/revisions/${internalRevisionId}`)) {
          return { status: 200, headers: {}, body: json({
            project_id: PROJECT_ID, timeline_id: TIMELINE_ID, revision_id: internalRevisionId,
            content_digest: 'sha256:internal-retry', payload: { timeline: { clips: [] } },
          }) };
        }
        return fixture.transport(method, path, headers, body);
      },
    });

    await expect(provider.shotComposition.loadAtHead!({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID, headRevisionId: 'parent-r1' })).rejects.toThrow();
    await expect(provider.shotComposition.loadAtHead!({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID, headRevisionId: 'parent-r1' })).resolves.toBeDefined();
    expect(shotReads).toBe(2);
  });

  it.each(['empty', 'absent'] as const)('projects top-level compact parent clips with %s config clips through direct and referenced reads', async (shape) => {
    const parent = compactParentComposition();
    const { clips: _clips, ...withoutClips } = parent.config;
    const fixture = runtimeFixture({ parentComposition: { ...parent, config: shape === 'absent' ? withoutClips : parent.config } });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'fixture-token', transport: publicTimelineTransport(fixture) });

    const loaded = await provider.loadTimeline(TIMELINE_ID);
    const referenced = await provider.loadReferencedTimeline(TIMELINE_ID);
    expect(loaded.config.clips).toEqual(parent.clips);
    expect(referenced.timeline.config).toEqual(loaded.config);
    expect(loaded.config).toMatchObject({ ...withoutClips, clips: parent.clips });
    expect(referenced.registry).toEqual(parent.registry);
    expect(await referenced.resolveAssetUrl('tone.wav')).toContain(encodeURIComponent(parent.registry.assets.tone.media_id));
    expect(fixture.read().parentComposition).toEqual({ ...parent, config: shape === 'absent' ? withoutClips : parent.config });
    expect(fixture.read().parentComposition.occurrences).toEqual([]);
  });

  it.each(['absent', 'empty', 'equal'] as const)('preserves legacy config clips with %s top-level clips', async (shape) => {
    const parent = compactParentComposition();
    const { clips: _clips, ...withoutClips } = parent;
    // Equal dicts remain equal when their JSON member insertion order differs.
    const reversedKeys = parent.clips.map((clip) => Object.fromEntries(Object.entries(clip).reverse()));
    const fixture = runtimeFixture({ parentComposition: {
      ...withoutClips,
      clips: shape === 'absent' ? undefined : shape === 'empty' ? [] : reversedKeys,
      config: { ...parent.config, clips: parent.clips },
    } });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'fixture-token', transport: publicTimelineTransport(fixture) });
    expect((await provider.loadTimeline(TIMELINE_ID)).config.clips).toEqual(parent.clips);
    expect((await provider.loadReferencedTimeline(TIMELINE_ID)).timeline.config.clips).toEqual(parent.clips);
  });

  it('preserves empty legacy timelines', async () => {
    const fixture = runtimeFixture();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'fixture-token', transport: publicTimelineTransport(fixture) });
    expect((await provider.loadTimeline(TIMELINE_ID)).config).toEqual(createDefaultTimelineConfig());
  });

  it.each(['edit', 'reorder'] as const)('rejects conflicting non-empty clip lists on %s without publishing', async (conflict) => {
    const parent = compactParentComposition();
    const clips = conflict === 'edit'
      ? parent.clips.map((clip, index) => index === 0 ? { ...clip, at: 1 } : clip)
      : [...parent.clips].reverse();
    const fixture = runtimeFixture({ parentComposition: { ...parent, config: { ...parent.config, clips } } });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'fixture-token', transport: publicTimelineTransport(fixture) });
    await expect(provider.loadTimeline(TIMELINE_ID)).rejects.toThrow('clips disagree');
    await expect(provider.loadReferencedTimeline(TIMELINE_ID)).rejects.toBeInstanceOf(TimelineSchemaIncompatibleError);
    await expect(provider.saveTimelineAtHead(TIMELINE_ID, createDefaultTimelineConfig(), { projectId: PROJECT_ID, timelineId: TIMELINE_ID, headRevisionId: 'parent-r1' })).rejects.toBeInstanceOf(TimelineSchemaIncompatibleError);
    expect(fixture.requests.some((request) => request.path.endsWith('/composition-revisions'))).toBe(false);
  });

  it.each([
    { location: 'parent', value: null }, { location: 'parent', value: {} },
    { location: 'config', value: null }, { location: 'config', value: 'clips' },
  ])('rejects malformed $location clips ($value)', async ({ location, value }) => {
    const parent = compactParentComposition();
    const fixture = runtimeFixture({ parentComposition: location === 'parent'
      ? { ...parent, clips: value }
      : { ...parent, config: { ...parent.config, clips: value } } });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'fixture-token', transport: publicTimelineTransport(fixture) });
    await expect(provider.loadTimeline(TIMELINE_ID)).rejects.toBeInstanceOf(TimelineSchemaIncompatibleError);
    await expect(provider.loadReferencedTimeline(TIMELINE_ID)).rejects.toThrow('clips are invalid');
  });

  ;

  it('preserves the local draft and performs no writes after a same-realm Runtime restart', async () => {
    vi.stubEnv('VITE_WORKSPACE_RUNTIME_EXPECTED_ACTOR_ID', 'astrid-product-connector');
    vi.stubEnv('VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID', 'realm-r1');
    vi.stubEnv('VITE_WORKSPACE_RUNTIME_EXPECTED_INSTANCE_ID', 'runtime-instance-r1');
    try {
      const options = { runtimeInstanceId: 'runtime-instance-r1' };
      const fixture = runtimeFixture(options);
      const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: publicTimelineTransport(fixture) });
      const initial = await provider.loadTimeline(TIMELINE_ID);
      const draft = { ...initial.config, clips: [{ id: 'unsaved-local', track: 'track-frame', clipType: 'hold', at: 0, hold: 2 }] };
      const preserved = structuredClone(draft);
      const stored = structuredClone(fixture.read());
      const restartRequestOffset = fixture.requests.length;
      options.runtimeInstanceId = 'replacement-runtime-same-realm';
      await expect(provider.reconnect()).rejects.toThrow('Runtime restarted—relaunch workspace');
      await expect(provider.saveTimelineAtHead(TIMELINE_ID, draft, initial.head!))
        .rejects.toThrow('Runtime restarted—relaunch workspace');
      expect(draft).toEqual(preserved);
      expect(fixture.read()).toEqual(stored);
      expect(fixture.requests.slice(restartRequestOffset).filter(({ method, path }) => method !== 'GET' && path !== '/v1/handshake'))
        .toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses the retired head-save route without changing the canonical head', async () => {
    const fixture = runtimeFixture();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: publicTimelineTransport(fixture) });
    const initial = await provider.loadTimeline(TIMELINE_ID);
    const before = fixture.read();

    const error = await provider.saveTimelineAtHead(TIMELINE_ID, initial.config, initial.head!).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: 'schema_incompatible' });
    expect((error as Error).message).toContain('retired_route');
    expect(fixture.requests.filter((request) => request.method === 'POST'
      && request.path.endsWith('/composition-revisions'))).toHaveLength(1);
    expect(fixture.read()).toEqual(before);
  });

  it('fails closed when the canonical base has contradictory clip copies', async () => {
    const fixture = runtimeFixture({
      initialClips: [{ id: 'canonical', at: 0, track: 'V1', clipType: 'media' }],
    });
    const transport: typeof fixture.transport = async (...args) => {
      const response = await fixture.transport(...args);
      if (args[0] === 'GET' && args[1].endsWith('/composition-revisions/parent-r1')) {
        const payload = JSON.parse(new TextDecoder().decode(response.body)) as { payload: { config: { clips: unknown[] } } };
        payload.payload.config.clips = [{ id: 'different', at: 0, track: 'V1', clipType: 'media' }];
        return { ...response, body: json(payload) };
      }
      return response;
    };
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: publicTimelineTransport(fixture, transport) });
    // A corrupt immutable base is refused at read as well as at publication.
    // No successful load/head can be obtained from contradictory authorities.
    await expect(provider.loadTimeline(TIMELINE_ID)).rejects.toMatchObject({
      code: 'schema_incompatible',
    });
    await expect(provider.saveTimelineAtHead(TIMELINE_ID, createDefaultTimelineConfig(), {
      projectId: PROJECT_ID, timelineId: TIMELINE_ID, headRevisionId: 'parent-r1',
    })).rejects.toMatchObject({
      code: 'schema_incompatible',
    });
    expect(fixture.requests.filter((request) => (
      request.method === 'POST' && request.path.endsWith('/composition-revisions')
    ))).toHaveLength(0);
  });

  it('fails closed for numeric-only saves and heads from another project or timeline', async () => {
    const fixture = runtimeFixture();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: publicTimelineTransport(fixture) });
    const base = await provider.loadTimeline(TIMELINE_ID);
    await expect(provider.saveTimeline(TIMELINE_ID, base.config, base.configVersion)).rejects.toBeInstanceOf(TimelineSaveError);
    for (const head of [{ ...base.head!, projectId: 'another' }, { ...base.head!, timelineId: 'another' }]) {
      await expect(provider.saveTimelineAtHead(TIMELINE_ID, base.config, head)).rejects.toBeInstanceOf(TimelineSaveError);
    }
    await expect(provider.saveTimelineAtHead(TIMELINE_ID, base.config, undefined as never)).rejects.toBeInstanceOf(TimelineSaveError);
    await expect(provider.saveTimelineAtHead(TIMELINE_ID, base.config,
      { ...base.head!, headRevisionId: '' })).rejects.toBeInstanceOf(TimelineSaveError);
    expect(fixture.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/composition-revisions'))).toHaveLength(0);
  });

  it.each([true, false])('restores with both current head guards and validates the accepted closure (complete: %s)', async (complete) => {
    const fixture = runtimeFixture();
    const restoreRequests: Array<{ body: unknown; key?: string }> = [];
    let headReads = 0;
    const accepted = acceptedCommit(
      { revision_id: 'restore-parent-old', publication_id: 'publication-restored' },
      { revision_id: 'parent-r1', publication_id: 'publication-current' },
      { projectId: PROJECT_ID, timelineId: TIMELINE_ID, children: true },
    );
    if (!complete) {
      accepted.data.canonical_document.internal_timeline_revisions = [];
      accepted.data.canonical_document.dependency_manifest.internal_timelines = [];
    }
    accepted.data.commands = [{ schema_version: 1, op: 'timeline.restore', version: '1', select: null, args: {
      revision_id: 'parent-old', content_digest: accepted.data.canonical_document.parent_revision.content_digest,
    } }];
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: async (...args) => {
      if (args[0] === 'GET' && args[1] === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`) {
        headReads += 1;
        return { status: 200, headers: {}, body: json(restoreHeadResource()) };
      }
      if (args[1].endsWith('/composition-revisions/parent-old/restore')) {
        restoreRequests.push({ body: JSON.parse(new TextDecoder().decode(args[3] as Uint8Array)), key: args[2]['Idempotency-Key'] });
        accepted.receipt.idempotency_key = args[2]['Idempotency-Key'];
        accepted.receipt.request_hash = fixtureDigest({ operation: 'restoreProjectParentCompositionRevision', path: args[1], publisher: accepted.data.publisher, request: restoreRequests[0].body }).slice(7);
        return { status: 200, headers: {}, body: json(accepted) };
      }
      return fixture.transport(...args);
    } });

    const history = await provider.shotComposition.listHistory!({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID });
    expect(history.map((entry) => entry.revisionId)).toEqual(['parent-r1', 'parent-old']);
    const restored = provider.shotComposition.restoreHistory!({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID, revisionId: 'parent-old' });
    if (complete) {
      await expect(restored).resolves.toEqual({ newHead: 'restore-parent-old' });
    } else {
      await expect(restored).rejects.toThrow('missing internal revision');
    }
    expect(restoreRequests).toEqual([{
      body: { expected_head: 'parent-r1', expected_publication_id: 'publication-current' },
      key: expect.any(String),
    }]);
    expect(headReads).toBe(1);
    expect(fixture.requests.some((request) => request.path.endsWith('/inspect'))).toBe(false);
    expect(fixture.requests.some((request) => request.method === 'GET' && request.path.includes('/composition-revisions/'))).toBe(false);
  });

  it.each([
    ['missing publication', 'parent-r1', undefined],
    ['unverified publication', 'parent-r1', null],
    ['empty publication', 'parent-r1', ''],
    ['missing revision', undefined, 'publication-current'],
    ['unverified revision', null, 'publication-current'],
    ['empty revision', '', 'publication-current'],
  ])('refuses restore before send with %s', async (_label, head, publication) => {
    const fixture = runtimeFixture();
    let restoreSends = 0;
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: async (...args) => {
      if (args[1].endsWith('/restore')) restoreSends += 1;
      if (args[0] === 'GET' && args[1] === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`) {
        return { status: 200, headers: {}, body: json(restoreHeadResource({ head_revision_id: head, head_publication_id: publication })) };
      }
      return fixture.transport(...args);
    } });
    await expect(provider.shotComposition.restoreHistory!({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID, revisionId: 'parent-old' }))
      .rejects.toThrow(_label.startsWith('empty') ? 'is missing' : 'verified revision and publication');
    expect(restoreSends).toBe(0);
  });

  it.each(['project_id', 'timeline_id'])('refuses restore before send with a head from another %s', async (field) => {
    const fixture = runtimeFixture();
    let restoreSends = 0;
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: async (...args) => {
      if (args[1].endsWith('/restore')) restoreSends += 1;
      if (args[0] === 'GET' && args[1] === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`) {
        return { status: 200, headers: {}, body: json(restoreHeadResource({ [field]: 'another' })) };
      }
      return fixture.transport(...args);
    } });
    await expect(provider.shotComposition.restoreHistory!({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID, revisionId: 'parent-old' }))
      .rejects.toThrow('belongs to');
    expect(restoreSends).toBe(0);
  });

  it('preserves Runtime 409 for a stale restore pair without refreshing or falling back', async () => {
    const fixture = runtimeFixture();
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: async (...args) => {
      const [method, path, , body] = args;
      requests.push({ method, path, ...(body ? { body: JSON.parse(new TextDecoder().decode(body as Uint8Array)) } : {}) });
      if (method === 'GET' && path === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`) {
        return { status: 200, headers: {}, body: json(restoreHeadResource()) };
      }
      if (path.endsWith('/restore')) {
        return { status: 409, headers: {}, body: json({ code: 'conflict', message: 'stale restore head', request_id: 'restore-stale', details: { reason: 'stale_head' } }) };
      }
      return fixture.transport(...args);
    } });
    await expect(provider.shotComposition.restoreHistory!({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID, revisionId: 'parent-old' }))
      .rejects.toMatchObject({ status: 409, code: 'conflict', details: { reason: 'stale_head' } });
    expect(requests.filter((request) => request.path.includes(`/timelines/${TIMELINE_ID}`))).toEqual([
      { method: 'GET', path: `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}` },
      { method: 'POST', path: `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/composition-revisions/parent-old/restore`,
        body: { expected_head: 'parent-r1', expected_publication_id: 'publication-current' } },
    ]);
  });

  it('serializes canonical placement start after stale nested placement metadata', async () => {
    const publication = await toRuntimePublication({
      primary_timeline: { head: { revision_id: 'head-1' } },
      shot_revisions: [{
        shot_id: 'shot-placement',
        revision_id: 'revision-placement',
        publish: true,
        internal_timeline_revision: {
          timeline_id: TIMELINE_ID,
          revision_id: 'timeline-placement',
          publish: true,
          timeline: { tracks: [{ id: 'video', kind: 'visual' }], clips: [{ id: 'clip', at_ms: 0, duration_ms: 2000 }] },
        },
      }],
      occurrences: [{
        occurrence_id: 'occ-placement',
        shot_id: 'shot-placement',
        revision_id: 'revision-placement',
        at_ms: 1500,
        duration_ms: 2000,
        placement: { start_ms: 0, track: 'video' },
      }],
      parent_composition: { config: {}, registry: {}, clips: [] },
    }, PROJECT_ID, TIMELINE_ID, 'head-1');

    expect((publication.parent_composition as Record<string, unknown>).occurrences).toEqual([
      expect.objectContaining({
        occurrence_id: 'occ-placement',
        placement: { start_ms: 1500, track: 'video' },
      }),
    ]);
  });

  it('loads the lightbox primary from the complete paginated variant set', async () => {
    const requests: string[] = [];
    const transport = async (method: string, path: string) => {
      requests.push(`${method} ${path}`);
      if (path === '/v1/health') {
        return { status: 200, headers: {}, body: json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, runtime_epoch: 1, runtime_instance_id: 'runtime-instance-lightbox' }) };
      }
      if (path === '/v1/handshake') {
        return { status: 200, headers: {}, body: json({ protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, session_id: 'session-lightbox', actor_id: 'astrid-product-connector', realm_id: 'realm-r1', scopes: RUNTIME_CLIENT_SCOPES, capabilities: [RUNTIME_TARGETED_EXECUTION_CAPABILITY] }) };
      }
      if (path === '/v1/realm') {
        return { status: 200, headers: {}, body: json({ realm_id: 'realm-r1', display_name: 'R1 fixture', version: 1, created_at: '2026-09-11T00:00:00Z' }) };
      }
      if (path === '/v1/generations/generation-lightbox') {
        return {
          status: 200,
          headers: {},
          body: json({
            generation_id: 'generation-lightbox',
            project_id: PROJECT_ID,
            type: 'image',
            status: 'succeeded',
            metadata: {},
            version: 1,
            created_at: '2026-09-11T00:00:00Z',
            updated_at: '2026-09-11T00:00:00Z',
          }),
        };
      }
      if (path === '/v1/generations/generation-lightbox/variants?limit=200') {
        return {
          status: 200,
          headers: {},
          body: json({
            items: [{
              variant_id: 'variant-first',
              generation_id: 'generation-lightbox',
              object_id: `sha256:${'a'.repeat(64)}`,
              variant_type: 'original',
              metadata: {},
              created_at: '2026-09-11T00:00:00Z',
            }],
            next_cursor: 'variants-page-2',
          }),
        };
      }
      if (path === '/v1/generations/generation-lightbox/variants?limit=200&cursor=variants-page-2') {
        return {
          status: 200,
          headers: {},
          body: json({
            items: [{
              variant_id: 'variant-primary',
              generation_id: 'generation-lightbox',
              object_id: `sha256:${'b'.repeat(64)}`,
              variant_type: 'edit',
              metadata: { is_primary: true, media_type: 'image/jpeg' },
              created_at: '2026-09-11T00:00:00Z',
            }],
            next_cursor: null,
          }),
        };
      }
      throw new Error(`unexpected ${method} ${path}`);
    };

    const provider = new RuntimeDataProvider({
      projectId: PROJECT_ID,
      baseUrl: 'http://runtime.test',
      token: 'fixture-token',
      transport,
    });

    const loaded = await provider.loadGenerationForLightbox('generation-lightbox');
    expect(loaded).toMatchObject({
      primary_variant_id: 'variant-primary',
      media_id: `sha256:${'b'.repeat(64)}`,
      type: 'image/jpeg',
    });
    expect(loaded).not.toHaveProperty('thumbUrl');
    expect(requests).toContain('GET /v1/generations/generation-lightbox/variants?limit=200&cursor=variants-page-2');
  });

  it('returns the stable catalog identity for freshly prepared media before registry readback', async () => {
    const fixture = runtimeFixture();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'fixture-token', transport: publicTimelineTransport(fixture) });

    const prepared = await provider.prepareAsset(
      new File(['managed creative'], 'managed-creative.mp4', { type: 'video/mp4' }),
      { timelineId: TIMELINE_ID, userId: 'owner-r3' },
    );

    expect(prepared.assetId).toBe(MANAGED_OBJECT_ID);
    expect(prepared.entry).toMatchObject({ media_id: MANAGED_OBJECT_ID, generationId: 'generation-import-r3', variantId: 'variant-import-r3' });
    expect(fixture.requests.some((request) => request.method === 'POST' && request.path.endsWith('/media-imports'))).toBe(true);
    expect(fixture.requests.some((request) => request.method === 'POST' && request.path.endsWith('/objects'))).toBe(false);
    expect(prepared.entry.file).toBe(MANAGED_OBJECT_URL);
    await expect(provider.resolveAssetUrl(prepared.entry.file!))
      .resolves.toBe(MANAGED_OBJECT_URL);
  });

  it('returns an actionable error when the Runtime is down', async () => {
    const client = new AstridRuntimeClient({
      baseUrl: 'http://runtime.test',
      token: 'fixture-token',
      transport: async () => { throw new Error('connect ECONNREFUSED'); },
    });

    await expect(client.ensureSession()).rejects.toMatchObject({
      name: 'RuntimeUnavailableError',
      code: 'runtime_unavailable',
      recoveryAction: 'Start the supported Runtime and configure its authenticated connector, then retry.',
    });
  });

  it('reports rejected Runtime credentials to the page recovery seam', async () => {
    const onRuntimeError = vi.fn();
    const provider = new RuntimeDataProvider({
      projectId: PROJECT_ID,
      baseUrl: 'http://runtime.test',
      token: 'fixture-token',
      onRuntimeError,
      transport: async (method, path) => {
        if (path === '/v1/health') {
          return { status: 401, headers: {}, body: json({ code: 'unauthorized', message: 'credential rejected' }) };
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
    });

    await expect(provider.loadTimeline(TIMELINE_ID)).rejects.toBeInstanceOf(RuntimeAuthenticationError);
    expect(onRuntimeError).toHaveBeenCalledTimes(1);
    expect(onRuntimeError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'runtime_authentication',
      status: 401,
    }));
  });
});

// Accepted Pack media-locator regression retained with current provider tests.
it('returns a playable locator for a freshly prepared object before registry readback', async () => {
    const fixture = runtimeFixture();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'fixture-token', transport: publicTimelineTransport(fixture) });

    const prepared = await provider.prepareAsset(
      new File(['managed creative'], 'managed-creative.mp4', { type: 'video/mp4' }),
      { timelineId: TIMELINE_ID, userId: 'owner-r3' },
    );

    expect(prepared.entry.file).toBe(MANAGED_OBJECT_URL);
    await expect(provider.resolveAssetUrl(prepared.entry.file!))
      .resolves.toBe(MANAGED_OBJECT_URL);
  });

  it('reads and reconnects to managed media from the canonical seeded registry', async () => {
    const fixture = runtimeFixture();
    const setup = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'fixture-token', transport: publicTimelineTransport(fixture) });
    const prepared = await setup.prepareAsset(
      new File(['managed creative'], 'managed-creative.mp4', { type: 'video/mp4' }),
      { timelineId: TIMELINE_ID, userId: 'owner-r4' },
    );
    fixture.setHead('parent-media', {
      ...fixture.read().parentComposition,
      registry: { assets: { [prepared.assetId]: prepared.entry } },
    });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'fixture-token', transport: publicTimelineTransport(fixture) });

    const priorHandshakes = fixture.requests.filter((request) => request.path === '/v1/handshake').length;
    await provider.loadAssetRegistry(TIMELINE_ID);
    const ranged = await provider.readAsset(MANAGED_OBJECT_ID, [0, 3]);
    const metadata = await provider.headAsset(MANAGED_OBJECT_ID);
    await provider.reconnect();

    expect(ranged.status).toBe(206);
    expect(ranged.etag).toBe(`"${MANAGED_OBJECT_DIGEST}"`);
    expect(ranged.content_range).toBe('bytes 0-3/16');
    expect(metadata.status).toBe(200);
    expect(metadata.etag).toBe(`"${MANAGED_OBJECT_DIGEST}"`);
    expect(fixture.requests.filter((request) => request.path === '/v1/handshake')).toHaveLength(priorHandshakes + 2);
    expect(fixture.requests.find((request) => request.method === 'GET' && request.path === `/v1/objects/${encodeURIComponent(MANAGED_OBJECT_ID)}`)?.headers.Range)
      .toBe('bytes=0-3');
    expect(fixture.requests.some((request) => request.method === 'POST' && request.path.endsWith('/composition-revisions'))).toBe(false);
  });

  it('fails closed when seeded managed media identity disagrees with the object response', async () => {
    const fixture = runtimeFixture({ mediaEtag: `"sha256:${'b'.repeat(64)}"` });
    const setup = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'fixture-token', transport: publicTimelineTransport(fixture) });
    const prepared = await setup.prepareAsset(
      new File(['managed creative'], 'managed-creative.mp4', { type: 'video/mp4' }),
      { timelineId: TIMELINE_ID, userId: 'owner-r4' },
    );
    fixture.setHead('parent-media', {
      ...fixture.read().parentComposition,
      registry: { assets: { [prepared.assetId]: prepared.entry } },
    });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', token: 'fixture-token', transport: publicTimelineTransport(fixture) });

    await provider.loadAssetRegistry(TIMELINE_ID);
    await expect(provider.headAsset(MANAGED_OBJECT_ID)).rejects.toThrow('Workspace Runtime object identity mismatch');
    expect(fixture.requests.some((request) => request.method === 'POST' && request.path.endsWith('/composition-revisions'))).toBe(false);
  });

describe('verified basis loader diagnostics', () => {
  it.each([
    ['history-head', 'history', /malformed timeline history head/],
    ['next-history-head', 'history', /malformed timeline history head/],
    ['next-history-changed', 'history', /changed the captured timeline history head/],
    ['parent-identity', 'parent', /belongs to project/],
    ['parent-revision', 'parent', /identity mismatch/],
    ['parent-manifest', 'parent', /verified parent dependency manifest/],
    ['shot-identity', 'shot', /belongs to project/],
    ['shot-revision', 'shot', /identity mismatch/],
    ['shot-pin', 'shot', /Baseline shot pin mismatch/],
    ['shot-payload', 'shot', /shot payload/],
    ['internal-identity', 'internal', /belongs to project/],
    ['internal-revision', 'internal', /identity mismatch/],
    ['internal-pin', 'internal', /Baseline internal pin mismatch/],
    ['internal-payload', 'internal', /internal payload/],
    ['canonical-digest', 'parent', /parent content_digest/],
    ['canonical-shot-pin', 'shot', /shot payload disagrees/],
    ['canonical-occurrence', 'parent', /unresolved shot revision/],
    ['graph-projection', 'parent', /shot closure is missing internal revision/],
  ] as const)('does not complete unvalidated reads (%s)', async (fault, operation, message) => {
    const { withTimelineBasisDiagnostics } = await import('@/tools/video-editor/lib/timeline-basis-diagnostics.ts');
    const fixture = runtimeFixture();
    const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' },
      { revision_id: 'r0', publication_id: 'p0' }, { projectId: PROJECT_ID, timelineId: TIMELINE_ID, children: true }).data.canonical_document;
    const observations: Array<{ operation: string; operationOrdinal: number; operationState: string }> = [];
    const calls: string[] = [];
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: async (...args) => {
      const [, path] = args;
      const read = path.includes('/commits?') ? 'history' : path.includes('/composition-revisions/') ? 'parent'
        : path.includes('/shots/') ? 'shot' : path.includes('/revisions/') ? 'internal' : undefined;
      if (!read) return fixture.transport(...args);
      calls.push(read);
      const value: Record<string, unknown> = read === 'history'
        ? { items: [], next_cursor: fault.startsWith('next-history') && calls.length === 1 ? 'next' : null,
          head: { revision_id: 'r0', publication_id: 'p0' } }
        : read === 'parent' ? { ...document.parent_revision, project_id: PROJECT_ID, timeline_id: TIMELINE_ID,
          dependency_manifest: document.dependency_manifest }
        : read === 'shot' ? { ...document.shot_revisions[0], project_id: PROJECT_ID, timeline_id: 'shot-1' }
        : { ...document.internal_timeline_revisions[0], project_id: PROJECT_ID };
      if (read === 'history') {
        if (fault === 'history-head' || (fault === 'next-history-head' && calls.length === 2)) value.head = null;
        if (fault === 'next-history-changed' && calls.length === 2) value.head = { revision_id: 'other', publication_id: 'other' };
      }
      if (fault === `${read}-identity`) value.project_id = 'other-project';
      if (fault === `${read}-revision`) value.revision_id = 'other-revision';
      if (fault === 'parent-manifest' && read === 'parent') value.dependency_manifest = null;
      if (fault === `${read}-pin`) value.content_digest = `sha256:${'f'.repeat(64)}`;
      if (fault === `${read}-payload`) value.payload = null;
      if (read === 'parent' && fault === 'canonical-digest') value.content_digest = 'invalid';
      if (read === 'shot' && fault === 'canonical-shot-pin') {
        value.payload = { ...document.shot_revisions[0]!.payload, internal_timeline_revision_id: 'other' };
      }
      if (read === 'parent' && fault === 'canonical-occurrence') {
        value.payload = { ...document.parent_revision.payload, occurrences: [{ occurrence_id: 'bad', shot_id: 'missing', shot_revision_id: 'missing' }] };
      }
      if (read === 'parent' && fault === 'graph-projection') {
        value.dependency_manifest = { ...document.dependency_manifest, internal_timelines: [] };
      }
      return { status: 200, headers: {}, body: json(value) };
    } });
    await expect(withTimelineBasisDiagnostics(provider, observation => observations.push(observation),
      () => provider.loadTimelineCommandBasis(TIMELINE_ID))).rejects.toThrow(message);
    const failed = observations.filter(item => item.operation === operation).at(-1)!;
    expect(failed.operationState).toBe('refused');
    expect(observations.some(item => item.operationOrdinal === failed.operationOrdinal && item.operationState === 'end')).toBe(false);
    expect(observations.filter(item => item.operationState === 'end' && item.operation !== 'history')).toEqual([]);
    expect(observations.at(-1)).toMatchObject({ operation: 'loader', operationState: 'refused' });
    for (const start of observations.filter(item => item.operationState === 'start')) {
      expect(observations.filter(item => item.operationOrdinal === start.operationOrdinal)).toHaveLength(2);
    }
    const expectedCalls = operation === 'history' ? (fault.startsWith('next-') ? ['history', 'history'] : ['history'])
      : fault === 'graph-projection' ? ['history', 'parent', 'shot']
      : fault.startsWith('canonical-') ? ['history', 'parent', 'shot', 'internal']
      : ['history', 'parent', 'shot', 'internal'].slice(0, ['history', 'parent', 'shot', 'internal'].indexOf(operation) + 1);
    expect(calls).toEqual(expectedCalls);
  });

  it('defers immutable completion until the entire closure validates', async () => {
    const { withTimelineBasisDiagnostics } = await import('@/tools/video-editor/lib/timeline-basis-diagnostics.ts');
    const fixture = runtimeFixture();
    const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' },
      { revision_id: 'r0', publication_id: 'p0' }, { projectId: PROJECT_ID, timelineId: TIMELINE_ID, children: true }).data.canonical_document;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const internalStarted = new Promise<void>(resolve => { entered = resolve; });
    const observations: string[] = [];
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: async (...args) => {
      const [, path] = args;
      let value: unknown;
      if (path.includes('/commits?')) value = { items: [], next_cursor: null, head: { revision_id: 'r0', publication_id: 'p0' } };
      else if (path.includes('/composition-revisions/')) value = { ...document.parent_revision, project_id: PROJECT_ID,
        timeline_id: TIMELINE_ID, dependency_manifest: document.dependency_manifest };
      else if (path.includes('/shots/')) value = { ...document.shot_revisions[0], project_id: PROJECT_ID };
      else if (path.includes('/revisions/')) {
        entered();
        await gate;
        value = { ...document.internal_timeline_revisions[0], project_id: PROJECT_ID };
      } else return fixture.transport(...args);
      return { status: 200, headers: {}, body: json(value) };
    } });
    const read = withTimelineBasisDiagnostics(provider,
      ({ operation, operationState }) => observations.push(`${operation}:${operationState}`),
      () => provider.loadTimelineCommandBasis(TIMELINE_ID));
    await internalStarted;
    try {
      expect(observations).toEqual(['loader:start', 'history:start', 'history:end', 'parent:start', 'shot:start', 'internal:start']);
    } finally { release(); }
    expect((await read).canonicalDocument).toEqual(document);
    expect(observations.slice(-4)).toEqual(['parent:end', 'shot:end', 'internal:end', 'loader:end']);
  });

  it.each(['complete', 'history', 'parent', 'shot', 'internal', 'listener'] as const)(
    'observes exact immutable closure order without changing calls or faults (%s)', async boundary => {
      const { withTimelineBasisDiagnostics } = await import('@/tools/video-editor/lib/timeline-basis-diagnostics.ts');
      const fixture = runtimeFixture();
      const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' },
        { revision_id: 'r0', publication_id: 'p0' }, { projectId: PROJECT_ID, timelineId: TIMELINE_ID, children: true }).data.canonical_document;
      const fault = Object.freeze(new Error('private provider fault'));
      const calls: string[] = [];
      const observations: Array<{ operation: string; operationOrdinal: number; operationState: string }> = [];
      const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: async (...args) => {
        const [, path] = args;
        const operation = path.includes('/commits?') ? 'history' : path.includes('/composition-revisions/') ? 'parent'
          : path.includes('/shots/') ? 'shot' : path.includes('/revisions/') ? 'internal' : undefined;
        if (!operation) return fixture.transport(...args);
        calls.push(operation);
        if (operation === boundary) throw fault;
        const value = operation === 'history' ? { items: [], next_cursor: null, head: { revision_id: 'r0', publication_id: 'p0' } }
          : operation === 'parent' ? { ...document.parent_revision, project_id: PROJECT_ID, timeline_id: TIMELINE_ID, dependency_manifest: document.dependency_manifest }
          : operation === 'shot' ? { ...document.shot_revisions[0], project_id: PROJECT_ID, timeline_id: 'shot-1' }
          : { ...document.internal_timeline_revisions[0], project_id: PROJECT_ID };
        return { status: 200, headers: {}, body: json(value) };
      } });
      const read = withTimelineBasisDiagnostics(provider, observation => {
        observations.push(observation);
        if (boundary === 'listener') throw new Error('listener failure');
      }, () => provider.loadTimelineCommandBasis(TIMELINE_ID));
      if (boundary === 'complete' || boundary === 'listener') {
        expect((await read).canonicalDocument).toEqual(document);
        expect(calls).toEqual(['history', 'parent', 'shot', 'internal']);
        expect(observations.map(({ operation, operationState }) => `${operation}:${operationState}`)).toEqual([
          'loader:start', 'history:start', 'history:end', 'parent:start', 'shot:start', 'internal:start',
          'parent:end', 'shot:end', 'internal:end', 'loader:end',
        ]);
      } else {
        await expect(read).rejects.toBe(fault);
        expect(calls).toEqual(['history', 'parent', 'shot', 'internal'].slice(0, ['history', 'parent', 'shot', 'internal'].indexOf(boundary) + 1));
        expect(observations.slice(-2).map(({ operation, operationState }) => `${operation}:${operationState}`))
          .toEqual([`${boundary}:refused`, 'loader:refused']);
      }
      for (const start of observations.filter(item => item.operationState === 'start')) {
        expect(observations.filter(item => item.operationOrdinal === start.operationOrdinal)).toHaveLength(2);
      }
      expect(JSON.stringify(observations)).not.toContain('private');
    });
});

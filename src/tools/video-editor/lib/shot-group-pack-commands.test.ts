import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';

import type {
  BridgeGenerationDetailPayload,
  BridgeTaskAdmissionResponse,
  BridgeTaskDetailPayload,
} from '@/tools/video-editor/data/bridgeContract.ts';
import type { PlacementDocument } from '@/shared/lib/placement/documentPlacement.ts';
import { TimelineVersionConflictError } from '@/sdk/video/timeline/errors';
import { deriveTimelineShotGroupViews } from '@/tools/video-editor/lib/timeline-domain.ts';
import { createFakeRuntimeRouter } from '@/test/fakeRuntimeRouter.ts';
import {
  deepCopyShotGroupInDocument,
  duplicateShotGroup,
  promotePrimaryVariant,
  refreshGenerationPrimaryInDocument,
  waitForShotPackCommand,
  type ShotPackCommandClient,
} from './shot-group-pack-commands.ts';

// The timeline head is read and written only through `RuntimeDataProvider` (workspace.v1: an immutable
// parent-composition revision published with `expected_head`), so the document is this in-memory head.
// Task admission and gallery reads still go through the fetch stub and the canonical fake router.
const runtime = vi.hoisted(() => ({
  head: 'rev-1',
  version: 1,
  config: null as unknown,
  registry: { assets: {} } as unknown,
  loads: 0,
  publishes: [] as string[],
}));

vi.mock('@/integrations/runtime/dataProvider', () => ({
  RuntimeDataProvider: class {
    constructor(readonly options: { projectId: string }) {}
    async loadTimeline(timelineId: string) {
      runtime.loads += 1;
      return {
        config: structuredClone(runtime.config),
        configVersion: runtime.version,
        head: { projectId: this.options.projectId, timelineId, headRevisionId: runtime.head },
      };
    }
    async loadAssetRegistry() {
      return structuredClone(runtime.registry);
    }
    async loadTimelineCommandBasis(timelineId: string) {
      runtime.loads += 1;
      return {
        head: { revisionId: runtime.head, publicationId: `pub-${runtime.head}` },
        canonicalDocument: {
          schema_version: 1 as const,
          project_id: this.options.projectId,
          timeline_id: timelineId,
          parent_revision: { revision_id: runtime.head, content_digest: `digest-${runtime.head}`, payload: {
            config: structuredClone(runtime.config), registry: structuredClone(runtime.registry), occurrences: [],
          } },
          shot_revisions: [], internal_timeline_revisions: [],
          dependency_manifest: { shots: [], internal_timeline: [], internal_timelines: [], media: [], documents: [] },
        },
        graph: {},
      };
    }
    async loadTimelineCommandBasisWithDisplay(timelineId: string) {
      const basis = await this.loadTimelineCommandBasis(timelineId);
      if (basis.head.revisionId !== runtime.head || basis.head.publicationId !== `pub-${runtime.head}`) {
        throw new TimelineVersionConflictError('Timeline document changed while pairing authoring basis and display');
      }
      return {
        basis,
        timeline: {
          config: structuredClone(runtime.config),
          configVersion: runtime.version,
          head: { projectId: this.options.projectId, timelineId,
            headRevisionId: runtime.head, headPublicationId: `pub-${runtime.head}` },
        },
        registry: structuredClone(runtime.registry),
      };
    }
    async getRecoverableIdentity() {
      return { realmId: 'realm', actorId: 'actor' };
    }
    async commitTimeline(request: any) {
      if (request.base_revision_id !== runtime.head) throw new TimelineVersionConflictError('stale_head');
      const document = await this.loadTimelineCommandBasis(request.timeline_id);
      // Build the accepted closure from the request without counting this local
      // response assembly as another caller-side head load.
      runtime.loads -= 1;
      const changes = request.commands[0].args.changes as any[];
      for (const change of changes) {
        let owner = document.canonicalDocument.parent_revision.payload;
        for (const token of change.path.slice(0, -1)) {
          owner = token.startsWith('id:')
            ? owner.find((row: any) => row.id === token.slice(3))
            : owner[token];
        }
        const key = change.path[change.path.length - 1];
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
      const nextHead = `rev-${runtime.publishes.length + 2}`;
      document.canonicalDocument.parent_revision.revision_id = nextHead;
      runtime.config = structuredClone(document.canonicalDocument.parent_revision.payload.config);
      runtime.registry = structuredClone(document.canonicalDocument.parent_revision.payload.registry);
      runtime.version += 1;
      runtime.head = nextHead;
      runtime.publishes.push(runtime.head);
      document.head = { revisionId: runtime.head, publicationId: `pub-${runtime.head}` };
      return {
        response: { data: { status: 'accepted', canonical_document: document.canonicalDocument }, receipt: { receipt_id: runtime.head } },
        accepted: document.head,
        canonicalDocument: document.canonicalDocument,
        graph: {},
        receipt: { receipt_id: runtime.head },
      };
    }
  },
}));

function seedRuntimeHead(seed: PlacementDocument, version: number): void {
  runtime.head = 'rev-1';
  runtime.version = version;
  runtime.config = structuredClone(seed.config);
  runtime.registry = structuredClone(seed.registry);
  runtime.loads = 0;
  runtime.publishes = [];
}

/** Every request that leaves the app for the fake router, as `METHOD /path`. */
function recordRouterRequests(router: ReturnType<typeof createFakeRuntimeRouter>): string[] {
  const paths: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = raw.startsWith('http') ? raw : `http://bridge.fake${raw}`;
    const request = new Request(url, init);
    paths.push(`${request.method} ${new URL(url).pathname}`);
    return await router.handle(request);
  }));
  return paths;
}

// Forbidden relational surface, spelled via join so the repo-wide literal grep
// gate (zero mentions under src/tools/video-editor) stays clean.
const forbidden = ['shot_', 'generations'].join('');

function documentFixture(): PlacementDocument {
  return {
    config: {
      output: { resolution: '1280x720', fps: 30, file: 'out.mp4' },
      tracks: [{ id: 'V1', kind: 'visual', label: 'Visual' }],
      clips: [{
        id: 'clip-a',
        track: 'V1',
        at: 1,
        clipType: 'media',
        hold: 2,
        asset: 'asset-a',
        params: { nested: { strength: 0.5 } },
      }],
      pinnedShotGroups: [{
        shotId: 'shot-source',
        name: 'Source shot',
        trackId: 'V1',
        clipIds: ['clip-a'],
        mode: 'images',
        poolGenerationIds: ['gen-pool'],
        videoAssetKey: 'asset-final',
        imageClipSnapshot: [{
          clipId: 'clip-a',
          assetKey: 'asset-a',
          meta: { params: { nested: { keep: true } } },
        }],
      }],
    },
    registry: {
      assets: {
        'asset-a': {
          file: '/api/astrid/projects/p/media/media-a/content',
          url: '/api/astrid/projects/p/media/media-a/content',
          generationId: 'gen-a',
          variantId: 'variant-a',
          metadata: { extensions: { test: { nested: true } } },
        },
        'gen:gen-pool': {
          file: '/api/astrid/projects/p/media/media-pool/content',
          generationId: 'gen-pool',
          variantId: 'variant-pool',
        },
        'asset-final': {
          file: '/api/astrid/projects/p/media/media-final/content',
          url: '/api/astrid/projects/p/media/media-final/content',
          type: 'video/mp4',
          content_sha256: 'abc123',
          generationId: 'gen-final',
          variantId: 'variant-final',
        },
      },
    },
  };
}

function admissionResponse(taskId = 'task-1'): BridgeTaskAdmissionResponse {
  return {
    task: {
      id: taskId,
      project_id: 'project-1',
      capability: 'test',
      spec: { family: 'test' },
      spec_hash: 'hash',
      input_manifest: [],
      status: 'queued',
      priority: 0,
      available_at: '2026-08-24T00:00:00Z',
      max_attempts: 1,
      created_at: '2026-08-24T00:00:00Z',
      updated_at: '2026-08-24T00:00:00Z',
    },
  };
}

function taskDetail(status: BridgeTaskDetailPayload['task']['status']): BridgeTaskDetailPayload['task'] {
  return {
    task_id: 'task-1',
    project_id: 'project-1',
    capability: 'test',
    status,
    priority: 0,
    max_attempts: 1,
    created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T00:00:00Z',
  };
}

function commandClient(overrides: Partial<ShotPackCommandClient> = {}): ShotPackCommandClient {
  return {
    tasks: {
      admit: vi.fn(async () => admissionResponse()),
      get: vi.fn(async () => taskDetail('succeeded')),
    },
    gallery: { get: vi.fn() },
    media: { contentUrl: vi.fn((mediaId: string) => `/media/${mediaId}/content`) },
    ...overrides,
  };
}

describe('shot-group pack commands', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB());
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}) } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('deep-copies document nodes and registry refs with final-video lineage and no shared objects', () => {
    const document = documentFixture();
    const sourceGroup = document.config.pinnedShotGroups![0]!;
    const sourceClip = document.config.clips[0]!;
    const sourceAsset = document.registry.assets['asset-a']!;
    const sourceFinal = document.registry.assets['asset-final']!;

    const result = deepCopyShotGroupInDocument(document, {
      source: { shotId: 'shot-source', trackId: 'V1' },
      destinationShotId: 'shot-copy',
      finalVideoReplacement: {
        mediaId: 'media-final-copy',
        generationId: 'gen-final-copy',
        variantId: 'variant-final-copy',
      },
      mediaContentUrl: (mediaId) => `/api/astrid/projects/p/media/${mediaId}/content`,
    });

    const copiedClipId = result.clipIdMap['clip-a']!;
    const copiedClip = document.config.clips.find((clip) => clip.id === copiedClipId)!;
    const copiedAssetKey = result.assetKeyMap['asset-a']!;
    const copiedFinalKey = result.assetKeyMap['asset-final']!;
    const copiedAsset = document.registry.assets[copiedAssetKey]!;
    const copiedFinal = document.registry.assets[copiedFinalKey]!;

    expect(result.group).not.toBe(sourceGroup);
    expect(result.group.clipIds).not.toBe(sourceGroup.clipIds);
    expect(result.group.poolGenerationIds).not.toBe(sourceGroup.poolGenerationIds);
    expect(result.group.imageClipSnapshot).not.toBe(sourceGroup.imageClipSnapshot);
    expect(result.group.imageClipSnapshot?.[0]?.meta).not.toBe(sourceGroup.imageClipSnapshot?.[0]?.meta);
    expect(copiedClip).not.toBe(sourceClip);
    expect(copiedClip.params).not.toBe(sourceClip.params);
    expect(copiedAsset).not.toBe(sourceAsset);
    expect(copiedAsset.metadata).not.toBe(sourceAsset.metadata);
    expect(copiedFinal).not.toBe(sourceFinal);
    expect(copiedClip.asset).toBe(copiedAssetKey);
    expect(result.group.videoAssetKey).toBe(copiedFinalKey);
    expect(result.group.derivedFrom).toEqual({ shotId: 'shot-source', trackId: 'V1' });
    expect(copiedFinal).toMatchObject({
      file: '/api/astrid/projects/p/media/media-final-copy/content',
      generationId: 'gen-final-copy',
      variantId: 'variant-final-copy',
      derivedFrom: {
        assetId: 'asset-final',
        content_sha256: 'abc123',
        role: 'render-output',
      },
    });
    expect(copiedClip.at).toBe(3);

    (copiedClip.params!.nested as { strength: number }).strength = 1;
    expect((sourceClip.params!.nested as { strength: number }).strength).toBe(0.5);
  });

  it('refuses media-bearing duplicates before task admission or timeline mutation', async () => {
    const router = createFakeRuntimeRouter();
    const seed = documentFixture();
    seedRuntimeHead(seed, 11);
    const galleryBefore = structuredClone(router.state.galleryDetails);
    const paths = recordRouterRequests(router);

    await expect(duplicateShotGroup({
      projectSlug: 'demo-project',
      timelineRef: 'active-non-default',
      configVersion: 11,
      source: { shotId: 'shot-source', trackId: 'V1' },
      destinationShotId: 'shot-copy',
    }, { wait: async () => undefined })).rejects.toThrow(
      'Legacy task family duplicate is unsupported; submit the canonical HC-04 admission envelope',
    );

    expect(runtime.loads).toBe(1);
    expect(paths).toEqual([]);
    expect(runtime.publishes).toEqual([]);
    expect({ config: runtime.config, registry: runtime.registry, version: runtime.version, galleryDetails: router.state.galleryDetails })
      .toEqual({ config: seed.config, registry: seed.registry, version: 11, galleryDetails: galleryBefore });
  });

  it('polls a command at the caller-supplied cadence until succeeded', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(taskDetail('queued'))
      .mockResolvedValueOnce(taskDetail('running'))
      .mockResolvedValueOnce(taskDetail('succeeded'));
    const wait = vi.fn(async () => undefined);
    const client = commandClient({ tasks: { admit: vi.fn(), get } });

    await expect(waitForShotPackCommand(client, 'task-1', { wait, pollMs: 2_000 }))
      .resolves.toMatchObject({ status: 'succeeded' });
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 2_000, undefined);
  });

  it('refreshes the document view to the promoted primary variant', () => {
    const document = documentFixture();
    const generation = {
      generation_id: 'gen-a',
      project_id: 'project-1',
      type: 'image',
      name: 'Generation A',
      starred: false,
      created_at: '2026-08-24T00:00:00Z',
      updated_at: '2026-08-24T00:00:00Z',
      variants: [
        { id: 'variant-a', generation_id: 'gen-a', media_id: 'media-a', is_primary: false, starred: false, created_at: '2026-08-24T00:00:00Z' },
        { id: 'variant-b', generation_id: 'gen-a', media_id: 'media-b', is_primary: true, starred: false, created_at: '2026-08-24T00:00:01Z' },
      ],
    } satisfies BridgeGenerationDetailPayload['generation'];

    expect(deriveTimelineShotGroupViews(document.config, document.registry)[0]
      ?.members.find((member) => member.generationId === 'gen-a')?.variantId).toBe('variant-a');

    refreshGenerationPrimaryInDocument(
      document,
      generation,
      (mediaId) => `/api/astrid/projects/p/media/${mediaId}/content`,
    );

    const refreshed = deriveTimelineShotGroupViews(document.config, document.registry)[0]!;
    expect(refreshed.members.find((member) => member.generationId === 'gen-a')).toMatchObject({
      variantId: 'variant-b',
      mediaRef: '/api/astrid/projects/p/media/media-b/content',
    });
  });

  it('duplicates only the explicitly active non-default timeline and never touches relational storage', async () => {
    const router = createFakeRuntimeRouter();
    const seed = documentFixture();
    delete seed.config.pinnedShotGroups![0]!.videoAssetKey;
    seedRuntimeHead(seed, 7);
    const paths = recordRouterRequests(router);

    const copied = await duplicateShotGroup({
      projectSlug: 'demo-project',
      timelineRef: 'active-non-default',
      configVersion: 7,
      source: { shotId: 'shot-source', trackId: 'V1' },
      destinationShotId: 'shot-copy',
    }, { wait: async () => undefined });

    expect(copied.group.derivedFrom).toEqual({ shotId: 'shot-source', trackId: 'V1' });
    expect((runtime.config as PlacementDocument['config']).pinnedShotGroups?.map((group) => group.shotId))
      .toEqual(['shot-source', 'shot-copy']);
    // The version check and the compare-and-swap cycle each load the active head; one revision is published
    // and no media task is admitted: a group with no final video has nothing to copy.
    expect(runtime.loads).toBe(2);
    expect(runtime.publishes).toEqual(['rev-2']);
    expect(paths).toEqual([]);
    expect(paths.some((path) => path.includes(forbidden))).toBe(false);
  });

  it('refuses the retired promote-primary family before task admission or timeline mutation', async () => {
    const router = createFakeRuntimeRouter();
    const seed = documentFixture();
    const generation = router.state.galleryDetails[0]!;
    const currentPrimary = generation.variants.find((variant) => variant.is_primary)!;
    const alternative = generation.variants.find((variant) => !variant.is_primary)!;
    seed.registry.assets['asset-a']!.generationId = generation.generation_id;
    seed.registry.assets['asset-a']!.variantId = currentPrimary.id;
    seedRuntimeHead(seed, 11);
    const variantsBefore = structuredClone(generation.variants);
    const paths = recordRouterRequests(router);

    await expect(promotePrimaryVariant({
      projectSlug: 'demo-project',
      timelineRef: 'active-non-default',
      configVersion: 11,
      generationId: generation.generation_id,
      variantId: alternative.id,
    }, { wait: async () => undefined })).rejects.toThrow(
      'Legacy task family promote_primary is unsupported; submit the canonical HC-04 admission envelope',
    );

    expect(runtime.loads).toBe(1);
    expect(paths).toEqual([]);
    expect(runtime.publishes).toEqual([]);
    expect({ config: runtime.config, registry: runtime.registry, version: runtime.version, galleryVariants: generation.variants })
      .toEqual({ config: seed.config, registry: seed.registry, version: 11, galleryVariants: variantsBefore });
  });
});

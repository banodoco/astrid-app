import { describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB, resetFakeIndexedDB } from 'fake-indexeddb';
import fixture from '@/tools/video-editor/data/shotComposition.fixture.json';
import { RuntimeDataProvider } from './dataProvider.ts';
import type { RequestBody } from './generated.ts';
import {
  RUNTIME_SCHEMA_DIGEST,
  RUNTIME_TARGETED_EXECUTION_CAPABILITY,
} from './contract-metadata.ts';
import { RUNTIME_CLIENT_SCOPES } from './client.ts';
import { StaleWriteError } from '@/tools/video-editor/data/shotComposition.ts';
import { createShotCompositionAdapter } from '@/tools/video-editor/data/shotCompositionAdapter.ts';
import { projectCanonicalComposition } from '@/tools/video-editor/data/shotCompositionProjection.ts';
import { createShotTimelineDataProvider } from '@/tools/travel-between-images/components/shotTimelineDataProvider.ts';
import { clearTimelineDraft, loadTimelineDraft } from '@/tools/video-editor/data/timelineDraftIndexedDb.ts';

const PROJECT_ID = 'project-001';
const TIMELINE_ID = 'document-primary';

vi.stubGlobal('indexedDB', createFakeIndexedDB());

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function runtimeResponses(options: {
  headRevisionId?: string;
  childAssets?: Record<string, Record<string, unknown>>;
  manifestAudioAsset?: boolean;
  textBindings?: Record<string, unknown>[];
} = {}) {
  const headRevisionId = options.headRevisionId ?? 'timeline-rev-2';
  const graph = fixture as Record<string, any>;
  const revisions = graph.shot_revisions as Array<Record<string, any>>;
  const occurrences = (graph.occurrences as Array<Record<string, any>>).map((occurrence) => ({
    occurrence_id: occurrence.occurrence_id,
    shot_id: occurrence.shot_id,
    shot_revision_id: occurrence.revision_id,
    placement: { start_ms: occurrence.at_ms },
    source_offset: 0,
    duration_ms: occurrence.duration_ms,
    speed: 1,
    track: 'video',
    transform: {},
    gain: 1,
    mute: false,
    provenance: {},
    ...(occurrence.occurrence_id === 'occ-1' && options.textBindings
      ? { text_bindings: options.textBindings }
      : {}),
  }));
  const parent = {
    revision_id: headRevisionId,
    project_id: PROJECT_ID,
    timeline_id: TIMELINE_ID,
    content_digest: graph.primary_timeline.head.content_digest,
    payload: { config: graph.parent_composition?.config ?? {}, registry: {}, clips: [], occurrences },
    created_at: '2026-09-19T00:00:00Z',
  };
  const shots = new Map<string, Record<string, any>>();
  const internals = new Map<string, Record<string, any>>();
  for (const revision of revisions) {
    const key = `${revision.shot_id}\u0000${revision.revision_id}`;
    shots.set(key, {
      revision_id: revision.revision_id,
      project_id: PROJECT_ID,
      shot_id: revision.shot_id,
      internal_timeline_revision_id: revision.internal_timeline_revision.revision_id,
      content_digest: revision.content_digest,
      payload: {
        assets: revision.shot_id === 'shot-alpha' && options.manifestAudioAsset
          ? [...revision.assets, {
              asset_id: 'alpha-audio',
              object_id: 'object-alpha-audio',
              digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
              role: 'audio',
              scope: { project_id: PROJECT_ID },
            }]
          : revision.assets,
        generation_inputs: revision.generation_inputs,
        timing: revision.timing,
        audio: revision.audio,
        dependencies: revision.dependencies,
        provenance: revision.provenance,
      },
      created_at: '2026-09-19T00:00:00Z',
    });
    internals.set(revision.internal_timeline_revision.revision_id, {
      revision_id: revision.internal_timeline_revision.revision_id,
      project_id: PROJECT_ID,
      timeline_id: TIMELINE_ID,
      content_digest: revision.internal_timeline_revision.content_digest,
      payload: revision.shot_id === 'shot-alpha' && options.childAssets
        ? { ...revision.internal_timeline_revision.timeline, assets: options.childAssets }
        : revision.internal_timeline_revision.timeline,
      created_at: '2026-09-19T00:00:00Z',
    });
  }
  return { graph, parent, occurrences, shots, internals };
}

function fixtureTransport(options: {
  conflict?: boolean;
  initialHeadRevisionId?: string | null;
  internalRevisionUnavailable?: boolean;
  childAssets?: Record<string, Record<string, unknown>>;
  manifestAudioAsset?: boolean;
  textBindings?: Record<string, unknown>[];
  commitThenLoseFirstResponse?: boolean;
} = {}) {
  const responses = runtimeResponses({
    childAssets: options.childAssets,
    manifestAudioAsset: options.manifestAudioAsset,
    textBindings: options.textBindings,
  });
  let currentHeadRevisionId = options.initialHeadRevisionId === undefined
    ? responses.parent.revision_id
    : options.initialHeadRevisionId;
  const requests: Array<{ method: string; path: string; headers: Record<string, string>; body?: Record<string, unknown> }> = [];
  const committedParents = new Map<string, Record<string, unknown>>();
  const committedShots = new Map<string, Record<string, unknown>>();
  const committedInternals = new Map<string, Record<string, unknown>>();
  const durableReceipts = new Map<string, Record<string, unknown>>();
  let lostFirstResponse = false;
  const transport = async (method: string, path: string, headers: Record<string, string>, body?: RequestBody) => {
    const parsedBody = body
      ? JSON.parse(body instanceof Blob ? await body.text() : new TextDecoder().decode(body)) as Record<string, unknown>
      : undefined;
    requests.push({ method, path, headers, ...(parsedBody ? { body: parsedBody } : {}) });
    if (path === '/v1/health') return { status: 200, headers: {}, body: json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, runtime_epoch: 1, runtime_instance_id: 'runtime-instance-shot-composition' }) };
    if (path === '/v1/handshake') return { status: 200, headers: {}, body: json({ protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, session_id: 'session', actor_id: 'astrid-product-connector', realm_id: 'realm', scopes: [...RUNTIME_CLIENT_SCOPES], capabilities: [RUNTIME_TARGETED_EXECUTION_CAPABILITY] }) };
    if (path === '/v1/realm') return { status: 200, headers: {}, body: json({ realm_id: 'realm', display_name: 'fixture', version: 1, created_at: '2026-09-19T00:00:00Z' }) };
    if (method === 'POST' && path === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/inspect`) {
      return {
        status: 200,
        headers: {},
        body: json({
          schema: 'runtime.timeline.declared_inputs/v1',
          evidence_kind: 'declared_inputs',
          render_requested: false,
          representation: 'canonical_head',
          authority: 'runtime_parent_composition',
          project_id: PROJECT_ID,
          timeline_id: TIMELINE_ID,
          revision_id: currentHeadRevisionId ?? responses.parent.revision_id,
          head_revision_id: currentHeadRevisionId,
          is_current_head: true,
          parent_content_digest: responses.parent.content_digest,
          head_content_digest: responses.parent.content_digest,
          snapshot_digest: 'sha256:fixture-inspection',
          selectors: {},
          selection_status: 'selected',
          target_count: responses.occurrences.length,
          occurrence_count: responses.occurrences.length,
          parent_clip_count: 0,
          parent_clip_target_count: 0,
          selected_clip_count: 0,
          selected: [],
          selected_parent_clips: [],
          next_cursor: null,
        }),
      };
    }
    if (method === 'GET' && path === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`) return { status: 200, headers: {}, body: json({ timeline_id: TIMELINE_ID, project_id: PROJECT_ID, version: 1, head_revision_id: currentHeadRevisionId, archived: false, shots: [], references: [] }) };
    const compositionRevisionId = path.match(/\/composition-revisions\/([^/]+)$/)?.[1];
    if (compositionRevisionId && committedParents.has(compositionRevisionId)) {
      return { status: 200, headers: {}, body: json(committedParents.get(compositionRevisionId)) };
    }
    if (path === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/composition-revisions/${responses.parent.revision_id}`) return { status: 200, headers: {}, body: json(responses.parent) };
    if (path.startsWith(`/v1/projects/${PROJECT_ID}/shots/`) && path.includes('/revisions/')) {
      const [, shotId, revisionId] = path.match(/\/shots\/([^/]+)\/revisions\/([^/]+)$/) ?? [];
      return { status: 200, headers: {}, body: json(committedShots.get(`${shotId}\u0000${revisionId}`) ?? responses.shots.get(`${shotId}\u0000${revisionId}`)) };
    }
    if (path.startsWith(`/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/revisions/`)) {
      if (options.internalRevisionUnavailable) return { status: 404, headers: {}, body: json({ code: 'not_found', message: 'canonical internal revision unavailable' }) };
      const revisionId = path.split('/').pop() ?? '';
      return { status: 200, headers: {}, body: json(committedInternals.get(revisionId) ?? responses.internals.get(revisionId)) };
    }
    if (method === 'POST' && path === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/composition-revisions`) {
      if (options.commitThenLoseFirstResponse) {
        const idempotencyKey = headers['Idempotency-Key'];
        let receipt = durableReceipts.get(idempotencyKey);
        if (!receipt) {
          if (parsedBody?.expected_head !== currentHeadRevisionId) {
            return { status: 409, headers: {}, body: json({ code: 'conflict', message: 'parent composition head is stale', details: { reason: 'stale_head', expected_head: parsedBody?.expected_head, actual_head: currentHeadRevisionId } }) };
          }
          const parentRevisionId = String(parsedBody?.parent_revision_id);
          const parentComposition = parsedBody?.parent_composition as Record<string, unknown>;
          const payload = {
            config: parentComposition.config,
            registry: parentComposition.registry,
            clips: parentComposition.clips,
            occurrences: parentComposition.occurrences,
          };
          committedParents.set(parentRevisionId, {
            revision_id: parentRevisionId,
            project_id: PROJECT_ID,
            timeline_id: TIMELINE_ID,
            content_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            payload,
            created_at: '2026-09-19T00:00:00Z',
          });
          for (const raw of parsedBody?.shot_revisions as Array<Record<string, unknown>>) {
            committedShots.set(`${String(raw.shot_id)}\u0000${String(raw.revision_id)}`, {
              revision_id: raw.revision_id,
              project_id: PROJECT_ID,
              shot_id: raw.shot_id,
              internal_timeline_revision_id: raw.internal_timeline_revision_id,
              content_digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              payload: raw.payload,
              created_at: '2026-09-19T00:00:00Z',
            });
          }
          for (const raw of parsedBody?.internal_timeline_revisions as Array<Record<string, unknown>>) {
            committedInternals.set(String(raw.revision_id), {
              revision_id: raw.revision_id,
              project_id: PROJECT_ID,
              timeline_id: raw.timeline_id,
              content_digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
              payload: raw.payload,
              created_at: '2026-09-19T00:00:00Z',
            });
          }
          currentHeadRevisionId = parentRevisionId;
          receipt = {
            data: { revision_id: parentRevisionId },
            receipt: {
              receipt_id: 'popup-receipt',
              command_kind: 'parent_composition.publish',
              idempotency_key: idempotencyKey,
              request_hash: 'popup-request-hash',
              project_id: PROJECT_ID,
              project_seq: [2, 2],
              event_ids: ['popup-event'],
              result: { dependency_manifest: {}, content_digests: {} },
              created_at: '2026-09-19T00:00:00Z',
            },
          };
          durableReceipts.set(idempotencyKey, receipt);
          if (!lostFirstResponse) {
            lostFirstResponse = true;
            throw new Error('connection dropped after durable commit');
          }
        }
        return { status: 200, headers: {}, body: json(receipt) };
      }
      if (options.conflict) return { status: 409, headers: {}, body: json({ code: 'conflict', message: 'parent composition head is stale', details: { reason: 'stale_head', expected_head: 'timeline-rev-2', actual_head: currentHeadRevisionId } }) };
      // Simulate a concurrent writer winning immediately after this commit.
      // The provider must still resolve the receipt's returned head below.
      currentHeadRevisionId = 'timeline-rev-future';
      return { status: 200, headers: {}, body: json({ data: { revision_id: responses.parent.revision_id }, receipt: { receipt_id: 'receipt', command_kind: 'parent_composition.publish', idempotency_key: 'key', request_hash: 'hash', project_id: PROJECT_ID, project_seq: [1, 1], event_ids: ['event'], result: { dependency_manifest: { shots: [{ shot_id: 'shot-alpha', revision_id: 'rev-a', internal_timeline_revision_id: 'timeline-alpha-a', content_digest: 'sha256:aaa' }], media: [{ content_digest: 'sha256:bbb' }] }, content_digests: { 'rev-a': 'sha256:aaa' } }, created_at: '2026-09-19T00:00:00Z' } }) };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { transport, requests };
}

describe('Runtime shot-composition port', () => {
  it('replays a lost popup publication through Runtime with the same candidate and preserves stale-head drafts', async () => {
    resetFakeIndexedDB();
    const fixtureRuntime = fixtureTransport({ commitThenLoseFirstResponse: true });
    const runtime = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: fixtureRuntime.transport });
    const adapter = createShotCompositionAdapter(runtime.shotComposition);
    const composition = adapter.prepare(await runtime.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID }));
    const localComposition = { ...composition, occurrences: [composition.occurrences.find((item) => item.occurrenceId === 'occ-1')!] };
    const config = projectCanonicalComposition(localComposition).config;
    const recoveryId = `${TIMELINE_ID}:shot:occ-1`;
    const firstPopup = createShotTimelineDataProvider(config, composition, 'occ-1', adapter);

    await expect(firstPopup.saveTimeline(recoveryId, config, 1)).rejects.toThrow('connection dropped after durable commit');
    const firstPublish = fixtureRuntime.requests.find((request) => request.method === 'POST' && request.path.includes('/composition-revisions'))!;
    const reopenedPopup = createShotTimelineDataProvider(config, composition, 'occ-1', adapter);
    await reopenedPopup.loadTimeline(recoveryId);
    await expect(reopenedPopup.saveTimeline(recoveryId, config, 1)).resolves.toBe(2);

    const publishRequests = fixtureRuntime.requests.filter((request) => request.method === 'POST' && request.path.includes('/composition-revisions'));
    expect(publishRequests).toHaveLength(2);
    expect(publishRequests[1]?.headers['Idempotency-Key']).toBe(firstPublish.headers['Idempotency-Key']);
    expect(publishRequests[1]?.body?.parent_revision_id).toBe(firstPublish.body?.parent_revision_id);
    expect(publishRequests[1]?.body).toEqual(firstPublish.body);

    const stalePopup = createShotTimelineDataProvider(config, composition, 'occ-1', adapter);
    // A temporal edit would also invalidate the exact parent pause interval;
    // keep this CAS/recovery draft admitted and change its authored geometry.
    const newerDraft = { ...config, clips: config.clips.map((clip) => ({ ...clip, x: 12 })) };
    await expect(stalePopup.saveTimeline(recoveryId, newerDraft, 1)).rejects.toMatchObject({ code: 'stale_write' });
    const recovery = await loadTimelineDraft(recoveryId);
    const authoredRecoveryConfig = {
      ...newerDraft,
      tracks: newerDraft.tracks.map(({ app: _app, ...track }) => ({
        ...track,
        id: track.id.replace(/^occ-1~/, ''),
      })),
      clips: newerDraft.clips.map(({ assetEntry: _assetEntry, app: rawApp, ...clip }) => {
        const app = rawApp && typeof rawApp === 'object'
          ? Object.fromEntries(Object.entries(rawApp).filter(([key]) => (
            !['canonical', 'canonicalTiming', 'canonicalEffects', 'group'].includes(key)
          )))
          : undefined;
        return {
          ...clip,
          id: clip.id.replace(/^occ-1:/, ''),
          track: clip.track.replace(/^occ-1~/, ''),
          ...(app && Object.keys(app).length > 0 ? { app } : {}),
        };
      }),
    };
    expect(recovery?.draft).toMatchObject({
      config: authoredRecoveryConfig,
      canonicalPublication: { expectedHeadRevisionId: composition.headRevisionId },
    });
    expect(recovery?.draft.config.tracks?.every((track) => !track.app?.group)).toBe(true);
    expect(recovery?.draft.config.clips.every((clip) => !clip.app?.group)).toBe(true);
    expect(recovery?.draft.config.clips.every((clip) => (
      !['canonical', 'canonicalTiming', 'canonicalEffects'].some((key) => Object.hasOwn(clip.app ?? {}, key))
    ))).toBe(true);
    await clearTimelineDraft(recoveryId);
  });

  it('reads the project-scoped head and exact immutable closure', async () => {
    const fixtureRuntime = fixtureTransport();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: fixtureRuntime.transport });
    const loaded = await provider.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID });

    expect(loaded).toMatchObject({ project: { project_id: PROJECT_ID, document_id: TIMELINE_ID }, primary_timeline: { head: { revision_id: 'timeline-rev-2' } } });
    expect(fixtureRuntime.requests.map(({ method, path }) => `${method} ${path}`).filter((value) => value.includes('/timelines/') || value.includes('/revisions/'))).toEqual(expect.arrayContaining([
      `POST /v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/inspect`,
      `GET /v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/composition-revisions/timeline-rev-2`,
      `GET /v1/projects/${PROJECT_ID}/shots/shot-alpha/revisions/rev-a`,
      `GET /v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/revisions/timeline-alpha-a`,
    ]));
    expect(fixtureRuntime.requests.some(({ method, path }) => method === 'GET' && path === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`)).toBe(false);
    expect(fixtureRuntime.requests.some(({ path }) => path.includes('/documents/'))).toBe(false);
  });

  it('fails closed on a non-canonical inspection without consulting the mutable timeline resource', async () => {
    const fixtureRuntime = fixtureTransport();
    const provider = new RuntimeDataProvider({
      projectId: PROJECT_ID,
      transport: async (...args) => {
        const response = await fixtureRuntime.transport(...args);
        if (args[1].endsWith(`/timelines/${TIMELINE_ID}/inspect`)) {
          const body = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
          return { ...response, body: json({ ...body, representation: 'canonical_revision', is_current_head: false }) };
        }
        return response;
      },
    });

    await expect(provider.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID }))
      .rejects.toThrow('instead of canonical_head');
    expect(fixtureRuntime.requests.some(({ method, path }) => (
      method === 'GET' && path === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`
    ))).toBe(false);
  });

  it('normalizes child timeline assets into the pinned revision at the Runtime boundary', async () => {
    const fixtureRuntime = fixtureTransport({
      childAssets: {
        'alpha-audio': {
          media_id: 'object-alpha-audio',
          content_sha256: '3333333333333333333333333333333333333333333333333333333333333333',
          type: 'audio',
        },
      },
    });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: fixtureRuntime.transport });

    const loaded = await provider.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID }) as {
      shot_revisions: Array<Record<string, any>>;
    };
    const alpha = loaded.shot_revisions.find((revision) => revision.shot_id === 'shot-alpha');

    expect(alpha?.assets).toContainEqual(expect.objectContaining({
      asset_id: 'alpha-audio',
      object_id: 'object-alpha-audio',
      digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
      role: 'audio',
      scope: { project_id: PROJECT_ID },
    }));
  });

  it('rejects conflicting child and shot asset bindings before projection', async () => {
    const fixtureRuntime = fixtureTransport({
      childAssets: {
        'alpha-image': {
          media_id: 'object-conflicting-image',
          content_sha256: '4444444444444444444444444444444444444444444444444444444444444444',
          type: 'image',
        },
      },
    });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: fixtureRuntime.transport });

    await expect(provider.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID }))
      .rejects.toThrow(/conflicts with object object-alpha-image/);
  });

  it('reads a pinned shot when an unused inherited registry alternative differs from its manifest', async () => {
    const fixtureRuntime = fixtureTransport({
      childAssets: {
        'unused-old-voiceover': {
          media_id: 'object-unused-child-audio',
          content_sha256: '4444444444444444444444444444444444444444444444444444444444444444',
          type: 'audio',
        },
      },
    });
    const provider = new RuntimeDataProvider({
      projectId: PROJECT_ID,
      transport: async (...args) => {
        const response = await fixtureRuntime.transport(...args);
        if (!args[1].endsWith('/shots/shot-alpha/revisions/rev-a')) return response;
        const body = JSON.parse(new TextDecoder().decode(response.body));
        body.payload.assets.push({
          asset_id: 'unused-old-voiceover',
          object_id: 'object-unused-manifest-audio',
          digest: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
          role: 'audio',
          scope: { project_id: PROJECT_ID },
        });
        return { ...response, body: json(body) };
      },
    });
    const composition = await createShotCompositionAdapter(provider.shotComposition)
      .load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID });
    const projection = projectCanonicalComposition(composition);

    expect(composition.headRevisionId).toBe('timeline-rev-2');
    expect(composition.occurrences.find((occurrence) => occurrence.shotId === 'shot-alpha')?.revision.assets)
      .toContainEqual(expect.objectContaining({
        asset_id: 'unused-old-voiceover', object_id: 'object-unused-manifest-audio',
      }));
    expect(projection.config.clips.some((clip) => clip.asset === 'unused-old-voiceover')).toBe(false);
  });

  it('uses the selected immutable registry binding ahead of a stale top-level child assets mirror', async () => {
    const fixtureRuntime = fixtureTransport({
      childAssets: {
        'alpha-image': {
          media_id: 'object-alpha-image',
          content_sha256: '1111111111111111111111111111111111111111111111111111111111111111',
          type: 'image',
        },
      },
    });
    const provider = new RuntimeDataProvider({
      projectId: PROJECT_ID,
      transport: async (...args) => {
        const response = await fixtureRuntime.transport(...args);
        if (!args[1].endsWith('/revisions/timeline-alpha-a')) return response;
        const body = JSON.parse(new TextDecoder().decode(response.body));
        body.payload.registry = { assets: body.payload.assets };
        body.payload.assets = {
          'alpha-image': {
            media_id: 'object-stale-image',
            content_sha256: '4444444444444444444444444444444444444444444444444444444444444444',
            type: 'image',
          },
        };
        return { ...response, body: json(body) };
      },
    });
    const composition = await createShotCompositionAdapter(provider.shotComposition)
      .load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID });
    expect(projectCanonicalComposition(composition).config.registry['alpha-image'])
      .toMatchObject({ file: 'object-alpha-image', type: 'image/png' });
  });

  it('preserves an explicit manifest audio role when the child registry omits its type', async () => {
    const fixtureRuntime = fixtureTransport({
      manifestAudioAsset: true,
      childAssets: {
        'alpha-audio': {
          media_id: 'object-alpha-audio',
          content_sha256: '3333333333333333333333333333333333333333333333333333333333333333',
        },
      },
    });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: fixtureRuntime.transport });
    const raw = await provider.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID });
    const composition = createShotCompositionAdapter({ load: async () => raw }).prepare(raw);
    const projection = projectCanonicalComposition(composition);
    const audioClip = projection.config.clips.find((clip) => clip.asset === 'alpha-audio');

    expect(audioClip?.assetEntry).toMatchObject({
      file: 'object-alpha-audio',
      type: 'audio',
    });
  });

  it.each(['asset', 'asset_id'])('preserves multiple child audio bindings without synthesizing legacy aggregate audio (%s)', async (assetField) => {
    const fixtureRuntime = fixtureTransport({
      childAssets: {
        'alpha-audio': {
          media_id: 'object-alpha-audio',
          content_sha256: '3333333333333333333333333333333333333333333333333333333333333333',
          type: 'audio',
        },
      },
    });
    const voiceover = { id: 'sdk-voiceover', track: 'audio', [assetField]: 'alpha-audio', at: 0.2, from: 0.5, to: 1.5, volume: 0.7 };
    const secondVoiceover = { id: 'sdk-voiceover-2', track: 'audio', [assetField]: 'alpha-audio', at: 1.5, from: 1, to: 2, volume: 0.35 };
    const provider = new RuntimeDataProvider({
      projectId: PROJECT_ID,
      transport: async (...args) => {
        const response = await fixtureRuntime.transport(...args);
        const body = JSON.parse(new TextDecoder().decode(response.body));
        if (args[1].endsWith('/shots/shot-alpha/revisions/rev-a')) {
          delete body.payload.audio;
          delete body.payload.timing;
          body.payload.generation_inputs = {};
          body.payload.name = 'Canonical top-level name';
          body.payload.app = { opaque: { future: true } };
          body.payload.audio_bindings = [
            { binding_id: 'vo-1', clip_id: 'sdk-voiceover', asset: 'alpha-audio' },
            { binding_id: 'vo-2', clip_id: 'sdk-voiceover-2', asset: 'alpha-audio' },
          ];
        }
        if (args[1].endsWith('/revisions/timeline-alpha-a')) {
          body.payload.tracks = [{ id: 'video', kind: 'visual' }, { id: 'audio', kind: 'audio' }];
          body.payload.clips.push(voiceover, secondVoiceover);
        }
        return { ...response, body: json(body) };
      },
    });
    const raw = await provider.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID });
    const composition = createShotCompositionAdapter({ load: async () => raw }).prepare(raw);
    const alpha = composition.occurrences.find((occurrence) => occurrence.shotId === 'shot-alpha');
    expect(alpha?.revision.audio).toBeUndefined();
    expect(alpha?.revision).toMatchObject({
      name: 'Canonical top-level name',
      app: { opaque: { future: true } },
      audio_bindings: [
        { binding_id: 'vo-1', clip_id: 'sdk-voiceover', asset: 'alpha-audio' },
        { binding_id: 'vo-2', clip_id: 'sdk-voiceover-2', asset: 'alpha-audio' },
      ],
    });
    const projection = projectCanonicalComposition(composition);
    const projectedVoiceover = projection.config.clips.find((clip) => clip.id.endsWith(':sdk-voiceover'));
    expect(projectedVoiceover).toMatchObject({ from: 0.5, to: 1.5, volume: 0.7 });
    expect(projectedVoiceover?.assetEntry).toMatchObject({ file: 'object-alpha-audio', type: 'audio' });
    expect(projection.config.clips.find((clip) => clip.id.endsWith(':sdk-voiceover-2')))
      .toMatchObject({ from: 1, to: 2, volume: 0.35 });
  });

  it('loads a silent child revision without inventing an audio descriptor', async () => {
    const fixtureRuntime = fixtureTransport();
    const provider = new RuntimeDataProvider({
      projectId: PROJECT_ID,
      transport: async (...args) => {
        const response = await fixtureRuntime.transport(...args);
        const body = JSON.parse(new TextDecoder().decode(response.body));
        if (args[1].endsWith('/shots/shot-alpha/revisions/rev-a')) delete body.payload.audio;
        if (args[1].endsWith('/revisions/timeline-alpha-a')) {
          body.payload.tracks = [{ id: 'video', kind: 'visual' }];
          body.payload.clips = body.payload.clips.filter((clip: Record<string, unknown>) => clip.track !== 'audio');
        }
        return { ...response, body: json(body) };
      },
    });
    const raw = await provider.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID });
    const composition = createShotCompositionAdapter({ load: async () => raw }).prepare(raw);
    expect(composition.occurrences.find((occurrence) => occurrence.shotId === 'shot-alpha')?.revision.audio).toBeUndefined();
    expect(projectCanonicalComposition(composition).config.clips.some((clip) => clip.track === 'audio')).toBe(false);
  });

  it('publishes the complete Runtime body and reloads the committed graph', async () => {
    const fixtureRuntime = fixtureTransport();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: fixtureRuntime.transport });
    const graph = await provider.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID });
    const published = await provider.shotComposition.publish?.({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID, expectedHeadRevisionId: 'timeline-rev-2', graph: graph as any });
    const publication = fixtureRuntime.requests.find((request) => request.method === 'POST' && request.path.includes('/composition-revisions'))?.body;
    expect(publication).toMatchObject({
      project_id: PROJECT_ID,
      timeline_id: TIMELINE_ID,
      expected_head: 'timeline-rev-2',
      parent_revision_id: 'timeline-rev-2',
      parent_composition: expect.any(Object),
      shot_revisions: expect.any(Array),
      internal_timeline_revisions: expect.any(Array),
    });
    expect(publication?.content_digest).toBeUndefined();
    expect(publication?.dependency_manifest).toBeUndefined();
    expect((published as any).publication_receipt).toMatchObject({
      new_head: 'timeline-rev-2',
      changed_identities: expect.arrayContaining(['timeline-rev-2', 'shot-alpha', 'rev-a', 'timeline-alpha-a', 'sha256:bbb']),
    });
    const publishRequest = fixtureRuntime.requests.find((request) => request.method === 'POST' && request.path.includes('/composition-revisions'));
    const generatedKey = publishRequest?.headers['Idempotency-Key'] ?? '';
    expect(generatedKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/);
    expect(generatedKey).toMatch(/^astrid\.shot-composition\./);
    // The exact receipt head is read after the POST even though the mutable
    // timeline endpoint now reports a newer concurrent head.
    expect(fixtureRuntime.requests.filter((request) => request.method === 'GET' && request.path.includes('/composition-revisions/')).at(-1)?.path)
      .toContain('/composition-revisions/timeline-rev-2');
  });

  it('preserves registered occurrence text bindings across a child edit, publication, and Runtime reload', async () => {
    const textBindings = [{
      binding_id: 'registered-title-binding',
      clip_id: 'alpha-title',
      field: 'text',
      source: { kind: 'registered_text', registration_id: 'narration.title' },
    }];
    const fixtureRuntime = fixtureTransport({ commitThenLoseFirstResponse: true, textBindings });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: fixtureRuntime.transport });
    const adapter = createShotCompositionAdapter(provider.shotComposition);
    const composition = adapter.prepare(await provider.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID }));
    const occurrence = composition.occurrences.find((candidate) => candidate.occurrenceId === 'occ-1');
    expect(occurrence?.textBindings).toEqual(textBindings);

    const graph = JSON.parse(JSON.stringify(composition.contract)) as Record<string, any>;
    // Shot and internal timeline revisions are immutable and cached by id
    // (6a563f10), so a child edit publishes NEW revision ids and re-points the
    // occurrence at them, as the editor does (shotCompositionEditor.ts:595).
    // The unedited occurrence keeps the original revision.
    const originalAlpha = graph.shot_revisions.find((revision: Record<string, any>) => revision.shot_id === 'shot-alpha' && revision.revision_id === 'rev-a');
    const alphaRevision = JSON.parse(JSON.stringify(originalAlpha)) as Record<string, any>;
    alphaRevision.revision_id = 'rev-a-edited';
    alphaRevision.publish = true;
    alphaRevision.internal_timeline_revision.revision_id = 'timeline-alpha-a-edited';
    alphaRevision.internal_timeline_revision.publish = true;
    graph.shot_revisions.push(alphaRevision);
    graph.occurrences.find((candidate: Record<string, any>) => candidate.occurrence_id === 'occ-1').revision_id = 'rev-a-edited';
    alphaRevision.internal_timeline_revision.timeline.clips.push({
      id: 'alpha-title',
      clip_type: 'text',
      track: 'video',
      at_ms: 0,
      duration_ms: 2_000,
      text: 'Updated narration title',
    });
    const request = {
      projectId: PROJECT_ID,
      parentDocumentId: TIMELINE_ID,
      expectedHeadRevisionId: composition.headRevisionId,
      idempotencyKey: 'text-binding-roundtrip',
      graph,
    };

    await expect(provider.shotComposition.publish?.(request)).rejects.toThrow('connection dropped after durable commit');
    await provider.shotComposition.publish?.(request);

    const reloaded = adapter.prepare(await provider.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID }));
    const reloadedOccurrence = reloaded.occurrences.find((candidate) => candidate.occurrenceId === 'occ-1');
    const reloadedAlpha = reloaded.contract.shot_revisions.find((revision) => revision.shot_id === 'shot-alpha' && revision.revision_id === 'rev-a-edited');
    expect(reloadedOccurrence?.textBindings).toEqual(textBindings);
    expect(reloadedOccurrence?.revision.revision_id).toBe('rev-a-edited');
    expect(reloaded.occurrences.find((candidate) => candidate.occurrenceId === 'occ-2')?.revision.revision_id).toBe('rev-a');
    expect(reloadedAlpha?.internal_timeline_revision).toMatchObject({
      timeline: { clips: expect.arrayContaining([expect.objectContaining({ id: 'alpha-title', text: 'Updated narration title' })]) },
    });
    const publication = fixtureRuntime.requests.find((entry) => entry.method === 'POST' && entry.path.includes('/composition-revisions'))?.body;
    expect(publication?.parent_composition).toMatchObject({
      occurrences: expect.arrayContaining([expect.objectContaining({ occurrence_id: 'occ-1', text_bindings: textBindings })]),
    });
  });

  it('reuses a caller-provided idempotency key for lost-response retries', async () => {
    const fixtureRuntime = fixtureTransport();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: fixtureRuntime.transport });
    const graph = await provider.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID });
    const request = {
      projectId: PROJECT_ID,
      parentDocumentId: TIMELINE_ID,
      expectedHeadRevisionId: 'timeline-rev-2',
      idempotencyKey: 'retry-shot-edit-1',
      graph: graph as any,
    };
    await provider.shotComposition.publish?.(request);
    // The timeline endpoint now reports a newer head, but Runtime's durable
    // idempotency replay is allowed to return the original receipt.
    await expect(provider.shotComposition.publish?.(request)).resolves.toBeDefined();
    expect(fixtureRuntime.requests.filter((entry) => entry.method === 'POST' && entry.path.includes('/composition-revisions')))
      .toHaveLength(2);
    expect(fixtureRuntime.requests.filter((entry) => entry.method === 'POST' && entry.path.includes('/composition-revisions'))
      .every((entry) => entry.headers['Idempotency-Key'] === 'retry-shot-edit-1')).toBe(true);
  });

  it('publishes a prepared graph against a null initial Runtime head', async () => {
    const fixtureRuntime = fixtureTransport({ initialHeadRevisionId: null });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: fixtureRuntime.transport });

    await provider.shotComposition.publish?.({
      projectId: PROJECT_ID,
      parentDocumentId: TIMELINE_ID,
      expectedHeadRevisionId: null,
      graph: fixture as any,
    });

    const publication = fixtureRuntime.requests.find((request) => request.method === 'POST' && request.path.includes('/composition-revisions'))?.body;
    expect(publication).toMatchObject({ expected_head: null });
  });

  it('fails closed when the canonical immutable internal revision is unavailable', async () => {
    const fixtureRuntime = fixtureTransport({ internalRevisionUnavailable: true });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: fixtureRuntime.transport });

    await expect(provider.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID }))
      .rejects.toThrow(/canonical internal timeline revision .* unavailable/);

    const internalReads = fixtureRuntime.requests
      .map(({ method, path }) => `${method} ${path}`)
      .filter((value) => value.includes('/revisions/'));
    expect(internalReads.some((value) => value.includes(`/timelines/${TIMELINE_ID}/revisions/`))).toBe(true);
    expect(internalReads.some((value) => value.includes('/timelines/shot%3A'))).toBe(false);
    expect(fixtureRuntime.requests.some(({ path }) => path.includes('/documents/') || path.startsWith('/v1/timelines/'))).toBe(false);
  });

  it('rejects a publication graph with foreign project identity before the Runtime read', async () => {
    const fixtureRuntime = fixtureTransport();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: fixtureRuntime.transport });
    const graph = JSON.parse(JSON.stringify(fixture)) as Record<string, any>;
    graph.project.project_id = 'project-foreign';

    await expect(provider.shotComposition.publish?.({
      projectId: PROJECT_ID,
      parentDocumentId: TIMELINE_ID,
      expectedHeadRevisionId: 'timeline-rev-2',
      graph: graph as any,
    })).rejects.toThrow(/publication graph belongs to project/);
    expect(fixtureRuntime.requests).toHaveLength(0);
  });

  it('maps Runtime 409 to the existing stale-write error', async () => {
    const fixtureRuntime = fixtureTransport({ conflict: true });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport: fixtureRuntime.transport });
    const graph = await provider.shotComposition.load({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID });
    await expect(provider.shotComposition.publish?.({ projectId: PROJECT_ID, parentDocumentId: TIMELINE_ID, expectedHeadRevisionId: 'timeline-rev-2', graph: graph as any }))
      .rejects.toBeInstanceOf(StaleWriteError);
  });
});

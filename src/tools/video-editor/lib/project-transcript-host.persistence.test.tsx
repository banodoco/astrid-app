// @vitest-environment jsdom
import React, { type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB, resetFakeIndexedDB } from 'fake-indexeddb';
import { RuntimeDataProvider } from '@/integrations/runtime/dataProvider.ts';
import { type RequestBody, type Transport } from '@/integrations/runtime/generated.ts';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { runtimeFixture } from '@/test/fakeWorkspaceRuntime.ts';
import { VideoEditorRuntimeProvider, type VideoEditorRuntimeContextValue } from '../contexts/VideoEditorRuntimeContext.tsx';
import { createInteractionState, type InteractionStateRef } from './interaction-state.ts';
import { createTimelineStore } from '../hooks/timelineStore.ts';
import { useTimelineSave } from '../hooks/useTimelineSave.ts';
import { useProjectTranscriptHost } from '../hooks/useProjectTranscriptHost.ts';
import { createCommitOutbox } from '../commands/commitOutbox.ts';
import { buildTimelineData } from './timeline-data.ts';
import { createDefaultTimelineConfig } from './defaults.ts';
import { persistedTranscriptItems, transcriptDocumentId, type ProjectTranscriptDocument, type ProjectTranscriptRepository } from '../data/typed/projectTranscript.ts';
import { normalizeTranscriptSource, TRANSCRIPT_SCHEMA_REF } from '../data/typed/adaptTranscript.ts';
import { computeHostFingerprint, HOST_GENERATION_PROVENANCE_VERSION } from '@/sdk/video/timeline/sourceMap.ts';
import type { SourceFrozenDataItem } from '../data/typed/envelope.ts';
import type { AssetRegistry, TimelineConfig } from '../types/index.ts';

const PROJECT = 'project-transcript-mounted';
const TIMELINE = 'timeline-transcript-mounted';
const MEDIA = `sha256:${'a'.repeat(64)}`;
const ALIAS = 'source-media';
const HEAD = { projectId: PROJECT, timelineId: TIMELINE, headRevisionId: 'r0', headPublicationId: 'p0' };
const TRANSCRIPT_EXTENSION_ID = 'haus.astrid.transcript-lane';
const TRANSCRIPT_CONTRIBUTION_ID = 'transcript-caption-foundry';
const TRANSCRIPT_CAPTION_TRACK = 'transcript-caption-foundry-track';
const SOURCE_ID = 'reviewed';
const LEGACY_TRANSCRIPT_ID = `transcript-source:${SOURCE_ID}:segment:segment-one`;
const CANONICAL_TRANSCRIPT_ID = `transcript-source:${ALIAS}:source:${SOURCE_ID}:segment:segment-one`;
const reviewKey = (id: string) => `transcript-source-review:${encodeURIComponent(id)}`;
const captionId = (id: string) => `transcript-caption-${computeHostFingerprint(id).split(':')[1]}`;

type JsonObject = Record<string, unknown>;
type CommitChange =
  | { op: 'set' | 'remove'; ref: string; path: string[]; value?: unknown }
  | { op: 'list.remove'; ref: string; path: string[]; id: string }
  | { op: 'list.insert'; ref: string; path: string[]; id: string; value: unknown; after_id?: string };

function bodyJson(body: RequestBody | undefined): JsonObject | undefined {
  if (!body) return undefined;
  if (body instanceof Blob) return undefined;
  return JSON.parse(new TextDecoder().decode(body)) as JsonObject;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parentForPath(root: JsonObject, path: readonly string[]): { parent: JsonObject | unknown[]; key: string | number } {
  let current: JsonObject | unknown[] = root;
  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(current)) {
      const id = segment.startsWith('id:') ? segment.slice(3) : segment;
      const index = current.findIndex((row) => !!row && typeof row === 'object' && (row as JsonObject).id === id);
      if (index < 0) throw new Error(`missing patch row ${segment}`);
      current = current[index] as JsonObject;
    } else {
      const next = current[segment];
      if (!next || typeof next !== 'object') throw new Error(`missing patch parent ${path.join('.')}`);
      current = next as JsonObject | unknown[];
    }
  }
  const final = path.at(-1);
  if (final === undefined) throw new Error('empty patch path');
  if (Array.isArray(current)) {
    const id = final.startsWith('id:') ? final.slice(3) : final;
    const index = current.findIndex((row) => !!row && typeof row === 'object' && (row as JsonObject).id === id);
    return { parent: current, key: index < 0 ? id : index };
  }
  return { parent: current, key: final };
}

function applyChanges(document: JsonObject, changes: readonly CommitChange[]): JsonObject {
  const next = clone(document);
  for (const change of changes) {
    if (change.ref !== 'parent') throw new Error(`unexpected patch ref ${change.ref}`);
    if (change.op === 'list.remove' || change.op === 'list.insert') {
      const list = change.path.reduce<unknown>((value, segment) => (
        value && typeof value === 'object' ? (value as JsonObject)[segment] : undefined
      ), next.parent_revision.payload) as unknown;
      if (!Array.isArray(list)) throw new Error(`missing patch list ${change.path.join('.')}`);
      if (change.op === 'list.remove') {
        const index = list.findIndex((row) => !!row && typeof row === 'object' && (row as JsonObject).id === change.id);
        if (index < 0) throw new Error(`missing patch row ${change.id}`);
        list.splice(index, 1);
      } else {
        const after = change.after_id === undefined
          ? list.length - 1
          : list.findIndex((row) => !!row && typeof row === 'object' && (row as JsonObject).id === change.after_id);
        list.splice(after + 1, 0, clone(change.value));
      }
      continue;
    }
    const { parent, key } = parentForPath(next.parent_revision.payload as JsonObject, change.path);
    if (change.op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[String(key)];
    } else if (Array.isArray(parent)) {
      if (typeof key !== 'number') throw new Error(`missing set row ${String(key)}`);
      parent[key] = clone(change.value);
    } else {
      parent[String(key)] = clone(change.value);
    }
  }
  const payload = next.parent_revision.payload as JsonObject;
  next.parent_revision.content_digest = fixtureDigest(payload);
  next.document_digest = fixtureDigest(next);
  return next;
}

function repository(media = MEDIA): ProjectTranscriptRepository {
  const documents = new Map<string, ProjectTranscriptDocument>();
  return {
    projectId: PROJECT,
    listAll: vi.fn(async () => [...documents.values()].map(clone)),
    listForMedia: vi.fn(async (id) => [...documents.values()].filter((document) => document.content.media_id === id).map(clone)),
    get: vi.fn(async (id) => {
      const document = documents.get(id);
      if (!document) throw Object.assign(new Error('Missing transcript'), { status: 404 });
      return clone(document);
    }),
    create: vi.fn(async (content) => {
      const document_id = await transcriptDocumentId(PROJECT, content.media_id, content.source_id);
      const document: ProjectTranscriptDocument = {
        document_id,
        project_id: PROJECT,
        kind: 'media.transcript',
        content: clone(content),
        version: 1,
        created_at: 'now',
        updated_at: 'now',
      };
      documents.set(document_id, document);
      return clone(document);
    }),
    update: vi.fn(async (id, content, version) => {
      const current = documents.get(id);
      if (!current || current.version !== version) throw Object.assign(new Error('Stale transcript'), { status: 409 });
      const document = { ...current, content: clone(content), version: version + 1 };
      documents.set(id, document);
      return clone(document);
    }),
  };
}

function makeTimelineConfig(): TimelineConfig {
  const config = createDefaultTimelineConfig();
  config.clips = [{
    id: 'media-clip', asset: ALIAS, track: 'V1', at: 0, from: 0, to: 10,
    app: { opaque: { keep: [null, false, 0] }, absentIsAbsent: true },
  }, {
    id: 'sibling-clip', track: 'V1', at: 10, hold: 2,
    app: { sibling: { keep: null, order: [false, 0] } },
  }];
  return config;
}

function makeRegistry(): AssetRegistry {
  return { assets: { [ALIAS]: { file: 'source.mp4', type: 'video/mp4', media_id: MEDIA } } };
}

function makeLegacyTranscriptItem(assetId = ALIAS): SourceFrozenDataItem {
  const canonical = normalizeTranscriptSource({
    assetId,
    sourceId: SOURCE_ID,
    segments: [{
      id: 'segment-one', start: 1, end: 4, text: 'hello world', speaker: null,
      words: [{ id: 'word-one', start: 1, end: 2, text: 'hello' }],
    }],
  })[0]!;
  const oldId = `transcript-source:${SOURCE_ID}:segment:segment-one`;
  return {
    ...clone(canonical),
    id: oldId,
    payload: {
      ...(canonical.payload as JsonObject),
      segmentId: oldId,
      words: [{ id: `${oldId}:word:word-one`, start: 1, end: 2, text: 'hello' }],
    },
  };
}

function transcriptReconciliationConfig(
  config: TimelineConfig,
  options: { collision?: boolean } = {},
): TimelineConfig {
  const oldCaptionId = captionId(`${LEGACY_TRANSCRIPT_ID}@media-clip`);
  const canonicalCaptionId = captionId(`${CANONICAL_TRANSCRIPT_ID}@media-clip`);
  const extension = {
    ...(config.app?.[TRANSCRIPT_EXTENSION_ID] as JsonObject | undefined),
    [reviewKey(LEGACY_TRANSCRIPT_ID)]: {
      schemaVersion: 1,
      sourceSchemaRef: TRANSCRIPT_SCHEMA_REF,
      sourceItemId: LEGACY_TRANSCRIPT_ID,
      status: 'accepted-for-source-update',
      proposedText: 'Human correction',
      opaque: { keep: [null, false] },
    },
  };
  return {
    ...config,
    tracks: [
      ...config.tracks,
      ...(config.tracks.some((track) => track.id === TRANSCRIPT_CAPTION_TRACK)
        ? []
        : [{ id: TRANSCRIPT_CAPTION_TRACK, kind: 'visual', label: 'Captions', muted: false }]),
    ],
    clips: [
      ...config.clips,
      {
        id: oldCaptionId,
        track: TRANSCRIPT_CAPTION_TRACK,
        clipType: 'text',
        at: 0.1,
        hold: 2.3,
        text: { content: 'Human correction', color: '#cc3377', fontSize: 51 },
        app: {
          retained: { future: [null, false] },
          __generated__: {
            extensionId: TRANSCRIPT_EXTENSION_ID,
            contributionId: TRANSCRIPT_CONTRIBUTION_ID,
            provenance: {
              contractVersion: HOST_GENERATION_PROVENANCE_VERSION,
              sourceSchemaRef: TRANSCRIPT_SCHEMA_REF,
              sourceItemId: LEGACY_TRANSCRIPT_ID,
              sourceFingerprint: 'keep-source-fingerprint',
              generatorVersion: '1.3.0',
              outputFingerprint: 'keep-output-fingerprint',
              conflictPolicy: 'preserve-output',
            },
          },
        },
      },
      ...(options.collision
        ? [{ id: canonicalCaptionId, track: 'other', clipType: 'text' as const }]
        : []),
    ],
    app: {
      ...config.app,
      [TRANSCRIPT_EXTENSION_ID]: extension,
    },
  };
}

type MountOptions = {
  config?: TimelineConfig;
  sourceItems?: readonly SourceFrozenDataItem[];
  parentClips?: TimelineConfig['clips'];
};

function makeTransport(
  config: TimelineConfig,
  registry: AssetRegistry,
  parentClips: TimelineConfig['clips'] = config.clips,
  sourceItems?: readonly SourceFrozenDataItem[],
) {
  const authoredConfig = sourceItems
    ? {
        ...config,
        bundle: {
          schema_version: 1,
          itemsBySchemaRef: persistedTranscriptItems({ [TRANSCRIPT_SCHEMA_REF]: sourceItems }),
        },
      }
    : config;
  const fixture = runtimeFixture({
    projectId: PROJECT,
    timelineId: TIMELINE,
    headRevisionId: 'r0',
    parentComposition: { config: authoredConfig, registry, clips: clone(parentClips), occurrences: [] },
  });
  let revision = 'r0';
  let publication = 'p0';
  let canonical = acceptedCommit(
    { revision_id: revision, publication_id: publication },
    { revision_id: revision, publication_id: publication },
    { projectId: PROJECT, timelineId: TIMELINE },
  ).data.canonical_document as unknown as JsonObject;
  canonical.parent_revision.payload = { config: clone(authoredConfig), registry: clone(registry), clips: clone(parentClips), occurrences: [] };
  canonical.parent_revision.content_digest = fixtureDigest(canonical.parent_revision.payload);
  canonical.document_digest = fixtureDigest(canonical);
  const requests: JsonObject[] = [];
  const acceptedReplies: JsonObject[] = [];
  const wire: Array<{ body: string; key: string; path: string }> = [];
  let refuseNext = false;
  const history = () => ({ items: [], next_cursor: null, head: { revision_id: revision, publication_id: publication } });
  const transport: Transport = async (method, path, headers, body) => {
    const commitPath = `/v1/projects/${PROJECT}/timelines/${TIMELINE}/commit`;
    if (method === 'GET' && path.startsWith(`/v1/projects/${PROJECT}/timelines/${TIMELINE}/commits`)) {
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(history())) };
    }
    if (method === 'GET' && path === `/v1/projects/${PROJECT}/timelines/${TIMELINE}/composition-revisions/${revision}`) {
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
        revision_id: revision, project_id: PROJECT, timeline_id: TIMELINE,
        content_digest: (canonical.parent_revision as JsonObject).content_digest,
        payload: (canonical.parent_revision as JsonObject).payload,
        dependency_manifest: canonical.dependency_manifest,
        created_at: 'now',
      })) };
    }
    if (method === 'POST' && path === commitPath) {
      const request = bodyJson(body)!;
      requests.push(clone(request));
      wire.push({ body: body instanceof Blob ? await body.text() : new TextDecoder().decode(body as Uint8Array), key: headers['Idempotency-Key'] ?? '', path });
      if (refuseNext) {
        refuseNext = false;
        return { status: 409, headers: {}, body: new TextEncoder().encode(JSON.stringify({
          code: 'conflict', message: 'Captured transcript association changed after your base', request_id: 'refusal-1',
          details: {
            status: 'conflict', reason: 'dependency_changed', code: 'dependency_changed',
            path: ['config', 'bundle'], hint: 'Read the current timeline and reapply the transcript association',
            suggested_command: 'timeline show',
            base: { revision_id: request.base_revision_id, publication_id: request.base_publication_id },
            current: { revision_id: revision, publication_id: publication },
            conflicts: [{
              kind: 'dependency_changed', ref: 'parent', path: ['config', 'bundle'],
              base: { state: 'absent' }, theirs: { state: 'absent' },
              ours: { state: 'present', value: ((request.commands as JsonObject[])[0]!.args as JsonObject).changes },
              choices: [],
            }],
          },
        })) };
      }
      const changes = ((request.commands as JsonObject[])[0]!.args as JsonObject).changes as CommitChange[];
      const next = applyChanges(canonical, changes);
      revision = `r${requests.length}`;
      publication = `p${requests.length}`;
      next.parent_revision = { ...(next.parent_revision as JsonObject), revision_id: revision };
      next.project_id = PROJECT;
      next.timeline_id = TIMELINE;
      canonical = next;
      const accepted = acceptedCommit(
        { revision_id: revision, publication_id: publication },
        { revision_id: request.base_revision_id as string, publication_id: request.base_publication_id as string },
        { projectId: PROJECT, timelineId: TIMELINE, commands: request.commands as never },
      );
      accepted.data.canonical_document = canonical as never;
      accepted.data.document_digest = fixtureDigest(canonical);
      accepted.data.commands = request.commands as never;
      accepted.data.status = 'accepted';
      accepted.data.merge_mode = request.merge as 'fields' | 'atomic';
      accepted.data.label = request.label;
      accepted.data.source = request.source;
      const submittedStep = (request.steps as JsonObject[])[0]!;
      accepted.data.steps = [{
        ...submittedStep,
        patch: changes,
        dependencies: [{ kind: 'scope', ref: 'parent', path: [] }],
      }] as never;
      accepted.receipt.idempotency_key = headers['Idempotency-Key'] ?? '';
      accepted.receipt.request_hash = fixtureDigest({
        operation: 'commitTimeline',
        path: `/v1/projects/${PROJECT}/timelines/${TIMELINE}/commit`,
        publisher: accepted.data.publisher,
        request,
      }).slice(7);
      acceptedReplies.push(clone(accepted as unknown as JsonObject));
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(accepted)) };
    }
    return fixture.transport(method, path, headers, body);
  };
  return { transport, requests, acceptedReplies, wire, refuse: () => { refuseNext = true; }, read: () => clone(canonical) };
}

async function mount(options: MountOptions = {}) {
  const config = options.config ?? makeTimelineConfig();
  const registry = makeRegistry();
  const transportState = makeTransport(config, registry, options.parentClips, options.sourceItems);
  const provider = new RuntimeDataProvider({ projectId: PROJECT, transport: transportState.transport });
  await provider.reconnect();
  const basis = await provider.loadTimelineCommandBasis(TIMELINE);
  const data = await buildTimelineData(
    config,
    registry,
    (file) => file,
    1,
    options.sourceItems ? { [TRANSCRIPT_SCHEMA_REF]: options.sourceItems } : undefined,
    HEAD,
  );
  const repositorySurface = repository();
  const interactionStateRef: InteractionStateRef = { current: createInteractionState() };
  const store = createTimelineStore();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const runtime = {
    provider,
    project: { projectId: PROJECT },
    timelineId: TIMELINE,
    shots: { canonicalDraft: null },
    assetResolver: { resolveAssetUrl: vi.fn(async (file: string) => file) },
  } as unknown as VideoEditorRuntimeContextValue;
  const owner = {};
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <VideoEditorRuntimeProvider value={runtime}>{children}</VideoEditorRuntimeProvider>
    </QueryClientProvider>
  );
  const view = renderHook(() => {
    const save = useTimelineSave(
      { timelineQuery: { data: undefined, isLoading: false }, assetRegistryQuery: { data: undefined } },
      provider,
      interactionStateRef,
      store,
      data,
    );
    const host = useProjectTranscriptHost({
      dataRef: save.dataRef,
      repository: repositorySurface,
      commitData: save.commitData,
      flushPendingSave: save.flushPendingSave,
    }, owner, TIMELINE);
    return { save, host };
  }, { wrapper });
  await vi.waitFor(() => expect(view.result.current.save.localSaveState?.ownerId).toBeTruthy());
  return { ...view, provider, transportState, repository: repositorySurface, basis };
}

describe('mounted project transcript persistence', () => {
  beforeEach(() => {
    resetFakeIndexedDB();
    vi.stubGlobal('indexedDB', createFakeIndexedDB());
    localStorage.clear();
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (_name: string, _options: unknown, work: (lock: object) => Promise<unknown>) => work({}),
    } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('imports through the mounted host into one v2 outbox request, preserving raw transcript planes and the exact base pair', async () => {
    const mounted = await mount();
    try {
      const receipt = await act(async () => mounted.result.current.host.importTranscript({
        associationAssetId: ALIAS,
        document: {
          sourceId: 'reviewed',
          segments: [
            { id: 'segment-one', start: 1, end: 4, text: 'hello', speaker: null,
              words: [{ id: 'word-one', start: 1, end: 2, text: 'hello' }] },
            { id: 'segment-two', start: 4, end: 5, text: 'next' },
          ],
        },
      }));
      expect(receipt).toMatchObject({ associationSaved: true, sourceId: 'reviewed', importedSegments: 2 });
      expect(mounted.transportState.requests).toHaveLength(1);
      const request = mounted.transportState.requests[0]!;
      expect(request).toMatchObject({
        api_version: 1, project_id: PROJECT, timeline_id: TIMELINE,
        base_revision_id: 'r0', base_publication_id: 'p0', label: 'Edit timeline',
        merge: 'atomic', dry_run: false, source: { via: 'app' },
        commands: [{ schema_version: 1, op: 'doc.patch', version: '1', select: null, created: [] }],
        steps: [{ id: expect.any(String), label: 'Edit timeline', intent: 'Save local editor changes', tags: [], command_ordinals: [0] }],
      });
      expect(request).not.toHaveProperty('reads');
      const command = (request.commands as JsonObject[])[0]!;
      const changes = (command.args as JsonObject).changes as JsonObject[];
      expect(changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ op: 'set', ref: 'parent', path: ['config', 'bundle'], before: { state: 'absent' } }),
      ]));
      expect((request.steps as JsonObject[])[0]!.patch).toEqual(changes);
      expect(JSON.stringify(request)).toBe(JSON.stringify(mounted.transportState.requests[0]));
      expect(request).not.toHaveProperty('operation', 'transcript.associate');
      expect(request).not.toHaveProperty('metadata_authority');
      const reply = mounted.transportState.acceptedReplies[0]!;
      expect(reply).toMatchObject({
        data: {
          status: 'accepted', base_revision_id: 'r0', base_publication_id: 'p0',
          previous_revision_id: 'r0', previous_publication_id: 'p0', accepted_revision_id: 'r1',
          rebased_onto: null, document_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          commands: request.commands, id_map: {}, provider_version: expect.any(String),
          compiler_version: expect.any(String), merge_mode: 'atomic', label: 'Edit timeline',
          source: { via: 'app' }, publisher: expect.any(String),
          canonical_document: {
            schema_version: 1, project_id: PROJECT, timeline_id: TIMELINE,
            parent_revision: {
              revision_id: 'r1', content_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
              payload: expect.any(Object),
            },
            shot_revisions: [], internal_timeline_revisions: [],
            dependency_manifest: { shots: [], internal_timelines: [], media: [], documents: [] },
          },
          steps: [{
            id: (request.steps as JsonObject[])[0]!.id,
            label: 'Edit timeline', intent: 'Save local editor changes', tags: [], command_ordinals: [0],
            patch: changes, dependencies: [{ kind: 'scope', ref: 'parent', path: [] }],
          }],
        },
        receipt: {
          receipt_id: 'p1', command_kind: 'timeline.commit', idempotency_key: expect.any(String),
          request_hash: expect.stringMatching(/^[0-9a-f]{64}$/), project_id: PROJECT,
          project_seq: [1, 1], event_ids: ['event-p1'], result: expect.any(Object),
          created_at: expect.any(String),
        },
      });
      expect((reply.receipt as JsonObject).result).toEqual(reply.data);
      const bundle = ((mounted.transportState.read().parent_revision as JsonObject).payload as JsonObject).config as JsonObject;
      expect(bundle.bundle).toMatchObject({
        schema_version: 1,
        transcriptReferences: { schema: 'media.transcript.references/v1', associations: [{ assetId: ALIAS, documentId: receipt.documentId }] },
      });
      const items = (bundle.bundle as JsonObject).itemsBySchemaRef as JsonObject;
      expect(items['astrid.transcript_segment/v1']).toEqual([]);
      expect((bundle.clips as JsonObject[])[0]!.app).toEqual({ opaque: { keep: [null, false, 0] }, absentIsAbsent: true });
      expect((bundle.clips as JsonObject[]).map((clip) => clip.id)).toEqual(['media-clip', 'sibling-clip']);
      expect((bundle.clips as JsonObject[])[1]!.app).toEqual({ sibling: { keep: null, order: [false, 0] } });
      expect((mounted.transportState.read().parent_revision as JsonObject).revision_id).toBe('r1');
      expect(mounted.result.current.save.dataRef.current?.head).toMatchObject({ headRevisionId: 'r1', headPublicationId: 'p1' });
      expect(mounted.transportState.wire[0]).toMatchObject({ path: `/v1/projects/${PROJECT}/timelines/${TIMELINE}/commit`, key: expect.any(String) });
      expect(mounted.transportState.wire[0]!.body).toBe(JSON.stringify(request));
      const identity = await mounted.provider.getRecoverableIdentity();
      expect((await createCommitOutbox().list({ ...identity, projectId: PROJECT, timelineId: TIMELINE }))[0]?.intents).toHaveLength(0);
    } finally {
      mounted.unmount();
    }
  });

  it('keeps the real outbox request and guarded failure when the mounted transport refuses the association save', async () => {
    const mounted = await mount();
    try {
      mounted.transportState.refuse();
      const result = await act(async () => mounted.result.current.host.importTranscript({
        associationAssetId: ALIAS,
        document: { sourceId: 'reviewed', segments: [{ id: 'segment-one', start: 0, end: 1, text: 'hello' }] },
      }));
      expect(result).toMatchObject({ associationSaved: false, message: expect.stringContaining('Project transcript saved') });
      expect(mounted.transportState.requests).toHaveLength(1);
      const request = mounted.transportState.requests[0]!;
      expect(request).toMatchObject({
        api_version: 1, base_revision_id: 'r0', base_publication_id: 'p0',
        commands: [{ op: 'doc.patch', args: { changes: expect.any(Array) } }],
      });
      expect(request).not.toHaveProperty('op', 'transcript.associate');
      expect(request).not.toHaveProperty('reads');
      expect(mounted.result.current.save.localSaveState).toMatchObject({
        status: 'conflict', error: {
          kind: 'conflict', code: 'conflict', details: {
            status: 'conflict', reason: 'dependency_changed', code: 'dependency_changed',
            base: { revision_id: 'r0', publication_id: 'p0' },
            current: { revision_id: 'r0', publication_id: 'p0' },
            conflicts: [expect.objectContaining({ kind: 'dependency_changed', ref: 'parent', choices: [] })],
            suggested_command: 'timeline show',
          },
        },
      });
      expect(mounted.result.current.save.dataRef.current?.head).toMatchObject({ headRevisionId: 'r0', headPublicationId: 'p0' });
      expect(mounted.result.current.save.dataRef.current?.transcriptReferences?.associations ?? []).toEqual([]);
      expect(mounted.result.current.save.dataRef.current?.config).not.toHaveProperty('bundle');
      const identity = await mounted.provider.getRecoverableIdentity();
      const [owner] = await createCommitOutbox().list({ ...identity, projectId: PROJECT, timelineId: TIMELINE });
      expect(owner.pending?.request).toMatchObject({
        path: `/v1/projects/${PROJECT}/timelines/${TIMELINE}/commit`,
        key: mounted.transportState.wire[0]!.key,
        body: mounted.transportState.wire[0]!.body,
      });
      expect(owner.pending?.outcome).toMatchObject({ kind: 'rejected', error: { kind: 'conflict', code: 'conflict' } });
      expect(owner.intents[0]?.conflict).toMatchObject({ kind: 'conflict', code: 'conflict' });
      expect(result.message).toContain('Timeline association is still unsaved');
    } finally {
      mounted.unmount();
    }
  });

  it('reconciles the legacy config clip mirror through the mounted save when the primary parent clip collection is empty', async () => {
    const config = transcriptReconciliationConfig(makeTimelineConfig());
    const mounted = await mount({
      config,
      sourceItems: [makeLegacyTranscriptItem()],
      parentClips: [],
    });
    try {
      const receipt = await act(async () => mounted.result.current.host.importTranscript({
        associationAssetId: ALIAS,
        document: {
          sourceId: SOURCE_ID,
          segments: [{
            id: CANONICAL_TRANSCRIPT_ID, start: 1, end: 4, text: 'hello world', speaker: null,
            words: [{ id: `${CANONICAL_TRANSCRIPT_ID}:word:word-one`, start: 1, end: 2, text: 'hello' }],
          }],
        },
      }));
      expect(receipt).toMatchObject({
        associationSaved: false,
        sourceId: SOURCE_ID,
        message: expect.stringContaining('contradictory parent clips mirror'),
      });
      // The real A2 handoff refuses this legacy shape before transport: the
      // authored parent clips mirror is empty while config.clips is populated.
      expect(mounted.transportState.requests).toHaveLength(0);
      expect(mounted.transportState.wire).toHaveLength(0);
      expect(mounted.result.current.save.dataRef.current?.config.clips.map((clip) => clip.id)).toEqual(
        expect.arrayContaining([captionId(`${CANONICAL_TRANSCRIPT_ID}@media-clip`)]),
      );
    } finally {
      mounted.unmount();
    }
  });

  it('persists mounted caption and review reconciliation with the legacy source identity', async () => {
    const config = transcriptReconciliationConfig(makeTimelineConfig());
    const mounted = await mount({ config, sourceItems: [makeLegacyTranscriptItem()] });
    try {
      const receipt = await act(async () => mounted.result.current.host.importTranscript({
        associationAssetId: ALIAS,
        document: {
          sourceId: SOURCE_ID,
          segments: [{
            id: CANONICAL_TRANSCRIPT_ID, start: 1, end: 4, text: 'hello world', speaker: null,
            words: [{ id: `${CANONICAL_TRANSCRIPT_ID}:word:word-one`, start: 1, end: 2, text: 'hello' }],
          }],
        },
      }));
      expect(receipt).toMatchObject({ associationSaved: true, sourceId: SOURCE_ID });
      const request = mounted.transportState.requests[0]!;
      const changes = ((request.commands as JsonObject[])[0]!.args as JsonObject).changes as JsonObject[];
      expect(changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ op: 'list.remove', ref: 'parent', path: ['clips'], id: captionId(`${LEGACY_TRANSCRIPT_ID}@media-clip`) }),
        expect.objectContaining({ op: 'list.insert', ref: 'parent', path: ['clips'], id: captionId(`${CANONICAL_TRANSCRIPT_ID}@media-clip`) }),
        expect.objectContaining({ op: 'set', ref: 'parent', path: ['config', 'app', TRANSCRIPT_EXTENSION_ID, reviewKey(CANONICAL_TRANSCRIPT_ID)] }),
      ]));
      expect(mounted.transportState.wire[0]!.body).toBe(JSON.stringify(request));
      const payload = (mounted.transportState.read().parent_revision as JsonObject).payload as JsonObject;
      const nextConfig = payload.config as JsonObject;
      const clips = payload.clips as JsonObject[];
      expect(clips.map((clip) => clip.id)).toContain(captionId(`${CANONICAL_TRANSCRIPT_ID}@media-clip`));
      expect(clips.map((clip) => clip.id)).not.toContain(captionId(`${LEGACY_TRANSCRIPT_ID}@media-clip`));
      const extension = (nextConfig.app as JsonObject)[TRANSCRIPT_EXTENSION_ID] as JsonObject;
      expect(extension).toHaveProperty(reviewKey(CANONICAL_TRANSCRIPT_ID));
      // The mounted generic patch persists the canonical review but currently
      // retains the legacy key; the old capture's atomic review move is not a
      // production-mounted operation.
      expect(extension).toHaveProperty(reviewKey(LEGACY_TRANSCRIPT_ID));
    } finally {
      mounted.unmount();
    }
  });

  it.each([
    {
      label: 'caption destination collision',
      config: () => transcriptReconciliationConfig(makeTimelineConfig(), { collision: true }),
      sourceItems: () => [makeLegacyTranscriptItem()],
      assertCurrentOutcome: (payload: JsonObject) => {
        const config = payload.config as JsonObject;
        const clips = config.clips as JsonObject[];
        expect(clips.map((clip) => clip.id)).toEqual(expect.arrayContaining([
          captionId(`${LEGACY_TRANSCRIPT_ID}@media-clip`),
          captionId(`${CANONICAL_TRANSCRIPT_ID}@media-clip`),
        ]));
        const extension = (config.app as JsonObject)[TRANSCRIPT_EXTENSION_ID] as JsonObject;
        expect(extension).toHaveProperty(reviewKey(LEGACY_TRANSCRIPT_ID));
        expect(extension).toHaveProperty(reviewKey(CANONICAL_TRANSCRIPT_ID));
      },
    },
    {
      label: 'shared review ownership',
      config: () => transcriptReconciliationConfig(makeTimelineConfig()),
      sourceItems: () => [makeLegacyTranscriptItem('other-media'), makeLegacyTranscriptItem()],
      assertCurrentOutcome: (payload: JsonObject) => {
        const config = payload.config as JsonObject;
        const clips = config.clips as JsonObject[];
        expect(clips.map((clip) => clip.id)).toContain(captionId(`${LEGACY_TRANSCRIPT_ID}@media-clip`));
        expect(clips.map((clip) => clip.id)).not.toContain(captionId(`${CANONICAL_TRANSCRIPT_ID}@media-clip`));
        const extension = (config.app as JsonObject)[TRANSCRIPT_EXTENSION_ID] as JsonObject;
        expect(extension).toHaveProperty(reviewKey(LEGACY_TRANSCRIPT_ID));
        expect(extension).not.toHaveProperty(reviewKey(CANONICAL_TRANSCRIPT_ID));
      },
    },
  ])('records the mounted current outcome for legacy collision and shared-row cases', async ({ config, sourceItems, assertCurrentOutcome }) => {
    const mounted = await mount({ config: config(), sourceItems: sourceItems() });
    try {
      const result = await act(async () => mounted.result.current.host.importTranscript({
        associationAssetId: ALIAS,
        document: {
          sourceId: SOURCE_ID,
          segments: [{ id: CANONICAL_TRANSCRIPT_ID, start: 1, end: 4, text: 'hello world', speaker: null }],
        },
      }));
      expect(result).toMatchObject({ associationSaved: true, sourceId: SOURCE_ID });
      expect(mounted.transportState.requests).toHaveLength(1);
      const request = mounted.transportState.requests[0]!;
      expect(request).toMatchObject({
        api_version: 1, project_id: PROJECT, timeline_id: TIMELINE,
        base_revision_id: 'r0', base_publication_id: 'p0',
        commands: [{ op: 'doc.patch', args: { changes: expect.any(Array) } }],
        steps: [{ command_ordinals: [0], patch: expect.any(Array) }],
        merge: 'atomic', dry_run: false, source: { via: 'app' },
      });
      expect(request).not.toHaveProperty('operation', 'transcript.associate');
      expect(mounted.transportState.wire[0]!.body).toBe(JSON.stringify(request));
      assertCurrentOutcome((mounted.transportState.read().parent_revision as JsonObject).payload as JsonObject);
    } finally {
      mounted.unmount();
    }
  });
});

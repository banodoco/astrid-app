import type { RequestBody, Transport } from '@/integrations/runtime/generated.ts';
import { RUNTIME_CLIENT_SCOPES } from '@/integrations/runtime/client.ts';
import {
  RUNTIME_SCHEMA_DIGEST,
  RUNTIME_TARGETED_EXECUTION_CAPABILITY,
} from '@/integrations/runtime/contract-metadata.ts';
import { createDefaultTimelineConfig } from '@/tools/video-editor/lib/defaults.ts';
import type { TimelineConfig } from '@/tools/video-editor/types/index.ts';
import {
  putContentAddressedObject,
  sha256Digest,
  type FakeObjectStore,
  type FakeStoredObject,
} from './fakeObjectStore.ts';
import {
  FAKE_RUNTIME_ACTOR_ID,
  FAKE_RUNTIME_INSTANCE_ID,
  FAKE_RUNTIME_REALM_ID,
} from './fakeRuntimeIdentity.mjs';

export { sha256Digest };

export const PROJECT_ID = 'project-r1';
export const TIMELINE_ID = 'timeline-r1';
export const MANAGED_OBJECT_DIGEST = 'sha256:837705df2d47b071382f374110cbb5ef50b037c431cac6974cdfba986d836be7';
export const MANAGED_OBJECT_ID = MANAGED_OBJECT_DIGEST;

async function requestBodyBytes(body: RequestBody): Promise<Uint8Array> {
  if (ArrayBuffer.isView(body)) {
    const view = body as Uint8Array;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return new Uint8Array(await body.arrayBuffer());
}

type FixtureObject = FakeStoredObject;
function fixtureError(code: string, message: string): Uint8Array {
  return json({ code, message, request_id: 'fake-request' });
}

function retiredTimelineResponse(document = false) {
  return { status: 410, headers: {}, body: json({ code: 'retired_route', request_id: 'fake-request',
    message: document
      ? 'timeline-document reads and CAS writes are retired; use inspectTimeline and canonical publication'
      : 'legacy timeline writes are retired; submit EditCommands through commitTimeline',
    details: document
      ? { replacement: 'POST /v1/projects/{project_id}/timelines/{timeline_id}/inspect' }
      : { status: 'refused', reason: 'timeline_commit_required',
        hint: 'Submit a timeline commit instead of the retired save route.', suggested_command: 'timeline commit',
        replacement: 'POST /v1/projects/{project_id}/timelines/{timeline_id}/commit' },
  }) };
}

/**
 * Single-range reads as the real daemon and the router answer them: a suffix range (`bytes=-N`) is the
 * last N bytes, an unsatisfiable range is 416 whose Content-Range is `bytes`, a star and the size, and an unparseable header
 * is ignored (full 200).
 */
function objectRange(
  bytes: Uint8Array,
  range: string | undefined,
): { status: number; bytes: Uint8Array; contentRange?: string } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return { status: 200, bytes };
  const size = bytes.length;
  const start = match[1] === '' ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = match[1] === '' || match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start > end || start >= size) {
    return { status: 416, bytes: new Uint8Array(), contentRange: `bytes */${size}` };
  }
  return {
    status: 206,
    bytes: bytes.slice(start, end + 1),
    contentRange: `bytes ${start}-${end}/${size}`,
  };
}

export function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

// Parent payloads are deliberately partial or malformed in tests; the fixture stores them verbatim.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FixtureParentComposition = Record<string, any>;

const FIXTURE_DIGEST_1 = `sha256:${'1'.repeat(64)}`;
const FIXTURE_DIGEST_2 = `sha256:${'2'.repeat(64)}`;
const FIXTURE_CREATED_AT = '2026-09-11T00:00:00Z';

type FixtureRevision = {
  payload: FixtureParentComposition;
  createdAt: string;
  contentDigest: string;
};

export type RuntimeFixtureOptions = {
  /** A fresh project has no timeline until the catalog create route bootstraps it. */
  timelineExists?: boolean;
  runtimeInstanceId?: string;
  mediaEtag?: string;
  objectReadOverrides?: Map<string, Uint8Array>;
  initialClips?: TimelineConfig['clips'];
  initialConfig?: Partial<TimelineConfig> & Record<string, unknown>;
  parentExtensions?: Record<string, unknown>;
  parentComposition?: FixtureParentComposition;
  /** The one project and timeline this instance serves. Defaults keep the vitest values. */
  projectId?: string;
  timelineId?: string;
  /** The head revision id the instance starts at (default `parent-r1`). */
  headRevisionId?: string;
  /**
   * Older revisions the instance starts with, oldest first, below the head. The default is one
   * `parent-old`, which the history tests restore; a seeded instance passes `[]`.
   */
  priorRevisions?: Array<{ revisionId: string; createdAt?: string; contentDigest?: string; parentComposition?: FixtureParentComposition }>;
  /**
   * A shared content-addressed object store. Passing one switches every id this fixture mints to the
   * sha256 of the bytes (ingest and media import); without it the vitest defaults apply (constant
   * `MANAGED_OBJECT_ID` for the managed creative, `project-object-N` otherwise).
   */
  objects?: FakeObjectStore;
  /** Keep the request log (default true). A long-lived server turns it off. */
  recordRequests?: boolean;
};

export function runtimeFixture(options: RuntimeFixtureOptions = {}) {
  const projectId = options.projectId ?? PROJECT_ID;
  let timelineId = options.timelineId ?? TIMELINE_ID;
  let timelineExists = options.timelineExists ?? true;
  let timelineName = timelineId;
  let projectVersion = 1;
  let projectMetadata: Record<string, unknown> = {};
  const contentAddressed = options.objects !== undefined;
  const documentVersion = 1;
  const receipts = new Map<string, { request: string; body: Uint8Array }>();
  let headRevisionId = options.headRevisionId ?? 'parent-r1';
  const initialConfig = createDefaultTimelineConfig();
  let config = {
    ...initialConfig,
    ...options.initialConfig,
    clips: options.initialClips ?? initialConfig.clips,
  };
  let registry = { assets: {} };
  const initialParentComposition = options.parentComposition ?? {
    ...options.parentExtensions,
    config,
    registry,
    clips: structuredClone(config.clips),
    occurrences: [],
  };
  config = initialParentComposition.config;
  registry = initialParentComposition.registry;
  // The revision list and restore derive from this map (oldest first in `revisionOrder`), so history can
  // never show a revision the instance does not hold. Timestamps come from a counter, never a clock.
  const revisions = new Map<string, FixtureRevision>();
  const revisionOrder: string[] = [];
  let tick = 0;
  const nextCreatedAt = () => new Date(Date.UTC(2026, 8, 11, 0, 0, ++tick)).toISOString().replace('.000Z', 'Z');
  const addRevision = (revisionId: string, revision: FixtureRevision) => {
    if (revisions.has(revisionId)) revisionOrder.splice(revisionOrder.indexOf(revisionId), 1);
    revisions.set(revisionId, revision);
    revisionOrder.push(revisionId);
  };
  for (const prior of options.priorRevisions ?? [{ revisionId: 'parent-old', createdAt: '2026-09-10T00:00:00Z', contentDigest: FIXTURE_DIGEST_2 }]) {
    addRevision(prior.revisionId, {
      payload: prior.parentComposition ?? structuredClone(initialParentComposition),
      createdAt: prior.createdAt ?? FIXTURE_CREATED_AT,
      contentDigest: prior.contentDigest ?? FIXTURE_DIGEST_2,
    });
  }
  addRevision(headRevisionId, { payload: initialParentComposition, createdAt: FIXTURE_CREATED_AT, contentDigest: FIXTURE_DIGEST_1 });
  let objectSequence = 0;
  const objects: FakeObjectStore = options.objects ?? new Map<string, FixtureObject>();
  const mediaEtag = options.mediaEtag;
  const requests: Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown }> = [];
  const staleHead = (expected: string | null) => ({
    status: 409,
    headers: {},
    body: json({ code: 'conflict', message: 'parent composition head is stale', request_id: 'req-stale', details: { reason: 'stale_head', expected_head: expected, actual_head: headRevisionId } }),
  });

  const transport = async (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: RequestBody,
  ): ReturnType<Transport> => {
    const timelinePath = `/v1/projects/${projectId}/timelines/${timelineId}`;
    const route = decodeURIComponent(path.split('?')[0]);
    const retiredDocument = ['GET', 'PATCH'].includes(method) && /^\/v1\/projects\/[^/]+\/documents\/timeline:/.test(route);
    const retired = (method === 'POST' && /^\/v1\/projects\/[^/]+\/(timeline-documents|timelines\/[^/]+\/(composition-revisions|replace-parent-media))$/.test(route))
      || (method === 'PATCH' && /^\/v1\/timelines\/[^/]+$/.test(route))
      || (method === 'POST' && /^\/v1\/timelines\/[^/]+\/(shots|references|replace-clip)$/.test(route))
      || (['PATCH', 'POST'].includes(method) && /^\/v1\/(shots|references)\/[^/]+(?:\/(archive|recover))?$/.test(route))
      || (method === 'POST' && /^\/v1\/attempts\/[^/]+\/publish-timeline-render$/.test(route))
      || retiredDocument;
    // The daemon refuses these routes before decoding their body or checking CAS.
    if (retired) {
      if (options.recordRequests !== false) requests.push({ method, path, headers });
      return retiredTimelineResponse(retiredDocument);
    }
    const projectObjectPath = /^\/v1\/projects\/([^/]+)\/objects$/.exec(path);
    const isMediaImport = path.endsWith('/media-imports');
    const parsedBody = body && !projectObjectPath && !isMediaImport
      ? JSON.parse(body instanceof Blob ? await body.text() : new TextDecoder().decode(body)) as Record<string, unknown>
      : undefined;
    if (options.recordRequests !== false) {
      requests.push({ method, path, headers, ...(parsedBody ? { body: parsedBody } : {}) });
    }
    if (method === 'POST' && /^\/v1\/projects\/[^/]+\/documents$/.test(route) && parsedBody
      && ('timeline_id' in parsedBody || String(parsedBody.document_id ?? '').startsWith('timeline:') || parsedBody.kind === 'timeline.composition')) {
      return retiredTimelineResponse();
    }
    if (method === 'POST' && route === `/v1/timelines/${timelineId}/recover`
      && typeof parsedBody?.version === 'number' && parsedBody.version !== 1) {
      return { status: 410, headers: {}, body: json({ code: 'retired_route', request_id: 'fake-request',
        message: 'legacy timeline recover cannot restore a historical film version; restore a revision with timeline.restore',
        details: { status: 'refused', reason: 'timeline_restore_required', replacement: 'timeline.restore',
          requested_version: parsedBody.version, current_version: 1 } }) };
    }

    if (path === '/v1/health') {
      return { status: 200, headers: {}, body: json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, runtime_epoch: 1, runtime_instance_id: options.runtimeInstanceId ?? FAKE_RUNTIME_INSTANCE_ID }) };
    }
    if (path === '/v1/handshake') {
      return { status: 200, headers: {}, body: json({ protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, session_id: 'session-r1', actor_id: FAKE_RUNTIME_ACTOR_ID, realm_id: FAKE_RUNTIME_REALM_ID, scopes: RUNTIME_CLIENT_SCOPES, capabilities: [RUNTIME_TARGETED_EXECUTION_CAPABILITY] }) };
    }
    if (path === '/v1/realm') {
      return { status: 200, headers: {}, body: json({ realm_id: FAKE_RUNTIME_REALM_ID, display_name: 'R1 fixture', version: 1, created_at: '2026-09-11T00:00:00Z' }) };
    }
    const project = () => ({ project_id: projectId, realm_id: FAKE_RUNTIME_REALM_ID, slug: projectId,
      name: 'Fresh project', metadata: projectMetadata, version: projectVersion, created_at: FIXTURE_CREATED_AT, updated_at: FIXTURE_CREATED_AT });
    const timeline = () => ({ project_id: projectId, timeline_id: timelineId, version: 1, name: timelineName,
      archived: false, shots: [], references: [], head_revision_id: headRevisionId, head_publication_id: 'publication-current' });
    if (path === `/v1/projects/${projectId}`) {
      if (method === 'PATCH') {
        if (parsedBody?.expected_version !== projectVersion) return { status: 409, headers: {}, body: fixtureError('version_conflict', 'project changed') };
        projectMetadata = parsedBody.metadata as Record<string, unknown>;
        projectVersion += 1;
      }
      return { status: 200, headers: {}, body: json(project()) };
    }
    if (method === 'GET' && route === `/v1/projects/${projectId}/timelines`) {
      return { status: 200, headers: {}, body: json({ items: timelineExists ? [timeline()] : [], next_cursor: null }) };
    }
    if (method === 'POST' && path === `/v1/projects/${projectId}/timelines`) {
      const request = JSON.stringify(parsedBody);
      const key = headers['Idempotency-Key'];
      const saved = receipts.get(key);
      if (saved) return saved.request === request
        ? { status: 201, headers: {}, body: saved.body }
        : { status: 409, headers: {}, body: fixtureError('conflict', 'idempotency payload mismatch') };
      if (timelineExists) return { status: 409, headers: {}, body: fixtureError('conflict', 'timeline already exists') };
      timelineId = parsedBody!.timeline_id as string;
      timelineName = (parsedBody!.name as string | undefined) ?? timelineId;
      timelineExists = true;
      headRevisionId = `bootstrap-${timelineId}`;
      revisions.clear();
      revisionOrder.length = 0;
      config = { clips: [], tracks: [] } as typeof config;
      registry = { assets: {} };
      addRevision(headRevisionId, { payload: { config, registry: {}, clips: [], occurrences: [] },
        createdAt: nextCreatedAt(), contentDigest: FIXTURE_DIGEST_1 });
      const data = timeline();
      const responseBody = json({ data, receipt: { receipt_id: 'receipt-create', command_kind: 'timeline.create',
        idempotency_key: key, project_id: projectId, project_seq: [1, 1], event_ids: [], result: data, created_at: FIXTURE_CREATED_AT } });
      receipts.set(key, { request, body: responseBody });
      return { status: 201, headers: {}, body: responseBody };
    }
    if (method === 'PATCH' && path === timelinePath && typeof parsedBody?.name === 'string' && Object.keys(parsedBody).length === 1) {
      timelineName = parsedBody.name;
      const data = timeline();
      return { status: 200, headers: {}, body: json({ data, receipt: { receipt_id: 'receipt-rename', command_kind: 'timeline.rename',
        idempotency_key: headers['Idempotency-Key'], project_id: projectId, result: data } }) };
    }
    if (method === 'POST' && path === `/v1/projects/${projectId}/media-imports`) {
      const operationId = headers['Idempotency-Key'] ?? '';
      const bytes = await requestBodyBytes(body as RequestBody);
      const mediaType = headers['Content-Type'] ?? 'video/mp4';
      const filename = headers['X-Original-Name'] ?? 'managed-creative.mp4';
      let objectId = MANAGED_OBJECT_ID;
      let digest = MANAGED_OBJECT_DIGEST;
      if (contentAddressed) {
        const stored = await putContentAddressedObject(objects, { projectId, bytes, mediaType, filename });
        objectId = stored.objectId;
        digest = stored.digest;
      } else {
        objects.set(MANAGED_OBJECT_ID, { projectId, bytes, digest, mediaType, filename });
      }
      return {
        status: 201,
        headers: { ETag: `"${digest}"` },
        body: json({
          data: {
            provider: 'runtime', project: projectId, import_operation_id: operationId, status: 'completed',
            task_id: 'task-import-r3', generation_id: 'generation-import-r3', variant_id: 'variant-import-r3',
            asset_id: objectId,
            entry: { object_id: objectId, media_type: mediaType, size: bytes.byteLength, filename },
            provenance: { source: 'external_upload', origin: 'imported', actor_id: 'owner' },
            actor_id: 'owner',
          },
          receipt: {
            receipt_id: 'receipt-import-r3', command_kind: 'media.import', idempotency_key: operationId,
          },
        }),
      };
    }
    if (projectObjectPath && method === 'POST') {
      if (!body) {
        return { status: 400, headers: {}, body: fixtureError('empty_body', 'project object body is required') };
      }
      const bytes = await requestBodyBytes(body);
      const filename = headers['X-Original-Name'];
      const objectProjectId = projectObjectPath[1]!;
      const mediaType = headers['Content-Type'] ?? 'application/octet-stream';
      let objectId: string;
      let object: FixtureObject;
      if (contentAddressed) {
        const stored = await putContentAddressedObject(objects, {
          projectId: objectProjectId, bytes, mediaType, ...(filename ? { filename } : {}),
        });
        objectId = stored.objectId;
        object = stored;
      } else {
        objectId = filename === 'managed-creative.mp4'
          ? MANAGED_OBJECT_ID
          : `project-object-${++objectSequence}`;
        object = {
          projectId: objectProjectId,
          bytes,
          digest: await sha256Digest(bytes),
          mediaType,
          ...(filename ? { filename } : {}),
        };
        objects.set(objectId, object);
      }
      return {
        status: 201,
        headers: { ETag: `"${object.digest}"` },
        body: json({
          data: {
            object_id: objectId,
            digest: object.digest,
            media_type: object.mediaType,
            size: object.bytes.byteLength,
            version: 1,
            created_at: '2026-09-11T00:00:00Z',
            ...(object.filename ? { filename: object.filename } : {}),
            relation: 'asset-upload',
          },
          receipt: {
            receipt_id: `receipt-object-${objectId}`,
            command_kind: 'object.ingest',
            idempotency_key: headers['Idempotency-Key'],
            project_id: object.projectId,
            project_seq: [1, 1],
            event_ids: [`event-object-${objectId}`],
            result: {},
            created_at: '2026-09-11T00:00:00Z',
          },
        }),
      };
    }
    const projectObjectLocationPath = /^\/v1\/projects\/([^/]+)\/objects\/([^/]+)\/location$/.exec(path);
    if (projectObjectLocationPath && method === 'GET') {
      const locationProjectId = projectObjectLocationPath[1]!;
      const objectId = decodeURIComponent(projectObjectLocationPath[2]!);
      const object = objects.get(objectId);
      if (!object || object.projectId !== locationProjectId) {
        return { status: 404, headers: {}, body: fixtureError('not_found', `object ${objectId} is not in project ${locationProjectId}`) };
      }
      return {
        status: 200,
        headers: {},
        body: json({
          object_id: objectId,
          digest: object.digest,
          size: object.bytes.byteLength,
          media_type: object.mediaType,
          ...(object.filename ? { filename: object.filename } : {}),
          local_path: `/runtime/${locationProjectId}/${objectId}`,
          storage: 'runtime_cas',
          verified: true,
        }),
      };
    }
    if (path.startsWith('/v1/objects/') && (method === 'GET' || method === 'HEAD')) {
      const objectId = decodeURIComponent(path.slice('/v1/objects/'.length));
      const object = objects.get(objectId);
      if (!object) {
        return { status: 404, headers: {}, body: fixtureError('not_found', `unknown object ${objectId}`) };
      }
      const servedBytes = options.objectReadOverrides?.get(objectId) ?? object.bytes;
      const ranged = objectRange(servedBytes, headers.Range);
      if (ranged.status === 416) {
        return { status: 416, headers: { 'Content-Range': ranged.contentRange!, 'Accept-Ranges': 'bytes' }, body: new Uint8Array() };
      }
      const etag = !contentAddressed && objectId === MANAGED_OBJECT_ID && mediaEtag
        ? mediaEtag
        : `"${contentAddressed && servedBytes === object.bytes ? object.digest : await sha256Digest(servedBytes)}"`;
      return {
        status: ranged.status,
        headers: {
          ETag: etag,
          'Accept-Ranges': 'bytes',
          'Content-Type': object.mediaType,
          'Content-Length': String(ranged.bytes.byteLength),
          ...(ranged.contentRange ? { 'Content-Range': ranged.contentRange } : {}),
        },
        body: method === 'HEAD' ? new Uint8Array() : ranged.bytes,
      };
    }
    if (method === 'POST' && path === `${timelinePath}/inspect`) {
      return {
        status: 200,
        headers: {},
        body: json({
          schema: 'runtime.timeline.declared_inputs/v1',
          evidence_kind: 'declared_inputs',
          render_requested: false,
          representation: 'canonical_head',
          authority: 'runtime_parent_composition',
          project_id: projectId,
          timeline_id: timelineId,
          revision_id: headRevisionId,
          head_revision_id: headRevisionId,
          is_current_head: true,
          parent_content_digest: FIXTURE_DIGEST_1,
          head_content_digest: FIXTURE_DIGEST_1,
          snapshot_digest: FIXTURE_DIGEST_2,
          selectors: {},
          selection_status: 'selected',
          target_count: 0,
          occurrence_count: 0,
          parent_clip_count: 0,
          parent_clip_target_count: 0,
          selected_clip_count: 0,
          selected: [],
          selected_parent_clips: [],
          next_cursor: null,
        }),
      };
    }
    const revisionPath = `${timelinePath}/composition-revisions/`;
    const requestedRevision = method === 'GET' && path.startsWith(revisionPath) && !path.includes('?')
      ? decodeURIComponent(path.slice(revisionPath.length))
      : '';
    if (method === 'GET' && requestedRevision) {
      const revision = revisions.get(requestedRevision);
      if (!revision) {
        return { status: 404, headers: {}, body: fixtureError('not_found', `revision ${requestedRevision} is not in timeline ${timelineId}`) };
      }
      return {
        status: 200,
        headers: {},
        body: json({
          revision_id: requestedRevision,
          project_id: projectId,
          timeline_id: timelineId,
          content_digest: revision.contentDigest,
          payload: revision.payload,
          created_at: revision.createdAt,
        }),
      };
    }
    if (method === 'GET' && (path === `${timelinePath}/composition-revisions` || path.startsWith(`${timelinePath}/composition-revisions?`))) {
      const query = new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : '');
      const limit = Math.max(1, Number(query.get('limit') ?? 50) || 50);
      const offset = Math.max(0, Number(query.get('cursor') ?? 0) || 0);
      const newestFirst = [...revisionOrder].reverse();
      const page = newestFirst.slice(offset, offset + limit);
      return {
        status: 200,
        headers: {},
        body: json({
          items: page.map((revisionId) => ({
            revision_id: revisionId,
            project_id: projectId,
            timeline_id: timelineId,
            content_digest: revisions.get(revisionId)!.contentDigest,
            created_at: revisions.get(revisionId)!.createdAt,
            is_current_head: revisionId === headRevisionId,
          })),
          next_cursor: offset + page.length < newestFirst.length ? String(offset + page.length) : null,
        }),
      };
    }
    const restoreMatch = method === 'POST' && path.startsWith(revisionPath) && path.endsWith('/restore')
      ? decodeURIComponent(path.slice(revisionPath.length, -'/restore'.length))
      : '';
    if (restoreMatch) {
      const request = parsedBody as { expected_head: string | null };
      const source = revisions.get(restoreMatch);
      if (!source) {
        return { status: 404, headers: {}, body: fixtureError('not_found', `revision ${restoreMatch} is not in timeline ${timelineId}`) };
      }
      if (request.expected_head !== headRevisionId) return staleHead(request.expected_head);
      let restoredId = `restore-${restoreMatch}`;
      for (let suffix = 2; revisions.has(restoredId); suffix += 1) restoredId = `restore-${restoreMatch}-${suffix}`;
      addRevision(restoredId, { payload: structuredClone(source.payload), createdAt: nextCreatedAt(), contentDigest: FIXTURE_DIGEST_2 });
      headRevisionId = restoredId;
      config = source.payload.config ?? config;
      registry = source.payload.registry ?? registry;
      return {
        status: 200,
        headers: {},
        body: json({
          data: {
            project_id: projectId,
            timeline_id: timelineId,
            revision_id: headRevisionId,
            parent_revision_id: headRevisionId,
            new_head: headRevisionId,
            content_digest: `sha256:${'3'.repeat(64)}`,
          },
          receipt: {
            receipt_id: 'receipt-history-restore',
            command_kind: 'parent_composition.restore',
            idempotency_key: headers['Idempotency-Key'],
            request_hash: 'history-restore-hash',
            project_id: projectId,
            project_seq: [2, 2],
            event_ids: [],
            result: {},
            created_at: '2026-09-11T00:00:00Z',
          },
        }),
      };
    }
    if (method === 'GET' && path === timelinePath) {
      if (!timelineExists) return { status: 404, headers: {}, body: fixtureError('not_found', 'timeline not found') };
      // The public timeline resource carries identity/head metadata only. The
      // mutable document projection remains retired below.
      return {
        status: 200,
        headers: {},
        body: json({
          project_id: projectId,
          timeline_id: timelineId,
          version: 1,
          name: timelineName,
          archived: false,
          shots: [],
          references: [],
          head_revision_id: headRevisionId,
          head_publication_id: 'publication-current',
        }),
      };
    }
    if (path === timelinePath) {
      return { status: 400, headers: {}, body: fixtureError('invalid_request', 'rename requires only name') };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };

  return {
    transport,
    requests,
    setHead: (revisionId: string, parentComposition: FixtureParentComposition) => {
      addRevision(revisionId, { payload: parentComposition, createdAt: nextCreatedAt(), contentDigest: FIXTURE_DIGEST_1 });
      headRevisionId = revisionId;
    },
    read: () => ({ config, registry, documentVersion, headRevisionId, parentComposition: revisions.get(headRevisionId)!.payload as FixtureParentComposition }),
  };
}

/**
 * Canonical fetch-level fake of the local Runtime's routes (no MSW). The fake
 * Runtime server (`tests/e2e/fake-runtime/server.ts`) routes every `/v1/*`
 * request here.
 *
 * - Every handler validates request/response shapes against the schemas in
 *   `bridgeContract.ts`, so a fixture drift fails loudly here
 *   instead of silently in a browser.
 * - All seed data comes from `src/test/fakeRuntimeSeed.mjs`, the same module
 *   `tests/e2e/fake-runtime/server.ts` consumes. There is no second
 *   fixture list anywhere.
 *
 * Error posture mirrors the real server: `{error, detail}` envelope, the
 * five public categories (`invalid_body/not_found/conflict/
 * capability_unavailable/payload_too_large`) and receipt semantics on admission
 * (replay → 200 with the stored task; key reuse with different bytes → 409
 * idempotency_mismatch). It serves no timeline document: the Runtime serves
 * those through `runtimeFixture` (`fakeWorkspaceRuntime.ts`).
 */

import {
  bridgeTaskAdmissionRequestSchema,
  bridgeTaskAdmissionResponseSchema,
  runtimeGenerationPageSchema,
  runtimeGenerationResourceSchema,
  runtimeProjectPageSchema,
  runtimeMutationReceiptSchema,
  runtimeTaskPageSchema,
  runtimeTaskResourceSchema,
  runtimeVariantPageSchema,
  runtimeVariantResourceSchema,
  type RuntimeCapability,
  type RuntimeManagedObject,
} from '@/tools/video-editor/data/bridgeContract.ts';
import { AVAILABLE_FAMILIES, createJourneyState, makeAttemptWireShape, makeAdmittedTaskReadModel, taskSummaryFromReadModel } from './bridgeFixtures.mjs';
import { fixtureUlid } from './fakeRuntimeSeed.mjs';
import type { FakeObjectStore } from './fakeObjectStore.ts';

export type FakeRuntimeEvent = {
  event_id: string;
  sequence: number;
  cursor: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  occurred_at: string;
};

export type FakeRuntimeRouterOptions = {
  /**
   * A shared content-addressed object store (see `fakeObjectStore.ts`). When given, the project object
   * list, ingest and GET read and write it instead of the router's own two maps, and the two placeholder
   * objects (`sha256:111...`, `sha256:222...`, which have no bytes) are not seeded.
   */
  objectStore?: FakeObjectStore;
  /** The sequence the event feed continues from, so a rebuilt router never rewinds a client's cursor. */
  eventSequenceStart?: number;
};

export type FakeRuntimeState = ReturnType<typeof createJourneyState> & {
  /** task_id → full admission read model (`id`-keyed wire shape). */
  admittedByTaskId: Map<string, Record<string, unknown>>;
  /** IdempotencyKey → task_id, for replay responses. */
  receiptTasks: Map<string, string>;
  /** Runtime project-scoped CAS fixtures used by HC-04 pre-admission checks. */
  runtimeObjects: Map<string, RuntimeManagedObject>;
  runtimeObjectBodies: Map<string, Uint8Array>;
  runtimeCapabilities: RuntimeCapability[];
  /** task_id → committed output rows surfaced on the detail read. */
  taskOutputs: Map<string, Array<{ ordinal: number; role: string; media_id: string; is_primary?: boolean }>>;
  /** `/v1/app-state/user/{key}`: the one fake actor's records, as the daemon keeps them (key → content and version). */
  appState: Map<string, { content: Record<string, unknown>; version: number; created_at: string; updated_at: string }>;
  /** The `GET /v1/events` feed: one `task.*` event per admission, cancel and completion, oldest first. */
  events: FakeRuntimeEvent[];
};

export type FakeRuntimeRouter = {
  /** Drop-in fetch target: `(request) => response`. */
  handle(request: Request): Promise<Response>;
  /** Mutate directly to drive poll/cancel scenarios. */
  state: FakeRuntimeState;
  /** Executor hook: mark a task succeeded and commit one output row (managed media). */
  completeTask(taskId: string, output: { role: string; media_id: string; is_primary?: boolean }): void;
};

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorEnvelope(status: number, code: string, detail: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { error: code, detail, ...extra });
}

/**
 * The Runtime daemon's error body, as recorded from a real daemon
 * (`src/integrations/runtime/fixtures/responses`): flat `{code, message, request_id}`.
 * Only routes whose real error responses are recorded use it; the rest keep the bridge envelope.
 */
function runtimeError(status: number, code: string, message: string): Response {
  return json(status, { code, message, request_id: 'fake-request' });
}

type FixtureGenerationVariant = {
  id: string;
  generation_id: string;
  variant_type?: string;
  name?: string | null;
  params?: Record<string, unknown>;
  is_primary?: boolean;
  starred?: boolean;
  viewed_at?: string | null;
  thumbnail?: {
    object_id: string;
    source_object_id: string;
    recipe_version: number;
  } | null;
  created_at: string;
};

type FixtureGenerationDetail = {
  generation_id: string;
  task_id?: string | null;
  type: string;
  name?: string | null;
  params?: Record<string, unknown>;
  starred?: boolean;
  created_at: string;
  updated_at: string;
  variants: FixtureGenerationVariant[];
};

/** Strip an optional `/api/astrid` prefix. */
function normalizePath(url: URL): string[] {
  let path = url.pathname;
  if (path.startsWith('/api/astrid')) {
    path = path.slice('/api/astrid'.length);
  }
  return path.split('/').filter((segment) => segment.length > 0);
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  if (request.method !== 'POST') return {};
  const text = await request.text();
  if (text.length > 1024 * 1024) return null;
  try {
    const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The one project row; `GET /v1/projects` and `GET /v1/projects/:selector` are built from it. */
const PROJECT_ROW_ID = 'demo-project-id';
/** Paging cursors are tagged so they can be told from polling cursors (bare sequence numbers), as the daemon's `numeric` flag does. */
const PAGING_CURSOR_PREFIX = 'p:';

export function createFakeRuntimeRouter(options: FakeRuntimeRouterOptions = {}): FakeRuntimeRouter {
  const objectStore = options.objectStore;
  const state = createJourneyState() as FakeRuntimeState;
  state.events = [];
  state.appState = new Map();
  state.admittedByTaskId = new Map();
  state.receiptTasks = new Map();
  state.runtimeObjects = new Map();
  state.runtimeObjectBodies = new Map();
  state.runtimeCapabilities = [{
    capability_id: 'astrid.image_generation',
    definition_digest: `sha256:${'a'.repeat(64)}`,
    status: 'ready',
    required_resource_keys: [],
    estimated_scratch_bytes: 0,
    estimated_output_bytes: 0,
  }, {
    capability_id: 'rendering.render',
    definition_digest: `sha256:${'d'.repeat(64)}`,
    status: 'ready',
    required_resource_keys: [],
    estimated_scratch_bytes: 0,
    estimated_output_bytes: 0,
  }];
  for (const [index, objectId] of (objectStore ? [] : ['1', '2']).entries()) {
    state.runtimeObjects.set(`sha256:${objectId.repeat(64)}`, {
      object_id: `sha256:${objectId.repeat(64)}`,
      digest: `sha256:${objectId.repeat(64)}`,
      media_type: 'application/octet-stream',
      size: 0,
      version: 1,
      created_at: '2026-09-06T00:00:00Z',
      filename: `fixture-${index}.bin`,
    });
  }
  state.taskOutputs = new Map();

  function completeTask(taskId: string, output: { role: string; media_id: string; is_primary?: boolean }): void {
    const summary = state.tasks.get(taskId);
    if (summary === undefined) throw new Error(`task ${taskId} was not admitted`);
    summary.status = 'succeeded';
    const readModel = state.admittedByTaskId.get(taskId);
    if (readModel !== undefined && typeof readModel === 'object') {
      readModel.status = 'succeeded';
    }
    state.taskOutputs.set(taskId, [{
      ordinal: 1,
      role: output.role,
      media_id: output.media_id,
      ...(output.is_primary ? { is_primary: true } : {}),
    }]);
    // `effect`, `objects` and `result.outputs` as recorded in `events_page_2_200`.
    const completedObject = {
      name: output.role,
      kind: 'object',
      digest: output.media_id,
      media_type: output.role.includes('video') ? 'video/mp4' : 'image/png',
      size: 0,
    };
    emitTaskEvent(taskId, 'task.completed', {
      effect: null,
      objects: [completedObject],
      result: { outputs: [completedObject] },
    });
  }

const ADMITTED_CLASSIFICATION = { is_generation: false, is_root: true, version: 1 } as const;

  let eventSequence = options.eventSequenceStart ?? 0;
  function emitTaskEvent(taskId: string, eventType: string, payload: Record<string, unknown>): void {
    eventSequence += 1;
    state.events.push({
      event_id: String(eventSequence),
      sequence: eventSequence,
      cursor: String(eventSequence),
      event_type: eventType,
      aggregate_type: 'task',
      aggregate_id: taskId,
      payload,
      occurred_at: '2026-09-06T00:00:00Z',
    });
  }

  /**
   * `GET /v1/events`: `limit`, `cursor`, `aggregate_id` and `from=latest`, mirroring the real daemon's two
   * cursor kinds (`runtime_protocol/service.py` `events_page`, recorded as `events_page_1_200` and
   * `events_page_2_200`):
   *  - a polling cursor (`from=latest` mints it) is the bare last sequence seen. It always comes back
   *    non-null: the newest item's sequence, or the cursor itself when nothing is new;
   *  - a paging cursor (`p:<sequence>`) is minted only when a page has more behind it. A walk that starts
   *    with no cursor, or with a paging cursor, ends in `next_cursor: null`.
   * A cursor of neither shape answers the recorded `invalid_cursor_400` shape.
   */
  function listEvents(url: URL): Response {
    const rawCursor = url.searchParams.get('cursor');
    const paging = rawCursor !== null && rawCursor.startsWith(PAGING_CURSOR_PREFIX);
    const cursorKey = rawCursor === null ? null : paging ? rawCursor.slice(PAGING_CURSOR_PREFIX.length) : rawCursor;
    if (cursorKey !== null && !/^\d+$/.test(cursorKey)) return runtimeError(400, 'invalid_request', 'cursor is invalid');
    const requestedLimit = Number(url.searchParams.get('limit') ?? '50');
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 200) : 50;
    if (url.searchParams.get('from') === 'latest' && rawCursor === null) {
      return json(200, { items: [], next_cursor: String(eventSequence) });
    }
    const polling = rawCursor !== null && !paging;
    const after = cursorKey === null ? 0 : Number(cursorKey);
    const aggregateId = url.searchParams.get('aggregate_id');
    const matching = state.events
      .filter((event) => event.sequence > after && (aggregateId === null || event.aggregate_id === aggregateId));
    const items = matching.slice(0, limit);
    const last = items[items.length - 1];
    let nextCursor: string | null;
    if (polling) nextCursor = last === undefined ? rawCursor : last.cursor;
    else nextCursor = matching.length > limit && last !== undefined ? `${PAGING_CURSOR_PREFIX}${last.cursor}` : null;
    return json(200, { items, next_cursor: nextCursor });
  }

  function projectRow() {
    return {
      project_id: PROJECT_ROW_ID,
      slug: state.project.slug as string,
      name: state.project.name as string,
      metadata: {},
      version: 1,
      created_at: '2026-09-06T00:00:00Z',
      updated_at: '2026-09-06T00:00:00Z',
      archived: false,
    };
  }

  // -- Admission ---------------------------------------------------------

  async function admitTask(request: Request, body: Record<string, unknown>): Promise<Response> {
    const rawKey = request.headers.get('Idempotency-Key');
    if (rawKey === null || rawKey.trim().length === 0 || rawKey.length > 200) {
      return errorEnvelope(400, 'invalid_body', 'the Idempotency-Key header is required for this route');
    }
    let parsed = bridgeTaskAdmissionRequestSchema.safeParse(body);
    // Some route-contract tests exercise the bridge address
    // directly. Keep that fixture-only path available so those tests do not
    // masquerade as neutral Runtime evidence; production client calls use the
    // /v1 handler below and never send this envelope.
    if (!parsed.success && typeof body.family === 'string') {
      parsed = bridgeTaskAdmissionRequestSchema.safeParse({
        project: state.project.slug,
        capability_id: 'astrid.image_generation',
        capability_digest: `sha256:${'a'.repeat(64)}`,
        schema_version: '1',
        input_object_ids: [],
        spec: {
          family: body.family,
          params: body.input && typeof body.input === 'object' ? body.input : {},
          output_policy: {},
        },
        storage_estimate: { scratch_bytes: 0, output_bytes: 0 },
        settlement_effect: {},
      });
    }
    if (!parsed.success) {
      return errorEnvelope(400, 'invalid_body', 'admission body violates the wire contract');
    }
    if (!AVAILABLE_FAMILIES.includes(parsed.data.spec.family)) {
      return errorEnvelope(422, 'capability_unavailable', `${parsed.data.spec.family}: no available local binding`);
    }

    const serializedBody = JSON.stringify(body);
    const replayedBody = state.receipts.get(rawKey);
    if (replayedBody !== undefined) {
      if (replayedBody !== serializedBody) {
        return errorEnvelope(409, 'idempotency_mismatch', 'key already committed under different bytes');
      }
      const taskId = state.receiptTasks.get(rawKey) ?? '';
      return json(200, { task: state.admittedByTaskId.get(taskId) });
    }

    state.admissions += 1;
    const readModel = makeAdmittedTaskReadModel({
      taskId: fixtureUlid(String(state.admissions).padStart(6, '0')),
      family: parsed.data.spec.family,
    });
    state.tasks.set(readModel.id, taskSummaryFromReadModel(readModel));
    state.admittedByTaskId.set(readModel.id, readModel);
    state.receipts.set(rawKey, serializedBody);
    state.receiptTasks.set(rawKey, readModel.id);
    // The recorded daemon admits every task with this classification object (events_page_1_200).
    emitTaskEvent(readModel.id, 'task.admitted', { capability: parsed.data.capability_id, classification: ADMITTED_CLASSIFICATION });

    const payload = { task: readModel };
    // Round-trip through the schema: a fixture that stops matching the
    // admission contract must fail here, in CI, not in a browser.
    bridgeTaskAdmissionResponseSchema.parse(payload);
    return json(201, payload);
  }

  // -- Neutral Runtime task/generation projections -------------------------

  /** The real daemon's `task.create` receipt result: the committed run and task rows, not the task resource. */
  function taskCreateReceiptResult(resource: Record<string, unknown>): Record<string, unknown> {
    return {
      run: {
        id: resource.run_id,
        project_id: resource.project_id,
        capability: resource.capability_id,
        idempotency_key: resource.idempotency_key,
        spec_digest: resource.capability_digest,
        status: resource.state,
        created_at: resource.created_at,
        updated_at: resource.updated_at,
      },
      task: {
        id: resource.task_id,
        run_id: resource.run_id,
        capability: resource.capability_id,
        capability_digest: resource.capability_digest,
        spec: resource.spec,
        status: resource.state,
        attempt: 0,
        attempt_id: null,
        executor_id: null,
        lease_expires_at: null,
        lease_fence: 0,
        lease_token: null,
        result_json: null,
        runtime_epoch: null,
        waiting_reason: null,
        created_at: resource.created_at,
        updated_at: resource.updated_at,
      },
    };
  }

  function runtimeReceipt(commandKind: string, key: string, result: unknown): Record<string, unknown> {
    const receipt = {
      receipt_id: `${commandKind}:${key}`,
      command_kind: commandKind,
      idempotency_key: key,
      request_hash: `sha256:${'c'.repeat(64)}`,
      project_id: state.project.slug,
      project_seq: [1, 1] as [number, number],
      event_ids: ['1'],
      result,
      created_at: '2026-09-06T00:00:00Z',
    };
    runtimeMutationReceiptSchema.parse(receipt);
    return receipt;
  }

  function runtimeTaskResource(taskId: string, requestBody?: Record<string, unknown>): Record<string, unknown> {
    const summary = state.tasks.get(taskId);
    if (!summary) throw new Error(`fixture missing task ${taskId}`);
    const readModel = state.admittedByTaskId.get(taskId) ?? {
      id: taskId,
      project_id: summary.project_id,
      capability: summary.capability,
      capability_id: summary.capability,
      capability_digest: `sha256:${'a'.repeat(64)}`,
      spec: summary.spec ?? {},
      created_at: summary.created_at,
      updated_at: summary.updated_at,
      run_id: fixtureUlid(`run${taskId.slice(-6)}`),
      idempotency_key: taskId,
    };
    const readModelRecord = readModel as typeof readModel & Record<string, unknown>;
    const capabilityDigest = typeof readModel.capability_digest === 'string'
      ? readModel.capability_digest
      : `sha256:${'a'.repeat(64)}`;
    const inputObjectIds = Array.isArray(readModel.input_object_ids)
      ? readModel.input_object_ids
      : Array.isArray(requestBody?.input_object_ids) ? requestBody.input_object_ids : [];
    const resource = {
      task_id: taskId,
      run_id: typeof readModel.run_id === 'string' ? readModel.run_id : fixtureUlid(`run${taskId.slice(-6)}`),
      project_id: state.project.slug,
      state: summary.status,
      version: 1,
      capability_id: typeof readModel.capability_id === 'string' ? readModel.capability_id : readModel.capability,
      capability_digest: capabilityDigest,
      schema_version: '1',
      input_object_ids: inputObjectIds,
      spec: {
        input_object_ids: inputObjectIds,
        schema_version: '1',
        capability_digest: capabilityDigest,
        spec: readModel.spec,
      },
      idempotency_key: typeof readModel.idempotency_key === 'string' ? readModel.idempotency_key : taskId,
      created_at: readModel.created_at,
      updated_at: readModel.updated_at,
      attempt_id: summary.status === 'running' ? fixtureUlid(`attempt${taskId.slice(-6)}`) : null,
      runtime_epoch: 1,
      ...(readModelRecord.generation_intent !== undefined
        ? { generation_intent: readModelRecord.generation_intent }
        : requestBody?.generation_intent !== undefined
          ? { generation_intent: requestBody.generation_intent }
          : {}),
      ...(state.taskOutputs.get(taskId)
        ? { result: { outputs: state.taskOutputs.get(taskId)!.map((output) => ({
            name: output.role,
            kind: 'object',
            digest: output.media_id,
            media_type: output.role.includes('video') ? 'video/mp4' : 'image/png',
            size: 0,
          })) } }
        : {}),
    };
    runtimeTaskResourceSchema.parse(resource);
    return resource;
  }

  async function admitRuntimeTask(request: Request, body: Record<string, unknown>): Promise<Response> {
    const rawKey = request.headers.get('Idempotency-Key');
    if (rawKey === null || rawKey.trim().length === 0 || rawKey.length > 200) {
      return errorEnvelope(400, 'invalid_body', 'the Idempotency-Key header is required for this route');
    }
    const parsed = bridgeTaskAdmissionRequestSchema.safeParse(body);
    if (!parsed.success) return runtimeError(422, 'validation_error', 'admission body violates the wire contract');
    if (!AVAILABLE_FAMILIES.includes(parsed.data.spec.family)) {
      return errorEnvelope(422, 'capability_unavailable', `${parsed.data.spec.family}: no available local binding`);
    }
    const serializedBody = JSON.stringify(body);
    const replayedBody = state.receipts.get(rawKey);
    if (replayedBody !== undefined) {
      if (replayedBody !== serializedBody) {
        return errorEnvelope(409, 'idempotency_mismatch', 'key already committed under different bytes');
      }
      const taskId = state.receiptTasks.get(rawKey) ?? '';
      const resource = runtimeTaskResource(taskId, body);
      return json(200, { data: resource, receipt: runtimeReceipt('task.create', rawKey, taskCreateReceiptResult(resource)) });
    }

    state.admissions += 1;
    const readModel = makeAdmittedTaskReadModel({
      taskId: fixtureUlid(String(state.admissions).padStart(6, '0')),
      family: parsed.data.spec.family,
    });
    const neutralReadModel = readModel as typeof readModel & Record<string, unknown>;
    neutralReadModel.project_id = state.project.slug;
    neutralReadModel.capability_id = parsed.data.capability_id;
    neutralReadModel.capability_digest = parsed.data.capability_digest;
    neutralReadModel.input_object_ids = parsed.data.input_object_ids;
    neutralReadModel.spec = parsed.data.spec;
    if (parsed.data.generation_intent !== undefined) {
      neutralReadModel.generation_intent = parsed.data.generation_intent;
    }
    neutralReadModel.idempotency_key = rawKey;
    neutralReadModel.run_id = fixtureUlid(`run${String(state.admissions).padStart(6, '0')}`);
    state.tasks.set(readModel.id, taskSummaryFromReadModel(readModel));
    state.admittedByTaskId.set(readModel.id, neutralReadModel);
    state.receipts.set(rawKey, serializedBody);
    state.receiptTasks.set(rawKey, readModel.id);
    // The recorded daemon admits every task with this classification object (events_page_1_200).
    emitTaskEvent(readModel.id, 'task.admitted', { capability: parsed.data.capability_id, classification: ADMITTED_CLASSIFICATION });
    const resource = runtimeTaskResource(readModel.id, body);
    return json(201, { data: resource, receipt: runtimeReceipt('task.create', rawKey, taskCreateReceiptResult(resource)) });
  }

  function runtimeGenerationResource(detail: FixtureGenerationDetail): Record<string, unknown> {
    const resource = {
      generation_id: detail.generation_id,
      project_id: state.project.slug,
      source_task_id: detail.task_id ?? null,
      type: detail.type,
      status: 'created',
      metadata: {
        name: detail.name,
        params: detail.params ?? {},
        starred: detail.starred,
      },
      version: 1,
      created_at: detail.created_at,
      updated_at: detail.updated_at,
    };
    runtimeGenerationResourceSchema.parse(resource);
    return resource;
  }

  function runtimeVariantResource(variant: FixtureGenerationVariant, index: number): Record<string, unknown> {
    const objectId = `sha256:${String.fromCharCode(97 + index)}${''.padEnd(63, String.fromCharCode(97 + index))}`;
    const resource = {
      variant_id: variant.id,
      generation_id: variant.generation_id,
      object_id: objectId,
      variant_type: variant.variant_type ?? 'original',
      ...(variant.thumbnail ? { thumbnail: variant.thumbnail } : {}),
      metadata: {
        name: variant.name,
        params: variant.params ?? {},
        is_primary: variant.is_primary,
        starred: variant.starred,
        viewed_at: variant.viewed_at,
      },
      created_at: variant.created_at,
    };
    runtimeVariantResourceSchema.parse(resource);
    return resource;
  }

  function runtimeGenerationDetails(generationId: string): { resource: Record<string, unknown>; variants: Record<string, unknown>[] } | null {
    const detail = state.galleryDetails.find((candidate) => candidate.generation_id === generationId) as FixtureGenerationDetail | undefined;
    if (!detail) return null;
    const resource = runtimeGenerationResource(detail);
    const variants = detail.variants.map((variant, index) => runtimeVariantResource(variant, index));
    return { resource, variants };
  }

  async function ingestRuntimeObject(request: Request, projectId: string): Promise<Response> {
    const idempotencyKey = request.headers.get('Idempotency-Key');
    const mediaType = request.headers.get('Content-Type');
    if (!idempotencyKey || !mediaType) {
      return errorEnvelope(400, 'invalid_body', 'Runtime object ingest requires media type and Idempotency-Key');
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    const digestBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const digest = Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const objectId = `sha256:${digest}`;
    const object: RuntimeManagedObject = {
      object_id: objectId,
      digest: objectId,
      media_type: mediaType,
      size: bytes.byteLength,
      version: 1,
      created_at: '2026-09-06T00:00:00Z',
      ...(request.headers.get('X-Original-Name')
        ? { filename: request.headers.get('X-Original-Name')! }
        : {}),
    };
    if (objectStore) {
      if (!objectStore.has(objectId)) {
        objectStore.set(objectId, {
          projectId,
          bytes,
          digest: objectId,
          mediaType,
          ...(object.filename ? { filename: object.filename } : {}),
        });
      }
    } else {
      state.runtimeObjects.set(objectId, object);
      state.runtimeObjectBodies.set(objectId, bytes);
    }
    return json(201, {
      data: object,
      receipt: {
        receipt_id: `receipt:${objectId}`,
        command_kind: 'project_object_ingest',
        idempotency_key: idempotencyKey,
        request_hash: objectId,
        project_id: projectId,
        project_seq: [1, 1],
        event_ids: [],
        result: { object_id: objectId },
        created_at: '2026-09-06T00:00:00Z',
      },
    });
  }

  /** Every stored object as the wire row; the shared store, when given, is the only source. */
  function runtimeObjectRows(): RuntimeManagedObject[] {
    if (!objectStore) return [...state.runtimeObjects.values()];
    return [...objectStore.values()].map((stored) => ({
      object_id: stored.digest,
      digest: stored.digest,
      media_type: stored.mediaType,
      size: stored.bytes.byteLength,
      version: 1,
      created_at: '2026-09-06T00:00:00Z',
      ...(stored.filename ? { filename: stored.filename } : {}),
    }));
  }

  function listRuntimeObjects(url: URL): Response {
    const all = runtimeObjectRows();
    const offset = Number(url.searchParams.get('cursor') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const items = all.slice(offset, offset + limit);
    const next = offset + items.length < all.length ? String(offset + items.length) : null;
    return json(200, { items, next_cursor: next });
  }

  // -- Managed-media bytes ----------------------------------------------

  function serveMedia(request: Request, mediaId: string): Response {
    const media = state.media.get(mediaId);
    if (media === undefined) {
      return errorEnvelope(404, 'media_not_found', `media ${mediaId} was not found`);
    }
    const etag = `"${media.bytes.byteLength.toString(16)}-seed"`;
    if (request.headers.get('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '');
    if (range && (range[1] !== '' || range[2] !== '')) {
      const size = media.bytes.byteLength;
      const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      const end = range[1] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
        });
      }
      return new Response(Uint8Array.from(media.bytes.subarray(start, end + 1)), {
        status: 206,
        headers: {
          'Content-Type': media.mime,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          ETag: etag,
          'Cache-Control': 'private, no-cache',
        },
      });
    }
    return new Response(Uint8Array.from(media.bytes), {
      status: 200,
      headers: {
        'Content-Type': media.mime,
        'Accept-Ranges': 'bytes',
        ETag: etag,
        'Cache-Control': 'private, no-cache',
      },
    });
  }

  function serveRuntimeObject(request: Request, objectId: string): Response {
    const stored = objectStore?.get(objectId);
    const object = objectStore
      ? runtimeObjectRows().find((row) => row.object_id === objectId)
      : state.runtimeObjects.get(objectId);
    const bytes = objectStore ? stored?.bytes : state.runtimeObjectBodies.get(objectId);
    if (object === undefined || bytes === undefined) {
      return errorEnvelope(404, 'not_found', `object ${objectId} was not found`);
    }
    const etag = `"${object.digest}"`;
    if (request.headers.get('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '');
    if (range && (range[1] !== '' || range[2] !== '')) {
      const start = range[1] === ''
        ? Math.max(0, bytes.byteLength - Number(range[2]))
        : Number(range[1]);
      const end = range[1] === ''
        ? bytes.byteLength - 1
        : Math.min(Number(range[2]), bytes.byteLength - 1);
      if (start > end || start >= bytes.byteLength) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${bytes.byteLength}`, 'Accept-Ranges': 'bytes' },
        });
      }
      return new Response(Uint8Array.from(bytes.subarray(start, end + 1)), {
        status: 206,
        headers: {
          'Content-Type': object.media_type,
          'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`,
          'Accept-Ranges': 'bytes',
          ETag: etag,
          'Cache-Control': 'private, no-cache',
        },
      });
    }
    return new Response(Uint8Array.from(bytes), {
      status: 200,
      headers: {
        'Content-Type': object.media_type,
        'Accept-Ranges': 'bytes',
        ETag: etag,
        'Cache-Control': 'private, no-cache',
      },
    });
  }

  /** `GET|PUT /v1/app-state/user/{key}`: absent reads as version 0; a PUT is compare-and-swap on `expected_version`. */
  async function appStateRoute(request: Request, key: string): Promise<Response> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key)) return runtimeError(422, 'validation_error', 'app-state key is invalid');
    const resource = () => {
      const row = state.appState.get(key);
      return {
        scope: 'user',
        actor_id: 'fake-actor',
        key,
        content: row?.content ?? null,
        version: row?.version ?? 0,
        created_at: row?.created_at ?? null,
        updated_at: row?.updated_at ?? null,
      };
    };
    if (request.method === 'GET') return json(200, resource());
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(await request.text());
      body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    const content = body?.content;
    const expected = body?.expected_version;
    if (!content || typeof content !== 'object' || Array.isArray(content) || !Number.isInteger(expected)) {
      return runtimeError(422, 'validation_error', 'app-state requires an object content and expected_version');
    }
    const current = state.appState.get(key);
    if ((current?.version ?? 0) !== expected) {
      return json(409, { code: 'conflict', message: 'app-state version conflict', request_id: 'fake-request', details: { expected, actual: current?.version ?? 0 } });
    }
    const now = new Date().toISOString();
    state.appState.set(key, {
      content: content as Record<string, unknown>,
      version: (current?.version ?? 0) + 1,
      created_at: current?.created_at ?? now,
      updated_at: now,
    });
    return json(200, { data: resource(), receipt: null });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = normalizePath(url);

    if (
      parts[0] === 'v1'
      && parts[1] === 'app-state'
      && parts[2] === 'user'
      && parts.length === 4
      && (request.method === 'GET' || request.method === 'PUT')
    ) {
      return appStateRoute(request, decodeURIComponent(parts[3]));
    }

    if (
      parts[0] === 'v1'
      && parts[1] === 'projects'
      && parts[3] === 'objects'
      && parts.length === 4
      && request.method === 'POST'
    ) {
      return await ingestRuntimeObject(request, parts[2]);
    }
    if (
      parts[0] === 'v1'
      && parts[1] === 'projects'
      && parts[3] === 'objects'
      && parts.length === 4
      && request.method === 'GET'
    ) {
      return listRuntimeObjects(url);
    }
    if (parts[0] === 'v1' && parts[1] === 'capabilities' && parts.length === 2 && request.method === 'GET') {
      const offset = Number(url.searchParams.get('cursor') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const items = state.runtimeCapabilities.slice(offset, offset + limit);
      const next = offset + items.length < state.runtimeCapabilities.length ? String(offset + items.length) : null;
      return json(200, { items, next_cursor: next });
    }

    if (parts[0] === 'v1' && parts[1] === 'health' && request.method === 'GET') {
      return json(200, {
        protocol: 'workspace.v1',
        runtime_epoch: 1,
        schema_digest: `sha256:${'a'.repeat(64)}`,
        status: 'ok',
      });
    }
    if (parts[0] === 'v1' && parts[1] === 'objects' && parts.length === 3 && request.method === 'GET') {
      return serveRuntimeObject(request, decodeURIComponent(parts[2]));
    }
    if (parts[0] === 'v1' && parts[1] === 'projects' && parts.length === 2 && request.method === 'GET') {
      const page = { items: [projectRow()], next_cursor: null };
      runtimeProjectPageSchema.parse(page);
      return json(200, page);
    }
    // One project by slug or canonical id, built from the same row as the list.
    if (parts[0] === 'v1' && parts[1] === 'projects' && parts.length === 3 && request.method === 'GET') {
      const row = projectRow();
      const selector = decodeURIComponent(parts[2]);
      if (selector !== row.slug && selector !== row.project_id) {
        return runtimeError(404, 'not_found', `project ${selector} was not found`);
      }
      runtimeProjectPageSchema.parse({ items: [row], next_cursor: null });
      return json(200, row);
    }
    if (parts[0] === 'v1' && parts[1] === 'events' && parts.length === 2 && request.method === 'GET') {
      return listEvents(url);
    }
    // Neutral Runtime task admission and reads.
    if (parts[0] === 'v1' && parts[1] === 'tasks' && parts.length === 2 && request.method === 'POST') {
      const body = await readJsonObject(request);
      if (body === null) return errorEnvelope(413, 'payload_too_large', 'admission body over limit');
      return await admitRuntimeTask(request, body);
    }
    if (parts[0] === 'v1' && parts[1] === 'projects' && parts[3] === 'tasks' && parts.length === 4 && request.method === 'GET') {
      const items = [...state.tasks.keys()].map((taskId) => runtimeTaskResource(taskId));
      const page = { items, next_cursor: null };
      runtimeTaskPageSchema.parse(page);
      return json(200, page);
    }
    if (parts[0] === 'v1' && parts[1] === 'tasks' && parts.length === 3 && request.method === 'GET') {
      if (!state.tasks.has(parts[2])) return runtimeError(404, 'not_found', 'task not found');
      return json(200, runtimeTaskResource(parts[2]));
    }
    if (parts[0] === 'v1' && parts[1] === 'tasks' && parts[3] === 'cancel' && parts.length === 4 && request.method === 'POST') {
      const body = await readJsonObject(request);
      const key = request.headers.get('Idempotency-Key');
      if (body === null || !key) return errorEnvelope(400, 'invalid_body', 'cancel requires a JSON body and Idempotency-Key');
      const summary = state.tasks.get(parts[2]);
      if (!summary) return errorEnvelope(404, 'not_found', `task ${parts[2]} was not found`);
      if (summary.status === 'running' && body.expected_version === undefined) {
        return errorEnvelope(409, 'conflict', 'stale task version', { attempt: makeAttemptWireShape({ status: 'running' }) });
      }
      if (summary.status !== 'cancelled' && summary.status !== 'succeeded' && summary.status !== 'failed') {
        summary.status = 'cancelled';
        const readModel = state.admittedByTaskId.get(parts[2]);
        if (readModel) {
          readModel.status = 'cancelled';
          readModel.finished_at = '2026-08-22T12:01:00Z';
        }
        emitTaskEvent(parts[2], 'task.cancelled', {});
      }
      const resource = runtimeTaskResource(parts[2]);
      return json(200, { data: resource, receipt: runtimeReceipt('task.cancel', key, resource) });
    }

    // Neutral Runtime generation/variant reads.
    if (parts[0] === 'v1' && parts[1] === 'projects' && parts[3] === 'generations' && parts.length === 4 && request.method === 'GET') {
      const items = state.galleryDetails
        .map((detail) => runtimeGenerationResource(detail as FixtureGenerationDetail))
        .sort((left, right) => (
          String(right.created_at).localeCompare(String(left.created_at))
          || String(left.generation_id).localeCompare(String(right.generation_id))
        ));
      const page = { items, next_cursor: null };
      runtimeGenerationPageSchema.parse(page);
      return json(200, page);
    }
    if (parts[0] === 'v1' && parts[1] === 'generations' && parts.length === 3 && request.method === 'GET') {
      const details = runtimeGenerationDetails(parts[2]);
      if (!details) return errorEnvelope(404, 'not_found', `generation ${parts[2]} was not found`);
      return json(200, details.resource);
    }
    if (parts[0] === 'v1' && parts[1] === 'generations' && parts[3] === 'variants' && parts.length === 4 && request.method === 'GET') {
      const details = runtimeGenerationDetails(parts[2]);
      if (!details) return errorEnvelope(404, 'not_found', `generation ${parts[2]} was not found`);
      const page = { items: details.variants, next_cursor: null };
      runtimeVariantPageSchema.parse(page);
      return json(200, page);
    }

    // Admission.
    if (parts[0] === 'projects' && parts[2] === 'tasks' && parts.length === 3 && request.method === 'POST') {
      const body = await readJsonObject(request);
      if (body === null) {
        return errorEnvelope(413, 'payload_too_large', 'admission body over limit', {
          limit_bytes: 1024 * 1024,
        });
      }
      return await admitTask(request, body);
    }

    // Managed-media bytes.
    if (
      parts[0] === 'projects'
      && parts[2] === 'media'
      && parts[4] === 'content'
      && parts.length === 5
      && (request.method === 'GET' || request.method === 'HEAD')
    ) {
      return serveMedia(request, parts[3]);
    }

    return errorEnvelope(404, 'not_found', `No fake route for ${url.pathname}`);
  }

  return { handle, state, completeTask };
}

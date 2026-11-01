// Every Runtime response the App parses is held to bytes a REAL daemon
// produced (vendored in ./fixtures/responses). Two parsing layers are exercised:
//   1. the generated WorkspaceClient behind AstridRuntimeClient (ApiError decoding, page/mutation guards)
//      and the App's conflict classifier `isRuntimeConflict`;
//   2. the Astrid bridge transport + zod task routes (`AstridLocalTaskRoutes`).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AstridBridgeTransport, BridgeRouteError } from '@/integrations/astrid/transport.ts';
import { AstridLocalTaskRoutes } from '@/integrations/astrid/taskRoutes.ts';
import { getManagedOutputExportExpectedIdentity } from '@/tools/video-editor/hooks/useFinalVideoAvailable.ts';
import { filled, PLACEHOLDER_VALUES, RECORDED_RESPONSES, type RecordedResponse } from '@/test/recordedResponses.ts';
import { classifyRuntimeCommitFailure, isRuntimeCanonicalPayloadConflict, isRuntimeConflict } from './client.ts';
import { ApiError, WorkspaceClient, type Transport } from './generated.ts';

const TASK_ID = PLACEHOLDER_VALUES.task_id;
const PROJECT_ID = PLACEHOLDER_VALUES.project_id;
const ERROR_CASES = ['not_found_404', 'validation_error_422', 'invalid_cursor_400'] as const;

/** A WorkspaceClient whose transport answers with `fixture`; `sent` records what the client asked for. */
function clientAnswering(fixture: RecordedResponse) {
  const sent: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  const transport: Transport = async (method, path, headers, body) => {
    sent.push({ method, path, headers: { ...headers }, body: body ? JSON.parse(new TextDecoder().decode(body as Uint8Array)) : null });
    return {
      status: fixture.status,
      headers: fixture.headers,
      body: new TextEncoder().encode(JSON.stringify(fixture.body)),
    };
  };
  return { client: new WorkspaceClient('/api/runtime', undefined, transport), sent };
}

async function caught(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to reject');
}

describe('recorded fixtures are all exercised', () => {
  it('covers every vendored response', () => {
    expect(Object.keys(RECORDED_RESPONSES).sort()).toEqual([
      'commit_conflict_409',
      'events_page_1_200', 'events_page_2_200', 'invalid_cursor_400', 'managed_outputs_200',
      'not_found_404', 'publish_conflict_409', 'retired_route_410', 'task_admission_201', 'task_read_200', 'validation_error_422',
    ]);
  });
});

describe('generated WorkspaceClient parses real success responses', () => {
  it('task_admission_201: admitTask returns the task with its committed receipt', async () => {
    const fixture = filled('task_admission_201');
    const { client, sent } = clientAnswering(fixture);
    const body = fixture.request.body as Parameters<WorkspaceClient['admitTask']>[0];

    const task = await client.admitTask(body, 'task');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: fixture.request.method, path: fixture.request.path, body });
    expect(task).toMatchObject({ task_id: TASK_ID, state: 'queued', capability_id: 'render.recorded' });
    expect(task.receipt).toMatchObject({ command_kind: 'task.create', idempotency_key: 'task' });
  });

  it('task_read_200: getTask returns the task resource', async () => {
    const fixture = filled('task_read_200');
    const { client, sent } = clientAnswering(fixture);

    const task = await client.getTask(TASK_ID);

    expect(sent[0]).toMatchObject({ method: 'GET', path: fixture.request.path });
    expect(task).toEqual(fixture.body);
  });

  it.each(['events_page_1_200', 'events_page_2_200'])('%s: listEvents returns a well-formed page', async (name) => {
    const fixture = filled(name);
    const { client, sent } = clientAnswering(fixture);
    const cursor = new URL(fixture.request.path, 'http://x').searchParams.get('cursor') ?? undefined;

    const page = await client.listEvents(cursor, 2);

    expect(sent[0]).toMatchObject({ method: 'GET', path: fixture.request.path });
    expect(page).toEqual(fixture.body);
    expect(page.items.length).toBeGreaterThan(0);
  });

  it('managed_outputs_200: listManagedOutputs returns outputs the export flow can identify', async () => {
    const fixture = filled('managed_outputs_200');
    const { client, sent } = clientAnswering(fixture);

    const page = await client.listManagedOutputs(TASK_ID);

    expect(sent[0].path.startsWith(fixture.request.path)).toBe(true);
    expect(page.next_cursor).toBeNull();
    const [output] = page.items;
    expect(output).toMatchObject({ state: 'available', object_id: expect.stringMatching(/^sha256:/) });
    const identity = getManagedOutputExportExpectedIdentity(output);
    // Every field the export guard pins must be present on the real daemon's output.
    for (const [field, value] of Object.entries(identity)) {
      expect(value, `export identity field ${field}`).not.toBeUndefined();
    }
    expect(identity).toMatchObject({ task_id: TASK_ID, executor_id: 'recorder', fence: 1, runtime_epoch: 1 });
  });
});

describe('the App classifies real error responses', () => {
  it('commit_conflict_409: canonical commit preserves the request, key and structured current head', async () => {
    const fixture = filled('commit_conflict_409');
    const { client, sent } = clientAnswering(fixture);
    const request = fixture.request.body as Parameters<WorkspaceClient['commitTimeline']>[2];

    const error = await caught(client.commitTimeline(PROJECT_ID, 'main', request, 'commit-conflict-409'));

    expect(sent).toEqual([{
      method: fixture.request.method,
      path: fixture.request.path,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': 'commit-conflict-409' },
      body: request,
    }]);
    expect(error).toBeInstanceOf(ApiError);
    const body = fixture.body as { code: string; message: string };
    expect(error).toMatchObject({ ...body, status: 409, message: `${body.code}: ${body.message}` });
    expect(classifyRuntimeCommitFailure(error)).toBe('refused');
    expect(isRuntimeConflict(error)).toBe(false);
    expect(isRuntimeCanonicalPayloadConflict(error)).toBe(false);
  });

  it('retired_route_410: a retired publisher is refused rather than classified as a commit conflict', async () => {
    const fixture = filled('retired_route_410');
    const { client, sent } = clientAnswering(fixture);

    const error = await caught(client.publishParentComposition(PROJECT_ID, 'main', fixture.request.body as Record<string, unknown>, 'retired-route-410'));

    expect(sent[0]).toMatchObject({ method: fixture.request.method, path: fixture.request.path });
    expect(error).toBeInstanceOf(ApiError);
    const body = fixture.body as { code: string; message: string };
    expect(error).toMatchObject({ ...body, status: 410, message: `${body.code}: ${body.message}` });
    expect(isRuntimeConflict(error)).toBe(false);
    expect(isRuntimeCanonicalPayloadConflict(error)).toBe(false);
  });

  // Keep the pre-D39 recording and its behavior tests as historical compatibility coverage.
  it('publish_conflict_409: ApiError carries the structured stale_head details and is a conflict', async () => {
    const fixture = filled('publish_conflict_409');
    const { client, sent } = clientAnswering(fixture);
    const request = fixture.request.body as Record<string, unknown>;

    const error = await caught(client.publishParentComposition(PROJECT_ID, 'main', request, 'publish-key'));

    expect(sent[0]).toMatchObject({ method: 'POST', path: fixture.request.path });
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError).toMatchObject({
      status: 409,
      code: 'conflict',
      request_id: PLACEHOLDER_VALUES.request_id,
      details: { reason: 'stale_head', actual_head: 'parent-1', expected_head: null },
    });
    expect(isRuntimeConflict(error)).toBe(true);
    expect(isRuntimeCanonicalPayloadConflict(error)).toBe(false);
  });

  it('publish_conflict_409: classification does not depend on the message wording', async () => {
    const fixture = filled('publish_conflict_409');
    const reworded = { ...fixture, body: { ...(fixture.body as object), message: 'something else entirely' } };
    const error = await caught(clientAnswering(reworded).client.publishParentComposition(
      PROJECT_ID, 'main', fixture.request.body as Record<string, unknown>, 'publish-key',
    ));
    expect(isRuntimeConflict(error)).toBe(true);
  });

  it.each(ERROR_CASES)('%s: decodes to an ApiError and is NOT a conflict', async (name) => {
    const fixture = filled(name);
    const { client, sent } = clientAnswering(fixture);
    const operation = name === 'not_found_404'
      ? client.getTask('task-does-not-exist')
      : name === 'invalid_cursor_400'
        ? client.listEvents('not-a-cursor')
        : client.admitTask(fixture.request.body as Parameters<WorkspaceClient['admitTask']>[0], 'task');

    const error = await caught(operation);

    expect(sent[0].method).toBe(fixture.request.method);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: fixture.status,
      code: (fixture.body as { code: string }).code,
      request_id: PLACEHOLDER_VALUES.request_id,
    });
    expect(isRuntimeConflict(error)).toBe(false);
    expect(isRuntimeCanonicalPayloadConflict(error)).toBe(false);
  });
});

describe('Astrid bridge transport and task routes parse real responses', () => {
  afterEach(() => vi.unstubAllGlobals());

  function routesAnswering(fixture: RecordedResponse) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fixture.body), {
      status: fixture.status,
      headers: fixture.headers,
    }));
    vi.stubGlobal('fetch', fetchMock);
    return { routes: new AstridLocalTaskRoutes(new AstridBridgeTransport({ baseUrl: '/api/astrid' }), { projectSlug: PROJECT_ID }), fetchMock };
  }

  it('task_read_200: tasks.get projects the real task resource', async () => {
    const fixture = filled('task_read_200');
    const { routes, fetchMock } = routesAnswering(fixture);

    const detail = await routes.get(TASK_ID);

    expect(fetchMock.mock.calls[0]).toEqual([`/api/astrid${fixture.request.path}`, expect.objectContaining({ method: 'GET' })]);
    expect(detail).toMatchObject({ task_id: TASK_ID, status: 'queued', capability: 'render.recorded' });
  });

  it('task_admission_201: tasks.admit accepts the real mutation envelope', async () => {
    const fixture = filled('task_admission_201');
    const { routes } = routesAnswering(fixture);

    const { task } = await routes.admit({
      project: PROJECT_ID,
      capability_id: 'render.recorded',
      capability_digest: PLACEHOLDER_VALUES.digest,
      schema_version: '1',
      input_object_ids: [],
      spec: { family: 'image_generation', params: {}, output_policy: {} },
      storage_estimate: { scratch_bytes: 0, output_bytes: 0 },
      settlement_effect: {},
    } as Parameters<typeof routes.admit>[0], 'task');

    expect(task).toMatchObject({ id: TASK_ID, run_id: PLACEHOLDER_VALUES.run_id, status: 'queued' });
  });

  it.each(['events_page_1_200', 'events_page_2_200'])('%s: tasks.events validates the real event page', async (name) => {
    const fixture = filled(name);
    const { routes } = routesAnswering(fixture);

    const page = await routes.events(TASK_ID, { limit: 2 });

    expect(page).toEqual(fixture.body);
  });

  // The daemon's error body is flat: {code, message, details?, request_id}. The transport must surface that
  // structured code (callers branch on it); falling back to the HTTP status alone loses it.
  it.each([...ERROR_CASES, 'publish_conflict_409'] as const)('%s: BridgeRouteError keeps the daemon code and message', async (name) => {
    const fixture = filled(name);
    const { routes } = routesAnswering(fixture);
    const body = fixture.body as { code: string; message: string };

    const error = await caught(routes.get(TASK_ID));

    expect(error).toBeInstanceOf(BridgeRouteError);
    expect(error).toMatchObject({ status: fixture.status, code: body.code, detail: body.message });
  });

  it('validation_error_422 is not mislabelled as capability_unavailable', async () => {
    const { routes } = routesAnswering(filled('validation_error_422'));
    const error = await caught(routes.get(TASK_ID));
    expect((error as BridgeRouteError).category).not.toBe('capability_unavailable');
  });
});

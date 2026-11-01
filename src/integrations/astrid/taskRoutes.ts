/**
 * Task routes: admission, polling reads, and
 * cancellation. Thin declarations over the shared transport — no retry
 * policy, no caching, no state. Consumers own cadence and idempotency-key
 * discipline.
 */

import type { AstridBridgeTransport } from './transport.ts';
import { dispatchAppEvent } from '@/shared/lib/typedEvents';
import {
  bridgeCancelRequestSchema,
  bridgeTaskAdmissionRequestSchema,
  bridgeTaskAdmissionResponseSchema,
  runtimeMutationSchema,
  runtimeEventPageSchema,
  runtimeTaskResourceSchema,
  type BridgeCancelRequest,
  type BridgeCancelResponse,
  type BridgeTaskAdmissionRequest,
  type BridgeTaskAdmissionResponse,
  type BridgeTaskList,
} from '@/tools/video-editor/data/bridgeContract.ts';
import {
  runtimeTaskToAdmittedTask,
  runtimeTaskToDetail,
  runtimeTaskToSummary,
} from './runtimeReadModels.ts';
import { runtimeTaskReadPageSchema, runtimeTaskReadResourceSchema } from './taskReadSchemas.ts';

const runtimeTaskMutationSchema = runtimeMutationSchema(runtimeTaskResourceSchema);

export type TaskAdmissionReservation = {
  key: string;
  reserve(request: { method: string; path: string; body: string; key: string }): Promise<void>;
  assertCurrent(): void;
  admitted?(task: BridgeTaskAdmissionResponse['task']): Promise<void>;
  /** Notify the existing requester only after the whole managed admission settles. */
  settled?(): Promise<void>;
};

export type TaskRoutesOptions = {
  /** The project slug every task route is scoped under (`/projects/:slug/…`). */
  projectSlug: string;
};

/** Legacy task envelope accepted only to produce a local fail-closed error. */
interface LegacyBridgeTaskEnvelope {
  family: string;
  input: unknown;
}

export class AstridLocalTaskRoutes {
  private readonly transport: AstridBridgeTransport;
  private readonly projectSlug: string;

  constructor(transport: AstridBridgeTransport, options: TaskRoutesOptions) {
    this.transport = transport;
    this.projectSlug = options.projectSlug;
  }

  private projectTasksPath(): string {
    return `/v1/projects/${encodeURIComponent(this.projectSlug)}/tasks`;
  }

  /**
   * Admission. `idempotencyKey` is REQUIRED by the bridge
   * (`Idempotency-Key` header); replaying the same key with the same body is
   * the server's dedup primitive, so callers derive keys deterministically.
   */
  async admit(
    request: BridgeTaskAdmissionRequest,
    idempotencyKey: string,
    reservation?: TaskAdmissionReservation,
  ): Promise<BridgeTaskAdmissionResponse>;
  async admit(
    request: LegacyBridgeTaskEnvelope,
    idempotencyKey: string,
    reservation?: TaskAdmissionReservation,
  ): Promise<BridgeTaskAdmissionResponse>;
  async admit(
    request: BridgeTaskAdmissionRequest | LegacyBridgeTaskEnvelope,
    idempotencyKey: string,
    reservation?: TaskAdmissionReservation,
  ): Promise<BridgeTaskAdmissionResponse> {
    if ('family' in request && !('project' in request)) {
      throw new Error(
        `Legacy task family ${request.family} is unsupported; submit the canonical HC-04 admission envelope`,
      );
    }
    // Validate on the client too: an invalid admit must fail here, before a
    // receipted key is spent on a request the bridge would reject.
    const parsed = bridgeTaskAdmissionRequestSchema.parse(request);
    // Rebuild the closed envelope in contract order so the bytes used by
    // Runtime's idempotency receipt are independent of caller key order.
    const canonicalRequest: BridgeTaskAdmissionRequest = {
      project: parsed.project,
      capability_id: parsed.capability_id,
      capability_digest: parsed.capability_digest,
      schema_version: parsed.schema_version,
      input_object_ids: [...parsed.input_object_ids],
      spec: {
        family: parsed.spec.family,
        params: parsed.spec.params,
        output_policy: parsed.spec.output_policy,
      },
      storage_estimate: {
        scratch_bytes: parsed.storage_estimate.scratch_bytes,
        output_bytes: parsed.storage_estimate.output_bytes,
      },
      ...(parsed.execution_request ? { execution_request: parsed.execution_request } : {}),
      generation_intent: parsed.generation_intent,
      settlement_effect: parsed.settlement_effect,
    };
    const body = JSON.stringify(canonicalRequest);
    if (reservation) {
      if (reservation.key !== idempotencyKey) throw new Error('Placement admission key changed');
      await reservation.reserve({ method: 'POST', path: '/v1/tasks', body, key: idempotencyKey });
      reservation.assertCurrent();
    }
    const response = await this.transport.requestJson(
      '/v1/tasks',
      { method: 'POST', rawBody: body, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey } },
      runtimeTaskMutationSchema,
      'task admission',
    );
    if (reservation && (response.data.project_id !== parsed.project
      || response.data.idempotency_key !== idempotencyKey || response.data.capability_id !== parsed.capability_id
      || response.data.capability_digest !== parsed.capability_digest)) {
      throw new Error('Task response differs from the reserved admission');
    }
    // Keep the app-facing admission projection stable while making the
    // neutral Runtime resource the only accepted wire shape at this boundary.
    const task = runtimeTaskToAdmittedTask(response.data, this.projectSlug);
    bridgeTaskAdmissionResponseSchema.parse({ task });
    if (reservation?.admitted) {
      reservation.assertCurrent();
      await reservation.admitted(task);
      reservation.assertCurrent();
    }
    if (typeof window !== 'undefined') {
      dispatchAppEvent('runtime:task-admitted', { projectId: this.projectSlug });
    }
    return { task };
  }

  /** Bounded task page for polling reads (`limit`, opaque Runtime cursor). */
  async list(options: { limit?: number; offset?: number; cursor?: string } = {}): Promise<BridgeTaskList & { next_cursor: string | null }> {
    if (options.offset !== undefined && options.offset !== 0 && options.cursor === undefined) {
      throw new Error('Astrid task pagination uses an opaque Runtime cursor; offset > 0 is unsupported');
    }
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.cursor !== undefined) params.set('cursor', options.cursor);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    const page = await this.transport.requestJson(
      this.projectTasksPath() + query,
      {},
      runtimeTaskReadPageSchema,
      'task list',
    );
    return {
      tasks: page.items.map((task) => runtimeTaskToSummary(task, this.projectSlug)),
      next_offset: null,
      next_cursor: page.next_cursor,
    };
  }

  /** One task's full read model incl. attempts and committed outputs. */
  async get(taskId: string): Promise<ReturnType<typeof runtimeTaskToDetail>> {
    const resource = await this.transport.requestJson(
      `/v1/tasks/${encodeURIComponent(taskId)}`,
      {},
      runtimeTaskReadResourceSchema,
      'task detail',
    );
    return runtimeTaskToDetail(resource, this.projectSlug);
  }

  /** Bounded Runtime-owned task event page; cursor remains opaque to the app. */
  async events(taskId: string, options: { cursor?: string; limit?: number } = {}) {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Astrid task event limit must be an integer from 1 to 100');
    }
    const params = new URLSearchParams({ aggregate_id: taskId, limit: String(limit) });
    if (options.cursor !== undefined) params.set('cursor', options.cursor);
    return this.transport.requestJson(
      `/v1/events?${params.toString()}`,
      {},
      runtimeEventPageSchema,
      'task events',
    );
  }

  /**
   * Common queued/running cancellation. A running cancel requires the live
   * attempt fence; cancelling an already-terminal task replays its current
   * state without error.
   */
  async cancel(taskId: string, fence: BridgeCancelRequest = {}): Promise<BridgeCancelResponse> {
    const parsedFence = bridgeCancelRequestSchema.parse(fence);
    const body = parsedFence.status_version === undefined
      ? {}
      : { expected_version: parsedFence.status_version };
    // Runtime key grammar: ^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$ — separators
    // must stay inside that set (a colon key is a hard 400 on this route).
    const idempotencyKey = `astrid.task.cancel-${taskId}-${parsedFence.status_version ?? 'current'}`;
    const response = await this.transport.requestJson(
      `/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
      { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } },
      runtimeTaskMutationSchema,
      'task cancel',
    );
    return { task: runtimeTaskToAdmittedTask(response.data, this.projectSlug) };
  }
}

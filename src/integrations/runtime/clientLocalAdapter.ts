import type { AstridLocalClient } from '@/integrations/astrid/client.ts';
import type { TaskAdmissionReservation } from '@/integrations/astrid/taskRoutes.ts';
import {
  bridgeTaskAdmissionRequestSchema,
  bridgeTaskAdmissionResponseSchema,
  type BridgeTaskAdmissionRequest,
  type BridgeTaskAdmissionResponse,
} from '@/tools/video-editor/data/bridgeContract.ts';
import type { OutboxRequest } from '@/tools/video-editor/commands/commitOutbox.ts';
import type { OutboxScope } from '@/tools/video-editor/commands/commitOutbox.ts';
import type { EditorImagePlacementHost } from '@/tools/video-editor/commands/editorImagePlacement.ts';
import type { Capability } from './generated.ts';
import { RuntimeOperationHost, type RuntimeOperation } from './operationHost.ts';

type LocalClient = Pick<AstridLocalClient, 'tasks' | 'catalog' | 'objects'>;

function canonicalAdmission(request: BridgeTaskAdmissionRequest): string {
  return JSON.stringify({
    project: request.project,
    capability_id: request.capability_id,
    capability_digest: request.capability_digest,
    schema_version: request.schema_version,
    input_object_ids: [...request.input_object_ids],
    spec: {
      family: request.spec.family,
      params: request.spec.params,
      output_policy: request.spec.output_policy,
    },
    storage_estimate: {
      scratch_bytes: request.storage_estimate.scratch_bytes,
      output_bytes: request.storage_estimate.output_bytes,
    },
    ...(request.execution_request ? { execution_request: request.execution_request } : {}),
    generation_intent: request.generation_intent,
    settlement_effect: request.settlement_effect,
  });
}

function admittedResponse(projectId: string, value: Awaited<ReturnType<RuntimeOperation['admitPreparedTask']>>): BridgeTaskAdmissionResponse {
  const task = {
    id: value.task_id,
    project_id: value.project_id ?? projectId,
    capability: value.capability_id,
    spec: value.spec,
    status: value.state === 'retrying' ? 'queued' : value.state,
    run_id: value.run_id,
    winning_attempt_id: value.attempt_id ?? null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
  return bridgeTaskAdmissionResponseSchema.parse({ task });
}

/**
 * Adapt one already-negotiated generated Runtime client to the existing
 * AstridLocalClient task surface. The adapter has no transport or identity
 * of its own; every method stays on the operation's pinned handle.
 */
export function createOperationLocalClient(operation: RuntimeOperation, projectId: string): LocalClient {
  const catalog = {
    async get(capabilityId: string) {
      if (!capabilityId) throw new Error('capability ID is required');
      let cursor: string | undefined;
      const seen = new Set<string>();
      let match: Capability | undefined;
      while (true) {
        const page = await operation.listCapabilities(cursor);
        for (const capability of page.items) {
          if (seen.has(capability.capability_id)) throw new Error(`capability catalog contains duplicate ID: ${capability.capability_id}`);
          seen.add(capability.capability_id);
          if (capability.capability_id === capabilityId) {
            if (match) throw new Error(`capability catalog contains duplicate ID: ${capabilityId}`);
            match = capability;
          }
        }
        if (page.next_cursor === null) break;
        if (!page.next_cursor) throw new Error('capability catalog cursor is empty');
        cursor = page.next_cursor;
      }
      if (!match) throw new Error(`capability is not registered: ${capabilityId}`);
      if (match.status !== 'ready') throw new Error(`capability is not ready: ${capabilityId}`);
      return match;
    },
    async bind(capabilityId: string, expectedDigest?: string) {
      const capability = await catalog.get(capabilityId);
      if (expectedDigest !== undefined && expectedDigest !== capability.definition_digest) {
        throw new Error(`capability digest mismatch: ${capabilityId}`);
      }
      return capability.definition_digest;
    },
  };
  const objects = {
    async list(options: { cursor?: string; limit?: number } = {}) {
      return await operation.listProjectObjects(projectId, options.cursor, options.limit);
    },
  };
  const tasks = {
    async admit(request: BridgeTaskAdmissionRequest, idempotencyKey: string, reservation?: TaskAdmissionReservation) {
      const parsed = bridgeTaskAdmissionRequestSchema.parse(request);
      if (parsed.project !== projectId) throw new Error('Task admission project differs from the bound editor project');
      const body = canonicalAdmission(parsed);
      if (reservation && reservation.key !== idempotencyKey) throw new Error('Placement admission key changed');
      const saved: OutboxRequest = { method: 'POST', path: '/v1/tasks', body, key: idempotencyKey };
      const release = reservation ? operation.beginTaskSubmission(saved, reservation.assertCurrent) : undefined;
      try {
        if (reservation) {
          await reservation.reserve(saved);
          reservation.assertCurrent();
        }
        const admitted = await operation.admitPreparedTask(saved);
        if (admitted.project_id !== parsed.project || admitted.idempotency_key !== idempotencyKey
          || admitted.capability_id !== parsed.capability_id || admitted.capability_digest !== parsed.capability_digest) {
          throw new Error('Task response differs from the reserved admission');
        }
        const task = admittedResponse(projectId, admitted);
        if (reservation?.admitted) {
          reservation.assertCurrent();
          await reservation.admitted(task.task);
          reservation.assertCurrent();
        }
        return task;
      } finally { release?.(); }
    },
  };
  return { catalog, objects, tasks } as LocalClient;
}

/** The Provider owns this binding and retires it with the editor lifetime. */
export function createEditorImagePlacementHost(operation: RuntimeOperation, projectId: string): EditorImagePlacementHost {
  const client = createOperationLocalClient(operation, projectId);
  return {
    client,
    operation,
    isCurrentIdentity: (scope: OutboxScope) => operation.isCurrentIdentity(scope),
    retire: operation.retire,
  };
}

/** Bind once for the editor lifetime; callers must pass the result to the session. */
export async function bindEditorImagePlacementHost(host: RuntimeOperationHost, projectId: string): Promise<EditorImagePlacementHost> {
  return createEditorImagePlacementHost(await host.bind(), projectId);
}

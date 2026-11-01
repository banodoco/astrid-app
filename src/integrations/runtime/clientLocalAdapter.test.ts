import { describe, expect, it, vi } from 'vitest';
import type { Task } from './generated.ts';
import type { RuntimeOperation } from './operationHost.ts';
import { createOperationLocalClient } from './clientLocalAdapter.ts';

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const request = {
  project: 'project', capability_id: 'generation.generate_image', capability_digest: digest('a'), schema_version: '1' as const,
  input_object_ids: [], spec: { family: 'generation.generate_image', params: { count: 1 }, output_policy: {} },
  storage_estimate: { scratch_bytes: 1, output_bytes: 1 },
  generation_intent: { prompt: 'one' },
  settlement_effect: { effect_type: 'generation.publish_v1' as const, target_id: 'project', payload: {
    version: 1, modality: 'image' as const, generation_type: 'image', metadata: {}, partial_success_policy: 'reject' as const,
    groups: [{ group_key: 'group', selectors: [{ variant_key: 'variant', output_port: 'image', ordinal: 0, selector: 'requested' }],
    }],
  } },
};
const task: Task = {
  task_id: 'task', run_id: 'run', project_id: 'project', state: 'queued', version: 1,
  capability_id: request.capability_id, capability_digest: request.capability_digest, idempotency_key: 'key',
  created_at: 'created', updated_at: 'updated', runtime_epoch: 1, input_object_ids: [], spec: {},
};

function operation() {
  const calls: string[] = [];
  const release = vi.fn();
  const fake = {
    beginTaskSubmission: vi.fn(() => release),
    listCapabilities: vi.fn(async () => ({ items: [{ capability_id: request.capability_id, definition_digest: request.capability_digest,
      status: 'ready' as const, required_resource_keys: [], estimated_scratch_bytes: 1, estimated_output_bytes: 1 }], next_cursor: null })),
    listProjectObjects: vi.fn(async () => ({ items: [], next_cursor: null })),
    admitPreparedTask: vi.fn(async (saved: { body: string }) => { calls.push(saved.body); return task; }),
  };
  return { fake: fake as unknown as RuntimeOperation, calls, release };
}

describe('operation-to-local task client adapter', () => {
  it('uses the existing local route surface and preserves the task reservation body', async () => {
    const env = operation();
    const client = createOperationLocalClient(env.fake, 'project');
    expect(await client.catalog.bind(request.capability_id, request.capability_digest)).toBe(request.capability_digest);
    await client.objects.list();
    const reserve = vi.fn(async () => undefined);
    const assertCurrent = vi.fn();
    const admitted = vi.fn(async () => undefined);
    const response = await client.tasks.admit(request, 'key', { key: 'key', reserve, assertCurrent, admitted });
    expect(response.task).toMatchObject({ id: 'task', project_id: 'project', run_id: 'run', status: 'queued' });
    expect(reserve).toHaveBeenCalledWith({ method: 'POST', path: '/v1/tasks', body: env.calls[0], key: 'key' });
    expect(JSON.parse(env.calls[0])).toEqual({
      ...request,
      // The route's canonical serializer omits no optional fields supplied by this request.
      schema_version: '1',
    });
    expect(admitted).toHaveBeenCalledWith(response.task);
    expect(assertCurrent).toHaveBeenCalled();
    expect(env.release).toHaveBeenCalledOnce();
  });

  it.each(['reserve', 'admit', 'locator'] as const)('releases the active submission after a %s failure', async (stage) => {
    const env = operation();
    const client = createOperationLocalClient(env.fake, 'project');
    const reserve = vi.fn(async () => {
      expect(env.fake.beginTaskSubmission).toHaveBeenCalledOnce();
      expect(env.release).not.toHaveBeenCalled();
      if (stage === 'reserve') throw new Error('reserve failed');
    });
    if (stage === 'admit') vi.mocked(env.fake.admitPreparedTask).mockRejectedValueOnce(new Error('admit failed'));
    const admitted = vi.fn(async () => {
      expect(env.release).not.toHaveBeenCalled();
      throw new Error('locator failed');
    });
    await expect(client.tasks.admit(request, 'key', { key: 'key', reserve, assertCurrent: vi.fn(), admitted }))
      .rejects.toThrow(`${stage} failed`);
    expect(env.release).toHaveBeenCalledOnce();
    expect(env.calls).toHaveLength(stage === 'locator' ? 1 : 0);
  });

  it('refuses an idempotency key that differs from the reserved key before admission', async () => {
    const env = operation();
    const client = createOperationLocalClient(env.fake, 'project');
    await expect(client.tasks.admit(request, 'other', { key: 'key', reserve: vi.fn(), assertCurrent: vi.fn() }))
      .rejects.toThrow('Placement admission key changed');
    expect(env.calls).toHaveLength(0);
  });
});

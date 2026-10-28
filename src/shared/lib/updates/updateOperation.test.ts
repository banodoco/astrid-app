import { describe, expect, it, vi } from 'vitest';
import { AstridRuntimeClient, type InstallerUpdateHealth, type InstallerUpdateStatus } from '@/integrations/runtime/client.ts';
import { ApiError } from '@/integrations/runtime/generated.ts';
import { UpdateOperation, pageUpdateOperation } from './updateOperation.ts';
import { checkHostedUpdate } from './updateStatus.ts';

vi.mock('./updateStatus.ts', () => ({ checkHostedUpdate: vi.fn(async () => null) }));

const HEALTH: InstallerUpdateHealth = {
  status: 'ok', protocol: 'workspace.v1', schema_digest: 'digest', runtime_epoch: 3,
  runtime_session_id: 'session-1', runtime_instance_id: 'instance-1', release: 12,
  identity: { managed_by: null, release: 12 },
};

const NONE: InstallerUpdateStatus = { available: true, state: 'none' };

type ClientMethods = Pick<AstridRuntimeClient, 'readInstallerUpdateHealth' | 'readInstallerUpdateStatus' | 'startInstallerUpdate'>;

function makeOperation(options: {
  statuses: Array<InstallerUpdateStatus | Error>;
  start?: () => Promise<Awaited<ReturnType<AstridRuntimeClient['startInstallerUpdate']>>>;
}) {
  let statusIndex = 0;
  const client: ClientMethods = {
    readInstallerUpdateHealth: vi.fn(async () => HEALTH),
    readInstallerUpdateStatus: vi.fn(async () => {
      const item = options.statuses[Math.min(statusIndex++, options.statuses.length - 1)];
      if (item instanceof Error) throw item;
      return item ?? NONE;
    }),
    startInstallerUpdate: vi.fn(options.start ?? (async () => ({
      accepted: true as const, state: 'accepted' as const,
      operation_id: 'f'.repeat(32), message: 'Update accepted.',
    }))),
  };
  return { operation: new UpdateOperation(client as AstridRuntimeClient), client };
}

describe('UpdateOperation', () => {
  it('keeps authenticated release ordering when an older Runtime has no F1 status route', async () => {
    const releaseStatus = {
      release: 12, app: 'page', servedRelease: 4, servedApp: 'served', behind: false,
      resolution: { installedRelease: 12, servedRelease: 4, releaseBehind: false },
    };
    vi.mocked(checkHostedUpdate).mockResolvedValueOnce(releaseStatus);
    const { operation, client } = makeOperation({ statuses: [new ApiError(404, 'not_found', 'No update route.', 'req-old')] });

    await operation.refresh();
    await operation.start();

    expect(operation.getSnapshot()).toMatchObject({ health: HEALTH, releaseStatus, fresh: false });
    expect(operation.getSnapshot().error).toMatch(/not_found/i);
    expect(client.startInstallerUpdate).not.toHaveBeenCalled();
  });

  it.each([
    { state: 'active' as const, outcome: undefined },
    { state: 'terminal' as const, outcome: 'updated' as const },
  ])('recovers a dropped POST acknowledgement from matching $state status without retrying', async ({ state, outcome }) => {
    const acceptedJob: InstallerUpdateStatus = {
      available: true, state, operation_id: 'a'.repeat(32),
      ...(outcome ? { outcome, result: 'Update completed.' } : {}),
    };
    const { operation, client } = makeOperation({
      statuses: [NONE, acceptedJob],
      start: async () => { throw new TypeError('connection reset after acceptance'); },
    });

    await operation.refresh();
    await operation.start();

    expect(client.startInstallerUpdate).toHaveBeenCalledOnce();
    expect(operation.getSnapshot()).toMatchObject({ status: acceptedJob, pending: state === 'active', fresh: true });
  });

  it('does not expose a mismatched operation result after tracking an active operation', async () => {
    const current: InstallerUpdateStatus = { available: true, state: 'active', operation_id: 'a'.repeat(32) };
    const staleOther: InstallerUpdateStatus = {
      available: true, state: 'terminal', operation_id: 'b'.repeat(32), outcome: 'updated', result: 'Wrong update result.',
    };
    const { operation } = makeOperation({ statuses: [current, staleOther] });
    await operation.refresh();

    await operation.refresh();

    expect(operation.getSnapshot()).toMatchObject({ status: null, fresh: false });
    expect(operation.getSnapshot().error).toMatch(/does not match/i);
    expect(operation.getSnapshot().status?.result).not.toBe('Wrong update result.');
  });

  it('keeps a definite installer refusal visible and never retries the POST', async () => {
    const refusal = new ApiError(409, 'conflict', 'This installation is not eligible.', 'req-1', { reason: 'source' });
    const { operation, client } = makeOperation({ statuses: [NONE, NONE], start: async () => { throw refusal; } });
    await operation.refresh();

    await operation.start();

    expect(client.startInstallerUpdate).toHaveBeenCalledOnce();
    expect(operation.getSnapshot().pending).toBe(false);
    expect(operation.getSnapshot().error).toMatch(/not eligible/i);
  });

  it('keeps authentication failure status stale and does not retry after a denied POST', async () => {
    const authError = new ApiError(401, 'unauthorized', 'installer:update scope required.', 'req-auth');
    const { operation, client } = makeOperation({
      statuses: [NONE, authError],
      start: async () => { throw authError; },
    });
    await operation.refresh();

    await operation.start();

    expect(client.startInstallerUpdate).toHaveBeenCalledOnce();
    expect(operation.getSnapshot()).toMatchObject({ fresh: false, pending: false });
    expect(operation.getSnapshot().error).toMatch(/unauthorized/i);
  });

  it('reuses a page-owned operation across component remounts', () => {
    const base = `https://connector-${crypto.randomUUID()}.test/api/runtime`;
    expect(pageUpdateOperation(base)).toBe(pageUpdateOperation(base));
  });
});

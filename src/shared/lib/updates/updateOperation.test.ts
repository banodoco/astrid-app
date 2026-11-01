import { describe, expect, it, vi } from 'vitest';
import { AstridRuntimeClient, type InstallerUpdateHealth, type InstallerUpdateStatus } from '@/integrations/runtime/client.ts';
import { ApiError } from '@/integrations/runtime/generated.ts';
import { installerUpdateStatusMessage, LocalPageUpdate, LOCAL_PAGE_REFUSAL_MESSAGES, UpdateOperation, pageLocalUpdate, pageUpdateOperation } from './updateOperation.ts';
import { checkHostedUpdate } from './updateStatus.ts';

vi.mock('./updateStatus.ts', () => ({ checkHostedUpdate: vi.fn(async () => null) }));

const HEALTH: InstallerUpdateHealth = {
  status: 'ok', protocol: 'workspace.v1', schema_digest: 'digest', runtime_epoch: 3,
  runtime_session_id: 'session-1', runtime_instance_id: 'instance-1', release: 12,
  identity: { managed_by: null, release: 12 },
};

const NONE: InstallerUpdateStatus = { available: true, state: 'none' };

describe('installerUpdateStatusMessage', () => {
  it.each([
    [{ state: 'active' }, 'Update in progress. Astrid may disconnect while it restarts.'],
    [{ state: 'terminal', outcome: 'updated', result: 'internal completed marker' }, 'Astrid updated. Reload to continue.'],
    [{ state: 'terminal', outcome: 'rolled_back', result: 'rolled_back' }, 'The update did not finish. Astrid was restored to its previous version.'],
    [{ state: 'recovery-needed', result: 'repair_required' }, 'Astrid needs recovery. Select Update to check the previous operation before continuing.'],
    [{ state: 'none', reason: 'busy' }, 'Astrid is busy. Wait for the current operation to finish before trying again.'],
    [{ state: 'none', reason: 'autostart-off' }, 'Automatic startup is off. Turn it on before updating Astrid here.'],
    [{ state: 'none', reason: 'unsupported-service-manager' }, 'In-app updates require user systemd 254 or newer on Linux.'],
  ] as const)('presents %j as clear user-facing status', (status, expected) => {
    expect(installerUpdateStatusMessage({ available: true, ...status } as InstallerUpdateStatus)).toBe(expected);
  });
});

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
  it('does not continue a recovery status without a valid operation identity', async () => {
    const { operation, client } = makeOperation({ statuses: [{ available: true, state: 'recovery-needed' }] });
    await operation.refresh();
    await operation.start();
    expect(client.startInstallerUpdate).not.toHaveBeenCalled();
  });

  it('does not settle a continuation from an unrelated acknowledgement or status', async () => {
    const recovery: InstallerUpdateStatus = { available: true, state: 'recovery-needed', operation_id: 'a'.repeat(32) };
    const unrelated: InstallerUpdateStatus = { available: true, state: 'recovery-needed', operation_id: 'b'.repeat(32) };
    const { operation, client } = makeOperation({
      statuses: [recovery, unrelated, unrelated],
      start: async () => ({ accepted: true, state: 'accepted', operation_id: 'b'.repeat(32), message: 'Update accepted.' }),
    });
    await operation.refresh();
    await operation.start();
    await operation.refresh();
    expect(operation.getSnapshot()).toMatchObject({ status: null, pending: true, fresh: false });
    expect(client.startInstallerUpdate).toHaveBeenCalledOnce();
  });

  it('retains the unresolved operation through two lost continuation acknowledgements', async () => {
    const recovery: InstallerUpdateStatus = { available: true, state: 'recovery-needed', operation_id: 'a'.repeat(32) };
    const { operation, client } = makeOperation({
      statuses: [recovery, recovery, recovery],
      start: async () => { throw new TypeError('connection reset after continuation'); },
    });
    await operation.refresh();
    await operation.start();
    expect(operation.getSnapshot()).toMatchObject({ status: recovery, pending: false, fresh: true });
    await operation.start();
    expect(operation.getSnapshot()).toMatchObject({ status: recovery, pending: false, fresh: true });
    expect(client.startInstallerUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not settle a lost acknowledgement with a read started before the click', async () => {
    const recovery: InstallerUpdateStatus = { available: true, state: 'recovery-needed', operation_id: 'a'.repeat(32) };
    let resolveOld!: (status: InstallerUpdateStatus) => void;
    const oldRead = new Promise<InstallerUpdateStatus>((resolve) => { resolveOld = resolve; });
    const status = vi.fn().mockResolvedValueOnce(recovery).mockReturnValueOnce(oldRead).mockResolvedValueOnce(recovery);
    const client: ClientMethods = {
      readInstallerUpdateHealth: vi.fn(async () => HEALTH),
      readInstallerUpdateStatus: status,
      startInstallerUpdate: vi.fn(async () => { throw new TypeError('lost acknowledgement'); }),
    };
    const operation = new UpdateOperation(client as AstridRuntimeClient);
    await operation.refresh();
    const before = operation.refresh();
    const action = operation.start();
    resolveOld({ available: true, state: 'terminal', operation_id: 'a'.repeat(32), outcome: 'updated' });
    await Promise.all([before, action]);
    expect(status).toHaveBeenCalledTimes(3);
    expect(operation.getSnapshot()).toMatchObject({ status: recovery, pending: false, fresh: true });
    expect(client.startInstallerUpdate).toHaveBeenCalledOnce();
  });

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
    expect(operation.getSnapshot().error).toBe('Could not check Astrid update status. Check your connection and try again.');
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
    expect(operation.getSnapshot().error).toBe('Astrid could not start the update. Check its status before trying again.');
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
    expect(operation.getSnapshot().error).toBe('Could not check Astrid update status. Check your connection and try again.');
  });

  it('reuses a page-owned operation across component remounts', () => {
    const base = `https://connector-${crypto.randomUUID()}.test/api/runtime`;
    expect(pageUpdateOperation(base)).toBe(pageUpdateOperation(base));
  });
});

describe('LocalPageUpdate', () => {
  const TARGET = { url: 'http://127.0.0.1:5000/page-update', token: 'ef'.repeat(32) };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  function make(launcher: () => Response | Promise<Response>, target: () => Response = () => json(200, TARGET)) {
    const post = vi.fn(launcher);
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => String(input) === '/__astrid/local-update-page' ? target() : post(init as never)) as unknown as typeof fetch;
    return { update: new LocalPageUpdate(fetchImpl), post, fetchImpl };
  }

  it('sends one authenticated POST with a fresh 32-hex request id and reports the result', async () => {
    const { update, post } = make(() => json(200, { result: { status: 'updated', message: 'Restart Astrid when convenient' } }));
    const seen: string[] = [];
    update.subscribe(() => seen.push(update.getSnapshot().phase));
    const outcome = await update.start();
    expect(outcome).toEqual({ phase: 'done', status: 'updated', message: 'Astrid updated.' });
    expect(seen).toEqual(['running', 'done']);
    expect(post).toHaveBeenCalledOnce();
    const init = post.mock.calls[0]![0] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TARGET.token}`);
    expect(JSON.parse(init.body as string).requestId).toMatch(/^[0-9a-f]{32}$/);
  });

  it.each(['update_busy', 'non_fast_forward', 'dirty'] as const)('maps the 409 %s refusal', async (refusal) => {
    const { update } = make(() => json(409, { refusal, code: 'x' }));
    expect(await update.start()).toEqual({ phase: 'refused', refusal, message: LOCAL_PAGE_REFUSAL_MESSAGES[refusal] });
  });

  it('treats a replay 409 and other 4xx/422 as failures, not refusals', async () => {
    expect((await make(() => json(409, { error: 'used', code: 'replay' })).update.start()).phase).toBe('failed');
    expect(await make(() => json(422, { error: 'build failed' })).update.start()).toEqual({ phase: 'failed', message: 'The update did not complete. Check diagnostics before trying again.' });
  });

  it('reports recovered (rollback) as a completed outcome', async () => {
    const { update } = make(() => json(200, { result: { status: 'recovered', message: 'Rolled back.' } }));
    expect(await update.start()).toMatchObject({ phase: 'done', status: 'recovered' });
  });

  it('does not post when the receipt endpoint is unavailable, and never retries a lost reply', async () => {
    const unavailable = make(() => json(200, {}), () => json(503, { error: 'page_update_unavailable' }));
    expect((await unavailable.update.start()).phase).toBe('failed');
    expect(unavailable.post).not.toHaveBeenCalled();
    const lost = make(() => { throw new TypeError('connection reset'); });
    const outcome = await lost.update.start();
    expect(outcome).toMatchObject({ phase: 'failed' });
    expect(lost.post).toHaveBeenCalledOnce();
  });

  it('ignores a second start while running', async () => {
    let release!: () => void;
    const { update, post } = make(() => new Promise<Response>((resolve) => { release = () => resolve(json(200, { result: { status: 'up-to-date', message: '' } })); }));
    const first = update.start();
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    expect(await update.start()).toEqual({ phase: 'running' });
    release();
    expect((await first).phase).toBe('done');
    expect(post).toHaveBeenCalledOnce();
  });

  it('reuses one page-owned instance', () => {
    expect(pageLocalUpdate()).toBe(pageLocalUpdate());
  });
});

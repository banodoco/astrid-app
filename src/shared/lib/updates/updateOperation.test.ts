import { describe, expect, it, vi } from 'vitest';
import { AstridRuntimeClient, type InstallerUpdateHealth, type InstallerUpdateStatus } from '@/integrations/runtime/client.ts';
import { ApiError } from '@/integrations/runtime/generated.ts';
import { canStartInstallerUpdate, installerUpdateReasonOf, installerUpdateStatusMessage, LocalPageUpdate, LOCAL_PAGE_REFUSAL_MESSAGES, UpdateOperation, pageLocalUpdate, pageUpdateOperation } from './updateOperation.ts';
import { checkHostedUpdate } from './updateStatus.ts';

vi.mock('./updateStatus.ts', () => ({ checkHostedUpdate: vi.fn(async () => null) }));

const HEALTH: InstallerUpdateHealth = {
  status: 'ok', protocol: 'workspace.v1', schema_digest: 'digest', runtime_epoch: 3,
  runtime_session_id: 'session-1', runtime_instance_id: 'instance-1', release: 12,
  identity: { managed_by: null, release: 12 },
};

const NONE: InstallerUpdateStatus = { available: true, self_update: true, state: 'none' };

const GENERIC_LINE = "Astrid can't update itself on this computer. Run the command below to update it.";

describe('installerUpdateStatusMessage', () => {
  it.each([
    [{ state: 'active' }, 'Update in progress. Astrid may disconnect while it restarts.'],
    [{ state: 'terminal', outcome: 'updated', result: 'internal completed marker' }, 'Astrid updated. Reload to continue.'],
    [{ state: 'terminal', outcome: 'rolled_back', result: 'rolled_back' }, 'The update did not finish. Astrid was restored to its previous version.'],
    [{ state: 'recovery-needed', self_update: true, result: 'repair_required' }, 'Astrid needs recovery. Select Update to check the previous operation before continuing.'],
    [{ state: 'recovery-needed', result: 'repair_required' }, 'Astrid needs repair before it can update.'],
    [{ state: 'none', reason: 'busy' }, 'Astrid is busy. Wait for the current operation to finish before trying again.'],
    [{ state: 'none', reason: 'autostart-off' }, 'Start at sign-in is off, so update from a terminal. This command updates Astrid and starts it; your choice stays off.'],
    [{ state: 'none', reason: 'unsupported-service-manager' }, 'In-app updates require user systemd 254 or newer on Linux.'],
    [{ state: 'none', reason: 'source' }, 'This Astrid runs from source, so update those checkouts to their main branches and restart Astrid.'],
    [{ state: 'none', reason: 'updater-unavailable' }, GENERIC_LINE],
    [{ state: 'none', reason: 'needs-repair' }, GENERIC_LINE],
  ] as const)('presents %j as clear user-facing status', (status, expected) => {
    expect(installerUpdateStatusMessage({ available: true, ...status } as InstallerUpdateStatus)).toBe(expected);
  });
});

describe('canStartInstallerUpdate', () => {
  it('starts only when the Runtime reports self_update and no refusal reason blocks it', () => {
    expect(canStartInstallerUpdate({ available: true, state: 'none' })).toBe(false);
    expect(canStartInstallerUpdate({ available: true, self_update: false, state: 'none' })).toBe(false);
    expect(canStartInstallerUpdate({ available: false, self_update: true, state: 'none' })).toBe(true);
    expect(canStartInstallerUpdate({ available: true, self_update: true, state: 'none', reason: 'busy' })).toBe(false);
    expect(canStartInstallerUpdate({ available: true, self_update: true, state: 'recovery-needed' })).toBe(true);
    expect(canStartInstallerUpdate(null)).toBe(false);
  });
});

describe('installerUpdateReasonOf', () => {
  // Every status reason the Runtime can send: the reasons of GET /v1/update/status (astrid_runtime/update.py
  // _STATUS_REASONS and _REPORTED_REASONS, plus "none"). A new Runtime reason must be added here with its
  // App mapping, so the App never reads an unmapped reason as a refusal by accident.
  const RUNTIME_REASON_MAPPING: ReadonlyArray<readonly [string, ReturnType<typeof installerUpdateReasonOf>]> = [
    ['none', null],
    ['busy', 'busy'],
    ['autostart-off', 'autostart-off'],
    ['unsupported-service-manager', 'unsupported-service-manager'],
    ['source', 'source'],
    ['needs-repair', 'self-update-unavailable'],
    ['managed-elsewhere', 'self-update-unavailable'],
  ];

  it.each(RUNTIME_REASON_MAPPING)('maps the Runtime reason %s', (reason, expected) => {
    const status = { available: true, self_update: true, state: 'none', reason } as InstallerUpdateStatus;
    expect(installerUpdateReasonOf(status)).toBe(expected);
  });

  it('lets Update now start when the Runtime reports reason none', () => {
    expect(canStartInstallerUpdate({ available: true, self_update: true, state: 'none', reason: 'none' } as InstallerUpdateStatus)).toBe(true);
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
  it('keeps authenticated release ordering when an older Runtime has no F1 status route', async () => {
    const releaseStatus = {
      release: 12, app: 'page', servedRelease: 4, servedApp: 'served', behind: false,
      resolution: { installedRelease: 12, servedRelease: 4, releaseBehind: false },
    };
    vi.mocked(checkHostedUpdate).mockResolvedValueOnce(releaseStatus);
    const { operation, client } = makeOperation({ statuses: [new ApiError(404, 'not_found', 'No update route.', 'req-old')] });

    await operation.refresh();
    await operation.start(() => true);

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
    await operation.start(() => true);

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

    await operation.start(() => true);

    expect(client.startInstallerUpdate).toHaveBeenCalledOnce();
    expect(operation.getSnapshot().pending).toBe(false);
    // The source reason has its own line, and the refusal stays visible after the status re-read.
    expect(operation.getSnapshot().error).toBe('This Astrid runs from source, so update those checkouts to their main branches and restart Astrid.');
    await operation.refresh();
    expect(operation.getSnapshot().error).toBe('This Astrid runs from source, so update those checkouts to their main branches and restart Astrid.');
  });

  it('shows the busy line from a POST refusal reason', async () => {
    const busy = new ApiError(409, 'conflict', 'Busy.', 'req-busy', { reason: 'busy' });
    const { operation, client } = makeOperation({ statuses: [NONE], start: async () => { throw busy; } });
    await operation.refresh();
    await operation.start(() => true);
    expect(client.startInstallerUpdate).toHaveBeenCalledOnce();
    expect(operation.getSnapshot().error).toBe('Astrid is busy. Wait for the current operation to finish before trying again.');
  });

  it('reads a 409 details.kind as the earlier outcome, never as a refusal reason', async () => {
    const outcome = new ApiError(409, 'conflict', 'Already finished.', 'req-kind', { kind: 'rolled_back' });
    const { operation } = makeOperation({ statuses: [NONE], start: async () => { throw outcome; } });
    await operation.refresh();
    await operation.start(() => true);
    expect(operation.getSnapshot().error).toBe('The update did not finish. Astrid was restored to its previous version.');

    const unknownKind = new ApiError(409, 'conflict', 'Reconcile.', 'req-unknown', { kind: 'reconciling' });
    const second = makeOperation({ statuses: [NONE], start: async () => { throw unknownKind; } });
    await second.operation.refresh();
    await second.operation.start(() => true);
    expect(second.operation.getSnapshot().error).toBe('Astrid could not start the update. Check its status before trying again.');
    expect(second.operation.getSnapshot().refusalCode).toBeNull();
  });

  it('shows the generic line with the Runtime message for an unmapped refusal code and keeps the code', async () => {
    const unmapped = new ApiError(409, 'conflict', 'Disk is full.', 'req-disk', { reason: 'disk-full' });
    const { operation } = makeOperation({ statuses: [NONE], start: async () => { throw unmapped; } });
    await operation.refresh();
    await operation.start(() => true);
    expect(operation.getSnapshot()).toMatchObject({ error: `${GENERIC_LINE} Disk is full.`, refusalCode: 'disk-full', pending: false });
    await operation.refresh();
    expect(operation.getSnapshot()).toMatchObject({ error: `${GENERIC_LINE} Disk is full.`, refusalCode: 'disk-full' });
  });

  it('never starts an update from a Runtime without self_update, even when its status is fresh', async () => {
    const { operation, client } = makeOperation({ statuses: [{ available: true, state: 'none' }] });
    await operation.refresh();

    await operation.start(() => true);

    expect(client.startInstallerUpdate).not.toHaveBeenCalled();
    expect(operation.getSnapshot().pending).toBe(false);
  });

  it('keeps authentication failure status stale and does not retry after a denied POST', async () => {
    const authError = new ApiError(401, 'unauthorized', 'installer:update scope required.', 'req-auth');
    const { operation, client } = makeOperation({
      statuses: [NONE, authError],
      start: async () => { throw authError; },
    });
    await operation.refresh();

    await operation.start(() => true);

    expect(client.startInstallerUpdate).toHaveBeenCalledOnce();
    expect(operation.getSnapshot()).toMatchObject({ fresh: false, pending: false });
    expect(operation.getSnapshot().error).toBe('Could not check Astrid update status. Check your connection and try again.');
  });

  it('rechecks draft admission after publishing pending and refuses locally without POST', async () => {
    const { operation, client } = makeOperation({ statuses: [NONE] });
    await operation.refresh();
    let clean = true;
    operation.subscribe(() => { if (operation.getSnapshot().pending) clean = false; });

    await operation.start(() => clean);

    expect(client.startInstallerUpdate).not.toHaveBeenCalled();
    expect(operation.getSnapshot()).toMatchObject({ pending: false, fresh: true });
    expect(operation.getSnapshot().error).toMatch(/drafts changed/i);
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

  it('shows the warning lines of a success that has warnings, not only Astrid updated', async () => {
    const lines = [
      'Astrid updated: Release 4 → Release 5, but skills did not refresh.',
      'Next: Restart your coding agent so it loads the refreshed skills.',
      'Details: /home/user/.astrid/install.log',
    ];
    const { update } = make(() => json(200, { result: { status: 'updated', lines } }));
    const outcome = await update.start();
    expect(outcome).toEqual({ phase: 'done', status: 'updated', message: lines.join('\n') });
  });

  it.each(['update_busy', 'non_fast_forward', 'dirty'] as const)('maps the 409 %s refusal', async (refusal) => {
    const { update } = make(() => json(409, { refusal, code: 'x' }));
    expect(await update.start()).toEqual({ phase: 'refused', refusal, message: LOCAL_PAGE_REFUSAL_MESSAGES[refusal] });
  });

  it('treats a replay 409 and other 4xx/422 as failures, not refusals', async () => {
    expect((await make(() => json(409, { error: 'used', code: 'replay' })).update.start()).phase).toBe('failed');
    expect(await make(() => json(422, { error: 'build failed' })).update.start()).toEqual({ phase: 'failed', message: 'The update did not complete. Download diagnostics to see why.' });
  });

  it('shows the Agent lines, Next and Details included, for a not-updated or failed run', async () => {
    const next = 'Next: open astrid.haus > Settings > Updates > Download diagnostics, and send the file to support.';
    const details = 'Details: /home/me/.local/state/astrid/install.log';
    const notUpdated = ['Astrid did NOT update. It is still Release 13; Release 14 is available.', 'Why: an earlier update was interrupted.', next, details];
    const skipped = await make(() => json(200, { result: { status: 'not-updated', exitCode: 3, lines: notUpdated, message: notUpdated.join('\n') } })).update.start();
    expect(skipped).toEqual({ phase: 'failed', message: notUpdated.join('\n') });
    const failed = await make(() => json(422, { error: 'busy', lines: ['Astrid did NOT update: busy.', next, details], exitCode: 1 })).update.start();
    expect(failed.phase === 'failed' && failed.message.split('\n').slice(-2)).toEqual([next, details]);
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

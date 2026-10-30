import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Transport } from './generated.ts';
import { AstridRuntimeClient } from './client.ts';

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const oldStatus = { available: false, state: 'none', reason: 'updater-unavailable' };
const acceptance = {
  accepted: true,
  state: 'accepted',
  operation_id: '0123456789abcdef0123456789abcdef',
  message: 'Update accepted.',
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AstridRuntimeClient installer update adapter', () => {
  it.each([
    ['none', 'busy'],
    ['none', 'autostart-off'],
    ['none', 'unsupported-service-manager'],
    ['recovery-needed', undefined],
  ] as const)('accepts the contract %s state/reason without inventing another operation state', async (state, reason) => {
    const transport: Transport = async () => ({ status: 200, headers: {}, body: bytes({ available: state === 'none' && reason === undefined, state, ...(reason ? { reason } : {}) }) });
    const client = new AstridRuntimeClient({ baseUrl: 'https://connector.test', transport });
    await expect(client.readInstallerUpdateStatus()).resolves.toMatchObject({ state, ...(reason ? { reason } : {}) });
  });

  it('reads an older status payload without requiring a workspace schema handshake', async () => {
    const calls: Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown }> = [];
    const transport: Transport = async (method, path, headers, body) => {
      calls.push({ method, path, headers, body });
      return { status: 200, headers: {}, body: bytes(oldStatus) };
    };
    const client = new AstridRuntimeClient({ baseUrl: 'https://connector.test', token: 'secret', transport });

    await expect(client.readInstallerUpdateStatus()).resolves.toEqual(oldStatus);
    expect(calls).toEqual([{
      method: 'GET', path: '/v1/update/status',
      headers: { Accept: 'application/json', Authorization: 'Bearer secret' },
      body: undefined,
    }]);
  });

  it('bounds a stalled status read to eight seconds', async () => {
    vi.useFakeTimers();
    const transport: Transport = async () => new Promise(() => undefined);
    const client = new AstridRuntimeClient({ baseUrl: 'https://connector.test', transport });

    const pending = expect(client.readInstallerUpdateStatus()).rejects.toThrow('Installer update read timed out');
    await vi.advanceTimersByTimeAsync(8000);
    await pending;
  });

  it('uses a real fetch request with cache disabled and zero POST body bytes', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify(calls.length === 1 ? oldStatus : acceptance), {
        status: calls.length === 1 ? 200 : 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const client = new AstridRuntimeClient({ baseUrl: 'https://connector.test', token: 'secret' });

    await client.readInstallerUpdateStatus();
    await expect(client.startInstallerUpdate()).resolves.toEqual(acceptance);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://connector.test/v1/update/status');
    expect(calls[0]?.init).toMatchObject({ method: 'GET', cache: 'no-store' });
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: 'Bearer secret' });
    expect(calls[1]?.url).toBe('https://connector.test/v1/update');
    expect(calls[1]?.init.method).toBe('POST');
    expect(calls[1]?.init.body).toBeUndefined();
    expect(calls[1]?.init.headers).toMatchObject({ Authorization: 'Bearer secret' });
  });

  it('surfaces a lost acceptance acknowledgement after exactly one POST', async () => {
    let requests = 0;
    const transport: Transport = async () => {
      requests += 1;
      throw new TypeError('connection reset after acceptance');
    };
    const client = new AstridRuntimeClient({ baseUrl: 'https://connector.test', transport });

    await expect(client.startInstallerUpdate()).rejects.toThrow('connection reset after acceptance');
    expect(requests).toBe(1);
  });

  it('refuses to start an update from a read-only discovery client', async () => {
    const transport = vi.fn();
    const client = new AstridRuntimeClient({ baseUrl: 'https://connector.test', transport, readOnly: true });
    await expect(client.startInstallerUpdate()).rejects.toThrow('A discovery client cannot start an update');
    expect(transport).not.toHaveBeenCalled();
  });

  it('bounds a stalled POST acknowledgement without retrying the request', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(async () => new Promise<never>(() => undefined));
    const client = new AstridRuntimeClient({ baseUrl: 'https://connector.test', transport });
    const pending = expect(client.startInstallerUpdate()).rejects.toThrow('acknowledgement timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(transport).toHaveBeenCalledOnce();
  });

  it('preserves producer refusal reasons for the caller to distinguish acknowledgement ambiguity', async () => {
    const transport: Transport = async () => ({
      status: 409, headers: {},
      body: bytes({ code: 'conflict', message: 'The update was accepted; check update status.', details: { reason: 'launch-acknowledgement-unknown' } }),
    });
    const client = new AstridRuntimeClient({ baseUrl: 'https://connector.test', transport });

    await expect(client.startInstallerUpdate()).rejects.toMatchObject({
      status: 409, code: 'conflict', details: { reason: 'launch-acknowledgement-unknown' },
    });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
  ])('preserves authentication and permission errors (%i)', async (status, code) => {
    let requests = 0;
    const transport: Transport = async () => {
      requests += 1;
      return { status, headers: {}, body: bytes({ code, message: 'denied', details: { scope: 'installer:update' } }) };
    };
    const client = new AstridRuntimeClient({ baseUrl: 'https://connector.test', transport });

    await expect(client.startInstallerUpdate()).rejects.toMatchObject({
      status, code, details: { scope: 'installer:update' },
    } satisfies Partial<ApiError>);
    expect(requests).toBe(1);
  });

  it('reads the authenticated health identity directly, without negotiating a session', async () => {
    const health = {
      status: 'ok', protocol: 'workspace.v1', schema_digest: 'a-future-schema',
      runtime_epoch: 1, runtime_session_id: 'session', runtime_instance_id: 'instance',
      identity: { managed_by: 'source', release: 17 },
    };
    const calls: string[] = [];
    const transport: Transport = async (_method, path) => {
      calls.push(path);
      return { status: 200, headers: {}, body: bytes(health) };
    };
    const client = new AstridRuntimeClient({ baseUrl: 'https://connector.test', transport });

    await expect(client.readInstallerUpdateHealth()).resolves.toMatchObject({
      schema_digest: 'a-future-schema', release: 17, identity: { managed_by: 'source', release: 17 },
    });
    expect(calls).toEqual(['/v1/health']);
  });
});

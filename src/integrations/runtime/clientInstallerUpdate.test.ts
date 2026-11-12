import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Transport } from './generated.ts';
import { AstridRuntimeClient } from './client.ts';

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const oldStatus = { available: false, state: 'none' };
const acceptance = {
  accepted: true,
  state: 'accepted',
  operation_id: '0123456789abcdef0123456789abcdef',
  message: 'Update accepted.',
};
const terminal = (state: 'updated' | 'rolled_back' | 'failed') => ({
  accepted: false,
  state,
  operation_id: 'fedcba9876543210fedcba9876543210',
  message: `${state} while reconciling the previous operation.`,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AstridRuntimeClient installer update adapter', () => {
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

  it.each(['accepted', 'launching', 'active'] as const)('accepts an admitted %s response', async (state) => {
    const response = { ...acceptance, state };
    const transport: Transport = vi.fn(async () => ({ status: 202, headers: {}, body: bytes(response) }));
    const client = new AstridRuntimeClient({ baseUrl: 'https://connector.test', token: 'secret', transport });

    await expect(client.startInstallerUpdate()).resolves.toEqual(response);
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(['updated', 'rolled_back', 'failed'] as const)('accepts a terminal %s reconciliation response', async (state) => {
    const response = terminal(state);
    const transport: Transport = vi.fn(async () => ({ status: 202, headers: {}, body: bytes(response) }));
    const client = new AstridRuntimeClient({ baseUrl: 'https://connector.test', token: 'secret', transport });

    await expect(client.startInstallerUpdate()).resolves.toEqual(response);
    expect(transport).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledWith('POST', '/v1/update', { Accept: 'application/json', Authorization: 'Bearer secret' }, undefined);
  });

  it.each([
    { accepted: false, state: 'accepted', operation_id: 'a'.repeat(32), message: 'mismatched' },
    { accepted: true, state: 'updated', operation_id: 'a'.repeat(32), message: 'mismatched' },
    { accepted: false, state: 'active', operation_id: 'a'.repeat(32), message: 'non-terminal' },
    { accepted: false, state: ['failed'], operation_id: 'a'.repeat(32), message: 'array coercion' },
    { accepted: false, state: 'future', operation_id: 'a'.repeat(32), message: 'unknown' },
    { accepted: false, state: 7, operation_id: 'a'.repeat(32), message: 'non-string' },
    { accepted: false, state: 'failed', operation_id: 'not-an-operation', message: 'malformed id' },
    { accepted: false, state: 'failed', operation_id: 'a'.repeat(32) },
  ])('rejects malformed, mismatched, coerced, or unknown update response %#', async (body) => {
    const transport: Transport = vi.fn(async () => ({ status: 202, headers: {}, body: bytes(body) }));
    const client = new AstridRuntimeClient({ baseUrl: 'https://connector.test', transport });

    await expect(client.startInstallerUpdate()).rejects.toThrow('invalid installer update acceptance response');
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    { available: false, state: 'none', reason: 'busy' },
    { available: false, state: 'none', reason: 'autostart-off' },
    { available: false, state: 'none', reason: 'unsupported-service-manager' },
  ] as const)('accepts the allowlisted %s status reason', async (status) => {
    const transport: Transport = vi.fn(async () => ({ status: 200, headers: {}, body: bytes(status) }));
    const client = new AstridRuntimeClient({ baseUrl: 'https://connector.test', token: 'secret', transport });

    await expect(client.readInstallerUpdateStatus()).resolves.toEqual(status);
  });

  it.each([
    { available: true, state: 'none', reason: 'unknown-reason' },
    { available: false, state: 'none', reason: '' },
    { available: false, state: 'none', reason: 'recovery-needed' },
    { available: true, state: 'none', reason: 'busy' },
    { available: false, state: 'recovery-needed', reason: 'busy' },
    { available: false, state: ['none'], reason: undefined },
    { available: false, state: 'active', outcome: ['failed'] },
    { available: false, state: 'terminal' },
    { available: false, state: 7 },
    { available: false, state: 'none', reason: 7 },
  ])('rejects an unknown, malformed, or misplaced status field %#', async (status) => {
    const transport: Transport = vi.fn(async () => ({ status: 200, headers: {}, body: bytes(status) }));
    const client = new AstridRuntimeClient({ baseUrl: 'https://connector.test', transport });

    await expect(client.readInstallerUpdateStatus()).rejects.toThrow();
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

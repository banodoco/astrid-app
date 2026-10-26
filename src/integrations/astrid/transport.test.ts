// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

import {
  BridgeContractError,
  runtimeMutationReceiptSchema,
} from '@/tools/video-editor/data/bridgeContract.ts';
import {
  AstridBridgeTransport,
  BridgeRouteError,
  BridgeTransportFailure,
  classifyRouteError,
  type BridgeRequestInit,
} from './transport';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('Astrid bridge transport boundary', () => {
  it('accepts valid mutation receipts and rejects invalid sequence or missing values', () => {
    const valid = {
      receipt_id: 'receipt-1',
      command_kind: 'core.project.create',
      idempotency_key: 'request-1',
      request_hash: 'hash-1',
      project_id: 'project-1',
      project_seq: [1, 2] as [number, number],
      event_ids: ['event-1'],
      result: null,
      created_at: '2026-08-30T00:00:00Z',
    };

    expect(runtimeMutationReceiptSchema.safeParse(valid).success).toBe(true);
    expect(runtimeMutationReceiptSchema.safeParse({ ...valid, project_seq: [0, 2] }).success).toBe(false);
    expect(runtimeMutationReceiptSchema.safeParse({ ...valid, project_seq: [1] }).success).toBe(false);
    expect(runtimeMutationReceiptSchema.safeParse({ ...valid, receipt_id: '' }).success).toBe(false);
    const withoutResult = { ...valid };
    delete (withoutResult as { result?: unknown }).result;
    expect(runtimeMutationReceiptSchema.safeParse(withoutResult).success).toBe(false);
  });

  it.each([
    [429, 'rate_limited'],
    [413, 'payload_too_large'],
  ])('preserves typed upstream %s errors without fallback', async (status, code) => {
    const server = createServer((_request, response) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        ...(status === 429 ? { 'Retry-After': '1' } : {}),
      });
      response.end(JSON.stringify({ error: code, detail: 'server boundary' }));
    });
    const baseUrl = await listen(server);
    try {
      const transport = new AstridBridgeTransport({ baseUrl });
      const error = await transport.requestJson(
        '/projects/demo-project/timelines/timeline',
        {},
        z.object({ ok: z.boolean() }),
        'load timeline',
      ).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(BridgeRouteError);
      expect(error).toMatchObject({ status, code });
      // `rate_limited` is an Astrid wire code, not one of Astrid App's public
      // recovery categories; preserve it without relabeling as conflict.
      if (code === 'rate_limited') expect(error).toMatchObject({ category: 'unknown' });
    } finally {
      await close(server);
    }
  });

  it('maps the Runtime readiness refusal to capability_unavailable, not a stale-version conflict', async () => {
    expect(classifyRouteError(409, 'unavailable')).toBe('capability_unavailable');
    expect(classifyRouteError(409, 'conflict')).toBe('conflict');
    expect(classifyRouteError(409, 'lease_fenced')).toBe('conflict');

    const nextAction = 'fix: gpu_not_configured; run `astrid doctor --json`, then retry';
    const server = createServer((_request, response) => {
      response.writeHead(409, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        code: 'unavailable',
        message: 'capability is not ready for admission',
        details: {
          capability_id: 'acceptance.gpu',
          status: 'unavailable',
          reason: 'gpu_not_configured',
          next_action: nextAction,
        },
      }));
    });
    const baseUrl = await listen(server);
    try {
      const transport = new AstridBridgeTransport({ baseUrl });
      const error = await transport.requestJson(
        '/v1/projects/demo-project/tasks',
        { method: 'POST', body: {} },
        z.object({ ok: z.boolean() }),
        'admit task',
      ).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(BridgeRouteError);
      expect(error).toMatchObject({
        status: 409,
        code: 'unavailable',
        category: 'capability_unavailable',
        detail: 'capability is not ready for admission',
        nextAction,
      });
      expect((error as Error).message).toBe(
        `Astrid bridge admit task failed: capability is not ready for admission Next: ${nextAction}`,
      );
    } finally {
      await close(server);
    }
  });

  it('keeps the plain message when the Runtime names no next action', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(409, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 'conflict', message: 'stale version', details: { next_action: '   ' } }));
    });
    const baseUrl = await listen(server);
    try {
      const transport = new AstridBridgeTransport({ baseUrl });
      const error = await transport.requestJson(
        '/v1/projects/demo-project/tasks',
        { method: 'POST', body: {} },
        z.object({ ok: z.boolean() }),
        'admit task',
      ).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(BridgeRouteError);
      expect(error).toMatchObject({ category: 'conflict', nextAction: undefined });
      expect((error as Error).message).toBe('Astrid bridge admit task failed: stale version');
    } finally {
      await close(server);
    }
  });

  it('sends raw bytes unchanged while keeping JSON serialization explicit', async () => {
    const observed: Array<{ body: Uint8Array; contentType: string | null; idempotencyKey: string | null }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        observed.push({
          body: new Uint8Array(Buffer.concat(chunks)),
          contentType: typeof request.headers['content-type'] === 'string'
            ? request.headers['content-type']
            : null,
          idempotencyKey: typeof request.headers['idempotency-key'] === 'string'
            ? request.headers['idempotency-key']
            : null,
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    const baseUrl = await listen(server);
    try {
      const transport = new AstridBridgeTransport({ baseUrl });
      await transport.requestRaw('/v1/upload', {
        method: 'POST',
        rawBody: new Uint8Array([0, 255, 1]),
        headers: {
          'Content-Type': 'image/png',
          'Idempotency-Key': 'cas:test',
          'X-Original-Name': 'input.png',
        },
      });
      await transport.requestJson('/health', {
        method: 'POST',
        body: { ok: true },
      }, z.object({ ok: z.boolean() }), 'json');
      expect(observed[0]).toEqual({
        body: new Uint8Array([0, 255, 1]),
        contentType: 'image/png',
        idempotencyKey: 'cas:test',
      });
      expect(observed[1].body).toEqual(new Uint8Array(Buffer.from('{"ok":true}')));
      expect(observed[1].contentType).toBe('application/json');
      await expect(transport.requestRaw('/v1/upload', {
        method: 'POST',
        body: { invalid: true },
        rawBody: new Uint8Array([1]),
      } as BridgeRequestInit)).rejects.toThrow('both body and rawBody');
    } finally {
      await close(server);
    }
  });

  it.each(['deadline', 'caller'] as const)('aborts a slow bridge request via %s and releases the client request', async (abortSource) => {
    let requestStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    let requestClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => { requestClosed = resolve; });
    const server = createServer((_request, response) => {
      response.once('close', requestClosed);
      requestStarted();
    });
    const baseUrl = await listen(server);
    // Under load a wall-clock deadline can expire before the request reaches
    // the server, leaving no response to observe closing. Control the deadline
    // after dispatch while retaining the real fetch/socket cancellation check.
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    try {
      const transport = new AstridBridgeTransport({ baseUrl, timeoutMs: 25 });
      const rejected = expect(transport.requestJson(
        '/health',
        abortSource === 'caller' ? { timeoutMs: null, signal: deadline.signal } : {},
        z.object({ ok: z.boolean() }),
        'health',
      )).rejects.toBeInstanceOf(BridgeTransportFailure);
      await started;
      if (abortSource === 'caller') expect(timeout).not.toHaveBeenCalled();
      else expect(timeout).toHaveBeenCalledWith(25);
      deadline.abort(abortSource === 'caller'
        ? new DOMException('Cancelled by caller', 'AbortError')
        : new DOMException('The operation timed out', 'TimeoutError'));
      await rejected;
      await expect(closed).resolves.toBeUndefined();
    } finally {
      deadline.abort();
      timeout.mockRestore();
      await close(server);
    }
  });

  it.each([
    ['malformed JSON', '{"ok":'],
    ['truncated JSON', '{"ok": true'],
  ])('rejects a %s success response as a contract failure', async (_label, body) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        // A short declared body exercises the same fetch consumption path as
        // a peer that disconnects during a streamed JSON response.
        'Content-Length': String(body.length + 8),
        Connection: 'close',
      });
      response.end(body);
    });
    const baseUrl = await listen(server);
    try {
      const transport = new AstridBridgeTransport({ baseUrl });
      await expect(transport.requestJson(
        '/health',
        {},
        z.object({ ok: z.boolean() }),
        'health',
      )).rejects.toBeInstanceOf(BridgeContractError);
    } finally {
      await close(server);
    }
  });
});

describe('Astrid bridge transport quiet retry', () => {
  const schema = z.object({ ok: z.boolean() });
  const hangUp = () => new Response(JSON.stringify({ error: 'runtime_unavailable', detail: 'runtime request failed: socket hang up' }), { status: 503 });
  const okResponse = () => Response.json({ ok: true });
  const transport = () => new AstridBridgeTransport({ baseUrl: 'http://bridge.test' });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubFetch(impl: () => Promise<Response>) {
    vi.useFakeTimers();
    const fetchMock = vi.fn(impl);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('retries a GET upstream hang-up quietly and surfaces nothing', async () => {
    const fetchMock = stubFetch(async () => okResponse());
    fetchMock
      .mockResolvedValueOnce(hangUp())
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    const loading = transport().requestJson('/acp/events', {}, schema, 'ACP events');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(loading).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last delay with the original error', async () => {
    const fetchMock = stubFetch(async () => hangUp());
    const loading = transport().requestJson('/acp/events', {}, schema, 'ACP events');
    const settled = expect(loading).rejects.toMatchObject({ name: 'BridgeRouteError', status: 503, code: 'runtime_unavailable' });
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['a rejected request', () => new Response(JSON.stringify({ error: 'invalid_protocol', detail: 'Expected X-Astrid-Bridge-Version: v1' }), { status: 400 })],
    ['no chat service on this computer', () => new Response(JSON.stringify({ error: 'acp_unavailable' }), { status: 503 })],
  ])('does not retry %s', async (_name, failure) => {
    const fetchMock = stubFetch(async () => failure());
    const settled = expect(transport().requestJson('/acp/events', {}, schema, 'ACP events')).rejects.toBeInstanceOf(BridgeRouteError);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['POST', 'PATCH', 'DELETE'] as const)('never retries a %s', async (method) => {
    const fetchMock = stubFetch(async () => hangUp());
    const settled = expect(transport().requestJson('/acp/send', { method, body: {} }, schema, 'send')).rejects.toBeInstanceOf(BridgeRouteError);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops retrying at once when the caller aborts', async () => {
    const fetchMock = stubFetch(async () => hangUp());
    const controller = new AbortController();
    const settled = expect(transport().requestJson('/acp/events', { signal: controller.signal }, schema, 'ACP events')).rejects.toBeInstanceOf(BridgeRouteError);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

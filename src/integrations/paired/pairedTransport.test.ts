import { createServer, request as httpRequestFn, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, win32 } from 'node:path';
import ts from 'typescript';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { classifyPairedRoute, isSafeForwardPath } from '../../../config/vite/pairedRoutePolicy';
import { PairingError, PairingRegistry } from '../../../config/vite/pairedRegistry';
import { PairedRelay } from '../../../config/vite/pairedRelay';

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function httpRequest(port: number, path: string, method: string, origin: string, headers: Record<string, string> = {}, body = ''): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequestFn({ hostname: '127.0.0.1', port, path, method, headers: { Origin: origin, ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('paired transport boundary', () => {
  it('keeps the forwarding table closed and rejects destination tricks', () => {
    expect(classifyPairedRoute('/api/runtime/v1/health', 'GET')?.service).toBe('runtime');
    expect(classifyPairedRoute('/api/runtime/v1/projects/p1', 'PATCH')?.service).toBe('runtime');
    expect(classifyPairedRoute('/api/runtime/v1/projects/p1/objects', 'POST')?.stream).toBe(true);
    expect(classifyPairedRoute('/api/runtime/v1/projects/p1/media-imports', 'POST')?.stream).toBe(true);
    expect(classifyPairedRoute('/api/runtime/v1/projects/p1/media-imports/op-1', 'GET')?.service).toBe('runtime');
    expect(classifyPairedRoute('/api/runtime/v1/doctor', 'GET')).toBeNull();
    expect(classifyPairedRoute('/api/runtime/v1/tasks/claim', 'POST')).toBeNull();
    expect(classifyPairedRoute('/api/runtime/v1/export?destination=/tmp/x', 'GET')).toBeNull();
    expect(classifyPairedRoute('/api/runtime/http://127.0.0.1:1/v1/health', 'GET')).toBeNull();
    expect(classifyPairedRoute('/api/astrid/v1/capabilities?limit=50', 'GET')?.service).toBe('astrid');
    expect(isSafeForwardPath('/api/runtime/v1/objects/a%2Fb')).toBe(false);
  });

  it('consumes invitations once and fences revoked sessions', () => {
    let now = 1_000;
    const registry = new PairingRegistry(() => now);
    const connection = {};
    const connected = registry.connectConnector({ connectorId: 'connector-1', realmId: 'realm-1', connectorSecret: 'connector-secret', connection });
    expect(connected.invitation?.code).toHaveLength(43);
    const redeemed = registry.redeemInvitation(connected.invitation!.code);
    expect(registry.authorizeSession(redeemed.sessionToken).realmId).toBe('realm-1');
    expect(() => registry.redeemInvitation(connected.invitation!.code)).toThrowError(PairingError);
    registry.revoke(redeemed.pair.pairId);
    expect(() => registry.authorizeSession(redeemed.sessionToken)).toThrow();
    now += 9 * 60 * 60 * 1000;
    expect(registry.getPair(redeemed.pair.pairId)).toBeUndefined();
  });

  it('expires pending invitations and sessions at their configured bounds', () => {
    let now = 1_000;
    const registry = new PairingRegistry(() => now);
    const connected = registry.connectConnector({ connectorId: 'connector-1', realmId: 'realm-1', connectorSecret: 'secret-1' });
    now += 5 * 60 * 1000;
    expect(() => registry.redeemInvitation(connected.invitation!.code)).toThrowError(
      expect.objectContaining({ code: 'expired_invitation' }),
    );

    now = 1_000;
    const next = registry.connectConnector({ connectorId: 'connector-1', realmId: 'realm-1', connectorSecret: 'secret-1' });
    const redemption = registry.redeemInvitation(next.invitation!.code);
    now += 8 * 60 * 60 * 1000;
    expect(() => registry.authorizeSession(redemption.sessionToken)).toThrowError(
      expect.objectContaining({ code: 'expired_session' }),
    );
  });

  it('enforces invitation and session expiry through the live relay handler', async () => {
    let now = 1_000;
    const config = { origin: '', loopbackTest: true, enabled: true };
    const relay = new PairedRelay(config, () => now);
    const server = createServer(relay.handler());
    relay.installUpgrade(server as never);
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('live relay did not bind a TCP port');
    const port = address.port;
    config.origin = `http://127.0.0.1:${port}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/pairing/connector`);
    try {
      const hello = new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
        socket.once('error', reject);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => {
          socket.send(JSON.stringify({ type: 'connector_hello', connector_id: 'live-connector', connector_secret: 'live-secret', realm_id: 'live-realm' }));
          resolve();
        });
        socket.once('error', reject);
      });
      const acknowledged = await hello;
      expect(acknowledged.type).toBe('connector_hello_ack');
      const invitation = String(acknowledged.invitation);
      const pending = relay.registry.createInvitation('live-connector');
      now += 5 * 60 * 1000;
      const expiredInvitation = await httpRequest(port, '/api/pairing/redeem', 'POST', config.origin, { 'Content-Type': 'application/json' }, JSON.stringify({ invitation: pending.code }));
      expect(expiredInvitation.status).toBe(410);
      expect(JSON.parse(expiredInvitation.body).error).toBe('expired_invitation');

      now = 1_000;
      const redeemed = await httpRequest(port, '/api/pairing/redeem', 'POST', config.origin, { 'Content-Type': 'application/json' }, JSON.stringify({ invitation }));
      expect(redeemed.status).toBe(200);
      const cookie = String(redeemed.headers['set-cookie']).split(';', 1)[0];
      now += 8 * 60 * 60 * 1000;
      const expiredSession = await httpRequest(port, '/api/pairing/status', 'GET', config.origin, { Cookie: cookie });
      expect(expiredSession.status).toBe(401);
      expect(JSON.parse(expiredSession.body).error).toBe('expired_session');
    } finally {
      socket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reconnects only with the separate connector secret and advances generation', () => {
    const registry = new PairingRegistry(() => 1_000);
    const first = registry.connectConnector({ connectorId: 'connector-1', realmId: 'realm-1', connectorSecret: 'secret-1' });
    const firstGeneration = first.connector.generation;
    const redemption = registry.redeemInvitation(first.invitation!.code);
    const pair = redemption.pair;
    const second = registry.connectConnector({ connectorId: 'connector-1', realmId: 'realm-1', connectorSecret: 'secret-1' });
    expect(second.connector.generation).toBeGreaterThan(firstGeneration);
    expect(registry.authorizeSession(redemption.sessionToken).generation).toBe(second.connector.generation);
    expect(() => registry.authorizeConnector(pair.pairId, 'wrong-secret', second.connector.generation)).toThrow();
  });

  it('invalidates every invitation and the connector credential on revoke', () => {
    const registry = new PairingRegistry(() => 1_000);
    const first = registry.connectConnector({ connectorId: 'connector-1', realmId: 'realm-1', connectorSecret: 'secret-1' });
    const secondInvitation = registry.createInvitation('connector-1');
    const redemption = registry.redeemInvitation(first.invitation!.code);
    registry.revoke(redemption.pair.pairId);
    expect(() => registry.redeemInvitation(secondInvitation.code)).toThrowError(PairingError);
    expect(() => registry.connectConnector({ connectorId: 'connector-1', realmId: 'realm-1', connectorSecret: 'secret-1' })).toThrowError(PairingError);
  });
});


type ObservedConnector = WebSocket & { connectorId: string; generation: number };
type RelayPending = { connector: ObservedConnector; generation: number; done: boolean; response: ServerResponse };
type RelayObservation = {
  connectors: Map<string, ObservedConnector>;
  pending: Map<string, RelayPending>;
  onConnectorMessage(socket: ObservedConnector, message: Record<string, unknown>): void;
};

async function withBoundRelay(run: (venue: {
  relay: PairedRelay; observed: RelayObservation; port: number; origin: string;
  connect(id: string): Promise<{ socket: WebSocket; owner: ObservedConnector; hello: Record<string, unknown> }>;
}) => Promise<void>, overrides: { requestIdleTimeoutMs?: number } = {}) {
  const config = { origin: '', loopbackTest: true, enabled: true, ...overrides };
  const relay = new PairedRelay(config);
  const observed = relay as unknown as RelayObservation;
  const server = createServer(relay.handler());
  relay.installUpgrade(server as never);
  const sockets: WebSocket[] = [];
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('relay fixture did not bind');
  const port = address.port;
  config.origin = `http://127.0.0.1:${port}`;
  try {
    await run({ relay, observed, port, origin: config.origin, connect: async (id) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/pairing/connector`);
      sockets.push(socket);
      const hello = new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
        socket.once('error', reject);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => {
          socket.send(JSON.stringify({ type: 'connector_hello', connector_id: id, connector_secret: `${id}-fixture-secret`, realm_id: 'fixture-realm' }));
          resolve();
        });
        socket.once('error', reject);
      });
      const acknowledged = await hello;
      expect(acknowledged.type).toBe('connector_hello_ack');
      return { socket, owner: observed.connectors.get(id)!, hello: acknowledged };
    } });
  } finally {
    for (const item of observed.pending.values()) item.done = true;
    relay.restart();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const responseFrames = (id: string) => [
  { type: 'response_start', id, status: 201, headers: { 'X-Fixture': 'untrusted' } },
  { type: 'response_chunk', id, data: Buffer.from('untrusted').toString('base64') },
  { type: 'response_end', id },
  { type: 'response_error', id, detail: 'untrusted fixture' },
];

async function boundRequest(venue: Parameters<Parameters<typeof withBoundRelay>[0]>[0], connector: Awaited<ReturnType<typeof venue.connect>>, path = '/api/runtime/v1/health') {
  const redeemed = await httpRequest(venue.port, '/api/pairing/redeem', 'POST', venue.origin, { 'Content-Type': 'application/json' }, JSON.stringify({ invitation: connector.hello.invitation }));
  expect(redeemed.status).toBe(200);
  const cookie = String(redeemed.headers['set-cookie']).split(';', 1)[0];
  const frame = new Promise<Record<string, unknown>>((resolve) => {
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'request_start') { connector.socket.off('message', listener); resolve(message); }
    };
    connector.socket.on('message', listener);
  });
  const result = httpRequest(venue.port, path, 'GET', venue.origin, { Cookie: cookie });
  const request = await frame;
  return { id: String(request.id), result };
}

async function sendProcessed(socket: WebSocket, owner: WebSocket, frame: Record<string, unknown>) {
  const processed = new Promise<void>((resolve) => owner.once('message', () => setImmediate(resolve)));
  socket.send(JSON.stringify(frame));
  await processed;
}

function completeResponse(owner: WebSocket, id: string) {
  owner.send(JSON.stringify({ type: 'response_start', id, status: 200, headers: { 'Content-Type': 'text/plain' } }));
  owner.send(JSON.stringify({ type: 'response_chunk', id, data: Buffer.from('owned').toString('base64') }));
  owner.send(JSON.stringify({ type: 'response_end', id }));
}

describe('paired response ownership', () => {
  it.each(['wrong socket', 'captured generation', 'active connector map'] as const)('rejects every response frame with a mismatched %s', async (mode) => {
    await withBoundRelay(async (venue) => {
      const a = await venue.connect('owner-a');
      const b = await venue.connect('owner-b');
      const request = await boundRequest(venue, a);
      const pending = venue.observed.pending.get(request.id)!;
      const generation = a.owner.generation;
      if (mode === 'captured generation') a.owner.generation += 1;
      if (mode === 'active connector map') venue.observed.connectors.set('owner-a', b.owner);
      for (const frame of responseFrames(request.id)) {
        await sendProcessed(mode === 'wrong socket' ? b.socket : a.socket, mode === 'wrong socket' ? b.owner : a.owner, frame);
        expect(venue.observed.pending.get(request.id)).toBe(pending);
        expect(pending.done).toBe(false);
        expect(pending.response.statusCode).toBe(200);
        expect(pending.response.getHeader('X-Fixture')).toBeUndefined();
        expect(pending.response.headersSent).toBe(false);
        expect(pending.response.writableEnded).toBe(false);
      }
      a.owner.generation = generation;
      venue.observed.connectors.set('owner-a', a.owner);
      completeResponse(a.socket, request.id);
      expect(await request.result).toMatchObject({ status: 200, body: 'owned' });
    });
  });

  it('ignores replaced socket frames and permits only the new captured owner', async () => {
    await withBoundRelay(async (venue) => {
      const old = await venue.connect('same-owner');
      const current = await venue.connect('same-owner');
      expect(current.owner.generation).toBeGreaterThan(old.owner.generation);
      const request = await boundRequest(venue, current);
      for (const frame of responseFrames(request.id)) venue.observed.onConnectorMessage(old.owner, frame);
      expect(venue.observed.pending.get(request.id)?.response.headersSent).toBe(false);
      completeResponse(current.socket, request.id);
      expect(await request.result).toMatchObject({ status: 200, body: 'owned' });
    });
  });

  it('ignores unknown, completed, and retained done request IDs for every response type', async () => {
    await withBoundRelay(async (venue) => {
      const a = await venue.connect('owner-a');
      for (const frame of responseFrames('unknown')) await sendProcessed(a.socket, a.owner, frame);
      expect(venue.observed.pending.size).toBe(0);
      const request = await boundRequest(venue, a);
      const pending = venue.observed.pending.get(request.id)!;
      completeResponse(a.socket, request.id);
      expect(await request.result).toMatchObject({ status: 200, body: 'owned' });
      for (const frame of responseFrames(request.id)) await sendProcessed(a.socket, a.owner, frame);
      expect(venue.observed.pending.size).toBe(0);
      venue.observed.pending.set(request.id, pending);
      for (const frame of responseFrames(request.id)) await sendProcessed(a.socket, a.owner, frame);
      expect(pending.response.getHeader('X-Fixture')).toBeUndefined();
      expect(pending.response.statusCode).toBe(200);
      expect(pending.done).toBe(true);
      venue.observed.pending.delete(request.id);
    });
  });
});

// Compile only the script's actual internal pure predicate. Importing its entry
// point would start credential/discovery reads and a Runtime handshake.
const connectorSource = ts.createSourceFile('astrid-local-connector.ts', readFileSync(resolve(process.cwd(), 'scripts/astrid-local-connector.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const urlPredicate = connectorSource.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'connectorWebSocketUrl');
if (!urlPredicate) throw new Error('connector URL predicate is missing');
const connectorWebSocketUrl = new Function(`${ts.transpileModule(urlPredicate.getText(connectorSource), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; return connectorWebSocketUrl;`)() as (origin: string) => URL;

const metadataPathFunction = connectorSource.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'productCredentialMetadataPath');
if (!metadataPathFunction) throw new Error('connector credential metadata path helper is missing');
const productCredentialMetadataPath = new Function('pathApi', `${ts.transpileModule(metadataPathFunction.getText(connectorSource), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; return (credentialPath) => productCredentialMetadataPath(credentialPath, pathApi);`)(win32) as (credentialPath: string) => string;

describe('paired connector credential metadata path', () => {
  it('finds sibling metadata for a Windows credential path', () => {
    expect(productCredentialMetadataPath('C:\\Users\\Astrid\\credentials\\product.token')).toBe('C:\\Users\\Astrid\\credentials\\product.json');
  });
});

describe('paired connector URL policy', () => {
  it.each(['http://127.0.0.1:4444', 'http://localhost:4444', 'http://[::1]:4444'])('allows explicit loopback HTTP %s as WS', (origin) => {
    expect(connectorWebSocketUrl(origin).toString()).toBe(`${origin.replace('http:', 'ws:')}/api/pairing/connector`);
  });
  it.each(['https://remote.example', 'https://localhost:4444'])('maps HTTPS %s to WSS', (origin) => {
    expect(connectorWebSocketUrl(`${origin}/ignored?query=1#fragment`).toString()).toBe(`${origin.replace('https:', 'wss:')}/api/pairing/connector`);
  });
  it.each(['http://remote.example', 'ws://remote.example', 'wss://remote.example', 'ws://127.0.0.1:4444', 'ftp://remote.example', 'not a URL'])('rejects supplied insecure or non-HTTP(S) origin %s', (origin) => {
    expect(() => connectorWebSocketUrl(origin)).toThrow();
  });
});

describe('paired object cache headers', () => {
  const digest = `sha256:${'b'.repeat(64)}`;
  it.each([
    [`/api/runtime/v1/objects/${digest}`, 'private, max-age=31536000, immutable'],
    ['/api/runtime/v1/projects', 'no-store'],
  ])('relays %s with Cache-Control %s', async (path, expected) => {
    await withBoundRelay(async (venue) => {
      const connector = await venue.connect('cache');
      const request = await boundRequest(venue, connector, path);
      connector.socket.send(JSON.stringify({ type: 'response_start', id: request.id, status: 200, headers: { 'Content-Type': 'audio/mpeg', 'cache-control': 'no-store' } }));
      connector.socket.send(JSON.stringify({ type: 'response_end', id: request.id }));
      expect((await request.result).headers['cache-control']).toBe(expected);
    });
  });
});

describe('paired request idle timeout', () => {
  async function startRequest(venue: Parameters<Parameters<typeof withBoundRelay>[0]>[0], connector: Awaited<ReturnType<typeof venue.connect>>) {
    return boundRequest(venue, connector);
  }

  it('keeps a flowing response alive past the idle window, in either direction of progress', async () => {
    await withBoundRelay(async (venue) => {
      const connector = await venue.connect('flow');
      const request = await startRequest(venue, connector);
      connector.socket.send(JSON.stringify({ type: 'response_start', id: request.id, status: 200, headers: { 'Content-Type': 'text/plain' } }));
      for (let index = 0; index < 8; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        connector.socket.send(JSON.stringify({ type: 'response_chunk', id: request.id, data: Buffer.from('x').toString('base64') }));
      }
      connector.socket.send(JSON.stringify({ type: 'response_end', id: request.id }));
      expect(await request.result).toMatchObject({ status: 200, body: 'xxxxxxxx' });
    }, { requestIdleTimeoutMs: 200 });
  });

  it('cancels a silent upstream after the idle window', async () => {
    await withBoundRelay(async (venue) => {
      const connector = await venue.connect('silent');
      const cancelled = new Promise<Record<string, unknown>>((resolve) => connector.socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'request_cancel') resolve(message);
      }));
      const request = await startRequest(venue, connector);
      expect(await request.result).toMatchObject({ status: 504 });
      expect((await cancelled).id).toBe(request.id);
    }, { requestIdleTimeoutMs: 200 });
  });

  it('cancels a stream that stalls after it started', async () => {
    await withBoundRelay(async (venue) => {
      const connector = await venue.connect('stall');
      const cancelled = new Promise<Record<string, unknown>>((resolve) => connector.socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'request_cancel') resolve(message);
      }));
      const request = await startRequest(venue, connector);
      connector.socket.send(JSON.stringify({ type: 'response_start', id: request.id, status: 200, headers: {} }));
      connector.socket.send(JSON.stringify({ type: 'response_chunk', id: request.id, data: Buffer.from('a').toString('base64') }));
      expect((await cancelled).id).toBe(request.id);
      expect(venue.observed.pending.has(request.id)).toBe(false);
    }, { requestIdleTimeoutMs: 200 });
  }, 3000);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  OPERATION_PREFIX as O, createRuntimeOperationRegistry, createRuntimeProxyServer,
  operationRequestAllowed, operationTarget,
} from './runtime-discovery-proxy.mjs';
import {
  createRuntimeOperationAdmissionPlugin, createRuntimeOperationProxyOptions,
  createWorkspaceRuntimeProxyOptions,
} from '../config/vite/runtimeProxy.ts';

const socketTest = (name, run) => test(name, { timeout: 15_000 }, run);
const H = 'X-Astrid-Operation-Handle';
const ORIGIN = 'http://127.0.0.1:17777';
const bytes = Buffer.from(' {"commands":["été 🎬"],"unchanged": true}\n');

function files(t, endpoint = 'http://127.0.0.1:17778') {
  const directory = mkdtempSync(join(tmpdir(), 'operation-proxy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const discoveryPath = join(directory, 'discovery.json');
  const credential = join(directory, 'credential.json');
  const realm = join(directory, 'realm');
  mkdirSync(realm);
  writeFileSync(join(directory, 'catalog.json'), JSON.stringify({ selected_realm_id: 'realm',
    realms: [{ realm_id: 'realm', source_profile: 'astrid', data_root: realm }] }));
  const rotate = (newEndpoint, token = 'first-token') => {
    writeFileSync(credential, JSON.stringify({ version: 1, scope: 'astrid', actor_id: 'app', token }));
    writeFileSync(discoveryPath, JSON.stringify({ endpoint: newEndpoint, credential_file: credential,
      active_realm: 'realm', runtime_instance_id: 'instance', realm_root: realm }));
  };
  rotate(endpoint);
  return { directory, discoveryPath, credential, rotate };
}

function shaped(method, headers = {}) {
  return { method, rawHeaders: Object.entries(headers).flatMap(([key, value]) =>
    (Array.isArray(value) ? value : [value]).flatMap((item) => [key, item])) };
}

test('pure: exact origin/Host and browser safe-read metadata admission', () => {
  assert(operationRequestAllowed(shaped('POST', { Host: 'proxy:17336', Origin: ORIGIN }), ORIGIN, 'proxy:17336'));
  assert(operationRequestAllowed(shaped('GET', { Host: 'proxy:17336', 'Sec-Fetch-Site': 'same-origin' }), ORIGIN, 'proxy:17336'));
  for (const [method, headers] of [
    ['POST', { Host: 'proxy:17336' }], ['GET', { Host: 'proxy:17336' }],
    ['GET', { Host: 'proxy:17336', 'Sec-Fetch-Site': 'cross-site' }],
    ['GET', { Host: 'proxy:17336', Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }],
    ['POST', { Host: 'evil:17336', Origin: ORIGIN }],
    ['POST', { Host: 'proxy:17336', Origin: `${ORIGIN}/path` }],
    ['POST', { Host: 'proxy:17336', Origin: [ORIGIN, ORIGIN] }],
    ['POST', { Host: ['proxy:17336', 'proxy:17336'], Origin: ORIGIN }],
    ['POST', { Host: 'proxy:17336', Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' }],
  ]) assert.equal(operationRequestAllowed(shaped(method, headers), ORIGIN, 'proxy:17336'), false);
  assert.equal(operationRequestAllowed(shaped('POST', { Host: 'proxy:17336', Origin: ORIGIN }), `${ORIGIN}/`, 'proxy:17336'), false);
});

test('pure: only exact controls and origin-form v1 suffixes are routed', () => {
  assert.deepEqual(operationTarget(O), { control: true });
  assert.deepEqual(operationTarget(`${O}/runtime/v1/tasks?cursor=a%2Fb`), { path: '/v1/tasks?cursor=a%2Fb' });
  for (const target of [`${O}?x=1`, `${O}/extra`, `${O}/runtime//evil/v1/tasks`,
    `http://evil${O}/runtime/v1/tasks`, `${O}/runtime/v1/../health`, `${O}/runtime/v1/%2e%2e/health`,
    `${O}/runtime/v1/%252e%252e/health`, `${O}/runtime/v1/a%2fb`, `${O}/runtime/v1/a%5cb`,
    `${O}/runtime/v1/a\\b`, `${O}/runtime/v1/a#secret`, `${O}/runtime/v1/%invalid`]) {
    assert.equal(operationTarget(target), null, target);
  }
});

test('pure: registry pins scalars/dispatch and retires predecessor even when reselection fails', (t) => {
  const fixture = files(t);
  const registry = createRuntimeOperationRegistry(fixture);
  t.after(() => registry.dispose());
  const first = registry.acquire();
  assert.match(first.handle, /^[a-f0-9]{64}$/);
  assert(Object.isFrozen(first.connection));
  fixture.rotate('http://127.0.0.1:18888', 'next-token');
  assert.equal(first.connection.port, 17778);
  assert.equal(first.connection.token, 'first-token');
  let cancelled = 0;
  registry.track(first, () => { cancelled++; assert.equal(registry.isActive(first), false); });
  writeFileSync(fixture.credential, '{}');
  assert.throws(() => registry.acquire(first.handle));
  assert.equal(cancelled, 1);
  assert.equal(registry.track(first, () => assert.fail('retired work')), null);
  assert.equal(registry.get(first.handle), undefined);
  fixture.rotate('http://127.0.0.1:18888', 'next-token');
  const next = registry.acquire();
  assert.notEqual(next.handle, first.handle);
  assert.equal(next.connection.token, 'next-token');
  assert.equal(first.connection.dispatch, next.connection.dispatch);
  registry.dispose();
  assert.equal(registry.isActive(next), false);
  assert.throws(() => registry.acquire());
});

test('pure: invalid snapshots refuse instead of exposing a credential or selecting an arbitrary target', (t) => {
  const fixture = files(t);
  const registry = createRuntimeOperationRegistry(fixture);
  t.after(() => registry.dispose());
  for (const endpoint of ['https://127.0.0.1:1234', 'http://example.com:1234', 'http://127.0.0.1',
    'http://secret@127.0.0.1:1234', 'http://127.0.0.1:1234/path', 'http://127.0.0.1:1234/?token=secret']) {
    fixture.rotate(endpoint);
    assert.throws(() => registry.acquire());
  }
  fixture.rotate('http://127.0.0.1:1234');
  const catalog = join(fixture.directory, 'catalog.json');
  writeFileSync(catalog, JSON.stringify({ selected_realm_id: 'other' }));
  assert.throws(() => registry.acquire());
});

test('pure: 128-entry cap does not evict, active work survives idle deadline, abandoned handles expire', async (t) => {
  const fixture = files(t);
  const registry = createRuntimeOperationRegistry({ ...fixture, idleTimeoutMs: 80 });
  t.after(() => registry.dispose());
  const active = registry.acquire();
  const release = registry.track(active, () => {});
  const abandoned = registry.acquire();
  for (let i = 2; i < 128; i++) registry.acquire();
  assert.throws(() => registry.acquire());
  assert(registry.isActive(active));
  await delay(130);
  assert(registry.isActive(active));
  assert.equal(registry.get(abandoned.handle), undefined);
  assert(registry.acquire());
  release();
  await delay(130);
  assert.equal(registry.get(active.handle), undefined);
});

test('pure: Vite operation options have no rewrite/token/cache override and ordinary routing stays intact', () => {
  const bound = createRuntimeOperationProxyOptions('http://127.0.0.1:17336');
  assert.equal(bound.headers, undefined);
  assert.equal(bound.rewrite, undefined);
  assert.equal(bound.changeOrigin, true);
  const ordinary = createWorkspaceRuntimeProxyOptions('http://127.0.0.1:17336', 'startup-token');
  assert.equal(ordinary.rewrite('/api/runtime/v1/projects'), '/v1/projects');
  assert.equal(ordinary.headers.Authorization, 'Bearer startup-token');
});

test('pure: operation admission strips normalized/raw headers before proxying and leaves ordinary traffic intact', () => {
  let admit;
  createRuntimeOperationAdmissionPlugin(ORIGIN).configureServer({ middlewares: { use: (handler) => { admit = handler; } } });
  const request = { ...shaped('POST', { Host: '127.0.0.1:17777', Origin: ORIGIN, [H]: 'a'.repeat(64),
    Connection: ['X-First, Authorization', 'x-SECOND, Cookie'], 'X-First': 'first-secret', 'X-Second': 'second-secret',
    Authorization: 'Bearer browser-secret', Cookie: 'browser=secret', 'Idempotency-Key': 'exact-key' }),
    url: `${O}/runtime/v1/tasks` };
  request.headers = { connection: 'X-First, Authorization, x-SECOND, Cookie', 'x-first': 'first-secret',
    'x-second': 'second-secret', authorization: 'Bearer browser-secret', cookie: 'browser=secret',
    [H.toLowerCase()]: 'a'.repeat(64), 'idempotency-key': 'exact-key' };
  let forwarded = 0;
  admit(request, { setHeader() {}, writeHead() { assert.fail('valid request refused'); } }, () => forwarded++);
  assert.equal(forwarded, 1);
  assert.deepEqual(request.headers, { [H.toLowerCase()]: 'a'.repeat(64), 'idempotency-key': 'exact-key' });
  assert.deepEqual(request.rawHeaders, ['Host', '127.0.0.1:17777', 'Origin', ORIGIN, H, 'a'.repeat(64), 'Idempotency-Key', 'exact-key']);
  const ordinary = { url: '/api/runtime/v1/tasks', headers: { connection: 'X-First', 'x-first': 'kept' },
    rawHeaders: ['Connection', 'X-First', 'X-First', 'kept'] };
  const before = structuredClone(ordinary);
  admit(ordinary, { setHeader() { assert.fail('ordinary request changed'); } }, () => forwarded++);
  assert.equal(forwarded, 2);
  assert.deepEqual(ordinary, before);
});

const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server.address().port));
});
const close = async (server) => {
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
};
async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function call(port, path, { method = 'GET', headers = {}, body, onData } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), error });
      };
      res.on('data', (chunk) => { chunks.push(chunk); onData?.(chunk); });
      res.once('end', () => finish());
      res.once('error', finish);
      res.once('aborted', () => finish(new Error('response aborted')));
    });
    req.once('error', (error) => resolve({ status: 0, headers: {}, body: Buffer.concat(chunks), error }));
    req.end(body);
  });
}

async function venue(t, handler, { idleTimeoutMs = 2000, connectTimeoutMs = 1000, appOrigin = ORIGIN } = {}) {
  const requests = [];
  const runtime = createServer(async (req, res) => {
    const record = { method: req.method, path: req.url, headers: req.headers, body: Buffer.alloc(0) };
    requests.push(record);
    if (handler) { handler(req, res, record); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    record.body = Buffer.concat(chunks);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'secret=hidden', 'X-Secret': 'hidden' });
    res.end('{"ok":true}');
  });
  const runtimePort = await listen(runtime);
  const fixture = files(t, `http://127.0.0.1:${runtimePort}`);
  const port = await freePort();
  const proxy = createRuntimeProxyServer({ discoveryPath: fixture.discoveryPath, allowedOrigin: appOrigin,
    expectedHost: `127.0.0.1:${port}`, idleTimeoutMs, connectTimeoutMs });
  await listen(proxy, port);
  t.after(async () => { await close(proxy); await close(runtime); });
  const send = (path, options = {}) => call(port, path, { ...options,
    headers: { Origin: appOrigin, ...options.headers } });
  const acquire = async (previous) => {
    const response = await send(O, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(previous ? { [H]: previous } : {}) }, body: '{}' });
    assert.equal(response.status, 201, response.body.toString());
    assert.equal(response.headers['cache-control'], 'no-store');
    const result = JSON.parse(response.body);
    assert.deepEqual(Object.keys(result).sort(), ['handle', 'identity', 'schemaVersion']);
    assert.deepEqual(result.identity, { actorId: 'app', realmId: 'realm', runtimeInstanceId: 'instance' });
    return result.handle;
  };
  return { ...fixture, runtimePort, port, proxy, requests, send, acquire };
}

socketTest('socket: pinned endpoint/bearer, original UTF8 bytes/key/Range, stripped credentials, ordinary rediscovery', async (t) => {
  const fixture = await venue(t);
  const handle = await fixture.acquire();
  const secondRequests = [];
  const second = createServer((req, res) => { secondRequests.push(req.headers); res.end('{}'); });
  const secondPort = await listen(second);
  t.after(() => close(second));
  fixture.rotate(`http://127.0.0.1:${secondPort}`, 'second-token');
  const response = await fixture.send(`${O}/runtime/v1/projects/p/timelines/t/commits?x=a%2Fb`, {
    method: 'POST', headers: { [H]: handle, Authorization: 'Bearer browser-secret', Cookie: 'cookie-secret',
      'Proxy-Authorization': 'proxy-secret', 'Content-Type': 'application/json', 'Idempotency-Key': 'original-key',
      Range: 'bytes=2-4', Connection: 'keep-alive, X-Leak', 'X-Leak': 'hidden' }, body: bytes,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['x-secret'], undefined);
  const received = fixture.requests.at(-1);
  assert.equal(received.path, '/v1/projects/p/timelines/t/commits?x=a%2Fb');
  assert.deepEqual(received.body, bytes);
  assert.equal(received.headers.authorization, 'Bearer first-token');
  assert.equal(received.headers['idempotency-key'], 'original-key');
  assert.equal(received.headers.range, 'bytes=2-4');
  for (const name of [H.toLowerCase(), 'cookie', 'proxy-authorization', 'x-leak']) assert.equal(received.headers[name], undefined);
  assert.equal(secondRequests.length, 0);
  assert.equal((await call(fixture.port, '/v1/projects')).status, 200);
  assert.equal(secondRequests[0].authorization, 'Bearer second-token');
  const next = await fixture.acquire(handle);
  assert.equal((await fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } })).status, 410);
  assert.equal((await fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: next } })).status, 200);
  assert.equal(secondRequests.at(-1).authorization, 'Bearer second-token');
});

socketTest('socket: origin/Host/metadata/header/target refusals never use ordinary fallback', async (t) => {
  const fixture = await venue(t);
  const handle = await fixture.acquire();
  const path = `${O}/runtime/v1/tasks`;
  for (const [options, status] of [
    [{ headers: {} }, 410], [{ headers: { [H]: 'a'.repeat(64) } }, 410],
    [{ headers: { [H]: [handle, handle] } }, 400], [{ headers: { [H]: `${handle},${handle}` } }, 400],
    [{ headers: { [H]: handle, Origin: 'null' } }, 403],
    [{ headers: { [H]: handle, Origin: [ORIGIN, ORIGIN] } }, 403],
    [{ headers: { [H]: handle, Host: 'foreign:1234' } }, 403],
    [{ headers: { [H]: handle, 'Sec-Fetch-Site': 'cross-site' } }, 403],
  ]) assert.equal((await fixture.send(path, options)).status, status);
  for (const target of [`${O}/extra`, `${O}/runtime/v1/../health`, `${O}/runtime/v1/%2e%2e/health`,
    `${O}/runtime/v1/a%2fb`, `http://foreign${path}`, '/v1/tasks']) {
    assert.equal((await fixture.send(target, { headers: { [H]: handle } })).status, 400, target);
  }
  assert.equal((await call(fixture.port, path, { headers: { [H]: handle } })).status, 403);
  assert.equal(fixture.requests.length, 0);
  const safe = await call(fixture.port, path, { headers: { [H]: handle, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(safe.status, 200);
  assert.equal(fixture.requests.length, 1);
});

socketTest('socket: control bounds and failed replacement retire before the body/discovery await', async (t) => {
  const fixture = await venue(t, undefined, { connectTimeoutMs: 150 });
  const handle = await fixture.acquire();
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const replacement = request({ hostname: '127.0.0.1', port: fixture.port, path: O, method: 'POST',
    headers: { Origin: ORIGIN, [H]: handle, 'Content-Type': 'application/json', 'Content-Length': 2 } }, (res) => {
    res.resume(); res.once('end', () => finish(res.statusCode));
  });
  replacement.flushHeaders();
  replacement.write('{');
  // Request ordering is confirmed by waiting for the old handle to become retired.
  let retired;
  for (let i = 0; i < 30; i++) {
    retired = await fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } });
    if (retired.status === 410) break;
    await delay(5);
  }
  assert.equal(retired.status, 410);
  writeFileSync(fixture.credential, '{}');
  replacement.end('}');
  assert.equal(await pending, 503);
  assert.equal((await fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } })).status, 410);
  for (const body of ['[]', '{"extra":1}', 'x'.repeat(1025)]) {
    assert.equal((await fixture.send(O, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 400);
  }
  const failed = await fixture.send(O, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(failed.status, 503);
  assert(!failed.body.includes(Buffer.from(fixture.directory)));
  assert(!failed.body.includes(Buffer.from('token')));
});

socketTest('socket: 409/422 retain a handle, auth/5xx/transport failures retire it, redirects are never followed', async (t) => {
  let status = 409;
  const fixture = await venue(t, (_req, res) => {
    res.writeHead(status, { Location: `http://127.0.0.1:1/secret`, 'Set-Cookie': 'secret=1' });
    res.end('semantic response');
  });
  let handle = await fixture.acquire();
  for (status of [409, 422, 302, 200]) {
    const result = await fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } });
    assert.equal(result.status, status);
    assert.equal(result.headers.location, undefined);
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  for (status of [401, 403, 500]) {
    const result = await fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } });
    assert.equal(result.status, 503);
    assert.equal(JSON.parse(result.body).code, 'operation_unavailable');
    assert.equal((await fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } })).status, 410);
    handle = await fixture.acquire();
  }
  const dead = await freePort();
  fixture.rotate(`http://127.0.0.1:${dead}`, 'new-token');
  handle = await fixture.acquire(handle);
  assert.equal((await fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } })).status, 503);
  assert.equal((await fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } })).status, 410);
});

socketTest('socket: retirement aborts all requests, streaming bodies and late ACKs; DELETE is idempotent', async (t) => {
  let observed;
  const reached = new Promise((resolve) => { observed = resolve; });
  const replies = [];
  const fixture = await venue(t, (_req, res) => { replies.push(res); if (replies.length === 2) observed(); });
  const handle = await fixture.acquire();
  const calls = [1, 2].map(() => fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } }));
  await reached;
  const deleted = await fixture.send(O, { method: 'DELETE', headers: { [H]: handle } });
  assert.equal(deleted.status, 204);
  for (const reply of replies) reply.end('late accepted ACK');
  for (const reply of await Promise.all(calls)) { assert.equal(reply.status, 503); assert(!reply.body.includes(Buffer.from('ACK'))); }
  assert.equal((await fixture.send(O, { method: 'DELETE', headers: { [H]: handle } })).status, 204);
  const next = await fixture.acquire();
  let firstChunk;
  const flowing = new Promise((resolve) => { firstChunk = resolve; });
  const stream = fixture.send(`${O}/runtime/v1/objects/o`, { headers: { [H]: next }, onData: firstChunk });
  while (replies.length < 3) await delay(5);
  replies[2].write('first');
  await flowing;
  await fixture.send(O, { method: 'DELETE', headers: { [H]: next } });
  replies[2].end('late');
  const result = await stream;
  assert.equal(result.body.toString(), 'first');
  assert(result.error);
});

socketTest('socket: retirement during upload aborts body ownership without replacing uncertain bytes', async (t) => {
  let receivedChunk;
  const gotChunk = new Promise((resolve) => { receivedChunk = resolve; });
  let uploaded = Buffer.alloc(0);
  const fixture = await venue(t, (req, res) => {
    req.on('data', (chunk) => { uploaded = Buffer.concat([uploaded, chunk]); receivedChunk(); });
    req.on('error', () => {});
    req.once('end', () => res.end('late ACK'));
  });
  const handle = await fixture.acquire();
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const upload = request({ hostname: '127.0.0.1', port: fixture.port, path: `${O}/runtime/v1/tasks`, method: 'POST',
    headers: { Origin: ORIGIN, [H]: handle, 'Content-Type': 'application/json',
      'Idempotency-Key': 'uncertain-key', 'Content-Length': bytes.length } }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.once('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks) }));
  });
  upload.on('error', () => finish({ status: 0, body: Buffer.alloc(0) }));
  const first = bytes.subarray(0, 20);
  upload.write(first);
  await gotChunk;
  assert.equal((await fixture.send(O, { method: 'DELETE', headers: { [H]: handle } })).status, 204);
  upload.end(bytes.subarray(20));
  const result = await completed;
  assert.equal(result.status, 503);
  assert(!result.body.includes(Buffer.from('ACK')));
  assert.deepEqual(uploaded, first);
  assert.equal(fixture.requests[0].headers['idempotency-key'], 'uncertain-key');
  assert.equal((await fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } })).status, 410);
});

socketTest('socket: idle timeout bounds silent and stalled streams; flowing streams outlive the window', async (t) => {
  let mode = 'silent';
  const fixture = await venue(t, (_req, res) => {
    if (mode === 'silent') return;
    res.write('x');
    if (mode === 'stalled') return;
    let count = 0;
    const timer = setInterval(() => { res.write('x'); if (++count === 8) { clearInterval(timer); res.end(); } }, 30);
    res.once('close', () => clearInterval(timer));
  }, { idleTimeoutMs: 120 });
  let handle = await fixture.acquire();
  assert.equal((await fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } })).status, 503);
  assert.equal((await fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } })).status, 410);
  mode = 'stalled'; handle = await fixture.acquire();
  const stalled = await fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } });
  assert.equal(stalled.body.toString(), 'x'); assert(stalled.error);
  mode = 'flowing'; handle = await fixture.acquire();
  const flowing = await fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } });
  assert.equal(flowing.body.toString(), 'xxxxxxxxx'); assert.equal(flowing.error, undefined);
});

socketTest('socket: dispose during control body and pending upstream; restart cannot revive old handles', async (t) => {
  let observed;
  const reached = new Promise((resolve) => { observed = resolve; });
  const fixture = await venue(t, () => observed());
  const handle = await fixture.acquire();
  const pending = fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } });
  await reached;
  let controlDone;
  const control = new Promise((resolve) => { controlDone = resolve; });
  const req = request({ hostname: '127.0.0.1', port: fixture.port, path: O, method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Content-Length': 2 } }, (res) => {
    res.resume(); res.once('end', () => controlDone(res.statusCode));
  });
  req.once('error', () => controlDone(0)); req.write('{');
  await delay(20);
  await new Promise((resolve) => fixture.proxy.close(resolve));
  req.end('}');
  assert.equal((await pending).status, 503);
  assert.equal(await control, 0);
  const restarted = createRuntimeProxyServer({ discoveryPath: fixture.discoveryPath, allowedOrigin: ORIGIN,
    expectedHost: `127.0.0.1:${fixture.port}` });
  await listen(restarted, fixture.port);
  t.after(() => close(restarted));
  assert.equal((await fixture.send(`${O}/runtime/v1/tasks`, { headers: { [H]: handle } })).status, 410);
});

socketTest('socket: lost acquire response expires without eviction or a second journal', async (t) => {
  const fixture = await venue(t, undefined, { idleTimeoutMs: 1000 });
  // Discard the acknowledgements as a disconnected browser would. No bound work keeps them alive.
  await Promise.all(Array.from({ length: 128 }, () => fixture.acquire()));
  const full = await fixture.send(O, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(full.status, 503);
  await delay(1200);
  assert(await fixture.acquire());
  assert.equal(fixture.requests.length, 0);
});

socketTest('socket: real Vite prefix uses production options/admission, preserves Origin and never injects startup auth', async (t) => {
  const { createServer: createViteServer } = await import('vite');
  const appPort = await freePort();
  const appOrigin = `http://127.0.0.1:${appPort}`;
  const fixture = await venue(t, undefined, { appOrigin });
  const target = `http://127.0.0.1:${fixture.port}`;
  const vite = await createViteServer({ configFile: false, root: fixture.directory,
    cacheDir: join(fixture.directory, '.vite'), logLevel: 'silent', appType: 'custom',
    plugins: [createRuntimeOperationAdmissionPlugin(appOrigin)],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: appPort, strictPort: true, watch: null, hmr: false, proxy: {
      [O]: createRuntimeOperationProxyOptions(target),
      '/api/runtime': createWorkspaceRuntimeProxyOptions(target, 'wrong-startup-token'),
    } },
  });
  await vite.listen(); t.after(() => vite.close());
  const acquire = await call(appPort, O, { method: 'POST', headers: { Origin: appOrigin,
    'Content-Type': 'application/json', Authorization: 'Bearer browser-secret', Cookie: 'secret=1' }, body: '{}' });
  assert.equal(acquire.status, 201, acquire.body.toString());
  const handle = JSON.parse(acquire.body).handle;
  const result = await call(appPort, `${O}/runtime/v1/tasks`, { method: 'POST',
    headers: { Origin: appOrigin, [H]: handle, 'Content-Type': 'application/json', 'Idempotency-Key': 'exact-key' }, body: bytes });
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(fixture.requests.at(-1).body, bytes);
  assert.equal(fixture.requests.at(-1).headers.authorization, 'Bearer first-token');
  assert.equal(fixture.requests.at(-1).headers[H.toLowerCase()], undefined);
  assert.equal((await call(appPort, `${O}/runtime/v1/tasks`, { headers: { [H]: handle, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await call(appPort, `${O}/extra`, { headers: { Origin: appOrigin, [H]: handle } })).status, 400);
  assert.equal((await call(appPort, `${O}/runtime/v1/tasks`, { headers: { Origin: appOrigin, Host: 'foreign', [H]: handle } })).status, 403);
  assert.equal((await call(appPort, `${O}/runtime/v1/tasks`, { headers: { Origin: 'http://evil', [H]: handle } })).status, 403);
  assert.equal((await call(appPort, '/api/runtime/v1/projects')).status, 200);
  assert.equal(fixture.requests.at(-1).path, '/v1/projects');
  await close(fixture.proxy);
  const unavailable = await call(appPort, `${O}/runtime/v1/tasks`, { headers: { Origin: appOrigin, [H]: handle } });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(unavailable.body).code, 'operation_unavailable');
});

socketTest('socket: duplicate Connection nominations are stripped in both directions through actual Vite', async (t) => {
  const { createServer: createViteServer } = await import('vite');
  const appPort = await freePort();
  const appOrigin = `http://127.0.0.1:${appPort}`;
  let received;
  const f = await venue(t, (req, res) => {
    received = req.headers;
    res.writeHead(200, { Connection: ['X-Reply-Leak', 'ETag'], 'X-Reply-Leak': 'private', ETag: 'private-tag',
      Authorization: 'Bearer upstream-secret', 'Proxy-Authorization': 'Basic upstream-secret', Cookie: 'upstream=secret',
      [H]: 'upstream-operation-secret', 'Set-Cookie': 'private-cookie=1', 'Content-Type': 'text/plain' });
    res.end('kept');
  }, { appOrigin });
  f.rotate(`http://127.0.0.1:${f.runtimePort}`, 'pinned-token');
  const vite = await createViteServer({ configFile: false, root: f.directory, cacheDir: join(f.directory, '.vite'),
    logLevel: 'silent', appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [createRuntimeOperationAdmissionPlugin(appOrigin)],
    server: { host: '127.0.0.1', port: appPort, strictPort: true, watch: null, hmr: false,
      proxy: { [O]: createRuntimeOperationProxyOptions(`http://127.0.0.1:${f.port}`) } } });
  await vite.listen();
  t.after(() => vite.close());
  const acquired = await call(appPort, O, { method: 'POST', headers: { Origin: appOrigin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(acquired.status, 201);
  const handle = JSON.parse(acquired.body).handle;
  const result = await call(appPort, `${O}/runtime/v1/tasks`, { headers: { Origin: appOrigin, [H]: handle,
    Connection: ['X-First, Authorization', 'X-Second, Cookie'], 'X-First': 'first-secret', 'X-Second': 'second-secret',
    Authorization: 'Bearer browser-secret', Cookie: 'browser=secret' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), 'kept');
  assert.equal(result.headers['content-type'], 'text/plain');
  assert.equal(received.authorization, 'Bearer pinned-token');
  for (const name of ['x-first', 'x-second', 'cookie', 'proxy-authorization', H.toLowerCase()]) assert.equal(received[name], undefined, name);
  for (const name of ['authorization', 'proxy-authorization', 'cookie', H.toLowerCase(), 'etag', 'x-reply-leak', 'set-cookie',
    'access-control-allow-origin']) assert.equal(result.headers[name], undefined, name);
  assert.equal(result.headers['cache-control'], 'no-store');
});

socketTest('socket: Vite strips raw mixed-case nominations before each hop, including Expect requests', async (t) => {
  const { createServer: createViteServer } = await import('vite');
  const appPort = await freePort();
  const appOrigin = `http://127.0.0.1:${appPort}`;
  const f = await venue(t, undefined, { appOrigin });
  const incoming = [];
  f.proxy.prependListener('request', (req) => incoming.push({ headers: { ...req.headers }, rawHeaders: [...req.rawHeaders] }));
  const target = `http://127.0.0.1:${f.port}`;
  const vite = await createViteServer({ configFile: false, root: f.directory, cacheDir: join(f.directory, '.vite'),
    logLevel: 'silent', appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [createRuntimeOperationAdmissionPlugin(appOrigin)],
    server: { host: '127.0.0.1', port: appPort, strictPort: true, watch: null, hmr: false,
      proxy: { [O]: createRuntimeOperationProxyOptions(target), '/api/runtime': createWorkspaceRuntimeProxyOptions(target, 'startup-token') } } });
  await vite.listen(); t.after(() => vite.close());
  const acquired = await call(appPort, O, { method: 'POST', headers: { Origin: appOrigin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(acquired.status, 201);
  const handle = JSON.parse(acquired.body).handle;
  const hopHeaders = { 'Keep-Alive': 'timeout=10', 'Proxy-Connection': 'keep-alive',
    'Proxy-Authenticate': 'Basic private', 'Proxy-Authorization': 'Basic private', TE: 'trailers',
    Trailer: 'X-Trailer', Upgrade: 'private-protocol' };
  for (const expect of [false, true]) {
    for (const nominateKey of [false, true]) {
      const headers = ['Host', `127.0.0.1:${appPort}`, 'Origin', appOrigin, H, handle,
        'cOnNeCtIoN', '  x-FiRsT, AuThOrIzAtIoN  ', 'CONNECTION', `x-SeCoNd, cOoKiE${nominateKey ? ', IdEmPoTeNcY-KeY' : ''}`,
        'X-First', 'first-secret', 'x-SECOND', 'second-secret', 'Authorization', 'Bearer browser-secret',
        'Cookie', 'browser=secret', 'Idempotency-Key', 'exact-key', 'Content-Type', 'application/json',
        'Range', 'bytes=2-4', ...Object.entries(hopHeaders).flat(), ...(expect ? ['Expect', '100-continue'] : [])];
      const result = await call(appPort, `${O}/runtime/v1/tasks?cursor=a%2Fb`, { method: 'POST', headers, body: bytes });
      assert.equal(result.status, 200, result.body.toString());
      const firstHop = incoming.at(-1);
      const received = f.requests.at(-1);
      for (const name of ['x-first', 'x-second', 'cookie', 'authorization', ...Object.keys(hopHeaders).map((name) => name.toLowerCase())]) {
        assert.equal(firstHop.headers[name], undefined, `first hop: ${name}`);
        assert(!firstHop.rawHeaders.some((value, index) => index % 2 === 0 && value.toLowerCase() === name), `raw first hop: ${name}`);
        if (name !== 'authorization') assert.equal(received.headers[name], undefined, `Runtime hop: ${name}`);
      }
      assert.equal(firstHop.headers[H.toLowerCase()], handle);
      assert.equal(received.headers[H.toLowerCase()], undefined);
      assert.equal(received.headers.authorization, 'Bearer first-token');
      for (const record of [firstHop, received]) {
        assert.equal(record.headers['idempotency-key'], nominateKey ? undefined : 'exact-key');
        assert.equal(record.headers.range, 'bytes=2-4');
      }
      assert.equal(received.method, 'POST');
      assert.equal(received.path, '/v1/tasks?cursor=a%2Fb');
      assert.deepEqual(received.body, bytes);
    }
  }
  const sent = incoming.length;
  const accepted = f.requests.length;
  for (const nomination of [H, `X-First, ${H.toUpperCase()}`]) {
    for (const path of [O, `${O}/runtime/v1/tasks`, '/api/runtime/v1/tasks']) {
      const result = await call(appPort, path, { method: 'POST', headers: { Origin: appOrigin, [H]: handle,
        Connection: ['X-Second', nomination], 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(result.status, 400);
      assert.equal(JSON.parse(result.body).code, 'operation_invalid');
      assert.equal(result.headers['cache-control'], 'no-store');
    }
  }
  for (const headers of [
    { Origin: 'http://foreign', Connection: 'Origin' }, { Origin: 'null', Connection: 'Origin' },
    { Origin: [appOrigin, appOrigin], Connection: 'Origin' },
    { Origin: appOrigin, 'Sec-Fetch-Site': 'cross-site', Connection: 'Sec-Fetch-Site' },
  ]) {
    const result = await call(appPort, `${O}/runtime/v1/tasks`, { headers: {
      [H]: handle, 'Sec-Fetch-Site': 'same-origin', ...headers } });
    assert.equal(result.status, 403);
    assert.equal(JSON.parse(result.body).code, 'operation_origin_forbidden');
  }
  for (const nomination of ['Origin', 'Host', 'Origin, Sec-Fetch-Site']) {
    const result = await call(appPort, `${O}/runtime/v1/tasks`, { headers: { Origin: appOrigin, [H]: handle,
      'Sec-Fetch-Site': 'same-origin', Connection: nomination } });
    // Origin-less safe reads remain allowed only when their Fetch Metadata survives stripping.
    assert.equal(result.status, nomination === 'Origin' ? 200 : 403);
  }
  assert.equal(incoming.length, sent + 1);
  assert.equal(f.requests.length, accepted + 1);
  assert.equal((await call(appPort, `${O}/runtime/v1/tasks`, { headers: { Origin: appOrigin, [H]: handle } })).status, 200);
});

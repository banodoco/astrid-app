import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer, request as requestHttp } from 'node:http';
import { URL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { objectCacheControl } from '../config/vite/objectCachePolicy.mjs';

const discoveryPath = process.env.ASTRID_WORKSPACE_DISCOVERY?.trim();
const port = Number(process.env.ASTRID_RUNTIME_PROXY_PORT ?? '17336');
// Connecting to the loopback Runtime is near-instant, so a long wait is a real failure.
// Once connected, only silence is an error: media streams may take as long as they keep
// producing bytes (same idea as the paired relay's idle timeout).
export const CONNECT_TIMEOUT_MS = 10_000;
export const IDLE_TIMEOUT_MS = 60_000;
const ACP_IDLE_TIMEOUT_MS = 5 * 60_000;
// Upstream requests currently open across the proxy, for the upstream error log line.
let upstreamInFlight = 0;

function fail(message, status = 503) {
  return { status, body: JSON.stringify({
    code: 'runtime_unavailable',
    message,
  }) };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readToken(path) {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) throw new Error('runtime credential is empty');
  if (!raw.startsWith('{')) return raw;
  const parsed = JSON.parse(raw);
  if (typeof parsed?.token !== 'string' || !parsed.token.trim()) {
    throw new Error('runtime credential has no token');
  }
  return parsed.token.trim();
}

/**
 * The Runtime to forward to right now: its loopback endpoint from the discovery file and its bearer token, read afresh on every
 * call so a restart on a new port or a rotated token is followed. Throws on a missing, malformed or non-loopback file.
 * `credentialFile` names a different token file than the discovery's own (the loopback gateway holds a product-scoped one).
 */
export function currentRuntime(discoveryPath, { credentialFile: credentialFileOverride } = {}) {
  if (!discoveryPath) throw new Error('ASTRID_WORKSPACE_DISCOVERY is not configured');
  const discovery = readJson(discoveryPath, 'runtime discovery');
  const endpoint = new URL(String(discovery.endpoint ?? ''));
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname) || !endpoint.port) {
    throw new Error('runtime discovery endpoint must be an explicit HTTP loopback URL');
  }
  const credentialFile = String(credentialFileOverride ?? discovery.credential_file ?? '').trim();
  if (!credentialFile) throw new Error('runtime discovery has no credential file');
  return { endpoint, token: readToken(credentialFile) };
}

/** The agent owns this registration and can rotate it independently of Vite. */
export function currentChat(discoveryPath) {
  if (!discoveryPath) throw new Error('ASTRID_WORKSPACE_DISCOVERY is not configured');
  const path = resolve(dirname(discoveryPath), 'chat.json');
  const metadata = lstatSync(path);
  if (!metadata.isFile() || (process.platform !== 'win32'
    && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid()))) {
    throw new Error('chat registration must be an owner-only regular file');
  }
  const registration = readJson(path, 'chat registration');
  const endpoint = new URL(String(registration.endpoint ?? ''));
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || Number(endpoint.port) < 1
    || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
    || typeof registration.token !== 'string' || !registration.token.trim()) {
    throw new Error('chat registration must name an authenticated loopback service');
  }
  return { endpoint, token: registration.token };
}

export function readWorkspaceRuntimeConfig(discoveryPath) {
  if (!discoveryPath) throw new Error('ASTRID_WORKSPACE_DISCOVERY is not configured');
  const discovery = readJson(discoveryPath, 'runtime discovery');
  const endpoint = new URL(String(discovery.endpoint ?? ''));
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || !endpoint.port) {
    throw new Error('runtime discovery endpoint must be an explicit HTTP loopback URL');
  }
  const credential = readJson(String(discovery.credential_file ?? ''), 'runtime product credential');
  const actorId = typeof credential.actor_id === 'string' ? credential.actor_id.trim() : '';
  const realmId = typeof discovery.active_realm === 'string' ? discovery.active_realm.trim() : '';
  const runtimeInstanceId = typeof discovery.runtime_instance_id === 'string' ? discovery.runtime_instance_id.trim() : '';
  if (credential.version !== 1 || credential.scope !== 'astrid' || !actorId
    || ['owner', 'astrid-pack-host', 'admin', 'worker'].includes(actorId)
    || typeof credential.token !== 'string' || !credential.token.trim()
    || !realmId || !runtimeInstanceId) {
    throw new Error('runtime discovery has no valid Astrid product identity');
  }
  const catalog = readJson(resolve(dirname(discoveryPath), 'catalog.json'), 'runtime profile catalog');
  const matches = Array.isArray(catalog.realms)
    ? catalog.realms.filter((row) => row?.realm_id === realmId) : [];
  if (catalog.selected_realm_id !== realmId || matches.length !== 1
    || matches[0].source_profile !== 'astrid'
    || realpathSync(discovery.realm_root) !== realpathSync(matches[0].data_root)) {
    throw new Error('runtime discovery does not match the selected Astrid realm');
  }
  return { schemaVersion: 1, endpoint: endpoint.origin, actorId, realmId, runtimeInstanceId };
}

// The operation relay is also consumed by Vite's same-origin admission plugin. Keep its
// bounded handle registry here so the discovery proxy and the dev server share one contract.
export const OPERATION_PREFIX = '/runtime-config/v1/operation';
const HANDLE_HEADER = 'x-astrid-operation-handle';
const HANDLE_PATTERN = /^[a-f0-9]{64}$/;
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'];

function readRuntimeSnapshot(discoveryPath) {
  const runtime = currentRuntime(discoveryPath);
  const config = readWorkspaceRuntimeConfig(discoveryPath);
  return { endpoint: runtime.endpoint, token: runtime.token,
    identity: { actorId: config.actorId, realmId: config.realmId, runtimeInstanceId: config.runtimeInstanceId } };
}

function headerValues(incoming, name) {
  const values = [];
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
    if (incoming.rawHeaders[i].toLowerCase() === name) values.push(incoming.rawHeaders[i + 1]);
  }
  return values;
}

export function operationRequestAllowed(incoming, allowedOrigin, expectedHost) {
  let origin;
  try { origin = new URL(allowedOrigin); } catch { return false; }
  if (origin.origin !== allowedOrigin || origin.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) return false;
  const hosts = headerValues(incoming, 'host');
  const origins = headerValues(incoming, 'origin');
  const sites = headerValues(incoming, 'sec-fetch-site');
  if (!expectedHost || hosts.length !== 1 || hosts[0] !== expectedHost
    || sites.length > 1 || (sites.length === 1 && sites[0] !== 'same-origin')) return false;
  if (origins.length) return origins.length === 1 && origins[0] === allowedOrigin;
  return ['GET', 'HEAD'].includes(incoming.method) && sites[0] === 'same-origin';
}

export function operationTarget(url) {
  if (url === OPERATION_PREFIX) return { control: true };
  const prefix = `${OPERATION_PREFIX}/runtime`;
  if (!url?.startsWith(`${prefix}/v1/`)) return null;
  const suffix = url.slice(prefix.length);
  const path = suffix.split('?')[0];
  if (path.length <= 4) return null;
  if (/[\\#\s\x00-\x1f\x7f]/.test(suffix) || /%(?:25|2f|5c)/i.test(path)) return null;
  try {
    if (decodeURIComponent(path).split('/').some((part) => part === '.' || part === '..')) return null;
  } catch { return null; }
  return { path: suffix };
}

export function operationFailure(status, code) {
  const messages = {
    operation_invalid: 'Invalid operation request.',
    operation_origin_forbidden: 'Operation origin forbidden.',
    operation_method_not_allowed: 'Operation method not allowed.',
    operation_retired: 'Operation is retired.',
    operation_unavailable: 'Operation is unavailable.',
  };
  return { status, body: JSON.stringify({ code, message: messages[code] }) };
}

export function createRuntimeOperationRegistry({ discoveryPath, idleTimeoutMs = IDLE_TIMEOUT_MS } = {}) {
  const entries = new Map();
  let disposed = false;
  const isActive = (entry) => !disposed && !entry.retired && entries.get(entry.handle) === entry;
  const retire = (handle) => {
    const entry = entries.get(handle);
    if (!entry) return;
    entry.retired = true;
    entries.delete(handle);
    clearTimeout(entry.timer);
    for (const cancel of entry.resources) cancel();
    entry.resources.clear();
  };
  const arm = (entry) => {
    clearTimeout(entry.timer);
    if (isActive(entry) && !entry.resources.size) {
      entry.timer = setTimeout(() => retire(entry.handle), idleTimeoutMs);
      entry.timer.unref();
    }
  };
  return {
    isActive,
    retire,
    get: (handle) => entries.get(handle),
    acquire(predecessor) {
      retire(predecessor);
      if (disposed || entries.size >= 128) throw new Error('operation unavailable');
      const { endpoint, token, identity } = readRuntimeSnapshot(discoveryPath);
      if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
        || /[\r\n]/.test(token)) throw new Error('invalid operation endpoint or credential');
      const connection = Object.freeze({ hostname: endpoint.hostname.replace(/^\[|\]$/g, ''),
        port: Number(endpoint.port), token, dispatch: requestHttp });
      const entry = { handle: randomBytes(32).toString('hex'), connection,
        identity: Object.freeze(identity), retired: false, resources: new Set(), timer: undefined };
      entries.set(entry.handle, entry);
      arm(entry);
      return entry;
    },
    track(entry, cancel) {
      if (!isActive(entry)) return null;
      clearTimeout(entry.timer);
      entry.resources.add(cancel);
      return () => { entry.resources.delete(cancel); arm(entry); };
    },
    dispose() {
      disposed = true;
      for (const handle of entries.keys()) retire(handle);
    },
  };
}

function strippedHeaders(headers) {
  const result = { ...headers };
  const nominated = String(headers.connection ?? '').toLowerCase().split(',').map((name) => name.trim());
  for (const name of [...HOP_HEADERS, ...nominated, 'host', 'authorization', 'cookie', HANDLE_HEADER]) delete result[name];
  return result;
}

function boundResponseHeaders(headers) {
  const permitted = ['content-type', 'content-length', 'content-range', 'accept-ranges',
    'etag', 'last-modified', 'content-encoding', 'retry-after'];
  const clean = strippedHeaders(headers);
  return { ...Object.fromEntries(permitted.filter((name) => clean[name] !== undefined)
    .map((name) => [name, clean[name]])), 'cache-control': 'no-store' };
}

async function readControlBody(incoming, response, timeoutMs) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    const finish = (error) => {
      clearTimeout(timer);
      incoming.off('data', data);
      incoming.off('end', end);
      incoming.off('aborted', aborted);
      incoming.off('error', aborted);
      response.off('close', aborted);
      if (error) response.shouldKeepAlive = false;
      if (error) reject(error); else resolveBody(Buffer.concat(chunks).toString('utf8'));
    };
    const aborted = () => finish(new Error('control aborted'));
    const data = (chunk) => {
      size += chunk.length;
      if (size > 1024) { incoming.resume(); finish(new Error('control too large')); }
      else chunks.push(chunk);
    };
    const end = () => finish();
    const timer = setTimeout(() => finish(new Error('control timeout')), timeoutMs);
    incoming.on('data', data);
    incoming.once('end', end);
    incoming.once('aborted', aborted);
    incoming.once('error', aborted);
    response.once('close', aborted);
  });
}

function forwardOperation(incoming, response, entry, registry, path, connectTimeoutMs, idleTimeoutMs) {
  let upstream, upstreamResponse, connectTimer;
  const unavailable = () => writeFailure(response, operationFailure(503, 'operation_unavailable'));
  const cancel = () => {
    clearTimeout(connectTimer);
    incoming.unpipe(upstream);
    upstreamResponse?.destroy();
    upstream?.destroy();
    incoming.resume();
    response.shouldKeepAlive = false;
    unavailable();
  };
  const release = registry.track(entry, cancel);
  if (!release) { writeFailure(response, operationFailure(410, 'operation_retired')); return; }
  const failOwned = () => registry.retire(entry.handle);
  let released = false;
  const finished = () => {
    if (released) return;
    released = true;
    clearTimeout(connectTimer);
    incoming.unpipe(upstream);
    upstream?.destroy();
    release();
    incoming.off('aborted', failOwned);
    incoming.off('error', failOwned);
  };
  response.once('finish', finished);
  response.once('close', () => { if (!response.writableFinished) failOwned(); finished(); });
  incoming.once('aborted', failOwned);
  incoming.once('error', failOwned);
  response.setTimeout(idleTimeoutMs, failOwned);
  const headers = strippedHeaders(incoming.headers);
  headers.authorization = `Bearer ${entry.connection.token}`;
  if (!registry.isActive(entry) || incoming.aborted || response.destroyed) { failOwned(); return; }
  try {
    upstream = entry.connection.dispatch({ hostname: entry.connection.hostname, port: entry.connection.port,
      method: incoming.method, path, headers }, (reply) => {
      upstreamResponse = reply;
      clearTimeout(connectTimer);
      if (!registry.isActive(entry)) { reply.destroy(); unavailable(); return; }
      const status = reply.statusCode ?? 502;
      if (status === 401 || status === 403 || status >= 500) { failOwned(); return; }
      response.writeHead(status, boundResponseHeaders(reply.headers));
      reply.on('data', (chunk) => {
        if (!registry.isActive(entry)) { reply.destroy(); unavailable(); return; }
        if (!response.write(chunk)) reply.pause();
      });
      response.on('drain', () => { if (registry.isActive(entry)) reply.resume(); });
      reply.once('end', () => { if (registry.isActive(entry)) response.end(); else unavailable(); });
      reply.once('error', failOwned);
      reply.once('aborted', failOwned);
    });
    connectTimer = setTimeout(failOwned, connectTimeoutMs);
    upstream.on('socket', (socket) => {
      const connected = () => { clearTimeout(connectTimer); upstream.setTimeout(idleTimeoutMs, failOwned); };
      if (socket.connecting) socket.once('connect', connected); else connected();
    });
    upstream.once('close', () => clearTimeout(connectTimer));
    upstream.once('error', failOwned);
    incoming.pipe(upstream);
  } catch { failOwned(); }
}

function writeFailure(response, failure) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(failure.status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  });
  response.end(failure.body);
}

export function createRuntimeProxyServer({
  discoveryPath,
  allowedOrigin,
  expectedHost,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  request = requestHttp,
} = {}) {
  const operations = createRuntimeOperationRegistry({ discoveryPath, idleTimeoutMs });
  const pendingControls = new Set();
  const server = createServer((incoming, response) => {
  if (incoming.url?.includes(OPERATION_PREFIX) || incoming.headers[HANDLE_HEADER] !== undefined) {
    void (async () => {
      if (!operationRequestAllowed(incoming, allowedOrigin, expectedHost)) {
        writeFailure(response, operationFailure(403, 'operation_origin_forbidden')); return;
      }
      const target = operationTarget(incoming.url);
      const handles = headerValues(incoming, HANDLE_HEADER);
      if (!target || handles.length > 1 || (handles.length && !HANDLE_PATTERN.test(handles[0]))) {
        writeFailure(response, operationFailure(400, 'operation_invalid')); return;
      }
      const handle = handles[0];
      if (!target.control) {
        const entry = operations.get(handle);
        if (!entry) { writeFailure(response, operationFailure(410, 'operation_retired')); return; }
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(incoming.method)) {
          writeFailure(response, operationFailure(405, 'operation_method_not_allowed')); return;
        }
        forwardOperation(incoming, response, entry, operations, target.path, connectTimeoutMs, idleTimeoutMs);
        return;
      }
      if (incoming.method === 'DELETE') {
        if (!handle || incoming.headers['transfer-encoding'] || Number(incoming.headers['content-length'] ?? 0) !== 0) {
          writeFailure(response, operationFailure(400, 'operation_invalid')); return;
        }
        operations.retire(handle);
        response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end(); return;
      }
      if (incoming.method !== 'POST') {
        writeFailure(response, operationFailure(405, 'operation_method_not_allowed')); return;
      }
      operations.retire(handle);
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(incoming.headers['content-type'] ?? '')) {
        writeFailure(response, operationFailure(400, 'operation_invalid')); return;
      }
      pendingControls.add(response);
      let body;
      try { body = JSON.parse(await readControlBody(incoming, response, connectTimeoutMs)); }
      catch { writeFailure(response, operationFailure(400, 'operation_invalid')); return; }
      finally { pendingControls.delete(response); }
      if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) {
        writeFailure(response, operationFailure(400, 'operation_invalid')); return;
      }
      if (incoming.aborted || response.destroyed) return;
      let entry;
      try { entry = operations.acquire(); }
      catch { writeFailure(response, operationFailure(503, 'operation_unavailable')); return; }
      response.once('close', () => { if (!response.writableFinished) operations.retire(entry.handle); });
      if (!operations.isActive(entry) || response.destroyed) { operations.retire(entry.handle); return; }
      response.writeHead(201, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ schemaVersion: 1, handle: entry.handle, identity: entry.identity }));
    })().catch(() => writeFailure(response, operationFailure(503, 'operation_unavailable')));
    return;
  }
  if (incoming.url?.split('?')[0] === '/runtime-config/v1/workspace.json') {
    if (incoming.method !== 'GET') {
      writeFailure(response, fail('method not allowed', 405));
      return;
    }
    try {
      const config = readWorkspaceRuntimeConfig(discoveryPath);
      response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(config));
    } catch (error) {
      writeFailure(response, fail(error instanceof Error ? error.message : String(error)));
    }
    return;
  }
  let runtime;
  const chat = incoming.url === '/acp' || incoming.url?.startsWith('/acp/');
  try {
    runtime = chat ? currentChat(discoveryPath) : currentRuntime(discoveryPath);
  } catch (error) {
    writeFailure(response, chat
      ? { status: 503, body: JSON.stringify({ error: 'acp_unavailable' }) }
      : fail(error instanceof Error ? error.message : String(error)));
    return;
  }

  const headers = { ...incoming.headers };
  delete headers.host;
  delete headers.authorization;
  headers.authorization = `Bearer ${runtime.token}`;
  if (chat) headers['x-astrid-bridge-version'] = 'v1';

  const startedAt = Date.now();
  const upstream = request({
    hostname: runtime.endpoint.hostname,
    port: Number(runtime.endpoint.port),
    method: incoming.method,
    path: chat ? incoming.url.slice(4) || '/' : incoming.url || '/',
    headers,
  }, (upstreamResponse) => {
    clearTimeout(connectTimer);
    const status = upstreamResponse.statusCode ?? 502;
    const responseHeaders = { ...upstreamResponse.headers };
    // The Runtime marks every reply no-store; digest-addressed object bytes are immutable.
    const cacheControl = objectCacheControl(incoming.method, incoming.url, status);
    if (cacheControl) responseHeaders['cache-control'] = cacheControl;
    response.writeHead(status, responseHeaders);
    upstreamResponse.pipe(response);
  });
  upstreamInFlight += 1;

  const connectTimer = setTimeout(() => upstream.destroy(new Error('runtime connect timed out')), connectTimeoutMs);
  upstream.on('socket', (socket) => {
    const connected = () => {
      clearTimeout(connectTimer);
      // Socket idle timeout: re-armed by every byte in either direction.
      upstream.setTimeout(chat ? ACP_IDLE_TIMEOUT_MS : idleTimeoutMs, () => upstream.destroy(new Error('runtime request idle timeout')));
    };
    if (socket.connecting) socket.once('connect', connected); else connected();
  });
  upstream.on('close', () => {
    clearTimeout(connectTimer);
    upstreamInFlight -= 1;
  });
  upstream.on('error', (error) => {
    console.error(`runtime proxy upstream error ${new Date().toISOString()} ${incoming.method} ${(incoming.url ?? '/').split('?')[0]} code=${error.code ?? 'none'} message=${error.message} reusedSocket=${upstream.reusedSocket} elapsedMs=${Date.now() - startedAt} inFlight=${upstreamInFlight}`);
    writeFailure(response, fail(`runtime request failed: ${error.message}`, /timed out|timeout/.test(error.message) ? 504 : 503));
  });
  incoming.on('aborted', () => upstream.destroy());
  incoming.pipe(upstream);
  });
  const close = server.close;
  server.close = function (...args) {
    operations.dispose();
    for (const response of pendingControls) response.destroy();
    return close.apply(this, args);
  };
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
const server = createRuntimeProxyServer({ discoveryPath,
  allowedOrigin: process.env.ASTRID_RUNTIME_OPERATION_ORIGIN,
  expectedHost: `127.0.0.1:${port}` });
server.on('error', (error) => {
  console.error(`runtime discovery proxy failed: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Runtime discovery proxy listening on 127.0.0.1:${port}`);
});
}

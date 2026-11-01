import type { Plugin, ProxyOptions } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OPERATION_PREFIX, operationFailure, operationRequestAllowed, operationTarget } from '../../scripts/runtime-discovery-proxy.mjs';
import { objectCacheControl } from './objectCachePolicy.mjs';

// Idle (socket inactivity) window: re-armed by every byte, so a flowing media stream is never capped.
const RUNTIME_REQUEST_TIMEOUT_MS = 60_000;
export const RUNTIME_TOKEN_FILE_ENV = 'WORKSPACE_RUNTIME_TOKEN_FILE';

function stripOperationRequestHeaders(request: IncomingMessage): boolean {
  const removed = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'authorization', 'cookie']);
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i].toLowerCase() === 'connection') {
      for (const name of request.rawHeaders[i + 1].split(',')) removed.add(name.trim().toLowerCase());
    }
  }
  // Strip before http-proxy copies headers and replaces Connection; proxyReq is bypassed by Expect.
  for (const name of removed) delete request.headers[name];
  request.rawHeaders = request.rawHeaders.filter((_value, index, headers) =>
    !removed.has(headers[index - index % 2].toLowerCase()));
  return !removed.has('x-astrid-operation-handle');
}

export function createWorkspaceRuntimeProxyOptions(
  target: string,
  token: string | null,
): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    timeout: RUNTIME_REQUEST_TIMEOUT_MS,
    proxyTimeout: RUNTIME_REQUEST_TIMEOUT_MS,
    configure: (proxy) => {
      // The Runtime marks every reply no-store; digest-addressed object bytes are immutable.
      proxy.on('proxyRes', (proxyRes, req) => {
        const cacheControl = objectCacheControl(req.method, req.url, proxyRes.statusCode);
        if (cacheControl) proxyRes.headers['cache-control'] = cacheControl;
      });
    },
    rewrite: (incomingPath) => incomingPath.replace(/^\/api\/runtime/, ''),
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  };
}

// This route never uses Vite's startup bearer or the ordinary Runtime rewrite/cache policy.
export function createRuntimeOperationProxyOptions(target: string): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    timeout: RUNTIME_REQUEST_TIMEOUT_MS,
    proxyTimeout: RUNTIME_REQUEST_TIMEOUT_MS,
    configure: (proxy) => {
      proxy.on('error', (_error, _request, response) => {
        if (!('writeHead' in response) || response.destroyed || response.writableEnded) return;
        if (response.headersSent) { response.destroy(); return; }
        const failure = operationFailure(503, 'operation_unavailable');
        response.removeHeader('Access-Control-Allow-Origin');
        response.writeHead(failure.status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
        response.end(failure.body);
      });
      proxy.on('proxyReq', (request) => {
        for (const name of ['authorization', 'cookie', 'proxy-authorization']) request.removeHeader(name);
      });
      proxy.on('proxyRes', (response, _request, downstream) => {
        downstream.removeHeader('Access-Control-Allow-Origin');
        response.headers['cache-control'] = 'no-store';
        delete response.headers['set-cookie'];
      });
    },
  };
}

export function createRuntimeOperationAdmissionPlugin(allowedOrigin: string | undefined): Plugin {
  const admit = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (!request.url?.includes(OPERATION_PREFIX) && request.headers['x-astrid-operation-handle'] === undefined) {
      next(); return;
    }
    let host: string | undefined;
    try { host = new URL(allowedOrigin ?? '').host; } catch { /* Unconfigured means unavailable. */ }
    response.setHeader('Cache-Control', 'no-store');
    const allowed = operationRequestAllowed(request, allowedOrigin, host);
    const handleAllowed = stripOperationRequestHeaders(request);
    const failure = !allowed || !operationRequestAllowed(request, allowedOrigin, host) ? operationFailure(403, 'operation_origin_forbidden')
      : !handleAllowed || !operationTarget(request.url) ? operationFailure(400, 'operation_invalid') : null;
    if (!failure) { next(); return; }
    response.writeHead(failure.status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
    response.end(failure.body);
  };
  return {
    name: 'runtime-operation-admission',
    configureServer: (server) => { server.middlewares.use(admit); },
    configurePreviewServer: (server) => { server.middlewares.use(admit); },
  };
}

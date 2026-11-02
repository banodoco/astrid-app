import type { ProxyOptions } from 'vite';
import { objectCacheControl } from './objectCachePolicy.mjs';

// Idle (socket inactivity) window: re-armed by every byte, so a flowing media stream is never capped.
const RUNTIME_REQUEST_TIMEOUT_MS = 60_000;
export const RUNTIME_TOKEN_FILE_ENV = 'WORKSPACE_RUNTIME_TOKEN_FILE';

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
    rewrite: (incomingPath) => incomingPath.startsWith('/api/runtime/packs/')
      ? incomingPath
      : incomingPath.replace(/^\/api\/runtime/, ''),
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  };
}

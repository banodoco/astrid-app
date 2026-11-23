export const WORKSPACE_RUNTIME_CONFIG_PATH = '/runtime-config/v1/workspace.json';
export const LOCAL_WORKSPACE_ORIGIN_HEADER = 'x-astrid-local-workspace-origin';

export interface WorkspaceRuntimeConfig {
  actorId: string;
  realmId: string;
  runtimeInstanceId: string;
  localWorkspaceProxy?: true;
}

const localWorkspaceOrigins = new WeakMap<WorkspaceRuntimeConfig, string>();

/** Only a config read from the preview proxy carries its origin proof. */
export function localWorkspaceProxyOrigin(config: WorkspaceRuntimeConfig): string | undefined {
  return localWorkspaceOrigins.get(config);
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && Boolean(url.port);
}

/** The local preview proxy supplies this on every page load; other builds retain their baked binding. */
export async function loadWorkspaceRuntimeConfig(
  fallback: WorkspaceRuntimeConfig | undefined,
  fetchImpl: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<WorkspaceRuntimeConfig | undefined> {
  if (typeof window === 'undefined' || typeof fetchImpl !== 'function') return fallback;
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const url = new URL(WORKSPACE_RUNTIME_CONFIG_PATH, window.location.origin);
    const response = await fetchImpl(url.href, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok || (response.url && new URL(response.url).origin !== url.origin)) return fallback;
    const config: unknown = await response.json();
    if (!config || typeof config !== 'object' || Array.isArray(config)) return fallback;
    const value = config as Record<string, unknown>;
    if (value.schemaVersion !== 1
      || Object.keys(value).sort().join(',') !== 'actorId,endpoint,realmId,runtimeInstanceId,schemaVersion'
      || typeof value.endpoint !== 'string') return fallback;
    const endpoint = new URL(value.endpoint);
    if (!isLoopbackHttp(endpoint)) return fallback;
    const ids = [value.actorId, value.realmId, value.runtimeInstanceId];
    if (ids.some((id) => typeof id !== 'string' || !id.trim())) return fallback;
    const localWorkspaceProxy = isLoopbackHttp(url) && response.headers.get(LOCAL_WORKSPACE_ORIGIN_HEADER) === url.origin;
    const binding: WorkspaceRuntimeConfig = {
      actorId: (value.actorId as string).trim(),
      realmId: (value.realmId as string).trim(),
      runtimeInstanceId: (value.runtimeInstanceId as string).trim(),
      ...(localWorkspaceProxy ? { localWorkspaceProxy: true } : {}),
    };
    if (localWorkspaceProxy) localWorkspaceOrigins.set(binding, url.origin);
    return binding;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

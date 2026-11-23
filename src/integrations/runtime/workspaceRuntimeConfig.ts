export const WORKSPACE_RUNTIME_CONFIG_PATH = '/runtime-config/v1/workspace.json';
export const LOCAL_WORKSPACE_ORIGIN_HEADER = 'x-astrid-local-workspace-origin';

export interface WorkspaceRuntimeConfig {
  actorId: string;
  realmId: string;
  runtimeInstanceId: string;
  localWorkspaceProxy?: true;
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
    if (endpoint.protocol !== 'http:'
      || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      || !endpoint.port) return fallback;
    const ids = [value.actorId, value.realmId, value.runtimeInstanceId];
    if (ids.some((id) => typeof id !== 'string' || !id.trim())) return fallback;
    return {
      actorId: (value.actorId as string).trim(),
      realmId: (value.realmId as string).trim(),
      runtimeInstanceId: (value.runtimeInstanceId as string).trim(),
      ...(response.headers.get(LOCAL_WORKSPACE_ORIGIN_HEADER) === url.origin ? { localWorkspaceProxy: true } : {}),
    };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

import { runtimeOrigin } from './connection.ts';
import { ApiError } from './generated.ts';
import { localWorkspaceProxyOrigin, type WorkspaceRuntimeConfig } from './workspaceRuntimeConfig.ts';

/** The selection read is served by the attested local preview proxy. */
export async function readLocalWorkspaceProjectSelection(
  config: WorkspaceRuntimeConfig,
  signal?: AbortSignal,
): Promise<unknown> {
  const origin = localWorkspaceProxyOrigin(config);
  if (!origin || runtimeOrigin() !== '' || typeof window === 'undefined' || window.location.origin !== origin) return undefined;
  const url = new URL('/api/runtime/v1/projects/selection', origin);
  signal?.throwIfAborted();
  const response = await fetch(url.href, {
    method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store',
    credentials: 'same-origin', mode: 'same-origin', redirect: 'error', signal,
  });
  const body = await response.text();
  signal?.throwIfAborted();
  if (response.status === 200) return JSON.parse(body) as unknown;
  let error: { code?: string; message?: string; request_id?: string; details?: Record<string, unknown> } = {};
  try { error = JSON.parse(body) ?? {}; } catch { /* HTTP status remains available for session handling. */ }
  throw new ApiError(response.status, error.code ?? 'http_error', error.message ?? `HTTP ${response.status}`,
    error.request_id ?? '', error.details ?? {});
}

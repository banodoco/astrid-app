import { useEffect, useState } from 'react';
import { isReleaseNumber } from './installedRelease.ts';

export const APP_BUILD_CHECK_INTERVAL_MS = 10 * 60 * 1000;
export const APP_BUILD_FETCH_TIMEOUT_MS = 8_000;
export const APP_BUILD = typeof __ASTRID_APP_BUILD__ === 'undefined' ? '' : __ASTRID_APP_BUILD__;

export type BuildInfo = { app: string; release: number };
export type BuildFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function scheduleFocusAndInterval(check: () => void, intervalMs: number, includeVisibility = false): () => void {
  const onVisibility = () => { if (document.visibilityState === 'visible') check(); };
  const interval = window.setInterval(check, intervalMs);
  window.addEventListener('focus', check);
  if (includeVisibility) document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.clearInterval(interval);
    window.removeEventListener('focus', check);
    if (includeVisibility) document.removeEventListener('visibilitychange', onVisibility);
  };
}

export async function fetchBuildInfo(fetchImpl: BuildFetch): Promise<BuildInfo | null> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, APP_BUILD_FETCH_TIMEOUT_MS);
    });
    const readBuild = async (): Promise<BuildInfo | null> => {
      const response = await fetchImpl('/build.json', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      if (typeof payload !== 'object' || payload === null) return null;
      const { app, release } = payload as Partial<BuildInfo>;
      if (typeof app !== 'string' || !app || !isReleaseNumber(release)) return null;
      return { app, release };
    };
    return await Promise.race([readBuild(), timedOut]);
  } catch {
    return null;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

const browserFetch: BuildFetch = (input, init) => fetch(input, init);

/** Shared App build check state. Failed reads are retried at the next normal check; they never imply a stale page. */
export function useAppBuildWatch({ fetchImpl = browserFetch, intervalMs = APP_BUILD_CHECK_INTERVAL_MS } = {}): boolean {
  const [pageStale, setPageStale] = useState(false);
  useEffect(() => {
    if (pageStale) return undefined;
    let disposed = false;
    let inFlight = false;
    const check = async () => {
      if (inFlight || disposed || pageStale) return;
      inFlight = true;
      try {
        const served = await fetchBuildInfo(fetchImpl);
        if (!disposed && served && served.app !== APP_BUILD) setPageStale(true);
      } finally {
        inFlight = false;
      }
    };
    void check();
    const cleanup = scheduleFocusAndInterval(() => { void check(); }, intervalMs, true);
    return () => { disposed = true; cleanup(); };
  }, [fetchImpl, intervalMs, pageStale]);
  return pageStale;
}

declare global {
  const __ASTRID_APP_BUILD__: string;
}

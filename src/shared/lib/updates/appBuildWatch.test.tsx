import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('App build watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('__ASTRID_APP_BUILD__', 'app-a');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('checks initially, on focus/visibility and every ten minutes; deduplicates requests and cleans up', async () => {
    const { useAppBuildWatch } = await import('./appBuildWatch.ts');
    let finish!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const view = renderHook(() => useAppBuildWatch({ fetchImpl, intervalMs: 600_000 }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('/build.json', expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
    act(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await act(async () => { finish(new Response(JSON.stringify({ app: 'app-a', release: 4 }), { status: 200 })); });
    expect(view.result.current).toBe(false);
    await act(async () => { vi.advanceTimersByTime(600_000); await Promise.resolve(); });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await act(async () => { finish(new Response(JSON.stringify({ app: 'app-a', release: 5 }), { status: 200 })); });
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await act(async () => { finish(new Response(JSON.stringify({ app: 'app-b', release: 5 }), { status: 200 })); });
    expect(view.result.current).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(1_200_000); window.dispatchEvent(new Event('focus')); });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    view.unmount();
    act(() => { vi.advanceTimersByTime(1_200_000); window.dispatchEvent(new Event('focus')); });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not mark the page stale when only Runtime release changes', async () => {
    const { useAppBuildWatch } = await import('./appBuildWatch.ts');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ app: 'app-a', release: 999 }), { status: 200 }));
    const view = renderHook(() => useAppBuildWatch({ fetchImpl }));
    await act(async () => { await Promise.resolve(); });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(view.result.current).toBe(false);
    view.unmount();
  });

  it('keeps the local page available and retries when build.json hangs', async () => {
    const { APP_BUILD_FETCH_TIMEOUT_MS, useAppBuildWatch } = await import('./appBuildWatch.ts');
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const view = renderHook(() => useAppBuildWatch({ fetchImpl, intervalMs: 600_000 }));

    await act(async () => { vi.advanceTimersByTime(APP_BUILD_FETCH_TIMEOUT_MS); await Promise.resolve(); });
    expect(view.result.current).toBe(false);

    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenLastCalledWith('/build.json', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    view.unmount();
  });
});

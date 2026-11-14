// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { visionFixture } from '../../../tests/fixtures/public-vision';

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
const response = () => new Response(JSON.stringify(visionFixture()), { status: 200 });
beforeEach(() => vi.resetModules());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('shared public vision loading', () => {
  it('joins a pending Home preload instead of making a second request', async () => {
    const request = deferredResponse();
    const fetch = vi.fn(() => request.promise); vi.stubGlobal('fetch', fetch);
    const module = await import('./publicVisionContent');
    module.preloadPublicVisionContent();
    module.preloadPublicVisionContent();
    const hook = renderHook(module.usePublicVisionContent);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { request.resolve(response()); });
    await waitFor(() => expect(hook.result.current.content?.vision.title).toBe(visionFixture().vision.title));
  });

  it('keeps a shared request alive across StrictMode and route disposal', async () => {
    const request = deferredResponse();
    const fetch = vi.fn(() => request.promise); vi.stubGlobal('fetch', fetch);
    const module = await import('./publicVisionContent');
    const first = renderHook(module.usePublicVisionContent, { wrapper: StrictMode });
    first.unmount();
    const second = renderHook(module.usePublicVisionContent, { wrapper: StrictMode });
    expect(fetch).toHaveBeenCalledTimes(1);
    const options = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((options[1].signal as AbortSignal).aborted).toBe(false);
    await act(async () => { request.resolve(response()); });
    await waitFor(() => expect(second.result.current.content).not.toBeNull());
  });

  it('uses validated cached content immediately and retains it if refresh fails', async () => {
    const initial = deferredResponse(); const refresh = deferredResponse();
    const fetch = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(refresh.promise);
    vi.stubGlobal('fetch', fetch);
    const module = await import('./publicVisionContent');
    const first = renderHook(module.usePublicVisionContent);
    await act(async () => { initial.resolve(response()); });
    await waitFor(() => expect(first.result.current.content).not.toBeNull());
    const saved = first.result.current.content; first.unmount();
    const second = renderHook(module.usePublicVisionContent);
    expect(second.result.current.content).toBe(saved);
    await act(async () => { refresh.resolve(new Response('', { status: 503 })); });
    await waitFor(() => expect(second.result.current.error).toBe(true));
    expect(second.result.current.content).toBe(saved);
  });

  it('clears a failed request so a deliberate retry can succeed', async () => {
    const initial = deferredResponse(); const retry = deferredResponse();
    const fetch = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(retry.promise);
    vi.stubGlobal('fetch', fetch);
    const module = await import('./publicVisionContent');
    const hook = renderHook(module.usePublicVisionContent);
    await act(async () => { initial.resolve(new Response('', { status: 503 })); });
    await waitFor(() => expect(hook.result.current.error).toBe(true));
    expect(hook.result.current.content).toBeNull();
    act(() => hook.result.current.retry());
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => { retry.resolve(response()); });
    await waitFor(() => expect(hook.result.current.content).not.toBeNull());
    expect(hook.result.current.error).toBe(false);
  });
});

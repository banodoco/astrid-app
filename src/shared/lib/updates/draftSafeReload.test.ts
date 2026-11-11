import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortOnNavigation,
  documentNavigationPhase,
  installDocumentRequestRegistry,
  resetDocumentNavigationForTests,
} from '@/shared/lib/navigation/documentNavigation';
import {
  DRAFTS_CHANGED_BEFORE_RELOAD,
  invalidateDraftReload,
  registerDraftSafeReloadGuard,
  resetDraftReloadGuardsForTest,
  useGuardedReload,
} from './draftSafeReload';

/** A fetch whose single Runtime request answers only when the test says so. */
function slowRuntime() {
  let answer!: () => void;
  const target = {
    fetch: vi.fn(() => new Promise<Response>((resolve) => {
      answer = () => resolve(new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
    })),
    addEventListener: vi.fn(),
  } as unknown as typeof globalThis;
  installDocumentRequestRegistry(target);
  return { target, answer: () => answer() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useGuardedReload', () => {
  beforeEach(() => { resetDocumentNavigationForTests(); resetDraftReloadGuardsForTest(); });
  afterEach(() => { resetDocumentNavigationForTests(); resetDraftReloadGuardsForTest(); });

  it('keeps the page when a draft is edited while Runtime requests settle, and opens the page again', async () => {
    const { target, answer } = slowRuntime();
    const slow = target.fetch('/api/runtime/v1/projects');
    const reloadImpl = vi.fn();
    // A guard registered like `useDraftSafeReload`'s default: never dirty, so only the edit counter can see the edit.
    const unregister = registerDraftSafeReloadGuard({ label: 'Agent chat', flush: async () => {}, isDirty: () => false });
    const { result } = renderHook(() => useGuardedReload(reloadImpl));

    let reloading!: Promise<void>;
    act(() => { reloading = result.current.reload(); });
    await act(tick);
    expect(documentNavigationPhase()).toBe('settling');
    // The person types while the slow request finishes.
    invalidateDraftReload();
    answer();
    await slow;
    await act(() => reloading);

    expect(reloadImpl).not.toHaveBeenCalled();
    expect(result.current.error).toBe(DRAFTS_CHANGED_BEFORE_RELOAD);
    expect(documentNavigationPhase(), 'requests flow again, so the draft can be saved').toBe('open');
    unregister();
  });

  it('reloads after preparing when nothing changed during the wait', async () => {
    const { target, answer } = slowRuntime();
    const slow = target.fetch('/api/runtime/v1/projects');
    const reloadImpl = vi.fn(() => { expect(documentNavigationPhase()).toBe('sealed'); });
    const unregister = registerDraftSafeReloadGuard({ label: 'Timeline', flush: async () => {}, isDirty: () => false });
    const { result } = renderHook(() => useGuardedReload(reloadImpl));

    let reloading!: Promise<void>;
    act(() => { reloading = result.current.reload(); });
    await act(tick);
    expect(reloadImpl).not.toHaveBeenCalled();
    answer();
    await slow;
    await act(() => reloading);

    expect(reloadImpl).toHaveBeenCalledOnce();
    expect(result.current.error).toBeNull();
    unregister();
  });
});

describe('useGuardedReload and requests a navigation does not wait for', () => {
  beforeEach(() => { resetDocumentNavigationForTests(); resetDraftReloadGuardsForTest(); });
  afterEach(() => { resetDocumentNavigationForTests(); resetDraftReloadGuardsForTest(); });

  /** A fetch whose requests answer only when told, and record whether they were cancelled. */
  function runtime() {
    const requests: Array<{ url: string; answer: () => void; aborted: () => boolean }> = [];
    const target = {
      fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        requests.push({ url: String(input), answer: () => resolve(Response.json({ ok: true })), aborted: () => init?.signal?.aborted === true });
      })),
      addEventListener: vi.fn(),
    } as unknown as typeof globalThis;
    installDocumentRequestRegistry(target);
    return { target, requests };
  }

  it('keeps an agent turn running when a draft changed during the wait and the page stays', async () => {
    const { target, requests } = runtime();
    const turn = target.fetch('/api/astrid/acp/c-1/rpc', abortOnNavigation({ method: 'POST' }));
    void target.fetch('/api/runtime/v1/projects');
    const reloadImpl = vi.fn();
    const unregister = registerDraftSafeReloadGuard({ label: 'Agent chat', flush: async () => {}, isDirty: () => false });
    const { result } = renderHook(() => useGuardedReload(reloadImpl));
    let reloading!: Promise<void>;
    act(() => { reloading = result.current.reload(); });
    await act(tick);
    invalidateDraftReload();
    requests[1].answer();
    await act(() => reloading);
    expect(reloadImpl).not.toHaveBeenCalled();
    expect(requests[0].aborted(), 'the turn the person is waiting for goes on').toBe(false);
    requests[0].answer();
    await expect(turn).resolves.toBeInstanceOf(Response);
    unregister();
  });

  it('cancels an agent turn\'s wait right before a reload that happens', async () => {
    const { target, requests } = runtime();
    const turn = target.fetch('/api/astrid/acp/c-1/rpc', abortOnNavigation({ method: 'POST' }));
    const reloadImpl = vi.fn(() => { expect(requests[0].aborted(), 'cancelled while the page is still here').toBe(true); });
    const { result } = renderHook(() => useGuardedReload(reloadImpl));
    await act(() => result.current.reload());
    expect(reloadImpl).toHaveBeenCalledOnce();
    await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
  });
});

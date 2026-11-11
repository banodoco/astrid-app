import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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

// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataProvider } from '@/tools/video-editor/data/DataProvider.ts';
import { createInteractionState, notifyInteractionEndIfIdle, notifyInteractionStart } from '@/tools/video-editor/lib/interaction-state.ts';
import {
  TIMELINE_EDITING_IDLE_MS,
  TIMELINE_EDITING_LEASE_RENEW_MS,
  useTimelineEditingLease,
} from './useTimelineEditingLease.ts';

function response(tabSessionId: string, sequence: number, active = true) {
  return { data: { tab_session_id: tabSessionId, sequence, active, expires_in_seconds: active ? 10 : 0 } };
}

function makeProvider() {
  const provider = {
    timelineEditingLease: {
      renew: vi.fn(async (_timelineId: string, tab: string, sequence: number) => response(tab, sequence)),
      release: vi.fn(async (_timelineId: string, tab: string, sequence: number) => response(tab, sequence, false)),
    },
  } as unknown as DataProvider;
  return provider;
}

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  } as unknown as Storage;
}

const interactionStates = new WeakMap<object, { current: ReturnType<typeof createInteractionState> }>();
function options(provider: DataProvider, overrides: Partial<Parameters<typeof useTimelineEditingLease>[0]> = {}) {
  let interactionState = interactionStates.get(provider);
  if (!interactionState) {
    interactionState = { current: createInteractionState() };
    interactionStates.set(provider, interactionState);
  }
  return {
    provider,
    timelineId: 'timeline-1',
    editSeq: 0,
    dirty: false,
    saving: false,
    nestedDraftActive: false,
    interactionStateRef: interactionState,
    ...overrides,
  };
}

describe('useTimelineEditingLease', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: fakeStorage() });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('sends the first PUT immediately and considers the edit protected only after its matching acknowledgement', async () => {
    let finish!: () => void;
    const provider = makeProvider();
    provider.timelineEditingLease!.renew = vi.fn((_timelineId, tab, sequence) => new Promise((resolve) => {
      finish = () => resolve(response(tab, sequence));
    }));
    const hook = renderHook(() => useTimelineEditingLease(options(provider, { editSeq: 1, dirty: true })));
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(1);
    expect(hook.result.current).toBe(false);
    await act(async () => { finish(); await Promise.resolve(); });
    expect(hook.result.current).toBe(true);
    hook.unmount();
  });

  it('renews every three seconds while editing and sends no heartbeat while idle', () => {
    const provider = makeProvider();
    const hook = renderHook(({ dirty }) => useTimelineEditingLease(options(provider, { editSeq: dirty ? 1 : 0, dirty })), {
      initialProps: { dirty: true },
    });
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(TIMELINE_EDITING_LEASE_RENEW_MS); });
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(2);
    hook.rerender({ dirty: false });
    act(() => { vi.advanceTimersByTime(TIMELINE_EDITING_LEASE_RENEW_MS); });
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it('holds dirty and saving edits until save acknowledgement, then releases after two seconds of inactivity', () => {
    const provider = makeProvider();
    const hook = renderHook(({ dirty, saving }) => useTimelineEditingLease(options(provider, { editSeq: dirty ? 1 : 0, dirty, saving })), {
      initialProps: { dirty: true, saving: true },
    });
    hook.rerender({ dirty: false, saving: false });
    act(() => { vi.advanceTimersByTime(TIMELINE_EDITING_IDLE_MS - 1); });
    expect(provider.timelineEditingLease!.release).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(provider.timelineEditingLease!.release).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('starts on a gesture transition, stays active through the gesture, then applies the inactivity grace', () => {
    const provider = makeProvider();
    const state = { current: createInteractionState() };
    const hook = renderHook(() => useTimelineEditingLease(options(provider, { interactionStateRef: state })));
    state.current.drag = true;
    act(() => notifyInteractionStart(state));
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(1);
    state.current.drag = false;
    act(() => notifyInteractionEndIfIdle(state));
    act(() => { vi.advanceTimersByTime(TIMELINE_EDITING_IDLE_MS); });
    expect(provider.timelineEditingLease!.release).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('tracks nested drafts, local text and IME composition without treating focus alone as activity', () => {
    const provider = makeProvider();
    const root = document.createElement('div');
    const input = document.createElement('input');
    root.append(input);
    document.body.append(root);
    const shellRootRef = { current: root };
    const hook = renderHook(({ nestedDraftActive }) => useTimelineEditingLease(options(provider, { nestedDraftActive, shellRootRef })), {
      initialProps: { nestedDraftActive: false },
    });
    act(() => { input.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    expect(provider.timelineEditingLease!.renew).not.toHaveBeenCalled();
    hook.rerender({ nestedDraftActive: true });
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(1);
    hook.rerender({ nestedDraftActive: false });
    act(() => { vi.advanceTimersByTime(TIMELINE_EDITING_IDLE_MS); });
    expect(provider.timelineEditingLease!.release).toHaveBeenCalledTimes(1);
    act(() => { input.dispatchEvent(new CustomEvent('compositionstart', { bubbles: true })); });
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(2);
    act(() => {
      input.dispatchEvent(new CustomEvent('compositionend', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(2);
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body })); });
    expect(provider.timelineEditingLease!.release).toHaveBeenCalledTimes(2);
    hook.unmount();
    root.remove();
  });

  it('fences delayed releases by tab identity and monotonically increasing sequence', () => {
    const storageA = fakeStorage();
    const storageB = fakeStorage();
    const providerA = makeProvider();
    const providerB = makeProvider();
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: storageA });
    const tabA = renderHook(() => useTimelineEditingLease(options(providerA, { dirty: true, editSeq: 1 })));
    const [tabAId, firstSequence] = providerA.timelineEditingLease!.renew.mock.calls[0].slice(1);
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: storageB });
    const tabB = renderHook(() => useTimelineEditingLease(options(providerB, { dirty: true, editSeq: 1 })));
    const tabBId = providerB.timelineEditingLease!.renew.mock.calls[0][1];
    expect(tabBId).not.toBe(tabAId);
    tabA.unmount();
    const release = providerA.timelineEditingLease!.release.mock.calls[0];
    expect(release[1]).toBe(tabAId);
    expect(release[2]).toBeGreaterThan(firstSequence as number);
    expect(providerB.timelineEditingLease!.release).not.toHaveBeenCalled();
    tabB.unmount();
  });

  it('renews on visibility restoration and pageshow after a best-effort pagehide release', () => {
    const provider = makeProvider();
    const hook = renderHook(() => useTimelineEditingLease(options(provider, { dirty: true, editSeq: 1 })));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(3);
    window.dispatchEvent(new Event('pagehide'));
    expect(provider.timelineEditingLease!.release).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('pageshow'));
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(4);
    hook.unmount();
  });

  it('releases on unmount and keeps failed PUT and DELETE requests silent', async () => {
    const provider = makeProvider();
    provider.timelineEditingLease!.renew = vi.fn(async () => { throw new Error('offline'); });
    provider.timelineEditingLease!.release = vi.fn(async () => { throw new Error('offline'); });
    const hook = renderHook(({ dirty }) => useTimelineEditingLease(options(provider, { dirty, editSeq: dirty ? 1 : 0 })), {
      initialProps: { dirty: true },
    });
    await act(async () => { await Promise.resolve(); });
    hook.rerender({ dirty: false });
    act(() => { vi.advanceTimersByTime(TIMELINE_EDITING_IDLE_MS); });
    expect(provider.timelineEditingLease!.release).toHaveBeenCalledTimes(1);
    expect(() => hook.unmount()).not.toThrow();
  });

  it('fences StrictMode effect remounts so the newest PUT outlives cleanup DELETE', async () => {
    const provider = makeProvider();
    const hook = renderHook(() => useTimelineEditingLease(options(provider, { dirty: true, editSeq: 1 })), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    const renewCalls = provider.timelineEditingLease!.renew.mock.calls;
    const deleteCalls = provider.timelineEditingLease!.release.mock.calls;
    const initialRenewCount = renewCalls.length;
    expect(renewCalls.length).toBeGreaterThanOrEqual(2);
    expect(deleteCalls).toHaveLength(1);
    expect(renewCalls.at(-1)![2]).toBeGreaterThan(deleteCalls[0][2]);
    await act(async () => { vi.advanceTimersByTime(TIMELINE_EDITING_LEASE_RENEW_MS); await Promise.resolve(); });
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(initialRenewCount + 1);
    hook.unmount();
  });
});

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

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  } as unknown as Storage;
}

const interactionStates = new WeakMap<object, { current: ReturnType<typeof createInteractionState> }>();
type LeaseOptions = Parameters<typeof useTimelineEditingLease>[0];
type LeaseOverrides = Partial<LeaseOptions> & { reconcileCanonical?: () => Promise<void> };
function options(provider: DataProvider, overrides: LeaseOverrides = {}) {
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

  it('keeps admission pending through a slow renewal and reconciles canonical state before acknowledging admission', async () => {
    const pending = new Map<number, (value: ReturnType<typeof response>) => void>();
    const events: string[] = [];
    const provider = makeProvider();
    provider.timelineEditingLease!.renew = vi.fn((_timelineId, tab, sequence) => new Promise((resolve) => {
      pending.set(sequence, (value) => resolve(value));
    }));
    let finishReconcile!: () => void;
    const root = document.createElement('div');
    const input = document.createElement('input');
    root.append(input);
    document.body.append(root);
    const shellRootRef = { current: root };
    const reconcileCanonical = vi.fn(() => {
      events.push('canonical-reconcile-start');
      return new Promise<void>(resolve => { finishReconcile = () => { events.push('canonical-reconcile-finish'); resolve(); }; });
    });
    const hook = renderHook(() => useTimelineEditingLease(options(provider, {
      editSeq: 1, dirty: true, reconcileCanonical, shellRootRef,
    })));
    act(() => input.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, data: 'A', inputType: 'insertText',
    })));
    expect(input.value).toBe('');
    expect(hook.result.current).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(TIMELINE_EDITING_LEASE_RENEW_MS + 500);
      const tab = provider.timelineEditingLease!.renew.mock.calls[0][1] as string;
      pending.get(1)!(response(tab, 1));
      await Promise.resolve();
    });
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(2);
    expect(reconcileCanonical).toHaveBeenCalledTimes(1);
    expect(hook.result.current).toBe(false);
    expect(input.value).toBe('');
    expect(events).toEqual(['canonical-reconcile-start']);
    await act(async () => {
      finishReconcile();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    expect(events).toEqual(['canonical-reconcile-start', 'canonical-reconcile-finish']);
    expect(input.value).toBe('A');
    expect(hook.result.current).toBe(true);
    hook.unmount();
    root.remove();
  });

  it('replays cumulative native beforeinput insertions in order after admission', async () => {
    const pending = new Map<number, (value: ReturnType<typeof response>) => void>();
    const provider = makeProvider();
    provider.timelineEditingLease!.renew = vi.fn((_timelineId, tab, sequence) => new Promise((resolve) => {
      pending.set(sequence, value => resolve(value));
    }));
    const root = document.createElement('div');
    const input = document.createElement('input');
    root.append(input);
    document.body.append(root);
    const shellRootRef = { current: root };
    const reconcileCanonical = vi.fn(async () => {});
    const hook = renderHook(() => useTimelineEditingLease(options(provider, { reconcileCanonical, shellRootRef })));

    act(() => {
      for (const data of ['A', 'B', 'C']) input.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, data, inputType: 'insertText',
      }));
    });
    expect(input.value).toBe('');
    const [tab, sequence] = provider.timelineEditingLease!.renew.mock.calls[0].slice(1) as [string, number];
    await act(async () => {
      pending.get(sequence)!(response(tab, sequence));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    expect(reconcileCanonical).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('ABC');
    expect(hook.result.current).toBe(true);
    hook.unmount();
    root.remove();
  });

  it('replaces cumulative cancelable IME composition text while admission is pending', async () => {
    const pending = new Map<number, (value: ReturnType<typeof response>) => void>();
    const provider = makeProvider();
    provider.timelineEditingLease!.renew = vi.fn((_timelineId, tab, sequence) => new Promise((resolve) => {
      pending.set(sequence, value => resolve(value));
    }));
    const root = document.createElement('div');
    const input = document.createElement('input');
    root.append(input);
    document.body.append(root);
    const shellRootRef = { current: root };
    const reconcileCanonical = vi.fn(async () => {});
    const hook = renderHook(() => useTimelineEditingLease(options(provider, { reconcileCanonical, shellRootRef })));

    act(() => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, data: 'n', inputType: 'insertCompositionText', isComposing: true,
      }));
      input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'ni' }));
      input.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, data: 'ni', inputType: 'insertCompositionText', isComposing: true,
      }));
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ni' }));
    });
    expect(input.value).toBe('');
    const [tab, sequence] = provider.timelineEditingLease!.renew.mock.calls[0].slice(1) as [string, number];
    await act(async () => {
      pending.get(sequence)!(response(tab, sequence));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    expect(reconcileCanonical).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('ni');
    expect(hook.result.current).toBe(true);
    hook.unmount();
    root.remove();
  });

  it('replays queued caret movement between native insertions', async () => {
    const pending = new Map<number, (value: ReturnType<typeof response>) => void>();
    const provider = makeProvider();
    provider.timelineEditingLease!.renew = vi.fn((_timelineId, tab, sequence) => new Promise((resolve) => {
      pending.set(sequence, value => resolve(value));
    }));
    const root = document.createElement('div');
    const input = document.createElement('input');
    root.append(input);
    document.body.append(root);
    const shellRootRef = { current: root };
    const reconcileCanonical = vi.fn(async () => {});
    const hook = renderHook(() => useTimelineEditingLease(options(provider, { reconcileCanonical, shellRootRef })));

    act(() => {
      input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: 'A', inputType: 'insertText' }));
      input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: 'B', inputType: 'insertText' }));
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowLeft' }));
      input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: 'C', inputType: 'insertText' }));
    });
    expect(input.value).toBe('');
    const [tab, sequence] = provider.timelineEditingLease!.renew.mock.calls[0].slice(1) as [string, number];
    await act(async () => {
      pending.get(sequence)!(response(tab, sequence));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    expect(reconcileCanonical).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('ACB');
    expect(hook.result.current).toBe(true);
    hook.unmount();
    root.remove();
  });

  it('queues a gesture start and its outside-shell movement and release until admission completes', async () => {
    const pending = new Map<number, (value: ReturnType<typeof response>) => void>();
    const provider = makeProvider();
    provider.timelineEditingLease!.renew = vi.fn((_timelineId, tab, sequence) => new Promise((resolve) => {
      pending.set(sequence, value => resolve(value));
    }));
    const root = document.createElement('div');
    const target = document.createElement('button');
    const outside = document.createElement('div');
    root.append(target);
    document.body.append(root, outside);
    const shellRootRef = { current: root };
    const observed: string[] = [];
    target.addEventListener('pointerdown', () => observed.push('down'));
    target.addEventListener('pointermove', () => observed.push('move'));
    target.addEventListener('pointerup', () => observed.push('up'));
    const reconcileCanonical = vi.fn(async () => {});
    const hook = renderHook(() => useTimelineEditingLease(options(provider, {
      reconcileCanonical, shellRootRef,
    })));
    act(() => {
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 12 }));
      outside.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 15, clientY: 18 }));
      outside.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 15, clientY: 18 }));
    });
    expect(observed).toEqual([]);
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(1);
    const [tab, sequence] = provider.timelineEditingLease!.renew.mock.calls[0].slice(1) as [string, number];
    await act(async () => {
      pending.get(sequence)!(response(tab, sequence));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    expect(reconcileCanonical).toHaveBeenCalledTimes(1);
    expect(observed).toEqual(['down', 'move', 'up']);
    expect(hook.result.current).toBe(true);
    hook.unmount();
    root.remove();
    outside.remove();
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

  it('releases after a save acknowledged just before a heartbeat without losing its idle timer', () => {
    const provider = makeProvider();
    const hook = renderHook(({ pending }) => useTimelineEditingLease(options(provider, {
      editSeq: 1, dirty: pending, saving: pending,
    })), { initialProps: { pending: true } });
    act(() => { vi.advanceTimersByTime(TIMELINE_EDITING_LEASE_RENEW_MS - 500); });
    hook.rerender({ pending: false });
    act(() => { vi.advanceTimersByTime(TIMELINE_EDITING_IDLE_MS - 1); });
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(2);
    expect(provider.timelineEditingLease!.release).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(provider.timelineEditingLease!.release).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(TIMELINE_EDITING_LEASE_RENEW_MS); });
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(2);
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

  it('records native text activity without rendering ahead of the controlled input handler', () => {
    const provider = makeProvider();
    // No acknowledgement arrives during the native event. Only the input's
    // React owner may render its new value before the synthetic change runs.
    provider.timelineEditingLease!.renew = vi.fn(() => new Promise(() => {}));
    const root = document.createElement('div');
    const input = document.createElement('input');
    root.append(input);
    document.body.append(root);
    let renders = 0;
    const shellRootRef = { current: root };
    const hook = renderHook(() => {
      renders++;
      return useTimelineEditingLease(options(provider, { shellRootRef }));
    });
    const before = renders;
    act(() => {
      input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, data: 'A' }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'A' }));
    });
    expect(provider.timelineEditingLease!.renew).toHaveBeenCalledTimes(1);
    expect(renders).toBe(before);
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

  it('gives cloned sessionStorage contexts separate lease owners and releases only its own lease', () => {
    const serializedOwner = JSON.stringify({ id: 'cloned-tab-owner', sequence: 41 });
    const storageA = fakeStorage({ 'astrid.timeline-editing.tab.v1': serializedOwner });
    const storageB = fakeStorage({ 'astrid.timeline-editing.tab.v1': serializedOwner });
    const activeLeases = new Map<string, number>();
    const provider = makeProvider();
    provider.timelineEditingLease!.renew = vi.fn(async (_timelineId, tab, sequence) => {
      activeLeases.set(tab, sequence);
      return response(tab, sequence);
    });
    provider.timelineEditingLease!.release = vi.fn(async (_timelineId, tab, sequence) => {
      if (sequence > (activeLeases.get(tab) ?? -1)) activeLeases.delete(tab);
      return response(tab, sequence, false);
    });

    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: storageA });
    const tabA = renderHook(() => useTimelineEditingLease(options(provider, { dirty: true, editSeq: 1 })));
    const [tabAId, firstSequenceA] = provider.timelineEditingLease!.renew.mock.calls[0].slice(1);

    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: storageB });
    const tabB = renderHook(() => useTimelineEditingLease(options(provider, { dirty: true, editSeq: 1 })));
    const [tabBId, firstSequenceB] = provider.timelineEditingLease!.renew.mock.calls[1].slice(1);

    expect(JSON.parse(storageA.getItem('astrid.timeline-editing.tab.v1')!).id).toBe(tabAId);
    expect(JSON.parse(storageB.getItem('astrid.timeline-editing.tab.v1')!).id).toBe(tabBId);
    expect(tabBId).not.toBe(tabAId);
    expect(firstSequenceA).toBe(1);
    expect(firstSequenceB).toBe(1);
    expect(activeLeases.size).toBe(2);

    tabA.unmount();

    expect(provider.timelineEditingLease!.release).toHaveBeenCalledTimes(1);
    expect(provider.timelineEditingLease!.release.mock.calls[0][2]).toBeGreaterThan(firstSequenceA as number);
    expect(activeLeases.has(tabAId as string)).toBe(false);
    expect(activeLeases.has(tabBId as string)).toBe(true);
    tabB.unmount();
  });

  it('gives two mounted editors using the same sessionStorage independent lease owners', () => {
    const provider = makeProvider();
    const active = new Set<string>();
    provider.timelineEditingLease!.renew = vi.fn(async (_timelineId, tab, sequence) => {
      active.add(tab);
      return response(tab, sequence);
    });
    provider.timelineEditingLease!.release = vi.fn(async (_timelineId, tab, sequence) => {
      active.delete(tab);
      return response(tab, sequence, false);
    });
    const storage = fakeStorage();
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: storage });

    const first = renderHook(() => useTimelineEditingLease(options(provider, { dirty: true, editSeq: 1 })));
    const second = renderHook(() => useTimelineEditingLease(options(provider, { dirty: true, editSeq: 1 })));
    const firstTab = provider.timelineEditingLease!.renew.mock.calls[0][1] as string;
    const secondTab = provider.timelineEditingLease!.renew.mock.calls[1][1] as string;
    expect(firstTab).not.toBe(secondTab);
    expect(active).toEqual(new Set([firstTab, secondTab]));

    first.unmount();

    expect(provider.timelineEditingLease!.release).toHaveBeenCalledTimes(1);
    expect(provider.timelineEditingLease!.release.mock.calls[0][1]).toBe(firstTab);
    expect(active.has(firstTab)).toBe(false);
    expect(active.has(secondTab)).toBe(true);
    second.unmount();
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

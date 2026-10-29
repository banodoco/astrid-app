import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useEditorBrowserDefaults } from '@/tools/video-editor/hooks/useEditorBrowserDefaults.ts';
import type { SaveStatus } from '@/tools/video-editor/hooks/useTimelinePersistence.ts';
import { flushDraftsBeforeReload } from '@/shared/lib/updates/draftSafeReload.ts';

function mount(
  saveStatus: SaveStatus,
  flushPendingSave = vi.fn(() => Promise.resolve(1)),
  preserveTimelineDraftForReload = vi.fn(() => Promise.resolve()),
  isTimelineDraftDurableForReload = vi.fn(() => false),
) {
  const shellRoot = document.createElement('div');
  const inner = document.createElement('button');
  shellRoot.appendChild(inner);
  document.body.appendChild(shellRoot);
  const view = renderHook((props: { status: SaveStatus }) => useEditorBrowserDefaults({
    shellRoot,
    saveStatus: props.status,
    flushPendingSave,
    preserveTimelineDraftForReload,
    isTimelineDraftDurableForReload,
  }), { initialProps: { status: saveStatus } });
  return { shellRoot, inner, flushPendingSave, preserveTimelineDraftForReload, isTimelineDraftDurableForReload, view, setStatus: (status: SaveStatus) => view.rerender({ status }) };
}

function key(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function unload() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useEditorBrowserDefaults', () => {
  it('blocks page zoom on Ctrl/Cmd+wheel inside the editor and leaves plain wheel alone', () => {
    const { inner } = mount('saved');
    const ctrl = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -10 });
    const meta = new WheelEvent('wheel', { bubbles: true, cancelable: true, metaKey: true, deltaY: 10 });
    const plain = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 10 });
    inner.dispatchEvent(ctrl);
    inner.dispatchEvent(meta);
    inner.dispatchEvent(plain);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(meta.defaultPrevented).toBe(true);
    expect(plain.defaultPrevented).toBe(false);
  });

  it('does not block wheel outside the editor shell', () => {
    mount('saved');
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true });
    outside.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('Cmd+S and Ctrl+S prevent Save page as and flush only when the timeline is dirty', () => {
    const dirty = mount('dirty');
    expect(key(dirty.inner, { key: 's', metaKey: true }).defaultPrevented).toBe(true);
    expect(key(dirty.inner, { key: 's', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(dirty.flushPendingSave).toHaveBeenCalledTimes(2);
    dirty.view.unmount();

    const saved = mount('saved');
    expect(key(saved.inner, { key: 's', metaKey: true }).defaultPrevented).toBe(true);
    expect(saved.flushPendingSave).not.toHaveBeenCalled();
  });

  it('leaves a bare S and Cmd+S outside the editor alone', () => {
    const { inner, flushPendingSave } = mount('dirty');
    expect(key(inner, { key: 's' }).defaultPrevented).toBe(false);
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    expect(key(outside, { key: 's', metaKey: true }).defaultPrevented).toBe(false);
    expect(flushPendingSave).not.toHaveBeenCalled();
  });

  it('asks before unload only while a save is pending, in flight or failed', () => {
    const { view } = mount('saved');
    expect(unload().defaultPrevented).toBe(false);
    for (const status of ['dirty', 'saving', 'retrying', 'error'] as const) {
      view.rerender({ status });
      expect(unload().defaultPrevented).toBe(true);
    }
    view.rerender({ status: 'saved' });
    expect(unload().defaultPrevented).toBe(false);
    view.unmount();
    expect(unload().defaultPrevented).toBe(false);
  });

  it('registers the mounted timeline flush as a durable update reload guard', async () => {
    let setStatus = (_status: SaveStatus) => undefined;
    const flushPendingSave = vi.fn(async () => { setStatus('saved'); return 4; });
    const mounted = mount('dirty', flushPendingSave);
    setStatus = mounted.setStatus;
    await flushDraftsBeforeReload();
    expect(flushPendingSave).toHaveBeenCalledOnce();
    mounted.view.unmount();
  });

  it('flushes again when the first barrier only acknowledged an older edit sequence', async () => {
    let setStatus = (_status: SaveStatus) => undefined;
    let attempts = 0;
    const flushPendingSave = vi.fn(async () => {
      attempts++;
      if (attempts === 2) setStatus('saved');
      return attempts;
    });
    const mounted = mount('dirty', flushPendingSave);
    setStatus = mounted.setStatus;

    await flushDraftsBeforeReload();

    expect(flushPendingSave).toHaveBeenCalledTimes(2);
    mounted.view.unmount();
  });

  it('admits reload after a failed Runtime acknowledgement only when the owner verifies a durable recovery draft', async () => {
    const flushPendingSave = vi.fn(async () => { throw new Error('Runtime instance changed'); });
    let durable = false;
    const preserveTimelineDraftForReload = vi.fn(async () => { durable = true; });
    const mounted = mount('error', flushPendingSave, preserveTimelineDraftForReload, () => durable);
    await act(async () => { await flushDraftsBeforeReload(); });
    expect(flushPendingSave).toHaveBeenCalledOnce();
    expect(preserveTimelineDraftForReload).toHaveBeenCalledOnce();
    mounted.view.unmount();

    const failedPreservation = mount('error', flushPendingSave, vi.fn(async () => { throw new Error('IndexedDB full'); }), () => false);
    await expect(flushDraftsBeforeReload()).rejects.toThrow('IndexedDB full');
    failedPreservation.view.unmount();
  });
});

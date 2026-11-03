import { describe, expect, it, vi } from 'vitest';
import {
  createInteractionState,
  isInteractionActive,
  notifyInteractionEndIfIdle,
  onInteractionEnd,
  type InteractionStateRef,
} from '@/tools/video-editor/lib/interaction-state';

const makeRef = (): InteractionStateRef => ({ current: createInteractionState() });

describe('interaction-state helpers', () => {
  it('reports active for gestures, resize, and pending edit admission', () => {
    const ref = makeRef();
    expect(isInteractionActive(ref)).toBe(false);
    ref.current.drag = true;
    expect(isInteractionActive(ref)).toBe(true);
    ref.current.drag = false;
    ref.current.resize = true;
    expect(isInteractionActive(ref)).toBe(true);
    ref.current.resize = false;
    (ref.current as typeof ref.current & { admissionPending?: boolean }).admissionPending = true;
    expect(isInteractionActive(ref)).toBe(true);
  });

  it('fires end listeners when both flags reach false', () => {
    const ref = makeRef();
    const listener = vi.fn();
    onInteractionEnd(ref, listener);

    ref.current.drag = true;
    notifyInteractionEndIfIdle(ref); // still active — should not fire
    expect(listener).not.toHaveBeenCalled();

    ref.current.drag = false;
    notifyInteractionEndIfIdle(ref); // now idle — should fire
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not fire end listeners while resize is still active', () => {
    const ref = makeRef();
    const listener = vi.fn();
    onInteractionEnd(ref, listener);

    ref.current.drag = true;
    ref.current.resize = true;
    ref.current.drag = false;
    notifyInteractionEndIfIdle(ref);
    expect(listener).not.toHaveBeenCalled();

    ref.current.resize = false;
    notifyInteractionEndIfIdle(ref);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('returns an unsubscribe function', () => {
    const ref = makeRef();
    const listener = vi.fn();
    const unsubscribe = onInteractionEnd(ref, listener);
    unsubscribe();
    notifyInteractionEndIfIdle(ref);
    expect(listener).not.toHaveBeenCalled();
  });

  it('multicasts to all registered listeners', () => {
    const ref = makeRef();
    const a = vi.fn();
    const b = vi.fn();
    onInteractionEnd(ref, a);
    onInteractionEnd(ref, b);
    notifyInteractionEndIfIdle(ref);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('keeps firing other listeners if one throws', () => {
    const ref = makeRef();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = vi.fn(() => {
      throw new Error('boom');
    });
    const b = vi.fn();
    onInteractionEnd(ref, a);
    onInteractionEnd(ref, b);
    notifyInteractionEndIfIdle(ref);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});

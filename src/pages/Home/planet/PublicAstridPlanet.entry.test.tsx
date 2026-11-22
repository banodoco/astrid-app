// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ wait: vi.fn(), pending: vi.fn(), init: vi.fn(), dispose: vi.fn() }));
vi.mock('../publicAstridNavigation', () => ({
  waitForPublicAstridPageTransitions: seam.wait,
  hasPendingPublicAstridPageTransition: seam.pending,
}));
import { PublicAstridPlanet } from './PublicAstridPlanet';

beforeEach(() => {
  seam.wait.mockResolvedValue(undefined);
  seam.pending.mockReturnValue(false);
  seam.init.mockReturnValue({ dispose: seam.dispose });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('PublicAstridPlanet engine boundary', () => {
  it('keeps the poster and skips the import while still or content is pending', async () => {
    const loadEngine = vi.fn(async () => ({ initPlanetEngine: seam.init }));
    const view = render(<PublicAstridPlanet live={false} contentReady loadEngine={loadEngine} />);
    expect(view.container.querySelector('img')).not.toBeNull();
    expect(view.container.querySelector('canvas')).toBeNull();
    view.rerender(<PublicAstridPlanet live contentReady={false} loadEngine={loadEngine} />);
    await act(async () => { await Promise.resolve(); });
    expect(view.container.querySelector('img')).not.toBeNull();
    expect(loadEngine).not.toHaveBeenCalled();
  });

  it('waits for the transition, holds the poster through the first frame, and disposes', async () => {
    let finish!: () => void;
    seam.wait.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const loadEngine = vi.fn(async () => ({ initPlanetEngine: seam.init }));
    const view = render(<PublicAstridPlanet live contentReady loadEngine={loadEngine} />);
    expect(loadEngine).not.toHaveBeenCalled();
    expect(view.container.querySelector('img')).not.toBeNull();
    await act(async () => { finish(); });
    await waitFor(() => expect(seam.init).toHaveBeenCalledTimes(1));
    expect(view.container.querySelector('img')).not.toBeNull();
    const callbacks = seam.init.mock.calls[0][1] as { onReady: () => void };
    act(() => callbacks.onReady());
    expect(view.container.querySelector('img')).toBeNull();
    view.unmount();
    expect(seam.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not initialize after unmount during transition or import', async () => {
    let finish!: () => void;
    seam.wait.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const loadEngine = vi.fn(async () => ({ initPlanetEngine: seam.init }));
    const waiting = render(<PublicAstridPlanet live contentReady loadEngine={loadEngine} />);
    waiting.unmount();
    await act(async () => { finish(); });
    expect(loadEngine).not.toHaveBeenCalled();

    let finishImport!: (module: Awaited<ReturnType<typeof loadEngine>>) => void;
    const delayed = vi.fn(() => new Promise<Awaited<ReturnType<typeof loadEngine>>>((resolve) => { finishImport = resolve; }));
    const loading = render(<PublicAstridPlanet live contentReady loadEngine={delayed} />);
    await waitFor(() => expect(delayed).toHaveBeenCalledTimes(1));
    loading.unmount();
    await act(async () => { finishImport({ initPlanetEngine: seam.init }); });
    expect(seam.init).not.toHaveBeenCalled();
  });
});


describe('page transition readiness signal', () => {
  it('follows replacement transitions and releases on finish, invalidation and synchronous failure', async () => {
    const navigation = await vi.importActual<typeof import('../publicAstridNavigation')>('../publicAstridNavigation');
    const original = Object.getOwnPropertyDescriptor(document, 'startViewTransition');
    const finishes: (() => void)[] = [];
    const start = vi.fn((apply: () => void) => {
      apply();
      return { finished: new Promise<void>((resolve) => finishes.push(resolve)), skipTransition: vi.fn() };
    });
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    const hook = renderHook(() => navigation.usePublicAstridNavigation({ visible: true, phone: false, reducedMotion: false }));
    try {
      act(() => hook.result.current.run(() => {}, 'vision'));
      let settled = false;
      void navigation.waitForPublicAstridPageTransitions().then(() => { settled = true; });
      act(() => hook.result.current.run(() => {}, 'home'));
      await act(async () => { await Promise.resolve(); });
      expect(settled).toBe(false);
      await act(async () => { finishes[1](); });
      await waitFor(() => expect(settled).toBe(true));
      act(() => hook.result.current.run(() => {}, 'vision'));
      act(() => hook.result.current.invalidate());
      expect(navigation.hasPendingPublicAstridPageTransition()).toBe(false);
      start.mockImplementationOnce(() => { throw new Error('unavailable'); });
      act(() => hook.result.current.run(() => {}, 'vision'));
      expect(navigation.hasPendingPublicAstridPageTransition()).toBe(false);
      Object.defineProperty(document, 'startViewTransition', { configurable: true, value: undefined });
      const commit = vi.fn();
      act(() => hook.result.current.run(commit, 'vision'));
      expect(commit).toHaveBeenCalledTimes(1);
      expect(navigation.hasPendingPublicAstridPageTransition()).toBe(false);
    } finally {
      hook.unmount();
      if (original) Object.defineProperty(document, 'startViewTransition', original);
      else delete (document as Document & { startViewTransition?: unknown }).startViewTransition;
    }
  });
});

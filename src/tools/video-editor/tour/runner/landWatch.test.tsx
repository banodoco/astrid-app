// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exitEditorTour, markEditorTourReady, setEditorTourBeat, skipEditorTourAnimation, startEditorTour, type EditorTourAct, type EditorTourBeat } from '@/shared/state/editorTourStore';
import { LAND_WATCH_CAP_MS, LAND_WATCH_HOLD_MS, useLandWatch } from './landWatch';

let reducedMotion = false;

beforeEach(() => {
  vi.useFakeTimers();
  reducedMotion = false;
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: reducedMotion, media: query } as MediaQueryList));
});
afterEach(() => {
  act(() => exitEditorTour());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function watchAt(tourAct: EditorTourAct, beat: EditorTourBeat, instant = false) {
  act(() => { startEditorTour(); setEditorTourBeat(tourAct, beat, instant); });
  return renderHook(() => useLandWatch(`1:${tourAct}:${beat}`, tourAct, beat));
}
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const present = () => act(() => markEditorTourReady('timeline'));

describe('useLandWatch', () => {
  it('holds each act for its own time, counted from when the result is being presented, not from the beat', () => {
    expect(LAND_WATCH_HOLD_MS).toEqual({ 1: 2000, 2: 300, 3: 3000 });
    for (const tourAct of [1, 2, 3] as const) {
      const { result, unmount } = watchAt(tourAct, 'land');
      expect(result.current).toBe(true);
      // A slow load does not eat the hold.
      advance(4000);
      expect(result.current).toBe(true);
      present();
      advance(LAND_WATCH_HOLD_MS[tourAct] - 1);
      expect(result.current).toBe(true);
      advance(1);
      expect(result.current).toBe(false);
      unmount();
    }
  });

  it('ends at once on Enter (the runner’s skip)', () => {
    const { result } = watchAt(3, 'land');
    present();
    advance(500);
    act(() => skipEditorTourAnimation());
    expect(result.current).toBe(false);
  });

  it('never watches on Back or with reduced motion, nor on any other beat', () => {
    expect(watchAt(1, 'land', true).result.current).toBe(false);
    for (const beat of ['welcome', 'compose', 'respond', 'gallery', 'finale', 'feedback'] as const) expect(watchAt(2, beat).result.current).toBe(false);
    reducedMotion = true;
    expect(watchAt(1, 'land').result.current).toBe(false);
  });

  it('gives up waiting for a result that never reports itself, so the explainer still comes', () => {
    const { result } = watchAt(1, 'land');
    advance(LAND_WATCH_CAP_MS - 1);
    expect(result.current).toBe(true);
    advance(1);
    expect(result.current).toBe(false);
  });
});

// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOUR_LEAVE_MS, TOUR_MOVE_MS, TOUR_SETTLE_CAP_MS, useSettledRects } from './useSettledRects';
import type { SpotlightMeasurement, SpotlightRect } from './useSpotlightRects';

const rect = (x: number, y = 100): SpotlightRect => ({ x, y, width: 100, height: 50 });
const measured = (key: string, rects: SpotlightRect[], complete = true): SpotlightMeasurement => ({ key, rects, complete });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
});

const frames = (n: number) => act(() => { vi.advanceTimersByTime(16 * n); });

interface Props { key: string; targetsKey: string; measurement: SpotlightMeasurement; motion?: boolean }

function mount(initial: Props) {
  return renderHook((props: Props) => useSettledRects({ motion: true, ...props }), { initialProps: initial });
}

const WELCOME: Props = { key: '1:1:welcome', targetsKey: '', measurement: measured('', []) };

describe('useSettledRects', () => {
  it('shows the first step at once, without animating', () => {
    const { result } = mount(WELCOME);
    expect(result.current).toMatchObject({ key: '1:1:welcome', rects: [], animate: false });
  });

  it('never commits a new step with the measurement of the previous step’s targets', () => {
    const { result, rerender } = mount(WELCOME);
    frames(3);
    // The store has moved on; the measurement still carries the welcome's (empty) targets for as long as it likes.
    rerender({ key: '1:1:compose', targetsKey: 'composer', measurement: measured('', []) });
    frames(TOUR_SETTLE_CAP_MS / 16 + 10);
    expect(result.current.key).toBe('1:1:welcome');
    rerender({ key: '1:1:compose', targetsKey: 'composer', measurement: measured('composer', [rect(300)]) });
    frames(6);
    expect(result.current).toMatchObject({ key: '1:1:compose', rects: [rect(300)], animate: true });
  });

  it('waits until every target exists, then commits them all at once', () => {
    const { result, rerender } = mount(WELCOME);
    frames(3);
    // A land beat: the preview is there at once, the act's new row a few frames later.
    rerender({ key: '1:2:land', targetsKey: 'row|preview', measurement: measured('row|preview', [rect(500)], false) });
    frames(15);
    expect(result.current.key).toBe('1:1:welcome');
    rerender({ key: '1:2:land', targetsKey: 'row|preview', measurement: measured('row|preview', [rect(10, 600), rect(500)]) });
    frames(5);
    expect(result.current).toMatchObject({ key: '1:2:land', rects: [rect(10, 600), rect(500)], animate: true, serial: 2 });
  });

  it('keeps the old step until the new targets hold still, then moves once to where they ended', () => {
    const { result, rerender } = mount(WELCOME);
    frames(3);
    rerender({ key: '1:1:compose', targetsKey: 'composer', measurement: measured('composer', [rect(100)]) });
    for (const x of [140, 180, 220, 260]) {
      frames(1);
      rerender({ key: '1:1:compose', targetsKey: 'composer', measurement: measured('composer', [rect(x)]) });
      expect(result.current.key).toBe('1:1:welcome');
    }
    frames(5);
    expect(result.current).toMatchObject({ key: '1:1:compose', rects: [rect(260)], animate: true, serial: 2 });
    frames(40);
    expect(result.current.serial).toBe(2);
  });

  it('lets the old content leave before anything moves, unless motion is reduced', () => {
    const still = { key: '1:1:compose', targetsKey: 'composer', measurement: measured('composer', [rect(100)]) };
    const moving = mount({ ...WELCOME, targetsKey: 'composer', measurement: measured('composer', [rect(100)]) });
    frames(3);
    moving.rerender(still);
    act(() => { vi.advanceTimersByTime(TOUR_LEAVE_MS - 20); });
    expect(moving.result.current.key).toBe('1:1:welcome');
    frames(3);
    expect(moving.result.current.key).toBe('1:1:compose');

    const reduced = mount({ ...WELCOME, targetsKey: 'composer', measurement: measured('composer', [rect(100)]), motion: false });
    frames(3);
    reduced.rerender({ ...still, motion: false });
    frames(4); // still long enough to count as still, well short of the leave
    expect(16 * 4).toBeLessThan(TOUR_LEAVE_MS);
    expect(reduced.result.current.key).toBe('1:1:compose');
  });

  it('commits what it has after the cap when a target never arrives', () => {
    const { result, rerender } = mount(WELCOME);
    frames(3);
    rerender({ key: '1:1:land', targetsKey: 'row|preview', measurement: measured('row|preview', [rect(500)], false) });
    act(() => { vi.advanceTimersByTime(TOUR_SETTLE_CAP_MS - 50); });
    expect(result.current.key).toBe('1:1:welcome');
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toMatchObject({ key: '1:1:land', rects: [rect(500)] });
  });

  it('ignores drift of a pixel or two within a step, and moves again for a real change only once the move has landed', () => {
    const { result, rerender } = mount(WELCOME);
    frames(3);
    rerender({ key: '1:1:compose', targetsKey: 'c', measurement: measured('c', [rect(100)]) });
    frames(12);
    expect(result.current).toMatchObject({ rects: [rect(100)], serial: 2 });
    rerender({ key: '1:1:compose', targetsKey: 'c', measurement: measured('c', [rect(101)]) });
    frames(10);
    expect(result.current.serial).toBe(2);
    // Mid-flight: a far change waits for the move in flight to land rather than retargeting it.
    rerender({ key: '1:1:compose', targetsKey: 'c', measurement: measured('c', [rect(300)]) });
    frames(5);
    expect(result.current.serial).toBe(2);
    act(() => { vi.advanceTimersByTime(TOUR_MOVE_MS); });
    expect(result.current).toMatchObject({ rects: [rect(300)], animate: true, serial: 3 });
  });

  it('follows a viewport resize at once, unanimated, and the reflow after it too', () => {
    const { result, rerender } = mount({ key: '1:1:compose', targetsKey: 'c', measurement: measured('c', [rect(100)]) });
    frames(3);
    act(() => {
      Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toMatchObject({ rects: [rect(100)], animate: false });
    rerender({ key: '1:1:compose', targetsKey: 'c', measurement: measured('c', [rect(60)]) });
    frames(6);
    expect(result.current).toMatchObject({ rects: [rect(60)], animate: false });
  });
});

// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpotlightMeasurement, type SpotlightMeasurement } from './useSpotlightRects';

const TARGET = '[data-editor-tour="chat-composer"]';
let target: HTMLElement;
let x = 400;
let measures = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  x = 400;
  measures = 0;
  target = document.createElement('div');
  target.dataset.editorTour = 'chat-composer';
  target.getBoundingClientRect = () => { measures += 1; return { left: x, top: 100, right: x + 200, bottom: 160, width: 200, height: 60, x, y: 100, toJSON: () => ({}) } as DOMRect; };
  document.body.append(target);
});
afterEach(() => {
  target.remove();
  document.querySelectorAll('[data-test-extra]').forEach((el) => el.remove());
  vi.useRealTimers();
});

const frame = () => act(() => { vi.advanceTimersByTime(16); });

function mount() {
  const seen: SpotlightMeasurement[] = [];
  const view = renderHook(() => {
    const measurement = useSpotlightMeasurement([TARGET]);
    if (seen.at(-1) !== measurement) seen.push(measurement);
    return measurement;
  });
  return { ...view, seen };
}

describe('useSpotlightMeasurement', () => {
  it('follows a sliding target in a ref: React hears of the first measurement and of the rects at rest, not of each frame', () => {
    const { result, seen } = mount();
    // The pane slides for twenty frames.
    for (let i = 0; i < 20; i += 1) { x -= 10; frame(); }
    expect(result.current.still).toBe(false);
    for (let i = 0; i < 6; i += 1) frame();
    expect(result.current).toMatchObject({ key: TARGET, complete: true, still: true });
    expect(result.current.rects[0].x).toBe(x - 6);
    // The initial placeholder, the first measurement, the rects at rest.
    expect(seen).toHaveLength(3);
  });

  it('is not woken by changes that cannot move its target: inside the tour’s own card, or inside the composer as it is typed in', async () => {
    mount();
    for (let i = 0; i < 6; i += 1) frame();
    const card = document.createElement('div');
    card.setAttribute('data-editor-tour-card-host', '');
    card.setAttribute('data-test-extra', '');
    await act(async () => { document.body.append(card); await Promise.resolve(); });
    for (let i = 0; i < 6; i += 1) frame();
    const before = measures;
    await act(async () => { card.append(document.createElement('span')); await Promise.resolve(); });
    for (let i = 0; i < 6; i += 1) frame();
    await act(async () => { target.append(document.createElement('span')); await Promise.resolve(); });
    for (let i = 0; i < 6; i += 1) frame();
    expect(measures).toBe(before);
    // A node appearing around the target can move it: that is looked at.
    await act(async () => { const sibling = document.createElement('div'); sibling.setAttribute('data-test-extra', ''); document.body.append(sibling); await Promise.resolve(); });
    for (let i = 0; i < 3; i += 1) frame();
    expect(measures).toBeGreaterThan(before);
  });

  it('still notices a shift that announced nothing, on its slow periodic look', () => {
    const { result } = mount();
    for (let i = 0; i < 6; i += 1) frame();
    x = 250;
    act(() => { vi.advanceTimersByTime(1100); });
    for (let i = 0; i < 6; i += 1) frame();
    expect(result.current.rects[0].x).toBe(244);
    expect(result.current.still).toBe(true);
  });
});

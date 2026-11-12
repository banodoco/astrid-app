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

  it('measures a target inside a pane that is sliding to its place where it will rest, so it is still at once', () => {
    const pane = document.createElement('div');
    pane.setAttribute('data-editor-tour-rest', 'in');
    pane.setAttribute('data-test-extra', '');
    document.body.append(pane);
    pane.append(target);
    let slide = 300;
    const computed = window.getComputedStyle.bind(window);
    const style = vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => (
      element === pane ? { ...computed(element, pseudo), transform: `matrix(1, 0, 0, 1, ${slide}, 0)`, overflowX: 'visible', overflowY: 'visible' } as CSSStyleDeclaration : computed(element, pseudo)
    ));
    vi.stubGlobal('DOMMatrixReadOnly', class { is2D = true; a = 1; b = 0; c = 0; d = 1; e: number; f = 0; constructor(text: string) { this.e = Number(/matrix\(1, 0, 0, 1, (-?[\d.]+)/.exec(text)?.[1] ?? 0); } });
    try {
      const { result } = mount();
      // The pane slides in: the target's box follows it, its resting box does not move.
      for (let i = 0; i < 6; i += 1) { slide -= 50; x = 400 + slide; frame(); }
      expect(result.current).toMatchObject({ complete: true, still: true });
      expect(result.current.rects[0].x).toBe(400 - 6);
    } finally {
      style.mockRestore();
      vi.unstubAllGlobals();
      document.body.append(target);
    }
  });

  it('sets nothing up for an empty target list', () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    renderHook(() => useSpotlightMeasurement([]));
    expect(observe).not.toHaveBeenCalled();
    observe.mockRestore();
  });
});

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPARE_REST, COMPARE_SWEEP_DELAY_MS, COMPARE_SWEEP_MS, TourCompare } from './TourCompare';
import { exitEditorTour, skipEditorTourAnimation, startEditorTour } from '@/shared/state/editorTourStore';

const LABELS = ['Frame', 'Qwen Image 2.1'] as const;
const BOX = { left: 100, width: 200 };
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

function renderCompare(sweep: boolean) {
  const view = render(<TourCompare labels={LABELS} sweep={sweep} />);
  const box = view.container.querySelector('[data-tour-compare]') as HTMLElement;
  vi.spyOn(box, 'getBoundingClientRect').mockReturnValue({ left: BOX.left, width: BOX.width, top: 0, height: 100, right: BOX.left + BOX.width, bottom: 100, x: BOX.left, y: 0, toJSON: () => ({}) });
  const slider = screen.getByRole('slider');
  const value = () => Number(slider.getAttribute('aria-valuenow'));
  const still = view.container.querySelector('[data-tour-compare-still]') as HTMLElement;
  const xAt = (percent: number) => BOX.left + (BOX.width * percent) / 100;
  return { ...view, box, slider, value, still, xAt };
}

beforeEach(() => {
  vi.useFakeTimers();
  startEditorTour();
});
afterEach(() => {
  exitEditorTour();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TourCompare', () => {
  it('without the sweep (reduced motion, Back) rests at once, still on the left and frame on the right', () => {
    const { value, still, slider } = renderCompare(false);
    expect(value()).toBe(COMPARE_REST);
    expect(still.style.clipPath).toBe(`inset(0 ${100 - COMPARE_REST}% 0 0)`);
    expect(still).toHaveTextContent(LABELS[1]);
    expect(still).not.toHaveTextContent(LABELS[0]);
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '100');
    expect(slider).toHaveAttribute('tabindex', '0');
    advance(COMPARE_SWEEP_DELAY_MS + COMPARE_SWEEP_MS);
    expect(value()).toBe(COMPARE_REST);
  });

  it('sweeps once from the left edge, moving only rightwards, and rests', () => {
    const { value } = renderCompare(true);
    expect(value()).toBe(0);
    advance(COMPARE_SWEEP_DELAY_MS - 50);
    expect(value()).toBe(0);
    const seen: number[] = [];
    for (let t = 0; t < COMPARE_SWEEP_MS + 200; t += 50) {
      advance(50);
      seen.push(value());
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.some((v) => v > 0 && v < COMPARE_REST)).toBe(true);
    expect(value()).toBe(COMPARE_REST);
  });

  it('yields to a grab mid-sweep without jumping, then follows the pointer', () => {
    const { box, value, xAt } = renderCompare(true);
    advance(COMPARE_SWEEP_DELAY_MS + COMPARE_SWEEP_MS / 2);
    const mid = value();
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(COMPARE_REST);
    // Grab a few px off the divider: it stays where it is.
    fireEvent.pointerDown(box, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: xAt(mid) + 4 });
    expect(value()).toBe(mid);
    advance(COMPARE_SWEEP_MS);
    expect(value()).toBe(mid);
    fireEvent.pointerMove(box, { pointerId: 1, pointerType: 'mouse', clientX: xAt(mid) + 4 + BOX.width * 0.1 });
    expect(value()).toBe(mid + 10);
    fireEvent.pointerUp(box, { pointerId: 1, pointerType: 'mouse' });
    advance(COMPARE_SWEEP_MS);
    expect(value()).toBe(mid + 10);
  });

  it('drags along the whole width by touch, clamped to the box', () => {
    const { box, value, xAt, still } = renderCompare(false);
    // A press away from the divider takes it to the press.
    fireEvent.pointerDown(box, { pointerId: 7, pointerType: 'touch', clientX: xAt(20) });
    expect(value()).toBe(20);
    fireEvent.pointerMove(box, { pointerId: 7, pointerType: 'touch', clientX: BOX.left - 80 });
    expect(value()).toBe(0);
    expect(still.style.clipPath).toBe('inset(0 100% 0 0)');
    fireEvent.pointerMove(box, { pointerId: 7, pointerType: 'touch', clientX: BOX.left + BOX.width + 80 });
    expect(value()).toBe(100);
    // Another pointer does not move it.
    fireEvent.pointerMove(box, { pointerId: 8, pointerType: 'touch', clientX: xAt(50) });
    expect(value()).toBe(100);
    fireEvent.pointerCancel(box, { pointerId: 7, pointerType: 'touch' });
    fireEvent.pointerMove(box, { pointerId: 7, pointerType: 'touch', clientX: xAt(50) });
    expect(value()).toBe(100);
  });

  it('ignores a right click, and stops selection and image drag', () => {
    const { box, value, xAt } = renderCompare(false);
    fireEvent.pointerDown(box, { pointerId: 1, pointerType: 'mouse', button: 2, clientX: xAt(10) });
    expect(value()).toBe(COMPARE_REST);
    expect(box).toHaveClass('select-none', 'cursor-col-resize');
    const down = fireEvent.pointerDown(box, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: xAt(10) });
    expect(down).toBe(false); // default prevented: no selection, no focus theft
    expect(fireEvent.dragStart(box)).toBe(false);
  });

  it('is keyboard-operable: arrows, Page Up/Down, Home and End, clamped', () => {
    const { slider, value } = renderCompare(false);
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(value()).toBe(COMPARE_REST + 5);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    fireEvent.keyDown(slider, { key: 'ArrowDown' });
    expect(value()).toBe(COMPARE_REST - 5);
    fireEvent.keyDown(slider, { key: 'PageUp' });
    expect(value()).toBe(COMPARE_REST + 15);
    fireEvent.keyDown(slider, { key: 'End' });
    expect(value()).toBe(100);
    fireEvent.keyDown(slider, { key: 'ArrowUp' });
    expect(value()).toBe(100);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(value()).toBe(0);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(value()).toBe(0);
    expect(slider).toHaveAttribute('aria-valuetext', `0% ${LABELS[1]}`);
    // Enter and Escape are the tour's: the handle lets them through.
    expect(fireEvent.keyDown(slider, { key: 'Enter' })).toBe(true);
    expect(slider).toHaveAttribute('data-editor-tour-keys', 'own');
  });

  it('a key mid-sweep takes the divider from where it is', () => {
    const { slider, value } = renderCompare(true);
    advance(COMPARE_SWEEP_DELAY_MS + COMPARE_SWEEP_MS / 3);
    const at = value();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(value()).toBe(Math.round(at + 5));
    advance(COMPARE_SWEEP_MS);
    expect(value()).toBe(Math.round(at + 5));
  });

  it('finishes the sweep at rest on a skip', () => {
    const { value } = renderCompare(true);
    advance(COMPARE_SWEEP_DELAY_MS + 100);
    expect(value()).toBeLessThan(COMPARE_REST);
    act(() => skipEditorTourAnimation());
    expect(value()).toBe(COMPARE_REST);
    advance(COMPARE_SWEEP_MS);
    expect(value()).toBe(COMPARE_REST);
  });

  it('keeps sweeping when the card settles on time (the prop drops), without a jump', () => {
    const { value, rerender } = renderCompare(true);
    advance(COMPARE_SWEEP_DELAY_MS + COMPARE_SWEEP_MS / 2);
    const mid = value();
    rerender(<TourCompare labels={LABELS} sweep={false} />);
    expect(value()).toBe(mid);
    advance(COMPARE_SWEEP_MS);
    expect(value()).toBe(COMPARE_REST);
  });
});

// @vitest-environment jsdom

import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOUR_ARRIVE_DELAY_MS, useCardMove } from './useCardMove';
import { TOUR_LEAVE_MS, TOUR_MOVE_MS } from './useSettledRects';

/** Natural sizes per step, as the browser would lay the cards out (jsdom has no layout). */
const NATURAL: Record<string, { width: number; height: number }> = { welcome: { width: 400, height: 230 }, compose: { width: 360, height: 147 } };

let seen: { arrivedKey: string | null; size: unknown } = { arrivedKey: null, size: null };

function Card({ step, animate, pending }: { step: string; animate: boolean; pending: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const { arrivedKey, size } = useCardMove(host, { key: step, animate, motion: true, pending });
  seen = { arrivedKey, size };
  return (
    <div ref={host} data-host>
      <section key={step} data-step={step}>
        <div data-editor-tour-card-content>{step}</div>
      </section>
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // Explicit inline sizes win, as in a browser; otherwise each element reports its step's natural size.
  const measure = (axis: 'width' | 'height') => function (this: HTMLElement) {
    const inline = parseFloat(this.style[axis]);
    if (!Number.isNaN(inline)) return inline;
    const step = (this.closest('[data-step]') as HTMLElement | null)?.dataset.step ?? (this.querySelector('[data-step]') as HTMLElement | null)?.dataset.step;
    return step ? NATURAL[step][axis] : 0;
  };
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(measure('width'));
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(measure('height'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const content = () => document.querySelector<HTMLElement>('[data-editor-tour-card-content]')!;
const section = () => document.querySelector<HTMLElement>('section')!;

describe('useCardMove', () => {
  it('shows the first card at once, arrived, at its own size', () => {
    render(<Card step="welcome" animate={false} pending={false} />);
    expect(seen).toEqual({ arrivedKey: 'welcome', size: { key: 'welcome', width: 400, height: 230 } });
  });

  it('lets the old content leave where it stands, then morphs the box from the old size while the new content waits to fade up', async () => {
    const view = render(<Card step="welcome" animate={false} pending={false} />);
    view.rerender(<Card step="welcome" animate={false} pending />);
    expect(content().style.opacity).toBe('0');
    expect(content().style.transition).toBe(`opacity ${TOUR_LEAVE_MS}ms ease-out`);

    view.rerender(<Card step="compose" animate pending={false} />);
    // The destination is known from the new card's own size, read before the morph starts.
    expect(seen.size).toEqual({ key: 'compose', width: 360, height: 147 });
    expect(seen.arrivedKey).toBe('welcome');
    expect(section().style.width).toBe('360px');
    expect(section().style.transition).toContain(`width ${TOUR_MOVE_MS}ms`);
    expect(section().style.overflow).toBe('hidden');
    expect(content().style.opacity).toBe('1');
    expect(content().style.transition).toContain(`${TOUR_ARRIVE_DELAY_MS}ms`);
    // Laid out at its final width throughout, so nothing re-wraps as the box grows or shrinks.
    expect(content().style.width).not.toBe('');

    await act(async () => { vi.advanceTimersByTime(TOUR_MOVE_MS); await Promise.resolve(); });
    expect(seen.arrivedKey).toBe('compose');
    expect(section().style.width).toBe('');
    expect(content().style.opacity).toBe('');
  });

  it('brings the content back if the store returns to the shown step before anything moved', () => {
    const view = render(<Card step="welcome" animate={false} pending={false} />);
    view.rerender(<Card step="welcome" animate={false} pending />);
    view.rerender(<Card step="welcome" animate={false} pending={false} />);
    expect(content().style.opacity).toBe('1');
    expect(seen.arrivedKey).toBe('welcome');
  });
});

describe('useCardMove unfolding a watch', () => {
  function Watch({ step, watching }: { step: string; watching: boolean }) {
    const host = useRef<HTMLDivElement>(null);
    const { arrivedKey, size } = useCardMove(host, { key: watching ? `${step}:watch` : step, animate: true, motion: true, pending: false });
    seen = { arrivedKey, size };
    return (
      <div ref={host} data-host>
        <section data-step={step}>
          <div data-editor-tour-card-content>
            <div>counter</div>
            <div data-editor-tour-card-rest data-folded={watching || undefined} style={watching ? { height: 0 } : undefined}>rest</div>
          </div>
        </section>
      </div>
    );
  }

  it('places the bar for the size the card will unfold to, then unfolds it in place: the counter row never fades', async () => {
    NATURAL.land = { width: 380, height: 54 };
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-editor-tour-card-rest') ? 409 : 0; });
    const view = render(<Watch step="land" watching />);
    expect(seen.size).toEqual({ key: 'land:watch', width: 380, height: 54 + 409 });

    NATURAL.land = { width: 380, height: 463 };
    view.rerender(<Watch step="land" watching={false} />);
    // Same size as it was placed for: nothing moves.
    expect(seen.size).toEqual({ key: 'land', width: 380, height: 463 });
    expect(section().style.height).toBe('463px');
    expect(section().style.transition).toContain(`height ${TOUR_MOVE_MS}ms`);
    expect(content().style.opacity).toBe('');
    const rest = document.querySelector<HTMLElement>('[data-editor-tour-card-rest]')!;
    expect(rest.style.opacity).toBe('1');
    expect(rest.style.transition).toContain('opacity');
    expect(seen.arrivedKey).not.toBe('land');
    await act(async () => { vi.advanceTimersByTime(TOUR_MOVE_MS); await Promise.resolve(); });
    expect(seen.arrivedKey).toBe('land');
    expect(section().style.height).toBe('');
  });
});

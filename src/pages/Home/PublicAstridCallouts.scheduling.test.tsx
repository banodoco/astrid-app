// @vitest-environment jsdom
import { useRef } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicAstridCallouts } from './PublicAstridCallouts';
import {
  CALLOUT_VACUUM_EXTEND_MS,
  CALLOUT_VACUUM_CANONICALIZE_MS,
  CALLOUT_VACUUM_PHONE_RETRACT_MS,
  CALLOUT_VACUUM_PHONE_EXTEND_MS,
  CALLOUT_VACUUM_POST_CONNECT_SETTLE_MS,
  CALLOUT_VACUUM_RECONNECT_STAGGER_MS,
  CALLOUT_VACUUM_RETRACT_MS,
  CALLOUT_VACUUM_RESIDUAL_RATIO,
  CALLOUT_VACUUM_SETTLE_MS,
} from './PublicAstridCalloutLayout';
import { usePublicAstridPlayerHeight } from './usePublicAstridPlayerHeight';

let frames: Map<number, FrameRequestCallback>;
let sequence: number;
let events: string[];
let resizeObservers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }>;
let mutationCallbacks: MutationCallback[];
let phone: boolean;
const originalResizeObserver = window.ResizeObserver;
const originalMutationObserver = window.MutationObserver;

function Stage({ active = true, beforeReveal = false, audience = 'app', reducedMotion = false, chatContent = true, chatAvailable = true, inspectorHidden = false }: { active?: boolean; beforeReveal?: boolean; audience?: 'app' | 'agent'; reducedMotion?: boolean; chatContent?: boolean; chatAvailable?: boolean; inspectorHidden?: boolean }) {
  const stage = useRef<HTMLDivElement>(null);
  usePublicAstridPlayerHeight(stage, active && beforeReveal);
  return <div ref={stage} data-testid="stage">
    <div className="astrid-editor-tilt"><div className="astrid-editor-surfaces">
      <div className="astrid-player-surface astrid-surface" />
      <div className="astrid-timeline-surface astrid-surface" />
      {chatAvailable && <div className="astrid-chat-surface astrid-surface">
        {chatContent && <>
        <div className="justify-end"><div className="rounded-2xl" /></div>
        <div className="justify-start"><div className="rounded-2xl" /></div>
        <div className="astrid-example-result" />
        </>}
      </div>}
      <div className="astrid-inspector-surface" data-test-inspector hidden={inspectorHidden}>
        <p>Select a clip to edit timing, position, audio, text, or effects.</p>
      </div>
    </div></div>
    <div className="astrid-preview-transport-outlet" />
    <button data-astrid-agent-launcher />
    {!beforeReveal && <PublicAstridCallouts stageRef={stage} audience={audience} reducedMotion={reducedMotion} active={active} />}
  </div>;
}
function paint() {
  const pending = [...frames.values()];
  frames.clear();
  act(() => pending.forEach((callback) => callback(performance.now())));
}
function settle() {
  for (let count = 0; frames.size && count < 200; count += 1) paint();
  expect(frames.size).toBe(0);
}

beforeEach(() => {
  frames = new Map(); sequence = 0; events = []; resizeObservers = []; mutationCallbacks = []; phone = false;
  class TestResizeObserver {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { resizeObservers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  }
  class TestMutationObserver {
    constructor(callback: MutationCallback) { mutationCallbacks.push(callback); }
    observe() {} disconnect() {}
  }
  // The shared jsdom setup installs these as writable, non-configurable window
  // properties, so assignment is the reversible override here.
  window.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  window.MutationObserver = TestMutationObserver as unknown as typeof MutationObserver;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.set(++sequence, callback); return sequence; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
    get matches() { return media.includes('640') && phone; }, media,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } as unknown as MediaQueryList));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    events.push('read');
    if (this.dataset.testid === 'stage' || this.classList.contains('astrid-callouts')) return new DOMRect(0, 0, 500, 500);
    if (this.closest('[data-test-inspector][hidden]')) return new DOMRect(0, 0, 0, 0);
    if (this.closest('[data-test-hidden-tablist]')) return new DOMRect(0, 0, 0, 0);
    return new DOMRect(100, 100, 100, 80);
  });
  for (const name of ['clientWidth', 'clientLeft', 'clientTop', 'offsetWidth'] as const) {
    vi.spyOn(HTMLElement.prototype, name, 'get').mockImplementation(() => { events.push('read'); return name.endsWith('Width') ? 100 : 0; });
  }
  const styleWrite = CSSStyleDeclaration.prototype.setProperty;
  vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty').mockImplementation(function (this: CSSStyleDeclaration, ...args) { events.push('write'); return styleWrite.apply(this, args); });
  const attributeWrite = Element.prototype.setAttribute;
  vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (this: Element, ...args) { events.push('write'); return attributeWrite.apply(this, args); });
});
afterEach(() => {
  cleanup();
  window.ResizeObserver = originalResizeObserver;
  window.MutationObserver = originalMutationObserver;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('bounded stage passes', () => {
  it('retracts every slot when its target is missing, then reconnects when that target arrives', () => {
    phone = true;
    const original = HTMLElement.prototype.animate;
    const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }) as unknown as Animation);
    HTMLElement.prototype.animate = animate;
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const view = render(<Stage chatAvailable={false} />);
      settle();
      const paths = [...view.container.querySelectorAll<SVGPathElement>('path')];
      const before = paths.map(path => path.getAttribute('d'));
      view.rerender(<Stage audience="agent" chatAvailable={false} />);
      now = 360;
      paint();
      expect(paths.every(path => path.getAttribute('d')?.startsWith('M'))).toBe(true);
      expect(paths.every((path, index) => path.getAttribute('d') !== before[index])).toBe(true);
      expect(paths.every(path => path.getAttribute('data-connector-target') === 'transition')).toBe(true);
      view.rerender(<Stage audience="agent" chatAvailable />);
      act(() => mutationCallbacks.at(-1)!([], {} as MutationObserver));
      now = 500;
      paint();
      expect(paths.every(path => path.getAttribute('d')?.startsWith('M'))).toBe(true);
      // Let the delayed third slot cross its scheduled gate before draining the
      // loop at a later fixed clock value.
      now = 640;
      paint();
      // The third slot starts 280ms after the first; advance past its natural
      // extension and settle window before draining the RAF loop.
      now = 1600;
      settle();
      expect(paths.map(path => path.getAttribute('data-connector-target'))).toEqual(['community', 'tools', 'workflows']);
      expect([...view.container.querySelectorAll<SVGCircleElement>('.astrid-callout-ping')]
        .every(ping => ping.getAttribute('data-astrid-reconnect-pulse') === 'true')).toBe(true);
    } finally { HTMLElement.prototype.animate = original; }
  });

  it.each([900, 1600])('extends after destination card geometry settles, before content arriving at %sms', (arrivalAt) => {
    phone = true;
    const original = HTMLElement.prototype.animate;
    const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }) as unknown as Animation);
    HTMLElement.prototype.animate = animate;
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const view = render(<Stage chatContent={false} />);
      settle();
      view.rerender(<Stage audience="agent" chatContent={false} />);
      const path = view.container.querySelector('path[data-callout="community"]')!;
      // The destination card geometry is already final in this harness. The connector must
      // still honor its retraction floor before it starts extending, independent of chat content.
      now = 239;
      paint();
      const heldPath = path.getAttribute('d');
      expect(heldPath).toMatch(/^M/);
      now = 360;
      paint();
      now = 460;
      paint();
      expect(path.getAttribute('d')).not.toBe(heldPath);
      expect(view.container.querySelector('.justify-end')).toBeNull();
      now = arrivalAt;
      paint();
      const beforeArrival = path.getAttribute('d');
      if (arrivalAt > 1240) {
        now = 2600;
        settle();
        expect(path.getAttribute('data-connector-target')).toBe('community');
      }
      view.rerender(<Stage audience="agent" />);
      const message = view.container.querySelector<HTMLElement>('.justify-start > .rounded-2xl')!;
      let targetWidth = 40;
      Object.defineProperty(message, 'getBoundingClientRect', { value: () => new DOMRect(130, 120, targetWidth, 30), configurable: true });
      act(() => mutationCallbacks.at(-1)!([], {} as MutationObserver));
      paint();
      expect(path.getAttribute('d')).not.toBe(beforeArrival);
      expect(animate).toHaveBeenCalledTimes(9);
      now = 1700;
      settle();
      const endpoint = view.container.querySelector('.astrid-callout-dot-end[data-callout="community"]')!;
      // Phones land on the left edge of Astrid's reply, so the endpoint holds while the bubble widens.
      expect(Number(endpoint.getAttribute('cx'))).toBe(130);
      targetWidth = 55;
      act(() => resizeObservers.at(-1)!.callback([], resizeObservers.at(-1)! as unknown as ResizeObserver));
      settle();
      expect(Number(endpoint.getAttribute('cx'))).toBe(130);
      expect(path.getAttribute('data-connector-target')).toBe('community');
    } finally { HTMLElement.prototype.animate = original; }
  });

  it.each([false, true])('reconnects after retract plus settled card geometry, before card animation finish (phone=%s)', (isPhone) => {
    phone = isPhone;
    const original = HTMLElement.prototype.animate;
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel, onfinish: null }) as unknown as Animation);
    HTMLElement.prototype.animate = animate;
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const view = render(<Stage />);
      settle();
      const cards = [...view.container.querySelectorAll('article')];
      const paths = [...view.container.querySelectorAll('path')];
      const oldPath = paths[0].getAttribute('d');
      view.rerender(<Stage audience="agent" />);
      const stage = view.getByTestId('stage');
      const sample = () => { fireEvent.transitionRun(stage); paint(); };
      expect([...view.container.querySelectorAll('article')]).toEqual(cards);
      expect([...view.container.querySelectorAll('path')]).toEqual(paths);
      expect(animate).toHaveBeenCalledTimes(9);
      expect(animate).toHaveBeenCalledWith([{opacity: 0, translate: '0 4px'}, {opacity: 1, translate: '0 0'}], expect.objectContaining({duration: 720}));
      expect(view.container.querySelectorAll('article > .astrid-callout-outgoing')).toHaveLength(3);
      sample();
      expect(paths[0].getAttribute('data-connector-target')).toBe('transition');
      // The first draw must preserve the exact synchronously primed curve; its
      // endpoint can retain the old x coordinate when the contraction is vertical.
      expect(paths[0].getAttribute('d')).not.toBe(oldPath);
      const retractUntil = isPhone ? CALLOUT_VACUUM_PHONE_RETRACT_MS : CALLOUT_VACUUM_RETRACT_MS;
      now += 60;
      sample();
      expect(paths[0].getAttribute('d')).not.toBe(oldPath);
      now = 1000 + retractUntil - 1;
      sample();
      const heldPath = paths[0].getAttribute('d');
      expect(heldPath).toMatch(/^M/);
      now += 250;
      sample();
      now += 100;
      sample();
      expect(paths[0].getAttribute('d')).not.toBe(heldPath);
      expect(paths[0].getAttribute('data-connector-target')).toBe('transition');
      expect(view.container.querySelector('[data-layout-moving]')).not.toBeNull();
      now += 1200;
      settle();
      expect(paths[0].getAttribute('data-connector-target')).toBe('community');
      expect([...view.container.querySelectorAll<SVGCircleElement>('.astrid-callout-ping')]
        .every(ping => ping.getAttribute('data-astrid-reconnect-pulse') === 'true')).toBe(true);
      view.rerender(<Stage audience="app" />);
      expect(cancel).toHaveBeenCalledTimes(9);
      expect([...view.container.querySelectorAll<SVGCircleElement>('.astrid-callout-ping')]
        .every(ping => ping.getAttribute('data-astrid-reconnect-pulse') === null)).toBe(true);
      view.rerender(<Stage audience="agent" reducedMotion />);
      expect(cancel).toHaveBeenCalledTimes(18);
      expect(animate).toHaveBeenCalledTimes(18);
      settle();
      expect(view.container.querySelector('[data-layout-moving]')).toBeNull();
      expect(view.container.querySelector('.astrid-callout-outgoing')).toBeNull();
    } finally { HTMLElement.prototype.animate = original; }
  });

  it('holds a visible fifth-length residual before Agent extension', () => {
    phone = false;
    const original = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }) as unknown as Animation);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const view = render(<Stage />);
      settle();
      view.rerender(<Stage audience="agent" />);
      const start = view.container.querySelector<SVGCircleElement>('.astrid-callout-dot-start')!;
      const end = view.container.querySelector<SVGCircleElement>('.astrid-callout-dot-end')!;
      const distance = () => Math.hypot(
        Number(end.getAttribute('cx')) - Number(start.getAttribute('cx')),
        Number(end.getAttribute('cy')) - Number(start.getAttribute('cy')),
      );
      now = 1000 + CALLOUT_VACUUM_RETRACT_MS - 1;
      paint();
      const residual = distance();
      // In the fixed-clock harness the destination cards are already settled,
      // so slot zero opens exactly at the retract boundary. Sample that gate
      // rather than stepping 250ms into its scheduled extension.
      now += 1;
      paint();
      expect(distance()).toBeCloseTo(residual, 1);
      now = 1000 + CALLOUT_VACUUM_RETRACT_MS + 2 * CALLOUT_VACUUM_RECONNECT_STAGGER_MS + 1;
      paint();
      now += 1200;
      settle();
      const settled = distance();
      expect(residual / settled).toBeCloseTo(CALLOUT_VACUUM_RESIDUAL_RATIO, 1);
    } finally { HTMLElement.prototype.animate = original; }
  });

  it.each([false, true])('uses the natural Agent reattachment duration after the geometry gate (phone=%s)', (isPhone) => {
    phone = isPhone;
    const original = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }) as unknown as Animation);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const view = render(<Stage />);
      settle();
      view.rerender(<Stage audience="agent" />);
      const firstCallout = 'community';
      const path = view.container.querySelector(`path[data-callout="${firstCallout}"]`)!;
      const ping = view.container.querySelector<SVGCircleElement>(`circle[data-callout-ping="${firstCallout}"]`)!;
      const retractUntil = isPhone ? CALLOUT_VACUUM_PHONE_RETRACT_MS : CALLOUT_VACUUM_RETRACT_MS;
      const baseDuration = isPhone ? CALLOUT_VACUUM_PHONE_EXTEND_MS : CALLOUT_VACUUM_EXTEND_MS;
      now = 1000 + retractUntil;
      paint();
      expect(path.getAttribute('data-connector-target')).toBe('transition');
      expect(ping.getAttribute('data-astrid-reconnect-pulse')).toBeNull();
      now += baseDuration - 1;
      paint();
      expect(ping.getAttribute('data-astrid-reconnect-pulse')).toBeNull();
      now += CALLOUT_VACUUM_SETTLE_MS + 1;
      paint();
      expect(path.getAttribute('data-connector-target')).toBe(firstCallout);
      expect(ping.getAttribute('data-astrid-reconnect-pulse')).toBe('true');
    } finally { HTMLElement.prototype.animate = original; }
  });

  it.each([false, true])('keeps a finite organic settle after each reconnect (phone=%s)', (isPhone) => {
    phone = isPhone;
    const original = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }) as unknown as Animation);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const view = render(<Stage />);
      settle();
      view.rerender(<Stage audience="agent" />);
      const firstCallout = 'community';
      const path = view.container.querySelector<SVGPathElement>(`path[data-callout="${firstCallout}"]`)!;
      const retractUntil = isPhone ? CALLOUT_VACUUM_PHONE_RETRACT_MS : CALLOUT_VACUUM_RETRACT_MS;
      const extendDuration = isPhone ? CALLOUT_VACUUM_PHONE_EXTEND_MS : CALLOUT_VACUUM_EXTEND_MS;
      for (const index of [0, 1, 2]) {
        now = 1000 + retractUntil + index * CALLOUT_VACUUM_RECONNECT_STAGGER_MS + 1;
        paint();
      }
      now = 1000 + retractUntil + extendDuration + 1;
      paint();
      const atExtensionEnd = path.getAttribute('d');
      expect(view.container.querySelector<SVGCircleElement>(`circle[data-callout-ping="${firstCallout}"]`)
        ?.getAttribute('data-astrid-reconnect-pulse')).toBe('true');
      now += CALLOUT_VACUUM_SETTLE_MS + CALLOUT_VACUUM_POST_CONNECT_SETTLE_MS / 2;
      paint();
      const duringSettle = path.getAttribute('d');
      expect(duringSettle).not.toBe(atExtensionEnd);
      now = 1000 + retractUntil + 2 * CALLOUT_VACUUM_RECONNECT_STAGGER_MS
        + extendDuration + CALLOUT_VACUUM_SETTLE_MS + CALLOUT_VACUUM_POST_CONNECT_SETTLE_MS
        + CALLOUT_VACUUM_CANONICALIZE_MS + 1;
      settle();
      const settled = path.getAttribute('d');
      expect(settled).not.toBe(duringSettle);
      expect(path.getAttribute('data-connector-target')).toBe(firstCallout);
    } finally { HTMLElement.prototype.animate = original; }
  });

  it.each([false, true])('canonicalizes controls before clearing the transition (phone=%s)', (isPhone) => {
    phone = isPhone;
    const original = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }) as unknown as Animation);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const view = render(<Stage />);
      settle();
      view.rerender(<Stage audience="agent" />);
      const firstCallout = 'community';
      const path = view.container.querySelector<SVGPathElement>(`path[data-callout="${firstCallout}"]`)!;
      const start = view.container.querySelector<SVGCircleElement>(`.astrid-callout-dot-start[data-callout="${firstCallout}"]`)!;
      const end = view.container.querySelector<SVGCircleElement>(`.astrid-callout-dot-end[data-callout="${firstCallout}"]`)!;
      const retractUntil = isPhone ? CALLOUT_VACUUM_PHONE_RETRACT_MS : CALLOUT_VACUUM_RETRACT_MS;
      const extendDuration = isPhone ? CALLOUT_VACUUM_PHONE_EXTEND_MS : CALLOUT_VACUUM_EXTEND_MS;
      const postSettleAt = 1000 + retractUntil + extendDuration + CALLOUT_VACUUM_SETTLE_MS + CALLOUT_VACUUM_POST_CONNECT_SETTLE_MS;
      // Establish every slot's extension clock before sampling the terminal
      // phase; otherwise a deliberately late test frame would redefine a
      // staggered extension start instead of exercising canonicalization.
      for (const index of [0, 1, 2]) {
        now = 1000 + retractUntil + index * CALLOUT_VACUUM_RECONNECT_STAGGER_MS + 1;
        paint();
      }
      now = postSettleAt - 1;
      paint();
      const beforeCanonicalization = path.getAttribute('d');
      now = postSettleAt + CALLOUT_VACUUM_CANONICALIZE_MS / 2;
      paint();
      expect(path.getAttribute('d')).not.toBe(beforeCanonicalization);
      now = postSettleAt + CALLOUT_VACUUM_CANONICALIZE_MS + 1;
      paint();
      const canonical = path.getAttribute('d');
      const numbers = (canonical?.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      expect(numbers).toHaveLength(8);
      expect(numbers[0]).toBe(Number(start.getAttribute('cx')));
      expect(numbers[1]).toBe(Number(start.getAttribute('cy')));
      expect(numbers[6]).toBe(Number(end.getAttribute('cx')));
      expect(numbers[7]).toBe(Number(end.getAttribute('cy')));
      now += 1;
      paint();
      expect(path.getAttribute('d')).toBe(canonical);

      now = 1000 + retractUntil + 2 * CALLOUT_VACUUM_RECONNECT_STAGGER_MS
        + extendDuration + CALLOUT_VACUUM_SETTLE_MS + CALLOUT_VACUUM_POST_CONNECT_SETTLE_MS
        + CALLOUT_VACUUM_CANONICALIZE_MS + 1;
      settle();
      const settled = path.getAttribute('d');
      expect(frames.size).toBe(0);
      paint();
      expect(path.getAttribute('d')).toBe(settled);
    } finally { HTMLElement.prototype.animate = original; }
  });

  it.each([
    [false, 'agent', ['community', 'tools', 'workflows']],
    [true, 'agent', ['community', 'tools', 'workflows']],
    [false, 'app', ['timeline', 'effects', 'models']],
    [true, 'app', ['effects', 'timeline', 'models']],
  ] as const)('staggers reconnect pulses in the %s %s introduction order', (isPhone, audience, order) => {
    phone = isPhone;
    const original = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }) as unknown as Animation);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const source = audience === 'agent' ? 'app' : 'agent';
      const view = render(<Stage audience={source} />);
      settle();
      view.rerender(<Stage audience={audience} />);
      const retractUntil = isPhone ? CALLOUT_VACUUM_PHONE_RETRACT_MS : CALLOUT_VACUUM_RETRACT_MS;
      const extendDuration = isPhone ? CALLOUT_VACUUM_PHONE_EXTEND_MS : CALLOUT_VACUUM_EXTEND_MS;
      // Paint each scheduled start first. This mirrors the live RAF clock and
      // ensures a paused frame cannot make all slots begin at the same timestamp.
      for (const index of order.keys()) {
        now = 1000 + retractUntil + index * CALLOUT_VACUUM_RECONNECT_STAGGER_MS + 1;
        paint();
      }
      for (const [index, id] of order.entries()) {
        now = 1000 + retractUntil + index * CALLOUT_VACUUM_RECONNECT_STAGGER_MS + extendDuration + 1;
        paint();
        const pulses = order.map(callout => view.container
          .querySelector<SVGCircleElement>(`circle[data-callout-ping="${callout}"]`)
          ?.getAttribute('data-astrid-reconnect-pulse') === 'true');
        expect(pulses.slice(0, index + 1).every(Boolean)).toBe(true);
        expect(pulses.slice(index + 1).every(pulsed => !pulsed)).toBe(true);
        expect(view.container.querySelector(`path[data-callout="${id}"]`)
          ?.getAttribute('data-connector-target')).toBe('transition');
      }
    } finally { HTMLElement.prototype.animate = original; }
  });

  it('has every App-to-Agent connector visibly retracted at the 320ms checkpoint', () => {
    phone = false;
    const original = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }) as unknown as Animation);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const view = render(<Stage />);
      settle();
      const paths = [...view.container.querySelectorAll<SVGPathElement>('path')];
      const before = paths.map(path => path.getAttribute('d'));
      view.rerender(<Stage audience="agent" />);
      now = 1320;
      paint();
      expect(paths.every(path => path.getAttribute('data-connector-target') === 'transition')).toBe(true);
      expect(paths.every((path, index) => path.getAttribute('d') !== before[index])).toBe(true);
    } finally { HTMLElement.prototype.animate = original; }
  });

  it.each([
    ['app', ['timeline', 'effects', 'models']],
    ['agent', ['community', 'tools', 'workflows']],
  ] as const)('presents %s cards in narrative order with overlapping entrance turns', (audience, order) => {
    const view = render(<Stage audience={audience} />);
    const cards = [...view.container.querySelectorAll<HTMLElement>('article.astrid-callout')];
    expect(cards.map(card => card.dataset.callout)).toEqual(order);
    const milliseconds = (element: HTMLElement | SVGElement, name: string) => parseFloat(element.style.getPropertyValue(`--astrid-${name}`));
    // Cards enter as a short sequence while connector drawing follows each card's settle.
    expect(milliseconds(cards[0], 'callout-start')).toBe(120);
    expect(milliseconds(cards[2], 'endpoint-start') + milliseconds(cards[2], 'endpoint-duration')).toBe(1900);
    for (const [index, card] of cards.entries()) {
      const group = view.container.querySelector<SVGElement>(`g:has(path[data-callout="${card.dataset.callout}"])`)!;
      expect(group.getAttribute('style')).toBe(card.getAttribute('style'));
      const start = milliseconds(card, 'callout-start');
      const lineStart = milliseconds(card, 'connector-start');
      const endStart = milliseconds(card, 'endpoint-start');
      expect(milliseconds(card, 'card-duration')).toBeGreaterThanOrEqual(350);
      expect(milliseconds(card, 'connector-duration')).toBeGreaterThanOrEqual(200);
      expect(lineStart).toBeGreaterThanOrEqual(start + 250);
      expect(endStart).toBeGreaterThanOrEqual(lineStart + milliseconds(card, 'connector-duration'));
      if (cards[index + 1]) {
        expect(milliseconds(cards[index + 1], 'callout-start') - start).toBe(360);
        expect(milliseconds(cards[index + 1], 'callout-start')).toBeLessThan(endStart + milliseconds(card, 'endpoint-duration'));
      }
    }
  });

  it.each([false, true])('connects to the centre of the empty Inspector card when visible (phone: %s)', (isPhone) => {
    phone = isPhone;
    const view = render(<Stage inspectorHidden />);
    settle();
    const path = view.container.querySelector<SVGPathElement>('path[data-callout="effects"]')!;
    const inspectorCard = view.container.querySelector<HTMLElement>('.astrid-inspector-surface')!;
    expect(path.getAttribute('data-connector-target')).toBeNull();
    expect(resizeObservers.some(observer => observer.targets.has(inspectorCard))).toBe(true);

    view.rerender(<Stage />);
    act(() => resizeObservers
      .filter(observer => observer.targets.has(inspectorCard))
      .forEach(observer => observer.callback([{ target: inspectorCard, contentRect: new DOMRect(100, 100, 100, 80) } as ResizeObserverEntry], observer as unknown as ResizeObserver)));
    expect(frames.size).toBeGreaterThan(0);
    paint();

    expect(path.getAttribute('data-connector-target')).toBe('effects');
    settle();
    const endpoint = view.container.querySelector('.astrid-callout-dot-end[data-callout="effects"]')!;
    // With no clip selected there is no Effects tab for the phone connector, so it uses the card too.
    expect(Number(endpoint.getAttribute('cx'))).toBe(150);
    expect(Number(endpoint.getAttribute('cy'))).toBe(140);
    expect(frames.size).toBe(0);
  });

  it('reads all callout/stage boxes before writes and stops after stable scroll/resize bursts', () => {
    const view = render(<Stage />);
    events = [];
    paint();
    // The first layout pass now paints synchronously in the layout effect so the
    // committed audience cannot expose a stale connector for one frame. A queued
    // follow-up may therefore be read-only; when it writes, reads still come first.
    const firstWrite = events.indexOf('write');
    expect(firstWrite === -1 || events.lastIndexOf('read') < firstWrite).toBe(true);
    settle();
    const stage = view.getByTestId('stage');
    expect(stage.style.getPropertyValue('--astrid-player-height')).toBe('39.375px');
    expect(stage.querySelector('path')!.getAttribute('d')).toMatch(/^M/);
    events = [];
    fireEvent.scroll(stage);
    fireEvent.scroll(window);
    fireEvent.resize(window);
    expect(frames.size).toBe(1);
    paint();
    expect(events).toContain('read');
    expect(events).not.toContain('write');
    expect(frames.size).toBe(0);
  });

  it('follows pointer easing then stops, and rejects retained-page frames/observer callbacks', () => {
    const view = render(<Stage />);
    settle();
    const stage = view.getByTestId('stage');
    const pointer = new MouseEvent('pointermove', { bubbles: true, clientX: 400, clientY: 350 });
    Object.defineProperty(pointer, 'pointerType', { value: 'mouse' });
    fireEvent(stage, pointer);
    expect(frames.size).toBe(1);
    events = [];
    paint();
    expect(events.lastIndexOf('read')).toBeLessThan(events.indexOf('write'));
    settle();
    expect(stage.querySelector<HTMLElement>('.astrid-editor-tilt')!.style.transform).toContain('rotateX(-1.600deg)');
    fireEvent.resize(window);
    const stale = [...frames.values()];
    const staleResize = resizeObservers[0]!.callback;
    const staleMutation = mutationCallbacks[0];
    view.rerender(<Stage active={false} />);
    events = [];
    act(() => { stale.forEach((callback) => callback(performance.now())); staleResize([], {} as ResizeObserver); staleMutation([], {} as MutationObserver); });
    fireEvent.resize(window);
    fireEvent.scroll(window);
    expect(events).toEqual([]);
    expect(frames.size).toBe(0);
  });

  it('coalesces pre-reveal player sizing, handles the phone breakpoint, and rejects stale callbacks', () => {
    const view = render(<Stage beforeReveal />);
    events = [];
    fireEvent.resize(window);
    fireEvent.resize(window);
    expect(frames.size).toBe(1);
    paint();
    expect(events.lastIndexOf('read')).toBeLessThan(events.indexOf('write'));
    expect(frames.size).toBe(0);
    phone = true;
    fireEvent.resize(window);
    paint();
    expect(view.getByTestId('stage').style.getPropertyValue('--astrid-player-height')).toBe('');
    fireEvent.resize(window);
    const stale = [...frames.values()];
    const observer = resizeObservers[0]!.callback;
    view.unmount();
    events = [];
    act(() => { stale.forEach((callback) => callback(performance.now())); observer([], {} as ResizeObserver); });
    expect(events).toEqual([]);
    expect(frames.size).toBe(0);
  });
});

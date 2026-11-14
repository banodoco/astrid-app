// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicAstridSky } from './PublicAstridSky';
import { createPublicAstridSkySession } from './publicAstridSkySession';

let frames: Map<number, FrameRequestCallback>;
let sequence: number;
const contexts = new Map<HTMLCanvasElement, { createImageData: ReturnType<typeof vi.fn>; putImageData: ReturnType<typeof vi.fn> }>();

function paint() {
  const pending = [...frames.values()];
  frames.clear();
  act(() => pending.forEach((callback) => callback(performance.now())));
}
function settle() {
  for (let count = 0; frames.size && count < 250; count += 1) paint();
  expect(frames.size).toBe(0);
}
function session() {
  const value = createPublicAstridSkySession({ environment: { visible: true, reducedMotion: true, phone: false }, now: () => Date.UTC(2026, 9, 6, 12) });
  value.mount();
  value.setManualHours(1);
  value.setEnvironment({ visible: true, reducedMotion: false, phone: false });
  return value;
}
function root() {
  const element = document.createElement('main');
  const reading = document.createElement('p');
  reading.className = 'reading';
  reading.textContent = 'Reading';
  element.append(reading);
  document.body.append(element);
  return { current: element, read: vi.spyOn(reading, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 12, 8)) };
}

beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map();
  sequence = 0;
  contexts.clear();
  vi.stubGlobal('innerWidth', 100);
  vi.stubGlobal('innerHeight', 60);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.set(++sequence, callback); return sequence; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    if (!contexts.has(this)) contexts.set(this, {
      createImageData: vi.fn((width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })),
      putImageData: vi.fn(),
    });
    return contexts.get(this) as unknown as CanvasRenderingContext2D;
  });
});
afterEach(() => {
  cleanup();
  document.querySelectorAll('main').forEach((element) => element.remove());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('active sky scheduling', () => {
  it('coalesces raster bursts and makes parallax-only updates without any raster writes or allocations', () => {
    const owner = session();
    const geometry = root();
    const view = render(<PublicAstridSky session={owner} geometryRoot={geometry} quietBehind=".reading" />);
    settle();
    const raster = vi.spyOn(owner.renderer, 'paint');
    act(() => { owner.setManualHours(2); owner.setManualHours(3); owner.setManualHours(4); });
    expect(frames.size).toBe(1);
    settle();
    expect(raster).toHaveBeenCalledTimes(1);
    raster.mockClear();
    contexts.forEach((context) => { context.putImageData.mockClear(); context.createImageData.mockClear(); });
    const before = view.container.querySelector('canvas')!.style.transform;
    const event = new MouseEvent('pointermove', { clientX: 90, clientY: 20 });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    act(() => window.dispatchEvent(event));
    settle();
    expect(view.container.querySelector('canvas')!.style.transform).not.toBe(before);
    expect(raster).not.toHaveBeenCalled();
    contexts.forEach((context) => { expect(context.putImageData).not.toHaveBeenCalled(); expect(context.createImageData).not.toHaveBeenCalled(); });
    view.unmount();
    owner.destroy();
  });

  it('keeps retained Home quiet while Vision owns geometry and rejects a queued Home resize', () => {
    const owner = session();
    const home = root();
    const vision = root();
    const pages = (atHome: boolean) => <>
      <section data-page="home"><PublicAstridSky session={owner} active={atHome} geometryRoot={home} geometryOwner="home" quietBehind=".reading" /></section>
      <section data-page="vision"><PublicAstridSky session={owner} active={!atHome} geometryRoot={vision} geometryOwner="vision" quietBehind=".reading" /></section>
    </>;
    const view = render(pages(true));
    settle();
    act(() => window.dispatchEvent(new Event('resize')));
    const stale = [...frames.values()];
    view.rerender(pages(false));
    settle();
    home.read.mockClear();
    const homeCanvases = [...view.container.querySelectorAll<HTMLCanvasElement>('[data-page="home"] canvas')];
    homeCanvases.forEach((canvas) => contexts.get(canvas)!.putImageData.mockClear());
    act(() => {
      stale.forEach((callback) => callback(performance.now()));
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
      owner.setManualHours(5);
    });
    settle();
    expect(owner.getGeometrySnapshot().owner).toBe('vision');
    expect(owner.getGeometrySnapshot().root).toBe(vision.current);
    expect(home.read).not.toHaveBeenCalled();
    homeCanvases.forEach((canvas) => expect(contexts.get(canvas)!.putImageData).not.toHaveBeenCalled());
    view.unmount();
    expect(frames.size).toBe(0);
    expect(owner.getGeometrySnapshot().owner).toBeNull();
    owner.destroy();
  });

  it('rejects queued resize/idle work after unmount and releases subscriptions', () => {
    const owner = session();
    const raster = vi.spyOn(owner.renderer, 'paint');
    const warm = vi.spyOn(owner.renderer, 'prepareMoon');
    const view = render(<PublicAstridSky session={owner} />);
    settle();
    act(() => window.dispatchEvent(new Event('resize')));
    const stale = [...frames.values()];
    view.unmount();
    raster.mockClear();
    act(() => { stale.forEach((callback) => callback(performance.now())); owner.setManualHours(3); vi.advanceTimersByTime(500); });
    expect(raster).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    owner.destroy();
  });
});


it('holds mobile sky raster dimensions through toolbar resizes but follows orientation changes', () => {
  const owner = session();
  owner.setEnvironment({ visible: true, reducedMotion: true, phone: true });
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
    media, matches: media === '(pointer: coarse)', onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => true,
  }));
  let largeHeight = 844;
  const originalHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')?.get;
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('astrid-sky-viewport') ? largeHeight : originalHeight?.call(this) ?? 0;
  });
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('innerHeight', 700);
  const view = render(<PublicAstridSky session={owner} />);
  settle();
  const sizes = () => [...view.container.querySelectorAll('canvas')].map(canvas => [canvas.width, canvas.height]);
  const initial = sizes();
  for (const height of [630, 790, 700]) {
    vi.stubGlobal('innerHeight', height);
    act(() => window.dispatchEvent(new Event('resize')));
    settle();
    expect(sizes()).toEqual(initial);
  }
  largeHeight = 390;
  vi.stubGlobal('innerWidth', 844);
  vi.stubGlobal('innerHeight', 390);
  act(() => window.dispatchEvent(new Event('resize')));
  settle();
  expect(sizes()).not.toEqual(initial);
  view.unmount();
  expect(frames.size).toBe(0);
  owner.destroy();
});

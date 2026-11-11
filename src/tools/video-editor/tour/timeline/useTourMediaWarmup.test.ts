import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { exitEditorTour, setEditorTourBeat, startEditorTour } from '@/shared/state/editorTourStore.ts';
import { EDITOR_TOUR_MEDIA } from '../tourMedia.ts';
import { useTourMediaWarmup } from './useTourMediaWarmup.ts';

beforeEach(() => startEditorTour());
afterEach(() => { exitEditorTour(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup(saveData = false) {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData } });
  const images: HTMLImageElement[] = [];
  const decode = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('Image', class {
    constructor() { const image = document.createElement('img'); image.decode = decode; images.push(image); return image; }
  });
  const loads: HTMLMediaElement[] = [];
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function () { loads.push(this); });
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  const paint = () => act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(performance.now()));
  });
  return { images, decode, loads, pause, paint };
}

afterEach(() => { delete (navigator as Navigator & { connection?: unknown }).connection; });

it('yields first paint, decodes the next guide frame first, then warms remaining images and buffers the guide clip once', async () => {
  const { images, decode, loads, pause, paint } = setup();
  let decoded!: () => void;
  decode.mockImplementationOnce(() => new Promise<void>(resolve => { decoded = resolve; }));
  const view = renderHook(useTourMediaWarmup);
  expect(images).toHaveLength(0);
  paint();
  expect(images).toHaveLength(0);
  paint();
  expect(images.map(image => image.getAttribute('src'))).toEqual([EDITOR_TOUR_MEDIA.frames[0].url]);
  expect(loads).toHaveLength(0);
  await act(async () => decoded());
  await waitFor(() => expect(decode).toHaveBeenCalledTimes(6));
  expect(images.map(image => image.getAttribute('src'))).toEqual([
    EDITOR_TOUR_MEDIA.frames[0], ...EDITOR_TOUR_MEDIA.stills, EDITOR_TOUR_MEDIA.frames[1],
  ].map(slot => slot.url));
  const video = loads[0];
  // Act 1's clip is the guide video; the H3 clip is not buffered until act 2.
  expect(video.getAttribute('src')).toBe(EDITOR_TOUR_MEDIA.guide.url);
  expect(video.preload).toBe('auto');
  expect(video.paused).toBe(true);
  view.rerender();
  expect(loads).toHaveLength(1);
  view.unmount();
  expect(images.every(image => !image.hasAttribute('src'))).toBe(true);
  expect(video.hasAttribute('src')).toBe(false);
  expect(pause).toHaveBeenCalledTimes(1);
  expect(loads).toEqual([video, video]);
});

it('limits Save Data to the current act and upgrades video metadata to buffering when needed', async () => {
  const { images, loads, paint } = setup(true);
  const view = renderHook(useTourMediaWarmup);
  paint(); paint();
  await act(async () => {});
  expect(images).toHaveLength(1);
  expect(loads).toHaveLength(0);
  act(() => setEditorTourBeat(2, 'compose'));
  await waitFor(() => expect(images).toHaveLength(5));
  expect(loads).toHaveLength(1);
  expect(loads[0].preload).toBe('metadata');
  expect(loads[0].getAttribute('src')).toBe(EDITOR_TOUR_MEDIA.video.url);
  act(() => setEditorTourBeat(3, 'compose'));
  await waitFor(() => expect(loads).toHaveLength(2));
  expect(loads[0]).toBe(loads[1]);
  expect(loads[1].preload).toBe('auto');
  view.unmount();
});

it('continues after an image decode fails and cancels remaining work on exit', async () => {
  const { images, decode, loads, paint } = setup();
  decode.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise(() => {}));
  const view = renderHook(useTourMediaWarmup);
  paint(); paint();
  await waitFor(() => expect(images).toHaveLength(2));
  expect(loads).toHaveLength(1);
  view.unmount();
  expect(images.every(image => !image.hasAttribute('src'))).toBe(true);
});

it('does no speculative work when unmounted before first paint', () => {
  const { images, loads, paint } = setup();
  const view = renderHook(useTourMediaWarmup);
  view.unmount();
  paint(); paint();
  expect(images).toHaveLength(0);
  expect(loads).toHaveLength(0);
});

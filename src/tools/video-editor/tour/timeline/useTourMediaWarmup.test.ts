// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { exitEditorTour, setEditorTourBeat, startEditorTour } from '@/shared/state/editorTourStore.ts';
import { EDITOR_TOUR_MEDIA } from '../tourMedia.ts';
import { tourWarmupPictures, useTourMediaWarmup } from './useTourMediaWarmup.ts';

beforeEach(() => startEditorTour());
afterEach(() => { exitEditorTour(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  const images: HTMLImageElement[] = [];
  const decode = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('Image', class {
    constructor() { const image = document.createElement('img'); image.decode = decode; images.push(image); return image; }
  });
  const paint = () => act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(performance.now()));
  });
  return { images, decode, paint };
}

const sources = (images: HTMLImageElement[]) => images.map(image => image.getAttribute('src'));
const guidePoster = EDITOR_TOUR_MEDIA.guide.displayUrl;
const stills = EDITOR_TOUR_MEDIA.stills.map(still => still.displayUrl);

it('warms only small display derivatives, never an original', () => {
  const originals = [...EDITOR_TOUR_MEDIA.frames, ...EDITOR_TOUR_MEDIA.stills, EDITOR_TOUR_MEDIA.video, EDITOR_TOUR_MEDIA.guide].map(slot => slot.url);
  for (const act of [1, 2, 3]) for (const landed of [false, true]) {
    const urls = tourWarmupPictures(act, landed);
    expect(urls.every(url => url.endsWith('.webp'))).toBe(true);
    expect(urls.some(url => originals.includes(url))).toBe(false);
  }
  expect(tourWarmupPictures(1, false)).toEqual([guidePoster]);
  expect(tourWarmupPictures(1, true)).toEqual([guidePoster, ...stills]);
  expect(tourWarmupPictures(2, false)).toEqual([guidePoster, ...stills, EDITOR_TOUR_MEDIA.video.displayUrl]);
});

it('yields first paint, then decodes step 1\'s poster alone until step 1 has landed', async () => {
  const { images, decode, paint } = setup();
  const view = renderHook(useTourMediaWarmup);
  expect(view.result.current).toBe(false);
  paint();
  expect(images).toHaveLength(0);
  paint();
  expect(view.result.current).toBe(true);
  expect(sources(images)).toEqual([guidePoster]);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  expect(decode).toHaveBeenCalledTimes(1);

  act(() => setEditorTourBeat(1, 'land'));
  await waitFor(() => expect(sources(images)).toEqual([guidePoster, ...stills]));
  act(() => setEditorTourBeat(2, 'compose'));
  await waitFor(() => expect(sources(images)).toEqual([guidePoster, ...stills, EDITOR_TOUR_MEDIA.video.displayUrl]));
  // Nothing is fetched twice.
  act(() => setEditorTourBeat(3, 'land'));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  expect(images).toHaveLength(6);
  view.unmount();
  expect(images.every(image => !image.hasAttribute('src'))).toBe(true);
});

it('continues after an image decode fails and cancels remaining work on exit', async () => {
  const { images, decode, paint } = setup();
  decode.mockRejectedValueOnce(new Error('decode failed'));
  act(() => setEditorTourBeat(1, 'land'));
  const view = renderHook(useTourMediaWarmup);
  paint(); paint();
  await waitFor(() => expect(images.length).toBeGreaterThanOrEqual(2));
  view.unmount();
  const count = images.length;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
  expect(images).toHaveLength(count);
});

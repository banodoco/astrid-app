// @vitest-environment jsdom

import { StrictMode, type PropsWithChildren } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VisualClipSequence } from '@/tools/video-editor/compositions/VisualClip.tsx';
import type { ResolvedTimelineClip, TrackDefinition } from '@/tools/video-editor/types/index.ts';

const remotion = vi.hoisted(() => ({
  scopedDelayRender: vi.fn(() => 41),
  scopedContinueRender: vi.fn(),
  scopedCancelRender: vi.fn(),
  contentAtScopedRelease: [] as boolean[],
  nextHandle: 40,
  delayRender: vi.fn(() => 41),
  continueRender: vi.fn(),
  cancelRender: vi.fn(),
  isRendering: true,
}));

vi.mock('remotion', async () => ({
  AbsoluteFill: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>,
  Sequence: ({ children, from, durationInFrames, premountFor }: PropsWithChildren<Record<string, unknown>>) => (
    <div data-testid="composition-sequence" data-from={from} data-duration={durationInFrames} data-premount-for={premountFor}>{children}</div>
  ),
  useCurrentFrame: () => 0,
  useRemotionEnvironment: () => ({ isRendering: remotion.isRendering, isClientSideRendering: false }),
  useVideoConfig: () => ({ fps: 30, width: 1920, height: 1080 }),
  // Model the hook's provider-scoped methods separately from the top-level
  // window methods. Web renderer export uses this scope, so calling the
  // top-level functions must not satisfy these assertions.
  useDelayRender: () => ({
    delayRender: remotion.scopedDelayRender,
    continueRender: remotion.scopedContinueRender,
    cancelRender: remotion.scopedCancelRender,
  }),
  delayRender: remotion.delayRender,
  continueRender: remotion.continueRender,
  cancelRender: remotion.cancelRender,
}));

vi.mock('@astrid/packs/rendering/shared/readiness-image', () => ({
  ReadinessImage: ({ src, ...props }: Record<string, unknown>) => <img data-testid="clip-media" src={String(src)} {...props} />,
}));

const track: TrackDefinition = { id: 'V1', type: 'video' };
const clipFor = (src: string): ResolvedTimelineClip => ({
  id: 'asset-without-resolution', clipType: 'media', track: 'V1', at: 0, hold: 1,
  assetEntry: { id: 'asset-without-resolution', type: 'image/png', src },
});

let createElement: typeof document.createElement;
let probes: HTMLImageElement[];

beforeEach(() => {
  remotion.delayRender.mockClear();
  remotion.continueRender.mockClear();
  remotion.cancelRender.mockClear();
  remotion.scopedDelayRender.mockClear();
  remotion.scopedContinueRender.mockClear();
  remotion.scopedCancelRender.mockClear();
  remotion.contentAtScopedRelease.length = 0;
  remotion.nextHandle = 40;
  remotion.scopedDelayRender.mockImplementation(() => ++remotion.nextHandle);
  remotion.scopedContinueRender.mockImplementation(() => {
    remotion.contentAtScopedRelease.push(Boolean(document.querySelector('[data-testid="clip-media"]')));
  });
  remotion.isRendering = true;
  probes = [];
  createElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const element = createElement(tag, options);
    if (tag === 'img') probes.push(element as HTMLImageElement);
    return element;
  }) as typeof document.createElement);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('holds export at frame zero until the intrinsic probe makes content available', async () => {
  render(<VisualClipSequence clip={clipFor('/first.png')} track={track} fps={30} />);

  expect(screen.getByTestId('composition-sequence')).toHaveAttribute('data-from', '0');
  expect(remotion.scopedDelayRender).toHaveBeenCalledTimes(1);
  expect(remotion.scopedContinueRender).not.toHaveBeenCalled();
  expect(remotion.delayRender).not.toHaveBeenCalled();
  expect(screen.queryByTestId('clip-media')).not.toBeInTheDocument();

  await act(async () => {
    Object.defineProperty(probes[0], 'naturalWidth', { configurable: true, value: 640 });
    Object.defineProperty(probes[0], 'naturalHeight', { configurable: true, value: 360 });
    probes[0].dispatchEvent(new Event('load'));
  });

  expect(screen.getByTestId('clip-media')).toHaveAttribute('src', '/first.png');
  expect(remotion.scopedContinueRender).toHaveBeenCalledTimes(1);
  expect(remotion.scopedContinueRender).toHaveBeenCalledWith(41);
  expect(remotion.contentAtScopedRelease).toEqual([true]);
  expect(remotion.scopedCancelRender).not.toHaveBeenCalled();
  expect(remotion.continueRender).not.toHaveBeenCalled();
});

it('cancels a held export when intrinsic probing fails', async () => {
  render(<VisualClipSequence clip={clipFor('/broken.png')} track={track} fps={30} />);
  expect(remotion.scopedDelayRender).toHaveBeenCalledTimes(1);

  await act(async () => { probes[0].dispatchEvent(new Event('error')); });

  expect(remotion.scopedCancelRender).toHaveBeenCalledTimes(1);
  expect(remotion.scopedContinueRender).not.toHaveBeenCalled();
});

it('keeps one outstanding scoped handle through Strict Mode replay and releases all handles on completion', async () => {
  render(
    <StrictMode>
      <VisualClipSequence clip={clipFor('/strict.png')} track={track} fps={30} />
    </StrictMode>,
  );

  // Strict Mode replays effects: the first handle is released, then a second
  // handle is acquired and remains outstanding while the probe is pending.
  expect(remotion.scopedDelayRender).toHaveBeenCalledTimes(2);
  expect(remotion.scopedContinueRender).toHaveBeenCalledTimes(1);
  expect(remotion.scopedContinueRender).toHaveBeenCalledWith(41);
  expect(remotion.contentAtScopedRelease).toEqual([false]);
  await act(async () => {
    Object.defineProperty(probes[probes.length - 1], 'naturalWidth', { configurable: true, value: 640 });
    Object.defineProperty(probes[probes.length - 1], 'naturalHeight', { configurable: true, value: 360 });
    probes[probes.length - 1].dispatchEvent(new Event('load'));
  });

  expect(screen.getByTestId('clip-media')).toBeInTheDocument();
  expect(remotion.scopedContinueRender).toHaveBeenCalledTimes(2);
  expect(remotion.scopedContinueRender).toHaveBeenNthCalledWith(2, 42);
  expect(remotion.contentAtScopedRelease).toEqual([false, true]);
});

it('releases old handles on source change and unmount without applying stale dimensions', async () => {
  const view = render(<VisualClipSequence clip={clipFor('/old.png')} track={track} fps={30} />);
  expect(remotion.scopedDelayRender).toHaveBeenCalledTimes(1);

  view.rerender(<VisualClipSequence clip={clipFor('/new.png')} track={track} fps={30} />);
  expect(remotion.scopedContinueRender).toHaveBeenCalledTimes(1);
  expect(remotion.scopedContinueRender).toHaveBeenCalledWith(41);
  expect(remotion.scopedDelayRender).toHaveBeenCalledTimes(2);
  expect(screen.queryByTestId('clip-media')).not.toBeInTheDocument();

  await act(async () => {
    Object.defineProperty(probes[0], 'naturalWidth', { configurable: true, value: 100 });
    Object.defineProperty(probes[0], 'naturalHeight', { configurable: true, value: 100 });
    probes[0].dispatchEvent(new Event('load'));
  });
  expect(screen.queryByTestId('clip-media')).not.toBeInTheDocument();

  view.unmount();
  expect(remotion.scopedContinueRender).toHaveBeenCalledTimes(2);
  expect(remotion.scopedContinueRender).toHaveBeenLastCalledWith(42);
});

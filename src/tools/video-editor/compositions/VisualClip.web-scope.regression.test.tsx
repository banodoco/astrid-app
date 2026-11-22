// @vitest-environment jsdom

import type { PropsWithChildren } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Internals } from 'remotion';
import { VisualClipSequence } from '@/tools/video-editor/compositions/VisualClip.tsx';
import type { ResolvedTimelineClip, TrackDefinition } from '@/tools/video-editor/types/index.ts';

const webRenderer = vi.hoisted(() => ({
  currentFrame: 0,
  handle: 0,
  environment: { isRendering: true, isClientSideRendering: true },
}));

vi.mock('remotion', async (importActual) => {
  const actual = await importActual<typeof import('remotion')>();
  return {
    ...actual,
    Img: ({ src, pauseWhenLoading: _pauseWhenLoading, ...props }: Record<string, unknown>) => <img src={String(src)} {...props} />,
    AbsoluteFill: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>,
    Sequence: ({ children, from, durationInFrames, premountFor }: PropsWithChildren<Record<string, unknown>>) => (
      <div data-testid="composition-sequence" data-from={from} data-duration={durationInFrames} data-premount-for={premountFor}>{children}</div>
    ),
    useCurrentFrame: () => webRenderer.currentFrame,
    useRemotionEnvironment: () => webRenderer.environment,
    useVideoConfig: () => ({ fps: 30, width: 1920, height: 1080 }),
  };
});

const track: TrackDefinition = { id: 'V1', type: 'video' };
const clipFor = (src: string): ResolvedTimelineClip => ({
  id: 'web-scope-clip', clipType: 'media', track: 'V1', at: 0, hold: 1,
  assetEntry: { id: 'web-scope-asset', type: 'image/png', src },
});

let createElement: typeof document.createElement;
let probes: HTMLImageElement[];
const scope = () => ({
  remotion_renderReady: true,
  remotion_delayRenderTimeouts: {},
  remotion_puppeteerTimeout: 30_000,
  remotion_attempt: 0,
  remotion_delayRenderHandles: [] as number[],
});

beforeEach(() => {
  webRenderer.currentFrame = 0;
  webRenderer.handle = 0;
  probes = [];
  createElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const element = createElement(tag, options);
    if (tag === 'img') probes.push(element as HTMLImageElement);
    return element;
  }) as typeof document.createElement);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('holds the real web renderer scope until frame-zero image dimensions resolve and a real img is visible', async () => {
  const renderScope = scope();
  render(
    <Internals.DelayRenderContextType.Provider value={renderScope}>
      <VisualClipSequence clip={clipFor('/frame-zero.png')} track={track} fps={30} />
    </Internals.DelayRenderContextType.Provider>,
  );

  expect(screen.getByTestId('composition-sequence')).toHaveAttribute('data-from', '0');
  expect(renderScope.remotion_delayRenderHandles).toHaveLength(1);
  expect(document.querySelector('img[src="/frame-zero.png"]')).not.toBeInTheDocument();
  expect(probes).toHaveLength(1);

  await act(async () => {
    Object.defineProperty(probes[0], 'naturalWidth', { configurable: true, value: 640 });
    Object.defineProperty(probes[0], 'naturalHeight', { configurable: true, value: 360 });
    probes[0].dispatchEvent(new Event('load'));
  });

  const image = screen.getByRole('img');
  expect(image).toHaveAttribute('src', '/frame-zero.png');
  await act(async () => {
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 640 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 360 });
    image.dispatchEvent(new Event('load'));
  });
  expect(renderScope.remotion_delayRenderHandles).toHaveLength(0);
  expect(renderScope.remotion_renderReady).toBe(true);
});

it('cancels the real web renderer scope when the frame-zero image probe errors', async () => {
  const renderScope = scope();
  render(
    <Internals.DelayRenderContextType.Provider value={renderScope}>
      <VisualClipSequence clip={clipFor('/broken-frame-zero.png')} track={track} fps={30} />
    </Internals.DelayRenderContextType.Provider>,
  );
  expect(renderScope.remotion_delayRenderHandles).toHaveLength(1);

  await act(async () => { probes[0].dispatchEvent(new Event('error')); });

  expect(renderScope.remotion_cancelledError).toContain('Could not load intrinsic dimensions for /broken-frame-zero.png');
  expect(renderScope.remotion_delayRenderHandles.length).toBeGreaterThan(0);
  expect(document.querySelector('img[src="/broken-frame-zero.png"]')).not.toBeInTheDocument();
});

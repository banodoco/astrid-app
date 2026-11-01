// @vitest-environment jsdom
import React, { createRef } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemotionPreview, type PreviewHandle } from './RemotionPreview';
import type { PreviewRevision } from './previewRevision.ts';
import type { ResolvedTimelineConfig } from '@/tools/video-editor/types';

vi.mock('@/tools/video-editor/compositions/TimelineRenderer', () => ({ TimelineRenderer: () => null }));

// External Player boundary from the preserved C2 current-owner counterexample.
// It records commands and public events; config scheduling remains in the real owner.
const boundary = vi.hoisted(() => ({
  player: null as any,
  props: null as any,
  applied: [] as ResolvedTimelineConfig[],
  events: [] as Array<{ frame: number; fps: number; config: string }>,
  listeners: new Map<string, Set<(event: any) => void>>(),
}));
vi.mock('@remotion/player', async () => {
  const React = await import('react');
  return {
    Player: React.forwardRef(function Player(props: any, ref: any) {
      boundary.props = props;
      boundary.applied.push(props.inputProps.config);
      const handle = React.useRef<any>(null);
      if (!handle.current) {
        let frame = props.initialFrame;
        let playing = false;
        const emit = (name: string) => {
          for (const listener of boundary.listeners.get(name) ?? []) listener({});
        };
        handle.current = {
          seekTo: vi.fn((next: number) => {
            frame = next;
            boundary.events.push({ frame, fps: boundary.props.fps, config: boundary.props.inputProps.config.output.file });
          }),
          getCurrentFrame: vi.fn(() => frame),
          isPlaying: vi.fn(() => playing),
          play: vi.fn(() => { playing = true; emit('play'); }),
          pause: vi.fn(() => { playing = false; emit('pause'); }),
          toggle: vi.fn(() => { playing = !playing; emit(playing ? 'play' : 'pause'); }),
          addEventListener: (name: string, listener: (event: any) => void) => {
            if (!boundary.listeners.has(name)) boundary.listeners.set(name, new Set());
            boundary.listeners.get(name)!.add(listener);
          },
          removeEventListener: (name: string, listener: (event: any) => void) => boundary.listeners.get(name)?.delete(listener),
        };
      }
      React.useImperativeHandle(ref, () => handle.current, []);
      boundary.player = handle.current;
      return <div data-testid="mailbox-player" />;
    }),
  };
});

function config(name: string, fps = 30): ResolvedTimelineConfig {
  return {
    output: { fps, resolution: '1280x720', file: name },
    tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
    clips: [{ id: name, at: 0, track: 'V1', clipType: 'hold', hold: 3 }],
    registry: {},
  };
}
let raf = new Map<number, FrameRequestCallback>();
let nextRaf = 0;
function flushFrame() {
  act(() => {
    const callbacks = [...raf.values()];
    raf.clear();
    for (const callback of callbacks) callback(1000);
  });
}
function advance(ms: number) { act(() => { vi.advanceTimersByTime(ms); }); }
function settle() {
  for (let i = 0; i < 8; i++) {
    advance(150);
    if (!raf.size) return;
    flushFrame();
  }
  expect(raf.size, 'finite RAF work exhausted').toBe(0);
}
function preview(initial: ResolvedTimelineConfig, initialRevision?: PreviewRevision) {
  const ref = createRef<PreviewHandle>();
  const container = createRef<HTMLDivElement>();
  const onTimeUpdate = vi.fn();
  const draw = (c: ResolvedTimelineConfig, revision = initialRevision) => (
    <RemotionPreview
      ref={ref}
      config={c}
      previewRevision={revision}
      onTimeUpdate={onTimeUpdate}
      playerContainerRef={container}
    />
  );
  const view = render(draw(initial));
  return { ref, view, replace: (c: ResolvedTimelineConfig, revision?: PreviewRevision) => view.rerender(draw(c, revision)) };
}
beforeEach(() => {
  vi.useFakeTimers();
  boundary.player = null;
  boundary.props = null;
  boundary.applied = [];
  boundary.events = [];
  boundary.listeners.clear();
  raf = new Map();
  nextRaf = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { raf.set(++nextRaf, callback); return nextRaf; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => raf.delete(id));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('H3 newest C beats queued playing B on explicit pause and subsequent one-second seek', () => {
  const a = config('h3-a', 30), b = config('h3-b', 60), c = config('h3-c', 90);
  const h = preview(a);
  settle();
  act(() => h.ref.current!.play());
  flushFrame();
  h.replace(b);
  act(() => { h.ref.current!.pause(); h.replace(c); });
  // Pending live work flushes immediately, without a 150ms paused-edit wait.
  expect.soft(boundary.props.inputProps.config).toBe(c);
  settle();
  act(() => h.ref.current!.seek(1));
  settle();
  expect.soft(boundary.props.inputProps.config).toBe(c);
  expect.soft(boundary.player.seekTo).toHaveBeenLastCalledWith(90);
  expect.soft(boundary.player.isPlaying()).toBe(false);
  expect.soft(boundary.player.play).toHaveBeenCalledTimes(1);
  expect.soft(boundary.applied).not.toContain(b);
  expect.soft(raf.size).toBe(0);
  expect.soft(vi.getTimerCount()).toBe(0);
});

it('flushes pending B immediately when pausing without a newer config', () => {
  const a = config('pending-a'), b = config('pending-b', 60);
  const h = preview(a);
  settle();
  act(() => h.ref.current!.play());
  flushFrame();
  h.replace(b);
  expect(boundary.props.inputProps.config).toBe(a);
  act(() => h.ref.current!.pause());
  expect(boundary.props.inputProps.config).toBe(b);
  expect(raf.size).toBe(0);
  settle();
  act(() => h.ref.current!.seek(1));
  settle();
  expect(boundary.player.seekTo).toHaveBeenLastCalledWith(60);
  expect(boundary.player.isPlaying()).toBe(false);
  expect(boundary.player.play).toHaveBeenCalledTimes(1);
});

it('keeps ordinary paused edits debounced for 150ms and cancels the older timer', () => {
  const a = config('paused-a'), b = config('paused-b'), c = config('paused-c');
  const h = preview(a);
  settle();
  h.replace(b);
  advance(100);
  h.replace(c);
  advance(149);
  expect(boundary.props.inputProps.config).toBe(a);
  advance(1);
  expect(boundary.props.inputProps.config).toBe(c);
  settle();
  expect(boundary.applied).not.toContain(b);
  expect(boundary.player.play).not.toHaveBeenCalled();
});

it('coalesces playing edits to only the newest config on the next finite RAF', () => {
  const a = config('coalesce-a'), b = config('coalesce-b'), c = config('coalesce-c');
  const h = preview(a);
  settle();
  act(() => h.ref.current!.play());
  flushFrame();
  h.replace(b);
  h.replace(c);
  expect(boundary.props.inputProps.config).toBe(a);
  expect(raf.size).toBe(1);
  flushFrame();
  expect(boundary.props.inputProps.config).toBe(c);
  expect(boundary.applied).not.toContain(b);
  expect(boundary.player.play).toHaveBeenCalledTimes(1);
  expect(boundary.player.isPlaying()).toBe(true);
});

it('preserves finite H2 A to B to the exact same A pending seek delivery', () => {
  const a = config('h2-a'), b = config('h2-b', 60);
  const h = preview(a);
  settle();
  act(() => h.ref.current!.seek(0.5));
  h.replace(b);
  h.replace(a);
  act(() => h.ref.current!.seek(1));
  settle();
  expect(boundary.props.inputProps.config).toBe(a);
  expect(boundary.player.seekTo).toHaveBeenNthCalledWith(1, 15);
  expect(boundary.player.seekTo).toHaveBeenLastCalledWith(30);
  expect(boundary.player.seekTo).toHaveBeenCalledTimes(2);
  expect(boundary.player.play).not.toHaveBeenCalled();
});

it('cancels pending mailbox and paused timer work on unmount', () => {
  const a = config('unmount-a'), b = config('unmount-b');
  const h = preview(a);
  settle();
  h.replace(b);
  expect(vi.getTimerCount()).toBe(1);
  h.view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  const live = preview(a);
  settle();
  act(() => live.ref.current!.play());
  flushFrame();
  live.replace(b);
  expect(raf.size).toBe(1);
  live.view.unmount();
  expect(raf.size).toBe(0);
  settle();
  expect(boundary.applied).not.toContain(b);
});

it('keeps the committed revision identity out of the preview caption', () => {
  const revisionId = `authoring-parent-revision-${'a'.repeat(64)}`;
  const { view } = preview(config('accepted'), { kind: 'committed', revisionId });

  expect(screen.queryByTestId('preview-revision-label')).not.toBeInTheDocument();
  expect(view.container).not.toHaveTextContent(revisionId);
  expect(boundary.props.inputProps.previewRevision).toEqual({ kind: 'committed', revisionId });
});

it('keeps a pending local preview from claiming the accepted revision', () => {
  const h = preview(config('accepted'), { kind: 'committed', revisionId: 'accepted-before' });

  h.replace(config('pending'), { kind: 'local', baseRevisionId: 'accepted-before' });
  expect(screen.queryByTestId('preview-revision-label')).not.toBeInTheDocument();

  advance(150);
  expect(screen.getByTestId('preview-revision-label')).toHaveTextContent(/^Unsaved local$/);
  expect(h.view.container).not.toHaveTextContent('accepted-before');
  expect(boundary.props.inputProps.previewRevision).toEqual({ kind: 'local', baseRevisionId: 'accepted-before' });
});

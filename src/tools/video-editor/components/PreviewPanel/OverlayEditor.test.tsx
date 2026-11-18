// @vitest-environment jsdom
import React from 'react';
import * as composition from '@banodoco/timeline-composition';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OverlayEditor, { overlayEditorPropsAreEqual } from '@/tools/video-editor/components/PreviewPanel/OverlayEditor';
import type { ClipMeta } from '@/tools/video-editor/lib/timeline-data';
import type { TimelineRow } from '@/tools/video-editor/types/timeline-canvas';


const baseRows: TimelineRow[] = [
  {
    id: 'V1',
    actions: [
      {
        id: 'clip-1',
        start: 0,
        end: 5,
      },
    ],
  },
];

const baseProps = (meta: Record<string, ClipMeta>, rows: TimelineRow[] = baseRows) => {
  const parent = document.createElement('div');
  const player = document.createElement('div');
  parent.appendChild(player);
  document.body.appendChild(parent);

  Object.defineProperty(player, 'offsetParent', {
    configurable: true,
    get: () => parent,
  });

  player.getBoundingClientRect = () => ({
    x: 100,
    y: 50,
    top: 50,
    left: 100,
    bottom: 590,
    right: 1060,
    width: 960,
    height: 540,
    toJSON: () => ({}),
  });

  parent.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 800,
    right: 1200,
    width: 1200,
    height: 800,
    toJSON: () => ({}),
  });

  return {
    cleanup: () => parent.remove(),
    props: {
      rows,
      meta,
      registry: {'asset-1': {id: 'asset-1', src: '/asset-1.png', type: 'image/png', resolution: '1920x1080'}},
      currentTime: 1,
      playerContainerRef: { current: player },
      trackScaleMap: { V1: 1 },
      compositionWidth: 1920,
      compositionHeight: 1080,
      selectedClipId: 'clip-1',
      deviceClass: 'desktop' as const,
      inputModality: 'mouse' as const,
      interactionMode: 'move' as const,
      gestureOwner: 'none' as const,
      onSelectClip: vi.fn(),
      onOverlayChange: vi.fn(),
      setInputModalityFromPointerType: vi.fn(() => 'mouse' as const),
      setGestureOwner: vi.fn(),
      setContextTarget: vi.fn(),
      setInspectorTarget: vi.fn(),
      onDoubleClickAsset: vi.fn(),
    },
  };
};

describe('OverlayEditor', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it('starts inline text editing on double-click and commits text on blur', () => {
    const { props, cleanup } = baseProps({
      'clip-1': {
        track: 'V1',
        clipType: 'text',
        hold: 4,
        text: {
          content: 'Before',
          fontSize: 56,
          color: '#ffffff',
          align: 'center',
        },
      },
    });
    cleanups.push(cleanup);

    render(<OverlayEditor {...props} />);

    fireEvent.doubleClick(screen.getByRole('button', { name: /selected overlay before/i }));

    const editor = screen.getByDisplayValue('Before');
    fireEvent.change(editor, { target: { value: 'After' } });
    fireEvent.blur(editor);

    expect(props.onOverlayChange).toHaveBeenCalledWith('clip-1', {
      text: {
        content: 'After',
        fontSize: 56,
        color: '#ffffff',
        align: 'center',
      },
    });
  });

  it('suppresses crop handles for inline-text overlays even when selected', () => {
    const { props, cleanup } = baseProps({
      'clip-1': {
        track: 'V1',
        clipType: 'text',
        hold: 4,
        text: {
          content: 'Headline',
          fontSize: 56,
          color: '#ffffff',
          align: 'center',
        },
      },
    });
    cleanups.push(cleanup);

    const { container } = render(<OverlayEditor {...props} />);

    expect(container.querySelector('[class*="cursor-ew-resize"]')).toBeNull();
    expect(container.querySelector('[class*="cursor-ns-resize"]')).toBeNull();
  });

  it('opens the asset lightbox on media double-click instead of entering text edit mode', () => {
    const { props, cleanup } = baseProps({
      'clip-1': {
        track: 'V1',
        clipType: 'hold',
        hold: 4,
        asset: 'asset-1',
      },
    });
    cleanups.push(cleanup);

    render(<OverlayEditor {...props} />);

    fireEvent.doubleClick(screen.getByRole('button', { name: /selected overlay asset-1/i }));

    expect(props.onDoubleClickAsset).toHaveBeenCalledWith('asset-1', 'clip-1');
    expect(screen.queryByDisplayValue(/asset-1/i)).not.toBeInTheDocument();
  });

  it('excludes effect-layer clips from overlay rendering entirely', () => {
    const { props, cleanup } = baseProps({
      'clip-1': {
        track: 'V1',
        clipType: 'effect-layer',
        hold: 4,
      },
    });
    cleanups.push(cleanup);

    const { container } = render(<OverlayEditor {...props} />);

    expect(container.querySelector('[data-overlay-hit="true"]')).toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('OverlayEditor memo comparator', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  const mediaMeta: Record<string, ClipMeta> = {
    'clip-1': { track: 'V1', clipType: 'media', hold: 4, asset: 'asset-1' },
  };

  const pair = () => {
    const { props, cleanup } = baseProps(mediaMeta);
    cleanups.push(cleanup);
    return props;
  };

  it('skips the re-render when every prop is referentially equal', () => {
    const props = pair();
    expect(overlayEditorPropsAreEqual(props, { ...props })).toBe(true);
  });

  it('skips the re-render when only currentTime moves within the same visible clips', () => {
    const props = pair();
    expect(overlayEditorPropsAreEqual(props, { ...props, currentTime: 2 })).toBe(true);
  });

  it('re-renders when currentTime moves the clip out of view', () => {
    const props = pair();
    expect(overlayEditorPropsAreEqual(props, { ...props, currentTime: 9 })).toBe(false);
  });

  it('re-renders when any other prop changes', () => {
    const props = pair();
    expect(overlayEditorPropsAreEqual(props, { ...props, selectedClipId: null })).toBe(false);
    expect(overlayEditorPropsAreEqual(props, { ...props, meta: { ...props.meta } })).toBe(false);
    expect(overlayEditorPropsAreEqual(props, { ...props, trackScaleMap: { V1: 0.5 } })).toBe(false);
    expect(overlayEditorPropsAreEqual(props, { ...props, onOverlayChange: vi.fn() })).toBe(false);
  });

  it('mounts the memoized component (comparator is the one wired into memo)', () => {
    const props = pair();
    const { container } = render(<OverlayEditor {...props} />);
    expect(container.querySelector('[data-overlay-hit="true"]')).not.toBeNull();
  });
});

describe('OverlayEditor — track scale agreement (decree: scale scales everything)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it('shows a positioned clip at its rendered (track-scaled) box, not its stored box', () => {
    // Composition scales the whole track subtree by 0.5 about center, so a
    // stored full-frame box renders as the centered half-size box. The gizmo
    // must sit on the rendered pixels.
    const { props, cleanup } = baseProps({
      'clip-1': {
        track: 'V1',
        clipType: 'media',
        hold: 4,
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
      },
    });
    cleanups.push(cleanup);
    props.trackScaleMap = { V1: 0.5 };

    render(<OverlayEditor {...props} />);

    const overlay = document.querySelector('[data-overlay-hit="true"]') as HTMLElement;
    // Rendered box = (480,270,960,540) in composition space; layout maps
    // composition 1920x1080 onto the 960x540 player → screen factor 0.5.
    expect(overlay.style.left).toBe('240px');
    expect(overlay.style.top).toBe('135px');
    expect(overlay.style.width).toBe('480px');
    expect(overlay.style.height).toBe('270px');
  });

  it('keeps the unpositioned default box centered and scaled (unchanged semantics)', () => {
    const { props, cleanup } = baseProps({
      'clip-1': {
        track: 'V1',
        clipType: 'media',
        hold: 4,
        asset: 'asset-1',
      },
    });
    cleanups.push(cleanup);
    props.trackScaleMap = { V1: 0.5 };

    render(<OverlayEditor {...props} />);

    const overlay = document.querySelector('[data-overlay-hit="true"]') as HTMLElement;
    // Default box for media = full frame, scaled to the same centered half box.
    expect(overlay.style.left).toBe('240px');
    expect(overlay.style.top).toBe('135px');
    expect(overlay.style.width).toBe('480px');
    expect(overlay.style.height).toBe('270px');
  });
});


it('passes the authored track appearance to shared placement', () => {
  const spy = vi.spyOn(composition, 'resolveClipPlacement');
  const {props, cleanup} = baseProps({'clip-1': {track: 'V1', clipType: 'media', asset: 'asset-1', hold: 4}});
  const track = {id: 'V1', kind: 'visual' as const, label: 'V1', fit: 'cover' as const, opacity: 0.4, scale: 1};
  render(<OverlayEditor {...props} tracks={[track]} />);
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({track}));
  spy.mockRestore();
  cleanup();
});


it('draws the exact output bounds returned by shared placement', () => {
  const actual = composition.resolveClipPlacement;
  const spy = vi.spyOn(composition, 'resolveClipPlacement').mockImplementation(input => {
    const result = actual(input);
    const box = {x: 200, y: 100, width: 400, height: 200};
    return {...result, output: {...result.output, full: box, visible: box}};
  });
  const {props, cleanup} = baseProps({'clip-1': {track: 'V1', clipType: 'media', asset: 'asset-1', hold: 4}});
  render(<OverlayEditor {...props} />);
  const overlay = document.querySelector('[data-overlay-hit="true"]') as HTMLElement;
  expect(overlay).toHaveStyle({left: '100px', top: '50px', width: '200px', height: '100px'});
  spy.mockRestore();
  cleanup();
});

// @vitest-environment jsdom
/**
 * Default-box conformance: **the clip-type descriptor is canonical and every
 * consumer asks it** (`getDefaultBoxForClipType`).
 *
 * Before this rule, a position-less text clip had three different boxes —
 * renderer `(0,0,640,160)`, gizmo `(120,120,640,180)`, properties panel
 * `(0,0,compW,compH)` — so the gizmo sat 120px off the rendered text. This
 * suite renders all three surfaces for a position-less clip and fails if any
 * of them disagrees with the accessor; a re-introduced local fallback is a red
 * test, not a misaligned gizmo on somebody's timeline.
 *
 * Deliberate consequence (owner-accepted): legacy position-less text clips
 * (agent/bridge/imported) now render at the descriptor box — they move from
 * the renderer's old (0,0) to (120,120).
 */
import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDefaultBoxForClipType } from '@/tools/video-editor/clip-types/index.ts';
import type { ClipMeta } from '@/tools/video-editor/lib/timeline-data.ts';
import type { ResolvedTimelineClip, TrackDefinition } from '@/tools/video-editor/types/index.ts';
import type { TimelineRow } from '@/tools/video-editor/types/timeline-canvas.ts';

const COMPOSITION_WIDTH = 1920;
const COMPOSITION_HEIGHT = 1080;

// ---------------------------------------------------------------------------
// Surface 1: the Remotion renderer (TextClip)
// ---------------------------------------------------------------------------

vi.mock('remotion', () => ({
  AbsoluteFill: ({ children, style, ...rest }: { children?: ReactNode; style?: CSSProperties }) => (
    <div data-testid="absolute-fill" style={style} {...rest}>{children}</div>
  ),
  Sequence: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useVideoConfig: () => ({
    width: COMPOSITION_WIDTH,
    height: COMPOSITION_HEIGHT,
    fps: 30,
    durationInFrames: 300,
  }),
  // Frame 0: the box is measured at rest, not mid-transition.
  useCurrentFrame: () => 0,
  // Frame 0 maps to the first output value, which is what the real
  // interpolate returns at rest.
  interpolate: (_frame: number, _inputRange: number[], outputRange: number[]) => outputRange[0],
}));

vi.mock('@/tools/video-editor/effects/index.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/tools/video-editor/effects/index.tsx')>();
  return {
    ...actual,
    // Identity: this suite measures the box, not entrance/exit effects.
    wrapWithClipEffects: (content: ReactNode) => content,
  };
});

// ---------------------------------------------------------------------------
// Surface 3: the properties panel (ClipPanel) — same seams the ClipPanel
// suites stub, so the panel renders its real position tab.
// ---------------------------------------------------------------------------

const useEffectResourcesMock = vi.hoisted(() => vi.fn());

vi.mock('@/tools/video-editor/hooks/useEffectResources', () => ({
  useEffectResources: () => useEffectResourcesMock(),
}));
vi.mock('@/shared/components/ui/input', () => ({
  Input: ({ onChange, value, ...props }: ComponentProps<'input'>) => (
    <input value={value} onChange={onChange} {...props} />
  ),
}));
vi.mock('@/shared/components/ui/textarea', () => ({
  Textarea: ({ onChange, value, ...props }: ComponentProps<'textarea'>) => (
    <textarea value={value} onChange={onChange} {...props} />
  ),
}));
vi.mock('@/shared/components/ui/number-input', () => ({
  NumberInput: ({ value, min, max, step }: {
    value: number | null;
    min?: number;
    max?: number;
    step?: number;
  }) => (
    <input role="spinbutton" readOnly value={value ?? ''} min={min} max={max} step={step} />
  ),
}));
vi.mock('@/shared/components/ui/select', async () => {
  const actual = await vi.importActual<typeof import('@/shared/components/ui/select')>('@/shared/components/ui/select');
  return {
    ...actual,
    // Render select content inline (no portal) so the panel mounts in jsdom.
    SelectContent: ({ children }: { children: ReactNode }) => <div data-testid="select-content">{children}</div>,
  };
});
vi.mock('@/tools/video-editor/contexts/VideoEditorRuntimeContext', () => ({
  useVideoEditorRuntime: () => ({ userId: 'user-1' }),
}));
vi.mock('@/tools/video-editor/components/EffectCreatorPanel', () => ({
  EffectCreatorPanel: () => null,
}));

import { TextClip } from '@/tools/video-editor/compositions/TextClip.tsx';
import OverlayEditor from '@/tools/video-editor/components/PreviewPanel/OverlayEditor.tsx';
import { ClipPanel } from '@/tools/video-editor/components/PropertiesPanel/ClipPanel.tsx';

const track: TrackDefinition = { id: 'V1', kind: 'visual', label: 'V1' };

/** A text clip with NO x/y/width/height — the fallback population. */
const positionlessTextClip: ResolvedTimelineClip = {
  id: 'clip-1',
  clipType: 'text',
  track: 'V1',
  at: 0,
  hold: 5,
  text: { content: 'Where am I?' },
};

const descriptorBox = getDefaultBoxForClipType('text', COMPOSITION_WIDTH, COMPOSITION_HEIGHT);

afterEach(() => {
  vi.clearAllMocks();
});

describe('surface: renderer (TextClip)', () => {
  it('draws a position-less text clip at the descriptor box', () => {
    render(<TextClip clip={positionlessTextClip} track={track} fps={30} />);

    // ClipTransition wraps the text box in an AbsoluteFill, so two elements
    // carry the test id. The text box is the innermost one, last in DOM order.
    const boxes = screen.getAllByTestId('absolute-fill');
    const box = boxes[boxes.length - 1];
    expect(box.style.left).toBe(`${descriptorBox.x}px`);
    expect(box.style.top).toBe(`${descriptorBox.y}px`);
    expect(box.style.width).toBe(`${descriptorBox.width}px`);
    expect(box.style.height).toBe(`${descriptorBox.height}px`);
  });

  it('still honors explicit positions (fallback only fills the gaps)', () => {
    render(
      <TextClip
        clip={{ ...positionlessTextClip, x: 10, y: 20, width: 300, height: 80 }}
        track={track}
        fps={30}
      />,
    );

    const boxes = screen.getAllByTestId('absolute-fill');
    const box = boxes[boxes.length - 1];
    expect(box.style.left).toBe('10px');
    expect(box.style.top).toBe('20px');
    expect(box.style.width).toBe('300px');
    expect(box.style.height).toBe('80px');
  });
});

describe('surface: gizmo (OverlayEditor)', () => {
  it('places the overlay for a position-less text clip on the descriptor box', () => {
    // Player 960x540 for a 1920x1080 composition → composition→screen 0.5.
    const parent = document.createElement('div');
    const player = document.createElement('div');
    parent.appendChild(player);
    document.body.appendChild(parent);
    Object.defineProperty(player, 'offsetParent', { configurable: true, get: () => parent });
    player.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, left: 0, bottom: 540, right: 960, width: 960, height: 540, toJSON: () => ({}),
    });
    parent.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, left: 0, bottom: 540, right: 960, width: 960, height: 540, toJSON: () => ({}),
    });

    const rows: TimelineRow[] = [
      { id: 'V1', actions: [{ id: 'clip-1', start: 0, end: 5, effectId: 'effect-clip-1' }] },
    ];
    const meta: Record<string, ClipMeta> = {
      'clip-1': { track: 'V1', clipType: 'text', hold: 5, text: { content: 'Where am I?' } },
    };

    render(
      <OverlayEditor
        rows={rows}
        meta={meta}
        registry={{}}
        currentTime={1}
        playerContainerRef={{ current: player }}
        trackScaleMap={{ V1: 1 }}
        compositionWidth={COMPOSITION_WIDTH}
        compositionHeight={COMPOSITION_HEIGHT}
        selectedClipId="clip-1"
        deviceClass="desktop"
        inputModality="mouse"
        interactionMode="move"
        gestureOwner="none"
        onSelectClip={vi.fn()}
        onOverlayChange={vi.fn()}
        setInputModalityFromPointerType={vi.fn(() => 'mouse' as const)}
        setGestureOwner={vi.fn()}
        setContextTarget={vi.fn()}
        setInspectorTarget={vi.fn()}
      />,
    );

    const overlay = document.querySelector('[data-overlay-hit="true"]') as HTMLElement | null;
    expect(overlay).not.toBeNull();
    const factor = 960 / COMPOSITION_WIDTH;
    expect(overlay?.style.left).toBe(`${descriptorBox.x * factor}px`);
    expect(overlay?.style.top).toBe(`${descriptorBox.y * factor}px`);
    expect(overlay?.style.width).toBe(`${descriptorBox.width * factor}px`);
    expect(overlay?.style.height).toBe(`${descriptorBox.height * factor}px`);

    parent.remove();
  });
});

describe('surface: properties panel (ClipPanel)', () => {
  beforeEach(() => {
    useEffectResourcesMock.mockReturnValue({
      effects: [],
      entrance: [],
      exit: [],
      continuous: [],
      canCreateEffect: false,
      canUpdateEffect: false,
      data: { entrance: [], exit: [], continuous: [] },
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: async () => undefined,
    });
  });

  it('shows the descriptor box for a position-less text clip', () => {
    render(
      <ClipPanel
        clip={positionlessTextClip}
        track={track}
        deviceClass="desktop"
        interactionMode="move"
        hasPredecessor={false}
        onChange={vi.fn()}
        onResetPosition={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onToggleMute={vi.fn()}
        onDetachAudio={vi.fn()}
        onSplitAtPlayhead={vi.fn()}
        onMoveTrackUp={vi.fn()}
        onMoveTrackDown={vi.fn()}
        onSetInteractionMode={vi.fn()}
        compositionWidth={COMPOSITION_WIDTH}
        compositionHeight={COMPOSITION_HEIGHT}
        registry={{}}
        activeTab="position"
        setActiveTab={vi.fn()}
        timelineFps={30}
      />,
    );

    const values = screen.getAllByRole('spinbutton').map((input) => (input as HTMLInputElement).value);
    expect(values).toContain(String(descriptorBox.x));
    expect(values).toContain(String(descriptorBox.width));
    expect(values).toContain(String(descriptorBox.height));
  });
});

describe('the accessor itself', () => {
  it('answers full-frame for descriptors that declare no box (media)', () => {
    expect(getDefaultBoxForClipType('media', COMPOSITION_WIDTH, COMPOSITION_HEIGHT)).toEqual({
      x: 0,
      y: 0,
      width: COMPOSITION_WIDTH,
      height: COMPOSITION_HEIGHT,
    });
  });

  it('answers the text descriptor defaults for text', () => {
    expect(descriptorBox).toEqual({ x: 120, y: 120, width: 640, height: 180 });
  });
});

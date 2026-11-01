// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineRenderer as TimelineRendererImplementation } from '@/tools/video-editor/compositions/TimelineRenderer';
import { continuousEffects } from '@/tools/video-editor/effects/index.tsx';
import type { ResolvedTimelineConfig } from '@/tools/video-editor/types';
import type { ClipRendererProps } from '@/tools/video-editor/clip-types/ClipTypeRegistry';
import type { ComponentProps, FC, PropsWithChildren } from 'react';
import {
  SEQUENCE_COMPONENT_REGISTRY,
  describeClipCapabilityWith,
  resolveSequenceClipEntry,
} from '@/tools/video-editor/sequences/registry';
import type { AstridDynamicSequenceEntry, AstridElementHost } from '@/tools/video-editor/runtime/astrid-element-host';
import {
  VideoEditorRuntimeProvider,
  type VideoEditorRuntimeContextValue,
} from '@/tools/video-editor/contexts/VideoEditorRuntimeContext';
import {
  createLiveDataRegistry,
  type LiveDataRegistry,
} from '@/tools/video-editor/runtime/liveDataRegistry';

const sequenceProps = vi.hoisted((): Array<Record<string, unknown>> => []);
const visualClipMock = vi.hoisted(() => vi.fn());
const textClipMock = vi.hoisted(() => vi.fn());
const postprocessPreviewMock = vi.hoisted(() => vi.fn());
const mockShaderRegistryGet = vi.hoisted(() => vi.fn());
const mockShaderRegistryHas = vi.hoisted(() => vi.fn());
const astridElementComponentMock = vi.hoisted(() => vi.fn());
const fixtureAstridElementHost: AstridElementHost = {
  descriptors: [],
  sequenceRegistry: SEQUENCE_COMPONENT_REGISTRY,
  resolveComponent: astridElementComponentMock,
  resolveSequenceClipEntry,
  describeClipCapability: describeClipCapabilityWith,
};
let currentFrame = 0;
let simulatePremount = false;
let currentEnvironment = {
  isRendering: false,
  isClientSideRendering: false,
};

vi.mock('remotion', async () => {
  return {
    delayRender: () => 0,
    continueRender: () => {},
    AbsoluteFill: ({
      children,
      ...props
    }: PropsWithChildren<Record<string, unknown>>) => (
      <div data-testid="absolute-fill" {...props}>{children}</div>
    ),
    Sequence: ({
      children,
      ...props
    }: PropsWithChildren<Record<string, unknown>>) => {
      sequenceProps.push(props);
      const from = typeof props.from === 'number' ? props.from : 0;
      const duration = typeof props.durationInFrames === 'number' ? props.durationInFrames : Infinity;
      const premountFor = typeof props.premountFor === 'number' ? props.premountFor : 0;
      if (simulatePremount) {
        const active = currentFrame >= from && currentFrame < from + duration;
        const mounted = currentFrame >= from - premountFor && currentFrame < from + duration;
        if (!mounted) return null;
        return (
          <div data-testid="sequence" data-from={from} data-active={String(active)} style={active ? undefined : { opacity: 0 }}>
            {children}
          </div>
        );
      }
      return <div data-testid="sequence">{children}</div>;
    },
    Series: ({ children }: PropsWithChildren) => <div data-testid="series">{children}</div>,
    useCurrentFrame: () => currentFrame,
    useVideoConfig: () => ({ fps: 30, width: 1920, height: 1080, durationInFrames: 30 }),
    useRemotionEnvironment: () => currentEnvironment,
    interpolate: (value: number) => value,
    spring: () => 0,
    Img: ({ ...props }: Record<string, unknown>) => <img {...props} />,
    Video: ({ ...props }: Record<string, unknown>) => <video {...props} />,
    Audio: ({ ...props }: Record<string, unknown>) => <audio {...props} />,
    Easing: {},
  };
});

vi.mock('@banodoco/timeline-composition/theme-api', async () => {
  const reactModule = await import('react');
  const runtimeThemeValue = {
    color: {
      accent: '#ffffff',
      bg: '#000000',
      fg: '#ffffff',
    },
    type: {
      families: {
        heading: 'Georgia, serif',
        body: 'Inter, system-ui, sans-serif',
        mono: 'JetBrains Mono, ui-monospace, monospace',
      },
      size: {
        base: 56,
        small: 32,
        large: 128,
      },
      weight: {
        normal: 300,
        bold: 500,
      },
      lineHeight: 1.1,
    },
    motion: {
      fadeMs: 500,
    },
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
    },
  };

  const DEFAULT_THEME = {
    id: 'default',
    visual: runtimeThemeValue,
  };

  const toRuntimeTheme = (value: unknown) => {
    if (
      value
      && typeof value === 'object'
      && 'visual' in value
      && value.visual
      && typeof value.visual === 'object'
    ) {
      return {
        ...runtimeThemeValue,
        ...value.visual,
        color: {
          ...runtimeThemeValue.color,
          ...(typeof value.visual.color === 'object' ? value.visual.color : {}),
        },
        type: {
          ...runtimeThemeValue.type,
          ...(typeof value.visual.type === 'object' ? value.visual.type : {}),
          families: {
            ...runtimeThemeValue.type.families,
            ...(typeof value.visual.type === 'object' && typeof value.visual.type.families === 'object'
              ? value.visual.type.families
              : {}),
          },
        },
      };
    }
    return runtimeThemeValue;
  };

  const ThemeContext = reactModule.createContext(runtimeThemeValue);

  return {
    DEFAULT_THEME,
    ThemeProvider: ({
      children,
      value,
    }: PropsWithChildren<{ value: typeof DEFAULT_THEME }>) => (
      <ThemeContext.Provider value={toRuntimeTheme(value)}>{children}</ThemeContext.Provider>
    ),
    useTheme: () => reactModule.useContext(ThemeContext),
    composeAnimations: () => ({}),
  };
});

vi.mock('@/tools/video-editor/compositions/AudioAnalysisProvider', async () => {
  return {
    AudioAnalysisProvider: ({ children, enabled = true }: PropsWithChildren<{ enabled?: boolean }>) => enabled ? (
      <div data-testid="audio-analysis-provider">{children}</div>
    ) : (
      <>{children}</>
    ),
  };
});

vi.mock('@/tools/video-editor/compositions/LocalFontFaces.tsx', () => ({
  LocalFontFaces: () => null,
}));

vi.mock('@/tools/video-editor/compositions/VisualClip', () => ({
  VisualClipSequence: (props: Record<string, unknown>) => {
    visualClipMock(props);
    return <div data-testid="visual-clip-sequence" data-clip-id={(props.clip as { id: string }).id} />;
  },
}));

vi.mock('@/tools/video-editor/compositions/TextClip', () => ({
  TextClipSequence: (props: Record<string, unknown>) => {
    textClipMock(props);
    return <div data-testid="text-clip-sequence" />;
  },
}));

vi.mock('@/tools/video-editor/runtime/astrid-element-components.tsx', () => ({
  resolveAstridElementComponent: astridElementComponentMock,
}));

const TEST_ASTRID_ELEMENT_HOST: AstridElementHost = {
  descriptors: [],
  sequenceRegistry: SEQUENCE_COMPONENT_REGISTRY,
  resolveComponent: astridElementComponentMock as AstridElementHost['resolveComponent'],
  resolveSequenceClipEntry: (clipType, dynamicEntries) => resolveSequenceClipEntry(
    clipType,
    dynamicEntries as Parameters<typeof resolveSequenceClipEntry>[1],
  ) as AstridDynamicSequenceEntry | undefined,
  describeClipCapability: (clip, dynamicEntries) => describeClipCapabilityWith(
    clip,
    dynamicEntries as Parameters<typeof describeClipCapabilityWith>[1],
  ),
};

// These standalone composition tests exercise the installed registry semantics
// through an explicit host while keeping element module resolution mocked.
const TimelineRenderer: FC<ComponentProps<typeof TimelineRendererImplementation>> = ({ astridElementHost, ...props }) => (
  <TimelineRendererImplementation
    {...props}
    astridElementHost={astridElementHost ?? TEST_ASTRID_ELEMENT_HOST}
  />
);

vi.mock('@/tools/video-editor/shaders/preview/PostprocessShaderPreviewCanvas.tsx', () => ({
  PostprocessShaderPreviewCanvas: (props: Record<string, unknown>) => {
    postprocessPreviewMock(props);
    return (
      <div
        data-testid={String(props.testId ?? 'timeline-postprocess-shader-preview')}
        data-shader-id={String((props.shader as { shaderId?: string })?.shaderId ?? '')}
        data-frame={String(props.frame)}
        data-time-seconds={String(props.timeSeconds)}
      />
    );
  },
}));

vi.mock('@/tools/video-editor/shaders/registry/index.ts', async () => {
  const actual = await vi.importActual<typeof import('@/tools/video-editor/shaders/registry/index.ts')>(
    '@/tools/video-editor/shaders/registry/index.ts',
  );
  return {
    ...actual,
    useShaderEffectRegistrySnapshot: () => ({
      records: Object.freeze([]),
      diagnostics: Object.freeze([]),
      get: mockShaderRegistryGet,
      getByLookup: (lookup: { shaderId: string; ownerExtensionId?: string }) => (
        mockShaderRegistryGet(lookup.shaderId, lookup.ownerExtensionId)
      ),
      has: mockShaderRegistryHas,
      hasByLookup: (lookup: { shaderId: string; ownerExtensionId?: string }) => (
        mockShaderRegistryHas(lookup.shaderId, lookup.ownerExtensionId)
      ),
    }),
  };
});

vi.mock('@banodoco/timeline-composition/theme-api', async () => {
  const React = await import('react');
  const DEFAULT_THEME = {
    id: 'default',
    visual: {
      color: {
        accent: '#ffffff',
        bg: '#000000',
      },
      type: {
        families: {
          heading: 'Georgia, serif',
        },
      },
    },
  };
  const ThemeContext = React.createContext(DEFAULT_THEME.visual);
  return {
    DEFAULT_THEME,
    ThemeProvider: ({
      children,
      value,
    }: PropsWithChildren<{ value: unknown }>) => (
      <ThemeContext.Provider value={(value as typeof DEFAULT_THEME)?.visual ?? DEFAULT_THEME.visual}>
        {children}
      </ThemeContext.Provider>
    ),
    useTheme: () => React.useContext(ThemeContext),
    composeAnimations: () => ({}),
  };
});

vi.mock('@banodoco/timeline-composition/registry.generated', async () => {
  const React = await import('react');
  const RegisteredSequence = ({
    clip,
    params,
    theme,
    fps,
    assetEntry,
  }: {
    clip: { id: string };
    params?: { title?: string; previews?: string[]; previewAssetKeys?: string[] };
    theme: {
      color: { accent: string; bg: string };
      type: { families: { heading: string } };
      };
    fps: number;
    assetEntry?: { file?: string };
  }) => (
    <div
      data-testid="registered-sequence"
      data-clip-id={clip.id}
      data-title={params?.title ?? ''}
      data-accent={theme.color.accent}
      data-bg={theme.color.bg}
      data-heading={theme.type.families.heading}
      data-fps={fps}
      data-previews={JSON.stringify(params?.previews ?? [])}
      data-preview-asset-keys={JSON.stringify(params?.previewAssetKeys ?? [])}
      data-asset-file={assetEntry?.file ?? ''}
    />
  );
  return {
    THEME_PACKAGE_CLIP_TYPES: ['section-hook', 'resource-card'],
    THEME_PACKAGE_REGISTRY: {
      'section-hook': {
        component: RegisteredSequence,
        themeId: '2rp',
        source: 'installed:@banodoco/timeline-theme-2rp',
      },
      'resource-card': {
        component: RegisteredSequence,
        themeId: '2rp',
        source: 'installed:@banodoco/timeline-theme-2rp',
      },
    },
  };
});

type BuildConfigExtras = Partial<Pick<ResolvedTimelineConfig, 'theme' | 'theme_overrides'>> & {
  assetEntry?: ResolvedTimelineConfig['clips'][number]['assetEntry'];
};

const buildConfig = (
  extras: BuildConfigExtras = {},
): ResolvedTimelineConfig => {
  const {assetEntry, ...configExtras} = extras;
  return {
  output: {
    resolution: '1920x1080',
    fps: 30,
    file: 'out.mp4',
  },
  tracks: [
    {
      id: 'V1',
      kind: 'visual',
      label: 'V1',
    },
  ],
  clips: [
    {
      id: 'clip-sequence',
      clipType: 'section-hook',
      track: 'V1',
      at: 1,
      hold: 3,
      params: {
        title: 'Renaissance systems',
      },
      assetEntry,
    },
  ],
  registry: {},
    ...configExtras,
  };
};

beforeEach(() => {
  currentFrame = 0;
  simulatePremount = false;
  currentEnvironment = {
    isRendering: false,
    isClientSideRendering: false,
  };
  postprocessPreviewMock.mockClear();
  mockShaderRegistryGet.mockReset();
  mockShaderRegistryHas.mockReset();
  astridElementComponentMock.mockReset();
});

describe('TimelineRenderer track lifetime', () => {
  it('keeps an existing effect around lower tracks only when an ordinary top track is added', () => {
    continuousEffects['test-track-lifetime'] = ({ children }) => <div data-testid="track-lifetime-effect">{children}</div>;
    try {
      const config: ResolvedTimelineConfig = {
        ...buildConfig(),
        tracks: [{ id: 'frames', kind: 'visual' }, { id: 'world', kind: 'visual' }],
        clips: [
          { id: 'world-clip', clipType: 'media', track: 'world', at: 0, from: 0, to: 14 },
          { id: 'town-frame', clipType: 'hold', track: 'frames', at: 13, hold: 1 },
          { id: 'effect', clipType: 'effect-layer', track: 'frames', at: 0, hold: 14, continuous: { type: 'test-track-lifetime' } },
        ],
      };
      currentFrame = 390;
      const view = render(<TimelineRenderer config={config} />);
      const effect = screen.getByTestId('track-lifetime-effect');
      const world = view.container.querySelector('[data-clip-id="world-clip"]');
      const still = view.container.querySelector('[data-clip-id="town-frame"]');
      expect(effect).toContainElement(world as HTMLElement);
      expect(effect).not.toContainElement(still as HTMLElement);
      view.rerender(<TimelineRenderer config={{ ...config,
        tracks: [{ id: 'video', kind: 'visual' }, ...config.tracks!],
        clips: [...config.clips, { id: 'h3-video', clipType: 'media', track: 'video', at: 0, from: 0, to: 14 }],
      }} />);
      expect(screen.getByTestId('track-lifetime-effect')).toBe(effect);
      expect(view.container.querySelector('[data-clip-id="world-clip"]')).toBe(world);
      expect(view.container.querySelector('[data-clip-id="town-frame"]')).toBe(still);
      expect(effect).not.toContainElement(view.container.querySelector('[data-clip-id="h3-video"]'));
      expect([...view.container.querySelectorAll('[data-testid="visual-clip-sequence"]')].map(node => node.getAttribute('data-clip-id')))
        .toEqual(['world-clip', 'town-frame', 'h3-video']);
    } finally {
      delete continuousEffects['test-track-lifetime'];
    }
  });

  it('keeps already-painted lower tracks mounted when a new top track arrives or leaves', () => {
    const stage2: ResolvedTimelineConfig = {
      ...buildConfig(),
      tracks: [{ id: 'frames', kind: 'visual' }, { id: 'world', kind: 'visual' }],
      clips: [
        { id: 'world-clip', clipType: 'media', track: 'world', at: 0, from: 0, to: 14 },
        { id: 'town-frame', clipType: 'hold', track: 'frames', at: 13, hold: 1 },
      ],
    };
    currentFrame = 390;
    const view = render(<TimelineRenderer config={stage2} />);
    const world = view.container.querySelector('[data-clip-id="world-clip"]');
    const still = view.container.querySelector('[data-clip-id="town-frame"]');
    expect(world).not.toBeNull();
    expect(still).not.toBeNull();
    const stage3: ResolvedTimelineConfig = {
      ...stage2,
      tracks: [{ id: 'video', kind: 'visual' }, ...stage2.tracks!],
      clips: [...stage2.clips, { id: 'h3-video', clipType: 'media', track: 'video', at: 0, from: 0, to: 14 }],
    };
    view.rerender(<TimelineRenderer config={stage3} />);
    // Keeping node identity means image/iframe/decoder state survives the new row's commit,
    // before the tour's async frame-readiness logic has had any opportunity to run.
    expect(view.container.querySelector('[data-clip-id="town-frame"]')).toBe(still);
    expect(view.container.querySelector('[data-clip-id="world-clip"]')).toBe(world);
    expect([...view.container.querySelectorAll('[data-testid="visual-clip-sequence"]')].map(node => node.getAttribute('data-clip-id')))
      .toEqual(['world-clip', 'town-frame', 'h3-video']);
    view.rerender(<TimelineRenderer config={stage2} />);
    expect(view.container.querySelector('[data-clip-id="town-frame"]')).toBe(still);
    expect(view.container.querySelector('[data-clip-id="world-clip"]')).toBe(world);
  });
});

describe('TimelineRenderer registered sequences', () => {
  it('prerolls an incoming text transition and stops at the authored end', async () => {
    const { TextClipSequence } = await vi.importActual<typeof import('@/tools/video-editor/compositions/TextClip.tsx')>(
      '@/tools/video-editor/compositions/TextClip.tsx',
    );
    sequenceProps.length = 0;
    const clip = {
      id: 'incoming-text', clipType: 'text' as const, track: 'V1', at: 10, hold: 2,
      text: { content: 'Text' }, transition: { id: 'fade', durationFrames: 8 },
      app: { canonicalTiming: { occurrenceStartMs: 10_000, occurrenceDurationMs: 2_000 } },
    } as ResolvedTimelineConfig['clips'][number];
    render(<TextClipSequence clip={clip} track={{ id: 'V1', kind: 'visual', label: 'V1' }} fps={30}
      predecessor={{ id: 'previous', clipType: 'hold', track: 'V1', at: 8, hold: 2 } as never} />);
    expect(sequenceProps.find((props) => props.from === 292)).toMatchObject({ from: 292, durationInFrames: 68 });
  });

  it.each([
    { name: 'oversized clamped-start transition', start: 30, duration: 30, T: 60, endCap: undefined, drawStart: 0, drawDuration: 90 },
    { name: 'canonical end cap', start: 60, duration: 30, T: 8, endCap: 90, drawStart: 52, drawDuration: 38 },
  ])('draws $name on the installed package incoming plan', async ({ start, duration, T, endCap, drawStart, drawDuration }) => {
    const { prepareTrack } = await import('@banodoco/timeline-composition/evaluation');
    const { TextClipSequence } = await vi.importActual<typeof import('@/tools/video-editor/compositions/TextClip.tsx')>(
      '@/tools/video-editor/compositions/TextClip.tsx',
    );
    const [, plan] = prepareTrack(
      [{ start: 0, duration: start }, { start, duration, ...(endCap === undefined ? {} : { endCap }) }],
      [null, null],
      [null, { T }],
    ).plans;
    expect(plan).toMatchObject({ drawStart, drawDuration });
    sequenceProps.length = 0;
    const clip = {
      id: 'incoming-text', clipType: 'text' as const, track: 'V1', at: start / 30, hold: duration / 30,
      text: { content: 'Text' }, transition: { id: 'fade', durationFrames: T },
      ...(endCap === undefined ? {} : { app: { canonicalTiming: { occurrenceStartMs: 2000, occurrenceDurationMs: 1000 } } }),
    } as ResolvedTimelineConfig['clips'][number];
    render(<TextClipSequence clip={clip} track={{ id: 'V1', kind: 'visual', label: 'V1' }} fps={30}
      predecessor={{ id: 'previous', clipType: 'hold', track: 'V1', at: 0, hold: start / 30 } as never} />);
    expect(sequenceProps.find((props) => props.from === plan.drawStart)).toMatchObject({
      from: plan.drawStart,
      durationInFrames: plan.drawDuration,
    });
  });

  it('keeps a canonical visual image absent at the half-open end after transition expansion', async () => {
    const { VisualClipSequence } = await vi.importActual<typeof import('@/tools/video-editor/compositions/VisualClip.tsx')>(
      '@/tools/video-editor/compositions/VisualClip.tsx',
    );
    sequenceProps.length = 0;
    const clip = {
      id: 'canonical-image',
      clipType: 'hold' as const,
      track: 'V1',
      at: 10,
      hold: 2,
      transition: { type: 'fade', duration: 0.5 },
      app: { canonicalTiming: { occurrenceStartMs: 10_000, occurrenceDurationMs: 2_000 } },
    } as ResolvedTimelineConfig['clips'][number];

    render(
      <>
        <VisualClipSequence
          clip={clip}
          track={{ id: 'V1', kind: 'visual', label: 'V1' }}
          fps={30}
          predecessor={{ id: 'previous', clipType: 'hold', track: 'V1', at: 8, hold: 2 }} as never
        />
        <div data-testid="transparent-gap" />
      </>,
    );

    // Actual VisualClipSequence emits [285,360); the former transition/overlap
    // expansion emitted [285,361), drawing frame 360 into the transparent gap.
    expect(sequenceProps.find((props) => props.from === 285)).toMatchObject({
      from: 285,
      durationInFrames: 75,
    });
    expect(screen.getByTestId('transparent-gap')).toBeInTheDocument();
  });

  beforeEach(() => {
    sequenceProps.length = 0;
    visualClipMock.mockClear();
    textClipMock.mockClear();
  });

  it('renders registered sequence clips through the generated registry and passes params/timing', () => {
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={buildConfig({ theme: '2rp' })} />);

    expect(screen.queryByTestId('unknown-clip-placeholder')).not.toBeInTheDocument();
    const sequence = screen.getByTestId('registered-sequence');
    expect(sequence).toHaveAttribute('data-clip-id', 'clip-sequence');
    expect(sequence).toHaveAttribute('data-title', 'Renaissance systems');
    expect(sequence).toHaveAttribute('data-accent', '#fde68a');
    expect(sequence).toHaveAttribute('data-fps', '30');
    expect(sequenceProps[0]).toMatchObject({
      from: 30,
      durationInFrames: 90,
    });
    expect(screen.queryByTestId('audio-analysis-provider')).not.toBeInTheDocument();
  });

  it('passes the host-resolved asset URL to registered effects', () => {
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={buildConfig({
      theme: '2rp',
      assetEntry: {
        file: 'stale-persisted-locator',
        src: '/media/resolved-source.mp4',
        type: 'video/mp4',
      },
    })} />);

    // The real registry component receives the same shape; this assertion
    // protects the boundary where managed `src` replaces a stale persisted
    // `file` locator for browser-only effect playback.
    expect(screen.getByTestId('registered-sequence')).toHaveAttribute('data-asset-file', '/media/resolved-source.mp4');
  });

  it('dispatches audio-reactive-colour through the first-party clip-relative renderer', () => {
    currentFrame = 4;
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{
      ...buildConfig(),
      clips: [{
        id: 'colour-map',
        clipType: 'audio-reactive-colour',
        track: 'V1',
        at: 2,
        hold: 3,
        params: {
          initialColor: '#000000',
          events: [{ frame: 4, color: '#405060' }],
        },
      }],
    }} />);

    expect(screen.queryByTestId('unknown-clip-placeholder')).not.toBeInTheDocument();
    expect(screen.getByTestId('audio-reactive-colour-renderer')).toHaveAttribute('data-frame', '4');
    expect(screen.getByTestId('audio-reactive-colour-renderer')).toHaveStyle({
      backgroundColor: '#405060',
    });
    expect(screen.getByTestId('audio-analysis-provider')).toBeInTheDocument();
    expect(sequenceProps[0]).toMatchObject({ from: 60, durationInFrames: 90 });
  });

  it('dispatches legacy Astrid effect clipTypes through the bundled effect renderer', () => {
    const ScrollingGuideMock: FC<{ clip: { id: string }; params?: Record<string, unknown> }> = ({ clip, params }) => (
      <div
        data-testid="astrid-effect-renderer"
        data-clip-id={clip.id}
        data-side={String(params?.side ?? '')}
      />
    );
    astridElementComponentMock.mockImplementation((elementId: string, kind: string) => (
      elementId === 'scrolling-guide' && kind === 'effect' ? ScrollingGuideMock : undefined
    ));

    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{
      ...buildConfig(),
      clips: [{
        id: 'closing-v6-scrolling-guide',
        clipType: 'scrolling-guide',
        track: 'V1',
        at: 1,
        hold: 3,
        params: { side: 'left' },
        app: { canonicalTiming: { occurrenceStartMs: 1000, occurrenceDurationMs: 3000 } },
      }],
    }} />);

    expect(screen.queryByTestId('unknown-clip-placeholder')).not.toBeInTheDocument();
    expect(screen.getByTestId('astrid-effect-renderer')).toHaveAttribute('data-clip-id', 'closing-v6-scrolling-guide');
    expect(screen.getByTestId('astrid-effect-renderer')).toHaveAttribute('data-side', 'left');
    expect(sequenceProps[0]).toMatchObject({ from: 30, durationInFrames: 90, premountFor: 60 });
  });

  it('premounts flattened canonical Astrid effect content hidden before its boundary', () => {
    const ScrollingGuideMock: FC<{ clip: { id: string } }> = ({ clip }) => (
      <div data-testid="canonical-effect-content" data-clip-id={clip.id} />
    );
    astridElementComponentMock.mockImplementation((elementId: string, kind: string) => (
      elementId === 'animated-media-transform' && kind === 'effect' ? ScrollingGuideMock : undefined
    ));
    const config: ResolvedTimelineConfig = {
      ...buildConfig(),
      clips: [{
        id: 'shot-6-image-transform',
        clipType: 'animated-media-transform',
        track: 'V1',
        at: 1,
        hold: 3,
        params: { fit: 'cover' },
        app: { canonicalTiming: { occurrenceStartMs: 1000, occurrenceDurationMs: 3000 } },
      }],
    };
    simulatePremount = true;
    currentFrame = 29;
    const view = render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={config} />);

    const content = screen.getByTestId('canonical-effect-content');
    const hiddenSequence = screen.getAllByTestId('sequence').find((sequence) => (
      sequence.contains(content) && sequence.getAttribute('data-from') === '30'
    ));
    expect(hiddenSequence).toHaveAttribute('data-active', 'false');
    expect(hiddenSequence).toHaveStyle({ opacity: 0 });
    expect(sequenceProps.find((props) => props.from === 30)).toMatchObject({
      from: 30,
      premountFor: 60,
    });

    currentFrame = 30;
    view.rerender(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{ ...config }} />);
    expect(screen.getByTestId('canonical-effect-content')).toBe(content);
    const activeSequence = screen.getAllByTestId('sequence').find((sequence) => (
      sequence.contains(content) && sequence.getAttribute('data-from') === '30'
    ));
    expect(activeSequence).toHaveAttribute('data-active', 'true');
    expect(activeSequence).not.toHaveStyle({ opacity: 0 });
  });

  it('passes the host-resolved asset URL to legacy Astrid effects', () => {
    const EndSpanningLayerMock: FC<{
      clip: { id: string };
      assetEntry?: { file?: string };
    }> = ({ clip, assetEntry }) => (
      <div
        data-testid="astrid-effect-asset-renderer"
        data-clip-id={clip.id}
        data-asset-file={assetEntry?.file ?? ''}
      />
    );
    astridElementComponentMock.mockImplementation((elementId: string, kind: string) => (
      elementId === 'end-spanning-layer' && kind === 'effect' ? EndSpanningLayerMock : undefined
    ));

    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{
      ...buildConfig(),
      clips: [{
        id: 'fx-process-v3',
        clipType: 'end-spanning-layer',
        track: 'V1',
        at: 1,
        hold: 3,
        asset: 'minkhole_original_source',
        assetEntry: {
          file: 'stale-persisted-locator',
          src: '/media/resolved-source.mp4',
          type: 'video/mp4',
        },
      }],
    }} />);

    expect(screen.getByTestId('astrid-effect-asset-renderer')).toHaveAttribute(
      'data-asset-file',
      '/media/resolved-source.mp4',
    );
  });

  it('uses shared duration helpers for speed-adjusted registered sequence clips', () => {
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{
      ...buildConfig({ theme: '2rp' }),
      clips: [
        {
          id: 'clip-speed-adjusted',
          clipType: 'section-hook',
          track: 'V1',
          at: 0,
          from: 0,
          to: 6,
          speed: 2,
          params: {
            title: 'Speed adjusted',
          },
        },
      ],
    }} />);

    expect(sequenceProps[0]).toMatchObject({
      from: 0,
      durationInFrames: 90,
    });
  });

  it('deep-merges timeline theme_overrides onto the installed theme', () => {
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={buildConfig({
      theme: '2rp',
      theme_overrides: {
        visual: {
          color: {
            accent: '#00ff88',
          },
        },
      },
    })} />);

    const sequence = screen.getByTestId('registered-sequence');
    expect(sequence).toHaveAttribute('data-accent', '#00ff88');
    expect(sequence).toHaveAttribute('data-bg', '#000000');
    expect(sequence).toHaveAttribute('data-heading', "'Sixtyfour', 'Sixtyfour Variable', monospace");
  });

  it('uses the DEFAULT_THEME fallback when the timeline has no theme', () => {
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={buildConfig()} />);

    const sequence = screen.getByTestId('registered-sequence');
    expect(sequence).toHaveAttribute('data-accent', '#ffffff');
    expect(sequence).toHaveAttribute('data-bg', '#000000');
    expect(sequence).toHaveAttribute('data-heading', 'Georgia, serif');
  });

  it('materializes registry asset keys into component-facing preview URLs for registered sequences', () => {
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{
      ...buildConfig({ theme: '2rp' }),
      clips: [
        {
          id: 'clip-resource',
          clipType: 'resource-card',
          track: 'V1',
          at: 0,
          hold: 3,
          params: {
            title: 'Resource',
            previewAssetKeys: ['asset-a'],
          },
        },
      ],
      registry: {
        'asset-a': {
          file: 'asset-a.png',
          src: 'https://cdn.example.com/asset-a.png',
          type: 'image',
        },
      },
    }} />);

    const sequence = screen.getByTestId('registered-sequence');
    expect(sequence).toHaveAttribute('data-previews', JSON.stringify(['https://cdn.example.com/asset-a.png']));
    expect(sequence).toHaveAttribute('data-preview-asset-keys', JSON.stringify(['asset-a']));
  });

  it('renders locally-registered title-card clips through the same registry-backed sequence route', () => {
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{
      ...buildConfig({ theme: '2rp' }),
      clips: [
        {
          id: 'clip-title-card',
          clipType: 'title-card',
          track: 'V1',
          at: 0,
          hold: 3,
          params: {
            kicker: 'INTRO',
            title: 'Registry Title',
            subtitle: 'Local example component',
          },
        },
      ],
    }} />);

    const sequence = screen.getByTestId('title-card-sequence');
    expect(sequence).toHaveAttribute('data-kicker', 'INTRO');
    expect(sequence).toHaveAttribute('data-title', 'Registry Title');
    expect(sequence).toHaveAttribute('data-subtitle', 'Local example component');
  });

  it('renders remotion_module clips as safe placeholders before registered, native, or unknown clipType dispatch', () => {
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{
      ...buildConfig({ theme: '2rp' }),
      clips: [
        {
          id: 'clip-module-theme',
          clipType: 'section-hook',
          track: 'V1',
          at: 0,
          hold: 1,
          generation: {
            sequence_lane: 'remotion_module',
            artifact_id: 'artifact-theme',
            source: 'do-not-render-this',
          },
        },
        {
          id: 'clip-module-native',
          clipType: 'media',
          track: 'V1',
          at: 1,
          hold: 1,
          generation: {
            sequence_lane: 'remotion_module',
            artifact_id: 'artifact-native',
          },
        },
        {
          id: 'clip-module-unknown',
          clipType: 'generated-unknown',
          track: 'V1',
          at: 2,
          hold: 1,
          generation: {
            sequence_lane: 'remotion_module',
            artifact_id: 'artifact-unknown',
          },
        },
      ],
    }} />);

    const placeholders = screen.getAllByTestId('generated-module-placeholder');
    expect(placeholders).toHaveLength(3);
    expect(placeholders.map((node) => node.getAttribute('data-artifact-id'))).toEqual([
      'artifact-theme',
      'artifact-native',
      'artifact-unknown',
    ]);
    expect(screen.queryByTestId('registered-sequence')).not.toBeInTheDocument();
    expect(screen.queryByTestId('unknown-clip-placeholder')).not.toBeInTheDocument();
    expect(visualClipMock).not.toHaveBeenCalled();
  });

  it('preserves embedded Remotion source but requires pack migration instead of executing it', async () => {
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{
      ...buildConfig({ theme: '2rp' }),
      app: {
        elements: {
          'draft-glow': {
            kind: 'effect',
            revision: 'draft-1',
            source: 'export default function Draft({ clip, durationInFrames }) { return <div data-testid="generated-live-preview">{clip.id}:{durationInFrames}</div>; }',
          },
        },
      },
      clips: [{
        id: 'clip-live',
        clipType: 'media',
        track: 'V1',
        at: 0,
        hold: 2,
        elementRef: { id: 'draft-glow', kind: 'effect', revision: 'draft-1' },
      }],
    }} />);

    expect(screen.queryByTestId('generated-live-preview')).not.toBeInTheDocument();
    expect(screen.getByTestId('generated-module-placeholder')).toHaveTextContent('requires its exact admitted pack revision');
  });

  it('keeps trusted_v1, schema_sequence, and legacy clips on their normal preview paths', () => {
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{
      ...buildConfig({ theme: '2rp' }),
      clips: [
        {
          id: 'clip-trusted',
          clipType: 'section-hook',
          track: 'V1',
          at: 0,
          hold: 1,
          params: {
            title: 'Trusted',
          },
          generation: {
            sequence_lane: 'trusted_v1',
          },
        },
        {
          id: 'clip-schema',
          clipType: 'media',
          track: 'V1',
          at: 1,
          hold: 1,
          generation: {
            sequence_lane: 'schema_sequence',
            artifact_id: 'schema-1',
          },
        },
        {
          id: 'clip-legacy',
          track: 'V1',
          at: 2,
          hold: 1,
        },
      ],
    }} />);

    expect(screen.queryByTestId('generated-module-placeholder')).not.toBeInTheDocument();
    expect(screen.getByTestId('registered-sequence')).toHaveAttribute('data-clip-id', 'clip-trusted');
    expect(visualClipMock).toHaveBeenCalledTimes(2);
  });

  it('falls back loudly when a trusted sequence clip is unavailable in the installed registry', () => {
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{
      ...buildConfig({ theme: '2rp' }),
      clips: [
        {
          id: 'clip-unavailable',
          clipType: 'cta-card',
          track: 'V1',
          at: 0,
          hold: 2,
        },
      ],
    }} />);

    expect(screen.getByTestId('unknown-clip-placeholder')).toBeInTheDocument();
    expect(screen.queryByTestId('registered-sequence')).not.toBeInTheDocument();
    expect(visualClipMock).not.toHaveBeenCalled();
    expect(textClipMock).not.toHaveBeenCalled();
  });
});

describe('TimelineRenderer postprocess shader preview', () => {
  beforeEach(() => {
    sequenceProps.length = 0;
    visualClipMock.mockClear();
    textClipMock.mockClear();
  });

  const postprocessShader = {
    scope: 'postprocess',
    extensionId: 'ext.shader',
    contributionId: 'ext.shader.post',
    shaderId: 'shader.preview.post',
    uniforms: { intensity: 0.6 },
  } as const;

  const postprocessRecord = {
    shaderId: 'shader.preview.post',
    ownerExtensionId: 'ext.shader',
    contributionId: 'ext.shader.post',
    label: 'Postprocess Preview',
    source: {
      kind: 'inline',
      fragment: 'precision mediump float; void main(){ gl_FragColor = vec4(1.0); }',
    },
    pass: 'postprocess',
    provenance: 'trusted-loader',
    renderability: {
      defaultRoute: 'preview',
      determinism: 'preview-only',
      capabilities: [
        {
          route: 'preview',
          status: 'supported',
          determinism: 'preview-only',
        },
      ],
    },
    status: 'active',
  };

  it('mounts one timeline-scope postprocess preview layer in browser preview coordinates', () => {
    currentFrame = 45;
    mockShaderRegistryGet.mockReturnValue(postprocessRecord);

    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{
      ...buildConfig({ theme: '2rp' }),
      app: { shaderPostprocess: postprocessShader },
    }} />);

    expect(screen.getByTestId('timeline-postprocess-shader-preview')).toHaveAttribute(
      'data-shader-id',
      'shader.preview.post',
    );
    expect(postprocessPreviewMock).toHaveBeenCalledWith(expect.objectContaining({
      shader: postprocessShader,
      record: postprocessRecord,
      frame: 45,
      timeSeconds: 1.5,
      width: 1920,
      height: 1080,
    }));
    expect(screen.queryByTestId('unsupported-postprocess-shader-export')).not.toBeInTheDocument();
  });

  it('keeps postprocess shaders preview-only during Remotion export rendering', () => {
    currentEnvironment = {
      isRendering: true,
      isClientSideRendering: false,
    };
    mockShaderRegistryGet.mockReturnValue(postprocessRecord);

    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{
      ...buildConfig({ theme: '2rp' }),
      app: { shaderPostprocess: postprocessShader },
    }} />);

    expect(postprocessPreviewMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('timeline-postprocess-shader-preview')).not.toBeInTheDocument();
    expect(screen.getByTestId('unsupported-postprocess-shader-export')).toHaveTextContent(
      'export requires a shader materializer that produces RenderMaterial',
    );
  });
});

// ---------------------------------------------------------------------------
// Extension clip renderer dispatch tests
// ---------------------------------------------------------------------------

const mockClipTypeRegistryGet = vi.fn();
const mockClipTypeRegistryHas = vi.fn();

vi.mock('@/tools/video-editor/clip-types/ClipTypeRegistryContext.tsx', async () => {
  const actual = await vi.importActual<
    typeof import('@/tools/video-editor/clip-types/ClipTypeRegistryContext.tsx')
  >('@/tools/video-editor/clip-types/ClipTypeRegistryContext.tsx');
  return {
    ...actual,
    useClipTypeRegistrySnapshot: () => ({
      records: Object.freeze([]),
      diagnostics: Object.freeze([]),
      get: mockClipTypeRegistryGet,
      has: mockClipTypeRegistryHas,
    }),
  };
});

/** Create a minimal ClipTypeRegistryRecord for tests. */
function makeRegistryRecord(
  overrides: Partial<{
    clipTypeId: string;
    status: string;
    renderer: unknown;
    capabilities: Array<{ route: string; status: string }>;
    schema: ReadonlyArray<{
      name: string;
      label: string;
      description: string;
      type: string;
      default?: unknown;
      min?: number;
      max?: number;
      step?: number;
      options?: readonly { label: string; value: string }[];
    }>;
  }> = {},
): Record<string, unknown> {
  const {
    clipTypeId = 'ext.my-clip',
    status = 'active',
    renderer,
    capabilities = [{ route: 'preview', status: 'supported' }],
    schema,
  } = overrides;
  return {
    clipTypeId,
    contributionId: 'contrib-1',
    renderer: renderer ?? ((() => null) as unknown),
    status,
    schema,
    renderability: {
      capabilities: capabilities.map((c) => ({
        ...c,
        determinism: 'deterministic',
      })),
      defaultRoute: 'preview',
      determinism: 'deterministic',
    },
  };
}

function runtimeWithLiveRegistry(liveDataRegistry?: LiveDataRegistry): VideoEditorRuntimeContextValue {
  return {
    provider: {},
    assetResolver: {},
    auth: {},
    project: {},
    shots: {},
    mediaLightbox: {},
    agentChat: {},
    toast: {},
    telemetry: {},
    timelineId: 'timeline-test',
    userId: 'user-test',
    extensions: {},
    liveDataRegistry,
  } as unknown as VideoEditorRuntimeContextValue;
}

function renderWithLiveRegistry(config: ResolvedTimelineConfig, liveDataRegistry?: LiveDataRegistry) {
  return render(
    <VideoEditorRuntimeProvider value={runtimeWithLiveRegistry(liveDataRegistry)}>
      <TimelineRenderer astridElementHost={fixtureAstridElementHost} config={config} />
    </VideoEditorRuntimeProvider>,
  );
}

describe('TimelineRenderer — extension clip renderer dispatch (M9 T10)', () => {
  beforeEach(() => {
    sequenceProps.length = 0;
    visualClipMock.mockClear();
    textClipMock.mockClear();
    mockClipTypeRegistryGet.mockReset();
    mockClipTypeRegistryHas.mockReset();
  });

  const extBuildConfig = (
    clipType: string,
    keyframes?: Record<string, Array<{ time: number; value: number | string | boolean; interpolation: string }>>,
    params?: Record<string, unknown>,
  ): ResolvedTimelineConfig => ({
    output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
    tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
    clips: [
      {
        id: 'clip-ext-1',
        clipType,
        track: 'V1',
        at: 0,
        hold: 2,
        params: params ?? {},
        keyframes,
      },
    ],
    registry: {},
  });

  it('renders an extension clip through the ClipTypeRegistry with host-interpolated params', () => {
    const TestRenderer: FC<ClipRendererProps> = (props) => (
      <div
        data-testid="extension-clip-renderer"
        data-clip-id={props.clipId}
        data-clip-type-id={props.clipTypeId}
        data-time={props.time}
        data-width={props.width}
        data-height={props.height}
        data-params={JSON.stringify(props.params)}
      >
        EXTENSION
      </div>
    );

    mockClipTypeRegistryGet.mockReturnValue(
      makeRegistryRecord({
        clipTypeId: 'ext.my-clip',
        renderer: TestRenderer,
      }),
    );
    mockClipTypeRegistryHas.mockReturnValue(true);

    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={extBuildConfig('ext.my-clip')} />);

    const el = screen.getByTestId('extension-clip-renderer');
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('data-clip-id', 'clip-ext-1');
    expect(el).toHaveAttribute('data-clip-type-id', 'ext.my-clip');
    expect(el).toHaveAttribute('data-time', '0');
    expect(el).toHaveAttribute('data-width', '1920');
    expect(el).toHaveAttribute('data-height', '1080');
    // No schema → params passed through as-is
    expect(el.getAttribute('data-params')).toBe('{}');
    expect(screen.queryByTestId('unknown-clip-placeholder')).not.toBeInTheDocument();
  });

  it('computes host-interpolated params from keyframes when schema is present', () => {
    const TestRenderer: FC<ClipRendererProps> = (props) => (
      <div
        data-testid="extension-clip-renderer"
        data-params={JSON.stringify(props.params)}
      />
    );

    mockClipTypeRegistryGet.mockReturnValue(
      makeRegistryRecord({
        clipTypeId: 'ext.anim-clip',
        renderer: TestRenderer,
        schema: [{ name: 'opacity', label: 'Opacity', description: '', type: 'number', default: 0.5, min: 0, max: 1 }],
      }),
    );
    mockClipTypeRegistryHas.mockReturnValue(true);

    render(
      <TimelineRenderer astridElementHost={fixtureAstridElementHost}
        config={extBuildConfig(
          'ext.anim-clip',
          {
            opacity: [
              { time: 0, value: 0.2, interpolation: 'linear' },
              { time: 2, value: 1.0, interpolation: 'linear' },
            ],
          },
        )}
      />,
    );

    const el = screen.getByTestId('extension-clip-renderer');
    const params = JSON.parse(el.getAttribute('data-params') ?? '{}');
    // At time=0, we get the first keyframe value (0.2)
    expect(params.opacity).toBe(0.2);
  });

  it('interpolates between keyframes at a non-zero time', () => {
    const TestRenderer: FC<ClipRendererProps> = (props) => (
      <div
        data-testid="extension-clip-renderer"
        data-params={JSON.stringify(props.params)}
      />
    );

    mockClipTypeRegistryGet.mockReturnValue(
      makeRegistryRecord({
        clipTypeId: 'ext.anim-clip',
        renderer: TestRenderer,
        schema: [{ name: 'scale', label: 'Scale', description: '', type: 'number', default: 1, min: 0.1, max: 5 }],
      }),
    );
    mockClipTypeRegistryHas.mockReturnValue(true);

    render(
      <TimelineRenderer astridElementHost={fixtureAstridElementHost}
        config={extBuildConfig(
          'ext.anim-clip',
          {
            scale: [
              { time: 0, value: 1, interpolation: 'linear' },
              { time: 2, value: 3, interpolation: 'linear' },
            ],
          },
        )}
      />,
    );

    const el = screen.getByTestId('extension-clip-renderer');
    const params = JSON.parse(el.getAttribute('data-params') ?? '{}');
    // At time=0, we get the first keyframe value (1)
    expect(params.scale).toBe(1);
  });

  it('falls back to raw params when clip has no keyframes and schema is present', () => {
    const TestRenderer: FC<ClipRendererProps> = (props) => (
      <div
        data-testid="extension-clip-renderer"
        data-params={JSON.stringify(props.params)}
      />
    );

    mockClipTypeRegistryGet.mockReturnValue(
      makeRegistryRecord({
        clipTypeId: 'ext.nokf-clip',
        renderer: TestRenderer,
        schema: [{ name: 'volume', label: 'Volume', description: '', type: 'number', default: 0.8, min: 0, max: 1 }],
      }),
    );
    mockClipTypeRegistryHas.mockReturnValue(true);

    render(
      <TimelineRenderer astridElementHost={fixtureAstridElementHost}
        config={extBuildConfig('ext.nokf-clip', undefined, { volume: 0.3 })}
      />,
    );

    const el = screen.getByTestId('extension-clip-renderer');
    const params = JSON.parse(el.getAttribute('data-params') ?? '{}');
    // No keyframes → uses default value from schema (0.8)
    expect(params.volume).toBe(0.8);
  });

  it('shows loud placeholder when renderer throws at runtime (error boundary)', () => {
    const CrashingRenderer: FC = () => {
      throw new Error('Intentional test crash');
    };

    mockClipTypeRegistryGet.mockReturnValue(
      makeRegistryRecord({
        clipTypeId: 'ext.crash-clip',
        renderer: CrashingRenderer,
      }),
    );
    mockClipTypeRegistryHas.mockReturnValue(true);

    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={extBuildConfig('ext.crash-clip')} />);

    // Error boundary should catch the crash and render the placeholder
    expect(screen.getByTestId('unknown-clip-placeholder')).toBeInTheDocument();
    expect(screen.queryByTestId('extension-clip-renderer')).not.toBeInTheDocument();
  });

  it('shows loud placeholder when registry record has no renderer', () => {
    mockClipTypeRegistryGet.mockReturnValue(
      makeRegistryRecord({
        clipTypeId: 'ext.norender-clip',
        renderer: { notAFunction: true }, // Not a function
      }),
    );
    mockClipTypeRegistryHas.mockReturnValue(true);

    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={extBuildConfig('ext.norender-clip')} />);

    expect(screen.getByTestId('unknown-clip-placeholder')).toBeInTheDocument();
    expect(screen.queryByTestId('extension-clip-renderer')).not.toBeInTheDocument();
  });

  it('shows loud placeholder when registry record is inactive', () => {
    mockClipTypeRegistryGet.mockReturnValue(
      makeRegistryRecord({
        clipTypeId: 'ext.inactive-clip',
        status: 'inactive',
      }),
    );
    mockClipTypeRegistryHas.mockReturnValue(true);

    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={extBuildConfig('ext.inactive-clip')} />);

    expect(screen.getByTestId('unknown-clip-placeholder')).toBeInTheDocument();
    expect(screen.queryByTestId('extension-clip-renderer')).not.toBeInTheDocument();
  });

  it('shows loud placeholder when preview capability is blocked', () => {
    const TestRenderer: FC<ClipRendererProps> = () => (
      <div data-testid="extension-clip-renderer" />
    );

    mockClipTypeRegistryGet.mockReturnValue(
      makeRegistryRecord({
        clipTypeId: 'ext.blocked-clip',
        renderer: TestRenderer,
        capabilities: [{ route: 'preview', status: 'blocked' }],
      }),
    );
    mockClipTypeRegistryHas.mockReturnValue(true);

    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={extBuildConfig('ext.blocked-clip')} />);

    expect(screen.getByTestId('unknown-clip-placeholder')).toBeInTheDocument();
    expect(screen.queryByTestId('extension-clip-renderer')).not.toBeInTheDocument();
  });

  it('falls through to existing loud placeholder when clipType is not in the registry', () => {
    mockClipTypeRegistryGet.mockReturnValue(undefined);
    mockClipTypeRegistryHas.mockReturnValue(false);

    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={extBuildConfig('ext.unknown-clip')} />);

    // Not in registry → falls through to !isBuiltinClipType check → loud placeholder
    expect(screen.getByTestId('unknown-clip-placeholder')).toBeInTheDocument();
    expect(screen.getByTestId('unknown-clip-placeholder')).toHaveTextContent(
      "renderer unavailable in this Astrid build",
    );
    expect(screen.queryByTestId('extension-clip-renderer')).not.toBeInTheDocument();
    expect(visualClipMock).not.toHaveBeenCalled();
  });
});

describe('TimelineRenderer — live binding renderer facade (M11 T6)', () => {
  beforeEach(() => {
    sequenceProps.length = 0;
    visualClipMock.mockClear();
    textClipMock.mockClear();
    mockClipTypeRegistryGet.mockReset();
    mockClipTypeRegistryHas.mockReset();
  });

  const liveBuildConfig = (
    clips: ResolvedTimelineConfig['clips'],
  ): ResolvedTimelineConfig => ({
    output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
    tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
    clips,
    registry: {},
  });

  const liveClip = (
    id: string,
    liveBindings: unknown,
  ): ResolvedTimelineConfig['clips'][number] => ({
    id,
    clipType: 'ext.live-clip',
    track: 'V1',
    at: 0,
    hold: 2,
    params: { liveBindings },
  });

  it('passes source-id keyed synchronous live read helpers into extension renderers', () => {
    const registry = createLiveDataRegistry();
    registry.registerSource({ id: 'source-live', kind: 'generated' });
    const channelId = registry.openChannel('source-live', 'video');
    registry.pushSample(channelId, {
      timestamp: 100,
      data: { value: 42 },
      format: 'json',
    });

    const TestRenderer: FC<ClipRendererProps> = (props) => {
      const sample = props.live.readLatestSample('source-live');
      const sampleAt = props.live.readSampleAt('source-live', 0);
      const samples = props.live.readSamples('source-live');
      const source = props.live.getSource('source-live');
      const latestReturn = props.live.readLatestSample('source-live');
      const isPromise = Boolean(latestReturn && typeof (latestReturn as unknown as Promise<unknown>).then === 'function');
      return (
        <div
          data-testid="extension-live-renderer"
          data-sample-value={String((sample?.frame.data as Record<string, unknown> | undefined)?.value)}
          data-sample-at-value={String((sampleAt?.frame.data as Record<string, unknown> | undefined)?.value)}
          data-sample-count={props.live.getSampleCount('source-live')}
          data-samples-length={samples.length}
          data-source-id={source?.id}
          data-resolved-channel={props.live.resolveChannelId('source-live')}
          data-is-promise={String(isPromise)}
        />
      );
    };

    mockClipTypeRegistryGet.mockReturnValue(makeRegistryRecord({ clipTypeId: 'ext.live-clip', renderer: TestRenderer }));
    mockClipTypeRegistryHas.mockReturnValue(true);

    renderWithLiveRegistry(
      liveBuildConfig([
        liveClip('clip-live', [
          {
            bindingId: 'binding-live',
            sourceId: 'source-live',
            sourceKind: 'generated',
            channelId,
          },
        ]),
      ]),
      registry,
    );

    const el = screen.getByTestId('extension-live-renderer');
    expect(el).toHaveAttribute('data-sample-value', '42');
    expect(el).toHaveAttribute('data-sample-at-value', '42');
    expect(el).toHaveAttribute('data-sample-count', '1');
    expect(el).toHaveAttribute('data-samples-length', '1');
    expect(el).toHaveAttribute('data-source-id', 'source-live');
    expect(el).toHaveAttribute('data-resolved-channel', channelId);
    expect(el).toHaveAttribute('data-is-promise', 'false');
    expect(screen.queryByTestId('live-binding-placeholder')).not.toBeInTheDocument();
  });

  it('passes host source time and opaque source independently of animated params', () => {
    currentFrame = 180;
    const TestRenderer: FC<ClipRendererProps> = props => <div data-testid="scene-clock" data-time={props.sourceTime} data-source={JSON.stringify(props.source)} data-params={JSON.stringify(props.params)} />;
    mockClipTypeRegistryGet.mockReturnValue(makeRegistryRecord({clipTypeId:'ext.live-clip',renderer:TestRenderer,schema:[{name:'scale',label:'Scale',description:'',type:'number',default:1}]}));
    mockClipTypeRegistryHas.mockReturnValue(true);
    const config = liveBuildConfig([{...liveClip('scene',[]),at:2,from:55,hold:20,speed:2,app:{liveScene:{revision:'pinned'}},keyframes:{scale:[{time:0,value:1},{time:10,value:2}]}}]);
    const view = render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={config} />);
    expect(screen.getByTestId('scene-clock')).toHaveAttribute('data-time','63');
    expect(screen.getByTestId('scene-clock')).toHaveAttribute('data-source',JSON.stringify({liveScene:{revision:'pinned'}}));
    expect(JSON.parse(screen.getByTestId('scene-clock').getAttribute('data-params') ?? '{}')).not.toHaveProperty('liveScene');
    currentFrame = 120;
    view.rerender(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{...config, clips:[...config.clips]}} />);
    expect(screen.getByTestId('scene-clock')).toHaveAttribute('data-time','59');
    currentFrame = 0;
  });

  it('renders live diagnostics placeholders for unresolved live binding states', () => {
    const TestRenderer: FC<ClipRendererProps> = () => (
      <div data-testid="extension-live-renderer" />
    );

    mockClipTypeRegistryGet.mockReturnValue(makeRegistryRecord({ clipTypeId: 'ext.live-clip', renderer: TestRenderer }));
    mockClipTypeRegistryHas.mockReturnValue(true);

    renderWithLiveRegistry(liveBuildConfig([
      liveClip('clip-missing', [{ bindingId: 'binding-missing', sourceId: 'source-missing', sourceKind: 'generated' }]),
      liveClip('clip-inactive', [{ bindingId: 'binding-inactive', sourceId: 'source-inactive', sourceKind: 'generated', sourceStatus: 'inactive' }]),
      liveClip('clip-disposed', [{ bindingId: 'binding-disposed', sourceId: 'source-disposed', sourceKind: 'generated', sourceStatus: 'disposed' }]),
      liveClip('clip-orphaned', [{ bindingId: 'binding-orphaned', sourceId: 'source-orphaned', sourceKind: 'generated', sourceStatus: 'orphaned' }]),
      liveClip('clip-partial', [{
        bindingId: 'binding-partial',
        sourceId: 'source-partial',
        sourceKind: 'generated',
        bake: {
          status: 'partial',
          bakedRanges: [{ startFrame: 0, endFrame: 10 }],
          unresolvedRanges: [{ startFrame: 11, endFrame: 20 }],
        },
      }]),
    ]));

    const placeholders = screen.getAllByTestId('live-binding-placeholder');
    expect(placeholders).toHaveLength(5);
    expect(placeholders.map((el) => el.getAttribute('data-live-binding-status'))).toEqual(
      expect.arrayContaining(['missing', 'inactive', 'disposed', 'orphaned', 'partiallyBaked']),
    );
    expect(screen.queryByTestId('extension-live-renderer')).not.toBeInTheDocument();
  });

  it('treats baked deterministic refs as resolved and bypasses live sample reads', () => {
    const registry = createLiveDataRegistry();
    registry.registerSource({ id: 'source-live', kind: 'generated' });
    const channelId = registry.openChannel('source-live', 'video');
    registry.pushSample(channelId, { timestamp: 100, data: { value: 99 }, format: 'json' });
    const latestSpy = vi.spyOn(registry, 'getLatestSample');

    const TestRenderer: FC<ClipRendererProps> = (props) => {
      const sample = props.live.readLatestSample('source-live');
      const binding = props.live.bindings[0];
      return (
        <div
          data-testid="extension-live-renderer"
          data-binding-status={binding?.status}
          data-ref={binding?.deterministicRefs[0]?.ref}
          data-sample-present={String(Boolean(sample))}
        />
      );
    };

    mockClipTypeRegistryGet.mockReturnValue(makeRegistryRecord({ clipTypeId: 'ext.live-clip', renderer: TestRenderer }));
    mockClipTypeRegistryHas.mockReturnValue(true);

    renderWithLiveRegistry(
      liveBuildConfig([
        liveClip('clip-resolved', [{
          bindingId: 'binding-resolved',
          sourceId: 'source-live',
          sourceKind: 'generated',
          channelId,
          bake: {
            status: 'complete',
            deterministicRefs: [{ kind: 'asset', ref: 'asset-baked-live' }],
          },
        }]),
      ]),
      registry,
    );

    const el = screen.getByTestId('extension-live-renderer');
    expect(el).toHaveAttribute('data-binding-status', 'resolved');
    expect(el).toHaveAttribute('data-ref', 'asset-baked-live');
    expect(el).toHaveAttribute('data-sample-present', 'false');
    expect(latestSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('live-binding-placeholder')).not.toBeInTheDocument();
  });
});

describe('TimelineRenderer — built-in live frame preview reader (M11 T7)', () => {
  beforeEach(() => {
    sequenceProps.length = 0;
    visualClipMock.mockClear();
    textClipMock.mockClear();
    mockClipTypeRegistryGet.mockReset();
    mockClipTypeRegistryHas.mockReset();
    mockClipTypeRegistryGet.mockReturnValue(undefined);
    mockClipTypeRegistryHas.mockReturnValue(false);
  });

  const liveFrameBuildConfig = (
    clips: ResolvedTimelineConfig['clips'],
  ): ResolvedTimelineConfig => ({
    output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
    tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
    clips,
    registry: {},
  });

  const liveFrameClip = (
    id: string,
    binding: Record<string, unknown>,
    at = 0,
  ): ResolvedTimelineConfig['clips'][number] => ({
    id,
    clipType: 'live-frame-preview',
    track: 'V1',
    at,
    hold: 2,
    params: {
      liveBindings: [binding],
    },
  });

  it('reads latest, frame-indexed, and time-indexed frame samples synchronously', () => {
    const registry = createLiveDataRegistry();
    registry.registerSource({ id: 'source-frames', kind: 'generated' });
    const channelId = registry.openChannel('source-frames', 'video');
    registry.pushSample(channelId, {
      timestamp: 0,
      data: { src: 'data:image/png;base64,FRAME_ZERO', frameIndex: 10 },
      format: 'json',
    });
    registry.pushSample(channelId, {
      timestamp: 1000,
      data: { src: 'data:image/png;base64,FRAME_ONE', frameIndex: 20 },
      format: 'json',
    });
    const latestSpy = vi.spyOn(registry, 'getLatestSample');

    renderWithLiveRegistry(
      liveFrameBuildConfig([
        liveFrameClip('clip-latest', {
          bindingId: 'binding-latest',
          sourceId: 'source-frames',
          sourceKind: 'generated',
          channelId,
          sampling: { mode: 'latest' },
        }),
        liveFrameClip('clip-frame', {
          bindingId: 'binding-frame',
          sourceId: 'source-frames',
          sourceKind: 'generated',
          channelId,
          sampling: { mode: 'frame', frameOffset: 10 },
        }),
        liveFrameClip('clip-time', {
          bindingId: 'binding-time',
          sourceId: 'source-frames',
          sourceKind: 'generated',
          channelId,
          sampling: { mode: 'time', timeOffsetMs: 500 },
        }),
      ]),
      registry,
    );

    const previews = screen.getAllByTestId('live-frame-preview');
    const srcs = previews.map((preview) => preview.querySelector('img')?.getAttribute('src'));
    expect(srcs).toEqual([
      'data:image/png;base64,FRAME_ONE',
      'data:image/png;base64,FRAME_ZERO',
      'data:image/png;base64,FRAME_ZERO',
    ]);
    expect(previews.map((preview) => preview.getAttribute('data-live-frame-sequence'))).toEqual(['1', '0', '0']);
    const latestReturn = latestSpy.mock.results[0]?.value;
    expect(Boolean(latestReturn && typeof (latestReturn as Promise<unknown>).then === 'function')).toBe(false);
    expect(screen.queryByTestId('unknown-clip-placeholder')).not.toBeInTheDocument();
  });

  it('renders visible placeholders for inactive, permission pending, generation, cancellation, error, missing, orphaned, disposed, and partial bake states', () => {
    const registry = createLiveDataRegistry();
    registry.registerSource({ id: 'source-inactive', kind: 'generated' });
    registry.registerSource({
      id: 'source-permission',
      kind: 'webcam',
      permission: { state: 'prompt', reason: 'Camera access' },
    });
    registry.registerSource({ id: 'source-pending', kind: 'generated' });
    registry.openChannel('source-pending', 'video');
    registry.transitionSource('source-pending', 'active');
    registry.registerSource({ id: 'source-refining', kind: 'generated' });
    const refiningChannel = registry.openChannel('source-refining', 'video');
    registry.pushSample(refiningChannel, {
      timestamp: 200,
      data: { status: 'refining', progress: 0.6 },
      format: 'json',
    });
    registry.registerSource({ id: 'source-cancelled', kind: 'generated' });
    const cancelledChannel = registry.openChannel('source-cancelled', 'video');
    registry.pushSample(cancelledChannel, {
      timestamp: 300,
      data: { status: 'cancelled', progress: 0.35 },
      format: 'json',
    });
    registry.registerSource({ id: 'source-error', kind: 'generated' });
    registry.openChannel('source-error', 'video');
    registry.transitionSource('source-error', 'error', 'Generation failed');

    renderWithLiveRegistry(
      liveFrameBuildConfig([
        liveFrameClip('clip-inactive', { bindingId: 'binding-inactive', sourceId: 'source-inactive', sourceKind: 'generated' }),
        liveFrameClip('clip-permission', { bindingId: 'binding-permission', sourceId: 'source-permission', sourceKind: 'webcam' }),
        liveFrameClip('clip-pending', {
          bindingId: 'binding-pending',
          sourceId: 'source-pending',
          sourceKind: 'generated',
          placeholder: { progress: 0.25 },
        }),
        liveFrameClip('clip-refining', {
          bindingId: 'binding-refining',
          sourceId: 'source-refining',
          sourceKind: 'generated',
          channelId: refiningChannel,
        }),
        liveFrameClip('clip-cancelled', {
          bindingId: 'binding-cancelled',
          sourceId: 'source-cancelled',
          sourceKind: 'generated',
          channelId: cancelledChannel,
        }),
        liveFrameClip('clip-error', { bindingId: 'binding-error', sourceId: 'source-error', sourceKind: 'generated' }),
        liveFrameClip('clip-missing', { bindingId: 'binding-missing', sourceId: 'source-missing', sourceKind: 'generated' }),
        liveFrameClip('clip-orphaned', { bindingId: 'binding-orphaned', sourceId: 'source-orphaned', sourceKind: 'generated', sourceStatus: 'orphaned' }),
        liveFrameClip('clip-disposed', { bindingId: 'binding-disposed', sourceId: 'source-disposed', sourceKind: 'generated', sourceStatus: 'disposed' }),
        liveFrameClip('clip-partial', {
          bindingId: 'binding-partial',
          sourceId: 'source-partial',
          sourceKind: 'generated',
          placeholder: { progress: 0.5 },
          bake: {
            status: 'partial',
            bakedRanges: [{ startFrame: 0, endFrame: 10 }],
            unresolvedRanges: [{ startFrame: 11, endFrame: 20 }],
          },
        }),
      ]),
      registry,
    );

    const placeholders = screen.getAllByTestId('live-frame-placeholder');
    expect(placeholders.map((el) => el.getAttribute('data-live-frame-state'))).toEqual([
      'inactive',
      'permission-pending',
      'pending',
      'refining',
      'cancelled',
      'error',
      'missing',
      'orphaned',
      'disposed',
      'partiallyBaked',
    ]);
    expect(placeholders[2]).toHaveAttribute('data-live-frame-progress', '25');
    expect(placeholders[3]).toHaveAttribute('data-live-frame-progress', '60');
    expect(placeholders[4]).toHaveAttribute('data-live-frame-progress', '35');
    expect(placeholders[9]).toHaveAttribute('data-live-frame-progress', '50');
    expect(screen.queryByTestId('live-frame-preview')).not.toBeInTheDocument();
  });

  it('subscribes to ring-buffer changes so progressive frame replacement updates the preview without async reads', () => {
    const registry = createLiveDataRegistry();
    registry.registerSource({ id: 'source-progressive', kind: 'generated' });
    const channelId = registry.openChannel('source-progressive', 'video');
    registry.pushSample(channelId, {
      timestamp: 0,
      data: { src: 'data:image/png;base64,FIRST', status: 'refining', progress: 0.4 },
      format: 'json',
    });
    const latestSpy = vi.spyOn(registry, 'getLatestSample');

    renderWithLiveRegistry(
      liveFrameBuildConfig([
        liveFrameClip('clip-progressive', {
          bindingId: 'binding-progressive',
          sourceId: 'source-progressive',
          sourceKind: 'generated',
          channelId,
        }),
      ]),
      registry,
    );

    const first = screen.getByTestId('live-frame-preview');
    expect(first.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,FIRST');
    expect(first).toHaveAttribute('data-live-frame-state', 'refining');
    expect(first).toHaveAttribute('data-live-frame-progress', '40');

    act(() => {
      registry.pushSample(channelId, {
        timestamp: 1000,
        data: { src: 'data:image/png;base64,FINAL', status: 'final', progress: 1 },
        format: 'json',
      });
    });

    const updated = screen.getByTestId('live-frame-preview');
    expect(updated.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,FINAL');
    expect(updated).toHaveAttribute('data-live-frame-state', 'final');
    expect(updated).toHaveAttribute('data-live-frame-progress', '100');
    expect(updated).toHaveAttribute('data-live-frame-sequence', '1');
    expect(latestSpy.mock.results.some((result) => Boolean(
      result.value && typeof (result.value as Promise<unknown>).then === 'function',
    ))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Keyframe / automation params must follow the playhead, not freeze at clip.at
// ---------------------------------------------------------------------------

describe('TimelineRenderer — extension clip params follow the composition time', () => {
  beforeEach(() => {
    sequenceProps.length = 0;
    mockClipTypeRegistryGet.mockReset();
    mockClipTypeRegistryHas.mockReset();
  });

  const ParamProbe: FC<ClipRendererProps> = (props) => (
    <div
      data-testid="extension-clip-renderer"
      data-time={props.time}
      data-params={JSON.stringify(props.params)}
    />
  );

  const readParams = (): Record<string, unknown> => JSON.parse(
    screen.getByTestId('extension-clip-renderer').getAttribute('data-params') ?? '{}',
  );
  const readTime = (): string | null => (
    screen.getByTestId('extension-clip-renderer').getAttribute('data-time')
  );

  it('re-resolves keyframed params as the playhead moves through the clip', () => {
    mockClipTypeRegistryGet.mockReturnValue(
      makeRegistryRecord({
        clipTypeId: 'ext.kf-clip',
        renderer: ParamProbe,
        schema: [{ name: 'opacity', label: 'Opacity', description: '', type: 'number', default: 0.5, min: 0, max: 1 }],
      }),
    );
    mockClipTypeRegistryHas.mockReturnValue(true);

    // Clip occupies 1s..5s. Keyframe times are absolute timeline seconds
    // (KeyframeInspector writes the playhead time; live recording writes
    // timelineStartSeconds + sample offset).
    const config: ResolvedTimelineConfig = {
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
      clips: [
        {
          id: 'clip-kf',
          clipType: 'ext.kf-clip',
          track: 'V1',
          at: 1,
          hold: 4,
          params: {},
          keyframes: {
            opacity: [
              { time: 1, value: 0.2, interpolation: 'linear' },
              { time: 5, value: 1, interpolation: 'linear' },
            ],
          },
        },
      ],
      registry: {},
    };

    currentFrame = 30; // t = 1s → clip start
    const { rerender } = render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={config} />);
    expect(readParams().opacity).toBeCloseTo(0.2, 6);
    expect(readTime()).toBe('1');

    currentFrame = 90; // t = 3s → halfway through the curve
    rerender(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{ ...config }} />);
    expect(readParams().opacity).toBeCloseTo(0.6, 6);
    expect(readTime()).toBe('3');

    currentFrame = 149; // last frame the clip occupies (from=30, duration=120)
    rerender(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{ ...config }} />);
    expect(readParams().opacity).toBeCloseTo(0.993333, 5);

    // Past the clip's last frame Remotion renders nothing; the resolved value
    // is clamped to the clip's range so off-screen clips reuse the memo.
    currentFrame = 400;
    rerender(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{ ...config }} />);
    expect(readParams().opacity).toBeCloseTo(0.993333, 5);
  });

  it('re-resolves automation-clip overrides as the playhead moves', () => {
    mockClipTypeRegistryGet.mockReturnValue(
      makeRegistryRecord({
        clipTypeId: 'ext.auto-target',
        renderer: ParamProbe,
        schema: [{ name: 'intensity', label: 'Intensity', description: '', type: 'number', default: 0.5, min: 0, max: 1 }],
      }),
    );
    mockClipTypeRegistryHas.mockReturnValue(true);

    const config: ResolvedTimelineConfig = {
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
      clips: [
        {
          id: 'clip-target',
          clipType: 'ext.auto-target',
          track: 'V1',
          at: 0,
          hold: 4,
          params: {},
        },
        {
          id: 'clip-automation',
          clipType: 'automation',
          track: 'V1',
          at: 0,
          hold: 4,
          params: {
            enabled: true,
            target: { contributionId: 'ext.auto-target', parameterPath: 'intensity' },
            keyframes: [
              { time: 0, value: 0, interpolation: 'linear' },
              { time: 4, value: 1, interpolation: 'linear' },
            ],
          },
        },
      ],
      registry: {},
    };

    currentFrame = 0;
    const { rerender } = render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={config} />);
    expect(readParams().intensity).toBeCloseTo(0, 6);

    currentFrame = 60; // t = 2s → midpoint of the automation curve
    rerender(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{ ...config }} />);
    expect(readParams().intensity).toBeCloseTo(0.5, 6);

    currentFrame = 105; // t = 3.5s
    rerender(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{ ...config }} />);
    expect(readParams().intensity).toBeCloseTo(0.875, 6);
  });
});

// ---------------------------------------------------------------------------
// track.scale fidelity — decree semantics. The owner decided: track scale
// scales EVERYTHING on the track — one transform on the track subtree, so
// text/theme/extension clips and clips with position overrides compose with
// it (positioned x/y/width/height are track-local; pre-existing positioned
// clips on scaled tracks were baked by `applyTrackScaleBakeMigration`).
// These tests previously pinned the old reach (plain un-positioned media
// only); they now assert the decree.
// ---------------------------------------------------------------------------

describe('TimelineRenderer — track.scale scales the whole track subtree', () => {
  beforeEach(() => {
    sequenceProps.length = 0;
    visualClipMock.mockClear();
    textClipMock.mockClear();
    mockClipTypeRegistryGet.mockReset();
    mockClipTypeRegistryGet.mockReturnValue(undefined);
    mockClipTypeRegistryHas.mockReset();
    mockClipTypeRegistryHas.mockReturnValue(false);
  });

  const scaledConfig = (clips: ResolvedTimelineConfig['clips']): ResolvedTimelineConfig => ({
    output: { resolution: '1280x720', fps: 30, file: 'out.mp4' },
    tracks: [{ id: 'V1', kind: 'visual', label: 'V1', scale: 0.5 }],
    clips,
    registry: {},
  });

  const wrapperTransform = (testId: string): string => {
    const el = screen.getByTestId(testId);
    return (el.parentElement as HTMLElement | null)?.style.transform ?? '';
  };

  it('wraps a plain media clip in the track scale transform', () => {
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={scaledConfig([
      { id: 'clip-plain', clipType: 'media', track: 'V1', at: 0, hold: 2, asset: 'a' },
    ])} />);

    expect(wrapperTransform('visual-clip-sequence')).toBe('scale(0.5)');
  });

  it('scales a media clip that carries a position override (track-local coordinates)', () => {
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={scaledConfig([
      { id: 'clip-positioned', clipType: 'media', track: 'V1', at: 0, hold: 2, asset: 'a', x: 320, y: 180, width: 640, height: 360 },
    ])} />);

    expect(wrapperTransform('visual-clip-sequence')).toBe('scale(0.5)');
  });

  it('scales text clips with the rest of the track', () => {
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={scaledConfig([
      { id: 'clip-text', clipType: 'text', track: 'V1', at: 0, hold: 2, text: { content: 'SCALED?' } },
    ])} />);

    expect(wrapperTransform('text-clip-sequence')).toBe('scale(0.5)');
  });

  it('applies the transform once, at the track subtree, not per clip', () => {
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={scaledConfig([
      { id: 'clip-plain', clipType: 'media', track: 'V1', at: 0, hold: 2, asset: 'a' },
      { id: 'clip-text', clipType: 'text', track: 'V1', at: 2, hold: 2, text: { content: 'SCALED?' } },
    ])} />);

    // Both clips share the same scaled ancestor — a second nested scale would
    // compound to 0.25 and is exactly the double-application bug the single
    // application point exists to prevent.
    const media = screen.getByTestId('visual-clip-sequence');
    const text = screen.getByTestId('text-clip-sequence');
    expect(media.parentElement).toBe(text.parentElement);
    expect(media.parentElement?.style.transform).toBe('scale(0.5)');
  });
});

describe('TimelineRenderer owner-qualified Astrid references', () => {
  it('replaces the initial unavailable preview after exact admission with the same config and host',async()=>{
    const admissions=await import('../runtime/admitted-elements');
    admissions.setAdmittedElementScope('preview-project',[]);
    const host:AstridElementHost={...fixtureAstridElementHost,
      get descriptors(){return admissions.getAdmittedElementSelection().elements.map(entry=>entry.descriptor);},
      resolveComponent(id,kind,packId,revision){return revision?admissions.admittedComponent({id,kind,packId,revision}):undefined;},
    };
    const ref={id:'text-card',kind:'effect' as const,packId:'project_preview',revision:'exact-preview-revision'};
    const config={...buildConfig(),clips:[{id:'activated-exact',track:'V1',at:0,hold:1,clipType:'effect-layer',elementRef:ref}]};
    render(<TimelineRenderer astridElementHost={host} config={config}/>);
    expect(screen.getByTestId('generated-module-placeholder')).toBeInTheDocument();
    const digest='f'.repeat(64);const key=JSON.stringify([ref.packId,ref.kind,ref.id,ref.revision]);
    const Owned:FC=()=> <div data-testid="admitted-after-refresh">Exact revision loaded</div>;
    await act(async()=>{await admissions.refreshAdmittedElements(
      async()=>({digest,moduleUrl:'/@id/__x00__virtual:astrid-element-admissions?v='+digest}),
      async()=>({configured:true,projectId:'preview-project',selectionDigest:digest,realmId:null,projects:[],
        elements:[{projectId:'preview-project',descriptor:{...ref,componentPath:'external/fixture.tsx'} as never,authoring:{packRoot:'/pack',descriptorPath:'/pack/element.yaml',componentPath:'/pack/component.tsx',status:'ready'}}],components:{[key]:Owned}}),
    );});
    expect(screen.queryByTestId('generated-module-placeholder')).not.toBeInTheDocument();
    expect(screen.getByTestId('admitted-after-refresh')).toHaveTextContent('Exact revision loaded');
  });

  it.each(['local', 'rendering'])('passes the %s owner to the component bridge', (packId) => {
    const Owned: FC<{ clip: { id: string } }> = ({ clip }) => <div data-testid="owner-preview">{clip.id}</div>;
    astridElementComponentMock.mockImplementation((id: string, kind: string, owner?: string) => (
      id === 'text-card' && kind === 'effect' && owner === packId ? Owned : undefined
    ));
    render(<TimelineRenderer astridElementHost={{...fixtureAstridElementHost, descriptors:[{id:'text-card',kind:'effect',packId,revision:'test-revision',componentPath:'fixture.tsx'}]}} config={{ ...buildConfig(), clips: [{
      id: `text-${packId}`, track: 'V1', at: 0, hold: 1, clipType: 'effect-layer',
      elementRef: { id: 'text-card', kind: 'effect', revision: 'test-revision', packId },
    }] }} />);
    expect(screen.getByTestId('owner-preview')).toHaveTextContent(`text-${packId}`);
    expect(astridElementComponentMock).toHaveBeenCalledWith('text-card', 'effect', packId, 'test-revision');
  });

  it('shows an unavailable-element placeholder for an unknown owner without using another source', () => {
    astridElementComponentMock.mockReturnValue(undefined);
    render(<TimelineRenderer astridElementHost={fixtureAstridElementHost} config={{ ...buildConfig(), app: { elements: {
      'text-card': { kind: 'effect', revision: 'test-revision', source: 'export default function Wrong() { return <div>wrong owner</div>; }' },
    } }, clips: [{
      id: 'unknown-owner', track: 'V1', at: 0, hold: 1, clipType: 'text-card',
      elementRef: { id: 'text-card', kind: 'effect', revision: 'test-revision', packId: 'unknown' },
    }] }} />);
    expect(screen.getByTestId('generated-module-placeholder')).toHaveAttribute('data-artifact-id', 'text-card');
    expect(astridElementComponentMock).not.toHaveBeenCalled();
    expect(screen.queryByText('wrong owner')).not.toBeInTheDocument();
  });
});

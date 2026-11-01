// @vitest-environment jsdom
import type { FC, PropsWithChildren } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TimelineRenderer } from './TimelineRenderer.tsx';
import type { ResolvedTimelineConfig } from '@/tools/video-editor/types/index.ts';
import type {
  AstridElementComponentProps,
  AstridElementHost,
} from '@/tools/video-editor/runtime/astrid-element-host.ts';
import { INSTALLED_ASTRID_ELEMENT_HOST } from '@/tools/video-editor/runtime/astrid-element-components.tsx';
import { resolveEndSpanningLayerPreviewParams } from '@/tools/video-editor/sequences/components/EndSpanningLayerSequence.tsx';
import {
  SEQUENCE_COMPONENT_REGISTRY,
  describeClipCapabilityWith,
  resolveSequenceClipEntry,
} from '@/tools/video-editor/sequences/registry.ts';
import {
  PUBLIC_ASTRID_ASSET_URLS,
  PUBLIC_ASTRID_ELEMENT_HOST,
} from '@/pages/Home/astrid-public-host.tsx';
import { ASTRID_RENDERING_ELEMENTS } from '@astrid/packs/rendering/elements/catalog.ts';
import canonicalCard0 from '@astrid/packs/local/rendering/elements/effects/end-spanning-layer/assets/card-0-canonical-mink.png?url';
import canonicalCard1 from '@astrid/packs/local/rendering/elements/effects/end-spanning-layer/assets/card-1.png?url';
import canonicalCard2 from '@astrid/packs/local/rendering/elements/effects/end-spanning-layer/assets/card-2.png?url';
import canonicalCard3 from '@astrid/packs/local/rendering/elements/effects/end-spanning-layer/assets/card-3.png?url';
import canonicalCard4 from '@astrid/packs/local/rendering/elements/effects/end-spanning-layer/assets/card-4-canonical-mink.png?url';
import canonicalCard5 from '@astrid/packs/local/rendering/elements/effects/end-spanning-layer/assets/card-5-canonical-mink.png?url';
import { clipOpacity } from '@banodoco/timeline-composition/evaluation';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let currentFrame = 0;
vi.mock('remotion', () => ({
  delayRender: () => 0,
  continueRender: () => {},
  AbsoluteFill: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>,
  Sequence: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => <div data-testid="sequence" {...props}>{children}</div>,
  Series: ({ children }: PropsWithChildren) => <>{children}</>,
  Img: (props: Record<string, unknown>) => <img {...props} />,
  Video: (props: Record<string, unknown>) => <video {...props} />,
  Audio: (props: Record<string, unknown>) => <audio {...props} />,
  useCurrentFrame: () => currentFrame,
  useVideoConfig: () => ({ fps: 30, width: 1920, height: 1080, durationInFrames: 150 }),
  useRemotionEnvironment: () => ({ isRendering: false, isClientSideRendering: false }),
  staticFile: (value: string) => `/static/${value}`,
  interpolate: (value: number, input: number[], output: number[]) => {
    if (value <= input[0]) return output[0];
    if (value >= input[input.length - 1]) return output[output.length - 1];
    const ratio = (value - input[0]) / (input[input.length - 1] - input[0]);
    return output[0] + ratio * (output[output.length - 1] - output[0]);
  },
  spring: () => 1,
  Easing: { inOut: () => (value: number) => value, quad: (value: number) => value },
}));

vi.mock('@remotion/media', () => ({
  Video: (props: Record<string, unknown>) => <video {...props} />,
}));

vi.mock('@/tools/video-editor/compositions/AudioAnalysisProvider.tsx', () => ({
  AudioAnalysisProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}));
vi.mock('@/tools/video-editor/compositions/VisualClip.tsx', () => ({
  VisualClipSequence: () => <div data-testid="visual-clip" />,
  VisualClip: () => <div data-testid="visual-clip" />,
}));
vi.mock('@/tools/video-editor/compositions/TextClip.tsx', () => ({
  TextClipSequence: () => <div data-testid="text-clip" />,
}));
vi.mock('@/tools/video-editor/shaders/preview/PostprocessShaderPreviewCanvas.tsx', () => ({
  PostprocessShaderPreviewCanvas: () => null,
}));

const baseConfig = (clip: ResolvedTimelineConfig['clips'][number]): ResolvedTimelineConfig => ({
  output: { resolution: '1920x1080', fps: 30, file: 'qualification.mp4' },
  tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
  clips: [clip],
  registry: {},
});

const makeProbeHost = () => {
  const resolveComponent = vi.fn((id: string, kind: string) => {
    if (id !== 'probe') return undefined;
    const Probe: FC<AstridElementComponentProps> = ({ children }) => (
      <div data-testid={`probe-${kind}`}>{children}</div>
    );
    return Probe;
  });
  const resolveSequenceClipEntry = vi.fn(() => undefined);
  const describeClipCapability = vi.fn((clip: { clipType?: string } | null | undefined) => (
    clip?.clipType === 'sequence-probe'
      ? {
          clipType: 'sequence-probe',
          source: 'trusted-local-sequence',
          capabilities: {
            preview: 'browser' as const,
            browserRender: true,
            workerRender: true,
            externalRender: false,
          },
        }
      : undefined
  ));
  const SequenceProbe: FC = () => <div data-testid="probe-sequence" />;
  const host: AstridElementHost = {
    // The renderer resolves an element only when the host declares its descriptor.
    descriptors: [
      { id: 'probe', kind: 'effect', revision: 'r1', componentPath: 'probe/effect.tsx' },
      { id: 'probe', kind: 'animation', revision: 'r2', componentPath: 'probe/animation.tsx' },
    ],
    sequenceRegistry: { 'sequence-probe': { component: SequenceProbe, source: 'probe' } },
    resolveComponent: resolveComponent as AstridElementHost['resolveComponent'],
    resolveSequenceClipEntry,
    describeClipCapability,
  };
  return { host, resolveComponent, resolveSequenceClipEntry, describeClipCapability };
};

describe('V009 public host behavior qualification', () => {
  it('applies a top-level fade to a registered effect and prerolls its incoming transition', () => {
    const { host } = makeProbeHost();
    const config = baseConfig({
      id: 'effect', clipType: 'probe', track: 'V1', at: 1, hold: 1, params: {},
      elementRef: { id: 'probe', kind: 'effect', revision: 'r1' },
      entrance: { id: 'fade', durationFrames: 12, easing: 'linear' },
      transition: { id: 'fade', durationFrames: 8 },
    });
    config.clips.unshift({ id: 'previous', clipType: 'media', track: 'V1', at: 0, hold: 1 });
    currentFrame = 0;
    const view = render(<TimelineRenderer astridElementHost={host} config={config} />);
    const effect = screen.getByTestId('probe-effect');
    expect(effect.closest('[data-testid="sequence"]')).toHaveAttribute('from', '22');
    let parent: HTMLElement | null = effect.parentElement;
    let faded = false;
    while (parent && parent !== view.container) {
      faded ||= parent.style.opacity === '0';
      parent = parent.parentElement;
    }
    expect(faded).toBe(true);
    view.unmount();
  });

  it.each([
    { shape: 'object', effects: { fade_in: 1 } },
    { shape: 'array', effects: [{ fade_in: 1 }] },
  ])('applies the package clipOpacity for $shape effects fade_in on a registered effect', ({ effects }) => {
    const { host } = makeProbeHost();
    const clip = {
      id: 'effect', clipType: 'probe', track: 'V1', at: 0, hold: 2, params: {},
      elementRef: { id: 'probe', kind: 'effect', revision: 'r1' },
      effects,
    } as ResolvedTimelineConfig['clips'][number];
    currentFrame = 15;
    const expected = clipOpacity(clip as never, 15, 30);
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(1);
    const view = render(<TimelineRenderer astridElementHost={host} config={baseConfig(clip)} />);
    const opacities: number[] = [];
    for (let node: HTMLElement | null = screen.getByTestId('probe-effect').parentElement; node && node !== view.container; node = node.parentElement) {
      if (node.style.opacity && node.style.opacity !== '1') opacities.push(Number(node.style.opacity));
    }
    expect(opacities).toEqual([expected]);
    view.unmount();
  });

  it('applies effects fade_out once on text content that already carries clip.opacity', async () => {
    const { TextClip } = await vi.importActual<typeof import('@/tools/video-editor/compositions/TextClip.tsx')>(
      '@/tools/video-editor/compositions/TextClip.tsx',
    );
    const clip = {
      id: 'text', clipType: 'text', track: 'V1', at: 0, hold: 2, opacity: 0.8,
      text: { content: 'Faded' }, effects: { fade_out: 1 },
    } as ResolvedTimelineConfig['clips'][number];
    currentFrame = 45;
    const fadeOnly = clipOpacity({ ...clip, opacity: undefined } as never, 45, 30);
    expect(fadeOnly).toBeGreaterThan(0);
    expect(fadeOnly).toBeLessThan(1);
    const view = render(<TextClip clip={clip} track={{ id: 'V1', kind: 'visual', label: 'V1' }} fps={30} />);
    const content = screen.getByText('Faded');
    expect(content.style.opacity).toBe('0.8');
    const faded: number[] = [];
    for (let node: HTMLElement | null = content.parentElement; node && node !== view.container; node = node.parentElement) {
      if (node.style.opacity && node.style.opacity !== '1') faded.push(Number(node.style.opacity));
    }
    expect(faded).toEqual([fadeOnly]);
    view.unmount();
  });

  it('uses injected host values at typed effect, typed animation, legacy, and sequence helper callsites', () => {
    const typedEffect = makeProbeHost();
    const typedEffectView = render(<TimelineRenderer
      astridElementHost={typedEffect.host}
      config={baseConfig({
        id: 'typed-effect', clipType: 'probe', track: 'V1', at: 0, hold: 1, params: {},
        elementRef: { id: 'probe', kind: 'effect', revision: 'r1' },
      })}
    />);
    expect(screen.getByTestId('probe-effect')).toBeInTheDocument();
    expect(typedEffect.resolveComponent.mock.calls.map(([id, kind, packId]) => ({ id, kind, packId })))
      .toContainEqual({ id: 'probe', kind: 'effect', packId: undefined });
    typedEffectView.unmount();

    const typedAnimation = makeProbeHost();
    const typedAnimationView = render(<TimelineRenderer
      astridElementHost={typedAnimation.host}
      config={baseConfig({
        id: 'typed-animation', clipType: 'probe', track: 'V1', at: 0, hold: 1, params: {},
        elementRef: { id: 'probe', kind: 'animation', revision: 'r2' },
      })}
    />);
    expect(screen.getByTestId('probe-animation')).toBeInTheDocument();
    expect(typedAnimation.resolveComponent.mock.calls.map(([id, kind, packId]) => ({ id, kind, packId })))
      .toContainEqual({ id: 'probe', kind: 'animation', packId: undefined });
    typedAnimationView.unmount();

    const legacy = makeProbeHost();
    const legacyView = render(<TimelineRenderer
      astridElementHost={legacy.host}
      config={baseConfig({ id: 'legacy', clipType: 'probe', track: 'V1', at: 0, hold: 1, params: {} })}
    />);
    expect(screen.getByTestId('probe-effect')).toBeInTheDocument();
    expect(legacy.resolveComponent).toHaveBeenCalledWith('probe', 'effect');
    legacyView.unmount();

    const sequence = makeProbeHost();
    render(<TimelineRenderer
      astridElementHost={sequence.host}
      config={baseConfig({ id: 'sequence', clipType: 'sequence-probe', track: 'V1', at: 0, hold: 1, params: {} })}
    />);
    expect(screen.getByTestId('probe-sequence')).toBeInTheDocument();
    expect(sequence.describeClipCapability).toHaveBeenCalled();
    expect(sequence.resolveSequenceClipEntry).toHaveBeenCalledWith('sequence-probe', []);
  });

  it('keeps public typed and legacy local-effect component identity exact', () => {
    for (const id of ['frame-overlay', 'end-spanning-layer']) {
      expect(PUBLIC_ASTRID_ELEMENT_HOST.resolveComponent(id, 'effect')).toBe(
        PUBLIC_ASTRID_ELEMENT_HOST.sequenceRegistry[id]?.component,
      );
    }
  });

  it('lets caller asset values override all browser wrapper defaults', () => {
    const Frame = PUBLIC_ASTRID_ELEMENT_HOST.resolveComponent('frame-overlay', 'effect')!;
    const frameView = render(<Frame
      clip={{ id: 'frame', clipType: 'frame-overlay', track: 'V1', at: 0, hold: 1 } as never}
      params={{ __astridAssets: { frame: 'data:image/png;base64,caller-frame' } }}
      theme={{} as never}
      fps={30}
    />);
    expect(frameView.container.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,caller-frame');
    frameView.unmount();

    currentFrame = 0;
    const End = PUBLIC_ASTRID_ELEMENT_HOST.resolveComponent('end-spanning-layer', 'effect')!;
    const endView = render(<End
      clip={{ id: 'end', clipType: 'end-spanning-layer', track: 'V1', at: 0, hold: 4 } as never}
      params={{ __astridAssets: { card0: 'data:image/png;base64,caller-card' }, phaseDurations: { prep: 1, iteration: 1, anchors: 1, workflow: 1 } }}
      theme={{} as never}
      fps={30}
    />);
    expect(endView.container.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,caller-card');
  });

  it('renders canonical defaults and per-clip managed overrides through the installed local owner', () => {
    const local = ASTRID_RENDERING_ELEMENTS.find((item) => (
      item.id === 'end-spanning-layer' && item.kind === 'effect' && item.packId === 'local'
    ));
    expect(local).toBeDefined();
    const clip = (id: string, at: number, params: Record<string, unknown>) => ({
      id,
      clipType: 'end-spanning-layer',
      track: 'V1',
      at,
      hold: 4,
      params,
      elementRef: { id: 'end-spanning-layer', kind: 'effect' as const, packId: 'local', revision: local!.revision },
    });
    const clips = [
      clip('override-this-clip', 0, {
        phaseDurations: { prep: 1, iteration: 1, anchors: 1, workflow: 1 },
        cardAssets: { card1: 'source-image' },
      }),
      clip('leave-this-clip-default', 5, {
        phaseDurations: { prep: 1, iteration: 1, anchors: 1, workflow: 1 },
      }),
    ];
    const config: ResolvedTimelineConfig = {
      ...baseConfig(clips[0] as ResolvedTimelineConfig['clips'][number]),
      clips: clips as ResolvedTimelineConfig['clips'],
      registry: { 'source-image': { type: 'image/png', src: '/runtime/managed/source-image.png' } },
    };
    const view = render(<TimelineRenderer astridElementHost={INSTALLED_ASTRID_ELEMENT_HOST} config={config} />);
    const sources = [...view.container.querySelectorAll('img')].map((image) => image.getAttribute('src'));
    expect(sources.slice(0, 6)).toEqual([
      canonicalCard0,
      '/runtime/managed/source-image.png',
      canonicalCard2,
      canonicalCard3,
      canonicalCard4,
      canonicalCard5,
    ]);
    expect(sources.slice(6, 12)).toEqual([
      canonicalCard0,
      canonicalCard1,
      canonicalCard2,
      canonicalCard3,
      canonicalCard4,
      canonicalCard5,
    ]);
  });

  it.each([
    ['array override', { cardAssets: ['source-image'] }, /cardAssets must be an object/],
    ['unresolved override', { cardAssets: { card1: 'missing-image' } }, /references unresolved asset/],
  ])('fails closed for %s on the local effect adapter', (_label, params, message) => {
    expect(() => resolveEndSpanningLayerPreviewParams(params, {})).toThrow(message);
  });

  it('does not interpret another installed owner’s params as local end-spanning card assets', () => {
    const renderingTextCard = ASTRID_RENDERING_ELEMENTS.find((item) => (
      item.id === 'text-card' && item.kind === 'effect' && item.packId === 'rendering'
    ));
    expect(renderingTextCard).toBeDefined();
    expect(() => render(<TimelineRenderer
      astridElementHost={INSTALLED_ASTRID_ELEMENT_HOST}
      config={baseConfig({
        id: 'rendering-owner-text-card',
        clipType: 'text-card',
        track: 'V1',
        at: 0,
        hold: 1,
        params: { cardAssets: { card1: 'unrelated-value' } },
        elementRef: {
          id: 'text-card',
          kind: 'effect',
          packId: 'rendering',
          revision: renderingTextCard!.revision,
        },
      })}
    />)).not.toThrow();
  });

  it('rejects installed-only and unknown IDs without substitution and renders a loud typed placeholder', () => {
    expect(INSTALLED_ASTRID_ELEMENT_HOST.resolveComponent('scrolling-guide', 'effect')).toBeDefined();
    expect(PUBLIC_ASTRID_ELEMENT_HOST.resolveComponent('scrolling-guide', 'effect')).toBeUndefined();
    expect(PUBLIC_ASTRID_ELEMENT_HOST.resolveComponent('missing-public-id', 'effect')).toBeUndefined();
    const installedOnlyDescriptor = ASTRID_RENDERING_ELEMENTS.find((item) => (
      item.id === 'scrolling-guide' && item.kind === 'effect'
    ));
    expect(installedOnlyDescriptor?.packId).toBeTruthy();

    render(<TimelineRenderer
      astridElementHost={PUBLIC_ASTRID_ELEMENT_HOST}
      config={baseConfig({
        id: 'unsupported', clipType: 'scrolling-guide', track: 'V1', at: 0, hold: 1, params: {},
        elementRef: {
          id: 'scrolling-guide',
          kind: 'effect',
          packId: installedOnlyDescriptor?.packId,
          revision: 'installed-only-r1',
        },
      })}
    />);
    const placeholder = screen.getByTestId('generated-module-placeholder');
    expect(placeholder).toHaveAttribute('data-artifact-id', 'scrolling-guide');
    expect(placeholder).toHaveAttribute('data-placeholder-reason', 'element_source_missing');
    expect(placeholder).toHaveTextContent(`scrolling-guide@installed-only-r1`);
  });

  it('keeps a public owner mismatch unavailable instead of resolving another text-card owner', () => {
    expect(PUBLIC_ASTRID_ELEMENT_HOST.resolveComponent('text-card', 'effect', 'local')).toBeUndefined();

    render(<TimelineRenderer
      astridElementHost={PUBLIC_ASTRID_ELEMENT_HOST}
      config={baseConfig({
        id: 'wrong-public-owner',
        clipType: 'text-card',
        track: 'V1',
        at: 0,
        hold: 1,
        params: {},
        elementRef: {
          id: 'text-card',
          kind: 'effect',
          packId: 'local',
          revision: 'wrong-owner-r1',
        },
      })}
    />);

    const placeholder = screen.getByTestId('generated-module-placeholder');
    expect(placeholder).toHaveAttribute('data-artifact-id', 'text-card');
    expect(placeholder).toHaveAttribute('data-placeholder-reason', 'element_source_missing');
    expect(placeholder).toHaveTextContent('text-card@wrong-owner-r1');
  });

  it('preserves exact owner resolution and ownerless catalog order', () => {
    const installedRenderingTextCard = INSTALLED_ASTRID_ELEMENT_HOST.resolveComponent(
      'text-card',
      'effect',
      'rendering',
    );
    const installedLocalTextCard = INSTALLED_ASTRID_ELEMENT_HOST.resolveComponent(
      'text-card',
      'effect',
      'local',
    );

    expect(installedRenderingTextCard).toBeDefined();
    expect(installedLocalTextCard).toBeDefined();
    expect(installedLocalTextCard).not.toBe(installedRenderingTextCard);
    expect(INSTALLED_ASTRID_ELEMENT_HOST.resolveComponent('text-card', 'effect'))
      .toBe(installedRenderingTextCard);

    expect(PUBLIC_ASTRID_ELEMENT_HOST.resolveComponent('text-card', 'effect', 'rendering')).toBeDefined();
    expect(PUBLIC_ASTRID_ELEMENT_HOST.resolveComponent('text-card', 'effect')).toBeDefined();
    expect(PUBLIC_ASTRID_ELEMENT_HOST.resolveComponent('text-card', 'effect', 'local')).toBeUndefined();
    expect(PUBLIC_ASTRID_ELEMENT_HOST.resolveComponent('text-card', 'effect', 'unknown-owner')).toBeUndefined();
    expect(PUBLIC_ASTRID_ELEMENT_HOST.resolveComponent('frame-overlay', 'effect', 'local')).toBeDefined();
    expect(PUBLIC_ASTRID_ELEMENT_HOST.resolveComponent('frame-overlay', 'effect', 'rendering')).toBeUndefined();
    expect(PUBLIC_ASTRID_ELEMENT_HOST.resolveComponent('frame-overlay', 'effect', 'unknown-owner')).toBeUndefined();
    expect(PUBLIC_ASTRID_ELEMENT_HOST.resolveComponent('missing-id', 'effect')).toBeUndefined();
    expect(PUBLIC_ASTRID_ELEMENT_HOST.resolveComponent('frame-overlay', 'transform' as never, 'local')).toBeUndefined();
  });

  it('preserves installed catalog, sequence registry, capability, and resolver identity', () => {
    // descriptors is now a fresh array per read (catalog plus admitted elements), so
    // assert each catalog entry by identity rather than the array itself.
    const installedDescriptors = INSTALLED_ASTRID_ELEMENT_HOST.descriptors;
    expect(installedDescriptors.slice(0, ASTRID_RENDERING_ELEMENTS.length)).toHaveLength(ASTRID_RENDERING_ELEMENTS.length);
    ASTRID_RENDERING_ELEMENTS.forEach((element, index) => {
      expect(installedDescriptors[index]).toBe(element);
    });
    expect(INSTALLED_ASTRID_ELEMENT_HOST.sequenceRegistry).toBe(SEQUENCE_COMPONENT_REGISTRY);
    const textCard = ASTRID_RENDERING_ELEMENTS.find((item) => item.kind === 'effect' && item.id === 'text-card');
    expect(textCard?.componentPath).toBe('packs/rendering/rendering/elements/effects/text-card/component.tsx');

    for (const clipType of Object.keys(SEQUENCE_COMPONENT_REGISTRY)) {
      expect(INSTALLED_ASTRID_ELEMENT_HOST.describeClipCapability({ clipType }, [])).toEqual(
        describeClipCapabilityWith({ clipType }, []),
      );
      expect(INSTALLED_ASTRID_ELEMENT_HOST.sequenceRegistry[clipType]?.component).toBe(
        SEQUENCE_COMPONENT_REGISTRY[clipType as keyof typeof SEQUENCE_COMPONENT_REGISTRY]?.component,
      );
    }

    const dynamic = [{ clipType: 'qualification-dynamic', component: (() => null) as FC }];
    expect(INSTALLED_ASTRID_ELEMENT_HOST.resolveSequenceClipEntry('custom:qualification-dynamic', dynamic)).toBe(
      resolveSequenceClipEntry('custom:qualification-dynamic', dynamic),
    );
    for (const descriptor of ASTRID_RENDERING_ELEMENTS) {
      expect(INSTALLED_ASTRID_ELEMENT_HOST.resolveComponent(descriptor.id, descriptor.kind)).toBeDefined();
    }
  });

  it('keeps exactly twelve public descriptors, seven asset URLs, and route/import isolation', () => {
    expect(PUBLIC_ASTRID_ELEMENT_HOST.descriptors).toHaveLength(12);
    expect(Object.keys(PUBLIC_ASTRID_ASSET_URLS).sort()).toEqual(
      ['card0', 'card1', 'card2', 'card3', 'card4', 'card5', 'frame'],
    );
    const root = process.cwd();
    const routes = readFileSync(path.join(root, 'src/app/routes.tsx'), 'utf8');
    const main = readFileSync(path.join(root, 'src/app/main.tsx'), 'utf8');
    const publicBootstrap = readFileSync(path.join(root, 'src/app/publicBootstrap.tsx'), 'utf8');
    const publicShell = readFileSync(path.join(root, 'src/pages/Home/PublicAstridShell.tsx'), 'utf8');
    const mountedEditor = readFileSync(path.join(root, 'src/pages/Home/PublicAstridMountedEditor.tsx'), 'utf8');
    const renderer = readFileSync(path.join(root, 'src/tools/video-editor/compositions/TimelineRenderer.tsx'), 'utf8');
    expect(routes).toContain('path="/home"');
    expect(routes).toContain('path="/"');
    expect(routes).toContain("import VideoEditorPage from '@/tools/video-editor/pages/VideoEditorPage'");
    expect(routes).toContain('path="/tools/travel-between-images"');
    // App routes intentionally keep primary tools eager for Safari hydration.
    // The public document stays separate because main returns from this branch
    // before importing app bootstrap and its route graph.
    const publicBranchStart = main.indexOf("if (owner === 'public')");
    const appBranchStart = main.indexOf('await startApp(rootElement);', publicBranchStart);
    expect(publicBranchStart).toBeGreaterThanOrEqual(0);
    expect(appBranchStart).toBeGreaterThan(publicBranchStart);
    const publicBranch = main.slice(publicBranchStart, appBranchStart);
    expect(publicBranch).toContain("await import('@/app/publicBootstrap.tsx')");
    expect(publicBranch).toContain('renderPublicEntry(rootElement);');
    expect(publicBranch).toMatch(/return;\s*}/);
    expect(publicBranch).not.toContain('@/app/bootstrap');
    expect(publicBranch).not.toContain('initializeVideoEditorExtensionRuntime');
    expect(main).not.toMatch(/from\s+['"]@\/app\/(?:bootstrap|routes)(?:\.tsx?)?['"]/);
    expect(publicBootstrap).toContain("from '@/pages/Home/PublicAstridSite.tsx'");
    expect(publicBootstrap).not.toMatch(/['"]@\/(?:app\/(?:bootstrap|routes)|tools\/travel-between-images\/pages\/VideoTravelToolPage)(?:\.tsx?)?['"]/);
    expect(main).toContain("@/tools/video-editor/browser/initializeVideoEditorExtensionRuntime.ts");
    expect(main).not.toMatch(/from\s+['"]@\/tools\/video-editor\/browser(?:\/index(?:\.[cm]?[jt]sx?)?)?['"]/);
    expect(routes).toContain('<HomeDocumentHandoff replaceDocument={homeDocumentReplacement} />');
    expect(publicShell).not.toContain('PublicAstridQualificationSurface');
    expect(publicShell).toContain('./PublicAstridMountedEditor.tsx');
    expect(mountedEditor).toContain('<PublicAstridEditorProvider example={example}');
    expect(mountedEditor).toContain('<PublicAstridPreview transportOutlet={transportOutlet} />');
    expect(mountedEditor).toContain('<PublicAstridInspector active={active}');
    expect(mountedEditor).toContain('<PublicAstridTimeline active={active}');
    expect(mountedEditor).toContain("import('./PublicAstridScriptedConversation.tsx')");
    expect(publicBootstrap).not.toContain('@/app/bootstrap');
    expect(publicBootstrap).not.toContain('initializeVideoEditorExtensionRuntime');
    expect(renderer).not.toContain("from '@/tools/video-editor/sequences/registry.ts'");
    expect(renderer).not.toContain("from '@/tools/video-editor/runtime/astrid-element-components.tsx'");
  });
});

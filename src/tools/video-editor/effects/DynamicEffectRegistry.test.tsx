import { act, render, screen, waitFor } from '@testing-library/react';
import { useSyncExternalStore, type FC } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const remotionState = vi.hoisted(() => ({
  frame: 0,
  videoConfig: { fps: 30, width: 1920, height: 1080 },
}));

vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  return {
    ...actual,
    useCurrentFrame: vi.fn(() => remotionState.frame),
    useVideoConfig: vi.fn(() => remotionState.videoConfig),
  };
});

import * as compileEffectModule from '@/tools/video-editor/effects/compileEffect';
import * as effectsModule from '@/tools/video-editor/effects';
import {
  entranceEffects,
  getEffectRegistry,
  resolvePreviewAnimationReference,
  replaceEffectRegistry,
  wrapWithClipEffects,
  wrapWithEffect,
} from '@/tools/video-editor/effects';
import { composeClipAnimationPhase, resolveAnimationReferences, useTheme } from '@banodoco/timeline-composition/theme-api';
import type { EffectComponentProps } from '@/tools/video-editor/effects/entrances';
import { DynamicEffectRegistry } from '@/tools/video-editor/effects/DynamicEffectRegistry';
import { EffectErrorBoundary } from '@/tools/video-editor/effects/EffectErrorBoundary';
import {
  EffectRegistryProvider,
  useEffectRegistrySnapshot,
} from '@/tools/video-editor/effects/registry/EffectRegistryContext';
import type {
  EffectRegistryRecord,
  EffectRegistrySnapshot,
} from '@/tools/video-editor/effects/registry/types';
import { validateAndCoerceParams } from '@/tools/video-editor/effects/validateParams';
import { useEffectRegistry } from '@/tools/video-editor/hooks/useEffectRegistry';
import type { EffectResource } from '@/tools/video-editor/hooks/useEffectResources';
import type { ParameterSchema, ResolvedTimelineClip } from '@/tools/video-editor/types';

function BuiltInFade(_props: EffectComponentProps) {
  return <div data-testid="builtin-fade" />;
}

const EFFECT_CODE = 'export default function Effect(){ return <div data-testid="dynamic-effect" />; }';

function makeResourceEffect(id: string, code: string, parameterSchema?: ParameterSchema): EffectResource {
  return {
    id,
    type: 'effect',
    name: id,
    slug: id,
    code,
    category: 'continuous',
    description: id,
    ...(parameterSchema ? { parameterSchema } : {}),
    created_by: { is_you: true },
    is_public: false,
  };
}

describe('DynamicEffectRegistry', () => {
  beforeAll(async () => {
    await compileEffectModule.preloadSucrase();
  });

  afterEach(() => {
    remotionState.frame = 0;
    localStorage.clear();
    replaceEffectRegistry(new DynamicEffectRegistry({}));
    vi.restoreAllMocks();
  });

  it('prefers built-in effects over dynamic name collisions and resolves custom prefix lookups', async () => {
    const registry = new DynamicEffectRegistry({ fade: BuiltInFade });
    registry.register('fade', 'export default function Effect(){ return <div data-testid="dynamic-fade" />; }');
    await registry.registerAsync('test', 'export default function Effect(){ return <div data-testid="custom-test" />; }');

    const FadeComponent = registry.get('fade');
    const CustomComponent = registry.get('custom:test');

    expect(FadeComponent).toBe(BuiltInFade);
    expect(CustomComponent).toBeDefined();
    expect(registry.getCode('custom:test')).toContain('custom-test');
  });

  it.each([
    ['fade entrance', 'fade', 'entrance', { type: 'fade', duration: 0.4 }],
    ['fade exit', 'fade', 'exit', { id: 'fade', durationFrames: 12 }],
    ['fade-up entrance', 'fade-up', 'entrance', { type: 'fade-up' }],
    ['scale-in entrance', 'scale-in', 'entrance', { id: 'scale-in', durationFrames: 20 }],
    ['slide-left entrance', 'slide-left', 'entrance', { type: 'slide-left', duration: 0.5 }],
    ['slide-up exit', 'slide-up', 'exit', { id: 'slide-up' }],
    ['type-on entrance', 'type-on', 'entrance', { id: 'type-on', durationFrames: 120 }],
  ] as const)(
    'resolves %s through the installed package exactly as the preview adapter does',
    (_name, id, phase, reference) => {
      const [fromPreview] = resolvePreviewAnimationReference(reference, phase, 30);
      const [fromPackage] = resolveAnimationReferences([{
        id,
        ...('durationFrames' in reference ? { durationFrames: reference.durationFrames } : {}),
        ...('duration' in reference ? { durationFrames: Math.round(reference.duration * 30) } : {}),
      }], phase);

      expect(fromPreview.id).toBe(fromPackage.id);
      expect(fromPreview.phase).toBe(fromPackage.phase);
      expect(fromPreview.durationFrames).toBe(fromPackage.durationFrames);
      expect(fromPreview.kind).toBe(fromPackage.kind);
    },
  );

  it.each([
    ['legacy entrance shape', { type: 'fade-up', duration: 0.4, params: { easing: 'ease-in' } }, undefined],
    ['package animation reference shape', { id: 'fade-up', durationFrames: 12, params: { easing: 'step' } }, undefined],
  ])('draws %s through the installed package animation component', (_name, entrance) => {
    const clip = { id: 'preview-field', entrance } as unknown as ResolvedTimelineClip;
    const { container } = render(<>{wrapWithClipEffects(<span>preview content</span>, clip, 60, 30)}</>);
    const fills = Array.from(container.querySelectorAll('[style]')) as HTMLElement[];

    expect(screen.getByText('preview content')).toBeInTheDocument();
    expect(fills.some((element) => element.style.transform.includes('translateY')
      || element.style.transform.includes('scale'))).toBe(true);
  });

  it.each([
    ['fade exit', 'exit', { id: 'fade', durationFrames: 12 }],
    ['slide-up exit', 'exit', { type: 'slide-up', duration: 0.4 }],
    ['fade entrance', 'entrance', { id: 'fade', durationFrames: 12, easing: 'step' }],
    ['fade-up entrance', 'entrance', { type: 'fade-up', duration: 0.4, params: { easing: 'ease-in' } }],
    ['scale-in entrance', 'entrance', { id: 'scale-in' }],
  ] as const)('matches installed phase markup for %s across its window', (_name, phase, reference) => {
    const clip = { id: 'phase-test', [phase]: reference } as unknown as ResolvedTimelineClip;
    const Expected: FC = () => {
      const theme = useTheme();
      return <>{composeClipAnimationPhase({ clip: clip as never, fps: 30, theme, phase,
        reference, clipFrames: 60, children: <span>content</span> }, remotionState.frame)}</>;
    };
    const frames = phase === 'exit' ? [0, 47, 48, 54, 59, 60] : [0, 4, 8, 12, 30];
    for (const frame of frames) {
      remotionState.frame = frame;
      const preview = render(<>{wrapWithClipEffects(<span>content</span>, clip, 60, 30)}</>);
      const expected = render(<Expected />);
      expect(preview.container.innerHTML, `frame ${frame}`).toBe(expected.container.innerHTML);
      preview.unmount();
      expected.unmount();
    }
  });

  it('does not synthesize type-on text or a clip-path for top-level type-on', () => {
    const clip = {
      id: 'preview-field',
      text: { content: 'Visible text' },
      entrance: { id: 'type-on', durationFrames: 120 },
    } as unknown as ResolvedTimelineClip;
    const { container } = render(<>{wrapWithClipEffects(<span>Visible text</span>, clip, 60, 30)}</>);

    expect(screen.getByText('Visible text')).toBeInTheDocument();
    expect(container.querySelector('[style*="clip-path"]')).toBeNull();
    expect(container.textContent).toBe('Visible text');
  });

  it('runs the package exit clock only over the final resolved duration', () => {
    const clip = {
      id: 'preview-field',
      exit: { id: 'slide-up' },
    } as unknown as ResolvedTimelineClip;
    remotionState.frame = 48;
    const view = render(<>{wrapWithClipEffects(<span>preview content</span>, clip, 60, 30)}</>);
    const getAnimationStyle = () => {
      const element = view.container.querySelector('[style*="translateY"]') as HTMLElement | null;
      return element?.style;
    };

    expect(getAnimationStyle()?.transform).toBe('translateY(0px)');
    expect(getAnimationStyle()?.opacity).toBe('1');
    remotionState.frame = 60;
    view.rerender(<>{wrapWithClipEffects(<span>preview content</span>, clip, 60, 30)}</>);
    expect(getAnimationStyle()?.transform).toBe('translateY(-30px)');
    expect(getAnimationStyle()?.opacity).toBe('0');
  });

  it.each([
    ['object', { fade_in: 0.5, fade_out: 0.5 }],
    ['array', [{ fade_in: 0.5 }, { fade_out: 0.5 }]],
  ])('ramps opacity from %s effects fade_in and fade_out like the installed package', (_form, effects) => {
    const clip = { id: 'preview-field', at: 0, hold: 2, effects } as unknown as ResolvedTimelineClip;
    const opacityAt = (frame: number) => {
      remotionState.frame = frame;
      const view = render(<>{wrapWithClipEffects(<span>content</span>, clip, 60, 30)}</>);
      const wrapper = view.container.firstElementChild as HTMLElement;
      const opacity = wrapper.style.opacity;
      view.unmount();
      return opacity;
    };

    expect(opacityAt(0)).toBe('0');
    expect(opacityAt(6)).toBe('0.4');
    expect(opacityAt(30)).toBe('1');
    expect(opacityAt(54)).toBe('0.4');
  });

  it('returns a compile error overlay instead of throwing for invalid custom code', async () => {
    const registry = new DynamicEffectRegistry({});
    expect(() => registry.register('broken', 'export default function Effect( {')).not.toThrow();
    expect(registry.get('broken')).toBeDefined();
  });

  it('compiles and renders an effect that calls useAudioReactive without a provider', async () => {
    const result = await compileEffectModule.tryCompileEffectAsync(`
      function AudioReactiveEffect() {
        const audio = useAudioReactive();
        return <div data-testid="audio-reactive-effect">{String(audio.amplitude)}:{String(audio.isBeat)}</div>;
      }
      exports.default = AudioReactiveEffect;
    `);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    render(<result.component durationInFrames={1}>{null}</result.component>);

    expect(screen.getByTestId('audio-reactive-effect').textContent).toBe('0:false');
  });

  it('compiles and renders an effect that calls useAudioParam', async () => {
    const result = await compileEffectModule.tryCompileEffectAsync(`
      function AudioParamEffect(props) {
        const value = useAudioParam(props.params?.binding);
        return <div data-testid="audio-param-effect">{String(value)}</div>;
      }
      exports.default = AudioParamEffect;
    `);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    render(
      <result.component
        durationInFrames={1}
        params={{ binding: { source: 'amplitude', min: 2, max: 5 } }}
      >
        {null}
      </result.component>,
    );

    expect(screen.getByTestId('audio-param-effect').textContent).toBe('2');
  });

  it('tracks subscriptions, deduplicates unchanged registrations, batches notifications, and stores schemas', async () => {
    const schema: ParameterSchema = [
      { name: 'amount', label: 'Amount', description: 'Adjust amount', type: 'number', default: 2, min: 0, max: 5 },
    ];
    const sameSchema: ParameterSchema = [
      { name: 'amount', label: 'Amount', description: 'Adjust amount', type: 'number', default: 2, min: 0, max: 5 },
    ];
    const changedSchema: ParameterSchema = [
      { name: 'amount', label: 'Amount', description: 'Adjust amount', type: 'number', default: 3, min: 0, max: 5 },
    ];
    const registry = new DynamicEffectRegistry({});
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    expect(registry.getSnapshot()).toBe(0);

    registry.register('alpha', EFFECT_CODE);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.getSnapshot()).toBe(1);

    registry.register('alpha', EFFECT_CODE);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.getSnapshot()).toBe(1);

    registry.register('schema-effect', EFFECT_CODE, schema);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.getSnapshot()).toBe(2);

    registry.register('schema-effect', EFFECT_CODE, sameSchema);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.getSnapshot()).toBe(2);

    registry.register('schema-effect', EFFECT_CODE, changedSchema);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(registry.getSnapshot()).toBe(3);

    await registry.batch(async () => {
      registry.register('beta', EFFECT_CODE.replace('dynamic-effect', 'beta-effect'));
      registry.register('gamma', EFFECT_CODE.replace('dynamic-effect', 'gamma-effect'), schema);
    });

    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(4);
    expect(registry.getSnapshot()).toBe(4);
    expect(registry.getSchema('custom:gamma')).toEqual(schema);
  });

  it('renders the fallback when an effect throws inside the boundary', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ThrowingEffect = () => {
      throw new Error('boom');
    };

    render(
      <EffectErrorBoundary effectName="explode" fallback={<div data-testid="effect-fallback" />}>
        <ThrowingEffect />
      </EffectErrorBoundary>,
    );

    expect(screen.getByTestId('effect-fallback')).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalledWith('[EffectErrorBoundary] "explode" runtime error: boom');
    errorSpy.mockRestore();
  });

  it('wrapWithEffect validates params before rendering the effect', () => {
    let receivedProps: Omit<EffectComponentProps, 'children'> | null = null;
    const InspectEffect = ({ children, ...props }: EffectComponentProps) => {
      receivedProps = props;
      return <div data-testid="wrapped-effect">{children}</div>;
    };
    const schema: ParameterSchema = [
      { name: 'amount', label: 'Amount', description: 'Effect amount', type: 'number', default: 2, min: 0, max: 5 },
      { name: 'enabled', label: 'Enabled', description: 'Enable effect', type: 'boolean', default: false },
    ];

    render(
      <>
        {wrapWithEffect(<div data-testid="wrapped-child" />, InspectEffect, {
          effectName: 'inspect',
          durationInFrames: 24,
          effectFrames: 12,
          intensity: 0.75,
          params: { amount: 'bad', enabled: 'true' },
          schema,
        })}
      </>,
    );

    expect(screen.getByTestId('wrapped-effect')).toBeInTheDocument();
    expect(screen.getByTestId('wrapped-child')).toBeInTheDocument();
    expect(receivedProps).toEqual({
      durationInFrames: 24,
      effectFrames: 12,
      intensity: 0.75,
      params: { amount: 2, enabled: false },
    });
  });

  it('wrapWithEffect falls back to the original content when the effect throws', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ThrowingEffect = () => {
      throw new Error('wrap failure');
    };

    render(
      <>
        {wrapWithEffect(<div data-testid="wrap-fallback" />, ThrowingEffect, {
          effectName: 'wrap-failure',
          durationInFrames: 10,
        })}
      </>,
    );

    expect(screen.getByTestId('wrap-fallback')).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalledWith('[EffectErrorBoundary] "wrap-failure" runtime error: wrap failure');
  });

  it('keeps the deprecated singleton bridge seedable without mutating built-in exports or wrappers', () => {
    const originalFade = entranceEffects.fade;
    const LegacyBridgeEffect = ({ children }: EffectComponentProps) => (
      <div data-testid="legacy-bridge-effect">{children}</div>
    );
    const DirectEffect = ({ children }: EffectComponentProps) => (
      <div data-testid="direct-wrapped-effect">{children}</div>
    );
    const seededRegistry = new DynamicEffectRegistry({
      'legacy-bridge': LegacyBridgeEffect,
    });

    expect(replaceEffectRegistry(seededRegistry)).toBe(seededRegistry);
    expect(getEffectRegistry()).toBe(seededRegistry);
    expect(getEffectRegistry().get('custom:legacy-bridge')).toBe(LegacyBridgeEffect);

    render(
      <>
        {wrapWithEffect(<div data-testid="direct-child" />, DirectEffect, {
          effectName: 'direct',
          durationInFrames: 10,
        })}
      </>,
    );

    expect(entranceEffects.fade).toBe(originalFade);
    expect(getEffectRegistry()).toBe(seededRegistry);
    expect(screen.getByTestId('direct-wrapped-effect')).toContainElement(screen.getByTestId('direct-child'));
  });

  it('re-renders subscribed components when async registration completes', async () => {
    const registry = new DynamicEffectRegistry({});

    function RegistryConsumer() {
      const version = useSyncExternalStore(registry.subscribe, registry.getSnapshot);
      const effect = registry.get('async-test');
      return (
        <div data-testid="consumer">
          v{version}:{effect ? 'found' : 'missing'}
        </div>
      );
    }

    render(<RegistryConsumer />);
    expect(screen.getByTestId('consumer').textContent).toBe('v0:missing');

    await act(async () => {
      await registry.registerAsync('async-test', EFFECT_CODE);
    });

    expect(screen.getByTestId('consumer').textContent).toBe('v1:found');
  });

  it('does not let a slower async registration overwrite newer code', async () => {
    const registry = new DynamicEffectRegistry({});
    const pending = new Map<string, (component: FC<EffectComponentProps>) => void>();
    const makeEffect = (testId: string): FC<EffectComponentProps> => {
      return function MockEffect({ children }) {
        return <div data-testid={testId}>{children}</div>;
      };
    };
    vi.spyOn(compileEffectModule, 'compileEffectAsync').mockImplementation((code: string) => {
      return new Promise<FC<EffectComponentProps>>((resolve) => {
        pending.set(code, resolve);
      });
    });

    registry.register('race', EFFECT_CODE.replace('dynamic-effect', 'race-v1'));

    const staleRegistration = registry.registerAsync('race', 'v1-old');
    const newestRegistration = registry.registerAsync('race', 'v2');

    pending.get('v2')?.(makeEffect('race-v2'));
    await newestRegistration;

    pending.get('v1-old')?.(makeEffect('race-v1-old'));
    await staleRegistration;

    expect(registry.getCode('race')).toBe('v2');

    const RegisteredEffect = registry.get('race');
    expect(RegisteredEffect).toBeDefined();

    render(
      RegisteredEffect ? (
        <RegisteredEffect durationInFrames={1}>
          <div data-testid="race-child" />
        </RegisteredEffect>
      ) : null,
    );

    expect(screen.getByTestId('race-v2')).toBeInTheDocument();
    expect(screen.queryByTestId('race-v1-old')).not.toBeInTheDocument();
  });

  it('loads effects into the provider registry without mutating the legacy singleton', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replaceSpy = vi.spyOn(effectsModule, 'replaceEffectRegistry');

    const resourceEffects: EffectResource[] = [
      makeResourceEffect('resource-effect', EFFECT_CODE),
    ];

    function RegistryHost() {
      const registry = useEffectRegistry(undefined, resourceEffects);
      const snapshot = useEffectRegistrySnapshot();
      const effect = snapshot.get('resource-effect');
      return (
        <div data-testid="registry-state">
          {snapshot === registry.getSnapshot() ? 'same' : 'different'}:{effect ? 'found' : 'missing'}
        </div>
      );
    }

    replaceEffectRegistry(new DynamicEffectRegistry({}));
    replaceSpy.mockClear();
    render(
      <EffectRegistryProvider>
        <RegistryHost />
      </EffectRegistryProvider>,
    );

    expect(replaceSpy).toHaveBeenCalledTimes(0);
    expect(getEffectRegistry().get('custom:resource-effect')).toBeUndefined();

    await waitFor(() => {
      expect(screen.getByTestId('registry-state').textContent).toBe('same:found');
    });
    expect(replaceSpy).toHaveBeenCalledTimes(0);
    expect(getEffectRegistry().get('custom:resource-effect')).toBeUndefined();
  });

  it('resolves built-ins and keeps resource-backed custom effects inactive, blocked, and unrendered in provider snapshots', async () => {
    let receivedProps: Omit<EffectComponentProps, 'children'> | null = null;
    const observed: { record?: EffectRegistryRecord } = {};
    const schema: ParameterSchema = [
      { name: 'amount', label: 'Amount', description: 'Effect amount', type: 'number', default: 4, min: 0, max: 10 },
      { name: 'enabled', label: 'Enabled', description: 'Enable effect', type: 'boolean', default: true },
    ];
    const compileSpy = vi.spyOn(compileEffectModule, 'compileEffect').mockImplementation((code: string) => {
      return function ProviderCompiledEffect({ children, ...props }: EffectComponentProps) {
        receivedProps = props;
        return <div data-testid={`provider-${code}`}>{children}</div>;
      };
    });

    const resourceEffects: EffectResource[] = [
      makeResourceEffect('custom:provider-custom', 'provider-custom-code', schema),
    ];

    function ProviderSnapshotHost() {
      const registry = useEffectRegistry(undefined, resourceEffects);
      const snapshot = useEffectRegistrySnapshot();
      const clip = {
        id: 'clip-1',
        continuous: {
          type: 'custom:provider-custom',
          params: { amount: 'bad', enabled: 'false' },
          intensity: 0.8,
        },
      } as ResolvedTimelineClip;
      const wrapped = wrapWithClipEffects(
        <div data-testid="provider-child" />,
        clip,
        30,
        30,
        snapshot,
      );
      const customRecord = snapshot.get('provider-custom');
      observed.record = customRecord;
      return (
        <div data-testid="provider-snapshot-state">
          <span data-testid="builtin-state">
            {snapshot.get('fade')?.component === entranceEffects.fade ? 'builtin-found' : 'builtin-missing'}
          </span>
          <span data-testid="custom-state">
            {customRecord?.schema === schema && registry.resolve('provider-custom') === customRecord
              ? 'custom-found'
              : 'custom-missing'}
          </span>
          {wrapped}
        </div>
      );
    }

    replaceEffectRegistry(new DynamicEffectRegistry({}));
    render(
      <EffectRegistryProvider>
        <ProviderSnapshotHost />
      </EffectRegistryProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('builtin-state').textContent).toBe('builtin-found');
      expect(screen.getByTestId('custom-state').textContent).toBe('custom-found');
      expect(screen.getByTestId('provider-child')).toBeInTheDocument();
    });

    // The resource-backed custom effect is registered as inactive, with its
    // capabilities blocked until it is migrated to an admitted element pack.
    expect(observed.record?.status).toBe('inactive');
    expect(observed.record?.renderability.capabilities.length).toBeGreaterThan(0);
    for (const capability of observed.record?.renderability.capabilities ?? []) {
      expect(capability.status).toBe('blocked');
      expect(capability.message).toBe('Requires migration to an admitted element pack.');
    }

    // Its code is never compiled, its component is never rendered, and the
    // child content is passed through unwrapped with no params applied.
    expect(compileSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('provider-provider-custom-code')).not.toBeInTheDocument();
    expect(receivedProps).toBeNull();
    expect(getEffectRegistry().get('custom:provider-custom')).toBeUndefined();
  });

  it('isolates same effect IDs across provider registries as inactive, unrendered records without compiling or leaking state', async () => {
    const compileSpy = vi.spyOn(compileEffectModule, 'compileEffect').mockImplementation((code: string) => {
      return function MockCompiledEffect({ children }: EffectComponentProps) {
        return <div data-testid={`compiled-${code}`}>{children}</div>;
      };
    });
    const observed: Record<string, EffectRegistryRecord | undefined> = {};

    function ProviderRegistryHost({
      label,
      resourceEffects,
    }: {
      label: string;
      resourceEffects: EffectResource[];
    }) {
      const registry = useEffectRegistry(undefined, resourceEffects);
      const snapshot = useEffectRegistrySnapshot();
      const record = snapshot.get('shared-effect');
      const CompiledEffect = record?.component;
      const registryRecord = registry.resolve('shared-effect');
      observed[label] = registryRecord;
      return (
        <div data-testid={`${label}-state`}>
          <span data-testid={`${label}-code`}>{registryRecord?.code ?? 'missing'}</span>
          {CompiledEffect ? (
            <CompiledEffect durationInFrames={1}>
              <span data-testid={`${label}-child`} />
            </CompiledEffect>
          ) : null}
        </div>
      );
    }

    replaceEffectRegistry(new DynamicEffectRegistry({}));
    render(
      <>
        <EffectRegistryProvider>
          <ProviderRegistryHost
            label="provider-a"
            resourceEffects={[makeResourceEffect('shared-effect', 'provider-a')]}
          />
        </EffectRegistryProvider>
        <EffectRegistryProvider>
          <ProviderRegistryHost
            label="provider-b"
            resourceEffects={[makeResourceEffect('shared-effect', 'provider-b')]}
          />
        </EffectRegistryProvider>
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('provider-a-code').textContent).toBe('provider-a');
      expect(screen.getByTestId('provider-b-code').textContent).toBe('provider-b');
    });

    // Each provider keeps its own record: same ID, distinct code, both inactive and blocked.
    for (const label of ['provider-a', 'provider-b']) {
      const record = observed[label];
      expect(record?.status).toBe('inactive');
      expect(record?.renderability.capabilities.length).toBeGreaterThan(0);
      for (const capability of record?.renderability.capabilities ?? []) {
        expect(capability.status).toBe('blocked');
        expect(capability.message).toBe('Requires migration to an admitted element pack.');
      }
    }
    expect(observed['provider-a']).not.toBe(observed['provider-b']);

    // Neither provider compiles or renders its custom component, so no marker
    // or child element appears and the singleton stays untouched.
    expect(compileSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('compiled-provider-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('compiled-provider-b')).not.toBeInTheDocument();
    expect(screen.queryByTestId('provider-a-child')).not.toBeInTheDocument();
    expect(screen.queryByTestId('provider-b-child')).not.toBeInTheDocument();
    expect(getEffectRegistry().get('custom:shared-effect')).toBeUndefined();
  });

  it('uses a memoized standalone fallback registry outside a provider', async () => {
    const resourceEffects: EffectResource[] = [
      makeResourceEffect('standalone-resource-effect', EFFECT_CODE),
    ];

    function RegistryHost() {
      const registry = useEffectRegistry(undefined, resourceEffects);
      const effect = registry.resolve('standalone-resource-effect');
      return (
        <div data-testid="standalone-registry-state">
          {effect ? 'found' : 'missing'}:{registry.getSnapshot().records.length}
        </div>
      );
    }

    replaceEffectRegistry(new DynamicEffectRegistry({}));
    render(<RegistryHost />);

    expect(getEffectRegistry().get('custom:standalone-resource-effect')).toBeUndefined();

    await waitFor(() => {
      expect(screen.getByTestId('standalone-registry-state').textContent).toMatch(/^found:/);
    });
    expect(getEffectRegistry().get('custom:standalone-resource-effect')).toBeUndefined();
  });

  it('seeds provider-unaware fallback registries locally as inactive, unrendered records without compiling or leaking same effect IDs', async () => {
    const compileSpy = vi.spyOn(compileEffectModule, 'compileEffect').mockImplementation((code: string) => {
      return function MockCompiledEffect({ children }: EffectComponentProps) {
        return <div data-testid={`standalone-${code}`}>{children}</div>;
      };
    });
    const observed: Record<string, EffectRegistryRecord | undefined> = {};

    function StandaloneRegistryHost({
      label,
      resourceEffects,
    }: {
      label: string;
      resourceEffects: EffectResource[];
    }) {
      const registry = useEffectRegistry(undefined, resourceEffects);
      const record = registry.resolve('fallback-shared-effect');
      const CompiledEffect = record?.component;
      observed[label] = record;
      return (
        <div data-testid={`${label}-fallback-state`}>
          <span data-testid={`${label}-fallback-code`}>{record?.code ?? 'missing'}</span>
          {CompiledEffect ? (
            <CompiledEffect durationInFrames={1}>
              <span data-testid={`${label}-fallback-child`} />
            </CompiledEffect>
          ) : null}
        </div>
      );
    }

    replaceEffectRegistry(new DynamicEffectRegistry({}));
    render(
      <>
        <StandaloneRegistryHost
          label="fallback-a"
          resourceEffects={[makeResourceEffect('fallback-shared-effect', 'fallback-a')]}
        />
        <StandaloneRegistryHost
          label="fallback-b"
          resourceEffects={[makeResourceEffect('fallback-shared-effect', 'fallback-b')]}
        />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('fallback-a-fallback-code').textContent).toBe('fallback-a');
      expect(screen.getByTestId('fallback-b-fallback-code').textContent).toBe('fallback-b');
    });

    // Each fallback registry keeps its own record: inactive and blocked until migrated.
    for (const label of ['fallback-a', 'fallback-b']) {
      const record = observed[label];
      expect(record?.status).toBe('inactive');
      expect(record?.renderability.capabilities.length).toBeGreaterThan(0);
      for (const capability of record?.renderability.capabilities ?? []) {
        expect(capability.status).toBe('blocked');
        expect(capability.message).toBe('Requires migration to an admitted element pack.');
      }
    }
    expect(observed['fallback-a']).not.toBe(observed['fallback-b']);

    // Neither fallback compiles or renders its custom component, and the singleton stays untouched.
    expect(compileSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('standalone-fallback-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('standalone-fallback-b')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fallback-a-fallback-child')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fallback-b-fallback-child')).not.toBeInTheDocument();
    expect(getEffectRegistry().get('custom:fallback-shared-effect')).toBeUndefined();
  });

  it('wrapWithClipEffects prefers provider record component and schema over legacy singleton for same effect ID', () => {
    const LegacyComponent = ({ children }: EffectComponentProps) => (
      <div data-testid="legacy-override-component">{children}</div>
    );
    const ProviderComponent = ({ children, params }: EffectComponentProps) => (
      <div data-testid="provider-override-component" data-amount={String(params?.amount ?? '')}>{children}</div>
    );
    const providerSchema: ParameterSchema = [
      { name: 'amount', label: 'Amount', type: 'number', default: 42, min: 0, max: 100 },
    ];
    const legacySchema: ParameterSchema = [
      { name: 'amount', label: 'Amount', type: 'number', default: 1, min: 0, max: 10 },
    ];

    // Seed the legacy singleton with one component and schema
    replaceEffectRegistry(new DynamicEffectRegistry({ 'override-effect': LegacyComponent }));
    getEffectRegistry().register('override-effect', 'export default function Effect(){}', legacySchema);

    // Build a provider snapshot with a different component and schema for the same ID
    const providerRecord: EffectRegistryRecord = {
      effectId: 'override-effect',
      contributionId: 'test:override-effect',
      component: ProviderComponent,
      provenance: 'trusted-loader',
      ownerExtensionId: 'test-ext',
      status: 'active',
      schema: providerSchema,
      renderability: {
        defaultRoute: 'preview',
        determinism: 'deterministic',
        capabilities: [
          { route: 'preview', status: 'supported', determinism: 'deterministic' },
        ],
      },
    };
    const providerSnapshot: EffectRegistrySnapshot = Object.freeze({
      records: Object.freeze([providerRecord]),
      diagnostics: Object.freeze([]),
      get: (effectId: string) => effectId === 'override-effect' ? providerRecord : undefined,
      has: (effectId: string) => effectId === 'override-effect',
    }) as EffectRegistrySnapshot;

    const clip: ResolvedTimelineClip = {
      id: 'clip-override',
      clipType: 'media',
      track: 'V1',
      at: 0,
      hold: 1,
      continuous: { type: 'override-effect', params: {}, intensity: 0.5 },
    };

    render(
      <>
        {wrapWithClipEffects(
          <div data-testid="override-child" />,
          clip,
          30,
          30,
          providerSnapshot,
        )}
      </>,
    );

    // Provider component renders, not legacy
    expect(screen.getByTestId('provider-override-component')).toBeInTheDocument();
    expect(screen.queryByTestId('legacy-override-component')).not.toBeInTheDocument();
    // Provider schema default (42) used, not legacy default (1)
    expect(screen.getByTestId('provider-override-component')).toHaveAttribute('data-amount', '42');
    // Legacy singleton is unchanged
    expect(getEffectRegistry().get('custom:override-effect')).toBe(LegacyComponent);
  });

  it('validates and coerces effect params from schema defaults', () => {
    const schema: ParameterSchema = [
      { name: 'size', label: 'Size', description: 'Effect size', type: 'number', default: 2, min: 0, max: 5 },
      { name: 'opacity', label: 'Opacity', description: 'Effect opacity', type: 'number', default: 0.5, min: 0, max: 1 },
      { name: 'enabled', label: 'Enabled', description: 'Enable effect', type: 'boolean', default: false },
      {
        name: 'mode',
        label: 'Mode',
        description: 'Effect mode',
        type: 'select',
        options: [
          { label: 'Soft', value: 'soft' },
          { label: 'Hard', value: 'hard' },
        ],
      },
      { name: 'color', label: 'Color', description: 'Tint color', type: 'color', default: '#123abc' },
      {
        name: 'binding',
        label: 'Binding',
        description: 'Audio binding',
        type: 'audio-binding',
        default: { source: 'bass', min: 1, max: 3 },
      },
    ];

    expect(validateAndCoerceParams({
      size: '3',
      opacity: 9,
      enabled: 'true',
      mode: 'missing',
      color: 'blue',
      binding: { source: 'noise', min: 'low', max: null },
      customSeed: 42,
    }, schema)).toEqual({
      size: 2,
      opacity: 1,
      enabled: false,
      mode: 'soft',
      color: '#123abc',
      binding: { source: 'bass', min: 1, max: 3 },
      customSeed: 42,
    });
  });
});

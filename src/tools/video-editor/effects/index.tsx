import type { FC, ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import {
  composeClipAnimationPhase,
  normalizeAnimationRefs,
  resolveAnimationReferences,
  useTheme,
  type AnimationPhase,
} from '@banodoco/timeline-composition/theme-api';
import { clipOpacity } from '@banodoco/timeline-composition/evaluation';
import { getEffectValue, secondsToFrames } from '@/tools/video-editor/lib/config-utils.ts';
import { DynamicEffectRegistry } from '@/tools/video-editor/effects/DynamicEffectRegistry.ts';
import { EffectErrorBoundary } from '@/tools/video-editor/effects/EffectErrorBoundary.tsx';
import {
  normalizeEffectRegistryId,
  type EffectRegistrySnapshot,
} from '@/tools/video-editor/effects/registry/index.ts';
import { validateAndCoerceParams } from '@/tools/video-editor/effects/validateParams.ts';
import {
  BounceEntrance,
  FadeEntrance,
  FlipEntrance,
  MeteoriteEntrance,
  PulseEntrance,
  SlideDownEntrance,
  SlideLeftEntrance,
  SlideRightEntrance,
  SlideUpEntrance,
  ZoomInEntrance,
  ZoomSpinEntrance,
  type EffectComponentProps,
} from '@/tools/video-editor/effects/entrances.tsx';
import {
  DriftEffect,
  FloatEffect,
  GlitchEffect,
  KenBurnsEffect,
  SlowZoomEffect,
} from '@/tools/video-editor/effects/continuous.tsx';
import {
  DissolveExit,
  FadeOutExit,
  FlipExit,
  ShrinkExit,
  SlideDownExit,
  ZoomOutExit,
} from '@/tools/video-editor/effects/exits.tsx';
import type { ParameterSchema, ResolvedTimelineClip } from '@/tools/video-editor/types/index.ts';

export type ClipEffectComponent = FC<EffectComponentProps>;

export const entranceEffects: Record<string, ClipEffectComponent> = {
  'slide-up': SlideUpEntrance,
  'slide-down': SlideDownEntrance,
  'slide-left': SlideLeftEntrance,
  'slide-right': SlideRightEntrance,
  'zoom-in': ZoomInEntrance,
  'zoom-spin': ZoomSpinEntrance,
  pulse: PulseEntrance,
  fade: FadeEntrance,
  flip: FlipEntrance,
  bounce: BounceEntrance,
  meteorite: MeteoriteEntrance,
};

export const exitEffects: Record<string, ClipEffectComponent> = {
  'slide-down': SlideDownExit,
  'zoom-out': ZoomOutExit,
  flip: FlipExit,
  'fade-out': FadeOutExit,
  shrink: ShrinkExit,
  dissolve: DissolveExit,
};

export const continuousEffects: Record<string, ClipEffectComponent> = {
  'ken-burns': KenBurnsEffect,
  float: FloatEffect,
  glitch: GlitchEffect,
  'slow-zoom': SlowZoomEffect,
  drift: DriftEffect,
};

export const entranceEffectTypes = Object.keys(entranceEffects);
export const exitEffectTypes = Object.keys(exitEffects);
export const continuousEffectTypes = Object.keys(continuousEffects);

const allBuiltInEffects: Record<string, ClipEffectComponent> = {
  ...entranceEffects,
  ...exitEffects,
  ...continuousEffects,
};

let effectRegistry: DynamicEffectRegistry | null = null;

/**
 * @deprecated Legacy compatibility bridge for provider-unaware renderers and
 * tests. New extension loading must use provider-scoped EffectRegistry instances
 * from `effects/registry` instead of the module singleton.
 */
export function getEffectRegistry(): DynamicEffectRegistry {
  if (!effectRegistry) {
    effectRegistry = new DynamicEffectRegistry(allBuiltInEffects);
  }

  return effectRegistry;
}

/**
 * @deprecated Legacy compatibility bridge for intentionally seeding the module
 * singleton in standalone tests. Provider-mounted code must not call this.
 */
export function replaceEffectRegistry(registry: DynamicEffectRegistry): DynamicEffectRegistry {
  effectRegistry = registry;
  return effectRegistry;
}

const resolveEffectName = (type: string): string => {
  return type.startsWith('custom:') ? type.slice(7) : type;
};

export const lookupEffect = (
  builtInMap: Record<string, ClipEffectComponent>,
  type: string,
): ClipEffectComponent | null => {
  const name = resolveEffectName(type);
  if (builtInMap[name]) {
    return builtInMap[name];
  }

  const registry = getEffectRegistry();
  return registry.get(name) ?? null;
};

/**
 * Resolve an effect from a provider-scoped {@link EffectRegistrySnapshot} by
 * normalized ID. Returns `undefined` when the record is missing, inactive, or
 * has no renderable component.
 *
 * The resolution order is:
 * 1. `snapshot.get(normalizeEffectRegistryId(type))` — strips `custom:` prefix
 * 2. `snapshot.get(type)` — fallback for legacy `custom:` keys
 *
 * Records with `status: 'inactive'` are skipped so deactivated extensions
 * don't leak stale effects into the render tree. Records with `status:
 * 'error'` are still returned because render-time coercion intentionally preserves
 * render-time parameter coercion for already-applied legacy data.
 */
export function resolveSnapshotEffect(
  snapshot: EffectRegistrySnapshot,
  type: string,
): ReturnType<EffectRegistrySnapshot['get']> {
  const record = snapshot.get(normalizeEffectRegistryId(type)) ?? snapshot.get(type);
  if (record && record.status === 'inactive') return undefined;
  return record;
}

type WrapWithEffectConfig = {
  effectName: string;
  durationInFrames: number;
  effectFrames?: number;
  intensity?: number;
  params?: Record<string, unknown>;
  schema?: ParameterSchema;
};

export const wrapWithEffect = (
  content: ReactNode,
  EffectComponent: ClipEffectComponent,
  { effectName, durationInFrames, effectFrames, intensity, params, schema }: WrapWithEffectConfig,
): ReactNode => {
  return (
    <EffectErrorBoundary effectName={effectName} fallback={content}>
      <EffectComponent
        durationInFrames={durationInFrames}
        effectFrames={effectFrames}
        intensity={intensity}
        params={validateAndCoerceParams(params, schema)}
      >
        {content}
      </EffectComponent>
    </EffectErrorBoundary>
  );
};

type ClipAnimation = {
  id?: string;
  type?: string;
  duration?: number;
  durationFrames?: number;
  easing?: string;
  params?: Record<string, unknown>;
};

export const resolvePreviewAnimationReference = (
  animation: ClipAnimation,
  phase: AnimationPhase,
  fps: number,
) => {
  const refs = normalizeAnimationRefs(animation, fps);
  if (!refs) throw new Error('Preview animation references require an id or type');
  return resolveAnimationReferences(refs, phase);
};

const PackageAnimation: FC<{
  content: ReactNode;
  clip: ResolvedTimelineClip;
  animation: ClipAnimation;
  durationInFrames: number;
  fps: number;
  phase: AnimationPhase;
}> = ({ content, clip, animation, durationInFrames, fps, phase }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  return <>{composeClipAnimationPhase({
    clip: clip as never,
    reference: animation,
    phase,
    children: content,
    theme,
    fps,
    clipFrames: durationInFrames,
  }, frame)}</>;
};

// `effects.fade_in` / `fade_out` ramp the clip's opacity through the package's own
// clipOpacity. `clip.opacity` is applied by each clip body, so it is dropped here.
const ClipFadeOpacity: FC<{ clip: ResolvedTimelineClip; fps: number; children: ReactNode }> = ({ clip, fps, children }) => {
  const opacity = clipOpacity({ ...clip, opacity: undefined } as never, useCurrentFrame(), fps);
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

const hasClipFade = (clip: ResolvedTimelineClip): boolean => (
  getEffectValue(clip.effects, 'fade_in') !== null || getEffectValue(clip.effects, 'fade_out') !== null
);

type PackageAnimationResolution = 'supported' | 'wrong-phase' | 'unknown';

const resolvePackageAnimation = (
  animation: ClipAnimation,
  phase: AnimationPhase,
  fps: number,
): PackageAnimationResolution => {
  try {
    resolvePreviewAnimationReference(animation, phase, fps);
    return 'supported';
  } catch (error) {
    // Unknown IDs belong to the contributed registry path below. A known ID
    // in the wrong phase is intentionally not reinterpreted as another phase.
    if (error instanceof Error && (error.message.startsWith('Unknown animation id')
      || error.message.startsWith('Preview animation references'))) return 'unknown';
    if (error instanceof Error && /^Animation '.+' is phase /.test(error.message)) return 'wrong-phase';
    throw error;
  }
};

export const wrapWithClipEffects = (
  content: ReactNode,
  clip: ResolvedTimelineClip,
  durationInFrames: number,
  fps: number,
  effectRegistrySnapshot?: EffectRegistrySnapshot,
): ReactNode => {
  let wrapped = content;
  const legacyRegistry = effectRegistrySnapshot ? null : getEffectRegistry();

  const continuousEffect = clip.continuous;
  const continuousRecord = continuousEffect && effectRegistrySnapshot
    ? resolveSnapshotEffect(effectRegistrySnapshot, continuousEffect.type)
    : undefined;
  const continuous = continuousEffect
    ? continuousRecord?.component
      ?? (legacyRegistry ? lookupEffect(continuousEffects, continuousEffect.type) : null)
    : null;
  if (continuousEffect && !continuous) {
    console.warn('[EffectWrap] continuous effect NOT FOUND for clip=%s type=%s', clip.id, continuousEffect.type);
  }
  if (continuous) {
    wrapped = wrapWithEffect(wrapped, continuous, {
      effectName: continuousEffect!.type,
      durationInFrames,
      effectFrames: durationInFrames,
      intensity: continuousEffect!.intensity ?? 0.5,
      params: continuousEffect!.params,
      schema: continuousRecord?.schema ?? legacyRegistry?.getSchema(continuousEffect!.type),
    });
  }

  const entranceEffect = clip.entrance;
  const entranceAnimation = entranceEffect as ClipAnimation | undefined;
  const entranceType = entranceAnimation?.id ?? entranceAnimation?.type;
  const entranceRecord = entranceEffect && effectRegistrySnapshot
    ? resolveSnapshotEffect(effectRegistrySnapshot, entranceType ?? '')
    : undefined;
  // A provider-owned snapshot record takes precedence over the package built-in.
  const packageEntrance = entranceAnimation && entranceEffect && !entranceRecord
    ? resolvePackageAnimation(entranceAnimation, 'entrance', fps)
    : 'unknown';
  const entrance = packageEntrance === 'unknown' && entranceEffect
    ? entranceRecord?.component
      ?? (legacyRegistry && entranceType ? lookupEffect(entranceEffects, entranceType) : null)
    : null;
  if (entranceAnimation && packageEntrance === 'supported' && entranceType !== 'type-on') {
    wrapped = <PackageAnimation
      content={wrapped}
      clip={clip}
      animation={entranceAnimation}
      durationInFrames={durationInFrames}
      fps={fps}
      phase="entrance"
    />;
  } else if (entrance) {
    wrapped = wrapWithEffect(wrapped, entrance, {
      effectName: entranceType ?? 'unknown',
      durationInFrames,
      effectFrames: entranceAnimation?.durationFrames
        ?? secondsToFrames(entranceAnimation?.duration ?? 0.4, fps),
      intensity: entranceEffect!.intensity,
      params: entranceEffect!.params,
      schema: entranceRecord?.schema ?? legacyRegistry?.getSchema(entranceType ?? ''),
    });
  }

  const exitEffect = clip.exit;
  const exitAnimation = exitEffect as ClipAnimation | undefined;
  const exitType = exitAnimation?.id ?? exitAnimation?.type;
  const exitRecord = exitEffect && effectRegistrySnapshot
    ? resolveSnapshotEffect(effectRegistrySnapshot, exitType ?? '')
    : undefined;
  // A provider-owned snapshot record takes precedence over the package built-in.
  const packageExit = exitAnimation && exitEffect && !exitRecord
    ? resolvePackageAnimation(exitAnimation, 'exit', fps)
    : 'unknown';
  const exit = packageExit === 'unknown' && exitEffect
    ? exitRecord?.component
      ?? (legacyRegistry && exitType ? lookupEffect(exitEffects, exitType) : null)
    : null;
  if (exitAnimation && packageExit === 'supported' && exitType !== 'type-on') {
    wrapped = <PackageAnimation
      content={wrapped}
      clip={clip}
      animation={exitAnimation}
      durationInFrames={durationInFrames}
      fps={fps}
      phase="exit"
    />;
  } else if (exit) {
    wrapped = wrapWithEffect(wrapped, exit, {
      effectName: exitType ?? 'unknown',
      durationInFrames,
      effectFrames: exitAnimation?.durationFrames
        ?? secondsToFrames(exitAnimation?.duration ?? 0.4, fps),
      intensity: exitEffect!.intensity,
      params: exitEffect!.params,
      schema: exitRecord?.schema ?? legacyRegistry?.getSchema(exitType ?? ''),
    });
  }

  return hasClipFade(clip) ? <ClipFadeOpacity clip={clip} fps={fps}>{wrapped}</ClipFadeOpacity> : wrapped;
};

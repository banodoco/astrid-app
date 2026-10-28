import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  compileCanonicalTransitions,
  prepareCompositionScene,
  toRuntimeTheme,
} from '@banodoco/timeline-composition';
import { clipSequenceTiming } from '@/tools/video-editor/compositions/ClipTransition.tsx';
import type { ResolvedTimelineClip } from '@/tools/video-editor/types/index.ts';

const FPS = 30;
const track = { id: 'v', kind: 'visual' as const };

// Reviewed oversized fixture: start S=30, incoming transition T=60, own duration D=30.
// The package's incoming rule (P=T, R=max(0,S-P), end=R+D+P) gives a span from 0 of H=90.
const clips = (second: Record<string, unknown>) => [
  { id: 'a', track: 'v', clipType: 'media', at: 0, hold: 1, asset: 'x' },
  { id: 'b', track: 'v', clipType: 'media', at: 1, hold: 1, asset: 'x', transition: { id: 'fade', durationFrames: 60 }, ...second },
] as unknown as ResolvedTimelineClip[];

const packagePlan = (list: ResolvedTimelineClip[]) => {
  const theme = toRuntimeTheme(DEFAULT_THEME);
  const compiled = compileCanonicalTransitions([{ track, clips: list as never }], FPS, theme);
  const scene = prepareCompositionScene([{ track, clips: list as never }], { assets: {} } as never, FPS, theme, 160, 90,
    undefined, undefined, {}, '', {}, {}, compiled);
  return scene.tracks[0].prepared.plans[1];
};

describe('clipSequenceTiming against the installed package incoming plan', () => {
  it('runs the oversized transition for the full span from a clamped start (H=90)', () => {
    const list = clips({});
    const plan = packagePlan(list);
    const timing = clipSequenceTiming(list[1], FPS, list[0]);
    expect(plan.drawStart).toBe(0);
    expect(plan.drawDuration).toBe(90);
    expect(timing).toEqual({ from: plan.drawStart, effectiveDuration: plan.drawDuration });
  });

  it('caps the span at the canonical occurrence end like the package', () => {
    const list = clips({ app: { canonicalTiming: { occurrenceStartMs: 1000, occurrenceDurationMs: 1000 } } });
    const plan = packagePlan(list);
    const timing = clipSequenceTiming(list[1], FPS, list[0]);
    expect(plan.drawDuration).toBe(60);
    expect(timing).toEqual({ from: plan.drawStart, effectiveDuration: plan.drawDuration });
  });
});

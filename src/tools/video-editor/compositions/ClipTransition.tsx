import { useMemo, type CSSProperties, type FC, type ReactNode } from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { getClipDurationInFrames, secondsToFrames } from '@/tools/video-editor/lib/config-utils.ts';
import { transitionReferenceFrames, transitionReferenceId } from '@/tools/video-editor/lib/transition-reference.ts';
import { useOptionalTransitionRegistryContext } from '@/tools/video-editor/transitions/registry/index.ts';
import { createTransitionSnapshot, resolveTransition } from '@/tools/video-editor/transitions/catalog.ts';
import type { ResolvedTimelineClip } from '@/tools/video-editor/types/index.ts';

// inline missing-transition placeholder body. Renders when
// a clip has a transition type that cannot be resolved through the unified
// catalog (built-ins + provider registry). The clip content still renders, but
// without transition styling — the placeholder is rendered as a diagnostic
// overlay. No silent fallback to crossfade.
const MissingTransitionBody: FC<{ clipId: string; transitionType: string }> = ({ clipId, transitionType }) => (
  <AbsoluteFill
    data-testid="missing-transition-placeholder"
    data-clip-id={clipId}
    data-transition-type={transitionType}
    style={{
      backgroundColor: '#1A0A2E',
      borderTop: '2px solid #A855F7',
      borderBottom: '2px solid #A855F7',
      color: '#E9D5FF',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '12px 24px',
      textAlign: 'center',
      fontFamily:
        'ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      letterSpacing: '0.04em',
    }}
  >
    <div
      style={{
        maxWidth: '80%',
        padding: '8px 16px',
        borderRadius: 4,
        background: 'rgba(0, 0, 0, 0.45)',
      }}
    >
      {`transition '${transitionType}' not found — clip will render without transition`}
    </div>
  </AbsoluteFill>
);

export const ClipTransition: FC<{ clip: ResolvedTimelineClip; fps: number; children: ReactNode }> = ({ clip, fps, children }) => {
  const frame = useCurrentFrame();
  const transitionRegistryContext = useOptionalTransitionRegistryContext();
  const mergedTransitionSnapshot = useMemo(
    () => createTransitionSnapshot(transitionRegistryContext?.snapshot),
    [transitionRegistryContext?.snapshot],
  );
  let transitionStyle: CSSProperties | undefined;
  if (clip.transition) {
    const transitionType = transitionReferenceId(clip.transition) ?? 'unknown';
    const transitionFrames = transitionReferenceFrames(clip.transition, fps);
    const record = resolveTransition(transitionType, mergedTransitionSnapshot);
    if (record) {
      const transitionProgress = interpolate(
        frame,
        [0, Math.max(1, transitionFrames)],
        [0, 1],
        {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        },
      );
      const renderer = record.renderer;
      const params = clip.transition.params ?? {};
      if (typeof renderer === 'function') {
        transitionStyle = (renderer as (progress: number, params: Record<string, unknown>) => CSSProperties)(
          transitionProgress,
          params,
        );
      } else {
        // Object-style renderer (static CSSProperties)
        transitionStyle = renderer as CSSProperties;
      }
    } else {
      // Transition ID not found in catalog — render diagnostic placeholder
      // and skip the clip content wrapper (the clip still renders, but
      // without transition styling). No crossfade fallback.
      return <MissingTransitionBody clipId={clip.id} transitionType={transitionType} />;
    }
  }

  return <AbsoluteFill style={{ overflow: 'hidden', ...transitionStyle }}>{children}</AbsoluteFill>;
};

export const clipSequenceTiming = (clip: ResolvedTimelineClip, fps: number, predecessor?: ResolvedTimelineClip | null) => {
  const durationInFrames = getClipDurationInFrames(clip, fps);
  const transitionFrames = predecessor && clip.transition
    ? transitionReferenceFrames(clip.transition, fps)
    : 0;
  const from = Math.max(0, secondsToFrames(clip.at, fps) - transitionFrames);
  const canonicalTiming = clip.app?.canonicalTiming as
    | { occurrenceStartMs?: unknown; occurrenceDurationMs?: unknown }
    | undefined;
  const canonicalEndMs = typeof canonicalTiming?.occurrenceStartMs === 'number'
    && typeof canonicalTiming.occurrenceDurationMs === 'number'
    ? canonicalTiming.occurrenceStartMs + canonicalTiming.occurrenceDurationMs
    : undefined;
  // Matches the package transition-spans incoming branch: the sequence runs
  // the full transition length past `from` (end = from + D + T even when the
  // start clamps at 0), then canonical clips cap at their half-open end.
  const effectiveDuration = canonicalEndMs === undefined
    ? durationInFrames + transitionFrames
    : Math.max(0, Math.min(
        durationInFrames + transitionFrames,
        Math.ceil((canonicalEndMs / 1000) * fps) - from,
      ));

  return { from, effectiveDuration };
};


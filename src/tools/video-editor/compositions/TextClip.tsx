import type { FC } from 'react';
import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';
import { getClipDurationInFrames } from '@/tools/video-editor/lib/config-utils.ts';
import { ClipTransition, clipSequenceTiming } from '@/tools/video-editor/compositions/ClipTransition.tsx';
import { getDefaultBoxForClipType } from '@/tools/video-editor/clip-types/index.ts';
import { wrapWithClipEffects } from '@/tools/video-editor/effects/index.tsx';
import {
  useOptionalEffectRegistryContext,
  type EffectRegistrySnapshot,
} from '@/tools/video-editor/effects/registry/index.ts';
import type { ResolvedTimelineClip, TrackDefinition } from '@/tools/video-editor/types/index.ts';

type TextClipProps = {
  clip: ResolvedTimelineClip;
  track: TrackDefinition;
  fps: number;
  effectRegistrySnapshot?: EffectRegistrySnapshot;
  predecessor?: ResolvedTimelineClip | null;
};

export const TextClip: FC<TextClipProps> = ({ clip, track: _track, fps, effectRegistrySnapshot }) => {
  const providerRegistryContext = useOptionalEffectRegistryContext();
  const registrySnapshot = effectRegistrySnapshot ?? providerRegistryContext?.snapshot;
  const { width: compositionWidth, height: compositionHeight } = useVideoConfig();
  const durationInFrames = getClipDurationInFrames(clip, fps);
  const text = clip.text;
  if (!text) {
    return null;
  }

  // Position-less clips fall back to the clip-type descriptor's canonical
  // default box — the same box the gizmo and the properties panel show. The
  // renderer must not invent its own (0,0,640,160), or a legacy x-less text
  // clip would render 120px away from its own gizmo.
  const defaultBox = getDefaultBoxForClipType(clip.clipType ?? 'text', compositionWidth, compositionHeight);
  const content = (
    <AbsoluteFill
      style={{
        left: clip.x ?? defaultBox.x,
        top: clip.y ?? defaultBox.y,
        width: clip.width ?? defaultBox.width,
        height: clip.height ?? defaultBox.height,
        position: 'absolute',
        justifyContent: 'center',
        color: text.color ?? '#ffffff',
        fontFamily: text.fontFamily ?? 'Georgia, serif',
        fontSize: text.fontSize ?? 64,
        fontWeight: text.bold ? 700 : 400,
        fontStyle: text.italic ? 'italic' : 'normal',
        textAlign: text.align ?? 'center',
        whiteSpace: 'pre-wrap',
        lineHeight: 1.1,
        // Captions and other overlay copy must stay legible on both bright
        // and dark footage. Two shadows provide a tight edge plus a softer
        // halo without adding a schema-specific stroke/background field.
        textShadow: '0 2px 4px rgba(0, 0, 0, 0.95), 0 2px 18px rgba(0, 0, 0, 0.8)',
        opacity: clip.opacity ?? 1,
      }}
    >
      {text.content}
    </AbsoluteFill>
  );

  return <>{wrapWithClipEffects(<ClipTransition clip={clip} fps={fps}>{content}</ClipTransition>, clip, durationInFrames, fps, registrySnapshot)}</>;
};

export const TextClipSequence: FC<TextClipProps> = ({ clip, track, fps, effectRegistrySnapshot, predecessor }) => {
  const { from, effectiveDuration } = clipSequenceTiming(clip, fps, predecessor);
  return (
    <Sequence
      key={clip.id}
      from={from}
      durationInFrames={effectiveDuration}
    >
      <TextClip clip={clip} track={track} fps={fps} effectRegistrySnapshot={effectRegistrySnapshot} />
    </Sequence>
  );
};

import {
  audioEnvelopeAt,
  compileAudioEnvelope,
  type AudioEnvelope,
} from '@banodoco/timeline-composition/evaluation';
import { getClipDurationInFrames } from '@/tools/video-editor/lib/config-utils.ts';
import type { TimelineClip } from '@/tools/video-editor/types/index.ts';

export type AudioVolumeProp = number | ((frame: number) => number);

/**
 * Compile the fade fields supported by Astrid's timeline projection through
 * Composition's public envelope compiler. Build a narrow runtime clip so
 * unknown document fields (including Composition's raw `audio.envelope` shape)
 * are not silently enabled by this adapter.
 */
export function getAudioFade(clip: TimelineClip, fps: number): AudioEnvelope | null {
  const params = clip.params ?? {};
  const durationFrames = getClipDurationInFrames(clip, fps);
  const envelopeClip = {
    id: clip.id,
    track: clip.track,
    at: 0,
    hold: durationFrames / fps,
    speed: 1,
    params: {
      fadeIn: params.fadeIn,
      fadeOut: params.fadeOut,
      fadeInCurve: params.fadeInCurve,
      fadeOutCurve: params.fadeOutCurve,
    },
  };
  return compileAudioEnvelope(envelopeClip, fps) ?? null;
}

/**
 * Remotion `volume` callback backed by Composition's clip-local envelope math.
 * `frameOffset` keeps a canonical occurrence's envelope anchored to the
 * authored clip when the rendered Sequence begins later.
 */
export function getAudioVolumeProp(
  baseVolume: number,
  envelope: AudioEnvelope | null,
  fps: number,
  frameOffset = 0,
): AudioVolumeProp {
  if (!envelope) return baseVolume;
  return (frame: number) => baseVolume * audioEnvelopeAt(envelope, (frame + frameOffset) / fps);
}

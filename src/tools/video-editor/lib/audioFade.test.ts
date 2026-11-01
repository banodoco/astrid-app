import { audioEnvelopeAt, compileAudioEnvelope } from '@banodoco/timeline-composition/evaluation';
import { describe, expect, it } from 'vitest';
import { getAudioFade, getAudioVolumeProp } from '@/tools/video-editor/lib/audioFade';
import type { TimelineClip } from '@/tools/video-editor/types';

const FPS = 30;

// The film's music bed (project almost-ready): two crossfades, at 28.5 s and 84.4 s.
const chip: TimelineClip = { id: 'music-chip', track: 'music', at: 0, from: 0, to: 31.5, volume: 0.5129, params: { fadeOut: 3 } };
const piano: TimelineClip = { id: 'music-piano', track: 'music', at: 28.5, from: 28.5, to: 88.4, volume: 0.7674, params: { fadeIn: 3, fadeOut: 4 } };
const orch: TimelineClip = { id: 'music-orch', track: 'music', at: 84.4, from: 123.46, to: 199.393331, volume: 0.263, params: { fadeIn: 4, fadeOut: 3 } };

function packageEnvelope(clip: TimelineClip) {
  return compileAudioEnvelope(clip, FPS);
}

function gainAt(clip: TimelineClip, compositionSecond: number): number {
  const envelope = getAudioFade(clip, FPS);
  const frame = Math.round(compositionSecond * FPS) - Math.round(clip.at * FPS);
  return envelope ? audioEnvelopeAt(envelope, frame / FPS) : 1;
}

describe('audio fades (Composition envelope semantics)', () => {
  it('matches package fade envelopes for the timeline music examples', () => {
    for (const clip of [chip, piano, orch]) {
      const actual = getAudioFade(clip, FPS);
      const expected = packageEnvelope(clip);
      expect(actual).toEqual(expected);
    }
    expect(audioEnvelopeAt(getAudioFade(chip, FPS)!, 28.5)).toBe(1);
    expect(audioEnvelopeAt(getAudioFade(chip, FPS)!, 30)).toBeCloseTo(0.5, 10);
    expect(audioEnvelopeAt(getAudioFade(chip, FPS)!, 31.5)).toBe(0);
    expect(audioEnvelopeAt(getAudioFade(piano, FPS)!, 1.5)).toBeCloseTo(0.5, 10);
  });

  it('crossfades the chiptune into the piano over 28.5–31.5 s instead of overlapping at full level', () => {
    expect(gainAt(chip, 28.5)).toBe(1);
    expect(gainAt(piano, 28.5)).toBe(0);
    expect(gainAt(chip, 30)).toBeCloseTo(0.5, 10);
    expect(gainAt(piano, 30)).toBeCloseTo(0.5, 10);
    expect(gainAt(chip, 31.5)).toBe(0);
    expect(gainAt(piano, 31.5)).toBe(1);
  });

  it('crossfades the piano into the orchestra over 84.4–88.4 s and fades the orchestra out at the end', () => {
    expect(gainAt(piano, 84.4)).toBe(1);
    expect(gainAt(orch, 84.4)).toBe(0);
    expect(gainAt(piano, 86.4)).toBeCloseTo(0.5, 10);
    expect(gainAt(orch, 86.4)).toBeCloseTo(0.5, 10);
    expect(gainAt(piano, 88.4)).toBe(0);
    expect(gainAt(orch, 88.4)).toBe(1);
    expect(gainAt(orch, 158.8)).toBeCloseTo(0.5, 1);
  });

  it('keeps a plain gain when fade values are zero or invalid', () => {
    for (const params of [undefined, {}, { fadeIn: 0 }, { fadeIn: -1, fadeOut: Number.NaN }, { fadeIn: '2' }, { fadeOut: Infinity }]) {
      const clip: TimelineClip = { ...chip, params: params as TimelineClip['params'] };
      expect(getAudioFade(clip, FPS)).toBeNull();
      expect(getAudioVolumeProp(0.4, getAudioFade(clip, FPS), FPS)).toBe(0.4);
    }
  });

  it('does not opt raw package audio envelopes into the App timeline projection', () => {
    const clipWithRawEnvelope = {
      ...chip,
      params: {},
      audio: { envelope: { keyframes: [{ at: 0, value: 0 }, { at: 1, value: 1 }] } },
    } as TimelineClip;
    expect(getAudioFade(clipWithRawEnvelope, FPS)).toBeNull();
  });

  it('anchors the ramp to the authored clip when playback starts later', () => {
    const envelope = getAudioFade(piano, FPS)!;
    const volume = getAudioVolumeProp(1, envelope, FPS, 30) as (frame: number) => number;
    // One second into the played Sequence is two seconds into the clip.
    expect(volume(30)).toBeCloseTo(audioEnvelopeAt(packageEnvelope(piano)!, 2), 12);
  });
});

import { describe, expect, it } from 'vitest';
import type { TimelineData } from '@/tools/video-editor/lib/timeline-data';
import {
  clampClipToMediaDuration,
  convertOverhangToHold,
  detectClipOverhang,
} from '@/tools/video-editor/lib/overhang';

describe('detectClipOverhang', () => {
  it('accounts for clip speed when calculating playable time', () => {
    const overhang = detectClipOverhang({
      clipMeta: {
        from: 1,
        speed: 2,
      },
      timelineDurationSeconds: 2,
      sourceDurationSeconds: 3,
    });

    expect(overhang).toEqual(expect.objectContaining({
      playableTimelineDurationSeconds: 1,
      overhangTimelineDurationSeconds: 1,
      overhangSourceDurationSeconds: 2,
      mediaEndFraction: 0.5,
    }));
  });

  it('returns null when the clip already fits inside the media duration', () => {
    expect(detectClipOverhang({
      clipMeta: {
        from: 0,
        speed: 1,
      },
      timelineDurationSeconds: 3,
      sourceDurationSeconds: 3,
    })).toBeNull();
  });
});

describe('clampClipToMediaDuration', () => {
  it('shortens the timeline action and updates the trim end', () => {
    const result = clampClipToMediaDuration({
      action: {
        id: 'clip-0',
        start: 12,
        end: 17,
        effectId: 'effect-clip-0',
      },
      clipMeta: {
        from: 0,
        speed: 1,
      },
      sourceDurationSeconds: 3,
    });

    expect(result).toEqual(expect.objectContaining({
      nextAction: expect.objectContaining({
        start: 12,
        end: 15,
      }),
      metaPatch: {
        to: 3,
      },
    }));
  });
});

describe('convertOverhangToHold', () => {
  it('splits the frozen tail into a separate hold clip without shifting later clips', () => {
    const current = {
      rows: [{
        id: 'V1',
        actions: [
          { id: 'clip-0', start: 10, end: 15, effectId: 'effect-clip-0' },
          { id: 'clip-1', start: 18, end: 20, effectId: 'effect-clip-1' },
        ],
      }],
      meta: {
        'clip-0': {
          asset: 'asset-video',
          track: 'V1',
          clipType: 'media',
          from: 0,
          to: 5,
          speed: 1,
          volume: 1,
          opacity: 0.8,
          fit: 'cover',
          x: 10,
          y: 20,
          width: 640,
          height: 360,
        },
        'clip-1': {
          asset: 'asset-next',
          track: 'V1',
          clipType: 'hold',
          hold: 2,
        },
      },
      clipOrder: {
        V1: ['clip-0', 'clip-1'],
      },
    } as unknown as TimelineData;

    const result = convertOverhangToHold({
      current,
      clipId: 'clip-0',
      sourceDurationSeconds: 3,
      frameRate: 30,
    });

    expect(result).not.toBeNull();
    expect(result?.holdClipId).toBe('clip-2');
    expect(result?.rows).toEqual([{
      id: 'V1',
      actions: [
        { id: 'clip-0', start: 10, end: 13, effectId: 'effect-clip-0' },
        { id: 'clip-2', start: 13, end: 15, effectId: 'effect-clip-2' },
        { id: 'clip-1', start: 18, end: 20, effectId: 'effect-clip-1' },
      ],
    }]);
    expect(result?.clipOrderOverride).toEqual({
      V1: ['clip-0', 'clip-2', 'clip-1'],
    });
    expect(result?.metaUpdates).toEqual(expect.objectContaining({
      'clip-0': {
        to: 3,
      },
      'clip-2': expect.objectContaining({
        asset: 'asset-video',
        track: 'V1',
        clipType: 'hold',
        hold: 2,
        from: expect.closeTo(3 - (1 / 30), 5),
        to: 3,
        speed: 1,
        volume: 0,
        opacity: 0.8,
        fit: 'cover',
        x: 10,
        y: 20,
        width: 640,
        height: 360,
      }),
    }));
  });
});

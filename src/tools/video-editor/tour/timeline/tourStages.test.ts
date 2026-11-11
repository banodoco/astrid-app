import { describe, expect, it } from 'vitest';

import type { TimelinePatch } from '@/sdk/video/timeline/patch.ts';
import { compileTimelinePatch } from '@/tools/video-editor/lib/timeline-patch.ts';
import { buildTimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import type { TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import { EDITOR_TOUR_TRACK_IDS } from '@/tools/video-editor/tour/anchors.ts';
import { EDITOR_TOUR_MEDIA } from '@/tools/video-editor/tour/tourMedia.ts';
import {
  EDITOR_TOUR_TIMELINE_ID,
  TOUR_CLIP_IDS,
  TOUR_ANCHOR_SECONDS,
  TOUR_SCENE_SECONDS,
  createEditorTourAssetRegistry,
  createEditorTourStagePatch,
  createEditorTourStageRemovalPatch,
  createEditorTourTimeline,
} from './tourStages.ts';

/** Builds the demo's starting TimelineData through the same path the editor uses to load a timeline. */
const buildStartData = (): Promise<TimelineData> =>
  buildTimelineData(createEditorTourTimeline(), createEditorTourAssetRegistry());

/** Applies one stage patch and asserts it compiled with no error diagnostics. */
const applyStage = (data: TimelineData, patch: TimelinePatch) => {
  const result = compileTimelinePatch(patch, data);
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  expect(errors).toEqual([]);
  expect(result.valid).toBe(true);
  expect(result.nextData).not.toBeNull();
  return result.nextData as TimelineData;
};

/** `tracks[0]` is the top row on the timeline and the top layer in the preview. */
const trackIdsTopFirst = (data: TimelineData): string[] =>
  (data.config.tracks ?? []).map((track) => track.id);

const clipIdsOn = (data: TimelineData, trackId: string): string[] =>
  data.config.clips.filter((clip) => clip.track === trackId).map((clip) => clip.id);

describe('editor tour timeline stages', () => {
  it('builds the empty demo timeline with only the scene row', async () => {
    const data = await buildStartData();
    expect(trackIdsTopFirst(data)).toEqual([EDITOR_TOUR_TRACK_IDS.scene]);
    expect(data.config.clips).toEqual([]);
    // The base row carries the editor's ordinary first-track label until the scene lands.
    expect(data.config.tracks?.[0].label).toBe('V1');
  });

  it('stage 1 places the muted 14 s guide video on the scene track', async () => {
    const start = await buildStartData();
    const data = applyStage(start, createEditorTourStagePatch(1));

    expect(trackIdsTopFirst(data)).toEqual([EDITOR_TOUR_TRACK_IDS.scene]);
    expect(data.config.clips).toHaveLength(1);
    expect(data.config.tracks?.find((track) => track.id === EDITOR_TOUR_TRACK_IDS.scene)?.label).toBe('Three.js');

    const clip = data.config.clips[0];
    expect(clip.id).toBe(TOUR_CLIP_IDS.scene);
    expect(clip.track).toBe(EDITOR_TOUR_TRACK_IDS.scene);
    expect(clip).toMatchObject({ clipType: 'media', asset: 'tour-guide', at: 0, from: 0, to: 14, speed: 1, volume: 0, label: 'Lantern Valley Three.js visualization' });
    // An ordinary media clip: no live scene, no extension payload.
    expect(clip.app).toBeUndefined();
  });

  it('the stage 1 removal patch takes the scene clip off and restores the base label', async () => {
    const landed = applyStage(await buildStartData(), createEditorTourStagePatch(1));
    const data = applyStage(landed, createEditorTourStageRemovalPatch(1));

    expect(data.config.clips).toEqual([]);
    expect(data.config.tracks?.find((track) => track.id === EDITOR_TOUR_TRACK_IDS.scene)?.label).toBe('V1');
  });

  it('stage 2 places all four reference frames above the scene at their guide times', async () => {
    const start = await buildStartData();
    const stage1 = applyStage(start, createEditorTourStagePatch(1));
    const data = applyStage(stage1, createEditorTourStagePatch(2));

    expect(trackIdsTopFirst(data)).toEqual([EDITOR_TOUR_TRACK_IDS.stills, EDITOR_TOUR_TRACK_IDS.scene]);
    expect(clipIdsOn(data, EDITOR_TOUR_TRACK_IDS.scene)).toEqual([TOUR_CLIP_IDS.scene]);
    expect(clipIdsOn(data, EDITOR_TOUR_TRACK_IDS.stills)).toEqual([...TOUR_CLIP_IDS.stills]);

    const [first, mountain, descent, last] = TOUR_CLIP_IDS.stills.map((id) => data.config.clips.find((clip) => clip.id === id));
    expect(first).toMatchObject({ track: EDITOR_TOUR_TRACK_IDS.stills, at: 0, clipType: 'hold', asset: 'tour-still-start', hold: TOUR_ANCHOR_SECONDS, label: 'Start frame' });
    expect(mountain).toMatchObject({ at: 6.5, asset: 'tour-still-mid-1', hold: 1 });
    expect(descent).toMatchObject({ at: 10, asset: 'tour-still-mid-2', hold: 1 });
    expect(last).toMatchObject({ track: EDITOR_TOUR_TRACK_IDS.stills, at: 13, clipType: 'hold', asset: 'tour-still-end', hold: TOUR_ANCHOR_SECONDS, label: 'Town frame' });
    expect(TOUR_ANCHOR_SECONDS).toBe(1);
    expect(last?.at).toBe(13);
  });

  it('stage 3 adds the video row on top with one muted 14 s MiniMax H3 clip', async () => {
    const start = await buildStartData();
    const stage1 = applyStage(start, createEditorTourStagePatch(1));
    const stage2 = applyStage(stage1, createEditorTourStagePatch(2));
    const data = applyStage(stage2, createEditorTourStagePatch(3));

    expect(trackIdsTopFirst(data)).toEqual([
      EDITOR_TOUR_TRACK_IDS.videos,
      EDITOR_TOUR_TRACK_IDS.stills,
      EDITOR_TOUR_TRACK_IDS.scene,
    ]);
    expect(clipIdsOn(data, EDITOR_TOUR_TRACK_IDS.scene)).toEqual([TOUR_CLIP_IDS.scene]);
    expect(clipIdsOn(data, EDITOR_TOUR_TRACK_IDS.stills)).toEqual([...TOUR_CLIP_IDS.stills]);
    expect(clipIdsOn(data, EDITOR_TOUR_TRACK_IDS.videos)).toEqual([TOUR_CLIP_IDS.video]);

    const video = data.config.clips.find((clip) => clip.id === TOUR_CLIP_IDS.video);
    expect(video).toMatchObject({ track: EDITOR_TOUR_TRACK_IDS.videos, at: 0, clipType: 'media', asset: 'tour-video', from: 0, to: 14, volume: 0, label: 'MiniMax H3' });
    expect(TOUR_SCENE_SECONDS).toBe(14);
  });

  it('points every media asset at the real URL of its slot', () => {
    const { assets } = createEditorTourAssetRegistry();
    const expected: Record<string, string> = {
      'tour-still-start': EDITOR_TOUR_MEDIA.stills[0].url,
      'tour-still-mid-1': EDITOR_TOUR_MEDIA.stills[1].url,
      'tour-still-mid-2': EDITOR_TOUR_MEDIA.stills[2].url,
      'tour-still-end': EDITOR_TOUR_MEDIA.stills[3].url,
      'tour-guide': EDITOR_TOUR_MEDIA.guide.url,
      'tour-video': EDITOR_TOUR_MEDIA.video.url,
    };
    for (const [id, url] of Object.entries(expected)) {
      expect(url, id).not.toBe('');
      expect(assets[id].file, id).toBe(url);
      expect(assets[id].file.startsWith('data:'), id).toBe(false);
    }
    expect(assets['tour-video'].duration).toBe(14.375);
    expect(assets['tour-guide'].duration).toBe(14);
    expect(assets['tour-guide'].type).toBe('video/mp4');
  });

  it('gives every clip a 320 px thumbnail, so the timeline never decodes an original for a 40 px slot', () => {
    const { assets } = createEditorTourAssetRegistry();
    for (const [id, entry] of Object.entries(assets)) {
      expect(entry.thumbnailUrl, id).toMatch(/\.webp$/);
      expect(entry.thumbnailUrl, id).not.toBe(entry.file);
    }
    expect(assets['tour-guide'].thumbnailUrl).toBe(EDITOR_TOUR_MEDIA.guide.thumbUrl);
    expect(assets['tour-still-end'].thumbnailUrl).toBe(EDITOR_TOUR_MEDIA.stills[3].thumbUrl);
  });

  it('names the media after what it is, not after the files', () => {
    const { assets } = createEditorTourAssetRegistry();
    expect(assets['tour-still-start'].metadata?.filename).toBe('Start frame');
    expect(assets['tour-still-end'].metadata?.filename).toBe('Town frame');
    expect(assets['tour-video'].metadata?.filename).toBe('MiniMax H3');
  });

  it('gives an empty media slot a non-empty neutral url', () => {
    const empty = { url: '', width: 1280, height: 720, durationSeconds: 10 };
    const { assets } = createEditorTourAssetRegistry({ frames: [empty, empty], stills: [empty, empty, empty, empty], video: empty, guide: empty });
    for (const id of ['tour-still-start', 'tour-still-end', 'tour-guide', 'tour-video']) {
      expect(assets[id].file.startsWith('data:'), id).toBe(true);
    }
  });

  it('keeps the tour timeline id stable', () => {
    expect(EDITOR_TOUR_TIMELINE_ID).toBe('tour-timeline');
  });
});

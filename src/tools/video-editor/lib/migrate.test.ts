import { describe, expect, it } from 'vitest';
import { repairConfig } from '@/tools/video-editor/lib/migrate';
import { canonicalizeTimelineConfigSnapshot, canonicalizeTimelinePair } from '@/tools/video-editor/lib/timeline-domain';
import { configToRows, rowsToConfig } from '@/tools/video-editor/lib/timeline-data';
import type { TimelineConfig } from '@/tools/video-editor/types';

describe('repairConfig — legacy pinnedShotGroups migration', () => {
  const buildLegacyConfig = (): TimelineConfig => ({
    output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
    tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
    clips: [
      { id: 'clip-a', at: 0, track: 'V1', clipType: 'hold', hold: 1 },
      { id: 'clip-b', at: 1, track: 'V1', clipType: 'hold', hold: 2 },
      { id: 'clip-c', at: 3, track: 'V1', clipType: 'hold', hold: 1.5 },
    ],
    // Legacy projection-shape group with `start` and `children` fields.
    pinnedShotGroups: [
      {
        shotId: 'shot-1',
        trackId: 'V1',
        clipIds: ['clip-a', 'clip-b', 'clip-c'],
        mode: 'images',
        imageClipSnapshot: [
          {
            clipId: 'clip-a',
            assetKey: 'asset-a',
            start: 0,
            end: 1,
            meta: { clipType: 'hold', hold: 1 },
          },
        ],
        // `as unknown as ...` escape hatch — the runtime file has extra legacy fields
        // even though the TS type no longer allows them.
        ...({
          start: 0,
          children: [
            { clipId: 'clip-a', offset: 0, duration: 1 },
            { clipId: 'clip-b', offset: 1, duration: 2 },
            { clipId: 'clip-c', offset: 3, duration: 1.5 },
          ],
        } as unknown as object),
      },
    ] as TimelineConfig['pinnedShotGroups'],
  });

  it('strips legacy `start`/`children` and derives clipIds from children', () => {
    const repaired = repairConfig(buildLegacyConfig());
    const [group] = repaired.pinnedShotGroups ?? [];
    expect(group).toBeDefined();
    expect(group).toMatchObject({
      shotId: 'shot-1',
      trackId: 'V1',
      clipIds: ['clip-a', 'clip-b', 'clip-c'],
      mode: 'images',
      imageClipSnapshot: [
        {
          clipId: 'clip-a',
          assetKey: 'asset-a',
          start: 0,
          end: 1,
          meta: { clipType: 'hold', hold: 1 },
        },
      ],
    });
    // Legacy fields must be gone.
    expect(Object.prototype.hasOwnProperty.call(group, 'start')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(group, 'children')).toBe(false);
  });

  it('preserves clipIds when legacy `children` array is missing', () => {
    const config = buildLegacyConfig();
    const [g] = config.pinnedShotGroups ?? [];
    const legacyWithoutChildren = {
      shotId: g.shotId,
      trackId: g.trackId,
      clipIds: ['clip-a', 'clip-b', 'clip-c'],
      mode: g.mode,
      ...({ start: 0 } as unknown as object),
    };
    config.pinnedShotGroups = [legacyWithoutChildren] as TimelineConfig['pinnedShotGroups'];

    const repaired = repairConfig(config);
    const [repairedGroup] = repaired.pinnedShotGroups ?? [];
    expect(repairedGroup?.clipIds).toEqual(['clip-a', 'clip-b', 'clip-c']);
    expect(Object.prototype.hasOwnProperty.call(repairedGroup, 'start')).toBe(false);
  });

  it('round-trips via configToRows → rowsToConfig without emitting legacy fields', () => {
    const repaired = repairConfig(buildLegacyConfig());
    const { rows, meta, clipOrder } = configToRows(repaired);
    const nextConfig = rowsToConfig(
      rows,
      meta,
      repaired.output,
      clipOrder,
      repaired.tracks ?? [],
      repaired.pinnedShotGroups,
    );

    const [group] = nextConfig.pinnedShotGroups ?? [];
    expect(group).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(group, 'start')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(group, 'children')).toBe(false);
    expect(group).toMatchObject({
      shotId: 'shot-1',
      trackId: 'V1',
      clipIds: ['clip-a', 'clip-b', 'clip-c'],
      mode: 'images',
      imageClipSnapshot: [
        {
          clipId: 'clip-a',
          assetKey: 'asset-a',
          start: 0,
          end: 1,
          meta: { clipType: 'hold', hold: 1 },
        },
      ],
    });
  });

  it('leaves already-soft-tag configs unchanged', () => {
    const config: TimelineConfig = {
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
      clips: [
        { id: 'clip-a', at: 0, track: 'V1', clipType: 'hold', hold: 1 },
      ],
      pinnedShotGroups: [
        { shotId: 'shot-1', trackId: 'V1', clipIds: ['clip-a'], mode: 'images' },
      ],
    };
    const repaired = repairConfig(config);
    expect(repaired.pinnedShotGroups).toBe(config.pinnedShotGroups);
  });

  it('exposes explicit config-only and pair-aware canonicalization contracts', () => {
    const config: TimelineConfig = {
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      clips: [
        { id: 'clip-1', at: 0, track: 'video', asset: 'asset-1' },
      ],
    };

    const configOnly = canonicalizeTimelineConfigSnapshot(config);
    expect(configOnly.level).toBe('config-only');
    expect(configOnly.config.tracks?.map((track) => track.id)).toEqual(['V1', 'V2', 'V3', 'A1']);
    expect(configOnly.config.clips[0]).toMatchObject({ track: 'V2', clipType: 'media' });
    expect(configOnly.issues.map((issue) => issue.code)).toContain('legacy_tracks_migrated');
    expect(configOnly.issues.map((issue) => issue.code)).toContain('malformed_non_hold_trim_zero_duration');

    const pairAware = canonicalizeTimelinePair(config, {
      assets: { 'asset-1': { file: 'video.mp4', duration: 4 } },
    });
    expect(pairAware.level).toBe('pair-aware');
    expect(pairAware.config.clips[0]).toMatchObject({
      track: 'V2',
      clipType: 'media',
      from: 0,
      to: 4,
    });
    expect(pairAware.issues.map((issue) => issue.code)).toContain('malformed_non_hold_trim_repaired');
  });
});

describe('applyTrackScaleBakeMigration — one-time track-scale semantics bake', () => {
  const buildScaledConfig = (): TimelineConfig => ({
    output: { resolution: '1280x720', fps: 30, file: 'out.mp4' },
    tracks: [
      { id: 'V1', kind: 'visual', label: 'V1', scale: 0.5 },
      { id: 'V2', kind: 'visual', label: 'V2' },
      { id: 'A1', kind: 'audio', label: 'A1' },
    ],
    clips: [
      // Positioned clip on the scaled track: must be baked (inverse-scaled
      // about the composition center) so its on-screen pixels do not move
      // when the renderer starts scaling positioned clips.
      { id: 'positioned', at: 0, track: 'V1', clipType: 'hold', hold: 2, x: 320, y: 180, width: 640, height: 360 },
      // Un-positioned clip on the scaled track: was already scaled before the
      // decree — stored values stay put.
      { id: 'plain', at: 2, track: 'V1', clipType: 'hold', hold: 2 },
      // Positioned clip on an unscaled track: old and new semantics coincide.
      { id: 'unscaled-track', at: 0, track: 'V2', clipType: 'hold', hold: 2, x: 10, y: 20, width: 100, height: 50 },
    ],
  });

  it('bakes positioned clips on scale≠1 visual tracks and stamps every track', () => {
    const { config, issues } = canonicalizeTimelinePair(buildScaledConfig(), { assets: {} });

    // (320,180,640,360) inverse-scaled by 0.5 about (640,360):
    // width/height double; center (640,360) maps to itself.
    expect(config.clips.find((clip) => clip.id === 'positioned')).toMatchObject({
      x: 0, y: 0, width: 1280, height: 720,
    });
    expect(config.clips.find((clip) => clip.id === 'plain')).not.toHaveProperty('x');
    expect(config.clips.find((clip) => clip.id === 'unscaled-track')).toMatchObject({
      x: 10, y: 20, width: 100, height: 50,
    });

    for (const track of config.tracks ?? []) {
      expect(track.app?.scaleAppliesToPositionedClips, `${track.id} stamped`).toBe(true);
    }
    expect(issues.filter((issue) => issue.code === 'track_scale_positions_baked')).toHaveLength(1);
  });

  it('is idempotent: a stamped config passes through untouched', () => {
    const first = canonicalizeTimelinePair(buildScaledConfig(), { assets: {} });
    const second = canonicalizeTimelinePair(first.config, { assets: {} });

    expect(second.config.clips).toEqual(first.config.clips);
    expect(second.issues.filter((issue) => issue.code === 'track_scale_positions_baked')).toHaveLength(0);
  });

  it('never bakes clips positioned under the new semantics (marker present, scale changed later)', () => {
    const stamped = canonicalizeTimelinePair(buildScaledConfig(), { assets: {} }).config;
    // The user later scales V2 and positions a clip there under new semantics.
    const evolved: TimelineConfig = {
      ...stamped,
      tracks: (stamped.tracks ?? []).map((track) => (
        track.id === 'V2' ? { ...track, scale: 0.5 } : track
      )),
    };

    const { config } = canonicalizeTimelinePair(evolved, { assets: {} });
    expect(config.clips.find((clip) => clip.id === 'unscaled-track')).toMatchObject({
      x: 10, y: 20, width: 100, height: 50,
    });
  });

  it('survives a rows edit round-trip (marker lives on track.app)', () => {
    const stamped = canonicalizeTimelinePair(buildScaledConfig(), { assets: {} }).config;
    const rowData = configToRows(stamped);
    const roundTripped = rowsToConfig(
      rowData.rows,
      rowData.meta,
      stamped.output,
      rowData.clipOrder,
      rowData.tracks,
      stamped.pinnedShotGroups,
      stamped,
    );

    for (const track of roundTripped.tracks ?? []) {
      expect(track.app?.scaleAppliesToPositionedClips, `${track.id} keeps marker`).toBe(true);
    }
  });
});

describe('shared clip placement migration', () => {
  it('persists the legacy fit choice and both markers once, preserving explicit fit', () => {
    const config: TimelineConfig = {
      output: {resolution: '1280x720', fps: 30, file: 'out.mp4'},
      tracks: [{id: 'V1', kind: 'visual', label: 'V1', fit: 'contain'}],
      clips: [
        {id: 'legacy', at: 0, track: 'V1', clipType: 'media', asset: 'a', x: 10, cropLeft: 0.2},
        {id: 'authored', at: 1, track: 'V1', clipType: 'media', asset: 'a', x: 20, fit: 'contain'},
      ],
    };
    const first = canonicalizeTimelineConfigSnapshot(config);
    expect(first.config.clips[0]).toMatchObject({fit: 'cover', x: 10, cropLeft: 0.2});
    expect(first.config.clips[1]).toMatchObject({fit: 'contain', x: 20});
    expect(first.config.tracks?.[0].app).toMatchObject({scaleAppliesToPositionedClips: true, clipPlacementVersion: 1});
    expect(first.issues.some(issue => issue.code === 'clip_placement_migrated')).toBe(true);
    const second = canonicalizeTimelineConfigSnapshot(first.config);
    expect(second.config).toEqual(first.config);
    expect(second.issues.some(issue => issue.code === 'clip_placement_migrated')).toBe(false);
  });
});

it('reports authored canvas materialization as a timeline finding before track repair', () => {
  const input = {theme_overrides: {visual: {canvas: {width: 1280, height: 720, fps: 24}}}, tracks: [{id: 'V1', kind: 'visual', label: 'V1', app: {scaleAppliesToPositionedClips: true, clipPlacementVersion: 1}}], clips: [{id: 'c', at: 0, track: 'V1', clipType: 'media', asset: 'a', x: 40}]} as unknown as TimelineConfig;
  const before = structuredClone(input);
  const result = canonicalizeTimelineConfigSnapshot(input);
  const issue = result.issues.find(item => item.details?.kind === 'canvas');
  expect(issue).toMatchObject({message: 'Using the timeline canvas setting in memory; it has not been written to output.', details: {source: 'theme_overrides.visual.canvas', before: undefined, after: {resolution: '1280x720', fps: 24, file: 'output.mp4'}}});
  expect(issue?.message).not.toContain('undefined');
  expect(result.config.clips[0]).toMatchObject({x: 40});
  expect(result.config.tracks?.[0].app).toMatchObject({scaleAppliesToPositionedClips: true, clipPlacementVersion: 1});
  expect(input).toEqual(before);
});

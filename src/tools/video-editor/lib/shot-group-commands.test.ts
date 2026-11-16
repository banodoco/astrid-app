import { describe, expect, it } from 'vitest';
import { repairConfig } from '@/tools/video-editor/lib/migrate';
import { configToRows, type TimelineData } from '@/tools/video-editor/lib/timeline-data';
import {
  buildPinShotGroupMutation,
  buildDeleteShotGroupMutation,
  buildSwitchShotGroupToFinalVideoMutation,
  buildSwitchShotGroupToImagesMutation,
  buildUnpinShotGroupMutation,
  buildUpdatePinnedShotGroupMutation,
  buildUpdateShotGroupToLatestVideoMutation,
} from '@/tools/video-editor/lib/shot-group-commands';
import type { AssetRegistry, TimelineConfig } from '@/tools/video-editor/types';

function makeTimelineData(config: TimelineConfig, registry: AssetRegistry): TimelineData {
  const canonicalConfig = repairConfig(config);
  const rowData = configToRows(canonicalConfig);

  return {
    config: canonicalConfig,
    configVersion: 1,
    registry,
    resolvedConfig: {
      output: { ...canonicalConfig.output },
      tracks: (canonicalConfig.tracks ?? []).map((track) => ({ ...track })),
      clips: canonicalConfig.clips.map((clip) => ({
        ...clip,
        assetEntry: clip.asset ? {
          ...registry.assets[clip.asset],
          src: registry.assets[clip.asset]?.file ?? '',
        } : undefined,
      })),
      registry: Object.fromEntries(
        Object.entries(registry.assets).map(([assetId, entry]) => [
          assetId,
          { ...entry, src: entry.file },
        ]),
      ),
    },
    rows: rowData.rows,
    meta: rowData.meta,
    effects: rowData.effects,
    assetMap: Object.fromEntries(Object.entries(registry.assets).map(([assetId, entry]) => [assetId, entry.file])),
    output: { ...canonicalConfig.output },
    tracks: (canonicalConfig.tracks ?? []).map((track) => ({ ...track })),
    clipOrder: rowData.clipOrder,
    signature: 'signature',
    stableSignature: 'stable-signature',
  };
}

function makeStaleImageGroupData(): TimelineData {
  return makeTimelineData(
    {
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      tracks: [
        { id: 'V1', kind: 'visual', label: 'V1' },
        { id: 'V2', kind: 'visual', label: 'V2' },
      ],
      clips: [
        { id: 'clip-1', at: 0, track: 'V2', clipType: 'hold', hold: 2 },
        { id: 'clip-2', at: 2, track: 'V2', clipType: 'hold', hold: 2 },
      ],
      pinnedShotGroups: [{
        shotId: 'shot-1',
        trackId: 'V1',
        clipIds: ['clip-1', 'clip-2'],
        mode: 'images',
      }],
    },
    {
      assets: {
        'asset-final': { file: 'video-final.mp4', type: 'video/mp4', generationId: 'final-1' },
      },
    },
  );
}

function makeImageGroupData(): TimelineData {
  return makeTimelineData(
    {
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      tracks: [
        { id: 'V1', kind: 'visual', label: 'V1' },
      ],
      clips: [
        { id: 'clip-1', at: 0, track: 'V1', clipType: 'hold', hold: 2 },
        { id: 'clip-2', at: 2, track: 'V1', clipType: 'hold', hold: 2 },
      ],
      pinnedShotGroups: [{
        shotId: 'shot-1',
        trackId: 'V1',
        clipIds: ['clip-1', 'clip-2'],
        mode: 'images',
      }],
    },
    {
      assets: {
        'asset-final': { file: 'video-final.mp4', type: 'video/mp4', generationId: 'final-1' },
      },
    },
  );
}

function makeStaleVideoGroupData(): TimelineData {
  return makeTimelineData(
    {
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      tracks: [
        { id: 'V1', kind: 'visual', label: 'V1' },
        { id: 'V2', kind: 'visual', label: 'V2' },
      ],
      clips: [
        { id: 'clip-3', at: 7, track: 'V2', clipType: 'media', asset: 'asset-video', from: 0, to: 10, speed: 1 },
      ],
      pinnedShotGroups: [{
        shotId: 'shot-1',
        trackId: 'V1',
        clipIds: ['clip-3'],
        mode: 'video',
        videoAssetKey: 'asset-video',
        imageClipSnapshot: [
          { clipId: 'clip-1', assetKey: 'asset-1', start: 7, end: 10, meta: { clipType: 'hold', hold: 3 } },
        ],
      }],
    },
    {
      assets: {
        'asset-video': { file: 'video-old.mp4', type: 'video/mp4', generationId: 'final-old' },
        'asset-1': { file: 'one.png', type: 'image/png' },
        'asset-video-new': { file: 'video-new.mp4', type: 'video/mp4', generationId: 'final-new' },
      },
    },
  );
}

describe('shot-group-commands', () => {
  it('buildPinShotGroupMutation orders clip ids by live timeline position', () => {
    const currentData = makeTimelineData(
      {
        output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
        tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
        clips: [
          { id: 'clip-1', at: 4, track: 'V1', clipType: 'hold', hold: 2 },
          { id: 'clip-2', at: 1, track: 'V1', clipType: 'hold', hold: 3 },
        ],
      },
      { assets: {} },
    );

    expect(buildPinShotGroupMutation(currentData, {
      shotId: 'shot-1',
      trackId: 'V1',
      clipIds: ['clip-1', 'clip-2'],
      mode: 'images',
    })).toEqual({
      type: 'pinnedShotGroups',
      pinnedShotGroups: [{
        shotId: 'shot-1',
        trackId: 'V1',
        clipIds: ['clip-2', 'clip-1'],
        mode: 'images',
      }],
    });
  });

  it('buildUnpinShotGroupMutation removes only the targeted pinned group', () => {
    const currentData = makeTimelineData(
      {
        output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
        tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
        clips: [
          { id: 'clip-1', at: 0, track: 'V1', clipType: 'hold', hold: 2 },
          { id: 'clip-2', at: 2, track: 'V1', clipType: 'hold', hold: 2 },
        ],
        pinnedShotGroups: [
          { shotId: 'shot-1', trackId: 'V1', clipIds: ['clip-1'], mode: 'images' },
          { shotId: 'shot-2', trackId: 'V1', clipIds: ['clip-2'], mode: 'images' },
        ],
      },
      { assets: {} },
    );

    expect(buildUnpinShotGroupMutation(currentData, { shotId: 'shot-1', trackId: 'V1' })).toEqual({
      type: 'pinnedShotGroups',
      pinnedShotGroups: [{
        shotId: 'shot-2',
        trackId: 'V1',
        clipIds: ['clip-2'],
        mode: 'images',
      }],
    });
  });

  it('buildUpdateShotGroupToLatestVideoMutation updates both the clip asset and group videoAssetKey', () => {
    const currentData = makeTimelineData(
      {
        output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
        tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
        clips: [
          { id: 'clip-3', at: 7, track: 'V1', clipType: 'media', asset: 'asset-video', from: 0, to: 10, speed: 1 },
        ],
        pinnedShotGroups: [{
          shotId: 'shot-1',
          trackId: 'V1',
          clipIds: ['clip-3'],
          mode: 'video',
          videoAssetKey: 'asset-video',
          imageClipSnapshot: [
            { clipId: 'clip-1', assetKey: 'asset-1', start: 7, end: 10, meta: { clipType: 'hold', hold: 3 } },
          ],
        }],
      },
      {
        assets: {
          'asset-video': { file: 'video-old.mp4', type: 'video/mp4', generationId: 'final-old' },
          'asset-1': { file: 'one.png', type: 'image/png' },
          'asset-video-new': { file: 'video-new.mp4', type: 'video/mp4', generationId: 'final-new' },
        },
      },
    );

    expect(buildUpdateShotGroupToLatestVideoMutation({
      currentData,
      shotId: 'shot-1',
      rowId: 'V1',
      assetKey: 'asset-video-new',
      targetGenerationId: 'final-new',
    })).toEqual({
      type: 'rows',
      rows: currentData.rows,
      metaUpdates: {
        'clip-3': {
          asset: 'asset-video-new',
        },
      },
      pinnedShotGroupsOverride: [{
        shotId: 'shot-1',
        trackId: 'V1',
        clipIds: ['clip-3'],
        mode: 'video',
        videoAssetKey: 'asset-video-new',
        imageClipSnapshot: [
          { clipId: 'clip-1', assetKey: 'asset-1', start: 7, end: 10, meta: { clipType: 'hold', hold: 3 } },
        ],
      }],
    });
  });

  it('buildPinShotGroupMutation replaces a stale stored trackId and self-heals the output group', () => {
    const currentData = makeStaleImageGroupData();

    expect(buildPinShotGroupMutation(currentData, {
      shotId: 'shot-1',
      trackId: 'V2',
      clipIds: ['clip-1', 'clip-2'],
      mode: 'images',
    })).toEqual({
      type: 'pinnedShotGroups',
      pinnedShotGroups: [{
        shotId: 'shot-1',
        trackId: 'V2',
        clipIds: ['clip-1', 'clip-2'],
        mode: 'images',
      }],
    });
  });

  it('buildUnpinShotGroupMutation removes a stale group when called with the resolved track id', () => {
    const currentData = makeStaleImageGroupData();

    expect(buildUnpinShotGroupMutation(currentData, { shotId: 'shot-1', trackId: 'V2' })).toEqual({
      type: 'pinnedShotGroups',
      pinnedShotGroups: [],
    });
  });

  it('buildUpdatePinnedShotGroupMutation self-heals a stale trackId in the returned group', () => {
    const currentData = makeStaleImageGroupData();

    expect(buildUpdatePinnedShotGroupMutation(
      currentData,
      { shotId: 'shot-1', trackId: 'V2' },
      {},
    )).toEqual({
      type: 'pinnedShotGroups',
      pinnedShotGroups: [{
        shotId: 'shot-1',
        trackId: 'V2',
        clipIds: ['clip-1', 'clip-2'],
        mode: 'images',
      }],
    });
  });

  it('buildDeleteShotGroupMutation deletes a stale group when addressed by the resolved track id', () => {
    const currentData = makeStaleImageGroupData();

    expect(buildDeleteShotGroupMutation({
      currentData,
      group: { shotId: 'shot-1', trackId: 'V2', clipIds: ['clip-1', 'clip-2'] },
    })).toEqual({
      type: 'rows',
      rows: [
        { id: 'V1', actions: [] },
        { id: 'V2', actions: [] },
      ],
      metaDeletes: ['clip-1', 'clip-2'],
      pinnedShotGroupsOverride: [],
    });
  });

  it('buildSwitchShotGroupToFinalVideoMutation switches a stale image group and self-heals trackId in the output', () => {
    const currentData = makeStaleImageGroupData();

    const mutation = buildSwitchShotGroupToFinalVideoMutation({
      currentData,
      shotId: 'shot-1',
      rowId: 'V2',
      clipIds: ['clip-1', 'clip-2'],
      assetKey: 'asset-final',
    });

    expect(mutation).not.toBeNull();
    expect(mutation?.type).toBe('rows');
    expect(mutation?.metaDeletes).toEqual(['clip-1', 'clip-2']);
    expect(mutation?.pinnedShotGroupsOverride).toEqual([{
      shotId: 'shot-1',
      trackId: 'V2',
      clipIds: ['clip-3'],
      mode: 'video',
      videoAssetKey: 'asset-final',
      imageClipSnapshot: [
        { clipId: 'clip-1', assetKey: undefined, start: 0, end: 2, meta: { clipType: 'hold', hold: 2 } },
        { clipId: 'clip-2', assetKey: undefined, start: 2, end: 4, meta: { clipType: 'hold', hold: 2 } },
      ],
    }]);
  });

  it('buildSwitchShotGroupToFinalVideoMutation clamps the video clip to a shorter known duration', () => {
    const currentData = makeImageGroupData();

    const mutation = buildSwitchShotGroupToFinalVideoMutation({
      currentData,
      shotId: 'shot-1',
      rowId: 'V1',
      clipIds: ['clip-1', 'clip-2'],
      assetKey: 'asset-final',
      durationSeconds: 1.5,
    });

    expect(mutation).not.toBeNull();
    expect(mutation?.metaUpdates).toEqual({
      'clip-3': {
        asset: 'asset-final',
        track: 'V1',
        clipType: 'media',
        from: 0,
        to: 1.5,
        speed: 1,
        volume: 1,
        opacity: 1,
        x: undefined,
        y: undefined,
        width: undefined,
        height: undefined,
      },
    });
    expect(mutation?.rows).toEqual([
      { id: 'V1', actions: [{ id: 'clip-3', start: 0, end: 1.5, effectId: 'effect-clip-3' }] },
    ]);
  });

  it('buildSwitchShotGroupToFinalVideoMutation falls back to the image span when durationSeconds is null', () => {
    const currentData = makeImageGroupData();

    const mutation = buildSwitchShotGroupToFinalVideoMutation({
      currentData,
      shotId: 'shot-1',
      rowId: 'V1',
      clipIds: ['clip-1', 'clip-2'],
      assetKey: 'asset-final',
      durationSeconds: null,
    });

    expect(mutation).not.toBeNull();
    expect(mutation?.metaUpdates).toEqual({
      'clip-3': {
        asset: 'asset-final',
        track: 'V1',
        clipType: 'media',
        from: 0,
        to: 4,
        speed: 1,
        volume: 1,
        opacity: 1,
        x: undefined,
        y: undefined,
        width: undefined,
        height: undefined,
      },
    });
    expect(mutation?.rows).toEqual([
      { id: 'V1', actions: [{ id: 'clip-3', start: 0, end: 4, effectId: 'effect-clip-3' }] },
    ]);
  });

  it('buildUpdateShotGroupToLatestVideoMutation self-heals a stale video group trackId in the output', () => {
    const currentData = makeStaleVideoGroupData();

    expect(buildUpdateShotGroupToLatestVideoMutation({
      currentData,
      shotId: 'shot-1',
      rowId: 'V2',
      assetKey: 'asset-video-new',
      targetGenerationId: 'final-new',
    })).toEqual({
      type: 'rows',
      rows: currentData.rows,
      metaUpdates: {
        'clip-3': {
          asset: 'asset-video-new',
        },
      },
      pinnedShotGroupsOverride: [{
        shotId: 'shot-1',
        trackId: 'V2',
        clipIds: ['clip-3'],
        mode: 'video',
        videoAssetKey: 'asset-video-new',
        imageClipSnapshot: [
          { clipId: 'clip-1', assetKey: 'asset-1', start: 7, end: 10, meta: { clipType: 'hold', hold: 3 } },
        ],
      }],
    });
  });

  it('buildSwitchShotGroupToImagesMutation restores a stale video group and self-heals trackId in the output', () => {
    const currentData = makeStaleVideoGroupData();

    expect(buildSwitchShotGroupToImagesMutation({
      currentData,
      shotId: 'shot-1',
      rowId: 'V2',
    })).toEqual({
      type: 'rows',
      rows: [
        { id: 'V1', actions: [] },
        { id: 'V2', actions: [{ id: 'clip-1', start: 7, end: 10, effectId: 'effect-clip-1' }] },
      ],
      metaUpdates: {
        'clip-1': {
          asset: 'asset-1',
          track: 'V2',
          clipType: 'hold',
          hold: 3,
        },
      },
      metaDeletes: ['clip-3'],
      clipOrderOverride: {
        V1: [],
        V2: ['clip-1'],
      },
      pinnedShotGroupsOverride: [{
        shotId: 'shot-1',
        trackId: 'V2',
        clipIds: ['clip-1'],
        mode: 'images',
        imageClipSnapshot: [
          { clipId: 'clip-1', assetKey: 'asset-1', start: 7, end: 10, meta: { clipType: 'hold', hold: 3 } },
        ],
      }],
    });
  });
});

it('preserves clip fit in the image snapshot when switching to a final video', () => {
  const currentData = makeStaleImageGroupData();
  currentData.meta['clip-1'].fit = 'cover';
  const mutation = buildSwitchShotGroupToFinalVideoMutation({currentData, shotId: 'shot-1', rowId: 'V2', clipIds: ['clip-1', 'clip-2'], assetKey: 'asset-final'});
  expect(mutation?.pinnedShotGroupsOverride?.[0].imageClipSnapshot?.[0].meta.fit).toBe('cover');
});

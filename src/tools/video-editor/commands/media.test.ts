import { describe, expect, it, vi } from 'vitest';
import { createDefaultTimelineConfig } from '@/tools/video-editor/lib/defaults.ts';
import { buildSwitchShotGroupToFinalVideoMutation } from '@/tools/video-editor/lib/shot-group-commands.ts';
import { buildTimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import * as serialize from '@/tools/video-editor/lib/serialize.ts';
import type { AssetRegistry } from '@/tools/video-editor/types/index.ts';
import {
  applyPreparedMediaCommand,
  PLACE_PREPARED_MEDIA_COMMAND_DESCRIPTOR,
  type PlacePreparedMediaCommand,
} from './media.ts';

describe('prepared media command', () => {
  it.each([
    ['negative time', (command: PlacePreparedMediaCommand) => { command.payload.at = -1; }],
    ['non-finite time', (command: PlacePreparedMediaCommand) => { command.payload.at = Infinity; }],
    ['non-JSON payload', (command: PlacePreparedMediaCommand) => { command.payload.asset.durationSeconds = NaN; }],
    ['non-JSON metadata', (command: PlacePreparedMediaCommand) => { command.metadata = { duration: Infinity }; }],
    ['empty asset key', (command: PlacePreparedMediaCommand) => { command.payload.asset.assetKey = ''; }],
    ['missing source', (command: PlacePreparedMediaCommand) => { command.payload.asset.entry = {}; }],
  ] as const)('preserves the %s refusal without mutating input', async (_label, invalidate) => {
    const current = await buildTimelineData({
      ...createDefaultTimelineConfig(),
      tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
      clips: [],
    }, { assets: {} });
    const before = structuredClone(current);
    const command: PlacePreparedMediaCommand = {
      type: 'place-prepared-media',
      payload: {
        asset: {
          assetKey: 'asset-new', mediaType: 'image', durationSeconds: 2,
          entry: { file: 'new.png', type: 'image/png' }, source: 'registered',
        },
        trackId: 'V1', at: 0,
      },
    };
    invalidate(command);
    expect(applyPreparedMediaCommand(current, command)).toBeNull();
    expect(current).toEqual(before);
  });

  it('previews through editor utilities without executing the command descriptor', async () => {
    const current = await buildTimelineData({
      ...createDefaultTimelineConfig(),
      tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
      clips: [],
    }, { assets: {} });
    const validate = vi.spyOn(PLACE_PREPARED_MEDIA_COMMAND_DESCRIPTOR, 'validate');
    const dryRun = vi.spyOn(PLACE_PREPARED_MEDIA_COMMAND_DESCRIPTOR, 'dryRun');
    const apply = vi.spyOn(PLACE_PREPARED_MEDIA_COMMAND_DESCRIPTOR, 'apply');
    const invert = vi.spyOn(PLACE_PREPARED_MEDIA_COMMAND_DESCRIPTOR, 'invert');
    try {
      const preview = applyPreparedMediaCommand(current, {
        type: 'place-prepared-media',
        payload: {
          asset: {
            assetKey: 'asset-new', mediaType: 'image', durationSeconds: 2,
            entry: { file: 'new.png', type: 'image/png' }, source: 'registered',
          },
          trackId: 'V1', at: 0,
        },
      });
      expect(preview?.nextData.config.clips).toEqual([
        expect.objectContaining({ asset: 'asset-new', track: 'V1' }),
      ]);
      expect(validate).not.toHaveBeenCalled();
      expect(dryRun).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      expect(invert).not.toHaveBeenCalled();
    } finally {
      validate.mockRestore();
      dryRun.mockRestore();
      apply.mockRestore();
      invert.mockRestore();
    }
  });

  it('persists the prepared registry entry and clip replacement in one compound mutation', async () => {
    const config = {
      ...createDefaultTimelineConfig(),
      tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
      clips: [{
        id: 'clip-old',
        at: 0,
        track: 'V1',
        clipType: 'hold' as const,
        hold: 2,
        asset: 'asset-old',
      }],
    };
    const registry: AssetRegistry = {
      assets: {
        'asset-old': { file: 'old.png', type: 'image/png' },
      },
    };
    const current = await buildTimelineData(config, registry);
    const preparedEntry = {
      file: 'new.png',
      type: 'image/png',
      generationId: 'generation-new',
    };

    const result = applyPreparedMediaCommand(current, {
      type: 'place-prepared-media',
      payload: {
        asset: {
          assetKey: 'asset-new',
          mediaType: 'image',
          durationSeconds: 2,
          entry: preparedEntry,
          source: 'registered',
        },
        trackId: 'V1',
        at: 0,
        removeClipId: 'clip-old',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.nextData.registry.assets['asset-new']).toEqual(preparedEntry);
    expect(result?.nextData.config.clips).toEqual([
      expect.objectContaining({ asset: 'asset-new', track: 'V1' }),
    ]);
    expect(result?.nextData.config.clips.some((clip) => clip.id === 'clip-old')).toBe(false);
    expect(result?.history).toMatchObject({
      appliedCount: 1,
      commandTypes: ['place-prepared-media'],
      failedCount: 0,
    });
  });

  it('rejects a prepared placement whose deferred target no longer exists', async () => {
    const current = await buildTimelineData(
      {
        ...createDefaultTimelineConfig(),
        tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
        clips: [],
      },
      { assets: {} },
    );

    const result = applyPreparedMediaCommand(current, {
      type: 'place-prepared-media',
      payload: {
        asset: {
          assetKey: 'asset-new',
          mediaType: 'image',
          durationSeconds: 1,
          entry: { file: 'new.png', type: 'image/png' },
          source: 'registered',
        },
        trackId: 'V1',
        at: 0,
        removeClipId: 'clip-deleted',
      },
    });

    expect(result).toBeNull();
  });

  it('keeps the prepared replacement clip id aligned with pinned group membership after source removal', async () => {
    const current = await buildTimelineData(
      {
        ...createDefaultTimelineConfig(),
        tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
        clips: [
          { id: 'clip-1', at: 0, track: 'V1', clipType: 'hold' as const, hold: 2, asset: 'asset-one' },
          { id: 'clip-2', at: 2, track: 'V1', clipType: 'hold' as const, hold: 2, asset: 'asset-two' },
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
          'asset-one': { file: 'one.png', type: 'image/png' },
          'asset-two': { file: 'two.png', type: 'image/png' },
        },
      },
    );

    const mutation = buildSwitchShotGroupToFinalVideoMutation({
      currentData: current,
      shotId: 'shot-1',
      rowId: 'V1',
      clipIds: ['clip-1', 'clip-2'],
      assetKey: 'asset-final',
      durationSeconds: 4,
    });
    expect(mutation).not.toBeNull();
    const replacementClipId = Object.keys(mutation?.metaUpdates ?? {})[0];
    const replacementAction = mutation?.rows[0]?.actions.find((action) => action.id === replacementClipId);

    const result = applyPreparedMediaCommand(current, {
      type: 'place-prepared-media',
      payload: {
        asset: {
          assetKey: 'asset-final',
          mediaType: 'video',
          durationSeconds: 4,
          entry: { file: 'final.mp4', type: 'video/mp4' },
          source: 'registered',
        },
        trackId: 'V1',
        at: replacementAction?.start ?? 0,
        clipSpanSeconds: replacementAction ? replacementAction.end - replacementAction.start : 4,
        clipId: replacementClipId,
        removeClipIds: mutation?.metaDeletes,
        pinnedShotGroupsOverride: mutation?.pinnedShotGroupsOverride
          ? JSON.parse(JSON.stringify(mutation.pinnedShotGroupsOverride))
          : undefined,
      },
    });

    expect(result?.nextData.config.clips).toEqual([
      expect.objectContaining({ id: replacementClipId, asset: 'asset-final' }),
    ]);
    expect(result?.nextData.config.pinnedShotGroups).toEqual([expect.objectContaining({
      clipIds: [replacementClipId],
    })]);
  });

  it('preserves replacement clip metadata while changing the prepared asset and duration bounds', async () => {
    const current = await buildTimelineData(
      {
        ...createDefaultTimelineConfig(),
        tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
        clips: [{
          id: 'clip-3',
          at: 7,
          track: 'V1',
          clipType: 'media' as const,
          asset: 'asset-old',
          from: 1,
          to: 11,
          speed: 2,
          volume: 0.4,
          opacity: 0.6,
          cropTop: 0.1,
          cropBottom: 0.2,
          cropLeft: 0.3,
          cropRight: 0.4,
          effects: { blur: 0.5 },
        }],
        pinnedShotGroups: [{
          shotId: 'shot-1',
          trackId: 'V1',
          clipIds: ['clip-3'],
          mode: 'video',
          videoAssetKey: 'asset-old',
        }],
      },
      {
        assets: {
          'asset-old': { file: 'old.mp4', type: 'video/mp4', generationId: 'old' },
        },
      },
    );

    const result = applyPreparedMediaCommand(current, {
      type: 'place-prepared-media',
      payload: {
        asset: {
          assetKey: 'asset-new',
          mediaType: 'video',
          durationSeconds: 3,
          entry: { file: 'new.mp4', type: 'video/mp4', generationId: 'new' },
          source: 'registered',
        },
        trackId: 'V1',
        at: 7,
        clipSpanSeconds: 3,
        clipId: 'clip-3',
        replaceClipId: 'clip-3',
        pinnedShotGroupsOverride: [{
          shotId: 'shot-1',
          trackId: 'V1',
          clipIds: ['clip-3'],
          mode: 'video',
          videoAssetKey: 'asset-new',
        }],
      },
    });

    expect(result?.nextData.config.clips).toEqual([expect.objectContaining({
      id: 'clip-3',
      asset: 'asset-new',
      at: 7,
      from: 1,
      to: 7,
      speed: 2,
      volume: 0.4,
      opacity: 0.6,
      cropTop: 0.1,
      cropBottom: 0.2,
      cropLeft: 0.3,
      cropRight: 0.4,
      effects: { blur: 0.5 },
    })]);
    expect(result?.nextData.config.clips[0]?.at).toBe(7);
    expect(result?.nextData.rows[0]?.actions).toEqual([
      { id: 'clip-3', start: 7, end: 10, effectId: 'effect-clip-3' },
    ]);
  });

  it('uses normal duplicate ripple and metadata behavior for prepared afterClipId placement', async () => {
    const current = await buildTimelineData(
      {
        ...createDefaultTimelineConfig(),
        tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
        clips: [
          {
            id: 'clip-1',
            at: 0,
            track: 'V1',
            clipType: 'hold' as const,
            hold: 2,
            asset: 'asset-old',
            opacity: 0.5,
            effects: { glow: 1 },
          },
          { id: 'clip-2', at: 4, track: 'V1', clipType: 'hold' as const, hold: 2, asset: 'asset-after' },
        ],
      },
      {
        assets: {
          'asset-old': { file: 'old.png', type: 'image/png' },
          'asset-after': { file: 'after.png', type: 'image/png' },
        },
      },
    );

    const result = applyPreparedMediaCommand(current, {
      type: 'place-prepared-media',
      payload: {
        asset: {
          assetKey: 'asset-copy',
          mediaType: 'video',
          durationSeconds: 2,
          entry: { file: 'copy.mp4', type: 'video/mp4' },
          source: 'registered',
        },
        at: 0,
        afterClipId: 'clip-1',
      },
    });

    expect(result?.nextData.rows[0]?.actions).toEqual([
      { id: 'clip-1', start: 0, end: 2, effectId: 'effect-clip-1' },
      { id: 'clip-3', start: 2, end: 4, effectId: 'effect-clip-3' },
      { id: 'clip-2', start: 6, end: 8, effectId: 'effect-clip-2' },
    ]);
    expect(result?.nextData.config.clips).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'clip-3',
        asset: 'asset-copy',
        opacity: 0.5,
        effects: { glow: 1 },
      }),
    ]));
  });

  it('keeps the source-window clone and opaque metadata while rippling only the source track', async () => {
    const config = {
      ...createDefaultTimelineConfig(),
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      tracks: [
        { id: 'V1', kind: 'visual' as const, label: 'V1' },
        { id: 'V2', kind: 'visual' as const, label: 'V2' },
      ],
      clips: [
        {
          id: 'clip-1',
          at: 1,
          track: 'V1',
          clipType: 'media' as const,
          asset: 'asset-source',
          from: 2,
          to: 6,
          speed: 2,
          opacity: 0.5,
          effects: { glow: 1 },
          transition: { type: 'crossfade', duration: 0.5, params: { opaque: [null, false] } },
          params: { claims: { reserved: true }, opaque: { ordered: [null, false, 0] } },
          app: { opaque: { keep: null, ordered: [false, 0, ''] } },
          keyframes: { opacity: [{ time: 0, value: 0.5, interpolation: 'linear' as const }] },
        },
        { id: 'clip-2', at: 5, track: 'V1', clipType: 'hold' as const, hold: 1, asset: 'asset-peer' },
        { id: 'clip-4', at: 5, track: 'V2', clipType: 'hold' as const, hold: 1, asset: 'asset-peer' },
      ],
    };
    const registry: AssetRegistry = {
      assets: {
        'asset-source': { file: 'source.mp4', type: 'video/mp4', media_id: 'media-source' },
        'asset-peer': { file: 'peer.png', type: 'image/png' },
      },
    };
    const current = await buildTimelineData(config, registry);
    const before = structuredClone(current);
    const command = {
      type: 'place-prepared-media' as const,
      payload: {
        asset: {
          assetKey: 'asset-copy',
          mediaType: 'video' as const,
          durationSeconds: 2,
          entry: { file: 'copy.mp4', type: 'video/mp4', media_id: 'media-copy' },
          source: 'registered' as const,
        },
        at: 0,
        afterClipId: 'clip-1',
      },
    };

    const result = applyPreparedMediaCommand(current, command);
    expect(result).not.toBeNull();
    expect(result?.nextData.rows.find((row) => row.id === 'V1')?.actions).toEqual([
      { id: 'clip-1', start: 1, end: 3, effectId: 'effect-clip-1' },
      { id: 'clip-5', start: 3, end: 5, effectId: 'effect-clip-5' },
      { id: 'clip-2', start: 7, end: 8, effectId: 'effect-clip-2' },
    ]);
    expect(result?.nextData.rows.find((row) => row.id === 'V2')?.actions).toEqual([
      { id: 'clip-4', start: 5, end: 6, effectId: 'effect-clip-4' },
    ]);
    expect(result?.nextData.config.clips).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'clip-5',
        at: 3,
        track: 'V1',
        asset: 'asset-copy',
        from: 2,
        to: 6,
        speed: 2,
        opacity: 0.5,
        effects: { glow: 1 },
        transition: { type: 'crossfade', duration: 0.5, params: { opaque: [null, false] } },
        params: { claims: { reserved: true }, opaque: { ordered: [null, false, 0] } },
        app: { opaque: { keep: null, ordered: [false, 0, ''] } },
        keyframes: { opacity: [{ time: 0, value: 0.5, interpolation: 'linear' }] },
      }),
      expect.objectContaining({ id: 'clip-2', at: 7 }),
      expect.objectContaining({ id: 'clip-4', at: 5 }),
    ]));
    expect(result?.nextData.registry.assets['asset-copy']).toEqual(command.payload.asset.entry);
    expect(result?.history).toMatchObject({
      appliedCount: 1,
      commandTypes: ['place-prepared-media'],
      failedCount: 0,
    });
    expect(current).toEqual(before);
  });

  it('replays the prepared after-anchor command from JSON without changing its local result', async () => {
    const config = {
      ...createDefaultTimelineConfig(),
      tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
      clips: [
        { id: 'clip-1', at: 0, track: 'V1', clipType: 'hold' as const, hold: 1, asset: 'asset-source' },
        { id: 'clip-2', at: 1, track: 'V1', clipType: 'hold' as const, hold: 1, asset: 'asset-peer' },
      ],
    };
    const current = await buildTimelineData(config, {
      assets: {
        'asset-source': { file: 'source.png', type: 'image/png' },
        'asset-peer': { file: 'peer.png', type: 'image/png' },
      },
    });
    const command = {
      type: 'place-prepared-media' as const,
      payload: {
        asset: {
          assetKey: 'asset-copy',
          mediaType: 'image' as const,
          durationSeconds: 1,
          entry: { file: 'copy.png', type: 'image/png' },
          source: 'registered' as const,
        },
        at: 0,
        afterClipId: 'clip-1',
      },
    };
    const first = applyPreparedMediaCommand(current, command);
    const reloaded = JSON.parse(JSON.stringify(command)) as typeof command;
    const replay = applyPreparedMediaCommand(current, reloaded);

    expect(replay).toEqual(first);
    expect(applyPreparedMediaCommand(current, {
      ...command,
      payload: { ...command.payload, afterClipId: 'clip-missing' },
    })).toBeNull();
  });

  it('replays selected-track and reserved-asset identity while the duplicate gets the editor allocation', async () => {
    const current = await buildTimelineData(
      {
        ...createDefaultTimelineConfig(),
        tracks: [
          { id: 'V1', kind: 'visual' as const, label: 'V1' },
          { id: 'V2', kind: 'visual' as const, label: 'V2' },
        ],
        clips: [
          { id: 'anchor', at: 1, track: 'V2', clipType: 'hold' as const, hold: 1, asset: 'asset-source' },
          { id: 'peer', at: 2, track: 'V2', clipType: 'hold' as const, hold: 1, asset: 'asset-peer' },
        ],
      },
      {
        assets: {
          'asset-source': { file: 'source.png', type: 'image/png' },
          'asset-peer': { file: 'peer.png', type: 'image/png' },
        },
      },
    );
    const command = {
      type: 'place-prepared-media' as const,
      payload: {
        asset: {
          assetKey: 'reserved-new',
          mediaType: 'image' as const,
          durationSeconds: 1,
          entry: { file: 'reserved.png', type: 'image/png', generationId: 'generation-new' },
          source: 'registered' as const,
        },
        selectedTrackId: 'V2',
        at: 0,
        afterClipId: 'anchor',
        clipId: 'reserved-clip',
      },
    };
    const before = structuredClone(current);
    const result = applyPreparedMediaCommand(current, command);
    const replay = applyPreparedMediaCommand(current, JSON.parse(JSON.stringify(command)));

    expect(result).not.toBeNull();
    expect(replay).toEqual(result);
    expect(result?.nextData.registry.assets['reserved-new']).toEqual(command.payload.asset.entry);
    expect(result?.commandResult?.detail).toMatchObject({ assetKey: 'reserved-new', trackId: 'V2' });
    expect(result?.commandResult?.detail?.clipId).toBe('clip-0');
    expect(result?.nextData.config.clips).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'clip-0', asset: 'reserved-new', track: 'V2', at: 2, hold: 1 }),
      expect.objectContaining({ id: 'peer', at: 3 }),
    ]));
    expect(result?.nextData.config.clips.some((clip) => clip.id === 'reserved-clip')).toBe(false);
    expect(current).toEqual(before);
  });

  it('refuses non-clip-owner and missing after anchors without mutating the input', async () => {
    const current = await buildTimelineData(
      {
        ...createDefaultTimelineConfig(),
        tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
        clips: [{ id: 'anchor', at: 0, track: 'V1', clipType: 'hold' as const, hold: 1, asset: 'asset-source' }],
      },
      { assets: { 'asset-source': { file: 'source.png', type: 'image/png' } } },
    );
    const before = structuredClone(current);
    const asset = {
      assetKey: 'asset-copy',
      mediaType: 'image' as const,
      durationSeconds: 1,
      entry: { file: 'copy.png', type: 'image/png' },
      source: 'registered' as const,
    };

    for (const afterClipId of ['occurrence:anchor', 'missing-anchor']) {
      expect(applyPreparedMediaCommand(current, {
        type: 'place-prepared-media',
        payload: { asset, at: 0, afterClipId },
      })).toBeNull();
      expect(current).toEqual(before);
    }
  });

  it('strips only the resolved assetEntry projection before validating authored clips', async () => {
    const current = await buildTimelineData({
      ...createDefaultTimelineConfig(),
      tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
      clips: [{
        id: 'anchor', at: 1, track: 'V1', clipType: 'media' as const,
        from: 0, to: 2, speed: 1, asset: 'asset-source', hold: null,
        transition: null, params: { opaque: { keep: [null, false, {}] } },
      }],
    }, { assets: { 'asset-source': { file: 'source.mp4', type: 'video/mp4' } } });
    const projectedClip = {
      ...current.config.clips[0],
      assetEntry: current.resolvedConfig.registry['asset-source'],
    } as typeof current.config.clips[number] & { assetEntry: unknown };
    const projected = {
      ...current,
      config: { ...current.config, clips: [projectedClip] },
    };
    const command = {
      type: 'place-prepared-media' as const,
      payload: {
        asset: {
          assetKey: 'asset-copy', mediaType: 'image' as const, durationSeconds: 1,
          entry: { file: 'copy.png', type: 'image/png' }, source: 'registered' as const,
        },
        at: 0,
        afterClipId: 'anchor',
      },
    };

    const result = applyPreparedMediaCommand(projected, command);
    expect(result).not.toBeNull();
    expect(result?.nextData.config.clips.find((clip) => clip.id === 'anchor')).toEqual({
      ...current.config.clips[0],
      at: 1,
      from: 0,
      to: 2,
      speed: 1,
      hold: null,
      transition: null,
      params: { opaque: { keep: [null, false, {}] } },
    });

    const forged = {
      ...projected,
      config: {
        ...projected.config,
        clips: [{ ...projectedClip, assetEntry: { forged: true } }],
      },
    };
    expect(applyPreparedMediaCommand(forged, command)).toBeNull();
  });

  it('normalizes an ambiguous raw anchor before prepared placement and keeps the edit executable', async () => {
    const anchor = { id: 'anchor', at: 0, track: 'V1', clipType: 'hold' as const, hold: 1, asset: 'asset-source' };
    const current = await buildTimelineData(
      {
        ...createDefaultTimelineConfig(),
        tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
        clips: [anchor, { ...anchor, at: 1 }],
      },
      { assets: { 'asset-source': { file: 'source.png', type: 'image/png' } } },
    );
    expect(current.config.clips.map((clip) => clip.id)).toEqual(['anchor']);
    const before = structuredClone(current);
    const result = applyPreparedMediaCommand(current, {
      type: 'place-prepared-media',
      payload: {
        asset: {
          assetKey: 'asset-copy',
          mediaType: 'image',
          durationSeconds: 1,
          entry: { file: 'copy.png', type: 'image/png' },
          source: 'registered',
        },
        at: 0,
        afterClipId: 'anchor',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.nextData.rows[0]?.actions).toEqual([
      { id: 'anchor', start: 0, end: 1, effectId: 'effect-anchor' },
      { id: 'clip-0', start: 1, end: 2, effectId: 'effect-clip-0' },
    ]);
    expect(current).toEqual(before);
  });

  it.each(['absent', 'null'] as const)('preserves %s transition/hold fields in the source-window clone', async (fieldState) => {
    const source: Record<string, unknown> = {
      id: 'anchor',
      at: 1,
      track: 'V1',
      clipType: 'media',
      from: 2,
      to: 6,
      speed: 2,
      asset: 'asset-source',
      params: { opaque: { keep: [null, false, {}] } },
    };
    if (fieldState === 'null') {
      source.hold = null;
      source.transition = null;
    }
    const current = await buildTimelineData(
      {
        ...createDefaultTimelineConfig(),
        tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
        clips: [source, { id: 'peer', at: 3, track: 'V1', clipType: 'hold' as const, hold: 1, asset: 'asset-peer' }],
      },
      {
        assets: {
          'asset-source': { file: 'source.mp4', type: 'video/mp4' },
          'asset-peer': { file: 'peer.png', type: 'image/png' },
        },
      },
    );
    const before = structuredClone(current);
    const result = applyPreparedMediaCommand(current, {
      type: 'place-prepared-media',
      payload: {
        asset: {
          assetKey: 'asset-copy',
          mediaType: 'video',
          durationSeconds: 2,
          entry: { file: 'copy.mp4', type: 'video/mp4' },
          source: 'registered',
        },
        at: 0,
        afterClipId: 'anchor',
      },
    });
    const clone = result?.nextData.config.clips.find((clip) => clip.asset === 'asset-copy');

    expect(result).not.toBeNull();
    expect(clone).toMatchObject({ at: 3, from: 2, to: 6, speed: 2, asset: 'asset-copy', params: { opaque: { keep: [null, false, {}] } } });
    if (fieldState === 'null') {
      expect(clone).toHaveProperty('hold', null);
      expect(clone).toHaveProperty('transition', null);
    } else {
      expect(clone).not.toHaveProperty('hold');
      expect(clone).not.toHaveProperty('transition');
    }
    expect(result?.nextData.config.clips.find((clip) => clip.id === 'peer')).toMatchObject({ at: 5 });
    expect(current).toEqual(before);
  });

  it('canonicalizes matching at_ms timing to the mounted editor at field while preserving transition data', async () => {
    const source = {
      id: 'anchor', at: 1.003, at_ms: 1003, track: 'V1', clipType: 'media' as const,
      from: 2, to: 6, speed: 2, asset: 'asset-source',
      transition: { type: 'crossfade', duration: 0.5, params: { opaque: [null, false] } },
    };
    const current = await buildTimelineData(
      {
        ...createDefaultTimelineConfig(),
        output: { ...createDefaultTimelineConfig().output, fps: 24 },
        tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
        clips: [source, { id: 'peer', at: 3.003, at_ms: 3003, track: 'V1', clipType: 'hold' as const, hold: 1, asset: 'asset-peer' }],
      },
      {
        assets: {
          'asset-source': { file: 'source.mp4', type: 'video/mp4' },
          'asset-peer': { file: 'peer.png', type: 'image/png' },
        },
      },
    );
    const result = applyPreparedMediaCommand(current, {
      type: 'place-prepared-media',
      payload: {
        asset: {
          assetKey: 'asset-copy',
          mediaType: 'video',
          durationSeconds: 2,
          entry: { file: 'copy.mp4', type: 'video/mp4' },
          source: 'registered',
        },
        at: 0,
        afterClipId: 'anchor',
      },
    });
    const clone = result?.nextData.config.clips.find((clip) => clip.asset === 'asset-copy');

    expect(result).not.toBeNull();
    expect(clone).toMatchObject({ at: 3, from: 2, to: 6, speed: 2, asset: 'asset-copy', transition: source.transition });
    expect(clone).not.toHaveProperty('at_ms');
    expect(result?.nextData.config.clips.find((clip) => clip.id === 'peer')).toMatchObject({ at: 5 });
  });

  it.each([1003, 1004, null, '1003'])(
    'normalizes only matching numeric preview timing while retaining the original source: %j', async (atMs) => {
      const current = await buildTimelineData({
        ...createDefaultTimelineConfig(),
        output: { ...createDefaultTimelineConfig().output, fps: 24 },
        tracks: [{ id: 'V1', kind: 'visual' }],
        clips: [{
          id: 'anchor', at: 1.003, at_ms: atMs, track: 'V1', asset: 'source',
          from: 2, to: 6, speed: 2, hold: null,
          transition: null, params: { opaque: [null, false, {}] },
        }],
      }, { assets: { source: { file: 'source.mp4', type: 'video/mp4' } } });
      const original = structuredClone(current);
      const result = applyPreparedMediaCommand(current, {
        type: 'place-prepared-media',
        payload: {
          asset: {
            assetKey: 'copy', mediaType: 'video', durationSeconds: 2,
            entry: { file: 'copy.mp4', type: 'video/mp4' }, source: 'registered',
          },
          at: 0, afterClipId: 'anchor',
        },
      });

      expect(current).toEqual(original);
      if (atMs !== 1003) {
        expect(result).toBeNull();
        return;
      }
      expect(result).not.toBeNull();
      const { at_ms: _atMs, ...source } = original.config.clips[0] as typeof original.config.clips[0] & { at_ms: unknown };
      expect(_atMs).toBe(1003);
      expect(result?.nextData.config.clips.find((clip) => clip.id === 'anchor')).toEqual(source);
      expect(result?.nextData.config.clips.find((clip) => clip.asset === 'copy')).toMatchObject({
        at: 3, from: 2, to: 6, speed: 2, hold: null, transition: null, params: source.params,
      });
    },
  );

  it.each([0.01, 0])('clamps a %s-second source hold to the editor minimum without mutating input', async (hold) => {
    const current = await buildTimelineData(
      {
        ...createDefaultTimelineConfig(),
        tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
        clips: [
          { id: 'anchor', at: 0, track: 'V1', clipType: 'hold' as const, hold, asset: 'asset-source' },
          { id: 'peer', at: hold, track: 'V1', clipType: 'hold' as const, hold: 1, asset: 'asset-peer' },
        ],
      },
      {
        assets: {
          'asset-source': { file: 'source.png', type: 'image/png' },
          'asset-peer': { file: 'peer.png', type: 'image/png' },
        },
      },
    );
    const before = structuredClone(current);
    const result = applyPreparedMediaCommand(current, {
      type: 'place-prepared-media',
      payload: {
        asset: {
          assetKey: 'asset-copy',
          mediaType: 'image',
          durationSeconds: 0.01,
          entry: { file: 'copy.png', type: 'image/png' },
          source: 'registered',
        },
        at: 0,
        afterClipId: 'anchor',
      },
    });
    const clone = result?.nextData.config.clips.find((clip) => clip.asset === 'asset-copy');

    expect(result).not.toBeNull();
    expect(clone).toMatchObject({ at: 0, hold: 0.0667, asset: 'asset-copy' });
    expect(result?.nextData.config.clips.find((clip) => clip.id === 'peer')).toMatchObject({ at: 0.0667 });
    expect(current).toEqual(before);
  });

  it('reports only fixed phase diagnostics for prepared-media refusals and nothing on success', async () => {
    const current = await buildTimelineData({
      ...createDefaultTimelineConfig(),
      tracks: [{ id: 'V1', kind: 'visual' as const, label: 'V1' }],
      clips: [],
    }, { assets: {} });
    const command: PlacePreparedMediaCommand = {
      type: 'place-prepared-media',
      payload: {
        asset: {
          assetKey: 'asset-new', mediaType: 'image', durationSeconds: 2,
          entry: { file: 'new.png', type: 'image/png' }, source: 'registered',
        },
        trackId: 'V1', at: 0,
      },
    };
    const cases = [
      {
        mutate: (candidate: PlacePreparedMediaCommand) => { (candidate as unknown as { type: string }).type = 'unknown'; },
        diagnostic: { stage: 'command-schema', reason: 'invalid-command', fieldCategory: 'command' },
      },
      {
        mutate: (candidate: PlacePreparedMediaCommand) => { candidate.payload.asset.assetKey = ''; },
        diagnostic: { stage: 'provisioned-asset', reason: 'invalid-asset', fieldCategory: 'asset' },
      },
      {
        mutate: (candidate: PlacePreparedMediaCommand) => { candidate.payload.afterClipId = 'missing-clip'; },
        diagnostic: { stage: 'placement', reason: 'invalid-placement', fieldCategory: 'placement' },
      },
    ] as const;

    for (const testCase of cases) {
      const candidate = structuredClone(command);
      testCase.mutate(candidate);
      const onFailure = vi.fn();
      expect(applyPreparedMediaCommand(current, candidate, { onFailure })).toBeNull();
      expect(onFailure).toHaveBeenCalledWith(testCase.diagnostic);
      expect(Object.isFrozen(onFailure.mock.calls[0]?.[0])).toBe(true);
    }

    const onFailure = vi.fn();
    expect(applyPreparedMediaCommand(current, command, { onFailure })).not.toBeNull();
    expect(onFailure).not.toHaveBeenCalled();

    const validateSerializedConfig = vi.spyOn(serialize, 'validateSerializedConfig')
      .mockImplementationOnce(() => { throw new Error('private validation detail'); });
    try {
      const finalConfigFailure = vi.fn();
      expect(applyPreparedMediaCommand(current, command, { onFailure: finalConfigFailure })).toBeNull();
      expect(finalConfigFailure).toHaveBeenCalledWith({
        stage: 'final-config', reason: 'invalid-config', fieldCategory: 'config',
      });
    } finally {
      validateSerializedConfig.mockRestore();
    }
  });

  it('preserves exceptions from the pre-effect guard checks', async () => {
    const current = await buildTimelineData(createDefaultTimelineConfig(), { assets: {} });
    const expected = new Error('placement guard failed');
    const payload = {
      asset: {
        assetKey: 'asset-new', mediaType: 'image' as const, durationSeconds: 2,
        entry: { file: 'new.png', type: 'image/png' }, source: 'registered' as const,
      },
      at: 0,
    };
    let atReads = 0;
    Object.defineProperty(payload, 'at', {
      enumerable: true,
      get: () => {
        atReads += 1;
        if (atReads > 1) throw expected;
        return 0;
      },
    });
    const command = { type: 'place-prepared-media', payload } as unknown as PlacePreparedMediaCommand;

    expect(() => applyPreparedMediaCommand(current, command)).toThrow(expected);
  });
});

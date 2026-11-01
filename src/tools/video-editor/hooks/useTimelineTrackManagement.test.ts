import type { DataLaneView } from '@/tools/video-editor/data/typed/envelope.ts';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildTimelineData } from '@/tools/video-editor/lib/timeline-data';
import { serializeForDisk } from '@/tools/video-editor/lib/serialize';
import {
  useTimelineTrackManagement,
  moveTrackWithinKind,
  reorderTracksByDirection,
} from '@/tools/video-editor/hooks/useTimelineTrackManagement';
import type {
  ResolvedTimelineConfig,
  TrackDefinition,
  TrackKind,
} from '@/tools/video-editor/types';
import { createTimelineEditability } from '@/tools/video-editor/lib/timeline-editability.ts';
import type { CanonicalDocument } from '@/integrations/runtime/timeline-commit-types.ts';
import { documentPatchIntent } from '@/tools/video-editor/commands/documentPatchIntent.ts';
import fixture from '@/tools/video-editor/commands/fixtures/authoringBundle.json';

const makePinnedGroup = (args: {
  shotId: string;
  trackId: string;
  clipIds: string[];
  mode: 'images' | 'video';
}) => ({ ...args });

function makeTrack(id: string, kind: TrackKind): TrackDefinition {
  return {
    id,
    kind,
    label: id,
  };
}

function getTrackOrder(tracks: TrackDefinition[]): string[] {
  return tracks.map((track) => track.id);
}

function makeResolvedConfig(tracks: TrackDefinition[]): ResolvedTimelineConfig {
  return {
    output: {
      resolution: '1280x720',
      fps: 30,
      file: 'out.mp4',
    },
    tracks,
    clips: tracks.map((track, index) => ({
      id: `clip-${track.id}`,
      at: index,
      track: track.id,
      clipType: 'hold',
      hold: 1,
    })),
    registry: {},
  };
}

describe('reorderTracksByDirection', () => {
  it('handles mixed-kind boundaries without crossing kinds', () => {
    const tracks = [
      makeTrack('V1', 'visual'),
      makeTrack('V2', 'visual'),
      makeTrack('A1', 'audio'),
      makeTrack('A2', 'audio'),
    ];

    expect(getTrackOrder(reorderTracksByDirection(tracks, 'V2', 1))).toEqual(['V1', 'V2', 'A1', 'A2']);
    expect(getTrackOrder(reorderTracksByDirection(tracks, 'A1', -1))).toEqual(['V1', 'V2', 'A1', 'A2']);
    expect(getTrackOrder(reorderTracksByDirection(tracks, 'A1', 1))).toEqual(['V1', 'V2', 'A2', 'A1']);
    expect(getTrackOrder(reorderTracksByDirection(tracks, 'V1', 1))).toEqual(['V2', 'V1', 'A1', 'A2']);
  });

  it('no-ops when each kind has only one track', () => {
    const tracks = [
      makeTrack('V1', 'visual'),
      makeTrack('A1', 'audio'),
    ];

    expect(getTrackOrder(reorderTracksByDirection(tracks, 'V1', -1))).toEqual(['V1', 'A1']);
    expect(getTrackOrder(reorderTracksByDirection(tracks, 'V1', 1))).toEqual(['V1', 'A1']);
    expect(getTrackOrder(reorderTracksByDirection(tracks, 'A1', -1))).toEqual(['V1', 'A1']);
    expect(getTrackOrder(reorderTracksByDirection(tracks, 'A1', 1))).toEqual(['V1', 'A1']);
  });

  it('reorders normally when all tracks share the same kind', () => {
    const tracks = [
      makeTrack('V1', 'visual'),
      makeTrack('V2', 'visual'),
      makeTrack('V3', 'visual'),
    ];

    expect(getTrackOrder(reorderTracksByDirection(tracks, 'V1', 1))).toEqual(['V2', 'V1', 'V3']);
    expect(getTrackOrder(reorderTracksByDirection(tracks, 'V2', 1))).toEqual(['V1', 'V3', 'V2']);
    expect(getTrackOrder(reorderTracksByDirection(tracks, 'V3', -1))).toEqual(['V1', 'V3', 'V2']);
  });
});

describe('runtime editability at commit', () => {
  it.each(['V1', 'V2'])('captures original same-row move inputs without claiming a cross-track basis: %s', async (target) => {
    const config = makeResolvedConfig([makeTrack('V1', 'visual'), makeTrack('V2', 'visual')]);
    const data = await buildTimelineData(config, { assets: {} });
    const applyEdit = vi.fn();
    const { result } = renderHook(() => useTimelineTrackManagement({ dataRef: { current: data }, resolvedConfig: data.resolvedConfig,
      selectedClipId: 'clip-V1', setSelectedTrackId: vi.fn(), applyEdit }));
    act(() => result.current.moveClipToRow('clip-V1', target, 5, 'move-transaction'));
    expect(applyEdit).toHaveBeenCalledTimes(1);
    const [mutation, options] = applyEdit.mock.calls[0];
    expect(mutation.rows.find((row: { id: string }) => row.id === target).actions).toContainEqual(expect.objectContaining({ id: 'clip-V1', start: 5 }));
    if (target === 'V1') {
      expect(options.gestureBasis).toEqual({ kind: 'move', clipId: 'clip-V1', trackId: 'V1', config: data.config, registry: data.registry });
      expect(options.gestureBasis.config).not.toBe(data.config);
    } else expect(options).not.toHaveProperty('gestureBasis');
  });

  it('rechecks a lock after the drag plan was produced', () => {
    const tracks = [makeTrack('V1', 'visual'), makeTrack('V2', 'visual')];
    const dataRef = { current: {
      rows: [
        { id: 'V1', actions: [{ id: 'clip-1', start: 0, end: 10, effectId: 'effect-clip-1' }] },
        { id: 'V2', actions: [] },
      ],
      tracks,
      meta: { 'clip-1': { track: 'V1', clipType: 'hold', hold: 10 } },
      clipOrder: { V1: ['clip-1'], V2: [] },
      config: { output: { resolution: '1280x720', fps: 30, file: 'out.mp4' }, tracks, clips: [{ id: 'clip-1', at: 0, track: 'V1', clipType: 'hold', hold: 10 }] },
      resolvedConfig: makeResolvedConfig(tracks),
    } } as any;
    const applyEdit = vi.fn();
    const { result } = renderHook(() => useTimelineTrackManagement({
      dataRef,
      resolvedConfig: dataRef.current.resolvedConfig,
      selectedClipId: null,
      setSelectedTrackId: vi.fn(),
      applyEdit,
      editability: createTimelineEditability({ lockedClipIds: ['clip-1'] }),
    }));

    act(() => result.current.applyResolvedClipMove('clip-1', 'V2', 'V2', 20, false, 'txn-stale-lock'));
    expect(applyEdit).not.toHaveBeenCalled();
  });
});

describe('moveTrackWithinKind', () => {
  it('moves a track to a new position within its kind group', () => {
    const tracks = [
      makeTrack('V1', 'visual'),
      makeTrack('V2', 'visual'),
      makeTrack('V3', 'visual'),
      makeTrack('A1', 'audio'),
      makeTrack('A2', 'audio'),
    ];

    expect(getTrackOrder(moveTrackWithinKind(tracks, 'V1', 'V3'))).toEqual(['V2', 'V3', 'V1', 'A1', 'A2']);
  });

  it('allows drag moves between different kinds', () => {
    const tracks = [
      makeTrack('V1', 'visual'),
      makeTrack('V2', 'visual'),
      makeTrack('A1', 'audio'),
      makeTrack('A2', 'audio'),
    ];

    expect(getTrackOrder(moveTrackWithinKind(tracks, 'V2', 'A1'))).toEqual(['V1', 'A1', 'V2', 'A2']);
  });

  it('preserves within-kind order across serialize and buildTimelineData round-trips', async () => {
    const reorderedTracks = moveTrackWithinKind([
      makeTrack('V1', 'visual'),
      makeTrack('V2', 'visual'),
      makeTrack('A1', 'audio'),
      makeTrack('A2', 'audio'),
    ], 'V1', 'V2');

    const serialized = serializeForDisk(makeResolvedConfig(reorderedTracks));
    const rebuilt = await buildTimelineData(serialized, { assets: {} });

    expect(getTrackOrder(rebuilt.tracks)).toEqual(['V2', 'V1', 'A1', 'A2']);
  });
});

describe('useTimelineTrackManagement', () => {
  it('keeps a canonical-shot track during direct removal and clear-unused operations', () => {
    const tracks = [
      makeTrack('V1', 'visual'),
      makeTrack('picture', 'visual'),
      makeTrack('V2', 'visual'),
      makeTrack('fx', 'visual'),
      makeTrack('A1', 'audio'),
    ];
    const resolvedConfig = { ...makeResolvedConfig(tracks), clips: [] };
    const dataRef = { current: {
      rows: tracks.map((track) => ({ id: track.id, actions: [] })),
      tracks,
      meta: {},
      clipOrder: Object.fromEntries(tracks.map((track) => [track.id, []])),
      config: resolvedConfig,
      resolvedConfig,
    } } as any;
    const applyEdit = vi.fn();
    const { result } = renderHook(() => useTimelineTrackManagement({
      dataRef,
      resolvedConfig,
      selectedClipId: null,
      setSelectedTrackId: vi.fn(),
      applyEdit,
      protectedTrackIds: new Set(['picture', 'fx']),
    }));

    expect(result.current.unusedTrackCount).toBe(1);
    act(() => result.current.handleRemoveTrack('picture'));
    expect(applyEdit).not.toHaveBeenCalled();

    act(() => result.current.handleClearUnusedTracks());
    const [mutation] = applyEdit.mock.calls[0];
    expect(mutation.resolvedConfig.tracks.map((track: TrackDefinition) => track.id)).toContain('picture');
    expect(mutation.resolvedConfig.tracks.map((track: TrackDefinition) => track.id)).toContain('fx');
    expect(mutation.resolvedConfig.tracks.map((track: TrackDefinition) => track.id)).not.toContain('V2');
  });

  it('reroutes moveClipToRow through a group move when the clip belongs to a pinned group', () => {
    const tracks = [
      makeTrack('V1', 'visual'),
      makeTrack('V2', 'visual'),
    ];
    const dataRef = {
      current: {
        rows: [
          { id: 'V1', actions: [{ id: 'clip-1', start: 0, end: 2, effectId: 'effect-clip-1' }] },
          { id: 'V2', actions: [] },
        ],
        tracks,
        meta: {
          'clip-1': { track: 'V1', clipType: 'hold', hold: 2 },
        },
        clipOrder: { V1: ['clip-1'], V2: [] },
        config: {
          output: {
            resolution: '1280x720',
            fps: 30,
            file: 'out.mp4',
          },
          tracks,
          clips: [{ id: 'clip-1', at: 0, track: 'V1', clipType: 'hold', hold: 2 }],
          pinnedShotGroups: [makePinnedGroup({ shotId: 'shot-1', trackId: 'V1', clipIds: ['clip-1'], mode: 'images' })],
        },
        resolvedConfig: makeResolvedConfig(tracks),
      },
    } as any;
    const applyEdit = vi.fn();

    const { result } = renderHook(() => useTimelineTrackManagement({
      dataRef,
      resolvedConfig: dataRef.current.resolvedConfig,
      selectedClipId: null,
      setSelectedTrackId: vi.fn(),
      applyEdit,
    }));

    act(() => {
      result.current.moveClipToRow('clip-1', 'V2', 3, 'txn-1');
    });

    expect(applyEdit).toHaveBeenCalledTimes(1);
    const [mutation, options] = applyEdit.mock.calls[0];
    expect(mutation).toEqual({
      type: 'rows',
      rows: [
        { id: 'V1', actions: [] },
        { id: 'V2', actions: [{ id: 'clip-1', start: 3, end: 5, effectId: 'effect-clip-1' }] },
      ],
      metaUpdates: { 'clip-1': { track: 'V2' } },
      clipOrderOverride: { V1: [], V2: ['clip-1'] },
      pinnedShotGroupsOverride: [makePinnedGroup({
        shotId: 'shot-1',
        trackId: 'V2',
        clipIds: ['clip-1'],
        mode: 'images',
      })],
    });
    expect(options).toEqual({ transactionId: 'txn-1' });
  });

  it('reroutes createTrackAndMoveClip through a group move when the clip belongs to a pinned group', () => {
    const tracks = [
      makeTrack('V1', 'visual'),
      makeTrack('V2', 'visual'),
    ];
    const applyEdit = vi.fn();
    const dataRef = {
      current: {
        rows: [
          { id: 'V1', actions: [{ id: 'clip-1', start: 0, end: 2, effectId: 'effect-clip-1' }] },
          { id: 'V2', actions: [] },
        ],
        tracks,
        meta: {
          'clip-1': { track: 'V1', clipType: 'hold', hold: 2 },
        },
        clipOrder: { V1: ['clip-1'], V2: [] },
        config: {
          output: {
            resolution: '1280x720',
            fps: 30,
            file: 'out.mp4',
          },
          tracks,
          clips: [{ id: 'clip-1', at: 0, track: 'V1', clipType: 'hold', hold: 2 }],
          pinnedShotGroups: [makePinnedGroup({ shotId: 'shot-1', trackId: 'V1', clipIds: ['clip-1'], mode: 'images' })],
        },
        resolvedConfig: {
          output: {
            resolution: '1280x720',
            fps: 30,
            file: 'out.mp4',
          },
          tracks,
          clips: [{ id: 'clip-1', at: 0, track: 'V1', clipType: 'hold', hold: 2 }],
          registry: {},
        },
      },
    } as any;

    const { result } = renderHook(() => useTimelineTrackManagement({
      dataRef,
      resolvedConfig: dataRef.current.resolvedConfig,
      selectedClipId: 'clip-1',
      setSelectedTrackId: vi.fn(),
      applyEdit,
    }));

    act(() => {
      result.current.createTrackAndMoveClip('clip-1', 'visual', 4);
    });

    expect(applyEdit).toHaveBeenCalledTimes(1);
    const [mutation, options] = applyEdit.mock.calls[0];
    expect(mutation.type).toBe('config');
    expect(mutation.resolvedConfig.tracks.map((track: TrackDefinition) => track.id)).toEqual(['V1', 'V2', 'V3']);
    expect(mutation.resolvedConfig.clips).toEqual([
      { id: 'clip-1', at: 4, track: 'V3', clipType: 'hold', hold: 2 },
    ]);
    expect(mutation.pinnedShotGroupsOverride).toEqual([makePinnedGroup({
      shotId: 'shot-1',
      trackId: 'V3',
      clipIds: ['clip-1'],
      mode: 'images',
    })]);
    expect(options).toEqual({ selectedClipId: 'clip-1', selectedTrackId: 'V3' });
  });

  it('reroutes grouped ArrowUp and ArrowDown moves through one atomic rows edit', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('txn-group');
    const tracks = [
      makeTrack('V1', 'visual'),
      makeTrack('V2', 'visual'),
    ];
    const setSelectedTrackId = vi.fn();
    const applyEdit = vi.fn();
    const dataRef = {
      current: {
        rows: [
          {
            id: 'V1',
            actions: [
              { id: 'clip-1', start: 0, end: 2, effectId: 'effect-clip-1' },
              { id: 'clip-2', start: 2, end: 4, effectId: 'effect-clip-2' },
            ],
          },
          { id: 'V2', actions: [] },
        ],
        tracks,
        meta: {
          'clip-1': { track: 'V1', clipType: 'hold', hold: 2 },
          'clip-2': { track: 'V1', clipType: 'hold', hold: 2 },
        },
        clipOrder: { V1: ['clip-1', 'clip-2'], V2: [] },
        config: {
          output: {
            resolution: '1280x720',
            fps: 30,
            file: 'out.mp4',
          },
          tracks,
          clips: [
            { id: 'clip-1', at: 0, track: 'V1', clipType: 'hold', hold: 2 },
            { id: 'clip-2', at: 2, track: 'V1', clipType: 'hold', hold: 2 },
          ],
          pinnedShotGroups: [makePinnedGroup({
            shotId: 'shot-1',
            trackId: 'V1',
            clipIds: ['clip-1', 'clip-2'],
            mode: 'images',
          })],
        },
        resolvedConfig: makeResolvedConfig(tracks),
      },
    } as any;

    const { result } = renderHook(() => useTimelineTrackManagement({
      dataRef,
      resolvedConfig: dataRef.current.resolvedConfig,
      selectedClipId: 'clip-1',
      setSelectedTrackId,
      applyEdit,
    }));

    act(() => {
      result.current.moveSelectedClipsToTrack('down', new Set(['clip-1']));
    });

    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(applyEdit).toHaveBeenCalledWith({
      type: 'rows',
      rows: [
        { id: 'V1', actions: [] },
        {
          id: 'V2',
          actions: [
            { id: 'clip-1', start: 0, end: 2, effectId: 'effect-clip-1' },
            { id: 'clip-2', start: 2, end: 4, effectId: 'effect-clip-2' },
          ],
        },
      ],
      metaUpdates: {
        'clip-1': { track: 'V2' },
        'clip-2': { track: 'V2' },
      },
      clipOrderOverride: { V1: [], V2: ['clip-1', 'clip-2'] },
      pinnedShotGroupsOverride: [makePinnedGroup({
        shotId: 'shot-1',
        trackId: 'V2',
        clipIds: ['clip-1', 'clip-2'],
        mode: 'images',
      })],
    }, { transactionId: 'txn-group' });
    expect(setSelectedTrackId).toHaveBeenCalledWith('V2');
  });

  it('reroutes grouped upward moves through one atomic rows edit', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('txn-group-up');
    const tracks = [
      makeTrack('V1', 'visual'),
      makeTrack('V2', 'visual'),
    ];
    const setSelectedTrackId = vi.fn();
    const applyEdit = vi.fn();
    const dataRef = {
      current: {
        rows: [
          { id: 'V1', actions: [] },
          {
            id: 'V2',
            actions: [
              { id: 'clip-1', start: 0, end: 2, effectId: 'effect-clip-1' },
              { id: 'clip-2', start: 2, end: 4, effectId: 'effect-clip-2' },
            ],
          },
        ],
        tracks,
        meta: {
          'clip-1': { track: 'V2', clipType: 'hold', hold: 2 },
          'clip-2': { track: 'V2', clipType: 'hold', hold: 2 },
        },
        clipOrder: { V1: [], V2: ['clip-1', 'clip-2'] },
        config: {
          output: {
            resolution: '1280x720',
            fps: 30,
            file: 'out.mp4',
          },
          tracks,
          clips: [
            { id: 'clip-1', at: 0, track: 'V2', clipType: 'hold', hold: 2 },
            { id: 'clip-2', at: 2, track: 'V2', clipType: 'hold', hold: 2 },
          ],
          pinnedShotGroups: [makePinnedGroup({
            shotId: 'shot-1',
            trackId: 'V2',
            clipIds: ['clip-1', 'clip-2'],
            mode: 'images',
          })],
        },
        resolvedConfig: makeResolvedConfig(tracks),
      },
    } as any;

    const { result } = renderHook(() => useTimelineTrackManagement({
      dataRef,
      resolvedConfig: dataRef.current.resolvedConfig,
      selectedClipId: 'clip-1',
      setSelectedTrackId,
      applyEdit,
    }));

    act(() => {
      result.current.moveSelectedClipsToTrack('up', new Set(['clip-1']));
    });

    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(applyEdit).toHaveBeenCalledWith({
      type: 'rows',
      rows: [
        {
          id: 'V1',
          actions: [
            { id: 'clip-1', start: 0, end: 2, effectId: 'effect-clip-1' },
            { id: 'clip-2', start: 2, end: 4, effectId: 'effect-clip-2' },
          ],
        },
        { id: 'V2', actions: [] },
      ],
      metaUpdates: {
        'clip-1': { track: 'V1' },
        'clip-2': { track: 'V1' },
      },
      clipOrderOverride: { V1: ['clip-1', 'clip-2'], V2: [] },
      pinnedShotGroupsOverride: [makePinnedGroup({
        shotId: 'shot-1',
        trackId: 'V1',
        clipIds: ['clip-1', 'clip-2'],
        mode: 'images',
      })],
    }, { transactionId: 'txn-group-up' });
    expect(setSelectedTrackId).toHaveBeenCalledWith('V1');
  });
});


describe('source track editing', async () => {
  async function setup() {
    const config = makeResolvedConfig([{ ...makeTrack('V1', 'visual'), role: 'source' }, makeTrack('V2', 'visual')]);
    const dataRef = { current: await buildTimelineData(serializeForDisk(config), { assets: {} }) };
    const applyEdit = vi.fn();
    const { result } = renderHook(() => useTimelineTrackManagement({
      dataRef, resolvedConfig: config, selectedClipId: 'clip-V1', setSelectedTrackId: vi.fn(), applyEdit,
    }));
    return { config, dataRef, applyEdit, result };
  }

  it('changes role as an ordinary config edit while preserving clips and other settings', async () => {
    const { config, applyEdit, result } = await setup();
    act(() => result.current.handleTrackPopoverChange('V1', { role: 'output' }));
    const mutation = applyEdit.mock.calls[0][0];
    expect(mutation.type).toBe('config');
    expect(mutation.resolvedConfig.tracks[0]).toEqual({ ...config.tracks[0], role: 'output' });
    expect(mutation.resolvedConfig.clips).toBe(config.clips);
    expect(config.tracks[0].role).toBe('source');
  });

  it('inherits Source when moving to a newly created lane, with one ordinary edit', async () => {
    const { config, applyEdit, result } = await setup();
    act(() => result.current.createTrackAndMoveClip('clip-V1', 'visual', 5));
    expect(applyEdit).toHaveBeenCalledTimes(1);
    const mutation = applyEdit.mock.calls[0][0];
    expect(mutation.resolvedConfig.tracks.at(-1).role).toBe('source');
    expect(mutation.resolvedConfig.clips.find((clip: { id: string }) => clip.id === 'clip-V1')).toMatchObject({ at: 5, track: 'V3' });
    expect(config.tracks).toHaveLength(2);
  });

  it('inherits Source in the resolved drag path and preserves its undo transaction', async () => {
    const { dataRef, applyEdit, result } = await setup();
    act(() => result.current.applyResolvedClipMove('clip-V1', 'new', null, 4, true, 'drag-role'));
    expect(dataRef.current.tracks.at(-1)?.role).toBe('source');
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(applyEdit.mock.calls[0][1]).toEqual({ transactionId: 'drag-role' });
  });

  it('keeps explicit Add track on the legacy Output default', async () => {
    const { applyEdit, result } = await setup();
    act(() => result.current.handleAddTrack('visual'));
    expect(applyEdit.mock.calls[0][0].resolvedConfig.tracks.at(-1).role ?? 'output').toBe('output');
  });
});

describe('mixed timeline row mutation', () => {
  const lanes = [{ laneId: 'astrid.transcript', height: 24, opaque: true }] as DataLaneView[];
  it('atomically persists lane placement through config serialization without changing tracks/clips or selection', () => {
    const config = makeResolvedConfig([makeTrack('V1', 'visual'), makeTrack('A1', 'audio')]);
    const applyEdit = vi.fn();
    const { result } = renderHook(() => useTimelineTrackManagement({ dataRef: { current: null }, resolvedConfig: config,
      selectedClipId: null, setSelectedTrackId: vi.fn(), applyEdit }));
    act(() => result.current.handleMoveTrack('data-lane-astrid.transcript', 'track-A1', lanes));
    expect(applyEdit).toHaveBeenCalledTimes(1);
    const edit = applyEdit.mock.calls[0][0];
    expect(edit.resolvedConfig.tracks).toBe(config.tracks);
    expect(edit.resolvedConfig.clips).toBe(config.clips);
    expect(edit.resolvedConfig.app.timelineDataLanePlacement).toEqual({ version: 1, lanes: [{ laneId: 'astrid.transcript', beforeTrackId: 'A1' }] });
    expect(applyEdit.mock.calls[0]).toHaveLength(1);
    const serialized = serializeForDisk(edit.resolvedConfig);
    expect(JSON.parse(JSON.stringify(serialized)).app.timelineDataLanePlacement).toEqual(edit.resolvedConfig.app.timelineDataLanePlacement);
  });
  it('rechecks read-only at mutation and does not write', () => {
    const config = makeResolvedConfig([makeTrack('V1', 'visual'), makeTrack('A1', 'audio')]);
    const applyEdit = vi.fn();
    const { result } = renderHook(() => useTimelineTrackManagement({ dataRef: { current: null }, resolvedConfig: config,
      selectedClipId: null, setSelectedTrackId: vi.fn(), applyEdit, editability: createTimelineEditability({ readOnly: true }) }));
    act(() => result.current.handleMoveTrack('data-lane-astrid.transcript', 'track-V1', lanes));
    expect(applyEdit).not.toHaveBeenCalled();
  });
});

it('does not add empty lane metadata to a legacy media-only row reorder', () => {
  const config = makeResolvedConfig([makeTrack('V1', 'visual'), makeTrack('A1', 'audio')]);
  const applyEdit = vi.fn();
  const { result } = renderHook(() => useTimelineTrackManagement({ dataRef: { current: null }, resolvedConfig: config,
    selectedClipId: null, setSelectedTrackId: vi.fn(), applyEdit }));
  act(() => result.current.handleMoveTrack('track-V1', 'track-A1', []));
  expect(applyEdit.mock.calls[0][0].resolvedConfig.app).toBeUndefined();
  expect(applyEdit.mock.calls[0][0].resolvedConfig.tracks.map((entry: TrackDefinition) => entry.id)).toEqual(['A1', 'V1']);
});

describe('mounted track reorder through the guarded document patch boundary', () => {
  const canonicalDocument = () => structuredClone(
    fixture.cases.find((entry) => entry.name === 'repeated-source')!.document,
  ) as CanonicalDocument;

  it('preserves raw rows and siblings, round-trips JSON, and emits the guarded A2 list move', async () => {
    const tracks = [
      { ...makeTrack('picture', 'visual'), extension: { clear: null }, opaque: { keep: [null, false, 0] } },
      { ...makeTrack('audio', 'audio'), label: null, opaque: { zero: 0 } },
      { ...makeTrack('overlay', 'visual'), opaque: { sibling: 'untouched' } },
    ];
    const config = {
      ...makeResolvedConfig(tracks),
      app: { timelineDataLanePlacement: { 'data-1': 'between' }, opaque: { keep: null } },
    } as ResolvedTimelineConfig;
    const applyEdit = vi.fn();
    const { result } = renderHook(() => useTimelineTrackManagement({
      dataRef: { current: null }, resolvedConfig: config, selectedClipId: null,
      setSelectedTrackId: vi.fn(), applyEdit,
    }));

    act(() => result.current.handleMoveTrack('overlay', 'picture'));

    expect(applyEdit).toHaveBeenCalledTimes(1);
    const mutation = applyEdit.mock.calls[0][0];
    expect(mutation).toMatchObject({ type: 'config', resolvedConfig: { app: config.app, clips: config.clips } });
    expect(mutation.resolvedConfig.tracks.map((track: TrackDefinition) => track.id)).toEqual(['overlay', 'picture', 'audio']);
    expect(mutation.resolvedConfig.tracks[0]).toEqual(tracks[2]);
    expect(config.tracks.map((track) => track.id)).toEqual(['picture', 'audio', 'overlay']);
    expect(mutation.resolvedConfig.tracks).not.toBe(config.tracks);

    const rebuilt = await buildTimelineData(serializeForDisk(mutation.resolvedConfig), { assets: {} });
    expect(rebuilt.tracks.map((track) => track.id)).toEqual(['overlay', 'picture', 'audio']);

    const before = canonicalDocument();
    const after = structuredClone(before);
    const beforePayload = before.parent_revision.payload as Record<string, unknown>;
    const afterPayload = after.parent_revision.payload as Record<string, unknown>;
    beforePayload.config = { tracks: structuredClone(tracks) };
    afterPayload.config = { tracks: structuredClone(mutation.resolvedConfig.tracks) };
    const patch = documentPatchIntent({
      before,
      after,
      roots: [{ ref: 'parent', revisionId: before.parent_revision.revision_id, contentDigest: before.parent_revision.content_digest }],
      basis: { head: { revisionId: before.parent_revision.revision_id, publicationId: 'original-publication' } },
      label: 'Reorder tracks',
      step: { id: 'track-reorder', label: 'Reorder tracks', intent: 'Reorder tracks', tags: ['editor'] },
    });
    expect(patch).toMatchObject({ kind: 'document-patch-intent', created: [] });
    expect(patch).toHaveProperty('changes', [{ op: 'list.move', ref: 'parent', path: ['config', 'tracks'], id: 'overlay',
      before: { state: 'present', value: tracks[2] }, order_before: ['picture', 'audio', 'overlay'], after_id: null }]);
    expect(patch).not.toHaveProperty('reads');
    expect(patch).not.toHaveProperty('commands');
  });

  it.each(['missing', 'foreign/track:picture', 'track::malformed'])('does not write for an unavailable UI identity: %s', (identity) => {
    const config = makeResolvedConfig([makeTrack('picture', 'visual'), makeTrack('overlay', 'visual')]);
    const applyEdit = vi.fn();
    const { result } = renderHook(() => useTimelineTrackManagement({ dataRef: { current: null }, resolvedConfig: config,
      selectedClipId: null, setSelectedTrackId: vi.fn(), applyEdit }));

    act(() => result.current.handleMoveTrack(identity, 'picture'));
    act(() => result.current.handleMoveTrack('picture', identity));

    expect(applyEdit).not.toHaveBeenCalled();
    expect(config.tracks.map((track) => track.id)).toEqual(['picture', 'overlay']);
  });

  it('does not write an unchanged order, while the patch boundary refuses duplicate current track IDs atomically', () => {
    const config = makeResolvedConfig([makeTrack('picture', 'visual'), makeTrack('overlay', 'visual')]);
    const applyEdit = vi.fn();
    const { result } = renderHook(() => useTimelineTrackManagement({ dataRef: { current: null }, resolvedConfig: config,
      selectedClipId: null, setSelectedTrackId: vi.fn(), applyEdit }));

    act(() => result.current.handleMoveTrack('picture', 'picture'));
    expect(applyEdit).not.toHaveBeenCalled();

    const before = canonicalDocument();
    const after = structuredClone(before);
    const beforePayload = before.parent_revision.payload as Record<string, unknown>;
    const afterPayload = after.parent_revision.payload as Record<string, unknown>;
    beforePayload.config = { tracks: [{ id: 'picture', kind: 'visual' }] };
    afterPayload.config = { tracks: [{ id: 'picture', kind: 'visual' }, { id: 'picture', kind: 'audio' }] };
    expect(() => documentPatchIntent({
      before,
      after,
      roots: [{ ref: 'parent', revisionId: before.parent_revision.revision_id, contentDigest: before.parent_revision.content_digest }],
      basis: { head: { revisionId: before.parent_revision.revision_id, publicationId: 'original-publication' } },
      label: 'Invalid track reorder',
      step: { id: 'invalid-track-reorder', label: 'Invalid track reorder', intent: 'Invalid track reorder', tags: ['editor'] },
    })).toThrow('missing/duplicate id');
  });
});

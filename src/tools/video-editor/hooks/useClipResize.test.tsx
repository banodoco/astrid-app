// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useClipResize, type ClipEdgeResizeSession } from './useClipResize';
import { resolveClipEdgeResizeContext } from './useClipResizeGesture.helpers';
import { applyClipEdgeMove, type ClipEdgeResizeContext, type ResizeDir } from '../lib/resize-math';
import { configToRows, type TimelineData } from '../lib/timeline-data';
import { getConfigSignature, getStableConfigSignature } from '../lib/config-utils';
import type { TimelineApplyEdit } from './timeline-state-types';
import type { AssetRegistryEntry, TimelineConfig } from '../types';
import type { TimelineAction, TimelineRow } from '../types/timeline-canvas';

type FreeClipInput = {
  id: string;
  at: number;
  hold?: number;
  clipType?: 'hold' | 'media' | 'text' | 'effect-layer';
  trackId?: string;
  asset?: string;
  from?: number;
  to?: number;
  speed?: number;
};

function makeData(opts: {
  groupClipIds: string[];
  groupMode?: 'images' | 'video';
  freeClips?: FreeClipInput[];
  tracks?: NonNullable<TimelineConfig['tracks']>;
  registryAssets?: Record<string, AssetRegistryEntry>;
}): TimelineData {
  const {
    groupClipIds,
    groupMode = 'images',
    freeClips = [],
    tracks = [
      { id: 'V1', kind: 'visual', label: 'V1' },
      { id: 'V2', kind: 'visual', label: 'V2' },
    ],
    registryAssets = {},
  } = opts;

  const config: TimelineConfig = {
    output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
    tracks,
    clips: [
      ...groupClipIds.map((id, index) => ({
        id,
        at: index,
        track: 'V1' as const,
        clipType: 'hold' as const,
        hold: 1,
      })),
      ...freeClips.map((clip) => {
        const clipType = clip.clipType ?? 'hold';
        return {
          id: clip.id,
          at: clip.at,
          track: clip.trackId ?? 'V2',
          clipType,
          ...(clipType === 'hold' ? { hold: clip.hold ?? 1 } : {}),
          ...(clipType === 'media'
            ? {
                asset: clip.asset ?? 'asset-video',
                from: clip.from ?? 0,
                to: clip.to ?? 1,
                speed: clip.speed ?? 1,
              }
            : {}),
          ...(clipType === 'text'
            ? {
                hold: clip.hold ?? 1,
                text: { content: 'Text clip' },
              }
            : {}),
          ...(clipType === 'effect-layer' ? { hold: clip.hold ?? 1 } : {}),
        };
      }),
    ],
    pinnedShotGroups: groupClipIds.length > 0
      ? [
          {
            shotId: 'shot-1',
            trackId: 'V1',
            clipIds: [...groupClipIds],
            mode: groupMode,
          },
        ]
      : undefined,
  };

  const rowData = configToRows(config);
  const resolvedConfig = {
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((track) => ({ ...track })),
    clips: config.clips.map((clip) => ({
      ...clip,
      assetEntry: clip.asset
        ? {
            ...registryAssets[clip.asset],
            src: registryAssets[clip.asset]?.file ?? '',
          }
        : undefined,
    })),
    registry: Object.fromEntries(
      Object.entries(registryAssets).map(([assetId, entry]) => [
        assetId,
        { ...entry, src: entry.file },
      ]),
    ),
  };
  return {
    config,
    configVersion: 1,
    registry: { assets: registryAssets },
    resolvedConfig,
    rows: rowData.rows,
    meta: rowData.meta,
    effects: rowData.effects,
    assetMap: Object.fromEntries(Object.entries(registryAssets).map(([assetId, entry]) => [assetId, entry.file])),
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((track) => ({ ...track })),
    clipOrder: rowData.clipOrder,
    signature: getConfigSignature(resolvedConfig),
    stableSignature: getStableConfigSignature(config, { assets: {} }),
  };
}

function buildResolvedFreeSession(
  data: TimelineData,
  rowId: string,
  clipId: string,
  edge: ResizeDir,
): ClipEdgeResizeSession {
  const resolved = resolveClipEdgeResizeContext(
    data.rows,
    [],
    {},
    rowId,
    clipId,
    edge,
    { current: data },
  );
  if (!resolved) {
    throw new Error(`expected resize context for ${clipId}`);
  }

  return {
    pointerId: 1,
    rowId,
    clipId,
    edge,
    cursorOffsetPx: 0,
    initialBoundaryTime: resolved.initialBoundaryTime,
    context: resolved.context,
    siblingTimes: resolved.siblingTimes,
  };
}

function getRow(rows: TimelineRow[], rowId: string): TimelineRow {
  const row = rows.find((candidate) => candidate.id === rowId);
  if (!row) {
    throw new Error(`expected row ${rowId}`);
  }
  return row;
}

function getAction(rows: TimelineRow[], rowId: string, actionId: string): TimelineAction {
  const action = getRow(rows, rowId).actions.find((candidate) => candidate.id === actionId);
  if (!action) {
    throw new Error(`expected action ${actionId}`);
  }
  return action;
}

function buildSession(args: {
  rowId: string;
  clipId: string;
  edge: ResizeDir;
  context: ClipEdgeResizeContext;
}): ClipEdgeResizeSession {
  return {
    pointerId: 1,
    rowId: args.rowId,
    clipId: args.clipId,
    edge: args.edge,
    cursorOffsetPx: 0,
    initialBoundaryTime: 0,
    context: args.context,
    siblingTimes: [],
  };
}

function buildGroupContext(
  rows: TimelineRow[],
  rowId: string,
  clipIds: string[],
  draggedClipId: string,
): ClipEdgeResizeContext {
  const groupActions = clipIds.map((clipId) => getAction(rows, rowId, clipId));
  const snapshot = groupActions.map((action) => ({
    clipId: action.id,
    start: action.start,
    end: action.end,
  }));
  const draggedIndex = snapshot.findIndex((child) => child.clipId === draggedClipId);
  return {
    kind: 'group',
    shotId: 'shot-1',
    trackId: rowId,
    draggedClipId,
    draggedIndex,
    groupClipIds: [...clipIds],
    groupChildrenSnapshot: snapshot,
  };
}

function buildFreeContext(
  rows: TimelineRow[],
  rowId: string,
  clipId: string,
): ClipEdgeResizeContext {
  const action = getAction(rows, rowId, clipId);
  return {
    kind: 'free',
    clipId,
    initialStart: action.start,
    initialEnd: action.end,
  };
}

function expectRowBounds(
  rows: TimelineRow[],
  rowId: string,
  clipId: string,
  bounds: { start: number; end: number },
) {
  const action = getAction(rows, rowId, clipId);
  expect(action.start).toBeCloseTo(bounds.start, 5);
  expect(action.end).toBeCloseTo(bounds.end, 5);
}

describe('useClipResize — unified clip-edge commit path', () => {
  it('adds the shot hard stop as a right-edge snap target', () => {
    const data = makeData({
      groupClipIds: [],
      freeClips: [{ id: 'free', at: 1, hold: 1, trackId: 'V2' }],
    });

    const resolved = resolveClipEdgeResizeContext(
      data.rows,
      [],
      {},
      'V2',
      'free',
      'right',
      { current: data },
      4,
    );

    expect(resolved?.siblingTimes).toContain(4);
  });

  it('commits free clip resize from unified updates', () => {
    const data = makeData({
      groupClipIds: ['a', 'b', 'c'],
      freeClips: [{ id: 'free-1', at: 5, hold: 2 }],
    });
    const dataRef = { current: data };
    const applyEdit = vi.fn<Parameters<TimelineApplyEdit>>();

    const { result } = renderHook(() => useClipResize({ dataRef, applyEdit }));

    const row = getRow(data.rows, 'V2');
    const action = getAction(data.rows, 'V2', 'free-1');
    const session = buildSession({
      rowId: 'V2',
      clipId: 'free-1',
      edge: 'right',
      context: buildFreeContext(data.rows, 'V2', 'free-1'),
    });

    act(() => {
      result.current.onActionResizeStart({ action, row, dir: 'right' });
    });
    act(() => {
      result.current.onClipEdgeResizeEnd({
        session,
        updates: applyClipEdgeMove(session.context, session.edge, 7.5).updates,
        cancelled: false,
      });
    });

    expect(applyEdit).toHaveBeenCalledOnce();
    const [mutation] = applyEdit.mock.calls[0];
    if (mutation.type !== 'rows') {
      throw new Error('expected rows mutation');
    }

    expect(mutation.metaUpdates?.['free-1']).toMatchObject({ hold: expect.closeTo(2.5, 5) });
    expectRowBounds(mutation.rows, 'V2', 'free-1', { start: 5, end: 7.5 });
  });

  it('clamps visual-track video resize to the asset duration', () => {
    const data = makeData({
      groupClipIds: [],
      freeClips: [{
        id: 'video-1',
        at: 5,
        clipType: 'media',
        asset: 'asset-video',
        from: 1,
        to: 2,
        speed: 1,
      }],
      registryAssets: {
        'asset-video': { file: 'video.mp4', type: 'video/mp4', duration: 4 },
      },
    });
    const dataRef = { current: data };
    const applyEdit = vi.fn<Parameters<TimelineApplyEdit>>();

    const { result } = renderHook(() => useClipResize({ dataRef, applyEdit }));
    const row = getRow(data.rows, 'V2');
    const action = getAction(data.rows, 'V2', 'video-1');
    const session = buildResolvedFreeSession(data, 'V2', 'video-1', 'right');

    act(() => {
      result.current.onActionResizeStart({ action, row, dir: 'right' });
    });
    act(() => {
      result.current.onClipEdgeResizeEnd({
        session,
        updates: applyClipEdgeMove(session.context, session.edge, 20).updates,
        cancelled: false,
      });
    });

    expect(applyEdit).toHaveBeenCalledOnce();
    const [mutation] = applyEdit.mock.calls[0];
    if (mutation.type !== 'rows') {
      throw new Error('expected rows mutation');
    }

    expectRowBounds(mutation.rows, 'V2', 'video-1', { start: 5, end: 8 });
  });

  it('does not clamp visual-track video resize when asset duration is unknown', () => {
    const data = makeData({
      groupClipIds: [],
      freeClips: [{
        id: 'video-1',
        at: 5,
        clipType: 'media',
        asset: 'asset-video',
        from: 0,
        to: 1,
        speed: 1,
      }],
      registryAssets: {
        'asset-video': { file: 'video.mp4', type: 'video/mp4' },
      },
    });
    const dataRef = { current: data };
    const applyEdit = vi.fn<Parameters<TimelineApplyEdit>>();

    const { result } = renderHook(() => useClipResize({ dataRef, applyEdit }));
    const row = getRow(data.rows, 'V2');
    const action = getAction(data.rows, 'V2', 'video-1');
    const session = buildResolvedFreeSession(data, 'V2', 'video-1', 'right');

    act(() => {
      result.current.onActionResizeStart({ action, row, dir: 'right' });
    });
    act(() => {
      result.current.onClipEdgeResizeEnd({
        session,
        updates: applyClipEdgeMove(session.context, session.edge, 20).updates,
        cancelled: false,
      });
    });

    expect(applyEdit).toHaveBeenCalledOnce();
    const [mutation] = applyEdit.mock.calls[0];
    if (mutation.type !== 'rows') {
      throw new Error('expected rows mutation');
    }

    expectRowBounds(mutation.rows, 'V2', 'video-1', { start: 5, end: 20 });
  });

  it('does not clamp text clips on visual tracks', () => {
    const data = makeData({
      groupClipIds: [],
      freeClips: [{ id: 'text-1', at: 5, clipType: 'text', hold: 1 }],
    });
    const dataRef = { current: data };
    const applyEdit = vi.fn<Parameters<TimelineApplyEdit>>();

    const { result } = renderHook(() => useClipResize({ dataRef, applyEdit }));
    const row = getRow(data.rows, 'V2');
    const action = getAction(data.rows, 'V2', 'text-1');
    const session = buildResolvedFreeSession(data, 'V2', 'text-1', 'right');

    act(() => {
      result.current.onActionResizeStart({ action, row, dir: 'right' });
    });
    act(() => {
      result.current.onClipEdgeResizeEnd({
        session,
        updates: applyClipEdgeMove(session.context, session.edge, 20).updates,
        cancelled: false,
      });
    });

    expect(applyEdit).toHaveBeenCalledOnce();
    const [mutation] = applyEdit.mock.calls[0];
    if (mutation.type !== 'rows') {
      throw new Error('expected rows mutation');
    }

    expectRowBounds(mutation.rows, 'V2', 'text-1', { start: 5, end: 20 });
  });

  it('does not clamp effect-layer clips on visual tracks', () => {
    const data = makeData({
      groupClipIds: [],
      freeClips: [{ id: 'effect-1', at: 5, clipType: 'effect-layer', hold: 1 }],
    });
    const dataRef = { current: data };
    const applyEdit = vi.fn<Parameters<TimelineApplyEdit>>();

    const { result } = renderHook(() => useClipResize({ dataRef, applyEdit }));
    const row = getRow(data.rows, 'V2');
    const action = getAction(data.rows, 'V2', 'effect-1');
    const session = buildResolvedFreeSession(data, 'V2', 'effect-1', 'right');

    act(() => {
      result.current.onActionResizeStart({ action, row, dir: 'right' });
    });
    act(() => {
      result.current.onClipEdgeResizeEnd({
        session,
        updates: applyClipEdgeMove(session.context, session.edge, 20).updates,
        cancelled: false,
      });
    });

    expect(applyEdit).toHaveBeenCalledOnce();
    const [mutation] = applyEdit.mock.calls[0];
    if (mutation.type !== 'rows') {
      throw new Error('expected rows mutation');
    }

    expectRowBounds(mutation.rows, 'V2', 'effect-1', { start: 5, end: 20 });
  });

  it.each([
    ['right', 'c', 3.5, { edge: 'end', toMs: 3500 }],
    ['left', 'a', 0.5, { edge: 'start', toMs: 500 }],
  ] as const)('sends the shot\'s own %s edge (%s) as an occurrence trim, with the rows edit as its preview', (edge, clipId, time, expected) => {
    const data = makeData({ groupClipIds: ['a', 'b', 'c'] });
    const dataRef = { current: data };
    const applyEdit = vi.fn<Parameters<TimelineApplyEdit>>();
    const { result } = renderHook(() => useClipResize({ dataRef, applyEdit }));
    const row = getRow(data.rows, 'V1');
    const session = buildSession({ rowId: 'V1', clipId, edge,
      context: { ...buildGroupContext(data.rows, 'V1', ['a', 'b', 'c'], clipId), occurrenceId: clipId } });
    act(() => { result.current.onActionResizeStart({ action: getAction(data.rows, 'V1', clipId), row, dir: edge }); });
    act(() => { result.current.onClipEdgeResizeEnd({ session, updates: applyClipEdgeMove(session.context, session.edge, time).updates, cancelled: false }); });
    const [mutation, options] = applyEdit.mock.calls[0];
    expect(mutation.type).toBe('rows');
    expect(options?.gestureBasis).toMatchObject({ kind: 'occurrence-trim', occurrenceId: clipId, ...expected });
  });

  it('keeps a child clip edge inside a shot as a plain rows edit', () => {
    const data = makeData({ groupClipIds: ['a', 'b', 'c'] });
    const dataRef = { current: data };
    const applyEdit = vi.fn<Parameters<TimelineApplyEdit>>();
    const { result } = renderHook(() => useClipResize({ dataRef, applyEdit }));
    const row = getRow(data.rows, 'V1');
    const session = buildSession({ rowId: 'V1', clipId: 'b', edge: 'right',
      context: { ...buildGroupContext(data.rows, 'V1', ['a', 'b', 'c'], 'b'), occurrenceId: 'a' } });
    act(() => { result.current.onActionResizeStart({ action: getAction(data.rows, 'V1', 'b'), row, dir: 'right' }); });
    act(() => { result.current.onClipEdgeResizeEnd({ session, updates: applyClipEdgeMove(session.context, session.edge, 0.5).updates, cancelled: false }); });
    expect(applyEdit.mock.calls[0][1]?.gestureBasis).toBeUndefined();
  });

  it('commits group left-edge resize on first clip, shifting nothing before it', () => {
    const data = makeData({ groupClipIds: ['a', 'b', 'c'] });
    const dataRef = { current: data };
    const applyEdit = vi.fn<Parameters<TimelineApplyEdit>>();

    const { result } = renderHook(() => useClipResize({ dataRef, applyEdit }));

    const row = getRow(data.rows, 'V1');
    const action = getAction(data.rows, 'V1', 'a');
    const session = buildSession({
      rowId: 'V1',
      clipId: 'a',
      edge: 'left',
      context: buildGroupContext(data.rows, 'V1', ['a', 'b', 'c'], 'a'),
    });

    act(() => {
      result.current.onActionResizeStart({ action, row, dir: 'left' });
    });
    act(() => {
      result.current.onClipEdgeResizeEnd({
        session,
        updates: applyClipEdgeMove(session.context, session.edge, -0.5).updates,
        cancelled: false,
      });
    });

    expect(applyEdit).toHaveBeenCalledOnce();
    const [mutation] = applyEdit.mock.calls[0];
    if (mutation.type !== 'rows') {
      throw new Error('expected rows mutation');
    }

    // First clip grows by 0.5 on the left; others unchanged
    expect(mutation.metaUpdates?.a).toMatchObject({ hold: expect.closeTo(1.5, 5) });
    expectRowBounds(mutation.rows, 'V1', 'a', { start: -0.5, end: 1 });
    expectRowBounds(mutation.rows, 'V1', 'b', { start: 1, end: 2 });
    expectRowBounds(mutation.rows, 'V1', 'c', { start: 2, end: 3 });
  });

  it('commits group right-edge resize on last clip, shifting nothing after it', () => {
    const data = makeData({ groupClipIds: ['a', 'b', 'c'] });
    const dataRef = { current: data };
    const applyEdit = vi.fn<Parameters<TimelineApplyEdit>>();

    const { result } = renderHook(() => useClipResize({ dataRef, applyEdit }));

    const row = getRow(data.rows, 'V1');
    const action = getAction(data.rows, 'V1', 'c');
    const session = buildSession({
      rowId: 'V1',
      clipId: 'c',
      edge: 'right',
      context: buildGroupContext(data.rows, 'V1', ['a', 'b', 'c'], 'c'),
    });

    act(() => {
      result.current.onActionResizeStart({ action, row, dir: 'right' });
    });
    act(() => {
      result.current.onClipEdgeResizeEnd({
        session,
        updates: applyClipEdgeMove(session.context, session.edge, 3.5).updates,
        cancelled: false,
      });
    });

    expect(applyEdit).toHaveBeenCalledOnce();
    const [mutation] = applyEdit.mock.calls[0];
    if (mutation.type !== 'rows') {
      throw new Error('expected rows mutation');
    }

    // Last clip grows by 0.5 on the right; others unchanged
    expect(mutation.metaUpdates?.c).toMatchObject({ hold: expect.closeTo(1.5, 5) });
    expectRowBounds(mutation.rows, 'V1', 'a', { start: 0, end: 1 });
    expectRowBounds(mutation.rows, 'V1', 'b', { start: 1, end: 2 });
    expectRowBounds(mutation.rows, 'V1', 'c', { start: 2, end: 3.5 });
  });

  it('commits group right-edge resize for middle clip, pushing subsequent clips', () => {
    const data = makeData({ groupClipIds: ['a', 'b', 'c'] });
    const dataRef = { current: data };
    const applyEdit = vi.fn<Parameters<TimelineApplyEdit>>();

    const { result } = renderHook(() => useClipResize({ dataRef, applyEdit }));

    const row = getRow(data.rows, 'V1');
    const action = getAction(data.rows, 'V1', 'b');
    const session = buildSession({
      rowId: 'V1',
      clipId: 'b',
      edge: 'right',
      context: buildGroupContext(data.rows, 'V1', ['a', 'b', 'c'], 'b'),
    });

    act(() => {
      result.current.onActionResizeStart({ action, row, dir: 'right' });
    });
    act(() => {
      result.current.onClipEdgeResizeEnd({
        session,
        updates: applyClipEdgeMove(session.context, session.edge, 2.3).updates,
        cancelled: false,
      });
    });

    expect(applyEdit).toHaveBeenCalledOnce();
    const [mutation] = applyEdit.mock.calls[0];
    if (mutation.type !== 'rows') {
      throw new Error('expected rows mutation');
    }

    expect(mutation.metaUpdates?.b).toMatchObject({ hold: expect.closeTo(1.3, 5) });
    expect(mutation.metaUpdates?.c).toMatchObject({ hold: expect.closeTo(1, 5) });
    expectRowBounds(mutation.rows, 'V1', 'a', { start: 0, end: 1 });
    expectRowBounds(mutation.rows, 'V1', 'b', { start: 1, end: 2.3 });
    expectRowBounds(mutation.rows, 'V1', 'c', { start: 2.3, end: 3.3 });
  });

  it('commits group left-edge resize for middle clip, pushing preceding clips', () => {
    const data = makeData({ groupClipIds: ['a', 'b', 'c'] });
    const dataRef = { current: data };
    const applyEdit = vi.fn<Parameters<TimelineApplyEdit>>();

    const { result } = renderHook(() => useClipResize({ dataRef, applyEdit }));

    const row = getRow(data.rows, 'V1');
    const action = getAction(data.rows, 'V1', 'b');
    const session = buildSession({
      rowId: 'V1',
      clipId: 'b',
      edge: 'left',
      context: buildGroupContext(data.rows, 'V1', ['a', 'b', 'c'], 'b'),
    });

    act(() => {
      result.current.onActionResizeStart({ action, row, dir: 'left' });
    });
    act(() => {
      result.current.onClipEdgeResizeEnd({
        session,
        updates: applyClipEdgeMove(session.context, session.edge, 0.7).updates,
        cancelled: false,
      });
    });

    expect(applyEdit).toHaveBeenCalledOnce();
    const [mutation] = applyEdit.mock.calls[0];
    if (mutation.type !== 'rows') {
      throw new Error('expected rows mutation');
    }

    expect(mutation.metaUpdates?.a).toMatchObject({ hold: expect.closeTo(1, 5) });
    expect(mutation.metaUpdates?.b).toMatchObject({ hold: expect.closeTo(1.3, 5) });
    expectRowBounds(mutation.rows, 'V1', 'a', { start: -0.3, end: 0.7 });
    expectRowBounds(mutation.rows, 'V1', 'b', { start: 0.7, end: 2 });
    expectRowBounds(mutation.rows, 'V1', 'c', { start: 2, end: 3 });
  });
});

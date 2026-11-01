import { afterEach, describe, expect, it } from 'vitest';
import { computeDropPosition, getPublishedTimelineRowLayout, publishTimelineRowLayout } from './drop-position.ts';
import { buildTimelineRowLayout } from './timeline-row-layout.ts';
import { configToRows, type TimelineData } from './timeline-data.ts';
import type { DataLaneView } from '@/tools/video-editor/data/typed/envelope.ts';
const tracks = [{ id: 'v', label: 'Video', kind: 'visual' as const }, { id: 'a', label: 'Audio', kind: 'audio' as const }];
const sameKindTracks = [
  { id: 'v1', label: 'Video 1', kind: 'visual' as const },
  { id: 'v2', label: 'Video 2', kind: 'visual' as const },
  { id: 'a', label: 'Audio', kind: 'audio' as const },
];
const data = (timelineTracks = tracks) => { const config = { output: { resolution: '1280x720', fps: 30, file: 'out.mp4' }, tracks: timelineTracks, clips: [] }; return { ...configToRows(config), tracks: timelineTracks, config, resolvedConfig: { ...config, registry: {} } } as TimelineData; };
const rect = { x: 0, y: 100, left: 0, top: 100, right: 1000, bottom: 500, width: 1000, height: 400, toJSON() {} };
afterEach(() => document.body.replaceChildren());
function setup(height = 24, timelineTracks = tracks) {
  const wrapper = document.createElement('div');
  const edit = document.createElement('div');
  edit.className = 'timeline-canvas-edit-area';
  edit.dataset.timelineRowLayout = 'managed';
  wrapper.append(edit); document.body.append(wrapper);
  wrapper.getBoundingClientRect = edit.getBoundingClientRect = () => rect;
  const current = data(timelineTracks);
  const layout = buildTimelineRowLayout({ tracks: timelineTracks, lanes: [{ laneId: 'astrid.transcript', height, opaque: true } as DataLaneView], mediaRowHeight: 48,
    placement: { version: 1, lanes: [{ laneId: 'astrid.transcript', beforeTrackId: 'a' }] } });
  const dispose = publishTimelineRowLayout(edit, layout, current);
  const dataRef = { current };
  const drop = (y: number, sourceKind: 'visual' | 'audio' = 'audio') => computeDropPosition({ wrapper, dataRef, clientX: 200, clientY: y,
    scale: 1, scaleWidth: 100, startLeft: 0, rowHeight: 48, sourceKind, clipDuration: 1 });
  return { wrapper, edit, dataRef, layout, drop, dispose };
}
describe('mixed row drop geometry', () => {
  it.each([24, 72])('maps a media row after %ipx lane using actual top and semantic media index', height => {
    const { drop, edit } = setup(height);
    edit.scrollTop = 20;
    const position = drop(100 + 48 + height + 10 - 20);
    expect(position.trackId).toBe('a'); expect(position.rowIndex).toBe(1);
    expect(position.screenCoords.rowTop).toBe(100 + 48 + height - 20);
    expect(position.isNewTrack).toBe(false); expect(position.isReject).toBe(false);
  });
  it('rejects both media kinds on data lanes without requesting track creation', () => {
    const { drop } = setup();
    for (const kind of ['visual', 'audio'] as const) {
      const result = drop(150, kind);
      expect(result.isReject).toBe(true); expect(result.plan?.valid).toBe(false);
      expect(result.plan?.rejectReason).toBe('data_lane_target');
      expect(result.trackId).toBeUndefined(); expect(result.isNewTrack).toBe(false);
    }
  });
  it('creates rows only outside full mixed stack; respects top scroll boundary', () => {
    const { drop, edit } = setup(72);
    expect(drop(100 + 48 + 72 + 47).isNewTrack).toBe(false);
    expect(drop(100 + 48 + 72 + 48).isNewTrack).toBe(true);
    expect(drop(99).isNewTrackTop).toBe(true);
    edit.scrollTop = 30;
    expect(drop(99).isNewTrackTop).toBe(false);
  });
  it('fails closed for absent/stale publications and cleans only its own committed generation', () => {
    const { edit, layout, dataRef, drop, dispose } = setup();
    const newer = publishTimelineRowLayout(edit, layout, dataRef.current);
    dispose(); expect(getPublishedTimelineRowLayout(edit, dataRef.current)).toBe(layout);
    dataRef.current = data();
    expect(drop(190).plan?.rejectReason).toBe('timeline_layout_unavailable');
    newer(); expect(drop(190).isNewTrack).toBe(false);
    delete edit.dataset.timelineRowLayout;
    expect(drop(160).trackId).toBe('a'); // genuine legacy tracks-only caller
  });

  it('keeps the hit owner when mutable rows lag the rendered track order', () => {
    const { edit, layout, dataRef } = setup();
    const current = dataRef.current;
    if (!current) throw new Error('test data is missing');
    current.rows = [...current.rows].reverse();
    publishTimelineRowLayout(edit, layout, current);

    const position = computeDropPosition({
      wrapper: edit.parentElement as HTMLDivElement,
      dataRef,
      clientX: 200,
      clientY: 110,
      scale: 1,
      scaleWidth: 100,
      startLeft: 0,
      rowHeight: 48,
      sourceKind: 'visual',
      clipDuration: 1,
    });

    expect(position.trackId).toBe('v');
    expect(position.plan?.requestedTrackId).toBe('v');
  });

  it('forwards the rendered same-kind owner after rows reorder', () => {
    const { edit, layout, dataRef } = setup(24, sameKindTracks);
    const current = dataRef.current;
    if (!current) throw new Error('test data is missing');
    current.rows = [current.rows[1], current.rows[0], current.rows[2]];
    publishTimelineRowLayout(edit, layout, current);

    const position = computeDropPosition({
      wrapper: edit.parentElement as HTMLDivElement,
      dataRef,
      clientX: 200,
      clientY: 110,
      scale: 1,
      scaleWidth: 100,
      startLeft: 0,
      rowHeight: 48,
      sourceKind: 'visual',
      clipDuration: 1,
    });

    expect(position.rowIndex).toBe(0);
    expect(current.tracks[position.rowIndex]?.id).toBe('v1');
    expect(position.trackId).toBe('v1');
    expect(position.plan?.targetTrackId).toBe('v1');
    expect(position.plan?.requestedTrackId).toBe('v1');
  });

  it('retains the rendered pointer owner when collision resolution selects another track', () => {
    const timelineTracks = [
      { id: 'V1', label: 'Video 1', kind: 'visual' as const },
      { id: 'V2', label: 'Video 2', kind: 'visual' as const },
      { id: 'V3', label: 'Video 3', kind: 'visual' as const },
    ];
    const wrapper = document.createElement('div');
    const edit = document.createElement('div');
    edit.className = 'timeline-canvas-edit-area';
    edit.dataset.timelineRowLayout = 'managed';
    wrapper.append(edit);
    document.body.append(wrapper);
    wrapper.getBoundingClientRect = edit.getBoundingClientRect = () => ({
      x: 0, y: 18, left: 0, top: 18, right: 1000, bottom: 126, width: 1000, height: 108, toJSON() {},
    });
    const current = data(timelineTracks);
    current.rows = current.rows.map(row => row.id === 'V2'
      ? { ...row, actions: [{ id: 'first', start: 3, end: 6, effectId: 'effect-first' },
        { id: 'second', start: 6, end: 9, effectId: 'effect-second' }] }
      : row);
    const dataRef = { current };
    const layout = buildTimelineRowLayout({ tracks: timelineTracks, lanes: [], mediaRowHeight: 36 });
    publishTimelineRowLayout(edit, layout, current);

    const position = computeDropPosition({
      wrapper,
      dataRef,
      clientX: 368,
      clientY: 54,
      scale: 5,
      scaleWidth: 160,
      startLeft: 144,
      rowHeight: 36,
      sourceKind: 'visual',
      clipDuration: 5,
    });

    expect(position.pointerTrackId).toBe('V2');
    expect(position.trackId).toBe('V3');
    expect(position.time).toBe(4.5);

    const managedPosition = computeDropPosition({
      wrapper,
      dataRef,
      clientX: 368,
      clientY: 54,
      scale: 5,
      scaleWidth: 160,
      startLeft: 144,
      rowHeight: 36,
      sourceKind: 'visual',
      clipDuration: 5,
      managedImage: true,
    });
    expect(managedPosition.pointerTrackId).toBe('V2');
    expect(managedPosition.trackId).toBe('V2');
    expect(managedPosition.time).toBe(9);
  });

  it.each([
    ['missing', (rows: TimelineData['rows']) => rows.filter((row) => row.id !== 'v1')],
    ['unknown', (rows: TimelineData['rows']) => [...rows, { id: 'ghost', actions: [] }]],
  ])('fails closed when the rendered track has a %s row snapshot', (_name, mutateRows) => {
    const { edit, layout, dataRef } = setup(24, sameKindTracks);
    const current = dataRef.current;
    if (!current) throw new Error('test data is missing');
    current.rows = mutateRows(current.rows);
    publishTimelineRowLayout(edit, layout, current);

    const position = computeDropPosition({
      wrapper: edit.parentElement as HTMLDivElement,
      dataRef,
      clientX: 200,
      clientY: 110,
      scale: 1,
      scaleWidth: 100,
      startLeft: 0,
      rowHeight: 48,
      sourceKind: 'visual',
      clipDuration: 1,
    });

    expect(position.isReject).toBe(true);
    expect(position.isNewTrack).toBe(false);
    expect(position.trackId).toBeUndefined();
    expect(position.plan?.rejectReason).toBe('timeline_layout_unavailable');
  });
});

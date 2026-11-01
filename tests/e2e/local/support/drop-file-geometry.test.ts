import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { DEFAULT_VISIBLE_CLIP_SPAN_SECONDS } from '../../../../src/tools/video-editor/lib/timeline-asset-durations.ts';
import { publishTimelineRowLayout } from '../../../../src/tools/video-editor/lib/drop-position.ts';
import { buildTimelineRowLayout } from '../../../../src/tools/video-editor/lib/timeline-row-layout.ts';
import { configToRows, type TimelineData } from '../../../../src/tools/video-editor/lib/timeline-data.ts';
import type { DataLaneView } from '../../../../src/tools/video-editor/data/typed/envelope.ts';
import { useDragCoordinator } from '../../../../src/tools/video-editor/hooks/useDragCoordinator.ts';
import { timelineFileDropClientX } from './app.ts';

const tracks = [
  { id: 'parent', label: 'Parent', kind: 'visual' as const },
  { id: 'occurrence', label: 'Occurrence', kind: 'visual' as const },
];
const embeddedTracks = [
  { id: 'plate', label: 'plate', kind: 'visual' as const },
  { id: 'V2', label: 'V2', kind: 'visual' as const },
];
const editRect = { x: 100, y: 100, left: 100, top: 100, right: 700, bottom: 300, width: 600, height: 200, toJSON() {} };
const wrapperRect = { x: 50, y: 100, left: 50, top: 100, right: 750, bottom: 300, width: 700, height: 200, toJSON() {} };
const embeddedV2Y = editRect.top + 48 + 24;

function createTimelineData(fixture: 'parent' | 'embedded' = 'parent'): TimelineData {
  const fixtureTracks = fixture === 'embedded' ? embeddedTracks : tracks;
  const config = {
    output: { resolution: '1280x720', fps: 30, file: 'out.mp4' },
    tracks: fixtureTracks,
    clips: [],
  };
  const current = {
    ...configToRows(config),
    tracks: fixtureTracks,
    config,
    resolvedConfig: { ...config, registry: {} },
  } as TimelineData;
  current.rows = fixture === 'embedded'
    ? [
        { id: 'plate', actions: [{ id: 'f2-plate', start: 0, end: 12, effectId: 'effect-f2-plate' }] },
        { id: 'V2', actions: [
          { id: 'f2-agent-clip', start: 3, end: 6, effectId: 'effect-f2-agent-clip' },
          { id: 'f2-agent-clear-clip', start: 6, end: 9, effectId: 'effect-f2-agent-clear-clip' },
        ] },
      ]
    : [
        { id: 'parent', actions: [{ id: 'parent-clip', start: 0, end: 3, effectId: 'effect-parent-clip' }] },
        { id: 'occurrence', actions: [] },
      ];
  return current;
}

function setup({ scaleWidth = 100, scrollLeft = 0, withLane = false, fixture = 'parent' }: {
  scaleWidth?: number;
  scrollLeft?: number;
  withLane?: boolean;
  fixture?: 'parent' | 'embedded';
} = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'timeline-wrapper';
  const edit = document.createElement('div');
  edit.className = 'timeline-canvas-edit-area';
  edit.dataset.timelineRowLayout = 'managed';
  wrapper.append(edit);
  document.body.append(wrapper);
  wrapper.getBoundingClientRect = () => wrapperRect;
  edit.getBoundingClientRect = () => editRect;
  edit.scrollLeft = scrollLeft;
  const current = createTimelineData(fixture);
  const lanes = withLane
    ? [{ laneId: 'astrid.transcript', height: 24, opaque: true } as DataLaneView]
    : [];
  const layout = buildTimelineRowLayout({
    tracks: fixture === 'embedded' ? embeddedTracks : tracks,
    lanes,
    mediaRowHeight: 48,
    placement: withLane ? { version: 1, lanes: [{ laneId: 'astrid.transcript', beforeTrackId: 'parent' }] } : undefined,
  });
  const dispose = publishTimelineRowLayout(edit, layout, current);
  const dataRef = { current };
  const pixelsPerSecond = scaleWidth;
  return { wrapper, edit, current, dataRef, layout, dispose, pixelsPerSecond };
}

function positionAtClientX(setupResult: ReturnType<typeof setup>, clientX: number, clientY: number, scaleWidth: number) {
  const { dataRef, edit } = setupResult;
  const { result, unmount } = renderHook(() => useDragCoordinator({
    dataRef,
    scale: 1,
    scaleWidth,
    startLeft: 0,
    rowHeight: 48,
  }));
  result.current.editAreaRef.current = edit;
  let position: ReturnType<typeof result.current.coordinator.update>;
  act(() => {
    position = result.current.coordinator.update({
      clientX,
      clientY,
      sourceKind: 'visual',
    });
  });
  act(() => {
    result.current.coordinator.end();
  });
  unmount();
  return position!;
}

function positionAt(
  setupResult: ReturnType<typeof setup>,
  time: number,
  clientY = 124,
  scaleWidth = setupResult.pixelsPerSecond,
  from = 0,
) {
  const clipLeft = editRect.left - setupResult.edit.scrollLeft + from * scaleWidth;
  const clientX = timelineFileDropClientX({
    clipLeft,
    from,
    time,
    pixelsPerSecond: scaleWidth,
  });
  return positionAtClientX(setupResult, clientX, clientY, scaleWidth);
}

afterEach(() => document.body.replaceChildren());

describe('external file-drop pointer geometry', () => {
  it('changes the real coordinator from the old overlapping fallback to the requested parent start', () => {
    const setupResult = setup();
    const oldClientX = editRect.left + 5 * setupResult.pixelsPerSecond;
    const oldPosition = positionAtClientX(setupResult, oldClientX, 124, setupResult.pixelsPerSecond);

    expect(oldPosition.time).toBe(5 - DEFAULT_VISIBLE_CLIP_SPAN_SECONDS / 2);
    expect(oldPosition.plan?.resolvedStart).toBe(5 - DEFAULT_VISIBLE_CLIP_SPAN_SECONDS / 2);
    expect(oldPosition.trackId).toBe('occurrence');

    const corrected = positionAt(setupResult, 5);
    expect(corrected.time).toBe(5);
    expect(corrected.plan?.resolvedStart).toBe(5);
    expect(corrected.trackId).toBe('parent');
    expect(corrected.plan?.needsNewTrack).toBe(false);
  });

  it('keeps the correction tied to rendered zoom and scroll geometry', () => {
    const setupResult = setup({ scaleWidth: 140, scrollLeft: 60 });
    const corrected = positionAt(setupResult, 5, 124, 140);

    expect(corrected.time).toBe(5);
    expect(corrected.trackId).toBe('parent');
    expect(corrected.isNewTrack).toBe(false);
    expect(corrected.isReject).toBe(false);
  });

  it('retains an explicit center-pointer call contract for non-image drops', () => {
    const setupResult = setup();
    const centerX = timelineFileDropClientX({
      clipLeft: editRect.left,
      from: 0,
      time: 22.5,
      pixelsPerSecond: setupResult.pixelsPerSecond,
      previewDurationSeconds: 0,
    });
    const position = positionAtClientX(setupResult, centerX, 124, setupResult.pixelsPerSecond);

    expect(position.time).toBe(20);
    expect(position.plan?.resolvedStart).toBe(20);
    expect(position.trackId).toBe('parent');
  });

  it('rejects a data-lane target instead of allowing the planner to reroute it', () => {
    const setupResult = setup({ withLane: true });
    const corrected = positionAt(setupResult, 5, 110);

    expect(corrected.isReject).toBe(true);
    expect(corrected.isNewTrack).toBe(false);
    expect(corrected.trackId).toBeUndefined();
    expect(corrected.plan?.rejectReason).toBe('data_lane_target');
  });

  it('keeps the embedded occurrence V2 start at 4.5s with the real clip fixture', () => {
    const setupResult = setup({ fixture: 'embedded' });
    const oldClipLeft = editRect.left + 3 * setupResult.pixelsPerSecond;
    const oldClientX = oldClipLeft + (4.5 - 3) * setupResult.pixelsPerSecond;
    const oldPosition = positionAtClientX(setupResult, oldClientX, embeddedV2Y, setupResult.pixelsPerSecond);

    expect(oldPosition.time).toBe(2);
    expect(oldPosition.plan?.requestedTrackId).toBe('V2');
    expect(oldPosition.isNewTrack).toBe(true);

    const corrected = positionAt(setupResult, 4.5, embeddedV2Y, setupResult.pixelsPerSecond, 3);
    expect(corrected.time).toBe(4.5);
    expect(corrected.plan?.resolvedStart).toBe(4.5);
    expect(corrected.plan?.requestedTrackId).toBe('V2');
    expect(corrected.isReject).toBe(false);
  });

  it('keeps embedded occurrence placement correct under zoom, scroll and viewport clamp', () => {
    const setupResult = setup({ fixture: 'embedded', scaleWidth: 140, scrollLeft: 360 });
    const corrected = positionAt(setupResult, 4.5, embeddedV2Y, 140, 3);
    const clientX = timelineFileDropClientX({
      clipLeft: editRect.left - setupResult.edit.scrollLeft + 3 * 140,
      from: 3,
      time: 4.5,
      pixelsPerSecond: 140,
    });

    expect(clientX).toBeGreaterThanOrEqual(wrapperRect.left);
    expect(clientX).toBeLessThanOrEqual(wrapperRect.right);
    expect(corrected.time).toBe(4.5);
    expect(corrected.plan?.resolvedStart).toBe(4.5);
    expect(corrected.plan?.requestedTrackId).toBe('V2');
  });

  it.each([
    ['wrong occurrence', (rows: TimelineData['rows']) => rows.map((row) => row.id === 'V2' ? { ...row, id: 'wrong-occurrence:V2' } : row)],
    ['missing occurrence', (rows: TimelineData['rows']) => rows.filter((row) => row.id !== 'V2')],
    ['ambiguous occurrence', (rows: TimelineData['rows']) => [...rows, { id: 'V2', actions: [] }]],
  ])('rejects a %s row snapshot before planner rerouting', (_name, mutateRows) => {
    const setupResult = setup({ fixture: 'embedded' });
    setupResult.current.rows = mutateRows(setupResult.current.rows);
    const corrected = positionAt(setupResult, 4.5, embeddedV2Y, setupResult.pixelsPerSecond, 3);

    expect(corrected.isReject).toBe(true);
    expect(corrected.isNewTrack).toBe(false);
    expect(corrected.trackId).toBeUndefined();
    expect(corrected.plan?.rejectReason).toBe('timeline_layout_unavailable');
  });

  it.each([
    ['missing', (rows: TimelineData['rows']) => rows.filter((row) => row.id !== 'parent')],
    ['ambiguous', (rows: TimelineData['rows']) => [...rows, { id: 'ghost', actions: [] }]],
  ])('fails closed for a %s row snapshot', (_name, mutateRows) => {
    const setupResult = setup();
    setupResult.current.rows = mutateRows(setupResult.current.rows);
    const corrected = positionAt(setupResult, 5);

    expect(corrected.isReject).toBe(true);
    expect(corrected.isNewTrack).toBe(false);
    expect(corrected.trackId).toBeUndefined();
    expect(corrected.plan?.rejectReason).toBe('timeline_layout_unavailable');
  });
});

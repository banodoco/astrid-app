import {
  __getSelectionStateForTests,
  __resetSelectionStoreForTests,
  editorSetSelectedTrackId,
  userSelectTimelineClip,
  userSelectTimelineItems,
} from '@/shared/state/selectionStore';
import { commitDraggingSession } from './useClipDrag.helpers.ts';
// @vitest-environment jsdom
import { act, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useClipDrag } from '@/tools/video-editor/hooks/useClipDrag';
import type { DragCoordinator } from '@/tools/video-editor/hooks/useDragCoordinator';
import { createInteractionState } from '@/tools/video-editor/lib/interaction-state';
import { repairConfig } from '@/tools/video-editor/lib/migrate';
import { configToRows, type TimelineData } from '@/tools/video-editor/lib/timeline-data';
import type { TimelineConfig, TrackDefinition } from '@/tools/video-editor/types';
import { planClipDrag } from '@/tools/video-editor/lib/clip-drag-planner.ts';
import type { ReactNode } from 'react';
import {
  createTimelineStore,
  TimelineStoreProvider,
} from '@/tools/video-editor/hooks/timelineStore';
import type {
  TimelineEditorDataContextValue,
  TimelineEditorOpsContextValue,
} from '@/tools/video-editor/hooks/useTimelineState.types';

const selectionMocks = vi.hoisted(() => ({
  userSelectTimelineClip: vi.fn(),
  userSelectTimelineClips: vi.fn(),
}));

vi.mock('@/shared/state/selectionStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/state/selectionStore')>();
  selectionMocks.userSelectTimelineClip.mockImplementation((...args) => actual.userSelectTimelineClip(...args));
  selectionMocks.userSelectTimelineClips.mockImplementation((...args) => actual.userSelectTimelineClips(...args));
  return {
    ...actual,
    userSelectTimelineClip: selectionMocks.userSelectTimelineClip,
    userSelectTimelineClips: selectionMocks.userSelectTimelineClips,
  };
});

const makeTrack = (id: string): TrackDefinition => ({
  id,
  kind: 'visual',
  label: id,
  scale: 1,
  fit: 'manual',
  opacity: 1,
  blendMode: 'normal',
});

function makeCoordinator(overrides: Partial<ReturnType<DragCoordinator['update']>> = {}): DragCoordinator {
  const defaultPosition = {
    time: 0,
    rowIndex: 0,
    trackId: 'V1',
    trackKind: 'visual' as const,
    trackName: 'V1',
    isNewTrack: false,
    isNewTrackTop: false,
    isReject: false,
    newTrackKind: null,
    screenCoords: {
      rowTop: 0,
      rowLeft: 0,
      rowWidth: 0,
      rowHeight: 48,
      clipLeft: 0,
      clipWidth: 0,
      ghostCenter: 0,
    },
  };
  const coordinator = {
    update: vi.fn(() => {
      const nextPosition = {
        ...defaultPosition,
        ...overrides,
        screenCoords: {
          ...defaultPosition.screenCoords,
          ...overrides.screenCoords,
        },
      };
      coordinator.lastPosition = nextPosition;
      return nextPosition;
    }),
    showSecondaryGhosts: vi.fn(),
    end: vi.fn(),
    lastPosition: null,
    editAreaRef: { current: null },
  } satisfies DragCoordinator;

  return coordinator;
}

function canonicalizeTimelineData(data: TimelineData): TimelineData {
  const config = repairConfig(data.config as TimelineConfig);
  const rowData = configToRows(config);

  return {
    ...data,
    config,
    resolvedConfig: {
      ...data.resolvedConfig,
      output: { ...config.output },
      tracks: (config.tracks ?? []).map((track) => ({ ...track })),
      clips: config.clips.map((clip) => ({ ...clip })),
    },
    rows: rowData.rows,
    meta: rowData.meta,
    effects: rowData.effects,
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((track) => ({ ...track })),
    clipOrder: rowData.clipOrder,
  };
}

function makeData(): TimelineData {
  const baseTrack = makeTrack('V1');
  return canonicalizeTimelineData({
    config: {
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      tracks: [baseTrack],
      clips: [{ id: 'clip-1', at: 0, track: 'V1', clipType: 'hold', hold: 2 }],
    },
    configVersion: 1,
    registry: { assets: {} },
    resolvedConfig: {
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      tracks: [baseTrack],
      clips: [{ id: 'clip-1', at: 0, track: 'V1', clipType: 'hold', hold: 2 }],
      registry: {},
    },
    rows: [{
      id: 'V1',
      actions: [{ id: 'clip-1', start: 0, end: 2, effectId: 'effect-clip-1' }],
    }],
    meta: {
      'clip-1': {
        track: 'V1',
        clipType: 'hold',
        hold: 2,
      },
    },
    effects: {
      'effect-clip-1': { id: 'effect-clip-1' },
    },
    assetMap: {},
    output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
    tracks: [baseTrack],
    clipOrder: { V1: ['clip-1'] },
    signature: 'sig-1',
    stableSignature: 'stable-1',
  });
}

function makeMultiClipData(): TimelineData {
  const tracks = [makeTrack('V1'), makeTrack('V2')];
  return canonicalizeTimelineData({
    config: {
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      tracks,
      clips: [
        { id: 'clip-1', at: 0, track: 'V1', clipType: 'hold', hold: 2 },
        { id: 'clip-2', at: 2, track: 'V2', clipType: 'hold', hold: 2 },
      ],
    },
    configVersion: 1,
    registry: { assets: {} },
    resolvedConfig: {
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      tracks,
      clips: [
        { id: 'clip-1', at: 0, track: 'V1', clipType: 'hold', hold: 2 },
        { id: 'clip-2', at: 2, track: 'V2', clipType: 'hold', hold: 2 },
      ],
      registry: {},
    },
    rows: [
      { id: 'V1', actions: [{ id: 'clip-1', start: 0, end: 2, effectId: 'effect-clip-1' }] },
      { id: 'V2', actions: [{ id: 'clip-2', start: 2, end: 4, effectId: 'effect-clip-2' }] },
    ],
    meta: {
      'clip-1': { track: 'V1', clipType: 'hold', hold: 2 },
      'clip-2': { track: 'V2', clipType: 'hold', hold: 2 },
    },
    effects: {
      'effect-clip-1': { id: 'effect-clip-1' },
      'effect-clip-2': { id: 'effect-clip-2' },
    },
    assetMap: {},
    output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
    tracks,
    clipOrder: { V1: ['clip-1'], V2: ['clip-2'] },
    signature: 'sig-1',
    stableSignature: 'stable-1',
  });
}

function makePinnedGroupData(): TimelineData {
  const tracks = [makeTrack('V1'), makeTrack('V2')];
  return canonicalizeTimelineData({
    config: {
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      tracks,
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
    configVersion: 1,
    registry: { assets: {} },
    resolvedConfig: {
      output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
      tracks,
      clips: [
        { id: 'clip-1', at: 0, track: 'V1', clipType: 'hold', hold: 2 },
        { id: 'clip-2', at: 2, track: 'V1', clipType: 'hold', hold: 2 },
      ],
      registry: {},
    },
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
    meta: {
      'clip-1': { track: 'V1', clipType: 'hold', hold: 2 },
      'clip-2': { track: 'V1', clipType: 'hold', hold: 2 },
    },
    effects: {
      'effect-clip-1': { id: 'effect-clip-1' },
      'effect-clip-2': { id: 'effect-clip-2' },
    },
    assetMap: {},
    output: { resolution: '1920x1080', fps: 30, file: 'out.mp4' },
    tracks,
    clipOrder: { V1: ['clip-1', 'clip-2'], V2: [] },
    signature: 'sig-1',
      stableSignature: 'stable-1',
  });
}

function makePinnedGroupDataWithExtraSelection(): TimelineData {
  const base = makePinnedGroupData();

  return canonicalizeTimelineData({
    ...base,
    config: {
      ...base.config,
      clips: [
        ...base.config.clips,
        { id: 'clip-3', at: 0, track: 'V2', clipType: 'hold', hold: 2 },
      ],
    },
    resolvedConfig: {
      ...base.resolvedConfig,
      clips: [
        ...base.resolvedConfig.clips,
        { id: 'clip-3', at: 0, track: 'V2', clipType: 'hold', hold: 2 },
      ],
    },
    rows: [
      base.rows[0],
      {
        id: 'V2',
        actions: [{ id: 'clip-3', start: 0, end: 2, effectId: 'effect-clip-3' }],
      },
    ],
    meta: {
      ...base.meta,
      'clip-3': { track: 'V2', clipType: 'hold', hold: 2 },
    },
    effects: {
      ...base.effects,
      'effect-clip-3': { id: 'effect-clip-3' },
    },
    clipOrder: { V1: ['clip-1', 'clip-2'], V2: ['clip-3'] },
  });
}

/**
 * useClipDrag reads everything from the timeline store, so a scenario is store
 * state — there is no prop channel to pass these through.
 */
type ClipDragScenario =
  Pick<
    TimelineEditorDataContextValue,
    | 'timelineWrapperRef'
    | 'dataRef'
    | 'selectedClipIdsRef'
    | 'additiveSelectionRef'
    | 'deviceClass'
    | 'interactionMode'
    | 'gestureOwner'
    | 'coordinator'
    | 'scale'
    | 'scaleWidth'
  >
  & Partial<Pick<TimelineEditorDataContextValue, 'interactionStateRef'>>
  & Pick<
    TimelineEditorOpsContextValue,
    | 'setGestureOwner'
    | 'setInputModalityFromPointerType'
    | 'setSelectedTrackId'
    | 'moveClipToRow'
    | 'createTrackAndMoveClip'
    | 'selectClip'
    | 'selectClips'
    | 'applyEdit'
  >;

function renderClipDrag(scenario: ClipDragScenario & { applyResolvedClipMove?: TimelineEditorOpsContextValue['applyResolvedClipMove'] }) {
  const store = createTimelineStore();
  const initial = store.getState();
  initial.syncSlices({
    data: {
      ...initial.data,
      timelineWrapperRef: scenario.timelineWrapperRef,
      dataRef: scenario.dataRef,
      interactionStateRef: scenario.interactionStateRef ?? initial.data.interactionStateRef,
      selectedClipIdsRef: scenario.selectedClipIdsRef,
      additiveSelectionRef: scenario.additiveSelectionRef,
      deviceClass: scenario.deviceClass,
      interactionMode: scenario.interactionMode,
      gestureOwner: scenario.gestureOwner,
      coordinator: scenario.coordinator,
      scale: scenario.scale,
      scaleWidth: scenario.scaleWidth,
    },
    ops: {
      ...initial.ops,
      setGestureOwner: scenario.setGestureOwner,
      setInputModalityFromPointerType: scenario.setInputModalityFromPointerType,
      setSelectedTrackId: scenario.setSelectedTrackId ?? vi.fn(),
      moveClipToRow: scenario.moveClipToRow,
      ...(scenario.applyResolvedClipMove ? { applyResolvedClipMove: scenario.applyResolvedClipMove } : {}),
      createTrackAndMoveClip: scenario.createTrackAndMoveClip,
      selectClip: scenario.selectClip,
      selectClips: scenario.selectClips,
      applyEdit: scenario.applyEdit,
    },
  });

  return renderHook(() => useClipDrag(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <TimelineStoreProvider store={store}>{children}</TimelineStoreProvider>
    ),
  });
}

function setupDom(clipId = 'clip-1', rowId = 'V1') {
  const wrapper = document.createElement('div');
  wrapper.className = 'timeline-wrapper';
  const editArea = document.createElement('div');
  editArea.className = 'timeline-canvas-edit-area';
  const clip = document.createElement('div');
  clip.className = 'clip-action';
  clip.dataset.clipId = clipId;
  clip.dataset.rowId = rowId;
  clip.getBoundingClientRect = () => ({
    x: 0,
    y: rowId === 'V2' ? 48 : 0,
    left: 0,
    top: rowId === 'V2' ? 48 : 0,
    right: 120,
    bottom: rowId === 'V2' ? 72 : 24,
    width: 120,
    height: 24,
    toJSON: () => ({}),
  });
  editArea.appendChild(clip);
  wrapper.appendChild(editArea);
  document.body.appendChild(wrapper);

  return {
    clip,
    wrapper,
    cleanup: () => wrapper.remove(),
  };
}

function createSvgPath(parent: Element): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  svg.appendChild(path);
  parent.appendChild(svg);
  return path;
}

function setupPinnedGroupLabelDom(anchorClipId = 'clip-1', rowId = 'V1') {
  const base = setupDom(anchorClipId, rowId);
  const label = document.createElement('div');
  label.dataset.shotGroupDragAnchorClipId = anchorClipId;
  label.dataset.shotGroupDragAnchorRowId = rowId;
  label.dataset.actionId = 'shot-group-label';
  label.title = 'Pinned Shot';
  label.getBoundingClientRect = () => ({
    x: 0,
    y: -18,
    left: 0,
    top: -18,
    right: 120,
    bottom: 0,
    width: 120,
    height: 18,
    toJSON: () => ({}),
  });
  base.wrapper.appendChild(label);

  return {
    ...base,
    label,
  };
}

afterEach(() => {
  __resetSelectionStoreForTests();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('useClipDrag', () => {
  it.each(['stable', 'changed'] as const)('passes the original ordinary move inputs only while the planner input remains %s', (input) => {
    const { clip, wrapper, cleanup } = setupDom();
    const data = makeData();
    const dataRef = { current: data };
    const plan = planClipDrag({ pointerTime: 5, clipDuration: 2, clipId: 'clip-1', sourceKind: 'visual',
      tracks: data.tracks, rows: data.rows, pointerRowIndex: 0, pixelSnapThreshold: 8, pixelsPerSecond: 100 });
    const coordinator = makeCoordinator({ time: plan.resolvedStart, plan });
    Object.defineProperty(coordinator, 'lastPlan', { get: () => plan });
    const applyResolvedClipMove = vi.fn();
    try {
      renderClipDrag({ timelineWrapperRef: { current: wrapper }, dataRef, coordinator, scale: 1, scaleWidth: 100,
        deviceClass: 'desktop', interactionMode: 'select', gestureOwner: 'none', setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: () => 'mouse', selectedClipIdsRef: { current: new Set(['clip-1']) },
        additiveSelectionRef: { current: false }, moveClipToRow: vi.fn(), applyResolvedClipMove,
        createTrackAndMoveClip: vi.fn(), selectClip: vi.fn(), selectClips: vi.fn(), applyEdit: vi.fn() });
      fireEvent.pointerDown(clip, { button: 0, pointerId: 77, clientX: 20, clientY: 12 });
      fireEvent.pointerMove(window, { pointerId: 77, clientX: 80, clientY: 12 });
      if (input === 'changed') dataRef.current = structuredClone(data);
      fireEvent.pointerUp(window, { pointerId: 77, clientX: 80, clientY: 12 });
      expect(applyResolvedClipMove).toHaveBeenCalledTimes(1);
      const args = applyResolvedClipMove.mock.calls[0];
      expect(args.slice(0, 5)).toEqual(['clip-1', 'V1', 'V1', 5, false]);
      if (input === 'stable') expect(args[6]).toEqual({ kind: 'move', clipId: 'clip-1', trackId: 'V1', config: data.config, registry: data.registry });
      else expect(args).toHaveLength(6);
    } finally { cleanup(); }
  });

  it('toggles interactionStateRef.drag only after the drag threshold is crossed', () => {
    const interactionStateRef = { current: createInteractionState() };
    const { clip, wrapper, cleanup } = setupDom();
    const timelineWrapperRef = { current: wrapper };
    const dataRef = { current: makeData() };

    try {
      renderClipDrag({
        timelineWrapperRef,
        dataRef,

        interactionStateRef,
        deviceClass: 'desktop',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>() },
        additiveSelectionRef: { current: false },
        applyEdit: vi.fn(),
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(clip, {
          button: 0,
          pointerId: 9,
          clientX: 24,
          clientY: 12,
        });
      });

      expect(interactionStateRef.current.drag).toBe(false);

      act(() => {
        fireEvent.pointerMove(window, {
          pointerId: 9,
          clientX: 26,
          clientY: 12,
        });
      });

      expect(interactionStateRef.current.drag).toBe(false);

      act(() => {
        fireEvent.pointerMove(window, {
          pointerId: 9,
          clientX: 32,
          clientY: 12,
        });
      });

      expect(interactionStateRef.current.drag).toBe(true);

      act(() => {
        fireEvent.pointerUp(window, {
          pointerId: 9,
          clientX: 32,
          clientY: 12,
        });
      });

      expect(interactionStateRef.current.drag).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('preserves additive touch selection on move-mode taps that do not start a drag', () => {

    const selectClip = vi.fn();
    const setSelectedTrackId = vi.fn((trackId: string | null) => editorSetSelectedTrackId(trackId));
    const { clip, wrapper, cleanup } = setupDom();
    const timelineWrapperRef = { current: wrapper };
    const dataRef = { current: makeData() };

    try {
      renderClipDrag({
        timelineWrapperRef,
        dataRef,

        deviceClass: 'phone',
        interactionMode: 'move',
        gestureOwner: 'none',
        setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: vi.fn(() => 'touch'),
        setSelectedTrackId,
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip,
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>(['clip-1', 'clip-2']) },
        additiveSelectionRef: { current: true },
        applyEdit: vi.fn(),
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(clip, {
          button: 0,
          pointerId: 13,
          pointerType: 'touch',
          clientX: 24,
          clientY: 12,
        });
      });

      act(() => {
        fireEvent.pointerUp(window, {
          pointerId: 13,
          clientX: 24,
          clientY: 12,
        });
      });

      expect(selectionMocks.userSelectTimelineClip).toHaveBeenCalledWith('clip-1', {
        additive: false,
        preserveIfSelected: true,
      }, undefined);
      expect(setSelectedTrackId).toHaveBeenCalledWith('V1');
    } finally {
      cleanup();
    }
  });

  it('keeps the mounted pointer selection track aligned with a clip on a later row', () => {
    const { clip, wrapper, cleanup } = setupDom('clip-2', 'V2');
    const setSelectedTrackId = vi.fn((trackId: string | null) => editorSetSelectedTrackId(trackId));
    editorSetSelectedTrackId('V1');

    try {
      renderClipDrag({
        timelineWrapperRef: { current: wrapper },
        dataRef: { current: makeMultiClipData() },
        deviceClass: 'desktop',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        setSelectedTrackId,
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>() },
        additiveSelectionRef: { current: false },
        applyEdit: vi.fn(),
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      fireEvent.pointerDown(clip, { button: 0, pointerId: 23, clientX: 24, clientY: 60 });
      fireEvent.pointerUp(window, { pointerId: 23, clientX: 24, clientY: 60 });

      expect(__getSelectionStateForTests().timeline.selectedClipIds).toEqual(new Set(['clip-2']));
      expect(__getSelectionStateForTests().timeline.selectedTrackId).toBe('V2');
      expect(setSelectedTrackId).toHaveBeenCalledWith('V2');
    } finally {
      cleanup();
    }
  });

  it('keeps shift selection additive while making the newly selected clip track explicit', () => {
    const { clip, wrapper, cleanup } = setupDom('clip-2', 'V2');
    const setSelectedTrackId = vi.fn((trackId: string | null) => editorSetSelectedTrackId(trackId));
    userSelectTimelineClip('clip-1', { additive: false });
    editorSetSelectedTrackId('V1');

    try {
      renderClipDrag({
        timelineWrapperRef: { current: wrapper },
        dataRef: { current: makeMultiClipData() },
        deviceClass: 'desktop',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        setSelectedTrackId,
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set(['clip-1']) },
        additiveSelectionRef: { current: true },
        applyEdit: vi.fn(),
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      fireEvent.pointerDown(clip, { button: 0, pointerId: 24, clientX: 24, clientY: 60 });
      fireEvent.pointerUp(window, { pointerId: 24, shiftKey: true, clientX: 24, clientY: 60 });

      expect(__getSelectionStateForTests().timeline.selectedClipIds).toEqual(new Set(['clip-1', 'clip-2']));
      expect(__getSelectionStateForTests().timeline.selectedTrackId).toBe('V2');
      expect(setSelectedTrackId).toHaveBeenCalledWith('V2');
    } finally {
      cleanup();
    }
  });

  it('does not invent a track when toggle selection clears the clicked clip', () => {
    const { clip, wrapper, cleanup } = setupDom('clip-2', 'V2');
    const setSelectedTrackId = vi.fn((trackId: string | null) => editorSetSelectedTrackId(trackId));
    userSelectTimelineClip('clip-2', { additive: false });
    editorSetSelectedTrackId('V2');

    try {
      renderClipDrag({
        timelineWrapperRef: { current: wrapper },
        dataRef: { current: makeMultiClipData() },
        deviceClass: 'desktop',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        setSelectedTrackId,
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set(['clip-2']) },
        additiveSelectionRef: { current: true },
        applyEdit: vi.fn(),
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      fireEvent.pointerDown(clip, { button: 0, metaKey: true, pointerId: 25, clientX: 24, clientY: 60 });
      fireEvent.pointerUp(window, { pointerId: 25, metaKey: true, clientX: 24, clientY: 60 });

      expect(__getSelectionStateForTests().timeline.selectedClipIds).toEqual(new Set());
      expect(__getSelectionStateForTests().timeline.selectedTrackId).toBe('V2');
      expect(setSelectedTrackId).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('refuses an unknown clip row without changing selection ownership', () => {
    const { clip, wrapper, cleanup } = setupDom('missing', 'V9');
    const setSelectedTrackId = vi.fn();

    try {
      renderClipDrag({
        timelineWrapperRef: { current: wrapper },
        dataRef: { current: makeData() },
        deviceClass: 'desktop',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        setSelectedTrackId,
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>() },
        additiveSelectionRef: { current: false },
        applyEdit: vi.fn(),
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      fireEvent.pointerDown(clip, { button: 0, pointerId: 26, clientX: 24, clientY: 60 });
      fireEvent.pointerUp(window, { pointerId: 26, clientX: 24, clientY: 60 });

      expect(__getSelectionStateForTests().timeline.selectedClipIds).toEqual(new Set());
      expect(setSelectedTrackId).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('keeps tablet touch select-mode drags dormant while tablet mouse still follows desktop drag behavior', () => {

    const touchInteractionStateRef = { current: createInteractionState() };
    const touchSetGestureOwner = vi.fn();
    const touchDom = setupDom();
    const touchTimelineWrapperRef = { current: touchDom.wrapper };
    const touchDataRef = { current: makeData() };

    try {
      renderClipDrag({
        timelineWrapperRef: touchTimelineWrapperRef,
        dataRef: touchDataRef,

        interactionStateRef: touchInteractionStateRef,
        deviceClass: 'tablet',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: touchSetGestureOwner,
        setInputModalityFromPointerType: vi.fn(() => 'touch'),
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>() },
        additiveSelectionRef: { current: false },
        applyEdit: vi.fn(),
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(touchDom.clip, {
          button: 0,
          pointerId: 14,
          pointerType: 'touch',
          clientX: 24,
          clientY: 12,
        });
      });

      act(() => {
        fireEvent.pointerMove(window, {
          pointerId: 14,
          pointerType: 'touch',
          clientX: 40,
          clientY: 12,
        });
      });

      expect(touchSetGestureOwner).not.toHaveBeenCalled();
      expect(touchInteractionStateRef.current.drag).toBe(false);

      act(() => {
        fireEvent.pointerUp(window, {
          pointerId: 14,
          pointerType: 'touch',
          clientX: 40,
          clientY: 12,
        });
      });


    } finally {
      touchDom.cleanup();
    }


    const mouseInteractionStateRef = { current: createInteractionState() };
    const mouseSetGestureOwner = vi.fn();
    const mouseDom = setupDom();
    const mouseTimelineWrapperRef = { current: mouseDom.wrapper };
    const mouseDataRef = { current: makeData() };

    try {
      renderClipDrag({
        timelineWrapperRef: mouseTimelineWrapperRef,
        dataRef: mouseDataRef,

        interactionStateRef: mouseInteractionStateRef,
        deviceClass: 'tablet',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: mouseSetGestureOwner,
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>() },
        additiveSelectionRef: { current: false },
        applyEdit: vi.fn(),
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(mouseDom.clip, {
          button: 0,
          pointerId: 15,
          pointerType: 'mouse',
          clientX: 24,
          clientY: 12,
        });
      });

      act(() => {
        fireEvent.pointerMove(window, {
          pointerId: 15,
          pointerType: 'mouse',
          clientX: 40,
          clientY: 12,
        });
      });

      expect(mouseSetGestureOwner).toHaveBeenCalledWith('clip');
      expect(mouseInteractionStateRef.current.drag).toBe(true);

      act(() => {
        fireEvent.pointerUp(window, {
          pointerId: 15,
          pointerType: 'mouse',
          clientX: 40,
          clientY: 12,
        });
      });

      expect(mouseInteractionStateRef.current.drag).toBe(false);

    } finally {
      mouseDom.cleanup();
    }
  });

  it('arms tablet touch clip dragging in move mode only after the drag threshold is crossed', () => {

    const interactionStateRef = { current: createInteractionState() };
    const setGestureOwner = vi.fn();
    const { clip, wrapper, cleanup } = setupDom();
    const timelineWrapperRef = { current: wrapper };
    const dataRef = { current: makeData() };

    try {
      const { result } = renderClipDrag({
        timelineWrapperRef,
        dataRef,

        interactionStateRef,
        deviceClass: 'tablet',
        interactionMode: 'move',
        gestureOwner: 'none',
        setGestureOwner,
        setInputModalityFromPointerType: vi.fn(() => 'touch'),
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>(['clip-1']) },
        additiveSelectionRef: { current: true },
        applyEdit: vi.fn(),
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(clip, {
          button: 0,
          pointerId: 16,
          pointerType: 'touch',
          clientX: 24,
          clientY: 12,
        });
      });

      act(() => {
        fireEvent.pointerMove(window, {
          pointerId: 16,
          pointerType: 'touch',
          clientX: 26,
          clientY: 12,
        });
      });

      expect(setGestureOwner).not.toHaveBeenCalled();
      expect(interactionStateRef.current.drag).toBe(false);

      act(() => {
        fireEvent.pointerMove(window, {
          pointerId: 16,
          pointerType: 'touch',
          clientX: 40,
          clientY: 12,
        });
      });

      expect(setGestureOwner).toHaveBeenCalledWith('clip');
      expect(interactionStateRef.current.drag).toBe(true);
      expect(result.current.isDragging).toBe(true);

      act(() => {
        fireEvent.pointerUp(window, {
          pointerId: 16,
          pointerType: 'touch',
          clientX: 40,
          clientY: 12,
        });
      });

      expect(interactionStateRef.current.drag).toBe(false);
      expect(result.current.isDragging).toBe(false);

    } finally {
      cleanup();
    }
  });

  it('cancels a touch clip drag, without committing it, when a second finger lands (pinch)', () => {
    const interactionStateRef = { current: createInteractionState() };
    const setGestureOwner = vi.fn();
    const moveClipToRow = vi.fn();
    const applyEdit = vi.fn();
    const { clip, wrapper, cleanup } = setupDom();

    try {
      const { result } = renderClipDrag({
        timelineWrapperRef: { current: wrapper },
        dataRef: { current: makeData() },
        interactionStateRef,
        deviceClass: 'phone',
        interactionMode: 'move',
        gestureOwner: 'none',
        setGestureOwner,
        setInputModalityFromPointerType: vi.fn(() => 'touch'),
        moveClipToRow,
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>(['clip-1']) },
        additiveSelectionRef: { current: true },
        applyEdit,
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(clip, { button: 0, pointerId: 31, pointerType: 'touch', clientX: 24, clientY: 12 });
      });
      act(() => {
        fireEvent.pointerMove(window, { pointerId: 31, pointerType: 'touch', clientX: 40, clientY: 12 });
      });
      expect(result.current.isDragging).toBe(true);

      act(() => {
        fireEvent.pointerDown(wrapper, { button: 0, pointerId: 32, pointerType: 'touch', clientX: 90, clientY: 12 });
      });
      expect(result.current.isDragging).toBe(false);
      expect(interactionStateRef.current.drag).toBe(false);
      expect(setGestureOwner).toHaveBeenLastCalledWith('none');

      // The first finger keeps moving and lifts: nothing is dragged or committed any more.
      act(() => {
        fireEvent.pointerMove(window, { pointerId: 31, pointerType: 'touch', clientX: 10, clientY: 12 });
        fireEvent.pointerUp(window, { pointerId: 31, pointerType: 'touch', clientX: 10, clientY: 12 });
      });
      expect(result.current.isDragging).toBe(false);
      expect(moveClipToRow).not.toHaveBeenCalled();
      expect(applyEdit).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('commits a config edit when a free multi-clip drag drops onto a new bottom track', () => {

    const applyEdit = vi.fn();
    const selectClips = vi.fn();
    const coordinator = makeCoordinator({
      time: 3,
      rowIndex: 2,
      trackId: undefined,
      trackName: '',
      isNewTrack: true,
      isNewTrackTop: false,
      newTrackKind: 'visual',
      screenCoords: {
        rowTop: 96,
        rowLeft: 0,
        rowWidth: 400,
        rowHeight: 48,
        clipLeft: 300,
        clipWidth: 120,
        ghostCenter: 360,
      },
    });
    const { clip, wrapper, cleanup } = setupDom('clip-2', 'V2');
    const timelineWrapperRef = { current: wrapper };
    const dataRef = { current: makeMultiClipData() };

    try {
      renderClipDrag({
        timelineWrapperRef,
        dataRef,

        deviceClass: 'desktop',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips,
        selectedClipIdsRef: { current: new Set<string>(['clip-1', 'clip-2']) },
        additiveSelectionRef: { current: true },
        applyEdit,
        coordinator,
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(clip, {
          button: 0,
          pointerId: 3,
          clientX: 24,
          clientY: 60,
        });
      });

      act(() => {
        fireEvent.pointerMove(window, {
          pointerId: 3,
          clientX: 124,
          clientY: 80,
        });
      });

      act(() => {
        fireEvent.pointerUp(window, {
          pointerId: 3,
          clientX: 124,
          clientY: 80,
        });
      });

      expect(applyEdit).toHaveBeenCalledTimes(1);
      const [edit, options] = applyEdit.mock.calls[0];
      expect(edit.type).toBe('config');
      expect(options).toMatchObject({ transactionId: expect.any(String) });
      expect(edit.resolvedConfig.tracks.map((track: TrackDefinition) => track.id)).toEqual(['V1', 'V2', 'V3']);
      expect(edit.resolvedConfig.clips).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'clip-1', track: 'V2', at: 1, hold: 2 }),
        expect.objectContaining({ id: 'clip-2', track: 'V3', at: 3, hold: 2 }),
      ]));
      expect(edit.pinnedShotGroupsOverride).toBeUndefined();
      expect(selectionMocks.userSelectTimelineClips).toHaveBeenCalledWith(['clip-2', 'clip-1'], { additive: false });
      expect(coordinator.showSecondaryGhosts).toHaveBeenCalled();

    } finally {
      cleanup();
    }
  });

  it('drags only the clicked clip when a stale multi-selection was not built additively', () => {

    const { clip, wrapper, cleanup } = setupDom('clip-2', 'V2');
    const timelineWrapperRef = { current: wrapper };
    const dataRef = { current: makeMultiClipData() };

    try {
      const { result } = renderClipDrag({
        timelineWrapperRef,
        dataRef,

        deviceClass: 'desktop',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>(['clip-1', 'clip-2']) },
        additiveSelectionRef: { current: false },
        applyEdit: vi.fn(),
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(clip, {
          button: 0,
          pointerId: 10,
          clientX: 24,
          clientY: 60,
        });
      });

      expect(result.current.dragSessionRef.current?.clipId).toBe('clip-2');
      expect(result.current.dragSessionRef.current?.draggedClipIds).toEqual(['clip-2']);
      expect(result.current.dragSessionRef.current?.groupDragEntry).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('records a group drag entry when pointerdown starts on a pinned-group member', () => {

    const { clip, wrapper, cleanup } = setupDom('clip-1', 'V1');
    const timelineWrapperRef = { current: wrapper };
    const dataRef = { current: makePinnedGroupData() };

    try {
      const { result } = renderClipDrag({
        timelineWrapperRef,
        dataRef,

        deviceClass: 'desktop',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>() },
        additiveSelectionRef: { current: false },
        applyEdit: vi.fn(),
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(clip, {
          button: 0,
          pointerId: 4,
          clientX: 24,
          clientY: 12,
        });
      });

      expect(result.current.dragSessionRef.current?.draggedClipIds).toEqual(['clip-1', 'clip-2']);
      expect(result.current.dragSessionRef.current?.groupDragEntry).toEqual({
        groupKey: {
          shotId: 'shot-1',
          trackId: 'V1',
        },
        originStart: 0,
        originTrackId: 'V1',
      });
    } finally {
      cleanup();
    }
  });

  it('drags only the clicked pinned group when a stale multi-selection was not built additively', () => {

    const { label, wrapper, cleanup } = setupPinnedGroupLabelDom('clip-1', 'V1');
    const timelineWrapperRef = { current: wrapper };
    const dataRef = { current: makePinnedGroupDataWithExtraSelection() };

    try {
      const { result } = renderClipDrag({
        timelineWrapperRef,
        dataRef,

        deviceClass: 'desktop',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>(['clip-1', 'clip-2', 'clip-3']) },
        additiveSelectionRef: { current: false },
        applyEdit: vi.fn(),
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(label, {
          button: 0,
          pointerId: 11,
          clientX: 24,
          clientY: -9,
        });
      });

      expect(result.current.dragSessionRef.current?.clipId).toBe('clip-1');
      expect(result.current.dragSessionRef.current?.draggedClipIds).toEqual(['clip-1', 'clip-2']);
      expect(result.current.dragSessionRef.current?.groupDragEntry).toEqual({
        groupKey: {
          shotId: 'shot-1',
          trackId: 'V1',
        },
        originStart: 0,
        originTrackId: 'V1',
      });
    } finally {
      cleanup();
    }
  });

  it('records a group drag entry when pointerdown starts on a pinned-group label', () => {

    const { label, wrapper, cleanup } = setupPinnedGroupLabelDom('clip-1', 'V1');
    const timelineWrapperRef = { current: wrapper };
    const dataRef = { current: makePinnedGroupData() };

    try {
      const { result } = renderClipDrag({
        timelineWrapperRef,
        dataRef,

        deviceClass: 'desktop',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>() },
        additiveSelectionRef: { current: false },
        applyEdit: vi.fn(),
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(label, {
          button: 0,
          pointerId: 7,
          clientX: 24,
          clientY: -9,
        });
      });

      expect(result.current.dragSessionRef.current?.clipId).toBe('clip-1');
      expect(result.current.dragSessionRef.current?.draggedClipIds).toEqual(['clip-1', 'clip-2']);
      expect(result.current.dragSessionRef.current?.groupDragEntry).toEqual({
        groupKey: {
          shotId: 'shot-1',
          trackId: 'V1',
        },
        originStart: 0,
        originTrackId: 'V1',
      });
    } finally {
      cleanup();
    }
  });

  it('adjusts label-start drags downward into the associated clip row before updating the coordinator', () => {

    const coordinator = makeCoordinator();
    const { label, wrapper, cleanup } = setupPinnedGroupLabelDom('clip-1', 'V1');
    const timelineWrapperRef = { current: wrapper };
    const dataRef = { current: makePinnedGroupData() };

    try {
      renderClipDrag({
        timelineWrapperRef,
        dataRef,

        deviceClass: 'desktop',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>() },
        additiveSelectionRef: { current: false },
        applyEdit: vi.fn(),
        coordinator,
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(label, {
          button: 0,
          pointerId: 8,
          clientX: 24,
          clientY: -9,
        });
      });

      act(() => {
        fireEvent.pointerMove(window, {
          pointerId: 8,
          clientX: 32,
          clientY: -5,
        });
      });

      expect(coordinator.update).toHaveBeenCalledWith(expect.objectContaining({
        clientX: 32,
        clientY: 13,
      }));
    } finally {
      cleanup();
    }
  });

  it('updates pinnedShotGroupsOverride when a pinned group is dragged across tracks', () => {

    const applyEdit = vi.fn();
    const selectClips = vi.fn();
    const coordinator = makeCoordinator({
      time: 1,
      rowIndex: 1,
      trackId: 'V2',
      trackName: 'V2',
      screenCoords: {
        rowTop: 48,
        rowLeft: 0,
        rowWidth: 400,
        rowHeight: 48,
        clipLeft: 100,
        clipWidth: 120,
        ghostCenter: 160,
      },
    });
    const { clip, wrapper, cleanup } = setupDom('clip-1', 'V1');
    const timelineWrapperRef = { current: wrapper };
    const dataRef = { current: makePinnedGroupData() };

    try {
      renderClipDrag({
        timelineWrapperRef,
        dataRef,

        deviceClass: 'desktop',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips,
        selectedClipIdsRef: { current: new Set<string>() },
        additiveSelectionRef: { current: false },
        applyEdit,
        coordinator,
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(clip, {
          button: 0,
          pointerId: 5,
          clientX: 24,
          clientY: 12,
        });
      });

      act(() => {
        fireEvent.pointerMove(window, {
          pointerId: 5,
          clientX: 124,
          clientY: 32,
        });
      });

      act(() => {
        fireEvent.pointerUp(window, {
          pointerId: 5,
          clientX: 124,
          clientY: 32,
        });
      });

      expect(applyEdit).toHaveBeenCalledTimes(1);
      const [edit, options] = applyEdit.mock.calls[0];
      expect(edit).toEqual({
        type: 'rows',
        rows: [
          { id: 'V1', actions: [] },
          {
            id: 'V2',
            actions: [
              { id: 'clip-1', start: 1, end: 3, effectId: 'effect-clip-1' },
              { id: 'clip-2', start: 3, end: 5, effectId: 'effect-clip-2' },
            ],
          },
        ],
        metaUpdates: {
          'clip-1': { track: 'V2' },
          'clip-2': { track: 'V2' },
        },
        clipOrderOverride: { V1: [], V2: ['clip-1', 'clip-2'] },
        pinnedShotGroupsOverride: [expect.objectContaining({
          shotId: 'shot-1',
          trackId: 'V2',
          clipIds: ['clip-1', 'clip-2'],
          mode: 'images',
        })],
      });
      expect(edit.pinnedShotGroupsOverride).toEqual([expect.objectContaining({
        shotId: 'shot-1',
        trackId: 'V2',
        clipIds: ['clip-1', 'clip-2'],
        mode: 'images',
      })]);
      expect(options).toMatchObject({ transactionId: expect.any(String) });
      expect(selectionMocks.userSelectTimelineClips).toHaveBeenCalledWith(['clip-1', 'clip-2'], { additive: false });
    } finally {
      cleanup();
    }
  });

  it('updates pinnedShotGroupsOverride when a pinned group is dragged onto a new track', () => {

    const applyEdit = vi.fn();
    const coordinator = makeCoordinator({
      time: 3,
      rowIndex: 2,
      trackId: undefined,
      trackName: '',
      isNewTrack: true,
      isNewTrackTop: false,
      newTrackKind: 'visual',
      screenCoords: {
        rowTop: 96,
        rowLeft: 0,
        rowWidth: 400,
        rowHeight: 48,
        clipLeft: 300,
        clipWidth: 120,
        ghostCenter: 360,
      },
    });
    const { clip, wrapper, cleanup } = setupDom('clip-1', 'V1');
    const timelineWrapperRef = { current: wrapper };
    const dataRef = { current: makePinnedGroupData() };

    try {
      renderClipDrag({
        timelineWrapperRef,
        dataRef,

        deviceClass: 'desktop',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        moveClipToRow: vi.fn(),
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>() },
        additiveSelectionRef: { current: false },
        applyEdit,
        coordinator,
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(clip, {
          button: 0,
          pointerId: 6,
          clientX: 24,
          clientY: 12,
        });
      });

      act(() => {
        fireEvent.pointerMove(window, {
          pointerId: 6,
          clientX: 124,
          clientY: 32,
        });
      });

      act(() => {
        fireEvent.pointerUp(window, {
          pointerId: 6,
          clientX: 124,
          clientY: 32,
        });
      });

      expect(applyEdit).toHaveBeenCalledTimes(1);
      const [edit] = applyEdit.mock.calls[0];
      expect(edit.type).toBe('config');
      expect(edit.pinnedShotGroupsOverride).toEqual([expect.objectContaining({
        shotId: 'shot-1',
        trackId: 'V3',
        clipIds: ['clip-1', 'clip-2'],
        mode: 'images',
      })]);
    } finally {
      cleanup();
    }
  });

  it('starts a drag from a pointerdown on an SVG path inside a clip and commits it', () => {
    const interactionStateRef = { current: createInteractionState() };
    const moveClipToRow = vi.fn();
    const setGestureOwner = vi.fn();
    const { clip, wrapper, cleanup } = setupDom();
    const timelineWrapperRef = { current: wrapper };
    const dataRef = { current: makeData() };
    const svgPath = createSvgPath(clip);

    try {
      renderClipDrag({
        timelineWrapperRef,
        dataRef,
        interactionStateRef,
        deviceClass: 'desktop',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner,
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        moveClipToRow,
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>() },
        additiveSelectionRef: { current: false },
        applyEdit: vi.fn(),
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(svgPath, {
          button: 0,
          pointerId: 21,
          clientX: 24,
          clientY: 12,
        });
      });

      act(() => {
        fireEvent.pointerMove(window, {
          pointerId: 21,
          clientX: 40,
          clientY: 12,
        });
      });

      expect(interactionStateRef.current.drag).toBe(true);
      expect(setGestureOwner).toHaveBeenCalledWith('clip');

      act(() => {
        fireEvent.pointerUp(window, {
          pointerId: 21,
          clientX: 40,
          clientY: 12,
        });
      });

      expect(interactionStateRef.current.drag).toBe(false);
      expect(moveClipToRow).toHaveBeenCalledTimes(1);
      expect(moveClipToRow).toHaveBeenCalledWith('clip-1', 'V1', expect.any(Number), expect.any(String));
    } finally {
      cleanup();
    }
  });

  it('does not start a drag from an SVG path inside a button or a no-drag element', () => {
    const interactionStateRef = { current: createInteractionState() };
    const moveClipToRow = vi.fn();
    const { clip, wrapper, cleanup } = setupDom();
    const timelineWrapperRef = { current: wrapper };
    const dataRef = { current: makeData() };

    const button = document.createElement('button');
    clip.appendChild(button);
    const buttonPath = createSvgPath(button);

    const noDragSlot = document.createElement('div');
    noDragSlot.dataset.noClipDrag = 'true';
    clip.appendChild(noDragSlot);
    const noDragPath = createSvgPath(noDragSlot);

    try {
      renderClipDrag({
        timelineWrapperRef,
        dataRef,
        interactionStateRef,
        deviceClass: 'desktop',
        interactionMode: 'select',
        gestureOwner: 'none',
        setGestureOwner: vi.fn(),
        setInputModalityFromPointerType: vi.fn(() => 'mouse'),
        moveClipToRow,
        createTrackAndMoveClip: vi.fn(),
        selectClip: vi.fn(),
        selectClips: vi.fn(),
        selectedClipIdsRef: { current: new Set<string>() },
        additiveSelectionRef: { current: false },
        applyEdit: vi.fn(),
        coordinator: makeCoordinator(),
        scale: 1,
        scaleWidth: 100,
      });

      act(() => {
        fireEvent.pointerDown(buttonPath, {
          button: 0,
          pointerId: 22,
          clientX: 24,
          clientY: 12,
        });
      });
      act(() => {
        fireEvent.pointerMove(window, {
          pointerId: 22,
          clientX: 40,
          clientY: 12,
        });
      });
      act(() => {
        fireEvent.pointerUp(window, {
          pointerId: 22,
          clientX: 40,
          clientY: 12,
        });
      });

      expect(interactionStateRef.current.drag).toBe(false);

      act(() => {
        fireEvent.pointerDown(noDragPath, {
          button: 0,
          pointerId: 23,
          clientX: 24,
          clientY: 12,
        });
      });
      act(() => {
        fireEvent.pointerMove(window, {
          pointerId: 23,
          clientX: 40,
          clientY: 12,
        });
      });
      act(() => {
        fireEvent.pointerUp(window, {
          pointerId: 23,
          clientX: 40,
          clientY: 12,
        });
      });

      expect(interactionStateRef.current.drag).toBe(false);
      expect(moveClipToRow).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});

it.each(['data_lane_target', 'timeline_layout_unavailable'])('rejects %s before any single/group clip mutation fallback', reason => {
  const callbacks = { applyEdit: vi.fn(), applyResolvedClipMove: vi.fn(), moveClipToRow: vi.fn(), createTrackAndMoveClip: vi.fn() };
  const args = { session: {}, nextStart: 5, dropPosition: { isReject: true, plan: { rejectReason: reason } }, crossTrackActive: true,
    liveData: null, callbacks, lastPlan: null } as unknown as Parameters<typeof commitDraggingSession>[0];
  expect(commitDraggingSession(args)).toEqual({ deferDeactivate: false });
  Object.values(callbacks).forEach(callback => expect(callback).not.toHaveBeenCalled());
});


it('does not drag the media subset of a mixed selected set', () => {
  const { clip, wrapper, cleanup } = setupDom();
  const coordinator = makeCoordinator();
  const applyEdit = vi.fn();
  const dataRef = { current: makeData() };
  const before = JSON.stringify(dataRef.current);
  userSelectTimelineItems({ clipIds: ['clip-1'], dataItems: [{ laneId: 'transcript', itemId: 'segment@clip-1' }] }, { additive: false });
  try {
    renderClipDrag({ timelineWrapperRef: { current: wrapper }, dataRef,
      deviceClass: 'desktop', interactionMode: 'select', gestureOwner: 'none',
      setGestureOwner: vi.fn(), setInputModalityFromPointerType: () => 'mouse',
      moveClipToRow: vi.fn(), createTrackAndMoveClip: vi.fn(), selectClip: vi.fn(), selectClips: vi.fn(),
      selectedClipIdsRef: { current: new Set(['clip-1']) }, additiveSelectionRef: { current: true },
      applyEdit, coordinator, scale: 1, scaleWidth: 100 });
    fireEvent.pointerDown(clip, { button: 0, pointerId: 99, clientX: 30, clientY: 80 });
    fireEvent.pointerMove(window, { pointerId: 99, clientX: 80, clientY: 85 });
    fireEvent.pointerUp(window, { pointerId: 99, clientX: 80, clientY: 85 });
    expect(coordinator.update).not.toHaveBeenCalled();
    expect(applyEdit).not.toHaveBeenCalled();
    expect(JSON.stringify(dataRef.current)).toBe(before);
  } finally { cleanup(); }
});

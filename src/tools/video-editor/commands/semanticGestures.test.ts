// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createTimelineStore } from '../hooks/timelineStore.ts';
import { createTimelineCommands } from '../hooks/useTimelineCommandsService.ts';
import { buildPendingDragSession, commitDraggingSession } from '../hooks/useClipDrag.helpers.ts';
import { compileTimelinePatch } from '../lib/timeline-patch.ts';
import { buildTimelineCommandData } from './timelineData.ts';
import {
  captureClipTrimEdit,
  type ClipTrimCapturePort,
} from './clipTrimGesture.ts';
import {
  captureClipMove,
  submitClipMove,
  type ClipMoveCapturePort,
  type ClipMoveProposal,
} from './semanticGestures.ts';

function data() {
  return buildTimelineCommandData({
    output: { resolution: '1920x1080', fps: 30, file: 'test.mp4' },
    tracks: [{ id: 'picture', kind: 'visual' }, { id: 'other', kind: 'visual' }],
    clips: [{ id: 'c', track: 'picture', at: 2, from: 10, to: 14, speed: 2, clipType: 'media' }],
  }, { assets: {} });
}

// Adapter-only claims. These are deliberately not a substitute for Agent's
// Python/TS fixtures or proof that framework capture produces these claims.
function proposal(at: number): ClipMoveProposal {
  return {
    schema_version: 1, op: 'clip.move', version: '1', select: 'parent/clip:c', args: { on: at },
    resolved: ['parent/clip:c'], created: [], bindings: { old: 'cut:old:start' },
    expect: { at: { state: 'present', value: at }, 'app.on': { state: 'present', value: null } },
    authorship: { at: 'direct', 'app.on': 'direct' },
    reads: [{ ref: 'parent/clip:c', path: ['speed'], state: { state: 'present', value: 2 } }],
    selections: [{ key: 'move.target', query_version: 1, owner: 'parent', members: ['parent/clip:c'],
      order: ['parent/clip:c'], boundaries: ['parent/clip:c'], policy: 'guard-membership' }],
    intent: { ripple: 'none', anchor: 'fixed', ownership: 'occurrence', position: 'absolute' },
  };
}

function host() {
  let current = data();
  const port: ClipMoveCapturePort = {
    capture: vi.fn(({ current }) => ({ command: proposal(current.config.clips[0].at) })),
    finish: vi.fn((basis, on) => ({
      command: { ...basis.command as ClipMoveProposal, args: { on } }, previewAt: on,
    })),
    submit: vi.fn(({ preview }) => {
      const result = compileTimelinePatch(preview, current);
      expect(result.valid).toBe(true);
      expect(result.nextData).not.toBeNull();
      current = result.nextData!;
      store.getState().data.dataRef.current = current;
    }),
  };
  const store = createTimelineStore();
  const initial = store.getState();
  const applyEdit = vi.fn();
  initial.syncSlices({
    data: { ...initial.data, dataRef: { current } },
    ops: { ...initial.ops, applyEdit, clipMove: port },
  });
  return { port, store, applyEdit, commands: createTimelineCommands(store), current: () => current };
}

function trimHost() {
  const current = buildTimelineCommandData({
    output: { resolution: '1920x1080', fps: 30, file: 'test.mp4' },
    tracks: [{ id: 'picture', kind: 'visual' }],
    clips: [{ id: 'c', track: 'picture', at: 2, from: 10, to: 14, speed: 2, clipType: 'media' }],
  }, { assets: { source: { duration: 20, type: 'video' } } });
  current.config.clips[0].asset = 'source';
  current.resolvedConfig.clips[0].asset = 'source';
  current.resolvedConfig.clips[0].assetEntry = { duration: 20, type: 'video', src: 'source.mp4' };
  const port: ClipTrimCapturePort = {
    capture: vi.fn(() => ({ original: { from: 10, to: 14, hold: 4 } })),
    finish: vi.fn((_basis, args) => ({
      command: {
        schema_version: 1, op: 'clip.trim', version: '1', select: 'parent/clip:c',
        args: { in_s: args.in_s ?? null, out_s: args.out_s ?? null },
      },
      preview: {
        version: 1, source: 'clip.trim', operations: [{
          op: 'clip.update', target: 'c', payload: { from: 10, to: args.out_s ?? 14, hold: (args.out_s ?? 14) - 10 },
        }],
      },
    })),
    submit: vi.fn(),
  };
  const store = createTimelineStore();
  const initial = store.getState();
  const applyEdit = vi.fn();
  initial.syncSlices({
    data: { ...initial.data, dataRef: { current } },
    ops: { ...initial.ops, applyEdit, clipTrim: port },
  });
  return { port, store, applyEdit, commands: createTimelineCommands(store), current: () => current };
}

describe('clip.move gesture adapters', () => {
  // U3's upstream editor retired direct clip.move/clip.trim service wiring.
  // The positive cases below exercise the mounted A2 callback; the adapter
  // guard cases remain direct so their refusal contract is still protected.
  it('current service routes moves through the mounted editor mutation callback', () => {
    const h = host();
    expect(h.commands.moveClip({ clipId: 'c', time: 5 })).toEqual({
      ok: true, data: { clipId: 'c', trackId: 'picture', time: 5 },
    });
    expect(h.commands.moveClip({ clipId: 'c', time: 7 }).ok).toBe(true);
    expect(h.port.submit).not.toHaveBeenCalled();
    expect(h.applyEdit).toHaveBeenCalledTimes(2);
    expect(h.applyEdit.mock.calls[0][0]).toMatchObject({
      type: 'config', resolvedConfig: { clips: [{ id: 'c', at: 5 }] },
    });
    expect(h.applyEdit.mock.calls[1][0]).toMatchObject({
      type: 'config', resolvedConfig: { clips: [{ id: 'c', at: 7 }] },
    });
  });

  it('routes a resolved same-track drag through applyResolvedClipMove', () => {
    const h = host();
    const clipTarget = document.createElement('div');
    const { session } = buildPendingDragSession({
      clipId: 'c', rowId: 'picture', sourceKind: 'visual',
      sourceAction: { id: 'c', start: 2, end: 4, effectId: 'effect-c' },
      current: h.current(), clipTarget, labelTarget: null,
      event: { pointerId: 1, clientX: 0, clientY: 0, ctrlKey: false, metaKey: false } as PointerEvent,
      selectedClipIds: new Set(), additiveSelection: false, dragAllowed: true,
      inputModality: 'mouse', pixelsPerSecond: 100,
    });
    session.plannedData = h.current();
    const applyResolvedClipMove = vi.fn();
    const callbacks = {
      moveClipToRow: vi.fn(),
      createTrackAndMoveClip: vi.fn(),
      selectClip: vi.fn(),
      selectClips: vi.fn(),
      applyEdit: h.applyEdit,
      applyResolvedClipMove,
    };
    const result = commitDraggingSession({
      session,
      nextStart: 7,
      dropPosition: null,
      crossTrackActive: false,
      liveData: h.current(),
      lastPlan: {
        valid: true,
        rejectReason: null,
        requestedTrackId: 'picture',
        targetTrackId: 'picture',
        resolvedStart: 7,
        needsNewTrack: false,
      } as Parameters<typeof commitDraggingSession>[0]['lastPlan'],
      callbacks,
    });
    expect(result).toEqual({ deferDeactivate: false });
    expect(applyResolvedClipMove).toHaveBeenCalledWith(
      'c', 'picture', 'picture', 7, false, session.transactionId, expect.anything(),
    );
    expect(callbacks.moveClipToRow).not.toHaveBeenCalled();
    expect(h.port.submit).not.toHaveBeenCalled();
  });

  it('does not discard a same-value move in the current service', () => {
    const h = host();
    expect(h.commands.moveClip({ clipId: 'c', time: 2 }).ok).toBe(true);
    expect(h.applyEdit).toHaveBeenCalledTimes(1);
    expect(h.port.submit).not.toHaveBeenCalled();
  });

  it('keeps adapter target time separate from preview quantization', () => {
    const h = host();
    vi.mocked(h.port.finish).mockImplementation((basis, on) => ({
      command: { ...basis.command as ClipMoveProposal, args: { on } }, previewAt: 5,
    }));
    const captured = captureClipMove(h.port, h.current(), 'c');
    submitClipMove(captured, 5.001);
    expect(vi.mocked(h.port.submit).mock.calls[0][0]).toMatchObject({
      command: { args: { on: 5.001 } }, preview: { operations: [{ payload: { at: 5 } }] },
    });
  });

  it('refuses absent capture without applying a patch-only move', () => {
    const h = host();
    expect(() => captureClipMove(undefined, h.current(), 'c')).toThrow('clip.move capture is unavailable.');
    expect(h.applyEdit).not.toHaveBeenCalled();
    expect(h.current().config.clips[0].at).toBe(2);
  });

  it.each([-1, Infinity, NaN])('refuses invalid absolute time %s without normalization', (time) => {
    const h = host();
    const captured = captureClipMove(h.port, h.current(), 'c');
    expect(() => submitClipMove(captured, time)).toThrow('nonnegative absolute time');
    expect(h.port.finish).not.toHaveBeenCalled();
    expect(h.port.submit).not.toHaveBeenCalled();
    expect(h.applyEdit).not.toHaveBeenCalled();
  });

  it('refuses cross-track moves before finishing or submitting', () => {
    const h = host();
    const captured = captureClipMove(h.port, h.current(), 'c');
    expect(() => submitClipMove(captured, 5, { trackId: 'other' })).toThrow(
      'clip.move v1 does not support cross-track moves.',
    );
    expect(h.port.finish).not.toHaveBeenCalled();
    expect(h.port.submit).not.toHaveBeenCalled();
    expect(h.applyEdit).not.toHaveBeenCalled();
  });

  it.each(['source', 'map', 'owner', 'selection', 'boundary'])('retains a host %s refusal without fallback', (kind) => {
    const h = host();
    const captured = captureClipMove(h.port, h.current(), 'c');
    vi.mocked(h.port.finish).mockImplementation(() => { throw new Error(`Unsupported ${kind}`); });
    expect(() => submitClipMove(captured, 5)).toThrow(`Unsupported ${kind}`);
    expect(h.port.submit).not.toHaveBeenCalled();
    expect(h.applyEdit).not.toHaveBeenCalled();
  });

  it('refuses ambiguous display IDs before capture', () => {
    const h = host();
    h.current().resolvedConfig.clips.push({ ...h.current().resolvedConfig.clips[0] });
    expect(() => captureClipMove(h.port, h.current(), 'c')).toThrow('unambiguous');
    expect(h.port.capture).not.toHaveBeenCalled();
  });

  it('refuses projection fallback IDs before capture', () => {
    const h = host();
    h.current().resolvedConfig.clips[0].app = {
      canonical: { occurrenceId: 'o', rawClipId: null, clipRef: null },
    };
    expect(() => captureClipMove(h.port, h.current(), 'c')).toThrow(
      'clip.move requires an addressable raw clip identity.',
    );
    expect(h.port.capture).not.toHaveBeenCalled();
    expect(h.port.submit).not.toHaveBeenCalled();
  });

  it('propagates local outbox refusal and never invokes applyEdit', () => {
    const h = host();
    const captured = captureClipMove(h.port, h.current(), 'c');
    vi.mocked(h.port.submit).mockImplementation(() => { throw new Error('Outbox unavailable'); });
    expect(() => submitClipMove(captured, 5)).toThrow('Outbox unavailable');
    expect(h.applyEdit).not.toHaveBeenCalled();
    expect(h.current().config.clips[0].at).toBe(2);
  });

  it('does not allow the capture implementation to substitute a different operation or target time', () => {
    const h = host();
    const captured = captureClipMove(h.port, h.current(), 'c');
    vi.mocked(h.port.finish).mockReturnValue({ command: proposal(99), previewAt: 7 });
    expect(() => submitClipMove(captured, 7)).toThrow('Unsupported clip.move');
    expect(h.port.submit).not.toHaveBeenCalled();
  });

  it.each(['sibling-start', 'sibling-end', 'hard-duration-end'] as const)(
    'routes a resolved %s snap through the current editor callback', (snapEdgeType) => {
      const h = host();
      const session = {
        clipId: 'c', draggedClipIds: ['c'], groupDragEntry: null,
        sourceRowId: 'picture', sourceKind: 'visual', transactionId: 'txn',
      } as Parameters<typeof commitDraggingSession>[0]['session'];
      const applyResolvedClipMove = vi.fn();
      const lastPlan = {
        valid: true, rejectReason: null, snapped: true, snapEdgeType,
        requestedTrackId: 'picture', targetTrackId: 'picture', resolvedStart: 7, needsNewTrack: false,
      } as NonNullable<Parameters<typeof commitDraggingSession>[0]['lastPlan']>;
      expect(commitDraggingSession({
        session,
        nextStart: 7,
        dropPosition: null,
        crossTrackActive: false,
        liveData: h.current(),
        lastPlan,
        callbacks: {
          moveClipToRow: vi.fn(),
          createTrackAndMoveClip: vi.fn(),
          selectClip: vi.fn(),
          selectClips: vi.fn(),
          applyEdit: h.applyEdit,
          applyResolvedClipMove,
        },
      })).toEqual({ deferDeactivate: false });
      expect(applyResolvedClipMove).toHaveBeenCalledWith(
        'c', 'picture', 'picture', 7, false, 'txn',
      );
      expect(h.port.submit).not.toHaveBeenCalled();
    },
  );
});

describe('public trim command adapter', () => {
  it('routes a source-only parent trim through the current editor mutation callback', () => {
    const h = trimHost();

    expect(h.commands.trimClip({ clipId: 'c', endTime: 3.5 })).toEqual({
      ok: true, data: { clipId: 'c', startTime: 2, endTime: 3.5 },
    });
    expect(h.port.capture).not.toHaveBeenCalled();
    expect(h.port.finish).not.toHaveBeenCalled();
    expect(h.port.submit).not.toHaveBeenCalled();
    expect(h.applyEdit).toHaveBeenCalledOnce();
  });

  it('retains the snapshot path for placement-plus-trim', () => {
    const h = trimHost();

    expect(h.commands.trimClip({ clipId: 'c', startTime: 3, endTime: 3.5 })).toEqual({
      ok: true, data: { clipId: 'c', startTime: 3, endTime: 3.5 },
    });
    expect(h.port.capture).not.toHaveBeenCalled();
    expect(h.port.submit).not.toHaveBeenCalled();
    expect(h.applyEdit).toHaveBeenCalledOnce();
  });

  it('refuses a native owner rejection without applying a snapshot fallback', () => {
    const h = trimHost();
    vi.mocked(h.port.capture).mockImplementation(() => { throw new Error('unsupported owner'); });

    expect(() => captureClipTrimEdit(h.port, h.current(), 'c')).toThrow('unsupported owner');
    expect(h.port.submit).not.toHaveBeenCalled();
    expect(h.applyEdit).not.toHaveBeenCalled();
    expect(h.current().config.clips[0]).toMatchObject({ at: 2, from: 10, to: 14 });
  });

  it('refuses an absent native port without applying a snapshot fallback', () => {
    const h = trimHost();
    expect(() => captureClipTrimEdit(undefined, h.current(), 'c')).toThrow('clip.trim capture is unavailable.');
    expect(h.applyEdit).not.toHaveBeenCalled();
    expect(h.current().config.clips[0]).toMatchObject({ at: 2, from: 10, to: 14 });
  });
});

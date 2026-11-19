// @vitest-environment jsdom
//
// Undo/redo across remote-data boundaries.
//
// History entries are full snapshots. When server-authoritative data replaces
// local state (accepted poll, conflict reload) every stacked snapshot predates
// that boundary: restoring one would revert the remote client's persisted work
// and save the result — silent multi-client data loss while both UIs read
// "saved". These tests mount the real commit + history (+ persistence) pair
// wired over the event bus exactly as useTimelineState wires them, and pin the
// boundary semantics: accepted remote data invalidates the undo/redo stacks.
//
// They also pin the undo/upload interaction: restores must not delete the
// transient `uploading-*` skeleton of an in-flight upload, and background
// pinned-group sync must not write user-visible undo entries.
import React, { useEffect } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shot } from '@/domains/generation/types';
import { __resetSelectionStoreForTests } from '@/shared/state/selectionStore';
import { VideoEditorRuntimeProvider } from '../contexts/VideoEditorRuntimeContext';
import type { DataProvider } from '../data/DataProvider';
import { getConfigSignature, getStableConfigSignature } from '../lib/config-utils';
import { createDefaultTimelineConfig } from '../lib/defaults';
import { createInteractionState, type InteractionStateRef } from '../lib/interaction-state';
import { configToRows, type ClipMeta, type TimelineData } from '../lib/timeline-data';
import type { AssetRegistry, TimelineConfig } from '../types';
import type { TimelineRow } from '../types/timeline-canvas';
import { usePinnedGroupSync } from './usePinnedShotGroups';
import { useTimelineCommit, type ApplyEditOptions } from './useTimelineCommit';
import { TimelineEventBus } from './useTimelineEventBus';
import { useTimelineHistory } from './useTimelineHistory';
import { useTimelinePersistence } from './useTimelinePersistence';
import type { UseAssetManagementResult } from './useAssetManagement';

type HoldClip = {
  id: string;
  at: number;
  track: string;
  clipType: 'hold';
  hold: number;
  asset?: string;
};

function makeConfig(clips: HoldClip[], pinnedShotGroups?: TimelineConfig['pinnedShotGroups']): TimelineConfig {
  const base = createDefaultTimelineConfig();
  return {
    ...base,
    tracks: (base.tracks ?? []).map((track) => ({ ...track })),
    clips,
    ...(pinnedShotGroups ? { pinnedShotGroups } : {}),
  };
}

function buildData(
  config: TimelineConfig,
  registry: AssetRegistry = { assets: {} },
  configVersion = 1,
): TimelineData {
  const rowData = configToRows(config);
  const resolvedRegistry = Object.fromEntries(
    Object.entries(registry.assets ?? {}).map(([assetId, entry]) => [assetId, { ...entry, src: entry.file }]),
  );
  const resolvedConfig = {
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((track) => ({ ...track })),
    clips: config.clips.map((clip) => ({
      ...clip,
      assetEntry: clip.asset ? resolvedRegistry[clip.asset] : undefined,
    })),
    registry: resolvedRegistry,
  };

  return {
    config,
    configVersion,
    registry,
    resolvedConfig,
    rows: rowData.rows,
    meta: rowData.meta,
    effects: rowData.effects,
    assetMap: Object.fromEntries(
      Object.entries(registry.assets ?? {}).map(([assetId, entry]) => [assetId, entry.file]),
    ),
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((track) => ({ ...track })),
    clipOrder: rowData.clipOrder,
    signature: getConfigSignature(resolvedConfig),
    stableSignature: getStableConfigSignature(config, registry),
  };
}

const POLL_ACCEPT_OPTIONS = { save: false, skipHistory: true, updateLastSavedSignature: true } as const;

function setupHarness(options: {
  provider?: Partial<DataProvider>;
  shots?: Shot[];
  registerGenerationAsset?: UseAssetManagementResult['registerGenerationAsset'];
} = {}) {
  const provider: DataProvider = {
    loadTimeline: vi.fn(async () => ({ config: makeConfig([]), configVersion: 1 })),
    saveTimeline: vi.fn(async () => 2),
    loadAssetRegistry: vi.fn(async () => ({ assets: {} })),
    resolveAssetUrl: vi.fn(async (file: string) => file),
    ...options.provider,
  };
  const eventBus = new TimelineEventBus();
  const lastSavedSignatureRef = { current: '' };
  const interactionStateRef: InteractionStateRef = { current: createInteractionState() };
  const editSeqAliasRef = { current: 0 };
  const savedSeqRef = { current: 0 };
  const configVersionRef = { current: 1 };
  const scheduleSaveCalls: TimelineData[] = [];
  eventBus.on('scheduleSave', (nextData) => {
    scheduleSaveCalls.push(nextData);
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(
    QueryClientProvider,
    { client: queryClient },
    React.createElement(
      VideoEditorRuntimeProvider,
      {
        value: {
          provider,
          project: { projectId: 'project-1' },
          toast: {
            error: vi.fn(() => 'toast-error'),
            success: vi.fn(() => 'toast-success'),
            warning: vi.fn(() => 'toast-warning'),
            info: vi.fn(() => 'toast-info'),
          },
          timelineId: 'timeline-1',
          userId: 'user-1',
          timelineName: 'Timeline 1',
        },
      },
      children,
    ),
  );

  const shots = options.shots;
  const registerGenerationAsset = options.registerGenerationAsset ?? vi.fn(() => undefined);

  const hook = renderHook(() => {
    const commit = useTimelineCommit({ eventBus, lastSavedSignatureRef });
    const history = useTimelineHistory({
      dataRef: commit.dataRef,
      commitData: commit.commitData,
      interactionStateRef,
      pendingOpsRef: commit.pendingOpsRef,
    });
    const persistence = useTimelinePersistence({
      provider,
      timelineId: 'timeline-1',
      eventBus,
      dataRef: commit.dataRef,
      commitData: commit.commitData,
      selectedClipIdRef: commit.selectedClipIdRef,
      selectedTrackIdRef: commit.selectedTrackIdRef,
      editSeqRef: editSeqAliasRef,
      savedSeqRef,
      configVersionRef,
      lastSavedSignatureRef,
      interactionStateRef,
    });
    usePinnedGroupSync({
      data: commit.data,
      dataRef: commit.dataRef,
      applyEdit: commit.applyEdit,
      shots,
      registerGenerationAsset,
      debounceMs: 25,
    });
    // Mirror useTimelineState's event wiring.
    useEffect(() => eventBus.on('beforeCommit', history.onBeforeCommit), [history.onBeforeCommit]);
    useEffect(() => eventBus.on('remoteCommit', history.onRemoteData), [history.onRemoteData]);
    return { commit, history, persistence };
  }, { wrapper });

  const seed = (data: TimelineData) => {
    act(() => {
      hook.result.current.commit.commitData(data, { save: false });
    });
  };

  const moveClip = (clipId: string, nextStart: number, editOptions: ApplyEditOptions = {}) => {
    act(() => {
      const current = hook.result.current.commit.dataRef.current;
      if (!current) {
        throw new Error('Harness has no data.');
      }
      const nextRows = current.rows.map((row) => ({
        ...row,
        actions: row.actions.map((action) => (action.id === clipId
          ? { ...action, start: nextStart, end: nextStart + (action.end - action.start) }
          : action)),
      }));
      hook.result.current.commit.applyEdit(
        {
          type: 'rows',
          rows: nextRows,
          metaUpdates: { [clipId]: { track: current.meta[clipId].track } },
        },
        editOptions,
      );
    });
  };

  return {
    ...hook,
    provider,
    scheduleSaveCalls,
    seed,
    moveClip,
    dataRef: () => hook.result.current.commit.dataRef,
  };
}

function clipAt(data: TimelineData | null, clipId: string): number | undefined {
  return data?.config.clips.find((clip) => clip.id === clipId)?.at;
}

function findAction(data: TimelineData | null, actionId: string) {
  for (const row of data?.rows ?? []) {
    const action = row.actions.find((candidate) => candidate.id === actionId);
    if (action) {
      return action;
    }
  }
  return undefined;
}

const CLIP_A: HoldClip = { id: 'clip-a', at: 0, track: 'V1', clipType: 'hold', hold: 2 };
const CLIP_B: HoldClip = { id: 'clip-b', at: 5, track: 'V1', clipType: 'hold', hold: 2 };

beforeEach(() => {
  vi.useRealTimers();
  __resetSelectionStoreForTests();
});

describe('undo across accepted remote polls', () => {
  it('does not revert or re-save the remote client work after an accepted poll', () => {
    const harness = setupHarness();
    harness.seed(buildData(makeConfig([CLIP_A, CLIP_B])));

    // Local user edit: move clip A. Creates one undo entry and schedules a save.
    harness.moveClip('clip-a', 1, { transactionId: 'move-a' });
    expect(clipAt(harness.dataRef().current, 'clip-a')).toBe(1);
    expect(harness.result.current.history.canUndo).toBe(true);

    // Poll acceptance: server has our saved A move plus a remote edit to B.
    // This is byte-for-byte the commit usePollSync issues on acceptance.
    const remoteData = buildData(
      makeConfig([{ ...CLIP_A, at: 1 }, { ...CLIP_B, at: 6 }]),
      { assets: {} },
      2,
    );
    act(() => {
      harness.result.current.commit.commitData(remoteData, POLL_ACCEPT_OPTIONS);
    });
    expect(clipAt(harness.dataRef().current, 'clip-b')).toBe(6);

    // The boundary invalidates history: undo may not resurrect the pre-poll
    // snapshot (which would revert B to 5 and save it).
    expect(harness.result.current.history.canUndo).toBe(false);
    const savesBeforeUndo = harness.scheduleSaveCalls.length;

    act(() => {
      harness.result.current.history.undo();
    });

    expect(clipAt(harness.dataRef().current, 'clip-b')).toBe(6);
    expect(clipAt(harness.dataRef().current, 'clip-a')).toBe(1);
    expect(harness.scheduleSaveCalls.length).toBe(savesBeforeUndo);
  });

  it('also clears the redo stack at the boundary', () => {
    const harness = setupHarness();
    harness.seed(buildData(makeConfig([CLIP_A, CLIP_B])));

    harness.moveClip('clip-a', 1, { transactionId: 'move-a' });
    act(() => {
      harness.result.current.history.undo();
    });
    expect(harness.result.current.history.canRedo).toBe(true);

    const remoteData = buildData(
      makeConfig([CLIP_A, { ...CLIP_B, at: 6 }]),
      { assets: {} },
      2,
    );
    act(() => {
      harness.result.current.commit.commitData(remoteData, POLL_ACCEPT_OPTIONS);
    });

    expect(harness.result.current.history.canRedo).toBe(false);
    act(() => {
      harness.result.current.history.redo();
    });
    expect(clipAt(harness.dataRef().current, 'clip-b')).toBe(6);
  });

  it('keeps the undo stack on signature-identical echoes (e.g. URL re-resolution refreshes)', () => {
    const harness = setupHarness();
    const initial = buildData(makeConfig([CLIP_A, CLIP_B]));
    harness.seed(initial);

    harness.moveClip('clip-a', 1, { transactionId: 'move-a' });

    // Same persisted content, only volatile fields differ — not a boundary.
    const current = harness.dataRef().current;
    if (!current) {
      throw new Error('Harness has no data.');
    }
    const echo = buildData(current.config, current.registry, current.configVersion);
    expect(echo.stableSignature).toBe(current.stableSignature);
    act(() => {
      harness.result.current.commit.commitData(echo, POLL_ACCEPT_OPTIONS);
    });

    expect(harness.result.current.history.canUndo).toBe(true);
    act(() => {
      harness.result.current.history.undo();
    });
    expect(clipAt(harness.dataRef().current, 'clip-a')).toBe(0);
  });

  it('starts a fresh undo entry for the first edit after a boundary instead of collapsing into a cleared stack', () => {
    const harness = setupHarness();
    harness.seed(buildData(makeConfig([CLIP_A, CLIP_B])));

    // Untransacted edit, then a boundary, then another untransacted edit within
    // the 300ms collapse window. The post-boundary edit must get its own entry
    // whose snapshot is the remote state — not merge into a deleted one.
    harness.moveClip('clip-a', 1);
    const remoteData = buildData(
      makeConfig([{ ...CLIP_A, at: 1 }, { ...CLIP_B, at: 6 }]),
      { assets: {} },
      2,
    );
    act(() => {
      harness.result.current.commit.commitData(remoteData, POLL_ACCEPT_OPTIONS);
    });
    harness.moveClip('clip-a', 2);

    expect(harness.result.current.history.canUndo).toBe(true);
    act(() => {
      harness.result.current.history.undo();
    });

    // Undo lands on the remote state (A back to 1, B keeps the remote 6).
    expect(clipAt(harness.dataRef().current, 'clip-a')).toBe(1);
    expect(clipAt(harness.dataRef().current, 'clip-b')).toBe(6);
  });
});

describe('undo across conflict reloads', () => {
  it('does not resurrect the config that just lost the conflict after reloadFromServer', async () => {
    const serverConfig = makeConfig([CLIP_A, { ...CLIP_B, at: 6 }]);
    const harness = setupHarness({
      provider: {
        loadTimeline: vi.fn(async () => ({ config: serverConfig, configVersion: 3 })),
      },
    });
    harness.seed(buildData(makeConfig([CLIP_A, CLIP_B])));

    harness.moveClip('clip-a', 1, { transactionId: 'move-a' });
    expect(harness.result.current.history.canUndo).toBe(true);

    await act(async () => {
      await harness.result.current.persistence.reloadFromServer();
    });
    expect(clipAt(harness.dataRef().current, 'clip-b')).toBe(6);

    expect(harness.result.current.history.canUndo).toBe(false);
    const savesBeforeUndo = harness.scheduleSaveCalls.length;
    act(() => {
      harness.result.current.history.undo();
    });

    // The losing local config (A moved, B at 5) must not come back or be saved.
    expect(clipAt(harness.dataRef().current, 'clip-a')).toBe(0);
    expect(clipAt(harness.dataRef().current, 'clip-b')).toBe(6);
    expect(harness.scheduleSaveCalls.length).toBe(savesBeforeUndo);
  });
});

describe('undo and in-flight uploads', () => {
  const SKELETON_ID = 'uploading-1234-test';
  const SKELETON_META: ClipMeta = {
    asset: 'uploading:drop.png',
    track: 'V1',
    clipType: 'hold',
    hold: 2,
  };

  function insertSkeleton(harness: ReturnType<typeof setupHarness>) {
    act(() => {
      const current = harness.dataRef().current;
      if (!current) {
        throw new Error('Harness has no data.');
      }
      const nextRows: TimelineRow[] = current.rows.map((row) => (row.id === 'V1'
        ? {
            ...row,
            actions: [...row.actions, {
              id: SKELETON_ID,
              start: 8,
              end: 10,
              effectId: `effect-${SKELETON_ID}`,
            }],
          }
        : row));
      harness.result.current.commit.applyEdit({
        type: 'rows',
        rows: nextRows,
        metaUpdates: { [SKELETON_ID]: SKELETON_META },
      }, { save: false });
    });
  }

  it('a single undo after a completed drop does not resurrect the uploading skeleton', () => {
    // Full external-drop sequence: skeleton insert (save:false, no history),
    // skeleton removal (save:true), dropAsset commit inside the 300ms collapse
    // window. History snapshots are config-derived and rowsToConfig drops
    // `uploading-*` actions, so the skeleton can never be snapshotted.
    const harness = setupHarness();
    harness.seed(buildData(makeConfig([CLIP_A])));

    insertSkeleton(harness);
    expect(findAction(harness.dataRef().current, SKELETON_ID)).toBeDefined();

    // Upload success: remove the skeleton…
    act(() => {
      const current = harness.dataRef().current;
      if (!current) {
        throw new Error('Harness has no data.');
      }
      harness.result.current.commit.applyEdit({
        type: 'rows',
        rows: current.rows.map((row) => ({
          ...row,
          actions: row.actions.filter((action) => action.id !== SKELETON_ID),
        })),
        metaDeletes: [SKELETON_ID],
      });
    });
    // …and land the real clip (collapses into the same undo entry).
    act(() => {
      const current = harness.dataRef().current;
      if (!current) {
        throw new Error('Harness has no data.');
      }
      harness.result.current.commit.applyEdit({
        type: 'rows',
        rows: current.rows.map((row) => (row.id === 'V1'
          ? {
              ...row,
              actions: [...row.actions, { id: 'clip-new', start: 8, end: 10, effectId: 'effect-clip-new' }],
            }
          : row)),
        metaUpdates: { 'clip-new': { track: 'V1', clipType: 'hold', hold: 2 } },
      });
    });
    expect(clipAt(harness.dataRef().current, 'clip-new')).toBe(8);

    act(() => {
      harness.result.current.history.undo();
    });

    const rows = harness.dataRef().current?.rows ?? [];
    const uploadingIds = rows.flatMap((row) => row.actions.filter((action) => action.id.startsWith('uploading-')));
    expect(uploadingIds).toHaveLength(0);
    expect(harness.dataRef().current?.meta[SKELETON_ID]).toBeUndefined();
    expect(clipAt(harness.dataRef().current, 'clip-new')).toBeUndefined();
    expect(clipAt(harness.dataRef().current, 'clip-a')).toBe(0);
  });

  it('undoing an unrelated edit while an upload is in flight preserves its skeleton', () => {
    const harness = setupHarness();
    harness.seed(buildData(makeConfig([CLIP_A])));

    // User edit first (undoable), then an upload starts.
    harness.moveClip('clip-a', 1, { transactionId: 'move-a' });
    insertSkeleton(harness);
    expect(findAction(harness.dataRef().current, SKELETON_ID)).toBeDefined();

    act(() => {
      harness.result.current.history.undo();
    });

    // The edit reverted, but the in-flight upload's placeholder survived.
    expect(clipAt(harness.dataRef().current, 'clip-a')).toBe(0);
    expect(findAction(harness.dataRef().current, SKELETON_ID)).toBeDefined();
    expect(harness.dataRef().current?.meta[SKELETON_ID]).toEqual(SKELETON_META);

    // Redo re-applies the edit and still keeps the skeleton.
    act(() => {
      harness.result.current.history.redo();
    });
    expect(clipAt(harness.dataRef().current, 'clip-a')).toBe(1);
    expect(findAction(harness.dataRef().current, SKELETON_ID)).toBeDefined();
  });
});

describe('pinned-group background sync and history', () => {
  it('repairs the group and saves without creating an undo entry', () => {
    vi.useFakeTimers();
    const registry: AssetRegistry = {
      assets: {
        'asset-1': { file: 'one.png', type: 'image/png', generationId: 'gen-1', variantId: 'variant-1' },
      },
    };
    const shots: Shot[] = [{
      id: 'shot-1',
      name: 'Shot 1',
      images: [
        { generation_id: 'gen-1', primary_variant_id: 'variant-1', imageUrl: 'https://example.com/one.png', type: 'image/png', timeline_frame: 0 },
        { generation_id: 'gen-2', primary_variant_id: 'variant-2', imageUrl: 'https://example.com/two.png', type: 'image/png', timeline_frame: 1 },
      ],
    } as Shot];
    const harness = setupHarness({
      shots,
      registerGenerationAsset: vi.fn(() => {
        const current = harness.dataRef().current;
        if (current) {
          current.registry.assets['asset-2'] = {
            file: 'https://example.com/two.png',
            type: 'image/png',
            generationId: 'gen-2',
            variantId: 'variant-2',
          };
        }
        return 'asset-2';
      }) as unknown as UseAssetManagementResult['registerGenerationAsset'],
    });

    harness.seed(buildData(
      makeConfig(
        [{ id: 'clip-1', at: 0, track: 'V1', clipType: 'hold', hold: 5, asset: 'asset-1' }],
        [{ shotId: 'shot-1', trackId: 'V1', clipIds: ['clip-1'], mode: 'images' }],
      ),
      registry,
    ));

    const savesBeforeSync = harness.scheduleSaveCalls.length;
    act(() => {
      vi.advanceTimersByTime(25);
    });

    // The repair applied and persisted…
    expect(harness.dataRef().current?.config.pinnedShotGroups?.[0]?.clipIds).toHaveLength(2);
    expect(harness.scheduleSaveCalls.length).toBeGreaterThan(savesBeforeSync);
    // …but is not a user edit: nothing to undo.
    expect(harness.result.current.history.canUndo).toBe(false);
    vi.useRealTimers();
  });
});

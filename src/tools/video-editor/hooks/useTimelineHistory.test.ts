// @vitest-environment jsdom
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoEditorRuntimeProvider } from '../contexts/VideoEditorRuntimeContext';
import type { DataProvider } from '../data/DataProvider';
import { getConfigSignature, getStableConfigSignature } from '../lib/config-utils';
import { createDefaultTimelineConfig } from '../lib/defaults';
import { createInteractionState } from '../lib/interaction-state';
import { buildDataFromCurrentRegistry } from '../lib/timeline-save-utils';
import { configToRows, type TimelineData } from '../lib/timeline-data';
import { useTimelineHistory } from './useTimelineHistory';
import type { TimelineLocalSaveHandoff } from './timelineLocalSaveHandoff';
import type { Checkpoint } from '../types/history';
import type { TimelineEditability } from '../lib/timeline-editability';

type CommitCall = {
  nextData: TimelineData;
  options?: {
    save?: boolean;
    selectedClipId?: string | null;
    selectedTrackId?: string | null;
    updateLastSavedSignature?: boolean;
    transactionId?: string;
    semantic?: boolean;
    skipHistory?: boolean;
    commandHistory?: unknown;
  };
};

const SESSION_IDLE_MS = 5 * 60 * 1000;

function makeConfig(step: number) {
  const base = createDefaultTimelineConfig();
  return {
    ...base,
    output: {
      ...base.output,
      file: `output-${step}.mp4`,
    },
    theme: '2rp',
    theme_overrides: { visual: { canvas: { fps: 24 } } },
    generation_defaults: { model: 'sequence-v1' },
    tracks: (base.tracks ?? []).map((track) => ({ ...track })),
    clips: step === 0
      ? []
      : [{
          id: `clip-${step}`,
          at: step,
          track: 'V1',
          clipType: 'hold' as const,
          hold: 1,
        }],
  };
}

function makeTimelineData(step: number): TimelineData {
  const config = makeConfig(step);
  const rowData = configToRows(config);
  const resolvedConfig = {
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((track) => ({ ...track })),
    clips: config.clips.map((clip) => ({
      ...clip,
      assetEntry: undefined,
    })),
    registry: {},
    theme: config.theme,
    theme_overrides: config.theme_overrides,
    generation_defaults: config.generation_defaults,
  };

  return {
    config,
    configVersion: 1,
    registry: { assets: {} },
    resolvedConfig,
    rows: rowData.rows,
    meta: rowData.meta,
    effects: rowData.effects,
    assetMap: {},
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((track) => ({ ...track })),
    clipOrder: rowData.clipOrder,
    signature: getConfigSignature(resolvedConfig),
    stableSignature: getStableConfigSignature(config, { assets: {} }),
  };
}

function makeMediaTimelineData(currentAsset: 'asset-old' | 'asset-new' = 'asset-old'): TimelineData {
  const base = createDefaultTimelineConfig();
  const config = {
    ...base,
    output: {
      ...base.output,
      file: `media-${currentAsset}.mp4`,
    },
    tracks: (base.tracks ?? []).map((track) => ({ ...track })),
    clips: [{
      id: 'clip-1',
      at: 0,
      track: 'V1',
      asset: currentAsset,
      clipType: 'hold' as const,
      hold: 1,
    }],
  };
  const registry = {
    assets: {
      'asset-old': { file: 'https://example.com/old.png', type: 'image/png' },
      'asset-new': { file: 'https://example.com/new.png', type: 'image/png' },
    },
  };
  const rowData = configToRows(config);
  const resolvedRegistry = Object.fromEntries(
    Object.entries(registry.assets).map(([assetId, entry]) => [
      assetId,
      {
        ...entry,
        src: entry.file,
      },
    ]),
  );
  const resolvedConfig = {
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((track) => ({ ...track })),
    clips: config.clips.map((clip) => ({
      ...clip,
      assetEntry: clip.asset ? resolvedRegistry[clip.asset] : undefined,
    })),
    registry: resolvedRegistry,
    theme: config.theme,
    theme_overrides: config.theme_overrides,
    generation_defaults: config.generation_defaults,
  };

  return {
    config,
    configVersion: 1,
    registry,
    resolvedConfig,
    rows: rowData.rows,
    meta: rowData.meta,
    effects: rowData.effects,
    assetMap: {
      'asset-old': 'https://example.com/old.png',
      'asset-new': 'https://example.com/new.png',
    },
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((track) => ({ ...track })),
    clipOrder: rowData.clipOrder,
    signature: getConfigSignature(resolvedConfig),
    stableSignature: getStableConfigSignature(config, registry),
  };
}

function makeProvider(overrides: Partial<DataProvider> = {}): DataProvider {
  return {
    loadTimeline: vi.fn(async () => ({ config: makeConfig(0), configVersion: 1 })),
    saveTimeline: vi.fn(async () => 1),
    loadAssetRegistry: vi.fn(async () => ({ assets: {} })),
    resolveAssetUrl: vi.fn(async (file: string) => file),
    ...overrides,
  };
}

function setup(options: {
  initialStep?: number;
  initialData?: TimelineData;
  providerOverrides?: Partial<DataProvider>;
  editability?: TimelineEditability;
  remoteHistory?: Pick<TimelineLocalSaveHandoff, 'remoteHistoryAvailable' | 'canUndo' | 'canRedo' | 'undo' | 'redo'>;
} = {}) {
  const provider = makeProvider(options.providerOverrides);
  const dataRef = { current: options.initialData ?? makeTimelineData(options.initialStep ?? 0) };
  const interactionStateRef = { current: createInteractionState() };
  const pendingOpsRef = { current: 0 };
  const commitCalls: CommitCall[] = [];
  const toast = {
    error: vi.fn(() => 'toast-error'),
    success: vi.fn(() => 'toast-success'),
    warning: vi.fn(() => 'toast-warning'),
    info: vi.fn(() => 'toast-info'),
  };
  const commitData = vi.fn((nextData: TimelineData, commitOptions?: CommitCall['options']) => {
    dataRef.current = nextData;
    commitCalls.push({ nextData, options: commitOptions });
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(
    VideoEditorRuntimeProvider,
    {
      value: {
        provider,
        project: { projectId: 'project-1' },
        toast,
        timelineId: 'timeline-1',
        userId: 'user-1',
        timelineName: 'Timeline 1',
      },
    },
    children,
  );

  const hook = renderHook(
    () => useTimelineHistory({ dataRef, commitData, interactionStateRef, pendingOpsRef, editability: options.editability,
      remoteHistory: options.remoteHistory }),
    { wrapper },
  );

  const applyEdit = (step: number, options: { transactionId?: string; semantic?: boolean } = {}) => {
    act(() => {
      hook.result.current.onBeforeCommit(dataRef.current, options);
      dataRef.current = makeTimelineData(step);
    });
  };

  return {
    provider,
    dataRef,
    pendingOpsRef,
    commitCalls,
    commitData,
    toast,
    ...hook,
    applyEdit,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTimelineHistory', () => {
  it('delegates mounted undo/redo to durable history once the owner is settled', async () => {
    const remoteHistory = {
      remoteHistoryAvailable: vi.fn(() => true),
      canUndo: vi.fn(() => true),
      canRedo: vi.fn(() => false),
      undo: vi.fn(async () => {}),
      redo: vi.fn(async () => {}),
    };
    const harness = setup({ remoteHistory });

    expect(harness.result.current.canUndo).toBe(true);
    expect(harness.result.current.canRedo).toBe(false);
    act(() => harness.result.current.undo());
    act(() => harness.result.current.redo());
    expect(remoteHistory.redo).not.toHaveBeenCalled();
    remoteHistory.canRedo.mockReturnValue(true);
    act(() => harness.result.current.redo());
    expect(remoteHistory.undo).toHaveBeenCalledTimes(1);
    expect(remoteHistory.redo).toHaveBeenCalledTimes(1);
    expect(harness.commitData).not.toHaveBeenCalled();
  });

  it('keeps snapshot history behind the durable boundary while saves are unsettled', () => {
    const remoteHistory = { remoteHistoryAvailable: () => false, canUndo: () => false, canRedo: () => false,
      undo: vi.fn(async () => {}), redo: vi.fn(async () => {}) };
    const harness = setup({ remoteHistory });
    act(() => {
      harness.result.current.onBeforeCommit(harness.dataRef.current, { transactionId: 'local' });
      harness.dataRef.current = makeTimelineData(1);
    });
    expect(harness.result.current.canUndo).toBe(false);
    act(() => harness.result.current.undo());
    expect(harness.commitData).not.toHaveBeenCalled();
    expect(remoteHistory.undo).not.toHaveBeenCalled();
  });

  it('keeps upload guards on durable Undo and reports a refusal without restoring a snapshot', async () => {
    const remoteHistory = { remoteHistoryAvailable: () => true, canUndo: () => true, canRedo: () => true,
      undo: vi.fn(async () => { throw new Error('Later write to target'); }), redo: vi.fn(async () => {}) };
    const harness = setup({ remoteHistory });
    harness.pendingOpsRef.current = 1;
    act(() => { harness.result.current.undo(); harness.result.current.redo(); });
    expect(remoteHistory.undo).not.toHaveBeenCalled();
    expect(remoteHistory.redo).not.toHaveBeenCalled();
    harness.pendingOpsRef.current = 0;
    await act(async () => { harness.result.current.undo(); });
    expect(harness.toast.error).toHaveBeenCalledWith('Could not undo timeline', { description: 'Later write to target' });
    expect(harness.commitData).not.toHaveBeenCalled();
  });

  it('undoes/redoes source-only edits and restores source-inclusive checkpoints after a clip edit', async () => {
    const saveCheckpoint = vi.fn(async (_timelineId: string, _checkpoint: Omit<Checkpoint, 'id'>) => 'source-checkpoint');
    const seed = makeTimelineData(0);
    const original = buildDataFromCurrentRegistry(seed.config, seed);
    const harness = setup({ initialData: original, providerOverrides: { saveCheckpoint } });
    const sourceItemsBySchemaRef = { 'astrid.transcript_segment/v1': [{
      id: 'source:segment', shape: 'interval' as const, domain: 'source_seconds' as const,
      extent: { start: 0, end: 1 }, schemaRef: 'astrid.transcript_segment/v1',
      sourceArtifactRef: { assetId: 'asset-1' }, provenance: { adapterId: 'test', adapterVersion: '1' },
      payload: { sourceId: 'source', segmentId: 'segment', text: 'Corrected', speaker: 'Alice', words: [{ id: 'word', start: 0, end: 1, text: 'Corrected' }] },
    }] };
    const corrected = buildDataFromCurrentRegistry(original.config, original, { sourceItemsBySchemaRef });
    act(() => {
      harness.result.current.onBeforeCommit(original, { transactionId: 'source-edit' });
      harness.dataRef.current = corrected;
    });
    act(() => harness.result.current.undo());
    expect(harness.dataRef.current.sourceItemsBySchemaRef).toEqual({});
    expect(harness.dataRef.current.stableSignature).toBe(original.stableSignature);
    act(() => harness.result.current.redo());
    expect(harness.dataRef.current.sourceItemsBySchemaRef).toEqual(sourceItemsBySchemaRef);
    expect(harness.dataRef.current.stableSignature).toBe(corrected.stableSignature);
    await act(async () => { await harness.result.current.createManualCheckpoint(); });
    expect(saveCheckpoint.mock.calls[0][1]).toMatchObject({ registry: original.registry, sourceItemsBySchemaRef });
    // An unrelated clip edit must carry source state through its own undo.
    act(() => {
      harness.result.current.onBeforeCommit(harness.dataRef.current, { transactionId: 'clip-edit' });
      harness.dataRef.current = buildDataFromCurrentRegistry(makeConfig(1), harness.dataRef.current);
    });
    act(() => harness.result.current.undo());
    expect(harness.dataRef.current.sourceItemsBySchemaRef).toEqual(sourceItemsBySchemaRef);
    act(() => {
      harness.dataRef.current = buildDataFromCurrentRegistry(original.config, harness.dataRef.current, { sourceItemsBySchemaRef: {} });
      harness.result.current.jumpToCheckpoint('source-checkpoint');
    });
    expect(harness.dataRef.current.sourceItemsBySchemaRef).toEqual(sourceItemsBySchemaRef);
  });

  it('defers canonical history until requested and reports a failed full-closure restore', async () => {
    const listHistory = vi.fn(async () => [{
      revisionId: 'parent-revision-1',
      projectId: 'project-1',
      parentDocumentId: 'timeline-1',
      contentDigest: 'sha256:' + 'a'.repeat(64),
      createdAt: '2026-10-05T12:00:00Z',
      isCurrentHead: false,
    }]);
    const restoreHistory = vi.fn(async () => {
      throw new Error('historical internal timeline revision failed immutable verification');
    });
    const shotComposition = {
      load: vi.fn(),
      listHistory,
      restoreHistory,
    };
    const { result, toast } = setup({
      providerOverrides: { shotComposition } as unknown as Partial<DataProvider>,
    });

    expect(listHistory).not.toHaveBeenCalled();
    expect(result.current.canonicalHistory).toEqual([]);
    expect(result.current.canonicalHistorySupported).toBe(true);

    await act(async () => {
      await result.current.restoreCanonicalRevision('parent-revision-1');
    });

    expect(restoreHistory).toHaveBeenCalledWith({
      projectId: 'project-1',
      parentDocumentId: 'timeline-1',
      revisionId: 'parent-revision-1',
    });
    expect(result.current.canonicalHistoryError).toContain('failed immutable verification');
    expect(toast.error).toHaveBeenCalledWith('Could not restore timeline history', {
      description: 'historical internal timeline revision failed immutable verification',
    });
  });

  it('refreshes canonical history on demand after a new revision is published', async () => {
    const first = {
      revisionId: 'parent-revision-1', projectId: 'project-1', parentDocumentId: 'timeline-1',
      contentDigest: 'sha256:' + 'a'.repeat(64), createdAt: '2026-10-05T12:00:00Z', isCurrentHead: true,
    };
    const second = {
      ...first, revisionId: 'parent-revision-2', isCurrentHead: true,
    };
    const listHistory = vi.fn()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([second, first]);
    const { result } = setup({
      providerOverrides: {
        shotComposition: {
          load: vi.fn(),
          listHistory,
          restoreHistory: vi.fn(),
        } as unknown as DataProvider['shotComposition'],
      },
    });

    expect(listHistory).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.refreshCanonicalHistory();
    });
    expect(result.current.canonicalHistory.map((entry) => entry.revisionId)).toEqual([
      'parent-revision-1',
    ]);
    await act(async () => {
      await result.current.refreshCanonicalHistory();
    });

    expect(listHistory).toHaveBeenCalledTimes(2);
    expect(result.current.canonicalHistory.map((entry) => entry.revisionId)).toEqual([
      'parent-revision-2', 'parent-revision-1',
    ]);
  });

  it('supports a basic undo/redo cycle', () => {
    const { result, dataRef, commitCalls, applyEdit } = setup();

    applyEdit(1, { transactionId: 'basic-1' });
    applyEdit(2, { transactionId: 'basic-2' });
    applyEdit(3, { transactionId: 'basic-3' });

    expect(result.current.canUndo).toBe(true);

    act(() => {
      result.current.undo();
      result.current.undo();
      result.current.undo();
    });

    expect(dataRef.current.config.output.file).toBe('output-0.mp4');
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
    expect(commitCalls.at(-1)?.options).toMatchObject({ save: true, skipHistory: true });

    act(() => {
      result.current.redo();
    });

    expect(dataRef.current.config.output.file).toBe('output-1.mp4');
    expect(dataRef.current.config).toMatchObject({
      theme: '2rp',
      theme_overrides: { visual: { canvas: { fps: 24 } } },
      generation_defaults: { model: 'sequence-v1' },
    });
    expect(dataRef.current.resolvedConfig).toMatchObject({
      theme: '2rp',
      theme_overrides: { visual: { canvas: { fps: 24 } } },
      generation_defaults: { model: 'sequence-v1' },
    });
    expect(result.current.canUndo).toBe(true);
  });

  it('uses snapshot history to undo and redo migrated edits', () => {
    const initialData = makeMediaTimelineData('asset-old');
    const { result, dataRef, commitCalls } = setup({ initialData });
    const applied = makeMediaTimelineData('asset-new');
    expect(applied.config.clips[0]?.asset).toBe('asset-new');

    act(() => {
      result.current.onBeforeCommit(initialData, {
        transactionId: 'swap-history',
      });
      dataRef.current = applied;
    });

    expect(dataRef.current.config.clips[0]?.asset).toBe('asset-new');

    act(() => {
      result.current.undo();
    });

    expect(dataRef.current.config.clips[0]?.asset).toBe('asset-old');

    act(() => {
      result.current.redo();
    });

    expect(dataRef.current.config.clips[0]?.asset).toBe('asset-new');
    expect(commitCalls.at(-1)?.options).toMatchObject({ save: true, skipHistory: true });
  });

  it('restores snapshot history for migrated edits without a local executor', () => {
    const initialData = makeMediaTimelineData('asset-old');
    const { result, dataRef } = setup({ initialData });
    const applied = makeMediaTimelineData('asset-new');
    expect(applied.config.clips[0]?.asset).toBe('asset-new');

    act(() => {
      result.current.onBeforeCommit(initialData, {
        transactionId: 'swap-fallback',
      });
      dataRef.current = applied;
    });

    act(() => {
      result.current.undo();
    });

    expect(dataRef.current.config.clips[0]?.asset).toBe('asset-old');

    act(() => {
      result.current.redo();
    });

    expect(dataRef.current.config.clips[0]?.asset).toBe('asset-new');
  });

  it('invalidates redo after a new edit following undo', () => {
    const { result, dataRef, applyEdit } = setup();

    applyEdit(1, { transactionId: 'redo-1' });
    applyEdit(2, { transactionId: 'redo-2' });

    act(() => {
      result.current.undo();
    });

    expect(result.current.canRedo).toBe(true);
    expect(dataRef.current.config.output.file).toBe('output-1.mp4');

    applyEdit(3, { transactionId: 'redo-3' });

    expect(result.current.canRedo).toBe(false);

    act(() => {
      result.current.redo();
    });

    expect(dataRef.current.config.output.file).toBe('output-3.mp4');
  });

  it('collapses five edits with the same transaction id into one undo entry', () => {
    const { result, dataRef, applyEdit } = setup();

    for (let step = 1; step <= 5; step += 1) {
      applyEdit(step, { transactionId: 'txn-1' });
    }

    act(() => {
      result.current.undo();
    });

    expect(dataRef.current.config.output.file).toBe('output-0.mp4');
    expect(result.current.canUndo).toBe(false);
  });

  it('collapses rapid untransacted edits within the 300ms debounce window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-26T10:00:00.000Z'));

    const { result, dataRef, applyEdit } = setup();

    applyEdit(1);
    vi.advanceTimersByTime(100);
    applyEdit(2);
    vi.advanceTimersByTime(100);
    applyEdit(3);
    vi.advanceTimersByTime(400);
    applyEdit(4);

    act(() => {
      result.current.undo();
    });

    expect(dataRef.current.config.output.file).toBe('output-3.mp4');

    act(() => {
      result.current.undo();
    });

    expect(dataRef.current.config.output.file).toBe('output-0.mp4');
  });

  it('caps the undo stack at 100 entries', () => {
    const { result, dataRef, applyEdit } = setup();

    for (let step = 1; step <= 105; step += 1) {
      applyEdit(step, { transactionId: `txn-${step}` });
    }

    act(() => {
      for (let count = 0; count < 100; count += 1) {
        result.current.undo();
      }
    });

    expect(dataRef.current.config.output.file).toBe('output-5.mp4');
    expect(result.current.canUndo).toBe(false);
  });

  it('creates checkpoints for session boundaries, edit distance, and semantic edits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-26T12:00:00.000Z'));

    const saveCheckpoint = vi.fn(async (_timelineId: string, checkpoint: Omit<Checkpoint, 'id'>) => {
      return `checkpoint-${checkpoint.triggerType}`;
    });

    const sessionCase = setup({ providerOverrides: { saveCheckpoint } });
    sessionCase.applyEdit(1, { transactionId: 'session-1' });
    vi.advanceTimersByTime(SESSION_IDLE_MS + 1);
    sessionCase.applyEdit(2, { transactionId: 'session-2' });

    await act(async () => {
      await Promise.resolve();
    });

    expect(saveCheckpoint).toHaveBeenCalledWith(
      'timeline-1',
      expect.objectContaining({ triggerType: 'session_boundary' }),
    );

    saveCheckpoint.mockClear();

    const distanceCase = setup({ providerOverrides: { saveCheckpoint } });
    for (let step = 1; step <= 31; step += 1) {
      distanceCase.applyEdit(step, { transactionId: `distance-${step}` });
    }

    await act(async () => {
      await Promise.resolve();
    });

    expect(saveCheckpoint).toHaveBeenCalledWith(
      'timeline-1',
      expect.objectContaining({ triggerType: 'edit_distance' }),
    );

    saveCheckpoint.mockClear();

    const semanticCase = setup({ providerOverrides: { saveCheckpoint } });
    semanticCase.applyEdit(1, { semantic: true, transactionId: 'semantic-1' });

    await act(async () => {
      await Promise.resolve();
    });

    expect(saveCheckpoint).toHaveBeenCalledWith(
      'timeline-1',
      expect.objectContaining({ triggerType: 'semantic' }),
    );
  });

  it('skips checkpoint persistence when provider persistence is disabled', async () => {
    const saveCheckpoint = vi.fn(async () => 'checkpoint-read-only');
    const testCase = setup({
      providerOverrides: {
        persistenceEnabled: false,
        saveCheckpoint,
      },
    });

    await act(async () => {
      await testCase.result.current.createManualCheckpoint('Read only');
    });

    expect(saveCheckpoint).not.toHaveBeenCalled();
  });

  it('blocks manual checkpoint persistence when whole-timeline editability is denied', async () => {
    const saveCheckpoint = vi.fn(async () => 'checkpoint-read-only');
    const testCase = setup({
      editability: {
        check: () => ({ allowed: false, reason: 'timeline_read_only' }),
        checkTimeline: () => ({ allowed: false, reason: 'timeline_read_only' }),
      },
      providerOverrides: {
        persistenceEnabled: true,
        saveCheckpoint,
      },
    });

    await act(async () => {
      await testCase.result.current.createManualCheckpoint('Read only');
    });

    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(testCase.result.current.checkpoints).toHaveLength(0);
  });

  it('jumpToCheckpoint restores the checkpoint config and clears both stacks', async () => {
    const checkpointConfig = makeConfig(7);
    const checkpoint: Checkpoint = {
      id: 'checkpoint-7',
      timelineId: 'timeline-1',
      config: checkpointConfig,
      createdAt: new Date('2026-03-26T12:00:00.000Z').toISOString(),
      triggerType: 'manual',
      label: 'Checkpoint 7',
      editsSinceLastCheckpoint: 0,
    };

    const { result, dataRef, commitCalls, applyEdit } = setup({
      providerOverrides: {
        loadCheckpoints: vi.fn(async () => [checkpoint]),
      },
    });

    await waitFor(() => {
      expect(result.current.checkpoints).toHaveLength(1);
    });

    applyEdit(1);

    act(() => {
      result.current.jumpToCheckpoint('checkpoint-7');
    });

    expect(dataRef.current.config.output.file).toBe('output-7.mp4');
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(commitCalls.at(-1)?.options).toMatchObject({ save: true, skipHistory: true });
  });

  it('blocks undo, redo, and checkpoint jumps while whole-timeline editability is denied', async () => {
    let allowed = true;
    const checkpoint: Checkpoint = {
      id: 'checkpoint-7',
      timelineId: 'timeline-1',
      config: makeConfig(7),
      createdAt: new Date('2026-03-26T12:00:00.000Z').toISOString(),
      triggerType: 'manual',
      label: 'Checkpoint 7',
      editsSinceLastCheckpoint: 0,
    };
    const testCase = setup({
      editability: { checkTimeline: () => ({ allowed }) },
      providerOverrides: { loadCheckpoints: vi.fn(async () => [checkpoint]) },
    });
    await waitFor(() => expect(testCase.result.current.checkpoints).toHaveLength(1));
    testCase.applyEdit(1);

    allowed = false;
    act(() => testCase.result.current.undo());
    expect(testCase.dataRef.current.config.output.file).toBe('output-1.mp4');
    expect(testCase.result.current.canUndo).toBe(true);

    allowed = true;
    act(() => testCase.result.current.undo());
    expect(testCase.result.current.canRedo).toBe(true);
    const dataAfterUndo = testCase.dataRef.current;
    const commitsAfterUndo = testCase.commitCalls.length;

    allowed = false;
    act(() => {
      testCase.result.current.redo();
      testCase.result.current.jumpToCheckpoint('checkpoint-7');
    });
    expect(testCase.dataRef.current).toBe(dataAfterUndo);
    expect(testCase.commitCalls).toHaveLength(commitsAfterUndo);
    expect(testCase.result.current.canRedo).toBe(true);
  });

  it('does not accumulate history when state changes bypass onBeforeCommit', () => {
    const { result, dataRef } = setup();

    act(() => {
      dataRef.current = makeTimelineData(1);
    });

    expect(result.current.canUndo).toBe(false);

    act(() => {
      result.current.undo();
    });

    expect(dataRef.current.config.output.file).toBe('output-1.mp4');
    expect(result.current.canRedo).toBe(false);
  });
});

describe('useTimelineHistory — upload pause gate', () => {
  it('pauses undo/redo while pendingOps > 0 and releases when it returns to 0', () => {
    const { result, rerender, pendingOpsRef, commitCalls, applyEdit } = setup();

    // Distinct transactions so the untransacted collapse window cannot merge
    // them into one undo entry.
    applyEdit(1, { transactionId: 'gate-1' });
    applyEdit(2, { transactionId: 'gate-2' });
    act(() => {
      result.current.undo();
    });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(true);
    expect(result.current.historyPausedForUploads).toBe(false);

    // An upload starts: the registry-stranding window opens.
    pendingOpsRef.current = 1;
    rerender();
    expect(result.current.historyPausedForUploads).toBe(true);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);

    // undo()/redo() are no-ops during the pause: no restore is committed and
    // the stacks are untouched.
    const commitsBefore = commitCalls.length;
    act(() => {
      result.current.undo();
      result.current.redo();
    });
    expect(commitCalls.length).toBe(commitsBefore);

    // Upload finishes: the gate releases with the stacks intact.
    pendingOpsRef.current = 0;
    rerender();
    expect(result.current.historyPausedForUploads).toBe(false);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(true);

    act(() => {
      result.current.undo();
    });
    expect(commitCalls.length).toBe(commitsBefore + 1);
  });
});


describe('data lane row placement history', () => {
  it('undoes and redoes only presentation metadata through the existing timeline history', () => {
    const harness = setup();
    const before = buildDataFromCurrentRegistry(harness.dataRef.current.config, harness.dataRef.current);
    harness.dataRef.current = before;
    const placement = { version: 1 as const, lanes: [{ laneId: 'astrid.transcript', beforeTrackId: 'V1' }] };
    act(() => {
      harness.result.current.onBeforeCommit(before, { semantic: true });
      harness.dataRef.current = buildDataFromCurrentRegistry({
        ...before.config, app: { ...before.config.app, timelineDataLanePlacement: placement },
      }, before);
    });
    expect(harness.dataRef.current.config.app?.timelineDataLanePlacement).toEqual(placement);
    act(() => harness.result.current.undo());
    expect(harness.dataRef.current.config.app?.timelineDataLanePlacement).toBeUndefined();
    expect(harness.dataRef.current.config.clips).toEqual(before.config.clips);
    expect(harness.dataRef.current.config.tracks).toEqual(before.config.tracks);
    act(() => harness.result.current.redo());
    expect(harness.dataRef.current.config.app?.timelineDataLanePlacement).toEqual(placement);
    expect(harness.dataRef.current.config.clips).toEqual(before.config.clips);
    expect(harness.dataRef.current.config.tracks).toEqual(before.config.tracks);
  });
});

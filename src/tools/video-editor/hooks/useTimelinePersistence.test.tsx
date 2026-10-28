// @vitest-environment jsdom
import React from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB, resetFakeIndexedDB } from 'fake-indexeddb';
vi.stubGlobal('indexedDB', createFakeIndexedDB());
// Cache invalidation is an effect of saving, not part of this writer's
// acknowledgement protocol. Avoid importing the renderer's media pack tree.
vi.mock('@/tools/video-editor/compositions/TimelineRenderer.tsx', () => ({
  invalidateReferencedTimelineCache: vi.fn(),
}));
// Call-through spy: behaviour is unchanged, but the draft writer's calls are observable.
vi.mock('@/tools/video-editor/data/timelineDraftIndexedDb.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/tools/video-editor/data/timelineDraftIndexedDb.ts')>();
  return { ...actual, saveTimelineDraft: vi.fn(actual.saveTimelineDraft) };
});
import { useTimelinePersistence, TimelineSaveBarrierError, type UseTimelinePersistenceResult } from './useTimelinePersistence';
import { useTimelineOps } from './useTimelineOps';
import { useEditorBrowserDefaults } from './useEditorBrowserDefaults';
import { useGuardedReload } from '@/shared/lib/updates/draftSafeReload.ts';
import { RuntimeDataProvider } from '@/integrations/runtime/dataProvider.ts';
import { PROJECT_ID, TIMELINE_ID, runtimeFixture } from '@/test/fakeWorkspaceRuntime.ts';
import { TimelineEventBus } from './useTimelineEventBus';
import {
  TimelineStoreProvider,
  createTimelineStore,
  useTimelineDataSelector,
  type TimelineStoreApi,
} from './timelineStore';
import { createInteractionState, notifyInteractionEndIfIdle, type InteractionStateRef } from '../lib/interaction-state';
import { buildTimelineData, configToRows, type TimelineData } from '../lib/timeline-data';
import { getConfigSignature, getStableConfigSignature } from '../lib/config-utils';
import { buildDataFromCurrentRegistry } from '../lib/timeline-save-utils';
import { createDefaultTimelineConfig } from '../lib/defaults';
import type { AssetResolver } from '../data/AssetResolver';
import { OwnUnacknowledgedSaveError, TimelineSchemaIncompatibleError, TimelineVersionConflictError, type DataProvider } from '../data/DataProvider';
import { StaleWriteError } from '../data/shotComposition';
import { BRIDGE_REQUEST_TIMEOUT_MS } from '../data/bridgeContract';
import { clearTimelineDraft, loadTimelineDraft, saveTimelineDraft, type TimelineDraftRecoveryMetadata } from '@/tools/video-editor/data/timelineDraftIndexedDb.ts';
import type { AssetRegistry } from '../types';
import type { TimelineBundleEnvelope } from '../data/typed/timelineBundle';

// Keep these inputs aligned with useTimelinePersistence's private save timing
// contract; the bridge request window itself comes from the shared contract.
const SAVE_DEBOUNCE_MS = 500;
const SAVE_ERROR_RETRY_BASE_MS = 500;
const WATCHDOG_GRACE_MS = SAVE_DEBOUNCE_MS + BRIDGE_REQUEST_TIMEOUT_MS + 2 * SAVE_ERROR_RETRY_BASE_MS;

function makeRegistry(label: string): AssetRegistry {
  return {
    assets: {
      [`asset-${label}`]: {
        file: `media/${label}.mp4`,
        type: 'video/mp4',
        generationId: `gen-${label}`,
        variantId: `variant-${label}`,
      },
    },
  };
}

function makeTimelineData(label: string, registry: AssetRegistry = { assets: {} }): TimelineData {
  const base = createDefaultTimelineConfig();
  const config = {
    ...base,
    output: { ...base.output, file: `output-${label}.mp4` },
    tracks: (base.tracks ?? []).map((track) => ({ ...track })),
    clips: [{
      id: `clip-${label}`,
      at: 0,
      track: 'V1' as const,
      clipType: 'hold' as const,
      hold: 1,
    }],
  };
  const rowData = configToRows(config);
  const assetMap = Object.fromEntries(
    Object.entries(registry.assets).map(([assetId, entry]) => [assetId, entry.file]),
  );
  const resolvedRegistry = Object.fromEntries(
    Object.entries(registry.assets).map(([assetId, entry]) => [assetId, { ...entry, src: entry.file }]),
  );
  const resolvedConfig = {
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((track) => ({ ...track })),
    clips: config.clips.map((clip) => ({ ...clip, assetEntry: undefined })),
    registry: resolvedRegistry,
  };
  return {
    config,
    configVersion: 1,
    registry,
    resolvedConfig,
    rows: rowData.rows,
    meta: rowData.meta,
    effects: rowData.effects,
    assetMap,
    output: { ...config.output },
    tracks: (config.tracks ?? []).map((track) => ({ ...track })),
    clipOrder: rowData.clipOrder,
    signature: getConfigSignature(resolvedConfig),
    stableSignature: getStableConfigSignature(config, registry),
  };
}

interface TestHarness {
  provider: DataProvider;
  assetResolver: AssetResolver;
  saveTimeline: ReturnType<typeof vi.fn>;
  loadTimeline: ReturnType<typeof vi.fn>;
  loadAssetRegistry: ReturnType<typeof vi.fn>;
  loadReferencedTimeline?: ReturnType<typeof vi.fn>;
  interactionStateRef: InteractionStateRef;
  dataRef: { current: TimelineData | null };
  /** Commit sequence counter — bump to simulate a newer edit landing. */
  editSeqRef: { current: number };
  savedSeqRef: { current: number };
  configVersionRef: { current: number };
  replaceSession: (provider: DataProvider, timelineId?: string) => void;
  commitData: ReturnType<typeof vi.fn>;
  scheduleSave: (data: TimelineData) => void;
  reloadFromServer: () => Promise<void>;
  unmount: () => void;
  eventBus: TimelineEventBus;
  result: { current: UseTimelinePersistenceResult };
}

interface SetupOptions {
  providerOverride?: DataProvider;
  timelineId?: string;
  store?: TimelineStoreApi;
  initialData?: TimelineData;
  persistenceEnabled?: boolean;
  saveTimelineImpl?: DataProvider['saveTimeline'];
  loadTimelineImpl?: DataProvider['loadTimeline'];
  loadCanonicalTimelineImpl?: NonNullable<DataProvider['loadCanonicalTimeline']>;
  loadAssetRegistryImpl?: DataProvider['loadAssetRegistry'];
  loadReferencedTimelineImpl?: NonNullable<DataProvider['loadReferencedTimeline']>;
  recoveryMetadata?: TimelineDraftRecoveryMetadata;
}

function setup(options?: SetupOptions): TestHarness {
  const saveTimeline = vi.fn(
    options?.saveTimelineImpl
      ?? (async (_id: string, _config: TimelineData['config'], _version: number, _registry?: AssetRegistry) => 2),
  );
  const loadTimeline = vi.fn(
    options?.loadTimelineImpl
      ?? (async () => ({ config: createDefaultTimelineConfig(), configVersion: 1 })),
  );
  const loadAssetRegistry = vi.fn(options?.loadAssetRegistryImpl ?? (async () => ({ assets: {} })));
  const loadReferencedTimeline = options?.loadReferencedTimelineImpl
    ? vi.fn(options.loadReferencedTimelineImpl)
    : undefined;
  const provider: DataProvider = options?.providerOverride ?? {
    persistenceEnabled: options?.persistenceEnabled,
    loadTimeline,
    ...(options?.loadCanonicalTimelineImpl
      ? { loadCanonicalTimeline: options.loadCanonicalTimelineImpl }
      : {}),
    saveTimeline,
    loadAssetRegistry,
    ...(loadReferencedTimeline
      ? { loadReferencedTimeline }
      : {}),
    resolveAssetUrl: vi.fn((file: string) => file),
    ...(options?.recoveryMetadata
      ? { getTimelineDraftRecoveryMetadata: () => options.recoveryMetadata! }
      : {}),
  };
  const assetResolver: AssetResolver = {
    resolveAssetUrl: vi.fn((file: string) => Promise.resolve(file)),
  };

  const eventBus = new TimelineEventBus();
  const dataRef = { current: options?.initialData ?? makeTimelineData('initial') };
  const interactionStateRef: InteractionStateRef = { current: createInteractionState() };
  const commitData = vi.fn();
  const selectedClipIdRef = { current: null };
  const selectedTrackIdRef = { current: null };
  const editSeqRef = { current: 1 };
  const savedSeqRef = { current: 0 };
  const configVersionRef = { current: 1 };
  const lastSavedSignatureRef = { current: '' };

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  const hook = renderHook(
    (target: { provider: DataProvider; timelineId: string }) => useTimelinePersistence({
      store: options?.store,
      provider: target.provider,
      assetResolver,
      timelineId: target.timelineId,
      eventBus,
      dataRef,
      commitData,
      selectedClipIdRef,
      selectedTrackIdRef,
      editSeqRef,
      savedSeqRef,
      configVersionRef,
      lastSavedSignatureRef,
      interactionStateRef,
    }),
    { wrapper, initialProps: { provider, timelineId: options?.timelineId ?? 'timeline-1' } },
  );

  return {
    provider,
    assetResolver,
    saveTimeline,
    loadTimeline,
    loadAssetRegistry,
    loadReferencedTimeline,
    interactionStateRef,
    dataRef,
    editSeqRef,
    savedSeqRef,
    configVersionRef,
    replaceSession: (nextProvider, timelineId = 'timeline-1') => hook.rerender({ provider: nextProvider, timelineId }),
    commitData,
    scheduleSave: (data) => {
      dataRef.current = data;
      act(() => {
        hook.result.current.scheduleSave(data);
      });
    },
    reloadFromServer: () => hook.result.current.reloadFromServer(),
    unmount: () => { hook.unmount(); },
    eventBus,
    result: hook.result,
  };
}

function makeBundle(text: string): TimelineBundleEnvelope {
  return {
    schema_version: 1,
    itemsBySchemaRef: {
      'astrid.transcript_segment/v1': [{
        id: `item-${text}`,
        shape: 'interval',
        domain: 'source_seconds',
        extent: { start: 0, end: 1 },
        schemaRef: 'astrid.transcript_segment/v1',
        payload: { text },
        sourceArtifactRef: { assetId: 'asset-a' },
        provenance: { adapterId: 'test', adapterVersion: '1' },
      }],
    },
  };
}

describe('useTimelinePersistence — interaction gating', () => {
  it('sends the edited source bundle at its captured Runtime head and keeps it recoverable on CAS conflict', async () => {
    const original = makeTimelineData('source-only');
    const head = { projectId: 'project-1', timelineId: 'timeline-1', headRevisionId: 'revision-1' };
    original.head = head;
    const harness = setup({ initialData: original });
    const conflict = new TimelineVersionConflictError('Another editor changed the transcript');
    const saveAtHead = vi.fn(async () => { throw conflict; });
    harness.provider.saveTimelineAtHead = saveAtHead;
    const loaded = makeBundle('old server text');
    harness.result.current.loadedBundleRef.current = { ...loaded, futureMetadata: { keep: true } } as TimelineBundleEnvelope;
    const edited = makeBundle('corrected source text');
    const corrected = buildDataFromCurrentRegistry(original.config, original, { sourceItemsBySchemaRef: edited.itemsBySchemaRef });
    expect(corrected.stableSignature).not.toBe(original.stableSignature);
    harness.scheduleSave(corrected);
    await act(async () => {
      await expect(harness.result.current.flushPendingSave()).rejects.toBe(conflict);
    });
    const expectedBundle = { ...edited, futureMetadata: { keep: true } };
    expect(saveAtHead).toHaveBeenCalledWith('timeline-1', corrected.config, head, corrected.registry, expectedBundle);
    expect(harness.saveTimeline).not.toHaveBeenCalled();
    expect(harness.savedSeqRef.current).toBe(0);
    expect(harness.dataRef.current?.sourceItemsBySchemaRef).toEqual(edited.itemsBySchemaRef);
    const draft = await loadTimelineDraft('timeline-1');
    expect(draft?.draft.bundle).toEqual(expectedBundle);
    expect(draft?.baseHeadRevisionId).toBe('revision-1');
    expect(harness.result.current.isConflictExhausted).toBe(true);
    expect(harness.commitData).not.toHaveBeenCalled();
  });

  it('publishes source-only edits and explicit source clearing without a server reload', async () => {
    const original = makeTimelineData('source-save');
    const harness = setup({ initialData: original });
    const bundle = makeBundle('new transcript');
    const edited = buildDataFromCurrentRegistry(original.config, original, { sourceItemsBySchemaRef: bundle.itemsBySchemaRef });
    harness.scheduleSave(edited);
    await act(async () => { await expect(harness.result.current.flushPendingSave()).resolves.toBe(2); });
    expect(harness.saveTimeline).toHaveBeenLastCalledWith('timeline-1', edited.config, 1, edited.registry, bundle);
    harness.editSeqRef.current += 1;
    const cleared = buildDataFromCurrentRegistry(edited.config, edited, { sourceItemsBySchemaRef: {} });
    harness.scheduleSave(cleared);
    await act(async () => { await harness.result.current.flushPendingSave(); });
    expect(harness.saveTimeline).toHaveBeenLastCalledWith('timeline-1', cleared.config, 2, cleared.registry, { schema_version: 1, itemsBySchemaRef: {} });
    expect(await loadTimelineDraft('timeline-1')).toBeNull();
  });


  it('serializes only canonical transcript references while leaving rich project projections transient', async()=>{
    const original=makeTimelineData('project-transcript-association'),harness=setup({initialData:original});
    const bundle=makeBundle('project-owned-text'),item=bundle.itemsBySchemaRef['astrid.transcript_segment/v1'][0];
    item.provenance={adapterId:'astrid.projectTranscript',adapterVersion:'1'};
    item.payload={text:'project-owned-text',documentId:'transcript:canonical',documentVersion:3,words:[{id:'w',start:0,end:1,text:'word'}]};
    const refs={schema:'media.transcript.references/v1' as const,associations:[{assetId:'asset-a',documentId:'transcript:canonical'}]};
    const associated=buildDataFromCurrentRegistry(original.config,original,{sourceItemsBySchemaRef:bundle.itemsBySchemaRef,transcriptReferences:refs});
    harness.scheduleSave(associated);await act(async()=>{await harness.result.current.flushPendingSave();});
    expect(harness.saveTimeline).toHaveBeenLastCalledWith('timeline-1',associated.config,1,associated.registry,{schema_version:1,itemsBySchemaRef:{'astrid.transcript_segment/v1':[]},transcriptReferences:refs});
    expect(harness.dataRef.current?.sourceItemsBySchemaRef?.['astrid.transcript_segment/v1'][0].payload).toEqual(item.payload);
  });
  beforeEach(() => {
    vi.useFakeTimers();
    resetFakeIndexedDB();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('guards the real reload action with the persistence owner recovery draft after Runtime restart', async () => {
    const runtimeOptions = { runtimeInstanceId: 'timeline-restart-before' };
    const fixture = runtimeFixture(runtimeOptions);
    let blockHealth = false;
    let releaseHealth!: () => void;
    let markHealthStarted!: () => void;
    const healthGate = new Promise<void>((resolve) => { releaseHealth = resolve; });
    const healthStarted = new Promise<void>((resolve) => { markHealthStarted = resolve; });
    const transport = async (...args: Parameters<typeof fixture.transport>) => {
      if (blockHealth && args[1] === '/v1/health') {
        markHealthStarted();
        await healthGate;
      }
      return fixture.transport(...args);
    };
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, transport });
    const loaded = await provider.loadTimeline(TIMELINE_ID);
    const initial = makeTimelineData('restart-initial');
    initial.head = loaded.head;
    const harness = setup({ providerOverride: provider, timelineId: TIMELINE_ID, initialData: initial });
    const inFlight = makeTimelineData('save-in-flight-at-restart');
    inFlight.head = initial.head;
    harness.editSeqRef.current++;
    harness.scheduleSave(inFlight);
    runtimeOptions.runtimeInstanceId = 'timeline-restart-after';
    blockHealth = true;
    const root = document.createElement('div');
    document.body.appendChild(root);
    const reload = vi.fn();
    const page = renderHook(() => {
      useEditorBrowserDefaults({
        shellRoot: root,
        saveStatus: harness.result.current.saveStatus,
        flushPendingSave: harness.result.current.flushPendingSave,
        preserveTimelineDraftForReload: harness.result.current.preserveTimelineDraftForReload,
        isTimelineDraftDurableForReload: harness.result.current.isTimelineDraftDurableForReload,
      });
      return useGuardedReload(reload);
    });

    let pendingReload!: Promise<void>;
    await act(async () => {
      pendingReload = page.result.current.reload();
      await healthStarted;
    });
    const latest = makeTimelineData('latest-after-restart');
    latest.head = initial.head;
    harness.editSeqRef.current++;
    harness.scheduleSave(latest);
    releaseHealth();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await pendingReload;
    });

    expect(reload).toHaveBeenCalledOnce();
    expect(fixture.requests.filter((request) => request.method === 'POST'
      && request.path.endsWith('/composition-revisions'))).toHaveLength(0);
    expect(harness.result.current.isTimelineDraftDurableForReload()).toBe(true);
    expect(harness.result.current.saveStatus).not.toBe('saved');
    const draft = await loadTimelineDraft(TIMELINE_ID);
    expect(draft?.draft.config).toEqual(latest.config);
    expect(draft?.draft.registry).toEqual(latest.registry);
    expect(draft?.baseHeadProjectId).toBe(PROJECT_ID);
    expect(draft?.baseHeadTimelineId).toBe(TIMELINE_ID);
    expect(draft?.baseHeadRevisionId).toBe(initial.head?.headRevisionId);
    page.unmount();
    harness.unmount();
  });

  it('binds a preflight no-write failure and fences its queued payload before correction', async () => {
    const harness = setup();
    harness.interactionStateRef.current.drag = true;
    const rejected = makeTimelineData('rejected', makeRegistry('rejected'));
    harness.dataRef.current = rejected;
    harness.scheduleSave(rejected);
    const target = harness.result.current.captureSaveTarget();
    const failure = await harness.result.current.flushSaveTarget(target).catch((error) => error);
    expect(failure).toBeInstanceOf(TimelineSaveBarrierError);
    expect(failure).toMatchObject({ target, certainty: 'definitely-uncommitted' });
    expect(harness.result.current.discardUncommittedSaveTarget(target, failure)).toBe(true);
    harness.editSeqRef.current += 1;
    const corrected = makeTimelineData('corrected');
    harness.dataRef.current = corrected;
    harness.scheduleSave(corrected);
    harness.interactionStateRef.current.drag = false;
    await act(async () => {
      notifyInteractionEndIfIdle(harness.interactionStateRef);
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.saveTimeline.mock.calls[0][3]).toEqual({ assets: {} });
    harness.unmount();
  });

  it('retains ambiguous transport state and cannot borrow an ACK from a replaced session', async () => {
    const harness = setup({ saveTimelineImpl: async () => { throw new Error('ACK lost'); } });
    const target = harness.result.current.captureSaveTarget();
    let failure: unknown;
    await act(async () => { failure = await harness.result.current.flushSaveTarget(target).catch((error) => error); });
    expect(failure).toMatchObject({ target, certainty: 'ambiguous', cause: expect.any(Error) });
    expect(harness.result.current.discardUncommittedSaveTarget(target, failure)).toBe(false);
    const replacement = { ...harness.provider, saveTimeline: vi.fn(async () => 7) };
    act(() => harness.replaceSession(replacement));
    await expect(harness.result.current.flushSaveTarget(target)).rejects.toMatchObject({ target, certainty: 'ambiguous' });
    expect(replacement.saveTimeline).not.toHaveBeenCalled();
    harness.unmount();
  });

  it('assigns no-write certainty to an initial typed CAS rejection but never to unknown errors', async () => {
    const cause = new TimelineVersionConflictError('CAS denied');
    const harness = setup({ saveTimelineImpl: async () => { throw cause; } });
    const target = harness.result.current.captureSaveTarget();
    let failure: unknown;
    await act(async () => { failure = await harness.result.current.flushSaveTarget(target).catch((error) => error); });
    expect(failure).toMatchObject({ target, certainty: 'definitely-uncommitted', cause });
    expect(harness.result.current.discardUncommittedSaveTarget(target, failure)).toBe(true);
    harness.unmount();
  });

  it('fences old targets across canonical reload without blocking reused sequence numbers', async () => {
    let calls = 0;
    const harness = setup({ saveTimelineImpl: async () => {
      if (calls++ === 0) throw new TimelineVersionConflictError('CAS denied');
      return 2;
    } });
    const oldTarget = harness.result.current.captureSaveTarget();
    let failure: unknown;
    await act(async () => { failure = await harness.result.current.flushSaveTarget(oldTarget).catch((error) => error); });
    expect(harness.result.current.discardUncommittedSaveTarget(oldTarget, failure)).toBe(true);
    await act(async () => { await harness.reloadFromServer(); });
    harness.editSeqRef.current += 1;
    harness.scheduleSave(makeTimelineData('after-reload'));
    const currentTarget = harness.result.current.captureSaveTarget();
    expect(currentTarget.targetSeq).toBe(oldTarget.targetSeq);
    expect(currentTarget.generation).not.toBe(oldTarget.generation);
    await expect(harness.result.current.flushSaveTarget(oldTarget)).rejects.toMatchObject({ certainty: 'ambiguous' });
    await act(async () => { await expect(harness.result.current.flushSaveTarget(currentTarget)).resolves.toBe(2); });
    harness.unmount();
  });

  it('does NOT fire saveTimeline while a drag interaction is active', async () => {
    const harness = setup();
    harness.interactionStateRef.current.drag = true;

    harness.scheduleSave(makeTimelineData('mid-drag'));

    // Advance well past the 500ms debounce.
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });

    expect(harness.saveTimeline).not.toHaveBeenCalled();
  });

  it('does NOT fire saveTimeline while a resize interaction is active', async () => {
    const harness = setup();
    harness.interactionStateRef.current.resize = true;

    harness.scheduleSave(makeTimelineData('mid-resize'));

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });

    expect(harness.saveTimeline).not.toHaveBeenCalled();
  });

  it('captures the canonical CAS base before an interaction-deferred save', async () => {
    const baseGraph = { head: 'canonical-head-before-gesture' };
    const harness = setup({
      recoveryMetadata: {
        recoveryKey: 'timeline-1:occurrence-1',
        baseHeadRevisionId: 'canonical-head-before-gesture',
        baseCanonicalGraph: baseGraph,
        draftIdentity: 'edit-during-gesture',
      },
    });
    harness.interactionStateRef.current.drag = true;
    harness.scheduleSave(makeTimelineData('interaction-deferred'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(harness.saveTimeline).not.toHaveBeenCalled();
    const recovered = await loadTimelineDraft('timeline-1:occurrence-1');
    expect(recovered).toMatchObject({
      baseHeadRevisionId: 'canonical-head-before-gesture',
      baseCanonicalGraph: baseGraph,
      draftIdentity: 'edit-during-gesture',
    });
  });

  it('flushes the newest deferred payload after the gesture ends', async () => {
    const harness = setup();
    harness.interactionStateRef.current.drag = true;

    // First scheduled mid-drag — should be deferred and replaced.
    harness.scheduleSave(makeTimelineData('drag-1'));
    harness.scheduleSave(makeTimelineData('drag-2'));
    harness.scheduleSave(makeTimelineData('drag-3'));

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(harness.saveTimeline).not.toHaveBeenCalled();

    // End the gesture.
    await act(async () => {
      harness.interactionStateRef.current.drag = false;
      notifyInteractionEndIfIdle(harness.interactionStateRef);
      // Now scheduleSave's setTimeout(500) should fire.
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    // Should have flushed the newest payload — output.file ends with 'drag-3'.
    const args = harness.saveTimeline.mock.calls[0]?.[1];
    expect(args?.output.file).toBe('output-drag-3.mp4');
  });

  it('keeps save deferred until both drag and resize interactions are idle', async () => {
    const harness = setup();
    harness.interactionStateRef.current.drag = true;
    harness.interactionStateRef.current.resize = true;

    harness.scheduleSave(makeTimelineData('both-active'));

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(harness.saveTimeline).not.toHaveBeenCalled();

    await act(async () => {
      harness.interactionStateRef.current.drag = false;
      notifyInteractionEndIfIdle(harness.interactionStateRef);
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(harness.saveTimeline).not.toHaveBeenCalled();

    await act(async () => {
      harness.interactionStateRef.current.resize = false;
      notifyInteractionEndIfIdle(harness.interactionStateRef);
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    const args = harness.saveTimeline.mock.calls[0]?.[1];
    expect(args?.output.file).toBe('output-both-active.mp4');
  });

  it('schedules saves normally when no interaction is active', async () => {
    const harness = setup();

    harness.scheduleSave(makeTimelineData('normal'));

    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
  });

  it('coalesces a recovery draft before the debounce, so a crash cannot lose the edit', async () => {
    const harness = setup();
    const first = makeTimelineData('crash-before-debounce');
    const latest = makeTimelineData('crash-latest');

    harness.scheduleSave(first);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.saveTimeline).not.toHaveBeenCalled();
    expect((await loadTimelineDraft('timeline-1'))?.draft).toEqual({
      config: first.config,
      registry: first.registry,
      bundle: null,
    });

    // A second mutation overwrites the one slot, still before any POST.
    harness.scheduleSave(latest);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((await loadTimelineDraft('timeline-1'))?.draft).toEqual({
      config: latest.config,
      registry: latest.registry,
      bundle: null,
    });
  });

  it('flushes a debounce-pending edit immediately and returns its acknowledged version', async () => {
    const harness = setup();
    harness.scheduleSave(makeTimelineData('render-barrier'));

    let acknowledgedVersion: number | undefined;
    await act(async () => {
      acknowledgedVersion = await harness.result.current.flushPendingSave();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.saveTimeline.mock.calls[0]?.[1].output.file).toBe('output-render-barrier.mp4');
    expect(acknowledgedVersion).toBe(2);
  });

  it('does not expose a registry durably when the canonical save fails before write', async () => {
    const persistedRegistry: { current: AssetRegistry } = { current: { assets: {} } };
    const failure = new TimelineVersionConflictError('CAS denied before registry write');
    const harness = setup({
      saveTimelineImpl: async () => { throw failure; },
      loadAssetRegistryImpl: async () => persistedRegistry.current,
    });
    const acceptedRegistry = makeRegistry('accepted-but-unsaved');
    harness.scheduleSave(makeTimelineData('registry-preflight-failure', acceptedRegistry));

    await expect(harness.result.current.flushPendingSave()).rejects.toBe(failure);
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.saveTimeline.mock.calls[0]?.[3]).toEqual(acceptedRegistry);
    await expect(harness.provider.loadAssetRegistry('timeline-1')).resolves.toEqual({ assets: {} });
    harness.unmount();
  });

  it('reads back a registered asset only after the canonical timeline save is acknowledged', async () => {
    const persistedRegistry: { current: AssetRegistry } = { current: { assets: {} } };
    const harness = setup({
      saveTimelineImpl: async (_id, _config, _version, registry) => {
        persistedRegistry.current = structuredClone(registry ?? { assets: {} });
        return 2;
      },
      loadAssetRegistryImpl: async () => persistedRegistry.current,
    });
    const acceptedRegistry = makeRegistry('canonical-save');
    harness.scheduleSave(makeTimelineData('registry-canonical-save', acceptedRegistry));

    await act(async () => {
      await expect(harness.result.current.flushPendingSave()).resolves.toBe(2);
    });
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.saveTimeline.mock.calls[0]?.[3]).toEqual(acceptedRegistry);
    await expect(harness.provider.loadAssetRegistry('timeline-1')).resolves.toEqual(acceptedRegistry);
    harness.unmount();
  });

  it('public apply schedules the normal host save synchronously and public flush awaits that writer', async () => {
    let acknowledge!: (version: number) => void;
    const harness = setup({ saveTimelineImpl: () => new Promise<number>((resolve) => { acknowledge = resolve; }) });
    const commitData = vi.fn((nextData: TimelineData) => {
      harness.editSeqRef.current += 1;
      harness.scheduleSave(nextData);
    });
    const ops = renderHook(() => useTimelineOps({
      dataRef: harness.dataRef,
      commitData,
      flushPendingSave: harness.result.current.flushPendingSave,
      createManualCheckpoint: vi.fn(),
      jumpToCheckpoint: vi.fn(),
      checkpoints: [],
    }));
    let applied: unknown;
    act(() => {
      applied = ops.result.current.apply({
        version: 1,
        operations: [{ op: 'track.update', target: 'V1', payload: { label: 'Acknowledged track' } }],
      });
    });
    expect(applied).not.toBeInstanceOf(Promise);
    expect(commitData).toHaveBeenCalledWith(expect.anything(), { save: true, semantic: true });
    expect(harness.saveTimeline).not.toHaveBeenCalled();
    let settled = false;
    let flushed!: ReturnType<typeof ops.result.current.flush>;
    await act(async () => {
      flushed = ops.result.current.flush().then((receipt) => { settled = true; return receipt; });
    });
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.saveTimeline.mock.calls[0]?.[1].tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'V1', label: 'Acknowledged track' }),
    ]));
    expect(settled).toBe(false);
    await act(async () => { acknowledge(8); });
    await expect(flushed).resolves.toEqual({ version: 8 });
    expect(harness.savedSeqRef.current).toBe(harness.editSeqRef.current);
  });

  it('refuses the save-for-render barrier while an interaction is active', async () => {
    const harness = setup();
    harness.interactionStateRef.current.drag = true;
    harness.scheduleSave(makeTimelineData('mid-drag-render'));

    await expect(harness.result.current.flushPendingSave()).rejects.toThrow(
      'Finish the current timeline interaction before rendering.',
    );
    expect(harness.saveTimeline).not.toHaveBeenCalled();
  });

  it('rejects the save-for-render barrier when the durable write fails', async () => {
    const harness = setup({
      saveTimelineImpl: async () => {
        throw new Error('bridge unavailable');
      },
    });
    harness.scheduleSave(makeTimelineData('failed-render-save'));

    await act(async () => {
      await expect(harness.result.current.flushPendingSave()).rejects.toThrow('bridge unavailable');
    });
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    harness.unmount();
  });

  it('rejects disabled persistence even when an earlier sequence is already saved', async () => {
    const harness = setup({ persistenceEnabled: false });
    harness.savedSeqRef.current = harness.editSeqRef.current;
    await expect(harness.result.current.flushPendingSave()).rejects.toThrow('persistence is unavailable');
    expect(harness.saveTimeline).not.toHaveBeenCalled();
  });

  it('rejects an unavailable writer and unloaded data before starting a save', async () => {
    const harness = setup();
    harness.dataRef.current = null;
    await expect(harness.result.current.flushPendingSave()).rejects.toThrow('Timeline data is not loaded');
    harness.dataRef.current = makeTimelineData('loaded');
    // A malformed/incomplete host must take a capability failure path.
    harness.provider.saveTimeline = undefined as unknown as DataProvider['saveTimeline'];
    await expect(harness.result.current.flushPendingSave()).rejects.toThrow('persistence is unavailable');
    expect(harness.saveTimeline).not.toHaveBeenCalled();
  });

  it('rejects a conflict with the existing error and cannot later claim that edit saved', async () => {
    const conflict = new TimelineVersionConflictError('stale timeline version', 1);
    const harness = setup({ saveTimelineImpl: async () => { throw conflict; } });
    harness.scheduleSave(makeTimelineData('conflict-flush'));
    await act(async () => {
      await expect(harness.result.current.flushPendingSave()).rejects.toBe(conflict);
    });
    expect(harness.savedSeqRef.current).toBe(0);
    await expect(harness.result.current.flushPendingSave()).rejects.toThrow('timeline version conflict');
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
  });

  it('an earlier receipt releases only the earlier sequence waiter', async () => {
    const receipts: Array<(version: number) => void> = [];
    const harness = setup({ saveTimelineImpl: () => new Promise<number>((resolve) => { receipts.push(resolve); }) });
    harness.scheduleSave(makeTimelineData('seq-one'));
    let first!: Promise<number>;
    await act(async () => { first = harness.result.current.flushPendingSave(); });
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);

    harness.editSeqRef.current = 2;
    harness.scheduleSave(makeTimelineData('seq-two'));
    let newerSettled = false;
    let newer!: Promise<number>;
    await act(async () => {
      newer = harness.result.current.flushPendingSave().then((version) => { newerSettled = true; return version; });
    });
    await act(async () => { receipts[0]!(2); });
    await expect(first).resolves.toBe(2);
    expect(newerSettled).toBe(false);
    expect(harness.savedSeqRef.current).toBe(1);
    expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
    expect(harness.saveTimeline.mock.calls[1]?.[2]).toBe(2);
    await act(async () => { receipts[1]!(3); });
    await expect(newer).resolves.toBe(3);
    expect(harness.savedSeqRef.current).toBe(2);
  });

  it('reuses a current acknowledged receipt without saving again, but not after session replacement', async () => {
    const harness = setup();
    harness.scheduleSave(makeTimelineData('acknowledged'));
    await act(async () => {
      await expect(harness.result.current.flushPendingSave()).resolves.toBe(2);
    });
    await expect(harness.result.current.flushPendingSave()).resolves.toBe(2);
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);

    // The host refs still carry the previous target's saved sequence. A new
    // session cannot borrow that receipt, even if its sequence is identical.
    let acknowledge!: (version: number) => void;
    const newWriter = vi.fn(() => new Promise<number>((resolve) => { acknowledge = resolve; }));
    harness.replaceSession({ ...harness.provider, saveTimeline: newWriter });
    let settled = false;
    let flushed!: Promise<number>;
    await act(async () => {
      flushed = harness.result.current.flushPendingSave().then((version) => { settled = true; return version; });
    });
    expect(newWriter).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await act(async () => { acknowledge(3); });
    await expect(flushed).resolves.toBe(3);
  });

  it('rejects an in-flight flush on unmount and rejects calls through the retained barrier', async () => {
    let acknowledge!: (version: number) => void;
    const harness = setup({ saveTimelineImpl: () => new Promise<number>((resolve) => { acknowledge = resolve; }) });
    harness.scheduleSave(makeTimelineData('close-flush'));
    const barrier = harness.result.current.flushPendingSave;
    let outcome!: Promise<number | Error>;
    await act(async () => { outcome = barrier().catch((error: Error) => error); });
    harness.unmount();
    expect(await outcome).toEqual(expect.objectContaining({ message: 'Timeline closed before durable acknowledgement.' }));
    await expect(barrier()).rejects.toThrow('closed or replaced');
    await act(async () => { acknowledge(9); });
    expect(harness.savedSeqRef.current).toBe(0);
    expect(harness.configVersionRef.current).toBe(1);
  });

  it.each(['provider', 'timeline'] as const)('rejects a flush on %s replacement and ignores a receipt after returning to the original target', async (kind) => {
    let acknowledge!: (version: number) => void;
    const harness = setup({ saveTimelineImpl: () => new Promise<number>((resolve) => { acknowledge = resolve; }) });
    harness.scheduleSave(makeTimelineData('replace-flush'));
    const oldBarrier = harness.result.current.flushPendingSave;
    let outcome!: Promise<number | Error>;
    await act(async () => { outcome = oldBarrier().catch((error: Error) => error); });
    harness.replaceSession(kind === 'provider' ? { ...harness.provider } : harness.provider, kind === 'timeline' ? 'timeline-2' : 'timeline-1');
    expect(await outcome).toEqual(expect.objectContaining({ message: 'Timeline session replaced before durable acknowledgement.' }));
    harness.replaceSession(harness.provider);
    await expect(oldBarrier()).rejects.toThrow('closed or replaced');
    await act(async () => { acknowledge(9); });
    expect(harness.savedSeqRef.current).toBe(0);
    expect(harness.configVersionRef.current).toBe(1);
  });

  it('a replaced session waiter waits for its own receipt after an obsolete save drains', async () => {
    let acknowledgeOld!: (version: number) => void;
    let acknowledgeNew!: (version: number) => void;
    const harness = setup({ saveTimelineImpl: () => new Promise<number>((resolve) => { acknowledgeOld = resolve; }) });
    let oldOutcome!: Promise<number | Error>;
    await act(async () => { oldOutcome = harness.result.current.flushPendingSave().catch((error: Error) => error); });
    const newWriter = vi.fn(() => new Promise<number>((resolve) => { acknowledgeNew = resolve; }));
    harness.replaceSession({ ...harness.provider, saveTimeline: newWriter });
    expect(await oldOutcome).toBeInstanceOf(Error);
    let newSettled = false;
    let newFlush!: Promise<number>;
    await act(async () => {
      newFlush = harness.result.current.flushPendingSave().then((version) => { newSettled = true; return version; });
    });
    await act(async () => { acknowledgeOld(40); });
    expect(newSettled).toBe(false);
    expect(harness.configVersionRef.current).toBe(1);
    expect(newWriter).toHaveBeenCalledTimes(1);
    await act(async () => { acknowledgeNew(2); });
    await expect(newFlush).resolves.toBe(2);
  });

  it('a replacement session flush does not wait behind the old session transport retry timer', async () => {
    const harness = setup({ saveTimelineImpl: async () => { throw new Error('old transport outcome unknown'); } });
    await act(async () => {
      await expect(harness.result.current.flushPendingSave()).rejects.toThrow('old transport outcome unknown');
    });
    expect(harness.result.current.saveStatus).toBe('retrying');
    const newWriter = vi.fn(async () => 5);
    harness.replaceSession({ ...harness.provider, saveTimeline: newWriter });
    await act(async () => {
      await expect(harness.result.current.flushPendingSave()).resolves.toBe(5);
      vi.advanceTimersByTime(1_000);
    });
    expect(newWriter).toHaveBeenCalledTimes(1);
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
  });

  it('rejects a flush when canonical reload invalidates its pending edit', async () => {
    let acknowledge!: (version: number) => void;
    const harness = setup({ saveTimelineImpl: () => new Promise<number>((resolve) => { acknowledge = resolve; }) });
    harness.scheduleSave(makeTimelineData('reload-flush'));
    let outcome!: Promise<number | Error>;
    await act(async () => { outcome = harness.result.current.flushPendingSave().catch((error: Error) => error); });
    let reloaded!: Promise<void>;
    await act(async () => { reloaded = harness.reloadFromServer(); });
    expect(await outcome).toEqual(expect.objectContaining({ message: 'Timeline reloaded before durable acknowledgement.' }));
    await expect(harness.result.current.flushPendingSave()).rejects.toThrow('Timeline is reloading');
    await act(async () => { acknowledge(2); await reloaded; });
  });

  it('rejects when timeline data unloads before the in-flight receipt arrives', async () => {
    let acknowledge!: (version: number) => void;
    const harness = setup({ saveTimelineImpl: () => new Promise<number>((resolve) => { acknowledge = resolve; }) });
    let outcome!: Promise<number | Error>;
    await act(async () => { outcome = harness.result.current.flushPendingSave().catch((error: Error) => error); });
    harness.dataRef.current = null;
    await act(async () => { acknowledge(2); });
    expect(await outcome).toEqual(expect.objectContaining({ message: 'Timeline data unloaded before durable acknowledgement.' }));
  });

  it('rejects if persistence is disabled before an in-flight receipt arrives', async () => {
    let acknowledge!: (version: number) => void;
    const harness = setup({ saveTimelineImpl: () => new Promise<number>((resolve) => { acknowledge = resolve; }) });
    let outcome!: Promise<number | Error>;
    await act(async () => { outcome = harness.result.current.flushPendingSave().catch((error: Error) => error); });
    harness.provider.persistenceEnabled = false;
    harness.replaceSession(harness.provider);
    expect(await outcome).toEqual(expect.objectContaining({ message: 'Durable timeline persistence is unavailable.' }));
    await act(async () => { acknowledge(2); });
  });

  it('suppresses autosave when provider persistence is disabled', async () => {
    const harness = setup({ persistenceEnabled: false });

    harness.scheduleSave(makeTimelineData('read-only'));

    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(harness.saveTimeline).not.toHaveBeenCalled();
  });

  // A transport failure (500, dropped connection) used to be retried by calling
  // scheduleSave() from the catch block. That lands in pendingSaveRef, which the
  // finally block drains immediately — so a permanently failing backend was
  // re-POSTed once per round trip with no gap, forever, and the chain kept
  // running after the editor unmounted.
  describe('transport-failure retry', () => {
    const advance = async (ms: number) => {
      await act(async () => {
        vi.advanceTimersByTime(ms);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    it('retries a failed save on a backoff, not once per round trip', async () => {
      const harness = setup({
        saveTimelineImpl: async () => {
          throw new Error('Astrid bridge save timeline failed: 500 Internal Server Error');
        },
      });

      harness.scheduleSave(makeTimelineData('flaky'));

      await advance(600);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(1);

      // First backoff is 500ms — nothing fires before it elapses.
      await advance(200);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(1);

      await advance(400);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(2);

      // Second backoff doubles to 1000ms.
      await advance(600);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(2);

      await advance(500);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(3);
    });

    it('stops retrying once the editor unmounts', async () => {
      const harness = setup({
        saveTimelineImpl: async () => {
          throw new Error('Astrid bridge save timeline failed: 500 Internal Server Error');
        },
      });

      harness.scheduleSave(makeTimelineData('flaky-unmount'));
      await advance(600);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(1);

      harness.unmount();
      await advance(10_000);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    });

    it('resumes normally once the backend recovers', async () => {
      let attempt = 0;
      const harness = setup({
        saveTimelineImpl: async () => {
          attempt += 1;
          if (attempt === 1) {
            throw new Error('Astrid bridge save timeline failed: 500 Internal Server Error');
          }
          return 2;
        },
      });

      harness.scheduleSave(makeTimelineData('recovers'));
      await advance(600);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(1);

      await advance(600);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(2);

      // Backoff is cleared by the successful save: no further attempts.
      await advance(10_000);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
    });
  });

  describe('a save that failed while Astrid was away', () => {
    const advance = async (ms: number) => {
      await act(async () => {
        vi.advanceTimersByTime(ms);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    const astridAway = () => Object.assign(new Error('Astrid is not answering'), { code: 'runtime_unavailable' });
    const outputFileOf = (call: ReadonlyArray<unknown>) => (call[1] as TimelineData['config']).output.file;

    it('waits for Astrid without a timer, then sends the very same save when told Astrid is back', async () => {
      let calls = 0;
      const harness = setup({
        saveTimelineImpl: async () => {
          calls += 1;
          if (calls === 1) throw astridAway();
          return 2;
        },
      });

      harness.scheduleSave(makeTimelineData('away'));
      await advance(600);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
      expect(harness.result.current.saveStatus).toBe('error');

      // No flood while it is away: nothing retries by itself.
      await advance(60_000);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(1);

      act(() => harness.result.current.retryPendingSave());
      await advance(0);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
      expect(harness.saveTimeline.mock.calls[1]).toEqual(harness.saveTimeline.mock.calls[0]);
      expect(harness.result.current.saveStatus).toBe('saved');
      expect(harness.result.current.isConflictExhausted).toBe(false);

      // And it does not send again.
      act(() => harness.result.current.retryPendingSave());
      await advance(10_000);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
    });

    it('does nothing when everything is saved already', async () => {
      const harness = setup();
      harness.scheduleSave(makeTimelineData('done'));
      await advance(600);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
      expect(harness.result.current.saveStatus).toBe('saved');

      act(() => harness.result.current.retryPendingSave());
      await advance(10_000);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    });

    it('does not send over a conflict the person has yet to settle', async () => {
      const harness = setup({
        saveTimelineImpl: async () => { throw new TimelineVersionConflictError('Another editor changed it'); },
      });
      harness.scheduleSave(makeTimelineData('conflicted'));
      await advance(600);
      expect(harness.result.current.isConflictExhausted).toBe(true);

      act(() => harness.result.current.retryPendingSave());
      await advance(10_000);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    });

    it('sends an edit made meanwhile behind the unanswered save: its own earlier save is not another writer, so no conflict', async () => {
      let calls = 0;
      const harness = setup({
        saveTimelineImpl: async () => {
          calls += 1;
          if (calls === 1) throw astridAway();
          // The second edit, sent beside the unanswered first one, is refused by the provider as the editor's own.
          if (calls === 2) throw new OwnUnacknowledgedSaveError('An unacknowledged save owns this timeline head and payload');
          return calls;
        },
      });

      harness.scheduleSave(makeTimelineData('first'));
      await advance(600);
      expect(harness.result.current.saveStatus).toBe('error');

      harness.editSeqRef.current = 2;
      harness.scheduleSave(makeTimelineData('second'));
      await advance(600);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
      expect(harness.result.current.isConflictExhausted).toBe(false);
      expect(harness.result.current.saveStatus).toBe('retrying');

      // The first save is sent again (under its own key), and the second goes after it.
      await advance(600);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(4);
      expect(outputFileOf(harness.saveTimeline.mock.calls[2])).toBe('output-first.mp4');
      expect(outputFileOf(harness.saveTimeline.mock.calls[3])).toBe('output-second.mp4');
      expect(harness.result.current.isConflictExhausted).toBe(false);
      expect(harness.result.current.saveStatus).toBe('saved');
      await advance(10_000);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(4);
    });

    it('sends the waiting save at once, instead of out its backoff, when told Astrid is back', async () => {
      let calls = 0;
      const harness = setup({
        saveTimelineImpl: async () => {
          calls += 1;
          if (calls === 1) throw astridAway();
          if (calls === 2) throw new OwnUnacknowledgedSaveError('An unacknowledged save owns this timeline head and payload');
          return calls;
        },
      });
      harness.scheduleSave(makeTimelineData('first'));
      await advance(600);
      harness.editSeqRef.current = 2;
      harness.scheduleSave(makeTimelineData('second'));
      await advance(600);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
      expect(harness.result.current.saveStatus).toBe('retrying');

      act(() => harness.result.current.retryPendingSave());
      await advance(0);
      expect(harness.saveTimeline).toHaveBeenCalledTimes(4);
      expect(harness.result.current.saveStatus).toBe('saved');
    });

    it('still names a conflict when the provider refuses an edit as the editor\'s own but no save of ours is waiting', async () => {
      const harness = setup({
        saveTimelineImpl: async () => { throw new OwnUnacknowledgedSaveError('An unacknowledged save owns this timeline head and payload'); },
      });
      harness.scheduleSave(makeTimelineData('orphan'));
      await advance(600);
      expect(harness.result.current.isConflictExhausted).toBe(true);
    });

    it('still names a conflict for a genuine second writer while a save of ours is waiting', async () => {
      let calls = 0;
      const harness = setup({
        saveTimelineImpl: async () => {
          calls += 1;
          if (calls === 1) throw astridAway();
          throw new TimelineVersionConflictError('Another editor changed the timeline');
        },
      });
      harness.scheduleSave(makeTimelineData('first'));
      await advance(600);
      harness.editSeqRef.current = 2;
      harness.scheduleSave(makeTimelineData('second'));
      await advance(600);
      expect(harness.result.current.isConflictExhausted).toBe(true);
    });
  });

  it('flushes a debounce-pending edit when the editor unmounts', async () => {
    const nextData = makeTimelineData('flush-on-unmount');
    const harness = setup({ initialData: nextData });
    harness.scheduleSave(nextData);
    harness.unmount();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.saveTimeline.mock.calls[0]?.[1].output.file).toBe('output-flush-on-unmount.mp4');
  });

  it('flushes an interaction-deferred edit when the editor unmounts', async () => {
    const nextData = makeTimelineData('flush-deferred-on-unmount');
    const harness = setup({ initialData: nextData });
    harness.interactionStateRef.current.drag = true;
    harness.scheduleSave(nextData);
    harness.unmount();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.saveTimeline.mock.calls[0]?.[1].output.file).toBe('output-flush-deferred-on-unmount.mp4');
  });

  it('keeps an exact matching retry 409 ambiguous when no provider receipt proves authorship', async () => {
    const nextData = makeTimelineData('lost-ack');
    let attempt = 0;
    const harness = setup({
      initialData: nextData,
      saveTimelineImpl: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('Astrid bridge save timeline failed: timeout');
        }
        throw new TimelineVersionConflictError();
      },
      loadReferencedTimelineImpl: async () => ({
        timeline: { config: nextData.config, configVersion: 2, bundle: null },
        registry: nextData.registry,
        resolveAssetUrl: async (file) => file,
      }),
    });

    harness.scheduleSave(nextData);
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
    expect(harness.loadReferencedTimeline).toHaveBeenCalledTimes(1);
    expect(harness.result.current.isConflictExhausted).toBe(true);
    expect(harness.result.current.saveStatus).toBe('error');
    expect((await loadTimelineDraft('timeline-1'))?.draft).toEqual({
      config: nextData.config,
      registry: nextData.registry,
      bundle: null,
    });
  });

  it('retries the exact old attempt and keeps a newer draft when matching readback is ambiguous', async () => {
    const firstData = makeTimelineData('lost-ack-older');
    const newerData = makeTimelineData('lost-ack-newer');
    let attempt = 0;
    let releaseFresh!: () => void;
    const freshRead = new Promise<void>((resolve) => { releaseFresh = resolve; });
    const harness = setup({
      initialData: firstData,
      saveTimelineImpl: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('Astrid bridge save timeline failed: timeout');
        }
        if (attempt === 2) {
          throw new TimelineVersionConflictError();
        }
        return 3;
      },
      loadReferencedTimelineImpl: async () => {
        await freshRead;
        return {
          timeline: { config: firstData.config, configVersion: 2, bundle: null },
          registry: firstData.registry,
          resolveAssetUrl: async (file) => file,
        };
      },
    });

    harness.scheduleSave(firstData);
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // A newer edit arrives after the timeout but before its retry. It must be
    // queued separately; the retry still owns the original payload and seq.
    harness.editSeqRef.current = 2;
    harness.scheduleSave(newerData);
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
    expect(harness.saveTimeline.mock.calls[1]?.[1]).toEqual(firstData.config);
    expect(harness.saveTimeline.mock.calls[1]?.[2]).toBe(1);

    // Exact content readback is still not an authorship receipt. The old
    // sequence stays unacknowledged and the newer edit remains recoverable.
    releaseFresh();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
    expect(harness.loadReferencedTimeline).toHaveBeenCalledTimes(1);
    expect(harness.result.current.isConflictExhausted).toBe(true);
    expect((await loadTimelineDraft('timeline-1'))?.draft).toEqual({
      config: newerData.config,
      registry: newerData.registry,
      bundle: null,
    });
    harness.unmount();
  });

  it('keeps a retry 409 as a genuine conflict when fresh state differs', async () => {
    const nextData = makeTimelineData('lost-ack-mismatch');
    let attempt = 0;
    const otherData = makeTimelineData('other-writer');
    const harness = setup({
      initialData: nextData,
      saveTimelineImpl: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('Astrid bridge save timeline failed: timeout');
        }
        throw new TimelineVersionConflictError();
      },
      loadReferencedTimelineImpl: async () => ({
        timeline: { config: otherData.config, configVersion: 2, bundle: null },
        registry: otherData.registry,
        resolveAssetUrl: async (file) => file,
      }),
    });

    harness.scheduleSave(nextData);
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
    expect(harness.result.current.isConflictExhausted).toBe(true);
    expect(harness.result.current.saveStatus).toBe('error');
    expect((await loadTimelineDraft('timeline-1'))?.draft).toEqual({
      config: nextData.config,
      registry: nextData.registry,
      bundle: null,
    });
  });

  it('does not invent lost-ack success when config and registry match but the bundle differs', async () => {
    const nextData = makeTimelineData('lost-ack-bundle');
    const attemptedBundle = makeBundle('attempted');
    const remoteBundle = makeBundle('other-writer');
    let attempt = 0;
    const harness = setup({
      initialData: nextData,
      saveTimelineImpl: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('Astrid bridge save timeline failed: timeout');
        throw new TimelineVersionConflictError();
      },
      loadTimelineImpl: async () => ({ config: nextData.config, configVersion: 1, bundle: attemptedBundle }),
      loadAssetRegistryImpl: async () => nextData.registry,
      loadReferencedTimelineImpl: async () => ({
        timeline: { config: nextData.config, configVersion: 2, bundle: remoteBundle },
        registry: nextData.registry,
        resolveAssetUrl: async (file) => file,
      }),
    });

    await act(async () => { await harness.reloadFromServer(); });
    harness.scheduleSave(nextData);
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
    expect(harness.saveTimeline.mock.calls[0]?.[4]).toEqual(attemptedBundle);
    expect(harness.saveTimeline.mock.calls[1]?.[4]).toEqual(attemptedBundle);
    expect(harness.result.current.isConflictExhausted).toBe(true);
    expect((await loadTimelineDraft('timeline-1'))?.draft).toEqual({
      config: nextData.config,
      registry: nextData.registry,
      bundle: attemptedBundle,
    });
  });

  it('keeps queued save ordering and lets an undo supersede only the later queued payload', async () => {
    const firstData = makeTimelineData('queue-first');
    const interimData = makeTimelineData('queue-interim');
    const undoData = makeTimelineData('queue-undo');
    let settleFirst!: (version: number) => void;
    let settleUndo!: (version: number) => void;
    let call = 0;
    const harness = setup({
      initialData: firstData,
      saveTimelineImpl: async () => {
        call += 1;
        return new Promise<number>((resolve) => {
          if (call === 1) settleFirst = resolve;
          else settleUndo = resolve;
        });
      },
    });

    harness.scheduleSave(firstData);
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    harness.editSeqRef.current = 2;
    harness.scheduleSave(interimData);
    harness.editSeqRef.current = 3;
    harness.scheduleSave(undoData);
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);

    act(() => { settleFirst(2); });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
    expect(harness.saveTimeline.mock.calls[1]?.[1]).toEqual(undoData.config);
    expect(harness.saveTimeline.mock.calls[1]?.[2]).toBe(2);
    expect((await loadTimelineDraft('timeline-1'))?.draft).toEqual({
      config: undoData.config,
      registry: undoData.registry,
      bundle: null,
    });

    act(() => { settleUndo(3); });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.result.current.saveStatus).toBe('saved');
    expect(await loadTimelineDraft('timeline-1')).toBeNull();
  });

  it.each([
    [
      'registration-first then clip-first',
      makeTimelineData('registration-first', makeRegistry('registration-first')),
      makeTimelineData('clip-first', makeRegistry('clip-first')),
    ],
    [
      'clip-first then registration-first',
      makeTimelineData('clip-first-reverse', makeRegistry('clip-first-reverse')),
      makeTimelineData('registration-first-reverse', makeRegistry('registration-first-reverse')),
    ],
  ])('serializes %s edits as ordered compound CAS payloads', async (_order, firstData, secondData) => {
    let settleFirst!: (version: number) => void;
    let settleSecond!: (version: number) => void;
    let call = 0;
    const expectedVersions: number[] = [];
    const harness = setup({
      initialData: firstData,
      saveTimelineImpl: async (_timelineId, _config, expectedVersion) => {
        call += 1;
        expectedVersions.push(expectedVersion);
        return new Promise<number>((resolve) => {
          if (call === 1) settleFirst = resolve;
          else settleSecond = resolve;
        });
      },
    });

    harness.scheduleSave(firstData);
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    harness.editSeqRef.current = 2;
    harness.scheduleSave(secondData);
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);

    act(() => { settleFirst(2); });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
    expect(expectedVersions).toEqual([1, 2]);
    expect(harness.saveTimeline.mock.calls[0]?.[1]).toEqual(firstData.config);
    expect(harness.saveTimeline.mock.calls[0]?.[3]).toEqual(firstData.registry);
    expect(harness.saveTimeline.mock.calls[1]?.[1]).toEqual(secondData.config);
    expect(harness.saveTimeline.mock.calls[1]?.[3]).toEqual(secondData.registry);

    act(() => { settleSecond(3); });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.result.current.saveStatus).toBe('saved');
  });

  it('warns when the backend\'s config_version goes backwards', async () => {
    // Versions are monotonic per backend generation. A decrease means the
    // backend lost its history (a restarted local bridge back at its seed) and
    // the save that just landed re-pushed the browser's copy — the badge will
    // read `saved` again, so this is the only signal the developer gets.
    const versions = [9, 2];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const harness = setup({ saveTimelineImpl: async () => versions.shift() ?? 2 });

    harness.scheduleSave(makeTimelineData('first'));
    await act(async () => { vi.advanceTimersByTime(600); await Promise.resolve(); });
    expect(warn).not.toHaveBeenCalled();

    harness.scheduleSave(makeTimelineData('second'));
    await act(async () => { vi.advanceTimersByTime(600); await Promise.resolve(); });

    expect(warn).toHaveBeenCalledWith(
      '[TimelineSave] bridge config_version went backwards (restart?) — local state re-pushed',
      { from: 9, to: 2 },
    );
    warn.mockRestore();
  });

  // Fix (b): a save RECEIPT is metadata, not a new timeline document. The ack
  // must advance the canonical version channel (configVersionRef + the store
  // field outside the data object) WITHOUT committing a new data object — a
  // version-only commitData rebuilds the editor-data slice and triggers the
  // O(n) render cascade that stalled the main thread mid-drag.
  describe('version-only ack (receipt metadata vs document state)', () => {
    it('advances the canonical version, preserves document identities, and the next save uses the acked version', async () => {
      const store = createTimelineStore();
      const versions = [2, 3];
      const harness = setup({
        store,
        saveTimelineImpl: async () => versions.shift() ?? 3,
      });

      // Editor + clip render probes mounted against the SAME store the ack
      // updates. They subscribe exactly like TimelineEditorCore (`data` slice
      // / clip list identity) and count ACTUAL component renders, so a
      // receipt-only ack re-rendering either of them would fail the test.
      const editorRenders = { current: 0 };
      const clipRenders = { current: 0 };
      function EditorRenderProbe() {
        useTimelineDataSelector((data) => data.data);
        editorRenders.current += 1;
        return null;
      }
      function ClipRenderProbe() {
        useTimelineDataSelector((data) => data.data?.config.clips ?? null);
        clipRenders.current += 1;
        return null;
      }
      render(
        <TimelineStoreProvider store={store}>
          <EditorRenderProbe />
          <ClipRenderProbe />
        </TimelineStoreProvider>,
      );
      // Baseline: one render each against the empty initial data slice.
      expect(editorRenders.current).toBe(1);
      expect(clipRenders.current).toBe(1);

      // Simulate the mounted editor pushing its data slice (useTimelineState
      // does this on mount/commit); the probes now observe the real document.
      const initialData = makeTimelineData('ack');
      act(() => {
        store.getState().syncSlices({ data: { ...store.getState().data, data: initialData } });
      });
      expect(editorRenders.current).toBe(2);
      expect(clipRenders.current).toBe(2);

      harness.scheduleSave(initialData);

      await act(async () => {
        vi.advanceTimersByTime(600);
        await Promise.resolve();
        await Promise.resolve();
      });

      // (a) The ack advances the version: the CAS ref AND the store channel.
      expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
      expect(harness.saveTimeline.mock.calls[0]![2]).toBe(1);
      expect(store.getState().configVersion).toBe(2);

      // (b) A receipt-only ack must NOT commit a new data object (that is the
      // setData → TimelineEditorCore re-render → O(n) cascade trigger).
      expect(harness.commitData).not.toHaveBeenCalled();

      // (c) Document / row / ACTION object identities are unchanged — SAME
      // references, not just deep-equal.
      expect(harness.dataRef.current).toBe(initialData);
      expect(harness.dataRef.current?.config).toBe(initialData.config);
      expect(harness.dataRef.current?.rows).toBe(initialData.rows);
      expect(harness.dataRef.current?.tracks).toBe(initialData.tracks);
      expect(initialData.rows.length).toBeGreaterThan(0);
      expect(initialData.rows[0]!.actions.length).toBeGreaterThan(0);
      expect(harness.dataRef.current?.rows[0]).toBe(initialData.rows[0]);
      expect(harness.dataRef.current?.rows[0]!.actions).toBe(initialData.rows[0]!.actions);
      expect(harness.dataRef.current?.rows[0]!.actions[0]).toBe(initialData.rows[0]!.actions[0]);

      // (d) The editor and clip render counters did NOT advance on the ack.
      expect(editorRenders.current).toBe(2);
      expect(clipRenders.current).toBe(2);

      // (e) The next save uses the acked version as its CAS expectation.
      const secondData = makeTimelineData('ack-second');
      harness.scheduleSave(secondData);
      await act(async () => {
        vi.advanceTimersByTime(600);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
      expect(harness.saveTimeline.mock.calls[1]![2]).toBe(2);
      expect(store.getState().configVersion).toBe(3);
      // Still no data commit on the second ack — and still no editor/clip
      // re-render.
      expect(harness.commitData).not.toHaveBeenCalled();
      expect(editorRenders.current).toBe(2);
      expect(clipRenders.current).toBe(2);

      // (f) Positive control: a REAL data commit (new data object) DOES
      // re-render both probes — the counters are live, and the quiet ack path
      // is what keeps them flat above.
      act(() => {
        store.getState().syncDataSlice({ ...store.getState().data, data: makeTimelineData('ack-committed') });
      });
      expect(editorRenders.current).toBe(3);
      expect(clipRenders.current).toBe(3);
    });
  });

  it('doSave passes registry to saveTimeline', async () => {
    const harness = setup();
    const registry = makeRegistry('save');
    const nextData = makeTimelineData('with-registry', registry);

    harness.scheduleSave(nextData);

    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    // 5th slot is the optional data-bundle arg (V2): undefined until a
    // reload populates loadedBundleRef.
    expect(harness.saveTimeline).toHaveBeenCalledWith('timeline-1', nextData.config, 1, registry, undefined);
  });

  it('preserves Astrid media_id through load, edit rebuild, and save', async () => {
    const registry: AssetRegistry = {
      assets: {
        'motion-output-audio.aac': {
          file: 'motion-output-audio.aac',
          media_id: '01jpairedreleaseasset000001',
          type: 'audio/aac',
        },
      },
    };
    const source = makeTimelineData('astrid-media-id').config;
    const loaded = await buildTimelineData(source, registry);
    const edited = buildDataFromCurrentRegistry({
      ...loaded.config,
      clips: loaded.config.clips.map((clip) => ({ ...clip, at: clip.at + 1 })),
    }, loaded);
    const harness = setup({ initialData: loaded });

    harness.scheduleSave(edited);

    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    const savedRegistry = harness.saveTimeline.mock.calls[0]?.[3] as AssetRegistry;
    expect(savedRegistry.assets['motion-output-audio.aac']?.media_id)
      .toBe('01jpairedreleaseasset000001');
  });

  it('a 409 enters diverged: no version reload, no re-POST (CAS-defeating retry removed)', async () => {
    const staleRegistry = makeRegistry('stale');
    const nextData = makeTimelineData('conflict', staleRegistry);
    const harness = setup({
      initialData: nextData,
      persistenceEnabled: true,
      saveTimelineImpl: async () => {
        throw new TimelineVersionConflictError();
      },
    });

    harness.scheduleSave(nextData);

    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Diverged state, exactly one POST, no remote version reload, no repost.
    expect(harness.result.current.isConflictExhausted).toBe(true);
    expect(harness.result.current.saveStatus).toBe('error');
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.loadTimeline).not.toHaveBeenCalled();
    expect(harness.loadAssetRegistry).not.toHaveBeenCalled();
  });
  it('maps a typed canonical stale write to terminal conflict without losing the draft', async () => {
    const nextData = makeTimelineData('canonical-stale');
    const harness = setup({
      persistenceEnabled: true,
      saveTimelineImpl: async () => {
        throw new StaleWriteError('canonical head advanced');
      },
    });

    harness.scheduleSave(nextData);
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.result.current.isConflictExhausted).toBe(true);
    expect(harness.result.current.saveStatus).toBe('error');
    expect(harness.dataRef.current?.stableSignature).toBe(nextData.stableSignature);
    expect(await loadTimelineDraft('timeline-1')).toMatchObject({
      draft: { config: nextData.config },
    });
  });


  it('retains the recovery draft after a 409 and transport failure, and clears it only after success', async () => {
    const conflict = setup({
      persistenceEnabled: true,
      saveTimelineImpl: async () => {
        throw new TimelineVersionConflictError();
      },
    });
    const conflictData = makeTimelineData('draft-conflict');
    conflict.scheduleSave(conflictData);
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await loadTimelineDraft('timeline-1')).not.toBeNull();
    conflict.unmount();

    resetFakeIndexedDB();
    const transport = setup({
      persistenceEnabled: true,
      saveTimelineImpl: async () => {
        throw new Error('bridge unavailable');
      },
    });
    transport.scheduleSave(makeTimelineData('draft-transport'));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await loadTimelineDraft('timeline-1')).not.toBeNull();
    transport.unmount();

    resetFakeIndexedDB();
    const success = setup({ persistenceEnabled: true });
    await saveTimelineDraft(
      'timeline-1',
      { config: makeTimelineData('old').config, registry: { assets: {} } },
      1,
    );
    success.scheduleSave(makeTimelineData('draft-success'));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(success.saveTimeline).toHaveBeenCalledTimes(1);
    expect(await loadTimelineDraft('timeline-1')).toBeNull();
  });

  it('autosave freezes while diverged (further edits do not POST)', async () => {
    const harness = setup({
      persistenceEnabled: true,
      saveTimelineImpl: async () => {
        throw new TimelineVersionConflictError();
      },
    });
    harness.scheduleSave(makeTimelineData('conflict'));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.result.current.isConflictExhausted).toBe(true);

    // A subsequent edit while diverged must not fire another POST.
    harness.scheduleSave(makeTimelineData('conflict-2'));
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
  });

  it('save as copy stashes a draft then reloads (no silent overwrite)', async () => {
    const bundle = makeBundle('save-as-copy');
    const localData = makeTimelineData('conflict');
    const harness = setup({
      initialData: localData,
      persistenceEnabled: true,
      saveTimelineImpl: async () => {
        throw new TimelineVersionConflictError();
      },
      loadTimelineImpl: async () => ({
        config: createDefaultTimelineConfig(),
        configVersion: 1,
        bundle,
      }),
    });
    await act(async () => { await harness.reloadFromServer(); });
    harness.scheduleSave(localData);
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.result.current.isConflictExhausted).toBe(true);

    const loadBefore = harness.loadTimeline.mock.calls.length;
    await act(async () => {
      await harness.result.current.retrySaveAfterConflict();
      await Promise.resolve();
    });
    // Diverged cleared, server reloaded, and the local save was NOT re-POSTed.
    expect(harness.result.current.isConflictExhausted).toBe(false);
    expect(harness.loadTimeline.mock.calls.length).toBeGreaterThan(loadBefore);
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    // Save-as-copy deliberately preserves the just-stashed local work across
    // the server reload.
    expect((await loadTimelineDraft('timeline-1'))?.draft).toEqual({
      config: localData.config,
      registry: localData.registry,
      bundle,
    });
  });

  it('direct reload adopts server state and clears a diverged recovery draft', async () => {
    const harness = setup({ persistenceEnabled: true });
    harness.scheduleSave(makeTimelineData('local-before-reload'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await loadTimelineDraft('timeline-1')).not.toBeNull();

    await act(async () => {
      await harness.reloadFromServer();
    });
    expect(await loadTimelineDraft('timeline-1')).toBeNull();
  });

  it('Retry then Discard before debounce cancels the recovered publication and reopens canonical', async () => {
    const canonical = makeTimelineData('canonical-after-discard');
    const harness = setup({
      loadTimelineImpl: async () => ({ config: canonical.config, configVersion: 8 }),
    });
    harness.scheduleSave(makeTimelineData('recovered-retry-pending'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(await loadTimelineDraft('timeline-1')).not.toBeNull();

    await act(async () => { await harness.reloadFromServer(); });
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.saveTimeline).not.toHaveBeenCalled();
    expect(await loadTimelineDraft('timeline-1')).toBeNull();
    expect(harness.commitData).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ clips: canonical.config.clips }),
    }), expect.objectContaining({ save: false, skipHistory: true }));
    await expect(harness.provider.loadTimeline('timeline-1')).resolves.toMatchObject({
      config: { clips: canonical.config.clips },
      configVersion: 8,
    });
    harness.unmount();
  });

  it('waits for an in-flight acknowledgement before Discard reads canonical and never drains queued B', async () => {
    let acknowledgeSaveA: ((version: number) => void) | null = null;
    const events: string[] = [];
    const canonical = makeTimelineData('canonical-after-ack');
    const harness = setup({
      saveTimelineImpl: () => {
        events.push('save-start');
        return new Promise<number>((resolve) => { acknowledgeSaveA = resolve; });
      },
      loadTimelineImpl: async () => {
        events.push('canonical-read');
        return { config: canonical.config, configVersion: 9 };
      },
    });
    harness.scheduleSave(makeTimelineData('retry-in-flight-A'));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);

    harness.editSeqRef.current = 2;
    harness.scheduleSave(makeTimelineData('discarded-queued-B'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const reload = harness.reloadFromServer();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(events).toEqual(['save-start']);
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);

    await act(async () => { acknowledgeSaveA?.(2); });
    await act(async () => { await reload; });
    expect(events).toEqual(['save-start', 'canonical-read']);
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(await loadTimelineDraft('timeline-1')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.commitData).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ clips: canonical.config.clips }),
    }), expect.objectContaining({ save: false, skipHistory: true }));
    harness.unmount();
  });

  it('keeps recovery and reports reload failure instead of claiming Discard succeeded', async () => {
    const harness = setup({
      loadTimelineImpl: async () => { throw new Error('canonical read failed'); },
    });
    harness.scheduleSave(makeTimelineData('recoverable-after-reload-failure'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    await act(async () => {
      await expect(harness.reloadFromServer()).rejects.toThrow('canonical read failed');
    });

    expect(harness.result.current.saveStatus).toBe('error');
    expect(await loadTimelineDraft('timeline-1')).not.toBeNull();
    expect(harness.commitData).not.toHaveBeenCalled();
    harness.unmount();
  });

  it('explicit canonical reload bypasses and clears a stable occurrence recovery slot', async () => {
    const recoveryKey = 'parent:shot:occurrence';
    const canonical = makeTimelineData('canonical-reload');
    const loadCanonicalTimeline = vi.fn(async () => ({ config: canonical.config, configVersion: 4 }));
    const harness = setup({
      initialData: makeTimelineData('visible-recovery'),
      recoveryMetadata: { recoveryKey },
      loadCanonicalTimelineImpl: loadCanonicalTimeline,
    });
    await saveTimelineDraft('session-new', {
      config: makeTimelineData('unsaved-recovery').config,
      registry: { assets: {} },
    }, 1, { recoveryKey, draftIdentity: 'recovered-unsaved' });

    await act(async () => { await harness.reloadFromServer(); });

    expect(loadCanonicalTimeline).toHaveBeenCalledWith('timeline-1');
    expect(await loadTimelineDraft(recoveryKey)).toBeNull();
    expect(harness.commitData).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ clips: canonical.config.clips }),
    }), expect.objectContaining({ save: false, skipHistory: true }));
    harness.unmount();
  });

  it('best-effort draft writes tolerate private-mode IndexedDB rejection', async () => {
    const harness = setup({ persistenceEnabled: true });
    const originalIndexedDb = (globalThis as Record<string, unknown>).indexedDB;
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('IndexedDB is blocked in private mode');
      },
    });

    expect(() => harness.scheduleSave(makeTimelineData('private-mode'))).not.toThrow();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    vi.stubGlobal('indexedDB', originalIndexedDb);
  });

  it('reloadFromServer rebuilds timeline data through the asset resolver', async () => {
    const registry = makeRegistry('reload');
    const base = createDefaultTimelineConfig();
    const loadedConfig = {
      ...base,
      output: { ...base.output, file: 'output-reload.mp4' },
      tracks: (base.tracks ?? []).map((track) => ({ ...track })),
      clips: [{
        id: 'clip-reload',
        at: 0,
        track: 'V1' as const,
        clipType: 'media' as const,
        asset: 'asset-reload',
        from: 0,
        to: 2,
      }],
    };
    const harness = setup({
      initialData: makeTimelineData('reload-initial', registry),
      loadTimelineImpl: async () => ({ config: loadedConfig, configVersion: 3 }),
      loadAssetRegistryImpl: async () => registry,
    });

    harness.assetResolver.onResolve = vi.fn(async ({ file }) => `resolved:${file}`);

    await act(async () => {
      await harness.reloadFromServer();
    });

    expect(harness.assetResolver.onResolve).toHaveBeenCalledWith({
      assetId: 'asset-reload',
      entry: registry.assets['asset-reload'],
      file: 'media/reload.mp4',
      timelineId: 'timeline-1',
    });
  });

  it('reloadFromServer captures a persisted bundle and the next save re-persists it', async () => {
    const bundle = {
      schema_version: 1 as const,
      itemsBySchemaRef: {
        'astrid.transcript_segment/v1': [{
          id: 'assetA:src:0',
          shape: 'interval' as const,
          domain: 'source_seconds' as const,
          extent: { start: 0, end: 1.5 },
          schemaRef: 'astrid.transcript_segment/v1',
          payload: { text: 'hello' },
          sourceArtifactRef: { assetId: 'assetA' },
          provenance: { adapterId: 'astrid.adaptTranscript', adapterVersion: '1' },
        }],
      },
    };
    const harness = setup({
      initialData: makeTimelineData('bundle-reload'),
      loadTimelineImpl: async () => ({
        config: createDefaultTimelineConfig(),
        configVersion: 3,
        bundle,
      }),
    });

    await act(async () => {
      await harness.reloadFromServer();
    });
    expect(harness.result.current.loadedBundleRef.current).toEqual(bundle);

    harness.scheduleSave(makeTimelineData('after-bundle-reload'));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(harness.saveTimeline).toHaveBeenCalledWith(
      'timeline-1',
      expect.anything(),
      3,
      expect.anything(),
      bundle,
    );
  });

});

describe('useTimelinePersistence — schema incompatibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFakeIndexedDB();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('surfaces typed 422 issues and freezes autosave retries until reload', async () => {
    const issues = [{ pointer: '/config/output', code: 'invalid_type', message: 'expected object' }];
    const harness = setup({
      saveTimelineImpl: async () => {
        throw new TimelineSchemaIncompatibleError('payload failed schema validation', issues);
      },
    });
    harness.scheduleSave(makeTimelineData('schema-rejected'));

    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.result.current.schemaIncompatible).toEqual(issues);
    expect(harness.result.current.saveStatus).toBe('error');

    harness.scheduleSave(makeTimelineData('schema-rejected-edit'));
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);

    await act(async () => {
      await harness.reloadFromServer();
    });
    expect(harness.result.current.schemaIncompatible).toBeNull();
    expect(harness.result.current.saveStatus).toBe('saved');
  });
});

describe('useTimelinePersistence — write-ack watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFakeIndexedDB();
  });

  // React Query defers mutationFn onto microtasks; flush them after advancing.
  const advance = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('trips after the grace period when a save never acknowledges', async () => {
    // A save that never settles: doSave starts, the watchdog sees no receipt.
    const harness = setup({
      persistenceEnabled: true,
      saveTimelineImpl: () => new Promise<number>(() => {}),
    });

    harness.scheduleSave(makeTimelineData('hang'));
    await advance(600); // debounce fires, save hangs
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);

    await advance(WATCHDOG_GRACE_MS - 600 - 1); // Just before the deadline, including the elapsed debounce.
    expect(harness.result?.current.watchdogTripped).toBe(false);
    await advance(2); // Past the computed deadline, trips.
    expect(harness.result?.current.watchdogTripped).toBe(true);
  });

  it('clears on a durable save receipt (saveSuccess)', async () => {
    const harness = setup({
      persistenceEnabled: true,
      saveTimelineImpl: () => new Promise<number>(() => {}),
    });

    harness.scheduleSave(makeTimelineData('hang'));
    await advance(WATCHDOG_GRACE_MS + 1);
    expect(harness.result?.current.watchdogTripped).toBe(true);

    act(() => { harness.eventBus.emit('saveSuccess'); });
    expect(harness.result?.current.watchdogTripped).toBe(false);
  });

  it('does NOT trip when a slow-but-valid save ACKs just inside the bridge request window', async () => {
    let settle: ((v: number) => void) | null = null;
    const harness = setup({
      persistenceEnabled: true,
      saveTimelineImpl: () => new Promise<number>((resolve) => { settle = resolve; }),
    });

    harness.scheduleSave(makeTimelineData('slow-ack'));
    await advance(600); // debounce fires, save in flight
    await advance(BRIDGE_REQUEST_TIMEOUT_MS - 700); // Total elapsed is 100ms inside the request deadline.
    expect(harness.result?.current.watchdogTripped).toBe(false);

    // The receipt lands inside the shared request window and clears the watchdog.
    act(() => { settle?.(2); });
    await advance(0);
    expect(harness.result?.current.saveStatus).toBe('saved');
    expect(harness.result?.current.watchdogTripped).toBe(false);

    // No latent trip fires after the ack.
    await advance(WATCHDOG_GRACE_MS + 1);
    expect(harness.result?.current.watchdogTripped).toBe(false);
  });

  it('does NOT trip when a save ACKs after the request window but within the retry allowance', async () => {
    let settle: ((v: number) => void) | null = null;
    const harness = setup({
      persistenceEnabled: true,
      saveTimelineImpl: () => new Promise<number>((resolve) => { settle = resolve; }),
    });

    harness.scheduleSave(makeTimelineData('late-ack'));
    await advance(600);
    // Total elapsed is one retry base after the bridge deadline, still inside
    // the computed grace (debounce + request window + two retry bases).
    await advance(BRIDGE_REQUEST_TIMEOUT_MS + SAVE_ERROR_RETRY_BASE_MS - 600);
    expect(harness.result?.current.watchdogTripped).toBe(false);

    act(() => { settle?.(2); });
    await advance(0);
    expect(harness.result?.current.watchdogTripped).toBe(false);
    expect(harness.result?.current.saveStatus).toBe('saved');

    await advance(WATCHDOG_GRACE_MS + 1);
    expect(harness.result?.current.watchdogTripped).toBe(false);
  });

  it('timeout -> retry -> success transitions through retrying and never shows error', async () => {
    let attempt = 0;
    const harness = setup({
      persistenceEnabled: true,
      saveTimelineImpl: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('Astrid bridge save timeline failed: 500 Internal Server Error');
        }
        return 2;
      },
    });

    harness.scheduleSave(makeTimelineData('retry-success'));
    await advance(600); // debounce fires, attempt 1 fails -> retrying
    expect(harness.result?.current.saveStatus).toBe('retrying');
    expect(harness.result?.current.watchdogTripped).toBe(false);

    await advance(600); // 500ms backoff elapses, attempt 2 succeeds
    expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
    expect(harness.result?.current.saveStatus).toBe('saved');
    expect(harness.result?.current.watchdogTripped).toBe(false);

    // The retried save ACKed well inside the grace window — no latent trip.
    await advance(WATCHDOG_GRACE_MS + 1);
    expect(harness.result?.current.watchdogTripped).toBe(false);
  });

  it('does not arm the watchdog while an interaction defers the save', async () => {
    const harness = setup({ persistenceEnabled: true });
    harness.interactionStateRef.current.drag = true;

    harness.scheduleSave(makeTimelineData('mid-drag'));

    // A full grace period elapses, but no watchdog can trip because it is only
    // armed once the deferral ends (and the flush re-arms).
    await advance(WATCHDOG_GRACE_MS + 1);
    expect(harness.result?.current.watchdogTripped).toBe(false);

    await act(async () => {
      harness.interactionStateRef.current.drag = false;
      notifyInteractionEndIfIdle(harness.interactionStateRef);
      await Promise.resolve();
    });
    await advance(600); // debounce fires, save succeeds
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.result?.current.watchdogTripped).toBe(false);
    expect(harness.result?.current.saveStatus).toBe('saved');
  });

  it('disarms the watchdog when an interaction defers an ALREADY-PENDING save (no false trip during a full-grace drag)', async () => {
    const harness = setup({ persistenceEnabled: true });

    // Save scheduled while idle: the debounce and computed write-ack grace
    // are armed together.
    harness.scheduleSave(makeTimelineData('pre-drag'));
    expect(harness.saveTimeline).not.toHaveBeenCalled();

    // The drag begins BEFORE the debounce fires. The deferral branch cancels
    // the pending debounce — and must ALSO disarm the watchdog, or the long
    // drag below would trip a false error with no POST ever fired.
    harness.interactionStateRef.current.drag = true;
    harness.scheduleSave(makeTimelineData('mid-drag'));

    // The full grace elapses with NO POST: the pre-fix race would trip the
    // watchdog here (it was armed with the pre-drag debounce).
    await advance(WATCHDOG_GRACE_MS + 1);
    expect(harness.saveTimeline).not.toHaveBeenCalled();
    expect(harness.result?.current.watchdogTripped).toBe(false);

    // Gesture ends: the deferred payload flushes through scheduleSave, which
    // re-arms the watchdog, POSTs, and ACKs — the error path stays clean.
    await act(async () => {
      harness.interactionStateRef.current.drag = false;
      notifyInteractionEndIfIdle(harness.interactionStateRef);
      await Promise.resolve();
    });
    await advance(600); // debounce fires, save succeeds
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    expect(harness.result?.current.watchdogTripped).toBe(false);
    expect(harness.result?.current.watchdogReason).toBeNull();
    expect(harness.result?.current.saveStatus).toBe('saved');

    // No latent trip from the pre-drag arm can fire later either.
    await advance(WATCHDOG_GRACE_MS + 1);
    expect(harness.result?.current.watchdogTripped).toBe(false);
  });

  it('an older save ACK does not clear the sole watchdog while a newer edit is pending', async () => {
    let settleA: ((v: number) => void) | null = null;
    let settleB: ((v: number) => void) | null = null;
    const harness = setup({
      persistenceEnabled: true,
      saveTimelineImpl: () => new Promise<number>((resolve) => {
        if (!settleA) {
          settleA = resolve;
        } else {
          settleB = resolve;
        }
      }),
    });

    // Save A (seq 1) goes in flight; the watchdog arms when it is scheduled.
    harness.scheduleSave(makeTimelineData('save-a'));
    await advance(600);
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);

    // A newer edit (seq 2) lands while A is still in flight — it queues.
    harness.editSeqRef.current = 2;
    harness.scheduleSave(makeTimelineData('save-b'));
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((await loadTimelineDraft('timeline-1'))?.draft).toEqual({
      config: makeTimelineData('save-b').config,
      registry: makeTimelineData('save-b').registry,
      bundle: null,
    });

    // A's ACK arrives: it does not cover the newest edit, so it must NOT
    // clear the sole watchdog. The queued save B drains and hangs.
    act(() => { settleA?.(2); });
    await advance(0);
    expect(harness.saveTimeline).toHaveBeenCalledTimes(2);
    expect(harness.saveTimeline.mock.calls[1]?.[1]).toEqual(makeTimelineData('save-b').config);
    expect(harness.saveTimeline.mock.calls[1]?.[2]).toBe(2);
    expect((await loadTimelineDraft('timeline-1'))?.draft).toEqual({
      config: makeTimelineData('save-b').config,
      registry: makeTimelineData('save-b').registry,
      bundle: null,
    });
    // The queued newer save B drained and is now in flight — definitely not
    // 'saved', and the watchdog is still armed.
    expect(harness.result?.current.saveStatus).toBe('saving');
    expect(harness.result?.current.watchdogTripped).toBe(false);

    // Nothing else cleared the watchdog: it trips once B goes unacknowledged
    // past the grace from when save A was scheduled.
    await advance(WATCHDOG_GRACE_MS - 600 - 1); // Just before the deadline.
    expect(harness.result?.current.watchdogTripped).toBe(false);
    await advance(2); // Past the deadline, trips.
    expect(harness.result?.current.watchdogTripped).toBe(true);
    expect(harness.result?.current.watchdogReason).toBe('timeout');

    // B eventually ACKs — the receipt now covers the newest edit and clears.
    act(() => { settleB?.(2); });
    await advance(0);
    expect(harness.result?.current.watchdogTripped).toBe(false);
    expect(harness.result?.current.saveStatus).toBe('saved');
    expect(await loadTimelineDraft('timeline-1')).toBeNull();
  });

  it('trips on a rejected CAS conflict that never resolves', async () => {
    const harness = setup({
      persistenceEnabled: true,
      saveTimelineImpl: () => Promise.reject(new TimelineVersionConflictError('conflict', 1)),
    });

    harness.scheduleSave(makeTimelineData('conflict'));
    await advance(600); // doSave -> conflict -> exhausted (async retry-version reload)
    expect(harness.result?.current.saveStatus).toBe('error');

    await advance(WATCHDOG_GRACE_MS - 600 - 1); // Just before the deadline.
    expect(harness.result?.current.watchdogTripped).toBe(false);
    await advance(2); // Past the deadline, trips.
    expect(harness.result?.current.watchdogTripped).toBe(true);
    expect(harness.result?.current.watchdogReason).toBe('timeout');
  });

  it('surfaces dropped edits immediately via the lostEdit event', () => {
    const harness = setup();

    act(() => { harness.eventBus.emit('lostEdit'); });
    expect(harness.result?.current.watchdogTripped).toBe(true);
    expect(harness.result?.current.watchdogReason).toBe('lost-edit');
  });

  it('retryWatchdog clears the notice and never duplicates an in-flight save', async () => {
    let settle: ((v: number) => void) | null = null;
    const harness = setup({
      persistenceEnabled: true,
      saveTimelineImpl: () => new Promise<number>((resolve) => { settle = resolve; }),
    });

    harness.scheduleSave(makeTimelineData('hang'));
    await advance(600);
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
    await advance(WATCHDOG_GRACE_MS + 1);
    expect(harness.result?.current.watchdogTripped).toBe(true);

    // Retry while the original save is still in flight: the notice clears and
    // no duplicate POST is issued (the same-seq retry is queued, then dropped
    // once the original settles).
    act(() => { harness.result?.current.retryWatchdog(); });
    expect(harness.result?.current.watchdogTripped).toBe(false);
    await advance(600);
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);

    // The in-flight save settles: its receipt keeps the watchdog cleared.
    act(() => { settle?.(2); });
    await advance(0);
    await advance(0);
    expect(harness.result?.current.watchdogTripped).toBe(false);
    expect(harness.saveTimeline).toHaveBeenCalledTimes(1);
  });
});

describe('useTimelinePersistence — recovery draft gated by persistence', () => {
  const flushMicrotasks = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(async () => {
    resetFakeIndexedDB();
    // Earlier suites leave drafts under this id in the shared fake database.
    await clearTimelineDraft('timeline-1');
    vi.useFakeTimers();
    vi.mocked(saveTimelineDraft).mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('writes no recovery draft and no save when persistence is disabled (scheduleSave and retry-after-conflict)', async () => {
    const harness = setup({ persistenceEnabled: false });
    const saveAtHead = vi.fn(async () => 2);
    harness.provider.saveTimelineAtHead = saveAtHead;

    harness.scheduleSave(makeTimelineData('read-only-draft'));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(saveTimelineDraft).not.toHaveBeenCalled();
    expect(harness.saveTimeline).not.toHaveBeenCalled();
    expect(saveAtHead).not.toHaveBeenCalled();
    expect(harness.result.current.saveStatus).toBe('saved');
    expect(await loadTimelineDraft('timeline-1')).toBeNull();

    // The explicit draft path: retrySaveAfterConflict awaits createScheduledSave(...).draftWrite.
    await act(async () => {
      await harness.result.current.retrySaveAfterConflict();
    });
    expect(saveTimelineDraft).not.toHaveBeenCalled();
    expect(harness.saveTimeline).not.toHaveBeenCalled();
    expect(saveAtHead).not.toHaveBeenCalled();
    expect(await loadTimelineDraft('timeline-1')).toBeNull();
    expect(harness.result.current.saveStatus).toBe('saved');
  });

  it('still writes exactly one recovery draft per scheduleSave when persistence is enabled', async () => {
    const harness = setup({ persistenceEnabled: true });

    harness.scheduleSave(makeTimelineData('durable-draft'));
    await flushMicrotasks();

    expect(saveTimelineDraft).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveTimelineDraft).mock.calls[0][0]).toBe('timeline-1');
    expect(await loadTimelineDraft('timeline-1')).not.toBeNull();
  });

  it('keeps guarded reload blocked when its durable recovery write fails', async () => {
    const harness = setup();
    const failure = new Error('IndexedDB full');
    vi.mocked(saveTimelineDraft).mockRejectedValueOnce(failure);
    await expect(harness.result.current.preserveTimelineDraftForReload()).rejects.toBe(failure);
    expect(harness.result.current.isTimelineDraftDurableForReload()).toBe(false);
    expect(await loadTimelineDraft('timeline-1')).toBeNull();
  });

  it('keeps guarded reload blocked when edits continue throughout recovery preservation', async () => {
    const harness = setup();
    for (let attempt = 0; attempt < 5; attempt++) {
      vi.mocked(saveTimelineDraft).mockImplementationOnce(async () => { harness.editSeqRef.current++; });
    }
    await expect(harness.result.current.preserveTimelineDraftForReload()).rejects.toThrow('kept changing');
    expect(harness.result.current.isTimelineDraftDurableForReload()).toBe(false);
    expect(await loadTimelineDraft('timeline-1')).toBeNull();
  });
});

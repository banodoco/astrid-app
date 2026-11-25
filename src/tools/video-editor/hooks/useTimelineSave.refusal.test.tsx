// @vitest-environment jsdom
import { toast as sonnerToast } from '@/shared/components/ui/runtime/sonner.tsx';
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB, resetFakeIndexedDB } from 'fake-indexeddb';
import { ApiError } from '@/integrations/runtime/generated.ts';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { TimelineStoreProvider, createTimelineStore } from './timelineStore';
import { useTimelineSave } from './useTimelineSave';
import { VideoEditorRuntimeProvider, type VideoEditorRuntimeContextValue } from '../contexts/VideoEditorRuntimeContext';
import { createInteractionState } from '../lib/interaction-state';
import { buildTimelineData, type TimelineData } from '../lib/timeline-data';
import { createDefaultTimelineConfig } from '../lib/defaults';
import { loadTimelineDraft, saveTimelineDraft } from '../data/timelineDraftIndexedDb';
import type { DataProvider } from '../data/DataProvider';
import type { TimelineConfig } from '../types/index.ts';

vi.stubGlobal('indexedDB', createFakeIndexedDB());
vi.mock('@/tools/video-editor/compositions/TimelineRenderer.tsx', () => ({
  invalidateReferencedTimelineCache: vi.fn(),
}));
vi.mock('@/shared/lib/media/videoMetadata.ts', () => ({
  extractVideoMetadata: vi.fn(async () => ({ duration_seconds: 8 })),
}));

const persistenceOverride = vi.hoisted(() => ({ status: null as null | 'retrying' }));
vi.mock('./useTimelinePersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useTimelinePersistence')>();
  return { ...actual, useTimelinePersistence: (...args: Parameters<typeof actual.useTimelinePersistence>) => {
    const result = actual.useTimelinePersistence(...args);
    return persistenceOverride.status ? { ...result, saveStatus: persistenceOverride.status } : result;
  } };
});

const TIMELINE = 'timeline-1';
const head = { projectId: 'project-commit', timelineId: TIMELINE, headRevisionId: 'r0', headPublicationId: 'p0' };

type Json = Record<string, unknown>;
// Applies the request's `doc.patch` set-changes to a payload copy (only the paths this file edits).
function applyChanges(payload: Json, changes: Array<{ op: string; path: string[]; value: unknown }>): Json {
  const next = structuredClone(payload) as Json;
  for (const change of changes) {
    let node: unknown = next;
    change.path.slice(0, -1).forEach((segment) => {
      node = Array.isArray(node) && segment.startsWith('id:')
        ? node.find((item: { id: string }) => item.id === segment.slice(3))
        : (node as Json)[segment];
    });
    (node as Json)[change.path.at(-1)!] = change.value;
  }
  const config = next.config as Json;
  if (Array.isArray(next.clips) && Array.isArray(config.clips)) {
    // The parent mirrors its clips; keep the mirror equal to whichever side was patched.
    if (changes.some((change) => change.path[0] === 'clips')) config.clips = next.clips;
    else next.clips = config.clips;
  }
  return next;
}

async function mount(options: { rejectFirstSend?: boolean; gate?: Promise<void>; failSends?: boolean; gates?: Array<Promise<void>>; waitForOwner?: boolean; canonicalReload?: boolean; basisGate?: Promise<void>; failFirstBasis?: boolean } = {}) {
  const config = createDefaultTimelineConfig();
  const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' },
    { timelineId: TIMELINE, projectId: 'project-commit' }).data.canonical_document;
  const data = await buildTimelineData({ ...config, clips: [{ id: 'clip-a', at: 0, track: 'V1', clipType: 'hold', hold: 1 }] },
    { assets: {} }, undefined, 1, undefined, head);
  document.parent_revision.payload = JSON.parse(JSON.stringify({ config: data.config, clips: data.config.clips, registry: data.registry, occurrences: [] }));
  document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
  let current = document;
  let counter = 0;
  const requests: Array<{ changes: Array<{ op: string; path: string[]; value: unknown }> }> = [];
  let rejectNext = options.rejectFirstSend;
  const send = vi.fn<NonNullable<DataProvider['commitTimeline']>>(async (request) => {
    if (options.gate) await options.gate;
    if (options.failSends) throw new TypeError('Failed to fetch');
    const gateForThisSend = options.gates?.[requests.length];
    if (gateForThisSend) await gateForThisSend;
    const changes = (request.commands as Array<{ args: { changes: never[] } }>).flatMap((command) => command.args.changes);
    requests.push({ changes });
    if (rejectNext) {
      rejectNext = false;
      throw new ApiError(409, 'conflict', 'Retain original intent', '', { status: 'conflict', path: ['output'], hint: 'Read latest' });
    }
    const revisionId = `r${++counter}`;
    const response = acceptedCommit({ revision_id: revisionId, publication_id: `p${counter}` }, { revision_id: current.parent_revision.revision_id, publication_id: `p${counter - 1}` },
      { timelineId: TIMELINE });
    const next = structuredClone(current);
    next.parent_revision.revision_id = revisionId;
    next.parent_revision.payload = applyChanges(current.parent_revision.payload as Json, changes) as never;
    next.parent_revision.content_digest = fixtureDigest(next.parent_revision.payload);
    response.data.canonical_document = next;
    current = next;
    return { response, accepted: { revisionId, publicationId: `p${counter}` }, canonicalDocument: next, graph: {}, receipt: response.receipt };
  });
  let failBasis = options.failFirstBasis;
  const provider = {
    persistenceEnabled: true,
    loadTimeline: vi.fn(async () => options.canonicalReload
      ? ({ config: data.config, configVersion: 1, head }) : ({ config: createDefaultTimelineConfig(), configVersion: 1 })),
    loadAssetRegistry: vi.fn(async () => ({ assets: {} })),
    saveTimeline: vi.fn(async () => { throw new Error('Legacy save must not be called'); }),
    resolveAssetUrl: vi.fn(async (file: string) => file),
    loadTimelineCommandBasis: vi.fn(async () => { if (failBasis) { failBasis = false; throw new Error('bootstrap failed'); } await options.basisGate; return { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document }; }),
    commitTimeline: send,
    getRecoverableIdentity: vi.fn(async () => ({ actorId: 'actor', realmId: 'realm' })),
  } as unknown as DataProvider;
  const store = createTimelineStore();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const runtime = { provider, project: { projectId: 'project-commit' }, toast: { error: vi.fn(), success: vi.fn() }, timelineId: TIMELINE,
    assetResolver: { resolveAssetUrl: vi.fn(async (file: string) => file) },
    shots: { shots: undefined, isLoading: false, error: null, refetchShots: vi.fn() } } as unknown as VideoEditorRuntimeContextValue;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <VideoEditorRuntimeProvider value={runtime}><TimelineStoreProvider store={store}>{children}</TimelineStoreProvider></VideoEditorRuntimeProvider>
    </QueryClientProvider>
  );
  const hook = renderHook(() => useTimelineSave({ timelineQuery: { data: undefined, isLoading: false }, assetRegistryQuery: { data: undefined } },
    provider, { current: createInteractionState() }, store, data), { wrapper });
  if (options.waitForOwner !== false) await vi.waitFor(() => expect(hook.result.current.localSaveState?.ownerId).toBeTruthy());
  return { hook, send, requests, data, provider };
}

type Harness = Awaited<ReturnType<typeof mount>>;

async function author(harness: Harness, edit: (config: TimelineConfig) => TimelineConfig, gestureBasis?: NonNullable<Parameters<Harness['hook']['result']['current']['commitData']>[1]>['gestureBasis']) {
  const current = harness.hook.result.current.dataRef.current!;
  const next = await buildTimelineData(edit(structuredClone(current.config)), current.registry, undefined, 1, undefined, current.head);
  await act(async () => { harness.hook.result.current.commitData(next, { save: true, ...(gestureBasis ? { gestureBasis } : {}) }); });
}

describe('useTimelineSave refused authoring edits', () => {
  const locks = new Set<string>();
  let descriptor: PropertyDescriptor | undefined;
  beforeEach(() => {
    resetFakeIndexedDB();
    vi.stubGlobal('indexedDB', createFakeIndexedDB());
    descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (name: string, _options: unknown, work: (lock: object | null) => Promise<unknown>) => {
        if (locks.has(name)) return work(null);
        locks.add(name);
        try { return await work({}); } finally { locks.delete(name); }
      },
    } });
  });
  afterEach(() => {
    persistenceOverride.status = null;
    vi.restoreAllMocks();
    if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
    else Reflect.deleteProperty(navigator, 'locks');
  });

  it('keeps loading during deferred recovery and shows saved over persistence retrying when ready', async () => {
    let release!: () => void;
    const basisGate = new Promise<void>((resolve) => { release = resolve; });
    persistenceOverride.status = 'retrying';
    const harness = await mount({ waitForOwner: false, basisGate });
    try {
      expect(harness.hook.result.current.saveStatus).toBe('loading');
      await act(async () => { release(); });
      await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.status).toBe('saved'));
      await vi.waitFor(() => expect(harness.hook.result.current.saveStatus).toBe('saved'));
    } finally { harness.hook.unmount(); }
  });

  it('shows error, loading, then ready when bootstrap is restarted', async () => {
    let release!: () => void;
    const basisGate = new Promise<void>((resolve) => { release = resolve; });
    const harness = await mount({ waitForOwner: false, failFirstBasis: true, basisGate });
    try {
      await vi.waitFor(() => expect(harness.hook.result.current.saveBar?.action).toBe('restart'));
      expect(harness.hook.result.current.saveStatus).toBe('error');
      await act(async () => { await harness.hook.result.current.tryAgain(); });
      expect(harness.hook.result.current.saveStatus).toBe('loading');
      await act(async () => { release(); });
      await vi.waitFor(() => expect(harness.hook.result.current.saveStatus).toBe('saved'));
    } finally { harness.hook.unmount(); }
  });

  it('reverts only the refused edit between two good edits and keeps the refused change out of the recovery slot', async () => {
    const toastError = vi.spyOn(sonnerToast, 'error');
    const harness = await mount();
    try {
      const original = harness.hook.result.current.dataRef.current!;
      await author(harness, (config) => ({ ...config, output: { ...config.output, file: 'edit-a.mp4' } }));
      // The gesture's read basis differs from the original input, so the handoff refuses this edit alone.
      const badBasis = { kind: 'trim' as const, clipId: 'clip-a', patch: { hold: 7 },
        config: { ...original.config, output: { ...original.config.output, file: 'someone-else.mp4' } }, registry: original.registry };
      await author(harness, (config) => ({ ...config, clips: config.clips.map((clip) => ({ ...clip, hold: 7 })) }), badBasis);
      await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
      expect(toastError.mock.calls[0][0]).toMatch(/The timeline changed while you were editing.*That change was undone; your other edits are kept\./s);
      // The refused edit is gone from the screen at once; A is still there.
      await vi.waitFor(() => expect(harness.hook.result.current.dataRef.current?.config.clips[0].hold).toBe(1));
      expect(harness.hook.result.current.dataRef.current?.config.output.file).toBe('edit-a.mp4');
      // B is authored after the revert, on a different field than A and the refused edit.
      await author(harness, (config) => ({ ...config, output: { ...config.output, fps: 24 } }));
      // The first flush reports the undone edit once, so a caller never believes it saved; the next one is clean.
      await act(async () => { await expect(harness.hook.result.current.flushPendingSave()).rejects.toThrow('The timeline changed while you were editing'); });
      await act(async () => { await harness.hook.result.current.flushPendingSave(); });

      const changes = harness.requests.flatMap((request) => request.changes);
      const touched = changes.map((change) => change.path.join('/'));
      expect(changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['config', 'output', 'file'], value: 'edit-a.mp4' }),
        expect.objectContaining({ path: ['config', 'output', 'fps'], value: 24 }),
      ]));
      expect(touched.some((path) => /hold/.test(path))).toBe(false);
      const final = harness.hook.result.current.dataRef.current!;
      expect(final.config.output).toMatchObject({ file: 'edit-a.mp4', fps: 24 });
      expect(final.config.clips[0].hold).toBe(1);
      // No sticky captureFailure: the session still saves and flushing resolves.
      expect(harness.hook.result.current.localSaveState?.status).not.toBe('error');
      await expect(harness.hook.result.current.flushPendingSave()).resolves.not.toThrow();
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(harness.provider.saveTimeline).not.toHaveBeenCalled();

      // Recovery storage: the one slot never holds the refused change, and there is no second slot.
      const main = await loadTimelineDraft(TIMELINE);
      if (main) expect(JSON.stringify(main.draft)).not.toContain('"hold":7');
      expect(await loadTimelineDraft(`${TIMELINE}#refused`)).toBeNull();
    } finally { harness.hook.unmount(); }

    // Reload: the refused edit is not offered back and the editor shows the canonical clip.
    const reopened = await mount();
    try {
      expect(reopened.hook.result.current.recoveryDraft).toBeNull();
      expect(reopened.hook.result.current.dataRef.current?.config.clips[0].hold).toBe(1);
    } finally { reopened.hook.unmount(); }
  });

  it('surfaces a refusal whose revert is declined (canonical reload in progress) as one refusal toast', async () => {
    const toastError = vi.spyOn(sonnerToast, 'error');
    const harness = await mount();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(harness.provider.loadTimeline).mockImplementation(async () => { await gate; return { config: createDefaultTimelineConfig(), configVersion: 1 }; });
    try {
      const original = harness.hook.result.current.dataRef.current!;
      const badBasis = { kind: 'trim' as const, clipId: 'clip-a', patch: { hold: 7 },
        config: { ...original.config, output: { ...original.config.output, file: 'someone-else.mp4' } }, registry: original.registry };
      const next = await buildTimelineData({ ...structuredClone(original.config), clips: original.config.clips.map((clip) => ({ ...clip, hold: 7 })) },
        original.registry, undefined, 1, undefined, original.head);
      let reload: Promise<unknown> = Promise.resolve();
      await act(async () => {
        harness.hook.result.current.commitData(next, { save: true, gestureBasis: badBasis });
        // Synchronously after the edit is captured, before the refusal settles: the revert is declined.
        reload = harness.hook.result.current.reloadFromServer({ preserveDraft: true });
      });
      // The reload is still running: the refusal has not been shown or lost yet.
      expect(toastError).not.toHaveBeenCalled();
      release();
      await act(async () => { await reload; });
      // The declined revert is never silent: one plain refusal toast, not the 'undone' text.
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(String(toastError.mock.calls[0][0])).toMatch(/The timeline changed while you were editing/);
      expect(String(toastError.mock.calls[0][0])).not.toContain('That change was undone');
      // The canonical reload replaced the refused edit, so the badge reflects canonical (saved), not a stuck error.
      expect(harness.hook.result.current.dataRef.current?.config.clips[0]?.hold).not.toBe(7);
      await act(async () => { await harness.hook.result.current.flushPendingSave(); });
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(harness.requests.flatMap((request) => request.changes).some((change) => /hold/.test(change.path.join('/')))).toBe(false);
    } finally { harness.hook.unmount(); }
  });

  it('Discard clears a retained non-refusal draft, and a reload offers neither it nor a refused edit', async () => {
    const harness = await mount({ rejectFirstSend: true });
    try {
      await author(harness, (config) => ({ ...config, output: { ...config.output, file: 'conflicted.mp4' } }));
      await act(async () => { await expect(harness.hook.result.current.flushPendingSave()).rejects.toThrow(); });
      // A conflict is not an authoring refusal: the edit stays as a retained draft.
      await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.status).toBe('conflict'));
      expect(await loadTimelineDraft(TIMELINE)).not.toBeNull();
    } finally { harness.hook.unmount(); }

    const reloaded = await mount();
    try {
      await vi.waitFor(() => expect(reloaded.hook.result.current.recoveryDraft).not.toBeNull());
      await act(async () => { await reloaded.hook.result.current.discardRecoveredDraft(); });
      expect(reloaded.hook.result.current.recoveryDraft).toBeNull();
      expect(await loadTimelineDraft(TIMELINE)).toBeNull();
      expect(reloaded.hook.result.current.dataRef.current?.config.output.file).toBe(reloaded.data.config.output.file);
    } finally { reloaded.hook.unmount(); }

    const again = await mount();
    try {
      expect(again.hook.result.current.recoveryDraft).toBeNull();
      expect(await loadTimelineDraft(TIMELINE)).toBeNull();
      expect(again.hook.result.current.dataRef.current?.config.output.file).toBe(again.data.config.output.file);
    } finally { again.hook.unmount(); }
  });

  function refusedBasis(original: TimelineData) {
    // The gesture's read basis differs from the original input, so the handoff refuses this edit alone.
    return { kind: 'trim' as const, clipId: 'clip-a', patch: { hold: 7 },
      config: { ...original.config, output: { ...original.config.output, file: 'someone-else.mp4' } }, registry: original.registry };
  }
  const sentPaths = (harness: Harness) => harness.requests.flatMap((request) => request.changes);

  it('keeps a good edit A when a refused edit B follows in the same tick, and sends nothing of B', async () => {
    const toastError = vi.spyOn(sonnerToast, 'error');
    const harness = await mount();
    try {
      const original = harness.hook.result.current.dataRef.current!;
      const a = await buildTimelineData({ ...original.config, output: { ...original.config.output, file: 'edit-a.mp4' } },
        original.registry, undefined, 1, undefined, original.head);
      const b = await buildTimelineData({ ...a.config, clips: a.config.clips.map((clip) => ({ ...clip, hold: 7 })) },
        a.registry, undefined, 1, undefined, a.head);
      await act(async () => {
        harness.hook.result.current.commitData(a, { save: true });
        harness.hook.result.current.commitData(b, { save: true, gestureBasis: refusedBasis(original) });
      });
      await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
      expect(String(toastError.mock.calls[0][0])).toMatch(/^Not saved: .*That change was undone; your other edits are kept\.$/s);
      expect(String(toastError.mock.calls[0][0])).not.toContain('Local document save retained');
      await vi.waitFor(() => expect(harness.hook.result.current.dataRef.current?.config.clips[0].hold).toBe(1));
      expect(harness.hook.result.current.dataRef.current?.config.output.file).toBe('edit-a.mp4');
      await act(async () => { await expect(harness.hook.result.current.flushPendingSave()).rejects.toThrow('The timeline changed while you were editing'); });
      await act(async () => { await harness.hook.result.current.flushPendingSave(); });
      const changes = sentPaths(harness);
      expect(changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['config', 'output', 'file'], value: 'edit-a.mp4' })]));
      // A was never published and then reverted: no request puts the original file back.
      expect(changes.some((change) => change.value === original.config.output.file)).toBe(false);
      expect(changes.some((change) => /hold/.test(change.path.join('/')))).toBe(false);
      expect(harness.hook.result.current.dataRef.current?.config.output.file).toBe('edit-a.mp4');
    } finally { harness.hook.unmount(); }
  });

  it('takes the terminal path when a later edit C follows the refused edit B in the same tick', async () => {
    const harness = await mount();
    try {
      const original = harness.hook.result.current.dataRef.current!;
      const b = await buildTimelineData({ ...original.config, clips: original.config.clips.map((clip) => ({ ...clip, hold: 7 })) },
        original.registry, undefined, 1, undefined, original.head);
      const c = await buildTimelineData({ ...b.config, output: { ...b.config.output, fps: 24 } }, b.registry, undefined, 1, undefined, b.head);
      await act(async () => {
        harness.hook.result.current.commitData(b, { save: true, gestureBasis: refusedBasis(original) });
        harness.hook.result.current.commitData(c, { save: true });
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await act(async () => { await expect(harness.hook.result.current.flushPendingSave()).rejects.toThrow('The timeline changed while you were editing'); });
      // Not reverted: C (authored on B) is not lost, and the draft keeps B and C for Save as copy.
      const screen = harness.hook.result.current.dataRef.current!;
      expect(screen.config.clips[0].hold).toBe(7);
      expect(screen.config.output.fps).toBe(24);
      const draft = await loadTimelineDraft(TIMELINE);
      expect(JSON.stringify(draft?.draft)).toContain('"hold":7');
      // The refused change is never published, not even inside C's unnamed capture.
      expect(sentPaths(harness).some((change) => /hold/.test(change.path.join('/')))).toBe(false);
    } finally { harness.hook.unmount(); }
  });

  it('keeps an edit made after a 409 conflict in the draft instead of undoing it', async () => {
    const toastError = vi.spyOn(sonnerToast, 'error');
    const harness = await mount({ rejectFirstSend: true });
    try {
      await author(harness, (config) => ({ ...config, output: { ...config.output, file: 'conflicted.mp4' } }));
      await act(async () => { await harness.hook.result.current.flushPendingSave().catch(() => {}); });
      await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.status).toBe('conflict'));
      const original = harness.hook.result.current.dataRef.current!;
      await author(harness, (config) => ({ ...config, output: { ...config.output, fps: 24 } }), refusedBasis(original));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(harness.hook.result.current.dataRef.current?.config.output.fps).toBe(24);
      const draft = await loadTimelineDraft(TIMELINE);
      expect((draft?.draft as { config: TimelineConfig }).config.output.fps).toBe(24);
      expect(toastError.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('That change was undone');
    } finally { harness.hook.unmount(); }
  });

  it('keeps the recovered draft and banner when Save them is refused', async () => {
    const seed = await mount();
    const base = seed.hook.result.current.dataRef.current!;
    seed.hook.unmount();
    await saveTimelineDraft(TIMELINE, { config: { ...base.config, output: { ...base.config.output, file: 'recovered.mp4' } },
      registry: base.registry, bundle: null }, 1, { ownerId: 'old-owner', draftIdentity: 'old-identity',
      baseHeadRevisionId: 'r0', baseHeadProjectId: 'project-commit', baseHeadTimelineId: TIMELINE });
    const harness = await mount();
    try {
      await vi.waitFor(() => expect(harness.hook.result.current.recoveryDraft).not.toBeNull());
      await act(async () => { await harness.hook.result.current.retryRecoveredDraft(); });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await act(async () => { await harness.hook.result.current.flushPendingSave().catch(() => {}); });
      const draft = await loadTimelineDraft(TIMELINE);
      expect((draft?.draft as { config: TimelineConfig } | undefined)?.config.output.file).toBe('recovered.mp4');
      expect(harness.hook.result.current.recoveryDraft).not.toBeNull();
      expect(harness.hook.result.current.dataRef.current?.config.output.file).toBe('recovered.mp4');
    } finally { harness.hook.unmount(); }
  });

  it('does not report an undone edit to a flush whose target does not cover it', async () => {
    const harness = await mount();
    try {
      const original = harness.hook.result.current.dataRef.current!;
      const a = await buildTimelineData({ ...original.config, output: { ...original.config.output, file: 'edit-a.mp4' } },
        original.registry, undefined, 1, undefined, original.head);
      const b = await buildTimelineData({ ...a.config, clips: a.config.clips.map((clip) => ({ ...clip, hold: 7 })) },
        a.registry, undefined, 1, undefined, a.head);
      let earlier!: Promise<number>;
      await act(async () => {
        harness.hook.result.current.commitData(a, { save: true });
        // This barrier targets A only; B is authored after it was requested.
        earlier = harness.hook.result.current.flushPendingSave();
        harness.hook.result.current.commitData(b, { save: true, gestureBasis: refusedBasis(original) });
        await earlier;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await act(async () => { await expect(harness.hook.result.current.flushPendingSave()).rejects.toThrow('The timeline changed while you were editing'); });
      await act(async () => { await harness.hook.result.current.flushPendingSave(); });
    } finally { harness.hook.unmount(); }
  });

  it('undoes an unnamed refused edit, and a later ordinary edit still reaches the Runtime', async () => {
    const toastError = vi.spyOn(sonnerToast, 'error');
    const harness = await mount();
    try {
      const original = harness.hook.result.current.dataRef.current!;
      // A new clip whose asset was registered without its Runtime media selection: refused by an edit-specific guard.
      const ghost = await buildTimelineData({ ...original.config, clips: [...original.config.clips,
        { id: 'clip-ghost', at: 2, track: 'V1', clipType: 'hold', hold: 1, asset: 'ghost-asset' }] },
        { ...original.registry, assets: { ...original.registry.assets, 'ghost-asset': { file: 'ghost.png', type: 'image/png' } } },
        undefined, 1, undefined, original.head);
      await act(async () => { harness.hook.result.current.commitData(ghost, { save: true }); });
      await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
      await vi.waitFor(() => expect(harness.hook.result.current.dataRef.current!.config.clips.map((clip) => clip.id)).toEqual(['clip-a']));
      await author(harness, (config) => ({ ...config, output: { ...config.output, file: 'edit-a.mp4' } }));
      // The refusal is reported once to the flush that covers it; the next flush is clean.
      await act(async () => { await harness.hook.result.current.flushPendingSave().catch(() => undefined); });
      await act(async () => { await harness.hook.result.current.flushPendingSave(); });
      const screen = harness.hook.result.current.dataRef.current!;
      expect(screen.config.clips.map((clip) => clip.id)).toEqual(['clip-a']);
      expect(screen.config.output.file).toBe('edit-a.mp4');
      expect(harness.requests.flatMap((request) => request.changes).map((change) => [change.path.join('/'), change.value]))
        .toEqual([['config/output/file', 'edit-a.mp4']]);
      expect(harness.hook.result.current.saveStatus).not.toBe('error');
      expect(String(toastError.mock.calls[0][0])).toMatch(/^Not saved: .*That change was undone; your other edits are kept\.$/s);
      expect(String(toastError.mock.calls[0][0])).not.toMatch(/Draft retained|reload the timeline|not saved.*not saved/is);
    } finally { harness.hook.unmount(); }
  });

  it('leaves no uploading placeholder on screen when a refused drop is undone', async () => {
    const toastError = vi.spyOn(sonnerToast, 'error');
    const harness = await mount();
    try {
      const original = harness.hook.result.current.dataRef.current!;
      const row = original.rows[0];
      const skeleton = { ...original,
        rows: original.rows.map((item) => item.id === row.id
          ? { ...item, actions: [...item.actions, { id: 'uploading-x', start: 5, end: 6, effectId: 'effect-uploading-x' }] } : item),
        meta: { ...original.meta, 'uploading-x': { ...original.meta['clip-a'], track: row.id } } } as TimelineData;
      await act(async () => { harness.hook.result.current.commitData(skeleton, { save: false }); });
      const placed = await buildTimelineData({ ...original.config, clips: original.config.clips.map((clip) => ({ ...clip, hold: 7 })) },
        original.registry, undefined, 1, undefined, original.head);
      const badBasis = { kind: 'trim' as const, clipId: 'clip-a', patch: { hold: 7 },
        config: { ...original.config, output: { ...original.config.output, file: 'someone-else.mp4' } }, registry: original.registry };
      await act(async () => { harness.hook.result.current.commitData(placed, { save: true, gestureBasis: badBasis }); });
      await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
      const screen = harness.hook.result.current.dataRef.current!;
      expect(screen.config.clips[0].hold).toBe(1);
      expect(screen.rows.some((item) => item.actions.some((action) => action.id.startsWith('uploading-')))).toBe(false);
      expect(Object.keys(screen.meta).some((id) => id.startsWith('uploading-'))).toBe(false);
    } finally { harness.hook.unmount(); }
  });

  it('undoes a refused edit made while an earlier edit is being sent, and a later edit still reaches the Runtime', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const harness = await mount({ gate });
    try {
      const original = harness.hook.result.current.dataRef.current!;
      await author(harness, (config) => ({ ...config, output: { ...config.output, file: 'edit-a.mp4' } }));
      let firstFlush: Promise<unknown> | undefined;
      await act(async () => { firstFlush = harness.hook.result.current.flushPendingSave().catch((error: unknown) => error); });
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1));
      expect(harness.hook.result.current.localSaveState?.status).toBe('saving');
      const badBasis = { kind: 'trim' as const, clipId: 'clip-a', patch: { hold: 7 },
        config: { ...original.config, output: { ...original.config.output, file: 'someone-else.mp4' } }, registry: original.registry };
      await author(harness, (config) => ({ ...config, clips: config.clips.map((clip) => ({ ...clip, hold: 7 })) }), badBasis);
      await vi.waitFor(() => expect(harness.hook.result.current.dataRef.current!.config.clips[0].hold).toBe(1));
      release();
      await act(async () => { await firstFlush; });
      await author(harness, (config) => ({ ...config, output: { ...config.output, fps: 24 } }));
      await act(async () => { await harness.hook.result.current.flushPendingSave().catch(() => {}); });
      await act(async () => { await harness.hook.result.current.flushPendingSave().catch(() => {}); });
      const sent = harness.requests.flatMap((request) => request.changes).map((change) => [change.path.join('/'), change.value]);
      expect(sent).toEqual([['config/output/file', 'edit-a.mp4'], ['config/output/fps', 24]]);
      expect(harness.hook.result.current.dataRef.current!.config.clips[0].hold).toBe(1);
      expect(harness.hook.result.current.localSaveState?.status).toBe('saved');
    } finally { harness.hook.unmount(); }
  });
  it('a save session that cannot recover an owner held by another tab still offers Discard, and the next edit saves', async () => {
    // Tab A holds an unsaved, retried save; its owner stays claimed.
    const tabA = await mount({ failSends: true });
    try {
      await author(tabA, (config) => ({ ...config, output: { ...config.output, file: 'held.mp4' } }));
      await vi.waitFor(() => expect(tabA.hook.result.current.localSaveState?.status).toBe('retry'));
      // Tab B lists A's owner, cannot claim it, and used to end with a dead bar and a rejected `ready`.
      const tabB = await mount({ waitForOwner: false, canonicalReload: true });
      try {
        await vi.waitFor(() => expect(tabB.hook.result.current.saveBar?.headline)
          .toBe('This timeline has unsaved changes open in another tab.'));
        await act(async () => { await tabB.hook.result.current.discardUnsaved(); });
        await vi.waitFor(() => expect(tabB.hook.result.current.saveBar).toBeNull());
        expect(tabB.hook.result.current.localSaveState?.status).toBe('saved');
        await author(tabB, (config) => ({ ...config, output: { ...config.output, file: 'after-discard.mp4' } }));
        await act(async () => { await tabB.hook.result.current.flushPendingSave(); });
        expect(tabB.requests.flatMap((request) => request.changes)).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: ['config', 'output', 'file'], value: 'after-discard.mp4' })]));
        expect(tabB.hook.result.current.saveBar).toBeNull();
      } finally { tabB.hook.unmount(); }
    } finally { tabA.hook.unmount(); }
  });

  it('two drops, the second made while the first saves, are both saved, and the bar is clear afterwards', async () => {
    let release1!: () => void;
    const gate1 = new Promise<void>((resolve) => { release1 = resolve; });
    const harness = await mount({ gates: [gate1] });
    try {
      await author(harness, (config) => ({ ...config, output: { ...config.output, file: 'drop-1.mp4' } }));
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1));
      await author(harness, (config) => ({ ...config, output: { ...config.output, fps: 24 } }));
      act(() => release1());
      await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.status).toBe('saved'));
      await act(async () => { await harness.hook.result.current.flushPendingSave(); });
      await author(harness, (config) => ({ ...config, output: { ...config.output, file: 'drop-3.mp4' } }));
      await act(async () => { await harness.hook.result.current.flushPendingSave(); });
      expect(harness.requests.flatMap((request) => request.changes)).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['config', 'output', 'file'], value: 'drop-1.mp4' }),
        expect.objectContaining({ path: ['config', 'output', 'fps'], value: 24 }),
        expect.objectContaining({ path: ['config', 'output', 'file'], value: 'drop-3.mp4' }),
      ]));
      expect(harness.hook.result.current.saveBar).toBeNull();
    } finally { harness.hook.unmount(); }
  });

  const outputOf = (harness: Harness) => harness.hook.result.current.dataRef.current!.config.output as Record<string, unknown>;

  it('an edit made while a later save is sending is kept and saved, and the screen never loses an edit', async () => {
    let release1!: () => void;
    let release2!: () => void;
    const gate1 = new Promise<void>((resolve) => { release1 = resolve; });
    const gate2 = new Promise<void>((resolve) => { release2 = resolve; });
    const harness = await mount({ gates: [gate1, gate2] });
    const toastError = vi.spyOn(sonnerToast, 'error');
    try {
      await author(harness, (config) => ({ ...config, output: { ...config.output, file: 'drop-1.mp4' } }));
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1));
      await author(harness, (config) => ({ ...config, output: { ...config.output, fps: 24 } }));
      act(() => release1());
      // Save 1 is accepted while save 2 is queued, then sends: the screen still shows both edits.
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(2));
      expect(outputOf(harness)).toMatchObject({ file: 'drop-1.mp4', fps: 24 });
      await author(harness, (config) => ({ ...config, output: { ...config.output, width: 640 } }));
      expect(outputOf(harness)).toMatchObject({ file: 'drop-1.mp4', fps: 24, width: 640 });
      expect(harness.hook.result.current.saveBar).toBeNull();
      act(() => release2());
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.status).toBe('saved'));
      await act(async () => { await harness.hook.result.current.flushPendingSave(); });
      const changes = harness.requests.flatMap((request) => request.changes);
      expect(changes.map((change) => `${change.path.join('/')}=${String(change.value)}`)).toEqual(expect.arrayContaining([
        'config/output/file=drop-1.mp4', 'config/output/fps=24', 'config/output/width=640']));
      expect(harness.hook.result.current.saveBar).toBeNull();
      expect(toastError).not.toHaveBeenCalled();
      // After the drain the screen is the server's head, with all three edits in it.
      expect(outputOf(harness)).toMatchObject({ file: 'drop-1.mp4', fps: 24, width: 640 });
      expect(harness.hook.result.current.dataRef.current?.head?.headRevisionId).toBe('r3');
    } finally { harness.hook.unmount(); }
  });

  it('a burst of ten quick edits across two accepts is saved in order, with nothing undone', async () => {
    let release1!: () => void;
    let release2!: () => void;
    const gate1 = new Promise<void>((resolve) => { release1 = resolve; });
    const gate2 = new Promise<void>((resolve) => { release2 = resolve; });
    const harness = await mount({ gates: [gate1, gate2] });
    const toastError = vi.spyOn(sonnerToast, 'error');
    const edit = (value: number) => author(harness, (config) => ({ ...config, output: { ...config.output, fps: value } }));
    try {
      await edit(21);
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1));
      for (const value of [22, 23, 24, 25]) await edit(value);
      act(() => release1());
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(2));
      expect(outputOf(harness).fps).toBe(25);
      for (const value of [26, 27, 28]) await edit(value);
      act(() => release2());
      await vi.waitFor(() => expect(harness.send.mock.calls.length).toBeGreaterThanOrEqual(3));
      for (const value of [29, 30]) await edit(value);
      expect(outputOf(harness).fps).toBe(30);
      await vi.waitFor(() => expect(harness.hook.result.current.localSaveState?.status).toBe('saved'));
      await act(async () => { await harness.hook.result.current.flushPendingSave(); });
      const fps = harness.requests.flatMap((request) => request.changes)
        .filter((change) => change.path.join('/') === 'config/output/fps').map((change) => change.value);
      expect(fps).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
      expect(harness.hook.result.current.saveBar).toBeNull();
      expect(toastError).not.toHaveBeenCalled();
      expect(outputOf(harness).fps).toBe(30);
      expect(harness.hook.result.current.dataRef.current?.head?.headRevisionId).toBe('r10');
    } finally { harness.hook.unmount(); }
  });

  describe('the save watchdog measures time without progress', () => {
    afterEach(() => { vi.useRealTimers(); });
    const deferredGate = () => { let open!: () => void; const gate = new Promise<void>((resolve) => { open = resolve; }); return { gate, open }; };
    const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

    it('does not show "not confirmed" for twelve edits accepted three seconds apart (36 s in all)', async () => {
      const gates = Array.from({ length: 12 }, deferredGate);
      const harness = await mount({ gates: gates.map((entry) => entry.gate) });
      vi.useFakeTimers();
      try {
        for (let value = 21; value <= 32; value += 1) {
          await author(harness, (config) => ({ ...config, output: { ...config.output, fps: value } }));
        }
        await tick(500);
        for (const entry of gates) {
          await tick(3000);
          expect(harness.hook.result.current.watchdogTripped).toBe(false);
          await act(async () => { entry.open(); await vi.advanceTimersByTimeAsync(0); });
        }
        await tick(100);
        expect(harness.send.mock.calls.length).toBe(12);
        expect(harness.hook.result.current.watchdogTripped).toBe(false);
        expect(harness.hook.result.current.saveBar).toBeNull();
      } finally { harness.hook.unmount(); }
    });

    it('still shows it when a save is not accepted for longer than the grace period', async () => {
      const stuck = deferredGate();
      const harness = await mount({ gates: [stuck.gate] });
      vi.useFakeTimers();
      try {
        await author(harness, (config) => ({ ...config, output: { ...config.output, fps: 21 } }));
        await tick(500);
        await tick(30_000);
        expect(harness.hook.result.current.watchdogTripped).toBe(false);
        await tick(120_000 - 30_000 - 500 + 1);
        expect(harness.hook.result.current.watchdogTripped).toBe(true);
        expect(harness.hook.result.current.saveBar).toMatchObject({ kind: 'waiting', action: 'watchdog' });
        stuck.open();
      } finally { harness.hook.unmount(); }
    });
  });

  it('says plainly that a recovered draft whose base no longer exists cannot be re-applied, offers only Discard, and Discard clears it', async () => {
    const seed = await mount();
    const base = seed.hook.result.current.dataRef.current!;
    seed.hook.unmount();
    await saveTimelineDraft(TIMELINE, { config: { ...base.config, output: { ...base.config.output, file: 'recovered.mp4' } },
      registry: base.registry, bundle: null }, 1, { ownerId: 'old-owner', draftIdentity: 'old-identity',
      baseHeadRevisionId: 'gone-revision', baseHeadProjectId: 'project-commit', baseHeadTimelineId: TIMELINE });
    const harness = await mount({ canonicalReload: true });
    try {
      await vi.waitFor(() => expect(harness.hook.result.current.saveBar).not.toBeNull());
      expect(harness.hook.result.current.saveBar).toMatchObject({ kind: 'refused', action: 'none',
        headline: 'These changes were made on a version that no longer exists.' });
      // Nothing is sent, and nothing re-applies the draft behind the person's back.
      await act(async () => { await harness.hook.result.current.tryAgain(); });
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.hook.result.current.saveStatus).not.toBe('error');
      await act(async () => { await harness.hook.result.current.discardUnsaved(); });
      await vi.waitFor(() => expect(harness.hook.result.current.saveBar).toBeNull());
      expect(await loadTimelineDraft(TIMELINE)).toBeNull();
    } finally { harness.hook.unmount(); }
  });

});

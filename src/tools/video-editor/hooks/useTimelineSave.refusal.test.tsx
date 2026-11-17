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
import { loadTimelineDraft } from '../data/timelineDraftIndexedDb';
import type { DataProvider } from '../data/DataProvider';
import type { TimelineConfig } from '../types/index.ts';

vi.mock('@/integrations/runtime/generated-contract-metadata.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/integrations/runtime/generated-contract-metadata.ts')>(),
  SCHEMA_DIGEST: 'sha256:9628bb5fd6e1dbbec392dd39f2e01031622dcf52d7ccff7cd1f0ad10743dcb1c',
}));
vi.stubGlobal('indexedDB', createFakeIndexedDB());
vi.mock('@/tools/video-editor/compositions/TimelineRenderer.tsx', () => ({
  invalidateReferencedTimelineCache: vi.fn(),
}));
vi.mock('@/shared/lib/media/videoMetadata.ts', () => ({
  extractVideoMetadata: vi.fn(async () => ({ duration_seconds: 8 })),
}));

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

async function mount(options: { rejectFirstSend?: boolean } = {}) {
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
  const provider = {
    persistenceEnabled: true,
    loadTimeline: vi.fn(async () => ({ config: createDefaultTimelineConfig(), configVersion: 1 })),
    loadAssetRegistry: vi.fn(async () => ({ assets: {} })),
    saveTimeline: vi.fn(async () => { throw new Error('Legacy save must not be called'); }),
    resolveAssetUrl: vi.fn(async (file: string) => file),
    loadTimelineCommandBasis: vi.fn(async () => ({ head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document })),
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
  await vi.waitFor(() => expect(hook.result.current.localSaveState?.ownerId).toBeTruthy());
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
    vi.restoreAllMocks();
    if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
    else Reflect.deleteProperty(navigator, 'locks');
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
      expect(toastError.mock.calls[0][0]).toMatch(/gesture read basis differs.*That change was undone; your other edits are kept\./s);
      // The refused edit is gone from the screen at once; A is still there.
      await vi.waitFor(() => expect(harness.hook.result.current.dataRef.current?.config.clips[0].hold).toBe(1));
      expect(harness.hook.result.current.dataRef.current?.config.output.file).toBe('edit-a.mp4');
      // B is authored after the revert, on a different field than A and the refused edit.
      await author(harness, (config) => ({ ...config, output: { ...config.output, fps: 24 } }));
      // The first flush reports the undone edit once, so a caller never believes it saved; the next one is clean.
      await act(async () => { await expect(harness.hook.result.current.flushPendingSave()).rejects.toThrow('gesture read basis differs'); });
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
      expect(String(toastError.mock.calls[0][0])).toMatch(/gesture read basis differs/);
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
});

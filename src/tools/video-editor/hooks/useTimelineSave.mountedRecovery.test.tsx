// @vitest-environment jsdom
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB, resetFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { CommitRequest } from '@/integrations/runtime/timeline-commit-types.ts';
import type { DataProvider, TimelineCommandBasis, TimelineCommitResult } from '../data/DataProvider.ts';
import { createCommitOutbox } from '../commands/commitOutbox.ts';
import { createInteractionState } from '../lib/interaction-state.ts';
import { createDefaultTimelineConfig } from '../lib/defaults.ts';
import { buildTimelineData, type TimelineData } from '../lib/timeline-data.ts';
import { VideoEditorRuntimeProvider, type VideoEditorRuntimeContextValue } from '../contexts/VideoEditorRuntimeContext.tsx';
import { createTimelineStore } from './timelineStore.ts';
import { useTimelineSave } from './useTimelineSave.ts';

const scope = { realmId: 'realm-mounted', actorId: 'actor-mounted', projectId: 'project-mounted', timelineId: 'timeline-mounted' };
const origin = 'http://127.0.0.1:17340';
const path = `/api/runtime/v1/projects/${scope.projectId}/timelines/${scope.timelineId}/commit`;

type Identity = { body: string; key: string };
type Attempt = Identity & { url: string; forwarded: boolean };
type Held = { resolve: (value: TimelineCommitResult) => void; reject: (error: Error) => void };

function assertExactLifecycle(attempts: Attempt[], forwarded: Attempt[], url: string, a: Identity, b: Identity) {
  expect(attempts).toHaveLength(5);
  expect(attempts.slice(0, 4).map(({ body, key }) => ({ body, key }))).toEqual([a, a, a, a]);
  expect(attempts[4]).toMatchObject({ body: b.body, key: b.key });
  expect(attempts.every((attempt) => attempt.url === url)).toBe(true);
  expect(attempts.every((attempt) => new URL(attempt.url).origin === origin)).toBe(true);
  expect(forwarded.map(({ body, key }) => ({ body, key }))).toEqual([a, a, b]);
  expect(forwarded).toHaveLength(3);
}

function makeBoundary(initial: TimelineCommandBasis) {
  const attempts: Attempt[] = [];
  const forwarded: Attempt[] = [];
  const held: Held[] = [];
  const documents = new Map<string, TimelineCommitResult>();

  function resultFor(request: CommitRequest, revisionId: string, publicationId: string): TimelineCommitResult {
    const response = acceptedCommit({ revision_id: revisionId, publication_id: publicationId },
      { revision_id: request.base_revision_id, publication_id: request.base_publication_id }, { timelineId: scope.timelineId });
    const document = structuredClone(initial.canonicalDocument);
    const output = request.commands[0]?.args && 'changes' in request.commands[0].args
      ? (request.commands[0].args.changes as Array<{ path?: string[]; value?: unknown }>).find((change) => change.path?.at(-1) === 'file')?.value
      : undefined;
    const config = document.parent_revision.payload.config as Record<string, unknown>;
    if (typeof output === 'string') config.output = { ...(config.output as object), file: output };
    document.parent_revision.payload.clips = (config.clips ?? []) as never;
    document.parent_revision.revision_id = revisionId;
    document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
    response.data.canonical_document = document;
    response.data.document_digest = fixtureDigest(document);
    response.receipt.idempotency_key = request.label;
    const value = { response, accepted: { revisionId, publicationId }, canonicalDocument: document,
      graph: {}, receipt: response.receipt } as TimelineCommitResult;
    documents.set(revisionId, value);
    return value;
  }

  const post = async (request: CommitRequest, key: string): Promise<TimelineCommitResult> => {
    const requestUrl = `${origin}${path}`;
    const attempt: Attempt = { body: JSON.stringify(request), key, url: requestUrl, forwarded: false };
    attempts.push(attempt);
    if (attempts.length === 1) {
      const accepted = resultFor(request, 'r1', 'p1');
      attempt.forwarded = true;
      forwarded.push(attempt);
      throw new Error('lost acknowledgement after durable acceptance');
    }
    if (attempts.length === 5) {
      attempt.forwarded = true;
      forwarded.push(attempt);
      const accepted = resultFor(request, 'r2', 'p2');
      return accepted;
    }
    return await new Promise<TimelineCommitResult>((resolve, reject) => held.push({ resolve, reject }));
  };

  return {
    attempts, forwarded, post,
    rejectHeld() {
      const request = held.shift();
      if (!request) throw new Error('No held boundary request');
      request.reject(new Error('connection closed'));
    },
    releaseHeld() {
      const request = held.shift();
      if (!request) throw new Error('No held boundary request');
      const attempt = attempts[attempts.length - 1];
      attempt.forwarded = true;
      forwarded.push(attempt);
      request.resolve(documents.get('r1')!);
    },
    initialResult: documents,
  };
}

async function mountedLifecycle(delay: number) {
  resetFakeIndexedDB();
  vi.stubGlobal('indexedDB', createFakeIndexedDB());
  const locks = new Set<string>();
  const previousLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: async (name: string, _options: unknown, work: (lock: object | null) => Promise<unknown>) => {
      if (locks.has(name)) return work(null);
      locks.add(name);
      try { return await work({}); } finally { locks.delete(name); }
    },
  } });

  const config = createDefaultTimelineConfig();
  config.output = { ...config.output, file: 'initial.mp4' };
  const seed = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }, scope);
  seed.data.canonical_document.parent_revision.payload = { config, clips: config.clips, registry: { assets: {} }, occurrences: [] };
  seed.data.canonical_document.parent_revision.content_digest = fixtureDigest(seed.data.canonical_document.parent_revision.payload);
  const head = { projectId: scope.projectId, timelineId: scope.timelineId, headRevisionId: 'r0', headPublicationId: 'p0' };
  const initial: TimelineCommandBasis = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: seed.data.canonical_document };
  const data = await buildTimelineData(config, { assets: {} }, undefined, 1, undefined, head);
  const boundary = makeBoundary(initial);
  const provider: DataProvider = {
    persistenceEnabled: true,
    loadTimeline: async () => ({ config, configVersion: 1 }),
    loadAssetRegistry: async () => ({ assets: {} }),
    resolveAssetUrl: async (file) => file,
    saveTimeline: async () => { throw new Error('legacy save route used'); },
    loadTimelineCommandBasis: async () => initial,
    getRecoverableIdentity: async () => ({ realmId: scope.realmId, actorId: scope.actorId }),
    commitTimeline: boundary.post,
  };
  const editedA = await buildTimelineData({ ...config, output: { ...config.output, file: 'A.mp4' } }, { assets: {} }, undefined, 1, undefined, head);
  const editedB = await buildTimelineData({ ...config, output: { ...config.output, file: 'B.mp4' } }, { assets: {} }, undefined, 1, undefined, head);

  const mount = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const store = createTimelineStore();
    const runtime = { provider, timelineId: scope.timelineId, project: { projectId: scope.projectId },
      shots: { shots: undefined, isLoading: false, error: null, refetchShots: vi.fn() }, toast: { error: vi.fn() } } as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(
      QueryClientProvider, { client: queryClient }, React.createElement(VideoEditorRuntimeProvider, { value: runtime }, children));
    const hook = renderHook(() => useTimelineSave({ timelineQuery: { data: undefined, isLoading: false }, assetRegistryQuery: { data: undefined } },
      provider, { current: createInteractionState() }, store, data), { wrapper });
    return { hook, queryClient };
  };

  const waitReady = async (hook: ReturnType<typeof mount>['hook']) => {
    await vi.waitFor(() => expect(hook.result.current.localSaveState?.ownerId).toBeTruthy());
  };
  const flush = async (hook: ReturnType<typeof mount>['hook']) => act(async () => { await hook.result.current.flushPendingSave(); });
  const first = mount();
  try {
    await waitReady(first.hook);
    await act(async () => { first.hook.result.current.commitData(editedA, { save: true }); });
    await expect(flush(first.hook)).rejects.toThrow('unacknowledged');
    await act(async () => { first.hook.result.current.commitData(editedB, { save: true }); });
    const heldRetry = flush(first.hook);
    await vi.waitFor(() => expect(boundary.attempts).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, delay));
    boundary.rejectHeld();
    await expect(heldRetry).rejects.toThrow();
    first.hook.unmount();
    first.queryClient.clear();

    const intermediate = mount();
    await vi.waitFor(() => expect(boundary.attempts).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, delay));
    boundary.rejectHeld();
    await vi.waitFor(() => expect(intermediate.hook.result.current.localSaveState?.status).toBe('retry'));
    intermediate.hook.unmount();
    intermediate.queryClient.clear();

    const restarted = mount();
    await vi.waitFor(() => expect(boundary.attempts).toHaveLength(4));
    await new Promise((resolve) => setTimeout(resolve, delay));
    boundary.releaseHeld();
    await vi.waitFor(() => expect(boundary.attempts).toHaveLength(5));
    await vi.waitFor(() => expect(restarted.hook.result.current.localSaveState?.status).toBe('saved'));
    const a = { body: boundary.attempts[0].body, key: boundary.attempts[0].key };
    const b = { body: boundary.attempts[4].body, key: boundary.attempts[4].key };
    assertExactLifecycle(boundary.attempts, boundary.forwarded, `${origin}${path}`, a, b);
    expect(boundary.attempts[4].body).not.toBe(a.body);
    expect(boundary.attempts[4].key).not.toBe(a.key);
    expect((await createCommitOutbox().list(scope))[0]?.intents).toEqual([]);
    restarted.hook.unmount();
    restarted.queryClient.clear();
    return { attempts: boundary.attempts, forwarded: boundary.forwarded };
  } finally {
    if (previousLocks) Object.defineProperty(navigator, 'locks', previousLocks);
    else Reflect.deleteProperty(navigator, 'locks');
    vi.unstubAllGlobals();
  }
}

describe('mounted timeline save recovery accounting', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([{ name: 'fast', delay: 0 }, { name: 'slow', delay: 8 }])('$name schedule preserves real 5/3 lifecycle counts', async ({ delay }) => {
    await mountedLifecycle(delay);
  });

  it('rejects wrong key/body/URL/origin and missing, extra, reordered, or double-forwarded attempts', () => {
    const a = { body: '{"commands":["A"]}', key: 'a' };
    const b = { body: '{"commands":["B"]}', key: 'b' };
    const url = `${origin}${path}`;
    const attempts = (changes: Partial<Attempt>[] = []) => [a, a, a, a, b].map((identity, index) => ({ ...identity, url, forwarded: [0, 3, 4].includes(index), ...changes[index] }));
    const forwarded = (all: Attempt[]) => all.filter((attempt) => attempt.forwarded);
    expect(() => assertExactLifecycle(attempts([{ key: 'wrong' }]), forwarded(attempts([{ key: 'wrong' }])), url, a, b)).toThrow();
    expect(() => assertExactLifecycle(attempts([{ body: 'wrong' }]), forwarded(attempts([{ body: 'wrong' }])), url, a, b)).toThrow();
    expect(() => assertExactLifecycle(attempts([{ url: 'http://wrong.test/commit' }]), forwarded(attempts([{ url: 'http://wrong.test/commit' }])), url, a, b)).toThrow();
    expect(() => assertExactLifecycle(attempts([{ url: 'http://127.0.0.1:49501/commit' }]), forwarded(attempts([{ url: 'http://127.0.0.1:49501/commit' }])), url, a, b)).toThrow();
    for (const invalid of [attempts().slice(0, 4), [...attempts(), { ...attempts()[4] }], [a, a, a, b, a], attempts([{}, { forwarded: true }])]) {
      expect(() => assertExactLifecycle(invalid, forwarded(invalid), url, a, b)).toThrow();
    }
  });
});

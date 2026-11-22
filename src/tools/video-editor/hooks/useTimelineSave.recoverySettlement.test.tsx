// @vitest-environment jsdom
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { createFakeIndexedDB, resetFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { CommitRequest } from '@/integrations/runtime/timeline-commit-types.ts';
import type { DataProvider, TimelineCommandBasis, TimelineCommitResult } from '../data/DataProvider.ts';
import { createCommitOutbox } from '../commands/commitOutbox.ts';
import { createTimelineStore } from './timelineStore.ts';
import { useTimelineSave } from './useTimelineSave.ts';
import { createInteractionState } from '../lib/interaction-state.ts';
import { createDefaultTimelineConfig } from '../lib/defaults.ts';
import { buildTimelineData } from '../lib/timeline-data.ts';
import { VideoEditorRuntimeProvider, type VideoEditorRuntimeContextValue } from '../contexts/VideoEditorRuntimeContext.tsx';

const scope = { realmId: 'realm-recovery-settlement', actorId: 'actor-recovery-settlement', projectId: 'project-recovery-settlement', timelineId: 'timeline-recovery-settlement' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type DraftSnapshot = { draft: { config: { output: { file: string }; background: { color: string } } } };

async function rawRecoveryRecord(key: string): Promise<DraftSnapshot | null> {
  const request = indexedDB.open('astrid.timeline-drafts', 1);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
  });
  try {
    return await new Promise<DraftSnapshot | null>((resolve, reject) => {
      const tx = db.transaction('timeline-drafts', 'readonly');
      const read = tx.objectStore('timeline-drafts').get(key);
      read.addEventListener('success', () => resolve(read.result ?? null));
      read.addEventListener('error', () => reject(read.error));
    });
  } finally { db.close(); }
}

it('does not re-offer an accepted outbox save after immediate editor death, and the next edit commits', async () => {
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
  const registry = { assets: {} };
  const seed = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' }, scope);
  seed.data.canonical_document.parent_revision.payload = { config, clips: config.clips, registry, occurrences: [] };
  seed.data.canonical_document.parent_revision.content_digest = fixtureDigest(seed.data.canonical_document.parent_revision.payload);
  const original: TimelineCommandBasis = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: seed.data.canonical_document };
  const head = { projectId: scope.projectId, timelineId: scope.timelineId, headRevisionId: 'r0', headPublicationId: 'p0' };
  const initialData = await buildTimelineData(config, registry, undefined, 1, undefined, head);
  const acceptedConfig = { ...config, output: { ...config.output, file: 'accepted.mp4' } };
  const normalizedConfig = { ...acceptedConfig, background: { ...acceptedConfig.background, color: '#123456' } };
  const acceptedDocument = structuredClone(seed.data.canonical_document);
  acceptedDocument.parent_revision.revision_id = 'r1';
  acceptedDocument.parent_revision.payload.config = normalizedConfig;
  acceptedDocument.parent_revision.payload.clips = normalizedConfig.clips;
  acceptedDocument.parent_revision.content_digest = fixtureDigest(acceptedDocument.parent_revision.payload);
  const acceptedData = await buildTimelineData(normalizedConfig, registry, undefined, 2, undefined,
    { ...head, headRevisionId: 'r1', headPublicationId: 'p1' });
  const gate = deferred<TimelineCommandBasis>();
  let basisReads = 0;
  const commits: CommitRequest[] = [];
  const provider: DataProvider = {
    persistenceEnabled: true,
    loadTimeline: async () => ({ config, configVersion: 1 }),
    loadAssetRegistry: async () => registry,
    resolveAssetUrl: async (file) => file,
    saveTimeline: async () => { throw new Error('legacy save route used'); },
    loadTimelineCommandBasis: async () => {
      basisReads++;
      return basisReads === 1 ? original : await gate.promise;
    },
    getRecoverableIdentity: async () => ({ realmId: scope.realmId, actorId: scope.actorId }),
    commitTimeline: async (request) => {
      commits.push(request);
      const revisionId = request.base_revision_id === 'r0' ? 'r1' : 'r2';
      const publicationId = request.base_publication_id === 'p0' ? 'p1' : 'p2';
      const response = acceptedCommit({ revision_id: revisionId, publication_id: publicationId },
        { revision_id: request.base_revision_id, publication_id: request.base_publication_id },
        { ...scope, commands: request.commands });
      response.data.canonical_document = structuredClone(acceptedDocument);
      const parent = response.data.canonical_document.parent_revision;
      parent.revision_id = revisionId;
      if (revisionId === 'r2') {
        parent.payload.config = { ...normalizedConfig, output: { ...normalizedConfig.output, file: 'next.mp4' } };
        parent.content_digest = fixtureDigest(parent.payload);
      }
      response.data.document_digest = fixtureDigest(response.data.canonical_document);
      response.receipt.idempotency_key = request.label;
      return { response, accepted: { revisionId, publicationId }, canonicalDocument: response.data.canonical_document, graph: {}, receipt: response.receipt } as TimelineCommitResult;
    },
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

  const mount = (data: typeof initialData, editorProvider: DataProvider = provider) => {
    const store = createTimelineStore();
    const runtime = { provider: editorProvider, timelineId: scope.timelineId, project: { projectId: scope.projectId },
      shots: { shots: undefined, isLoading: false, error: null, refetchShots: vi.fn() }, toast: { error: vi.fn() } } as unknown as VideoEditorRuntimeContextValue;
    const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(
      QueryClientProvider, { client: queryClient }, React.createElement(VideoEditorRuntimeProvider, { value: runtime }, children));
    return renderHook(() => useTimelineSave({ timelineQuery: { data: undefined, isLoading: false }, assetRegistryQuery: { data: undefined } },
      editorProvider, { current: createInteractionState() }, store, data), { wrapper });
  };

  const first = mount(initialData);
  try {
    await vi.waitFor(() => expect(first.result.current.localSaveState?.ownerId).toBeTruthy());
    const edited = await buildTimelineData({ ...config, output: { ...config.output, file: 'accepted.mp4' } }, registry, undefined, 1, undefined, head);
    await act(async () => { first.result.current.commitData(edited, { save: true }); });
    await vi.waitFor(async () => {
      const [row] = await createCommitOutbox().list(scope);
      expect(row?.accepted?.head).toEqual({ revisionId: 'r1', publicationId: 'p1' });
      expect(row?.intents).toEqual([]);
    });
    expect(commits).toHaveLength(1);
    await vi.waitFor(() => expect(basisReads).toBe(2));
    const raw = await rawRecoveryRecord(scope.timelineId);
    expect(raw?.draft?.config?.output?.file).toBe('accepted.mp4');
    expect(raw?.draft?.config?.background?.color).not.toBe('#123456');

    first.unmount();
    const acceptedBasis = { head: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: acceptedDocument };
    gate.resolve(acceptedBasis);
    await vi.waitFor(() => expect(locks.size).toBe(0));
    expect(await rawRecoveryRecord(scope.timelineId)).toEqual(raw);
    const reopenedProvider: DataProvider = { ...provider, loadTimelineCommandBasis: async () => acceptedBasis };
    const reopened = mount(acceptedData, reopenedProvider);
    try {
      await vi.waitFor(() => expect(reopened.result.current.localSaveState?.ownerId).toBeTruthy());
      await vi.waitFor(async () => expect(await rawRecoveryRecord(scope.timelineId)).toBeNull());
      expect(reopened.result.current.saveBar).toBeNull();
      expect(reopened.result.current.data?.head?.headRevisionId).toBe('r1');
      expect(reopened.result.current.data?.config.background.color).toBe('#123456');
      const next = await buildTimelineData({ ...normalizedConfig, output: { ...normalizedConfig.output, file: 'next.mp4' } },
        registry, undefined, 2, undefined, { ...head, headRevisionId: 'r1', headPublicationId: 'p1' });
      await act(async () => { reopened.result.current.commitData(next, { save: true }); });
      await act(async () => { await reopened.result.current.flushPendingSave(); });
      expect(commits).toHaveLength(2);
      expect(commits[1].base_revision_id).toBe('r1');
      expect(reopened.result.current.localSaveState?.status).toBe('saved');
      expect(reopened.result.current.data?.config.output.file).toBe('next.mp4');
      expect(reopened.result.current.saveBar).toBeNull();
    } finally { reopened.unmount(); }
  } finally {
    first.unmount();
    queryClient.clear();
    if (previousLocks) Object.defineProperty(navigator, 'locks', previousLocks);
    else Reflect.deleteProperty(navigator, 'locks');
    vi.unstubAllGlobals();
  }
});

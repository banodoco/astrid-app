import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB, resetFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { ApiError } from '@/integrations/runtime/generated.ts';
import type { CommitRequest } from '@/integrations/runtime/timeline-commit-types.ts';
import { createCommitOutbox } from '../commands/commitOutbox.ts';
import { VideoEditorRuntimeProvider, type VideoEditorRuntimeContextValue } from '../contexts/VideoEditorRuntimeContext.tsx';
import type { DataProvider, TimelineCommandBasis, TimelineCommitResult } from '../data/DataProvider.ts';
import { createDefaultTimelineConfig } from '../lib/defaults.ts';
import { createInteractionState } from '../lib/interaction-state.ts';
import { buildTimelineData } from '../lib/timeline-data.ts';
import type { TimelineConfig } from '../types/index.ts';
import { useClipEditing } from './useClipEditing.ts';
import { useTimelineSave } from './useTimelineSave.ts';
import { createTimelineStore } from './timelineStore.ts';

vi.mock('@/tools/video-editor/compositions/TimelineRenderer.tsx', () => ({ invalidateReferencedTimelineCache: vi.fn() }));
vi.mock('@/integrations/runtime/generated-contract-metadata.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/integrations/runtime/generated-contract-metadata.ts')>(),
  SCHEMA_DIGEST: 'sha256:9628bb5fd6e1dbbec392dd39f2e01031622dcf52d7ccff7cd1f0ad10743dcb1c',
}));

beforeEach(() => {
  vi.useFakeTimers();
  resetFakeIndexedDB();
  vi.stubGlobal('indexedDB', createFakeIndexedDB());
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function eventually(check: () => void | Promise<void>) {
  let failure: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    try { await check(); return; } catch (error) { failure = error; }
  }
  throw failure;
}

describe('mounted split and inspector trim authoring reads', () => {
  it.each(['label merge', 'source conflict', 'membership conflict'] as const)(
    'retains original dependent reads and exact lost-ACK request across restart: %s', async (outcome) => {
      const locks = new Set<string>();
      const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
      Object.defineProperty(navigator, 'locks', { configurable: true, value: {
        request: async (name: string, _options: unknown, work: (lock: object | null) => Promise<unknown>) => {
          if (locks.has(name)) return work(null);
          locks.add(name);
          try { return await work({}); } finally { locks.delete(name); }
        },
      } });
      const head = { projectId: 'project-commit', timelineId: 'timeline-1', headRevisionId: 'r0', headPublicationId: 'p0' };
      const config: TimelineConfig = { ...createDefaultTimelineConfig(), clips: [
        { id: 'original', track: 'V1', at: 0, asset: 'media', from: 0, to: 8, speed: 1,
          app: { 'org.example': { keep: [null, false] } } },
        { id: 'OTHERCLIP', track: 'V1', at: 10, asset: 'media', from: 0, to: 2, speed: 1, label: 'Other' },
      ] };
      const registry = { assets: { media: { file: 'media.mp4', type: 'video/mp4', duration: 8 } } };
      const document = acceptedCommit({ revision_id: 'r0', publication_id: 'p0' }, { revision_id: 'r0', publication_id: 'p0' },
        { timelineId: head.timelineId }).data.canonical_document;
      document.parent_revision.payload = { config, clips: structuredClone(config.clips), registry, occurrences: [], opaque: { keep: null } };
      document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
      const initial: TimelineCommandBasis = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: document };
      let latest = initial;
      const send = vi.fn<(request: CommitRequest, key: string) => Promise<TimelineCommitResult>>();
      const legacy = vi.fn(async () => { throw new Error('Legacy save must not run'); });
      const provider = { persistenceEnabled: true, loadTimelineCommandBasis: async () => latest,
        getRecoverableIdentity: async () => ({ actorId: 'actor', realmId: 'realm' }), commitTimeline: send,
        saveTimeline: legacy, resolveAssetUrl: async (file: string) => file,
        loadTimeline: async () => ({ config, configVersion: 1 }), loadAssetRegistry: async () => registry,
      } as unknown as DataProvider;
      const data = await buildTimelineData(config, registry, undefined, 1, undefined, head);
      const mount = (seed = data) => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
        const store = createTimelineStore();
        const interaction = { current: createInteractionState() };
        const runtime = { provider, timelineId: head.timelineId, shots: { canonicalDraft: null },
          assetResolver: { resolveAssetUrl: provider.resolveAssetUrl },
        } as unknown as VideoEditorRuntimeContextValue;
        return renderHook(() => {
          const save = useTimelineSave({ timelineQuery: { data: undefined, isLoading: false }, assetRegistryQuery: { data: undefined } },
            provider, interaction, store, seed);
          const editing = useClipEditing({ dataRef: save.dataRef, resolvedConfig: save.data?.resolvedConfig ?? null,
            selectedClipId: save.selectedClipId, selectedTrack: null, currentTime: 4,
            selectClip: vi.fn(), setSelectedTrackId: save.setSelectedTrackId, applyEdit: save.applyEdit });
          return { save, editing };
        }, { wrapper: ({ children }) => <QueryClientProvider client={client}>
          <VideoEditorRuntimeProvider value={runtime}>{children}</VideoEditorRuntimeProvider>
        </QueryClientProvider> });
      };
      const scope = { realmId: 'realm', actorId: 'actor', projectId: head.projectId, timelineId: head.timelineId };
      const first = mount();
      let recovered: ReturnType<typeof mount> | undefined;
      try {
        await eventually(() => expect(first.result.current.save.localSaveState?.ownerId).toBeTruthy());
        act(() => first.result.current.editing.handleSplitClipAtTime('original', 4));
        const rightId = first.result.current.save.selectedClipId!;
        expect(rightId).not.toBe('original');
        expect(first.result.current.save.dataRef.current?.config.clips).toMatchObject([
          { id: 'original', from: 0, to: 4 }, { id: rightId, at: 4, from: 4, to: 8 }, { id: 'OTHERCLIP', label: 'Other' },
        ]);
        act(() => first.result.current.editing.handleSelectedClipChange({ from: 5 }));
        expect(first.result.current.save.dataRef.current?.config.clips[1].from).toBe(5);
        await eventually(async () => expect((await createCommitOutbox().list(scope))[0].intents).toHaveLength(2));
        const [authored] = await createCommitOutbox().list(scope);
        const splitIntent = authored.intents[0].payload.documentIntent as Record<string, unknown>;
        const trimIntent = structuredClone(authored.intents[1].payload);
        expect(authored.intents[1].basis).toEqual({ after: authored.intents[0].id });
        expect(splitIntent.created).toEqual([`parent/clip:${rightId}`]);
        expect(splitIntent.step).toMatchObject({ intent: 'Split original at 4' });
        expect((trimIntent.documentIntent as Record<string, unknown>).step).toMatchObject({ intent: `Trim ${rightId}: {"from":5}` });
        const reads = (trimIntent.documentIntent as Record<string, unknown>).reads as unknown[];
        expect(reads).toContainEqual({ kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${rightId}`, 'to'],
          state: { state: 'present', value: 8 } });
        expect(reads).toContainEqual({ kind: 'field', ref: 'parent', path: ['config', 'registry', 'assets', 'media'],
          state: { state: 'present', value: registry.assets.media } });
        expect(reads).toContainEqual({ kind: 'field', ref: 'parent', path: ['config', 'output', 'fps'],
          state: { state: 'present', value: 30 } });
        expect(reads.some((read) => (read as { kind: string }).kind === 'collection')).toBe(false);
        expect(reads).not.toContainEqual(expect.objectContaining({ path: ['config', 'clips'] }));
        expect(splitIntent.reads).toContainEqual({ kind: 'collection', ref: 'parent', path: ['config', 'clips'],
          members: ['OTHERCLIP', 'original'], order: ['original', 'OTHERCLIP'] });
        expect(splitIntent.reads).toContainEqual({ kind: 'field', ref: 'parent', path: ['config', 'pinnedShotGroups'], state: { state: 'absent' } });
        expect(reads.some((read) => (read as { path: string[] }).path.at(-1) === 'label')).toBe(false);
        const splitDoc = (authored.intents[0].payload.after as unknown as typeof document);
        const finalDoc = (authored.intents[1].payload.after as unknown as typeof document);
        const reply = (request: CommitRequest, payload: typeof document, status: 'accepted' | 'merged', revision: string): TimelineCommitResult => {
          const response = acceptedCommit({ revision_id: revision, publication_id: `p-${revision}` },
            { revision_id: request.base_revision_id, publication_id: request.base_publication_id }, { timelineId: head.timelineId });
          response.data.canonical_document = structuredClone(payload);
          response.data.canonical_document.parent_revision.revision_id = revision;
          const steps = request.steps!.map((step) => ({ ...step, dependencies: request.reads }));
          Object.assign(response.data, { status, merge_mode: 'fields', steps });
          return { response, accepted: { revisionId: revision, publicationId: `p-${revision}` },
            canonicalDocument: response.data.canonical_document, receipt: response.receipt, graph: {} };
        };
        send.mockImplementationOnce(async (request) => {
          expect(request.commands[0].created).toEqual([`parent/clip:${rightId}`]);
          expect(request.reads).toEqual(splitIntent.reads);
          expect(request.steps![0].patch).toEqual(request.commands[0].args.changes);
          return reply(request, splitDoc, 'accepted', 'r1');
        })
          .mockImplementationOnce(async (request) => {
            expect(first.result.current.save.dataRef.current?.head?.headRevisionId).toBe('r1');
            expect(first.result.current.save.dataRef.current?.config.clips[1].from).toBe(4);
            expect(request).toMatchObject({ base_revision_id: 'r1', base_publication_id: 'p-r1', merge: 'fields', reads });
            throw new Error('Lost acknowledgement');
          });
        await act(async () => { await expect(first.result.current.save.flushPendingSave()).rejects.toThrow(); });
        const [uncertain] = await createCommitOutbox().list(scope);
        const exact = structuredClone(uncertain.pending!.request);
        expect(uncertain.intents[0].payload).toEqual(trimIntent);
        const agentDoc = structuredClone(splitDoc);
        const agentConfig = agentDoc.parent_revision.payload.config as unknown as TimelineConfig;
        agentConfig.tracks![0].label = 'Agent label';
        agentConfig.clips.find((clip) => clip.id === 'OTHERCLIP')!.label = 'Agent other clip label';
        if (outcome === 'source conflict') agentConfig.clips[1].to = 7;
        if (outcome === 'membership conflict') agentConfig.tracks!.push({ id: 'V4', kind: 'visual' });
        agentDoc.parent_revision.payload.clips = structuredClone(agentConfig.clips);
        agentDoc.parent_revision.content_digest = fixtureDigest(agentDoc.parent_revision.payload);
        agentDoc.parent_revision.revision_id = 'agent-r';
        latest = { head: { revisionId: 'agent-r', publicationId: 'agent-p' }, canonicalDocument: agentDoc };
        first.unmount();
        await eventually(() => expect(locks.size).toBe(0));
        send.mockImplementationOnce(async (request, key) => {
          expect(JSON.stringify(request)).toBe(exact.body);
          expect(key).toBe(exact.key);
          expect(request.steps![0].patch).toEqual(request.commands[0].args.changes);
          expect(request.reads).toEqual(reads);
          if (outcome !== 'label merge') throw new ApiError(409, 'dependency_changed', 'Original gesture input changed', '', {
            status: 'conflict', reason: outcome === 'source conflict' ? 'dependency_changed' : 'selection_changed', head: latest.head,
          });
          const merged = structuredClone(finalDoc);
          (merged.parent_revision.payload.config as unknown as TimelineConfig).tracks![0].label = 'Agent label';
          const other = (merged.parent_revision.payload.config as unknown as TimelineConfig).clips.find((clip) => clip.id === 'OTHERCLIP')!;
          other.label = 'Agent other clip label';
          merged.parent_revision.payload.clips = structuredClone((merged.parent_revision.payload.config as unknown as TimelineConfig).clips);
          return reply(request, merged, 'merged', 'r3');
        });
        const recoveredData = await buildTimelineData(agentConfig, registry, undefined, 1, undefined, {
          ...head, headRevisionId: 'agent-r', headPublicationId: 'agent-p',
        });
        recovered = mount(recoveredData);
        await eventually(() => expect(recovered!.result.current.save.localSaveState?.status).toBe(outcome === 'label merge' ? 'saved' : 'conflict'));
        const [settled] = await createCommitOutbox().list(scope);
        const visible = recovered.result.current.save.dataRef.current!;
        expect(visible.config.tracks![0].label).toBe('Agent label');
        expect(visible.config.clips.find((clip) => clip.id === 'OTHERCLIP')!.label).toBe('Agent other clip label');
        if (outcome === 'label merge') {
          expect(settled.intents).toHaveLength(0);
          expect(settled.accepted?.value).toMatchObject({ response: { data: { status: 'merged', merge_mode: 'fields',
            steps: [{ dependencies: reads }] } } });
          expect(visible.config.clips[1].from).toBe(5);
        } else {
          expect(settled.intents[0].payload).toEqual(trimIntent);
          expect(settled.pending?.outcome).toMatchObject({ kind: 'rejected', error: { message: 'dependency_changed: Original gesture input changed' } });
          expect(visible.config.clips[1].from).toBe(4);
          expect(recovered.result.current.save.localSaveState?.error).toMatchObject({ message: 'dependency_changed: Original gesture input changed' });
        }
        expect(visible.config.clips[1].app).toEqual({ 'org.example': { keep: [null, false] } });
        expect(visible.config.clips[1].app).not.toHaveProperty('astrid');
        expect(settled.accepted?.value).toMatchObject({ canonicalDocument: { parent_revision: { payload: { opaque: { keep: null } } } } });
        expect(legacy).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(3);
      } finally {
        first.unmount();
        recovered?.unmount();
        await eventually(() => expect(locks.size).toBe(0));
        if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
        else Reflect.deleteProperty(navigator, 'locks');
      }
    });
});

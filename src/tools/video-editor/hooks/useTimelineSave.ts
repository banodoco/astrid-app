import { withTimelineBasisDiagnostics } from '../lib/timeline-basis-diagnostics.ts';
import { type AstridElementOperationAdapter, type ElementTimelineRoutes, type ElementTimelineDocument } from '../runtime/element-adapter.ts';
import type { AstridAgentElementContext } from '../runtime/element-contract.ts';
import { persistedTranscriptItems } from '../data/typed/projectTranscript.ts';
import type { RegistrationSaveOwner } from './timeline-state-types.ts';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { InteractionStateRef } from '@/tools/video-editor/lib/interaction-state.ts';
import { useTimelineCommit, type OwnedRegistryMutation, type TimelineEditMutation } from '@/tools/video-editor/hooks/useTimelineCommit.ts';
import { TimelineEventBus } from '@/tools/video-editor/hooks/useTimelineEventBus.ts';
import { useTimelinePersistence } from '@/tools/video-editor/hooks/useTimelinePersistence.ts';
import { clearTimelineDraft, loadTimelineDraft } from '@/tools/video-editor/data/timelineDraftIndexedDb.ts';
import { buildTimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import { getStableConfigSignature } from '@/tools/video-editor/lib/config-utils.ts';
import { withDefaultTimelineOutput } from '@/tools/video-editor/lib/defaults.ts';
import type { AssetRegistry, TimelineConfig } from '@/tools/video-editor/types/index.ts';
import { usePollSync, type UsePollSyncQueries } from '@/tools/video-editor/hooks/usePollSync.ts';
import type { TimelineStoreApi } from '@/tools/video-editor/hooks/timelineStore.ts';
import { useVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import { isDataProviderPersistenceEnabled, TimelineSaveError, type DataProvider, type TimelineHeadRevision } from '@/tools/video-editor/data/DataProvider.ts';
import type { TimelineDraftRecord } from '@/tools/video-editor/data/timelineDraftIndexedDb.ts';
import { canonicalJsonStringify, parseTimelineBundle, type TimelineBundleEnvelope } from '@/tools/video-editor/data/typed/timelineBundle.ts';
import type { TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import { createTimelineLocalSaveHandoff, readTimelineOriginalSaveBasis, type TimelineLocalSaveHandoff, type TimelineOriginalSaveBasis, type TimelineSaveSource, type TimelineGestureReadBasis } from './timelineLocalSaveHandoff.ts';
import { createLocalSaveSession, type LocalSaveSession, type LocalSaveState } from '../commands/localSaveSession.ts';
import { toOutboxJson } from '../commands/commitOutbox.ts';
import { emitTimelineSaveDiagnostic, markTimelineSaveRejection } from '../lib/timeline-diagnostics.ts';
export { shouldAcceptPolledData } from '@/tools/video-editor/lib/timeline-save-utils.ts';
export type { SaveStatus } from '@/tools/video-editor/hooks/useTimelinePersistence.ts';

type UseTimelineSaveQueries = UsePollSyncQueries;

export type { InteractionStateRef } from '@/tools/video-editor/lib/interaction-state.ts';

interface PendingOriginalSaveRead {
  provider: DataProvider;
  timelineId: string;
  headKey: string;
  original: TimelineData;
  editSeq: number;
  readOrdinal: number;
  promise: Promise<TimelineOriginalSaveBasis>;
  settled: boolean;
}

const elementParameterOwners = new WeakMap<ElementTimelineRoutes, { context: AstridAgentElementContext; adapter: AstridElementOperationAdapter }>();

/** Share the mounted adapter's authority with its exact Inspector source. */
export function bindElementParameterOwner(routes: ElementTimelineRoutes, context: AstridAgentElementContext, adapter: AstridElementOperationAdapter) {
  const binding = { context, adapter };
  elementParameterOwners.set(routes, binding);
  return () => { if (elementParameterOwners.get(routes) === binding) elementParameterOwners.delete(routes); };
}

/** Keep parameter gestures on the scoped element route, before generic serialization. */
export async function saveElementParameterEdit(current: TimelineData, mutation: TimelineEditMutation,
  basis: TimelineGestureReadBasis, routes: ElementTimelineRoutes, timelineId: string, adapter: AstridElementOperationAdapter) {
  if (basis.kind !== 'element') throw new TimelineSaveError('Element parameter basis is unavailable; draft retained');
  const op = basis.operation;
  if (!op || op.name !== 'timeline.update_element' || !op.params || op.element || op.duration !== undefined
    || op.clip_id !== basis.clipId || op.timeline !== timelineId || op.expected_version !== current.configVersion
    || mutation.type !== 'config' || mutation.pinnedShotGroupsOverride !== undefined || !current.head
    || canonicalJsonStringify(basis.config) !== canonicalJsonStringify(current.config)
    || canonicalJsonStringify(basis.registry) !== canonicalJsonStringify(current.registry)
    || canonicalJsonStringify(mutation.resolvedConfig) !== canonicalJsonStringify({ ...current.resolvedConfig,
      clips: current.resolvedConfig.clips.map(clip => clip.id === op.clip_id
        ? { ...clip, params: { ...clip.params, ...op.params } } : clip) })) {
    throw new TimelineSaveError('Element parameter source changed; draft retained');
  }
  const original = await routes.get(timelineId);
  if (canonicalJsonStringify(original.config) !== canonicalJsonStringify(basis.config)
    || canonicalJsonStringify(original.registry) !== canonicalJsonStringify(basis.registry)
    || canonicalJsonStringify(original.head ?? null) !== canonicalJsonStringify(current.head)
    || original.config_version !== current.configVersion) {
    throw new TimelineSaveError('Element parameter owner changed; draft retained');
  }
  return adapter.execute(op);
}

export function useTimelineSave(
  queries: UseTimelineSaveQueries,
  provider: DataProvider,
  interactionStateRef: InteractionStateRef,
  store: TimelineStoreApi,
  initialData?: TimelineData,
) {
  const { timelineId, assetResolver, timelineEditability, shots, toast } = useVideoEditorRuntime();
  const resolveAssetUrl = useCallback(async (file: string) => {
    if (assetResolver) {
      return await assetResolver.resolveAssetUrl(file);
    }

    return await provider.resolveAssetUrl(file);
  }, [assetResolver, provider]);
  const lastSavedSignatureRef = useRef(initialData?.stableSignature ?? '');
  const savedSeqRef = useRef(0);
  // Start at 0 so a fresh bridge timeline (config_version 0) is not rejected
  // as "stale" by the poll gate (polled < current). The bridge CAS is strict
  // equality, so the first save POSTs expected_version 0 and succeeds.
  const configVersionRef = useRef(initialData?.configVersion ?? 0);
  const headRevisionRef = useRef(initialData?.head);
  const recoveryPendingRef = useRef(false);
  // Includes the asynchronous initial draft check and Retry awaiting an ACK.
  const recoveryActiveRef = useRef(true);
  const eventBusRef = useRef(new TimelineEventBus());
  // Recovery Retry performs async read/build work before entering persistence.
  // Canonical reloads must invalidate that work at their shared boundary.
  const recoveryActionGenerationRef = useRef(0);
  const invalidateRecoveryAction = useCallback(() => {
    recoveryActionGenerationRef.current += 1;
  }, []);
  const commit = useTimelineCommit({
    eventBus: eventBusRef.current,
    lastSavedSignatureRef,
    editability: timelineEditability,
    initialData,
    resolveAssetUrl,
  });
  const [originalLocalSaveBasis, setOriginalLocalSaveBasis] = useState<
    { status: 'ready'; value: TimelineOriginalSaveBasis } | { status: 'unavailable'; reason: string } | { status: 'loading' } | null
  >(null);
  const [localSaveState, setLocalSaveState] = useState<LocalSaveState | null>(null);
  const localOwner = useMemo(() => ({ provider, timelineId, closed: false, started: false, generation: 0,
    headKey: '', recovered: false,
    retirement: undefined as Promise<void> | undefined,
    ready: undefined as Promise<TimelineLocalSaveHandoff> | undefined,
    handoff: undefined as TimelineLocalSaveHandoff | undefined,
    session: undefined as LocalSaveSession | undefined }), [provider, timelineId]);
  const usesLocalDocumentSave = Boolean(provider.loadTimelineCommandBasis && provider.commitTimeline && provider.getRecoverableIdentity);
  // Stable from the first render: a gesture during assembly cannot fall through
  // to the old snapshot writer while the verified original is being loaded.
  const localDocumentSave = useMemo<TimelineLocalSaveHandoff | undefined>(() => usesLocalDocumentSave ? {
    async capture(source, gestureBasis) {
      emitTimelineSaveDiagnostic('capture-called', () => ({ owner: localOwner, timelineId: localOwner.timelineId,
        source, gesture: gestureBasis,
        clipId: gestureBasis?.clipId,
        generation: localOwner.generation, closed: localOwner.closed, sessionPresent: Boolean(localOwner.session) }));
      try {
        const original = structuredClone(source);
        const originalReads = gestureBasis ? structuredClone(gestureBasis) : undefined;
        if (localOwner.closed || !localOwner.ready) throw markTimelineSaveRejection(new TimelineSaveError('Original local save session is unavailable; draft retained'), 'capture-owner-unavailable', 'TimelineSaveError');
        const handoff = await localOwner.ready;
        if (localOwner.closed) throw markTimelineSaveRejection(new TimelineSaveError('Local save session was replaced; draft retained'), 'capture-owner-replaced', 'TimelineSaveError');
        await handoff.capture(original, originalReads);
        emitTimelineSaveDiagnostic('capture-resolved', () => ({ owner: localOwner, timelineId: localOwner.timelineId,
          source: original, gesture: originalReads,
          generation: localOwner.generation, closed: localOwner.closed, sessionPresent: Boolean(localOwner.session) }));
      } catch (error) {
        emitTimelineSaveDiagnostic('capture-rejected', () => ({ error, owner: localOwner, timelineId: localOwner.timelineId,
          gesture: gestureBasis,
          generation: localOwner.generation, closed: localOwner.closed, sessionPresent: Boolean(localOwner.session) }));
        throw error;
      }
    },
    async flush() {
      if (localOwner.closed || !localOwner.ready) throw new TimelineSaveError('Original local save session is unavailable; draft retained');
      const handoff = await localOwner.ready;
      if (localOwner.closed) throw new TimelineSaveError('Local save session was replaced; draft retained');
      return handoff.flush();
    },
    remoteHistoryAvailable: () => localOwner.handoff?.remoteHistoryAvailable() ?? false,
    canUndo: () => localOwner.handoff?.canUndo() ?? false,
    canRedo: () => localOwner.handoff?.canRedo() ?? false,
    undo: async () => {
      const handoff = await localOwner.ready;
      if (localOwner.closed || !handoff) throw new TimelineSaveError('Original local save session is unavailable; draft retained');
      try { await handoff.undo(); }
      finally { if (!localOwner.closed) setLocalSaveState((current) => current ? { ...current } : current); }
    },
    redo: async () => {
      const handoff = await localOwner.ready;
      if (localOwner.closed || !handoff) throw new TimelineSaveError('Original local save session is unavailable; draft retained');
      try { await handoff.redo(); }
      finally { if (!localOwner.closed) setLocalSaveState((current) => current ? { ...current } : current); }
    },
  } : undefined, [localOwner, usesLocalDocumentSave]);
  useEffect(() => {
    localOwner.closed = false;
    emitTimelineSaveDiagnostic('owner-init', () => ({ owner: localOwner, timelineId: localOwner.timelineId, closed: localOwner.closed,
      generation: localOwner.generation, sessionPresent: Boolean(localOwner.session) }));
    setLocalSaveState(null);
    return () => {
      localOwner.closed = true;
      localOwner.generation++;
      localOwner.started = false;
      localOwner.ready = undefined;
      localOwner.handoff = undefined;
      emitTimelineSaveDiagnostic('owner-closed', () => ({ owner: localOwner, timelineId: localOwner.timelineId, closed: localOwner.closed,
        generation: localOwner.generation, sessionPresent: Boolean(localOwner.session) }));
      void localOwner.session?.dispose().catch(() => {});
    };
  }, [localOwner]);
  const { dataRef: localDataRef, editSeqRef: localEditSeqRef, commitData: adoptCanonicalData } = commit;
  const originalHeadKey = canonicalJsonStringify(commit.data?.head ?? null);
  // Updated only after commit. A suspended/aborted render cannot supply a
  // dependency-change claim. Cleanup alone cannot distinguish unmount from
  // replacement; the next committed effect supplies that observation.
  const committedBasisDependencies = useRef<readonly unknown[] | null>(null);
  const basisReadOrdinal = useRef(0);
  const pendingOriginalSaveReadRef = useRef<PendingOriginalSaveRead | null>(null);
  useEffect(() => {
    const dependencies = [provider, timelineId, originalHeadKey, localDataRef, localEditSeqRef, adoptCanonicalData, localOwner, resolveAssetUrl, usesLocalDocumentSave];
    const previous = committedBasisDependencies.current;
    committedBasisDependencies.current = dependencies;
    emitTimelineSaveDiagnostic('basis-dependencies-committed', () => ({ owner: localOwner,
      generation: localOwner.generation, dependencyBaselinePresent: previous !== null,
      providerChanged: previous ? !Object.is(previous[0], provider) : undefined,
      timelineChanged: previous ? !Object.is(previous[1], timelineId) : undefined,
      headChanged: previous ? !Object.is(previous[2], originalHeadKey) : undefined,
      dataRefChanged: previous ? !Object.is(previous[3], localDataRef) : undefined,
      editSeqRefChanged: previous ? !Object.is(previous[4], localEditSeqRef) : undefined,
      adoptionChanged: previous ? !Object.is(previous[5], adoptCanonicalData) : undefined,
      ownerChanged: previous ? !Object.is(previous[6], localOwner) : undefined,
      resolverChanged: previous ? !Object.is(previous[7], resolveAssetUrl) : undefined,
      localSaveChanged: previous ? !Object.is(previous[8], usesLocalDocumentSave) : undefined }));
    let previousDisposal = localOwner.retirement;
    let sessionCreation: Promise<LocalSaveSession> | undefined;
    if (localOwner.started) {
      if (localOwner.headKey === originalHeadKey || localOwner.session?.getState().status !== 'saved'
        || localEditSeqRef.current !== savedSeqRef.current) return;
      // A clean poll/reload establishes a new original, after retiring the old
      // display owner. Dirty chains retain their original physical bindings.
      localOwner.generation++;
      previousDisposal = localOwner.session.dispose();
      localOwner.session = undefined;
      localOwner.handoff = undefined;
      localOwner.started = false;
      emitTimelineSaveDiagnostic('owner-retired', () => ({ owner: localOwner, timelineId,
        generation: localOwner.generation, sessionPresent: Boolean(localOwner.session) }));
    }
    const original = localDataRef.current;
    if (!provider.loadTimelineCommandBasis || !original?.head) {
      emitTimelineSaveDiagnostic('basis-unavailable', () => ({ owner: localOwner, timelineId,
        mounted: original, basisStatus: 'unavailable' }));
      setOriginalLocalSaveBasis(null);
      return;
    }
    let cancelled = false;
    const editSeq = localEditSeqRef.current;
    if (editSeq !== savedSeqRef.current || original.editProjection?.kind === 'local') {
      emitTimelineSaveDiagnostic('basis-unavailable', () => ({ owner: localOwner, timelineId,
        mounted: original, basisStatus: 'unavailable' }));
      setOriginalLocalSaveBasis({ status: 'unavailable', reason: 'Original verified read must precede local edits' });
      return;
    }
    setOriginalLocalSaveBasis({ status: 'loading' });
    const readGeneration = localOwner.generation;
    const pending = pendingOriginalSaveReadRef.current;
    const samePendingRead = pending && !pending.settled
      && pending.provider === provider && pending.timelineId === timelineId
      && pending.headKey === originalHeadKey && pending.original === original
      && pending.editSeq === editSeq;
    let readOrdinal: number;
    let originalRead: Promise<TimelineOriginalSaveBasis>;
    if (samePendingRead) {
      readOrdinal = pending.readOrdinal;
      originalRead = pending.promise;
    } else {
      readOrdinal = ++basisReadOrdinal.current;
      emitTimelineSaveDiagnostic('basis-read', () => ({ owner: localOwner, timelineId,
        basisReadOrdinal: readOrdinal, mounted: original, basisStatus: 'loading', generation: readGeneration }));
      originalRead = withTimelineBasisDiagnostics(provider, observation => {
        emitTimelineSaveDiagnostic('basis-operation', () => ({ ...observation, owner: localOwner,
          generation: readGeneration, basisReadOrdinal: readOrdinal,
          current: !cancelled && !localOwner.closed && readGeneration === localOwner.generation }));
      }, () => readTimelineOriginalSaveBasis(provider, timelineId, {
        config: original.config, registry: original.registry, head: original.head,
        ...(original.sourceItemsBySchemaRef !== undefined ? { bundle: {
          schema_version: 1, itemsBySchemaRef: persistedTranscriptItems(original.sourceItemsBySchemaRef),
          ...(original.transcriptReferences ? { transcriptReferences: original.transcriptReferences } : {}),
        } } : {}),
      }));
      const record: PendingOriginalSaveRead = { provider, timelineId, headKey: originalHeadKey, original, editSeq,
        readOrdinal, promise: originalRead, settled: false };
      pendingOriginalSaveReadRef.current = record;
      void originalRead.then(() => {
        record.settled = true;
        if (pendingOriginalSaveReadRef.current === record) pendingOriginalSaveReadRef.current = null;
      }, () => {
        record.settled = true;
        if (pendingOriginalSaveReadRef.current === record) pendingOriginalSaveReadRef.current = null;
      });
    }
    void originalRead.then((value) => {
      if (cancelled) return;
      emitTimelineSaveDiagnostic(() => localEditSeqRef.current === editSeq ? 'basis-ready' : 'basis-unavailable', () => ({
        owner: localOwner, timelineId, mounted: localDataRef.current, basis: value,
        basisStatus: localEditSeqRef.current === editSeq ? 'ready' : 'unavailable', generation: readGeneration, basisReadOrdinal: readOrdinal }));
      setOriginalLocalSaveBasis(localEditSeqRef.current === editSeq
        ? { status: 'ready', value }
        : { status: 'unavailable', reason: 'Local edits preceded completion of the original verified read' });
    }).catch((error: unknown) => {
      emitTimelineSaveDiagnostic('basis-error', () => ({ error, owner: localOwner, timelineId,
        mounted: localDataRef.current, basisStatus: 'error', generation: readGeneration, basisReadOrdinal: readOrdinal, closed: localOwner.closed, current: !cancelled }));
      if (!cancelled) setOriginalLocalSaveBasis({ status: 'unavailable', reason: error instanceof Error ? error.message : String(error) });
    });
    if (usesLocalDocumentSave) {
      localOwner.started = true;
      localOwner.headKey = originalHeadKey;
      const generation = localOwner.generation;
      const isCurrent = () => !localOwner.closed && generation === localOwner.generation;
      localOwner.ready = (async () => {
        const verified = await originalRead;
        if (cancelled || !isCurrent() || localEditSeqRef.current !== editSeq) {
          throw markTimelineSaveRejection(new TimelineSaveError('Local edits preceded the original verified read; draft retained'), 'owner-original-read-invalidated', 'TimelineSaveError');
        }
        const identity = await provider.getRecoverableIdentity!();
        emitTimelineSaveDiagnostic('identity-read', () => ({ owner: localOwner, timelineId,
          identityPresent: identity != null, closed: localOwner.closed, current: isCurrent(), generation }));
        if (cancelled || !isCurrent()) throw markTimelineSaveRejection(new Error('Local save session replaced during identity read'), 'owner-identity-invalidated', 'Error');
        await previousDisposal;
        if (!isCurrent()) throw markTimelineSaveRejection(new Error('Local save session replaced during owner retirement'), 'owner-retirement-invalidated', 'Error');
        let adoptedSource = structuredClone(verified.source);
        sessionCreation = createLocalSaveSession({
          scope: { ...identity, projectId: verified.initial.canonicalDocument.project_id, timelineId },
          initial: verified.initial, document: toOutboxJson(verified.initial.canonicalDocument),
          send: (request, key) => provider.commitTimeline!(request, key),
          loadLatest: () => provider.loadTimelineCommandBasis!(timelineId),
          changed: (state) => {
            emitTimelineSaveDiagnostic('session-changed', () => ({ owner: localOwner, timelineId,
              state, current: isCurrent(), closed: localOwner.closed, generation,
              sessionPresent: Boolean(localOwner.session) }));
            if (isCurrent()) setLocalSaveState(state);
          },
          prepareDisplay: async (basis, draft) => {
            const document = (draft ?? basis.canonicalDocument) as unknown as typeof basis.canonicalDocument;
            const parent = document.parent_revision.payload;
            const { bundle, ...config } = parent.config as unknown as TimelineConfig & { bundle?: TimelineBundleEnvelope };
            const registry = parent.registry as unknown as AssetRegistry;
            if (bundle) parseTimelineBundle(bundle);
            const head: TimelineHeadRevision = { projectId: document.project_id, timelineId: document.timeline_id,
              headRevisionId: basis.head.revisionId, headPublicationId: basis.head.publicationId };
            // The numeric UI counter is local; it is never used as a physical pin.
            const next = await buildTimelineData({ ...config, ...withDefaultTimelineOutput(config) }, registry, resolveAssetUrl,
              configVersionRef.current, bundle?.itemsBySchemaRef, head, bundle?.transcriptReferences);
            const source: TimelineSaveSource = { config: next.config, registry: next.registry, head,
              ...(bundle === undefined ? {} : { bundle }) };
            return { document: toOutboxJson(document), adopt() {
              emitTimelineSaveDiagnostic('adoption-start', () => ({ owner: localOwner, timelineId,
                mounted: localDataRef.current, source, current: isCurrent(), generation,
                scopeMatched: head.timelineId === timelineId && head.projectId === verified.initial.canonicalDocument.project_id }));
              if (!isCurrent()) return;
              adoptedSource = source;
              localOwner.headKey = canonicalJsonStringify(head);
              headRevisionRef.current = head;
              adoptCanonicalData(next, { save: false, skipHistory: true, updateLastSavedSignature: true });
              emitTimelineSaveDiagnostic('adoption-complete', () => ({ owner: localOwner, timelineId,
                mounted: localDataRef.current, source, current: isCurrent(), generation }));
            } };
          },
        });
        const session = await sessionCreation;
        if (!isCurrent()) { await session.dispose(); throw markTimelineSaveRejection(new Error('Local save session replaced during outbox claim'), 'owner-claim-invalidated', 'Error'); }
        localOwner.session = session;
        emitTimelineSaveDiagnostic('session-created', () => ({ owner: localOwner, timelineId,
          sessionPresent: true, current: isCurrent(), generation, basis: verified, mounted: localDataRef.current }));
        const owners = session.getState().recoverableOwners;
        if (owners.length === 1) { localOwner.recovered = true; await session.recover(owners[0]);
          emitTimelineSaveDiagnostic('session-recovered', () => ({ owner: localOwner, timelineId,
            current: isCurrent(), generation, sessionPresent: true }));
        }
        else if (owners.length) throw markTimelineSaveRejection(new TimelineSaveError('Multiple local save owners require recovery; drafts retained'), 'owner-recovery-ambiguous', 'TimelineSaveError');
        let initial = verified.initial;
        if (owners.length && session.getState().status === 'saved') {
          initial = await session.flush();
          const latest = await provider.loadTimelineCommandBasis!(timelineId);
          if (canonicalJsonStringify(latest.head) === canonicalJsonStringify(initial.head)) {
            initial = { ...initial, history: latest.history };
          }
        }
        if (!isCurrent()) throw markTimelineSaveRejection(new Error('Local save session replaced during history read'), 'owner-history-invalidated', 'Error');
        const handoff = createTimelineLocalSaveHandoff({ initial, source: adoptedSource, session,
          loadHistory: () => provider.loadTimelineCommandBasis!(timelineId),
          adopted: () => {
            emitTimelineSaveDiagnostic('adopted-read', () => ({ owner: localOwner, timelineId,
              mounted: localDataRef.current, source: adoptedSource, basis: verified,
              current: isCurrent(), generation, sessionPresent: Boolean(localOwner.session) }));
            return { source: adoptedSource,
              receipt: { configVersion: configVersionRef.current, head: adoptedSource.head! } };
          } });
        localOwner.handoff = handoff;
        emitTimelineSaveDiagnostic('handoff-ready', () => ({ owner: localOwner, timelineId,
          basis: verified, basisStatus: 'ready', current: isCurrent(), generation, sessionPresent: Boolean(localOwner.session),
          mounted: localDataRef.current }));
        setLocalSaveState((current) => current ? { ...current } : current);
        return handoff;
      })();
      void localOwner.ready.catch((error: unknown) => {
        emitTimelineSaveDiagnostic('owner-error', () => ({ error, owner: localOwner, timelineId,
          closed: localOwner.closed, current: isCurrent(), generation, sessionPresent: Boolean(localOwner.session) }));
        if (isCurrent()) setLocalSaveState({ status: 'error', recoverableOwners: [],
          error: { message: error instanceof Error ? error.message : String(error) } });
      });
    }
    return () => { cancelled = true;
      if (!localOwner.session) {
        // A cancelled bootstrap has no live session to retain. Let the same
        // owner restart, and retire any claim already in flight before reuse.
        localOwner.generation++;
        localOwner.started = false;
        localOwner.ready = undefined;
        localOwner.retirement = sessionCreation?.then(session => session.dispose(), () => {}) ?? previousDisposal;
      }
      emitTimelineSaveDiagnostic('lifecycle-cancel', () => ({ owner: localOwner, timelineId,
        closed: localOwner.closed, generation: readGeneration, basisReadOrdinal: readOrdinal, sessionPresent: Boolean(localOwner.session) }));
    };
  }, [provider, timelineId, originalHeadKey, localDataRef, localEditSeqRef, adoptCanonicalData, localOwner, resolveAssetUrl, usesLocalDocumentSave]);
  const persistence = useTimelinePersistence({
    store,
    provider,
    timelineId,
    resolveAssetUrl,
    assetResolver,
    eventBus: eventBusRef.current,
    dataRef: commit.dataRef,
    commitData: commit.commitData,
    selectedClipIdRef: commit.selectedClipIdRef,
    selectedTrackIdRef: commit.selectedTrackIdRef,
    editSeqRef: commit.editSeqRef,
    savedSeqRef,
    configVersionRef,
    headRevisionRef,
    recoveryPendingRef,
    recoveryActiveRef,
    lastSavedSignatureRef,
    interactionStateRef,
    onCanonicalReloadStart: invalidateRecoveryAction,
    localDocumentSave,
    diagnosticOwner: localOwner,
  });
  const { clearDeferredRecoverySave, resumeDeferredRecoverySave } = persistence;
  const resumeDeferredRecoverySaveRef = useRef(resumeDeferredRecoverySave);
  resumeDeferredRecoverySaveRef.current = resumeDeferredRecoverySave;

  useEffect(() => {
    return eventBusRef.current.on('scheduleSave', persistence.scheduleSave);
  }, [persistence.scheduleSave]);

  usePollSync({
    store,
    queries,
    provider,
    resolveAssetUrl,
    commitData: commit.commitData,
    dataRef: commit.dataRef,
    selectedClipIdRef: commit.selectedClipIdRef,
    selectedTrackIdRef: commit.selectedTrackIdRef,
    editSeqRef: commit.editSeqRef,
    pendingOpsRef: commit.pendingOpsRef,
    savedSeqRef,
    configVersionRef,
    headRevisionRef,
    recoveryActiveRef,
    canonicalReloadInProgressRef: persistence.canonicalReloadInProgressRef,
    lastSavedSignatureRef,
    isSavingRef: persistence.isSavingRef,
    isConflictExhaustedRef: persistence.isConflictExhaustedRef,
    interactionStateRef,
    canonicalShotDraftActive: Boolean(shots.canonicalDraft),
  });

  // One-slot recovery draft (plan-v5 B9): after the timeline data loads, offer
  // any draft left by a crash / offline edit / save-as-copy. Offered once per
  // mount; the shell renders Retry / Discard.
  const [recoveryDraft, setRecoveryDraft] = useState<{
    updatedAt: string;
    baseVersion: number;
    retryAllowed: boolean;
  } | null>(null);
  const [recoveredAsDirty, setRecoveredAsDirty] = useState(false);
  const recoveryCheckedScopeRef = useRef<string | null>(null);
  const recoveryKey = provider.getTimelineDraftRecoveryMetadata?.().recoveryKey ?? timelineId;
  const recoveryScope = `${timelineId}\u0000${recoveryKey}`;
  const fallbackCanonicalReloadInProgressRef = useRef(false);
  const canonicalReloadInProgressRef = persistence.canonicalReloadInProgressRef
    ?? fallbackCanonicalReloadInProgressRef;

  const hasTimelineData = commit.data !== null;
  useEffect(() => {
    if (!localOwner.recovered || localSaveState?.status !== 'saved') return;
    // The outbox has replayed the durable request; the older recovery slot
    // cannot become a second submission of the same gesture.
    invalidateRecoveryAction();
    setRecoveryDraft(null);
    setRecoveredAsDirty(false);
    recoveryPendingRef.current = false;
    recoveryActiveRef.current = false;
    resumeDeferredRecoverySave();
  }, [invalidateRecoveryAction, localOwner, localSaveState?.status, resumeDeferredRecoverySave]);
  const trustedRecoveryHead = useCallback((record: TimelineDraftRecord): TimelineHeadRevision | undefined => {
    const scope = headRevisionRef.current ?? commit.dataRef.current?.head;
    if (!scope || record.timelineId !== timelineId
      || record.baseHeadProjectId !== scope.projectId
      || record.baseHeadTimelineId !== scope.timelineId
      || !(record.baseHeadRevisionId === null || (typeof record.baseHeadRevisionId === 'string' && record.baseHeadRevisionId.length > 0))) return undefined;
    return { projectId: scope.projectId, timelineId: scope.timelineId, headRevisionId: record.baseHeadRevisionId };
  }, [commit.dataRef, timelineId]);
  const offerRecovery = useCallback((record: TimelineDraftRecord) => {
    recoveryPendingRef.current = true;
    recoveryActiveRef.current = true;
    setRecoveryDraft({ updatedAt: record.updatedAt, baseVersion: record.baseVersion,
      retryAllowed: !provider.saveTimelineAtHead || Boolean(trustedRecoveryHead(record)) });
  }, [provider, trustedRecoveryHead]);
  useEffect(() => {
    // No durable persistence (a read-only example, the editor tour) means no draft was ever written to offer.
    if (!isDataProviderPersistenceEnabled(provider)) return;
    if (!hasTimelineData || recoveryCheckedScopeRef.current === recoveryScope) {
      return;
    }
    recoveryCheckedScopeRef.current = recoveryScope;
    const loadedData = commit.dataRef.current;
    if (!loadedData) return;
    const checkStartedAt = Date.now();
    const editSeqAtCheck = commit.editSeqRef.current;
    const actionGenerationAtCheck = recoveryActionGenerationRef.current;
    let cancelled = false;
    let completed = false;
    // Best-effort: IndexedDB unavailable (private mode) or a corrupt store
    // simply means no recovery offer; never an unhandled rejection.
    void loadTimelineDraft(recoveryKey)
      .then((record) => {
        if (cancelled || !record
          || recoveryCheckedScopeRef.current !== recoveryScope
          || recoveryActionGenerationRef.current !== actionGenerationAtCheck) {
          return;
        }
        // Do not call a draft written after this editor session began a
        // recovery check "recovered". A normal edit can create that durable
        // draft before this IndexedDB read finishes.
        const updatedAt = Date.parse(record.updatedAt);
        if (commit.editSeqRef.current !== editSeqAtCheck
          && Number.isFinite(updatedAt)
          && updatedAt >= checkStartedAt) return;
        const draft = record.draft as { config?: TimelineConfig; registry?: AssetRegistry; bundle?: TimelineBundleEnvelope | null };
        // Content equality cannot lend provenance to a legacy Runtime draft.
        if (provider.saveTimelineAtHead && !trustedRecoveryHead(record)) {
          offerRecovery(record);
          return;
        }
        // A save ACK clears the slot asynchronously. Another tab can load the
        // record in that window (or a late draft write can race the clear), so
        // the mere presence of a slot is not proof of unsaved work. If the
        // draft is already the server snapshot, discard it silently instead
        // of showing a false recovery banner.
        const loadedBundle = loadedData.sourceItemsBySchemaRef
          ? {
              schema_version: 1,
              itemsBySchemaRef: persistedTranscriptItems(loadedData.sourceItemsBySchemaRef),
              ...(loadedData.transcriptReferences ? {transcriptReferences:loadedData.transcriptReferences}:{}),
            }
          : null;
        const draftBundle = draft.bundle ?? null;
        if (
          draft.config
          && getStableConfigSignature(draft.config, draft.registry ?? { assets: {} })
            === getStableConfigSignature(loadedData.config, loadedData.registry)
          && canonicalJsonStringify(draftBundle) === canonicalJsonStringify(loadedBundle)
        ) {
          if (recoveryKey === timelineId) {
            void clearTimelineDraft(recoveryKey).catch(() => {});
            return;
          }
          // Some providers hydrate this stable occurrence slot directly into
          // the visible editor. It is still an unacknowledged draft and must
          // remain retryable even though its signature matches the loaded data.
          setRecoveredAsDirty(true);
          offerRecovery(record);
          return;
        }
        setRecoveredAsDirty(recoveryKey !== timelineId);
        offerRecovery(record);
      })
      .catch(() => {
        // no recovery offer
      }).finally(() => {
        completed = true;
        if (!cancelled && recoveryActionGenerationRef.current === actionGenerationAtCheck) {
          recoveryActiveRef.current = recoveryPendingRef.current;
          if (!recoveryActiveRef.current) resumeDeferredRecoverySaveRef.current();
        }
      });
    return () => {
      cancelled = true;
      // StrictMode can retire the first check before it resolves. Its
      // replacement must perform the read that releases the recovery gate.
      if (!completed && recoveryCheckedScopeRef.current === recoveryScope) recoveryCheckedScopeRef.current = null;
    };
  }, [commit.dataRef, commit.editSeqRef, hasTimelineData, recoveryKey, recoveryScope, timelineId, offerRecovery, provider, trustedRecoveryHead]);
  useEffect(() => {
    return eventBusRef.current.on('saveSuccess', () => {
      invalidateRecoveryAction();
      // Retry stays visible until the durable acknowledgement, not merely
      // until the save request is queued.
      setRecoveryDraft(null);
      setRecoveredAsDirty(false);
      recoveryPendingRef.current = false;
      recoveryActiveRef.current = false;
      resumeDeferredRecoverySave();
    });
  }, [invalidateRecoveryAction, resumeDeferredRecoverySave]);

  const retryRecoveredDraft = useCallback(async () => {
    // A Retry started during Reload would get a newer generation than the
    // reload's invalidation and could commit after canonical adoption.
    if (canonicalReloadInProgressRef.current || persistence.isConflictExhaustedRef?.current) return;
    const actionGeneration = ++recoveryActionGenerationRef.current;
    const isCurrentAction = () => recoveryActionGenerationRef.current === actionGeneration;
    let record: Awaited<ReturnType<typeof loadTimelineDraft>>;
    try {
      record = await loadTimelineDraft(recoveryKey);
    } catch {
      // A temporary read failure is not a discard. Keep the recovery controls
      // and write freeze so the original slot remains safe and resolvable.
      return;
    }
    if (!isCurrentAction()) return;
    if (!record) {
      setRecoveryDraft(null);
      setRecoveredAsDirty(false);
      recoveryPendingRef.current = false;
      recoveryActiveRef.current = false;
      persistence.resumeDeferredRecoverySave();
      return;
    }
    const recoveredHead = trustedRecoveryHead(record);
    if (provider.saveTimelineAtHead && !recoveredHead) {
      offerRecovery(record);
      return;
    }
    const draft = record.draft as { config?: TimelineConfig; registry?: AssetRegistry; bundle?: TimelineBundleEnvelope | null };
    if (!draft.config || !commit.data) {
      return;
    }
    if (draft.bundle) parseTimelineBundle(draft.bundle);
    const recovered = await buildTimelineData(
      draft.config,
      draft.registry ?? { assets: {} },
      resolveAssetUrl ?? ((file) => provider.resolveAssetUrl(file)),
      record.baseVersion,
      draft.bundle?.itemsBySchemaRef,
      recoveredHead,
      draft.bundle?.transcriptReferences,
    );
    // Reload/Discard can finish while this async recovery build is running.
    // Never let that stale candidate reach commitData afterward.
    if (!isCurrentAction() || persistence.isConflictExhaustedRef?.current) return;
    // Recovery Retry is a user-triggered whole-timeline replacement; recheck
    // after the async build so a canonical-head transition cannot publish H0.
    if (timelineEditability?.checkTimeline && !timelineEditability.checkTimeline().allowed) return;
    // Retry against the version captured with the draft. Using a newer
    // polled version here would turn a stale recovery into an unconditional
    // overwrite instead of an honest CAS conflict.
    configVersionRef.current = record.baseVersion;
    headRevisionRef.current = recoveredHead;
    if (draft.bundle !== undefined) persistence.loadedBundleRef.current = draft.bundle;
    // The recovered record is the previous session's payload. A new-session
    // edit made while recovery was pending is held separately by persistence
    // and will resume after this recovery save is acknowledged.
    recoveryPendingRef.current = false;
    recoveryActiveRef.current = false;
    // Keep the slot and visible recovery controls until a durable ACK. A 409
    // or transport failure must leave the recovered work retryable.
    setRecoveredAsDirty(true);
    commit.commitData(recovered, { save: true });
  }, [canonicalReloadInProgressRef, commit, configVersionRef, persistence, provider, recoveryKey, resolveAssetUrl, timelineEditability, trustedRecoveryHead, offerRecovery, recoveryActiveRef]);

  const reloadCanonicalFromServer = persistence.reloadFromServer;
  const reloadFromServer = useCallback(async (options?: { clearDraft?: boolean; preserveDraft?: boolean }) => {
    await reloadCanonicalFromServer(options);
    const shouldClearRecovery = options?.clearDraft ?? !options?.preserveDraft;
    if (shouldClearRecovery) {
      setRecoveryDraft(null);
      setRecoveredAsDirty(false);
      recoveryPendingRef.current = false;
      recoveryActiveRef.current = false;
      clearDeferredRecoverySave();
      resumeDeferredRecoverySave();
    }
  }, [clearDeferredRecoverySave, reloadCanonicalFromServer, resumeDeferredRecoverySave]);
  const discardRecoveredDraft = useCallback(async () => {
    try {
      // Reload first. The persistence path clears the slot only after it has
      // built and committed fresh canonical data, so discarded content cannot
      // remain visible while the editor reports saved.
      await reloadFromServer({ clearDraft: true });
    } catch {
      return;
    }
    setRecoveryDraft(null);
    setRecoveredAsDirty(false);
  }, [reloadFromServer]);

  const registrationTargetsRef = useRef(new WeakMap<OwnedRegistryMutation, { session: object; generation: number }>());
  // commit and persistence are fresh object literals on every render; their
  // members are useCallback-stable. Depend on those members, not the objects.
  const {
    captureSaveTarget,
    flushSaveTarget,
    discardUncommittedSaveTarget,
  } = persistence;
  const {
    patchRegistryOwned,
    ownsRegistryMutation,
    canRollbackRegistryMutation,
    rollbackRegistryMutation,
  } = commit;
  const registrationOwner = useMemo<RegistrationSaveOwner>(() => ({
    captureSaveTarget,
    patchRegistryOwned: (assetId, entry, src) => {
      const target = captureSaveTarget();
      const receipt = patchRegistryOwned(assetId, entry, src);
      registrationTargetsRef.current.set(receipt, { session: target.session, generation: target.generation });
      return receipt;
    },
    ownsRegistryMutation: (receipt) => {
      const binding = registrationTargetsRef.current.get(receipt);
      try {
        const current = captureSaveTarget();
        return binding?.session === current.session && binding.generation === current.generation
          && ownsRegistryMutation(receipt);
      } catch { return false; }
    },
    flushSaveTarget,
    rollbackRegistration: (receipt, target, error) => {
      const binding = registrationTargetsRef.current.get(receipt);
      if (target.targetSeq !== receipt.editSeq || binding?.session !== target.session
        || binding.generation !== target.generation) return false;
      if (!canRollbackRegistryMutation(receipt)) return false;
      if (!discardUncommittedSaveTarget(target, error)) return false;
      return rollbackRegistryMutation(receipt);
    },
  }), [captureSaveTarget, flushSaveTarget, discardUncommittedSaveTarget, patchRegistryOwned,
    ownsRegistryMutation, canRollbackRegistryMutation, rollbackRegistryMutation]);

  const { dataRef: elementDataRef, commitData: commitElementData } = commit;
  const { canonicalReloadInProgressRef: elementReloadRef, isConflictExhaustedRef: elementConflictRef,
    flushPendingSave: flushElementSave } = persistence;
  const elementTimelineRoutes = useMemo<ElementTimelineRoutes>(() => {
    const currentDocument = (): ElementTimelineDocument => {
      const current = elementDataRef.current;
      if (!current) throw new TimelineSaveError('Timeline is not loaded');
      return structuredClone({ config: current.config, registry: current.registry,
        config_version: configVersionRef.current, head: current.head,
        ...(current.sourceItemsBySchemaRef === undefined ? {} : { bundle: { schema_version: 1,
          itemsBySchemaRef: persistedTranscriptItems(current.sourceItemsBySchemaRef),
          ...(current.transcriptReferences ? { transcriptReferences: current.transcriptReferences } : {}) } }) });
    };
    return {
      getGeneration: () => canonicalJsonStringify(currentDocument()),
      async get(id) {
        if (id !== timelineId) throw new TimelineSaveError('Element timeline scope changed');
        return currentDocument();
      },
      async save(id, input) {
        const original = structuredClone(input.original);
        const checkCurrent = () => {
          input.assertAuthority?.();
          const permission = timelineEditability?.checkTimeline?.();
          if (id !== timelineId || permission?.allowed === false || elementReloadRef.current
            || elementConflictRef.current || !original
            || canonicalJsonStringify(currentDocument()) !== canonicalJsonStringify(original)
            || input.expectedVersion !== original.config_version
            || canonicalJsonStringify(input.expectedHead ?? null) !== canonicalJsonStringify(original.head ?? null)) {
            throw new TimelineSaveError('Element original local document changed; draft retained');
          }
        };
        checkCurrent();
        if (!input.operation || !input.context) throw new TimelineSaveError('Element causal input is unavailable');
        const config = input.config as TimelineConfig;
        const registry = input.registry as AssetRegistry;
        if (localDocumentSave) {
          const handoff = await localOwner.ready;
          if (!handoff || localOwner.closed) throw new TimelineSaveError('Element local save owner was replaced');
          checkCurrent();
          await handoff.capture({ config, registry, head: input.expectedHead, bundle: input.bundle }, {
            kind: 'element', config: original!.config as TimelineConfig, registry: original!.registry as AssetRegistry,
            clipId: 'clip_id' in input.operation ? input.operation.clip_id ?? '' : '', operation: input.operation, context: input.context,
          });
          checkCurrent();
          // The element operation is intentionally not projected into the live
          // editor before Runtime acceptance. The local save session retains
          // the exact draft and its outbox identity while the editor remains
          // on the durable document; its acceptance adoption below is the
          // single point at which the element becomes applied.
          await handoff.flush();
        } else {
          const next = await buildTimelineData(config, registry, resolveAssetUrl, input.expectedVersion,
            input.bundle?.itemsBySchemaRef, input.expectedHead, input.bundle?.transcriptReferences);
          checkCurrent();
          commitElementData(next, { save: true });
          await flushElementSave();
        }
        return currentDocument();
      },
    };
  }, [elementDataRef, commitElementData, timelineId, timelineEditability, localDocumentSave,
    localOwner, elementReloadRef,
    elementConflictRef, flushElementSave, resolveAssetUrl]);

  const commitApplyEdit = commit.applyEdit;
  const applyEdit = useCallback<ReturnType<typeof useTimelineCommit>['applyEdit']>((mutation, options) => {
    if (options?.gestureBasis?.kind !== 'element') { commitApplyEdit(mutation, options); return; }
    const current = elementDataRef.current;
    if (!current) { toast.error('Element parameter source is unavailable; draft retained'); return; }
    const owner = elementParameterOwners.get(elementTimelineRoutes);
    if (!owner || owner.context !== options.gestureBasis.context) {
      toast.error('Element parameter editor owner changed or is unavailable; draft retained'); return;
    }
    void saveElementParameterEdit(current, mutation, options.gestureBasis, elementTimelineRoutes, timelineId, owner.adapter.captureForTurn())
      .catch(error => toast.error(error instanceof Error ? error.message : String(error)));
  }, [commitApplyEdit, elementDataRef, elementTimelineRoutes, timelineId, toast]);

  return {
    elementTimelineRoutes,
    localDocumentSave,
    localSaveState,
    originalLocalSaveBasis,
    data: commit.data,
    dataRef: commit.dataRef,
    isConflictExhausted: persistence.isConflictExhausted,
    selectedClipId: commit.selectedClipId,
    selectedTrackId: commit.selectedTrackId,
    saveStatus: localSaveState && ['blocked', 'conflict', 'error', 'recovery', 'retry'].includes(localSaveState.status)
      ? 'error' : localSaveState?.status === 'saving' ? 'saving' : localSaveState?.status === 'dirty' ? 'dirty' : recoveredAsDirty && persistence.saveStatus === 'saved' ? 'dirty' : persistence.saveStatus,
    schemaIncompatible: persistence.schemaIncompatible,
    flushPendingSave: persistence.flushPendingSave,
    preserveTimelineDraftForReload: persistence.preserveTimelineDraftForReload,
    isTimelineDraftDurableForReload: persistence.isTimelineDraftDurableForReload,
    registrationOwner,
    setSelectedTrackId: commit.setSelectedTrackId,
    applyEdit,
    patchRegistry: commit.patchRegistry,
    unpatchRegistry: commit.unpatchRegistry,
    commitData: commit.commitData,
    eventBus: eventBusRef.current,
    reloadFromServer,
    retrySaveAfterConflict: persistence.retrySaveAfterConflict,
    editSeqRef: commit.editSeqRef,
    pendingOpsRef: commit.pendingOpsRef,
    savedSeqRef,
    selectedClipIdRef: commit.selectedClipIdRef,
    selectedTrackIdRef: commit.selectedTrackIdRef,
    isLoading: queries.timelineQuery.isLoading && !commit.data,
    watchdogTripped: persistence.watchdogTripped,
    watchdogReason: persistence.watchdogReason,
    retryWatchdog: persistence.retryWatchdog,
    retryPendingSave: persistence.retryPendingSave,
    // The conflict dialog owns resolution after a rejected Retry. Retain the
    // durable slot and recovery state, but never expose both surfaces at once.
    recoveryDraft: persistence.isConflictExhausted ? null : recoveryDraft,
    retryRecoveredDraft,
    discardRecoveredDraft,
  };
}

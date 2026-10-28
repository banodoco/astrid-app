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
import { useTimelineCommit, type OwnedRegistryMutation } from '@/tools/video-editor/hooks/useTimelineCommit.ts';
import { TimelineEventBus } from '@/tools/video-editor/hooks/useTimelineEventBus.ts';
import { useTimelinePersistence } from '@/tools/video-editor/hooks/useTimelinePersistence.ts';
import { clearTimelineDraft, loadTimelineDraft } from '@/tools/video-editor/data/timelineDraftIndexedDb.ts';
import { buildTimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import { getStableConfigSignature } from '@/tools/video-editor/lib/config-utils.ts';
import type { AssetRegistry, TimelineConfig } from '@/tools/video-editor/types/index.ts';
import { usePollSync, type UsePollSyncQueries } from '@/tools/video-editor/hooks/usePollSync.ts';
import type { TimelineStoreApi } from '@/tools/video-editor/hooks/timelineStore.ts';
import { useVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import { isDataProviderPersistenceEnabled, type DataProvider, type TimelineHeadRevision } from '@/tools/video-editor/data/DataProvider.ts';
import type { TimelineDraftRecord } from '@/tools/video-editor/data/timelineDraftIndexedDb.ts';
import { canonicalJsonStringify, parseTimelineBundle, type TimelineBundleEnvelope } from '@/tools/video-editor/data/typed/timelineBundle.ts';
import type { TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
export { shouldAcceptPolledData } from '@/tools/video-editor/lib/timeline-save-utils.ts';
export type { SaveStatus } from '@/tools/video-editor/hooks/useTimelinePersistence.ts';

type UseTimelineSaveQueries = UsePollSyncQueries;

export type { InteractionStateRef } from '@/tools/video-editor/lib/interaction-state.ts';

export function useTimelineSave(
  queries: UseTimelineSaveQueries,
  provider: DataProvider,
  interactionStateRef: InteractionStateRef,
  store: TimelineStoreApi,
  initialData?: TimelineData,
) {
  const { timelineId, assetResolver, timelineEditability, shots } = useVideoEditorRuntime();
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
        if (!cancelled && recoveryActionGenerationRef.current === actionGenerationAtCheck) {
          recoveryActiveRef.current = recoveryPendingRef.current;
          if (!recoveryActiveRef.current) resumeDeferredRecoverySaveRef.current();
        }
      });
    return () => {
      cancelled = true;
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

  return {
    data: commit.data,
    dataRef: commit.dataRef,
    isConflictExhausted: persistence.isConflictExhausted,
    selectedClipId: commit.selectedClipId,
    selectedTrackId: commit.selectedTrackId,
    saveStatus: recoveredAsDirty && persistence.saveStatus === 'saved' ? 'dirty' : persistence.saveStatus,
    schemaIncompatible: persistence.schemaIncompatible,
    flushPendingSave: persistence.flushPendingSave,
    preserveTimelineDraftForReload: persistence.preserveTimelineDraftForReload,
    isTimelineDraftDurableForReload: persistence.isTimelineDraftDurableForReload,
    registrationOwner,
    setSelectedTrackId: commit.setSelectedTrackId,
    applyEdit: commit.applyEdit,
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

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { isInteractionActive, onInteractionEnd, type InteractionStateRef } from '@/tools/video-editor/lib/interaction-state.ts';
import { shouldAcceptPolledData } from '@/tools/video-editor/lib/timeline-save-utils.ts';
import { buildTimelineData, preserveUploadingClips, type TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import { withDefaultTimelineOutput } from '@/tools/video-editor/lib/defaults.ts';
import { canonicalJsonStringify } from '@/tools/video-editor/data/typed/timelineBundle.ts';
import type { DataProvider, TimelineHeadRevision } from '@/tools/video-editor/data/DataProvider.ts';
import type { CommitDataOptions } from '@/tools/video-editor/hooks/useTimelineCommit.ts';
import type { TimelineStoreApi } from '@/tools/video-editor/hooks/timelineStore.ts';
import { isTimelineDiagnosticsEnabled } from '@/tools/video-editor/lib/timeline-diagnostics.ts';

const TIMELINE_SYNC_LOG_TAG = '[TimelineSync]';

type PollCheckPhase = 'preflight' | 'timeout';
type ConfigVersionUpdateSource = 'poll';

export interface UsePollSyncQueries {
  timelineQuery: {
    data: TimelineData | undefined;
    isLoading: boolean;
  };
  assetRegistryQuery: {
    data: Awaited<ReturnType<DataProvider['loadAssetRegistry']>> | undefined;
  };
}

interface TimelinePollGate {
  editSeq: number;
  savedSeq: number;
  pendingOps: number;
  isSaving: boolean;
  interactionActive?: boolean;
  canonicalShotDraftActive?: boolean;
}

export interface PollRejectionInput extends TimelinePollGate {
  polledConfigVersion: number;
  currentConfigVersion: number;
  polledStableSignature: string;
  lastSavedStableSignature: string;
}

interface UsePollSyncOptions {
  store?: TimelineStoreApi;
  queries: UsePollSyncQueries;
  provider: DataProvider;
  resolveAssetUrl?: (file: string) => Promise<string>;
  commitData: (nextData: TimelineData, options?: CommitDataOptions) => void;
  dataRef: MutableRefObject<TimelineData | null>;
  selectedClipIdRef: MutableRefObject<string | null>;
  selectedTrackIdRef: MutableRefObject<string | null>;
  editSeqRef: MutableRefObject<number>;
  pendingOpsRef: MutableRefObject<number>;
  savedSeqRef: MutableRefObject<number>;
  configVersionRef: MutableRefObject<number>;
  headRevisionRef?: MutableRefObject<TimelineHeadRevision | undefined>;
  recoveryActiveRef?: MutableRefObject<boolean>;
  canonicalReloadInProgressRef?: MutableRefObject<boolean>;
  lastSavedSignatureRef: MutableRefObject<string>;
  isSavingRef: MutableRefObject<boolean>;
  interactionStateRef: InteractionStateRef;
  /** A nested canonical shot draft owns the parent composition while dirty. */
  canonicalShotDraftActive?: boolean;
  /** When true (a 409 put the editor into diverged), remote data is NOT adopted. */
  isConflictExhaustedRef?: MutableRefObject<boolean>;
}

export function isTimelinePollIdle({ editSeq, savedSeq, pendingOps, isSaving, interactionActive, canonicalShotDraftActive }: TimelinePollGate): boolean {
  if (interactionActive) {
    return false;
  }
  if (canonicalShotDraftActive) {
    return false;
  }
  return savedSeq >= editSeq && !isSaving && pendingOps === 0;
}

export function getTimelinePollRejectionReason({
  editSeq,
  savedSeq,
  pendingOps,
  isSaving,
  interactionActive,
  canonicalShotDraftActive,
  polledConfigVersion,
  currentConfigVersion,
  polledStableSignature,
  lastSavedStableSignature,
}: PollRejectionInput): string | null {
  if (!isTimelinePollIdle({ editSeq, savedSeq, pendingOps, isSaving, interactionActive, canonicalShotDraftActive })) {
    if (interactionActive) {
      return 'interaction active';
    }

    if (canonicalShotDraftActive) {
      return 'canonical shot draft active';
    }

    if (savedSeq < editSeq) {
      return 'unsaved edits';
    }

    if (pendingOps > 0) {
      return 'pending ops';
    }

    if (isSaving) {
      return 'saving';
    }

    return 'busy';
  }

  if (polledConfigVersion < currentConfigVersion) {
    return 'stale version';
  }

  if (
    !shouldAcceptPolledData(
      editSeq,
      savedSeq,
      pendingOps,
      polledStableSignature,
      lastSavedStableSignature,
    )
  ) {
    return polledConfigVersion === currentConfigVersion ? 'own echo' : 'signature match';
  }

  return null;
}

function pollSignatureWithDefaultOutput(data: TimelineData): string {
  const { config, registry, sourceItemsBySchemaRef, transcriptReferences } = data;
  const { output } = withDefaultTimelineOutput(config);
  return canonicalJsonStringify({
    config: { ...config, output: { ...config.output, ...output } },
    registry,
    sourceItemsBySchemaRef,
    transcriptReferences,
  });
}

export function usePollSync({
  store,
  queries,
  provider,
  resolveAssetUrl,
  commitData,
  dataRef,
  selectedClipIdRef,
  selectedTrackIdRef,
  editSeqRef,
  pendingOpsRef,
  savedSeqRef,
  configVersionRef,
  headRevisionRef,
  recoveryActiveRef,
  canonicalReloadInProgressRef,
  lastSavedSignatureRef,
  isSavingRef,
  interactionStateRef,
  isConflictExhaustedRef,
  canonicalShotDraftActive = false,
}: UsePollSyncOptions): void {
  const lastRegistryDataRef = useRef<Awaited<ReturnType<DataProvider['loadAssetRegistry']>> | null>(null);
  const commitDataRef = useRef(commitData);
  const canonicalShotDraftActiveRef = useRef(canonicalShotDraftActive);
  canonicalShotDraftActiveRef.current = canonicalShotDraftActive;
  // The first provider snapshot hydrates this editor session. Some providers
  // include a durable recovery draft in that payload, so the initial recovery
  // check must not prevent that snapshot from becoming the visible base.
  const initialProviderSnapshotHandledRef = useRef(false);
  const latestObservedRemoteConfigVersionRef = useRef<number | null>(null);
  // Newest polled timeline data observed while a drag/resize was in flight.
  // Replayed via the normal commit path on gesture end.
  const deferredPolledDataRef = useRef<TimelineData | null>(null);
  // Bumped on gesture end to re-trigger the poll-acceptance effect against
  // whatever the latest polled payload is.
  const [interactionEndTick, setInteractionEndTick] = useState(0);
  const getDataRef = useCallback(() => {
    const storeDataRef = store?.getState().data.dataRef;
    return storeDataRef && storeDataRef.current !== null ? storeDataRef : dataRef;
  }, [dataRef, store]);
  const getPendingOpsRef = useCallback(() => {
    const storePendingOpsRef = store?.getState().data.pendingOpsRef;
    return storePendingOpsRef ? storePendingOpsRef : pendingOpsRef;
  }, [pendingOpsRef, store]);
  const getInteractionStateRef = useCallback(() => {
    const storeInteractionStateRef = store?.getState().data.interactionStateRef;
    return storeInteractionStateRef ? storeInteractionStateRef : interactionStateRef;
  }, [interactionStateRef, store]);

  useLayoutEffect(() => {
    commitDataRef.current = commitData;
  }, [commitData]);

  useEffect(() => {
    const polledVersion = queries.timelineQuery.data?.configVersion;
    if (queries.timelineQuery.data && typeof polledVersion === 'number') {
      latestObservedRemoteConfigVersionRef.current = polledVersion;
    }
  }, [queries.timelineQuery.data]);

  const logTimelineSync = useCallback((message: string, details?: Record<string, unknown>) => {
    if (!isTimelineDiagnosticsEnabled()) {
      return;
    }

    console.log(TIMELINE_SYNC_LOG_TAG, message, details);
  }, []);

  const logConfigVersionUpdate = useCallback((source: ConfigVersionUpdateSource, nextVersion: number) => {
    if (!isTimelineDiagnosticsEnabled()) {
      return;
    }

    if (configVersionRef.current === nextVersion) {
      return;
    }

    console.log(TIMELINE_SYNC_LOG_TAG, 'configVersionRef updated', {
      source,
      from: configVersionRef.current,
      to: nextVersion,
    });
  }, [configVersionRef]);

  const getPollRejectionReason = useCallback((polledData: TimelineData, allowInitialSnapshot = false): string | null => {
    if (isConflictExhaustedRef?.current) return 'diverged';
    if (canonicalReloadInProgressRef?.current) return 'reloading';
    if (
      getDataRef().current
      && recoveryActiveRef?.current
      && initialProviderSnapshotHandledRef.current
      && !allowInitialSnapshot
    ) return 'recovery active';
    const gate = {
      editSeq: editSeqRef.current,
      savedSeq: savedSeqRef.current,
      pendingOps: getPendingOpsRef().current,
      isSaving: isSavingRef.current,
      interactionActive: isInteractionActive(getInteractionStateRef()),
      canonicalShotDraftActive: canonicalShotDraftActiveRef.current,
    };
    if (provider.saveTimelineAtHead && isTimelinePollIdle(gate)) {
      if (!polledData.head) return 'unknown head';
      const currentHead = headRevisionRef?.current;
      if (currentHead && (currentHead.projectId !== polledData.head.projectId || currentHead.timelineId !== polledData.head.timelineId)) return 'different scope';
      const mountedData = getDataRef().current;
      const mountedHead = mountedData?.head;
      if (
        mountedData
        && mountedHead?.headRevisionId
        && mountedHead.headPublicationId
        && mountedHead.projectId === polledData.head.projectId
        && mountedHead.timelineId === polledData.head.timelineId
        && mountedHead.headRevisionId === polledData.head.headRevisionId
        && mountedHead.headPublicationId === polledData.head.headPublicationId
        && pollSignatureWithDefaultOutput(mountedData) === pollSignatureWithDefaultOutput(polledData)
      ) {
        // Ignore display-only output defaults so the save handoff keeps its
        // accepted source. Still adopt a poll that supplies richer timeline data.
        return 'own echo';
      }
      // A same-payload remote publication still changes the CAS base. Local
      // counters have no ordering meaning across provider instances.
      if (!currentHead || currentHead.headRevisionId !== polledData.head.headRevisionId) {
        // The numeric version is not the CAS authority, but it is still a
        // useful freshness fence within this live editor. A delayed response
        // from the old head must not roll back a newer acknowledged head.
        if (currentHead && polledData.configVersion <= configVersionRef.current) return 'stale head';
        return null;
      }
    }
    return getTimelinePollRejectionReason({
      ...gate,
      polledConfigVersion: polledData.configVersion,
      currentConfigVersion: configVersionRef.current,
      polledStableSignature: polledData.stableSignature,
      lastSavedStableSignature: lastSavedSignatureRef.current,
    });
  }, [
    configVersionRef,
    editSeqRef,
    isSavingRef,
    lastSavedSignatureRef,
    getInteractionStateRef,
    getPendingOpsRef,
    savedSeqRef,
    canonicalReloadInProgressRef,
    getDataRef,
    headRevisionRef,
    isConflictExhaustedRef,
    provider,
    recoveryActiveRef,
  ]);

  const logPollRejection = useCallback((phase: PollCheckPhase, polledData: TimelineData, reason: string) => {
    logTimelineSync(`poll rejected (${phase}: ${reason})`, {
      polledConfigVersion: polledData.configVersion,
      currentConfigVersion: configVersionRef.current,
      latestObservedRemoteConfigVersion: latestObservedRemoteConfigVersionRef.current,
      editSeq: editSeqRef.current,
      savedSeq: savedSeqRef.current,
      pendingOps: getPendingOpsRef().current,
      isSaving: isSavingRef.current,
      canonicalShotDraftActive,
    });
  }, [
    configVersionRef,
    editSeqRef,
    getPendingOpsRef,
    isSavingRef,
    logTimelineSync,
    savedSeqRef,
    canonicalShotDraftActive,
  ]);

  // Wake the poll-acceptance effect once a gesture ends so the most recently
  // deferred polled payload (if any) is re-evaluated against the freshly idle gate.
  useEffect(() => {
    return onInteractionEnd(getInteractionStateRef(), () => {
      setInteractionEndTick((tick) => tick + 1);
    });
  }, [getInteractionStateRef]);

  useEffect(() => {
    const polledData = queries.timelineQuery.data ?? deferredPolledDataRef.current;
    if (!polledData) {
      return;
    }
    // Alias for closures: TS does not preserve the `!polledData` narrowing
    // through the nested setTimeout callback below.
    const resolvedPolledData: TimelineData = polledData;

    // Diverged (409): freeze remote adoption — adopting the server state would
    // silently discard the local edits the user was told about.
    if (isConflictExhaustedRef?.current) {
      logPollRejection('preflight', resolvedPolledData, 'diverged');
      return;
    }

    const preflightRejectionReason = getPollRejectionReason(resolvedPolledData);
    if (preflightRejectionReason) {
      if (preflightRejectionReason === 'interaction active'
        || preflightRejectionReason === 'canonical shot draft active') {
        // Defer the conflict reload until the gesture ends; keep the newest payload.
        deferredPolledDataRef.current = resolvedPolledData;
      }
      logPollRejection('preflight', resolvedPolledData, preflightRejectionReason);
      return;
    }
    // Mark the initial snapshot as checked as soon as it passes preflight.
    // A later poll must respect recovery hold even if the initial adoption is
    // still waiting for its deferred commit.
    const isInitialSnapshot = !initialProviderSnapshotHandledRef.current;
    if (isInitialSnapshot) initialProviderSnapshotHandledRef.current = true;
    // We accepted this payload — clear any stale deferred reference.
    deferredPolledDataRef.current = null;
    const dataAtPreflight = getDataRef().current;
    const seqAtPreflight = editSeqRef.current;
    const headAtPreflight = headRevisionRef?.current;

    const syncHandle = window.setTimeout(() => {
      if (getDataRef().current !== dataAtPreflight || editSeqRef.current !== seqAtPreflight) return;
      if (provider.saveTimelineAtHead && headRevisionRef) {
        const currentHead = headRevisionRef.current;
        const sameHead = currentHead?.projectId === headAtPreflight?.projectId
          && currentHead?.timelineId === headAtPreflight?.timelineId
          && currentHead?.headRevisionId === headAtPreflight?.headRevisionId;
        if (!sameHead) {
          logPollRejection('timeout', resolvedPolledData, 'editing head advanced');
          return;
        }
      }
      const timeoutRejectionReason = getPollRejectionReason(resolvedPolledData, isInitialSnapshot);
      if (timeoutRejectionReason) {
        logPollRejection('timeout', resolvedPolledData, timeoutRejectionReason);
        return;
      }

      if (configVersionRef.current !== resolvedPolledData.configVersion) {
        logTimelineSync('poll accepted', {
          fromConfigVersion: configVersionRef.current,
          toConfigVersion: resolvedPolledData.configVersion,
          latestObservedRemoteConfigVersion: latestObservedRemoteConfigVersionRef.current,
        });
      }
      latestObservedRemoteConfigVersionRef.current = resolvedPolledData.configVersion;
      logConfigVersionUpdate('poll', resolvedPolledData.configVersion);
      configVersionRef.current = resolvedPolledData.configVersion;
      if (headRevisionRef) headRevisionRef.current = resolvedPolledData.head;
      // Mirror into the store's canonical version channel (outside the data
      // object) so reader/ops/sync see the adopted version.
      store?.getState().setConfigVersion(resolvedPolledData.configVersion);
      const currentData = getDataRef().current;
      commitDataRef.current(
        currentData ? preserveUploadingClips(currentData, resolvedPolledData) : resolvedPolledData,
        { save: false, skipHistory: true, updateLastSavedSignature: true },
      );
    }, 0);

    return () => window.clearTimeout(syncHandle);
  }, [
    configVersionRef,
    headRevisionRef,
    editSeqRef,
    dataRef,
    getPollRejectionReason,
    interactionEndTick,
    logConfigVersionUpdate,
    logPollRejection,
    logTimelineSync,
    getDataRef,
    isConflictExhaustedRef,
    canonicalShotDraftActive,
    queries.timelineQuery.data,
    store,
    provider.saveTimelineAtHead,
  ]);

  useEffect(() => {
    // Head-authoritative providers deliver registry and config together from
    // one immutable revision. A separate registry query has no head evidence.
    if (provider.saveTimelineAtHead) return;
    const current = getDataRef().current;
    const registry = queries.assetRegistryQuery.data;

    if (
      !current
      || !registry
      || isConflictExhaustedRef?.current
      || recoveryActiveRef?.current
      || canonicalReloadInProgressRef?.current
      || !isTimelinePollIdle({
        editSeq: editSeqRef.current,
        savedSeq: savedSeqRef.current,
        pendingOps: getPendingOpsRef().current,
        isSaving: isSavingRef.current,
        interactionActive: isInteractionActive(getInteractionStateRef()),
        canonicalShotDraftActive: canonicalShotDraftActiveRef.current,
      })
      || registry === lastRegistryDataRef.current
    ) {
      return;
    }

    lastRegistryDataRef.current = registry;
    let cancelled = false;
    let syncHandle: number | undefined;
    const seqAtBuild = editSeqRef.current;
    const headAtBuild = current.head;

    void buildTimelineData(
      current.config,
      registry,
      resolveAssetUrl ?? ((file) => provider.resolveAssetUrl(file)),
      current.configVersion,
      current.sourceItemsBySchemaRef,
      current.head,
    ).then((nextData) => {
      if (cancelled || getDataRef().current !== current || editSeqRef.current !== seqAtBuild) return;
      if (
        nextData.stableSignature === current.stableSignature
        && Object.keys(nextData.assetMap).length === Object.keys(current.assetMap).length
      ) {
        return;
      }

      syncHandle = window.setTimeout(() => {
        if (cancelled || getDataRef().current !== current || editSeqRef.current !== seqAtBuild
          || (provider.saveTimelineAtHead && headRevisionRef && (headRevisionRef.current?.headRevisionId !== headAtBuild?.headRevisionId))
          || isConflictExhaustedRef?.current || recoveryActiveRef?.current || canonicalReloadInProgressRef?.current
          || !isTimelinePollIdle({
          editSeq: editSeqRef.current,
          savedSeq: savedSeqRef.current,
          pendingOps: getPendingOpsRef().current,
          isSaving: isSavingRef.current,
          interactionActive: isInteractionActive(getInteractionStateRef()),
          canonicalShotDraftActive: canonicalShotDraftActiveRef.current,
        })) {
          return;
        }

        commitDataRef.current(nextData, {
          save: false,
          skipHistory: true,
          updateLastSavedSignature: true,
          selectedClipId: selectedClipIdRef.current,
          selectedTrackId: selectedTrackIdRef.current,
        });
      }, 0);

    }).catch(() => {});
    return () => {
      cancelled = true;
      if (syncHandle !== undefined) window.clearTimeout(syncHandle);
    };
  }, [
    editSeqRef,
    isSavingRef,
    provider,
    resolveAssetUrl,
    queries.assetRegistryQuery.data,
    savedSeqRef,
    selectedClipIdRef,
    selectedTrackIdRef,
    getDataRef,
    getInteractionStateRef,
    canonicalShotDraftActive,
    getPendingOpsRef,
    isConflictExhaustedRef,
    recoveryActiveRef,
    canonicalReloadInProgressRef,
    headRevisionRef,
    provider.saveTimelineAtHead,
  ]);
}

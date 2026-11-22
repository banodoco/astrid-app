import { persistedTranscriptItems } from '../data/typed/projectTranscript.ts';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useVideoEditorRuntime } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import { isDataProviderPersistenceEnabled } from '@/tools/video-editor/data/DataProvider.ts';
import type {
  CommitDataOptions,
  CommitHistoryOptions,
} from '@/tools/video-editor/hooks/useTimelineCommit.ts';
import {
  isInteractionActive,
  type InteractionStateRef,
} from '@/tools/video-editor/lib/interaction-state.ts';
import {
  buildDataFromCurrentRegistry,
  buildDataFromSnapshot,
} from '@/tools/video-editor/lib/timeline-save-utils.ts';
import { preserveUploadingClips, type TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import type { TimelineConfig } from '@/tools/video-editor/types/index.ts';
import type { TimelineEditability } from '@/tools/video-editor/lib/timeline-editability.ts';
import type {
  Checkpoint,
  CheckpointTriggerType,
  UndoEntry,
  UndoSnapshot,
} from '@/tools/video-editor/types/history.ts';
import type { CanonicalShotCompositionHistoryEntry } from '@/tools/video-editor/data/shotCompositionAdapter.ts';
import type { TimelineLocalSaveHandoff } from './timelineLocalSaveHandoff.ts';

const UNDO_STACK_LIMIT = 100;
const CHECKPOINT_LIMIT = 30;
const CHECKPOINT_RETENTION_MS = 24 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 5 * 60 * 1000;
const EDIT_DISTANCE_CHECKPOINT_THRESHOLD = 30;
const UNTRANSACTED_COLLAPSE_WINDOW_MS = 300;

export interface UseTimelineHistoryArgs {
  dataRef: MutableRefObject<TimelineData | null>;
  commitData: (nextData: TimelineData, options?: CommitDataOptions) => void;
  interactionStateRef: InteractionStateRef;
  /**
   * In-flight upload counter (drops, asset panel uploads). While it is > 0,
   * undo/redo are paused: a history snapshot's registry predates the upload's
   * `patchRegistry` (which is save:false/no-history), so restoring one
   * mid-upload would strand the upload — delete its skeleton clip and its
   * registry patch, leaving an orphaned asset. `preserveUploadingClips`
   * protects the skeleton but nothing can rebase the registry, so the safe
   * semantics is to wait out the window.
   */
  pendingOpsRef: MutableRefObject<number>;
  editability?: TimelineEditability;
  remoteHistory?: Pick<TimelineLocalSaveHandoff, 'remoteHistoryAvailable' | 'canRequestHistory' | 'refreshHistory' | 'canUndo' | 'canRedo' | 'undo' | 'redo'>;
}

export interface UseTimelineHistoryResult {
  canUndo: boolean;
  canRedo: boolean;
  /** True while undo/redo are paused because media uploads are in flight. */
  historyPausedForUploads: boolean;
  checkpoints: Checkpoint[];
  canonicalHistory: readonly CanonicalShotCompositionHistoryEntry[];
  canonicalHistorySupported: boolean;
  canonicalHistoryError: string | null;
  refreshCanonicalHistory: () => Promise<void>;
  restoringCanonicalRevisionId: string | null;
  restoreCanonicalRevision: (revisionId: string) => Promise<void>;
  onBeforeCommit: (currentData: TimelineData, options: CommitHistoryOptions) => void;
  onRemoteData: (currentData: TimelineData, nextData: TimelineData) => void;
  undo: () => void;
  redo: () => void;
  jumpToCheckpoint: (checkpointId: string) => void;
  createManualCheckpoint: (label?: string) => Promise<void>;
  createCheckpoint: (label?: string) => Promise<void>;
}

function cloneConfig(config: TimelineConfig): TimelineConfig {
  return structuredClone(config);
}

function historyBasis(data: TimelineData | null): string | null {
  return data ? JSON.stringify([data.head, data.config, data.registry, data.sourceItemsBySchemaRef]) : null;
}

function buildSnapshot(currentData: TimelineData): UndoSnapshot {
  return {
    config: cloneConfig(currentData.config),
    registry: structuredClone(currentData.registry),
    sourceItemsBySchemaRef: structuredClone(persistedTranscriptItems(currentData.sourceItemsBySchemaRef ?? {})),
    signature: currentData.signature,
  };
}

function isCheckpointFresh(checkpoint: Checkpoint, now: number): boolean {
  return now - new Date(checkpoint.createdAt).getTime() <= CHECKPOINT_RETENTION_MS;
}

function trimCheckpoints(checkpoints: Checkpoint[], now = Date.now()): Checkpoint[] {
  const manual = checkpoints.filter((c) => c.triggerType === 'manual');
  const auto = checkpoints
    .filter((c) => c.triggerType !== 'manual' && isCheckpointFresh(c, now))
    .slice(0, CHECKPOINT_LIMIT);
  return [...manual, ...auto].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

function defaultCheckpointLabel(triggerType: CheckpointTriggerType): string {
  switch (triggerType) {
    case 'session_boundary':
      return 'Session checkpoint';
    case 'edit_distance':
      return 'Auto checkpoint';
    case 'semantic':
      return 'Before destructive edit';
    case 'manual':
      return 'Manual checkpoint';
  }
}

export function useTimelineHistory({
  dataRef,
  commitData,
  interactionStateRef,
  pendingOpsRef,
  editability,
  remoteHistory,
}: UseTimelineHistoryArgs): UseTimelineHistoryResult {
  const { provider, timelineId, project, toast } = useVideoEditorRuntime();
  const historyProjectId = project.projectId;
  const undoStackRef = useRef<UndoEntry[]>([]);
  const redoStackRef = useRef<UndoEntry[]>([]);
  const lastEditTimestampRef = useRef<number | null>(null);
  const editsSinceLastCheckpointRef = useRef(0);
  const lastUntransactedEditAtRef = useRef<number | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [canonicalHistory, setCanonicalHistory] = useState<readonly CanonicalShotCompositionHistoryEntry[]>([]);
  const [canonicalHistoryError, setCanonicalHistoryError] = useState<string | null>(remoteHistory ? 'History has not been loaded.' : null);
  const [restoringCanonicalRevisionId, setRestoringCanonicalRevisionId] = useState<string | null>(null);
  const canonicalHistoryRequestRef = useRef(0);
  const historyActionPendingRef = useRef(false);
  const canonicalHistoryBasisRef = useRef<TimelineData | null>(null);
  const canonicalHistoryFingerprintRef = useRef<string | null>(null);
  const canonicalHistorySupported = Boolean(provider.shotComposition?.listHistory && provider.shotComposition?.restoreHistory);

  const syncHistoryState = useCallback(() => {
    const nextCanUndo = undoStackRef.current.length > 0;
    const nextCanRedo = redoStackRef.current.length > 0;
    setCanUndo((current) => (current === nextCanUndo ? current : nextCanUndo));
    setCanRedo((current) => (current === nextCanRedo ? current : nextCanRedo));
  }, []);

  const appendCheckpoint = useCallback((checkpoint: Checkpoint) => {
    setCheckpoints((current) => {
      const deduped = [checkpoint, ...current.filter((entry) => entry.id !== checkpoint.id)];
      return trimCheckpoints(deduped);
    });
  }, []);

  const clearRedoStack = useCallback(() => {
    if (redoStackRef.current.length === 0) {
      return;
    }

    redoStackRef.current = [];
    syncHistoryState();
  }, [syncHistoryState]);

  const persistCheckpoint = useCallback(async (
    currentData: TimelineData,
    triggerType: CheckpointTriggerType,
    editsSinceLastCheckpoint: number,
    label?: string,
  ) => {
    if (!isDataProviderPersistenceEnabled(provider) || !provider.saveCheckpoint) {
      return;
    }

    const createdAt = new Date().toISOString();
    const checkpointInput = {
      timelineId,
      config: cloneConfig(currentData.config),
      registry: structuredClone(currentData.registry),
      sourceItemsBySchemaRef: structuredClone(persistedTranscriptItems(currentData.sourceItemsBySchemaRef ?? {})),
      createdAt,
      triggerType,
      label: label?.trim() || defaultCheckpointLabel(triggerType),
      editsSinceLastCheckpoint,
    };

    try {
      const checkpointId = await provider.saveCheckpoint(timelineId, checkpointInput);
      appendCheckpoint({
        id: checkpointId,
        ...checkpointInput,
      });
    } catch {
      // Checkpoint persistence is best-effort and should not interrupt editing.
    }
  }, [appendCheckpoint, provider, timelineId]);

  const applyHistoryEntry = useCallback((
    current: TimelineData,
    entry: UndoEntry,
  ) => {
    const nextConfig = cloneConfig(entry.snapshot.config);
    return entry.snapshot.registry
      ? buildDataFromSnapshot(nextConfig, entry.snapshot.registry, current, entry.snapshot.sourceItemsBySchemaRef)
      : buildDataFromCurrentRegistry(nextConfig, current, { sourceItemsBySchemaRef: entry.snapshot.sourceItemsBySchemaRef });
  }, []);

  const restoreHistoryEntry = useCallback((entry: UndoEntry) => {
    const current = dataRef.current;
    if (!current) {
      return false;
    }

    const nextData = applyHistoryEntry(current, entry);
    // Same protection every applyEdit path has: history snapshots never contain
    // transient `uploading-*` skeletons (rowsToConfig drops them from config),
    // so a restore during an in-flight upload would silently delete the
    // upload's placeholder. Carry it over from the live rows instead.
    commitData(
      preserveUploadingClips(current, nextData),
      { save: true, skipHistory: true },
    );
    lastEditTimestampRef.current = Date.now();
    lastUntransactedEditAtRef.current = null;
    return true;
  }, [applyHistoryEntry, commitData, dataRef]);

  const pushUndoEntry = useCallback((entry: UndoEntry) => {
    undoStackRef.current = [...undoStackRef.current, entry].slice(-UNDO_STACK_LIMIT);
    syncHistoryState();
  }, [syncHistoryState]);

  const onBeforeCommit = useCallback((currentData: TimelineData, options: CommitHistoryOptions) => {
    const now = Date.now();
    const topUndoEntry = undoStackRef.current[undoStackRef.current.length - 1] ?? null;
    const hasMatchingTransaction = Boolean(
      options.transactionId
      && topUndoEntry?.transactionId
      && topUndoEntry.transactionId === options.transactionId,
    );
    const isDebouncedUntransactedEdit = Boolean(
      !options.transactionId
      && !topUndoEntry?.transactionId
      && lastUntransactedEditAtRef.current !== null
      && now - lastUntransactedEditAtRef.current <= UNTRANSACTED_COLLAPSE_WINDOW_MS,
    );
    const isSessionBoundary = Boolean(
      lastEditTimestampRef.current !== null
      && now - lastEditTimestampRef.current > SESSION_IDLE_MS,
    );
    const shouldCreateDistanceCheckpoint =
      editsSinceLastCheckpointRef.current >= EDIT_DISTANCE_CHECKPOINT_THRESHOLD;

    let checkpointTrigger: CheckpointTriggerType | null = null;
    if (isSessionBoundary) {
      checkpointTrigger = 'session_boundary';
    } else if (options.semantic) {
      checkpointTrigger = 'semantic';
    } else if (shouldCreateDistanceCheckpoint) {
      checkpointTrigger = 'edit_distance';
    }

    if (checkpointTrigger) {
      void persistCheckpoint(
        currentData,
        checkpointTrigger,
        editsSinceLastCheckpointRef.current,
      );
      editsSinceLastCheckpointRef.current = 1;
    } else {
      editsSinceLastCheckpointRef.current += 1;
    }

    clearRedoStack();

    const nextEntry: UndoEntry = {
      snapshot: buildSnapshot(currentData),
      timestamp: new Date(now).toISOString(),
      transactionId: options.transactionId,
    };

    if (hasMatchingTransaction || isDebouncedUntransactedEdit) {
      if (topUndoEntry) {
        undoStackRef.current = [
          ...undoStackRef.current.slice(0, -1),
          topUndoEntry,
        ];
      }
    } else {
      pushUndoEntry(nextEntry);
    }

    lastEditTimestampRef.current = now;
    if (!options.transactionId) {
      lastUntransactedEditAtRef.current = now;
    } else {
      lastUntransactedEditAtRef.current = null;
    }
  }, [clearRedoStack, persistCheckpoint, pushUndoEntry]);

  /**
   * Server-authoritative data replaced local state (accepted poll, conflict
   * reload, registry refresh). Every stacked snapshot predates that boundary:
   * restoring one would revert the remote client's persisted work and save the
   * result — silent multi-client data loss with both UIs reading "saved".
   * Rebasing snapshots over remote changes is a merge problem this history
   * model does not attempt, so the safe semantics is to invalidate the stacks
   * at the boundary. Echoes (same stableSignature, e.g. a URL re-resolution
   * refresh) keep the stacks.
   */
  const onRemoteData = useCallback((currentData: TimelineData, nextData: TimelineData) => {
    if (currentData.stableSignature === nextData.stableSignature) {
      return;
    }

    if (undoStackRef.current.length === 0 && redoStackRef.current.length === 0) {
      return;
    }

    undoStackRef.current = [];
    redoStackRef.current = [];
    // A subsequent untransacted edit must start a fresh entry rather than try
    // to collapse into a top-of-stack entry that no longer exists.
    lastUntransactedEditAtRef.current = null;
    syncHistoryState();
  }, [syncHistoryState]);

  const undo = useCallback(() => {
    if (remoteHistory) {
      if (pendingOpsRef.current > 0 || isInteractionActive(interactionStateRef)
        || (editability?.checkTimeline && !editability.checkTimeline().allowed) || historyActionPendingRef.current) return;
      if (!remoteHistory.remoteHistoryAvailable()) {
        const basis = dataRef.current;
        if (!basis?.head?.headRevisionId || !basis.head.headPublicationId) return;
        if (!remoteHistory.canRequestHistory?.(basis.head) || !remoteHistory.refreshHistory) return;
        const fingerprint = historyBasis(basis);
        historyActionPendingRef.current = true;
        void remoteHistory.refreshHistory().then(async () => {
          if (dataRef.current !== basis || historyBasis(dataRef.current) !== fingerprint || pendingOpsRef.current > 0
            || isInteractionActive(interactionStateRef) || (editability?.checkTimeline && !editability.checkTimeline().allowed)
            || !remoteHistory.remoteHistoryAvailable()) return;
          if (!remoteHistory.canUndo()) { toast.info('No saved timeline change to undo'); return; }
          await remoteHistory.undo();
        }).catch((error: unknown) => {
          toast.error('Could not undo timeline', { description: error instanceof Error ? error.message : String(error) });
        }).finally(() => { historyActionPendingRef.current = false; });
        return;
      }
      if (!remoteHistory.canUndo()) return;
      void remoteHistory.undo().catch((error: unknown) => {
        toast.error('Could not undo timeline', { description: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (editability?.checkTimeline && !editability.checkTimeline().allowed) return;
    if (pendingOpsRef.current > 0) {
      // Dev-only diagnostic (stripped in prod); the toolbar communicates the
      // pause to the user via disabled state + title.
      console.log('[TimelineHistory] undo ignored: paused while media uploads finish', {
        pendingOps: pendingOpsRef.current,
      });
      return;
    }

    const current = dataRef.current;
    const entry = undoStackRef.current[undoStackRef.current.length - 1];
    if (!current || !entry || isInteractionActive(interactionStateRef)) {
      return;
    }

    if (!restoreHistoryEntry(entry)) {
      return;
    }

    undoStackRef.current = undoStackRef.current.slice(0, -1);
    redoStackRef.current = [
      ...redoStackRef.current,
      {
        ...entry,
        snapshot: buildSnapshot(current),
        timestamp: new Date().toISOString(),
      },
    ].slice(-UNDO_STACK_LIMIT);
    syncHistoryState();
  }, [dataRef, editability, interactionStateRef, pendingOpsRef, remoteHistory, restoreHistoryEntry, syncHistoryState, toast]);

  const redo = useCallback(() => {
    if (remoteHistory) {
      if (pendingOpsRef.current > 0 || isInteractionActive(interactionStateRef)
        || (editability?.checkTimeline && !editability.checkTimeline().allowed) || historyActionPendingRef.current) return;
      if (!remoteHistory.remoteHistoryAvailable()) {
        const basis = dataRef.current;
        if (!basis?.head?.headRevisionId || !basis.head.headPublicationId) return;
        if (!remoteHistory.canRequestHistory?.(basis.head) || !remoteHistory.refreshHistory) return;
        const fingerprint = historyBasis(basis);
        historyActionPendingRef.current = true;
        void remoteHistory.refreshHistory().then(async () => {
          if (dataRef.current !== basis || historyBasis(dataRef.current) !== fingerprint || pendingOpsRef.current > 0
            || isInteractionActive(interactionStateRef) || (editability?.checkTimeline && !editability.checkTimeline().allowed)
            || !remoteHistory.remoteHistoryAvailable()) return;
          if (!remoteHistory.canRedo()) { toast.info('No saved timeline change to redo'); return; }
          await remoteHistory.redo();
        }).catch((error: unknown) => {
          toast.error('Could not redo timeline', { description: error instanceof Error ? error.message : String(error) });
        }).finally(() => { historyActionPendingRef.current = false; });
        return;
      }
      if (!remoteHistory.canRedo()) return;
      void remoteHistory.redo().catch((error: unknown) => {
        toast.error('Could not redo timeline', { description: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (editability?.checkTimeline && !editability.checkTimeline().allowed) return;
    if (pendingOpsRef.current > 0) {
      console.log('[TimelineHistory] redo ignored: paused while media uploads finish', {
        pendingOps: pendingOpsRef.current,
      });
      return;
    }

    const current = dataRef.current;
    const entry = redoStackRef.current[redoStackRef.current.length - 1];
    if (!current || !entry || isInteractionActive(interactionStateRef)) {
      return;
    }

    if (!restoreHistoryEntry(entry)) {
      return;
    }

    redoStackRef.current = redoStackRef.current.slice(0, -1);
    undoStackRef.current = [
      ...undoStackRef.current,
      {
        ...entry,
        snapshot: buildSnapshot(current),
        timestamp: new Date().toISOString(),
      },
    ].slice(-UNDO_STACK_LIMIT);
    syncHistoryState();
  }, [dataRef, editability, interactionStateRef, pendingOpsRef, remoteHistory, restoreHistoryEntry, syncHistoryState, toast]);

  const jumpToCheckpoint = useCallback((checkpointId: string) => {
    if (editability?.checkTimeline && !editability.checkTimeline().allowed) return;
    const current = dataRef.current;
    const checkpoint = checkpoints.find((entry) => entry.id === checkpointId);
    if (!current || !checkpoint) {
      return;
    }

    undoStackRef.current = [];
    redoStackRef.current = [];
    syncHistoryState();
    restoreHistoryEntry({
      snapshot: {
        config: cloneConfig(checkpoint.config),
        registry: checkpoint.registry,
        sourceItemsBySchemaRef: checkpoint.sourceItemsBySchemaRef,
        signature: checkpoint.id,
      },
      timestamp: new Date().toISOString(),
    });
    editsSinceLastCheckpointRef.current = 0;
  }, [checkpoints, dataRef, editability, restoreHistoryEntry, syncHistoryState]);

  const createManualCheckpoint = useCallback(async (label?: string) => {
    if (editability?.checkTimeline && !editability.checkTimeline().allowed) return;
    const current = dataRef.current;
    if (!current) {
      return;
    }

    await persistCheckpoint(
      current,
      'manual',
      editsSinceLastCheckpointRef.current,
      label,
    );
    editsSinceLastCheckpointRef.current = 0;
  }, [dataRef, editability, persistCheckpoint]);

  useEffect(() => {
    if (!isDataProviderPersistenceEnabled(provider) || !provider.loadCheckpoints) {
      return;
    }

    let cancelled = false;

    void provider.loadCheckpoints(timelineId)
      .then((loadedCheckpoints) => {
        if (cancelled) {
          return;
        }

        setCheckpoints(trimCheckpoints(loadedCheckpoints));
      })
      .catch(() => {
        if (!cancelled) {
          setCheckpoints([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [provider, timelineId]);

  const refreshCanonicalHistory = useCallback(async () => {
    const requestId = ++canonicalHistoryRequestRef.current;
    const listHistory = provider.shotComposition?.listHistory;
    if (!listHistory || !timelineId || !historyProjectId) {
      setCanonicalHistory([]);
      setCanonicalHistoryError(null);
      return;
    }

    const basis = dataRef.current;
    const fingerprint = historyBasis(basis);
    canonicalHistoryBasisRef.current = null;
    canonicalHistoryFingerprintRef.current = null;
    setCanonicalHistoryError(remoteHistory ? 'Loading timeline history…' : null);
    try {
      await remoteHistory?.refreshHistory?.();
      const entries = await listHistory({ projectId: historyProjectId, parentDocumentId: timelineId });
      if (requestId === canonicalHistoryRequestRef.current) {
        if (remoteHistory && (dataRef.current !== basis || historyBasis(dataRef.current) !== fingerprint
          || !basis?.head?.headRevisionId || !basis.head.headPublicationId
          || !remoteHistory.remoteHistoryAvailable()
          || !entries.some(entry => entry.isCurrentHead && entry.revisionId === basis.head?.headRevisionId))) {
          setCanonicalHistory([]);
          setCanonicalHistoryError('Timeline changed while history was loading. Open history again.');
          return;
        }
        canonicalHistoryBasisRef.current = basis;
        canonicalHistoryFingerprintRef.current = fingerprint;
        setCanonicalHistory(entries);
        setCanonicalHistoryError(null);
      }
    } catch (error: unknown) {
      if (requestId === canonicalHistoryRequestRef.current) {
        setCanonicalHistory([]);
        setCanonicalHistoryError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [dataRef, historyProjectId, provider, remoteHistory, timelineId]);

  useEffect(() => {
    return () => {
      canonicalHistoryRequestRef.current += 1;
    };
  }, [refreshCanonicalHistory]);

  const restoreCanonicalRevision = useCallback(async (revisionId: string) => {
    const restoreHistory = provider.shotComposition?.restoreHistory;
    if (!restoreHistory || !timelineId || !historyProjectId) return;
    if (remoteHistory && (!canonicalHistoryBasisRef.current || canonicalHistoryBasisRef.current !== dataRef.current
      || canonicalHistoryFingerprintRef.current !== historyBasis(dataRef.current)
      || !remoteHistory.remoteHistoryAvailable() || !canonicalHistory.some(entry => entry.revisionId === revisionId))) {
      setCanonicalHistoryError('Load current timeline history before restoring a revision.');
      return;
    }
    if (editability?.checkTimeline && !editability.checkTimeline().allowed) return;
    if (pendingOpsRef.current > 0 || isInteractionActive(interactionStateRef)) {
      setCanonicalHistoryError('History restore is paused while an edit or media upload is active.');
      return;
    }

    setCanonicalHistoryError(null);
    setRestoringCanonicalRevisionId(revisionId);
    try {
      await restoreHistory({ projectId: historyProjectId, parentDocumentId: timelineId, revisionId });
      const entries = await provider.shotComposition?.listHistory?.({
        projectId: historyProjectId,
        parentDocumentId: timelineId,
      });
      if (entries) setCanonicalHistory(entries);
      undoStackRef.current = [];
      redoStackRef.current = [];
      syncHistoryState();
      toast.success('Timeline history restored', { description: `Restored revision ${revisionId.slice(0, 16)}.` });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setCanonicalHistoryError(message);
      toast.error('Could not restore timeline history', { description: message });
    } finally {
      setRestoringCanonicalRevisionId(null);
    }
  }, [canonicalHistory, dataRef, editability, historyProjectId, interactionStateRef, pendingOpsRef, provider, remoteHistory, syncHistoryState, timelineId, toast]);

  // Read at render time. Every pendingOps transition is bracketed by a data
  // commit (skeleton insert on increment; skeleton removal / failure cleanup
  // before the `finally` decrement), so the tree re-renders right after each
  // transition and this value cannot go stale for longer than that commit.
  const historyPausedForUploads = pendingOpsRef.current > 0;
  const canRequestRemoteHistory = Boolean(dataRef.current?.head?.headRevisionId && dataRef.current.head.headPublicationId
    && remoteHistory?.canRequestHistory?.(dataRef.current.head) && remoteHistory.refreshHistory
    && !historyActionPendingRef.current && !historyPausedForUploads && !isInteractionActive(interactionStateRef)
    && (!editability?.checkTimeline || editability.checkTimeline().allowed));
  const historyStale = Boolean(remoteHistory && canonicalHistoryBasisRef.current
    && (canonicalHistoryBasisRef.current !== dataRef.current
      || canonicalHistoryFingerprintRef.current !== historyBasis(dataRef.current)
      || !remoteHistory.remoteHistoryAvailable()));

  return {
    canUndo: (remoteHistory ? remoteHistory.canUndo() || canRequestRemoteHistory : canUndo) && !historyPausedForUploads,
    canRedo: (remoteHistory ? remoteHistory.canRedo() || canRequestRemoteHistory : canRedo) && !historyPausedForUploads,
    historyPausedForUploads,
    checkpoints,
    canonicalHistory: historyStale ? [] : canonicalHistory,
    canonicalHistorySupported,
    canonicalHistoryError: historyStale ? 'Timeline changed. Open history again.' : canonicalHistoryError,
    refreshCanonicalHistory,
    restoringCanonicalRevisionId,
    restoreCanonicalRevision,
    onBeforeCommit,
    onRemoteData,
    undo,
    redo,
    jumpToCheckpoint,
    createManualCheckpoint,
    createCheckpoint: createManualCheckpoint,
  };
}

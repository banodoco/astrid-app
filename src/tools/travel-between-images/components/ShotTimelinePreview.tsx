import { getTimelineDurationInFrames } from '@/tools/video-editor/lib/config-utils.ts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TimelinePersistenceHandoffContext } from '@/tools/video-editor/hooks/timelineLocalSaveHandoff.ts';
import type { SaveStatus } from '@/tools/video-editor/hooks/useTimelinePersistence.ts';
import type { DataProvider } from '@/tools/video-editor/data/DataProvider.ts';
import { AlertCircle, Film } from 'lucide-react';
import { Button } from '@/shared/components/ui/button.tsx';
import { VideoEditorProvider } from '@/tools/video-editor/contexts/VideoEditorProvider.tsx';
import { TimelineEditorCore } from '@/tools/video-editor/components/TimelineEditor/TimelineEditorCore.tsx';
import { RemotionPreview } from '@/tools/video-editor/components/PreviewPanel/RemotionPreview.tsx';
import type { PreviewRevision } from '@/tools/video-editor/components/PreviewPanel/previewRevision.ts';
import { projectCanonicalComposition } from '@/tools/video-editor/data/shotCompositionProjection.ts';
import { useTimelinePlaybackContext } from '@/tools/video-editor/hooks/timelineStore.ts';
import { useTimelineChromeContext } from '@/tools/video-editor/hooks/timelineStore.ts';
import { useTimelineEditorData } from '@/tools/video-editor/hooks/timelineStore.ts';
import { createTimelineEditability } from '@/tools/video-editor/lib/timeline-editability.ts';
import type { TimelineEditability } from '@/tools/video-editor/lib/timeline-editability.ts';
import { recordShotTimelinePhase, SHOT_TIMELINE_TIMING_EVENT, type ShotTimelineTimingDetail } from '@/tools/video-editor/lib/shot-timeline-timing.ts';
import type {
  PreparedShotComposition,
  ShotCompositionAdapter,
} from '@/tools/video-editor/data/shotCompositionAdapter.ts';
import type {
  CanonicalShotTimelineDraft,
  CanonicalShotTimelinePublication,
  CanonicalShotTimelineScope,
} from '@/tools/video-editor/runtime/ports.ts';
import { hardDurationMs } from '@/tools/video-editor/data/shotCompositionEditor.ts';
import type { ResolvedTimelineConfig } from '@/tools/video-editor/types/index.ts';
import {
  createShotTimelineDataProvider,
  createShotTimelineInitialData,
  createShotTimelineEditorSessionToken,
  projectShotTimelineDraftComposition,
  projectShotTimelineRenderConfig,
  shotTimelineDurationSeconds,
  shotTimelineSessionId,
  type ShotTimelineEditorHeadState,
} from './shotTimelineDataProvider.ts';

type ShotTimelinePreviewProps = {
  composition: PreparedShotComposition;
  occurrenceId: string;
  shotCompositionAdapter?: ShotCompositionAdapter;
  /** Parent Runtime provider; popup saves reuse its A2 document outbox. */
  timelineDataProvider?: DataProvider;
  onCanonicalCompositionPublished?: (
    composition: PreparedShotComposition,
    publication?: CanonicalShotTimelinePublication,
  ) => void;
  onCanonicalDraftSessionChange?: (scope: CanonicalShotTimelineScope, active: boolean) => void;
  onCanonicalDraftProjectionChange?: (draft: CanonicalShotTimelineDraft) => void;
  onCanonicalDraftProjectionClear?: (scope: CanonicalShotTimelineScope, generation: number) => void;
  /** Keep an external head refresh from replacing an unsaved nested draft. */
  onCanonicalDraftStateChange?: (dirty: boolean) => void;
};

type ProjectionState = {
  config: ResolvedTimelineConfig | null;
  error: string | null;
};

export function boundShotTimelinePreviewConfig(
  config: ResolvedTimelineConfig,
  hardDurationSeconds?: number,
): ResolvedTimelineConfig {
  const durationMs = Math.ceil(shotTimelineDurationSeconds(config, hardDurationSeconds) * 1000);
  return {
    ...config,
    clips: config.clips.map((clip) => {
      const app = clip.app && typeof clip.app === 'object' && !Array.isArray(clip.app)
        ? clip.app
        : null;
      const timing = app?.canonicalTiming && typeof app.canonicalTiming === 'object'
        && !Array.isArray(app.canonicalTiming)
        ? app.canonicalTiming
        : null;
      return app && timing
        ? { ...clip, app: { ...app, canonicalTiming: { ...timing, occurrenceStartMs: 0, occurrenceDurationMs: durationMs } } }
        : clip;
    }),
  };
}

function projectShotTimeline(composition: PreparedShotComposition, occurrenceId: string): ProjectionState {
  const occurrence = composition.occurrences.find((candidate) => candidate.occurrenceId === occurrenceId);
  if (!occurrence) {
    return { config: null, error: 'This shot occurrence is no longer present in the canonical timeline.' };
  }

  try {
    // The shared projection deliberately uses parent-document time so the full
    // editor can place the shot correctly. This view is shot-local, so remove
    // the occurrence offset after projection without changing any child timing
    // or asset resolution rules.
    const singleShotComposition: PreparedShotComposition = {
      ...composition,
      occurrences: [occurrence],
    };
    const projected = projectCanonicalComposition(singleShotComposition, {
      output: { resolution: '1920x1080', fps: 30, file: `shot-${occurrence.shotId}.mp4` },
      tracks: [],
      clips: [],
      registry: {},
    }, { clampToOccurrenceDuration: false }).config;
    const occurrenceOffset = occurrence.atMs / 1000;
    const clips = projected.clips.map((clip) => {
      const app = clip.app && typeof clip.app === 'object' && !Array.isArray(clip.app)
        ? clip.app
        : null;
      const canonicalTiming = app?.canonicalTiming && typeof app.canonicalTiming === 'object'
        && !Array.isArray(app.canonicalTiming)
        ? app.canonicalTiming
        : null;
      return {
        ...clip,
        at: Math.max(0, clip.at - occurrenceOffset),
        // The popup is a shot-local coordinate system. Keep the canonical
        // identity, but normalize the render boundary to local zero so the
        // half-open guard does not discard every preview clip at the parent
        // document's absolute occurrence offset.
        ...(app && canonicalTiming
          ? { app: { ...app, canonicalTiming: { ...canonicalTiming, occurrenceStartMs: 0 } } }
          : {}),
      };
    });
    return { config: { ...projected, clips }, error: null };
  } catch (error) {
    return {
      config: null,
      error: error instanceof Error ? error.message : 'The canonical shot timeline could not be projected.',
    };
  }
}

function getConfigHeadRevisionId(config: { app?: unknown } | null | undefined): string | null {
  const app = config?.app && typeof config.app === 'object' && !Array.isArray(config.app)
    ? config.app as Record<string, unknown>
    : null;
  const canonical = app?.canonicalComposition && typeof app.canonicalComposition === 'object'
    && !Array.isArray(app.canonicalComposition)
    ? app.canonicalComposition as Record<string, unknown>
    : null;
  return typeof canonical?.headRevisionId === 'string' ? canonical.headRevisionId : null;
}

function ShotTimelineEditorSurface({
  config,
  hardDurationSeconds,
  editorHeadState,
  onActiveConfigChange,
}: {
  config: ResolvedTimelineConfig;
  hardDurationSeconds?: number;
  editorHeadState: { current: ShotTimelineEditorHeadState };
  onActiveConfigChange?: (config: ResolvedTimelineConfig) => void;
}) {
  const chrome = useTimelineChromeContext();
  const { previewRef, playerContainerRef, currentTime, onPreviewTimeUpdate } = useTimelinePlaybackContext();
  const editorData = useTimelineEditorData();
  const activeConfig = editorData.resolvedConfig ?? config;
  // Resolved config is the visual/rendering model and may omit timeline-level
  // metadata. Prefer the persisted config actually consumed by this mounted
  // query; only fall back to that same editor query's resolved config when a
  // provider/test double omits the persisted wrapper. Never use the parent
  // projection as adoption authority while the old query remains mounted.
  const displayedHeadRevisionId = getConfigHeadRevisionId(editorData.data?.config)
    ?? getConfigHeadRevisionId(editorData.resolvedConfig);
  const [, setHeadAdoptionRenderTick] = useState(0);
  const canonicalHeadRevisionId = editorHeadState.current.canonicalHeadRevisionId;
  const isAdoptingCanonicalHead = Boolean(
    canonicalHeadRevisionId
      && editorHeadState.current.displayedHeadRevisionId !== canonicalHeadRevisionId,
  );
  const previousConfigRef = useRef(activeConfig);
  const previousActiveConfigRef = useRef(activeConfig);
  const lastReportedDraftConfigRef = useRef(activeConfig);
  const pendingTraceRef = useRef<string | null>(null);
  const draftCommitAtRef = useRef<{ at: number; traceId: string | null } | null>(null);
  useEffect(() => {
    const onTimingEvent = (event: Event) => {
      const detail = (event as CustomEvent<ShotTimelineTimingDetail>).detail;
      if (detail?.phase === 'local-commit') pendingTraceRef.current = detail.traceId;
    };
    globalThis.addEventListener(SHOT_TIMELINE_TIMING_EVENT, onTimingEvent);
    return () => globalThis.removeEventListener(SHOT_TIMELINE_TIMING_EVENT, onTimingEvent);
  }, []);
  if (previousConfigRef.current !== activeConfig) {
    previousConfigRef.current = activeConfig;
    draftCommitAtRef.current = import.meta.env.DEV
      ? { at: performance.now(), traceId: pendingTraceRef.current }
      : null;
    pendingTraceRef.current = null;
  }
  useLayoutEffect(() => {
    const pending = draftCommitAtRef.current;
    if (pending === null || !import.meta.env.DEV) return;
    const frame = requestAnimationFrame(() => {
      const elapsedMs = performance.now() - pending.at;
      // Visible in DevTools without adding production telemetry. This is
      // React-draft-commit -> next animation frame, not input -> persistence.
      performance.mark('shot-timeline:local-next-frame');
      performance.measure('shot-timeline:local-commit-to-next-frame', {
        start: pending.at,
        end: performance.now(),
        detail: { elapsedMs },
      });
      if (pending.traceId) recordShotTimelinePhase(pending.traceId, 'local-commit-to-paint', { elapsedMs });
      draftCommitAtRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [activeConfig]);
  useLayoutEffect(() => {
    const configChanged = previousActiveConfigRef.current !== activeConfig;
    previousActiveConfigRef.current = activeConfig;
    if (chrome.saveStatus === 'saved') return;
    if (!configChanged && lastReportedDraftConfigRef.current === activeConfig) return;
    lastReportedDraftConfigRef.current = activeConfig;
    onActiveConfigChange?.(activeConfig);
  }, [activeConfig, chrome.saveStatus, onActiveConfigChange]);
  useLayoutEffect(() => {
    if (editorHeadState.current.displayedHeadRevisionId !== displayedHeadRevisionId) {
      editorHeadState.current.displayedHeadRevisionId = displayedHeadRevisionId;
      setHeadAdoptionRenderTick((tick) => tick + 1);
    }
  }, [displayedHeadRevisionId, editorHeadState]);
  const durationLimitSeconds = shotTimelineDurationSeconds(activeConfig, hardDurationSeconds);
  const freeSeconds = hardDurationSeconds === undefined
    ? undefined
    : Math.max(0, hardDurationSeconds - durationLimitSeconds);

  const durationSeconds = useMemo(() => {
    return getTimelineDurationInFrames(activeConfig, activeConfig.output.fps) / activeConfig.output.fps;
  }, [activeConfig]);

  const saveStatus = chrome.isConflictExhausted
    ? 'conflict'
    : chrome.watchdogTripped
      ? 'error'
      : chrome.saveStatus;
  const saveStatusLabel = saveStatus === 'saved'
    ? 'Saved to canonical timeline'
    : saveStatus === 'saving'
      ? 'Saving canonical timeline…'
      : saveStatus === 'retrying'
        ? 'Retrying canonical save…'
        : saveStatus === 'conflict'
          ? 'Save blocked: timeline changed elsewhere'
          : saveStatus === 'error'
            ? 'Save needs attention'
            : 'Unsaved changes — saving shortly';

  const previewRevision = useMemo<PreviewRevision>(() => {
    if (isAdoptingCanonicalHead && canonicalHeadRevisionId) {
      return {
        kind: 'unavailable',
        unavailableTarget: {
          targetRevisionId: canonicalHeadRevisionId,
          reason: 'The mounted shot preview is still adopting the latest canonical revision.',
        },
      };
    }
    if (saveStatus !== 'saved') {
      return { kind: 'local', baseRevisionId: canonicalHeadRevisionId };
    }
    return canonicalHeadRevisionId
      ? { kind: 'committed', revisionId: canonicalHeadRevisionId }
      : { kind: 'unknown', reason: 'The mounted shot timeline has no canonical revision identity.' };
  }, [canonicalHeadRevisionId, isAdoptingCanonicalHead, saveStatus]);

  const previewConfig = useMemo(
    () => boundShotTimelinePreviewConfig(projectShotTimelineRenderConfig(activeConfig), hardDurationSeconds),
    [activeConfig, hardDurationSeconds],
  );

  return (
    <div
      className="space-y-3"
      data-shot-timeline-editor="true"
      data-shot-timeline-current-time={currentTime}
    >
      <ShotTimelineRecoveryControls />
      {isAdoptingCanonicalHead ? (
        <div role="status" data-shot-timeline-head-adoption="pending" className="text-xs text-muted-foreground">
          Updating canonical shot; editing is paused.
        </div>
      ) : null}
      <div className="flex justify-end">
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-right font-mono text-[11px] text-muted-foreground">
          <span
            role={saveStatus === 'saved' ? undefined : 'status'}
            data-shot-timeline-save-status={saveStatus}
            className={saveStatus === 'saved' ? 'text-emerald-600 dark:text-emerald-400' : undefined}
          >
            {saveStatusLabel}
          </span>
          <span>
            {activeConfig.output.fps} fps · shot ends {durationLimitSeconds.toFixed(2)}s · {freeSeconds === undefined ? 'no free-space limit' : `${freeSeconds.toFixed(2)}s free`} · {hardDurationSeconds === undefined ? 'no hard stop' : `blocked at ${hardDurationSeconds.toFixed(2)}s`}
          </span>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="relative mx-auto aspect-video min-h-[220px] w-full max-w-[640px]">
          <RemotionPreview
            ref={previewRef}
            config={previewConfig}
            previewRevision={previewRevision}
            compact
            onTimeUpdate={onPreviewTimeUpdate}
            playerContainerRef={playerContainerRef}
          />
        </div>
      </div>
      <div
        className="overflow-hidden rounded-lg"
        data-shot-timeline-canvas="true"
        data-shot-timeline-clip-count={activeConfig.clips.length}
        data-shot-timeline-tracks={activeConfig.tracks.map((track) => `${track.id}:${track.kind}`).join('|')}
        data-shot-timeline-clip-assets={activeConfig.clips.map((clip) => `${clip.id}:${clip.track}:${clip.at}:${clip.from ?? 'no-from'}:${clip.to ?? 'no-to'}:${clip.hold ?? 'no-hold'}:${clip.clipType ?? 'media'}:${clip.asset ? 'asset' : 'no-asset'}:${clip.assetEntry?.type ?? 'unknown'}`).join('|')}
      >
        {activeConfig.clips.length > 24 ? (
          <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/20 px-3 py-2 text-xs">
            <span className="text-muted-foreground">
              One canonical shot · {activeConfig.clips.length} internal render clips · drop media below to add it
            </span>
          </div>
        ) : null}
        <div className="h-44 min-h-36 overflow-hidden">
          <TimelineEditorCore
            durationLimitSeconds={durationLimitSeconds}
            hardDurationSeconds={hardDurationSeconds}
          />
        </div>
      </div>
      <div className="sr-only">Shot timeline duration {durationSeconds.toFixed(2)} seconds.</div>
    </div>
  );
}
export function ShotTimelineRecoveryControls() {
  const chrome = useTimelineChromeContext();
  const recovery = chrome.recoveryDraft;
  if (!recovery && !chrome.isConflictExhausted) {
    return null;
  }

  return (
    <div className="space-y-2" data-shot-timeline-recovery="true">
      {recovery ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
        >
          <span>
            Recovered unsaved changes from {new Date(recovery.updatedAt).toLocaleString()}.
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void chrome.retryRecoveredDraft()}>
              Retry
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void chrome.discardRecoveredDraft()}>
              Discard
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void chrome.reloadFromServer().catch(() => undefined)}>
              Reload
            </Button>
          </div>
        </div>
      ) : null}
      {chrome.isConflictExhausted ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span>This timeline changed elsewhere. Reload or save your work as a copy.</span>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void chrome.reloadFromServer().catch(() => undefined)}>
              Reload
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void chrome.retrySaveAfterConflict()}>
              Save as copy
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}


export function ShotTimelinePreview({
  composition,
  occurrenceId,
  shotCompositionAdapter,
  timelineDataProvider,
  onCanonicalCompositionPublished,
  onCanonicalDraftStateChange,
  onCanonicalDraftSessionChange,
  onCanonicalDraftProjectionChange,
  onCanonicalDraftProjectionClear,
}: ShotTimelinePreviewProps) {
  const [editorSessionToken] = useState(createShotTimelineEditorSessionToken);
  const [currentComposition, setCurrentComposition] = useState(composition);
  const initialTimelineDataHeadRef = useRef(composition.headRevisionId);
  const suppliedCompositionIsUsable = composition.projectId.length > 0
    && composition.parentDocumentId.length > 0
    && composition.occurrences.some((candidate) => candidate.occurrenceId === occurrenceId);
  const [freshHeadStatus, setFreshHeadStatus] = useState<'loading' | 'ready' | 'error'>(
    suppliedCompositionIsUsable ? 'ready' : shotCompositionAdapter ? 'loading' : 'error',
  );
  const [mountedHeadRevisionId, setMountedHeadRevisionId] = useState(composition.headRevisionId);
  const [draftDirty, setDraftDirty] = useState(false);
  const draftDirtyRef = useRef(false);
  const draftGenerationRef = useRef(0);
  const initialFreshnessCheckRef = useRef(suppliedCompositionIsUsable);
  const draftScope = useMemo<CanonicalShotTimelineScope>(() => ({
    projectId: composition.projectId,
    parentDocumentId: composition.parentDocumentId,
    occurrenceId,
    editorSessionId: editorSessionToken,
  }), [composition.parentDocumentId, composition.projectId, editorSessionToken, occurrenceId]);
  const editorHeadStateRef = useRef<ShotTimelineEditorHeadState>({
    canonicalHeadRevisionId: composition.headRevisionId,
    displayedHeadRevisionId: composition.headRevisionId,
  });
  useEffect(() => {
    if (suppliedCompositionIsUsable) return;
    let cancelled = false;
    if (!shotCompositionAdapter) {
      setCurrentComposition(composition);
      setFreshHeadStatus('ready');
      return () => { cancelled = true; };
    }
    setFreshHeadStatus('loading');
    void shotCompositionAdapter.load({
      projectId: composition.projectId,
      parentDocumentId: composition.parentDocumentId,
    }).then((latest) => {
      if (cancelled) return;
      if (!latest || latest.projectId !== composition.projectId
        || latest.parentDocumentId !== composition.parentDocumentId) {
        setFreshHeadStatus('error');
        return;
      }
      setCurrentComposition(latest);
      setFreshHeadStatus('ready');
    }).catch(() => {
      if (!cancelled) setFreshHeadStatus('error');
    });
    return () => { cancelled = true; };
  // The immutable occurrence/document identity defines one popup opening.
  // Parent head changes during that mounted session are adopted below without
  // restarting the editor or its undo history.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotCompositionAdapter, composition.projectId, composition.parentDocumentId, occurrenceId, suppliedCompositionIsUsable]);
  useLayoutEffect(() => {
    onCanonicalDraftSessionChange?.(draftScope, true);
    return () => onCanonicalDraftSessionChange?.(draftScope, false);
  }, [draftScope, onCanonicalDraftSessionChange]);
  useEffect(() => {
    const needsInitialCheck = initialFreshnessCheckRef.current;
    if (!shotCompositionAdapter || freshHeadStatus !== 'ready' || draftDirty
      || (!needsInitialCheck && composition.headRevisionId === currentComposition.headRevisionId)) {
      return;
    }
    initialFreshnessCheckRef.current = false;
    let cancelled = false;
    // A changed parent prop is only a signal to check the canonical head. It
    // is not itself authority: it may be an older render arriving after a
    // fresh query. Re-read before replacing the clean mounted editor.
    void shotCompositionAdapter.load({
      projectId: composition.projectId,
      parentDocumentId: composition.parentDocumentId,
    }).then((latest) => {
      if (cancelled || !latest || latest.projectId !== composition.projectId
        || latest.parentDocumentId !== composition.parentDocumentId || draftDirtyRef.current) return;
      setCurrentComposition(latest);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [shotCompositionAdapter, composition.projectId, composition.parentDocumentId,
    composition.headRevisionId, currentComposition.headRevisionId, draftDirty, freshHeadStatus]);
  const projection = useMemo(() => projectShotTimeline(currentComposition, occurrenceId), [currentComposition, occurrenceId]);
  const handleCanonicalCompositionPublished = useCallback((
    published: PreparedShotComposition,
    generation: number,
    expectedHeadRevisionId: string | null,
  ) => {
    setCurrentComposition(published);
    setFreshHeadStatus('ready');
    onCanonicalCompositionPublished?.(published, {
      scope: draftScope,
      generation,
      expectedHeadRevisionId,
    });
  }, [draftScope, onCanonicalCompositionPublished]);
  const projectionConfig = projection.config;
  const hasProjectionConfig = projectionConfig !== null;
  const hardDurationMs = hardDurationMsForOccurrence(currentComposition, occurrenceId);
  const hardDurationSeconds = hardDurationMs === undefined ? undefined : hardDurationMs / 1000;
  const timelineEditability = useMemo<TimelineEditability>(() => {
    const base = createTimelineEditability({
      readOnly: shotCompositionAdapter?.publish === undefined,
      hardDurationSeconds,
    });
    const headIsCurrent = () => {
      const state = editorHeadStateRef.current;
      return Boolean(state.canonicalHeadRevisionId)
        && state.displayedHeadRevisionId === state.canonicalHeadRevisionId;
    };
    return {
      hardDurationSeconds,
      checkTimeline: () => headIsCurrent()
        ? base.check({ clipId: '', sourceTrackId: null, targetTrackId: null })
        : { allowed: false, reason: 'timeline_read_only' },
      check: (input) => headIsCurrent()
        ? base.check(input)
        : { allowed: false, reason: 'timeline_read_only' },
      checkMove: (input) => headIsCurrent()
        ? base.checkMove?.(input) ?? { allowed: true }
        : { allowed: false, reason: 'timeline_read_only' },
    };
  }, [hardDurationSeconds, shotCompositionAdapter?.publish]);
  const dataProvider = useMemo(
    () => projectionConfig
      ? createShotTimelineDataProvider(
          projectionConfig,
          currentComposition,
          occurrenceId,
          shotCompositionAdapter,
          handleCanonicalCompositionPublished,
          editorHeadStateRef,
          0,
          timelineDataProvider,
          timelineDataProvider,
        )
      : null,
    // Keep one provider/editor session. Its query identity advances with the
    // clean canonical head, so the previous head's cache cannot be reused for the new one.
    // Its initial composition is refreshed by adoptCleanBaseline below, and
    // its publish callback is refreshed by setPublishCallback on every render;
    // recreating it for either would reset query/editor/recovery identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasProjectionConfig, currentComposition.parentDocumentId,
      currentComposition.projectId, occurrenceId, shotCompositionAdapter, timelineDataProvider],
  );
  const initialTimelineData = useMemo(
    () => projectionConfig ? createShotTimelineInitialData(projectionConfig, 1, currentComposition, occurrenceId) : undefined,
    [currentComposition, occurrenceId, projectionConfig],
  );
  useEffect(() => () => { void dataProvider?.dispose().catch(() => {}); }, [dataProvider]);
  const handleActiveConfigChange = useCallback((nextConfig: ResolvedTimelineConfig) => {
    if (!dataProvider) return;
    draftDirtyRef.current = true;
    const generation = draftGenerationRef.current + 1;
    draftGenerationRef.current = generation;
    dataProvider.setDraftGeneration(generation);
    onCanonicalDraftProjectionChange?.({
      scope: draftScope,
      generation,
      composition: projectShotTimelineDraftComposition(
        currentComposition,
        occurrenceId,
        nextConfig,
      ),
    });
  }, [currentComposition, dataProvider, draftScope, occurrenceId, onCanonicalDraftProjectionChange]);
  const handleSaveStatusChange = useCallback((status: SaveStatus) => {
    const dirty = status !== 'saved';
    draftDirtyRef.current = dirty;
    dataProvider?.setDraftState(dirty);
    setDraftDirty(dirty);
    onCanonicalDraftStateChange?.(dirty);
    if (!dirty && draftGenerationRef.current > 0) {
      onCanonicalDraftProjectionClear?.(draftScope, draftGenerationRef.current);
    }
  }, [dataProvider, draftScope, onCanonicalDraftProjectionClear, onCanonicalDraftStateChange]);
  useEffect(() => {
    if (!dataProvider || !projection.config || currentComposition.headRevisionId === mountedHeadRevisionId) {
      return;
    }
    if (!dataProvider.adoptCleanBaseline(projection.config, currentComposition)) {
      return;
    }
    setMountedHeadRevisionId(currentComposition.headRevisionId);
  }, [currentComposition, dataProvider, draftDirty, mountedHeadRevisionId, projection.config]);
  dataProvider?.setPublishCallback(handleCanonicalCompositionPublished);
  const canEdit = shotCompositionAdapter?.publish !== undefined;
  const shotTimelineId = shotTimelineSessionId(currentComposition.parentDocumentId, occurrenceId, editorSessionToken);
  const persistenceBinding = useMemo(() => dataProvider?.bindLocalDocumentSave(shotTimelineId),
    [dataProvider, shotTimelineId]);
  if (freshHeadStatus === 'loading') {
    return <section data-shot-timeline-preview="true" data-shot-timeline-status="loading" aria-label="Shot timeline">Loading current shot timeline…</section>;
  }
  if (freshHeadStatus === 'error') {
    return <section data-shot-timeline-preview="true" data-shot-timeline-status="error" aria-label="Shot timeline">Could not load the current shot timeline.</section>;
  }
  if (!projection.config) {
    return (
      <section
        className="rounded-xl border border-dashed border-border bg-muted/10 p-4"
        data-shot-timeline-preview="true"
        data-shot-timeline-status="empty"
        aria-label="Shot timeline"
      >
        <div className="flex items-start gap-3 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <h2 className="font-medium text-foreground">Shot timeline</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {projection.error ?? 'No internal timeline revision is available for this shot.'}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Nothing is selected as a silent fallback; author a primary visual into the shot timeline to make it render here.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className="rounded-xl border border-border bg-card/50 p-3 shadow-sm"
      data-shot-timeline-preview="true"
      data-shot-timeline-status="ready"
      data-shot-timeline-head-revision-id={currentComposition.headRevisionId}
      aria-label="Shot timeline"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Film className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-foreground">Shot timeline</h2>
            <p className="text-[11px] text-muted-foreground">
              {canEdit ? 'Editable canonical revision · shot-local time' : 'Pinned internal timeline revision · shot-local time'}
            </p>
          </div>
        </div>
      </div>

      <TimelinePersistenceHandoffContext.Provider value={persistenceBinding}>
        <VideoEditorProvider
          dataProvider={dataProvider!}
          projectId={currentComposition.projectId}
          projectSlug={currentComposition.projectId}
          timelineId={shotTimelineId}
          timelineName="Shot timeline"
          userId={null}
          timelineEditability={timelineEditability}
          extensionHostEnabled={false}
          onSaveStatusChange={handleSaveStatusChange}
          initialTimelineData={currentComposition.headRevisionId === initialTimelineDataHeadRef.current
            ? initialTimelineData
            : undefined}
        >
          <ShotTimelineEditorSurface
            config={projection.config}
            hardDurationSeconds={hardDurationSeconds}
            editorHeadState={editorHeadStateRef}
            onActiveConfigChange={handleActiveConfigChange}
          />
        </VideoEditorProvider>
      </TimelinePersistenceHandoffContext.Provider>
    </section>
  );
}

function hardDurationMsForOccurrence(
  composition: PreparedShotComposition,
  occurrenceId: string,
): number | undefined {
  return hardDurationMs(composition.contract, occurrenceId);
}

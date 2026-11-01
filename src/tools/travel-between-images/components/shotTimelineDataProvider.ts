import {
  projectedClipCounterparts,
  verifiedRetainedRawClipIds,
} from '@/tools/video-editor/lib/serialize.ts';
import { TimelineSaveError, TimelineVersionConflictError, type DataProvider, type TimelineAcceptedIdentity, type TimelineCommandBasis } from '@/tools/video-editor/data/DataProvider.ts';
import type {
  LoadedTimeline,
} from '@/tools/video-editor/data/DataProvider.ts';
import type {
  MediaSelection,
  MediaSelectionQuery,
  VerifiedMedia,
} from '@/integrations/runtime/generated.ts';
import {
  advanceTimelineDraftBaseAfterAcknowledgement,
  clearTimelineDraftIfMatches,
  loadTimelineDraft,
  reconcileTimelineDraftHeadMarker,
  saveTimelineDraftIfOwner,
  type TimelineDraftRecoveryMetadata,
} from '@/tools/video-editor/data/timelineDraftIndexedDb.ts';
import type {
  PreparedShotComposition,
  ShotCompositionAdapter,
} from '@/tools/video-editor/data/shotCompositionAdapter.ts';
import type { ShotCompositionContract } from '@/tools/video-editor/data/shotComposition.ts';
import { StaleWriteError } from '@/tools/video-editor/data/shotComposition.ts';
import { projectCanonicalComposition } from '@/tools/video-editor/data/shotCompositionProjection.ts';
import { projectOutputTimelineConfig } from '@/tools/video-editor/data/timelineOutputProjection.ts';
import { recordShotTimelinePhase } from '@/tools/video-editor/lib/shot-timeline-timing.ts';
import {
  enqueueCanonicalShotPublish,
  hardDurationMs,
  updateCanonicalShotTimeline,
} from '@/tools/video-editor/data/shotCompositionEditor.ts';
import { createLocalSaveSession, type LocalSave, type LocalSaveSession, type LocalSaveState } from '@/tools/video-editor/commands/localSaveSession.ts';
import { bindTimelinePersistenceHandoff, type TimelinePersistenceBinding, type TimelinePersistenceHandoff } from '@/tools/video-editor/hooks/timelineLocalSaveHandoff.ts';
import type { CanonicalDocument, CommitRequest } from '@/integrations/runtime/timeline-commit-types.ts';
import { toOutboxJson, type OutboxJson } from '@/tools/video-editor/commands/commitOutbox.ts';
import type {
  ResolvedAssetRegistryEntry,
  ResolvedTimelineConfig,
  TimelineClip,
  TimelineConfig,
  TrackDefinition,
} from '@/tools/video-editor/types/index.ts';
import { timelineContentExtentMs } from '@/tools/video-editor/data/shotCompositionTiming.ts';
import { bridgeMediaUrl } from '@/shared/lib/media/bridgeMediaUrl.ts';
import { assembleTimelineData, type TimelineData } from '@/tools/video-editor/lib/timeline-data.ts';
import { buildAssetReferenceMap } from '@/tools/video-editor/lib/asset-registry.ts';

type JsonObject = Record<string, unknown>;

export type ShotTimelineMediaProvider = Pick<DataProvider,
  'supportsDirectAssetUpload'
  | 'prepareMediaImport'
> & {
  getProjectMediaSelection?(query: MediaSelectionQuery): Promise<MediaSelection>;
  getProjectVerifiedMedia?(selection: MediaSelection): Promise<VerifiedMedia>;
};

export function shotTimelineSessionId(
  parentDocumentId: string,
  occurrenceId: string,
  editorSessionToken: string,
): string {
  // Query cache identity is per popup opening; durable recovery has its own
  // stable occurrence key below and is not tied to React Query freshness.
  return `${parentDocumentId}:shot:${occurrenceId}:session:${editorSessionToken}`;
}

export function shotTimelineRecoveryId(parentDocumentId: string, occurrenceId: string): string {
  return `${parentDocumentId}:shot:${occurrenceId}`;
}

export function createShotTimelineEditorSessionToken(): string {
  // Retained as a mount-local diagnostic token; durable recovery identity is
  // deliberately independent of the popup opening.
  return globalThis.crypto?.randomUUID?.() ?? `editor-${Date.now()}`;
}

export type ShotTimelineEditorHeadState = {
  canonicalHeadRevisionId: string | null;
  displayedHeadRevisionId: string | null;
};

function headRevisionIdFromConfig(config: Pick<TimelineConfig, 'app'>): string | null {
  const app = config.app && typeof config.app === 'object' && !Array.isArray(config.app)
    ? config.app as Record<string, unknown>
    : null;
  const canonical = app?.canonicalComposition && typeof app.canonicalComposition === 'object'
    && !Array.isArray(app.canonicalComposition)
    ? app.canonicalComposition as Record<string, unknown>
    : null;
  return typeof canonical?.headRevisionId === 'string' ? canonical.headRevisionId : null;
}

function reconcileConfigHeadRevision(config: TimelineConfig, headRevisionId: string): TimelineConfig {
  const app = config.app && typeof config.app === 'object' && !Array.isArray(config.app)
    ? config.app as Record<string, unknown>
    : null;
  const canonical = app?.canonicalComposition
    && typeof app.canonicalComposition === 'object'
    && !Array.isArray(app.canonicalComposition)
    ? app.canonicalComposition as Record<string, unknown>
    : null;
  if (!app || !canonical || canonical.headRevisionId === headRevisionId) return config;
  return {
    ...config,
    app: {
      ...app,
      canonicalComposition: { ...canonical, headRevisionId },
    },
  };
}

export function shotTimelineDurationSeconds(
  config: Pick<ResolvedTimelineConfig, 'clips'>,
  hardDurationSeconds?: number,
): number {
  const contentSeconds = timelineContentExtentMs({ clips: config.clips }) / 1000;
  return hardDurationSeconds === undefined
    ? contentSeconds
    : Math.min(contentSeconds, Math.max(0, hardDurationSeconds));
}

function createShotTimelineConfig(config: ResolvedTimelineConfig): TimelineConfig {
  return {
    output: config.output,
    clips: config.clips,
    tracks: config.tracks,
    ...(config.effects !== undefined ? { effects: config.effects } : {}),
    ...(config.theme ? { theme: config.theme } : {}),
    ...(config.theme_overrides ? { theme_overrides: config.theme_overrides } : {}),
    ...(config.generation_defaults ? { generation_defaults: config.generation_defaults } : {}),
    ...(config.app ? { app: config.app } : {}),
  };
}

type ShotTimelineSource = 'projection' | 'shot-local';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function occurrenceInternalTimeline(
  composition: PreparedShotComposition,
  occurrenceId: string,
): { occurrence: PreparedShotComposition['occurrences'][number]; timeline: JsonObject } {
  const matches = composition.occurrences.filter((candidate) => candidate.occurrenceId === occurrenceId);
  if (matches.length !== 1) throw new Error('Shot popup has no unique verified occurrence binding');
  const occurrence = matches[0]!;
  const revision = composition.contract.shot_revisions.filter((candidate) => (
    candidate.shot_id === occurrence.shotId && candidate.revision_id === occurrence.revisionId
  ));
  if (revision.length !== 1 || revision[0] !== occurrence.revision) {
    throw new Error('Shot popup has no verified child revision binding');
  }
  const internal = object(occurrence.revision.internal_timeline_revision);
  if (!internal || internal.revision_id !== occurrenceInternalRevisionId(occurrence)
    || typeof internal.content_digest !== 'string') {
    throw new Error('Shot popup has no verified child timeline pin');
  }
  const timeline = object(internal.timeline);
  if (!timeline || !Array.isArray(timeline.clips) || !Array.isArray(timeline.tracks)) {
    throw new Error('Shot popup has no verified child timeline');
  }
  return { occurrence, timeline };
}

function occurrenceInternalRevisionId(occurrence: PreparedShotComposition['occurrences'][number]): string {
  const internal = object(occurrence.revision.internal_timeline_revision);
  return typeof internal?.revision_id === 'string' ? internal.revision_id : '';
}

function authoredRowApp(value: unknown): Record<string, unknown> | undefined {
  const app = object(value);
  if (!app) return undefined;
  const { group: _projectionGroup, ...authored } = app;
  return authored;
}

function shotLocalTrack(raw: unknown): TrackDefinition | null {
  const track = object(raw);
  const id = stringValue(track?.id);
  if (!track || !id) return null;
  return {
    ...track,
    id,
    kind: track.kind === 'audio' ? 'audio' : 'visual',
    label: stringValue(track.label) ?? id,
    ...(authoredRowApp(track.app) ? { app: authoredRowApp(track.app) } : {}),
  } as TrackDefinition;
}

function shotLocalClip(raw: unknown, index: number): TimelineClip {
  const source = object(raw);
  if (!source) throw new Error(`Shot popup child clip ${index} is not an object`);
  const id = stringValue(source.id);
  if (!id) throw new Error(`Shot popup child clip ${index} has no authored ID`);
  const atMs = finiteValue(source.at_ms);
  const durationMs = finiteValue(source.duration_ms);
  const duration = finiteValue(source.duration);
  const rawFrom = finiteValue(source.from);
  const rawTo = finiteValue(source.to);
  const hasTrim = rawFrom !== undefined && rawTo !== undefined && rawTo > rawFrom;
  const muted = source.muted === true || source.mute === true;
  const gain = finiteValue(source.gain ?? source.volume);
  const app = object(source.app);
  const {
    at_ms: _atMs,
    duration_ms: _durationMs,
    asset_id: _assetId,
    clip_type: _clipType,
    duration: _duration,
    gain: _gain,
    mute: _mute,
    muted: _muted,
    volume: _volume,
    ...authoredFields
  } = source;
  return {
    ...authoredFields,
    id,
    at: atMs !== undefined ? Math.max(0, atMs) / 1000 : Math.max(0, finiteValue(source.at) ?? 0),
    track: stringValue(source.track) ?? 'video',
    clipType: stringValue(source.clip_type) ?? stringValue(source.clipType) ?? 'media',
    ...(stringValue(source.asset_id) ?? stringValue(source.asset)
      ? { asset: stringValue(source.asset_id) ?? stringValue(source.asset) } : {}),
    ...(hasTrim
      ? { from: rawFrom, to: rawTo }
      : durationMs !== undefined
        ? { hold: Math.max(0, durationMs) / 1000 }
        : duration !== undefined
          ? { hold: Math.max(0, duration) }
          : {}),
    ...(muted || gain !== undefined ? { volume: muted ? 0 : gain } : {}),
    ...(app ? { app: structuredClone(app) } : {}),
  } as TimelineClip;
}

/** Read the verified child timeline directly; unlike projection, this keeps authored IDs and metadata. */
function createShotLocalTimelineConfig(
  composition: PreparedShotComposition,
  occurrenceId: string,
  fallback: TimelineConfig,
): TimelineConfig {
  const { occurrence, timeline } = occurrenceInternalTimeline(composition, occurrenceId);
  const tracks = (timeline.tracks as unknown[]).map(shotLocalTrack)
    .filter((track): track is TrackDefinition => Boolean(track));
  const clips = (timeline.clips as unknown[]).map(shotLocalClip);
  const timelineApp = object(timeline.app);
  return {
    output: fallback.output,
    clips,
    tracks,
    ...(timeline.effects !== undefined ? { effects: timeline.effects as TimelineConfig['effects'] } : {}),
    ...(timeline.theme !== undefined ? { theme: timeline.theme as TimelineConfig['theme'] } : {}),
    ...(timeline.theme_overrides !== undefined ? { theme_overrides: timeline.theme_overrides as TimelineConfig['theme_overrides'] } : {}),
    ...(timeline.generation_defaults !== undefined ? { generation_defaults: timeline.generation_defaults as TimelineConfig['generation_defaults'] } : {}),
    app: {
      ...(timelineApp ?? {}),
      canonicalComposition: {
        projectId: composition.projectId,
        parentDocumentId: composition.parentDocumentId,
        headRevisionId: composition.headRevisionId,
        occurrenceIds: [occurrence.occurrenceId],
      },
    },
  };
}

function rawChildRows(
  composition: PreparedShotComposition,
  occurrenceId: string,
  key: 'clips' | 'tracks',
): Map<string, Record<string, unknown>> {
  const { timeline } = occurrenceInternalTimeline(composition, occurrenceId);
  return collectionRows(timeline[key], [key]);
}

function timelineOccurrenceId(config: TimelineConfig, composition: PreparedShotComposition): string {
  const app = object(config.app);
  const canonical = object(app?.canonicalComposition);
  const configured = Array.isArray(canonical?.occurrenceIds) ? canonical.occurrenceIds : [];
  if (configured.length === 1 && typeof configured[0] === 'string') return configured[0];
  for (const occurrence of composition.occurrences) {
    const raw = rawChildRows(composition, occurrence.occurrenceId, 'clips');
    if (config.clips.some((clip) => raw.has(clip.id))) return occurrence.occurrenceId;
  }
  return composition.occurrences[0]?.occurrenceId ?? '';
}

function timelineSource(
  config: TimelineConfig,
  composition: PreparedShotComposition,
  occurrenceId: string,
): ShotTimelineSource {
  const raw = rawChildRows(composition, occurrenceId, 'clips');
  const projectedIdPrefix = `${occurrenceId}:`;
  const hasExplicitProjectedClip = config.clips.some((clip) => clip.id.startsWith(projectedIdPrefix));
  if (!hasExplicitProjectedClip && config.clips.some((clip) => raw.has(clip.id))) return 'shot-local';
  const projected = projectedClipCounterparts(composition, config.clips);
  if (config.clips.some((clip) => projected.has(clip.id))) return 'projection';
  if (config.clips.some((clip) => raw.has(clip.id))) return 'shot-local';
  const prefix = `${occurrenceId}~`;
  if ((config.tracks ?? []).some((track) => track.id.startsWith(prefix))) return 'projection';
  return 'shot-local';
}

function authoredTracks(
  tracks: TrackDefinition[],
  composition: PreparedShotComposition,
  occurrenceId: string,
): TrackDefinition[] {
  const rawTracks = rawChildRows(composition, occurrenceId, 'tracks');
  const prefix = `${occurrenceId}~`;
  return tracks.map((track) => {
    const localId = rawTracks.has(track.id) ? track.id
      : track.id.startsWith(prefix) && rawTracks.has(track.id.slice(prefix.length))
        ? track.id.slice(prefix.length) : track.id;
    const app = authoredRowApp(track.app);
    return { ...track, id: localId, ...(app ? { app } : {}) };
  });
}

function authoredClipFields(clip: TimelineClip, occurrenceId: string): TimelineClip {
  const prefix = `${occurrenceId}~`;
  const app = object(clip.app);
  const authoredApp = authoredRowApp(app);
  return {
    ...clip,
    track: clip.track.startsWith(prefix) ? clip.track.slice(prefix.length) : clip.track,
    ...(authoredApp ? { app: authoredApp } : {}),
  };
}

function stripProjectedClipFields(
  clip: TimelineClip,
  raw: Record<string, unknown> | null,
): TimelineClip {
  const app = object(clip.app);
  const rawApp = object(raw?.app);
  const authoredApp = app ? { ...app } : undefined;
  if (authoredApp) {
    for (const key of ['canonical', 'canonicalTiming', 'canonicalEffects']) {
      if (rawApp && own(rawApp, key) && key !== 'canonicalEffects') {
        Object.defineProperty(authoredApp, key, {
          value: structuredClone(rawApp[key]),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else {
        Reflect.deleteProperty(authoredApp, key);
      }
    }
  }
  const { assetEntry: _assetEntry, app: _app, ...persistedClip } = clip as typeof clip & { assetEntry?: unknown };
  return {
    ...persistedClip,
    ...(authoredApp && Object.keys(authoredApp).length > 0 ? { app: authoredApp } : {}),
  };
}
/** Render child Source visuals and inherited effects without changing authored editor data. */
export function projectShotTimelineRenderConfig(config: ResolvedTimelineConfig): ResolvedTimelineConfig {
  const { effects, ...local } = config;
  return projectOutputTimelineConfig({
    ...local,
    tracks: config.tracks.map((track) => track.kind !== 'audio' && track.role === 'source'
      ? { ...track, role: 'output' }
      : track),
    clips: config.clips.map((clip) => Array.isArray(effects) && effects.length > 0
      ? { ...clip, effects: [...(Array.isArray(clip.effects) ? clip.effects : []), ...effects] }
      : clip),
  }).config;
}

/** Build first-render editor data from the already-resolved parent projection. */
export function createShotTimelineInitialData(
  config: ResolvedTimelineConfig,
  configVersion = 1,
  composition?: PreparedShotComposition,
  occurrenceId?: string,
): TimelineData {
  const registry = {
    assets: Object.fromEntries(Object.entries(config.registry).map(([assetId, entry]) => ([assetId, {
      ...entry,
      file: entry.file ?? entry.media_id ?? entry.url,
    }]))),
  };
  const projectedConfig = createShotTimelineConfig(config);
  const timelineConfig = composition && occurrenceId
    ? createShotLocalTimelineConfig(composition, occurrenceId, projectedConfig)
    : projectedConfig;
  const resolvedConfig = composition && occurrenceId
    ? {
        ...config,
        ...timelineConfig,
        clips: timelineConfig.clips.map((clip) => ({
          ...clip,
          ...(clip.asset && config.registry[clip.asset]
            ? { assetEntry: config.registry[clip.asset] }
            : {}),
        })),
        tracks: timelineConfig.tracks ?? [],
      }
    : config;
  return assembleTimelineData({
    config: timelineConfig,
    configVersion,
    registry,
    resolvedConfig,
    output: config.output,
    assetMap: buildAssetReferenceMap(registry),
  });
}

function createCanonicalTimeline(
  config: TimelineConfig,
  composition: PreparedShotComposition,
  source: ShotTimelineSource = timelineSource(config, composition, timelineOccurrenceId(config, composition)),
): Record<string, unknown> {
  const occurrenceId = timelineOccurrenceId(config, composition);
  const retainedRawClipIds = verifiedRetainedRawClipIds(composition);
  const projectedCounterparts = projectedClipCounterparts(composition, config.clips);
  const counterparts = source === 'shot-local'
    ? rawChildRows(composition, occurrenceId, 'clips')
    : projectedCounterparts;
  if (source === 'projection') {
    for (const clip of config.clips) {
      if (retainedRawClipIds.has(clip.id)) {
        throw new Error(`The shot draft clip ${clip.id} collides with a retained raw clip ID; keep the draft`);
      }
    }
  }
  const clips = (config.clips ?? []).map((editorClip) => {
    // Apply to existing and newly authored clips on every save path, before
    // restoring identity and app collisions from the verified child bytes.
    const projectedClip = authoredClipFields(editorClip, occurrenceId);
    const raw = counterparts.get(projectedClip.id) ?? null;
    // A clip absent from the verified identity map is a newly authored editor
    // clip (existing projected clips are present with either a raw match or a
    // null value when their identity is ambiguous). Keep it intact so popup
    // add remains a normal authoring operation.
    if (!raw && counterparts.has(projectedClip.id)) {
      throw new Error('The shot draft has no unambiguous raw clip counterpart');
    }
    const clip = stripProjectedClipFields(
      raw ? { ...projectedClip, id: String(raw.id) } : projectedClip,
      raw,
    );
    if (!raw) {
      return clip;
    }
    const rawApp = raw.app as Record<string, unknown> | undefined;
    const app = clip.app && typeof clip.app === 'object' && !Array.isArray(clip.app)
      ? { ...clip.app } : clip.app;
    if (app) {
      for (const key of ['canonical', 'canonicalTiming']) {
        if (rawApp && Object.prototype.hasOwnProperty.call(rawApp, key)) {
          Object.defineProperty(app, key, { value: structuredClone(rawApp[key]),
            enumerable: true, configurable: true, writable: true });
        } else Reflect.deleteProperty(app, key);
      }
    }
    return {
      ...clip,
      id: String(raw.id),
      ...(app && typeof app === 'object' ? { app } : {}),
    };
  });
  const app = object(config.app);
  const authoredApp = app
    ? Object.fromEntries(Object.entries(app).filter(([key]) => key !== 'canonicalComposition' && key !== 'visualSeamContract'))
    : undefined;
  return {
    tracks: authoredTracks(config.tracks ?? [], composition, occurrenceId),
    clips,
    ...(config.effects !== undefined ? { effects: config.effects } : {}),
    ...(config.theme ? { theme: config.theme } : {}),
    ...(config.theme_overrides ? { theme_overrides: config.theme_overrides } : {}),
    ...(config.generation_defaults ? { generation_defaults: config.generation_defaults } : {}),
    ...(authoredApp && Object.keys(authoredApp).length > 0 ? { app: authoredApp } : {}),
  };
}

function restoreRawAppCollisionsInRecoveryDraft(
  config: TimelineConfig,
  composition: PreparedShotComposition,
): TimelineConfig {
  const occurrenceId = timelineOccurrenceId(config, composition);
  const counterparts = projectedClipCounterparts(composition, config.clips);
  return {
    ...config,
    // Recovery is durable editor data too. Keep the authored track fields and
    // raw app metadata, but never retain the projection's occurrence prefix or
    // its group hint in the child timeline draft.
    tracks: authoredTracks(config.tracks ?? [], composition, occurrenceId),
    clips: config.clips.map((editorClip) => {
      const projectedClip = authoredClipFields(editorClip, occurrenceId);
      const raw = counterparts.get(projectedClip.id) ?? null;
      return stripProjectedClipFields(
        raw ? { ...projectedClip, id: String(raw.id) } : projectedClip,
        raw,
      );
    }),
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeHeadForSignature(
  timeline: Record<string, unknown>,
  headRevisionId: string,
): Record<string, unknown> {
  const app = timeline.app && typeof timeline.app === 'object' && !Array.isArray(timeline.app)
    ? timeline.app as Record<string, unknown>
    : null;
  const canonical = app?.canonicalComposition
    && typeof app.canonicalComposition === 'object'
    && !Array.isArray(app.canonicalComposition)
    ? app.canonicalComposition as Record<string, unknown>
    : null;
  if (!app || !canonical) return timeline;
  return {
    ...timeline,
    app: {
      ...app,
      canonicalComposition: { ...canonical, headRevisionId },
    },
  };
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type PendingCanonicalPublication = {
  configSignature: string;
  expectedHeadRevisionId: string;
  idempotencyKey: string;
  graph: ShotCompositionContract;
};

type ShotTimelineDataProvider = DataProvider & {
  getProjectMediaSelection?: (query: MediaSelectionQuery) => Promise<MediaSelection>;
  getProjectVerifiedMedia?: (selection: MediaSelection) => Promise<VerifiedMedia>;
  localDocumentSave?: TimelinePersistenceHandoff;
  bindLocalDocumentSave(timelineId: string): TimelinePersistenceBinding | undefined;
  timelineQueryIdentity: string;
  setPublishCallback: (callback?: (
    composition: PreparedShotComposition,
    generation: number,
    expectedHeadRevisionId: string | null,
  ) => void) => void;
  setDraftState: (dirty: boolean) => void;
  setDraftGeneration: (generation: number) => PreparedShotComposition;
  adoptCleanBaseline: (config: ResolvedTimelineConfig, composition: PreparedShotComposition) => boolean;
  getLocalSaveState: () => Promise<LocalSaveState | null>;
  recoverLocalSaves: (ownerId: string) => Promise<void>;
  dispose: () => Promise<void>;
};

type PopupLocalSaveProvider = Pick<DataProvider,
  'loadTimelineCommandBasis' | 'getRecoverableIdentity' | 'commitTimeline'> & Partial<ShotTimelineMediaProvider>;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function mergeAuthoredValue(raw: unknown, authored: unknown, baseline: unknown): unknown {
  if (sameJson(authored, baseline)) return structuredClone(raw);
  if (authored === null || authored === undefined || Array.isArray(authored)
    || typeof authored !== 'object') return authored;
  const rawObject = object(raw);
  const result: Record<string, unknown> = rawObject ? structuredClone(rawObject) : {};
  const next = object(authored)!;
  const previous = object(baseline);
  for (const key of new Set([...Object.keys(previous ?? {}), ...Object.keys(next)])) {
    if (!own(next, key)) continue;
    if (!own(previous, key) || !sameJson(next[key], previous?.[key])) {
      Object.defineProperty(result, key, { value: mergeAuthoredValue(rawObject?.[key], next[key], previous?.[key]),
        enumerable: true, writable: true, configurable: true });
    }
  }
  return result;
}

function mergeAuthoredRegistry(raw: unknown, authored: unknown, baseline: unknown): unknown {
  const result = object(mergeAuthoredValue(raw, authored, baseline));
  const assets = object(result?.assets);
  const previous = object(object(baseline)?.assets);
  const next = object(object(authored)?.assets);
  if (assets && previous && next) {
    for (const id of Object.keys(previous)) {
      if (!own(next, id)) Reflect.deleteProperty(assets, id);
    }
  }
  return result;
}

function registryValue(document: CanonicalDocument, timeline: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(timeline, 'registry')) return timeline.registry;
  const parent = object(document.parent_revision.payload);
  if (parent && Object.prototype.hasOwnProperty.call(parent, 'registry')) return parent.registry;
  return object(parent?.config)?.registry;
}

function mergeAuthoredRows(
  raw: unknown,
  authored: unknown,
  baseline: unknown,
  key: 'clips' | 'tracks',
): OutboxJson[] {
  if (!Array.isArray(raw) || !Array.isArray(authored)) {
    throw new Error(`Popup save requires the verified child ${key} collection`);
  }
  const rawRows = collectionRows(raw, [key]);
  const previousRows = collectionRows(baseline, [key]);
  if ([...previousRows.keys()].some((id) => !rawRows.has(id))) {
    throw new Error('Popup original projection has no exact raw row binding');
  }
  const authoredRows = authored.map((value) => object(value));
  if (authoredRows.some((value) => !value || typeof value.id !== 'string')) {
    throw new Error(`Popup ${key} rows require stable authored IDs`);
  }
  const result = authoredRows.map((value) => {
    const authoredRow = value!;
    const id = authoredRow.id as string;
    const rawRow = rawRows.get(id);
    if (rawRow && !previousRows.has(id)) throw new Error('Popup authored ID collides with an omitted raw row');
    const merged = rawRow ? object(mergeAuthoredValue(rawRow, authoredRow, previousRows.get(id)))! : authoredRow;
    if (key === 'clips' && rawRow && own(rawRow, 'asset_id')
      && !sameJson(authoredRow.asset, previousRows.get(id)?.asset)) {
      merged.asset_id = authoredRow.asset;
      if (!own(rawRow, 'asset')) Reflect.deleteProperty(merged, 'asset');
    }
    return toOutboxJson(merged);
  });
  // A projection can omit foreign rows. Only rows visible in the previous
  // editor document can be deliberately removed by this edit.
  for (const [id, row] of [...rawRows].reverse()) {
    if (previousRows.has(id) || authoredRows.some((value) => value!.id === id)) continue;
    const following = [...rawRows.keys()].slice([...rawRows.keys()].indexOf(id) + 1);
    const index = result.findIndex((value) => following.includes(String(object(value)?.id)));
    result.splice(index < 0 ? result.length : index, 0, toOutboxJson(row));
  }
  return result;
}

type PopupDocumentEdit = {
  document: CanonicalDocument;
  reads: OutboxJson[];
  roots: Array<{ ref: 'parent' | `internal-revision:${string}`; revisionId: string; contentDigest: string }>;
};

function popupDocumentAfter(
  before: CanonicalDocument,
  nextConfig: TimelineConfig,
  baselineConfig: TimelineConfig,
  nextRegistry: unknown,
  baselineRegistry: unknown,
  composition: PreparedShotComposition,
  occurrenceId: string,
): PopupDocumentEdit {
  const document = structuredClone(before);
  const parent = object(document.parent_revision.payload);
  const occurrences = Array.isArray(parent?.occurrences) ? parent.occurrences : [];
  const matched = occurrences.filter((value) => object(value)?.occurrence_id === occurrenceId);
  const occurrenceRecord = matched.length === 1 ? object(matched[0]) : null;
  if (!occurrenceRecord) throw new Error('Popup save has no unique physical occurrence binding');
  const owners = occurrences.map((value) => {
    const row = object(value);
    const shots = document.shot_revisions.filter((image) => image.shot_id === row?.shot_id
      && image.revision_id === row?.shot_revision_id);
    if (shots.length !== 1) throw new Error('Popup save has no unique child shot revision binding');
    const shot = shots[0];
    const pins = document.dependency_manifest.shots.filter((pin) => pin.revision_id === shot.revision_id);
    if (pins.length !== 1 || pins[0].shot_id !== shot.shot_id
      || pins[0].content_digest !== shot.content_digest
      || pins[0].internal_timeline_revision_id !== shot.internal_timeline_revision_id
      || (own(object(shot.payload), 'internal_timeline_revision_id')
        && object(shot.payload)!.internal_timeline_revision_id !== shot.internal_timeline_revision_id)) {
      throw new Error('Popup save has an inconsistent child shot pin');
    }
    return { row: row!, shot };
  });
  const shot = owners.find((owner) => owner.row === occurrenceRecord)!.shot;
  const internals = document.internal_timeline_revisions.filter((image) => image.revision_id === shot.internal_timeline_revision_id);
  if (internals.length !== 1) throw new Error('Popup save has no unique child timeline root binding');
  const internal = internals[0];
  const pins = document.dependency_manifest.internal_timelines.filter((pin) => pin.revision_id === internal.revision_id);
  if (pins.length !== 1 || pins[0].timeline_id !== internal.timeline_id || pins[0].content_digest !== internal.content_digest) {
    throw new Error('Popup save has an inconsistent child timeline pin');
  }
  if (owners.filter((owner) => owner.shot.internal_timeline_revision_id === internal.revision_id).length !== 1) {
    throw new Error('Popup occurrence isolation requires a registered per-occurrence fork before editing a shared internal revision');
  }
  const displayedOccurrence = composition.occurrences.find((value) => value.occurrenceId === occurrenceId);
  const displayedInternal = object(displayedOccurrence?.revision.internal_timeline_revision);
  if (displayedOccurrence?.shotId !== shot.shot_id || displayedOccurrence.revisionId !== shot.revision_id
    || displayedInternal?.revision_id !== internal.revision_id || displayedInternal.content_digest !== internal.content_digest) {
    throw new Error('Popup displayed occurrence differs from its verified physical closure pin');
  }
  const rawTimeline = object(internal.payload);
  if (!rawTimeline) throw new Error('Popup save has no verified raw child timeline');

  // This is the existing graph identity join. It restores raw clip IDs/app
  // collisions from the retained closure instead of guessing from display IDs.
  const authoredTimeline = createCanonicalTimeline(nextConfig, composition);
  const baselineTimeline = createCanonicalTimeline(baselineConfig, composition);
  const nextTimeline: Record<string, unknown> = {
    ...object(mergeAuthoredValue(rawTimeline,
      Object.fromEntries(Object.entries(authoredTimeline).filter(([key]) => !['clips', 'tracks'].includes(key))),
      Object.fromEntries(Object.entries(baselineTimeline).filter(([key]) => !['clips', 'tracks'].includes(key))))),
    clips: mergeAuthoredRows(rawTimeline.clips, authoredTimeline.clips, baselineTimeline.clips, 'clips'),
    tracks: mergeAuthoredRows(rawTimeline.tracks, authoredTimeline.tracks, baselineTimeline.tracks, 'tracks'),
  };
  internal.payload = nextTimeline as typeof internal.payload;
  const roots: PopupDocumentEdit['roots'] = [{
    ref: `internal-revision:${internal.revision_id}`,
    revisionId: internal.revision_id,
    contentDigest: internal.content_digest,
  }];
  if (nextRegistry !== undefined && !sameJson(nextRegistry, registryValue(before, rawTimeline))) {
    const parentPayload = object(document.parent_revision.payload);
    const childRegistry = object(rawTimeline.registry);
    if (own(rawTimeline, 'registry')) {
      if (!childRegistry) throw new Error('Popup registry edit has no authored registry object at the verified child root');
      nextTimeline.registry = mergeAuthoredRegistry(childRegistry, nextRegistry, baselineRegistry);
    } else if (parentPayload && Object.prototype.hasOwnProperty.call(parentPayload, 'registry')) {
      const mirror = object(parentPayload.config);
      if (own(mirror, 'registry') && !sameJson(mirror!.registry, parentPayload.registry)) {
        throw new Error('Popup registry edit has contradictory parent mirrors');
      }
      parentPayload.registry = mergeAuthoredRegistry(parentPayload.registry, nextRegistry, baselineRegistry);
      const config = object(parentPayload.config);
      if (config && Object.prototype.hasOwnProperty.call(config, 'registry')) {
        config.registry = structuredClone(parentPayload.registry);
      }
      roots.push({ ref: 'parent', revisionId: document.parent_revision.revision_id,
        contentDigest: document.parent_revision.content_digest });
    } else {
      const config = object(parentPayload?.config);
      if (!config || !Object.prototype.hasOwnProperty.call(config, 'registry')) {
        throw new Error('Popup asset registry changes lack a verified registry root');
      }
      config.registry = mergeAuthoredRegistry(config.registry, nextRegistry, baselineRegistry);
      roots.push({ ref: 'parent', revisionId: document.parent_revision.revision_id,
        contentDigest: document.parent_revision.content_digest });
    }
  }
  return {
    document,
    roots,
    // Ownership was consulted in addition to the authored child. Guard the
    // exact pin paths so a newly shared image cannot receive a local edit.
    reads: toOutboxJson([
      { kind: 'field', ref: 'parent', path: ['occurrences'], state: tagged(parent!.occurrences, true) },
      ...owners.map((owner) => ({ kind: 'field', ref: `shot-revision:${owner.shot.revision_id}`,
        path: ['internal_timeline_revision_id'], state: tagged(object(owner.shot.payload)?.internal_timeline_revision_id,
          own(object(owner.shot.payload), 'internal_timeline_revision_id')) })),
      ...roots.map((root) => ({ kind: 'scope', ref: root.ref, path: [] })),
    ]) as OutboxJson[],
  };
}

type PopupPatchChange = Record<string, unknown>;

function tagged(value: unknown, present: boolean): PopupPatchChange {
  return present ? { state: 'present', value: toOutboxJson(value) } : { state: 'absent' };
}

function own(value: Record<string, unknown> | null, key: string): boolean {
  return value !== null && Object.prototype.hasOwnProperty.call(value, key);
}

function collectionRows(value: unknown, path: string[]): Map<string, Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`Popup patch requires an identified collection at ${path.join('/')}`);
  const rows = new Map<string, Record<string, unknown>>();
  for (const item of value) {
    const row = object(item);
    if (!row || typeof row.id !== 'string' || rows.has(row.id)) {
      throw new Error(`Popup patch requires unique row IDs at ${path.join('/')}`);
    }
    rows.set(row.id, row);
  }
  return rows;
}

function appendPopupDiff(
  ref: string,
  oldValue: unknown,
  nextValue: unknown,
  oldPresent: boolean,
  nextPresent: boolean,
  path: string[],
  changes: PopupPatchChange[],
  created: string[],
  owner: string,
  skipRegistryMirror = false,
): void {
  if (oldPresent && nextPresent && sameJson(oldValue, nextValue)) return;
  if (skipRegistryMirror && path[0] === 'config' && path[1] === 'registry') return;
  const identityCollection = (path.length === 1 && (path[0] === 'clips' || path[0] === 'tracks'));
  if (identityCollection) {
    const oldRows = collectionRows(oldValue, path);
    const nextRows = collectionRows(nextValue, path);
    let order = [...oldRows.keys()];
    for (const [id, value] of oldRows) {
      if (nextRows.has(id)) continue;
      changes.push({ op: 'list.remove', ref, path, id, before: tagged(value, true), order_before: [...order] });
      order = order.filter((candidate) => candidate !== id);
    }
    let anchor: string | null = null;
    for (const [id, value] of nextRows) {
      if (!oldRows.has(id)) {
        changes.push({ op: 'list.insert', ref, path, id, before: tagged(undefined, false),
          order_before: [...order], after_id: anchor, value: toOutboxJson(value) });
        order.splice(anchor === null ? 0 : order.indexOf(anchor) + 1, 0, id);
        created.push(`${owner}/${path[0] === 'clips' ? 'clip' : 'track'}:${id}`);
      } else if (order[anchor === null ? 0 : order.indexOf(anchor) + 1] !== id) {
        changes.push({ op: 'list.move', ref, path, id, before: tagged(oldRows.get(id), true),
          order_before: [...order], after_id: anchor });
        order = order.filter((candidate) => candidate !== id);
        order.splice(anchor === null ? 0 : order.indexOf(anchor) + 1, 0, id);
      }
      anchor = id;
    }
    for (const [id, value] of nextRows) {
      if (oldRows.has(id)) appendPopupDiff(ref, oldRows.get(id), value, true, true,
        [...path, `id:${id}`], changes, created, owner, skipRegistryMirror);
    }
    return;
  }
  const oldObject = oldPresent ? object(oldValue) : null;
  const nextObject = nextPresent ? object(nextValue) : null;
  if (nextObject && path.at(-2) === 'registry' && path.at(-1) === 'assets') {
    for (const key of Object.keys(nextObject)) {
      if (!own(oldObject, key)) created.push(`${owner}/asset:${key}`);
    }
  }
  if (oldObject && nextObject) {
    for (const key of new Set([...Object.keys(oldObject), ...Object.keys(nextObject)])) {
      appendPopupDiff(ref, oldObject[key], nextObject[key], own(oldObject, key), own(nextObject, key),
        [...path, key], changes, created, owner, skipRegistryMirror);
    }
    return;
  }
  if (path.length === 0) throw new Error(`Popup patch cannot replace the ${ref} payload root`);
  changes.push(nextPresent
    ? { op: 'set', ref, path, before: tagged(oldValue, oldPresent), value: toOutboxJson(nextValue) }
    : { op: 'remove', ref, path, before: tagged(oldValue, oldPresent) });
}

function popupDocumentPatchIntent(
  before: CanonicalDocument,
  edit: PopupDocumentEdit,
  occurrenceId: string,
  label: string,
  step: { id: string; label: string; intent: string; tags: string[] },
  head: TimelineAcceptedIdentity,
): OutboxJson {
  const beforeJson = toOutboxJson(before);
  const afterJson = toOutboxJson(edit.document);
  const beforeShell = structuredClone(before);
  const afterShell = structuredClone(edit.document);
  for (const image of [beforeShell.parent_revision, ...beforeShell.shot_revisions, ...beforeShell.internal_timeline_revisions]) image.payload = {};
  for (const image of [afterShell.parent_revision, ...afterShell.shot_revisions, ...afterShell.internal_timeline_revisions]) image.payload = {};
  if (!sameJson(beforeShell, afterShell)) throw new Error('Popup save changed a canonical wrapper or closure pin');
  const beforeParent = object(before.parent_revision.payload);
  const afterParent = object(edit.document.parent_revision.payload);
  if (!beforeParent || !afterParent || !sameJson(beforeParent.occurrences, afterParent.occurrences)) {
    throw new Error('Popup save changed provider-managed occurrence membership');
  }
  const changes: PopupPatchChange[] = [];
  const created: string[] = [];
  for (const root of edit.roots) {
    const beforeImage = root.ref === 'parent'
      ? before.parent_revision
      : before.internal_timeline_revisions.find((candidate) => candidate.revision_id === root.revisionId);
    const afterImage = root.ref === 'parent'
      ? edit.document.parent_revision
      : edit.document.internal_timeline_revisions.find((candidate) => candidate.revision_id === root.revisionId);
    if (!beforeImage || !afterImage || beforeImage.content_digest !== root.contentDigest
      || afterImage.content_digest !== root.contentDigest) {
      throw new Error('Popup save lost its original physical root binding');
    }
    const owner = root.ref === 'parent' ? 'parent' : `occurrence:${occurrenceId}`;
    const parentPayload = root.ref === 'parent' ? object(beforeImage.payload) : null;
    const skipRegistryMirror = Boolean(parentPayload
      && own(parentPayload, 'registry')
      && own(object(parentPayload.config), 'registry'));
    appendPopupDiff(root.ref, beforeImage.payload, afterImage.payload, true, true, [], changes, created,
      owner, skipRegistryMirror);
  }
  if (!changes.length) throw new Error('Popup save has no authored changes');
  return toOutboxJson({ kind: 'document-patch-intent', basis: { head }, before: beforeJson, after: afterJson, roots: edit.roots, label, step: { ...step, reads: edit.reads }, changes, created, merge: 'atomic', reads: edit.reads });
}

function hasPopupStructuralChange(before: CanonicalDocument, after: CanonicalDocument): boolean {
  const mediaIdentity = (row: Record<string, unknown>): unknown => {
    for (const key of ['asset', 'asset_id', 'source_uuid', 'media_id', 'object_id', 'file']) {
      if (own(row, key)) return row[key];
    }
    return undefined;
  };
  const arraysChanged = (key: 'clips' | 'tracks') => before.internal_timeline_revisions.some((beforeInternal) => {
    const afterInternal = after.internal_timeline_revisions.find((candidate) => (
      candidate.revision_id === beforeInternal.revision_id));
    const oldRows = Array.isArray(object(beforeInternal.payload)?.[key])
      ? (object(beforeInternal.payload)![key] as Array<Record<string, unknown>>).map((row) => row.id)
      : [];
    const nextRows = Array.isArray(object(afterInternal?.payload)?.[key])
      ? (object(afterInternal?.payload)![key] as Array<Record<string, unknown>>).map((row) => row.id)
      : [];
    return !sameJson(oldRows, nextRows);
  });
  const mediaChanged = before.internal_timeline_revisions.some((beforeInternal) => {
    const afterInternal = after.internal_timeline_revisions.find((candidate) => (
      candidate.revision_id === beforeInternal.revision_id));
    const oldRows = object(beforeInternal.payload)?.clips;
    const nextRows = object(afterInternal?.payload)?.clips;
    if (!Array.isArray(oldRows) || !Array.isArray(nextRows)) return false;
    const nextById = new Map(nextRows.map((row) => [object(row)?.id, object(row)]));
    return oldRows.some((row) => {
      const oldRow = object(row);
      const nextRow = oldRow?.id === undefined ? undefined : nextById.get(oldRow.id);
      return oldRow && nextRow && !sameJson(mediaIdentity(oldRow), mediaIdentity(nextRow));
    });
  });
  const beforeParent = object(before.parent_revision.payload);
  const afterParent = object(after.parent_revision.payload);
  const registryChanged = before.internal_timeline_revisions.some((beforeInternal) => {
    const afterInternal = after.internal_timeline_revisions.find((candidate) => (
      candidate.revision_id === beforeInternal.revision_id));
    return !sameJson(object(beforeInternal.payload)?.registry, object(afterInternal?.payload)?.registry);
  });
  return arraysChanged('clips') || arraysChanged('tracks')
    || mediaChanged
    || !sameJson(beforeParent?.registry, afterParent?.registry)
    || !sameJson(object(beforeParent?.config)?.registry, object(afterParent?.config)?.registry)
    || registryChanged;
}

type SharedPopupMediaCommands = {
  commands: CommitRequest['commands'];
};

function mediaAssetId(row: Record<string, unknown>): string | null {
  const value = row.asset ?? row.asset_id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function mediaSelectionIdentity(registry: unknown, asset: string): { generationId: string; variantId: string } | null {
  const entry = object(object(registry)?.assets)?.[asset];
  const generationId = object(entry)?.generation_id ?? object(entry)?.generationId;
  const variantId = object(entry)?.variant_id ?? object(entry)?.variantId;
  return typeof generationId === 'string' && typeof variantId === 'string'
    ? { generationId, variantId }
    : null;
}

function registryAssets(registry: unknown): Record<string, unknown> | null {
  const value = object(registry);
  return object(value?.assets) ?? value;
}

function mediaRowWithoutAsset(row: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(row);
  delete result.asset;
  delete result.asset_id;
  delete result.assetEntry;
  if (result.clipType === undefined && result.clip_type !== undefined) {
    result.clipType = result.clip_type;
  }
  delete result.clip_type;
  return result;
}

async function projectMediaSelection(
  provider: PopupLocalSaveProvider,
  projectId: string,
  asset: string,
  registry: unknown,
): Promise<MediaSelection> {
  const entry = object(object(registry)?.assets)?.[asset];
  const generationId = object(entry)?.generation_id ?? object(entry)?.generationId;
  const variantId = object(entry)?.variant_id ?? object(entry)?.variantId;
  if (typeof generationId !== 'string' || typeof variantId !== 'string') {
    throw new Error('Shared popup media requires the Runtime selection identity for the chosen asset');
  }
  const reader = provider.getProjectMediaSelection?.bind(provider);
  if (!reader) throw new Error('Shared popup media requires the existing Runtime selection reader');
  const query = { asset, generation_id: generationId, variant_id: variantId };
  const selected = reader.length >= 2
    ? await (reader as unknown as (project: string, value: MediaSelectionQuery) => Promise<MediaSelection>)(projectId, query)
    : await reader(query);
  if (selected.asset !== asset || selected.generation_id !== generationId || selected.variant_id !== variantId) {
    throw new Error('Runtime returned a mismatched popup media selection');
  }
  return selected;
}

/**
 * A shared child cannot accept a raw patch: the fork must be the first command
 * in the same durable request, and the registered media command then resolves
 * against the newly materialized occurrence owner.
 */
async function sharedPopupMediaCommands(
  before: CanonicalDocument,
  nextConfig: TimelineConfig,
  nextRegistry: unknown,
  baselineRegistry: unknown,
  composition: PreparedShotComposition,
  occurrenceId: string,
  mediaProvider: PopupLocalSaveProvider,
): Promise<SharedPopupMediaCommands | null> {
  const parent = object(before.parent_revision.payload);
  const occurrences = Array.isArray(parent?.occurrences) ? parent.occurrences : [];
  const matched = occurrences.filter((value) => object(value)?.occurrence_id === occurrenceId);
  const occurrenceRecord = matched.length === 1 ? object(matched[0]) : null;
  if (!occurrenceRecord) throw new Error('Popup save has no unique physical occurrence binding');
  const owners = occurrences.map((value) => {
    const row = object(value);
    const shots = before.shot_revisions.filter((candidate) => candidate.shot_id === row?.shot_id
      && candidate.revision_id === row?.shot_revision_id);
    if (shots.length !== 1) throw new Error('Popup save has no unique child shot revision binding');
    const shot = shots[0];
    const pins = before.dependency_manifest.shots.filter((pin) => pin.revision_id === shot.revision_id);
    if (pins.length !== 1 || pins[0].shot_id !== shot.shot_id
      || pins[0].content_digest !== shot.content_digest
      || pins[0].internal_timeline_revision_id !== shot.internal_timeline_revision_id
      || (own(object(shot.payload), 'internal_timeline_revision_id')
        && object(shot.payload)!.internal_timeline_revision_id !== shot.internal_timeline_revision_id)) {
      throw new Error('Popup save has an inconsistent child shot pin');
    }
    return { row: row!, shot };
  });
  const shot = owners.find((owner) => owner.row === occurrenceRecord)?.shot;
  if (!shot) throw new Error('Popup save has no unique child shot revision binding');
  const internal = before.internal_timeline_revisions.filter((candidate) => (
    candidate.revision_id === shot.internal_timeline_revision_id));
  if (internal.length !== 1) throw new Error('Popup save has no unique child timeline root binding');
  const pins = before.dependency_manifest.internal_timelines.filter((pin) => pin.revision_id === internal[0].revision_id);
  if (pins.length !== 1 || pins[0].timeline_id !== internal[0].timeline_id
    || pins[0].content_digest !== internal[0].content_digest) {
    throw new Error('Popup save has an inconsistent child timeline pin');
  }
  const shared = Array.isArray(parent?.occurrences) && parent.occurrences.filter((value) => {
    const row = object(value);
    return row?.shot_revision_id !== undefined && before.shot_revisions.some((candidate) => (
      candidate.shot_id === row?.shot_id && candidate.revision_id === row?.shot_revision_id
        && candidate.internal_timeline_revision_id === internal[0].revision_id));
  }).length > 1;
  const displayed = composition.occurrences.find((candidate) => candidate.occurrenceId === occurrenceId);
  if (!displayed || displayed.shotId !== shot.shot_id || displayed.revisionId !== shot.revision_id
    || object(displayed.revision.internal_timeline_revision)?.revision_id !== internal[0].revision_id
    || object(displayed.revision.internal_timeline_revision)?.content_digest !== internal[0].content_digest) {
    throw new Error('Popup displayed occurrence differs from its verified physical closure pin');
  }
  if (shared && !mediaProvider.getProjectMediaSelection) {
    throw new Error('Popup occurrence isolation requires a registered per-occurrence fork before editing the shared image');
  }
  const rawTimeline = object(internal[0].payload);
  if (!rawTimeline || !Array.isArray(rawTimeline.clips) || !Array.isArray(rawTimeline.tracks)) {
    throw new Error('Popup save has no verified raw child timeline');
  }
  const beforeRegistry = registryValue(before, rawTimeline) ?? baselineRegistry;
  const authored = createCanonicalTimeline(nextConfig, composition);
  const oldRows = collectionRows(rawTimeline.clips, ['clips']);
  const nextRows = collectionRows(authored.clips, ['clips']);
  const added = [...nextRows.entries()].filter(([id]) => !oldRows.has(id));
  const changed = [...nextRows.entries()].filter(([id, row]) => oldRows.has(id)
    && mediaAssetId(oldRows.get(id)!) !== mediaAssetId(row));
  // An unshared child can use the same registered occurrence carrier as a
  // shared child, but only for a genuine media birth. Any other edit remains
  // on the existing document/patch path below.
  if (!shared && (added.length !== 1 || changed.length !== 0)) return null;
  if (added.length > 1 || changed.length > 1 || (added.length === 0 && changed.length === 0)) {
    throw new Error('Shared popup edits require one occurrence media ADD or SWAP');
  }
  if (added.length === 1) {
    const [, addedRow] = added[0];
    const asset = mediaAssetId(addedRow);
    const track = stringValue(addedRow.track);
    const rawTracks = collectionRows(rawTimeline.tracks, ['tracks']);
    if (asset && (!track || !rawTracks.has(track))) {
      throw new TimelineSaveError(
        'Gallery drops onto a new shot track are not supported yet. Drop the gallery item onto an existing shot track; nothing was saved.',
      );
    }
  }
  const forkShotId = shared
    ? `shot-fork-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
    : null;
  const fork = forkShotId ? {
    schema_version: 1 as const, op: 'occurrence.fork', version: '1', select: `occurrence:${occurrenceId}`,
    args: { shot_id: forkShotId },
    intent: { ownership: 'occurrence' as const },
    created: [`shot:${forkShotId}`],
  } : null;
  if (added.length === 1) {
    const [id, row] = added[0];
    const asset = mediaAssetId(row);
    if (!asset) throw new Error('Shared popup media ADD has no stable asset identity');
    if (!shared && !mediaSelectionIdentity(nextRegistry, asset)) return null;
    const media = await projectMediaSelection(mediaProvider, composition.projectId, asset, nextRegistry);
    const addRow = mediaRowWithoutAsset(row);
    addRow.id = id;
    addRow.asset = asset;
    const created = [
      ...(!Object.prototype.hasOwnProperty.call(registryAssets(beforeRegistry) ?? {}, asset)
        ? [`occurrence:${occurrenceId}/asset:${asset}`] : []),
      `occurrence:${occurrenceId}/clip:${id}`,
    ];
    const add: CommitRequest['commands'][number] = {
      schema_version: 1, op: 'occurrence.add-media', version: '1', select: `occurrence:${occurrenceId}`,
      args: { row: toOutboxJson(addRow), media }, intent: { ownership: 'occurrence' }, created,
    };
    return { commands: fork ? [fork, add] : [add] };
  }
  const [id, row] = changed[0];
  if (!fork) throw new Error('Shared popup media requires the occurrence fork carrier');
  const old = oldRows.get(id)!;
  const oldAsset = mediaAssetId(old);
  const newAsset = mediaAssetId(row);
  if (!oldAsset || !newAsset) throw new Error('Shared popup media SWAP has no stable asset identity');
  const [oldMedia, media] = await Promise.all([
    projectMediaSelection(mediaProvider, composition.projectId, oldAsset, beforeRegistry),
    projectMediaSelection(mediaProvider, composition.projectId, newAsset, nextRegistry),
  ]);
  const created = Object.prototype.hasOwnProperty.call(registryAssets(beforeRegistry) ?? {}, newAsset)
    ? []
    : [`occurrence:${occurrenceId}/asset:${newAsset}`];
  return { commands: [fork, {
    schema_version: 1, op: 'occurrence.swap-media', version: '1', select: `occurrence:${occurrenceId}/clip:${id}`,
    args: { old_media: oldMedia, media }, intent: { ownership: 'occurrence' }, created,
  }] };
}

/** Ephemeral shot-local geometry projection; it never changes the CAS graph. */
export function projectShotTimelineDraftComposition(
  composition: PreparedShotComposition,
  occurrenceId: string,
  config: ResolvedTimelineConfig,
  rawComposition = composition,
): PreparedShotComposition {
  const occurrence = composition.occurrences.find((candidate) => candidate.occurrenceId === occurrenceId);
  if (!occurrence) return composition;
  const timeline = createCanonicalTimeline(createShotTimelineConfig(config), rawComposition, 'shot-local');
  const extentMs = timelineContentExtentMs(timeline);
  const hardLimitMs = hardDurationMs(composition.contract, occurrenceId, occurrence.atMs);
  const revision = occurrence.revision;
  const internal = revision.internal_timeline_revision
    && typeof revision.internal_timeline_revision === 'object'
    && !Array.isArray(revision.internal_timeline_revision)
    ? revision.internal_timeline_revision as JsonObject
    : {};
  return {
    ...composition,
    occurrences: composition.occurrences.map((candidate) => candidate.occurrenceId === occurrenceId
      ? {
        ...candidate,
        durationMs: hardLimitMs === undefined ? extentMs : Math.min(extentMs, hardLimitMs),
        revision: {
          ...revision,
          internal_timeline_revision: { ...internal, timeline },
        },
      }
      : candidate),
  };
}

/** DataProvider bridge for the shot-local popup's canonical CAS publication. */
export function createShotTimelineDataProvider(
  config: ResolvedTimelineConfig,
  composition: PreparedShotComposition,
  occurrenceId: string,
  shotCompositionAdapter?: ShotCompositionAdapter,
  onCanonicalCompositionPublished?: (
    composition: PreparedShotComposition,
    generation: number,
    expectedHeadRevisionId: string | null,
  ) => void,
  editorHeadState?: { current: ShotTimelineEditorHeadState },
  initialDraftGeneration = 0,
  mediaProvider?: ShotTimelineMediaProvider,
  timelineDataProvider?: PopupLocalSaveProvider,
): ShotTimelineDataProvider {
  let registry: { assets: Record<string, ResolvedAssetRegistryEntry> } = {
    assets: Object.fromEntries(Object.entries(config.registry).map(([assetId, entry]) => ([assetId, {
      ...entry,
      file: entry.file ?? entry.media_id ?? entry.url,
    }]))),
  };
  const resolve = async (file: string): Promise<string> => {
    const entry = Object.values(registry.assets).find((candidate) => (
      candidate.file === file || candidate.media_id === file || candidate.url === file
    ));
    // Canonical projection has already resolved managed object IDs into src.
    // Prefer that display address over the persisted file/media identity so
    // opaque sha256: references never reach <img>/<video> as a request URL.
    if (entry?.src) return entry.src;
    if (entry?.url) return entry.url;
    return file.startsWith('sha256:')
      ? bridgeMediaUrl(composition.projectId, file)
      : file;
  };
  const projectedTimelineConfig = createShotTimelineConfig(config);
  let timelineConfig = createShotLocalTimelineConfig(composition, occurrenceId, projectedTimelineConfig);
  let canonicalTimelineConfig = timelineConfig;
  let configVersion = 1;
  // This is the CAS base for the mounted popup session. Never reload here:
  // doing so would turn a stale local draft into an unconditional write over
  // a concurrent canonical head. Advance the base only after its publication
  let canonicalBase = composition;
  const editorHeadStateIsMounted = editorHeadState !== undefined;
  const activeEditorHeadState = editorHeadState ?? {
    current: {
      canonicalHeadRevisionId: composition.headRevisionId,
      displayedHeadRevisionId: headRevisionIdFromConfig(config),
    },
  };
  activeEditorHeadState.current.canonicalHeadRevisionId = composition.headRevisionId;
  const adoptCanonicalBase = (next: PreparedShotComposition, advanceDisplayedHead = false) => {
    canonicalBase = next;
    activeEditorHeadState.current.canonicalHeadRevisionId = next.headRevisionId;
    if (!editorHeadStateIsMounted || advanceDisplayedHead) {
      activeEditorHeadState.current.displayedHeadRevisionId = next.headRevisionId;
    }
  };
  const assertEditorHeadIsCurrent = () => {
    const { canonicalHeadRevisionId, displayedHeadRevisionId } = activeEditorHeadState.current;
    if (canonicalHeadRevisionId
      && displayedHeadRevisionId !== canonicalHeadRevisionId) {
      throw new StaleWriteError(
        'The shot timeline is still adopting the latest canonical revision; retry after the displayed shot updates.',
      );
    }
  };
  const recoveryKey = shotTimelineRecoveryId(composition.parentDocumentId, occurrenceId);
  let timelineQueryIdentity = composition.headRevisionId;
  let pendingPublication: PendingCanonicalPublication | null = null;
  let activeTimingTraceId: string | null = null;
  let publishCallback = onCanonicalCompositionPublished;
  let draftGeneration = initialDraftGeneration;
  let draftDirty = false;
  let pendingPublishes = 0;
  let localSaveHead: TimelineAcceptedIdentity | undefined;
  let localSaveSessionPromise: Promise<LocalSaveSession> | undefined;
  let pendingLocalSaveSignature: string | null = null;
  let localSaveSource: { config: TimelineConfig; registry: unknown } | undefined;
  const localSaveEnabled = Boolean(
    timelineDataProvider?.loadTimelineCommandBasis
      && timelineDataProvider.getRecoverableIdentity
      && timelineDataProvider.commitTimeline,
  );
  if (timelineDataProvider && !localSaveEnabled) {
    throw new Error('Popup A2 save requires the existing command-basis, identity, and commit transport seam');
  }
  const prepareCanonicalSave = (basis: TimelineCommandBasis) => {
    localSaveHead = basis.head;
    if (!shotCompositionAdapter || !basis.graph) throw new Error('Popup A2 save received no accepted canonical closure');
    const published = shotCompositionAdapter.prepare(basis.graph);
    const occurrence = published.occurrences.find((value) => value.occurrenceId === occurrenceId);
    if (!occurrence) throw new Error('Popup A2 save received a canonical closure without the edited occurrence');
    const projected = projectCanonicalComposition({ ...published, occurrences: [occurrence] },
      { ...config, clips: [], tracks: [], registry: {} }, { clampToOccurrenceDuration: false }).config;
    const canonicalConfig = createShotLocalTimelineConfig(
      published,
      occurrenceId,
      createShotTimelineConfig(projected),
    );
    return () => {
      composition = published;
      localSaveSource = undefined;
      adoptCanonicalBase(published, true);
      timelineConfig = canonicalConfig;
      canonicalTimelineConfig = canonicalConfig;
      registry = { assets: Object.fromEntries(Object.entries(projected.registry).map(([id, entry]) => [id, {
        ...entry, file: entry.file ?? entry.media_id ?? entry.url,
      }])) };
    };
  };
  const flushLocalSaves = async (session: LocalSaveSession) => {
    try { return await session.flush(); }
    catch (error) {
      const state = session.getState();
      const detail = object(state.error)?.message;
      const message = typeof detail === 'string' ? detail : error instanceof Error ? error.message : String(error);
      if (state.status === 'conflict') throw new TimelineVersionConflictError(message);
      if (['blocked', 'error', 'recovery'].includes(state.status)) throw new TimelineSaveError(message);
      throw error;
    }
  };
  if (localSaveEnabled) {
    localSaveSessionPromise = (async () => {
      const [initial, identity] = await Promise.all([
        timelineDataProvider!.loadTimelineCommandBasis!(composition.parentDocumentId),
        timelineDataProvider!.getRecoverableIdentity!(),
      ]);
      if (!initial.head.revisionId || !initial.head.publicationId
        || initial.canonicalDocument.project_id !== composition.projectId
        || initial.canonicalDocument.timeline_id !== composition.parentDocumentId) {
        throw new TimelineSaveError('Popup A2 save needs the original verified parent, shot and internal closure with revision and publication pins; draft retained');
      }
      const revisionMismatch = typeof initial.head.revisionId === 'string' && initial.head.revisionId.length > 0
        && typeof composition.headRevisionId === 'string' && composition.headRevisionId.length > 0
        && initial.head.revisionId !== composition.headRevisionId;
      const canonicalRevisionMismatch = typeof initial.canonicalDocument.parent_revision.revision_id === 'string'
        && initial.canonicalDocument.parent_revision.revision_id.length > 0
        && typeof initial.head.revisionId === 'string' && initial.head.revisionId.length > 0
        && initial.canonicalDocument.parent_revision.revision_id !== initial.head.revisionId;
      if (revisionMismatch || canonicalRevisionMismatch) {
        throw new TimelineVersionConflictError('Popup A2 original parent revision changed before save; draft retained');
      }
      localSaveHead = initial.head;
      return createLocalSaveSession({
        scope: { ...identity, projectId: composition.projectId, timelineId: composition.parentDocumentId },
        initial,
        document: toOutboxJson(initial.canonicalDocument),
        send: (request, key) => timelineDataProvider!.commitTimeline!(request, key),
        loadLatest: () => timelineDataProvider!.loadTimelineCommandBasis!(composition.parentDocumentId),
        changed: () => {},
        prepareDisplay: async (basis, draft) => ({
          document: draft ?? toOutboxJson(basis.canonicalDocument),
          adopt: draft === undefined ? prepareCanonicalSave(basis) : () => {},
        }),
      });
    })();
    void localSaveSessionPromise.catch(() => {});
  }

  // Only the verified assembly read and our own accepted successors supply
  // source pins; a display projection or a later provider poll cannot do so.
  const readSourceHead = () => {
    const sourceComposition = composition;
    const sourceHead = localSaveHead;
    return localSaveSessionPromise!.then(() => {
      const verified = sourceHead ?? localSaveHead;
      if (verified && typeof verified.revisionId === 'string' && verified.revisionId.length > 0
        && typeof sourceComposition.headRevisionId === 'string' && sourceComposition.headRevisionId.length > 0
        && verified.revisionId !== sourceComposition.headRevisionId) {
        throw new TimelineVersionConflictError('Popup original source revision changed; draft retained');
      }
      if (!verified || !verified.revisionId || !verified.publicationId || !sourceComposition.headRevisionId) {
        throw new TimelineSaveError('Popup original source head is unavailable; draft retained');
      }
      return { projectId: sourceComposition.projectId, timelineId: sourceComposition.parentDocumentId,
        headRevisionId: verified.revisionId, headPublicationId: verified.publicationId };
    });
  };

  let captureChain: Promise<void> = Promise.resolve();
  let capturedExpectedHeadRevisionId = composition.headRevisionId;
  const localDocumentSave: TimelinePersistenceHandoff | undefined = localSaveEnabled ? {
    async capture(source) {
      const { config: nextConfig, registry: nextRegistry, head } = structuredClone(source);
      assertEditorHeadIsCurrent();
      const rawComposition = composition;
      capturedExpectedHeadRevisionId = canonicalBase.headRevisionId;
      captureChain = captureChain.then(async () => {
        if (!shotCompositionAdapter) throw new Error('Popup A2 save requires the validated canonical composition adapter');
        const session = await localSaveSessionPromise!;
        assertEditorHeadIsCurrent();
        if (!head || head.projectId !== rawComposition.projectId
          || head.timelineId !== rawComposition.parentDocumentId
          || !head.headRevisionId || !head.headPublicationId
          || !rawComposition.headRevisionId || !localSaveHead?.publicationId) {
          throw new TimelineSaveError('Popup canonical source pins are unavailable; draft retained');
        }
        if (typeof canonicalBase.headRevisionId === 'string' && canonicalBase.headRevisionId.length > 0
          && typeof rawComposition.headRevisionId === 'string' && rawComposition.headRevisionId.length > 0
          && canonicalBase.headRevisionId !== rawComposition.headRevisionId) {
          throw new TimelineVersionConflictError('Popup canonical head changed during capture; draft retained');
        }
        if (head?.headRevisionId && rawComposition.headRevisionId
          && head.headRevisionId !== rawComposition.headRevisionId) {
          throw new TimelineVersionConflictError('Popup canonical head changed during capture; draft retained');
        }
        if (head?.headPublicationId && localSaveHead?.publicationId
          && head.headPublicationId !== localSaveHead.publicationId) {
          throw new TimelineVersionConflictError('Popup canonical head changed during capture; draft retained');
        }
        const draftRegistry = nextRegistry ?? registry;
        const before = session.getDocument() as unknown as CanonicalDocument;
        const signature = stableStringify({ config: nextConfig, registry: draftRegistry });
        if (session.getState().status !== 'retry' || pendingLocalSaveSignature !== signature) {
          const step = {
            id: globalThis.crypto?.randomUUID?.() ?? `popup-edit-${Date.now()}`,
            label: 'Edit shot timeline',
            intent: 'Save shot-local timeline changes',
            tags: ['shot-popup'],
          };
          const sharedCommands = await sharedPopupMediaCommands(
            before,
            nextConfig,
            draftRegistry,
            localSaveSource?.registry ?? registry,
            rawComposition,
            occurrenceId,
            timelineDataProvider!,
          );
          if (sharedCommands) {
            await session.append({
              before: toOutboxJson(before),
              after: toOutboxJson(before),
              label: 'Edit shot timeline',
              commands: sharedCommands.commands,
            });
          } else {
            const edit = popupDocumentAfter(
              before,
              nextConfig,
              localSaveSource?.config
                ?? (timelineSource(nextConfig, rawComposition, occurrenceId) === 'shot-local'
                  ? timelineConfig
                  : projectedTimelineConfig),
              nextRegistry && !sameJson(nextRegistry, localSaveSource?.registry ?? registry) ? draftRegistry : undefined,
              localSaveSource?.registry ?? registry,
              rawComposition,
              occurrenceId,
            );
            if (hasPopupStructuralChange(before, edit.document)) {
              const intent = popupDocumentPatchIntent(before, edit, occurrenceId, 'Edit shot timeline', step, localSaveHead!);
              const intentObject = intent as unknown as Record<string, unknown>;
              const command: CommitRequest['commands'][number] = {
                schema_version: 1 as const,
                op: 'doc.patch',
                version: '1',
                select: null,
                created: intentObject.created as string[],
                args: { changes: toOutboxJson(intentObject.changes) },
              };
              const save: LocalSave & { documentIntent: OutboxJson } = {
                before: toOutboxJson(before),
                after: toOutboxJson(edit.document),
                label: 'Edit shot timeline',
                commands: [command],
                documentIntent: intent,
              };
              await session.append(save);
            } else {
              await session.appendDocument({
                before,
                after: edit.document,
                roots: edit.roots,
                label: 'Edit shot timeline',
                step: { ...step, reads: edit.reads },
                reads: edit.reads,
                merge: 'atomic',
              });
            }
          }
          pendingLocalSaveSignature = signature;
          localSaveSource = structuredClone({ config: nextConfig, registry: draftRegistry });
        }
      });
      return captureChain;
    },
    async flush() {
      const publicationGeneration = draftGeneration;
      const expectedHeadRevisionId = capturedExpectedHeadRevisionId;
      assertEditorHeadIsCurrent();
      await captureChain;
      const session = await localSaveSessionPromise!;
      const basis = await flushLocalSaves(session);
      prepareCanonicalSave(basis)();
      pendingLocalSaveSignature = null;
      pendingPublication = null;
      publishCallback?.(composition, publicationGeneration, expectedHeadRevisionId);
      configVersion += 1;
      return { configVersion, head: { projectId: composition.projectId, timelineId: composition.parentDocumentId,
        headRevisionId: basis.head.revisionId, headPublicationId: basis.head.publicationId } };
    },
  } : undefined;

  const provider: ShotTimelineDataProvider = {
    localDocumentSave,
    bindLocalDocumentSave: (timelineId) => localDocumentSave
      ? bindTimelinePersistenceHandoff(provider, timelineId, {
          capture(source) {
            const snapshot = structuredClone(source);
            const head = readSourceHead();
            return head.then(verified => localDocumentSave.capture({ ...snapshot, head: snapshot.head ?? verified }));
          },
          flush: () => localDocumentSave.flush(),
        }) : undefined,
    get timelineQueryIdentity() {
      return timelineQueryIdentity;
    },
    persistenceEnabled: Boolean(shotCompositionAdapter?.publish || localSaveEnabled),
    ...(mediaProvider?.supportsDirectAssetUpload !== undefined
      ? { supportsDirectAssetUpload: mediaProvider.supportsDirectAssetUpload }
      : {}),
    ...(mediaProvider?.prepareMediaImport
      ? { prepareMediaImport: mediaProvider.prepareMediaImport.bind(mediaProvider) }
      : {}),
    ...(mediaProvider?.getProjectMediaSelection
      ? { getProjectMediaSelection: mediaProvider.getProjectMediaSelection.bind(mediaProvider) }
      : {}),
    ...(mediaProvider?.getProjectVerifiedMedia
      ? { getProjectVerifiedMedia: mediaProvider.getProjectVerifiedMedia.bind(mediaProvider) }
      : {}),
    setShotTimelineTraceId: (traceId) => { activeTimingTraceId = traceId; },
    getTimelineDraftRecoveryMetadata: (rememberRaw): TimelineDraftRecoveryMetadata => {
      rememberRaw?.(composition);
      return {
        recoveryKey,
        baseHeadRevisionId: canonicalBase.headRevisionId,
        baseCanonicalGraph: canonicalBase.contract as unknown as Record<string, unknown>,
        draftIdentity: globalThis.crypto?.randomUUID?.() ?? `edit-${Date.now()}-${Math.random()}`,
      };
    },
    resolveAssetUrl: resolve,
    onResolve: async ({ file }) => resolve(file),
    loadTimeline: async (_timelineId) => {
      timelineConfig = createShotLocalTimelineConfig(composition, occurrenceId, canonicalTimelineConfig);
      const recovery = await loadTimelineDraft(recoveryKey).catch(() => null);
      let recoveryBaseHeadRevisionId: string | null = null;
      if (recovery?.baseCanonicalGraph && shotCompositionAdapter) {
        try {
          const recoveredBase = shotCompositionAdapter.prepare(recovery.baseCanonicalGraph);
          if (recoveredBase.headRevisionId === recovery.baseHeadRevisionId) {
            const recoveryBaseIsCurrent = recoveredBase.headRevisionId === canonicalBase.headRevisionId;
            // A recovery base is CAS provenance, not proof that it is still the
            // current canonical head. Only adopt its displayed marker when it
            // matches the provider's latest known base; never rewrite a stale
            // draft's original CAS revision here.
            composition = recoveredBase;
            adoptCanonicalBase(recoveredBase, recoveryBaseIsCurrent);
            if (recoveryBaseIsCurrent) {
              recoveryBaseHeadRevisionId = recoveredBase.headRevisionId;
            }
          }
        } catch {
          // A malformed recovery base is not authority; keep the fresh graph.
        }
      }
      if (recoveryBaseHeadRevisionId && recovery?.draftIdentity) {
        // Keep the durable draft's marker aligned with the validated base.
        // Retry reads the one-slot record again, so an in-memory-only repair
        // here would let it rehydrate the stale marker and hit the edit gate.
        await reconcileTimelineDraftHeadMarker(
          recoveryKey,
          recovery.draftIdentity,
          recoveryBaseHeadRevisionId,
        ).catch(() => false);
      }
      const recoveredConfig = recovery?.draft.config;
      if (recoveredConfig && typeof recoveredConfig === 'object' && !Array.isArray(recoveredConfig)) {
        const authoredRecoveryConfig = restoreRawAppCollisionsInRecoveryDraft(
          recoveredConfig as TimelineConfig,
          composition,
        );
        timelineConfig = recoveryBaseHeadRevisionId
          ? reconcileConfigHeadRevision(authoredRecoveryConfig, recoveryBaseHeadRevisionId)
          : authoredRecoveryConfig;
      }
      if (recoveredConfig) {
        const identities = projectCanonicalComposition(composition, undefined, { clampToOccurrenceDuration: false }).clipIdentities;
        timelineConfig = { ...timelineConfig, clips: timelineConfig.clips.map((clip) => {
          const identity = identities.get(clip.id);
          const original = composition.occurrences.find((item) => item.occurrenceId === identity?.occurrenceId);
          return original ? { ...clip, app: { ...clip.app, canonicalTiming: {
            ...(clip.app?.canonicalTiming as object), storedOccurrenceDurationMs: original.durationMs,
          } } } : clip;
        }) };
      }
      const savedPublication = recovery?.draft.canonicalPublication;
      if (savedPublication && typeof savedPublication === 'object' && !Array.isArray(savedPublication)) {
        const candidate = savedPublication as Record<string, unknown>;
        if (typeof candidate.configSignature === 'string'
          && typeof candidate.expectedHeadRevisionId === 'string'
          && typeof candidate.idempotencyKey === 'string'
          && candidate.graph && typeof candidate.graph === 'object' && !Array.isArray(candidate.graph)) {
          pendingPublication = {
            configSignature: candidate.configSignature,
            expectedHeadRevisionId: candidate.expectedHeadRevisionId,
            idempotencyKey: candidate.idempotencyKey,
            graph: candidate.graph as unknown as ShotCompositionContract,
          };
        }
      }
      return { config: timelineConfig, configVersion };
    },
    loadCanonicalTimeline: async (_timelineId): Promise<LoadedTimeline> => {
      if (shotCompositionAdapter) {
        const latest = await shotCompositionAdapter.load({
          projectId: composition.projectId,
          parentDocumentId: composition.parentDocumentId,
        });
        if (!latest) throw new Error('The canonical shot composition is unavailable');
        composition = latest;
        adoptCanonicalBase(latest);
        timelineQueryIdentity = latest.headRevisionId;
        const occurrence = latest.occurrences.find((candidate) => candidate.occurrenceId === occurrenceId);
        if (!occurrence) throw new Error('The canonical shot occurrence is unavailable');
        const canonicalLocalConfig = createShotLocalTimelineConfig(
          latest,
          occurrenceId,
          canonicalTimelineConfig,
        );
        const projected = projectCanonicalComposition({ ...latest, occurrences: [occurrence] },
          { ...config, clips: [], tracks: [], registry: {} }, { clampToOccurrenceDuration: false }).config;
        registry = {
          assets: Object.fromEntries(Object.entries(projected.registry).map(([assetId, entry]) => ([assetId, {
            ...entry,
            file: entry.file ?? entry.media_id ?? entry.url,
          }]))),
        };
        canonicalTimelineConfig = canonicalLocalConfig;
      }
      timelineConfig = createShotLocalTimelineConfig(composition, occurrenceId, canonicalTimelineConfig);
      pendingPublication = null;
      return { config: timelineConfig, configVersion };
    },
    loadAssetRegistry: async () => registry,
    saveTimeline: async (timelineId, nextConfig, expectedVersion, nextRegistry) => {
      const publicationGeneration = draftGeneration;
      const rawComposition = composition;
      const draftRegistry = nextRegistry ?? registry;
      assertEditorHeadIsCurrent();
      if (localDocumentSave) {
        await localDocumentSave.capture({ config: nextConfig, registry: draftRegistry, head: await readSourceHead() });
        return (await localDocumentSave.flush()).configVersion;
      }
      if (!shotCompositionAdapter?.publish) {
        throw new Error('The canonical shot-composition provider is read-only');
      }
      pendingPublishes += 1;
      const requestedAt = import.meta.env.DEV ? performance.now() : 0;
      const timingTraceId = activeTimingTraceId;
      let publicationExpectedHeadRevisionId: string | null = null;
      if (timingTraceId) recordShotTimelinePhase(timingTraceId, 'request-start', { expectedVersion });
      try {
        const timeline = createCanonicalTimeline(nextConfig, rawComposition, timelineSource(nextConfig, rawComposition, occurrenceId));
        // Reserve the project queue synchronously in caller order before any
        // async recovery read or hashing. Otherwise a later edit can finish
        // preparation first and publish ahead of the save that was requested
        // before it.
        const published = await enqueueCanonicalShotPublish(
          composition.projectId,
          composition.parentDocumentId,
          async () => {
            // The queued publication may have waited behind another shot edit
            // while the mounted popup adopted a newer head. Recheck at the
            // actual write boundary, not just when the UI requested the save.
            assertEditorHeadIsCurrent();
            // Another edit can become durable while this publication hashes
            // and prepares its graph, so owner comparison and write below are
            // still transactional.
            const recoveryAtStart = await loadTimelineDraft(recoveryKey).catch(() => null);
            const configSignature = await digest(normalizeHeadForSignature(timeline, canonicalBase.headRevisionId));
            let candidate = pendingPublication?.configSignature === configSignature
              ? pendingPublication
              : null;
            if (!candidate) {
              const identitySeed = (await digest({
                projectId: canonicalBase.projectId,
                parentDocumentId: canonicalBase.parentDocumentId,
                occurrenceId,
                expectedHeadRevisionId: canonicalBase.headRevisionId,
                configSignature,
              })).slice(0, 32);
              const graph = await updateCanonicalShotTimeline(
                canonicalBase.contract,
                occurrenceId,
                timeline,
                identitySeed,
              );
              candidate = {
                configSignature,
                expectedHeadRevisionId: canonicalBase.headRevisionId,
                idempotencyKey: `astrid.shot-popup.${identitySeed}`,
                graph,
              };
              pendingPublication = candidate;
            }
            publicationExpectedHeadRevisionId = candidate.expectedHeadRevisionId;
            const recoveryDraftConfig = recoveryAtStart?.draft.config;
            const recoveryMatchesThisSave = Boolean(
              recoveryAtStart?.draftIdentity
              && recoveryDraftConfig
              && typeof recoveryDraftConfig === 'object'
              && !Array.isArray(recoveryDraftConfig)
              && await digest(normalizeHeadForSignature(
                createCanonicalTimeline(
                  recoveryDraftConfig as TimelineConfig,
                  rawComposition,
                  timelineSource(recoveryDraftConfig as TimelineConfig, rawComposition, occurrenceId),
                ),
                canonicalBase.headRevisionId,
              )) === configSignature,
            );
            const expectedRecoveryOwner = recoveryAtStart === null
              ? null
              : recoveryMatchesThisSave
                ? recoveryAtStart.draftIdentity!
                // A different durable config is newer than this save or has
                // no trustworthy owner token. Force the conflict-merge path;
                // never adopt its owner token and overwrite its config.
                : `superseded:${candidate.idempotencyKey}`;
            const publicationDraft = {
              ...(recoveryAtStart?.draft ?? {}),
              // Existing recovery bytes keep their owner and retry meaning.
              // Recovery owns the exact editor draft, including the verified
              // stored occurrence duration used to replay its preview. The
              // publication candidate above remains the sanitized canonical
              // graph; do not strip replay metadata from the stale draft.
              config: restoreRawAppCollisionsInRecoveryDraft(
                recoveryMatchesThisSave ? recoveryAtStart!.draft.config as TimelineConfig : nextConfig,
                rawComposition,
              ),
              registry: draftRegistry,
              canonicalPublication: candidate,
            };
            await saveTimelineDraftIfOwner(
              timelineId,
              publicationDraft,
              expectedVersion,
              {
                recoveryKey,
                baseHeadRevisionId: candidate.expectedHeadRevisionId,
                baseCanonicalGraph: canonicalBase.contract as unknown as Record<string, unknown>,
                draftIdentity: candidate.idempotencyKey,
                acknowledgementIdentity: candidate.idempotencyKey,
              },
              expectedRecoveryOwner,
              (current, candidateRecord) => ({
                ...current,
                // Keep B's config/base/owner, but make A's exact publication
                // candidate available as a retry without making A the owner.
                draft: {
                  ...current.draft,
                  canonicalPublication: candidateRecord.draft.canonicalPublication,
                },
              }),
            );
            const publishStartedAt = import.meta.env.DEV ? performance.now() : 0;
            const acknowledged = await shotCompositionAdapter.publish!({
              projectId: canonicalBase.projectId,
              parentDocumentId: canonicalBase.parentDocumentId,
              expectedHeadRevisionId: candidate.expectedHeadRevisionId,
              graph: candidate.graph,
              idempotencyKey: candidate.idempotencyKey,
              timingTraceId: timingTraceId ?? undefined,
            });
            // This head is our own acknowledged publication. The mounted
            // editor contains that saved revision plus any newer local edits,
            // so it can continue on the new CAS base without waiting for a
            // redundant query echo to rewrite its head marker.
            adoptCanonicalBase(acknowledged, true);
            canonicalTimelineConfig = createShotLocalTimelineConfig(acknowledged, occurrenceId, nextConfig);
            timelineConfig = canonicalTimelineConfig;
            pendingPublication = null;
            const clearedAcknowledgedDraft = await clearTimelineDraftIfMatches(
              recoveryKey,
              candidate.idempotencyKey,
            ).catch(() => false);
            if (!clearedAcknowledgedDraft) {
              await advanceTimelineDraftBaseAfterAcknowledgement(
                recoveryKey,
                candidate.expectedHeadRevisionId,
                acknowledged.headRevisionId,
                acknowledged.contract as unknown as Record<string, unknown>,
                candidate.idempotencyKey,
              ).catch(() => false);
            }
            if (import.meta.env.DEV) {
              console.debug('[ShotTimelineLatency]', {
                phase: 'canonical-publish-ack',
                occurrenceId,
                queueWaitMs: Math.round(publishStartedAt - requestedAt),
                publishMs: Math.round(performance.now() - publishStartedAt),
              });
            }
            if (timingTraceId) recordShotTimelinePhase(timingTraceId, 'canonical-ack', {
              headRevisionId: acknowledged.headRevisionId,
            });
            return acknowledged;
          },
        );
        if (timingTraceId) recordShotTimelinePhase(timingTraceId, 'request-end', {
          durationMs: Math.round(performance.now() - requestedAt),
        });
        // A publication can finish after React has rendered a newer callback.
        // Keep the callback current without rebuilding the editor's provider.
        publishCallback?.(published, publicationGeneration, publicationExpectedHeadRevisionId);
        configVersion += 1;
        return configVersion;
      } finally {
        pendingPublishes -= 1;
      }
    },
    setPublishCallback: (callback) => { publishCallback = callback; },
    setDraftState: (dirty) => { draftDirty = dirty; },
    setDraftGeneration: (generation) => { draftGeneration = Math.max(draftGeneration, generation); return composition; },
    adoptCleanBaseline: (nextConfig, nextComposition) => {
      if (draftDirty || pendingPublishes > 0) {
        return false;
      }
      composition = nextComposition;
      timelineConfig = createShotLocalTimelineConfig(nextComposition, occurrenceId, nextConfig);
      canonicalTimelineConfig = timelineConfig;
      registry = {
        assets: Object.fromEntries(Object.entries(nextConfig.registry).map(([assetId, entry]) => ([assetId, {
          ...entry,
          file: entry.file ?? entry.media_id ?? entry.url,
        }]))),
      };
      adoptCanonicalBase(nextComposition);
      timelineQueryIdentity = nextComposition.headRevisionId;
      return true;
    },
    getLocalSaveState: async () => (await localSaveSessionPromise)?.getState() ?? null,
    recoverLocalSaves: async (ownerId) => {
      if (!localSaveSessionPromise) throw new Error('Popup A2 save session is unavailable');
      const session = await localSaveSessionPromise;
      await session.recover(ownerId);
      const basis = await flushLocalSaves(session);
      prepareCanonicalSave(basis)();
      publishCallback?.(composition, draftGeneration, null);
    },
    dispose: async () => {
      await localSaveSessionPromise?.then((session) => session.dispose());
    },
  };
  return provider;
}

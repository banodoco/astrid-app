import { bridgeMediaUrl } from '@/shared/lib/media/bridgeMediaUrl.ts';
import type {
  ResolvedAssetRegistryEntry,
  ResolvedTimelineConfig,
  TimelineClip,
  TrackDefinition,
} from '@/tools/video-editor/types/index.ts';
import type {
  CanonicalShotOccurrence,
  PreparedShotComposition,
} from './shotCompositionAdapter.ts';
import {
  isActiveTimelineClip,
  timelineContentExtentMs,
  timelineOccurrenceEffectiveDurationMs,
} from './shotCompositionTiming.ts';
import { analyzeVisualSeams } from './visualSeamContract.ts';
import {
  outputTimeline,
  projectOutputTimelineConfig,
  trackRole,
} from './timelineOutputProjection.ts';

type JsonObject = Record<string, unknown>;

export type CanonicalProjectionFailureCode =
  | 'missing_dependency'
  | 'unsupported_nesting'
  | 'blank_child_output'
  | 'asset_conflict';

export class CanonicalCompositionProjectionError extends Error {
  readonly code: CanonicalProjectionFailureCode;
  readonly occurrenceId?: string;

  constructor(code: CanonicalProjectionFailureCode, message: string, occurrenceId?: string) {
    super(message);
    this.name = 'CanonicalCompositionProjectionError';
    this.code = code;
    this.occurrenceId = occurrenceId;
  }
}

export type CanonicalClipIdentity = Readonly<{
  projectId: string;
  parentDocumentId: string;
  occurrenceId: string;
  shotId: string;
  revisionId: string;
  internalTimelineRevisionId: string;
  outputIdentity: string;
}>;

export type CanonicalCompositionProjection = Readonly<{
  config: ResolvedTimelineConfig;
  clipIdentities: ReadonlyMap<string, CanonicalClipIdentity>;
  occurrenceIdentities: ReadonlyMap<string, CanonicalClipIdentity>;
}>;

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mediaTypeForAsset(asset: JsonObject): string | undefined {
  const source = record(asset.source);
  const candidates = [
    asset.media_type,
    asset.type,
    source?.media_type,
    source?.type,
    asset.role,
  ];
  return candidates
    .map((value) => text(value))
    .find((value) => value !== undefined && /^(image|video|audio)(?:\/|$)/i.test(value));
}

function isMediaType(value: unknown): value is string {
  return typeof value === 'string' && /^(image|video|audio)(?:\/|$)/i.test(value);
}

function positiveNumber(value: unknown, fallback: number): number {
  const candidate = finiteNumber(value, fallback);
  return candidate > 0 ? candidate : fallback;
}

function internalTimelineRevisionId(occurrence: CanonicalShotOccurrence): string {
  const internal = record(occurrence.revision.internal_timeline_revision);
  return text(internal?.revision_id) ?? `${occurrence.revisionId}:internal`;
}

function identityForOccurrence(occurrence: CanonicalShotOccurrence): CanonicalClipIdentity {
  return Object.freeze({
    projectId: occurrence.projectId,
    parentDocumentId: occurrence.parentDocumentId,
    occurrenceId: occurrence.occurrenceId,
    shotId: occurrence.shotId,
    revisionId: occurrence.revisionId,
    internalTimelineRevisionId: internalTimelineRevisionId(occurrence),
    outputIdentity: occurrence.outputIdentity,
  });
}

function assertDependencies(composition: PreparedShotComposition): void {
  const revisions = new Set(composition.contract.shot_revisions.map((revision) => (
    `${String(revision.shot_id)}\u0000${String(revision.revision_id)}`
  )));
  for (const revision of composition.contract.shot_revisions) {
    const dependencies = Array.isArray(revision.dependencies) ? revision.dependencies : [];
    for (const dependency of dependencies) {
      const value = record(dependency);
      const key = `${String(value?.shot_id)}\u0000${String(value?.revision_id)}`;
      if (!revisions.has(key)) {
        throw new CanonicalCompositionProjectionError(
          'missing_dependency',
          `Canonical shot ${String(revision.shot_id)}/${String(revision.revision_id)} requires missing dependency ${key.replace('\u0000', '/')}`,
        );
      }
    }
  }
}

function assertSupportedChildClip(rawClip: JsonObject, occurrence: CanonicalShotOccurrence): void {
  const clipType = text(rawClip.clip_type) ?? text(rawClip.clipType);
  const nested = clipType === 'shot'
    || clipType === 'sequence'
    || clipType === 'composition'
    || Array.isArray(rawClip.children)
    || rawClip.shot_id !== undefined
    || rawClip.shot_revision_id !== undefined
    || rawClip.occurrence_id !== undefined;
  if (nested) {
    throw new CanonicalCompositionProjectionError(
      'unsupported_nesting',
      `Canonical occurrence ${occurrence.occurrenceId} contains an unsupported nested child clip`,
      occurrence.occurrenceId,
    );
  }
}

function childTimeline(occurrence: CanonicalShotOccurrence): JsonObject {
  const internal = record(occurrence.revision.internal_timeline_revision);
  const timeline = record(internal?.timeline);
  if (!timeline) {
    throw new CanonicalCompositionProjectionError(
      'blank_child_output',
      `Canonical occurrence ${occurrence.occurrenceId} has no child timeline`,
      occurrence.occurrenceId,
    );
  }
  return timeline;
}

function assetRegistryFor(
  composition: PreparedShotComposition,
  baseConfig?: ResolvedTimelineConfig | null,
  occurrences: readonly CanonicalShotOccurrence[] = composition.occurrences,
): { registry: Record<string, ResolvedAssetRegistryEntry>; assetAliases: Map<string, string> } {
  const registry: Record<string, ResolvedAssetRegistryEntry> = {
    ...(baseConfig?.registry ?? {}),
  };
  const canonicalObjectIds = new Map<string, string>();
  const assetAliases = new Map<string, string>();
  const selectedAssets: Array<{ occurrenceId: string; assetId: string; asset: JsonObject; objectId: string }> = [];
  const selectedObjectIds = new Map<string, Set<string>>();
  for (const clip of baseConfig?.clips ?? []) {
    if (clip.clipType === 'shot' || !clip.asset) continue;
    const objectId = text(registry[clip.asset]?.media_id) ?? text(registry[clip.asset]?.file);
    if (objectId) selectedObjectIds.set(clip.asset, new Set([objectId]));
  }

  const mergeAsset = (assetId: string, rawAsset: JsonObject, objectId: string, canonical: boolean): void => {
    if (canonical) {
      const existingCanonicalObjectId = canonicalObjectIds.get(assetId);
      if (existingCanonicalObjectId && existingCanonicalObjectId !== objectId) {
        throw new CanonicalCompositionProjectionError(
          'asset_conflict',
          `Canonical asset ${assetId} resolves to both ${existingCanonicalObjectId} and ${objectId}`,
        );
      }
      canonicalObjectIds.set(assetId, objectId);
    }
    const canonicalMediaType = mediaTypeForAsset(rawAsset);
    const existing = registry[assetId];
    const sameObject = existing?.media_id === objectId || existing?.file === objectId;
    registry[assetId] = {
      ...existing,
      file: sameObject ? existing?.file ?? objectId : objectId,
      media_id: sameObject ? existing?.media_id ?? objectId : objectId,
      content_sha256: sameObject
        ? existing?.content_sha256 ?? text(rawAsset.digest) ?? text(rawAsset.content_sha256)
        : text(rawAsset.digest) ?? text(rawAsset.content_sha256) ?? existing?.content_sha256,
      // Canonical shot assets are authoritative for the media kind. Some
      // older parent registries omitted it or incorrectly described a
      // video object as an image, which makes the browser mount an MP4 as
      // <img> and leaves a blank frame.
      type: canonicalMediaType ?? (sameObject && isMediaType(existing?.type) ? existing.type : 'image'),
      resolution: text(rawAsset.resolution) ?? (sameObject ? existing?.resolution : undefined),
      origin: sameObject ? existing?.origin ?? 'immutable-public' : 'immutable-public',
      metadata: sameObject ? existing?.metadata ?? {
        provenance: {
          sourceProvider: 'canonical-shot-composition',
          originalFilename: assetId,
        },
      } : {
        provenance: {
          sourceProvider: 'canonical-shot-composition',
          originalFilename: assetId,
        },
      },
      src: sameObject && existing?.src
        ? existing.src
        : bridgeMediaUrl(composition.projectId, objectId),
    };
  };

  for (const occurrence of occurrences) {
    const timeline = outputTimeline(childTimeline(occurrence));
    const selectedAssetIds = new Set(
      (Array.isArray(timeline.clips) ? timeline.clips : []).flatMap((rawClip) => {
        const clip = record(rawClip);
        const assetId = text(clip?.asset_id) ?? text(clip?.asset);
        return assetId ? [assetId] : [];
      }),
    );
    const playbackAssets = occurrence.revision.runtime_playback_assets;
    const assets = Array.isArray(playbackAssets)
      ? playbackAssets
      : Array.isArray(occurrence.revision.assets) ? occurrence.revision.assets : [];
    for (const rawAsset of assets) {
      const asset = record(rawAsset);
      if (!asset) continue;
      const assetId = text(asset.asset_id);
      const objectId = text(asset.object_id);
      if (!assetId || !objectId) continue;
      // Inherited alternatives are revision-scoped metadata. They must not
      // collide with another shot's selected binding in the playback registry.
      if (!selectedAssetIds.has(assetId)) continue;
      selectedAssets.push({ occurrenceId: occurrence.occurrenceId, assetId, asset, objectId });
      const objectIds = selectedObjectIds.get(assetId) ?? new Set<string>();
      objectIds.add(objectId);
      selectedObjectIds.set(assetId, objectIds);
    }
  }
  for (const { occurrenceId, assetId, asset, objectId } of selectedAssets) {
    // Asset keys belong to an immutable child revision. Different shots can
    // legitimately select different objects under the same authored key.
    const projectedAssetId = selectedObjectIds.get(assetId)!.size > 1
      ? `canonical:${encodeURIComponent(occurrenceId)}:${encodeURIComponent(assetId)}`
      : assetId;
    assetAliases.set(`${occurrenceId}\u0000${assetId}`, projectedAssetId);
    mergeAsset(projectedAssetId, asset, objectId, true);
  }
  return { registry, assetAliases };
}

function tracksFor(
  composition: PreparedShotComposition,
  baseConfig?: ResolvedTimelineConfig | null,
  occurrences: readonly CanonicalShotOccurrence[] = composition.occurrences,
): TrackDefinition[] {
  // Keep parent-owned lanes (frame overlays, FX, terminal activity, VO, etc.)
  // alongside the projected shot child lanes. The canonical graph owns shot
  // content, but it does not replace unrelated parent timeline content.
  const tracks = [...(baseConfig?.tracks ?? [])];
  const trackIds = new Set(tracks.map((track) => track.id));
  for (const occurrence of occurrences) {
    const timeline = outputTimeline(childTimeline(occurrence));
    const rawTracks = Array.isArray(timeline.tracks) ? timeline.tracks : [];
    for (const rawTrack of rawTracks) {
      const track = record(rawTrack);
      const id = text(track?.id);
      if (!id || trackIds.has(id)) continue;
      if (trackRole({
        id,
        role: track?.role as TrackDefinition['role'],
      }) === 'source') continue;
      const kind = track?.kind === 'audio' ? 'audio' : 'visual';
      const definition = { ...track, id, kind, label: text(track?.label) ?? id } as TrackDefinition;
      const shotTrackOrder = rawTracks.map((raw) => text(record(raw)?.id)).filter((value): value is string => Boolean(value));
      const position = shotTrackOrder.indexOf(id);
      let insertAt = tracks.length;
      for (let previous = position - 1; previous >= 0; previous--) {
        const sharedIndex = tracks.findIndex((entry) => entry.id === shotTrackOrder[previous]);
        if (sharedIndex >= 0) { insertAt = sharedIndex + 1; break; }
      }
      if (position >= 0 && !shotTrackOrder.slice(0, position).some((priorId) => tracks.some((entry) => entry.id === priorId))) {
        const nextShared = shotTrackOrder.slice(position + 1).find((nextId) => tracks.some((entry) => entry.id === nextId));
        if (nextShared) insertAt = tracks.findIndex((entry) => entry.id === nextShared);
      }
      if (position >= 0 && !shotTrackOrder.slice(position + 1).some((nextId) => tracks.some((entry) => entry.id === nextId))) {
        insertAt = tracks.length;
      }
      tracks.splice(insertAt, 0, definition);
      trackIds.add(id);
    }
  }
  if (tracks.length === 0) {
    tracks.push({ id: 'video', kind: 'visual', label: 'Video' });
  }
  return tracks;
}

function projectClip(
  rawClip: JsonObject,
  occurrence: CanonicalShotOccurrence,
  clipIndex: number,
  clipIdentities: Map<string, CanonicalClipIdentity>,
  clampToOccurrenceDuration: boolean,
): TimelineClip | null {
  assertSupportedChildClip(rawClip, occurrence);
  const identity = identityForOccurrence(occurrence);
  const clipId = text(rawClip.id) ?? `child-${clipIndex}`;
  const id = `${occurrence.occurrenceId}:${clipId}`;
  // Runtime canonical revisions use one of two timeline encodings:
  // - the transport form (`at_ms`/`duration_ms`), or
  // - the editor form (`at`/`from`/`to`/`hold`), whose times are seconds.
  // Do not treat editor seconds as milliseconds: a 1/24s frame at `at: 0.0417`
  // otherwise collapses to the start of the parent shot and every frame gets
  // the occurrence's full duration, creating a large overlapping render tree.
  const atMs = rawClip.at_ms !== undefined
    ? Math.max(0, finiteNumber(rawClip.at_ms, 0))
    : Math.max(0, finiteNumber(rawClip.at, 0) * 1000);
  const rawFrom = optionalFiniteNumber(rawClip.from);
  const rawTo = optionalFiniteNumber(rawClip.to);
  const hasTrim = rawFrom !== undefined && rawTo !== undefined && rawTo > rawFrom;
  const sourceOffsetMs = Math.max(0, occurrence.sourceOffsetMs ?? 0);
  const sourceOffsetSeconds = sourceOffsetMs / 1000;
  const speed = positiveNumber(rawClip.speed, positiveNumber(occurrence.speed, 1));
  // Persisted duration/hold/trim values are source-media units. Keep that
  // convention in the projected clip; timeline-domain consumers apply speed
  // once when deriving the occurrence extent and render duration.
  const durationMs = rawClip.duration_ms !== undefined
    ? Math.max(1, finiteNumber(rawClip.duration_ms, occurrence.durationMs * speed))
    : rawClip.duration !== undefined
      ? Math.max(1, finiteNumber(rawClip.duration, occurrence.durationMs / 1000 * speed) * 1000)
      : rawClip.hold !== undefined
        ? Math.max(1, finiteNumber(rawClip.hold, occurrence.durationMs / 1000 * speed) * 1000)
        : hasTrim
          ? Math.max(1, (rawTo - rawFrom) * 1000)
          : Math.max(1, occurrence.durationMs * speed);
  // An unset gain stays unset: the effective volume rule (element default, else 1) applies downstream.
  const gain = optionalFiniteNumber(rawClip.gain ?? rawClip.volume) ?? optionalFiniteNumber(occurrence.gain);
  const muted = rawClip.muted === true || rawClip.mute === true || occurrence.muted === true;
  const track = text(rawClip.track) ?? occurrence.trackId ?? 'video';
  const clipType = text(rawClip.clip_type) ?? text(rawClip.clipType) ?? 'media';
  const asset = text(rawClip.asset_id) ?? text(rawClip.asset);
  const params = record(rawClip.params);
  const numberField = (key: string): number | undefined => optionalFiniteNumber(rawClip[key]);
  const preservedGeometry = Object.fromEntries(
    ['x', 'y', 'width', 'height', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight', 'opacity']
      .flatMap((key) => {
        const value = numberField(key);
        return value === undefined ? [] : [[key, value]];
      }),
  );
  const app = record(rawClip.app) ?? {};
  const projected: TimelineClip = {
    id,
    ...(typeof rawClip.enabled === 'boolean' ? { enabled: rawClip.enabled } : {}),
    ...(typeof rawClip.active === 'boolean' ? { active: rawClip.active } : {}),
    ...(typeof rawClip.disabled === 'boolean' ? { disabled: rawClip.disabled } : {}),
    ...(typeof rawClip.hidden === 'boolean' ? { hidden: rawClip.hidden } : {}),
    ...(typeof rawClip.deleted === 'boolean' ? { deleted: rawClip.deleted } : {}),
    at: Math.max(0, occurrence.atMs + atMs) / 1000,
    track,
    clipType,
    ...(text(rawClip.label) ? { label: text(rawClip.label) } : {}),
    ...(asset ? { asset } : {}),
    ...(hasTrim
      ? { from: Math.max(0, rawFrom + sourceOffsetSeconds), to: Math.max(0, rawTo + sourceOffsetSeconds) }
      : sourceOffsetMs > 0 ? { from: sourceOffsetSeconds } : {}),
    ...(speed !== 1 ? { speed } : {}),
    // Transport clips expose duration_ms; editor-form clips with `from`/`to`
    // retain those trim bounds instead of being converted to a parent-sized
    // hold. Hold remains the deterministic fallback for duration-only clips.
    ...(hasTrim ? {} : { hold: durationMs / 1000 }),
    ...(muted ? { volume: 0 } : gain !== undefined ? { volume: gain } : {}),
    ...preservedGeometry,
    ...(params ? { params } : {}),
    ...(record(rawClip.text) ? { text: rawClip.text as TimelineClip['text'] } : {}),
    ...(record(rawClip.effects) || Array.isArray(rawClip.effects) ? { effects: rawClip.effects as TimelineClip['effects'] } : {}),
    ...(record(rawClip.elementRef) ? { elementRef: rawClip.elementRef as TimelineClip['elementRef'] } : {}),
    ...(rawClip.transition !== undefined ? { transition: rawClip.transition as TimelineClip['transition'] } : {}),
    ...(rawClip.entrance !== undefined ? { entrance: rawClip.entrance as TimelineClip['entrance'] } : {}),
    ...(rawClip.exit !== undefined ? { exit: rawClip.exit as TimelineClip['exit'] } : {}),
    ...(rawClip.continuous !== undefined ? { continuous: rawClip.continuous as TimelineClip['continuous'] } : {}),
    ...(record(rawClip.keyframes) ? { keyframes: rawClip.keyframes as TimelineClip['keyframes'] } : {}),
    app: {
      ...app,
      canonical: identity,
      canonicalTiming: {
        sourceOffsetMs,
        speed,
        gain,
        muted,
        durationMs,
        occurrenceStartMs: occurrence.atMs,
        occurrenceDurationMs: occurrence.durationMs,
      },
    },
  };
  // Inactive clips remain editable/re-enableable at their authored geometry;
  // their state excludes them from occurrence extent and render output.
  if (clampToOccurrenceDuration && isActiveTimelineClip(rawClip)) {
    const remainingSeconds = occurrence.durationMs / 1000 - projected.at + occurrence.atMs / 1000;
    if (remainingSeconds <= 0) return null;
    if (hasTrim && projected.from !== undefined && projected.to !== undefined) {
      const maxTrimmedTo = projected.from + remainingSeconds * speed;
      if (projected.to > maxTrimmedTo) {
        projected.to = maxTrimmedTo;
      }
    } else if (projected.hold !== undefined) {
      projected.hold = Math.min(projected.hold, remainingSeconds * speed);
    }
  }
  clipIdentities.set(id, identity);
  return projected;
}

export type CanonicalCompositionProjectionOptions = Readonly<{
  /** Keep shot-local overhang visible so saving can grow the soft wall. */
  clampToOccurrenceDuration?: boolean;
}>;

export function projectCanonicalComposition(
  composition: PreparedShotComposition,
  baseConfig?: ResolvedTimelineConfig | null,
  options: CanonicalCompositionProjectionOptions = {},
): CanonicalCompositionProjection {
  let authoredBaseConfig = baseConfig;
  // Publication carries pinned parent bytes without a separate resolved config.
  // Read authored track roles before constructing the output-only projection.
  if (!authoredBaseConfig) {
    const parent = record(composition.contract.parent_composition);
    const authored = record(parent?.config);
    if (authored) {
      const registry = record(parent?.registry);
      authoredBaseConfig = {
        ...authored,
        output: (record(authored.output) ?? {
          resolution: '1920x1080', fps: 30, file: `timeline-${composition.parentDocumentId}.mp4`,
        }) as ResolvedTimelineConfig['output'],
        tracks: (Array.isArray(authored.tracks) ? authored.tracks : []) as TrackDefinition[],
        clips: (Array.isArray(parent?.clips) ? parent.clips
          : Array.isArray(authored.clips) ? authored.clips : []) as ResolvedTimelineConfig['clips'],
        registry: (record(registry?.assets) ?? registry ?? {}) as ResolvedTimelineConfig['registry'],
      } as ResolvedTimelineConfig;
    }
  }
  const parentTrackRoles = new Map(
    (authoredBaseConfig?.tracks ?? []).map((track) => [track.id, trackRole(track)]),
  );
  const outputBaseConfig = authoredBaseConfig
    ? projectOutputTimelineConfig(authoredBaseConfig).config
    : undefined;
  // Parent lane identity is classified from the unfiltered authored tracks.
  // This must happen before output projection removes Source tracks; otherwise
  // a child track reusing the same ID can make a Source occurrence look legacy.
  const outputOccurrences = composition.occurrences.filter((occurrence) => (
    !occurrence.trackId || parentTrackRoles.get(occurrence.trackId) !== 'source'
  ));
  assertDependencies(composition);
  const clips: TimelineClip[] = [];
  const clipIdentities = new Map<string, CanonicalClipIdentity>();
  const occurrenceIdentities = new Map<string, CanonicalClipIdentity>();

  for (const occurrence of outputOccurrences) {
    const identity = identityForOccurrence(occurrence);
    occurrenceIdentities.set(occurrence.occurrenceId, identity);
    const timeline = outputTimeline(childTimeline(occurrence));
    const contentDurationMs = timelineContentExtentMs(timeline);
    const effectiveDurationMs = timelineOccurrenceEffectiveDurationMs(
      occurrence,
      outputOccurrences,
      contentDurationMs,
    );
    const effectiveOccurrence = { ...occurrence, durationMs: effectiveDurationMs };
    const rawClips = Array.isArray(timeline.clips) ? timeline.clips : [];
    if (rawClips.length === 0) {
      throw new CanonicalCompositionProjectionError(
        'blank_child_output',
        `Canonical occurrence ${occurrence.occurrenceId} has a blank child output`,
        occurrence.occurrenceId,
      );
    }
    rawClips.forEach((rawClip, index) => {
      const clip = record(rawClip);
      if (clip) {
        const projected = projectClip(
          clip,
          effectiveOccurrence,
          index,
          clipIdentities,
          options.clampToOccurrenceDuration !== false,
        );
        if (projected) {
          if (Array.isArray(timeline.effects) && timeline.effects.length > 0) {
            const local = Array.isArray(projected.effects) ? projected.effects : [];
            projected.effects = [...local, ...timeline.effects] as TimelineClip['effects'];
            projected.app = {...projected.app, canonicalEffects: {localCount: local.length, timeline: timeline.effects}};
          }
          clips.push(projected);
        }
      }
    });
    if (!rawClips.some((rawClip) => record(rawClip))) {
      throw new CanonicalCompositionProjectionError(
        'blank_child_output',
        `Canonical occurrence ${occurrence.occurrenceId} has no renderable child clips`,
        occurrence.occurrenceId,
      );
    }
  }

  // Legacy parent shot clips are replaced by the immutable child projection;
  // every other parent clip remains part of the rendered/editor timeline.
  const parentClips = (outputBaseConfig?.clips ?? []).filter((clip) => clip.clipType !== 'shot');
  const { registry, assetAliases } = assetRegistryFor(composition, outputBaseConfig, outputOccurrences);
  // `baseConfig` is already resolved, but projected child clips are created
  // from the persisted canonical graph after that resolution step. Attach the
  // corresponding resolved registry entry here so the renderer can consume
  // the projection directly. Without this, the asset exists in `registry`
  // while `VisualClip` still sees an assetless clip and renders its loud
  // missing-asset placeholder.
  const projectedClips = [...parentClips, ...clips].map((clip) => {
    const occurrenceId = clipIdentities.get(clip.id)?.occurrenceId;
    const asset = clip.asset && occurrenceId
      ? assetAliases.get(`${occurrenceId}\u0000${clip.asset}`) ?? clip.asset
      : clip.asset;
    // Runtime authoring calls still-image clips `image`; the browser's native
    // still-image renderer and export contract call them `hold`. Normalize the
    // read model only, retaining the canonical document and its clip identity.
    const clipType = clip.clipType === 'image' ? 'hold' : clip.clipType;
    return { ...clip, clipType, ...(asset ? { asset } : {}), assetEntry: asset ? registry[asset] : undefined };
  });
  const output = outputBaseConfig?.output ?? { resolution: '1920x1080', fps: 30, file: `timeline-${composition.parentDocumentId}.mp4` };
  const baseApp = record(outputBaseConfig?.app) ?? {};
  const configBase: ResolvedTimelineConfig = {
    output,
    tracks: tracksFor(composition, outputBaseConfig, outputOccurrences),
    clips: projectedClips,
    registry,
    ...(outputBaseConfig?.effects ? {effects: outputBaseConfig.effects} : {}),
    ...(outputBaseConfig?.theme ? { theme: outputBaseConfig.theme } : {}),
    ...(outputBaseConfig?.theme_overrides ? { theme_overrides: outputBaseConfig.theme_overrides } : {}),
    ...(outputBaseConfig?.generation_defaults ? { generation_defaults: outputBaseConfig.generation_defaults } : {}),
    app: {
      ...baseApp,
      canonicalComposition: {
        projectId: composition.projectId,
        parentDocumentId: composition.parentDocumentId,
        headRevisionId: composition.headRevisionId,
        occurrenceIds: outputOccurrences.map((occurrence) => occurrence.occurrenceId),
      },
    },
  };
  const visualSeamReport = analyzeVisualSeams(configBase, { enforceIntent: true });
  const baseVisualSeamContract = record(baseApp.visualSeamContract) ?? {};
  const config: ResolvedTimelineConfig = {
    ...configBase,
    app: {
      ...(configBase.app ?? {}),
      visualSeamContract: {
        ...baseVisualSeamContract,
        version: visualSeamReport.version,
        mode: 'enforced',
        report: visualSeamReport,
      },
    },
  };

  return Object.freeze({
    config,
    clipIdentities,
    occurrenceIdentities,
  });
}

export function canonicalOccurrenceKey(occurrence: Pick<CanonicalShotOccurrence, 'occurrenceId'>): string {
  return occurrence.occurrenceId;
}

export function managedOutputIdentityForOccurrence(
  output: JsonObject,
): { occurrenceId?: string; outputIdentity?: string } {
  const provenance = record(output.provenance);
  const metadata = record(output.metadata);
  const params = record(output.params);
  const occurrenceId = text(output.occurrence_id)
    ?? text(provenance?.occurrence_id)
    ?? text(metadata?.occurrence_id)
    ?? text(params?.occurrence_id);
  const outputIdentity = text(output.output_identity)
    ?? text(provenance?.output_identity)
    ?? text(metadata?.output_identity)
    ?? text(params?.output_identity);
  return { occurrenceId, outputIdentity };
}

export function managedOutputMatchesOccurrence(
  output: JsonObject,
  occurrence: Pick<CanonicalShotOccurrence, 'occurrenceId' | 'outputIdentity'>,
): boolean {
  const identity = managedOutputIdentityForOccurrence(output);
  return identity.occurrenceId === occurrence.occurrenceId
    || identity.outputIdentity === occurrence.outputIdentity;
}

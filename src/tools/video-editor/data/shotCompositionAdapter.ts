import {
  parseShotComposition,
  StaleWriteError,
  type ShotCompositionContract,
} from './shotComposition.ts';
import {
  isActiveTimelineClip,
  timelineClipDurationMs,
  timelineClipStartMs,
} from './shotCompositionTiming.ts';
import { assertVisualSeamAdmission } from './visualSeamContract.ts';
import { projectCanonicalComposition } from './shotCompositionProjection.ts';

type JsonObject = Record<string, unknown>;

export type ShotCompositionReadRequest = Readonly<{
  projectId: string;
  parentDocumentId: string;
  /** Background readers may share a recently checked head. */
  poll?: boolean;
}>;

/** Parent-head geometry available before child revisions are hydrated. */
export type ShotPlacement = Readonly<{
  occurrenceId: string;
  shotId: string;
  ordinal: number;
  atMs: number;
  durationMs: number;
  trackId: string;
}>;

export type ShotCompositionHeadReadRequest = ShotCompositionReadRequest & Readonly<{
  /** Immutable parent revision to resolve; never re-read the mutable head. */
  headRevisionId: string;
}>;

export type ShotCompositionPublicationReceipt = Readonly<{
  receiptId?: string;
  idempotencyKey?: string;
  requestHash?: string;
  expectedHead?: string | null;
  newHead: string;
  changedIdentities?: readonly string[];
  diff?: JsonObject;
  raw?: JsonObject;
}>;

export type CanonicalShotCompositionHistoryEntry = Readonly<{
  revisionId: string;
  projectId: string;
  parentDocumentId: string;
  contentDigest: string;
  createdAt: string;
  isCurrentHead: boolean;
}>;

export type ShotCompositionHistoryRequest = ShotCompositionReadRequest;

export type ShotCompositionHistoryRestoreRequest = ShotCompositionReadRequest & Readonly<{
  revisionId: string;
  /** The publication the user reviewed. Required by Runtime-backed restores. */
  reviewedHead?: Readonly<{ revisionId: string; publicationId: string }>;
}>;

export type ShotCompositionHistoryRestoreReceipt = Readonly<{
  newHead: string;
}>;

export type ShotCompositionPublishRequest = Readonly<{
  projectId: string;
  parentDocumentId: string;
  expectedHeadRevisionId: string | null;
  graph: ShotCompositionContract;
  /** Reuse this key when retrying the same candidate after a lost response. */
  idempotencyKey?: string;
  /** Development trace correlation only; not part of the committed graph. */
  timingTraceId?: string;
}>;

/**
 * Product-facing I/O port for the canonical graph.
 *
 * Runtime/bridge clients implement this port. The adapter never imports a
 * transport or React provider, which keeps all graph tests
 * deterministic and makes the expected-head CAS explicit at the boundary.
 */
export interface ShotCompositionPort {
  load(request: ShotCompositionReadRequest): Promise<unknown>;
  loadPlacements?(request: ShotCompositionReadRequest): Promise<readonly ShotPlacement[]>;
  loadAtHead?(request: ShotCompositionHeadReadRequest): Promise<unknown>;
  publish?(request: ShotCompositionPublishRequest): Promise<unknown>;
  listHistory?(request: ShotCompositionHistoryRequest): Promise<readonly CanonicalShotCompositionHistoryEntry[]>;
  restoreHistory?(request: ShotCompositionHistoryRestoreRequest): Promise<ShotCompositionHistoryRestoreReceipt>;
  getSourceFrameThumbnailUrl?(request: SourceFrameThumbnailRequest): Promise<string | null>;
}

export type SourceFrameThumbnailRequest = Readonly<{
  projectId: string;
  sourceObjectId: string;
  sourceTimeSeconds: number;
  recipeVersion?: number;
}>;

export class ShotCompositionUnavailableError extends Error {
  readonly code = 'shot_composition_unavailable' as const;

  constructor(message = 'The canonical shot-composition graph is unavailable') {
    super(message);
    this.name = 'ShotCompositionUnavailableError';
  }
}

export type CanonicalShotOccurrence = Readonly<{
  projectId: string;
  occurrenceId: string;
  parentDocumentId: string;
  shotId: string;
  revisionId: string;
  ordinal: number;
  atMs: number;
  durationMs: number;
  stableDeepLink: string;
  outputIdentity: string;
  trackId?: string;
  sourceOffsetMs?: number;
  speed?: number;
  gain?: number;
  muted?: boolean;
  transform?: JsonObject;
  textBindings?: readonly JsonObject[];
  revision: JsonObject;
}>;

export type PreparedShotComposition = Readonly<{
  contract: ShotCompositionContract;
  projectId: string;
  parentDocumentId: string;
  headRevisionId: string;
  occurrences: readonly CanonicalShotOccurrence[];
  /** Durable publication receipt, when this graph is the result of a commit. */
  publicationReceipt?: ShotCompositionPublicationReceipt;
}>;

function record(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ShotCompositionUnavailableError(`${label} is not an object`);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ShotCompositionUnavailableError(`${label} is missing`);
  }
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ShotCompositionUnavailableError(`${label} is invalid`);
  }
  return value;
}

function isConflict(error: unknown): boolean {
  return error instanceof Error
    && ('status' in error && (error as Error & { status?: unknown }).status === 409
      || 'statusCode' in error && (error as Error & { statusCode?: unknown }).statusCode === 409
      || 'code' in error && ['conflict', 'stale_write', 'document_version_conflict'].includes(
        String((error as Error & { code?: unknown }).code),
      ));
}

function publicationReceipt(value: unknown): ShotCompositionPublicationReceipt | undefined {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
  if (!candidate || typeof candidate.new_head !== 'string' || candidate.new_head.length === 0) return undefined;
  const changed = candidate.changed_identities;
  return Object.freeze({
    ...(typeof candidate.receipt_id === 'string' ? { receiptId: candidate.receipt_id } : {}),
    ...(typeof candidate.idempotency_key === 'string' ? { idempotencyKey: candidate.idempotency_key } : {}),
    ...(typeof candidate.request_hash === 'string' ? { requestHash: candidate.request_hash } : {}),
    ...(candidate.expected_head === null || typeof candidate.expected_head === 'string' ? { expectedHead: candidate.expected_head } : {}),
    newHead: candidate.new_head,
    ...(Array.isArray(changed) ? { changedIdentities: changed.filter((item): item is string => typeof item === 'string') } : {}),
    ...(candidate.diff && typeof candidate.diff === 'object' && !Array.isArray(candidate.diff) ? { diff: candidate.diff as JsonObject } : {}),
    raw: candidate,
  });
}

function prepareContract(contract: ShotCompositionContract): PreparedShotComposition {
  const project = record(contract.project, 'project');
  const primaryTimeline = record(contract.primary_timeline, 'primary_timeline');
  const head = record(primaryTimeline.head, 'primary_timeline.head');
  const projectId = requiredString(project.project_id, 'project.project_id');
  const parentDocumentId = requiredString(project.document_id, 'project.document_id');
  const headRevisionId = requiredString(head.revision_id, 'primary_timeline.head.revision_id');
  const revisions = new Map(
    contract.shot_revisions.map((revision) => [
      `${String(revision.shot_id)}\u0000${String(revision.revision_id)}`,
      revision,
    ]),
  );

  const occurrences = contract.occurrences
    .map((rawOccurrence) => {
      const occurrence = record(rawOccurrence, 'occurrence');
      const shotId = requiredString(occurrence.shot_id, 'occurrence.shot_id');
      const revisionId = requiredString(occurrence.revision_id, 'occurrence.revision_id');
      const revision = revisions.get(`${shotId}\u0000${revisionId}`);
      if (!revision) {
        throw new ShotCompositionUnavailableError(
          `occurrence ${String(occurrence.occurrence_id)} references a missing revision`,
        );
      }
      return Object.freeze({
        projectId,
        occurrenceId: requiredString(occurrence.occurrence_id, 'occurrence.occurrence_id'),
        parentDocumentId: requiredString(occurrence.parent_document_id, 'occurrence.parent_document_id'),
        shotId,
        revisionId,
        ordinal: requiredNumber(occurrence.ordinal, 'occurrence.ordinal'),
        atMs: requiredNumber(occurrence.at_ms, 'occurrence.at_ms'),
        durationMs: requiredNumber(occurrence.duration_ms, 'occurrence.duration_ms'),
        stableDeepLink: requiredString(occurrence.stable_deep_link, 'occurrence.stable_deep_link'),
        outputIdentity: requiredString(occurrence.output_identity, 'occurrence.output_identity'),
        ...(typeof occurrence.track === 'string' && occurrence.track.length > 0
          ? { trackId: occurrence.track }
          : {}),
        ...(typeof occurrence.source_offset === 'number' && Number.isFinite(occurrence.source_offset)
          ? { sourceOffsetMs: occurrence.source_offset }
          : {}),
        ...(typeof occurrence.speed === 'number' && Number.isFinite(occurrence.speed) && occurrence.speed > 0
          ? { speed: occurrence.speed }
          : {}),
        ...(typeof occurrence.gain === 'number' && Number.isFinite(occurrence.gain)
          ? { gain: occurrence.gain }
          : {}),
        ...(typeof occurrence.muted === 'boolean' ? { muted: occurrence.muted } : {}),
        ...(occurrence.transform !== undefined && occurrence.transform !== null && typeof occurrence.transform === 'object' && !Array.isArray(occurrence.transform)
          ? { transform: occurrence.transform as JsonObject }
          : {}),
        ...(Array.isArray(occurrence.text_bindings)
          ? { textBindings: occurrence.text_bindings.filter((value): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)) }
          : {}),
        revision,
      });
    })
    .sort((left, right) => left.ordinal - right.ordinal);

  return Object.freeze({
    contract,
    projectId,
    parentDocumentId,
    headRevisionId,
    occurrences: Object.freeze(occurrences),
    ...(publicationReceipt(contract.publication_receipt) ? { publicationReceipt: publicationReceipt(contract.publication_receipt) } : {}),
  });
}

function assertRequestIdentity(
  composition: PreparedShotComposition,
  request: ShotCompositionReadRequest | ShotCompositionPublishRequest,
): void {
  if (composition.projectId !== request.projectId) {
    throw new ShotCompositionUnavailableError(
      `Canonical composition belongs to project ${composition.projectId}, not ${request.projectId}`,
    );
  }
  if (composition.parentDocumentId !== request.parentDocumentId) {
    throw new ShotCompositionUnavailableError(
      `Canonical composition belongs to timeline ${composition.parentDocumentId}, not ${request.parentDocumentId}`,
    );
  }
  const primaryTimeline = record(composition.contract.primary_timeline, 'primary_timeline');
  const primaryDocumentId = requiredString(primaryTimeline.document_id, 'primary_timeline.document_id');
  if (primaryDocumentId !== request.parentDocumentId) {
    throw new ShotCompositionUnavailableError(
      `Canonical primary timeline belongs to ${primaryDocumentId}, not ${request.parentDocumentId}`,
    );
  }
}

export function createShotCompositionAdapter(port: ShotCompositionPort) {
  return {
    getSourceFrameThumbnailUrl: port.getSourceFrameThumbnailUrl
      ? (request: SourceFrameThumbnailRequest) => port.getSourceFrameThumbnailUrl!(request)
      : undefined,
    async load(request: ShotCompositionReadRequest): Promise<PreparedShotComposition> {
      try {
        const composition = prepareContract(parseShotComposition(await port.load(request)));
        assertRequestIdentity(composition, request);
        return composition;
      } catch (error) {
        if (error instanceof ShotCompositionUnavailableError) throw error;
        throw error;
      }
    },

    async loadAtHead(request: ShotCompositionHeadReadRequest): Promise<PreparedShotComposition> {
      if (!port.loadAtHead) {
        throw new ShotCompositionUnavailableError('The canonical shot-composition provider cannot resolve an exact head');
      }
      requiredString(request.headRevisionId, 'headRevisionId');
      const composition = prepareContract(parseShotComposition(await port.loadAtHead(request)));
      assertRequestIdentity(composition, request);
      if (composition.headRevisionId !== request.headRevisionId) {
        throw new ShotCompositionUnavailableError(
          `Canonical composition resolved head ${composition.headRevisionId}, not requested ${request.headRevisionId}`,
        );
      }
      return composition;
    },

    prepare(raw: unknown): PreparedShotComposition {
      return prepareContract(parseShotComposition(raw));
    },

    async publish(request: ShotCompositionPublishRequest): Promise<PreparedShotComposition> {
      if (!port.publish) {
        throw new ShotCompositionUnavailableError('The canonical shot-composition provider is read-only');
      }
      // Validate the submitted graph before crossing the port. The submitted
      // graph may advance the head; expectedHeadRevisionId is the old head the
      // Runtime must compare-and-swap against.
      const submitted = prepareContract(parseShotComposition(request.graph));
      assertRequestIdentity(submitted, request);
      // Publication is the last local authoring choke point before Runtime
      // owns the graph. Reuse the exact canonical projection used by preview
      // and export, and fail closed only for frame-near structural seams or
      // undeclared custom/phase cues.
      const seamProjection = projectCanonicalComposition(submitted);
      assertVisualSeamAdmission(seamProjection.config, { enforceIntent: true });
      if (request.expectedHeadRevisionId !== null) {
        requiredString(request.expectedHeadRevisionId, 'expectedHeadRevisionId');
      }
      try {
        const published = await port.publish(request);
        const composition = prepareContract(parseShotComposition(published));
        assertRequestIdentity(composition, request);
        return composition;
      } catch (error) {
        if (error instanceof StaleWriteError) throw error;
        if (isConflict(error)) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new StaleWriteError(`stale shot-composition write: ${detail}`);
        }
        throw error;
      }
    },
  };
}

export type ShotCompositionAdapter = ReturnType<typeof createShotCompositionAdapter>;

function objectRecord(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function visualAssetKind(asset: JsonObject, clip: JsonObject): 'image' | 'video' | undefined {
  const raw = stringValue(asset.media_type) ?? stringValue(asset.type)
    ?? stringValue(clip.clip_type) ?? stringValue(clip.clipType);
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === 'video' || normalized.startsWith('video/')) return 'video';
  if (normalized === 'image' || normalized.startsWith('image/')) return 'image';
  return undefined;
}

/**
 * Resolve the one deterministic source-frame key shared by repair and read.
 * The midpoint is measured in shot playback time; trim and speed are applied
 * exactly once when mapping it back to source-media time.
 */
export function canonicalSourceFrameRequest(
  occurrence: CanonicalShotOccurrence,
): SourceFrameThumbnailRequest | null {
  const revision = objectRecord(occurrence.revision);
  const internal = objectRecord(revision?.internal_timeline_revision);
  const timeline = objectRecord(internal?.timeline);
  const rawAssets = Array.isArray(revision?.assets) ? revision.assets : [];
  const assets = new Map<string, JsonObject>();
  for (const rawAsset of rawAssets) {
    const asset = objectRecord(rawAsset);
    const assetId = stringValue(asset?.asset_id);
    if (asset && assetId) assets.set(assetId, asset);
  }
  const tracks = Array.isArray(timeline?.tracks) ? timeline.tracks : [];
  const primaryVisualTrack = tracks.find((rawTrack) => {
    const track = objectRecord(rawTrack);
    return track?.kind === 'visual' && typeof track.id === 'string';
  });
  const primaryVisualTrackId = objectRecord(primaryVisualTrack)?.id;
  if (typeof primaryVisualTrackId !== 'string') return null;
  const visualClips = (Array.isArray(timeline?.clips) ? timeline.clips : [])
    .filter(isActiveTimelineClip)
    .map((rawClip) => {
      const clip = objectRecord(rawClip);
      if (!clip) return null;
      const asset = assets.get(stringValue(clip.asset_id) ?? stringValue(clip.asset) ?? '');
      if (!asset || clip.track !== primaryVisualTrackId || visualAssetKind(asset, clip) !== 'video') return null;
      const startMs = timelineClipStartMs(clip);
      const durationMs = timelineClipDurationMs(clip);
      if (durationMs <= 0) return null;
      const rawSpeed = finite(clip.speed);
      const speed = rawSpeed !== undefined && rawSpeed > 0 ? rawSpeed : 1;
      const sourceFrom = finite(clip.from)
        ?? (finite(clip.from_ms) !== undefined ? (finite(clip.from_ms) as number) / 1000 : 0);
      const sourceObjectId = stringValue(asset.object_id) ?? stringValue(asset.media_id);
      if (!sourceObjectId) return null;
      return { clip, asset, startMs, durationMs, speed, sourceFrom, sourceObjectId };
    })
    .filter((clip): clip is NonNullable<typeof clip> => clip !== null)
    .sort((left, right) => left.startMs - right.startMs);
  if (visualClips.length === 0) return null;

  const targetMs = Math.max(0, occurrence.durationMs / 2);
  const selected = visualClips.reduce((best, candidate) => {
    const candidateEnd = candidate.startMs + candidate.durationMs;
    const bestEnd = best.startMs + best.durationMs;
    const candidateDistance = targetMs < candidate.startMs
      ? candidate.startMs - targetMs
      : targetMs > candidateEnd ? targetMs - candidateEnd : 0;
    const bestDistance = targetMs < best.startMs
      ? best.startMs - targetMs
      : targetMs > bestEnd ? targetMs - bestEnd : 0;
    return candidateDistance < bestDistance
      || (candidateDistance === bestDistance && candidate.startMs < best.startMs)
      ? candidate
      : best;
  });
  const localMs = Math.min(
    selected.durationMs,
    Math.max(0, targetMs - selected.startMs),
  );
  const sourceTimeSeconds = selected.sourceFrom
    + (localMs / 1000) * selected.speed;
  if (!Number.isFinite(sourceTimeSeconds) || sourceTimeSeconds < 0) return null;
  return {
    projectId: occurrence.projectId,
    sourceObjectId: selected.sourceObjectId,
    sourceTimeSeconds,
    recipeVersion: 1,
  };
}

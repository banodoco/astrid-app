import {
  stableOccurrenceDeepLink,
  stableOutputIdentity,
  type ShotCompositionContract,
} from './shotComposition.ts';
import { createShotCompositionAdapter } from './shotCompositionAdapter.ts';
import { projectCanonicalComposition } from './shotCompositionProjection.ts';
import { timelineContentExtentMs } from './shotCompositionTiming.ts';
import { remapDeclaredVisualPauseEdges } from './visualSeamContract.ts';

type JsonObject = Record<string, unknown>;

function defineOwn(target: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

const canonicalPublishQueues = new Map<string, Promise<unknown>>();

/** Serialize all canonical edits for one project/timeline CAS head. */
export function enqueueCanonicalShotPublish<T>(
  projectId: string,
  parentDocumentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${projectId}\u0000${parentDocumentId}`;
  const previous = canonicalPublishQueues.get(key);
  const queued = previous
    ? previous.catch(() => {}).then(operation)
    : operation();
  canonicalPublishQueues.set(key, queued);
  void queued.then(
    () => {
      if (canonicalPublishQueues.get(key) === queued) canonicalPublishQueues.delete(key);
    },
    () => {
      if (canonicalPublishQueues.get(key) === queued) canonicalPublishQueues.delete(key);
    },
  );
  return queued;
}

export type CanonicalOccurrenceEdit = Readonly<{
  occurrenceId: string;
  atMs?: number;
  durationMs?: number;
}>;

export type CanonicalShotRevisionPatch = Readonly<{
  settings?: JsonObject;
  provenance?: JsonObject;
  timeline?: JsonObject;
  /** Revision-scoped admitted media declarations; bytes stay in Runtime. */
  assets?: readonly JsonObject[];
  /** Per-occurrence duration discovered while saving a shot-local timeline. */
  occurrenceDurationMs?: number;
  /** Stable identity seed for replaying one popup publication after response loss. */
  identitySeed?: string;
}>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function digestJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function newIdentity(prefix: string, identitySeed?: string): string {
  if (identitySeed) return `${prefix}-${identitySeed}`;
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function occurrenceIndex(graph: ShotCompositionContract, occurrenceId: string): number {
  const index = graph.occurrences.findIndex((occurrence) => occurrence.occurrence_id === occurrenceId);
  if (index < 0) throw new Error(`canonical occurrence ${occurrenceId} is missing`);
  return index;
}

function withOccurrenceIdentity(
  graph: ShotCompositionContract,
  occurrence: JsonObject,
  occurrenceId: string,
): JsonObject {
  const projectId = String(graph.project.project_id);
  const documentId = String(graph.project.document_id);
  const shotId = String(occurrence.shot_id);
  const revisionId = String(occurrence.revision_id);
  return {
    ...occurrence,
    occurrence_id: occurrenceId,
    stable_deep_link: stableOccurrenceDeepLink(projectId, documentId, shotId, revisionId, occurrenceId),
    output_identity: stableOutputIdentity(projectId, documentId, occurrenceId),
  };
}

function revisionPayload(revision: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(revision).filter(([key]) => ![
    'shot_id',
    'revision_id',
    'document_role',
    'content_digest',
    'internal_timeline_revision',
  ].includes(key)));
}

function internalTimelinePayload(internal: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(internal).filter(([key]) => ![
    'revision_id',
    'content_digest',
    'publish',
  ].includes(key)));
}

function remapOwnedItemReferences(value: unknown, itemIds: Map<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => remapOwnedItemReferences(item, itemIds));
  }
  if (value === null || typeof value !== 'object') return value;
  const row = value as JsonObject;
  const next: JsonObject = {};
  for (const [childKey, child] of Object.entries(row)) {
    if ((childKey === 'item_id' || childKey.endsWith('_item_id')) && typeof child === 'string') {
      defineOwn(next, childKey, itemIds.get(child) ?? child);
    } else if ((childKey === 'item_ids' || childKey.endsWith('_item_ids')) && Array.isArray(child)) {
      defineOwn(next, childKey, child.map((item) => typeof item === 'string' ? (itemIds.get(item) ?? item) : item));
    } else {
      defineOwn(next, childKey, remapOwnedItemReferences(child, itemIds));
    }
  }
  return next;
}

function remapIndependentInternalTimeline(value: unknown, prefix: string): JsonObject {
  const internal = clone(value as JsonObject);
  const timeline = record(internal.timeline);
  if (!timeline || !Array.isArray(timeline.clips)) return internal;
  internal.timeline = {
    ...timeline,
    clips: timeline.clips.map((clip) => {
      const row = record(clip);
      return row && typeof row.id === 'string'
        ? {...row, id: `${prefix}:${row.id}`}
        : clip;
    }),
  };
  return internal;
}

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function parentLaneKey(occurrence: JsonObject): string {
  const placement = record(occurrence.placement);
  const track = occurrence.track ?? placement?.track;
  return typeof track === 'string' && track.length > 0 ? track : 'video';
}

function occurrenceContentExtentMs(graph: ShotCompositionContract, occurrence: JsonObject): number {
  const revision = graph.shot_revisions.find((candidate) => (
    String(candidate.shot_id) === String(occurrence.shot_id)
    && String(candidate.revision_id) === String(occurrence.revision_id)
  ));
  const internal = record(revision?.internal_timeline_revision);
  return timelineContentExtentMs(internal?.timeline);
}

function effectiveOccurrenceEndMs(graph: ShotCompositionContract, occurrence: JsonObject): number {
  return Math.max(0, Number(occurrence.at_ms ?? 0)) + occurrenceContentExtentMs(graph, occurrence);
}

function sameLaneOccurrences(graph: ShotCompositionContract, occurrenceId: string): JsonObject[] {
  const current = graph.occurrences.find((candidate) => candidate.occurrence_id === occurrenceId);
  if (!current) return [];
  const lane = parentLaneKey(current);
  return graph.occurrences
    .filter((candidate) => candidate.occurrence_id !== occurrenceId && parentLaneKey(candidate) === lane)
    .map((candidate) => candidate as JsonObject);
}

/** The next same-lane occurrence is the hard, half-open end boundary. */
export function hardDurationMs(graph: ShotCompositionContract, occurrenceId: string, atMs?: number): number | undefined {
  const occurrence = graph.occurrences.find((candidate) => candidate.occurrence_id === occurrenceId);
  if (!occurrence) return undefined;
  const startMs = atMs ?? Number(occurrence.at_ms);
  const next = sameLaneOccurrences(graph, occurrenceId)
    .sort((left, right) => (
      Number(left.at_ms) - Number(right.at_ms)
      || Number(left.ordinal) - Number(right.ordinal)
    ))
    .find((candidate) => Number(candidate.at_ms) >= startMs);
  return next ? Math.max(0, Number(next.at_ms) - startMs) : undefined;
}

function assertParentLanePlacement(
  graph: ShotCompositionContract,
  occurrenceId: string,
  atMs: number,
  durationMs: number,
): void {
  if (durationMs === 0) return;
  const endMs = atMs + durationMs;
  const overlap = sameLaneOccurrences(graph, occurrenceId).find((candidate) => (
    atMs < effectiveOccurrenceEndMs(graph, candidate) && Number(candidate.at_ms) < endMs
  ));
  if (overlap) {
    throw new Error(
      `Shot occurrence ${occurrenceId} would cross same-lane blocker ${String(overlap.occurrence_id)}`,
    );
  }
}

/**
 * Create an immutable child revision for an editor-level shot change.
 *
 * Shot occurrences pin immutable revisions. Updating the old revision in place
 * makes Runtime reject the publication as an identity reuse, so a shot edit
 * gets a new revision for the targeted occurrence only. Other occurrences that
 * happened to share the old revision remain linked to that immutable history;
 * an explicit duplicate/edit operation can materialize them independently.
 */
export async function updateCanonicalShotRevision(
  graph: ShotCompositionContract,
  occurrenceId: string,
  patch: CanonicalShotRevisionPatch,
): Promise<ShotCompositionContract> {
  const next = clone(graph);
  const occurrenceIndex = next.occurrences.findIndex((occurrence) => occurrence.occurrence_id === occurrenceId);
  if (occurrenceIndex < 0) throw new Error(`canonical occurrence ${occurrenceId} is missing`);

  const sourceOccurrence = next.occurrences[occurrenceIndex];
  const sharedSource = next.occurrences.some((candidate, index) => (
    index !== occurrenceIndex
    && candidate.shot_id === sourceOccurrence.shot_id
  ));
  const targetShotId = sharedSource
    ? newIdentity(`shot-${String(sourceOccurrence.shot_id)}`, patch.identitySeed ? `${patch.identitySeed}-shot` : undefined)
    : String(sourceOccurrence.shot_id);
  const sourceRevisionIndex = next.shot_revisions.findIndex((revision) => (
    revision.shot_id === sourceOccurrence.shot_id
    && revision.revision_id === sourceOccurrence.revision_id
  ));
  if (sourceRevisionIndex < 0) throw new Error(`canonical shot revision ${sourceOccurrence.shot_id}/${sourceOccurrence.revision_id} is missing`);

  const sourceRevision = next.shot_revisions[sourceRevisionIndex];
  const sourceInternal = record(sourceRevision.internal_timeline_revision);
  const occurrenceDurationMs = patch.timeline
    ? timelineContentExtentMs(patch.timeline)
    : patch.occurrenceDurationMs ?? timelineContentExtentMs(sourceInternal?.timeline);
  if (occurrenceDurationMs !== undefined) {
    requireNonNegativeInteger(occurrenceDurationMs, 'occurrenceDurationMs');
    const hardLimitMs = hardDurationMs(next, String(sourceOccurrence.occurrence_id));
    if (hardLimitMs !== undefined && occurrenceDurationMs > hardLimitMs) {
      throw new Error(`Shot content would cross the next shot at ${hardLimitMs / 1000}s`);
    }
    next.occurrences[occurrenceIndex] = {
      ...next.occurrences[occurrenceIndex],
      duration_ms: occurrenceDurationMs,
    };
  }
  const revisionId = newIdentity(`shot-revision-${String(sourceOccurrence.shot_id)}`, patch.identitySeed ? `${patch.identitySeed}-revision` : undefined);
  if (!sourceInternal) throw new Error('canonical shot revision internal timeline is missing');
  const updatedInternal = patch.timeline
    ? {
        ...sourceInternal,
        revision_id: newIdentity(`timeline-${String(sourceOccurrence.shot_id)}`, patch.identitySeed ? `${patch.identitySeed}-timeline` : undefined),
        publish: true,
        timeline: clone(patch.timeline),
      }
    : undefined;
  const updatedRevision: JsonObject = {
    ...sourceRevision,
    shot_id: targetShotId,
    revision_id: revisionId,
    publish: true,
    ...(patch.settings ? { settings: clone(patch.settings) } : {}),
    ...(patch.provenance ? { provenance: clone(patch.provenance) } : {}),
    ...(patch.assets ? { assets: clone(patch.assets) } : {}),
    ...(updatedInternal ? { internal_timeline_revision: updatedInternal } : {}),
    ...(occurrenceDurationMs !== undefined
      ? { timing: { ...(record(sourceRevision.timing) ?? {}), duration_ms: occurrenceDurationMs } }
      : {}),
  };
  if (sharedSource) {
    const sourceItems = Array.isArray(updatedRevision.items) ? updatedRevision.items : [];
    const itemIds = new Map<string, string>();
    for (const item of sourceItems) {
      const row = record(item);
      if (row && typeof row.item_id === 'string') itemIds.set(row.item_id, `${targetShotId}:${row.item_id}`);
    }
    if (updatedRevision.internal_timeline_revision) {
      updatedRevision.internal_timeline_revision = remapIndependentInternalTimeline(
        updatedRevision.internal_timeline_revision,
        targetShotId,
      );
    }
    const remapped = remapOwnedItemReferences(updatedRevision, itemIds);
    if (remapped && typeof remapped === 'object') {
      for (const [key, value] of Object.entries(remapped as JsonObject)) {
        defineOwn(updatedRevision, key, value);
      }
    }
  }
  const finalInternal = record(updatedRevision.internal_timeline_revision);
  if (finalInternal && (updatedInternal || sharedSource)) {
    if (sharedSource && !updatedInternal) {
      finalInternal.revision_id = newIdentity(`timeline-${String(sourceOccurrence.shot_id)}`, patch.identitySeed ? `${patch.identitySeed}-timeline` : undefined);
      finalInternal.publish = true;
    }
    finalInternal.content_digest = await digestJson(internalTimelinePayload(finalInternal));
  }
  updatedRevision.content_digest = await digestJson(revisionPayload(updatedRevision));
  // Keep the source revision in the graph. Runtime revisions are immutable;
  // the new revision is appended as a child rather than replacing history.
  next.shot_revisions.push(updatedRevision);

  next.occurrences[occurrenceIndex] = withOccurrenceIdentity(next, {
    ...next.occurrences[occurrenceIndex],
    shot_id: targetShotId,
    revision_id: revisionId,
  }, String(sourceOccurrence.occurrence_id));

  const parentComposition = record(next.parent_composition);
  if (parentComposition && Array.isArray(parentComposition.occurrences)) {
    const nextOccurrencesById = new Map(next.occurrences.map((occurrence) => [String(occurrence.occurrence_id), occurrence]));
    const parentOccurrences = parentComposition.occurrences.map((rawOccurrence) => {
      const occurrence = record(rawOccurrence);
      if (!occurrence) {
        return rawOccurrence;
      }
      const canonicalOccurrence = nextOccurrencesById.get(String(occurrence.occurrence_id));
      if (!canonicalOccurrence) return rawOccurrence;
      const existingPlacement = record(occurrence.placement) ?? {};
      return {
        ...occurrence,
        revision_id: canonicalOccurrence.revision_id,
        shot_revision_id: canonicalOccurrence.revision_id,
        duration_ms: canonicalOccurrence.duration_ms,
        placement: {
          ...existingPlacement,
          // Canonical occurrence timing wins over any stale nested placement.
          start_ms: canonicalOccurrence.at_ms,
        },
      };
    });
    next.parent_composition = { ...parentComposition, occurrences: parentOccurrences };
  }

  const nextHeadRevisionId = newIdentity('composition-revision', patch.identitySeed ? `${patch.identitySeed}-head` : undefined);
  const nextParentPayload = record(next.parent_composition) ?? { occurrences: next.occurrences };
  const primaryTimeline = record(next.primary_timeline);
  const head = primaryTimeline ? record(primaryTimeline.head) : null;
  if (!primaryTimeline || !head) throw new Error('canonical primary timeline head is missing');
  next.primary_timeline = {
    ...primaryTimeline,
    head: {
      ...head,
      revision_id: nextHeadRevisionId,
      content_digest: await digestJson(nextParentPayload),
    },
  };

  const cases = record(next.cases);
  const staleWrite = cases ? record(cases.stale_write_rejection) : null;
  if (cases && staleWrite) {
    next.cases = {
      ...cases,
      stale_write_rejection: {
        ...staleWrite,
        submitted_head_revision_id: nextHeadRevisionId,
      },
    };
  }

  return next;
}

export function updateCanonicalShotSettings(
  graph: ShotCompositionContract,
  occurrenceId: string,
  settings: JsonObject,
): Promise<ShotCompositionContract> {
  return updateCanonicalShotRevision(graph, occurrenceId, { settings });
}

export type CanonicalMediaReplacement = Readonly<{
  /** Existing selected asset key in the shot-local timeline. */
  fromAssetId: string;
  /** Explicitly admitted replacement asset key; never resolves "latest". */
  assetId: string;
  /** Optional complete immutable declaration returned by media admission. */
  asset?: JsonObject;
}>;

/**
 * Replace one admitted media selection through the same immutable revision/CAS
 * path as direct timeline edits. The helper is deliberately asset-key based:
 * importing/admitting bytes is a separate operation and no storage lookup or
 * implicit variant selection occurs here.
 */
export async function replaceCanonicalMedia(
  graph: ShotCompositionContract,
  occurrenceId: string,
  replacement: CanonicalMediaReplacement,
): Promise<ShotCompositionContract> {
  if (!replacement.fromAssetId || !replacement.assetId) {
    throw new Error('replace_media requires explicit fromAssetId and assetId');
  }
  const occurrence = graph.occurrences.find((candidate) => candidate.occurrence_id === occurrenceId);
  if (!occurrence) throw new Error(`canonical occurrence ${occurrenceId} is missing`);
  const revision = graph.shot_revisions.find((candidate) => (
    candidate.shot_id === occurrence.shot_id && candidate.revision_id === occurrence.revision_id
  ));
  const sourceInternal = record(revision?.internal_timeline_revision);
  const timeline = record(sourceInternal?.timeline);
  if (!revision || !sourceInternal || !timeline || !Array.isArray(timeline.clips)) {
    throw new Error(`canonical occurrence ${occurrenceId} has no editable internal timeline`);
  }
  const matching = timeline.clips.filter((rawClip) => {
    const clip = record(rawClip);
    return clip?.asset_id === replacement.fromAssetId || clip?.asset === replacement.fromAssetId;
  });
  if (matching.length === 0) {
    throw new Error(`canonical occurrence ${occurrenceId} has no selected asset ${replacement.fromAssetId}`);
  }
  const admittedAssets = Array.isArray(revision.assets) ? revision.assets.map((item) => record(item)).filter((item): item is JsonObject => Boolean(item)) : [];
  const suppliedAsset = replacement.asset ? clone(replacement.asset) : admittedAssets.find((asset) => asset.asset_id === replacement.assetId);
  if (!suppliedAsset) {
    throw new Error(`replacement asset ${replacement.assetId} is not admitted for this shot`);
  }
  const nextTimeline = {
    ...timeline,
    clips: timeline.clips.map((rawClip) => {
      const clip = record(rawClip);
      if (!clip) return rawClip;
      if (clip.asset_id === replacement.fromAssetId) return { ...clip, asset_id: replacement.assetId };
      return clip.asset === replacement.fromAssetId ? { ...clip, asset: replacement.assetId } : rawClip;
    }),
  };
  const nextAssets = [
    ...admittedAssets.filter((asset) => asset.asset_id !== replacement.assetId),
    { ...suppliedAsset, asset_id: replacement.assetId },
  ];
  return updateCanonicalShotRevision(graph, occurrenceId, {
    timeline: nextTimeline,
    assets: nextAssets,
  });
}

export function updateCanonicalShotTimeline(
  graph: ShotCompositionContract,
  occurrenceId: string,
  timeline: JsonObject,
  identitySeed?: string,
): Promise<ShotCompositionContract> {
  const occurrence = graph.occurrences.find((candidate) => candidate.occurrence_id === occurrenceId);
  if (!occurrence) throw new Error(`canonical occurrence ${occurrenceId} is missing`);
  return (async () => {
    const updated = await updateCanonicalShotRevision(graph, occurrenceId, {
      timeline,
      identitySeed,
      // The child timeline is authoritative for duration. The next same-lane
      // occurrence is checked as a hard wall inside updateCanonicalShotRevision.
      occurrenceDurationMs: timelineContentExtentMs(timeline),
    });
    const currentContract = record(record(record(graph.parent_composition)?.config)?.app)?.visualSeamContract;
    const currentGaps = record(currentContract)?.gaps;
    const hasDeclaredPauses = Array.isArray(currentGaps)
      && currentGaps.some((gap) => record(gap)?.kind === 'pause');
    // Most shot edits have no authored pause to move. Avoid projecting the
    // whole parent graph in that case, and keep empty timelines on the normal
    // editor path (the canonical projection intentionally rejects them).
    if (!hasDeclaredPauses || timelineContentExtentMs(timeline) <= 0) return updated;

    const adapter = createShotCompositionAdapter({load: async () => graph});
    let previousConfig: ReturnType<typeof projectCanonicalComposition>['config'];
    try {
      previousConfig = projectCanonicalComposition(adapter.prepare(graph)).config;
    } catch {
      // Older compositions can contain an empty shot that prevents projection.
      // Preserve the valid shot edit and its existing pause contract.
      return updated;
    }
    const nextConfig = projectCanonicalComposition(adapter.prepare(updated)).config;
    const gaps = remapDeclaredVisualPauseEdges(previousConfig, nextConfig);
    if (!gaps) return updated;

    const parentComposition = record(updated.parent_composition);
    const parentConfig = record(parentComposition?.config);
    const app = record(parentConfig?.app);
    const visualSeamContract = record(app?.visualSeamContract);
    if (!parentComposition || !parentConfig || !app || !visualSeamContract) return updated;
    const nextParentComposition = {
      ...parentComposition,
      config: {
        ...parentConfig,
        app: {
          ...app,
          visualSeamContract: {...visualSeamContract, gaps},
        },
      },
    };
    const primaryTimeline = record(updated.primary_timeline);
    const head = record(primaryTimeline?.head);
    if (!primaryTimeline || !head) throw new Error('canonical primary timeline head is missing');
    return {
      ...updated,
      parent_composition: nextParentComposition,
      primary_timeline: {
        ...primaryTimeline,
        head: {
          ...head,
          content_digest: await digestJson(nextParentComposition),
        },
      },
    } as ShotCompositionContract;
  })();
}

export function updateCanonicalShotName(
  graph: ShotCompositionContract,
  occurrenceId: string,
  name: string,
): Promise<ShotCompositionContract> {
  const occurrence = graph.occurrences.find((candidate) => candidate.occurrence_id === occurrenceId);
  if (!occurrence) throw new Error(`canonical occurrence ${occurrenceId} is missing`);
  const revision = graph.shot_revisions.find((candidate) => (
    candidate.shot_id === occurrence.shot_id && candidate.revision_id === occurrence.revision_id
  ));
  const provenance = record(revision?.provenance) ?? {};
  return updateCanonicalShotRevision(graph, occurrenceId, {
    provenance: { ...provenance, name },
  });
}

function reorderOccurrences(graph: ShotCompositionContract): ShotCompositionContract {
  const occurrences = graph.occurrences
    .map((occurrence, index) => ({ occurrence, index }))
    .sort((left, right) => (
      Number(left.occurrence.at_ms) - Number(right.occurrence.at_ms)
      || Number(left.occurrence.ordinal) - Number(right.occurrence.ordinal)
      || left.index - right.index
    ))
    .map(({ occurrence }, ordinal) => ({ ...occurrence, ordinal }));
  return { ...graph, occurrences };
}

export function moveCanonicalOccurrence(
  graph: ShotCompositionContract,
  edit: Pick<CanonicalOccurrenceEdit, 'occurrenceId' | 'atMs'>,
): ShotCompositionContract {
  const atMs = requireNonNegativeInteger(edit.atMs ?? 0, 'atMs');
  const next = clone(graph);
  const index = occurrenceIndex(next, edit.occurrenceId);
  const current = next.occurrences[index];
  assertParentLanePlacement(next, edit.occurrenceId, atMs, occurrenceContentExtentMs(next, current));
  next.occurrences[index] = {
    ...current,
    at_ms: atMs,
    placement: {
      ...(record(current.placement) ?? {}),
      start_ms: atMs,
    },
  };
  return reorderOccurrences(next);
}

export function trimCanonicalOccurrence(
  graph: ShotCompositionContract,
  edit: Pick<CanonicalOccurrenceEdit, 'occurrenceId' | 'durationMs'>,
): ShotCompositionContract {
  const durationMs = requireNonNegativeInteger(edit.durationMs ?? 0, 'durationMs');
  const next = clone(graph);
  const index = occurrenceIndex(next, edit.occurrenceId);
  const occurrence = next.occurrences[index];
  const revision = next.shot_revisions.find((candidate) => (
    candidate.shot_id === occurrence.shot_id && candidate.revision_id === occurrence.revision_id
  ));
  const internal = record(revision?.internal_timeline_revision);
  const contentExtentMs = timelineContentExtentMs(internal?.timeline);
  if (durationMs < contentExtentMs) {
    throw new Error(`Shot duration cannot end before active content at ${contentExtentMs / 1000}s`);
  }
  if (durationMs > contentExtentMs) {
    throw new Error('Shot duration cannot include an empty tail; edit the internal content instead');
  }
  const hardLimitMs = hardDurationMs(next, edit.occurrenceId);
  if (hardLimitMs !== undefined && durationMs > hardLimitMs) {
    throw new Error(`Shot occurrence ${edit.occurrenceId} would cross its next same-lane blocker`);
  }
  next.occurrences[index] = {
    ...occurrence,
    duration_ms: durationMs,
    placement: {
      ...(record(occurrence.placement) ?? {}),
      start_ms: occurrence.at_ms,
    },
  };
  return next;
}

export function duplicateLinkedOccurrence(
  graph: ShotCompositionContract,
  sourceOccurrenceId: string,
  destinationOccurrenceId: string,
): ShotCompositionContract {
  if (graph.occurrences.some((occurrence) => occurrence.occurrence_id === destinationOccurrenceId)) {
    throw new Error(`canonical occurrence ${destinationOccurrenceId} already exists`);
  }
  const source = graph.occurrences[occurrenceIndex(graph, sourceOccurrenceId)];
  const next = clone(graph);
  next.occurrences.push(withOccurrenceIdentity(next, source, destinationOccurrenceId));
  return reorderOccurrences(next);
}

export function duplicateIndependentShot(
  graph: ShotCompositionContract,
  sourceOccurrenceId: string,
  ids: Readonly<{ shotId: string; revisionId: string; internalTimelineRevisionId: string; occurrenceId: string }>,
): ShotCompositionContract {
  const next = clone(graph);
  const sourceOccurrence = next.occurrences[occurrenceIndex(next, sourceOccurrenceId)];
  if (next.occurrences.some((occurrence) => occurrence.occurrence_id === ids.occurrenceId)) {
    throw new Error(`canonical occurrence ${ids.occurrenceId} already exists`);
  }
  if (next.shot_revisions.some((revision) => revision.shot_id === ids.shotId && revision.revision_id === ids.revisionId)) {
    throw new Error(`canonical revision ${ids.shotId}/${ids.revisionId} already exists`);
  }
  const sourceRevision = next.shot_revisions.find((revision) => (
    revision.shot_id === sourceOccurrence.shot_id && revision.revision_id === sourceOccurrence.revision_id
  ));
  if (!sourceRevision) throw new Error('source shot revision is missing');
  const independentRevision = clone(sourceRevision);
  independentRevision.shot_id = ids.shotId;
  independentRevision.revision_id = ids.revisionId;
  independentRevision.publish = true;
  const internal = independentRevision.internal_timeline_revision as JsonObject;
  independentRevision.internal_timeline_revision = { ...internal, revision_id: ids.internalTimelineRevisionId, publish: true };
  next.shot_revisions.push(independentRevision);
  next.occurrences.push(withOccurrenceIdentity(next, {
    ...sourceOccurrence,
    shot_id: ids.shotId,
    revision_id: ids.revisionId,
  }, ids.occurrenceId));
  return reorderOccurrences(next);
}

export class CanonicalShotCompositionHistory {
  private readonly past: ShotCompositionContract[] = [];
  private readonly future: ShotCompositionContract[] = [];

  constructor(private current: ShotCompositionContract) {}

  get value(): ShotCompositionContract {
    return this.current;
  }

  commit(next: ShotCompositionContract): ShotCompositionContract {
    this.past.push(this.current);
    this.current = next;
    this.future.length = 0;
    return this.current;
  }

  undo(): ShotCompositionContract {
    const previous = this.past.pop();
    if (!previous) return this.current;
    this.future.push(this.current);
    this.current = previous;
    return this.current;
  }

  redo(): ShotCompositionContract {
    const next = this.future.pop();
    if (!next) return this.current;
    this.past.push(this.current);
    this.current = next;
    return this.current;
  }
}

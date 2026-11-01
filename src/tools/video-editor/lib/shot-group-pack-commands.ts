/**
 * Document-native shot-group commands (Phase C B5).
 *
 * Group structure is changed only through the timeline CAS document. The two
 * relational generation mutations needed by shot UX are admitted through the
 * frozen Astrid task client with their family pinned at the call site:
 * `duplicate` copies managed final-video bytes; `promote_primary` atomically
 * swaps a generation's primary variant. After command completion we refresh
 * the document registry so every shot view observes the new primary/media.
 */

import { AstridLocalClient } from '@/integrations/astrid/client.ts';
import type {
  BridgeGenerationDetailPayload,
  BridgeTaskAdmissionResponse,
  BridgeTaskDetailPayload,
} from '@/tools/video-editor/data/bridgeContract.ts';
import { loadTimelineDocument, mutateTimelineDocument, prepareTimelineDocumentMutation } from '@/shared/lib/placement/placementService.ts';
import type { PlacementDocument } from '@/shared/lib/placement/documentPlacement.ts';
import {
  deriveTimelineShotGroupViews,
  getConfigTimelineClipDuration,
  type TimelineShotGroupView,
} from '@/tools/video-editor/lib/timeline-domain.ts';
import type {
  AssetRegistryEntry,
  PinnedShotGroup,
  TimelineClip,
} from '@/tools/video-editor/types/index.ts';

export const DUPLICATE_SHOT_GROUP_FAMILY = 'duplicate' as const;
export const PROMOTE_PRIMARY_FAMILY = 'promote_primary' as const;
export const SHOT_PACK_COMMAND_POLL_MS = 2_000;

type TaskDetail = BridgeTaskDetailPayload['task'];
type GenerationDetail = BridgeGenerationDetailPayload['generation'];

export interface ShotPackCommandClient {
  tasks: {
    admit: AstridLocalClient['tasks']['admit'];
    get: AstridLocalClient['tasks']['get'];
  };
  gallery: {
    get: AstridLocalClient['gallery']['get'];
  };
  media: {
    contentUrl: AstridLocalClient['media']['contentUrl'];
  };
}

export type ShotGroupLocator = Readonly<{ shotId: string; trackId: string }>;

export interface DeepCopyShotGroupInput {
  source: ShotGroupLocator;
  destinationShotId: string;
  destinationTrackId?: string;
  destinationName?: string;
  /** Optional explicit start; otherwise append after the destination track. */
  at?: number;
  /** Copied final-video output committed by the `duplicate` pack command. */
  finalVideoReplacement?: Readonly<{
    mediaId: string;
    generationId?: string;
    variantId?: string;
    mimeType?: string;
  }>;
  mediaContentUrl?: (mediaId: string) => string;
}

export interface DeepCopyShotGroupResult {
  readonly group: PinnedShotGroup;
  readonly sourceGroup: PinnedShotGroup;
  readonly clipIdMap: Readonly<Record<string, string>>;
  readonly assetKeyMap: Readonly<Record<string, string>>;
}

const cloneJson = <T>(value: T): T => {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [key, cloneJson(child)]),
    ) as T;
  }
  return value;
};

const safeIdPart = (value: string): string => value.replace(/[^a-zA-Z0-9_-]+/g, '-');

function uniqueId(base: string, occupied: Set<string>): string {
  if (!occupied.has(base)) {
    occupied.add(base);
    return base;
  }
  let ordinal = 2;
  while (occupied.has(`${base}-${ordinal}`)) ordinal += 1;
  const value = `${base}-${ordinal}`;
  occupied.add(value);
  return value;
}

function requireSourceGroup(document: PlacementDocument, source: ShotGroupLocator): PinnedShotGroup {
  const group = document.config.pinnedShotGroups?.find((candidate) => (
    candidate.shotId === source.shotId && candidate.trackId === source.trackId
  ));
  if (!group) {
    throw new Error(`Shot group ${source.shotId}:${source.trackId} was not found in the timeline document`);
  }
  return group;
}

function sourceClipIds(group: PinnedShotGroup, clips: readonly TimelineClip[]): Set<string> {
  const available = new Set(clips.map((clip) => clip.id));
  return new Set(group.clipIds.filter((clipId) => available.has(clipId)));
}

function destinationStart(
  clips: readonly TimelineClip[],
  trackId: string,
  explicitAt?: number,
): number {
  if (explicitAt !== undefined) return Math.max(0, explicitAt);
  return clips.reduce((end, clip) => (
    clip.track === trackId
      ? Math.max(end, clip.at + getConfigTimelineClipDuration(clip))
      : end
  ), 0);
}

/**
 * Deep-copy a group inside one document mutation.
 *
 * Every object/array, clip id, and registry key is independent from the
 * source. Ordinary generation media references intentionally still point at
 * the same immutable managed bytes; the final-video asset is replaced with
 * the pack command's copied output and carries `derivedFrom` lineage.
 */
export function deepCopyShotGroupInDocument(
  document: PlacementDocument,
  input: DeepCopyShotGroupInput,
): DeepCopyShotGroupResult {
  const sourceGroup = requireSourceGroup(document, input.source);
  if (document.config.pinnedShotGroups?.some((group) => group.shotId === input.destinationShotId)) {
    throw new Error(`Shot group destination ${input.destinationShotId} already exists`);
  }

  const destinationTrackId = input.destinationTrackId ?? sourceGroup.trackId;
  const sourceIds = sourceClipIds(sourceGroup, document.config.clips);
  const sourceClips = document.config.clips
    .filter((clip) => sourceIds.has(clip.id))
    .sort((left, right) => left.at - right.at);
  const sourceStart = sourceClips[0]?.at ?? 0;
  const copyStart = destinationStart(document.config.clips, destinationTrackId, input.at);
  const offset = copyStart - sourceStart;
  const token = safeIdPart(input.destinationShotId);
  const occupiedClipIds = new Set(document.config.clips.map((clip) => clip.id));
  const occupiedAssetKeys = new Set(Object.keys(document.registry.assets));
  const clipIdMap = new Map<string, string>();
  const assetKeyMap = new Map<string, string>();

  const sourceAssetKeys = new Set<string>();
  for (const clip of sourceClips) {
    if (clip.asset) sourceAssetKeys.add(clip.asset);
  }
  if (sourceGroup.videoAssetKey) sourceAssetKeys.add(sourceGroup.videoAssetKey);

  for (const sourceAssetKey of sourceAssetKeys) {
    const sourceEntry = document.registry.assets[sourceAssetKey];
    if (!sourceEntry) continue;
    const copiedKey = uniqueId(`${sourceAssetKey}-copy-${token}`, occupiedAssetKeys);
    assetKeyMap.set(sourceAssetKey, copiedKey);
    const copiedEntry = cloneJson(sourceEntry);
    if (sourceGroup.videoAssetKey === sourceAssetKey) {
      const replacement = input.finalVideoReplacement;
      if (replacement) {
        if (!input.mediaContentUrl) {
          throw new Error('A final-video replacement requires mediaContentUrl');
        }
        const contentUrl = input.mediaContentUrl(replacement.mediaId);
        copiedEntry.file = contentUrl;
        copiedEntry.url = contentUrl;
        copiedEntry.thumbnailUrl = contentUrl;
        copiedEntry.type = replacement.mimeType ?? copiedEntry.type ?? 'video/mp4';
        copiedEntry.generationId = replacement.generationId ?? copiedEntry.generationId;
        copiedEntry.variantId = replacement.variantId ?? copiedEntry.variantId;
      }
      copiedEntry.derivedFrom = {
        assetId: sourceAssetKey,
        ...(sourceEntry.content_sha256 ? { content_sha256: sourceEntry.content_sha256 } : {}),
        role: 'render-output',
      };
    }
    document.registry.assets[copiedKey] = copiedEntry;
  }

  const copiedClips = sourceClips.map((sourceClip) => {
    const copiedId = uniqueId(`${sourceClip.id}-copy-${token}`, occupiedClipIds);
    clipIdMap.set(sourceClip.id, copiedId);
    const copied = cloneJson(sourceClip);
    copied.id = copiedId;
    copied.track = destinationTrackId;
    copied.at = Math.max(0, copied.at + offset);
    if (copied.asset && assetKeyMap.has(copied.asset)) {
      copied.asset = assetKeyMap.get(copied.asset);
    }
    // The copied clip is a new document node; retain source_uuid only as
    // provenance inside `generation`, never as its node identity.
    copied.source_uuid = undefined;
    return copied;
  });

  const copiedGroup: PinnedShotGroup = {
    ...cloneJson(sourceGroup),
    shotId: input.destinationShotId,
    name: input.destinationName?.trim() || `${sourceGroup.name?.trim() || sourceGroup.shotId} copy`,
    trackId: destinationTrackId,
    clipIds: sourceGroup.clipIds
      .map((clipId) => clipIdMap.get(clipId))
      .filter((clipId): clipId is string => clipId !== undefined),
    poolGenerationIds: sourceGroup.poolGenerationIds ? [...sourceGroup.poolGenerationIds] : undefined,
    derivedFrom: { shotId: sourceGroup.shotId, trackId: sourceGroup.trackId },
    ...(sourceGroup.videoAssetKey && assetKeyMap.has(sourceGroup.videoAssetKey)
      ? { videoAssetKey: assetKeyMap.get(sourceGroup.videoAssetKey) }
      : { videoAssetKey: undefined }),
    imageClipSnapshot: sourceGroup.imageClipSnapshot?.map((snapshot) => {
      const copied = cloneJson(snapshot);
      copied.clipId = clipIdMap.get(snapshot.clipId) ?? copied.clipId;
      if (copied.assetKey && assetKeyMap.has(copied.assetKey)) {
        copied.assetKey = assetKeyMap.get(copied.assetKey);
      }
      return copied;
    }),
  };

  document.config.clips = [...document.config.clips, ...copiedClips];
  document.config.pinnedShotGroups = [
    ...(document.config.pinnedShotGroups ?? []),
    copiedGroup,
  ];

  return {
    group: copiedGroup,
    sourceGroup,
    clipIdMap: Object.freeze(Object.fromEntries(clipIdMap)),
    assetKeyMap: Object.freeze(Object.fromEntries(assetKeyMap)),
  };
}

function packKey(...parts: string[]): string {
  return `astrid:shot-pack:v1:${parts.map((part) => encodeURIComponent(part)).join(':')}`;
}

export async function admitDuplicateShotGroupPackCommand(
  client: ShotPackCommandClient,
  input: Readonly<{
    source: ShotGroupLocator;
    destinationShotId: string;
    destinationTrackId: string;
    finalVideoMediaId?: string;
  }>,
): Promise<BridgeTaskAdmissionResponse> {
  return await client.tasks.admit({
    family: DUPLICATE_SHOT_GROUP_FAMILY,
    input: {
      source_group: { shot_id: input.source.shotId, track_id: input.source.trackId },
      destination_group: { shot_id: input.destinationShotId, track_id: input.destinationTrackId },
      derived_from: { shot_id: input.source.shotId, track_id: input.source.trackId },
      ...(input.finalVideoMediaId ? { final_video_media_id: input.finalVideoMediaId } : {}),
    },
  }, packKey('duplicate', input.source.shotId, input.source.trackId, input.destinationShotId));
}

export async function admitPromotePrimaryPackCommand(
  client: ShotPackCommandClient,
  input: Readonly<{ generationId: string; variantId: string }>,
): Promise<BridgeTaskAdmissionResponse> {
  return await client.tasks.admit({
    family: PROMOTE_PRIMARY_FAMILY,
    input: {
      generation_id: input.generationId,
      variant_id: input.variantId,
    },
  }, packKey('promote-primary', input.generationId, input.variantId));
}

export interface WaitForShotPackCommandOptions {
  signal?: AbortSignal;
  pollMs?: number;
  maxPolls?: number;
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

const defaultWait = async (delayMs: number, signal?: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
};

/** Poll at the ratified 2-second active cadence until the pack task is terminal. */
export async function waitForShotPackCommand(
  client: ShotPackCommandClient,
  taskId: string,
  options: WaitForShotPackCommandOptions = {},
): Promise<TaskDetail> {
  const maxPolls = options.maxPolls ?? 150;
  const wait = options.wait ?? defaultWait;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    const task = await client.tasks.get(taskId);
    if (task.status === 'succeeded') return task;
    if (task.status === 'failed' || task.status === 'cancelled') {
      throw new Error(`Shot pack command ${taskId} ended ${task.status}`);
    }
    await wait(options.pollMs ?? SHOT_PACK_COMMAND_POLL_MS, options.signal);
  }
  throw new Error(`Shot pack command ${taskId} did not finish after ${maxPolls} polls`);
}

function parseParams(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finalVideoReplacementFromTask(task: TaskDetail): DeepCopyShotGroupInput['finalVideoReplacement'] {
  const output = task.outputs?.find((candidate) => candidate.role === 'final_video') ?? task.outputs?.[0];
  if (!output) return undefined;
  const params = parseParams(output.params_json);
  return {
    mediaId: output.media_id,
    ...(typeof params.generation_id === 'string' ? { generationId: params.generation_id } : {}),
    ...(typeof params.variant_id === 'string' ? { variantId: params.variant_id } : {}),
    ...(typeof params.mime_type === 'string' ? { mimeType: params.mime_type } : {}),
  };
}

function mediaIdFromContentRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/\/media\/([^/]+)\/content(?:[?#].*)?$/);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

function sourceFinalVideo(document: PlacementDocument, source: ShotGroupLocator): {
  group: PinnedShotGroup;
  entry?: AssetRegistryEntry;
  mediaId?: string;
} {
  const group = requireSourceGroup(document, source);
  const entry = group.videoAssetKey ? document.registry.assets[group.videoAssetKey] : undefined;
  return { group, entry, mediaId: mediaIdFromContentRef(entry?.url ?? entry?.file) };
}

/** End-to-end duplicate: pack-copy final bytes, then CAS-copy document nodes. */
export async function duplicateShotGroup(
  input: Omit<DeepCopyShotGroupInput, 'finalVideoReplacement' | 'mediaContentUrl'> & {
    projectSlug: string;
    timelineRef: string;
    configVersion: number;
  },
  options: WaitForShotPackCommandOptions = {},
): Promise<DeepCopyShotGroupResult> {
  const client = new AstridLocalClient({ projectSlug: input.projectSlug });
  const head = await prepareTimelineDocumentMutation({
    projectSlug: input.projectSlug,
    timelineRef: input.timelineRef,
    configVersion: input.configVersion,
  });
  if (head.expectedVersion !== input.configVersion) {
    throw new Error(
      `Timeline ${input.timelineRef} is at version ${head.expectedVersion}; expected active editor version ${input.configVersion}`,
    );
  }
  const source = sourceFinalVideo(head, input.source);
  // A group with no final video has no bytes to copy: duplicate its document nodes without a pack task.
  let replacement: DeepCopyShotGroupInput['finalVideoReplacement'];
  if (source.entry) {
    const admitted = await admitDuplicateShotGroupPackCommand(client, {
      source: input.source,
      destinationShotId: input.destinationShotId,
      destinationTrackId: input.destinationTrackId ?? source.group.trackId,
      finalVideoMediaId: source.mediaId,
    });
    const task = await waitForShotPackCommand(client, admitted.task.id, options);
    replacement = finalVideoReplacementFromTask(task);
    if (!replacement) {
      throw new Error('Duplicate pack command succeeded without a copied final-video output');
    }
  }
  return (await head.mutate((document) => deepCopyShotGroupInDocument(document, {
    ...input,
    finalVideoReplacement: replacement,
    mediaContentUrl: (mediaId) => client.media.contentUrl(mediaId),
  }))).result;
}

/** Refresh every registry reference to a generation's newly primary variant. */
export function refreshGenerationPrimaryInDocument(
  document: PlacementDocument,
  generation: GenerationDetail,
  mediaContentUrl: (mediaId: string) => string,
): void {
  const primary = generation.variants.find((variant) => variant.is_primary);
  if (!primary) {
    throw new Error(`Generation ${generation.generation_id} has no primary variant after refresh`);
  }
  const url = mediaContentUrl(primary.media_id);
  for (const [assetKey, entry] of Object.entries(document.registry.assets)) {
    if (entry.generationId !== generation.generation_id) continue;
    document.registry.assets[assetKey] = {
      ...cloneJson(entry),
      file: url,
      url,
      thumbnailUrl: url,
      variantId: primary.id,
    };
  }
}

/** End-to-end promote: admit pack command, await it, refresh R13, then CAS registry. */
export async function promotePrimaryVariant(
  input: Readonly<{
    projectSlug: string;
    timelineRef: string;
    configVersion: number;
    generationId: string;
    variantId: string;
  }>,
  options: WaitForShotPackCommandOptions = {},
): Promise<readonly TimelineShotGroupView[]> {
  const client = new AstridLocalClient({ projectSlug: input.projectSlug });
  const head = await loadTimelineDocument(input.projectSlug, input.timelineRef);
  if (head.expectedVersion !== input.configVersion) {
    throw new Error(
      `Timeline ${input.timelineRef} is at version ${head.expectedVersion}; expected active editor version ${input.configVersion}`,
    );
  }
  const admitted = await admitPromotePrimaryPackCommand(client, input);
  await waitForShotPackCommand(client, admitted.task.id, options);
  const generation = await client.gallery.get(input.generationId);
  const primary = generation.variants.find((variant) => variant.is_primary);
  if (primary?.id !== input.variantId) {
    throw new Error(`Promote-primary completed but ${input.variantId} is not primary`);
  }
  return (await mutateTimelineDocument({
    projectSlug: input.projectSlug,
    timelineRef: input.timelineRef,
    configVersion: input.configVersion,
  }, (document) => {
    refreshGenerationPrimaryInDocument(document, generation, (mediaId) => client.media.contentUrl(mediaId));
    return deriveTimelineShotGroupViews(document.config, document.registry);
  })).result;
}

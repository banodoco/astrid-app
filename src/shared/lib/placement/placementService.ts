/**
 * Placement service — the ONLY I/O path for document-native placement on
 * non-editor surfaces.
 *
 * Every mutation is one authoring cycle: load the verified canonical closure → run a pure
 * document mutation (`documentPlacement.ts`) → author a guarded `doc.patch` through the
 * editor's durable LocalSaveSession/outbox. A concurrent refusal remains visible and its
 * original intent stays durable for explicit recovery.
 *
 * There is no relational placement route here or anywhere else: no
 * junction-table writes, no placement RPC. Reads derive from the same single
 * document plus the gallery reads.
 */

import { AstridLocalClient } from '@/integrations/astrid/client';
import { RuntimeDataProvider } from '@/integrations/runtime/dataProvider';
import type { CanonicalDocument, EditCommand } from '@/integrations/runtime/timeline-commit-types';
import { TimelineSaveError, type TimelineCommandBasis, type TimelineSaveReceipt } from '@/tools/video-editor/data/DataProvider';
import { createCommitOutbox, toOutboxJson, type OutboxScope } from '@/tools/video-editor/commands/commitOutbox';
import { createLocalSaveSession, type LocalSaveSession } from '@/tools/video-editor/commands/localSaveSession';
import { canonicalJsonStringify } from '@/tools/video-editor/data/typed/timelineBundle';
import { authoringBundleFromDocument } from '@/tools/video-editor/commands/authoringBundle';
import type { TimelineSaveSource } from '@/tools/video-editor/hooks/timelineLocalSaveHandoff';
import { TimelineVersionConflictError } from '@/sdk/video/timeline/errors';
import { resolveGenerationAsset } from '@/tools/video-editor/data/generationAssetResolver';
import type { TimelineConfig } from '@/tools/video-editor/types/index';
import type { TimelineBundleEnvelope } from '@/tools/video-editor/data/typed/timelineBundle';
import {
  batchUpdateFramesInDocument,
  placeGenerationInDocument,
  readPlacements,
  removeEntryFromDocument,
  type FrameUpdate,
  type PlacementDocument,
  type ShotPlacement,
} from './documentPlacement';

const GALLERY_PAGE_LIMIT = 100;
/** Journey-scale bound: enough pages that panels see every generation without unbounded paging. */
const GALLERY_MAX_ROWS = 500;
/** Re-read once if the verified document changes before a durable intent exists. */
const PLACEMENT_RETRY_ATTEMPTS = 2;

class PlacementDocumentChangedError extends TimelineVersionConflictError {}

export class PlacementProjectMissingError extends Error {
  constructor(projectSlug: string) {
    super(`No default timeline found for project ${projectSlug}`);
    this.name = 'PlacementProjectMissingError';
  }
}

/** Explicit document head selected by the editor. Mutations must never infer it. */
export interface ActiveTimelineTarget {
  projectSlug: string;
  timelineRef: string;
  configVersion: number;
  /**
   * Workspace v1 head the editor selected (numeric versions are provider-local
   * counters and cannot be compared across providers). Checked when present.
   */
  headRevisionId?: string | null;
  /** Transitional non-editor placement callers may retain bounded CAS rebase. */
  allowVersionRebase?: boolean;
}

export interface LoadedDocument extends PlacementDocument {
  expectedVersion: number;
  headRevisionId?: string | null;
}

interface PlacementSaveDocument extends LoadedDocument {
  basis: TimelineCommandBasis;
  source: TimelineSaveSource;
  session: LocalSaveSession;
  handoff: TimelineLocalSaveHandoff;
}

interface TimelineLocalSaveHandoff {
  capture(source: TimelineSaveSource): Promise<void>;
  flush(): Promise<TimelineSaveReceipt>;
}

const sameJson = (a: unknown, b: unknown): boolean => canonicalJsonStringify(a) === canonicalJsonStringify(b);
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function authoredJson(value: unknown): ReturnType<typeof toOutboxJson> {
  if (Array.isArray(value)) return value.map(authoredJson);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, authoredJson(item)]));
  }
  return toOutboxJson(value);
}

function sourceFromBasis(basis: TimelineCommandBasis): TimelineSaveSource {
  const parent = basis.canonicalDocument.parent_revision.payload as Record<string, unknown>;
  if (!parent.config || typeof parent.config !== 'object' || Array.isArray(parent.config)
    || !parent.registry || typeof parent.registry !== 'object' || Array.isArray(parent.registry)) {
    throw new TimelineSaveError(
      `Runtime timeline ${basis.canonicalDocument.timeline_id} has no authored parent config/registry`,
    );
  }
  const rawConfig = structuredClone(parent.config) as TimelineConfig & { bundle?: TimelineBundleEnvelope | null };
  const { bundle, ...config } = rawConfig;
  return {
    config,
    registry: structuredClone(parent.registry) as LoadedDocument['registry'],
    head: {
      projectId: basis.canonicalDocument.project_id,
      timelineId: basis.canonicalDocument.timeline_id,
      headRevisionId: basis.head.revisionId,
      headPublicationId: basis.head.publicationId,
    },
    ...(hasOwn(rawConfig, 'bundle') ? { bundle: bundle ?? null } : {}),
  };
}

function refusePlacement(message: string): never {
  throw new TimelineSaveError(`Local document save retained: ${message}`);
}

function checkPlacementHead(initial: TimelineCommandBasis, source: TimelineSaveSource): void {
  const canonicalRevision = initial.canonicalDocument.parent_revision.revision_id;
  const sourceHead = source.head;
  if (!initial.head.revisionId || !initial.head.publicationId
    || !canonicalRevision
    || sourceHead?.projectId !== initial.canonicalDocument.project_id
    || sourceHead.timelineId !== initial.canonicalDocument.timeline_id
    || !sourceHead.headRevisionId || !sourceHead.headPublicationId) {
    refusePlacement('original verified authoring head is unavailable');
  }
  if (initial.head.revisionId && canonicalRevision && canonicalRevision !== initial.head.revisionId) {
    throw new TimelineVersionConflictError('Local document save retained: verified parent revision changed');
  }
  if (sourceHead?.projectId === initial.canonicalDocument.project_id
    && sourceHead.timelineId === initial.canonicalDocument.timeline_id
    && sourceHead.headRevisionId && initial.head.revisionId
    && sourceHead.headRevisionId !== initial.head.revisionId) {
    throw new TimelineVersionConflictError('Local document save retained: source revision changed');
  }
  if (sourceHead?.projectId === initial.canonicalDocument.project_id
    && sourceHead.timelineId === initial.canonicalDocument.timeline_id
    && sourceHead.headRevisionId === initial.head.revisionId
    && sourceHead.headPublicationId && initial.head.publicationId
    && sourceHead.headPublicationId !== initial.head.publicationId) {
    throw new TimelineVersionConflictError('Local document save retained: source publication changed');
  }
  if (sourceHead.headRevisionId !== initial.head.revisionId
    || sourceHead.headPublicationId !== initial.head.publicationId) refusePlacement('original verified authoring head is unavailable');
}

/**
 * Placement owns the parent root explicitly. Child/occurrence images remain in the verified
 * closure and are never flattened into the display source or changed by this adapter.
 */
function createPlacementLocalSaveHandoff(options: {
  initial: TimelineCommandBasis;
  source: TimelineSaveSource;
  session: LocalSaveSession;
  adopted(basis: TimelineCommandBasis): { receipt: TimelineSaveReceipt; source: TimelineSaveSource };
}): TimelineLocalSaveHandoff {
  let initial = structuredClone(options.initial);
  let source = structuredClone(options.source);
  let document = structuredClone(options.initial.canonicalDocument);

  function checkSource(current: TimelineSaveSource, before: CanonicalDocument): void {
    const parent = before.parent_revision.payload as Record<string, unknown>;
    const rawConfig = structuredClone(parent.config) as Record<string, unknown>;
    const { bundle, ...config } = rawConfig;
    if (!sameJson(current.config, config)
      || !sameJson(current.registry, parent.registry)
      || (hasOwn(rawConfig, 'bundle') && !sameJson(current.bundle, bundle))
      || (!hasOwn(rawConfig, 'bundle') && current.bundle !== undefined)) {
      refusePlacement('placement source differs from the verified authored parent');
    }
  }

  return {
    capture(input) {
      try {
        const next = structuredClone(input);
        checkPlacementHead(initial, source);
        checkPlacementHead(initial, next);
        const before = options.session.getDocument() as unknown as CanonicalDocument;
        if (!sameJson(before, document)) refusePlacement('local authored document changed outside this handoff');
        checkSource(source, before);

        const after = structuredClone(before);
        const payload = after.parent_revision.payload as Record<string, unknown>;
        const nextConfig = authoredJson(next.config) as Record<string, unknown>;
        if (next.bundle !== undefined) nextConfig.bundle = structuredClone(next.bundle);
        payload.config = nextConfig;
        payload.registry = authoredJson(next.registry) as Record<string, unknown>;
        for (const key of ['clips', 'tracks'] as const) {
          if (!hasOwn(payload, key)) continue;
          const parentConfig = payload.config as Record<string, unknown>;
          if (!sameJson(payload[key], (before.parent_revision.payload.config as Record<string, unknown>)[key])) {
            refusePlacement(`contradictory parent ${key} mirror`);
          }
          payload[key] = structuredClone(parentConfig[key]);
        }

        const authoredAfter = authoredJson(after) as unknown as CanonicalDocument;
        const pending = options.session.appendDocument({
          before,
          after: authoredAfter,
          roots: [{ ref: 'parent', revisionId: before.parent_revision.revision_id,
            contentDigest: before.parent_revision.content_digest }],
          label: 'Edit timeline',
          step: { id: crypto.randomUUID(), label: 'Edit timeline', intent: 'Save placement changes', tags: [] },
        });
        source = authoredJson(next) as unknown as TimelineSaveSource;
        document = structuredClone(authoredAfter);
        return pending;
      } catch (error) {
        return Promise.reject(error instanceof TimelineSaveError || error instanceof TimelineVersionConflictError ? error
          : new TimelineSaveError(`Local document save retained: ${error instanceof Error ? error.message : String(error)}`));
      }
    },
    async flush() {
      let basis: TimelineCommandBasis;
      try {
        basis = await options.session.flush();
      } catch (error) {
        const state = options.session.getState();
        const detail = state.error && typeof state.error === 'object' && !Array.isArray(state.error)
          && typeof state.error.message === 'string' ? state.error.message : undefined;
        const message = detail ?? (error instanceof Error ? error.message : String(error));
        if (state.status === 'conflict') throw new TimelineVersionConflictError(message);
        if (state.status === 'error') throw new TimelineSaveError(message);
        throw error;
      }
      const adopted = options.adopted(basis);
      const head = adopted.receipt.head;
      if (head.projectId !== initial.canonicalDocument.project_id
        || head.timelineId !== initial.canonicalDocument.timeline_id
        || head.headRevisionId !== basis.head.revisionId
        || head.headPublicationId !== basis.head.publicationId
        || !sameJson(adopted.source.head, head)) {
        refusePlacement('canonical assembly did not adopt the accepted head');
      }
      initial = structuredClone(basis);
      source = structuredClone(adopted.source);
      document = structuredClone(basis.canonicalDocument);
      return adopted.receipt;
    },
  };
}

/** One load/save pair over the Runtime's canonical commit path. */
interface DocumentStore {
  load(): Promise<PlacementSaveDocument>;
  save(document: PlacementSaveDocument): Promise<number>;
}

/**
 * The document head as the Runtime serves it: `RuntimeDataProvider` reads the parent-composition
 * revision (config and registry), because `GET /v1/projects/:p/timelines/:t` answers the public timeline
 * resource without either. `headRevisionId` is `undefined` when the provider reports no head at all.
 */
export async function loadTimelineDocument(projectSlug: string, timelineRef: string): Promise<LoadedDocument> {
  const provider = new RuntimeDataProvider({ projectId: projectSlug });
  const [timeline, registry] = await Promise.all([
    provider.loadTimeline(timelineRef),
    provider.loadAssetRegistry(timelineRef),
  ]);
  return {
    config: timeline.config,
    registry,
    expectedVersion: timeline.configVersion,
    headRevisionId: timeline.head?.headRevisionId,
  };
}

function createDocumentStore(
  target: ActiveTimelineTarget,
  provider = new RuntimeDataProvider({ projectId: target.projectSlug }),
  initialBasis?: TimelineCommandBasis,
): DocumentStore {
  const ref = target.timelineRef;
  return {
    async load() {
      const captured = initialBasis;
      initialBasis = undefined;
      const basis = captured ?? await provider.loadTimelineCommandBasis(ref);
      // Validate the complete pinned closure before authoring any local transform. The
      // placement operation below owns only the explicit parent physical root; child and
      // occurrence images are validated dependencies and remain untouched.
      await authoringBundleFromDocument(basis.canonicalDocument);
      // Detect only local read staleness, before creating an owner or authoring
      // guards. A Runtime rejection after dispatch is definitive for that intent.
      const current = await provider.loadTimelineCommandBasis(ref);
      if (current.head.revisionId !== basis.head.revisionId
        || current.head.publicationId !== basis.head.publicationId) {
        throw new PlacementDocumentChangedError('Timeline document changed before placement authoring');
      }
      let saveBasis = basis;
      let source = sourceFromBasis(saveBasis);
      const identity = await provider.getRecoverableIdentity();
      const outboxes = createCommitOutbox();
      const scope: OutboxScope = {
        ...identity,
        projectId: basis.canonicalDocument.project_id,
        timelineId: basis.canonicalDocument.timeline_id,
      };
      const session = await createLocalSaveSession({
        scope,
        initial: basis,
        document: toOutboxJson(basis.canonicalDocument),
        outboxes,
        send: (request, key) => provider.commitTimeline(request, key),
        loadLatest: () => provider.loadTimelineCommandBasis(ref),
        prepareDisplay: async (nextBasis, draft) => ({
          document: draft ?? toOutboxJson(nextBasis.canonicalDocument),
          adopt() {},
        }),
        changed() {},
      });
      const owners = session.getState().recoverableOwners;
      if (owners.length === 1) {
        try {
          await session.recover(owners[0]!);
          // A recovered ACK (including a merged ACK after an intervening head) is the
          // authoring basis for this new placement transform, never the stale load above.
          saveBasis = await session.flush();
          source = sourceFromBasis(saveBasis);
        } catch (error) {
          await session.dispose();
          throw error;
        }
      } else if (owners.length > 1) {
        await session.dispose();
        throw new TimelineSaveError('Multiple placement save owners require explicit recovery');
      }
      const handoff = createPlacementLocalSaveHandoff({
        initial: saveBasis,
        source,
        session,
        adopted(nextBasis) {
          const nextSource = sourceFromBasis(nextBasis);
          const receipt: TimelineSaveReceipt = {
            configVersion: target.configVersion + 1,
            head: nextSource.head!,
          };
          return { receipt, source: nextSource };
        },
      });
      return {
        config: structuredClone(source.config),
        registry: structuredClone(source.registry),
        expectedVersion: target.configVersion,
        headRevisionId: saveBasis.head.revisionId,
        basis: saveBasis,
        source,
        session,
        handoff,
      };
    },
    async save(document) {
      await document.handoff.capture({ ...document.source, config: document.config, registry: document.registry });
      return (await document.handoff.flush()).configVersion;
    },
  };
}

/** Keep the cold verified read private until the caller finishes any asynchronous preflight. */
export async function prepareTimelineDocumentMutation(target: ActiveTimelineTarget): Promise<LoadedDocument & {
  mutate<T>(mutate: (document: PlacementDocument) => T): Promise<{ result: T; configVersion: number }>;
}> {
  const selected = { ...target };
  const provider = new RuntimeDataProvider({ projectId: selected.projectSlug });
  const { basis, timeline, registry } = await provider.loadTimelineCommandBasisWithDisplay(selected.timelineRef);
  const store = createDocumentStore(selected, provider, basis);
  let consumed = false;
  return {
    config: timeline.config,
    registry,
    expectedVersion: timeline.configVersion,
    headRevisionId: timeline.head?.headRevisionId,
    mutate(mutate) {
      if (consumed) return Promise.reject(new TimelineSaveError('Timeline mutation was already consumed'));
      consumed = true;
      return mutateTimelineDocumentFromStore(selected, mutate, store);
    },
  };
}

async function resolveDefaultTimelineRef(client: AstridLocalClient, projectSlug: string): Promise<string> {
  const timelines = (await client.timelines.list()).timelines ?? [];
  if (timelines.length === 0) throw new PlacementProjectMissingError(projectSlug);
  const chosen = timelines.find((timeline) => timeline.is_default === true) ?? timelines[0];
  // The Runtime addresses timelines by canonical id.
  return chosen.timeline_id;
}

export async function mutateTimelineDocument<T>(
  target: ActiveTimelineTarget,
  mutate: (document: PlacementDocument) => T,
): Promise<{ result: T; configVersion: number }> {
  return mutateTimelineDocumentFromStore(target, mutate, createDocumentStore(target));
}

async function mutateTimelineDocumentFromStore<T>(
  target: ActiveTimelineTarget,
  mutate: (document: PlacementDocument) => T,
  store: DocumentStore,
): Promise<{ result: T; configVersion: number }> {
  const ref = target.timelineRef;

  for (let attempt = 0; attempt < PLACEMENT_RETRY_ATTEMPTS; attempt += 1) {
    let document: PlacementSaveDocument;
    try {
      document = await store.load();
    } catch (error) {
      if (target.allowVersionRebase && error instanceof PlacementDocumentChangedError
        && attempt + 1 < PLACEMENT_RETRY_ATTEMPTS) continue;
      throw error;
    }
    try {
      if (!target.allowVersionRebase) {
        const stale = target.headRevisionId !== undefined && document.headRevisionId !== target.headRevisionId;
        if (stale) {
          throw new TimelineVersionConflictError(
            `Timeline ${ref} is at version ${document.expectedVersion}; expected active editor version ${target.configVersion}`,
          );
        }
      }
      const result = mutate(document);
      return { result, configVersion: await store.save(document) };
    } finally {
      await document.session.dispose();
    }
  }
  throw new TimelineVersionConflictError(
    `Timeline placement save conflicted ${PLACEMENT_RETRY_ATTEMPTS} consecutive times`,
  );
}

async function resolveLegacyPlacementTarget(projectSlug: string): Promise<ActiveTimelineTarget> {
  const client = new AstridLocalClient({ projectSlug });
  const timelineRef = await resolveDefaultTimelineRef(client, projectSlug);
  // The save session authors a new intent from this verified basis; it never
  // rewrites a pending request after a definitive Runtime refusal.
  return { projectSlug, timelineRef, configVersion: 0, allowVersionRebase: true };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface PlaceGenerationRequest {
  projectSlug: string;
  shotId: string;
  generationId: string;
  /** Explicit canonical occurrence owner; its child is forked before placement when supplied. */
  ownerRef?: OccurrenceForkRequest['ownerRef'];
  /** Selected editor identity; refuse a placement resolved into another timeline. */
  timelineRef?: string;
  /** `undefined` → auto-position; `null` → pooled; number → explicit frame. */
  timelineFrame?: number | null;
}

/**
 * The selected occurrence is an authenticated closure binding, not a display shot id.
 * The destination shot is allocated by the caller and is retained verbatim across retries.
 */
export interface OccurrenceForkRequest extends ActiveTimelineTarget {
  ownerRef: `occurrence:${string}`;
  shotId: string;
}

export function buildOccurrenceForkCommand(document: CanonicalDocument, request: OccurrenceForkRequest): EditCommand {
  if (!/^occurrence:(?!.*::)[^/]+$/.test(request.ownerRef)) {
    throw new TimelineSaveError('Occurrence fork requires one explicit canonical occurrence owner');
  }
  if (!/^(?!.*::)[^/]+$/.test(request.shotId)) {
    throw new TimelineSaveError('Occurrence fork requires one reserved shot identity');
  }
  const occurrenceId = request.ownerRef.slice('occurrence:'.length);
  const payload = document.parent_revision.payload as Record<string, unknown>;
  const occurrences = payload.occurrences;
  if (!Array.isArray(occurrences)) {
    throw new TimelineSaveError('Occurrence fork has no canonical occurrence closure');
  }
  const owners = occurrences.filter((row) => row && typeof row === 'object'
    && !Array.isArray(row) && (row as Record<string, unknown>).occurrence_id === occurrenceId);
  if (owners.length !== 1) {
    throw new TimelineSaveError('Occurrence fork requires one uniquely bound canonical occurrence');
  }
  const sourceShotId = (owners[0] as Record<string, unknown>).shot_id;
  if (typeof sourceShotId !== 'string' || sourceShotId === request.shotId) {
    throw new TimelineSaveError('Occurrence fork requires a fresh shot identity distinct from its source');
  }
  const shotRevisions = document.shot_revisions.filter((shot) => shot.shot_id === request.shotId);
  if (shotRevisions.length !== 0) {
    throw new TimelineSaveError('Occurrence fork destination shot identity is already occupied');
  }
  return {
    schema_version: 1,
    op: 'occurrence.fork',
    version: '1',
    select: request.ownerRef,
    args: { shot_id: request.shotId },
    intent: { ownership: 'occurrence' },
    created: [`shot:${request.shotId}`],
  };
}

/**
 * Materialize one selected occurrence through the registered Agent fork before a child-owned
 * placement/media command is authored. This deliberately uses the existing A2 LocalSaveSession;
 * it does not create a second transport or patch managed closure edges in TypeScript.
 */
export async function forkOccurrence(request: OccurrenceForkRequest): Promise<TimelineCommandBasis> {
  const store = createDocumentStore(request);
  const document = await store.load();
  try {
    const command = buildOccurrenceForkCommand(document.basis.canonicalDocument, request);
    const before = document.session.getDocument();
    await document.session.append({
      before,
      after: before,
      label: 'Fork selected occurrence',
      commands: [command],
    });
    return await document.session.flush();
  } finally {
    await document.session.dispose();
  }
}

/**
 * Resolve the generation's primary media through the generation detail read (single authority for
 * media addressing), then place it via one CAS cycle.
 */
export async function placeGeneration(request: PlaceGenerationRequest): Promise<ShotPlacement> {
  const resolution = await resolveGenerationAsset({
    generationId: request.generationId,
    projectSlug: request.projectSlug,
  });
  if (!resolution.ok) {
    throw new Error(resolution.diagnostic.message);
  }

  const target = await resolveLegacyPlacementTarget(request.projectSlug);
  if (request.timelineRef !== undefined && request.timelineRef !== target.timelineRef) {
    throw new TimelineSaveError('Placement target differs from the selected editor timeline');
  }
  if (request.ownerRef !== undefined) {
    await forkOccurrence({ ...target, ownerRef: request.ownerRef, shotId: request.shotId });
  }
  return (await mutateTimelineDocument(target, (document) =>
    placeGenerationInDocument(document, {
      shotId: request.shotId,
      generationId: request.generationId,
      mediaRef: resolution.asset.url,
      displaySrc: resolution.asset.url,
      mimeType: resolution.asset.mimeType,
      registryEntry: resolution.asset.entry,
      timelineFrame: request.timelineFrame,
    }),
  )).result;
}

export interface UnplaceGenerationRequest {
  projectSlug: string;
  shotId: string;
  entryId: string;
  /** The generation this entry places (no id parsing — explicit is honest). */
  generationId: string;
  /**
   * `true` keeps membership as a pooled member ("set timeline_frame =
   * NULL" semantics); `false` removes the placement expression entirely.
   */
  keepAsPooled?: boolean;
}

export async function unplaceGeneration(request: UnplaceGenerationRequest): Promise<void> {
  const target = await resolveLegacyPlacementTarget(request.projectSlug);
  await mutateTimelineDocument(target, (document) => {
    const asset = document.registry.assets[`gen:${request.generationId}`];
    removeEntryFromDocument(document, request.entryId);
    // Pooling without managed media would strand a member nothing can render;
    // leave the placement removed instead.
    if (!request.keepAsPooled || !asset?.file) return;
    placeGenerationInDocument(document, {
      shotId: request.shotId,
      generationId: request.generationId,
      mediaRef: asset.file,
      displaySrc: asset.url,
      registryEntry: asset,
      timelineFrame: null,
    });
  });
}

export interface BatchFrameUpdateRequest {
  projectSlug: string;
  shotId: string;
  updates: FrameUpdate[];
}

/** Batch frame update for one shot's placements in the timeline document. */
export async function batchUpdatePlacementFrames(request: BatchFrameUpdateRequest): Promise<ShotPlacement[]> {
  const target = await resolveLegacyPlacementTarget(request.projectSlug);
  return (await mutateTimelineDocument(target, (document) =>
    batchUpdateFramesInDocument(document, request.shotId, request.updates),
  )).result;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------


export interface ProjectPlacements {
  /** Placements per shot id (ordered by frame, pooled last). */
  byShot: Map<string, ShotPlacement[]>;
  config: TimelineConfig;
  registry: { assets: Record<string, unknown> };
  configVersion: number | null;
}

/** Load the placement read model straight off the document head. */
export async function fetchProjectPlacements(projectSlug: string): Promise<ProjectPlacements> {
  const client = new AstridLocalClient({ projectSlug });
  const ref = await resolveDefaultTimelineRef(client, projectSlug);
  const { config, registry, expectedVersion } = await loadTimelineDocument(projectSlug, ref);
  return {
    byShot: readPlacements(config, registry),
    config,
    registry,
    configVersion: expectedVersion,
  };
}

export interface PlacementGalleryRow {
  generationId: string;
  name: string | null;
  type: string;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
  variantCount: number;
  primaryMediaId: string | null;
}

/** Bounded gallery page walk — the row source placements merge against. */
export async function fetchGalleryRows(projectSlug: string): Promise<PlacementGalleryRow[]> {
  const client = new AstridLocalClient({ projectSlug });
  const rows: PlacementGalleryRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.gallery.list({ limit: GALLERY_PAGE_LIMIT, cursor });
    for (const generation of page.generations) {
      rows.push({
        generationId: generation.generation_id,
        name: generation.name,
        type: generation.type,
        starred: generation.starred,
        createdAt: generation.created_at,
        updatedAt: generation.updated_at,
        variantCount: generation.variant_count,
        primaryMediaId: generation.primary?.media_id ?? null,
      });
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined && rows.length < GALLERY_MAX_ROWS);
  return rows;
}

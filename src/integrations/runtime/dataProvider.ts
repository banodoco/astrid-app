import { timelineBasisDiagnostics } from '@/tools/video-editor/lib/timeline-basis-diagnostics.ts';
import { PROJECT_TRANSCRIPT_KIND, parseProjectTranscriptDocument, projectTranscriptSchema, transcriptDocumentId, type ProjectTranscriptRepository } from '@/tools/video-editor/data/typed/projectTranscript.ts';
import { ApiError, type ByteResponse, type MediaImportOperation as MediaImport, type RequestBody } from './generated.ts';
import type {
  CanonicalDocument,
  CommitAcceptedMutation,
  CommitRequest,
  EditCommand,
  HistoryPage,
  MediaSelection,
  MediaSelectionQuery,
  VerifiedMedia,
} from './generated.ts';
import {
  AstridRuntimeClient,
  RuntimeAuthenticationError,
  RuntimeUnavailableError,
  isRuntimeCanonicalPayloadConflict,
  classifyRuntimeCommitFailure,
  isRuntimeConflict,
  isRuntimeUnavailableFailure,
  type RuntimeConnectorError,
} from './client.ts';
import {
  TimelineNotFoundError,
  TimelineSaveError,
  TimelineSchemaIncompatibleError,
  TimelineVersionConflictError,
  OwnUnacknowledgedSaveError,
  type DataProvider,
  type LoadedTimeline,
  type TimelineHeadRevision,
  type TimelineSaveReceipt,
  type TimelineAcceptedIdentity,
  type TimelineCommitCapability,
  type TimelineCommitResult,
  type TimelineCommandBasis,
  type TimelineCommandBasisWithDisplay,
  type TimelineRecoveryIdentity,
  type LoadedReferencedTimeline,
  type ProjectObjectStorage,
  type UploadedAssetResult,
  type UploadAssetOptions,
} from '@/tools/video-editor/data/DataProvider.ts';
import type {
  AssetRegistry,
  AssetRegistryEntry,
  TimelineConfig,
} from '@/tools/video-editor/types/index.ts';
import type { GenerationRow } from '@/domains/generation/types/index.ts';
import type { TimelineInspectionResult, Transport } from './generated.ts';
import {
  assertRuntimeMediaImportSize,
  type AssetResolveRequest,
  type AssetUploadRequest,
  type MediaImportOptions,
  type PreparedMediaImport,
} from '@/tools/video-editor/data/AssetResolver.ts';
import type { TimelineBundleEnvelope } from '@/tools/video-editor/data/typed/timelineBundle.ts';
import { parseTimelineBundle } from '@/tools/video-editor/data/typed/timelineBundle.ts';
import { withDefaultTimelineOutput } from '@/tools/video-editor/lib/defaults.ts';
import {
  ShotCompositionUnavailableError,
  type CanonicalShotCompositionHistoryEntry,
  type ShotCompositionHeadReadRequest,
  type ShotCompositionPort,
  type ShotPlacement,
} from '@/tools/video-editor/data/shotCompositionAdapter.ts';
import {
  stableOccurrenceDeepLink,
  stableOutputIdentity,
  StaleWriteError,
} from '@/tools/video-editor/data/shotComposition.ts';
import { generateUUID } from '@/shared/lib/taskCreation/ids.ts';
import {
  runtimeThumbnailObjectId,
  selectRuntimePrimaryVariant,
} from './generationProjection.ts';
import { listAllRuntimeVariants } from './generationAccess.ts';
import { recordShotTimelinePhase } from '@/tools/video-editor/lib/shot-timeline-timing.ts';
import { isTimelineDiagnosticsEnabled } from '@/tools/video-editor/lib/timeline-diagnostics.ts';
import { initializeBootstrapTimeline as initializeNativeBootstrapTimeline, recoverBootstrapInitialization } from './bootstrapInitialization.ts';
import { createCommitOutbox } from '@/tools/video-editor/commands/commitOutbox.ts';

type RuntimeRecord = Record<string, unknown>;

type CanonicalTimelineState = {
  headRevisionId: string | null;
  headPublicationId: string | null;
  parentComposition: RuntimeRecord;
  version: number;
};

const HEAD_CHECK_DEDUPE_MS = 1_000;
const CANONICAL_HEAD_REFRESH_MS = 6_000;
const PUBLIC_HEAD_PAIR_ATTEMPTS = 2;

export interface RuntimeDataProviderOptions {
  projectId: string;
  baseUrl?: string;
  /** Direct clients may pass a disposable test credential; browser callers use the connector. */
  token?: string;
  transport?: Transport;
  /** @internal Reuse the configured client for the private native-bootstrap seam. */
  runtimeClient?: AstridRuntimeClient;
  /** UI-only observation of connector failures; Runtime remains the IO authority. */
  onRuntimeError?: (error: RuntimeConnectorError) => void;
}

type NativeBootstrapOptions = {
  name: string;
  createName: string | null;
  createKey: string;
  outboxes?: ReturnType<typeof createCommitOutbox>;
};

/**
 * Astrid's neutral-runtime provider. It owns no storage: the generated
 * WorkspaceClient is the only IO authority, and the Runtime's immutable
 * parent-composition head is the editor's config/registry record.
 */
export class RuntimeDataProvider implements DataProvider {
  readonly timelineCommands: TimelineCommitCapability = {
    commitTimeline: (request, idempotencyKey) => this.commitTimeline(request, idempotencyKey),
    undoTimeline: (base, publications, idempotencyKey) => this.undoTimeline(base, publications, idempotencyKey),
    listTimelineCommits: (timelineId, cursor, limit) => this.listTimelineCommits(timelineId, cursor, limit),
  };
  readonly projectTranscripts: ProjectTranscriptRepository;
  readonly documents: NonNullable<DataProvider['documents']>;
  readonly persistenceEnabled = true;
  readonly supportsDirectAssetUpload = true;
  /**
   * Runtime has no public timeline-document event cursor yet. Until that
   * contract exists, the consumer catches up through its canonical versioned
   * read on a bounded cadence; usePollSync decides whether to adopt it.
   */
  readonly refreshIntervalMs = CANONICAL_HEAD_REFRESH_MS;
  readonly apiBaseUrl: string;
  readonly projectObjects: ProjectObjectStorage = {
    ingest: async (bytes, mediaType, filename) => {
      const object = await this.client.ingestProjectObject(this.projectId, bytes, mediaType, filename);
      return {
        object_id: object.object_id,
        digest: object.digest,
        media_type: object.media_type,
        size: object.size,
        ...(object.filename !== undefined ? { filename: object.filename } : {}),
      };
    },
    read: async (objectId) => {
      const location = await this.client.getProjectObjectLocation(this.projectId, objectId);
      if (location.object_id !== objectId) {
        throw new Error(
          `Workspace Runtime project-object authority returned ${location.object_id} for ${objectId}`,
        );
      }
      const response = await this.client.getObject(objectId);
      if (response.etag) {
        assertManagedObjectIdentity(objectId, location.digest, response.etag);
      }
      if (response.data.byteLength !== location.size) {
        throw new Error(
          `Workspace Runtime object size mismatch for ${objectId}: expected ${location.size}, got ${response.data.byteLength}`,
        );
      }
      return response.data;
    },
  };
  readonly shotComposition: ShotCompositionPort = {
    getSourceFrameThumbnailUrl: async (request) => {
      const descriptor = await this.client.getSourceFrameThumbnail(
        request.projectId,
        request.sourceObjectId,
        request.sourceTimeSeconds,
        request.recipeVersion ?? 1,
      );
      const objectId = descriptor && typeof descriptor.object_id === 'string'
        ? descriptor.object_id
        : null;
      return objectId ? this.client.objectContentUrl(objectId) : null;
    },
    load: async (request) => {
      try {
        return await this.loadRuntimeShotComposition(request.projectId, request.parentDocumentId, request.poll);
      } catch (error) {
        throw this.toProviderError(error, request.parentDocumentId);
      }
    },
    loadPlacements: async (request) => {
      try {
        const inspection = await (request.poll
          ? this.pollCanonicalTimelineHead(request.projectId, request.parentDocumentId)
          : this.inspectCanonicalTimelineHead(request.projectId, request.parentDocumentId));
        const headRevisionId = nullableString(inspection.head_revision_id, 'canonical timeline inspection.head_revision_id');
        if (!headRevisionId) return [];
        const cached = this.canonicalTimelineState.get(request.parentDocumentId);
        const parentPayload = cached?.headRevisionId === headRevisionId
          ? cached.parentComposition
          : requiredRecord((await this.readParentCompositionAtHead(
              request.projectId, request.parentDocumentId, headRevisionId,
            )).payload, 'parent composition revision.payload');
        return parentShotPlacements(parentPayload);
      } catch (error) {
        throw this.toProviderError(error, request.parentDocumentId);
      }
    },
    loadAtHead: async (request) => {
      try {
        return await this.loadRuntimeShotCompositionAtHead(request);
      } catch (error) {
        throw this.toProviderError(error, request.parentDocumentId);
      }
    },
    listHistory: async (request) => {
      const entries: CanonicalShotCompositionHistoryEntry[] = [];
      let cursor: string | undefined;
      do {
        const pageKey = JSON.stringify([request.projectId, request.parentDocumentId, cursor ?? null]);
        const page = await this.readImmutableInFlight(pageKey, () => this.client.listProjectParentCompositionRevisions(
          request.projectId,
          request.parentDocumentId,
          cursor,
        ));
        for (const value of page.items) {
          const revisionId = requiredString(value.revision_id, 'composition history.revision_id');
          const projectId = requiredString(value.project_id, 'composition history.project_id');
          const parentDocumentId = requiredString(value.timeline_id, 'composition history.timeline_id');
          if (projectId !== request.projectId || parentDocumentId !== request.parentDocumentId) {
            throw new ShotCompositionUnavailableError('Workspace Runtime returned history outside the requested project and timeline');
          }
          entries.push({
            revisionId,
            projectId,
            parentDocumentId,
            contentDigest: requiredString(value.content_digest, 'composition history.content_digest'),
            createdAt: requiredString(value.created_at, 'composition history.created_at'),
            isCurrentHead: value.is_current_head === true,
          });
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      return entries;
    },
    restoreHistory: async (request) => {
      const timeline = await this.client.getProjectTimeline(request.projectId, request.parentDocumentId);
      assertRuntimeIdentity(timeline, request.projectId, request.parentDocumentId, 'timeline');
      const expectedHead = optionalNullableString(timeline.head_revision_id, 'timeline.head_revision_id');
      const expectedPublication = optionalNullableString(timeline.head_publication_id, 'timeline.head_publication_id');
      if (!expectedHead || !expectedPublication) {
        throw new ShotCompositionUnavailableError('Workspace Runtime timeline requires a verified revision and publication before restoring history');
      }
      const restored = await this.client.restoreProjectParentCompositionRevision(
        request.projectId,
        request.parentDocumentId,
        request.revisionId,
        expectedHead,
        expectedPublication,
        generateUUID(),
      );
      // The ACK contains the exact restored closure, even if head has moved
      // again before the response arrives.
      const result = this.acceptedCommitResult(restored, request.parentDocumentId);
      this.invalidatePolledHead(request.projectId, request.parentDocumentId);
      return { newHead: result.accepted.revisionId };
    },
    publish: async (request) => {
      const publishStartedAt = import.meta.env.DEV ? performance.now() : 0;
      try {
        assertGraphRequestIdentity(request.graph, request.projectId, request.parentDocumentId);
        const headReadStartedAt = import.meta.env.DEV ? performance.now() : 0;
        // A null expected head is an explicit first publication, so there is
        // no existing head to inspect. Every non-null head is still checked
        // through the canonical inspection contract before publishing.
        const inspection = request.expectedHeadRevisionId === null
          ? null
          : await this.inspectCanonicalTimelineHead(request.projectId, request.parentDocumentId);
        this.logShotTimelineLatency('runtime-head-read', headReadStartedAt, request.timingTraceId);
        // Do not reject a retry merely because the mutable head has advanced:
        // Runtime checks durable idempotency replay before its CAS comparison.
        // A new key still receives the Runtime's explicit stale-head 409.
        if (inspection) {
          const currentHead = nullableString(
            inspection.head_revision_id,
            'canonical timeline inspection.head_revision_id',
          );
          if (currentHead === null) {
            throw new ShotCompositionUnavailableError(
              `Workspace Runtime timeline ${request.parentDocumentId} has no published canonical shot-composition head`,
            );
          }
        }
        const publication = await toRuntimePublication(request.graph, request.projectId, request.parentDocumentId, request.expectedHeadRevisionId);
        const idempotencyKey = request.idempotencyKey ?? await stablePublicationKey(
          request.projectId,
          request.parentDocumentId,
          request.expectedHeadRevisionId,
          request.graph,
        );
        const commitStartedAt = import.meta.env.DEV ? performance.now() : 0;
        const committed = await this.client.publishParentComposition(
          request.projectId,
          request.parentDocumentId,
          publication,
          idempotencyKey,
        );
        this.logShotTimelineLatency('runtime-publish-request', commitStartedAt, request.timingTraceId);
        // Never reload the mutable current head here: another writer may have
        // advanced it before the response arrived. Pin the returned receipt's
        // exact immutable revision and carry the receipt/diff alongside it.
        const committedHead = committed.revision_id ?? committed.parent_revision_id ?? committed.new_head;
        if (typeof committedHead !== 'string' || committedHead.length === 0) {
          throw new Error('Workspace Runtime publication receipt omitted its committed parent head');
        }
        this.invalidatePolledHead(request.projectId, request.parentDocumentId);
        const reloadStartedAt = import.meta.env.DEV ? performance.now() : 0;
        const graph = await this.loadRuntimeShotCompositionAtHead({
          projectId: request.projectId,
          parentDocumentId: request.parentDocumentId,
          headRevisionId: committedHead,
        });
        this.logShotTimelineLatency('runtime-exact-head-reload', reloadStartedAt, request.timingTraceId);
        const receipt = asRecord((committed as RuntimeRecord).receipt);
        const result = asRecord(receipt?.result);
        const changedIdentities = publicationChangedIdentities(result, committedHead);
        const publishedGraph = {
          ...(graph as RuntimeRecord),
          publication_receipt: {
            ...(typeof receipt?.receipt_id === 'string' ? { receipt_id: receipt.receipt_id } : {}),
            idempotency_key: idempotencyKey,
            ...(typeof receipt?.request_hash === 'string' ? { request_hash: receipt.request_hash } : {}),
            expected_head: request.expectedHeadRevisionId,
            new_head: committedHead,
            changed_identities: changedIdentities,
            diff: result ?? {},
          },
        };
        this.logShotTimelineLatency('runtime-publish-total', publishStartedAt, request.timingTraceId);
        return publishedGraph;
      } catch (error) {
        if (isRuntimeConflict(error)) {
          throw new StaleWriteError(`Workspace Runtime rejected a stale shot-composition write: ${error.message}`);
        }
        throw this.toProviderError(error, request.parentDocumentId);
      }
    },
  };

  private readonly projectId: string;
  private readonly client: AstridRuntimeClient;
  readonly paramReadClient: NonNullable<DataProvider['paramReadClient']> = {
    getProjectVerifiedDocument: (projectId, pin) => {
      if (projectId !== this.projectId) throw new Error('Retained document read belongs to another project');
      return this.client.getProjectVerifiedDocument(this.projectId, pin);
    },
    getProjectVerifiedDocumentObject: (projectId, pin, objectId) => {
      if (projectId !== this.projectId) throw new Error('Retained document object read belongs to another project');
      return this.client.getProjectVerifiedDocumentObject(this.projectId, pin, objectId);
    },
  };
  private readonly onRuntimeError?: (error: RuntimeConnectorError) => void;
  private activeRegistry: AssetRegistry | null = null;
  private readonly canonicalTimelineState = new Map<string, CanonicalTimelineState>();
  private readonly checkedHeads = new Map<string, { checkedAt: number; inspection: TimelineInspectionResult }>();
  private readonly headChecksInFlight = new Map<string, Promise<TimelineInspectionResult>>();
  private readonly immutableReadsInFlight = new Map<string, Promise<unknown>>();
  private readonly shotGraphs = new Map<string, { headRevisionId: string; graph: unknown }>();
  private readonly shotRevisions = new Map<string, RuntimeRecord>();
  private readonly internalTimelineRevisions = new Map<string, RuntimeRecord>();
  private readonly timelineOperations = new Map<string, Promise<void>>();
  // One unresolved transport attempt per timeline. Only byte-equivalent input
  // may replay its original key/head; a poll is not an authorship receipt.
  private readonly unacknowledgedSaves = new Map<string, {
    expectedVersion: number;
    requestSignature: string;
    expectedHead: string | null;
    parentComposition: RuntimeRecord;
    idempotencyKey: string;
  }>();

  /** Keep head discovery, immutable payload reads, and publication receipts in
   * one order per timeline. Otherwise an older read can overwrite a save ACK
   * and invent a version conflict on this editor's next edit. Runtime CAS still
   * arbitrates other providers/tabs; this queue never rebases a stale write. */
  private withTimelineOperation<T>(timelineId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.timelineOperations.get(timelineId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => {}, () => {});
    this.timelineOperations.set(timelineId, settled);
    void settled.then(() => {
      if (this.timelineOperations.get(timelineId) === settled) {
        this.timelineOperations.delete(timelineId);
      }
    });
    return result;
  }

  constructor(options: RuntimeDataProviderOptions) {
    this.projectId = options.projectId;
    this.client = options.runtimeClient ?? new AstridRuntimeClient({
      baseUrl: options.baseUrl,
      token: options.token,
      transport: options.transport,
    });
    const documentListeners = new Set<() => void>();
    const notifyDocumentsChanged = () => {
      for (const listener of [...documentListeners]) listener();
    };
    this.documents = {
      list: async (kind, page) => this.client.listDocuments(
        this.projectId, page?.cursor, page?.limit ?? 50, kind,
      ),
      get: (id) => this.client.getDocument(this.projectId, id),
      create: async (kind, content, documentId) => {
        const id = documentId ?? `document:${generateUUID()}`;
        const result = await this.client.createDocument(
          this.projectId, id, kind, content, await documentCreateKey(id),
        );
        notifyDocumentsChanged();
        return result;
      },
      update: async (id, content, expectedVersion) => {
        const result = await this.client.updateDocument(
          this.projectId, id, expectedVersion, content, generateUUID(),
        );
        notifyDocumentsChanged();
        return result;
      },
      onChange: (listener) => {
        documentListeners.add(listener);
        return () => documentListeners.delete(listener);
      },
    };
    this.projectTranscripts = {
      projectId: this.projectId,
      listAll: async () => {
        const documents = [];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const page = await this.client.listDocuments(
            this.projectId,
            cursor,
            100,
            PROJECT_TRANSCRIPT_KIND,
          );
          for (const d of page.items) {
            const parsed = await parseProjectTranscriptDocument(d, this.projectId);
            documents.push(parsed);
          }
          cursor = page.next_cursor ?? undefined;
          if (cursor && cursors.has(cursor))
            throw new Error('Project transcript pagination repeated a cursor.');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        return documents;
      },
      listForMedia: async (mediaId) =>
        (await this.projectTranscripts.listAll()).filter((doc) => doc.content.media_id === mediaId),
      get: async (id) =>
        parseProjectTranscriptDocument(
          await this.client.getDocument(this.projectId, id),
          this.projectId,
        ),
      create: async (content, key) => {
        const parsed = projectTranscriptSchema.parse(content);
        return parseProjectTranscriptDocument(
          await this.client.createDocument(
            this.projectId,
            await transcriptDocumentId(
              this.projectId,
              parsed.media_id,
              parsed.source_id,
            ),
            PROJECT_TRANSCRIPT_KIND,
            parsed,
            key,
          ),
          this.projectId,
        );
      },
      update: async (id, content, version, key) =>
        parseProjectTranscriptDocument(
          await this.client.updateDocument(
            this.projectId,
            id,
            version,
            projectTranscriptSchema.parse(content),
            key,
          ),
          this.projectId,
        ),
    };
    this.onRuntimeError = options.onRuntimeError;
    this.apiBaseUrl = this.client.baseUrl;
  }

  /**
   * @internal Private create/init seam. It owns no new storage or wire shape:
   * bootstrapInitialization uses the existing command outbox and this provider's
   * guarded generated-client methods for create, history, immutable reads, and
   * native commit.
   */
  async initializeNativeBootstrapTimeline(
    timelineId: string,
    options: NativeBootstrapOptions,
  ): Promise<TimelineCommandBasis> {
    const identity = await this.client.getRecoverableIdentity();
    return initializeNativeBootstrapTimeline(
      { ...identity, projectId: this.projectId, timelineId },
      {
        ...options,
        ports: {
          createTimeline: (project, timeline, key, name) => this.client.createTimeline(project, timeline, key, name),
          listTimelineCommits: (project, timeline, cursor, limit) => this.client.listTimelineCommits(project, timeline, cursor, limit),
          getProjectParentCompositionRevision: (project, timeline, revision) =>
            this.client.getProjectParentCompositionRevision(project, timeline, revision),
          loadLatest: (id) => this.loadTimelineCommandBasis(id),
          commitTimeline: (request, key) => this.commitTimeline(request, key),
        },
      },
    );
  }

  async recoverNativeBootstrapTimeline(timelineId: string, ownerId: string): Promise<TimelineCommandBasis> {
    const identity = await this.client.getRecoverableIdentity();
    return recoverBootstrapInitialization(
      { ...identity, projectId: this.projectId, timelineId },
      ownerId,
      {
        createTimeline: (project, timeline, key, name) => this.client.createTimeline(project, timeline, key, name),
        listTimelineCommits: (project, timeline, cursor, limit) => this.client.listTimelineCommits(project, timeline, cursor, limit),
        getProjectParentCompositionRevision: (project, timeline, revision) =>
          this.client.getProjectParentCompositionRevision(project, timeline, revision),
        loadLatest: (id) => this.loadTimelineCommandBasis(id),
        commitTimeline: (request, key) => this.commitTimeline(request, key),
      },
    );
  }

  private async loadRuntimeShotComposition(projectId: string, timelineId: string, poll = false): Promise<unknown> {
    const startedAt = import.meta.env.DEV ? performance.now() : 0;
    const inspection = await (poll
      ? this.pollCanonicalTimelineHead(projectId, timelineId)
      : this.inspectCanonicalTimelineHead(projectId, timelineId));
    if (!poll) this.rememberFreshHead(projectId, timelineId, inspection);
    const headRevisionId = nullableString(inspection.head_revision_id, 'canonical timeline inspection.head_revision_id');
    if (headRevisionId === null) {
      throw new ShotCompositionUnavailableError(
        `Workspace Runtime timeline ${timelineId} has no published canonical shot-composition head`,
      );
    }
    const key = JSON.stringify([projectId, timelineId]);
    const cached = this.shotGraphs.get(key);
    const graph = poll && cached?.headRevisionId === headRevisionId
      ? cached.graph
      : await this.loadRuntimeShotCompositionAtHead({ projectId, parentDocumentId: timelineId, headRevisionId });
    if (poll && cached?.headRevisionId !== headRevisionId) this.shotGraphs.set(key, { headRevisionId, graph });
    this.logShotTimelineLatency('runtime-composition-load', startedAt);
    return graph;
  }

  /**
   * Resolve the current immutable composition head through Runtime's typed
   * inspection contract. The legacy timeline resource is deliberately not a
   * head-discovery fallback: it is a mutable document and may describe a
   * different shell than the canonical shot composition.
   */
  private async inspectCanonicalTimelineHead(
    projectId: string,
    timelineId: string,
  ): Promise<TimelineInspectionResult> {
    // The head fields are independent of selected clips. One item keeps this
    // head-only response small even for a large composition.
    const inspection = await this.client.inspectTimeline(projectId, timelineId, { limit: 1 });
    if (inspection.project_id !== projectId) {
      throw new Error(
        `Workspace Runtime canonical timeline inspection belongs to project ${String(inspection.project_id)}, not ${projectId}`,
      );
    }
    if (inspection.timeline_id !== timelineId) {
      throw new Error(
        `Workspace Runtime canonical timeline inspection belongs to timeline ${String(inspection.timeline_id)}, not ${timelineId}`,
      );
    }
    if (inspection.representation !== 'canonical_head') {
      throw new Error(
        `Workspace Runtime canonical timeline inspection returned ${String(inspection.representation)} instead of canonical_head`,
      );
    }
    if (inspection.authority !== 'runtime_parent_composition') {
      throw new Error(
        `Workspace Runtime canonical timeline inspection returned authority ${String(inspection.authority)}`,
      );
    }
    if (inspection.is_current_head !== true) {
      throw new Error('Workspace Runtime canonical timeline inspection is not the current head');
    }
    const headRevisionId = nullableString(
      inspection.head_revision_id,
      'canonical timeline inspection.head_revision_id',
    );
    if (headRevisionId !== null && inspection.revision_id !== headRevisionId) {
      throw new Error(
        `Workspace Runtime canonical timeline inspection revision ${inspection.revision_id} does not match head ${headRevisionId}`,
      );
    }
    return inspection;
  }

  private pollCanonicalTimelineHead(projectId: string, timelineId: string): Promise<TimelineInspectionResult> {
    this.client.assertNotFenced();
    const key = JSON.stringify([projectId, timelineId]);
    const running = this.headChecksInFlight.get(key);
    if (running) return running;
    const cached = this.checkedHeads.get(key);
    if (cached && Date.now() - cached.checkedAt < HEAD_CHECK_DEDUPE_MS) return Promise.resolve(cached.inspection);
    const check: Promise<TimelineInspectionResult> = this.inspectCanonicalTimelineHead(projectId, timelineId).then((inspection) => {
      if (this.headChecksInFlight.get(key) === check) {
        this.checkedHeads.set(key, { checkedAt: Date.now(), inspection });
      }
      return inspection;
    }).finally(() => {
      if (this.headChecksInFlight.get(key) === check) this.headChecksInFlight.delete(key);
    });
    this.headChecksInFlight.set(key, check);
    return check;
  }

  private readImmutableInFlight<T>(key: string, load: () => Promise<T>): Promise<T> {
    const running = this.immutableReadsInFlight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const read = load().finally(() => {
      if (this.immutableReadsInFlight.get(key) === read) this.immutableReadsInFlight.delete(key);
    });
    this.immutableReadsInFlight.set(key, read);
    return read;
  }

  private invalidatePolledHead(projectId: string, timelineId: string): void {
    const key = JSON.stringify([projectId, timelineId]);
    this.checkedHeads.delete(key);
    this.headChecksInFlight.delete(key);
  }

  private rememberFreshHead(projectId: string, timelineId: string, inspection: TimelineInspectionResult): void {
    this.invalidatePolledHead(projectId, timelineId);
    this.checkedHeads.set(JSON.stringify([projectId, timelineId]), { checkedAt: Date.now(), inspection });
  }

  private logShotTimelineLatency(phase: string, startedAt: number, traceId?: string): void {
    if (!isTimelineDiagnosticsEnabled()) return;
    const durationMs = Math.round(performance.now() - startedAt);
    if (traceId) {
      recordShotTimelinePhase(traceId, phase, { durationMs });
      return;
    }
    console.debug('[ShotTimelineLatency]', {
      phase,
      durationMs,
    });
  }

  private async readParentCompositionAtHead(projectId: string, timelineId: string, headRevisionId: string): Promise<RuntimeRecord> {
    const parent = await this.readImmutableInFlight(
      JSON.stringify(['parent', projectId, timelineId, headRevisionId]),
      () => this.client.getProjectParentCompositionRevision(projectId, timelineId, headRevisionId),
    );
    assertRuntimeIdentity(parent, projectId, timelineId, 'parent composition revision');
    assertRevisionIdentity(parent, headRevisionId, 'parent composition revision');
    return parent;
  }

  private async loadRuntimeShotCompositionAtHead({ projectId, parentDocumentId: timelineId, headRevisionId }: ShotCompositionHeadReadRequest): Promise<unknown> {
    const parent = await this.readParentCompositionAtHead(projectId, timelineId, headRevisionId);
    const parentPayload = requiredRecord(parent.payload, 'parent composition revision.payload');
    const rawOccurrences = array(parentPayload.occurrences, 'parent composition.occurrences');
    const identities = uniqueOccurrences(rawOccurrences).map((occurrence) => ({
      shotId: requiredString(occurrence.shot_id, 'parent composition occurrence.shot_id'),
      revisionId: requiredString(occurrence.shot_revision_id ?? occurrence.revision_id, 'parent composition occurrence.shot_revision_id'),
    }));
    const resolved = await Promise.all(identities.map(async ({ shotId, revisionId }) => {
      // Revision ids are unique per shot, not across shots (shot-alpha/rev-a and
      // shot-beta/rev-a are different immutable records), so key by both.
      const shotKey = `${shotId}\u0000${revisionId}`;
      let shot = this.shotRevisions.get(shotKey);
      if (!shot) {
        shot = await this.readImmutableInFlight(
          JSON.stringify(['shot', projectId, shotId, revisionId]),
          () => this.client.getProjectShotRevision(projectId, shotId, revisionId),
        );
        assertRuntimeIdentity(shot, projectId, shotId, 'shot revision');
        assertRevisionIdentity(shot, revisionId, 'shot revision');
        if (shot.shot_id !== shotId) throw new Error(`Runtime shot revision identity mismatch: requested ${shotId}, got ${String(shot.shot_id)}`);
        this.shotRevisions.set(shotKey, shot);
      }
      const internalRevisionId = requiredString(shot.internal_timeline_revision_id, `shot revision ${revisionId}.internal_timeline_revision_id`);
      // The shot revision may carry the canonical immutable timeline scope;
      // otherwise the parent timeline is the only admitted scope. A missing
      // revision is a hard availability failure. Do not probe synthetic
      // `shot:<id>` scopes, which would reintroduce child-timeline reads.
      const internalTimelineScope = typeof shot.timeline_id === 'string' && shot.timeline_id.length > 0
        ? shot.timeline_id
        : timelineId;
      let internal = this.internalTimelineRevisions.get(internalRevisionId);
      if (!internal) {
        try {
          internal = await this.readImmutableInFlight(
            JSON.stringify(['internal-timeline', projectId, internalTimelineScope, internalRevisionId]),
            () => this.client.getProjectTimelineRevision(projectId, internalTimelineScope, internalRevisionId),
          );
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            throw new ShotCompositionUnavailableError(
              `Workspace Runtime canonical internal timeline revision ${internalRevisionId} is unavailable at scope ${internalTimelineScope}`,
            );
          }
          throw error;
        }
        assertRuntimeIdentity(internal, projectId, internalTimelineScope, 'internal timeline revision');
        assertRevisionIdentity(internal, internalRevisionId, 'internal timeline revision');
        this.internalTimelineRevisions.set(internalRevisionId, internal);
      }
      return { shot, internal };
    }));
    return runtimeGraphToContract(
      projectId,
      timelineId,
      { project_id: projectId, timeline_id: timelineId, version: 1, head_revision_id: headRevisionId },
      parent,
      resolved,
    );
  }

  /** Re-open the cached Runtime handshake before the next hosted read. */
  async reconnect(): Promise<void> {
    try {
      await this.client.reconnect();
    } catch (error) {
      this.reportRuntimeError(error);
      throw error;
    }
  }

  async getRecoverableIdentity(): Promise<TimelineRecoveryIdentity> {
    return this.client.getRecoverableIdentity();
  }

  /**
   * Send a producer-built command batch and consume only its returned closure.
   * This adapter deliberately does not inspect the mutable head or rebuild the
   * command after the request: the Runtime response is the accepted basis.
   */
  async commitTimeline(request: CommitRequest, idempotencyKey: string): Promise<TimelineCommitResult> {
    if (request.project_id !== this.projectId || !request.timeline_id) {
      throw new TimelineSchemaIncompatibleError('Timeline commit request has an untrusted project or timeline identity');
    }
    if (!request.base_revision_id || !request.base_publication_id) {
      throw new TimelineSchemaIncompatibleError('Timeline commit requires a verified revision and publication base');
    }
    const response = await this.client.commitTimeline(
      request.project_id,
      request.timeline_id,
      request,
      idempotencyKey,
    );
    if (response.receipt === null) {
      throw new TimelineSchemaIncompatibleError('Timeline preview is not an accepted commit');
    }
    return this.acceptedCommitResult(response, request.timeline_id);
  }

  /** Build the canonical explicit inverse command, then use the same commit path. */
  async undoTimeline(
    base: TimelineHeadRevision,
    publications: readonly string[],
    idempotencyKey: string,
  ): Promise<TimelineCommitResult> {
    if (base.projectId !== this.projectId || !base.timelineId || !base.headRevisionId || !base.headPublicationId) {
      throw new TimelineSchemaIncompatibleError('Timeline undo requires a verified revision and publication base');
    }
    const targets = [...publications];
    if (targets.length === 0 || targets.some((value) => typeof value !== 'string' || value.length === 0)
      || new Set(targets).size !== targets.length) {
      throw new TimelineSchemaIncompatibleError('Timeline undo requires unique accepted publication IDs');
    }
    const command: EditCommand = {
      schema_version: 1,
      op: 'timeline.inverse',
      version: '1',
      select: null,
      args: { publications: targets },
    };
    return this.commitTimeline({
      api_version: 1,
      project_id: base.projectId,
      timeline_id: base.timelineId,
      base_revision_id: base.headRevisionId,
      base_publication_id: base.headPublicationId,
      commands: [command],
      source: { via: 'app' },
    }, idempotencyKey);
  }

  async listTimelineCommits(timelineId: string, cursor?: string, limit = 50): Promise<HistoryPage> {
    if (!timelineId) throw new TimelineSchemaIncompatibleError('Timeline history requires a timeline identity');
    return this.client.listTimelineCommits(this.projectId, timelineId, cursor, limit);
  }

  private acceptedCommitResult(response: CommitAcceptedMutation, timelineId: string): TimelineCommitResult {
    const data = response.data;
    const receipt = response.receipt;
    if (!['accepted', 'rebased', 'merged'].includes(data.status)
      || receipt.project_id !== this.projectId || receipt.command_kind !== 'timeline.commit') {
      throw new TimelineSchemaIncompatibleError('Workspace Runtime returned an invalid timeline acceptance envelope');
    }
    acceptedDigest(data.document_digest, 'document_digest');
    const publicationId = requiredString(receipt.receipt_id, 'timeline commit receipt.receipt_id');
    const canonicalDocument = validateAcceptedCanonicalDocument(data.canonical_document, this.projectId, timelineId, data.accepted_revision_id);
    assertIdentityMap(data.id_map);
    const graph = runtimeGraphToContractFromCanonicalDocument(
      this.projectId,
      timelineId,
      canonicalDocument,
      publicationId,
    );
    const accepted: TimelineAcceptedIdentity = {
      revisionId: data.accepted_revision_id,
      publicationId,
    };
    const current = this.canonicalTimelineState.get(timelineId);
    // A replayed/late A acknowledgement may be older than a known current C.
    // It remains an exact historical basis and must never regress the cache.
    if (!current || (current.headRevisionId === data.base_revision_id
      && current.headPublicationId === data.base_publication_id)) {
      const parentPayload = data.canonical_document.parent_revision.payload as RuntimeRecord;
      this.canonicalTimelineState.set(timelineId, {
        headRevisionId: accepted.revisionId,
        headPublicationId: accepted.publicationId,
        parentComposition: parentPayload,
        version: (current?.version ?? 0) + (current?.headRevisionId === accepted.revisionId
          && current.headPublicationId === accepted.publicationId ? 0 : 1),
      });
      this.activeRegistry = normalizeRegistry(parentPayload.registry, this.client);
    }
    return { response, accepted, canonicalDocument, graph, receipt };
  }

  async resolveTimelineCommandAsset(file: string, registry: AssetRegistry): Promise<string> {
    return this.resolveAssetUrlFromRegistry(file, registry);
  }

  async getProjectMediaSelection(
    projectId: string,
    selection: MediaSelectionQuery,
  ): Promise<MediaSelection> {
    if (projectId !== this.projectId) {
      throw new Error(
        `Workspace Runtime media selection read requires project ${this.projectId}, got ${projectId}`,
      );
    }
    return this.client.getProjectMediaSelection(projectId, selection);
  }

  async getProjectVerifiedMedia(
    projectId: string,
    selection: MediaSelection,
  ): Promise<VerifiedMedia> {
    const originalSelection = Object.freeze({
      asset: selection.asset,
      generation_id: selection.generation_id,
      variant_id: selection.variant_id,
      object_id: selection.object_id,
      catalog_digest: selection.catalog_digest,
    });
    if (projectId !== this.projectId) {
      throw new Error(
        `Workspace Runtime verified media read requires project ${this.projectId}, got ${projectId}`,
      );
    }
    const verified = await this.client.getProjectVerifiedMedia(projectId, originalSelection);
    if (!sameMediaSelection(verified.selection, originalSelection)) {
      throw new Error('Workspace Runtime verified media read returned a mismatched selection');
    }
    return verified;
  }

  /** Public verified history pins plus scoped immutable reads, never projected rows. */
  async loadTimelineCommandBasis(timelineId: string): Promise<TimelineCommandBasis> {
    const observe = timelineBasisDiagnostics(this);
    const finishLoader = observe('loader');
    // Immutable reads are complete only when their assembled closure validates.
    const pendingReads: Array<(completed: boolean) => void> = [];
    try {
      const requireHead = (page: HistoryPage): HistoryPage['head'] => {
        const head = page?.head;
        if (!head || typeof head.revision_id !== 'string' || !head.revision_id
          || typeof head.publication_id !== 'string' || !head.publication_id) {
          throw new TimelineSchemaIncompatibleError('Workspace Runtime returned a malformed timeline history head');
        }
        return head;
      };
      const finishFirstHistory = observe('history');
      let firstHistory;
      let firstHead;
      try {
        firstHistory = await this.listTimelineCommits(timelineId);
        firstHead = requireHead(firstHistory);
        finishFirstHistory(true);
      } catch (error) {
        finishFirstHistory(false);
        throw error;
      }
      const pages = [firstHistory];
      const seenCursors = new Set<string>();
      while (pages[pages.length - 1]!.next_cursor !== null) {
        const cursor = pages[pages.length - 1]!.next_cursor!;
        if (seenCursors.has(cursor)) {
          throw new TimelineSchemaIncompatibleError('Workspace Runtime returned a cyclic timeline history cursor');
        }
        seenCursors.add(cursor);
        const finishNextPage = observe('history');
        let nextPage;
        try {
          nextPage = await this.listTimelineCommits(timelineId, cursor);
          const nextHead = requireHead(nextPage);
          if (nextHead.revision_id !== firstHead.revision_id
            || nextHead.publication_id !== firstHead.publication_id) {
            throw new TimelineSchemaIncompatibleError('Workspace Runtime changed the captured timeline history head');
          }
          finishNextPage(true);
        } catch (error) {
          finishNextPage(false);
          throw error;
        }
        pages.push(nextPage);
      }
      const history: HistoryPage = {
        ...firstHistory,
        items: pages.flatMap((page) => page.items),
        next_cursor: null,
      };
      const head = history.head;
      if (!head?.revision_id || !head.publication_id) {
        throw new TimelineSchemaIncompatibleError('Timeline has no verified authoring history head');
      }
      const finishParent = observe('parent');
      pendingReads.push(finishParent);
      const parent = await this.readParentCompositionAtHead(this.projectId, timelineId, head.revision_id);
      const manifest = requiredRecord(parent.dependency_manifest, 'verified parent dependency manifest');
      const shots = await Promise.all(array(manifest.shots, 'baseline shots').map(async (value) => {
        const pin = requiredRecord(value, 'baseline shot pin');
        const shotId = requiredString(pin.shot_id, 'baseline shot_id');
        const revision = requiredString(pin.revision_id, 'baseline shot revision_id');
        const finishShot = observe('shot');
        pendingReads.push(finishShot);
        const shot = await this.client.getProjectShotRevision(this.projectId, shotId, revision);
        assertRuntimeIdentity(shot, this.projectId, shotId, 'shot revision');
        assertRevisionIdentity(shot, revision, 'shot revision');
        if (shot.shot_id !== shotId || shot.content_digest !== pin.content_digest
          || shot.internal_timeline_revision_id !== pin.internal_timeline_revision_id) {
          throw new TimelineSchemaIncompatibleError('Baseline shot pin mismatch');
        }
        return { shot_id: pin.shot_id, revision_id: pin.revision_id, internal_timeline_revision_id: pin.internal_timeline_revision_id,
          content_digest: pin.content_digest, payload: requiredRecord(shot.payload, 'shot payload') };
      }));
      const internals = await Promise.all(array(manifest.internal_timelines, 'baseline internals').map(async (value) => {
        const pin = requiredRecord(value, 'baseline internal pin');
        const scope = requiredString(pin.timeline_id, 'baseline internal timeline_id');
        const revision = requiredString(pin.revision_id, 'baseline internal revision_id');
        const finishInternal = observe('internal');
        pendingReads.push(finishInternal);
        const internal = await this.client.getProjectTimelineRevision(this.projectId, scope, revision);
        assertRuntimeIdentity(internal, this.projectId, scope, 'internal timeline revision');
        assertRevisionIdentity(internal, revision, 'internal timeline revision');
        if (internal.content_digest !== pin.content_digest) throw new TimelineSchemaIncompatibleError('Baseline internal pin mismatch');
        return { timeline_id: pin.timeline_id, revision_id: pin.revision_id, content_digest: pin.content_digest,
          payload: requiredRecord(internal.payload, 'internal payload') };
      }));
      const raw = { schema_version: 1, project_id: this.projectId, timeline_id: timelineId,
          parent_revision: { revision_id: head.revision_id, content_digest: parent.content_digest, payload: parent.payload },
          shot_revisions: shots, internal_timeline_revisions: internals,
          dependency_manifest: manifest };
      const canonicalDocument = validateAcceptedCanonicalDocument(raw as CanonicalDocument, this.projectId, timelineId, head.revision_id);
      const result = {
        head: { revisionId: head.revision_id, publicationId: head.publication_id }, canonicalDocument, history,
        graph: runtimeGraphToContractFromCanonicalDocument(this.projectId, timelineId, canonicalDocument, head.publication_id),
      };
      for (const finish of pendingReads) finish(true);
      finishLoader(true);
      return result;
    } catch (error) {
      for (const finish of pendingReads) finish(false);
      finishLoader(false);
      throw error;
    }
  }

  async loadTimelineCommandBasisWithDisplay(timelineId: string): Promise<TimelineCommandBasisWithDisplay> {
    const basis = await this.loadTimelineCommandBasis(timelineId);
    const { timeline, registry } = await this.loadReferencedTimeline(timelineId);
    if (timeline.head?.headRevisionId !== basis.head.revisionId
      || timeline.head.headPublicationId !== basis.head.publicationId) {
      throw new TimelineVersionConflictError('Timeline document changed while pairing authoring basis and display');
    }
    return { basis, timeline, registry };
  }

  async loadTimeline(timelineId: string, options?: { poll?: boolean }): Promise<LoadedTimeline> {
    const record = await this.readTimeline(timelineId, options?.poll);
    const configRecord = asRecord(record.config);
    if (!configRecord) {
      throw new TimelineSchemaIncompatibleError('Workspace Runtime timeline has no config object');
    }
    const bundle = configRecord.bundle;
    if (bundle !== undefined && bundle !== null) parseTimelineBundle(bundle);
    const { bundle: _storedBundle, ...configWithoutBundle } = configRecord;
    return {
      config: { ...configWithoutBundle, ...withDefaultTimelineOutput(configWithoutBundle as Partial<TimelineConfig>) },
      configVersion: runtimeVersion(record),
      head: this.timelineHead(timelineId, record.head_revision_id as string | null, optionalNullableString(record.head_publication_id, 'timeline.head_publication_id')),
      ...(bundle === null ? { bundle: null } : bundle === undefined ? {} : { bundle: bundle as TimelineBundleEnvelope }),
    };
  }

  async loadAssetRegistry(timelineId: string, options?: { poll?: boolean }): Promise<AssetRegistry> {
    const registry = normalizeRegistry((await this.readTimeline(timelineId, options?.poll)).registry, this.client);
    this.activeRegistry = registry;
    return registry;
  }

  async loadReferencedTimeline(timelineId: string, options?: { poll?: boolean }): Promise<LoadedReferencedTimeline> {
    const record = await this.readTimeline(timelineId, options?.poll);
    const configRecord = asRecord(record.config);
    if (!configRecord) {
      throw new TimelineSchemaIncompatibleError('Workspace Runtime timeline has no config object');
    }
    const bundle = configRecord.bundle;
    if (bundle !== undefined && bundle !== null) parseTimelineBundle(bundle);
    const { bundle: _storedBundle, ...configWithoutBundle } = configRecord;
    return {
      timeline: {
        config: { ...configWithoutBundle, ...withDefaultTimelineOutput(configWithoutBundle as Partial<TimelineConfig>) },
        configVersion: runtimeVersion(record),
        head: this.timelineHead(timelineId, record.head_revision_id as string | null, optionalNullableString(record.head_publication_id, 'timeline.head_publication_id')),
        ...(bundle === null ? { bundle: null } : bundle === undefined ? {} : { bundle: bundle as TimelineBundleEnvelope }),
      },
      registry: normalizeRegistry(record.registry, this.client),
      resolveAssetUrl: async (file: string) => this.resolveAssetUrlFromRegistry(file, normalizeRegistry(record.registry, this.client)),
    };
  }

  async setPrimaryTimeline(timelineId: string): Promise<void> {
    const project = await this.client.getProject(this.projectId);
    await this.client.updateProject(
      this.projectId,
      generateUUID(),
      project.version,
      undefined,
      { ...project.metadata, default_timeline_id: timelineId },
    );
  }

  async saveTimeline(
    timelineId: string,
    config: TimelineConfig,
    expectedVersion: number,
    _registry?: AssetRegistry,
    _bundle?: TimelineBundleEnvelope | null,
  ): Promise<number> {
    throw new TimelineSaveError('Workspace Runtime requires the original scoped timeline head; numeric versions cannot authorize a save.');
  }

  private timelineHead(timelineId: string, headRevisionId: string | null, headPublicationId: string | null = null): TimelineHeadRevision {
    return { projectId: this.projectId, timelineId, headRevisionId, headPublicationId };
  }

  async saveTimelineAtHead(
    timelineId: string,
    config: TimelineConfig,
    expectedHead: TimelineHeadRevision,
    registry?: AssetRegistry,
    bundle?: TimelineBundleEnvelope | null,
  ): Promise<TimelineSaveReceipt> {
    if (expectedHead?.projectId !== this.projectId || expectedHead.timelineId !== timelineId
      || !(expectedHead.headRevisionId === null || (typeof expectedHead.headRevisionId === 'string' && expectedHead.headRevisionId.length > 0))) {
      throw new TimelineSaveError('Workspace Runtime save has missing or untrusted timeline head provenance.');
    }
    const base = { ...expectedHead };
    return this.withTimelineOperation(timelineId, () =>
      this.saveTimelineInOrder(timelineId, config, base, registry, bundle));
  }

  private async saveTimelineInOrder(
    timelineId: string,
    config: TimelineConfig,
    base: TimelineHeadRevision,
    registry?: AssetRegistry,
    bundle?: TimelineBundleEnvelope | null,
  ): Promise<TimelineSaveReceipt> {
    if (bundle !== undefined && bundle !== null) parseTimelineBundle(bundle);
    let current = this.canonicalTimelineState.get(timelineId);
    if (!current) {
      await this.readTimelineInOrder(timelineId);
      current = this.canonicalTimelineState.get(timelineId);
    }
    if (!current) {
      throw new TimelineSchemaIncompatibleError('Workspace Runtime canonical timeline state was not loaded');
    }
    const expectedVersion = current.version;
    const deletedTransitions = config.clips
      .filter((clip) => Object.prototype.hasOwnProperty.call(clip, 'transition') && clip.transition === undefined)
      .map((clip) => clip.id);
    // JSON omits undefined. Pending acknowledgements must still distinguish an
    // explicit None action from an otherwise identical partial clip edit.
    const requestSignature = stableJson({ config, registry, bundle,
      ...(deletedTransitions.length > 0 ? { deletedTransitions } : {}),
    });
    const pending = this.unacknowledgedSaves.get(timelineId);
    const replay = pending?.expectedHead === base.headRevisionId
      && pending.requestSignature === requestSignature ? pending : undefined;
    if (pending && !replay && pending.expectedHead === base.headRevisionId) {
      throw new OwnUnacknowledgedSaveError('An unacknowledged save owns this timeline head and payload; resolve its acknowledgement before publishing another edit.');
    }
    // Load the immutable base payload, not a newer cached/polled head. Runtime
    // owns CAS (and checks idempotency replay first), including read/publish races.
    const baseComposition = replay ? replay.parentComposition
      : current.headRevisionId === base.headRevisionId ? current.parentComposition
      : base.headRevisionId === null ? { config: {}, registry: { assets: {} }, clips: [], occurrences: [] }
      : await this.client.getProjectParentCompositionRevision(this.projectId, timelineId, base.headRevisionId)
          .then((record) => {
            assertRuntimeIdentity(record, this.projectId, timelineId, 'parent composition revision');
            assertRevisionIdentity(record, base.headRevisionId!, 'parent composition revision');
            return requiredRecord(record.payload, 'parent composition revision.payload');
          });
    const nextRegistry = normalizeRegistry(registry ?? baseComposition.registry, this.client);
    const { output: _derivedOutput, ...configWithoutOutput } = config;
    const baseConfig = asRecord(baseComposition.config);
    const { output: _baseDerivedOutput, ...baseConfigWithoutOutput } = baseConfig ?? {};
    const storedBundle = baseConfig?.bundle;
    const nextClips = reconcileParentClips(baseComposition, config.clips);
    const configForWire: RuntimeRecord = {
      ...baseConfigWithoutOutput,
      ...configWithoutOutput,
      // Runtime accepts the legacy duplicate for compatibility, but both
      // copies must describe the same authored parent clips. Keeping the
      // editor's authored order/content here also preserves clip edits while
      // reconciling the canonical top-level field below.
      clips: nextClips,
      tracks: config.tracks ?? [],
      ...(bundle !== undefined
        ? { bundle }
        : storedBundle !== undefined
          ? { bundle: storedBundle }
          : {}),
    };
    const parentComposition: RuntimeRecord = replay?.parentComposition ?? {
      ...baseComposition,
      clips: nextClips,
      config: configForWire,
      registry: nextRegistry,
    };
    const expectedHead = base.headRevisionId;
    const idempotencyKey = replay?.idempotencyKey ?? await stableTimelinePublicationKey(
      this.projectId,
      timelineId,
      expectedHead,
      parentComposition,
    );
    this.unacknowledgedSaves.set(timelineId, {
      expectedVersion, requestSignature, expectedHead,
      parentComposition: structuredClone(parentComposition), idempotencyKey,
    });

    const publishStartedAt = performance.now();
    if (isTimelineDiagnosticsEnabled()) {
      console.log('[TimelineSave] runtime publish start', {
        projectId: this.projectId,
        timelineId,
        expectedHead,
        idempotencyKey,
        payloadBytes: JSON.stringify({
          expected_head: expectedHead,
          parent_composition: parentComposition,
        }).length,
        topLevelClipIds: Array.isArray(parentComposition.clips)
          ? parentComposition.clips.map((clip) => asRecord(clip)?.id)
          : null,
        configClipIds: Array.isArray(asRecord(parentComposition.config)?.clips)
          ? (asRecord(parentComposition.config)?.clips as unknown[]).map((clip) => asRecord(clip)?.id)
          : null,
      });
    }
    try {
      const saved = await this.client.publishParentComposition(
        this.projectId,
        timelineId,
        {
          expected_head: expectedHead,
          parent_revision_id: idempotencyKey,
          parent_composition: parentComposition,
          // Existing immutable child revisions are resolved by Runtime from
          // the parent occurrences. The editor only changes the parent
          // config/registry, so it must not reconstruct child authority.
          internal_timeline_revisions: [],
          shot_revisions: [],
        },
        idempotencyKey,
      );
      if (isTimelineDiagnosticsEnabled()) {
        console.log('[TimelineSave] runtime publish success', {
          projectId: this.projectId,
          timelineId,
          durationMs: Math.round(performance.now() - publishStartedAt),
          revisionId: saved.revision_id ?? saved.parent_revision_id ?? saved.new_head,
        });
      }
      const committedHead = saved.revision_id ?? saved.parent_revision_id ?? saved.new_head;
      if (typeof committedHead !== 'string' || committedHead.length === 0) {
        throw new Error('Workspace Runtime publication receipt omitted its committed parent head');
      }
      // A replay receipt proves our save committed, but must never rebase a
      // local draft onto a different head observed in the meantime.
      if (current.headRevisionId !== expectedHead && current.headRevisionId !== committedHead) {
        throw new TimelineVersionConflictError(
          'The save was confirmed, but the timeline has since changed; review the current head.',
          expectedVersion, current.version,
        );
      }
      const savedRegistry = normalizeRegistry(parentComposition.registry, this.client);
      const nextVersion = current.headRevisionId === committedHead ? current.version : current.version + 1;
      // The retired whole-document publication path does not prove the new
      // commit-history publication pin. Keep it read-only until a verified
      // command ACK or baseline supplies the pair.
      const savedPublicationId = null;
      this.canonicalTimelineState.set(timelineId, {
        headRevisionId: committedHead,
        headPublicationId: savedPublicationId,
        parentComposition: {
          ...parentComposition,
          registry: savedRegistry,
        },
        version: nextVersion,
      });
      this.invalidatePolledHead(this.projectId, timelineId);
      this.activeRegistry = savedRegistry;
      this.unacknowledgedSaves.delete(timelineId);
      return { configVersion: nextVersion, head: this.timelineHead(timelineId, committedHead, savedPublicationId) };
    } catch (error) {
      if (isTimelineDiagnosticsEnabled()) {
        const diagnostic = error && typeof error === 'object'
          ? error as { name?: unknown; message?: unknown; code?: unknown; status?: unknown; details?: unknown }
          : {};
        console.error('[TimelineSave] runtime publish failed ' + JSON.stringify({
          projectId: this.projectId,
          timelineId,
          durationMs: Math.round(performance.now() - publishStartedAt),
          name: diagnostic.name,
          message: diagnostic.message,
          code: diagnostic.code,
          status: diagnostic.status,
          details: diagnostic.details,
        }));
      }
      if (error instanceof TimelineVersionConflictError
        || (error instanceof ApiError && error.status >= 400 && error.status < 500
          && error.status !== 408 && error.status !== 429)) {
        this.unacknowledgedSaves.delete(timelineId);
      }
      throw this.toProviderError(error, timelineId, expectedVersion);
    }
  }

  async resolveAssetUrl(file: string): Promise<string> {
    return this.resolveAssetUrlFromRegistry(file, this.activeRegistry);
  }

  /** Resolve a Runtime generation into the editor's existing lightbox row shape. */
  async loadGenerationForLightbox(generationId: string): Promise<GenerationRow | null> {
    try {
      const generation = await this.client.getGeneration(generationId);
      const variants = await listAllRuntimeVariants(this.client, generationId, 200);
      const primary = selectRuntimePrimaryVariant(variants);
      if (!primary?.object_id) return null;
      const mediaType = typeof primary.metadata.media_type === 'string'
        ? primary.metadata.media_type
        : (typeof primary.metadata.content_type === 'string' ? primary.metadata.content_type : 'image/png');
      const url = this.client.objectContentUrl(primary.object_id);
      const thumbnailObjectId = runtimeThumbnailObjectId(generation, primary.object_id);
      const thumbnailUrl = thumbnailObjectId
        ? this.client.objectContentUrl(thumbnailObjectId)
        : null;
      return {
        id: generation.generation_id,
        generation_id: generation.generation_id,
        location: url,
        imageUrl: url,
        ...(thumbnailUrl ? { thumbUrl: thumbnailUrl } : {}),
        type: mediaType,
        contentType: mediaType,
        createdAt: generation.created_at,
        metadata: generation.metadata,
        name: typeof generation.metadata.name === 'string' ? generation.metadata.name : null,
        primary_variant_id: primary.variant_id,
        source_task_id: generation.source_task_id ?? null,
        media_id: primary.object_id,
      };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** Read managed bytes through the generated Range/ETag Runtime contract. */
  async readAsset(file: string, byteRange?: [number, number?]): Promise<ByteResponse> {
    const asset = this.findManagedAsset(file, true);
    const response = await this.client.getObject(asset.objectId, byteRange);
    assertManagedObjectIdentity(asset.objectId, asset.expectedDigest, response.etag);
    return response;
  }

  /** Read managed media metadata through the generated Range/ETag contract. */
  async headAsset(file: string, byteRange?: [number, number?]): Promise<ByteResponse> {
    const asset = this.findManagedAsset(file, true);
    const response = await this.client.headObject(asset.objectId, byteRange);
    assertManagedObjectIdentity(asset.objectId, asset.expectedDigest, response.etag);
    return response;
  }

  async onResolve(request: AssetResolveRequest): Promise<string> {
    return this.resolveAssetUrl(request.assetId ?? request.file);
  }

  async registerAsset(timelineId: string, assetId: string, entry: AssetRegistryEntry): Promise<void> {
    return this.withTimelineOperation(timelineId, async () => {
      const record = await this.readTimelineInOrder(timelineId);
      const configRecord = asRecord(record.config);
      if (!configRecord) throw new TimelineSchemaIncompatibleError('Workspace Runtime timeline has no config object');
      await this.saveTimelineInOrder(
        timelineId,
        withDefaultTimelineOutput(configRecord as Partial<TimelineConfig>),
        this.timelineHead(timelineId, record.head_revision_id as string | null),
        {
          assets: { ...normalizeRegistry(record.registry, this.client).assets, [assetId]: entry },
        },
      );
    });
  }

  /**
   * Settle local image/video bytes in Runtime's host-owned catalog boundary.
   * The operation key is persisted before the request so a lost response can
   * be recovered with Runtime's operation lookup without re-importing bytes.
   */
  async prepareMediaImport(
    file: File,
    options: MediaImportOptions = {},
  ): Promise<PreparedMediaImport> {
    return this.prepareMediaImportAtBoundary(file, options, true);
  }

  private async prepareMediaImportAtBoundary(
    file: File,
    options: MediaImportOptions,
    captureNativeSelection: boolean,
  ): Promise<PreparedMediaImport> {
    assertRuntimeMediaImportSize(file);
    const importOperationId = generateUUID();
    const mediaType = options.mediaType ?? file.type;
    const filename = options.filename ?? file.name;
    persistMediaImportOperation(this.projectId, importOperationId, { filename, mediaType });

    const data = file;
    let imported: MediaImport;
    try {
      imported = await this.client.importProjectMedia(
        this.projectId,
        data,
        mediaType,
        importOperationId,
        filename,
        options.expectedDigest,
        options.width,
        options.height,
        options.durationSeconds,
      );
    } catch (firstError) {
      imported = await recoverMediaImportAfterLostAck(
        this.client,
        this.projectId,
        data,
        mediaType,
        filename,
        importOperationId,
        options,
        firstError,
      );
    }

    if (imported.project !== this.projectId) {
      throw new Error(
        `Workspace Runtime media import belongs to project ${imported.project}, not ${this.projectId}`,
      );
    }

    const prepared = await toPreparedMediaImport(
      this.client,
      imported,
      mediaType,
      filename,
      options.durationSeconds,
      captureNativeSelection && typeof this.client.getProjectMediaSelection === 'function',
    );
    persistMediaImportOperation(this.projectId, importOperationId, prepared);
    this.activeRegistry = {
      assets: {
        ...(this.activeRegistry?.assets ?? {}),
        [prepared.assetId]: prepared.entry,
      },
    };
    return prepared;
  }

  async prepareAsset(file: File, options: UploadAssetOptions): Promise<UploadedAssetResult> {
    // AssetPanel and external drops use this seam. User media must take the
    // same validated host import/catalog operation as gallery imports.
    const prepared = await this.prepareMediaImportAtBoundary(file, {
      filename: options.filename ?? file.name,
    }, false);
    const entry: AssetRegistryEntry = {
      ...prepared.entry,
      metadata: {
        ...prepared.entry.metadata,
        provenance: {
          ...prepared.entry.metadata?.provenance,
          sourceProvider: 'workspace-runtime',
          importedBy: options.userId,
          originalFilename: options.filename ?? file.name,
        },
      },
    };
    return { assetId: prepared.assetId, entry };
  }

  async uploadAsset(file: File, options: UploadAssetOptions): Promise<UploadedAssetResult> {
    const result = await this.prepareAsset(file, options);
    await this.registerAsset(options.timelineId, result.assetId, result.entry);
    return result;
  }

  async onUpload(request: AssetUploadRequest): Promise<UploadedAssetResult> {
    return this.uploadAsset(request.file, request.options);
  }

  private readTimeline(timelineId: string, poll = false): Promise<RuntimeRecord> {
    return this.withTimelineOperation(timelineId, () => this.readTimelineInOrder(timelineId, poll));
  }

  private async readTimelineInOrder(timelineId: string, poll = false): Promise<RuntimeRecord> {
    try {
      let inspection: TimelineInspectionResult | undefined;
      let headRevisionId: string | null = null;
      let headPublicationId: string | null = null;
      let mismatch: string | undefined;
      for (let attempt = 0; attempt < PUBLIC_HEAD_PAIR_ATTEMPTS; attempt += 1) {
        inspection = attempt === 0
          ? await (poll
            ? this.pollCanonicalTimelineHead(this.projectId, timelineId)
            : this.inspectCanonicalTimelineHead(this.projectId, timelineId))
          : await this.inspectCanonicalTimelineHead(this.projectId, timelineId);
        const inspectedRevisionId = nullableString(
          inspection.head_revision_id,
          'canonical timeline inspection.head_revision_id',
        );
        const publicHead = await this.client.getProjectTimeline(this.projectId, timelineId);
        assertRuntimeIdentity(publicHead, this.projectId, timelineId, 'timeline');
        const publicRevisionId = nullableString(publicHead.head_revision_id, 'timeline.head_revision_id');
        const publicPublicationId = nullableString(publicHead.head_publication_id, 'timeline.head_publication_id');
        if (publicRevisionId === inspectedRevisionId) {
          headRevisionId = inspectedRevisionId;
          headPublicationId = publicPublicationId;
          mismatch = undefined;
          break;
        }
        mismatch = `Workspace Runtime timeline head moved while pairing inspected revision ${inspectedRevisionId ?? 'null'} with public revision ${publicRevisionId ?? 'null'}`;
        this.invalidatePolledHead(this.projectId, timelineId);
      }
      if (mismatch) throw new TimelineVersionConflictError(mismatch);
      if (!inspection) throw new TimelineSaveError('Workspace Runtime timeline head pair is unavailable');
      this.rememberFreshHead(this.projectId, timelineId, inspection);
      const previous = this.canonicalTimelineState.get(timelineId);
      const sameVerifiedPublication = previous?.headPublicationId === null
        || previous?.headPublicationId === headPublicationId;
      const parentComposition = previous?.headRevisionId === headRevisionId
        && sameVerifiedPublication
        ? previous.parentComposition
        : headRevisionId === null
          ? { config: {}, registry: { assets: {} }, clips: [], occurrences: [] }
        : await this.readImmutableInFlight(
            JSON.stringify(['parent', this.projectId, timelineId, headRevisionId]),
            () => this.client.getProjectParentCompositionRevision(this.projectId, timelineId, headRevisionId),
          ).then((record) => {
            assertRuntimeIdentity(record, this.projectId, timelineId, 'parent composition revision');
            assertRevisionIdentity(record, headRevisionId, 'parent composition revision');
            return requiredRecord(record.payload, 'parent composition revision.payload');
          });
      const config = asRecord(parentComposition.config);
      if (!config) {
        throw new TimelineSchemaIncompatibleError('Workspace Runtime canonical timeline has no config object');
      }
      const clips = canonicalParentClips(parentComposition, config);
      const version = previous && previous.headRevisionId === headRevisionId
        && sameVerifiedPublication
        ? previous.version
        : (previous?.version ?? 0) + 1;
      this.canonicalTimelineState.set(timelineId, {
        headRevisionId,
        headPublicationId,
        parentComposition,
        version,
      });
      return {
        project_id: this.projectId,
        timeline_id: timelineId,
        version,
        head_revision_id: headRevisionId,
        head_publication_id: headPublicationId,
        config: { ...config, clips },
        registry: parentComposition.registry ?? { assets: {} },
      };
    } catch (error) {
      throw this.toProviderError(error, timelineId);
    }
  }

  private findManagedAsset(
    candidate: string,
    requireDigest = false,
    registry: AssetRegistry | null = this.activeRegistry,
  ): { objectId: string; expectedDigest: string } {
    const entry = Object.entries(registry?.assets ?? {}).find(([assetId, value]) => (
      assetId === candidate || value.file === candidate || value.media_id === candidate
    ))?.[1];
    const objectId = entry?.media_id;
    if (!objectId) {
      throw new Error(`Workspace Runtime has no managed object for asset ${candidate}`);
    }
    const expectedDigest = normalizeDigest(entry.content_sha256 ?? entry.etag);
    if (requireDigest && !expectedDigest) {
      throw new Error(`Workspace Runtime registry has no digest identity for managed object ${objectId}`);
    }
    return { objectId, expectedDigest };
  }

  private async resolveAssetUrlFromRegistry(
    file: string,
    registry: AssetRegistry | null,
  ): Promise<string> {
    const candidate = file.trim();
    if (!candidate) throw new Error('Cannot resolve a Runtime asset URL for an empty file path');
    if (/^https?:\/\//i.test(candidate)) return candidate;
    // A managed object route names its object itself: it resolves with no registry readback.
    const routed = managedObjectIdOf(candidate);
    if (routed !== null) return this.client.objectContentUrl(routed);
    return this.client.objectContentUrl(this.findManagedAsset(candidate, false, registry).objectId);
  }

  private toProviderError(error: unknown, timelineId: string, expectedVersion?: number): Error {
    let providerError: Error;
    if (error instanceof TimelineSaveError || error instanceof TimelineSchemaIncompatibleError || error instanceof TimelineVersionConflictError) {
      providerError = error;
    } else if (isRuntimeUnavailableFailure(error)) {
      providerError = error instanceof RuntimeUnavailableError
        ? error
        : new RuntimeUnavailableError(error, this.apiBaseUrl);
    } else if (isRuntimeCanonicalPayloadConflict(error)) {
      providerError = new TimelineSchemaIncompatibleError(
        `Workspace Runtime rejected a non-canonical parent payload: ${error.message}`,
        [{ pointer: '/clips', code: 'canonical_duplicate_mismatch', message: error.message }],
      );
    } else if (error instanceof ApiError && (classifyRuntimeCommitFailure(error) === 'conflict' || isRuntimeConflict(error))) {
      const actual = asRecord(error.details)?.actual;
      providerError = new TimelineVersionConflictError(
        'Workspace Runtime rejected a stale timeline version; reload to review the canonical head.',
        expectedVersion,
        typeof actual === 'number' ? actual : undefined,
      );
    } else if (error instanceof ApiError && classifyRuntimeCommitFailure(error) === 'refused') {
      const reason = asRecord(error.details)?.reason;
      providerError = new TimelineSchemaIncompatibleError(
        `Workspace Runtime refused the timeline commit${typeof reason === 'string' ? ` (${reason})` : ''}: ${error.message}`,
      );
    } else if (error instanceof ApiError && error.status === 404) {
      providerError = new TimelineNotFoundError(timelineId);
    } else if (error instanceof ApiError && error.status >= 400 && error.status < 500
      && error.status !== 408 && error.status !== 429) {
      // Deterministic client rejections are terminal for this payload. They
      // are not transport failures and must not enter the generic retry loop.
      const details = asRecord(error.details);
      providerError = new TimelineSchemaIncompatibleError(
        `Workspace Runtime rejected the timeline save: ${error.message}`,
        [{
          code: typeof details?.code === 'string' ? details.code : error.code,
          message: error.message,
        }],
      );
    } else {
      providerError = error instanceof Error ? error : new Error(String(error));
    }
    this.reportRuntimeError(providerError);
    return providerError;
  }

  private reportRuntimeError(error: unknown): void {
    if (error instanceof RuntimeAuthenticationError || error instanceof RuntimeUnavailableError) {
      this.onRuntimeError?.(error);
    }
  }
}

function asRecord(value: unknown): RuntimeRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RuntimeRecord
    : null;
}

/**
 * The Runtime's route to a managed object, with no origin: a relative locator, optionally under the door prefix. A registry
 * entry may carry one as its `file`: it names the entry's own media, and it is the only locator the Runtime accepts there when
 * it freezes a render. An absolute URL is never a route, whatever its path: the Runtime refuses a foreign origin's
 * `/v1/objects/<id>` as an unmanaged locator, and so must nothing here make it look managed.
 */
const MANAGED_OBJECT_ROUTE = /^\/(?:api\/(?:runtime|astrid)\/)?v1\/objects\/([^/?#]+)$/;

function managedObjectRoute(objectId: string): string {
  return `/v1/objects/${encodeURIComponent(objectId)}`;
}

/** The object id a relative route names, or null when `locator` is not a managed object route. */
function managedObjectIdOf(locator: string): string | null {
  const match = MANAGED_OBJECT_ROUTE.exec(locator.trim());
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

/**
 * An entry whose `file` is this Runtime's own URL for its own object keeps the route instead. Any other `file` is left as it is,
 * for the Runtime to accept or refuse: a URL of another origin is never rewritten, even when its path has the route's shape.
 */
function withManagedFileRoute(entry: AssetRegistryEntry, client: Pick<AstridRuntimeClient, 'objectContentUrl'>): AssetRegistryEntry {
  if (typeof entry.file !== 'string' || typeof entry.media_id !== 'string') return entry;
  return entry.file === client.objectContentUrl(entry.media_id) ? { ...entry, file: managedObjectRoute(entry.media_id) } : entry;
}

function normalizeRegistry(value: unknown, client: Pick<AstridRuntimeClient, 'objectContentUrl'>): AssetRegistry {
  const record = asRecord(value);
  const assets = asRecord(record?.assets);
  if (!assets) return { assets: {} };
  return {
    ...record,
    assets: Object.fromEntries(Object.entries(assets).map(([assetKey, rawEntry]) => {
      const entry = asRecord(rawEntry) as AssetRegistryEntry | null;
      if (!entry) return [assetKey, rawEntry];
      if (entry.media_id || typeof entry.content_sha256 !== 'string') return [assetKey, withManagedFileRoute(entry, client)];
      const digest = entry.content_sha256.replace(/^sha256:/, '').trim();
      return /^[0-9a-f]{64}$/.test(digest)
        ? [assetKey, withManagedFileRoute({ ...entry, media_id: `sha256:${digest}` }, client)]
        : [assetKey, rawEntry];
    })) as Record<string, AssetRegistryEntry>,
  };
}

function runtimeVersion(record: RuntimeRecord): number {
  const value = record.config_version ?? record.version;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TimelineSchemaIncompatibleError('Workspace Runtime timeline has no positive version');
  }
  return value;
}

function normalizeDigest(value: string | undefined): string {
  return value?.trim().replace(/^W\//, '').replace(/^"|"$/g, '') ?? '';
}

function assertManagedObjectIdentity(
  objectId: string,
  expectedDigest: string,
  etag: string | undefined,
): void {
  const actualDigest = normalizeDigest(etag);
  if (!actualDigest) {
    throw new Error(`Workspace Runtime object ${objectId} response omitted its strong ETag identity`);
  }
  if (actualDigest !== expectedDigest) {
    throw new Error(
      `Workspace Runtime object identity mismatch for ${objectId}: expected ${expectedDigest}, got ${actualDigest}`,
    );
  }
}

const MEDIA_IMPORT_STORAGE_PREFIX = 'astrid.runtime.media-import.v1:';

function persistMediaImportOperation(
  projectId: string,
  importOperationId: string,
  value: object,
): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        `${MEDIA_IMPORT_STORAGE_PREFIX}${projectId}:${importOperationId}`,
        JSON.stringify({ projectId, importOperationId, ...value }),
      );
    }
  } catch {
    // Runtime remains the durable authority when browser storage is unavailable.
  }
}

async function recoverMediaImportAfterLostAck(
  client: AstridRuntimeClient,
  projectId: string,
  data: RequestBody,
  mediaType: string,
  filename: string,
  importOperationId: string,
  options: MediaImportOptions,
  firstError: unknown,
): Promise<MediaImport> {
  try {
    const recovered = await client.getProjectMediaImport(projectId, importOperationId);
    if (recovered.status === 'completed') return recovered;

    // A durable pending object means ingestion succeeded but the ACK was lost
    // before catalog settlement. Replaying the same caller key asks Runtime to
    // finish that exact operation; it cannot create a second object or pair.
    return await client.importProjectMedia(
      projectId,
      data,
      mediaType,
      importOperationId,
      filename,
      options.expectedDigest,
      options.width,
      options.height,
      options.durationSeconds,
    );
  } catch (recoveryError) {
    throw firstError instanceof Error ? firstError : recoveryError;
  }
}

async function toPreparedMediaImport(
  client: AstridRuntimeClient,
  imported: MediaImport,
  fallbackMediaType: string,
  fallbackFilename: string,
  fallbackDuration?: number,
  captureNativeSelection = false,
): Promise<PreparedMediaImport> {
  if (
    imported.provider !== 'runtime'
    || imported.status !== 'completed'
    || typeof imported.project !== 'string'
    || typeof imported.import_operation_id !== 'string'
    || typeof imported.generation_id !== 'string'
    || typeof imported.variant_id !== 'string'
    || typeof imported.asset_id !== 'string'
  ) {
    throw new Error('Workspace Runtime returned an incomplete media import descriptor');
  }

  let mediaSelection: PreparedMediaImport['mediaSelection'];
  if (captureNativeSelection) {
    const selected = await client.getProjectMediaSelection(imported.project, {
      asset: imported.asset_id,
      generation_id: imported.generation_id,
      variant_id: imported.variant_id,
    });
    if (
      selected.asset !== imported.asset_id
      || selected.generation_id !== imported.generation_id
      || selected.variant_id !== imported.variant_id
      || selected.object_id !== imported.entry.object_id
    ) {
      throw new Error('Workspace Runtime media selection does not match the prepared import');
    }
    Object.freeze(selected);
    mediaSelection = selected;
  }

  const mediaType = imported.entry.media_type || fallbackMediaType;
  const filename = imported.entry.filename || fallbackFilename;
  const duration = imported.duration_seconds ?? fallbackDuration;
  const entry: AssetRegistryEntry = {
    file: client.objectContentUrl(imported.asset_id),
    media_id: imported.asset_id,
    content_sha256: imported.asset_id,
    type: mediaType,
    ...(typeof duration === 'number' && duration > 0 ? { duration } : {}),
    generationId: imported.generation_id,
    variantId: imported.variant_id,
    metadata: {
      provenance: {
        sourceProvider: 'workspace-runtime',
        importOperationId: imported.import_operation_id,
        ...(imported.provenance ?? {}),
      },
      extensions: {
        originalFilename: filename,
        ...(typeof imported.entry.size === 'number' ? { byteSize: imported.entry.size } : {}),
      },
    },
  };

  return {
    provider: imported.provider,
    project: imported.project,
    importOperationId: imported.import_operation_id,
    generationId: imported.generation_id,
    variantId: imported.variant_id,
    assetId: imported.asset_id,
    entry,
    ...(mediaSelection ? { mediaSelection } : {}),
  };
}

export type { RuntimeUnavailableError };

/** Shared acceptance decoder; it neither constructs a client nor updates provider state. */
export function decodeAcceptedTimelineCommit(
  response: CommitAcceptedMutation,
  projectId: string,
  timelineId: string,
): TimelineCommitResult {
  const data = response.data;
  const receipt = response.receipt;
  if ((data.status !== 'accepted' && data.status !== 'rebased' && data.status !== 'merged')
    || receipt.project_id !== projectId || receipt.command_kind !== 'timeline.commit') {
    throw new TimelineSchemaIncompatibleError('Workspace Runtime returned an invalid timeline acceptance envelope');
  }
  acceptedDigest(data.document_digest, 'document_digest');
  const publicationId = requiredString(receipt.receipt_id, 'timeline commit receipt.receipt_id');
  const canonicalDocument = validateAcceptedCanonicalDocument(data.canonical_document, projectId, timelineId, data.accepted_revision_id);
  assertIdentityMap(data.id_map);
  const graph = runtimeGraphToContractFromCanonicalDocument(projectId, timelineId, canonicalDocument, publicationId);
  const accepted: TimelineAcceptedIdentity = {
    revisionId: data.accepted_revision_id,
    publicationId,
  };
  return { response, accepted, canonicalDocument, graph, receipt };
}

function requiredRecord(value: unknown, label: string): RuntimeRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Workspace Runtime ${label} must be an object`);
  }
  return value as RuntimeRecord;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Workspace Runtime ${label} is missing`);
  }
  return value;
}

function sameMediaSelection(value: unknown, right: MediaSelection): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const left = value as Record<string, unknown>;
  const keys = ['asset', 'generation_id', 'variant_id', 'object_id', 'catalog_digest'] as const;
  return Object.keys(left).length === keys.length
    && keys.every((key) => left[key] === right[key]);
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function optionalNullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, label);
}

function assertIdentityMap(idMap: Record<string, string>): void {
  for (const [source, target] of Object.entries(idMap)) {
    if (source !== target) {
      throw new TimelineSchemaIncompatibleError(
        `Workspace Runtime accepted a non-identity id_map entry for ${source}`,
      );
    }
  }
}

function acceptedDigest(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new TimelineSchemaIncompatibleError(`Workspace Runtime returned an invalid accepted ${label}`);
  }
}

function acceptedManifest(entries: RuntimeRecord[], keyFor: (entry: RuntimeRecord) => string): Map<string, RuntimeRecord> {
  const result = new Map<string, RuntimeRecord>();
  for (const entry of entries) {
    const key = keyFor(entry);
    if (result.has(key)) throw new TimelineSchemaIncompatibleError(`Workspace Runtime returned duplicate manifest entry ${key}`);
    result.set(key, entry);
  }
  return result;
}

export function validateAcceptedCanonicalDocument(
  value: CanonicalDocument,
  projectId: string,
  timelineId: string,
  acceptedRevisionId: string,
): CanonicalDocument {
  const document = requiredRecord(value, 'accepted canonical document') as unknown as CanonicalDocument;
  if (document.schema_version !== 1 || document.project_id !== projectId || document.timeline_id !== timelineId) {
    throw new TimelineSchemaIncompatibleError('Workspace Runtime returned an accepted closure outside the requested project/timeline');
  }
  const parent = requiredRecord(document.parent_revision, 'accepted canonical document.parent_revision');
  if (requiredString(parent.revision_id, 'accepted canonical document.parent_revision.revision_id') !== acceptedRevisionId) {
    throw new TimelineSchemaIncompatibleError('Workspace Runtime accepted revision does not match its canonical closure');
  }
  acceptedDigest(parent.content_digest, 'parent content_digest');
  const parentPayload = requiredRecord(parent.payload, 'accepted canonical document.parent_revision.payload');
  const manifest = requiredRecord(document.dependency_manifest, 'accepted canonical document.dependency_manifest');
  const shots = array(document.shot_revisions, 'accepted canonical document.shot_revisions');
  const internals = array(document.internal_timeline_revisions, 'accepted canonical document.internal_timeline_revisions');
  const shotManifest = acceptedManifest(array(manifest.shots, 'accepted canonical document.dependency_manifest.shots'), (entry) =>
    `${requiredString(entry.shot_id, 'accepted shot manifest.shot_id')}\u0000${requiredString(entry.revision_id, 'accepted shot manifest.revision_id')}`
  );
  const internalManifest = acceptedManifest(array(manifest.internal_timelines, 'accepted canonical document.dependency_manifest.internal_timelines'), (entry) =>
    `${requiredString(entry.timeline_id, 'accepted internal manifest.timeline_id')}\u0000${requiredString(entry.revision_id, 'accepted internal manifest.revision_id')}`
  );
  const seenShots = new Set<string>();
  for (const shot of shots) {
    const shotId = requiredString(shot.shot_id, 'accepted shot image.shot_id');
    const revisionId = requiredString(shot.revision_id, 'accepted shot image.revision_id');
    acceptedDigest(shot.content_digest, 'shot content_digest');
    const payload = requiredRecord(shot.payload, 'accepted shot image.payload');
    const internalRevision = requiredString(shot.internal_timeline_revision_id, 'accepted shot image.internal_timeline_revision_id');
    if (payload.internal_timeline_revision_id !== internalRevision) {
      throw new TimelineSchemaIncompatibleError('Workspace Runtime shot payload disagrees with its internal revision pin');
    }
    const key = `${shotId}\u0000${revisionId}`;
    if (seenShots.has(key)) throw new TimelineSchemaIncompatibleError(`Workspace Runtime returned duplicate shot closure ${shotId}/${revisionId}`);
    seenShots.add(key);
    const manifestEntry = shotManifest.get(key);
    if (!manifestEntry || manifestEntry.content_digest !== shot.content_digest
      || manifestEntry.internal_timeline_revision_id !== shot.internal_timeline_revision_id) {
      throw new TimelineSchemaIncompatibleError(`Workspace Runtime shot closure/manifest mismatch for ${shotId}/${revisionId}`);
    }
  }
  for (const key of shotManifest.keys()) {
    if (!seenShots.has(key)) throw new TimelineSchemaIncompatibleError(`Workspace Runtime manifest has no shot image for ${key.replace('\u0000', '/')}`);
  }
  const seenInternals = new Set<string>();
  for (const internal of internals) {
    const timeline = requiredString(internal.timeline_id, 'accepted internal image.timeline_id');
    const revision = requiredString(internal.revision_id, 'accepted internal image.revision_id');
    acceptedDigest(internal.content_digest, 'internal content_digest');
    requiredRecord(internal.payload, 'accepted internal image.payload');
    const key = `${timeline}\u0000${revision}`;
    if (seenInternals.has(key)) throw new TimelineSchemaIncompatibleError(`Workspace Runtime returned duplicate internal closure ${timeline}/${revision}`);
    seenInternals.add(key);
    const manifestEntry = internalManifest.get(key);
    if (!manifestEntry || manifestEntry.content_digest !== internal.content_digest) {
      throw new TimelineSchemaIncompatibleError(`Workspace Runtime internal closure/manifest mismatch for ${timeline}/${revision}`);
    }
  }
  for (const key of internalManifest.keys()) {
    if (!seenInternals.has(key)) throw new TimelineSchemaIncompatibleError(`Workspace Runtime manifest has no internal image for ${key.replace('\u0000', '/')}`);
  }
  const occurrences = array(parentPayload.occurrences, 'accepted parent occurrences');
  const seenOccurrences = new Set<string>();
  for (const occurrence of occurrences) {
    const id = requiredString(occurrence.occurrence_id, 'accepted occurrence.occurrence_id');
    if (seenOccurrences.has(id)) throw new TimelineSchemaIncompatibleError(`Workspace Runtime returned duplicate occurrence ${id}`);
    seenOccurrences.add(id);
    const shotId = requiredString(occurrence.shot_id, 'accepted occurrence.shot_id');
    const revisionId = requiredString(occurrence.shot_revision_id, 'accepted occurrence.shot_revision_id');
    if (!seenShots.has(`${shotId}\u0000${revisionId}`)) {
      throw new TimelineSchemaIncompatibleError(`Workspace Runtime occurrence references an unresolved shot revision ${shotId}/${revisionId}`);
    }
  }
  acceptedManifest(array(manifest.media, 'accepted canonical document.dependency_manifest.media'), (entry) => {
    acceptedDigest(entry.media_id, 'media media_id');
    acceptedDigest(entry.content_digest, 'media content_digest');
    return String(entry.media_id);
  });
  acceptedManifest(array(manifest.documents, 'accepted canonical document.dependency_manifest.documents'), (entry) => {
    const id = requiredString(entry.document_id, 'accepted document pin.document_id');
    acceptedDigest(entry.content_digest, 'document content_digest');
    if (!Number.isInteger(entry.version) || Number(entry.version) < 1) {
      throw new TimelineSchemaIncompatibleError('Workspace Runtime returned an invalid document pin version');
    }
    return `${id}\u0000${entry.version}\u0000${entry.content_digest}`;
  });
  return value;
}

function array(value: unknown, label: string): RuntimeRecord[] {
  if (!Array.isArray(value)) throw new Error(`Workspace Runtime ${label} must be an array`);
  return value.map((item, index) => requiredRecord(item, `${label}[${index}]`));
}

function assertRuntimeIdentity(value: RuntimeRecord, projectId: string, identity: string, label: string): void {
  if (value.project_id !== projectId) {
    throw new Error(`Workspace Runtime ${label} belongs to project ${String(value.project_id)}, not ${projectId}`);
  }
  const key = label.includes('shot') ? 'shot_id' : 'timeline_id';
  if (value[key] !== identity) {
    throw new Error(`Workspace Runtime ${label} belongs to ${key === 'shot_id' ? 'shot' : 'timeline'} ${String(value[key])}, not ${identity}`);
  }
}

function assertRevisionIdentity(value: RuntimeRecord, revisionId: string, label: string): void {
  if (value.revision_id !== revisionId) {
    throw new Error(`Workspace Runtime ${label} identity mismatch: requested ${revisionId}, got ${String(value.revision_id)}`);
  }
}

function assertGraphRequestIdentity(graph: unknown, projectId: string, timelineId: string): void {
  const graphRecord = requiredRecord(graph, 'publication graph');
  const project = requiredRecord(graphRecord.project, 'publication graph.project');
  const primary = requiredRecord(graphRecord.primary_timeline, 'publication graph.primary_timeline');
  const graphProjectId = requiredString(project.project_id, 'publication graph.project.project_id');
  const projectDocumentId = requiredString(project.document_id, 'publication graph.project.document_id');
  const primaryDocumentId = requiredString(primary.document_id, 'publication graph.primary_timeline.document_id');
  if (graphProjectId !== projectId) {
    throw new Error(`Workspace Runtime publication graph belongs to project ${graphProjectId}, not ${projectId}`);
  }
  if (projectDocumentId !== timelineId) {
    throw new Error(`Workspace Runtime publication graph project document is ${projectDocumentId}, not ${timelineId}`);
  }
  if (primaryDocumentId !== timelineId) {
    throw new Error(`Workspace Runtime publication graph primary timeline is ${primaryDocumentId}, not ${timelineId}`);
  }
}

function uniqueOccurrences(occurrences: RuntimeRecord[]): RuntimeRecord[] {
  const seen = new Set<string>();
  return occurrences.filter((occurrence) => {
    const key = `${String(occurrence.shot_id)}\u0000${String(occurrence.shot_revision_id ?? occurrence.revision_id)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parentShotPlacements(parentPayload: RuntimeRecord): ShotPlacement[] {
  return array(parentPayload.occurrences, 'parent composition.occurrences').map((occurrence, ordinal) => {
    const placement = asRecord(occurrence.placement) ?? {};
    const atMs = Number(placement.start_ms ?? occurrence.at_ms ?? 0);
    const durationMs = Number(occurrence.duration_ms ?? occurrence.duration ?? 0);
    if (!Number.isFinite(atMs) || atMs < 0 || !Number.isFinite(durationMs) || durationMs < 0) {
      throw new ShotCompositionUnavailableError(`Workspace Runtime parent composition occurrence[${ordinal}] has invalid timing`);
    }
    return {
      occurrenceId: requiredString(occurrence.occurrence_id, `parent composition occurrence[${ordinal}].occurrence_id`),
      shotId: requiredString(occurrence.shot_id, `parent composition occurrence[${ordinal}].shot_id`),
      ordinal,
      atMs,
      durationMs,
      trackId: String(occurrence.track ?? placement.track ?? 'video'),
    };
  });
}

function canonicalArray(value: unknown, fallback: unknown[] = []): unknown[] {
  return Array.isArray(value) ? value : fallback;
}

function canonicalParentClips(parent: RuntimeRecord, config: RuntimeRecord): unknown[] {
  // Match Runtime's _canonical_parent_clips: absent lists are empty, malformed
  // lists fail closed, and only two non-empty authorities can conflict.
  const parentClips = parent.clips === undefined ? [] : parent.clips;
  const configClips = config.clips === undefined ? [] : config.clips;
  if (!Array.isArray(parentClips) || !Array.isArray(configClips)) {
    throw new TimelineSchemaIncompatibleError('Workspace Runtime canonical parent composition clips are invalid');
  }
  if (parentClips.length && configClips.length && stableJson(parentClips) !== stableJson(configClips)) {
    throw new TimelineSchemaIncompatibleError('Workspace Runtime canonical parent clips and config.clips disagree');
  }
  return parentClips.length ? parentClips : configClips;
}


function reconcileParentClips(
  baseComposition: RuntimeRecord,
  authoredClips: unknown,
): RuntimeRecord[] {
  const baseConfig = asRecord(baseComposition.config);
  canonicalParentClips(baseComposition, baseConfig ?? {});
  const topLevelClips = asRuntimeRecordArray(baseComposition.clips, 'canonical parent clips');
  const configClips = asRuntimeRecordArray(baseConfig?.clips, 'canonical config.clips');

  // Runtime's compatibility rule permits one side to be absent/empty, but
  // two populated canonical lists must already agree. Do not silently choose
  // one half of a corrupt base revision.
  if (topLevelClips.length > 0 && configClips.length > 0
    && stableJson(topLevelClips) !== stableJson(configClips)) {
    throw new TimelineSchemaIncompatibleError(
      'Workspace Runtime canonical parent clips and config.clips disagree',
      [{ pointer: '/clips', code: 'canonical_duplicate_mismatch', message: 'Canonical parent clips and config.clips disagree.' }],
    );
  }

  const canonicalClips = topLevelClips.length > 0 ? topLevelClips : configClips;
  if (!Array.isArray(authoredClips)) {
    throw new TimelineSchemaIncompatibleError(
      'Workspace Runtime editor config.clips must be an array',
      [{ pointer: '/config/clips', code: 'invalid_type', message: 'Expected an array of authored clips.' }],
    );
  }

  const canonicalById = new Map(
    canonicalClips
      .map((clip) => [typeof clip.id === 'string' ? clip.id : null, clip] as const)
      .filter((entry): entry is readonly [string, RuntimeRecord] => entry[0] !== null),
  );
  return authoredClips.map((rawClip, index) => {
    const clip = asRecord(rawClip);
    if (!clip) {
      throw new TimelineSchemaIncompatibleError(
        `Workspace Runtime editor config.clips[${index}] must be an object`,
        [{ pointer: `/config/clips/${index}`, code: 'invalid_type', message: 'Expected a clip object.' }],
      );
    }
    const id = typeof clip.id === 'string' ? clip.id : null;
    const canonical = id ? canonicalById.get(id) : undefined;
    // The editor may submit a partial authored clip while preserving the
    // stable identity. Merge it over the canonical object so unknown fields
    // (effects, live-scene metadata, provenance) survive untouched.
    const reconciled = canonical ? { ...canonical, ...clip } : { ...clip };
    if (Object.prototype.hasOwnProperty.call(clip, 'transition') && clip.transition === undefined) {
      delete reconciled.transition;
    }
    return reconciled;
  });
}

function asRuntimeRecordArray(value: unknown, label: string): RuntimeRecord[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new TimelineSchemaIncompatibleError(
      `Workspace Runtime ${label} must be an array`,
      [{ pointer: label === 'canonical parent clips' ? '/clips' : '/config/clips', code: 'invalid_type', message: 'Expected an array of clips.' }],
    );
  }
  return value.map((item, index) => {
    const record = asRecord(item);
    if (!record) {
      throw new TimelineSchemaIncompatibleError(
        `Workspace Runtime ${label}[${index}] must be an object`,
        [{ pointer: label === 'canonical parent clips' ? `/clips/${index}` : `/config/clips/${index}`, code: 'invalid_type', message: 'Expected a clip object.' }],
      );
    }
    return record;
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as RuntimeRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deterministic create key per document id (retry-safe). Ids may contain ':' or be long,
 * which Runtime's key grammar (^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$) rejects, so hash them.
 */
export async function documentCreateKey(documentId: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(documentId));
  return `astrid.document-create.${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function stablePublicationKey(
  projectId: string,
  timelineId: string,
  expectedHead: string | null,
  graph: unknown,
): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson({ projectId, timelineId, expectedHead, graph }));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  // Runtime's idempotency-key grammar accepts dots/dashes but not colons.
  return `astrid.shot-composition.${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function stableTimelinePublicationKey(
  projectId: string,
  timelineId: string,
  expectedHead: string | null,
  parentComposition: RuntimeRecord,
): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson({
    projectId,
    timelineId,
    expectedHead,
    parentComposition,
  }));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `astrid.editor.timeline.${hex}`;
}

function publicationChangedIdentities(result: RuntimeRecord | null, parentRevisionId: string): string[] {
  const identities = new Set<string>([parentRevisionId]);
  const manifest = asRecord(result?.dependency_manifest);
  for (const section of ['shots', 'internal_timelines', 'timelines', 'media']) {
    const values = manifest && Array.isArray(manifest[section]) ? manifest[section] : [];
    for (const raw of values) {
      const item = asRecord(raw);
      if (!item) continue;
      for (const field of ['shot_id', 'timeline_id', 'revision_id', 'internal_timeline_revision_id', 'content_digest']) {
        if (typeof item[field] === 'string' && item[field].length > 0) identities.add(item[field] as string);
      }
    }
  }
  const contentDigests = asRecord(result?.content_digests);
  if (contentDigests) Object.keys(contentDigests).forEach((identity) => identities.add(identity));
  return [...identities];
}

function canonicalAudio(payload: RuntimeRecord): RuntimeRecord | undefined {
  if (payload.audio === undefined) return undefined;
  const audio = asRecord(payload.audio);
  if (!audio) {
    throw new Error('Workspace Runtime shot revision has an invalid legacy audio descriptor');
  }
  // This is a read-only compatibility field. Child timeline clips and
  // bindings remain playback authority; never synthesize or collapse them
  // into one aggregate descriptor.
  return audio;
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/i;

function canonicalAssetDigest(rawAsset: RuntimeRecord, objectId: string, label: string): string {
  const candidate = [rawAsset.digest, rawAsset.content_sha256, rawAsset.sha256, objectId]
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  if (!candidate) {
    throw new Error(`Workspace Runtime ${label} has no immutable asset digest`);
  }
  if (SHA256_DIGEST.test(candidate)) return candidate.toLowerCase();
  if (/^[0-9a-f]{64}$/i.test(candidate)) return `sha256:${candidate.toLowerCase()}`;
  throw new Error(`Workspace Runtime ${label} has an invalid immutable asset digest`);
}

function canonicalAssetRole(rawAsset: RuntimeRecord, fallback?: string): string {
  const source = asRecord(rawAsset.source);
  const role = [rawAsset.role, rawAsset.media_type, rawAsset.type, source?.media_type, source?.type]
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  return role ?? fallback ?? 'source';
}

/**
 * Normalize all media declarations for one pinned shot revision at the
 * Runtime boundary. A child timeline can carry an immutable registry even when
 * the older shot manifest omitted the same declaration; after this boundary
 * the canonical contract has one revision-scoped asset list and projection
 * does not need to understand transport-specific fallbacks.
 */
function normalizeShotRevisionAssets(
  projectId: string,
  shotId: string,
  revisionId: string,
  shotPayload: RuntimeRecord,
  timelinePayload: RuntimeRecord,
): RuntimeRecord[] {
  const assets = new Map<string, RuntimeRecord>();
  const selectedAssetIds = new Set(
    [...canonicalArray(timelinePayload.clips), ...canonicalArray(shotPayload.audio_bindings)]
      .flatMap((value) => {
        const selection = asRecord(value);
        return [selection?.asset_id, selection?.asset]
          .filter((assetId): assetId is string => typeof assetId === 'string' && assetId.length > 0);
      }),
  );
  const add = (assetId: string, rawAsset: RuntimeRecord, sourceLabel: string): void => {
    const objectId = typeof rawAsset.object_id === 'string' && rawAsset.object_id.length > 0
      ? rawAsset.object_id
      : typeof rawAsset.media_id === 'string' && rawAsset.media_id.length > 0
        ? rawAsset.media_id
        : undefined;
    if (!objectId) return;
    const label = `${sourceLabel} ${shotId}/${revisionId} asset ${assetId}`;
    const normalized: RuntimeRecord = {
      ...rawAsset,
      asset_id: assetId,
      object_id: objectId,
      digest: canonicalAssetDigest(rawAsset, objectId, label),
      role: canonicalAssetRole(rawAsset, typeof assets.get(assetId)?.role === 'string' ? String(assets.get(assetId)?.role) : undefined),
      scope: { ...(asRecord(rawAsset.scope) ?? {}), project_id: projectId },
    };
    const existing = assets.get(assetId);
    if (existing && existing.object_id !== objectId) {
      // Older children inherited the whole project registry, including unused
      // alternatives whose later copies can differ from the shot manifest.
      // Only selected media participates in this shot's playback closure.
      if (sourceLabel === 'internal timeline' && !selectedAssetIds.has(assetId)) return;
      throw new Error(
        `Workspace Runtime ${label} conflicts with object ${String(existing.object_id)}`,
      );
    }
    assets.set(assetId, { ...existing, ...normalized });
  };

  for (const rawAsset of canonicalArray(shotPayload.assets)) {
    const asset = asRecord(rawAsset);
    const assetId = typeof asset?.asset_id === 'string' && asset.asset_id.length > 0 ? asset.asset_id : undefined;
    if (asset && assetId) add(assetId, asset, 'shot revision');
  }

  // The registry is the authored selector authority. The older top-level
  // assets map is only a fallback and can retain pre-edit alternatives.
  const childAssets = {
    ...asRecord(timelinePayload.assets),
    ...asRecord(asRecord(timelinePayload.registry)?.assets),
  };
  for (const [assetId, rawAsset] of Object.entries(childAssets)) {
    const asset = asRecord(rawAsset);
    if (asset) add(assetId, asset, 'internal timeline');
  }

  return [...assets.values()];
}

function runtimeGraphToContract(
  projectId: string,
  timelineId: string,
  timeline: RuntimeRecord,
  parent: RuntimeRecord,
  resolved: Array<{ shot: RuntimeRecord; internal: RuntimeRecord }>,
): RuntimeRecord {
  const parentPayload = requiredRecord(parent.payload, 'parent composition revision.payload');
  const parentOccurrences = array(parentPayload.occurrences, 'parent composition.occurrences');
  const resolvedByKey = new Map(resolved.map(({ shot, internal }) => [
    `${String(shot.shot_id)}\u0000${String(shot.revision_id)}`,
    { shot, internal },
  ]));
  const durationByKey = new Map(parentOccurrences.map((occurrence) => [
    `${String(occurrence.shot_id)}\u0000${String(occurrence.shot_revision_id ?? occurrence.revision_id)}`,
    Number(occurrence.duration_ms ?? occurrence.duration ?? 0),
  ]));
  const shotRevisions = resolved.map(({ shot, internal }) => {
    const shotPayload = requiredRecord(shot.payload, `shot revision ${String(shot.revision_id)}.payload`);
    const internalPayload = requiredRecord(internal.payload, `internal timeline revision ${String(internal.revision_id)}.payload`);
    const timelinePayload = requiredRecord(internalPayload.timeline ?? internalPayload, `internal timeline revision ${String(internal.revision_id)}.timeline`);
    const timing = shotPayload.timing && typeof shotPayload.timing === 'object' && !Array.isArray(shotPayload.timing)
      ? shotPayload.timing as RuntimeRecord
      : { duration_ms: durationByKey.get(`${String(shot.shot_id)}\u0000${String(shot.revision_id)}`) ?? 0 };
    const provenance = shotPayload.provenance && typeof shotPayload.provenance === 'object' && !Array.isArray(shotPayload.provenance)
      ? shotPayload.provenance as RuntimeRecord
      : {};
    const assets = normalizeShotRevisionAssets(projectId, String(shot.shot_id), String(shot.revision_id), shotPayload, timelinePayload);
    const audio = canonicalAudio(shotPayload);
    return {
      ...shotPayload,
      // Display normalization must not become authored successor payload data.
      rawJson: shotPayload,
      shot_id: requiredString(shot.shot_id, 'shot revision.shot_id'),
      revision_id: requiredString(shot.revision_id, 'shot revision.revision_id'),
      document_role: 'shot_revision',
      content_digest: requiredString(shot.content_digest, 'shot revision.content_digest'),
      internal_timeline_revision: {
        timeline_id: typeof internal.timeline_id === 'string' && internal.timeline_id.length > 0
          ? internal.timeline_id
          : timelineId,
        revision_id: requiredString(internal.revision_id, 'internal timeline revision.revision_id'),
        content_digest: requiredString(internal.content_digest, 'internal timeline revision.content_digest'),
        timeline: timelinePayload,
      },
      dependencies: canonicalArray(shotPayload.dependencies),
      assets,
      generation_inputs: canonicalArray(shotPayload.generation_inputs),
      timing,
      ...(audio ? { audio } : {}),
      provenance,
    };
  });
  const graphOccurrences = parentOccurrences.map((occurrence, ordinal) => {
    const shotId = requiredString(occurrence.shot_id, `parent composition occurrence[${ordinal}].shot_id`);
    const revisionId = requiredString(occurrence.shot_revision_id ?? occurrence.revision_id, `parent composition occurrence[${ordinal}].shot_revision_id`);
    const placement = occurrence.placement && typeof occurrence.placement === 'object' && !Array.isArray(occurrence.placement)
      ? occurrence.placement as RuntimeRecord
      : {};
    const atMs = Number(placement.start_ms ?? occurrence.at_ms ?? 0);
    const durationMs = Number(occurrence.duration_ms ?? occurrence.duration ?? 0);
    const occurrenceId = requiredString(occurrence.occurrence_id, `parent composition occurrence[${ordinal}].occurrence_id`);
    return {
      ...occurrence,
      occurrence_id: occurrenceId,
      parent_document_id: timelineId,
      shot_id: shotId,
      revision_id: revisionId,
      ordinal,
      at_ms: atMs,
      duration_ms: durationMs,
      stable_deep_link: stableOccurrenceDeepLink(projectId, timelineId, shotId, revisionId, occurrenceId),
      output_identity: stableOutputIdentity(projectId, timelineId, occurrenceId),
      placement,
      source_offset: occurrence.source_offset ?? 0,
      speed: occurrence.speed ?? 1,
      track: occurrence.track ?? placement.track ?? 'video',
      transform: occurrence.transform ?? {},
      gain: occurrence.gain ?? 1,
      muted: occurrence.muted ?? occurrence.mute ?? false,
      provenance: occurrence.provenance ?? {},
      ...(Array.isArray(occurrence.text_bindings)
        ? { text_bindings: occurrence.text_bindings }
        : {}),
    };
  });
  for (const occurrence of graphOccurrences) {
    if (!resolvedByKey.has(`${occurrence.shot_id}\u0000${occurrence.revision_id}`)) {
      throw new Error(`Workspace Runtime parent composition references an unresolved shot revision ${occurrence.shot_id}/${occurrence.revision_id}`);
    }
  }
  const headRevisionId = requiredString(parent.revision_id, 'parent composition revision.revision_id');
  const parentGraph = {
    ...parentPayload,
  };
  return {
    schema_version: 1,
    project: { project_id: projectId, document_id: timelineId, role: 'project' },
    primary_timeline: {
      document_id: timelineId,
      role: 'primary_timeline',
      head: { revision_id: headRevisionId, content_digest: requiredString(parent.content_digest, 'parent composition revision.content_digest') },
    },
    parent_composition: parentGraph,
    shot_revisions: shotRevisions,
    occurrences: graphOccurrences,
    cases: {
      missing_dependency: { shot_id: 'missing-dependency', revision_id: 'missing-revision', expected: 'missing_dependency' },
      stale_write_rejection: { expected_head_revision_id: headRevisionId, submitted_head_revision_id: headRevisionId, expected_status: 409 },
    },
    timeline: { timeline_id: timeline.timeline_id, project_id: timeline.project_id, version: timeline.version },
  };
}

export function runtimeGraphToContractFromCanonicalDocument(
  projectId: string,
  timelineId: string,
  document: CanonicalDocument,
  publicationId: string,
): RuntimeRecord {
  const parent = {
    project_id: projectId,
    timeline_id: timelineId,
    revision_id: document.parent_revision.revision_id,
    content_digest: document.parent_revision.content_digest,
    payload: document.parent_revision.payload,
  } as RuntimeRecord;
  const internalsByRevision = new Map<string, typeof document.internal_timeline_revisions[number]>();
  for (const internal of document.internal_timeline_revisions) {
    if (internalsByRevision.has(internal.revision_id)) {
      throw new TimelineSchemaIncompatibleError(`Workspace Runtime returned ambiguous internal revision ${internal.revision_id}`);
    }
    internalsByRevision.set(internal.revision_id, internal);
  }
  const resolved = document.shot_revisions.map((shot) => {
    const internalImage = internalsByRevision.get(shot.internal_timeline_revision_id);
    if (!internalImage) {
      throw new TimelineSchemaIncompatibleError(`Workspace Runtime shot closure is missing internal revision ${shot.internal_timeline_revision_id}`);
    }
    return {
      shot: {
        project_id: projectId,
        shot_id: shot.shot_id,
        revision_id: shot.revision_id,
        internal_timeline_revision_id: shot.internal_timeline_revision_id,
        content_digest: shot.content_digest,
        payload: shot.payload,
      } as RuntimeRecord,
      internal: {
        project_id: projectId,
        timeline_id: internalImage.timeline_id,
        revision_id: shot.internal_timeline_revision_id,
        content_digest: internalImage.content_digest,
        payload: internalImage.payload,
      } as RuntimeRecord,
    };
  });
  const graph = runtimeGraphToContract(
    projectId,
    timelineId,
    {
      project_id: projectId,
      timeline_id: timelineId,
      version: 1,
      head_revision_id: document.parent_revision.revision_id,
    },
    parent,
    resolved,
  );
  const primary = requiredRecord(graph.primary_timeline, 'accepted graph.primary_timeline');
  const head = requiredRecord(primary.head, 'accepted graph.primary_timeline.head');
  head.publication_id = publicationId;
  return {
    ...graph,
    accepted_identity: { revision_id: document.parent_revision.revision_id, publication_id: publicationId },
    canonical_document: document,
  };
}

function runtimePayloadWithoutCanonicalEnvelope(revision: RuntimeRecord): RuntimeRecord {
  if (revision.rawJson !== undefined) return requiredRecord(revision.rawJson, 'shot revision.rawJson');
  const { shot_id: _shotId, revision_id: _revisionId, document_role: _role, content_digest: _digest, internal_timeline_revision: _internal, publish: _publish, ...payload } = revision;
  return payload;
}

export async function toRuntimePublication(
  graph: RuntimeRecord,
  projectId: string,
  timelineId: string,
  expectedHead: string | null,
): Promise<RuntimeRecord> {
  const primary = requiredRecord(graph.primary_timeline, 'primary_timeline');
  const head = requiredRecord(primary.head, 'primary_timeline.head');
  const parentRevisionId = requiredString(head.revision_id, 'primary_timeline.head.revision_id');
  const revisions = array(graph.shot_revisions, 'shot_revisions');
  const occurrences = array(graph.occurrences, 'occurrences');
  const revisionByKey = new Map(revisions.map((revision) => [
    `${String(revision.shot_id)}\u0000${String(revision.revision_id)}`,
    revision,
  ]));
  const used = uniqueOccurrences(occurrences).map((occurrence) => {
    const key = `${String(occurrence.shot_id)}\u0000${String(occurrence.revision_id)}`;
    const revision = revisionByKey.get(key);
    if (!revision) throw new Error(`Canonical graph is missing shot revision ${key}`);
    return revision;
  }).filter((revision) => revision.publish === true);
  const internalByKey = new Map<string, RuntimeRecord>();
  const shotRevisions = used.map((revision) => {
    const internal = requiredRecord(revision.internal_timeline_revision, `shot revision ${String(revision.revision_id)}.internal_timeline_revision`);
    const internalRevisionId = requiredString(internal.revision_id, 'internal timeline revision.revision_id');
    const internalTimeline = requiredRecord(internal.timeline, `internal timeline revision ${internalRevisionId}.timeline`);
    const internalTimelineId = typeof internal.timeline_id === 'string' && internal.timeline_id.length > 0
      ? internal.timeline_id
      : timelineId;
    const timelineRevision = {
      timeline_id: internalTimelineId,
      revision_id: internalRevisionId,
      payload: internalTimeline,
    };
    if (internal.publish === true) {
      internalByKey.set(`${internalTimelineId}\u0000${internalRevisionId}`, timelineRevision);
    }
    return {
      shot_id: requiredString(revision.shot_id, 'shot revision.shot_id'),
      revision_id: requiredString(revision.revision_id, 'shot revision.revision_id'),
      internal_timeline_revision_id: internalRevisionId,
      payload: runtimePayloadWithoutCanonicalEnvelope(revision),
    };
  });
  const parentSource = requiredRecord(graph.parent_composition ?? {}, 'parent_composition');
  const parentComposition = {
    ...parentSource,
    config: parentSource.config ?? {},
    registry: parentSource.registry ?? {},
    clips: parentSource.clips ?? [],
    occurrences: occurrences.map((occurrence, ordinal) => ({
      ...occurrence,
      occurrence_id: requiredString(occurrence.occurrence_id, `occurrences[${ordinal}].occurrence_id`),
      shot_id: requiredString(occurrence.shot_id, `occurrences[${ordinal}].shot_id`),
      shot_revision_id: requiredString(occurrence.revision_id, `occurrences[${ordinal}].revision_id`),
      // `at_ms` is the canonical occurrence field. Spread legacy placement
      // metadata first so a stale nested start cannot overwrite a fresh drag.
      placement: { ...(occurrence.placement as RuntimeRecord ?? {}), start_ms: Number(occurrence.at_ms ?? 0) },
      source_offset: occurrence.source_offset ?? 0,
      duration_ms: Number(occurrence.duration_ms ?? 0),
      speed: occurrence.speed ?? 1,
      track: occurrence.track ?? 'video',
      transform: occurrence.transform ?? {},
      gain: occurrence.gain ?? 1,
      mute: occurrence.muted ?? occurrence.mute ?? false,
      provenance: occurrence.provenance ?? {},
      ...(Array.isArray(occurrence.text_bindings)
        ? { text_bindings: occurrence.text_bindings }
        : Array.isArray(occurrence.textBindings)
          ? { text_bindings: occurrence.textBindings }
          : {}),
    })),
  };
  const mediaDigests = new Set<string>();
  const collectMedia = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(collectMedia);
    if (value === null || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value as RuntimeRecord)) {
      if (['digest', 'content_digest', 'content_sha256', 'sha256'].includes(key) && typeof item === 'string' && /^sha256:[0-9a-f]{64}$/.test(item)) mediaDigests.add(item);
      else collectMedia(item);
    }
  };
  collectMedia(shotRevisions.map((revision) => revision.payload));
  collectMedia([...internalByKey.values()].map((revision) => revision.payload));
  collectMedia(parentComposition);
  return {
    project_id: projectId,
    timeline_id: timelineId,
    expected_head: expectedHead,
    parent_revision_id: parentRevisionId,
    parent_composition: parentComposition,
    shot_revisions: shotRevisions,
    internal_timeline_revisions: [...internalByKey.values()],
  };
}

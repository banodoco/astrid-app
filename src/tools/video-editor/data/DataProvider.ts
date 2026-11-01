export type {
  ImmutableProjectPackageDescriptor,
  ProjectObjectMetadata,
  ProjectObjectStorage,
} from '@/sdk/video/assets/projectObjects.ts';

import type { ProjectObjectStorage } from '@/sdk/video/assets/projectObjects.ts';

import { TimelineVersionConflictError } from '@/sdk/video/timeline/errors.ts';

/** A terminal local save refusal that did not establish a concurrent write. */
export class TimelineSaveError extends Error {
  readonly code = 'timeline_save_refused' as const;

  constructor(message = 'Timeline save was refused') {
    super(message);
    this.name = 'TimelineSaveError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export {
  TimelineVersionConflictError,
  isTimelineVersionConflictError,
  TimelineSchemaIncompatibleError,
  isTimelineSchemaIncompatibleError,
} from '@/sdk/video/timeline/errors.ts';
export type { TimelineSchemaIssue } from '@/sdk/video/timeline/errors.ts';
import type { AssetRegistry, TimelineConfig } from '@/tools/video-editor/types/index.ts';
import type { Checkpoint } from '@/tools/video-editor/types/history.ts';
import type { AssetResolver } from '@/tools/video-editor/data/AssetResolver.ts';
import type { TimelineBundleEnvelope } from '@/tools/video-editor/data/typed/timelineBundle.ts';
import type { GenerationRow } from '@/domains/generation/types/index.ts';
import type { ShotCompositionPort } from '@/tools/video-editor/data/shotCompositionAdapter.ts';
import type {
  CanonicalDocument,
  CommitAcceptedMutation,
  CommitRequest,
  DocumentPin,
  HistoryPage,
  MutationReceipt,
  VerifiedDocument,
  VerifiedDocumentObject,
} from '@/integrations/runtime/generated.ts';
export type {
  AssetProfile,
  SilenceRegion,
  UploadedAssetResult,
  UploadAssetOptions,
} from '@/tools/video-editor/data/AssetResolver.ts';

/** An opaque CAS base. Null is an explicit first publication, not unknown provenance. */
export interface TimelineHeadRevision {
  projectId: string;
  timelineId: string;
  headRevisionId: string | null;
  /** Runtime acceptance identity. A revision without this pin is read-only. */
  headPublicationId?: string | null;
}

export interface TimelineAcceptedIdentity {
  revisionId: string;
  publicationId: string;
}

export interface TimelineRecoveryIdentity {
  actorId: string;
  realmId: string;
}

export interface TimelineCommandBasis {
  head: TimelineAcceptedIdentity;
  canonicalDocument: CanonicalDocument;
  graph?: Record<string, unknown>;
  history?: HistoryPage;
}

export interface TimelineCommitResult {
  response: CommitAcceptedMutation;
  accepted: TimelineAcceptedIdentity;
  canonicalDocument: CanonicalDocument;
  /** The existing graph contract, projected from the accepted closure. */
  graph: Record<string, unknown>;
  /** Explicit enumerable copy; generated mutation receipts are non-enumerable elsewhere. */
  receipt: MutationReceipt;
}

export interface TimelineSaveReceipt {
  configVersion: number;
  head: TimelineHeadRevision;
}

export interface TimelineCommitCapability {
  commitTimeline(
    request: CommitRequest,
    idempotencyKey: string,
  ): Promise<TimelineCommitResult>;
  listTimelineCommits(timelineId: string, cursor?: string, limit?: number): Promise<HistoryPage>;
  undoTimeline(
    base: TimelineHeadRevision,
    publications: readonly string[],
    idempotencyKey: string,
  ): Promise<TimelineCommitResult>;
}

export interface LoadedTimeline {
  config: TimelineConfig;
  configVersion: number;
  head?: TimelineHeadRevision;
  /**
   * Persisted data-lane source items (TimelineBundle),
   * parsed fail-closed by the provider on load. `null` = nothing persisted;
   * `undefined` = provider has not adopted bundles yet. Views/occurrences are
   * derived at assembly — this carries SOURCE items only.
   */
  bundle?: TimelineBundleEnvelope | null;
}

export interface LoadedReferencedTimeline {
  timeline: LoadedTimeline;
  registry: AssetRegistry;
  /** Resolve child assets against the child timeline's registry/authority. */
  resolveAssetUrl: (file: string) => Promise<string>;
}

/** Verified authoring closure paired with this provider's actual display/version observation. */
export interface TimelineCommandBasisWithDisplay {
  basis: TimelineCommandBasis;
  timeline: LoadedTimeline;
  registry: AssetRegistry;
}

export class TimelineNotFoundError extends Error {
  code = 'timeline_not_found' as const;

  constructor(timelineId: string) {
    super(`Timeline ${timelineId} not found — it may have been deleted`);
    this.name = 'TimelineNotFoundError';
  }
}

export function isTimelineNotFoundError(error: unknown): error is TimelineNotFoundError {
  return error instanceof TimelineNotFoundError
    || (error instanceof Error && error.name === 'TimelineNotFoundError');
}

/**
 * A save was refused before it left the browser, because an earlier save of this same editor from the same head has
 * not been acknowledged yet (its answer never came back, for instance while Astrid was away) and this one differs
 * from it. Nobody else wrote anything: the earlier save is the editor's own, so this is never "the timeline changed
 * somewhere else". The persistence layer retries the earlier save first and sends this edit behind it.
 */
export class OwnUnacknowledgedSaveError extends TimelineVersionConflictError {
  readonly ownUnacknowledgedSave = true as const;
}

export function isOwnUnacknowledgedSaveError(error: unknown): error is OwnUnacknowledgedSaveError {
  return error instanceof OwnUnacknowledgedSaveError
    || (error instanceof Error && (error as { ownUnacknowledgedSave?: unknown }).ownUnacknowledgedSave === true);
}

/** Provider-wide outages must not enter the timeline save retry backoff. */
export function isProviderUnavailableError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === 'runtime_unavailable'
    || code === 'runtime_authentication'
    || code === 'runtime_incompatible';
}

// ---------------------------------------------------------------------------
// Extension persistence contracts
// ---------------------------------------------------------------------------

import type {
  ExtensionStateRepository,
  ExtensionSettingsSnapshot,
} from '@/tools/video-editor/runtime/extensionStateRepository.ts';
import type { ExtensionDiagnostic } from '@astrid/editor-sdk';


// ---------------------------------------------------------------------------
// Stable diagnostic codes for unsupported extension persistence capabilities
// ---------------------------------------------------------------------------

/**
 * Emitted when a {@link DataProvider} does not support extension state
 * persistence (enablement, packs, lifecycle events, dev overrides, project
 * lock metadata).
 */
export const PROVIDER_CAPABILITY_EXTENSION_STATE_UNSUPPORTED =
  'provider_capability_extension_state_unsupported' as const;

/**
 * Emitted when a {@link DataProvider} does not support extension settings
 * snapshot persistence.
 */
export const PROVIDER_CAPABILITY_EXTENSION_SETTINGS_UNSUPPORTED =
  'provider_capability_extension_settings_unsupported' as const;

/**
 * Emitted when a {@link DataProvider} does not support extension proposal
 * storage.
 */
export const PROVIDER_CAPABILITY_EXTENSION_PROPOSALS_UNSUPPORTED =
  'provider_capability_extension_proposals_unsupported' as const;

/**
 * Scope that binds extension persistence to a specific user and timeline.
 *
 * All extension state, settings, and proposals managed by an
 * {@link ExtensionPersistenceService} are scoped to this (userId, timelineId)
 * pair. Providers that implement extension persistence MUST isolate data by
 * this scope so that no cross-user or cross-timeline state leakage occurs.
 */
export interface ExtensionPersistenceScope {
  /** The owning user identifier (auth subject). */
  readonly userId: string;
  /** The timeline identifier that owns the extension state. */
  readonly timelineId: string;
}

// ---------------------------------------------------------------------------
// Proposal foundation types
// ---------------------------------------------------------------------------

/** The lifecycle status of an extension proposal. */
export type ExtensionProposalStatus =
  | 'draft'
  | 'submitted'
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'stale'
  | 'cancelled'
  | 'expired';

/** A single persisted proposal record. */
export interface ExtensionProposalRecord {
  /** Unique proposal identifier. */
  readonly id: string;
  /** The extension that emitted the proposal. */
  readonly extensionId: string;
  /** ISO 8601 timestamp of creation. */
  readonly createdAt: string;
  /** ISO 8601 timestamp of last update. */
  readonly updatedAt: string;
  /** Current lifecycle status. */
  readonly status: ExtensionProposalStatus;
  /** Opaque payload as defined by the extension (JSON-serializable). */
  readonly payload: Record<string, unknown>;
  /** Optional human-readable title for UI surfacing. */
  readonly title?: string;
  /** Backward-compatible display label used by cache tests. */
  readonly label?: string;
  /** Optional structured detail for filtering / display. */
  readonly detail?: Record<string, unknown>;
  /**
   * The timeline config version this proposal was created against.
   * Used for stale/expired conflict diagnostics.
   */
  readonly baseVersion?: number;
  /**
   * Epoch-ms timestamp when this proposal expires.
   * `undefined` means no expiry.
   */
  readonly expiresAt?: number;
  /**
   * ISO 8601 timestamp when this proposal was accepted.
   * Only present when status is `accepted`.
   */
  readonly acceptedAt?: string;
  /**
   * ISO 8601 timestamp when this proposal was rejected.
   * Only present when status is `rejected`.
   */
  readonly rejectedAt?: string;
}

/** A diagnostic code for proposal storage degradation (e.g., IndexedDB down). */
export const PROPOSAL_STORAGE_DEGRADED =
  'proposal_storage_degraded' as const;

export type ExtensionProposal = ExtensionProposalRecord;

/** Query criteria for listing proposals. */
export interface ExtensionProposalQuery {
  /** Filter by extension identifier. */
  extensionId?: string;
  /** Filter by one or more lifecycle statuses. */
  statuses?: readonly ExtensionProposalStatus[];
  /** Inclusive start timestamp (ISO 8601). */
  since?: string;
  /** Inclusive end timestamp (ISO 8601). */
  until?: string;
  /** Maximum number of proposals to return. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// ExtensionPersistenceCapabilities
// ---------------------------------------------------------------------------

/**
 * Describes which extension persistence capabilities a provider's
 * {@link ExtensionPersistenceService} supports.
 *
 * ## Capability truth: factory-plus-conformance
 *
 * A provider advertises support for a capability **solely** by implementing
 * the corresponding method on its {@link ExtensionPersistenceService} and
 * passing the shared provider conformance suite. The booleans on this
 * interface are derived from actual method availability — they are
 * descriptive, not prescriptive.
 *
 * Providers that do not implement a factory method MUST return `false` for
 * the matching capability and MUST NOT silently no-op when the capability
 * is requested. Callers should consult the conformance suite result rather
 * than these flags alone when deciding whether to depend on a capability.
 */
export interface ExtensionPersistenceCapabilities {
  /** The provider supports extension state persistence (enablement, packs, lifecycle). */
  readonly state: boolean;
  /** The provider supports extension settings snapshot persistence. */
  readonly settings: boolean;
  /** The provider supports extension proposal storage. */
  readonly proposals: boolean;
}

// ---------------------------------------------------------------------------
// ExtensionPersistenceService
// ---------------------------------------------------------------------------

/**
 * Provider-owned service that encapsulates extension persistence for a
 * single (userId, timelineId) scope.
 *
 * Providers advertise support by implementing
 * {@link DataProvider.createExtensionPersistenceService}. When a provider
 * does not support extension persistence, the factory is absent and
 * callers receive normalized unsupported diagnostics.
 *
 * The service wraps:
 * - An {@link ExtensionStateRepository} for enablement, packs, lifecycle
 *   events, dev overrides, and project lock metadata.
 * - A settings facade backed by {@link ExtensionSettingsSnapshot} (imported
 *   and reused from `extensionStateRepository.ts` — no parallel settings
 *   model exists).
 * - A proposal storage foundation (create, read, update
 *   status, list — policy execution is owned by the proposal runtime).
 *
 * ## Lifecycle
 *
 * 1. The provider creates the service via its factory.
 * 2. Callers invoke `initialize()` before any data access.
 * 3. Callers invoke `dispose()` when the scope is torn down.
 * 4. After disposal, all methods reject with a descriptive error.
 */
export interface ExtensionPersistenceService {
  /** The scope this service instance is bound to. */
  readonly scope: ExtensionPersistenceScope;

  /** The capabilities this service instance provides. */
  readonly capabilities: ExtensionPersistenceCapabilities;

  /**
   * Initialize the service (hydrate caches, open connections).
   *
   * Must be called before any other method. Idempotent.
   */
  initialize(): Promise<void>;

  /**
   * Dispose the service, closing connections and releasing resources.
   *
   * After disposal, all methods reject. Idempotent.
   */
  dispose(): Promise<void>;

  /** Whether the service has been disposed. */
  readonly isDisposed: boolean;

  /**
   * The underlying extension state repository.
   *
   * Only available when {@link ExtensionPersistenceCapabilities.state} is
   * `true`. Returns `undefined` for providers that only support settings
   * or proposals.
   */
  readonly stateRepository?: ExtensionStateRepository;

  /**
   * Persist an extension settings snapshot for the given extension.
   *
   * Only available when {@link ExtensionPersistenceCapabilities.settings}
   * is `true`. Overwrites any existing snapshot for the same extension ID.
   */
  putSettings?(snapshot: ExtensionSettingsSnapshot): Promise<void>;

  /**
   * Retrieve a settings snapshot for the given extension.
   *
   * Returns `null` when no snapshot exists or settings are unsupported.
   */
  getSettings?(extensionId: string): Promise<ExtensionSettingsSnapshot | null>;

  /**
   * Retrieve all settings snapshots in this scope.
   */
  getAllSettings?(): Promise<ExtensionSettingsSnapshot[]>;

  /**
   * Delete a settings snapshot (e.g. on uninstall).
   *
   * Idempotent.
   */
  deleteSettings?(extensionId: string): Promise<void>;

  // -----------------------------------------------------------------------
  // Proposal storage foundation
  // -----------------------------------------------------------------------

  /**
   * Create a new proposal record.
   *
   * Only available when {@link ExtensionPersistenceCapabilities.proposals}
   * is `true`.
   */
  createProposal?(record: Omit<ExtensionProposalRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<ExtensionProposalRecord | string>;

  /**
   * Retrieve a proposal by ID.
   *
   * Returns `null` when no proposal exists.
   */
  getProposal?(id: string): Promise<ExtensionProposalRecord | null>;

  /**
   * Update the status (and optionally detail) of an existing proposal.
   */
  updateProposalStatus?(id: string, status: ExtensionProposalStatus, detail?: Record<string, unknown>): Promise<ExtensionProposalRecord | void>;

  /**
   * Query proposals matching the given criteria.
   *
   * Returns proposals in reverse chronological order (newest first).
   */
  queryProposals?(query: ExtensionProposalQuery): Promise<ExtensionProposalRecord[]>;
}

// ---------------------------------------------------------------------------
// DataProvider extension
// ---------------------------------------------------------------------------

export interface DataProvider extends AssetResolver {
  /** Command commits are supplied whole by gesture/command producers. */
  timelineCommands?: TimelineCommitCapability;
  loadTimelineCommandBasis?(timelineId: string): Promise<TimelineCommandBasis>;
  resolveTimelineCommandAsset?(file: string, registry: AssetRegistry): Promise<string>;
  commitTimeline?(request: CommitRequest, idempotencyKey: string): Promise<TimelineCommitResult>;
  undoTimeline?(base: TimelineHeadRevision, publications: readonly string[], idempotencyKey: string): Promise<TimelineCommitResult>;
  getRecoverableIdentity?(): Promise<TimelineRecoveryIdentity>;
  /** Resume an existing native bootstrap owner without creating a new timeline or request. */
  recoverNativeBootstrapTimeline?(timelineId: string, ownerId: string): Promise<TimelineCommandBasis>;
  /** Exact retained inputs through this provider's authenticated project session. */
  readonly paramReadClient?: {
    getProjectVerifiedDocument(projectId: string, pin: DocumentPin): Promise<VerifiedDocument>;
    getProjectVerifiedDocumentObject(projectId: string, pin: DocumentPin, objectId: string): Promise<VerifiedDocumentObject>;
  };
  documents?: import('@/sdk/context.ts').ProjectDocumentSurface;
  projectTranscripts?: import('./typed/projectTranscript.ts').ProjectTranscriptRepository;
  /** When present, writes MUST use this immutable-head CAS path, never numeric versions. */
  saveTimelineAtHead?(
    timelineId: string,
    config: TimelineConfig,
    expectedHead: TimelineHeadRevision,
    registry?: AssetRegistry,
    bundle?: TimelineBundleEnvelope | null,
  ): Promise<TimelineSaveReceipt>;
  /** Optional canonical shot-composition boundary. Legacy shot records are not a fallback. */
  shotComposition?: ShotCompositionPort;
  /** Optional provider-owned generation lookup for editor asset actions. */
  loadGenerationForLightbox?(generationId: string): Promise<GenerationRow | null>;
  /** Existing Runtime-managed object plane for editable project sources. */
  projectObjects?: ProjectObjectStorage;
  persistenceEnabled?: boolean;
  /** Durable-recovery metadata captured synchronously at the first local edit. */
  getTimelineDraftRecoveryMetadata?(
    rememberRaw?: (composition: import('./shotCompositionAdapter.ts').PreparedShotComposition) => void,
  ): import('./timelineDraftIndexedDb.ts').TimelineDraftRecoveryMetadata;
  /** Explicit reload path that bypasses provider-local unsaved recovery state. */
  loadCanonicalTimeline?(timelineId: string): Promise<LoadedTimeline>;

  /**
   * Declared capability flags. Callers branch on these
   * booleans instead of `instanceof` type-sniffing: a provider DECLARES what
   * it supports, so no behavioral fork hides inside a type check. Absent or
   * `false` both mean "not supported".
   */
  /**
   * Direct upload of every dropped file without per-type handlers
   * (`useExternalDrop` → `directAssetUploadAllFiles`).
   */
  supportsDirectAssetUpload?: boolean;
  loadTimeline(timelineId: string, options?: { poll?: boolean }): Promise<LoadedTimeline>;
  /** Associate development timing phases with one shot-popup save attempt. */
  setShotTimelineTraceId?(traceId: string | null): void;
  /** Read a nested timeline document for preview-only composition. */
  loadReferencedTimeline?(timelineId: string, options?: { poll?: boolean }): Promise<LoadedReferencedTimeline>;
  /** Persist the project-level primary/default timeline selection. */
  setPrimaryTimeline?(timelineId: string): Promise<void>;
  saveTimeline(
    timelineId: string,
    config: TimelineConfig,
    expectedVersion: number,
    registry?: AssetRegistry,
    /**
     * Optional data-lane bundle to persist atomically with config+registry.
     * `undefined` leaves any stored bundle untouched; explicit `null` clears
     * it. Implementors MUST validate a provided envelope (fail-closed) before
     * mutating any state or issuing a network call.
     */
    bundle?: TimelineBundleEnvelope | null,
  ): Promise<number>;
  saveCheckpoint?(timelineId: string, checkpoint: Omit<Checkpoint, 'id'>): Promise<string>;
  loadCheckpoints?(timelineId: string): Promise<Checkpoint[]>;
  loadAssetRegistry(timelineId: string, options?: { poll?: boolean }): Promise<AssetRegistry>;

  /**
   * Create an extension persistence service for the given scope.
   *
   * Optional — providers that do not support extension persistence leave
   * this method absent. When absent, callers receive normalized unsupported
   * diagnostics instead of silently no-oping.
   *
   * The returned service's {@link ExtensionPersistenceCapabilities} reflect
   * the provider's actual capabilities. A provider that implements this
   * factory MUST pass the shared provider conformance suite for every
   * capability it advertises.
   *
   * @param scope   The (userId, timelineId) scope for all extension data.
   * @param diagnostics An array the provider may append
   *   {@link ExtensionDiagnostic} entries to (unsupported notices,
   *   degraded-mode warnings, etc.).
   */
  createExtensionPersistenceService?(
    scope: ExtensionPersistenceScope,
    diagnostics: ExtensionDiagnostic[],
  ): ExtensionPersistenceService;
}

export function isDataProviderPersistenceEnabled(provider: DataProvider | null | undefined): boolean {
  return provider?.persistenceEnabled !== false;
}

// The persistence boundary for the headless editor core remains the existing
// data provider contract. Core/runtime ports can rename or regroup host inputs,
// but persistence should continue to flow through this canonical interface.
export type VideoEditorPersistencePort = DataProvider;

// ---------------------------------------------------------------------------
// Unsupported capability diagnostics helper
// ---------------------------------------------------------------------------

/**
 * Append {@link ExtensionDiagnostic} entries to `diagnostics` for every
 * extension persistence capability that is not supported by the provider.
 *
 * This is the **single helper path** for emitting the three stable
 * `provider_capability_extension_*_unsupported` codes. Callers that
 * encounter a provider without a
 * {@link DataProvider.createExtensionPersistenceService} factory (or whose
 * factory returns `null`) should call this helper instead of silently
 * no-oping so that downstream consumers (diagnostics UIs, telemetry,
 * conformance reporters) receive normalized, predictable signals.
 *
 * @param diagnostics  The array to append diagnostic entries to.
 * @param capabilities  Optional capability flags. When omitted or when a key
 *   is absent, that capability is treated as **unsupported** and a diagnostic
 *   is emitted. When a key is `true`, the corresponding diagnostic is
 *   suppressed (the provider supports that capability). When a key is
 *   `false`, the diagnostic is emitted (explicit unsupported).
 * @param providerName  Optional human-readable provider name used in
 *   diagnostic messages. Defaults to `"this provider"`.
 */
export function pushUnsupportedCapabilityDiagnostics(
  diagnostics: ExtensionDiagnostic[],
  capabilities?: {
    readonly state?: boolean;
    readonly settings?: boolean;
    readonly proposals?: boolean;
  },
  providerName?: string,
): void {
  const name = providerName ?? 'this provider';

  const emit = (code: string, capability: string): void => {
    diagnostics.push({
      severity: 'info',
      code,
      message: `Extension ${capability} persistence is not supported by ${name}.`,
      milestone: 'm2',
    });
  };

  if (!capabilities) {
    emit(PROVIDER_CAPABILITY_EXTENSION_STATE_UNSUPPORTED, 'state');
    emit(PROVIDER_CAPABILITY_EXTENSION_SETTINGS_UNSUPPORTED, 'settings');
    emit(PROVIDER_CAPABILITY_EXTENSION_PROPOSALS_UNSUPPORTED, 'proposal');
    return;
  }

  if (!capabilities.state) {
    emit(PROVIDER_CAPABILITY_EXTENSION_STATE_UNSUPPORTED, 'state');
  }
  if (!capabilities.settings) {
    emit(PROVIDER_CAPABILITY_EXTENSION_SETTINGS_UNSUPPORTED, 'settings');
  }
  if (!capabilities.proposals) {
    emit(PROVIDER_CAPABILITY_EXTENSION_PROPOSALS_UNSUPPORTED, 'proposal');
  }
}

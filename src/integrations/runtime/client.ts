import {
  ApiError,
  PROTOCOL,
  WorkspaceClient,
  type Handshake,
  type Health,
  type Capability,
  type ByteResponse,
  type Generation,
  type GenerationVariant,
  type Event,
  type ManagedOutput,
  type ManagedOutputExportReceipt,
  type MediaImportOperation as MediaImport,
  type MutationResult,
  type Page,
  type Project,
  type Realm,
  type Task,
  type ObjectLocation,
  type TimelineInspectionResult,
  type CommitAcceptedMutation,
  type CommitPreviewResponse,
  type CommitRequest,
  type HistoryPage,
  type MediaSelection,
  type MediaSelectionQuery,
  type VerifiedMedia,
  type Transport,
  type RequestBody,
  type DocumentPin,
} from './generated.ts';
import {
  RUNTIME_ACCEPTED_SCHEMA_DIGESTS,
  RUNTIME_TARGETED_EXECUTION_CAPABILITY,
} from './contract-metadata.ts';
import { runtimeApiBase, runtimeOrigin } from './connection.ts';
import { loadWorkspaceRuntimeConfig } from './workspaceRuntimeConfig.ts';

// A client without an explicit `baseUrl` asks `runtimeApiBase()` on every request: same-origin
// `/api/runtime` locally (the connector/proxy injects the product credential), or the loopback
// gateway on the hosted build. It never caches the base, so a client built before boot still
// reaches the right place.
export const RUNTIME_CLIENT_VERSION = 'astrid-r1-consumer-20260911';
export const RUNTIME_CLIENT_SCOPES = [
  'handshake',
  'installer:update',
  'projects:read',
  'projects:write',
  'objects:read',
  'objects:write',
  'tasks:read',
  'tasks:write',
];
const FORBIDDEN_RUNTIME_ACTORS = new Set(['owner', 'astrid-pack-host', 'admin', 'worker']);

export interface RuntimeIdentityBinding {
  actorId: string;
  realmId: string;
  runtimeInstanceId: string;
}

function configuredRuntimeIdentity(): RuntimeIdentityBinding | undefined {
  const actorId = import.meta.env.VITE_WORKSPACE_RUNTIME_EXPECTED_ACTOR_ID?.trim();
  const realmId = import.meta.env.VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID?.trim();
  const runtimeInstanceId = import.meta.env.VITE_WORKSPACE_RUNTIME_EXPECTED_INSTANCE_ID?.trim();
  const configured = [actorId, realmId, runtimeInstanceId].filter(Boolean).length;
  if (configured === 0) return undefined;
  if (configured !== 3) {
    throw new Error('Workspace Runtime launch identity is incomplete');
  }
  return { actorId, realmId, runtimeInstanceId };
}

// Without build-time launch ids (the paired path), the first healthy session a
// page observes for a base URL becomes its binding, shared by every client object
// because call sites construct clients ad hoc. A later session that sees another
// Runtime instance or realm is a restart, never a silent rebind: relaunch is
// required (a page reload starts a fresh observation) and drafts stay untouched.
export type ObservedRuntimeIdentities = Map<string, { actorId?: string; realmId: string; runtimeInstanceId: string; fencedReason?: string }>;
const RESTART_INSTANCE = 'Runtime restarted—relaunch workspace. The selected Runtime instance changed; your timeline draft is preserved.';
const RESTART_REALM = 'Runtime realm changed—relaunch workspace. The connected Runtime belongs to a different realm; your timeline draft is preserved.';
const observedRuntimeIdentities: ObservedRuntimeIdentities = new Map();
let pageRuntimeIdentity: Promise<RuntimeIdentityBinding | undefined> | undefined;

export function initializeWorkspaceRuntimeIdentity(): Promise<RuntimeIdentityBinding | undefined> {
  if (!pageRuntimeIdentity) {
    const fetchImpl = globalThis.fetch;
    // The runtime config is served by the local preview proxy, so only same-origin builds read it. The hosted
    // build has no identity compiled in and binds to the first healthy session it sees through the gateway.
    pageRuntimeIdentity = typeof fetchImpl === 'function' && runtimeOrigin() === ''
      ? loadWorkspaceRuntimeConfig(configuredRuntimeIdentity(), fetchImpl.bind(globalThis))
      : Promise.resolve(configuredRuntimeIdentity());
  }
  return pageRuntimeIdentity;
}

type RuntimeSession = { health: Health; handshake: Handshake; realm: Realm };
/** A negotiated session, held by reference so every client that shares it also shares its invalidation. */
type SessionSlot = { current: Promise<RuntimeSession> | null; inflight: Map<string, Promise<unknown>> };
// The App constructs clients ad hoc (a dozen hooks each call `new AstridRuntimeClient()`),
// and without sharing, every instance runs its own health + handshake + realm round trips: four
// handshakes on a cold load. Clients on the default browser transport with no private
// credentials share one slot per base URL and launch binding, so a page negotiates once.
// Slots are scoped to the `fetch` they were negotiated through, so replacing the
// global fetch (tests, instrumentation) starts from a clean slate.
const sharedSessionSlots = new WeakMap<object, Map<string, SessionSlot>>();
function sharedSlotFor(key: string): SessionSlot {
  const scope: object = typeof globalThis.fetch === 'function' ? globalThis.fetch : sharedSessionSlots;
  let slots = sharedSessionSlots.get(scope);
  if (!slots) sharedSessionSlots.set(scope, slots = new Map());
  let slot = slots.get(key);
  if (!slot) slots.set(key, slot = { current: null, inflight: new Map() });
  return slot;
}

const LEGACY_RUNTIME_CLIENT_SCOPES = RUNTIME_CLIENT_SCOPES.filter((scope) => scope !== 'installer:update');
function hasExactScopes(actual: string[]): boolean {
  return [RUNTIME_CLIENT_SCOPES, LEGACY_RUNTIME_CLIENT_SCOPES].some((expected) =>
    actual.length === expected.length
      && [...actual].sort().every((scope, index) => scope === [...expected].sort()[index]));
}

export class RuntimeUnavailableError extends Error {
  readonly code = 'runtime_unavailable' as const;
  readonly recoveryAction: string;
  readonly status?: number;
  readonly causeCode?: string;
  readonly failureKind: 'storage' | 'admission' | 'transport' | 'unknown';

  constructor(cause: unknown, baseUrl: string) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const apiError = cause instanceof ApiError ? cause : undefined;
    const diagnostic = `${detail} ${apiError ? JSON.stringify(apiError.details) : ''}`;
    const storageFailure = /no space left on device|enospc|disk full|storage full/i.test(diagnostic);
    const admissionFailure = apiError?.code === 'realm_admission_failed'
      || /startup admission|integrity check|dependency_graph_mismatch/i.test(diagnostic);
    const failureKind = storageFailure
      ? 'storage'
      : admissionFailure
        ? 'admission'
        : apiError
          ? 'unknown'
          : 'transport';
    super(
      `Workspace Runtime is unavailable at ${baseUrl}: ${detail}. `
      + (storageFailure
        ? 'The Runtime reported a storage-capacity failure; your timeline draft is preserved.'
        : admissionFailure
          ? 'The Runtime failed its startup or integrity checks; your timeline draft is preserved.'
          : 'Start the supported Runtime and configure its authenticated connector, then retry.'),
    );
    this.name = 'RuntimeUnavailableError';
    this.status = apiError?.status;
    this.causeCode = apiError?.code;
    this.failureKind = failureKind;
    this.recoveryAction = storageFailure
      ? 'Check the Runtime data volume and restart it, then retry; your timeline draft is preserved.'
      : admissionFailure
        ? 'Repair or restore the Runtime realm, restart it, then retry; your timeline draft is preserved.'
        : 'Start the supported Runtime and configure its authenticated connector, then retry.';
  }
}

export class RuntimeAuthenticationError extends Error {
  readonly code = 'runtime_authentication' as const;
  readonly status = 401 as const;
  readonly recoveryAction = 'Provide an authenticated connector credential and retry.';

  constructor(baseUrl: string) {
    super(
      `Workspace Runtime authentication failed at ${baseUrl}: the credential was rejected or revoked. `
      + 'Provide an authenticated connector credential and retry.',
    );
    this.name = 'RuntimeAuthenticationError';
  }
}

export class RuntimeCompatibilityError extends Error {
  readonly code = 'runtime_incompatible' as const;
  readonly recoveryAction: string;

  constructor(public readonly kind: 'schema' | 'capability' | 'identity', public readonly detail: string, baseUrl: string) {
    const recoveryAction = kind === 'schema'
      ? 'Update Astrid on this computer, then reconnect.'
      : kind === 'identity'
        ? 'Restart the selected Astrid Runtime and reconnect to the same workspace.'
        : 'Use a Runtime that supports this capability, then retry.';
    super(`Workspace Runtime at ${baseUrl} is incompatible (${kind}): ${detail}. ${recoveryAction}`);
    this.name = 'RuntimeCompatibilityError';
    this.recoveryAction = recoveryAction;
  }
}

export type RuntimeConnectorError = RuntimeAuthenticationError | RuntimeUnavailableError | RuntimeCompatibilityError;

export type InstallerUpdateStatusState = 'none' | 'active' | 'terminal' | 'recovery-needed';
export type InstallerUpdateOutcome = 'updated' | 'rolled_back' | 'failed';
export type InstallerUpdateReason = 'busy' | 'autostart-off' | 'unsupported-service-manager' | 'recovery-needed';

/** Exact editor-owned explanations for the Runtime's allowlisted refusal states. */
export const INSTALLER_UPDATE_REASON_MESSAGES: Readonly<Record<InstallerUpdateReason, string>> = Object.freeze({
  busy: 'Astrid is busy. Wait for the current operation to finish before trying again.',
  'autostart-off': 'Automatic startup is off. Turn it on before updating Astrid here.',
  'unsupported-service-manager': 'In-app updates require user systemd 254 or newer on Linux.',
  'recovery-needed': 'Astrid needs recovery. Select Update to check the previous operation before continuing.',
});

/** Raw, read-only installer status returned by the Runtime producer. */
export interface InstallerUpdateStatus {
  available: boolean;
  state: InstallerUpdateStatusState;
  operation_id?: string;
  result?: string;
  outcome?: InstallerUpdateOutcome;
  target_release?: number | string;
  accepted_at?: number | string;
  log_path?: string;
  reason?: string;
}

/** The producer's update capability is only whether its transient launcher exists. */
export type InstallerUpdateCapability = Pick<InstallerUpdateStatus, 'available' | 'reason'>;

/** Successful durable acceptance of an update request. */
export interface InstallerUpdateAcceptance {
  accepted: true;
  state: 'accepted';
  operation_id: string;
  message: string;
}

/** Startup identity exposed by the authenticated health endpoint. */
export interface InstallerUpdateHealth extends Omit<Health, 'identity'> {
  identity?: { managed_by?: string | null; release?: number; [key: string]: unknown } | null;
}

export interface InstallerUpdateEligibilityRefusal {
  reason: string;
  message: string;
}

function objectValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateInstallerUpdateStatus(value: unknown): InstallerUpdateStatus {
  if (!objectValue(value) || typeof value.available !== 'boolean'
    || !['none', 'active', 'terminal', 'recovery-needed'].includes(String(value.state))) {
    throw new Error('invalid installer update status response');
  }
  if (value.operation_id !== undefined && typeof value.operation_id !== 'string') throw new Error('invalid installer update operation id');
  if (value.result !== undefined && typeof value.result !== 'string') throw new Error('invalid installer update result');
  if (value.outcome !== undefined && !['updated', 'rolled_back', 'failed'].includes(String(value.outcome))) throw new Error('invalid installer update outcome');
  if (value.target_release !== undefined && typeof value.target_release !== 'string' && typeof value.target_release !== 'number') throw new Error('invalid installer update target release');
  if (value.accepted_at !== undefined && typeof value.accepted_at !== 'string' && typeof value.accepted_at !== 'number') throw new Error('invalid installer update acceptance time');
  if (value.log_path !== undefined && typeof value.log_path !== 'string') throw new Error('invalid installer update log path');
  if (value.reason !== undefined && (typeof value.reason !== 'string' || !value.reason)) throw new Error('invalid installer update reason');
  return value as unknown as InstallerUpdateStatus;
}

function validateInstallerUpdateAcceptance(value: unknown): InstallerUpdateAcceptance {
  if (!objectValue(value) || value.accepted !== true || value.state !== 'accepted'
    || typeof value.operation_id !== 'string' || !/^[0-9a-f]{32}$/.test(value.operation_id)
    || typeof value.message !== 'string') {
    throw new Error('invalid installer update acceptance response');
  }
  return value as unknown as InstallerUpdateAcceptance;
}

function validateInstallerUpdateHealth(value: unknown): InstallerUpdateHealth {
  if (!objectValue(value) || (value.status !== 'ok' && value.status !== 'degraded')
    || value.protocol !== PROTOCOL || typeof value.schema_digest !== 'string'
    || typeof value.runtime_instance_id !== 'string' || typeof value.runtime_session_id !== 'string'
    || typeof value.runtime_epoch !== 'number'
    || (value.identity !== undefined && value.identity !== null && !objectValue(value.identity))) {
    throw new Error('invalid installer update health response');
  }
  const identity = objectValue(value.identity) ? value.identity : undefined;
  return {
    ...value,
    ...(typeof identity?.release === 'number' ? { release: identity.release } : {}),
  } as unknown as InstallerUpdateHealth;
}

export function isRuntimeUnavailableFailure(error: unknown): boolean {
  if (error instanceof RuntimeUnavailableError) return true;
  if (!(error instanceof ApiError)) return false;
  return error.status >= 500
    || error.code === 'realm_admission_failed'
    || error.code === 'runtime_unhealthy'
    || error.code === 'service_unavailable';
}

export function isRuntimeConflict(error: unknown): error is ApiError {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  if (error.code === 'realm_admission_failed' || error.code === 'runtime_unhealthy') return false;
  if (error.details?.status === 'conflict') return true;
  if (error.details?.status === 'refused') return false;
  if (error.code === 'timeline_version_conflict' || error.code === 'stale_write') return true;
  // Classify on structure, never on message wording. The Runtime's stale-head
  // 409 (publish and restore) carries details.reason = 'stale_head'; its other
  // compare-and-swap 409s carry the numeric {expected, actual} pair.
  if (error.code !== 'conflict') return false;
  const details = error.details ?? {};
  return details.reason === 'stale_head' || (typeof details.expected === 'number' && typeof details.actual === 'number');
}

export type RuntimeCommitFailureKind =
  | 'conflict'
  | 'refused'
  | 'validation'
  | 'authorization'
  | 'storage'
  | 'unknown';

/** Classify commit failures from the typed Runtime status/reason fields. */
export function classifyRuntimeCommitFailure(error: unknown): RuntimeCommitFailureKind {
  if (!(error instanceof ApiError)) return 'unknown';
  // These typed refusals leave the exact request retryable, including 409
  // head contention. Keep them in the session's unknown-outcome retry lane.
  if (error.details?.reason === 'head_busy' || error.details?.reason === 'runtime_unavailable') return 'unknown';
  const status = error.details?.status;
  if (status === 'conflict') return 'conflict';
  if (status === 'refused') return 'refused';
  if (error.status === 401 || error.status === 403) return 'authorization';
  if (error.status === 400 || error.status === 422) return 'validation';
  if (/storage|disk|space/i.test(error.code) || /storage|disk|space/i.test(String(error.details?.reason ?? ''))) return 'storage';
  if (error.status >= 500) return 'unknown';
  return 'unknown';
}

/**
 * A canonical payload disagreement is a schema/persistence defect, not a
 * stale-head conflict. It must stop the save retry loop and keep the draft
 * available for correction.
 */
export function isRuntimeCanonicalPayloadConflict(error: unknown): error is ApiError {
  return error instanceof ApiError
    && error.status === 409
    && error.details?.reason === 'canonical_payload_mismatch';
}

export class AstridRuntimeClient {
  /** Set only when the caller pinned a base; otherwise every read resolves `runtimeApiBase()`. */
  private readonly pinnedBaseUrl: string | undefined;
  private readonly token: string | undefined;
  private readonly transport: Transport | undefined;
  private readonly workspaceClients = new Map<string, WorkspaceClient>();
  private expectedIdentity: RuntimeIdentityBinding | undefined;
  /** A default client with no pinned launch binding adopts the page's runtime config on its first session. */
  private usesRuntimeConfig: boolean;
  private readonly readOnly: boolean;
  private discoveryBinding: { identity?: RuntimeIdentityBinding } = {};
  private readonly signal: AbortSignal | undefined;
  /** A status-only session can read the workspace while its cold Runtime is degraded. */
  private statusSession: Promise<RuntimeSession> | null = null;
  private readonly identityStore: ObservedRuntimeIdentities;
  /** A private slot (token, transport or injected store); undefined means the page-shared slot for the current base. */
  private readonly ownSlot: SessionSlot | undefined;

  constructor(options: {
    baseUrl?: string; token?: string; transport?: Transport; expectedIdentity?: RuntimeIdentityBinding;
    /** Catalog reads may follow local discovery after a restart; this client cannot mutate. */
    readOnly?: boolean;
    /** Observation store; the browser shares one per page, an injected transport (tests/CLI) gets its own. */
    identityStore?: ObservedRuntimeIdentities;
    /** Cancel this caller's requests without cancelling a shared browser session. */
    signal?: AbortSignal;
  } = {}) {
    this.identityStore = options.identityStore ?? (options.transport || options.readOnly ? new Map() : observedRuntimeIdentities);
    this.pinnedBaseUrl = options.baseUrl;
    this.readOnly = options.readOnly === true;
    this.expectedIdentity = options.expectedIdentity ?? configuredRuntimeIdentity();
    this.usesRuntimeConfig = (options.baseUrl === undefined || this.readOnly)
      && !options.expectedIdentity && !options.transport && !options.token;
    // Browser credentials are supplied by the authenticated connector/proxy.
    // A token is accepted for direct test/CLI clients, but is never persisted.
    this.token = options.token;
    this.transport = options.transport;
    this.signal = options.signal;
    this.ownSlot = options.token || options.transport || options.identityStore || options.signal
      ? { current: null, inflight: new Map() }
      : undefined;
  }

  /** The Runtime base this client talks to, resolved now (see `connection.ts`). */
  get baseUrl(): string {
    return this.pinnedBaseUrl ?? runtimeApiBase();
  }

  private get client(): WorkspaceClient {
    const base = this.baseUrl;
    let client = this.workspaceClients.get(base);
    if (!client) {
      const signal = this.signal;
      const transport: Transport | undefined = signal ? async (method, path, headers, body) => {
        signal.throwIfAborted();
        if (this.transport) {
          const response = await this.transport(method, path, headers, body);
          signal.throwIfAborted();
          return response;
        }
        const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
          method, headers, body: body as BodyInit | undefined, signal,
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        signal.throwIfAborted();
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => { responseHeaders[key] = value; });
        return { status: response.status, headers: responseHeaders, body: bytes };
      } : this.transport;
      this.workspaceClients.set(base, client = new WorkspaceClient(base, this.token, transport));
    }
    return client;
  }

  /** A cancellable attempt keeps identity fences but never joins another attempt's in-flight reads. */
  withSignal(signal: AbortSignal): AstridRuntimeClient {
    const client = new AstridRuntimeClient({
      baseUrl: this.pinnedBaseUrl, token: this.token, transport: this.transport,
      expectedIdentity: this.expectedIdentity, readOnly: this.readOnly,
      identityStore: this.identityStore, signal,
    });
    client.usesRuntimeConfig = this.usesRuntimeConfig;
    client.discoveryBinding = this.discoveryBinding;
    return client;
  }

  /** One slot per resolved base and launch binding, so a page negotiates once per base. */
  private get slot(): SessionSlot {
    return this.ownSlot ?? sharedSlotFor(JSON.stringify([this.baseUrl, this.expectedIdentity ?? null, this.readOnly]));
  }

  /** Refuse every operation once any client sharing this binding saw a restart. */
  assertNotFenced(): void {
    const reason = this.identityStore.get(this.baseUrl)?.fencedReason;
    if (reason) throw new RuntimeCompatibilityError('identity', reason, this.baseUrl);
  }

  private fence(reason: string): never {
    const bound = this.identityStore.get(this.baseUrl);
    if (bound) bound.fencedReason = reason;
    throw new RuntimeCompatibilityError('identity', reason, this.baseUrl);
  }

  private static instanceIdOf(health: Health): string {
    const id = (health as Health & { runtime_instance_id?: unknown }).runtime_instance_id;
    return typeof id === 'string' ? id.trim() : '';
  }

  /** Compare against the binding without committing it. */
  private checkObservedIdentity(health: Health, handshake: Handshake): void {
    this.assertNotFenced();
    const instanceId = AstridRuntimeClient.instanceIdOf(health);
    if (!instanceId) {
      throw new RuntimeCompatibilityError('identity', 'Runtime health did not report an instance id, so restarts cannot be detected', this.baseUrl);
    }
    const bound = this.identityStore.get(this.baseUrl);
    if (!bound) return;
    if (bound.actorId && bound.actorId !== handshake.actor_id) this.fence('Runtime actor changed—relaunch workspace. Recoverable timeline work remains scoped to the original actor.');
    if (bound.realmId !== handshake.realm_id) this.fence(RESTART_REALM);
    if (bound.runtimeInstanceId !== instanceId) this.fence(RESTART_INSTANCE);
  }

  private commitObservedIdentity(health: Health, handshake: Handshake): void {
    const bound = this.identityStore.get(this.baseUrl);
    if (!bound) {
      this.identityStore.set(this.baseUrl, { actorId: handshake.actor_id, realmId: handshake.realm_id, runtimeInstanceId: AstridRuntimeClient.instanceIdOf(health) });
    } else if (!bound.actorId) {
      bound.actorId = handshake.actor_id;
    }
  }

  /** Cheap pre-write fence: one health read against the bound instance (the Runtime offers no expected-instance precondition on mutations). */
  private async revalidateInstance(): Promise<void> {
    const expected = this.expectedIdentity?.runtimeInstanceId ?? this.identityStore.get(this.baseUrl)?.runtimeInstanceId;
    if (!expected) return;
    let health: Health;
    try {
      health = await this.client.health();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw error;
      throw new RuntimeUnavailableError(error, this.baseUrl);
    }
    if (AstridRuntimeClient.instanceIdOf(health) !== expected) {
      this.slot.current = null;
      if (this.expectedIdentity) throw new RuntimeCompatibilityError('identity', RESTART_INSTANCE, this.baseUrl);
      this.fence(RESTART_INSTANCE);
    }
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.readOnly) throw new Error('A read-only Runtime discovery client cannot mutate the workspace');
    // A read already in flight may predate this write; later readers must not join it.
    this.slot.inflight.clear();
    try {
      return await this.withSession(async () => {
        await this.revalidateInstance();
        return operation();
      });
    } finally {
      this.slot.inflight.clear();
    }
  }

  /**
   * Concurrent identical reads share one request (the editor asks for the same
   * timeline head and revisions from several hooks at once). Only requests in
   * flight are shared, never results, and a mutation drops them, so a read that
   * starts after a write always reaches the Runtime. Each caller owns its result.
   */
  private coalescedRead<T>(key: string, read: () => Promise<T>): Promise<T> {
    const { inflight } = this.slot;
    const running = inflight.get(key) as Promise<T> | undefined;
    if (running) return running.then((value) => structuredClone(value));
    const request: Promise<T> = this.withSession(read).finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
    inflight.set(key, request);
    return request;
  }

  async ensureSession(): Promise<RuntimeSession> {
    this.signal?.throwIfAborted();
    // Every ad hoc client must receive the same page binding, including clients
    // that join a session opened by another instance.
    if (this.usesRuntimeConfig) {
      if (this.readOnly && runtimeOrigin() === '') {
        // Catalogs follow the proxy's current discovery, independently of the
        // launch binding held by timeline writers with drafts in memory.
        const identity = await loadWorkspaceRuntimeConfig(this.expectedIdentity, globalThis.fetch, this.signal);
        this.signal?.throwIfAborted();
        if (this.discoveryBinding.identity && identity
          && (identity.actorId !== this.discoveryBinding.identity.actorId || identity.realmId !== this.discoveryBinding.identity.realmId)) {
          throw new RuntimeCompatibilityError('identity', 'Runtime discovery changed the selected actor or realm', this.baseUrl);
        }
        this.discoveryBinding.identity ??= identity;
        this.expectedIdentity = identity;
      } else {
        this.expectedIdentity = await initializeWorkspaceRuntimeIdentity();
      }
    }
    this.signal?.throwIfAborted();
    const slot = this.slot;
    if (!slot.current) {
      const opening: Promise<RuntimeSession> = this.openSession().catch((error) => {
        if (slot.current === opening) slot.current = null;
        throw error;
      });
      slot.current = opening;
    }
    return slot.current;
  }

  /** Read current health without reusing the session's cached health snapshot. */
  async readStatus(): Promise<{ health: Health; realm: Realm }> {
    let session: RuntimeSession;
    if (!this.slot.current && this.statusSession) {
      session = await this.statusSession;
    } else {
      try {
        session = await this.ensureSession();
      } catch (error) {
        if (!(error instanceof RuntimeUnavailableError && error.causeCode === 'runtime_unhealthy')) throw error;
        if (!this.statusSession) {
          const opening: Promise<RuntimeSession> = this.openSession(true).catch((statusError) => {
            if (this.statusSession === opening) this.statusSession = null;
            throw statusError;
          });
          this.statusSession = opening;
        }
        session = await this.statusSession;
      }
    }
    const health = await this.client.health();
    const instanceId = AstridRuntimeClient.instanceIdOf(health);
    const expectedInstanceId = this.expectedIdentity?.runtimeInstanceId ?? AstridRuntimeClient.instanceIdOf(session.health);
    if (!instanceId || instanceId !== expectedInstanceId) {
      throw new RuntimeCompatibilityError('identity', 'Runtime status belongs to a different instance than the connected workspace', this.baseUrl);
    }
    if (this.expectedIdentity && session.realm.realm_id !== this.expectedIdentity.realmId) {
      throw new RuntimeCompatibilityError('identity', 'Runtime status belongs to a different realm than the selected Astrid profile', this.baseUrl);
    }
    this.checkObservedIdentity(health, session.handshake);
    return { health, realm: session.realm };
  }

  /** Force the existing client through a fresh authenticated handshake. */
  async reconnect(): Promise<RuntimeSession> {
    this.slot.current = null;
    return this.ensureSession();
  }

  /** Return the stable identity that may adopt recoverable local work. */
  async getRecoverableIdentity(): Promise<{ actorId: string; realmId: string }> {
    const { handshake, realm } = await this.ensureSession();
    if (realm.realm_id !== handshake.realm_id || !handshake.actor_id || !handshake.realm_id) {
      throw new RuntimeCompatibilityError('identity', 'Runtime recovery identity is incomplete or mismatched', this.baseUrl);
    }
    return { actorId: handshake.actor_id, realmId: handshake.realm_id };
  }

  private async openSession(allowDegradedHealth = false) {
    try {
      // Health and handshake are independent, so they share one round trip.
      // Validation below still runs in the original order; a rejection that loses
      // the race is observed here so it never surfaces as unhandled. The realm read
      // stays after validation: an incompatible Runtime is never asked for more.
      const healthRead = this.client.health();
      const handshakeRead = this.client.handshake('astrid-browser', RUNTIME_CLIENT_VERSION, RUNTIME_CLIENT_SCOPES)
        .catch((error: unknown) => {
          // Older owners and credentials keep normal use and command fallback.
          // Only the precise missing update grant permits a legacy negotiation.
          if (error instanceof ApiError && error.status === 401 && error.code === 'unauthorized'
            && Array.isArray(error.details.scopes) && error.details.scopes.length === 1
            && error.details.scopes[0] === 'installer:update') {
            return this.client.handshake('astrid-browser', RUNTIME_CLIENT_VERSION, LEGACY_RUNTIME_CLIENT_SCOPES);
          }
          throw error;
        });
      for (const pending of [healthRead, handshakeRead]) pending.catch(() => undefined);
      const health = await healthRead;
      if (health.status !== 'ok' && !(allowDegradedHealth && health.status === 'degraded')) {
        throw new ApiError(503, 'runtime_unhealthy', `Runtime health is ${health.status}`, '', { health });
      }
      const handshake = await handshakeRead;
      if (!RUNTIME_ACCEPTED_SCHEMA_DIGESTS.includes(health.schema_digest as typeof RUNTIME_ACCEPTED_SCHEMA_DIGESTS[number])
        || !RUNTIME_ACCEPTED_SCHEMA_DIGESTS.includes(handshake.schema_digest as typeof RUNTIME_ACCEPTED_SCHEMA_DIGESTS[number])) {
        throw new RuntimeCompatibilityError(
          'schema', `schema digest mismatch (health=${health.schema_digest}, handshake=${handshake.schema_digest}, expected one of ${RUNTIME_ACCEPTED_SCHEMA_DIGESTS.join(', ')})`,
          this.baseUrl,
        );
      }
      if (!handshake.capabilities.includes(RUNTIME_TARGETED_EXECUTION_CAPABILITY)) {
        throw new RuntimeCompatibilityError(
          'capability', `missing capability ${RUNTIME_TARGETED_EXECUTION_CAPABILITY}`,
          this.baseUrl,
        );
      }
      if (FORBIDDEN_RUNTIME_ACTORS.has(handshake.actor_id) || !hasExactScopes(handshake.scopes)) {
        throw new RuntimeCompatibilityError(
          'identity', 'authenticated actor or granted scopes do not match the Astrid App product connector role',
          this.baseUrl,
        );
      }
      if (this.expectedIdentity) {
        if (handshake.actor_id !== this.expectedIdentity.actorId
          || handshake.realm_id !== this.expectedIdentity.realmId) {
          throw new RuntimeCompatibilityError(
            'identity', 'authenticated actor or realm does not match the selected Astrid profile',
            this.baseUrl,
          );
        }
      }
      // Keep the selected launch binding across reconnects. A healthy replacement
      // process in the same realm is not permission to write the local draft.
      if (this.expectedIdentity
        && (health as Health & { runtime_instance_id?: string }).runtime_instance_id
          !== this.expectedIdentity.runtimeInstanceId) {
        throw new RuntimeCompatibilityError(
          'identity',
          'Runtime restarted—relaunch workspace. The selected Runtime instance changed; your timeline draft is preserved.',
          this.baseUrl,
        );
      }
      if (!this.expectedIdentity) this.checkObservedIdentity(health, handshake);
      const realm = await this.client.getRealm();
      if (realm.realm_id !== handshake.realm_id) {
        throw new RuntimeCompatibilityError('identity', 'Runtime realm endpoint does not match its handshake', this.baseUrl);
      }
      if (this.expectedIdentity && realm.realm_id !== this.expectedIdentity.realmId) {
        throw new RuntimeCompatibilityError(
          'identity', 'Runtime realm endpoint does not match the selected Astrid profile',
          this.baseUrl,
        );
      }
      if (!this.expectedIdentity) this.commitObservedIdentity(health, handshake);
      return { health, handshake, realm };
    } catch (error) {
      if (error instanceof RuntimeCompatibilityError) throw error;
      if (error instanceof ApiError && error.status === 401) {
        throw new RuntimeAuthenticationError(this.baseUrl);
      }
      throw new RuntimeUnavailableError(error, this.baseUrl);
    }
  }

  private async withSession<T>(operation: () => Promise<T>): Promise<T> {
    this.assertNotFenced();
    try {
      await this.ensureSession();
      return await operation();
    } catch (error) {
      // A restart can happen between reading discovery and reaching the proxy.
      // Retry a catalog read once with fresh discovery and a new handshake.
      this.signal?.throwIfAborted();
      if (this.readOnly && this.usesRuntimeConfig && runtimeOrigin() === ''
        && (error instanceof TypeError || error instanceof RuntimeUnavailableError
          || error instanceof RuntimeAuthenticationError
          || error instanceof RuntimeCompatibilityError && error.detail === RESTART_INSTANCE
          || error instanceof ApiError && (error.status === 401 || error.status >= 500))) {
        await this.reconnect();
        return operation();
      }
      if (error instanceof ApiError && error.status === 401) {
        this.slot.current = null;
        throw new RuntimeAuthenticationError(this.baseUrl);
      }
      throw error;
    }
  }

  /** Installer routes use the authenticated connector directly and deliberately skip workspace negotiation. */
  private async installerUpdateRequest(method: 'GET' | 'POST', path: string): Promise<Uint8Array> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let response: { status: number; headers: Record<string, string>; body: Uint8Array };
    if (this.transport) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new DOMException(method === 'GET' ? 'Installer update read timed out' : 'Installer update acknowledgement timed out; check status before another action', 'TimeoutError')), method === 'GET' ? 8000 : 30_000);
      const abortCaller = () => controller.abort(this.signal?.reason);
      if (this.signal?.aborted) abortCaller();
      else this.signal?.addEventListener('abort', abortCaller, { once: true });
      const interrupted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
      try {
        if (controller.signal.aborted) throw controller.signal.reason;
        response = await Promise.race([this.transport(method, path, headers, undefined), interrupted]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        this.signal?.removeEventListener('abort', abortCaller);
      }
    } else {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new DOMException(method === 'GET' ? 'Installer update read timed out' : 'Installer update acknowledgement timed out; check status before another action', 'TimeoutError')), method === 'GET' ? 8000 : 30_000);
      const abortCaller = () => controller.abort(this.signal?.reason);
      if (this.signal?.aborted) abortCaller();
      else this.signal?.addEventListener('abort', abortCaller, { once: true });
      try {
        const fetched = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
          method,
          headers,
          signal: controller.signal,
          ...(method === 'GET' ? { cache: 'no-store' as const } : {}),
        });
        response = {
          status: fetched.status,
          headers: Object.fromEntries(fetched.headers),
          body: new Uint8Array(await fetched.arrayBuffer()),
        };
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        this.signal?.removeEventListener('abort', abortCaller);
      }
    }
    const expected = method === 'POST' ? 202 : 200;
    if (response.status !== expected) {
      try {
        const value = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
        throw new ApiError(
          response.status,
          typeof value.code === 'string' ? value.code : 'http_error',
          typeof value.message === 'string' ? value.message : `HTTP ${response.status}`,
          typeof value.request_id === 'string' ? value.request_id : '',
          objectValue(value.details) ? value.details : {},
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(response.status, 'http_error', `HTTP ${response.status}`);
      }
    }
    return response.body;
  }

  /** Read status without schema handshake, and bypass all browser/proxy caches. */
  async readInstallerUpdateStatus(): Promise<InstallerUpdateStatus> {
    return validateInstallerUpdateStatus(JSON.parse(new TextDecoder().decode(
      await this.installerUpdateRequest('GET', '/v1/update/status'),
    )) as unknown);
  }

  /** Read the authenticated startup identity needed to classify the installation. */
  async readInstallerUpdateHealth(): Promise<InstallerUpdateHealth> {
    return validateInstallerUpdateHealth(JSON.parse(new TextDecoder().decode(
      await this.installerUpdateRequest('GET', '/v1/health'),
    )) as unknown);
  }

  /** Accept one update request. A lost acknowledgement is surfaced; this POST is never retried. */
  async startInstallerUpdate(): Promise<InstallerUpdateAcceptance> {
    if (this.readOnly) throw new RuntimeCompatibilityError('identity', 'A discovery client cannot start an update.', this.baseUrl);
    return validateInstallerUpdateAcceptance(JSON.parse(new TextDecoder().decode(
      await this.installerUpdateRequest('POST', '/v1/update'),
    )) as unknown);
  }

  async listProjects(): Promise<Project[]> {
    return this.coalescedRead('projects', async () => {
      const projects: Project[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.client.listProjects(cursor, 200);
        projects.push(...page.items);
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      return projects;
    });
  }

  async getProject(projectId: string): Promise<Project> {
    return this.withSession(() => this.client.getProject(projectId));
  }

  async selectProject(projectId: string, scope: 'workspace' | 'user' = 'workspace'): Promise<MutationResult<Record<string, unknown>>> {
    return this.withMutation(() => this.client.selectProject(projectId, scope, idempotencyKey()));
  }

  async createProject(
    name: string,
    idempotencyKey: string,
    slug?: string,
    metadata?: Record<string, unknown>,
  ): Promise<MutationResult<Project>> {
    return this.withMutation(() => this.client.createProject(name, idempotencyKey, slug, metadata));
  }

  async updateProject(
    projectId: string,
    idempotencyKey: string,
    expectedVersion: number,
    name: string | undefined,
    metadata: Record<string, unknown>,
  ): Promise<Project> {
    return this.withMutation(() => this.client.updateProject(
      projectId,
      idempotencyKey,
      expectedVersion,
      name,
      metadata,
    ));
  }

  async listTimelines(projectId: string): Promise<Record<string, unknown>[]> {
    return this.coalescedRead(JSON.stringify(['timelines', projectId]), async () => {
      const timelines: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.client.listTimelines(projectId, cursor, 200);
        timelines.push(...page.items);
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      return timelines;
    });
  }

  async renameTimeline(
    projectId: string,
    timelineId: string,
    name: string,
  ): Promise<MutationResult<Record<string, unknown>>> {
    return this.withMutation(() => this.client.renameTimeline(
      projectId,
      timelineId,
      name,
      idempotencyKey(),
    ));
  }

  /** One actor-owned app-state record (absent reads as version 0 with null content). */
  async getUserAppState(key: string) { return this.withSession(() => this.client.getUserAppState(key)); }
  async updateUserAppState(key: string, content: Record<string, unknown>, expectedVersion: number) {
    return this.withMutation(() => this.client.updateUserAppState(key, content, expectedVersion, idempotencyKey()));
  }

  async listDocuments(projectId: string, cursor?: string, limit = 50, kind?: string) { return this.withSession(() => this.client.listDocuments(projectId, cursor, limit, kind)); }
  async getDocument(projectId: string, documentId: string) { return this.withSession(() => this.client.getDocument(projectId, documentId)); }
  async getProjectVerifiedDocument(projectId: string, pin: DocumentPin) {
    const originalPin = { ...pin };
    return this.withRetainedRead((client) => client.getProjectVerifiedDocument(projectId, originalPin));
  }

  async getProjectVerifiedDocumentObject(projectId: string, pin: DocumentPin, objectId: string) {
    const originalPin = { ...pin };
    return this.withRetainedRead((client) => client.getProjectVerifiedDocumentObject(projectId, originalPin, objectId));
  }

  private async withRetainedRead<T>(read: (client: WorkspaceClient) => Promise<T>): Promise<T> {
    const base = this.baseUrl, client = this.client;
    return this.withSession(async () => {
      const slot = this.slot, opening = slot.current;
      const assertCurrent = () => {
        this.assertNotFenced();
        if (this.baseUrl !== base || this.client !== client || this.slot !== slot || slot.current !== opening) {
          throw new RuntimeCompatibilityError('identity', 'Retained input session changed; draft preserved', base);
        }
      };
      assertCurrent();
      const session = await opening!;
      this.checkObservedIdentity(session.health, session.handshake);
      assertCurrent();
      const result = await read(client);
      assertCurrent();
      this.checkObservedIdentity(session.health, session.handshake);
      return result;
    });
  }
  async createDocument(projectId: string, documentId: string, kind: string, content: unknown, key: string) { return this.withMutation(() => this.client.createDocument(projectId, documentId, kind, content, key)); }
  async updateDocument(projectId: string, documentId: string, version: number, content: unknown, key: string) { return this.withMutation(() => this.client.updateDocument(projectId, documentId, version, key, content)); }

  async getProjectTimeline(projectId: string, timelineId: string): Promise<Record<string, unknown>> {
    return this.coalescedRead(JSON.stringify(['timeline', projectId, timelineId]), () => this.client.getProjectTimeline(projectId, timelineId));
  }

  /**
   * Read the Runtime-owned canonical timeline head. Consumers that need the
   * shot-composition closure must begin here so a mutable legacy timeline
   * document cannot select the editor's authority by accident.
   */
  async inspectTimeline(
    projectId: string,
    timelineId: string,
    options: Record<string, unknown> = {},
  ): Promise<TimelineInspectionResult> {
    return this.coalescedRead(JSON.stringify(['inspect', projectId, timelineId, options]), async () => {
      const result = await this.client.inspectTimeline(projectId, timelineId, options);
      return result as unknown as TimelineInspectionResult;
    });
  }

  async commitTimeline(
    projectId: string,
    timelineId: string,
    request: CommitRequest,
    idempotencyKeyValue: string,
  ): Promise<CommitAcceptedMutation | CommitPreviewResponse> {
    return this.withMutation(() => this.client.commitTimeline(projectId, timelineId, request, idempotencyKeyValue));
  }

  async listTimelineCommits(
    projectId: string,
    timelineId: string,
    cursor?: string,
    limit = 50,
  ): Promise<HistoryPage> {
    return this.withSession(() => this.client.listTimelineCommits(projectId, timelineId, cursor, limit));
  }

  async createTimeline(
    projectId: string,
    timelineId: string,
    idempotencyKeyValue: string,
    name?: string,
  ): Promise<MutationResult<Record<string, unknown>>> {
    return this.withMutation(() => this.client.createTimeline(projectId, timelineId, idempotencyKeyValue, name));
  }

  async getProjectMediaSelection(
    projectId: string,
    selection: MediaSelectionQuery,
  ): Promise<MediaSelection> {
    return this.withSession(() => this.client.getProjectMediaSelection(projectId, selection));
  }

  async getProjectVerifiedMedia(
    projectId: string,
    selection: MediaSelection,
  ): Promise<VerifiedMedia> {
    return this.withSession(() => this.client.getProjectVerifiedMedia(projectId, selection));
  }

  async publishParentComposition(
    projectId: string,
    timelineId: string,
    publication: Record<string, unknown>,
    idempotencyKeyValue?: string,
  ): Promise<MutationResult<Record<string, unknown>>> {
    return this.withMutation(() => this.client.publishParentComposition(
      projectId,
      timelineId,
      publication,
      idempotencyKeyValue ?? idempotencyKey(),
    ));
  }

  async getProjectParentCompositionRevision(projectId: string, timelineId: string, revision: string): Promise<Record<string, unknown>> {
    return this.coalescedRead(JSON.stringify(['composition', projectId, timelineId, revision]), () => this.client.getProjectParentCompositionRevision(projectId, timelineId, revision));
  }

  async listProjectParentCompositionRevisions(projectId: string, timelineId: string, cursor?: string, limit = 50): Promise<Page<Record<string, unknown>>> {
    return this.withSession(() => this.client.listProjectParentCompositionRevisions(projectId, timelineId, cursor, limit));
  }

  async latestTimelineEditAt(projectId: string, timelineId: string): Promise<string | null> {
    const page = await this.withSession(() =>
      this.client.listProjectParentCompositionRevisions(projectId, timelineId, undefined, 1),
    );
    const createdAt = page.items[0]?.created_at;
    return typeof createdAt === 'string' ? createdAt : null;
  }

  async restoreProjectParentCompositionRevision(projectId: string, timelineId: string, revision: string, expectedHead: string, expectedPublicationId: string, key?: string): Promise<CommitAcceptedMutation> {
    return this.withMutation(() => this.client.restoreProjectParentCompositionRevision(
      projectId, timelineId, revision, expectedHead, expectedPublicationId, key ?? idempotencyKey(),
    ));
  }

  async getProjectShotRevision(projectId: string, shotId: string, revision: string): Promise<Record<string, unknown>> {
    return this.coalescedRead(JSON.stringify(['shot', projectId, shotId, revision]), () => this.client.getProjectShotRevision(projectId, shotId, revision));
  }

  async getProjectTimelineRevision(projectId: string, timelineId: string, revision: string): Promise<Record<string, unknown>> {
    return this.coalescedRead(JSON.stringify(['timeline-rev', projectId, timelineId, revision]), () => this.client.getProjectTimelineRevision(projectId, timelineId, revision));
  }

  async updateTimelineDocument(
    projectId: string,
    timelineId: string,
    expectedVersion: number,
    config: Record<string, unknown>,
    registry: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.withMutation(() => this.client.updateTimelineDocument(
      projectId,
      timelineId,
      expectedVersion,
      idempotencyKey(),
      config,
      registry,
    ));
  }

  async ingestProjectObject(
    projectId: string,
    data: RequestBody,
    mediaType: string,
    filename?: string,
  ) {
    return this.withMutation(() => this.client.ingestProjectObject(projectId, data, mediaType, idempotencyKey(), filename));
  }

  /** Commit an already Runtime-prepared import body (or target-project managed object reference). */
  async importTimeline(projectId: string, prepared: Record<string, unknown>, key = idempotencyKey()): Promise<MutationResult<Record<string, unknown>>> {
    return this.withMutation(() => this.client.importTimeline(projectId, prepared, key));
  }

  /** Project-scoped object authority check; the local path is never exposed. */
  async getProjectObjectLocation(projectId: string, objectId: string): Promise<ObjectLocation> {
    return this.withSession(() => this.client.getProjectObjectLocation(projectId, objectId));
  }
  async listProjectObjects(projectId: string, cursor?: string, limit = 50) {
    return this.withSession(() => this.client.listProjectObjects(projectId, cursor, limit));
  }
  async importProjectMedia(
    projectId: string,
    data: RequestBody,
    mediaType: string,
    idempotencyKey: string,
    filename?: string,
    expectedDigest?: string,
    width?: number,
    height?: number,
    durationSeconds?: number,
  ): Promise<MediaImport> {
    return this.withMutation(() => this.client.importProjectMedia(
      projectId,
      data,
      mediaType,
      idempotencyKey,
      { filename, expectedDigest, width, height, durationSeconds },
    ));
  }

  async getProjectMediaImport(projectId: string, importOperationId: string): Promise<MediaImport> {
    return this.withSession(() => this.client.getProjectMediaImport(projectId, importOperationId));
  }

  /** Canonical Runtime generation page; the opaque cursor is caller-owned. */
  async listGenerations(projectId: string, cursor?: string, limit = 50): Promise<Page<Generation>> {
    return this.withSession(() => this.client.listGenerations(projectId, cursor, limit));
  }

  async getGeneration(generationId: string): Promise<Generation> {
    return this.withSession(() => this.client.getGeneration(generationId));
  }

  /** Canonical Runtime variant page; the opaque cursor is caller-owned. */
  async listVariants(generationId: string, cursor?: string, limit = 50): Promise<Page<GenerationVariant>> {
    return this.withSession(() => this.client.listVariants(generationId, cursor, limit));
  }

  async markVariantViewed(variantId: string): Promise<MutationResult<GenerationVariant>> {
    return this.withMutation(() => this.client.markVariantViewed(variantId, idempotencyKey()));
  }

  async markGenerationVariantsViewed(generationId: string): Promise<MutationResult<Record<string, unknown>>> {
    return this.withMutation(() => this.client.markGenerationVariantsViewed(generationId, idempotencyKey()));
  }

  /** Capability discovery is read-only and supplies the digest for admission. */
  async listCapabilities(cursor?: string, limit = 50): Promise<Page<Capability>> {
    return this.withSession(() => this.client.listCapabilities(cursor, limit));
  }

  /** Browser admission only. Claim, execution, and settlement remain host-owned. */
  async admitTask(
    input: Parameters<WorkspaceClient['admitTask']>[0],
    admissionKey: string,
  ): Promise<MutationResult<Task>> {
    return this.withMutation(() => this.client.admitTask(input, admissionKey));
  }

  async getTask(taskId: string): Promise<Task> {
    return this.withSession(() => this.client.getTask(taskId));
  }

  async listProjectTasks(projectId: string, cursor?: string, limit = 50): Promise<Page<Task>> {
    return this.withSession(() => this.client.listProjectTasks(projectId, cursor, limit));
  }

  /** Read the global event feed through the restart-fenced Runtime session. */
  async listEvents(cursor?: string, fromLatest = false): Promise<Page<Event>> {
    return this.withSession(() => this.client.listEvents(cursor, 50, undefined, fromLatest ? 'latest' : undefined));
  }

  /** Read lifecycle events for one task without exposing raw event payloads to callers. */
  async listTaskEvents(taskId: string, cursor?: string, limit = 50): Promise<Page<Event>> {
    return this.withSession(() => this.client.listEvents(cursor, limit, taskId));
  }

  async cancelTask(taskId: string, admissionKey: string, expectedVersion?: number): Promise<MutationResult<Task>> {
    return this.withMutation(() => this.client.cancelTask(taskId, admissionKey, expectedVersion));
  }

  async retryTask(taskId: string, admissionKey: string, expectedVersion?: number): Promise<MutationResult<Task>> {
    return this.withMutation(() => this.client.retryTask(taskId, admissionKey, expectedVersion));
  }

  /** Canonical managed-output associations for one completed task. */
  async listManagedOutputs(taskId: string, cursor?: string, limit = 50): Promise<Page<ManagedOutput>> {
    return this.withSession(() => this.client.listManagedOutputs(taskId, cursor, limit));
  }

  /** Canonical readback of one managed-output association. */
  async getManagedOutput(associationId: string): Promise<ManagedOutput> {
    return this.withSession(() => this.client.getManagedOutput(associationId));
  }

  /** Export one selected Runtime-managed output; Runtime owns the destination and receipt. */
  async exportManagedOutput(
    associationId: string,
    destinationFilename: string,
    expected?: Record<string, unknown>,
  ): Promise<MutationResult<ManagedOutputExportReceipt>> {
    return this.withMutation(() => this.client.exportManagedOutput(
      associationId,
      destinationFilename,
      idempotencyKey(),
      expected,
    ));
  }

  /** Read a Runtime-owned thumbnail selected from a source video frame. */
  async getSourceFrameThumbnail(
    projectId: string,
    sourceObjectId: string,
    sourceTimeSeconds: number,
    recipeVersion = 1,
  ): Promise<Record<string, unknown> | null> {
    return this.withSession(() => this.client.getSourceFrameThumbnail(
      projectId,
      sourceObjectId,
      sourceTimeSeconds,
      recipeVersion,
    ));
  }

  /** Ensure a typed source-frame thumbnail relation exists, idempotently. */
  async ensureSourceFrameThumbnail(
    projectId: string,
    thumbnail: Record<string, unknown>,
    idempotencyKeyValue: string,
  ): Promise<MutationResult<Record<string, unknown>>> {
    return this.withMutation(() => this.client.ensureSourceFrameThumbnail(
      projectId,
      thumbnail,
      idempotencyKeyValue,
    ));
  }

  /** Authenticated generated Runtime media read with optional byte range. */
  async getObject(objectId: string, byteRange?: [number, number?]): Promise<ByteResponse> {
    return this.withSession(() => this.client.getObject(objectId, byteRange));
  }

  /** Authenticated generated Runtime media metadata read with optional range. */
  async headObject(objectId: string, byteRange?: [number, number?]): Promise<ByteResponse> {
    return this.withSession(() => this.client.headObject(objectId, byteRange));
  }

  objectContentUrl(objectId: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/v1/objects/${encodeURIComponent(objectId)}`;
  }
}

function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `astrid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export { PROTOCOL };

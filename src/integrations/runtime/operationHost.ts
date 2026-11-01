import { AstridRuntimeClient, initializeWorkspaceRuntimeIdentity, RUNTIME_CLIENT_SCOPES, type RuntimeIdentityBinding } from './client.ts';
import { runtimeApiBase, runtimeOrigin } from './connection.ts';
import { RUNTIME_ACCEPTED_SCHEMA_DIGESTS, RUNTIME_TARGETED_EXECUTION_CAPABILITY } from './contract-metadata.ts';
import { decodeAcceptedTimelineCommit } from './dataProvider.ts';
import {
  ApiError,
  PROTOCOL,
  type CommitAcceptedMutation,
  type Task,
  type Transport,
  WorkspaceClient,
} from './generated.ts';
import type { OutboxRequest, OutboxScope } from '@/tools/video-editor/commands/commitOutbox.ts';

const OPERATION_PATH = '/runtime-config/v1/operation';
const HANDLE_HEADER = 'X-Astrid-Operation-Handle';
const scopes = [...RUNTIME_CLIENT_SCOPES].sort();
const forbiddenActors = new Set(['owner', 'astrid-pack-host', 'admin', 'worker']);
type Identity = Pick<RuntimeIdentityBinding, 'actorId' | 'realmId'>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid operation response');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid operation identity');
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Invalid Runtime grants');
  return value;
}
function identity(value: unknown): RuntimeIdentityBinding {
  const v = record(value);
  return { actorId: text(v.actorId), realmId: text(v.realmId), runtimeInstanceId: text(v.runtimeInstanceId) };
}
function equal(a: RuntimeIdentityBinding, b: RuntimeIdentityBinding): boolean {
  return a.actorId === b.actorId && a.realmId === b.realmId && a.runtimeInstanceId === b.runtimeInstanceId;
}
function pathAllowed(path: string): boolean {
  if (!path.startsWith('/v1/') || /[\\#\s]/.test(path)) return false;
  try {
    const url = new URL(path, 'http://operation.invalid');
    return url.pathname === path.split('?')[0]
      && !decodeURIComponent(url.pathname).split('/').some(part => part === '.' || part === '..' || /[\\/]/.test(part));
  } catch { return false; }
}

/**
 * Inactive same-origin owner. The captured fetch must dispatch immediately with the supplied
 * target/options: delayed forwarding wrappers or hidden target reselection are unsupported.
 * Local retirement cannot observe silent remote invalidation or undo an already sent request.
 */
export class RuntimeOperationHost {
  private current?: { retire(): void; handle?: string };
  private disposed = false;
  private expected?: RuntimeIdentityBinding;
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.fetchImpl = fetchImpl;
  }

  dispose(): void {
    this.disposed = true;
    this.current?.retire();
    this.current = undefined;
  }

  reconnect() { return this.bind(); }

  async bind() {
    const predecessor = this.current?.handle;
    this.current?.retire();
    this.current = undefined;
    if (this.disposed || runtimeOrigin() !== '') {
      throw new Error('Operation transport requires an active same-origin workspace');
    }
    const base = runtimeApiBase();
    const controller = new AbortController();
    const fetchImpl = this.fetchImpl;
    let retired = false;
    let negotiated: Identity | undefined;
    let taskSubmission: { request: OutboxRequest; assertCurrent(): void } | undefined;
    const currentTaskSubmission = () => {
      // A released editor claim makes even a still-pending POST uncertain.
      try { taskSubmission?.assertCurrent(); }
      catch { taskSubmission = undefined; }
      return taskSubmission;
    };
    const options = (method: string, handle?: string): RequestInit => ({
      method, cache: 'no-store', mode: 'same-origin', credentials: 'omit', redirect: 'error',
      signal: controller.signal,
      headers: handle ? { [HANDLE_HEADER]: handle } : {},
    });
    const cleanup = (handle: string) => {
      // Cleanup owns a fresh signal: retirement has already aborted the data requests.
      try {
        void fetchImpl(OPERATION_PATH, { ...options('DELETE', handle), signal: new AbortController().signal }).catch(() => undefined);
      } catch { /* Cleanup cannot restore or interrupt local retirement. */ }
    };
    const binding: { retire(): void; handle?: string } = {
      retire() {
        if (retired) return;
        retired = true;
        negotiated = undefined;
        taskSubmission = undefined;
        controller.abort();
        if (binding.handle) cleanup(binding.handle);
      },
    };
    this.current = binding;
    const active = () => {
      if (retired || this.disposed || this.current !== binding || runtimeOrigin() !== '' || runtimeApiBase() !== base) {
        binding.retire();
        throw new Error('Runtime operation retired; exact request outcome may be unknown');
      }
    };
    try {
      // This is the existing page launch/config seam, never the new acquire metadata.
      const selected = await initializeWorkspaceRuntimeIdentity();
      active();
      if (!selected) throw new Error('Workspace launch identity is required for operation transport');
      const policy = identity(selected);
      if (this.expected && !equal(this.expected, policy)) throw new Error('Workspace launch identity changed; relaunch required');
      this.expected ??= policy;
      const expected = { ...this.expected };
      active();
      const acquired = await fetchImpl(OPERATION_PATH, {
        ...options('POST', predecessor),
        headers: { ...(predecessor ? { [HANDLE_HEADER]: predecessor } : {}), 'Content-Type': 'application/json' }, body: '{}',
      });
      try { active(); } catch (error) {
        // A late acquisition may only be consumed for cleanup; it never installs a successor.
        void acquired.json().then(value => {
          const handle = record(value).handle;
          if (typeof handle === 'string' && /^[0-9a-f]{64}$/.test(handle)) cleanup(handle);
        }).catch(() => undefined);
        throw error;
      }
      const acquiredValue = record(await acquired.json());
      const handle = text(acquiredValue.handle);
      if (!/^[0-9a-f]{64}$/.test(handle)) throw new Error('Invalid operation handle');
      binding.handle = handle;
      if (retired) cleanup(handle);
      active();
      if (acquired.status !== 201 || acquiredValue.schemaVersion !== 1 || !equal(identity(acquiredValue.identity), expected)) {
        throw new Error('Operation selection does not match workspace launch identity');
      }
      let healthDigest: string | undefined;
      let handshakeDigest: string | undefined;
      let authenticated: Identity | undefined;
      let realmId: string | undefined;
      const validateAuthority = (path: string, bytes: Uint8Array) => {
        if (!['/v1/health', '/v1/handshake', '/v1/realm'].includes(path)) return;
        const value = record(JSON.parse(new TextDecoder().decode(bytes)));
        if (path === '/v1/realm') {
          realmId = text(value.realm_id);
          if (realmId !== expected.realmId) throw new Error('Runtime realm changed');
          return;
        }
        const digest = text(value.schema_digest);
        if (value.protocol !== PROTOCOL || !RUNTIME_ACCEPTED_SCHEMA_DIGESTS.some(accepted => accepted === digest)) {
          throw new Error('Incompatible Runtime protocol or schema');
        }
        if (path === '/v1/health') {
          if (value.status !== 'ok' || text(value.runtime_instance_id) !== expected.runtimeInstanceId) {
            throw new Error('Runtime restarted or unhealthy; relaunch required');
          }
          healthDigest = digest;
        } else {
          const actorId = text(value.actor_id);
          const granted = [...strings(value.scopes)].sort();
          if (actorId !== expected.actorId || forbiddenActors.has(actorId) || text(value.realm_id) !== expected.realmId
            || granted.length !== scopes.length || granted.some((scope, index) => scope !== scopes[index])
            || !strings(value.capabilities).includes(RUNTIME_TARGETED_EXECUTION_CAPABILITY)) {
            throw new Error('Invalid Astrid App product authority');
          }
          handshakeDigest = digest;
          authenticated = { actorId, realmId: expected.realmId };
        }
        if (healthDigest && handshakeDigest && healthDigest !== handshakeDigest) throw new Error('Runtime schema changed during negotiation');
      };
      const transport: Transport = async (method, path, headers, body) => {
        try {
          active();
          if (!pathAllowed(path)) throw new Error('Invalid operation Runtime path');
          const requestHeaders = new Headers(headers);
          if (requestHeaders.has('Authorization') || requestHeaders.has(HANDLE_HEADER)) throw new Error('Unexpected operation credential');
          requestHeaders.set(HANDLE_HEADER, handle);
          active();
          const response = await fetchImpl(`${OPERATION_PATH}/runtime${path}`, {
            ...options(method), headers: requestHeaders, body: body as BodyInit | undefined,
          });
          active();
          if ([401, 403, 410].includes(response.status) || response.status >= 500) throw new Error('Runtime operation unavailable; exact request outcome may be unknown');
          const bytes = new Uint8Array(await response.arrayBuffer());
          active();
          // Capture authenticated bytes before generated handshakeInfo assignment or another await.
          if (response.ok) validateAuthority(path, bytes);
          const responseHeaders: Record<string, string> = {};
          response.headers.forEach((value, key) => { responseHeaders[key] = value; });
          return { status: response.status, headers: responseHeaders, body: bytes };
        } catch (error) { binding.retire(); throw error; }
      };
      const client = new AstridRuntimeClient({ baseUrl: base, transport, expectedIdentity: { ...expected }, identityStore: new Map() });
      await client.ensureSession();
      // The generated client is transport-only here: negotiation and identity
      // remain owned by the operation above, so this cannot rediscover a session.
      const generated = new WorkspaceClient(base, undefined, transport);
      active();
      if (!authenticated || !healthDigest || !handshakeDigest || realmId !== authenticated.realmId) throw new Error('Incomplete operation negotiation');
      negotiated = { ...authenticated };
      const run = async <T>(operation: () => Promise<T>): Promise<T> => {
        active();
        try {
          const result = await operation();
          active();
          return result;
        } catch (error) {
          if (!(error instanceof ApiError) || error.status >= 500 || [401, 403, 410].includes(error.status)) binding.retire();
          throw error;
        }
      };
      const isCurrentIdentity = (expectedIdentity: Identity): boolean => {
        try { active(); } catch { return false; }
        return !!negotiated && negotiated.actorId === expectedIdentity.actorId && negotiated.realmId === expectedIdentity.realmId;
      };
      const admitPreparedTask = (request: OutboxRequest) => run(async () => {
        const saved = { ...request };
        if (saved.method !== 'POST' || saved.path !== '/v1/tasks' || !text(saved.key)) {
          throw new Error('Exact task admission request is not canonical');
        }
        const response = await transport(saved.method, saved.path, {
          Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': saved.key,
        }, new TextEncoder().encode(saved.body));
        if (response.status !== 200 && response.status !== 201) {
          const value = record(JSON.parse(new TextDecoder().decode(response.body)));
          throw new ApiError(response.status, typeof value.code === 'string' ? value.code : 'http_error',
            typeof value.message === 'string' ? value.message : 'Runtime task admission failed', '',
            value.details as Record<string, unknown> | undefined);
        }
        const value = record(JSON.parse(new TextDecoder().decode(response.body)));
        if (!value.data || !value.receipt) throw new Error('Invalid task admission response');
        return record(value.data) as unknown as Task;
      });
      return Object.freeze({
        retire: () => binding.retire(),
        isCurrentIdentity,
        // Covers reservation through locator persistence, not just the HTTP POST.
        beginTaskSubmission(request: OutboxRequest, assertCurrent: () => void) {
          active();
          assertCurrent();
          if (currentTaskSubmission()) throw new Error('Original task submission is still active');
          const pending = { request: { ...request }, assertCurrent };
          taskSubmission = pending;
          return () => { if (taskSubmission === pending) taskSubmission = undefined; };
        },
        isTaskSubmissionActive(request: OutboxRequest) {
          const pending = currentTaskSubmission()?.request;
          return !!pending && pending.method === request.method && pending.path === request.path
            && pending.key === request.key && pending.body === request.body;
        },
        getRecoverableIdentity: () => run(async () => {
          active();
          if (!negotiated) throw new Error('Operation is not negotiated');
          return { ...negotiated };
        }),
        admitTask: (...args: Parameters<AstridRuntimeClient['admitTask']>) => run(() => client.admitTask(...args)),
        getTask: (...args: Parameters<AstridRuntimeClient['getTask']>) => run(() => client.getTask(...args)),
        listManagedOutputs: (...args: Parameters<AstridRuntimeClient['listManagedOutputs']>) => run(() => client.listManagedOutputs(...args)),
        getManagedOutput: (...args: Parameters<AstridRuntimeClient['getManagedOutput']>) => run(() => client.getManagedOutput(...args)),
        getProjectMediaSelection: (...args: Parameters<AstridRuntimeClient['getProjectMediaSelection']>) => run(() => client.getProjectMediaSelection(...args)),
        getProjectVerifiedMedia: (...args: Parameters<WorkspaceClient['getProjectVerifiedMedia']>) => run(() => generated.getProjectVerifiedMedia(...args)),
        listCapabilities: (...args: Parameters<WorkspaceClient['listCapabilities']>) => run(() => generated.listCapabilities(...args)),
        listProjectObjects: (...args: Parameters<WorkspaceClient['listProjectObjects']>) => run(() => generated.listProjectObjects(...args)),
        getObject: (...args: Parameters<AstridRuntimeClient['getObject']>) => run(() => client.getObject(...args)),
        headObject: (...args: Parameters<AstridRuntimeClient['headObject']>) => run(() => client.headObject(...args)),
        admitPreparedTask,
        transmit: (scope: OutboxScope, saved: OutboxRequest) => {
          const request = { ...saved };
          const selectedScope = { ...scope };
          return run(async () => {
            if (!isCurrentIdentity(selectedScope) || request.method !== 'POST' || !text(request.key)
              || request.path !== `/v1/projects/${encodeURIComponent(text(selectedScope.projectId))}/timelines/${encodeURIComponent(text(selectedScope.timelineId))}/commit`) {
              throw new Error('Exact request scope does not match operation');
            }
            const payload = record(JSON.parse(request.body));
            if (payload.project_id !== selectedScope.projectId || payload.timeline_id !== selectedScope.timelineId || payload.dry_run === true) {
              throw new Error('Exact request body does not match saved scope');
            }
            // Preserve the ordinary client's pre-write instance fence on the same transport.
            const health = await transport('GET', '/v1/health', {});
            if (health.status !== 200) throw new Error('Runtime health unavailable');
            active();
            const response = await transport(request.method, request.path, {
              Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': request.key,
            }, new TextEncoder().encode(request.body));
            active();
            const value = record(JSON.parse(new TextDecoder().decode(response.body)));
            if (response.status !== 200) throw new ApiError(response.status, typeof value.code === 'string' ? value.code : 'http_error',
              typeof value.message === 'string' ? value.message : 'Runtime commit failed', '', value.details as Record<string, unknown> | undefined);
            const result = decodeAcceptedTimelineCommit(value as unknown as CommitAcceptedMutation, selectedScope.projectId, selectedScope.timelineId);
            active();
            return result;
          });
        },
      });
    } catch (error) { binding.retire(); throw error; }
  }
}

export type RuntimeOperation = Awaited<ReturnType<RuntimeOperationHost['bind']>>;

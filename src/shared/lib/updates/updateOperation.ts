import { AstridRuntimeClient, type InstallerUpdateStatus, type InstallerUpdateHealth } from '@/integrations/runtime/client.ts';
import { ApiError } from '@/integrations/runtime/generated.ts';
import type { UpdateStatus } from './updateStatus.ts';
import { checkHostedUpdate } from './updateStatus.ts';

export interface UpdateOperationSnapshot {
  readonly health: InstallerUpdateHealth | null;
  readonly status: InstallerUpdateStatus | null;
  readonly releaseStatus: UpdateStatus | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly fresh: boolean;
  readonly restartRequired: boolean;
}

/** Page-owned operation, independent of any mounted notice or Settings panel. */
export class UpdateOperation {
  private snapshot: UpdateOperationSnapshot = { health: null, status: null, releaseStatus: null, pending: false, error: null, fresh: false, restartRequired: false };
  private listeners = new Set<() => void>();
  private reading: Promise<void> | null = null;
  private posting = false;
  private uncertain = false;
  private operationId: string | null = null;
  private releaseIdentity: string | null = null;
  private acknowledgementBaseline: string | undefined;
  private refusal: string | null = null;
  constructor(private readonly client = new AstridRuntimeClient()) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<UpdateOperationSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  refresh = (checkRelease = false): Promise<void> => {
    if (checkRelease) this.releaseIdentity = null;
    if (this.reading) return this.reading;
    this.reading = this.read().finally(() => { this.reading = null; });
    return this.reading;
  };
  private async read() {
    try {
      const [healthRead, statusRead] = await Promise.allSettled([this.client.readInstallerUpdateHealth(), this.client.readInstallerUpdateStatus()]);
      if (healthRead.status === 'rejected') throw healthRead.reason;
      const health = healthRead.value;
      if (this.snapshot.health && health.runtime_instance_id !== this.snapshot.health.runtime_instance_id) this.publish({ restartRequired: true });
      this.publish({ health });
      // Release ordering is independent of the F1 route. Older Runtimes can
      // report an installed release even when status is absent or denied;
      // K6 must still suppress a downgrade prompt on those installations.
      if (statusRead.status === 'rejected') this.publish({ fresh: false, error: statusRead.reason instanceof Error ? statusRead.reason.message : 'Update status could not be read.' });
      const identity = JSON.stringify([health.runtime_instance_id, health.release]);
      if (this.releaseIdentity !== identity || !this.snapshot.releaseStatus) {
        try {
          const releaseStatus = await checkHostedUpdate(health);
          this.releaseIdentity = identity;
          this.publish({ releaseStatus });
        } catch {
          // Release checks cannot manufacture a success or an executable action.
          this.publish({ releaseStatus: null });
        }
      }
      if (statusRead.status === 'rejected') throw statusRead.reason;
      const status = statusRead.value;
      if (this.operationId && status.operation_id !== this.operationId) {
        this.publish({ health, status: null, fresh: false, error: 'Update status does not match this request. Check again before taking another action.' });
        return;
      }
      // An unknown acknowledgement cannot be resolved by an old terminal result.
      if (this.uncertain && (!status.operation_id || status.operation_id === this.acknowledgementBaseline)) {
        this.publish({ health, status: null, fresh: false, error: 'The update acknowledgement was lost. Its result is not confirmed; check again before taking another action.' });
        return;
      }
      if (status.operation_id && (status.state === 'active' || this.uncertain)) {
        this.operationId = status.operation_id;
        this.uncertain = false;
      }
      const pending = this.posting || status.state === 'active';
      this.publish({ health, status, pending, fresh: true, error: this.refusal });
    } catch (cause) {
      this.publish({ fresh: false, error: cause instanceof Error ? cause.message : 'Update status could not be read.' });
    }
  }
  start = async (): Promise<void> => {
    if (this.posting || this.snapshot.pending || !this.snapshot.fresh || !this.snapshot.status?.available) return;
    this.posting = true;
    this.refusal = null;
    this.operationId = null;
    this.acknowledgementBaseline = this.snapshot.status.operation_id;
    this.publish({ pending: true, error: null });
    try {
      const accepted = await this.client.startInstallerUpdate();
      this.operationId = accepted.operation_id;
      this.publish({ status: { available: true, state: 'active', operation_id: accepted.operation_id, result: accepted.message } });
    } catch (cause) {
      // Never retry a POST, even when its acknowledgement never arrived.
      const definiteRefusal = cause instanceof ApiError && cause.status >= 400 && cause.status < 500
        && !String(cause.details?.reason).includes('acknowledgement-unknown');
      this.uncertain = !definiteRefusal;
      const error = cause instanceof Error ? cause.message : 'Update acknowledgement was lost. Check update status.';
      if (definiteRefusal) this.refusal = error;
      this.publish({ pending: !definiteRefusal, fresh: false, error });
    } finally {
      this.posting = false;
      await this.refresh();
    }
  };
}

const operations = new WeakMap<typeof fetch, Map<string, UpdateOperation>>();
export function pageUpdateOperation(base: string): UpdateOperation {
  let byBase = operations.get(fetch);
  if (!byBase) operations.set(fetch, byBase = new Map());
  let operation = byBase.get(base);
  if (!operation) byBase.set(base, operation = new UpdateOperation());
  return operation;
}

export type LocalPageRefusal = 'update_busy' | 'non_fast_forward' | 'dirty';
export const LOCAL_PAGE_REFUSAL_MESSAGES: Record<LocalPageRefusal, string> = {
  update_busy: 'Another Astrid update is already running. Wait for it to finish, or update another way.',
  non_fast_forward: 'This checkout has local commits that Astrid cannot fast-forward over. Update another way.',
  dirty: 'Your local edits overlap files in this update. Astrid left them untouched; update another way.',
};

export type LocalPageUpdateState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running' }
  | { readonly phase: 'done'; readonly status: 'updated' | 'up-to-date' | 'recovered'; readonly message: string }
  | { readonly phase: 'refused'; readonly refusal: LocalPageRefusal; readonly message: string }
  | { readonly phase: 'failed'; readonly message: string };

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' } as const;
const REFUSALS = new Set<string>(['update_busy', 'non_fast_forward', 'dirty']);

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json().catch(() => null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

/**
 * Settings "Update now" for the fully-local path. The Vite server hands over
 * the launcher's page url and secret from its 0600 receipt; the launcher does
 * the fenced update and relaunch, so its reply outlives the editor restart.
 * One POST per click, never retried.
 */
export class LocalPageUpdate {
  private state: LocalPageUpdateState = { phase: 'idle' };
  private listeners = new Set<() => void>();
  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(state: LocalPageUpdateState): LocalPageUpdateState {
    this.state = state;
    this.listeners.forEach((listener) => listener());
    return state;
  }
  reset = () => { if (this.state.phase !== 'running') this.set({ phase: 'idle' }); };

  start = async (): Promise<LocalPageUpdateState> => {
    if (this.state.phase === 'running') return this.state;
    this.set({ phase: 'running' });
    let target: { url: string; token: string };
    try {
      const response = await this.fetchImpl('/__astrid/local-update-page', { method: 'POST', body: '', cache: 'no-store', redirect: 'error', headers: JSON_HEADERS, signal: AbortSignal.timeout(8000) });
      const body = await readJson(response);
      if (!response.ok || typeof body.url !== 'string' || typeof body.token !== 'string') throw new Error('The update launcher is not available.');
      target = { url: body.url, token: body.token };
    } catch (cause) {
      return this.set({ phase: 'failed', message: cause instanceof Error ? cause.message : 'The update launcher is not available.' });
    }
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    try {
      // No timeout: preparation can take minutes and the launcher owns recovery.
      const response = await this.fetchImpl(target.url, { method: 'POST', cache: 'no-store', redirect: 'error', headers: { ...JSON_HEADERS, Authorization: `Bearer ${target.token}` }, body: JSON.stringify({ requestId }) });
      const body = await readJson(response);
      if (response.status === 409 && typeof body.refusal === 'string' && REFUSALS.has(body.refusal)) {
        const refusal = body.refusal as LocalPageRefusal;
        return this.set({ phase: 'refused', refusal, message: LOCAL_PAGE_REFUSAL_MESSAGES[refusal] });
      }
      const result = body.result as { status?: unknown; message?: unknown } | undefined;
      if (response.ok && result && (result.status === 'updated' || result.status === 'up-to-date' || result.status === 'recovered')) {
        return this.set({ phase: 'done', status: result.status, message: typeof result.message === 'string' ? result.message : '' });
      }
      return this.set({ phase: 'failed', message: typeof body.error === 'string' ? body.error : 'The update did not complete.' });
    } catch {
      return this.set({ phase: 'failed', message: 'The update result could not be confirmed. Check for updates before trying again.' });
    }
  };
}

let localPageUpdate: LocalPageUpdate | undefined;
/** Page-owned, so progress survives closing Settings. */
export function pageLocalUpdate(): LocalPageUpdate {
  return localPageUpdate ??= new LocalPageUpdate();
}

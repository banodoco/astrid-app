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

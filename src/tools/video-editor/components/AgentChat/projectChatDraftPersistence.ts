import { registerDraftSafeReloadGuard } from '@/shared/lib/updates/draftSafeReload.ts';

export type ProjectDraftSnapshot<T> = { text: string; queue: T[] };

export function sameProjectDraft<T>(left: ProjectDraftSnapshot<T>, right: ProjectDraftSnapshot<T>): boolean {
  return left.text === right.text && JSON.stringify(left.queue) === JSON.stringify(right.queue);
}

/** What a draft write reports: the new revision, optionally with the snapshot actually written (after a rebase). */
export type DraftWriteResult<T> = number | { revision: number; snapshot: ProjectDraftSnapshot<T> };

/**
 * Three-way union of queued rows by id. `base` is the last queue this composer knew was saved, `remote` is the
 * server's current queue, `local` is what this composer holds. A row that was in `base` and is gone from `remote`
 * was sent or removed elsewhere, so it is dropped (never resurrected into a second send); a row that is new on
 * either side is kept. Local order wins; rows only the server has follow.
 */
export function mergeQueues<R extends { id: string }>(base: R[], remote: R[], local: R[]): R[] {
  const baseIds = new Set(base.map(row => row.id));
  const remoteIds = new Set(remote.map(row => row.id));
  const kept = local.filter(row => remoteIds.has(row.id) || !baseIds.has(row.id));
  const keptIds = new Set(kept.map(row => row.id));
  return [...kept, ...remote.filter(row => !keptIds.has(row.id) && !baseIds.has(row.id))];
}

/** One local composer lifetime, retained while its last save finishes after unmount. */
export class ProjectChatDraftPersistence<T> {
  mounted = true;
  private chain: Promise<void> = Promise.resolve();
  private requested = 0;
  private acknowledgedThrough = 0;
  private inflight = 0;
  private activeWriteRequest: number | null = null;
  private latest: ProjectDraftSnapshot<T>;
  private writer: ((snapshot: ProjectDraftSnapshot<T>) => Promise<void>) | null = null;
  private unregisterReloadGuard: (() => void) | null = null;

  constructor(public revision: number, public saved: ProjectDraftSnapshot<T>) {
    this.latest = saved;
  }

  /** No save is queued or running: the saved base is exactly what this composer last wrote or read. */
  get idle(): boolean { return this.inflight === 0; }
  get current(): ProjectDraftSnapshot<T> { return this.latest; }

  /** Keep this project's latest draft and a project-bound durable writer owned across component lifetimes. */
  track(snapshot: ProjectDraftSnapshot<T>, writer: (snapshot: ProjectDraftSnapshot<T>) => Promise<void>): void {
    this.latest = snapshot;
    this.writer = writer;
    this.syncReloadGuard();
  }

  private get dirty(): boolean {
    return !this.idle || !sameProjectDraft(this.latest, this.saved);
  }

  private syncReloadGuard(): void {
    if (this.dirty && !this.unregisterReloadGuard && this.writer) {
      this.unregisterReloadGuard = registerDraftSafeReloadGuard({
        label: 'Agent chat',
        flush: () => this.flushLatest(),
        isDirty: () => this.dirty,
      });
    } else if (!this.dirty && this.unregisterReloadGuard) {
      this.unregisterReloadGuard();
      this.unregisterReloadGuard = null;
    }
  }

  /** Flush the current version, then recheck for edits and writes that arrived during the flush. */
  private async flushLatest(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const snapshot = this.latest;
      const writer = this.writer;
      if (!writer) {
        if (!this.dirty) return;
        throw new Error('the draft has not finished loading and cannot be saved yet');
      }
      if (!this.idle || !sameProjectDraft(snapshot, this.saved)) await writer(snapshot);
      if (this.idle && sameProjectDraft(this.latest, this.saved)) {
        this.syncReloadGuard();
        return;
      }
    }
    throw new Error('the draft kept changing while it was being saved');
  }

  /** Take another client's newer draft as this composer's base (the caller has checked the composer is idle). */
  adopt(revision: number, saved: ProjectDraftSnapshot<T>): void {
    this.revision = revision;
    this.saved = saved;
    this.latest = saved;
    this.acknowledgedThrough = this.activeWriteRequest === null ? this.requested : this.activeWriteRequest - 1;
    this.syncReloadGuard();
  }

  observe(revision: number, saved: ProjectDraftSnapshot<T>, local: ProjectDraftSnapshot<T>): void {
    // Never give divergent unsaved text a newer CAS token. Only an unchanged
    // base or an exact acknowledgement can safely advance this composer's base.
    if (revision > this.revision && (sameProjectDraft(saved, this.saved) || sameProjectDraft(saved, local))) {
      this.revision = revision;
      this.saved = saved;
      if (sameProjectDraft(saved, local)) {
        // A snapshot observed while a write is running does not prove that the
        // in-flight older write cannot land after it. Leave later requests queued.
        this.acknowledgedThrough = this.activeWriteRequest === null ? this.requested : this.activeWriteRequest - 1;
      }
      this.syncReloadGuard();
    }
  }

  save(snapshot: ProjectDraftSnapshot<T>, write: (revision: number) => Promise<DraftWriteResult<T>>): Promise<void> {
    const request = ++this.requested;
    this.inflight++;
    if (sameProjectDraft(this.latest, this.saved) || sameProjectDraft(this.latest, snapshot)) this.latest = snapshot;
    this.syncReloadGuard();
    const pending = this.chain.catch(() => undefined).then(async () => {
      // An exact acknowledgement of newer local text supersedes older queued
      // snapshots; they must never overwrite that already durable text.
      if (request <= this.acknowledgedThrough || sameProjectDraft(snapshot, this.saved)) return;
      this.activeWriteRequest = request;
      const result = await write(this.revision);
      const revision = typeof result === 'number' ? result : result.revision;
      if (revision >= this.revision) {
        this.revision = revision;
        this.saved = typeof result === 'number' ? snapshot : result.snapshot;
        if (sameProjectDraft(this.latest, snapshot)) this.latest = this.saved;
      }
      this.syncReloadGuard();
    }).finally(() => { this.inflight--; this.activeWriteRequest = null; this.syncReloadGuard(); });
    this.chain = pending;
    return pending;
  }
}

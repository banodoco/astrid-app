/**
 * The one settings store. Settings are declared in `defineSetting`, read and written through `useSetting`, and kept
 * in the Runtime's per-user app-state (one record per group: `ui.panes`, `ui.timeline.<id>`, `ext.<extension>`).
 *
 * - A group loads once when it is first used (and again on window focus or when the Runtime connects) and lives in memory.
 * - Changes are written per group after a debounce, with `expected_version`. On a 409 the group is read again and
 *   only the changed fields are laid back on top of what the Runtime now holds.
 * - A localStorage snapshot per group covers first paint and an unreachable Runtime. Callers never see it.
 * - A declaration's legacy key is imported once (written to the Runtime, then removed).
 * - Device settings are plain localStorage values behind the same API.
 */

export interface SettingRef<T = unknown> {
  /** The Runtime app-state key (`ui.panes`), or `device`. */
  readonly group: string;
  /** The field inside the group's record; for `device` the localStorage key. */
  readonly field: string;
  readonly default: T;
  readonly validate: (value: unknown) => boolean;
  readonly legacyKey?: string;
  readonly legacyParse?: (raw: string) => unknown;
  readonly mirrorKey?: string;
  readonly debounceMs?: number;
  readonly device?: boolean;
}

export interface AppStateRecord {
  version: number;
  content: Record<string, unknown> | null;
}

export interface AppStateApi {
  get(key: string): Promise<AppStateRecord>;
  put(key: string, content: Record<string, unknown>, expectedVersion: number): Promise<AppStateRecord>;
}

export interface SettingsStoreOptions {
  api: AppStateApi;
  /** The browser storage for snapshots, legacy keys and device settings; `null` for none. */
  storage?: Storage | null;
  /**
   * False keeps the store off the Runtime until `connect()`: a page that has not connected yet makes no Runtime
   * request (its permission prompt comes first). Reads use the snapshot and changes wait. Defaults to true.
   */
  connected?: boolean;
  /**
   * True while the page is preparing to navigate away (`documentNavigation.ts`): nothing new is sent or read, changes
   * stay pending in the snapshot for the next page, and `refresh()` picks them up if the page stays.
   */
  isNavigating?: () => boolean;
}

/** The Runtime refuses records over 16 KiB of JSON. */
export const APP_STATE_MAX_BYTES = 16 * 1024;
const SNAPSHOT_PREFIX = 'astrid.settings.snapshot.v1:';
const REMOVED = Symbol('removed');
type Pending = unknown | typeof REMOVED;

type GroupStatus = 'idle' | 'loading' | 'loaded' | 'unreachable';
interface LegacyEntry { key: string; value: unknown }

interface Group {
  name: string;
  /** What readers see: the Runtime's record with this browser's unsent changes on top. */
  content: Record<string, unknown>;
  /** The Runtime's record as last read. */
  server: Record<string, unknown>;
  version: number;
  status: GroupStatus;
  pending: Map<string, Pending>;
  refs: Map<string, SettingRef>;
  legacy: Map<string, LegacyEntry>;
  /** Legacy keys to delete once the Runtime holds the value. */
  legacyGarbage: Set<string>;
  legacyPrefixes: Set<string>;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  loading: Promise<void> | null;
  flushing: Promise<void> | null;
  flushAgain: boolean;
  /** The Runtime refused the pending changes (too large, or a 4xx): nothing more is sent until the next change. */
  blocked: boolean;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function statusOf(error: unknown): number | undefined {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' ? status : undefined;
}

/** How long a group waits after a change before it writes. */
export function defaultDebounceMs(group: string): number {
  if (group === 'ui.editor') return 300;
  if (group.startsWith('ui.timeline.')) return 1500;
  if (group.startsWith('ext.')) return 500;
  return 0;
}

export class SettingsStore {
  private readonly api: AppStateApi;
  private readonly storage: Storage | null;
  private readonly groups = new Map<string, Group>();
  private readonly deviceListeners = new Set<() => void>();
  private readonly deviceCache = new Map<string, { raw: string | null; value: unknown }>();
  private detach: (() => void) | null = null;
  private connected: boolean;
  private readonly isNavigating: () => boolean;

  constructor(options: SettingsStoreOptions) {
    this.api = options.api;
    this.isNavigating = options.isNavigating ?? (() => false);
    this.storage = options.storage === undefined ? safeLocalStorage() : options.storage;
    this.connected = options.connected ?? true;
  }

  // -- reading -------------------------------------------------------------------------------------------------

  get<T>(ref: SettingRef<T>): T {
    if (ref.device) return this.getDevice(ref);
    const g = this.group(ref.group);
    this.register(g, ref);
    this.ensureLoaded(g);
    const stored = g.content[ref.field];
    if (stored !== undefined && ref.validate(stored)) return stored as T;
    const legacy = g.legacy.get(ref.field);
    if (legacy !== undefined && !g.pending.has(ref.field) && ref.validate(legacy.value)) return legacy.value as T;
    return ref.default;
  }

  /** True once the group has been read from the Runtime (not merely from the snapshot). */
  isLoaded(group: string): boolean {
    return this.groups.get(group)?.status === 'loaded';
  }

  /** The fields a group holds, for settings whose names are not declared (extension settings). */
  fields(group: string): string[] {
    const g = this.group(group);
    this.ensureLoaded(g);
    return [...new Set([...Object.keys(g.content), ...g.legacy.keys()])].filter((field) => g.pending.get(field) !== REMOVED);
  }

  // -- writing -------------------------------------------------------------------------------------------------

  set<T>(ref: SettingRef<T>, value: T): void {
    if (ref.device) { this.setDevice(ref, value); return; }
    const g = this.group(ref.group);
    this.register(g, ref);
    if (sameJson(this.get(ref), value) && g.content[ref.field] !== undefined) return;
    this.mutate(g, ref.field, value, ref.debounceMs);
  }

  /** Deletes a field (extension settings only; declared settings just take their default back by being set to it). */
  remove(ref: SettingRef): void {
    if (ref.device) { this.removeDevice(ref); return; }
    const g = this.group(ref.group);
    this.register(g, ref);
    if (g.content[ref.field] === undefined && !g.legacy.has(ref.field)) return;
    this.mutate(g, ref.field, REMOVED, ref.debounceMs);
  }

  /**
   * Imports every `<prefix>*` browser key into the group (the key's remainder is the field). For settings whose
   * names are not known ahead of time.
   */
  importLegacyPrefix(group: string, prefix: string): void {
    const g = this.group(group);
    if (g.legacyPrefixes.has(prefix)) return;
    g.legacyPrefixes.add(prefix);
    this.scanPrefix(g, prefix);
    if (g.status === 'loaded') this.afterServerState(g);
    this.ensureLoaded(g);
  }

  subscribe(ref: SettingRef, listener: () => void): () => void {
    if (ref.device) {
      this.deviceListeners.add(listener);
      this.attach();
      return () => { this.deviceListeners.delete(listener); };
    }
    const g = this.group(ref.group);
    this.register(g, ref);
    g.listeners.add(listener);
    this.attach();
    this.ensureLoaded(g);
    return () => { g.listeners.delete(listener); };
  }

  subscribeGroup(group: string, listener: () => void): () => void {
    const g = this.group(group);
    g.listeners.add(listener);
    this.attach();
    this.ensureLoaded(g);
    return () => { g.listeners.delete(listener); };
  }

  // -- Runtime I/O ---------------------------------------------------------------------------------------------

  /** Writes everything pending now (the tab is hiding, or a test). */
  async flush(): Promise<void> {
    await Promise.all([...this.groups.values()].map((g) => this.flushGroup(g)));
  }

  /** The Runtime answered: load every group the page has used and send what waited. */
  async connect(): Promise<void> {
    this.connected = true;
    await this.refresh();
  }

  /** Reads every group again: window focus. */
  async refresh(): Promise<void> {
    await Promise.all([...this.groups.values()].map(async (g) => {
      if (g.pending.size > 0) { await this.flushGroup(g); return; }
      await this.load(g);
    }));
  }

  private ensureLoaded(g: Group): void {
    if (g.status === 'idle' && this.connected) void this.load(g);
  }

  private load(g: Group): Promise<void> {
    if (g.loading) return g.loading;
    if (!this.connected || this.isNavigating()) return Promise.resolve();
    g.status = g.status === 'loaded' ? 'loaded' : 'loading';
    g.loading = (async () => {
      try {
        const record = await this.api.get(g.name);
        g.version = record.version;
        g.server = record.content ?? {};
        g.status = 'loaded';
        this.afterServerState(g);
      } catch {
        if (g.status !== 'loaded') g.status = 'unreachable';
      } finally {
        g.loading = null;
      }
    })();
    return g.loading;
  }

  private flushGroup(g: Group): Promise<void> {
    if (g.timer) { clearTimeout(g.timer); g.timer = null; }
    if (g.blocked || !this.connected || this.isNavigating()) return Promise.resolve();
    // A write already in flight: this call resolves after the changes made meanwhile have been sent too.
    if (g.flushing) { g.flushAgain = true; return g.flushing.then(() => (g.pending.size > 0 ? this.flushGroup(g) : undefined)); }
    // A load in flight may import legacy values: wait for it, then send what it left pending.
    if (g.pending.size === 0) return g.loading ? g.loading.then(() => (g.pending.size > 0 ? this.flushGroup(g) : undefined)) : Promise.resolve();
    g.flushing = (async () => {
      if (g.loading) await g.loading;
      if (g.status !== 'loaded') await this.load(g);
      if (g.status !== 'loaded') return;
      for (let attempt = 0; attempt < 4 && g.pending.size > 0; attempt += 1) {
        const sent = new Map(g.pending);
        const body: Record<string, unknown> = { ...g.server };
        for (const [field, value] of sent) {
          if (value === REMOVED) delete body[field]; else body[field] = value;
        }
        if (new TextEncoder().encode(JSON.stringify(body)).length > APP_STATE_MAX_BYTES) {
          console.warn(`[settings] ${g.name} is over the ${APP_STATE_MAX_BYTES} byte limit; the change stays on this browser`);
          g.blocked = true;
          return;
        }
        try {
          const record = await this.api.put(g.name, body, g.version);
          g.version = record.version;
          g.server = record.content ?? body;
          for (const [field, value] of sent) if (g.pending.get(field) === value) g.pending.delete(field);
          this.afterServerState(g, false);
          return;
        } catch (error) {
          const status = statusOf(error);
          if (status === 409) {
            // Someone else wrote first: read again and lay only our changed fields back on top.
            try {
              const record = await this.api.get(g.name);
              g.version = record.version;
              g.server = record.content ?? {};
              this.afterServerState(g, false);
            } catch { g.status = 'unreachable'; return; }
            continue;
          }
          if (status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429) {
            // The Runtime refuses this content: keep the change (and its old browser key) here and stop
            // retrying until the next change.
            console.warn(`[settings] ${g.name} was refused (${status}); the change stays on this browser`);
            g.blocked = true;
            return;
          }
          g.status = 'unreachable';
          return;
        }
      }
    })().finally(() => {
      // Runs after `g.flushing` is assigned (a synchronous return from the body would otherwise leave it set for good).
      g.flushing = null;
      if (g.flushAgain) { g.flushAgain = false; if (g.pending.size > 0) this.schedule(g, 0); }
    });
    return g.flushing;
  }

  // -- state ---------------------------------------------------------------------------------------------------

  private group(name: string): Group {
    let g = this.groups.get(name);
    if (!g) {
      g = {
        name, content: {}, server: {}, version: 0, status: 'idle', pending: new Map(), refs: new Map(), legacy: new Map(),
        legacyGarbage: new Set(), legacyPrefixes: new Set(), listeners: new Set(), timer: null, loading: null,
        flushing: null, flushAgain: false, blocked: false,
      };
      this.restoreSnapshot(g);
      this.groups.set(name, g);
    }
    return g;
  }

  private register(g: Group, ref: SettingRef): void {
    if (g.refs.has(ref.field)) return;
    g.refs.set(ref.field, ref);
    const legacyKey = ref.legacyKey ?? ref.mirrorKey;
    if (legacyKey) this.readLegacy(g, ref, legacyKey);
    if (g.status === 'loaded') this.afterServerState(g);
  }

  private readLegacy(g: Group, ref: SettingRef, key: string): void {
    const raw = this.read(key);
    if (raw === null) return;
    let value: unknown;
    try { value = ref.legacyParse ? ref.legacyParse(raw) : JSON.parse(raw); } catch { value = undefined; }
    if (value !== undefined && ref.validate(value)) g.legacy.set(ref.field, { key, value });
    else if (ref.legacyKey) g.legacyGarbage.add(key);
  }

  private scanPrefix(g: Group, prefix: string): void {
    const storage = this.storage;
    if (!storage) return;
    try {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (!key || !key.startsWith(prefix) || key.length === prefix.length) continue;
        const field = key.slice(prefix.length);
        const raw = storage.getItem(key);
        if (raw === null) continue;
        try { g.legacy.set(field, { key, value: JSON.parse(raw) }); } catch { g.legacyGarbage.add(key); }
      }
    } catch { /* A storage that cannot be listed has nothing to import. */ }
  }

  /** The Runtime's record is known: lay pending changes on top, import legacy values, tidy legacy keys. */
  private afterServerState(g: Group, scheduleWrite = true): void {
    for (const [field, entry] of [...g.legacy]) {
      if (field in g.server) {
        // The Runtime already holds it (or has just been given it): the old browser key is spent.
        g.legacyGarbage.add(entry.key);
        g.legacy.delete(field);
      } else if (!g.pending.has(field)) {
        // Import: a legacy value the Runtime does not hold yet becomes a pending write.
        g.pending.set(field, entry.value);
      }
    }
    this.rebuild(g);
    if (g.pending.size > 0) { if (scheduleWrite && !g.timer) this.schedule(g, 0); } else this.removeLegacyKeys(g);
  }

  private removeLegacyKeys(g: Group): void {
    if (g.status !== 'loaded' || g.pending.size > 0) return;
    const mirrored = new Set([...g.refs.values()].map((ref) => ref.mirrorKey));
    for (const key of g.legacyGarbage) if (!mirrored.has(key)) this.remove_(key);
    g.legacyGarbage.clear();
  }

  private mutate(g: Group, field: string, value: Pending, debounceMs: number | undefined): void {
    g.pending.set(field, value);
    g.blocked = false;
    const legacy = g.legacy.get(field);
    if (legacy) { g.legacyGarbage.add(legacy.key); g.legacy.delete(field); }
    this.rebuild(g);
    this.schedule(g, debounceMs ?? defaultDebounceMs(g.name));
  }

  private schedule(g: Group, delay: number): void {
    if (g.timer) clearTimeout(g.timer);
    g.timer = setTimeout(() => { g.timer = null; void this.flushGroup(g); }, delay);
  }

  /** Recomputes what readers see, keeps old object identities where nothing changed, writes the snapshot, notifies. */
  private rebuild(g: Group): void {
    const next: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(g.server)) {
      next[field] = sameJson(g.content[field], value) ? g.content[field] : value;
    }
    for (const [field, value] of g.pending) {
      if (value === REMOVED) delete next[field]; else next[field] = sameJson(g.content[field], value) ? g.content[field] : value;
    }
    const changed = !sameJson(Object.keys(next).sort(), Object.keys(g.content).sort())
      || Object.keys(next).some((field) => next[field] !== g.content[field]);
    g.content = next;
    this.writeSnapshot(g);
    this.mirror(g);
    if (changed) for (const listener of [...g.listeners]) listener();
  }

  private mirror(g: Group): void {
    for (const ref of g.refs.values()) {
      if (!ref.mirrorKey) continue;
      const value = g.content[ref.field];
      if (value !== undefined && ref.validate(value)) this.write(ref.mirrorKey, JSON.stringify(value));
    }
  }

  private restoreSnapshot(g: Group): void {
    const raw = this.read(SNAPSHOT_PREFIX + g.name);
    if (!raw) return;
    try {
      const snapshot = JSON.parse(raw) as { content?: unknown; pending?: unknown; removed?: unknown };
      if (!snapshot.content || typeof snapshot.content !== 'object' || Array.isArray(snapshot.content)) return;
      g.content = snapshot.content as Record<string, unknown>;
      // The snapshot is the last state this browser knew of the Runtime (less its unsent changes): until the Runtime
      // answers, changes are laid on top of it. A write always loads first, so this seed is never sent as is.
      g.server = { ...g.content };
      // Changes this browser made but the Runtime never confirmed (the tab closed first) are still to be sent.
      if (Array.isArray(snapshot.pending)) {
        for (const field of snapshot.pending) {
          if (typeof field === 'string' && field in g.content) { g.pending.set(field, g.content[field]); delete g.server[field]; }
        }
      }
      if (Array.isArray(snapshot.removed)) {
        for (const field of snapshot.removed) if (typeof field === 'string') g.pending.set(field, REMOVED);
      }
    } catch { /* A broken snapshot is the same as none. */ }
  }

  private writeSnapshot(g: Group): void {
    const pending: string[] = [];
    const removed: string[] = [];
    for (const [field, value] of g.pending) (value === REMOVED ? removed : pending).push(field);
    this.write(SNAPSHOT_PREFIX + g.name, JSON.stringify({ content: g.content, pending, removed }));
  }

  // -- device settings -----------------------------------------------------------------------------------------

  private getDevice<T>(ref: SettingRef<T>): T {
    const raw = this.read(ref.field);
    const cached = this.deviceCache.get(ref.field);
    if (cached && cached.raw === raw) return (cached.value === undefined ? ref.default : cached.value) as T;
    let value: unknown;
    if (raw !== null) {
      try { value = ref.legacyParse ? ref.legacyParse(raw) : JSON.parse(raw); } catch { value = undefined; }
      if (value !== undefined && !ref.validate(value)) value = undefined;
    }
    this.deviceCache.set(ref.field, { raw, value });
    return (value === undefined ? ref.default : value) as T;
  }

  private setDevice<T>(ref: SettingRef<T>, value: T): void {
    this.write(ref.field, JSON.stringify(value));
    // With storage blocked the write is lost; keeping the value here means the page still sees what the person chose.
    this.deviceCache.set(ref.field, { raw: this.read(ref.field), value });
    for (const listener of [...this.deviceListeners]) listener();
  }

  private removeDevice(ref: SettingRef): void {
    this.remove_(ref.field);
    for (const listener of [...this.deviceListeners]) listener();
  }

  // -- browser -------------------------------------------------------------------------------------------------

  private read(key: string): string | null {
    try { return this.storage?.getItem(key) ?? null; } catch { return null; }
  }

  private write(key: string, value: string): void {
    try { this.storage?.setItem(key, value); } catch { /* Storage full or blocked: the Runtime still holds the value. */ }
  }

  private remove_(key: string): void {
    try { this.storage?.removeItem(key); } catch { /* Nothing to tidy. */ }
  }

  /** Window focus re-reads, a hiding tab flushes, another tab's device write wakes device readers. Attached once. */
  private attach(): void {
    if (this.detach || typeof window === 'undefined' || typeof window.addEventListener !== 'function' || typeof document === 'undefined') return;
    const onFocus = () => { void this.refresh(); };
    const onHide = () => { void this.flush(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') onHide(); };
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== this.storage) return;
      for (const listener of [...this.deviceListeners]) listener();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisibility);
    this.detach = () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibility);
      this.detach = null;
    };
  }

  /** Stops the window listeners and timers (tests). */
  dispose(): void {
    this.detach?.();
    for (const g of this.groups.values()) if (g.timer) clearTimeout(g.timer);
  }
}

function safeLocalStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

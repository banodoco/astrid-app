/**
 * Navigation preparation: before this document goes away on a navigation the App starts or is asked to prepare for,
 * every Runtime request the document started reaches its own end (the response fully received, or a failure), and no
 * new one starts.
 *
 * 1. Owners first write what they hold while the page still runs normally (settings are sent and acknowledged).
 * 2. From then on a new Runtime request fails at once like an offline network, without reaching the network. Work that
 *    could not be sent stays where it already lives durably (the settings snapshot, the command outbox) and the next
 *    document sends it.
 * 3. Requests already on the wire are waited for; none is cut off. Their responses are read to the end.
 *
 * If no navigation follows (a "stay on this page" answer, or a restore from the back/forward cache) the page opens
 * again and owners pick their work back up.
 *
 * Only `/api/` requests made with `fetch` are covered. A navigation the browser starts on its own (the reload button,
 * closing the tab) is not prepared: it keeps the best-effort hand-off it always had.
 */

export type DocumentNavigationPhase = 'open' | 'settling' | 'sealed';

export interface NavigationOwner {
  readonly label: string;
  /** Called while requests still flow: send what must reach the Runtime, and resolve once it has (or cannot). */
  prepare(): Promise<void>;
  /** The navigation did not happen: start again. */
  release?(): void;
}

/** What a Runtime request refused during preparation rejects with: the same shape as an offline network. */
export class DocumentNavigatingError extends TypeError {
  constructor() {
    super('Failed to fetch: this page is navigating away');
  }
}

interface InFlight {
  readonly label: string;
  done: Promise<void>;
}

export const NAVIGATION_PREPARE_TIMEOUT_MS = 10_000;
/** A prepared page that is still here this long after preparing was not navigated away from. */
export const NAVIGATION_RELEASE_AFTER_MS = 30_000;
export const PREPARE_EVENT = 'astrid:prepare-navigation';
export const SETTLING_EVENT = 'astrid:navigation-settling';
export const PREPARED_EVENT = 'astrid:navigation-prepared';
export const RELEASE_EVENT = 'astrid:release-navigation';

let phase: DocumentNavigationPhase = 'open';
let preparing: Promise<void> | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let left = false;
const inflight = new Set<InFlight>();
const owners = new Set<NavigationOwner>();
const changes = new Set<() => void>();

function changed(): void { for (const listener of [...changes]) listener(); }

export function documentNavigationPhase(): DocumentNavigationPhase { return phase; }

/** True while a prepared navigation holds new Runtime requests back. */
export function isDocumentNavigating(): boolean { return phase !== 'open'; }

export function registerNavigationOwner(owner: NavigationOwner): () => void {
  owners.add(owner);
  return () => { owners.delete(owner); };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
}

/** Runtime and bridge requests, same-origin or through the gateway: `/api/...`. */
export function isRuntimeRequest(input: RequestInfo | URL, base = typeof location === 'undefined' ? 'http://localhost/' : location.href): boolean {
  try { return new URL(requestUrl(input), base).pathname.startsWith('/api/'); } catch { return false; }
}

function routeLabel(input: RequestInfo | URL, init?: RequestInit): string {
  let path = '/api/';
  try { path = new URL(requestUrl(input), typeof location === 'undefined' ? 'http://localhost/' : location.href).pathname; } catch { /* keep the prefix */ }
  // A label names the kind of request, never its identifiers.
  const kind = path.includes('/app-state/') ? 'app-state' : path.split('/').filter(Boolean).slice(0, 4).join('/');
  return `${requestMethod(input, init)} ${kind}`;
}

/** Resolves once the response body has been received to its end (or failed), without consuming the caller's copy. */
async function received(response: Response): Promise<void> {
  if (!response.body) return;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return;
    while (!(await reader.read()).done) { /* Drain the copy only. */ }
  } catch {
    // An aborted or failed body has also ended.
  } finally {
    try { reader?.releaseLock(); } catch { /* Already released. */ }
  }
}

let installedOn: (typeof globalThis) | null = null;

/** Wraps `fetch` once so every Runtime request is known to the page until it has fully ended. */
export function installDocumentRequestRegistry(target: typeof globalThis = globalThis): void {
  if (installedOn === target || typeof target.fetch !== 'function') return;
  installedOn = target;
  const original = target.fetch.bind(target);
  const wrapped: typeof fetch = (input, init) => {
    if (!isRuntimeRequest(input)) return original(input, init);
    if (phase !== 'open') return Promise.reject(new DocumentNavigatingError());
    const started = original(input, init);
    const entry: InFlight = { label: routeLabel(input, init), done: Promise.resolve() };
    inflight.add(entry);
    // Registered before the caller can read the body, so the copy is taken first.
    entry.done = started.then(received, () => undefined).finally(() => { inflight.delete(entry); changed(); });
    return started;
  };
  target.fetch = wrapped;
  if (typeof target.addEventListener === 'function') {
    target.addEventListener('pagehide', () => { left = true; });
    target.addEventListener('pageshow', (event) => {
      left = false;
      if ((event as PageTransitionEvent).persisted) releaseDocumentNavigation();
    });
  }
}

/** Runtime requests this document has started and that have not fully ended. */
export function inflightRuntimeRequests(): string[] { return [...inflight].map((entry) => entry.label); }

function waitForIdle(deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => {
      if (inflight.size > 0 && Date.now() < deadline) return;
      changes.delete(check);
      clearTimeout(timer);
      resolve(inflight.size === 0);
    };
    changes.add(check);
    const timer = setTimeout(check, Math.max(0, deadline - Date.now()));
    check();
  });
}

function withDeadline<T>(work: Promise<T>, deadline: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
    void work.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(undefined); });
  });
}

export interface PrepareOptions {
  /** Called once new requests are refused and only requests already on the wire remain. */
  onSettling?: () => void;
  timeoutMs?: number;
}

/**
 * Prepare this document to be navigated away from. Resolves once owners have written what they hold, no Runtime
 * request is in flight and none can start. Rejects (and opens the page again) when requests do not end in time.
 */
export function prepareDocumentNavigation(options: PrepareOptions = {}): Promise<void> {
  if (phase === 'sealed') { options.onSettling?.(); return Promise.resolve(); }
  if (preparing) {
    const current = preparing;
    if (options.onSettling) {
      if (phase === 'settling') options.onSettling();
      else { const notify = options.onSettling; const once = () => { if (phase !== 'open') { changes.delete(once); notify(); } }; changes.add(once); }
    }
    return current;
  }
  const deadline = Date.now() + (options.timeoutMs ?? NAVIGATION_PREPARE_TIMEOUT_MS);
  preparing = (async () => {
    await withDeadline(Promise.allSettled([...owners].map((owner) => Promise.resolve().then(() => owner.prepare()))), deadline);
    phase = 'settling';
    changed();
    options.onSettling?.();
    if (!await waitForIdle(deadline)) {
      const still = inflightRuntimeRequests();
      releaseDocumentNavigation();
      throw new Error(`Runtime requests did not finish before navigation: ${[...new Set(still)].join(', ')}`);
    }
    phase = 'sealed';
    changed();
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => { if (!left) releaseDocumentNavigation(); }, NAVIGATION_RELEASE_AFTER_MS);
  })().finally(() => { preparing = null; });
  return preparing;
}

/** The navigation did not happen: requests flow again and owners resume. */
export function releaseDocumentNavigation(): void {
  if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
  if (phase === 'open') return;
  phase = 'open';
  changed();
  for (const owner of [...owners]) {
    try { owner.release?.(); } catch { /* One owner cannot stop the others. */ }
  }
}

/** Prepare, then navigate. A failed preparation still navigates: the person asked to leave. */
export async function navigateDocument(navigate: () => void): Promise<void> {
  try { await prepareDocumentNavigation(); } catch { /* Durable owners carry what could not be settled. */ }
  navigate();
}

let protocolInstalled = false;

/**
 * Lets the page's host (a test driver or an embedding shell) ask for preparation before it navigates the page itself:
 * `astrid:prepare-navigation` {id} is answered by `astrid:navigation-settling` {id} and `astrid:navigation-prepared`
 * {id, ok, error?}; `astrid:release-navigation` opens the page again.
 */
export function installNavigationPreparationProtocol(target: Window = window): void {
  if (protocolInstalled) return;
  protocolInstalled = true;
  target.addEventListener(PREPARE_EVENT, (event) => {
    const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
    const reply = (type: string, detail: Record<string, unknown> = {}) =>
      target.dispatchEvent(new CustomEvent(type, { detail: { id, ...detail } }));
    prepareDocumentNavigation({ onSettling: () => reply(SETTLING_EVENT) }).then(
      () => reply(PREPARED_EVENT, { ok: true }),
      (error: unknown) => reply(PREPARED_EVENT, { ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  });
  target.addEventListener(RELEASE_EVENT, () => releaseDocumentNavigation());
  target.document.documentElement.dataset.astridNavigation = 'ready';
}

/** Tests only: forget every request, owner and phase. */
export function resetDocumentNavigationForTests(): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  phase = 'open';
  preparing = null;
  left = false;
  inflight.clear();
  owners.clear();
  changes.clear();
  installedOn = null;
  protocolInstalled = false;
}

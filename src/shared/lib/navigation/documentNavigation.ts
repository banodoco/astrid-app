/**
 * Navigation preparation: before this document goes away on a navigation the App starts or is asked to prepare for,
 * every Runtime request the document started reaches its own end (the response fully received, or a failure), and no
 * new one starts.
 *
 * 1. Owners first write what they hold while the page still runs normally (settings are sent and acknowledged).
 * 2. From then on a new Runtime request fails at once like an offline network, without reaching the network. Work that
 *    could not be sent stays where it already lives durably (the settings snapshot, the command outbox) and the next
 *    document sends it.
 * 3. Requests already on the wire end while this document is still alive, each with its own end event:
 *    - an ordinary request (its answer is JSON or text, the bodies a credential scan reads in full) is waited for, and
 *      its body is read to the end on a copy;
 *    - a request that would hold the page indefinitely is not waited for: one marked `abortOnNavigation` (an agent
 *      turn, which has no deadline of its own and goes on in the agent) while it waits for its answer, and any answer
 *      of another kind (media and object bytes, downloads, event streams). Those bodies are never copied, so nothing
 *      is buffered on their behalf and a caller that cancels its body stops the transfer. They are cancelled only once
 *      the navigation is certain (`cancelUnwaitedRequests`, right before it), so a page that stays keeps them;
 *    - whatever is still on the wire when the 10 s run out is cancelled.
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
  /** Cancels this request on the network, through the wrapper's own abort signal. */
  readonly abort: () => void;
  /** Not waited for by a prepared navigation, and cancelled once that navigation is certain. */
  cancelOnPrepare: boolean;
}

export const NAVIGATION_PREPARE_TIMEOUT_MS = 10_000;
/** A prepared page that is still here this long after preparing was not navigated away from. */
export const NAVIGATION_RELEASE_AFTER_MS = 30_000;
/** How long cancelled requests get to report their end before preparation gives up on them. */
export const NAVIGATION_CANCEL_GRACE_MS = 1_000;
export const PREPARE_EVENT = 'astrid:prepare-navigation';
export const SETTLING_EVENT = 'astrid:navigation-settling';
export const PREPARED_EVENT = 'astrid:navigation-prepared';
export const RELEASE_EVENT = 'astrid:release-navigation';

let phase: DocumentNavigationPhase = 'open';
let preparing: Promise<void> | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let left = false;
/** Requests the page waits for: no answer yet, or an answer whose body is still being read to the end. */
const inflight = new Set<InFlight>();
/**
 * Answers whose bodies are left to their callers (bytes, streams): cancelled at preparation, whether or not they have
 * already ended. Forgotten when their response is collected; nothing is kept for them but the abort.
 */
const uncopied = new Set<InFlight>();
type Finalization = new (cleanup: (entry: InFlight) => void) => { register(target: object, entry: InFlight): void };
const Finalizer = (globalThis as { FinalizationRegistry?: Finalization }).FinalizationRegistry;
const collected = Finalizer ? new Finalizer((entry) => { uncopied.delete(entry); }) : null;
const marked = new WeakSet<object>();
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

/**
 * Mark a request that has no deadline of its own, so the page does not wait for it before a navigation: it is
 * cancelled at preparation instead (an agent turn goes on in the agent, and the next page reads its outcome).
 */
export function abortOnNavigation<T extends RequestInit>(init: T): T {
  marked.add(init);
  return init;
}

/**
 * An answer the page waits for, body included: JSON or text (what a credential scan reads in full), except formats
 * that stream without end. Any other answer (media, object bytes, downloads) is left to its caller, uncopied.
 */
export function settlesInFull(response: Response): boolean {
  if (!response.body) return true;
  const type = response.headers.get('content-type') ?? '';
  if (/event-stream|ndjson|json-seq/i.test(type)) return false;
  return /json|text/i.test(type);
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

function callerSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
  if (init && 'signal' in init) return init.signal ?? undefined;
  return typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined;
}

/** The caller's signal and the wrapper's own, either of which cancels the request. */
function combined(own: AbortSignal, caller: AbortSignal | undefined): AbortSignal {
  if (!caller) return own;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([caller, own]);
  const both = new AbortController();
  const follow = (signal: AbortSignal) => {
    if (signal.aborted) both.abort(signal.reason);
    else signal.addEventListener('abort', () => both.abort(signal.reason), { once: true });
  };
  follow(caller);
  follow(own);
  return both.signal;
}

function navigatingAway(): DOMException {
  return new DOMException('This page is navigating away', 'AbortError');
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
    const controller = new AbortController();
    const started = original(input, { ...init, signal: combined(controller.signal, callerSignal(input, init)) });
    const entry: InFlight = {
      label: routeLabel(input, init),
      done: Promise.resolve(),
      abort: () => controller.abort(navigatingAway()),
      cancelOnPrepare: Boolean(init && marked.has(init)),
    };
    inflight.add(entry);
    // Registered before the caller can read the body, so the copy (when one is taken) is taken first.
    entry.done = started.then((response) => {
      if (settlesInFull(response)) { entry.cancelOnPrepare = false; return received(response); }
      // Left to its caller: a cancel the caller makes reaches the network, and a prepared navigation cancels it.
      entry.cancelOnPrepare = true;
      uncopied.add(entry);
      collected?.register(response, entry);
      return undefined;
    }, () => undefined).finally(() => { inflight.delete(entry); changed(); });
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
export function inflightRuntimeRequests(): string[] { return awaited().map((entry) => entry.label); }

/** What a prepared navigation waits for: everything on the wire except what it cancels instead. */
function awaited(): InFlight[] { return [...inflight].filter((entry) => !entry.cancelOnPrepare); }

function waitForIdle(deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = () => {
      changes.delete(check);
      clearTimeout(timer);
      resolve(awaited().length === 0);
    };
    const check = () => { if (awaited().length === 0 || Date.now() >= deadline) finish(); };
    changes.add(check);
    // The timer itself is the deadline: a timer can fire a millisecond before the clock reads it.
    const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
    check();
  });
}

/**
 * The navigation is certain (called synchronously right before it): cancel what preparation did not wait for, requests
 * marked so and bodies left to their callers, so each ends with its own failure event while the document is alive.
 * Not called when the page stays (a draft changed during the wait, or the host releases), so those requests go on.
 */
export function cancelUnwaitedRequests(): void {
  for (const entry of [...inflight]) if (entry.cancelOnPrepare) entry.abort();
  for (const entry of [...uncopied]) entry.abort();
  uncopied.clear();
}

/** The 10 s ran out: cancel what is left, and give the cancellations a moment to end. */
async function cancelRemaining(): Promise<void> {
  for (const entry of awaited()) entry.abort();
  await waitForIdle(Date.now() + NAVIGATION_CANCEL_GRACE_MS);
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
      // Nothing is left on the wire when the page goes, even when preparing failed.
      await cancelRemaining();
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
  cancelUnwaitedRequests();
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
    // A host that asks navigates next: what preparation did not wait for is cancelled before it is told so.
    prepareDocumentNavigation({ onSettling: () => reply(SETTLING_EVENT) }).then(
      () => { cancelUnwaitedRequests(); reply(PREPARED_EVENT, { ok: true }); },
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
  uncopied.clear();
  owners.clear();
  changes.clear();
  installedOn = null;
  protocolInstalled = false;
}

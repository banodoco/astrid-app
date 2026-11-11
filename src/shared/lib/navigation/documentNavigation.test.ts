import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortOnNavigation,
  cancelUnwaitedRequests,
  DocumentNavigatingError,
  documentNavigationPhase,
  inflightRuntimeRequests,
  installDocumentRequestRegistry,
  installNavigationPreparationProtocol,
  PREPARE_EVENT,
  PREPARED_EVENT,
  prepareDocumentNavigation,
  registerNavigationOwner,
  releaseDocumentNavigation,
  resetDocumentNavigationForTests,
} from './documentNavigation';
import { SettingsStore, type AppStateApi } from '@/shared/settings/settingsStore';

/**
 * A fake global whose fetch answers only when the test says so, with a body that streams until it is ended. Like the
 * browser, an abort rejects a request still waiting for its answer and errors a body still arriving; a body cancelled
 * by whoever reads it stops arriving (`cancelled`).
 */
function fakeGlobal() {
  const calls: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const pending: Array<{ url: string; respond: (type?: string) => void; end: () => void; cancelled: () => boolean; aborted: () => boolean }> = [];
  const target = {
    fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      signals.push(init?.signal ?? undefined);
      return new Promise<Response>((resolve, reject) => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let cancelled = false;
        let ended = false;
        const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { cancelled = true; } });
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal!.reason);
          if (!ended && !cancelled) { try { controller.error(init.signal!.reason); } catch { /* Already closed. */ } }
        }, { once: true });
        pending.push({
          url,
          respond: (type = 'application/json') => { controller.enqueue(new TextEncoder().encode('{"ok":')); resolve(new Response(body, { headers: { 'content-type': type } })); },
          end: () => { ended = true; controller.enqueue(new TextEncoder().encode('true}')); controller.close(); },
          cancelled: () => cancelled,
          aborted: () => init?.signal?.aborted === true,
        });
      });
    }),
    addEventListener: vi.fn(),
  } as unknown as typeof globalThis;
  return { target, calls, pending, signals };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('document navigation preparation', () => {
  beforeEach(() => resetDocumentNavigationForTests());
  afterEach(() => resetDocumentNavigationForTests());

  it('waits for a Runtime request already on the wire, including its whole body, and refuses new ones', async () => {
    const { target, calls, pending } = fakeGlobal();
    installDocumentRequestRegistry(target);
    const reading = target.fetch('/api/runtime/v1/app-state/user/ui.panes').then((response) => response.text());
    let prepared = false;
    let settling = false;
    const preparing = prepareDocumentNavigation({ onSettling: () => { settling = true; } }).then(() => { prepared = true; });
    await flush();
    expect(settling).toBe(true);
    expect(documentNavigationPhase()).toBe('settling');
    // A request started while settling never reaches the network.
    await expect(target.fetch('/api/runtime/v1/health')).rejects.toBeInstanceOf(DocumentNavigatingError);
    await expect(target.fetch('/api/runtime/v1/health')).rejects.toBeInstanceOf(TypeError);
    expect(calls).toEqual(['/api/runtime/v1/app-state/user/ui.panes']);
    pending[0].respond();
    await flush();
    expect(prepared, 'headers alone do not end a request').toBe(false);
    expect(inflightRuntimeRequests()).toEqual(['GET app-state']);
    pending[0].end();
    await preparing;
    expect(prepared).toBe(true);
    expect(documentNavigationPhase()).toBe('sealed');
    expect(await reading, 'the caller still reads the full original body').toBe('{"ok":true}');
    // Unload-time work (a pagehide flush) sends nothing.
    await expect(target.fetch('/api/runtime/v1/app-state/user/ui.panes')).rejects.toBeInstanceOf(DocumentNavigatingError);
    expect(calls).toHaveLength(1);
  });

  it('lets owners send before requests are refused, and leaves other requests alone', async () => {
    const { target, calls, pending } = fakeGlobal();
    installDocumentRequestRegistry(target);
    registerNavigationOwner({
      label: 'owner',
      prepare: async () => { const sent = target.fetch('/api/runtime/v1/app-state/user/ui.panes', { method: 'PUT' }); pending.at(-1)!.respond(); pending.at(-1)!.end(); await sent; },
    });
    void target.fetch('/assets/chunk.js');
    await prepareDocumentNavigation();
    expect(calls).toEqual(['/assets/chunk.js', '/api/runtime/v1/app-state/user/ui.panes']);
    expect(documentNavigationPhase()).toBe('sealed');
    void target.fetch('/assets/other.js');
    expect(calls).toHaveLength(3);
  });

  it('opens the page again when a request does not end, naming the kind of request only', async () => {
    const { target } = fakeGlobal();
    installDocumentRequestRegistry(target);
    void target.fetch('/api/runtime/v1/projects/p-1/timelines/t-1/commit', { method: 'POST' });
    await expect(prepareDocumentNavigation({ timeoutMs: 20 })).rejects.toThrow('POST api/runtime/v1/projects');
    expect(documentNavigationPhase()).toBe('open');
  });

  it('waits for a poll started while owners were sending, before new requests were refused', async () => {
    const { target, pending } = fakeGlobal();
    installDocumentRequestRegistry(target);
    let poll!: Promise<string>;
    // A health poll fires while the settings owner is still writing: the page is open, so it goes out.
    registerNavigationOwner({ label: 'settings', prepare: async () => { poll = target.fetch('/api/runtime/v1/health').then((response) => response.text()); } });
    let prepared = false;
    const preparing = prepareDocumentNavigation().then(() => { prepared = true; });
    await flush();
    expect(documentNavigationPhase()).toBe('settling');
    expect(inflightRuntimeRequests()).toEqual(['GET api/runtime/v1/health']);
    pending[0].respond();
    await flush();
    expect(prepared, 'its answer has not been read to the end').toBe(false);
    pending[0].end();
    await preparing;
    expect(await poll).toBe('{"ok":true}');
  });

  it('leaves a byte body to its caller, so the caller cancelling it stops the transfer', async () => {
    const { target, pending } = fakeGlobal();
    installDocumentRequestRegistry(target);
    const downloading = target.fetch('/api/runtime/v1/objects/sha256-render');
    pending[0].respond('video/mp4');
    const response = await downloading;
    // `render-download.ts`: a render over the browser download limit is refused from its headers.
    await response.body!.cancel();
    expect(pending[0].cancelled(), 'the network body stops, not only the caller\'s copy').toBe(true);
    expect(inflightRuntimeRequests()).toEqual([]);
  });

  it('does not wait for a byte body still arriving, and cancels it once the navigation is certain', async () => {
    const { target, pending } = fakeGlobal();
    installDocumentRequestRegistry(target);
    const media = await (async () => { const started = target.fetch('/api/runtime/v1/objects/sha256-video'); pending[0].respond('video/mp4'); return started; })();
    const reading = media.arrayBuffer();
    await prepareDocumentNavigation({ timeoutMs: 5_000 });
    expect(pending[0].aborted(), 'a page that may yet stay keeps it').toBe(false);
    cancelUnwaitedRequests();
    expect(pending[0].aborted(), 'cancelled through the page\'s own signal, while the page is still here').toBe(true);
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(documentNavigationPhase()).toBe('sealed');
  });

  it('prepares at once past a request with no deadline (an agent turn), and cancels it once the navigation is certain', async () => {
    const { target, pending } = fakeGlobal();
    installDocumentRequestRegistry(target);
    const turn = target.fetch('/api/astrid/acp/c-1/rpc', abortOnNavigation({ method: 'POST', body: '{"method":"session/prompt"}' }));
    const startedAt = Date.now();
    await prepareDocumentNavigation();
    expect(Date.now() - startedAt, 'not the 10 s preparation cap').toBeLessThan(1_000);
    expect(pending[0].aborted(), 'a page that may yet stay keeps the turn').toBe(false);
    cancelUnwaitedRequests();
    await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
    expect(documentNavigationPhase()).toBe('sealed');
  });

  it('keeps the caller\'s own abort working through the page\'s signal', async () => {
    const { target } = fakeGlobal();
    installDocumentRequestRegistry(target);
    const caller = new AbortController();
    const request = target.fetch('/api/runtime/v1/health', { signal: caller.signal });
    caller.abort(new DOMException('caller stopped', 'AbortError'));
    await expect(request).rejects.toMatchObject({ message: 'caller stopped' });
    await flush();
    expect(inflightRuntimeRequests()).toEqual([]);
  });

  it('cancels what is still on the wire when preparation runs out of time, so nothing outlives the page', async () => {
    const { target, pending } = fakeGlobal();
    installDocumentRequestRegistry(target);
    const commit = target.fetch('/api/runtime/v1/projects/p-1/timelines/t-1/commit', { method: 'POST' });
    await expect(prepareDocumentNavigation({ timeoutMs: 20 })).rejects.toThrow('POST api/runtime/v1/projects');
    expect(pending[0].aborted()).toBe(true);
    await expect(commit).rejects.toMatchObject({ name: 'AbortError' });
    expect(inflightRuntimeRequests()).toEqual([]);
  });

  it('cancels an agent turn when the host prepares the page, and after release a self-prepared navigation cancels nothing', async () => {
    const { target, pending } = fakeGlobal();
    installDocumentRequestRegistry(target);
    const host = Object.assign(new EventTarget(), { document }) as unknown as Window;
    installNavigationPreparationProtocol(host);
    void target.fetch('/api/astrid/acp/c-1/rpc', abortOnNavigation({ method: 'POST' }));
    const prepared = new Promise((resolve) => host.addEventListener(PREPARED_EVENT, resolve, { once: true }));
    host.dispatchEvent(new CustomEvent(PREPARE_EVENT, { detail: { id: 'host' } }));
    await prepared;
    // A host that asks navigates next, so the turn's wait is cancelled before it is told the page is prepared.
    expect(pending[0].aborted()).toBe(true);
    releaseDocumentNavigation();
    // Not asked again, a page that stays (B1, or no host at all) never cancels what it did not wait for.
    void target.fetch('/api/astrid/acp/c-1/rpc', abortOnNavigation({ method: 'POST' }));
    await prepareDocumentNavigation();
    releaseDocumentNavigation();
    expect(pending[1].aborted()).toBe(false);
  });

  it('release resumes owners after a navigation that did not happen', async () => {
    const { target } = fakeGlobal();
    installDocumentRequestRegistry(target);
    const release = vi.fn();
    registerNavigationOwner({ label: 'owner', prepare: async () => {}, release });
    await prepareDocumentNavigation();
    releaseDocumentNavigation();
    expect(release).toHaveBeenCalledOnce();
    expect(documentNavigationPhase()).toBe('open');
  });

  it('keeps settings changes pending for the next page while navigating, and sends them if the page stays', async () => {
    let navigating = false;
    const api: AppStateApi = {
      get: vi.fn(async () => ({ version: 1, content: {} })),
      put: vi.fn(async (_key, content) => ({ version: 2, content })),
    };
    const store = new SettingsStore({ api, storage: null, isNavigating: () => navigating });
    const ref = { group: 'ui.panes', field: 'width', default: 1, validate: (value: unknown) => typeof value === 'number', debounceMs: 0 };
    store.get(ref);
    await flush();
    navigating = true;
    store.set(ref, 5);
    await store.flush();
    await flush();
    expect(api.put).not.toHaveBeenCalled();
    expect(store.get(ref)).toBe(5);
    navigating = false;
    await store.refresh();
    expect(api.put).toHaveBeenCalledWith('ui.panes', { width: 5 }, 1);
    store.dispose();
  });
});

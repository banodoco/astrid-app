import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DocumentNavigatingError,
  documentNavigationPhase,
  inflightRuntimeRequests,
  installDocumentRequestRegistry,
  prepareDocumentNavigation,
  registerNavigationOwner,
  releaseDocumentNavigation,
  resetDocumentNavigationForTests,
} from './documentNavigation';
import { SettingsStore, type AppStateApi } from '@/shared/settings/settingsStore';

/** A fake global whose fetch answers only when the test says so, with a body that streams until it is ended. */
function fakeGlobal() {
  const calls: string[] = [];
  const pending: Array<{ url: string; respond: () => void; end: () => void }> = [];
  const target = {
    fetch: vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return new Promise<Response>((resolve) => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
        pending.push({
          url,
          respond: () => { controller.enqueue(new TextEncoder().encode('{"ok":')); resolve(new Response(body, { headers: { 'content-type': 'application/json' } })); },
          end: () => { controller.enqueue(new TextEncoder().encode('true}')); controller.close(); },
        });
      });
    }),
    addEventListener: vi.fn(),
  } as unknown as typeof globalThis;
  return { target, calls, pending };
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

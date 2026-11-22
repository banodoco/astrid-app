import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectElementComponent, ProjectElementEntry } from './admittedElementLoader';

// The gateway origin is the only difference between the cases below, so the origin is the one mutable mock.
let origin = '';
vi.mock('@/integrations/runtime/connection.ts', () => ({
  runtimeOrigin: () => origin,
  runtimeApiBase: () => `${origin}/api/runtime`,
}));
// Vitest cannot evaluate a blob URL. The real loader still fetches, digest-checks and blob-wraps the bytes; only the
// browser's own import() of that blob is replaced by a stand-in component.
const Blocks: ProjectElementComponent = () => null;
vi.mock('./admittedElementLoader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./admittedElementLoader')>();
  return {
    ...actual,
    importProjectElement: (entry: ProjectElementEntry, signal: AbortSignal) => actual.importProjectElement(entry, signal, async () => ({ default: Blocks })),
  };
});

let host: typeof import('./admitted-elements');
const fetchMock = vi.fn();
const SOURCE = 'export default function Blocks() { return null; }';
const DIGEST = createHash('sha256').update(SOURCE).digest('hex');
const REF = { packId: 'project_pack', kind: 'effect' as const, id: 'blocks', revision: 'r1' };
const REF_DIGEST = createHash('sha256').update(JSON.stringify([REF.packId, REF.kind, REF.id, REF.revision]), 'utf8').digest('hex');

function installImportMap() {
  const bindings = Object.fromEntries(['react', 'react/jsx-runtime', 'remotion'].map((name, index) => [
    name, { url: `/assets/shared-${index}.js`, sha256: String(index).repeat(64), version: '1.0.0' }]));
  for (const [id, type, body] of [
    ['astrid-extension-importmap', 'importmap', { imports: Object.fromEntries(Object.entries(bindings).map(([name, binding]) => [name, binding.url])) }],
    ['astrid-extension-shared-modules', 'application/json', { version: 1, shared_modules: bindings }],
  ] as const) {
    const script = document.createElement('script');
    script.type = type;
    script.id = id;
    script.textContent = JSON.stringify(body);
    document.head.appendChild(script);
  }
}

function listBody(url = `/api/runtime/packs/project-elements/project/${DIGEST}.js`) {
  return {
    version: 1, projectId: 'project', selectionDigest: 'a'.repeat(64), legacy: [], projects: [], realmId: 'realm',
    elements: [{
      ref: REF, digest: DIGEST, url,
      descriptor: { id: 'blocks', kind: 'effect', packId: 'project_pack', revision: 'r1', label: 'Blocks', description: '', componentPath: 'elements/blocks/component.tsx',
        parameters: [], defaults: {}, renderability: { preview: 'supported', browserExport: 'supported', workerExport: 'unknown' } },
      authoring: { packRoot: '/canonical', descriptorPath: '/canonical/element.yaml', componentPath: '/canonical/component.tsx', status: 'ready' },
    }],
  };
}

/** Routes the list and bytes requests the way the Runtime answers them, on whichever origin the editor is using. */
function runtimeFetch(list: unknown) {
  return async (url: string) => {
    if (url.endsWith('/packs/project-elements?project=project')) return { ok: true, redirected: false, json: async () => list };
    if (url.endsWith(`/packs/project-elements/project/${DIGEST}.js?ref=${REF_DIGEST}`)) {
      return { ok: true, redirected: false, arrayBuffer: async () => new TextEncoder().encode(SOURCE).buffer };
    }
    throw new Error(`unexpected request ${url}`);
  };
}

beforeEach(async () => {
  origin = '';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  for (const id of ['astrid-extension-importmap', 'astrid-extension-shared-modules']) document.getElementById(id)?.remove();
  installImportMap();
  host = await import('./admitted-elements');
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const id of ['astrid-extension-importmap', 'astrid-extension-shared-modules']) document.getElementById(id)?.remove();
});

describe('element admissions on the hosted build', () => {
  it('with the gateway origin, lists and loads the admitted element from the Runtime instead of skipping', async () => {
    origin = 'http://127.0.0.1:17340';
    fetchMock.mockImplementation(runtimeFetch(listBody(`/api/runtime/packs/project-elements/project/${DIGEST}.js`)));
    host.setAdmittedElementScope('project', [REF]);

    await host.refreshAdmittedElements();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:17340/api/runtime/packs/project-elements?project=project',
      `http://127.0.0.1:17340/api/runtime/packs/project-elements/project/${DIGEST}.js?ref=${REF_DIGEST}`,
    ]);
    expect(host.admittedComponent(REF)).toBe(Blocks);
    expect(host.getAdmittedElementReadiness()).toMatchObject({ projectId: 'project', phase: 'ready', error: null });
    expect(host.isAdmittedElementPreviewPreparing('project', [REF])).toBe(false);
  });

  it('with the gateway origin, applying a pack ref lists and loads it the same way', async () => {
    origin = 'http://127.0.0.1:17340';
    fetchMock.mockImplementation(runtimeFetch(listBody()));
    host.setAdmittedElementScope('project', []);

    await host.refreshAdmittedElementRef(REF);

    expect(host.admittedComponent(REF)).toBe(Blocks);
    expect(host.getAdmittedElementReadiness()).toMatchObject({ phase: 'ready', error: null });
  });

  it('same-origin reads the same list and bytes from the same-origin Runtime path', async () => {
    fetchMock.mockImplementation(runtimeFetch(listBody()));
    host.setAdmittedElementScope('project', [REF]);

    await host.refreshAdmittedElements();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/runtime/packs/project-elements?project=project',
      `/api/runtime/packs/project-elements/project/${DIGEST}.js?ref=${REF_DIGEST}`,
    ]);
    expect(host.admittedComponent(REF)).toBe(Blocks);
  });

  it('refuses a gateway list whose bytes URL names another project, publishes nothing, and does not reject', async () => {
    origin = 'http://127.0.0.1:17340';
    fetchMock.mockImplementation(runtimeFetch(listBody(`/api/runtime/packs/project-elements/other/${DIGEST}.js`)));
    host.setAdmittedElementScope('project', [REF]);

    await expect(host.refreshAdmittedElements()).resolves.toBe(host.getAdmittedElementSelection());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.admittedComponent(REF)).toBeUndefined();
    expect(host.getAdmittedElementReadiness()).toMatchObject({ phase: 'error', error: expect.stringContaining('invalid project element entry') });
  });
});

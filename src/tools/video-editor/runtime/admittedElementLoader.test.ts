// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './__fixtures__/project-elements-list.json';

// The gateway origin is the only mutable input the loader reads from the connection module.
let origin = '';
vi.mock('@/integrations/runtime/connection.ts', () => ({
  runtimeOrigin: () => origin,
  runtimeApiBase: () => `${origin}/api/runtime`,
}));

const loader = () => import('./admittedElementLoader');
const digestOf = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const COMPONENT_SOURCE = 'export default function Blocks() { return null; }';
const IMPORT_MAP = '{"imports":{"react":"/assets/react.js","react/jsx-runtime":"/assets/jsx.js","remotion":"/assets/remotion.js"}}';

function installImportMap(body: string | null = IMPORT_MAP) {
  document.getElementById('astrid-extension-importmap')?.remove();
  if (body === null) return;
  const script = document.createElement('script');
  script.type = 'importmap';
  script.id = 'astrid-extension-importmap';
  script.textContent = body;
  document.head.appendChild(script);
}

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function entryFor(digest: string, revision = 'r1') {
  return {
    ref: { packId: 'project_pack', kind: 'effect' as const, id: 'blocks', revision },
    digest,
    url: `/api/runtime/packs/project-elements/project/${digest}.js`,
    descriptor: { id: 'blocks', kind: 'effect', packId: 'project_pack', revision } as never,
    authoring: { packRoot: '/canonical', descriptorPath: '/canonical/element.yaml', componentPath: '/canonical/component.tsx', status: 'ready' },
  };
}

function listBody(elements: unknown[], overrides: Record<string, unknown> = {}) {
  return { version: 1, projectId: 'project', selectionDigest: 'a'.repeat(64), projects: [], realmId: 'realm', elements, ...overrides };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  origin = '';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  installImportMap();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  installImportMap(null);
});

describe('project element list parsing', () => {
  it('accepts the Runtime shape and names each ref exactly', async () => {
    const { parseProjectElementList } = await loader();
    const digest = 'b'.repeat(64);
    const list = parseProjectElementList(listBody([entryFor(digest)]), 'project');
    expect(list).toMatchObject({ version: 1, projectId: 'project', realmId: 'realm', selectionDigest: 'a'.repeat(64) });
    expect(list.elements).toHaveLength(1);
    expect(list.elements[0].ref).toEqual({ packId: 'project_pack', kind: 'effect', id: 'blocks', revision: 'r1' });
  });

  it.each([
    ['another version', (body: Record<string, unknown>) => ({ ...body, version: 2 })],
    ['another project', (body: Record<string, unknown>) => ({ ...body, projectId: 'other' })],
    ['a missing realm', (body: Record<string, unknown>) => ({ ...body, realmId: '' })],
    ['a malformed selection digest', (body: Record<string, unknown>) => ({ ...body, selectionDigest: 'not-a-digest' })],
    ['a non-array projects field', (body: Record<string, unknown>) => ({ ...body, projects: 'none' })],
  ])('rejects a list with %s', async (_label, mutate) => {
    const { parseProjectElementList } = await loader();
    expect(() => parseProjectElementList(mutate(listBody([entryFor('b'.repeat(64))])), 'project'))
      .toThrow('invalid project element list');
  });

  it.each([
    ['a url on another host', { url: 'https://evil.example/x.js' }],
    ['a url for another project', { url: `/api/runtime/packs/project-elements/other/${'b'.repeat(64)}.js` }],
    ['a url whose digest is not the entry digest', { url: `/api/runtime/packs/project-elements/project/${'c'.repeat(64)}.js` }],
    ['a non-digest value', { digest: 'b'.repeat(63) }],
  ])('rejects an entry with %s', async (_label, patch) => {
    const { parseProjectElementList } = await loader();
    const bad = { ...entryFor('b'.repeat(64)), ...patch };
    expect(() => parseProjectElementList(listBody([bad]), 'project')).toThrow('invalid project element entry');
  });

  it.each([
    ['an unknown element kind', { packId: 'project_pack', kind: 'sound', id: 'blocks', revision: 'r1' }],
    ['an empty revision', { packId: 'project_pack', kind: 'effect', id: 'blocks', revision: '' }],
    ['a missing pack id', { kind: 'effect', id: 'blocks', revision: 'r1' }],
  ])('rejects an entry whose ref has %s', async (_label, ref) => {
    const { parseProjectElementList } = await loader();
    const bad = { ...entryFor('b'.repeat(64)), ref };
    expect(() => parseProjectElementList(listBody([bad]), 'project')).toThrow('inexact project element ref');
  });

  it('rejects two entries with the same exact ref', async () => {
    const { parseProjectElementList } = await loader();
    const digest = 'b'.repeat(64);
    expect(() => parseProjectElementList(listBody([entryFor(digest), entryFor(digest)]), 'project'))
      .toThrow('listed the element blocks twice');
  });
});

describe('Runtime project element list fixture', () => {
  it('parses the committed Runtime response exactly, with every ref, digest, descriptor and authoring kept', async () => {
    const { parseProjectElementList } = await loader();
    const list = parseProjectElementList(fixture, fixture.projectId);
    expect(list).toEqual({ version: 1, projectId: fixture.projectId, realmId: fixture.realmId,
      selectionDigest: fixture.selectionDigest, projects: fixture.projects, elements: fixture.elements });
  });
});

describe('reading the project list', () => {
  it('asks the Runtime for the project list with no-store and the same-origin credential policy', async () => {
    origin = 'http://127.0.0.1:17340';
    const { readProjectElementList } = await loader();
    fetchMock.mockResolvedValue({ ok: true, redirected: false, json: async () => listBody([]) });
    const controller = new AbortController();

    await expect(readProjectElementList('project', controller.signal)).resolves.toMatchObject({ projectId: 'project', elements: [] });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17340/api/runtime/packs/project-elements?project=project',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin', signal: controller.signal }),
    );
  });

  it('names the inspect/admit remedy when the Runtime refuses the list', async () => {
    const { readProjectElementList } = await loader();
    fetchMock.mockResolvedValue({ ok: false, redirected: false });
    await expect(readProjectElementList('project', new AbortController().signal))
      .rejects.toThrow('inspect/admit the project pack');
  });
});

describe('importing one admitted bundle', () => {
  it('rejects bytes that do not match the digest the Runtime admitted, without importing them', async () => {
    const { importProjectElement } = await loader();
    const admitted = digestOf(COMPONENT_SOURCE);
    fetchMock.mockResolvedValue({ ok: true, redirected: false, arrayBuffer: async () => new TextEncoder().encode('export default 1;').buffer });
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');

    await expect(importProjectElement(entryFor(admitted), new AbortController().signal))
      .rejects.toThrow('does not match the digest the Runtime admitted');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('refuses to run without the host import map, naming the rebuild fix', async () => {
    const { importProjectElement } = await loader();
    installImportMap(null);
    fetchMock.mockResolvedValue({ ok: true, redirected: false, arrayBuffer: async () => new TextEncoder().encode(COMPONENT_SOURCE).buffer });

    await expect(importProjectElement(entryFor(digestOf(COMPONENT_SOURCE)), new AbortController().signal))
      .rejects.toThrow('no import map for react, react/jsx-runtime, remotion');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('imports the verified bytes from a blob URL and returns the default-exported component', async () => {
    const { importProjectElement } = await loader();
    const bytes = new TextEncoder().encode(COMPONENT_SOURCE);
    fetchMock.mockResolvedValue({ ok: true, redirected: false, arrayBuffer: async () => bytes.buffer.slice(0) });
    const blobs = new Map<string, Blob>();
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
      const url = `blob:admitted/${blobs.size}`;
      blobs.set(url, blob as Blob);
      return url;
    });
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL');
    const Blocks = () => null;
    // Vitest cannot evaluate a blob URL, so the seam stands in for the browser's import(); it still receives the blob URL
    // and must see exactly the verified bytes.
    const importModule = vi.fn(async (url: string) => {
      const blob = blobs.get(url);
      if (!blob) throw new Error(`unknown module ${url}`);
      expect(await readBlobText(blob)).toBe(COMPONENT_SOURCE);
      return { default: Blocks };
    });

    const component = await importProjectElement(entryFor(digestOf(COMPONENT_SOURCE)), new AbortController().signal, importModule);

    expect(component).toBe(Blocks);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect((createObjectURL.mock.calls[0][0] as Blob).type).toBe('text/javascript');
    expect(importModule).toHaveBeenCalledWith('blob:admitted/0');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:admitted/0');
  });

  it('rejects a bundle that does not default-export its component', async () => {
    const { importProjectElement } = await loader();
    const source = 'export const notDefault = 1;';
    fetchMock.mockResolvedValue({ ok: true, redirected: false, arrayBuffer: async () => new TextEncoder().encode(source).buffer });

    await expect(importProjectElement(entryFor(digestOf(source)), new AbortController().signal, async () => ({ notDefault: 1 }) as { default?: unknown }))
      .rejects.toThrow('must default-export its component');
  });

  it('reports a bundle that fails to evaluate with the element id', async () => {
    const { importProjectElement } = await loader();
    const source = 'throw new Error("boom");';
    fetchMock.mockResolvedValue({ ok: true, redirected: false, arrayBuffer: async () => new TextEncoder().encode(source).buffer });

    await expect(importProjectElement(entryFor(digestOf(source)), new AbortController().signal,
      async () => { throw new Error('boom'); })).rejects.toThrow('Project element blocks failed to load: boom');
  });
});

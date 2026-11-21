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
const BINDINGS = Object.fromEntries((['react', 'react/jsx-runtime', 'remotion'] as const).map((specifier, index) => [
  specifier, { url: `/assets/shared-${index}.js`, sha256: String(index).repeat(64), version: '1.0.0' },
]));
const IMPORT_MAP = JSON.stringify({ imports: Object.fromEntries(Object.entries(BINDINGS).map(([name, binding]) => [name, binding.url])) });
const LOCK = JSON.stringify({ version: 1, shared_modules: BINDINGS });

function installScript(id: string, type: string, body: string | null) {
  document.getElementById(id)?.remove();
  if (body === null) return;
  const script = document.createElement('script');
  script.type = type;
  script.id = id;
  script.textContent = body;
  document.head.appendChild(script);
}
function installImportMap(body: string | null = IMPORT_MAP, lock: string | null = body === null ? null : LOCK) {
  installScript('astrid-extension-importmap', 'importmap', body);
  installScript('astrid-extension-shared-modules', 'application/json', lock);
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
    descriptor: { id: 'blocks', kind: 'effect', packId: 'project_pack', revision, label: 'Blocks', description: '', componentPath: 'elements/blocks/component.tsx',
      parameters: [], defaults: {}, renderability: { preview: 'supported', browserExport: 'supported', workerExport: 'unknown' } } as never,
    authoring: { packRoot: '/canonical', descriptorPath: '/canonical/element.yaml', componentPath: '/canonical/component.tsx', status: 'ready' },
  };
}

function listBody(elements: unknown[], overrides: Record<string, unknown> = {}) {
  return { version: 1, projectId: 'project', selectionDigest: 'a'.repeat(64), legacy: [], projects: [], realmId: 'realm', elements, ...overrides };
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

  it('keeps the legacy refs the Runtime lists by name', async () => {
    const { parseProjectElementList } = await loader();
    const legacy = [{ packId: 'project_pack', kind: 'effect', id: 'old' }];
    expect(parseProjectElementList(listBody([], { legacy }), 'project').legacy).toEqual(legacy);
  });

  it.each([
    ['no legacy field', (body: Record<string, unknown>) => { const { legacy: _legacy, ...rest } = body; return rest; }],
    ['a malformed legacy ref', (body: Record<string, unknown>) => ({ ...body, legacy: [{ packId: 'p', kind: 'sound', id: 'x' }] })],
  ])('rejects a list with %s', async (_label, mutate) => {
    const { parseProjectElementList } = await loader();
    expect(() => parseProjectElementList(mutate(listBody([])), 'project')).toThrow('invalid project element list');
  });

  it.each([
    ['no renderability', (d: Record<string, unknown>) => { delete d.renderability; }],
    ['a renderability without preview', (d: Record<string, unknown>) => { d.renderability = { browserExport: 'supported', workerExport: 'unknown' }; }],
    ['a non-array parameters field', (d: Record<string, unknown>) => { d.parameters = {}; }],
    ['no label', (d: Record<string, unknown>) => { delete d.label; }],
    ['a descriptor that names another element', (d: Record<string, unknown>) => { d.id = 'other'; }],
  ])('rejects an entry whose descriptor has %s as a plain failure', async (_label, mutate) => {
    const { parseProjectElementList } = await loader();
    const bad = entryFor('b'.repeat(64));
    mutate(bad.descriptor as unknown as Record<string, unknown>);
    expect(() => parseProjectElementList(listBody([bad]), 'project')).toThrow('incomplete descriptor for the element blocks');
  });

  it('rejects an entry without the authoring paths the editor shows', async () => {
    const { parseProjectElementList } = await loader();
    const bad = { ...entryFor('b'.repeat(64)), authoring: { packRoot: '/canonical' } };
    expect(() => parseProjectElementList(listBody([bad]), 'project')).toThrow('incomplete descriptor');
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
      selectionDigest: fixture.selectionDigest, legacy: fixture.legacy, projects: fixture.projects, elements: fixture.elements });
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
      .rejects.toThrow('no pinned extension import map');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a scoped import map', JSON.stringify({ imports: JSON.parse(IMPORT_MAP).imports, scopes: { '/x/': {} } }), LOCK],
    ['an import map that disagrees with the lock', IMPORT_MAP.replace('shared-0', 'shared-9'), LOCK],
    ['a lock binding with a malformed digest', IMPORT_MAP, LOCK.replace('0'.repeat(64), 'xyz')],
    ['a map missing remotion', JSON.stringify({ imports: { react: '/assets/shared-0.js' } }), LOCK],
  ])('applies the extension loader\'s check to %s', async (_label, map, lock) => {
    const { importProjectElement } = await loader();
    installImportMap(map, lock);
    await expect(importProjectElement(entryFor(digestOf(COMPONENT_SOURCE)), new AbortController().signal))
      .rejects.toThrow(/Singleton binding mismatch|pinned import map/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never evaluates a bundle whose project was left while its bytes were being fetched', async () => {
    const { importProjectElement } = await loader();
    const controller = new AbortController();
    let release!: () => void;
    fetchMock.mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: true, redirected: false, arrayBuffer: async () => new TextEncoder().encode(COMPONENT_SOURCE).buffer };
    });
    const importModule = vi.fn(async () => ({ default: () => null }));
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');

    const pending = importProjectElement(entryFor(digestOf(COMPONENT_SOURCE)), controller.signal, importModule);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    controller.abort();
    release();

    await expect(pending).rejects.toThrow();
    expect(importModule).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
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

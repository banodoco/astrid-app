// Passive open (Plan 06, PK-14): opening a project never installs, fetches or runs a pack.
//
// Opening a project mounts the editor page, whose only pack I/O is the installed-pack hook
// (`useRuntimePackExtensions`). The Runtime HTTP boundary is the only fake here: every request the open makes is
// recorded and judged. A read of the installed inventory is allowed; an install, an asset fetch or a lease (the
// step that precedes running an admitted module) is not.
import { createHash } from 'node:crypto';
import { renderHook, waitFor } from '@testing-library/react';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIndexedDBExtensionStateRepository } from './extensionStateRepositoryIndexedDB';
import { useRuntimePackExtensions } from './useRuntimePackExtensions';

const INVENTORY = '/api/runtime/packs/inventory';
const HEX = (char: string) => char.repeat(64);

interface Seen { url: string; method: string }

function inventoryResponse(packs: unknown[]) {
  return new Response(JSON.stringify({ version: 1, revision: packs.length, packs }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

const SHARED_SPECIFIERS = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'remotion', '@astrid/editor-sdk'];
const SHARED_MODULES = Object.fromEntries(SHARED_SPECIFIERS.map((specifier, index) => [specifier,
  { sha256: HEX(String(index + 1)), version: '1.0.0', url: `/assets/shared-${index}.js` }]));

/** The builder's and Runtime's canonical JSON (sorted keys), so the admission digest is the one the loader recomputes. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The host page's pinned import map and shared-module lock, as the production build emits them. */
function installHostImportMap() {
  const map = document.createElement('script');
  map.id = 'astrid-extension-importmap';
  map.type = 'importmap';
  map.textContent = JSON.stringify({ imports: Object.fromEntries(SHARED_SPECIFIERS.map((specifier) => [specifier, SHARED_MODULES[specifier].url])) });
  const lock = document.createElement('script');
  lock.id = 'astrid-extension-shared-modules';
  lock.type = 'application/json';
  lock.textContent = JSON.stringify({ version: 1, shared_modules: SHARED_MODULES });
  document.head.append(map, lock);
  return () => { map.remove(); lock.remove(); };
}

/** A complete Runtime admission of a pack whose editor effect the project names: everything the loader checks before it leases and imports. */
function admittedPack() {
  const extensionManifest = {
    id: 'com.astrid.test.live-effect', version: '1.0.0', apiVersion: 1, label: 'Live effect',
    publisher: 'Astrid PK-14 fixture', license: 'MIT', settingsSchema: { version: 1 },
    contributions: [{ id: 'effect', kind: 'effect', effectId: 'live-effect' }],
  };
  const artifactManifest = {
    version: 1, packId: 'live_effect', sourceDigest: HEX('a'), digest: HEX('b'), graphIndexDigest: HEX('c'),
    toolchainDigest: HEX('d'), entry: 'index.js', extensionManifest, sharedModules: SHARED_MODULES,
    files: [{ path: 'index.js', sha256: HEX('b'), mime: 'text/javascript' }],
  };
  return {
    packId: 'live_effect', sourceDigest: HEX('a'), digest: HEX('b'),
    artifactManifestDigest: createHash('sha256').update(canonical(artifactManifest)).digest('hex'),
    enabled: true, url: `/api/runtime/packs/assets/live_effect/${HEX('b')}/index.js`, artifactManifest,
  };
}

function recordFetch(packs: unknown[]) {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    if (url === INVENTORY) return inventoryResponse(packs);
    return new Response('{"error":"not expected on open"}', { status: 404 });
  }));
  return seen;
}

/** Every pack request an open made, with the reads of the installed inventory set aside. */
function packWork(seen: Seen[]) {
  return seen.filter((request) => !(request.url === INVENTORY && request.method === 'GET'));
}

/** Mount the editor's pack wiring as a project open does, wait for it to settle, then close the project. */
async function openProject(seen: Seen[]) {
  const before = seen.length;
  const { result, unmount } = renderHook(() => useRuntimePackExtensions(undefined, 25));
  await waitFor(() => expect(seen.length).toBeGreaterThan(before));
  await waitFor(() => expect(result.current.isResolving).toBe(false));
  // Let a few refresh ticks pass so anything the open schedules has had its chance to run.
  await new Promise((resolve) => setTimeout(resolve, 120));
  const state = { resolved: result.current.resolvedExtensions, entries: result.current.packageStateEntries };
  unmount();
  return state;
}

describe('project open is passive', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opening a project that names an uninstalled pack effect never installs, fetches or runs a pack', async () => {
    const seen = recordFetch([]);
    // Open a project, then open another one: each open reads the installed inventory and does nothing else.
    const first = await openProject(seen);
    const second = await openProject(seen);

    expect(seen.length).toBeGreaterThan(0);
    expect(packWork(seen), 'an open only reads the installed inventory').toEqual([]);
    expect(seen.some((request) => /install/i.test(request.url))).toBe(false);
    expect(first.resolved).toEqual([]);
    expect(second.resolved).toEqual([]);

    const repository = createIndexedDBExtensionStateRepository();
    await repository.initialize();
    expect(await repository.getAllPackRecords(), 'nothing is recorded as installed by an open').toEqual([]);
    await repository.dispose();
  });

  it('opening a project never runs an installed pack the user disabled', async () => {
    const removeImportMap = installHostImportMap();
    const pack = admittedPack();
    const repository = createIndexedDBExtensionStateRepository();
    await repository.initialize();
    await repository.putEnablementState({
      extensionId: pack.artifactManifest.extensionManifest.id, enabled: false,
      lastToggledAt: new Date(0).toISOString(), toggleReason: 'user disabled via manager',
    });
    await repository.dispose();
    const seen = recordFetch([pack]);

    const opened = await openProject(seen);

    // Running an admitted module starts with a lease and an asset import: neither happens for a disabled pack.
    expect(packWork(seen), 'no lease, asset or install request on open').toEqual([]);
    expect(opened.resolved.map((extension) => extension.manifest.id)).not.toContain('com.astrid.test.live-effect');
    removeImportMap();
  });
});

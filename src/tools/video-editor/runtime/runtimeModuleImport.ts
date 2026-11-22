/* eslint-disable @typescript-eslint/no-explicit-any -- moved verbatim from extensionLoader: artifact and lock JSON are untrusted and validated field by field. */
import { computeSha256 } from './extensionIntegrity';

/**
 * The one way the editor brings Runtime-served modules into the page: the host's pinned import map is checked against
 * its lock, and every import goes through one `import()` site. Both the extension loader (entry plus its chunks, by
 * URL) and the admitted-element loader (one bundle, digest-verified bytes from a blob URL) use these.
 */

/** Build-time singleton bindings; the browser never constructs an import map. */
export const SHARED_SPECIFIERS = [
  'react', 'react/jsx-runtime', 'react/jsx-dev-runtime',
  'react-dom/client', 'remotion', '@astrid/editor-sdk',
] as const;
export const IMPORT_MAP_ID = 'astrid-extension-importmap';
export const SHARED_MODULES_ID = 'astrid-extension-shared-modules';
export const SHA256 = /^[a-f0-9]{64}$/;

export const isRecord = (value: unknown): value is Record<string, any> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** Canonical JSON used by the builder and Runtime for artifact identity M. */
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A host that cannot run Runtime-served modules (no pinned map, wrong bindings). The message is the plain reason. */
export class SharedModulesError extends Error {}

/**
 * Verifies the document's pinned import map against its shared-module lock for the `required` specifiers: the map is a
 * plain `imports` map (no scopes), and each required specifier binds exactly the URL the lock records, with a valid
 * digest, version and /assets/ URL. When `expected` (an artifact's `sharedModules`) is given, it must name exactly the
 * required specifiers with bindings identical to the lock. Fails closed in development builds, which emit no lock.
 */
export function assertHostSharedModules(
  required: readonly (typeof SHARED_SPECIFIERS)[number][],
  expected?: Record<string, unknown>,
): void {
  const mapElement = document.getElementById(IMPORT_MAP_ID);
  const lockElement = document.getElementById(SHARED_MODULES_ID);
  let map: any;
  let lock: any;
  try {
    map = JSON.parse(mapElement?.textContent ?? '');
    const envelope = JSON.parse(lockElement?.textContent ?? '');
    if (envelope.version !== 1) throw new Error('Unsupported shared-module lock');
    lock = envelope.shared_modules;
  } catch {
    throw new SharedModulesError('The host build has no pinned extension import map.');
  }
  if (mapElement?.getAttribute('type') !== 'importmap' || !isRecord(map?.imports) || map.scopes !== undefined || !isRecord(lock)
    || (expected !== undefined && canonical(Object.keys(expected).sort()) !== canonical([...required].sort()))) {
    throw new SharedModulesError(expected !== undefined
      ? 'All six host singleton bindings are required.'
      : `The editor page needs a pinned import map binding ${required.join(', ')}.`);
  }
  for (const specifier of required) {
    const binding = expected ? expected[specifier] : lock[specifier];
    if (!isRecord(binding) || !SHA256.test(binding.sha256) || typeof binding.version !== 'string'
      || typeof binding.url !== 'string' || !/^\/assets\/[a-zA-Z0-9_.-]+\.js$/.test(binding.url)
      || map.imports[specifier] !== binding.url || canonical(binding) !== canonical(lock[specifier])) {
      throw new SharedModulesError(`Singleton binding mismatch for ${specifier}. Rebuild against this host release.`);
    }
  }
}

/** Reads one Runtime-served file and returns its bytes only when they hash to the digest the Runtime named. */
export async function fetchVerifiedBytes(url: string, digest: string, signal: AbortSignal, label: string,
  refusal?: (response: Response) => Promise<string | undefined>): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal });
  if (!response.ok || response.redirected) {
    const reason = !response.redirected && refusal ? await refusal(response) : undefined;
    signal.throwIfAborted();
    throw new Error(reason ?? `${label} could not be read from the Runtime.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (await computeSha256(bytes) !== digest) {
    throw new Error(`${label} does not match the digest the Runtime admitted; reload the editor.`);
  }
  return bytes;
}

/** The single dynamic import of a Runtime-served module; bare specifiers inside it resolve through the pinned map. */
export function importRuntimeModule(url: string): Promise<any> {
  return import(/* @vite-ignore */ url);
}

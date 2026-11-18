import type { ComponentType } from 'react';
import { runtimeApiBase, runtimeOrigin } from '@/integrations/runtime/connection';
import { computeSha256 } from './extensionIntegrity';
import type { AdmittedDescriptor, AdmittedElement, ProjectElementAuthoring } from './admitted-elements';
import type { AstridElementComponentProps } from './astrid-element-host';

/**
 * Project pack elements as the Runtime admitted them. The Runtime lists the project's admitted refs and serves each
 * compiled ESM bundle by its sha256 digest; the editor verifies the bytes before importing them.
 */
export type ElementRef = { packId: string; kind: 'effect' | 'animation' | 'transition'; id: string; revision: string };
export type ProjectElementEntry = {
  ref: ElementRef; digest: string; url: string;
  descriptor: AdmittedDescriptor; authoring: AdmittedElement['authoring'];
};
export type ProjectElementList = {
  version: 1; projectId: string; realmId: string; selectionDigest: string;
  projects: readonly ProjectElementAuthoring[]; elements: readonly ProjectElementEntry[];
};
export type ProjectElementComponent = ComponentType<AstridElementComponentProps>;

const SHA256 = /^[a-f0-9]{64}$/;
const KINDS = new Set(['effect', 'animation', 'transition']);
/** Bare specifiers the admitted bundles leave external; the document's import map must bind each one. */
const HOST_SPECIFIERS = ['react', 'react/jsx-runtime', 'remotion'] as const;
const IMPORT_MAP_ID = 'astrid-extension-importmap';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const runtimeOriginPath = (projectId: string, digest: string) => (
  `${runtimeApiBase()}/packs/project-elements/${encodeURIComponent(projectId)}/${digest}.js`.slice(runtimeOrigin().length)
);

export const elementKey = (ref: ElementRef) => JSON.stringify([ref.packId, ref.kind, ref.id, ref.revision]);

/**
 * Validates the Runtime's list shape for the project the editor asked about. The Runtime names the project by the
 * request, so the list carries no project id of its own; nothing here trusts a value the Runtime did not name exactly.
 */
export function parseProjectElementList(value: unknown, projectId: string): ProjectElementList {
  if (!record(value) || value.version !== 1 || typeof value.realmId !== 'string' || !value.realmId
    || typeof value.selectionDigest !== 'string' || !SHA256.test(value.selectionDigest)
    || !Array.isArray(value.projects) || !Array.isArray(value.elements)) {
    throw new Error('Runtime returned an invalid project element list.');
  }
  const keys = new Set<string>();
  const elements = value.elements.map((entry): ProjectElementEntry => {
    if (!record(entry) || !record(entry.ref) || typeof entry.digest !== 'string' || !SHA256.test(entry.digest)
      || entry.url !== runtimeOriginPath(projectId, entry.digest) || !record(entry.descriptor) || !record(entry.authoring)) {
      throw new Error('Runtime returned an invalid project element entry.');
    }
    const ref = entry.ref;
    if (typeof ref.packId !== 'string' || !ref.packId || typeof ref.id !== 'string' || !ref.id
      || typeof ref.revision !== 'string' || !ref.revision || typeof ref.kind !== 'string' || !KINDS.has(ref.kind)) {
      throw new Error('Runtime returned an inexact project element ref.');
    }
    const key = elementKey(ref as unknown as ElementRef);
    if (keys.has(key)) throw new Error(`Runtime listed the element ${ref.id} twice.`);
    keys.add(key);
    return entry as unknown as ProjectElementEntry;
  });
  return { version: 1, projectId, realmId: value.realmId, selectionDigest: value.selectionDigest,
    projects: value.projects as ProjectElementAuthoring[], elements };
}

/** Reads the project's currently admitted refs. Re-read on every call; nothing is cached on the Runtime's side. */
export async function readProjectElementList(projectId: string, signal: AbortSignal): Promise<ProjectElementList> {
  const response = await fetch(`${runtimeApiBase()}/packs/project-elements?project=${encodeURIComponent(projectId)}`, {
    cache: 'no-store', credentials: 'same-origin', signal,
  });
  if (!response.ok || response.redirected) {
    throw new Error('Pack admission is unavailable or invalid; inspect/admit the project pack before applying a ref.');
  }
  return parseProjectElementList(await response.json(), projectId);
}

/** The browser's import map is the only place bare specifiers resolve; a page without it cannot run any admitted element. */
function assertHostImportMap(): void {
  const element = document.getElementById(IMPORT_MAP_ID);
  let imports: unknown;
  try { imports = element?.getAttribute('type') === 'importmap' ? JSON.parse(element.textContent ?? '').imports : undefined; } catch { imports = undefined; }
  const missing = HOST_SPECIFIERS.filter(specifier => !record(imports) || typeof imports[specifier] !== 'string');
  if (missing.length) throw new Error(`The editor page has no import map for ${missing.join(', ')}. Rebuild the editor or restart the dev server.`);
}

/**
 * Fetches one admitted bundle, verifies its bytes against the digest the Runtime named, then imports the verified bytes
 * themselves (from a blob URL), so the executed module is exactly what was hashed.
 */
export async function importProjectElement(
  entry: ProjectElementEntry,
  signal: AbortSignal,
  importModule: (url: string) => Promise<{ default?: unknown }> = (url) => import(/* @vite-ignore */ url),
): Promise<ProjectElementComponent> {
  assertHostImportMap();
  const response = await fetch(`${runtimeOrigin()}${entry.url}`, { cache: 'no-store', credentials: 'same-origin', signal });
  if (!response.ok || response.redirected) throw new Error(`Project element ${entry.ref.id} could not be read from the Runtime.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (await computeSha256(bytes) !== entry.digest) {
    throw new Error(`Project element ${entry.ref.id} does not match the digest the Runtime admitted; reload the editor.`);
  }
  const moduleUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
  let namespace: { default?: unknown };
  try {
    namespace = await importModule(moduleUrl);
  } catch (error) {
    throw new Error(`Project element ${entry.ref.id} failed to load: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
  if (typeof namespace.default !== 'function') throw new Error(`Project element ${entry.ref.id} must default-export its component.`);
  return namespace.default as ProjectElementComponent;
}

import type { ComponentType } from 'react';
import { runtimeApiBase, runtimeOrigin } from '@/integrations/runtime/connection';
import { assertHostSharedModules, fetchVerifiedBytes, importRuntimeModule, isRecord as record, SHA256, SharedModulesError } from './runtimeModuleImport';
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
  refusal?: string;
};
/** An element admitted before the Runtime kept its compiled bundle: listed by name, never loadable until re-admitted. */
export type LegacyElementRef = { packId: string; kind: ElementRef['kind']; id: string };
export type ProjectElementList = {
  version: 1; projectId: string; realmId: string; selectionDigest: string; legacy: readonly LegacyElementRef[];
  projects: readonly ProjectElementAuthoring[]; elements: readonly ProjectElementEntry[];
};
export type ProjectElementComponent = ComponentType<AstridElementComponentProps>;

const KINDS = new Set(['effect', 'animation', 'transition']);
const SUPPORT = new Set(['supported', 'blocked', 'unknown']);
const RENDERABILITY_KEYS = ['preview', 'browserExport', 'workerExport'] as const;
/** Bare specifiers the admitted bundles leave external; the document's pinned import map must bind each one. */
const HOST_SPECIFIERS = ['react', 'react/jsx-runtime', 'remotion'] as const;

const text = (value: unknown): value is string => typeof value === 'string';
const allText = (value: Record<string, unknown>, keys: readonly string[]) => keys.every(key => text(value[key]));
/** The descriptor fields the editor's catalog and placeholders read, so a consumer never meets a missing one. */
const validDescriptor = (descriptor: Record<string, unknown>, ref: Record<string, unknown>) => {
  const renderability = descriptor.renderability;
  return text(descriptor.packId) && !!descriptor.packId && descriptor.kind === ref.kind && descriptor.id === ref.id && descriptor.revision === ref.revision
    && allText(descriptor, ['label', 'description', 'componentPath']) && !!descriptor.label && !!descriptor.componentPath
    && Array.isArray(descriptor.parameters) && descriptor.parameters.every((parameter: unknown) => record(parameter) && text(parameter.name) && text(parameter.type))
    && record(descriptor.defaults) && record(renderability) && Object.keys(renderability).length === RENDERABILITY_KEYS.length
    && RENDERABILITY_KEYS.every(key => {
      const status = renderability[key];
      return text(status) && SUPPORT.has(status);
    });
};
const validAuthoring = (authoring: Record<string, unknown>) => allText(authoring, ['packRoot', 'descriptorPath', 'componentPath', 'status']);
const validProject = (project: unknown) => record(project)
  && allText(project, ['projectId', 'packId', 'packRoot', 'status', 'initCommand', 'admitCommand', 'inspectCommand']);
const validLegacy = (entry: unknown) => record(entry) && text(entry.packId) && !!entry.packId && text(entry.id) && !!entry.id
  && text(entry.kind) && KINDS.has(entry.kind);

const runtimeOriginPath = (projectId: string, digest: string) => (
  `${runtimeApiBase()}/packs/project-elements/${encodeURIComponent(projectId)}/${digest}.js`.slice(runtimeOrigin().length)
);

export const elementKey = (ref: ElementRef) => JSON.stringify([ref.packId, ref.kind, ref.id, ref.revision]);

/**
 * Validates the Runtime's list shape for the project the editor asked about. The list must name that same project;
 * nothing here trusts a value the Runtime did not name exactly.
 */
export function parseProjectElementList(value: unknown, projectId: string): ProjectElementList {
  if (!record(value) || value.version !== 1 || value.projectId !== projectId || typeof value.realmId !== 'string' || !value.realmId
    || typeof value.selectionDigest !== 'string' || !SHA256.test(value.selectionDigest)
    || !Array.isArray(value.projects) || !value.projects.every(validProject)
    || !Array.isArray(value.legacy) || !value.legacy.every(validLegacy) || !Array.isArray(value.elements)) {
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
    if (!validDescriptor(entry.descriptor, ref) || !validAuthoring(entry.authoring)) {
      throw new Error(`Runtime returned an incomplete descriptor for the element ${ref.id}.`);
    }
    const key = elementKey(ref as unknown as ElementRef);
    if (keys.has(key)) throw new Error(`Runtime listed the element ${ref.id} twice.`);
    keys.add(key);
    if (entry.descriptor.packId !== ref.packId) {
      return { ...entry, refusal: `Project element ${ref.id} has a mismatched pack owner.` } as unknown as ProjectElementEntry;
    }
    return entry as unknown as ProjectElementEntry;
  });
  return { version: 1, projectId, realmId: value.realmId, selectionDigest: value.selectionDigest,
    legacy: value.legacy as LegacyElementRef[], projects: value.projects as ProjectElementAuthoring[], elements };
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

/**
 * Fetches one admitted bundle, verifies its bytes against the digest the Runtime named, then imports the verified bytes
 * themselves (from a blob URL), so the executed module is exactly what was hashed.
 *
 * `signal` is the project's lifetime: it is checked after the fetch and BEFORE the module is evaluated, so a bundle
 * fetched for a project the editor has since left is never evaluated. Once `import()` has begun the bytes execute and
 * that cannot be undone; the caller still never publishes the result of an aborted request.
 */
export async function importProjectElement(
  entry: ProjectElementEntry,
  signal: AbortSignal,
  importModule: (url: string) => Promise<{ default?: unknown }> = importRuntimeModule,
): Promise<ProjectElementComponent> {
  if (entry.refusal) throw new Error(entry.refusal);
  try { assertHostSharedModules(HOST_SPECIFIERS); } catch (error) {
    if (error instanceof SharedModulesError) throw new Error(`${error.message} Rebuild the editor or reload it.`);
    throw error;
  }
  const bytes = await fetchVerifiedBytes(`${runtimeOrigin()}${entry.url}`, entry.digest, signal, `Project element ${entry.ref.id}`, async response => {
    if (response.status !== 409) return;
    let body: unknown;
    try { body = await response.json(); } catch { return; }
    signal.throwIfAborted();
    if (record(body) && record(body.details) && body.details.reason === 'project_element_binding_missing') {
      return 'This project element was admitted by a pre-release build. Change its component source, admit the element again, then place the new revision on the clip.';
    }
  });
  signal.throwIfAborted();
  const moduleUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
  let namespace: { default?: unknown };
  try {
    namespace = await importModule(moduleUrl);
  } catch (error) {
    throw new Error(`Project element ${entry.ref.id} failed to load: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
  signal.throwIfAborted();
  if (typeof namespace.default !== 'function') throw new Error(`Project element ${entry.ref.id} must default-export its component.`);
  return namespace.default as ProjectElementComponent;
}

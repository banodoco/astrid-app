import type { AstridElementDescriptor } from './astrid-element-host';
import { ASTRID_BRIDGE_REQUEST_TIMEOUT_MS } from '../data/astridBridgeWire';
import { elementKey, importProjectElement, readProjectElementList, type ElementRef, type ProjectElementComponent, type ProjectElementEntry, type LegacyElementRef, type ProjectElementList } from './admittedElementLoader';

export type AdmittedDescriptor = AstridElementDescriptor & {label:string; description:string; parameters:import('../types/index').ParameterSchema; defaults:Record<string,unknown>; renderability:{preview:'supported'|'blocked'|'unknown';browserExport:'supported'|'blocked'|'unknown';workerExport:'supported'|'blocked'|'unknown'}};
export type ProjectElementAuthoring = {
  projectId: string; packId: string; packRoot: string; status: string;
  initCommand: string; admitCommand: string; inspectCommand: string;
};
export type AdmittedElement = {
  projectId: string; descriptor: AdmittedDescriptor;
  authoring: {packRoot: string; descriptorPath: string; componentPath: string; status: string};
};
export type AdmittedElementSelection = {
  projectId: string | null; selectionDigest: string; realmId: string | null;
  projects: readonly ProjectElementAuthoring[]; elements: readonly AdmittedElement[];
  components: Readonly<Record<string, ProjectElementComponent>>;
};
const refKey = elementKey;
const listeners = new Set<() => void>();
// Pack selection talks to the same local Runtime as editor data requests.
// Reuse its request budget for the list read plus browser module admission.
export const ADMITTED_ELEMENT_LOAD_TIMEOUT_MS = ASTRID_BRIDGE_REQUEST_TIMEOUT_MS;
type AdmissionReadiness = {projectId: string | null; refKeys: readonly string[]; phase: 'idle' | 'loading' | 'ready' | 'error'; error: string | null;
  /** Elements the Runtime lists by name only (admitted before it kept their bundles); they need re-admitting. */
  legacy: readonly LegacyElementRef[]; failures: Readonly<Record<string, string>>};
export const LEGACY_ELEMENT_REASON = 'Project elements admitted before this version need re-admitting: run project-pack admit again.';
export const isLegacyElementRef = (ref: {packId?: string; kind: string; id: string}) => (
  readiness.legacy.some(entry => entry.packId === ref.packId && entry.kind === ref.kind && entry.id === ref.id)
);
const readinessListeners = new Set<() => void>();
let readiness: AdmissionReadiness = {projectId: null, refKeys: [], phase: 'idle', error: null, legacy: [], failures: {}};
const publishReadiness = (next: AdmissionReadiness) => {
  readiness = next;
  readinessListeners.forEach(listener => listener());
};
export const getAdmittedElementReadiness = () => readiness;
export const subscribeAdmittedElementReadiness = (listener: () => void) => {
  readinessListeners.add(listener);
  return () => { readinessListeners.delete(listener); };
};
const EMPTY_SELECTION: AdmittedElementSelection = Object.freeze({projectId: null, selectionDigest: 'empty', realmId: null,
  projects: Object.freeze([]), elements: Object.freeze([]), components: Object.freeze({})});
let current: AdmittedElementSelection = EMPTY_SELECTION;
// What the last published selection was built from; a refresh that resolves to the same inputs keeps the same object.
let currentSignature = '';
// A verified module can be reused only after Runtime authorized this exact scoped ref and digest.
const importedByDigest = new Map<string, ProjectElementComponent>();
let generation = 0;
// The in-flight refresh's fetches. A scope change or a newer refresh aborts them, so a module requested for one
// project is never fetched on, evaluated or published once the editor has moved on.
let inFlight: AbortController | null = null;
let lastLoggedFailure: string | null = null;
let scope: {projectId:string;refs:Array<ElementRef>}|null=null;
export function setAdmittedElementScope(projectId:string,refs:NonNullable<typeof scope>['refs']) {
  const next={projectId,refs:[...new Map(refs.map(ref=>[refKey(ref),ref])).values()].sort((a,b)=>refKey(a).localeCompare(refKey(b)))};
  if(JSON.stringify(scope)===JSON.stringify(next))return;
  const changed=scope?.projectId!==projectId;scope=next;++generation;inFlight?.abort();
  publishReadiness({projectId, refKeys: next.refs.map(refKey), phase: 'loading', error: null, legacy: changed ? [] : readiness.legacy, failures: {}});
  if(changed){current={...EMPTY_SELECTION,projectId};currentSignature='';listeners.forEach(listener=>listener());}
}

export const getAdmittedElementSelection = () => current;
export const subscribeAdmittedElements = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/**
 * Native receiving-build refresh, independent of mounted editor/ACP authority.
 * `read` lists the project's admitted refs from the Runtime; `load` verifies and imports one listed bundle.
 * Always resolves: a failed list or import is recorded as the readiness `error` with its reason and returns the
 * selection as it was (elements not loaded stay unloaded).
 */
export async function refreshAdmittedElements(
  read?: () => Promise<ProjectElementList | null>,
  load?: (entry: ProjectElementEntry) => Promise<ProjectElementComponent>,
): Promise<AdmittedElementSelection> {
  const controller = new AbortController();
  const loadEntry = load ?? ((entry: ProjectElementEntry) => importProjectElement(entry, controller.signal));
  const requestedScope = scope;
  const readList = read ?? (async () => (requestedScope ? readProjectElementList(requestedScope.projectId, controller.signal) : null));
  const request = ++generation;
  inFlight?.abort();
  inFlight = controller;
  const requestedReadiness = {...readiness, phase: 'loading' as const, error: null, failures: {}};
  publishReadiness(requestedReadiness);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Preview pack loading timed out. Check the local connection and inspect/admit the project pack, then reload the editor.'));
      controller.abort();
    }, ADMITTED_ELEMENT_LOAD_TIMEOUT_MS);
  });
  let importFailures: Record<string, string> = {};
  try {
    const list = await Promise.race([readList(), deadline]);
    if (request !== generation) return current;
    if (!list) {
      publishReadiness({...requestedReadiness, phase:'ready', legacy: []});
      return current;
    }
    if (requestedScope && list.projectId !== requestedScope.projectId) throw new Error('Element selection belongs to another project');
    if (current.realmId !== null && list.realmId !== current.realmId) throw new Error('Element selection realm changed; reload the editor.');
    // Only the active exact requested pins are loaded. Missing pins stay unavailable; never substitute newest code.
    const wanted = list.elements.filter(entry => !requestedScope || requestedScope.refs.some(ref => refKey(ref) === refKey(entry.ref)));
    const outcomes = await Promise.all(wanted.map(async entry => {
      try {
        if (entry.refusal) return { error: entry.refusal };
        const component = await Promise.race([(async () => {
          const cacheKey = JSON.stringify([list.realmId, list.projectId, refKey(entry.ref), entry.digest]);
          const imported = importedByDigest.get(cacheKey);
          if (imported) return imported;
          if (request !== generation) throw new DOMException('The editor moved to another project.', 'AbortError');
          const component = await loadEntry(entry);
          if (request !== generation || controller.signal.aborted) throw new DOMException('The editor moved to another project.', 'AbortError');
          if (typeof component !== 'function') throw new Error(`Project element ${entry.ref.id} is not a component.`);
          importedByDigest.set(cacheKey, component);
          while (importedByDigest.size > 128) importedByDigest.delete(importedByDigest.keys().next().value!);
          return component;
        })(), deadline]);
        return { component };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }));
    if (request !== generation) return current;
    const failures: Record<string, string> = importFailures = Object.fromEntries(wanted.flatMap((entry, index) =>
      outcomes[index].error ? [[refKey(entry.ref), outcomes[index].error!]] : []));
    if (wanted.length && Object.keys(failures).length === wanted.length && !wanted.some(entry => entry.refusal)) throw new Error(Object.values(failures)[0]);
    const loaded = wanted.filter((_, index) => outcomes[index].component);
    // A previously verified build of the same exact ref stays active if its replacement fails.
    const retained = current.projectId === list.projectId ? current.elements.filter(element =>
      failures[refKey(element.descriptor as ElementRef)] && !wanted.some(entry => entry.refusal && refKey(entry.ref) === refKey(element.descriptor as ElementRef))
      && current.components[refKey(element.descriptor as ElementRef)]) : [];
    const signature = JSON.stringify([list.projectId, list.realmId, list.selectionDigest,
      loaded.map(entry => [refKey(entry.ref), entry.digest]), retained.map(element => refKey(element.descriptor as ElementRef))]);
    if (signature === currentSignature) {
      publishReadiness({...requestedReadiness, phase:'ready', legacy: list.legacy, failures});
      return current;
    }
    // import() returns an exotic module namespace: freezing it throws even when each export is valid.
    // The published selection is a plain frozen snapshot of the components already verified above.
    current = Object.freeze({projectId: list.projectId, selectionDigest: list.selectionDigest, realmId: list.realmId,
      projects: Object.freeze([...list.projects]),
      elements: Object.freeze([...loaded.map(entry => Object.freeze({projectId: list.projectId, descriptor: entry.descriptor, authoring: entry.authoring})), ...retained]),
      components: Object.freeze(Object.fromEntries([...wanted.flatMap((entry, index) => outcomes[index].component ? [[refKey(entry.ref), outcomes[index].component]] : []),
        ...retained.map(element => [refKey(element.descriptor as ElementRef), current.components[refKey(element.descriptor as ElementRef)]])]))});
    currentSignature = signature;
    listeners.forEach(listener => listener());
    publishReadiness({...requestedReadiness, phase:'ready', legacy: list.legacy, failures});
    return current;
  } catch (error) {
    // A failed list never rejects into prompts, mount or element adapters: the readiness store carries the reason,
    // elements stay unloaded, and clips that need them show the placeholder with that reason.
    const reason = error instanceof Error ? error.message : String(error);
    if (request === generation) publishReadiness({...requestedReadiness, phase:'error', error:reason, failures: importFailures});
    if (request === generation && reason !== lastLoggedFailure) {
      lastLoggedFailure = reason;
      console.error(`Project elements unavailable: ${reason}`);
    }
    return current;
  } finally {
    clearTimeout(timeout);
    if (inFlight === controller) inFlight = null;
  }
}
export function admittedElementFailure(ref: {packId?: string; kind: string; id: string; revision: string}) {
  return readiness.failures[refKey(ref as ElementRef)];
}
export function admittedComponent(ref: {packId?: string; kind: string; id: string; revision: string}) {
  return current.components[refKey(ref as ElementRef)];
}
export function isAdmittedElementPreviewPreparing(
  projectId: string,
  refs: readonly {packId?: string; kind: string; id: string; revision: string}[],
) {
  if (!refs.length) return false;
  if (readiness.projectId !== projectId || readiness.phase === 'idle') return true;
  const missing = refs.filter(ref => !admittedComponent(ref));
  // A new config may render once before the provider's scope effect runs.
  // A completed request only settles the exact pins that it checked.
  if (missing.some(ref => !readiness.refKeys.includes(refKey(ref as ElementRef)))) return true;
  return missing.length > 0 && readiness.phase === 'loading';
}
export function projectElementAuthoring(projectId: string) {
  return current.projects.find(project => project.projectId === projectId) ?? null;
}

export function admittedCatalogEntries(projectId?: string): import('./element-contract').AstridElementCatalogEntry[] {
  return current.elements.filter(entry => !projectId || entry.projectId === projectId).map(({descriptor: d, authoring}) => ({
    admitted:true,id: d.id, packId: d.packId, kind: d.kind, revision: d.revision, label: d.label,
    description: d.description, placement: d.kind === 'transition' ? 'between-clips' : 'overlay', publication: 'published',
    schema: d.parameters as import('../types/index').ParameterSchema, defaults: d.defaults,
    capabilities: {browserPreview: d.renderability.preview, astridExport: d.renderability.browserExport, workerExport: d.renderability.workerExport},
    authoring,
  }));
}
export function projectPackContext(projectId: string) {
  const existing = projectElementAuthoring(projectId);
  const command = `python3 -m astrid.core.element.cli project-pack`;
  const selector = `--realm ${current.realmId ?? '<configured-realm-id>'} --project ${projectId}`;
  return { status: existing?.status ?? 'not-created', ...(existing ?? {}),
    realmId: current.realmId, projectId,
    initCommand: existing?.initCommand ?? `${command} init ${selector}`,
    inspectCommand: existing?.inspectCommand ?? `${command} inspect ${selector}`,
    admitCommand: existing?.admitCommand ?? `${command} admit ${selector}`,
    elements: current.elements.filter(entry => entry.projectId === projectId).slice(0,32).map(({descriptor,authoring})=>({
      ref:{packId:descriptor.packId,kind:descriptor.kind,id:descriptor.id,revision:descriptor.revision},...authoring,
    })),
  };
}

export async function refreshProjectElementContext(projectId:string) {
  if(scope?.projectId!==projectId)setAdmittedElementScope(projectId,[]);
  return refreshAdmittedElements();
}
export async function refreshAdmittedElementRef(ref:{packId?:string;kind:'effect'|'animation'|'transition';id:string;revision:string}) {
  if(scope && ref.packId)setAdmittedElementScope(scope.projectId,[...scope.refs,{...ref,packId:ref.packId}]);
  return refreshAdmittedElements();
}

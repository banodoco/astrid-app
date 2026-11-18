import type { AstridElementDescriptor, AstridElementComponentProps } from './astrid-element-host';
import { ASTRID_BRIDGE_REQUEST_TIMEOUT_MS } from '../data/astridBridgeWire';
import { elementKey, importProjectElement, readProjectElementList, type ElementRef, type ProjectElementComponent, type ProjectElementEntry, type ProjectElementList } from './admittedElementLoader';

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
type AdmissionReadiness = {projectId: string | null; refKeys: readonly string[]; phase: 'idle' | 'loading' | 'ready' | 'error'; error: string | null};
const readinessListeners = new Set<() => void>();
let readiness: AdmissionReadiness = {projectId: null, refKeys: [], phase: 'idle', error: null};
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
// Verified bundles by digest. A digest names exact bytes, so a re-read of the same admitted build reuses its module.
const importedByDigest = new Map<string, ProjectElementComponent>();
let generation = 0;
let scope: {projectId:string;refs:Array<ElementRef>}|null=null;
export function setAdmittedElementScope(projectId:string,refs:NonNullable<typeof scope>['refs']) {
  const next={projectId,refs:[...new Map(refs.map(ref=>[refKey(ref),ref])).values()].sort((a,b)=>refKey(a).localeCompare(refKey(b)))};
  if(JSON.stringify(scope)===JSON.stringify(next))return;
  const changed=scope?.projectId!==projectId;scope=next;++generation;
  publishReadiness({projectId, refKeys: next.refs.map(refKey), phase: 'loading', error: null});
  if(changed){current={...EMPTY_SELECTION,projectId};currentSignature='';listeners.forEach(listener=>listener());}
}

export const getAdmittedElementSelection = () => current;
export const subscribeAdmittedElements = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/**
 * Native receiving-build refresh, independent of mounted editor/ACP authority.
 * `read` lists the project's admitted refs from the Runtime; `load` verifies and imports one listed bundle.
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
  const requestedReadiness = {...readiness, phase: 'loading' as const, error: null};
  publishReadiness(requestedReadiness);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Preview pack loading timed out. Check the local connection and inspect/admit the project pack, then reload the editor.'));
      controller.abort();
    }, ADMITTED_ELEMENT_LOAD_TIMEOUT_MS);
  });
  try {
    const list = await Promise.race([readList(), deadline]);
    if (request !== generation) return current;
    if (!list) {
      publishReadiness({...requestedReadiness, phase:'ready'});
      return current;
    }
    if (requestedScope && list.projectId !== requestedScope.projectId) throw new Error('Element selection belongs to another project');
    if (current.realmId !== null && list.realmId !== current.realmId) throw new Error('Element selection realm changed; reload the editor.');
    // Only the active exact requested pins are loaded. Missing pins stay unavailable; never substitute newest code.
    const wanted = list.elements.filter(entry => !requestedScope || requestedScope.refs.some(ref => refKey(ref) === refKey(entry.ref)));
    const components = await Promise.race([Promise.all(wanted.map(async entry => {
      const imported = importedByDigest.get(entry.digest);
      if (imported) return imported;
      const component = await loadEntry(entry);
      if (typeof component !== 'function') throw new Error(`Project element ${entry.ref.id} is not a component.`);
      importedByDigest.set(entry.digest, component);
      while (importedByDigest.size > 128) importedByDigest.delete(importedByDigest.keys().next().value!);
      return component;
    })), deadline]);
    if (request !== generation) return current;
    const signature = JSON.stringify([list.projectId, list.realmId, list.selectionDigest, wanted.map(entry => [refKey(entry.ref), entry.digest])]);
    if (signature === currentSignature) {
      publishReadiness({...requestedReadiness, phase:'ready'});
      return current;
    }
    // import() returns an exotic module namespace: freezing it throws even when each export is valid.
    // The published selection is a plain frozen snapshot of the components already verified above.
    current = Object.freeze({projectId: list.projectId, selectionDigest: list.selectionDigest, realmId: list.realmId,
      projects: Object.freeze([...list.projects]),
      elements: Object.freeze(wanted.map(entry => Object.freeze({projectId: list.projectId, descriptor: entry.descriptor, authoring: entry.authoring}))),
      components: Object.freeze(Object.fromEntries(wanted.map((entry, index) => [refKey(entry.ref), components[index]])))});
    currentSignature = signature;
    listeners.forEach(listener => listener());
    publishReadiness({...requestedReadiness, phase:'ready'});
    return current;
  } catch (error) {
    if (request === generation) publishReadiness({...requestedReadiness, phase:'error', error:error instanceof Error ? error.message : String(error)});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

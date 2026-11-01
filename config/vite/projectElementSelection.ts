import path from 'node:path';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {verifyElementAdmissions, type VerifiedElementAdmission, type ElementVerificationCache} from './astridElementAdmissions';
export type ElementRef = {packId:string;kind:'effect'|'animation'|'transition';id:string;revision:string};
export type ProjectPackDocument = {document_id:string;project_id:string;kind:string;version:number;content:unknown};
type Admission = {id:string;kind:string;revision:string;snapshot_digest:string;snapshot_object?:unknown};
type Binding = {schema:string;pack_id:string;source_binding_key:string;relative_manifest:string;admissions:Admission[]};
export function stableJson(value: unknown): string {
  if(Array.isArray(value))return '['+value.map(stableJson).join(',')+']';
  if(value && typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+stableJson(item)).join(',')+'}';
  return JSON.stringify(value);
}
export const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Matches Astrid documents.stable_document_id, including Python's default array separators. */
export function projectPackDocumentId(projectId:string,name='default') {
  const namespace=Buffer.from('6ba7b8119dad11d180b400c04fd430c8','hex');
  const json='['+[projectId,'astrid.project-pack',name].map(value=>JSON.stringify(value)).join(', ')+']';
  const hash=createHash('sha1').update(namespace).update(json).digest();hash[6]=(hash[6]&15)|80;hash[8]=(hash[8]&63)|128;
  const h=hash.subarray(0,16).toString('hex');return 'document:'+h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
}
const identity=(value:unknown):value is string=>typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const refKey=(ref:ElementRef)=>JSON.stringify([ref.packId,ref.kind,ref.id,ref.revision]);
export type ProjectElementSelection = VerifiedElementAdmission & {projectId:string; requiredRefs:ElementRef[]; unavailable:ElementRef[]};
export type ProjectSelectionOptions = {
  realmId:string;artifactRoot:string;sourceRoot:string;
  readDocument(projectId:string,documentId:string):Promise<ProjectPackDocument|null>;
  verificationCache?:ElementVerificationCache;
  resolveRecord?(projectId:string,ref:ElementRef):Promise<Record<string,unknown>>;
  resolvedCache?:Map<string,VerifiedElementAdmission>;
};
export async function selectProjectElements(projectId:string,refs:ElementRef[],options:ProjectSelectionOptions):Promise<ProjectElementSelection> {
  if(!identity(projectId)||!identity(options.realmId)||refs.length>64)throw new Error('Invalid active project element scope');
  const required=[...new Map(refs.map(ref=>{
    if(!identity(ref.packId)||!identity(ref.id)||!['effect','animation','transition'].includes(ref.kind)||typeof ref.revision!=='string'||ref.revision.length>256||!ref.revision)throw new Error('Invalid exact element ref');
    return [refKey(ref),ref] as const;
  })).values()];
  if(!path.isAbsolute(options.sourceRoot)||!path.isAbsolute(options.artifactRoot))throw new Error('Native element source roots must be explicit absolute paths');
  const sourceRoot=path.resolve(options.sourceRoot);const artifactRoot=path.resolve(options.artifactRoot);
  const documents=new Map<string,Promise<ProjectPackDocument|null>>();
  const read=(name:string)=>{const id=projectPackDocumentId(projectId,name);let pending=documents.get(id);if(!pending){pending=options.readDocument(projectId,id).then(document=>{if(document&&(document.document_id!==id||document.project_id!==projectId))throw new Error('Runtime returned another project pack document');return document;});documents.set(id,pending);}return pending;};
  const defaultDoc=await read('default');
  function binding(document:ProjectPackDocument):Binding {
    if(document.project_id!==projectId||document.kind!=='astrid.project-pack'||!Number.isSafeInteger(document.version)||document.version<1)throw new Error('Invalid Runtime project pack document');
    const value=document.content as Binding;
    if(value?.schema!=='astrid.project-pack/v1'||!identity(value.pack_id)||value.source_binding_key!=='project-packs'||!Array.isArray(value.admissions))throw new Error('Unsupported canonical project pack binding');
    if(typeof value.relative_manifest!=='string'||path.isAbsolute(value.relative_manifest)||value.relative_manifest.includes('\\')||value.relative_manifest.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Unsafe canonical source binding');
    return value;
  }
  const initial=defaultDoc?binding(defaultDoc):null;
  const defaultId='project_'+sha256(options.realmId+':'+projectId+':default').slice(0,20);
  const packId=initial?.pack_id??defaultId;
  const manifest=initial?.relative_manifest??`${options.realmId}/${projectId}/packs/${packId}/pack.yaml`;
  const packRoot=path.dirname(path.join(sourceRoot,manifest));
  const command=`python3 -m astrid.core.element.cli project-pack`;
  const selector=` --realm ${options.realmId} --project ${projectId}`;
  const project={projectId,packId,packRoot,status:defaultDoc?(fs.existsSync(path.join(packRoot,'pack.yaml'))?'source-present':'source-missing'):'not-created',
    initCommand:command+' init'+selector,inspectCommand:command+' inspect'+selector,admitCommand:command+' admit'+selector,
    ...(defaultDoc?{documentId:defaultDoc.document_id,documentVersion:defaultDoc.version}:{}),};
  const elements:VerifiedElementAdmission['elements']=[];const files=new Set<string>();const unavailable:ElementRef[]=[];
  for(const ref of required) {
    const document=initial?.pack_id===ref.packId?defaultDoc:await read(ref.packId);
    if(!document){unavailable.push(ref);continue;}
    const content=binding(document);
    if(content.pack_id!==ref.packId)throw new Error('Runtime pack owner does not match requested ref');
    const selected=content.admissions.find(entry=>entry.id===ref.id&&entry.kind===ref.kind&&entry.revision===ref.revision);
    if(!selected){unavailable.push(ref);continue;}
    if(!/^[a-f0-9]{64}$/.test(selected.snapshot_digest))throw new Error('Invalid canonical admission digest');
    const cacheKey=sha256(stableJson([options.realmId,projectId,ref,selected.snapshot_digest,content.source_binding_key,content.relative_manifest,sourceRoot,artifactRoot,'astrid-pack-host-v1']));
    let verified=options.resolvedCache?.get(cacheKey);
    if(!verified) {
      if(!options.resolveRecord)throw new Error('Native canonical element resolver is not configured');
      const record=await options.resolveRecord(projectId,ref);
      const resolved=record as unknown as VerifiedElementAdmission['elements'][number] & {binding:{projectId:string;documentId:string;documentVersion:number;contentDigest:string}};
      if(resolved.binding?.projectId!==projectId||resolved.binding.documentId!==document.document_id||resolved.binding.documentVersion!==document.version
        || resolved.binding.contentDigest!=='sha256:'+sha256(stableJson(document.content)))throw new Error('Canonical element resolution raced its Runtime document; retry the scoped read');
      if(resolved.projectId!==projectId||refKey(resolved.descriptor as ElementRef)!==refKey(ref))throw new Error('Canonical element resolver returned another exact ref');
      const expectedPackRoot=path.dirname(path.join(sourceRoot,content.relative_manifest));
      if(resolved.authoring.packRoot!==expectedPackRoot||resolved.snapshot.root!==path.join(artifactRoot,options.realmId,projectId,ref.packId,'snapshots',selected.snapshot_digest))throw new Error('Snapshot or authoring paths are not selected by the canonical project document');
      const closure=[...resolved.snapshot.files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
      if(sha256(stableJson(closure))!==selected.snapshot_digest)throw new Error('Snapshot closure does not match canonical admission');
      const selectedRecord=selected.snapshot_object===undefined?resolved:{...resolved,snapshot_object:selected.snapshot_object};
      verified=verifyElementAdmissions(undefined,{schema:'astrid.element-admissions/v1',realmId:options.realmId,
        projects:[{...project,packId:ref.packId,packRoot:expectedPackRoot}],elements:[selectedRecord]},options.verificationCache);
      options.resolvedCache?.set(cacheKey,verified);
    }
    const entry=verified.elements[0];
    elements.push(entry);verified.files.forEach(file=>files.add(file));
  }
  const digest=sha256(stableJson({projectId,realmId:options.realmId,refs:required,documents:await Promise.all([...documents.values()]),elements:elements.map(entry=>({descriptor:entry.descriptor,authoring:entry.authoring}))}));
  return {projectId,requiredRefs:required,unavailable,digest,realmId:options.realmId,projects:[project],elements,files:[...files]};
}

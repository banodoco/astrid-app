#!/usr/bin/env node
// Owns the Runtime up + local App proxy + startup clock + one quick sweep.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';

const args=process.argv.slice(2);
function option(name) {
  const i=args.indexOf(name), value=args[i+1];
  if(i<0||!value||value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}
const runtimeCli=option('--runtime-cli'), dataRoot=option('--data-root'), sourceManifest=option('--source-manifest');
const productApp=option('--product-app'), toolingApp=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const editorPort=Number(option('--editor-port')), proxyPort=Number(option('--proxy-port')), doorPort=Number(option('--door-port'));
const fixture=option('--manifest'), versions=option('--versions'), results=option('--results'), startupFile=option('--startup-file');
const stackRoot=path.resolve(option('--stack-root')), chrome=process.env.SAVE_LOOP_CHROME;
const sandbox=path.resolve(`${toolingApp}.env/quick-indicator`);
const within=(parent,child)=>child===parent||child.startsWith(parent+path.sep);
if(!within(sandbox,stackRoot)) throw new Error(`stack root must be inside the owned quick sandbox: ${sandbox}`);
if(!within(stackRoot,path.resolve(dataRoot))||!within(stackRoot,path.resolve(sourceManifest))) throw new Error('data root and source manifest must be inside this owned stack root');
if(path.resolve(productApp)!==productApp||!fs.existsSync(path.join(productApp,'.git'))) throw new Error('product App checkout must be a canonical supplied Git checkout');
for(const [name,value] of Object.entries({runtimeCli,fixture,versions,results,startupFile}))
  if(!within(stackRoot,path.resolve(value))) throw new Error(`${name} must be inside this owned stack root`);
const ownershipMarker=path.join(stackRoot,'.sl1-stack-owned');
if(fs.readFileSync(ownershipMarker,'utf8')!==`astrid-app-sl1-stack-v1 ${stackRoot}`) throw new Error('stack ownership marker does not match canonical root');
if(!chrome||!path.isAbsolute(chrome)||!fs.existsSync(chrome)) throw new Error('SAVE_LOOP_CHROME must name an existing absolute Chrome executable');
for(const [name,value] of Object.entries({editorPort,proxyPort,doorPort})) if(!Number.isInteger(value)||value<1024||value>65535) throw new Error(`${name} is not a valid port`);
const manifest=JSON.parse(fs.readFileSync(fixture,'utf8'));
const project=manifest.project_id, timeline=manifest.timeline_id;
if(!project||!timeline) throw new Error('fixture manifest must identify its exact project and timeline');
if(fs.existsSync(results)||fs.existsSync(startupFile)) throw new Error('quick results and startup paths must be new');
fs.mkdirSync(path.dirname(results),{recursive:true,mode:0o700});

const base=`http://127.0.0.1:${editorPort}`;
const timelineUrl=`${base}/api/runtime/v1/projects/${encodeURIComponent(project)}/timelines/${encodeURIComponent(timeline)}`;
const logPath=path.join(path.dirname(results),'editor.log');
const logFd=fs.openSync(logPath,'wx',0o600);
const env={...process.env,HOME:path.join(stackRoot,'home'),TMPDIR:path.join(stackRoot,'tmp'),
  XDG_DATA_HOME:path.join(stackRoot,'home/.local/share'),XDG_STATE_HOME:path.join(stackRoot,'home/.local/state'),
  XDG_CACHE_HOME:path.join(stackRoot,'home/.cache'),XDG_CONFIG_HOME:path.join(stackRoot,'home/.config'),
  ASTRID_RUNTIME_DOOR_PORT:String(doorPort),PORT:String(editorPort),VITE_ASTRID_DYNAMIC_PROXY_PORT:String(proxyPort)};
let editor;
let runtimeStartLaunch;

function runChild(command,argv,{cwd,env:childEnv=env,stdout='ignore',stderr='ignore',onSpawn}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,argv,{cwd,env:childEnv,stdio:['ignore',stdout,stderr]});
    child.once('error',reject);
    child.once('spawn',()=>onSpawn?.(child));
    child.once('exit',(code,signal)=>code===0?resolve({code,signal}):reject(new Error(`${path.basename(command)} exited ${code??signal}`)));
  });
}
function metadataComplete(body) {
  const item=body?.data??body;
  return item&&typeof item==='object'&&!Array.isArray(item)&&item.project_id===project&&item.timeline_id===timeline&&
    typeof item.head_revision_id==='string'&&item.head_revision_id.length>0&&
    typeof item.head_publication_id==='string'&&item.head_publication_id.length>0;
}
async function pollMetadata(startedAt,shouldStop) {
  const deadline=startedAt+900000, attempts=[];
  let firstComplete=null,firstSubsecond=null;
  while(performance.now()<deadline&&!shouldStop()&&!firstSubsecond) {
    const requestAt=performance.now();let status=null,complete=false,error=null;
    try {
      const response=await fetch(timelineUrl,{headers:{accept:'application/json'},signal:AbortSignal.timeout(5000),cache:'no-store',redirect:'manual'});
      status=response.status;
      if(response.ok) {let body;try{body=await response.json();}catch(e){error=`invalid JSON: ${e.message}`;}
        if(body!==undefined) complete=Boolean(metadataComplete(body));}
    } catch(e) {error=String(e?.name==='AbortError'?'timeout':e?.message||e);}
    const endedAt=performance.now(),attempt={attempt:attempts.length+1,status,complete,request_duration_ms:endedAt-requestAt,
      request_end_utc:new Date().toISOString(),elapsed_from_runtime_launch_ms:endedAt-startedAt,error};
    attempts.push(attempt);if(complete&&!firstComplete)firstComplete=attempt;if(complete&&attempt.request_duration_ms<1000)firstSubsecond=attempt;
    if(!firstSubsecond)await new Promise(resolve=>setTimeout(resolve,100));
  }
  return {attempts,first_complete_metadata:firstComplete,first_complete_subsecond_metadata:firstSubsecond,
    outcome:firstSubsecond?'available':shouldStop()?'sweep_finished_before_answer':performance.now()>=deadline?'timeout':'unobserved'};
}
let exitCode=0;
let stopMetadataPolling=false;
try {
  const launchUtc=new Date().toISOString();
  let cliSpawnUtc=null, cliPid=null, cliSpawnPerf=null;
  let spawnedResolve;
  const spawnedPromise=new Promise(resolve=>{spawnedResolve=resolve;});
  const upPromise=runChild(runtimeCli,['up','--profile','astrid','--data-root',dataRoot,'--source-manifest',sourceManifest,
    '--door-port',String(doorPort),'--hosted-origin','off','--json'],{onSpawn:child=>{
      runtimeStartLaunch={utc:launchUtc,process_spawn_utc:cliSpawnUtc=new Date().toISOString(),monotonic_ms:cliSpawnPerf=performance.now(),process_pid:cliPid=child.pid,
        command:'owned installed astrid-runtime up',marker:'CLI child spawn immediately before Runtime bootstrap'};
      spawnedResolve();
    }});
  await Promise.race([spawnedPromise,upPromise.then(()=>{throw new Error('Runtime up exited before a process spawn marker');})]);
  const metadataPromise=pollMetadata(cliSpawnPerf,()=>stopMetadataPolling);
  await upPromise;
  if(!runtimeStartLaunch) throw new Error('Runtime up process did not emit a spawn marker');
  editor=spawn(process.execPath,['scripts/dev-local-workspace.mjs','--data-root',dataRoot],{cwd:productApp,env,stdio:['ignore',logFd,logFd]});
  await new Promise((resolve,reject)=>{editor.once('error',reject);editor.once('spawn',resolve);});
  const sweepEnv={...env,SAVE_LOOP_ROOT:stackRoot,SAVE_LOOP_RUNTIME_DATA_ROOT:dataRoot,SAVE_LOOP_BASE_URL:base,SAVE_LOOP_CHROME:chrome,
    ...(process.env.SAVE_LOOP_PLAYWRIGHT?{SAVE_LOOP_PLAYWRIGHT:process.env.SAVE_LOOP_PLAYWRIGHT}:{})};
  const sweepPath=path.join(toolingApp,'scripts/save-loop/sweep.mjs');
  const descriptor={type:'runtime_startup',measurement:'runtime_start_launch_to_first_authenticated_complete_subsecond_metadata',
    runtime_start_launch_marker:runtimeStartLaunch,project_id:project,timeline_id:timeline,outcome:'pending',elapsed_ms:null};
  fs.writeFileSync(startupFile,JSON.stringify(descriptor,null,2)+'\n',{flag:'wx',mode:0o600});
  const sweepArgs=[sweepPath,'--manifest',fixture,'--results',results,'--versions',versions,'--quick','--runtime-startup',startupFile];
  if(process.env.SAVE_LOOP_QUICK_WARM_RELOAD==='1') sweepArgs.push('--quick-warm-reload');
  const sweepPromise=runChild(process.execPath,sweepArgs,
    {cwd:toolingApp,env:sweepEnv,stdout:'inherit',stderr:'inherit'});
  try{await sweepPromise;}catch(e){exitCode=1;console.error(String(e?.message||e));}
  stopMetadataPolling=true;
  const metadata=await metadataPromise;
  let quickOpening=null;
  if(fs.existsSync(results)) for(const line of fs.readFileSync(results,'utf8').split(/\r?\n/).filter(Boolean)) {
    try {const item=JSON.parse(line);if(item.type==='quick_opening')quickOpening=item;}catch{}
  }
  const first=metadata.first_complete_subsecond_metadata;
  const uiStart=quickOpening?.navigation_started_at??null;
  const precedesUi=first&&uiStart?Date.parse(first.request_end_utc)<Date.parse(uiStart):null;
  const startup={...descriptor, outcome:first?'available':metadata.outcome,elapsed_ms:first?.elapsed_from_runtime_launch_ms??null,
    attempts:metadata.attempts,first_complete_metadata:metadata.first_complete_metadata,first_complete_subsecond_metadata:first,
    authenticated_proxy:'loopback App Runtime discovery proxy injects the current Runtime bearer token from its owned discovery record',
    quick_navigation_started_at:uiStart,qualifying_read_preceded_ui_navigation:precedesUi,
    blocked_indicator_censoring:precedesUi===true?'metadata was ready before UI navigation; quick-open/blocked timing may be cache-warmed':precedesUi===false?'first qualifying metadata response followed UI navigation':'UI ordering unobserved',
    limitation:'Startup probe and quick sweep ran concurrently. Startup duration is independent of UI-marker post_open_blocked_s; if readiness preceded navigation, UI timings are marked potentially cache-warmed.'};
  fs.writeFileSync(startupFile,JSON.stringify(startup,null,2)+'\n');
  if(fs.existsSync(results))fs.appendFileSync(results,JSON.stringify(startup)+'\n',{mode:0o600});
} catch(error) {
  exitCode=1;
  const fallback={type:'runtime_startup',measurement:'runtime_start_launch_to_first_authenticated_complete_subsecond_metadata',
    runtime_start_launch_marker:runtimeStartLaunch??null,outcome:'setup_failed',elapsed_ms:null,first_complete_subsecond_metadata:null,
    reason:String(error?.message||error),limitation:'Startup did not complete; no elapsed value invented.'};
  let pending=false;
  if(fs.existsSync(startupFile)) {try {pending=JSON.parse(fs.readFileSync(startupFile,'utf8')).outcome==='pending';} catch {}}
  if(!fs.existsSync(startupFile)||pending) {
    fs.writeFileSync(startupFile,JSON.stringify(fallback,null,2)+'\n',fs.existsSync(startupFile)?'utf8':{flag:'wx',mode:0o600});
    if(fs.existsSync(results)) fs.appendFileSync(results,JSON.stringify(fallback)+'\n',{mode:0o600});
  }
  console.error(`quick-runtime-cycle: ${error?.message||error}`);
} finally {
  stopMetadataPolling=true;
  if(editor&&editor.exitCode===null&&editor.signalCode===null) {
    editor.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>editor.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);
    if(editor.exitCode===null&&editor.signalCode===null) editor.kill('SIGKILL');
  }
  try { fs.closeSync(logFd); } catch {}
  try { await runChild(runtimeCli,['down','--profile','astrid','--data-root',dataRoot,'--door-port',String(doorPort),'--json']); }
  catch(error) { exitCode=1; console.error(`Runtime shutdown unconfirmed: ${error.message}`); }
}
process.exitCode=exitCode;

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {runtimeRootForData} from './cpu.mjs';

// Truthful Plan 77 indicator classification. Missing observations stay unknown.
export function trafficLight(value, {works, slow, broken = Infinity, refused = false} = {}) {
  if (refused || value?.refused === true) return {light:'broken', seconds:null, reason:'refused'};
  const seconds = typeof value === 'number' ? value : value?.seconds;
  if (!Number.isFinite(seconds) || seconds < 0) return {light:'unobserved', seconds:null, reason:value?.reason ?? 'not observed'};
  return {light:seconds <= works ? 'works' : seconds <= slow ? 'slow' : 'broken', seconds, reason:null};
}

export function quickIndicatorRow({size, label, usableSeconds, blockedSeconds, immediateSave, quietSave, versions}) {
  const timing=value=>value?.timing?{...value.timing,...(value.timing.reason||value.reason?{reason:value.timing.reason??value.reason}:{})}:{request_observed:false,gesture_to_post_ms:null,post_to_response_ms:null,outcome:'unobserved',reason:value?.reason??'not observed'};
  return {
    type:'quick_indicator', size, label, versions:versions??null,
    usable:trafficLight(usableSeconds, {works:5, slow:15}),
    blocked:trafficLight(blockedSeconds, {works:2, slow:30}),
    immediate_save:trafficLight(immediateSave, {works:2, slow:10}),
    quiet_save:trafficLight(quietSave, {works:2, slow:10}),
    immediate_save_timing:timing(immediateSave),
    quiet_save_timing:timing(quietSave),
    thresholds_seconds:{usable:{works:5, slow:15, broken:'>15'}, save:{works:2, slow:10, broken:'refused or no Saved within 60'}, blocked:{works:2, slow:30, broken:'>30'}},
  };
}

export function quickSaveTiming(events, gestureEndedAt) {
  const candidates=Array.isArray(events)?events:[];
  if (!candidates.length) return {request_observed:false,gesture_to_post_ms:null,post_to_response_ms:null,outcome:'unobserved',reason:'no scoped commit request observed'};
  if(!Number.isFinite(gestureEndedAt)) return {request_observed:true,gesture_to_post_ms:null,post_to_response_ms:null,outcome:'unobserved',reason:'trusted gesture-end event timestamp was not observed'};
  const request=candidates.find(entry=>Number.isFinite(entry.requestAt)&&entry.requestAt>=gestureEndedAt)??candidates[0];
  const requestAt=request.requestAt;
  const responseAt=request.responseAt;
  const gestureValid=Number.isFinite(gestureEndedAt)&&Number.isFinite(requestAt);
  const postValid=Number.isFinite(requestAt)&&Number.isFinite(responseAt)&&responseAt>=requestAt;
  const beforeGesture=gestureValid&&requestAt<gestureEndedAt;
  const status=Number.isFinite(request.status)?request.status:null;
  return {
    request_observed:true,
    request_method:request.method,
    request_status:status,
    gesture_to_post_ms:gestureValid&&!beforeGesture?requestAt-gestureEndedAt:null,
    post_to_response_ms:postValid?responseAt-requestAt:null,
    outcome:request.error?'request_failed':status===null?'response_unconfirmed':status>=200&&status<300?'accepted':status===409?'refused':'http_failure',
    reason:beforeGesture?'commit request preceded the measured gesture end':!gestureValid?'gesture or request clock was unavailable':!postValid?(request.error??'matching response was not observed'):null,
  };
}

export function quickSaveValue(row, cleanupVerified=true) {
  const timing=row?.quick_save_timing??{request_observed:false,gesture_to_post_ms:null,post_to_response_ms:null,outcome:'unobserved',reason:'quick save timing was not recorded'};
  if (['http_failure','request_failed','response_unconfirmed'].includes(timing.outcome) && row?.pass!==true && !(row?.settlement_outcome==='deadline' && row.settlement_timeout_ms>=60000 && row.settlement_elapsed_ms>=60000)) return {reason:`ambiguous ${timing.outcome}; save outcome not confirmed`,timing};
  if (row?.settlement_outcome==='refusal' || timing.outcome==='refused') return {refused:true,reason:row.final_badge?.text||row.reason||timing.reason||'Runtime refused the save',timing};
  if (row?.settlement_outcome==='deadline' && Number.isFinite(row.settlement_timeout_ms) && row.settlement_timeout_ms>=60000 && Number.isFinite(row.settlement_elapsed_ms) && row.settlement_elapsed_ms>=60000)
    return {refused:true,reason:`no Saved after ${Math.round(row.settlement_elapsed_ms/1000)} seconds`,timing};
  if (row?.pass !== true || !cleanupVerified || !Number.isFinite(row.ms)) return {reason:!cleanupVerified?'cleanup was not verified':row?.reason??'save outcome not confirmed',timing};
  return {seconds:row.ms/1000,timing};
}

function parseStackInfo(root) {
  const raw=fs.readFileSync(path.join(root,'stack-info.txt'),'utf8');
  return Object.fromEntries(raw.split(/\r?\n/).filter(Boolean).map(line=>{const i=line.indexOf('=');return i<0?['','']:[line.slice(0,i),line.slice(i+1)];}));
}
function sha(value) { return typeof value==='string'&&/^[0-9a-f]{40}$/.test(value); }
function acquireQuickLock(sandbox) {
  const marker=path.join(sandbox,'.quick-operation-lock','owner');
  const supplied=process.env.SAVE_LOOP_QUICK_LOCK_OWNER;
  if(!supplied||fs.readFileSync(marker,'utf8')!==supplied) throw new Error('quick mode requires the active one-root lock owner handoff');
  return ()=>{};
}
export async function quickPreflight({root,baseUrl,versions,dataRoot,productApp,editorPid=process.env.SAVE_LOOP_EDITOR_PID,
  proxyPort=process.env.SAVE_LOOP_PROXY_PORT,doorPort=process.env.SAVE_LOOP_DOOR_PORT}={}) {
  if(!root||!baseUrl||!versions||!dataRoot||!productApp) throw new Error('quick mode requires owned root, base URL, data root, product App and explicit versions');
  const tooling=path.resolve(path.dirname(new URL(import.meta.url).pathname),'../..');
  const sandbox=path.resolve(`${tooling}.env/quick-indicator`),resolvedRoot=fs.realpathSync(root);
  if(path.resolve(root)!==resolvedRoot||!resolvedRoot.startsWith(`${sandbox}${path.sep}`)) throw new Error('quick root must be canonical inside the tooling quick sandbox');
  if(fs.readFileSync(path.join(resolvedRoot,'.sl1-stack-owned'),'utf8')!==`astrid-app-sl1-stack-v1 ${resolvedRoot}`) throw new Error('quick stack marker does not match its canonical root');
  const disk=execFileSync('df',['-Pk',sandbox],{encoding:'utf8'}).trim().split('\n').at(-1).trim().split(/\s+/)[3];
  if(!/^\d+$/.test(disk)||Number(disk)<25*1024*1024) throw new Error(`quick run requires 25 GiB free at ${sandbox}`);
  const stack=parseStackInfo(resolvedRoot),want=JSON.parse(fs.readFileSync(versions,'utf8'));
  if(![want.app,want.agent,want.runtime].every(sha)||want.app!==stack.APP_SHA||want.agent!==stack.AGENT_SHA||want.runtime!==stack.RUNTIME_SHA)
    throw new Error('quick versions do not match the owned stack source tuple');
  const resolvedApp=fs.realpathSync(productApp);
  if(resolvedApp!==path.resolve(productApp)||!fs.existsSync(path.join(resolvedApp,'.git'))) throw new Error('quick product App path must be canonical');
  const head=execFileSync('git',['-C',resolvedApp,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(head!==want.app||execFileSync('git',['-C',resolvedApp,'status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim())
    throw new Error('quick product App must be clean at the selected App revision');
  const resolvedData=fs.realpathSync(dataRoot);
  if(path.resolve(dataRoot)!==resolvedData||!resolvedData.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('quick Runtime data root must be canonical inside the owned stack');
  const url=new URL(baseUrl),ep=Number(stack.EDITOR_PORT),pp=Number(stack.PROXY_PORT),dp=Number(stack.DOOR_PORT);
  if(url.hostname!=='127.0.0.1'||Number(url.port)!==ep||Number(proxyPort)!==pp||Number(doorPort)!==dp) throw new Error('quick editor/proxy/door ports must match the owned stack-info tuple');
  const release=acquireQuickLock(sandbox);
  try {
    const pid=Number(editorPid);
    if(!Number.isSafeInteger(pid)||pid<=0) throw new Error('quick mode requires the owned editor PID');
    const args=execFileSync('ps',['-p',String(pid),'-o','args='],{encoding:'utf8'});
    const cwd=fs.realpathSync(`/proc/${pid}/cwd`);
    if(!args.includes('dev-local-workspace.mjs')||!args.includes(`--data-root ${resolvedData}`)||cwd!==resolvedApp)
      throw new Error('quick editor PID does not match the selected App checkout and data root');
    const ui=await fetch(`${baseUrl}/tools/video-editor?connect=1`,{redirect:'manual',signal:AbortSignal.timeout(3000)});
    if(!ui.ok||ui.redirected) throw new Error(`owned editor health failed (${ui.status})`);
    const active=await runtimeRootForData(resolvedRoot,resolvedData,`${baseUrl}/api/runtime/v1/health`);
    const discovery=JSON.parse(fs.readFileSync(path.join(resolvedData,'runtime/discovery.json'),'utf8'));
    const proxy=await fetch(`http://127.0.0.1:${pp}/v1/health`,{redirect:'manual',signal:AbortSignal.timeout(3000)});
    const proxyHealth=proxy.ok?await proxy.json():null;
    if(!proxyHealth||proxyHealth.runtime_instance_id!==discovery.runtime_instance_id||proxyHealth.status!=='ok'||proxyHealth.protocol!=='workspace.v1')
      throw new Error('owned Runtime proxy port health does not match the adopted data root instance');
    return {release,stack,activeRuntimePid:active.pid,editorPort:ep,proxyPort:pp,doorPort:dp};
  } catch(error) { release(); throw error; }
}

export function formatQuickTable(rows) {
  const cell = value => value.seconds === null ? value.light : `${value.light} ${value.seconds.toFixed(1)}s`;
  const duration=value=>Number.isFinite(value)?`${value.toFixed(0)} ms`:'unobserved';
  const lines = ['Size | Usable | Blocked | Save after open | Open gesture→POST | Open POST→response | Save after quiet | Quiet gesture→POST | Quiet POST→response', '--- | --- | --- | --- | --- | --- | --- | --- | ---'];
  for (const row of rows) lines.push(`${row.label || row.size} | ${cell(row.usable)} | ${cell(row.blocked)} | ${cell(row.immediate_save)} | ${duration(row.immediate_save_timing.gesture_to_post_ms)} | ${duration(row.immediate_save_timing.post_to_response_ms)} | ${cell(row.quiet_save)} | ${duration(row.quiet_save_timing.gesture_to_post_ms)} | ${duration(row.quiet_save_timing.post_to_response_ms)}`);
  return lines.join('\n');
}

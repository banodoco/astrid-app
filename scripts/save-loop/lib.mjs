// Shared helpers for sweep.mjs. Environment (all required unless noted):
//   SAVE_LOOP_CHROME        path to a Chrome/Chromium binary started with --remote-debugging-port
//   SAVE_LOOP_BASE_URL      editor origin, e.g. http://localhost:<port>
//   SAVE_LOOP_PROJECT       project id to open in the editor
//   SAVE_LOOP_TIMELINE      timeline id to open in the editor
//   SAVE_LOOP_PLAYWRIGHT    optional module specifier for playwright (default 'playwright')
//   SAVE_LOOP_RESULTS       optional results file appended per row (default ./results.jsonl)
import fs from 'fs';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';
import {spawn, execFileSync} from 'child_process';
import {once} from 'events';
import {performance} from 'node:perf_hooks';
import {createCpuSampler, runtimeRoot, processRoot} from './cpu.mjs';
import {expectedFixtureIds, first15FixtureIds, first15WritableCondition, sameIds} from './readiness.mjs';
const {chromium}=await import(process.env.SAVE_LOOP_PLAYWRIGHT||'playwright');
function need(name){ const v=process.env[name]; if(!v){ throw new Error(`missing env ${name} (see scripts/save-loop/lib.mjs header or run sweep.mjs --help)`); } return v; }
const CHROME=need('SAVE_LOOP_CHROME');
const RESULTS=process.env.SAVE_LOOP_RESULTS||'results.jsonl';
export const URL_=`${need('SAVE_LOOP_BASE_URL')}/tools/video-editor?connect=1&project=${encodeURIComponent(need('SAVE_LOOP_PROJECT'))}&timeline=${encodeURIComponent(need('SAVE_LOOP_TIMELINE'))}`;
// Check before every browser run, including recovery/reopens. Never use the owner realm.
export function checkDisk() {
  const diskPath = process.env.SAVE_LOOP_ROOT || os.homedir();
  const output = execFileSync('df', ['-Pk', diskPath], {encoding:'utf8'}).trim().split('\n');
  const available = Number(output.at(-1).trim().split(/\s+/)[3]);
  if (!Number.isFinite(available) || available < 15 * 1024 * 1024) {
    throw new Error(`save-loop requires at least 15 GiB free at ${diskPath} (available KiB: ${available})`);
  }
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function exitedWithin(proc, ms) {
  if (proc.exitCode !== null || proc.signalCode !== null) return true;
  return Promise.race([
    once(proc, 'exit').then(() => true, () => true),
    delay(ms).then(() => false),
  ]);
}
// One monotonic budget covers navigation and all read-only startup corroboration.
export function startupBudget(onEvent = event => console.log(JSON.stringify(event)), duration = 480000) {
  const start = performance.now(), deadline = start + duration;
  const remaining = () => {
    const ms = Math.floor(deadline - performance.now());
    if (ms <= 0) throw new Error('startup readiness deadline exceeded');
    return ms;
  };
  const bounded = async (phase, operation) => {
    const ms = remaining();
    let timer;
    try {
      return await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`startup readiness deadline exceeded during ${phase}`)), ms);
      })]);
    } finally { clearTimeout(timer); }
  };
  const read = async (phase, operation) => {
    for (;;) {
      try { return await bounded(phase, operation); }
      catch (error) {
        const message = String(error?.message || error);
        const kind = /(?:^|\s)TypeError: Failed to fetch(?:\s|$)/.test(message) ? 'fetch'
          : /^(?:public timeline metadata|public composition revision|public composition revision index) GET failed \((502|503|504)\)$/.exec(message)?.[1]
          || /^(?:page\.evaluate: )?(?:Error: )?sandbox project read failed \((502|503|504)\)(?:\n|$)/.exec(message)?.[1];
        if (!kind) throw error;
        onEvent({type:'startup_retry', phase, class:kind === 'fetch' ? kind : `http_${kind}`, elapsed_ms:Math.round(performance.now()-start)});
        await bounded(phase, () => delay(Math.min(1000, remaining())));
      }
    }
  };
  return {start, deadline, remaining, bounded, read};
}
export async function open({onCleanup, fixture, onOpening, reducedOpening = false, onProvisional} = {}){
  checkDisk();
  const browserScratch=fs.mkdtempSync(path.join('/tmp','sl-'));
  const profile=browserScratch;
  let proc, browser, cpu, closePromise;
  // Startup failure, signals and the sweep watchdog may all request close.
  function close(){ return closePromise ??= closeOwned(); }
  async function closeOwned(){
    try {
      cpu?.close();
      if (browser) {
        await Promise.race([
          Promise.resolve().then(() => browser.close()).catch(() => {}),
          delay(2000),
        ]);
      }
    } finally {
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        try { proc.kill('SIGTERM'); } catch {}
        if (!await exitedWithin(proc, 2000)) {
          try { proc.kill('SIGKILL'); } catch {}
          await exitedWithin(proc, 2000);
        }
      }
      fs.rmSync(browserScratch,{recursive:true,force:true,maxRetries:8,retryDelay:100});
    }
  }
  if (onCleanup) onCleanup(close);
  try {
    proc=spawn(CHROME,['--headless=new',...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),'--remote-debugging-port=0','--user-data-dir='+profile,'--disk-cache-size=1','--media-cache-size=1','--no-first-run','--window-size=1700,1500','about:blank'],{stdio:'ignore',env:{...process.env,TMPDIR:browserScratch}});
    let ready=false, port;
    let spawnError; proc.on('error', error=>{spawnError=error;});
    for(let i=0;i<40;i++){
      if (spawnError) throw spawnError;
      try { port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]); } catch {}
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error('Chrome exited before CDP was ready');
      try { const r=port && await fetch('http://127.0.0.1:'+port+'/json/version'); if(r.ok) {ready=true; break;} } catch {}
      await new Promise(r=>setTimeout(r,500));
    }
    if (!ready) throw new Error('Chrome CDP did not become ready');
    browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
    const ctx=browser.contexts()[0];
    const p=ctx.pages()[0]; await p.setViewportSize({width:1700,height:1500});
    const ev=[]; p.__ev=ev;
    p.on('request',r=>{ if(r.method()==='POST'&&!/handshake|local-update|inspect|acp|chat/.test(r.url())) r.__t=Date.now(); });
    p.on('response',async r=>{ const q=r.request(); if(q.method()==='POST'&&!/handshake|local-update|inspect|acp|chat/.test(r.url())){ let body=''; if(/commit/.test(r.url())){try{body=(await r.text()).slice(0,400)}catch{}} ev.push({t:Date.now(),requestTime:q.__t,url:r.url().replace(/.*\/api\//,''),status:r.status(),body}); }});
    let opening, startup;
    if (fixture) {
      const expected = expectedFixtureIds(fixture);
      const tracks = [...(fixture.tracks?.visual ?? []), ...(fixture.tracks?.audio ?? [])].map(t=>t.id);
      if (tracks.length !== 9 || new Set(tracks).size !== 9) throw new Error('fixture must have nine distinct tracks');
      const target = fixture.clips?.audio?.primary || fixture.clips?.video?.primary;
      if (!target?.clip_id || !target?.track_id) throw new Error('fixture lacks a selection target');
      if (!process.env.SAVE_LOOP_ROOT) throw new Error('SAVE_LOOP_ROOT required for owned Runtime CPU identity');
      cpu = createCpuSampler(runtimeRoot(process.env.SAVE_LOOP_ROOT), processRoot(proc.pid));
      startup=startupBudget(undefined, reducedOpening ? 900000 : 480000);
      const measureOpening = async (warm = false) => {
      const cpuStart=cpu.mark(), start=warm ? performance.now() : startup.start;
      const posts=[];
      const observe=request=>{if(request.method()==='POST' && request.url().includes('/api/runtime/')) posts.push(request.url().replace(/.*\/api\//,''));};
      p.on('request',observe);
      const navigation=warm ? p.reload({waitUntil:'domcontentloaded', timeout:startup.remaining()}) : p.goto(URL_, {waitUntil:'domcontentloaded', timeout:startup.remaining()});
      // Warm DOM observers must attach only after the reloaded document is ready.
      if (warm) await navigation;
      const selector=`.clip-action[data-clip-id="${target.clip_id}"][data-row-id="${target.track_id}"]`;
      const first15=(async()=>{
        try {
          const ids=first15FixtureIds(fixture);
          await p.waitForFunction(({expectedIds,project,timeline})=>{
            const url=new URL(location.href);
            if (url.searchParams.get('project')!==project || url.searchParams.get('timeline')!==timeline) return false;
            const visible=e=>{
              if (!e) return false;
              let r=e.getBoundingClientRect();
              if (r.width<=0 || r.height<=0) return false;
              let left=Math.max(0,r.left), right=Math.min(innerWidth,r.right), top=Math.max(0,r.top), bottom=Math.min(innerHeight,r.bottom);
              for (let parent=e;parent;parent=parent.parentElement) {
                const style=getComputedStyle(parent);
                if (style.display==='none' || style.visibility==='hidden') return false;
                if (parent!==e && /(auto|scroll|hidden|clip)/.test(style.overflowX+' '+style.overflowY)) {
                  r=parent.getBoundingClientRect(); left=Math.max(left,r.left); right=Math.min(right,r.right); top=Math.max(top,r.top); bottom=Math.min(bottom,r.bottom);
                }
              }
              return right>left && bottom>top;
            };
            const actions=[...document.querySelectorAll('.clip-action[data-clip-id][data-row-id]')];
            return expectedIds.every(id=>actions.some(e=>e.getAttribute('data-clip-id')===id && visible(e)));
          },{expectedIds:ids,project:fixture.project_id,timeline:fixture.timeline_id},{timeout:startup.remaining()});
          return {visible_ms:performance.now()-start, expected_ids:ids, limitation:'All expected first-15-second clips intersect the visible viewport; editability and complete time-axis coverage are not proven.'};
        } catch(error) {return {visible_ms:null,error:String(error.message),limitation:'First-15-second clip visibility not proven.'};}
      })();
      const selection=(async()=>{
        try {
          const control=p.locator(selector).first();
          await control.waitFor({state:'visible', timeout:startup.remaining()});
          const current=new URL(p.url());
          if (current.searchParams.get('project')!==fixture.project_id || current.searchParams.get('timeline')!==fixture.timeline_id) throw new Error('selection target is not on the fixture project and timeline');
          const visible=performance.now()-start;
          const selectedBefore=await control.getAttribute('data-selected');
          const countBefore=posts.length;
          await control.press('Enter', {timeout:startup.remaining()});
          await p.waitForFunction(sel=>document.querySelector(sel)?.getAttribute('data-selected')==='true',selector,{timeout:Math.min(10000, startup.remaining())});
          return {visible_ms:visible, selection_ms:performance.now()-start, selected_before:selectedBefore, selection_transition_proven:selectedBefore !== 'true', runtime_posts_during_selection:posts.length-countBefore, limitation:'Selection only; first 15 seconds rendered, editable state, and unchanged public head are not established.'};
        } catch(error) {return {selection_ms:null, error:String(error.message), limitation:'Selection and first 15 seconds editable are not established.'};}
      })();
      const firstUsable=(async()=>{
        const selected=await selection;
        if (!selected.selection_transition_proven || selected.runtime_posts_during_selection !== 0) return {ms:null, target_pass:null, reason:'The clip selection transition without a Runtime POST was not established.'};
        try {
          const handle=await p.waitForFunction(first15WritableCondition, {
            expectedIds:first15FixtureIds(fixture), project:fixture.project_id, timeline:fixture.timeline_id,
            targetClipId:target.clip_id, targetTrackId:target.track_id,
          }, {timeout:startup.remaining()});
          const evidence=await handle.jsonValue();
          const ms=performance.now()-start;
          await handle.dispose();
          return {ms,target_pass:ms<=5000,evidence, label:'First-15 clip visibility, responded-to selection, and writable track-name affordance; no edit was made.', limitation:'A writable affordance and the shared editability policy do not prove that a persisted edit was accepted or that every clip is editable.'};
        } catch(error) {return {ms:null,target_pass:null,reason:String(error.message)};}
      })();
      firstUsable.then(value => console.log(JSON.stringify({type:'startup_first_usable_observation', ms:value.ms, target_pass:value.target_pass, corroborated:false})));
      await navigation;
      // Observe the same stable predicate independently while public reads may stall.
      // It is explicitly uncorroborated; the original post-head observer remains below.
      const earlyFull=(async()=>{
        let stableSince=null;
        while (performance.now() < startup.deadline) {
          const state=await startup.bounded('early_ui', () => p.evaluate(()=>({project:new URL(location.href).searchParams.get('project'), timeline:new URL(location.href).searchParams.get('timeline'), ids:[...document.querySelectorAll('.clip-action[data-clip-id][data-row-id]')].map(e=>e.getAttribute('data-clip-id')), tracks:[...new Set([...document.querySelectorAll('[data-row-id]')].map(e=>e.getAttribute('data-row-id')))], saved:[...document.querySelectorAll('div,span,button')].some(e=>e.children.length===0&&/^saved$/i.test((e.textContent||'').trim()))})));
          const matches=state.project===fixture.project_id && state.timeline===fixture.timeline_id && state.saved && sameIds(state.ids,expected) && sameIds(state.tracks,tracks);
          if (matches) {
            stableSince ??= performance.now();
            if (performance.now()-stableSince>=800) {
              const value={ui_saved_ms:performance.now()-start, stable_ms:performance.now()-stableSince, corroborated:false};
              if (onProvisional) onProvisional({warm, value, page:p, startup, marker:performance.now()});
              return value;
            }
          } else stableSince=null;
          await startup.bounded('early_ui', () => delay(Math.min(250, startup.remaining())));
        }
        return null;
      })().then(value => { console.log(JSON.stringify({type:'startup_ui_observation', full_ui_saved:value, corroborated:false})); return value; }, () => { console.log(JSON.stringify({type:'startup_ui_observation', full_ui_saved:null, corroborated:false})); return null; });
      const {publicSnapshot} = await import('./assert.mjs');
      const headBefore = await startup.read('head_before_ui', () => publicSnapshot(p, process.env.SAVE_LOOP_BASE_URL, fixture));
      if (!sameIds(headBefore.clipIds, expected)) throw new Error('opening public head clip IDs do not match fixture');
      let full=null;
      const deadline=startup.deadline;
      let stableSince=null;
      while(performance.now()<deadline) {
        const state=await startup.bounded('full_ui', () => p.evaluate(()=>({project:new URL(location.href).searchParams.get('project'), timeline:new URL(location.href).searchParams.get('timeline'), ids:[...document.querySelectorAll('.clip-action[data-clip-id][data-row-id]')].map(e=>e.getAttribute('data-clip-id')), tracks:[...new Set([...document.querySelectorAll('[data-row-id]')].map(e=>e.getAttribute('data-row-id')))], saved:[...document.querySelectorAll('div,span,button')].some(e=>e.children.length===0&&/^saved$/i.test((e.textContent||'').trim()))})));
        const matches=state.project===fixture.project_id && state.timeline===fixture.timeline_id && state.saved && sameIds(state.ids,expected) && sameIds(state.tracks,tracks);
        if (matches) {
          stableSince ??= performance.now();
          if (performance.now()-stableSince>=800) {full={ui_saved_ms:performance.now()-start,stable_ms:performance.now()-stableSince,cpu:cpu.delta(cpuStart,'opening_to_full_ui_saved')}; break;}
        } else stableSince=null;
        await startup.bounded('full_ui', () => p.waitForTimeout(Math.min(250, startup.remaining())));
      }
      if (!full) opening = {cpu:cpu.delta(cpuStart,'opening_until_full_ui_timeout')};
      const [selected,first15Visible,usable]=await Promise.all([selection,first15,firstUsable]);
      p.off('request',observe);
      return {type:warm ? 'warm_opening' : 'opening', early_full_ui_saved:await earlyFull, selection:selected, first_15_seconds_visibility:first15Visible, first_usable:usable, first_usable_ms:usable.ms, first_usable_target_pass:usable.target_pass, full_ui_saved:full, head_before_ui:{revision:headBefore.headRevision,publication:headBefore.publicationId}, timeout_cpu:opening?.cpu ?? null, limitation:full ? 'Public head identity and exact IDs must be confirmed before this is a full-open claim.' : 'Full UI was not proven; the timeline may virtualize offscreen controls.', target_first_usable_ms:5000,target_full_open_ms:15000};
      };
      opening=await measureOpening();
      p.__measureWarmOpening=measureOpening;
    } else {
      await p.goto(URL_);
      await p.waitForFunction(()=>[...document.querySelectorAll('div')].some(e=>e.children.length===0&&/^saved$/i.test(e.textContent||'')),null,{timeout:60000});
    }
    if (reducedOpening && startup) await startup.bounded('stability_delay', () => p.waitForTimeout(15000));
    else await p.waitForTimeout(15000);
    if (opening) { opening.stability_delay_ms=15000; if (onOpening) onOpening(opening); }
    return {b:{close},p,ev,context:ctx,cpu,opening,startup:fixture ? startup : undefined, measureWarmOpening:p.__measureWarmOpening};
  } catch(error) {
    try { await close(); }
    catch(cleanupError) {
      error.message = `${error.message}; browser cleanup also failed: ${cleanupError.message}`;
    }
    throw error;
  }
}
export async function badge(p){ return await p.evaluate(()=>{ for(const e of document.querySelectorAll('div,span,button')){ if(e.children.length===0){ const t=(e.textContent||'').trim(); if(/^(saved|saving\.*|not saved|error|unsaved\.*|save failed)$/i.test(t)) return t.toLowerCase(); } } return '?'; }); }
// run a gesture, wait for settle, return result
export async function act(p,name,fn,{settle=90000}={}){
  const ev=p.__ev; const n0=ev.length; const t0=Date.now();
  await fn();
  await p.waitForTimeout(1200);
  let st='';
  const end=Date.now()+settle;
  while(Date.now()<end){ st=await badge(p); if(st==='saved'||/not saved|error|failed/.test(st)) { await p.waitForTimeout(800); const st2=await badge(p); if(st2===st) break; } await p.waitForTimeout(500); }
  const dur=Date.now()-t0;
  const posts=ev.slice(n0);
  const toast=await p.evaluate(()=>[...document.querySelectorAll('[data-sonner-toast],[role="alert"]')].map(e=>e.innerText));
  const banner=await p.evaluate(()=>[...document.querySelectorAll('div,p,span')].filter(e=>e.children.length===0&&/not saved|refus|changed somewhere|protocol_error|validation|can.t/i.test(e.textContent||'')).map(e=>e.textContent));
  const r={name,badge:st,ms:dur,posts:posts.map(x=>({u:x.url,s:x.status,b:x.body.slice(0,250)})),toast:[...new Set([...toast,...banner])].map(s=>s.slice(0,250)).slice(0,4)};
  console.log(JSON.stringify(r));
  fs.appendFileSync(RESULTS,JSON.stringify(r)+'\n');
  return r;
}
export const undo=async p=>{await p.keyboard.press('Control+z');};
export const rect=(p,id)=>p.evaluate(i=>{const e=document.querySelector(`[data-clip-id="${i}"]:not([data-resize-edge])`); if(!e) return null; e.scrollIntoView({block:'nearest',inline:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height};},id);
export const rowY=(p,id)=>p.evaluate(i=>{const e=document.querySelector(`[data-row-id="${i}"]`); const r=e.getBoundingClientRect(); return r.y+r.height/2;},id);
export async function drag(p,x0,y0,x1,y1){ await p.mouse.move(x0,y0); await p.mouse.down(); await p.mouse.move((x0+x1)/2,(y0+y1)/2,{steps:4}); await p.mouse.move(x1,y1,{steps:6}); await p.mouse.up(); }
export async function dropFile(p,x,y,name='sweep.png'){
  const b64=fs.readFileSync(fileURLToPath(new URL('./sweep.b64',import.meta.url)),'utf8');
  await p.evaluate(({x,y,b64,name})=>{ const bin=atob(b64); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); const f=new File([u],name,{type:'image/png'}); const dt=new DataTransfer(); dt.items.add(f); const t=document.elementFromPoint(x,y); for(const ty of ['dragenter','dragover','drop']){ t.dispatchEvent(new DragEvent(ty,{bubbles:true,cancelable:true,clientX:x,clientY:y,dataTransfer:dt})); } },{x,y,b64,name});
}
export const clipIds=p=>p.evaluate(()=>[...new Set([...document.querySelectorAll('[data-clip-id]')].map(e=>e.getAttribute('data-clip-id')+'@'+e.getAttribute('data-row-id')))]);

// Restore only the exact head observed by the row; a concurrent change aborts.
export async function restoreScenario({page, secondPage, fixture, result}) {
  const before = result?.before;
  const after = result?.after;
  if (!before?.headRevision || !after?.headRevision || !after?.publicationId) {
    throw new Error('cannot safely restore: row did not capture both public head and publication');
  }
  const base = `/api/runtime/v1/projects/${encodeURIComponent(fixture.project_id)}/timelines/${encodeURIComponent(fixture.timeline_id)}`;
  const restored = await page.evaluate(async ({base, before, after}) => {
    const read = async path => {
      const response = await fetch(path, {cache:'no-store', credentials:'same-origin'});
      if (!response.ok) throw new Error(`cleanup read failed (${response.status})`);
      const value = await response.json();
      return value?.data ?? value;
    };
    const current = await read(base);
    if (current.head_revision_id !== after.headRevision || current.head_publication_id !== after.publicationId)
      throw new Error('cleanup refused: public head changed since row evidence');
    if (current.head_revision_id === before.headRevision) return {changed:false};
    const response = await fetch(`${base}/composition-revisions/${encodeURIComponent(before.headRevision)}/restore`, {
      method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},
      body:JSON.stringify({expected_head:current.head_revision_id,expected_publication_id:current.head_publication_id}),
    });
    const body = await response.json().catch(()=>null);
    if (!response.ok || !['accepted','rebased','merged'].includes(body?.data?.status) || !body?.receipt)
      throw new Error(`guarded restore failed (${response.status}): ${JSON.stringify(body).slice(0,500)}`);
    const restoredHead = await read(base);
    const [original, restoredRevision] = await Promise.all([
      read(`${base}/composition-revisions/${encodeURIComponent(before.headRevision)}`),
      read(`${base}/composition-revisions/${encodeURIComponent(restoredHead.head_revision_id)}`),
    ]);
    if (!original.content_digest || original.content_digest !== restoredRevision.content_digest)
      throw new Error('guarded restore did not reproduce original content digest');
    return {changed:true, headRevision:restoredHead.head_revision_id, publicationId:restoredHead.head_publication_id};
  }, {base, before, after});
  // Evidence is already recorded. Discard any refused local draft before reload.
  for (const tab of [page, secondPage].filter(Boolean)) {
    const discard = tab.getByRole('button', {name:'Discard', exact:true});
    if (await discard.isVisible().catch(()=>false)) await discard.click();
    await tab.reload();
    await tab.waitForFunction(()=>[...document.querySelectorAll('div,span,button')].some(e=>e.children.length===0 && /^saved$/i.test((e.textContent||'').trim())), null, {timeout:60000});
  }
  return restored;
}

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
const {chromium}=await import(process.env.SAVE_LOOP_PLAYWRIGHT||'playwright');
function need(name){ const v=process.env[name]; if(!v){ throw new Error(`missing env ${name} (see scripts/save-loop/lib.mjs header or run sweep.mjs --help)`); } return v; }
const CHROME=need('SAVE_LOOP_CHROME');
const RESULTS=process.env.SAVE_LOOP_RESULTS||'results.jsonl';
export const URL_=`${need('SAVE_LOOP_BASE_URL')}/tools/video-editor?project=${encodeURIComponent(need('SAVE_LOOP_PROJECT'))}&timeline=${encodeURIComponent(need('SAVE_LOOP_TIMELINE'))}`;
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
export async function open({onCleanup} = {}){
  checkDisk();
  const browserScratch=fs.mkdtempSync(path.join('/tmp','sl-'));
  const profile=browserScratch;
  let proc, browser;
  async function close(){
    try {
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
    await p.goto(URL_);
    await p.waitForFunction(()=>[...document.querySelectorAll('div')].some(e=>e.children.length===0&&/^saved$/i.test(e.textContent||'')),null,{timeout:60000});
    await p.waitForTimeout(15000);
    return {b:{close},p,ev,context:ctx};
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

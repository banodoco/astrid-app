// Shared helpers for sweep.mjs. Environment (all required unless noted):
//   SAVE_LOOP_CHROME        path to a Chrome/Chromium binary started with --remote-debugging-port
//   SAVE_LOOP_BASE_URL      editor origin, e.g. http://localhost:<port>
//   SAVE_LOOP_PROJECT       project id to open in the editor
//   SAVE_LOOP_TIMELINE      timeline id to open in the editor
//   SAVE_LOOP_PLAYWRIGHT    optional module specifier for playwright (default 'playwright')
//   SAVE_LOOP_CDP_PORT_BASE optional first remote-debugging port to try (default 9300)
//   SAVE_LOOP_RESULTS       optional results file appended per row (default ./results.jsonl)
import fs from 'fs';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';
import {spawn} from 'child_process';
const {chromium}=await import(process.env.SAVE_LOOP_PLAYWRIGHT||'playwright');
function need(name){ const v=process.env[name]; if(!v){ throw new Error(`missing env ${name} (see scripts/save-loop/lib.mjs header or run sweep.mjs --help)`); } return v; }
const CHROME=need('SAVE_LOOP_CHROME');
const PORT_BASE=Number(process.env.SAVE_LOOP_CDP_PORT_BASE||9300);
const RESULTS=process.env.SAVE_LOOP_RESULTS||'results.jsonl';
export const URL_=`${need('SAVE_LOOP_BASE_URL')}/tools/video-editor?project=${encodeURIComponent(need('SAVE_LOOP_PROJECT'))}&timeline=${encodeURIComponent(need('SAVE_LOOP_TIMELINE'))}`;
export async function open(){
  const port=PORT_BASE+Math.floor(Math.random()*400); const PROF=path.join(os.tmpdir(),'save-loop-'+process.pid+'-'+port);
  const proc=spawn(CHROME,['--headless=new','--remote-debugging-port='+port,'--user-data-dir='+PROF,'--disk-cache-size=1','--media-cache-size=1','--no-first-run','--window-size=1700,1500','about:blank'],{stdio:'ignore'});
  for(let i=0;i<40;i++){ try{ const r=await fetch('http://127.0.0.1:'+port+'/json/version'); if(r.ok) break; }catch{} await new Promise(r=>setTimeout(r,500)); }
  const b0 = await chromium.connectOverCDP('http://127.0.0.1:'+port);
  const b={close:async()=>{try{await b0.close()}catch{}; proc.kill(); await new Promise(r=>setTimeout(r,1500)); fs.rmSync(PROF,{recursive:true,force:true});}};
  const ctx = b0.contexts()[0];
  const p = ctx.pages()[0]; await p.setViewportSize({width:1700,height:1500});
  const ev=[]; p.__ev=ev;
  p.on('request',r=>{ if(r.method()==='POST'&&!/handshake|local-update|inspect|acp|chat/.test(r.url())) r.__t=Date.now(); });
  p.on('response',async r=>{ const q=r.request(); if(q.method()==='POST'&&!/handshake|local-update|inspect|acp|chat/.test(r.url())){ let body=''; if(/commit/.test(r.url())){try{body=(await r.text()).slice(0,400)}catch{}} let req=''; ev.push({t:Date.now(),url:r.url().replace(/.*\/api\//,''),status:r.status(),body,req}); }});
  await p.goto(URL_);
  await p.waitForFunction(()=>[...document.querySelectorAll('div')].some(e=>e.children.length===0&&/^saved$/i.test(e.textContent||'')),null,{timeout:60000});
  await p.waitForTimeout(15000);
  return {b,p,ev};
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

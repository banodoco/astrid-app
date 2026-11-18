/*
 * Save-loop sweep: drives the video editor through timeline gestures (move, trim, split,
 * mute, delete, inspector, audio, tracks, shots, undo/redo, file drops, repeats) and records
 * for each one the save badge, the POSTs to /commit and any toast. One JSON line per gesture
 * is appended to the results file. Needs a running editor, Runtime and Chrome; it creates
 * and reverts edits on the timeline it opens, so point it at a sandbox timeline.
 *
 * Usage: node scripts/save-loop/sweep.mjs [--state loaded|after-upload] [--video-clip ID] [--audio-clip ID] [--help]
 *   --state        loaded (default) runs on the timeline as opened; after-upload first drops a PNG
 *                  onto the Type row and targets the clip it creates
 *   --video-clip   clip id moved/trimmed/split in the video rows (default clip-2)
 *   --audio-clip   clip id moved/trimmed/muted/deleted in the audio rows (default music-song)
 * Environment (read by lib.mjs): SAVE_LOOP_CHROME, SAVE_LOOP_BASE_URL, SAVE_LOOP_PROJECT,
 *   SAVE_LOOP_TIMELINE (required); SAVE_LOOP_PLAYWRIGHT, SAVE_LOOP_CDP_PORT_BASE, SAVE_LOOP_RESULTS (optional).
 * Coordinates assume the 1700x1500 viewport set in lib.mjs. Track row ids (type, fx, picture,
 * sprite, plate, sfx) are the editor's data-row-id values for the timeline layout the sweep was written against.
 */
const USAGE=`Usage: node scripts/save-loop/sweep.mjs [--state loaded|after-upload] [--video-clip ID] [--audio-clip ID]
Environment: SAVE_LOOP_CHROME, SAVE_LOOP_BASE_URL, SAVE_LOOP_PROJECT, SAVE_LOOP_TIMELINE (required)
             SAVE_LOOP_PLAYWRIGHT, SAVE_LOOP_CDP_PORT_BASE, SAVE_LOOP_RESULTS (optional)`;
const argv=process.argv.slice(2);
const flag=(name,dflt)=>{ const i=argv.indexOf(name); if(i<0) return dflt; const v=argv[i+1]; if(!v||v.startsWith('--')) throw new Error(`${name} needs a value`); return v; };
if(argv.includes('--help')||argv.includes('-h')){ console.log(USAGE); process.exit(0); }
const STATE=flag('--state','loaded');  // loaded | after-upload
if(!['loaded','after-upload'].includes(STATE)) throw new Error(`--state must be loaded or after-upload, got ${STATE}`);
const VIDEO_CLIP=flag('--video-clip','clip-2');
const AUDIO_CLIP=flag('--audio-clip','music-song');
const {open,act,rect,rowY,drag,dropFile,clipIds,badge}=await import('./lib.mjs');
let {b,p}=await open();
const tag=n=>`[${STATE}] ${n}`;
async function reload(){ await b.close(); ({b,p}=await open()); }
async function row(name,doit,{undo=true,undoName}={}){
  try{
    const r=await act(p,tag(name),doit);
    const ok=r.posts.some(x=>/commit$/.test(x.u)&&x.s===200)&&r.badge==='saved';
    if(ok&&undo){ await act(p,tag((undoName||name)+' -> UNDO'),async()=>{await p.keyboard.press('Control+z');}); }
    else if(!ok){ await reload(); }
  }catch(e){ console.log('ROWERR',name,e.message.slice(0,200)); try{await reload();}catch{} }
}
const sel=async id=>{const r=await rect(p,id); await p.mouse.click(r.x+r.w/2,r.y+r.h/2); await p.waitForTimeout(500); return r;};
const ids=await clipIds(p); console.log(JSON.stringify(ids));
let T=VIDEO_CLIP;
if(STATE==='after-upload'){
  const before=new Set(await clipIds(p));
  const y=await rowY(p,'type');
  await row('drop PNG file onto Type row (setup, keep)',async()=>{await dropFile(p,600,y);},{undo:false});
  const after=await clipIds(p); const nw=after.filter(x=>!before.has(x)); console.log('NEW',nw);
  const n=nw.find(x=>x.endsWith('@type'))||nw[0]; if(n) T=n.split('@')[0];
  await p.waitForTimeout(2000);
}
console.log('TARGET',T);
const targetRow=async()=>(await p.evaluate(i=>document.querySelector(`[data-clip-id="${i}"]`)?.getAttribute('data-row-id'),T));
await row(`move ${T} same track (drag +120px)`,async()=>{const r=await sel(T);await drag(p,r.x+r.w/2,r.y+r.h/2,r.x+r.w/2+120,r.y+r.h/2);});
await row(`move ${T} cross-track to Fx (drag)`,async()=>{const r=await sel(T);await drag(p,r.x+r.w/2,r.y+r.h/2,r.x+r.w/2,await rowY(p,'fx'));});
await row(`move ${T} onto shot track Picture (drag)`,async()=>{const r=await sel(T);await drag(p,r.x+r.w/2,r.y+r.h/2,r.x+r.w/2,await rowY(p,'picture'));});
await row(`keyboard move ${T} track ArrowDown`,async()=>{await sel(T);await p.keyboard.press('ArrowDown');});
await row(`keyboard nudge ${T} Alt+Right`,async()=>{await sel(T);await p.keyboard.press('Alt+ArrowRight');});
await row(`trim ${T} right edge (drag -40px)`,async()=>{const r=await rect(p,T);const x=r.x+r.w-3;await drag(p,x,r.y+r.h/2,x-40,r.y+r.h/2);});
await row(`trim ${T} left edge (drag +30px)`,async()=>{const r=await rect(p,T);const x=r.x+3;await drag(p,x,r.y+r.h/2,x+30,r.y+r.h/2);});
await row(`split ${T} at playhead ('s')`,async()=>{const r=await sel(T);await p.mouse.click(r.x+r.w/2,985);await p.waitForTimeout(400);await p.keyboard.press('s');});
await row(`mute ${T} ('m')`,async()=>{await sel(T);await p.keyboard.press('m');});
await row(`delete ${T} (Delete key)`,async()=>{await sel(T);await p.keyboard.press('Delete');});
// inspector edits
await row(`inspector: set a numeric field on ${T}`,async()=>{await sel(T);const inp=p.locator('input[type=number]').first();await inp.click();await inp.fill('7');await inp.press('Tab');});
// audio
await row(`move audio ${AUDIO_CLIP} (drag +60px)`,async()=>{const r=await rect(p,AUDIO_CLIP);await drag(p,r.x+r.w/2,r.y+r.h/2,r.x+r.w/2+60,r.y+r.h/2);});
await row(`trim audio ${AUDIO_CLIP} right edge (-30px)`,async()=>{const r=await rect(p,AUDIO_CLIP);const x=r.x+r.w-3;await drag(p,x,r.y+r.h/2,x-30,r.y+r.h/2);});
await row(`mute audio ${AUDIO_CLIP} (m)`,async()=>{await sel(AUDIO_CLIP);await p.keyboard.press('m');});
await row(`delete audio ${AUDIO_CLIP}`,async()=>{await sel(AUDIO_CLIP);await p.keyboard.press('Delete');});
await row('move audio clip to Sfx track (drag)',async()=>{const r=await rect(p,AUDIO_CLIP);await drag(p,r.x+r.w/2,r.y+r.h/2,r.x+r.w/2,await rowY(p,'sfx'));});
// tracks
await row('add video track (+ Video)',async()=>{await p.getByText('+ Video',{exact:false}).first().click();});
await row('rename track Fx label',async()=>{const y=await rowY(p,'fx');await p.mouse.click(60,y); await p.mouse.click(112,y);await p.waitForTimeout(500);const inp=p.locator('input[type=text]:visible').first();await inp.fill('FxRen');await inp.press('Enter');});
await row('reorder track (drag Sprite handle down)',async()=>{const y=await rowY(p,'sprite');await drag(p,88,y,88,y+40);});
await row('remove empty track Plate (x button)',async()=>{const y=await rowY(p,'plate');await p.mouse.move(60,y);await p.locator('button[title="Remove track"]').nth(5).click({force:true});});
// shots
await row('shot move: drag Picture shot 2 left',async()=>{await drag(p,700,1022,500,1022);});
await row('shot trim: drag boundary right edge of shot 1 (-40px)',async()=>{await drag(p,445,1022,405,1022);});
await row('shot select + delete',async()=>{await p.mouse.click(300,1022);await p.keyboard.press('Delete');});
// undo/redo
await row('redo path: nudge, undo, redo',async()=>{await sel(T);await p.keyboard.press('Alt+ArrowRight');await p.waitForTimeout(15000);await p.keyboard.press('Control+z');await p.waitForTimeout(15000);await p.keyboard.press('Control+Shift+z');},{undoName:'redo'});
// drop
{ const y=await rowY(p,'sprite');
  await row('drop PNG file onto Sprite row',async()=>{await dropFile(p,700,y);}); }
// repeats
await row(`REPEAT x3 move ${T} (3 quick drags)`,async()=>{for(let i=0;i<3;i++){const r=await rect(p,T);await drag(p,r.x+r.w/2,r.y+r.h/2,r.x+r.w/2+40,r.y+r.h/2);await p.waitForTimeout(300);}},{undo:false});
await row(`REPEAT x3 trim ${T} right edge`,async()=>{for(let i=0;i<3;i++){const r=await rect(p,T);const x=r.x+r.w-3;await drag(p,x,r.y+r.h/2,x-15,r.y+r.h/2);await p.waitForTimeout(300);}},{undo:false});
{ const y=await rowY(p,'plate');
  await row('REPEAT x3 drop PNG on Plate',async()=>{for(let i=0;i<3;i++){await dropFile(p,300+i*120,y,`sweep${i}.png`);await p.waitForTimeout(400);}},{undo:false}); }
console.log('FINAL', JSON.stringify(await clipIds(p)));
await b.close();

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function readQuickFile(file) {
  const records=fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  const row=records.filter(item=>item.type==='quick_indicator');
  const startup=records.filter(item=>item.type==='runtime_startup');
  if(row.length!==1) throw new Error(`${file}: expected exactly one quick_indicator row; found ${row.length}`);
  if(startup.length>1) throw new Error(`${file}: expected at most one runtime_startup row`);
  return {...row[0],runtime_startup_ms:startup[0]?.elapsed_ms??null,runtime_startup_outcome:startup[0]?.outcome??'not_recorded',
    readiness_preceded_ui:startup[0]?.qualifying_read_preceded_ui_navigation??null};
}
function light(value) {
  if(!value||value.light==='unobserved') return 'unobserved';
  return `${value.light} ${value.seconds==null?'':`${value.seconds.toFixed(2)}s`}`.trim();
}
function ms(value) { return Number.isFinite(value)?`${(value/1000).toFixed(2)}s`:'unobserved'; }
export function formatQuickAggregate(rows) {
  const headings=['size','Runtime launch → subsecond metadata','usable','blocked','immediate save','quiet save'];
  const body=rows.map(row=>[row.label||String(row.size),row.runtime_startup_outcome==='available'?ms(row.runtime_startup_ms):row.runtime_startup_outcome,
    light(row.usable),`${light(row.blocked)}${row.readiness_preceded_ui===true?' (censored; ready before UI)':''}`,light(row.immediate_save),light(row.quiet_save)]);
  const widths=headings.map((h,i)=>Math.max(h.length,...body.map(r=>String(r[i]).length)));
  const line=values=>values.map((v,i)=>String(v).padEnd(widths[i])).join(' | ');
  return [line(headings),widths.map(w=>'-'.repeat(w)).join('-+-'),...body.map(line)].join('\n');
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  const files=process.argv.slice(2);
  if(files.length!==4) throw new Error('Usage: node scripts/save-loop/aggregate-quick.mjs EMPTY.jsonl TEN.jsonl HUNDRED.jsonl HEAVY.jsonl');
  const rows=files.map(readQuickFile);
  const sizes=rows.map(row=>row.size);
  if(new Set(sizes).size!==4) throw new Error('aggregate inputs must represent four distinct measured sizes');
  console.log(formatQuickAggregate(rows));
}

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function readQuickFile(file, {requireRunProvenance=false}={}) {
  const records=fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  const row=records.filter(item=>item.type==='quick_indicator');
  const startup=records.filter(item=>item.type==='runtime_startup');
  const run=records.filter(item=>item.type==='run');
  if(row.length!==1) throw new Error(`${file}: expected exactly one quick_indicator row; found ${row.length}`);
  if(run.length>1||(requireRunProvenance&&run.length!==1)) throw new Error(`${file}: expected exactly one run provenance row; found ${run.length}`);
  if(startup.length>1) throw new Error(`${file}: expected at most one runtime_startup row`);
  const tupleKey=value=>value&&typeof value==='object'&&['app','agent','runtime'].every(key=>typeof value[key]==='string'&&/^[0-9a-f]{40}$/.test(value[key])) ? [value.app,value.agent,value.runtime].join(':') : null;
  const indicatorTuple=tupleKey(row[0].versions);
  if((row[0].versions!==undefined&&!indicatorTuple)||(run.length&&(!indicatorTuple||indicatorTuple!==tupleKey(run[0].versions)))) throw new Error(`${file}: indicator and run version tuples differ or are malformed`);
  return {...row[0],runtime_startup_ms:startup[0]?.elapsed_ms??null,runtime_startup_outcome:startup[0]?.outcome??'not_recorded',
    readiness_preceded_ui:startup[0]?.qualifying_read_preceded_ui_navigation??null};
}
function light(value) {
  if(!value||value.light==='unobserved') return 'unobserved';
  return `${value.light} ${value.seconds==null?'':`${value.seconds.toFixed(2)}s`}`.trim();
}
function ms(value) { return Number.isFinite(value)?`${(value/1000).toFixed(2)}s`:'unobserved'; }
export function formatQuickAggregate(rows) {
  const headings=['size','Runtime launch → subsecond metadata','usable','blocked','immediate save','immediate gesture→POST / POST→response','quiet save','quiet gesture→POST / POST→response'];
  const body=rows.map(row=>[row.label||String(row.size),row.runtime_startup_outcome==='available'?ms(row.runtime_startup_ms):row.runtime_startup_outcome,
    light(row.usable),`${light(row.blocked)}${row.readiness_preceded_ui===true?' (censored; ready before UI)':''}`,light(row.immediate_save),`${ms(row.immediate_save_timing?.gesture_to_post_ms)} / ${ms(row.immediate_save_timing?.post_to_response_ms)}`,light(row.quiet_save),`${ms(row.quiet_save_timing?.gesture_to_post_ms)} / ${ms(row.quiet_save_timing?.post_to_response_ms)}`]);
  const widths=headings.map((h,i)=>Math.max(h.length,...body.map(r=>String(r[i]).length)));
  const line=values=>values.map((v,i)=>String(v).padEnd(widths[i])).join(' | ');
  return [line(headings),widths.map(w=>'-'.repeat(w)).join('-+-'),...body.map(line)].join('\n');
}
export function validateQuickRows(rows) {
  const sizes=rows.map(row=>row.size);
  if(sizes.join(',')!=='0,10,100,300') throw new Error('aggregate inputs must be exactly 0, 10, 100, and 300 clips in that order');
  if(rows[3].label!=='heavy seed history, worst case') throw new Error('300-clip row must be labeled heavy seed history, worst case');
  const tuples=rows.map(row=>row.versions&&['app','agent','runtime'].every(key=>typeof row.versions[key]==='string'&&/^[0-9a-f]{40}$/.test(row.versions[key]))&&[row.versions.app,row.versions.agent,row.versions.runtime].join(':'));
  if(tuples.some(value=>!value||value!==tuples[0])) throw new Error('all four rows must use the same exact App/Agent/Runtime tuple');
  return rows;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  const files=process.argv.slice(2);
  if(files.length!==4) throw new Error('Usage: node scripts/save-loop/aggregate-quick.mjs EMPTY.jsonl TEN.jsonl HUNDRED.jsonl HEAVY.jsonl');
  const rows=files.map(file=>readQuickFile(file,{requireRunProvenance:true}));
  validateQuickRows(rows);
  console.log(formatQuickAggregate(rows));
}

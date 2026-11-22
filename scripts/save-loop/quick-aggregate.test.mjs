import assert from 'node:assert/strict';
import test from 'node:test';
import {formatQuickAggregate, validateQuickRows} from './aggregate-quick.mjs';

const versions={app:'a'.repeat(40),agent:'b'.repeat(40),runtime:'c'.repeat(40)};
function rows(){return [0,10,100,300].map(size=>({size,label:size===300?'heavy seed history, worst case':`${size} clips`,versions,
  runtime_startup_outcome:'available',runtime_startup_ms:1200,readiness_preceded_ui:false,
  usable:{light:'works',seconds:2},blocked:{light:'slow',seconds:3},immediate_save:{light:'works',seconds:1.2},quiet_save:{light:'slow',seconds:2.2},
  immediate_save_timing:{gesture_to_post_ms:100,post_to_response_ms:200},quiet_save_timing:{gesture_to_post_ms:300,post_to_response_ms:400}}));}

test('four-row quick aggregate requires exact sizes, heavy label, and one source tuple',()=>{
  const good=rows();assert.equal(validateQuickRows(good),good);
  assert.throws(()=>validateQuickRows([good[0],good[1],good[2],{...good[3],size:299}]),/exactly 0, 10, 100, and 300/);
  assert.throws(()=>validateQuickRows([good[0],good[1],good[2],{...good[3],label:'300 clips'}]),/heavy seed history/);
  assert.throws(()=>validateQuickRows([good[0],good[1],good[2],{...good[3],versions:{...versions,app:'d'.repeat(40)}}]),/same exact/);
});

test('minute-readable aggregate preserves timing split values',()=>{
  const table=formatQuickAggregate(rows());
  assert.match(table,/heavy seed history, worst case/);
  assert.match(table,/0\.10s \/ 0\.20s/);
  assert.match(table,/0\.30s \/ 0\.40s/);
});

test('strict aggregate rejects missing, malformed, mismatched, and duplicate provenance', async()=>{
  const {default:fs}=await import('node:fs');
  const {default:os}=await import('node:os');
  const {default:path}=await import('node:path');
  const {spawnSync}=await import('node:child_process');
  const {readQuickFile}=await import('./aggregate-quick.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'p77-provenance-'));
  try {
    const files=rows().map((row,i)=>{
      const file=path.join(dir,`${i}.jsonl`);
      fs.writeFileSync(file,[{type:'run',versions},{...row,type:'quick_indicator'}].map(JSON.stringify).join('\n')+'\n');
      return file;
    });
    const cli=()=>spawnSync(process.execPath,['scripts/save-loop/aggregate-quick.mjs',...files],{encoding:'utf8'});
    assert.equal(cli().status,0);
    const indicator={...rows()[0],type:'quick_indicator'};
    const write=records=>fs.writeFileSync(files[0],records.map(JSON.stringify).join('\n')+'\n');
    write([indicator]);
    assert.equal(readQuickFile(files[0]).size,0);
    assert.throws(()=>readQuickFile(files[0],{requireRunProvenance:true}),/run provenance/);
    assert.notEqual(cli().status,0);
    for(const bad of [{...versions,app:'A'.repeat(40)},{...versions,app:'a'}, {...versions,app:'d'.repeat(40)}]) {
      write([{type:'run',versions:bad},indicator]);
      assert.throws(()=>readQuickFile(files[0]),/version tuples/);
      assert.notEqual(cli().status,0);
    }
    write([{type:'run',versions},{type:'run',versions},indicator]);
    assert.throws(()=>readQuickFile(files[0]),/run provenance/);
    assert.notEqual(cli().status,0);
    write([{...indicator,versions:{...versions,app:'A'.repeat(40)}}]);
    assert.throws(()=>readQuickFile(files[0]),/version tuples/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

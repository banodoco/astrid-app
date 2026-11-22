import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {formatQuickAggregate,readQuickFile} from './aggregate-quick.mjs';
import {processRoot,runtimeRootForData} from './cpu.mjs';

test('quick aggregate requires and preserves one indicator plus startup timing',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'p77-quick-aggregate-'));
  try {
    const file=path.join(dir,'empty.jsonl');
    fs.writeFileSync(file,[
      JSON.stringify({type:'runtime_startup',outcome:'available',elapsed_ms:2400,qualifying_read_preceded_ui_navigation:true}),
      JSON.stringify({type:'quick_indicator',size:0,label:'empty',usable:{light:'works',seconds:1.2},blocked:{light:'slow',seconds:8},immediate_save:{light:'works',seconds:1},quiet_save:{light:'unobserved',seconds:null}}),
    ].join('\n')+'\n');
    const row=readQuickFile(file);
    assert.equal(row.runtime_startup_ms,2400);
    assert.match(formatQuickAggregate([row]),/2\.40s/);
    assert.match(formatQuickAggregate([row]),/censored; ready before UI/);
    assert.match(formatQuickAggregate([row]),/unobserved/);
    fs.appendFileSync(file,JSON.stringify({type:'quick_indicator',size:0})+'\n');
    assert.throws(()=>readQuickFile(file),/exactly one quick_indicator/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('quick CPU root matches adopted data identity to owned loopback proxy health', {skip:!['linux','darwin'].includes(process.platform)}, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'p77-quick-cpu-'));
  const data=path.join(root,'quick-data','run');fs.mkdirSync(path.join(data,'runtime'),{recursive:true});
  fs.writeFileSync(path.join(root,'.sl1-stack-owned'),`astrid-app-sl1-stack-v1 ${root}`);
  const proc=processRoot(process.pid);let birth=proc.start;
  if(process.platform==='linux') {
    birth=`proc-start-ticks:${proc.start};boot:${fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};pidns:${fs.statSync(`/proc/${process.pid}/ns/pid`).ino}`;
  }
  fs.writeFileSync(path.join(data,'runtime/discovery.json'),JSON.stringify({pid:process.pid,process_birth_id:birth,runtime_instance_id:'instance-quick-test'}));
  let instance='instance-quick-test';
  const server=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',protocol:'workspace.v1',runtime_instance_id:instance}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/api/runtime/v1/health`;
    assert.deepEqual(await runtimeRootForData(root,data,url),proc);
    instance='different-instance';
    await assert.rejects(runtimeRootForData(root,data,url),/does not match active loopback proxy health/);
  } finally { await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true}); }
});

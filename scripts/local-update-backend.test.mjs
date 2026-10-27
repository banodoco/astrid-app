import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedBackend, runBackendUpdate } from './local-update-backend.mjs';

test('installed backend resolution follows selected venv path rather than system Python symlink', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'astrid-backend-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'versions/old/py/bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(root, 'install.json'), '{"owner":"haus.astrid.runtime"}');
  await writeFile(join(root, 'current'), 'old');
  if (process.platform === 'win32') await copyFile(process.execPath, join(bin, 'python'));
  else await symlink(process.execPath, join(bin, 'python'));
  await writeFile(join(root, 'versions/old/version.json'), JSON.stringify({ root: join(root, 'versions/old'), python: join(bin, 'python'), profile: join(root, 'versions/old/profile.json') }));
  assert.equal(installedBackend(join(bin, 'python')).root, root);
  assert.throws(() => installedBackend(process.execPath), /source checkouts/);
});

const fixture = `
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
let step=0;
lines.on('line', line => {
 const message=JSON.parse(line);
 if (step++===0) {
   if (message.action!=='update') process.exit(2);
   console.log(JSON.stringify({hook:'stop-editor',id:1,app:{test:true}}));
 } else {
   if (message.id!==1) process.exit(3);
   if (message.ok) console.log(JSON.stringify({result:{status:'updated'}}));
   else console.log(JSON.stringify({error:message.error,step:'stop-editor'}));
   process.exit(message.ok ? 0 : 1);
 }
});`;

test('backend JSONL bridge awaits launcher hook acknowledgment before completion', async () => {
  const calls=[];
  const result=await runBackendUpdate({backend:{python:'/unused/python',root:tmpdir()},action:{action:'update'},
    spawnProcess: (_command,args,options) => {
      assert.deepEqual(args.slice(0,3), ['-I','-m','astrid.installer.local_update']);
      assert.equal(options.stdio[0], 'pipe');
      return spawn(process.execPath,['-e',fixture],options);
    },
    hook:async message => {calls.push(message.hook); await new Promise(done=>setImmediate(done));},
  });
  assert.deepEqual(calls,['stop-editor']);
  assert.equal(result.status,'updated');
});

test('backend JSONL bridge returns failed hook step without losing the failure detail', async () => {
  await assert.rejects(runBackendUpdate({backend:{python:'/unused/python',root:tmpdir()},action:{action:'update'},
    spawnProcess:(_command,_args,options)=>spawn(process.execPath,['-e',fixture],options),
    hook:async()=>{throw Object.assign(new Error('editor still owns port'),{step:'stop-editor'});},
  }), error=>error.step==='stop-editor' && /editor still owns port/.test(error.message));
});

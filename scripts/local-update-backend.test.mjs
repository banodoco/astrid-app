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

// The Agent's final reply after it settles the run (astrid-agent local_update.main).
const NEXT = 'Next: open astrid.haus > Settings > Updates > Download diagnostics, and send the file to support.';
const DETAILS = 'Details: /home/me/.local/state/astrid/install.log';
const replyFixture = `
const readline = require('node:readline');
const [reply, code] = process.argv.slice(1);
readline.createInterface({ input: process.stdin }).once('line', () => { console.log(reply); process.exit(Number(code)); });`;
const settled = (reply, code) => runBackendUpdate({ backend: { python: '/unused/python', root: tmpdir() }, action: { action: 'update' },
  spawnProcess: (_command, _args, options) => spawn(process.execPath, ['-e', replyFixture, JSON.stringify(reply), String(code)], options),
  hook: async () => {} });
const notUpdated = { kind: 'not-updated', reason: 'recovered-previous-version', exit_code: 3,
  reason_line: 'an earlier update was interrupted and Astrid restored the version before it; run the same command again to update.' };
const notUpdatedLines = ['Astrid did NOT update. It is still Release 13; Release 14 is available.',
  `Why: ${notUpdated.reason_line}`, 'Your projects are safe — nothing was changed.', NEXT, DETAILS];

test('a settled not-updated reply (receipt exit 3) is its own outcome, not "the backend updater failed"', async () => {
  const result = await settled({ result: { status: 'recovered' }, outcome: notUpdated, lines: notUpdatedLines }, 3);
  assert.equal(result.exitCode, 3);
  assert.equal(result.outcome.kind, 'not-updated');
  assert.equal(result.outcome.reason, 'recovered-previous-version');
});

test('a settled failure keeps its error and carries the receipt exit code with the Next and Details lines', async () => {
  const lines = ['Astrid did NOT update: Astrid or another installer is busy; try again when it finishes.', 'Astrid is still Release 13.', NEXT, DETAILS];
  await assert.rejects(settled({ error: 'busy', step: 'lock', outcome: { kind: 'failed', reason: 'busy', exit_code: 1 }, lines }, 1), (error) => {
    assert.doesNotMatch(error.message, /backend updater failed/);
    assert.equal(error.step, 'lock');
    assert.equal(error.exitCode, 1);
    assert.deepEqual(error.lines.slice(-2), [NEXT, DETAILS]);
    return true;
  });
});

test('the receipt, not the process, decides the exit code', async () => {
  const lines = ['Astrid updated: Release 13 → Release 14.'];
  const result = await settled({ result: { status: 'complete' }, outcome: { kind: 'updated', exit_code: 0 }, lines }, 0);
  assert.equal(result.status, 'complete');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.lines, lines);
});

test('a reply with no receipt (an older Agent) keeps the process exit code as before', async () => {
  assert.deepEqual(await settled({ result: { status: 'complete' } }, 0), { status: 'complete' });
  await assert.rejects(settled({ result: { status: 'recovered' } }, 3), /The backend updater failed: exit 3/);
});

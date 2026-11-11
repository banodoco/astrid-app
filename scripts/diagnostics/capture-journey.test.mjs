import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const capture = resolve('scripts/diagnostics/capture-journey.mjs');
const spawn = (directory, program) => spawnSync(process.execPath, [capture, directory, process.execPath, '-e', program], {encoding:'utf8'});

test('captures only validated diagnostic records in separate streams and keeps journey status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r12-capture-'));
  try {
    const pw = {event:'observer-start', process:1, seq:1};
    const sniff = {event:'request', process:2, scanner:3, request:4, navigation:0, time:42, label:'GET /health request'};
    const program = `console.log('private sentinel'); console.log('TOKEN_SNIFF '+${JSON.stringify(JSON.stringify(sniff))}); console.error('PW_R12 '+${JSON.stringify(JSON.stringify(pw))}); process.exitCode=7;`;
    const result = spawn(dir, program);
    assert.equal(result.status, 7);
    assert.match(result.stdout, /private sentinel/);
    const stdout = readFileSync(join(dir, 'stdout.log'), 'utf8');
    const stderr = readFileSync(join(dir, 'stderr.log'), 'utf8');
    const combined = readFileSync(join(dir, 'combined.log'), 'utf8');
    assert.equal(stdout, `TOKEN_SNIFF ${JSON.stringify(sniff)}\n`);
    assert.equal(stderr, `PW_R12 ${JSON.stringify(pw)}\n`);
    assert.ok(combined.includes(stdout) && combined.includes(stderr));
    assert.ok(!combined.includes('private sentinel'));
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('invalid records fail evidence and never enter artifacts', () => {
  for (const line of [
    'PW_R12 {broken}',
    `PW_R12 ${JSON.stringify({event:'will-send', process:1, seq:1, secret:'private sentinel'})}`,
    `TOKEN_SNIFF ${JSON.stringify({event:'request',process:1,scanner:1,request:1,navigation:0,time:1,label:'GET /private sentinel request'})}`,
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'r12-capture-'));
    try {
      const result = spawn(dir, `console.log(${JSON.stringify(line)});`);
      assert.equal(result.status, 1);
      assert.equal(readFileSync(join(dir, 'combined.log'), 'utf8'), '');
    } finally { rmSync(dir, {recursive:true, force:true}); }
  }
});

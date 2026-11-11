import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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


test('verifier requires completed valid collector status even for complete joins', () => {
  const verifier = resolve('scripts/diagnostics/verify-playwright-log.mjs');
  const pw = [
    {event:'observer-start'}, {event:'will-send', request:9, session:11},
    {event:'paused', request:9, route:10, session:11},
    {event:'created', request:9, route:10, session:11, object:2},
    {event:'dispatcher', object:2, guid:3}, {event:'observer-end', invalid:0},
  ].map((row, i) => `PW_R12 ${JSON.stringify({process:1, seq:i + 1, ...row})}`);
  const sniff = [
    {event:'request', process:4, scanner:5, request:6, navigation:0, time:1},
    {event:'protocol-join', process:4, scanner:5, request:6, navigation:0, time:1, protocol:3},
  ].map(row => `TOKEN_SNIFF ${JSON.stringify(row)}`);
  for (const invalid of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'r12-capture-'));
    try {
      const lines = [...pw, ...sniff, ...(invalid ? ['TOKEN_SNIFF {broken}'] : [])];
      const program = `${lines.map(line => `console.log(${JSON.stringify(line)});`).join('')} process.exitCode=7;`;
      const child = spawn(dir, program);
      assert.equal(child.status, 7);
      const status = JSON.parse(readFileSync(join(dir, 'collector-status.json'), 'utf8'));
      assert.deepEqual(status, {complete:true, invalid});
      const verify = () => spawnSync(process.execPath, [verifier, join(dir, 'combined.log')], {encoding:'utf8'});
      assert.equal(verify().status === 0, !invalid);
      unlinkSync(join(dir, 'collector-status.json'));
      assert.notEqual(verify().status, 0);
      for (const bad of ['{', JSON.stringify({complete:false, invalid:false}), JSON.stringify({complete:true, invalid:false, extra:true})]) {
        writeFileSync(join(dir, 'collector-status.json'), bad);
        assert.notEqual(verify().status, 0);
      }
    } finally { rmSync(dir, {recursive:true, force:true}); }
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const rebuild = 'scripts/installer/rebuild-stand-in.py';
const candidate = 'scripts/installer/freeze-candidate.mjs';

test('stand-in retains source identity, uses installer canonical bytes and refuses missing VibeComfy', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'freeze-tool-'));
  try {
    const input = path.join(dir, 'input.json');
    const output = path.join(dir, 'r2.json');
    const source = { release: 1, agent: { sha: 'agent' }, runtime: { sha: 'runtime' }, tools: { node: 'pin' } };
    writeFileSync(input, JSON.stringify(source));
    const blocked = spawnSync('python3', [rebuild, input, output], { encoding: 'utf8' });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /explicit vibecomfy/);
    const bytes = readFileSync(output, 'utf8');
    const result = JSON.parse(bytes);
    assert.equal(result.release, 2);
    assert.match(result.qualification_marker, /UPDATE LANDED/);
    delete result.qualification_marker;
    result.release = 1;
    assert.deepEqual(result, source);
    assert.match(bytes, /\\u2014/);
    assert.equal(spawnSync('python3', [rebuild, input, output]).status, 1);
    assert.equal(readFileSync(output, 'utf8'), bytes);
    source.vibecomfy = { sha: 'pinned' };
    writeFileSync(input, JSON.stringify(source));
    assert.equal(spawnSync('python3', [rebuild, input, path.join(dir, 'valid.json')]).status, 0);
    source.release = 2;
    writeFileSync(input, JSON.stringify(source));
    assert.equal(spawnSync('python3', [rebuild, input, path.join(dir, 'invalid.json')]).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('candidate refuses moving baselines and output in the App checkout', () => {
  const ref = 'a'.repeat(40);
  let result = spawnSync('node', [candidate, 'input', '/tmp/candidate.json', 'origin/main'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /immutable full commit SHA/);
  result = spawnSync('node', [candidate, 'input', path.resolve('public/candidate.json'), ref], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside the App checkout/);
});

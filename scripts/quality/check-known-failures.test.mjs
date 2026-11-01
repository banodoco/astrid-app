#!/usr/bin/env node

import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkKnownFailures, MAX_SRC_ENTRIES } from './check-known-failures.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, '..', '..');
const gateScript = resolve(moduleDir, 'check-known-failures.mjs');
const tempRoots = [];
after(() => { for (const root of tempRoots) rmSync(root, { recursive: true, force: true }); });

function makeRepo(files) {
  const root = mkdtempSync(join(os.tmpdir(), 'known-failures-'));
  tempRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

const auditedNames = [
  'commits a config edit when a free multi-clip drag drops onto a new bottom track',
  'updates pinnedShotGroupsOverride when a pinned group is dragged across tracks',
  'updates pinnedShotGroupsOverride when a pinned group is dragged onto a new track',
];
const auditedPath = 'src/tools/video-editor/hooks/useClipDrag.test.tsx';
const auditedSource = (names = auditedNames) => names.map((name) => [
  '// EditCommand support required by M2.',
  `it.fails('${name}', () => {});`,
].join('\n')).join('\n');

describe('expected-failure marker ban', () => {
  it('sets the source allowance to zero', () => assert.equal(MAX_SRC_ENTRIES, 0));

  it('rejects an inverse marker in a source unit test', () => {
    const marker = ['it', '.fails'].join('');
    const result = checkKnownFailures({ repoRoot: makeRepo({ 'src/a.test.ts': `${marker}('case', () => {});` }) });
    assert.equal(result.srcCount, 1);
    assert.match(result.problems.join('\n'), /expected-failure markers are forbidden/);
  });

  it('allows exactly the three audited drag callsites', () => {
    const result = checkKnownFailures({ repoRoot: makeRepo({ [auditedPath]: auditedSource() }) });
    assert.equal(result.allowedEntries.length, 3);
    assert.deepEqual(result.forbiddenEntries, []);
    assert.deepEqual(result.problems, []);
  });

  it('rejects an audited name in a different path', () => {
    const result = checkKnownFailures({
      repoRoot: makeRepo({ 'src/other.test.ts': auditedSource([auditedNames[0]]) }),
    });
    assert.equal(result.allowedEntries.length, 0);
    assert.equal(result.forbiddenEntries.length, 1);
    assert.match(result.problems.join('\n'), /expected-failure markers are forbidden/);
  });

  it('rejects a changed audited name', () => {
    const result = checkKnownFailures({
      repoRoot: makeRepo({ [auditedPath]: auditedSource(['commits a different drag case']) }),
    });
    assert.equal(result.allowedEntries.length, 0);
    assert.equal(result.forbiddenEntries.length, 1);
  });

  it('rejects a fourth marker at the audited path', () => {
    const result = checkKnownFailures({
      repoRoot: makeRepo({
        [auditedPath]: auditedSource([...auditedNames, 'a fourth drag case']),
      }),
    });
    assert.equal(result.allowedEntries.length, 3);
    assert.equal(result.forbiddenEntries.length, 1);
  });

  it('rejects duplicate audited callsites', () => {
    const result = checkKnownFailures({
      repoRoot: makeRepo({ [auditedPath]: auditedSource([auditedNames[0], auditedNames[0]]) }),
    });
    assert.equal(result.allowedEntries.length, 0);
    assert.equal(result.forbiddenEntries.length, 2);
  });

  it('rejects an expected-failure marker in a journey spec', () => {
    const marker = ['test', '.fail'].join('');
    const result = checkKnownFailures({ repoRoot: makeRepo({ 'tests/e2e/a.spec.ts': `${marker}('case', () => {});` }) });
    assert.match(result.problems.join('\n'), /expected-failure markers are forbidden/);
  });

  it('allows trees with no expected-failure markers', () => {
    const result = checkKnownFailures({ repoRoot: makeRepo({ 'tests/e2e/a.spec.ts': "test('case', () => {});" }) });
    assert.deepEqual(result.problems, []);
  });

  it('passes for this repository and exits 0 from its CLI entry point', () => {
    const result = checkKnownFailures({ repoRoot });
    assert.equal(result.allowedEntries.length, 0);
    assert.deepEqual(result.forbiddenEntries, []);
    assert.deepEqual(result.problems, []);
    const proc = spawnSync(process.execPath, [gateScript], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(proc.status, 0, proc.stderr);
  });
});

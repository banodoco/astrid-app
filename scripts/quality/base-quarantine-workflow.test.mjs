import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHECKER = 'scripts/quality/check-quarantine-policy.mjs';
const GATE = 'scripts/quality/check-known-failures.mjs';
const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function workflowCommand() {
  const lines = readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8').split('\n');
  const starts = lines.flatMap((line, index) => line === '      - name: Check quarantine policy against the merge base' ? [index] : []);
  assert.equal(starts.length, 1, 'the workflow must have one quarantine-policy step');
  const end = lines.findIndex((line, index) => index > starts[0] && line.startsWith('      - '));
  const step = lines.slice(starts[0], end < 0 ? lines.length : end);
  const run = step.findIndex((line) => line.startsWith('        run: '));
  assert.ok(run >= 0, 'the policy step must execute a command');
  if (step[run] !== '        run: |') return step[run].slice('        run: '.length);
  return step.slice(run + 1).filter((line) => line.startsWith('          ')).map((line) => line.slice(10)).join('\n');
}

function fixture({ trustedChecker = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'p39-base-policy-workflow-'));
  roots.push(root);
  const put = (file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const checker = readFileSync(path.join(ROOT, CHECKER), 'utf8');
  put(GATE, 'export const MAX_SRC_ENTRIES = 0;\nexport const MAX_QUARANTINE_ENTRIES = 10;\nexport const MAX_EXPIRY_DAYS = 14;\n');
  put('config/testing/skipRegistry.mjs', 'export const VITEST_EXPECTED_FAILURES = [];\n');
  put('config/testing/direct-journey-expected-failures.json', '{"direct":[]}');
  put('package.json', JSON.stringify({ scripts: { 'check:quarantine-policy': `node ${CHECKER}` } }));
  const typescript = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).packages['node_modules/typescript'];
  put('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/typescript': typescript } }));
  if (trustedChecker) put(CHECKER, checker);
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'trusted policy base');
  const base = git('rev-parse', 'HEAD');
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  if (!trustedChecker) put(CHECKER, checker);
  return { root, base, put, git, checker, run: () => spawnSync('bash', ['-euo', 'pipefail', '-c', workflowCommand()], {
    cwd: root, env: { ...process.env, QUARANTINE_BASE_REF: base }, encoding: 'utf8',
  }) };
}

it('the actual workflow rejects a raised ceiling even when the candidate checker returns no problems', () => {
  const f = fixture();
  const initial = f.run();
  assert.equal(initial.status, 0, initial.stdout + initial.stderr);
  f.put(GATE, readFileSync(path.join(f.root, GATE), 'utf8').replace('MAX_QUARANTINE_ENTRIES = 10', 'MAX_QUARANTINE_ENTRIES = 11'));
  const forged = f.checker.replace(/export function comparePolicy\([\s\S]*?\n}/,
    "export function comparePolicy() { console.log('FORGED_CANDIDATE_CHECKER_RAN'); return []; }");
  assert.notEqual(forged, f.checker);
  f.put(CHECKER, forged);
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /MAX_QUARANTINE_ENTRIES raised above merge base/);
  assert.doesNotMatch(result.stdout + result.stderr, /FORGED_CANDIDATE_CHECKER_RAN/);
});

it('the actual workflow fails closed when the merge base has no trusted checker', () => {
  const f = fixture({ trustedChecker: false });
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /trusted quarantine checker is absent from merge base/);
});

it('the actual workflow ignores a committed nested TypeScript stub and candidate parser lock', () => {
  const f = fixture();
  f.put(GATE, readFileSync(path.join(f.root, GATE), 'utf8').replace('MAX_QUARANTINE_ENTRIES = 10', 'MAX_QUARANTINE_ENTRIES = 11'));
  const nested = 'scripts/quality/node_modules/typescript';
  f.put(`${nested}/package.json`, JSON.stringify({ name: 'typescript', type: 'module', exports: './index.mjs' }));
  f.put(`${nested}/index.mjs`, `import ts from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'node_modules/typescript/lib/typescript.js')).href)};
    export default { ...ts, createSourceFile(file, text, ...args) {
      console.log('COMMITTED_TYPESCRIPT_STUB_RAN');
      return ts.createSourceFile(file, text.replace('MAX_QUARANTINE_ENTRIES = 11', 'MAX_QUARANTINE_ENTRIES = 10'), ...args);
    } };`);
  f.put('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/typescript': {
    version: '0.0.0', resolved: `file:${nested}`, integrity: 'candidate-controlled',
  } } }));
  f.git('add', '-f', GATE, nested, 'package-lock.json');
  f.git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'commit parser shadow and raised ceiling');
  assert.equal(f.git('ls-files', `${nested}/index.mjs`), `${nested}/index.mjs`);
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /MAX_QUARANTINE_ENTRIES raised above merge base/);
  assert.doesNotMatch(result.stdout + result.stderr, /COMMITTED_TYPESCRIPT_STUB_RAN/);
});

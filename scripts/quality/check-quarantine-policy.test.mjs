import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkQuarantinePolicy } from './check-quarantine-policy.mjs';

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const entry = { id: 'P39-PROBE', file: 'src/a.test.ts', title: 'case', issue: 'https://github.com/banodoco/astrid-app/issues/249', owner: 'probe', expiry: '2026-11-25' };
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'p39-policy-'));
  roots.push(root);
  const put = (file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  put('scripts/quality/check-known-failures.mjs', 'export const MAX_SRC_ENTRIES = 0;\nexport const MAX_QUARANTINE_ENTRIES = 10;\nexport const MAX_EXPIRY_DAYS = 14;\n');
  put('config/testing/skipRegistry.mjs', 'export const VITEST_EXPECTED_FAILURES = [];\n');
  put('config/testing/direct-journey-expected-failures.json', JSON.stringify({ direct: [entry] }));
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'base policy');
  const base = git('rev-parse', 'HEAD');
  return { root, base, put, git, check: () => checkQuarantinePolicy({ repoRoot: root, baseRef: base }) };
}
it('accepts unchanged policy read from the real merge base', () => {
  const f = fixture();
  assert.deepEqual(f.check(), { mergeBase: f.base, problems: [] });
});
for (const [constant, before, afterValue] of [['MAX_QUARANTINE_ENTRIES', 10, 11], ['MAX_EXPIRY_DAYS', 14, 15], ['MAX_SRC_ENTRIES', 0, 1]]) {
  it(`rejects ${constant} raised in the candidate's own code`, () => {
    const f = fixture();
    const file = 'scripts/quality/check-known-failures.mjs';
    f.put(file, readFileSync(path.join(f.root, file), 'utf8').replace(`${constant} = ${before}`, `${constant} = ${afterValue}`));
    f.git('add', '.'); f.git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '-qm', 'raise limit');
    assert.match(f.check().problems.join('\n'), new RegExp(`${constant} raised above merge base`));
  });
}
it('rejects a later expiry even when it remains within the current 14-day window', () => {
  const f = fixture();
  f.put('config/testing/direct-journey-expected-failures.json', JSON.stringify({ direct: [{ ...entry, expiry: '2026-11-26' }] }));
  assert.match(f.check().problems.join('\n'), /expiry extended beyond merge base/);
});
it('cannot reset an expiry by renaming the id or moving the entry between registries', () => {
  const f = fixture();
  f.put('config/testing/direct-journey-expected-failures.json', '{"direct":[]}');
  f.put('config/testing/skipRegistry.mjs', `export const VITEST_EXPECTED_FAILURES = ${JSON.stringify([{ ...entry, id: 'P39-RENAMED', expiry: '2026-11-26' }])};`);
  assert.match(f.check().problems.join('\n'), /expiry extended beyond merge base/);
});
it('rejects moving a registered identity to another test', () => {
  const f = fixture();
  f.put('config/testing/direct-journey-expected-failures.json', JSON.stringify({ direct: [{ ...entry, title: 'replacement' }] }));
  assert.match(f.check().problems.join('\n'), /moved from its merge-base identity/);
});
it('allows a smaller ceiling, earlier expiry and removal', () => {
  const f = fixture();
  f.put('scripts/quality/check-known-failures.mjs', 'export const MAX_SRC_ENTRIES = 0;\nexport const MAX_QUARANTINE_ENTRIES = 9;\nexport const MAX_EXPIRY_DAYS = 13;');
  f.put('config/testing/direct-journey-expected-failures.json', JSON.stringify({ direct: [{ ...entry, expiry: '2026-11-24' }] }));
  assert.deepEqual(f.check().problems, []);
  f.put('config/testing/direct-journey-expected-failures.json', '{"direct":[]}');
  assert.deepEqual(f.check().problems, []);
});
it('fails closed without the immutable Git base', () => {
  const f = fixture();
  assert.throws(() => checkQuarantinePolicy({ repoRoot: f.root, baseRef: 'nonexistent-base' }));
});

it('rejects a new far-future expiry using the merge-base age window', () => {
  const f = fixture();
  f.put('config/testing/direct-journey-expected-failures.json', JSON.stringify({ direct: [entry, {
    ...entry, id: 'P39-NEW', title: 'new case', issue: 'https://github.com/banodoco/astrid-app/issues/253', expiry: '2027-12-01',
  }] }));
  const result = checkQuarantinePolicy({ repoRoot: f.root, baseRef: f.base, today: new Date('2026-11-18T23:59:59Z') });
  assert.match(result.problems.join('\n'), /expiry exceeds merge-base 14-day window.*2026-12-02/);
});

it('keeps the previous expiry when both id and title are renamed under the same issue', () => {
  const f = fixture();
  f.put('config/testing/direct-journey-expected-failures.json', JSON.stringify({ direct: [{
    ...entry, id: 'P39-RENAMED-AGAIN', title: 'renamed case', expiry: '2026-11-26',
  }] }));
  const result = checkQuarantinePolicy({ repoRoot: f.root, baseRef: f.base, today: new Date('2026-11-18T00:00:00Z') });
  assert.match(result.problems.join('\n'), /expiry extended beyond merge base.*2026-11-25 -> 2026-11-26/);
});

it('accepts the last UTC day of the base window and rejects an invalid expiry date', () => {
  const f = fixture();
  const candidate = { ...entry, id: 'P39-NEW', title: 'new case', issue: 'https://github.com/banodoco/astrid-app/issues/253' };
  f.put('config/testing/direct-journey-expected-failures.json', JSON.stringify({ direct: [{ ...candidate, expiry: '2026-12-02' }] }));
  const check = () => checkQuarantinePolicy({ repoRoot: f.root, baseRef: f.base, today: new Date('2026-11-18T00:00:00Z') });
  assert.deepEqual(check().problems, []);
  f.put('config/testing/direct-journey-expected-failures.json', JSON.stringify({ direct: [{ ...candidate, expiry: '2026-11-99' }] }));
  assert.match(check().problems.join('\n'), /invalid expiry date/);
});

for (const [form, declaration] of [
  ['aliased export', `const QF = ${JSON.stringify([{ ...entry, expiry: '2027-12-01' }])}; export { QF as VITEST_EXPECTED_FAILURES };`],
  ['missing export', 'export const UNRELATED = [];'],
  ['mutable let export', 'export let VITEST_EXPECTED_FAILURES = [];'],
  ['mutable var export', 'export var VITEST_EXPECTED_FAILURES = [];'],
]) {
  it(`rejects a registry without a literal export const: ${form}`, () => {
    const f = fixture();
    f.put('config/testing/skipRegistry.mjs', declaration);
    assert.throws(f.check, /VITEST_EXPECTED_FAILURES.*literal export const/);
  });
}

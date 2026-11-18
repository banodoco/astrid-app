import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { expectedFailureProblems } from '../../config/testing/skipRegistry.mjs';

const ROOT = path.resolve(__dirname, '../..');

it('rejects an undeclared expected failure even when Vitest reports it as passed', () => {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run',
    '--config', 'src/test/__fixtures__/skipGuard/vitest.config.ts',
    'expected-fail.fixture.ts',
  ], { cwd: ROOT, env: { ...process.env, CI: '' }, encoding: 'utf8' });
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(/UNDECLARED EXPECTED FAILURE.*an undeclared expected failure/);
});

function runFixture(file: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [
    path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run',
    '--config', 'src/test/__fixtures__/skipGuard/vitest.config.ts', file,
  ], { cwd: ROOT, env: { ...process.env, CI: '', ASTRID_RUNTIME_CHECKOUT: path.join(tmpdir(), 'p39-no-runtime'), ...env }, encoding: 'utf8' });
}

for (const fixture of ['forged-skip.fixture.ts', 'borrowed-skip.fixture.ts', 'wrong-tag.fixture.ts']) {
  it(`refuses a tag without this item's binding: ${fixture}`, () => {
    const result = runFixture(fixture);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('UNDECLARED SKIP');
  });
}

it('binds a legitimate renamed helper to each dynamically named test', () => {
  const result = runFixture('aliased-skip.fixture.ts');
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout + result.stderr).toContain('declared skips (2)');
});

it('rejects a forged skip even when an inert helper call binds the same item and name', () => {
  const result = runFixture('false-predicate.fixture.ts', { CI: 'true' });
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('UNDECLARED SKIP');
});

it('refuses a bound skip when this job requires its lane', () => {
  const result = runFixture('aliased-skip.fixture.ts', { ASTRID_REQUIRE_LANES: 'direct-journey' });
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('UNDECLARED SKIP');
});

it('catches an expected-failure API assembled at runtime', () => {
  const result = runFixture('dynamic-fails.fixture.ts');
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(/UNDECLARED EXPECTED FAILURE.*computed expected failure/);
});

it('preserves Vitest strict unexpected-pass failure', () => {
  const result = runFixture('unexpected-pass.fixture.ts');
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('Expect test to fail');
});

for (const env of [{ P39_EACH_LITERAL: '1' }, { P39_EACH_LITERAL: '0' }]) {
  it(`refuses an each table that creates zero cases (literal=${env.P39_EACH_LITERAL})`, () => {
    const result = runFixture('empty-each.fixture.ts', env);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('test.each() requires at least one row');
  });
}

it('preserves every row of a nonempty evaluated each table', () => {
  const result = runFixture('empty-each.fixture.ts', { P39_EACH_LITERAL: '0', P39_EACH_ROWS: 'nonempty' });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout + result.stderr).toMatch(/3 passed/);
});

describe('runtime expected-failure equality', () => {
  const entry = { file: 'src/a.test.ts', title: 'suite > case' };
  const selected = new Set([entry.file]);
  it('accepts the exact registered set', () => {
    expect(expectedFailureProblems([entry], selected, [entry])).toEqual([]);
  });
  it('rejects a missing registered marker', () => {
    expect(expectedFailureProblems([], selected, [entry])).toEqual([`MISSING EXPECTED FAILURE ${entry.file} > ${entry.title}`]);
  });
  it('rejects moving the marker to another full title', () => {
    expect(expectedFailureProblems([{ ...entry, title: 'other > case' }], selected, [entry])).toEqual([
      `UNDECLARED EXPECTED FAILURE ${entry.file} > other > case`,
      `MISSING EXPECTED FAILURE ${entry.file} > ${entry.title}`,
    ]);
  });
  it('rejects duplicate instances under one registry identity', () => {
    expect(expectedFailureProblems([entry, entry], selected, [entry])).toEqual([`DUPLICATE EXPECTED FAILURE ${entry.file} > ${entry.title}`]);
  });
  it('limits completeness to the files selected by a focused run', () => {
    expect(expectedFailureProblems([], new Set(['src/unrelated.test.ts']), [entry])).toEqual([]);
  });
});

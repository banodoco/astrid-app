import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

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

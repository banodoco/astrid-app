import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PUBLIC_TRIM_PLAYWRIGHT_ARGS, runPublicTrimAction } from './public-trim-action-wrapper.mjs';

const require = createRequire(import.meta.url);
const PLAYWRIGHT_PACKAGE = path.dirname(require.resolve('@playwright/test'));
const PLAYWRIGHT_CLI = path.join(PLAYWRIGHT_PACKAGE, 'cli.js');
const WRAPPER = path.resolve('scripts/testing/public-trim-action-wrapper.mjs');

test('retains a planted non-browser Playwright failure outside output-dir cleanup', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'public-trim-wrapper-'));
  const outputDir = path.join(root, 'browser-artifacts');
  const recordDir = path.join(root, 'record');
  const controlDir = path.join(root, 'control');
  mkdirSync(controlDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, 'action.log'), 'this must be deleted by Playwright\n');
  const spec = path.join(controlDir, 'planted-failure.spec.mjs');
  const config = path.join(controlDir, 'playwright.config.mjs');
  writeFileSync(spec, [
    `import { test } from ${JSON.stringify(path.join(PLAYWRIGHT_PACKAGE, 'index.mjs'))};`,
    "import { writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "test('planted wrapper failure without page or browser fixtures', () => {",
    "  writeFileSync(path.join(process.env.PLAYWRIGHT_OUTPUT_DIR, 'error-context.md'), 'PLANTED_ERROR_CONTEXT\\n');",
    "  writeFileSync(path.join(process.env.PLAYWRIGHT_OUTPUT_DIR, 'trace.zip'), 'PLANTED_TRACE\\n');",
    "  throw new Error('PLANTED_WRAPPER_FAILURE');",
    "});",
  ].join('\n'));
  writeFileSync(config, `export default { testDir: ${JSON.stringify(controlDir)}, outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR, reporter: 'list' };\n`);

  try {
    const status = runPublicTrimAction({
      cwd: process.cwd(),
      command: process.execPath,
      args: [PLAYWRIGHT_CLI, 'test', '--config', config, spec],
      env: { ...process.env, PLAYWRIGHT_OUTPUT_DIR: outputDir, RECORD_DIR: recordDir },
    });
    assert.equal(status, 1);
    assert.equal(readFileSync(path.join(recordDir, 'exit'), 'utf8').trim(), '1');
    const actionLog = readFileSync(path.join(recordDir, 'action.log'), 'utf8');
    assert.match(actionLog, /PLANTED_WRAPPER_FAILURE/);
    assert.match(actionLog, /1 failed/);
    assert.doesNotMatch(actionLog, /No tests found/);
    assert.equal(existsSync(path.join(outputDir, 'action.log')), false);
    assert.equal(existsSync(path.join(recordDir, 'playwright-output', '.last-run.json')), true);
    assert.equal(readFileSync(path.join(recordDir, 'playwright-output', 'error-context.md'), 'utf8'), 'PLANTED_ERROR_CONTEXT\n');
    assert.equal(readFileSync(path.join(recordDir, 'playwright-output', 'trace.zip'), 'utf8'), 'PLANTED_TRACE\n');

    const wrapper = spawnSync(process.execPath, [WRAPPER, PLAYWRIGHT_CLI, 'test', '--config', config, spec], {
      cwd: process.cwd(),
      env: { ...process.env, PLAYWRIGHT_OUTPUT_DIR: outputDir, RECORD_DIR: recordDir },
      encoding: 'utf8',
    });
    assert.equal(wrapper.status, 1);
    const entrypointLog = readFileSync(path.join(recordDir, 'action.log'), 'utf8');
    assert.match(entrypointLog, /PLANTED_WRAPPER_FAILURE/);
    assert.match(entrypointLog, /1 failed/);
    assert.equal(statSync(recordDir).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects symlinked record directories and hardens existing records', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'public-trim-wrapper-custody-'));
  const outputDir = path.join(root, 'browser-artifacts');
  const targetDir = path.join(root, 'record-target');
  const symlinkRecord = path.join(root, 'record-link');
  const recordDir = path.join(root, 'record');
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(recordDir, { recursive: true });
  chmodSync(recordDir, 0o755);
  symlinkSync(targetDir, symlinkRecord, 'dir');

  try {
    assert.throws(() => runPublicTrimAction({
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      env: { ...process.env, PLAYWRIGHT_OUTPUT_DIR: outputDir, RECORD_DIR: symlinkRecord },
    }), /RECORD_DIR must not contain symlinks/);
    assert.equal(lstatSync(symlinkRecord).isSymbolicLink(), true);
    assert.equal(existsSync(path.join(targetDir, 'action.log')), false);

    const status = runPublicTrimAction({
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      env: { ...process.env, PLAYWRIGHT_OUTPUT_DIR: outputDir, RECORD_DIR: recordDir },
    });
    assert.equal(status, 7);
    assert.equal(statSync(recordDir).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('central planted service failure keeps child7, wrapper7, and records across the outer exec', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'public-trim-wrapper-central-'));
  const outputDir = path.join(root, 'browser-artifacts');
  const recordDir = path.join(root, 'record');
  const service = path.join(root, 'planted-service.mjs');
  writeFileSync(service, [
    "import { mkdirSync, rmSync, writeFileSync } from 'node:fs';",
    "const output = process.env.PLAYWRIGHT_OUTPUT_DIR;",
    "rmSync(output, { recursive: true, force: true });",
    "mkdirSync(output, { recursive: true, mode: 0o700 });",
    "writeFileSync(`${output}/error-context.md`, 'CENTRAL_PLANTED_SERVICE_FAILURE\\n');",
    "console.error('CENTRAL_PLANTED_SERVICE_FAILURE');",
    'process.exit(7);',
  ].join('\n'), { mode: 0o600 });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, 'action.log'), 'must be removed by service cleanup\n');

  try {
    const outerCommand = `set -Eeuo pipefail; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(WRAPPER)} ${JSON.stringify(service)}`;
    const central = spawnSync('/bin/bash', ['-c', outerCommand], {
      cwd: process.cwd(),
      env: { ...process.env, PLAYWRIGHT_OUTPUT_DIR: outputDir, RECORD_DIR: recordDir },
      encoding: 'utf8',
    });
    assert.equal(central.status, 7);
    assert.equal(readFileSync(path.join(recordDir, 'exit'), 'utf8').trim(), '7');
    const actionLog = readFileSync(path.join(recordDir, 'action.log'), 'utf8');
    assert.match(actionLog, /CENTRAL_PLANTED_SERVICE_FAILURE/);
    assert.equal(readFileSync(path.join(recordDir, 'playwright-output', 'error-context.md'), 'utf8'), 'CENTRAL_PLANTED_SERVICE_FAILURE\n');
    assert.equal(existsSync(path.join(outputDir, 'action.log')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps the production public Trim argv unchanged', () => {
  assert.deepEqual(PUBLIC_TRIM_PLAYWRIGHT_ARGS, [
    'node_modules/@playwright/test/cli.js',
    'test',
    '--config',
    'playwright.public-trim.config.ts',
    'tests/e2e/local/public-trim-mounted-fixture.spec.ts',
  ]);
});

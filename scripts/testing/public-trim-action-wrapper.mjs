#!/usr/bin/env node

import { appendFileSync, closeSync, constants, cpSync, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PUBLIC_TRIM_PLAYWRIGHT_ARGS = Object.freeze([
  'node_modules/@playwright/test/cli.js',
  'test',
  '--config',
  'playwright.public-trim.config.ts',
  'tests/e2e/local/public-trim-mounted-fixture.spec.ts',
]);

function fail(message) {
  throw new Error(`[public-trim/action-wrapper] ${message}`);
}

function requiredAbsolute(env, name) {
  const value = env[name]?.trim();
  if (!value) fail(`${name} is required`);
  if (!path.isAbsolute(value)) fail(`${name} must be absolute`);
  return path.resolve(value);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function rejectSymlinkPath(target, name) {
  const root = path.parse(target).root;
  let current = root;
  for (const part of target.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) fail(`${name} must not contain symlinks`);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

function ensurePrivateRecordDirectory(recordDir) {
  rejectSymlinkPath(recordDir, 'RECORD_DIR');
  mkdirSync(recordDir, { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = openSync(recordDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fchmodSync(fd, 0o700);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return realpathSync(recordDir);
}

function prepareRecordDirectory(recordDir, outputDir) {
  const record = ensurePrivateRecordDirectory(recordDir);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const output = realpathSync(outputDir);
  if (isInside(output, record)) fail('RECORD_DIR must be outside PLAYWRIGHT_OUTPUT_DIR');
  return { record, output };
}

function retainPlaywrightOutput(outputDir, recordDir, actionLog) {
  if (!existsSync(outputDir)) return;
  const retained = path.join(recordDir, 'playwright-output');
  cpSync(outputDir, retained, { recursive: true, force: true });
  appendFileSync(actionLog, `wrapper retained Playwright output at ${retained}\n`);
}

export function runPublicTrimAction({
  env = process.env,
  cwd = process.cwd(),
  command = process.execPath,
  args = PUBLIC_TRIM_PLAYWRIGHT_ARGS,
} = {}) {
  const outputDir = requiredAbsolute(env, 'PLAYWRIGHT_OUTPUT_DIR');
  const recordDir = requiredAbsolute(env, 'RECORD_DIR');
  const prepared = prepareRecordDirectory(recordDir, outputDir);
  const actionLog = path.join(prepared.record, 'action.log');
  const exitFile = path.join(prepared.record, 'exit');
  writeFileSync(actionLog, '', { mode: 0o600 });

  let status = 1;
  let childError;
  let logFd;
  try {
    logFd = openSync(actionLog, 'a');
    const child = spawnSync(command, args, {
      cwd,
      env: { ...env, PLAYWRIGHT_OUTPUT_DIR: prepared.output },
      shell: false,
      stdio: ['ignore', logFd, logFd],
    });
    if (child.error) childError = child.error;
    if (Number.isInteger(child.status)) status = child.status;
    else if (child.signal) childError = new Error(`child terminated by ${child.signal}`);
  } catch (error) {
    childError = error;
  } finally {
    if (logFd !== undefined) closeSync(logFd);
  }

  if (childError) appendFileSync(actionLog, `wrapper child error: ${childError.message}\n`);
  writeFileSync(exitFile, `${status}\n`, { mode: 0o600 });
  try {
    retainPlaywrightOutput(prepared.output, prepared.record, actionLog);
  } catch (error) {
    appendFileSync(actionLog, `wrapper retention error: ${error.message}\n`);
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runPublicTrimAction({ args: process.argv.length > 2 ? process.argv.slice(2) : undefined });
}

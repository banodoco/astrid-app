#!/usr/bin/env node
// A stalled task must not strand already-finished task updates in Vitest's throttle.
// Pinned upstream cause: the elapsed-time boundary is strict, and the timer callback
// retains its expired handle. An exact/early timer then cannot schedule another flush.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const BEFORE = `function throttle(fn, ms) {
\tlet last = 0;
\tlet pendingCall;
\treturn function call(...args) {
\t\tconst now = unixNow();
\t\tif (now - last > ms) {
\t\t\tlast = now;
\t\t\tclearTimeout(pendingCall);
\t\t\tpendingCall = undefined;
\t\t\treturn fn.apply(this, args);
\t\t}
\t\t// Make sure fn is still called even if there are no further calls
\t\tpendingCall ??= setTimeout(() => call.bind(this)(...args), ms);
\t};
}`;
const AFTER = BEFORE.replace('now - last > ms', 'now - last >= ms').replace(
  'pendingCall ??= setTimeout(() => call.bind(this)(...args), ms);',
  `pendingCall ??= setTimeout(() => {
\t\t\tpendingCall = undefined;
\t\t\tcall.apply(this, args);
\t\t}, ms);`,
);

export function patchedSource(source) {
  const occurrences = (block) => source.split(block).length - 1;
  if (occurrences(AFTER) === 1 && occurrences(BEFORE) === 0) return source;
  if (occurrences(BEFORE) !== 1 || occurrences(AFTER) !== 0) {
    throw new Error('Vitest task-update throttle differs from the audited 4.1.5 source; inspect it before updating the patch');
  }
  return source.replace(BEFORE, AFTER);
}

export function patchInstalledRunner({ check = false } = {}) {
  let manifest;
  try {
    manifest = require.resolve('@vitest/runner/package.json');
  } catch (error) {
    const omittedDev = (process.env.npm_config_omit ?? '').split(/[\s,]+/).includes('dev')
      || process.env.NODE_ENV === 'production';
    // Production installs may omit this devDependency. A test command's --check
    // still refuses an absent runner; installation never certifies a test run.
    if (!check && omittedDev && error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
  const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
  if (version !== '4.1.5') throw new Error(`expected @vitest/runner 4.1.5, found ${version}; re-prove the streaming patch before upgrading`);
  const file = path.join(path.dirname(manifest), 'dist/chunk-artifact.js');
  const source = readFileSync(file, 'utf8');
  const patched = patchedSource(source);
  if (check && patched !== source) throw new Error('Vitest streaming patch is absent; run npm install with postinstall enabled');
  if (!check && patched !== source) writeFileSync(file, patched);
  return file;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv.length !== 3 || !['--apply', '--check'].includes(process.argv[2])) {
      throw new Error('usage: node scripts/patches/vitest-4.1.5-result-stream.mjs --apply|--check');
    }
    const file = patchInstalledRunner({ check: process.argv[2] === '--check' });
    console.log(file ? 'Vitest 4.1.5 task-update streaming patch verified.'
      : 'Production installation omits the Vitest development runner.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

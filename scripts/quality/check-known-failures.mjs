#!/usr/bin/env node
// Expected failures are forbidden except for named Direct Journey exceptions in
// config/testing/direct-journey-expected-failures.json (the same list the Direct Journey workflow enforces).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { globSync } from 'tinyglobby';
import { ALL_VITEST_INCLUDE } from '../../config/testing/vitestIncludes.mjs';
import { VITEST_EXPECTED_FAILURES } from '../../config/testing/skipRegistry.mjs';
import { inspectTestSource } from './lib/test-source.mjs';

const DEFAULT_REPO_ROOT = path.resolve(import.meta.dirname, '../..');
export const MAX_SRC_ENTRIES = 0;
const EXCEPTIONS_FILE = path.join(DEFAULT_REPO_ROOT, 'config/testing/direct-journey-expected-failures.json');
// Plan 39 quarantine rule. Each entry: { id (the Plan 39 item), file, title, issue, owner, expiry }. A marker is allowed
// only inside the test with exactly that title, in that file, directly under a comment line naming the entry id; no other
// marker in the file is. The guard fails on a missing field, an expired entry (or one more than 14 days out), or more than
// MAX_QUARANTINE_ENTRIES allowed markers in total.
export const MAX_QUARANTINE_ENTRIES = 10;
export const MAX_EXPIRY_DAYS = 14;
export const REQUIRED_FIELDS = ['id', 'file', 'title', 'issue', 'owner', 'expiry'];
export const DIRECT_JOURNEY_EXCEPTIONS = Object.values(JSON.parse(fs.readFileSync(EXCEPTIONS_FILE, 'utf8'))).flat();
function scanFile(file, repoRoot, exceptions) {
  const rel = path.relative(repoRoot, file).split(path.sep).join('/');
  const markers = inspectTestSource(file).expectedFailures;
  const exceptionOf = (marker) => exceptions.find((item) => item.file === rel
    && item.title === (marker.kind === 'vitest' ? marker.fullTitle : marker.title)
    && (marker.kind === 'vitest' || marker.previousLine.includes(item.id)));
  const counts = new Map();
  for (const marker of markers) {
    const item = exceptionOf(marker);
    if (item) counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return markers.map((marker) => {
    const item = exceptionOf(marker);
    const allowed = item && counts.get(item) === 1;
    return {
      where: `${rel}:${marker.line}`,
      status: allowed ? 'ALLOWED' : 'FORBIDDEN',
      detail: allowed ? `named exception ${item.id}` : 'expected-failure marker',
      name: marker.fullTitle ?? marker.title,
      ...(allowed ? { exceptionId: item.id } : {}),
    };
  });
}

/**
 * Runs the gate over one repo tree. Returns the entries, the problems (each one fails the gate),
 * and the per-spec counts, so callers can print or assert on them.
 */
export function validateExceptions(exceptions, today = new Date()) {
  const problems = [];
  const day = (date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  for (const [index, item] of exceptions.entries()) {
    const label = item?.id ?? `entry ${index}`;
    const missing = REQUIRED_FIELDS.filter((field) => typeof item?.[field] !== 'string' || item[field].trim() === '');
    if (missing.length > 0) {
      problems.push(`${label}: missing field(s) ${missing.join(', ')}`);
      continue;
    }
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(item.issue)) problems.push(`${label}: issue must be a GitHub issue URL`);
    const expiry = /^\d{4}-\d{2}-\d{2}$/.test(item.expiry) ? new Date(`${item.expiry}T00:00:00Z`) : null;
    if (!expiry || Number.isNaN(expiry.getTime())) {
      problems.push(`${label}: expiry "${item.expiry}" is not a YYYY-MM-DD date`);
      continue;
    }
    const daysLeft = (expiry.getTime() - day(today)) / 86_400_000;
    if (daysLeft < 0) problems.push(`${label}: expired on ${item.expiry}`);
    if (daysLeft > MAX_EXPIRY_DAYS) problems.push(`${label}: expiry ${item.expiry} is more than ${MAX_EXPIRY_DAYS} days out`);
  }
  return problems;
}

export function checkKnownFailures({ repoRoot = DEFAULT_REPO_ROOT, requireAllExceptions = false, exceptions = [...DIRECT_JOURNEY_EXCEPTIONS, ...VITEST_EXPECTED_FAILURES], today = new Date(), include = ALL_VITEST_INCLUDE } = {}) {
  const entries = [];

  // Use the same include globs as Vitest, including JS and edge functions. Scan
  // all declared lanes, even when this invocation selects only the default lane.
  const files = globSync([...include, 'tests/**/*.spec.ts'], {
    cwd: repoRoot, absolute: true, onlyFiles: true,
    ignore: ['**/node_modules/**', '**/.git/**'],
  }).sort();
  for (const file of files) entries.push(...scanFile(file, repoRoot, exceptions));

  const allowedEntries = entries.filter((entry) => entry.status === 'ALLOWED');
  const forbiddenEntries = entries.filter((entry) => entry.status === 'FORBIDDEN');
  const problems = forbiddenEntries.map((entry) => `${entry.where}: expected-failure markers are forbidden`);
  problems.push(...validateExceptions(exceptions, today));
  if (allowedEntries.length > MAX_QUARANTINE_ENTRIES || exceptions.length > MAX_QUARANTINE_ENTRIES) {
    problems.push(`more than ${MAX_QUARANTINE_ENTRIES} quarantined expected failures (${allowedEntries.length} markers, ${exceptions.length} registry entries)`);
  }
  if (requireAllExceptions) {
    // The allowlist and the markers must match exactly: a listed exception with no marker (renamed, removed) is a failure too.
    for (const item of exceptions) {
      if (!allowedEntries.some((entry) => entry.exceptionId === item.id)) {
        problems.push(`${item.file}: named exception ${item.id} ("${item.title}") has no matching expected-failure marker`);
      }
    }
  }
  return {
    entries,
    allowedEntries,
    forbiddenEntries,
    problems,
    srcCount: forbiddenEntries.filter((entry) => entry.where.startsWith('src/')).length,
  };
}

function main() {
  const result = checkKnownFailures({ requireAllExceptions: true });
  for (const entry of result.allowedEntries) {
    console.log(`${entry.where} | ${entry.detail}`);
  }
  for (const entry of result.forbiddenEntries) {
    console.log(`${entry.where} | ${entry.detail}`);
  }
  console.log(`authorized expected-failure markers: ${result.allowedEntries.length}`);
  console.log(`forbidden expected-failure markers: ${result.forbiddenEntries.length} (maximum ${MAX_SRC_ENTRIES})`);
  for (const problem of result.problems) console.error(`FAIL ${problem}`);
  process.exit(result.problems.length > 0 ? 1 : 0);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}

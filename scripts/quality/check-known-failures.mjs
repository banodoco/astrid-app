#!/usr/bin/env node
// Expected failures are forbidden except for the three audited drag requirements below.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPO_ROOT = path.resolve(import.meta.dirname, '../..');
export const MAX_SRC_ENTRIES = 0;
const MARKER_RE = /\b(?:it|test)\.fails?\b/;
const AUTHORIZED_PATH = 'src/tools/video-editor/hooks/useClipDrag.test.tsx';

// AUDIT REDIRECT (2026-10-19): these are the exact three requirements from the
// drag audit. Remove this allowlist when M2 EditCommand implementations make
// the tests ordinary passing tests.
const AUTHORIZED_NAMES = new Set([
  'commits a config edit when a free multi-clip drag drops onto a new bottom track',
  'updates pinnedShotGroupsOverride when a pinned group is dragged across tracks',
  'updates pinnedShotGroupsOverride when a pinned group is dragged onto a new track',
]);

function listFiles(dir, namePattern) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, namePattern);
    return namePattern.test(entry.name) ? [full] : [];
  });
}

function scanFile(file, repoRoot) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const rel = path.relative(repoRoot, file).split(path.sep).join('/');
  const markers = lines.flatMap((line, index) => {
    if (!MARKER_RE.test(line)) return [];
    return [...line.matchAll(/\b(?:it|test)\.fails?\b/g)].map((match) => {
      const where = `${rel}:${index + 1}`;
      const call = line.slice(match.index + match[0].length)
        .match(/^\s*\(\s*(['"])(.*?)\1/);
      return {
        where,
        name: call?.[2],
        hasRequirementComment: /\/\/.*\bEditCommand\b.*\bM[12]\b/.test(lines[index - 1] ?? ''),
      };
    });
  });

  const names = new Map();
  for (const marker of markers) {
    if (marker.name === undefined) continue;
    const key = `${rel}\0${marker.name}`;
    names.set(key, (names.get(key) ?? 0) + 1);
  }

  return markers.map((marker) => {
    const isAuthorized = rel === AUTHORIZED_PATH
      && AUTHORIZED_NAMES.has(marker.name)
      && marker.hasRequirementComment
      && (names.get(`${rel}\0${marker.name}`) ?? 0) === 1;
    if (isAuthorized) {
      return {
        where: marker.where,
        status: 'ALLOWED',
        detail: 'audited expected-failure marker',
        name: marker.name,
      };
    }
    return {
      where: marker.where,
      status: 'FORBIDDEN',
      detail: 'expected-failure marker',
      name: marker.name,
    };
  });
}

/**
 * Runs the gate over one repo tree. Returns the entries, the problems (each one fails the gate),
 * and the per-spec counts, so callers can print or assert on them.
 */
export function checkKnownFailures({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const entries = [];

  const srcEntries = listFiles(path.join(repoRoot, 'src'), /\.test\.tsx?$/)
    .flatMap((file) => scanFile(file, repoRoot));
  entries.push(...srcEntries);

  for (const file of listFiles(path.join(repoRoot, 'tests'), /\.spec\.ts$/)) {
    const found = scanFile(file, repoRoot);
    entries.push(...found);
  }

  const allowedEntries = entries.filter((entry) => entry.status === 'ALLOWED');
  const forbiddenEntries = entries.filter((entry) => entry.status === 'FORBIDDEN');
  const problems = forbiddenEntries.map((entry) => `${entry.where}: expected-failure markers are forbidden`);
  return {
    entries,
    allowedEntries,
    forbiddenEntries,
    problems,
    srcCount: forbiddenEntries.filter((entry) => entry.where.startsWith('src/')).length,
  };
}

function main() {
  const result = checkKnownFailures();
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

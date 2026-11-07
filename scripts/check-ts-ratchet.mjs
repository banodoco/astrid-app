#!/usr/bin/env node
/**
 * TypeScript error-count ratchet for the app project.
 *
 * `tsconfig.app.json` is a "solution-style" project reference — the repo's own
 * The full app typecheck is not always run by build/test scripts; this gate
 * enforces the committed error baseline (currently zero), preventing regressions.
 *
 * It runs the app project's typecheck, counts `error TS` lines, and compares
 * the count against the committed baseline in `config/ts-error-baseline.json`:
 *   - count > baseline  -> fail: new type errors were introduced.
 *   - count < baseline  -> pass, but print instructions to ratchet the
 *     baseline down in the same PR (the file change must be a reviewed act,
 *     so this script never writes it).
 *   - count === baseline -> pass, silently.
 *
 * TypeScript exits nonzero when it reports errors. We inspect its diagnostics
 * rather than treating that exit code alone as the ratchet verdict; only the
 * baseline comparison decides whether this gate fails.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { packageManagerInvocation } from './node-package-manager.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const baselinePath = join(repoRoot, 'config', 'ts-error-baseline.json');
const tsconfigPath = 'tsconfig.app.json';

function readBaseline() {
  let raw;
  try {
    raw = readFileSync(baselinePath, 'utf8');
  } catch (error) {
    console.error(`[ts-ratchet] Could not read baseline file at ${baselinePath}: ${error.message}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`[ts-ratchet] Baseline file at ${baselinePath} is not valid JSON: ${error.message}`);
    process.exit(1);
  }

  if (typeof parsed.maxErrors !== 'number' || !Number.isFinite(parsed.maxErrors)) {
    console.error(`[ts-ratchet] Baseline file at ${baselinePath} is missing a numeric "maxErrors" field.`);
    process.exit(1);
  }

  return parsed.maxErrors;
}

function countTsErrors() {
  // `tsc --noEmit` exits 1/2 whenever it reports any error — that is the
  // possible when the compiler reports errors, so we
  // read stdout/stderr regardless of the exit code rather than treating a
  // nonzero status as a script failure.
  const invocation = packageManagerInvocation('npx', ['tsc', '-p', tsconfigPath, '--noEmit']);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });

  if (result.error) {
    console.error(`[ts-ratchet] Failed to invoke tsc: ${result.error.message}`);
    process.exit(1);
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const matches = output.match(/error TS\d+:/g) ?? [];
  return { count: matches.length, output };
}

const baseline = readBaseline();
const { count } = countTsErrors();

if (count > baseline) {
  console.error(
    `[ts-ratchet] ${count} errors vs baseline ${baseline} — new type errors introduced; `
      + 'fix them or (only for pre-existing reclassifications) update '
      + 'config/ts-error-baseline.json with justification.',
  );
  process.exit(1);
}

if (count < baseline) {
  console.log(
    `[ts-ratchet] Nice — ${count} errors vs baseline ${baseline}. `
      + `Ratchet the baseline down in the same PR: set "maxErrors" to ${count} in `
      + `${join('config', 'ts-error-baseline.json')} (reviewed act, not auto-written by this script).`,
  );
  process.exit(0);
}

console.log(`[ts-ratchet] ${count} errors, matches baseline ${baseline}. OK.`);
process.exit(0);

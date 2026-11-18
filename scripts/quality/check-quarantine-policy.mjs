#!/usr/bin/env node
// Compare policy data with Git's merge base, never with a second editable copy.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '../..');
const GATE = 'scripts/quality/check-known-failures.mjs';
const SKIPS = 'config/testing/skipRegistry.mjs';
const JOURNEY = 'config/testing/direct-journey-expected-failures.json';
const LIMITS = ['MAX_SRC_ENTRIES', 'MAX_QUARANTINE_ENTRIES', 'MAX_EXPIRY_DAYS'];

function literal(node) {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map((property) => {
    if (!ts.isPropertyAssignment(property) || !('text' in property.name)) throw new Error('policy must use literal object fields');
    return [property.name.text, literal(property.initializer)];
  }));
  throw new Error('policy values must be literals, not executable expressions');
}

function exportsFrom(sourceText, names) {
  const source = ts.createSourceFile('policy.mjs', sourceText, ts.ScriptTarget.Latest, true);
  const values = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)) {
        if (!declaration.initializer || values.has(declaration.name.text)) throw new Error(`ambiguous policy ${declaration.name.text}`);
        values.set(declaration.name.text, literal(declaration.initializer));
      }
    }
  }
  return values;
}

export function readPolicy(read) {
  const limits = exportsFrom(read(GATE), LIMITS);
  for (const name of LIMITS) {
    if (!Number.isInteger(limits.get(name)) || limits.get(name) < 0) throw new Error(`missing or invalid ${name}`);
  }
  const expected = exportsFrom(read(SKIPS), ['VITEST_EXPECTED_FAILURES']).get('VITEST_EXPECTED_FAILURES') ?? [];
  const journeys = Object.values(JSON.parse(read(JOURNEY)));
  if (!Array.isArray(expected) || journeys.some((entries) => !Array.isArray(entries))) throw new Error('expected-failure registries must contain arrays');
  return { limits: Object.fromEntries(limits), entries: [...expected, ...journeys.flat()] };
}

export function comparePolicy(base, candidate) {
  const problems = [];
  for (const name of LIMITS) {
    if (candidate.limits[name] > base.limits[name]) problems.push(`${name} raised above merge base: ${base.limits[name]} -> ${candidate.limits[name]}`);
  }
  if (candidate.entries.length > base.limits.MAX_QUARANTINE_ENTRIES) problems.push(`quarantine count ${candidate.entries.length} exceeds merge-base ceiling ${base.limits.MAX_QUARANTINE_ENTRIES}`);
  const identity = (entry) => JSON.stringify([entry.file, entry.title]);
  for (const entry of candidate.entries) {
    const previous = base.entries.find((old) => old.id === entry.id || identity(old) === identity(entry));
    if (!previous) continue;
    if (identity(previous) !== identity(entry)) problems.push(`${entry.id}: quarantine item moved from its merge-base identity`);
    if (entry.expiry > previous.expiry) problems.push(`${entry.id}: expiry extended beyond merge base: ${previous.expiry} -> ${entry.expiry}`);
  }
  return problems;
}

export function checkQuarantinePolicy({ repoRoot = ROOT, baseRef = process.env.QUARANTINE_BASE_REF } = {}) {
  const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!baseRef || baseRef.startsWith('-') || /^0+$/.test(baseRef)) throw new Error('an existing base ref is required for quarantine policy comparison');
  const baseCommit = git(['rev-parse', '--verify', `${baseRef}^{commit}`]);
  const mergeBase = git(['merge-base', 'HEAD', baseCommit]);
  const base = readPolicy((file) => git(['show', `${mergeBase}:${file}`]));
  const candidate = readPolicy((file) => fs.readFileSync(path.join(repoRoot, file), 'utf8'));
  return { mergeBase, problems: comparePolicy(base, candidate) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = checkQuarantinePolicy({ ...(process.argv[2] ? { baseRef: process.argv[2] } : {}) });
    console.log(`Quarantine policy merge base: ${result.mergeBase}`);
    for (const problem of result.problems) console.error(`FAIL ${problem}`);
    if (result.problems.length) process.exitCode = 1;
    else console.log('Quarantine ceiling and expiries do not exceed the merge base.');
  } catch (error) {
    console.error(`FAIL quarantine policy: ${error.message}`);
    process.exitCode = 1;
  }
}

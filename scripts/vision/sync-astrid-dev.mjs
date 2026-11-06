#!/usr/bin/env node
// Regenerate the committed /vision snapshot using Astrid Dev's canonical exporter.
// The website never fetches GitHub on page load.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checkout = path.resolve(process.env.ASTRID_DEV_CHECKOUT || path.join(root, '../astrid-dev'));
const output = path.join(root, 'src/pages/Home/vision.generated.json');
const checkOnly = process.argv.includes('--check');
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

try {
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=no'], checkout);
  if (dirty) throw new Error('Astrid Dev checkout has tracked changes; use a clean checkout at the intended revision');
  const revision = run('git', ['rev-parse', 'HEAD'], checkout);
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Astrid Dev is not at an immutable Git revision');
  const temp = mkdtempSync(path.join(os.tmpdir(), 'astrid-vision-'));
  try {
    const generated = path.join(temp, 'vision.json');
    run('python3', [path.join(checkout, 'scripts/export_public_vision.py'), '--revision', revision, '--output', generated], checkout);
    const next = readFileSync(generated, 'utf8');
    if (checkOnly) {
      if (next !== readFileSync(output, 'utf8')) throw new Error('Generated snapshot differs; run npm run vision:sync');
      process.stdout.write('Public vision snapshot matches Astrid Dev at ' + revision + '\n');
    } else {
      writeFileSync(output, next, 'utf8');
      process.stdout.write('Public vision refreshed from Astrid Dev at ' + revision + '\n');
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
} catch (error) {
  process.stderr.write('Public vision sync failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}

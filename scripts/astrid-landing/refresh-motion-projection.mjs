#!/usr/bin/env node
/** Update only the motion projection in an already verified browser vendor.
 * The destination must be new: inspect/copy its output as generated sources.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMotionProjection, verifyMotionProjection } from './motion-projection.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).reduce(
  (pairs, arg, i, all) => arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs, [],
));
if (!args.projection || !args['agent-repo'] || !args.destination) {
  throw new Error('usage: refresh-motion-projection.mjs --projection <verified pack> --agent-repo <Agent checkout> --destination <new dir> [--source-vendor <dir>]');
}
const source = path.resolve(args['source-vendor'] ?? path.join(app, 'vendor/astrid-browser'));
const destination = path.resolve(args.destination);
if (destination === source || fs.existsSync(destination)) throw new Error('Destination must be a new directory');
const provenance = JSON.parse(fs.readFileSync(path.join(source, 'provenance.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const out = new Map();
for (const [name, digest] of Object.entries(provenance.files)) {
  if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error('Unsafe browser source path');
  const bytes = fs.readFileSync(path.join(source, name));
  if (sha(bytes) !== digest) throw new Error('Unverified browser source: ' + name);
  out.set(name, bytes);
}
const record = applyMotionProjection(out, provenance.astrid_commit, path.resolve(args.projection), path.resolve(args['agent-repo']));
const files = Object.fromEntries([...out.keys()].sort().map(name => [name, sha(out.get(name))]));
const next = {
  ...provenance,
  motion_projection: record,
  refresh_command: 'node scripts/astrid-landing/refresh-motion-projection.mjs --projection <verified pack> --agent-repo <Agent checkout> --destination <new dir>',
  files,
};
fs.mkdirSync(destination);
for (const [name, bytes] of out) {
  const target = path.join(destination, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { flag: 'wx' });
}
fs.writeFileSync(path.join(destination, 'provenance.json'), JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
const readme = path.join(source, 'README.md');
if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(destination, 'README.md'), fs.constants.COPYFILE_EXCL);
verifyMotionProjection(destination, next);
console.log('Verified projected vendor tree ' + record.tree_digest);

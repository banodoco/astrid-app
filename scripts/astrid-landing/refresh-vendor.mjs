#!/usr/bin/env node
/**
 * Refresh vendor/astrid-browser from ANY Astrid commit (the one refresh command).
 *
 *   node scripts/astrid-landing/refresh-vendor.mjs \
 *     --astrid-repo /path/to/Astrid --commit <sha-or-ref>
 *
 * Options: --destination <dir>   default vendor/astrid-browser
 *          --files <json>        default config/astrid-vendor-files.json (the declared file set)
 *
 * It reads the declared file set straight from git objects at the commit (the
 * Astrid checkout is never modified), keeps Astrid-relative paths, derives
 * public-catalog.ts by filtering the commit's catalog.ts, vendors
 * astrid/tools/catalog.json plus every pack file it binds (what
 * validateAstridToolCatalog needs), checks that relative imports between
 * vendored files resolve, and writes provenance.json with a sha256 per file.
 * Verify afterwards with: node scripts/build/verify-astrid-vendor-sources.mjs
 *
 * Supersedes scripts/astrid-landing/prepare-public.py for refreshes: that
 * pipeline is pinned to one Astrid base commit and patches the tree.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
if (!args['astrid-repo'] || !args.commit) {
  console.error('usage: refresh-vendor.mjs --astrid-repo <path> --commit <sha-or-ref> [--destination <dir>] [--files <json>]');
  process.exit(2);
}
const repo = path.resolve(args['astrid-repo']);
const destination = path.resolve(args.destination ?? path.join(appRoot, 'vendor/astrid-browser'));
const declaredPath = path.resolve(args.files ?? path.join(appRoot, 'config/astrid-vendor-files.json'));
const declared = JSON.parse(fs.readFileSync(declaredPath, 'utf8'));
if (declared.schema !== 'astrid-vendor-files/v1') throw new Error(`Unsupported declared file set schema: ${declared.schema}`);
const excluded = new Set(declared.exclude ?? []);
for (const p of excluded) {
  if (typeof p !== 'string' || path.posix.normalize(p) !== p || p.startsWith('/') || p.includes('..')) {
    throw new Error(`Unsafe excluded Astrid source path: ${p}`);
  }
}

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 1 << 30 });
const commit = git('rev-parse', '--verify', `${args.commit}^{commit}`).toString().trim();
const tree = git('rev-parse', `${commit}^{tree}`).toString().trim();
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const allPaths = git('ls-tree', '-r', '--name-only', '-z', commit).toString().split('\0').filter(Boolean);
const pathSet = new Set(allPaths);
const blob = (p) => {
  if (!pathSet.has(p)) throw new Error(`${p} does not exist in Astrid ${commit}`);
  return git('cat-file', 'blob', `${commit}:${p}`);
};

const out = new Map(); // destination-relative path -> Buffer
const add = (p, bytes) => out.set(p, bytes);

add('LICENSE', blob(declared.license));
for (const dir of declared.directories) {
  const matches = allPaths.filter((p) => p.startsWith(`${dir.path}/`) && dir.extensions.includes(path.extname(p)) && !excluded.has(p));
  if (!matches.length) throw new Error(`No ${dir.extensions.join('/')} files under ${dir.path} in ${commit}`);
  for (const p of matches) add(p, blob(p));
}
for (const p of declared.files) {
  if (excluded.has(p)) throw new Error(`Astrid source path is declared in both files and exclude: ${p}`);
  add(p, blob(p));
}

// Whole-Tool catalog: the catalog plus every pack file it binds by digest.
const toolCatalogBytes = blob(declared.tool_catalog);
add(declared.tool_catalog, toolCatalogBytes);
for (const tool of JSON.parse(toolCatalogBytes.toString('utf8')).tools) {
  const bound = [tool.manifest, tool.entry, ...(tool.resources ?? [])].map((f) => f.path);
  for (const rel of bound) {
    const p = `astrid/packs/${tool.pack_id}/${rel}`;
    const bytes = blob(p);
    add(p, bytes);
  }
}

// public-catalog.ts = the commit's catalog.ts filtered to the declared selections, in selection order.
const { output, source, selections } = declared.public_catalog;
const sourceText = blob(source).toString('utf8');
const open = 'Object.freeze(\n';
const start = sourceText.indexOf(open) + open.length;
const end = sourceText.indexOf('\n);\n', start);
if (start < open.length || end < 0) throw new Error(`${source} does not have the expected generated catalog shape`);
const descriptors = JSON.parse(sourceText.slice(start, end));
const picked = selections.map((s) => {
  const d = descriptors.find((x) => x.packId === s.packId && x.kind === s.kind && x.id === s.id);
  if (!d) throw new Error(`Selection ${s.packId}/${s.kind}/${s.id} is not in ${source} at ${commit}`);
  return d;
});
add(output, Buffer.from(sourceText.slice(0, start) + JSON.stringify(picked, null, 2) + sourceText.slice(end)));

// Relative imports between vendored sources must resolve inside the vendored set.
const resolves = (from, spec) => {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec.split('?')[0]));
  return ['', '.ts', '.tsx', '.js', '.json', '/index.ts', '/index.tsx'].some((ext) => out.has(base + ext));
};
const unresolved = [];
for (const [p, bytes] of out) {
  if (!/\.tsx?$/.test(p)) continue;
  for (const m of bytes.toString('utf8').matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    if (!resolves(p, m[1])) unresolved.push(`${p} -> ${m[1]}`);
  }
}
if (unresolved.length) {
  throw new Error(`Vendored files import files outside the declared set; add them to ${path.relative(appRoot, declaredPath)}:\n  ${unresolved.join('\n  ')}`);
}

// Replace the destination atomically-ish: stage, then swap.
const staging = `${destination}.staging-${process.pid}`;
fs.rmSync(staging, { recursive: true, force: true });
const files = {};
for (const p of [...out.keys()].sort()) {
  const target = path.join(staging, p);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, out.get(p));
  files[p] = sha256(out.get(p));
}
const provenance = {
  astrid_commit: commit,
  astrid_tree: tree,
  refresh_command: `node scripts/astrid-landing/refresh-vendor.mjs --astrid-repo <Astrid checkout> --commit ${commit}`,
  declared_files: path.relative(appRoot, declaredPath),
  excluded_files: [...excluded].sort(),
  verify_command: 'node scripts/build/verify-astrid-vendor-sources.mjs',
  files,
};
fs.writeFileSync(path.join(staging, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
const readme = path.join(destination, 'README.md');
if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(staging, 'README.md'));
fs.rmSync(destination, { recursive: true, force: true });
fs.renameSync(staging, destination);
console.log(`Vendored ${Object.keys(files).length} files from Astrid ${commit} into ${path.relative(appRoot, destination) || destination}`);

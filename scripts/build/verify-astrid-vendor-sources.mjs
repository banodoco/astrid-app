import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMotionAgentSource, verifyMotionProjection } from '../astrid-landing/motion-projection.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const closureRoot = path.join(projectRoot, 'vendor/astrid-build-inputs');
const manifestPath = path.join(closureRoot, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (manifest.schema !== 'astrid-container-source-closure/v1') {
  throw new Error(`Unsupported Astrid source closure schema: ${manifest.schema}`);
}

let checked = 0;
for (const [name, source] of Object.entries(manifest.sources ?? {})) {
  const sourceDirectory = path.join(closureRoot, source.directory);
  const expectedRoot = path.resolve(sourceDirectory, source.source_root);
  const rootStat = await stat(expectedRoot).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Missing ${name} Astrid source root: ${expectedRoot}`);
  }

  for (const entry of source.files ?? []) {
    if (path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..')) {
      throw new Error(`Unsafe ${name} source path in manifest: ${entry.path}`);
    }
    const sourcePath = path.resolve(sourceDirectory, entry.path);
    const relative = path.relative(sourceDirectory, sourcePath);
    if (relative.startsWith(`..${path.sep}`) || relative === '..') {
      throw new Error(`Astrid source path escapes its pinned root: ${entry.path}`);
    }

    const bytes = await readFile(sourcePath);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256) {
      throw new Error(`Astrid ${name} source hash mismatch for ${entry.path}: ${actual}`);
    }
    if (bytes.length !== entry.size_bytes) {
      throw new Error(`Astrid ${name} source size mismatch for ${entry.path}`);
    }
    checked += 1;
  }
}

if (checked === 0) throw new Error('Astrid source closure manifest contains no files');
process.stdout.write(`Verified ${checked} pinned Astrid source files.\n`);

// vendor/astrid-browser: every file in provenance.json must exist with the recorded digest,
// and no unrecorded file may hide in the tree (README.md and provenance.json excepted).
const browserRoot = path.join(projectRoot, 'vendor/astrid-browser');
const provenance = JSON.parse(await readFile(path.join(browserRoot, 'provenance.json'), 'utf8'));
if (!/^[0-9a-f]{40}$/.test(provenance.astrid_commit ?? '')) throw new Error('vendor/astrid-browser provenance lacks astrid_commit');
const motionDigest = verifyMotionProjection(browserRoot, provenance);
if (motionDigest) process.stdout.write(`Verified motion projection ${motionDigest}.\n`);
const args = Object.fromEntries(process.argv.slice(2).reduce(
  (pairs, arg, i, all) => arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs, [],
));
if (Object.hasOwn(args, 'motion-agent-repo') || Object.hasOwn(args, 'motion-agent-commit')) {
  if (!args['motion-agent-repo'] || !args['motion-agent-commit']) throw new Error('Both exact motion Agent source arguments are required');
  const commit = verifyMotionAgentSource(browserRoot, provenance, {
    agentRepo: args['motion-agent-repo'], agentCommit: args['motion-agent-commit'],
  });
  process.stdout.write(`Verified selected motion Agent Git source ${commit}.\n`);
}
const recorded = Object.entries(provenance.files ?? {});
if (recorded.length === 0) throw new Error('vendor/astrid-browser provenance lists no files');
for (const [relative, expected] of recorded) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error(`Unsafe browser vendor path: ${relative}`);
  const actual = createHash('sha256').update(await readFile(path.join(browserRoot, relative))).digest('hex');
  if (actual !== expected) throw new Error(`vendor/astrid-browser hash mismatch for ${relative}: ${actual}`);
}
const onDisk = [];
const walk = async (dir) => {
  if (!(await lstat(dir)).isDirectory()) throw new Error('Browser vendor is not a real directory: ' + dir);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile()) onDisk.push(path.relative(browserRoot, full).split(path.sep).join('/'));
    else throw new Error('Non-regular browser vendor path: ' + full);
  }
};
await walk(browserRoot);
const extra = onDisk.filter((f) => !(f in provenance.files) && f !== 'provenance.json' && f !== 'README.md');
if (extra.length) throw new Error(`vendor/astrid-browser has files missing from provenance.json: ${extra.join(', ')}`);
process.stdout.write(`Verified ${recorded.length} vendor/astrid-browser files from Astrid ${provenance.astrid_commit}.\n`);

// The build's default @astrid-public alias points to vendor/astrid-browser/astrid.
// Keep the public host's imports in agreement with the source the build resolves.
const publicRoot = path.join(browserRoot, 'astrid');
const publicHostPath = path.join(projectRoot, 'src/pages/Home/astrid-public-host.tsx');
const publicHost = await readFile(publicHostPath, 'utf8');
const publicImports = [...publicHost.matchAll(/(?:from\s*|import\s*)['"]@astrid-public\/([^'"]+)['"]/g)];
if (publicImports.length === 0) throw new Error('Astrid public host contains no @astrid-public imports');
for (const [, specifier] of publicImports) {
  const relative = specifier.split('?')[0];
  const sourcePath = path.resolve(publicRoot, relative);
  const escaped = path.relative(publicRoot, sourcePath);
  if (escaped === '..' || escaped.startsWith(`..${path.sep}`) || path.isAbsolute(escaped)) {
    throw new Error(`Unsafe @astrid-public import in public host: ${specifier}`);
  }
  const info = await stat(sourcePath).catch(() => null);
  if (!info?.isFile()) throw new Error(`Missing @astrid-public import in vendored public source: ${specifier}`);
}
process.stdout.write(`Verified ${publicImports.length} @astrid-public imports from ${path.relative(projectRoot, publicHostPath)}.\n`);

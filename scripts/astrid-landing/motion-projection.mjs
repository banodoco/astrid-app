/** The App consumes the same verified projection as the user's collection. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MOTION_ROOT = 'astrid/packs/astrid_motion';
export const CATALOG = 'astrid/packs/rendering/elements/catalog.ts';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;

function relativeName(relative) {
  if (!relative || relative.normalize('NFC') !== relative || /[\\\r\n\0]/.test(relative)
      || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe motion projection path: ' + relative);
  }
  return relative;
}

export function readMotionFiles(root) {
  if (!fs.lstatSync(root).isDirectory()) throw new Error('Motion projection is not a real directory');
  const files = new Map(), folded = new Set();
  function walk(dir, prefix) {
    for (const name of fs.readdirSync(dir)) {
      const relative = relativeName(prefix ? prefix + '/' + name : name);
      const key = relative.toLowerCase();
      if (folded.has(key)) throw new Error('Case collision in motion projection: ' + relative);
      folded.add(key);
      const full = path.join(dir, name), info = fs.lstatSync(full);
      if (info.isDirectory()) walk(full, relative);
      else if (info.isFile()) files.set(relative, fs.readFileSync(full));
      else throw new Error('Non-regular motion projection path: ' + relative);
    }
  }
  walk(root, '');
  return files;
}

// The reviewed browser projection contains exactly regular source files, no
// PIN, generated/cache directories or excluded entries. Every byte is bound.
export function motionTreeDigest(files) {
  const hash = createHash('sha256');
  for (const relative of [...files.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    relativeName(relative);
    hash.update(relative, 'utf8').update('\0').update(sha(files.get(relative))).update('\n');
  }
  return hash.digest('hex');
}

function verifyRecord(record, commit, files) {
  if (!record || record.schema !== 'astrid-motion-projection/v1'
      || record.pack_id !== 'astrid_motion'
      || record.repo !== 'https://github.com/banodoco/astrid-agent'
      || record.upstream_subpath !== MOTION_ROOT
      || record.digest_rule !== 'pack-tree-v1'
      || !commitPattern.test(record.upstream_commit ?? '')
      || record.upstream_commit !== commit
      || !commitPattern.test(record.upstream_tree ?? '')
      || !digestPattern.test(record.upstream_digest ?? '')
      || !digestPattern.test(record.alias_only_digest ?? '')
      || !digestPattern.test(record.tree_digest ?? '')
      || !Number.isSafeInteger(record.file_count) || record.file_count !== files.size
      || !files.has('pack.yaml') || files.has('PIN')
      || motionTreeDigest(files) !== record.tree_digest) {
    throw new Error('Motion projection witness does not match its source and bytes');
  }
  return record.tree_digest;
}

/** An absent witness is a legacy source; a present bad witness fails closed. */
export function verifyMotionProjection(vendorRoot, provenance) {
  if (!Object.hasOwn(provenance, 'motion_projection')) return undefined;
  const files = readMotionFiles(path.join(vendorRoot, MOTION_ROOT));
  const digest = verifyRecord(provenance.motion_projection, provenance.astrid_commit, files);
  const expected = new Set([...files.keys()].map(p => MOTION_ROOT + '/' + p));
  const recorded = Object.keys(provenance.files ?? {}).filter(p => p.startsWith(MOTION_ROOT + '/'));
  if (recorded.length !== expected.size || recorded.some(p => !expected.has(p))) {
    throw new Error('Motion projection file list differs from browser provenance');
  }
  for (const [relative, bytes] of files) {
    if (provenance.files[MOTION_ROOT + '/' + relative] !== sha(bytes)) {
      throw new Error('Motion projection file hash mismatch: ' + relative);
    }
  }
  return digest;
}

/** Run the producer's checked tool and product catalog algorithm, then consume
 * the same complete pack tree. No App-side rewrite of the pack or element hashes.
 */
export function applyMotionProjection(out, commit, projection, agentRepo) {
  const python = process.env.ASTRID_PROJECTION_PYTHON || 'python3';
  const tool = path.join(agentRepo, 'scripts/project_astrid_motion.py');
  const catalogTool = path.join(agentRepo, 'scripts/project_astrid_motion_catalog.py');
  const args = ['--check', '--output', projection];
  const record = JSON.parse(execFileSync(python, [tool, ...args], { encoding: 'utf8' }));
  const files = readMotionFiles(projection);
  verifyRecord(record, commit, files);
  const rawCatalog = out.get(CATALOG);
  if (!rawCatalog) throw new Error('Missing source editor catalog');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-motion-catalog-'));
  try {
    const source = path.join(temp, 'source.ts'), generated = path.join(temp, 'generated.ts');
    fs.writeFileSync(source, rawCatalog);
    execFileSync(python, [catalogTool, '--projection', projection, '--source-catalog', source, '--output', generated], {
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    });
    const catalog = fs.readFileSync(generated);
    // Check again after the producer reads the files; publish only the original
    // verified snapshot, not a changed working tree.
    verifyRecord(record, commit, readMotionFiles(projection));
    for (const name of [...out.keys()]) {
      if (name.startsWith(MOTION_ROOT + '/')) out.delete(name);
    }
    for (const [name, bytes] of files) out.set(MOTION_ROOT + '/' + name, bytes);
    out.set(CATALOG, catalog);
    return record;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** The App consumes the same verified projection as the user's collection. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const MOTION_ROOT = 'astrid/packs/astrid_motion';
export const CATALOG = 'astrid/packs/rendering/elements/catalog.ts';
export const MOTION_CONTRACT = 'astrid/packs/rendering/shared/element_contracts.ts';
export const MOTION_RELEASE_SOURCE = 'astrid/resources/astrid_motion_release_source.json';
const DIRECT_SCHEMA = 'astrid-motion-release-source/v1';
const DIRECT_FIELDS = ['schema', 'pack_id', 'repo', 'upstream_commit', 'upstream_subpath',
  'upstream_tree', 'digest_rule', 'upstream_digest', 'tree_digest', 'file_count', 'transform'];
const AGENT_REPO = 'https://github.com/banodoco/astrid-agent';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const digestPattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const hasFields = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());

function regularFile(root, relative) {
  relativeName(relative);
  let current = root;
  if (!fs.lstatSync(current).isDirectory()) throw new Error('Source root is not a real directory');
  for (const [index, part] of relative.split('/').entries()) {
    current = path.join(current, part);
    const info = fs.lstatSync(current);
    if (index === relative.split('/').length - 1 ? !info.isFile() : !info.isDirectory()) {
      throw new Error('Non-regular motion source path: ' + relative);
    }
  }
  return fs.readFileSync(current);
}

/** Read the two selected Agent inputs from immutable Git, never from a claim
 * in the pack or from a dirty tooling checkout. The rest of the vendor stays
 * attributed to its original global astrid_commit.
 */
export function readMotionAgentSource(agentRepo, agentCommit) {
  if (!matches(commitPattern, agentCommit)) throw new Error('Direct motion requires an exact --agent-commit');
  const git = (...args) => execFileSync('git', ['-C', agentRepo, ...args], { maxBuffer: 16 * 1024 * 1024 });
  if (git('rev-parse', '--verify', 'HEAD').toString().trim() !== agentCommit
      || git('rev-parse', '--verify', `${agentCommit}^{commit}`).toString().trim() !== agentCommit
      || git('status', '--porcelain', '--untracked-files=all').length) {
    throw new Error('Selected Agent checkout does not match its clean exact commit');
  }
  const files = {}, bytes = new Map();
  for (const relative of [MOTION_CONTRACT, MOTION_RELEASE_SOURCE]) {
    const entry = git('ls-tree', '-z', agentCommit, '--', relative).toString();
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(entry);
    if (!match || match[3] !== relative) throw new Error('Selected Agent source is not a regular Git blob: ' + relative);
    const value = git('cat-file', 'blob', match[2]);
    if (blobSha(value) !== match[2] || !regularFile(agentRepo, relative).equals(value)) {
      throw new Error('Selected Agent source differs from its Git blob: ' + relative);
    }
    bytes.set(relative, value);
    files[relative] = { blob: match[2], sha256: sha(value) };
  }
  return { record: { schema: 'astrid-motion-agent-source/v1', repo: AGENT_REPO, commit: agentCommit, files }, bytes };
}

/** Offline checks bind the vendored contract and independent witness bytes.
 * Qualification additionally supplies the exact Agent checkout/commit to
 * verify their Git attribution; provenance alone is not a Git authority.
 */
export function verifyMotionAgentSource(vendorRoot, provenance, { agentRepo, agentCommit } = {}) {
  const source = provenance.motion_agent_source;
  if (!hasFields(source, ['schema', 'repo', 'commit', 'files'])
      || source.schema !== 'astrid-motion-agent-source/v1' || source.repo !== AGENT_REPO
      || !matches(commitPattern, source.commit)
      || !hasFields(source.files, [MOTION_CONTRACT, MOTION_RELEASE_SOURCE])) {
    throw new Error('Invalid selected motion Agent source');
  }
  for (const relative of [MOTION_CONTRACT, MOTION_RELEASE_SOURCE]) {
    const item = source.files[relative], bytes = regularFile(vendorRoot, relative);
    if (!hasFields(item, ['blob', 'sha256']) || !matches(commitPattern, item.blob)
        || !matches(digestPattern, item.sha256) || blobSha(bytes) !== item.blob
        || sha(bytes) !== item.sha256 || provenance.files?.[relative] !== item.sha256) {
      throw new Error('Selected motion Agent source hash mismatch: ' + relative);
    }
  }
  const independent = JSON.parse(regularFile(vendorRoot, MOTION_RELEASE_SOURCE));
  if (!isDeepStrictEqual(independent, provenance.motion_projection)) {
    throw new Error('Motion projection differs from the selected Agent witness');
  }
  if (agentRepo !== undefined || agentCommit !== undefined) {
    if (!agentRepo || !agentCommit || !isDeepStrictEqual(readMotionAgentSource(agentRepo, agentCommit).record, source)) {
      throw new Error('Motion Agent provenance differs from the selected Git source');
    }
  }
  return source.commit;
}

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
  const direct = record?.schema === DIRECT_SCHEMA;
  const profileValid = direct
    ? hasFields(record, DIRECT_FIELDS) && record.repo === 'https://github.com/banodoco/poms_packs'
      && record.upstream_subpath === 'astrid_motion' && record.transform === 'identity'
      && record.upstream_digest === record.tree_digest
    : record?.schema === 'astrid-motion-projection/v1' && record.repo === AGENT_REPO
      && record.upstream_subpath === MOTION_ROOT && record.upstream_commit === commit
      && matches(digestPattern, record.alias_only_digest);
  if (!profileValid || record.pack_id !== 'astrid_motion'
      || record.digest_rule !== 'pack-tree-v1'
      || !matches(commitPattern, record.upstream_commit)
      || !matches(commitPattern, record.upstream_tree)
      || !matches(digestPattern, record.upstream_digest)
      || !matches(digestPattern, record.tree_digest)
      || !Number.isSafeInteger(record.file_count) || record.file_count <= 0 || record.file_count !== files.size
      || !files.has('pack.yaml') || files.has('PIN')
      || motionTreeDigest(files) !== record.tree_digest) {
    throw new Error('Motion projection witness does not match its source and bytes');
  }
  return record.tree_digest;
}

/** An absent witness is a legacy source; a present bad witness fails closed. */
export function verifyMotionProjection(vendorRoot, provenance) {
  if (!Object.hasOwn(provenance, 'motion_projection')) {
    if (Object.hasOwn(provenance, 'motion_agent_source')) throw new Error('Motion Agent source lacks its witness');
    return undefined;
  }
  const files = readMotionFiles(path.join(vendorRoot, MOTION_ROOT));
  const digest = verifyRecord(provenance.motion_projection, provenance.astrid_commit, files);
  if (provenance.motion_projection.schema === DIRECT_SCHEMA) verifyMotionAgentSource(vendorRoot, provenance);
  else if (Object.hasOwn(provenance, 'motion_agent_source')) throw new Error('Ambiguous legacy/direct motion source');
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
export function applyMotionProjection(out, commit, projection, agentRepo, { profile = 'legacy-projection', agentCommit } = {}) {
  if (!['legacy-projection', 'direct-source'].includes(profile)) throw new Error('Unknown motion source profile: ' + profile);
  const selected = profile === 'direct-source' ? readMotionAgentSource(agentRepo, agentCommit) : undefined;
  const python = process.env.ASTRID_PROJECTION_PYTHON || 'python3';
  const tool = path.join(agentRepo, 'scripts/project_astrid_motion.py');
  const catalogTool = path.join(agentRepo, 'scripts/project_astrid_motion_catalog.py');
  const profileArgs = profile === 'direct-source' ? ['--profile', profile] : [];
  const args = [...profileArgs, '--check', '--output', projection];
  const record = JSON.parse(execFileSync(python, [tool, ...args], { encoding: 'utf8' }));
  if ((profile === 'direct-source') !== (record.schema === DIRECT_SCHEMA)
      || (selected && !isDeepStrictEqual(JSON.parse(selected.bytes.get(MOTION_RELEASE_SOURCE)), record))) {
    throw new Error('Producer returned a different motion profile or witness');
  }
  const files = readMotionFiles(projection);
  verifyRecord(record, commit, files);
  const rawCatalog = out.get(CATALOG);
  if (!rawCatalog) throw new Error('Missing source editor catalog');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-motion-catalog-'));
  try {
    const source = path.join(temp, 'source.ts'), generated = path.join(temp, 'generated.ts');
    const snapshot = path.join(temp, 'astrid_motion');
    fs.mkdirSync(snapshot);
    for (const [relative, bytes] of files) {
      const target = path.join(snapshot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx' });
    }
    verifyRecord(record, commit, readMotionFiles(snapshot));
    fs.writeFileSync(source, rawCatalog);
    execFileSync(python, [catalogTool, ...profileArgs, '--projection', snapshot, '--source-catalog', source, '--output', generated], {
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    });
    const catalog = fs.readFileSync(generated);
    // Check the private snapshot again before consuming its generated catalog.
    verifyRecord(record, commit, readMotionFiles(snapshot));
    if (selected && !isDeepStrictEqual(readMotionAgentSource(agentRepo, agentCommit).record, selected.record)) {
      throw new Error('Selected Agent changed during motion generation');
    }
    for (const name of [...out.keys()]) {
      if (name.startsWith(MOTION_ROOT + '/')) out.delete(name);
    }
    for (const [name, bytes] of files) out.set(MOTION_ROOT + '/' + name, bytes);
    out.set(CATALOG, catalog);
    if (selected) for (const [name, bytes] of selected.bytes) out.set(name, bytes);
    return record;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

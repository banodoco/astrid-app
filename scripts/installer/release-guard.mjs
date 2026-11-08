#!/usr/bin/env node
// release-guard: the install tuple and the public `release` number move together.
//
// The install tuple is the manifest without `release`, `required` and `version_starts`,
// plus the three public bootstrap files. If the tuple changes, `release` must rise by
// exactly 1. If it does not change, `release` must stay the same. `required` is
// validated on its own. `version_starts` is add-only, and a new start must come with
// release +1 at its own release (see releaseVersion.mjs for the version rules).
//
// --integration (PRs into int/**): the tuple may move, but `release`, `required` and
// `version_starts` must be byte-identical to the base. The number moves once, on the
// release PR to main, which is checked against main as above.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateVersionStarts } from './releaseVersion.mjs';

export const MANIFEST_PATH = 'public/install-manifest.json';
export const BOOTSTRAP_PATHS = ['public/install', 'public/install.ps1', 'public/install.sh'];

const SHA = /^[0-9a-f]{40}$/;

// Sorted keys make the tuple independent of key order and whitespace, so a pure
// reformat of the manifest is not a tuple change. Any value change is.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function parseManifest(bytes, label) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return manifest;
}

// A base manifest without `release` is the Release-0 shape, so it reads as 0.
// A head manifest must state its release explicitly.
function releaseOf(manifest, label, { required }) {
  if (!Object.hasOwn(manifest, 'release')) {
    if (required) throw new Error(`${label} must declare an integer release`);
    return 0;
  }
  if (!Number.isSafeInteger(manifest.release) || manifest.release < 0) {
    throw new Error(`${label} release must be a non-negative integer`);
  }
  return manifest.release;
}

function validateRequired(manifest, release, label) {
  if (!Object.hasOwn(manifest, 'required')) return;
  const { required } = manifest;
  if (!required || typeof required !== 'object' || Array.isArray(required)) {
    throw new Error(`${label} required must be an object`);
  }
  if (!Number.isSafeInteger(required.release) || required.release < 0) {
    throw new Error(`${label} required.release must be a non-negative integer`);
  }
  if (required.release > release) {
    throw new Error(`${label} required.release ${required.release} exceeds release ${release}`);
  }
  if (typeof required.reason !== 'string' || !required.reason.trim()) {
    throw new Error(`${label} required.reason must be a non-empty string`);
  }
}

function tupleParts(snapshot) {
  const manifest = parseManifest(snapshot.manifest, 'install-manifest.json');
  const rest = { ...manifest };
  delete rest.release;
  delete rest.required;
  delete rest.version_starts;
  const parts = { 'manifest (without release and required)': JSON.stringify(canonical(rest)) };
  for (const file of BOOTSTRAP_PATHS) {
    const bytes = snapshot.bootstraps[file];
    if (!bytes) throw new Error(`${file} is missing from the snapshot`);
    parts[file] = bytes.toString('base64');
  }
  return parts;
}

// Canonical bytes of one manifest field. An absent field is its own value, not null.
function fieldBytes(manifest, name) {
  return Object.hasOwn(manifest, name) ? JSON.stringify(canonical(manifest[name])) : '(absent)';
}

function sameStart(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

// version_starts is add-only: the base list must be a prefix of the head list.
// Returns the starts the head adds.
function addedVersionStarts(baseStarts, headStarts) {
  const prefix = baseStarts.length <= headStarts.length && baseStarts.every((start, index) => sameStart(start, headStarts[index]));
  if (!prefix) throw new Error('version_starts is add-only; a start in the base was removed or changed');
  return headStarts.slice(baseStarts.length);
}

// Snapshot shape: { manifest: Buffer, bootstraps: { 'public/install': Buffer, ... } }
export function checkReleaseGuard({ base, head, integration = false }) {
  const baseManifest = parseManifest(base.manifest, 'base install-manifest.json');
  const headManifest = parseManifest(head.manifest, 'head install-manifest.json');
  const baseRelease = releaseOf(baseManifest, 'base install-manifest.json', { required: false });
  const headRelease = releaseOf(headManifest, 'head install-manifest.json', { required: true });
  validateRequired(headManifest, headRelease, 'head install-manifest.json');
  validateVersionStarts(baseManifest.version_starts, baseRelease, 'base version_starts');
  validateVersionStarts(headManifest.version_starts, headRelease, 'head version_starts');

  if (integration) {
    const pinned = ['required', 'version_starts'].filter((name) => fieldBytes(baseManifest, name) !== fieldBytes(headManifest, name));
    if (baseRelease !== headRelease) pinned.unshift('release');
    if (pinned.length > 0) {
      throw new Error(`integration PR changes ${pinned.join(', ')}; on int/** release, required and version_starts must stay byte-identical to the base (release ${baseRelease}). The number moves only on the release PR to main`);
    }
    const tuple = changedTupleParts(base, head);
    return tuple.length > 0
      ? `install tuple changed (${tuple.join(', ')}) on an integration branch; release ${baseRelease} unchanged.`
      : `install tuple unchanged; release ${headRelease} unchanged.`;
  }

  const changed = changedTupleParts(base, head);
  if (changed.length > 0) {
    if (headRelease !== baseRelease + 1) {
      throw new Error(`install tuple changed (${changed.join(', ')}) but release is ${headRelease}; a tuple change requires release ${baseRelease + 1} (exactly +1 from ${baseRelease})`);
    }
  } else if (headRelease !== baseRelease) {
    throw new Error(`release changed from ${baseRelease} to ${headRelease} without an install tuple change; release must stay ${baseRelease}`);
  }

  const added = addedVersionStarts(baseManifest.version_starts ?? [], headManifest.version_starts ?? []);
  const addedText = added.map((start) => `${start.version} at release ${start.release}`).join(', ');
  if (added.length > 0) {
    if (headRelease !== baseRelease + 1) {
      throw new Error(`version_starts adds ${addedText} but release is ${headRelease}; a version start requires release ${baseRelease + 1} (exactly +1 from ${baseRelease})`);
    }
    const misplaced = added.find((start) => start.release !== headRelease);
    if (misplaced) {
      throw new Error(`version_starts adds a start at release ${misplaced.release}; a version start must be at the new release ${headRelease}`);
    }
  }

  const tuple = changed.length > 0
    ? `install tuple changed (${changed.join(', ')}); release ${baseRelease} -> ${headRelease}.`
    : `install tuple unchanged; release ${headRelease} unchanged.`;
  return added.length > 0 ? `${tuple} version_starts adds ${addedText}.` : tuple;
}

function changedTupleParts(base, head) {
  const baseParts = tupleParts(base);
  const headParts = tupleParts(head);
  return Object.keys(baseParts).filter((key) => baseParts[key] !== headParts[key]);
}

function readAtRef(repo, ref, file) {
  try {
    return execFileSync('git', ['-C', repo, 'show', `${ref}:${file}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`${file} cannot be read at ${ref}: ${error.stderr?.toString().trim() || error.message}`);
  }
}

function resolveCommit(repo, ref) {
  let sha;
  try {
    sha = execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error(`${ref} is not a commit in this checkout`);
  }
  if (!SHA.test(sha)) throw new Error(`${ref} did not resolve to a full commit SHA`);
  return sha;
}

export function readSnapshot(repo, ref) {
  const commit = resolveCommit(repo, ref);
  const bootstraps = {};
  for (const file of BOOTSTRAP_PATHS) bootstraps[file] = readAtRef(repo, commit, file);
  return { manifest: readAtRef(repo, commit, MANIFEST_PATH), bootstraps };
}

async function main(argv) {
  const integration = argv.includes('--integration');
  const [baseRef, headRef = 'HEAD', ...extra] = argv.filter((arg) => arg !== '--integration');
  if (!baseRef || extra.length) {
    throw new Error('Usage: node scripts/installer/release-guard.mjs <base-ref-or-sha> [head-ref] [--integration]');
  }
  const repo = process.cwd();
  const message = checkReleaseGuard({ base: readSnapshot(repo, baseRef), head: readSnapshot(repo, headRef), integration });
  process.stdout.write(`${message}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`release guard refused: ${error.message}\n`);
    process.exitCode = 1;
  });
}

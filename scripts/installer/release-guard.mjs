#!/usr/bin/env node
// release-guard: the install tuple and the public `release` number move together.
//
// The install tuple is the manifest without `release` and `required`, plus the
// three public bootstrap files. If the tuple changes, `release` must rise by
// exactly 1. If it does not change, `release` must stay the same. `required`
// is validated on its own.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
  const parts = { 'manifest (without release and required)': JSON.stringify(canonical(rest)) };
  for (const file of BOOTSTRAP_PATHS) {
    const bytes = snapshot.bootstraps[file];
    if (!bytes) throw new Error(`${file} is missing from the snapshot`);
    parts[file] = bytes.toString('base64');
  }
  return parts;
}

// Snapshot shape: { manifest: Buffer, bootstraps: { 'public/install': Buffer, ... } }
export function checkReleaseGuard({ base, head }) {
  const baseManifest = parseManifest(base.manifest, 'base install-manifest.json');
  const headManifest = parseManifest(head.manifest, 'head install-manifest.json');
  const baseRelease = releaseOf(baseManifest, 'base install-manifest.json', { required: false });
  const headRelease = releaseOf(headManifest, 'head install-manifest.json', { required: true });
  validateRequired(headManifest, headRelease, 'head install-manifest.json');
  // A floor this change sets must be the release it publishes. A floor pinned before the release is bumped
  // would sit one release behind, so the guard refuses it. Release 0 is "no floor yet"; an unchanged floor is not checked.
  const requiredChanged = JSON.stringify(baseManifest.required ?? null) !== JSON.stringify(headManifest.required ?? null);
  if (requiredChanged && headManifest.required && headManifest.required.release !== 0 && headManifest.required.release !== headRelease) {
    throw new Error(`required.release ${headManifest.required.release} is not the release being published (${headRelease}); bump release, then pin --require`);
  }

  const baseParts = tupleParts(base);
  const headParts = tupleParts(head);
  const changed = Object.keys(baseParts).filter((key) => baseParts[key] !== headParts[key]);

  if (changed.length > 0) {
    if (headRelease !== baseRelease + 1) {
      throw new Error(`install tuple changed (${changed.join(', ')}) but release is ${headRelease}; a tuple change requires release ${baseRelease + 1} (exactly +1 from ${baseRelease})`);
    }
    return `install tuple changed (${changed.join(', ')}); release ${baseRelease} -> ${headRelease}.`;
  }
  if (headRelease !== baseRelease) {
    throw new Error(`release changed from ${baseRelease} to ${headRelease} without an install tuple change; release must stay ${baseRelease}`);
  }
  return `install tuple unchanged; release ${headRelease} unchanged.`;
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
  const [baseRef, headRef = 'HEAD', ...extra] = argv;
  if (!baseRef || extra.length) {
    throw new Error('Usage: node scripts/installer/release-guard.mjs <base-ref-or-sha> [head-ref]');
  }
  const repo = process.cwd();
  const message = checkReleaseGuard({ base: readSnapshot(repo, baseRef), head: readSnapshot(repo, headRef) });
  process.stdout.write(`${message}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`release guard refused: ${error.message}\n`);
    process.exitCode = 1;
  });
}

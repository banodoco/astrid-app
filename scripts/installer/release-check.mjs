import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const manifestPath = 'public/install-manifest.json';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
}

function readRelease(bytes, label) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  const release = Object.hasOwn(manifest, 'release') ? manifest.release : 0;
  if (!Number.isSafeInteger(release) || release < 0) {
    throw new Error(`${label} release must be a non-negative integer`);
  }
  return release;
}

function readRequiredRelease(bytes, label) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!Object.hasOwn(manifest, 'required')) return 0;
  const required = manifest.required;
  if (!required || typeof required !== 'object' || Array.isArray(required)) {
    throw new Error(`${label} required must be an object`);
  }
  if (!Number.isSafeInteger(required.release) || required.release < 0) {
    throw new Error(`${label} required.release must be a non-negative integer`);
  }
  return required.release;
}

export async function checkManifestRelease({ repo = process.cwd(), baseRef = 'origin/main', candidateBytes } = {}) {
  const current = candidateBytes ?? await readFile(path.join(repo, manifestPath));
  const baseline = git(repo, 'show', `${baseRef}:${manifestPath}`);
  const baselineRelease = readRelease(baseline, `${baseRef} install-manifest.json`);
  const commits = git(repo, 'log', '--full-history', '--format=%H', baseRef, '--', manifestPath).toString('utf8').trim().split('\n').filter(Boolean);
  let highestRelease = 0;
  let requiredHighWater = 0;
  for (const commit of commits) {
    const bytes = git(repo, 'show', `${commit}:${manifestPath}`);
    highestRelease = Math.max(highestRelease, readRelease(bytes, `main history at ${commit}`));
    requiredHighWater = Math.max(requiredHighWater, readRequiredRelease(bytes, `main history at ${commit}`));
  }
  const candidateRequiredRelease = readRequiredRelease(current, 'candidate install-manifest.json');
  if (candidateRequiredRelease < requiredHighWater) {
    throw new Error(`Manifest required.release ${candidateRequiredRelease} is below App main history high-water ${requiredHighWater}`);
  }
  if (current.equals(baseline)) {
    return `Manifest bytes match ${baseRef}; release unchanged; required.release ${candidateRequiredRelease} preserves or exceeds history high-water ${requiredHighWater}.`;
  }

  const release = readRelease(current, 'candidate install-manifest.json');
  if (release <= baselineRelease) {
    throw new Error(`Manifest bytes changed but release ${release} does not exceed previous main release ${baselineRelease}`);
  }
  if (release <= highestRelease) {
    throw new Error(`Manifest release ${release} does not exceed App main history high-water ${highestRelease}`);
  }
  return `Manifest bytes changed; release ${release} exceeds previous main ${baselineRelease} and history high-water ${highestRelease}; required.release ${candidateRequiredRelease} preserves or exceeds history high-water ${requiredHighWater}.`;
}

async function main() {
  const [baseRef = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main'] = process.argv.slice(2);
  process.stdout.write(`${await checkManifestRelease({ baseRef })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

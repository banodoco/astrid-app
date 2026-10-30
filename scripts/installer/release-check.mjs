import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const manifestPath = 'public/install-manifest.json';
const publishedBaselinePath = 'config/qualification/published-release-baseline.json';
const release0ManifestPath = 'config/qualification/release-0-public-manifest.json';

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

export async function checkManifestRelease({ repo = process.cwd(), baseRef = 'origin/main', candidateBytes, candidateMode = false, publishedBaselineRef = 'origin/main' } = {}) {
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
  const release = readRelease(current, 'candidate install-manifest.json');
  let publishedRelease;
  if (candidateMode) {
    // The candidate branch cannot lower its own published floor. Until main
    // first contains this file, the only valid fallback is Release 0.
    let publishedBytes;
    try {
      publishedBytes = git(repo, 'show', `${publishedBaselineRef}:${publishedBaselinePath}`);
    } catch (error) {
      const mainManifest = git(repo, 'show', `${publishedBaselineRef}:${manifestPath}`);
      if (readRelease(mainManifest, `${publishedBaselineRef} install-manifest.json`) !== 0) {
        throw new Error(`Published baseline is missing from ${publishedBaselineRef} after Release 0`);
      }
      publishedBytes = Buffer.from('{"schema_version":1,"release":0}\n');
    }
    const candidateBaselineBytes = await readFile(path.join(repo, publishedBaselinePath));
    const publishedBaseline = JSON.parse(publishedBytes.toString('utf8'));
    const candidateBaseline = JSON.parse(candidateBaselineBytes.toString('utf8'));
    if (candidateBaseline.schema_version !== publishedBaseline.schema_version || candidateBaseline.release !== publishedBaseline.release) {
      throw new Error(`Candidate published release baseline differs from ${publishedBaselineRef}`);
    }
    if (publishedBaseline.schema_version !== 1 || !Number.isSafeInteger(publishedBaseline.release) || publishedBaseline.release < 0) {
      throw new Error(`${publishedBaselinePath} must contain schema_version 1 and a non-negative release`);
    }
    publishedRelease = publishedBaseline.release;
    const release0Manifest = await readFile(path.join(repo, release0ManifestPath));
    if (createHash('sha256').update(release0Manifest).digest('hex') !== 'fe12781e4da60d441595c08f84cb8d0390d840ab7c71227b8c4eff791553795e') {
      throw new Error('Frozen Release-0 manifest bytes have changed');
    }
    if (publishedRelease === 0 && current.equals(release0Manifest)) {
      return `Manifest bytes match frozen Release-0 baseline; unpublished candidate phase has not changed the public manifest; required.release ${candidateRequiredRelease} preserves or exceeds history high-water ${requiredHighWater}.`;
    }
    if (release <= publishedRelease) {
      throw new Error(`Manifest release ${release} does not exceed last published release ${publishedRelease}`);
    }
  }
  if (current.equals(baseline)) {
    return `Manifest bytes match ${baseRef}; release unchanged; required.release ${candidateRequiredRelease} preserves or exceeds history high-water ${requiredHighWater}.`;
  }

  if (candidateMode) {
    return `Manifest bytes changed; unpublished candidate release ${release} exceeds last published release ${publishedRelease}; required.release ${candidateRequiredRelease} preserves or exceeds history high-water ${requiredHighWater}.`;
  }
  if (release <= baselineRelease) {
    throw new Error(`Manifest bytes changed but release ${release} does not exceed previous main release ${baselineRelease}`);
  }
  if (release <= highestRelease) {
    throw new Error(`Manifest release ${release} does not exceed App main history high-water ${highestRelease}`);
  }
  return `Manifest bytes changed; release ${release} exceeds previous main ${baselineRelease} and history high-water ${highestRelease}; required.release ${candidateRequiredRelease} preserves or exceeds history high-water ${requiredHighWater}.`;
}

async function main() {
  const args = process.argv.slice(2);
  const candidateMode = args.includes('--candidate');
  const refs = args.filter((arg) => arg !== '--candidate');
  if (refs.length > 1) throw new Error('Usage: node scripts/installer/release-check.mjs [base-ref] [--candidate]');
  const [baseRef = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main'] = refs;
  process.stdout.write(`${await checkManifestRelease({ baseRef, candidateMode })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkManifest } from './pin.mjs';

const fields = [
  ['agent.sha', (manifest) => manifest?.agent?.sha],
  ['runtime.sha', (manifest) => manifest?.runtime?.sha],
  ['runtime.schema_digest', (manifest) => manifest?.runtime?.schema_digest],
  ['release', (manifest) => manifest?.release],
  // Compared as bytes of the canonical list so an absent list and an empty one are the same name set.
  ['version_starts', (manifest) => JSON.stringify(manifest?.version_starts ?? [])],
];
// Bootstrap files are served byte-for-byte at the same name under the origin root.
const bootstrapNames = ['install', 'install.sh', 'install.ps1'];
const defaultManifestPath = fileURLToPath(new URL('../../public/install-manifest.json', import.meta.url));
const servedOrigin = 'https://astrid.haus';
const servedManifestUrl = `${servedOrigin}/install-manifest.json`;
const attempts = 7;
const requestTimeoutMs = 5_000;
const retryDelayMs = 18_000;

function display(value) {
  return value ?? '(missing)';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Compares a served snapshot ({ manifest, bootstraps }) with the deployed public files.
export function servedMismatches(expected, actual, deployedSha) {
  const manifestMismatches = fields.flatMap(([name, value]) => {
    const expectedValue = value(expected.manifest);
    const actualValue = value(actual.manifest);
    if (expectedValue === actualValue) return [];
    return [`${name}: deployed ${deployedSha} public value ${display(expectedValue)}, served value ${display(actualValue)}`];
  });
  const bootstrapMismatches = bootstrapNames.flatMap((name) => {
    if (expected.bootstraps[name].equals(actual.bootstraps[name])) return [];
    return [`${name}: served bytes differ from deployed ${deployedSha} public/${name}`];
  });
  return [...manifestMismatches, ...bootstrapMismatches];
}

async function readServed(url) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  throw new Error(`Could not fetch ${url} after ${attempts} attempts: ${lastError.message}`);
}

async function readServedSnapshot() {
  const manifestBytes = await readServed(servedManifestUrl);
  const bootstrapBytes = await Promise.all(bootstrapNames.map((name) => readServed(`${servedOrigin}/${name}`)));
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Served manifest at ${servedManifestUrl} is not valid JSON: ${error.message}`);
  }
  return { manifest, bootstraps: Object.fromEntries(bootstrapNames.map((name, index) => [name, bootstrapBytes[index]])) };
}

async function main() {
  const [deployedSha, manifestPath = defaultManifestPath] = process.argv.slice(2);
  if (!/^[0-9a-f]{40}$/.test(deployedSha ?? '')) {
    throw new Error('Usage: node scripts/installer/served-manifest.mjs <deployed-sha> [expected-manifest-path]');
  }

  const publicDir = path.dirname(manifestPath);
  const expectedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Number.isSafeInteger(expectedManifest.release) || expectedManifest.release < 0) {
    throw new Error(`${manifestPath} release must be a non-negative integer`);
  }
  const expected = {
    manifest: expectedManifest,
    bootstraps: Object.fromEntries(await Promise.all(bootstrapNames.map(async (name) => [name, await readFile(path.join(publicDir, name))]))),
  };

  let lastMismatches = [];
  let lastManifest;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const actual = await readServedSnapshot();
    lastManifest = actual.manifest;
    lastMismatches = servedMismatches(expected, actual, deployedSha);
    if (lastMismatches.length === 0) {
      const coherence = await checkManifest(actual.manifest);
      process.stdout.write(`${coherence}\n`);
      process.stdout.write(`Served manifest and bootstraps at ${servedOrigin} match deployment ${deployedSha}; release ${actual.manifest.release}.\n`);
      return;
    }
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  let coherenceError;
  try {
    await checkManifest(lastManifest);
  } catch (error) {
    coherenceError = `C1 coherence check also failed: ${error.message}`;
  }
  const details = [...lastMismatches, ...(coherenceError ? [coherenceError] : [])];
  throw new Error(`Served manifest at ${servedManifestUrl} did not match deployment ${deployedSha} after ${attempts} attempts:\n${details.join('\n')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

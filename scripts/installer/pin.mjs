import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const agentRepo = 'banodoco/astrid-agent';
const runtimeRepo = 'banodoco/astrid-runtime';
const manifestPath = path.join(process.cwd(), 'public/install-manifest.json');

function rawUrl(repository, sha, file) {
  return `https://raw.githubusercontent.com/${repository}/${sha}/${file}`;
}

async function readRaw(repository, sha, file) {
  const response = await fetch(rawUrl(repository, sha, file));
  if (!response.ok) throw new Error(`Could not read ${repository}/${file} at ${sha}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function sourcePath(value, label) {
  if (typeof value !== 'string' || !value || path.posix.isAbsolute(value)) {
    throw new Error(`Runtime contract manifest has an invalid ${label} path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Runtime contract manifest has an invalid ${label} path`);
  }
  return `contract/${normalized}`;
}

async function runtimeSchemaDigest(runtimeSha) {
  const contract = JSON.parse((await readRaw(runtimeRepo, runtimeSha, 'contract/manifest.json')).toString('utf8'));
  if (!Array.isArray(contract.schemas)) throw new Error('Runtime contract manifest needs a schemas list');
  const paths = [sourcePath(contract.openapi, 'OpenAPI'), ...contract.schemas.map((file) => sourcePath(file, 'schema'))];
  const contents = await Promise.all(paths.map((file) => readRaw(runtimeRepo, runtimeSha, file)));
  const hash = createHash('sha256');
  for (const [index, file] of paths.entries()) {
    const name = Buffer.from(file, 'utf8');
    const data = contents[index];
    const nameLength = Buffer.alloc(4);
    const dataLength = Buffer.alloc(8);
    nameLength.writeUInt32BE(name.length);
    dataLength.writeBigUInt64BE(BigInt(data.length));
    hash.update(nameLength).update(name).update(dataLength).update(data);
  }
  return `sha256:${hash.digest('hex')}`;
}

async function readAgentRuntime(agentSha) {
  const lock = JSON.parse((await readRaw(agentRepo, agentSha, 'runtime.lock.json')).toString('utf8'));
  if (!/^[0-9a-f]{40}$/.test(lock.source_commit ?? '')) {
    throw new Error(`Agent ${agentSha} runtime.lock.json needs a full source_commit`);
  }
  return lock.source_commit;
}

export function applyReleasePin(manifest, reason) {
  const previousRelease = Object.hasOwn(manifest, 'release') ? manifest.release : 0;
  if (!Number.isSafeInteger(previousRelease) || previousRelease < 0) {
    throw new Error('install-manifest.json release must be a non-negative integer');
  }
  const release = previousRelease + 1;
  if (!Number.isSafeInteger(release)) throw new Error('install-manifest.json release exceeds the safe integer range');
  manifest.release = release;
  if (reason !== undefined) {
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('--require needs a non-empty reason');
    const currentRequiredRelease = manifest.required == null
      ? 0
      : Object.hasOwn(manifest.required, 'release') ? manifest.required.release : 0;
    if (!Number.isSafeInteger(currentRequiredRelease) || currentRequiredRelease < 0) {
      throw new Error('install-manifest.json required.release must be a non-negative integer');
    }
    manifest.required = {
      release: Math.max(release, currentRequiredRelease),
      reason: reason.trim(),
    };
  }
  return manifest;
}

async function pin(agentSha, reason) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest.agent || !manifest.runtime) throw new Error('install-manifest.json needs agent and runtime records');
  const runtimeSha = await readAgentRuntime(agentSha);
  const schemaDigest = await runtimeSchemaDigest(runtimeSha);
  manifest.agent.sha = agentSha;
  manifest.runtime.sha = runtimeSha;
  manifest.runtime.schema_digest = schemaDigest;
  applyReleasePin(manifest, reason);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function checkManifest(manifest) {
  const agentSha = manifest?.agent?.sha;
  if (!/^[0-9a-f]{40}$/.test(agentSha ?? '')) throw new Error('install-manifest.json agent.sha must be a full commit SHA');
  const runtimeSha = await readAgentRuntime(agentSha);
  if (manifest.runtime?.sha !== runtimeSha) {
    throw new Error(`install-manifest.json runtime.sha ${manifest.runtime?.sha ?? '(missing)'} does not match agent ${agentSha} runtime.lock.json source_commit ${runtimeSha}`);
  }
  const schemaDigest = await runtimeSchemaDigest(runtimeSha);
  if (manifest.runtime?.schema_digest !== schemaDigest) {
    throw new Error(`install-manifest.json runtime.schema_digest ${manifest.runtime?.schema_digest ?? '(missing)'} does not match Runtime ${runtimeSha} contract digest ${schemaDigest}`);
  }
  return `Manifest pins agent ${agentSha}, Runtime ${runtimeSha}, and ${schemaDigest}.`;
}

async function check() {
  process.stdout.write(`${await checkManifest(JSON.parse(await readFile(manifestPath, 'utf8')))}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--check') return check();
  let reason;
  let agentSha;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--require') {
      if (reason !== undefined || !args[index + 1]) throw new Error('--require needs one non-empty reason');
      reason = args[index + 1];
      index += 1;
    } else if (!agentSha && /^[0-9a-f]{40}$/i.test(args[index])) {
      agentSha = args[index];
    } else {
      throw new Error('Usage: node scripts/installer/pin.mjs <agent-sha> [--require "<reason>"] | --check');
    }
  }
  if (agentSha) return pin(agentSha, reason);
  throw new Error('Usage: node scripts/installer/pin.mjs <agent-sha> [--require "<reason>"] | --check');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

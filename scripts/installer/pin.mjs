import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nextVersionStart, validateVersionStarts } from './releaseVersion.mjs';

const agentRepo = 'banodoco/astrid-agent';
const runtimeRepo = 'banodoco/astrid-runtime';
const manifestPath = path.join(process.cwd(), 'public/install-manifest.json');
const usage = 'Usage: node scripts/installer/pin.mjs [<agent-sha>] [--release [minor|major]] [--require "<reason>"] | --check';

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

function currentRelease(manifest) {
  const release = Object.hasOwn(manifest, 'release') ? manifest.release : 0;
  if (!Number.isSafeInteger(release) || release < 0) {
    throw new Error('install-manifest.json release must be a non-negative integer');
  }
  return release;
}

// Plain pinning writes the install tuple (agent, Runtime and schema digest) and nothing else.
// It never touches `release`, `version_starts` or `required`.
export function applyTuplePin(manifest, { agentSha, runtimeSha, schemaDigest }) {
  manifest.agent.sha = agentSha;
  manifest.runtime.sha = runtimeSha;
  manifest.runtime.schema_digest = schemaDigest;
  return manifest;
}

// `--require` sets the floor to the manifest's own release. With --release it runs after
// applyReleasePin, so the floor is the new release. release-guard checks that the floor is not above release.
export function applyRequiredPin(manifest, reason) {
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('--require needs a non-empty reason');
  manifest.required = {
    release: currentRelease(manifest),
    reason: reason.trim(),
  };
  return manifest;
}

// `--release` is the only writer of `release` and `version_starts`. It moves release by exactly one.
// A minor or major kind also appends the version start for that new release; a plain release adds none.
export function applyReleasePin(manifest, kind) {
  if (kind !== undefined && kind !== 'minor' && kind !== 'major') throw new Error('--release kind must be minor or major');
  const release = currentRelease(manifest) + 1;
  const starts = manifest.version_starts ?? [];
  validateVersionStarts(starts, currentRelease(manifest));
  if (kind) manifest.version_starts = [...starts, nextVersionStart(release, kind, starts)];
  manifest.release = release;
  return manifest;
}

async function pin({ agentSha, release, kind, reason }) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest.agent || !manifest.runtime) throw new Error('install-manifest.json needs agent and runtime records');
  // With --release and no sha, the release pins the agent the manifest already names.
  const sha = agentSha ?? manifest.agent.sha;
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('install-manifest.json agent.sha must be a full commit SHA');
  const runtimeSha = await readAgentRuntime(sha);
  const schemaDigest = await runtimeSchemaDigest(runtimeSha);
  applyTuplePin(manifest, { agentSha: sha, runtimeSha, schemaDigest });
  if (release) applyReleasePin(manifest, kind);
  if (reason !== undefined) applyRequiredPin(manifest, reason);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function checkManifest(manifest) {
  validateVersionStarts(manifest?.version_starts, currentRelease(manifest ?? {}));
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

// Parses the command line into options. Refuses every combination that would write a field
// outside its own writer: --require is only accepted together with --release.
export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--check') return { check: true };
  const options = { agentSha: undefined, release: false, kind: undefined, reason: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--release') {
      if (options.release) throw new Error(usage);
      options.release = true;
      if (args[index + 1] === 'minor' || args[index + 1] === 'major') {
        options.kind = args[index + 1];
        index += 1;
      }
    } else if (arg === '--require') {
      const value = args[index + 1];
      if (options.reason !== undefined || !value || value.startsWith('--')) throw new Error('--require needs one non-empty reason');
      options.reason = value;
      index += 1;
    } else if (!options.agentSha && /^[0-9a-f]{40}$/i.test(arg)) {
      options.agentSha = arg;
    } else {
      throw new Error(usage);
    }
  }
  if (options.reason !== undefined && !options.release) {
    throw new Error('--require needs --release: required is set only with a release');
  }
  if (!options.agentSha && !options.release) throw new Error(usage);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.check) return check();
  return pin(options);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

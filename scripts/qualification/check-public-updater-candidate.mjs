import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const candidatePath = path.join(repoRoot, 'config/qualification/public-updater-candidate.json');
const baselinePath = path.join(repoRoot, 'config/qualification/release-0-public-manifest.json');
const finalManifestPath = path.join(repoRoot, 'public/install-manifest.json');
const baselineDigest = 'fe12781e4da60d441595c08f84cb8d0390d840ab7c71227b8c4eff791553795e';
const expected = {
  agent: { repo: 'banodoco/astrid-agent' },
  runtime: { repo: 'banodoco/astrid-runtime' },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertExpectedAppSha(expectedSha, actualSha) {
  assert(/^[0-9a-f]{40}$/.test(expectedSha ?? ''), 'Usage: node scripts/qualification/check-public-updater-candidate.mjs --expected-app-sha <full-40-hex-sha>');
  assert(/^[0-9a-f]{40}$/.test(actualSha ?? ''), 'Could not read a full App commit SHA from this worktree');
  assert(expectedSha === actualSha, `Expected App SHA ${expectedSha} does not match worktree HEAD ${actualSha}`);
}

function exactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert(Object.keys(value).sort().join(',') === [...keys].sort().join(','), `${label} has unexpected or missing fields`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readRaw(repo, sha, file) {
  const response = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${file}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Could not read ${repo}/${file} at ${sha}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function contractPath(value, label) {
  assert(typeof value === 'string' && value.length > 0 && !path.posix.isAbsolute(value), `Runtime contract has invalid ${label} path`);
  const normalized = path.posix.normalize(value);
  assert(normalized !== '..' && !normalized.startsWith('../'), `Runtime contract has unsafe ${label} path`);
  return `contract/${normalized}`;
}

async function runtimeSchemaDigest(runtimeSha) {
  const contract = JSON.parse((await readRaw(expected.runtime.repo, runtimeSha, 'contract/manifest.json')).toString('utf8'));
  assert(Array.isArray(contract.schemas) && contract.schemas.length > 0, 'Runtime contract manifest must list schemas');
  const files = [contractPath(contract.openapi, 'OpenAPI'), ...contract.schemas.map((file) => contractPath(file, 'schema'))];
  const contents = await Promise.all(files.map((file) => readRaw(expected.runtime.repo, runtimeSha, file)));
  const hash = createHash('sha256');
  for (const [index, file] of files.entries()) {
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

// The candidate metadata is the recorded Agent/Runtime tuple. The App SHA is
// supplied separately because a commit cannot contain its own SHA.
export function validateTuple({ candidate, baseline, mode, manifest }) {
  assert(mode === 'candidate' || mode === 'final', 'Mode must be candidate or final');
  exactKeys(candidate, ['schema_version', 'candidate_only', 'baseline', 'release', 'agent', 'runtime'], 'candidate');
  assert(candidate.schema_version === 1 && candidate.candidate_only === true, 'Candidate metadata marker is invalid');
  exactKeys(candidate.baseline, ['release', 'agent_sha', 'runtime_sha'], 'candidate baseline');
  exactKeys(candidate.agent, ['repo', 'sha'], 'candidate agent pin');
  exactKeys(candidate.runtime, ['repo', 'sha', 'schema_digest'], 'candidate Runtime pin');
  const baselineRelease = baseline.release ?? 0;
  assert(Number.isSafeInteger(baselineRelease) && baselineRelease >= 0, 'Frozen baseline release is invalid');
  assert(candidate.baseline.release === baselineRelease, 'Candidate baseline release does not match frozen release-0 baseline');
  assert(candidate.baseline.agent_sha === baseline.agent?.sha && candidate.baseline.runtime_sha === baseline.runtime?.sha, 'Candidate baseline source pins do not match frozen release-0 baseline');
  assert(Number.isSafeInteger(candidate.release) && candidate.release > baselineRelease, 'Candidate release must be an integer strictly above the frozen baseline');
  for (const component of ['agent', 'runtime']) {
    const pin = candidate[component];
    assert(pin.repo === expected[component].repo && /^[0-9a-f]{40}$/.test(pin.sha ?? ''), `${component} must use a full immutable GitHub SHA`);
  }
  assert(/^sha256:[0-9a-f]{64}$/.test(candidate.runtime.schema_digest ?? ''), 'Candidate Runtime schema digest is invalid');
  if (mode === 'final') {
    assert(manifest && manifest.release === candidate.release, 'Final manifest release differs from recorded candidate');
    assert(manifest.agent?.sha === candidate.agent.sha, 'Final manifest Agent SHA differs from recorded candidate');
    assert(manifest.runtime?.sha === candidate.runtime.sha, 'Final manifest Runtime SHA differs from recorded candidate');
    assert(manifest.runtime?.schema_digest === candidate.runtime.schema_digest, 'Final manifest Runtime schema digest differs from recorded candidate');
  }
  return baselineRelease;
}

async function main(args = process.argv.slice(2)) {
  let mode = 'candidate';
  let expectedAppSha;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--mode' && args.length) mode = args.shift();
    else if (flag === '--expected-app-sha' && args.length) expectedAppSha = args.shift();
    else throw new Error('Usage: node scripts/qualification/check-public-updater-candidate.mjs [--mode candidate|final] --expected-app-sha <full-40-hex-sha>');
  }
  const actualAppSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  assertExpectedAppSha(expectedAppSha, actualAppSha);
  const trackedInputs = ['config/qualification/public-updater-candidate.json', 'config/qualification/release-0-public-manifest.json', 'public/install-manifest.json'];
  const dirty = execFileSync('git', ['status', '--porcelain', '--', ...trackedInputs], { cwd: repoRoot, encoding: 'utf8' });
  assert(!dirty.trim(), 'Qualification inputs must match the recorded App commit');
  const baselineBytes = await readFile(baselinePath);
  assert(createHash('sha256').update(baselineBytes).digest('hex') === baselineDigest, 'Frozen release-0 baseline bytes have changed');
  const baseline = JSON.parse(baselineBytes.toString('utf8'));
  const candidate = await readJson(candidatePath);
  const manifest = mode === 'final' ? await readJson(finalManifestPath) : undefined;
  const baselineRelease = validateTuple({ candidate, baseline, mode, manifest });
  const agentLock = JSON.parse((await readRaw(expected.agent.repo, candidate.agent.sha, 'runtime.lock.json')).toString('utf8'));
  assert(agentLock.source_commit === candidate.runtime.sha, 'Agent runtime.lock.json does not select the candidate Runtime SHA');
  const digest = await runtimeSchemaDigest(candidate.runtime.sha);
  assert(candidate.runtime.schema_digest === digest, `Candidate Runtime schema digest ${candidate.runtime.schema_digest} does not match pinned Runtime source ${digest}`);
  process.stdout.write(`${mode} tuple coherent: App ${actualAppSha}; release ${candidate.release} > baseline ${baselineRelease}; Agent ${candidate.agent.sha}; Runtime ${candidate.runtime.sha}; ${digest}.\n`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

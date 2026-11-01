import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { ASTRID_CHECKOUT, ASTRID_PYTHON } from './astrid.ts';
import { REPO_ROOT, RUNTIME_CHECKOUT } from './harness.ts';

export const EXPECTED_RUNTIME_PRODUCER = 'astrid-runtime';
export const EXPECTED_RUNTIME_MANIFEST = 'contract/artifacts.json';
export const EXPECTED_RUNTIME_PRODUCER_VERSION = 'sha256:54205b3ecb55038e416b31af936c9af26afa30dc1b05da16157ee4d861fe05ac';
export const EXPECTED_PUBLIC_COMPOSITION_PACKAGE = {
  name: '@banodoco/timeline-composition',
  version: '0.0.13',
} as const;

const EXPECTED_RUNTIME_FILES = {
  'src/integrations/runtime/fixtures/responses/events_page_1_200.json': 'conformance/responses/events_page_1_200.json',
  'src/integrations/runtime/fixtures/responses/events_page_2_200.json': 'conformance/responses/events_page_2_200.json',
  'src/integrations/runtime/fixtures/responses/invalid_cursor_400.json': 'conformance/responses/invalid_cursor_400.json',
  'src/integrations/runtime/fixtures/responses/managed_outputs_200.json': 'conformance/responses/managed_outputs_200.json',
  'src/integrations/runtime/fixtures/responses/not_found_404.json': 'conformance/responses/not_found_404.json',
  'src/integrations/runtime/fixtures/responses/publish_conflict_409.json': 'conformance/responses/publish_conflict_409.json',
  'src/integrations/runtime/fixtures/responses/task_admission_201.json': 'conformance/responses/task_admission_201.json',
  'src/integrations/runtime/fixtures/responses/task_read_200.json': 'conformance/responses/task_read_200.json',
  'src/integrations/runtime/fixtures/responses/validation_error_422.json': 'conformance/responses/validation_error_422.json',
  'src/integrations/runtime/generated-contract-metadata.ts': 'packages/typescript/src/contract-metadata.ts',
  'src/integrations/runtime/generated.ts': 'packages/typescript/src/generated.ts',
  'src/integrations/runtime/timeline-commit-types.ts': 'packages/typescript/src/timeline-commit-types.ts',
  'vendor/timeline-schema/python/banodoco_timeline_schema/timeline.schema.json': 'contract/schemas/timeline-config.schema.json',
} as const;

export interface RuntimeLock {
  files: Record<keyof typeof EXPECTED_RUNTIME_FILES, { from: string; sha256: string }>;
  manifest: typeof EXPECTED_RUNTIME_MANIFEST;
  producer: typeof EXPECTED_RUNTIME_PRODUCER;
  producer_version: typeof EXPECTED_RUNTIME_PRODUCER_VERSION;
  source_commit: string;
}

/** Strict consumer-side shape check; vendor-lock.mjs remains the byte/hash authority. */
export function assertPublicTrimRuntimeLock(value: unknown, sourceCommit: string): RuntimeLock {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'public Trim Runtime lock must be an object');
  const lock = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(lock).sort(), ['files', 'manifest', 'producer', 'producer_version', 'source_commit']);
  assert.equal(lock.manifest, EXPECTED_RUNTIME_MANIFEST);
  assert.equal(lock.producer, EXPECTED_RUNTIME_PRODUCER);
  assert.equal(lock.producer_version, EXPECTED_RUNTIME_PRODUCER_VERSION);
  assert.equal(lock.source_commit, sourceCommit);
  assert(lock.files && typeof lock.files === 'object' && !Array.isArray(lock.files), 'public Trim Runtime lock files must be an object');
  const files = lock.files as Record<string, unknown>;
  assert.deepEqual(Object.keys(files).sort(), Object.keys(EXPECTED_RUNTIME_FILES).sort());
  for (const [consumerPath, producerPath] of Object.entries(EXPECTED_RUNTIME_FILES)) {
    const entry = files[consumerPath];
    assert(entry && typeof entry === 'object' && !Array.isArray(entry), `invalid Runtime lock entry: ${consumerPath}`);
    assert.deepEqual(Object.keys(entry).sort(), ['from', 'sha256']);
    assert.equal((entry as { from: unknown }).from, producerPath);
    assert.match((entry as { sha256: unknown }).sha256 as string, /^sha256:[0-9a-f]{64}$/);
  }
  return lock as RuntimeLock;
}

/** Validate package identity without constraining the archive's complete package metadata. */
export function assertPublicTrimCompositionPackage(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'public Trim Composition package must be an object');
  const packageJson = value as Record<string, unknown>;
  assert.equal(packageJson.name, EXPECTED_PUBLIC_COMPOSITION_PACKAGE.name);
  assert.equal(packageJson.version, EXPECTED_PUBLIC_COMPOSITION_PACKAGE.version);
  return packageJson;
}

const EXACT_AGENT_COMMIT = '6efc81500a0e0688c2bb41e736503f0fc3e04abb';
const EXACT_AGENT_TREE = '2ed2b8a12b5b3391ca221ba6ff05390f71a73556';
const EXACT_RUNTIME_COMMIT = '95bd3c5f6d00e9bc8cc8cbe5ef510b68ed660f3c';
const EXACT_RUNTIME_TREE = 'd3a290b407fa61e6ab2d476f50c068073f70df00';
const EXACT_VENDOR_AGENT_COMMIT = '091aa23ec83ea05ffd3b0115a640230d51c8c429';
const EXACT_VENDOR_AGENT_TREE = 'e3ae90fe482ba6cad6c3f94069127faf76ebceb6';
const EXACT_RUNTIME_SCHEMA_DIGEST = 'sha256:7d4afa05962b8cd61643213fc79cdde41e16046c4e2a777bd299b48af0f31816';
const EXACT_PUBLIC_COMPOSITION_SHA256 = '9412ae25c306d5118241f4d631e8eecc6eef9b2fb5a98302d40938e9f6d54738';
const IMMUTABLE_AGENT_CHECKOUT = '/home/user/work/wt/agt-pin-6efc8150';
const IMMUTABLE_RUNTIME_CHECKOUT = '/home/user/work/wt/rt-pin-95bd3c5f';

function git(checkout: string, ...args: string[]) {
  return execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function requireCleanPin(checkout: string, commit: string, tree: string, label: string) {
  assert.equal(realpathSync(checkout), realpathSync(label === 'Agent' ? IMMUTABLE_AGENT_CHECKOUT : IMMUTABLE_RUNTIME_CHECKOUT), `${label} checkout`);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), commit, `${label} commit`);
  assert.equal(git(checkout, 'rev-parse', 'HEAD^{tree}'), tree, `${label} tree`);
  assert.equal(git(checkout, 'status', '--porcelain', '--untracked-files=normal'), '', `${label} checkout must be clean`);
}

/** The exact source/artifact/module prelude shared by the browser fixture and cheap preflight. */
export function verifyPublicTrimSourceTuple() {
  assert.equal(process.env.TIMELINE_BUNDLE_AGENT_HEAD, EXACT_AGENT_COMMIT);
  assert.equal(ASTRID_CHECKOUT, IMMUTABLE_AGENT_CHECKOUT);
  assert.equal(RUNTIME_CHECKOUT, IMMUTABLE_RUNTIME_CHECKOUT);
  requireCleanPin(ASTRID_CHECKOUT, EXACT_AGENT_COMMIT, EXACT_AGENT_TREE, 'Agent');
  const provenance = JSON.parse(readFileSync(path.join(REPO_ROOT, 'vendor/astrid-browser/provenance.json'), 'utf8')) as { astrid_commit: string; astrid_tree: string };
  assert.deepEqual({ astrid_commit: provenance.astrid_commit, astrid_tree: provenance.astrid_tree }, { astrid_commit: EXACT_VENDOR_AGENT_COMMIT, astrid_tree: EXACT_VENDOR_AGENT_TREE });
  assert.notEqual(provenance.astrid_commit, EXACT_AGENT_COMMIT);
  const runtimeLock = assertPublicTrimRuntimeLock(JSON.parse(readFileSync(path.join(REPO_ROOT, 'runtime.lock.json'), 'utf8')), EXACT_RUNTIME_COMMIT);
  assert.equal(process.env.TIMELINE_BUNDLE_RUNTIME_HEAD, runtimeLock.source_commit);
  requireCleanPin(RUNTIME_CHECKOUT, runtimeLock.source_commit, EXACT_RUNTIME_TREE, 'Runtime');
  assert.equal(runtimeLock.manifest, EXPECTED_RUNTIME_MANIFEST);
  assert.equal(runtimeLock.producer, EXPECTED_RUNTIME_PRODUCER);
  assert.equal(runtimeLock.producer_version, EXPECTED_RUNTIME_PRODUCER_VERSION);
  const contractMetadata = readFileSync(path.join(REPO_ROOT, 'src/integrations/runtime/generated-contract-metadata.ts'), 'utf8');
  assert.match(contractMetadata, /CONTRACT_VERSION = "0\.2\.14"/);
  assert.match(contractMetadata, new RegExp(`SCHEMA_DIGEST = "${EXACT_RUNTIME_SCHEMA_DIGEST}"`));
  const vendorCheck = execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/vendor-lock.mjs'), 'check', path.join(REPO_ROOT, 'runtime.lock.json'), '--producer', RUNTIME_CHECKOUT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(vendorCheck, /ok runtime\.lock\.json \(matches pinned producer commit\)/);
  const vendorSourcesCheck = execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/build/verify-astrid-vendor-sources.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(vendorSourcesCheck, /Verified/);
  const artifacts = JSON.parse(readFileSync(path.join(RUNTIME_CHECKOUT, 'contract/artifacts.json'), 'utf8')) as { artifacts: Record<string, unknown>; producer: string; version: string };
  assert.deepEqual(Object.keys(artifacts).sort(), ['artifacts', 'producer', 'version']);
  assert.equal(artifacts.producer, EXPECTED_RUNTIME_PRODUCER);
  assert.equal(artifacts.version, EXPECTED_RUNTIME_PRODUCER_VERSION);
  assert.equal(Object.keys(artifacts.artifacts).length, 76);
  assert.ok(Object.values(artifacts.artifacts).every((digest) => typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(digest)));
  assert.deepEqual(artifacts, JSON.parse(git(RUNTIME_CHECKOUT, 'show', `${EXACT_RUNTIME_COMMIT}:contract/artifacts.json`)));
  const archive = path.join(REPO_ROOT, 'vendor/artifacts/banodoco-timeline-composition-0.0.13.tgz');
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), EXACT_PUBLIC_COMPOSITION_SHA256);
  const appPackage = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const appLock = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8')) as { packages?: Record<string, { dependencies?: Record<string, string>; version?: string; resolved?: string; integrity?: string }> };
  const compositionPackage = appLock.packages?.['node_modules/@banodoco/timeline-composition'];
  const compositionSpec = appPackage.dependencies?.['@banodoco/timeline-composition'];
  assert.equal(compositionSpec, 'file:vendor/artifacts/banodoco-timeline-composition-0.0.13.tgz');
  assert.equal(appLock.packages?.['']?.dependencies?.['@banodoco/timeline-composition'], compositionSpec);
  assert.deepEqual(compositionPackage, {
    version: '0.0.13',
    resolved: 'file:vendor/artifacts/banodoco-timeline-composition-0.0.13.tgz',
    integrity: 'sha512-6qgEAcfYqEGuiesoRlBFj1QnEgDKdZsisQdrMivONtc3lAct8thdzVbNV6L7lY5f2D9vvTIZHTD8vKhfWgLOuQ==',
    peerDependencies: {
      '@remotion/layout-utils': '4.0.509',
      '@remotion/media': '4.0.509',
      react: '18.3.1',
      'react-dom': '18.3.1',
      remotion: '4.0.509',
    },
  });
  const archivePackage = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as unknown;
  assertPublicTrimCompositionPackage(archivePackage);
  const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').filter((member) => member && !member.endsWith('/'));
  assert.equal(members.length, 77);
  assert.ok(members.every((member) => member.startsWith('package/')));
  const modules = JSON.parse(execFileSync(ASTRID_PYTHON, ['-c', 'import astrid, runtime_protocol, json; print(json.dumps({"astrid": astrid.__file__, "runtime": runtime_protocol.__file__}))'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: [ASTRID_CHECKOUT, RUNTIME_CHECKOUT].join(path.delimiter) },
  })) as { astrid: string; runtime: string };
  assert.ok(realpathSync(modules.astrid).startsWith(`${realpathSync(ASTRID_CHECKOUT)}${path.sep}`));
  assert.ok(realpathSync(modules.runtime).startsWith(`${realpathSync(RUNTIME_CHECKOUT)}${path.sep}`));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { assertExpectedAppSha } from './check-public-updater-candidate.mjs';

test('App SHA binding accepts an exact full-SHA match', () => {
  const sha = 'ff6ede4f99aba8ba9653ba19d471c1894a00975f';
  assert.doesNotThrow(() => assertExpectedAppSha(sha, sha));
});

test('App SHA binding rejects a worktree HEAD mismatch', () => {
  assert.throws(
    () => assertExpectedAppSha('ff6ede4f99aba8ba9653ba19d471c1894a00975f', 'a7c4463e8a6faad37decfb17ff8287f4b8096d1c'),
    /does not match worktree HEAD/,
  );
});

test('App SHA binding requires a full 40-character SHA', () => {
  assert.throws(() => assertExpectedAppSha('ff6ede4f', 'ff6ede4f99aba8ba9653ba19d471c1894a00975f'), /full-40-hex-sha/);
});

import { readFile } from 'node:fs/promises';
import { validateTuple } from './check-public-updater-candidate.mjs';

const baseline = JSON.parse(await readFile(new URL('../../config/qualification/release-0-public-manifest.json', import.meta.url)));
const candidate = JSON.parse(await readFile(new URL('../../config/qualification/public-updater-candidate.json', import.meta.url)));
const finalManifest = {
  release: candidate.release,
  agent: { sha: candidate.agent.sha },
  runtime: { sha: candidate.runtime.sha, schema_digest: candidate.runtime.schema_digest },
};

test('candidate and final modes validate the recorded tuple against the frozen baseline', () => {
  assert.equal(validateTuple({ candidate, baseline, mode: 'candidate' }), 0);
  assert.equal(validateTuple({ candidate, baseline, mode: 'final', manifest: finalManifest }), 0);
});

test('candidate input cannot redefine the frozen baseline', () => {
  const altered = structuredClone(candidate);
  altered.baseline.agent_sha = altered.agent.sha;
  assert.throws(() => validateTuple({ candidate: altered, baseline, mode: 'candidate' }), /frozen release-0 baseline/);
});

test('final mode rejects every tuple mismatch and a missing manifest', () => {
  for (const mutate of [
    (value) => { value.release++; },
    (value) => { value.agent.sha = 'a'.repeat(40); },
    (value) => { value.runtime.sha = 'b'.repeat(40); },
    (value) => { value.runtime.schema_digest = `sha256:${'c'.repeat(64)}`; },
  ]) {
    const manifest = structuredClone(finalManifest);
    mutate(manifest);
    assert.throws(() => validateTuple({ candidate, baseline, mode: 'final', manifest }), /differs from recorded candidate/);
  }
  assert.throws(() => validateTuple({ candidate, baseline, mode: 'final' }), /Final manifest release/);
});

test('candidate mode rejects mutable refs and releases at the baseline', () => {
  const branch = structuredClone(candidate);
  branch.agent.sha = 'main';
  assert.throws(() => validateTuple({ candidate: branch, baseline, mode: 'candidate' }), /full immutable/);
  const oldRelease = structuredClone(candidate);
  oldRelease.release = 0;
  assert.throws(() => validateTuple({ candidate: oldRelease, baseline, mode: 'candidate' }), /strictly above/);
  assert.throws(() => validateTuple({ candidate, baseline, mode: 'unknown' }), /Mode must/);
});

// Exercise the real CLI in an isolated committed App repository. The source
// fetches are deterministic fixtures so CI verifies the lock and digest paths
// without depending on GitHub availability or publishing a manifest.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check-public-updater-candidate.mjs', import.meta.url));
const frozenBaseline = fileURLToPath(new URL('../../config/qualification/release-0-public-manifest.json', import.meta.url));
const agentSha = 'a'.repeat(40);
const runtimeSha = 'b'.repeat(40);

function fixtureDigest(files) {
  const hash = createHash('sha256');
  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const nameLength = Buffer.alloc(4);
    const dataLength = Buffer.alloc(8);
    nameLength.writeUInt32BE(nameBytes.length);
    dataLength.writeBigUInt64BE(BigInt(data.length));
    hash.update(nameLength).update(nameBytes).update(dataLength).update(data);
  }
  return `sha256:${hash.digest('hex')}`;
}

test('final CLI checks a committed exact tuple and rejects source or worktree drift', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'astrid-final-tuple-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['scripts/qualification', 'config/qualification', 'public']) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await copyFile(checker, path.join(root, 'scripts/qualification/check-public-updater-candidate.mjs'));
  await copyFile(frozenBaseline, path.join(root, 'config/qualification/release-0-public-manifest.json'));
  const files = [['contract/openapi/api.yaml', 'openapi: 3.0.0\n'], ['contract/schemas/a.json', '{"type":"object"}\n']];
  const digest = fixtureDigest(files);
  const metadata = structuredClone(candidate);
  metadata.agent.sha = agentSha;
  metadata.runtime.sha = runtimeSha;
  metadata.runtime.schema_digest = digest;
  const manifest = { release: metadata.release, agent: { sha: agentSha }, runtime: { sha: runtimeSha, schema_digest: digest } };
  await writeFile(path.join(root, 'config/qualification/public-updater-candidate.json'), JSON.stringify(metadata));
  await writeFile(path.join(root, 'public/install-manifest.json'), JSON.stringify(manifest));
  // --import installs a fetch stub inside the separate CLI process. It checks
  // the requested repository and immutable SHA as well as returning bytes.
  const responses = {
    [`banodoco/astrid-agent/${agentSha}/runtime.lock.json`]: JSON.stringify({ source_commit: runtimeSha }),
    [`banodoco/astrid-runtime/${runtimeSha}/contract/manifest.json`]: JSON.stringify({ openapi: 'openapi/api.yaml', schemas: ['schemas/a.json'] }),
    ...Object.fromEntries(files.map(([name, data]) => [`banodoco/astrid-runtime/${runtimeSha}/${name}`, data])),
  };
  await writeFile(path.join(root, 'fetch-fixture.mjs'), `const responses = ${JSON.stringify(responses)};\nglobalThis.fetch = async (url) => {\n  const key = String(url).replace('https://raw.githubusercontent.com/', '');\n  if (!(key in responses)) throw new Error('Unexpected source fetch: ' + url);\n  let body = responses[key];\n  if (process.env.FIXTURE_DRIFT === 'lock' && key.endsWith('runtime.lock.json')) body = JSON.stringify({source_commit: 'c'.repeat(40)});\n  if (process.env.FIXTURE_DRIFT === 'contract' && key.endsWith('schemas/a.json')) body += ' ';\n  return new Response(body);\n};\n`);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Final tuple fixture');
  const appSha = git('rev-parse', 'HEAD');
  const run = (extraEnv = {}, expectedSha = appSha) => spawnSync(process.execPath, ['--import', path.join(root, 'fetch-fixture.mjs'), path.join(root, 'scripts/qualification/check-public-updater-candidate.mjs'), '--mode', 'final', '--expected-app-sha', expectedSha], { cwd: root, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  const success = run();
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, new RegExp(`final tuple coherent: App ${appSha}; release 1 > baseline 0; Agent ${agentSha}; Runtime ${runtimeSha}; ${digest}`));
  for (const [drift, message] of [['lock', /does not select the candidate Runtime SHA/], ['contract', /does not match pinned Runtime source/]]) {
    const result = run({ FIXTURE_DRIFT: drift });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  }
  const wrongHead = run({}, 'd'.repeat(40));
  assert.notEqual(wrongHead.status, 0);
  assert.match(wrongHead.stderr, /does not match worktree HEAD/);
  await writeFile(path.join(root, 'public/install-manifest.json'), JSON.stringify({ ...manifest, release: 2 }));
  const dirty = run();
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /Qualification inputs must match/);
  git('add', 'public/install-manifest.json');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Mismatch');
  const mismatch = run({}, git('rev-parse', 'HEAD'));
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /Final manifest release differs/);
});

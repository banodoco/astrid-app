import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyReleasePin } from './pin.mjs';
import { checkManifestRelease } from './release-check.mjs';

const manifestPath = 'public/install-manifest.json';
const releaseCheckPath = fileURLToPath(new URL('./release-check.mjs', import.meta.url));
const release0ManifestBytes = await readFile(new URL('../../config/qualification/release-0-public-manifest.json', import.meta.url));

async function gitRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'astrid-release-check-'));
  await mkdir(path.join(repo, 'public'));
  await mkdir(path.join(repo, 'config/qualification'), { recursive: true });
  await writeFile(path.join(repo, 'config/qualification/published-release-baseline.json'), '{"schema_version":1,"release":0}\n');
  await writeFile(path.join(repo, 'config/qualification/release-0-public-manifest.json'), release0ManifestBytes);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release-test@example.invalid');
  return {
    repo,
    async commit(manifest) {
      await this.commitBytes(Buffer.from(`${JSON.stringify(manifest)}\n`));
    },
    async commitBytes(bytes) {
      await writeFile(path.join(repo, manifestPath), bytes);
      git('add', manifestPath, 'config/qualification/published-release-baseline.json');
      git('commit', '-m', 'pin manifest');
    },
    branch(name) { git('branch', name); },
    checkout(name) { git('checkout', name); },
    manifestAt(ref) { return git('show', `${ref}:${manifestPath}`); },
    async candidate(manifest) {
      return Buffer.from(`${JSON.stringify(manifest)}\n`);
    },
    async writeCandidate(manifest) {
      await writeFile(path.join(repo, manifestPath), `${JSON.stringify(manifest)}\n`);
    },
    async close() { await rm(repo, { recursive: true, force: true }); },
  };
}

test('pins begin at release 1, increase on every pin, and keep required release persistent', () => {
  const manifest = {};
  applyReleasePin(manifest);
  assert.equal(manifest.release, 1);
  applyReleasePin(manifest, 'Security fix');
  assert.equal(manifest.release, 2);
  assert.deepEqual(manifest.required, { release: 2, reason: 'Security fix' });
  applyReleasePin(manifest);
  assert.equal(manifest.release, 3);
  assert.deepEqual(manifest.required, { release: 2, reason: 'Security fix' });
  applyReleasePin(manifest, 'Urgent data repair');
  assert.equal(manifest.release, 4);
  assert.deepEqual(manifest.required, { release: 4, reason: 'Urgent data repair' });
});

test('unchanged manifest bytes are a no-op; a changed manifest must raise release from missing release 0', async (t) => {
  const fixture = await gitRepo();
  t.after(() => fixture.close());
  await fixture.commit({ schema_version: 1 });
  assert.match(await checkManifestRelease({ repo: fixture.repo, baseRef: 'main' }), /bytes match/);
  assert.match(await checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: await fixture.candidate({ schema_version: 1, release: 1 }) }), /release 1 exceeds previous main 0/);
  await assert.rejects(
    checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: await fixture.candidate({ schema_version: 2 }) }),
    /does not exceed previous main release 0/,
  );
});

test('successive release 2 passes after release 1; a changed manifest cannot reuse release 1', async (t) => {
  const fixture = await gitRepo();
  t.after(() => fixture.close());
  await fixture.commit({ release: 1, field: 'first' });
  assert.match(await checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: await fixture.candidate({ release: 2, field: 'second' }) }), /release 2 exceeds previous main 1/);
  await assert.rejects(
    checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: await fixture.candidate({ release: 1, field: 'second' }) }),
    /does not exceed previous main release 1/,
  );
});

test('release must exceed the highest release in all App main manifest history', async (t) => {
  const fixture = await gitRepo();
  t.after(() => fixture.close());
  await fixture.commit({ release: 5, field: 'high water' });
  await fixture.commit({ release: 4, field: 'lower but current baseline' });
  await assert.rejects(
    checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: await fixture.candidate({ release: 5, field: 'changed' }) }),
    /does not exceed App main history high-water 5/,
  );
});

test('candidate mode allows replacing an unpublished candidate at the same release above the published baseline', async (t) => {
  const fixture = await gitRepo();
  t.after(() => fixture.close());
  await fixture.commit({ release: 1, field: 'first unpublished candidate' });
  assert.match(
    await checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: await fixture.candidate({ release: 1, field: 'replacement candidate' }), candidateMode: true, publishedBaselineRef: 'main' }),
    /unpublished candidate release 1 exceeds last published release 0/,
  );
  await assert.rejects(
    checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: await fixture.candidate({ release: 1, field: 'replacement candidate' }) }),
    /does not exceed previous main release 1/,
  );
});

test('candidate mode allows the exact frozen Release-0 manifest before the first public bump', async (t) => {
  const fixture = await gitRepo();
  t.after(() => fixture.close());
  await fixture.commitBytes(release0ManifestBytes);
  assert.match(
    await checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: release0ManifestBytes, candidateMode: true, publishedBaselineRef: 'main' }),
    /bytes match frozen Release-0 baseline/,
  );
});

test('candidate mode rejects release-0 bytes once a later release is published', async (t) => {
  const fixture = await gitRepo();
  t.after(() => fixture.close());
  await writeFile(path.join(fixture.repo, 'config/qualification/published-release-baseline.json'), '{"schema_version":1,"release":1}\n');
  await fixture.commit({ release: 1 });
  const release0 = await readFile(path.join(fixture.repo, 'config/qualification/release-0-public-manifest.json'));
  await assert.rejects(checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: release0, candidateMode: true, publishedBaselineRef: 'main' }), /does not exceed last published release 1/);
});

test('candidate mode rejects a changed frozen Release-0 baseline', async (t) => {
  const fixture = await gitRepo();
  t.after(() => fixture.close());
  await fixture.commit({ release: 1 });
  await writeFile(path.join(fixture.repo, 'config/qualification/release-0-public-manifest.json'), '{"release":0}\n');
  await assert.rejects(checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: await fixture.candidate({ release: 1 }), candidateMode: true, publishedBaselineRef: 'main' }), /Frozen Release-0 manifest bytes have changed/);
});

test('candidate mode still rejects a downgrade below the frozen published release', async (t) => {
  const fixture = await gitRepo();
  t.after(() => fixture.close());
  await writeFile(path.join(fixture.repo, 'config/qualification/published-release-baseline.json'), '{"schema_version":1,"release":1}\n');
  await fixture.commit({ release: 2, field: 'unpublished candidate' });
  await assert.rejects(
    checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: await fixture.candidate({ release: 1, field: 'downgrade' }), candidateMode: true, publishedBaselineRef: 'main' }),
    /does not exceed last published release 1/,
  );
});

test('legacy main without a baseline permits only the Release-0 fallback', async (t) => {
  const fixture = await gitRepo();
  t.after(() => fixture.close());
  await fixture.commit({ release: 0 });
  const git = (...args) => execFileSync('git', args, { cwd: fixture.repo, stdio: 'pipe' });
  git('rm', '--cached', 'config/qualification/published-release-baseline.json');
  git('commit', '-m', 'legacy main');
  assert.match(await checkManifestRelease({ repo: fixture.repo, baseRef: 'main', publishedBaselineRef: 'main', candidateBytes: await fixture.candidate({ release: 1 }), candidateMode: true }), /last published release 0/);
  await writeFile(path.join(fixture.repo, manifestPath), '{"release":1}\n');
  git('add', manifestPath);
  git('commit', '-m', 'advance without baseline');
  await assert.rejects(checkManifestRelease({ repo: fixture.repo, baseRef: 'main', publishedBaselineRef: 'main', candidateBytes: await fixture.candidate({ release: 2 }), candidateMode: true }), /Published baseline is missing from main after Release 0/);
});

test('candidate cannot lower the published baseline from main', async (t) => {
  const fixture = await gitRepo();
  t.after(() => fixture.close());
  await writeFile(path.join(fixture.repo, 'config/qualification/published-release-baseline.json'), '{"schema_version":1,"release":1}\n');
  await fixture.commit({ release: 1, field: 'published' });
  await writeFile(path.join(fixture.repo, 'config/qualification/published-release-baseline.json'), '{"schema_version":1,"release":0}\n');
  await assert.rejects(
    checkManifestRelease({ repo: fixture.repo, baseRef: 'main', publishedBaselineRef: 'main', candidateBytes: await fixture.candidate({ release: 1, field: 'downgrade' }), candidateMode: true }),
    /Candidate published release baseline differs from main/,
  );
});

test('candidate mode rejects unchanged main bytes when that release is already published', async (t) => {
  const fixture = await gitRepo();
  t.after(() => fixture.close());
  await writeFile(path.join(fixture.repo, 'config/qualification/published-release-baseline.json'), '{"schema_version":1,"release":1}\n');
  await fixture.commit({ release: 1, field: 'published release' });
  await assert.rejects(
    checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateMode: true, publishedBaselineRef: 'main' }),
    /Manifest release 1 does not exceed last published release 1/,
  );
});

test('stale branch manifests cannot remove or lower required.release when merged after main advances', async (t) => {
  const fixture = await gitRepo();
  t.after(() => fixture.close());
  await fixture.commit({ release: 10, required: { release: 8, reason: 'Older requirement' } });
  fixture.branch('stale-pin');

  await fixture.commit({ release: 11, required: { release: 9, reason: 'Current requirement' } });
  fixture.checkout('stale-pin');
  await fixture.commit({ release: 12, field: 'stale branch removed required' });
  const removedRequirement = fixture.manifestAt('stale-pin');

  fixture.checkout('main');
  await assert.rejects(
    checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: removedRequirement }),
    /required\.release 0 is below App main history high-water 9/,
  );

  await fixture.checkout('stale-pin');
  await fixture.commit({ release: 13, required: { release: 8, reason: 'Stale requirement' } });
  const loweredRequirement = fixture.manifestAt('stale-pin');
  await assert.rejects(
    checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: loweredRequirement }),
    /required\.release 8 is below App main history high-water 9/,
  );
});

test('required.release may be preserved or increased from main history', async (t) => {
  const fixture = await gitRepo();
  t.after(() => fixture.close());
  await fixture.commit({ release: 10, required: { release: 9, reason: 'Required fix' } });

  assert.match(
    await checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: await fixture.candidate({ release: 11, required: { release: 9, reason: 'Required fix' } }) }),
    /required\.release 9 preserves or exceeds history high-water 9/,
  );
  assert.match(
    await checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: await fixture.candidate({ release: 12, required: { release: 12, reason: 'More urgent fix' } }) }),
    /required\.release 12 preserves or exceeds history high-water 9/,
  );
});

test('the CI checker CLI rejects a candidate that removes required.release', async (t) => {
  const fixture = await gitRepo();
  t.after(() => fixture.close());
  await fixture.commit({ release: 10, required: { release: 9, reason: 'Required fix' } });
  await fixture.writeCandidate({ release: 11 });

  assert.throws(
    () => execFileSync(process.execPath, [releaseCheckPath, 'main'], { cwd: fixture.repo, stdio: ['ignore', 'pipe', 'pipe'] }),
    (error) => error.status === 1 && /required\.release 0 is below App main history high-water 9/.test(error.stderr.toString()),
  );

  await fixture.writeCandidate({ release: 11, required: { release: 9, reason: 'Required fix' } });
  assert.match(
    execFileSync(process.execPath, [releaseCheckPath, 'main'], { cwd: fixture.repo, encoding: 'utf8' }),
    /required\.release 9 preserves or exceeds history high-water 9/,
  );
});

test('required.release cannot fall below a historical high-water above the current manifest', async (t) => {
  const fixture = await gitRepo();
  t.after(() => fixture.close());
  await fixture.commit({ release: 10, required: { release: 12, reason: 'Historical requirement' } });
  await fixture.commit({ release: 11, required: { release: 9, reason: 'Lower current requirement' } });

  await assert.rejects(
    checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: await fixture.candidate({ release: 12, required: { release: 10, reason: 'Attempted reduction' } }) }),
    /required\.release 10 is below App main history high-water 12/,
  );
  await assert.rejects(
    checkManifestRelease({ repo: fixture.repo, baseRef: 'main' }),
    /required\.release 9 is below App main history high-water 12/,
  );
  assert.match(
    await checkManifestRelease({ repo: fixture.repo, baseRef: 'main', candidateBytes: await fixture.candidate({ release: 13, required: { release: 12, reason: 'Preserved historical requirement' } }) }),
    /required\.release 12 preserves or exceeds history high-water 12/,
  );
});

test('the pin helper preserves unrelated manifest fields including schema_digest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../public/install-manifest.json', import.meta.url), 'utf8'));
  const schemaDigest = manifest.runtime.schema_digest;
  const expectedRelease = (manifest.release ?? 0) + 1;
  applyReleasePin(manifest, 'Required migration');
  assert.equal(manifest.release, expectedRelease);
  assert.equal(manifest.required.release, expectedRelease);
  assert.equal(manifest.runtime.schema_digest, schemaDigest);
});

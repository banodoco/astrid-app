import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyReleasePin } from './pin.mjs';
import { checkManifestRelease } from './release-check.mjs';

const manifestPath = 'public/install-manifest.json';

async function gitRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'astrid-release-check-'));
  await mkdir(path.join(repo, 'public'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release-test@example.invalid');
  return {
    repo,
    async commit(manifest) {
      await writeFile(path.join(repo, manifestPath), `${JSON.stringify(manifest)}\n`);
      git('add', manifestPath);
      git('commit', '-m', 'pin manifest');
    },
    async candidate(manifest) {
      return Buffer.from(`${JSON.stringify(manifest)}\n`);
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

test('the pin helper preserves unrelated manifest fields including schema_digest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../public/install-manifest.json', import.meta.url), 'utf8'));
  const schemaDigest = manifest.runtime.schema_digest;
  applyReleasePin(manifest, 'Required migration');
  assert.equal(manifest.release, 1);
  assert.equal(manifest.required.release, 1);
  assert.equal(manifest.runtime.schema_digest, schemaDigest);
});

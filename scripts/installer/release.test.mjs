import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyRequiredPin, checkManifest } from './pin.mjs';
import * as guard from './release-guard.mjs';
import { checkReleaseGuard, readSnapshot } from './release-guard.mjs';
import { servedMismatches } from './served-manifest.mjs';

const releaseGuardPath = fileURLToPath(new URL('./release-guard.mjs', import.meta.url));
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DIGEST = `sha256:${'c'.repeat(64)}`;

const bootstrapDefaults = {
  'public/install': Buffer.from('#!/bin/sh\necho install v1\n'),
  'public/install.ps1': Buffer.from('Write-Output "install v1"\n'),
  'public/install.sh': Buffer.from('#!/bin/sh\necho install.sh v1\n'),
};

function manifestOf(overrides = {}) {
  return {
    schema_version: 1,
    release: 3,
    agent: { sha: SHA_A },
    runtime: { sha: SHA_B, schema_digest: DIGEST },
    tools: { uv: { version: '0.11.32' } },
    ...overrides,
  };
}

function withoutRelease(manifest) {
  const copy = { ...manifest };
  delete copy.release;
  return copy;
}

// A snapshot is what readSnapshot returns: manifest bytes plus bootstrap bytes.
function snapshot(manifest, bootstraps = {}) {
  return {
    manifest: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    bootstraps: { ...bootstrapDefaults, ...bootstraps },
  };
}

// A served snapshot is what served-manifest reads: parsed manifest plus bootstrap bytes.
// served-manifest keys bootstrap bytes by their public/ file name.
function served(manifest, bootstraps = {}) {
  const byName = Object.fromEntries(Object.entries({ ...bootstrapDefaults, ...bootstraps }).map(([file, bytes]) => [file.slice('public/'.length), bytes]));
  return { manifest, bootstraps: byName };
}

test('an install tuple change with release +1 passes the guard', () => {
  const base = snapshot(manifestOf());
  const head = snapshot(manifestOf({ release: 4, agent: { sha: SHA_B } }));
  assert.match(checkReleaseGuard({ base, head }), /install tuple changed \(manifest \(without release and required\)\); release 3 -> 4/);
});

test('an install tuple change without release +1 fails the guard', () => {
  const base = snapshot(manifestOf());
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ agent: { sha: SHA_B } })) }),
    /install tuple changed .* a tuple change requires release 4/,
  );
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 5, agent: { sha: SHA_B } })) }),
    /a tuple change requires release 4 \(exactly \+1 from 3\)/,
  );
});

test('a bootstrap byte change needs release +1: refused at the same release, passes at +1', () => {
  const base = snapshot(manifestOf());
  const edited = { 'public/install.sh': Buffer.from('#!/bin/sh\necho install.sh v2\n') };
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf(), edited) }),
    /install tuple changed \(public\/install\.sh\) but release is 3/,
  );
  assert.match(
    checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 4 }), edited) }),
    /install tuple changed \(public\/install\.sh\); release 3 -> 4/,
  );
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 5 }), { 'public/install.ps1': Buffer.from('changed\n') }) }),
    /install tuple changed \(public\/install\.ps1\) but release is 5; a tuple change requires release 4/,
  );
});

test('a release change without a tuple change fails the guard, up or down', () => {
  const base = snapshot(manifestOf());
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 4 })) }),
    /release changed from 3 to 4 without an install tuple change; release must stay 3/,
  );
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 2 })) }),
    /release changed from 3 to 2 without an install tuple change/,
  );
});

test('no tuple change and no release change passes, including a valid required floor', () => {
  const base = snapshot(manifestOf({ release: 5 }));
  assert.match(checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 5 })) }), /install tuple unchanged; release 5 unchanged/);
  assert.match(
    checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 5, required: { release: 5, reason: 'Security fix' } })) }),
    /install tuple unchanged; release 5 unchanged/,
  );
});

test('a pure reformat or key reorder of the manifest is not a tuple change', () => {
  const base = snapshot(manifestOf());
  const reordered = Buffer.from(JSON.stringify({ tools: { uv: { version: '0.11.32' } }, runtime: { schema_digest: DIGEST, sha: SHA_B }, agent: { sha: SHA_A }, release: 3, schema_version: 1 }));
  assert.match(checkReleaseGuard({ base, head: { manifest: reordered, bootstraps: bootstrapDefaults } }), /install tuple unchanged/);
});

test('a base manifest without release reads as release 0', () => {
  const base = snapshot(withoutRelease(manifestOf()));
  assert.match(
    checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 1, agent: { sha: SHA_B } })) }),
    /release 0 -> 1/,
  );
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 2, agent: { sha: SHA_B } })) }),
    /a tuple change requires release 1 \(exactly \+1 from 0\)/,
  );
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 1 })) }),
    /release changed from 0 to 1 without an install tuple change/,
  );
});

test('the head manifest must declare an integer release', () => {
  const base = snapshot(manifestOf());
  assert.throws(() => checkReleaseGuard({ base, head: snapshot(withoutRelease(manifestOf())) }), /must declare an integer release/);
  assert.throws(() => checkReleaseGuard({ base, head: snapshot(manifestOf({ release: '4' })) }), /release must be a non-negative integer/);
});

test('required must satisfy 0 <= required.release <= release and carry a non-empty reason', () => {
  const base = snapshot(manifestOf());
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ required: { release: 4, reason: 'Ahead of release' } })) }),
    /required\.release 4 exceeds release 3/,
  );
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ required: { release: -1, reason: 'Negative' } })) }),
    /required\.release must be a non-negative integer/,
  );
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ required: { release: 3, reason: '   ' } })) }),
    /required\.reason must be a non-empty string/,
  );
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ required: { release: 3 } })) }),
    /required\.reason must be a non-empty string/,
  );
  assert.match(
    checkReleaseGuard({ base, head: snapshot(manifestOf({ required: { release: 0, reason: 'No floor yet' } })) }),
    /install tuple unchanged/,
  );
});

test('pin --require sets required.release to the manifest own release and never writes release', () => {
  const manifest = manifestOf();
  applyRequiredPin(manifest, 'Security fix');
  assert.equal(manifest.release, 3);
  assert.deepEqual(manifest.required, { release: 3, reason: 'Security fix' });
  applyRequiredPin(manifest, 'Later fix');
  assert.equal(manifest.release, 3);
  assert.deepEqual(manifest.required, { release: 3, reason: 'Later fix' });
  assert.throws(() => applyRequiredPin(manifest, '  '), /non-empty reason/);
});

test('the CLI compares committed base and head refs and exits non-zero on refusal', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'release-guard-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const commitState = async ({ manifest, bootstraps = {} }) => {
    for (const [file, bytes] of Object.entries({ 'public/install-manifest.json': Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), ...bootstrapDefaults, ...bootstraps })) {
      await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
      await writeFile(path.join(repo, file), bytes);
    }
    git('add', '.');
    git('-c', 'user.name=Release guard test', '-c', 'user.email=release-guard-test@example.invalid', 'commit', '-q', '-m', 'state');
    return git('rev-parse', 'HEAD');
  };
  const run = (ref) => spawnSync(process.execPath, [releaseGuardPath, ref, 'HEAD'], { cwd: repo, encoding: 'utf8' });

  git('init', '-q', '-b', 'main');
  const base = await commitState({ manifest: manifestOf() });
  // Each scenario is a separate commit on top of the same base, so a passing
  // scenario cannot make a later refusal pass.
  const scenario = async (state) => {
    git('reset', '-q', '--hard', base);
    await commitState(state);
    return run(base);
  };

  const passing = await scenario({ manifest: manifestOf({ release: 4, agent: { sha: SHA_B } }) });
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /release 3 -> 4/);

  const bootstrapRefused = await scenario({ manifest: manifestOf(), bootstraps: { 'public/install.sh': Buffer.from('#!/bin/sh\nchanged\n') } });
  assert.equal(bootstrapRefused.status, 1);
  assert.match(bootstrapRefused.stderr, /release guard refused: install tuple changed \(public\/install\.sh\) but release is 3/);

  const tupleSkippedRelease = await scenario({ manifest: manifestOf({ release: 5, agent: { sha: SHA_B } }) });
  assert.equal(tupleSkippedRelease.status, 1);
  assert.match(tupleSkippedRelease.stderr, /a tuple change requires release 4 \(exactly \+1 from 3\)/);

  const releaseOnly = await scenario({ manifest: manifestOf({ release: 4 }) });
  assert.equal(releaseOnly.status, 1);
  assert.match(releaseOnly.stderr, /release guard refused: release changed from 3 to 4 without an install tuple change/);
});

test('readSnapshot rejects a ref that is not a commit', () => {
  assert.throws(() => readSnapshot(process.cwd(), '0'.repeat(40)), /is not a commit in this checkout/);
});

test('the served canary reports release and bootstrap-byte mismatches and accepts a matching deployment', () => {
  const expected = served(manifestOf({ release: 4 }));
  const deployed = 'd'.repeat(40);
  assert.deepEqual(servedMismatches(expected, served(manifestOf({ release: 4 })), deployed), []);
  assert.deepEqual(
    servedMismatches(expected, served(manifestOf({ release: 3 })), deployed),
    [`release: deployed ${deployed} public value 4, served value 3`],
  );
  assert.deepEqual(
    servedMismatches(expected, served(manifestOf({ release: 4 }), { 'public/install': Buffer.from('old bytes\n') }), deployed),
    [`install: served bytes differ from deployed ${deployed} public/install`],
  );
  assert.deepEqual(
    servedMismatches(expected, served(manifestOf({ release: 4 }), { 'public/install.ps1': Buffer.from('old\n') }), deployed),
    [`install.ps1: served bytes differ from deployed ${deployed} public/install.ps1`],
  );
});

test('a floor pinned before release is bumped is refused, and a floor at the published release passes', () => {
  const base = snapshot(manifestOf({ release: 2 }));
  // Pinned before the bump: the floor stays at the old release while release 3 is published.
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 3, agent: { sha: SHA_B }, required: { release: 2, reason: 'Security fix' } })) }),
    /required\.release 2 is not the release being published \(3\)/,
  );
  // Bumped first, then pinned: the floor is the published release.
  assert.match(
    checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 3, agent: { sha: SHA_B }, required: { release: 3, reason: 'Security fix' } })) }),
    /install tuple changed/,
  );
  // A floor that is not changed is not the guard's business.
  const floored = snapshot(manifestOf({ release: 3, required: { release: 2, reason: 'Old fix' } }));
  assert.match(checkReleaseGuard({ base: floored, head: snapshot(manifestOf({ release: 3, required: { release: 2, reason: 'Old fix' } })) }), /release 3 unchanged/);
});


test('the App runtime.lock.json source_commit must be the runtime.sha the manifest pins', () => {
  const SHA_C = 'c'.repeat(40);
  const lockFor = (sha) => Buffer.from(`${JSON.stringify({ source_commit: sha }, null, 2)}\n`);
  assert.match(guard.checkAppRuntimeLock(manifestOf(), lockFor(SHA_B)), /runtime\.sha matches App runtime\.lock\.json source_commit/);
  assert.throws(
    () => guard.checkAppRuntimeLock(manifestOf(), lockFor(SHA_C)),
    { message: `install-manifest.json runtime.sha ${SHA_B} does not match App runtime.lock.json source_commit ${SHA_C}` },
  );
});

test('the pin check refuses a manifest runtime.sha that disagrees with the Agent runtime.lock.json', async () => {
  const SHA_C = 'c'.repeat(40);
  const reader = async (repository, sha, file) => {
    if (file === 'runtime.lock.json') return Buffer.from(JSON.stringify({ source_commit: SHA_C }));
    throw new Error(`unexpected read of ${file}`);
  };
  await assert.rejects(
    () => checkManifest(manifestOf(), reader),
    { message: `install-manifest.json runtime.sha ${SHA_B} does not match agent ${SHA_A} runtime.lock.json source_commit ${SHA_C}` },
  );
});

test('the CLI with --pins refuses a head whose runtime.sha disagrees with the App runtime.lock.json', async (t) => {
  const SHA_C = 'c'.repeat(40);
  const repo = await mkdtemp(path.join(os.tmpdir(), 'release-guard-pins-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const commitState = async (manifest, appLockSha) => {
    const files = {
      'public/install-manifest.json': Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      'runtime.lock.json': Buffer.from(`${JSON.stringify({ source_commit: appLockSha }, null, 2)}\n`),
      ...bootstrapDefaults,
    };
    for (const [file, bytes] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
      await writeFile(path.join(repo, file), bytes);
    }
    git('add', '.');
    git('-c', 'user.name=Release guard test', '-c', 'user.email=release-guard-test@example.invalid', 'commit', '-q', '-m', 'state');
    return git('rev-parse', 'HEAD');
  };

  git('init', '-q', '-b', 'main');
  const base = await commitState(manifestOf(), SHA_B);
  // Release +1 with a moved runtime.sha, but the App lock still names the old Runtime: the tuple passes, the pin does not.
  await commitState(manifestOf({ release: 4, runtime: { sha: SHA_C, schema_digest: DIGEST } }), SHA_B);
  const result = spawnSync(process.execPath, [releaseGuardPath, '--pins', base, 'HEAD'], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(
    result.stderr.includes(`release guard refused: install-manifest.json runtime.sha ${SHA_C} does not match App runtime.lock.json source_commit ${SHA_B}`),
    result.stderr,
  );
});

test('a later push to main never cancels the release guard for an earlier one', async () => {
  const workflow = await readFile(fileURLToPath(new URL('../../.github/workflows/test.yml', import.meta.url)), 'utf8');
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}/);
  assert.doesNotMatch(workflow, /cancel-in-progress: true/);
});

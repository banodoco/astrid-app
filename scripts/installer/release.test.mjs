import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyReleasePin, applyRequiredPin, applyTuplePin, parseArgs } from './pin.mjs';
import { checkReleaseGuard, readSnapshot } from './release-guard.mjs';
import { servedMismatches } from './served-manifest.mjs';
import { validateVersionStarts, versionOf } from './releaseVersion.mjs';

const releaseGuardPath = fileURLToPath(new URL('./release-guard.mjs', import.meta.url));
const pinPath = fileURLToPath(new URL('./pin.mjs', import.meta.url));
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

test('versionOf names 0.0.N by default and counts on from each minor or major start', () => {
  assert.equal(versionOf(10, []), '0.0.10');
  assert.equal(versionOf(10), '0.0.10');
  const starts = [{ release: 15, version: '0.1.0' }];
  assert.equal(versionOf(14, starts), '0.0.14');
  assert.equal(versionOf(15, starts), '0.1.0');
  assert.equal(versionOf(16, starts), '0.1.1');
  const withMajor = [...starts, { release: 30, version: '1.0.0' }];
  assert.equal(versionOf(29, withMajor), '0.1.14');
  assert.equal(versionOf(30, withMajor), '1.0.0');
  assert.equal(versionOf(31, withMajor), '1.0.1');
  assert.throws(() => versionOf(-1, []), /release must be a non-negative integer/);
});

test('validateVersionStarts accepts only the next minor or major after the version in force', () => {
  validateVersionStarts([{ release: 15, version: '0.1.0' }], 16);
  validateVersionStarts([{ release: 15, version: '0.1.0' }, { release: 30, version: '0.2.0' }], 30);
  validateVersionStarts([{ release: 15, version: '0.1.0' }, { release: 30, version: '1.0.0' }], 30);
  validateVersionStarts([{ release: 15, version: '1.0.0' }], 15);
  assert.throws(() => validateVersionStarts([{ release: 15, version: '0.2.0' }], 15), /must be the next minor 0\.1\.0 or the next major 1\.0\.0 after 0\.0\.14/);
  assert.throws(() => validateVersionStarts([{ release: 15, version: '0.1.0' }, { release: 30, version: '0.3.0' }], 30), /next minor 0\.2\.0 or the next major 1\.0\.0 after 0\.1\.14/);
  assert.throws(() => validateVersionStarts([{ release: 15, version: '0.1.1' }], 15), /must be the next minor/);
  assert.throws(() => validateVersionStarts([{ release: 15, version: '0.1.0' }], 14), /exceeds release 14/);
});

test('validateVersionStarts refuses malformed, unordered, duplicate and non-array starts', () => {
  assert.throws(() => validateVersionStarts([{ release: 0, version: '0.1.0' }], 5), /release must be an integer from 1/);
  assert.throws(() => validateVersionStarts([{ release: 15, version: '0.1.0', note: 'x' }], 15), /must have exactly the keys release and version/);
  assert.throws(() => validateVersionStarts([{ release: 15 }], 15), /must have exactly the keys release and version/);
  assert.throws(() => validateVersionStarts([{ release: 15, version: '0.1.0' }, { release: 15, version: '0.2.0' }], 15), /must be above 15/);
  assert.throws(() => validateVersionStarts([{ release: 16, version: '0.1.0' }, { release: 15, version: '0.2.0' }], 16), /must be above 16/);
  assert.throws(() => validateVersionStarts(['0.1.0'], 15), /must be an object/);
  assert.throws(() => validateVersionStarts({ release: 15, version: '0.1.0' }, 15), /must be an array/);
});

test('pin --release moves release by one, adds a start only for minor or major, and --require floors the new release', () => {
  const manifest = manifestOf({ release: 14 });
  applyReleasePin(manifest, 'minor');
  assert.equal(manifest.release, 15);
  assert.deepEqual(manifest.version_starts, [{ release: 15, version: '0.1.0' }]);
  applyRequiredPin(manifest, 'Security fix');
  assert.deepEqual(manifest.required, { release: 15, reason: 'Security fix' });
  applyReleasePin(manifest, undefined);
  assert.equal(manifest.release, 16);
  assert.equal(versionOf(manifest.release, manifest.version_starts), '0.1.1');
  assert.deepEqual(manifest.version_starts, [{ release: 15, version: '0.1.0' }]);
  assert.deepEqual(manifest.required, { release: 15, reason: 'Security fix' });
  applyReleasePin(manifest, 'major');
  assert.equal(manifest.release, 17);
  assert.deepEqual(manifest.version_starts.at(-1), { release: 17, version: '1.0.0' });
  assert.equal(versionOf(manifest.release, manifest.version_starts), '1.0.0');
  assert.throws(() => applyReleasePin(manifestOf(), 'patch'), /kind must be minor or major/);
});

test('plain pinning writes only the install tuple, never release, version_starts or required', () => {
  const starts = [{ release: 15, version: '0.1.0' }];
  const required = { release: 15, reason: 'Security fix' };
  const manifest = manifestOf({ release: 15, version_starts: starts, required });
  applyTuplePin(manifest, { agentSha: SHA_B, runtimeSha: SHA_A, schemaDigest: `sha256:${'e'.repeat(64)}` });
  assert.equal(manifest.agent.sha, SHA_B);
  assert.equal(manifest.runtime.sha, SHA_A);
  assert.equal(manifest.release, 15);
  assert.deepEqual(manifest.version_starts, starts);
  assert.deepEqual(manifest.required, required);
});

test('pin argument parsing refuses --require without --release and accepts the --release forms', () => {
  assert.throws(() => parseArgs([SHA_A, '--require', 'Security fix']), /--require needs --release/);
  assert.throws(() => parseArgs(['--require', 'Security fix']), /--require needs --release/);
  assert.throws(() => parseArgs(['--release', '--require', '--release']), /--require needs one non-empty reason/);
  assert.throws(() => parseArgs([]), /Usage/);
  assert.throws(() => parseArgs(['--release', 'patch']), /Usage/);
  assert.deepEqual(parseArgs(['--release', 'minor', '--require', 'Security fix']), { agentSha: undefined, release: true, kind: 'minor', reason: 'Security fix' });
  assert.deepEqual(parseArgs(['--release']), { agentSha: undefined, release: true, kind: undefined, reason: undefined });
  assert.deepEqual(parseArgs([SHA_A, '--release', 'major']), { agentSha: SHA_A, release: true, kind: 'major', reason: undefined });
  assert.deepEqual(parseArgs([SHA_A]), { agentSha: SHA_A, release: false, kind: undefined, reason: undefined });
  assert.deepEqual(parseArgs(['--check']), { check: true });
});

test('a version start comes with release +1 at its own release, and version_starts is add-only', () => {
  const base = snapshot(manifestOf({ release: 14 }));
  const minor = [{ release: 15, version: '0.1.0' }];
  assert.match(
    checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 15, agent: { sha: SHA_B }, version_starts: minor })) }),
    /install tuple changed .*; release 14 -> 15\. version_starts adds 0\.1\.0 at release 15\./,
  );
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 15, version_starts: minor })) }),
    /release changed from 14 to 15 without an install tuple change/,
  );
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 14, version_starts: minor })) }),
    /exceeds release 14/,
  );
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 15, agent: { sha: SHA_B }, version_starts: [{ release: 14, version: '0.1.0' }] })) }),
    /version_starts adds a start at release 14; a version start must be at the new release 15/,
  );
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 15, agent: { sha: SHA_B }, version_starts: [{ release: 15, version: '0.2.0' }] })) }),
    /must be the next minor 0\.1\.0 or the next major 1\.0\.0 after 0\.0\.14/,
  );
  const withStart = snapshot(manifestOf({ release: 15, version_starts: minor }));
  assert.throws(
    () => checkReleaseGuard({ base: withStart, head: snapshot(manifestOf({ release: 16, agent: { sha: SHA_B }, version_starts: [] })) }),
    /version_starts is add-only; a start in the base was removed or changed/,
  );
  assert.throws(
    () => checkReleaseGuard({ base: withStart, head: snapshot(manifestOf({ release: 16, agent: { sha: SHA_B }, version_starts: [{ release: 15, version: '1.0.0' }] })) }),
    /version_starts is add-only/,
  );
});

test('changing required alone passes the release guard with no release or tuple change', () => {
  const starts = [{ release: 15, version: '0.1.0' }];
  const base = snapshot(manifestOf({ release: 15, version_starts: starts }));
  assert.match(
    checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 15, version_starts: starts, required: { release: 15, reason: 'Security fix' } })) }),
    /install tuple unchanged; release 15 unchanged/,
  );
});

test('an integration PR keeps release, required and version_starts byte-identical; the install tuple may move', () => {
  const base = snapshot(manifestOf({ release: 15 }));
  assert.match(
    checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 15, agent: { sha: SHA_B } })), integration: true }),
    /install tuple changed .* on an integration branch; release 15 unchanged/,
  );
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 16, agent: { sha: SHA_B } })), integration: true }),
    /integration PR changes release; on int\/\*\* release, required and version_starts must stay byte-identical/,
  );
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 15, version_starts: [{ release: 15, version: '0.1.0' }] })), integration: true }),
    /integration PR changes version_starts/,
  );
  assert.throws(
    () => checkReleaseGuard({ base, head: snapshot(manifestOf({ release: 15, required: { release: 15, reason: 'Security fix' } })), integration: true }),
    /integration PR changes required/,
  );
});

test('the CLI --integration flag holds release fixed on an integration PR', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'release-guard-integration-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const commitState = async (manifest) => {
    for (const [file, bytes] of Object.entries({ 'public/install-manifest.json': Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), ...bootstrapDefaults })) {
      await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
      await writeFile(path.join(repo, file), bytes);
    }
    git('add', '.');
    git('-c', 'user.name=Release guard test', '-c', 'user.email=release-guard-test@example.invalid', 'commit', '-q', '-m', 'state');
    return git('rev-parse', 'HEAD');
  };
  const run = (...args) => spawnSync(process.execPath, [releaseGuardPath, ...args], { cwd: repo, encoding: 'utf8' });

  git('init', '-q', '-b', 'main');
  const base = await commitState(manifestOf({ release: 3 }));
  git('reset', '-q', '--hard', base);
  await commitState(manifestOf({ release: 3, agent: { sha: SHA_B } }));
  const tupleOnly = run(base, 'HEAD', '--integration');
  assert.equal(tupleOnly.status, 0, tupleOnly.stderr);
  assert.match(tupleOnly.stdout, /on an integration branch; release 3 unchanged/);

  git('reset', '-q', '--hard', base);
  await commitState(manifestOf({ release: 4, agent: { sha: SHA_B } }));
  const releaseMoved = run(base, 'HEAD', '--integration');
  assert.equal(releaseMoved.status, 1);
  assert.match(releaseMoved.stderr, /release guard refused: integration PR changes release/);
  const releaseMovedOnMain = run(base, 'HEAD');
  assert.equal(releaseMovedOnMain.status, 0, releaseMovedOnMain.stderr);
});

test('pin refuses --require without --release before it touches the manifest or the network', () => {
  const result = spawnSync(process.execPath, [pinPath, '--require', 'Security fix'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--require needs --release/);
});

test('the served canary compares version_starts', () => {
  const starts = [{ release: 4, version: '0.1.0' }];
  const deployed = 'd'.repeat(40);
  assert.deepEqual(
    servedMismatches(served(manifestOf({ release: 4, version_starts: starts })), served(manifestOf({ release: 4 })), deployed),
    [`version_starts: deployed ${deployed} public value ${JSON.stringify(starts)}, served value []`],
  );
});

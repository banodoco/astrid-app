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

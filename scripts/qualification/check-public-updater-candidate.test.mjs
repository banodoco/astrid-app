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

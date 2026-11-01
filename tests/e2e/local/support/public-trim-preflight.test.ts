import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertPublicTrimCompositionPackage, assertPublicTrimRuntimeLock } from './public-trim-preflight.ts';

const lock = JSON.parse(readFileSync(new URL('../../../../runtime.lock.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const sourceCommit = '95bd3c5f6d00e9bc8cc8cbe5ef510b68ed660f3c';
const archive = fileURLToPath(new URL('../../../../vendor/artifacts/banodoco-timeline-composition-0.0.13.tgz', import.meta.url));
const archivePackage = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as Record<string, unknown>;

test('public Trim preflight accepts the full normal Runtime lock', () => {
  assert.doesNotThrow(() => assertPublicTrimRuntimeLock(lock, sourceCommit));
});

test('public Trim preflight rejects a wrong source commit', () => {
  assert.throws(() => assertPublicTrimRuntimeLock({ ...lock, source_commit: '0'.repeat(40) }, sourceCommit));
});

test('public Trim preflight rejects arbitrary lock entries', () => {
  const files = { ...(lock.files as Record<string, unknown>), 'extra/unowned.json': { from: 'extra/unowned.json', sha256: 'sha256:' + '0'.repeat(64) } };
  assert.throws(() => assertPublicTrimRuntimeLock({ ...lock, files }, sourceCommit));
});

test('public Trim preflight accepts the real Composition archive metadata', () => {
  assert.doesNotThrow(() => assertPublicTrimCompositionPackage(archivePackage));
});

test('public Trim preflight rejects a wrong Composition package identity', () => {
  assert.throws(() => assertPublicTrimCompositionPackage({ ...archivePackage, name: '@banodoco/wrong-package' }));
});

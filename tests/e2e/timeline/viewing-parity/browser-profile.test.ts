import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import baseline from '../../../../playwright.viewing-parity.config';
import nativeCodec from '../../../../playwright.viewing-parity.native-codec.config';
import { browserExecutableHash, playerBrowserProfile, verifyPlayerBrowser } from './browser-profile';
import { PLAYER_BROWSER, sourceVersions } from './harness';

test('original config defaults to Chromium 141 and retains all four original cases', () => {
  assert.equal(baseline.projects, undefined);
  assert.equal(baseline.metadata?.viewingParityBrowserProfile, undefined);
  assert.equal(PLAYER_BROWSER, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
  assert.deepEqual(playerBrowserProfile(), {
    profile: 'chromium141', executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    version: '141.0.7390.37', sha256: '85918a9937192b78da8edb51c38a7af4920ac6bd9ba19939ecb0bb724d5a1a95',
  });
  assert.equal(baseline.testMatch, 'player-export-frame-parity.spec.ts');
  assert.equal(baseline.workers, 1);
  assert.equal(baseline.retries, 0);
});

test('Chrome 155 is a separate named environment using the identical four-case suite', () => {
  assert.equal(nativeCodec.projects?.length, 1);
  const project = nativeCodec.projects![0];
  assert.equal(project.name, 'native-codec-chrome155');
  assert.deepEqual(project.metadata, { viewingParityBrowserProfile: 'native-codec-chrome155' });
  assert.deepEqual(playerBrowserProfile(project.metadata!.viewingParityBrowserProfile), {
    profile: 'native-codec-chrome155', executablePath: '/opt/google/chrome/chrome',
    version: '155.0.8059.84', sha256: 'cb19b59995072b86cc7f887b3b1c7ab1f63518a7f2ed9f0d33249e1a040e2c76',
  });
  const { projects: _projects, ...shared } = nativeCodec;
  assert.deepEqual(shared, baseline);
  assert.notDeepEqual(playerBrowserProfile(), playerBrowserProfile(project.metadata!.viewingParityBrowserProfile));
});

test('unknown profiles refuse before source reads or browser launch, without a fallback', async () => {
  for (const profile of ['', 'chrome', '/opt/google/chrome/chrome', 'toString', '__proto__', null, 155, {}]) {
    assert.throws(() => playerBrowserProfile(profile), /unsupported viewing parity browser profile/);
    await assert.rejects(verifyPlayerBrowser(profile), /unsupported viewing parity browser profile/);
    await assert.rejects(sourceVersions(profile), /unsupported viewing parity browser profile/);
  }
});

test('executable hash covers the full file including bytes past the first chunk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viewing-browser-bytes-'));
  try {
    const path = join(root, 'browser');
    const bytes = Buffer.alloc(1024 * 1024 + 7, 1);
    await writeFile(path, bytes);
    const original = await browserExecutableHash(path);
    assert.equal(original, createHash('sha256').update(bytes).digest('hex'));
    bytes[bytes.length - 1] = 2;
    await writeFile(path, bytes);
    assert.notEqual(await browserExecutableHash(path), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

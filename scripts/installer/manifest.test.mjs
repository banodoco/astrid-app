import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { repo } from './fixture.mjs';

test('every production manifest download has its own exact SHA256 digest', async () => {
  const manifest = JSON.parse(await readFile(path.join(repo, 'public/install-manifest.json'), 'utf8'));
  for (const [tool, pin] of Object.entries(manifest.tools)) {
    for (const [platform, asset] of Object.entries(pin.assets || {})) {
      const label = `${tool}/${platform}`;
      const urls = asset.urls || [asset.url];
      const hashes = asset.urls ? asset.sha256 : [asset.sha256];
      assert.ok(Array.isArray(hashes), `${label} needs one digest per URL`);
      assert.equal(hashes.length, urls.length, `${label} digest count`);
      for (const [index, url] of urls.entries()) {
        assert.equal(new URL(url).protocol, 'https:', `${label} must use HTTPS`);
        assert.match(hashes[index], /^[0-9a-f]{64}$/, `${label} checksum ${index}`);
        assert.notEqual(hashes[index], '0'.repeat(64), `${label} placeholder digest`);
      }
    }
  }
});

test('both bootstraps agree with the manifest uv and Python pins', async () => {
  const manifest = JSON.parse(await readFile(path.join(repo, 'public/install-manifest.json'), 'utf8'));
  const posix = await readFile(path.join(repo, 'public/install'), 'utf8');
  const powershell = await readFile(path.join(repo, 'public/install.ps1'), 'utf8');
  assert.equal(posix.match(/^UV_VERSION=(\S+)$/m)?.[1], manifest.tools.uv.version);
  assert.equal(posix.match(/^PYTHON_VERSION=(\S+)$/m)?.[1], manifest.tools.python.version);
  assert.equal(powershell.match(/\$UvVersion = '([^']+)'/)?.[1], manifest.tools.uv.version);
  assert.equal(powershell.match(/\$PythonVersion = '([^']+)'/)?.[1], manifest.tools.python.version);
});

test('manifest pins its agent Runtime and schema digest', () => {
  const result = spawnSync(process.execPath, [path.join(repo, 'scripts/installer/pin.mjs'), '--check'], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('--check refuses a manifest whose lifecycle block is missing', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pin-check-'));
  await mkdir(path.join(dir, 'public'));
  const manifest = JSON.parse(await readFile(path.join(repo, 'public/install-manifest.json'), 'utf8'));
  delete manifest.lifecycle;
  await writeFile(path.join(dir, 'public/install-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const result = spawnSync(process.execPath, [path.join(repo, 'scripts/installer/pin.mjs'), '--check'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /missing the lifecycle block/);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { agentVibecomfyPin } from './vibecomfy-pin.mjs';
import { checkManifest } from './pin.mjs';
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

test('Agent recipe and pins bind the manifest VibeComfy identity and reject invalid identities', async () => {
  const revision = 'c'.repeat(40);
  const repository = 'https://github.com/banodoco/VibeComfy.git';
  const files = new Map();
  const put = (file, object) => {
    const bytes = Buffer.from(JSON.stringify(object));
    files.set('astrid/' + file, bytes);
    return { path: file, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const pins = { schema: 'astrid.engine-pins.v1', sources: { vibecomfy: { repository, revision } } };
  const pinsRef = put('packs/runpod/pins.json', pins);
  put('packs/vibecomfy/pins.json', pins);
  const recipeRef = put('packs/vibecomfy/recipe.json', { schema: 'astrid.engine-recipe.v1', engine: 'vibecomfy', platform: 'windows-x86_64-cu130', pins: pinsRef, source_bindings: [{ name: 'vibecomfy', pin: 'vibecomfy' }] });
  put('packs/engine-index.json', { schema: 'astrid.engine-index.v1', entries: [{ engine: 'vibecomfy', platform: 'windows-x86_64-cu130', recipe: recipeRef }] });
  const read = async (file) => {
    if (!files.has(file)) throw new Error('missing ' + file);
    return files.get(file);
  };
  assert.deepEqual(await agentVibecomfyPin(read), { sha: revision });
  const base = files.get('astrid/packs/vibecomfy/pins.json');
  for (const source of [undefined, { repository, revision: 'b'.repeat(40) }, { repository: 'https://example.com/foreign.git', revision }]) {
    put('packs/vibecomfy/pins.json', { schema: 'astrid.engine-pins.v1', sources: source ? { vibecomfy: source } : {} });
    await assert.rejects(agentVibecomfyPin(read), /missing, mismatched, or foreign/);
  }
  files.set('astrid/packs/vibecomfy/pins.json', base);
  const bound = files.get('astrid/packs/runpod/pins.json');
  files.set('astrid/packs/runpod/pins.json', Buffer.concat([bound, Buffer.from(' ')]));
  await assert.rejects(agentVibecomfyPin(read), /digest mismatch/);
  files.set('astrid/packs/runpod/pins.json', bound);

  const runtime = 'a'.repeat(40);
  const openapi = Buffer.from('test schema');
  const name = Buffer.from('contract/openapi.json');
  const nameLength = Buffer.alloc(4); nameLength.writeUInt32BE(name.length);
  const dataLength = Buffer.alloc(8); dataLength.writeBigUInt64BE(BigInt(openapi.length));
  const schemaDigest = 'sha256:' + createHash('sha256').update(nameLength).update(name).update(dataLength).update(openapi).digest('hex');
  const agent = 'e'.repeat(40);
  const raw = new Map([...files].map(([file, bytes]) => [`banodoco/astrid-agent/${agent}/${file}`, bytes]));
  raw.set(`banodoco/astrid-agent/${agent}/runtime.lock.json`, Buffer.from(JSON.stringify({ source_commit: runtime })));
  raw.set(`banodoco/astrid-runtime/${runtime}/contract/manifest.json`, Buffer.from(JSON.stringify({ openapi: 'openapi.json', schemas: [] })));
  raw.set(`banodoco/astrid-runtime/${runtime}/contract/openapi.json`, openapi);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const bytes = raw.get(url.replace('https://raw.githubusercontent.com/', ''));
    return bytes ? new Response(bytes) : new Response(null, { status: 404 });
  };
  try {
    const manifest = { agent: { sha: agent }, runtime: { sha: runtime, schema_digest: schemaDigest }, vibecomfy: { sha: revision } };
    await checkManifest(manifest);
    for (const vibecomfy of [undefined, { sha: 'b'.repeat(40) }, { sha: revision, repo: 'https://example.com/foreign.git' }]) {
      await assert.rejects(checkManifest({ ...manifest, vibecomfy }), /vibecomfy identity/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

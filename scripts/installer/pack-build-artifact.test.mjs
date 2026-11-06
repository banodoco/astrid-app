import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { emitPackBuildArtifact, measureAppRelease } from './pack-build-artifact.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const dist = mkdtempSync(path.join(os.tmpdir(), 'pack-build-artifact-'));
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, 'index.html'), '<html>release</html>');
  const asset = 'export const real = true;';
  writeFileSync(path.join(dist, 'assets', 'react.js'), asset);
  writeFileSync(path.join(dist, 'extension-shared-modules.json'), JSON.stringify({ version: 1, shared_modules: Object.fromEntries(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'remotion', '@astrid/editor-sdk'].map(name => [name, { url: '/assets/react.js', sha256: sha(asset), version: '18.3.1' }])) }));
  writeFileSync(path.join(dist, 'install-manifest.json'), JSON.stringify({ release: 3, node: { version: '20.19.4' } }));
  return dist;
}

test('binds emitted shared lock to measured served build without circular manifest hash', () => {
  const dist = fixture();
  const expected = measureAppRelease(dist);
  const record = emitPackBuildArtifact({ dist, origin: 'https://astrid.haus' });
  const manifest = JSON.parse(readFileSync(path.join(dist, 'install-manifest.json')));
  assert.equal(record.app_release_sha256, expected);
  assert.deepEqual(manifest.pack_build, record);
  assert.equal(manifest.node.version, '20.19.4');
  assert.equal(record.esbuild_version, '0.27.7');
  assert.equal(record.shared_modules.url, `https://astrid.haus/pack-build/${record.shared_modules.sha256}.json`);
  assert.equal(sha(readFileSync(path.join(dist, 'pack-build', `${record.shared_modules.sha256}.json`))), record.shared_modules.sha256);
  assert.equal(measureAppRelease(dist), expected);
  writeFileSync(path.join(dist, 'index.html'), '<html>changed</html>');
  assert.notEqual(measureAppRelease(dist), expected);
});

test('refuses mismatched assets and unsafe artifact origins', () => {
  const dist = fixture();
  writeFileSync(path.join(dist, 'assets', 'react.js'), 'changed');
  assert.throws(() => emitPackBuildArtifact({ dist, origin: 'https://astrid.haus' }), /digest mismatch/);
  assert.throws(() => emitPackBuildArtifact({ dist, origin: 'http://astrid.haus' }), /HTTPS origin/);
});

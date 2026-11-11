#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Local: node scripts/onboarding/verify-assets.mjs [public|dist]
// Deployed: node scripts/onboarding/verify-assets.mjs https://astrid.haus/
const target = process.argv[2] ?? 'public';
const remote = /^https?:\/\//.test(target);
const prefix = 'astrid/onboarding/lantern-valley-14s-v1/';
async function read(name) {
  if (!remote) return readFile(resolve(target, prefix, name));
  const response = await fetch(new URL(`${prefix}${name}`, target.endsWith('/') ? target : `${target}/`), { credentials: 'omit' });
  assert.equal(response.status, 200, `${name}: anonymous HTTP status`);
  return Buffer.from(await response.arrayBuffer());
}
const manifest = JSON.parse(await read('manifest.json'));
const source = JSON.parse(await readFile(new URL('../../src/tools/video-editor/tour/asset-manifest.json', import.meta.url)));
assert.deepEqual(manifest, source, 'distributed and source manifests agree');
assert.equal(manifest.version, 'lantern-valley-14s-v1');
assert.deepEqual(manifest.anchorTimes, [0, 6.5, 10, 13]);
assert.equal(manifest.anchorCaptureTimes[3], 419 / 30);
const results = [];
for (const [name, asset] of Object.entries(manifest.assets)) {
  assert.match(asset.filename, /^[a-f0-9]{64}\.(png|mp4|json|webp)$/);
  assert.ok(asset.filename.startsWith(asset.sha256), `${name}: named by its SHA-256`);
  // A playback derivative (scripts/onboarding/build-derivatives.mjs) names the original it was made from.
  if (asset.derivedFrom) assert.ok(manifest.assets[asset.derivedFrom] && !manifest.assets[asset.derivedFrom].derivedFrom, `${name}: derivedFrom names an original`);
  const bytes = await read(asset.filename);
  assert.equal(bytes.length, asset.size, `${name}: byte length`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, `${name}: SHA-256`);
  if (name === 'world') {
    const world = JSON.parse(bytes);
    assert.deepEqual(world.assets, []);
    assert.equal(world.entry.object_id, undefined, 'no runtime object identity');
    assert.equal(createHash('sha256').update(world.html).digest('hex'), world.entry.digest.slice(7));
    assert.match(world.html, /window\.astridScene/);
    assert.doesNotMatch(world.html, /localhost|127\.0\.0\.1|\/Users\/|\/tmp\/|(?:src|href)=["']https?:/);
  }
  results.push({ name, size: bytes.length, sha256: asset.sha256 });
}
console.log(JSON.stringify({ verified: true, target, assetCount: results.length, totalBytes: results.reduce((n, a) => n + a.size, 0), assets: results }, null, 2));

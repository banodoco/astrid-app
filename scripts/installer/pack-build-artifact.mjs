#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = (data) => createHash('sha256').update(data).digest('hex');

// Hash path-framed served bytes, excluding the manifest that carries this hash
// and the content-addressed copy itself, so the measurement is not circular.
export function measureAppRelease(dist) {
  const files = [];
  function visit(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (rel === 'install-manifest.json' || rel === 'pack-build') continue;
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`Symlink in App build: ${rel}`);
      if (stat.isDirectory()) visit(full, rel);
      else if (stat.isFile()) files.push([rel, readFileSync(full)]);
      else throw new Error(`Non-file in App build: ${rel}`);
    }
  }
  visit(dist);
  if (!files.some(([name]) => name === 'index.html')) throw new Error('App build has no index.html');
  const hash = createHash('sha256');
  for (const [name, bytes] of files) {
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export function emitPackBuildArtifact({ dist, origin }) {
  const packageLock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (packageLock.packages?.['node_modules/esbuild']?.version !== '0.27.7') {
    throw new Error('App package lock must pin esbuild 0.27.7');
  }
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('App release origin must be an HTTPS origin');
  }
  const lockBytes = readFileSync(path.join(dist, 'extension-shared-modules.json'));
  const lock = JSON.parse(lockBytes);
  const expected = ['@astrid/editor-sdk', 'react', 'react-dom/client', 'react/jsx-dev-runtime', 'react/jsx-runtime', 'remotion'];
  if (lock.version !== 1 || !lock.shared_modules ||
      JSON.stringify(Object.keys(lock.shared_modules).sort()) !== JSON.stringify(expected.sort())) {
    throw new Error('Invalid emitted shared-module lock');
  }
  for (const binding of Object.values(lock.shared_modules)) {
    if (typeof binding.url !== 'string' || !/^\/assets\/[A-Za-z0-9_.-]+$/.test(binding.url) || !/^[a-f0-9]{64}$/.test(binding.sha256)) {
      throw new Error('Invalid shared-module binding');
    }
    if (digest(readFileSync(path.join(dist, binding.url.slice(1)))) !== binding.sha256) {
      throw new Error(`Shared-module asset digest mismatch: ${binding.url}`);
    }
  }
  const appReleaseSha = measureAppRelease(dist);
  const lockSha = digest(lockBytes);
  const artifact = `pack-build/${lockSha}.json`;
  const manifestPath = path.join(dist, 'install-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.pack_build = {
    version: 1,
    esbuild_version: '0.27.7',
    app_release_sha256: appReleaseSha,
    shared_modules: { url: new URL(`/${artifact}`, base).href, sha256: lockSha },
  };
  mkdirSync(path.join(dist, 'pack-build'), { recursive: true });
  writeFileSync(path.join(dist, artifact), lockBytes);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.pack_build;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dist = path.resolve(process.argv[2] || path.join(root, 'dist'));
  const { origin } = JSON.parse(readFileSync(path.join(root, 'config/hosted-origin.json'), 'utf8'));
  console.log(JSON.stringify(emitPackBuildArtifact({ dist, origin })));
}

#!/usr/bin/env node
// Produce an unpublished candidate from a separately planned checkpoint manifest.
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyReleasePin } from './pin.mjs';
import { checkManifestRelease } from './release-check.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [input, output, baseRef, ...extra] = process.argv.slice(2);
try {
  if (!input || !output || !baseRef || extra.length || !path.isAbsolute(output)) {
    throw new Error('Usage: node scripts/installer/freeze-candidate.mjs <planned-manifest> <absolute-new-output> <published-main-commit>');
  }
  if (!/^[0-9a-f]{40}$/.test(baseRef)) throw new Error('published main must be an immutable full commit SHA');
  const parent = await realpath(path.dirname(output));
  const relative = path.relative(await realpath(repo), parent);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) throw new Error('output must be outside the App checkout');
  const manifest = JSON.parse(await readFile(input, 'utf8'));
  applyReleasePin(manifest);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  console.log(await checkManifestRelease({ repo, baseRef, candidateBytes: bytes }));
  console.log(await checkManifestRelease({ repo, baseRef, publishedBaselineRef: baseRef, candidateMode: true, candidateBytes: bytes }));
  await writeFile(path.join(parent, path.basename(output)), bytes, { flag: 'wx' });
  console.log(`Unpublished candidate written to ${output}; release ${manifest.release}.`);
} catch (error) {
  console.error(`freeze candidate refused: ${error.message}`);
  process.exitCode = 1;
}

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function verifyBuildIdentity(expected, buildFile) {
  const build = JSON.parse(readFileSync(buildFile, 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(expected) || build.app !== expected) {
    throw new Error('Hosted build identity does not match the exact App commit');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyBuildIdentity(process.argv[2], process.argv[3]);
}

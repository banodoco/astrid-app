// Version names for the install manifest. `release` is the only ordering key; a version is
// a name worked out from it. Without a start a release is 0.0.N. Each owner-declared start
// (a minor or major step) sets the name at its release and then counts on from there:
// versionOf(15, [{ release: 15, version: "0.1.0" }]) is "0.1.0", and 16 is "0.1.1".
//
// `version_starts` sits outside the install tuple. It is add-only and only `pin.mjs --release`
// appends to it; release-guard checks the rules below on every change.

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const KINDS = ['minor', 'major'];

export function parseVersion(text, label = 'version') {
  const match = typeof text === 'string' ? VERSION.exec(text) : null;
  if (!match) throw new Error(`${label} must be major.minor.patch, got ${JSON.stringify(text)}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function releaseNumber(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

// The start in force at `release` is the one with the largest start.release that is not above it.
function startInForce(release, versionStarts) {
  let current;
  for (const start of versionStarts) {
    if (start.release <= release && (!current || start.release > current.release)) current = start;
  }
  return current;
}

export function versionOf(release, versionStarts = []) {
  releaseNumber(release, 'release');
  const start = startInForce(release, versionStarts);
  if (!start) return `0.0.${release}`;
  const base = parseVersion(start.version, 'version_starts version');
  return `${base.major}.${base.minor}.${base.patch + release - start.release}`;
}

function stepFrom(previous, kind) {
  if (kind === 'minor') return `${previous.major}.${previous.minor + 1}.0`;
  if (kind === 'major') return `${previous.major + 1}.0.0`;
  throw new Error(`version kind must be one of ${KINDS.join(', ')}`);
}

// Validates the whole list against the manifest release. Each start must be the next minor or
// the next major after the version in force at the release before it.
export function validateVersionStarts(versionStarts, release, label = 'version_starts') {
  releaseNumber(release, 'release');
  if (versionStarts === undefined) return;
  if (!Array.isArray(versionStarts)) throw new Error(`${label} must be an array`);
  let previousRelease = 0;
  versionStarts.forEach((start, index) => {
    const at = `${label}[${index}]`;
    if (!start || typeof start !== 'object' || Array.isArray(start)) throw new Error(`${at} must be an object`);
    const keys = Object.keys(start).sort();
    if (keys.length !== 2 || keys[0] !== 'release' || keys[1] !== 'version') {
      throw new Error(`${at} must have exactly the keys release and version`);
    }
    if (!Number.isSafeInteger(start.release) || start.release < 1) throw new Error(`${at}.release must be an integer from 1`);
    if (start.release <= previousRelease) throw new Error(`${at}.release ${start.release} must be above ${previousRelease}; starts are ordered and unique`);
    if (start.release > release) throw new Error(`${at}.release ${start.release} exceeds release ${release}`);
    const before = versionOf(start.release - 1, versionStarts.slice(0, index));
    const previous = parseVersion(before, 'version in force');
    const minor = stepFrom(previous, 'minor');
    const major = stepFrom(previous, 'major');
    if (start.version !== minor && start.version !== major) {
      throw new Error(`${at}.version ${JSON.stringify(start.version)} must be the next minor ${minor} or the next major ${major} after ${before}`);
    }
    previousRelease = start.release;
  });
}

// The start that `pin.mjs --release <kind>` appends for the new release. The version it names is
// the next step after the version in force at the release before it.
export function nextVersionStart(release, kind, versionStarts = []) {
  releaseNumber(release, 'release');
  const previous = parseVersion(versionOf(release - 1, versionStarts), 'version in force');
  return { release, version: stepFrom(previous, kind) };
}

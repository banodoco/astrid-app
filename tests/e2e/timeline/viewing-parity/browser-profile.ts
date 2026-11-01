import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

export const PLAYER_BROWSER_PROFILES = {
  chromium141: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    version: '141.0.7390.37',
    sha256: '85918a9937192b78da8edb51c38a7af4920ac6bd9ba19939ecb0bb724d5a1a95',
  },
  'native-codec-chrome155': {
    executablePath: '/opt/google/chrome/chrome',
    version: '155.0.8059.84',
    sha256: 'cb19b59995072b86cc7f887b3b1c7ab1f63518a7f2ed9f0d33249e1a040e2c76',
  },
} as const;

export function playerBrowserProfile(name: unknown = 'chromium141'): {
  profile: keyof typeof PLAYER_BROWSER_PROFILES; executablePath: string; version: string; sha256: string;
} {
  if (typeof name !== 'string' || !Object.hasOwn(PLAYER_BROWSER_PROFILES, name)) {
    throw new Error(`unsupported viewing parity browser profile: ${String(name)}`);
  }
  const profile = name as keyof typeof PLAYER_BROWSER_PROFILES;
  return { profile, ...PLAYER_BROWSER_PROFILES[profile] };
}

/** Read every executable byte without starting a browser or learning a new pin. */
export async function browserExecutableHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyPlayerBrowser(name?: unknown) {
  const browser = playerBrowserProfile(name);
  assert.equal(await browserExecutableHash(browser.executablePath), browser.sha256,
    `selected Player browser bytes changed: ${browser.profile}`);
  return browser;
}

export type BrowserEntryOwner = 'public' | 'app';

/** Public pages served by the dedicated public entry in every build. */
const PUBLIC_PAGE_PATHS = new Set(['/', '/home', '/vision']);

export function classifyBrowserEntry(
  url: URL,
): BrowserEntryOwner {
  if (PUBLIC_PAGE_PATHS.has(url.pathname)) {
    return 'public';
  }
  return 'app';
}

/**
 * Where a returning visitor lands once they have chosen the app over the landing page: the editor.
 * Other app routes send anyone without a signed-in session back to /home, so they would bounce
 * straight back here. The bare route lets the editor pick the last-opened (or newest) project from
 * the Runtime it is connected to. Every build talks to a real Runtime; only the fake-Runtime dev and
 * test harness has no real projects, and its one project is the demo, so the editor picks that too.
 */
export const APP_ENTRY_PATH = '/tools/video-editor';

/** Installer links arrive on the public root, but `?connect=1` must reach the app's Runtime gate. */
export function resolveInstallerConnectEntry(url: URL): string | null {
  if (url.pathname !== '/' || url.searchParams.get('connect') !== '1') return null;
  const target = new URL(APP_ENTRY_PATH, url.origin);
  const incomingKeys = new Set(url.searchParams.keys());
  for (const key of incomingKeys) target.searchParams.delete(key);
  url.searchParams.forEach((value, key) => target.searchParams.append(key, value));
  return `${target.pathname}${target.search}${url.hash}`;
}
const APP_ENTRY_PREFERENCE_KEY = 'astrid:prefers-app';

/** Remember that this browser chose the app (installed it, or asked to use it here). */
export function rememberAppEntryPreference(): void {
  try {
    localStorage.setItem(APP_ENTRY_PREFERENCE_KEY, '1');
  } catch {
    // Storage can be unavailable (private windows, blocked site data); the landing page still works.
  }
}

export function isRunningInstalled(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: fullscreen)').matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

export function prefersAppEntry(): boolean {
  if (isRunningInstalled()) return true;
  try {
    return localStorage.getItem(APP_ENTRY_PREFERENCE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Installing from the browser doesn't open the app at its start page: Chrome moves the tab being viewed
 * (usually the landing page) into the new app window, with no reload. When a public page finds itself
 * running as the installed app this way, it hands over to the editor.
 */
export function followIntoInstalledApp(): void {
  let query: MediaQueryList;
  try {
    query = window.matchMedia('(display-mode: standalone)');
  } catch {
    return;
  }
  query.addEventListener('change', () => {
    if (!isRunningInstalled()) return;
    rememberAppEntryPreference();
    window.location.replace(`${APP_ENTRY_PATH}${window.location.search}${window.location.hash}`);
  });
}

/**
 * Once someone has installed Astrid or chosen to use it in the browser, the site root opens the app
 * instead of the landing page. /home always shows the landing page.
 */
export function resolveReturningAppEntry(url: URL, prefersApp: boolean): string | null {
  if (!prefersApp || url.pathname !== '/') return null;
  return `${APP_ENTRY_PATH}${url.search}${url.hash}`;
}

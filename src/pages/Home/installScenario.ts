import {
  detectBrowser,
  detectDeviceType,
  detectPlatform,
  isDesktopPlatform,
} from '@/shared/hooks/platformInstall/platformDetection';

/** Which explainer to show: Chrome and Edge install, other desktop browsers can't, and phones can't yet. */
export type InstallScenario = 'chromium' | 'unsupported' | 'mobile';

/** A touch screen this narrow (its short side, in CSS pixels) is a phone, not a touchscreen laptop or a Windows tablet. */
const TOUCH_ONLY_PHONE_MAX_SHORT_SIDE = 600;

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/**
 * A phone that sends a desktop user agent. Only its input gives it away: a touch screen whose primary pointer is coarse,
 * that cannot hover, and with no fine pointer of any kind (a touchscreen laptop has a touchpad, so it is never this).
 * Android Chrome's "Desktop site" sends a Linux UA and is caught on those signals alone; any other desktop UA must also be
 * phone-sized. (iOS's desktop mode is caught earlier, by `detectPlatform`.)
 */
function isTouchOnlyPhone(platform: string): boolean {
  if (typeof navigator === 'undefined' || navigator.maxTouchPoints < 1) return false;
  if (!matches('(pointer: coarse)') || !matches('(hover: none)') || matches('(any-pointer: fine)') || matches('(any-hover: hover)')) return false;
  if (platform === 'linux') return true;
  return typeof screen !== 'undefined' && Math.min(screen.width, screen.height) <= TOUCH_ONLY_PHONE_MAX_SHORT_SIDE;
}

export function detectInstallScenario(): InstallScenario {
  const platform = detectPlatform();
  const browser = detectBrowser();
  if (detectDeviceType(platform) !== 'desktop' || isTouchOnlyPhone(platform)) return 'mobile';
  if (!isDesktopPlatform(platform)) return 'unsupported';
  if (browser === 'chrome' || browser === 'edge') return 'chromium';
  return 'unsupported';
}

/**
 * Whether this device can't run Astrid (a phone or tablet): the landing page's install dialog and the hosted build's
 * connection gate both ask, so the two always agree on who gets "Desktop only, for now".
 */
export function isMobileDevice(): boolean {
  return detectInstallScenario() === 'mobile';
}

/**
 * The name the connection cards give the person's browser ("Choose Allow in Edge"). The local-network prompt is a
 * Chromium one, so Edge is named as Edge and every other browser as Chrome.
 */
export function installBrowserName(): 'Chrome' | 'Edge' {
  return detectBrowser() === 'edge' ? 'Edge' : 'Chrome';
}

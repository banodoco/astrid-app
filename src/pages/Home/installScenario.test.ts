import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectInstallScenario } from './installScenario.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const ANDROID_DESKTOP_SITE = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IPAD_DESKTOP_SITE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const LINUX_DESKTOP = ANDROID_DESKTOP_SITE;

function device(platform: string, userAgent: string, maxTouchPoints = 0, coarse = false) {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: coarse && (query === '(pointer: coarse)' || query === '(hover: none)'), media: query }));
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('detectInstallScenario', () => {
  it.each([
    ['iPhone Safari (also an in-app browser)', 'iPhone', IPHONE, 5, true],
    ['Android Chrome', 'Linux armv81', ANDROID, 5, true],
    ['iPad, desktop user agent', 'MacIntel', IPAD_DESKTOP_SITE, 5, true],
    ['Android Chrome with "Desktop site"', 'Linux armv81', ANDROID_DESKTOP_SITE, 5, true],
  ])('%s is mobile', (_name, platform, ua, touch, coarse) => {
    device(platform, ua, touch, coarse);
    expect(detectInstallScenario()).toBe('mobile');
  });

  it('keeps a Linux desktop (fine pointer, even with a touch screen) a desktop', () => {
    device('Linux x86_64', LINUX_DESKTOP, 10, false);
    expect(detectInstallScenario()).toBe('chromium');
  });
});

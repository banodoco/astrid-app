import type { MouseEvent as ReactMouseEvent } from 'react';

export const GITHUB_URL = 'https://github.com/banodoco/astrid-dev';
export const REPOSITORY_URL = 'https://github.com/banodoco/astrid-app';
export const DISCORD_URL = 'https://discord.gg/D5K2c6kfhy';
export const X_URL = 'https://x.com/astrid_ivi';

/** Vision & Issues, shown in place over the home page (see PublicAstridSite.tsx). */
export const VISION_PATH = '/vision';

/** Follows a link in place for a plain click; modified clicks (new tab, new window) keep the browser's own handling. */
export function followInPage(event: ReactMouseEvent<HTMLAnchorElement>, go?: () => void) {
  if (!go || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  go();
}

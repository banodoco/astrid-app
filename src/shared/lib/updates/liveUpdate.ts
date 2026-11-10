/**
 * Notices, on an open page, that Astrid was updated: the Runtime instance changed and its installed release went up.
 * The last release this tab saw is kept in sessionStorage, so the result is still shown after the page reloads itself
 * onto the restarted Astrid. Storage can be unavailable (private windows, previews); then only the live case is seen.
 */

/** How long "Astrid updated: Release N → Release M" stays before the normal up-to-date state. */
export const UPDATED_NOTICE_MS = 8000;

const SEEN_KEY = 'astrid.update.seen';
const UPDATED_KEY = 'astrid.update.updated';

export interface UpdatedTransition {
  readonly from: number;
  readonly to: number;
  /** Epoch ms after which the transition is no longer shown. */
  readonly until: number;
}

function read<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* A per-tab convenience only. */ }
}

const isRelease = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Record the release one Runtime instance reports. Returns the transition when a different instance now reports a
 * higher release than this tab last saw, else null.
 */
export function noteRelease(instance: string | undefined, release: number, now = Date.now()): UpdatedTransition | null {
  if (!instance || !isRelease(release)) return null;
  const seen = read<{ instance?: unknown; release?: unknown }>(SEEN_KEY);
  write(SEEN_KEY, { instance, release });
  if (!seen || typeof seen.instance !== 'string' || !isRelease(seen.release)) return null;
  if (seen.instance === instance || release <= seen.release) return null;
  const transition = { from: seen.release, to: release, until: now + UPDATED_NOTICE_MS };
  write(UPDATED_KEY, transition);
  return transition;
}

/** A transition recorded before this page reloaded itself, while it is still to be shown. */
export function activeTransition(now = Date.now()): UpdatedTransition | null {
  const value = read<Partial<UpdatedTransition>>(UPDATED_KEY);
  if (!value || !isRelease(value.from) || !isRelease(value.to) || typeof value.until !== 'number' || value.until <= now) return null;
  return { from: value.from, to: value.to, until: value.until };
}

export function updatedLine(transition: Pick<UpdatedTransition, 'from' | 'to'>): string {
  return `Astrid updated: Release ${transition.from} → Release ${transition.to}`;
}

/** Test pages start with an empty tab. */
export function resetLiveUpdateForTest(): void {
  try {
    window.sessionStorage.removeItem(SEEN_KEY);
    window.sessionStorage.removeItem(UPDATED_KEY);
  } catch { /* ignore */ }
}

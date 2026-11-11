import { APP_ENTRY_PATH } from '@/app/entryClassification.ts';

export const WELCOME_PROGRESS_KEY = 'astrid:welcome-v1';
const SETUP_DESTINATION_KEY = 'astrid:welcome-setup-destination';
const RUN_MODE_KEY = 'astrid:welcome-run-mode-v1';
export type WelcomeRunMode = 'hosted' | 'local';
/** `setup` (the old bare "Set up Astrid" page) is retired: a stored one migrates on read (see `readWelcomePhase`). */
export type WelcomePhase = 'tour' | 'choose' | 'connection' | 'local' | 'complete';
export type WelcomeEntry = WelcomePhase | 'editor';
const LEGACY_KEYS = [
  'astrid.runtime.connectedBefore',
  'astrid-setup-complete',
  'astrid-editor-tour-v1',
  'astrid:lastOpenedLocalProjectSlug',
] as const;
let memoryPhase: WelcomePhase | null = null;

/**
 * Fill in the durable record once for an existing browser profile. A stored `setup` (the retired setup page) becomes
 * `local` where that page led to local setup (a local build, or the local run mode) and `connection` everywhere else,
 * and the record is rewritten so the next read is plain.
 */
export function readWelcomePhase(localBuild = false): WelcomePhase | null {
  try {
    const value = localStorage.getItem(WELCOME_PROGRESS_KEY);
    if (value === 'setup') {
      const migrated: WelcomePhase = localBuild || readWelcomeRunMode() === 'local' ? 'local' : 'connection';
      localStorage.setItem(WELCOME_PROGRESS_KEY, migrated);
      memoryPhase = migrated;
      return migrated;
    }
    if (value === 'tour' || value === 'choose' || value === 'connection' || value === 'local' || value === 'complete') return value;
    if (value !== null) return null;
    const returning = LEGACY_KEYS.some(key => localStorage.getItem(key) !== null);
    if (returning) {
      localStorage.setItem(WELCOME_PROGRESS_KEY, 'complete');
      memoryPhase = 'complete';
      return 'complete';
    }
    return memoryPhase;
  } catch { return memoryPhase; }
}

export function writeWelcomePhase(phase: WelcomePhase | null): void {
  memoryPhase = phase;
  try {
    if (phase === null) localStorage.removeItem(WELCOME_PROGRESS_KEY);
    else localStorage.setItem(WELCOME_PROGRESS_KEY, phase);
  } catch { /* This visit still progresses. */ }
}

export function hasRememberedConnection(): boolean {
  try { return localStorage.getItem('astrid.runtime.connectedBefore') !== null; }
  catch { return false; }
}

export function readWelcomeRunMode(): WelcomeRunMode | null {
  try { const value = localStorage.getItem(RUN_MODE_KEY); return value === 'hosted' || value === 'local' ? value : null; }
  catch { return null; }
}

export function writeWelcomeRunMode(mode: WelcomeRunMode): void {
  try { localStorage.setItem(RUN_MODE_KEY, mode); } catch { /* This visit still progresses. */ }
}

/** Preserve the one-time setup completion across the destination reload when localStorage is unavailable. */
export function rememberSetupDestination(url: URL): void {
  try {
    const current = window.history.state;
    const state = current && typeof current === 'object' ? current as Record<string, unknown> : {};
    window.history.replaceState({ ...state, [SETUP_DESTINATION_KEY]: `${url.pathname}${url.search}${url.hash}` }, '');
  } catch { /* Session progress remains the fallback. */ }
}

const WORK_LINK_KEYS = ['project', 'timeline', 'localProject', 'localTimeline'] as const;

/** A link to work (a project or timeline, or the tour's explicit Open editor): its destination always wins over onboarding. */
export function isWorkLink(url: URL): boolean {
  return url.searchParams.get('entry') === 'editor' || WORK_LINK_KEYS.some(key => url.searchParams.has(key));
}

/**
 * Pick the only owner for this URL and phase. Work links take precedence over onboarding: they open the editor, whose
 * own Runtime gate connects (or, on a phone, says to open the link on a computer) and then loads the destination. Seeing
 * one marks welcome complete, as continuing past the old setup page did, so the link is never answered with the demo.
 */
export function entryFor(url: URL, phase: WelcomePhase | null, localBuild = false): WelcomeEntry {
  if (url.pathname !== APP_ENTRY_PATH) return 'editor';
  try {
    const current = window.history.state;
    if (current && typeof current === 'object' && (current as Record<string, unknown>)[SETUP_DESTINATION_KEY] === `${url.pathname}${url.search}${url.hash}`) {
      const state = { ...(current as Record<string, unknown>) };
      delete state[SETUP_DESTINATION_KEY];
      window.history.replaceState(state, '');
      return url.searchParams.get('connect') === '1' && !isWorkLink(url) ? 'connection' : 'editor';
    }
  } catch { /* Storage may be blocked. */ }
  if (isWorkLink(url)) {
    if (phase !== 'complete') writeWelcomePhase('complete');
    return 'editor';
  }
  if (phase === 'local') return 'local';
  // The installer's handoff resumes at connection; a local build has nothing to connect before its local setup.
  if (url.searchParams.get('connect') === '1') return phase === 'complete' || phase === 'connection' || !localBuild ? 'connection' : 'local';
  if (localBuild && phase === 'choose') return 'local';
  return phase === 'complete' ? 'editor' : phase ?? 'tour';
}

export function completeWelcome(selection?: {projectId: string; timelineId: string | null}): string {
  writeWelcomePhase('complete');
  const params = new URLSearchParams();
  if (selection) {
    params.set('project', selection.projectId);
    if (selection.timelineId) params.set('timeline', selection.timelineId);
  } else params.set('entry', 'editor');
  const target = `${APP_ENTRY_PATH}${params.size ? `?${params}` : ''}`;
  rememberSetupDestination(new URL(target, window.location.origin));
  return target;
}

import { APP_ENTRY_PATH } from '@/app/entryClassification.ts';

export const WELCOME_PROGRESS_KEY = 'astrid:welcome-v1';
const SETUP_DESTINATION_KEY = 'astrid:welcome-setup-destination';
const RUN_MODE_KEY = 'astrid:welcome-run-mode-v1';
export type WelcomeRunMode = 'hosted' | 'local';
export type WelcomePhase = 'tour' | 'choose' | 'setup' | 'connection' | 'local' | 'complete';
export type WelcomeEntry = WelcomePhase | 'editor';
const LEGACY_KEYS = [
  'astrid.runtime.connectedBefore',
  'astrid-setup-complete',
  'astrid-editor-tour-v1',
  'astrid:lastOpenedLocalProjectSlug',
] as const;
let memoryPhase: WelcomePhase | null = null;

/** Fill in the durable record once for an existing browser profile. */
export function readWelcomePhase(): WelcomePhase | null {
  try {
    const value = localStorage.getItem(WELCOME_PROGRESS_KEY);
    if (value === 'tour' || value === 'choose' || value === 'setup' || value === 'connection' || value === 'local' || value === 'complete') return value;
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

/** Pick the only owner for this URL and phase. Work links take precedence over onboarding. */
export function entryFor(url: URL, phase: WelcomePhase | null, localBuild = false): WelcomeEntry {
  if (url.pathname !== APP_ENTRY_PATH) return 'editor';
  try {
    const current = window.history.state;
    if (current && typeof current === 'object' && (current as Record<string, unknown>)[SETUP_DESTINATION_KEY] === `${url.pathname}${url.search}${url.hash}`) {
      const state = { ...(current as Record<string, unknown>) };
      delete state[SETUP_DESTINATION_KEY];
      window.history.replaceState(state, '');
      const hasWorkTarget = url.searchParams.get('entry') === 'editor' || ['project', 'timeline', 'localProject', 'localTimeline'].some(key => url.searchParams.has(key));
      return url.searchParams.get('connect') === '1' && !hasWorkTarget ? 'connection' : 'editor';
    }
  } catch { /* Storage may be blocked. */ }
  if (['project', 'timeline', 'localProject', 'localTimeline'].some(key => url.searchParams.has(key))) return phase === 'complete' ? 'editor' : 'setup';
  // The tour's explicit Open editor link can still work when browser storage is blocked.
  // The editor's normal Runtime gate remains responsible for connecting before workspace data loads.
  if (url.searchParams.get('entry') === 'editor') return phase === 'complete' ? 'editor' : 'setup';
  if (phase === 'local') return 'local';
  if (url.searchParams.get('connect') === '1') return phase === 'complete' || phase === 'connection' ? 'connection' : 'setup';
  if (localBuild && phase === 'choose') return 'setup';
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

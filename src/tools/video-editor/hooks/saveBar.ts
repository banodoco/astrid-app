import type { LocalSaveState } from '../commands/localSaveSession.ts';

/** What Try again runs. Computed with the headline, so the bar and its button can never disagree. */
export type SaveBarAction =
  /** A save conflict raised outside the local queue: resend on the latest head. */
  | 'conflict'
  | 'watchdog'
  /** The retained local chain: resend now, on the latest head when it was refused. */
  | 'local'
  /** The save session did not start: start it again (it recovers what is retained). */
  | 'restart'
  | 'draft'
  | 'pending';

/**
 * The one description of "this timeline has unsaved work and nothing is sending it": what the save bar and the
 * badge both read. `refused` will not be accepted as it is, `waiting` is kept and will be sent again, `recovered`
 * is work found after a reload.
 */
export interface SaveBarInput {
  kind: 'refused' | 'waiting' | 'recovered';
  headline: string;
  since?: string;
  action: SaveBarAction;
}

export interface SaveBarSources {
  local: LocalSaveState | null;
  /** The save session failed to start (its owner could not be claimed or recovered). */
  bootstrapFailed: boolean;
  recoveryDraft: { updatedAt: string } | null;
  conflictExhausted: boolean;
  schemaIncompatible: boolean;
  watchdogTripped: boolean;
  saveError: string | null | undefined;
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const reasonOf = (error: LocalSaveState['error']): string | undefined => error && typeof error === 'object' && !Array.isArray(error)
  ? text(error.message) : undefined;
const HELD_ELSEWHERE = 'This timeline has unsaved changes open in another tab.';
const withoutPrefix = (message: string) => message.replace(/^Local document save retained: /, '');

/** The single function from today's state to the bar. Returns null when everything is saved or in flight. */
export function saveBarInput(source: SaveBarSources): SaveBarInput | null {
  const { local } = source;
  if (source.bootstrapFailed) {
    const reason = reasonOf(local?.error) ?? 'The save session could not start.';
    return { kind: 'refused', headline: /already claimed/i.test(reason) ? HELD_ELSEWHERE : reason, action: 'restart' };
  }
  if (local?.notice) return { kind: 'refused', headline: local.notice, action: 'local' };
  if (local && ['conflict', 'error', 'blocked'].includes(local.status)) {
    const reason = reasonOf(local.error) ?? 'The Runtime did not accept this change.';
    return { kind: 'refused', headline: /already claimed/i.test(reason) ? HELD_ELSEWHERE : reason, action: 'local' };
  }
  if (source.conflictExhausted) return { kind: 'refused', headline: 'This timeline changed somewhere else.', action: 'conflict' };
  if (source.schemaIncompatible) {
    return { kind: 'refused', headline: 'The timeline could not be saved: the payload is incompatible with the server schema.', action: 'pending' };
  }
  if (local?.status === 'retry') {
    return { kind: 'waiting', headline: reasonOf(local.error) ?? 'The Runtime is not answering. Your changes are kept.', action: 'local' };
  }
  // Retained work found on load, before it has been replayed.
  if (local?.status === 'recovery') return { kind: 'recovered', headline: 'You have unsaved changes.', action: 'restart' };
  if (source.watchdogTripped) return { kind: 'waiting', headline: 'The save has not been confirmed. Your changes are kept.', action: 'watchdog' };
  if (source.recoveryDraft) {
    return { kind: 'recovered', headline: 'You have unsaved changes.', since: source.recoveryDraft.updatedAt, action: 'draft' };
  }
  // Any other failure keeps its own reason (a reload failure, a declined edit that could not be undone).
  if (source.saveError) return { kind: 'refused', headline: withoutPrefix(source.saveError), action: 'pending' };
  return null;
}

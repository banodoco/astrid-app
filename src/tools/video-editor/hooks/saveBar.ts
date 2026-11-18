import type { LocalSaveState } from '../commands/localSaveSession.ts';

/**
 * The one description of "this timeline has unsaved work and nothing is sending it": what the save bar and the
 * badge both read. `refused` will not be accepted as it is, `waiting` is kept and will be sent again, `recovered`
 * is work found after a reload.
 */
export interface SaveBarInput {
  kind: 'refused' | 'waiting' | 'recovered';
  headline: string;
  since?: string;
}

export interface SaveBarSources {
  local: LocalSaveState | null;
  recoveryDraft: { updatedAt: string } | null;
  conflictExhausted: boolean;
  schemaIncompatible: boolean;
  watchdogTripped: boolean;
  saveError: string | null | undefined;
}

const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const reasonOf = (error: LocalSaveState['error']): string | undefined => error && typeof error === 'object' && !Array.isArray(error)
  ? text(error.message) : undefined;

/** The single function from today's state to the bar. Returns null when everything is saved or in flight. */
export function saveBarInput(source: SaveBarSources): SaveBarInput | null {
  const { local } = source;
  if (local?.notice) return { kind: 'refused', headline: local.notice };
  if (local && ['conflict', 'error', 'blocked'].includes(local.status)) {
    return { kind: 'refused', headline: reasonOf(local.error) ?? 'The Runtime did not accept this change.' };
  }
  if (source.conflictExhausted) return { kind: 'refused', headline: 'This timeline changed somewhere else.' };
  if (source.schemaIncompatible) {
    return { kind: 'refused', headline: 'The timeline could not be saved: the payload is incompatible with the server schema.' };
  }
  if (local && (local.status === 'retry' || local.status === 'recovery')) {
    return { kind: 'waiting', headline: reasonOf(local.error) ?? 'The Runtime is not answering. Your changes are kept.' };
  }
  if (source.watchdogTripped) return { kind: 'waiting', headline: 'The save has not been confirmed. Your changes are kept.' };
  if (source.recoveryDraft) {
    return { kind: 'recovered', headline: 'You have unsaved changes.', since: source.recoveryDraft.updatedAt };
  }
  if (source.saveError) {
    // An earlier retained save declined this edit (its own throw text is never shown); the bar says what is happening.
    if (local) return { kind: 'waiting', headline: 'Earlier changes are still being saved. Try again in a moment.' };
    return { kind: 'refused', headline: source.saveError };
  }
  return null;
}

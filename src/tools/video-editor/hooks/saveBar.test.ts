import { describe, expect, it } from 'vitest';
import type { LocalSaveState } from '../commands/localSaveSession.ts';
import { saveBarInput, type SaveBarSources } from './saveBar.ts';

const none: SaveBarSources = { local: null, bootstrapFailed: false, recoveryDraft: null, conflictExhausted: false,
  schemaIncompatible: false, watchdogTripped: false, saveError: null };
const local = (status: LocalSaveState['status'], extra: Partial<LocalSaveState> = {}): LocalSaveState => ({ status, recoverableOwners: [], ...extra });

describe('saveBarInput: the headline and the action Try again runs come from one place', () => {
  it('is empty when nothing is unsaved or in flight', () => {
    expect(saveBarInput(none)).toBeNull();
    expect(saveBarInput({ ...none, local: local('saving') })).toBeNull();
    expect(saveBarInput({ ...none, local: local('dirty') })).toBeNull();
  });

  it.each([
    ['a refused save', { local: local('error', { error: { message: 'bad request' } }) }, 'refused', 'bad request', 'local'],
    ['an unavailable save', { local: local('retry') }, 'waiting', 'The Runtime is not answering. Your changes are kept.', 'local'],
    ['retained work found on load', { local: local('recovery') }, 'recovered', 'You have unsaved changes.', 'restart'],
    ['a save session that did not start', { bootstrapFailed: true, local: local('error', { error: { message: 'boom' } }) }, 'refused', 'boom', 'restart'],
    ['a conflict outside the queue', { conflictExhausted: true }, 'refused', 'This timeline changed somewhere else.', 'conflict'],
    ['an unconfirmed save', { watchdogTripped: true }, 'waiting', 'The save has not been confirmed. Your changes are kept.', 'watchdog'],
    ['a recovered draft', { recoveryDraft: { updatedAt: '2026-11-18T10:16:00Z' } }, 'recovered', 'You have unsaved changes.', 'draft'],
    ['a draft whose base no longer exists offers only Discard', { recoveryDraft: { updatedAt: '2026-11-18T11:10:00Z', baseGone: true } },
      'refused', 'These changes were made on a version that no longer exists.', 'none'],
    ['a failed Try again on a recovered draft shows its reason, not the generic headline',
      { recoveryDraft: { updatedAt: '2026-11-18T11:10:00Z' }, saveError: 'Local document save retained: original verified authoring head is unavailable' },
      'refused', 'original verified authoring head is unavailable', 'draft'],
    ['a reload failure keeps its own reason', { local: local('saved'), saveError: 'The recovery draft changed during reload; it was kept for safety.' },
      'refused', 'The recovery draft changed during reload; it was kept for safety.', 'pending'],
  ] as const)('%s', (_name, patch, kind, headline, action) => {
    expect(saveBarInput({ ...none, ...patch } as SaveBarSources)).toMatchObject({ kind, headline, action });
  });

  it('names a lock held by another tab, and strips the retained-save prefix from a plain failure', () => {
    expect(saveBarInput({ ...none, local: local('error', { error: { message: 'Outbox is already claimed' } }) })?.headline)
      .toBe('This timeline has unsaved changes open in another tab.');
    expect(saveBarInput({ ...none, saveError: 'Local document save retained: head moved' })?.headline).toBe('head moved');
  });

  it('chooses the action in the order it chooses the headline: a refusal beats the watchdog', () => {
    expect(saveBarInput({ ...none, watchdogTripped: true, local: local('error', { error: { message: 'no' } }) })).toMatchObject({ headline: 'no', action: 'local' });
  });
});

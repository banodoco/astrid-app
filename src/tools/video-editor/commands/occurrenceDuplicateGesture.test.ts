import { describe, expect, it, vi } from 'vitest';
import type { EditCommand } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelineData } from '../lib/timeline-data.ts';
import { copy } from './clipMovePrimitives.ts';
import { captureOccurrenceDuplicateEdit, submitOccurrenceDuplicateEdit, type OccurrenceDuplicateCapturePort } from './occurrenceDuplicateGesture.ts';
import fixture from './fixtures/recipe_m2_app_occurrence_duplicate.json';

const owner = 'occurrence:occ-0';
const args = { occurrence_id: 'occ-copy', shot_id: 'shot-copy' };
const current = {} as TimelineData;
function port() {
  return {
    capture: vi.fn<OccurrenceDuplicateCapturePort['capture']>(() => ({ original: { keep: [null, false] } })),
    finish: vi.fn<OccurrenceDuplicateCapturePort['finish']>(() => ({ command: copy(fixture.command) as EditCommand })),
    submit: vi.fn<OccurrenceDuplicateCapturePort['submit']>(),
  } satisfies OccurrenceDuplicateCapturePort;
}

describe('independent duplicate gesture adapter', () => {
  it('retains original raw owner, reservations, and immutable capture through submission', () => {
    const native = port();
    const reserved = copy(args);
    const captured = captureOccurrenceDuplicateEdit(native, current, owner, reserved);
    reserved.shot_id = 'changed-after-capture';
    expect(native.capture).toHaveBeenCalledExactlyOnceWith({ current, ownerRef: owner, args });
    expect(Object.isFrozen(captured.args)).toBe(true);
    expect(Object.isFrozen(captured.basis.original)).toBe(true);
    submitOccurrenceDuplicateEdit(captured);
    expect(native.finish).toHaveBeenCalledExactlyOnceWith(captured.basis);
    expect(native.submit).toHaveBeenCalledExactlyOnceWith({ command: fixture.command });
    expect(Object.isFrozen(native.submit.mock.calls[0][0].command)).toBe(true);
  });

  it('refuses an unavailable port', () => {
    expect(() => captureOccurrenceDuplicateEdit(undefined, current, owner, args)).toThrow('unavailable');
  });

  it.each([
    { op: 'placement.move' }, { select: 'occurrence:other' }, { version: '2' },
    { args: { ...args, shot_id: 'changed' } }, { intent: { ownership: 'shared' } },
  ])('refuses a changed capture result %j before submission', (change) => {
    const native = port();
    const captured = captureOccurrenceDuplicateEdit(native, current, owner, args);
    native.finish.mockReturnValue({ command: { ...copy(fixture.command), ...change } as EditCommand });
    expect(() => submitOccurrenceDuplicateEdit(captured)).toThrow('Unsupported');
    expect(native.submit).not.toHaveBeenCalled();
  });
});

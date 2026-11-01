import { describe, expect, it } from 'vitest';
import type { TimelinePatchOperation } from '@/sdk/video/timeline/patch.ts';
import { captureGenericPatch, executeGenericPatch } from './genericPatchCapture.ts';
import fixture from './fixtures/recipe_m1_move.json';
import {
  captureOrdinaryMoveMember,
  executeOrdinaryMoveMember,
  finishOrdinaryMoveMember,
} from './ordinaryMoveMember.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

const move = (at: number, order?: number): TimelinePatchOperation => ({
  op: 'clip.move',
  target: 'c',
  payload: { at },
  ...(order === undefined ? {} : { order }),
});

describe('ordinary clip.move patch member', () => {
  it('produces the Agent command, full record, and immutable bundle for a mixed sequence', () => {
    const bundle = structuredClone(fixture.bundle) as AuthoredBundle;
    const basis = captureOrdinaryMoveMember(bundle, move(4, 1), fixture.select);
    const prepared = finishOrdinaryMoveMember(basis, 0);

    expect(prepared.command).toEqual(fixture.command);
    expect(prepared.bundle).toEqual(fixture.after_bundle);
    expect(prepared.record).toEqual({ ...fixture.record, ordinal: 0 });
    expect(prepared.operation).toEqual(move(4, 1));
    expect(Object.isFrozen(basis)).toBe(true);
    expect(Object.isFrozen(basis.move.bundle)).toBe(true);

    const mixedBundle = structuredClone(fixture.bundle) as AuthoredBundle;
    delete (mixedBundle.parent.clips as Array<Record<string, unknown>>)[0].app;
    const prefix = captureGenericPatch(mixedBundle, {
      version: 1,
      operations: [
        { op: 'clip.update', target: 'c', payload: { hold: 4 }, order: 0 },
        { op: 'track.update', target: 'picture', payload: { label: 'Picture' }, order: 1 },
      ],
    }, (operation) => operation.op === 'clip.update' ? fixture.select : 'parent/track:picture');
    const appliedPrefix = executeGenericPatch(mixedBundle, prefix.commands);
    const mixedBasis = captureOrdinaryMoveMember(appliedPrefix.bundle, move(4, 2), fixture.select);
    const mixed = finishOrdinaryMoveMember(mixedBasis, 2);
    const appliedMove = executeOrdinaryMoveMember(appliedPrefix.bundle, mixed.command, 2);

    expect(appliedPrefix.records.map((record) => record.command.op)).toEqual(['clip.set', 'track.set']);
    expect(appliedMove.record.ordinal).toBe(2);
    expect(mixed.previewAt).toBe(4.004);
    expect(appliedMove.bundle.parent.clips).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'c', at: mixed.previewAt, hold: 4 }),
    ]));
    expect(appliedMove.bundle.parent.config.tracks).toEqual([
      { id: 'picture', kind: 'visual', label: 'Picture' },
    ]);

    const replay = executeOrdinaryMoveMember(bundle, prepared.command, 4);
    expect(replay.command).toEqual(prepared.command);
    expect(replay.bundle).toEqual(prepared.bundle);
    expect(replay.record).toEqual({ ...prepared.record, ordinal: 4,
      derived_writes: prepared.record.derived_writes.map((write) => ({ ...write, cause: 4 })) });
  });

  it('refuses unsupported move payloads and guarded destinations without clamping', () => {
    const bundle = structuredClone(fixture.bundle) as AuthoredBundle;
    expect(() => captureOrdinaryMoveMember(bundle, move(-1), fixture.select)).toThrow(
      'finite non-negative absolute at value',
    );
    expect(() => captureOrdinaryMoveMember(bundle, {
      op: 'clip.move', target: 'c', payload: { at: 4, track: 'other' },
    } as TimelinePatchOperation, fixture.select)).toThrow();

    const blocked = fixture.cases.find((item) => item.name === 'repeated_shared_A')!;
    const blockedBasis = captureOrdinaryMoveMember(blocked.bundle as AuthoredBundle,
      { ...move(18.1), target: 'c' }, blocked.select);
    expect(() => finishOrdinaryMoveMember(blockedBasis)).toThrow('crosses');
  });
});

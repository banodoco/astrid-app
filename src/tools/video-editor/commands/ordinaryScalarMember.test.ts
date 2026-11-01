import { describe, expect, it } from 'vitest';
import { authoringBundleFromDocument } from './authoringBundle.ts';
import { environment } from './__tests__/commitSessionEnvironment.ts';
import {
  captureOrdinaryScalarClear,
  captureOrdinaryScalarMember,
  executeOrdinaryScalarBatch,
  executeOrdinaryScalarMember,
} from './ordinaryScalarMember.ts';
import { AuthoredState, copy } from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';
import type { EditCommand } from '@/integrations/runtime/timeline-commit-types.ts';

const ref = 'parent/clip:x';

async function bundle(): Promise<AuthoredBundle> {
  const { initial } = await environment();
  return authoringBundleFromDocument(initial.canonicalDocument);
}

const clip = (value: AuthoredBundle, target = ref) => new AuthoredState(value).entity(target)!;

describe('ordinary clip scalar member', () => {
  it('captures a hold value through the existing native clip.set recorder', async () => {
    const input = await bundle();
    const command = captureOrdinaryScalarMember(input, { select: ref, values: { hold: 2.5 } });
    const result = executeOrdinaryScalarMember(input, command);

    expect(command).toMatchObject({
      op: 'clip.set', select: ref, args: { values: { hold: 2.5 }, clear: [] },
    });
    expect(result.bundle).not.toBe(input);
    expect(clip(result.bundle).hold).toBe(2.5);
    expect(result.record.writes).toEqual([{
      ref, path: ['hold'], before: { state: 'present', value: 1 }, after: { state: 'present', value: 2.5 },
    }]);
    expect(clip(input).hold).toBe(1);
  });

  it('captures an explicit transition clear as ABSENT and preserves opaque siblings', async () => {
    const input = await bundle();
    clip(input).transition = { type: 'crossfade', duration: 0.25 };
    clip(input).app = { opaque: null, nested: [false, 0, 'keep'] };
    const command = captureOrdinaryScalarClear(input, ref, 'transition');
    const result = executeOrdinaryScalarMember(input, command);

    expect(command.args).toEqual({ values: {}, clear: ['transition'] });
    expect(clip(result.bundle)).not.toHaveProperty('transition');
    expect(clip(result.bundle).app).toEqual({ opaque: null, nested: [false, 0, 'keep'] });
    expect(result.record.writes).toEqual([{
      ref,
      path: ['transition'],
      before: { state: 'present', value: { type: 'crossfade', duration: 0.25 } },
      after: { state: 'absent' },
    }]);
  });

  it('records unchanged values and absent clears instead of dropping no-op intent', async () => {
    const input = await bundle();
    const set = executeOrdinaryScalarMember(input,
      captureOrdinaryScalarMember(input, { select: ref, values: { hold: 1 } }));
    const clear = executeOrdinaryScalarMember(input,
      captureOrdinaryScalarClear(input, ref, 'transition'));

    expect(set.record.writes[0].before).toEqual(set.record.writes[0].after);
    expect(clear.record.writes[0].before).toEqual({ state: 'absent' });
    expect(clear.record.writes[0].after).toEqual({ state: 'absent' });
  });

  it('keeps command order and one sequential authored result for a scalar batch', async () => {
    const input = await bundle();
    clip(input).transition = { type: 'wipe', duration: 1 };
    const commands = [
      captureOrdinaryScalarMember(input, { select: ref, values: { hold: 2 } }),
      captureOrdinaryScalarClear(input, ref, 'transition'),
    ];
    const result = executeOrdinaryScalarBatch(input, commands);

    expect(result.commands.map((command) => command.args)).toEqual([
      { values: { hold: 2 }, clear: [] },
      { values: {}, clear: ['transition'] },
    ]);
    expect(result.records.map((record) => record.ordinal)).toEqual([0, 1]);
    expect(clip(result.bundle).hold).toBe(2);
    expect(clip(result.bundle)).not.toHaveProperty('transition');
    expect(clip(input)).toHaveProperty('transition');
  });

  it('refuses transition SET and hold clear without a source window', async () => {
    const input = await bundle();
    expect(() => captureOrdinaryScalarMember(input, {
      select: ref,
      values: { transition: { type: 'crossfade' } } as never,
    })).toThrow('unsupported field');
    expect(() => captureOrdinaryScalarClear(input, ref, 'hold')).toThrow('surviving source window');
  });

  it('retains original guards when authored state changes after capture', async () => {
    const input = await bundle();
    const command = captureOrdinaryScalarMember(input, { select: ref, values: { hold: 2 } });
    const changed = copy(input);
    clip(changed).hold = 9;
    expect(() => executeOrdinaryScalarMember(changed, command)).toThrow('original capture');
  });

  it('does not accept a forged command shape', async () => {
    const input = await bundle();
    const command: EditCommand = {
      schema_version: 1, op: 'clip.set', version: '1', select: ref,
      args: { values: { opacity: 0.5 }, clear: [] }, intent: {},
    };
    expect(() => executeOrdinaryScalarMember(input, command)).toThrow('unsupported field');
  });
});

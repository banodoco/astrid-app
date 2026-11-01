import { describe, expect, it } from 'vitest';
import type { AgentState, CommandRecord, EditCommand, JSON as JsonValue } from '@/integrations/runtime/timeline-commit-types.ts';
import {
  captureClipClear,
  captureClipSet,
  executeClipSet,
  executeClipSetBatch,
} from './clipScalarCapture.ts';
import { AuthoredState } from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipScalarCapture.ts';
import fixture from './fixtures/recipe_m2_app_clip_scalar_fields.json';

type Golden = {
  bundle: AuthoredBundle;
  commands: EditCommand[];
  records: CommandRecord[];
  after_bundle: AuthoredBundle;
};

const golden = fixture as unknown as Golden;
const detached = <T>(value: T): T => structuredClone(value);
const clip = (bundle: AuthoredBundle, ref: string): Record<string, JsonValue> => {
  const entity = new AuthoredState(bundle).entity(ref);
  if (!entity) throw new Error(`missing ${ref}`);
  return entity;
};
const inverseRecord = (bundle: AuthoredBundle, record: CommandRecord): AuthoredBundle => {
  const restored = detached(bundle);
  const state = new AuthoredState(restored);
  for (const write of [...record.derived_writes].reverse()) {
    state.set(write.ref, write.path, write.before);
  }
  for (const write of [...record.writes].reverse()) {
    state.set(write.ref, write.path, write.before);
  }
  return restored;
};

describe('Agent built-in clip.set capture parity', () => {
  it('writes prototype-looking authored leaves as own data', () => {
    const input = detached(golden.bundle);
    const ref = 'parent/clip:f2-transition-clip';
    const row = clip(input, ref);
    row.transition = JSON.parse('{"params":{}}') as JsonValue;
    const state = new AuthoredState(input);
    const after: AgentState = { state: 'present', value: { literal: true } };
    state.set(ref, ['transition', 'params', '__proto__'], after);
    expect(Object.hasOwn((row.transition as Record<string, JsonValue>).params as object, '__proto__')).toBe(true);
    expect(state.get(ref, ['transition', 'params', '__proto__'])).toEqual(after);
    expect(Object.getPrototypeOf((row.transition as Record<string, JsonValue>).params)).toBe(Object.prototype);
  });

  it('matches all three frozen App fixture commands, records, and authored output exactly', () => {
    const input = detached(golden.bundle);
    const result = executeClipSetBatch(input, golden.commands);
    expect(result.commands).toEqual(golden.commands);
    expect(result.records).toEqual(golden.records);
    expect(result.bundle).toEqual(golden.after_bundle);
    expect(input).toEqual(golden.bundle);
  });

  it('captures each original command with stable parent/occurrence-scoped identity', () => {
    const [hold, asset, transition] = golden.commands;
    expect(captureClipSet(golden.bundle, hold.select!, { values: { hold: 4 } })).toEqual(hold);
    expect(captureClipClear(golden.bundle, asset.select!, 'asset')).toEqual(asset);
    expect(captureClipClear(golden.bundle, transition.select!, 'transition')).toEqual(transition);
  });

  it('captures a repaired incoming transition with its paired ref and predecessor guard', () => {
    const input = detached(golden.bundle);
    const ref = 'parent/clip:f2-transition-clip';
    clip(input, ref).at = 3;
    const values = {
      transition: {
        type: 'crossfade', duration: 0.75, revision: 'transition-r1',
        params: JSON.parse('{"opaque":{"__proto__":["keep"],"a.b":false}}'), future: [null, 2],
      },
      elementRef: { id: 'crossfade', kind: 'transition', revision: 'transition-r1' },
    } as unknown as Record<string, JsonValue>;
    const command = captureClipSet(input, ref, { values });
    const result = executeClipSet(input, command);
    expect(command.args).toEqual({ values, clear: [] });
    expect(command.selections).toEqual([{
      key: 'transition.predecessor', query_version: 1, owner: ref,
      members: ['parent/clip:f2-app-clip'],
      order: ['parent/clip:f2-app-clip', ref],
      boundaries: ['parent/track:V1'], policy: 'guard-membership',
    }]);
    expect(result.record.command).toEqual(command);
    expect(result.record.writes).toEqual([
      { ref, path: ['elementRef'], before: { state: 'absent' }, after: { state: 'present', value: values.elementRef } },
      { ref, path: ['transition'], before: { state: 'present', value: { type: 'crossfade', duration: 0.5 } }, after: { state: 'present', value: values.transition } },
    ]);
    expect(clip(result.bundle, ref)).toMatchObject(values);
    expect((clip(result.bundle, ref).transition as Record<string, JsonValue>).future).toEqual([null, 2]);
    expect((clip(result.bundle, ref).transition as Record<string, JsonValue>).params).toMatchObject({ opaque: { 'a.b': false } });
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['object', { opaque: { keep: [null, false, 0] } }],
  ] as const)('preserves raw params %s through an authenticated no-ref duration update', (_label, params) => {
    const input = detached(golden.bundle);
    const ref = 'parent/clip:f2-transition-clip';
    const row = clip(input, ref);
    row.at = 3;
    row.transition = { type: 'crossfade', duration: 0.5, revision: 'transition-r1', future: { keep: true } };
    if (params === undefined) delete (row.transition as Record<string, JsonValue>).params;
    else (row.transition as Record<string, JsonValue>).params = detached(params);

    const values = {
      transition: { type: 'crossfade', duration: 0.75, revision: 'transition-r1' },
    } as Record<string, JsonValue>;
    const result = executeClipSet(input, captureClipSet(input, ref, { values }));
    const transition = clip(result.bundle, ref).transition as Record<string, JsonValue>;
    expect(transition).toMatchObject({ type: 'crossfade', duration: 0.75, revision: 'transition-r1', future: { keep: true } });
    if (params === undefined) expect(transition).not.toHaveProperty('params');
    else expect(transition.params).toEqual(params);
  });

  it('accepts a literal null params value when the no-ref update preserves it', () => {
    const input = detached(golden.bundle);
    const ref = 'parent/clip:f2-transition-clip';
    const row = clip(input, ref);
    row.at = 3;
    row.transition = { type: 'crossfade', duration: 0.5, revision: 'transition-r1', params: null };
    const values = {
      transition: { type: 'crossfade', duration: 0.75, revision: 'transition-r1', params: null },
    } as Record<string, JsonValue>;

    const result = executeClipSet(input, captureClipSet(input, ref, { values }));
    expect(clip(result.bundle, ref).transition).toMatchObject(values.transition);
    expect(Object.hasOwn(clip(result.bundle, ref).transition as object, 'params')).toBe(true);
    expect((clip(result.bundle, ref).transition as Record<string, JsonValue>).params).toBeNull();
  });

  it('refuses params null when it would discard non-empty existing params atomically', () => {
    const input = detached(golden.bundle);
    const ref = 'parent/clip:f2-transition-clip';
    const row = clip(input, ref);
    row.at = 3;
    row.transition = {
      type: 'crossfade', duration: 0.5, revision: 'transition-r1', params: { keep: true },
    };
    const before = detached(input);
    expect(() => captureClipSet(input, ref, {
      values: { transition: { type: 'crossfade', duration: 0.75, revision: 'transition-r1', params: null } },
    })).toThrow('remove existing parameters');
    expect(input).toEqual(before);
  });

  it.each(['elementRef', 'element_ref'] as const)('refuses no-ref updates when %s is present, independently', (field) => {
    const input = detached(golden.bundle);
    const ref = 'parent/clip:f2-transition-clip';
    const row = clip(input, ref);
    row.at = 3;
    row.transition = { type: 'crossfade', duration: 0.5, revision: 'transition-r1' };
    row[field] = null;
    const before = detached(input);
    expect(() => captureClipSet(input, ref, {
      values: { transition: { type: 'crossfade', duration: 0.75, revision: 'transition-r1' } },
    })).toThrow('existing raw identity');
    expect(input).toEqual(before);
  });

  it.each([
    ['type', { type: 'other', duration: 0.75, revision: 'transition-r1' }],
    ['revision', { type: 'crossfade', duration: 0.75, revision: 'transition-r2' }],
  ] as const)('refuses a no-ref update with changed %s', (_label, transition) => {
    const input = detached(golden.bundle);
    const ref = 'parent/clip:f2-transition-clip';
    const row = clip(input, ref);
    row.at = 3;
    row.transition = { type: 'crossfade', duration: 0.5, revision: 'transition-r1' };
    const before = detached(input);
    expect(() => captureClipSet(input, ref, { values: { transition } })).toThrow('existing raw identity');
    expect(input).toEqual(before);
  });

  it.each([
    ['missing to null', undefined, null],
    ['null to missing', null, undefined],
    ['missing to empty', undefined, ''],
    ['empty to missing', '', undefined],
  ] as const)('distinguishes revision presence/value for no-ref updates: %s', (_label, stored, requested) => {
    const input = detached(golden.bundle);
    const ref = 'parent/clip:f2-transition-clip';
    const row = clip(input, ref);
    row.at = 3;
    row.transition = { type: 'crossfade', duration: 0.5 };
    if (stored === undefined) delete (row.transition as Record<string, JsonValue>).revision;
    else (row.transition as Record<string, JsonValue>).revision = stored;
    const transition = { type: 'crossfade', duration: 0.75 } as Record<string, JsonValue>;
    if (requested !== undefined) transition.revision = requested;
    const before = detached(input);
    expect(() => captureClipSet(input, ref, { values: { transition } })).toThrow('existing raw identity');
    expect(input).toEqual(before);
  });

  it('refuses an adjacency gap or mismatched selected ref atomically before writes', () => {
    const base = detached(golden.bundle);
    const ref = 'parent/clip:f2-transition-clip';
    const values = {
      transition: { type: 'crossfade', duration: 0.75, revision: 'transition-r1' },
      elementRef: { id: 'crossfade', kind: 'transition', revision: 'transition-r1' },
    } as unknown as Record<string, JsonValue>;
    const beforeGap = detached(base);
    expect(() => captureClipSet(base, ref, { values })).toThrow('adjacent');
    expect(base).toEqual(beforeGap);

    const adjacent = detached(base);
    clip(adjacent, ref).at = 3;
    const beforeMismatch = detached(adjacent);
    const wrongRef = { ...values, elementRef: { id: 'wipe', kind: 'transition', revision: 'transition-r1' } } as unknown as Record<string, JsonValue>;
    expect(() => captureClipSet(adjacent, ref, { values: wrongRef })).toThrow('matching selected reference');
    expect(adjacent).toEqual(beforeMismatch);
  });

  it('refuses a transition window longer than either adjacent clip', () => {
    const input = detached(golden.bundle);
    const ref = 'parent/clip:f2-transition-clip';
    clip(input, ref).at = 3;
    const values = {
      transition: { type: 'crossfade', duration: 4, revision: 'transition-r1' },
      elementRef: { id: 'crossfade', kind: 'transition', revision: 'transition-r1' },
    } as unknown as Record<string, JsonValue>;
    expect(() => captureClipSet(input, ref, { values })).toThrow('shorter adjacent clip');
  });

  it('keeps shared occurrences isolated and preserves opaque/unrelated data', () => {
    const result = executeClipSetBatch(detached(golden.bundle), golden.commands);
    expect(clip(result.bundle, 'occurrence:shared-sibling/clip:f2-agent-clip')).toEqual(
      clip(golden.bundle, 'occurrence:shared-sibling/clip:f2-agent-clip'),
    );
    expect(clip(result.bundle, 'occurrence:f2-occurrence/clip:f2-agent-clip').app).toEqual({
      f2Opaque: { owner: 'f2', nested: [1, { k: 'v' }] },
    });
    expect(clip(result.bundle, 'occurrence:f2-occurrence/clip:f2-agent-clear-clip')).not.toHaveProperty('asset');
    expect(clip(result.bundle, 'parent/clip:f2-transition-clip')).not.toHaveProperty('transition');
  });

  it.each([
    null, '', false, 0, -1, Infinity, NaN,
  ])('refuses invalid hold source seconds: %j', (value) => {
    expect(() => captureClipSet(golden.bundle, golden.commands[0].select!, {
      values: { hold: value as JsonValue },
    })).toThrow();
  });

  it.each([
    [{ hold: 2 }, ['hold']],
    [{ asset: 'anything' }, []],
    [{ asset: '' }, []],
    [{ asset: null }, []],
    [{ transition: null }, []],
    [{ transition: { type: 'crossfade', duration: 0 } }, []],
    [{}, ['speed']],
    [{}, ['hold', 'hold']],
    [{}, []],
  ] as const)('refuses closed-schema edge %j %j', (values, clear) => {
    expect(() => captureClipSet(golden.bundle, golden.commands[0].select!, {
      values: values as unknown as Record<string, JsonValue>,
      clear: clear as unknown as never,
    })).toThrow();
  });

  it('distinguishes ABSENT, empty, and null source states while clearing to ABSENT', () => {
    const input = detached(golden.bundle);
    const ref = 'parent/clip:f2-transition-clip';
    const row = clip(input, ref);
    row.transition = '';
    const empty = executeClipSet(input, captureClipClear(input, ref, 'transition'));
    expect(empty.record.writes).toEqual([{
      ref,
      path: ['transition'],
      before: { state: 'present', value: '' },
      after: { state: 'absent' },
    }]);

    row.transition = null;
    const nullable = executeClipSet(input, captureClipClear(input, ref, 'transition'));
    expect(nullable.record.writes[0].before).toEqual({ state: 'present', value: null });
    expect(clip(nullable.bundle, ref)).not.toHaveProperty('transition');
  });

  it('matches the canonical paired clear record, raw output, and inverse for both ref spellings', () => {
    for (const field of ['elementRef', 'element_ref'] as const) {
      const input = detached(golden.bundle);
      const ref = 'parent/clip:f2-transition-clip';
      const selected = { id: 'crossfade', kind: 'transition', revision: 'transition-r1' } as JsonValue;
      const transition = {
        type: 'crossfade', duration: 0.5, revision: 'transition-r1',
        params: { opaque: { 'a.b': false, nested: [null, 0, ''] } }, future: [null, false, 0],
      } as JsonValue;
      const row = clip(input, ref);
      row.transition = transition;
      row[field] = detached(selected);
      const command = captureClipSet(input, ref, { clear: ['transition', 'elementRef'] });
      const result = executeClipSet(input, command);

      expect(command.args).toEqual({ values: {}, clear: ['transition', 'elementRef'] });
      expect(result.record.command).toEqual(command);
      expect(result.record.writes).toEqual(field === 'elementRef' ? [
        { ref, path: ['elementRef'], before: { state: 'present', value: selected }, after: { state: 'absent' } },
        { ref, path: ['transition'], before: { state: 'present', value: transition }, after: { state: 'absent' } },
      ] : [
        { ref, path: ['elementRef'], before: { state: 'absent' }, after: { state: 'absent' } },
        { ref, path: ['element_ref'], before: { state: 'present', value: selected }, after: { state: 'absent' } },
        { ref, path: ['transition'], before: { state: 'present', value: transition }, after: { state: 'absent' } },
      ]);
      expect(clip(result.bundle, ref)).not.toHaveProperty('transition');
      expect(clip(result.bundle, ref)).not.toHaveProperty('elementRef');
      expect(clip(result.bundle, ref)).not.toHaveProperty('element_ref');
      expect(inverseRecord(result.bundle, result.record)).toEqual(input);
    }
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['opaque', { opaque: { 'a.b': false }, future: [null, 0, ''] }],
  ] as const)('preserves exact stored transition presence through paired clear: %s', (_label, value) => {
    const input = detached(golden.bundle);
    const ref = 'parent/clip:f2-transition-clip';
    const row = clip(input, ref);
    if (value === undefined) delete row.transition;
    else row.transition = value as JsonValue;
    const before = detached(input);
    const command = captureClipSet(input, ref, { clear: ['transition', 'elementRef'] });
    const result = executeClipSet(input, command);
    expect(result.record.writes).toEqual([
      { ref, path: ['elementRef'], before: { state: 'absent' }, after: { state: 'absent' } },
      { ref, path: ['transition'], before: value === undefined ? { state: 'absent' } : { state: 'present', value }, after: { state: 'absent' } },
    ]);
    expect(clip(result.bundle, ref)).not.toHaveProperty('transition');
    expect(inverseRecord(result.bundle, result.record)).toEqual(before);
  });

  it.each([
    { id: 'crossfade', kind: 'effect', revision: 'transition-r1' },
    { id: 'crossfade', kind: 'transition', revision: 'wrong' },
    'opaque legacy reference',
  ] as const)('refuses a paired clear with an unsafe associated ref without mutation: %j', (selected) => {
    const input = detached(golden.bundle);
    const ref = 'parent/clip:f2-transition-clip';
    clip(input, ref).transition = { type: 'crossfade', duration: 0.5, revision: 'transition-r1' };
    clip(input, ref).element_ref = selected as JsonValue;
    const before = detached(input);
    expect(() => captureClipSet(input, ref, { clear: ['transition', 'elementRef'] })).toThrow();
    expect(input).toEqual(before);
  });

  it('refuses an elementRef-only clear and leaves the draft untouched', () => {
    const input = detached(golden.bundle);
    const ref = 'parent/clip:f2-transition-clip';
    const before = detached(input);
    expect(() => captureClipSet(input, ref, { clear: ['elementRef'] })).toThrow('requires transition clear');
    expect(input).toEqual(before);
  });

  it.each(['elementRef', 'element_ref'] as const)('keeps unrelated %s on the existing transition-only reset', (field) => {
    const input = detached(golden.bundle);
    const ref = 'parent/clip:f2-transition-clip';
    const unrelated = { id: 'rocket', kind: 'effect', revision: 'r1' } as JsonValue;
    clip(input, ref).transition = { type: 'crossfade', duration: 0.5 };
    clip(input, ref)[field] = unrelated;
    const result = executeClipSet(input, captureClipClear(input, ref, 'transition'));
    expect(clip(result.bundle, ref)[field]).toEqual(unrelated);
    expect(result.record.writes).toEqual([{
      ref, path: ['transition'], before: { state: 'present', value: { type: 'crossfade', duration: 0.5 } }, after: { state: 'absent' },
    }]);
    expect(inverseRecord(result.bundle, result.record)).toEqual(input);
  });

  it('refuses alternate media selectors, malformed timing, and successor-style hold intent', () => {
    const input = detached(golden.bundle);
    const ref = 'occurrence:f2-occurrence/clip:f2-agent-clip';
    clip(input, ref).media_id = 'other';
    expect(() => captureClipClear(input, ref, 'asset')).toThrow('another media selector');

    const malformed = detached(golden.bundle);
    clip(malformed, ref).speed = 2;
    clip(malformed, ref).app = { astrid: { for: 1 } };
    expect(() => captureClipSet(malformed, ref, { values: { hold: 4 } })).toThrow();

    const successor = detached(golden.bundle);
    clip(successor, ref).app = { astrid: { for: 3 } };
    expect(() => captureClipSet(successor, ref, { values: { hold: 4 } })).toThrow('does not support for');
  });

  it('refuses hold clear without a surviving explicit source window', () => {
    expect(() => captureClipClear(golden.bundle, golden.commands[0].select!, 'hold'))
      .toThrow('surviving source window');
  });

  it('uses exact source seconds and guards speed, rational fps, extent, and source windows', () => {
    const input = detached(golden.bundle);
    const ref = golden.commands[0].select!;
    const row = clip(input, ref);
    row.at = 3;
    row.speed = 2;
    (input.parent.config as Record<string, JsonValue>).output = {
      fps: { numerator: 30000, denominator: 1001 },
    };
    const command = captureClipSet(input, ref, { values: { hold: 18 } });
    const result = executeClipSet(input, command);
    expect(clip(result.bundle, ref).hold).toBe(18);
    expect(() => captureClipSet(input, ref, { values: { hold: 18.01 } })).toThrow('occurrence boundary');
    expect(() => captureClipSet(input, ref, { values: { hold: 20 } })).toThrow('occurrence boundary');

    const windowed = detached(input);
    const windowedRow = clip(windowed, ref);
    delete windowedRow.hold;
    windowedRow.from = 1;
    windowedRow.to = 5;
    expect(captureClipClear(windowed, ref, 'hold')).toMatchObject({ op: 'clip.set', args: { clear: ['hold'] } });

    for (const [key, value] of [['speed', 0], ['speed', 2], ['source_offset', 1], ['duration_ms', 0]] as const) {
      const malformed = detached(golden.bundle);
      if (key === 'duration_ms') clip(malformed, ref)[key] = value;
      else if (key === 'speed' || key === 'source_offset') {
        const occurrence = malformed.placements[0];
        occurrence[key] = value;
      }
      expect(() => captureClipSet(malformed, ref, { values: { hold: 4 } })).toThrow();
    }
  });

  it('refuses malformed clear shapes and unknown intentions', () => {
    const ref = golden.commands[0].select!;
    const malformed = (args: JsonValue, intent?: JsonValue): EditCommand => ({
      schema_version: 1,
      op: 'clip.set',
      version: '1',
      select: ref,
      args: args as { [key: string]: JsonValue },
      ...(intent === undefined ? {} : { intent: intent as EditCommand['intent'] }),
    });
    for (const command of [
      malformed({ values: {}, clear: ['hold', 'hold'] }),
      malformed({ values: {}, clear: ['unknown'] }),
      malformed({ values: { hold: 4 }, clear: ['hold'] }),
      malformed({ values: {}, clear: null }),
      malformed({ values: {}, clear: [] }),
      malformed({ values: { asset: 'new-media' }, clear: [] }),
      malformed({ values: { hold: 4 }, clear: [] }, { ownership: 'occurrence' }),
    ]) {
      expect(() => executeClipSet(golden.bundle, command)).toThrow();
    }
  });

  it('preserves the original capture guards when the submitted bundle changes', () => {
    const command = captureClipSet(golden.bundle, golden.commands[0].select!, { values: { hold: 4 } });
    const changed = detached(golden.bundle);
    clip(changed, golden.commands[0].select!).hold = 9;
    expect(() => executeClipSet(changed, command)).toThrow('original capture');
  });
});

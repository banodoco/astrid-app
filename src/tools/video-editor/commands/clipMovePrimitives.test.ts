import { describe, expect, it } from 'vitest';
import type { AgentState, JSON } from '@/integrations/runtime/timeline-commit-types.ts';
import { AuthoredState, MoveRecording } from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

const ref = 'parent/clip:c';
const present = (value: JSON): AgentState => ({ state: 'present', value });
const absent: AgentState = { state: 'absent' };
function fixture(params: Record<string, JSON> = {}) {
  const row = { id: 'c', params };
  const bundle: AuthoredBundle = { parent: { clips: [row] }, placements: [], shots: {} };
  return { row, bundle, state: new AuthoredState(bundle) };
}

describe('AuthoredState own JSON writes', () => {
  it.each([null, false, 0, '', [], { keep: 1 }].map((value) => ({ value })))(
    'writes __proto__ as own data: $value', ({ value }) => {
      const { row, state } = fixture();
      const prototype = Object.getPrototypeOf(row.params);
      const globalDescriptors = Object.getOwnPropertyDescriptors(Object.prototype);
      state.set(ref, ['params', '__proto__'], present(value));
      expect(Object.hasOwn(row.params, '__proto__')).toBe(true);
      expect(state.get(ref, ['params', '__proto__'])).toEqual(present(value));
      expect(JSON.stringify(row.params)).toBe(JSON.stringify(Object.fromEntries([['__proto__', value]])));
      expect(Object.getPrototypeOf(row.params)).toBe(prototype);
      expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(globalDescriptors);
    },
  );

  it.each(['__proto__', 'constructor', 'toString', 'literal.key', 'a::b', '[0]', ''])(
    'creates, overwrites, clones and clears literal own key %j', (key) => {
      const { row, state } = fixture();
      const value = { keep: [false, null] };
      state.set(ref, ['params', key], present(value));
      value.keep.push(true);
      expect(state.get(ref, ['params', key])).toEqual(present({ keep: [false, null] }));
      state.set(ref, ['params', key], present(null));
      expect(Object.hasOwn(row.params, key)).toBe(true);
      expect(state.get(ref, ['params', key])).toEqual(present(null));
      state.set(ref, ['params', key], absent);
      state.set(ref, ['params', key], absent);
      expect(Object.hasOwn(row.params, key)).toBe(false);
      expect(state.get(ref, ['params', key])).toEqual(absent);
    },
  );

  it.each(['__proto__', 'constructor', 'toString', 'inherited'])(
    'refuses unrecorded inherited container descent through %s', (key) => {
      const inherited = { keep: 1 };
      const params = Object.create(Object.fromEntries([[key, inherited]])) as Record<string, JSON>;
      const { state } = fixture(params);
      const prototype = Object.getPrototypeOf(params);
      for (const after of [present(2), absent]) {
        expect(() => state.set(ref, ['params', key, 'keep'], after))
          .toThrow('write requires recorded container creation');
      }
      expect(inherited).toEqual({ keep: 1 });
      expect(Object.getPrototypeOf(params)).toBe(prototype);
      expect(Object.keys(params)).toEqual([]);
    },
  );

  it('can descend through an explicitly owned __proto__ container', () => {
    const { row, state } = fixture(JSON.parse('{"__proto__":{"keep":1}}'));
    const prototype = Object.getPrototypeOf(row.params);
    state.set(ref, ['params', '__proto__', 'keep'], present(null));
    expect(state.get(ref, ['params', '__proto__', 'keep'])).toEqual(present(null));
    expect(Object.getPrototypeOf(row.params)).toBe(prototype);
  });

  it.each([undefined, null, [], 1, false, ''].map((value) => ({ value })))(
    'refuses a missing or non-object container: $value', ({ value }) => {
      const { row, state } = fixture();
      if (value !== undefined) row.params.nested = value;
      const snapshot = structuredClone(row);
      expect(() => state.set(ref, ['params', 'nested', 'x'], present(1)))
        .toThrow('write requires recorded container creation');
      expect(row).toEqual(snapshot);
    },
  );

  it('records unchanged own leaf writes and absent clears with their original guards', () => {
    const { bundle } = fixture(JSON.parse('{"__proto__":null}'));
    const recorder = new MoveRecording(bundle, {
      schema_version: 1, op: 'clip.set-params', version: '1', select: ref, args: {},
    });
    recorder.write(ref, ['params', '__proto__'], null);
    recorder.clear(ref, ['params', 'toString']);
    expect(recorder.command.expect).toEqual({
      [`${ref}::params.__proto__`]: present(null), [`${ref}::params.toString`]: absent,
    });
    expect(recorder.record.writes).toEqual([
      { ref, path: ['params', '__proto__'], before: present(null), after: present(null) },
      { ref, path: ['params', 'toString'], before: absent, after: absent },
    ]);
    expect(recorder.state.get(ref, ['params', '__proto__'])).toEqual(present(null));
    expect(recorder.state.get(ref, ['params', 'toString'])).toEqual(absent);
  });
});

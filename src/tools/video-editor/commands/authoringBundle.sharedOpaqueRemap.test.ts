// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type JSON } from '@/integrations/runtime/timeline-commit-types.ts';
import { remapItems } from './authoringBundle.ts';

type JSONRecord = { [key: string]: JSON };
type FixtureCase = {
  name: string;
  item_ids: Record<string, string>;
  payload: JSONRecord;
  expected: JSONRecord;
};
type Fixture = { schema: string; cases: FixtureCase[] };

const fixtureText = readFileSync(new URL('./fixtures/corpus/opaque_remap.json', import.meta.url), 'utf8');
// Native JSON.parse gives semantic numbers: lexical 0 and 0.0 intentionally
// collapse here, so this test does not claim wire-text preservation.
const fixture = JSON.parse(fixtureText) as unknown as Fixture;

describe('Agent shared opaque remap corpus', () => {
  it('matches parsed native output and preserves input for every published case', () => {
    expect(Buffer.byteLength(fixtureText)).toBe(5866);
    expect(createHash('sha256').update(fixtureText).digest('hex'))
      .toBe('49228930598f19ca3055cb442af9519ef2f8d4b6a2a98c799d4a78baa55c8e66');
    expect(fixture.schema).toBe('opaque-remap/v1');

    for (const testCase of fixture.cases) {
      const source = structuredClone(testCase.payload);
      const before = structuredClone(source);
      const result = remapItems(source, new Map(Object.entries(testCase.item_ids)));
      expect(result, testCase.name).toEqual(testCase.expected);
      expect(source, `${testCase.name} input mutation`).toEqual(before);
    }
  });

  it('rejects bounded near-miss outputs', () => {
    const testCase = fixture.cases.find(({ name }) => name === 'numeric_zero_and_float_zero_stay_untouched')!;
    const actual = remapItems(
      structuredClone(testCase.payload),
      new Map(Object.entries(testCase.item_ids)),
    );
    const firstItem = (actual.items as JSONRecord[])[0];

    const numericChanged = structuredClone(actual);
    ((numericChanged.items as JSONRecord[])[0]).at = 1;
    expect(numericChanged).not.toEqual(actual);

    const keyAdded = structuredClone(actual);
    ((keyAdded.items as JSONRecord[])[0]).unexpected = null;
    expect(keyAdded).not.toEqual(actual);

    const keyRemoved = structuredClone(actual);
    delete ((keyRemoved.items as JSONRecord[])[0]).at;
    expect(keyRemoved).not.toEqual(actual);

    const arrayAppended = structuredClone(actual);
    (arrayAppended.items as JSON[]).push(null);
    expect(arrayAppended).not.toEqual(actual);

    expect(firstItem.at).toBe(0);
  });

  it('keeps prototype-looking keys as ordinary opaque own data', () => {
    const payload = JSON.parse(
      '{"items":[{"item_id":"item-1","__proto__":{"item_id":"item-1"},"constructor":"item-1","prototype":"item-1","metadata":{"source_item_id":"item-1","__proto__":{"constructor":"item-1"}}}],"__proto__":{"constructor":{"prototype":"item-1"}},"constructor":"item-1","prototype":"item-1"}',
    ) as JSONRecord;
    const result = remapItems(payload, new Map([['item-1', 'item-9']]));
    const item = (result.items as JSONRecord[])[0];

    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.hasOwn(result, 'constructor')).toBe(true);
    expect(Object.hasOwn(result, 'prototype')).toBe(true);
    expect(Object.hasOwn(item, '__proto__')).toBe(true);
    expect(Object.hasOwn(item, 'constructor')).toBe(true);
    expect(Object.hasOwn(item, 'prototype')).toBe(true);
    expect(item.item_id).toBe('item-9');
    expect(item.constructor).toBe('item-1');
    expect(item.prototype).toBe('item-1');
    expect((item.metadata as JSONRecord).source_item_id).toBe('item-9');
    expect((item.metadata as JSONRecord).__proto__).toEqual({ constructor: 'item-1' });
    expect(result.__proto__).toEqual({ constructor: { prototype: 'item-1' } });
    expect(result.constructor).toBe('item-1');
    expect(result.prototype).toBe('item-1');
  });
});

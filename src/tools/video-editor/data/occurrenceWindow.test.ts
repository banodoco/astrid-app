import { describe, expect, it } from 'vitest';

import {
  OccurrenceOffsetError,
  occurrenceOffsetIsValid,
  readOccurrenceSourceOffsetMs,
  readOccurrenceSourceOffsetSeconds,
  visibleSpan,
} from './occurrenceWindow.ts';

describe('occurrence source_offset rule', () => {
  it.each([
    ['a valid scalar', 2000, 2000],
    ['a valid {start, end} mapping (only start is read)', { start: 2000, end: 7 }, 2000],
    ['the legacy zero mapping', { start: 0, end: 0 }, 0],
    ['zero', 0, 0],
    ['absent', undefined, 0],
    ['null', null, 0],
    ['a mapping with no start', { end: 5 }, 0],
  ])('accepts %s', (_label, value, ms) => {
    expect(readOccurrenceSourceOffsetMs(value)).toBe(ms);
    expect(occurrenceOffsetIsValid(value)).toBe(true);
  });

  it.each([
    ['a negative scalar', -1],
    ['a negative mapping start', { start: -250, end: 0 }],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a mapping with a non-numeric start', { start: 'soon', end: 0 }],
    ['a string', '2000'],
    ['a boolean', true],
    ['an array', [0]],
  ])('refuses %s', (_label, value) => {
    expect(() => readOccurrenceSourceOffsetMs(value)).toThrow(OccurrenceOffsetError);
    expect(occurrenceOffsetIsValid(value)).toBe(false);
  });

  it('reads seconds', () => {
    expect(readOccurrenceSourceOffsetSeconds({ start: 1500, end: 0 })).toBe(1.5);
  });
});

describe('occurrence crop rule (the same vectors as the Agent and Runtime helpers)', () => {
  it('cuts a child span to the window', () => {
    expect(visibleSpan(1000, 5000, 2000, 4000)).toEqual([2000, 5000]);
    expect(visibleSpan(0, 2000, 2000, 4000)).toBeNull();
    expect(visibleSpan(1000, 10000, 2000, 4000)).toEqual([2000, 6000]);
  });
});

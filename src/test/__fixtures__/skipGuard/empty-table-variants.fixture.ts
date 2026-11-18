import { describe, expect, it } from 'vitest';

it('ordinary passing test beside the table', () => expect(true).toBe(true));

if (process.env.P39_TABLE_FORMAT === 'tagged') {
  describe.each`row\n${1}\n${2}`('tagged each suite $row', ({ row }) => {
    it('retains the row', () => expect(row).toBeGreaterThan(0));
  });
  it.for`row\n${1}\n${2}`('tagged for test $row', ({ row }) => expect(row).toBeGreaterThan(0));
  describe.for`row\n${1}\n${2}`('tagged for suite $row', ({ row }) => {
    it('retains the row', () => expect(row).toBeGreaterThan(0));
  });
} else {
  const rows = process.env.P39_TABLE_ROWS === 'nonempty' ? [1, 2] : Array.from([]);
  if (process.env.P39_TABLE_API === 'describe.each') {
    describe.each(rows)('each suite row %s', (row) => {
      it('retains the row', () => expect(row).toBeGreaterThan(0));
    });
  } else if (process.env.P39_TABLE_API === 'it.for') {
    it.for(rows)('for test row %s', (row) => expect(row).toBeGreaterThan(0));
  } else if (process.env.P39_TABLE_API === 'describe.for') {
    describe.for(rows)('for suite row %s', (row) => {
      it('retains the row', () => expect(row).toBeGreaterThan(0));
    });
  } else {
    throw new Error('the fixture requires an explicit table API');
  }
}

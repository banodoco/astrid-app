import { expect, it } from 'vitest';

it('ordinary passing test beside the table', () => expect(true).toBe(true));

if (process.env.P39_EACH_LITERAL === '1') {
  it.each([])('literal empty table row %s', () => {});
} else {
  const rows = process.env.P39_EACH_ROWS === 'nonempty' ? [1, 2] : Array.from([]);
  it.each(rows)('evaluated table row %s', (value) => expect(value).toBeGreaterThan(0));
}

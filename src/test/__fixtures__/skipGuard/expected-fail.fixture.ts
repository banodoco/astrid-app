import { expect, it } from 'vitest';

it.fails('an undeclared expected failure', () => {
  expect(1).toBe(2);
});
it('an ordinary passing test', () => {});

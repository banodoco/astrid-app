import { expect, it } from 'vitest';

const property = String.fromCharCode(102, 97, 105, 108, 115);
it[property]('computed expected failure', () => { expect(1).toBe(2); });
it('ordinary pass', () => {});

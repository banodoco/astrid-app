import { it } from 'vitest';
import { skipWhen as declared } from '../../declaredSkip';

for (const name of ['one', 'two']) {
  it(`loop ${name}`, (ctx) => { declared('direct-journey-harness', ctx); });
}
it('ordinary pass', () => {});

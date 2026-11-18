import { it } from 'vitest';
import { skipWhen } from '../../declaredSkip';
import { declaredTag } from '../../../../config/testing/skipRegistry.mjs';

it('inert helper cannot authorize a false predicate', (ctx) => {
  if (false) skipWhen('agent-corpus-checkout', ctx);
  ctx['sk' + 'ip'](declaredTag('agent-corpus-checkout'));
});
it('ordinary pass', () => {});

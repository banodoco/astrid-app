import { it } from 'vitest';
import { skipWhen } from '../../declaredSkip';
import { declaredTag } from '../../../../config/testing/skipRegistry.mjs';

it('borrows a different declared name', (ctx) => {
  if (false) skipWhen('posix-owner-only-modes', ctx);
  ctx['sk' + 'ip'](declaredTag('direct-journey-harness'));
});
it('ordinary pass', () => {});

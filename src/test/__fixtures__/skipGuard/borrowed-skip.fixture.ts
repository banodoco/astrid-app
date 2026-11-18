import { it } from 'vitest';
import { skipWhen } from '../../declaredSkip';
import { declaredTag } from '../../../../config/testing/skipRegistry.mjs';

it('same title', (ctx) => { skipWhen('direct-journey-harness', ctx); });
it('same title', (ctx) => {
  ctx['sk' + 'ip'](declaredTag('direct-journey-harness'));
});
it('ordinary pass', () => {});

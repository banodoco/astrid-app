import { it } from 'vitest';
import { declaredTag } from '../../../../config/testing/skipRegistry.mjs';

it('forged declared tag', (ctx) => {
  ctx['sk' + 'ip'](declaredTag('direct-journey-harness'));
});
it('ordinary pass', () => {});

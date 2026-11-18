import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';
import { RUNTIME_RESTORE_INCLUDE } from './vitestIncludes.mjs';

// Socket-based proof, run by the central test service rather than the unit lane.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: RUNTIME_RESTORE_INCLUDE,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});

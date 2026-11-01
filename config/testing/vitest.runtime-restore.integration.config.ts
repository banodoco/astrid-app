import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

// Socket-based proof, run by the central test service rather than the unit lane.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/integration/runtimeRestore.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});

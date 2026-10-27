import { defineConfig } from '@playwright/test';

/** FX12 staging-only browser check. It attaches to the already-running staging app. */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['fx12-staging.spec.ts'],
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/fx12-staging',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.FX12_APP_ORIGIN ?? 'http://127.0.0.1:2412',
    trace: 'retain-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
});

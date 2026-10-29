import { defineConfig } from '@playwright/test';

// ASTRID_RUNTIME_CHECKOUT and ASTRID_APP_DIRECT_DIST select real historical artifacts.
export default defineConfig({
  testDir: './tests/e2e/local',
  testMatch: process.env.ASTRID_SKEW_MODE === 'release' ? 'skew-release.spec.ts' : 'skew.spec.ts',
  globalSetup: './tests/e2e/local/global-setup.ts',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/skew',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['./config/testing/playwrightSkipGuard.ts']],
  use: { trace: 'retain-on-failure' },
});

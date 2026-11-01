import { defineConfig } from '@playwright/test';

/** Focused I-AP-08 browser-door/outbox acceptance; no dev server or fake Runtime. */
export default defineConfig({
  testDir: '../../tests/e2e/local',
  testMatch: 'i-ap-08-bridge-outbox.spec.ts',
  globalSetup: '../../tests/e2e/local/global-setup.ts',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/i-ap-08',
  timeout: 180_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.IAP08_PLAYWRIGHT_JSON ?? 'test-results/i-ap-08/results.json' }],
    ['../../config/testing/playwrightSkipGuard.ts'],
  ],
  use: { acceptDownloads: true, trace: 'retain-on-failure' },
});

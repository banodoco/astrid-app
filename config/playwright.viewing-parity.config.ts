import { defineConfig } from '@playwright/test';

// The parity fixture owns its real Runtime, pack host and verified browser.
// Execution still requires an owner-frozen tuple and venue approval.
export default defineConfig({
  testDir: '../tests/e2e/timeline',
  testMatch: 'player-export-frame-parity.spec.ts',
  globalSetup: '../tests/e2e/local/global-setup.ts',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? '../test-results/viewing-parity',
  timeout: 180_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['./testing/playwrightSkipGuard.ts']],
  use: { acceptDownloads: true, trace: 'retain-on-failure' },
});

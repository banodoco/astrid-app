import { defineConfig } from '@playwright/test';

// Same-machine "direct" journey (Plan A, phase A0): production build on a hosted-style HTTPS origin,
// a real Runtime daemon on throwaway SQLite with its browser door, and Chromium.
// Run with: npm run test:e2e:direct
export default defineConfig({
  testDir: './tests/e2e/local',
  testMatch: ['direct-journey.spec.ts', 'settings-persist.spec.ts'],
  globalSetup: './tests/e2e/local/global-setup.ts',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/direct',
  // Hang guard only (R-10): durations are reported, never judged.
  timeout: 180_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['./config/testing/playwrightSkipGuard.ts'], ['./scripts/ci/ceiling_playwright.ts']],
  use: {
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
});

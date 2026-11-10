import { defineConfig } from '@playwright/test';

// Focused proof for the three-products journey's credential capture.
export default defineConfig({
  testDir: './tests/e2e/local/support',
  testMatch: 'tokenSniff.spec.ts',
  workers: 1,
  use: { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } },
});

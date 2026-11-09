import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

// Reuse the repo's isolated dev servers and fixtures, but never pass Chromium
// launch flags to WebKit. The normal e2e matrix remains unchanged.
export default defineConfig({
  ...base,
  // Keep the first pass's screenshots instead of clearing all test-results.
  outputDir: 'test-results/vision-webkit',
  use: { ...base.use, launchOptions: {} },
  projects: [{
    name: 'vision-webkit',
    testMatch: '**/public-astrid-vision-wayfinding.spec.ts',
    use: { ...devices['Desktop Safari'], launchOptions: {} },
  }],
});

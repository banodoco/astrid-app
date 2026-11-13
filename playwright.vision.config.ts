import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** Native dialog and touch regression gate, including Safari's WebKit engine. */
export default defineConfig({
  ...base,
  // A cold Vite transform and high-DPI WebKit compete for the same CI CPU.
  // Serialize this six-test browser gate; retain failures without retrying them.
  workers: 1,
  timeout: 60_000,
  testMatch: '**/public-astrid-vision-aspirations.spec.ts',
  use: { ...base.use, launchOptions: {} },
  projects: [
    { name: 'vision-webkit-phone', use: { ...devices['iPhone 13'], launchOptions: {} } },
  ],
});

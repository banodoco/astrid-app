import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** Native dialog and touch regression gate, including Safari's WebKit engine. */
export default defineConfig({
  ...base,
  // Cold Vite transforms and full-width 3x WebKit screenshots share the CI CPU.
  // Run 43428020937 reached its final navigation after capturing at 58 seconds;
  // allow the complete capture-and-interaction case to finish, without retries.
  workers: 1,
  timeout: 90_000,
  testMatch: ['**/public-astrid-vision-aspirations.spec.ts', '**/public-astrid-vision-mobile-catalogs.spec.ts'],
  use: { ...base.use, launchOptions: {} },
  projects: [
    { name: 'vision-webkit-phone', use: { ...devices['iPhone 13'], launchOptions: {} } },
  ],
});

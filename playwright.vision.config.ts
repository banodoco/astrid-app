import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** Native dialog and touch regression gate, including Safari's WebKit engine. */
export default defineConfig({
  ...base,
  testMatch: '**/public-astrid-vision-aspirations.spec.ts',
  use: { ...base.use, launchOptions: {} },
  projects: [
    { name: 'vision-webkit-phone', use: { ...devices['iPhone 13'], launchOptions: {} } },
  ],
});

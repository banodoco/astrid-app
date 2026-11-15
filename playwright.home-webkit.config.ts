import { defineConfig } from '@playwright/test';
import vision from './playwright.vision.config';

/** Real Home media and mobile disclosure motion, run on Apple-platform WebKit. */
export default defineConfig({
  ...vision,
  testMatch: ['**/public-astrid-home-chips.spec.ts'],
});

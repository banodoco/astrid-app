import { defineConfig } from '@playwright/test';
import baseline from './playwright.viewing-parity.config';

export default defineConfig({
  ...baseline,
  projects: [{ name: 'native-codec-chrome155', metadata: { viewingParityBrowserProfile: 'native-codec-chrome155' } }],
});

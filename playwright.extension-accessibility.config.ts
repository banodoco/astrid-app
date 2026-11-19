import { defineConfig, devices } from '@playwright/test';
import { fakeRuntimeEnv } from './tests/e2e/fake-runtime/launch.mjs';
import { astridOnboardedStorageState } from './tests/e2e/fixtures/astridOnboardedStorageState';
import {
  allocateIsolatedPort,
  readCanonicalBaseUrl,
  readPublishedPort,
  resolveCanonicalBaseUrl,
} from './tests/e2e/timeline/isolated-port.mjs';

const allocatedPorts = new Set<number>();
const inheritedRunPorts = process.env.ASTRID_APP_EXTENSION_PORTS_ALLOCATED === '1';
const configuredBaseURL = readCanonicalBaseUrl();
if (configuredBaseURL && !process.env.PLAYWRIGHT_PORT) process.env.PLAYWRIGHT_PORT = String(configuredBaseURL.port);
const port = inheritedRunPorts
  ? readPublishedPort('PLAYWRIGHT_PORT')
  : allocateIsolatedPort('PLAYWRIGHT_PORT', allocatedPorts);
const fakeRuntimePort = inheritedRunPorts
  ? readPublishedPort('FAKE_RUNTIME_PORT')
  : allocateIsolatedPort('FAKE_RUNTIME_PORT', allocatedPorts);
const baseURL = resolveCanonicalBaseUrl(port);
const fakeRuntimeViteEnv = fakeRuntimeEnv({ port: fakeRuntimePort });

process.env.BASE_URL = baseURL;
process.env.PLAYWRIGHT_BASE_URL = baseURL;
process.env.ASTRID_APP_EXTENSION_PORTS_ALLOCATED = '1';

/**
 * Accessibility and responsive release gate for the bundled editor extensions.
 *
 * This lane intentionally uses only Playwright-downloaded engines. It never
 * selects the user's installed Chrome/Edge channels or a persistent profile.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /extension-accessibility\.spec\.ts$/,
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/extension-accessibility',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: [[process.env.CI ? 'github' : 'list'], ['./config/testing/playwrightSkipGuard.ts'], ['./scripts/ci/ceiling_playwright.ts']],
  use: {
    baseURL,
    storageState: astridOnboardedStorageState(baseURL),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `npm run dev -- --mode test --host 127.0.0.1 --port ${port}`,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        // One fake Runtime serves workspace.v1, the `/api/astrid` bridge routes and the ACP read, behind one token.
        ...fakeRuntimeViteEnv,
      },
    },
    {
      command: 'node tests/e2e/fake-runtime/launch.mjs --serve',
      // workspace.json is the one open route; every other route needs the token.
      url: `http://127.0.0.1:${fakeRuntimePort}/runtime-config/v1/workspace.json`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        FAKE_RUNTIME_PORT: String(fakeRuntimePort),
        FAKE_RUNTIME_TOKEN_FILE: fakeRuntimeViteEnv.FAKE_RUNTIME_TOKEN_FILE,
      },
    },
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});

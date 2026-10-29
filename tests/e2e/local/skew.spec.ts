/** Real artifacts selected by the CI matrix: current App / pre-updater Runtime and
 * pre-updater App / candidate Runtime. No health or handshake response is mocked. */
import { expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RUNTIME_ACCEPTED_SCHEMA_DIGESTS } from '../../../src/integrations/runtime/contract-metadata.ts';
import { openApp, test, UI } from './support/app.ts';
import type { DirectHarness } from './support/harness.ts';

const mode = process.env.ASTRID_SKEW_MODE;
if (mode !== 'old-runtime' && mode !== 'old-app' && mode !== 'candidate-rejected') throw new Error('Set ASTRID_SKEW_MODE to old-runtime, old-app or candidate-rejected');

function readDoorAudit(harness: DirectHarness) {
  return readFileSync(harness.auditPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { method: string; path: string; status: number });
}

async function waitForDoorAudit(harness: DirectHarness, predicate: (entries: ReturnType<typeof readDoorAudit>) => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const entries = readDoorAudit(harness);
      if (predicate(entries)) return entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Door audit did not record the expected request within ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('real App and Runtime artifacts connect or show their recovery action', async ({ page, harness }) => {
  const health = await (await harness.runtimeFetch('/v1/health')).json() as { schema_digest?: string };
  const expectedDigest = mode === 'old-runtime'
    ? 'sha256:9061d4982c786e04d99e45470b8ea4f3d9c9ff9855c4a2f83d751a93408c205b' // Runtime 11443b0
    : 'sha256:5d229bf66ffaeb0b4937844a3c2b08ddd21f97cbcc305101a5cc19a95c971194'; // Runtime 959ce04
  expect(health.schema_digest).toBe(expectedDigest);
  let before = 0;
  let outcome: 'connected' | 'recovery' | 'incomplete' = 'incomplete';
  try {
    const doorHealth = await harness.doorRequest('/v1/health');
    expect(doorHealth.status).toBe(200);
    const probeAudit = await waitForDoorAudit(harness, entries => entries.some(entry => entry.path === '/v1/health' && entry.status === 200));
    before = probeAudit.length;
    await openApp(page, harness);
    const connected = page.locator(`${UI.status}[data-state="connected"]`);
    const update = page.getByText('Update Astrid', { exact: true });
    const reload = page.getByRole('button', { name: 'Reload' });
    await expect.poll(async () => (await connected.count()) > 0 || (await update.isVisible().catch(() => false)) || (await reload.isVisible().catch(() => false))).toBe(true);
    const allAudit = await waitForDoorAudit(harness, entries => entries.slice(before).some(entry => entry.path === '/v1/health' && entry.status === 200));
    const observedAudit = allAudit.slice(before);
    expect(observedAudit.some(({ path: requestPath }) => requestPath === '/v1/health'), 'the real door recorded a health read').toBe(true);
    if (mode === 'old-runtime' && RUNTIME_ACCEPTED_SCHEMA_DIGESTS.includes(health.schema_digest as typeof RUNTIME_ACCEPTED_SCHEMA_DIGESTS[number])) {
      await expect(connected).toHaveCount(1);
      outcome = 'connected';
    } else {
      if (mode !== 'old-runtime') expect(RUNTIME_ACCEPTED_SCHEMA_DIGESTS).not.toContain(health.schema_digest);
      await expect(update.or(reload).first()).toBeVisible();
      const writes = observedAudit.filter(({ method }) => !['GET', 'HEAD', 'OPTIONS'].includes(method));
      expect(writes, 'rejected Runtime receives no writes through the door').toEqual([]);
      outcome = 'recovery';
    }
  } finally {
    const output = process.env.PLAYWRIGHT_OUTPUT_DIR ?? path.resolve('test-results/skew');
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, `skew-evidence-${mode}.json`), JSON.stringify({
      mode,
      appSha: process.env.ASTRID_SKEW_APP_SHA,
      runtimeSha: process.env.ASTRID_SKEW_RUNTIME_SHA,
      health,
      outcome,
      audit: readDoorAudit(harness),
    }, null, 2));
  }
});

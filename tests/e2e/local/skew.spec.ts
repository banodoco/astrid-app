/** Real artifacts selected by the CI matrix: current App / pre-updater Runtime and
 * pre-updater App / candidate Runtime. No health or handshake response is mocked. */
import { expect } from '@playwright/test';
import { RUNTIME_ACCEPTED_SCHEMA_DIGESTS } from '../../../src/integrations/runtime/contract-metadata.ts';
import { openApp, test, UI } from './support/app.ts';

const mode = process.env.ASTRID_SKEW_MODE;
if (mode !== 'old-runtime' && mode !== 'old-app' && mode !== 'candidate-rejected') throw new Error('Set ASTRID_SKEW_MODE to old-runtime, old-app or candidate-rejected');

test('real App and Runtime artifacts connect or show their recovery action', async ({ page, harness }) => {
  const health = await (await harness.runtimeFetch('/v1/health')).json() as { schema_digest?: string };
  const expectedDigest = mode === 'old-runtime'
    ? 'sha256:9061d4982c786e04d99e45470b8ea4f3d9c9ff9855c4a2f83d751a93408c205b' // Runtime 11443b0
    : 'sha256:5d229bf66ffaeb0b4937844a3c2b08ddd21f97cbcc305101a5cc19a95c971194'; // Runtime 959ce04
  expect(health.schema_digest).toBe(expectedDigest);
  const before = harness.audit().length;
  await openApp(page, harness);
  const connected = page.locator(`${UI.status}[data-state="connected"]`);
  const update = page.getByText('Update Astrid', { exact: true });
  const reload = page.getByRole('button', { name: 'Reload' });
  await expect.poll(async () => (await connected.count()) > 0 || (await update.isVisible().catch(() => false)) || (await reload.isVisible().catch(() => false))).toBe(true);
  if (mode === 'old-runtime') {
    if (RUNTIME_ACCEPTED_SCHEMA_DIGESTS.includes(health.schema_digest as typeof RUNTIME_ACCEPTED_SCHEMA_DIGESTS[number])) {
      await expect(connected).toHaveCount(1);
    } else {
      await expect(update).toBeVisible();
      const writes = harness.audit().slice(before).filter(({ method }) => !['GET', 'HEAD', 'OPTIONS'].includes(method));
      expect(writes, 'rejected Runtime receives no writes through the door').toEqual([]);
    }
  } else if (mode === 'candidate-rejected') {
    expect(RUNTIME_ACCEPTED_SCHEMA_DIGESTS).not.toContain(health.schema_digest);
    await expect(update).toBeVisible();
    expect(harness.audit().slice(before).filter(({ method }) => !['GET', 'HEAD', 'OPTIONS'].includes(method))).toEqual([]);
  } else if (!(await connected.count())) {
    await expect(update.or(reload).first()).toBeVisible();
  }
});

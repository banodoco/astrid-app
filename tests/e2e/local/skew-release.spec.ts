/** Run with ASTRID_SKEW_MODE=release and ASTRID_QUICK_DESCRIPTOR pointing to a
 * disposable, seeded compatible installer-managed Runtime. Health is never mocked;
 * only the hosted release manifest is controlled to exercise both boundaries. */
import { expect, type Page } from '@playwright/test';
import { openApp, expectConnected, test } from './support/app.ts';
import { RUNTIME_ACCEPTED_SCHEMA_DIGESTS } from '../../../src/integrations/runtime/contract-metadata.ts';
import type { DirectHarness } from './support/harness.ts';

async function installedRelease(harness: DirectHarness): Promise<number> {
  if (!process.env.ASTRID_QUICK_DESCRIPTOR) throw new Error('Release cases require a disposable installer Runtime via ASTRID_QUICK_DESCRIPTOR');
  const health = await (await harness.runtimeFetch('/v1/health')).json() as { release?: unknown; schema_digest?: string; identity?: { managed_by?: string | null } };
  if (!Number.isSafeInteger(health.release) || (health.release as number) < 1 || !health.identity || health.identity.managed_by !== null) {
    throw new Error(`Release cases require a real installed Runtime with positive release, got ${JSON.stringify(health)}`);
  }
  if (!RUNTIME_ACCEPTED_SCHEMA_DIGESTS.includes(health.schema_digest as typeof RUNTIME_ACCEPTED_SCHEMA_DIGESTS[number])) {
    throw new Error(`Release cases require a compatible Runtime; got digest ${health.schema_digest}`);
  }
  return health.release as number;
}

async function serveManifest(page: Page, manifest: object) {
  await page.route('**/install-manifest.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) }));
}

test('installed Runtime newer than served has a quiet notice', async ({ page, harness }) => {
  const release = await installedRelease(harness);
  await serveManifest(page, { release: release - 1 });
  const manifestRead = page.waitForResponse(response => response.url().endsWith('/install-manifest.json') && response.ok());
  await openApp(page, harness);
  await expectConnected(page);
  await manifestRead;
  await expect(page.getByTestId('quiet-update-notice')).toContainText('newer than astrid.haus');
});

test('installed Runtime below a required release shows the required card', async ({ page, harness }) => {
  const release = await installedRelease(harness);
  await serveManifest(page, { release: release + 1, required: { release: release + 1, reason: 'Skew contract requirement' } });
  await openApp(page, harness);
  await expectConnected(page);
  const notice = page.getByTestId('quiet-update-notice');
  await expect(notice).toContainText('Update Astrid');
  await expect(notice).toContainText('This update is required: Skew contract requirement');
});

/**
 * User settings are kept by the Runtime, not the browser: change the Tasks pane lock, wait for the Runtime's
 * `ui.panes` record, clear this browser's storage, reload, and the lock is still as chosen.
 *
 *   npm run test:e2e:settings-persist   (the direct lane's config; runs the real Runtime on a throwaway realm, on the
 *                                        door port from ASTRID_APP_DIRECT_DOOR_PORT)
 */
import { expect, type Page } from '@playwright/test';
import { EDITOR_TOUR_VERSION } from '../../../src/shared/lib/editorTourVersion.ts';
import { skipWhen } from '../support/declaredSkip.ts';
import { expectConnected, openApp, test } from './support/app.ts';

/** The Tasks pane's edge tab: "Unlock pane" while the pane is locked open, "Lock pane" while it is not. */
function tasksPaneLock(page: Page) {
  return page.locator('div')
    .filter({ has: page.getByRole('button', { name: /^Open Action pane/ }) })
    .filter({ has: page.getByRole('button', { name: /^(Lock|Unlock) pane$/ }) })
    .last()
    .getByRole('button', { name: /^(Lock|Unlock) pane$/ });
}
const SNAPSHOT_KEY = 'astrid.settings.snapshot.v1:ui.panes';

test.describe.configure({ mode: 'serial' });
test.beforeEach(() => {
  skipWhen('direct-journey-harness');
});

test('a changed Tasks pane lock holds after clearing the browser and reloading (the Runtime holds it)', async ({ page, harness }) => {
  // The first-run tour would cover the page: the Runtime already has this person's tour record.
  const tour = await harness.runtimeJson('PUT', '/v1/app-state/user/editor-tour', {
    content: { version: EDITOR_TOUR_VERSION, outcome: 'skipped', step: 'act1/start', at: new Date().toISOString() },
    expected_version: 0,
  });
  expect(tour.status).toBe(200);

  await openApp(page, harness);
  await expectConnected(page);

  // Flip whatever the first visit shows, so the proof is the change and not the default.
  const wasLocked = (await tasksPaneLock(page).getAttribute('aria-label')) === 'Unlock pane';
  const locked = !wasLocked;
  await tasksPaneLock(page).click();
  await expect(tasksPaneLock(page)).toHaveAttribute('aria-label', locked ? 'Unlock pane' : 'Lock pane');

  // The Runtime has the record once the change is saved.
  await expect.poll(async () => {
    const state = await harness.runtimeJson('GET', '/v1/app-state/user/ui.panes');
    return state.body?.content?.['tasks.locked'];
  }, { timeout: 0 }).toBe(locked);

  // Forget everything this browser knows.
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  expect(await page.evaluate((key) => localStorage.getItem(key), SNAPSHOT_KEY)).toBeNull();

  // This browser forgot its onboarding progress (welcomeProgress.ts is local), so it is shown the setup page.
  // The real way through is "I've already set up Astrid" and Continue; that reconnects to the same Runtime.
  await page.reload();
  await page.getByRole('checkbox', { name: "I've already set up Astrid" }).check();
  await page.getByRole('button', { name: 'Continue to Astrid' }).click();
  await expectConnected(page);

  // Same choice: the value came back from the Runtime.
  await expect(tasksPaneLock(page)).toHaveAttribute('aria-label', locked ? 'Unlock pane' : 'Lock pane');
});

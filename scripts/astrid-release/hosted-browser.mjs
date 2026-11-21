// Real installed editor proof. No mocked routes, client state, or runtime responses.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const [root, evidence, mode] = process.argv.slice(2);
assert.equal(process.platform, 'darwin');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.GITHUB_REF, 'refs/heads/p61/rb-6');
assert.ok(['play', 'edit', 'verify-edit'].includes(mode));
const { chromium, expect } = createRequire(path.join(root, 'editor/package.json'))('@playwright/test');
const state = JSON.parse(readFileSync(path.join(evidence, 'context.json'), 'utf8'));
const port = readFileSync(path.join(root, 'state/ports'), 'utf8').trim().split(',')[0];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const stamp = `${mode}-${Date.now()}`;
const result = { mode, url: `http://127.0.0.1:${port}/tools/video-editor?entry=editor`, pageErrors: [], failedResponses: [] };
await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
const page = await context.newPage();
page.on('pageerror', error => result.pageErrors.push(error.message));
page.on('response', response => {
  if (response.status() >= 400 && response.url().startsWith(`http://127.0.0.1:${port}/`)) {
    result.failedResponses.push({ status: response.status(), url: response.url().replace(/\?.*$/, '') });
  }
});
async function head() {
  const response = await context.request.get(`http://127.0.0.1:${port}/api/runtime/v1/projects/${state.project_id}/timelines/${state.timeline_id}`);
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}
try {
  await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await expect(page.locator('[data-testid="runtime-not-connected"]')).toHaveCount(0, { timeout: 90_000 });
  await expect(page.getByRole('combobox', { name: 'Select project' })).toContainText('P61 live proof', { timeout: 90_000 });
  await expect(page.getByRole('combobox', { name: 'Select timeline' })).toContainText('Long-lived timeline', { timeout: 90_000 });
  const field = page.getByRole('textbox', { name: 'Track name' }).first();
  await expect(field).toBeVisible({ timeout: 90_000 });
  const initial = await head();
  result.before = { revision: initial.head_revision_id, publication: initial.head_publication_id };
  assert.ok(result.before.revision && result.before.publication);
  if (mode === 'edit') {
    await field.fill('P61 copied-realm edit');
    await field.press('Enter');
    await field.blur();
    await expect.poll(async () => (await head()).head_publication_id, { timeout: 60_000 }).not.toBe(initial.head_publication_id);
    await expect(field).toHaveValue('P61 copied-realm edit');
  } else if (mode === 'verify-edit') {
    await expect(field).toHaveValue('P61 copied-realm edit');
    assert.equal(initial.head_publication_id, state.edited_heads.find(item => item.timeline_id === state.timeline_id).publication_id);
  } else {
    assert.equal(initial.head_publication_id, state.seed_head.head_publication_id);
  }
  await expect(page.locator('[data-testid="preview-revision-unavailable"]')).toHaveCount(0);
  await expect(page.locator('[data-astrid-preview-frame-ready="true"]').first()).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: path.join(evidence, `${stamp}-timeline.png`), fullPage: true });
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  const position = page.getByRole('slider', { name: 'Playback position' });
  await expect(position).toBeVisible();
  result.frameBefore = Number(await position.getAttribute('aria-valuenow'));
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await position.getAttribute('aria-valuenow')), { timeout: 15_000 }).toBeGreaterThan(result.frameBefore + 10);
  result.framePlaying = Number(await position.getAttribute('aria-valuenow'));
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.screenshot({ path: path.join(evidence, `${stamp}-played.png`), fullPage: true });
  await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
  const after = await head();
  result.after = { revision: after.head_revision_id, publication: after.head_publication_id };
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL';
  result.error = String(error);
  await page.screenshot({ path: path.join(evidence, `${stamp}-failure.png`), fullPage: true }).catch(() => {});
  throw error;
} finally {
  writeFileSync(path.join(evidence, `${stamp}-playback.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  await context.tracing.stop({ path: path.join(evidence, `${stamp}-trace.zip`) });
  await browser.close();
}

import { expect, test, type APIRequestContext } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ORIGIN = process.env.FX12_APP_ORIGIN ?? 'http://127.0.0.1:2412';
const RUNTIME_ORIGIN = process.env.FX12_RUNTIME_ORIGIN ?? 'http://127.0.0.1:17440';
const PROJECT_NAME = `FX12-${Date.now()}`;
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = [
  path.resolve(here, '../../public/example-image1.jpg'),
  path.resolve(here, '../../public/example-image2.jpg'),
  path.resolve(here, '../../public/example-video.mp4'),
];
const timelineCreatePath = /^\/api\/runtime\/v1\/projects\/([^/]+)\/timelines$/;
const timelineCommitPath = /^\/api\/runtime\/v1\/projects\/([^/]+)\/timelines\/([^/]+)\/commit$/;

type TimelineHistory = { items: Array<Record<string, any>>; head: Record<string, string> };

async function readHistory(request: APIRequestContext, projectId: string, timelineId: string): Promise<TimelineHistory> {
  const response = await request.get(`${APP_ORIGIN}/api/runtime/v1/projects/${encodeURIComponent(projectId)}/timelines/${encodeURIComponent(timelineId)}/commits?limit=50`);
  const body = await response.text();
  expect(response.status(), body).toBe(200);
  return JSON.parse(body) as TimelineHistory;
}

test('FX12: Add media batches two images and one video into one undoable history entry', async ({ page }) => {
  // The explicitly configured runtime is the same staging discovery proxy used by the app.
  // Read through it before touching the UI so this check cannot silently target another realm.
  const runtimeHealth = await page.request.get(`${RUNTIME_ORIGIN}/v1/health`);
  expect(runtimeHealth.status(), await runtimeHealth.text()).toBe(200);

  await page.goto(`${APP_ORIGIN}/tools/video-editor`);
  await page.getByRole('button', { name: /Skip tour/ }).click();
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.locator('#project-name').fill(PROJECT_NAME);
  const timelineCreate = page.waitForRequest((request) => request.method() === 'POST' && timelineCreatePath.test(new URL(request.url()).pathname));
  const creating = page.getByRole('button', { name: 'Create Project', exact: true }).click();

  const createRequest = await timelineCreate;
  const createMatch = new URL(createRequest.url()).pathname.match(timelineCreatePath);
  expect(createMatch, 'new timeline request should name its project').toBeTruthy();
  const projectId = decodeURIComponent(createMatch![1]);
  const timelineId = (createRequest.postDataJSON() as { timeline_id?: string }).timeline_id;
  expect(timelineId, 'new timeline request should reserve its timeline ID').toBeTruthy();
  await creating;

  const addMedia = page.getByRole('button', { name: 'Add media', exact: true });
  await expect(addMedia).toBeVisible();
  await expect(addMedia).toBeEnabled();
  const initialHistory = await readHistory(page.request, projectId, timelineId!);
  const initialEntryCount = initialHistory.items.length;
  const initialPublications = new Set(initialHistory.items.map((entry) => entry.publication_id));
  const commitPosts: Array<Record<string, any>> = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && timelineCommitPath.test(new URL(request.url()).pathname)) {
      commitPosts.push(request.postDataJSON() as Record<string, any>);
    }
  });

  // Walk focus with Tab from the page's current focus, then activate the real visible button.
  let reachedAddMedia = false;
  for (let tab = 0; tab < 100; tab += 1) {
    await page.keyboard.press('Tab');
    if (await addMedia.evaluate((element) => element === document.activeElement)) {
      reachedAddMedia = true;
      break;
    }
  }
  expect(reachedAddMedia, 'Tab should reach the visible Add media control').toBe(true);

  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  const fileChooser = await fileChooserPromise;
  expect(fileChooser.isMultiple()).toBe(true);
  const mediaInput = page.getByLabel('Add media files');
  expect(await fileChooser.element().getAttribute('aria-label')).toBe('Add media files');
  await mediaInput.setInputFiles(fixtures);

  await expect(page.locator('.clip-action')).toHaveCount(3, { timeout: 120_000 });
  await expect.poll(async () => (await readHistory(page.request, projectId, timelineId!)).items.length, { timeout: 120_000 })
    .toBe(initialEntryCount + 1);
  expect(commitPosts).toHaveLength(1);
  expect(commitPosts[0].source).toEqual({ via: 'app' });
  const uploadedHistory = await readHistory(page.request, projectId, timelineId!);
  const newEntries = uploadedHistory.items.filter((entry) => !initialPublications.has(entry.publication_id));
  expect(newEntries).toHaveLength(1);
  expect(newEntries[0].source).toEqual({ via: 'app' });

  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(page.locator('.clip-action')).toHaveCount(0, { timeout: 120_000 });
});

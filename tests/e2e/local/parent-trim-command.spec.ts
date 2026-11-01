/** The existing parent source-window control through the native durable session. */
import { expect, type Page, type Route } from '@playwright/test';
import {
  commandOutboxes,
  expectConnected,
  openApp,
  openSeededTimeline,
  revisionBody,
  test as appTest,
} from './support/app.ts';
import { harnessUnavailableReason, type DirectHarness, type ThreeProductsSeed } from './support/harness.ts';
import { ASTRID_PYTHON } from './support/astrid.ts';
import type { CommitAcceptedMutation, CommitRequest, HeadPin, HistoryPage } from '../../../src/integrations/runtime/timeline-commit-types.ts';

const CEILING = { timeout: 90_000 };
const COMMITS = /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/;
const LEGACY_SAVES = /\/timelines\/[^/]+\/composition-revisions$/;

type CommitPost = {
  body: CommitRequest;
  rawBody: string;
  key: string;
  status: number | null;
  response: CommitAcceptedMutation | null;
};

const test = appTest.extend<object, { seed3: ThreeProductsSeed }>({
  seed3: [async ({ harness }, use) => { await use(await harness.seedThreeProducts()); }, { scope: 'worker', timeout: 240_000 }],
});

test.beforeAll(() => {
  const reason = harnessUnavailableReason();
  if (reason) throw new Error(`the parent-trim journey cannot run: ${reason}`);
  for (const name of ['TIMELINE_BUNDLE_AGENT_HEAD', 'TIMELINE_BUNDLE_RUNTIME_HEAD']) {
    if (!/^[0-9a-f]{40}$/.test(process.env[name] ?? '')) {
      throw new Error(`the parent-trim cohort requires ${name} as a full 40-character SHA`);
    }
  }
});

test.describe.configure({ mode: 'serial' });

function pinOf(result: CommitAcceptedMutation): HeadPin {
  return { revision_id: result.data.accepted_revision_id, publication_id: result.receipt.receipt_id };
}

async function history(harness: DirectHarness, seed: ThreeProductsSeed): Promise<HistoryPage> {
  const result = await harness.runtimeJson<HistoryPage>('GET',
    `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

async function parentAt(harness: DirectHarness, revisionId: string): Promise<Record<string, any>> {
  return (await revisionBody(harness, revisionId)).payload as Record<string, any>;
}

function parentClip(parent: Record<string, any>, clipId: string): Record<string, any> {
  const clips = (parent.clips as Array<Record<string, any>>).filter((clip) => clip.id === clipId);
  expect(clips, `${clipId} remains a literal parent clip`).toHaveLength(1);
  return clips[0];
}

function expectRawTrim(parent: Record<string, any>, original: Record<string, any>, clipId: string,
  expected: { from: number; to: number; hold: number }) {
  const expectedParent = structuredClone(original);
  for (const clips of [expectedParent.clips, expectedParent.config.clips]) {
    Object.assign((clips as Array<Record<string, any>>).find((clip) => clip.id === clipId)!, expected);
  }
  expect(parent).toEqual(expectedParent);
  expect(parent.config.x_f2_opaque).toEqual(original.config.x_f2_opaque);
  expect(parent.registry).toEqual(original.registry);
}

function observeTraffic(page: Page) {
  const posts: CommitPost[] = [];
  const legacy: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const pathname = new URL(request.url()).pathname;
    if (COMMITS.test(pathname)) {
      posts.push({ body: JSON.parse(request.postData() ?? '{}') as CommitRequest,
        rawBody: request.postData() ?? '', key: request.headers()['idempotency-key'], status: null, response: null });
    }
    if (LEGACY_SAVES.test(pathname)) legacy.push(pathname);
  });
  page.on('response', (response) => {
    if (response.request().method() !== 'POST' || !COMMITS.test(new URL(response.url()).pathname)) return;
    const post = [...posts].reverse().find((candidate) => candidate.key === response.request().headers()['idempotency-key']);
    if (!post) return;
    post.status = response.status();
    void response.json().then((body) => { post.response = body as CommitAcceptedMutation; }).catch(() => {});
  });
  return { posts, legacy };
}

async function waitForPost(posts: CommitPost[], index: number) {
  await expect.poll(() => posts[index]?.status, CEILING).not.toBeNull();
  await expect.poll(() => posts[index]?.response, CEILING).not.toBeNull();
  return posts[index];
}

async function openParent(page: Page, harness: DirectHarness) {
  await openApp(page, harness);
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await expect.poll(async () => (await commandOutboxes(page, harness.seed.timelineId)).some((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);
}

async function sourceWindow(page: Page, seed: ThreeProductsSeed) {
  await page.locator(`.clip-action[data-clip-id="${seed.transitionClipId}"]`).first().click();
  // Desktop selection opens the existing inspector on Effects; the same real
  // selection opens Timing on touch. Source In/Out are the media clip's
  // controls in that Timing tab.
  await page.getByRole('tab', { name: 'Timing', exact: true }).click();
  // Base UI labels the non-editable NumberField/ScrubField root. Its visible
  // native input is the real user-editable control; the sibling aria-hidden
  // input only participates in form validation.
  const scrubField = page.getByLabel('Source In');
  await expect(scrubField).toBeVisible();
  const input = scrubField.locator('input:not([aria-hidden="true"])');
  await expect(input).toBeEditable();
  return input;
}

async function changeSourceIn(page: Page, seed: ThreeProductsSeed, value: string) {
  const input = await sourceWindow(page, seed);
  await input.fill(value);
  await input.press('Enter');
  // Base UI commits editable NumberField text on blur; tab to the next real
  // field so this journey exercises the same discrete user commit as the
  // existing ClipPanelBody control test.
  await input.press('Tab');
  return input;
}

test('M2 parent trim: raw source window, reload, Runtime undo, lost ACK exact retry and zero legacy', async ({ page, harness, seed3 }) => {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  const traffic = observeTraffic(page);
  await openParent(page, harness);

  const before = await history(harness, seed3);
  const original = await parentAt(harness, before.head.revision_id);
  expect(parentClip(original, seed3.transitionClipId)).toMatchObject({ from: 0, to: 3 });
  const originalAppClip = structuredClone(parentClip(original, seed3.appClipId));

  await changeSourceIn(page, seed3, '0.5');
  await expect.poll(() => traffic.posts.length, CEILING).toBe(1);
  await waitForPost(traffic.posts, 0);
  const trimmed = traffic.posts[0];
  expect(trimmed.body).toMatchObject({
    base_revision_id: before.head.revision_id,
    base_publication_id: before.head.publication_id,
    commands: [expect.objectContaining({ schema_version: 1, op: 'clip.trim', version: '1',
      select: `parent/clip:${seed3.transitionClipId}`, args: { in_s: 0.5, out_s: null } })],
  });
  expect(trimmed.body).not.toHaveProperty('parent_composition');
  expect(trimmed.status).toBe(200);
  const trimResult = trimmed.response!;
  const trimmedParent = trimResult.data.canonical_document.parent_revision.payload as Record<string, any>;
  expectRawTrim(trimmedParent, original, seed3.transitionClipId, { from: 0.5, to: 3, hold: 2.5 });
  expect(parentClip(trimmedParent, seed3.appClipId)).toEqual(originalAppClip);
  const trimPin = pinOf(trimResult);

  // Reload reads the accepted source window; Undo is a real Runtime inverse, not a local reset.
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await expect((await sourceWindow(page, seed3))).toHaveValue('0.5');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => traffic.posts.length, CEILING).toBe(2);
  await waitForPost(traffic.posts, 1);
  expect(traffic.posts[1].body.commands).toEqual([{ schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
    args: { publications: [trimPin.publication_id] } }]);
  const undone = traffic.posts[1].response!;
  expect(undone.data.canonical_document.parent_revision.payload).toEqual(original);

  // The second real source-window edit is accepted by Runtime, then only its browser ACK is lost.
  let heldRoute: Route | undefined;
  let holdAck = true;
  const retryPosts: CommitPost[] = [];
  const retryTraffic = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const request = route.request();
    const response = await route.fetch({ maxRetries: 0 });
    const post: CommitPost = { body: JSON.parse(request.postData() ?? '{}') as CommitRequest,
      rawBody: request.postData() ?? '', key: request.headers()['idempotency-key'], status: response.status(), response: await response.json() };
    retryPosts.push(post);
    if (holdAck) heldRoute = route;
    else await route.fulfill({ response });
  };
  await page.route(COMMITS, retryTraffic);
  await changeSourceIn(page, seed3, '0.75');
  await expect.poll(() => retryPosts.length, CEILING).toBe(1);
  const originalRetry = retryPosts[0];
  expect(originalRetry.body.commands[0]).toMatchObject({ op: 'clip.trim', select: `parent/clip:${seed3.transitionClipId}`,
    args: { in_s: 0.75, out_s: null } });
  expect(originalRetry.status).toBe(200);
  holdAck = false;
  await heldRoute!.abort('connectionreset');
  await page.unroute(COMMITS, retryTraffic);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.pending)?.pending?.outcome?.kind, CEILING).toBe('retry');
  const owner = (await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.pending?.request.key === originalRetry.key)!;
  expect(owner.pending?.request).toMatchObject({ body: originalRetry.rawBody, key: originalRetry.key });
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  expect((await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.ownerId === owner.ownerId)?.pending?.request)
    .toMatchObject({ body: originalRetry.rawBody, key: originalRetry.key });
  const retriedResponse = page.waitForResponse((response) => response.request().method() === 'POST' && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await page.getByRole('button', { name: /^Recover saved edits/ }).and(page.locator(`[data-owner-id="${owner.ownerId}"]`)).click();
  const response = await retriedResponse;
  expect(response.status()).toBe(200);
  const retryRequest = response.request();
  expect(retryRequest.postData()).toBe(originalRetry.rawBody);
  expect(retryRequest.headers()['idempotency-key']).toBe(originalRetry.key);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).every((candidate) => !candidate.pending && !candidate.intents.length), CEILING).toBe(true);
  await expect((await sourceWindow(page, seed3))).toHaveValue('0.75');
  expect(traffic.legacy).toEqual([]);

  const retryResult = await response.json() as CommitAcceptedMutation;
  const retryParent = retryResult.data.canonical_document.parent_revision.payload as Record<string, any>;
  expectRawTrim(retryParent, original, seed3.transitionClipId, { from: 0.75, to: 3, hold: 2.25 });
  expect(parentClip(retryParent, seed3.appClipId)).toEqual(originalAppClip);
  expect((await history(harness, seed3)).items).toHaveLength(before.items.length + 3);
  await expect((await sourceWindow(page, seed3))).toHaveValue('0.75');
  expect(pinOf(retryResult).revision_id).toBeTruthy();
});

/** One real UI parent clip.split proof; compound and unsupported positives stay in their existing suites. */
import { expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { APP_ENTRY_ROUTE, commandOutboxes, expectConnected, firstTrackName, openApp, test as appTest } from './support/app.ts';
import { compositionPublication, harnessUnavailableReason, type DirectHarness, type ThreeProductsSeed } from './support/harness.ts';
import { ASTRID_PYTHON } from './support/astrid.ts';
import type { CommitAcceptedMutation, CommitRequest, HistoryPage } from '../../../src/integrations/runtime/timeline-commit-types.ts';

const CEILING = { timeout: 90_000 };
const COMMITS = /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/;
const LEGACY = /\/timelines\/[^/]+\/composition-revisions$/;
const SPLIT_AT = 1;
type SplitSeed = { projectSlug: string; timelineId: string; clipId: string; neighborId: string; headRevisionId: string };
type Post = { body: CommitRequest; raw: string; key: string; status?: number; result?: CommitAcceptedMutation };

const test = appTest.extend<object, { seed3: ThreeProductsSeed }>({
  seed3: [async ({ harness }, use) => { await use(await harness.seedThreeProducts()); }, { scope: 'worker', timeout: 240_000 }],
});
test.beforeAll(() => { const reason = harnessUnavailableReason(); if (reason) throw new Error(`parent split cannot run: ${reason}`); });

async function seedSplit(harness: DirectHarness): Promise<SplitSeed> {
  const timelineId = randomUUID(); const clipId = 'native-split-source'; const neighborId = 'native-split-neighbor'; const speed = 1.3;
  const clip = { id: clipId, at: 0, track: 'V1', clipType: 'media', asset: 'split-video', from: 0, to: 4, speed, hold: 4 / speed,
    app: { opaque: { root: 'keep', child: [null, false, 0] }, astrid: { for: 4 / speed } } };
  const neighbor = { id: neighborId, at: 5, track: 'V1', clipType: 'media', asset: 'split-video', from: 4, to: 8, speed: 1, hold: 4 };
  const publication = compositionPublication({ projectId: harness.seed.projectId, timelineId }, null, 'Native parent split', 30);
  const parent = publication.parent_composition as Record<string, any>; parent.config.output.fps = { numerator: 30000, denominator: 1001 };
  parent.config.clips = [clip, neighbor]; parent.clips = [clip, neighbor]; parent.config.opaque = { root: 'preserve', child: [null, false, 0] };
  parent.registry = { assets: { 'split-video': { file: harness.seed.video.mediaType === 'video/webm' ? 'split-video.webm' : 'split-video.mp4', type: harness.seed.video.mediaType, duration: 12, media_id: harness.seed.video.objectId, content_sha256: harness.seed.video.digest } } };
  const result = await harness.runtimeJson('POST', `/v1/projects/${harness.seed.projectId}/timelines/${timelineId}/composition-revisions`, publication);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const project = await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}`);
  return { projectSlug: project.body.data.slug, timelineId, clipId, neighborId, headRevisionId: result.body.data.new_head };
}
async function history(harness: DirectHarness, seed: SplitSeed): Promise<HistoryPage> {
  const result = await harness.runtimeJson<HistoryPage>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50`);
  expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body;
}
function parentOf(result: CommitAcceptedMutation): Record<string, any> { return result.data.canonical_document.parent_revision.payload as Record<string, any>; }
function observe(page: Page) {
  const posts: Post[] = []; const legacy: string[] = []; const renderer: string[] = [];
  page.on('request', (request) => { if (request.method() !== 'POST') return; const pathname = new URL(request.url()).pathname;
    if (COMMITS.test(pathname)) posts.push({ body: JSON.parse(request.postData() ?? '{}'), raw: request.postData() ?? '', key: request.headers()['idempotency-key'] });
    if (LEGACY.test(pathname)) legacy.push(pathname); if (/render|export/i.test(pathname)) renderer.push(pathname); });
  page.on('response', (response) => { const post = posts.find((candidate) => candidate.key === response.request().headers()['idempotency-key']);
    if (post && COMMITS.test(new URL(response.url()).pathname)) { post.status = response.status(); void response.json().then((body) => { post.result = body; }).catch(() => {}); } });
  return { posts, legacy, renderer };
}
async function openSplit(page: Page, harness: DirectHarness, seed: SplitSeed) {
  await page.goto(`${harness.origin}${APP_ENTRY_ROUTE}?localProject=${encodeURIComponent(seed.projectSlug)}&localTimeline=${encodeURIComponent(seed.timelineId)}`);
  await expectConnected(page); await expect(firstTrackName(page)).toBeVisible();
}

test('M2 native parent split preserves raw closure through lost ACK, restart, retry and Runtime inverse', async ({ page, harness, seed3 }) => {
  expect(seed3.transitionClipId).toBeTruthy(); await harness.enableTimelineAuthoring(ASTRID_PYTHON); const seed = await seedSplit(harness);
  await openApp(page, harness); await openSplit(page, harness, seed); const traffic = observe(page); const before = await history(harness, seed);
  const original = (await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/composition-revisions/${before.head.revision_id}`)).body.payload;
  const originalClip = original.clips.find((clip: any) => clip.id === seed.clipId); expect(originalClip).toMatchObject({ from: 0, to: 4, speed: 1.3, app: { opaque: { root: 'keep' } } });
  let accepted!: CommitAcceptedMutation; let held!: Route;
  await page.route(COMMITS, async (route) => { const response = await route.fetch({ maxRetries: 0 }); accepted = await response.json(); held = route; });
  await page.locator(`.clip-action[data-clip-id="${seed.clipId}"]`).click(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('s');
  await expect.poll(() => traffic.posts.length, CEILING).toBe(1); const first = traffic.posts[0]; const command = first.body.commands[0] as any;
  expect(command).toMatchObject({ schema_version: 1, op: 'clip.split', version: '1', select: `parent/clip:${seed.clipId}`, args: { on: SPLIT_AT } });
  const rightId = command.args.right_id; expect(rightId).toMatch(new RegExp(`^${seed.clipId}-\\d+$`)); expect(first.body).not.toHaveProperty('parent_composition'); expect(first.key).toBeTruthy();
  await expect.poll(async () => (await commandOutboxes(page, seed.timelineId)).some((record) => record.pending?.request), CEILING).toBe(true); const owner = (await commandOutboxes(page, seed.timelineId)).find((record) => record.pending?.request)!;
  await expect.poll(() => !!held, CEILING).toBe(true); await held.abort('connectionreset'); await expect.poll(async () => (await commandOutboxes(page, seed.timelineId)).find((record) => record.ownerId === owner.ownerId)?.pending?.outcome?.kind, CEILING).toBe('retry');
  const splitParent = parentOf(accepted); expect(splitParent.clips.map((clip: any) => clip.id)).toEqual([seed.clipId, rightId, seed.neighborId]); expect(splitParent.config.clips).toEqual(splitParent.clips);
  expect(splitParent.clips[0]).toMatchObject({ from: 0, to: 1.3, hold: 1, app: { astrid: { for: 1 / 1.3 }, opaque: originalClip.app.opaque } });
  expect(splitParent.clips[1]).toMatchObject({ id: rightId, at: 1, from: 1.3, to: 4, hold: 3 / 1.3, app: { opaque: originalClip.app.opaque } });
  expect(splitParent.config.opaque).toEqual(original.config.opaque); expect(splitParent.registry).toEqual(original.registry); expect(accepted.data.canonical_document.shot_revisions).toEqual([]); expect(accepted.data.canonical_document.internal_timeline_revisions).toEqual([]);
  await page.unroute(COMMITS); await page.reload(); await openSplit(page, harness, seed); const old = harness.runtimeInstanceId; await harness.restartRuntime(); expect(harness.runtimeInstanceId).not.toBe(old); await expectConnected(page); await openSplit(page, harness, seed);
  const persisted = (await commandOutboxes(page, seed.timelineId)).find((record) => record.ownerId === owner.ownerId)!; expect(persisted.pending?.request).toMatchObject({ body: first.raw, key: first.key });
  await page.getByRole('button', { name: /^Recover saved edits/ }).and(page.locator(`[data-owner-id="${owner.ownerId}"]`)).click();
  await expect.poll(async () => (await commandOutboxes(page, seed.timelineId)).every((record) => !record.pending && !record.intents.length), CEILING).toBe(true); expect(traffic.posts[1].raw).toBe(first.raw); expect(traffic.posts[1].key).toBe(first.key); expect(traffic.posts[1].result).toEqual(accepted);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect.poll(() => traffic.posts.length, CEILING).toBe(3); await expect.poll(() => traffic.posts[2].status, CEILING).toBe(200);
  const undone = traffic.posts[2].result!; expect(undone.data.canonical_document.parent_revision.payload).toEqual(original); expect(traffic.posts.map((post) => post.body.commands[0].op)).toEqual(['clip.split', 'clip.split', 'timeline.inverse']); expect(traffic.legacy).toEqual([]); expect(traffic.renderer).toEqual([]); expect(parentOf(undone).clips.map((clip: any) => clip.id)).toEqual([seed.clipId, seed.neighborId]);
});

/** Source only until the native delete ports are composed into the qualified current013 App. */
import { expect, type Page, type Route } from '@playwright/test';
import { checkCurrent013Sources, readCurrent013Inputs } from '../../../scripts/testing/current013-integration.mjs';
import { CURRENT013_PARENT_DELETE_AGENT } from '../../../scripts/testing/current013-parent-delete.mjs';
import { harnessUnavailableReason, type DirectHarness, type ThreeProductsSeed } from './support/harness.ts';
import {
  commandOutboxes, expectConnected, openApp, openSeededTimeline, revisionBody, test as appTest,
} from './support/app.ts';
import { ASTRID_PYTHON, AstridCli, astridUnavailableReason, revisionSet } from './support/astrid.ts';
import { traceDeleteKeyboard } from './support/delete-keyboard-trace.ts';
import type {
  CanonicalDocument, CommitAcceptedMutation, CommitRequest, HeadPin, HistoryPage, Manifest,
} from '../../../src/integrations/runtime/timeline-commit-types.ts';

const CEILING = { timeout: 90_000 };
const COMMITS = /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/;
const LEGACY_WRITES = /\/(?:composition-revisions|revisions|restore|restore-history)(?:\/[^/]+)?$/;

const test = appTest.extend<object, { seed3: ThreeProductsSeed; astrid: AstridCli }>({
  seed3: [async ({ harness }, use) => {
    await use(await harness.seedThreeProducts(undefined, 'parent-delete'));
  }, { scope: 'worker', timeout: 240_000 }],
  astrid: [async ({ harness }, use) => { await use(await AstridCli.create(harness)); }, { scope: 'worker', timeout: 240_000 }],
});

test.beforeAll(() => {
  const input = readCurrent013Inputs();
  expect(input.agentSha, 'use the literal approved Agent, never infer a parent/group scope').toBe(CURRENT013_PARENT_DELETE_AGENT);
  checkCurrent013Sources(input);
  const reason = harnessUnavailableReason() ?? astridUnavailableReason();
  if (reason) throw new Error(`the current013 parent-delete journey cannot run: ${reason}`);
});

const pinOf = (result: CommitAcceptedMutation): HeadPin => ({
  revision_id: result.data.accepted_revision_id, publication_id: result.receipt.receipt_id,
});
const basePath = (harness: DirectHarness, seed: ThreeProductsSeed) =>
  `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}`;

async function history(harness: DirectHarness, seed: ThreeProductsSeed): Promise<HistoryPage> {
  const response = await harness.runtimeJson<HistoryPage>('GET', `${basePath(harness, seed)}/commits?limit=50`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.next_cursor, 'the bounded fixture history fits on one page').toBeNull();
  return response.body;
}

/** The same immutable Runtime reads as the existing real parent-delete and label journeys. */
async function canonicalAt(harness: DirectHarness, seed: ThreeProductsSeed, head: HeadPin): Promise<CanonicalDocument> {
  const parent = await revisionBody(harness, head.revision_id);
  const manifest = parent.dependency_manifest as Manifest;
  const root = `/v1/projects/${harness.seed.projectId}`;
  const shots = await Promise.all(manifest.shots.map(async (pin) => {
    const response = await harness.runtimeJson('GET', `${root}/shots/${pin.shot_id}/revisions/${pin.revision_id}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject(pin);
    return { ...pin, payload: response.body.payload };
  }));
  const internals = await Promise.all(manifest.internal_timelines.map(async (pin) => {
    const response = await harness.runtimeJson('GET', `${root}/timelines/${pin.timeline_id}/revisions/${pin.revision_id}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject(pin);
    return { ...pin, payload: response.body.payload };
  }));
  return {
    schema_version: 1, project_id: harness.seed.projectId, timeline_id: seed.timelineId,
    parent_revision: { revision_id: parent.revision_id, content_digest: parent.content_digest, payload: parent.payload },
    shot_revisions: shots, internal_timeline_revisions: internals, dependency_manifest: manifest,
  };
}

async function expectReadback(harness: DirectHarness, seed: ThreeProductsSeed, result: CommitAcceptedMutation) {
  expect(await canonicalAt(harness, seed, pinOf(result))).toEqual(result.data.canonical_document);
  const entry = (await history(harness, seed)).items.find((row) => row.publication_id === pinOf(result).publication_id);
  expect(entry?.receipt).toEqual(result.receipt);
  expect(entry?.revision_id).toBe(result.data.accepted_revision_id);
}

async function openCommandTimeline(page: Page, harness: DirectHarness, seed: ThreeProductsSeed) {
  const previous = page.url().startsWith(harness.origin) ? await commandOutboxes(page, seed.timelineId) : [];
  await openApp(page, harness);
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  // The canvas can finish loading before the command session exposes its native ports.
  await expect.poll(async () => ({
    mounted: await page.locator('[data-command-session-ready="true"]').count(),
    owner: (await commandOutboxes(page, seed.timelineId)).some((owner) =>
      !previous.some((old) => old.ownerId === owner.ownerId) && !owner.pending && !owner.intents.length),
    notice: await page.getByTestId('timeline-command-recovery').allTextContents(),
  }), { ...CEILING, message: 'the mounted editor must expose native command ports and claim a new durable owner before the gesture' })
    .toMatchObject({ mounted: 1, owner: true });
}

type CommitPost = { method: string; path: string; body: string; key: string; status: number; response: CommitAcceptedMutation };

/** Only the network ACK is faulted, using the existing M1 route.fetch/abort pattern. */
async function faultFirstCommit(page: Page) {
  const posts: CommitPost[] = [];
  const legacy: string[] = [];
  let held: Route | undefined;
  const intercept = async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const response = await route.fetch({ maxRetries: 0 });
    posts.push({ method: request.method(), path: new URL(request.url()).pathname.replace(/^\/api\/runtime/, ''),
      body: request.postData()!, key: request.headers()['idempotency-key'],
      status: response.status(), response: await response.json() });
    if (posts.length === 1) held = route;
    else await route.fulfill({ response });
  };
  const attach = async (target: Page) => {
    target.on('request', (request) => {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && LEGACY_WRITES.test(new URL(request.url()).pathname)) {
        legacy.push(`${request.method()} ${new URL(request.url()).pathname}`);
      }
    });
    await target.route(COMMITS, intercept);
  };
  await attach(page);
  return { posts, legacy, attach, async loseAck() {
    if (!held) throw new Error('No actual Runtime response to lose');
    await held.abort('connectionreset');
    held = undefined;
  } };
}

/** Hold the actual delete request before the Runtime sees it, so a same-property Agent edit can win first. */
async function holdFirstCommit(page: Page) {
  const posts: CommitPost[] = [];
  const legacy: string[] = [];
  let held: Route | undefined;
  let request: CommitPost | undefined;
  const intercept = async (route: Route) => {
    const incoming = route.request();
    if (incoming.method() !== 'POST') return route.fallback();
    if (held) return route.fallback();
    held = route;
    request = { method: incoming.method(), path: new URL(incoming.url()).pathname.replace(/^\/api\/runtime/, ''),
      body: incoming.postData()!, key: incoming.headers()['idempotency-key'], status: 0, response: {} };
  };
  const attach = async (target: Page) => {
    target.on('request', (incoming) => {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(incoming.method()) && LEGACY_WRITES.test(new URL(incoming.url()).pathname)) {
        legacy.push(`${incoming.method()} ${new URL(incoming.url()).pathname}`);
      }
    });
    await target.route(COMMITS, intercept);
  };
  await attach(page);
  return { posts, legacy, attach, request: () => request, async release() {
    if (!held || !request) throw new Error('No actual Runtime commit request was held');
    const response = await held.fetch({ maxRetries: 0 });
    const post = { ...request, status: response.status(), response: await response.json() };
    posts.push(post);
    await held.fulfill({ response });
    held = undefined;
    request = post;
    return post;
  } };
}

function accepted(post: CommitPost): CommitAcceptedMutation {
  expect(post.status, JSON.stringify(post.response)).toBe(200);
  expect(post.response.data.status).toMatch(/^(accepted|rebased)$/);
  expect(post.key).toBeTruthy();
  // Runtime keeps publication/receipt identity separate from request retry identity.
  expect(post.response.receipt.receipt_id).toBeTruthy();
  expect(post.response.receipt.idempotency_key).toBe(post.key);
  expect(post.response.receipt.result).toEqual(post.response.data);
  return post.response;
}

const clipsOf = (document: CanonicalDocument) => document.parent_revision.payload.clips as Array<Record<string, any>>;
const withoutConflict = <T extends { conflict?: unknown }>(intents: T[]) => intents.map((intent) => {
  const original = structuredClone(intent);
  delete original.conflict;
  return original;
});

function expectOnlyDeleted(before: CanonicalDocument, after: CanonicalDocument, clipId: string) {
  const expected = structuredClone(before.parent_revision.payload);
  const remaining = clipsOf(before).filter((clip) => clip.id !== clipId);
  expected.clips = remaining;
  (expected.config as Record<string, any>).clips = remaining;
  // Exact payload equality includes registry, unrelated clips, occurrences and opaque keys.
  expect(after.parent_revision.payload).toEqual(expected);
  expect(clipsOf(after).some((clip) => clip.id === clipId), 'the RAW parent row is absent').toBe(false);
  expect((after.parent_revision.payload.config as Record<string, any>).clips).toEqual(remaining);
  expect(after.shot_revisions).toEqual(before.shot_revisions);
  expect(after.internal_timeline_revisions).toEqual(before.internal_timeline_revisions);
  expect(after.dependency_manifest).toEqual(before.dependency_manifest);
}

test('M2 current013 real parent DELETE: lost ACK, reload, Runtime restart, exact retry and UI inverse restore raw opaque clip', async ({ page, context, harness, astrid, seed3 }, testInfo) => {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  const identity = await astrid.preflight();
  const before = await history(harness, seed3);
  expect(before.head.revision_id).toBe(seed3.headRevisionId);
  const original = await canonicalAt(harness, seed3, before.head);
  const rawClip = clipsOf(original).find((clip) => clip.id === seed3.appClipId)!;
  expect(rawClip, 'the seed is a raw parent clip, not an occurrence/group').toBeTruthy();
  expect(rawClip.opaque).toEqual({ nullable: null, ordered: [false, 0, '', [], { z: 2, a: 1 }] });
  expect(rawClip.app.canonical.future).toEqual({ nullable: null, ordered: [0, false, ''] });
  expect(Object.hasOwn(rawClip, '__proto__')).toBe(true);
  expect(rawClip.__proto__).toEqual({ raw: true });
  expect(Object.hasOwn(rawClip.app.canonical, '__proto__')).toBe(true);
  expect(rawClip.app.canonical.__proto__).toEqual({ literal: true });
  expect(rawClip.app.canonical.constructor).toEqual({ prototype: [null, false] });
  expect(rawClip.app.future).toEqual({ prototype: false });
  expect(rawClip.constructor).toEqual({ prototype: { literal: true } });
  expect(rawClip.prototype).toBeNull();
  expect(clipsOf(original)).toEqual((original.parent_revision.payload.config as Record<string, any>).clips);

  const wire = await faultFirstCommit(page);
  await openCommandTimeline(page, harness, seed3);
  const clip = page.locator(`.clip-action[data-clip-id="${seed3.appClipId}"]`).first();
  await expect(clip).toBeVisible();
  await clip.click();
  await expect(clip).toHaveAttribute('data-selected', 'true');
  await clip.focus();
  await expect(clip).toBeFocused();
  const finishKeyboardTrace = await traceDeleteKeyboard(page, testInfo);
  try {
    await page.keyboard.press('Delete');
    // Missing nativeDelete composition must fail here; a legacy save cannot satisfy this.
    await expect.poll(() => wire.posts.length, CEILING).toBe(1);
  } finally {
    await finishKeyboardTrace?.();
  }
  const deletion = accepted(wire.posts[0]);
  expect(deletion.data.status).toBe('accepted');
  const request = JSON.parse(wire.posts[0].body) as CommitRequest;
  expect(request).toMatchObject({ base_revision_id: before.head.revision_id, base_publication_id: before.head.publication_id });
  expect(request).not.toHaveProperty('parent_composition');
  expect(request.commands).toHaveLength(1);
  const command = request.commands[0];
  expect(command).toMatchObject({ schema_version: 1, op: 'clip.delete', version: '1', select: `parent/clip:${seed3.appClipId}`, args: {} });
  expect(command.expect).toEqual({ [`parent/clip:${seed3.appClipId}::`]: { state: 'present', value: rawClip } });
  expect(command.reads).toEqual(expect.arrayContaining([
    { ref: 'parent/collection:clip', path: [], state: { state: 'present', value: {
      members: { state: 'present', value: [] }, config: { state: 'present', value: {} }, payload_members: { state: 'present', value: [] },
    } } },
    { ref: `parent/clip:${seed3.appClipId}`, path: [], state: { state: 'present', value: rawClip } },
    { ref: 'parent/collection:occurrence', path: [], state: { state: 'present', value: { container: 'array' } } },
    { ref: 'occurrence:f2-occurrence/collection:clip', path: [], state: { state: 'present', value: { members: { state: 'present', value: [] } } } },
  ]));
  expect(command.selections).toEqual([
    { key: 'collection.clips', query_version: 1, owner: 'parent',
      members: [`parent/clip:${seed3.appClipId}`, `parent/clip:${seed3.transitionClipId}`],
      order: [`parent/clip:${seed3.appClipId}`, `parent/clip:${seed3.transitionClipId}`],
      boundaries: [`parent/clip:${seed3.appClipId}`, `parent/clip:${seed3.transitionClipId}`], policy: 'guard-membership' },
    { key: 'collection.occurrences', query_version: 1, owner: 'parent',
      members: ['occurrence:f2-occurrence'], order: ['occurrence:f2-occurrence'], boundaries: ['occurrence:f2-occurrence'], policy: 'guard-membership' },
    { key: 'collection.clips', query_version: 1, owner: 'occurrence:f2-occurrence',
      members: ['occurrence:f2-occurrence/clip:f2-plate', 'occurrence:f2-occurrence/clip:f2-agent-clip', 'occurrence:f2-occurrence/clip:f2-agent-clear-clip'],
      order: ['occurrence:f2-occurrence/clip:f2-plate', 'occurrence:f2-occurrence/clip:f2-agent-clip', 'occurrence:f2-occurrence/clip:f2-agent-clear-clip'],
      boundaries: ['occurrence:f2-occurrence/clip:f2-plate', 'occurrence:f2-occurrence/clip:f2-agent-clip', 'occurrence:f2-occurrence/clip:f2-agent-clear-clip'], policy: 'guard-membership' },
  ]);
  expect(command.bindings).toEqual({ 'collection.owner:collection.clips': 'occurrence:f2-occurrence' });
  expect(command.created).toEqual([]);
  expect(command.resolved).toEqual([`parent/clip:${seed3.appClipId}`]);
  expect(deletion.data.commands).toEqual(request.commands);
  const entry = (await history(harness, seed3)).items.find((row) => row.publication_id === pinOf(deletion).publication_id);
  expect(entry?.records?.commands[0].command).toEqual(command);
  expect(entry?.records?.commands[0].reads).toEqual(command.reads);
  expect(entry?.records?.commands[0].selections).toEqual(command.selections);
  expect(entry?.records?.commands[0].bindings).toEqual([
    { key: 'collection.owner:collection.clips', ref: 'occurrence:f2-occurrence', policy: 'fixed', dependencies: [] },
  ]);
  expect(entry?.records?.commands[0].created).toEqual([]);
  expect(entry?.records?.commands[0].writes).toEqual([
    { ref: `parent/clip:${seed3.appClipId}`, path: [], before: { state: 'present', value: rawClip }, after: { state: 'absent' } },
  ]);
  expectOnlyDeleted(original, deletion.data.canonical_document, seed3.appClipId);
  await expectReadback(harness, seed3, deletion);

  const owner = (await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.pending)!;
  expect(owner).toBeTruthy();
  expect(owner.pending!.request).toEqual({ method: 'POST', path: `${basePath(harness, seed3)}/commit`,
    body: wire.posts[0].body, key: wire.posts[0].key });
  expect(owner.intents).toHaveLength(1);
  expect((owner.intents[0].payload as { commands: unknown }).commands).toEqual(request.commands);

  // A real disjoint Agent publication while the durable delete ACK is still unknown.
  const independent = await astrid.commitCaptured(harness.seed.projectId, seed3.timelineId, pinOf(deletion),
    { kind: 'track', id: 'f2-delete-independent-C' }, 'm2-current013-parent-delete-independent');
  expect(independent.data.publisher).not.toBe(deletion.data.publisher);
  const independentConfig = independent.data.canonical_document.parent_revision.payload.config as Record<string, any>;
  expect(independentConfig.tracks).toContainEqual({ id: 'f2-delete-independent-C', kind: 'audio', label: 'f2-delete-independent-C' });
  const expectedIndependent = structuredClone(deletion.data.canonical_document.parent_revision.payload);
  (expectedIndependent.config as Record<string, any>).tracks = independentConfig.tracks;
  expect(independent.data.canonical_document.parent_revision.payload).toEqual(expectedIndependent);
  await expectReadback(harness, seed3, independent);
  await wire.loseAck();
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId))
    .find((candidate) => candidate.ownerId === owner.ownerId)?.pending?.outcome?.kind, CEILING).toBe('retry');

  await page.reload();
  await expectConnected(page);
  const afterReload = (await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.ownerId === owner.ownerId)!;
  expect(afterReload.pending?.request).toEqual(owner.pending!.request);
  expect(afterReload.intents).toEqual(owner.intents);
  expect(wire.posts).toHaveLength(1);
  await page.close();
  const realm = harness.realmId;
  const restarted = await harness.restartRuntime();
  expect(harness.runtimeInstanceId).not.toBe(restarted.oldInstanceId);
  expect(harness.realmId).toBe(realm);
  const reopened = await context.newPage();
  await wire.attach(reopened);
  await openApp(reopened, harness);
  await expectConnected(reopened);
  await openSeededTimeline(reopened, harness);
  const persisted = (await commandOutboxes(reopened, seed3.timelineId)).find((candidate) => candidate.ownerId === owner.ownerId)!;
  expect(persisted.pending?.request).toEqual(owner.pending!.request);
  expect(persisted.intents).toEqual(owner.intents);
  expect(wire.posts).toHaveLength(1);
  expect((await history(harness, seed3)).head).toEqual(pinOf(independent));
  expect(await canonicalAt(harness, seed3, pinOf(independent))).toEqual(independent.data.canonical_document);

  await reopened.getByRole('button', { name: /^Recover saved edits/ })
    .and(reopened.locator(`[data-owner-id="${owner.ownerId}"]`)).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(2);
  expect(wire.posts[1].body).toBe(wire.posts[0].body);
  expect(wire.posts[1].key).toBe(wire.posts[0].key);
  expect(wire.posts[1].method).toBe(wire.posts[0].method);
  expect(wire.posts[1].path).toBe(wire.posts[0].path);
  expect(accepted(wire.posts[1])).toEqual(deletion);
  await expect.poll(async () => (await commandOutboxes(reopened, seed3.timelineId))
    .find((candidate) => candidate.ownerId === owner.ownerId)?.intents.length, CEILING).toBe(0);
  const recovered = await history(harness, seed3);
  expect(recovered.head).toEqual(pinOf(independent));
  expect(recovered.items).toHaveLength(before.items.length + 2);
  expect(recovered.items.filter((row) => row.publication_id === pinOf(deletion).publication_id)).toHaveLength(1);
  expectOnlyDeleted(original, await canonicalAt(harness, seed3, pinOf(deletion)), seed3.appClipId);

  await reopened.reload();
  await expectConnected(reopened);
  await openSeededTimeline(reopened, harness);
  await expect(reopened.locator(`.clip-action[data-clip-id="${seed3.appClipId}"]`)).toHaveCount(0);
  expect(await canonicalAt(harness, seed3, (await history(harness, seed3)).head)).toEqual(independent.data.canonical_document);
  await reopened.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(3);
  const inverseRequest = JSON.parse(wire.posts[2].body) as CommitRequest;
  expect(inverseRequest.commands).toEqual([
    { schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: [pinOf(deletion).publication_id] } },
  ]);
  const inverse = accepted(wire.posts[2]);
  expect(inverse.data.previous_revision_id).toBe(pinOf(independent).revision_id);
  expect(inverse.data.previous_publication_id).toBe(pinOf(independent).publication_id);
  const expectedRestored = structuredClone(original.parent_revision.payload);
  (expectedRestored.config as Record<string, any>).tracks = independentConfig.tracks;
  expect(inverse.data.canonical_document.parent_revision.payload).toEqual(expectedRestored);
  expect(clipsOf(inverse.data.canonical_document).find((candidate) => candidate.id === seed3.appClipId)).toEqual(rawClip);
  expect(inverse.data.canonical_document.shot_revisions).toEqual(original.shot_revisions);
  expect(inverse.data.canonical_document.internal_timeline_revisions).toEqual(original.internal_timeline_revisions);
  expect(inverse.data.canonical_document.dependency_manifest).toEqual(original.dependency_manifest);
  await expectReadback(harness, seed3, inverse);
  const final = await history(harness, seed3);
  expect(final.head).toEqual(pinOf(inverse));
  expect(final.items).toHaveLength(before.items.length + 3);
  expect(final.items.find((row) => row.publication_id === pinOf(inverse).publication_id)?.records?.undo_of)
    .toEqual([pinOf(deletion).publication_id]);
  await reopened.reload();
  await expectConnected(reopened);
  await openSeededTimeline(reopened, harness);
  await expect(reopened.locator(`.clip-action[data-clip-id="${seed3.appClipId}"]`).first()).toBeVisible();
  expect((await canonicalAt(harness, seed3, (await history(harness, seed3)).head)).parent_revision.payload).toEqual(expectedRestored);
  expect(wire.posts.map((post) => (JSON.parse(post.body) as CommitRequest).commands[0].op))
    .toEqual(['clip.delete', 'clip.delete', 'timeline.inverse']);
  expect(wire.posts.every((post) => !Object.hasOwn(JSON.parse(post.body), 'parent_composition'))).toBe(true);
  expect(wire.legacy, 'delete, retry, recovery and inverse have zero browser legacy writes').toEqual([]);
  await testInfo.attach('parent-delete-readback', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
    sources: revisionSet(identity), original, deletion, independent, inverse,
    requests: wire.posts.map(({ body, key }) => ({ body, key })), legacy: wire.legacy,
  }, null, 2)) });
});

test('M2 current013 parent DELETE conflict: same-property Agent move wins while the original delete request is held and draft is retained', async ({ page, harness, astrid, seed3 }, testInfo) => {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  await astrid.preflight();
  const before = await history(harness, seed3);
  const original = await canonicalAt(harness, seed3, before.head);
  const originalClip = clipsOf(original).find((clip) => clip.id === seed3.appClipId)!;
  const wire = await holdFirstCommit(page);
  await openCommandTimeline(page, harness, seed3);
  const clip = page.locator(`.clip-action[data-clip-id="${seed3.appClipId}"]`).first();
  await expect(clip).toBeVisible();
  await clip.click();
  await expect(clip).toHaveAttribute('data-selected', 'true');
  await clip.focus();
  await expect(clip).toBeFocused();
  const finishKeyboardTrace = await traceDeleteKeyboard(page, testInfo);
  try {
    await page.keyboard.press('Delete');
    await expect.poll(() => wire.request(), CEILING).toBeTruthy();
  } finally {
    await finishKeyboardTrace?.();
  }
  const held = wire.request()!;
  const heldRequest = JSON.parse(held.body) as CommitRequest;
  expect(heldRequest.commands[0]).toMatchObject({ op: 'clip.delete', select: `parent/clip:${seed3.appClipId}` });
  const owner = (await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.pending)!;
  expect(owner).toBeTruthy();

  // This is a real Agent capture/commit against the same raw parent clip property, not a provider fake.
  const moved = await astrid.commitCaptured(harness.seed.projectId, seed3.timelineId, before.head,
    { kind: 'move', clipId: seed3.appClipId, on: 1 }, 'm2-current013-parent-delete-same-property');
  expect(moved.data.commands[0]).toMatchObject({ op: 'clip.move', select: `parent/clip:${seed3.appClipId}` });
  expect(clipsOf(moved.data.canonical_document).find((candidate) => candidate.id === seed3.appClipId)?.at).toBe(1);
  expect(clipsOf(moved.data.canonical_document).find((candidate) => candidate.id === seed3.appClipId)?.opaque).toEqual(originalClip.opaque);
  await expectReadback(harness, seed3, moved);

  const conflict = await wire.release();
  expect(conflict.status, JSON.stringify(conflict.response)).toBe(409);
  expect(conflict.response.details.status).toBe('conflict');
  expect(conflict.response.details.conflicts).toEqual(expect.arrayContaining([
    expect.objectContaining({ ref: `parent/clip:${seed3.appClipId}` }),
  ]));
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId))
    .find((candidate) => candidate.ownerId === owner.ownerId)?.pending?.outcome?.kind, CEILING).toBe('rejected');
  await expect(page.getByTestId('timeline-command-recovery'))
    .toContainText('Your changes are retained and need resolution before they can be saved.');
  const retained = (await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.ownerId === owner.ownerId)!;
  // The conflict is additive state; the original intent, including its guards, remains byte-exact.
  expect(withoutConflict(retained.intents)).toEqual(owner.intents);
  expect(retained.intents.map((intent) => intent.conflict)).toEqual([
    expect.objectContaining({ kind: 'conflict' }),
  ]);
  expect(retained.pending?.request).toEqual(owner.pending?.request);
  expect(retained.pending?.outcome).toMatchObject({ kind: 'rejected', error: { kind: 'conflict' } });
  expect(JSON.parse(retained.pending!.request.body).commands).toEqual(heldRequest.commands);
  expect((await history(harness, seed3)).head).toEqual(pinOf(moved));
  expect((await history(harness, seed3)).items).toHaveLength(before.items.length + 1);
  expect(clipsOf(await canonicalAt(harness, seed3, pinOf(moved))).find((candidate) => candidate.id === seed3.appClipId)?.at).toBe(1);
  expect(wire.posts).toHaveLength(1);

  await page.reload();
  await expectConnected(page);
  const reloaded = (await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.ownerId === owner.ownerId)!;
  expect(withoutConflict(reloaded.intents)).toEqual(owner.intents);
  expect(reloaded.intents.map((intent) => intent.conflict)).toEqual(retained.intents.map((intent) => intent.conflict));
  expect(reloaded.pending?.request).toEqual(retained.pending?.request);
  expect(reloaded.pending?.outcome).toEqual(retained.pending?.outcome);
  const recover = page.getByRole('button', { name: /^Recover saved edits/ })
    .and(page.locator(`[data-owner-id="${owner.ownerId}"]`));
  await expect(recover).toBeVisible(CEILING);
  await recover.click();
  await expect(page.getByTestId('timeline-command-recovery'))
    .toContainText('Your changes are retained and need resolution before they can be saved.');
  const recovered = (await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.ownerId === owner.ownerId)!;
  expect(withoutConflict(recovered.intents)).toEqual(owner.intents);
  expect(recovered.intents.map((intent) => intent.conflict)).toEqual(retained.intents.map((intent) => intent.conflict));
  expect(recovered.pending?.request).toEqual(retained.pending?.request);
  expect(recovered.pending?.outcome).toEqual(retained.pending?.outcome);
  expect(wire.posts).toHaveLength(1);
  expect(wire.legacy).toEqual([]);
});

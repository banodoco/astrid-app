/** The mounted canonical shot-name command: one real parent session, one Runtime door, no fallback writer. */
import { execFileSync } from 'node:child_process';
import { expect, type Page, type Route } from '@playwright/test';
import {
  harnessUnavailableReason,
  REPO_ROOT,
  RUNTIME_CHECKOUT,
  type CanonicalSettingsSeed,
  type DirectHarness,
  type ThreeProductsSeed,
} from './support/harness.ts';
import {
  commandOutboxes,
  embeddedShotNameInput,
  expectConnected,
  openApp,
  openEmbeddedCanonicalShot,
  openSeededTimeline,
  revisionBody,
  test as appTest,
} from './support/app.ts';
import { ASTRID_CHECKOUT, ASTRID_PYTHON } from './support/astrid.ts';
import type { CanonicalDocument, CommitAcceptedMutation, CommitRequest, HeadPin, HistoryPage } from '../../../src/integrations/runtime/timeline-commit-types.ts';

const CEILING = { timeout: 90_000 };
const COMMITS = /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/;
const LEGACY_SAVES = /\/timelines\/[^/]+\/composition-revisions$/;
const SHOT_NAME = 'F2 canonical shot';
const SETTINGS_SHOT_NAME = 'Settings auto-disable shot';
const ACCEPTED_NAME = 'Édit 🎬';
const RETRY_NAME = 'F2 retry survives restart';
const CONFLICT_DRAFT = '  same-name draft 🎬  ';
const ACCEPTED_PROMPT = 'A paper moon drifts over Tokyo — 🚀';
const RETRY_PROMPT = 'Prompt retry survives restart';

type CommitPost = {
  body: CommitRequest;
  rawBody: string;
  key: string;
  status: number | null;
  response: any;
};

const test = appTest.extend<object, { seed3: ThreeProductsSeed; settingsSeed: CanonicalSettingsSeed }>({
  seed3: [async ({ harness }, use) => { await use(await harness.seedThreeProducts()); }, { scope: 'worker', timeout: 240_000 }],
  settingsSeed: [async ({ harness }, use) => { await use(await harness.seedCanonicalSettingsShot()); }, { scope: 'worker', timeout: 240_000 }],
});
test.beforeAll(() => {
  const reason = harnessUnavailableReason();
  if (reason) throw new Error(`the shot-name journey cannot run: ${reason}`);
  for (const name of ['TIMELINE_BUNDLE_AGENT_HEAD', 'TIMELINE_BUNDLE_RUNTIME_HEAD']) {
    if (!/^[0-9a-f]{40}$/.test(process.env[name] ?? '')) {
      throw new Error(`the shot-name cohort requires ${name} as a full 40-character SHA`);
    }
  }
  const exactSources = {
    TIMELINE_CURRENT013_AGENT_SHA: '6efc81500a0e0688c2bb41e736503f0fc3e04abb',
    TIMELINE_CURRENT013_RUNTIME_SHA: '95bd3c5f6d00e9bc8cc8cbe5ef510b68ed660f3c',
    TIMELINE_CURRENT013_PUBLIC_SOURCE_SHA256: '9412ae25c306d5118241f4d631e8eecc6eef9b2fb5a98302d40938e9f6d54738',
  } as const;
  for (const [name, value] of Object.entries(exactSources)) {
    if (process.env[name] !== value) throw new Error(`the shot-name cohort requires exact ${name}`);
  }
  const git = (checkout: string, ...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
  expect(git(ASTRID_CHECKOUT, 'rev-parse', 'HEAD')).toBe(process.env.TIMELINE_BUNDLE_AGENT_HEAD);
  expect(git(RUNTIME_CHECKOUT, 'rev-parse', 'HEAD')).toBe(process.env.TIMELINE_BUNDLE_RUNTIME_HEAD);
  expect(git(ASTRID_CHECKOUT, 'status', '--porcelain', '--untracked-files=normal')).toBe('');
  expect(git(RUNTIME_CHECKOUT, 'status', '--porcelain', '--untracked-files=normal')).toBe('');
  console.log('[shot-name] source', JSON.stringify({
    app: { checkout: REPO_ROOT, head: git(REPO_ROOT, 'rev-parse', 'HEAD'), tree: git(REPO_ROOT, 'rev-parse', 'HEAD^{tree}') },
    agent: process.env.TIMELINE_BUNDLE_AGENT_HEAD,
    runtime: process.env.TIMELINE_BUNDLE_RUNTIME_HEAD,
  }));
});

test.describe.configure({ mode: 'serial' });

function pinOf(result: CommitAcceptedMutation): HeadPin {
  return { revision_id: result.data.accepted_revision_id, publication_id: result.receipt.receipt_id };
}

function promptCommitIndex(posts: CommitPost[], prompt: string) {
  return posts.findIndex((post) => post.body.commands.some((command) => (
    (command.args.values as Record<string, any> | undefined)?.settings?.prompt === prompt
  )));
}

function shotPayload(document: CanonicalDocument) {
  const shot = document.shot_revisions.find((candidate) => candidate.shot_id === 'f2-shot');
  expect(shot, 'the accepted canonical document keeps the seeded shot revision').toBeTruthy();
  return shot!.payload as Record<string, any>;
}

async function rawShot(harness: DirectHarness, seed: ThreeProductsSeed, parentRevisionId: string) {
  const parent = await revisionBody(harness, parentRevisionId);
  const occurrence = (parent.payload.occurrences as Array<Record<string, any>>).find((candidate) => candidate.occurrence_id === seed.occurrenceId);
  expect(occurrence, 'the raw parent binds the requested occurrence').toBeTruthy();
  const shot = await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}/shots/${seed.shotId}/revisions/${occurrence!.shot_revision_id}`);
  expect(shot.status, JSON.stringify(shot.body)).toBe(200);
  return { parent, shot: shot.body as { revision_id: string; shot_id: string; internal_timeline_revision_id: string; content_digest: string; payload: Record<string, any> } };
}

async function rawSettingsShot(harness: DirectHarness, seed: CanonicalSettingsSeed, parentRevisionId: string) {
  const parent = await revisionBody(harness, parentRevisionId);
  const occurrence = (parent.payload.occurrences as Array<Record<string, any>>).find((candidate) => candidate.occurrence_id === seed.occurrenceId);
  expect(occurrence, 'the raw parent binds the settings occurrence').toBeTruthy();
  const shot = await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}/shots/${seed.shotId}/revisions/${occurrence!.shot_revision_id}`);
  expect(shot.status, JSON.stringify(shot.body)).toBe(200);
  return { parent, shot: shot.body as { revision_id: string; shot_id: string; internal_timeline_revision_id: string; content_digest: string; payload: Record<string, any> } };
}

function observeTraffic(page: Page) {
  const posts: CommitPost[] = [];
  const legacy: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const pathname = new URL(request.url()).pathname;
    if (COMMITS.test(pathname)) {
      posts.push({ body: JSON.parse(request.postData() ?? '{}') as CommitRequest, rawBody: request.postData() ?? '', key: request.headers()['idempotency-key'], status: null, response: null });
    }
    if (LEGACY_SAVES.test(pathname)) legacy.push(pathname);
  });
  page.on('response', (response) => {
    if (response.request().method() !== 'POST' || !COMMITS.test(new URL(response.url()).pathname)) return;
    const key = response.request().headers()['idempotency-key'];
    const post = [...posts].reverse().find((candidate) => candidate.key === key);
    if (!post) return;
    post.status = response.status();
    void response.json().then((body) => { post.response = body; }).catch(() => {});
  });
  return { posts, legacy };
}

async function waitForPost(posts: CommitPost[], index: number) {
  await expect.poll(() => posts[index]?.status, CEILING).not.toBeNull();
  await expect.poll(() => posts[index]?.response, CEILING).not.toBeNull();
  return posts[index];
}

async function acceptAndRecord(route: Route, posts: CommitPost[]) {
  const response = await route.fetch({ maxRetries: 0 });
  const post = posts[posts.length - 1];
  post.status = response.status();
  post.response = await response.json();
  await route.fulfill({ response });
}

async function openParent(page: Page, harness: DirectHarness) {
  await openApp(page, harness);
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await expect.poll(async () => (await commandOutboxes(page, harness.seed.timelineId)).some((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);
}

async function editShotName(page: Page, seed: ThreeProductsSeed, value: string) {
  const dialog = await openEmbeddedCanonicalShot(page, seed.occurrenceId, SHOT_NAME);
  await dialog.locator('span[title="Click to edit shot name"]').first().click();
  const input = embeddedShotNameInput(dialog);
  await expect(input).toBeVisible();
  await expect(input).toHaveValue(SHOT_NAME);
  await input.fill(value);
  await input.press('Enter');
  return { dialog, input };
}

test('M2 real embedded shot name: raw preservation, undo, lost ACK restart retry, and same-name conflict draft', async ({ page, harness, seed3 }) => {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  await openParent(page, harness);
  const traffic = observeTraffic(page);
  const initialHead = (await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed3.timelineId}/composition-revisions?limit=1`)).body.items.find((item: any) => item.is_current_head).revision_id as string;
  const initial = await rawShot(harness, seed3, initialHead);
  expect(initial.shot.payload.name).toBe(SHOT_NAME);
  expect(initial.shot.payload.provenance).toEqual({ source: 'three-products-seed', revision: 1 });
  expect(initial.shot.payload.x_f2_opaque).toEqual(seed3.opaque.shot);

  // Capture happens on the production name click, before the Unicode draft is typed.
  const first = await editShotName(page, seed3, `  ${ACCEPTED_NAME}  `);
  await expect.poll(() => traffic.posts.length, CEILING).toBe(1);
  await waitForPost(traffic.posts, 0);
  const accepted = traffic.posts[0];
  expect(accepted.body).toMatchObject({
    base_revision_id: initialHead,
    commands: [{ schema_version: 1, op: 'shot.set', version: '1', select: `occurrence:${seed3.occurrenceId}/shot`, args: { values: { name: ACCEPTED_NAME }, clear: [] } }],
  });
  expect(accepted.body).not.toHaveProperty('parent_composition');
  expect(accepted.body.commands[0].reads).toEqual(expect.arrayContaining([
    { ref: `occurrence:${seed3.occurrenceId}`, path: ['occurrence_id'], state: { state: 'present', value: seed3.occurrenceId } },
  ]));
  expect(accepted.body.commands[0]).not.toHaveProperty('dependencies');
  const acceptedResponse = traffic.posts[0].response as CommitAcceptedMutation;
  expect(acceptedResponse.data.status).toMatch(/^(accepted|rebased)$/);
  expect(shotPayload(acceptedResponse.data.canonical_document)).toMatchObject({
    name: ACCEPTED_NAME,
    provenance: initial.shot.payload.provenance,
    x_f2_opaque: initial.shot.payload.x_f2_opaque,
  });
  await expect(embeddedShotNameInput(first.dialog)).toHaveCount(0);
  await expect(first.dialog.getByText(ACCEPTED_NAME, { exact: true }).first()).toBeVisible();
  const acceptedPin = pinOf(acceptedResponse);
  const acceptedHistory = await harness.runtimeJson<HistoryPage>('GET',
    `/v1/projects/${harness.seed.projectId}/timelines/${seed3.timelineId}/commits?limit=50`);
  expect(acceptedHistory.status, JSON.stringify(acceptedHistory.body)).toBe(200);
  const acceptedRecord = acceptedHistory.body.items.find((entry) => entry.publication_id === acceptedPin.publication_id);
  expect(acceptedRecord, 'the accepted shot.set has a canonical authenticated history record').toBeTruthy();
  expect(acceptedRecord?.records?.commands).toHaveLength(1);
  expect(acceptedRecord?.records?.commands[0].dependencies).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: 'shot.source', policy: 'exact' }),
  ]));
  const acceptedRaw = await rawShot(harness, seed3, acceptedPin.revision_id);
  expect(acceptedRaw.shot.payload).toEqual(expect.objectContaining({ name: ACCEPTED_NAME, provenance: initial.shot.payload.provenance, x_f2_opaque: initial.shot.payload.x_f2_opaque }));

  // Reload reads the accepted shot, then the parent session's real Runtime inverse restores only this name.
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await expect.poll(() => page.getByRole('button', { name: 'Undo', exact: true }).isVisible(), CEILING).toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => traffic.posts.length, CEILING).toBe(2);
  await waitForPost(traffic.posts, 1);
  expect(traffic.posts[1].body.commands).toEqual([{ schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: [acceptedPin.publication_id] } }]);
  const undone = traffic.posts[1].response as CommitAcceptedMutation;
  expect(shotPayload(undone.data.canonical_document)).toMatchObject({ name: SHOT_NAME, provenance: initial.shot.payload.provenance, x_f2_opaque: initial.shot.payload.x_f2_opaque });
  const undonePin = pinOf(undone);
  const undoneRaw = await rawShot(harness, seed3, undonePin.revision_id);
  expect(undoneRaw.shot.payload).toEqual(initial.shot.payload);

  // The first retry case holds the accepted Runtime response, then aborts only the browser acknowledgement.
  let releaseAck!: () => void;
  const ackGate = new Promise<void>((resolve) => { releaseAck = resolve; });
  let heldAck = false;
  const ackInterceptor = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (!heldAck) {
      heldAck = true;
      const response = await route.fetch({ maxRetries: 0 });
      const post = traffic.posts[traffic.posts.length - 1];
      post.status = response.status();
      post.response = await response.json();
      await ackGate;
      await route.abort('connectionreset').catch(() => {});
      return;
    }
    await acceptAndRecord(route, traffic.posts);
  };
  await page.route(COMMITS, ackInterceptor);
  const retry = await editShotName(page, seed3, RETRY_NAME);
  await expect.poll(() => traffic.posts.length, CEILING).toBe(3);
  await waitForPost(traffic.posts, 2);
  const originalRetry = { body: traffic.posts[2].rawBody, key: traffic.posts[2].key };
  const acceptedRetry = traffic.posts[2].response as CommitAcceptedMutation;
  expect(shotPayload(acceptedRetry.data.canonical_document).name).toBe(RETRY_NAME);
  releaseAck();
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.pending)?.pending?.outcome?.kind, CEILING).toBe('retry');
  await expect(retry.input).toHaveValue(RETRY_NAME);
  await page.reload();
  await expectConnected(page);
  const beforeRestart = (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.pending)!;
  expect(beforeRestart.pending?.request.body).toBe(originalRetry.body);
  expect(beforeRestart.pending?.request.key).toBe(originalRetry.key);
  const restarted = await harness.restartRuntime();
  expect(restarted.oldInstanceId).not.toBe(harness.runtimeInstanceId);
  await expect(page.getByRole('heading', { name: 'Astrid restarted' })).toBeVisible(CEILING);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  const ownerId = beforeRestart.ownerId;
  await page.getByRole('button', { name: /^Recover saved edits/ }).and(page.locator(`[data-owner-id="${ownerId}"]`)).click();
  await expect.poll(() => traffic.posts.length, CEILING).toBe(4);
  expect(traffic.posts[3].rawBody).toBe(originalRetry.body);
  expect(traffic.posts[3].key).toBe(originalRetry.key);
  expect(traffic.posts[3].response).toEqual(traffic.posts[2].response);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).every((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);
  await page.unroute(COMMITS, ackInterceptor);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => traffic.posts.length, CEILING).toBe(5);
  await waitForPost(traffic.posts, 4);
  const afterRetryUndo = traffic.posts[4].response as CommitAcceptedMutation;
  expect(shotPayload(afterRetryUndo.data.canonical_document).name).toBe(SHOT_NAME);

  // Hold the actual App request before Runtime acceptance; a second writer changes this same shot-name leaf.
  let releaseConflict!: () => void;
  const conflictGate = new Promise<void>((resolve) => { releaseConflict = resolve; });
  let heldConflict = false;
  const conflictInterceptor = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (!heldConflict) {
      heldConflict = true;
      await conflictGate;
      const response = await route.fetch({ maxRetries: 0 });
      const post = traffic.posts[traffic.posts.length - 1];
      post.status = response.status();
      post.response = await response.json();
      await route.fulfill({ response });
      return;
    }
    await route.fallback();
  };
  await page.route(COMMITS, conflictInterceptor);
  const conflict = await editShotName(page, seed3, CONFLICT_DRAFT);
  await expect.poll(() => traffic.posts.length, CEILING).toBe(6);
  const held = traffic.posts[5];
  const externalCommand = structuredClone(held.body.commands[0]);
  externalCommand.args = { values: { name: 'Other writer' }, clear: [] };
  const external = await harness.runtimeJson('POST', `/v1/projects/${harness.seed.projectId}/timelines/${seed3.timelineId}/commit`, {
    ...held.body,
    commands: [externalCommand],
  });
  expect(external.status).toBe(200);
  releaseConflict();
  await waitForPost(traffic.posts, 5);
  expect(traffic.posts[5].status).toBe(409);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.pending)?.pending?.outcome?.kind, CEILING).toBe('rejected');
  await expect(conflict.input).toHaveValue(CONFLICT_DRAFT);
  expect(traffic.legacy).toEqual([]);
  await page.unroute(COMMITS, conflictInterceptor);
});

test('M2 real embedded SettingsAutoDisable: native scalar field change, raw settings preservation, reload, Runtime undo, and zero legacy', async ({ page, harness, settingsSeed }) => {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  await openParent(page, harness);
  const traffic = observeTraffic(page);
  const initialHead = (await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${settingsSeed.timelineId}/composition-revisions?limit=1`)).body.items.find((item: any) => item.is_current_head).revision_id as string;
  const initial = await rawSettingsShot(harness, settingsSeed, initialHead);
  const initialOccurrence = (initial.parent.payload.occurrences as Array<Record<string, any>>).find((candidate) => candidate.occurrence_id === settingsSeed.occurrenceId);
  expect(initialOccurrence).toEqual(expect.objectContaining({ shot_id: settingsSeed.shotId, shot_revision_id: initial.shot.revision_id }));
  expect(initial.shot).toMatchObject({ shot_id: initialOccurrence!.shot_id, internal_timeline_revision_id: initial.shot.payload.internal_timeline_revision_id });
  const initialInternalManifest = (initial.parent.dependency_manifest.internal_timelines as Array<Record<string, any>>).find((candidate) => candidate.revision_id === initial.shot.internal_timeline_revision_id);
  expect(initialInternalManifest).toEqual(expect.objectContaining({ timeline_id: settingsSeed.timelineId, revision_id: initial.shot.internal_timeline_revision_id }));
  const initialInternalResponse = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${initialInternalManifest!.timeline_id}/revisions/${initial.shot.internal_timeline_revision_id}`);
  expect(initialInternalResponse.status, JSON.stringify(initialInternalResponse.body)).toBe(200);
  const initialInternal = initialInternalResponse.body as { timeline_id: string; revision_id: string; content_digest: string; payload: Record<string, any> };
  expect(initial.shot.payload.settings).toEqual({
    turboMode: true,
    advancedMode: true,
    motionMode: 'advanced',
    prompt: 'fixture prompt remains raw',
    negativePrompt: null,
    x_settings_opaque: settingsSeed.opaqueSettings,
  });

  // Opening the existing mounted editor is the only trigger. SettingsAutoDisable
  // observes the raw true/true pair and submits its existing scalar correction.
  await openEmbeddedCanonicalShot(page, settingsSeed.occurrenceId, SETTINGS_SHOT_NAME);
  await expect.poll(() => traffic.posts.length, CEILING).toBe(1);
  await waitForPost(traffic.posts, 0);
  const accepted = traffic.posts[0];
  expect(accepted.body).toMatchObject({
    base_revision_id: initialHead,
    commands: [{
      schema_version: 1,
      op: 'shot.set',
      version: '1',
      select: `occurrence:${settingsSeed.occurrenceId}/shot`,
      args: { values: { settings: { advancedMode: false, motionMode: 'basic' } }, clear: [] },
    }],
  });
  expect(accepted.body).not.toHaveProperty('parent_composition');
  const acceptedResponse = accepted.response as CommitAcceptedMutation;
  expect(acceptedResponse.data.status).toMatch(/^(accepted|rebased)$/);
  const acceptedPin = pinOf(acceptedResponse);
  const acceptedOccurrence = (acceptedResponse.data.canonical_document.parent_revision.payload.occurrences as Array<Record<string, any>>).find((candidate) => candidate.occurrence_id === settingsSeed.occurrenceId);
  expect(acceptedOccurrence).toEqual(expect.objectContaining({ shot_id: initialOccurrence!.shot_id }));
  expect(acceptedOccurrence!.shot_revision_id).not.toBe(initialOccurrence!.shot_revision_id);
  const acceptedShot = acceptedResponse.data.canonical_document.shot_revisions.find((candidate) => candidate.shot_id === acceptedOccurrence!.shot_id && candidate.revision_id === acceptedOccurrence!.shot_revision_id);
  expect(acceptedShot, 'Agent8130 materializes the edited shot closure').toBeTruthy();
  expect(acceptedShot!.payload.internal_timeline_revision_id).toBe(acceptedShot!.internal_timeline_revision_id);
  const acceptedInternalManifest = acceptedResponse.data.canonical_document.dependency_manifest.internal_timelines.find((candidate) => candidate.timeline_id === initialInternalManifest!.timeline_id && candidate.revision_id === acceptedShot!.internal_timeline_revision_id);
  expect(acceptedInternalManifest).toEqual(expect.objectContaining({ timeline_id: initialInternalManifest!.timeline_id, revision_id: acceptedShot!.internal_timeline_revision_id }));
  const acceptedInternal = acceptedResponse.data.canonical_document.internal_timeline_revisions.find((candidate) => candidate.timeline_id === acceptedInternalManifest!.timeline_id && candidate.revision_id === acceptedShot!.internal_timeline_revision_id);
  expect(acceptedInternal, 'the accepted shot pin resolves to its accepted internal timeline').toBeTruthy();
  expect(acceptedShot!.internal_timeline_revision_id).not.toBe(initial.shot.internal_timeline_revision_id);
  expect(acceptedInternal!.payload).toEqual(initialInternal.payload);
  expect(acceptedInternal!.content_digest).toBe(initialInternal.content_digest);
  const acceptedInternalResponse = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${acceptedInternalManifest!.timeline_id}/revisions/${acceptedInternal!.revision_id}`);
  expect(acceptedInternalResponse.status, JSON.stringify(acceptedInternalResponse.body)).toBe(200);
  expect(acceptedInternalResponse.body).toMatchObject({
    timeline_id: acceptedInternal!.timeline_id,
    revision_id: acceptedInternal!.revision_id,
    content_digest: initialInternal.content_digest,
    payload: initialInternal.payload,
  });
  const acceptedShotManifest = acceptedResponse.data.canonical_document.dependency_manifest.shots.find((candidate) => candidate.shot_id === acceptedShot!.shot_id && candidate.revision_id === acceptedShot!.revision_id);
  expect(acceptedShotManifest).toEqual({
    shot_id: acceptedShot!.shot_id,
    revision_id: acceptedShot!.revision_id,
    internal_timeline_revision_id: acceptedShot!.internal_timeline_revision_id,
    content_digest: acceptedShot!.content_digest,
  });
  expect(acceptedInternalManifest).toEqual({
    timeline_id: acceptedInternal!.timeline_id,
    revision_id: acceptedInternal!.revision_id,
    content_digest: acceptedInternal!.content_digest,
  });
  const acceptedRaw = await rawSettingsShot(harness, settingsSeed, acceptedPin.revision_id);
  expect(acceptedRaw.shot).toMatchObject({
    shot_id: acceptedShot!.shot_id,
    revision_id: acceptedShot!.revision_id,
    internal_timeline_revision_id: acceptedShot!.internal_timeline_revision_id,
    content_digest: acceptedShot!.content_digest,
  });
  expect(acceptedRaw.shot.payload).toEqual({
    ...initial.shot.payload,
    internal_timeline_revision_id: acceptedShot!.internal_timeline_revision_id,
    settings: {
      ...initial.shot.payload.settings,
      advancedMode: false,
      motionMode: 'basic',
    },
  });

  // Reload consumes the accepted immutable head without a second settings write.
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await expect.poll(() => traffic.posts.length, CEILING).toBe(1);
  const reloaded = await rawSettingsShot(harness, settingsSeed, acceptedPin.revision_id);
  expect(reloaded.shot.payload.settings).toEqual(acceptedRaw.shot.payload.settings);

  // The mounted parent session's real Runtime inverse restores the raw true/true source.
  await expect.poll(() => page.getByRole('button', { name: 'Undo', exact: true }).isVisible(), CEILING).toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => traffic.posts.length, CEILING).toBe(2);
  await waitForPost(traffic.posts, 1);
  expect(traffic.posts[1].body.commands).toEqual([{ schema_version: 1, op: 'timeline.inverse', select: null, version: '1', args: { publications: [acceptedPin.publication_id] } }]);
  const undone = traffic.posts[1].response as CommitAcceptedMutation;
  const undoneRaw = await rawSettingsShot(harness, settingsSeed, pinOf(undone).revision_id);
  expect(undoneRaw.shot.payload).toEqual(initial.shot.payload);
  expect(traffic.legacy).toEqual([]);
});

test('M2 real embedded settings prompt: native shot.set preserves exact raw settings, retries after restart, and undoes through Runtime', async ({ page, harness, settingsSeed }) => {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  await openParent(page, harness);
  const traffic = observeTraffic(page);
  const initialHead = (await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${settingsSeed.timelineId}/composition-revisions?limit=1`)).body.items.find((item: any) => item.is_current_head).revision_id as string;
  const initial = await rawSettingsShot(harness, settingsSeed, initialHead);
  expect(initial.shot.payload.settings).toEqual({
    turboMode: true,
    advancedMode: true,
    motionMode: 'advanced',
    prompt: 'fixture prompt remains raw',
    negativePrompt: null,
    x_settings_opaque: settingsSeed.opaqueSettings,
  });

  const promptDialog = await openEmbeddedCanonicalShot(page, settingsSeed.occurrenceId, SETTINGS_SHOT_NAME);
  // The shared fixture intentionally starts with the original AutoDisable pair;
  // consume that mounted correction before exercising the distinct prompt case.
  await expect.poll(() => traffic.posts.length, CEILING).toBe(1);
  await waitForPost(traffic.posts, 0);
  const promptBase = pinOf(traffic.posts[0].response as CommitAcceptedMutation);
  const promptBaseRaw = await rawSettingsShot(harness, settingsSeed, promptBase.revision_id);
  const promptInput = promptDialog.locator('#batchVideoPrompt:visible').first();
  await expect(promptInput).toBeVisible();
  await promptInput.fill(ACCEPTED_PROMPT);
  await promptInput.blur();
  await expect.poll(() => promptCommitIndex(traffic.posts, ACCEPTED_PROMPT), CEILING).toBe(1);
  await waitForPost(traffic.posts, 1);
  const acceptedPrompt = traffic.posts[1];
  expect(acceptedPrompt.body).toMatchObject({
    base_revision_id: promptBase.revision_id,
    base_publication_id: promptBase.publication_id,
    commands: [{
      schema_version: 1,
      op: 'shot.set',
      version: '1',
      select: `occurrence:${settingsSeed.occurrenceId}/shot`,
      args: { values: { settings: { prompt: ACCEPTED_PROMPT } }, clear: [] },
    }],
  });
  expect(acceptedPrompt.body).not.toHaveProperty('parent_composition');
  expect(acceptedPrompt.body.commands[0].reads).toEqual(expect.arrayContaining([
    { ref: `occurrence:${settingsSeed.occurrenceId}`, path: ['occurrence_id'], state: { state: 'present', value: settingsSeed.occurrenceId } },
  ]));
  const acceptedPromptResponse = acceptedPrompt.response as CommitAcceptedMutation;
  expect(acceptedPromptResponse.data.status).toBe('accepted');
  const acceptedPromptPin = pinOf(acceptedPromptResponse);
  const acceptedPromptRaw = await rawSettingsShot(harness, settingsSeed, acceptedPromptPin.revision_id);
  expect(acceptedPromptRaw.shot.payload.settings).toEqual({
    ...promptBaseRaw.shot.payload.settings,
    prompt: ACCEPTED_PROMPT,
  });
  expect(acceptedPromptRaw.shot.payload).toEqual({
    ...promptBaseRaw.shot.payload,
    internal_timeline_revision_id: acceptedPromptRaw.shot.internal_timeline_revision_id,
    settings: { ...promptBaseRaw.shot.payload.settings, prompt: ACCEPTED_PROMPT },
  });

  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await expect.poll(() => traffic.posts.length, CEILING).toBe(1);
  const reloadedPrompt = await rawSettingsShot(harness, settingsSeed, acceptedPromptPin.revision_id);
  expect(reloadedPrompt.shot.payload.settings).toEqual(acceptedPromptRaw.shot.payload.settings);

  let releaseAck!: () => void;
  const ackGate = new Promise<void>((resolve) => { releaseAck = resolve; });
  let heldAck = false;
  const ackInterceptor = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (!heldAck) {
      heldAck = true;
      const response = await route.fetch({ maxRetries: 0 });
      const post = traffic.posts[traffic.posts.length - 1];
      post.status = response.status();
      post.response = await response.json();
      await ackGate;
      await route.abort('connectionreset').catch(() => {});
      return;
    }
    await acceptAndRecord(route, traffic.posts);
  };
  await page.route(COMMITS, ackInterceptor);
  const retryDialog = await openEmbeddedCanonicalShot(page, settingsSeed.occurrenceId, SETTINGS_SHOT_NAME);
  const retryInput = retryDialog.locator('#batchVideoPrompt:visible').first();
  await retryInput.fill(RETRY_PROMPT);
  await retryInput.blur();
  await expect.poll(() => promptCommitIndex(traffic.posts, RETRY_PROMPT), CEILING).toBe(2);
  await waitForPost(traffic.posts, 2);
  const acceptedRetry = traffic.posts[2];
  expect(acceptedRetry.body).toMatchObject({
    base_revision_id: acceptedPromptPin.revision_id,
    commands: [{
      schema_version: 1,
      op: 'shot.set',
      version: '1',
      select: `occurrence:${settingsSeed.occurrenceId}/shot`,
      args: { values: { settings: { prompt: RETRY_PROMPT } }, clear: [] },
    }],
  });
  const acceptedRetryResponse = acceptedRetry.response as CommitAcceptedMutation;
  expect(acceptedRetryResponse.data.status).toBe('accepted');
  const acceptedRetryPin = pinOf(acceptedRetryResponse);
  const acceptedRetryRaw = await rawSettingsShot(harness, settingsSeed, acceptedRetryPin.revision_id);
  expect(acceptedRetryRaw.shot.payload.settings).toEqual({
    ...acceptedPromptRaw.shot.payload.settings,
    prompt: RETRY_PROMPT,
  });
  const originalRetry = { body: acceptedRetry.rawBody, key: acceptedRetry.key };
  releaseAck();
  await expect.poll(async () => (await commandOutboxes(page, settingsSeed.timelineId)).find((owner) => owner.pending)?.pending?.outcome?.kind, CEILING).toBe('retry');
  await expect(retryInput).toHaveValue(RETRY_PROMPT);
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  const beforeRestart = (await commandOutboxes(page, settingsSeed.timelineId)).find((owner) => owner.pending?.request.key === originalRetry.key)!;
  expect(beforeRestart.scope).toMatchObject({ projectId: harness.seed.projectId, timelineId: settingsSeed.timelineId });
  expect(beforeRestart.intents[0]).toMatchObject({
    basis: { head: { revisionId: acceptedPromptPin.revision_id, publicationId: acceptedPromptPin.publication_id } },
    payload: { commands: [{ op: 'shot.set', select: `occurrence:${settingsSeed.occurrenceId}/shot`, args: { values: { settings: { prompt: RETRY_PROMPT } } } }] },
  });
  expect(beforeRestart.pending?.request.body).toBe(originalRetry.body);
  expect(beforeRestart.pending?.request.key).toBe(originalRetry.key);
  const ownerId = beforeRestart.ownerId;
  const restarted = await harness.restartRuntime();
  expect(restarted.oldInstanceId).not.toBe(harness.runtimeInstanceId);
  await expect(page.getByRole('heading', { name: 'Astrid restarted' })).toBeVisible(CEILING);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await page.getByRole('button', { name: /^Recover saved edits/ }).and(page.locator(`[data-owner-id="${ownerId}"]`)).click();
  await expect.poll(() => traffic.posts.length, CEILING).toBe(4);
  expect(traffic.posts[3].rawBody).toBe(originalRetry.body);
  expect(traffic.posts[3].key).toBe(originalRetry.key);
  expect(traffic.posts[3].response).toEqual(traffic.posts[2].response);
  await expect.poll(async () => (await commandOutboxes(page, settingsSeed.timelineId)).every((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);
  await page.unroute(COMMITS, ackInterceptor);

  const undoIndex = traffic.posts.length;
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => traffic.posts.length, CEILING).toBe(undoIndex + 1);
  await waitForPost(traffic.posts, undoIndex);
  expect(traffic.posts[undoIndex].body.commands).toEqual([{ schema_version: 1, op: 'timeline.inverse', select: null, version: '1', args: { publications: [acceptedRetryPin.publication_id] } }]);
  const undonePrompt = traffic.posts[undoIndex].response as CommitAcceptedMutation;
  const undonePromptRaw = await rawSettingsShot(harness, settingsSeed, pinOf(undonePrompt).revision_id);
  expect(undonePromptRaw.shot.payload.settings).toEqual({
    ...promptBaseRaw.shot.payload.settings,
    prompt: ACCEPTED_PROMPT,
  });
  expect(undonePromptRaw.shot.payload).toEqual({
    ...promptBaseRaw.shot.payload,
    internal_timeline_revision_id: undonePromptRaw.shot.internal_timeline_revision_id,
    settings: { ...promptBaseRaw.shot.payload.settings, prompt: ACCEPTED_PROMPT },
  });
  expect(traffic.legacy).toEqual([]);
});

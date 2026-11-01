/**
 * M2 real parent-track label journey.
 *
 * This is deliberately separate from three-products.spec.ts: the M1 mixed-editing case remains the
 * historical refusal proof, while this case is the positive command-path replacement for track labels.
 */
import { expect, type Page, type Request } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import {
  harnessUnavailableReason,
  REPO_ROOT,
  RUNTIME_CHECKOUT,
  type DirectHarness,
  type ThreeProductsSeed,
} from './support/harness.ts';
import {
  commandOutboxes,
  dragTimelineClip,
  editFirstTrackName,
  expectConnected,
  firstTrackName,
  holdCommandRequests,
  openApp,
  openSeededTimeline,
  revisionBody,
  test as appTest,
} from './support/app.ts';
import {
  ASTRID_CHECKOUT,
  ASTRID_PYTHON,
  AstridCli,
  astridUnavailableReason,
  revisionSet,
} from './support/astrid.ts';
import type {
  CanonicalDocument,
  CommitAcceptedMutation,
  HeadPin,
  HistoryPage,
} from '../../../src/integrations/runtime/timeline-commit-types.ts';

const CEILING = { timeout: 90_000 };
const COMMITS = /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/;
const LEGACY_SAVES = /\/timelines\/[^/]+\/composition-revisions$/;
const NEW_LABEL = 'Picture é 🎬';

type CommitPost = {
  request: Request;
  body: Record<string, any>;
};

const test = appTest.extend<object, { seed3: ThreeProductsSeed; astrid: AstridCli }>({
  seed3: [async ({ harness }, use) => { await use(await harness.seedThreeProducts()); }, { scope: 'worker', timeout: 240_000 }],
  astrid: [async ({ harness }, use) => { await use(await AstridCli.create(harness)); }, { scope: 'worker', timeout: 240_000 }],
});

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  const reason = harnessUnavailableReason() ?? astridUnavailableReason();
  if (reason) throw new Error(`the M2 track-label journey cannot run: ${reason}`);
  for (const name of ['TIMELINE_BUNDLE_AGENT_HEAD', 'TIMELINE_BUNDLE_RUNTIME_HEAD']) {
    if (!/^[0-9a-f]{40}$/.test(process.env[name] ?? '')) {
      throw new Error(`the current track-label cohort requires ${name} as a full 40-character SHA`);
    }
  }
  for (const [name, checkout, expected] of [
    ['app', REPO_ROOT, undefined],
    ['agent', ASTRID_CHECKOUT, process.env.TIMELINE_BUNDLE_AGENT_HEAD],
    ['runtime', RUNTIME_CHECKOUT, process.env.TIMELINE_BUNDLE_RUNTIME_HEAD],
  ]) {
    const git = (...args: string[]) => execFileSync('git', ['-C', checkout!, ...args], { encoding: 'utf8' }).trim();
    const head = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');
    const status = git('status', '--porcelain', '--untracked-files=normal');
    if (expected) {
      expect(head, `${name} must match the current retained source input`).toBe(expected);
      expect(status, `${name} retained source must be clean`).toBe('');
    }
    console.log('[track-label] source', JSON.stringify({ name, checkout, head, tree, status }));
  }
});

function pinOf(result: CommitAcceptedMutation): HeadPin {
  return { revision_id: result.data.accepted_revision_id, publication_id: result.receipt.receipt_id };
}

function trackIn(document: CanonicalDocument): Record<string, any> {
  const tracks = (document.parent_revision.payload.config as { tracks?: Array<Record<string, any>> }).tracks ?? [];
  const track = tracks.find((candidate) => candidate.id === 'V1');
  expect(track, 'the seeded parent track V1 remains addressable').toBeTruthy();
  return track!;
}

function expectOpaqueClosure(document: CanonicalDocument, seed: ThreeProductsSeed) {
  expect((document.parent_revision.payload.config as Record<string, any>).x_f2_opaque)
    .toEqual(seed.opaque.config);
  const child = document.internal_timeline_revisions
    .flatMap((revision) => ((revision.payload as Record<string, any>).clips as Array<Record<string, any>> | undefined) ?? [])
    .find((clip) => clip.id === seed.agentClipId);
  expect(child?.app?.f2Opaque, 'the Agent-owned opaque child state survives the App command').toEqual(seed.opaque.clip);
}

async function history(harness: DirectHarness, seed: ThreeProductsSeed): Promise<HistoryPage> {
  const response = await harness.runtimeJson<HistoryPage>('GET',
    `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

async function expectReadback(harness: DirectHarness, document: CanonicalDocument) {
  const root = `/v1/projects/${document.project_id}`;
  const parent = await harness.runtimeJson('GET',
    `${root}/timelines/${document.timeline_id}/composition-revisions/${document.parent_revision.revision_id}`);
  expect(parent.status, JSON.stringify(parent.body)).toBe(200);
  expect(parent.body).toMatchObject({ ...document.parent_revision, dependency_manifest: document.dependency_manifest });
  expect(parent.body.payload).toEqual(document.parent_revision.payload);
  for (const shot of document.shot_revisions) {
    const row = await harness.runtimeJson('GET', `${root}/shots/${shot.shot_id}/revisions/${shot.revision_id}`);
    expect(row.status, JSON.stringify(row.body)).toBe(200);
    expect(row.body).toMatchObject(shot);
    expect(row.body.payload).toEqual(shot.payload);
  }
  for (const internal of document.internal_timeline_revisions) {
    const row = await harness.runtimeJson('GET', `${root}/timelines/${internal.timeline_id}/revisions/${internal.revision_id}`);
    expect(row.status, JSON.stringify(row.body)).toBe(200);
    expect(row.body).toMatchObject(internal);
    expect(row.body.payload).toEqual(internal.payload);
  }
}

function attachTraffic(page: Page) {
  const commits: CommitPost[] = [];
  const legacy: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const pathname = new URL(request.url()).pathname;
    if (COMMITS.test(pathname)) commits.push({ request, body: request.postDataJSON() as Record<string, any> });
    if (LEGACY_SAVES.test(pathname)) legacy.push(pathname);
  });
  return { commits, legacy };
}

async function waitForCommitCount(commits: CommitPost[], count: number) {
  await expect.poll(() => commits.length, {
    ...CEILING,
    message: 'the real App gesture must produce the expected Runtime /v1 command commit',
  }).toBe(count);
}

test('M2 real move then ordinary Unicode track rename reloads and guarded UI undo preserves an Agent edit', async ({ page, harness, astrid, seed3 }, testInfo) => {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  const identity = await astrid.preflight();
  console.log('[track-label] identity', JSON.stringify(revisionSet(identity)));

  await openApp(page, harness);
  await expectConnected(page);
  await openSeededTimeline(page, harness);

  const originalHead = (await history(harness, seed3)).head;
  expect(originalHead.revision_id).toBe(seed3.headRevisionId);
  const originalBody = await revisionBody(harness, originalHead.revision_id);
  const originalPayload = originalBody.payload as Record<string, any>;
  const originalTrack = (originalPayload.config.tracks as Array<Record<string, any>>).find((track) => track.id === 'V1');
  expect(originalTrack, 'the seed has a parent V1 track').toBeTruthy();
  expect(Object.prototype.hasOwnProperty.call(originalTrack, 'label'), 'the original label is present, not a display fallback').toBe(true);
  expect(originalTrack!.label).toBe('V1');
  await expect(firstTrackName(page)).toHaveValue('V1');

  const traffic = attachTraffic(page);

  // Real pointer gesture first: the label command must be based on the accepted moved head.
  const moveResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await dragTimelineClip(page, seed3.appClipId, seed3.transitionClipId, 0, 5, 15);
  const movedResponse = await moveResponse;
  expect(movedResponse.status(), await movedResponse.text()).toBe(200);
  await waitForCommitCount(traffic.commits, 1);
  const moved = await movedResponse.json() as CommitAcceptedMutation;
  expect(traffic.commits[0].body).toMatchObject({
    base_revision_id: originalHead.revision_id, base_publication_id: originalHead.publication_id,
  });
  expect(pinOf(moved)).not.toEqual(originalHead);
  expect(moved.data.commands).toHaveLength(1);
  expect(moved.data.commands[0]).toMatchObject({ op: 'clip.move', select: `parent/clip:${seed3.appClipId}`, args: { on: 5 } });
  expectOpaqueClosure(moved.data.canonical_document, seed3);
  await expectReadback(harness, moved.data.canonical_document);

  // Consume the actual textbox through focus, typing and blur. No Enter shortcut or direct port is used.
  const label = firstTrackName(page);
  const renameResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await label.click();
  await label.press('Control+A');
  await label.type(NEW_LABEL);
  await label.blur();
  const renamed = await renameResponse;
  expect(renamed.status(), await renamed.text()).toBe(200);
  await waitForCommitCount(traffic.commits, 2);
  const renameRequest = traffic.commits[1];
  expect(renameRequest.body).toMatchObject({
    base_revision_id: moved.data.accepted_revision_id, base_publication_id: moved.receipt.receipt_id,
  });
  expect(renameRequest.body).not.toHaveProperty('parent_composition');
  expect(renameRequest.body.commands).toHaveLength(1);
  expect(renameRequest.body.commands[0]).toMatchObject({
    schema_version: 1,
    op: 'track.set',
    version: '1',
    select: 'parent/track:V1',
  });
  expect(renameRequest.body.commands[0].args).toEqual({ values: { label: NEW_LABEL }, clear: [] });
  expect(renameRequest.body.commands[0]).toMatchObject({
    expect: { 'parent/track:V1::label': { state: 'present', value: 'V1' } },
    reads: [{ ref: 'parent/track:V1', path: ['id'], state: { state: 'present', value: 'V1' } }],
    bindings: { 'scalar.target': 'parent/track:V1' },
  });
  const renamedResult = await renamed.json() as CommitAcceptedMutation;
  expect(renamedResult.data.status).toMatch(/^(accepted|rebased)$/);
  expect(trackIn(renamedResult.data.canonical_document).label).toBe(NEW_LABEL);
  expectOpaqueClosure(renamedResult.data.canonical_document, seed3);
  await expectReadback(harness, renamedResult.data.canonical_document);
  expect(renamedResult.data.canonical_document.internal_timeline_revisions)
    .toEqual(moved.data.canonical_document.internal_timeline_revisions);
  await expect(label).toHaveValue(NEW_LABEL);

  const renamePublication = pinOf(renamedResult);
  const renameHistory = await history(harness, seed3);
  expect(renameHistory.head).toEqual(renamePublication);
  expect(renameHistory.items.find((entry) => entry.publication_id === renamePublication.publication_id)?.records?.commands[0].command)
    .toMatchObject({ op: 'track.set', select: 'parent/track:V1', args: { values: { label: NEW_LABEL }, clear: [] } });

  // Reload must load the accepted Unicode label and the committed history, not a draft or display fallback.
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await expect(firstTrackName(page)).toHaveValue(NEW_LABEL);
  const reloadedHistory = await history(harness, seed3);
  expect(reloadedHistory.items.some((entry) => entry.publication_id === renamePublication.publication_id)).toBe(true);
  expect(reloadedHistory.head).toEqual(renamePublication);

  // A separate real Agent authoring edit changes a disjoint parent track before UI undo.
  const independent = await astrid.commitCaptured(
    harness.seed.projectId,
    seed3.timelineId,
    renamePublication,
    { kind: 'track', id: 'f2-independent-C' },
    'm2-track-label-independent',
  );
  expect(independent.data.canonical_document.parent_revision.payload.config).toMatchObject({
    tracks: expect.arrayContaining([expect.objectContaining({ id: 'f2-independent-C' })]),
  });
  expectOpaqueClosure(independent.data.canonical_document, seed3);
  await expectReadback(harness, independent.data.canonical_document);

  const undoResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const undoneResponse = await undoResponse;
  expect(undoneResponse.status(), await undoneResponse.text()).toBe(200);
  await waitForCommitCount(traffic.commits, 3);
  const undoRequest = traffic.commits[2];
  expect(undoRequest.body.commands).toEqual([{
    schema_version: 1,
    op: 'timeline.inverse',
    version: '1',
    select: null,
    args: { publications: [renamePublication.publication_id] },
  }]);
  const undone = await undoneResponse.json() as CommitAcceptedMutation;
  expect(undone.data.previous_revision_id).toBe(independent.data.accepted_revision_id);
  expect(undone.data.previous_publication_id).toBe(independent.receipt.receipt_id);
  expect(trackIn(undone.data.canonical_document)).toHaveProperty('label', 'V1');
  expect(undone.data.canonical_document.parent_revision.payload.config).toMatchObject({
    tracks: expect.arrayContaining([
      expect.objectContaining({ id: 'f2-independent-C' }),
      expect.objectContaining({ id: 'V1' }),
    ]),
  });
  expectOpaqueClosure(undone.data.canonical_document, seed3);
  await expectReadback(harness, undone.data.canonical_document);
  expect(undone.data.canonical_document.internal_timeline_revisions)
    .toEqual(independent.data.canonical_document.internal_timeline_revisions);
  const finalConfig = undone.data.canonical_document.parent_revision.payload.config as Record<string, any>;
  expect(finalConfig.clips.find((clip: Record<string, any>) => clip.id === seed3.appClipId).at).toBe(5);
  await expect(firstTrackName(page)).toHaveValue('V1');

  const finalHistory = await history(harness, seed3);
  const undoEntry = finalHistory.items.find((entry) => entry.publication_id === undone.receipt.receipt_id);
  expect(undoEntry?.records?.undo_of).toEqual([renamePublication.publication_id]);
  expect(finalHistory.head.revision_id).toBe(undone.data.accepted_revision_id);
  expect(finalHistory.head.publication_id).toBe(undone.receipt.receipt_id);
  expect(traffic.commits.map((post) => post.body.commands[0].op)).toEqual(['clip.move', 'track.set', 'timeline.inverse']);
  expect(traffic.commits.every((post) => !Object.prototype.hasOwnProperty.call(post.body, 'parent_composition'))).toBe(true);
  expect(traffic.legacy, 'M2 label editing must not emit legacy whole-config saves').toEqual([]);
  await testInfo.attach('track-label-readback', {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({
      sources: revisionSet(identity),
      commands: traffic.commits.map((post) => post.body),
      renamed: renamedResult.data.canonical_document,
      independent: independent.data.canonical_document,
      undone: undone.data.canonical_document,
      head: finalHistory.head,
      legacy: traffic.legacy,
    }, null, 2)),
  });
});


// Conflict cases start after an accepted move; the cold-open case below tests initial label-only loading.
async function acceptInitialMove(page: Page, harness: DirectHarness, seed: ThreeProductsSeed) {
  await expect.poll(() => commandOutboxes(page, seed.timelineId), CEILING).toHaveLength(1);
  const head = (await history(harness, seed)).head;
  const parent = await revisionBody(harness, head.revision_id);
  const from = parent.payload.config.clips.find((clip: { id: string }) => clip.id === seed.appClipId).at;
  const saving = page.waitForResponse((response) => response.request().method() === 'POST'
    && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await dragTimelineClip(page, seed.appClipId, seed.transitionClipId, from, from + 1, 15);
  const response = await saving;
  expect(response.status(), await response.text()).toBe(200);
  const moved = await response.json() as CommitAcceptedMutation;
  expect(moved.data.commands[0]).toMatchObject({ op: 'clip.move', select: `parent/clip:${seed.appClipId}`, args: { on: from + 1 } });
  await expect.poll(async () => (await commandOutboxes(page, seed.timelineId))
    .every((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);
  expectOpaqueClosure(moved.data.canonical_document, seed);
  await expectReadback(harness, moved.data.canonical_document);
}

// Only delivery/acknowledgement is faulted here; guards, outbox and acceptance are real product code.
test('M2 real label conflict Keep captures fresh guards, retries its lost ACK exactly after reload and undoes', async ({ page, harness, astrid, seed3 }) => {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  await astrid.preflight();
  await openApp(page, harness);
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await acceptInitialMove(page, harness, seed3);
  const traffic = attachTraffic(page);
  const before = await history(harness, seed3);
  const hold = await holdCommandRequests(page);
  await editFirstTrackName(page, 'My explicit label');
  await expect.poll(() => hold.requests.length, CEILING).toBe(1);
  const original = hold.requests[0];
  const originalBytes = original.postData()!;
  const originalKey = original.headers()['idempotency-key'];
  const body = original.postDataJSON();
  expect(body).toMatchObject({ base_revision_id: before.head.revision_id, base_publication_id: before.head.publication_id });
  expect(body.commands[0]).toMatchObject({ op: 'track.set', select: 'parent/track:V1',
    expect: { 'parent/track:V1::label': { state: 'present', value: 'V1' } } });
  const remote = await astrid.commitCaptured(harness.seed.projectId, seed3.timelineId, before.head,
    { kind: 'label', trackId: 'V1', label: 'Remote label' }, 'm2-label-real-conflict');
  const refusing = page.waitForResponse((response) => response.request() === original, CEILING);
  await hold.release(true);
  const refused = await refusing;
  expect(refused.status(), await refused.text()).toBe(409);
  expect((await refused.json()).details.status).toBe('conflict');
  const recovery = page.getByTestId('timeline-command-recovery');
  await expect(recovery).toContainText('Your changes are retained and need resolution');
  const rejected = (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.pending?.request.key === originalKey)!;
  expect(rejected.pending?.outcome?.kind).toBe('rejected');
  expect(rejected.pending?.request.body).toBe(originalBytes);
  expect(rejected.intents[0].payload).toMatchObject({ commands: body.commands });
  await expect(firstTrackName(page)).toHaveValue('My explicit label');
  expect((await history(harness, seed3)).head).toEqual(pinOf(remote));

  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  const persisted = (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.ownerId === rejected.ownerId)!;
  expect(persisted.pending).toEqual(rejected.pending);
  expect(persisted.intents).toEqual(rejected.intents);
  await page.getByRole('button', { name: /^Recover saved edits/ })
    .and(page.locator(`[data-owner-id="${rejected.ownerId}"]`)).click();
  await expect(recovery.getByRole('button', { name: 'Keep my changes', exact: true })).toBeEnabled();
  expect(traffic.commits).toHaveLength(1);

  // Accept the NEW Keep request at the real Runtime, then lose only its acknowledgement.
  let loseAck!: () => Promise<void>;
  let kept!: CommitAcceptedMutation;
  await page.route(COMMITS, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const response = await route.fetch({ maxRetries: 0 });
    expect(response.status(), await response.text()).toBe(200);
    kept = await response.json() as CommitAcceptedMutation;
    loseAck = () => route.abort('connectionreset');
  });
  await recovery.getByRole('button', { name: 'Keep my changes', exact: true }).click();
  await expect.poll(() => !!loseAck, CEILING).toBe(true);
  await waitForCommitCount(traffic.commits, 2);
  const replacement = traffic.commits[1].request;
  expect(replacement.headers()['idempotency-key']).not.toBe(originalKey);
  expect(replacement.postDataJSON()).toMatchObject({ base_revision_id: remote.data.accepted_revision_id,
    base_publication_id: remote.receipt.receipt_id, commands: [{ op: 'track.set', select: 'parent/track:V1',
      args: { values: { label: 'My explicit label' }, clear: [] },
      expect: { 'parent/track:V1::label': { state: 'present', value: 'Remote label' } } }] });
  const pending = (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.ownerId === rejected.ownerId)!;
  expect(pending.intents[0].id).not.toBe(rejected.intents[0].id);
  expect(original.postData()).toBe(originalBytes);
  expect(trackIn(kept.data.canonical_document).label).toBe('My explicit label');
  expectOpaqueClosure(kept.data.canonical_document, seed3);
  await expectReadback(harness, kept.data.canonical_document);
  const acceptedHistory = await history(harness, seed3);
  expect(acceptedHistory.head).toEqual(pinOf(kept));
  expect(acceptedHistory.items).toHaveLength(before.items.length + 2);
  await loseAck();
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId))
    .find((owner) => owner.ownerId === pending.ownerId)?.pending?.outcome?.kind, CEILING).toBe('retry');
  await expect(recovery.getByRole('button', { name: 'Retry save', exact: true })).toBeEnabled();
  await expect(recovery.getByRole('button', { name: 'Keep my changes', exact: true })).toHaveCount(0);
  await expect(recovery.getByRole('button', { name: 'Use latest version', exact: true })).toHaveCount(0);
  await page.unroute(COMMITS);
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  const reloaded = (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.ownerId === pending.ownerId)!;
  expect(reloaded.pending?.request).toEqual(pending.pending!.request);
  expect(reloaded.intents).toEqual(pending.intents);
  expect(traffic.commits).toHaveLength(2);
  const retrying = page.waitForResponse((response) => response.request().method() === 'POST'
    && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await page.getByRole('button', { name: /^Recover saved edits/ })
    .and(page.locator(`[data-owner-id="${pending.ownerId}"]`)).click();
  const retried = await retrying;
  expect(retried.status(), await retried.text()).toBe(200);
  expect(retried.request().postData()).toBe(replacement.postData());
  expect(retried.request().headers()['idempotency-key']).toBe(replacement.headers()['idempotency-key']);
  expect(await retried.json()).toEqual(kept);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId))
    .every((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);
  await expect(firstTrackName(page)).toHaveValue('My explicit label');
  expect(await history(harness, seed3)).toEqual(acceptedHistory);

  const undoing = page.waitForResponse((response) => response.request().method() === 'POST'
    && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const undoneResponse = await undoing;
  expect(undoneResponse.status(), await undoneResponse.text()).toBe(200);
  expect(undoneResponse.request().postDataJSON().commands).toEqual([{
    schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
    args: { publications: [pinOf(kept).publication_id] },
  }]);
  const undone = await undoneResponse.json() as CommitAcceptedMutation;
  expect(trackIn(undone.data.canonical_document).label).toBe('Remote label');
  expect(undone.data.canonical_document.internal_timeline_revisions).toEqual(remote.data.canonical_document.internal_timeline_revisions);
  expectOpaqueClosure(undone.data.canonical_document, seed3);
  await expectReadback(harness, undone.data.canonical_document);
  await expect(firstTrackName(page)).toHaveValue('Remote label');
  expect((await history(harness, seed3)).items.find((entry) => entry.publication_id === pinOf(undone).publication_id)?.records?.undo_of)
    .toEqual([pinOf(kept).publication_id]);
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await expect(firstTrackName(page)).toHaveValue('Remote label');
  expect(traffic.legacy).toEqual([]);
});

test('M2 real label conflict retains an unsupported suffix across reload and Use latest publishes nothing', async ({ page, harness, astrid, seed3 }) => {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  await astrid.preflight();
  await openApp(page, harness);
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await acceptInitialMove(page, harness, seed3);
  const traffic = attachTraffic(page);
  const before = await history(harness, seed3);
  const hold = await holdCommandRequests(page);
  await editFirstTrackName(page, 'Local A');
  await expect.poll(() => hold.requests.length, CEILING).toBe(1);
  const original = hold.requests[0];
  await editFirstTrackName(page, 'Dependent B');
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId))
    .find((owner) => owner.pending?.request.key === original.headers()['idempotency-key'])?.intents.length, CEILING).toBe(2);
  const authored = (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.pending?.request.key === original.headers()['idempotency-key'])!;
  expect(authored.intents[1]).toMatchObject({ basis: { after: authored.intents[0].id },
    payload: { commands: [{ op: 'track.set', select: 'parent/track:V1',
      args: { values: { label: 'Dependent B' }, clear: [] },
      expect: { 'parent/track:V1::label': { state: 'present', value: 'Local A' } } }] } });
  const remote = await astrid.commitCaptured(harness.seed.projectId, seed3.timelineId, before.head,
    { kind: 'label', trackId: 'V1', label: 'Latest remote' }, 'm2-label-suffix-conflict');
  const refusing = page.waitForResponse((response) => response.request() === original, CEILING);
  await hold.release(true);
  const refused = await refusing;
  expect(refused.status(), await refused.text()).toBe(409);
  expect((await refused.json()).details.status).toBe('conflict');
  const recovery = page.getByTestId('timeline-command-recovery');
  await expect(recovery).toContainText('Keeping these changes is not available for this conflict');
  await expect(recovery.getByRole('button', { name: 'Keep my changes', exact: true })).toHaveCount(0);
  await expect(firstTrackName(page)).toHaveValue('Dependent B');
  const rejected = (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.ownerId === authored.ownerId)!;
  const outcome = rejected.pending!.outcome!;
  expect(outcome).toMatchObject({ kind: 'rejected', error: { kind: 'conflict' } });
  if (outcome.kind !== 'rejected') throw new Error('Expected a definitive rejection');
  expect(rejected.intents).toEqual(authored.intents.map((intent) => ({ ...intent, conflict: outcome.error })));
  expect(rejected.pending?.request.body).toBe(original.postData());
  expect(rejected.pending?.outcome?.kind).toBe('rejected');
  const remoteHistory = await history(harness, seed3);
  expect(remoteHistory.head).toEqual(pinOf(remote));
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  const reloaded = (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.ownerId === rejected.ownerId)!;
  expect(reloaded.intents).toEqual(rejected.intents);
  expect(reloaded.pending).toEqual(rejected.pending);
  await page.getByRole('button', { name: /^Recover saved edits/ })
    .and(page.locator(`[data-owner-id="${rejected.ownerId}"]`)).click();
  await expect(firstTrackName(page)).toHaveValue('Dependent B');
  await expect(recovery).toContainText('Keeping these changes is not available for this conflict');
  expect(traffic.commits).toHaveLength(1);
  await recovery.getByRole('button', { name: 'Use latest version', exact: true }).click();
  await expect(firstTrackName(page)).toHaveValue('Latest remote');
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId))
    .every((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);
  expect(await history(harness, seed3)).toEqual(remoteHistory);
  await expectReadback(harness, remote.data.canonical_document);
  expectOpaqueClosure(remote.data.canonical_document, seed3);
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await expect(firstTrackName(page)).toHaveValue('Latest remote');
  expect(await history(harness, seed3)).toEqual(remoteHistory);
  expect(traffic.commits).toHaveLength(1);
  expect(traffic.legacy).toEqual([]);
});

test('M2 cold-open ordinary Unicode track rename uses the initial head and guarded UI undo', async ({ page, harness, astrid, seed3 }) => {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  const identity = await astrid.preflight();
  console.log('[track-label-cold] identity', JSON.stringify(revisionSet(identity)));

  // This is the fresh Runtime/API seed path: the first App edit is the label rename itself.
  const traffic = attachTraffic(page);
  await openApp(page, harness);
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  expect(traffic.commits).toHaveLength(0);
  expect(traffic.legacy).toEqual([]);

  const initialHead = (await history(harness, seed3)).head;
  expect(initialHead).toEqual({ revision_id: seed3.headRevisionId, publication_id: expect.any(String) });
  const initialBody = await revisionBody(harness, initialHead.revision_id);
  expect(initialBody).toMatchObject({ revision_id: initialHead.revision_id, timeline_id: seed3.timelineId });
  const initialPayload = initialBody.payload as Record<string, any>;
  const initialConfig = JSON.parse(JSON.stringify(initialPayload.config)) as Record<string, any>;
  const initialTrack = (initialConfig.tracks as Array<Record<string, any>>).find((track) => track.id === 'V1');
  expect(initialTrack, 'the cold-open source has an editable parent V1 track').toBeTruthy();
  expect(initialTrack).toMatchObject({ id: 'V1', kind: 'visual', label: 'V1' });
  expect(initialConfig.x_f2_opaque).toEqual(seed3.opaque.config);
  await expect(firstTrackName(page)).toHaveValue('V1');

  const hold = await holdCommandRequests(page);
  const label = firstTrackName(page);
  const renameResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await label.click();
  await label.press('Control+A');
  await label.type(NEW_LABEL);
  await label.blur();
  await expect.poll(() => hold.requests.length, CEILING).toBe(1);

  // The native durable outbox carries the real initial revision/publication pair into the request.
  const renameRequest = hold.requests[0];
  expect(renameRequest.postDataJSON()).toMatchObject({
    base_revision_id: initialHead.revision_id,
    base_publication_id: initialHead.publication_id,
    commands: [{
      op: 'track.set', select: 'parent/track:V1', args: { values: { label: NEW_LABEL }, clear: [] },
      expect: { 'parent/track:V1::label': { state: 'present', value: 'V1' } },
      reads: [{ ref: 'parent/track:V1', path: ['id'], state: { state: 'present', value: 'V1' } }],
      bindings: { 'scalar.target': 'parent/track:V1' },
    }],
  });
  const pendingOwners = await commandOutboxes(page, seed3.timelineId);
  expect(pendingOwners).toHaveLength(1);
  expect(pendingOwners[0].pending?.request.key).toBe(renameRequest.headers()['idempotency-key']);
  expect(pendingOwners[0].pending?.request.body).toBe(renameRequest.postData());
  expect(pendingOwners[0].intents).toHaveLength(1);
  expect(traffic.legacy).toEqual([]);

  await hold.release(true);
  const renamedResponse = await renameResponse;
  expect(renamedResponse.status(), await renamedResponse.text()).toBe(200);
  await waitForCommitCount(traffic.commits, 1);
  const renamed = await renamedResponse.json() as CommitAcceptedMutation;
  expect(renamed.data.status).toBe('accepted');
  expect(trackIn(renamed.data.canonical_document)).toHaveProperty('label', NEW_LABEL);
  expectOpaqueClosure(renamed.data.canonical_document, seed3);
  const renamedConfig = renamed.data.canonical_document.parent_revision.payload.config as Record<string, any>;
  const expectedRenamedConfig = JSON.parse(JSON.stringify(initialConfig)) as Record<string, any>;
  expectedRenamedConfig.tracks.find((track: Record<string, any>) => track.id === 'V1').label = NEW_LABEL;
  expect(renamedConfig).toEqual(expectedRenamedConfig);
  await expectReadback(harness, renamed.data.canonical_document);

  const renamedHead = pinOf(renamed);
  expect(await history(harness, seed3)).toMatchObject({ head: renamedHead });
  await expect(label).toHaveValue(NEW_LABEL);

  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await expect(firstTrackName(page)).toHaveValue(NEW_LABEL);
  expect((await history(harness, seed3)).head).toEqual(renamedHead);

  const undoResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const undoneResponse = await undoResponse;
  expect(undoneResponse.status(), await undoneResponse.text()).toBe(200);
  await waitForCommitCount(traffic.commits, 2);
  expect(traffic.commits[1].body.commands).toEqual([{
    schema_version: 1,
    op: 'timeline.inverse',
    version: '1',
    select: null,
    args: { publications: [renamedHead.publication_id] },
  }]);
  const undone = await undoneResponse.json() as CommitAcceptedMutation;
  expect(undone.data.previous_revision_id).toBe(renamedHead.revision_id);
  expect(undone.data.previous_publication_id).toBe(renamedHead.publication_id);
  expect(trackIn(undone.data.canonical_document)).toHaveProperty('label', 'V1');
  expect(undone.data.canonical_document.parent_revision.payload.config).toEqual(initialConfig);
  expectOpaqueClosure(undone.data.canonical_document, seed3);
  await expectReadback(harness, undone.data.canonical_document);

  const finalHead = pinOf(undone);
  const finalHistory = await history(harness, seed3);
  expect(finalHistory.head).toEqual(finalHead);
  expect(finalHistory.items.find((entry) => entry.publication_id === finalHead.publication_id)?.records?.undo_of)
    .toEqual([renamedHead.publication_id]);
  expect(traffic.commits.map((post) => post.body.commands[0].op)).toEqual(['track.set', 'timeline.inverse']);
  expect(traffic.commits.every((post) => !Object.prototype.hasOwnProperty.call(post.body, 'parent_composition'))).toBe(true);
  expect(traffic.legacy).toEqual([]);

  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await expect(firstTrackName(page)).toHaveValue('V1');
  expect((await history(harness, seed3)).head).toEqual(finalHead);
});

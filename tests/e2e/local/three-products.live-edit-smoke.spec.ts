import { expect, type Response } from '@playwright/test';
import { APP_ENTRY_ROUTE, dragTimelineClip, expectConnected, firstTrackName, openSeededTimeline, revisionBody, test as appTest } from './support/app.ts';
import { AstridCli } from './support/astrid.ts';
import { harnessUnavailableReason, startDirectHarness, type DirectHarness, type ThreeProductsSeed } from './support/harness.ts';
import type { CommitAcceptedMutation, HeadPin, HistoryPage } from '../../../src/integrations/runtime/timeline-commit-types.ts';

const CEILING = { timeout: 90_000 };
const REMOTE_VISIBLE_TIMEOUT = 10_000;
const COMMITS = /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/;
const REMOTE_LABEL = 'Agent live D79 edit';

const test = appTest.extend<object, { seed3: ThreeProductsSeed; astrid: AstridCli }>({
  // Match the proven D66/P1 normal stack: P3 owns initialization of the
  // common pristine Runtime shell, and the three-product seed is the first
  // authored fixture on the Astrid profile.
  // eslint-disable-next-line no-empty-pattern
  harness: [async ({}, use) => {
    const harness = await startDirectHarness({ deferTimelineInitialization: true });
    try { await use(harness); } finally { await harness.stop(); }
  }, { scope: 'worker', timeout: 240_000 }],
  seed3: [async ({ harness }, use) => { await use(await harness.seedThreeProducts()); }, { scope: 'worker', timeout: 240_000 }],
  astrid: [async ({ harness }, use) => { await use(await AstridCli.create(harness)); }, { scope: 'worker', timeout: 240_000 }],
});

test.beforeAll(() => {
  const reason = harnessUnavailableReason();
  if (reason) throw new Error(`D79 live-edit smoke cannot run: ${reason}`);
});

async function history(harness: DirectHarness, seed: ThreeProductsSeed): Promise<HistoryPage> {
  const response = await harness.runtimeJson<HistoryPage>('GET',
    `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

function pinOf(result: CommitAcceptedMutation): HeadPin {
  return { revision_id: result.data.accepted_revision_id, publication_id: result.receipt.receipt_id };
}

function remotePayloadSeen(response: Response): Promise<boolean> {
  if (response.request().method() !== 'GET') return Promise.resolve(false);
  return response.text().then((text) => text.includes(REMOTE_LABEL)).catch(() => false);
}

test('D79 live-edit smoke: Agent edit arrives during a held drag and remote undo stays safe', async ({ page, harness, astrid, seed3 }) => {
  await astrid.preflight();
  await page.goto(`${harness.origin}${APP_ENTRY_ROUTE}`);
  await expectConnected(page);
  await openSeededTimeline(page, harness);

  const before = (await history(harness, seed3)).head;
  const original = await revisionBody(harness, before.revision_id);
  const originalTrack = (original.payload.config.tracks as Array<Record<string, any>>).find((track) => track.id === 'V1');
  expect(originalTrack?.label).toBe('V1');
  await expect(firstTrackName(page)).toHaveValue('V1');

  let remoteSnapshotSeenDuringHold = false;
  page.on('response', (response) => {
    void remotePayloadSeen(response).then((seen) => {
      if (seen) remoteSnapshotSeenDuringHold = true;
    });
  });

  let heldClipX: number | undefined;
  const clip = page.locator(`.clip-action[data-clip-id="${seed3.appClipId}"]`).first();
  const initialClipBox = await clip.boundingBox();
  expect(initialClipBox).toBeTruthy();

  let agentTurnFinishedAt = 0;
  const localCommit = page.waitForResponse((response) => response.request().method() === 'POST'
    && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await dragTimelineClip(page, seed3.appClipId, seed3.transitionClipId, 0, 5, 15, async () => {
    heldClipX = (await clip.boundingBox())?.x;
    const remote = await astrid.commitCaptured(harness.seed.projectId, seed3.timelineId, before,
      { kind: 'label', trackId: 'V1', label: REMOTE_LABEL }, 'd79-agent-live-edit');
    expect(remote.data.status).toBe('accepted');
    agentTurnFinishedAt = Date.now();

    // This wait runs before dragTimelineClip releases the real pointer. The
    // response is therefore a genuine usePollSync arrival during the hold.
    await expect.poll(() => remoteSnapshotSeenDuringHold, {
      timeout: REMOTE_VISIBLE_TIMEOUT,
      message: 'the open editor must poll the Agent revision while the drag is held',
    }).toBe(true);
    await expect(firstTrackName(page)).toHaveValue('V1');
  });

  expect(heldClipX).toBeGreaterThan(initialClipBox!.x + 10);
  const localResponse = await localCommit;
  expect(localResponse.status(), await localResponse.text()).toBe(200);
  const local = await localResponse.json() as CommitAcceptedMutation;
  expect(local.data.status).toMatch(/^(accepted|rebased)$/);
  expect(local.data.canonical_document.parent_revision.payload.config.clips)
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: seed3.appClipId, at: 5 })]));

  // The remote payload was observed during the hold; after release it must be
  // adopted by the real poll path within the owner-requested ten seconds.
  await expect.poll(() => firstTrackName(page).inputValue(), {
    timeout: REMOTE_VISIBLE_TIMEOUT,
    message: 'the open timeline must show the Agent edit within ten seconds of the CLI turn',
  }).toBe(REMOTE_LABEL);
  expect(Date.now() - agentTurnFinishedAt).toBeLessThanOrEqual(REMOTE_VISIBLE_TIMEOUT);

  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeEnabled();
  const commitsBeforeUndo = (await history(harness, seed3)).items.length;
  const undoResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await undo.click();
  const undoneResponse = await undoResponse;
  expect(undoneResponse.status(), await undoneResponse.text()).toBe(200);
  const undone = await undoneResponse.json() as CommitAcceptedMutation;
  expect(undone.data.canonical_document.parent_revision.payload.config.clips)
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: seed3.appClipId, at: 0 })]));

  // Undo may remove the local drag, but the remoteCommit boundary must prevent
  // the pre-remote V1 snapshot from coming back.
  await expect(firstTrackName(page)).toHaveValue(REMOTE_LABEL);
  const finalHistory = await history(harness, seed3);
  expect(finalHistory.items.length).toBeGreaterThan(commitsBeforeUndo);
  expect(finalHistory.items.find((entry) => entry.publication_id === pinOf(undone).publication_id)?.records?.undo_of)
    .toEqual([local.receipt.receipt_id]);
});

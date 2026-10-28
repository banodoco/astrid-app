import { expect, type Page, type Request, type Response } from '@playwright/test';
import { THREE_PRODUCTS_REFERENCE_AT, type DirectHarness, type ThreeProductsSeed } from './support/harness.ts';
import { openEmbeddedCanonicalShot, revisionBody, test as appTest } from './support/app.ts';
import { ASTRID_PYTHON } from './support/astrid.ts';
import type { CanonicalDocument, CommitRequest, CommitAcceptedMutation, Manifest } from '../../../src/integrations/runtime/timeline-commit-types.ts';

const COMMITS = /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/;
const CEILING = { timeout: 90_000 };

type JsonObject = Record<string, unknown>;

interface CommitPost {
  request: Request;
  response: Response;
  body: CommitRequest;
  json: CommitAcceptedMutation;
}

function object(value: unknown, label: string): JsonObject {
  expect(value, label).toBeTruthy();
  expect(typeof value, label).toBe('object');
  expect(Array.isArray(value), label).toBe(false);
  return value as JsonObject;
}

function childClips(document: CanonicalDocument, occurrenceId: string): JsonObject[] {
  const parent = object(document.parent_revision.payload, 'parent payload');
  const occurrences = parent.occurrences as JsonObject[];
  const occurrence = occurrences.find((candidate) => candidate.occurrence_id === occurrenceId);
  expect(occurrence, `occurrence ${occurrenceId}`).toBeTruthy();
  const shot = document.shot_revisions.find((candidate) => candidate.revision_id === occurrence!.shot_revision_id);
  expect(shot, `shot revision for ${occurrenceId}`).toBeTruthy();
  const internal = document.internal_timeline_revisions.find(
    (candidate) => candidate.revision_id === shot!.internal_timeline_revision_id,
  );
  expect(internal, `internal timeline for ${occurrenceId}`).toBeTruthy();
  const payload = object(internal!.payload, 'shot timeline payload');
  expect(Array.isArray(payload.clips), 'shot timeline clips').toBe(true);
  return payload.clips as JsonObject[];
}

function parentContainsClip(document: CanonicalDocument, clipId: string): boolean {
  const parent = object(document.parent_revision.payload, 'parent payload');
  const config = object(parent.config, 'parent config');
  const parentClips = Array.isArray(parent.clips) ? parent.clips : [];
  const configClips = Array.isArray(config.clips) ? config.clips : [];
  return [...parentClips, ...configClips].some((clip) => object(clip, 'parent clip').id === clipId);
}

async function canonicalDocumentAt(harness: DirectHarness, seed: ThreeProductsSeed, revisionId: string): Promise<CanonicalDocument> {
  const parent = await revisionBody(harness, revisionId) as Record<string, any>;
  const manifest = parent.dependency_manifest as Manifest;
  const root = `/v1/projects/${harness.seed.projectId}`;
  const shots = await Promise.all(manifest.shots.map(async (pin) => {
    const response = await harness.runtimeJson('GET', `${root}/shots/${pin.shot_id}/revisions/${pin.revision_id}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { ...pin, payload: response.body.payload };
  }));
  const internals = await Promise.all(manifest.internal_timelines.map(async (pin) => {
    const response = await harness.runtimeJson('GET', `${root}/timelines/${pin.timeline_id}/revisions/${pin.revision_id}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { ...pin, payload: response.body.payload };
  }));
  return {
    schema_version: 1,
    project_id: harness.seed.projectId,
    timeline_id: seed.timelineId,
    parent_revision: { revision_id: parent.revision_id, content_digest: parent.content_digest, payload: parent.payload },
    shot_revisions: shots,
    internal_timeline_revisions: internals,
    dependency_manifest: manifest,
  };
}

async function openTimeline(page: Page, harness: DirectHarness, seed: ThreeProductsSeed): Promise<void> {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  await page.goto(`${harness.origin}/tools/video-editor`);
  await expect(page.locator('[data-testid="runtime-connection-status"]')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByRole('combobox', { name: 'Select project' })).toContainText(harness.seed.projectName);
  await expect(page.getByRole('textbox', { name: 'Track name' }).first()).toBeVisible();
  await expect(page.locator('[data-testid="runtime-not-connected"]')).toHaveCount(0);
  expect(seed.timelineId).toBe(harness.seed.timelineId);
}

async function commitFromGesture(page: Page, gesture: () => Promise<void>): Promise<CommitPost> {
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && COMMITS.test(new URL(response.url()).pathname),
    CEILING,
  );
  await gesture();
  const response = await responsePromise;
  const request = response.request();
  return {
    request,
    response,
    body: request.postDataJSON() as CommitRequest,
    json: await response.json() as CommitAcceptedMutation,
  };
}

async function dragGalleryImageIntoShot(page: Page): Promise<void> {
  await page.evaluate(() => {
    const source = [...document.querySelectorAll<HTMLElement>('[data-testid="generations-pane"] [data-gallery-item-id]')]
      .find((tile) => tile.querySelector('img'));
    const target = document.querySelector<HTMLElement>('[role="dialog"] .timeline-wrapper [data-row-id="V2"]');
    const firstAnchor = target?.querySelector<HTMLElement>('.clip-action[data-clip-id="f2-agent-clip"]');
    const lastAnchor = target?.querySelector<HTMLElement>('.clip-action[data-clip-id="f2-agent-clear-clip"]');
    if (!source) throw new Error('The locked bottom gallery has no draggable image tile.');
    if (!target) throw new Error('The open shot editor has no existing V2 timeline track.');
    if (!firstAnchor || !lastAnchor) throw new Error('The existing V2 timeline track has no seeded clips to anchor the drop.');
    const targetBox = target.getBoundingClientRect();
    const firstBox = firstAnchor.getBoundingClientRect();
    const lastBox = lastAnchor.getBoundingClientRect();
    const pixelsPerSecond = (lastBox.left - firstBox.left) / 3;
    const clientX = lastBox.right + pixelsPerSecond * 2.5;
    const clientY = targetBox.top + Math.max(1, targetBox.height / 2);
    const dataTransfer = new DataTransfer();
    const event = (type: 'dragstart' | 'dragover' | 'drop' | 'dragend') => new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      dataTransfer,
    });
    source.dispatchEvent(event('dragstart'));
    target.dispatchEvent(event('dragover'));
    target.dispatchEvent(event('drop'));
    source.dispatchEvent(event('dragend'));
  });
}

async function dragGalleryImageOntoNewShotTrack(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const source = [...document.querySelectorAll<HTMLElement>('[data-testid="generations-pane"] [data-gallery-item-id]')]
      .find((tile) => tile.querySelector('img'));
    const wrapper = document.querySelector<HTMLElement>('[role="dialog"] .timeline-wrapper');
    const row = wrapper?.querySelector<HTMLElement>('[data-row-id="V2"]');
    const editArea = wrapper?.querySelector<HTMLElement>('.timeline-canvas-edit-area');
    const firstAnchor = row?.querySelector<HTMLElement>('.clip-action[data-clip-id="f2-agent-clip"]');
    if (!source) throw new Error('The locked bottom gallery has no draggable image tile.');
    if (!wrapper || !row || !editArea) throw new Error('The open shot editor has no timeline drop area.');
    if (!firstAnchor) throw new Error('The existing V2 timeline track has no seeded clip to anchor the drop.');
    const rowBox = row.getBoundingClientRect();
    const editAreaBox = editArea.getBoundingClientRect();
    const firstBox = firstAnchor.getBoundingClientRect();
    const clientX = firstBox.left + Math.max(1, firstBox.width / 2);
    // Stay inside the edit area while sampling below the rendered row. The
    // bottom edge is the new-track zone, so use the nearest in-bounds point
    // when the viewport has less than 8px of empty space.
    const clientY = Math.min(rowBox.bottom + 8, editAreaBox.bottom - 2);
    if (clientY <= rowBox.bottom || clientY < editAreaBox.top || clientY > editAreaBox.bottom) {
      throw new Error('The timeline edit area has no in-bounds empty space below the existing row.');
    }
    const dataTransfer = new DataTransfer();
    const event = (type: 'dragstart' | 'dragover' | 'drop' | 'dragend') => new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      dataTransfer,
    });
    source.dispatchEvent(event('dragstart'));
    wrapper.dispatchEvent(event('dragover'));
    const targetedNewTrack = await new Promise<boolean>((resolve) => {
      const deadline = performance.now() + 1_000;
      const waitForIndicator = () => {
        if (editArea.classList.contains('drop-target-new-track')) {
          resolve(true);
        } else if (performance.now() >= deadline) {
          resolve(false);
        } else {
          requestAnimationFrame(waitForIndicator);
        }
      };
      requestAnimationFrame(waitForIndicator);
    });
    wrapper.dispatchEvent(event('drop'));
    source.dispatchEvent(event('dragend'));
    return targetedNewTrack;
  });
}

async function reloadAndOpenShot(page: Page, harness: DirectHarness, seed: ThreeProductsSeed, revisionId: string) {
  await page.reload();
  await expect(page.locator('[data-testid="runtime-connection-status"]')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByRole('textbox', { name: 'Track name' }).first()).toBeVisible();
  const head = await harness.runtimeJson<{ head_revision_id: string }>(
    'GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}`,
  );
  expect(head.status, JSON.stringify(head.body)).toBe(200);
  expect(head.body.head_revision_id).toBe(revisionId);
  await expect(page.getByTestId('preview-revision-unavailable')).toHaveCount(0);
  return openEmbeddedCanonicalShot(page, seed.occurrenceId, 'F2 agent shot');
}

appTest('C2 gallery drag into shot saves exactly one shot-local clip, reloads, and undoes', async ({ page, harness }) => {
  const seed = await harness.seedThreeProducts(THREE_PRODUCTS_REFERENCE_AT, 'native-none', 14);
  await openTimeline(page, harness, seed);

  // Use the existing lockable bottom gallery. This is intentionally opened before
  // the shot editor so the journey proves that the gallery stays usable behind it.
  // The closed desktop control is an intentionally small hoverable grip; expand it
  // before clicking its opacity-hidden Open Gallery action.
  await page.locator('[data-pane-control][data-pane-control-side="bottom"]').hover();
  await page.getByRole('button', { name: 'Open Gallery', exact: true }).click();
  await expect(page.getByTestId('generations-pane')).toBeVisible();
  await page.getByRole('button', { name: 'Lock pane', exact: true }).click();
  const galleryImage = page.locator('[data-testid="generations-pane"] [data-gallery-item-id]:has(img)').first();
  await expect(galleryImage).toBeVisible(CEILING);

  const beforeHead = await harness.runtimeJson<{ head_revision_id: string }>(
    'GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}`,
  );
  const before = await canonicalDocumentAt(harness, seed, beforeHead.body.head_revision_id);
  const beforeChild = childClips(before, seed.occurrenceId);

  const dialog = await openEmbeddedCanonicalShot(page, seed.occurrenceId, 'F2 agent shot');
  await expect(page.locator('[data-dialog-backdrop]')).toHaveCount(0);
  await expect(page.locator('[data-video-editor-instance]').first()).toHaveAttribute('inert', '');
  await expect(galleryImage).toBeVisible();
  await expect(dialog.locator('.timeline-wrapper').first()).toBeVisible();

  const post = await commitFromGesture(page, () => dragGalleryImageIntoShot(page));
  const command = object(post.body.commands[0], 'gallery drop command');
  expect(command.op).toBe('occurrence.add-media');
  expect(command.select).toBe(`occurrence:${seed.occurrenceId}`);
  const row = object(object(command.args, 'gallery drop args').row, 'new shot clip');
  expect(row.id).toEqual(expect.any(String));

  const after = post.json.data.canonical_document;
  const afterChild = childClips(after, seed.occurrenceId);
  expect(afterChild.filter((clip) => !beforeChild.some((known) => known.id === clip.id)))
    .toEqual([expect.objectContaining({ id: row.id })]);
  expect(afterChild).toHaveLength(beforeChild.length + 1);
  expect(parentContainsClip(after, row.id as string)).toBe(false);

  const occurrenceId = seed.occurrenceId;
  const shotClipId = row.id as string;
  const projectedClipId = `${occurrenceId}:${shotClipId}`;
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator(`.clip-action[data-clip-id="${projectedClipId}"]`)).toHaveCount(0);

  const reloadedDialog = await reloadAndOpenShot(page, harness, seed, after.parent_revision.revision_id);
  await expect(reloadedDialog.locator(`.clip-action[data-clip-id="${shotClipId}"]`)).toHaveCount(1);
  await reloadedDialog.getByRole('button', { name: 'Close', exact: true }).click();

  const undo = await commitFromGesture(page, async () => {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
  });
  expect(undo.body.commands[0]).toMatchObject({ op: 'timeline.inverse' });
  const undone = undo.json.data.canonical_document;
  expect(undone.parent_revision.payload).toEqual(before.parent_revision.payload);
  expect(undone.shot_revisions).toEqual(before.shot_revisions);
  expect(undone.internal_timeline_revisions).toEqual(before.internal_timeline_revisions);

  const undoneDialog = await reloadAndOpenShot(page, harness, seed, undone.parent_revision.revision_id);
  await expect(undoneDialog.locator(`.clip-action[data-clip-id="${shotClipId}"]`)).toHaveCount(0);
});

appTest('C2 gallery drop onto a new shot track is refused without a commit or partial mutation', async ({ page, harness }) => {
  const seed = await harness.seedThreeProducts(THREE_PRODUCTS_REFERENCE_AT, 'native-none', 14);
  await openTimeline(page, harness, seed);

  await page.locator('[data-pane-control][data-pane-control-side="bottom"]').hover();
  await page.getByRole('button', { name: 'Open Gallery', exact: true }).click();
  await expect(page.getByTestId('generations-pane')).toBeVisible();
  await page.getByRole('button', { name: 'Lock pane', exact: true }).click();
  const galleryImage = page.locator('[data-testid="generations-pane"] [data-gallery-item-id]:has(img)').first();
  await expect(galleryImage).toBeVisible(CEILING);

  const beforeHead = await harness.runtimeJson<{ head_revision_id: string }>(
    'GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}`,
  );
  const before = await canonicalDocumentAt(harness, seed, beforeHead.body.head_revision_id);
  const dialog = await openEmbeddedCanonicalShot(page, seed.occurrenceId, 'F2 agent shot');
  await expect(page.locator('[data-video-editor-instance]').first()).toHaveAttribute('inert', '');
  await expect(galleryImage).toBeVisible();

  const commitRequests: Request[] = [];
  const recordCommit = (request: Request) => {
    if (request.method() === 'POST' && COMMITS.test(new URL(request.url()).pathname)) commitRequests.push(request);
  };
  page.on('request', recordCommit);
  const targetedNewTrack = await dragGalleryImageOntoNewShotTrack(page);
  expect(targetedNewTrack, 'the gallery gesture must target the new-track drop zone').toBe(true);
  await expect(page.getByText(
    'Gallery drops onto a new shot track are not supported yet. Drop the gallery item onto an existing shot track; nothing was saved.',
    { exact: true },
  )).toBeVisible(CEILING);
  await page.waitForTimeout(100);
  page.off('request', recordCommit);

  expect(commitRequests, 'the refused drop never reaches the Runtime commit endpoint').toHaveLength(0);
  const afterHead = await harness.runtimeJson<{ head_revision_id: string }>(
    'GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}`,
  );
  expect(afterHead.body.head_revision_id).toBe(beforeHead.body.head_revision_id);
  const after = await canonicalDocumentAt(harness, seed, afterHead.body.head_revision_id);
  expect(after.parent_revision.payload).toEqual(before.parent_revision.payload);
  expect(after.shot_revisions).toEqual(before.shot_revisions);
  expect(after.internal_timeline_revisions).toEqual(before.internal_timeline_revisions);
});

appTest('C2 shot editor blocks parent Undo while the locked bottom gallery remains usable', async ({ page, harness }) => {
  const seed = await harness.seedThreeProducts(THREE_PRODUCTS_REFERENCE_AT, 'native-none', 14);
  await openTimeline(page, harness, seed);

  await page.locator('[data-pane-control][data-pane-control-side="bottom"]').hover();
  await page.getByRole('button', { name: 'Open Gallery', exact: true }).click();
  await expect(page.getByTestId('generations-pane')).toBeVisible();
  await page.getByRole('button', { name: 'Lock pane', exact: true }).click();
  const galleryImage = page.locator('[data-testid="generations-pane"] [data-gallery-item-id]:has(img)').first();
  await expect(galleryImage).toBeVisible(CEILING);

  const beforeHead = await harness.runtimeJson<{ head_revision_id: string }>(
    'GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}`,
  );
  const before = await canonicalDocumentAt(harness, seed, beforeHead.body.head_revision_id);
  const dialog = await openEmbeddedCanonicalShot(page, seed.occurrenceId, 'F2 agent shot');
  await expect(page.locator('[data-dialog-backdrop]')).toHaveCount(0);
  const parentEditor = page.locator('[data-video-editor-instance]').first();
  await expect(parentEditor).toHaveAttribute('inert', '');
  await expect(galleryImage).toBeVisible();
  await expect(dialog.locator('.timeline-wrapper').first()).toBeVisible();

  const parentCommitRequests: Request[] = [];
  const recordParentCommit = (request: Request) => {
    if (request.method() === 'POST' && COMMITS.test(new URL(request.url()).pathname)) parentCommitRequests.push(request);
  };
  page.on('request', recordParentCommit);
  const parentUndo = parentEditor.getByRole('button', { name: 'Undo', exact: true });
  await expect(parentUndo).toBeEnabled();
  await parentUndo.click({ force: true });
  await page.waitForTimeout(250);
  page.off('request', recordParentCommit);
  expect(parentCommitRequests, 'the inert parent editor cannot submit Undo').toHaveLength(0);

  const unchangedHead = await harness.runtimeJson<{ head_revision_id: string }>(
    'GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}`,
  );
  expect(unchangedHead.body.head_revision_id).toBe(beforeHead.body.head_revision_id);
  const unchanged = await canonicalDocumentAt(harness, seed, unchangedHead.body.head_revision_id);
  expect(unchanged.parent_revision.payload).toEqual(before.parent_revision.payload);
  expect(unchanged.shot_revisions).toEqual(before.shot_revisions);
  expect(unchanged.internal_timeline_revisions).toEqual(before.internal_timeline_revisions);
});

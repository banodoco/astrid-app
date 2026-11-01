/**
 * P2's first mounted tour slice.  The original three-products journey remains
 * the behavioural baseline; this file adds v2 proof for the smallest ready
 * parent gestures without copying that journey's broad fixture or helpers.
 */
import { expect, type Page, type Request, type Response } from '@playwright/test';
import { sha256Hex, THREE_PRODUCTS_REFERENCE_AT, type DirectHarness, type ThreeProductsSeed } from './support/harness.ts';
import { ASTRID_PYTHON } from './support/astrid.ts';
import { test as appTest } from './support/app.ts';
import type { CanonicalDocument, CommitAcceptedMutation, CommitRequest, EditCommand, HeadPin, HistoryEntry, HistoryPage } from '../../../src/integrations/runtime/timeline-commit-types.ts';

const COMMITS = /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/;
const LEGACY_WRITES = /\/timelines\/[^/]+\/(?:composition-revisions|saves)$/;
const CEILING = { timeout: 90_000 };

type JsonObject = Record<string, unknown>;

interface CommitPost {
  request: Request;
  response: Response;
  body: CommitRequest;
  json: unknown;
  key: string;
}

interface TourWire {
  posts: CommitPost[];
  legacy: string[];
}

const test = appTest.extend<object, { seed3: ThreeProductsSeed }>({
  seed3: [async ({ harness }, use) => {
    await use(await harness.seedThreeProducts(THREE_PRODUCTS_REFERENCE_AT, 'native-none'));
  }, { scope: 'worker', timeout: 240_000 }],
});

test.describe.configure({ mode: 'serial' });

function object(value: unknown, label: string): JsonObject {
  expect(value, label).toBeTruthy();
  expect(typeof value, label).toBe('object');
  expect(Array.isArray(value), label).toBe(false);
  return value as JsonObject;
}

function pinOf(result: CommitAcceptedMutation): HeadPin {
  return { revision_id: result.data.accepted_revision_id, publication_id: result.receipt.receipt_id };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  const json = JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : item);
  return sha256Hex(new TextEncoder().encode(json));
}

async function revisionBody(harness: DirectHarness, revisionId: string): Promise<JsonObject> {
  const response = await harness.runtimeJson<JsonObject>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${harness.seed.timelineId}/composition-revisions/${revisionId}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

async function canonicalDocumentAt(harness: DirectHarness, seed: ThreeProductsSeed, revisionId: string): Promise<CanonicalDocument> {
  const parent = await revisionBody(harness, revisionId);
  const manifest = object(parent.dependency_manifest, `dependency manifest for ${revisionId}`);
  const shots = await Promise.all((manifest.shots as Array<JsonObject>).map(async (pin) => {
    const response = await harness.runtimeJson<JsonObject>('GET', `/v1/projects/${harness.seed.projectId}/shots/${String(pin.shot_id)}/revisions/${String(pin.revision_id)}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { ...pin, payload: response.body.payload };
  }));
  const internals = await Promise.all((manifest.internal_timelines as Array<JsonObject>).map(async (pin) => {
    const response = await harness.runtimeJson<JsonObject>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/revisions/${String(pin.revision_id)}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { ...pin, payload: response.body.payload };
  }));
  return {
    schema_version: 1,
    project_id: harness.seed.projectId,
    timeline_id: seed.timelineId,
    parent_revision: { revision_id: String(parent.revision_id), content_digest: String(parent.content_digest), payload: parent.payload as CanonicalDocument['parent_revision']['payload'] },
    shot_revisions: shots as CanonicalDocument['shot_revisions'],
    internal_timeline_revisions: internals as CanonicalDocument['internal_timeline_revisions'],
    dependency_manifest: manifest as CanonicalDocument['dependency_manifest'],
  };
}

async function history(harness: DirectHarness, seed: ThreeProductsSeed): Promise<HistoryPage> {
  const items: HistoryEntry[] = [];
  let cursor: string | null = null;
  let pinnedHead: HeadPin | undefined;
  do {
    const query = `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const response = await harness.runtimeJson<HistoryPage>('GET', query);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    pinnedHead ??= response.body.head;
    expect(response.body.head, 'every cursor page keeps the first page head').toEqual(pinnedHead);
    items.push(...response.body.items);
    cursor = response.body.next_cursor;
  } while (cursor);
  expect(pinnedHead).toBeTruthy();
  return { items, head: pinnedHead!, next_cursor: null };
}

function wireFor(page: Page): TourWire {
  const wire: TourWire = { posts: [], legacy: [] };
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (!['GET', 'HEAD'].includes(request.method())
      && (LEGACY_WRITES.test(pathname) || pathname.includes('/composition-revisions'))) {
      wire.legacy.push(`${request.method()} ${pathname}`);
    }
  });
  return wire;
}

async function commitFromGesture(page: Page, wire: TourWire, action: () => Promise<void>): Promise<CommitPost> {
  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await action();
  const response = await responsePromise;
  const request = response.request();
  const body = request.postDataJSON() as CommitRequest;
  const post: CommitPost = {
    request,
    response,
    body,
    json: await response.json(),
    key: request.headers()['idempotency-key'] ?? '',
  };
  wire.posts.push(post);
  return post;
}

async function openCommandTimeline(page: Page, harness: DirectHarness, seed: ThreeProductsSeed): Promise<void> {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  await page.goto(`${harness.origin}/tools/video-editor`);
  await expect(page.locator('[data-testid="runtime-connection-status"]')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByRole('combobox', { name: 'Select project' })).toContainText(harness.seed.projectName);
  await expect(page.getByRole('textbox', { name: 'Track name' }).first()).toBeVisible();
  await expect(page.getByTestId('runtime-not-connected')).toBeHidden();
  expect(seed.timelineId).toBe(harness.seed.timelineId);
}

function clipById(document: CanonicalDocument, clipId: string): JsonObject {
  const parent = document.parent_revision.payload as unknown as JsonObject;
  const clips = parent.clips as Array<JsonObject>;
  const clip = clips.find((candidate) => candidate.id === clipId);
  expect(clip, `parent clip ${clipId}`).toBeTruthy();
  return clip!;
}

function assertCanonicalClosure(document: CanonicalDocument, harness: DirectHarness, seed: ThreeProductsSeed): void {
  expect(document.schema_version).toBe(1);
  expect(document.project_id).toBe(harness.seed.projectId);
  expect(document.timeline_id).toBe(seed.timelineId);
  expect(document.parent_revision.content_digest).toBe(digest(document.parent_revision.payload));
  for (const shot of document.shot_revisions) expect(shot.content_digest).toBe(digest(shot.payload));
  for (const internal of document.internal_timeline_revisions) expect(internal.content_digest).toBe(digest(internal.payload));
  for (const pin of document.dependency_manifest.shots) {
    const shot = document.shot_revisions.find((candidate) => candidate.revision_id === pin.revision_id);
    expect(shot, `manifest shot ${pin.revision_id}`).toBeTruthy();
    expect(pin.content_digest).toBe(shot!.content_digest);
  }
  for (const pin of document.dependency_manifest.internal_timelines) {
    const internal = document.internal_timeline_revisions.find((candidate) => candidate.revision_id === pin.revision_id);
    expect(internal, `manifest internal ${pin.revision_id}`).toBeTruthy();
    expect(pin.content_digest).toBe(internal!.content_digest);
  }
}

function assertOnlyParentClipFieldsChanged(before: CanonicalDocument, after: CanonicalDocument, clipIds: string[], fields: string[]): void {
  const beforeParent = before.parent_revision.payload as unknown as JsonObject;
  const afterParent = after.parent_revision.payload as unknown as JsonObject;
  const allowed = new Set(clipIds.flatMap((clipId) => fields.map((field) => `${clipId}:${field}`)));
  const compare = (left: unknown, right: unknown, path: string): void => {
    if (Array.isArray(left) && Array.isArray(right)) {
      expect(right.length, `${path} length is stable`).toBe(left.length);
      left.forEach((value, index) => compare(value, right[index], `${path}[${index}]`));
      return;
    }
    if (left && typeof left === 'object' && right && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const key of keys) compare((left as JsonObject)[key], (right as JsonObject)[key], `${path}.${key}`);
      return;
    }
    if (canonical(left) === canonical(right)) return;
    const match = /(?:\.config)?\.clips\[(\d+)\]\.(.+)$/.exec(path);
    if (!match) throw new Error(`unexpected canonical delta at ${path}`);
    const clip = (beforeParent.clips as Array<JsonObject>)[Number(match[1])];
    expect(allowed.has(`${String(clip.id)}:${match[2]}`), `only intended field changed at ${path}`).toBe(true);
  };
  compare(before.parent_revision.payload, after.parent_revision.payload, 'parent');
  const beforeConfig = beforeParent.config as JsonObject;
  const afterConfig = afterParent.config as JsonObject;
  if (Array.isArray(beforeConfig.clips)) expect(afterConfig.clips).toEqual(afterParent.clips);
  expect(before.shot_revisions).toEqual(after.shot_revisions);
  expect(before.internal_timeline_revisions).toEqual(after.internal_timeline_revisions);
  expect(before.dependency_manifest).toEqual(after.dependency_manifest);
}

function assertRawTransitionCleared(before: CanonicalDocument, after: CanonicalDocument, ids: string[]): void {
  const beforeParent = before.parent_revision.payload as unknown as JsonObject;
  const afterParent = after.parent_revision.payload as unknown as JsonObject;
  for (const [key, value] of Object.entries(beforeParent)) {
    if (key === 'config') {
      expect(afterParent.config).toEqual({ ...value as JsonObject, clips: (afterParent.config as JsonObject).clips });
    } else if (key !== 'clips') expect(afterParent[key]).toEqual(value);
  }
  for (const id of ids) {
    const beforeClip = clipById(before, id);
    const afterClip = clipById(after, id);
    expect(Object.hasOwn(afterClip, 'transition'), `${id}: None is raw absence`).toBe(false);
    expect(Object.hasOwn(beforeClip, 'transition')).toBe(true);
  }
  for (const [label, beforeClips, afterClips] of [
    ['parent.clips', beforeParent.clips, afterParent.clips],
    ['parent.config.clips', (beforeParent.config as JsonObject).clips, (afterParent.config as JsonObject).clips],
  ] as const) {
    expect(afterClips, `${label} remains an array`).toEqual(expect.any(Array));
    const beforeRows = beforeClips as Array<JsonObject>;
    const afterRows = afterClips as Array<JsonObject>;
    expect(afterRows.map((clip) => clip.id), `${label} order is stable`).toEqual(beforeRows.map((clip) => clip.id));
    for (const id of ids) {
      const beforeClip = beforeRows.find((clip) => clip.id === id)!;
      const afterClip = afterRows.find((clip) => clip.id === id)!;
      expect(Object.hasOwn(afterClip, 'transition'), `${label}/${id}: None is raw absence`).toBe(false);
      expect(Object.hasOwn(beforeClip, 'transition')).toBe(true);
    }
  }
}

function assertNormalizedCommands(commands: EditCommand[], submitted: EditCommand[]): void {
  expect(commands).toHaveLength(submitted.length);
  for (const [ordinal, claim] of submitted.entries()) {
    const command = commands[ordinal];
    // Both doc.patch and ABI-1 inverse gain provider captures. Every submitted
    // field (including complete args and optional guards) must survive exactly.
    expect(['doc.patch', 'timeline.inverse']).toContain(claim.op);
    for (const [field, value] of Object.entries(claim)) {
      expect((command as unknown as JsonObject)[field], `command ${ordinal}.${field}`).toEqual(value);
    }
    expect(command.intent).toEqual(claim.intent ?? {});
    expect(command.resolved).toEqual(claim.resolved ?? []);
    expect(Object.keys(command).sort()).toEqual([...new Set([
      ...Object.keys(claim), 'intent', 'resolved', 'expect', 'authorship',
      'reads', 'selections', 'bindings', 'created',
    ])].sort());
  }
}

function assertReplyShape(post: CommitPost, before: HeadPin): CommitAcceptedMutation {
  expect(post.response.status(), JSON.stringify(post.json)).toBe(200);
  const envelope = object(post.json, 'commit reply');
  const data = object(envelope.data, 'commit reply data');
  expect(['accepted', 'merged']).toContain(data.status);
  expect(data.base_revision_id).toBe(before.revision_id);
  expect(data.base_publication_id).toBe(before.publication_id);
  expect(data.previous_revision_id).toBe(before.revision_id);
  expect(data.previous_publication_id).toBe(before.publication_id);
  expect(data.accepted_revision_id).toEqual(expect.any(String));
  expect(data.canonical_document).toBeTruthy();
  expect(data.document_digest).toEqual(expect.any(String));
  assertNormalizedCommands(data.commands as EditCommand[], post.body.commands);
  const expectedLabel = Object.hasOwn(post.body, 'label') ? post.body.label : 'Timeline edit';
  expect(data.label).toBe(expectedLabel);
  expect(data.id_map).toEqual(expect.any(Object));
  expect(data.provider_version).toEqual(expect.any(String));
  expect(data.compiler_version).toEqual(expect.any(String));
  expect(data.publisher).toEqual(expect.any(String));
  expect(data.merge_mode).toBe(post.body.merge ?? 'fields');
  expect(data.steps).toEqual(expect.any(Array));
  expect(data.steps).not.toHaveLength(0);
  for (const step of data.steps as Array<JsonObject>) {
    expect(step.id).toEqual(expect.any(String));
    expect(step.label).toEqual(expect.any(String));
    expect(step.intent).toEqual(expect.any(String));
    expect(step.tags).toEqual(expect.any(Array));
    expect(step.command_ordinals).toEqual(expect.any(Array));
    expect((step.command_ordinals as unknown[]).length).toBeGreaterThan(0);
    expect(step.patch).toEqual(expect.any(Array));
    expect((step.patch as unknown[]).length).toBeGreaterThan(0);
    expect(step.dependencies).toEqual(expect.any(Array));
    expect((step.dependencies as unknown[]).length).toBeGreaterThan(0);
  }
  if (Object.hasOwn(post.body, 'steps')) {
    expect(data.steps).toEqual(post.body.steps!.map((step, index) => ({
      ...step,
      patch: (data.steps as Array<JsonObject>)[index].patch,
      dependencies: (data.steps as Array<JsonObject>)[index].dependencies,
    })));
  } else {
    expect(data.steps).toEqual([{
      id: 'edit', label: expectedLabel, intent: '', tags: [], command_ordinals: [0],
      patch: (data.steps as Array<JsonObject>)[0].patch,
      dependencies: (data.steps as Array<JsonObject>)[0].dependencies,
    }]);
  }
  expect(data.source).toEqual(post.body.source);
  const receipt = object(envelope.receipt, 'accepted receipt');
  expect(receipt.receipt_id).toEqual(expect.stringMatching(/^txn-\S+$/));
  expect(receipt.receipt_id).not.toBe(post.key);
  expect(receipt.idempotency_key).toBe(post.key);
  expect(receipt.result).toEqual(envelope.data);
  if (data.status === 'accepted') expect(data.rebased_onto).toBeNull();
  else expect(data.rebased_onto).toMatchObject({ revision_id: expect.any(String), publication_id: expect.any(String) });
  return envelope as unknown as CommitAcceptedMutation;
}

function assertAuthoritativeHistoryPublication(entry: HistoryEntry, result: CommitAcceptedMutation): void {
  expect(entry.publication_id).toBe(result.receipt.receipt_id);
}

function assertAuthoritativeHead(head: HeadPin, result: CommitAcceptedMutation): void {
  expect(head).toEqual({
    revision_id: result.data.accepted_revision_id,
    publication_id: result.receipt.receipt_id,
  });
}

function assertInverseTargetsPublication(inverse: CommitPost, publicationId: string): void {
  expect(inverse.body.commands).toEqual([{
    schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
    args: { publications: [publicationId] },
  }]);
}

function assertUndoHistoryPublication(entry: HistoryEntry, publicationId: string): void {
  expect(entry.records?.undo_of).toEqual([publicationId]);
}

function assertRequestV2(
  post: CommitPost,
  before: HeadPin,
  inverseExpectation?: { projectId: string; timelineId: string; publicationId: string; action: 'Undo' | 'Redo' },
): void {
  expect(post.key).toBeTruthy();
  expect(post.body).toMatchObject({
    api_version: 1,
    project_id: expect.any(String),
    timeline_id: expect.any(String),
    base_revision_id: before.revision_id,
    base_publication_id: before.publication_id,
    commands: expect.any(Array),
  });
  expect(post.body.commands.length).toBeGreaterThan(0);
  if (inverseExpectation) {
    const command = {
      schema_version: 1,
      op: 'timeline.inverse',
      version: '1',
      select: null,
      args: { publications: [inverseExpectation.publicationId] },
    };
    expect(post.body).toEqual({
      api_version: 1, project_id: inverseExpectation.projectId, timeline_id: inverseExpectation.timelineId,
      base_revision_id: before.revision_id, base_publication_id: before.publication_id,
      commands: [command],
      label: `${inverseExpectation.action} timeline`,
      steps: [{
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        label: `${inverseExpectation.action} timeline`, intent: `${inverseExpectation.action} timeline`, tags: [], command_ordinals: [0], patch: [],
      }],
      merge: 'fields', reads: [], dry_run: false, source: { via: 'app' },
    });
    return;
  }
  expect(post.body.label).toEqual(expect.any(String));
  expect(post.body.steps).toEqual(expect.any(Array));
  expect(post.body.steps!.length).toBeGreaterThan(0);
  for (const step of post.body.steps!) {
    expect(step.id).toEqual(expect.any(String));
    expect(step.command_ordinals.length).toBeGreaterThan(0);
    expect(step.patch).toEqual(expect.any(Array));
    if (step.reads !== undefined) expect(step.reads).toEqual(expect.any(Array));
  }
  expect(post.body.merge).toBe('atomic');
  expect(Object.hasOwn(post.body, 'reads'), 'the mounted document-patch fallback omits request reads').toBe(false);
  expect(post.body.dry_run).toBe(false);
  for (const step of post.body.steps!) {
    expect(Object.hasOwn(step, 'reads'), 'the mounted document-patch fallback omits step reads').toBe(false);
  }
  expect(post.body.source).toEqual({ via: 'app' });
}

function assertDocumentPatchRequest(body: CommitRequest, changes: unknown[], created: string[] | undefined, intent: string): void {
  expect(body.commands).toEqual([{
    schema_version: 1,
    op: 'doc.patch',
    version: '1',
    select: null,
    ...(created === undefined ? {} : { created }),
    args: { changes },
  }]);
  expect(body.steps).toHaveLength(1);
  expect(body.steps![0]!.label).toBe('Edit timeline');
  expect(body.steps![0]!.intent).toBe(intent);
  expect(body.steps![0]!.tags).toEqual([]);
  expect(body.steps![0]!.command_ordinals).toEqual([0]);
  expect(body.steps![0]!.patch).toEqual(changes);
}

function assertParentMoveRequestV2(
  post: CommitPost,
  before: HeadPin,
  original: CanonicalDocument,
  clipId: string,
  targetAt: number,
): void {
  expect(post.key).toBeTruthy();
  const payload = original.parent_revision.payload as unknown as JsonObject;
  const config = payload.config as JsonObject;
  const clips = config.clips as Array<JsonObject>;
  const selected = clips.find((clip) => clip.id === clipId);
  expect(selected, `parent move source clip ${clipId}`).toBeTruthy();
  const trackId = String(selected!.track);
  const read = (value: JsonObject, key: string, path: string[]): JsonObject => ({
    kind: 'field', ref: 'parent', path: [...path, key],
    state: Object.hasOwn(value, key) ? { state: 'present', value: value[key] } : { state: 'absent' },
  });
  const readPath = (value: JsonObject, keys: string[], path: string[]): JsonObject => {
    const [key, ...rest] = keys;
    return rest.length && value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])
      ? readPath(value[key] as JsonObject, rest, [...path, key]) : read(value, key, path);
  };
  const clipPath = ['config', 'clips'];
  const timingReads = (item: JsonObject): JsonObject[] => ['id', 'track', 'at', 'clipType', 'hold', 'from', 'to', 'speed', 'asset']
    .map((key) => read(item, key, [...clipPath, `id:${String(item.id)}`]));
  const reads = timingReads(selected!);
  reads.push(readPath(config, ['output', 'fps'], ['config']));
  const registry = payload.registry as JsonObject;
  const assetRead = (item: JsonObject): void => {
    if (typeof item.asset === 'string') reads.push(readPath(registry, ['assets', item.asset], ['config', 'registry']));
  };
  assetRead(selected!);
  const tracks = config.tracks as Array<JsonObject>;
  const track = tracks.find((row) => row.id === trackId);
  expect(track, `parent move source track ${trackId}`).toBeTruthy();
  reads.push(read(track!, 'kind', ['config', 'tracks', `id:${trackId}`]));
  reads.push(read(config, 'pinnedShotGroups', ['config']));
  const order = clips.map((clip) => String(clip.id));
  reads.push({ kind: 'collection', ref: 'parent', path: clipPath, members: [...order].sort(), order });
  for (const sibling of clips) {
    if (sibling.id === clipId) continue;
    reads.push(read(sibling, 'track', [...clipPath, `id:${String(sibling.id)}`]));
    if (sibling.track === trackId) {
      reads.push(...timingReads(sibling));
      assetRead(sibling);
    }
  }
  const changes = [{
    op: 'set', ref: 'parent', path: ['clips', `id:${clipId}`, 'at'],
    before: { state: 'present', value: selected!.at }, value: targetAt,
  }];
  expect(post.body).toEqual({
    api_version: 1,
    project_id: original.project_id,
    timeline_id: original.timeline_id,
    base_revision_id: before.revision_id,
    base_publication_id: before.publication_id,
    commands: [{ schema_version: 1, op: 'doc.patch', version: '1', select: null, created: [], args: { changes } }],
    label: 'Edit timeline',
    steps: [{
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), label: 'Edit timeline', intent: `Move ${clipId} on ${trackId}`, tags: [],
      command_ordinals: [0], patch: changes, reads,
    }],
    merge: 'fields', reads, dry_run: false, source: { via: 'app' },
  });
}

function assertTransitionRequestV2(
  post: CommitPost,
  before: HeadPin,
  original: CanonicalDocument,
  ids: string[],
  changes: unknown[],
): void {
  expect(post.key).toBeTruthy();
  const payload = original.parent_revision.payload as unknown as JsonObject;
  const config = payload.config as JsonObject;
  const clips = config.clips as Array<JsonObject>;
  const reads = ids.flatMap((id) => {
    const clip = clips.find((candidate) => candidate.id === id);
    expect(clip, `transition source clip ${id}`).toBeTruthy();
    return ['id', 'transition'].map((key) => ({
      kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${id}`, key],
      state: Object.hasOwn(clip!, key) ? { state: 'present', value: clip![key] } : { state: 'absent' },
    }));
  });
  reads.push({
    kind: 'field', ref: 'parent', path: ['config', 'pinnedShotGroups'],
    state: Object.hasOwn(config, 'pinnedShotGroups')
      ? { state: 'present', value: config.pinnedShotGroups } : { state: 'absent' },
  });

  expect(post.body).toEqual({
    api_version: 1,
    project_id: original.project_id,
    timeline_id: original.timeline_id,
    base_revision_id: before.revision_id,
    base_publication_id: before.publication_id,
    commands: [{
      schema_version: 1,
      op: 'doc.patch',
      version: '1',
      select: null,
      created: [],
      args: { changes },
    }],
    label: 'Edit timeline',
    steps: [{
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      label: 'Edit timeline',
      intent: `Clear transitions: ${ids.join(', ')}`,
      tags: [],
      command_ordinals: [0],
      patch: changes,
      reads,
    }],
    merge: 'fields',
    reads,
    dry_run: false,
    source: { via: 'app' },
  });
}

function assertHistoryMetadata(entry: HistoryEntry, post: CommitPost, result: CommitAcceptedMutation): void {
  expect(entry.intent).toBe('recorded');
  expect(entry.records).not.toBeNull();
  assertAuthoritativeHistoryPublication(entry, result);
  expect(entry.revision_id).toBe(result.data.accepted_revision_id);
  expect(entry.receipt).toEqual(result.receipt);
  expect(entry.publisher).toBe(result.data.publisher);
  expect(entry.provider_version).toBe(result.data.provider_version);
  expect(entry.compiler_version).toBe(result.data.compiler_version);
  expect(entry.label).toBe(Object.hasOwn(post.body, 'label') ? post.body.label : 'Timeline edit');
  expect(entry.merge).toBe(post.body.merge ?? 'fields');
  expect(entry.merge_mode).toBe(result.data.merge_mode);
  expect(entry.source).toEqual(post.body.source);
  expect(entry.previous).toEqual({ revision_id: result.data.previous_revision_id, publication_id: result.data.previous_publication_id });
  expect(entry.steps).toEqual(result.data.steps);
  expect(entry.records!.steps).toEqual(result.data.steps);
  expect(entry.records!.label).toBe(result.data.label);
  expect(entry.records!.merge_mode).toBe(result.data.merge_mode);
  expect(result.data.commands).toEqual(entry.records!.commands.map((record) => record.command));
  assertNormalizedCommands(result.data.commands, post.body.commands);
  expect(entry.records!.commands.map((record) => record.ordinal)).toEqual(post.body.commands.map((_, ordinal) => ordinal));
  if (Object.hasOwn(post.body, 'steps')) {
    expect(result.data.steps).toEqual(post.body.steps.map((step, index) => ({
      ...step, patch: result.data.steps![index].patch, dependencies: result.data.steps![index].dependencies,
    })));
  }
  for (const step of entry.records!.steps ?? []) {
    expect(step.patch).toEqual(expect.any(Array));
    expect(step.command_ordinals.length).toBeGreaterThan(0);
    expect(step.dependencies).toEqual(expect.any(Array));
    expect(step.dependencies!.length).toBeGreaterThan(0);
  }
  for (const record of entry.records!.commands) {
    expect(record.writes.length).toBeGreaterThan(0);
    expect(record.reads.length).toBeGreaterThan(0);
    expect(record.bindings.length).toBeGreaterThan(0);
    // These operations capture field/scope guards in step.dependencies; they
    // do not use the native move recipe's external dependency pins.
    expect(record.dependencies).toEqual([]);
  }
  // C0 §§1, 4, 5 and 7: request reads are optional request metadata, accepted
  // replies/history preserve the submitted envelope, and inverse remains an
  // ordinary request.  They are not interchangeable with captured recorder
  // reads: preserve exact declared reads when submitted, and raw absence when
  // the request omits them.
  if (Object.hasOwn(post.body, 'reads')) {
    expect(entry.reads, 'history preserves exact declared request reads').toEqual(post.body.reads);
  } else {
    expect(Object.hasOwn(entry, 'reads'), 'history preserves omitted request reads').toBe(false);
  }
}

function assertHistoryProof(
  entry: HistoryEntry,
  post: CommitPost,
  result: CommitAcceptedMutation,
  original: CanonicalDocument,
  after: CanonicalDocument,
  clipIds: string[],
  fields: string[],
): void {
  assertHistoryMetadata(entry, post, result);
  const patches = (entry.records!.steps ?? []).flatMap((step) => step.patch);
  const requestedChanges = post.body.commands[0]!.args.changes as unknown[];
  const bindings = entry.records!.commands.flatMap((record) => record.bindings
    .filter((binding) => binding.key.startsWith('doc.patch:')));
  expect(bindings.map((binding) => binding.change)).toEqual(requestedChanges);
  expect(patches).toEqual(requestedChanges.map((change) => {
    const value = object(change, 'submitted document patch');
    const path = value.path as string[];
    return { ...value, path: ['config', ...path] };
  }));
  expect(bindings.map((binding) => ({ ...binding.change, ref: binding.physical_ref, path: binding.path }))).toEqual(patches);
  for (const clipId of clipIds) {
    for (const field of fields) {
      const patch = patches.find((change) => change.ref === 'parent'
        && canonical(change.path) === canonical(['config', 'clips', `id:${clipId}`, field]));
      expect(patch, `authoritative step patch for ${clipId}.${field}`).toBeTruthy();
      const beforeValue = clipById(original, clipId)[field];
      expect(patch!.before).toEqual(Object.hasOwn(clipById(original, clipId), field)
        ? { state: 'present', value: beforeValue }
        : { state: 'absent' });
      if (patch!.op === 'set') expect(patch!.value).toEqual(clipById(after, clipId)[field]);
      if (patch!.op === 'remove') expect(Object.hasOwn(clipById(after, clipId), field)).toBe(false);
    }
  }
}

function assertAuthoritativeCanonical(
  result: CommitAcceptedMutation,
  actual: CanonicalDocument,
  harness: DirectHarness,
  seed: ThreeProductsSeed,
): void {
  const document = result.data.canonical_document;
  assertCanonicalClosure(document, harness, seed);
  expect(document.parent_revision.revision_id).toBe(result.data.accepted_revision_id);
  expect(result.data.document_digest).toBe(digest(document));
  expect(actual).toEqual(document);
}

function assertNoNewLegacyEntries(before: HistoryPage, after: HistoryPage): void {
  const known = new Set(before.items.map((entry) => entry.publication_id));
  for (const entry of after.items.filter((candidate) => !known.has(candidate.publication_id))) {
    expect(entry.intent, `new history entry ${entry.publication_id} is recorded`).toBe('recorded');
    expect(entry.records, `new history entry ${entry.publication_id} has records`).not.toBeNull();
    expect(['timeline.commit', 'timeline.inverse']).toContain(entry.receipt.command_kind);
  }
}

function assertCanonicalRestored(original: CanonicalDocument, undone: CanonicalDocument): void {
  expect(undone.parent_revision.payload).toEqual(original.parent_revision.payload);
  expect(undone.shot_revisions).toEqual(original.shot_revisions);
  expect(undone.internal_timeline_revisions).toEqual(original.internal_timeline_revisions);
  expect(undone.dependency_manifest).toEqual(original.dependency_manifest);
}

async function assertReloaded(page: Page, harness: DirectHarness, revision: string): Promise<void> {
  await page.reload();
  await expect(page.locator('[data-testid="runtime-connection-status"]')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByRole('textbox', { name: 'Track name' }).first()).toBeVisible();
  await expect(page.getByTestId('preview-revision-label').filter({ hasText: `Committed ${revision}` }).first()).toBeVisible(CEILING);
  expect(harness.runtimePort).toBeGreaterThan(0);
}

async function transitionSelect(page: Page) {
  return page.getByText('Transition', { exact: true }).locator('xpath=following::*[@role="combobox"][1]');
}

async function clearTransition(page: Page, clipId: string): Promise<void> {
  await page.locator(`[data-clip-id="${clipId}"]`).first().click();
  await page.getByRole('tab', { name: 'Effects', exact: true }).click();
  await (await transitionSelect(page)).click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await expect(await transitionSelect(page)).toContainText('None');
}

async function clearTransitionBulk(page: Page, seed: ThreeProductsSeed): Promise<void> {
  await page.locator(`[data-clip-id="${seed.appClipId}"]`).first().click();
  await page.locator(`[data-clip-id="${seed.transitionClipId}"]`).first().click({ modifiers: ['Shift'] });
  await expect(page.getByText('2 clips selected', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Effects', exact: true }).click();
  await (await transitionSelect(page)).click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await expect(await transitionSelect(page)).toContainText('None');
}

async function proveGestureAndUndo(
  page: Page,
  harness: DirectHarness,
  seed: ThreeProductsSeed,
  wire: TourWire,
  before: HistoryPage,
  original: CanonicalDocument,
  gesture: () => Promise<void>,
  expectedClipIds: string[],
  expectedFields: string[],
  assertCommands: (body: CommitRequest) => void,
  assertAfter: (after: CanonicalDocument) => void,
  assertUndo: (undone: CanonicalDocument) => void,
  assertRequest: (post: CommitPost, before: HeadPin) => void = (post, head) => assertRequestV2(post, head),
): Promise<void> {
  assertCanonicalClosure(original, harness, seed);
  const post = await commitFromGesture(page, wire, gesture);
  assertRequest(post, before.head);
  assertCommands(post.body);
  const result = assertReplyShape(post, before.head);
  const after = result.data.canonical_document;
  const actualAfter = await canonicalDocumentAt(harness, seed, result.data.accepted_revision_id);
  assertAuthoritativeCanonical(result, actualAfter, harness, seed);
  assertOnlyParentClipFieldsChanged(original, after, expectedClipIds, expectedFields);
  assertAfter(after);
  const committed = await history(harness, seed);
  const entry = committed.items.find((candidate) => candidate.publication_id === result.receipt.receipt_id);
  expect(entry, 'history joins by receipt/publication id').toBeTruthy();
  assertHistoryProof(entry!, post, result, original, after, expectedClipIds, expectedFields);
  assertNoNewLegacyEntries(before, committed);
  expect(committed.items.filter((candidate) => !before.items.some((known) => known.publication_id === candidate.publication_id))).toHaveLength(1);
  assertAuthoritativeHead(committed.head, result);
  await assertReloaded(page, harness, result.data.accepted_revision_id);
  expect(await history(harness, seed), 'reload preserves the complete authoritative history').toEqual(committed);
  expect(wire.legacy, 'the mounted gesture has no old-route write').toEqual([]);

  const inverse = await commitFromGesture(page, wire, async () => {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
  });
  assertRequestV2(inverse, pinOf(result), {
    projectId: original.project_id,
    timelineId: original.timeline_id,
    publicationId: result.receipt.receipt_id,
    action: 'Undo',
  });
  assertInverseTargetsPublication(inverse, result.receipt.receipt_id);
  const inverseResult = assertReplyShape(inverse, pinOf(result));
  const undone = inverseResult.data.canonical_document;
  const actualUndone = await canonicalDocumentAt(harness, seed, inverseResult.data.accepted_revision_id);
  assertAuthoritativeCanonical(inverseResult, actualUndone, harness, seed);
  assertCanonicalRestored(original, undone);
  assertUndo(undone);
  const finalHistory = await history(harness, seed);
  const inverseEntry = finalHistory.items.find((candidate) => candidate.publication_id === inverseResult.receipt.receipt_id);
  expect(inverseEntry, 'Undo history joins by receipt/publication id').toBeTruthy();
  assertHistoryMetadata(inverseEntry!, inverse, inverseResult);
  assertUndoHistoryPublication(inverseEntry!, result.receipt.receipt_id);
  expect(finalHistory.items.filter((candidate) => candidate.publication_id !== inverseResult.receipt.receipt_id),
    'Undo preserves every prior authoritative history entry').toEqual(committed.items);
  assertNoNewLegacyEntries(before, finalHistory);
  expect(finalHistory.items.filter((candidate) => !before.items.some((known) => known.publication_id === candidate.publication_id))).toHaveLength(2);
  expect(finalHistory.head).toEqual(pinOf(inverseResult));
  expect(await history(harness, seed), 'repeated reads preserve complete inverse records and dependencies').toEqual(finalHistory);
  expect(wire.legacy, 'mounted Undo has no old-route write').toEqual([]);
}

test('P2 mounted single parent move: v2 commit, exact field delta, reload and guarded Undo', async ({ page, harness, seed3 }) => {
  await openCommandTimeline(page, harness, seed3);
  const wire = wireFor(page);
  const before = await history(harness, seed3);
  const original = await canonicalDocumentAt(harness, seed3, before.head.revision_id);
  const from = Number(clipById(original, seed3.appClipId).at);
  await proveGestureAndUndo(page, harness, seed3, wire, before, original,
    async () => {
      const clip = page.locator(`.clip-action[data-clip-id="${seed3.appClipId}"]`).first();
      const reference = page.locator(`.clip-action[data-clip-id="${seed3.transitionClipId}"]`).first();
      const clipBox = await clip.boundingBox();
      const referenceBox = await reference.boundingBox();
      if (!clipBox || !referenceBox) throw new Error('mounted parent clips are not measurable');
      const pixelsPerSecond = (referenceBox.x - clipBox.x) / (THREE_PRODUCTS_REFERENCE_AT - from);
      await page.mouse.move(clipBox.x + Math.min(clipBox.width / 2, 24), clipBox.y + clipBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(clipBox.x + Math.min(clipBox.width / 2, 24) + (5 - from) * pixelsPerSecond, clipBox.y + clipBox.height / 2, { steps: 12 });
      await page.mouse.up();
    },
    [seed3.appClipId], ['at'],
    (body) => assertDocumentPatchRequest(body, [{
      op: 'set',
      ref: 'parent',
      path: ['clips', `id:${seed3.appClipId}`, 'at'],
      before: { state: 'present', value: from },
      value: 5,
    }], [], `Move ${seed3.appClipId} on ${String(clipById(original, seed3.appClipId).track)}`),
    (after) => expect(clipById(after, seed3.appClipId).at).toBe(5),
    (undone) => expect(clipById(undone, seed3.appClipId).at).toBe(from),
    (post, head) => assertParentMoveRequestV2(post, head, original, seed3.appClipId, 5));
});

test('P2 mounted transition None single: raw clear preserves opaque data/order and guarded Undo', async ({ page, harness, seed3 }) => {
  await openCommandTimeline(page, harness, seed3);
  const wire = wireFor(page);
  const before = await history(harness, seed3);
  const original = await canonicalDocumentAt(harness, seed3, before.head.revision_id);
  const changes = [{
    op: 'remove',
    ref: 'parent',
    path: ['clips', `id:${seed3.transitionClipId}`, 'transition'],
    before: { state: 'present', value: clipById(original, seed3.transitionClipId).transition },
  }];
  await proveGestureAndUndo(page, harness, seed3, wire, before, original,
    () => clearTransition(page, seed3.transitionClipId),
    [seed3.transitionClipId], ['transition'],
    (body) => assertDocumentPatchRequest(body, changes, [], `Clear transitions: ${[seed3.transitionClipId].join(', ')}`),
    (after) => assertRawTransitionCleared(original, after, [seed3.transitionClipId]),
    (undone) => expect(clipById(undone, seed3.transitionClipId).transition).toEqual(clipById(original, seed3.transitionClipId).transition),
    (post, head) => assertTransitionRequestV2(post, head, original, [seed3.transitionClipId], changes));
});

test('P2 mounted transition None bulk: atomic raw clears preserve unknown fields/order and guarded Undo', async ({ page, harness, seed3 }) => {
  await openCommandTimeline(page, harness, seed3);
  const wire = wireFor(page);
  const before = await history(harness, seed3);
  const original = await canonicalDocumentAt(harness, seed3, before.head.revision_id);
  const ids = [seed3.appClipId, seed3.transitionClipId];
  const changes = ids.map((id) => ({
    op: 'remove',
    ref: 'parent',
    path: ['clips', `id:${id}`, 'transition'],
    before: { state: 'present', value: clipById(original, id).transition },
  }));
  await proveGestureAndUndo(page, harness, seed3, wire, before, original,
    () => clearTransitionBulk(page, seed3), ids, ['transition'],
    (body) => assertDocumentPatchRequest(body, changes, [], `Clear transitions: ${[seed3.appClipId, seed3.transitionClipId].join(', ')}`),
    (after) => assertRawTransitionCleared(original, after, ids),
    (undone) => {
      for (const id of ids) expect(clipById(undone, id).transition).toEqual(clipById(original, id).transition);
    },
    (post, head) => assertTransitionRequestV2(post, head, original, ids, changes));
});

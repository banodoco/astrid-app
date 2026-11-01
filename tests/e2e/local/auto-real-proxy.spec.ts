/**
 * One representative M2 automatic-placement gate. It starts the same Vite and discovery-proxy processes used by dev:local,
 * then drives the actual editor UI against the actual Runtime. The image executor is a temporary GenericPackHost pack in
 * DirectHarness.tmp, not an App command or a fake Runtime endpoint.
 */
import { expect, type Page, type Response as PlaywrightResponse } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { APP_ENTRY_ROUTE, commandOutboxes, openSeededTimeline, test as appTest, UI } from './support/app.ts';
import { ASTRID_CHECKOUT, ASTRID_PYTHON } from './support/astrid.ts';
import { RUNTIME_CHECKOUT, spawnGroup, stopGroup, type DirectHarness } from './support/harness.ts';
import { classifyRuntimePost, normalRuntimeCommitPath, requireAuthoritativeHead } from './support/auto-real-proxy-helpers.ts';
import { normalAcpEnvironment } from '../../../scripts/testing/auto-real-proxy-main95.mjs';
import type { ThreeProductsSeed } from './support/harness.ts';

const OPERATION_PREFIX = '/runtime-config/v1/operation';
const NORMAL_RUNTIME_PREFIX = '/api/runtime/v1';
const TASK_PATH = `${OPERATION_PREFIX}/runtime/v1/tasks`;
const COMMIT_PATH = new RegExp(`${OPERATION_PREFIX}/runtime/v1/projects/[^/]+/timelines/[^/]+/commit$`);
const PLACEMENT_LANE = 'V2';
const CEILING = { timeout: 60_000 };
const test = appTest.extend<{ workspace: Workspace }>({
  workspace: [async ({ harness }, use) => {
    const seed = await harness.seedThreeProducts();
    await harness.enableTimelineAuthoring(ASTRID_PYTHON);
    const composerCheckout = prepareComposerCheckout(harness);
    await runImageHost(harness, 'register', composerCheckout);
    const vite = await startViteWorkspace(harness, composerCheckout);
    try { await use({ harness, seed, vite }); } finally { await vite.stop(); }
  }, { scope: 'worker', timeout: 240_000 }],
});

type Workspace = { harness: DirectHarness; seed: ThreeProductsSeed; vite: ViteWorkspace };
type ViteWorkspace = { origin: string; restart(): Promise<void>; stop(): Promise<void> };
type Wire = { method: string; body: string; key: string; receipt?: Record<string, unknown> | null; receiptBody?: string };
type JsonRecord = Record<string, any>;
type PlacementSnapshot = { parent: JsonRecord; shot: JsonRecord; inner: JsonRecord };

function record(value: unknown, label: string): JsonRecord {
  expect(value, label).toBeTruthy();
  expect(typeof value, label).toBe('object');
  expect(Array.isArray(value), label).toBe(false);
  return value as JsonRecord;
}

function assertFullV2Request(wire: Wire, projectId: string, timelineId: string): JsonRecord {
  const body = JSON.parse(wire.body) as JsonRecord;
  expect(wire.method).toBe('POST');
  expect(wire.key).toEqual(expect.any(String));
  expect(wire.key).toBeTruthy();
  expect(body).toMatchObject({
    api_version: 1, project_id: projectId, timeline_id: timelineId,
    base_revision_id: expect.any(String), base_publication_id: expect.any(String),
    commands: expect.any(Array), label: expect.any(String), steps: expect.any(Array),
    merge: expect.stringMatching(/^(fields|atomic)$/), dry_run: false, source: { via: 'app' },
  });
  expect(body.label.length).toBeGreaterThan(0);
  expect(body.commands.length).toBeGreaterThan(0);
  expect(body.steps.length).toBeGreaterThan(0);
  for (const step of body.steps as JsonRecord[]) {
    expect(step).toMatchObject({ id: expect.any(String), label: expect.any(String), intent: expect.any(String),
      tags: expect.any(Array), command_ordinals: expect.any(Array), patch: expect.any(Array) });
    if (step.reads !== undefined) expect(step.reads).toEqual(expect.any(Array));
  }
  if (body.reads !== undefined) expect(body.reads).toEqual(expect.any(Array));
  if (body.rationale !== undefined) expect(body.rationale).toEqual(expect.any(String));
  if (body.group_id !== undefined) expect(body.group_id).toEqual(expect.any(String));
  for (const command of body.commands as JsonRecord[]) {
    expect(command).toMatchObject({ schema_version: 1, version: '1' });
    if (command.reads !== undefined) expect(command.reads).toEqual(expect.any(Array));
  }
  return body;
}

function assertFullV2Reply(wire: Wire, projectId: string, timelineId: string): JsonRecord {
  const envelope = record(wire.receipt, 'full v2 commit envelope');
  const data = record(envelope.data, 'full v2 commit data');
  const requestBody = JSON.parse(wire.body) as JsonRecord;
  if (data.status === 'preview') {
    expect(data.would_status).toMatch(/^(accepted|merged)$/);
    expect(envelope.receipt).toBeNull();
    return data;
  }
  if (data.status === 'conflict' || data.status === 'refused') {
    expect(data).toMatchObject({ reason: expect.any(String), head: expect.any(Object) });
    return data;
  }
  if (data.status === 'invalid') {
    expect(data).toMatchObject({ code: expect.any(String), path: expect.any(Array), hint: expect.any(String), command: expect.any(Object) });
    return data;
  }
  const receipt = record(envelope.receipt, 'full v2 receipt');
  expect(['accepted', 'merged', 'rebased']).toContain(data.status);
  expect(data).toMatchObject({
    base_revision_id: expect.any(String), base_publication_id: expect.any(String),
    previous_revision_id: expect.any(String), previous_publication_id: expect.any(String),
    accepted_revision_id: expect.any(String), canonical_document: expect.any(Object), document_digest: expect.any(String),
    commands: expect.any(Array), label: expect.any(String), steps: expect.any(Array),
    id_map: expect.any(Object),
    merge_mode: expect.stringMatching(/^(fields|atomic)$/), publisher: expect.any(String),
    provider_version: expect.any(String), compiler_version: expect.any(String),
  });
  expect(data.base_revision_id).toBe(requestBody.base_revision_id);
  expect(data.base_publication_id).toBe(requestBody.base_publication_id);
  expect(data.label).toBe(requestBody.label);
  expect(data.merge_mode).toBe(requestBody.merge);
  expect(data.source).toEqual(requestBody.source);
  for (const field of ['rationale', 'group_id'] as const) {
    if (requestBody[field] !== undefined) expect(data[field]).toEqual(requestBody[field]);
  }
  expect(data.canonical_document).toMatchObject({ schema_version: 1, project_id: projectId, timeline_id: timelineId,
    parent_revision: expect.any(Object), shot_revisions: expect.any(Array), internal_timeline_revisions: expect.any(Array),
    dependency_manifest: expect.any(Object) });
  expect(data.accepted_revision_id).toBe(data.canonical_document.parent_revision.revision_id);
  expect(wire.receiptBody).toEqual(expect.any(String));
  expect(JSON.parse(wire.receiptBody!)).toEqual(envelope);
  // Preserve Runtime's number spelling (1.0 vs 1) from the raw reply and use its official digest.
  const documentDigest = execFileSync(ASTRID_PYTHON, ['-c',
    'import json, sys; sys.path.insert(0, sys.argv[1]); from runtime_protocol.timeline_commit_validation import digest; print(digest(json.load(sys.stdin)["data"]["canonical_document"]))',
    RUNTIME_CHECKOUT], { input: wire.receiptBody, encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 30_000 }).trim();
  expect(data.document_digest).toBe(documentDigest);
  assertReplyLanding(data);
  expect(receipt).toMatchObject({ receipt_id: expect.any(String), command_kind: 'timeline.commit',
    project_id: projectId, idempotency_key: wire.key });
  expect(receipt.receipt_id).toBeTruthy();
  expect(receipt.result).toEqual(data);
  expect(data.steps.length).toBeGreaterThan(0);
  expect(data.commands).toHaveLength(requestBody.commands.length);
  for (const [ordinal, command] of (data.commands as JsonRecord[]).entries()) {
    for (const [field, value] of Object.entries((requestBody.commands as JsonRecord[])[ordinal])) {
      expect(command[field], `authoritative command ${ordinal}.${field}`).toEqual(value);
    }
    expect(command).toMatchObject({ intent: expect.any(Object), resolved: expect.any(Array), reads: expect.any(Array),
      selections: expect.any(Array), bindings: expect.any(Array), created: expect.any(Array) });
  }
  expect(data.steps).toHaveLength(requestBody.steps.length);
  for (const [ordinal, step] of (data.steps as JsonRecord[]).entries()) {
    const submitted = (requestBody.steps as JsonRecord[])[ordinal];
    expect(step).toMatchObject({ id: submitted.id, label: submitted.label, intent: submitted.intent, tags: submitted.tags,
      command_ordinals: submitted.command_ordinals });
    expect(step).toMatchObject({ id: expect.any(String), label: expect.any(String), intent: expect.any(String),
      tags: expect.any(Array), command_ordinals: expect.any(Array), patch: expect.any(Array), dependencies: expect.any(Array) });
  }
  return data;
}

function assertReplyLanding(data: JsonRecord): void {
  const previous = { revision_id: data.previous_revision_id, publication_id: data.previous_publication_id };
  const base = { revision_id: data.base_revision_id, publication_id: data.base_publication_id };
  if (data.status === 'accepted') {
    expect(data.rebased_onto).toBeNull();
    expect(previous).toEqual(base);
  } else {
    expect(['merged', 'rebased']).toContain(data.status);
    expect(data.rebased_onto).toEqual(previous);
    expect(previous).not.toEqual(base);
  }
}

function isExpectedV2InverseRequest(request: { method(): string; url(): string; postDataJSON(): unknown; headers(): Record<string, string> }, projectId: string,
  timelineId: string, publicationId: string): boolean {
  if (request.method() !== 'POST') return false;
  let url: URL;
  let body: JsonRecord;
  try {
    url = new URL(request.url());
    body = request.postDataJSON() as JsonRecord;
  } catch { return false; }
  if (!body || Array.isArray(body) || typeof body !== 'object' || url.search || url.hash
    || url.pathname !== normalRuntimeCommitPath(projectId, timelineId)
    || !request.headers()['idempotency-key']
    || typeof body.base_revision_id !== 'string' || !body.base_revision_id
    || typeof body.base_publication_id !== 'string' || !body.base_publication_id
    || !Array.isArray(body.steps) || body.steps.length !== 1
    || typeof body.steps[0]?.id !== 'string' || !body.steps[0].id) return false;
  const command = {
    schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
    args: { publications: [publicationId] },
  };
  // commitSession's Undo builder supplies this metadata; only the persisted intent ID varies.
  const expected = {
    api_version: 1, project_id: projectId, timeline_id: timelineId,
    base_revision_id: body.base_revision_id, base_publication_id: body.base_publication_id,
    commands: [command], label: 'Undo timeline',
    steps: [{ id: body.steps[0].id, label: 'Undo timeline', intent: 'Undo timeline',
      tags: [], command_ordinals: [0], patch: [] }],
    merge: 'fields', dry_run: false, source: { via: 'app' },
  } as JsonRecord;
  if (Object.hasOwn(body, 'reads')) expected.reads = [];
  for (const field of ['rationale', 'group_id'] as const) {
    if (Object.hasOwn(body, field)) {
      if (typeof body[field] !== 'string' || (field === 'group_id' && !body[field])) return false;
      expected[field] = body[field];
    }
  }
  return isDeepStrictEqual(body, expected);
}

async function currentPlacementSnapshot(harness: DirectHarness, seed: ThreeProductsSeed): Promise<PlacementSnapshot> {
  const history = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50`);
  const head = requireAuthoritativeHead(history.body);
  const parent = (await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/composition-revisions/${head.revision_id}`)).body;
  const payload = record(parent.payload, 'current parent payload');
  const occurrence = (payload.occurrences as JsonRecord[]).find((item) => item.occurrence_id === seed.occurrenceId);
  expect(occurrence, 'seed occurrence').toBeTruthy();
  const shot = (await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/shots/${seed.shotId}/revisions/${occurrence!.shot_revision_id}`)).body;
  const inner = (await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/revisions/${shot.internal_timeline_revision_id}`)).body;
  return { parent: payload, shot: record(shot.payload, 'current shot payload'), inner: record(inner.payload, 'current child payload') };
}

function replyPlacementSnapshot(data: JsonRecord, seed: ThreeProductsSeed): PlacementSnapshot {
  const document = record(data.canonical_document, 'accepted canonical document');
  const parent = record(record(document.parent_revision, 'accepted parent revision').payload, 'accepted parent payload');
  const shotRevision = (document.shot_revisions as JsonRecord[]).find((item) => item.shot_id === seed.shotId);
  expect(shotRevision, 'accepted shot revision').toBeTruthy();
  const innerRevision = (document.internal_timeline_revisions as JsonRecord[]).find((item) => item.revision_id === shotRevision!.internal_timeline_revision_id);
  expect(innerRevision, 'accepted internal revision').toBeTruthy();
  return { parent, shot: record(shotRevision!.payload, 'accepted shot payload'), inner: record(innerRevision!.payload, 'accepted child payload') };
}

function assertPlacementCanonicalDelta(before: PlacementSnapshot, after: PlacementSnapshot, seed: ThreeProductsSeed, clipId: string, objectId: string, media: JsonRecord): void {
  const beforeOccurrence = (before.parent.occurrences as JsonRecord[]).find((item) => item.occurrence_id === seed.occurrenceId)!;
  const afterOccurrence = (after.parent.occurrences as JsonRecord[]).find((item) => item.occurrence_id === seed.occurrenceId)!;
  expect(Object.keys(after.parent).sort()).toEqual(Object.keys(before.parent).sort());
  for (const [key, value] of Object.entries(before.parent)) {
    if (key !== 'occurrences') expect(after.parent[key]).toEqual(value);
  }
  expect(after.parent.occurrences).toEqual((before.parent.occurrences as JsonRecord[]).map((item) => item.occurrence_id === seed.occurrenceId
    ? { ...item, shot_revision_id: afterOccurrence.shot_revision_id } : item));
  expect(after.shot).toEqual(before.shot);
  expect(Object.keys(after.inner).sort()).toEqual(Object.keys(before.inner).sort());
  for (const [key, value] of Object.entries(before.inner)) {
    if (key !== 'clips' && key !== 'registry') expect(after.inner[key]).toEqual(value);
  }
  const beforeClips = before.inner.clips as JsonRecord[];
  const afterClips = after.inner.clips as JsonRecord[];
  expect(afterClips).toHaveLength(beforeClips.length + 1);
  expect(afterClips.slice(0, beforeClips.length)).toEqual(beforeClips);
  expect(afterClips.at(-1)).toEqual({ id: clipId, clipType: 'image', asset: media.asset, track: 'V2', at: 6, hold: 5 });
  const beforeAssets = record(before.inner.registry, 'before registry').assets as JsonRecord;
  const afterAssets = record(after.inner.registry, 'after registry').assets as JsonRecord;
  expect(Object.keys(afterAssets)).toEqual([...Object.keys(beforeAssets), String(media.asset)]);
  for (const [key, value] of Object.entries(beforeAssets)) expect(afterAssets[key]).toEqual(value);
  expect(afterAssets[media.asset]).toEqual({ media_id: objectId, type: 'image', generationId: media.generation_id, variantId: media.variant_id });
  expect(after.inner.registry).toEqual({ ...before.inner.registry, assets: afterAssets });
  expect(afterOccurrence.occurrence_id).toBe(beforeOccurrence.occurrence_id);
}

function assertUndoRecords(records: JsonRecord, commands: JsonRecord[], undoOf: string[]): void {
  const inverse = commands.find((command) => command.op === 'timeline.inverse');
  expect(records.undo_of).toEqual(undoOf);
  expect(inverse?.args.publications ?? []).toEqual(undoOf);
  const steps = inverse?.args.steps;
  if (steps !== undefined) {
    const selected = record(steps, 'requested inverse step map');
    expect(Object.keys(selected).sort()).toEqual([...undoOf].sort());
    for (const ids of Object.values(selected)) {
      expect(ids).toEqual(expect.any(Array));
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((id: unknown) => typeof id === 'string' && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    }
  }
  expect(Object.hasOwn(records, 'undo_steps')).toBe(true);
  expect(records.undo_steps).toEqual(steps === undefined ? null : steps);
}

function assertHistoryPlacement(entry: JsonRecord, data: JsonRecord, publicationId: string, wire: Wire, undoOf: string[] = []): void {
  const envelope = record(wire.receipt, 'history acceptance envelope');
  const requestBody = JSON.parse(wire.body) as JsonRecord;
  expect(entry).toMatchObject({ publication_id: publicationId, revision_id: data.accepted_revision_id, intent: 'recorded',
    records: expect.any(Object), steps: data.steps, label: data.label, publisher: data.publisher,
    provider_version: data.provider_version, compiler_version: data.compiler_version,
    merge_mode: data.merge_mode, source: data.source });
  expect(entry.previous).toEqual({ revision_id: data.previous_revision_id, publication_id: data.previous_publication_id });
  expect(entry.receipt).toEqual(envelope.receipt);
  expect(entry.receipt.receipt_id).toBe(publicationId);
  expect(entry.receipt.result).toEqual(data);
  expect(entry.steps).toEqual(data.steps);
  expect(entry.source).toEqual(data.source);
  expect(entry.merge).toBe(requestBody.merge);
  const records = record(entry.records, 'history records');
  expect(records).toMatchObject({ schema_version: 1, commands: expect.any(Array), steps: data.steps, undo_of: undoOf,
    label: data.label, merge_mode: data.merge_mode });
  expect(records.steps).toEqual(data.steps);
  expect(records.commands.map((command: JsonRecord) => command.command)).toEqual(data.commands);
  assertUndoRecords(records, requestBody.commands, undoOf);
  for (const [ordinal, command] of (records.commands as JsonRecord[]).entries()) {
    expect(command).toMatchObject({ ordinal, command: expect.any(Object), writes: expect.any(Array), reads: expect.any(Array),
      bindings: expect.any(Array), dependencies: expect.any(Array), derived_writes: expect.any(Array) });
  }
}

function assertNoOldRoutePublications(history: JsonRecord, baseline: JsonRecord[], publications: string[]): void {
  expect(history.next_cursor, 'bounded journey must inspect every Runtime /commits item').toBeNull();
  const items = history.items as JsonRecord[];
  expect(items.map((entry) => entry.publication_id)).toEqual([...baseline.map((entry) => entry.publication_id), ...publications]);
  expect(items.slice(0, baseline.length), 'seed publications remain unchanged').toEqual(baseline);
  // Runtime history authenticates the writer through receipt.command_kind, not a caller-supplied route/source annotation.
  const oldRoutePublications = items.filter((entry) => !baseline.some((seed) => seed.publication_id === entry.publication_id)
    && (entry.intent !== 'recorded' || entry.receipt?.command_kind !== 'timeline.commit'));
  expect(oldRoutePublications, 'Runtime /commits has zero new old-route publications').toEqual([]);
  for (const entry of items) expect(entry.receipt.receipt_id).toBe(entry.publication_id);
}
function sanitizedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/ig, 'Bearer <redacted>').slice(0, 800);
}

type HttpFailure = { method: string; path: string; status: number; code?: string; type?: string; location?: string };
const SAFE_HTTP_FACT = /^[A-Za-z0-9._:/-]{1,160}$/;

function validatedHttpFact(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_HTTP_FACT.test(value) ? value : undefined;
}

function responsePath(rawUrl: string): string {
  try { return new URL(rawUrl).pathname.slice(0, 320); }
  catch { return rawUrl.split(/[?#]/, 1)[0].slice(0, 320); }
}

async function readHttpFailure(response: PlaywrightResponse): Promise<HttpFailure> {
  const fact: HttpFailure = { method: response.request().method(), path: responsePath(response.url()), status: response.status() };
  try {
    const body = await response.json() as Record<string, unknown>;
    for (const key of ['code', 'type', 'location'] as const) {
      const value = validatedHttpFact(body[key]);
      if (value) fact[key] = value;
    }
  } catch {
    // The status and path are still useful when a proxy returns a non-JSON failure.
  }
  return fact;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function publishProxyProfile(harness: DirectHarness): string {
  const discovery = harness.discovery();
  const catalog = JSON.parse(readFileSync(path.join(harness.supportDir, 'catalog.json'), 'utf8'));
  const rows = Array.isArray(catalog.realms)
    ? catalog.realms.filter((row) => row?.realm_id === discovery.active_realm) : [];
  if (discovery.active_realm !== harness.realmId || catalog.selected_realm_id !== harness.realmId
    || rows.length !== 1 || (rows[0].source_profile !== undefined && rows[0].source_profile !== 'astrid')
    || realpathSync(String(discovery.realm_root)) !== realpathSync(harness.realmDir)
    || realpathSync(String(rows[0].data_root)) !== realpathSync(harness.realmDir)) {
    throw new Error('test Runtime discovery does not match the seeded Astrid realm');
  }
  // Supply the product profile normally published by astrid-runtime up, keeping daemon discovery separate.
  const directory = path.join(harness.tmp, 'proxy-profile');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify({ ...catalog,
    realms: catalog.realms.map((row) => row.realm_id === harness.realmId ? { ...row, source_profile: 'astrid' } : row),
  }), { mode: 0o600 });
  const discoveryPath = path.join(directory, 'discovery.json');
  writeFileSync(discoveryPath, JSON.stringify({ ...discovery, credential_file: harness.credentialPath }), { mode: 0o600 });
  return discoveryPath;
}

async function waitFor(url: string, ready: (response: Response) => boolean = (response) => response.ok): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastFailure = '';
  for (;;) {
    try {
      const response = await fetch(url);
      if (ready(response)) return;
      lastFailure = `${response.status} ${await response.text()}`;
    } catch (error) { lastFailure = error instanceof Error ? error.message : String(error); }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${url}${lastFailure ? ` (last response: ${lastFailure})` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function reloadEditor(page: Page, url: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !/ERR_ABORTED|frame was detached/.test(error.message)) throw error;
      await waitFor(url);
    }
  }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    throw new Error(`${lastError instanceof Error ? lastError.message : String(lastError)}; fallback navigation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function processEnv(harness: DirectHarness): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ASTRID_WORKSPACE_DISCOVERY: path.join(harness.supportDir, 'discovery.json'),
    WORKSPACE_RUNTIME_TOKEN_FILE: harness.credentialPath,
    PYTHONPATH: [ASTRID_CHECKOUT, RUNTIME_CHECKOUT].join(path.delimiter),
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
  };
}

function prepareComposerCheckout(harness: DirectHarness): string {
  const checkout = path.join(harness.tmp, 'agent-compose-checkout');
  execFileSync('cp', ['-al', ASTRID_CHECKOUT, checkout], { stdio: 'ignore' });
  unlinkSync(path.join(checkout, 'astrid', 'packs', 'generation', 'pack.yaml'));
  unlinkSync(path.join(checkout, 'config', 'astrid-beta-capabilities.json'));
  return checkout;
}

async function startViteWorkspace(harness: DirectHarness, composerCheckout: string): Promise<ViteWorkspace> {
  const proxyPort = await freePort();
  const vitePort = await freePort();
  const origin = `http://127.0.0.1:${vitePort}`;
  const compositionOverlay = path.join(harness.tmp, 'timeline-composition-overlay');
  mkdirSync(compositionOverlay, { recursive: true });
  // This test-only gate follows the current App D10 source attribution and its
  // already-pinned public13 Composition artifact; it does not change any
  // external Runtime or producer pin.
  execFileSync('tar', ['-xzf', path.resolve('vendor/artifacts/banodoco-timeline-composition-0.0.13.tgz'), '-C', compositionOverlay]);
  const compositionRoot = path.join(compositionOverlay, 'package');
  const proxyDiscovery = publishProxyProfile(harness);
  const baseEnv = processEnv(harness);
  const proxy = spawnGroup(process.execPath, [path.resolve('scripts/runtime-discovery-proxy.mjs')], {
    cwd: process.cwd(), env: { ...baseEnv, ASTRID_WORKSPACE_DISCOVERY: proxyDiscovery, ASTRID_RUNTIME_PROXY_PORT: String(proxyPort), ASTRID_RUNTIME_OPERATION_ORIGIN: origin },
  });
  const start = () => spawnGroup(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--config', 'config/vite/vite.config.ts', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: process.cwd(), env: {
      ...baseEnv,
      PORT: String(vitePort),
      ASTRID_CHECKOUT: composerCheckout,
      ASTRID_PYTHON,
      PYTHONPATH: [composerCheckout, RUNTIME_CHECKOUT].join(path.delimiter),
      VITE_ASTRID_BRIDGE_PORT: String(proxyPort),
      ...normalAcpEnvironment(proxyPort),
      ASTRID_BRIDGE_TOKEN: harness.productToken,
      ASTRID_RUNTIME_OPERATION_ORIGIN: origin,
      ASTRID_RUNTIME_PROXY_PORT: String(proxyPort),
      VITE_WORKSPACE_RUNTIME_URL: `http://127.0.0.1:${proxyPort}`,
      WORKSPACE_RUNTIME_TOKEN_FILE: harness.credentialPath,
      VITE_CACHE_DIR: path.join(harness.tmp, 'vite-cache'),
      VITE_TIMELINE_COMPOSITION_ROOT: compositionRoot,
      VITE_DISABLE_REMOTE_FONTS: '1',
      VITE_ASTRID_EDITOR_ONLY: '1',
    },
  });
  let vite = start();
  try {
    await waitFor(`http://127.0.0.1:${proxyPort}/runtime-config/v1/workspace.json`);
    await waitFor(origin);
  } catch (error) {
    const details = [
      `proxy stdout:\n${proxy.stdout.slice(-2000)}`,
      `proxy stderr:\n${proxy.stderr.slice(-4000)}`,
      `vite stdout:\n${vite.stdout.slice(-2000)}`,
      `vite stderr:\n${vite.stderr.slice(-4000)}`,
    ].join('\n');
    await stopGroup(vite); await stopGroup(proxy);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${details}`);
  }
  return {
    origin,
    async restart() { await stopGroup(vite); publishProxyProfile(harness); vite = start(); await waitFor(origin); },
    async stop() { await stopGroup(vite); await stopGroup(proxy); },
  };
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const IMAGE_HOST_PROGRAM = String.raw`
import base64, hashlib, json, os, sys
from pathlib import Path
from astrid.core.execution.generic_host import GenericPackHost, RuntimeProtocolClient
from astrid.core.pack.loader import _load_manifest_payload
from astrid.sdk.workspace_client import resolve_runtime_connection
import yaml
pack_root = Path(sys.argv[1]).resolve()
pack = pack_root / 'generation'
pack.mkdir(parents=True, exist_ok=True)
program = "import base64,hashlib,json; from pathlib import Path; out=Path('{out}'); data=base64.b64decode('${PNG}'); image=out/'generated.png'; image.write_bytes(data); (out/'manifest.json').write_text(json.dumps({'outputs':[{'name':'generated_images','path':'generated.png','artifact_type':'image/png','ordinal':0,'role':'result','is_primary':True,'bytes':len(data),'content_hash':'sha256:'+hashlib.sha256(data).hexdigest()}]}))"
source_manifest = Path(os.environ['ASTRID_SOURCE_CHECKOUT']) / 'astrid' / 'packs' / 'generation' / 'pack.yaml'
source_pack = _load_manifest_payload(source_manifest)
action = json.loads(json.dumps(source_pack['actions']['generate_image']))
action.pop('resources', None)
action['metadata'].update({'adapter_family': 'cpu', 'resource_keys': ['cpu']})
for key in ('api_provider', 'env', 'secrets_required', 'network_policy'):
    action['metadata'].pop(key, None)
action['isolation']['network'] = False
action['invocation'] = {'kind': 'command', 'command': {'argv': ['{python_exec}', '-c', program]}}
(pack / 'pack.yaml').write_text(yaml.safe_dump({
    'schema_version': 3, 'id': 'generation', 'name': 'Astrid Generation Test',
    'version': source_pack['version'], 'actions': {'generate_image': action},
}, sort_keys=False))
endpoint, token = resolve_runtime_connection(os.environ['ASTRID_TIMELINE_EVAL_ENDPOINT'], Path(sys.argv[2]))
runner = GenericPackHost(pack_roots=[pack_root], client=RuntimeProtocolClient(endpoint, token), executor_id=sys.argv[3], attempt_root=pack_root.with_name(pack_root.name + '-attempts'))
runner.discover(); runner.register(deliberate=True)
if sys.argv[4] == 'run':
    settled = runner.run(once=True); task = settled[0] if settled else None
    print(json.dumps({'task_id': task['task_id'] if task else None, 'state': task['state'] if task else 'idle', 'outputs': [{'name': item['name'], 'object_id': item['digest'], 'media_type': item['media_type'], 'size': item['size']} for item in (task or {}).get('result', {}).get('outputs', [])]}))
else:
    print(json.dumps({'state': 'registered', 'capability_id': 'generation.generate_image'}))
`;

async function runImageHost(harness: DirectHarness, mode: 'register' | 'run', composerCheckout: string): Promise<{ state: string; outputs?: Array<{ object_id: string; name: string }> }> {
  const discovery = harness.discovery();
  const packRoot = path.join(composerCheckout, 'astrid', 'packs');
  const env = {
    ...processEnv(harness),
    ASTRID_CHECKOUT: composerCheckout,
    ASTRID_SOURCE_CHECKOUT: ASTRID_CHECKOUT,
    PYTHONPATH: [composerCheckout, RUNTIME_CHECKOUT].join(path.delimiter),
    ASTRID_TIMELINE_EVAL_ENDPOINT: discovery.endpoint,
  };
  const child = spawnGroup(ASTRID_PYTHON, ['-c', IMAGE_HOST_PROGRAM, packRoot, discovery.worker_credential_file, discovery.worker_actor, mode], { cwd: harness.tmp, env });
  const code = await child.exited; await child.closed;
  if (code !== 0) throw new Error(`image host failed (${code}): ${child.stderr.slice(-3000)}`);
  return JSON.parse(child.stdout.trim().split('\n').pop()!) as { state: string; outputs?: Array<{ object_id: string; name: string }> };
}

async function canonicalImage(harness: DirectHarness, seed: ThreeProductsSeed, objectId: string): Promise<void> {
  await expect.poll(async () => {
    const history = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50`);
    const revision = requireAuthoritativeHead(history.body).revision_id;
    const parent = (await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/composition-revisions/${revision}`)).body.payload;
    const occurrence = parent.occurrences.find((item: any) => item.occurrence_id === seed.occurrenceId);
    if (!occurrence) return undefined;
    const shot = (await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/shots/${seed.shotId}/revisions/${occurrence.shot_revision_id}`)).body;
    const inner = (await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/revisions/${shot.internal_timeline_revision_id}`)).body.payload;
    return inner.clips.find((item: any) => inner.registry.assets[item.asset]?.media_id === objectId && item.clipType === 'image');
  }, CEILING).toMatchObject({ track: PLACEMENT_LANE, hold: 5, clipType: 'image' });
}

async function clickRecovery(page: Page, ownerId: string): Promise<void> {
  await page.getByRole('button', { name: /^Recover saved edits/ }).and(page.locator(`[data-owner-id="${ownerId}"]`)).click();
}

async function chooseTextGeneration(page: Page): Promise<void> {
  const textSource = page.getByRole('radio', { name: 'Just text', exact: true });
  await expect(textSource).toBeVisible(CEILING);
  await textSource.click();
  await expect(textSource).toHaveAttribute('aria-checked', 'true');
  const textModel = page.getByRole('radio', { name: 'Qwen Image 2512', exact: true });
  await expect(textModel).toBeVisible(CEILING);
  await textModel.click();
  await expect(textModel).toHaveAttribute('aria-checked', 'true');
}

async function expectConnectedWithDiagnostics(page: Page, diagnostics: string[], failures: HttpFailure[] = [], pendingFailures: Array<Promise<void>> = []): Promise<void> {
  try {
    const status = page.locator(UI.status);
    if (await status.count()) {
      await expect(status).toHaveAttribute('data-state', 'connected', CEILING);
    } else {
      // Same-origin dev proxy mode has no hosted connection gate; the live editor is its readiness signal.
      await expect(page.getByRole('button', { name: 'Generate image', exact: true })).toBeVisible(CEILING);
    }
  } catch (error) {
    await Promise.allSettled(pendingFailures);
    const body = await page.locator('body').innerText().catch(() => '');
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n` + [
      `page url: ${page.url()}`,
      `page title: ${await page.title().catch(() => '')}`,
      `body: ${body.slice(-4000)}`,
      `HTTP failures: ${JSON.stringify(failures.slice(-40))}`,
      ...diagnostics.slice(-40),
    ].join('\n'));
  }
}

test('real operation proxy automatic image placement survives reconnect, lost ACK retry, reload and guarded undo', async ({ page, workspace }, testInfo) => {
  const { harness, seed, vite } = workspace;
  const composerCheckout = path.join(harness.tmp, 'agent-compose-checkout');
  const legacy: string[] = [];
  const operation: string[] = [];
  const requests: string[] = [];
  const responses: string[] = [];
  const diagnostics: string[] = [];
  const failures: HttpFailure[] = [];
  const pendingFailures: Array<Promise<void>> = [];
  const failureRecord = testInfo.outputPath('auto-http-failures.json');
  const writeFailureRecord = () => writeFileSync(failureRecord, JSON.stringify({ httpFailures: failures.slice(0, 80) }) + '\n');
  writeFailureRecord();
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${sanitizedError(error)}`));
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.push(`console: ${sanitizedError(message.text())}`); });
  page.on('requestfailed', (request) => diagnostics.push(`requestfailed: ${request.method()} ${responsePath(request.url())} ${sanitizedError(request.failure()?.errorText ?? '')}`));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/runtime') || url.pathname.startsWith(OPERATION_PREFIX)) {
      responses.push(`${response.status()} ${url.pathname}`);
      if (response.status() >= 400 && failures.length < 80) {
        const pending = readHttpFailure(response).then((failure) => { failures.push(failure); writeFailureRecord(); });
        pendingFailures.push(pending);
      }
    }
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST') requests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname.startsWith(OPERATION_PREFIX) || url.pathname.startsWith(NORMAL_RUNTIME_PREFIX)) operation.push(`${request.method()} ${url.pathname}`);
    if (classifyRuntimePost(request.method(), url.pathname) === 'legacy-writer') legacy.push(url.pathname);
  });

  await page.goto(`${vite.origin}${APP_ENTRY_ROUTE}`);
  await expectConnectedWithDiagnostics(page, diagnostics, failures, pendingFailures);
  await openSeededTimeline(page, harness);
  const beforePlacement = await currentPlacementSnapshot(harness, seed);
  const baselineHistory = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50`);
  expect(baselineHistory.body.next_cursor).toBeNull();
  const seededPublications = baselineHistory.body.items as JsonRecord[];
  await expect.poll(
    () => responses.filter((entry) => entry.startsWith('200 /api/runtime/v1/events')).length,
    CEILING,
  ).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Generate image', exact: true }).click();
  const approval = page.getByRole('checkbox', { name: /Add the generated image to this timeline/ });
  await expect(approval).not.toBeChecked();
  expect((await commandOutboxes(page, seed.timelineId)).flatMap((item) => item.placementContinuations ?? [])).toHaveLength(0);
  await approval.check();
  await expect(approval).toBeChecked();
  await chooseTextGeneration(page);
  await page.locator('label').filter({ hasText: 'Raw occurrence reference' }).locator('input').fill(`occurrence:${seed.occurrenceId}`);
  await page.locator('label').filter({ hasText: 'Raw lane ID' }).locator('input').fill(PLACEMENT_LANE);
  await page.locator('label').filter({ hasText: 'Raw anchor clip ID' }).locator('input').fill(seed.agentClipId);
  await page.getByRole('radio', { name: /Managed/ }).click();
  const promptSummary = page.getByText(/Click to add prompts|currently active/).first();
  await expect(promptSummary).toBeVisible(CEILING);
  await promptSummary.click();
  await expect(page.locator('textarea[id^="fullPrompt-"]').first()).toBeVisible(CEILING);
  await page.locator('textarea[id^="fullPrompt-"]').first().fill('a deterministic one-pixel test image');
  await page.getByRole('button', { name: 'Close', exact: true }).first().click();

  let reserved: Awaited<ReturnType<typeof commandOutboxes>> | undefined;
  let taskPost: Wire | undefined;
  let reservationProbeFailure: string | undefined;
  await page.route(`**${TASK_PATH}`, async (route) => {
    taskPost = { method: route.request().method(), body: route.request().postData() ?? '', key: route.request().headers()['idempotency-key'] ?? '' };
    let stage = 'initial reservation probe';
    try {
      reserved = await commandOutboxes(page, seed.timelineId);
      if (!reserved.some((item) => item.placementContinuations?.length)) {
        // Keep the admission request paused: the continuation must become
        // observable before Runtime receives the task body.
        stage = 'reservation probe polling';
        await expect.poll(async () => {
          reserved = await commandOutboxes(page, seed.timelineId);
          return reserved.some((item) => item.placementContinuations?.length);
        }, CEILING).toBe(true);
      }
      await route.continue();
    } catch (error) {
      // Keep the original probe error visible while fail-closing the paused
      // admission request. A probe failure must not permit task transmission.
      reservationProbeFailure = `${stage}: ${sanitizedError(error)}`;
      await route.abort('failed').catch(() => {});
    }
  });
  await page.getByRole('button', { name: 'Generate 1 New Image', exact: true }).click();
  try {
    await expect.poll(() => taskPost, CEILING).not.toBeUndefined();
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n` + [
      `operation requests: ${operation.join(' | ')}`,
      `POST requests: ${requests.join(' | ')}`,
      `Runtime responses: ${responses.slice(-60).join(' | ')}`,
      `diagnostics: ${diagnostics.slice(-40).join(' | ')}`,
      `modal body: ${(await page.locator('body').innerText().catch(() => '')).slice(-4000)}`,
    ].join('\n'));
  }
  const owner = (reserved ?? []).find((item) => item.placementContinuations?.length);
  if (!owner) {
    const probe = reservationProbeFailure ? ` (${reservationProbeFailure})` : '';
    throw new Error(`placement reservation missing before task admission${probe}: ${JSON.stringify(reserved)}`);
  }
  expect(owner?.placementContinuations?.[0].input).toMatchObject({ ownerRef: `occurrence:${seed.occurrenceId}`, lane: PLACEMENT_LANE, anchor: seed.agentClipId });
  expect(owner?.placementContinuations?.[0].input.request).toEqual({ method: 'POST', path: '/v1/tasks', body: taskPost!.body, key: taskPost!.key });
  expect(owner?.placementContinuations?.[0].input.readClosure).toEqual(expect.objectContaining({ head: expect.anything(), savedCanonicalDocument: expect.anything() }));

  const admitted = await runImageHost(harness, 'run', composerCheckout);
  expect(admitted.state).toBe('succeeded');
  const objectId = admitted.outputs?.find((item) => item.name === 'generated_images')?.object_id;
  expect(objectId).toMatch(/^sha256:/);

  // The operation handle is pinned to the old Runtime. Restart both Runtime and Vite, keeping the browser origin and IndexedDB.
  await harness.restartRuntime();
  await vite.restart();
  await waitFor(`${vite.origin}${APP_ENTRY_ROUTE}`);
  await reloadEditor(page, `${vite.origin}${APP_ENTRY_ROUTE}`);
  await expectConnectedWithDiagnostics(page, diagnostics, failures, pendingFailures);
  await openSeededTimeline(page, harness);
  const retained = (await commandOutboxes(page, seed.timelineId)).find((item) => item.placementContinuations?.length);
  expect(retained).toBeTruthy();
  await runImageHost(harness, 'run', composerCheckout);
  const taskId = retained!.placementContinuations?.[0].taskLocator?.taskId;
  expect(taskId).toBeTruthy();
  await expect.poll(
    async () => (await harness.runtimeJson<any>('GET', `/v1/tasks/${taskId}`)).body.state,
    CEILING,
  ).toBe('succeeded');
  await expect.poll(
    async () => (await harness.runtimeJson<any>('GET', `/v1/tasks/${taskId}/managed-outputs?limit=50`)).body.items?.length ?? 0,
    CEILING,
  ).toBeGreaterThan(0);

  let lost: Wire | undefined;
  await page.route(COMMIT_PATH, async (route) => {
    const response = await route.fetch();
    const receiptBody = await response.text();
    lost = { method: route.request().method(), body: route.request().postData() ?? '', key: route.request().headers()['idempotency-key'] ?? '', receipt: JSON.parse(receiptBody), receiptBody };
    await route.abort('connectionreset');
  });
  await clickRecovery(page, retained!.ownerId);
  await expect.poll(async () => (await commandOutboxes(page, seed.timelineId)).find((item) => item.ownerId === retained!.ownerId)?.pending?.outcome?.kind, CEILING).toBe('retry');
  expect(lost?.body).toBeTruthy();
  // The first response is intentionally discarded by the browser, but the operation proxy
  // still returned the Runtime's complete v2 reply before the connection reset.
  assertFullV2Request(lost!, harness.seed.projectId, seed.timelineId);
  assertFullV2Reply(lost!, harness.seed.projectId, seed.timelineId);
  await canonicalImage(harness, seed, objectId!);

  await harness.restartRuntime();
  await vite.restart();
  await waitFor(`${vite.origin}${APP_ENTRY_ROUTE}`);
  const operationAfterRestart = operation.length;
  await reloadEditor(page, `${vite.origin}${APP_ENTRY_ROUTE}`);
  await expectConnectedWithDiagnostics(page, diagnostics, failures, pendingFailures);
  await openSeededTimeline(page, harness);
  await expect.poll(() => operation.slice(operationAfterRestart).some((entry) => entry.endsWith('/realm')), CEILING).toBe(true);
  const responsesAfterOpen = responses.length;
  await expect.poll(() => responses.length, CEILING).toBeGreaterThan(responsesAfterOpen);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const recovered = (await commandOutboxes(page, seed.timelineId)).find((item) => item.ownerId === retained!.ownerId)!;
  let retry: Wire | undefined;
  await page.unroute(COMMIT_PATH);
  await page.route(COMMIT_PATH, async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    retry = { method: route.request().method(), body: route.request().postData() ?? '', key: route.request().headers()['idempotency-key'] ?? '', receipt: JSON.parse(body.toString()), receiptBody: body.toString() };
    await route.fulfill({ status: response.status(), headers: response.headers(), body });
  });
  await clickRecovery(page, recovered.ownerId);
  await expect.poll(async () => (await commandOutboxes(page, seed.timelineId)).every((item) => !item.pending && !item.intents.length && !item.placementContinuations?.some((placement) => !placement.placement?.accepted)), CEILING).toBe(true);
  expect(retry).toMatchObject({ method: lost!.method, body: lost!.body, key: lost!.key, receipt: lost!.receipt });
  const retryRequest = assertFullV2Request(retry!, harness.seed.projectId, seed.timelineId);
  const retryData = assertFullV2Reply(retry!, harness.seed.projectId, seed.timelineId);
  expect(retryRequest.base_revision_id).toBe(retryData.base_revision_id);
  expect(retryRequest.base_publication_id).toBe(retryData.base_publication_id);
  const completed = (await commandOutboxes(page, seed.timelineId)).find((item) => item.ownerId === recovered.ownerId);
  const inversePublicationId = completed?.placementContinuations?.find((placement) => placement.id === recovered.placementContinuations?.[0]?.id)?.placement?.accepted?.head.publicationId;
  if (!inversePublicationId) throw new Error('automatic placement did not retain its accepted publication for guarded undo');
  const completedPlacement = completed?.placementContinuations?.find((placement) => placement.id === recovered.placementContinuations?.[0]?.id);
  const createdClipId = completedPlacement?.input.createdIds[0];
  const mediaPin = record(completedPlacement?.mediaPin, 'saved immutable generated media pin');
  if (!createdClipId) throw new Error('automatic placement did not retain its created clip identity');
  const afterPlacement = await currentPlacementSnapshot(harness, seed);
  expect(replyPlacementSnapshot(retryData, seed)).toEqual(afterPlacement);
  assertPlacementCanonicalDelta(beforePlacement, afterPlacement, seed, createdClipId, objectId!, mediaPin);
  const placementHistory = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50`);
  expect(placementHistory.body.head).toEqual({ revision_id: retryData.accepted_revision_id, publication_id: inversePublicationId });
  const placementEntry = (placementHistory.body.items as JsonRecord[]).find((entry) => entry.publication_id === inversePublicationId);
  expect(placementEntry, 'Runtime /commits contains the accepted placement publication').toBeTruthy();
  assertHistoryPlacement(placementEntry!, retryData, inversePublicationId, retry!);
  assertNoOldRoutePublications(placementHistory.body, seededPublications, [inversePublicationId]);
  await canonicalImage(harness, seed, objectId!);

  await page.unroute(COMMIT_PATH);
  await reloadEditor(page, `${vite.origin}${APP_ENTRY_ROUTE}`);
  await expectConnectedWithDiagnostics(page, diagnostics, failures, pendingFailures);
  await openSeededTimeline(page, harness);
  expect(await currentPlacementSnapshot(harness, seed)).toEqual(afterPlacement);
  await canonicalImage(harness, seed, objectId!);
  const beforeUndo = operation.length;
  const undoRequest = page.waitForRequest((request) => isExpectedV2InverseRequest(request, harness.seed.projectId, seed.timelineId, inversePublicationId), CEILING);
  const undoResponse = page.waitForResponse((response) => response.request().method() === 'POST' && /\/commit$/.test(new URL(response.url()).pathname), CEILING);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const undoBody = JSON.parse((await undoRequest).postData() ?? '{}') as { base_revision_id?: string; base_publication_id?: string; commands?: Array<{ op?: string }> };
  expect(undoBody).toMatchObject({ base_revision_id: expect.any(String), base_publication_id: expect.any(String), commands: [{ op: 'timeline.inverse' }] });
  const undoResponseValue = await undoResponse;
  const undoReceiptBody = await undoResponseValue.text();
  const undoWire: Wire = { method: undoResponseValue.request().method(), body: undoResponseValue.request().postData() ?? '', key: undoResponseValue.request().headers()['idempotency-key'] ?? '', receipt: JSON.parse(undoReceiptBody), receiptBody: undoReceiptBody };
  const undoRequestV2 = assertFullV2Request(undoWire, harness.seed.projectId, seed.timelineId);
  const undoData = assertFullV2Reply(undoWire, harness.seed.projectId, seed.timelineId);
  expect(undoRequestV2.commands[0]).toMatchObject({ op: 'timeline.inverse' });
  await expect.poll(() => operation.length, CEILING).toBeGreaterThan(beforeUndo);
  await expect.poll(async () => (await commandOutboxes(page, seed.timelineId)).every((item) => !item.pending && !item.intents.length), CEILING).toBe(true);

  const history = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50`);
  const inversePublication = record(record(undoWire.receipt, 'guarded undo envelope').receipt, 'guarded undo receipt').receipt_id as string;
  const inverseEntry = (history.body.items as JsonRecord[]).find((entry) => entry.publication_id === inversePublication);
  expect(inverseEntry, 'Runtime /commits contains the guarded inverse publication').toBeTruthy();
  assertHistoryPlacement(inverseEntry!, undoData, inversePublication, undoWire, [inversePublicationId]);
  const inverseRecords = record(inverseEntry!.records, 'guarded inverse records');
  expect(inverseRecords.undo_of).toEqual([inversePublicationId]);
  expect(inverseRecords.undo_steps).toBeNull();
  assertNoOldRoutePublications(history.body, seededPublications, [inversePublicationId, inversePublication]);
  const current = requireAuthoritativeHead(history.body);
  const undone = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/composition-revisions/${current.revision_id}`);
  const occurrence = undone.body.payload.occurrences.find((item: any) => item.occurrence_id === seed.occurrenceId);
  const shot = (await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/shots/${seed.shotId}/revisions/${occurrence.shot_revision_id}`)).body;
  const inner = (await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/revisions/${shot.internal_timeline_revision_id}`)).body.payload;
  expect(inner.clips.some((item: any) => inner.registry.assets[item.asset]?.media_id === objectId)).toBe(false);
  expect(legacy, 'automatic placement never uses legacy POST traffic').toEqual([]);
  expect(operation.some((path) => path.includes('/tasks'))).toBe(true);
  expect(operation.some((path) => /\/tasks\/[^/]+$/.test(path))).toBe(true);
  expect(operation.some((path) => /\/tasks\/[^/]+\/managed-outputs$/.test(path))).toBe(true);
  expect(operation.some((path) => path.includes('/media-selection/verified'))).toBe(true);
  expect(operation.some((path) => path.endsWith('/commit'))).toBe(true);
});

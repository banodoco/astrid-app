/**
 * Three products on one realm (testing plan F2, thin slice on the Plan A direct path):
 *
 *   npm run test:e2e:three-products    # hosted App build -> Runtime door -> real Runtime, plus the real Astrid CLI
 *
 * The App (hosted build, Chromium) and the agent (the Astrid CLI as a subprocess) are two clients of one Runtime. Nothing in a
 * case is a stand-in: the page talks to the real door, Astrid to the same Runtime over its own credential, and the Runtime
 * is the real daemon on a throwaway realm. Needs an Astrid checkout (ASTRID_CHECKOUT, default ../astrid-agent) with its Python
 * (ASTRID_PYTHON, default <checkout>/.venv/bin/python); a missing prerequisite fails the run with its name, it never skips.
 *
 * Cases
 *   1  agent -> open App   an Astrid task and the agent's publication show up in the open App with no reload
 *   2  concurrent edit     retained transition/media coverage awaits widened Agent capture (see case comment)
 *   3  Runtime restart     an unsent label command survives the open page and explicit recovery
 *   4  M1 move/restart     real pointer gestures, lost durable ACK, dependent intent, exact retry and UI inverse
 *   5  relevant conflict   a real dependency change retains B instead of rewriting its guards
 * Every case first proves the three products share one realm, one Runtime instance and one contract, and ends with the
 * page-wide check that no credential ever reached the page.
 *
 * Not covered here (recorded, each released by a named test; plan "Owned debt"):
 *   step 3  render R adversarially (publish R+1 before it runs)   needs rendering without a provisioned Remotion and Linux custody
 *   step 4  playback parity of that render                         same
 *   step 6  Codex image -> sprite                                  full tier only, needs the network
 *
 * Speed: durations, Astrid call times and the load average are written to three-products-summary.json (beside the Playwright
 * output) and never judged (R-10). Waits are hang ceilings, not budgets. The ordering of events is made by awaited CLI calls and
 * route holds, never by sleeping.
 */
import { expect, type Locator, type Page, type Request, type Route } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import path from 'node:path';
import { getTimelineLabelWidth } from '../../../src/tools/video-editor/lib/coordinate-utils.ts';
import { PREVIEW_SURFACE, calibrateRuler, seekRulerToFrame, type RulerSeek } from '../support/previewRuler.ts';
import { harnessUnavailableReason, startDirectHarness, sha256Hex, THREE_PRODUCTS_REFERENCE_AT, type DirectHarness, type ThreeProductsSeed } from './support/harness.ts';
import { APP_ENTRY_ROUTE, commandOutboxes, currentHead, dragTimelineClip, dropFileOnTimeline, editFirstTrackName, expectConnected, firstTrackName, holdCommandRequests, holdTimelineCreation, openApp, openSeededTimeline, revisionBody, test as appTest, timelineDraft, UI, waitForAudit } from './support/app.ts';
import { allowlistedEvidenceMethod, allowlistedEvidenceStatus, relevantEvidenceRoute, type EvidenceMethod, type EvidenceRoute } from './support/auto-real-proxy-helpers.ts';
import { timelineBase as runtimeTimelineBase, timelineFromList, type TimelineListPage, type TimelineScope } from './support/timeline-scope.ts';
import type { CanonicalDocument, CommitAcceptedMutation, CommitRequest, EditCommand, HeadPin, HistoryEntry, HistoryPage } from '../../../src/integrations/runtime/timeline-commit-types.ts';
import { ASTRID_PYTHON, AstridCli, astridUnavailableReason, contractDigest, realmDisagreements, revisionSet, type AstridCall, type AstridIdentity } from './support/astrid.ts';
import { centreCell, gridDifference, letterbox, matches, pictureGrid, MATCH, type GridDifference, type PictureGrid, type Rect } from './support/pictures.ts';
import { assertGate5ResetPrecondition } from './support/gate5-reset-precondition.ts';
import { classifyGate5FaultOrder, sameGate5CommitIdentity, type Gate5CommitIdentity } from './support/gate5-fault-order.ts';

/** A hang ceiling for one wait (R-10): many times the usual time, never a budget. */
const CEILING = { timeout: 90_000 };
const SAVES = /\/timelines\/[^/]+\/composition-revisions$/;
const CONFLICT_TITLE = 'This timeline changed somewhere else';
const COMMITS = /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

const test = appTest.extend<object, { seed3: ThreeProductsSeed; astrid: AstridCli; quickAstrid: AstridCli }>({
  // P3 owns initialization of the common bootstrap's single pristine Runtime shell.
  // eslint-disable-next-line no-empty-pattern
  harness: [async ({}, use) => {
    const harness = await startDirectHarness({ deferTimelineInitialization: true });
    try { await use(harness); } finally { await harness.stop(); }
  }, { scope: 'worker', timeout: process.env.ASTRID_QUICK_DESCRIPTOR ? 0 : 240_000 }],
  seed3: [async ({ harness }, use) => {
    await use(await harness.seedThreeProducts());
  }, { scope: 'worker', timeout: 240_000 }],
  astrid: [async ({ harness, seed3 }, use) => {
    const astrid = await AstridCli.create(harness);
    journey.identity = await astrid.preflight();
    // The seed must be something Astrid accepts as it is (a real finding otherwise): check a fresh working copy of it, then drop it.
    await astrid.astrid(['timelines', 'checkout', seed3.timelineId, '--project', seed3.projectSlug, '--fresh', '--json']);
    await astrid.astrid(['timelines', 'check', seed3.timelineId, '--project', seed3.projectSlug, '--no-sweep']);
    await astrid.astrid(['timelines', 'discard', seed3.timelineId, '--project', seed3.projectSlug]);
    journey.preflightCalls = [...astrid.calls];
    await use(astrid);
  }, { scope: 'worker', timeout: 240_000 }],
  quickAstrid: [async ({ harness }, use) => {
    if (!harness.attachment) throw new Error('quick Astrid fixture requires ASTRID_QUICK_DESCRIPTOR');
    const astrid = await AstridCli.create(harness);
    journey.identity = await astrid.preflight();
    journey.preflightCalls = [...astrid.calls];
    await use(astrid);
  }, { scope: 'worker', timeout: 0 }],
});

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  const reason = harnessUnavailableReason() ?? astridUnavailableReason();
  if (reason) throw new Error(`the three-products journey cannot run: ${reason}`);
  if (!process.env.ASTRID_QUICK_DESCRIPTOR) {
    const expectedAgentHead = process.env.TIMELINE_BUNDLE_AGENT_HEAD;
    const expectedRuntimeHead = process.env.TIMELINE_BUNDLE_RUNTIME_HEAD;
    if (!expectedAgentHead || !FULL_SHA.test(expectedAgentHead)) {
      throw new Error('the current three-products cohort requires TIMELINE_BUNDLE_AGENT_HEAD as a full 40-character SHA');
    }
    if (!expectedRuntimeHead || !FULL_SHA.test(expectedRuntimeHead)) {
      throw new Error('the current three-products cohort requires TIMELINE_BUNDLE_RUNTIME_HEAD as a full 40-character SHA');
    }
    const sources = revisionSet();
    if (sources.astridHead !== expectedAgentHead) throw new Error(`the current Agent source moved: expected ${expectedAgentHead}, got ${sources.astridHead}`);
    if (sources.runtimeHead !== expectedRuntimeHead) throw new Error(`the current Runtime source moved: expected ${expectedRuntimeHead}, got ${sources.runtimeHead}`);
    journey.sources = sources;
  }
});

// ---------------------------------------------------------------------------------------------
// The run summary (revision set, durations, load: reported, never judged)

interface CaseRecord {
  name: string;
  status: string;
  durationMs: number;
  loadAverageStart: number;
  loadAverageEnd: number;
  astridCalls: AstridCall[];
  facts: Record<string, unknown>;
}

const journey = {
  startedAt: new Date().toISOString(),
  loadAverageStart: loadavg(),
  identity: undefined as AstridIdentity | undefined,
  sources: undefined as ReturnType<typeof revisionSet> | undefined,
  preflightCalls: [] as AstridCall[],
  cases: [] as CaseRecord[],
  /** What the running case has learned that the summary should carry (named facts, never verdicts on speed). */
  facts: {} as Record<string, unknown>,
  caseStart: { at: 0, load: 0, calls: 0 },
};

interface BoundedBrowserEvidence {
  requests: Array<{ method: EvidenceMethod; route: EvidenceRoute }>;
  responses: Array<{ method: EvidenceMethod; route: EvidenceRoute; status: number }>;
}

const browserEvidence = new Map<Page, BoundedBrowserEvidence>();

function captureBoundedBrowserEvidence(page: Page): void {
  const evidence: BoundedBrowserEvidence = { requests: [], responses: [] };
  browserEvidence.set(page, evidence);
  page.on('request', (request) => {
    const method = allowlistedEvidenceMethod(request.method());
    const route = relevantEvidenceRoute(request.url());
    if (method && route && evidence.requests.length < 80) evidence.requests.push({ method, route });
  });
  page.on('response', (response) => {
    const method = allowlistedEvidenceMethod(response.request().method());
    const route = relevantEvidenceRoute(response.url());
    const status = allowlistedEvidenceStatus(response.status());
    if (method && route && status !== undefined && evidence.responses.length < 80) {
      evidence.responses.push({ method, route, status });
    }
  });
}

test.beforeEach(async ({ astrid }) => {
  journey.facts = {};
  browserEvidence.clear();
  journey.caseStart = { at: Date.now(), load: loadavg()[0], calls: astrid.calls.length };
});

test.afterEach(async ({ astrid, page }, testInfo) => {
  const evidence = [...browserEvidence.values()];
  if (evidence.length) {
    journey.facts = {
      ...journey.facts,
      boundedBrowserEvidence: {
        requests: evidence.flatMap((item) => item.requests).slice(0, 160),
        responses: evidence.flatMap((item) => item.responses).slice(0, 160),
      },
    };
  }
  journey.cases.push({
    name: testInfo.title,
    status: testInfo.status ?? 'unknown',
    durationMs: testInfo.duration,
    loadAverageStart: journey.caseStart.load,
    loadAverageEnd: loadavg()[0],
    astridCalls: astrid.calls.slice(journey.caseStart.calls),
    facts: journey.facts,
  });
});

// Playwright reads fixture dependencies from the destructuring pattern, so the empty pattern is required.
// eslint-disable-next-line no-empty-pattern
test.afterAll(async ({}, testInfo) => {
  const outputDir = testInfo.project.outputDir;
  console.log('[three-products] source tuple', JSON.stringify(revisionSet(journey.identity)));
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, 'three-products-summary.json'), JSON.stringify({
    startedAt: journey.startedAt,
    note: 'reported, never judged (testing plan R-10)',
    revisions: revisionSet(journey.identity),
    sourcesAtStart: journey.sources,
    machine: { cpus: cpus().length, loadAverageStart: journey.loadAverageStart, loadAverageEnd: loadavg() },
    preflight: { astridCalls: journey.preflightCalls },
    cases: journey.cases,
  }, null, 2));
  expect(revisionSet(), 'source tuple must remain fixed throughout the cross-product run').toEqual(journey.sources);
});

// ---------------------------------------------------------------------------------------------
// Helpers: what the Runtime holds, what the page was told, what the agent sees

/** JSON with sorted keys, so "equal" means the same data whatever the key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const timelineBase = (harness: DirectHarness, seed: Pick<ThreeProductsSeed, 'timelineId'>, scope: TimelineScope = {
  projectId: harness.seed.projectId, timelineId: seed.timelineId,
}) =>
  runtimeTimelineBase(scope);

/** Every composition revision of the seeded timeline, newest first. */
async function allRevisions(harness: DirectHarness, seed: Pick<ThreeProductsSeed, 'timelineId'>): Promise<Array<{ revision_id: string; is_current_head: boolean }>> {
  const items: Array<{ revision_id: string; is_current_head: boolean }> = [];
  let cursor: string | null = null;
  do {
    const page: { status: number; body: any } = await harness.runtimeJson('GET', `${timelineBase(harness, seed)}/composition-revisions?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    items.push(...page.body.items);
    cursor = page.body.next_cursor ?? null;
  } while (cursor);
  return items;
}

/** Read the canonical authored closure from the normal Runtime reads, before a commit changes the head. */
async function canonicalDocumentAt(harness: DirectHarness, seed: ThreeProductsSeed, revisionId: string): Promise<CanonicalDocument> {
  const parent = await revisionBody(harness, revisionId) as Record<string, any>;
  const manifest = parent.dependency_manifest as Record<string, any>;
  expect(manifest, `revision ${revisionId} exposes its dependency manifest`).toBeTruthy();
  const shotRevisions = await Promise.all((manifest.shots as Array<Record<string, any>>).map(async (pin) => {
    const response = await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}/shots/${pin.shot_id}/revisions/${pin.revision_id}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { ...pin, payload: response.body.payload };
  }));
  const internalTimelineRevisions = await Promise.all((manifest.internal_timelines as Array<Record<string, any>>).map(async (pin) => {
    const response = await harness.runtimeJson('GET', `${timelineBase(harness, seed)}/revisions/${pin.revision_id}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { ...pin, payload: response.body.payload };
  }));
  return {
    schema_version: 1,
    project_id: harness.seed.projectId,
    timeline_id: seed.timelineId,
    parent_revision: { revision_id: parent.revision_id, content_digest: parent.content_digest, payload: parent.payload },
    shot_revisions: shotRevisions,
    internal_timeline_revisions: internalTimelineRevisions,
    dependency_manifest: manifest,
  } as CanonicalDocument;
}

/** The parent composition of a revision and the agent's shot content beneath it, read straight from the Runtime. */
async function revisionState(harness: DirectHarness, seed: ThreeProductsSeed, revisionId: string) {
  const parent = (await revisionBody(harness, revisionId)).payload;
  const occurrence = (parent.occurrences as Array<Record<string, any>>).find((candidate) => candidate.occurrence_id === seed.occurrenceId);
  expect(occurrence, `revision ${revisionId} keeps the agent's shot placement`).toBeTruthy();
  const shot = await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}/shots/${seed.shotId}/revisions/${occurrence!.shot_revision_id}`);
  expect(shot.status, JSON.stringify(shot.body)).toBe(200);
  const inner = await harness.runtimeJson('GET', `${timelineBase(harness, seed)}/revisions/${(shot.body as any).internal_timeline_revision_id}`);
  expect(inner.status, JSON.stringify(inner.body)).toBe(200);
  const payload = (inner.body as any).payload;
  return {
    revisionId,
    parent,
    trackLabel: (parent.config.tracks as Array<Record<string, any>>).find((track) => track.id === 'V1')?.label as string | undefined,
    parentClips: Object.fromEntries((parent.clips as Array<Record<string, any>>).map((clip) => [clip.id, clip])) as Record<string, Record<string, any>>,
    shotClips: Object.fromEntries((payload.clips as Array<Record<string, any>>).map((clip) => [clip.id, clip])) as Record<string, Record<string, any>>,
    shotRegistry: payload.registry.assets as Record<string, Record<string, any>>,
    internalRevisionId: (shot.body as any).internal_timeline_revision_id as string,
  };
}

/** The opaque data neither client models is the seed's, unchanged, in the seed and in every later revision (the App's saves and the agent's alike). */
async function expectOpaqueDataKept(harness: DirectHarness, seed: ThreeProductsSeed) {
  const revisions = await allRevisions(harness, seed);
  const seedAt = revisions.findIndex((revision) => revision.revision_id === seed.headRevisionId);
  expect(seedAt, 'the seed revision is in the history').toBeGreaterThanOrEqual(0);
  for (const revision of revisions.slice(0, seedAt + 1)) {
    const state = await revisionState(harness, seed, revision.revision_id);
    expect(canonical(state.parent.config.x_f2_opaque), `config.x_f2_opaque in ${revision.revision_id}`).toBe(canonical(seed.opaque.config));
    expect(canonical(state.shotClips[seed.agentClipId].app?.f2Opaque), `${seed.agentClipId}.app.f2Opaque in ${revision.revision_id}`).toBe(canonical(seed.opaque.clip));
  }
  return revisions.length;
}

/** The agent's verbs, as the CLI ships them. */
function agentOf(astrid: AstridCli, seed: Pick<ThreeProductsSeed, 'timelineId' | 'projectSlug'>) {
  const common = [seed.timelineId, '--project', seed.projectSlug];
  return {
    checkout: () => astrid.astrid(['timelines', 'checkout', ...common, '--fresh', '--json']),
    edit: (...flags: string[]) => astrid.astrid(['timelines', 'edit', ...common, ...flags]),
    publish: async (message: string, idempotencyKey: string) => {
      const envelope = await astrid.json<{ new_head: string; old_head: string; idempotency_key: string; published?: boolean }>(['timelines', 'publish', ...common, '-m', message, '--idempotency-key', idempotencyKey, '--json']);
      expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
      return envelope.data!;
    },
    status: async () => (await astrid.json<{ current_head: string }>(['timelines', 'status', ...common, '--json'])).data!,
    show: async () => (await astrid.json<{ head_revision_id: string; rows: Array<{ layers: Array<{ clip_id: string; asset: string | null }> }> }>(['timelines', 'show', ...common, '--published', '--json'])).data!,
  };
}

/** A credential never reaches the page: not in a request, a door answer, the DOM, or the page's storage. */
class TokenSniff {
  private readonly pending: Array<Promise<void>> = [];
  private readonly leaks: string[] = [];

  constructor(private readonly tokens: Record<string, string>) {}

  private scan(where: string, text: string | null | undefined) {
    if (!text) return;
    for (const [name, token] of Object.entries(this.tokens)) if (text.includes(token)) this.leaks.push(`${name} token in ${where}`);
  }

  attach(page: Page) {
    page.on('request', (request: Request) => {
      this.pending.push((async () => {
        const headers = await request.allHeaders().catch(() => request.headers());
        this.scan(`the URL of ${request.method()} ${request.url().split('?')[0]}`, request.url());
        this.scan(`the headers of ${request.method()} ${request.url().split('?')[0]}`, JSON.stringify(headers));
        this.scan(`the body of ${request.method()} ${request.url().split('?')[0]}`, request.postData());
      })());
    });
    page.on('response', (response) => {
      const type = response.headers()['content-type'] ?? '';
      if (!/json|text/.test(type) || !response.url().includes(`:${new URL(response.url()).port}/api/`)) return;
      this.pending.push(response.text().then((text) => this.scan(`the answer to ${response.request().method()} ${response.url().split('?')[0]}`, text)).catch(() => {}));
    });
  }

  async expectClean(page: Page, timelineId?: string) {
    await Promise.all(this.pending);
    const inPage = await page.evaluate(() => JSON.stringify({
      dom: document.documentElement.outerHTML,
      local: Object.fromEntries(Object.entries(window.localStorage)),
      session: Object.fromEntries(Object.entries(window.sessionStorage)),
      cookie: document.cookie,
    }));
    this.scan('the page (DOM, storage, cookies)', inPage);
    if (timelineId) this.scan('native command outboxes', JSON.stringify(await commandOutboxes(page, timelineId)));
    expect(this.leaks, 'no credential reached the page').toEqual([]);
  }
}

/** The credentials in play: the App's, Astrid's, and the Runtime's owner and worker credentials (none belongs in a page). */
function secretsOf(harness: DirectHarness, astrid: AstridCli): Record<string, string> {
  const fromFile = (file: string) => {
    const text = readFileSync(file, 'utf8').trim();
    try { const parsed = JSON.parse(text); return typeof parsed.token === 'string' ? parsed.token : text; } catch { return text; }
  };
  return {
    product: harness.productToken,
    astrid: astrid.secret,
    owner: fromFile(path.join(harness.supportDir, 'credentials', 'owner.token')),
    worker: fromFile(harness.discovery().worker_credential_file),
  };
}

/**
 * The three products are talking to the same Runtime: the realm and instance the harness made, the page's health and realm
 * (fetched from inside the page, through the door) and Astrid's handshake all agree, and so do the contract digests of the App,
 * of Astrid and of the Runtime. Returns what each saw, for the summary.
 */
async function expectSameRealm(page: Page, harness: DirectHarness, astrid: AstridCli) {
  const fromPage = await page.evaluate(async (base) => {
    const [health, realm] = await Promise.all([fetch(`${base}/v1/health`), fetch(`${base}/v1/realm`)]);
    return { health: await health.json(), realm: await realm.json() };
  }, harness.doorBase);
  const fromAstrid = await astrid.identity();
  const digest = contractDigest();
  expect([
    ...realmDisagreements('the page', { realm_id: fromPage.realm.realm_id, runtime_instance_id: fromPage.health.runtime_instance_id, schema_digest: fromPage.health.schema_digest }, harness, digest),
    ...realmDisagreements('Astrid', fromAstrid, harness, digest),
  ], 'the page, Astrid and the Runtime share one realm, instance and contract').toEqual([]);
  return { realmId: fromPage.realm.realm_id as string, runtimeInstanceId: fromPage.health.runtime_instance_id as string, schemaDigest: fromPage.health.schema_digest as string, astridFile: fromAstrid.astrid_file };
}

/** The transition control of the clip panel, found by its label (the panel's selects carry no accessible name). */
const transitionSelect = (page: Page): Locator => page.getByText('Transition', { exact: true }).locator('xpath=following::*[@role="combobox"][1]');

async function selectClip(page: Page, clipId: string) {
  await page.locator(`[data-clip-id="${clipId}"]`).first().click();
}

async function setTransitionToNone(page: Page, clipId: string) {
  await selectClip(page, clipId);
  await transitionSelect(page).click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await expect(transitionSelect(page)).toContainText('None');
}

/** Opens the App's action pane, where the runtime activity dock lives (it slides away until opened). */
async function openActionPane(page: Page) {
  await page.getByRole('button', { name: /^Open Action pane/ }).click();
  await expect(page.locator('[data-runtime-activity-dock]')).toBeVisible();
}

/** What the page was told by the Runtime: the answers it received, keyed by what they are. */
function watchPageReads(page: Page, harness: DirectHarness) {
  const reads = { eventFeed: [] as Array<{ aggregate_type: string; aggregate_id: string; event_type: string }>, urls: [] as string[], internalRevisions: [] as Array<{ id: string; payload: any }>, compositionRevisions: [] as Array<{ id: string; payload: any }> };
  page.on('response', (response) => {
    const url = response.url();
    if (!url.startsWith(harness.doorBase) || response.request().method() !== 'GET' || response.status() !== 200) return;
    const route = url.slice(harness.doorBase.length);
    reads.urls.push(route);
    if (route.startsWith('/v1/events')) {
      void response.json().then((body) => { for (const item of body.items ?? []) reads.eventFeed.push({ aggregate_type: item.aggregate_type, aggregate_id: item.aggregate_id, event_type: item.event_type }); }).catch(() => {});
    } else if (/\/composition-revisions\/[^/?]+$/.test(route)) {
      void response.json().then((body) => { reads.compositionRevisions.push({ id: body.revision_id, payload: body.payload }); }).catch(() => {});
    } else if (/\/timelines\/[^/]+\/revisions\/[^/?]+$/.test(route)) {
      void response.json().then((body) => { reads.internalRevisions.push({ id: body.revision_id, payload: body.payload }); }).catch(() => {});
    }
  });
  return reads;
}

const noReloadFlag = (page: Page) => page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload);

async function plantNoReloadFlag(page: Page) {
  await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
}

// ---------------------------------------------------------------------------------------------
// 1. agent -> open App

// Bundle 1 blocker: the original Agent swap below still needs native asset + registry/task-output capture.
// Keep the task/adoption/media assertions until that operation ships; the final App label uses commands now.
test('agent -> open App: an Astrid task and its publication appear in the open App without a reload', async ({ page, harness, astrid, seed3 }) => {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  const agent = agentOf(astrid, seed3);
  const sniff = new TokenSniff(secretsOf(harness, astrid));
  sniff.attach(page);
  const reads = watchPageReads(page, harness);

  await openApp(page, harness);
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await plantNoReloadFlag(page);
  await openActionPane(page);
  journey.facts.sameRealm = await expectSameRealm(page, harness, astrid);

  // The agent registers an executor and admits a task. The page learns of it from the Runtime's event feed, not from a reload.
  await astrid.host({ register: true });
  const created = await astrid.json<{ task_id: string }>(['tasks', 'create', '--project', seed3.projectSlug, '--capability', 'f2.marker', '--spec', '{}', '--json']);
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const taskId = created.data!.task_id;
  const row = page.locator(`[data-activity-task-id="${taskId}"]`);
  await expect(row).toHaveAttribute('aria-label', /^F2 Marker, (Queued|Ready)$/, CEILING);
  await expect.poll(() => reads.eventFeed, { message: 'the page was told by the event feed', ...CEILING }).toContainEqual(expect.objectContaining({ aggregate_type: 'task', aggregate_id: taskId }));

  // The executor runs it: the task leaves the active rows and is listed as complete.
  const ran = await astrid.host({ runOnce: true });
  expect(ran).toMatchObject({ task_id: taskId, state: 'succeeded' });
  const output = ran.outputs?.find((candidate) => candidate.name === 'marker');
  expect(output, 'the task produced its marker image').toBeTruthy();
  await expect(row).toHaveCount(0, CEILING);
  await page.getByRole('button', { name: 'Peek at tasks' }).click();
  await expect(page.locator('[data-task-peek-surface="tasks"]').filter({ hasText: 'F2 Marker' }).getByText('Complete', { exact: true })).toBeVisible(CEILING);
  const settled = await astrid.json<{ state: string }>(['tasks', 'show', taskId, '--project', seed3.projectSlug, '--json']);
  expect(settled.data!.state, 'the Runtime agrees the task succeeded').toBe('succeeded');

  // The agent publishes the timeline with the task's output; the open page adopts that revision by itself.
  const before = await currentHead(harness);
  await agent.checkout();
  await agent.edit('--clip', seed3.agentClipId, '--swap-asset', `${seed3.markerAssetKey}=task:${taskId}/marker#0`);
  const published = await agent.publish('agent: marker', 'f2-case1');
  expect(published.old_head, 'the agent built on the head the App has').toBe(before);
  expect(published.new_head).not.toBe(before);
  expect(await currentHead(harness), 'the Runtime head is the agent\'s revision').toBe(published.new_head);

  await expect.poll(() => reads.urls.some((url) => url.includes(`/composition-revisions/${published.new_head}`)), CEILING).toBe(true);
  await expect.poll(() => reads.internalRevisions.some((revision) => revision.payload?.registry?.assets?.[seed3.markerAssetKey]), CEILING).toBe(true);
  const adopted = reads.internalRevisions.find((revision) => revision.payload?.registry?.assets?.[seed3.markerAssetKey])!;
  expect(adopted.payload.registry.assets[seed3.markerAssetKey].media_id, 'the page received the revision that carries the task\'s output').toBe(output!.object_id);
  expect(await noReloadFlag(page), 'the page was never reloaded').toBe(true);

  // The Runtime holds the same data: the revision is the task's work, and the agent's edit kept what neither client models.
  const state = await revisionState(harness, seed3, published.new_head);
  expect(state.shotRegistry[seed3.markerAssetKey].media_id).toBe(output!.object_id);
  expect(state.shotClips[seed3.agentClipId].asset).toBe(seed3.markerAssetKey);
  expect((await agent.show()).head_revision_id, 'the agent reads the head it published').toBe(published.new_head);
  const agentHead = (await history(harness, seed3)).head;
  expect(agentHead.revision_id).toBe(published.new_head);
  // The App's next save is built on the agent's head, and the Runtime accepts it (the parent-head check of the retired handoff case).
  const appSaved = page.waitForResponse((response) => response.request().method() === 'POST' && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await editFirstTrackName(page, 'F2 App after agent');
  const appSave = await appSaved;
  expect(appSave.status(), 'the Runtime accepts the App\'s save on the agent\'s head').toBe(200);
  expect(appSave.request().postDataJSON()).toMatchObject({ base_revision_id: published.new_head,
    base_publication_id: agentHead.publication_id,
    commands: [{ op: 'track.set', select: 'parent/track:V1', args: { values: { label: 'F2 App after agent' }, clear: [] } }] });
  await expect.poll(() => currentHead(harness), CEILING).not.toBe(published.new_head);
  const appRevision = await currentHead(harness);
  expect(await noReloadFlag(page), 'the page was still not reloaded after its own save').toBe(true);

  // The agent reads the App's save made on top of its own publication.
  expect((await agent.status()).current_head, 'the agent reads the App\'s revision').toBe(appRevision);

  const revisionCount = await expectOpaqueDataKept(harness, seed3);

  journey.facts = { ...journey.facts, taskId, outputObjectId: output!.object_id, agentRevision: published.new_head, appRevision, revisionCount };
  await sniff.expectClean(page, seed3.timelineId);
});

// ---------------------------------------------------------------------------------------------
// Legacy concurrent edit

/**
 * Migration blocker: Bundle 1 lacks child hold extension, child asset clear and parent transition clear capture.
 * Preserve this entire original ordering and its positive Keep/Use latest assertions until those operations ship.
 * Track/transition writers originally used whole-document CAS saves. Replaying A must not let C overwrite B's changed shot
 * pins, extension and explicit clear. Either the provider notices B before accepting A's receipt or C receives stale_head;
 * both must retain A+C and offer an explicit resolution. Command rebase is exercised separately by the M1 move cases.
 */
test('concurrent edit: the App\'s acknowledgement is lost, the agent publishes, the App edits again; the App names the conflict and keeps its draft', async ({ page, harness, astrid, seed3 }) => {
  const agent = agentOf(astrid, seed3);
  const sniff = new TokenSniff(secretsOf(harness, astrid));
  sniff.attach(page);
  const watched = watchPageReads(page, harness);

  // Every save the page sends, with the key and head it names and what became of it.
  interface Post { key: string; body: string; expectedHead: string | null; status: number | null; outcome: 'held' | 'sent' | 'lost' }
  const posts: Post[] = [];
  const postOf = new Map<Request, Post>();
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !SAVES.test(new URL(request.url()).pathname)) return;
    const post: Post = { key: request.headers()['idempotency-key'], body: request.postData()!, expectedHead: JSON.parse(request.postData() ?? '{}').expected_head ?? null, status: null, outcome: 'sent' };
    postOf.set(request, post);
    posts.push(post);
  });
  page.on('response', (response) => { const post = postOf.get(response.request()); if (post) post.status = response.status(); });
  page.on('requestfailed', (request) => { const post = postOf.get(request); if (post) post.outcome = 'lost'; });

  // Hold the acknowledgement, not the request: the Runtime commits the save, the page never hears back.
  let holding = true;
  const held: Array<{ route: Parameters<Parameters<Page['route']>[1]>[0]; post: Post }> = [];
  await page.route(SAVES, async (route) => {
    const request = route.request();
    if (!holding || request.method() !== 'POST') return route.fallback();
    const post = postOf.get(request)!;
    const response = await route.fetch({ maxRetries: 0 });
    post.status = response.status();
    post.outcome = 'held';
    held.push({ route, post });
  });

  await openApp(page, harness);
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  journey.facts.sameRealm = await expectSameRealm(page, harness, astrid);
  const baseHead = await currentHead(harness);
  const revisionsBefore = (await allRevisions(harness, seed3)).length;

  // A: the App renames the track. The Runtime commits it; the acknowledgement is held.
  await editFirstTrackName(page, 'F2 App A');
  await expect.poll(() => held.length, CEILING).toBe(1);
  expect(held[0].post.status, 'the Runtime committed A').toBe(200);
  expect(held[0].post.expectedHead).toBe(baseHead);
  const keyA = held[0].post.key;
  await expect.poll(() => currentHead(harness), CEILING).not.toBe(baseHead);
  const headA = await currentHead(harness);
  expect(headA, 'the App\'s save is stored under its idempotency key').toBe(keyA);

  // B: the agent builds on A and publishes (it extends one clip and clears another one's asset).
  await agent.checkout();
  const stateA = await revisionState(harness, seed3, headA);
  await agent.edit('--clip', seed3.agentClipId, '--extend', '1');
  await agent.edit('--clip', seed3.agentClearClipId, '--clear-asset');
  const published = await agent.publish('agent: extend and clear', 'f2-case2');
  expect(published.old_head, 'the agent built on the App\'s save').toBe(headA);
  const headB = published.new_head;
  expect(await currentHead(harness)).toBe(headB);

  // C: the App edits again while A is unacknowledged (it clears a transition).
  await setTransitionToNone(page, seed3.transitionClipId);
  await expect.poll(async () => {
    const clip = (await timelineDraft(page, seed3.timelineId))?.draft.config?.clips
      ?.find((candidate) => candidate.id === seed3.transitionClipId);
    return { present: Boolean(clip), transition: clip?.transition ?? null };
  }, CEILING).toEqual({ present: true, transition: null });

  // The acknowledgement is lost: the page sees a connection reset, and its own retry follows.
  holding = false;
  await held[0].route.abort('connectionreset');

  const conflict = page.getByRole('alertdialog', { name: CONFLICT_TITLE });
  await expect(conflict).toBeVisible(CEILING);
  await expect(conflict.getByText('Keep your changes, or switch to the latest version.')).toBeVisible();
  await expect(conflict.getByRole('button', { name: 'Keep my changes' })).toBeVisible();
  await expect(conflict.getByRole('button', { name: 'Use latest version' })).toBeVisible();
  await page.unroute(SAVES);

  // Which of the two ways to the conflict ran (recorded, not asserted).
  const afterRelease = posts.slice(1);
  const queuedEditPosted = afterRelease.find((post) => post.expectedHead === headA && post.key !== keyA);
  const branch = queuedEditPosted ? 'b: the receipt was accepted, the queued edit was posted on A and the Runtime answered 409 stale_head' : 'a: the provider refused the confirmed receipt after its cached head moved to B';
  test.info().annotations.push({ type: 'case-2-branch', description: branch });
  journey.facts = { ...journey.facts, verdict: 'named_conflict', branch, posts: posts.map(({ expectedHead, status, outcome }, index) => ({ n: index + 1, expectedHead: expectedHead === null ? null : expectedHead === baseHead ? 'base head' : expectedHead === headA ? 'A' : expectedHead, status, outcome, sameKeyAsA: posts[index].key === keyA })) };

  // The draft is kept: the dialog is modal, so the editor behind it is hidden from the accessibility tree but still holds A and C.
  await expect(page.getByRole('textbox', { name: 'Track name', includeHidden: true }).first()).toHaveValue('F2 App A');
  await expect(transitionSelect(page)).toContainText('None');

  // The Runtime head is B and holds A and B, and not C.
  expect(await currentHead(harness), 'nothing was published after B').toBe(headB);
  const stateB = await revisionState(harness, seed3, headB);
  expect(stateB.trackLabel, 'B holds the App\'s save A').toBe('F2 App A');
  expect(stateB.shotClips[seed3.agentClipId].hold, 'B holds the agent\'s extension').toBe(stateA.shotClips[seed3.agentClipId].hold + 1);
  expect(stateB.shotClips[seed3.agentClearClipId].asset, 'B holds the agent\'s clear').toBeUndefined();
  expect(stateA.shotClips[seed3.agentClearClipId].asset, 'A still had that asset').toBeTruthy();
  expect(stateB.parentClips[seed3.transitionClipId].transition, 'C was never published').toEqual(stateA.parentClips[seed3.transitionClipId].transition);
  expect(stateB.parentClips[seed3.transitionClipId].transition).toBeTruthy();

  // One publication per retried save: A was replayed under its own key and made exactly one revision; the agent's publication made one.
  const revisions = (await allRevisions(harness, seed3)).map((revision) => revision.revision_id);
  expect(revisions.length, 'two new revisions: A and B').toBe(revisionsBefore + 2);
  expect(new Set(revisions).size, 'no revision is stored twice').toBe(revisions.length);
  expect(revisions.filter((id) => id === keyA), 'A\'s key names exactly one revision').toHaveLength(1);
  const retriesA = posts.filter((post) => post.key === keyA);
  expect(retriesA.length, 'A was replayed with the same key').toBeGreaterThanOrEqual(2);
  expect(retriesA.every((post) => post.body === posts[0].body), 'every replay of A keeps the exact request bytes').toBe(true);
  expect(posts.filter((post) => post.expectedHead === baseHead).every((post) => post.key === keyA), 'every send on the base head is A\'s').toBe(true);

  // Opaque data and clears, in every revision.
  await expectOpaqueDataKept(harness, seed3);

  // Keep is actionable: it stashes A+C durably and loads B without silently overwriting the agent.
  await conflict.getByRole('button', { name: 'Keep my changes' }).click();
  await expect(conflict).toHaveCount(0, CEILING);
  await expect(firstTrackName(page)).toHaveValue(stateB.trackLabel!);
  await selectClip(page, seed3.transitionClipId);
  await expect(transitionSelect(page)).toContainText('crossfade', CEILING);
  const kept = await timelineDraft(page, seed3.timelineId);
  expect(kept?.draft.config?.tracks?.find((track: any) => track.id === 'V1')?.label).toBe('F2 App A');
  expect(kept?.draft.config?.clips?.find((clip: any) => clip.id === seed3.transitionClipId)?.transition).toBeUndefined();
  expect(kept?.baseHeadProjectId).toBe(harness.seed.projectId);
  expect(kept?.baseHeadTimelineId).toBe(seed3.timelineId);
  expect([baseHead, headA]).toContain(kept?.baseHeadRevisionId);
  expect(await currentHead(harness)).toBe(headB);

  // A reload offers that same draft. Retrying its original CAS cannot erase B; Use latest resolves it explicitly.
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  const recovered = page.getByRole('alert').filter({ hasText: 'You have unsaved changes' });
  await expect(recovered).toBeVisible(CEILING);
  await expect(recovered.getByRole('button', { name: 'Save them' })).toBeEnabled();
  expect((await timelineDraft(page, seed3.timelineId))?.draft).toEqual(kept?.draft);
  // Selection is session-local: reopen the clip panel before checking the recovered transition behind the modal.
  await selectClip(page, seed3.transitionClipId);
  await expect(transitionSelect(page)).toContainText('crossfade');
  await recovered.getByRole('button', { name: 'Save them' }).click();
  await expect(conflict).toBeVisible(CEILING);
  await expect(page.getByRole('textbox', { name: 'Track name', includeHidden: true }).first()).toHaveValue('F2 App A');
  await expect(transitionSelect(page)).toContainText('None');
  expect(await currentHead(harness)).toBe(headB);
  await conflict.getByRole('button', { name: 'Use latest version' }).click();
  await expect(conflict).toHaveCount(0, CEILING);
  await expect(firstTrackName(page)).toHaveValue(stateB.trackLabel!);
  await expect.poll(() => timelineDraft(page, seed3.timelineId), CEILING).toBeNull();
  await expect(recovered).toHaveCount(0);
  expect((await allRevisions(harness, seed3)).length, 'resolution creates no extra publication').toBe(revisionsBefore + 2);

  // Both clients agree after another reload: the App reads head B and shows A; the agent reads B.
  const readsBeforeReload = watched.urls.length;
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await expect(firstTrackName(page)).toHaveValue(stateB.trackLabel!);
  await expect.poll(() => watched.urls.slice(readsBeforeReload).some((url) => url.includes(`/composition-revisions/${headB}`)), CEILING).toBe(true);
  await selectClip(page, seed3.transitionClipId);
  await expect(transitionSelect(page)).toContainText('crossfade');
  expect((await agent.status()).current_head).toBe(headB);
  const shown = await agent.show();
  expect(shown.head_revision_id).toBe(headB);
  const layers = shown.rows.flatMap((row) => row.layers);
  expect(layers.find((layer) => layer.clip_id === seed3.agentClearClipId)?.asset, 'the agent sees the clear').toBeNull();
  journey.facts.headB = headB;
  await sniff.expectClean(page, seed3.timelineId);
});

// ---------------------------------------------------------------------------------------------
// Command Runtime restart with both attached

test('Runtime restart with the App open: the draft survives, saves after the relaunch, and the agent follows', async ({ page, harness, astrid, seed3 }) => {
  const agent = agentOf(astrid, seed3);
  const sniff = new TokenSniff(secretsOf(harness, astrid));
  sniff.attach(page);
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);

  await openApp(page, harness);
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  const before = await expectSameRealm(page, harness, astrid);
  const headBefore = await currentHead(harness);
  const revisionsBefore = (await allRevisions(harness, seed3)).length;

  // A draft that was never sent: the save is held, so the edit is a draft by construction.
  const hold = await holdCommandRequests(page);
  await editFirstTrackName(page, 'F2 kept across restart');
  await expect.poll(() => hold.requests.length, CEILING).toBe(1);
  const request = hold.requests[0];
  const draftBefore = (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.pending?.request.key === request.headers()['idempotency-key'])!;
  expect(draftBefore.scope).toMatchObject({ realmId: harness.realmId, projectId: harness.seed.projectId, timelineId: seed3.timelineId });
  expect(draftBefore.pending?.request.body).toBe(request.postData());
  expect(draftBefore.pending?.outcome).toBeUndefined();
  expect(request.postDataJSON()).toMatchObject({ base_revision_id: headBefore,
    commands: [{ op: 'track.set', select: 'parent/track:V1', args: { values: { label: 'F2 kept across restart' }, clear: [] } }] });
  expect(await currentHead(harness)).toBe(headBefore);
  await plantNoReloadFlag(page);

  // The Runtime restarts on a new port; the page says so and does not reload itself.
  const restarted = await harness.restartRuntime();
  expect(restarted.oldInstanceId).toBe(before.runtimeInstanceId);
  expect(harness.runtimePort).not.toBe(restarted.oldPort);
  await expect(page.getByRole('heading', { name: 'Astrid restarted' })).toBeVisible(CEILING);
  expect(await noReloadFlag(page), 'the page does not reload by itself').toBe(true);
  await expect(page.locator(UI.status)).toHaveAttribute('data-state', 'restarted');
  await expect(firstTrackName(page)).toHaveValue('F2 kept across restart');
  expect((await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.ownerId === draftBefore.ownerId)?.intents).toEqual(draftBefore.intents);

  // The agent follows discovery to the new endpoint: same realm and contract, a new instance, and the draft is not in the Runtime.
  const after = await astrid.identity();
  expect(after.realm_id).toBe(before.realmId);
  expect(after.runtime_instance_id, 'the agent reached the relaunched Runtime').toBe(harness.runtimeInstanceId);
  expect(after.runtime_instance_id).not.toBe(before.runtimeInstanceId);
  expect(after.schema_digest).toBe(before.schemaDigest);
  expect((await agent.status()).current_head, 'the draft is not saved').toBe(headBefore);
  expect(await currentHead(harness)).toBe(headBefore);

  // The page reconnects after Reload, offers the draft back, and saves it once the hold is released.
  await page.getByRole('button', { name: UI.reload }).click();
  await expectConnected(page);
  await expect(page.getByRole('heading', { name: 'Astrid restarted' })).toHaveCount(0);
  await openSeededTimeline(page, harness);
  journey.facts.sameRealmAfterRestart = await expectSameRealm(page, harness, astrid);
  const recovered = page.getByRole('button', { name: /^Recover saved edits/ })
    .and(page.locator(`[data-owner-id="${draftBefore.ownerId}"]`));
  await expect(recovered).toBeEnabled(CEILING);
  const persisted = (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.ownerId === draftBefore.ownerId)!;
  expect(persisted.intents).toEqual(draftBefore.intents);
  expect(persisted.pending?.request).toEqual(draftBefore.pending!.request);
  expect(await currentHead(harness), 'reconnection alone never sends the draft').toBe(headBefore);
  await hold.release();
  const recoveredSave = page.waitForResponse((response) => response.request().method() === 'POST' && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await recovered.click();
  const saved = await recoveredSave;
  expect(saved.status(), 'the Runtime accepts the recovered draft').toBe(200);
  expect(saved.request().postData()).toBe(draftBefore.pending!.request.body);
  expect(saved.request().headers()['idempotency-key']).toBe(draftBefore.pending!.request.key);
  const result = await saved.json() as CommitAcceptedMutation;
  const keyAfter = saved.request().headers()['idempotency-key'];
  await expect(recovered).toHaveCount(0, CEILING);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).every((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);
  await expect.poll(() => currentHead(harness), CEILING).not.toBe(headBefore);
  await expect(firstTrackName(page)).toHaveValue('F2 kept across restart');

  // The agent reads what the App saved after the relaunch.
  const headAfter = await currentHead(harness);
  expect((await agent.status()).current_head).toBe(headAfter);
  expect((await agent.show()).head_revision_id).toBe(headAfter);
  const state = await revisionState(harness, seed3, headAfter);
  expect(state.trackLabel, 'the saved revision is the draft').toBe('F2 kept across restart');
  expect(result.receipt.receipt_id, 'the post-restart publication keeps its persisted retry identity').toBe(keyAfter);
  expect(headAfter).toBe(result.data.accepted_revision_id);
  expect((await allRevisions(harness, seed3)).length, 'recover/save creates exactly one revision').toBe(revisionsBefore + 1);
  await expectImmutableClosure(harness, seed3, result);
  await expectOpaqueDataKept(harness, seed3);

  journey.facts = { ...journey.facts, instanceBefore: before.runtimeInstanceId, instanceAfter: after.runtime_instance_id, headBefore, headAfter };
  await sniff.expectClean(page, seed3.timelineId);
});

// ---------------------------------------------------------------------------------------------
// M1: only the network is faulted; capture, storage, acceptance and undo are product code.

interface CommitPost {
  method: string;
  path: string;
  body: string;
  key: string;
  status: number;
  response: any;
}

async function faultFirstCommit(page: Page) {
  const posts: CommitPost[] = [];
  const forwarded: Array<{ identity: Gate5CommitIdentity; response: unknown }> = [];
  const observed: Gate5CommitIdentity[] = [];
  const observedUrls: string[] = [];
  const stagedRetries: Gate5CommitIdentity[] = [];
  const legacy: string[] = [];
  let held: Route | undefined;
  let stagedRoute: Route | undefined;
  let stagedPage: Page | undefined;
  let stagedResolve!: () => void;
  const stagedReady = new Promise<void>((resolve) => { stagedResolve = resolve; });
  let initial: Gate5CommitIdentity | undefined;
  let recoveryForwarded = false;
  let recoveryRetryArmed = false;
  const MAX_OBSERVED_ATTEMPTS = 16;
  const observe = (target: Page) => {
    target.on('request', (request) => {
      if (request.method() === 'POST' && SAVES.test(new URL(request.url()).pathname)) legacy.push(request.url());
    });
  };
  const abortStagedRetry = async (errorCode: 'failed' | 'connectionreset' | 'connectionclosed' = 'failed') => {
    const route = stagedRoute;
    const target = stagedPage;
    stagedRoute = undefined;
    stagedPage = undefined;
    if (!route) return;
    try {
      await route.abort(errorCode);
    } catch (error) {
      // Navigation and page close can terminate a route before its explicit abort runs.
      // Preserve the lifecycle state in that case; an open page must still surface a real
      // route-lifecycle failure instead of silently losing the staged request.
      if (target && !target.isClosed()) throw error;
    }
  };
  const forward = async (route: Route, request: Request, identity: Gate5CommitIdentity) => {
    const response = await route.fetch({ maxRetries: 0 });
    const post: CommitPost = {
      method: request.method(), path: new URL(request.url()).pathname.replace(/^\/api\/runtime/, ''),
      body: request.postData()!, key: request.headers()['idempotency-key'],
      status: response.status(), response: await response.json(),
    };
    posts.push(post);
    forwarded.push({ identity, response: post.response });
    if (stagedRetries.length > 0 && sameGate5CommitIdentity(identity, stagedRetries[0])) recoveryForwarded = true;
    if (posts.length === 1) held = route;
    else await route.fulfill({ response });
  };
  const releaseStagedRetry = async () => {
    const route = stagedRoute;
    const target = stagedPage;
    if (!route || !target || target.isClosed()) throw new Error('Gate5 fault control has no staged retry to release');
    stagedRoute = undefined;
    stagedPage = undefined;
    recoveryRetryArmed = false;
    await forward(route, route.request(), {
      body: route.request().postData()!, key: route.request().headers()['idempotency-key'],
    });
  };
  const intercept = async (target: Page, route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const identity: Gate5CommitIdentity = { body: request.postData()!, key: request.headers()['idempotency-key'] };
    if (observed.length >= MAX_OBSERVED_ATTEMPTS) {
      await route.abort('failed');
      throw new Error(`Gate5 fault control observed more than ${MAX_OBSERVED_ATTEMPTS} commit POST attempts`);
    }
    observed.push(identity);
    observedUrls.push(request.url());
    if (recoveryRetryArmed && stagedRetries.length > 0 && !recoveryForwarded
      && sameGate5CommitIdentity(identity, stagedRetries[0])) {
      if (stagedRoute) {
        await route.abort('failed');
        throw new Error('Gate5 fault control already has a staged automatic retry');
      }
      stagedRoute = route;
      stagedPage = target;
      return;
    }
    const action = classifyGate5FaultOrder({ initial, candidate: identity,
      automaticRetryStaged: stagedRetries.length > 0, recoveryForwarded });
    if (action === 'reject-unexpected-duplicate' || action === 'reject-early-dependent') {
      await route.abort('failed');
      throw new Error(`Gate5 fault control refused ${action === 'reject-early-dependent' ? 'early dependent or mismatching' : 'unexpected duplicate exact'} request`);
    }
    if (action === 'stage-automatic-retry') {
      if (stagedRoute) {
        await route.abort('failed');
        throw new Error('Gate5 fault control already has a staged automatic retry');
      }
      stagedRetries.push(identity);
      stagedRoute = route;
      stagedPage = target;
      stagedResolve();
      return;
    }
    if (!initial) initial = identity;
    if (stagedRoute && stagedRetries.length > 0 && sameGate5CommitIdentity(identity, stagedRetries[0])) await abortStagedRetry();
    await forward(route, request, identity);
  };
  const attach = async (target: Page) => {
    if (stagedPage && stagedPage !== target) await abortStagedRetry('connectionclosed');
    observe(target);
    target.once('close', () => { void abortStagedRetry('connectionclosed'); });
    target.on('requestfailed', (request) => {
      if (stagedRoute?.request() === request) {
        stagedRoute = undefined;
        stagedPage = undefined;
      }
    });
    await target.route(COMMITS, (route) => intercept(target, route));
  };
  const waitForStagedRetry = async () => {
    if (stagedRetries.length === 0) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Automatic A retry was not staged')), CEILING.timeout);
      void stagedReady.then(() => { clearTimeout(timer); resolve(); });
    });
    return stagedRetries[0];
  };
  await attach(page);
  return {
    posts, forwarded, observed, stagedRetries, legacy, attach, observedUrls,
    get attempts() { return observed.length; },
    get forwardedAttempts() { return posts.length; },
    waitForStagedRetry,
    releaseStagedRetry,
    abortStagedRetry,
    armRecoveryRetry() { recoveryRetryArmed = true; },
    async loseAck() {
      if (!held) throw new Error('No durably accepted response to lose');
      await held.abort('connectionreset');
      held = undefined;
      await waitForStagedRetry();
    },
  };
}

function accepted(post: CommitPost): CommitAcceptedMutation {
  expect(post.status, JSON.stringify(post.response)).toBe(200);
  expect(post.response.data.status).toMatch(/^(accepted|rebased|merged)$/);
  expect(post.response.receipt.receipt_id).toBeTruthy();
  expect(post.response.receipt.result).toEqual(post.response.data);
  return post.response as CommitAcceptedMutation;
}

const pinOf = (result: CommitAcceptedMutation): HeadPin => ({
  revision_id: result.data.accepted_revision_id, publication_id: result.receipt.receipt_id as string,
});
const commandsOf = (payload: unknown) => (payload as { commands: EditCommand[] }).commands;
const position = (document: CanonicalDocument, clipId: string) =>
  (document.parent_revision.payload.clips as Array<{ id: string; at: number }>).find((clip) => clip.id === clipId)!.at;

async function history(harness: DirectHarness, seed: ThreeProductsSeed, scope: TimelineScope = {
  projectId: harness.seed.projectId, timelineId: seed.timelineId,
}): Promise<HistoryPage> {
  const items: HistoryEntry[] = [];
  let cursor: string | null = null;
  let head!: HeadPin;
  do {
    const response = await harness.runtimeJson<HistoryPage>('GET', `${timelineBase(harness, seed, scope)}/commits?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    items.push(...response.body.items);
    cursor = response.body.next_cursor;
    if (head) expect(response.body.head).toEqual(head);
    else head = response.body.head;
  } while (cursor);
  return { items, head, next_cursor: null };
}

/** The v2 commit envelope and the authenticated /commits projection must agree. */
function expectRecordedDocumentPatchCommand(recorded: EditCommand | undefined, submitted: EditCommand, clipId: string): void {
  expect(recorded).toBeTruthy();
  const command = recorded as EditCommand;
  const address = `parent/clip:${clipId}::at`;
  expect(Object.keys(submitted).sort()).toEqual(['args', 'created', 'op', 'schema_version', 'select', 'version']);
  expect(Object.keys(command).sort()).toEqual([
    'args', 'authorship', 'bindings', 'created', 'expect', 'intent', 'op', 'reads', 'resolved',
    'schema_version', 'select', 'selections', 'version',
  ]);
  expect(command).toEqual({
    ...submitted,
    authorship: { [address]: 'direct' },
    bindings: {},
    expect: { [address]: { state: 'present', value: 5 } },
    intent: {},
    reads: [{ ref: `parent/clip:${clipId}`, path: ['at'], state: { state: 'present', value: 5 } }],
    resolved: [],
    selections: [],
  });
}

async function expectV2History(harness: DirectHarness, seed: ThreeProductsSeed, post: CommitPost,
  expectedStatus: 'accepted' | 'merged', expectedUndoOf: string[] = []) {
  const request = JSON.parse(post.body) as CommitRequest;
  const requestObject = request as unknown as Record<string, unknown>;
  const result = post.response as CommitAcceptedMutation;
  const data = result.data;
  expect(post.path).toBe(`${timelineBase(harness, seed)}/commit`);
  expect(post.key).toBeTruthy();
  expect(request).toMatchObject({
    api_version: 1,
    project_id: harness.seed.projectId,
    timeline_id: seed.timelineId,
    base_revision_id: expect.any(String),
    base_publication_id: expect.any(String),
    commands: expect.any(Array),
    label: expect.any(String),
    steps: [expect.objectContaining({
      id: expect.any(String), label: expect.any(String), intent: expect.any(String), tags: expect.any(Array),
      command_ordinals: [0], patch: expect.any(Array),
    })],
    merge: expect.stringMatching(/^(fields|atomic)$/),
    dry_run: false,
  });
  expect(request.steps).toHaveLength(request.commands.length);
  expect(data).toMatchObject({
    status: expectedStatus,
    base_revision_id: request.base_revision_id,
    base_publication_id: request.base_publication_id,
    previous_revision_id: expect.any(String),
    previous_publication_id: expect.any(String),
    accepted_revision_id: expect.any(String),
    canonical_document: {
      schema_version: 1,
      project_id: request.project_id,
      timeline_id: request.timeline_id,
      parent_revision: { revision_id: data.accepted_revision_id },
    },
    document_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    commands: request.commands,
    id_map: expect.any(Object),
    provider_version: expect.any(String),
    compiler_version: expect.any(String),
    merge_mode: expect.stringMatching(/^(fields|atomic)$/),
    steps: [expect.objectContaining({
      id: request.steps![0].id,
      label: request.steps![0].label,
      intent: request.steps![0].intent,
      tags: request.steps![0].tags,
      command_ordinals: [0],
      patch: expect.any(Array),
      dependencies: expect.any(Array),
    })],
    publisher: expect.any(String),
  });
  const effectiveMerge = request.merge === 'atomic'
    || (!Object.hasOwn(requestObject, 'reads') && request.commands.some((command) => command.op === 'doc.patch'))
    ? 'atomic' : (request.merge ?? 'fields');
  expect(data.merge_mode).toBe(effectiveMerge);
  expect(data.label).toBe(request.label);
  expect(data.document_digest).toBe(sha256Hex(Buffer.from(canonical(data.canonical_document))));
  expect(data.rebased_onto).toEqual(expectedStatus === 'accepted'
    ? null
    : { revision_id: data.previous_revision_id, publication_id: data.previous_publication_id });
  if (expectedStatus === 'accepted') expect({ revision_id: data.previous_revision_id, publication_id: data.previous_publication_id })
    .toEqual({ revision_id: request.base_revision_id, publication_id: request.base_publication_id });
  else expect({ revision_id: data.previous_revision_id, publication_id: data.previous_publication_id })
    .not.toEqual({ revision_id: request.base_revision_id, publication_id: request.base_publication_id });
  expect(result.receipt).toMatchObject({
    command_kind: 'timeline.commit',
    idempotency_key: post.key,
    project_id: request.project_id,
    result: data,
  });
  expect(result.receipt.result).toEqual(data);

  const page = await history(harness, seed);
  const entry = page.items.find((candidate) => candidate.publication_id === result.receipt.receipt_id);
  expect(entry, 'accepted publication must have an authoritative /commits entry').toBeTruthy();
  expect(entry).toMatchObject({
    publication_id: result.receipt.receipt_id,
    revision_id: data.accepted_revision_id,
    previous: { revision_id: data.previous_revision_id, publication_id: data.previous_publication_id },
    receipt: result.receipt,
    intent: 'recorded',
    provider_version: data.provider_version,
    compiler_version: data.compiler_version,
    merge: request.merge,
    merge_mode: data.merge_mode,
    steps: data.steps,
    publisher: data.publisher,
    label: data.label,
    records: {
      schema_version: 1,
      label: data.label,
      merge_mode: data.merge_mode,
      steps: data.steps,
      commands: expect.any(Array),
      undo_of: expectedUndoOf,
      restored_from: null,
    },
  });
  const records = entry!.records!;
  expect(data.commands).toEqual(records.commands.map((record) => record.command));
  const inputDocument = await canonicalDocumentAt(harness, seed, data.previous_revision_id);
  if (Object.hasOwn(requestObject, 'reads')) expect(entry).toHaveProperty('reads', request.reads);
  else expect(entry).not.toHaveProperty('reads');
  expect(entry!.steps).toEqual(data.steps);
  expect(records.steps).toEqual(data.steps);
  expect(records.commands).toHaveLength(request.commands.length);
  expect(data.steps).toHaveLength(request.steps!.length);
  for (const [index, submittedStep] of request.steps!.entries()) {
    const step = data.steps![index];
    const recordStep = records.steps![index];
    expect(step).toEqual(recordStep);
    expect(step).toEqual({ ...submittedStep, patch: step.patch, dependencies: step.dependencies });
    expect(step.command_ordinals).toEqual(submittedStep.command_ordinals);
    if (Object.hasOwn(submittedStep, 'reads')) expect(step).toHaveProperty('reads', submittedStep.reads);
    else expect(step).not.toHaveProperty('reads');

    const submittedPatch = submittedStep.command_ordinals.flatMap((ordinal) => {
      const command = request.commands[ordinal];
      return command.op === 'doc.patch' ? (command.args.changes as unknown[]) : [];
    });
    if (submittedStep.command_ordinals.every((ordinal) => request.commands[ordinal].op === 'doc.patch')) {
      expect(submittedStep.patch).toEqual(submittedPatch);
    }
    if (submittedPatch.length) {
      expect(records.commands.filter((record) => submittedStep.command_ordinals.includes(record.ordinal))
        .flatMap((record) => record.bindings.filter((binding) => binding.key.startsWith('doc.patch:'))
          .map((binding) => ({ ...binding.change, ref: binding.ref })))).toEqual(submittedPatch);
    }
    for (const claim of submittedStep.patch) {
      expect(step.patch.some((effect) => canonical({ ...effect, ...recordedSite(effect.ref, effect.path) })
        === canonical({ ...claim, ...recordedSite(claim.ref, claim.path) })),
      `step ${step.id} omits its submitted effect assertion`).toBe(true);
    }

    const dependencies = step.dependencies ?? [];
    const covers = (read: NonNullable<typeof step.dependencies>[number]) => dependencies.some((dependency) => {
      const site = recordedSite(read.ref, read.path);
      const candidate = recordedSite(dependency.ref, dependency.path);
      if (dependency.kind === 'scope') return dependency.path.length === 0
        && (dependency.ref === 'timeline' || candidate.ref === site.ref);
      return canonical({ ...dependency, ...candidate }) === canonical({ ...read, ...site });
    });
    for (const read of [...(request.reads ?? []), ...(submittedStep.reads ?? [])]) {
      expect(covers(read), `step ${step.id} omits declared ${canonical(read)}`).toBe(true);
    }

    for (const ordinal of step.command_ordinals) {
      const record = records.commands[ordinal];
      expect(record).toMatchObject({
        ordinal,
        command: request.commands[ordinal],
        writes: expect.any(Array),
        reads: expect.any(Array),
        selections: expect.any(Array),
        bindings: expect.any(Array),
        created: expect.any(Array),
        dependencies: expect.any(Array),
        derived_writes: expect.any(Array),
      });
      expect(record.command).toEqual(data.commands[ordinal]);
      if (record.command.op === 'clip.move') {
        for (const read of record.command.reads!) expect(record.reads).toContainEqual(read);
        expect(record.selections).toEqual(record.command.selections);
        for (const [key, ref] of Object.entries(record.command.bindings!)) {
          expect(record.bindings.filter((binding) => binding.key === key && binding.ref === ref)).toHaveLength(1);
        }
        expect(record.dependencies.map((dependency) => dependency.key).sort()).toEqual([
          'move.images', 'move.quantization',
          ...(record.reads.some((read) => read.ref === `${record.command.select!.split('/')[0]}/registry`) ? ['move.source'] : []),
        ].sort());
      }
      if (record.command.op === 'timeline.inverse') {
        expect(record.selections).toEqual(page.items.filter((item) => expectedUndoOf.includes(item.publication_id))
          .flatMap((item) => item.records!.commands.flatMap((command) => command.selections)));
      }
      for (const read of record.reads) {
        // Allocation absence is guarded by the authenticated created-ID record.
        if (read.state.state === 'absent' && record.created.some((created) => created.ref === read.ref)) continue;
        const site = recordedSite(read.ref, read.path);
        expect(covers(site.path.length && site.ref !== 'timeline'
          ? { kind: 'field', ...site, state: read.state }
          : { kind: 'scope', ...site }), `step ${step.id} omits captured ${canonical(read)}`).toBe(true);
      }
      for (const selected of record.selections) {
        if (selected.key === 'move.target') {
          // This native query selects the named entity, not the whole clip collection.
          expect(selected.members).toEqual(selected.order);
          expect(selected.boundaries).toEqual(selected.order);
          for (const ref of selected.members) {
            const identity = record.reads.find((read) => read.ref === ref && canonical(read.path) === '["id"]');
            expect(identity, `selection ${selected.key} needs its observed identity`).toBeTruthy();
            expect(covers({ kind: 'field', ref, path: ['id'], state: identity!.state })).toBe(true);
          }
        } else {
          // Other native selections must retain collection shape or a conservative scope.
          const kind = selected.key === 'track.create' ? 'track'
            : selected.key.match(/^collection\.(clips|tracks|occurrences)(?:\.after)?$/)?.[1].slice(0, -1);
          if (kind) {
            const collection = recordedSite(`${selected.owner}/collection:${kind}`, []);
            const ids = (refs: string[]) => refs.map((ref) => ref.slice(ref.indexOf(`${kind}:`) + kind.length + 1));
            expect(covers({ kind: 'collection', ...collection, members: ids(selected.order).sort(), order: ids(selected.order) }),
              `step ${step.id} omits selection ${canonical(selected)}`).toBe(true);
          } else expect(covers({ kind: 'scope', ...recordedSite(selected.owner, []) }),
            `unbounded selection ${canonical(selected)} requires its owner scope`).toBe(true);
        }
      }
      for (const binding of record.bindings) {
        if (binding.key === 'inverse.stage') {
          const target = page.items.find((item) => item.publication_id === binding.boundary?.publication_id);
          const targetStep = target?.steps?.find((item) => item.id === binding.boundary?.step_id);
          expect(targetStep, 'inverse segments name an authenticated target step').toBeTruthy();
          expect(binding.boundary?.command_ordinals).toEqual(targetStep!.command_ordinals);
        } else {
          expect(binding.boundary).toMatchObject({
            base_revision_id: request.base_revision_id, base_publication_id: request.base_publication_id,
            evaluated_head: { revision_id: data.previous_revision_id, publication_id: data.previous_publication_id },
            step_id: step.id, command_ordinal: ordinal,
          });
          expect(binding.physical_ref).toBeTruthy();
          if (binding.key === 'commit.effect') {
            expect(binding.boundary?.phase).toBe('effect');
            expect(['before', 'after']).toContain(binding.boundary?.side);
          } else if (binding.key === 'commit.read' && binding.boundary?.phase === 'batch-read') {
            expect(ordinal).toBe(0);
            expect(request.reads?.length).toBeGreaterThan(0);
          } else expect(binding.boundary?.phase).toBe('input');
          const document = binding.boundary?.side === 'after' ? data.canonical_document : inputDocument;
          const image = binding.physical_ref === 'parent' ? document.parent_revision
            : document.shot_revisions.find((candidate) => binding.physical_ref === `shot-revision:${candidate.revision_id}`)
              ?? document.internal_timeline_revisions.find((candidate) => binding.physical_ref === `internal-revision:${candidate.revision_id}`);
          expect(image, `binding ${binding.key} names a physical boundary image`).toBeTruthy();
          expect(binding.revision_id).toBe(image!.revision_id);
          expect(binding.content_digest).toBe(image!.content_digest);
          if (binding.dependency) expect(covers(binding.dependency)).toBe(true);
          if (binding.key === 'commit.atomic') expect(covers({ kind: 'scope', ref: binding.physical_ref!, path: [] })).toBe(true);
          if (binding.key === 'commit.effect') {
            expect(binding.step_id).toBe(step.id);
            expect(binding.ref).toBe(step.patch[binding.effect_ordinal!].ref);
            expect(binding.path).toEqual(step.patch[binding.effect_ordinal!].path);
          }
        }
        for (const key of binding.dependencies) {
          expect(record.dependencies.filter((dependency) => dependency.key === key),
            `binding ${binding.key} must retain its complete dependency pin`).toHaveLength(1);
        }
      }
      for (const dependency of record.dependencies) {
        const consumers = record.bindings.filter((binding) => binding.dependencies.includes(dependency.key));
        expect(consumers, `orphan recorder dependency ${canonical(dependency)}`).not.toHaveLength(0);
        if (dependency.key === 'move.images') {
          expect(dependency).toEqual({ key: dependency.key, kind: 'entity', policy: 'exact', pin: { parent: {
            revision_id: inputDocument.parent_revision.revision_id,
            content_digest: inputDocument.parent_revision.content_digest,
          } } });
        } else if (dependency.key === 'move.quantization') {
          const fps = record.reads.find((read) => read.ref === 'parent' && canonical(read.path) === '["config","output","fps"]');
          expect(fps?.state.state).toBe('present');
          const value = fps!.state.state === 'present' ? fps!.state.value : undefined;
          const rate = typeof value === 'number' ? { numerator: value, denominator: 1 }
            : value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
          expect(rate, 'quantization retains the observed numeric or rational frame rate').toBeTruthy();
          expect(dependency).toEqual({ key: dependency.key, kind: 'time-map', policy: 'exact', pin: {
            ...rate,
            rounding: 'half-toward-positive-infinity',
          } });
        } else if (dependency.key === 'move.source') {
          const { ref, asset } = dependency.pin;
          expect(typeof ref).toBe('string');
          expect(typeof asset).toBe('string');
          expect(ref).toBe(`${record.command.select!.split('/')[0]}/registry`);
          const selectedAsset = record.reads.find((read) => read.ref === record.command.select && canonical(read.path) === '["asset"]');
          expect(selectedAsset?.state).toEqual({ state: 'present', value: asset });
          const observed = Object.fromEntries(record.reads.filter((read) => read.ref === ref
            && read.path[0] === 'assets' && read.path[1] === asset)
            .map((read) => [read.path[2], read.state.state === 'present' ? read.state.value : null]));
          expect(dependency).toEqual({ key: dependency.key, kind: 'entity', policy: 'exact', pin: { ref, asset, source: observed } });
        } else {
          for (const consumer of consumers) expect(covers({ kind: 'scope', ref: consumer.physical_ref!, path: [] }),
            `opaque pin ${dependency.key} requires a conservative dependency scope`).toBe(true);
        }
      }
      for (const write of [...record.writes, ...record.derived_writes]) {
        const refAndPath = recordedSite(write.ref, write.path);
        // Redundant native clears have no effect, but retain their exact guards.
        if (canonical(write.before) === canonical(write.after)) {
          expect(covers({ kind: 'field', ...refAndPath, state: write.before })).toBe(true);
          continue;
        }
        if (write.ref === 'parent' && canonical(write.path) === '["config","clips"]'
          && record.derived_writes.some((derived) => derived === write)) {
          // The recorder's whole-array mirror accompanies the native leaf writes.
          expect(write.before).toEqual({ state: 'present', value: inputDocument.parent_revision.payload.clips });
          expect(write.after).toEqual({ state: 'present', value: data.canonical_document.parent_revision.payload.clips });
          expect(record.writes.some((authored) => authored.ref.startsWith('parent/clip:'))).toBe(true);
          continue;
        }
        const matchingEffects = step.patch.filter((effect) => canonical(recordedSite(effect.ref, effect.path)) === canonical(refAndPath)
          && canonical(effect.before) === canonical(write.before));
        expect(matchingEffects, `step ${step.id} omits captured ${write.ref}:${write.path.join('.')}`).not.toHaveLength(0);
        expect(matchingEffects.some((effect) => write.after.state === 'absent'
          ? effect.op === 'remove'
          : effect.op === 'set' && canonical(effect.value) === canonical(write.after.value))).toBe(true);
      }
    }
  }
  if (expectedUndoOf.length) expect(records.undo_steps).toBeNull();
  return entry!;
}

/** Normalize native recorder aliases to the physical paths used by authoritative effects. */
function recordedSite(ref: string, path: string[]): { ref: string; path: string[] } {
  const match = ref.match(/^parent\/(clip|track):(.+)$/);
  if (match) return recordedSite('parent', ['config', `${match[1]}s`, `id:${match[2]}`, ...path]);
  if (ref === 'parent/source') return recordedSite('parent', ['config', ...path]);
  if (ref === 'parent/registry') return recordedSite('parent', ['registry', ...path]);
  if (ref.startsWith('parent/asset:')) return recordedSite('parent', ['registry', 'assets', ref.slice('parent/asset:'.length), ...path]);
  const collection = ref.match(/^parent\/collection:(clip|track|occurrence)$/);
  if (collection) return recordedSite('parent', collection[1] === 'occurrence' ? ['occurrences', ...path] : ['config', `${collection[1]}s`, ...path]);
  if (ref === 'parent' && path[0] === 'config' && ['clips', 'registry'].includes(path[1])) return { ref, path: path.slice(1) };
  return { ref, path };
}

async function expectImmutableClosure(harness: DirectHarness, seed: ThreeProductsSeed, result: CommitAcceptedMutation) {
  const document = result.data.canonical_document;
  const parent = await revisionBody(harness, document.parent_revision.revision_id);
  expect(parent.payload).toEqual(document.parent_revision.payload);
  expect(parent.content_digest).toBe(document.parent_revision.content_digest);
  for (const shot of document.shot_revisions) {
    const response = await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}/shots/${shot.shot_id}/revisions/${shot.revision_id}`);
    expect(response.status).toBe(200);
    expect(response.body.content_digest).toBe(shot.content_digest);
    expect(response.body.payload).toEqual(shot.payload);
    expect(response.body.internal_timeline_revision_id).toBe(shot.internal_timeline_revision_id);
  }
  for (const inner of document.internal_timeline_revisions) {
    const response = await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}/timelines/${inner.timeline_id}/revisions/${inner.revision_id}`);
    expect(response.status).toBe(200);
    expect(response.body.content_digest).toBe(inner.content_digest);
    expect(response.body.payload).toEqual(inner.payload);
  }
  const entry = (await history(harness, seed)).items.find((item) => item.publication_id === result.receipt.receipt_id);
  expect(entry?.receipt).toEqual(result.receipt);
  expect(entry?.revision_id).toBe(document.parent_revision.revision_id);
}

async function ownerWithTwoMoves(page: Page, seed: ThreeProductsSeed) {
  await expect.poll(async () => (await commandOutboxes(page, seed.timelineId)).some((owner) => owner.intents.length === 2), CEILING).toBe(true);
  const owner = (await commandOutboxes(page, seed.timelineId)).find((candidate) => candidate.intents.length === 2)!;
  expect(owner.pending?.request).toBeTruthy();
  expect(owner.intents[1].basis).toEqual({ after: owner.intents[0].id });
  expect(owner.intents[1].readyBase, 'dependent B has never been sent').toBeUndefined();
  const commands = commandsOf(owner.intents[1].payload);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ op: 'clip.move', select: `parent/clip:${seed.appClipId}`, args: { on: 7 } });
  expect(commands[0].reads?.find((read) => read.ref === `parent/clip:${seed.appClipId}` && canonical(read.path) === '["at"]')?.state)
    .toEqual({ state: 'present', value: 5 });
  expect(commands[0].expect && Object.keys(commands[0].expect).length).toBeGreaterThan(0);
  expect(commands[0].bindings && Object.keys(commands[0].bindings).length).toBeGreaterThan(0);
  return owner;
}

type MountedDocumentIntent = {
  basis: unknown;
  before: CanonicalDocument;
  after: CanonicalDocument;
  label: string;
  step: { id: string; label: string; intent: string; tags: string[]; reads?: unknown[] };
  changes: Array<Record<string, unknown>>;
  merge?: 'fields' | 'atomic';
  reads?: unknown[];
};

/** The mounted editor persists its original document intent before Runtime records authoritative effects. */
function mountedDocumentIntentOf(payload: unknown): MountedDocumentIntent {
  const intent = (payload as { documentIntent?: unknown }).documentIntent;
  expect(intent).toMatchObject({
    kind: 'document-patch-intent',
    basis: expect.any(Object),
    before: expect.any(Object),
    after: expect.any(Object),
    step: { id: expect.any(String), label: expect.any(String), intent: expect.any(String), tags: expect.any(Array) },
    changes: expect.any(Array),
  });
  return intent as MountedDocumentIntent;
}

async function ownerWithTwoMountedDocuments(page: Page, seed: ThreeProductsSeed) {
  await expect.poll(async () => (await commandOutboxes(page, seed.timelineId)).some((owner) => owner.intents.length === 2), CEILING).toBe(true);
  const owner = (await commandOutboxes(page, seed.timelineId)).find((candidate) => candidate.intents.length === 2)!;
  expect(owner.pending?.request).toBeTruthy();
  expect(owner.intents[1].basis).toEqual({ after: owner.intents[0].id });
  expect(owner.intents[1].readyBase, 'dependent B has never been sent').toBeUndefined();
  const first = mountedDocumentIntentOf(owner.intents[0].payload);
  const second = mountedDocumentIntentOf(owner.intents[1].payload);
  expect(second.basis).toEqual({ after: owner.intents[0].id });
  expect(second.before).toEqual(first.after);
  expect(position(second.before, seed.appClipId)).toBe(5);
  expect(position(second.after, seed.appClipId)).toBe(7);
  expect(second.changes).toEqual([{
    op: 'set', ref: 'parent', path: ['clips', `id:${seed.appClipId}`, 'at'],
    before: { state: 'present', value: 5 }, value: 7,
  }]);
  expect(second.step).toMatchObject({ label: second.label, intent: `Move ${seed.appClipId} on V1`, tags: [] });
  return owner;
}

async function openCommandTimeline(page: Page, harness: DirectHarness, seed: ThreeProductsSeed) {
  // A case selected alone must establish its own verified authoring baseline.
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  // The hosted blank page establishes the storage origin without mounting an
  // editor or claiming an owner, including on an ordinary fresh Playwright page.
  await page.goto(`${harness.origin}/__blank.html`);
  const previous = await commandOutboxes(page, seed.timelineId);
  await openApp(page, harness);
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  // Loading the canvas can finish before immutable reads and the native owner claim.
  await expect.poll(async () => ({
    ready: (await commandOutboxes(page, seed.timelineId)).filter((owner) =>
      owner.scope.projectId === harness.seed.projectId && owner.scope.timelineId === seed.timelineId
        && !previous.some((old) => old.ownerId === owner.ownerId) && !owner.pending && !owner.intents.length).length === 1,
    notice: await page.getByTestId('timeline-command-recovery').allTextContents(),
  }), { ...CEILING, message: 'the mounted editor must claim a new durable command owner before the gesture' }).toMatchObject({ ready: true });
  const fresh = (await commandOutboxes(page, seed.timelineId)).filter((owner) =>
    owner.scope.projectId === harness.seed.projectId && owner.scope.timelineId === seed.timelineId
      && !previous.some((old) => old.ownerId === owner.ownerId) && !owner.pending && !owner.intents.length);
  expect(fresh, 'exactly one fresh scoped owner must have been claimed').toHaveLength(1);
  return { ownerId: fresh[0].ownerId, scope: fresh[0].scope };
}

async function prepareDependentMoves(page: Page, harness: DirectHarness, seed: ThreeProductsSeed, beforeBDrop?: (a: CommitAcceptedMutation) => Promise<void>) {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  const wire = await faultFirstCommit(page);
  await openCommandTimeline(page, harness, seed);
  const before = await history(harness, seed);
  await dragTimelineClip(page, seed.appClipId, seed.transitionClipId, 0, 5, THREE_PRODUCTS_REFERENCE_AT, () => {
    expect(wire.attempts, 'pointer movement previews; the actual drop commits').toBe(0);
  });
  await expect.poll(() => wire.posts.length, CEILING).toBe(1);
  const a = accepted(wire.posts[0]);
  const bodyA = JSON.parse(wire.posts[0].body) as CommitRequest;
  expect(bodyA).toMatchObject({ base_revision_id: before.head.revision_id, base_publication_id: before.head.publication_id,
    commands: [{ op: 'clip.move', select: `parent/clip:${seed.appClipId}`, args: { on: 5 } }] });
  expect(position(a.data.canonical_document, seed.appClipId)).toBe(5);
  expect((await history(harness, seed)).head.revision_id).toBe(pinOf(a).revision_id);
  // The second pointerdown observes the actual optimistic authored bundle A.
  await dragTimelineClip(page, seed.appClipId, seed.transitionClipId, 5, 7, THREE_PRODUCTS_REFERENCE_AT, async () => {
    expect(wire.attempts, 'B stays unsent behind unacknowledged A').toBe(1);
    await beforeBDrop?.(a);
  });
  const owner = await ownerWithTwoMoves(page, seed);
  expect(owner.scope).toEqual({ realmId: harness.realmId, actorId: a.data.publisher, projectId: harness.seed.projectId, timelineId: seed.timelineId });
  expect(owner.pending!.request).toEqual({ method: 'POST', path: `${timelineBase(harness, seed)}/commit`,
    body: wire.posts[0].body, key: wire.posts[0].key });
  expect(wire.posts).toHaveLength(1);
  return { wire, before, a, owner };
}

type CommandWire = Awaited<ReturnType<typeof faultFirstCommit>>;

async function prepareAfterAckLossMoves(page: Page, harness: DirectHarness, seed: ThreeProductsSeed,
  ackLostFirst?: (a: CommitAcceptedMutation, wire: CommandWire) => Promise<void>) {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  const wire = await faultFirstCommit(page);
  await openCommandTimeline(page, harness, seed);
  const before = await history(harness, seed);
  await dragTimelineClip(page, seed.appClipId, seed.transitionClipId, 0, 5, THREE_PRODUCTS_REFERENCE_AT, () => {
    expect(wire.attempts, 'pointer movement previews; the actual drop commits').toBe(0);
  });
  await expect.poll(() => wire.posts.length, CEILING).toBe(1);
  const a = accepted(wire.posts[0]);
  const bodyA = JSON.parse(wire.posts[0].body) as CommitRequest;
  expect(bodyA).toMatchObject({ base_revision_id: before.head.revision_id, base_publication_id: before.head.publication_id,
    commands: [{ op: 'clip.move', select: `parent/clip:${seed.appClipId}`, args: { on: 5 } }] });
  expect(position(a.data.canonical_document, seed.appClipId)).toBe(5);
  expect((await history(harness, seed)).head.revision_id).toBe(pinOf(a).revision_id);
  await ackLostFirst?.(a, wire);
  // The second pointerdown observes the actual optimistic authored bundle A.
  await dragTimelineClip(page, seed.appClipId, seed.transitionClipId, 5, 7, THREE_PRODUCTS_REFERENCE_AT, async () => {
    expect(wire.attempts, 'B stays unsent behind unacknowledged A').toBe(1);
  });
  const owner = await ownerWithTwoMoves(page, seed);
  expect(owner.scope).toEqual({ realmId: harness.realmId, actorId: a.data.publisher, projectId: harness.seed.projectId, timelineId: seed.timelineId });
  expect(owner.pending!.request).toEqual({ method: 'POST', path: `${timelineBase(harness, seed)}/commit`,
    body: wire.posts[0].body, key: wire.posts[0].key });
  expect(wire.posts).toHaveLength(1);
  return { wire, before, a, owner };
}

async function prepareAfterAckLossMountedDocuments(page: Page, harness: DirectHarness, seed: ThreeProductsSeed,
  ackLostFirst?: (a: CommitAcceptedMutation, wire: CommandWire) => Promise<void>) {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  const wire = await faultFirstCommit(page);
  await openCommandTimeline(page, harness, seed);
  const before = await history(harness, seed);
  await dragTimelineClip(page, seed.appClipId, seed.transitionClipId, 0, 5, THREE_PRODUCTS_REFERENCE_AT, () => {
    expect(wire.attempts, 'pointer movement previews; the actual drop commits').toBe(0);
  });
  await expect.poll(() => wire.posts.length, CEILING).toBe(1);
  const a = accepted(wire.posts[0]);
  const bodyA = JSON.parse(wire.posts[0].body) as CommitRequest;
  expect(bodyA).toMatchObject({ base_revision_id: before.head.revision_id, base_publication_id: before.head.publication_id,
    commands: [{ op: 'doc.patch', select: null, args: { changes: expect.any(Array) } }] });
  expect(position(a.data.canonical_document, seed.appClipId)).toBe(5);
  expect((await history(harness, seed)).head.revision_id).toBe(pinOf(a).revision_id);
  await ackLostFirst?.(a, wire);
  await dragTimelineClip(page, seed.appClipId, seed.transitionClipId, 5, 7, THREE_PRODUCTS_REFERENCE_AT, async () => {
    expect(wire.observed).toHaveLength(2);
    expect(wire.observed[1]).toEqual(wire.observed[0]);
    expect(wire.forwarded).toHaveLength(1);
    expect(wire.forwarded[0].identity).toEqual(wire.observed[0]);
    expect(wire.observed.every((identity) => sameGate5CommitIdentity(identity, wire.observed[0]))).toBe(true);
  });
  const owner = await ownerWithTwoMountedDocuments(page, seed);
  expect(owner.scope).toEqual({ realmId: harness.realmId, actorId: a.data.publisher, projectId: harness.seed.projectId, timelineId: seed.timelineId });
  expect(owner.pending!.request).toEqual({ method: 'POST', path: `${timelineBase(harness, seed)}/commit`,
    body: wire.posts[0].body, key: wire.posts[0].key });
  expect(wire.posts).toHaveLength(1);
  return { wire, before, a, owner };
}

async function expectAgentRevision(astrid: AstridCli, harness: DirectHarness, seed: ThreeProductsSeed, revision: string) {
  const shown = await astrid.json<{ revision_id: string }>(['timelines', 'show', seed.timelineId,
    '--project', seed.projectSlug, '--revision-id', revision, '--json']);
  expect(shown.ok, JSON.stringify(shown)).toBe(true);
  expect(shown.data?.revision_id).toBe(revision);
  const visualized = await astrid.json<{ outputs: { inspection: { revision_id: string }; evidence_kind: string;
    render_requested: boolean; artifacts: { md: { object_id: string } } } }>(['timelines', 'visualize', seed.timelineId,
    '--project', seed.projectSlug, '--revision-id', revision, '--mode', 'inputs', '--format', 'md', '--json']);
  expect(visualized.ok, JSON.stringify(visualized)).toBe(true);
  const outputs = visualized.data!.outputs;
  expect(outputs.inspection.revision_id).toBe(revision);
  expect(outputs.evidence_kind).toBe('declared_inputs');
  expect(outputs.render_requested).toBe(false);
  const artifact = await harness.runtimeFetch(`/v1/objects/${encodeURIComponent(outputs.artifacts.md.object_id)}`);
  expect(artifact.status).toBe(200);
  const markdown = await artifact.text();
  expect(markdown).toContain(`Parent revision: ${revision}`);
  expect(markdown).toContain('Source pixels, waveforms, and rendered output were not inspected.');
  journey.facts.visualize = { revision, mode: 'inputs', renderer: 'not started', composedPixels: 'not run' };
}

async function expectPreviewRevision(page: Page, revision: string) {
  const label = page.getByTestId('preview-revision-label').filter({ hasText: `Committed ${revision}` })
    .or(page.getByTestId('preview-revision-unavailable').filter({ hasText: `Preview of ${revision} unavailable` }));
  await expect(label.first()).toBeVisible(CEILING);
  journey.facts.previewLabel = await label.first().innerText();
}

async function expectFreshPreviewUnavailable(page: Page, astrid: AstridCli, harness: DirectHarness,
  seed: ThreeProductsSeed, retainedRevision: string) {
  // Keep the already-delivered revision readable while the next real Runtime
  // head is observed. The failed fresh read exercises the production preview
  // boundary: cached pixels stay labelled, but the new target is unavailable.
  await page.route(/\/timelines\/[^/]+\/composition-revisions\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const revision = new URL(route.request().url()).pathname.split('/').pop();
    if (revision === retainedRevision) return route.fallback();
    return route.abort('failed');
  });
  try {
    const retained = (await history(harness, seed)).head;
    expect(retained.revision_id).toBe(retainedRevision);
    const target = await astrid.commitCaptured(harness.seed.projectId, seed.timelineId,
      { revision_id: retainedRevision, publication_id: retained.publication_id },
      { kind: 'track', id: 'f2-gate3-preview-unavailable' }, 'f2-gate3-preview-unavailable');
    const targetRevision = target.data.accepted_revision_id;
    await expect(page.getByTestId('preview-revision-label')).toHaveText(`Committed ${retainedRevision}`, CEILING);
    await expect(page.getByTestId('preview-revision-unavailable'))
      .toHaveText('Preview target unavailable', CEILING);
    return targetRevision;
  } finally {
    await page.unroute(/\/timelines\/[^/]+\/composition-revisions\/[^/]+$/);
  }
}

test('M1 real gesture: lost durable ACK, dependent B, reopen, Runtime restart, exact retry and UI undo preserve independent Agent work', async ({ page, context, harness, astrid, seed3 }) => {
  const sniff = new TokenSniff(secretsOf(harness, astrid));
  sniff.attach(page);
  const { wire, before, a, owner } = await prepareDependentMoves(page, harness, seed3);
  const realmBefore = await expectSameRealm(page, harness, astrid);
  // track.create is the supported structural proof; it does not alter the moved clip or its lane.
  const c = await astrid.commitCaptured(harness.seed.projectId, seed3.timelineId, pinOf(a), { kind: 'track', id: 'f2-independent-C' }, 'f2-independent-C');
  expect(c.data.publisher).not.toBe(a.data.publisher);
  expect(position(c.data.canonical_document, seed3.appClipId)).toBe(5);
  await wire.loseAck();
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).find((item) => item.ownerId === owner.ownerId)?.pending?.outcome?.kind, CEILING).toBe('retry');
  await page.reload();
  await expectConnected(page);
  const afterReload = (await commandOutboxes(page, seed3.timelineId)).find((item) => item.ownerId === owner.ownerId)!;
  expect(afterReload.pending?.request).toEqual(owner.pending!.request);
  expect(afterReload.intents).toEqual(owner.intents);
  expect(wire.posts, 'reload requires explicit owner recovery before retry').toHaveLength(1);
  await page.close();

  const restarted = await harness.restartRuntime();
  expect(restarted.oldInstanceId).toBe(realmBefore.runtimeInstanceId);
  expect(harness.runtimeInstanceId).not.toBe(restarted.oldInstanceId);
  expect(harness.realmId).toBe(realmBefore.realmId);
  const reopened = await context.newPage();
  sniff.attach(reopened);
  await wire.attach(reopened);
  await openApp(reopened, harness);
  await expectConnected(reopened);
  await openSeededTimeline(reopened, harness);
  const realmAfter = await expectSameRealm(reopened, harness, astrid);
  expect(realmAfter.realmId).toBe(realmBefore.realmId);
  expect(realmAfter.runtimeInstanceId).toBe(harness.runtimeInstanceId);
  expect(realmAfter.runtimeInstanceId).not.toBe(realmBefore.runtimeInstanceId);
  const persisted = (await commandOutboxes(reopened, seed3.timelineId)).find((item) => item.ownerId === owner.ownerId)!;
  expect(persisted.pending?.request).toEqual(owner.pending!.request);
  expect(persisted.intents).toEqual(owner.intents);
  expect(wire.posts).toHaveLength(1);
  // Recovery is an actual user action selecting the persisted owner, never a test command injection.
  await reopened.getByRole('button', { name: /^Recover saved edits/ })
    .and(reopened.locator(`[data-owner-id="${owner.ownerId}"]`)).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(3);
  expect(wire.posts[1]).toEqual(wire.posts[0]);
  const b = accepted(wire.posts[2]);
  expect(b.data.publisher).toBe(a.data.publisher);
  const requestB = JSON.parse(wire.posts[2].body) as CommitRequest;
  expect(wire.posts[2].key).not.toBe(wire.posts[0].key);
  expect(requestB).toMatchObject({ base_revision_id: pinOf(a).revision_id, base_publication_id: pinOf(a).publication_id });
  expect(requestB.commands, 'no rewritten original B claims, references or created IDs').toEqual(commandsOf(owner.intents[1].payload));
  expect(b.data.status).toBe('rebased');
  expect(b.data.previous_publication_id).toBe(pinOf(c).publication_id);
  expect(position(b.data.canonical_document, seed3.appClipId)).toBe(7);
  expect(b.data.canonical_document.parent_revision.payload.config).toMatchObject({ tracks: expect.arrayContaining([expect.objectContaining({ id: 'f2-independent-C', kind: 'audio', label: 'f2-independent-C' })]) });
  await expect.poll(async () => (await commandOutboxes(reopened, seed3.timelineId)).find((item) => item.ownerId === owner.ownerId)?.intents.length, CEILING).toBe(0);
  expect((await history(harness, seed3)).items).toHaveLength(before.items.length + 3);
  const recordedB = (await history(harness, seed3)).items.find((entry) => entry.publication_id === pinOf(b).publication_id)?.records;
  expect(recordedB?.commands[0].command).toEqual(requestB.commands[0]);
  expect(recordedB?.commands[0].writes.length).toBeGreaterThan(0);
  expect(recordedB?.commands[0].reads.length).toBeGreaterThan(0);
  expect(recordedB?.commands[0].bindings.length).toBeGreaterThan(0);
  await expectImmutableClosure(harness, seed3, a);
  await expectImmutableClosure(harness, seed3, c);
  await expectImmutableClosure(harness, seed3, b);
  await expectPreviewRevision(reopened, pinOf(b).revision_id);
  await expectAgentRevision(astrid, harness, seed3, pinOf(b).revision_id);

  // Undo the accepted B publication through the mounted App toolbar.
  const publication = pinOf(b).publication_id;
  let undone!: CommitAcceptedMutation;
  {
    const count = wire.posts.length;
    await reopened.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => wire.posts.length, CEILING).toBe(count + 1);
    const inversePost = wire.posts[count];
    expect((JSON.parse(inversePost.body) as CommitRequest).commands).toEqual([
      { schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: [publication] } },
    ]);
    const inverse = accepted(inversePost);
    expect(position(inverse.data.canonical_document, seed3.appClipId)).toBe(5);
    expect(inverse.data.canonical_document.parent_revision.payload, 'undo restores A exactly and keeps all of disjoint C')
      .toEqual(c.data.canonical_document.parent_revision.payload);
    expect(inverse.data.canonical_document.shot_revisions).toEqual(c.data.canonical_document.shot_revisions);
    expect(inverse.data.canonical_document.internal_timeline_revisions).toEqual(c.data.canonical_document.internal_timeline_revisions);
    expect(inverse.data.canonical_document.dependency_manifest).toEqual(c.data.canonical_document.dependency_manifest);
    undone = inverse;
    expect(inverse.data.canonical_document.parent_revision.payload.config).toMatchObject({ tracks: expect.arrayContaining([expect.objectContaining({ id: 'f2-independent-C' })]) });
    const entries = (await history(harness, seed3)).items;
    expect(entries.find((entry) => entry.publication_id === pinOf(inverse).publication_id)?.records?.undo_of).toEqual([publication]);
    await expectImmutableClosure(harness, seed3, inverse);
    await expectPreviewRevision(reopened, pinOf(inverse).revision_id);
    await expectAgentRevision(astrid, harness, seed3, pinOf(inverse).revision_id);
  }
  // An intentional same-value write is a new publication of the same immutable revision.
  const revisionCount = (await allRevisions(harness, seed3)).length;
  const same = await astrid.commitCaptured(harness.seed.projectId, seed3.timelineId, pinOf(undone),
    { kind: 'move', clipId: seed3.appClipId, on: 5 }, 'f2-same-value');
  expect(pinOf(same).revision_id).toBe(pinOf(undone).revision_id);
  expect(pinOf(same).publication_id).not.toBe(pinOf(undone).publication_id);
  expect(await astrid.commitCaptured(harness.seed.projectId, seed3.timelineId, pinOf(undone),
    { kind: 'move', clipId: seed3.appClipId, on: 5 }, 'f2-same-value')).toEqual(same);
  expect((await allRevisions(harness, seed3)).length).toBe(revisionCount);
  const finalHistory = await history(harness, seed3);
  expect(finalHistory.items).toHaveLength(before.items.length + 5);
  expect(new Set(finalHistory.items.map((entry) => entry.publication_id)).size).toBe(finalHistory.items.length);
  expect(finalHistory.items.filter((entry) => entry.publication_id === pinOf(a).publication_id)).toHaveLength(1);
  expect(wire.legacy, 'move and inverse must never POST a legacy snapshot').toEqual([]);
  await expectOpaqueDataKept(harness, seed3);
  journey.facts = { ...journey.facts, sourceTuple: revisionSet(journey.identity), renderer: 'not started',
    authoringLaunch: { profile: 'astrid', python: ASTRID_PYTHON },
    headA: pinOf(a), headB: pinOf(b), independentC: pinOf(c), originalB: commandsOf(owner.intents[1].payload),
    exactRetry: { method: wire.posts[1].method, path: wire.posts[1].path, key: wire.posts[1].key }, legacySaveCount: wire.legacy.length };
  await sniff.expectClean(reopened, seed3.timelineId);
});

test('M2 real gate 5 (M1 real mounted path): Agent edit, lost ACK, newer local gesture, exact retry, restart and undo preserve intent', async ({ page, context, harness, astrid, seed3 }) => {
  const sniff = new TokenSniff(secretsOf(harness, astrid));
  sniff.attach(page);
  let c!: CommitAcceptedMutation;
  const preconditionOwner = await openCommandTimeline(page, harness, seed3);
  const preconditionBase = await history(harness, seed3);
  const preGestureDocument = await canonicalDocumentAt(harness, seed3, preconditionBase.head.revision_id);
  const preconditionRequest = page.waitForRequest((request) => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== `/api/runtime${timelineBase(harness, seed3)}/commit`) return false;
    const body = request.postDataJSON() as Record<string, any>;
    return body?.base_revision_id === preconditionBase.head.revision_id
      && body?.base_publication_id === preconditionBase.head.publication_id
      && body?.commands?.length === 1
      && body.commands[0]?.schema_version === 1
      && body.commands[0]?.op === 'doc.patch'
      && body.commands[0]?.version === '1'
      && body.commands[0]?.select === null
      && Array.isArray(body.commands[0]?.created)
      && body.commands[0].created.length === 0
      && body.commands[0]?.args?.changes?.length === 1
      && body.commands[0].args.changes[0]?.op === 'set'
      && body.commands[0].args.changes[0]?.ref === 'parent'
      && body.commands[0].args.changes[0]?.path?.join('/') === `clips/id:${seed3.appClipId}/at`
      && body.commands[0].args.changes[0]?.before?.state === 'present'
      && body.commands[0].args.changes[0]?.before?.value === 0
      && body.commands[0].args.changes[0]?.value === 5
      && body.label === 'Edit timeline'
      && body.merge === 'fields'
      && body.dry_run === false
      && body.source?.via === 'app'
      && Array.isArray(body.reads) && body.reads.length > 0
      && body.steps?.length === 1
      && body.steps[0]?.label === 'Edit timeline'
      && body.steps[0]?.intent === `Move ${seed3.appClipId} on V1`
      && body.steps[0]?.command_ordinals?.length === 1
      && body.steps[0].command_ordinals[0] === 0
      && JSON.stringify(body.steps[0]?.patch) === JSON.stringify(body.commands[0].args.changes)
      && JSON.stringify(body.steps[0]?.reads) === JSON.stringify(body.reads);
  }, CEILING);
  const preconditionResponse = page.waitForResponse(async (response) => response.request() === await preconditionRequest, CEILING);
  await dragTimelineClip(page, seed3.appClipId, seed3.transitionClipId, 0, 5, THREE_PRODUCTS_REFERENCE_AT);
  const setupRequest = await preconditionRequest;
  const setupResponse = await preconditionResponse;
  const setupBody = await setupResponse.json();
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).every((item) => !item.pending && !item.intents.length), CEILING).toBe(true);
  const setupPost: CommitPost = {
    method: setupRequest.method(), path: new URL(setupRequest.url()).pathname.replace(/^\/api\/runtime/, ''),
    body: setupRequest.postData()!, key: setupRequest.headers()['idempotency-key'],
    status: setupResponse.status(), response: setupBody,
  };
  const setupHistory = await expectV2History(harness, seed3, setupPost, 'accepted');
  const setupData = (setupBody as CommitAcceptedMutation).data;
  const authoritativeHead = (await history(harness, seed3)).head;
  const authoritativeRevision = await revisionBody(harness, setupData.accepted_revision_id);
  assertGate5ResetPrecondition({
    request: setupRequest.postDataJSON(), requestIdentity: setupRequest, responseRequest: setupResponse.request(),
    requestIdempotencyKey: setupRequest.headers()['idempotency-key'], responseStatus: setupResponse.status(), responseBody: setupBody,
    expectedBase: { revisionId: preconditionBase.head.revision_id, publicationId: preconditionBase.head.publication_id },
    expectedScope: { projectId: harness.seed.projectId, timelineId: seed3.timelineId },
    expectedOwnerId: preconditionOwner.ownerId, expectedOwnerScope: preconditionOwner.scope, preGestureDocument,
    authoritativeHistory: setupHistory,
    clipId: seed3.appClipId, expectedTrackId: 'V1', expectedPreviousPosition: 0, expectedPosition: 5,
    settledOutboxes: (await commandOutboxes(page, seed3.timelineId)).filter((owner) => owner.ownerId === preconditionOwner.ownerId),
    authoritativeHead, authoritativeRevision,
  });
  const resetResponse = page.waitForResponse((response) => response.request().method() === 'POST' && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await dragTimelineClip(page, seed3.appClipId, seed3.transitionClipId, 5, 0, THREE_PRODUCTS_REFERENCE_AT);
  const reset = await resetResponse;
  expect(reset.status(), await reset.text()).toBe(200);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).every((item) => !item.pending && !item.intents.length), CEILING).toBe(true);
  const { wire, before, a, owner } = await prepareAfterAckLossMountedDocuments(page, harness, seed3, async (acceptedA, commandWire) => {
    c = await astrid.commitCaptured(harness.seed.projectId, seed3.timelineId, pinOf(acceptedA),
      { kind: 'track', id: 'f2-gate5-independent-C' }, 'f2-gate5-independent-C');
    expect(c.data.publisher).not.toBe(acceptedA.data.publisher);
    expect(position(c.data.canonical_document, seed3.appClipId)).toBe(5);
    await commandWire.loseAck();
    const retryOwnerId = (await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.pending)?.ownerId;
    expect(retryOwnerId).toBeTruthy();
    await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId))
      .find((candidate) => candidate.ownerId === retryOwnerId)?.pending?.outcome?.kind, CEILING).toBe('retry');
  });
  const recordedA = await expectV2History(harness, seed3, wire.posts[0], 'accepted');
  const seedState = await revisionState(harness, seed3, seed3.headRevisionId);
  const seededTransition = seedState.parentClips[seed3.transitionClipId].transition;
  expect(c.data.canonical_document.parent_revision.payload.clips)
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: seed3.transitionClipId, transition: seededTransition })]));
  expect(wire.posts, 'B was authored only after the durable ACK was lost').toHaveLength(1);
  expect(owner.intents).toHaveLength(2);
  expect(owner.intents[1].basis).toEqual({ after: owner.intents[0].id });
  expect(owner.intents[1].readyBase).toBeUndefined();

  const realmBefore = await expectSameRealm(page, harness, astrid);
  const originalARequest = { body: wire.posts[0].body, key: wire.posts[0].key };
  wire.armRecoveryRetry();
  await wire.abortStagedRetry();
  await page.reload();
  await expectConnected(page);
  const afterReload = (await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.ownerId === owner.ownerId)!;
  expect(afterReload.pending?.request).toEqual(owner.pending!.request);
  expect(afterReload.intents).toEqual(owner.intents);
  expect(wire.posts, 'reload does not send queued B or retry A').toHaveLength(1);
  await expect.poll(() => wire.observed.length, CEILING).toBe(3);
  await wire.abortStagedRetry('connectionclosed');
  await page.close();

  const restarted = await harness.restartRuntime();
  expect(restarted.oldInstanceId).toBe(realmBefore.runtimeInstanceId);
  expect(harness.runtimeInstanceId).not.toBe(restarted.oldInstanceId);
  expect(harness.realmId).toBe(realmBefore.realmId);
  const reopened = await context.newPage();
  sniff.attach(reopened);
  await wire.attach(reopened);
  await openApp(reopened, harness);
  await expectConnected(reopened);
  await openSeededTimeline(reopened, harness);
  const realmAfter = await expectSameRealm(reopened, harness, astrid);
  expect(realmAfter.realmId).toBe(realmBefore.realmId);
  expect(realmAfter.runtimeInstanceId).toBe(harness.runtimeInstanceId);
  expect(realmAfter.runtimeInstanceId).not.toBe(realmBefore.runtimeInstanceId);
  const persisted = (await commandOutboxes(reopened, seed3.timelineId)).find((candidate) => candidate.ownerId === owner.ownerId)!;
  expect(persisted.pending?.request).toEqual(owner.pending!.request);
  expect(persisted.intents).toEqual(owner.intents);
  expect(wire.posts).toHaveLength(1);

  wire.armRecoveryRetry();
  await expect.poll(() => wire.observed.length, CEILING).toBe(4);
  expect(wire.observed.slice(0, 4)).toEqual([originalARequest, originalARequest, originalARequest, originalARequest]);
  expect(wire.observedUrls.slice(0, 4)).toEqual([wire.observedUrls[0], wire.observedUrls[0], wire.observedUrls[0], wire.observedUrls[0]]);
  expect(wire.observedUrls.slice(0, 4).map((url) => new URL(url).origin))
    .toEqual([new URL(harness.doorBase).origin, new URL(harness.doorBase).origin,
      new URL(harness.doorBase).origin, new URL(harness.doorBase).origin]);
  expect(wire.forwarded).toHaveLength(1);
  await wire.releaseStagedRetry();
  await expect.poll(() => wire.posts.length, CEILING).toBe(3);
  expect(wire.posts[1].body).toBe(originalARequest.body);
  expect(wire.posts[1].key).toBe(originalARequest.key);
  expect(wire.posts[1].response).toEqual(wire.posts[0].response);
  expect(await expectV2History(harness, seed3, wire.posts[1], 'accepted')).toEqual(recordedA);
  const b = accepted(wire.posts[2]);
  expect(wire.observed).toHaveLength(5);
  expect(wire.observed.slice(0, 4)).toEqual([originalARequest, originalARequest, originalARequest, originalARequest]);
  expect(wire.observed[4]).toEqual({ body: wire.posts[2].body, key: wire.posts[2].key });
  expect(wire.observedUrls).toEqual([wire.observedUrls[0], wire.observedUrls[0], wire.observedUrls[0], wire.observedUrls[0], wire.observedUrls[0]]);
  expect(wire.observedUrls.map((url) => new URL(url).origin))
    .toEqual([new URL(harness.doorBase).origin, new URL(harness.doorBase).origin,
      new URL(harness.doorBase).origin, new URL(harness.doorBase).origin, new URL(harness.doorBase).origin]);
  expect(wire.forwarded).toHaveLength(3);
  const requestB = JSON.parse(wire.posts[2].body) as CommitRequest;
  const mountedB = mountedDocumentIntentOf(owner.intents[1].payload);
  expect(wire.posts[2].key).not.toBe(wire.posts[0].key);
  expect(requestB).toMatchObject({ base_revision_id: pinOf(a).revision_id, base_publication_id: pinOf(a).publication_id });
  expect(requestB.commands).toEqual([{ schema_version: 1, op: 'doc.patch', version: '1', select: null,
    args: { changes: mountedB.changes }, created: [] }]);
  expect(requestB.label).toBe(mountedB.label);
  expect(requestB.merge).toBe(mountedB.merge ?? 'atomic');
  expect(requestB.steps).toEqual([{ ...mountedB.step, command_ordinals: [0], patch: mountedB.changes }]);
  if (mountedB.reads === undefined) expect(requestB).not.toHaveProperty('reads');
  else expect(requestB.reads).toEqual(mountedB.reads);
  expect(b.data.publisher).toBe(a.data.publisher);
  expect(b.data.status).toBe('merged');
  expect(b.data.previous_publication_id).toBe(pinOf(c).publication_id);
  expect(position(b.data.canonical_document, seed3.appClipId)).toBe(7);
  expect(b.data.canonical_document.parent_revision.payload.config).toMatchObject({
    tracks: expect.arrayContaining([expect.objectContaining({ id: 'f2-gate5-independent-C', kind: 'audio', label: 'f2-gate5-independent-C' })]),
  });
  expect(b.data.canonical_document.parent_revision.payload.clips)
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: seed3.transitionClipId, transition: seededTransition })]));
  await expect.poll(async () => (await commandOutboxes(reopened, seed3.timelineId))
    .find((candidate) => candidate.ownerId === owner.ownerId)?.intents.length, CEILING).toBe(0);
  expect((await history(harness, seed3)).items).toHaveLength(before.items.length + 3);
  const recordedB = (await history(harness, seed3)).items.find((entry) => entry.publication_id === pinOf(b).publication_id)?.records;
  expectRecordedDocumentPatchCommand(recordedB?.commands[0].command, requestB.commands[0], seed3.appClipId);
  expect(recordedB?.commands[0].reads.length).toBeGreaterThan(0);
  expect(recordedB?.commands[0].bindings.length).toBeGreaterThan(0);
  const recordedMerged = await expectV2History(harness, seed3, wire.posts[2], 'merged');
  await expectImmutableClosure(harness, seed3, a);
  await expectImmutableClosure(harness, seed3, c);
  await expectImmutableClosure(harness, seed3, b);
  await expectPreviewRevision(reopened, pinOf(b).revision_id);
  await expectAgentRevision(astrid, harness, seed3, pinOf(b).revision_id);

  const publication = pinOf(b).publication_id;
  const count = wire.posts.length;
  await reopened.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(count + 1);
  const inversePost = wire.posts[count];
  expect((JSON.parse(inversePost.body) as CommitRequest).commands).toEqual([
    { schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: [publication] } },
  ]);
  const inverse = accepted(inversePost);
  const recordedInverse = await expectV2History(harness, seed3, inversePost, 'accepted', [publication]);
  expect(position(inverse.data.canonical_document, seed3.appClipId)).toBe(5);
  expect(inverse.data.canonical_document.parent_revision.payload).toEqual(c.data.canonical_document.parent_revision.payload);
  expect(inverse.data.canonical_document.parent_revision.payload.clips)
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: seed3.transitionClipId, transition: seededTransition })]));
  expect(inverse.data.canonical_document.shot_revisions).toEqual(c.data.canonical_document.shot_revisions);
  expect(inverse.data.canonical_document.internal_timeline_revisions).toEqual(c.data.canonical_document.internal_timeline_revisions);
  expect(inverse.data.canonical_document.dependency_manifest).toEqual(c.data.canonical_document.dependency_manifest);
  const finalHistory = await history(harness, seed3);
  expect(finalHistory.items.find((entry) => entry.publication_id === recordedA.publication_id)).toEqual(recordedA);
  expect(finalHistory.items.find((entry) => entry.publication_id === recordedMerged.publication_id)).toEqual(recordedMerged);
  expect(finalHistory.items.find((entry) => entry.publication_id === recordedInverse.publication_id)).toEqual(recordedInverse);
  expect(finalHistory.items).toHaveLength(before.items.length + 4);
  expect(finalHistory.items.find((entry) => entry.publication_id === pinOf(inverse).publication_id)?.records?.undo_of)
    .toEqual([publication]);
  await expectImmutableClosure(harness, seed3, inverse);
  await expectPreviewRevision(reopened, pinOf(inverse).revision_id);
  await expectAgentRevision(astrid, harness, seed3, pinOf(inverse).revision_id);
  await expectOpaqueDataKept(harness, seed3);
  expect(wire.legacy, 'the post-loss B gesture and inverse never use legacy snapshot traffic').toEqual([]);
  journey.facts = { ...journey.facts, sourceTuple: revisionSet(journey.identity), renderer: 'not started',
    authoringLaunch: { profile: 'astrid', python: ASTRID_PYTHON }, headA: pinOf(a), headB: pinOf(b), independentC: pinOf(c),
    originalB: mountedB.changes, exactRetry: { body: originalARequest.body, key: originalARequest.key },
    legacySaveCount: wire.legacy.length };
  await sniff.expectClean(reopened, seed3.timelineId);
});

test('M2 ordinary extension batch: move and hold, Agent label, lost ACK, restart, exact retry and guarded undo', async ({ page, context, harness, astrid, seed3 }) => {
  const sniff = new TokenSniff(secretsOf(harness, astrid));
  sniff.attach(page);
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  const wire = await faultFirstCommit(page);
  await openCommandTimeline(page, harness, seed3);
  const realmBefore = await expectSameRealm(page, harness, astrid);
  const before = await history(harness, seed3);
  const beforeDocument = await canonicalDocumentAt(harness, seed3, before.head.revision_id);
  // Shape regression: the old parent-only projection had no closure arrays.
  expect(beforeDocument).toMatchObject({
    schema_version: 1,
    project_id: harness.seed.projectId,
    timeline_id: seed3.timelineId,
    parent_revision: expect.objectContaining({ revision_id: before.head.revision_id }),
    shot_revisions: [expect.objectContaining({ shot_id: seed3.shotId })],
    internal_timeline_revisions: [expect.objectContaining({ timeline_id: seed3.timelineId })],
    dependency_manifest: expect.objectContaining({
      shots: [expect.objectContaining({ shot_id: seed3.shotId })],
      internal_timelines: [expect.objectContaining({ timeline_id: seed3.timelineId })],
    }),
  });
  const original = await revisionState(harness, seed3, before.head.revision_id);

  // The production-mounted Scene Phase Markers extension emits one public patch.
  // Its ordinary members are captured by the host's generic port as one outbox intent.
  await expect(page.getByTestId('scene-markers-summary')).toContainText('2 markers');
  const tail = page.getByTestId('scene-markers-playhead').locator('..').locator('input[type="number"]');
  await tail.fill('3');
  await page.getByTestId('scene-markers-move-shots').click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(1);

  const ordinaryPost = wire.posts[0];
  const ordinaryRequest = JSON.parse(ordinaryPost.body) as CommitRequest;
  // The production action aligns every visual clip in the displayed snapshot:
  // the two authored parent clips plus the three projected clips owned by the
  // seeded occurrence. Keep the full native membership explicit here; the
  // occurrence clips are part of this normal fixture, not an unsupported
  // subset to be filtered out of the action.
  expect(ordinaryRequest.commands).toHaveLength(10);
  expect(ordinaryRequest.commands).toEqual([
    expect.objectContaining({ op: 'clip.move', select: `parent/clip:${seed3.appClipId}`, args: { on: 1 } }),
    expect.objectContaining({ op: 'clip.set', select: `parent/clip:${seed3.appClipId}`, args: { values: { hold: 5 }, clear: [] } }),
    expect.objectContaining({ op: 'clip.move', select: `parent/clip:${seed3.transitionClipId}`, args: { on: 6 } }),
    expect.objectContaining({ op: 'clip.set', select: `parent/clip:${seed3.transitionClipId}`, args: { values: { hold: 3 }, clear: [] } }),
    expect.objectContaining({ op: 'clip.move', select: `occurrence:${seed3.occurrenceId}/clip:f2-plate`, args: { on: 6 } }),
    expect.objectContaining({ op: 'clip.set', select: `occurrence:${seed3.occurrenceId}/clip:f2-plate`, args: { values: { hold: 3 }, clear: [] } }),
    expect.objectContaining({ op: 'clip.move', select: `occurrence:${seed3.occurrenceId}/clip:${seed3.agentClipId}`, args: { on: 6 } }),
    expect.objectContaining({ op: 'clip.set', select: `occurrence:${seed3.occurrenceId}/clip:${seed3.agentClipId}`, args: { values: { hold: 3 }, clear: [] } }),
    expect.objectContaining({ op: 'clip.move', select: `occurrence:${seed3.occurrenceId}/clip:${seed3.agentClearClipId}`, args: { on: 6 } }),
    expect.objectContaining({ op: 'clip.set', select: `occurrence:${seed3.occurrenceId}/clip:${seed3.agentClearClipId}`, args: { values: { hold: 3 }, clear: [] } }),
  ]);
  const ordinary = accepted(ordinaryPost);
  expect(position(ordinary.data.canonical_document, seed3.appClipId)).toBe(1);
  expect(position(ordinary.data.canonical_document, seed3.transitionClipId)).toBe(6);
  expect((ordinary.data.canonical_document.parent_revision.payload.clips as Array<Record<string, any>>)
    .find((clip) => clip.id === seed3.appClipId)?.hold).toBe(5);
  expect((ordinary.data.canonical_document.parent_revision.payload.clips as Array<Record<string, any>>)
    .find((clip) => clip.id === seed3.transitionClipId)?.hold).toBe(3);
  expect((await history(harness, seed3)).items).toHaveLength(before.items.length + 1);

  // A disjoint Agent label lands after the ordinary batch, while its ACK is still held from the App.
  const agentEdit = await astrid.commitCaptured(harness.seed.projectId, seed3.timelineId, pinOf(ordinary),
    { kind: 'label', trackId: 'S1', label: 'F2 Agent ordinary sibling' }, 'f2-ordinary-agent-label');
  expect(agentEdit.data.publisher).not.toBe(ordinary.data.publisher);
  expect(position(agentEdit.data.canonical_document, seed3.appClipId)).toBe(1);
  expect((agentEdit.data.canonical_document.parent_revision.payload.clips as Array<Record<string, any>>)
    .find((clip) => clip.id === seed3.appClipId)?.hold).toBe(5);

  await editFirstTrackName(page, 'F2 ordinary local label');
  await expect.poll(async () => {
    const candidates = await commandOutboxes(page, seed3.timelineId);
    return candidates.find((candidate) => candidate.pending?.request.key === ordinaryPost.key && candidate.intents.length === 2) ?? null;
  }, CEILING).toBeTruthy();
  const owner = (await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.pending?.request.key === ordinaryPost.key)!;
  expect(commandsOf(owner.intents[0].payload)).toEqual(ordinaryRequest.commands);
  expect(owner.intents[1].basis).toEqual({ after: owner.intents[0].id });
  expect(commandsOf(owner.intents[1].payload)).toEqual([expect.objectContaining({
    op: 'track.set', select: 'parent/track:V1', args: { values: { label: 'F2 ordinary local label' }, clear: [] },
  })]);
  await wire.loseAck();
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.ownerId === owner.ownerId)?.pending?.outcome?.kind, CEILING).toBe('retry');

  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  const afterReload = (await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.ownerId === owner.ownerId)!;
  expect(afterReload.pending?.request).toEqual(owner.pending?.request);
  expect(afterReload.intents).toEqual(owner.intents);
  expect(wire.posts).toHaveLength(1);
  await page.close();

  const restarted = await harness.restartRuntime();
  expect(restarted.oldInstanceId).toBe(realmBefore.runtimeInstanceId);
  const reopened = await context.newPage();
  sniff.attach(reopened);
  await wire.attach(reopened);
  await openApp(reopened, harness);
  await expectConnected(reopened);
  await openSeededTimeline(reopened, harness);
  const realmAfter = await expectSameRealm(reopened, harness, astrid);
  expect(realmAfter.realmId).toBe(realmBefore.realmId);
  expect(realmAfter.runtimeInstanceId).not.toBe(realmBefore.runtimeInstanceId);
  const persisted = (await commandOutboxes(reopened, seed3.timelineId)).find((candidate) => candidate.ownerId === owner.ownerId)!;
  expect(persisted.pending?.request).toEqual(owner.pending?.request);
  expect(persisted.intents).toEqual(owner.intents);

  await reopened.getByRole('button', { name: /^Recover saved edits/ })
    .and(reopened.locator(`[data-owner-id="${owner.ownerId}"]`)).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(3);
  expect(wire.posts[1], 'client and Runtime restart preserve the exact retry body and key').toEqual(wire.posts[0]);
  const retriedOrdinary = accepted(wire.posts[1]);
  const localLabel = accepted(wire.posts[2]);
  expect(localLabel.data.status).toBe('rebased');
  expect(JSON.parse(wire.posts[2].body).commands).toEqual(commandsOf(owner.intents[1].payload));
  expect(localLabel.data.canonical_document.parent_revision.payload.config).toMatchObject({
    tracks: expect.arrayContaining([
      expect.objectContaining({ id: 'V1', label: 'F2 ordinary local label' }),
      expect.objectContaining({ id: 'S1', label: 'F2 Agent ordinary sibling' }),
    ]),
    x_f2_opaque: seed3.opaque.config,
  });
  expect(position(localLabel.data.canonical_document, seed3.appClipId)).toBe(1);
  expect(position(localLabel.data.canonical_document, seed3.transitionClipId)).toBe(6);
  expect(retriedOrdinary.data.canonical_document).toEqual(ordinary.data.canonical_document);
  await expect.poll(async () => (await commandOutboxes(reopened, seed3.timelineId)).every((candidate) => !candidate.pending && !candidate.intents.length), CEILING).toBe(true);

  // Undo the newer label first, then the grouped ordinary batch. The Agent label and opaque fields survive both inverses.
  await reopened.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(4);
  const undoLabel = accepted(wire.posts[3]);
  expect(JSON.parse(wire.posts[3].body).commands).toEqual([{
    schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: [localLabel.receipt.receipt_id] },
  }]);
  expect(undoLabel.data.canonical_document.parent_revision.payload.config).toMatchObject({
    tracks: expect.arrayContaining([expect.objectContaining({ id: 'S1', label: 'F2 Agent ordinary sibling' })]),
  });

  await reopened.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(5);
  const undoOrdinary = accepted(wire.posts[4]);
  expect(JSON.parse(wire.posts[4].body).commands).toEqual([{
    schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: [ordinary.receipt.receipt_id] },
  }]);
  // The inverse restores the independent pre-ordinary authored document, not
  // the derived ordinary revision that Agent C was based on. Build the exact
  // expected authored state from the pre-edit Runtime document and overlay
  // only Agent C's disjoint S1 label; do not derive it from the inverse result.
  const expectedAfterUndo = structuredClone(beforeDocument) as CanonicalDocument;
  const expectedAfterUndoParent = expectedAfterUndo.parent_revision.payload as Record<string, any>;
  const expectedAfterUndoAgentTrack = (expectedAfterUndoParent.config.tracks as Array<Record<string, any>>)
    .find((track) => track.id === 'S1');
  expect(expectedAfterUndoAgentTrack, 'the independent Agent track remains in the authored seed').toBeTruthy();
  expectedAfterUndoAgentTrack!.label = 'F2 Agent ordinary sibling';
  expect(undoOrdinary.data.canonical_document.parent_revision.payload).toEqual(expectedAfterUndoParent);
  expect(undoOrdinary.data.canonical_document.shot_revisions).toEqual(expectedAfterUndo.shot_revisions);
  expect(undoOrdinary.data.canonical_document.internal_timeline_revisions).toEqual(expectedAfterUndo.internal_timeline_revisions);
  expect(undoOrdinary.data.canonical_document.dependency_manifest).toEqual(expectedAfterUndo.dependency_manifest);
  expect(position(undoOrdinary.data.canonical_document, seed3.appClipId)).toBe(original.parentClips[seed3.appClipId].at);
  expect(position(undoOrdinary.data.canonical_document, seed3.transitionClipId)).toBe(original.parentClips[seed3.transitionClipId].at);
  expect(undoOrdinary.data.canonical_document.parent_revision.payload.config.x_f2_opaque).toEqual(seed3.opaque.config);
  expect(wire.legacy, 'the extension batch, local label, retry and inverses never use legacy snapshot traffic').toEqual([]);
  await expectImmutableClosure(harness, seed3, undoOrdinary);
  await expectOpaqueDataKept(harness, seed3);
  journey.facts = { ...journey.facts, sourceTuple: revisionSet(journey.identity), ordinary: {
    commands: ordinaryRequest.commands, retryKey: ordinaryPost.key, agentEdit: pinOf(agentEdit), localLabel: pinOf(localLabel),
    undo: pinOf(undoOrdinary), historyGroup: true, legacySaveCount: wire.legacy.length,
  } };
  await sniff.expectClean(reopened, seed3.timelineId);
});

test('M2 real mounted manual video drop: Runtime selection refusal is closed, native ADD recovers exactly, and undo preserves opaque data', async ({ page, context, harness, astrid, seed3 }) => {
  const sniff = new TokenSniff(secretsOf(harness, astrid));
  sniff.attach(page);
  captureBoundedBrowserEvidence(page);
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  await openCommandTimeline(page, harness, seed3);

  // Main's external-drop coordinator centers its five-second preview. Keep
  // the original 22.5s pointer (left edge 20s) and prepare the mounted
  // viewport through the existing user-facing zoom control. The two rendered
  // clips are the calibration anchors used by the drop helper; the V1 row
  // proves that the pointer is measured against the original selected row.
  const manualDropPointerAt = 22.5;
  const manualDropDurationSeconds = 5;
  const dropClip = page.locator(`.clip-action[data-clip-id="${seed3.appClipId}"]`).first();
  const referenceClip = page.locator(`.clip-action[data-clip-id="${seed3.transitionClipId}"]`).first();
  const timelineWrapper = page.locator('.timeline-wrapper').first();
  await expect(page.locator('[data-row-id="V1"]').first()).toBeVisible();
  await expect(dropClip).toBeVisible();
  await expect(referenceClip).toBeVisible();
  await expect(timelineWrapper).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zoom out timeline', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Zoom out timeline', exact: true }).click();
  const [dropBox, referenceBox, wrapperBox] = await Promise.all([
    dropClip.boundingBox(),
    referenceClip.boundingBox(),
    timelineWrapper.boundingBox(),
  ]);
  if (!dropBox || !referenceBox || !wrapperBox) throw new Error('Cannot measure prepared manual-drop viewport');
  const pixelsPerSecond = (referenceBox.x - dropBox.x) / THREE_PRODUCTS_REFERENCE_AT;
  expect(pixelsPerSecond).toBeGreaterThan(0);
  const centeredPointerX = dropBox.x + manualDropPointerAt * pixelsPerSecond;
  expect(centeredPointerX).toBeGreaterThanOrEqual(wrapperBox.x);
  expect(centeredPointerX).toBeLessThanOrEqual(wrapperBox.x + wrapperBox.width);
  expect(manualDropPointerAt - manualDropDurationSeconds / 2).toBe(20);
  expect(manualDropPointerAt - manualDropDurationSeconds / 2).toBeGreaterThanOrEqual(THREE_PRODUCTS_REFERENCE_AT + 3);

  const mediaObject = await harness.runtimeFetch(`/v1/objects/${encodeURIComponent(harness.seed.video.objectId)}`);
  expect(mediaObject.status).toBe(200);
  const mediaBytes = new Uint8Array(await mediaObject.arrayBuffer());
  expect(harness.seed.video.decodable, 'the positive drop requires the normal decodable WebM fixture').toBe(true);
  expect(harness.seed.video.mediaType).toBe('video/webm');
  expect(harness.seed.video.objectId).toBe(harness.seed.video.digest);
  expect(mediaBytes.byteLength).toBe(harness.seed.video.size);
  expect(sha256Hex(mediaBytes)).toBe(harness.seed.video.digest);
  expect(Array.from(mediaBytes.slice(0, 4))).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  const bytesBase64 = Buffer.from(mediaBytes).toString('base64');
  const file = { name: 'manual-drop.webm', type: harness.seed.video.mediaType, bytesBase64 };
  const fileProbe = await page.evaluate(async ({ name, type, bytesBase64: encoded }) => {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const browserFile = new File([bytes], name, { type });
    const url = URL.createObjectURL(browserFile);
    const video = document.createElement('video');
    video.preload = 'metadata';
    try {
      const metadata = await new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
        video.onloadedmetadata = () => resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
        video.onerror = () => reject(new Error('browser could not decode the seeded File'));
        video.src = url;
      });
      return { size: browserFile.size, type: browserFile.type, ...metadata };
    } finally {
      URL.revokeObjectURL(url);
    }
  }, file);
  expect(fileProbe).toMatchObject({ size: harness.seed.video.size, type: harness.seed.video.mediaType });
  expect(fileProbe.duration).toBeGreaterThan(0);
  expect(fileProbe.width).toBeGreaterThan(0);
  expect(fileProbe.height).toBeGreaterThan(0);
  const original = await history(harness, seed3);
  const baselineClipCount = await page.locator('.clip-action').count();
  const mediaReads: URL[] = [];
  const onMediaRequest = (request: Request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && /\/media-selection(?:\/verified)?\?/.test(url.pathname + url.search)) mediaReads.push(url);
  };
  page.on('request', onMediaRequest);

  // A wrong verified selection reaches the real Runtime and must refuse without a legacy or snapshot fallback.
  const wrongImportResponse = page.waitForResponse((response) => response.request().method() === 'POST' && /\/media-imports$/.test(new URL(response.url()).pathname), CEILING);
  const wrongVerifiedResponse = page.waitForResponse((response) => response.request().method() === 'GET' && /\/media-selection\/verified\?/.test(new URL(response.url()).pathname + new URL(response.url()).search), CEILING);
  const wrongSelectionRoute = /\/media-selection\/verified\?/;
  await page.route(wrongSelectionRoute, async (route) => {
    const url = new URL(route.request().url());
    const originalObjectId = url.searchParams.get('object_id');
    expect(originalObjectId).toMatch(/^sha256:[0-9a-f]{64}$/);
    const lastHex = originalObjectId!.at(-1)!;
    url.searchParams.set('object_id', `${originalObjectId!.slice(0, -1)}${lastHex === '0' ? '1' : '0'}`);
    await route.continue({ url: url.toString() });
  });
  await dropFileOnTimeline(page, file, seed3.appClipId, seed3.transitionClipId, 0, THREE_PRODUCTS_REFERENCE_AT, manualDropPointerAt);
  await wrongImportResponse;
  const wrongVerified = await wrongVerifiedResponse;
  expect(wrongVerified.status()).toBe(404);
  await expect(wrongVerified.json()).resolves.toEqual({
    code: 'not_found',
    message: 'selected media is not a managed project generation/variant/object',
    request_id: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/),
  });
  await page.unroute(wrongSelectionRoute);
  await expect(page.locator('.clip-action')).toHaveCount(baselineClipCount, CEILING);
  expect(await currentHead(harness)).toBe(original.head.revision_id);
  expect(await history(harness, seed3)).toEqual(original);
  expect(mediaReads.some((url) => url.pathname.endsWith('/media-selection/verified'))).toBe(true);

  // The same real file-drop path now uses the Runtime's original five-field selection and native clip.add-media.
  mediaReads.length = 0;
  const wire = await faultFirstCommit(page);
  const importResponse = page.waitForResponse((response) => response.request().method() === 'POST' && /\/media-imports$/.test(new URL(response.url()).pathname), CEILING);
  const selectionResponse = page.waitForResponse((response) => response.request().method() === 'GET' && /\/media-selection\?/.test(new URL(response.url()).pathname + new URL(response.url()).search), CEILING);
  const verifiedResponse = page.waitForResponse((response) => response.request().method() === 'GET' && /\/media-selection\/verified\?/.test(new URL(response.url()).pathname + new URL(response.url()).search), CEILING);
  await dropFileOnTimeline(page, file, seed3.appClipId, seed3.transitionClipId, 0, THREE_PRODUCTS_REFERENCE_AT, manualDropPointerAt);
  const imported = await importResponse;
  expect(imported.status()).toBe(201);
  const importedBody = await imported.json() as { data: Record<string, any> };
  const selected = await selectionResponse.then((response) => response.json()) as Record<string, string>;
  const verified = await verifiedResponse;
  expect(verified.status(), await verified.text()).toBe(200);
  expect((await verified.json()).selection).toEqual(selected);
  const selectedRequest = mediaReads.find((url) => url.pathname.endsWith('/media-selection'));
  const verifiedRequest = mediaReads.find((url) => url.pathname.endsWith('/media-selection/verified'));
  expect(selectedRequest).toBeTruthy();
  expect(verifiedRequest).toBeTruthy();
  expect(selected).toMatchObject({
    asset: importedBody.data.asset_id,
    generation_id: importedBody.data.generation_id,
    variant_id: importedBody.data.variant_id,
    object_id: importedBody.data.entry.object_id,
  });
  expect(importedBody.data.entry).toMatchObject({
    object_id: harness.seed.video.objectId,
    size: harness.seed.video.size,
    media_type: harness.seed.video.mediaType,
  });
  expect(verifiedRequest!.searchParams.get('asset')).toBe(selected.asset);
  expect(verifiedRequest!.searchParams.get('generation_id')).toBe(selected.generation_id);
  expect(verifiedRequest!.searchParams.get('variant_id')).toBe(selected.variant_id);
  expect(verifiedRequest!.searchParams.get('object_id')).toBe(selected.object_id);
  expect(verifiedRequest!.searchParams.get('catalog_digest')).toBe(selected.catalog_digest);

  // A sent request and a fetched response are different milestones.
  await expect.poll(async () => ({
    attempts: wire.attempts,
    alerts: await page.getByRole('alert').allTextContents(),
    session: await page.getByTestId('timeline-command-recovery').allTextContents(),
    draft: await timelineDraft(page, seed3.timelineId),
  }), CEILING).toMatchObject({ attempts: 1 });
  await expect.poll(() => wire.posts.length, CEILING).toBe(1);
  const addPost = wire.posts[0];
  const addRequest = JSON.parse(addPost.body) as CommitRequest;
  const addCommand = addRequest.commands[0];
  expect(addCommand.op).toBe('clip.add-media');
  expect(addCommand.select).toBe('parent');
  expect(addCommand.args.media).toEqual(selected);
  expect(addCommand.args).not.toHaveProperty('afterClipId');
  expect(addCommand.args).not.toHaveProperty('removeClipId');
  expect(addCommand.args).not.toHaveProperty('replaceClipId');
  const addedRow = addCommand.args.row as Record<string, any>;
  expect(addedRow.track).toBe('V1');
  expect(addedRow.at).toBeCloseTo(20, 3);
  expect(addedRow.clipType).toBe('media');
  const addedClipId = addedRow.id as string;
  const addedAsset = addedRow.asset as string;
  const ownerBeforeLoss = (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.pending?.request.key === addPost.key)!;
  expect(ownerBeforeLoss.pending?.request.body).toBe(addPost.body);

  // B is authored against the unacknowledged A and must be replayed only after A's exact retry.
  await editFirstTrackName(page, 'Manual drop follow-up');
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId))
    .find((owner) => owner.ownerId === ownerBeforeLoss.ownerId)?.intents.length, CEILING).toBe(2);
  await wire.loseAck();
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId))
    .find((owner) => owner.ownerId === ownerBeforeLoss.ownerId)?.pending?.outcome?.kind, CEILING).toBe('retry');
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  expect((await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.ownerId === ownerBeforeLoss.ownerId)?.pending?.request)
    .toEqual(ownerBeforeLoss.pending!.request);
  expect(wire.posts).toHaveLength(1);

  await page.close();
  await harness.restartRuntime();
  const reopened = await context.newPage();
  captureBoundedBrowserEvidence(reopened);
  sniff.attach(reopened);
  await wire.attach(reopened);
  await openApp(reopened, harness);
  await expectConnected(reopened);
  await openSeededTimeline(reopened, harness);
  const recovered = reopened.getByRole('button', { name: /^Recover saved edits/ })
    .and(reopened.locator(`[data-owner-id="${ownerBeforeLoss.ownerId}"]`));
  await expect(recovered).toBeEnabled(CEILING);
  await recovered.click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(3);
  expect(wire.posts[1].body).toBe(addPost.body);
  expect(wire.posts[1].key).toBe(addPost.key);
  expect(wire.posts[1].response).toEqual(addPost.response);
  expect((JSON.parse(wire.posts[2].body) as CommitRequest).commands[0]).toMatchObject({
    op: 'track.set',
    args: { values: { label: 'Manual drop follow-up' }, clear: [] },
  });
  await expect.poll(async () => (await commandOutboxes(reopened, seed3.timelineId))
    .every((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);

  const acceptedAdd = accepted(wire.posts[1]);
  const afterRecovery = await revisionState(harness, seed3, accepted(wire.posts[2]).data.accepted_revision_id);
  expect(afterRecovery.parentClips[addedClipId]).toMatchObject({ id: addedClipId, asset: addedAsset, at: 20, track: 'V1', clipType: 'media' });
  expect(Object.values(afterRecovery.parentClips).filter((clip) => clip.id === addedClipId)).toHaveLength(1);
  expect(afterRecovery.trackLabel).toBe('Manual drop follow-up');
  expect(afterRecovery.parentClips[addedClipId].asset).toBe(addedAsset);
  expect(acceptedAdd.data.canonical_document.parent_revision.payload.config).toMatchObject({ x_f2_opaque: seed3.opaque.config });
  await expectOpaqueDataKept(harness, seed3);
  expect(wire.legacy).toEqual([]);

  // Undo the newer local intent through the same Runtime command history; the native media clip remains intact.
  await reopened.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(4);
  const undoneFollowUp = accepted(wire.posts[3]);
  expect(JSON.parse(wire.posts[3].body).commands).toEqual([{
    schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
    args: { publications: [accepted(wire.posts[2]).receipt.receipt_id] },
  }]);
  const afterUndo = await revisionState(harness, seed3, undoneFollowUp.data.accepted_revision_id);
  expect(afterUndo.trackLabel).toBe('V1');
  expect(afterUndo.parentClips[addedClipId]).toMatchObject({ id: addedClipId, asset: addedAsset });
  await expectOpaqueDataKept(harness, seed3);
  expect(wire.legacy).toEqual([]);
  journey.facts = { ...journey.facts, nativeSelection: selected, addedClipId, addedAsset, refusedStatus: wrongVerified.status(), exactRetryKey: addPost.key, renderer: 'not started', legacySaveCount: wire.legacy.length };
  await sniff.expectClean(reopened, seed3.timelineId);
});

test('M2 real gate 5 bootstrap actual consumer: production initializer uses native create/init, exact retry, restart and guarded undo', async ({ page, context, harness, astrid, seed3 }) => {
  const sniff = new TokenSniff(secretsOf(harness, astrid));
  sniff.attach(page);
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);

  const auditedBeforeCreate = harness.audit().length;
  await openApp(page, harness);
  await expectConnected(page);
  const createHold = await holdTimelineCreation(page);
  const initHold = await holdCommandRequests(page);
  await page.getByRole('button', { name: 'New project' }).click();
  const projectName = `Bootstrap actual ${Date.now()}`;
  await page.locator('#project-name').fill(projectName);
  const creating = page.getByRole('button', { name: 'Create Project' }).click();
  await expect.poll(() => createHold.requests.length, CEILING).toBe(1);
  const bootstrapCreateRequest = createHold.requests[0];
  const createPathFromRequest = new URL(bootstrapCreateRequest.url()).pathname.replace(/^\/api\/runtime/, '');
  const createBody = JSON.parse(bootstrapCreateRequest.postData() ?? '{}') as { timeline_id?: string };
  const createProjectMatch = createPathFromRequest.match(/^\/v1\/projects\/([^/]+)\/timelines$/);
  expect(createProjectMatch, 'bootstrap create must use the canonical project timeline route').toBeTruthy();
  expect(createBody.timeline_id, 'bootstrap create must reserve its timeline identity in the request').toBeTruthy();
  const createScope = { realmId: harness.realmId, projectId: decodeURIComponent(createProjectMatch![1]), timelineId: createBody.timeline_id! };
  await expect.poll(async () => (await commandOutboxes(page, createScope.timelineId))
    .find((owner) => owner.scope.projectId === createScope.projectId && owner.scope.timelineId === createScope.timelineId
      && owner.pending?.request.path === createPathFromRequest)?.scope, CEILING)
    .toMatchObject(createScope);
  await createHold.release(true);
  await expect.poll(() => initHold.requests.length, CEILING).toBe(1);
  await expect.poll(async () => (await commandOutboxes(page, createScope.timelineId))
    .find((owner) => owner.scope.projectId === createScope.projectId && owner.scope.timelineId === createScope.timelineId
      && owner.pending?.request.path === new URL(initHold.requests[0].url()).pathname.replace(/^\/api\/runtime/, '')),
  CEILING).toMatchObject({ scope: createScope, pending: { request: { method: 'POST' } }, intents: [{ payload: { kind: 'timeline-init' } }] });
  await initHold.release(true);
  await creating;
  await expect(page).toHaveURL(/\/tools\/video-editor\?project=/, CEILING);

  const createdProjectUrl = new URL(page.url());
  const projectId = createdProjectUrl.searchParams.get('project');
  expect(projectId, 'the production project creator must return a Runtime project ID').toBeTruthy();
  await expect(page.getByRole('combobox', { name: 'Select project' })).toContainText(projectName);
  await expect(page.getByRole('combobox', { name: 'Select timeline' })).toBeVisible(CEILING);
  await expect(firstTrackName(page)).toBeVisible(CEILING);
  await expect(page).toHaveURL(/\/tools\/video-editor\?project=[^&]+&timeline=[^&]+/, CEILING);
  const selectedTimelineId = new URL(page.url()).searchParams.get('timeline');
  expect(selectedTimelineId, 'the production initializer must select the created canonical timeline').toBeTruthy();
  expect({ realmId: harness.realmId, projectId, timelineId: selectedTimelineId }).toEqual(createScope);
  await expect.poll(async () => {
    const owner = (await commandOutboxes(page, selectedTimelineId!))
      .find((candidate) => candidate.scope.projectId === projectId && candidate.scope.timelineId === selectedTimelineId);
    return owner === undefined || (!owner.pending && owner.intents.length === 0);
  }, CEILING).toBe(true);
  let list!: { status: number; body: TimelineListPage };
  await expect.poll(async () => {
    list = await harness.runtimeJson<TimelineListPage>('GET', `/v1/projects/${projectId}/timelines`);
    return list.status === 200 && Boolean(timelineFromList(list.body, selectedTimelineId!));
  }, CEILING).toBe(true);
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  const selectedTimeline = timelineFromList(list.body, selectedTimelineId!);
  expect(selectedTimeline, 'the UI-selected timeline must belong to the created project').toMatchObject({ timeline_id: selectedTimelineId });
  expect(selectedTimeline?.is_shot, 'the bootstrap scope must be the document timeline, not a shot').not.toBe(true);

  // The New Project result, requested name/UI, and selected timeline establish
  // the exact scope. The door audit is the server-side boundary for this
  // browser transport; it must not choose a project or timeline from whichever
  // POST happened to be observed.
  const expectedScope = { realmId: harness.realmId, projectId: projectId!, timelineId: selectedTimelineId! };
  const createPath = `/v1/projects/${expectedScope.projectId}/timelines`;
  const commitPath = `/v1/projects/${expectedScope.projectId}/timelines/${expectedScope.timelineId}/commit`;
  await waitForAudit(harness, () => {
    const requests = harness.audit().slice(auditedBeforeCreate);
    return requests.some((request) => request.method === 'POST' && request.path === createPath)
      && requests.some((request) => request.method === 'POST' && request.path === commitPath);
  }, CEILING.timeout);
  const runtimeRequests = harness.audit().slice(auditedBeforeCreate);
  const createIndex = runtimeRequests.findIndex((request) => request.method === 'POST' && request.path === createPath);
  const initIndex = runtimeRequests.findIndex((request) => request.method === 'POST' && request.path === commitPath);
  const createRequest = runtimeRequests[createIndex];
  expect(createRequest, 'production bootstrap must create the timeline through Runtime /v1').toBeDefined();
  expect(createRequest?.status).toBe(201);
  const initRequest = runtimeRequests[initIndex];
  expect(initRequest, 'production bootstrap must submit timeline.init through Runtime /v1 commit').toBeDefined();
  expect(initRequest?.status).toBe(200);
  expect(createIndex, 'timeline creation must precede native initialization').toBeLessThan(initIndex);
  expect(runtimeRequests.filter((request) => request.method === 'POST' && SAVES.test(request.path)), 'bootstrap must emit zero legacy snapshot traffic').toEqual([]);

  const bootstrapHistory = await history(harness, seed3, expectedScope);
  // The audit deliberately records only the door's method/path/status. The
  // accepted Runtime history is the authoritative record of the init body.
  // Main's create_timeline publishes one normal empty baseline before the
  // native initialization commit. The former total=1 assertion represented
  // only the native entry; keep that contract one-to-one as baseline=1 plus
  // native-init=1, without filtering either accepted record from history.
  expect(bootstrapHistory.items).toHaveLength(2);
  const [bootstrapEntry, initEntry] = bootstrapHistory.items;
  expect((bootstrapEntry.receipt.result as { revision_id?: unknown }).revision_id).toBe(bootstrapEntry.revision_id);
  expect(bootstrapEntry).toMatchObject({
    publication_id: bootstrapEntry.receipt.receipt_id,
    previous: null,
    intent: 'bootstrap',
    records: null,
    receipt: {
      command_kind: 'parent_composition.publish',
      idempotency_key: `bootstrap:${expectedScope.timelineId}`,
      project_id: expectedScope.projectId,
      result: {
        project_id: expectedScope.projectId,
        timeline_id: expectedScope.timelineId,
        old_head: null,
        new_head: bootstrapEntry.revision_id,
      },
    },
  });
  expect(initEntry).toMatchObject({
    publication_id: initEntry.receipt.receipt_id,
    previous: { revision_id: bootstrapEntry.revision_id, publication_id: bootstrapEntry.publication_id },
    intent: 'recorded',
    receipt: {
      command_kind: 'timeline.commit',
      project_id: expectedScope.projectId,
      result: {
        canonical_document: { project_id: expectedScope.projectId, timeline_id: expectedScope.timelineId },
      },
    },
  });
  expect(bootstrapHistory.items.map((entry) => entry.receipt.command_kind)).toEqual([
    'parent_composition.publish', 'timeline.commit',
  ]);
  expect(bootstrapHistory.head).toEqual({ revision_id: initEntry.revision_id, publication_id: initEntry.publication_id });
  expect(initEntry.records?.commands.map((record) => [record.command.op, record.command.version, record.command.select])).toEqual([
    ['timeline.init', '1', 'parent'],
    ['track.create', '1', 'parent'],
    ['track.create', '1', 'parent'],
  ]);

  const originalTrackName = await firstTrackName(page).inputValue();
  const wire = await faultFirstCommit(page);
  await editFirstTrackName(page, 'Bootstrap actual consumer edit');
  await expect.poll(() => wire.posts.length, CEILING).toBe(1);
  accepted(wire.posts[0]);
  expect(JSON.parse(wire.posts[0].body)).toMatchObject({
    base_revision_id: bootstrapHistory.head.revision_id,
    commands: [expect.objectContaining({ op: 'track.update' })],
  });
  await expect.poll(async () => (await commandOutboxes(page, expectedScope.timelineId))
    .find((owner) => owner.pending?.request.key === wire.posts[0].key)?.scope, CEILING).toMatchObject(expectedScope);
  await wire.loseAck();
  await expect.poll(async () => (await commandOutboxes(page, expectedScope.timelineId)).find((owner) => owner.pending)?.pending?.outcome?.kind, CEILING).toBe('retry');

  const beforeRestart = await expectSameRealm(page, harness, astrid);
  await page.reload();
  await expectConnected(page);
  await expect(firstTrackName(page)).toHaveValue('Bootstrap actual consumer edit', CEILING);
  expect(wire.posts).toHaveLength(1);
  await page.close();

  const restarted = await harness.restartRuntime();
  expect(restarted.oldInstanceId).toBe(beforeRestart.runtimeInstanceId);
  const reopened = await context.newPage();
  sniff.attach(reopened);
  await wire.attach(reopened);
  await reopened.goto(`${harness.origin}${APP_ENTRY_ROUTE}?project=${encodeURIComponent(expectedScope.projectId)}&timeline=${encodeURIComponent(expectedScope.timelineId)}`);
  await expectConnected(reopened);
  await expect(firstTrackName(reopened)).toBeVisible(CEILING);
  expect(wire.posts).toHaveLength(1);
  const persisted = (await commandOutboxes(reopened, expectedScope.timelineId)).find((owner) => owner.pending);
  expect(persisted, 'restart must preserve the exact in-flight bootstrap consumer edit').toBeTruthy();
  await reopened.getByRole('button', { name: /^Recover saved edits/ })
    .and(reopened.locator(`[data-owner-id="${persisted!.ownerId}"]`)).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(2);
  expect(wire.posts[1]).toEqual(wire.posts[0]);
  await expect.poll(async () => (await commandOutboxes(reopened, expectedScope.timelineId)).every((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);

  await reopened.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(3);
  const inverse = accepted(wire.posts[2]);
  expect(JSON.parse(wire.posts[2].body).commands).toEqual([expect.objectContaining({ op: 'timeline.inverse' })]);
  expect(inverse.data.canonical_document.parent_revision.payload.config.tracks)
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'V1', label: originalTrackName })]));
  expect(wire.legacy, 'retry and guarded undo must never use legacy snapshot traffic').toEqual([]);
  await sniff.expectClean(reopened, expectedScope.timelineId);
  await reopened.close();
});

test('M1 real dependency conflict retains B original guards and pending identity', async ({ page, harness, astrid, seed3 }) => {
  const sniff = new TokenSniff(secretsOf(harness, astrid));
  sniff.attach(page);
  const legacy: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && SAVES.test(new URL(request.url()).pathname)) legacy.push(request.url());
  });
  await openCommandTimeline(page, harness, seed3);
  const resetResponse = page.waitForResponse((response) => response.request().method() === 'POST' && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await dragTimelineClip(page, seed3.appClipId, seed3.transitionClipId, 5, 0, THREE_PRODUCTS_REFERENCE_AT);
  const reset = await resetResponse;
  expect(reset.status(), await reset.text()).toBe(200);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).every((item) => !item.pending && !item.intents.length), CEILING).toBe(true);
  let c!: CommitAcceptedMutation;
  const { wire, before, owner } = await prepareDependentMoves(page, harness, seed3, async (a) => {
    // Change the actual guard after pointerdown, before drop; B must not recapture it.
    c = await astrid.commitCaptured(harness.seed.projectId, seed3.timelineId, pinOf(a), { kind: 'move', clipId: seed3.appClipId, on: 6 }, 'f2-dependent-C');
  });
  journey.facts.sameRealm = await expectSameRealm(page, harness, astrid);
  await wire.loseAck();
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).find((item) => item.ownerId === owner.ownerId)?.pending?.outcome?.kind, CEILING).toBe('retry');
  await page.getByRole('button', { name: 'Retry save', exact: true })
    .and(page.getByTestId('timeline-command-retry')).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(3);
  expect(wire.posts[1]).toEqual(wire.posts[0]);
  expect(wire.posts[2].status).toBe(409);
  expect(wire.posts[2].response.details.status).toBe('conflict');
  expect(wire.posts[2].response.details.reason).not.toBe('stale_head');
  const conflict = wire.posts[2].response.details.conflicts;
  expect(conflict.length, JSON.stringify(wire.posts[2].response)).toBeGreaterThan(0);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).find((item) => item.ownerId === owner.ownerId)?.pending?.outcome?.kind, CEILING).toBe('rejected');
  await expect(page.getByTestId('timeline-command-recovery')).toContainText('Your changes are retained and need resolution before they can be saved.');
  const retained = (await commandOutboxes(page, seed3.timelineId)).find((item) => item.ownerId === owner.ownerId)!;
  expect(retained.intents).toHaveLength(1);
  expect(retained.intents[0].id).toBe(owner.intents[1].id);
  expect(retained.intents[0].payload).toEqual(owner.intents[1].payload);
  expect(retained.intents[0].conflict).toBeTruthy();
  expect(retained.pending?.outcome?.kind).toBe('rejected');
  expect(retained.pending?.request.body).toBe(wire.posts[2].body);
  expect(JSON.parse(wire.posts[2].body).commands).toEqual(commandsOf(owner.intents[1].payload));
  expect(wire.posts[2].key).not.toBe(wire.posts[0].key);
  expect((await history(harness, seed3)).head.revision_id).toBe(pinOf(c).revision_id);
  expect((await history(harness, seed3)).items).toHaveLength(before.items.length + 2);
  await page.reload();
  await expectConnected(page);
  const reloaded = (await commandOutboxes(page, seed3.timelineId)).find((item) => item.ownerId === owner.ownerId)!;
  expect(reloaded.pending).toEqual(retained.pending);
  expect(reloaded.intents).toEqual(retained.intents);
  const recoverConflict = page.getByRole('button', { name: /^Recover saved edits/ })
    .and(page.locator(`[data-owner-id="${owner.ownerId}"]`));
  await expect(recoverConflict).toBeVisible(CEILING);
  await recoverConflict.click();
  await expect(page.getByTestId('timeline-command-recovery')).toContainText('Your changes are retained and need resolution before they can be saved.');
  const recoveredConflict = (await commandOutboxes(page, seed3.timelineId)).find((item) => item.ownerId === owner.ownerId)!;
  expect(recoveredConflict.intents).toEqual(retained.intents);
  expect(recoveredConflict.pending).toEqual(retained.pending);
  expect(wire.posts).toHaveLength(3);
  expect(wire.legacy).toEqual([]);
  expect(legacy, 'the reset move must also use the commit path exclusively').toEqual([]);
  await expectOpaqueDataKept(harness, seed3);
  await sniff.expectClean(page, seed3.timelineId);
});

test('M2 native occurrence duplicate: lost ACK, Agent label, local label, restart, exact retry and guarded undo', async ({ page, context, harness, astrid, seed3 }) => {
  const sniff = new TokenSniff(secretsOf(harness, astrid));
  sniff.attach(page);
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  const wire = await faultFirstCommit(page);
  await openCommandTimeline(page, harness, seed3);
  const realmBefore = await expectSameRealm(page, harness, astrid);
  const before = await history(harness, seed3);
  const beforeParent = await revisionBody(harness, before.head.revision_id);
  const beforeDocument = beforeParent.payload;
  const sourceBefore = (beforeDocument.occurrences as Array<Record<string, any>>)
    .find((occurrence) => occurrence.occurrence_id === seed3.occurrenceId)!;
  expect(sourceBefore, 'the seeded canonical occurrence is present in the raw Runtime document').toBeTruthy();
  const beforeShotResponse = await harness.runtimeJson('GET',
    `/v1/projects/${harness.seed.projectId}/shots/${seed3.shotId}/revisions/${sourceBefore.shot_revision_id}`);
  expect(beforeShotResponse.status, JSON.stringify(beforeShotResponse.body)).toBe(200);
  const beforeShot = beforeShotResponse.body as Record<string, any>;
  const beforeInternalResponse = await harness.runtimeJson('GET',
    `${timelineBase(harness, seed3)}/revisions/${beforeShot.internal_timeline_revision_id}`);
  expect(beforeInternalResponse.status, JSON.stringify(beforeInternalResponse.body)).toBe(200);
  const beforeInternal = beforeInternalResponse.body as Record<string, any>;

  const gesturePosts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') gesturePosts.push(new URL(request.url()).pathname);
  });
  const shotLabel = page.locator('[data-shot-group-key]').first();
  await expect(shotLabel, 'the real canonical occurrence is rendered as a shot group').toHaveCount(1);
  await shotLabel.click({ button: 'right' });
  await page.getByRole('button', { name: 'Duplicate shot', exact: true }).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(1);

  const duplicatePost = wire.posts[0];
  const duplicateRequest = JSON.parse(duplicatePost.body) as CommitRequest;
  expect(duplicateRequest.commands).toHaveLength(1);
  expect(duplicateRequest.commands[0]).toMatchObject({
    op: 'occurrence.duplicate', select: `occurrence:${seed3.occurrenceId}`,
    args: { occurrence_id: expect.stringMatching(new RegExp(`^${seed3.occurrenceId}-copy-`)), shot_id: expect.stringMatching(new RegExp(`^${seed3.shotId}-copy-`)) },
    intent: { ownership: 'occurrence' },
  });
  const duplicate = accepted(duplicatePost);
  const duplicateCommand = duplicateRequest.commands[0];
  const duplicateOccurrenceId = duplicateCommand.args.occurrence_id as string;
  const duplicateShotId = duplicateCommand.args.shot_id as string;
  const duplicateDocument = duplicate.data.canonical_document as any;
  const duplicateOccurrence = (duplicateDocument.parent_revision.payload.occurrences as Array<Record<string, any>>)
    .find((occurrence) => occurrence.occurrence_id === duplicateOccurrenceId)!;
  expect(duplicateOccurrence, 'the accepted document contains the new occurrence').toBeTruthy();
  expect(duplicateOccurrence.shot_id).toBe(duplicateShotId);
  for (const key of ['duration_ms', 'placement', 'source_offset', 'speed', 'track', 'transform', 'gain', 'mute', 'provenance']) {
    expect(duplicateOccurrence[key], `${key} is preserved on the copied raw occurrence`).toEqual(sourceBefore[key]);
  }
  const sourceShot = duplicateDocument.shot_revisions.find((shot) => shot.shot_id === seed3.shotId)!;
  const copiedShot = duplicateDocument.shot_revisions.find((shot) => shot.shot_id === duplicateShotId)!;
  expect(copiedShot.payload.metadata).toEqual(sourceShot.payload.metadata);
  const sourceInternal = duplicateDocument.internal_timeline_revisions.find((revision) => revision.revision_id === sourceShot.internal_timeline_revision_id)!;
  const copiedInternal = duplicateDocument.internal_timeline_revisions.find((revision) => revision.revision_id === copiedShot.internal_timeline_revision_id)!;
  const sourceOpaqueClip = sourceInternal.payload.clips.find((clip: any) => clip.id === seed3.agentClipId);
  const copiedOpaqueClip = copiedInternal.payload.clips.find((clip: any) => clip.id === seed3.agentClipId);
  expect(copiedOpaqueClip?.app?.f2Opaque, 'opaque child data survives the independent copy').toEqual(sourceOpaqueClip?.app?.f2Opaque);
  expect(duplicateDocument.parent_revision.payload.config.x_f2_opaque, 'opaque parent data survives the independent copy')
    .toEqual(seed3.opaque.config);
  expect(gesturePosts.filter((pathname) => !COMMITS.test(pathname)), 'the gesture emits no legacy graph/task save traffic').toEqual([]);

  // A disjoint Agent publication lands after the duplicate but before its ACK reaches the App.
  const agentEdit = await astrid.commitCaptured(harness.seed.projectId, seed3.timelineId, pinOf(duplicate),
    { kind: 'label', trackId: 'S1', label: 'F2 Agent duplicate sibling' }, 'f2-duplicate-agent-label');
  expect((agentEdit.data.canonical_document as any).parent_revision.payload.config.x_f2_opaque).toEqual(seed3.opaque.config);

  // B is captured over A and remains local until A's uncertain result is recovered.
  await editFirstTrackName(page, 'F2 duplicate local label');
  await expect.poll(async () => {
    const candidates = await commandOutboxes(page, seed3.timelineId);
    return candidates.find((candidate) => candidate.pending?.request.key === duplicatePost.key && candidate.intents.length === 2) ?? null;
  }, CEILING).toBeTruthy();
  const owner = (await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.pending?.request.key === duplicatePost.key)!;
  expect(commandsOf(owner.intents[0].payload)).toEqual(duplicateRequest.commands);
  expect(owner.intents[1].basis).toEqual({ after: owner.intents[0].id });
  expect(owner.intents[1].readyBase).toBeUndefined();
  expect(commandsOf(owner.intents[1].payload)).toEqual([expect.objectContaining({
    op: 'track.set', select: 'parent/track:V1', args: { values: { label: 'F2 duplicate local label' }, clear: [] },
  })]);
  await wire.loseAck();
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.ownerId === owner.ownerId)?.pending?.outcome?.kind, CEILING).toBe('retry');
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  const afterReload = (await commandOutboxes(page, seed3.timelineId)).find((candidate) => candidate.ownerId === owner.ownerId)!;
  expect(afterReload.pending?.request).toEqual(owner.pending?.request);
  expect(afterReload.intents).toEqual(owner.intents);
  expect(wire.posts).toHaveLength(1);
  await page.close();

  const restarted = await harness.restartRuntime();
  expect(restarted.oldInstanceId).toBe(realmBefore.runtimeInstanceId);
  const reopened = await context.newPage();
  sniff.attach(reopened);
  await wire.attach(reopened);
  await openApp(reopened, harness);
  await expectConnected(reopened);
  await openSeededTimeline(reopened, harness);
  const realmAfter = await expectSameRealm(reopened, harness, astrid);
  expect(realmAfter.realmId).toBe(realmBefore.realmId);
  expect(realmAfter.runtimeInstanceId).not.toBe(realmBefore.runtimeInstanceId);
  const persisted = (await commandOutboxes(reopened, seed3.timelineId)).find((candidate) => candidate.ownerId === owner.ownerId)!;
  expect(persisted.pending?.request).toEqual(owner.pending?.request);
  expect(persisted.intents).toEqual(owner.intents);
  await reopened.getByRole('button', { name: /^Recover saved edits/ })
    .and(reopened.locator(`[data-owner-id="${owner.ownerId}"]`)).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(3);
  expect(wire.posts[1], 'the retry is byte-identical after client and Runtime restart').toEqual(wire.posts[0]);
  const retriedDuplicate = accepted(wire.posts[1]);
  const localLabel = accepted(wire.posts[2]);
  expect(localLabel.data.status).toBe('rebased');
  expect(JSON.parse(wire.posts[2].body).commands).toEqual(commandsOf(owner.intents[1].payload));
  expect((localLabel.data.canonical_document as any).parent_revision.payload.config).toMatchObject({
    tracks: expect.arrayContaining([
      expect.objectContaining({ id: 'V1', label: 'F2 duplicate local label' }),
      expect.objectContaining({ id: 'S1', label: 'F2 Agent duplicate sibling' }),
    ]),
    x_f2_opaque: seed3.opaque.config,
  });
  const postRecoveryDocument = localLabel.data.canonical_document;
  expect((postRecoveryDocument.parent_revision.payload.occurrences as Array<Record<string, any>>)
    .some((occurrence) => occurrence.occurrence_id === duplicateOccurrenceId && occurrence.shot_id === duplicateShotId)).toBe(true);
  expect(retriedDuplicate.data.canonical_document).toEqual(duplicate.data.canonical_document);
  await expect.poll(async () => (await commandOutboxes(reopened, seed3.timelineId)).every((candidate) => !candidate.pending && !candidate.intents.length), CEILING).toBe(true);

  // Undo the newer local label first, then the duplicate. Both inverses are guarded and preserve the Agent edit.
  await reopened.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(4);
  const undoLabel = accepted(wire.posts[3]);
  expect(JSON.parse(wire.posts[3].body).commands).toEqual([{
    schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: [localLabel.receipt.receipt_id] },
  }]);
  expect((undoLabel.data.canonical_document as any).parent_revision.payload.config).toMatchObject({
    tracks: expect.arrayContaining([expect.objectContaining({ id: 'S1', label: 'F2 Agent duplicate sibling' })]),
  });
  expect((undoLabel.data.canonical_document.parent_revision.payload.occurrences as Array<Record<string, any>>)
    .some((occurrence) => occurrence.occurrence_id === duplicateOccurrenceId)).toBe(true);

  await reopened.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(5);
  const undoDuplicate = accepted(wire.posts[4]);
  expect(JSON.parse(wire.posts[4].body).commands).toEqual([{
    schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: [duplicate.receipt.receipt_id] },
  }]);
  const expectedPostUndoParent = structuredClone(beforeDocument) as Record<string, any>;
  const expectedIndependentTrack = (expectedPostUndoParent.config.tracks as Array<Record<string, any>>)
    .find((track) => track.id === 'S1');
  expect(expectedIndependentTrack, 'the pre-A fixture has the independent Agent track').toBeTruthy();
  expectedIndependentTrack!.label = 'F2 Agent duplicate sibling';
  const finalDocument = undoDuplicate.data.canonical_document;
  expect(finalDocument.parent_revision.payload)
    .toEqual(expectedPostUndoParent);
  expect((finalDocument.parent_revision.payload.occurrences as Array<Record<string, any>>)
    .some((occurrence) => occurrence.occurrence_id === duplicateOccurrenceId)).toBe(false);
  expect((finalDocument.parent_revision.payload.occurrences as Array<Record<string, any>>)
    .filter((occurrence) => occurrence.occurrence_id === seed3.occurrenceId)).toHaveLength(1);
  expect(finalDocument.shot_revisions).toEqual([{
    shot_id: seed3.shotId,
    revision_id: beforeShot.revision_id,
    internal_timeline_revision_id: beforeShot.internal_timeline_revision_id,
    content_digest: beforeShot.content_digest,
    payload: beforeShot.payload,
  }]);
  expect(finalDocument.internal_timeline_revisions).toEqual([{
    timeline_id: seed3.timelineId,
    revision_id: beforeInternal.revision_id,
    content_digest: beforeInternal.content_digest,
    payload: beforeInternal.payload,
  }]);
  expect(finalDocument.dependency_manifest).toEqual(beforeParent.dependency_manifest);
  expect(wire.legacy).toEqual([]);
  await expectImmutableClosure(harness, seed3, undoDuplicate);
  await expectOpaqueDataKept(harness, seed3);
  journey.facts = { ...journey.facts, sourceTuple: revisionSet(journey.identity), duplicate: { occurrenceId: duplicateOccurrenceId, shotId: duplicateShotId },
    agentEdit: pinOf(agentEdit), localLabel: pinOf(localLabel), retryKey: duplicatePost.key, legacySaveCount: wire.legacy.length };
  await sniff.expectClean(reopened, seed3.timelineId);
});

// Complements track-label-command.spec.ts: Unicode + disjoint undo there; exact retained-label recovery here.
test('M2 mixed editing: accepted pointer move and rename survive lost ACK, reload, exact recovery and guarded undo', async ({ page, harness, astrid, seed3 }) => {
  const sniff = new TokenSniff(secretsOf(harness, astrid));
  sniff.attach(page);
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  await openCommandTimeline(page, harness, seed3);
  journey.facts.sameRealm = await expectSameRealm(page, harness, astrid);
  const before = await history(harness, seed3);
  const original = await revisionState(harness, seed3, before.head.revision_id);
  const from = original.parentClips[seed3.appClipId].at as number;
  const to = from === 5 ? 7 : 5;
  const moveResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await dragTimelineClip(page, seed3.appClipId, seed3.transitionClipId, from, to, THREE_PRODUCTS_REFERENCE_AT);
  const response = await moveResponse;
  const move = accepted({ method: response.request().method(), path: new URL(response.url()).pathname,
    body: response.request().postData()!, key: response.request().headers()['idempotency-key'],
    status: response.status(), response: await response.json() });
  expect(JSON.parse(response.request().postData()!)).toMatchObject({
    base_revision_id: before.head.revision_id, base_publication_id: before.head.publication_id,
    commands: [{ op: 'clip.move', select: `parent/clip:${seed3.appClipId}`, args: { on: to } }],
  });
  expect(position(move.data.canonical_document, seed3.appClipId)).toBe(to);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId))
    .every((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);
  await expectPreviewRevision(page, pinOf(move).revision_id);
  const moved = await history(harness, seed3);
  expect(moved.head).toEqual(pinOf(move));
  expect(moved.items).toHaveLength(before.items.length + 1);
  const revisions = await allRevisions(harness, seed3);
  const trackLabel = 'F2 mixed editing retained rename';
  const wire = await faultFirstCommit(page);
  await editFirstTrackName(page, trackLabel);
  await expect.poll(() => wire.posts.length, CEILING).toBe(1);
  const rename = accepted(wire.posts[0]);
  expect(JSON.parse(wire.posts[0].body)).toMatchObject({
    base_revision_id: moved.head.revision_id, base_publication_id: moved.head.publication_id,
    commands: [{ op: 'track.set', select: 'parent/track:V1', args: { values: { label: trackLabel }, clear: [] } }],
  });
  expect(position(rename.data.canonical_document, seed3.appClipId)).toBe(to);
  expect(rename.data.canonical_document.parent_revision.payload.config).toMatchObject({
    tracks: expect.arrayContaining([expect.objectContaining({ id: 'V1', label: trackLabel })]),
    x_f2_opaque: seed3.opaque.config,
  });
  expect(rename.data.canonical_document.parent_revision.payload.occurrences)
    .toEqual(move.data.canonical_document.parent_revision.payload.occurrences);
  expect(rename.data.canonical_document.shot_revisions).toEqual(move.data.canonical_document.shot_revisions);
  expect(rename.data.canonical_document.internal_timeline_revisions).toEqual(move.data.canonical_document.internal_timeline_revisions);
  await expectImmutableClosure(harness, seed3, move);
  await expectImmutableClosure(harness, seed3, rename);

  const kept = (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.pending?.request.key === wire.posts[0].key)!;
  expect(kept.scope).toMatchObject({ realmId: harness.realmId, projectId: harness.seed.projectId, timelineId: seed3.timelineId });
  expect(kept.pending?.request).toEqual({ method: 'POST', path: `${timelineBase(harness, seed3)}/commit`,
    body: wire.posts[0].body, key: wire.posts[0].key });
  expect(commandsOf(kept.intents[0].payload)).toEqual(JSON.parse(wire.posts[0].body).commands);
  await wire.loseAck();
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.ownerId === kept.ownerId)?.pending?.outcome?.kind, CEILING).toBe('retry');
  const renamed = await history(harness, seed3);
  expect(renamed.head).toEqual(pinOf(rename));
  expect(renamed.items).toHaveLength(moved.items.length + 1);
  expect(await allRevisions(harness, seed3)).toHaveLength(revisions.length + 1);

  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  const reloaded = (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.ownerId === kept.ownerId)!;
  expect(reloaded.pending?.request).toEqual(kept.pending!.request);
  expect(reloaded.intents).toEqual(kept.intents);
  expect(wire.posts).toHaveLength(1);
  expect(await history(harness, seed3)).toEqual(renamed);
  await page.getByRole('button', { name: /^Recover saved edits/ })
    .and(page.locator(`[data-owner-id="${kept.ownerId}"]`)).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(2);
  expect(wire.posts[1], 'recovery preserves exact command bytes, guards, retry key and accepted result').toEqual(wire.posts[0]);
  await expect(firstTrackName(page)).toHaveValue(trackLabel);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).every((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);
  expect(await history(harness, seed3)).toEqual(renamed);
  await expectImmutableClosure(harness, seed3, rename);
  const pinned = await revisionState(harness, seed3, pinOf(rename).revision_id);
  expect(pinned.shotClips[seed3.agentClipId].app?.f2Opaque).toEqual(seed3.opaque.clip);
  await expectPreviewRevision(page, pinOf(rename).revision_id);
  await expectAgentRevision(astrid, harness, seed3, pinOf(rename).revision_id);

  const independent = await astrid.commitCaptured(harness.seed.projectId, seed3.timelineId, pinOf(rename),
    { kind: 'track', id: 'f2-mixed-independent' }, 'f2-mixed-independent');
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await expect(firstTrackName(page)).toHaveValue(trackLabel);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(3);
  expect(JSON.parse(wire.posts[2].body).commands).toEqual([{
    schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
    args: { publications: [pinOf(rename).publication_id] },
  }]);
  const undone = accepted(wire.posts[2]);
  expect(position(undone.data.canonical_document, seed3.appClipId)).toBe(to);
  expect(undone.data.canonical_document.parent_revision.payload.config).toMatchObject({
    x_f2_opaque: seed3.opaque.config,
    tracks: expect.arrayContaining([
      expect.objectContaining({ id: 'V1', label: original.trackLabel }),
      expect.objectContaining({ id: 'f2-mixed-independent' }),
    ]),
  });
  expect(undone.data.canonical_document.shot_revisions).toEqual(independent.data.canonical_document.shot_revisions);
  expect(undone.data.canonical_document.internal_timeline_revisions).toEqual(independent.data.canonical_document.internal_timeline_revisions);
  expect(undone.data.canonical_document.dependency_manifest).toEqual(independent.data.canonical_document.dependency_manifest);
  await expect(firstTrackName(page)).toHaveValue(original.trackLabel!);
  const finalHistory = await history(harness, seed3);
  expect(finalHistory.head).toEqual(pinOf(undone));
  expect(finalHistory.items).toHaveLength(before.items.length + 4);
  expect(finalHistory.items.find((entry) => entry.publication_id === pinOf(undone).publication_id)?.records?.undo_of)
    .toEqual([pinOf(rename).publication_id]);
  await expectImmutableClosure(harness, seed3, independent);
  await expectImmutableClosure(harness, seed3, undone);
  await expectAgentRevision(astrid, harness, seed3, pinOf(undone).revision_id);
  await expectOpaqueDataKept(harness, seed3);
  expect(wire.legacy).toEqual([]);
  journey.facts = { ...journey.facts, acceptedMove: pinOf(move), acceptedRename: pinOf(rename),
    retainedOwner: kept.ownerId, retryKey: wire.posts[0].key, guardedUndo: pinOf(undone), renderer: 'not started' };
  await sniff.expectClean(page, seed3.timelineId);
});

// Separate worker seed: the original seven cases retain their ordinary fixture and bodies.
const nativeNoneTest = test.extend<object, { seed3: ThreeProductsSeed }>({
  seed3: [async ({ harness }, use) => {
    await use(await harness.seedThreeProducts(THREE_PRODUCTS_REFERENCE_AT, 'native-none'));
  }, { scope: 'worker', timeout: 240_000 }],
});

function expectTransitionClear(request: CommitRequest, base: HeadPin, original: Record<string, any>, ids: string[]) {
  expect(request.base_revision_id).toBe(base.revision_id);
  expect(request.base_publication_id).toBe(base.publication_id);
  expect(request.commands).toHaveLength(ids.length);
  expect(request.commands.map((command) => command.select).sort()).toEqual(ids.map((id) => `parent/clip:${id}`).sort());
  for (const command of request.commands) {
    const id = command.select!.slice('parent/clip:'.length);
    expect(command).toMatchObject({ schema_version: 1, op: 'clip.set', version: '1',
      args: { values: {}, clear: ['transition'] } });
    expect(command.args).toEqual({ values: {}, clear: ['transition'] });
    expect(command.expect?.[`${command.select}::transition`]).toEqual({ state: 'present', value: original[id].transition });
    expect(command.bindings).toStrictEqual({ 'scalar.target': command.select });
    expect(command.reads!.length).toBeGreaterThan(0);
  }
}

function expectRawTransitionsCleared(actual: Record<string, any>, original: Record<string, any>, ids: string[]) {
  const expected = structuredClone(original);
  for (const clips of [expected.clips, expected.config.clips]) {
    for (const clip of clips) if (ids.includes(clip.id)) delete clip.transition;
  }
  expect(actual).toEqual(expected);
  for (const clips of [actual.clips, actual.config.clips]) {
    for (const id of ids) {
      const clip = clips.find((row: any) => row.id === id);
      expect(clip).toBeTruthy();
      expect(Object.hasOwn(clip, 'transition'), `${id}: raw ABSENT, never null or a None sentinel`).toBe(false);
      expect(Object.keys(clip)).toEqual(Object.keys(expected.clips.find((row: any) => row.id === id)));
    }
  }
}

async function expectRecordedTransitionClears(harness: DirectHarness, seed: ThreeProductsSeed,
  result: CommitAcceptedMutation, request: CommitRequest, original: Record<string, any>) {
  const records = (await history(harness, seed)).items.find((entry) => entry.publication_id === pinOf(result).publication_id)!.records!;
  expect(records.commands.map((record) => record.command)).toEqual(request.commands);
  for (const record of records.commands) {
    const id = record.command.select!.slice('parent/clip:'.length);
    expect(record.writes).toContainEqual({ ref: record.command.select, path: ['transition'],
      before: { state: 'present', value: original[id].transition }, after: { state: 'absent' } });
  }
}

async function bulkTransitionNone(page: Page, seed: ThreeProductsSeed) {
  await selectClip(page, seed.appClipId);
  await page.locator(`[data-clip-id="${seed.transitionClipId}"]`).first().click({ modifiers: ['Shift'] });
  await expect(page.getByText('2 clips selected', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Effects', exact: true }).click();
  await transitionSelect(page).click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await expect(transitionSelect(page)).toContainText('None');
}

nativeNoneTest('M2 native None single: ordinary default crossfade clears raw mirrors, reloads, retries exactly after restart and undoes through Runtime', async ({ page, harness, astrid, seed3 }) => {
  const sniff = new TokenSniff(secretsOf(harness, astrid));
  sniff.attach(page);
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  const wire = await faultFirstCommit(page);
  await openCommandTimeline(page, harness, seed3);
  journey.facts.sameRealm = await expectSameRealm(page, harness, astrid);
  const before = await history(harness, seed3);
  const original = await revisionState(harness, seed3, before.head.revision_id);
  expect(original.parentClips[seed3.transitionClipId].transition).toEqual({ type: 'crossfade', duration: 0.5 });
  await selectClip(page, seed3.transitionClipId);
  await page.getByRole('tab', { name: 'Effects', exact: true }).click();
  await expect(transitionSelect(page)).toContainText('crossfade');
  await setTransitionToNone(page, seed3.transitionClipId);
  await expect.poll(() => wire.posts.length, CEILING).toBe(1);
  const cleared = accepted(wire.posts[0]);
  expectTransitionClear(JSON.parse(wire.posts[0].body), before.head, original.parentClips, [seed3.transitionClipId]);
  expectRawTransitionsCleared(cleared.data.canonical_document.parent_revision.payload, original.parent, [seed3.transitionClipId]);
  await expectImmutableClosure(harness, seed3, cleared);
  await expectRecordedTransitionClears(harness, seed3, cleared, JSON.parse(wire.posts[0].body), original.parentClips);
  const retained = (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.pending?.request.key === wire.posts[0].key)!;
  expect(retained.intents).toHaveLength(1);
  expect(retained.pending!.request).toEqual({ method: 'POST', path: `${timelineBase(harness, seed3)}/commit`,
    body: wire.posts[0].body, key: wire.posts[0].key });
  await wire.loseAck();
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.ownerId === retained.ownerId)?.pending?.outcome?.kind, CEILING).toBe('retry');
  const acceptedHistory = await history(harness, seed3);
  expect(acceptedHistory.items).toHaveLength(before.items.length + 1);
  expect(acceptedHistory.head).toEqual(pinOf(cleared));
  const revisionCount = (await allRevisions(harness, seed3)).length;
  await harness.restartRuntime();
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  expect((await commandOutboxes(page, seed3.timelineId)).find((owner) => owner.ownerId === retained.ownerId)?.pending?.request)
    .toEqual(retained.pending!.request);
  expect(wire.posts).toHaveLength(1);
  expectRawTransitionsCleared((await revisionState(harness, seed3, pinOf(cleared).revision_id)).parent, original.parent, [seed3.transitionClipId]);
  await page.getByRole('button', { name: /^Recover saved edits/ }).and(page.locator(`[data-owner-id="${retained.ownerId}"]`)).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(2);
  expect(wire.posts[1], 'exact bytes, key, receipt and accepted closure survive reload and Runtime restart').toEqual(wire.posts[0]);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).every((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);
  expect(await history(harness, seed3)).toEqual(acceptedHistory);
  expect(await allRevisions(harness, seed3)).toHaveLength(revisionCount);
  await selectClip(page, seed3.transitionClipId);
  await expect(transitionSelect(page)).toContainText('None');
  await expectPreviewRevision(page, pinOf(cleared).revision_id);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(3);
  expect(JSON.parse(wire.posts[2].body).commands).toEqual([{
    schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
    args: { publications: [pinOf(cleared).publication_id] },
  }]);
  const undone = accepted(wire.posts[2]);
  expect(undone.data.canonical_document.parent_revision.payload).toEqual(original.parent);
  expect(undone.data.canonical_document.shot_revisions).toEqual(cleared.data.canonical_document.shot_revisions);
  expect(undone.data.canonical_document.internal_timeline_revisions).toEqual(cleared.data.canonical_document.internal_timeline_revisions);
  const finalHistory = await history(harness, seed3);
  expect(finalHistory.items).toHaveLength(before.items.length + 2);
  expect(finalHistory.items.find((entry) => entry.publication_id === pinOf(undone).publication_id)?.records?.undo_of)
    .toEqual([pinOf(cleared).publication_id]);
  await expectImmutableClosure(harness, seed3, undone);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).every((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await selectClip(page, seed3.transitionClipId);
  await page.getByRole('tab', { name: 'Effects', exact: true }).click();
  await expect(transitionSelect(page)).toContainText('crossfade');
  const unavailableTarget = await expectFreshPreviewUnavailable(page, astrid, harness, seed3, pinOf(undone).revision_id);
  expect((await revisionState(harness, seed3, pinOf(undone).revision_id)).parent).toEqual(original.parent);
  await expectOpaqueDataKept(harness, seed3);
  expect(wire.legacy).toEqual([]);
  journey.facts = { ...journey.facts, cleared: pinOf(cleared), undone: pinOf(undone), unavailableTarget,
    renderer: 'not started', legacySaveCount: 0 };
  await sniff.expectClean(page, seed3.timelineId);
});

nativeNoneTest('M2 native None bulk: one original-basis atomic clear preserves unknown revision and opaque data; real conflict retains the whole draft', async ({ page, harness, astrid, seed3 }) => {
  const sniff = new TokenSniff(secretsOf(harness, astrid));
  sniff.attach(page);
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  const wire = await faultFirstCommit(page);
  await openCommandTimeline(page, harness, seed3);
  journey.facts.sameRealm = await expectSameRealm(page, harness, astrid);
  const before = await history(harness, seed3);
  const original = await revisionState(harness, seed3, before.head.revision_id);
  const ids = [seed3.appClipId, seed3.transitionClipId];
  expect(original.parentClips[seed3.appClipId].transition.revision).toBe('native-none-unknown-revision');
  expect(Object.hasOwn(original.parentClips[seed3.appClipId].transition.params, '__proto__')).toBe(true);
  await bulkTransitionNone(page, seed3);
  await expect.poll(() => wire.posts.length, CEILING).toBe(1);
  const cleared = accepted(wire.posts[0]);
  expectTransitionClear(JSON.parse(wire.posts[0].body), before.head, original.parentClips, ids);
  const owner = (await commandOutboxes(page, seed3.timelineId)).find((item) => item.pending?.request.key === wire.posts[0].key)!;
  expect(owner.intents, 'one atomic intent owns both commands').toHaveLength(1);
  expect(commandsOf(owner.intents[0].payload)).toEqual(JSON.parse(wire.posts[0].body).commands);
  expectRawTransitionsCleared(cleared.data.canonical_document.parent_revision.payload, original.parent, ids);
  await expectImmutableClosure(harness, seed3, cleared);
  await expectRecordedTransitionClears(harness, seed3, cleared, JSON.parse(wire.posts[0].body), original.parentClips);
  await wire.loseAck();
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).find((item) => item.ownerId === owner.ownerId)?.pending?.outcome?.kind, CEILING).toBe('retry');
  await page.getByRole('button', { name: 'Retry save', exact: true }).and(page.getByTestId('timeline-command-retry')).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(2);
  expect(wire.posts[1]).toEqual(wire.posts[0]);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).every((item) => !item.pending && !item.intents.length), CEILING).toBe(true);
  expect((await history(harness, seed3)).items).toHaveLength(before.items.length + 1);
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  for (const id of ids) {
    await selectClip(page, id);
    await page.getByRole('tab', { name: 'Effects', exact: true }).click();
    await expect(transitionSelect(page)).toContainText('None');
  }
  expectRawTransitionsCleared((await revisionState(harness, seed3, pinOf(cleared).revision_id)).parent, original.parent, ids);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => wire.posts.length, CEILING).toBe(3);
  expect(JSON.parse(wire.posts[2].body).commands).toEqual([{
    schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
    args: { publications: [pinOf(cleared).publication_id] },
  }]);
  const undone = accepted(wire.posts[2]);
  expect(undone.data.canonical_document.parent_revision.payload).toEqual(original.parent);
  const restored = (undone.data.canonical_document.parent_revision.payload.clips as Array<Record<string, any>>)
    .find((clip) => clip.id === seed3.appClipId)!;
  expect(Object.hasOwn(restored.transition, '__proto__')).toBe(true);
  expect(Object.hasOwn(restored.transition.params, '__proto__')).toBe(true);
  expect(Object.keys(restored.transition)).toEqual(Object.keys(original.parentClips[seed3.appClipId].transition));
  await expectImmutableClosure(harness, seed3, undone);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).every((item) => !item.pending && !item.intents.length), CEILING).toBe(true);
  await openCommandTimeline(page, harness, seed3);
  expect((await revisionState(harness, seed3, pinOf(undone).revision_id)).parent).toEqual(original.parent);

  // Capture both clears first, then change one guarded leaf with the real Agent.
  const hold = await holdCommandRequests(page);
  await bulkTransitionNone(page, seed3);
  await expect.poll(() => hold.requests.length, CEILING).toBe(1);
  const pending = (await commandOutboxes(page, seed3.timelineId)).find((item) => item.pending)!;
  expect(pending.intents).toHaveLength(1);
  expectTransitionClear(JSON.parse(pending.pending!.request.body), pinOf(undone), original.parentClips, ids);
  const concurrent = await astrid.commitCaptured(harness.seed.projectId, seed3.timelineId, pinOf(undone),
    { kind: 'clear-transition', clipId: seed3.appClipId }, 'f2-native-none-conflict');
  const atConflict = await history(harness, seed3);
  expect(atConflict.items).toHaveLength(before.items.length + 3);
  const revisionsAtConflict = await allRevisions(harness, seed3);
  const response = page.waitForResponse((reply) => reply.request().method() === 'POST' && COMMITS.test(new URL(reply.url()).pathname), CEILING);
  await hold.release(true);
  const rejected = await response;
  expect(rejected.status()).toBe(409);
  const error = await rejected.json();
  expect(error.details.status).toBe('conflict');
  expect(error.details.reason).not.toBe('stale_head');
  expect(error.details.conflicts.length).toBeGreaterThan(0);
  expect(rejected.request().postData()).toBe(pending.pending!.request.body);
  expect(rejected.request().headers()['idempotency-key']).toBe(pending.pending!.request.key);
  await expect.poll(async () => (await commandOutboxes(page, seed3.timelineId)).find((item) => item.ownerId === pending.ownerId)?.pending?.outcome?.kind, CEILING).toBe('rejected');
  const retained = (await commandOutboxes(page, seed3.timelineId)).find((item) => item.ownerId === pending.ownerId)!;
  expect(retained.intents).toHaveLength(1);
  expect(retained.intents[0].id).toBe(pending.intents[0].id);
  expect(retained.intents[0].payload).toEqual(pending.intents[0].payload);
  expect(retained.intents[0].basis).toEqual(pending.intents[0].basis);
  expect(retained.intents[0].conflict).toBeTruthy();
  expect(retained.pending!.request).toEqual(pending.pending!.request);
  expect(await history(harness, seed3)).toEqual(atConflict);
  expect(await allRevisions(harness, seed3)).toEqual(revisionsAtConflict);
  expect(atConflict.head).toEqual(pinOf(concurrent));
  expectRawTransitionsCleared(concurrent.data.canonical_document.parent_revision.payload, original.parent, [seed3.appClipId]);
  await expectImmutableClosure(harness, seed3, concurrent);
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  const reloaded = (await commandOutboxes(page, seed3.timelineId)).find((item) => item.ownerId === pending.ownerId)!;
  expect(reloaded.pending).toEqual(retained.pending);
  expect(reloaded.intents).toEqual(retained.intents);
  await page.getByRole('button', { name: /^Recover saved edits/ }).and(page.locator(`[data-owner-id="${pending.ownerId}"]`)).click();
  await expect(page.getByTestId('timeline-command-recovery')).toContainText('Your changes are retained and need resolution before they can be saved.');
  for (const id of ids) {
    await selectClip(page, id);
    await page.getByRole('tab', { name: 'Effects', exact: true }).click();
    await expect(transitionSelect(page)).toContainText('None');
  }
  expect((await commandOutboxes(page, seed3.timelineId)).find((item) => item.ownerId === pending.ownerId)?.pending).toEqual(retained.pending);
  expect(wire.posts).toHaveLength(3);
  expect(await history(harness, seed3)).toEqual(atConflict);
  await expectOpaqueDataKept(harness, seed3);
  expect(wire.legacy).toEqual([]);
  journey.facts = { ...journey.facts, cleared: pinOf(cleared), undone: pinOf(undone), concurrent: pinOf(concurrent),
    retainedOwner: pending.ownerId, renderer: 'not started', legacySaveCount: 0 };
  await sniff.expectClean(page, seed3.timelineId);
});

// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
// 2b. render R, publish R+1 before it runs (F2 steps 3 and 4)

/** The three moments compared: frames near 1 s, 3 s (the middle of the agent's slot) and 5 s of the 6 s film. */
const SAMPLE_SECONDS = [1, 3, 5] as const;

/** A task row, whichever envelope the door answers it in. */
const dataOf = (body: any) => body?.data ?? body;

/** What the preview showed at a moment: where the playhead observed itself, and the picture. */
interface PreviewShot { seconds: number; seek: RulerSeek; png: Buffer; surface: { width: number; height: number }; composition: Rect }

/**
 * The editor's preview at the playhead. The preview's own evidence is what is waited on: each decoded video clip exposes the
 * player frame that was current when its decoder last drew (`data-preview-presented-frame`, ReadinessVideo), so the capture
 * starts when a clip has presented the frame the ruler click asked for. There is no quiet period and no frame counting.
 */
async function capturePreview(page: Page, seconds: number, seek: RulerSeek, outputDir: string, name: string): Promise<PreviewShot> {
  const surface = page.locator(PREVIEW_SURFACE);
  await expect(surface.locator(`[data-preview-presented-frame="${seek.observedFrame}"]`), `a clip of the preview presented frame ${seek.observedFrame} for ${name}`).toBeAttached(CEILING);
  // The composition box is Remotion's player element: the surface also holds the bars around it.
  const geometry = await surface.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const player = element.querySelector('.__remotion-player');
    if (!player) throw new Error('the preview surface has no .__remotion-player');
    const inner = player.getBoundingClientRect();
    return { surface: { width: box.width, height: box.height }, composition: { x: inner.left - box.left, y: inner.top - box.top, width: inner.width, height: inner.height } };
  });
  // The preview's overlay (timeline picker, time, Render) and the transport buttons lie over the picture; the picture is what is compared.
  const png = await surface.screenshot({
    animations: 'disabled',
    style: '[data-video-editor-shell-region="preview"] > [data-shell-interaction="true"], .astrid-preview-transport { visibility: hidden !important; }',
    path: path.join(outputDir, `${name}.png`),
  });
  return { seconds, seek, png, ...geometry };
}

/** The finished film's player: seek to a moment, wait for its frame, and take the element's picture (without the native control bar, which lies over it). */
async function captureFilm(player: Locator, atSeconds: number, outputDir: string, name: string) {
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState), { message: 'the player has loaded its metadata', ...CEILING }).toBeGreaterThanOrEqual(1);
  const presented = await player.evaluate((video: HTMLVideoElement, at: number) => new Promise<{ mediaTime: number }>((resolve, reject) => {
    if (Math.abs(video.currentTime - at) < 1e-6) { reject(new Error('the player is already at the moment to sample: no seek, so no new frame')); return; }
    video.pause();
    video.controls = false;
    let seeked = false;
    let frame: { mediaTime: number } | null = null;
    const finish = () => { if (seeked && frame) resolve(frame); };
    // The callback is registered before the seek: a paused video presents nothing until the seek's frame.
    video.requestVideoFrameCallback((_now, metadata) => { frame = { mediaTime: metadata.mediaTime }; finish(); });
    video.addEventListener('seeked', () => { seeked = true; finish(); }, { once: true });
    video.currentTime = at;
  }), atSeconds);
  const geometry = await player.evaluate((video: HTMLVideoElement) => {
    const box = video.getBoundingClientRect();
    return { box: { width: box.width, height: box.height }, natural: { width: video.videoWidth, height: video.videoHeight } };
  });
  const png = await player.screenshot({ animations: 'disabled', path: path.join(outputDir, `${name}.png`) });
  return { png, mediaTime: presented.mediaTime, ...geometry, picture: letterbox(geometry.natural, geometry.box) };
}

const rounded = (difference: GridDifference) => ({ meanPerChannel: difference.meanPerChannel.map((value) => Number(value.toFixed(2))), worstCell: Number(difference.worstCell.toFixed(2)) });

test('render R, publish R+1 before it runs: the render is R\'s, it plays, and it is the film the App showed', async ({ page, harness, astrid }, testInfo) => {
  const sniff = new TokenSniff(secretsOf(harness, astrid));
  sniff.attach(page);
  const reads = watchPageReads(page, harness);
  const outputDir = path.join(testInfo.outputDir, 'render-journey');
  mkdirSync(outputDir, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 1000 });

  // This browser plays what the render is: H.264 High 4.0 and AAC-LC in MP4. Without that the case could not tell a bad film from a browser that cannot play it.
  const codecs = await page.evaluate(() => ({
    h264: document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"'),
    aac: document.createElement('audio').canPlayType('audio/mp4; codecs="mp4a.40.2"'),
  }));
  expect(codecs.h264, 'this browser must play H.264 High 4.0 (avc1.640028); the journey runs in installed Chrome').toBe('probably');
  expect(codecs.aac, 'this browser must play AAC-LC (mp4a.40.2); the journey runs in installed Chrome').toBe('probably');

  const render = await harness.seedRenderTimeline();
  const agent = agentOf(astrid, render);
  const timeline = { fps: render.fps, startLeft: getTimelineLabelWidth('desktop'), lastClipSelector: render.occurrenceBlockSelector };
  const filmResponses: Array<{ url: string; status: number; contentRange: string | null }> = [];
  page.on('response', (response) => {
    if (response.url().includes('/v1/objects/')) filmResponses.push({ url: response.url(), status: response.status(), contentRange: response.headers()['content-range'] ?? null });
  });
  const renderBlockers = page.locator('[data-video-editor-render-blocker]');
  const player = page.getByRole('dialog', { name: 'Rendered film' }).getByTestId('timeline-render-player');

  let revisionR = '';
  let revisionR1 = '';
  let taskId = '';
  const previewShots: PreviewShot[] = [];
  let negative: PreviewShot | undefined;

  await test.step('3 render R, publish R+1 before the render runs: the render is R\'s', async () => {
    // a. One worker hosts the marker and the renderer. Remotion is not provisioned here, and rendering.render is still ready.
    await astrid.host({ register: true, render: true });
    const catalog = await harness.runtimeJson('GET', '/v1/capabilities?limit=200');
    expect(catalog.status, JSON.stringify(catalog.body)).toBe(200);
    const row = (catalog.body as any).items.find((item: any) => item.capability_id === 'rendering.render');
    expect(row, 'the Runtime lists rendering.render').toBeTruthy();
    expect({ status: row.status, unavailable_reason: row.unavailable_reason }, 'rendering.render is ready on a host without Remotion').toEqual({ status: 'ready', unavailable_reason: null });

    // The App is open on the render timeline before the agent publishes, so that it can adopt R by itself.
    await openApp(page, harness);
    await expectConnected(page);
    await openSeededTimeline(page, harness);
    journey.facts.sameRealm = await expectSameRealm(page, harness, astrid);
    await page.getByRole('combobox', { name: 'Select timeline' }).click();
    await page.getByRole('option', { name: render.timelineName }).click();
    await expect(page.getByRole('combobox', { name: 'Select timeline' })).toContainText(render.timelineName);
    await expect(page.locator(render.occurrenceBlockSelector)).toBeVisible(CEILING);
    await plantNoReloadFlag(page);

    // b. The marker is a task's output: a 2 s clip of the fixed marker colour (the one case 1 makes in this realm too), so what the film shows at 3 s is its own, not the grey placeholder's.
    const created = await astrid.json<{ task_id: string }>(['tasks', 'create', '--project', render.projectSlug, '--capability', 'f2.marker', '--spec', '{}', '--json']);
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const markerTask = created.data!.task_id;
    const ran = await astrid.host({ runOnce: true, render: true });
    expect(ran).toMatchObject({ task_id: markerTask, state: 'succeeded' });
    const clip = ran.outputs?.find((candidate) => candidate.name === 'marker_clip');
    expect(clip, 'the task produced its marker clip').toBeTruthy();
    expect(clip!.ordinal, 'and the Runtime numbered it').toEqual(expect.any(Number));

    // c. The agent fills the slot with it and publishes R. The open App adopts R by itself.
    await agent.checkout();
    await agent.edit('--clip', render.slotClipId, '--swap-asset', `${render.markerAssetKey}=task:${markerTask}/marker_clip#${clip!.ordinal}`);
    const publishedR = await agent.publish('agent: marker clip in the slot', 'f2-render-r');
    expect(publishedR.old_head, 'R builds on the seed').toBe(render.headRevisionId);
    revisionR = publishedR.new_head;
    await expect.poll(() => reads.urls.some((url) => url.includes(`/composition-revisions/${revisionR}`)), { message: 'the App read R', ...CEILING }).toBe(true);
    expect(await noReloadFlag(page), 'the App adopted R without a reload').toBe(true);

    // d. What the App's preview shows near 1 s, 3 s and 5 s: the playhead's own observed time, and the picture.
    const calibration = await calibrateRuler(page, timeline);
    for (const seconds of SAMPLE_SECONDS) {
      const seek = await seekRulerToFrame(page, calibration, seconds * render.fps, render.fps, `${seconds} s`);
      expect(seek.observedFrame, `the playhead reached the frame at ${seconds} s`).toBe(seconds * render.fps);
      if (seconds === 3) await expect(page.locator(`${PREVIEW_SURFACE} [data-preview-decoded-frame="true"][data-preview-media-src*="${encodeURIComponent(clip!.object_id)}"]`)).toBeAttached(CEILING);
      previewShots.push(await capturePreview(page, seconds, seek, outputDir, `preview-${seconds}s-R`));
    }
    await expect(renderBlockers, 'no blocker is shown: the Runtime\'s seam check only advises render admission, whatever the cuts at 2 s and 4 s').toHaveCount(0);

    // e. Render. No host is running, so the task is admitted and waits; the order is made by the setup, not by timing.
    const admitted = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/v1/tasks') && response.request().postDataJSON()?.capability_id === 'rendering.render', CEILING);
    await page.getByRole('button', { name: 'Render', exact: true }).click();
    const admission = await admitted;
    expect(admission.status(), await admission.text()).toBeLessThan(300);
    const admittedBody = dataOf(await admission.json());
    taskId = admittedBody.task_id ?? admittedBody.task?.id;
    expect(taskId, 'the App\'s render request named a task').toBeTruthy();
    expect(admission.request().postDataJSON().spec.params, 'the App leaves the renderer to the host').not.toHaveProperty('selector');
    await expect(renderBlockers).toHaveCount(0);

    // f. Before the render can run, the agent puts the placeholder back and publishes R+1 on R. The App adopts R+1; its preview is the negative control.
    const eventsBefore = await harness.runtimeJson('GET', '/v1/events?limit=200');
    expect(eventsBefore.status, JSON.stringify(eventsBefore.body)).toBe(200);
    await agent.checkout();
    await agent.edit('--clip', render.slotClipId, '--swap-asset', `f2-render-grey=${render.placeholder.digest}`);
    const publishedR1 = await agent.publish('agent: placeholder back in the slot', 'f2-render-r1');
    expect(publishedR1.old_head, 'R+1 builds on R').toBe(revisionR);
    revisionR1 = publishedR1.new_head;
    expect(revisionR1).not.toBe(revisionR);
    await expect.poll(() => reads.urls.some((url) => url.includes(`/composition-revisions/${revisionR1}`)), { message: 'the App read R+1', ...CEILING }).toBe(true);
    // Same zoom, same film length: the calibration made for R still maps the ruler to time.
    const seekAfter = await seekRulerToFrame(page, calibration, 3 * render.fps, render.fps, '3 s on R+1');
    await expect(page.locator(`${PREVIEW_SURFACE} [data-preview-decoded-frame="true"][data-preview-media-src*="${encodeURIComponent(render.placeholder.objectId)}"]`)).toBeAttached(CEILING);
    await expect(page.locator(`${PREVIEW_SURFACE} [data-preview-media-src*="${encodeURIComponent(clip!.object_id)}"]`), 'the marker clip is gone from the preview').toHaveCount(0);
    negative = await capturePreview(page, 3, seekAfter, outputDir, 'preview-3s-R1');
    Object.assign(journey.facts, { taskId, revisionR, revisionR1 });

    // g. Now the host runs. It claims the task the App admitted.
    const rendered = await astrid.host({ runOnce: true, render: true });
    expect(rendered, 'the host rendered the task the App admitted').toMatchObject({ task_id: taskId, state: 'succeeded' });

    // h. The Runtime's record: the render is R's, the host chose its renderer, and R, the admission and R+1 happened in that order.
    const task = await harness.runtimeJson('GET', `/v1/tasks/${taskId}`);
    expect(task.status, JSON.stringify(task.body)).toBe(200);
    const record = dataOf(task.body);
    const authority = record.spec.spec.inputs.timeline_authority;
    expect(authority.parent_revision_id, 'the render is pinned to R').toBe(revisionR);
    expect(authority.parent_revision_id, 'and not to R+1').not.toBe(revisionR1);
    expect(record.result.renderer_selection, 'the host chose ffmpeg because Remotion is not available').toMatchObject({ selector: 'rendering.ffmpeg', chosen_by: 'host', remotion_ok: false });
    journey.facts.rendererSelection = record.result.renderer_selection;
    const history = (await allRevisions(harness, render)).map((revision) => revision.revision_id);
    expect(history.indexOf(revisionR1), 'R+1 is newer than R in the Runtime\'s history').toBeLessThan(history.indexOf(revisionR));
    expect(history.indexOf(revisionR), 'R is newer than the seed').toBeLessThan(history.indexOf(render.headRevisionId));
    const feed = await harness.runtimeJson('GET', `/v1/events?aggregate_id=${encodeURIComponent(taskId)}&limit=200`);
    expect(feed.status, JSON.stringify(feed.body)).toBe(200);
    const admissionSequence = Math.min(...((feed.body as any).items as Array<{ sequence: number }>).map((event) => event.sequence));
    const latestBeforeR1 = Math.max(...((eventsBefore.body as any).items as Array<{ sequence: number }>).map((event) => event.sequence));
    expect(admissionSequence, 'the task was admitted before the agent published R+1 (the event feed\'s latest sequence at that moment)').toBeLessThanOrEqual(latestBeforeR1);
    journey.facts.admissionSequence = admissionSequence;

    // i. The marker is in the film: the centre of the picture at 3 s is the task's colour, and not the placeholder's grey.
    await expect(page.getByRole('dialog', { name: 'Rendered film' })).toBeVisible(CEILING);
    const shot3 = previewShots.find((shot) => shot.seconds === 3)!;
    const frame = await captureFilm(player, shot3.seek.observedTime + 0.5 / render.fps, outputDir, 'film-3s-marker');
    const centre = centreCell(await pictureGrid(page, frame.png, frame.picture, frame.box));
    const marker = [...Buffer.from(astrid.markerColor, 'hex')];
    expect(Math.max(...centre.map((value, channel) => Math.abs(value - marker[channel]))), `the film's centre at 3 s is the marker colour ${astrid.markerColor}: ${centre.map(Math.round)}`).toBeLessThanOrEqual(8);
    const grey = [render.placeholderGrey.r, render.placeholderGrey.g, render.placeholderGrey.b];
    expect(Math.hypot(...centre.map((value, channel) => value - grey[channel])), 'and it is far from the placeholder grey').toBeGreaterThanOrEqual(60);
    journey.facts.centreCellOfFilmAt3s = centre.map((value) => Number(value.toFixed(1)));
  });

  await test.step('4 the render plays, and it is the film the App showed', async () => {
    // a. The App opened the finished film; its source is the door's content URL of the task's output.
    const task = dataOf((await harness.runtimeJson('GET', `/v1/tasks/${taskId}`)).body);
    const output = (task.result.outputs as Array<{ digest: string; object_id?: string; media_type: string; size: number }>).find((candidate) => String(candidate.media_type).startsWith('video'));
    expect(output, 'the task produced a film').toBeTruthy();
    await expect(page.getByRole('dialog', { name: 'Rendered film' })).toBeVisible(CEILING);
    // The door answers the same Runtime routes under two prefixes; the App's render result uses its own (`/api/astrid`).
    const doorOrigin = new URL(harness.doorBase).origin;
    const objectRoute = `/v1/objects/${encodeURIComponent(output!.object_id ?? output!.digest)}`;
    const expectedSrc = (await player.getAttribute('src'))!;
    expect(['astrid', 'runtime'].map((prefix) => `${doorOrigin}/api/${prefix}${objectRoute}`), 'the player\'s source is the door\'s content URL of the task\'s output').toContain(expectedSrc);
    await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState), { message: 'the player loaded the film', ...CEILING }).toBeGreaterThanOrEqual(1);

    // b. The door serves ranges: the player's own requests were 206 with a Content-Range, and so is a probe of 1 KiB at an offset.
    const playerRanges = filmResponses.filter((response) => response.url === expectedSrc && response.status === 206 && response.contentRange);
    expect(playerRanges.length, 'the player\'s own requests were answered 206 with a Content-Range').toBeGreaterThan(0);
    const probe = await page.evaluate(async (src) => {
      const response = await fetch(src, { headers: { Range: 'bytes=1024-2047' } });
      return { status: response.status, contentRange: response.headers.get('content-range'), bytes: (await response.arrayBuffer()).byteLength };
    }, expectedSrc);
    expect(probe.status).toBe(206);
    expect(probe.contentRange).toBe(`bytes 1024-2047/${output!.size}`);
    expect(probe.bytes).toBe(1024);

    // c, d. The film at each moment the preview showed, compared through the same pipeline as the preview's picture.
    const rows: Array<{ seconds: number; previewTime: number; filmTime: number; difference: GridDifference }> = [];
    let film3: PictureGrid | undefined;
    let aspect = { film: 0, preview: 0 };
    for (const shot of previewShots) {
      const frame = await captureFilm(player, shot.seek.observedTime + 0.5 / render.fps, outputDir, `film-${shot.seconds}s`);
      expect(Math.abs(frame.mediaTime - shot.seek.observedTime), `the player presented the frame at ${shot.seconds} s`).toBeLessThan(1 / render.fps);
      const filmGrid = await pictureGrid(page, frame.png, frame.picture, frame.box);
      const difference = gridDifference(filmGrid, await pictureGrid(page, shot.png, shot.composition, shot.surface));
      rows.push({ seconds: shot.seconds, previewTime: shot.seek.observedTime, filmTime: frame.mediaTime, difference });
      Object.assign(journey.facts, { frameDifferences: { match: rows.map((row) => ({ seconds: row.seconds, previewTime: row.previewTime, filmTime: row.filmTime, ...rounded(row.difference) })) } });
      expect(matches(difference), `the film at ${shot.seconds} s is the preview's picture: ${JSON.stringify(rounded(difference))} against ${JSON.stringify(MATCH)}`).toBe(true);
      if (shot.seconds === 3) film3 = filmGrid;
      aspect = { film: frame.natural.width / frame.natural.height, preview: shot.composition.width / shot.composition.height };
    }
    expect(aspect.film, 'the render has the preview\'s aspect ratio').toBeCloseTo(aspect.preview, 1);

    // The negative control: the film is not the preview of R+1, so the comparison can tell R from R+1.
    const teeth = gridDifference(film3!, await pictureGrid(page, negative!.png, negative!.composition, negative!.surface));
    Object.assign(journey.facts, { frameDifferences: { match: rows.map((row) => ({ seconds: row.seconds, previewTime: row.previewTime, filmTime: row.filmTime, ...rounded(row.difference) })), negativeControl: rounded(teeth) } });
    expect(matches(teeth), `the film at 3 s is not the preview of R+1: ${JSON.stringify(rounded(teeth))} must exceed ${JSON.stringify(MATCH)}`).toBe(false);

    // e. Sound, decoded from the same URL: the tone is in the film.
    const loudness = await page.evaluate(async (src) => {
      const response = await fetch(src);
      const audio = await new OfflineAudioContext(1, 1, 48_000).decodeAudioData(await response.arrayBuffer());
      let sum = 0;
      let count = 0;
      for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
        const samples = audio.getChannelData(channel);
        for (let index = Math.floor(0.5 * audio.sampleRate); index < Math.min(samples.length, Math.floor(5.5 * audio.sampleRate)); index += 1) { sum += samples[index] * samples[index]; count += 1; }
      }
      return 20 * Math.log10(Math.sqrt(sum / Math.max(1, count)));
    }, expectedSrc);
    expect(loudness, 'the film is audible between 0.5 s and 5.5 s (dBFS)').toBeGreaterThan(-40);

    // f. Its length is the timeline's: a content check, not a timing check.
    const duration = await player.evaluate((video: HTMLVideoElement) => video.duration);
    expect(Math.abs(duration - render.durationSeconds), 'the film is as long as the timeline, within a frame').toBeLessThanOrEqual(1 / render.fps);

    // g. Reported, never judged.
    Object.assign(journey.facts, { loudnessDbfs: Number(loudness.toFixed(1)), filmSeconds: duration });
  });

  await sniff.expectClean(page);
});

// QUICK: F1 owns the realm and Runtime; this case attaches the App and real Astrid CLI to that one timeline.

test('quick: Astrid edit then App edit are visible and readable on the adopted timeline', async ({ page, harness, quickAstrid }) => {
  const descriptor = harness.attachment;
  const seed = harness.quickSeed;
  expect(descriptor, 'the quick descriptor selected the attached harness').toBeTruthy();
  expect(seed, 'the adopted project and timeline are available').toBeTruthy();
  const quickSeed = { timelineId: seed!.timelineId, projectSlug: seed!.projectSlug };
  const agent = agentOf(quickAstrid, quickSeed);
  const sniff = new TokenSniff(secretsOf(harness, quickAstrid));
  sniff.attach(page);
  const reads = watchPageReads(page, harness);

  await openApp(page, harness);
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  const sameRealm = await expectSameRealm(page, harness, quickAstrid);
  expect(sameRealm.realmId).toBe(descriptor!.realmId);
  expect(sameRealm.runtimeInstanceId).toBe(descriptor!.runtimeInstanceId);
  expect(sameRealm.astridFile).toContain('astrid');

  const baseRevisionId = descriptor!.headRevisionId;
  const base = await revisionBody(harness, baseRevisionId);
  const clips = (base.payload.clips ?? []) as Array<Record<string, any>>;
  expect(clips.length, 'the fixture has an editable media clip').toBeGreaterThan(0);
  const clip = clips[0];
  const mediaId = base.payload.registry.assets[clip.asset].media_id as string;
  const mediaUrl = `${harness.doorBase}/v1/objects/${encodeURIComponent(mediaId)}`;
  const preview = page.getByTestId('video-editor-preview-surface');
  const decodedFrame = preview.locator('[data-preview-media-src]');
  const renderedClip = preview.locator('[data-astrid-retry-token]');
  await expect(decodedFrame, 'the preview contains the fixture media source').toHaveCount(1);
  await expect(decodedFrame).toHaveAttribute('data-preview-media-src', mediaUrl);
  await expect(decodedFrame, 'Chromium decoded the fixture media').toHaveAttribute('data-preview-decoded-frame', 'true');
  await expect(renderedClip, 'one fixture media surface is rendered').toHaveCount(1);
  await expect(renderedClip).toBeVisible();
  await expect(renderedClip).toHaveCSS('opacity', '1');

  await agent.checkout();
  await agent.edit('--clip', String(clip.id), '--set', 'opacity=0.5');
  const astridPublished = await agent.publish('Quick Astrid edit', `quick-astrid-${descriptor!.timelineId}`);
  expect(astridPublished.old_head).toBe(baseRevisionId);
  const astridRevisionId = astridPublished.new_head;
  await expect.poll(async () => (await currentHead(harness)), { message: 'the App observes Astrid’s published revision', timeout: 0 }).toBe(astridRevisionId);
  await expect.poll(() => reads.compositionRevisions.some((item) => item.id === astridRevisionId && item.payload?.clips?.some((candidate: any) => candidate.id === clip.id && candidate.opacity === 0.5)), { message: 'the editor reads Astrid’s edited clip content', timeout: 0 }).toBe(true);
  await expect(renderedClip, 'Astrid’s opacity edit is visible in the rendered editor').toHaveCSS('opacity', '0.5', { timeout: 0 });

  const appLabel = 'QUICK App edit';
  const appSaved = page.waitForResponse((response) => response.request().method() === 'POST' && SAVES.test(new URL(response.url()).pathname), CEILING);
  await editFirstTrackName(page, appLabel);
  const saveResponse = await appSaved;
  expect(saveResponse.ok(), `App save returned ${saveResponse.status()}`).toBe(true);
  expect(saveResponse.request().postDataJSON().expected_head).toBe(astridRevisionId);
  const saveEnvelope = await saveResponse.json();
  const savedRevisionId = saveEnvelope.data?.new_head as string;
  expect(savedRevisionId, 'the App response identifies its saved revision').toBeTruthy();
  expect(saveEnvelope.data?.old_head).toBe(astridRevisionId);
  expect(savedRevisionId).not.toBe(astridRevisionId);
  expect(await currentHead(harness)).toBe(savedRevisionId);

  const status = await agent.status();
  const show = await agent.show();
  expect(status.current_head).toBe(savedRevisionId);
  expect(show.head_revision_id).toBe(savedRevisionId);
  const lineage = (await allRevisions(harness, quickSeed)).map((revision) => revision.revision_id);
  expect(lineage.indexOf(savedRevisionId)).toBeGreaterThanOrEqual(0);
  expect(lineage.indexOf(savedRevisionId)).toBeLessThan(lineage.indexOf(astridRevisionId));
  expect(lineage.indexOf(astridRevisionId)).toBeLessThan(lineage.indexOf(baseRevisionId));
  const astridRead = await quickAstrid.readTimelineBundle(seed!.timelineId, seed!.projectSlug, savedRevisionId);
  expect(astridRead.revisionId).toBe(savedRevisionId);
  const labels = ((astridRead.bundle.parent as Record<string, any>).config.tracks as Array<Record<string, any>>).map((track) => track.label);
  expect(labels).toContain(appLabel);

  const revisions = revisionSet(journey.identity);
  const observedRevisions = { app: revisions.appHead, astrid: revisions.astridHead, runtime: revisions.runtimeHead };
  expect(observedRevisions).toEqual(descriptor!.revisions);
  const result = { realmId: sameRealm.realmId, runtimeInstanceId: sameRealm.runtimeInstanceId, baseRevisionId, astridRevisionId, savedRevisionId,
    astridParentRevisionId: astridPublished.old_head, appParentRevisionId: saveEnvelope.data.old_head as string, astridLabel: 'Quick Astrid edit', appLabel, revisions: observedRevisions };
  mkdirSync(path.dirname(descriptor!.resultFile), { recursive: true });
  writeFileSync(descriptor!.resultFile, JSON.stringify(result, null, 2));
  journey.facts = { ...journey.facts, ...result };
  await sniff.expectClean(page);
});

test('empty bootstrap: creating the first timeline in a fresh project then dropping an image records one App-source commit', async ({ page, harness }) => {
  const fresh = await harness.createFreshProject();
  const catalogPath = `/v1/projects/${fresh.projectId}/timelines`;
  const before = await harness.runtimeJson<any>('GET', `${catalogPath}?limit=50`);
  expect(before.status, JSON.stringify(before.body)).toBe(200);
  expect(before.body.items).toEqual([]);

  await openApp(page, harness);
  await expectConnected(page);
  // Automatic setup uses the same action. Refuse its first attempt before it
  // reaches Runtime, leaving a fresh project for the visible retry button.
  let automaticAttempt = true;
  await page.route(`**/api/runtime${catalogPath}`, async (route) => {
    if (route.request().method() === 'POST' && automaticAttempt) {
      automaticAttempt = false;
      await route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ code: 'unavailable', message: 'Transient setup failure', request_id: 'fx4' }) });
    } else await route.continue();
  });
  const retiredWrites: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes(catalogPath) && request.url().endsWith('/composition-revisions')) retiredWrites.push(request.url());
  });
  await page.goto(`${harness.origin}${APP_ENTRY_ROUTE}?project=${fresh.projectId}`);
  const createFirst = page.getByRole('button', { name: 'Create first timeline' });
  await expect.poll(() => automaticAttempt).toBe(false);
  await expect(createFirst).toBeEnabled();
  expect((await harness.runtimeJson<any>('GET', `${catalogPath}?limit=50`)).body.items).toEqual([]);
  await createFirst.click();
  await expect(page.getByRole('combobox', { name: 'Select timeline' })).toContainText('Main');
  await expect(createFirst).toHaveCount(0);
  expect(retiredWrites).toEqual([]);
  const catalog = await harness.runtimeJson<any>('GET', `${catalogPath}?limit=50`);
  expect(catalog.body.items).toHaveLength(1);
  const empty = catalog.body.items[0];
  const base = `${catalogPath}/${empty.timeline_id}`;
  const initial = await harness.runtimeJson<HistoryPage>('GET', `${base}/commits?limit=50`);
  expect(initial.status, JSON.stringify(initial.body)).toBe(200);
  expect(initial.body.items).toHaveLength(1);
  expect(initial.body.items[0].intent).toBe('bootstrap');
  const initialRevision = await harness.runtimeJson<any>('GET', `${base}/composition-revisions/${initial.body.head.revision_id}`);
  expect(initialRevision.status, JSON.stringify(initialRevision.body)).toBe(200);
  const initialPayload = initialRevision.body.payload;
  expect(initialPayload.clips ?? initialPayload.config?.clips).toEqual([]);
  expect(initialPayload.tracks ?? initialPayload.config?.tracks).toEqual([]);
  await expect(page.getByRole('textbox', { name: 'Track name' })).toHaveCount(0);
  await expect(page.locator('.timeline-wrapper')).toBeVisible();

  const file = {
    name: 'drop-on-empty.png',
    type: 'image/png',
    bytesBase64: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGP4EKDxnxLMMGrAqAGjBgwXAwCCv2cf+oH0twAAAABJRU5ErkJggg==',
  };
  const wrapper = page.locator('.timeline-wrapper').first();
  const box = await wrapper.boundingBox();
  if (!box || box.width < 20 || box.height < 20) throw new Error('Cannot measure empty timeline drop target');
  await page.evaluate(({ name, type, bytesBase64, x, y }) => {
    const target = document.querySelector<HTMLElement>('.timeline-wrapper');
    if (!target) throw new Error('Mounted timeline wrapper is missing');
    const bytes = Uint8Array.from(atob(bytesBase64), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name, { type }));
    for (const eventType of ['dragover', 'drop'] as const) {
      target.dispatchEvent(new DragEvent(eventType, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: transfer }));
    }
  }, { ...file, x: box.x + Math.min(80, box.width / 3), y: box.y + box.height / 2 });

  let after!: HistoryPage;
  await expect.poll(async () => {
    const response = await harness.runtimeJson<HistoryPage>('GET', `${base}/commits?limit=50`);
    if (response.status !== 200) return false;
    after = response.body;
    const added = after.items.filter((entry) => !initial.body.items.some((old) => old.publication_id === entry.publication_id));
    return added.filter((entry) => entry.source?.via === 'app').length;
  }, { timeout: CEILING.timeout }).toBe(1);

  const added = after.items.filter((entry) => !initial.body.items.some((old) => old.publication_id === entry.publication_id));
  expect(added).toHaveLength(1);
  expect(added[0].source?.via).toBe('app');

  const canonicalReply = await harness.runtimeJson<any>('GET', `${base}/composition-revisions/${after.head.revision_id}`);
  expect(canonicalReply.status, JSON.stringify(canonicalReply.body)).toBe(200);
  const payload = canonicalReply.body.payload;
  const clips = payload.clips ?? payload.config?.clips;
  const tracks = payload.tracks ?? payload.config?.tracks;
  expect(clips).toHaveLength(1);
  const clip = clips[0] as Record<string, any>;
  expect(clip).toMatchObject({ clipType: 'hold', hold: 5 });
  expect(typeof clip.asset).toBe('string');
  expect(typeof clip.track).toBe('string');
  expect(tracks).toEqual([expect.objectContaining({ id: clip.track, kind: 'visual' })]);

  const assets = payload.registry?.assets ?? payload.config?.registry?.assets;
  const asset = assets?.[clip.asset];
  expect(asset).toMatchObject({ type: 'image/png' });
  expect(typeof asset.media_id).toBe('string');
  const object = await harness.runtimeFetch(`/v1/objects/${encodeURIComponent(asset.media_id)}`);
  expect(object.status).toBe(200);
  expect(Array.from(new Uint8Array(await object.arrayBuffer()).slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
});

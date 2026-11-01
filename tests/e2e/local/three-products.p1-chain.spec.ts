/** P1: the mounted App's local split -> trim chain through the durable v2 save session. */
import { expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { CommitRequest } from '../../../src/integrations/runtime/timeline-commit-types.ts';
import { APP_ENTRY_ROUTE, commandOutboxes, expectConnected, firstTrackName, openSeededTimeline, test as appTest } from './support/app.ts';
import { ASTRID_PYTHON, AstridCli } from './support/astrid.ts';
import { harnessUnavailableReason, PRODUCT_ACTOR, type DirectHarness } from './support/harness.ts';
import {
  diagnosticObservedVisibility,
  diagnosticListener,
  logDiagnostic,
  logPriorityDiagnostic,
  redactDiagnosticText,
  boundedDiagnosticRead,
  DIAGNOSTIC_ARTIFACT_TIMEOUT_MS,
  DIAGNOSTIC_COLLECTION_TIMEOUT_MS,
  DIAGNOSTIC_READ_TIMEOUT_MS,
  MOUNTED_DIAGNOSTIC_MAX_RECORDS,
  mountedDiagnosticInitScript,
  withDiagnosticDeadline,
  writeDiagnosticArtifact,
} from './p1-diagnostic-safety.ts';

const CEILING = { timeout: 90_000 };
const COMMITS = /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/;
const LEGACY_WRITES = /\/timelines\/[^/]+\/composition-revisions$/;
const SOURCE_ID = 'p1-chain-source';
const SPLIT_AT = 2;

type ChainSeed = { projectSlug: string; timelineId: string; sourceId: string };
type CommitPost = { body: CommitRequest; raw: string; key: string; status?: number; response?: any };
type DiagnosticReadonlyTraffic = {
  method: string;
  route: string;
  status?: number;
  reply?: unknown;
};
type DiagnosticWireHead = {
  method: string;
  route: string;
  key: string | null;
  status: number;
  head: { revisionId: string; publicationId: string | null } | null;
  replyReadFailed: boolean;
};
type DiagnosticRequestProjection = {
  index: number;
  method: string;
  route: string;
  status: number | null;
  bodyProjection: { present: boolean; bytes: number; sameAsPrevious: boolean | null };
  keyProjection: { present: boolean; bytes: number; sameAsPrevious: boolean | null };
};
type DiagnosticSourceWindow = {
  rightId: string;
  sourceIn: {
    value: string | 'UNKNOWN';
    numericValue: number | 'UNKNOWN';
    visible: boolean | 'UNKNOWN';
  };
  selectedClip: {
    identity: Record<string, string | null> | 'UNKNOWN';
    visible: boolean | 'UNKNOWN';
    status: string | 'UNKNOWN';
    text: string | 'UNKNOWN';
  };
};
type P1DiagnosticTrace = {
  pageErrors: string[];
  consoleErrors: Array<{ type: string; signal: DiagnosticErrorSignal; message: string; location: unknown }>;
  requestFailures: Array<{ method: string; route: string; error: string | null }>;
  wireHeads: DiagnosticWireHead[];
  requestProjections: DiagnosticRequestProjection[];
  failureContext?: unknown;
  projectId?: string;
  timelineId?: string;
  sourceWindow?: { before: DiagnosticSourceWindow; after: DiagnosticSourceWindow };
};
const diagnosticTraces = new WeakMap<Page, P1DiagnosticTrace>();

const test = appTest.extend<object, { astrid: AstridCli }>({
  astrid: async ({ harness }, use) => {
    const client = await AstridCli.create(harness);
    await client.preflight();
    await use(client);
  },
});
test.beforeAll(() => {
  const reason = harnessUnavailableReason();
  if (reason) throw new Error(`P1 chain cannot run: ${reason}`);
});
test.beforeEach(async ({ page }, testInfo) => {
  const trace: P1DiagnosticTrace = { pageErrors: [], consoleErrors: [], requestFailures: [], wireHeads: [], requestProjections: [] };
  diagnosticTraces.set(page, trace);
  const buffer = testInfo?.title?.includes('real Agent move') ? 'case2' : 'case1';
  const addInitScript = (page as Page & { addInitScript?: (script: { content: string }) => Promise<void> }).addInitScript;
  if (typeof addInitScript === 'function') {
    await addInitScript.call(page, { content: mountedDiagnosticInitScript({
      buffer,
      maxRecords: MOUNTED_DIAGNOSTIC_MAX_RECORDS,
    }) });
  }
  page.on('pageerror', diagnosticListener((error) => boundedPush(trace.pageErrors, redactDiagnosticText(error.message))));
  page.on('console', diagnosticListener((message) => {
    const text = message.text();
    if (message.type() !== 'error' && !/save|commit|outbox|recover/i.test(text)) return;
    // Console locations may contain private paths or URL credentials.
    const location = 'UNKNOWN';
    boundedPush(trace.consoleErrors, {
      type: message.type(),
      signal: classifyDiagnosticError(text),
      message: redactDiagnosticText(text),
      location,
    });
  }));
  page.on('requestfailed', diagnosticListener((request) => {
    let path: string;
    try { path = new URL(request.url()).pathname; } catch { return; }
    const route = diagnosticRoute(path);
    if (!route) return;
    boundedPush(trace.requestFailures, {
      method: request.method(),
      route,
      error: request.failure()?.errorText ? redactDiagnosticText(request.failure()!.errorText!) : null,
    });
  }));
  page.on('response', diagnosticListener((response) => {
    let path: string;
    try { path = new URL(response.url()).pathname; } catch { return; }
    if (!COMMITS.test(path)) return;
    const scope = path.match(/^\/api\/(?:runtime|astrid)\/v1\/projects\/([^/]+)\/timelines\/([^/]+)\/commit$/);
    if (scope) {
      trace.projectId = scope[1];
      trace.timelineId = scope[2];
    }
    const wire: DiagnosticWireHead = {
      method: response.request().method(),
      route: diagnosticRoute(path) ?? '/unknown',
      key: response.request().headers()['idempotency-key'] ?? null,
      status: response.status(),
      head: null,
      replyReadFailed: false,
    };
    boundedPush(trace.wireHeads, wire);
    void response.json().then((body) => { wire.head = diagnosticHead(body); }).catch(() => { wire.replyReadFailed = true; });
  }));
});

function pin(result: any) {
  return { revision_id: result.data.accepted_revision_id, publication_id: result.receipt.receipt_id };
}

function parentOf(result: any) {
  return result.data.canonical_document.parent_revision.payload;
}

function assertV2Request(post: CommitPost, harness: DirectHarness, seed: ChainSeed) {
  const body = post.body as any;
  expect(body).toMatchObject({
    api_version: 1,
    project_id: harness.seed.projectId,
    timeline_id: seed.timelineId,
    base_revision_id: expect.any(String),
    base_publication_id: expect.any(String),
    commands: expect.any(Array),
    label: expect.any(String),
    steps: expect.any(Array),
    merge: expect.stringMatching(/^(fields|atomic)$/),
    dry_run: false,
  });
  for (const step of body.steps) {
    expect(step).toMatchObject({ id: expect.any(String), label: expect.any(String), intent: expect.any(String),
      tags: expect.any(Array), command_ordinals: expect.any(Array), patch: expect.any(Array) });
    if ('reads' in step) expect(step.reads).toEqual(expect.any(Array));
  }
  if ('reads' in body) expect(body.reads).toEqual(expect.any(Array));
  expect(post.key).toBeTruthy();
}

function assertSuccessfulReply(post: Pick<CommitPost, 'status' | 'response'>, label: string) {
  const body = post.response && typeof post.response === 'object' ? post.response as Record<string, any> : {};
  const details = body.details && typeof body.details === 'object' ? body.details as Record<string, any> : {};
  const nestedError = body.error && typeof body.error === 'object' ? body.error as Record<string, any> : {};
  const code = [body.code, details.code, nestedError.code].find((value) => typeof value === 'string');
  const path = [details.path, body.path, nestedError.path].find((value) => Array.isArray(value));
  const hint = [details.hint, body.hint, nestedError.hint].find((value) => typeof value === 'string');
  const hasStructuredData = body.data !== null && typeof body.data === 'object' && !Array.isArray(body.data);
  if (post.status !== 200 || !hasStructuredData) {
    logDiagnostic(`P1 ${label} structural reply diagnostic`, {
      status: post.status ?? null,
      ...(code === undefined ? {} : { code }),
      ...(path === undefined ? {} : { path }),
      ...(hint === undefined ? {} : { hint }),
    });
  }
  expect(post.status, `${label} expected HTTP 200`).toBe(200);
  expect(hasStructuredData, `${label} expected structured success data`).toBe(true);
}

function assertAcceptedData(result: any, post: CommitPost, status: 'accepted' | 'merged') {
  expect(result).toMatchObject({ data: { status, canonical_document: expect.any(Object), document_digest: expect.any(String),
    commands: expect.any(Array), id_map: expect.any(Object), provider_version: expect.any(String),
    compiler_version: expect.any(String), merge_mode: expect.stringMatching(/^(fields|atomic)$/), steps: expect.any(Array) },
    receipt: { receipt_id: expect.any(String), idempotency_key: post.key, request_hash: expect.any(String) } });
  expect(result.data).not.toHaveProperty('dependencies');
  expect(result.data.steps).toEqual(expect.any(Array));
  for (const step of result.data.steps) expect(step).toMatchObject({ id: expect.any(String), label: expect.any(String),
    intent: expect.any(String), tags: expect.any(Array), command_ordinals: expect.any(Array), patch: expect.any(Array), dependencies: expect.any(Array) });
  expect(result.receipt.result).toEqual(result.data);
}

async function seedOneClip(harness: DirectHarness, astrid: AstridCli): Promise<ChainSeed> {
  const timelineId = randomUUID();
  const clip = {
    id: SOURCE_ID, at: 0, track: 'V1', clipType: 'media', asset: 'p1-video', from: 0, to: 8, speed: 1, hold: 8,
    app: { opaque: { keep: null, ordered: [false, 0, ''] }, astrid: { for: 8 }, 'org.example': { literal: SOURCE_ID, clear: null } },
  };
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  const created = await harness.runtimeJson('POST', `/v1/projects/${harness.seed.projectId}/timelines`, { timeline_id: timelineId, name: 'P1 chain' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bootstrap = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${timelineId}`);
  expect(bootstrap.status, JSON.stringify(bootstrap.body)).toBe(200);
  const baseRevisionId = bootstrap.body.head_revision_id;
  const basePublicationId = bootstrap.body.head_publication_id;
  expect(baseRevisionId).toEqual(expect.any(String));
  expect(basePublicationId).toEqual(expect.any(String));

  const source = await harness.runtimeFetch(`/v1/objects/${encodeURIComponent(harness.seed.video.objectId)}`);
  expect(source.status).toBe(200);
  const imported = await harness.runtimeFetch(`/v1/projects/${harness.seed.projectId}/media-imports`, {
    method: 'POST',
    headers: {
      'Content-Type': harness.seed.video.mediaType,
      'Idempotency-Key': randomUUID(),
      'X-Original-Name': harness.seed.video.mediaType === 'video/webm' ? 'p1-video.webm' : 'p1-video.mp4',
      'X-Media-Duration-Seconds': '12',
    },
    body: new Uint8Array(await source.arrayBuffer()),
  });
  const importedBody = await imported.json() as any;
  expect(imported.status, JSON.stringify(importedBody)).toBe(201);
  const importedData = importedBody.data ?? importedBody;
  const selection = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/media-selection?asset=${encodeURIComponent(importedData.variant_id)}&generation_id=${encodeURIComponent(importedData.generation_id)}&variant_id=${encodeURIComponent(importedData.variant_id)}`);
  expect(selection.status, JSON.stringify(selection.body)).toBe(200);
  const pin = selection.body.data ?? selection.body;
  expect(pin).toMatchObject({ asset: importedData.variant_id, object_id: harness.seed.video.objectId });
  const verified = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/media-selection/verified?asset=${encodeURIComponent(pin.asset)}&generation_id=${encodeURIComponent(pin.generation_id)}&variant_id=${encodeURIComponent(pin.variant_id)}&object_id=${encodeURIComponent(pin.object_id)}&catalog_digest=${encodeURIComponent(pin.catalog_digest)}`);
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);

  const authoredPayload = {
    slug: 'main', name: 'P1 chain',
    config: {
      output: { resolution: '1280x720', fps: 30, file: 'out.mp4' },
      clips: [clip], tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }],
      opaque: { root: null, order: [0, false] },
    },
    registry: { assets: {
      'p1-video': { file: harness.seed.video.mediaType === 'video/webm' ? 'p1-video.webm' : 'p1-video.mp4',
        type: harness.seed.video.mediaType, duration: 8, media_id: harness.seed.video.objectId, content_sha256: harness.seed.video.digest },
    } },
    clips: [clip], occurrences: [],
  };
  const idempotencyKey = randomUUID();
  const run = await astrid.python(['-c', String.raw`
import copy, json, sys
from astrid.sdk.client import AstridClient
from astrid.sdk.timeline._command_state import CommandError
from astrid.sdk.timeline.capture import capture_track_create
from astrid.sdk.timeline.commands import execute
from astrid.sdk.timeline.emitter import emit_document_commands
from astrid.sdk.timeline.native_initialize import capture_initialize
from astrid.sdk.timeline.native_parent_media_commands import capture_clip_add_media

case = json.loads(sys.argv[1])
with AstridClient.open_from_launcher(start_pack_host=False, client_name="p1-seed") as client:
    opened = client.timelines.open_bundle(case["project_id"], case["timeline_id"], revision_id=case["base_revision_id"], publication_id=case["base_publication_id"])
    if not opened.ok:
        raise RuntimeError(str(opened.error))
    bundle = opened.data["bundle"]
    verified = [case["verified"]]
    commands = []

    def add(command):
        global bundle
        bundle = execute(bundle, [command], verified_media=verified).bundle
        commands.append(command)

    add(capture_initialize(bundle, name="P1 chain", slug="main", output={
        "resolution": "1280x720", "fps": 30, "file": "output.mp4",
        "background": None, "background_scale": None,
    }))
    add(capture_track_create(bundle, "parent", {"id": "V1", "kind": "visual", "label": "V1"}))
    try:
        capture_clip_add_media(bundle, case["clip"], case["pin"], verified_media=verified)
    except CommandError as exc:
        if exc.kind != "unsupported_timing":
            raise RuntimeError(f"native relation guard changed kind: {exc.kind}") from exc
    else:
        raise RuntimeError("native relation guard unexpectedly accepted app.astrid.for")

    supported_clip = copy.deepcopy(case["clip"])
    supported_clip["app"]["astrid"].pop("for")
    add(capture_clip_add_media(bundle, supported_clip, case["pin"], verified_media=verified))

    before = copy.deepcopy(bundle)
    after = copy.deepcopy(bundle)
    after["parent"]["slug"] = case["payload"]["slug"]
    after["parent"]["name"] = case["payload"]["name"]
    after["parent"]["config"] = copy.deepcopy(case["payload"]["config"])
    after["parent"]["registry"] = copy.deepcopy(case["payload"]["registry"])
    after["parent"]["clips"] = copy.deepcopy(case["payload"]["clips"])
    patches = emit_document_commands(before, after)
    if patches:
        bundle = execute(before, patches, verified_media=verified).bundle
        commands.extend(patches)

    expected_parent = copy.deepcopy(case["payload"])
    expected_parent.pop("occurrences")
    if bundle["parent"] != expected_parent:
        raise RuntimeError("native seed changed the authored P1 payload")
    steps = [{"id": f"seed-{index + 1}", "label": "Seed P1 chain", "intent": "Initialize P1 chain fixture",
              "tags": ["bootstrap"], "command_ordinals": [index],
              "patch": copy.deepcopy(command.get("args", {}).get("changes", [])) if command["op"] == "doc.patch" else []}
             for index, command in enumerate(commands)]
    body = {
        "api_version": 1, "project_id": case["project_id"], "timeline_id": case["timeline_id"],
        "base_revision_id": case["base_revision_id"], "base_publication_id": case["base_publication_id"],
        "commands": commands, "label": "Seed P1 chain", "steps": steps, "merge": "atomic", "reads": [],
        "dry_run": False, "source": {"via": "python"},
    }
    result = client.timelines.commit(case["project_id"], case["timeline_id"], body, idempotency_key=case["idempotency_key"])
    if not result.ok:
        raise RuntimeError(str(result.error))
    data = result.data
    receipt = result.as_dict()["receipt"]
    document = data["canonical_document"]
    parent = document["parent_revision"]
    manifest = document["dependency_manifest"]
    if data["status"] != "accepted":
        raise RuntimeError(f"seed commit was not accepted: {data['status']}")
    if (data["base_revision_id"], data["base_publication_id"]) != (case["base_revision_id"], case["base_publication_id"]):
        raise RuntimeError("seed acknowledgement changed its requested base pair")
    if (data["previous_revision_id"], data["previous_publication_id"]) != (case["base_revision_id"], case["base_publication_id"]):
        raise RuntimeError("accepted seed does not immediately follow its Runtime bootstrap")
    if data["rebased_onto"] is not None or data["accepted_revision_id"] != parent["revision_id"]:
        raise RuntimeError("seed acknowledgement has an invalid accepted revision identity")
    if (receipt["command_kind"], receipt["project_id"], receipt["idempotency_key"]) != (
            "timeline.commit", case["project_id"], case["idempotency_key"]):
        raise RuntimeError("seed acknowledgement has an invalid publication receipt identity")
    if receipt["receipt_id"] == case["base_publication_id"] or receipt["result"] != data:
        raise RuntimeError("seed publication receipt is not bound to its accepted result")
    if (document["schema_version"], document["project_id"], document["timeline_id"]) != (
            1, case["project_id"], case["timeline_id"]):
        raise RuntimeError("seed canonical document has the wrong Runtime scope")
    if set(document) != {"schema_version", "project_id", "timeline_id", "parent_revision",
                         "shot_revisions", "internal_timeline_revisions", "dependency_manifest"}:
        raise RuntimeError("seed canonical document is incomplete")
    if set(parent) != {"revision_id", "content_digest", "payload"} or not isinstance(parent["content_digest"], str):
        raise RuntimeError("seed canonical parent image is incomplete")
    if document["shot_revisions"] != [] or document["internal_timeline_revisions"] != []:
        raise RuntimeError("seed unexpectedly created child closure roots")
    expected_media = {"media_id": case["pin"]["object_id"], "content_digest": case["pin"]["object_id"]}
    if manifest != {"shots": [], "internal_timelines": [], "media": [expected_media], "documents": []}:
        raise RuntimeError("seed dependency manifest is not the Runtime-derived media-only closure")
    if parent["payload"] != case["payload"]:
        raise RuntimeError("Runtime canonical document changed the authored P1 payload")
    print(json.dumps({"head_revision_id": data["accepted_revision_id"], "publication_id": receipt["receipt_id"]}))
`, JSON.stringify({
    project_id: harness.seed.projectId, timeline_id: timelineId, base_revision_id: baseRevisionId, base_publication_id: basePublicationId,
    clip, payload: authoredPayload, pin, verified: verified.body.data ?? verified.body, idempotency_key: idempotencyKey,
  })]);
  const seeded = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}') as { head_revision_id?: string; publication_id?: string };
  expect(seeded.head_revision_id).toEqual(expect.any(String));
  expect(seeded.publication_id).toEqual(expect.any(String));
  const project = await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}`);
  return { projectSlug: (project.body.data ?? project.body).slug, timelineId, sourceId: SOURCE_ID };
}

async function history(harness: DirectHarness, seed: ChainSeed) {
  const result = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

function observe(page: Page, captureReadonlyTraffic = false) {
  const posts: CommitPost[] = [];
  const legacy: string[] = [];
  const readonlyTraffic: DiagnosticReadonlyTraffic[] = [];
  const readonlyByRequest = new Map<unknown, DiagnosticReadonlyTraffic>();
  page.on('request', diagnosticListener((request) => {
    if (!captureReadonlyTraffic && request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      if (COMMITS.test(path)) {
        const raw = request.postData() ?? '';
        const key = request.headers()['idempotency-key'];
        const previous = posts.at(-1);
        const trace = diagnosticTraces.get(page);
        posts.push({ body: JSON.parse(raw || '{}'), raw, key });
        if (trace) boundedPush(trace.requestProjections, {
          index: posts.length - 1,
          method: request.method(),
          route: diagnosticRoute(path) ?? '/unknown',
          status: null,
          bodyProjection: {
            present: raw.length > 0,
            bytes: new TextEncoder().encode(raw).length,
            sameAsPrevious: previous ? previous.raw === raw : null,
          },
          keyProjection: {
            present: typeof key === 'string' && key.length > 0,
            bytes: typeof key === 'string' ? new TextEncoder().encode(key).length : 0,
            sameAsPrevious: previous ? previous.key === key : null,
          },
        });
      }
      if (LEGACY_WRITES.test(path)) legacy.push(path);
    }
    const route = captureReadonlyTraffic ? diagnosticRoute(path) : undefined;
    if (route && !COMMITS.test(path)) {
      const record = { method: request.method(), route };
      boundedPush(readonlyTraffic, record);
      readonlyByRequest.set(request, record);
    }
  }));
  page.on('response', diagnosticListener((response) => {
    if (!COMMITS.test(new URL(response.url()).pathname)) return;
    const post = [...posts].reverse().find((candidate) => candidate.key === response.request().headers()['idempotency-key']);
    if (!post) return;
    post.status = response.status();
    const trace = diagnosticTraces.get(page);
    const projection = trace?.requestProjections.find((item) => item.keyProjection.present
      && item.keyProjection.bytes === new TextEncoder().encode(post.key).length
      && posts[item.index] === post);
    if (projection) projection.status = response.status();
    void response.json().then((body) => { post.response = body; }).catch(() => {});
  }));
  page.on('response', diagnosticListener((response) => {
    const record = readonlyByRequest.get(response.request());
    if (!record) return;
    record.status = response.status();
    void response.json().then((body) => { record.reply = body; }).catch(() => {});
  }));
  return { posts, legacy, readonlyTraffic };
}

type P1FailureSignals = {
  pageErrors: string[];
  consoleErrors: string[];
  requestFailures: Array<{ method: string; route: string; error: string | null }>;
};

async function openChain(page: Page, harness: DirectHarness, seed: ChainSeed, failureSignals?: P1FailureSignals) {
  const runtimeResponses: RuntimeDiagnosticResponse[] = [];
  const pageErrors: DiagnosticErrorSignal[] = [];
  const consoleErrors: DiagnosticErrorSignal[] = [];
  page.on('response', diagnosticListener((response) => {
    const method = diagnosticMethod(response.request().method());
    const status = diagnosticStatus(response.status());
    let route: DiagnosticRoute | undefined;
    try { route = diagnosticRoute(new URL(response.url()).pathname); } catch { return; }
    if (method && status !== undefined && route) boundedPush(runtimeResponses, { method, route, status });
  }));
  page.on('pageerror', diagnosticListener((error) => {
    boundedPush(pageErrors, classifyDiagnosticError(error.message));
    if (failureSignals) boundedPush(failureSignals.pageErrors, redactDiagnosticText(error.message));
  }));
  page.on('console', diagnosticListener((message) => {
    if (message.type() === 'error') {
      boundedPush(consoleErrors, classifyDiagnosticError(message.text()));
      if (failureSignals) boundedPush(failureSignals.consoleErrors, redactDiagnosticText(message.text()));
    }
  }));
  if (failureSignals) {
    page.on('requestfailed', diagnosticListener((request) => {
      let route: DiagnosticRoute | undefined;
      try { route = diagnosticRoute(new URL(request.url()).pathname); } catch { return; }
      if (!route) return;
      boundedPush(failureSignals.requestFailures, {
        method: request.method(), route, error: request.failure()?.errorText ? redactDiagnosticText(request.failure()!.errorText!) : null,
      });
    }));
  }
  try {
    await page.goto(`${harness.origin}${APP_ENTRY_ROUTE}?localProject=${encodeURIComponent(seed.projectSlug)}&localTimeline=${encodeURIComponent(seed.timelineId)}`);
    await expectConnected(page);
    await expect(firstTrackName(page)).toBeVisible();
    await expect.poll(async () => (await commandOutboxes(page, seed.timelineId)).some((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);
  } catch (error) {
    try {
      await openChainDiagnostics(page, seed.timelineId, runtimeResponses, pageErrors, consoleErrors);
    } catch {
      // Failure-only diagnostics must never replace the original assertion failure.
    }
    throw error;
  }
}

async function setPlayhead(page: Page, seconds: number) {
  const ruler = page.getByTestId('timeline-ruler');
  const labels = ruler.locator('[data-testid="timeline-ruler-labels"] span');
  const marks = await labels.evaluateAll((nodes) => nodes.map((node) => ({ text: node.textContent?.trim() ?? '', box: node.getBoundingClientRect().toJSON() })));
  const parsed = marks.map((mark) => {
    const match = mark.text.match(/^(\d+):(\d\d)\.(\d\d)$/);
    return match ? { seconds: Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 100, box: mark.box } : null;
  }).filter((mark): mark is { seconds: number; box: DOMRect } => mark !== null);
  const zero = parsed.find((mark) => mark.seconds === 0);
  const anchor = parsed.find((mark) => mark.seconds > 0);
  expect(zero, 'the real timeline ruler must expose a zero-time anchor').toBeTruthy();
  expect(anchor, 'the real timeline ruler must expose a second time anchor').toBeTruthy();
  const pixelsPerSecond = (anchor!.box.x - zero!.box.x) / anchor!.seconds;
  await page.mouse.click(zero!.box.x - 6 + seconds * pixelsPerSecond, (await ruler.boundingBox())!.y + 15);
}

async function splitSource(page: Page, seed: ChainSeed) {
  await page.locator(`.clip-action[data-clip-id="${seed.sourceId}"]`).click();
  await setPlayhead(page, SPLIT_AT);
  await page.keyboard.press('s');
}

async function sourceWindowSnapshot(page: Page, clipId: string, input: any): Promise<DiagnosticSourceWindow> {
  const sourceIn: DiagnosticSourceWindow['sourceIn'] = { value: 'UNKNOWN', numericValue: 'UNKNOWN', visible: 'UNKNOWN' };
  try {
    const snapshots = await input.evaluateAll((nodes: Element[]) => nodes.slice(0, 2).map((node) => {
      const element = node as HTMLInputElement;
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        attached: node.isConnected,
        visible: style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0,
        value: element.value,
      };
    }));
    sourceIn.visible = diagnosticObservedVisibility(snapshots);
    if (snapshots.length === 1 && snapshots[0].attached) {
      const value = snapshots[0].value;
      sourceIn.value = redactDiagnosticText(value);
      const numericValue = Number(value);
      sourceIn.numericValue = value.trim() !== '' && Number.isFinite(numericValue) ? numericValue : 'UNKNOWN';
    }
  } catch {
    sourceIn.visible = 'UNKNOWN';
    sourceIn.value = 'UNKNOWN';
    sourceIn.numericValue = 'UNKNOWN';
  }

  const selectedClip = page.locator(`.clip-action[data-clip-id="${clipId}"]`);
  let identity: DiagnosticSourceWindow['selectedClip']['identity'] = 'UNKNOWN';
  let status: DiagnosticSourceWindow['selectedClip']['status'] = 'UNKNOWN';
  let text: DiagnosticSourceWindow['selectedClip']['text'] = 'UNKNOWN';
  try {
    const snapshots = await selectedClip.evaluateAll((nodes: Element[]) => nodes.slice(0, 2).map((node) => {
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return {
        attached: node.isConnected,
        visible: style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0,
        identity: {
          tagName: node.tagName,
          id: node.id || null,
          clipId: node.getAttribute('data-clip-id'),
          testId: node.getAttribute('data-testid'),
          ariaSelected: node.getAttribute('aria-selected'),
          className: typeof node.className === 'string' ? node.className : null,
        },
        status: node.getAttribute('data-status') ?? node.getAttribute('data-state') ?? 'UNKNOWN',
        text: node.textContent?.trim() ?? '',
      };
    }));
    const visibility = diagnosticObservedVisibility(snapshots);
    if (snapshots.length === 1 && snapshots[0].attached) {
      const details = snapshots[0];
      identity = details.identity;
      status = details.status;
      text = redactDiagnosticText(details.text);
      return { rightId: clipId, sourceIn, selectedClip: { identity, visible: visibility, status, text } };
    }
    return { rightId: clipId, sourceIn, selectedClip: { identity, visible: 'UNKNOWN', status, text } };
  } catch {
    identity = 'UNKNOWN';
    status = 'UNKNOWN';
    text = 'UNKNOWN';
  }
  return { rightId: clipId, sourceIn, selectedClip: { identity, visible: 'UNKNOWN', status, text } };
}

async function trimSourceWindow(page: Page, clipId: string, value: string) {
  await page.locator(`.clip-action[data-clip-id="${clipId}"]`).click();
  await page.getByRole('tab', { name: 'Timing', exact: true }).click();
  // The current product renders FieldLabel and NumberInput in one normal DOM container;
  // keep the same Source In intent without requiring an accessibility patch in this proof.
  const field = page.getByText('Source In', { exact: true }).locator('..');
  await expect(field).toBeVisible();
  const input = field.locator('input:not([aria-hidden="true"])');
  const before = await sourceWindowSnapshot(page, clipId, input);
  try {
    await expect(input).toBeEditable();
    await input.fill(value);
    await input.press('Enter');
    await input.press('Tab');
  } finally {
    const after = await sourceWindowSnapshot(page, clipId, input);
    const trace = diagnosticTraces.get(page);
    if (trace) trace.sourceWindow = { before, after };
  }
}

async function forward(route: Route, response: any, body: any) {
  await route.fulfill({ status: response.status(), headers: response.headers(), body: JSON.stringify(body) });
}

const DIAGNOSTIC_LIMIT = 40;
const DIAGNOSTIC_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;
type DiagnosticMethod = typeof DIAGNOSTIC_METHODS[number];
type DiagnosticRoute =
  | '/api/runtime/v1/health' | '/api/runtime/v1/realm' | '/api/runtime/v1/handshake'
  | '/api/runtime/v1/projects' | '/api/runtime/v1/projects/:project'
  | '/api/runtime/v1/projects/:project/timelines'
  | '/api/runtime/v1/projects/:project/timelines/:timeline'
  | '/api/runtime/v1/projects/:project/timelines/:timeline/commits'
  | '/api/runtime/v1/projects/:project/timelines/:timeline/inspect'
  | '/api/runtime/v1/projects/:project/timelines/:timeline/commit'
  | '/api/astrid/v1/health' | '/api/astrid/v1/realm' | '/api/astrid/v1/handshake'
  | '/api/astrid/v1/projects' | '/api/astrid/v1/projects/:project'
  | '/api/astrid/v1/projects/:project/timelines'
  | '/api/astrid/v1/projects/:project/timelines/:timeline'
  | '/api/astrid/v1/projects/:project/timelines/:timeline/commits'
  | '/api/astrid/v1/projects/:project/timelines/:timeline/inspect'
  | '/api/astrid/v1/projects/:project/timelines/:timeline/commit'
  | '/runtime-config/v1/workspace.json' | '/runtime-config/v1/operation/:handle';
type DiagnosticErrorSignal =
  | 'failed_to_fetch' | 'network_error' | 'connection_refused' | 'runtime_unavailable'
  | 'operation_unavailable' | 'paired_connector_error' | 'no_proxy_on_hosted_origin' | 'unknown';
type DiagnosticConnectionState =
  | 'connected' | 'stopped' | 'restarted' | 'connecting' | 'phone' | 'permission'
  | 'pending' | 'blocked' | 'set_up' | 'update_needed' | 'unknown';

type DiagnosticRuntimeResponse = { method: DiagnosticMethod; route: DiagnosticRoute; status: number };

const DIAGNOSTIC_ERROR_LABELS: ReadonlyArray<[DiagnosticErrorSignal, string]> = [
  ['failed_to_fetch', 'failed to fetch'],
  ['network_error', 'network error'],
  ['connection_refused', 'connection refused'],
  ['runtime_unavailable', 'runtime unavailable'],
  ['operation_unavailable', 'operation_unavailable'],
  ['paired_connector_error', 'paired_connector_error'],
  ['no_proxy_on_hosted_origin', 'no_proxy_on_hosted_origin'],
];

const DIAGNOSTIC_CONNECTION_STATES: readonly DiagnosticConnectionState[] = [
  'connected', 'stopped', 'restarted', 'connecting', 'phone', 'permission', 'pending', 'blocked', 'set_up', 'update_needed', 'unknown',
];

const DIAGNOSTIC_ROUTE_TEMPLATES: ReadonlyArray<[RegExp, string]> = [
  [/^\/v1\/health$/, '/v1/health'],
  [/^\/v1\/realm$/, '/v1/realm'],
  [/^\/v1\/handshake$/, '/v1/handshake'],
  [/^\/v1\/projects$/, '/v1/projects'],
  [/^\/v1\/projects\/[^/]+$/, '/v1/projects/:project'],
  [/^\/v1\/projects\/[^/]+\/timelines$/, '/v1/projects/:project/timelines'],
  [/^\/v1\/projects\/[^/]+\/timelines\/[^/]+$/, '/v1/projects/:project/timelines/:timeline'],
  [/^\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commits$/, '/v1/projects/:project/timelines/:timeline/commits'],
  [/^\/v1\/projects\/[^/]+\/timelines\/[^/]+\/inspect$/, '/v1/projects/:project/timelines/:timeline/inspect'],
  [/^\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/, '/v1/projects/:project/timelines/:timeline/commit'],
];

function boundedPush<T>(items: T[], item: T) {
  if (items.length < DIAGNOSTIC_LIMIT) items.push(item);
}

function diagnosticMethod(value: string): DiagnosticMethod | undefined {
  return (DIAGNOSTIC_METHODS as readonly string[]).includes(value) ? value as DiagnosticMethod : undefined;
}

function diagnosticStatus(value: number): number | undefined {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function diagnosticRoute(pathname: string): DiagnosticRoute | undefined {
  if (pathname === '/runtime-config/v1/workspace.json') return pathname;
  if (pathname.startsWith('/runtime-config/v1/operation/')) return '/runtime-config/v1/operation/:handle';
  const prefix = pathname.startsWith('/api/runtime/') ? '/api/runtime' : pathname.startsWith('/api/astrid/') ? '/api/astrid' : undefined;
  if (!prefix) return undefined;
  const suffix = pathname.slice(prefix.length);
  const template = DIAGNOSTIC_ROUTE_TEMPLATES.find(([pattern]) => pattern.test(suffix))?.[1];
  return template ? `${prefix}${template}` as DiagnosticRoute : undefined;
}

function classifyDiagnosticError(value: string): DiagnosticErrorSignal {
  const normalized = value.toLowerCase();
  return DIAGNOSTIC_ERROR_LABELS.find(([, phrase]) => normalized.includes(phrase))?.[0] ?? 'unknown';
}

function diagnosticConnectionState(value: string | null): DiagnosticConnectionState {
  return (DIAGNOSTIC_CONNECTION_STATES as readonly string[]).includes(value ?? '') ? value as DiagnosticConnectionState : 'unknown';
}

function diagnosticHead(value: unknown): { revisionId: string; publicationId: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, any>;
  const acceptedRevisionId = record.data?.accepted_revision_id ?? record.accepted_revision_id;
  const receiptId = record.receipt?.receipt_id ?? record.data?.receipt?.receipt_id;
  if (typeof acceptedRevisionId === 'string' && acceptedRevisionId) {
    return { revisionId: acceptedRevisionId, publicationId: typeof receiptId === 'string' ? receiptId : null };
  }
  const candidates = [record, record.head, record.data?.head, record.primary_timeline?.head, record.data?.primary_timeline?.head,
    record.receipt, record.data?.canonical_document?.parent_revision];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const revisionId = candidate.revision_id ?? candidate.revisionId;
    const publicationId = candidate.publication_id ?? candidate.publicationId ?? candidate.receipt_id ?? candidate.receiptId ?? null;
    if (typeof revisionId === 'string' && revisionId) return { revisionId, publicationId: typeof publicationId === 'string' ? publicationId : null };
  }
  return null;
}

function summarizeBasisReads(value: unknown) {
  if (!Array.isArray(value)) return { count: 'UNKNOWN', items: [], summarized: true, truncated: false };
  const items = value.slice(0, DIAGNOSTIC_LIMIT).map((read) => {
    if (!read || typeof read !== 'object' || Array.isArray(read)) return { kind: 'UNKNOWN', ref: 'UNKNOWN', path: 'UNKNOWN' };
    const record = read as Record<string, unknown>;
    return {
      kind: typeof record.kind === 'string' ? record.kind : 'UNKNOWN',
      ref: typeof record.ref === 'string' ? record.ref : 'UNKNOWN',
      path: Array.isArray(record.path) ? record.path.filter((part): part is string => typeof part === 'string') : 'UNKNOWN',
      state: record.state && typeof record.state === 'object' && !Array.isArray(record.state)
        ? ((record.state as Record<string, unknown>).state ?? 'UNKNOWN')
        : 'UNKNOWN',
    };
  });
  return { count: value.length, items, summarized: true, truncated: value.length > DIAGNOSTIC_LIMIT };
}

function summarizeFailureOutboxes(records: any[]) {
  return records.slice(0, DIAGNOSTIC_LIMIT).map((record) => ({
    ownerId: typeof record.ownerId === 'string' ? record.ownerId : 'UNKNOWN',
    generation: typeof record.generation === 'number' ? record.generation : 'UNKNOWN',
    intentCount: Array.isArray(record.intents) ? record.intents.length : 'UNKNOWN',
    pending: record.pending ? {
      intentId: typeof record.pending.intentId === 'string' ? record.pending.intentId : 'UNKNOWN',
      request: record.pending.request ? {
        method: typeof record.pending.request.method === 'string' ? record.pending.request.method : 'UNKNOWN',
        path: String(record.pending.request.path ?? '').split(/[?#]/, 1)[0] || 'UNKNOWN',
        key: typeof record.pending.request.key === 'string' ? record.pending.request.key : 'UNKNOWN',
      } : null,
      outcome: record.pending.outcome ? {
        kind: typeof record.pending.outcome.kind === 'string' ? record.pending.outcome.kind : 'UNKNOWN',
        status: typeof record.pending.outcome.status === 'number' ? record.pending.outcome.status : 'UNKNOWN',
        reason: typeof record.pending.outcome.reason === 'string' ? record.pending.outcome.reason : 'UNKNOWN',
      } : null,
    } : null,
    rejected: record.pending?.outcome?.kind === 'rejected',
    acceptedHead: diagnosticHead(record.accepted?.head),
  }));
}

async function diagnosticVisibleText(locator: { isVisible(): Promise<boolean>; innerText(): Promise<string> }) {
  try {
    return await locator.isVisible() ? redactDiagnosticText((await locator.innerText()).trim()) : null;
  } catch {
    return null;
  }
}

function summarizeOutboxes(records: any[]) {
  const observed = records.slice(0, DIAGNOSTIC_LIMIT);
  const intentLengths = observed.map((record) => Array.isArray(record.intents) ? record.intents.length : 0);
  const pendingIntentLengths = observed.map((record) => record.pending ? 1 : 0);
  const outcomeKinds = observed
    .map((record) => record.pending?.outcome?.kind)
    .filter((kind): kind is 'accepted' | 'rejected' | 'retry' => kind === 'accepted' || kind === 'rejected' || kind === 'retry');
  return {
    ownerCount: records.length,
    intentLengths,
    pendingIntentLengths,
    outcomeKinds,
    hasIdleOwner: records.some((record) => !record.pending && Array.isArray(record.intents) && record.intents.length === 0),
    hasPending: records.some((record) => !!record.pending),
    hasIntents: intentLengths.some((length) => length > 0),
    hasConflict: records.some((record) => record.intents?.some((intent: any) => intent.conflict !== undefined)),
  };
}

async function visibleDiagnostic(locator: { isVisible(): Promise<boolean> }) {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function openChainDiagnostics(
  page: Page,
  timelineId: string,
  runtimeResponses: DiagnosticRuntimeResponse[],
  pageErrors: DiagnosticErrorSignal[],
  consoleErrors: DiagnosticErrorSignal[],
) {
  let outboxSummary: ReturnType<typeof summarizeOutboxes> | null = null;
  let outboxReadFailed = false;
  try {
    outboxSummary = summarizeOutboxes(await commandOutboxes(page, timelineId));
  } catch {
    outboxReadFailed = true;
  }
  const connection = page.getByTestId('runtime-connection-status');
  const runtimePanel = page.getByTestId('runtime-not-connected');
  const recovery = page.getByTestId('timeline-command-recovery');
  const timelineError = page.locator('[data-video-editor-timeline-error="true"]');
  const provider = page.getByTestId('video-editor-provider');
  const connectionState = await connection.getAttribute('data-state').catch(() => null);
  const panelState = await runtimePanel.getAttribute('data-state').catch(() => null);
  const selectedTimelineId = await provider.getAttribute('data-timeline-id').catch(() => null);
  const alertCount = await page.locator('[role="alert"]:visible').count().catch(() => 0);
  logDiagnostic('P1 openChain diagnostics', {
    outboxReadFailed,
    outboxes: outboxSummary,
    ui: {
      selectedTimelineMatchesExpectedId: selectedTimelineId === timelineId,
      connectionState: diagnosticConnectionState(connectionState ?? panelState),
      runtimePanelVisible: await visibleDiagnostic(runtimePanel),
      recoveryVisible: await visibleDiagnostic(recovery),
      timelineErrorVisible: await visibleDiagnostic(timelineError),
      alertCount,
    },
    runtimeResponses,
    errorSignals: {
      page: { count: pageErrors.length, known: pageErrors.filter((signal) => signal !== 'unknown') },
      console: { count: consoleErrors.length, known: consoleErrors.filter((signal) => signal !== 'unknown') },
    },
  });
}

async function captureSecondCaseFailureDiagnostics({
  page,
  harness,
  seed,
  traffic,
  signals,
  before,
  originalClip,
  rightId,
  split,
  agent,
}: {
  page: Page;
  harness: DirectHarness;
  seed: ChainSeed;
  traffic: ReturnType<typeof observe>;
  signals: P1FailureSignals;
  before: any;
  originalClip: any;
  rightId: string;
  split: CommitPost;
  agent: any;
}) {
  try {
    let outboxes: unknown = null;
    let outboxRecords: any[] | null = null;
    let outboxReadFailed = false;
    try {
      outboxRecords = await commandOutboxes(page, seed.timelineId);
      outboxes = summarizeFailureOutboxes(outboxRecords);
    } catch {
      outboxReadFailed = true;
    }
    let runtimeHistory: any = null;
    let historyReadFailed = false;
    try {
      const result = await harness.runtimeJson<any>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50`);
      runtimeHistory = result.body;
    } catch {
      historyReadFailed = true;
    }
    const provider = page.getByTestId('video-editor-provider');
    const connection = page.getByTestId('runtime-connection-status');
    const runtimePanel = page.getByTestId('runtime-not-connected');
    const recovery = page.getByTestId('timeline-command-recovery');
    const timelineError = page.locator('[data-video-editor-timeline-error="true"]');
    const providerTimelineId = await provider.getAttribute('data-timeline-id').catch(() => null);
    const providerProjectId = await provider.getAttribute('data-project-id').catch(() => null);
    const connectionState = await connection.getAttribute('data-state').catch(() => null);
    const panelState = await runtimePanel.getAttribute('data-state').catch(() => null);
    const readonlyTraffic = traffic.readonlyTraffic.slice(0, DIAGNOSTIC_LIMIT).map((record) => ({
      method: record.method,
      route: record.route,
      status: record.status ?? null,
      displayedHead: diagnosticHead(record.reply),
    }));
    const commitTraffic = traffic.posts.slice(0, DIAGNOSTIC_LIMIT).map((post, index) => ({
      index,
      key: post.key,
      status: post.status ?? null,
      replyHead: diagnosticHead(post.response),
    }));
    const basis = traffic.posts.slice(0, DIAGNOSTIC_LIMIT).map((post, index) => ({
      index,
      key: post.key,
      baseRevisionId: (post.body as any).base_revision_id ?? null,
      basePublicationId: (post.body as any).base_publication_id ?? null,
      merge: (post.body as any).merge ?? null,
      reads: summarizeBasisReads((post.body as any).reads),
    }));
    const priorityBasis = traffic.posts.slice(0, DIAGNOSTIC_LIMIT).map((post, index) => ({
      index,
      key: post.key,
      baseRevisionId: (post.body as any).base_revision_id ?? null,
      basePublicationId: (post.body as any).base_publication_id ?? null,
      merge: (post.body as any).merge ?? null,
      reads: (post.body as any).reads,
    }));
    const priorityDisplayedHead = {
      providerProjectId,
      providerTimelineId,
      commitReplies: commitTraffic.map(({ index, replyHead }) => ({ index, head: replyHead })),
      readonlyReplies: readonlyTraffic.map(({ route, status, displayedHead: head }) => ({ route, status, head })),
      runtimeHistoryHead: diagnosticHead(runtimeHistory?.head),
      historyReadFailed,
    };
    const ui = {
      connectionState: diagnosticConnectionState(connectionState ?? panelState),
      runtimePanelVisible: await visibleDiagnostic(runtimePanel),
      recoveryVisible: await visibleDiagnostic(recovery),
      recoveryMessage: await diagnosticVisibleText(recovery),
      timelineErrorVisible: await visibleDiagnostic(timelineError),
      timelineErrorMessage: await diagnosticVisibleText(timelineError),
      alertCount: await page.locator('[role="alert"]:visible').count().catch(() => 0),
    };
    const errors = {
      page: signals.pageErrors.slice(0, 4),
      console: signals.consoleErrors.slice(0, 4),
      requestFailures: signals.requestFailures.slice(0, 4),
    };
    const trace = typeof diagnosticTraces === 'undefined' ? undefined : diagnosticTraces.get(page);
    const artifactCommits = traffic.posts.slice(0, DIAGNOSTIC_LIMIT).map((post, index) => ({
      index,
      status: post.status ?? null,
      replyHead: diagnosticHead(post.response),
      bodyProjection: { present: post.raw.length > 0, bytes: post.raw.length, sameAsPrevious: index > 0 ? post.raw === traffic.posts[index - 1].raw : null },
      keyProjection: { present: post.key.length > 0, bytes: post.key.length, sameAsPrevious: index > 0 ? post.key === traffic.posts[index - 1].key : null },
    }));
    const artifactBasisRecords = traffic.posts.slice(0, DIAGNOSTIC_LIMIT).map((post, index) => ({
      index,
      baseRevisionId: (post.body as any).base_revision_id ?? null,
      basePublicationId: (post.body as any).base_publication_id ?? null,
      merge: (post.body as any).merge ?? null,
      reads: summarizeBasisReads((post.body as any).reads),
      bodyProjection: { present: post.raw.length > 0, bytes: post.raw.length, sameAsPrevious: index > 0 ? post.raw === traffic.posts[index - 1].raw : null },
      keyProjection: { present: post.key.length > 0, bytes: post.key.length, sameAsPrevious: index > 0 ? post.key === traffic.posts[index - 1].key : null },
    }));
    const artifactOwners = outboxRecords === null ? 'UNKNOWN' : outboxRecords.slice(0, DIAGNOSTIC_LIMIT).map((record) => {
      const request = record.pending?.request;
      const body = request?.body;
      const key = request?.key;
      return {
        ownerId: typeof record.ownerId === 'string' ? record.ownerId : 'UNKNOWN',
        generation: typeof record.generation === 'number' ? record.generation : 'UNKNOWN',
        intentCount: Array.isArray(record.intents) ? record.intents.length : 'UNKNOWN',
        pending: record.pending ? {
          intentId: typeof record.pending.intentId === 'string' ? record.pending.intentId : 'UNKNOWN',
          request: request ? {
            method: typeof request.method === 'string' ? request.method : 'UNKNOWN',
            path: typeof request.path === 'string' ? request.path.split(/[?#]/, 1)[0] || 'UNKNOWN' : 'UNKNOWN',
            bodyProjection: { present: body !== undefined && body !== null, bytes: typeof body === 'string' ? body.length : 0, sameAsPrevious: null },
            keyProjection: { present: typeof key === 'string' && key.length > 0, bytes: typeof key === 'string' ? key.length : 0, sameAsPrevious: null },
          } : 'UNKNOWN',
          outcome: record.pending.outcome ? {
            kind: typeof record.pending.outcome.kind === 'string' ? record.pending.outcome.kind : 'UNKNOWN',
            status: typeof record.pending.outcome.status === 'number' ? record.pending.outcome.status : 'UNKNOWN',
            reason: typeof record.pending.outcome.reason === 'string' ? record.pending.outcome.reason : 'UNKNOWN',
          } : 'UNKNOWN',
        } : null,
        acceptedHead: diagnosticHead(record.accepted?.head) ?? 'UNKNOWN',
      };
    });
    if (trace) trace.failureContext = {
      phase: 'after-source-in-before-original-post-count-wait',
      case: {
        title: 'P1 split -> trim new clip: a real Agent move refuses the stale trim and the App rolls back with a message',
        projectId: harness.seed.projectId,
        projectSlug: seed.projectSlug,
        timelineId: seed.timelineId,
        sourceId: seed.sourceId,
        originalClipId: originalClip.id,
        rightId,
        expectedPostCount: 2,
        observedPostCount: traffic.posts.length,
      },
      sourceIdentities: {
        beforeHead: diagnosticHead({ head: before.head }) ?? 'UNKNOWN',
        splitHead: diagnosticHead(split.response),
        agentHead: diagnosticHead(agent),
        sourceAsset: 'UNKNOWN',
      },
      traffic: { commits: artifactCommits, readonly: readonlyTraffic },
      basis: artifactBasisRecords,
      displayedHead: {
        providerProjectId,
        providerTimelineId,
        commitReplies: artifactCommits.map((item) => ({ index: item.index, head: item.replyHead })),
        readonlyReplies: readonlyTraffic.map(({ route, status, displayedHead: head }) => ({ route, status, head })),
        runtimeHistoryHead: diagnosticHead({ head: runtimeHistory?.head }) ?? 'UNKNOWN',
        historyReadFailed,
      },
      outbox: { readFailed: outboxReadFailed, owners: artifactOwners },
      ui,
      errors,
    };
    // Keep causal state ahead of the bounded structural traffic summaries.
    logPriorityDiagnostic('P1 second-case priority diagnostics', {
      case: {
        projectId: harness.seed.projectId,
        projectSlug: seed.projectSlug,
        timelineId: seed.timelineId,
        sourceId: seed.sourceId,
        originalClipId: originalClip.id,
        rightId,
        expectedPostCount: 2,
        observedPostCount: traffic.posts.length,
      },
      basis: priorityBasis,
      displayedHead: priorityDisplayedHead,
      outbox: { readFailed: outboxReadFailed, summary: outboxRecords === null ? null : summarizeOutboxes(outboxRecords) },
      ui,
      errors,
    });
    logDiagnostic('P1 second-case failure diagnostics', {
      case: {
        title: 'P1 split -> trim new clip: a real Agent move refuses the stale trim and the App rolls back with a message',
        phase: 'after-source-in-before-original-post-count-wait',
        projectId: harness.seed.projectId,
        projectSlug: seed.projectSlug,
        timelineId: seed.timelineId,
        sourceId: seed.sourceId,
        originalClipId: originalClip.id,
        rightId,
        expectedPostCount: 2,
        observedPostCount: traffic.posts.length,
      },
      sourceIdentities: {
        beforeHead: diagnosticHead({ head: before.head }) ?? 'UNKNOWN',
        splitHead: diagnosticHead(split.response),
        agentHead: diagnosticHead(agent),
        sourceAsset: 'UNKNOWN',
      },
      traffic: { commits: commitTraffic, readonly: readonlyTraffic },
      basis,
      displayedHead: {
        providerProjectId,
        providerTimelineId,
        commitReplies: commitTraffic.map(({ index, replyHead }) => ({ index, head: replyHead })),
        readonlyReplies: readonlyTraffic.map(({ route, status, displayedHead }) => ({ route, status, head: displayedHead })),
        runtimeHistoryHead: diagnosticHead({ head: runtimeHistory?.head }) ?? 'UNKNOWN',
        historyReadFailed,
      },
      outbox: { readFailed: outboxReadFailed, records: outboxes },
      ui: {
        connectionState: diagnosticConnectionState(connectionState ?? panelState),
        runtimePanelVisible: await visibleDiagnostic(runtimePanel),
        recoveryVisible: await visibleDiagnostic(recovery),
        recoveryMessage: await diagnosticVisibleText(recovery),
        timelineErrorVisible: await visibleDiagnostic(timelineError),
        timelineErrorMessage: await diagnosticVisibleText(timelineError),
        alertCount: await page.locator('[role="alert"]:visible').count().catch(() => 0),
      },
      errors: {
        page: signals.pageErrors.slice(0, DIAGNOSTIC_LIMIT),
        console: signals.consoleErrors.slice(0, DIAGNOSTIC_LIMIT),
        requestFailures: signals.requestFailures.slice(0, DIAGNOSTIC_LIMIT),
      },
    });
  } catch {
    logDiagnostic('P1 second-case failure diagnostics', { capture: 'failed' });
  }
}

function summarizePriorityOutboxes(records: any[]): unknown[] {
  return records.slice(0, DIAGNOSTIC_LIMIT).map((record) => ({
    ownerId: typeof record.ownerId === 'string' ? record.ownerId : 'UNKNOWN',
    generation: typeof record.generation === 'number' ? record.generation : 'UNKNOWN',
    intentCount: Array.isArray(record.intents) ? record.intents.length : 'UNKNOWN',
    pending: record.pending ? {
      intentId: typeof record.pending.intentId === 'string' ? record.pending.intentId : 'UNKNOWN',
      request: record.pending.request ? {
        method: typeof record.pending.request.method === 'string' ? record.pending.request.method : 'UNKNOWN',
        path: String(record.pending.request.path ?? '').split(/[?#]/, 1)[0] || 'UNKNOWN',
        key: typeof record.pending.request.key === 'string' ? record.pending.request.key : 'UNKNOWN',
      } : 'UNKNOWN',
      outcome: record.pending.outcome ? {
        kind: typeof record.pending.outcome.kind === 'string' ? record.pending.outcome.kind : 'UNKNOWN',
        status: typeof record.pending.outcome.status === 'number' ? record.pending.outcome.status : 'UNKNOWN',
        reason: typeof record.pending.outcome.reason === 'string' ? record.pending.outcome.reason : 'UNKNOWN',
      } : 'UNKNOWN',
    } : null,
    acceptedHead: diagnosticHead(record.accepted?.head) ?? 'UNKNOWN',
  }));
}

function diagnosticByteLength(value: unknown): number {
  return typeof value === 'string' ? new TextEncoder().encode(value).length : 0;
}

function artifactWireHeads(wireHeads: DiagnosticWireHead[]): unknown[] {
  return wireHeads.map(({ key: _key, ...wire }) => ({
    ...wire,
    keyProjection: { present: typeof _key === 'string' && _key.length > 0, bytes: diagnosticByteLength(_key) },
  }));
}

function artifactCommitTraffic(posts: CommitPost[]): unknown[] {
  return posts.slice(0, DIAGNOSTIC_LIMIT).map((post, index) => ({
    index,
    status: post.status ?? null,
    replyHead: diagnosticHead(post.response),
    bodyProjection: {
      present: post.raw.length > 0,
      bytes: diagnosticByteLength(post.raw),
      sameAsPrevious: index > 0 ? post.raw === posts[index - 1].raw : null,
    },
    keyProjection: {
      present: post.key.length > 0,
      bytes: diagnosticByteLength(post.key),
      sameAsPrevious: index > 0 ? post.key === posts[index - 1].key : null,
    },
  }));
}

function artifactBasis(posts: CommitPost[]): unknown[] {
  return posts.slice(0, DIAGNOSTIC_LIMIT).map((post, index) => ({
    index,
    baseRevisionId: (post.body as any).base_revision_id ?? null,
    basePublicationId: (post.body as any).base_publication_id ?? null,
    merge: (post.body as any).merge ?? null,
    reads: summarizeBasisReads((post.body as any).reads),
    bodyProjection: {
      present: post.raw.length > 0,
      bytes: diagnosticByteLength(post.raw),
      sameAsPrevious: index > 0 ? post.raw === posts[index - 1].raw : null,
    },
    keyProjection: {
      present: post.key.length > 0,
      bytes: diagnosticByteLength(post.key),
      sameAsPrevious: index > 0 ? post.key === posts[index - 1].key : null,
    },
  }));
}

function artifactOutboxOwners(records: any[] | null): unknown {
  if (records === null) return 'UNKNOWN';
  return records.slice(0, DIAGNOSTIC_LIMIT).map((record) => {
    const request = record.pending?.request;
    const body = request?.body;
    const key = request?.key;
    return {
      ownerId: typeof record.ownerId === 'string' ? record.ownerId : 'UNKNOWN',
      generation: typeof record.generation === 'number' ? record.generation : 'UNKNOWN',
      intentCount: Array.isArray(record.intents) ? record.intents.length : 'UNKNOWN',
      pending: record.pending ? {
        intentId: typeof record.pending.intentId === 'string' ? record.pending.intentId : 'UNKNOWN',
        request: request ? {
          method: typeof request.method === 'string' ? request.method : 'UNKNOWN',
          path: typeof request.path === 'string' ? request.path.split(/[?#]/, 1)[0] || 'UNKNOWN' : 'UNKNOWN',
          bodyProjection: { present: body !== undefined && body !== null, bytes: diagnosticByteLength(body), sameAsPrevious: null },
          keyProjection: { present: typeof key === 'string' && key.length > 0, bytes: diagnosticByteLength(key), sameAsPrevious: null },
        } : 'UNKNOWN',
        outcome: record.pending.outcome ? {
          kind: typeof record.pending.outcome.kind === 'string' ? record.pending.outcome.kind : 'UNKNOWN',
          status: typeof record.pending.outcome.status === 'number' ? record.pending.outcome.status : 'UNKNOWN',
          reason: typeof record.pending.outcome.reason === 'string' ? record.pending.outcome.reason : 'UNKNOWN',
        } : 'UNKNOWN',
      } : null,
      rejected: record.pending?.outcome?.kind === 'rejected',
      acceptedHead: diagnosticHead(record.accepted?.head) ?? 'UNKNOWN',
    };
  });
}

async function diagnosticVisibleState(locator: any): Promise<boolean | 'UNKNOWN'> {
  try { return await locator.isVisible(); } catch { return 'UNKNOWN'; }
}

async function diagnosticVisibleTextState(locator: any): Promise<string> {
  try {
    return await locator.isVisible() ? redactDiagnosticText((await locator.innerText()).trim()) : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

async function diagnosticAttribute(locator: any, name: string): Promise<string> {
  try { return (await locator.getAttribute(name)) ?? 'UNKNOWN'; } catch { return 'UNKNOWN'; }
}

async function captureFailureContinuation(page: Page, testInfo: any) {
  const trace = diagnosticTraces.get(page);
  const caseTitle = testInfo.title;
  const earlyProjectId = trace?.projectId ?? 'UNKNOWN';
  const earlyTimelineId = trace?.timelineId ?? 'UNKNOWN';
  const earlyRightId = trace?.sourceWindow?.after.rightId ?? 'UNKNOWN';

  // Persist the in-memory failure identity and the already-bounded mounted seam
  // before touching IndexedDB, the DOM, or any browser evaluation. Later reads
  // remain strictly best effort.
  // The later collector is strictly best effort; this file is the durable minimum
  // when a page has closed or one of its reads never settles.
  await withDiagnosticDeadline(() => writeDiagnosticArtifact(testInfo, {
    schemaVersion: 1,
    title: caseTitle,
    status: testInfo.status,
    expectedStatus: testInfo.expectedStatus,
    capturedAt: new Date().toISOString(),
    durationMs: testInfo.duration,
    phase: 'afterEach_failure_early_return',
    case: { title: caseTitle, expectedPostCount: 2, observedPostCount: trace?.wireHeads.length ?? 'UNKNOWN' },
    tuple: { projectId: earlyProjectId, timelineId: earlyTimelineId, sourceId: 'UNKNOWN', rightId: earlyRightId },
    available: {
      wireHeads: trace ? artifactWireHeads(trace.wireHeads) : 'UNKNOWN',
      requestProjections: trace?.requestProjections ?? 'UNKNOWN',
      sourceWindow: trace?.sourceWindow ?? 'UNKNOWN',
    },
    mountedObservations: 'UNKNOWN',
    captureData: 'UNKNOWN',
    unknowns: { mountedDataRef: 'UNKNOWN', callbackPatch: 'UNKNOWN', captureResolution: 'UNKNOWN' },
    losses: { cappedConsole: true, mountedObservations: 'UNKNOWN', callbackPatch: 'UNKNOWN', captureResolution: 'UNKNOWN' },
  }), false, DIAGNOSTIC_ARTIFACT_TIMEOUT_MS);

  const earlyMountedObservations = await withDiagnosticDeadline(() => page.evaluate((_timelineId) => {
    try {
      const snapshot = (window as Window & { __timelineSaveDiagnosticsSnapshot?: () => unknown }).__timelineSaveDiagnosticsSnapshot;
      return typeof snapshot === 'function' ? snapshot() : 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }, earlyTimelineId), 'UNKNOWN', DIAGNOSTIC_READ_TIMEOUT_MS);
  if (earlyMountedObservations !== 'UNKNOWN') {
    await withDiagnosticDeadline(() => writeDiagnosticArtifact(testInfo, {
      schemaVersion: 1,
      title: caseTitle,
      status: testInfo.status,
      expectedStatus: testInfo.expectedStatus,
      capturedAt: new Date().toISOString(),
      durationMs: testInfo.duration,
      phase: 'afterEach_failure_early_return',
      case: { title: caseTitle, expectedPostCount: 2, observedPostCount: trace?.wireHeads.length ?? 'UNKNOWN' },
      tuple: { projectId: earlyProjectId, timelineId: earlyTimelineId, sourceId: 'UNKNOWN', rightId: earlyRightId },
      available: {
        wireHeads: trace ? artifactWireHeads(trace.wireHeads) : 'UNKNOWN',
        requestProjections: trace?.requestProjections ?? 'UNKNOWN',
        sourceWindow: trace?.sourceWindow ?? 'UNKNOWN',
        mountedObservations: earlyMountedObservations,
      },
      mountedObservations: earlyMountedObservations,
      captureData: 'UNKNOWN',
      unknowns: { mountedDataRef: 'UNKNOWN', callbackPatch: 'UNKNOWN', captureResolution: 'UNKNOWN' },
      losses: { cappedConsole: true, mountedObservations: false, callbackPatch: 'UNKNOWN', captureResolution: 'UNKNOWN' },
    }), false, DIAGNOSTIC_ARTIFACT_TIMEOUT_MS);
  }

  const collectionDeadline = Date.now() + DIAGNOSTIC_COLLECTION_TIMEOUT_MS;
  const read = <T>(operation: () => T | PromiseLike<T>, fallback: T) => (
    boundedDiagnosticRead(operation, fallback, collectionDeadline)
  );
  const getLocator = <T>(factory: () => T): T | null => {
    try { return factory(); } catch { return null; }
  };
  const provider = getLocator(() => page.getByTestId('video-editor-provider'));
  const connection = getLocator(() => page.getByTestId('runtime-connection-status'));
  const runtimePanel = getLocator(() => page.getByTestId('runtime-not-connected'));
  const recovery = getLocator(() => page.getByTestId('timeline-command-recovery'));
  const timelineError = getLocator(() => page.locator('[data-video-editor-timeline-error="true"]'));
  const providerTimelineId = await read(() => diagnosticAttribute(provider, 'data-timeline-id'), 'UNKNOWN');
  const providerProjectId = await read(() => diagnosticAttribute(provider, 'data-project-id'), 'UNKNOWN');
  const timelineId = providerTimelineId !== 'UNKNOWN' ? providerTimelineId : trace?.timelineId ?? 'UNKNOWN';
  const mountedObservations = await read(() => page.evaluate((_timelineId) => {
    try {
      const snapshot = (window as Window & { __timelineSaveDiagnosticsSnapshot?: () => unknown }).__timelineSaveDiagnosticsSnapshot;
      return typeof snapshot === 'function' ? snapshot() : 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }, timelineId), 'UNKNOWN');
  let outboxRecords: any[] | null = null;
  let outboxReadFailed = false;
  try {
    if (timelineId === 'UNKNOWN') throw new Error('timeline id unavailable');
    outboxRecords = await read(() => commandOutboxes(page, timelineId), null);
    if (outboxRecords === null) throw new Error('outbox read unavailable');
  } catch {
    outboxReadFailed = true;
  }
  const connectionState = await read(() => diagnosticAttribute(connection, 'data-state'), 'UNKNOWN');
  const panelState = await read(() => diagnosticAttribute(runtimePanel, 'data-state'), 'UNKNOWN');
  const wireHeads = trace?.wireHeads ?? [];
  const safeWireHeads = artifactWireHeads(wireHeads);
  const projectId = providerProjectId !== 'UNKNOWN' ? providerProjectId : trace?.projectId ?? 'UNKNOWN';
  const timelineTupleId = timelineId;
  const ui = {
    connectionState: diagnosticConnectionState(connectionState !== 'UNKNOWN' ? connectionState : panelState),
    runtimePanelVisible: await read(() => diagnosticVisibleState(runtimePanel), 'UNKNOWN'),
    recoveryVisible: await read(() => diagnosticVisibleState(recovery), 'UNKNOWN'),
    recoveryMessage: await read(() => diagnosticVisibleTextState(recovery), 'UNKNOWN'),
    timelineErrorVisible: await read(() => diagnosticVisibleState(timelineError), 'UNKNOWN'),
    timelineErrorMessage: await read(() => diagnosticVisibleTextState(timelineError), 'UNKNOWN'),
    alertCount: await read(() => page.locator('[role="alert"]:visible').count(), 'UNKNOWN'),
  };
  const errors = {
    page: trace?.pageErrors ?? 'UNKNOWN',
    console: trace?.consoleErrors ?? 'UNKNOWN',
    requestFailures: trace?.requestFailures ?? 'UNKNOWN',
  };
  await boundedDiagnosticRead(() => writeDiagnosticArtifact(testInfo, {
    schemaVersion: 1,
    title: caseTitle,
    status: testInfo.status,
    expectedStatus: testInfo.expectedStatus,
    capturedAt: new Date().toISOString(),
    durationMs: testInfo.duration,
    phase: 'afterEach_failure_continuation',
    case: {
      title: caseTitle,
      expectedPostCount: 2,
      observedPostCount: wireHeads.length,
    },
    tuple: {
      projectId,
      timelineId: timelineTupleId,
      sourceId: 'UNKNOWN',
      rightId: trace?.sourceWindow?.after.rightId ?? 'UNKNOWN',
    },
    available: {
      wireHeads: safeWireHeads,
      requestProjections: trace?.requestProjections ?? 'UNKNOWN',
      failureContext: trace?.failureContext ?? 'UNKNOWN',
      sourceWindow: trace?.sourceWindow ?? 'UNKNOWN',
      outbox: {
        readFailed: outboxReadFailed,
        summary: outboxRecords === null ? 'UNKNOWN' : summarizeOutboxes(outboxRecords),
        owners: artifactOutboxOwners(outboxRecords),
      },
      mountedObservations,
      recovery: ui,
      errors,
    },
    mountedObservations,
    captureData: 'UNKNOWN',
    unknowns: {
      mountedDataRef: 'UNKNOWN',
      callbackPatch: 'UNKNOWN',
      captureResolution: 'UNKNOWN',
    },
    losses: {
      cappedConsole: true,
      mountedObservations: 'UNKNOWN',
      callbackPatch: 'UNKNOWN',
      captureResolution: 'UNKNOWN',
    },
  }), false, Date.now() + DIAGNOSTIC_ARTIFACT_TIMEOUT_MS, DIAGNOSTIC_ARTIFACT_TIMEOUT_MS);
  logPriorityDiagnostic(`P1 failure continuation ${testInfo.title}`, {
    case: {
      projectId,
      timelineId,
      rightId: trace?.sourceWindow?.after.rightId ?? 'UNKNOWN',
      observedPostCount: wireHeads.length,
    },
    displayedHead: {
      providerProjectId,
      providerTimelineId,
      currentWireHeads: wireHeads,
    },
    outbox: {
      readFailed: outboxReadFailed,
      summary: outboxRecords === null ? 'UNKNOWN' : summarizeOutboxes(outboxRecords),
      owners: outboxRecords === null ? 'UNKNOWN' : summarizePriorityOutboxes(outboxRecords),
    },
    sourceWindow: trace?.sourceWindow ?? 'UNKNOWN',
    ui,
    errors,
  });
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  try {
    await captureFailureContinuation(page, testInfo);
  } catch {
    logPriorityDiagnostic('P1 failure continuation unavailable', { diagnostic: 'UNKNOWN' });
  }
});

// Source proof only: execution is NOT READY until A2 supplies its existing authoritative
// read/intent seam. The strict merged reply assertions below remain required; do not infer
// reads or reinterpret this boundary as a refusal.
test('P1 split -> trim new clip: accepted split, merged trim after Agent edit, lost ACK restart and exact retry', async ({ page, harness, astrid }) => {
  const seed = await seedOneClip(harness, astrid);
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  const traffic = observe(page);
  let heldSplit: Route | undefined;
  let heldTrim: Route | undefined;
  let heldRetry: Route | undefined;
  let retryPost: CommitPost | undefined;
  await page.route(COMMITS, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const post = traffic.posts.find((candidate) => candidate.key === route.request().headers()['idempotency-key']);
    if (post && traffic.posts.indexOf(post) === 0) { heldSplit = route; return; }
    if (post && traffic.posts.indexOf(post) === 1) { heldTrim = route; return; }
    const response = await route.fetch({ maxRetries: 0 });
    await forward(route, response, await response.json());
  });
  await openChain(page, harness, seed);
  const before = await history(harness, seed);
  const original = (await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/composition-revisions/${before.head.revision_id}`)).body.payload;
  expect(original.clips).toHaveLength(1);
  const originalClip = structuredClone(original.clips[0]);
  await splitSource(page, seed);
  await expect.poll(() => traffic.posts.length, CEILING).toBe(1);
  await expect.poll(() => !!heldSplit, CEILING).toBe(true);
  const split = traffic.posts[0];
  assertV2Request(split, harness, seed);
  const splitCommand = split.body.commands[0] as any;
  expect(splitCommand).toMatchObject({ schema_version: 1, op: 'doc.patch', version: '1', select: null });
  const inserted = (splitCommand.args.changes as Array<any>).find((change) => change.op === 'list.insert' && change.path.join('.') === 'clips');
  expect(inserted).toMatchObject({ before: { state: 'absent' }, value: { id: expect.any(String), clipType: 'media', track: 'V1' },
    order_before: [SOURCE_ID], after_id: SOURCE_ID });
  expect(inserted.id).toMatch(/^p1-chain-source-/);
  expect(inserted.value.id).toBe(inserted.id);
  expect(splitCommand.created).toEqual([`parent/clip:${inserted.id}`]);
  const rightId = inserted.id;
  expect(split.body).toMatchObject({ api_version: 1, project_id: harness.seed.projectId, timeline_id: seed.timelineId,
    base_revision_id: before.head.revision_id, base_publication_id: before.head.publication_id,
    source: { via: 'app' }, merge: 'fields', dry_run: false, label: expect.any(String), commands: [splitCommand] });
  expect(split.body.steps[0]).toMatchObject({ command_ordinals: [0], patch: splitCommand.args.changes });

  // Release only after the dependent has been authored locally. The outbox must persist it
  // behind the held split instead of sending it with a guessed base or a new ID.
  await trimSourceWindow(page, rightId, '3');
  await expect.poll(() => traffic.posts.length, CEILING).toBe(1);
  expect((await commandOutboxes(page, seed.timelineId)).some((owner) => owner.pending && owner.intents.length > 0)).toBe(true);
  const splitWire = await heldSplit!.fetch({ maxRetries: 0 });
  split.response = await splitWire.json(); split.status = splitWire.status();
  await forward(heldSplit!, splitWire, split.response);
  assertSuccessfulReply(split, 'split');
  assertAcceptedData(split.response, split, 'accepted');
  expect(split.response.data.rebased_onto).toBeNull();
  const splitDocument = parentOf(split.response);
  expect(splitDocument.clips.map((clip: any) => clip.id)).toEqual([SOURCE_ID, rightId]);
  // This seed is a hold clip in the current App. Its UI split changes hold/at/ID only;
  // it does not manufacture a source-window split or strip the authored app state.
  expect(splitDocument.clips[0]).toEqual({ ...originalClip, hold: SPLIT_AT });
  expect(splitDocument.clips[1]).toEqual({ ...originalClip, id: rightId, at: SPLIT_AT, hold: originalClip.hold - SPLIT_AT });
  expect(splitDocument.config.opaque).toEqual({ root: null, order: [0, false] });
  expect(splitDocument.config.clips).toEqual(splitDocument.clips);
  expect(split.response.data.steps[0].patch).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'list.insert', id: rightId,
    value: expect.objectContaining({ id: rightId }), before: { state: 'absent' }, order_before: [SOURCE_ID], after_id: SOURCE_ID })]));
  expect(splitDocument.registry).toEqual((await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/composition-revisions/${split.response.data.accepted_revision_id}`)).body.payload.registry);

  await expect.poll(() => traffic.posts.length, CEILING).toBe(2);
  const trim = traffic.posts[1];
  await expect.poll(() => !!heldTrim, CEILING).toBe(true);
  assertV2Request(trim, harness, seed);
  expect(trim.status).toBeUndefined();
  expect(trim.body.steps[0]).toMatchObject({ command_ordinals: [0], patch: (trim.body.commands[0] as any).args.changes });
  expect(trim.body.commands[0]).toMatchObject({ op: 'doc.patch', select: null });
  const trimChange = (trim.body.commands[0] as any).args.changes.find((change: any) => change.path.includes(`id:${rightId}`) && change.path.at(-1) === 'from');
  expect(trimChange).toMatchObject({ value: 3, before: { state: 'present', value: 0 }, path: ['clips', `id:${rightId}`, 'from'] });
  expect(trim.body.base_revision_id).toBe(split.response.data.accepted_revision_id);
  expect(trim.body.base_publication_id).toBe(split.response.receipt.receipt_id);

  const agent = await astrid.commitCaptured(harness.seed.projectId, seed.timelineId, pin(split.response), { kind: 'label', trackId: 'V1', label: 'Agent edit after split' }, 'p1-agent-after-split');
  expect(agent.data.status).toBe('accepted');
  expect(agent.data.rebased_onto).toBeNull();
  const originalTrim = { raw: trim.raw, key: trim.key };
  const acceptedTrimResponse = await heldTrim!.fetch({ maxRetries: 0 });
  const acceptedTrim = await acceptedTrimResponse.json();
  assertSuccessfulReply({ status: acceptedTrimResponse.status(), response: acceptedTrim }, 'merged trim');
  expect(acceptedTrimResponse.status()).toBe(200);
  assertAcceptedData(acceptedTrim, trim, 'merged');
  expect(acceptedTrim.data.rebased_onto).toEqual(pin(agent));
  const mergedDocument = parentOf(acceptedTrim);
  expect(mergedDocument.clips.map((clip: any) => clip.id)).toEqual([SOURCE_ID, rightId]);
  expect(mergedDocument.clips[0]).toMatchObject({ id: SOURCE_ID, from: originalClip.from, to: originalClip.to, hold: SPLIT_AT });
  expect(mergedDocument.clips[1]).toMatchObject({ id: rightId, at: SPLIT_AT, from: 3, to: originalClip.to, hold: originalClip.hold - SPLIT_AT });
  expect(mergedDocument.config.clips).toEqual(mergedDocument.clips);
  expect(mergedDocument.clips[0].app).toEqual(originalClip.app);
  expect(mergedDocument.clips[1].app.opaque).toEqual(originalClip.app.opaque);
  expect(mergedDocument.clips[1].app['org.example']).toEqual(originalClip.app['org.example']);
  expect(mergedDocument.clips[1].app['org.example']).toHaveProperty('clear', null);
  expect(mergedDocument.clips[1].app).toEqual(originalClip.app);
  expect(mergedDocument.registry).toEqual(splitDocument.registry);
  expect(mergedDocument.occurrences).toEqual(splitDocument.occurrences);
  expect(acceptedTrim.data.canonical_document.shot_revisions).toEqual(split.response.data.canonical_document.shot_revisions);
  expect(acceptedTrim.data.canonical_document.internal_timeline_revisions).toEqual(split.response.data.canonical_document.internal_timeline_revisions);
  expect(mergedDocument.config.tracks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'V1', label: 'Agent edit after split' })]));
  await heldTrim!.abort('connectionreset');
  await page.unroute(COMMITS);
  await expect.poll(async () => (await commandOutboxes(page, seed.timelineId)).some((owner) => owner.pending?.outcome?.kind === 'retry'), CEILING).toBe(true);
  const ownersBeforeReload = await commandOutboxes(page, seed.timelineId);
  expect(ownersBeforeReload).toHaveLength(1);
  const owner = ownersBeforeReload[0];
  expect(owner.scope).toEqual({ realmId: harness.realmId, actorId: PRODUCT_ACTOR,
    projectId: harness.seed.projectId, timelineId: seed.timelineId });
  expect(owner.pending?.request).toMatchObject({ body: originalTrim.raw, key: originalTrim.key });

  // The mounted local-save session claims the sole authenticated owner on reload and
  // invokes recovery automatically. Arm the observer first, then hold that real request
  // so the lost-ACK/restart boundary remains genuine and the retry reaches the restarted
  // Runtime with its persisted body and key.
  await page.unroute(COMMITS);
  expect(traffic.posts).toHaveLength(2);
  const retryResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
    && COMMITS.test(new URL(response.url()).pathname)
    && response.request().headers()['idempotency-key'] === originalTrim.key, CEILING);
  await page.route(COMMITS, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const key = route.request().headers()['idempotency-key'];
    const post = [...traffic.posts].reverse().find((candidate) => candidate.key === key);
    if (key === originalTrim.key && post) {
      retryPost = post;
      heldRetry = route;
      return;
    }
    const response = await route.fetch({ maxRetries: 0 });
    await forward(route, response, await response.json());
  });
  await page.reload();
  await expectConnected(page);
  await openSeededTimeline(page, harness);
  await expect.poll(() => !!heldRetry, CEILING).toBe(true);
  expect(traffic.posts).toHaveLength(3);
  expect(retryPost).toBe(traffic.posts[2]);
  // Automatic recovery has reserved exactly one request, but the route has not forwarded
  // it yet; this is the replacement for the obsolete fixture-button traffic-count guard.
  expect(retryPost?.raw).toBe(originalTrim.raw);
  expect(retryPost?.key).toBe(originalTrim.key);
  expect(retryPost?.status).toBeUndefined();
  const ownersAfterReload = await commandOutboxes(page, seed.timelineId);
  expect(ownersAfterReload).toHaveLength(1);
  expect(ownersAfterReload[0].ownerId).toBe(owner.ownerId);
  expect(ownersAfterReload[0].scope).toEqual(owner.scope);
  expect(ownersAfterReload[0].pending?.request).toMatchObject({ body: originalTrim.raw, key: originalTrim.key });
  const restarted = await harness.restartRuntime();
  expect(restarted.oldInstanceId).toBeTruthy();
  await expectConnected(page);
  const retryWire = await heldRetry!.fetch({ maxRetries: 0 });
  const retryBody = await retryWire.json();
  await forward(heldRetry!, retryWire, retryBody);
  const retryResponse = await retryResponsePromise;
  expect(retryResponse.status()).toBe(200);
  expect(retryResponse.request().postData()).toBe(originalTrim.raw);
  expect(retryResponse.request().headers()['idempotency-key']).toBe(originalTrim.key);
  const retry = await retryResponse.json();
  assertSuccessfulReply({ status: retryResponse.status(), response: retry }, 'trim retry');
  expect(retry).toEqual(acceptedTrim);
  expect(retry.data.status).toBe('merged');
  await expect.poll(async () => (await commandOutboxes(page, seed.timelineId)).every((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);
  expect(traffic.legacy).toEqual([]);
  const final = (await history(harness, seed)).items;
  expect(final).toHaveLength(before.items.length + 3);
  expect(final.filter((item: any) => item.receipt?.idempotency_key === originalTrim.key)).toHaveLength(1);
});

test('P1 split -> trim new clip: a real Agent move refuses the stale trim and the App rolls back with a message', async ({ page, harness, astrid }) => {
  const seed = await seedOneClip(harness, astrid);
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  const traffic = observe(page, true);
  const signals: P1FailureSignals = { pageErrors: [], consoleErrors: [], requestFailures: [] };
  let heldTrim: Route | undefined;
  await page.route(COMMITS, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const post = traffic.posts.find((candidate) => candidate.key === route.request().headers()['idempotency-key']);
    if (post && traffic.posts.indexOf(post) === 1) { heldTrim = route; return; }
    const response = await route.fetch({ maxRetries: 0 });
    await forward(route, response, await response.json());
  });
  await openChain(page, harness, seed, signals);
  const before = await history(harness, seed);
  const original = (await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/composition-revisions/${before.head.revision_id}`)).body.payload;
  const originalClip = structuredClone(original.clips[0]);
  await splitSource(page, seed);
  await expect.poll(() => traffic.posts.length, CEILING).toBe(1);
  await expect.poll(() => traffic.posts[0].response, CEILING).not.toBeUndefined();
  const split = traffic.posts[0];
  assertV2Request(split, harness, seed);
  assertSuccessfulReply(split, 'split');
  const splitDocument = parentOf(split.response);
  const inserted = (split.body.commands[0] as any).args.changes.find((change: any) => change.op === 'list.insert');
  expect(inserted.value.id).toBe(inserted.id);
  expect(inserted.order_before).toEqual([SOURCE_ID]);
  expect(inserted.after_id).toBe(SOURCE_ID);
  const rightId = inserted.id;
  let agent: any = null;
  await trimSourceWindow(page, rightId, '3');
  try {
    await expect.poll(() => traffic.posts.length, CEILING).toBe(2);
  } catch (error) {
    try {
      await captureSecondCaseFailureDiagnostics({ page, harness, seed, traffic, signals, before, originalClip, rightId, split, agent });
    } catch {
      // Failure-only diagnostics must never replace the original assertion failure.
    }
    throw error;
  }
  await expect.poll(() => !!heldTrim, CEILING).toBe(true);
  const trim = traffic.posts[1];
  let agentParent: any;
  let originalError: unknown;
  let releaseError: unknown;
  try {
    assertV2Request(trim, harness, seed);
    expect(trim.raw).toBeTruthy();
    expect(trim.key).toBeTruthy();
    expect(trim.body).toMatchObject({ base_revision_id: split.response.data.accepted_revision_id,
      base_publication_id: split.response.receipt.receipt_id, merge: 'fields',
      reads: expect.arrayContaining([
        { kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${rightId}`, 'at'], state: { state: 'present', value: SPLIT_AT } },
        { kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${rightId}`, 'from'], state: { state: 'present', value: originalClip.from } },
      ]) });
    agent = await astrid.commitCaptured(harness.seed.projectId, seed.timelineId, pin(split.response), { kind: 'move', clipId: rightId, on: 3 }, 'p1-agent-conflict');
    expect(agent.data.status).toBe('accepted');
    expect(agent.data.rebased_onto).toBeNull();
    agentParent = parentOf(agent);
    // Preserve the exact split baseline for fields the native move did not intend to change.
    expect(agentParent.clips[0]).toEqual(splitDocument.clips[0]);
    expect(agentParent.clips[1]).toMatchObject({ id: rightId, at: 3, from: originalClip.from, to: originalClip.to, hold: originalClip.to - SPLIT_AT });
    expect(agentParent.clips[1].app).toEqual({ ...splitDocument.clips[1].app,
      astrid: { fixed_start: true, for: originalClip.to - SPLIT_AT } });
  } catch (error) {
    originalError = error;
    throw error;
  } finally {
    const route = heldTrim;
    heldTrim = undefined;
    if (route) {
      try {
        const trimWire = await route.fetch({ maxRetries: 0 });
        await forward(route, trimWire, await trimWire.json());
      } catch (cleanupFailure) {
        await route.abort('failed').catch(() => {});
        if (originalError === undefined) releaseError = cleanupFailure;
      }
    }
  }
  if (releaseError !== undefined) throw releaseError;
  await expect.poll(() => traffic.posts[1].status, CEILING).not.toBeUndefined();
  expect(traffic.posts[1].status).toBe(409);
  expect(traffic.posts[1].response.details).toMatchObject({ status: 'conflict', reason: 'value_conflict',
    current: pin(agent), conflicts: expect.any(Array) });
  expect(traffic.posts[1].response.details.conflicts.length).toBeGreaterThan(0);
  for (const conflict of traffic.posts[1].response.details.conflicts) {
    expect(conflict).toMatchObject({ kind: expect.any(String), ref: expect.any(String), path: expect.any(Array),
      base: expect.any(Object), theirs: expect.any(Object), ours: expect.any(Object), choices: expect.any(Array) });
    for (const token of conflict.path) expect(token).toEqual(expect.any(String));
    for (const state of [conflict.base, conflict.theirs, conflict.ours]) {
      if (state.state === 'present') expect(state).toHaveProperty('value');
      else expect(state).toEqual({ state: 'absent' });
    }
  }
  expect(traffic.posts[1].response.details.conflicts).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'value_conflict', ref: 'parent', path: ['config', 'clips', `id:${rightId}`, 'at'] }),
  ]));
  const conflictDialog = page.getByRole('alertdialog');
  await expect(conflictDialog).toBeVisible();
  await expect(conflictDialog.getByRole('heading', { name: 'This timeline changed somewhere else', exact: true })).toBeVisible();
  await expect(conflictDialog.getByText('Keep your changes, or switch to the latest version.', { exact: true })).toBeVisible();
  await expect(conflictDialog.getByRole('button', { name: 'Use latest version', exact: true })).toBeVisible();
  await expect(conflictDialog.getByRole('button', { name: 'Keep my changes', exact: true })).toBeVisible();
  await expect.poll(async () => (await commandOutboxes(page, seed.timelineId)).find((owner) => owner.pending)?.pending?.outcome?.kind, CEILING).toBe('rejected');
  const current = await history(harness, seed);
  expect(current.items).toHaveLength(before.items.length + 2);
  expect(current.head).toEqual(pin(agent));
  const currentRevision = (await harness.runtimeJson('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/composition-revisions/${current.head.revision_id}`)).body;
  const currentParent = currentRevision.payload;
  // The refused trim must leave the complete canonical parent/closure equal to the
  // actual accepted Agent baseline; do not reconstruct a guessed move result here.
  expect(currentRevision).toMatchObject({ revision_id: agent.data.canonical_document.parent_revision.revision_id,
    content_digest: agent.data.canonical_document.parent_revision.content_digest,
    payload: agentParent, dependency_manifest: agent.data.canonical_document.dependency_manifest });
  expect(agent.data.canonical_document.shot_revisions).toEqual([]);
  expect(agent.data.canonical_document.internal_timeline_revisions).toEqual([]);
  expect(currentParent.clips.map((clip: any) => clip.id)).toEqual([SOURCE_ID, rightId]);
  expect(currentParent.clips[0]).toEqual(agentParent.clips[0]);
  expect(currentParent.clips[1]).toEqual(agentParent.clips[1]);
  expect(currentParent.clips[0].app.opaque).toEqual(currentParent.clips[1].app.opaque);
  expect(currentParent.clips[0].app['org.example']).toEqual(currentParent.clips[1].app['org.example']);
  expect(currentParent.clips[0].app.astrid).toEqual(splitDocument.clips[0].app.astrid);
  expect(currentParent.clips[1].app.astrid).toEqual({ fixed_start: true, for: originalClip.to - SPLIT_AT });
  expect(currentParent.config.clips).toEqual(currentParent.clips);
  expect(traffic.legacy).toEqual([]);
});

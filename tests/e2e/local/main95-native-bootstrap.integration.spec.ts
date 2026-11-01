import { expect, type Page, type Route } from '@playwright/test';
import { ASTRID_PYTHON } from './support/astrid.ts';
import {
  APP_ENTRY_ROUTE,
  commandOutboxes,
  expectConnected,
  firstTrackName,
  openApp,
  test as appTest,
} from './support/app.ts';

const COMMIT = /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/;
const CREATE = /\/v1\/projects\/[^/]+\/timelines$/;
const CEILING = { timeout: 90_000 };
const test = appTest;

type RuntimeResponse = { data: Record<string, any>; receipt: Record<string, any> };
type Attempt = { body: string; key: string; response: RuntimeResponse };
type CreateAttempt = Attempt & { body: string; key: string };

async function captureBootstrapWire(page: Page) {
  const creates: CreateAttempt[] = [];
  const commits: Attempt[] = [];
  const intercept = async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const response = await route.fetch({ maxRetries: 0 });
    if (CREATE.test(new URL(request.url()).pathname)) {
      creates.push({ body: request.postData()!, key: request.headers()['idempotency-key'], response: await response.json() as RuntimeResponse });
      await route.fulfill({ response });
      return;
    }
    const attempt: Attempt = {
      body: request.postData()!,
      key: request.headers()['idempotency-key'],
      response: await response.json() as RuntimeResponse,
    };
    commits.push(attempt);
    if (commits.length === 1) await route.abort('connectionreset');
    else await route.fulfill({ response });
  };
  await page.route(COMMIT, intercept);
  await page.route(CREATE, intercept);
  return {
    creates,
    commits,
    async close() {
      await page.unroute(COMMIT, intercept);
      await page.unroute(CREATE, intercept);
    },
  };
}

const emptyBaseline = {
  config: { clips: [], tracks: [] },
  registry: {},
  clips: [],
  occurrences: [],
};

const defaultConfig = {
  clips: [],
  tracks: [
    { id: 'V1', kind: 'visual', label: 'V1', scale: 1, fit: 'contain', opacity: 1, blendMode: 'normal' },
    { id: 'A1', kind: 'audio', label: 'A1', scale: 1, fit: 'contain', opacity: 1, blendMode: 'normal' },
  ],
  output: { resolution: '1280x720', fps: 30, file: 'output.mp4', background: null, background_scale: null },
};
const initializedPayload = { config: defaultConfig, registry: { assets: {} }, clips: [], occurrences: [], name: 'Main', slug: 'main' };

test('Main95 real native bootstrap: create/init, lost ACK retry, daemon restart, and raw readback', async ({ page, harness }) => {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  await openApp(page, harness);
  await expectConnected(page);
  const wire = await captureBootstrapWire(page);
  const projectName = `Main95 bootstrap ${Date.now()}`;
  await page.getByRole('button', { name: 'New project' }).click();
  await page.locator('#project-name').fill(projectName);
  const creating = page.getByRole('button', { name: 'Create Project' }).click();
  await expect.poll(() => wire.creates.length, CEILING).toBe(1);
  await expect.poll(() => wire.commits.length, CEILING).toBe(1);

  const create = wire.creates[0].response;
  const createData = create.data;
  expect(wire.creates[0].body).toEqual(expect.stringContaining('"timeline_id"'));
  expect(JSON.parse(wire.creates[0].body)).toEqual({ timeline_id: expect.any(String), name: 'Main' });
  expect(create.receipt.command_kind).toBe('timeline.create');
  expect(createData).toMatchObject({ archived: false, head_revision_id: expect.any(String), head_publication_id: expect.any(String) });
  const commitBody = JSON.parse(wire.commits[0].body) as Record<string, any>;
  const projectId = commitBody.project_id as string;
  const timelineId = commitBody.timeline_id as string;
  const base = `/v1/projects/${projectId}/timelines/${timelineId}`;
  expect(wire.commits[0].key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/);
  expect(commitBody).toMatchObject({
    api_version: 1,
    project_id: projectId,
    timeline_id: timelineId,
    base_revision_id: createData.head_revision_id,
    base_publication_id: createData.head_publication_id,
    source: { via: 'app' },
    commands: [
      { op: 'timeline.init', version: '1', select: 'parent', args: { name: 'Main', slug: 'main', output: defaultConfig.output } },
      { op: 'track.create', version: '1', args: { row: expect.objectContaining({ id: 'V1', kind: 'visual' }) } },
      { op: 'track.create', version: '1', args: { row: expect.objectContaining({ id: 'A1', kind: 'audio' }) } },
    ],
  });

  const baseline = await harness.runtimeJson<any>('GET', `${base}/composition-revisions/${createData.head_revision_id}`);
  expect(baseline.status).toBe(200);
  expect(baseline.body.payload).toEqual(emptyBaseline);
  const accepted = wire.commits[0].response;
  expect(accepted.data.status).toBe('accepted');
  expect(accepted.data.previous_revision_id).toBe(createData.head_revision_id);
  expect(accepted.data.previous_publication_id).toBe(createData.head_publication_id);
  expect(accepted.data.canonical_document.project_id).toBe(projectId);
  expect(accepted.data.canonical_document.timeline_id).toBe(timelineId);
  expect(accepted.data.canonical_document.parent_revision.payload).toEqual(initializedPayload);
  expect(accepted.receipt).toMatchObject({ command_kind: 'timeline.commit', idempotency_key: wire.commits[0].key });
  await creating;

  const pending = (await commandOutboxes(page, timelineId)).find((owner) => owner.pending);
  expect(pending?.pending?.request).toEqual({
    method: 'POST', path: `${base}/commit`, body: wire.commits[0].body, key: wire.commits[0].key,
  });
  const beforeRestart = harness.runtimeInstanceId;
  await harness.restartRuntime();
  expect(harness.runtimeInstanceId).not.toBe(beforeRestart);
  await page.reload();
  await expectConnected(page);
  await page.goto(`${harness.origin}${APP_ENTRY_ROUTE}?project=${encodeURIComponent(projectId)}&timeline=${encodeURIComponent(timelineId)}`);
  await expectConnected(page);
  const recover = page.getByRole('button', { name: /^Recover saved edits/ });
  await expect(recover).toBeEnabled(CEILING);
  await recover.click();
  await expect.poll(() => wire.commits.length, CEILING).toBe(2);
  expect(wire.commits[1]).toMatchObject({ body: wire.commits[0].body, key: wire.commits[0].key });
  await expect.poll(async () => (await commandOutboxes(page, timelineId)).every((owner) => !owner.pending && !owner.intents.length), CEILING).toBe(true);

  const history = await harness.runtimeJson<any>('GET', `${base}/commits?limit=50`);
  expect(history.status).toBe(200);
  expect(history.body.head).toEqual({ revision_id: accepted.data.accepted_revision_id, publication_id: accepted.receipt.receipt_id });
  // Main's create_timeline publishes one normal empty baseline before the
  // native initialization commit. Keep that contract one-to-one as
  // baseline=1 plus native-init=1, without filtering either history record.
  expect(history.body.items).toHaveLength(2);
  const [bootstrapEntry, initEntry] = history.body.items;
  expect((bootstrapEntry.receipt.result as { revision_id?: unknown }).revision_id).toBe(bootstrapEntry.revision_id);
  expect(bootstrapEntry).toMatchObject({
    publication_id: bootstrapEntry.receipt.receipt_id,
    previous: null,
    intent: 'bootstrap',
    records: null,
    receipt: {
      command_kind: 'parent_composition.publish',
      idempotency_key: `bootstrap:${timelineId}`,
      project_id: projectId,
      result: {
        project_id: projectId,
        timeline_id: timelineId,
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
      project_id: projectId,
      result: {
        canonical_document: { project_id: projectId, timeline_id: timelineId },
      },
    },
  });
  expect(history.body.items.map((entry: Record<string, any>) => entry.receipt.command_kind)).toEqual([
    'parent_composition.publish', 'timeline.commit',
  ]);
  expect(history.body.head).toEqual({ revision_id: initEntry.revision_id, publication_id: initEntry.publication_id });
  expect(initEntry.records?.commands.map((record: Record<string, any>) => [record.command.op, record.command.version, record.command.select])).toEqual([
    ['timeline.init', '1', 'parent'],
    ['track.create', '1', 'parent'],
    ['track.create', '1', 'parent'],
  ]);
  const readback = await harness.runtimeJson<any>('GET', `${base}/composition-revisions/${accepted.data.accepted_revision_id}`);
  expect(readback.body.payload).toEqual(initializedPayload);
  await expect(firstTrackName(page)).toHaveValue('V1', CEILING);
  await wire.close();
  expect(wire.commits[1].response.receipt.receipt_id).toBe(accepted.receipt.receipt_id);
});

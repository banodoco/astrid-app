// Contract test for the fake Runtime's wiring: `node --import tsx --test tests/e2e/fake-runtime/server.contract.test.mjs`
// (plain `node --test` also works; the server itself always runs under tsx in a child process).
//
// What is NOT here: whether the fakes reproduce the real daemon. That is held in vitest, where the
// recordings load (`src/test/fakeRuntimeRouter.recorded.test.ts` for tasks, events and errors,
// `src/test/fakeWorkspaceRuntime.recorded.test.ts` for the stale-head publish 409). This file holds the
// server's own promises: auth, dispatch, the seed, content addressing, reset, atomic saves, ports and env.
//
// It also carries what the retired stub contract test asserted:
// the empty task/generation envelopes, object GET/HEAD, the ACP reads, the
// mutate-then-reset behaviour of all three timelines, the editor connection binding (schema digest,
// connector scopes and targeted-execution capability read from src/integrations/runtime), and the
// canonical audio compositions bound to the committed WAV. Its legacy non-/v1 routes (`/projects/...`, `/save`,
// registry PUT, `X-Astrid-Bridge-Version` on every reply) have no Runtime equivalent and are not ported.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AUDIO_REACTIVE_FIXTURE_TIMELINE_ID, AUDIO_REACTIVE_OFFSET_FIXTURE_TIMELINE_ID, AUDIO_REACTIVE_OFFSET_START_FRAME, FIXTURE_TIMELINE_ID, createAudioReactiveColourFixtures, createOffsetAudioReactiveColourFixtures, createTimelineFixtures } from '../../../src/test/fakeRuntimeSeed.mjs';
import {
  FAKE_RUNTIME_ACTOR_ID,
  FAKE_RUNTIME_INSTANCE_ID,
  FAKE_RUNTIME_REALM_ID,
} from '../../../src/test/fakeRuntimeIdentity.mjs';
import { fakeRuntimeEnv, startFakeRuntime } from './launch.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SLUG = 'demo-project';
const PROJECT_ID = 'demo-project-id';
const read = (relative) => readFileSync(resolve(REPO, relative), 'utf8');
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

let fake;

function call(path, { method = 'GET', token = fake.token, headers = {}, body } = {}) {
  return fetch(`${fake.origin}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body,
  });
}
const json = async (path, options) => await (await call(path, options)).json();
const postJson = (path, value, headers = {}) => call(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(value),
});

const reset = async () => await json('/__test/reset', { method: 'POST' });
const head = async (timelineId = FIXTURE_TIMELINE_ID) => (
  await json(`/v1/projects/${PROJECT_ID}/timelines`)
).items.find((item) => item.timeline_id === timelineId).head_revision_id;
const revision = async (timelineId, revisionId) => await json(
  `/v1/projects/${SLUG}/timelines/${timelineId}/composition-revisions/${revisionId}`,
);
const publish = (timelineId, { expectedHead, revisionId, key, config, registry }) => postJson(
  `/v1/projects/${SLUG}/timelines/${timelineId}/composition-revisions`,
  {
    expected_head: expectedHead,
    parent_revision_id: revisionId,
    parent_composition: { config, registry, clips: config.clips },
  },
  { 'Idempotency-Key': key },
);
const admission = () => ({
  project: SLUG,
  capability_id: 'astrid.image_generation',
  capability_digest: `sha256:${'a'.repeat(64)}`,
  schema_version: '1',
  input_object_ids: [],
  spec: { family: 'image_generation', params: {}, output_policy: {} },
  storage_estimate: { scratch_bytes: 0, output_bytes: 0 },
  settlement_effect: {},
});

before(async () => {
  fake = await startFakeRuntime();
});
after(async () => {
  await fake?.close();
});
beforeEach(async () => {
  await reset();
});

describe('identity and auth', () => {
  test('workspace.json is open and carries exactly the key set the client demands, endpoint on loopback', async () => {
    const response = await call('/runtime-config/v1/workspace.json', { token: null });
    assert.equal(response.status, 200);
    const config = await response.json();
    assert.deepEqual(Object.keys(config).sort(), ['actorId', 'endpoint', 'realmId', 'runtimeInstanceId', 'schemaVersion']);
    assert.equal(config.schemaVersion, 1);
    assert.equal(config.actorId, FAKE_RUNTIME_ACTOR_ID);
    assert.equal(config.realmId, FAKE_RUNTIME_REALM_ID);
    assert.equal(config.runtimeInstanceId, FAKE_RUNTIME_INSTANCE_ID);
    assert.equal(config.endpoint, `http://127.0.0.1:${fake.port}`);
  });

  test('everything else needs the bearer token: /v1, ACP and reset answer 401 without it', async () => {
    for (const [method, path] of [
      ['GET', '/v1/health'], ['GET', '/v1/projects'], ['GET', '/v1/events'], ['POST', '/__test/reset'],
      ['GET', `/projects/${SLUG}/chat`], ['POST', '/connect'], ['GET', '/health'], ['POST', '/__test/agent-setup'],
    ]) {
      const none = await call(path, { method, token: null });
      assert.equal(none.status, 401, `${method} ${path} without a token`);
      assert.equal((await none.json()).code, 'unauthorized');
      const wrong = await call(path, { method, token: 'not-the-token' });
      assert.equal(wrong.status, 401, `${method} ${path} with a wrong token`);
    }
  });

  test('reset accepts POST only', async () => {
    assert.equal((await call('/__test/reset', { method: 'GET' })).status, 405);
  });

  test('reset with { seed: "empty" } starts the demo timeline as a new, empty one; a plain reset brings the demo back', async () => {
    const empty = await (await postJson('/__test/reset', { seed: 'empty' })).json();
    assert.equal(empty.seed, 'empty');
    const blank = await revision(FIXTURE_TIMELINE_ID, empty.heads[FIXTURE_TIMELINE_ID]);
    assert.deepEqual(blank.payload.config.clips, []);
    assert.deepEqual(blank.payload.config.tracks.map((track) => track.id), ['V1', 'A1']);
    assert.deepEqual(blank.payload.registry.assets, {});

    const demo = await reset();
    assert.equal(demo.seed, 'demo');
    const restored = await revision(FIXTURE_TIMELINE_ID, demo.heads[FIXTURE_TIMELINE_ID]);
    assert.deepEqual(restored.payload.config, createTimelineFixtures().config);
  });

  test('health, handshake and realm come from the fixture with the fixed identity; the router health is shadowed', async () => {
    const health = await json('/v1/health');
    assert.equal(health.runtime_instance_id, FAKE_RUNTIME_INSTANCE_ID);
    const handshake = await (await postJson('/v1/handshake', { client_name: 'contract', client_version: '1', requested_scopes: [] })).json();
    assert.equal(handshake.actor_id, FAKE_RUNTIME_ACTOR_ID);
    assert.equal(handshake.realm_id, FAKE_RUNTIME_REALM_ID);
    assert.equal((await json('/v1/realm')).realm_id, FAKE_RUNTIME_REALM_ID);
  });

  test('the editor connection is bound to the Runtime contract the app ships: digest, connector scopes, capability, realm, projects', async () => {
    // Read from the app's own sources as text, so a drifted fake cannot agree with itself.
    const expectedScopes = /export const RUNTIME_CLIENT_SCOPES = \[([\s\S]*?)\];/
      .exec(read('src/integrations/runtime/client.ts'))?.[1].match(/'([^']+)'/g)?.map((scope) => scope.slice(1, -1));
    const expectedDigest = /SCHEMA_DIGEST = "(sha256:[0-9a-f]+)"/.exec(read('src/integrations/runtime/generated-contract-metadata.ts'))?.[1];
    const expectedCapability = /RUNTIME_TARGETED_EXECUTION_CAPABILITY = '([^']+)'/.exec(read('src/integrations/runtime/contract-metadata.ts'))?.[1];
    assert.ok(expectedScopes?.length);
    assert.ok(expectedDigest);
    assert.ok(expectedCapability);

    const health = await json('/v1/health');
    assert.equal(health.status, 'ok');
    assert.equal(health.protocol, 'workspace.v1');
    assert.equal(health.schema_digest, expectedDigest);
    assert.equal(health.runtime_instance_id, FAKE_RUNTIME_INSTANCE_ID);

    const handshakeResponse = await postJson('/v1/handshake', {
      protocol: 'workspace.v1', client_name: 'contract-test', client_version: '1', requested_scopes: expectedScopes,
    });
    assert.equal(handshakeResponse.status, 200);
    const handshake = await handshakeResponse.json();
    assert.equal(handshake.protocol, 'workspace.v1');
    assert.equal(handshake.schema_digest, expectedDigest);
    assert.equal(handshake.actor_id, FAKE_RUNTIME_ACTOR_ID);
    assert.equal(handshake.realm_id, FAKE_RUNTIME_REALM_ID);
    assert.deepEqual(handshake.scopes, expectedScopes);
    assert.deepEqual(handshake.capabilities, [expectedCapability]);

    const realm = await call('/v1/realm');
    assert.equal(realm.status, 200);
    assert.equal((await realm.json()).realm_id, handshake.realm_id);
    const projects = await call('/v1/projects?limit=200');
    assert.equal(projects.status, 200);
    assert.equal((await projects.json()).next_cursor, null);
  });

  test('an unknown route is a logged 404, never an invented body', async () => {
    const routed = await call('/v1/no-such-route');
    assert.equal(routed.status, 404);
    assert.match(JSON.stringify(await routed.json()), /No fake route for \/v1\/no-such-route/);
    const outside = await call('/nowhere');
    assert.equal(outside.status, 404);
    assert.equal((await outside.json()).code, 'not_found');
  });

  test('a fixture that throws (the retired mutable timeline write) answers 500 fake_internal and the server keeps serving', async () => {
    const response = await call(`/v1/projects/${SLUG}/timelines/${FIXTURE_TIMELINE_ID}`, { method: 'POST' });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).code, 'fake_internal');
    assert.equal((await call('/v1/health')).status, 200);
  });

  test('fixture replies carry JSON content-type and no-store when the fixture sets none', async () => {
    const response = await call('/v1/health');
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

describe('projects, timelines and the seed', () => {
  test('the project row (router) and the seed agree on the canonical id, and a slug or id selects it', async () => {
    const listed = (await json('/v1/projects')).items;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].project_id, PROJECT_ID);
    assert.equal(listed[0].slug, SLUG);
    for (const selector of [SLUG, PROJECT_ID]) {
      const response = await call(`/v1/projects/${selector}`);
      assert.equal(response.status, 200, selector);
      assert.deepEqual(await response.json(), listed[0]);
    }
    assert.equal((await call('/v1/projects/other-project')).status, 404);
  });

  test('the timeline list aggregates the three seeded timelines with their heads, by slug or id', async () => {
    for (const selector of [SLUG, PROJECT_ID]) {
      const page = await json(`/v1/projects/${selector}/timelines`);
      assert.equal(page.next_cursor, null);
      assert.deepEqual(
        page.items.map((item) => item.timeline_id),
        [FIXTURE_TIMELINE_ID, AUDIO_REACTIVE_FIXTURE_TIMELINE_ID, AUDIO_REACTIVE_OFFSET_FIXTURE_TIMELINE_ID],
      );
      assert.equal(page.items.filter((item) => item.is_default).length, 1);
      assert.ok(page.items.every((item) => item.project_id === PROJECT_ID && /^seed-r\d+$/.test(item.head_revision_id)));
    }
    assert.equal((await call('/v1/projects/other-project/timelines')).status, 404);
    assert.equal((await call(`/v1/projects/${SLUG}/timelines/no-such-timeline/inspect`, { method: 'POST', body: '{}' })).status, 404);
  });

  test('the project document list is an empty page by slug or id, and 404 for an unknown project', async () => {
    for (const selector of [SLUG, PROJECT_ID]) {
      assert.deepEqual(await json(`/v1/projects/${selector}/documents?limit=100&kind=media.transcript`), { items: [], next_cursor: null });
    }
    assert.equal((await call('/v1/projects/other-project/documents')).status, 404);
  });

  test('history shows only revisions the instance holds: the seeded head', async () => {
    const page = await json(`/v1/projects/${SLUG}/timelines/${FIXTURE_TIMELINE_ID}/composition-revisions?limit=50`);
    assert.deepEqual(page.items.map((item) => [item.revision_id, item.is_current_head]), [[await head(), true]]);
  });

  test('the seeded registries are content-addressed: media_id equals content_sha256 and no display src or generationId survives', async () => {
    for (const timelineId of [FIXTURE_TIMELINE_ID, AUDIO_REACTIVE_FIXTURE_TIMELINE_ID, AUDIO_REACTIVE_OFFSET_FIXTURE_TIMELINE_ID]) {
      const { payload } = await revision(timelineId, await head(timelineId));
      for (const [key, entry] of Object.entries(payload.registry.assets)) {
        assert.match(entry.media_id, /^sha256:[0-9a-f]{64}$/, `${timelineId}/${key}`);
        assert.equal(entry.content_sha256, entry.media_id);
        assert.equal(entry.src, undefined);
        assert.equal(entry.generationId, undefined);
      }
    }
  });

  test('every seeded asset resolves through /v1/objects/sha256:... with Range, HEAD and an ETag equal to its id', async () => {
    const ids = new Set();
    for (const timelineId of [FIXTURE_TIMELINE_ID, AUDIO_REACTIVE_FIXTURE_TIMELINE_ID, AUDIO_REACTIVE_OFFSET_FIXTURE_TIMELINE_ID]) {
      const { payload } = await revision(timelineId, await head(timelineId));
      for (const entry of Object.values(payload.registry.assets)) ids.add([entry.media_id, entry.type]);
    }
    assert.equal(ids.size >= 4, true);
    for (const [objectId, mediaType] of ids) {
      const url = `/v1/objects/${encodeURIComponent(objectId)}`;
      const full = await call(url);
      assert.equal(full.status, 200, objectId);
      assert.equal(full.headers.get('etag'), `"${objectId}"`);
      assert.equal(full.headers.get('content-type'), mediaType);
      const bytes = Buffer.from(await full.arrayBuffer());
      assert.equal(sha256(bytes), objectId, 'the served bytes hash to the id');
      assert.equal(Number(full.headers.get('content-length')), bytes.length);

      const ranged = await call(url, { headers: { Range: 'bytes=0-9' } });
      assert.equal(ranged.status, 206);
      assert.equal(ranged.headers.get('content-range'), `bytes 0-9/${bytes.length}`);
      assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(0, 10));
      const suffix = await call(url, { headers: { Range: 'bytes=-4' } });
      assert.equal(suffix.status, 206);
      assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(bytes.length - 4));
      const unsatisfiable = await call(url, { headers: { Range: `bytes=${bytes.length + 5}-` } });
      assert.equal(unsatisfiable.status, 416);
      assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${bytes.length}`);

      const headResponse = await call(url, { method: 'HEAD' });
      assert.equal(headResponse.status, 200);
      assert.equal(headResponse.headers.get('etag'), `"${objectId}"`);
      assert.equal(headResponse.headers.get('content-length'), String(bytes.length));
      assert.equal((await headResponse.arrayBuffer()).byteLength, 0);
    }
  });

  test('the seeded content matches the fixture module: audio timeline isolated, offset timeline values intact', async () => {
    const audioPristine = createAudioReactiveColourFixtures();
    const audio = (await revision(AUDIO_REACTIVE_FIXTURE_TIMELINE_ID, await head(AUDIO_REACTIVE_FIXTURE_TIMELINE_ID))).payload;
    assert.deepEqual(audio.config, audioPristine.config);
    assert.equal(audio.config.output.fps, 30);
    assert.deepEqual(audio.config.clips[0].params.events.map((event) => event.frame), [2, 4]);

    const offsetPristine = createOffsetAudioReactiveColourFixtures();
    const offset = (await revision(AUDIO_REACTIVE_OFFSET_FIXTURE_TIMELINE_ID, await head(AUDIO_REACTIVE_OFFSET_FIXTURE_TIMELINE_ID))).payload;
    assert.deepEqual(offset.config, offsetPristine.config);
    assert.equal(offset.config.clips[0].at, AUDIO_REACTIVE_OFFSET_START_FRAME / 30);
    assert.equal(offset.config.clips[0].hold, 0.6);
    assert.equal(offset.config.clips[0].params.initialColor, '#102030');
    assert.deepEqual(offset.config.clips[0].params.events.map((event) => event.frame), [2, 4]);
  });

  test('the audio timelines carry canonical shot compositions bound to the committed WAV, each with its own parent identity', async () => {
    const wav = readFileSync(resolve(REPO, 'public/audio-reactive-colour-tone.wav'));
    const wavDigest = sha256(wav);
    const audioPristine = createAudioReactiveColourFixtures();
    const offsetPristine = createOffsetAudioReactiveColourFixtures();
    const audio = audioPristine.shotComposition;
    const offset = offsetPristine.shotComposition;

    for (const [composition, expectedAtMs, initialColor] of [
      [audio, 0, '#000000'],
      [offset, AUDIO_REACTIVE_OFFSET_START_FRAME * (1000 / 30), '#102030'],
    ]) {
      const revision = composition.shot_revisions[0];
      assert.equal(composition.occurrences[0].at_ms, Math.round(expectedAtMs));
      assert.equal(revision.internal_timeline_revision.timeline.clips[0].params.initialColor, initialColor);
      // The digest is the SHA-256 of the file the Runtime serves, not a literal that merely looks like one.
      assert.equal(revision.assets[0].digest, wavDigest);
      assert.equal(revision.audio.digest, wavDigest);
    }
    assert.notEqual(offset.project.document_id, audio.project.document_id);
    assert.notEqual(offset.primary_timeline.head.revision_id, audio.primary_timeline.head.revision_id);

    // The same bytes are what the seeded registry serves, so the canonical audio resolves through /v1/objects.
    for (const timelineId of [AUDIO_REACTIVE_FIXTURE_TIMELINE_ID, AUDIO_REACTIVE_OFFSET_FIXTURE_TIMELINE_ID]) {
      const { payload } = await revision(timelineId, await head(timelineId));
      assert.equal(payload.registry.assets.source_audio.media_id, wavDigest, timelineId);
    }
    assert.equal(createTimelineFixtures().shotComposition, undefined);
  });
});

describe('project selection', () => {
  test('PUT /v1/projects/selection records the demo project and refuses an unknown one', async () => {
    const put = (project) => call('/v1/projects/selection', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'selection-test' },
      body: JSON.stringify({ project, scope: 'workspace' }),
    });
    const selected = await put(SLUG);
    assert.equal(selected.status, 200);
    const body = await selected.json();
    assert.equal(body.data.project_id, PROJECT_ID);
    assert.equal(body.receipt.idempotency_key, 'selection-test');
    assert.equal((await put('no-such-project')).status, 404);
    assert.equal((await call('/v1/projects/selection')).status, 405);
  });
});

describe('the object layer is one content-addressed store', () => {
  test('the project object list holds the seeded assets only: the router placeholders are gone', async () => {
    const page = await json(`/v1/projects/${SLUG}/objects`);
    assert.ok(page.items.length >= 4);
    assert.ok(page.items.every((item) => /^sha256:[0-9a-f]{64}$/.test(item.object_id) && item.object_id === item.digest));
    assert.ok(!page.items.some((item) => /^sha256:([12])\1{63}$/.test(item.object_id)), 'no placeholder objects');
  });

  test('ingest -> the list contains it -> GET has ETag = id and the bytes hash to the id; location agrees', async () => {
    const bytes = Buffer.from('a dropped file, content addressed');
    const id = sha256(bytes);
    const ingested = await call(`/v1/projects/${SLUG}/objects`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Idempotency-Key': 'ingest-1', 'X-Original-Name': 'drop.txt' },
      body: bytes,
    });
    assert.equal(ingested.status, 201);
    const body = await ingested.json();
    assert.equal(body.data.object_id, id);
    assert.equal(body.data.digest, id);

    const listed = (await json(`/v1/projects/${SLUG}/objects?limit=200`)).items;
    assert.ok(listed.some((item) => item.object_id === id), 'the list (authorises task inputs) contains the new object');

    const got = await call(`/v1/objects/${encodeURIComponent(id)}`);
    assert.equal(got.headers.get('etag'), `"${id}"`);
    assert.equal(sha256(Buffer.from(await got.arrayBuffer())), id);

    const location = await json(`/v1/projects/${PROJECT_ID}/objects/${encodeURIComponent(id)}/location`);
    assert.equal(location.object_id, id);
    assert.equal(location.digest, id);
    assert.equal(location.size, bytes.length);
  });

  test('a media import is stored under the digest of its bytes, so the provider identity check passes', async () => {
    const bytes = Buffer.from('an imported clip');
    const id = sha256(bytes);
    const imported = await call(`/v1/projects/${PROJECT_ID}/media-imports`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4', 'Idempotency-Key': 'import-1', 'X-Original-Name': 'clip.mp4' },
      body: bytes,
    });
    assert.equal(imported.status, 201);
    assert.equal((await imported.json()).data.asset_id, id);
    assert.equal(imported.headers.get('etag'), `"${id}"`);
    const got = await call(`/v1/objects/${encodeURIComponent(id)}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('etag'), `"${id}"`);
    assert.equal(sha256(Buffer.from(await got.arrayBuffer())), id);
  });

  test('reset returns the store to the seeded assets only', async () => {
    const before = (await json(`/v1/projects/${SLUG}/objects?limit=200`)).items.length;
    await call(`/v1/projects/${SLUG}/objects`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'Idempotency-Key': 'k' }, body: 'ephemeral' });
    assert.equal((await json(`/v1/projects/${SLUG}/objects?limit=200`)).items.length, before + 1);
    await reset();
    assert.equal((await json(`/v1/projects/${SLUG}/objects?limit=200`)).items.length, before);
    assert.equal((await call(`/v1/objects/${encodeURIComponent(sha256(Buffer.from('ephemeral')))}`)).status, 404);
  });
});

describe('saves, reset and atomicity', () => {
  test('a publish lands, moves the head and the history, and is read back; a stale head is 409 stale_head', async () => {
    const base = await head();
    const { payload } = await revision(FIXTURE_TIMELINE_ID, base);
    const config = { ...payload.config, output: { ...payload.config.output, fps: 12 } };
    const response = await publish(FIXTURE_TIMELINE_ID, { expectedHead: base, revisionId: 'edit-1', key: 'save-1', config, registry: payload.registry });
    assert.equal(response.status, 200);
    assert.equal(await head(), 'edit-1');
    assert.equal((await revision(FIXTURE_TIMELINE_ID, 'edit-1')).payload.config.output.fps, 12);
    const history = await json(`/v1/projects/${SLUG}/timelines/${FIXTURE_TIMELINE_ID}/composition-revisions?limit=50`);
    assert.deepEqual(history.items.map((item) => item.revision_id), ['edit-1', base]);

    const stale = await publish(FIXTURE_TIMELINE_ID, { expectedHead: base, revisionId: 'edit-2', key: 'save-2', config, registry: payload.registry });
    assert.equal(stale.status, 409);
    const body = await stale.json();
    assert.equal(body.code, 'conflict');
    assert.equal(body.details.reason, 'stale_head');
  });

  test('two concurrent saves with one base give exactly one 200 and one 409 stale_head', async () => {
    const base = await head();
    const { payload } = await revision(FIXTURE_TIMELINE_ID, base);
    const attempts = await Promise.all(['a', 'b'].map((suffix) => publish(FIXTURE_TIMELINE_ID, {
      expectedHead: base, revisionId: `race-${suffix}`, key: `race-${suffix}`, config: payload.config, registry: payload.registry,
    })));
    const statuses = attempts.map((response) => response.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    const loser = attempts.find((response) => response.status === 409);
    assert.equal((await loser.json()).details.reason, 'stale_head');
  });

  test('reset restores the seed, never rewinds a head, and an old head is then stale', async () => {
    const seededHead = await head();
    const seededConfig = (await revision(FIXTURE_TIMELINE_ID, seededHead)).payload.config;
    const { payload } = await revision(FIXTURE_TIMELINE_ID, seededHead);
    const mutated = { ...payload.config, app: { leaked_from_previous_test: true }, clips: [{ id: 'mutated-only', track: 'V1', at: 99, clipType: 'text', hold: 1 }] };
    const registry = { assets: { ...payload.registry.assets, 'mutated-only': { file: 'mutated.bin', type: 'application/octet-stream' } } };
    assert.equal((await publish(FIXTURE_TIMELINE_ID, { expectedHead: seededHead, revisionId: 'mutation', key: 'm', config: mutated, registry })).status, 200);

    // The audio timeline is separate state: mutating it must not leak into the demo timeline.
    const audioHead = await head(AUDIO_REACTIVE_FIXTURE_TIMELINE_ID);
    const audio = (await revision(AUDIO_REACTIVE_FIXTURE_TIMELINE_ID, audioHead)).payload;
    assert.equal((await publish(AUDIO_REACTIVE_FIXTURE_TIMELINE_ID, { expectedHead: audioHead, revisionId: 'audio-mutation', key: 'a', config: { ...audio.config, clips: [] }, registry: audio.registry })).status, 200);
    assert.deepEqual((await revision(FIXTURE_TIMELINE_ID, 'mutation')).payload.config, mutated);

    const first = await reset();
    assert.equal(first.reset, true);
    const afterHead = await head();
    assert.notEqual(afterHead, seededHead, 'a new epoch gets a new head id');
    assert.deepEqual(first.heads[FIXTURE_TIMELINE_ID], afterHead);
    assert.deepEqual((await revision(FIXTURE_TIMELINE_ID, afterHead)).payload.config, seededConfig);
    assert.equal((await revision(FIXTURE_TIMELINE_ID, afterHead)).payload.config.app, undefined);
    assert.deepEqual((await revision(AUDIO_REACTIVE_FIXTURE_TIMELINE_ID, await head(AUDIO_REACTIVE_FIXTURE_TIMELINE_ID))).payload.config, createAudioReactiveColourFixtures().config);
    assert.equal((await call(`/v1/projects/${SLUG}/timelines/${FIXTURE_TIMELINE_ID}/composition-revisions/mutation`)).status, 404);

    const stale = await publish(FIXTURE_TIMELINE_ID, { expectedHead: seededHead, revisionId: 'late', key: 'late', config: mutated, registry });
    assert.equal(stale.status, 409, 'a client holding a pre-reset head stays stale');
    const second = await reset();
    assert.equal(second.epoch, first.epoch + 1);
  });

  test('restore works for any revision the instance holds', async () => {
    const base = await head();
    const { payload } = await revision(FIXTURE_TIMELINE_ID, base);
    await publish(FIXTURE_TIMELINE_ID, { expectedHead: base, revisionId: 'edit-1', key: 'e1', config: { ...payload.config, output: { ...payload.config.output, fps: 12 } }, registry: payload.registry });
    const restored = await postJson(
      `/v1/projects/${SLUG}/timelines/${FIXTURE_TIMELINE_ID}/composition-revisions/${base}/restore`,
      { expected_head: 'edit-1' },
      { 'Idempotency-Key': 'restore-1' },
    );
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).data.new_head, `restore-${base}`);
    assert.equal((await revision(FIXTURE_TIMELINE_ID, `restore-${base}`)).payload.config.output.fps, payload.config.output.fps);
  });
});

describe('tasks, generations and the event feed', () => {
  test('the empty envelopes the editor reads on a cold load', async () => {
    assert.deepEqual(await json(`/v1/projects/${SLUG}/tasks?limit=1`), { items: [], next_cursor: null });
    assert.deepEqual(await json(`/v1/projects/${SLUG}/generations?limit=1`), { items: [], next_cursor: null });
  });

  test('GET /v1/events: a never-null cursor, admissions appear as task events, a bad cursor is the recorded 400', async () => {
    const cold = await json('/v1/events?from=latest');
    assert.deepEqual(cold.items, []);
    assert.equal(typeof cold.next_cursor, 'string');

    const admitted = await postJson('/v1/tasks', admission(), { 'Idempotency-Key': 'task-1' });
    assert.equal(admitted.status, 201);
    const taskId = (await admitted.json()).data.task_id;

    const page = await json(`/v1/events?limit=50&cursor=${cold.next_cursor}`);
    assert.deepEqual(page.items.map((event) => [event.aggregate_type, event.aggregate_id, event.event_type]), [['task', taskId, 'task.admitted']]);
    assert.equal(typeof page.next_cursor, 'string');
    const drained = await json(`/v1/events?limit=50&cursor=${page.next_cursor}`);
    assert.deepEqual(drained.items, []);
    assert.equal(drained.next_cursor, page.next_cursor);

    const bad = await call('/v1/events?cursor=not-a-cursor');
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'invalid_request');
  });

  test('a task from a seeded clip is authorised: its object is in the project object list', async () => {
    const { payload } = await revision(FIXTURE_TIMELINE_ID, await head());
    const seededId = payload.registry.assets['demo-hero'].media_id;
    const authorised = (await json(`/v1/projects/${SLUG}/objects?limit=200`)).items.some((item) => item.object_id === seededId);
    assert.equal(authorised, true);
  });

  test('admit a task, reset, and the task list is empty again; the event cursor does not rewind', async () => {
    await postJson('/v1/tasks', admission(), { 'Idempotency-Key': 'task-1' });
    assert.equal((await json(`/v1/projects/${SLUG}/tasks`)).items.length, 1);
    const before = await json('/v1/events?from=latest');
    await reset();
    assert.deepEqual(await json(`/v1/projects/${SLUG}/tasks`), { items: [], next_cursor: null });
    await postJson('/v1/tasks', admission(), { 'Idempotency-Key': 'task-2' });
    const after = await json(`/v1/events?cursor=${before.next_cursor}`);
    assert.equal(after.items.length, 1, 'an event admitted after the reset is visible from a pre-reset cursor');
  });
});

describe('ACP chat reads', () => {
  test('the chat state answers for the slug and for the canonical id, echoing the caller selector', async () => {
    for (const selector of [SLUG, PROJECT_ID]) {
      assert.deepEqual(await json(`/projects/${selector}/chat`), {
        project_id: selector,
        scope_key: `project:${selector}`,
        revision: 0,
        selected_session_id: null,
        sessions: [],
        draft: { text: '', revision: 0, queued_messages: [] },
      });
    }
    assert.equal((await call('/projects/other-project/chat')).status, 404);
  });

  test('the draft saves with a revision CAS, a stale revision is 409, and reset clears it', async () => {
    const patch = (value) => call(`/projects/${PROJECT_ID}/chat/draft`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const saved = await patch({ expected_revision: 0, text: '', queued_messages: [] });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).draft.revision, 1);
    assert.equal((await patch({ expected_revision: 0, text: 'stale', queued_messages: [] })).status, 409);
    await reset();
    assert.equal((await json(`/projects/${PROJECT_ID}/chat`)).draft.revision, 0);
  });

  test('connect, session/list and events are canned; a prompt is not served', async () => {
    assert.deepEqual(await (await postJson('/connect', {})).json(), { connection_id: 'local-test-connection', initialize: {} });
    assert.deepEqual(await (await postJson('/local-test-connection/rpc', { method: 'session/list', params: {} })).json(), { result: { sessions: [] } });
    assert.equal((await postJson('/local-test-connection/rpc', { method: 'session/prompt', params: {} })).status, 404);
    assert.deepEqual(await json('/local-test-connection/events'), { notifications: [], disconnected: false });
  });

  test('the chat creates and selects its own sessions; reset forgets them; a prompt is still not served', async () => {
    const create = (body) => postJson(`/projects/${PROJECT_ID}/chat/sessions`, { connection_id: 'local-test-connection', ...body });
    const first = await (await create({ mode: 'ensure', operation_id: 'op-1' })).json();
    assert.equal(first.operation_session_id, 'fake-session-1');
    assert.equal(first.selected_session_id, 'fake-session-1');
    assert.deepEqual(first.sessions, [{ id: 'fake-session-1', title: 'Main' }]);
    assert.equal(first.revision, 1);
    assert.equal('main_session_id' in first, false);
    // Ensure and a replayed operation return the same session instead of adding another.
    assert.equal((await (await create({ mode: 'ensure', operation_id: 'op-2' })).json()).operation_session_id, 'fake-session-1');
    assert.equal((await (await create({ mode: 'new', operation_id: 'op-1' })).json()).operation_session_id, 'fake-session-1');
    const second = await (await create({ mode: 'new', operation_id: 'op-3' })).json();
    assert.equal(second.operation_session_id, 'fake-session-2');
    assert.equal(second.sessions.length, 2);

    const select = (body) => call(`/projects/${PROJECT_ID}/chat`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await select({ expected_revision: 0, selected_session_id: 'fake-session-1' })).status, 409);
    assert.equal((await select({ expected_revision: second.revision, selected_session_id: 'nope' })).status, 409);
    const selected = await (await select({ expected_revision: second.revision, selected_session_id: 'fake-session-1' })).json();
    assert.equal(selected.selected_session_id, 'fake-session-1');

    assert.equal((await postJson(`/projects/other-project/chat/sessions`, { connection_id: 'local-test-connection', mode: 'ensure' })).status, 404);
    assert.equal((await postJson(`/projects/${PROJECT_ID}/chat/sessions`, { connection_id: 'elsewhere', mode: 'ensure' })).status, 404);
    // Attaching the created session and closing the creator's connection are canned; a prompt is not.
    assert.deepEqual(await (await postJson('/local-test-connection/rpc', { method: 'session/load', params: { sessionId: 'fake-session-1' } })).json(), { result: {} });
    assert.deepEqual(await json('/local-test-connection/models?sessionId=fake-session-1'), { models: null });
    assert.deepEqual(await (await call('/local-test-connection', { method: 'DELETE' })).json(), { connection_id: 'local-test-connection', closed: true });
    assert.equal((await postJson('/local-test-connection/rpc', { method: 'session/prompt', params: {} })).status, 404);

    await reset();
    const cleared = await json(`/projects/${PROJECT_ID}/chat`);
    assert.deepEqual([cleared.revision, cleared.selected_session_id, cleared.sessions], [0, null, []]);
  });

  test('the default catalogs have one ready Astrid and no providers; setting a model is not served', async () => {
    const catalog = await json('/agents');
    assert.equal(catalog.defaultAgent, 'astrid');
    assert.equal(catalog.agents.length, 4);
    assert.equal(catalog.agents[0].state, 'ready');
    assert.deepEqual(await json('/models'), { providers: [], currentModel: null });
    assert.equal((await postJson('/model', { model: 'any' })).status, 404);
  });
});

describe('launcher: ports, token file and env', () => {
  test('launching twice gives two ports, two tokens and two token files', async () => {
    const other = await startFakeRuntime();
    try {
      assert.notEqual(other.port, fake.port);
      assert.notEqual(other.token, fake.token);
      assert.notEqual(other.tokenFile, fake.tokenFile);
      assert.equal((await fetch(`${other.origin}/v1/health`, { headers: { Authorization: `Bearer ${other.token}` } })).status, 200);
      assert.equal((await fetch(`${other.origin}/v1/health`, { headers: { Authorization: `Bearer ${fake.token}` } })).status, 401);
    } finally {
      await other.close();
    }
    assert.equal(existsSync(other.tokenFile), false, 'close() removes the token file');
  });

  test('the token file is mode 0600 in a 0700 directory under the OS temp dir, never in the repo', () => {
    assert.equal(statSync(fake.tokenFile).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(fake.tokenFile)).mode & 0o777, 0o700);
    assert.ok(fake.tokenFile.startsWith(tmpdir()));
    assert.ok(relative(REPO, fake.tokenFile).startsWith('..'), 'outside the repository');
    assert.equal(readFileSync(fake.tokenFile, 'utf8').trim(), fake.token);
  });

  test('the env carries every key the Vite proxies and the app need, pointing at the fake', () => {
    const expected = {
      VITE_WORKSPACE_RUNTIME_URL: `http://127.0.0.1:${fake.port}`,
      WORKSPACE_RUNTIME_TOKEN_FILE: fake.tokenFile,
      VITE_WORKSPACE_RUNTIME_EXPECTED_ACTOR_ID: FAKE_RUNTIME_ACTOR_ID,
      VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID: FAKE_RUNTIME_REALM_ID,
      VITE_WORKSPACE_RUNTIME_EXPECTED_INSTANCE_ID: FAKE_RUNTIME_INSTANCE_ID,
      VITE_ASTRID_BRIDGE_PORT: String(fake.port),
      ASTRID_BRIDGE_TOKEN: fake.token,
      VITE_ASTRID_ACP_BRIDGE_PORT: String(fake.port),
      ASTRID_ACP_BRIDGE_TOKEN: fake.token,
      VITE_RUNTIME_ORIGIN: '',
      FAKE_RUNTIME_PORT: String(fake.port),
      FAKE_RUNTIME_TOKEN_FILE: fake.tokenFile,
    };
    assert.deepEqual(fake.env, expected);
  });

  test('fakeRuntimeEnv is idempotent across Playwright config reloads: one token file, never rewritten', () => {
    const saved = { file: process.env.FAKE_RUNTIME_TOKEN_FILE, port: process.env.FAKE_RUNTIME_PORT };
    delete process.env.FAKE_RUNTIME_TOKEN_FILE;
    delete process.env.FAKE_RUNTIME_PORT;
    try {
      assert.throws(() => fakeRuntimeEnv(), /needs a port/);
      const first = fakeRuntimeEnv({ port: 41234 });
      assert.equal(process.env.FAKE_RUNTIME_TOKEN_FILE, first.FAKE_RUNTIME_TOKEN_FILE);
      assert.equal(process.env.FAKE_RUNTIME_PORT, '41234');
      const written = readFileSync(first.FAKE_RUNTIME_TOKEN_FILE, 'utf8');
      const mtime = statSync(first.FAKE_RUNTIME_TOKEN_FILE).mtimeMs;
      // A worker reload: same process environment, config evaluated again.
      const reloaded = fakeRuntimeEnv();
      assert.deepEqual(reloaded, first);
      assert.equal(readFileSync(first.FAKE_RUNTIME_TOKEN_FILE, 'utf8'), written);
      assert.equal(statSync(first.FAKE_RUNTIME_TOKEN_FILE).mtimeMs, mtime);
      assert.equal(first.ASTRID_BRIDGE_TOKEN, written.trim());
      assert.equal(statSync(first.FAKE_RUNTIME_TOKEN_FILE).mode & 0o777, 0o600);
    } finally {
      for (const [key, value] of [['FAKE_RUNTIME_TOKEN_FILE', saved.file], ['FAKE_RUNTIME_PORT', saved.port]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('the server is not reachable on the IPv6 loopback or a non-loopback interface (127.0.0.1 only)', async () => {
    const reached = await fetch(`http://[::1]:${fake.port}/runtime-config/v1/workspace.json`).then(() => true, () => false);
    assert.equal(reached, false);
    assert.match(readFileSync(resolve(REPO, 'tests/e2e/fake-runtime/server.ts'), 'utf8'), /server\.listen\([^)]*'127\.0\.0\.1'/);
  });
});

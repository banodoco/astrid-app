import { describe, expect, it } from 'vitest';

import {
  PROJECT_ID,
  runtimeFixture,
  sha256Digest,
  TIMELINE_ID,
} from '@/test/fakeWorkspaceRuntime.ts';
import type { FakeObjectStore } from '@/test/fakeObjectStore.ts';

const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any>;
const TIMELINE = `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`;

describe('runtimeFixture content-addressed mode (a shared object store is passed)', () => {
  it('mints sha256-of-bytes ids for ingest, serves them with their own ETag, and shares them across instances', async () => {
    const objects: FakeObjectStore = new Map();
    const first = runtimeFixture({ objects });
    const second = runtimeFixture({ objects, projectId: 'other', timelineId: 'other-timeline' });
    const bytes = new TextEncoder().encode('sample bytes');
    const digest = await sha256Digest(bytes);

    const ingested = await first.transport('POST', `/v1/projects/${PROJECT_ID}/objects`, { 'Content-Type': 'text/plain', 'Idempotency-Key': 'k' }, bytes);
    expect(decode(ingested.body).data.object_id).toBe(digest);

    const got = await second.transport('GET', `/v1/objects/${encodeURIComponent(digest)}`, {});
    expect(got.status).toBe(200);
    expect(got.headers.ETag).toBe(`"${digest}"`);
    expect(got.headers['Content-Type']).toBe('text/plain');
    expect(got.headers['Content-Length']).toBe(String(bytes.byteLength));
    expect(await sha256Digest(got.body)).toBe(digest);
  });

  it('imports media under the digest of the bytes, not the constant managed id', async () => {
    const objects: FakeObjectStore = new Map();
    const fixture = runtimeFixture({ objects });
    const bytes = new TextEncoder().encode('imported clip');
    const digest = await sha256Digest(bytes);

    const response = await fixture.transport('POST', `/v1/projects/${PROJECT_ID}/media-imports`, { 'Content-Type': 'video/mp4', 'Idempotency-Key': 'import-1' }, bytes);

    expect(decode(response.body).data.asset_id).toBe(digest);
    expect(response.headers.ETag).toBe(`"${digest}"`);
    expect(objects.has(digest)).toBe(true);
  });
});

describe('runtimeFixture object ranges', () => {
  async function fixtureWithObject() {
    const objects: FakeObjectStore = new Map();
    const fixture = runtimeFixture({ objects });
    const bytes = Uint8Array.from({ length: 100 }, (_, index) => index);
    const ingested = await fixture.transport('POST', `/v1/projects/${PROJECT_ID}/objects`, { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': 'k' }, bytes);
    return { fixture, bytes, path: `/v1/objects/${encodeURIComponent(decode(ingested.body).data.object_id)}` };
  }

  it('serves open, closed and suffix ranges', async () => {
    const { fixture, path } = await fixtureWithObject();
    const closed = await fixture.transport('GET', path, { Range: 'bytes=10-19' });
    expect([closed.status, closed.headers['Content-Range'], closed.body.byteLength]).toEqual([206, 'bytes 10-19/100', 10]);
    const suffix = await fixture.transport('GET', path, { Range: 'bytes=-5' });
    expect([suffix.status, suffix.headers['Content-Range'], Array.from(suffix.body)]).toEqual([206, 'bytes 95-99/100', [95, 96, 97, 98, 99]]);
    const open = await fixture.transport('GET', path, { Range: 'bytes=90-' });
    expect([open.status, open.body.byteLength]).toEqual([206, 10]);
  });

  it('answers an unsatisfiable range 416 with the size, and HEAD sends the full length and no body', async () => {
    const { fixture, path } = await fixtureWithObject();
    const unsatisfiable = await fixture.transport('GET', path, { Range: 'bytes=500-' });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers['Content-Range']).toBe('bytes */100');
    const head = await fixture.transport('HEAD', path, {});
    expect([head.status, head.headers['Content-Length'], head.body.byteLength]).toEqual([200, '100', 0]);
  });
});

describe('runtimeFixture revision history', () => {
  it('lists the revisions it holds, newest first, with the head flagged and a later seeded head on top', async () => {
    const fixture = runtimeFixture({ priorRevisions: [], headRevisionId: 'seed-r1' });
    const initial = decode((await fixture.transport('GET', `${TIMELINE}/composition-revisions?limit=50`, {})).body);
    expect(initial.items.map((item: any) => [item.revision_id, item.is_current_head])).toEqual([['seed-r1', true]]);

    fixture.setHead('next', { config: fixture.read().config, registry: fixture.read().registry, clips: [], occurrences: [] });
    const after = decode((await fixture.transport('GET', `${TIMELINE}/composition-revisions?limit=1`, {})).body);
    expect(after.items.map((item: any) => [item.revision_id, item.is_current_head])).toEqual([['next', true]]);
    expect(after.next_cursor).toBe('1');
    const created = decode((await fixture.transport('GET', `${TIMELINE}/composition-revisions?limit=50`, {})).body).items
      .map((item: any) => item.created_at);
    expect(created[0] > created[1]).toBe(true);
  });

  it('restores any revision it holds, and 404s one it does not', async () => {
    const fixture = runtimeFixture({ priorRevisions: [], headRevisionId: 'seed-r1' });
    fixture.setHead('next', { config: fixture.read().config, registry: fixture.read().registry, clips: [], occurrences: [] });
    const restore = (revision: string, expectedHead: string) => fixture.transport(
      'POST', `${TIMELINE}/composition-revisions/${revision}/restore`, { 'Idempotency-Key': `restore-${revision}` },
      new TextEncoder().encode(JSON.stringify({ expected_head: expectedHead })),
    );

    const restored = decode((await restore('seed-r1', 'next')).body);
    expect(restored.data.new_head).toBe('restore-seed-r1');
    expect(fixture.read().headRevisionId).toBe('restore-seed-r1');
    expect((await restore('never-existed', 'restore-seed-r1')).status).toBe(404);
    expect((await restore('seed-r1', 'next')).status).toBe(409);
  });
});

describe('runtimeFixture retired timeline routes', () => {
  it.each([
    ['POST', `${TIMELINE}/composition-revisions`],
    ['POST', `${TIMELINE}/replace-parent-media`],
    ['POST', `/v1/projects/${PROJECT_ID}/timeline-documents`],
    ['GET', `/v1/projects/${PROJECT_ID}/documents/timeline%3A${TIMELINE_ID}`],
    ['PATCH', `/v1/projects/${PROJECT_ID}/documents/timeline%3A${TIMELINE_ID}`],
    ['PATCH', `/v1/timelines/${TIMELINE_ID}`],
    ['POST', `/v1/timelines/${TIMELINE_ID}/replace-clip`],
    ['POST', `/v1/timelines/${TIMELINE_ID}/shots`],
    ['POST', `/v1/timelines/${TIMELINE_ID}/references`],
    ['PATCH', '/v1/shots/shot'],
    ['POST', '/v1/shots/shot/archive'],
    ['POST', '/v1/shots/shot/recover'],
    ['PATCH', '/v1/references/reference'],
    ['POST', '/v1/references/reference/archive'],
    ['POST', '/v1/references/reference/recover'],
    ['POST', '/v1/attempts/attempt/publish-timeline-render'],
  ])('%s %s refuses without changing the timeline', async (method, path) => {
    const fixture = runtimeFixture();
    const original = structuredClone(fixture.read());
    const response = await fixture.transport(method, path, { 'Idempotency-Key': 'retired' },
      new TextEncoder().encode(JSON.stringify({ expected_head: 'stale' })));
    expect(response.status).toBe(410);
    expect(decode(response.body).code).toBe('retired_route');
    expect(fixture.read()).toEqual(original);
  });

  it('refuses composition writes before decoding malformed JSON', async () => {
    const fixture = runtimeFixture();
    const response = await fixture.transport('POST', `${TIMELINE}/composition-revisions`, {}, new TextEncoder().encode('invalid JSON'));
    expect(response.status).toBe(410);
    expect(decode(response.body)).toMatchObject({ code: 'retired_route', details: { reason: 'timeline_commit_required' } });
  });

  it('keeps timeline catalog rename supported', async () => {
    const fixture = runtimeFixture();
    const response = await fixture.transport('PATCH', TIMELINE, { 'Idempotency-Key': 'rename' },
      new TextEncoder().encode(JSON.stringify({ name: 'New name' })));
    expect(response.status).toBe(200);
    expect(decode(response.body).data.name).toBe('New name');
    expect(fixture.read().headRevisionId).toBe('parent-r1');
  });

  it('refuses historical film recovery through the catalog route', async () => {
    const fixture = runtimeFixture();
    const response = await fixture.transport('POST', `/v1/timelines/${TIMELINE_ID}/recover`, {},
      new TextEncoder().encode(JSON.stringify({ expected_version: 1, version: 2 })));
    expect(response.status).toBe(410);
    expect(decode(response.body)).toMatchObject({ code: 'retired_route', details: { reason: 'timeline_restore_required' } });
    expect(fixture.read().headRevisionId).toBe('parent-r1');
  });

  it.each([{ timeline_id: TIMELINE_ID }, { document_id: `timeline:${TIMELINE_ID}` }, { kind: 'timeline.composition' }])(
    'refuses timeline payloads through generic document creation: %j', async (body) => {
      const fixture = runtimeFixture();
      const response = await fixture.transport('POST', `/v1/projects/${PROJECT_ID}/documents`, {},
        new TextEncoder().encode(JSON.stringify(body)));
      expect(response.status).toBe(410);
      expect(decode(response.body)).toMatchObject({ code: 'retired_route', details: { reason: 'timeline_commit_required' } });
    });
});

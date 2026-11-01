import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Page } from '@playwright/test';
import type { ManagedOutput } from '../../../../src/integrations/runtime/generated';
import { assertDownloadTransfer, observeDownloadTransfer, type DownloadTransfer } from './download';
import { mediaHash } from './media';

const pageOrigin = 'http://127.0.0.1:17340';
const runtimeBase = 'http://127.0.0.1:17341/api/runtime';
const projectId = 'same project';
const bytes = Buffer.from('synthetic transfer proof, not an MP4');
const video = { object_id: mediaHash(bytes), digest: mediaHash(bytes), size: bytes.length } as ManagedOutput;
const blobUrl = `blob:${pageOrigin}/unit-download`;
function transfer(): DownloadTransfer {
  const read = { method: 'GET', resourceType: 'fetch', status: 200, origin: pageOrigin, redirected: false };
  return { runtimeBase, pageOrigin,
    location: { ...read, url: `${runtimeBase}/v1/projects/${encodeURIComponent(projectId)}/objects/${encodeURIComponent(video.object_id)}/location`,
      objectId: video.object_id, digest: video.digest, size: video.size },
    object: { ...read, url: `${runtimeBase}/v1/objects/${encodeURIComponent(video.object_id)}`, bytes: Buffer.from(bytes) } };
}
const validate = (proof: DownloadTransfer, saved = bytes, url = blobUrl) =>
  assertDownloadTransfer(proof, runtimeBase, projectId, video, saved, url, pageOrigin);

test('binds the actual Runtime alias, same-project location and full bytes to the native same-page blob', () => {
  validate(transfer());
  assert.throws(() => validate(transfer(), Buffer.from('wrong saved bytes')));
  for (const url of [transfer().object.url, `blob:${runtimeBase}/other`, `blob:${pageOrigin}/`,
    `${blobUrl}?redirect=1`, `${blobUrl}#other`]) assert.throws(() => validate(transfer(), bytes, url));
});

for (const target of ['location', 'object'] as const) {
  for (const [field, value] of Object.entries({ method: 'HEAD', resourceType: 'media', status: 206,
    range: 'bytes=0-', origin: 'http://localhost:17340', redirected: true })) {
    test(`refuses ${target} ${field} mismatch`, () => {
      const proof = transfer();
      Object.assign(proof[target], { [field]: value });
      assert.throws(() => validate(proof));
    });
  }
  for (const status of [403, 401, 500]) {
    test(`refuses ${target} HTTP ${status}`, () => {
      const proof = transfer(); proof[target].status = status;
      assert.throws(() => validate(proof));
    });
  }
  for (const field of ['origin', 'method', 'status', 'resourceType', 'redirected'] as const) {
    test(`requires concrete ${target} ${field}`, () => {
      const proof = transfer(); delete (proof[target] as Partial<typeof proof[typeof target]>)[field];
      assert.throws(() => validate(proof));
    });
  }
  for (const suffix of ['?other=1', '/other']) {
    test(`refuses ${target} URL suffix ${suffix}`, () => {
      const proof = transfer(); proof[target].url += suffix;
      assert.throws(() => validate(proof));
    });
  }
}
for (const [name, mutate] of Object.entries({
  'other project': (p: DownloadTransfer) => { p.location.url = p.location.url.replace('same%20project', 'other'); },
  'other alias': (p: DownloadTransfer) => { p.object.url = p.object.url.replace('/api/runtime/', '/api/astrid/'); },
  'other object': (p: DownloadTransfer) => { p.location.objectId = 'other'; },
  'wrong digest': (p: DownloadTransfer) => { p.location.digest = 'other'; },
  'wrong size': (p: DownloadTransfer) => { p.location.size++; },
  'truncation': (p: DownloadTransfer) => { p.object.bytes = p.object.bytes.subarray(1); },
  'corruption': (p: DownloadTransfer) => { p.object.bytes[0] ^= 255; },
  'other Runtime': (p: DownloadTransfer) => { p.runtimeBase += '/other'; },
  'other page': (p: DownloadTransfer) => { p.pageOrigin += '/other'; },
})) {
  test(`refuses ${name}`, () => { const proof = transfer(); mutate(proof); assert.throws(() => validate(proof)); });
}

function mockPage() {
  return Object.assign(new EventEmitter(), { url: () => `${pageOrigin}/tools/video-editor` });
}
function emit(page: EventEmitter, proof: DownloadTransfer, type: 'location' | 'object', options: {
  resourceType?: string; body?: () => Promise<Buffer>; allHeaders?: () => Promise<Record<string, string | undefined>>;
} = {}) {
  const read = proof[type];
  page.emit('response', { url: () => read.url, status: () => read.status,
    request: () => ({ method: () => read.method, resourceType: () => options.resourceType ?? read.resourceType,
      headers: () => { assert.fail('provisional request headers must not be used'); },
      allHeaders: options.allHeaders ?? (async () => ({ origin: read.origin, range: read.range,
        authorization: 'must never be retained' })),
      redirectedFrom: () => read.redirected ? {} : null }),
    body: options.body ?? (async () => type === 'object' ? proof.object.bytes
      : Buffer.from(JSON.stringify({ object_id: proof.location.objectId, digest: proof.location.digest,
        size: proof.location.size, local_path: 'must never be retained' }))) });
}

test('collector observes responses without intercepting and retains no private location or credentials', async () => {
  const page = mockPage(); const proof = transfer();
  const observer = observeDownloadTransfer(page as unknown as Page, runtimeBase, projectId, video);
  try {
    emit(page, proof, 'location');
    emit(page, proof, 'object', { resourceType: 'media', body: async () => { assert.fail('media belongs to strict diagnostics'); } });
    emit(page, proof, 'object');
    const observed = await observer.finish();
    validate(observed);
    assert.doesNotMatch(JSON.stringify(observed), /must never|authorization|local_path/);
  } finally { observer.stop(); }
  assert.deepEqual(page.eventNames(), []);
});
test('collector awaits complete headers and bodies while preserving response arrival order', async () => {
  const page = mockPage(); const proof = transfer();
  const observer = observeDownloadTransfer(page as unknown as Page, runtimeBase, projectId, video);
  let resolveHeaders!: (headers: Record<string, string>) => void;
  let resolveBody!: (bytes: Buffer) => void;
  const headers = new Promise<Record<string, string>>(resolve => { resolveHeaders = resolve; });
  const body = new Promise<Buffer>(resolve => { resolveBody = resolve; });
  try {
    emit(page, proof, 'location', { allHeaders: () => headers });
    emit(page, proof, 'object', { body: () => body });
    let finished = false;
    const finishing = observer.finish().then(result => { finished = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    resolveBody(bytes);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    resolveHeaders({ origin: pageOrigin, authorization: 'must never be retained' });
    const observed = await finishing;
    validate(observed);
    assert.doesNotMatch(JSON.stringify(observed), /must never|authorization|local_path/);
  } finally { observer.stop(); }
});
for (const target of ['location', 'object'] as const) {
  test(`collector propagates failed ${target} complete headers without an unhandled rejection`, async () => {
    const page = mockPage(); const proof = transfer();
    const observer = observeDownloadTransfer(page as unknown as Page, runtimeBase, projectId, video);
    const failure = new Error('complete headers failed');
    try {
      for (const type of ['location', 'object'] as const) emit(page, proof, type, type === target
        ? { allHeaders: async () => { throw failure; } } : {});
      await new Promise(resolve => setImmediate(resolve));
      await assert.rejects(observer.finish(), error => error === failure);
    } finally { observer.stop(); }
  });
  for (const origin of [undefined, 'https://wrong.test']) {
    test(`collector refuses ${target} complete Origin ${origin ?? 'missing'}`, async () => {
      const page = mockPage(); const proof = transfer();
      const observer = observeDownloadTransfer(page as unknown as Page, runtimeBase, projectId, video);
      try {
        for (const type of ['location', 'object'] as const) emit(page, proof, type, type === target
          ? { allHeaders: async () => ({ origin }) } : {});
        const observed = await observer.finish();
        assert.equal(observed[target].origin, origin);
        assert.throws(() => validate(observed));
      } finally { observer.stop(); }
    });
  }
  test(`collector retains and refuses ${target} complete Range`, async () => {
    const page = mockPage(); const proof = transfer();
    const observer = observeDownloadTransfer(page as unknown as Page, runtimeBase, projectId, video);
    try {
      for (const type of ['location', 'object'] as const) emit(page, proof, type, type === target
        ? { allHeaders: async () => ({ origin: pageOrigin, range: 'bytes=0-' }) } : {});
      const observed = await observer.finish();
      assert.equal(observed[target].range, 'bytes=0-');
      assert.throws(() => validate(observed));
    } finally { observer.stop(); }
  });
}
for (const kind of ['missing location', 'missing object', 'repeated location', 'repeated object', 'reversed order', 'failed body'] as const) {
  test(`collector refuses ${kind}`, async () => {
    const page = mockPage(); const proof = transfer();
    const observer = observeDownloadTransfer(page as unknown as Page, runtimeBase, projectId, video);
    try {
      if (kind === 'reversed order') emit(page, proof, 'object');
      if (kind !== 'missing location') emit(page, proof, 'location', kind === 'failed body'
        ? { body: async () => { throw new Error('body failed'); } } : {});
      if (kind !== 'missing object') emit(page, proof, 'object');
      if (kind === 'repeated location') emit(page, proof, 'location');
      if (kind === 'repeated object') emit(page, proof, 'object');
      await assert.rejects(observer.finish());
    } finally { observer.stop(); }
  });
}

test('main button observes a complete managed-object fetch without a location preflight', async () => {
  const page = mockPage(); const proof = transfer();
  const observer = observeDownloadTransfer(page as unknown as Page, runtimeBase, projectId, video, 'direct');
  try {
    emit(page, proof, 'object', { resourceType: 'media', body: async () => { assert.fail('preview media is not the download'); } });
    emit(page, proof, 'object');
    const observed = await observer.finish();
    assertDownloadTransfer(observed, runtimeBase, projectId, video, bytes, blobUrl, pageOrigin);
    assert.equal(Object.hasOwn(observed, 'location'), false);
    assert.doesNotMatch(JSON.stringify(observed), /must never|authorization|local_path/);
    for (const bad of [
      { ...observed, object: { ...observed.object, bytes: bytes.subarray(1) } },
      { ...observed, object: { ...observed.object, status: 206 } },
      { ...observed, object: { ...observed.object, origin: undefined } },
      { ...observed, object: { ...observed.object, range: 'bytes=0-' } },
    ]) assert.throws(() => assertDownloadTransfer(bad, runtimeBase, projectId, video, bytes, blobUrl, pageOrigin));
  } finally { observer.stop(); }
  assert.deepEqual(page.eventNames(), []);
});

for (const kind of ['missing', 'repeated', 'failed headers', 'failed body'] as const) {
  test(`main download collector refuses ${kind} object fetch`, async () => {
    const page = mockPage(); const proof = transfer();
    const observer = observeDownloadTransfer(page as unknown as Page, runtimeBase, projectId, video, 'direct');
    try {
      if (kind !== 'missing') emit(page, proof, 'object', kind === 'failed headers'
        ? { allHeaders: async () => { throw new Error('headers failed'); } }
        : kind === 'failed body' ? { body: async () => { throw new Error('body failed'); } } : {});
      if (kind === 'repeated') emit(page, proof, 'object');
      await new Promise(resolve => setImmediate(resolve));
      await assert.rejects(observer.finish());
    } finally { observer.stop(); }
  });
}

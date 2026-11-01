import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { ManagedOutput, Task } from '../../../../src/integrations/runtime/generated';
import type { DownloadTransfer } from './download';
import { mediaHash } from './media';
import { compareRgbFrames } from './compare';
import { PARITY_FRAMES } from './fixture';
import type { Page } from '@playwright/test';
import { ACP_RESOURCE_ERROR, classifyPageDiagnostics, collectPageDiagnostics, type PageDiagnostic, type ResultPreviewProof } from './diagnostics';

const origin = 'http://127.0.0.1:17340';
const project = 'current-project';
const url = `${origin}/api/astrid/acp/projects/${project}/chat`;
const response = (overrides = {}): Extract<PageDiagnostic, { kind: 'response' }> => ({ kind: 'response',
  url, method: 'GET', status: 503, body: '{ "error": "acp_unavailable" }', ...overrides });
const consoleError = (overrides = {}): Extract<PageDiagnostic, { kind: 'console' }> => ({ kind: 'console',
  message: ACP_RESOURCE_ERROR, location: { url, lineNumber: 0, columnNumber: 0 }, ...overrides });
const classify = (raw: PageDiagnostic[]) => classifyPageDiagnostics(raw, origin, project);

for (const path of ['/api/astrid/acp/models', '/api/astrid/acp/agents', `/api/astrid/acp/projects/${project}/chat`]) {
  test(`classifies only correlated optional ACP unavailability: ${path}`, () => {
    const target = `${origin}${path}`;
    const raw = [consoleError({ location: { url: target, lineNumber: 0, columnNumber: 0 } }), response({ url: target })];
    assert.deepEqual(classify(raw), { raw, optionalAcp: raw, qualifiedResultPreviews: [], failures: [] });
  });
}

for (const [name, overrides] of Object.entries({
  'wrong body': { body: '{"error":"unauthorized"}' },
  'extra body field': { body: '{"error":"acp_unavailable","detail":"failure"}' },
  'array body': { body: '[{"error":"acp_unavailable"}]' },
  'invalid JSON': { body: 'acp_unavailable' },
  'unreadable body': { body: undefined, bodyError: 'closed' },
  'wrong status': { status: 500 },
  'auth status': { status: 403 },
  'wrong method': { method: 'POST' },
  'HEAD method': { method: 'HEAD' },
})) {
  test(`retains ${name} and its console error as failures`, () => {
    const raw = [response(overrides), consoleError()];
    assert.deepEqual(classify(raw), { raw, optionalAcp: [], qualifiedResultPreviews: [], failures: raw });
  });
}

for (const [name, target] of Object.entries({
  'wrong origin': url.replace('127.0.0.1', 'localhost'),
  'wrong port': url.replace('17340', '17341'),
  'wrong project': url.replace(project, 'other-project'),
  'query string': `${url}?project=${project}`,
  'catalog': `${origin}/api/astrid/v1/capabilities`,
  'media': `${origin}/api/astrid/v1/objects/media.mp4`,
  'admission': `${origin}/api/astrid/v1/tasks`,
  'auth': `${origin}/api/astrid/auth`,
  'unrelated ACP': `${origin}/api/astrid/acp/status`,
})) {
  test(`retains matching ${name} response and console error as failures`, () => {
    const raw = [response({ url: target }), consoleError({ location: { url: target, lineNumber: 0, columnNumber: 0 } })];
    assert.deepEqual(classify(raw), { raw, optionalAcp: [], qualifiedResultPreviews: [], failures: raw });
  });
}

test('requires an exact resource-load message and matching resource location', () => {
  for (const error of [consoleError({ message: `app: ${ACP_RESOURCE_ERROR}` }),
    consoleError({ location: { url: `${origin}/page.js`, lineNumber: 0, columnNumber: 0 } }),
    consoleError({ location: { url, lineNumber: 1, columnNumber: 0 } })]) {
    const raw = [response(), error];
    assert.deepEqual(classify(raw).failures, raw);
  }
  assert.deepEqual(classify([consoleError()]).failures, [consoleError()]);
  assert.deepEqual(classify([response()]).failures, [response()]);
});

test('retains all page, media, transport and other console errors beside optional chat diagnostics', () => {
  const optional = [response(), consoleError()];
  const failures: PageDiagnostic[] = [
    { kind: 'pageerror', message: ACP_RESOURCE_ERROR },
    { kind: 'requestfailed', url: `${origin}/video.mp4`, method: 'GET', message: 'net::ERR_FAILED' },
    consoleError({ message: 'media decode failed' }),
    response({ url: `${origin}/video.mp4` }),
  ];
  const raw = [...optional, ...failures];
  assert.deepEqual(classify(raw), { raw, optionalAcp: optional, qualifiedResultPreviews: [], failures });
});

test('does not let one valid response hide repeated or ambiguous errors on the same URL', () => {
  const raw = [response(), consoleError(), consoleError()];
  assert.deepEqual(classify(raw).failures, [raw[2]]);
  for (const extra of [response({ status: 500 }), response({ method: 'POST' }),
    { kind: 'requestfailed', url, method: 'GET', message: 'net::ERR_FAILED' } as const]) {
    const ambiguous = [response(), consoleError(), extra];
    assert.deepEqual(classify(ambiguous).failures, ambiguous);
  }
});

test('collector retains raw errors, waits for the response body and removes listeners', async () => {
  const page = Object.assign(new EventEmitter(), { url: () => origin });
  const logs = collectPageDiagnostics(page as unknown as Page, origin, project);
  let resolveBody!: (body: string) => void;
  page.emit('response', { url: () => url, status: () => 503, headers: () => ({}), request: () => ({ method: () => 'GET' }),
    text: () => new Promise<string>(resolve => { resolveBody = resolve; }) });
  page.emit('console', { type: () => 'error', text: () => ACP_RESOURCE_ERROR,
    location: () => ({ url, lineNumber: 0, columnNumber: 0 }) });
  page.emit('pageerror', new Error('page crashed'));
  page.emit('requestfailed', { url: () => `${origin}/media.mp4`, method: () => 'GET',
    failure: () => ({ errorText: 'decode request failed' }), resourceType: () => 'media', headers: () => ({}), redirectedFrom: () => null });
  const result = logs.result();
  resolveBody('{"error":"acp_unavailable"}');
  const diagnostics = await result;
  assert.equal(diagnostics.raw.length, 4);
  assert.equal(diagnostics.optionalAcp.length, 2);
  assert.deepEqual(diagnostics.failures.map(item => item.kind), ['pageerror', 'requestfailed']);
  logs.stop();
  assert.deepEqual(page.eventNames(), []);
});

test('collector fails closed when an optional response body cannot be read', async () => {
  const page = Object.assign(new EventEmitter(), { url: () => origin });
  const logs = collectPageDiagnostics(page as unknown as Page, origin, project);
  try {
    page.emit('response', { url: () => url, status: () => 503, headers: () => ({}), request: () => ({ method: () => 'GET' }),
      text: async () => { throw new Error('closed'); } });
    page.emit('console', { type: () => 'error', text: () => ACP_RESOURCE_ERROR,
      location: () => ({ url, lineNumber: 0, columnNumber: 0 }) });
    const diagnostics = await logs.result();
    assert.equal(diagnostics.failures.length, 2);
    assert.match(JSON.stringify(diagnostics.raw), /closed/);
  } finally { logs.stop(); }
});

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const fixture: ResultPreviewProof['fixture'] = {
  projectId: 'project', timelineId: 'timeline', headRevisionId: 'parent', shotId: 'shot', occurrenceId: 'occurrence',
  shotRevisionId: 'shot-revision', internalRevisionId: 'internal-revision',
  parent: { revision_id: 'parent', content_digest: 'parent-digest', payload: {} },
  shot: { revision_id: 'shot-revision', content_digest: 'shot-digest', payload: {} },
  internal: { revision_id: 'internal-revision', content_digest: 'internal-digest', payload: {} },
  media: [{ objectId: digest('a'), digest: digest('a') }], sourceVideoMediaId: digest('a'),
  sourceVideoMetadata: { streams: [], frames: [], format: { duration: '1.5' } },
};

function admittedTask() {
  const task = {
    task_id: 'task', run_id: 'run', project_id: 'project', state: 'queued', version: 1, capability_id: 'rendering.render',
    capability_digest: digest('c'), idempotency_key: 'render-operation', created_at: '', updated_at: '', runtime_epoch: 1,
    input_object_ids: [digest('a'), digest('b')],
    spec: { spec: { inputs: { selector: 'rendering.remotion', timeline_authority: {
      authority: 'kernel', project_id: 'project', timeline_id: 'timeline', parent_revision_id: 'parent',
      parent_content_digest: 'parent-digest', snapshot_digest: digest('b'), input_object_ids: [digest('a')],
      managed_media_admissions: { [digest('a')]: digest('a') },
      dependency_digests: [
        { dependency_kind: 'shot_revision', dependency_id: 'shot-revision', content_digest: 'shot-digest' },
        { dependency_kind: 'internal_timeline_revision', dependency_id: 'internal-revision', content_digest: 'internal-digest' },
        { dependency_kind: 'media', dependency_id: digest('a'), content_digest: digest('a') },
      ],
    } }, timeline_snapshot_ref: { digest: digest('b'), project_id: 'project', timeline_id: 'timeline',
      revision_id: 'parent', revision_digest: 'parent-digest', source_kind: 'revision' } } },
  } satisfies Task;
  return task;
}


// Synthetic classifier inputs only: these tests do not perform or certify a UI download/ffprobe/decode.
function completeProof(): ResultPreviewProof & { downloadTransfer: DownloadTransfer } {
  const initial = admittedTask();
  initial.project_id = project;
  initial.spec.spec.inputs.timeline_authority.project_id = project;
  initial.spec.spec.timeline_snapshot_ref.project_id = project;
  const completed = { ...initial, state: 'succeeded' as const, attempt_id: 'attempt' };
  const downloadBytes = Buffer.from('unit classifier bytes, not a real MP4');
  const provenanceBytes = Buffer.from(JSON.stringify({
    canonical_timeline: initial.spec.spec.inputs.timeline_authority, engine: 'rendering.remotion',
    backend_fragments: { 'rendering.remotion': { renderer: 'remotion', composition_id: 'TimelineComposition', project_dir: '/render' } },
  }));
  const output = (bytes: Uint8Array, overrides: Partial<ManagedOutput>): ManagedOutput => ({
    association_id: 'association', task_id: initial.task_id, run_id: initial.run_id, project_id: project,
    attempt_id: 'attempt', object_id: mediaHash(bytes), digest: mediaHash(bytes), size: bytes.length,
    output_port: 'video', role: 'result', state: 'available', media_type: 'video/mp4', filename: 'result.mp4',
    group_key: '', variant_key: '', selector: { group_key: '', variant_key: '' }, manifest_ref: null,
    ordinal: 0, producer: {}, provenance: {}, durability: 'durable', version: 1, lifecycle: {}, ...overrides,
  });
  const video = output(downloadBytes, {});
  const target = `${origin}/api/astrid/v1/objects/${encodeURIComponent(video.object_id)}`;
  return { initial, completed, fixture: { ...fixture, projectId: project }, capabilityDigest: digest('c'),
    video, provenanceOutput: output(provenanceBytes, { role: 'auxiliary', output_port: 'provenance', media_type: 'application/json' }),
    downloadBytes, provenanceBytes, downloadFailure: null, downloadHref: target, downloadUrl: `blob:${origin}/unit-download`,
    downloadTransfer: { runtimeBase: origin, pageOrigin: origin,
      location: { url: `${origin}/v1/projects/${project}/objects/${encodeURIComponent(video.object_id)}/location`,
        method: 'GET', resourceType: 'fetch', status: 200, origin, redirected: false,
        objectId: video.object_id, digest: video.digest, size: video.size },
      object: { url: `${origin}/v1/objects/${encodeURIComponent(video.object_id)}`, method: 'GET', resourceType: 'fetch',
        status: 200, origin, redirected: false, bytes: Buffer.from(downloadBytes) } }, probeStderr: '', remotionProject: '/render',
    metadata: { streams: [
      { codec_type: 'video', codec_name: 'h264', width: 640, height: 360, r_frame_rate: '30/1', nb_read_frames: '165' },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
    ], format: { size: String(video.size) } },
    decodedFrames: [{ frame: 0, decoded: { width: 640, height: 360, bytes: Buffer.alloc(640 * 360 * 3) } }],
    media: { currentSrc: target, readyState: 1, error: null },
  };
}

function aborted(proof: ResultPreviewProof): Extract<PageDiagnostic, { kind: 'requestfailed' }> {
  return { kind: 'requestfailed', url: proof.downloadHref, method: 'GET', message: 'net::ERR_ABORTED',
    requestId: 1, resourceType: 'media', range: 'bytes=0-', redirected: false,
    response: { requestId: 1, url: proof.downloadHref, status: 206, contentType: 'video/mp4',
      contentRange: `bytes 0-${proof.video.size - 1}/${proof.video.size}`, contentLength: String(proof.video.size) } };
}

const classifyResult = (raw: PageDiagnostic[], proof?: ResultPreviewProof) => classifyPageDiagnostics(raw, origin, project, proof);

test('keeps the exact qualified result abort raw and separate, alongside existing paired ACP diagnostics', () => {
  const proof = completeProof();
  const item = aborted(proof);
  const optionalAcp = [response(), consoleError()];
  const raw = [...optionalAcp, item];
  assert.deepEqual(classifyResult(raw, proof), { raw, optionalAcp, qualifiedResultPreviews: [item], failures: [] });
});

test('empty scope (including Case 2) and unfinished case keep result/source aborts failing', () => {
  const item = aborted(completeProof());
  assert.deepEqual(classifyResult([item]).failures, [item]);
  const source = { ...item, url: `${origin}/api/astrid/v1/objects/${encodeURIComponent(digest('a'))}` };
  assert.deepEqual(classifyResult([source], completeProof()).failures, [source]);
});

for (const field of Object.keys(completeProof()) as Array<keyof ResultPreviewProof>) {
  test(`missing concrete proof field ${field} fails closed`, () => {
    const proof = completeProof();
    const item = aborted(proof);
    delete (proof as Partial<ResultPreviewProof>)[field];
    assert.deepEqual(classifyResult([item], proof).failures, [item]);
  });
}

function changeProvenance(proof: ResultPreviewProof, mutate: (value: { canonical_timeline: Record<string, unknown>; engine: string; backend_fragments: Record<string, Record<string, unknown>> }) => void) {
  const value = JSON.parse(Buffer.from(proof.provenanceBytes).toString());
  mutate(value);
  proof.provenanceBytes = Buffer.from(JSON.stringify(value));
  proof.provenanceOutput.digest = mediaHash(proof.provenanceBytes);
  proof.provenanceOutput.object_id = proof.provenanceOutput.digest;
  proof.provenanceOutput.size = proof.provenanceBytes.length;
}

const invalidProofs: Record<string, (proof: ResultPreviewProof) => void> = {
  'failed full fetch': p => { p.downloadTransfer.object.status = 403; },
  'range-only fetch': p => { p.downloadTransfer.object.range = 'bytes=0-'; },
  'wrong fetch project': p => { (p.downloadTransfer as DownloadTransfer).location.url += '/other'; },
  'different fetched bytes': p => { p.downloadTransfer.object.bytes[0] ^= 255; },
  'native HTTP navigation': p => { p.downloadUrl = p.downloadHref; },
  'unfinished download': p => { p.downloadFailure = 'cancelled'; },
  'truncated download': p => { p.downloadBytes = p.downloadBytes.subarray(1); },
  'wrong managed size': p => { p.video.size++; },
  'wrong digest': p => { p.video.digest = digest('d'); },
  'corrupt full bytes': p => { p.downloadBytes[0] ^= 255; },
  'wrong object': p => { p.video.object_id = digest('d'); },
  'wrong output project': p => { p.video.project_id = 'other'; },
  'wrong output task': p => { p.video.task_id = 'other'; },
  'wrong output run': p => { p.video.run_id = 'other'; },
  'wrong output attempt': p => { p.video.attempt_id = 'other'; },
  'missing attempt': p => { p.completed.attempt_id = null; },
  'wrong completed task': p => { p.completed.task_id = 'other'; },
  'wrong completed project': p => { p.completed.project_id = 'other'; },
  'unfinished task': p => { p.completed.state = 'running'; },
  'changed spec': p => { p.completed.spec = {}; },
  'wrong fixture revision': p => { p.fixture.headRevisionId = 'other'; },
  'wrong capability': p => { p.capabilityDigest = digest('d'); },
  'non-result role': p => { p.video.role = 'input'; },
  'non-video port': p => { p.video.output_port = 'other'; },
  'unavailable output': p => { p.video.state = 'missing'; },
  'wrong output type': p => { p.video.media_type = 'application/octet-stream'; },
  'wrong sidecar digest': p => { p.provenanceOutput.digest = digest('d'); },
  'wrong sidecar size': p => { p.provenanceOutput.size++; },
  'wrong sidecar project': p => { p.provenanceOutput.project_id = 'other'; },
  'wrong sidecar attempt': p => { p.provenanceOutput.attempt_id = 'other'; },
  'wrong sidecar task': p => { p.provenanceOutput.task_id = 'other'; },
  'corrupt sidecar': p => { p.provenanceBytes[0] ^= 255; },
  'wrong provenance authority': p => changeProvenance(p, v => { v.canonical_timeline.parent_revision_id = 'other'; }),
  'wrong provenance engine': p => changeProvenance(p, v => { v.engine = 'other'; }),
  'wrong provenance backend': p => changeProvenance(p, v => { v.backend_fragments['rendering.remotion'].renderer = 'other'; }),
  'wrong provenance source': p => changeProvenance(p, v => { v.backend_fragments['rendering.remotion'].project_dir = '/other'; }),
  'ffprobe decoding error': p => { p.probeStderr = 'Invalid data'; },
  'wrong codec': p => { p.metadata.streams[0].codec_name = 'vp8'; },
  'wrong width': p => { p.metadata.streams[0].width = 320; },
  'wrong height': p => { p.metadata.streams[0].height = 180; },
  'wrong FPS': p => { p.metadata.streams[0].r_frame_rate = '24/1'; },
  'wrong frame count': p => { p.metadata.streams[0].nb_read_frames = '164'; },
  'wrong audio codec': p => { p.metadata.streams[1].codec_name = 'opus'; },
  'wrong audio rate': p => { p.metadata.streams[1].sample_rate = '44100'; },
  'wrong audio channels': p => { p.metadata.streams[1].channels = 1; },
  'missing audio': p => { p.metadata.streams.pop(); },
  'wrong probe size': p => { p.metadata.format.size = '0'; },
  'missing decoded frames': p => { p.decodedFrames = []; },
  'wrong decoded frame': p => { p.decodedFrames[0].frame = 1; },
  'wrong decoded dimensions': p => { p.decodedFrames[0].decoded = { width: 320, height: 360, bytes: Buffer.alloc(0) }; },
  'truncated decoded bytes': p => { p.decodedFrames[0].decoded = { width: 640, height: 360, bytes: Buffer.alloc(1) }; },
  'incomplete parity baseline': p => { p.comparisons = []; },
  'wrong Download URL': p => { p.downloadHref += '?download=1'; },
  'redirected download URL': p => { p.downloadUrl += '?redirect=1'; },
  'wrong live URL': p => { p.media.currentSrc += '?preview=1'; },
  'metadata not ready': p => { p.media.readyState = 0; },
  'live native MediaError': p => { p.media.error = { code: 3, message: 'decode error' }; },
};
for (const [name, mutate] of Object.entries(invalidProofs)) {
  test(`result abort remains failing with ${name}`, () => {
    const proof = completeProof();
    const item = aborted(proof);
    mutate(proof);
    assert.deepEqual(classifyResult([item], proof).failures, [item]);
  });
}

test('configured origin/project and source outputs cannot borrow a complete artifact proof', () => {
  const proof = completeProof();
  const item = aborted(proof);
  assert.deepEqual(classifyPageDiagnostics([item], origin.replace('127.0.0.1', 'localhost'), project, proof).failures, [item]);
  assert.deepEqual(classifyPageDiagnostics([item], origin, 'other-project', proof).failures, [item]);
  proof.fixture.media = [...proof.fixture.media, { objectId: proof.video.object_id, digest: proof.video.digest }];
  assert.deepEqual(classifyResult([item], proof).failures, [item]);
});

test('parity cases require every decoded baseline frame', () => {
  const proof = completeProof();
  const decoded = proof.decodedFrames[0].decoded;
  proof.decodedFrames = PARITY_FRAMES.map(frame => ({ frame, decoded }));
  proof.comparisons = PARITY_FRAMES.map(frame => compareRgbFrames(decoded, decoded, frame));
  assert.equal(classifyResult([aborted(proof)], proof).qualifiedResultPreviews.length, 1);
  proof.comparisons = proof.comparisons.map(item => ({ ...item, outsideBoundFraction: 1 }));
  assert.equal(classifyResult([aborted(proof)], proof).qualifiedResultPreviews.length, 0);
});

const invalidRequests: Record<string, (item: ReturnType<typeof aborted>) => void> = {
  'wrong URL': i => { i.url += '/other'; },
  'wrong origin': i => { i.url = i.url.replace('127.0.0.1', 'localhost'); },
  'wrong port': i => { i.url = i.url.replace('17340', '17341'); },
  'query URL': i => { i.url += '?download=1'; },
  'non-GET': i => { i.method = 'POST'; },
  'HEAD': i => { i.method = 'HEAD'; },
  'fetch resource': i => { i.resourceType = 'fetch'; },
  'wrong Range': i => { i.range = 'bytes=0-1023'; },
  'missing Range': i => { delete i.range; },
  'redirect': i => { i.redirected = true; },
  'missing redirect knowledge': i => { delete i.redirected; },
  'missing response': i => { delete i.response; },
  'missing request identity': i => { delete i.requestId; },
  'mismatched request identity': i => { i.response!.requestId = 2; },
  'wrong response URL': i => { i.response!.url += '?other=1'; },
  'full status200': i => { i.response!.status = 200; },
  'auth status403': i => { i.response!.status = 403; },
  'HTTP status500': i => { i.response!.status = 500; },
  'wrong MIME': i => { i.response!.contentType = 'application/octet-stream'; },
  'missing length': i => { delete i.response!.contentLength; },
  'wrong length': i => { i.response!.contentLength = '1'; },
  'bounded range response': i => { i.response!.contentRange = `bytes 0-1/${completeProof().video.size}`; },
  'missing Content-Range': i => { delete i.response!.contentRange; },
  'other error': i => { i.message = 'net::ERR_FAILED'; },
  'similar error': i => { i.message = 'net::ERR_ABORTED extra'; },
};
for (const [name, mutate] of Object.entries(invalidRequests)) {
  test(`result abort remains failing for ${name}`, () => {
    const proof = completeProof();
    const item = aborted(proof);
    mutate(item);
    assert.deepEqual(classifyResult([item], proof).failures, [item]);
  });
}

test('repeated or ambiguous result failures never qualify by URL', () => {
  const proof = completeProof();
  const raw = [aborted(proof), { ...aborted(proof), requestId: 2 }];
  assert.deepEqual(classifyResult(raw, proof).failures, raw);
});

for (const extra of [
  { kind: 'pageerror', message: 'crashed' }, consoleError({ message: 'decoder error' }),
  { kind: 'mediaerror', url: 'input-video', code: 3, message: 'native decoder error' },
  response({ url: `${origin}/api/astrid/v1/capabilities` }),
  response({ url: `${origin}/api/astrid/auth`, status: 401 }),
  { kind: 'requestfailed', url: 'input-video', method: 'GET', message: 'net::ERR_ABORTED' },
  { kind: 'requestfailed', url: 'unknown', method: 'GET', message: 'unknown request failure' },
] satisfies PageDiagnostic[]) {
  test(`another ${extra.kind} failure prevents result qualification`, () => {
    const proof = completeProof();
    const raw = [aborted(proof), extra];
    assert.deepEqual(classifyResult(raw, proof).failures, raw);
  });
}

function requestFor(proof: ResultPreviewProof) {
  return { url: () => proof.downloadHref, method: () => 'GET', resourceType: () => 'media',
    headers: () => ({ range: 'bytes=0-' }), redirectedFrom: () => null,
    failure: () => ({ errorText: 'net::ERR_ABORTED' }) };
}

function resultPage(proof: ResultPreviewProof) {
  const page = Object.assign(new EventEmitter(), { url: () => origin });
  const errors: PageDiagnostic[] = [];
  Object.assign(page, { addInitScript: async () => {}, evaluate: async () => errors.splice(0),
    getByTestId: () => ({ evaluateAll: async () => proof.media }) });
  return { page: page as unknown as Page, events: page, errors };
}

function emitPreviewResponse(page: EventEmitter, proof: ResultPreviewProof, request: ReturnType<typeof requestFor>) {
  page.emit('response', { url: () => proof.downloadHref, status: () => 206, request: () => request,
    headers: () => ({ 'content-type': 'video/mp4', 'content-length': String(proof.video.size),
      'content-range': `bytes 0-${proof.video.size - 1}/${proof.video.size}` }) });
}

test('collector correlates the actual request object, never another request to the same URL', async () => {
  for (const sameRequest of [true, false]) {
    const proof = completeProof();
    const { page, events } = resultPage(proof);
    const logs = collectPageDiagnostics(page, origin, project);
    await logs.observeMediaErrors();
    const request = requestFor(proof);
    emitPreviewResponse(events, proof, request);
    events.emit('requestfailed', sameRequest ? request : requestFor(proof));
    await logs.completeResult(proof);
    const result = await logs.result();
    assert.equal(result.raw.length, 1);
    assert.equal(result.qualifiedResultPreviews.length, sameRequest ? 1 : 0);
    assert.equal(result.failures.length, sameRequest ? 0 : 1);
    logs.stop();
    assert.deepEqual(events.eventNames(), []);
  }
});

test('collector stays strict before completion, after an early failure, and for later native errors', async () => {
  const proof = completeProof();
  const { page, events, errors } = resultPage(proof);
  const logs = collectPageDiagnostics(page, origin, project);
  await assert.rejects(logs.completeResult(proof), /media-error observation/);
  await logs.observeMediaErrors();
  const request = requestFor(proof);
  emitPreviewResponse(events, proof, request);
  events.emit('requestfailed', request);
  assert.equal((await logs.result()).failures.length, 1);
  await logs.completeResult(proof);
  assert.equal((await logs.result()).qualifiedResultPreviews.length, 1);
  logs.discardResult();
  assert.equal((await logs.result()).failures.length, 1);
  await logs.completeResult(proof);
  errors.push({ kind: 'mediaerror', url: proof.downloadHref, code: 3, message: 'transient native error' });
  let result = await logs.result();
  assert.deepEqual(result.failures.map(item => item.kind), ['requestfailed', 'mediaerror']);
  result = await logs.result();
  assert.equal(result.qualifiedResultPreviews.length, 0, 'observed errors remain raw on subsequent reads');
  logs.stop();
});

test('collector rechecks live currentSrc/metadata/MediaError at final diagnostic evaluation', async () => {
  for (const change of [
    (p: ResultPreviewProof) => { p.media.currentSrc += '?changed=1'; },
    (p: ResultPreviewProof) => { p.media.readyState = 0; },
    (p: ResultPreviewProof) => { p.media.error = { code: 3, message: 'decode failed' }; },
  ]) {
    const proof = completeProof();
    const { page, events } = resultPage(proof);
    const logs = collectPageDiagnostics(page, origin, project);
    await logs.observeMediaErrors();
    const request = requestFor(proof);
    emitPreviewResponse(events, proof, request);
    events.emit('requestfailed', request);
    await logs.completeResult(proof);
    change(proof);
    const result = await logs.result();
    assert.equal(result.qualifiedResultPreviews.length, 0);
    assert.ok(result.failures.some(item => item.kind === 'requestfailed'));
    if (proof.media.error) assert.ok(result.failures.some(item => item.kind === 'mediaerror'));
    logs.stop();
  }
});

test('document media-error capture is passive and retains native errors even after the element clears its error', async () => {
  let capture: ((event: { target: unknown }) => void) | undefined;
  class MediaElement {
    currentSrc = 'input-video';
    src = 'input-video';
    error: { code: number; message: string } | null = { code: 3, message: 'decode failed' };
    load() { assert.fail('observer must not load media'); }
    play() { assert.fail('observer must not play media'); }
    pause() { assert.fail('observer must not pause media'); }
  }
  const window: { __viewingParityMediaErrors?: PageDiagnostic[] } = {};
  const page = Object.assign(new EventEmitter(), { url: () => origin });
  Object.assign(page, { addInitScript: async (callback: () => void) => {
    runInNewContext(`(${callback.toString()})()`, { window, HTMLMediaElement: MediaElement,
      document: { addEventListener: (name: string, listener: typeof capture, capturing: boolean) => {
        assert.equal(name, 'error');
        assert.equal(capturing, true);
        capture = listener;
      } } });
  }, evaluate: async () => window.__viewingParityMediaErrors!.splice(0) });
  const logs = collectPageDiagnostics(page as unknown as Page, origin, project);
  await logs.observeMediaErrors();
  const media = new MediaElement();
  capture!({ target: media });
  media.error = null;
  capture!({ target: {} });
  const result = await logs.result();
  assert.deepEqual(JSON.parse(JSON.stringify(result.failures)), [{ kind: 'mediaerror', url: 'input-video', code: 3, message: 'decode failed' }]);
  logs.stop();
});

test('qualifies main managed-fetch result bytes with the same strict task, provenance and media proof', () => {
  const legacy = completeProof();
  const proof: ResultPreviewProof = { ...legacy, downloadTransfer: {
    runtimeBase: `${origin}/api/astrid`, pageOrigin: origin,
    object: { ...legacy.downloadTransfer.object, url: legacy.downloadHref },
  } };
  const item = aborted(proof);
  assert.deepEqual(classifyResult([item], proof).qualifiedResultPreviews, [item]);
  proof.downloadTransfer.object.bytes = proof.downloadTransfer.object.bytes.subarray(1);
  assert.deepEqual(classifyResult([item], proof).failures, [item]);
});

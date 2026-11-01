import assert from 'node:assert/strict';
import type { ManagedOutput, Task } from '../../../../src/integrations/runtime/generated';
import { assertDownloadTransfer, type DownloadTransfer, type ManagedDownloadTransfer } from './download';
import { assertTaskAuthority, record } from './authority';
import { PARITY_FRAMES, type FrameParityFixture } from './fixture';
import { mediaHash, PARITY_FPS } from './media';
import { assertFrameWithinBound, type FrameComparison, type RgbFrame } from './compare';
import { ORIGINAL_640, type ParityCanvas } from './canvas';
import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';

export const ACP_RESOURCE_ERROR = 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)';

export type PageDiagnostic =
  | { kind: 'pageerror'; message: string; stack?: string }
  | { kind: 'console'; message: string; location: { url: string; lineNumber: number; columnNumber: number } }
  | { kind: 'response'; url: string; method: string; status: number; body?: string; bodyError?: string }
  | { kind: 'mediaerror'; url: string; code: number; message: string }
  | { kind: 'requestfailed'; url: string; method: string; message: string; requestId?: number;
      resourceType?: string; range?: string; redirected?: boolean; response?: {
        requestId: number; url: string; status: number; contentType?: string; contentRange?: string; contentLength?: string;
      } };

export interface ResultPreviewProof {
  initial: Task; completed: Task; fixture: FrameParityFixture; capabilityDigest: string;
  video: ManagedOutput; provenanceOutput: ManagedOutput; provenanceBytes: Uint8Array;
  downloadBytes: Uint8Array; downloadFailure: string | null; downloadHref: string; downloadUrl: string; downloadTransfer: DownloadTransfer | ManagedDownloadTransfer;
  metadata: { streams: Array<Record<string, unknown>>; format: Record<string, unknown> };
  probeStderr: string; remotionProject: string;
  decodedFrames: Array<{ frame: number; decoded: RgbFrame }>;
  comparisons?: readonly FrameComparison[];
  media: { currentSrc: string; readyState: number; error: { code: number; message: string } | null };
}

/** Concrete same-case results, supplied only after all case assertions finish. */
export function assertCompleteResult(proof: ResultPreviewProof, origin: string, projectId: string, canvas: ParityCanvas = ORIGINAL_640): string {
  const { initial, completed, fixture, video, provenanceOutput, metadata, media } = proof;
  assert.equal(fixture.projectId, projectId);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.task_id, initial.task_id);
  assert.equal(completed.run_id, initial.run_id);
  assert.ok(completed.attempt_id);
  assert.deepEqual(completed.spec, initial.spec);
  const frozen = assertTaskAuthority(initial, fixture, proof.capabilityDigest);
  assert.deepEqual(assertTaskAuthority(completed, fixture, proof.capabilityDigest), frozen);
  for (const output of [video, provenanceOutput]) {
    assert.equal(output.task_id, completed.task_id);
    assert.equal(output.run_id, completed.run_id);
    assert.equal(output.project_id, projectId);
    assert.equal(output.attempt_id, completed.attempt_id);
    assert.equal(output.state, 'available');
    assert.match(output.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(output.object_id, output.digest);
    assert.ok(Number.isSafeInteger(output.size) && output.size > 0);
  }
  assert.ok(!fixture.media.some(pin => pin.objectId === video.object_id || pin.digest === video.digest));
  assert.equal(video.media_type, 'video/mp4');
  assert.equal(video.output_port, 'video');
  assert.equal(video.role, 'result');
  assert.equal(provenanceOutput.role, 'auxiliary');
  assert.equal(provenanceOutput.output_port, 'provenance');
  assert.equal(provenanceOutput.media_type, 'application/json');
  assert.equal(proof.downloadFailure, null);
  assert.equal(proof.downloadBytes.length, video.size);
  assert.equal(mediaHash(proof.downloadBytes), video.digest);
  assert.equal(proof.provenanceBytes.length, provenanceOutput.size);
  assert.equal(mediaHash(proof.provenanceBytes), provenanceOutput.digest);
  const provenance = record(JSON.parse(Buffer.from(proof.provenanceBytes).toString('utf8')));
  assert.deepEqual(provenance.canonical_timeline, frozen.authority);
  assert.equal(provenance.engine, 'rendering.remotion');
  const backend = record(record(provenance.backend_fragments)['rendering.remotion']);
  assert.equal(backend.renderer, 'remotion');
  assert.equal(backend.composition_id, 'TimelineComposition');
  assert.equal(backend.project_dir, proof.remotionProject);
  assert.equal(proof.probeStderr, '');
  assert.equal(metadata.streams.length, 2);
  const v = metadata.streams.find(stream => stream.codec_type === 'video');
  const a = metadata.streams.find(stream => stream.codec_type === 'audio');
  assert.ok(v && a);
  assert.deepEqual([v.codec_name, v.width, v.height, v.r_frame_rate, v.nb_read_frames],
    ['h264', canvas.width, canvas.height, `${PARITY_FPS}/1`, '165']);
  assert.deepEqual([a.codec_name, a.sample_rate, a.channels], ['aac', '48000', 2]);
  assert.equal(metadata.format.size, String(video.size));
  assert.deepEqual(proof.decodedFrames.map(item => item.frame), proof.comparisons ? [...PARITY_FRAMES] : [0]);
  if (proof.comparisons) {
    assert.deepEqual(proof.comparisons.map(item => item.frame), [...PARITY_FRAMES]);
    proof.comparisons.forEach(comparison => assertFrameWithinBound(comparison, canvas));
  }
  for (const { decoded } of proof.decodedFrames) {
    assert.equal(decoded.width, canvas.width);
    assert.equal(decoded.height, canvas.height);
    assert.equal(decoded.bytes.length, canvas.width * canvas.height * 3);
  }
  const url = `${new URL(origin).origin}/api/astrid/v1/objects/${encodeURIComponent(video.object_id)}`;
  assert.equal(proof.downloadHref, url);
  const downloadBase = 'location' in proof.downloadTransfer ? origin : `${new URL(origin).origin}/api/astrid`;
  assertDownloadTransfer(proof.downloadTransfer, downloadBase, projectId, video, proof.downloadBytes,
    proof.downloadUrl, proof.downloadTransfer.pageOrigin);
  assert.equal(media.currentSrc, url);
  assert.ok(media.readyState >= 1);
  assert.equal(media.error, null);
  return url;
}

function resultPreviewAbort(raw: readonly PageDiagnostic[], proof: ResultPreviewProof | undefined,
  origin: string, projectId: string, canvas: ParityCanvas): PageDiagnostic[] {
  if (!proof) return [];
  let url: string;
  try { url = assertCompleteResult(proof, origin, projectId, canvas); } catch { return []; }
  const matching = raw.filter(item => item.kind === 'requestfailed' && item.url === url);
  if (matching.length !== 1) return [];
  const item = matching[0];
  if (item.kind !== 'requestfailed' || item.message !== 'net::ERR_ABORTED' || item.method !== 'GET'
    || item.resourceType !== 'media' || item.range !== 'bytes=0-' || item.redirected !== false
    || !Number.isSafeInteger(item.requestId) || !item.response || item.response.requestId !== item.requestId
    || item.response.url !== url || item.response.status !== 206 || item.response.contentType !== 'video/mp4'
    || item.response.contentLength !== String(proof.video.size)
    || item.response.contentRange !== `bytes 0-${proof.video.size - 1}/${proof.video.size}`) return [];
  return [item];
}

function optionalAcpUrl(url: string, origin: string, projectId: string): boolean {
  return ['/api/astrid/acp/models', '/api/astrid/acp/agents',
    `/api/astrid/acp/projects/${encodeURIComponent(projectId)}/chat`]
    .some(path => url === `${new URL(origin).origin}${path}`);
}

function unavailableBody(body: string | undefined): boolean {
  try {
    const value = JSON.parse(body ?? '') as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      && Object.keys(value).length === 1 && 'error' in value && value.error === 'acp_unavailable';
  } catch { return false; }
}

/** Keep raw failures; qualify only paired ACP errors or a fully checked result preview. */
export function classifyPageDiagnostics(raw: readonly PageDiagnostic[], origin: string, projectId: string, proof?: ResultPreviewProof, canvas: ParityCanvas = ORIGINAL_640) {
  const optional = new Set<PageDiagnostic>();
  const responses = raw.filter(item => item.kind === 'response');
  for (const item of raw) {
    if (item.kind !== 'console' || item.message !== ACP_RESOURCE_ERROR
      || item.location.lineNumber !== 0 || item.location.columnNumber !== 0
      || !optionalAcpUrl(item.location.url, origin, projectId)) continue;
    const matching = responses.filter(response => response.url === item.location.url);
    // Ambiguous failures on the same URL cannot qualify a resource console message.
    if (!matching.length || matching.some(response => response.method !== 'GET'
      || response.status !== 503 || !unavailableBody(response.body))
      || raw.some(error => error.kind === 'requestfailed' && error.url === item.location.url)) continue;
    const response = matching.find(candidate => !optional.has(candidate));
    if (response) { optional.add(response); optional.add(item); }
  }
  // Other errors also prevent qualification; a complete file does not excuse them.
  const candidates = resultPreviewAbort(raw, proof, origin, projectId, canvas);
  const qualifiedResultPreviews = raw.every(item => optional.has(item) || candidates.includes(item)) ? candidates : [];
  return { raw: [...raw], optionalAcp: raw.filter(item => optional.has(item)), qualifiedResultPreviews,
    failures: raw.filter(item => !optional.has(item) && !qualifiedResultPreviews.includes(item)) };
}

/** Observe real traffic without intercepting requests or changing product readiness. */
export function collectPageDiagnostics(page: Page, origin: string, projectId: string, canvas: ParityCanvas = ORIGINAL_640) {
  const raw: PageDiagnostic[] = [];
  const pending = new Set<Promise<void>>();
  const responses = new WeakMap<Request, NonNullable<Extract<PageDiagnostic, { kind: 'requestfailed' }>['response']>>();
  const identities = new WeakMap<Request, number>();
  let nextId = 0;
  const identity = (request: Request) => {
    if (!identities.has(request)) identities.set(request, ++nextId);
    return identities.get(request)!;
  };
  let proof: Omit<ResultPreviewProof, 'media'> | undefined;
  let observingMedia = false;
  const onPageError = (error: Error) => raw.push({ kind: 'pageerror', message: error.message, stack: error.stack });
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === 'error') raw.push({ kind: 'console', message: message.text(), location: message.location() });
  };
  const onRequestFailed = (request: Request) => raw.push({ kind: 'requestfailed', url: request.url(),
    method: request.method(), message: request.failure()?.errorText ?? 'unknown request failure',
    requestId: identity(request), resourceType: request.resourceType(), range: request.headers().range,
    redirected: request.redirectedFrom() !== null, response: responses.get(request) });
  const onResponse = (response: Response) => {
    const request = response.request();
    const headers = response.headers();
    responses.set(request, { requestId: identity(request), url: response.url(), status: response.status(),
      contentType: headers['content-type'], contentRange: headers['content-range'], contentLength: headers['content-length'] });
    if (response.status() < 400) return;
    const item: Extract<PageDiagnostic, { kind: 'response' }> = { kind: 'response', url: response.url(),
      method: response.request().method(), status: response.status() };
    raw.push(item);
    if (item.method !== 'GET' || item.status !== 503 || !optionalAcpUrl(item.url, origin, projectId)) return;
    const reading = response.text().then(body => { item.body = body; }, error => { item.bodyError = String(error); });
    pending.add(reading);
    void reading.then(() => pending.delete(reading));
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);
  async function liveMedia() {
    return page.getByTestId('timeline-render-player').evaluateAll(elements => {
      if (elements.length !== 1 || !(elements[0] instanceof HTMLVideoElement)) return undefined;
      const video = elements[0];
      return { currentSrc: video.currentSrc, readyState: video.readyState,
        error: video.error ? { code: video.error.code, message: video.error.message } : null };
    });
  }
  return {
    async observeMediaErrors() {
      await page.addInitScript(() => {
        window.__viewingParityMediaErrors = [];
        document.addEventListener('error', event => {
          if (event.target instanceof HTMLMediaElement) {
            const media = event.target;
            window.__viewingParityMediaErrors.push({ kind: 'mediaerror', url: media.currentSrc || media.src,
              code: media.error?.code ?? 0, message: media.error?.message ?? 'native media element error' });
          }
        }, true);
      });
      observingMedia = true;
    },
    async completeResult(value: Omit<ResultPreviewProof, 'media'>) {
      const media = await liveMedia();
      assert.ok(observingMedia && media, 'result requires document media-error observation and a live video');
      assert.equal(value.downloadTransfer.pageOrigin, new URL(page.url()).origin);
      assertCompleteResult({ ...value, media }, origin, projectId, canvas);
      proof = value;
    },
    discardResult() { proof = undefined; },
    async result() {
      await Promise.all([...pending]);
      if (observingMedia) {
        raw.push(...await page.evaluate(() => window.__viewingParityMediaErrors.splice(0)));
      }
      const media = proof ? await liveMedia() : undefined;
      if (media?.error) raw.push({ kind: 'mediaerror', url: media.currentSrc, ...media.error });
      return classifyPageDiagnostics(raw, origin, projectId, proof && media ? { ...proof, media } : undefined, canvas);
    },
    stop() {
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
    },
  };
}

declare global {
  interface Window { __viewingParityMediaErrors: Array<Extract<PageDiagnostic, { kind: 'mediaerror' }>> }
}

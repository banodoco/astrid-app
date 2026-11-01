import { downloadBlobAsFile } from '@/shared/runtime/browserDownloadRuntime.ts';
import { AstridRuntimeClient } from '@/integrations/runtime/client.ts';
import type { Task } from '@/integrations/runtime/generated.ts';
import { runtimeApiBase } from '@/integrations/runtime/connection.ts';
import { getBridgeTaskClient } from '@/integrations/astrid/bridgeTaskReads.ts';
import { writeStoredZip, readStoredZip, verifyStoredZipEntry, type StoredZipProgress } from './timeline-transfer-zip.ts';

const INLINE_MANIFEST_LIMIT = 256 * 1024;
const INLINE_COMMIT_LIMIT = 768 * 1024;
const MAX_JSON_ENTRY = 64 * 1024 * 1024;
const MAX_FALLBACK_ARCHIVE = 1024 * 1024 * 1024;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const encoder = new TextEncoder();

type TaskClient = Pick<AstridRuntimeClient,
  'admitTask' | 'getTask' | 'listManagedOutputs' | 'ingestProjectObject'
  | 'listProjectObjects' | 'importTimeline'> & Partial<Pick<AstridRuntimeClient, 'listCapabilities'>>;

export type TransferProgress = { phase: string; loaded: number; total: number };
export type TransferToast = { loading(message: string): unknown; update(id: unknown, message: string): void; success(message: string, id?: unknown, description?: string): void; warning(message: string, id?: unknown, description?: string): void; error(message: string, id?: unknown, description?: string): void };
type TransferOptions = { saveAs?: boolean; client?: TaskClient; fetchImpl?: typeof fetch; xhrFactory?: () => XMLHttpRequest; onProgress?: (progress: TransferProgress) => void; toast?: TransferToast; existingNames?: readonly string[]; onImported?: (timelineId: string) => Promise<boolean> };

/** "Name" if free, else "Name 2", "Name 3", … (same numbering as "Timeline N"). */
export function uniqueTimelineName(name: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((item) => item.trim().toLowerCase()));
  if (!taken.has(name.trim().toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function randomKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function parseJson(text: string, label: string): Record<string, unknown> {
  try { return asRecord(JSON.parse(text), label); }
  catch (error) { throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function jsonBlob(value: unknown): Blob {
  return new Blob([encoder.encode(JSON.stringify(value))], { type: 'application/json' });
}

function blobStream(blob: Blob): ReadableStream<Uint8Array> {
  if (typeof blob.stream === 'function') return blob.stream();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try { controller.enqueue(new Uint8Array(await blob.arrayBuffer())); controller.close(); }
      catch (error) { controller.error(error); }
    },
  });
}

async function runAction(client: TaskClient, project: string, id: string, params: Record<string, unknown>, injectedClient: boolean): Promise<{ taskId: string; outputs: Awaited<ReturnType<TaskClient['listManagedOutputs']>>['items'] }> {
  let cursor: string | undefined;
  let capability: Awaited<ReturnType<AstridRuntimeClient['listCapabilities']>>['items'][number] | undefined;
  do {
    // Capability discovery is an Astrid product catalog read (`/api/astrid`),
    // while admission and task lifecycle remain Runtime routes (`/api/runtime`).
    const page = injectedClient && client.listCapabilities
      ? await client.listCapabilities(cursor, 100)
      : await getBridgeTaskClient(project).catalog.list({ cursor, limit: 100 });
    capability = page.items.find((item) => item.capability_id === id && item.status === 'ready');
    cursor = page.next_cursor ?? undefined;
  } while (!capability && cursor);
  if (!capability) throw new Error(`Runtime action ${id} is unavailable. Update Astrid and try again.`);
  const fileNames = ['manifest_file', 'payload'].filter((name) => typeof params[name] === 'string');
  const inputDigests = fileNames.map((name) => ({ name, digest: String(params[name]) }));
  const task = await client.admitTask({
    capability_id: capability.capability_id,
    capability_digest: capability.definition_digest,
    project,
    input_object_ids: inputDigests.map((item) => item.digest),
    storage_estimate: { scratch_bytes: capability.estimated_scratch_bytes, output_bytes: capability.estimated_output_bytes },
    spec: { capability_id: id, kind: 'action', inputs: params, outputs: {}, extra_pack_roots: [], ...(inputDigests.length ? { input_digests: inputDigests } : {}) },
    settlement_effect: {},
  }, randomKey(id));
  const taskId = task.task_id;
  let current: Task = task;
  while (!TERMINAL.has(current.state)) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    current = await client.getTask(taskId);
  }
  if (current.state !== 'succeeded') {
    const message = (current.result as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(message || `Runtime action ${id} ${current.state}.`);
  }
  let outputCursor: string | undefined;
  const outputs: Awaited<ReturnType<TaskClient['listManagedOutputs']>>['items'] = [];
  do {
    const page = await client.listManagedOutputs(taskId, outputCursor, 100);
    outputs.push(...page.items);
    outputCursor = page.next_cursor ?? undefined;
  } while (outputCursor);
  return { taskId, outputs };
}

async function fetchObjectJson(digest: string, declaredSize: number | undefined, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  if (declaredSize !== undefined && (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_JSON_ENTRY)) throw new Error('Action JSON is larger than 64 MiB.');
  const response = await fetchImpl(`${runtimeApiBase()}/v1/objects/${encodeURIComponent(digest)}`, { method: 'GET', credentials: 'omit' });
  if (!response.ok) throw new Error(`Runtime could not read object ${digest} (${response.status}).`);
  const contentLength = response.headers.get('Content-Length');
  if (declaredSize === undefined && contentLength && /^\d+$/.test(contentLength)) declaredSize = Number(contentLength);
  if (declaredSize !== undefined && declaredSize > MAX_JSON_ENTRY) throw new Error('Action JSON is larger than 64 MiB.');
  if (!response.body) throw new Error(`Runtime returned no body for action artifact ${digest}.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_JSON_ENTRY || (declaredSize !== undefined && size > declaredSize)) throw new Error('Action JSON exceeded its declared size or the 64 MiB limit.');
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  if (declaredSize !== undefined && size !== declaredSize) throw new Error('Action JSON size did not match its managed output descriptor.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'Action artifact');
}

async function getActionJson(client: TaskClient, project: string, action: string, params: Record<string, unknown>, port: string, fetchImpl: typeof fetch, injectedClient: boolean): Promise<{ value: Record<string, unknown>; taskId: string }> {
  const { taskId, outputs } = await runAction(client, project, action, params, injectedClient);
  const output = outputs.find((item) => item.output_port === port);
  if (!output) throw new Error(`Runtime action ${action} completed without its ${port} artifact.`);
  const value = await fetchObjectJson(output.digest, output.size, fetchImpl);
  return { value, taskId };
}

function saveFileHandle(filename: string): Promise<FileSystemFileHandle> {
  const picker = (globalThis as typeof globalThis & { showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (!picker) return Promise.reject(new Error('save picker unavailable'));
  return picker({ suggestedName: filename, types: [{ description: 'Astrid timeline', accept: { 'application/zip': ['.astrid'] } }] });
}

function safeFilename(name: string): string {
  const printable = Array.from(name.trim(), (character) => character.charCodeAt(0) < 32 ? '_' : character).join('');
  const base = printable.replace(/[\\/:*?"<>|]/g, '_').replace(/\.+$/g, '') || 'timeline';
  return base.toLowerCase().endsWith('.astrid') ? base : `${base}.astrid`;
}

/** Explicit Save as acquires its handle in the click gesture; exports use browser Downloads. */
export async function exportTimelineArchive(input: { projectId: string; timelineId: string; timelineName: string; flushPendingSave: () => Promise<unknown> }, options: TransferOptions = {}): Promise<void> {
  const filename = safeFilename(input.timelineName);
  let handle: FileSystemFileHandle | undefined;
  const handlePromise = options.saveAs ? saveFileHandle(filename).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  ) : undefined;
  let toastId: unknown;
  try {
    if (handlePromise) {
      const result = await handlePromise;
      if ('error' in result) {
        if ((result.error as { name?: string }).name === 'AbortError') return;
        throw result.error;
      }
      handle = result.value;
    }
    toastId = options.toast?.loading('Saving timeline before export…');
    await input.flushPendingSave();
    const client = options.client ?? new AstridRuntimeClient();
    const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    options.toast?.update(toastId, 'Preparing timeline export…');
    const { value: plan } = await getActionJson(client, input.projectId, 'rendering.timeline_export_plan', { project: input.projectId, timeline: input.timelineId }, 'plan', fetchImpl, options.client !== undefined);
    const manifest = asRecord(plan.manifest, 'Export manifest');
    const timeline = asRecord(plan.timeline, 'Export timeline');
    if (manifest.format !== 'astrid.timeline/1' || !Array.isArray(manifest.media) || !Array.isArray(manifest.transcripts) || !Array.isArray(plan.media)) throw new Error('Runtime returned an invalid timeline export plan.');
    if (!plan.transcripts || typeof plan.transcripts !== 'object' || Array.isArray(plan.transcripts)) throw new Error('Runtime returned invalid transcript export data.');
    const transcriptMap = plan.transcripts as Record<string, unknown>;
    const media = plan.media.map((row, index) => asRecord(row, `Export media item ${index}`));
    const mediaKeys = (rows: unknown[]) => rows.map((raw, index) => {
      const row = asRecord(raw, `Manifest media item ${index}`);
      const sha = String(row.sha256 ?? '');
      if (!/^[a-f0-9]{64}$/.test(sha) || typeof row.size !== 'number' || !Number.isSafeInteger(row.size) || row.size < 0) throw new Error('Export plan contains invalid media metadata.');
      return `${sha}:${row.size}`;
    }).sort();
    if (JSON.stringify(mediaKeys(manifest.media)) !== JSON.stringify(mediaKeys(media))) throw new Error('Export plan media does not match its manifest.');
    const transcriptNames = Object.keys(transcriptMap).map((name) => name.startsWith('transcripts/') ? name : `transcripts/${name}`).sort();
    const manifestTranscriptNames = (manifest.transcripts as unknown[]).filter((name): name is string => typeof name === 'string').sort();
    if (manifestTranscriptNames.length !== manifest.transcripts.length || JSON.stringify(manifestTranscriptNames) !== JSON.stringify(transcriptNames)) throw new Error('Export plan transcripts do not match its manifest.');
    const manifestBlob = jsonBlob(manifest), timelineBlob = jsonBlob(timeline);
    const transcriptBlobs = Object.entries(transcriptMap).map(([entryName, item]) => {
      const row = asRecord(item, 'Transcript');
      const path = entryName.startsWith('transcripts/') ? entryName : `transcripts/${entryName}`;
      if (!/^transcripts\/[0-9a-f]{64}\.[A-Za-z0-9_.%~-]+\.json$/.test(path)) throw new Error(`Runtime returned an invalid transcript entry name: ${path}.`);
      const content = asRecord(row.content ?? row.transcript ?? row, 'Transcript content');
      return { name: path, blob: jsonBlob(content) };
    });
    const entries = [
      { name: 'manifest.json', blob: manifestBlob },
      { name: 'timeline.json', blob: timelineBlob },
      ...transcriptBlobs,
      ...media.map((row) => {
        const sha = String(row.sha256 ?? '');
        const size = row.size;
        if (!/^[a-f0-9]{64}$/.test(sha) || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new Error('Export plan contains invalid media metadata.');
        return { name: `media/${sha}`, blob: null as Blob | null, digest: `sha256:${sha}`, size };
      }),
    ];
    const total = entries.reduce((sum, entry) => sum + (entry.blob?.size ?? (Number((entry as { size?: number }).size) || 0)), 0);
    const pickerApi = !!handle;
    const zipOverhead = entries.reduce((sum, entry) => sum + 160 + encoder.encode(entry.name).byteLength, 98);
    if (!pickerApi && total + Math.max(1024 * 1024, Math.ceil(total * 0.03), zipOverhead) > MAX_FALLBACK_ARCHIVE) {
      throw new Error('This timeline is too large for a browser download (1 GiB limit). Choose Save timeline as… in the timeline menu to stream it directly to a file.');
    }
    const sources = entries.map((entry) => ({
      name: entry.name,
      size: entry.blob?.size ?? Number((entry as { size?: number }).size),
      stream: () => entry.blob ? blobStream(entry.blob) : mediaObjectStream((entry as { digest: string }).digest, Number((entry as { size: number }).size), fetchImpl),
    }));
    const progress: StoredZipProgress = (p) => {
      options.onProgress?.({ phase: p.entry, loaded: p.totalBytes, total: p.totalSize });
      options.toast?.update(toastId, `Exporting ${input.timelineName}… ${Math.round(p.totalBytes / Math.max(1, p.totalSize) * 100)}%`);
    };
    if (handle) {
      const writable = await handle.createWritable();
      await writeStoredZip(sources, writable, progress);
    } else {
      const chunks: Uint8Array[] = [];
      const writable = new WritableStream<Uint8Array>({ write(chunk) { chunks.push(chunk); } });
      await writeStoredZip(sources, writable, progress);
      downloadBlobAsFile(new Blob(chunks.map((chunk) => chunk.slice().buffer as ArrayBuffer), { type: 'application/zip' }), filename);
    }
    options.toast?.success(handle ? `Saved ${input.timelineName}` : `Download started: ${input.timelineName}`, toastId);
  } catch (error) {
    if ((error as { name?: string }).name !== 'AbortError') options.toast?.error(`Couldn't export ${input.timelineName}`, toastId, error instanceof Error ? error.message : String(error));
  }
}

function mediaObjectStream(digest: string, expectedSize: number, fetchImpl: typeof fetch): ReadableStream<Uint8Array> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let read = 0;
  return new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        if (!reader) {
          const response = await fetchImpl(`${runtimeApiBase()}/v1/objects/${encodeURIComponent(digest)}`, { method: 'GET', credentials: 'omit', signal: controller.signal });
          if (!response.ok || !response.body) throw new Error(`Runtime could not stream ${digest} (${response.status}).`);
          reader = response.body.getReader();
        }
        const next = await reader.read();
        if (next.done) {
          if (read !== expectedSize) throw new Error('Media object size did not match its export plan.');
          streamController.close();
          return;
        }
        read += next.value.byteLength;
        if (read > expectedSize) throw new Error('Media object exceeded its declared size.');
        streamController.enqueue(next.value);
      } catch (error) {
        await reader?.cancel(error).catch(() => undefined);
        streamController.error(error);
      }
    },
    async cancel(reason) {
      controller.abort(reason);
      await reader?.cancel(reason).catch(() => undefined);
    },
  });
}

function xhrUpload(projectId: string, digest: string, filename: string, mediaType: string, blob: Blob, options: TransferOptions, loadedBefore: number, total: number, toastId?: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = (options.xhrFactory ?? (() => new XMLHttpRequest()))();
    xhr.open('POST', `${runtimeApiBase()}/v1/projects/${encodeURIComponent(projectId)}/objects`);
    xhr.setRequestHeader('Content-Type', mediaType || 'application/octet-stream');
    xhr.setRequestHeader('Idempotency-Key', randomKey('timeline-media'));
    xhr.setRequestHeader('X-Expected-Digest', digest);
    xhr.setRequestHeader('X-Original-Name', filename.replace(/[^\x20-\x7e]/g, '_'));
    xhr.upload.onprogress = (event) => {
      const progress = { phase: filename, loaded: loadedBefore + event.loaded, total };
      options.onProgress?.(progress);
      options.toast?.update(toastId, `Uploading ${filename}: ${Math.round(progress.loaded / Math.max(total, 1) * 100)}%`);
    };
    xhr.onerror = () => reject(new Error(`Media upload failed for ${filename}.`));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Media upload failed for ${filename} (${xhr.status}).`));
    xhr.send(blob);
  });
}

function jsonEntry(entries: Awaited<ReturnType<typeof readStoredZip>>, name: string): Promise<Record<string, unknown>> {
  const entry = entries.find((item) => item.name === name);
  if (!entry) throw new Error(`Archive is missing ${name}.`);
  if (entry.size > MAX_JSON_ENTRY) throw new Error(`${name} is larger than the 64 MiB transfer limit.`);
  return verifyStoredZipEntry(entry).then(() => entry.blob.text()).then((text) => parseJson(text, name));
}

function manifestForCheck(manifest: Record<string, unknown>): Record<string, unknown> {
  return { format: manifest.format, elements: manifest.elements };
}

function mediaDigest(sha: unknown): string {
  const raw = String(sha ?? '');
  if (!/^[a-f0-9]{64}$/.test(raw)) throw new Error(`Invalid media SHA-256 digest: ${String(sha)}`);
  return `sha256:${raw}`;
}

function mediaIdentity(value: unknown): string {
  const raw = String(value ?? '');
  const normalized = raw.startsWith('sha256:') ? raw.slice(7) : raw;
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`Invalid media SHA-256 identity: ${raw}`);
  return normalized;
}

function safeTranscriptSource(source: string): string {
  const bytes = encoder.encode(source);
  let result = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    result += /^[A-Za-z0-9_.~-]$/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return result || 'source';
}

function effectNames(values: unknown[]): string[] {
  return values.map((value) => {
    if (!value || typeof value !== 'object') return String(value);
    const descriptor = value as Record<string, unknown>;
    const id = typeof descriptor.id === 'string' ? descriptor.id : 'unknown effect';
    return typeof descriptor.packId === 'string' ? `${id} (${descriptor.packId})` : id;
  });
}

async function uploadJson(client: TaskClient, projectId: string, blob: Blob, filename: string): Promise<string> {
  const uploaded = await client.ingestProjectObject(projectId, blob, 'application/json', filename);
  return uploaded.object_id;
}

function validateArchiveEntries(entries: Awaited<ReturnType<typeof readStoredZip>>, manifest: Record<string, unknown>): { media: Array<Record<string, unknown>>; transcriptNames: string[] } {
  if (!Array.isArray(manifest.media) || !Array.isArray(manifest.transcripts) || !Array.isArray(manifest.elements)) throw new Error('Manifest media, transcripts, and elements must be arrays.');
  const media = manifest.media.map((item, index) => asRecord(item, `Manifest media item ${index}`));
  const transcriptNames = manifest.transcripts.map((name) => {
    if (typeof name !== 'string' || !/^transcripts\/[0-9a-f]{64}\.[A-Za-z0-9_.%~-]+\.json$/.test(name)) throw new Error('Manifest contains an invalid transcript entry name.');
    return name;
  });
  if (new Set(transcriptNames).size !== transcriptNames.length) throw new Error('Manifest contains duplicate transcript entries.');
  const expected = new Set(['manifest.json', 'timeline.json']);
  const mediaNames = new Set<string>();
  for (const item of media) {
    const digest = mediaDigest(item.sha256);
    const size = item.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid declared size for ${digest}.`);
    const name = `media/${digest.slice(7)}`;
    if (mediaNames.has(name)) throw new Error(`Manifest contains duplicate media entry ${name}.`);
    mediaNames.add(name);
    expected.add(name);
  }
  for (const name of transcriptNames) expected.add(name);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  if (byName.size !== entries.length) throw new Error('Archive contains duplicate entries.');
  for (const entry of entries) if (!expected.has(entry.name)) throw new Error(`Archive contains an unlisted entry: ${entry.name}.`);
  for (const name of expected) if (!byName.has(name)) throw new Error(`Archive is missing ${name}.`);
  let metadataBytes = 0;
  for (const name of ['manifest.json', 'timeline.json', ...transcriptNames]) {
    const entry = byName.get(name)!;
    if (entry.size > MAX_JSON_ENTRY) throw new Error(`${name} is larger than the 64 MiB transfer limit.`);
    metadataBytes += entry.size;
    if (metadataBytes > MAX_JSON_ENTRY) throw new Error('Combined manifest, timeline, and transcript metadata exceeds 64 MiB.');
  }
  for (const item of media) {
    const name = `media/${mediaDigest(item.sha256).slice(7)}`;
    if (byName.get(name)!.size !== Number(item.size)) throw new Error(`Archive entry ${name} has the wrong size.`);
  }
  return { media, transcriptNames };
}

function validatePreparedMedia(prepared: Record<string, unknown>, manifestMedia: Array<Record<string, unknown>>, importedTranscripts: Array<Record<string, unknown>>): void {
  const publication = asRecord(prepared.publication, 'Prepared publication');
  const dependencies = asRecord(publication.dependency_manifest, 'Prepared dependency manifest');
  if (!Array.isArray(dependencies.media)) throw new Error('Prepared timeline is missing its publication media dependencies.');
  const declared = new Set(manifestMedia.map((item) => mediaIdentity(item.sha256)));
  const preparedMedia = new Set<string>();
  for (const row of dependencies.media) {
    const media = asRecord(row, 'Prepared media dependency');
    preparedMedia.add(mediaIdentity(media.media_id));
  }
  if (declared.size !== preparedMedia.size || [...declared].some((digest) => !preparedMedia.has(digest))) {
    throw new Error('Prepared publication media does not match the archive media manifest.');
  }
  const requireDeclared = (value: unknown, label: string) => {
    const digest = mediaIdentity(value);
    if (!declared.has(digest) || !preparedMedia.has(digest)) throw new Error(`${label} references media that is absent from the archive or prepared publication.`);
  };
  const transcripts = Array.isArray(prepared.transcripts) ? prepared.transcripts : [];
  const expectedTranscriptKeys = new Set(importedTranscripts.map((row) => {
    const content = asRecord(row.content, 'Archive transcript content');
    return `${mediaIdentity(content.media_id)}\0${String(content.source_id)}`;
  }));
  const preparedTranscriptKeys = new Set<string>();
  for (const raw of transcripts) {
    const transcript = asRecord(raw, 'Prepared transcript');
    const content = asRecord(transcript.content, 'Prepared transcript content');
    requireDeclared(content.media_id, 'Prepared transcript');
    preparedTranscriptKeys.add(`${mediaIdentity(content.media_id)}\0${String(content.source_id)}`);
  }
  if (expectedTranscriptKeys.size !== preparedTranscriptKeys.size || [...expectedTranscriptKeys].some((key) => !preparedTranscriptKeys.has(key))) throw new Error('Prepared transcript identities do not match the archive transcript entries.');
  const bindings = Array.isArray(prepared.text_bindings) ? prepared.text_bindings : [];
  for (const raw of bindings) {
    const binding = asRecord(raw, 'Prepared text binding');
    requireDeclared(binding.media_id, 'Prepared text binding');
  }
  const shotRevisions = Array.isArray(publication.shot_revisions) ? publication.shot_revisions : [];
  for (const raw of shotRevisions) {
    const revision = asRecord(raw, 'Prepared shot revision');
    const payload = revision.payload && typeof revision.payload === 'object' ? revision.payload as Record<string, unknown> : {};
    const shotBindings = Array.isArray(payload.text_bindings) ? payload.text_bindings : [];
    for (const bindingValue of shotBindings) {
      const binding = asRecord(bindingValue, 'Prepared shot text binding');
      requireDeclared(binding.media_id, 'Prepared shot text binding');
    }
  }
}

/** Validate and prepare the archive before uploading any media, then commit its Runtime-prepared body. */
export async function importTimelineArchive(file: File, projectId: string, options: TransferOptions = {}): Promise<Record<string, unknown>> {
  const toastId = options.toast?.loading('Reading timeline archive…');
  try {
    const client = options.client ?? new AstridRuntimeClient();
    const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const entries = await readStoredZip(file);
    const manifest = await jsonEntry(entries, 'manifest.json');
    if (manifest.format !== 'astrid.timeline/1') {
      const version = /^astrid\.timeline\/(\d+)$/.exec(String(manifest.format))?.[1];
      if (version && Number(version) > 1) throw new Error('This timeline was made with a newer Astrid format. Update Astrid to open it.');
      throw new Error("This file isn't an Astrid timeline, or it's damaged.");
    }
    const { media, transcriptNames } = validateArchiveEntries(entries, manifest);
    const manifestEntry = entries.find((item) => item.name === 'manifest.json')!;
    const timelineEntry = entries.find((item) => item.name === 'timeline.json')!;
    await verifyStoredZipEntry(manifestEntry);
    await verifyStoredZipEntry(timelineEntry);
    for (const name of transcriptNames) await verifyStoredZipEntry(entries.find((item) => item.name === name)!);
    const timeline = await jsonEntry(entries, 'timeline.json');
    const transcripts: Array<Record<string, unknown>> = [];
    for (const name of transcriptNames) {
      const entry = entries.find((item) => item.name === name)!;
      const content = parseJson(await entry.blob.text(), entry.name);
      const identity = /^transcripts\/([0-9a-f]{64})\.([A-Za-z0-9_.%~-]+)\.json$/.exec(name)!;
      if (content.schema !== 'media.transcript/v1' || typeof content.media_id !== 'string' || mediaIdentity(content.media_id) !== identity[1]
        || typeof content.source_id !== 'string' || !content.source_id || safeTranscriptSource(content.source_id) !== identity[2]) {
        throw new Error(`Transcript ${name} does not match its media and source identity.`);
      }
      transcripts.push({ kind: 'media.transcript', content });
    }
    const payloadBlob = jsonBlob({ timeline, transcripts });
    if (payloadBlob.size > MAX_JSON_ENTRY) throw new Error('Import payload exceeds 64 MiB.');
    const elements = Array.isArray(manifest.elements) ? manifest.elements : [];
    const manifestText = JSON.stringify({ ...manifest, elements });
    const manifestBytes = encoder.encode(manifestText);
    if (manifestBytes.byteLength > MAX_JSON_ENTRY) throw new Error('Manifest metadata exceeds 64 MiB.');
    const checkManifest = manifestForCheck(manifest);
    const checkManifestBytes = encoder.encode(JSON.stringify(checkManifest));
    const checkInputs: Record<string, unknown> = { project: projectId, check_only: true };
    if (checkManifestBytes.byteLength <= INLINE_MANIFEST_LIMIT) checkInputs.manifest = checkManifest;
    else checkInputs.manifest_file = await uploadJson(client, projectId, new Blob([checkManifestBytes], { type: 'application/json' }), 'manifest-check.json');
    const check = await getActionJson(client, projectId, 'rendering.timeline_prepare_import', checkInputs, 'result', fetchImpl, options.client !== undefined);
    const missingEffects = effectNames(Array.isArray(check.value.missing_effects) ? check.value.missing_effects : []);
    const differentEffects = effectNames(Array.isArray(check.value.different_effects) ? check.value.different_effects : []);
    options.toast?.update(toastId, 'Checking media…');
    const managedDigests = new Set<string>();
    let objectsCursor: string | undefined;
    do {
      const page = await client.listProjectObjects(projectId, objectsCursor, 100);
      for (const object of page.items) {
        if (object.relation === 'managed') managedDigests.add(String(object.digest ?? object.object_id).replace(/^sha256:/, '').toLowerCase());
      }
      objectsCursor = page.next_cursor ?? undefined;
    } while (objectsCursor);
    const missing: Array<{ digest: string; size: number; filename: string; mediaType: string; blob: Blob }> = [];
    let totalUpload = 0;
    for (const [index, item] of media.entries()) {
      options.toast?.update(toastId, `Checking media ${index + 1} of ${media.length}…`);
      const digest = mediaDigest(item.sha256);
      const size = item.size as number;
      const entry = entries.find((candidate) => candidate.name === `media/${digest.slice(7)}`);
      if (!entry) throw new Error(`Archive is missing media/${digest.slice(7)}.`);
      await verifyStoredZipEntry(entry);
      if (!managedDigests.has(digest.slice(7))) {
        missing.push({ digest, size, filename: String(item.original_name ?? digest.slice(7)), mediaType: typeof item.media_type === 'string' ? item.media_type : 'application/octet-stream', blob: entry.blob });
        totalUpload += size;
      }
    }
    let uploadedBytes = 0;
    for (const item of missing) {
      options.toast?.update(toastId, `Uploading media: ${item.filename}`);
      await xhrUpload(projectId, item.digest, item.filename, item.mediaType, item.blob, options, uploadedBytes, totalUpload, toastId);
      uploadedBytes += item.size;
    }
    const actionInputs: Record<string, unknown> = { project: projectId, name: uniqueTimelineName(String(manifest.name ?? file.name.replace(/\.astrid$/i, '')), options.existingNames ?? []) };
    if (manifestBytes.byteLength <= INLINE_MANIFEST_LIMIT) actionInputs.manifest = JSON.parse(manifestText);
    else {
      const manifestObject = await uploadJson(client, projectId, new Blob([manifestBytes], { type: 'application/json' }), 'manifest.json');
      actionInputs.manifest_file = manifestObject;
    }
    const payloadObject = await uploadJson(client, projectId, payloadBlob, 'timeline-import-payload.json');
    actionInputs.payload = payloadObject;
    options.toast?.update(toastId, 'Preparing imported timeline…');
    const preparedAction = await getActionJson(client, projectId, 'rendering.timeline_prepare_import', actionInputs, 'prepared', fetchImpl, options.client !== undefined);
    validatePreparedMedia(preparedAction.value, media, transcripts);
    const inlineRequest = { ...preparedAction.value, source: { via: 'app' } };
    const preparedBytes = encoder.encode(JSON.stringify(preparedAction.value));
    if (preparedBytes.byteLength > MAX_JSON_ENTRY) throw new Error('Prepared timeline metadata exceeds 64 MiB.');
    let receipt: Record<string, unknown>;
    if (preparedBytes.byteLength <= INLINE_COMMIT_LIMIT) {
      const result = await client.importTimeline(projectId, inlineRequest, randomKey('timeline-import'));
      receipt = result;
    } else {
      const preparedObject = await uploadJson(client, projectId, new Blob([preparedBytes], { type: 'application/json' }), 'timeline-prepared-import.json');
      receipt = await client.importTimeline(projectId, { prepared_object_id: preparedObject, source: { via: 'app' } }, randomKey('timeline-import'));
    }
    const timelineId = typeof receipt.timeline_id === 'string' ? receipt.timeline_id : undefined;
    const mediaNames = new Map(media.map((item) => [String(item.sha256 ?? '').toLowerCase(), String(item.original_name ?? '')]));
    const mediaLabel = (id: unknown) => mediaNames.get(String(id ?? '').replace(/^sha256:/, '').toLowerCase()) || 'a media file';
    const conflicts = Array.isArray(receipt.transcript_conflicts) ? receipt.transcript_conflicts as Array<Record<string, unknown>> : [];
    const details = [
      ...missingEffects.map((effect) => `${effect} isn't installed here.`),
      ...(differentEffects.length ? [`Using this machine’s versions of ${differentEffects.join(', ')}.`] : []),
      ...conflicts.map((conflict) => `Transcript conflict for ${mediaLabel(conflict.media_id)}: kept the project version.`),
    ];
    const title = `Imported ${String(receipt.name ?? manifest.name ?? 'timeline')}`;
    const opened = timelineId && options.onImported ? await options.onImported(timelineId).catch(() => false) : true;
    const note = opened ? [] : ['Open it from the Timeline menu.'];
    if (details.length) options.toast?.warning(title, toastId, [...details, ...note].join(' '));
    else options.toast?.success(title, toastId, note.join(' ') || undefined);
    return { ...receipt, uploaded_media_count: missing.length, uploaded_media_bytes: uploadedBytes, ...(timelineId ? { timeline_id: timelineId } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.toast?.error(`Couldn't import ${file.name}`, toastId, message);
    throw error;
  }
}

export const timelineTransferLimits = { inlineManifest: INLINE_MANIFEST_LIMIT, inlineCommit: INLINE_COMMIT_LIMIT, fallbackArchive: MAX_FALLBACK_ARCHIVE } as const;

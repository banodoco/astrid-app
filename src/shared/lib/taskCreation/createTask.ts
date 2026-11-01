import type { AstridLocalClient } from '@/integrations/astrid/client.ts';
import type { TaskAdmissionReservation } from '@/integrations/astrid/taskRoutes.ts';
import { getBridgeTaskClient, mapBridgeTaskStatus } from '@/integrations/astrid/bridgeTaskReads';
import { BridgeTransportFailure } from '@/integrations/astrid/transport';
import {
  bridgeTaskAdmissionRequestSchema,
  runtimeSha256IdSchema,
  type RuntimeCapability,
} from '@/tools/video-editor/data/bridgeContract.ts';
import { normalizeAndPresentAndRethrow } from '@/shared/lib/errorHandling/runtimeError';
import { NetworkError } from '@/shared/lib/errorHandling/errors';
import { generateUUID } from './ids';
import { parseTaskCreationResponse } from './parseTaskCreationResponse';
import {
  TaskValidationError,
  type BaseTaskParams,
  type RuntimeInput,
  type RuntimeInputIngestOptions,
  type RuntimeObjectReceipt,
  type TaskCreationResult,
} from './types';
import { unsupportedLegacyTaskError } from './legacyBoundary';

const MAX_ATTEMPTS = 2;
export interface CreateTaskOptions {
  client?: Pick<AstridLocalClient, 'tasks' | 'catalog' | 'objects'>;
  reservation?: TaskAdmissionReservation;
  signal?: AbortSignal;
  /** Retained for existing producer-specific options. */
  [key: string]: unknown;
}

/**
 * Legacy producer envelope accepted only so residual callers fail at the
 * canonical boundary with a typed error.  It is never translated or sent to
 * Runtime; removing this overload is part of the later deletion receipt.
 */
interface LegacyTaskEnvelope {
  project_id: string;
  family: string;
  input: unknown;
}

function getNetworkDiagnostics(): Record<string, unknown> {
  const diag: Record<string, unknown> = {
    online: navigator.onLine,
  };
  const conn = (navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number; rtt?: number } }).connection;
  if (conn) {
    diag.effectiveType = conn.effectiveType;
    diag.downlink = conn.downlink;
    diag.rtt = conn.rtt;
  }
  return diag;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into an ArrayBuffer-backed view.  Browser TypeScript definitions
  // reject Uint8Array<ArrayBufferLike> as a BufferSource because the input
  // may be backed by SharedArrayBuffer; the copy also makes the hashed bytes
  // immutable for the duration of the digest call.
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', owned);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isInputBlob(input: RuntimeInput): input is Blob {
  return input instanceof Blob || (typeof input === 'object' && input !== null
    && 'arrayBuffer' in input && typeof input.arrayBuffer === 'function'
    && 'type' in input && typeof input.type === 'string');
}

async function inputBytes(input: RuntimeInput): Promise<{
  bytes: Uint8Array;
  mediaType: string | undefined;
  originalName: string | undefined;
}> {
  // Fetch and iframe Blobs may belong to another realm and fail instanceof.
  if (isInputBlob(input)) {
    return {
      bytes: new Uint8Array(await input.arrayBuffer()),
      mediaType: input.type || undefined,
      originalName: 'name' in input && typeof input.name === 'string' ? input.name : undefined,
    };
  }
  if (input instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(input), mediaType: undefined, originalName: undefined };
  }
  return { bytes: input, mediaType: undefined, originalName: undefined };
}

async function readResponseBlobBounded(response: Response, maxBytes?: number): Promise<Blob> {
  if (maxBytes === undefined) return await response.blob();
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxBytes) {
      throw new TaskValidationError(
        `Source media exceeds the ${maxBytes}-byte ingest boundary`,
        'sourceUrl',
      );
    }
  }
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > maxBytes) {
      throw new TaskValidationError(
        `Source media exceeds the ${maxBytes}-byte ingest boundary`,
        'sourceUrl',
      );
    }
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TaskValidationError(
          `Source media exceeds the ${maxBytes}-byte ingest boundary`,
          'sourceUrl',
        );
      }
      const owned = new Uint8Array(value.byteLength);
      owned.set(value);
      chunks.push(owned.buffer);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: response.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? '' });
}

async function validateImageBlob(blob: Blob, mediaType: string): Promise<void> {
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const isPng = header.length >= 8
    && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47
    && header[4] === 0x0d && header[5] === 0x0a && header[6] === 0x1a && header[7] === 0x0a;
  const isJpeg = header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const isGif = header.length >= 6
    && (String.fromCharCode(...header.slice(0, 6)) === 'GIF89a'
      || String.fromCharCode(...header.slice(0, 6)) === 'GIF87a');
  const isWebp = header.length >= 12
    && String.fromCharCode(...header.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...header.slice(8, 12)) === 'WEBP';
  const detected = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : isGif ? 'image/gif' : isWebp ? 'image/webp' : null;
  if (detected === null || detected !== mediaType.toLowerCase()) {
    throw new TaskValidationError('Source media bytes do not match a supported image media type', 'sourceUrl');
  }
}

/** Ingest producer-owned bytes into the project-scoped Runtime CAS. */
export async function ingestProjectInput(
  project: string,
  input: RuntimeInput,
  options: RuntimeInputIngestOptions = {},
): Promise<RuntimeObjectReceipt> {
  const source = await inputBytes(input);
  if (options.maxBytes !== undefined && source.bytes.byteLength > options.maxBytes) {
    throw new TaskValidationError(
      `Source media exceeds the ${options.maxBytes}-byte ingest boundary`,
      options.field ?? 'sourceUrl',
    );
  }
  const mediaType = options.mediaType ?? source.mediaType;
  if (mediaType === undefined || mediaType.length === 0) {
    throw new TaskValidationError('A media type is required for Runtime CAS ingest', 'mediaType');
  }
  const originalName = options.originalName ?? source.originalName;
  const contentFingerprint = await sha256Hex(source.bytes);
  const metadataFingerprint = await sha256Hex(
    new TextEncoder().encode(JSON.stringify([project, mediaType, originalName ?? ''])),
  );
  const key = [
    'astrid.cas',
    contentFingerprint,
    metadataFingerprint,
  ].join('.');
  const committed = await getBridgeTaskClient(project).objects.ingest(
    source.bytes,
    mediaType,
    key,
    originalName,
  );
  const expectedObjectId = `sha256:${contentFingerprint}`;
  if (committed.data.object_id !== expectedObjectId) {
    throw new TaskValidationError(
      'Runtime CAS returned an object ID that does not match the ingested bytes',
      'input_object_ids',
    );
  }
  return {
    object_id: committed.data.object_id,
    media_type: committed.data.media_type,
    size: committed.data.size,
    filename: committed.data.filename ?? originalName ?? 'source',
    receipt: committed.receipt,
  };
}

/** Fetch a producer-owned media locator, then commit its bytes to project CAS. */
export async function ingestProjectInputFromUrl(
  project: string,
  sourceUrl: string,
  options: RuntimeInputIngestOptions = {},
): Promise<RuntimeObjectReceipt> {
  if (!sourceUrl.trim()) {
    throw new TaskValidationError('A source media URL is required', 'sourceUrl');
  }
  let parsed: URL;
  try {
    parsed = new URL(
      sourceUrl,
      typeof window === 'undefined' ? 'http://astrid.invalid' : window.location.origin,
    );
  } catch {
    throw new TaskValidationError('Source media URL is malformed', 'sourceUrl');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TaskValidationError('Source media URL must use HTTP(S)', 'sourceUrl');
  }

  const response = await fetch(parsed.toString(), { redirect: 'error' });
  if (!response.ok) {
    throw new TaskValidationError(
      `Source media could not be fetched (${response.status})`,
      'sourceUrl',
    );
  }
  const responseType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  const blob = await readResponseBlobBounded(response, options.maxBytes);
  const { maxBytes: _maxBytes, requireImage, ...ingestOptions } = options;
  const mediaType = ingestOptions.mediaType ?? responseType ?? blob.type;
  if (requireImage) {
    if (!mediaType?.startsWith('image/')) {
      throw new TaskValidationError('Source media must be an image media type', 'sourceUrl');
    }
    await validateImageBlob(blob, mediaType);
  }
  let originalName = parsed.pathname.split('/').pop() || 'source';
  try {
    originalName = decodeURIComponent(originalName);
  } catch {
    throw new TaskValidationError('Source media URL has an invalid filename', 'sourceUrl');
  }
  originalName = options.originalName ?? originalName;
  return ingestProjectInput(project, blob, { ...ingestOptions, mediaType, originalName });
}

/** Verify that an existing Runtime CAS ID is authorized for this project. */
export async function verifyProjectInputObject(project: string, objectId: string, client: Pick<AstridLocalClient, 'objects'> = getBridgeTaskClient(project)): Promise<void> {
  if (!runtimeSha256IdSchema.safeParse(objectId).success) {
    throw new TaskValidationError('Input must be a Runtime sha256 object ID', 'input_object_ids');
  }
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  while (true) {
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new TaskValidationError('Project object catalog cursor cycle detected', 'input_object_ids');
      }
      seenCursors.add(cursor);
    }
    const page = await client.objects.list({ cursor });
    if (page.items.some((object) => object.object_id === objectId)) return;
    if (page.next_cursor === null) break;
    cursor = page.next_cursor;
  }
  throw new TaskValidationError(`Input object is not authorized for project: ${objectId}`, 'input_object_ids');
}

/** Bind a capability ID to Runtime's exact ready definition digest. */
export async function bindTaskCapability(project: string, capabilityId: string, expectedDigest?: string): Promise<string> {
  return await getBridgeTaskClient(project).catalog.bind(capabilityId, expectedDigest);
}

/** Resolve the exact ready catalog record used to compile a typed producer request. */
export async function resolveTaskCapability(project: string, capabilityId: string): Promise<RuntimeCapability> {
  return await getBridgeTaskClient(project).catalog.get(capabilityId);
}

async function validateAdmissionAuthority(taskParams: BaseTaskParams, client?: CreateTaskOptions['client']): Promise<BaseTaskParams> {
  const parsed = bridgeTaskAdmissionRequestSchema.safeParse(taskParams);
  if (!parsed.success) {
    throw new TaskValidationError('Task admission body is not a canonical HC-04 request');
  }
  const boundDigest = client ? await client.catalog.bind(parsed.data.capability_id, parsed.data.capability_digest)
    : await bindTaskCapability(
      parsed.data.project,
      parsed.data.capability_id,
      parsed.data.capability_digest,
    );
  if (boundDigest !== parsed.data.capability_digest) {
    throw new TaskValidationError('Capability digest does not match Runtime catalog', 'capability_digest');
  }
  for (const objectId of parsed.data.input_object_ids) {
    await verifyProjectInputObject(parsed.data.project, objectId, client);
  }
  return parsed.data;
}


/**
 * Creates a task through the canonical HC-04 Runtime admission route
 * (`POST /projects/:slug/tasks`, Idempotency-Key header).
 * Retries once on transport failure since admission is receipted: replaying
 * the same key either dedups or 409s, never double-admits.
 */
export function createTask(
  taskParams: LegacyTaskEnvelope,
  options?: CreateTaskOptions,
): Promise<never>;
export function createTask(
  taskParams: BaseTaskParams,
  options?: CreateTaskOptions,
): Promise<TaskCreationResult>;
export async function createTask(
  taskParams: BaseTaskParams | LegacyTaskEnvelope,
  options?: CreateTaskOptions,
): Promise<TaskCreationResult> {
  if ('project_id' in taskParams) {
    throw unsupportedLegacyTaskError(taskParams.family);
  }
  const validatedTaskParams = await validateAdmissionAuthority(taskParams, options?.client);
  const startTime = Date.now();
  const requestId = `${startTime}-${Math.random().toString(36).slice(2, 8)}`;
  const requestContext = {
    requestId,
    taskType: validatedTaskParams.spec.family,
    projectId: validatedTaskParams.project,
  };

  // Idempotency key stays the same across retries so the bridge
  // deduplicates if the first attempt actually landed.
  const idempotency_key = options?.reservation?.key ?? generateUUID();

  const client = options?.client ?? getBridgeTaskClient(validatedTaskParams.project);

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = options?.reservation
        ? await client.tasks.admit(validatedTaskParams, idempotency_key, options.reservation)
        : await client.tasks.admit(validatedTaskParams, idempotency_key);

      const result = parseTaskCreationResponse(
        {
          task_id: response.task.id,
          status: mapBridgeTaskStatus(response.task.status),
        },
        requestContext,
      );
      // The requester may observe the durable reservation before this
      // invocation reaches the POST. Wake it only after the managed admission
      // has completed successfully, when admitted() has saved the locator.
      await options?.reservation?.settled?.();
      return result;
    } catch (err: unknown) {
      lastError = err;
      const durationMs = Date.now() - startTime;
      const isTimeout = err instanceof BridgeTransportFailure;

      if (isTimeout && attempt < MAX_ATTEMPTS) {
        console.error('[createTask] attempt %d/%d failed after %dms, retrying', attempt, MAX_ATTEMPTS, durationMs, {
          ...requestContext,
          network: getNetworkDiagnostics(),
        });
        continue;
      }

      const context = {
        ...requestContext,
        attempt,
        durationMs,
        network: getNetworkDiagnostics(),
        errorType: err instanceof Error ? err.name : typeof err,
        errorMessage: err instanceof Error ? err.message : String(err),
      };

      console.error('[createTask] FAILED after %d attempt(s), %dms', attempt, durationMs, context);

      if (isTimeout) {
        throw new NetworkError('Task creation timed out. Please try again.', {
          isTimeout: true,
          context,
          cause: err instanceof Error ? err : undefined,
        });
      }

      normalizeAndPresentAndRethrow(err, {
        context: 'TaskCreation',
        showToast: false,
        logData: context,
      });
    }
  }

  // Unreachable, but TypeScript needs it
  throw lastError;
}

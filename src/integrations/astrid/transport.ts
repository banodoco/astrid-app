/**
 * Shared bridge transport — the one fetch pipeline for every JSON exchange
 * with `astrid serve`.
 *
 * Consumed by `AstridLocalClient` (timelines/tasks/generations/media). It owns exactly three
 * concerns and nothing more:
 *
 * 1. **Timeout** — requests default to `BRIDGE_REQUEST_TIMEOUT_MS`;
 *    ACP prompt completion explicitly opts out while retaining caller aborts.
 * 2. **Envelope parsing** — non-2xx responses parse against the shared
 *    `bridgeErrorEnvelopeSchema` and surface as a {@link BridgeRouteError}
 *    carrying the raw wire code plus its public category; success
 *    payloads validate through the caller's zod schema (never coerced).
 * 3. **Per-boot token posture** — the per-boot request
 *    token (`X-Astrid-Request-Token`) is injected by the dev-server proxy /
 *    static middleware on the SERVER side. This module deliberately has no
 *    token code path: browser code never reads, stores, or sends the token,
 *    and requests stay same-origin relative paths so the proxy sees them.
 */

import {
  BRIDGE_REQUEST_TIMEOUT_MS,
  bridgeErrorEnvelopeSchema,
} from '@/tools/video-editor/data/bridgeContract.ts';
import {
  BridgeContractError,
  parseBridgePayload,
  type BridgeErrorCategory,
} from '@/tools/video-editor/data/bridgeContract.ts';
import type { z } from 'zod';
import { astridBase } from '@/integrations/runtime/connection.ts';

/**
 * A failed bridge route: HTTP status, the raw wire error code, and its
 * public category. Timeline codes
 * (`timeline_version_conflict`, …) keep their exact code so existing
 * reload-and-retry ladders keep working; only the category is derived.
 */
export class BridgeRouteError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly category: BridgeErrorCategory | 'unknown';
  readonly detail: string | undefined;
  /** The Runtime's own next step (`details.next_action`), when it names one. */
  readonly nextAction: string | undefined;
  readonly envelope: z.infer<typeof bridgeErrorEnvelopeSchema> | null;

  constructor(
    action: string,
    status: number,
    envelope: z.infer<typeof bridgeErrorEnvelopeSchema> | null,
  ) {
    const nextAction = envelope?.next_action?.trim() || readNextAction(envelope);
    const reason = envelope?.detail ?? `${status} ${reasonPhrase(status)}`;
    const description = nextAction ? `${reason} Next: ${nextAction}` : reason;
    super(`Astrid bridge ${action} failed: ${description}`);
    this.name = 'BridgeRouteError';
    this.status = status;
    this.code = envelope?.error;
    this.detail = envelope?.detail;
    this.nextAction = nextAction;
    this.envelope = envelope;
    this.category = classifyRouteError(status, this.code);
  }
}

/** The Runtime's `details.next_action` string, trimmed; `undefined` when absent or blank. */
function readNextAction(envelope: z.infer<typeof bridgeErrorEnvelopeSchema> | null): string | undefined {
  const details: unknown = envelope?.details;
  if (typeof details !== 'object' || details === null) return undefined;
  const next: unknown = (details as { next_action?: unknown }).next_action;
  if (typeof next !== 'string') return undefined;
  return next.trim() || undefined;
}

/** Network failure, timeout, or an unparseable body — never a route answer. */
export class BridgeTransportFailure extends Error {
  constructor(readonly cause: unknown) {
    super(
      cause instanceof Error && cause.name === 'TimeoutError'
        ? 'Astrid bridge request timed out'
        : `Astrid bridge is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'BridgeTransportFailure';
  }
}

/**
 * The Runtime door's answer to every chat route while no chat service is running on this computer
 * (astrid-runtime `runtime_protocol/door.py`: 503 `{"error": "acp_unavailable"}`).
 */
export const ACP_UNAVAILABLE_CODE = 'acp_unavailable';

/** Quiet pauses between retries of one idempotent request; a longer outage surfaces. */
export const BRIDGE_READ_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;

/**
 * A request that never reached the service, or whose upstream hung up (the proxy's 502/503/504),
 * says nothing about the route itself. `acp_unavailable` is a real "no chat service" state, not a blip.
 */
export function isTransientBridgeFailure(error: unknown): boolean {
  if (error instanceof BridgeTransportFailure) return true;
  return error instanceof BridgeRouteError
    && (error.status === 502 || error.status === 503 || error.status === 504)
    && error.code !== ACP_UNAVAILABLE_CODE;
}

/** Resolve after `ms`, or reject at once when `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Host-owned, privacy-bounded observation of one actual bridge request. */
export type AstridBridgeRequestObservation = Readonly<{
  outcome: 'success' | 'failure';
  durationMs: number;
  errorClass?: 'bridge.timeout' | 'bridge.http_error' | 'bridge.invalid_response';
}>;

function reasonPhrase(status: number): string {
  // Deliberately tiny: only statuses the routes actually answer with.
  switch (status) {
    case 400: return 'Bad Request';
    case 403: return 'Forbidden';
    case 404: return 'Not Found';
    case 409: return 'Conflict';
    case 413: return 'Payload Too Large';
    case 422: return 'Unprocessable Entity';
    default: return 'Error';
  }
}

/**
 * Map (status, wire code) → public category. Exact codes win; otherwise
 * the HTTP status classifies. Anything unmapped stays `unknown` rather than
 * being silently relabeled into a wrong recovery path.
 */
export function classifyRouteError(status: number, code: string | undefined): BridgeErrorCategory | 'unknown' {
  if (
    code === 'invalid_body'
    || code === 'not_found'
    || code === 'conflict'
    || code === 'capability_unavailable'
    || code === 'payload_too_large'
  ) {
    return code;
  }
  // The Runtime's 422 is a request-validation failure (`validation_error`), not an unavailable capability.
  if (code === 'validation_error') return 'invalid_body';
  // The Runtime's CapabilityUnavailableError is HTTP 409 with code `unavailable`: a
  // capability that is not ready, not a stale version, so it must not read as a conflict.
  if (code === 'unavailable') return 'capability_unavailable';
  if (status === 400 || status === 413) return 'invalid_body';
  if (status === 404) return 'not_found';
  if (status === 403 || status === 409) return 'conflict';
  if (status === 422) return 'capability_unavailable';
  return 'unknown';
}

export type AstridBridgeTransportOptions = {
  /** Base for the bridge routes. Default: `astridBase()`, read per request. */
  baseUrl?: string;
  timeoutMs?: number;
};

export type BridgeRequestInit =
  | {
      method?: 'GET' | 'POST' | 'PATCH' | 'HEAD' | 'DELETE';
      /** JSON body — serialized here so every caller gets identical encoding. */
      body?: unknown;
      /** Raw bodies are mutually exclusive with JSON bodies. */
      rawBody?: never;
      headers?: Record<string, string>;
      /** Extra abort signal combined with the transport deadline. */
      signal?: AbortSignal;
      /** Override the request deadline; null waits for completion or caller abort. */
      timeoutMs?: number | null;
      /** Let the request outlive the page (best-effort close on pagehide). */
      keepalive?: boolean;
    }
  | {
      method?: 'GET' | 'POST' | 'PATCH' | 'HEAD' | 'DELETE';
      body?: never;
      /** Explicit byte/body mode; the caller owns Content-Type. */
      rawBody: BodyInit;
      headers?: Record<string, string>;
      /** Extra abort signal combined with the transport deadline. */
      signal?: AbortSignal;
      /** Override the request deadline; null waits for completion or caller abort. */
      timeoutMs?: number | null;
      /** Let the request outlive the page (best-effort close on pagehide). */
      keepalive?: boolean;
    };

export type BridgeJsonRequestInit = Exclude<BridgeRequestInit, { rawBody: BodyInit }>;
export type BridgeRawRequestInit = Extract<BridgeRequestInit, { rawBody: BodyInit }>;

function assertRequestBodyMode(request: BridgeRequestInit): void {
  if (request.body !== undefined && request.rawBody !== undefined) {
    throw new TypeError('bridge requests cannot specify both body and rawBody');
  }
}

export class AstridBridgeTransport {
  private readonly explicitBaseUrl: string | undefined;

  private readonly timeoutMs: number;

  constructor(options: AstridBridgeTransportOptions = {}) {
    this.explicitBaseUrl = options.baseUrl?.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? BRIDGE_REQUEST_TIMEOUT_MS;
  }

  /** Read per request, so a transport built before the origin is set still reaches the configured one. */
  get baseUrl(): string {
    return (this.explicitBaseUrl ?? astridBase()).replace(/\/+$/, '');
  }

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /**
   * Fetch one JSON route, validate the response body against `schema`, and
   * hand back the caller's own value (validate-don't-rewrite — see
   * `parseBridgePayload`). Non-2xx → {@link BridgeRouteError}; network or
   * deadline failures → {@link BridgeTransportFailure}; malformed 2xx bodies
   * → {@link BridgeContractError}.
   */
  async requestJson<Schema extends z.ZodType>(
    path: string,
    request: BridgeRequestInit,
    schema: Schema,
    what: string,
  ): Promise<z.infer<Schema>> {
    const response = await this.requestWithReadRetry(path, request, what);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new BridgeContractError(
        what,
        `response body is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }
    return parseBridgePayload(schema, payload, what);
  }

  /**
   * GET/HEAD are idempotent: ride out a transient failure quietly (same delays everywhere) and
   * throw the original error once the delays are spent. Writes are never retried; an abort stops at once.
   */
  private async requestWithReadRetry(path: string, request: BridgeRequestInit, what: string): Promise<Response> {
    const method = request.method ?? 'GET';
    const idempotent = method === 'GET' || method === 'HEAD';
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.requestRaw(path, request);
        if (!response.ok) {
          throw new BridgeRouteError(what, response.status, await parseErrorEnvelope(response));
        }
        return response;
      } catch (error) {
        const delay = BRIDGE_READ_RETRY_DELAYS_MS[attempt];
        if (!idempotent || delay === undefined || request.signal?.aborted || !isTransientBridgeFailure(error)) throw error;
        try {
          await pause(delay, request.signal);
        } catch {
          throw error;
        }
      }
    }
  }

  /**
   * Fetch one route without parsing a JSON body (byte routes such as media
   * content, or callers that only need the status).
   */
  async requestRaw(path: string, request: BridgeRequestInit = {}): Promise<Response> {
    assertRequestBodyMode(request);
    const headers: Record<string, string> = { ...request.headers };
    let body: BodyInit | undefined;
    if (request.rawBody !== undefined) {
      body = request.rawBody;
    } else if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(request.body);
    }
    try {
      return await fetch(this.url(path), {
        method: request.method ?? 'GET',
        headers,
        body,
        keepalive: request.keepalive,
        signal: composeSignals(request.timeoutMs === undefined ? this.timeoutMs : request.timeoutMs, request.signal),
      });
    } catch (cause) {
      throw new BridgeTransportFailure(cause);
    }
  }
}

function composeSignals(timeoutMs: number | null, extra: AbortSignal | undefined): AbortSignal | undefined {
  if (timeoutMs === null) return extra;
  const deadline = AbortSignal.timeout(timeoutMs);
  return extra ? AbortSignal.any([deadline, extra]) : deadline;
}

/**
 * The Runtime daemon answers `{code, message, details?, request_id}` (recorded
 * from a real daemon: `src/integrations/runtime/fixtures/responses`), an older
 * Runtime wrapped that as `{error: {code, message, details, request_id}}`, and
 * bridge routes send `{error: <code>, detail: <message>}`. Flatten the Runtime
 * shapes (keeping `details`) so all reach callers the same way.
 */
function normalizeRuntimeErrorBody(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const flat = body as { error?: unknown; code?: unknown; message?: unknown; details?: unknown };
  if (flat.error === undefined && typeof flat.code === 'string') {
    return {
      error: flat.code,
      detail: typeof flat.message === 'string' ? flat.message : undefined,
      ...(flat.details !== undefined ? { details: flat.details } : {}),
    };
  }
  const error = flat.error;
  if (typeof error !== 'object' || error === null) return body;
  const { code, message, details } = error as { code?: unknown; message?: unknown; details?: unknown };
  return {
    error: typeof code === 'string' ? code : undefined,
    detail: typeof message === 'string' ? message : undefined,
    ...(details !== undefined ? { details } : {}),
  };
}

async function parseErrorEnvelope(response: Response): Promise<z.infer<typeof bridgeErrorEnvelopeSchema> | null> {
  try {
    const body: unknown = await response.json();
    const parsed = bridgeErrorEnvelopeSchema.safeParse(normalizeRuntimeErrorBody(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

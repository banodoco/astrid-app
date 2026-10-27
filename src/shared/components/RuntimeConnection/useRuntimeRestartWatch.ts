import { useEffect, useRef, useState } from 'react';
import { runtimeApiBase } from '@/integrations/runtime/connection.ts';
import { scheduleFocusAndInterval } from '@/shared/lib/updates/appBuildWatch.ts';

/**
 * Notices, while connected, that Astrid stopped, restarted or changed.
 *
 * The client fences a restarted Runtime only when a request reaches it, and a connected page that is reading
 * nothing would never make one. So this asks the health route on an interval and on focus: the instance id seen
 * at the first answer is the baseline, and a different id is a restart. The door's 503 `runtime_identity_mismatch` (its
 * credential now names another identity) is Astrid changed under the page. Both are sticky: once seen, the page keeps its
 * drafts and waits for Reload.
 *
 * Two readings in a row that fail are `stopped`, or `refused` when a `no-cors` request to the same URL still gets an answer
 * (Astrid is up but no longer serves this page; a closed port fails both). Before a network failure is blamed on Astrid
 * the permission is asked again (`confirmPermission`): Chrome does not always fire `onchange` on a reset, and without the
 * permission the page learns nothing about Astrid. A failed reading is a network error (nothing is there, or it refuses us), a 503 that is not an identity change (the Runtime's door answers but the Runtime is not ready), or any
 * other answer that is not ok. A reading that times out is different: the port took the request and did not answer in
 * time, which is a loaded machine, not a missing Astrid. It never counts toward `stopped`; two in a row are `busy`, a
 * calm card that Astrid is still running. A slow reading also ends a streak of failures, and a failure ends a streak of
 * slow readings: each streak counts only readings that agree. Neither state is sticky: a reading with the same
 * instance clears it, and a new instance is a restart. A slow reading while `stopped` is `busy` at once, since the
 * port is answering again. An ok answer that names no instance is not a restart and changes nothing.
 */

export type RuntimeRestartStatus = 'ok' | 'busy' | 'stopped' | 'refused' | 'restarted' | 'realm_changed';

const RESTART_CHECK_INTERVAL_MS = 3000;

/** Failed readings in a row before the page says Astrid stopped: one dropped request is not a stop. */
const FAILURES_BEFORE_STOPPED = 2;
/** Slow readings in a row before the page says Astrid is busy. */
const SLOW_BEFORE_BUSY = 2;
/** A health request that has not answered by now counts as a slow reading. */
const HEALTH_TIMEOUT_MS = 3000;

type HealthReading =
  | { kind: 'instance'; instanceId: string }
  | { kind: 'realm_changed' }
  | { kind: 'unreachable' }
  /** A network failure of the CORS read: nothing listening, or an answer this page may not read. */
  | { kind: 'network' }
  | { kind: 'refused' }
  | { kind: 'slow' }
  | { kind: 'unknown' };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function readHealth(fetchImpl: FetchLike): Promise<HealthReading> {
  let response: Response;
  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, HEALTH_TIMEOUT_MS);
  try {
    response = await fetchImpl(`${runtimeApiBase()}/v1/health`, { cache: 'no-store', signal: controller.signal });
  } catch {
    // Only our own abort timer makes this slow; a rejected fetch with no timeout is a refused or unreachable port.
    return timedOut ? { kind: 'slow' } : { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 503) {
    const body = await readJson(response);
    const code = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    // A door that answers 503 because the Runtime is not ready is as stopped as one that does not answer at all.
    return code === 'runtime_identity_mismatch' ? { kind: 'realm_changed' } : { kind: 'unreachable' };
  }
  if (!response.ok) return { kind: 'unreachable' };
  const body = await readJson(response);
  const instanceId = typeof body === 'object' && body !== null ? (body as { runtime_instance_id?: unknown }).runtime_instance_id : undefined;
  return typeof instanceId === 'string' && instanceId ? { kind: 'instance', instanceId } : { kind: 'unknown' };
}

/** After a network failure: does anything answer a `no-cors` request to the same URL? Resolves opaque if so. */
async function answersWithoutCors(fetchImpl: FetchLike): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    await fetchImpl(`${runtimeApiBase()}/v1/health`, { cache: 'no-store', mode: 'no-cors', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Module-level so the effect's dependency is stable across renders; an inline default would re-run the effect every render.
const browserFetch: FetchLike = (input, init) => fetch(input, init);

export function useRuntimeRestartWatch(
  enabled: boolean,
  { intervalMs = RESTART_CHECK_INTERVAL_MS, fetchImpl = browserFetch, confirmPermission }: { intervalMs?: number; fetchImpl?: FetchLike; confirmPermission?: () => Promise<boolean> } = {},
): RuntimeRestartStatus {
  const [status, setStatus] = useState<RuntimeRestartStatus>('ok');
  // A ref, not an effect-local: a re-run of the effect must not forget the instance the page connected to.
  const baselineRef = useRef<string | null>(null);
  const settled = status === 'restarted' || status === 'realm_changed';

  useEffect(() => {
    if (!enabled || settled) return undefined;
    let stopped = false;
    let inFlight = false;
    let failures = 0;
    let slows = 0;
    const check = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        let reading = await readHealth(fetchImpl);
        if (stopped) return;
        if (reading.kind === 'network') {
          // The permission comes first: without it nothing here says anything about Astrid (the provider drops the
          // connection when it sees the loss, and the page goes to the connection step).
          if (confirmPermission && !(await confirmPermission())) {
            failures = 0;
            slows = 0;
            return;
          }
          if (stopped) return;
          reading = (await answersWithoutCors(fetchImpl)) ? { kind: 'refused' } : { kind: 'unreachable' };
          if (stopped) return;
        }
        if (reading.kind === 'unreachable' || reading.kind === 'refused') {
          failures += 1;
          slows = 0;
          const failed: RuntimeRestartStatus = reading.kind === 'refused' ? 'refused' : 'stopped';
          if (failures >= FAILURES_BEFORE_STOPPED) setStatus((current) => (current === 'ok' || current === 'busy' || current === 'stopped' || current === 'refused' ? failed : current));
          return;
        }
        if (reading.kind === 'slow') {
          slows += 1;
          failures = 0;
          setStatus((current) => {
            if (current === 'stopped' || current === 'refused') return 'busy';
            return current === 'ok' && slows >= SLOW_BEFORE_BUSY ? 'busy' : current;
          });
          return;
        }
        failures = 0;
        slows = 0;
        if (reading.kind === 'realm_changed') {
          setStatus('realm_changed');
        } else if (reading.kind === 'instance') {
          if (baselineRef.current === null) baselineRef.current = reading.instanceId;
          if (reading.instanceId !== baselineRef.current) setStatus('restarted');
          else setStatus((current) => (current === 'stopped' || current === 'refused' || current === 'busy' ? 'ok' : current));
        }
      } finally {
        inFlight = false;
      }
    };
    void check();
    const unschedule = scheduleFocusAndInterval(() => { void check(); }, intervalMs);
    return () => {
      stopped = true;
      unschedule();
    };
  }, [enabled, settled, intervalMs, fetchImpl, confirmPermission]);

  return status;
}

/**
 * Runs `onAnswers` whenever Astrid starts answering the health route after this hook saw it not answering, and never
 * again while it keeps answering. The first reading is only the baseline: a caller mounted because a load failed while
 * Astrid was answering must not retry at once, or retry, fail and remount would loop. A thing that failed to load because
 * Astrid was not there uses it to try again by itself, as the connection panel opens by itself.
 */
export function useOnAstridAnswers(
  onAnswers: () => void,
  { intervalMs = RESTART_CHECK_INTERVAL_MS, fetchImpl = browserFetch }: { intervalMs?: number; fetchImpl?: FetchLike } = {},
): void {
  const latest = useRef(onAnswers);
  useEffect(() => {
    latest.current = onAnswers;
  });
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    /** Null until the first reading, which only sets the baseline. */
    let answering: boolean | null = null;
    const check = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const reading = await readHealth(fetchImpl);
        if (disposed) return;
        // A slow reading says nothing new about whether Astrid answers: the port is there, the answer is late.
        if (reading.kind === 'slow') return;
        // A `network` failure is not answering (nothing is known beyond that).
        const nowAnswering = reading.kind === 'instance' || reading.kind === 'unknown';
        const started = nowAnswering && answering === false;
        answering = nowAnswering;
        if (started) latest.current();
      } finally {
        inFlight = false;
      }
    };
    void check();
    const unschedule = scheduleFocusAndInterval(() => { void check(); }, intervalMs);
    return () => {
      disposed = true;
      unschedule();
    };
  }, [intervalMs, fetchImpl]);
}

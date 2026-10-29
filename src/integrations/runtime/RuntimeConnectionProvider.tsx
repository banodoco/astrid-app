/**
 * The boot gate for the hosted build (Plan A, D3).
 *
 * On the hosted build the page and the Runtime are on different origins (`runtimeOrigin()` is the loopback
 * gateway), so the page must find out whether it can reach the Runtime before anything reads it:
 *
 *   permission (`local-network-access`) -> probe (`GET <runtime base>/v1/health`, then `/v1/realm`) -> queries
 *
 * - `granted`: probe at once, then re-check every few seconds and on focus until connected.
 * - `prompt`: show `needs_permission` and send nothing. `connect()` probes without a timeout, which is what makes
 *   Chrome ask. Re-checking stays off until the browser reports `granted` (the permission's `onchange`).
 * - `denied`: `blocked`, nothing sent.
 *
 * Two unanswered readings with permission granted show install/start help, or, when a `no-cors` follow-up shows
 * something did answer, the `refused` card (Astrid is running but won't serve this page). Slow probes count as unanswered
 * readings, with one follow-up bounded to 60 seconds. Background probes leave the current panel in place.
 * Phones and unsupported browsers never query permission or probe. Once connected the
 * state is sticky: a Runtime that stops later shows a recovery card, keeping the editor and its unsaved work mounted.
 *
 * The first connection also marks this browser as one that chose the app (`rememberAppEntryPreference`), so the next
 * visit to the bare domain skips the landing page. The default app gate is hosted-only; welcome can also opt into a
 * same-origin reachability gate.
 *
 * Same-origin builds (no `VITE_RUNTIME_ORIGIN`: local dev, Plan B's relay) are not gated by default. The welcome
 * handoff opts into a reachability gate through the same-origin server proxy, without querying local-network permission.
 *
 * The panel and pill are render props with a placeholder default each, so the real ones are plugged in here and
 * `Layout.tsx` is not edited again.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { RuntimeGateOpenProvider } from './runtimeGateOpen';
import { requireContextValue } from '@/shared/contexts/contextGuard';
import { rememberAppEntryPreference } from '@/app/entryClassification';
import { detectInstallScenario } from '@/pages/Home/installScenario.ts';
import {
  queryLocalNetworkPermission,
  requiresLocalNetworkPermission as needsLocalNetworkPermission,
  watchLocalNetworkPermission,
  type LocalNetworkPermissionState,
  type PermissionsLike,
} from './localNetworkPermission.ts';
import {
  runtimeApiBase,
  runtimeOrigin,
  type RuntimeConnectionState,
} from './connection.ts';
import { autoConnectRequested, consumeAutoConnectQuery, takeAutoConnectRequest } from './autoConnectRequest.ts';
import type { Realm } from './generated.ts';
import { RUNTIME_ACCEPTED_SCHEMA_DIGESTS } from './contract-metadata.ts';
import { getSettingsStore } from '@/shared/settings/instance';

export const POLL_INTERVAL_MS = 3000;
export const PROBE_TIMEOUT_MS = 5000;
export const SLOW_PROBE_TIMEOUT_MS = 60_000;
const CONNECTED_BEFORE_KEY = 'astrid.runtime.connectedBefore';
const PINOKIO_MANAGED_KEY = 'astrid.runtime.managedByPinokio';
/** The `error` codes of the Runtime door's refusals (astrid-runtime runtime_protocol/door.py): the only error bodies the page reads as the door's. */
export type RuntimeRefusalCode = 'runtime_unavailable' | 'runtime_identity_mismatch';
const GATEWAY_REFUSAL_OUTCOMES: Readonly<Record<RuntimeRefusalCode, 'down' | 'restart'>> = Object.freeze({
  runtime_unavailable: 'down',
  runtime_identity_mismatch: 'restart',
});

type RealmSummary = Pick<Realm, 'realm_id' | 'display_name'>;

export type RuntimeProbeOutcome =
  | { kind: 'connected'; realm: RealmSummary; schemaDigest: string | null; managedByPinokio: boolean }
  | { kind: 'restart' }
  | { kind: 'update_needed'; managedByPinokio: boolean; authenticated: boolean }
  | { kind: 'down' }
  /** Something answered the CORS-less follow-up probe, but this page may not read it: Astrid is up and refuses this origin. */
  | { kind: 'refused' }
  | { kind: 'silent' }
  | { kind: 'slow' };

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** After a CORS failure: `refused` if a `no-cors` request to the same URL still gets an (opaque) answer, else `silent`. */
async function answeredWithoutCors(url: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<'refused' | 'silent' | 'slow'> {
  try {
    await fetchImpl(url, { signal, cache: 'no-store', mode: 'no-cors' });
    return 'refused';
  } catch {
    return signal?.aborted && signal.reason?.name === 'TimeoutError' ? 'slow' : 'silent';
  }
}

/**
 * Asks the Runtime who it is, the way the gateway does: health, then realm. Never throws. Only documented
 * refusals at their refusal statuses count; unrelated servers and malformed responses are `silent`. A timeout
 * owned by the caller is `slow`.
 */
export async function probeRuntime(
  signal?: AbortSignal,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  /** Asked when the CORS read fails: false (the default) sends nothing more. Only true while permission is granted or not required. */
  mayProbeRefusal: () => boolean = () => false,
): Promise<RuntimeProbeOutcome> {
  const base = runtimeApiBase();
  const get = async (path: string, detectRefusal = false): Promise<RuntimeProbeOutcome | { body: unknown }> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, { signal, cache: 'no-store' });
    } catch {
      if (signal?.aborted) return { kind: signal.reason?.name === 'TimeoutError' ? 'slow' : 'silent' };
      // A refusal (the door's 403 for an origin it does not serve) carries no CORS headers, so it fails here exactly like
      // a closed port. A `no-cors` request to the same URL settles it: it resolves (opaque) if anything answered, and
      // fails only when nothing is listening. Only sent while permission is granted (or not required): a request held behind
      // or denied by Chrome's local-network prompt says nothing about what is listening.
      return { kind: detectRefusal && mayProbeRefusal() ? await answeredWithoutCors(`${base}${path}`, fetchImpl, signal) : 'silent' };
    }
    const body = await readJson(response);
    if (signal?.aborted && signal.reason?.name === 'TimeoutError') return { kind: 'slow' };
    if ((response.status === 502 || response.status === 503) && typeof body === 'object' && body !== null && 'error' in body) {
      const kind = typeof body.error === 'string' && Object.prototype.hasOwnProperty.call(GATEWAY_REFUSAL_OUTCOMES, body.error)
        ? GATEWAY_REFUSAL_OUTCOMES[body.error as RuntimeRefusalCode]
        : undefined;
      if (kind) return { kind };
    }
    if (response.status !== 200) return { kind: 'silent' };
    return { body };
  };

  const health = await get('/v1/health', true);
  if ('kind' in health) return health;
  if (typeof health.body !== 'object' || health.body === null || typeof (health.body as { status?: unknown }).status !== 'string') {
    return { kind: 'silent' };
  }
  const install = (health.body as { install?: unknown }).install;
  const managedBy = typeof install === 'object' && install !== null ? (install as { managed_by?: unknown }).managed_by : undefined;
  const managedByPinokio = managedBy === 'pinokio';
  const schemaDigest = (health.body as { schema_digest?: unknown }).schema_digest;
  if (typeof schemaDigest !== 'string' || !RUNTIME_ACCEPTED_SCHEMA_DIGESTS.includes(schemaDigest as typeof RUNTIME_ACCEPTED_SCHEMA_DIGESTS[number])) {
    return { kind: 'update_needed', managedByPinokio, authenticated: typeof schemaDigest === 'string' };
  }
  const realm = await get('/v1/realm');
  if ('kind' in realm) return realm;
  const { realm_id, display_name } = (realm.body ?? {}) as Partial<RealmSummary>;
  if (typeof realm_id !== 'string' || typeof display_name !== 'string') return { kind: 'silent' };
  return { kind: 'connected', realm: { realm_id, display_name }, schemaDigest, managedByPinokio };
}

function readPinokioManaged(): boolean | null {
  try {
    const value = window.localStorage.getItem(PINOKIO_MANAGED_KEY);
    return value === '1' ? true : value === '0' ? false : null;
  } catch { return null; }
}

function rememberPinokioManaged(value: boolean | null): void {
  if (value === null) return;
  try { window.localStorage.setItem(PINOKIO_MANAGED_KEY, value ? '1' : '0'); } catch { /* Storage can be unavailable. */ }
}

function readConnectedBefore(): boolean {
  try {
    return window.localStorage.getItem(CONNECTED_BEFORE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeConnectedBefore(): void {
  try {
    window.localStorage.setItem(CONNECTED_BEFORE_KEY, '1');
  } catch {
    // Private window or blocked storage: the panel just keeps its first-time wording.
  }
}

export interface RuntimeConnectionValue {
  /** True when the app waits for a confirmed Runtime connection before mounting its children. */
  gated: boolean;
  state: RuntimeConnectionState | { status: 'restart' } | { status: 'browser_update_needed' };
  isConnected: boolean;
  /** Authenticated health can be readable even when workspace schema negotiation is incompatible. */
  isAuthenticated: boolean;
  /** This browser has reached Astrid before, so missing-work guidance can distinguish a return visit from first setup. */
  connectedBefore: boolean;
  /** Last known installer provenance for this browser; null when unknown or storage is unavailable. */
  managedByPinokio: boolean | null;
  /** The permission or the first probe is still pending: nothing can be shown yet, so the app renders nothing. */
  isBooting: boolean;
  /** An explicit Connect probe is in flight; background checks never enter a visible checking state. */
  isChecking: boolean;
  /** The connected Runtime's realm display name, for the pill. */
  realmName: string | null;
  /** The health digest seen by the provider's existing probe, when the Runtime reports one. */
  schemaDigest: string | null;
  /**
   * A local Astrid service (chat) answered with something this page can't read, so Astrid on this computer is older
   * than the page. Settings shows the same Update Astrid status as an incompatible Runtime; the app is never gated on
   * it (only `state` gates), so the person keeps their work. Cleared by `setLocalServiceOutOfDate(false)`.
   */
  localServiceOutOfDate: boolean;
  setLocalServiceOutOfDate: (outOfDate: boolean) => void;
  /** Probes now, leaving Chrome's permission prompt untimed. No-op when connected or denied. */
  connect: () => void;
  /**
   * An explicit Connect finished and the permission is still not granted: Chrome was dismissed, or did not ask. The
   * permission card then offers the site-settings steps as well, and keeps Connect.
   */
  askUnanswered: boolean;
  /**
   * Re-reads Chrome's permission now (it does not always fire `onchange` on a reset) and resolves whether the page may
   * speak about the Runtime: true when it is granted or not required. Anything that is about to blame the Runtime asks first.
   */
  confirmPermission: () => Promise<boolean>;
}

const RuntimeConnectionContext = createContext<RuntimeConnectionValue | undefined>(undefined);

export interface RuntimeConnectionProviderProps {
  children: React.ReactNode;
  /** Override for tests; defaults to "a Runtime origin is configured". */
  gated?: boolean;
  /** Whether a gated connection waits for the browser's local-network permission; inferred from page/runtime origins. */
  requireLocalNetworkPermission?: boolean;
  /** Override for tests; defaults to `navigator.permissions`. */
  permissions?: PermissionsLike;
  /** Override for tests; defaults to `fetch`. */
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  /** Called each time the connection comes up (once per page): where Runtime queries are invalidated. */
  onConnected?: () => void;
}

export function RuntimeConnectionProvider({
  children,
  gated = runtimeOrigin() !== '',
  requireLocalNetworkPermission = gated && needsLocalNetworkPermission(
    runtimeOrigin(),
    typeof window === 'undefined' ? '' : window.location.origin,
  ),
  permissions,
  fetchImpl,
  pollIntervalMs = POLL_INTERVAL_MS,
  onConnected,
}: RuntimeConnectionProviderProps) {
  const [permission, setPermissionState] = useState<LocalNetworkPermissionState | null>(
    () => gated && requireLocalNetworkPermission ? null : 'granted',
  );
  const [outcome, setOutcome] = useState<RuntimeProbeOutcome | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [localServiceOutOfDate, setLocalServiceOutOfDate] = useState(false);
  const [failedReadings, setFailedReadings] = useState(0);
  const [askUnanswered, setAskUnanswered] = useState(false);
  const [scenario] = useState(detectInstallScenario);
  const canConnect = scenario !== 'mobile' && (!requireLocalNetworkPermission || scenario === 'chromium');
  const [connectedBeforeAtMount] = useState(() => !gated || readConnectedBefore());
  const [managedByPinokio, setManagedByPinokio] = useState(readPinokioManaged);
  useEffect(() => {
    if (!outcome || !('managedByPinokio' in outcome)) return;
    rememberPinokioManaged(outcome.managedByPinokio);
    setManagedByPinokio(outcome.managedByPinokio);
  }, [outcome]);
  // A fresh health response is authoritative immediately. The persisted value is
  // only the fallback for states (such as not_running) where this probe has no provenance.
  const currentManagedByPinokio = outcome && 'managedByPinokio' in outcome
    ? outcome.managedByPinokio
    : managedByPinokio;

  const mounted = useRef(true);
  const inFlight = useRef<AbortController | null>(null);
  /** The untimed probe `connect()` started while the permission was not yet granted: the one a grant must replace. */
  const promptProbe = useRef<AbortController | null>(null);
  /** A timed probe's longer slow follow-up: an explicit Connect takes priority over it. */
  const slowProbe = useRef<AbortController | null>(null);
  /** Sticky once a probe connects (set in `runProbe`, before the render): no probe starts after it. */
  const connectedRef = useRef(false);
  const permissionRef = useRef(permission);
  const setPermission = useCallback((next: LocalNetworkPermissionState) => {
    // Browser events can beat the next render and the cleanup of its granted-permission callbacks.
    permissionRef.current = next;
    setPermissionState(next);
  }, []);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
      slowProbe.current = null;
    };
  }, []);

  // The permission, and every change the browser reports to it.
  useEffect(() => {
    if (!gated || !requireLocalNetworkPermission || !canConnect) {
      if (gated && !requireLocalNetworkPermission) setPermission('granted');
      return undefined;
    }
    let cancelled = false;
    let unwatch: () => void = () => {};
    void (async () => {
      const stop = await watchLocalNetworkPermission((next) => {
        if (!cancelled) setPermission(next);
      }, permissions);
      if (cancelled) {
        stop();
        return;
      }
      unwatch = stop;
      const current = await queryLocalNetworkPermission(permissions);
      if (!cancelled) setPermission(current);
    })();
    return () => {
      cancelled = true;
      unwatch();
    };
  }, [gated, requireLocalNetworkPermission, canConnect, permissions, setPermission]);

  // Site settings do not always dispatch a permission change (a reset, cleared site data, another tab), so the browser is
  // asked again whenever the tab resumes, for as long as the gate is active: before and after a connection.
  useEffect(() => {
    if (!gated || !requireLocalNetworkPermission || !canConnect) return undefined;
    let cancelled = false;
    const check = async () => {
      const current = await queryLocalNetworkPermission(permissions);
      if (!cancelled) setPermission(current);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [gated, requireLocalNetworkPermission, canConnect, permissions, setPermission]);

  const confirmPermission = useCallback(async () => {
    if (!gated || !requireLocalNetworkPermission) return true;
    const current = await queryLocalNetworkPermission(permissions);
    if (mounted.current) setPermission(current);
    return current === 'granted';
  }, [gated, requireLocalNetworkPermission, permissions, setPermission]);

  const runProbe = useCallback(async function runProbe(untimed: boolean, explicit = false) {
    if (!explicit && permissionRef.current !== 'granted') return;
    if (explicit && inFlight.current && inFlight.current === slowProbe.current) {
      inFlight.current.abort();
      inFlight.current = null;
      slowProbe.current = null;
    }
    if (inFlight.current || connectedRef.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    if (explicit) setAskUnanswered(false);
    if (untimed && permissionRef.current !== 'granted') promptProbe.current = controller;
    if (untimed && !explicit && permissionRef.current === 'granted') slowProbe.current = controller;
    setIsChecking(untimed);
    const timeoutMs = untimed ? permissionRef.current === 'granted' ? SLOW_PROBE_TIMEOUT_MS : undefined : PROBE_TIMEOUT_MS;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new DOMException('Runtime probe timed out', 'TimeoutError')), timeoutMs);
    let result: RuntimeProbeOutcome;
    try {
      result = await probeRuntime(controller.signal, fetchImpl, () => permissionRef.current === 'granted');
    } finally {
      clearTimeout(timer);
    }
    // A grant replaced this probe (see the granted effect): its abort is not an answer, and the new probe owns the state.
    if (inFlight.current !== controller) return;
    inFlight.current = null;
    if (promptProbe.current === controller) promptProbe.current = null;
    if (slowProbe.current === controller) slowProbe.current = null;
    if (!mounted.current) return;
    setIsChecking(false);
    if (connectedRef.current) return;
    // Latch the connection now, not on the render that `setOutcome` schedules: `inFlight` is already clear, and an
    // interval tick or focus event that lands before that render would otherwise start a second probe.
    if (result.kind === 'connected') {
      connectedRef.current = true;
      // An answer this page could read is proof of the grant, whatever the browser's event has said so far.
      if (requireLocalNetworkPermission && permissionRef.current !== 'granted') setPermission('granted');
    }
    if (result.kind === 'slow' && !untimed && permissionRef.current === 'granted') void runProbe(true);
    // A failed request held behind a browser question is not evidence that Astrid is absent.
    if (permissionRef.current === 'granted') {
      setFailedReadings((previous) => result.kind === 'connected' ? 0 : previous + 1);
    }
    setOutcome(result);
    if (requireLocalNetworkPermission && result.kind !== 'connected' && permissionRef.current !== 'granted') {
      // A denied fetch looks like nothing listening, so the permission is the only way to tell them apart.
      const current = await queryLocalNetworkPermission(permissions);
      if (mounted.current) setPermission(current);
      // The person pressed Connect and nothing changed: Chrome was dismissed or never asked. Say so, and keep Connect.
      if (mounted.current && explicit && current === 'prompt') setAskUnanswered(true);
    }
  }, [fetchImpl, permissions, requireLocalNetworkPermission, setPermission]);

  // The permission comes first, always: once it is lost (denied, or reset to the prompt) nothing about the Runtime is known,
  // connected or not, so the connection is not claimed until it is granted again.
  const permissionLost = requireLocalNetworkPermission && (permission === 'denied' || permission === 'prompt');
  const isConnected = outcome?.kind === 'connected' && !permissionLost;

  // Permission resets invalidate earlier failures: setup help needs probes from the current granted visit.
  // A connection does not survive losing the permission: it is dropped so that a grant probes afresh.
  useEffect(() => {
    if (permission === 'granted') {
      setAskUnanswered(false);
      return;
    }
    if (connectedRef.current && !permissionLost) return;
    connectedRef.current = false;
    setFailedReadings(0);
    setOutcome(null);
  }, [permission, permissionLost]);

  // Saved settings are read from the Runtime only once it has answered (never before the permission prompt).
  const settingsMayConnect = !gated || isConnected;
  useEffect(() => {
    if (settingsMayConnect) void getSettingsStore().connect();
  }, [settingsMayConnect]);

  // Granted: probe at once, then on an interval and on focus, until connected.
  useEffect(() => {
    if (!gated || !canConnect || permission !== 'granted' || isConnected) return undefined;
    // A probe started under `prompt` is untimed and stays pending until the person answers Chrome; once the answer
    // is `granted` it is replaced by a fresh one (`runProbe` would otherwise return at once because it is in flight).
    if (promptProbe.current && inFlight.current === promptProbe.current) {
      inFlight.current.abort();
      inFlight.current = null;
      promptProbe.current = null;
    }
    const check = () => void runProbe(false);
    check();
    const interval = setInterval(check, pollIntervalMs);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', check);
    };
  }, [gated, canConnect, permission, isConnected, pollIntervalMs, runProbe]);

  useEffect(() => {
    if (!isConnected) return;
    writeConnectedBefore();
    // A visitor who has reached their Runtime from this browser goes straight into the app the next time they open
    // the bare domain (`resolveReturningAppEntry`); the landing page stays for first visits and /home.
    rememberAppEntryPreference();
    onConnectedRef.current?.();
  }, [isConnected]);

  const connect = useCallback(() => {
    if (!gated || !canConnect || connectedRef.current || permissionRef.current === null || permissionRef.current === 'denied' || permissionRef.current === 'unsupported') return;
    void runProbe(true, true);
  }, [gated, canConnect, runProbe]);

  const value = useMemo<RuntimeConnectionValue>(() => {
    if (!gated) {
      return {
        gated: false,
        state: { status: 'connected', realm: { realm_id: '', display_name: '' } },
        isConnected: true,
        isAuthenticated: true,
        connectedBefore: true,
        managedByPinokio: currentManagedByPinokio,
        isBooting: false,
        isChecking: false,
        realmName: null,
        schemaDigest: null,
        localServiceOutOfDate,
        setLocalServiceOutOfDate,
        connect,
        askUnanswered: false,
        confirmPermission,
      };
    }
    const base = {
      gated: true,
      isAuthenticated: !permissionLost && (outcome?.kind === 'connected'
        || outcome?.kind === 'update_needed' && outcome.authenticated),
      isChecking,
      connect,
      askUnanswered,
      confirmPermission,
      connectedBefore: connectedBeforeAtMount,
      managedByPinokio: currentManagedByPinokio,
      localServiceOutOfDate,
      setLocalServiceOutOfDate,
    } as const;
    if (outcome?.kind === 'connected' && !permissionLost) {
      return { ...base, state: { status: 'connected', realm: outcome.realm, ...(outcome.managedByPinokio ? { managedByPinokio: true } : {}) }, isConnected: true, isBooting: false, realmName: outcome.realm.display_name, schemaDigest: outcome.schemaDigest };
    }
    const notConnected = { ...base, isConnected: false, realmName: null, schemaDigest: null };
    if (scenario === 'mobile') return { ...notConnected, state: { status: 'phone' }, isBooting: false };
    if (requireLocalNetworkPermission && scenario === 'unsupported') return { ...notConnected, state: { status: 'unsupported' }, isBooting: false };
    if (requireLocalNetworkPermission && permission === 'unsupported') return { ...notConnected, state: { status: 'browser_update_needed' }, isBooting: false };
    if (permission === null) return { ...notConnected, state: { status: 'connecting' }, isBooting: true };
    if (permission === 'denied') return { ...notConnected, state: { status: 'blocked' }, isBooting: false };
    if (permission === 'prompt') return { ...notConnected, state: { status: 'needs_permission' }, isBooting: false };
    if (outcome?.kind === 'restart') return { ...notConnected, state: { status: 'restart' }, isBooting: false };
    if (outcome?.kind === 'update_needed') return { ...notConnected, state: { status: 'update_needed' }, isBooting: false };
    if (failedReadings >= 2) {
      return {
        ...notConnected,
        // The latest reading decides: an answer this page cannot read is a refusal, nothing at all is not running.
        state: { status: outcome?.kind === 'refused' ? 'refused' : 'not_running' },
        isBooting: false,
      };
    }
    return { ...notConnected, state: { status: 'connecting' }, isBooting: outcome === null };
  }, [gated, requireLocalNetworkPermission, outcome, permission, isChecking, connectedBeforeAtMount, currentManagedByPinokio, connect, failedReadings, scenario, localServiceOutOfDate, permissionLost, askUnanswered, confirmPermission]);

  return <RuntimeConnectionContext.Provider value={value}>{children}</RuntimeConnectionContext.Provider>;
}

export const useRuntimeConnection = (): RuntimeConnectionValue =>
  requireContextValue(useContext(RuntimeConnectionContext), 'useRuntimeConnection', 'RuntimeConnectionProvider');

/** Recovery UI can also be rendered outside the boot/auth provider. */
export const useRuntimeConnectionSafe = (): RuntimeConnectionValue | undefined => useContext(RuntimeConnectionContext);

/** Placeholder until the real panel is plugged in (A2.P): the state name and nothing else. */
function PlaceholderPanel({ state, exit }: RuntimeConnectionValue & { exit: RuntimeConnectionPanelExit | null }) {
  // Nothing to show on the way out: the app opens at once.
  useEffect(() => { exit?.left(); }, [exit]);
  if (exit) return null;
  return (
    <div
      role="status"
      data-testid="runtime-not-connected"
      data-state={state.status}
      className="grid min-h-screen place-items-center bg-background text-muted-foreground"
    >
      {state.status}
    </div>
  );
}

/**
 * The panel's way out once the Runtime connects: the app is mounted beneath it, the panel leaves in its own way (a
 * screen that asked for something shows that it worked first), then calls `left`.
 */
export interface RuntimeConnectionPanelExit {
  readonly left: () => void;
}

export interface RuntimeConnectionGateProps {
  children: React.ReactNode;
  /** A hosted onboarding connection phase is a deliberate entry, including in a new installed-app window. */
  connectOnEntry?: boolean;
  /**
   * Drawn over the app while the Runtime is not connected. When it connects, the same panel stays (with the last
   * screen it showed) and `exit` is set: the app mounts beneath it, and the panel is removed when it calls `exit.left`.
   * The panel decides how it leaves: a screen that asked the person to do something shows that it worked first.
   */
  panel?: (connection: RuntimeConnectionValue, exit: RuntimeConnectionPanelExit | null) => React.ReactNode;
  /** Rendered beside `children` once connected. Nothing until A2.P. */
  pill?: (connection: RuntimeConnectionValue) => React.ReactNode;
}

/**
 * Renders `children` once the Runtime is connected, and `panel` until then. A same-origin build renders `children`
 * at once. The default `panel` and `pill` are the places A2.P replaces.
 */
export function RuntimeConnectionGate({
  children,
  connectOnEntry = false,
  panel = (connection, exit) => <PlaceholderPanel {...connection} exit={exit} />,
  pill = () => null,
}: RuntimeConnectionGateProps) {
  const connection = useRuntimeConnection();
  // The last connection the panel was drawn with. While it is set and Astrid is connected, the panel is on its way
  // out over the app; `left` clears it.
  const shownRef = useRef<RuntimeConnectionValue | null>(null);
  const everConnectedRef = useRef(false);
  const [, panelLeft] = useReducer((count: number) => count + 1, 0);
  const exit = useMemo<RuntimeConnectionPanelExit>(() => ({
    left: () => {
      shownRef.current = null;
      panelLeft();
    },
  }), []);
  // The landing page's "use it right here" click asked to go in (`autoConnectRequest.ts`): the flag is read once, in the
  // first render, so the explainer is never painted for the frame before the effect below asks Chrome.
  const [autoConnect, setAutoConnect] = useState(() => {
    if (!connection.gated) return false;
    const installerEntry = consumeAutoConnectQuery();
    return connectOnEntry || installerEntry || autoConnectRequested();
  });
  const autoConnectRef = useRef(autoConnect);
  const { gated, state, isBooting, isConnected, connect } = connection;
  const needsPermission = state.status === 'needs_permission';
  useEffect(() => {
    if (!gated || !autoConnectRef.current) return;
    if (!needsPermission && !isConnected && isBooting) return;
    // Consume before probing: a permission reset can commit before setAutoConnect(false) renders.
    autoConnectRef.current = false;
    takeAutoConnectRequest();
    setAutoConnect(false);
    if (needsPermission) connect();
  }, [gated, autoConnect, needsPermission, isBooting, isConnected, connect]);
  if (!gated) return <>{children}</>;
  // Once Astrid has answered in this page load the app stays mounted for good: a later loss of the permission covers
  // it with the panel (inert) rather than unmounting it, so unsaved work, undo history and the unload guard survive.
  if (isConnected) everConnectedRef.current = true;
  let overlay: React.ReactNode = null;
  if (!isConnected) {
    // While the flag is waiting for its effect, the panel shows Chrome's prompt screen, not the explainer.
    const shown = autoConnect && needsPermission ? { ...connection, isChecking: true } : connection;
    shownRef.current = shown;
    overlay = panel(shown, null);
  } else if (shownRef.current) {
    overlay = panel(shownRef.current, exit);
  }
  // Keyed, so the panel stays the same element while the app mounts beneath it; the app is inert until it has left.
  return (
    <>
      {isConnected || everConnectedRef.current ? (
        <div key="app" className="contents" {...(overlay ? { inert: '' } : {})}>
          <RuntimeGateOpenProvider open={!overlay}>
            {pill(connection)}
            {children}
          </RuntimeGateOpenProvider>
        </div>
      ) : null}
      {overlay ? <React.Fragment key="panel">{overlay}</React.Fragment> : null}
    </>
  );
}

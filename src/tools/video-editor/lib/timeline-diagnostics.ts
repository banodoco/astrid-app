/**
 * High-volume timeline diagnostics are opt-in. The editor polls canonical
 * state in the background, so a normal development session must not turn each
 * poll/reconciliation phase into a console (or persisted-log) entry.
 *
 * Add `debugTimeline=1` to the editor URL when investigating the save/poll
 * protocol. Keeping this explicit also makes a noisy diagnostic session a
 * deliberate choice instead of an accidental property of DEV builds.
 */
export function isTimelineDiagnosticsEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('debugTimeline') === '1';
}

const SAVE_DIAGNOSTIC_PHASES = ['schedule', 'capture-called', 'capture-resolved', 'capture-rejected',
  'basis-operation', 'basis-dependencies-committed', 'owner-init', 'owner-closed', 'owner-retired', 'lifecycle-cancel',
  'basis-read', 'basis-ready', 'basis-unavailable', 'basis-error',
  'identity-read', 'session-created', 'session-recovered', 'session-changed',
  'adoption-start', 'adoption-complete', 'adopted-read', 'handoff-ready', 'owner-error'] as const;
type SaveDiagnosticPhase = typeof SAVE_DIAGNOSTIC_PHASES[number];

const SAVE_REJECTION_CODES = [
  'original-head-unavailable', 'capture-source-head-unavailable', 'capture-input-head-unavailable',
  'source-parent-unavailable', 'source-parent-mismatch', 'source-clip-identity', 'source-track-identity',
  'source-bundle-mismatch', 'original-read-unavailable',
  'authored-collection-unavailable', 'authored-binding-ambiguous', 'authored-identity-unavailable',
  'display-container-unbound', 'trim-binding-mismatch', 'explicit-clear-unavailable', 'display-value-unbound',
  'child-ownership-unavailable', 'local-document-changed', 'parent-mirror-mismatch',
  'gesture-basis-mismatch', 'gesture-clips-unavailable', 'gesture-clip-ambiguous',
  'gesture-registry-unavailable', 'registry-mirror-mismatch', 'split-time-unavailable',
  'move-track-mismatch', 'move-tracks-unavailable', 'move-track-ambiguous', 'move-routing-unavailable',
  'trim-operands-unavailable', 'capture-owner-unavailable', 'capture-owner-replaced',
  'owner-original-read-invalidated', 'owner-identity-invalidated', 'owner-retirement-invalidated',
  'owner-claim-invalidated', 'owner-recovery-ambiguous', 'owner-history-invalidated',
] as const;
export type TimelineSaveRejectionCode = typeof SAVE_REJECTION_CODES[number];
type SaveRejectionClass = 'TimelineVersionConflictError' | 'TimelineSaveError' | 'Error';
const saveRejections = new WeakMap<object, { code: TimelineSaveRejectionCode; errorClass: SaveRejectionClass }>();

// Only authentic local throw sites supply these fixed values. Never inspect or
// mutate an exception; unknown/foreign errors cannot classify themselves.
export function markTimelineSaveRejection<T extends Error>(error: T, code: TimelineSaveRejectionCode,
  errorClass: SaveRejectionClass = 'TimelineVersionConflictError'): T {
  try {
    if (typeof window !== 'undefined'
      && (window as unknown as { __timelineSaveDiagnosticsEnabled?: unknown }).__timelineSaveDiagnosticsEnabled === true
      && SAVE_REJECTION_CODES.includes(code) && ['TimelineVersionConflictError', 'TimelineSaveError', 'Error'].includes(errorClass)) {
      saveRejections.set(error, { code, errorClass });
    }
  } catch { /* Diagnostic tagging cannot affect the original throw. */ }
  return error;
}

interface SaveDiagnosticObservation {
  dependencyBaselinePresent?: unknown;
  providerChanged?: unknown;
  timelineChanged?: unknown;
  headChanged?: unknown;
  dataRefChanged?: unknown;
  editSeqRefChanged?: unknown;
  adoptionChanged?: unknown;
  ownerChanged?: unknown;
  resolverChanged?: unknown;
  localSaveChanged?: unknown;
  basisReadOrdinal?: unknown;
  operation?: unknown;
  operationOrdinal?: unknown;
  operationState?: unknown;
  error?: unknown;
  owner?: object;
  timelineId?: unknown;
  clipId?: unknown;
  generation?: unknown;
  sessionPresent?: unknown;
  closed?: unknown;
  current?: unknown;
  identityPresent?: unknown;
  scopeMatched?: unknown;
  mounted?: unknown;
  source?: unknown;
  gesture?: unknown;
  basis?: unknown;
  basisStatus?: unknown;
  state?: unknown;
}

const UNKNOWN = 'UNKNOWN';
const ownerAliases = new WeakMap<object, number>();
let nextOwnerAlias = 0;
let saveDiagnosticSequence = 0;
let saveDiagnosticTime = 0;

// Inspect only named own data properties: accessors, inherited fields and
// unavailable values stay unknown. Never walk bundles, errors or metadata.
function own(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== 'object') return undefined;
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch { return undefined; }
}
function identifier(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
    && /^[a-zA-Z0-9_.:-]+$/.test(value) ? value : value === null ? null : UNKNOWN;
}
function finite(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : UNKNOWN;
}
function counter(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : UNKNOWN;
}
function bool(value: unknown) { return typeof value === 'boolean' ? value : UNKNOWN; }
function choice(value: unknown, allowed: readonly string[]) {
  return typeof value === 'string' && allowed.includes(value) ? value : UNKNOWN;
}
function head(value: unknown) {
  return Object.freeze({ revisionId: identifier(own(value, 'headRevisionId')),
    publicationId: identifier(own(value, 'headPublicationId')) });
}
function numbers(value: unknown) {
  const result: Record<string, number | string | null> = {};
  for (const key of ['from', 'to', 'at', 'hold', 'speed']) {
    const item = own(value, key);
    result[key] = item === null ? null : finite(item);
    const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    result[`${key}State`] = !value || (descriptor && !('value' in descriptor)) ? UNKNOWN
      : !descriptor ? 'absent' : item === null ? 'null'
      : typeof item === 'number' && Number.isFinite(item) ? 'present' : UNKNOWN;
  }
  return Object.freeze(result);
}
function selected(source: unknown, clipId: unknown) {
  const clips = own(own(source, 'config'), 'clips');
  if (!Array.isArray(clips) || typeof clipId !== 'string') return numbers(undefined);
  const length = own(clips, 'length');
  if (typeof length !== 'number') return numbers(undefined);
  for (let index = 0; index < Math.min(length, 256); index++) {
    const clip = own(clips, String(index));
    if (own(clip, 'id') === clipId) return numbers(clip);
  }
  return numbers(undefined);
}

/** Separate explicit browser opt-in; the existing DEV/URL log policy is unchanged.
 * The lazy read runs only when enabled. No app references reach observers and
 * diagnostic failures cannot change the caller's result or error classification.
 */
export function emitTimelineSaveDiagnostic(boundary: SaveDiagnosticPhase | (() => SaveDiagnosticPhase), read: () => SaveDiagnosticObservation): void {
  try {
    if (typeof window === 'undefined'
      || (window as unknown as { __timelineSaveDiagnosticsEnabled?: unknown }).__timelineSaveDiagnosticsEnabled !== true) return;
    const phase = choice(typeof boundary === 'function' ? boundary() : boundary, SAVE_DIAGNOSTIC_PHASES);
    const observed = read();
    const rejected = ['capture-rejected', 'basis-error', 'owner-error'].includes(phase);
    const rejection = rejected && observed.error && typeof observed.error === 'object'
      ? saveRejections.get(observed.error) : undefined;
    let ownerAlias: number | string = UNKNOWN;
    if (observed.owner && typeof observed.owner === 'object') {
      ownerAlias = ownerAliases.get(observed.owner) ?? ++nextOwnerAlias;
      ownerAliases.set(observed.owner, ownerAlias);
    }
    const mountedHead = own(observed.mounted, 'head');
    const originalHead = own(own(observed.basis, 'source'), 'head');
    const state = observed.state;
    const owners = own(state, 'recoverableOwners');
    const ownerCount = Array.isArray(owners) ? own(owners, 'length') : undefined;
    const clipId = observed.clipId ?? own(observed.gesture, 'clipId');
    const time = performance.now();
    if (Number.isFinite(time)) saveDiagnosticTime = Math.max(saveDiagnosticTime, time);
    const detail = Object.freeze({ version: 1, sequence: ++saveDiagnosticSequence, time: saveDiagnosticTime, phase,
      projectId: identifier(own(mountedHead, 'projectId') ?? own(own(observed.source, 'head'), 'projectId')),
      timelineId: identifier(observed.timelineId), clipId: identifier(clipId), ownerAlias,
      dependencyBaselinePresent: bool(observed.dependencyBaselinePresent),
      providerChanged: bool(observed.providerChanged),
      timelineChanged: bool(observed.timelineChanged),
      headChanged: bool(observed.headChanged),
      dataRefChanged: bool(observed.dataRefChanged),
      editSeqRefChanged: bool(observed.editSeqRefChanged),
      adoptionChanged: bool(observed.adoptionChanged),
      ownerChanged: bool(observed.ownerChanged),
      resolverChanged: bool(observed.resolverChanged),
      localSaveChanged: bool(observed.localSaveChanged),
      basisReadOrdinal: counter(observed.basisReadOrdinal), operationOrdinal: counter(observed.operationOrdinal),
      operation: choice(observed.operation, ['loader', 'history', 'parent', 'shot', 'internal']),
      operationState: choice(observed.operationState, ['start', 'end', 'refused']),
      generation: finite(observed.generation), sessionPresent: bool(observed.sessionPresent), closed: bool(observed.closed), current: bool(observed.current),
      identityPresent: bool(observed.identityPresent), scopeMatched: bool(observed.scopeMatched),
      mountedHead: head(mountedHead), originalHead: head(originalHead),
      basisStatus: choice(observed.basisStatus, ['loading', 'ready', 'unavailable', 'error']),
      gestureKind: choice(own(observed.gesture, 'kind'), ['trim', 'move', 'split']),
      patch: numbers(own(observed.gesture, 'patch')), mountedClip: selected(observed.mounted, clipId),
      sourceClip: selected(observed.source, clipId), gestureClip: selected(observed.gesture, clipId),
      originalClip: selected(own(observed.basis, 'source'), clipId),
      status: choice(own(state, 'status'), ['saved', 'dirty', 'saving', 'retry', 'conflict', 'blocked', 'recovery', 'error']),
      ownerPresent: state && typeof state === 'object' ? typeof own(state, 'ownerId') === 'string' : UNKNOWN,
      recoverableOwnerCount: typeof ownerCount === 'number' && ownerCount <= 10000 ? ownerCount : UNKNOWN,
      intentsPendingCount: UNKNOWN,
      errorStage: phase === 'capture-rejected' ? 'capture' : phase === 'basis-error' ? 'basis-read' : phase === 'owner-error' ? 'owner-init' : UNKNOWN,
      errorCode: rejection?.code ?? (rejected ? 'operation-rejected' : UNKNOWN),
      errorClass: rejection?.errorClass ?? UNKNOWN,
    });
    window.dispatchEvent(new CustomEvent('timeline:save-diagnostic', { detail }));
  } catch { /* Diagnostics are observational, including hostile getters/dispatch. */ }
}

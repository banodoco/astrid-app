import { writeFile } from 'node:fs/promises';

const REDACTED = '[REDACTED]';

export const DIAGNOSTIC_MAX_BYTES = 16 * 1024;
export const DIAGNOSTIC_MAX_DEPTH = 8;
export const DIAGNOSTIC_MAX_KEYS = 40;
export const DIAGNOSTIC_MAX_ARRAY_ITEMS = 40;
export const DIAGNOSTIC_MAX_STRING = 500;
const DIAGNOSTIC_MAX_INPUT_STRING = 4 * 1024;
const DIAGNOSTIC_PRIORITY_MAX_ITEMS = 4;

export const DIAGNOSTIC_READ_TIMEOUT_MS = 150;
export const DIAGNOSTIC_ARTIFACT_TIMEOUT_MS = 500;
export const DIAGNOSTIC_COLLECTION_TIMEOUT_MS = 1_000;

export const MOUNTED_DIAGNOSTIC_EVENT = 'timeline:save-diagnostic';
export const MOUNTED_DIAGNOSTIC_MAX_RECORDS = 32;

export const MOUNTED_DIAGNOSTIC_ERROR_CODES = [
  'original-head-unavailable', 'capture-source-head-unavailable', 'capture-input-head-unavailable',
  'source-parent-unavailable', 'source-parent-mismatch', 'source-clip-identity', 'source-track-identity',
  'source-bundle-mismatch', 'original-read-unavailable', 'authored-collection-unavailable',
  'authored-binding-ambiguous', 'authored-identity-unavailable', 'display-container-unbound',
  'trim-binding-mismatch', 'explicit-clear-unavailable', 'display-value-unbound', 'child-ownership-unavailable',
  'local-document-changed', 'parent-mirror-mismatch', 'gesture-basis-mismatch', 'gesture-clips-unavailable',
  'gesture-clip-ambiguous', 'gesture-registry-unavailable', 'registry-mirror-mismatch', 'split-time-unavailable',
  'move-track-mismatch', 'move-tracks-unavailable', 'move-track-ambiguous', 'move-routing-unavailable',
  'trim-operands-unavailable', 'capture-owner-unavailable', 'capture-owner-replaced',
  'owner-original-read-invalidated', 'owner-identity-invalidated', 'owner-retirement-invalidated',
  'owner-claim-invalidated', 'owner-recovery-ambiguous', 'owner-history-invalidated',
] as const;
export const MOUNTED_DIAGNOSTIC_ERROR_CLASSES = ['TimelineVersionConflictError', 'Error'] as const;
const MOUNTED_BOOTSTRAP_DIAGNOSTIC_ERROR_CLASSES = [
  ...MOUNTED_DIAGNOSTIC_ERROR_CLASSES, 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'DOMException',
] as const;

export const MOUNTED_DIAGNOSTIC_PHASES = [
  'schedule', 'capture-called', 'capture-resolved', 'capture-rejected', 'owner-init', 'owner-closed',
  'basis-operation', 'basis-dependencies-committed', 'owner-retired', 'lifecycle-cancel', 'basis-read', 'basis-ready', 'basis-unavailable', 'basis-error',
  'identity-read', 'session-created', 'session-recovered', 'session-changed', 'adoption-start',
  'adoption-complete', 'adopted-read', 'handoff-ready', 'owner-error',
  'connection-route', 'page-error',
] as const;

const MOUNTED_DIAGNOSTIC_PHASE_SET = new Set<string>(MOUNTED_DIAGNOSTIC_PHASES);
const MOUNTED_DIAGNOSTIC_ERROR_CODE_SET = new Set<string>(MOUNTED_DIAGNOSTIC_ERROR_CODES);
const MOUNTED_DIAGNOSTIC_ERROR_CLASS_SET = new Set<string>(MOUNTED_DIAGNOSTIC_ERROR_CLASSES);
const MOUNTED_DIAGNOSTIC_PRIORITY_PHASE_SET = new Set(['capture-rejected', 'basis-error', 'owner-error']);
const MOUNTED_BOOTSTRAP_DIAGNOSTIC_PHASE_SET = new Set(['connection-route', 'page-error']);
const MOUNTED_BOOTSTRAP_DIAGNOSTIC_FIELDS = [
  'connectionRoute', 'connectionStatus', 'connectionOutcome', 'pageErrorClass', 'pageErrorCategory',
] as const;
const MOUNTED_DIAGNOSTIC_FIELDS = [
  'version', 'sequence', 'time', 'phase', 'projectId', 'timelineId', 'clipId', 'ownerAlias', 'generation',
  'sessionPresent', 'closed', 'current', 'identityPresent', 'scopeMatched', 'mountedHead', 'originalHead',
  'basisStatus', 'gestureKind', 'patch', 'mountedClip', 'sourceClip', 'gestureClip', 'originalClip', 'status',
  'ownerPresent', 'recoverableOwnerCount', 'intentsPendingCount', 'errorStage', 'errorCode', 'errorClass', 'dependencyBaselinePresent', 'providerChanged', 'timelineChanged', 'headChanged', 'dataRefChanged', 'editSeqRefChanged', 'adoptionChanged', 'ownerChanged', 'resolverChanged', 'localSaveChanged', 'basisReadOrdinal', 'operation', 'operationOrdinal', 'operationState',
] as const;
const MOUNTED_DIAGNOSTIC_NUMERIC_FIELDS = ['from', 'to', 'at', 'hold', 'speed'] as const;
const MOUNTED_DIAGNOSTIC_STATES = ['present', 'absent', 'null', 'UNKNOWN'] as const;
const UNKNOWN = 'UNKNOWN' as const;

export type MountedDiagnosticSnapshot = {
  status: 'observed' | 'UNKNOWN';
  buffer: string;
  records: unknown[];
  accepted: number;
  rejected: number;
  overflow: number;
  listenerErrors: number;
};

type MountedDiagnosticProjection = { accepted: true; record: Record<string, unknown> } | { accepted: false };

function mountedOwnData(value: object, key: string): { present: boolean; value?: unknown } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return { present: false };
    return { present: true, value: descriptor.value };
  } catch {
    return { present: false };
  }
}

function mountedSafeId(value: unknown): string | null | 'UNKNOWN' {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) return UNKNOWN;
  if (!/^[a-zA-Z0-9_.:-]+$/.test(value) || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) return UNKNOWN;
  return value;
}

function mountedSafeScalar(value: unknown): string | null | 'UNKNOWN' {
  return value === null ? null : typeof value === 'string' && value.length <= 200 ? redactDiagnosticText(value) : UNKNOWN;
}

function mountedSafeNumber(value: unknown, integer = false): number | 'UNKNOWN' {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000
    && (!integer || Number.isInteger(value)) ? value : UNKNOWN;
}

function mountedSafeNonNegativeInteger(value: unknown, maximum = 1_000_000_000): number | 'UNKNOWN' {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum ? value : UNKNOWN;
}

function mountedSafeBoolean(value: unknown): boolean | 'UNKNOWN' {
  return typeof value === 'boolean' ? value : UNKNOWN;
}

function mountedErrorStage(value: unknown): string {
  return value === 'capture' || value === 'basis-read' || value === 'owner-init' ? value : UNKNOWN;
}

function mountedErrorCode(value: unknown): string {
  return typeof value === 'string'
    && (value === 'operation-rejected' || MOUNTED_DIAGNOSTIC_ERROR_CODE_SET.has(value)) ? value : UNKNOWN;
}

function mountedErrorClass(value: unknown): string {
  return typeof value === 'string' && MOUNTED_DIAGNOSTIC_ERROR_CLASS_SET.has(value) ? value : UNKNOWN;
}

function mountedConnectionRoute(value: unknown): string {
  return value === 'health' || value === 'handshake' || value === 'realm' ? value : UNKNOWN;
}

function mountedConnectionStatus(value: unknown): number | 'UNKNOWN' {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : UNKNOWN;
}

function mountedConnectionOutcome(value: unknown): string {
  return value === 'ok' || value === 'redirect' || value === 'http-error' || value === 'transport-failure' || value === 'unknown' ? value : UNKNOWN;
}

function mountedBootstrapErrorClass(value: unknown): string {
  return typeof value === 'string' && MOUNTED_BOOTSTRAP_DIAGNOSTIC_ERROR_CLASSES.includes(value as typeof MOUNTED_BOOTSTRAP_DIAGNOSTIC_ERROR_CLASSES[number]) ? value : UNKNOWN;
}

function mountedPageErrorCategory(value: unknown): string {
  return value === 'runtime' ? value : UNKNOWN;
}

function mountedHead(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { revisionId: UNKNOWN, publicationId: UNKNOWN };
  const source = value as object;
  const revisionId = mountedOwnData(source, 'revisionId');
  const publicationId = mountedOwnData(source, 'publicationId');
  return {
    revisionId: revisionId.present ? mountedSafeId(revisionId.value) : UNKNOWN,
    publicationId: publicationId.present ? mountedSafeId(publicationId.value) : UNKNOWN,
  };
}

function mountedNumberField(value: object, field: typeof MOUNTED_DIAGNOSTIC_NUMERIC_FIELDS[number]): { value: unknown; state: typeof MOUNTED_DIAGNOSTIC_STATES[number] } {
  const raw = mountedOwnData(value, field);
  const state = mountedOwnData(value, `${field}State`);
  const explicitState = typeof state.value === 'string' && (MOUNTED_DIAGNOSTIC_STATES as readonly string[]).includes(state.value)
    ? state.value as typeof MOUNTED_DIAGNOSTIC_STATES[number] : undefined;
  if (explicitState === 'null') return { value: null, state: 'null' };
  if (explicitState === 'absent') return { value: UNKNOWN, state: 'absent' };
  if (explicitState === 'UNKNOWN') return { value: UNKNOWN, state: 'UNKNOWN' };
  if (explicitState === 'present') {
    const number = mountedSafeNumber(raw.value);
    return number === UNKNOWN ? { value: UNKNOWN, state: 'UNKNOWN' } : { value: number, state: 'present' };
  }
  if (!raw.present) return { value: UNKNOWN, state: 'absent' };
  if (raw.value === null) return { value: null, state: 'null' };
  const number = mountedSafeNumber(raw.value);
  return number === UNKNOWN ? { value: UNKNOWN, state: 'UNKNOWN' } : { value: number, state: 'present' };
}

function mountedNumericRecord(value: unknown): Record<string, unknown> {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as object : null;
  const result: Record<string, unknown> = {};
  for (const field of MOUNTED_DIAGNOSTIC_NUMERIC_FIELDS) {
    const projected = source ? mountedNumberField(source, field) : { value: UNKNOWN, state: 'UNKNOWN' as const };
    result[field] = projected.value;
    result[`${field}State`] = projected.state;
  }
  return result;
}

function mountedRecordField(detail: object, key: typeof MOUNTED_DIAGNOSTIC_FIELDS[number] | typeof MOUNTED_BOOTSTRAP_DIAGNOSTIC_FIELDS[number], phase: string): unknown {
  const field = mountedOwnData(detail, key);
  if (key === 'version') return 1;
  if (key === 'dependencyBaselinePresent' || key === 'providerChanged' || key === 'timelineChanged' || key === 'headChanged' || key === 'dataRefChanged' || key === 'editSeqRefChanged' || key === 'adoptionChanged' || key === 'ownerChanged' || key === 'resolverChanged' || key === 'localSaveChanged') return mountedSafeBoolean(field.value);
  if (key === 'basisReadOrdinal' || key === 'operationOrdinal') return mountedSafeNonNegativeInteger(field.value);
  if (key === 'operation') return typeof field.value === 'string' && ['loader', 'history', 'parent', 'shot', 'internal'].includes(field.value) ? field.value : UNKNOWN;
  if (key === 'operationState') return typeof field.value === 'string' && ['start', 'end', 'refused'].includes(field.value) ? field.value : UNKNOWN;
  if (key === 'phase') return field.present && typeof field.value === 'string' && MOUNTED_DIAGNOSTIC_PHASE_SET.has(field.value) ? field.value : UNKNOWN;
  if (key === 'projectId' || key === 'timelineId' || key === 'clipId') return field.present ? mountedSafeId(field.value) : UNKNOWN;
  if (key === 'mountedHead' || key === 'originalHead') return mountedHead(field.present ? field.value : undefined);
  if (key === 'patch' || key === 'mountedClip' || key === 'sourceClip' || key === 'gestureClip' || key === 'originalClip') {
    return mountedNumericRecord(field.present ? field.value : undefined);
  }
  if (key === 'intentsPendingCount') return UNKNOWN;
  if (key === 'sequence' || key === 'time' || key === 'generation' || key === 'ownerAlias' || key === 'recoverableOwnerCount' || key === 'intentsPendingCount') {
    if (key === 'time') return mountedSafeNumber(field.present ? field.value : undefined);
    if (key === 'recoverableOwnerCount') return mountedSafeNonNegativeInteger(field.present ? field.value : undefined, 10_000);
    return mountedSafeNonNegativeInteger(field.present ? field.value : undefined);
  }
  if (key === 'sessionPresent' || key === 'closed' || key === 'current' || key === 'identityPresent' || key === 'scopeMatched' || key === 'ownerPresent') {
    return mountedSafeBoolean(field.present ? field.value : undefined);
  }
  if (key === 'errorStage') return field.present ? mountedErrorStage(field.value) : UNKNOWN;
  if (key === 'errorCode') return MOUNTED_DIAGNOSTIC_PRIORITY_PHASE_SET.has(phase) && field.present ? mountedErrorCode(field.value) : UNKNOWN;
  if (key === 'errorClass') return MOUNTED_DIAGNOSTIC_PRIORITY_PHASE_SET.has(phase) && field.present ? mountedErrorClass(field.value) : UNKNOWN;
  if (key === 'connectionRoute') return field.present ? mountedConnectionRoute(field.value) : UNKNOWN;
  if (key === 'connectionStatus') return field.present ? mountedConnectionStatus(field.value) : UNKNOWN;
  if (key === 'connectionOutcome') return field.present ? mountedConnectionOutcome(field.value) : UNKNOWN;
  if (key === 'pageErrorClass') return field.present ? mountedBootstrapErrorClass(field.value) : UNKNOWN;
  if (key === 'pageErrorCategory') return field.present ? mountedPageErrorCategory(field.value) : UNKNOWN;
  return field.present ? mountedSafeScalar(field.value) : UNKNOWN;
}

export function projectMountedDiagnosticDetail(detail: unknown): MountedDiagnosticProjection {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return { accepted: false };
  const version = mountedOwnData(detail, 'version');
  const phase = mountedOwnData(detail, 'phase');
  if (version.value !== 1 || !phase.present || typeof phase.value !== 'string' || !MOUNTED_DIAGNOSTIC_PHASE_SET.has(phase.value)) {
    return { accepted: false };
  }
  const record: Record<string, unknown> = {};
  for (const key of MOUNTED_DIAGNOSTIC_FIELDS) record[key] = mountedRecordField(detail, key, phase.value);
  if (MOUNTED_BOOTSTRAP_DIAGNOSTIC_PHASE_SET.has(phase.value)) {
    for (const key of MOUNTED_BOOTSTRAP_DIAGNOSTIC_FIELDS) record[key] = mountedRecordField(detail, key, phase.value);
  }
  return { accepted: true, record };
}

/** Source for page.addInitScript; it intentionally has no imports or closures. */
export function mountedDiagnosticInitScript(options: { buffer: string; maxRecords: number }) {
  const source = (config: { buffer: string; maxRecords: number }) => {
    const win = window as unknown as Window & Record<string, unknown>;
    if (win.__timelineSaveDiagnosticsEnabled !== true) win.__timelineSaveDiagnosticsEnabled = true;
    const own = (value: object, key: string) => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && 'value' in descriptor ? { present: true, value: descriptor.value } : { present: false };
      } catch { return { present: false }; }
    };
    const phases = new Set(['schedule', 'capture-called', 'capture-resolved', 'capture-rejected', 'owner-init', 'owner-closed', 'basis-operation', 'basis-dependencies-committed', 'owner-retired', 'lifecycle-cancel', 'basis-read', 'basis-ready', 'basis-unavailable', 'basis-error', 'identity-read', 'session-created', 'session-recovered', 'session-changed', 'adoption-start', 'adoption-complete', 'adopted-read', 'handoff-ready', 'owner-error', 'connection-route', 'page-error']);
    const bootstrapPhases = new Set(['connection-route', 'page-error']);
    const numericFields = ['from', 'to', 'at', 'hold', 'speed'];
    const states = new Set(['present', 'absent', 'null', 'UNKNOWN']);
    const errorCodes = new Set(['original-head-unavailable', 'capture-source-head-unavailable', 'capture-input-head-unavailable', 'source-parent-unavailable', 'source-parent-mismatch', 'source-clip-identity', 'source-track-identity', 'source-bundle-mismatch', 'original-read-unavailable', 'authored-collection-unavailable', 'authored-binding-ambiguous', 'authored-identity-unavailable', 'display-container-unbound', 'trim-binding-mismatch', 'explicit-clear-unavailable', 'display-value-unbound', 'child-ownership-unavailable', 'local-document-changed', 'parent-mirror-mismatch', 'gesture-basis-mismatch', 'gesture-clips-unavailable', 'gesture-clip-ambiguous', 'gesture-registry-unavailable', 'registry-mirror-mismatch', 'split-time-unavailable', 'move-track-mismatch', 'move-tracks-unavailable', 'move-track-ambiguous', 'move-routing-unavailable', 'trim-operands-unavailable', 'capture-owner-unavailable', 'capture-owner-replaced', 'owner-original-read-invalidated', 'owner-identity-invalidated', 'owner-retirement-invalidated', 'owner-claim-invalidated', 'owner-recovery-ambiguous', 'owner-history-invalidated']);
    const errorClasses = new Set(['TimelineVersionConflictError', 'Error']);
    const priorityPhases = new Set(['capture-rejected', 'basis-error', 'owner-error']);
    const fields = ['version', 'sequence', 'time', 'phase', 'projectId', 'timelineId', 'clipId', 'ownerAlias', 'generation', 'sessionPresent', 'closed', 'current', 'identityPresent', 'scopeMatched', 'mountedHead', 'originalHead', 'basisStatus', 'gestureKind', 'patch', 'mountedClip', 'sourceClip', 'gestureClip', 'originalClip', 'status', 'ownerPresent', 'recoverableOwnerCount', 'intentsPendingCount', 'errorStage', 'errorCode', 'errorClass', 'dependencyBaselinePresent', 'providerChanged', 'timelineChanged', 'headChanged', 'dataRefChanged', 'editSeqRefChanged', 'adoptionChanged', 'ownerChanged', 'resolverChanged', 'localSaveChanged', 'basisReadOrdinal', 'operation', 'operationOrdinal', 'operationState'];
    const bootstrapFields = ['connectionRoute', 'connectionStatus', 'connectionOutcome', 'pageErrorClass', 'pageErrorCategory'];
    const unknown = 'UNKNOWN';
    const id = (value: unknown) => value === null ? null : typeof value === 'string' && value.length > 0 && value.length <= 160 && /^[a-zA-Z0-9_.:-]+$/.test(value) && !/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : unknown;
    const number = (value: unknown, integer = false) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000 && (!integer || Number.isInteger(value)) ? value : unknown;
    const nonNegative = (value: unknown, maximum = 1_000_000_000) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum ? value : unknown;
    const boolean = (value: unknown) => typeof value === 'boolean' ? value : unknown;
    const scalar = (value: unknown) => value === null ? null : typeof value === 'string' && value.length <= 200 ? value : unknown;
    const head = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { revisionId: unknown, publicationId: unknown };
      const source = value as object;
      const revision = own(source, 'revisionId'); const publication = own(source, 'publicationId');
      return { revisionId: revision.present ? id(revision.value) : unknown, publicationId: publication.present ? id(publication.value) : unknown };
    };
    const numericRecord = (value: unknown) => {
      const source = value && typeof value === 'object' && !Array.isArray(value) ? value as object : null;
      const result: Record<string, unknown> = {};
      for (const field of numericFields) {
        const raw = source ? own(source, field) : { present: false, value: undefined };
        const explicit = source ? own(source, `${field}State`) : { present: false, value: undefined };
        const explicitState = typeof explicit.value === 'string' && states.has(explicit.value) ? explicit.value : undefined;
        let state = 'UNKNOWN'; let resultValue: unknown = unknown;
        if (explicitState === 'null') { state = 'null'; resultValue = null; }
        else if (explicitState === 'absent') state = 'absent';
        else if (explicitState === 'present') { resultValue = number(raw.value); state = resultValue === unknown ? 'UNKNOWN' : 'present'; }
        else if (explicitState === 'UNKNOWN') state = 'UNKNOWN';
        else if (!raw.present) state = 'absent';
        else if (raw.value === null) { state = 'null'; resultValue = null; }
        else { resultValue = number(raw.value); state = resultValue === unknown ? 'UNKNOWN' : 'present'; }
        result[field] = resultValue; result[`${field}State`] = state;
      }
      return result;
    };
    const project = (detail: object) => {
      const version = own(detail, 'version'); const phase = own(detail, 'phase');
      if (version.value !== 1 || !phase.present || typeof phase.value !== 'string' || !phases.has(phase.value)) return null;
      const rejectionPhase = priorityPhases.has(phase.value);
      const result: Record<string, unknown> = {};
      for (const key of fields) {
        const field = own(detail, key); const value = field.value;
        if (key === 'version') result[key] = 1;
        else if (key === 'dependencyBaselinePresent' || key === 'providerChanged' || key === 'timelineChanged' || key === 'headChanged' || key === 'dataRefChanged' || key === 'editSeqRefChanged' || key === 'adoptionChanged' || key === 'ownerChanged' || key === 'resolverChanged' || key === 'localSaveChanged') result[key] = boolean(value);
        else if (key === 'basisReadOrdinal' || key === 'operationOrdinal') result[key] = nonNegative(value);
        else if (key === 'operation') result[key] = typeof value === 'string' && ['loader', 'history', 'parent', 'shot', 'internal'].includes(value) ? value : unknown;
        else if (key === 'operationState') result[key] = typeof value === 'string' && ['start', 'end', 'refused'].includes(value) ? value : unknown;
        else if (key === 'phase') result[key] = phase.value;
        else if (key === 'projectId' || key === 'timelineId' || key === 'clipId') result[key] = field.present ? id(value) : unknown;
        else if (key === 'mountedHead' || key === 'originalHead') result[key] = head(field.present ? value : undefined);
        else if (key === 'patch' || key === 'mountedClip' || key === 'sourceClip' || key === 'gestureClip' || key === 'originalClip') result[key] = numericRecord(field.present ? value : undefined);
        else if (key === 'intentsPendingCount') result[key] = unknown;
        else if (key === 'sequence' || key === 'generation' || key === 'ownerAlias') result[key] = nonNegative(field.present ? value : undefined);
        else if (key === 'recoverableOwnerCount') result[key] = nonNegative(field.present ? value : undefined, 10000);
        else if (key === 'time') result[key] = number(field.present ? value : undefined);
        else if (key === 'sessionPresent' || key === 'closed' || key === 'current' || key === 'identityPresent' || key === 'scopeMatched' || key === 'ownerPresent') result[key] = boolean(field.present ? value : undefined);
        else if (key === 'errorStage') result[key] = field.present && (value === 'capture' || value === 'basis-read' || value === 'owner-init') ? value : unknown;
        else if (key === 'errorCode') result[key] = rejectionPhase && field.present && (value === 'operation-rejected' || (typeof value === 'string' && errorCodes.has(value))) ? value : unknown;
        else if (key === 'errorClass') result[key] = rejectionPhase && field.present && typeof value === 'string' && errorClasses.has(value) ? value : unknown;
        else result[key] = field.present ? scalar(value) : unknown;
      }
      if (bootstrapPhases.has(phase.value)) for (const key of bootstrapFields) {
        const field = own(detail, key); const value = field.value;
        if (key === 'connectionRoute') result[key] = field.present && (value === 'health' || value === 'handshake' || value === 'realm') ? value : unknown;
        else if (key === 'connectionStatus') result[key] = field.present && typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : unknown;
        else if (key === 'connectionOutcome') result[key] = field.present && ['ok', 'redirect', 'http-error', 'transport-failure', 'unknown'].includes(value as string) ? value : unknown;
        else if (key === 'pageErrorClass') result[key] = field.present && ['TimelineVersionConflictError', 'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'DOMException'].includes(value as string) ? value : unknown;
        else result[key] = field.present && value === 'runtime' ? value : unknown;
      }
      return result;
    };
    const capacity = Number.isSafeInteger(config.maxRecords) && config.maxRecords > 0 ? config.maxRecords : 1;
    const state = { records: [] as unknown[], accepted: 0, rejected: 0, overflow: 0, listenerErrors: 0 };
    const snapshot = () => ({ status: state.records.length > 0 ? 'observed' : 'UNKNOWN', buffer: config.buffer, records: state.records.slice(), accepted: state.accepted, rejected: state.rejected, overflow: state.overflow, listenerErrors: state.listenerErrors });
    const snapshotName = '__timelineSaveDiagnosticsSnapshot';
    win[snapshotName] = snapshot;
    try {
      window.addEventListener('timeline:save-diagnostic', (event: Event) => {
        try {
          const detail = own(event, 'detail');
          let detailValue = detail.value;
          if (!detail.present && typeof CustomEvent !== 'undefined' && event instanceof CustomEvent) {
            try { detailValue = event.detail; } catch { detailValue = undefined; }
          }
          if (detailValue === undefined || !detailValue || typeof detailValue !== 'object' || Array.isArray(detailValue)) { state.rejected += 1; return; }
          const record = project(detailValue as object);
          if (!record) { state.rejected += 1; return; }
          state.accepted += 1;
          if (state.records.length >= capacity) {
            const isPriority = priorityPhases.has(String((record as Record<string, unknown>).phase));
            const firstNonPriority = state.records.findIndex((item) => !priorityPhases.has(String((item as Record<string, unknown>).phase)));
            if (!isPriority && state.records.some((item) => priorityPhases.has(String((item as Record<string, unknown>).phase)))) {
              state.overflow += 1;
              return;
            }
            state.records.splice(isPriority && firstNonPriority >= 0 ? firstNonPriority : 0, 1);
            state.overflow += 1;
          }
          state.records.push(record);
        } catch { state.listenerErrors += 1; }
      });
    } catch { state.listenerErrors += 1; }
  };
  const serialized = source.toString()
    .replaceAll('__name(', '')
    .replaceAll(',"own")', '')
    .replaceAll(',"safeText")', '')
    .replaceAll(',"project")', '')
    .replaceAll(',"snapshot")', '')
    .replaceAll(',"id")', '')
    .replaceAll(',"number")', '')
    .replaceAll(',"boolean")', '')
    .replaceAll(',"scalar")', '')
    .replaceAll(',"head")', '')
    .replaceAll(',"numericRecord")', '')
    .replaceAll(',"nonNegative")', '');
  return `(${serialized})(${JSON.stringify(options)});`;
}

const SENSITIVE_KEY = /^(?:body|principal|authorization|cookie|set-cookie|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|credential|client[_-]?secret|private[_-]?key|session)$/i;
const SENSITIVE_ASSIGNMENT = /(["']?)([A-Za-z0-9_-]*(?:body|principal|authorization|cookie|set-cookie|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|credential|client[_-]?secret|private[_-]?key|session)[A-Za-z0-9_-]*)\1(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|\{[\s\S]*|\[[\s\S]*|[^\s,;}\]]+)/gi;

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length <= maxBytes) return value;
  const marker = '…[TRUNCATED]';
  const markerBytes = new TextEncoder().encode(marker).length;
  let prefix = new TextDecoder().decode(encoded.slice(0, Math.max(0, maxBytes - markerBytes)));
  while (new TextEncoder().encode(prefix + marker).length > maxBytes) prefix = prefix.slice(0, -1);
  return prefix + marker;
}

export function redactDiagnosticText(value: string): string {
  const input = value.slice(0, DIAGNOSTIC_MAX_INPUT_STRING);
  const redacted = input
    .replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.origin}${url.pathname}`;
      } catch {
        return '[REDACTED_URL]';
      }
    })
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, (_match, openingQuote: string, key: string, separator: string) => (
      `${openingQuote}${key}${openingQuote}${separator}${openingQuote ? `${openingQuote}${REDACTED}${openingQuote}` : REDACTED}`
    ))
    .replace(/([/?][^\s"'<>?]*)\?[^\s"'<>]*/g, '$1[QUERY_REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]');
  return truncateUtf8(redacted, DIAGNOSTIC_MAX_STRING);
}

export type DiagnosticDomObservation = { attached: boolean; visible: boolean };

export function diagnosticObservedVisibility(observations: readonly DiagnosticDomObservation[]): boolean | 'UNKNOWN' {
  if (observations.length !== 1) return 'UNKNOWN';
  const observation = observations[0];
  if (typeof observation.attached !== 'boolean' || typeof observation.visible !== 'boolean') return 'UNKNOWN';
  return observation.attached ? observation.visible : 'UNKNOWN';
}

// Only these diagnostic containers may carry structure. All other allowed fields
// are primitives; a head or ID field can never smuggle a request body or principal.
const DIAGNOSTIC_CONTAINERS = new Set([
  'case', 'basis', 'displayedHead', 'sourceIdentities', 'traffic', 'commits', 'readonly',
  'commitReplies', 'currentWireHeads', 'readonlyReplies', 'head', 'replyHead', 'beforeHead',
  'splitHead', 'agentHead', 'runtimeHistoryHead', 'acceptedHead', 'reads', 'items',
  'outbox', 'outboxes', 'summary', 'records', 'owners', 'pending', 'request', 'outcome',
  'sourceWindow', 'before', 'after', 'sourceIn', 'selectedClip', 'identity', 'tuple', 'available',
  'unknowns', 'losses', 'failureContext', 'wireHeads', 'requestProjections', 'keyProjection', 'bodyProjection', 'recovery', 'transport', 'captureData',
  'ui', 'errors', 'errorSignals', 'page', 'console', 'requestFailures', 'runtimeResponses',
  'mountedObservations', 'mounted', 'originalBasis', 'basis', 'mountedHead', 'originalHead', 'headPair',
  'scopedOwner', 'adoption', 'error', 'capture', 'records', 'unknown', 'patch', 'mountedClip', 'sourceClip',
  'gestureClip', 'originalClip',
]);
const DIAGNOSTIC_PRIMITIVES = new Set([
  'title', 'phase', 'projectId', 'projectSlug', 'timelineId', 'sourceId', 'originalClipId', 'rightId',
  'expectedPostCount', 'observedPostCount', 'index', 'key', 'baseRevisionId', 'basePublicationId',
  'merge', 'kind', 'ref', 'path', 'state', 'revisionId', 'publicationId', 'providerProjectId',
  'providerTimelineId', 'historyReadFailed', 'method', 'route', 'status', 'replyReadFailed',
  'readFailed', 'ownerId', 'generation', 'intentCount', 'intentId', 'reason', 'rejected',
  'ownerCount', 'intentLengths', 'pendingIntentLengths', 'outcomeKinds', 'hasIdleOwner',
  'hasPending', 'hasIntents', 'hasConflict', 'value', 'numericValue', 'visible', 'text',
  'data-clip-id', 'data-testid', 'data-state', 'data-selected', 'aria-selected',
  'tagName', 'id', 'clipId', 'testId', 'ariaSelected', 'className',
  'connectionState', 'runtimePanelVisible', 'recoveryVisible', 'recoveryMessage',
  'timelineErrorVisible', 'timelineErrorMessage', 'alertCount', 'type', 'signal', 'message',
  'error', 'count', 'summarized', 'truncated', 'outboxReadFailed', 'selectedTimelineMatchesExpectedId',
  'known', 'capture', 'captureData', 'mountedDataRef', 'callbackPatch', 'diagnostic', 'buffer', 'accepted', 'overflow', 'listenerErrors',
  'version', 'scope', 'sequence', 'time', 'ownerAlias', 'sessionState', 'start', 'resolve', 'reject', 'code', 'class', 'stage',
  'from', 'to', 'at', 'hold', 'speed', 'fromState', 'toState', 'atState', 'holdState', 'speedState',
  'generation', 'sessionPresent', 'closed', 'current', 'identityPresent', 'scopeMatched', 'basisStatus', 'gestureKind',
  'status', 'ownerPresent', 'recoverableOwnerCount', 'intentsPendingCount', 'errorStage', 'errorCode', 'errorClass', 'dependencyBaselinePresent', 'providerChanged', 'timelineChanged', 'headChanged', 'dataRefChanged', 'editSeqRefChanged', 'adoptionChanged', 'ownerChanged', 'resolverChanged', 'localSaveChanged', 'basisReadOrdinal', 'operation', 'operationOrdinal', 'operationState',
  'schemaVersion', 'expectedStatus', 'capturedAt', 'durationMs', 'cappedConsole', 'captureResolution', 'sourceAsset', 'present', 'bytes', 'sameAsPrevious', 'sameAsIndex',
]);

function diagnosticPrimitive(value: unknown): unknown {
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 'UNKNOWN';
}

const DIAGNOSTIC_HEAD_FIELDS = new Set([
  'head', 'replyHead', 'beforeHead', 'splitHead', 'agentHead', 'runtimeHistoryHead', 'acceptedHead',
]);

function diagnosticHeadFields(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'UNKNOWN';
  const record = value as Record<string, unknown>;
  const identifier = (field: unknown) => typeof field === 'string' && /^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(field)
    ? field : 'UNKNOWN';
  return { revisionId: identifier(record.revisionId), publicationId: record.publicationId === null ? null : identifier(record.publicationId) };
}

export function diagnosticStructure(value: unknown, depth = 0): unknown {
  if (depth >= DIAGNOSTIC_MAX_DEPTH) return 'UNKNOWN';
  if (!value || typeof value !== 'object') return diagnosticPrimitive(value);
  if (Array.isArray(value)) return value.slice(0, DIAGNOSTIC_MAX_ARRAY_ITEMS).map((item) => diagnosticStructure(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const key of [...DIAGNOSTIC_CONTAINERS, ...DIAGNOSTIC_PRIMITIVES]) {
    try {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const field = (value as Record<string, unknown>)[key];
      result[key] = key === 'sourceAsset' ? 'UNKNOWN'
        : DIAGNOSTIC_HEAD_FIELDS.has(key) ? diagnosticHeadFields(field)
        : DIAGNOSTIC_CONTAINERS.has(key) ? diagnosticStructure(field, depth + 1)
        : Array.isArray(field) && ['path', 'intentLengths', 'pendingIntentLengths', 'outcomeKinds', 'known'].includes(key)
          ? field.slice(0, DIAGNOSTIC_MAX_ARRAY_ITEMS).map(diagnosticPrimitive) : diagnosticPrimitive(field);
    } catch {
      result[key] = 'UNKNOWN';
    }
  }
  return result;
}

function diagnosticArtifactStructure(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (!value || typeof value !== 'object') return diagnosticPrimitive(value);
  try {
    if (ancestors.has(value)) return 'UNKNOWN';
    ancestors.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, DIAGNOSTIC_MAX_ARRAY_ITEMS).map((item) => diagnosticArtifactStructure(item, ancestors));
    }
    const result: Record<string, unknown> = {};
    for (const key of [...DIAGNOSTIC_CONTAINERS, ...DIAGNOSTIC_PRIMITIVES]) {
      try {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const field = (value as Record<string, unknown>)[key];
        result[key] = key === 'sourceAsset' ? 'UNKNOWN'
          : DIAGNOSTIC_HEAD_FIELDS.has(key) ? diagnosticHeadFields(field)
          : DIAGNOSTIC_CONTAINERS.has(key) ? diagnosticArtifactStructure(field, ancestors)
          : Array.isArray(field) && ['path', 'intentLengths', 'pendingIntentLengths', 'outcomeKinds', 'known'].includes(key)
            ? field.slice(0, DIAGNOSTIC_MAX_ARRAY_ITEMS).map(diagnosticPrimitive) : diagnosticPrimitive(field);
      } catch {
        result[key] = 'UNKNOWN';
      }
    }
    return result;
  } catch {
    return 'UNKNOWN';
  } finally {
    ancestors.delete(value);
  }
}

export function diagnosticListener<Args extends unknown[]>(callback: (...args: Args) => unknown): (...args: Args) => Promise<void> | void {
  return (...args) => {
    try {
      return Promise.resolve(callback(...args)).then(() => {}, () => {});
    } catch {
      // Event diagnostics are disposable, including synchronous getters and rejected thenables.
    }
  };
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || /(?:authorization|cookie|token|secret|password|credential|api[_-]?key)/i.test(key);
}

function redactArray(value: unknown[], depth: number): unknown[] {
  const result: unknown[] = [];
  const length = Math.min(value.length, DIAGNOSTIC_MAX_ARRAY_ITEMS);
  for (let index = 0; index < length; index += 1) {
    try {
      result.push(redactDiagnosticValue(value[index], depth + 1));
    } catch {
      result.push('[UNREADABLE]');
    }
  }
  if (value.length > DIAGNOSTIC_MAX_ARRAY_ITEMS) result.push('[TRUNCATED_ARRAY]');
  return result;
}

export function redactDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth >= DIAGNOSTIC_MAX_DEPTH) return '[REDACTED_DEPTH]';
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return '[BIGINT]';
  if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) return '[UNSERIALIZABLE]';

  try {
    if (Array.isArray(value)) return redactArray(value, depth);
  } catch {
    return '[UNREADABLE_ARRAY]';
  }

  const result: Record<string, unknown> = {};
  let visited = 0;
  try {
    for (const key in value as object) {
      if (visited >= DIAGNOSTIC_MAX_KEYS) break;
      visited += 1;
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (isSensitiveKey(key)) continue;
      const safeKey = truncateUtf8(redactDiagnosticText(key), DIAGNOSTIC_MAX_STRING);
      try {
        result[safeKey] = redactDiagnosticValue((value as Record<string, unknown>)[key], depth + 1);
      } catch {
        result[safeKey] = '[UNREADABLE]';
      }
    }
  } catch {
    result['[UNREADABLE_KEYS]'] = true;
  }
  return result;
}

export function formatDiagnostic(label: string, value: unknown): string {
  let safeValue: unknown = '[UNREADABLE]';
  try {
    safeValue = redactDiagnosticValue(value);
  } catch {
    // The diagnostic must remain disposable if a proxy/getter is hostile.
  }
  let body = '"[UNSERIALIZABLE]"';
  try {
    body = JSON.stringify(safeValue) ?? 'null';
  } catch {
    // Keep the fallback free of the original value.
  }
  return truncateUtf8(`[${redactDiagnosticText(label)}] ${body}`, DIAGNOSTIC_MAX_BYTES);
}

export type DiagnosticLogger = (message: string) => void;

function priorityRecord(value: unknown, keys: readonly string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return redactDiagnosticValue(value);
  const result: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    try {
      if (Object.prototype.hasOwnProperty.call(record, key)) result[key] = redactDiagnosticValue(record[key]);
    } catch {
      result[key] = '[UNREADABLE]';
    }
  }
  return result;
}

function priorityList(value: unknown, transform: (item: unknown) => unknown = redactDiagnosticValue): unknown {
  if (!Array.isArray(value)) return redactDiagnosticValue(value);
  const items = value.slice(0, DIAGNOSTIC_PRIORITY_MAX_ITEMS).map((item) => {
    try {
      return transform(item);
    } catch {
      return '[UNREADABLE]';
    }
  });
  return { count: value.length, items, summarized: true, truncated: value.length > DIAGNOSTIC_PRIORITY_MAX_ITEMS };
}

function priorityReads(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.slice(0, DIAGNOSTIC_MAX_ARRAY_ITEMS).map((item) => priorityRecord(item, ['kind', 'ref', 'path', 'state']));
    return { count: value.length, items, summarized: true, truncated: value.length > DIAGNOSTIC_MAX_ARRAY_ITEMS };
  }
  return redactDiagnosticValue(value);
}

function priorityBasis(value: unknown): unknown {
  if (!Array.isArray(value)) return redactDiagnosticValue(value);
  const items = value.slice(0, DIAGNOSTIC_PRIORITY_MAX_ITEMS).map((item) => {
    const safeRecord = priorityRecord(item, ['index', 'key', 'baseRevisionId', 'basePublicationId', 'merge']);
    if (!safeRecord || typeof safeRecord !== 'object' || Array.isArray(safeRecord)) return safeRecord;
    const record = safeRecord as Record<string, unknown>;
    try {
      if (item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, 'reads')) {
        record.reads = priorityReads((item as Record<string, unknown>).reads);
      }
    } catch {
      record.reads = '[UNREADABLE]';
    }
    return record;
  });
  return { count: value.length, items, summarized: true, truncated: value.length > DIAGNOSTIC_PRIORITY_MAX_ITEMS };
}

function priorityOwner(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return redactDiagnosticValue(value);
  const record = value as Record<string, unknown>;
  const result = priorityRecord(record, ['ownerId', 'generation', 'intentCount', 'acceptedHead']);
  try {
    if (Object.prototype.hasOwnProperty.call(record, 'pending')) {
      const pending = record.pending;
      if (!pending || typeof pending !== 'object' || Array.isArray(pending)) {
        result.pending = redactDiagnosticValue(pending);
      } else {
        const pendingRecord = pending as Record<string, unknown>;
        result.pending = priorityRecord(pendingRecord, ['intentId', 'request', 'outcome']);
        if (pendingRecord.request && typeof pendingRecord.request === 'object' && !Array.isArray(pendingRecord.request)) {
          (result.pending as Record<string, unknown>).request = priorityRecord(pendingRecord.request, ['method', 'path', 'key']);
        }
        if (pendingRecord.outcome && typeof pendingRecord.outcome === 'object' && !Array.isArray(pendingRecord.outcome)) {
          (result.pending as Record<string, unknown>).outcome = priorityRecord(pendingRecord.outcome, ['kind', 'status', 'reason']);
        }
      }
    }
  } catch {
    result.pending = '[UNREADABLE]';
  }
  return result;
}

function priorityOutbox(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return redactDiagnosticValue(value);
  const record = value as Record<string, unknown>;
  const result = priorityRecord(record, ['readFailed', 'summary']);
  try {
    if (Object.prototype.hasOwnProperty.call(record, 'owners')) {
      result.owners = Array.isArray(record.owners) ? priorityList(record.owners, priorityOwner) : redactDiagnosticValue(record.owners);
    }
  } catch {
    result.owners = '[UNREADABLE]';
  }
  return result;
}

function priorityValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  let recognized = false;
  const read = (key: string, transform: (field: unknown) => unknown = redactDiagnosticValue) => {
    try {
      if (!Object.prototype.hasOwnProperty.call(record, key)) return;
      recognized = true;
      result[key] = transform(record[key]);
    } catch {
      recognized = true;
      result[key] = '[UNREADABLE]';
    }
  };
  read('case', (field) => priorityRecord(field, [
    'projectId', 'projectSlug', 'timelineId', 'sourceId', 'originalClipId', 'rightId', 'expectedPostCount', 'observedPostCount',
  ]));
  read('basis', priorityBasis);
  read('displayedHead', (field) => priorityRecord(field, [
    'revisionId', 'publicationId', 'providerProjectId', 'providerTimelineId', 'commitReplies', 'currentWireHeads', 'readonlyReplies', 'runtimeHistoryHead', 'historyReadFailed',
  ]));
  read('outbox', priorityOutbox);
  read('sourceWindow', (field) => priorityRecord(field, ['rightId', 'before', 'after']));
  read('ui', (field) => priorityRecord(field, [
    'connectionState', 'runtimePanelVisible', 'recoveryVisible', 'recoveryMessage', 'timelineErrorVisible', 'timelineErrorMessage', 'alertCount',
  ]));
  read('errors', (field) => priorityRecord(field, ['page', 'console', 'requestFailures']));

  if (!recognized) return null;
  if ('displayedHead' in result && result.displayedHead && typeof result.displayedHead === 'object') {
    const displayedHead = result.displayedHead as Record<string, unknown>;
    if (Array.isArray(displayedHead.commitReplies)) {
      displayedHead.commitReplies = priorityList(displayedHead.commitReplies, (item) => priorityRecord(item, ['index', 'head']));
    }
    if (Array.isArray(displayedHead.currentWireHeads)) {
      displayedHead.currentWireHeads = priorityList(displayedHead.currentWireHeads, (item) => priorityRecord(item, [
        'method', 'route', 'key', 'status', 'head', 'replyReadFailed',
      ]));
    }
    if (Array.isArray(displayedHead.readonlyReplies)) {
      displayedHead.readonlyReplies = priorityList(displayedHead.readonlyReplies, (item) => priorityRecord(item, ['route', 'status', 'head']));
    }
  }
  if ('outbox' in result && result.outbox && typeof result.outbox === 'object') {
    const outbox = result.outbox as Record<string, unknown>;
    if ('summary' in outbox) outbox.summary = priorityRecord(outbox.summary, [
      'ownerCount', 'intentLengths', 'pendingIntentLengths', 'outcomeKinds', 'hasIdleOwner', 'hasPending', 'hasIntents', 'hasConflict',
    ]);
  }
  if ('errors' in result && result.errors && typeof result.errors === 'object') {
    const errors = result.errors as Record<string, unknown>;
    for (const key of ['page', 'console', 'requestFailures']) {
      if (key in errors) errors[key] = priorityList(errors[key]);
    }
  }
  return result;
}

export function formatPriorityDiagnostic(label: string, value: unknown): string {
  const prefix = `[${redactDiagnosticText(label)}] `;
  let safeValue: unknown = { diagnostic: 'priority_over_budget' };
  try {
    safeValue = priorityValue(diagnosticStructure(value)) ?? { diagnostic: 'priority_over_budget' };
  } catch {
    // Priority state is best effort and must never affect the assertion.
  }
  let body = '{"diagnostic":"priority_unavailable"}';
  try {
    body = JSON.stringify(safeValue) ?? 'null';
  } catch {
    // Keep the fallback free of the original value.
  }
  const candidate = prefix + body;
  if (new TextEncoder().encode(candidate).length <= DIAGNOSTIC_MAX_BYTES) return candidate;
  return `${prefix}{"diagnostic":"priority_over_budget"}`;
}

export function formatDiagnosticArtifact(value: unknown): string {
  let safeValue: unknown = { diagnostic: 'artifact_unavailable' };
  try {
    safeValue = diagnosticArtifactStructure(value);
  } catch {
    // Artifact formatting is best effort and must never affect the assertion under test.
  }
  try {
    return `${JSON.stringify(safeValue, null, 2) ?? '{"diagnostic":"artifact_unavailable"}'}\n`;
  } catch {
    return '{"diagnostic":"artifact_unavailable"}\n';
  }
}

export type DiagnosticArtifactTestInfo = {
  outputPath(...pathSegments: string[]): string;
  attach(name: string, options: { path: string; contentType: string }): Promise<void>;
};

export async function withDiagnosticDeadline<T>(
  operation: () => T | PromiseLike<T>,
  fallback: T,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function boundedDiagnosticRead<T>(
  operation: () => T | PromiseLike<T>,
  fallback: T,
  deadline: number,
  timeoutMs = DIAGNOSTIC_READ_TIMEOUT_MS,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(fallback);
  return withDiagnosticDeadline(operation, fallback, Math.min(timeoutMs, remaining));
}

export async function writeDiagnosticArtifact(testInfo: DiagnosticArtifactTestInfo, value: unknown): Promise<boolean> {
  try {
    const artifactPath = testInfo.outputPath('p1-diagnostic.json');
    await writeFile(artifactPath, formatDiagnosticArtifact(value), 'utf8');
    await testInfo.attach('p1-diagnostic', { path: artifactPath, contentType: 'application/json' });
    return true;
  } catch {
    // A failed artifact write must not replace the original test failure.
    return false;
  }
}

export function logDiagnostic(label: string, value: unknown, logger?: DiagnosticLogger): void {
  let message = '[P1 diagnostic unavailable]';
  try {
    message = formatDiagnostic(label, diagnosticStructure(value));
  } catch {
    // Formatting is best effort and must never affect the assertion under test.
  }
  try {
    (logger ?? ((line: string) => console.log(line)))(message);
  } catch {
    try {
      if (!logger) console.log('[P1 diagnostic unavailable]');
    } catch {
      // The final stdout fallback is also best effort.
    }
  }
}

export function logPriorityDiagnostic(label: string, value: unknown, logger?: DiagnosticLogger): void {
  let message = '[P1 priority diagnostic unavailable]';
  try {
    message = formatPriorityDiagnostic(label, value);
  } catch {
    // Formatting is best effort and must never affect the assertion under test.
  }
  try {
    (logger ?? ((line: string) => console.log(line)))(message);
  } catch {
    try {
      if (!logger) console.log('[P1 priority diagnostic unavailable]');
    } catch {
      // The final stdout fallback is also best effort.
    }
  }
}

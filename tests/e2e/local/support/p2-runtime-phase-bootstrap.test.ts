import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AstridCli } from './astrid.ts';
import { P2_PHASE_CAPTURE_FILE, p2CommitPhaseCaptureConfig, RUNTIME_CHECKOUT, startDirectHarness } from './harness.ts';

const python = process.env.ASTRID_RUNTIME_PYTHON ?? 'python3';
const runtimeCheckout = RUNTIME_CHECKOUT;
const bootstrapDirectory = path.resolve('scripts/testing');
const NORMAL_HELPER_SHA256 = 'a17a92115661fcef13b49169504ad8726e6f6c0cdce66b195128b14477fa76a4';
const REVIEWED_HELPER_SHA256 = '6c9daef27884c30b8faf234349078310af7ebe016bf0c4339960d5baae5a0760';
const REVIEWED_NEW_HELPER_SHA256 = '4ee0424b63f1f9847995a605dc1050ad7cb8ca75f4d64b8c36d851cfe723f41e';
const REVIEWED_PROFILER_HELPER_SHA256 = '095c252b111a6d43cb5b4b9ed284b5a445b8b6fe69ca0ad4ee6950f1383c352d';
const CAPTURE_SCHEMA_VERSION = 1;
const RETENTION_FORMAT_VERSION = 2;
const NORMAL_PHASES = ['dispatch_queue', 'handler_entry', 'authorization', 'coordinator_admission', 'coordinator_lock', 'provider', 'accept', 'receipt', 'http_response'];
const REVIEWED_PHASES = ['arrival', ...NORMAL_PHASES];
const NEW_LIFECYCLE_VALUES = ['completed', 'raised', 'returned_without_response', 'pending_at_stop'];
const MAX_REQUESTS = 8;
const MAX_EVENTS = 128;
const MAX_BYTES = 64 * 1024;
const MAX_PHASE_COUNT = 32;
const PRIVATE_VALUE = /(?:bearer\s|private|marker|content-type|raw[_-]?body|authorization|password|secret|token|credential|stack(?:trace)?|traceback|exception)/i;

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

function assertFiniteNumber(value: unknown, label: string, { nonnegative = false } = {}): asserts value is number {
  assert.equal(typeof value, 'number', label);
  assert.ok(Number.isFinite(value), label);
  if (nonnegative) assert.ok(value >= 0, label);
}

function assertNumberOrNull(value: unknown, label: string): void {
  if (value !== null) assertFiniteNumber(value, label);
}

function assertInteger(value: unknown, label: string, { minimum = 0, maximum }: { minimum?: number; maximum?: number } = {}): asserts value is number {
  assert.equal(typeof value, 'number', label);
  assert.ok(Number.isInteger(value) && value >= minimum, label);
  if (maximum !== undefined) assert.ok(value <= maximum, label);
}

function assertSafeIdentifier(value: unknown, label: string): void {
  assert.equal(typeof value, 'string', label);
  assert.match(value, /^(?:[A-Za-z_][A-Za-z0-9_]*|<[^<>\r\n]{1,64}>)$/, label);
  assert.doesNotMatch(value, PRIVATE_VALUE, label);
}

function assertTimestamp(value: unknown, label: string): void {
  assertFiniteNumber(value, label, { nonnegative: true });
}

function assertNoPrivateKeys(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (!REVIEWED_PHASES.includes(key)) {
      assert.doesNotMatch(key, /^(?:body|raw_body|headers?|authorization|auth|url|stack|traceback|exception|credentials?|token|password|secret|idempotency_key)$/i);
    }
    assertNoPrivateKeys(child);
  }
}

function assertPhaseMap(phases: unknown, reviewed: boolean): void {
  assert.ok(phases && typeof phases === 'object' && !Array.isArray(phases));
  const rows = phases as Record<string, unknown>;
  const phaseNames = reviewed ? REVIEWED_PHASES : NORMAL_PHASES;
  exactKeys(rows, phaseNames);
  for (const phase of phaseNames) {
    const row = rows[phase];
    const state = record(row, `${phase} state`);
    const unsupportedArrival = reviewed && phase === 'arrival';
    exactKeys(state, unsupportedArrival ? ['status', 'count', 'start_ms', 'end_ms', 'reason'] : ['status', 'count', 'start_ms', 'end_ms']);
    assertInteger(state.count, `${phase}.count`, { maximum: MAX_PHASE_COUNT });
    if (unsupportedArrival) {
      assert.equal(state.status, 'unsupported');
      assert.equal(state.count, 0);
      assert.equal(state.start_ms, null);
      assert.equal(state.end_ms, null);
      assert.equal(state.reason, 'no earlier socket/server-accept hook');
      continue;
    }
    if (state.count === 0) {
      assert.equal(state.status, 'UNKNOWN');
      assert.equal(state.start_ms, null);
      assert.equal(state.end_ms, null);
    } else {
      assert.ok(state.status === 'observed' || state.status === 'raised');
      assertTimestamp(state.start_ms, `${phase}.start_ms`);
      assertNumberOrNull(state.end_ms, `${phase}.end_ms`);
      if (state.end_ms !== null) assert.ok(state.end_ms >= state.start_ms, `${phase}.end_ms`);
      if (state.status === 'raised') assert.notEqual(state.end_ms, null, `${phase}.raised end`);
    }
  }
}

function assertRetention(value: unknown, newSchema = false): void {
  const retention = record(value, 'retention');
  exactKeys(retention, ['format_version', 'mode', 'rolling', 'final_request', 'output']);
  assert.equal(retention.format_version, RETENTION_FORMAT_VERSION);
  assert.equal(retention.mode, 'rolling_plus_final_request');
  const rolling = record(retention.rolling, 'retention.rolling');
  exactKeys(rolling, ['capacity_events', 'events_seen', 'events_retained', 'capacity_dropped_events', 'complete', 'incomplete_limit']);
  assertInteger(rolling.capacity_events, 'capacity_events');
  assertInteger(rolling.events_seen, 'events_seen');
  assertInteger(rolling.events_retained, 'events_retained');
  assertInteger(rolling.capacity_dropped_events, 'capacity_dropped_events');
  assert.equal(rolling.capacity_events, MAX_EVENTS);
  const rollingCount = Math.min(rolling.events_seen, rolling.capacity_events);
  assert.ok(rolling.events_retained <= rollingCount);
  assert.equal(rolling.capacity_dropped_events, Math.max(0, rolling.events_seen - rolling.capacity_events));
  assert.equal(typeof rolling.complete, 'boolean');
  if (rolling.complete) {
    assert.equal(rolling.events_retained, rollingCount);
    assert.equal(rolling.incomplete_limit, null);
  } else {
    const limit = record(rolling.incomplete_limit, 'rolling.incomplete_limit');
    assertDropLimit(limit, 'rolling.incomplete_limit');
    assert.equal(limit.dropped_events, rollingCount - rolling.events_retained);
  }
  const output = record(retention.output, 'retention.output');
  exactKeys(output, ['max_bytes', 'bytes', 'events']);
  assertInteger(output.max_bytes, 'output.max_bytes');
  assertInteger(output.bytes, 'output.bytes', { maximum: MAX_BYTES });
  assertInteger(output.events, 'output.events');
  assert.equal(output.max_bytes, MAX_BYTES);
  assert.equal(output.bytes === 0, output.events === 0);
  assert.ok(output.events <= rolling.events_seen);
  assert.ok(rolling.events_retained <= output.events);
  if (retention.final_request === null) return;
  const finalRequest = record(retention.final_request, 'retention.final_request');
  exactKeys(finalRequest, newSchema
    ? ['request', 'outcome', 'events_seen', 'events_retained', 'buffer_complete', 'complete', 'incomplete_limit']
    : ['request', 'outcome', 'events_seen', 'events_retained', 'complete', 'incomplete_limit']);
  assertInteger(finalRequest.request, 'final_request.request', { minimum: 1, maximum: MAX_REQUESTS });
  assert.ok((newSchema ? NEW_LIFECYCLE_VALUES : ['complete', 'failed', 'pending']).includes(finalRequest.outcome as string));
  assertInteger(finalRequest.events_seen, 'final_request.events_seen');
  assertInteger(finalRequest.events_retained, 'final_request.events_retained');
  assert.ok(finalRequest.events_retained <= finalRequest.events_seen);
  assert.ok(finalRequest.events_retained <= output.events);
  if (newSchema) assert.equal(typeof finalRequest.buffer_complete, 'boolean');
  assert.equal(typeof finalRequest.complete, 'boolean');
  if (newSchema) assert.equal(finalRequest.buffer_complete, finalRequest.complete);
  if (finalRequest.complete) assert.equal(finalRequest.incomplete_limit, null);
  else {
    const limit = record(finalRequest.incomplete_limit, 'final_request.incomplete_limit');
    assertDropLimit(limit, 'final_request.incomplete_limit', true);
    assert.ok(limit.required_bytes >= limit.retained_bytes);
    assert.equal(limit.required_bytes, limit.retained_bytes + limit.dropped_bytes);
  }
}

function assertDropLimit(limit: Record<string, unknown>, label: string, requestLimit = false): void {
  exactKeys(limit, requestLimit
    ? ['reason', 'limit_bytes', 'required_bytes', 'retained_bytes', 'dropped_events', 'dropped_bytes']
    : ['reason', 'limit_bytes', 'dropped_events', 'dropped_bytes']);
  assert.equal(limit.reason, 'max_bytes', label);
  assertInteger(limit.limit_bytes, `${label}.limit_bytes`);
  assert.equal(limit.limit_bytes, MAX_BYTES);
  assertInteger(limit.dropped_events, `${label}.dropped_events`, { minimum: 1 });
  assertInteger(limit.dropped_bytes, `${label}.dropped_bytes`, { minimum: 1 });
  if (requestLimit) {
    assertInteger(limit.required_bytes, `${label}.required_bytes`);
    assertInteger(limit.retained_bytes, `${label}.retained_bytes`);
    assert.ok(limit.required_bytes >= limit.retained_bytes);
  }
}

function assertSampling(value: unknown, newSchema = false): void {
  const sampling = record(value, 'sampling');
  exactKeys(sampling, newSchema
    ? ['sampling_interval_ms', 'sample_total', 'lost_samples', 'observer_cpu_ms', 'observer_cpu_scope', 'observer_cpu_attribution', 'top_inclusive_frames', 'top_leaf_frames', 'sample_membership', 'dispatch_wall_denominator_ms', 'counter_limits', 'sampler_errors']
    : ['sampling_interval_ms', 'sample_total', 'lost_samples', 'observer_cpu_ms', 'observer_cpu_scope', 'observer_cpu_attribution', 'top_inclusive_frames', 'sample_membership', 'dispatch_wall_denominator_ms', 'counter_limits', 'sampler_errors']);
  assertFiniteNumber(sampling.sampling_interval_ms, 'sampling_interval_ms', { nonnegative: true });
  assert.equal(sampling.sampling_interval_ms, 20);
  assertInteger(sampling.sample_total, 'sample_total');
  assertInteger(sampling.lost_samples, 'lost_samples');
  assertFiniteNumber(sampling.observer_cpu_ms, 'observer_cpu_ms', { nonnegative: true });
  assert.equal(sampling.observer_cpu_scope, 'capture-wide');
  assert.equal(sampling.observer_cpu_attribution, 'sampler CPU covers the whole capture and is not attributed to this request');
  assert.equal(sampling.sample_membership, 'each safe frame identity is counted at most once per sample');
  assertNumberOrNull(sampling.dispatch_wall_denominator_ms, 'dispatch_wall_denominator_ms');
  if (sampling.dispatch_wall_denominator_ms !== null) assert.ok(sampling.dispatch_wall_denominator_ms > 0);
  assert.ok(Array.isArray(sampling.sampler_errors));
  for (const error of sampling.sampler_errors) assertSafeIdentifier(error, 'sampler_errors');
  const limits = record(sampling.counter_limits, 'counter_limits');
  exactKeys(limits, ['max_requests', 'max_events', 'max_bytes', 'top_frames']);
  assert.deepEqual(limits, { max_requests: 8, max_events: 128, max_bytes: 64 * 1024, top_frames: 10 });
  const assertFrameRows = (value: unknown, label: string): void => {
    assert.ok(Array.isArray(value), label);
    assert.ok(value.length <= 10, label);
    const seenFrames = new Set<string>();
    for (const frame of value) {
      const row = record(frame, 'top_inclusive_frames row');
      exactKeys(row, newSchema
        ? ['file', 'function', 'line', 'sample_count', 'sample_total', 'lost_samples', 'sample_share', 'dispatch_wall_share']
        : ['file', 'function', 'line', 'sample_count', 'sample_total', 'sample_share', 'dispatch_wall_share']);
      assert.equal(typeof row.file, 'string');
      assert.match(row.file, /^<(?:runtime|agent|stdlib)>\/[A-Za-z0-9_./<>-]+$/);
      assert.doesNotMatch(row.file, PRIVATE_VALUE);
      assertSafeIdentifier(row.function, 'frame.function');
      assertInteger(row.line, 'frame.line', { minimum: 1 });
      assertInteger(row.sample_count, 'frame.sample_count', { minimum: 1 });
      assertInteger(row.sample_total, 'frame.sample_total');
      assert.equal(row.sample_total, sampling.sample_total);
      assert.ok(row.sample_count <= row.sample_total);
      if (newSchema) {
        assertInteger(row.lost_samples, 'frame.lost_samples');
        assert.equal(row.lost_samples, sampling.lost_samples);
      }
      assertFiniteNumber(row.sample_share, 'sample_share', { nonnegative: true });
      assert.ok(row.sample_share <= 1);
      assert.equal(row.sample_total === 0, false);
      assert.ok(Math.abs(row.sample_share - row.sample_count / row.sample_total) < 1e-12);
      assertNumberOrNull(row.dispatch_wall_share, 'dispatch_wall_share');
      if (row.dispatch_wall_share !== null) {
        assert.ok(row.dispatch_wall_share >= 0);
        assert.ok(sampling.dispatch_wall_denominator_ms !== null);
        assert.ok(Math.abs(row.dispatch_wall_share - (row.sample_count * 20 / sampling.dispatch_wall_denominator_ms)) < 1e-12);
      } else if (newSchema) {
        assert.equal(sampling.dispatch_wall_denominator_ms, null);
      }
      if (newSchema && sampling.dispatch_wall_denominator_ms !== null) assert.notEqual(row.dispatch_wall_share, null);
      const identity = `${row.file}\0${row.function}\0${row.line}`;
      assert.equal(seenFrames.has(identity), false);
      seenFrames.add(identity);
    }
  };
  assertFrameRows(sampling.top_inclusive_frames, 'top_inclusive_frames');
  if (newSchema) assertFrameRows(sampling.top_leaf_frames, 'top_leaf_frames');
}

function assertProfileFunction(value: unknown, label: string): asserts value is string {
  assert.equal(typeof value, 'string', label);
  assert.ok(value.length > 0 && value.length <= 160, label);
  assert.match(value, /^[A-Za-z0-9_.$<>:' -]+$/, label);
  assert.doesNotMatch(value, PRIVATE_VALUE, label);
}

function assertProfileFile(value: unknown, label: string): asserts value is string {
  assert.equal(typeof value, 'string', label);
  assert.match(value, /^<(?:runtime|agent|stdlib|package)>\/[A-Za-z0-9_./<>-]+$/, label);
  assert.doesNotMatch(value, /(?:^|\/)\.\.(?:\/|$)/, label);
  assert.doesNotMatch(value, PRIVATE_VALUE, label);
}

function assertProfileEndpoint(value: unknown, label: string): void {
  const endpoint = record(value, label);
  exactKeys(endpoint, ['file', 'line', 'function']);
  assertProfileFile(endpoint.file, `${label}.file`);
  assertInteger(endpoint.line, `${label}.line`);
  assertProfileFunction(endpoint.function, `${label}.function`);
}

function assertCProfile(value: unknown): void {
  const profile = record(value, 'cprofile');
  exactKeys(profile, ['format_version', 'status', 'scope', 'functions', 'edges', 'limits', 'rank_meaning', 'timing_note']);
  assert.equal(profile.format_version, 1);
  assert.equal(profile.scope, 'RuntimeHandler._timeline_commit');
  assert.equal(profile.status === 'captured' || profile.status === 'unavailable', true);
  const limits = record(profile.limits, 'cprofile.limits');
  exactKeys(limits, ['max_functions', 'max_edges', 'dropped_rows', 'dropped_edges']);
  assertInteger(limits.max_functions, 'cprofile.limits.max_functions', { maximum: 40 });
  assertInteger(limits.max_edges, 'cprofile.limits.max_edges', { maximum: 1600 });
  assertInteger(limits.dropped_rows, 'cprofile.limits.dropped_rows');
  assertInteger(limits.dropped_edges, 'cprofile.limits.dropped_edges');
  assert.equal(limits.max_functions, 40);
  assert.equal(limits.max_edges, 1600);
  assert.equal(typeof profile.timing_note, 'string');
  assert.match(profile.timing_note, /cProfile overhead/);

  const functions = profile.functions;
  assert.ok(Array.isArray(functions), 'cprofile.functions');
  if (profile.status === 'unavailable') {
    assert.deepEqual(functions, []);
    assert.deepEqual(profile.edges, []);
    assert.equal(profile.rank_meaning, 'unavailable');
    assert.equal(limits.dropped_rows, 0);
    assert.equal(limits.dropped_edges, 0);
    return;
  }

  assert.equal(profile.rank_meaning, 'functions sorted descending cumtime, then file/line/function');
  assert.ok(functions.length <= 40, 'cprofile.functions limit');
  const identities = new Set<string>();
  let previous: Record<string, unknown> | undefined;
  for (let index = 0; index < functions.length; index += 1) {
    const row = record(functions[index], 'cprofile.functions row');
    exactKeys(row, ['rank', 'file', 'line', 'function', 'ncalls', 'primitive_calls', 'tottime', 'cumtime']);
    assertInteger(row.rank, 'cprofile.functions.rank', { minimum: 1, maximum: 40 });
    assert.equal(row.rank, index + 1);
    assertProfileFile(row.file, 'cprofile.functions.file');
    assertInteger(row.line, 'cprofile.functions.line');
    assertProfileFunction(row.function, 'cprofile.functions.function');
    assertInteger(row.ncalls, 'cprofile.functions.ncalls');
    assertInteger(row.primitive_calls, 'cprofile.functions.primitive_calls');
    assertFiniteNumber(row.tottime, 'cprofile.functions.tottime', { nonnegative: true });
    assertFiniteNumber(row.cumtime, 'cprofile.functions.cumtime', { nonnegative: true });
    assert.ok((row.cumtime as number) >= (row.tottime as number), 'cprofile cumulative time');
    const identity = `${row.file}\0${row.line}\0${row.function}`;
    assert.equal(identities.has(identity), false, 'cprofile function identity is unique');
    identities.add(identity);
    if (previous) {
      const order = (previous.cumtime as number) - (row.cumtime as number);
      if (order === 0) {
        const previousKey = `${previous.file}\0${String(previous.line).padStart(10, '0')}\0${previous.function}`;
        const currentKey = `${row.file}\0${String(row.line).padStart(10, '0')}\0${row.function}`;
        assert.ok(previousKey <= currentKey, 'cprofile tie ranking');
      } else {
        assert.ok(order >= 0, 'cprofile cumulative ranking');
      }
    }
    previous = row;
  }

  const edges = profile.edges;
  assert.ok(Array.isArray(edges), 'cprofile.edges');
  assert.ok(edges.length <= 1600, 'cprofile.edges limit');
  const edgeIdentities = new Set<string>();
  for (const edgeValue of edges) {
    const edge = record(edgeValue, 'cprofile edge');
    exactKeys(edge, ['caller', 'callee', 'ncalls']);
    assertProfileEndpoint(edge.caller, 'cprofile.edge.caller');
    assertProfileEndpoint(edge.callee, 'cprofile.edge.callee');
    assertInteger(edge.ncalls, 'cprofile.edge.ncalls');
    const caller = record(edge.caller, 'cprofile.edge.caller');
    const callee = record(edge.callee, 'cprofile.edge.callee');
    const callerIdentity = `${caller.file}\0${caller.line}\0${caller.function}`;
    const calleeIdentity = `${callee.file}\0${callee.line}\0${callee.function}`;
    assert.equal(identities.has(callerIdentity), true, 'cprofile caller is emitted');
    assert.equal(identities.has(calleeIdentity), true, 'cprofile callee is emitted');
    const edgeIdentity = `${callerIdentity}\0${calleeIdentity}`;
    assert.equal(edgeIdentities.has(edgeIdentity), false, 'cprofile edge is unique');
    edgeIdentities.add(edgeIdentity);
  }
}

type CaptureValidatorArm = 'normal' | 'reviewed' | 'reviewed-new' | 'reviewed-profiler';

function assertReviewedNewLifecycle(
  event: Record<string, unknown>,
  phases: Record<string, unknown>,
  durations: Record<string, unknown>,
): void {
  const lifecycle = event.lifecycle as string;
  const dispatch = record(phases.dispatch_queue, 'dispatch_queue phase');
  const response = record(phases.http_response, 'http_response phase');
  const handler = record(phases.handler_entry, 'handler_entry phase');
  const duration = (start: unknown, end: unknown): number | null =>
    typeof start === 'number' && typeof end === 'number' ? Math.round((end - start) * 1000) / 1000 : null;
  const equalDuration = (actual: unknown, expected: number | null, label: string): void => {
    if (expected === null) assert.equal(actual, null, label);
    else {
      assert.equal(typeof actual, 'number', label);
      assert.ok(Math.abs((actual as number) - expected) < 1e-9, label);
    }
  };
  // Frozen 231ddb: queue end is handler entry, not dispatch completion.
  assert.equal(event.dispatch_start_ms, dispatch.start_ms);
  equalDuration(durations.dispatch_queue_ms, duration(dispatch.start_ms, handler.start_ms), 'dispatch queue boundaries');
  for (const [phase, key] of [['provider', 'provider_wall_ms'], ['http_response', 'response_write_wall_ms']]) {
    const state = record(phases[phase], phase);
    equalDuration(durations[key], duration(state.start_ms, state.end_ms), `${phase} boundaries`);
  }
  assert.equal(durations.execution_lock_wait_ms, null);
  assert.equal(durations.caller_receipt_ms, null);
  assert.equal(durations.dispatch_to_completion_wall_ms, durations.dispatch_total_ms);
  // Completion is not exported as a timestamp. Infer it only from an observed
  // duration; missing starts and an error at dispatch return leave it unknown.
  const completion = typeof durations.dispatch_total_ms === 'number' && typeof dispatch.start_ms === 'number'
    ? dispatch.start_ms + durations.dispatch_total_ms
    : typeof durations.handler_ms === 'number' && typeof handler.start_ms === 'number'
      ? handler.start_ms + durations.handler_ms : null;
  equalDuration(durations.dispatch_total_ms, duration(dispatch.start_ms, completion), 'dispatch completion boundaries');
  equalDuration(durations.handler_ms, duration(handler.start_ms, completion), 'handler completion boundaries');
  if (dispatch.status === 'raised') assert.equal(completion, null, 'dispatch error leaves completion unknown');
  if (dispatch.count && handler.count) assert.notEqual(dispatch.end_ms, null, 'handler entry closes the queue');
  if (lifecycle !== 'pending_at_stop' && dispatch.count) {
    assert.notEqual(dispatch.end_ms, null, 'finished dispatch closes an open queue');
  }
  if (lifecycle === 'completed') {
    // Response count wins over dispatch_raised; caught errors can leave all
    // completion durations null even though the lifecycle is completed.
    assert.ok((response.count as number) > 0, 'completed requires an observed response');
  } else if (lifecycle === 'returned_without_response') {
    assert.equal(response.count, 0, 'returned_without_response forbids an observed response');
    if (dispatch.count) {
      assert.equal(dispatch.status, 'observed');
      assert.notEqual(durations.dispatch_total_ms, null, 'observed dispatch return has a completion boundary');
    }
  } else if (lifecycle === 'raised') {
    assert.equal(response.count, 0, 'response completion takes priority over raised');
    assert.equal(completion, null, 'raised dispatch has no completion timestamp');
    if (dispatch.count && !handler.count) assert.equal(dispatch.status, 'raised');
  }
  // pending_at_stop can include a return callback that has set its end time
  // but has not yet acquired the lock to set dispatch_finished.
}

function assertCaptureEvent(event: Record<string, unknown>, arm: CaptureValidatorArm): void {
  const reviewed = arm !== 'normal';
  const profiler = arm === 'reviewed-profiler';
  const newSchema = arm === 'reviewed-new' || profiler;
  assertNoPrivateKeys(event);
  const phase = event.phase;
  assert.equal(event.schema_version, CAPTURE_SCHEMA_VERSION);
  assertInteger(event.request, 'request', { minimum: 1, maximum: MAX_REQUESTS });
  if (phase !== 'summary' || reviewed) assertFiniteNumber(event.at_ms, 'at_ms', { nonnegative: true });
  if (phase === 'summary') {
    exactKeys(event, reviewed
      ? [...(newSchema ? ['lifecycle'] : []), 'schema_version', 'request', 'phase', 'last_phase', 'phases', 'durations_ms', 'utc', 'at_ms', 'capture_anchor', 'capture_namespace', 'pid', 'birth_ticks', 'method', 'route_template', 'idempotency_key_sha256', 'dispatch_start_ms', 'sampling', 'unknown_boundaries', 'unsupported_boundaries', 'truncated', 'retention', ...(profiler ? ['cprofile'] : [])]
      : ['schema_version', 'request', 'phase', 'last_phase', 'phases', 'durations_ms', 'unknown_boundaries', 'truncated', 'retention']);
    assert.equal(typeof event.last_phase, 'string');
    assert.ok([...NORMAL_PHASES, 'UNKNOWN'].includes(event.last_phase as string));
    if (newSchema) assert.ok(NEW_LIFECYCLE_VALUES.includes(event.lifecycle as string));
    assertPhaseMap(event.phases, reviewed);
    const durations = record(event.durations_ms, 'durations_ms');
    const durationKeys = reviewed
      ? ['dispatch_queue_ms', 'handler_ms', 'dispatch_total_ms', 'dispatch_to_completion_wall_ms', 'provider_wall_ms', 'response_write_wall_ms', 'execution_lock_wait_ms', 'caller_receipt_ms']
      : ['dispatch_queue_ms', 'handler_ms', 'dispatch_total_ms', 'provider_wall_ms', 'response_write_wall_ms', 'execution_lock_wait_ms', 'caller_receipt_ms'];
    exactKeys(durations, durationKeys);
    for (const [key, value] of Object.entries(durations)) {
      assertNumberOrNull(value, `duration ${key}`);
      if (value !== null) assert.ok(value >= 0, `duration ${key}`);
    }
    if (durations.dispatch_total_ms !== null && durations.dispatch_queue_ms !== null && durations.handler_ms !== null) {
      assert.ok(Math.abs(durations.dispatch_total_ms - (durations.dispatch_queue_ms + durations.handler_ms)) < 1e-9);
    }
    if (reviewed) assert.equal(durations.dispatch_to_completion_wall_ms, durations.dispatch_total_ms);
    assert.equal(typeof event.truncated, 'boolean');
    if (newSchema) {
      assertReviewedNewLifecycle(event, event.phases as Record<string, unknown>, durations);
    }
    assertRetention(event.retention, newSchema);
    if (newSchema) {
      const finalRequest = record(event.retention, 'retention').final_request;
      if (finalRequest === null) {
        assert.equal(event.lifecycle, 'completed', 'a non-completed summary must be retained as final_request');
      } else {
        const final = record(finalRequest, 'retention.final_request');
        assert.notEqual(final.outcome, 'completed', 'final_request selects a non-completed request');
        if (final.request === event.request) assert.equal(final.outcome, event.lifecycle, 'final_request outcome matches its summary');
      }
    }
    if (profiler) assertCProfile(event.cprofile);
    const unknown = record(event.unknown_boundaries, 'unknown_boundaries');
    exactKeys(unknown, reviewed
      ? ['client_request_to_server_receive', 'request_body_receive', 'execution_lock_wait', 'caller_receipt']
      : ['client_request_to_server_receive', 'execution_lock_wait', 'caller_receipt']);
    assert.equal(unknown.client_request_to_server_receive, reviewed ? 'unsupported: no earlier socket/server-accept hook' : 'outside Runtime process');
    if (reviewed) assert.equal(unknown.request_body_receive, 'unsupported: no body-read hook; body time is not separately measured');
    assert.equal(unknown.execution_lock_wait, 'phase hook has no exact threading.Lock.acquire boundary');
    assert.equal(unknown.caller_receipt, 'outside Runtime process');
    if (reviewed) {
      assert.match(event.utc as string, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      const anchor = record(event.capture_anchor, 'capture_anchor');
      exactKeys(anchor, ['utc', 'at_ms']);
      assert.match(anchor.utc as string, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.equal(anchor.at_ms, 0);
      assert.match(event.capture_namespace as string, /^pid-\d+-birth-(?:\d+|unknown)-capture-\d+$/);
      assertInteger(event.pid, 'pid', { minimum: 1 });
      if (event.birth_ticks !== null) assertInteger(event.birth_ticks, 'birth_ticks');
      assert.equal(event.method, 'POST');
      assert.equal(event.route_template, '/v1/projects/{project_id}/timelines/{timeline_id}/commit');
      assert.match(event.idempotency_key_sha256 as string, /^[0-9a-f]{64}$/);
      assertNumberOrNull(event.dispatch_start_ms, 'dispatch_start_ms');
      if (event.dispatch_start_ms !== null) assert.ok(event.dispatch_start_ms >= 0);
      assertSampling(event.sampling, newSchema);
      if (newSchema) {
        const sampling = record(event.sampling, 'sampling');
        assert.equal(sampling.dispatch_wall_denominator_ms, durations.dispatch_to_completion_wall_ms);
      }
      const unsupported = record(event.unsupported_boundaries, 'unsupported_boundaries');
      exactKeys(unsupported, ['network_arrival_ms', 'request_body_receive_ms', 'execution_lock_wait_ms', 'caller_receipt_ms']);
      assert.deepEqual(unsupported, { network_arrival_ms: null, request_body_receive_ms: null, execution_lock_wait_ms: null, caller_receipt_ms: null });
    }
    return;
  }
  assert.ok(typeof phase === 'string' && NORMAL_PHASES.includes(phase));
  const expectedKeys = ['schema_version', 'request', 'phase', 'state', 'at_ms', 'count', ...(phase === 'http_response' ? ['status'] : [])];
  if (reviewed && ['dispatch_queue', 'coordinator_lock', 'handler_entry'].includes(phase as string)) {
    expectedKeys.push('namespace', 'capture_namespace', 'pid', 'birth_ticks', 'utc', 'method', 'route_template', 'idempotency_key_sha256');
  } else if (reviewed) {
    expectedKeys.push('utc', 'capture_namespace');
  }
  exactKeys(event, expectedKeys);
  assert.ok(['start', 'end', 'raised'].includes(event.state as string));
  assertInteger(event.count, 'event.count', { minimum: 1, maximum: MAX_PHASE_COUNT });
  if (phase === 'http_response') {
    assert.equal(typeof event.status, 'number');
    assert.ok(Number.isInteger(event.status) && (event.status as number) >= 100 && (event.status as number) <= 599);
  }
  if (reviewed) {
    assert.match(event.utc as string, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.match(event.capture_namespace as string, /^pid-\d+-birth-(?:\d+|unknown)-capture-\d+$/);
    if (['dispatch_queue', 'coordinator_lock', 'handler_entry'].includes(phase as string)) {
      assert.equal(event.namespace, phase);
      assertInteger(event.pid, 'event.pid', { minimum: 1 });
      assert.equal(event.method, 'POST');
      assert.equal(event.route_template, '/v1/projects/{project_id}/timelines/{timeline_id}/commit');
      assert.match(event.idempotency_key_sha256 as string, /^[0-9a-f]{64}$/);
    }
  }
}

test('D105 launch ownership gives each retained DirectHarness start a distinct sink while keeping ordinal one unchanged', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p2-runtime-launch-ordinal-'));
  const first = p2CommitPhaseCaptureConfig(root, 1)!;
  const second = p2CommitPhaseCaptureConfig(root, 2)!;
  assert.equal(path.basename(first.sink), P2_PHASE_CAPTURE_FILE);
  assert.equal(path.basename(second.sink), 'p2-commit-phase-2.jsonl');
  assert.notEqual(first.sink, second.sink);
});

function assertSourcePinnedHelper(config: { helper: string; helperSha256: string }): void {
  if (config.helperSha256 === NORMAL_HELPER_SHA256) {
    assert.equal(config.helper, path.join(runtimeCheckout, 'tests/helpers/p2_commit_phase_capture.py'));
  } else if (config.helperSha256 === REVIEWED_HELPER_SHA256) {
    assert.equal(config.helperSha256, REVIEWED_HELPER_SHA256);
    assert.equal(path.basename(config.helper), 'p2_commit_phase_capture.py');
  } else if (config.helperSha256 === REVIEWED_PROFILER_HELPER_SHA256) {
    assert.equal(config.helperSha256, REVIEWED_PROFILER_HELPER_SHA256);
    assert.equal(path.basename(config.helper), 'p2_commit_phase_capture.py');
  } else {
    assert.equal(config.helperSha256, REVIEWED_NEW_HELPER_SHA256);
    assert.equal(path.basename(config.helper), 'p2_commit_phase_capture.py');
  }
}

test('D127c source guard accepts every reviewed arm and rejects wrong hash or source', () => {
  const helper = path.join(runtimeCheckout, 'tests/helpers/p2_commit_phase_capture.py');
  for (const helperSha256 of [NORMAL_HELPER_SHA256, REVIEWED_HELPER_SHA256, REVIEWED_NEW_HELPER_SHA256, REVIEWED_PROFILER_HELPER_SHA256]) {
    assert.doesNotThrow(() => assertSourcePinnedHelper({ helper, helperSha256 }));
  }
  assert.throws(
    () => assertSourcePinnedHelper({ helper, helperSha256: `${REVIEWED_PROFILER_HELPER_SHA256.slice(0, -1)}0` }),
    /Expected values to be strictly equal/,
  );
  assert.throws(
    () => assertSourcePinnedHelper({ helper: path.join(path.dirname(helper), 'unknown-helper.py'), helperSha256: REVIEWED_PROFILER_HELPER_SHA256 }),
    /Expected values to be strictly equal/,
  );
});

function readCapture(sink: string, helperSha256: string): string {
  const text = readFileSync(sink, 'utf8');
  assert.ok(text.length <= 64 * 1024);
  assert.ok([NORMAL_HELPER_SHA256, REVIEWED_HELPER_SHA256, REVIEWED_NEW_HELPER_SHA256, REVIEWED_PROFILER_HELPER_SHA256].includes(helperSha256), `unexpected P2 helper identity: ${helperSha256}`);
  const arm: CaptureValidatorArm = helperSha256 === NORMAL_HELPER_SHA256
    ? 'normal'
    : helperSha256 === REVIEWED_HELPER_SHA256
      ? 'reviewed'
      : helperSha256 === REVIEWED_NEW_HELPER_SHA256
        ? 'reviewed-new'
        : 'reviewed-profiler';
  const events = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(events.length > 0);
  for (const event of events) assertCaptureEvent(event, arm);
  assert.equal(text.includes('p2_commit_phase_capture.py'), false);
  assert.equal(text.includes('Bearer '), false);
  assert.equal(text.includes('Content-Type'), false);
  return text;
}

function newValidatorSummaryFixture(): Record<string, unknown> {
  const phases = Object.fromEntries(REVIEWED_PHASES.map((phase) => [phase, phase === 'arrival'
    ? { status: 'unsupported', count: 0, start_ms: null, end_ms: null, reason: 'no earlier socket/server-accept hook' }
    : phase === 'dispatch_queue'
      ? { status: 'observed', count: 1, start_ms: 0, end_ms: null }
      : { status: 'UNKNOWN', count: 0, start_ms: null, end_ms: null }]));
  const frame = {
    file: '<runtime>/provider.py',
    function: 'commit',
    line: 1,
    sample_count: 1,
    sample_total: 2,
    lost_samples: 1,
    sample_share: 0.5,
    dispatch_wall_share: null,
  };
  const sampling = {
    sampling_interval_ms: 20,
    sample_total: 2,
    lost_samples: 1,
    observer_cpu_ms: 0,
    observer_cpu_scope: 'capture-wide',
    observer_cpu_attribution: 'sampler CPU covers the whole capture and is not attributed to this request',
    top_inclusive_frames: [frame],
    top_leaf_frames: [frame],
    sample_membership: 'each safe frame identity is counted at most once per sample',
    dispatch_wall_denominator_ms: null,
    counter_limits: { max_requests: 8, max_events: 128, max_bytes: 64 * 1024, top_frames: 10 },
    sampler_errors: [],
  };
  return {
    schema_version: CAPTURE_SCHEMA_VERSION,
    request: 1,
    phase: 'summary',
    last_phase: 'dispatch_queue',
    phases,
    lifecycle: 'pending_at_stop',
    durations_ms: {
      dispatch_queue_ms: null,
      handler_ms: null,
      dispatch_total_ms: null,
      dispatch_to_completion_wall_ms: null,
      provider_wall_ms: null,
      response_write_wall_ms: null,
      execution_lock_wait_ms: null,
      caller_receipt_ms: null,
    },
    utc: '2026-10-25T00:00:00.000Z',
    at_ms: 1,
    capture_anchor: { utc: '2026-10-25T00:00:00.000Z', at_ms: 0 },
    capture_namespace: 'pid-1-birth-unknown-capture-1',
    pid: 1,
    birth_ticks: null,
    method: 'POST',
    route_template: '/v1/projects/{project_id}/timelines/{timeline_id}/commit',
    idempotency_key_sha256: 'a'.repeat(64),
    dispatch_start_ms: 0,
    sampling,
    unknown_boundaries: {
      client_request_to_server_receive: 'unsupported: no earlier socket/server-accept hook',
      request_body_receive: 'unsupported: no body-read hook; body time is not separately measured',
      execution_lock_wait: 'phase hook has no exact threading.Lock.acquire boundary',
      caller_receipt: 'outside Runtime process',
    },
    unsupported_boundaries: {
      network_arrival_ms: null,
      request_body_receive_ms: null,
      execution_lock_wait_ms: null,
      caller_receipt_ms: null,
    },
    truncated: false,
    retention: {
      format_version: RETENTION_FORMAT_VERSION,
      mode: 'rolling_plus_final_request',
      rolling: {
        capacity_events: MAX_EVENTS,
        events_seen: 1,
        events_retained: 1,
        capacity_dropped_events: 0,
        complete: true,
        incomplete_limit: null,
      },
      final_request: {
        request: 1,
        outcome: 'pending_at_stop',
        events_seen: 1,
        events_retained: 1,
        buffer_complete: true,
        complete: true,
        incomplete_limit: null,
      },
      output: { max_bytes: MAX_BYTES, bytes: 100, events: 1 },
    },
  };
}

function cProfileFixture(status: 'captured' | 'unavailable' = 'captured'): Record<string, unknown> {
  const limits = { max_functions: 40, max_edges: 1600, dropped_rows: 0, dropped_edges: 0 };
  const base = {
    format_version: 1,
    status,
    scope: 'RuntimeHandler._timeline_commit',
    limits,
    timing_note: 'cProfile overhead inflates absolute times; use ranking and call counts observationally, never as the original budget',
  };
  if (status === 'unavailable') {
    return { ...base, functions: [], edges: [], rank_meaning: 'unavailable' };
  }
  const outer = {
    rank: 1,
    file: '<runtime>/outer.py',
    line: 10,
    function: 'outer',
    ncalls: 2,
    primitive_calls: 1,
    tottime: 0.1,
    cumtime: 0.3,
  };
  const inner = {
    rank: 2,
    file: '<runtime>/inner.py',
    line: 20,
    function: 'inner',
    ncalls: 2,
    primitive_calls: 2,
    tottime: 0.1,
    cumtime: 0.2,
  };
  return {
    ...base,
    functions: [outer, inner],
    edges: [{
      caller: { file: outer.file, line: outer.line, function: outer.function },
      callee: { file: inner.file, line: inner.line, function: inner.function },
      ncalls: 2,
    }],
    rank_meaning: 'functions sorted descending cumtime, then file/line/function',
  };
}

test('D127c reviewed-profiler validator enforces the exact safe cProfile projection', () => {
  const fixture = newValidatorSummaryFixture();
  fixture.cprofile = cProfileFixture();
  assert.doesNotThrow(() => assertCaptureEvent(fixture, 'reviewed-profiler'));

  const unavailable = newValidatorSummaryFixture();
  unavailable.cprofile = cProfileFixture('unavailable');
  assert.doesNotThrow(() => assertCaptureEvent(unavailable, 'reviewed-profiler'));

  const noEligibleProfile = newValidatorSummaryFixture();
  assert.doesNotThrow(() => assertCaptureEvent(noEligibleProfile, 'reviewed-new'));
  assert.equal('cprofile' in noEligibleProfile, false);

  const rejects = (label: string, mutate: (event: Record<string, any>) => void): void => {
    const mutated = JSON.parse(JSON.stringify(fixture)) as Record<string, any>;
    mutate(mutated);
    assert.throws(() => assertCaptureEvent(mutated, 'reviewed-profiler'), undefined, label);
  };
  rejects('unknown cProfile field is refused', (event) => { event.cprofile.extra = true; });
  rejects('private cProfile payload is refused', (event) => { event.cprofile.payload = 'private'; });
  rejects('private cProfile key hash is refused', (event) => { event.cprofile.key_hashes = ['private']; });
  rejects('private cProfile URL path is refused', (event) => { event.cprofile.functions[0].file = 'https://private.invalid'; });
  rejects('private cProfile locals are refused', (event) => { event.cprofile.locals = {}; });
  rejects('absolute cProfile path is refused', (event) => { event.cprofile.functions[0].file = '/tmp/private.py'; });
  rejects('duplicate cProfile function identity is refused', (event) => {
    event.cprofile.functions[1].file = event.cprofile.functions[0].file;
    event.cprofile.functions[1].line = event.cprofile.functions[0].line;
    event.cprofile.functions[1].function = event.cprofile.functions[0].function;
  });
  rejects('cProfile function bound is refused', (event) => {
    event.cprofile.functions.push({ ...event.cprofile.functions[1], rank: 41 });
  });
  rejects('negative cProfile call counts are refused', (event) => { event.cprofile.functions[0].ncalls = -1; });
  rejects('non-finite cProfile times are refused', (event) => { event.cprofile.functions[0].cumtime = Number.NaN; });
  rejects('negative cProfile times are refused', (event) => { event.cprofile.functions[0].tottime = -0.1; });
  rejects('edge call counts remain exact integers', (event) => { event.cprofile.edges[0].ncalls = 1.5; });
  rejects('edge endpoints remain among emitted functions', (event) => { event.cprofile.edges[0].callee.function = 'missing'; });
  rejects('cProfile truncation limits are fixed', (event) => { event.cprofile.limits.max_edges = 1601; });
  rejects('cProfile rank meaning is fixed', (event) => { event.cprofile.rank_meaning = 'descending tottime'; });
  rejects('cProfile overhead note is required', (event) => { event.cprofile.timing_note = 'fast'; });
  rejects('cProfile status is enumerated', (event) => { event.cprofile.status = 'captured-with-private-data'; });
});

test('D127 reviewed-new validator rejects field, lifecycle, phase, truncation, and safety mutations', () => {
  const fixture = newValidatorSummaryFixture();
  assert.doesNotThrow(() => assertCaptureEvent(fixture, 'reviewed-new'));
  const rejects = (label: string, mutate: (event: Record<string, any>) => void): void => {
    const mutated = JSON.parse(JSON.stringify(fixture)) as Record<string, any>;
    mutate(mutated);
    assert.throws(() => assertCaptureEvent(mutated, 'reviewed-new'), undefined, label);
  };
  rejects('summary lifecycle is required and enumerated', (event) => { delete event.lifecycle; });
  rejects('unknown lifecycle is refused', (event) => { event.lifecycle = 'pending'; });
  rejects('top leaf field is required', (event) => { delete event.sampling.top_leaf_frames; });
  rejects('leaf row lost_samples is required', (event) => { delete event.sampling.top_leaf_frames[0].lost_samples; });
  rejects('leaf row lost_samples must match the sample summary', (event) => { event.sampling.top_leaf_frames[0].lost_samples = 0; });
  rejects('leaf count cannot exceed sample total', (event) => { event.sampling.top_leaf_frames[0].sample_count = 3; });
  rejects('leaf frame identity remains safe', (event) => { event.sampling.top_leaf_frames[0].function = 'private token'; });
  rejects('completion duration cannot omit a known handler boundary', (event) => {
    event.phases.handler_entry = { status: 'observed', count: 1, start_ms: 1, end_ms: null };
    event.phases.dispatch_queue.end_ms = 1;
    event.durations_ms.dispatch_queue_ms = 1;
    event.durations_ms.dispatch_total_ms = 2;
    event.durations_ms.dispatch_to_completion_wall_ms = 2;
  });
  rejects('completed lifecycle requires an observed response', (event) => { event.lifecycle = 'completed'; });
  rejects('returned lifecycle requires no response and ended dispatch state', (event) => {
    event.lifecycle = 'returned_without_response';
    event.durations_ms.dispatch_total_ms = 1;
    event.durations_ms.dispatch_to_completion_wall_ms = 1;
    event.phases.http_response = { status: 'observed', count: 1, start_ms: 0, end_ms: 0 };
    event.durations_ms.response_write_wall_ms = 0;
  });
  rejects('raised before handler entry requires a closed raised queue', (event) => { event.lifecycle = 'raised'; });
  rejects('dispatch denominator cannot contradict unknown duration', (event) => {
    event.sampling.dispatch_wall_denominator_ms = 20;
  });
  rejects('arrival phase contradiction is refused', (event) => {
    event.phases.arrival = { status: 'observed', count: 1, start_ms: 0, end_ms: 1, reason: 'no earlier socket/server-accept hook' };
  });
  rejects('retention outcome uses the new lifecycle enum', (event) => { event.retention.final_request.outcome = 'pending'; });
  rejects('summary and final retention lifecycle must agree', (event) => { event.retention.final_request.outcome = 'returned_without_response'; });
  rejects('buffer completeness must agree with complete', (event) => { event.retention.final_request.buffer_complete = false; });
  rejects('unknown summary fields are refused', (event) => { event.extra = null; });
  rejects('raw request content stays private', (event) => { event.body = 'fixture'; });
  rejects('request cap remains eight', (event) => { event.request = 9; });
  rejects('phase count cap remains thirty-two', (event) => { event.phases.dispatch_queue.count = 33; });
  rejects('rolling capacity remains 128', (event) => { event.retention.rolling.capacity_events = 129; });
  rejects('output byte cap remains 65536', (event) => { event.retention.output.bytes = 65537; });
  rejects('sampling interval remains 20 ms', (event) => { event.sampling.sampling_interval_ms = 21; });
  rejects('retention accounting is exact', (event) => { event.retention.rolling.events_retained = 0; });
});

test('D127 frozen helper lifecycle matrix accepts observed projections and rejects boundary contradictions', () => {
  const source = spawnSync('git', ['-C', runtimeCheckout, 'show', '231ddb5a6605b535d26172d34439ebe7b90804de:tests/helpers/p2_commit_phase_capture.py'], { encoding: 'utf8' });
  assert.equal(source.status, 0, source.stderr);
  assert.equal(createHash('sha256').update(source.stdout).digest('hex'), REVIEWED_NEW_HELPER_SHA256);
  // Only stdlib helper callbacks and in-memory summaries; no trace installation,
  // Runtime bodies, timers, sockets, output sinks, or helper normalization.
  const probe = spawnSync(python, ['-c', `
import itertools, json, sys
from types import SimpleNamespace
scope = {}
exec(compile(sys.stdin.read(), "p2_commit_phase_capture.py", "exec"), scope)
Capture = scope["P2CommitPhaseCapture"]

def capture():
    ticks = itertools.count(1_000_000, 1_000_000)
    value = Capture(clock_ns=lambda: next(ticks))
    value._utc_anchor = value._utc_text()
    return value

def handler():
    return SimpleNamespace(command="POST", path="/v1/projects/p/timelines/t/commit",
                           headers={"Idempotency-Key": "fixture"})

def frame(name, owner):
    return SimpleNamespace(f_globals={"__name__": "runtime_protocol.server"},
                           f_code=SimpleNamespace(co_qualname="RuntimeHandler." + name),
                           f_locals={"self": owner, "status": 200}, f_back=None)

def summary(value):
    for request in value._requests.values():
        value._summary(request)
    value._finalize_snapshot()
    return value._summary_events[-1]

cases = []
# Exercise the actual call/exception/return callback, including lifecycle priority.
recipes = [
    ("pending_before_handler", True, False, False, False, False),
    ("pending_after_handler", True, True, False, False, False),
    ("pending_with_response", True, True, True, False, False),
    ("completed", True, True, True, True, False),
    ("completed_without_handler_boundary", True, False, True, True, False),
    ("returned_without_response", True, True, False, True, False),
    ("raised_before_handler", True, False, False, True, True),
    ("raised_after_handler", True, True, False, True, True),
    ("completed_after_error_before_handler", True, False, True, True, True),
    ("completed_after_error_inside_handler", True, True, True, True, True),
    ("pending_missing_dispatch", False, True, False, False, False),
    ("pending_response_missing_dispatch", False, True, True, False, False),
    ("returned_before_handler", True, False, False, True, False),
]
for name, dispatch, entered, responded, finished, error in recipes:
    value, owner = capture(), handler()
    dispatch_frame, handler_frame, response_frame = [frame(n, owner) for n in ("_dispatch", "_timeline_commit", "_send")]
    if dispatch:
        value._trace_inner(dispatch_frame, "call", None)
    if entered:
        value._trace_inner(handler_frame, "call", None)
    if error:
        if entered:
            value._trace_inner(handler_frame, "exception", None)
        value._trace_inner(dispatch_frame, "exception", None)
    if responded:
        value._trace_inner(response_frame, "call", None)
        value._trace_inner(response_frame, "return", None)
    if entered and finished:
        value._trace_inner(handler_frame, "return", None)
    if dispatch and finished:
        value._trace_inner(dispatch_frame, "return", None)
    cases.append({"name": name, "summary": summary(value)})

flags = []
for finished, returned, raised, response in itertools.product((False, True), repeat=4):
    value = capture()
    ordinal = value._new_request(handler=handler())
    request = value._requests[ordinal]
    request.update(dispatch_finished=finished, dispatch_returned=returned, dispatch_raised=raised)
    if response:
        value._begin(ordinal, "http_response", status=200)
    flags.append({"finished": finished, "returned": returned, "raised": raised,
                  "response": response, "outcome": value._request_outcome(request)})

# Closed boundary matrix: present/missing starts, response presence, return/error
# flags, and the stop interleaving before dispatch_finished. Missing dispatch is
# also covered by the frozen Runtime unit test's explicitly unknown boundary.
for dispatch, entered, responded, state in itertools.product((False, True), (False, True), (False, True), ("pending", "returning", "error_returning", "finished", "error_finished")):
    value = capture()
    ordinal = value._new_request(handler=handler())
    request = value._requests[ordinal]
    if dispatch:
        value._begin(ordinal, "dispatch_queue")
    if entered:
        if dispatch:
            value._end(ordinal, "dispatch_queue")
        value._begin(ordinal, "handler_entry")
    if responded:
        value._begin(ordinal, "http_response", status=200)
        value._end(ordinal, "http_response", status=200)
    if state != "pending":
        error = state.startswith("error_")
        request["dispatch_returned"] = True
        request["dispatch_raised"] = error
        if not error:
            request["dispatch_end_ms"] = value._at_ms()
        if dispatch and not entered:
            value._end(ordinal, "dispatch_queue", error=error)
        request["dispatch_finished"] = state.endswith("finished")
    cases.append({"name": f"matrix-{dispatch}-{entered}-{responded}-{state}", "summary": summary(value)})
retention = []
for outcomes in itertools.product(("pending_at_stop", "completed", "raised", "returned_without_response"), repeat=2):
    value = capture()
    for outcome in outcomes:
        ordinal = value._new_request(handler=handler())
        value._begin(ordinal, "dispatch_queue")
        request = value._requests[ordinal]
        if outcome == "completed":
            value._begin(ordinal, "http_response", status=200)
            value._end(ordinal, "http_response", status=200)
        if outcome != "pending_at_stop":
            error = outcome == "raised"
            request.update(dispatch_finished=True, dispatch_returned=True, dispatch_raised=error)
            if not error:
                request["dispatch_end_ms"] = value._at_ms()
            value._end(ordinal, "dispatch_queue", error=error)
    summary(value)
    retention.append({"outcomes": outcomes, "summaries": value._summary_events})
print(json.dumps({"flags": flags, "cases": cases, "retention": retention}))
`], { input: source.stdout, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
  const result = JSON.parse(probe.stdout) as {
    flags: { finished: boolean; returned: boolean; raised: boolean; response: boolean; outcome: string }[];
    cases: { name: string; summary: Record<string, any> }[];
    retention: { outcomes: string[]; summaries: Record<string, any>[] }[];
  };
  assert.equal(result.flags.length, 16);
  for (const row of result.flags) {
    assert.equal(row.outcome, !row.finished ? 'pending_at_stop'
      : row.returned && row.response ? 'completed' : row.raised ? 'raised' : 'returned_without_response');
  }
  assert.equal(result.retention.length, 16);
  for (const { outcomes, summaries } of result.retention) {
    const target = outcomes.findLastIndex((outcome) => outcome !== 'completed');
    for (const summary of summaries) {
      assert.doesNotThrow(() => assertCaptureEvent(summary, 'reviewed-new'));
      const final = summary.retention.final_request;
      if (target === -1) assert.equal(final, null);
      else {
        assert.equal(final.request, target + 1);
        assert.equal(final.outcome, outcomes[target]);
        assert.equal(final.buffer_complete, true);
        assert.equal(final.complete, true);
      }
    }
  }
  assert.equal(result.cases.length, 53);
  for (const { name, summary } of result.cases) {
    assert.doesNotThrow(() => assertCaptureEvent(summary, 'reviewed-new'), name);
    const rejects = (label: string, mutate: (event: Record<string, any>) => void): void => {
      const changed = JSON.parse(JSON.stringify(summary)) as Record<string, any>;
      mutate(changed);
      assert.throws(() => assertCaptureEvent(changed, 'reviewed-new'), undefined, `${name}: ${label}`);
    };
    rejects('queue duration follows its two starts', (event) => {
      event.durations_ms.dispatch_queue_ms = event.durations_ms.dispatch_queue_ms === null ? 1 : event.durations_ms.dispatch_queue_ms + 1;
      if (event.durations_ms.dispatch_total_ms !== null && event.durations_ms.handler_ms !== null) {
        event.durations_ms.handler_ms -= 1;
      }
    });
    rejects('provider duration follows observed boundaries', (event) => { event.durations_ms.provider_wall_ms = 1; });
    rejects('response duration follows observed boundaries', (event) => {
      event.durations_ms.response_write_wall_ms = event.durations_ms.response_write_wall_ms === null ? 1 : event.durations_ms.response_write_wall_ms + 1;
    });
    rejects('unsupported lock duration stays unknown', (event) => { event.durations_ms.execution_lock_wait_ms = 1; });
    rejects('unsupported caller receipt stays unknown', (event) => { event.durations_ms.caller_receipt_ms = 1; });
    rejects('dispatch start identity', (event) => { event.dispatch_start_ms = event.dispatch_start_ms === null ? 0 : null; });
    rejects('sampling denominator follows completion duration', (event) => {
      event.sampling.dispatch_wall_denominator_ms = event.sampling.dispatch_wall_denominator_ms === null ? 1 : null;
    });
    if (summary.phases.dispatch_queue.status === 'raised') {
      rejects('dispatch error cannot invent a completion timestamp', (event) => {
        const completion = 100;
        const total = completion - event.phases.dispatch_queue.start_ms;
        event.durations_ms.dispatch_total_ms = total;
        event.durations_ms.dispatch_to_completion_wall_ms = total;
        event.durations_ms.handler_ms = event.phases.handler_entry.start_ms === null ? null : completion - event.phases.handler_entry.start_ms;
        event.sampling.dispatch_wall_denominator_ms = total;
      });
    }
    if (!summary.phases.http_response.count) {
      rejects('completion needs a response', (event) => { event.lifecycle = 'completed'; event.retention.final_request = null; });
    }
    if (summary.lifecycle === 'completed') {
      for (const lifecycle of ['raised', 'returned_without_response']) {
        rejects('observed response takes completion priority', (event) => { event.lifecycle = lifecycle; });
      }
    }
  }
});

function readBootstrappedWatchdog(root: string, seconds?: string): { seconds: number; stack_sink: string } {
  const config = p2CommitPhaseCaptureConfig(path.join(root, seconds ? `watchdog-${seconds}` : 'watchdog-default'))!;
  mkdirSync(config.directory, { recursive: true, mode: 0o700 });
  const run = spawnSync(python, ['-c', [
    'import json, sys, sitecustomize',
    "sys.argv = ['-m', 'start']",
    'sitecustomize._start_capture()',
    "print(json.dumps({'seconds': sitecustomize._capture.watchdog_seconds, 'stack_sink': str(sitecustomize._capture.watchdog_sink)}))",
    'sitecustomize._capture.stop()',
  ].join(';')], {
    env: {
      ...process.env,
      PYTHONPATH: [bootstrapDirectory, runtimeCheckout].join(path.delimiter),
      ASTRID_P2_COMMIT_PHASE_CAPTURE: undefined,
      ASTRID_P2_COMMIT_PHASE_CAPTURE_SINK: config.sink,
      ASTRID_P2_COMMIT_PHASE_CAPTURE_HELPER: config.helper,
      ASTRID_P2_COMMIT_PHASE_CAPTURE_WATCHDOG_SECONDS: seconds,
    },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  return JSON.parse(run.stdout.trim()) as { seconds: number; stack_sink: string };
}

test('D78 bootstrap passes the selected watchdog to the existing helper and preserves its private stack name', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p2-runtime-watchdog-options-'));
  assert.deepEqual(readBootstrappedWatchdog(root), {
    seconds: 20,
    stack_sink: path.join(root, 'watchdog-default', 'p2-commit-phase.stacks.txt'),
  });
  assert.deepEqual(readBootstrappedWatchdog(root, '2'), {
    seconds: 2,
    stack_sink: path.join(root, 'watchdog-2', 'p2-commit-phase.stacks.txt'),
  });
});
test('P2 Runtime observer bootstrap is opt-in, source-pinned, bounded, and flushed on exit paths', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p2-runtime-bootstrap-'));
  const disabledSink = path.join(root, 'disabled', P2_PHASE_CAPTURE_FILE);
  const disabled = spawnSync(python, ['-c', 'import sys; assert sys.gettrace() is None'], {
    env: { ...process.env, PYTHONPATH: bootstrapDirectory, ASTRID_P2_COMMIT_PHASE_CAPTURE: undefined, ASTRID_P2_COMMIT_PHASE_CAPTURE_SINK: undefined, ASTRID_P2_COMMIT_PHASE_CAPTURE_HELPER: undefined },
    encoding: 'utf8',
  });
  assert.equal(disabled.status, 0, `${disabled.stdout}\n${disabled.stderr}`);
  assert.equal(statSync(path.dirname(disabledSink), { throwIfNoEntry: false }), undefined);

  const unmatched = p2CommitPhaseCaptureConfig(path.join(root, 'unmatched'))!;
  const unmatchedRun = spawnSync(python, ['-c', 'import sys; assert sys.gettrace() is None'], {
    env: {
      ...process.env,
      PYTHONPATH: bootstrapDirectory,
      ASTRID_P2_COMMIT_PHASE_CAPTURE: '1',
      ASTRID_P2_COMMIT_PHASE_CAPTURE_SINK: unmatched.sink,
      ASTRID_P2_COMMIT_PHASE_CAPTURE_HELPER: unmatched.helper,
    },
    encoding: 'utf8',
  });
  assert.equal(unmatchedRun.status, 0, `${unmatchedRun.stdout}\n${unmatchedRun.stderr}`);
  assert.equal(statSync(unmatched.directory, { throwIfNoEntry: false }), undefined);

  const runtimeLogDir = mkdtempSync(path.join(tmpdir(), 'p2-runtime-cli-smoke-'));
  const previousLogDir = process.env.D66_RUNTIME_LOG_DIR;
  const previousWatchdog = process.env.ASTRID_P2_COMMIT_PHASE_CAPTURE_WATCHDOG_SECONDS;
  process.env.D66_RUNTIME_LOG_DIR = runtimeLogDir;
  process.env.ASTRID_P2_COMMIT_PHASE_CAPTURE_WATCHDOG_SECONDS = '2';
  let harness: Awaited<ReturnType<typeof startDirectHarness>> | undefined;
  try {
    harness = await startDirectHarness();
    assert.equal(harness.lifecycleObservation?.launchModule, 'runtime_protocol.cli');
    assert.equal(harness.lifecycleObservation?.actualModule, 'runtime_protocol.cli');
    const astrid = await AstridCli.create(harness);
    const timeline = await harness.runtimeJson<{ head_publication_id: string }>(
      'GET', `/v1/projects/${harness.seed.projectId}/timelines/${harness.seed.timelineId}`,
    );
    assert.equal(timeline.status, 200);
    const accepted = await astrid.commitCaptured(
      harness.seed.projectId,
      harness.seed.timelineId,
      { revision_id: harness.seed.headRevisionId, publication_id: timeline.body.head_publication_id },
      { kind: 'track', id: 'p2-real-worker-proof' },
      'p2-real-worker-proof',
    );
    assert.equal(accepted.data.status, 'accepted');
  } finally {
    await harness?.stop();
    if (previousLogDir === undefined) delete process.env.D66_RUNTIME_LOG_DIR;
    else process.env.D66_RUNTIME_LOG_DIR = previousLogDir;
    if (previousWatchdog === undefined) delete process.env.ASTRID_P2_COMMIT_PHASE_CAPTURE_WATCHDOG_SECONDS;
    else process.env.ASTRID_P2_COMMIT_PHASE_CAPTURE_WATCHDOG_SECONDS = previousWatchdog;
  }

  const config = p2CommitPhaseCaptureConfig(runtimeLogDir);
  assert.ok(config);
  assert.equal(statSync(config.sink).mode & 0o777, 0o600);
  assert.equal(statSync(config.directory).mode & 0o777, 0o700);
  assertSourcePinnedHelper(config);
  const smokeText = readCapture(config.sink, config.helperSha256);
  assert.match(smokeText, /"phase":"handler_entry"/);
  assert.match(smokeText, /"phase":"authorization"/);
  assert.match(smokeText, /"phase":"provider"/);
  assert.match(smokeText, /"phase":"receipt"/);
  assert.match(smokeText, /"phase":"http_response"/);
  assert.equal(readFileSync(config.sink, 'utf8').includes('p2_commit_phase_capture.py'), false);
});

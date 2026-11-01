import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  boundedDiagnosticRead,
  DIAGNOSTIC_COLLECTION_TIMEOUT_MS,
  DIAGNOSTIC_MAX_BYTES,
  diagnosticListener,
  diagnosticObservedVisibility,
  formatDiagnostic,
  formatDiagnosticArtifact,
  formatPriorityDiagnostic,
  MOUNTED_DIAGNOSTIC_EVENT,
  MOUNTED_DIAGNOSTIC_ERROR_CLASSES,
  MOUNTED_DIAGNOSTIC_ERROR_CODES,
  MOUNTED_DIAGNOSTIC_MAX_RECORDS,
  MOUNTED_DIAGNOSTIC_PHASES,
  mountedDiagnosticInitScript,
  projectMountedDiagnosticDetail,
  logDiagnostic,
  logPriorityDiagnostic,
  redactDiagnosticText,
  writeDiagnosticArtifact,
} from './p1-diagnostic-safety.ts';

test('P1 diagnostics redact quoted credential fields before formatting', () => {
  const output = formatDiagnostic('quoted JSON', {
    authorization: 'authorization-secret',
    authToken: 'auth-token-secret',
    headers: { Cookie: 'cookie-secret', token: 'token-secret' },
    raw: '{"authorization":"quoted-authorization","cookie":"quoted-cookie","token":"quoted-token"}',
  });

  assert.equal(output.includes('authorization-secret'), false);
  assert.equal(output.includes('auth-token-secret'), false);
  assert.equal(output.includes('cookie-secret'), false);
  assert.equal(output.includes('token-secret'), false);
  assert.equal(output.includes('quoted-authorization'), false);
  assert.equal(output.includes('quoted-cookie'), false);
  assert.equal(output.includes('quoted-token'), false);
  assert.equal(redactDiagnosticText('{"authorization":{"value":"nested-secret"}}').includes('nested-secret'), false);
});

test('P1 mounted seam projection accepts the exact App record and nested observations', () => {
  const hostile = {
    version: 1,
    sequence: 4,
    time: 12.5,
    phase: 'capture-called',
    projectId: 'project-safe',
    timelineId: 'timeline-safe',
    clipId: 'clip-safe',
    ownerAlias: 1,
    generation: 0,
    sessionPresent: true,
    closed: false,
    current: 'current',
    identityPresent: false,
    scopeMatched: true,
    mountedHead: { revisionId: 'mounted-revision', publicationId: 'mounted-publication' },
    originalHead: { revisionId: 'original-revision', publicationId: null },
    basisStatus: 'ready',
    gestureKind: 'trim',
    patch: { from: 0, fromState: 'present', to: null, toState: 'null', speed: 1, speedState: 'present' },
    mountedClip: { from: 0, fromState: 'present' },
    sourceClip: { from: 0, fromState: 'present', to: 3, toState: 'present' },
    gestureClip: { at: 0, atState: 'present' },
    originalClip: { hold: 3, holdState: 'present' },
    status: 'accepted',
    ownerPresent: true,
    recoverableOwnerCount: 1,
    intentsPendingCount: 0,
    errorStage: 'UNKNOWN',
    errorCode: 'UNKNOWN',
    token: 'must-not-enter',
    body: 'must-not-enter',
    get errorClass() { throw new Error('hostile getter'); },
  };
  const result = projectMountedDiagnosticDetail(hostile);
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.equal(result.record.phase, 'capture-called');
  assert.deepEqual(result.record.mountedHead, { revisionId: 'mounted-revision', publicationId: 'mounted-publication' });
  assert.deepEqual(result.record.originalHead, { revisionId: 'original-revision', publicationId: null });
  assert.deepEqual(result.record.patch, { from: 0, fromState: 'present', to: null, toState: 'null', at: 'UNKNOWN', atState: 'absent', hold: 'UNKNOWN', holdState: 'absent', speed: 1, speedState: 'present' });
  assert.deepEqual(result.record.sourceClip, { from: 0, fromState: 'present', to: 3, toState: 'present', at: 'UNKNOWN', atState: 'absent', hold: 'UNKNOWN', holdState: 'absent', speed: 'UNKNOWN', speedState: 'absent' });
  assert.equal(result.record.intentsPendingCount, 'UNKNOWN');
  assert.equal(result.record.errorClass, 'UNKNOWN');
  assert.equal('token' in result.record, false);
  assert.equal('body' in result.record, false);
  const artifact = JSON.parse(formatDiagnosticArtifact({ mountedObservations: {
    status: 'observed', buffer: 'case1',
    records: [result.record], accepted: 1, rejected: 0, overflow: 0, listenerErrors: 0,
  } }));
  assert.equal(artifact.mountedObservations.records[0].sourceClip.to, 3);
  assert.equal(JSON.stringify(artifact).includes('must-not-enter'), false);
});

test('P1 mounted seam consumes the exact finite source enum and preserves safe rejection classes', () => {
  const serialized = `${JSON.stringify({ errorCode: MOUNTED_DIAGNOSTIC_ERROR_CODES, errorClass: MOUNTED_DIAGNOSTIC_ERROR_CLASSES })}\n`;
  assert.equal(createHash('sha256').update(serialized).digest('hex'), '5f7d9e8f3da6f39c4b4b96a14908b9b9b5f36d33f5940275b6a511fa0ff6b897');
  assert.equal(MOUNTED_DIAGNOSTIC_ERROR_CODES.length, 38);
  assert.deepEqual(MOUNTED_DIAGNOSTIC_ERROR_CLASSES, ['TimelineVersionConflictError', 'Error']);

  for (const errorClass of MOUNTED_DIAGNOSTIC_ERROR_CLASSES) {
    const result = projectMountedDiagnosticDetail({ version: 1, phase: 'capture-rejected', errorCode: 'capture-input-head-unavailable', errorClass });
    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.equal(result.record.errorCode, 'capture-input-head-unavailable');
      assert.equal(result.record.errorClass, errorClass);
    }
  }
  for (const errorCode of ['forged-code', 'capture-input-head-unavailable\0', 'Error: capture-input-head-unavailable']) {
    const result = projectMountedDiagnosticDetail({ version: 1, phase: 'capture-rejected', errorCode, errorClass: 'Error: TimelineVersionConflictError' });
    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.equal(result.record.errorCode, 'UNKNOWN');
      assert.equal(result.record.errorClass, 'UNKNOWN');
    }
  }
  const generic = projectMountedDiagnosticDetail({ version: 1, phase: 'capture-rejected', errorCode: 'operation-rejected', errorClass: 'UNKNOWN' });
  assert.equal(generic.accepted, true);
  if (generic.accepted) assert.deepEqual({ errorCode: generic.record.errorCode, errorClass: generic.record.errorClass }, { errorCode: 'operation-rejected', errorClass: 'UNKNOWN' });
  const untagged = projectMountedDiagnosticDetail({ version: 1, phase: 'schedule', errorCode: 'capture-input-head-unavailable', errorClass: 'Error' });
  assert.equal(untagged.accepted, true);
  if (untagged.accepted) assert.deepEqual({ errorCode: untagged.record.errorCode, errorClass: untagged.record.errorClass }, { errorCode: 'UNKNOWN', errorClass: 'UNKNOWN' });

  const listeners = new Map<string, (event: unknown) => void>();
  const window = {
    __timelineSaveDiagnosticsEnabled: false,
    addEventListener: (name: string, listener: (event: unknown) => void) => { listeners.set(name, listener); },
  } as Record<string, unknown>;
  runInNewContext(mountedDiagnosticInitScript({ buffer: 'enum', maxRecords: 64 }), { window, Object, Set, Number, JSON });
  const listener = listeners.get(MOUNTED_DIAGNOSTIC_EVENT);
  assert.ok(listener);
  MOUNTED_DIAGNOSTIC_ERROR_CODES.forEach((errorCode, sequence) => listener!({ detail: {
    version: 1, sequence, phase: 'capture-rejected', errorCode, errorClass: 'Error',
  } }));
  const snapshot = (window.__timelineSaveDiagnosticsSnapshot as () => Record<string, any>)();
  assert.deepEqual(Array.from(snapshot.records as any[], (record: any) => record.errorCode), [...MOUNTED_DIAGNOSTIC_ERROR_CODES]);
  assert.ok((snapshot.records as any[]).every((record) => record.errorClass === 'Error'));
});

test('P1 mounted seam accepts every published phase and rejects unknown metadata', () => {
  for (const phase of MOUNTED_DIAGNOSTIC_PHASES) {
    assert.equal(projectMountedDiagnosticDetail({ version: 1, phase }).accepted, true, phase);
  }
  assert.equal(projectMountedDiagnosticDetail({ version: 2, phase: 'schedule' }).accepted, false);
  assert.equal(projectMountedDiagnosticDetail({ version: 1, phase: 'evil.phase' }).accepted, false);
  const missing = projectMountedDiagnosticDetail({ version: 1, phase: 'schedule' });
  assert.equal(missing.accepted, true);
  if (missing.accepted) {
    assert.equal(missing.record.projectId, 'UNKNOWN');
    assert.deepEqual(missing.record.mountedHead, { revisionId: 'UNKNOWN', publicationId: 'UNKNOWN' });
    assert.equal((missing.record.patch as Record<string, unknown>).fromState, 'UNKNOWN');
    assert.equal(missing.record.intentsPendingCount, 'UNKNOWN');
    assert.equal(missing.record.errorClass, 'UNKNOWN');
  }

  const listeners = new Map<string, (event: unknown) => void>();
  const window = {
    __timelineSaveDiagnosticsEnabled: false,
    addEventListener: (name: string, listener: (event: unknown) => void) => { listeners.set(name, listener); },
  } as Record<string, unknown>;
  runInNewContext(mountedDiagnosticInitScript({
    buffer: 'case1',
    maxRecords: MOUNTED_DIAGNOSTIC_MAX_RECORDS,
  }), { window, Object, Set, Number, JSON });
  const snapshot = window.__timelineSaveDiagnosticsSnapshot as () => Record<string, unknown>;
  assert.equal(window.__timelineSaveDiagnosticsEnabled, true);
  assert.equal(snapshot().status, 'UNKNOWN');
  assert.equal(Array.isArray(snapshot().records), true);
});

test('P1 mounted seam listener is bounded and disposable under hostile events', () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const window = {
    __timelineSaveDiagnosticsEnabled: false,
    addEventListener: (name: string, listener: (event: unknown) => void) => { listeners.set(name, listener); },
  } as Record<string, unknown>;
  runInNewContext(mountedDiagnosticInitScript({
    buffer: 'case2',
    maxRecords: 2,
  }), { window, Object, Set, Number, JSON });
  const listener = listeners.get(MOUNTED_DIAGNOSTIC_EVENT);
  assert.ok(listener);
  listener!({ detail: { version: 1, phase: 'schedule', sequence: 1, status: 'accepted', token: 'secret' } });
  listener!({ detail: { version: 1, phase: 'schedule', sequence: 2, status: 'merged' } });
  listener!({ detail: { version: 1, phase: 'schedule', sequence: 3, status: 'rejected' } });
  listener!({ detail: new Proxy({}, { get() { throw new Error('detail getter'); } }) });
  const snapshot = (window.__timelineSaveDiagnosticsSnapshot as () => Record<string, any>)();
  assert.equal(snapshot.buffer, 'case2');
  assert.equal(snapshot.accepted, 3);
  assert.equal(snapshot.rejected, 1);
  assert.equal(snapshot.overflow, 1);
  assert.equal(snapshot.listenerErrors, 0);
  assert.equal(snapshot.records.length, 2);
  assert.equal(JSON.stringify(snapshot.records).includes('secret'), false);
});

test('P1 authentic producer reaches the registered failure artifact after later background events', { timeout: 20_000 }, async () => {
  const producerPath = '/home/user/work/app/src/tools/video-editor/lib/timeline-diagnostics.ts';
  const producerSource = readFileSync(producerPath, 'utf8');
  assert.equal(createHash('sha256').update(producerSource).digest('hex'), '0793024b13484ea19313199d9c888f77d55bf5428841449dc158fb0f27e2c21f');
  const producer = await import(pathToFileURL(producerPath).href) as typeof import('/home/user/work/app/src/tools/video-editor/lib/timeline-diagnostics.ts');
  const errors = await import(pathToFileURL('/home/user/work/app/src/sdk/video/timeline/errors.ts').href);

  class TestCustomEvent {
    readonly type: string;
    readonly detail: unknown;
    constructor(type: string, init: { detail: unknown }) { this.type = type; this.detail = init.detail; }
  }
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
  const restoreGlobal = () => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', previousCustomEvent);
    else Reflect.deleteProperty(globalThis, 'CustomEvent');
  };

  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'p1-authentic-producer-'));
  const artifactPath = join(directory, 'p1-diagnostic.json');
  const listeners = new Map<string, (event: unknown) => void>();
  const window = {
    __timelineSaveDiagnosticsEnabled: false,
    addEventListener: (name: string, listener: (event: unknown) => void) => { listeners.set(name, listener); },
    dispatchEvent: (event: TestCustomEvent) => { listeners.get(event.type)?.(event); return true; },
  } as Record<string, unknown>;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: TestCustomEvent });

  try {
    const requireBuiltin = createRequire(import.meta.url);
    const transpile = (source: string) => ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const source = readFileSync(new URL('./three-products.p1-chain.spec.ts', import.meta.url), 'utf8');
    const safetySource = readFileSync(new URL('./p1-diagnostic-safety.ts', import.meta.url), 'utf8');
    const mountedReadinessSource = readFileSync(new URL('./mounted-readiness-safety.ts', import.meta.url), 'utf8');
    const sources = new Map([
      ['./support/app.ts', transpile(readFileSync(new URL('./support/app.ts', import.meta.url), 'utf8'))],
      ['./p1-diagnostic-safety.ts', transpile(safetySource)],
      ['../p1-diagnostic-safety.ts', transpile(safetySource)],
      ['../mounted-readiness-safety.ts', transpile(mountedReadinessSource)],
      ['./three-products.p1-chain.spec.ts', transpile(source)],
    ]);
    const hooks = new Map<string, (...args: any[]) => Promise<void>>();
    const titles: string[] = [];
    const events = new Map<string, (...args: any[]) => unknown>();
    const register = Object.assign((title: string) => { titles.push(title); }, {
      extend: () => register,
      beforeAll: () => {},
      beforeEach: (hook: (...args: any[]) => Promise<void>) => { hooks.set('beforeEach', hook); },
      afterEach: (hook: (...args: any[]) => Promise<void>) => { hooks.set('afterEach', hook); },
    });
    const modules = new Map<string, { exports: any }>();
    const load = (name: string): any => {
      if (name.startsWith('node:')) return requireBuiltin(name);
      if (name === '@playwright/test') return { test: register };
      if (['./support/astrid.ts', './support/harness.ts', './harness.ts'].includes(name)) return {};
      const cached = modules.get(name);
      if (cached) return cached.exports;
      const moduleSource = sources.get(name);
      assert.ok(moduleSource, `unexpected module: ${name}`);
      const module = { exports: {} };
      modules.set(name, module);
      runInNewContext(moduleSource, {
        exports: module.exports, module, require: load, process, URL, TextEncoder, TextDecoder, Buffer,
        setTimeout, clearTimeout, console: { log: () => {} }, indexedDB: { databases: () => [] },
        window, CustomEvent: TestCustomEvent,
      }, { filename: name });
      return module.exports;
    };
    const page = {
      addInitScript: async ({ content }: { content: string }) => {
        runInNewContext(content, { window, Object, Set, Number, JSON, CustomEvent: TestCustomEvent });
      },
      on: (event: string, listener: (...args: any[]) => unknown) => { events.set(event, listener); },
      getByTestId: () => ({ getAttribute: async () => 'UNKNOWN', isVisible: async () => false, innerText: async () => '', count: async () => 0 }),
      locator: () => ({ getAttribute: async () => 'UNKNOWN', isVisible: async () => false, innerText: async () => '', count: async () => 0 }),
      evaluate: async (operation: (id: string) => Promise<unknown>, id: string) => operation(id),
    };
    load('./three-products.p1-chain.spec.ts');
    assert.equal(titles.length, 2);
    assert.equal(hooks.size, 2);
    await hooks.get('beforeEach')!({ page });
    const listener = listeners.get(MOUNTED_DIAGNOSTIC_EVENT);
    assert.ok(listener);
    assert.equal(window.__timelineSaveDiagnosticsEnabled, true);

    const owner = {};
    const sourceDocument = {
      head: { projectId: 'project-commit', headRevisionId: 'r0', headPublicationId: 'p0' },
      config: { clips: [{ id: 'diagnostic-clip', from: 3, to: 8, at: 0, hold: 8, speed: 1 }] },
    };
    const rejection = new errors.TimelineVersionConflictError('capture refused');
    producer.markTimelineSaveRejection(rejection, 'capture-input-head-unavailable');
    producer.emitTimelineSaveDiagnostic('capture-rejected', () => ({ error: rejection, owner,
      timelineId: 'timeline-1', clipId: 'diagnostic-clip', generation: 3, sessionPresent: true, closed: false,
      current: true, identityPresent: true, scopeMatched: true, mounted: sourceDocument, source: sourceDocument,
      gesture: { kind: 'trim', clipId: 'diagnostic-clip', patch: { from: 3, to: 8 } },
      basis: { source: sourceDocument }, basisStatus: 'ready', state: { status: 'error', ownerId: 'owner-1', recoverableOwners: [owner] } }));
    for (let index = 0; index < 40; index += 1) {
      producer.emitTimelineSaveDiagnostic('schedule', () => ({ owner, timelineId: 'timeline-1', clipId: 'diagnostic-clip',
        generation: 3, sessionPresent: true, closed: false, current: true, identityPresent: true, scopeMatched: true,
        mounted: sourceDocument, source: sourceDocument, gesture: { kind: 'trim', patch: { from: 3 } }, state: { status: 'dirty' } }));
    }
    const snapshot = (window.__timelineSaveDiagnosticsSnapshot as () => Record<string, any>)();
    assert.equal(snapshot.accepted, 41);
    assert.equal(snapshot.rejected, 0);
    assert.equal(snapshot.overflow, 9);
    assert.equal(snapshot.records.length, MOUNTED_DIAGNOSTIC_MAX_RECORDS);
    assert.equal(snapshot.records[0].errorCode, 'capture-input-head-unavailable');
    assert.equal(snapshot.records[0].errorClass, 'TimelineVersionConflictError');

    const original = new assert.AssertionError({ message: 'original P1 assertion' });
    const testInfo = {
      title: titles[0], status: 'failed', expectedStatus: 'passed', duration: 90_000,
      error: original, errors: [original], outputPath: (name: string) => { assert.equal(name, 'p1-diagnostic.json'); return artifactPath; },
      attach: async (name: string, options: { path: string; contentType: string }) => {
        assert.equal(name, 'p1-diagnostic'); assert.equal(options.path, artifactPath); assert.equal(options.contentType, 'application/json');
      },
    };
    await hooks.get('afterEach')!({ page }, testInfo);
    const artifactContents = readFileSync(artifactPath, 'utf8');
    const artifact = JSON.parse(artifactContents) as Record<string, any>;
    const retained = artifact.mountedObservations.records[0];
    assert.equal(retained.phase, 'capture-rejected');
    assert.equal(retained.errorCode, 'capture-input-head-unavailable');
    assert.equal(retained.errorClass, 'TimelineVersionConflictError');
    assert.equal(retained.patch.from, 3);
    assert.equal(retained.mountedHead.revisionId, 'r0');
    assert.equal(artifact.mountedObservations.overflow, 9);
    assert.equal(artifact.mountedObservations.records.length, MOUNTED_DIAGNOSTIC_MAX_RECORDS);
  } finally {
    restoreGlobal();
  }
});

test('P1 diagnostics bound breadth, depth, arrays, strings, and bytes', () => {
  const broad: Record<string, unknown> = {};
  for (let index = 0; index < 6000; index += 1) broad[`field-${index}`] = 'x'.repeat(500);
  broad.token = 'breadth-secret';
  const deep: Record<string, unknown> = { value: 'deep-secret' };
  let cursor = deep;
  for (let index = 0; index < 30; index += 1) {
    cursor.next = { value: `depth-${index}` };
    cursor = cursor.next as Record<string, unknown>;
  }
  const output = formatDiagnostic('bounds', { broad, deep, array: Array(6000).fill('array-value'), text: 'z'.repeat(20_000) });

  assert.ok(new TextEncoder().encode(output).length <= DIAGNOSTIC_MAX_BYTES);
  assert.equal(output.includes('breadth-secret'), false);
  assert.ok(output.includes('[TRUNCATED]') || output.includes('[TRUNCATED_ARRAY]') || output.includes('[REDACTED_DEPTH]'));
});

test('P1 diagnostics cannot mask the original assertion when the logger throws', () => {
  const original = new Error('original assertion');
  const throwingLogger = () => { throw new Error('logger failure'); };
  let observed: unknown;

  try {
    logDiagnostic('logger probe', { get value() { throw new Error('getter failure'); } }, throwingLogger);
    throw original;
  } catch (error) {
    observed = error;
  }

  assert.strictEqual(observed, original);

  const savedConsoleLog = console.log;
  try {
    console.log = throwingLogger;
    assert.doesNotThrow(() => logDiagnostic('stdout probe', { value: 'safe' }));
  } finally {
    console.log = savedConsoleLog;
  }
});

test('P1 priority diagnostics preserve causal state ahead of oversized readonly traffic', () => {
  const readonlyTraffic = Array.from({ length: 40 }, () => ({ reply: 'x'.repeat(20_000) }));
  const output = formatPriorityDiagnostic('priority', {
    basis: [{ baseRevisionId: 'basis-revision', basePublicationId: 'basis-publication', merge: 'fields', reads: readonlyTraffic }],
    displayedHead: { revisionId: 'displayed-revision', publicationId: 'displayed-publication' },
    outbox: {
      summary: { hasPending: true, hasConflict: true },
      owners: [{ ownerId: 'owner-1', pending: { intentId: 'intent-1', outcome: { kind: 'retry' } } }],
    },
    sourceWindow: { rightId: 'right-1', before: { sourceIn: { numericValue: 0 } }, after: { sourceIn: { numericValue: 3 } } },
    ui: { recoveryMessage: 'changes retained' },
    errors: { page: ['network error'] },
  });
  const body = output.slice(output.indexOf('] ') + 2);

  assert.ok(new TextEncoder().encode(output).length <= DIAGNOSTIC_MAX_BYTES);
  assert.doesNotThrow(() => JSON.parse(body));
  assert.equal(body.includes('basis-revision'), true);
  assert.equal(body.includes('basis-publication'), true);
  assert.equal(body.includes('"count":40'), true);
  assert.equal(body.includes('"summarized":true'), true);
  assert.equal(body.includes('"truncated":false'), true);
  assert.equal(body.includes('displayed-revision'), true);
  assert.equal(body.includes('owner-1'), true);
  assert.equal(body.includes('right-1'), true);
  assert.equal(body.includes('numericValue'), true);
  assert.equal(body.includes(readonlyTraffic[0].reply), false);
});

test('P1 priority diagnostics keep an oversized value finite, redacted, and parseable', () => {
  const broad: Record<string, string> = {};
  for (let index = 0; index < 600; index += 1) broad[`field-${index}`] = 'r'.repeat(500);
  const output = formatPriorityDiagnostic('priority', {
    authorization: 'should-not-leak',
    readonly: broad,
  });
  const body = output.slice(output.indexOf('] ') + 2);

  assert.ok(new TextEncoder().encode(output).length <= DIAGNOSTIC_MAX_BYTES);
  assert.deepEqual(JSON.parse(body), { diagnostic: 'priority_over_budget' });
  assert.equal(output.includes('should-not-leak'), false);
});

test('P1 diagnostic artifacts retain uncapped safe files and exact correlation unknowns', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'p1-diagnostic-artifact-'));
  const artifactPath = join(directory, 'p1-diagnostic.json');
  const attachments: Array<{ name: string; path: string; contentType: string }> = [];
  const testInfo = {
    outputPath: () => artifactPath,
    attach: async (name: string, options: { path: string; contentType: string }) => { attachments.push({ name, ...options }); },
  };
  const payload = {
    schemaVersion: 1,
    title: 'P1 exact case title',
    status: 'failed',
    expectedStatus: 'passed',
    capturedAt: '2026-10-23T19:12:00.000Z',
    phase: 'afterEach_failure_continuation',
    tuple: { projectId: 'project-safe', timelineId: 'timeline-safe', sourceId: 'UNKNOWN', rightId: 'right-safe' },
    mountedObservations: 'UNKNOWN',
    available: {
      wireHeads: [{ method: 'POST', route: '/api/runtime/v1/projects/:project/timelines/:timeline/commit', status: 200,
        head: { revisionId: 'revision-safe', publicationId: 'publication-safe' }, keyProjection: { present: true, bytes: 36 } }],
      requestProjections: Array.from({ length: 40 }, (_, index) => ({
        index, method: 'POST', route: '/api/runtime/v1/projects/:project/timelines/:timeline/commit', status: 200,
        bodyProjection: { present: true, bytes: 700, sameAsPrevious: index > 0 },
        keyProjection: { present: true, bytes: 36, sameAsPrevious: index > 0 },
        message: `available-${index} ${'x'.repeat(500)}`,
      })),
      errors: { console: [{ message: '{"nested":{"token":"nested-token-secret","cookie":"nested-cookie-secret"}}' }] },
    },
    captureData: 'UNKNOWN',
    unknowns: { mountedDataRef: 'UNKNOWN', callbackPatch: 'UNKNOWN', captureResolution: 'UNKNOWN' },
    losses: { cappedConsole: true, mountedObservations: 'UNKNOWN' },
  };
  let deepAvailable: Record<string, unknown> = { message: 'deep-safe-end' };
  for (let index = 0; index < 12; index += 1) deepAvailable = { available: deepAvailable };
  (payload.available as Record<string, unknown>).available = deepAvailable;

  const fileWritten = await writeDiagnosticArtifact(testInfo, payload);
  assert.equal(fileWritten, true);
  const contents = readFileSync(artifactPath, 'utf8');
  assert.ok(new TextEncoder().encode(contents).length > DIAGNOSTIC_MAX_BYTES);
  const parsed = JSON.parse(contents) as Record<string, any>;
  assert.equal(parsed.title, payload.title);
  assert.equal(parsed.status, payload.status);
  assert.equal(parsed.tuple.timelineId, payload.tuple.timelineId);
  assert.equal(parsed.mountedObservations, 'UNKNOWN');
  assert.equal(contents.includes('deep-safe-end'), true);
  assert.equal(contents.includes('[REDACTED_DEPTH]'), false);
  assert.equal(parsed.available.requestProjections.at(-1).message.startsWith('available-39 '), true);
  assert.equal(parsed.available.requestProjections.at(-1).message.endsWith('[TRUNCATED]'), true);
  assert.equal(contents.includes('nested-token-secret'), false);
  assert.equal(contents.includes('nested-cookie-secret'), false);
  assert.equal(attachments[0].name, 'p1-diagnostic');
  assert.equal(attachments[0].path, artifactPath);
  assert.equal(attachments[0].contentType, 'application/json');

  const capped = formatPriorityDiagnostic('capped console', payload.available);
  assert.ok(new TextEncoder().encode(capped).length <= DIAGNOSTIC_MAX_BYTES);
  assert.doesNotThrow(() => JSON.parse(capped.slice(capped.indexOf('] ') + 2)));
});

test('P1 diagnostic artifact write failure is disposable and cannot replace a test failure', async () => {
  const testInfo = {
    outputPath: () => { throw new Error('output unavailable'); },
    attach: async () => { throw new Error('attach unavailable'); },
  };
  assert.equal(await writeDiagnosticArtifact(testInfo, { title: 'safe', status: 'failed' }), false);
  const original = new Error('original test failure');
  assert.throws(() => { throw original; }, (error) => error === original);
});

test('P1 failure artifacts return before unresolved collection and retain the early file', async () => {
  const source = readFileSync(new URL('./three-products.p1-chain.spec.ts', import.meta.url), 'utf8');
  const captureStart = source.indexOf('async function captureFailureContinuation');
  const earlyWrite = source.indexOf('writeDiagnosticArtifact(testInfo', captureStart);
  const outboxRead = source.indexOf('commandOutboxes(page, timelineId)', captureStart);
  assert.ok(captureStart >= 0 && earlyWrite >= 0 && earlyWrite < outboxRead);
  assert.ok(source.includes('boundedDiagnosticRead(operation, fallback, collectionDeadline)'));

  const directory = mkdtempSync(join(tmpdir(), 'p1-diagnostic-early-'));
  const artifactPath = join(directory, 'p1-diagnostic.json');
  const testInfo = {
    outputPath: () => artifactPath,
    attach: async () => {},
  };
  const title = 'P1 never-resolving collection';
  assert.equal(await writeDiagnosticArtifact(testInfo, {
    schemaVersion: 1, title, status: 'failed', expectedStatus: 'passed',
    phase: 'afterEach_failure_early_return',
    tuple: { projectId: 'project-safe', timelineId: 'timeline-safe', sourceId: 'UNKNOWN', rightId: 'UNKNOWN' },
    sourceWindow: 'UNKNOWN', mountedObservations: 'UNKNOWN',
  }), true);

  const started = Date.now();
  const outbox = await boundedDiagnosticRead(() => new Promise<never>(() => {}), 'UNKNOWN', Date.now() + 25, 25);
  const dom = await boundedDiagnosticRead(() => { throw new Error('page closed'); }, 'UNKNOWN', Date.now() + 25, 25);
  assert.equal(outbox, 'UNKNOWN');
  assert.equal(dom, 'UNKNOWN');
  assert.ok(Date.now() - started < DIAGNOSTIC_COLLECTION_TIMEOUT_MS);
  const parsed = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
  assert.equal(parsed.title, title);
  assert.equal(parsed.phase, 'afterEach_failure_early_return');
});

test('P1 registered failure hook retains the real outbox caller artifact and original assertion', { timeout: 20_000 }, async () => {
  const requireBuiltin = createRequire(import.meta.url);
  const transpile = (source: string) => ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const sources = new Map([
    ['./support/app.ts', transpile(readFileSync(new URL('./support/app.ts', import.meta.url), 'utf8'))],
    ['./p1-diagnostic-safety.ts', transpile(readFileSync(new URL('./p1-diagnostic-safety.ts', import.meta.url), 'utf8'))],
    ['../p1-diagnostic-safety.ts', transpile(readFileSync(new URL('./p1-diagnostic-safety.ts', import.meta.url), 'utf8'))],
    ['../mounted-readiness-safety.ts', transpile(readFileSync(new URL('./mounted-readiness-safety.ts', import.meta.url), 'utf8'))],
    ['./three-products.p1-chain.spec.ts', transpile(readFileSync(new URL('./three-products.p1-chain.spec.ts', import.meta.url), 'utf8'))],
  ]);

  // Execute whole, unchanged modules. Only fixture registration and the browser
  // boundary are controlled; no caller, outbox reader, formatter or writer mirror.
  for (const scenario of ['unresolved', 'throwing', 'closed', 'output-path', 'write', 'attach', 'attach-unresolved'] as const) {
    const directory = mkdtempSync(join(tmpdir(), `p1-real-caller-${scenario}-`));
    const artifactPath = join(directory, 'p1-diagnostic.json');
    const hooks = new Map<string, (...args: any[]) => Promise<void>>();
    const titles: string[] = [];
    const events = new Map<string, (...args: any[]) => unknown>();
    const lines: string[] = [];
    const reads: string[] = [];
    const attachments: string[] = [];
    const observationFailures: unknown[] = [];
    const observe = (check: () => void) => {
      try { check(); } catch (error) { observationFailures.push(error); }
    };
    const transportFails = scenario === 'output-path' || scenario === 'write';
    const never = () => new Promise<never>(() => {});
    const original = new assert.AssertionError({ message: `original P1 assertion: ${scenario}` });
    const testInfo = {
      title: '', status: 'failed', expectedStatus: 'passed', duration: 90_000,
      error: original, errors: [original],
      outputPath: (...segments: string[]) => {
        observe(() => assert.deepEqual(segments, ['p1-diagnostic.json']));
        if (scenario === 'output-path') throw new Error('output path unavailable');
        return scenario === 'write' ? directory : artifactPath;
      },
      attach: async (name: string, options: { path: string; contentType: string }) => {
        observe(() => {
          assert.equal(name, 'p1-diagnostic');
          assert.equal(options.path, artifactPath);
          assert.equal(options.contentType, 'application/json');
          attachments.push(JSON.parse(readFileSync(options.path, 'utf8')).phase);
        });
        if (scenario === 'attach') throw new Error('attachment unavailable');
        if (scenario === 'attach-unresolved') await never();
      },
    };
    const assertFile = (early = false) => {
      const contents = readFileSync(artifactPath, 'utf8');
      const packet = JSON.parse(contents);
      assert.ok(Buffer.byteLength(contents) > DIAGNOSTIC_MAX_BYTES);
      assert.equal(packet.title, testInfo.title);
      assert.equal(packet.status, 'failed');
      assert.equal(packet.expectedStatus, 'passed');
      assert.equal(packet.tuple.projectId, 'project-safe');
      assert.equal(packet.tuple.timelineId, 'timeline-safe');
      assert.equal(packet.tuple.sourceId, 'UNKNOWN');
      assert.equal(packet.mountedObservations, 'UNKNOWN');
      assert.equal(packet.captureData, 'UNKNOWN');
      assert.equal(packet.unknowns.mountedDataRef, 'UNKNOWN');
      assert.equal(packet.unknowns.callbackPatch, 'UNKNOWN');
      assert.equal(packet.unknowns.captureResolution, 'UNKNOWN');
      assert.equal(packet.available.wireHeads.length, 40);
      assert.equal(packet.available.wireHeads.at(-1).head.revisionId, `revision-39-${'r'.repeat(140)}`);
      assert.ok(contents.indexOf(`revision-39-${'r'.repeat(140)}`) > DIAGNOSTIC_MAX_BYTES);
      assert.equal(contents.includes('raw-idempotency-secret'), false);
      assert.equal(contents.includes('wire-body-secret'), false);
      assert.equal(contents.includes('wire-token-secret'), false);
      if (early) assert.equal(packet.phase, 'afterEach_failure_early_return');
      return packet;
    };
    const readBoundary = (name: string) => {
      // Observe the actual file at the first DOM access and inside the real
      // commandOutboxes evaluate callback, before their promises can settle.
      if (!transportFails) observe(() => { assertFile(true); });
      reads.push(name);
      if (scenario === 'unresolved') return never();
      throw new Error(scenario === 'closed' ? 'Target page, context or browser has been closed' : `${name} read failed`);
    };
    const locator = {
      getAttribute: () => readBoundary('DOM attribute'),
      isVisible: () => readBoundary('DOM visibility'),
      innerText: () => readBoundary('DOM text'),
      count: () => readBoundary('DOM count'),
    };
    const page = {
      on: (event: string, listener: (...args: any[]) => unknown) => { events.set(event, listener); },
      getByTestId: () => {
        if (scenario === 'closed') readBoundary('closed locator');
        return locator;
      },
      locator: () => {
        if (scenario === 'closed') readBoundary('closed locator');
        return locator;
      },
      evaluate: async (operation: (id: string) => Promise<string>, id: string) => {
        observe(() => assert.equal(id, 'timeline-safe'));
        reads.push('commandOutboxes evaluate');
        if (scenario === 'closed') return readBoundary('closed evaluate');
        // This invokes support/app.ts's real IndexedDB callback, not a substitute
        // outbox implementation or a page.evaluate result stub.
        return operation(id);
      },
    };
    const register = Object.assign((title: string) => { titles.push(title); }, {
      extend: () => register,
      beforeAll: () => {},
      beforeEach: (hook: (...args: any[]) => Promise<void>) => { hooks.set('beforeEach', hook); },
      afterEach: (hook: (...args: any[]) => Promise<void>) => { hooks.set('afterEach', hook); },
    });
    const modules = new Map<string, { exports: any }>();
    const load = (name: string): any => {
      if (name.startsWith('node:')) return requireBuiltin(name);
      if (name === '@playwright/test') return { test: register };
      // Prerequisites and journey bodies are registered, never executed here.
      if (['./support/astrid.ts', './support/harness.ts', './harness.ts'].includes(name)) return {};
      const cached = modules.get(name);
      if (cached) return cached.exports;
      const source = sources.get(name);
      assert.ok(source, `unexpected module: ${name}`);
      const module = { exports: {} };
      modules.set(name, module);
      runInNewContext(source, {
        exports: module.exports, module, require: load, process, URL, TextEncoder, TextDecoder, Buffer,
        setTimeout, clearTimeout,
        console: { log: (line: string) => { lines.push(line); } },
        indexedDB: { databases: () => readBoundary('indexedDB.databases') },
      }, { filename: name });
      return module.exports;
    };
    load('./three-products.p1-chain.spec.ts');
    assert.equal(titles.length, 2);
    assert.equal(hooks.size, 2);
    testInfo.title = titles[0];
    await hooks.get('beforeEach')!({ page });
    for (let index = 0; index < 40; index += 1) {
      events.get('response')!({
        url: () => 'http://localhost/api/runtime/v1/projects/project-safe/timelines/timeline-safe/commit',
        request: () => ({ method: () => 'POST', headers: () => ({ 'idempotency-key': 'raw-idempotency-secret' }) }),
        status: () => 200,
        json: async () => ({
          head: { revision_id: `revision-${index}-${'r'.repeat(140)}`, publication_id: `publication-${index}-${'p'.repeat(140)}` },
          body: 'wire-body-secret', token: 'wire-token-secret',
        }),
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    // Matching expected status must still bypass failure collection entirely.
    await hooks.get('afterEach')!({ page }, { ...testInfo, status: 'passed' });
    assert.equal(reads.length, 0);
    assert.equal(attachments.length, 0);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    try {
      await assert.rejects(async () => {
        try { throw original; } finally {
          await Promise.race([
            hooks.get('afterEach')!({ page }, testInfo),
            new Promise<never>((_resolve, reject) => {
              watchdog = setTimeout(() => reject(new Error(`failure hook exceeded bound: ${scenario}`)), 2_500);
            }),
          ]);
        }
      }, (error) => error === original);
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
    }
    assert.ok(Date.now() - started < 2_500, scenario);
    assert.strictEqual(testInfo.error, original);
    assert.strictEqual(testInfo.errors[0], original);
    assert.ok(reads.includes('commandOutboxes evaluate'), scenario);
    assert.ok(reads.some((name) => /DOM|closed locator/.test(name)), scenario);
    if (scenario !== 'closed') assert.ok(reads.includes('indexedDB.databases'), scenario);
    if (!transportFails) {
      const packet = assertFile();
      assert.equal(attachments[0], 'afterEach_failure_early_return');
      if (packet.phase === 'afterEach_failure_continuation') {
        assert.equal(packet.available.outbox.readFailed, true);
        assert.equal(packet.available.outbox.owners, 'UNKNOWN');
      } else {
        assert.equal(packet.phase, 'afterEach_failure_early_return');
      }
    } else {
      assert.equal(attachments.length, 0);
    }
    assert.ok(lines.length > 0);
    // Production intentionally catches diagnostic failures; boundary assertions
    // must therefore be checked outside that catch path too.
    assert.deepEqual(observationFailures, [], scenario);
  }
});

test('P1 failure continuation keeps the realistic causal core under the byte budget', () => {
  const heads = Array.from({ length: 40 }, (_, index) => ({
    method: 'POST',
    route: '/api/runtime/v1/projects/:project/timelines/:timeline/commit',
    key: `commit-key-${index}`,
    status: index % 2 === 0 ? 200 : 409,
    head: { revisionId: `revision-${index}`, publicationId: `publication-${index}` },
    replyReadFailed: false,
  }));
  const owners = Array.from({ length: 40 }, (_, index) => ({
    ownerId: `owner-${index}`,
    generation: index,
    intentCount: 1,
    pending: {
      intentId: `intent-${index}`,
      request: { method: 'POST', path: '/api/runtime/v1/projects/:project/timelines/:timeline/commit', key: `commit-key-${index}` },
      outcome: { kind: index % 2 === 0 ? 'retry' : 'rejected', status: index % 2 === 0 ? 503 : 409, reason: 'value_conflict' },
    },
    acceptedHead: { revisionId: `accepted-${index}`, publicationId: `publication-${index}` },
  }));
  const readonlyReplies = Array.from({ length: 40 }, (_, index) => ({
    route: '/api/runtime/v1/projects/:project/timelines/:timeline',
    status: 200,
    head: { revisionId: `readonly-${index}`, publicationId: `publication-${index}` },
  }));
  const output = formatPriorityDiagnostic('P1 failure continuation realistic', {
    case: {
      projectId: 'project-realistic', projectSlug: 'project-slug', timelineId: 'timeline-realistic',
      sourceId: 'p1-chain-source', originalClipId: 'p1-chain-source', rightId: 'p1-chain-source-right',
      expectedPostCount: 2, observedPostCount: 2,
    },
    basis: [{ baseRevisionId: 'basis-revision', basePublicationId: 'basis-publication', merge: 'fields', reads: readonlyReplies }],
    displayedHead: {
      providerProjectId: 'project-realistic', providerTimelineId: 'timeline-realistic',
      commitReplies: heads.map(({ head }, index) => ({ index, head })),
      currentWireHeads: heads,
      readonlyReplies,
      runtimeHistoryHead: { revisionId: 'history-revision', publicationId: 'history-publication' },
      historyReadFailed: false,
    },
    outbox: {
      readFailed: false,
      summary: {
        ownerCount: 40, intentLengths: Array(40).fill(1), pendingIntentLengths: Array(40).fill(1),
        outcomeKinds: Array(40).fill('rejected'), hasIdleOwner: false, hasPending: true, hasIntents: true, hasConflict: true,
      },
      owners,
    },
    sourceWindow: {
      rightId: 'p1-chain-source-right',
      before: { sourceIn: { value: '0', numericValue: 0, visible: true } },
      after: { sourceIn: { value: '3', numericValue: 3, visible: true } },
    },
    ui: {
      connectionState: 'connected', runtimePanelVisible: false, recoveryVisible: true,
      recoveryMessage: 'Your changes are retained and need resolution before they can be saved.',
      timelineErrorVisible: false, timelineErrorMessage: 'UNKNOWN', alertCount: 1,
    },
    errors: {
      page: Array.from({ length: 40 }, () => 'network error'),
      console: Array.from({ length: 40 }, () => ({ type: 'error', signal: 'network_error', message: 'network error', location: 'UNKNOWN' })),
      requestFailures: Array.from({ length: 40 }, () => ({ method: 'GET', route: '/api/runtime/v1/projects/:project/timelines/:timeline', error: 'connection reset' })),
    },
  });
  const body = JSON.parse(output.slice(output.indexOf('] ') + 2)) as Record<string, any>;

  assert.ok(new TextEncoder().encode(output).length <= DIAGNOSTIC_MAX_BYTES);
  for (const key of ['case', 'displayedHead', 'outbox', 'sourceWindow', 'ui', 'errors']) assert.ok(body[key]);
  assert.equal(body.case.rightId, 'p1-chain-source-right');
  assert.equal(body.displayedHead.currentWireHeads.count, 40);
  assert.equal(body.displayedHead.readonlyReplies.count, 40);
  assert.equal(body.outbox.owners.count, 40);
  assert.equal(body.errors.page.count, 40);
  assert.equal(body.sourceWindow.after.sourceIn.numericValue, 3);
  assert.equal(body.ui.recoveryVisible, true);
  assert.equal(body.errors.requestFailures.items[0].error, 'connection reset');
});

test('P1 DOM evidence reports only unique attached visibility as observed', () => {
  assert.equal(diagnosticObservedVisibility([]), 'UNKNOWN');
  assert.equal(diagnosticObservedVisibility([{ attached: true, visible: true }, { attached: true, visible: false }]), 'UNKNOWN');
  assert.equal(diagnosticObservedVisibility([{ attached: false, visible: false }]), 'UNKNOWN');
  assert.equal(diagnosticObservedVisibility([{ attached: true, visible: false }]), false);
});

test('P1 priority logging cannot mask the original assertion when formatting or logging throws', () => {
  const original = new Error('original priority assertion');
  const throwingLogger = () => { throw new Error('priority logger failure'); };
  assert.doesNotThrow(() => logPriorityDiagnostic('priority probe', { value: 'safe' }, throwingLogger));
  assert.throws(() => { throw original; }, (error) => error === original);
});


test('P1 actual failure packet shapes admit only primitive fields and structural heads', () => {
  const unsafe = { body: { value: 'body-secret' }, principal: { name: 'principal-secret' }, token: 'token-secret' };
  const head = { revisionId: 'revision-safe', publicationId: 'publication-safe', ...unsafe };
  const packet = {
    case: { projectId: unsafe, rightId: 'right-safe' },
    sourceIdentities: { beforeHead: head, splitHead: head, agentHead: head, sourceAsset: 'https://private.example/unsafe-asset-secret?token=asset-token' },
    displayedHead: { runtimeHistoryHead: head, currentWireHeads: [{ head, key: unsafe }] },
    outbox: { owners: [{ acceptedHead: head, pending: { request: { key: unsafe, body: unsafe }, outcome: unsafe } }] },
    sourceWindow: { after: { selectedClip: { identity: { 'data-clip-id': unsafe }, text: unsafe } } },
    ui: { recoveryMessage: unsafe }, errors: { console: [{ message: unsafe, ...unsafe }, { message: '{"principal":{"name":"encoded-principal-secret"}}' }] },
  };
  const lines: string[] = [];
  logDiagnostic('actual detailed packet', packet, (line) => lines.push(line));
  lines.push(formatPriorityDiagnostic('actual priority packet', packet));
  for (const line of lines) {
    for (const secret of ['body-secret', 'principal-secret', 'token-secret', 'encoded-principal-secret', 'unsafe-asset-secret', 'asset-token', '"body"', '"principal"', '"token"']) assert.equal(line.includes(secret), false);
    assert.ok(line.includes('revision-safe'));
    assert.ok(line.includes('UNKNOWN'));
    assert.ok(new TextEncoder().encode(line).length <= DIAGNOSTIC_MAX_BYTES);
  }
  const invalidHead = formatPriorityDiagnostic('head tamper', { displayedHead: { runtimeHistoryHead: { revisionId: unsafe, publicationId: 'https://private.example/token-secret' } } });
  assert.equal(invalidHead.includes('token-secret'), false);
});

test('P1 actual event listeners contain synchronous stubs and rejected response promises', async () => {
  const source = readFileSync(new URL('./three-products.p1-chain.spec.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('p1.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const listeners: Array<{ event: string; code: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(ast) === 'page' && node.expression.name.text === 'on') {
      assert.ok(node.arguments[1].getText(ast).startsWith('diagnosticListener('));
      listeners.push({ event: (node.arguments[0] as ts.StringLiteral).text, code: node.arguments[1].getText(ast) });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(listeners.length, 11);
  const path = '/api/runtime/v1/projects/project/timelines/timeline/commit';
  const hostile = new Proxy({}, { get() { throw new Error('event getter failure'); } });
  for (const { code } of listeners) {
    const post = { key: 'key-safe' };
    const record = {};
    const request = { method: () => 'POST', headers: () => ({ 'idempotency-key': 'key-safe' }), url: () => 'http://localhost' + path };
    const listener = runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
      diagnosticListener, URL, diagnosticRoute: () => path, diagnosticMethod: (x: unknown) => x, diagnosticStatus: (x: unknown) => x,
      diagnosticHead: () => { throw new Error('head projection failure'); }, classifyDiagnosticError: () => 'unknown',
      redactDiagnosticText, boundedPush: (items: unknown[], item: unknown) => items.push(item),
      trace: { pageErrors: [], consoleErrors: [], requestFailures: [], wireHeads: [] },
      pageErrors: [], consoleErrors: [], runtimeResponses: [], failureSignals: { pageErrors: [], consoleErrors: [], requestFailures: [] },
      posts: [post], legacy: [], readonlyTraffic: [], readonlyByRequest: new Map([[request, record]]), captureReadonlyTraffic: true,
      COMMITS: /\/commit$/, LEGACY_WRITES: /composition-revisions$/,
    }) as (event: unknown) => unknown;
    await assert.doesNotReject(async () => { await listener(hostile); });
    for (const json of [() => { throw new Error('json sync failure'); }, () => Promise.reject(new Error('json async failure')), () => Promise.resolve({})]) {
      await assert.doesNotReject(async () => { await listener({ url: () => 'http://localhost' + path, request: () => request, status: () => 200, json }); });
    }
  }
  await new Promise((resolve) => setImmediate(resolve));
  const original = new Error('original test failure');
  await diagnosticListener(async () => { throw new Error('async event failure'); })();
  await diagnosticListener(() => ({ then() { throw new Error('thenable failure'); } }))();
  assert.throws(() => { diagnosticListener(() => { throw new Error('event failure'); })(); throw original; }, (error) => error === original);
});

test('P1 failure caller never sends an unprojected head or unsafe asset to formatting', () => {
  const source = readFileSync(new URL('./three-products.p1-chain.spec.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("beforeHead: diagnosticHead({ head: before.head }) ?? 'UNKNOWN'"));
  assert.ok(source.includes("runtimeHistoryHead: diagnosticHead({ head: runtimeHistory?.head }) ?? 'UNKNOWN'"));
  assert.ok(source.includes("sourceAsset: 'UNKNOWN'"));
  assert.equal(source.includes('sourceAsset: originalClip.asset'), false);
  assert.equal(source.includes('redactDiagnosticValue('), false);
});


test('P1 detailed failure caller projects hostile heads and an unsafe source asset', async () => {
  const source = readFileSync(new URL('./three-products.p1-chain.spec.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('p1.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
    && ['diagnosticHead', 'captureSecondCaseFailureDiagnostics'].includes(node.name?.text ?? ''));
  assert.equal(functions.length, 2);
  const lines: string[] = [];
  const unsafe = { body: { value: 'caller-body-secret' }, principal: { name: 'caller-principal-secret' }, token: 'caller-token-secret' };
  const head = { revision_id: 'caller-revision', publication_id: 'caller-publication', ...unsafe };
  const locator = { getAttribute: async () => null, isVisible: async () => false, count: async () => 0 };
  const context = {
    DIAGNOSTIC_LIMIT: 40, commandOutboxes: async () => [], summarizeFailureOutboxes: () => [], summarizeOutboxes: () => ({ ownerCount: 0 }),
    diagnosticConnectionState: () => 'unknown', visibleDiagnostic: async () => false, diagnosticVisibleText: async () => null,
    logDiagnostic: (label: string, value: unknown) => logDiagnostic(label, value, (line) => lines.push(line)),
    logPriorityDiagnostic: (label: string, value: unknown) => logPriorityDiagnostic(label, value, (line) => lines.push(line)),
  };
  const code = functions.map((node) => node.getText(ast)).join('\n') + '\ncaptureSecondCaseFailureDiagnostics';
  const capture = runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  await capture({
    page: { getByTestId: () => locator, locator: () => locator },
    harness: { seed: { projectId: 'project-safe' }, runtimeJson: async () => ({ body: { head } }) },
    seed: { projectSlug: 'project-safe', timelineId: 'timeline-safe', sourceId: 'source-safe' },
    traffic: { posts: [], readonlyTraffic: [] }, signals: { pageErrors: [], consoleErrors: [], requestFailures: [] },
    before: { head }, originalClip: { id: 'clip-safe', asset: 'https://private.example/unsafe-asset-secret?token=asset-token' },
    rightId: 'right-safe', split: { response: { head } }, agent: { head },
  });
  assert.equal(lines.length, 2);
  const detail = JSON.parse(lines[1].slice(lines[1].indexOf('] ') + 2));
  assert.equal(detail.sourceIdentities.beforeHead.revisionId, 'caller-revision');
  assert.equal(detail.displayedHead.runtimeHistoryHead.publicationId, 'caller-publication');
  assert.equal(detail.sourceIdentities.sourceAsset, 'UNKNOWN');
  for (const secret of ['caller-body-secret', 'caller-principal-secret', 'caller-token-secret', 'unsafe-asset-secret', 'asset-token', '"body"', '"principal"']) {
    for (const line of lines) assert.equal(line.includes(secret), false);
  }
});

test('basis phases and committed dependency flags roundtrip strictly through cap32 retention', () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const window = { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) } as Record<string, unknown>;
  runInNewContext(mountedDiagnosticInitScript({ buffer: 'mounted-bootstrap', maxRecords: MOUNTED_DIAGNOSTIC_MAX_RECORDS }), { window, Object, Set, Number, JSON });
  const listener = listeners.get(MOUNTED_DIAGNOSTIC_EVENT)!;
  const flags = ['dependencyBaselinePresent', 'providerChanged', 'timelineChanged', 'headChanged', 'dataRefChanged',
    'editSeqRefChanged', 'adoptionChanged', 'ownerChanged', 'resolverChanged', 'localSaveChanged'];
  for (let sequence = 0; sequence < 40; sequence++) {
    const detail = { version: 1, phase: sequence % 2 ? 'basis-operation' : 'basis-dependencies-committed', sequence,
      ownerAlias: 1, generation: 2, basisReadOrdinal: 3, operationOrdinal: 4,
      operation: 'internal', operationState: 'start', ...Object.fromEntries(flags.map(key => [key, true])),
      token: 'private', config: { private: true }, error: new Error('private') };
    listener({ detail });
    const projected = projectMountedDiagnosticDetail(detail);
    assert.ok(projected.accepted);
    if (projected.accepted) assert.deepEqual(projectMountedDiagnosticDetail(projected.record), projected);
  }
  const snapshot = (window.__timelineSaveDiagnosticsSnapshot as () => Record<string, any>)();
  assert.equal(snapshot.accepted, 40);
  assert.equal(snapshot.records.length, 32);
  assert.equal(snapshot.overflow, 8);
  assert.equal(snapshot.rejected, 0);
  assert.equal(snapshot.listenerErrors, 0);
  for (const record of snapshot.records) {
    assert.equal(record.operation, 'internal');
    assert.equal(record.operationState, 'start');
    assert.equal(record.basisReadOrdinal, 3);
    for (const flag of flags) assert.equal(record[flag], true);
    const projected = projectMountedDiagnosticDetail(record);
    assert.ok(projected.accepted);
    if (projected.accepted) assert.equal(JSON.stringify(projected.record), JSON.stringify(record));
  }
  assert.ok(!JSON.stringify(snapshot).includes('private'));
  const foreign = { version: 1, phase: 'basis-operation', operation: 'https://private', operationState: 'private',
    basisReadOrdinal: Infinity, operationOrdinal: -1, ...Object.fromEntries(flags.map(key => [key, 'true'])) };
  const projected = projectMountedDiagnosticDetail(foreign);
  assert.ok(projected.accepted);
  if (projected.accepted) for (const key of [...flags, 'operation', 'operationState', 'operationOrdinal', 'basisReadOrdinal']) {
    assert.equal(projected.record[key], 'UNKNOWN');
  }
  const getter = Object.defineProperty({ version: 1, phase: 'basis-operation' }, 'operation', { get() { throw new Error('private'); } });
  assert.doesNotThrow(() => listener({ detail: getter }));
  assert.doesNotThrow(() => projectMountedDiagnosticDetail(getter));
});

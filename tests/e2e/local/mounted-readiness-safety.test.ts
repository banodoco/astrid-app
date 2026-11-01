import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { BrowserContext, Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFakeIndexedDB } from '../../../vendor/fake-indexeddb/index.js';
import { createCommitOutbox } from '../../../src/tools/video-editor/commands/commitOutbox.ts';
import { emitTimelineSaveDiagnostic, markTimelineSaveRejection } from '../../../src/tools/video-editor/lib/timeline-diagnostics.ts';
import { TimelineVersionConflictError } from '../../../src/sdk/video/timeline/errors.ts';
import { bootstrapMountedBaseline, installMountedBootstrapDiagnostics, installMountedBootstrapPageDiagnostics } from './support/app.ts';
import type { DirectHarness } from './support/harness.ts';
import { mountedDiagnosticInitScript, projectMountedDiagnosticDetail } from './p1-diagnostic-safety.ts';
import { clearMountedBootstrapFailure, hasFreshSettledOwner, isFreshlyConnected, MountedBootstrapError, readExistingReadonly, readMountedBootstrapFailure, recordMountedBootstrapFailure, retainMountedBootstrapDiagnostics } from './mounted-readiness-safety.ts';

test('missing database is unavailable, not a verified empty baseline', async () => {
  let reads = 0;
  const result = await readExistingReadonly(async () => false, async () => {
    reads += 1;
    return [];
  });
  assert.deepEqual(result, { status: 'unknown', reason: 'unavailable' });
  assert.equal(reads, 0);
});

test('database read rejection remains unknown', async () => {
  const result = await readExistingReadonly(async () => true, async () => { throw new Error('read rejected'); });
  assert.deepEqual(result, { status: 'unknown', reason: 'read-rejected' });
});

test('an available empty database is a verified empty baseline', async () => {
  const result = await readExistingReadonly(async () => true, async () => []);
  assert.deepEqual(result, { status: 'verified', value: [] });
});

test('only a new settled owner qualifies after the verified baseline', () => {
  const previous = new Set(['old-owner']);
  assert.equal(hasFreshSettledOwner([{ ownerId: 'old-owner', intents: [] }], previous), false);
  assert.equal(hasFreshSettledOwner([{ ownerId: 'new-owner', pending: { state: 'pending' }, intents: [] }], previous), false);
  assert.equal(hasFreshSettledOwner([{ ownerId: 'new-owner', intents: ['gesture'] }], previous), false);
  assert.equal(hasFreshSettledOwner([{ ownerId: 'new-owner', intents: [] }], previous), true);
});

test('a closed page read cannot become a verified baseline', async () => {
  const result = await readExistingReadonly(async () => { throw new Error('page closed'); }, async () => []);
  assert.deepEqual(result, { status: 'unknown', reason: 'unavailable' });
});

test('a disconnected selection read cannot retain the initial connected claim', () => {
  assert.equal(isFreshlyConnected({ attached: true, state: 'connected' }), true);
  assert.equal(isFreshlyConnected({ attached: true, state: 'disconnected' }), false);
  assert.equal(isFreshlyConnected({ attached: 'UNKNOWN', state: 'connected' }), false);
});

test('mounted bootstrap failures expose only a finite safe projection', () => {
  clearMountedBootstrapFailure();
  const cause = new Error('private cause remains on the error');
  recordMountedBootstrapFailure(new MountedBootstrapError({ stage: 'selection', code: 'mounted-bootstrap', class: 'mounted-bootstrap' }, cause));
  assert.deepEqual(readMountedBootstrapFailure(), { stage: 'selection', code: 'mounted-bootstrap', class: 'mounted-bootstrap' });
  clearMountedBootstrapFailure();
  assert.equal(readMountedBootstrapFailure(), undefined);
});

test('mounted bootstrap connection diagnostics use the existing producer and detach on success or failure', async () => {
  type TestListener = (...args: unknown[]) => unknown;
  const handlers = new Map<string, Set<TestListener>>();
  const details: unknown[] = [];
  const diagnosticWindow = {
    dispatchEvent(event: { detail: unknown }) { details.push(event.detail); return true; },
  };
  const page = {
    on(name: string, listener: TestListener) {
      const listeners = handlers.get(name) ?? new Set<TestListener>();
      listeners.add(listener);
      handlers.set(name, listeners);
    },
    off(name: string, listener: TestListener) { handlers.get(name)?.delete(listener); },
    async evaluate<T, A>(fn: (arg: A) => T, arg: A) {
      const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
      const previousCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
      class TestCustomEvent { constructor(readonly type: string, readonly init: { detail: unknown }) {} get detail() { return this.init.detail; } }
      Object.defineProperty(globalThis, 'window', { configurable: true, value: diagnosticWindow });
      Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: TestCustomEvent });
      try { return await fn(arg); }
      finally {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else Reflect.deleteProperty(globalThis, 'window');
        if (previousCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', previousCustomEvent);
        else Reflect.deleteProperty(globalThis, 'CustomEvent');
      }
    },
  } as unknown as Page;
  const detach = installMountedBootstrapPageDiagnostics(page);
  assert.deepEqual([...handlers.keys()].sort(), ['pageerror', 'requestfailed', 'response']);
  for (const listener of handlers.get('response') ?? []) await listener({ url: () => 'https://runtime.invalid/v1/handshake?token=private', status: () => 503 });
  for (const listener of handlers.get('requestfailed') ?? []) await listener({ url: () => 'https://runtime.invalid/v1/realm?token=private' });
  for (const listener of handlers.get('pageerror') ?? []) await listener(new TypeError('private stack and message'));
  for (const listener of handlers.get('response') ?? []) await listener({ url: () => 'https://runtime.invalid/v1/private', status: () => 200 });
  await assert.doesNotReject(detach);
  await assert.doesNotReject(detach);
  assert.deepEqual([...handlers.values()].map((listeners) => listeners.size), [0, 0, 0]);
  assert.equal(details.length, 3);
  const routeRecord = projectMountedDiagnosticDetail(details[0]);
  assert.equal(routeRecord.accepted, true);
  if (!routeRecord.accepted) throw new Error('route diagnostic was rejected');
  assert.deepEqual({
    phase: routeRecord.record.phase,
    connectionRoute: routeRecord.record.connectionRoute,
    connectionStatus: routeRecord.record.connectionStatus,
    connectionOutcome: routeRecord.record.connectionOutcome,
    pageErrorClass: routeRecord.record.pageErrorClass,
    pageErrorCategory: routeRecord.record.pageErrorCategory,
  }, { phase: 'connection-route', connectionRoute: 'handshake', connectionStatus: 503, connectionOutcome: 'http-error', pageErrorClass: 'UNKNOWN', pageErrorCategory: 'UNKNOWN' });
  const errorRecord = projectMountedDiagnosticDetail(details[2]);
  assert.equal(errorRecord.accepted, true);
  assert.deepEqual({
    phase: errorRecord.record.pageErrorClass && errorRecord.record.phase,
    pageErrorClass: errorRecord.record.pageErrorClass,
    pageErrorCategory: errorRecord.record.pageErrorCategory,
    connectionRoute: errorRecord.record.connectionRoute,
    connectionStatus: errorRecord.record.connectionStatus,
    connectionOutcome: errorRecord.record.connectionOutcome,
  }, { phase: 'page-error', pageErrorClass: 'TypeError', pageErrorCategory: 'runtime', connectionRoute: 'UNKNOWN', connectionStatus: 'UNKNOWN', connectionOutcome: 'UNKNOWN' });
  assert.doesNotMatch(JSON.stringify(details), /runtime\.invalid|private|stack|message|token/);
});

test('mounted bootstrap retention uses the authentic producer through the real bootstrap finally', async () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mounted-bootstrap-lifecycle-'));
  const artifactPath = join(directory, 'mounted-bootstrap-lifecycle.json');
  const testInfo = {
    outputPath(name: string) { assert.equal(name, 'mounted-bootstrap-lifecycle.json'); return artifactPath; },
    async attach(name: string, options: { path: string; contentType: string }) {
      assert.equal(name, 'mounted-bootstrap-lifecycle.json');
      assert.deepEqual(options, { path: artifactPath, contentType: 'application/json' });
    },
  };
  const listeners = new Map<string, (event: { type: string; detail: unknown }) => void>();
  const diagnosticWindow = {
    __timelineSaveDiagnosticsEnabled: false,
    addEventListener(name: string, listener: (event: { type: string; detail: unknown }) => void) { listeners.set(name, listener); },
    dispatchEvent(event: { type: string; detail: unknown }) { listeners.get(event.type)?.(event); return true; },
  };
  const initScriptRuns: string[] = [];
  let emitted = false;
  const owner = {};
  const sourceDocument = {
    head: { projectId: 'project', headRevisionId: 'revision', headPublicationId: 'publication' },
    config: { clips: [{ id: 'clip', from: 3, to: 8, at: 0, hold: 8, speed: 1 }] },
    token: 'must-not-enter',
  };
  const emitAuthenticProducerEvents = () => {
    if (emitted) return;
    emitted = true;
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
    class TestCustomEvent {
      readonly type: string;
      readonly detail: unknown;
      constructor(type: string, init: { detail: unknown }) { this.type = type; this.detail = init.detail; }
    }
    const restore = () => {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (previousCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', previousCustomEvent);
      else Reflect.deleteProperty(globalThis, 'CustomEvent');
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: diagnosticWindow });
    Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: TestCustomEvent });
    try {
      const boundedWindow = {
        __timelineSaveDiagnosticsEnabled: false,
        addEventListener(name: string, listener: (event: { type: string; detail: unknown }) => void) { listeners.set(`bounded:${name}`, listener); },
        dispatchEvent(event: { type: string; detail: unknown }) { listeners.get(`bounded:${event.type}`)?.(event); return true; },
      };
      runInNewContext(mountedDiagnosticInitScript({ buffer: 'bounded', maxRecords: 2 }), { window: boundedWindow, Object, Set, Number, JSON });
      Object.defineProperty(globalThis, 'window', { configurable: true, value: boundedWindow });
      for (let index = 0; index < 3; index += 1) {
        emitTimelineSaveDiagnostic('schedule', () => ({ owner, timelineId: 'timeline', generation: 1,
          sessionPresent: false, closed: false, current: true, state: { status: 'dirty' } }));
      }
      const boundedSnapshot = (boundedWindow as Record<string, unknown>).__timelineSaveDiagnosticsSnapshot as () => { accepted: number; overflow: number; records: unknown[] };
      assert.deepEqual({ accepted: boundedSnapshot().accepted, overflow: boundedSnapshot().overflow, records: boundedSnapshot().records.length }, { accepted: 3, overflow: 1, records: 2 });
      Object.defineProperty(globalThis, 'window', { configurable: true, value: diagnosticWindow });
      for (let index = 0; index < 2; index += 1) {
        emitTimelineSaveDiagnostic('schedule', () => ({ owner, timelineId: 'timeline', generation: 1,
          sessionPresent: false, closed: false, current: true, state: { status: 'dirty' } }));
      }
      emitTimelineSaveDiagnostic('owner-init', () => ({ owner, timelineId: 'timeline', generation: 1, closed: false, sessionPresent: false }));
      emitTimelineSaveDiagnostic('basis-read', () => ({ owner, timelineId: 'timeline', mounted: sourceDocument, basisStatus: 'loading', generation: 1 }));
      emitTimelineSaveDiagnostic('basis-ready', () => ({ owner, timelineId: 'timeline', mounted: sourceDocument,
        basis: { source: sourceDocument }, basisStatus: 'ready', generation: 1 }));
      emitTimelineSaveDiagnostic('identity-read', () => ({ owner, timelineId: 'timeline', identityPresent: true, generation: 1 }));
      emitTimelineSaveDiagnostic('session-created', () => ({ owner, timelineId: 'timeline', sessionPresent: true, generation: 1 }));
      const rejection = markTimelineSaveRejection(new TimelineVersionConflictError('private primary failure'), 'capture-input-head-unavailable');
      emitTimelineSaveDiagnostic('capture-rejected', () => ({ error: rejection, owner, timelineId: 'timeline',
        generation: 1, sessionPresent: true, closed: false, current: true, mounted: sourceDocument,
        source: sourceDocument, gesture: { kind: 'trim', clipId: 'clip', patch: { from: 3, to: 8 } },
        basis: { source: sourceDocument }, basisStatus: 'ready', state: { status: 'error', ownerId: 'owner', recoverableOwners: [owner] } }));
      const snapshot = ((diagnosticWindow as Record<string, unknown>).__timelineSaveDiagnosticsSnapshot as () => { accepted: number; records: unknown[] })();
      assert.equal(snapshot.accepted, 8);
      assert.equal(projectMountedDiagnosticDetail(snapshot.records.at(-1)).accepted, true);
    } finally {
      restore();
    }
  };
  const control = bootstrapControl(async (probe, storage) => {
    if (probe === 1) await storage.create({ realmId: 'realm', actorId: 'actor', projectId: 'project', timelineId: 'timeline' }, async () => {});
  }, { evaluateWindow: diagnosticWindow, onEvaluate: emitAuthenticProducerEvents, onInitScript: (content) => {
    initScriptRuns.push(content);
    runInNewContext(content, { window: diagnosticWindow, Object, Set, Number, JSON });
    assert.equal(typeof (diagnosticWindow as Record<string, unknown>).__timelineSaveDiagnosticsSnapshot, 'function');
  } });
  await installMountedBootstrapDiagnostics(control.context as BrowserContext, testInfo);
  await assert.doesNotReject(control.run);
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
    status: string;
    lifecycle: { outcome: string; pageMounted: boolean; beforePageClose: boolean };
    diagnostics: { status: string; buffer: string; accepted: number; rejected: number; overflow: number; records: Array<Record<string, unknown>> };
    losses: { read: boolean; write: boolean; records: boolean };
  };
  assert.equal(initScriptRuns.length, 1);
  assert.equal(artifact.status, 'captured');
  assert.deepEqual(artifact.lifecycle, { outcome: 'completed', pageMounted: true, beforePageClose: true });
  assert.equal(artifact.lifecycle.beforePageClose, true);
  assert.equal(artifact.diagnostics.status, 'observed');
  assert.equal(artifact.diagnostics.buffer, 'mounted-bootstrap');
  assert.equal(artifact.diagnostics.accepted, 8);
  assert.equal(artifact.diagnostics.rejected, 0);
  assert.equal(artifact.diagnostics.overflow, 0);
  assert.equal(artifact.diagnostics.records.length, 8);
  assert.deepEqual(artifact.diagnostics.records.at(-1), {
    dependencyBaselinePresent: 'UNKNOWN', providerChanged: 'UNKNOWN', timelineChanged: 'UNKNOWN', headChanged: 'UNKNOWN',
    dataRefChanged: 'UNKNOWN', editSeqRefChanged: 'UNKNOWN', adoptionChanged: 'UNKNOWN', ownerChanged: 'UNKNOWN',
    resolverChanged: 'UNKNOWN', localSaveChanged: 'UNKNOWN', basisReadOrdinal: 'UNKNOWN', operation: 'UNKNOWN',
    operationOrdinal: 'UNKNOWN', operationState: 'UNKNOWN',
    version: 1, sequence: 11, time: artifact.diagnostics.records.at(-1)?.time, phase: 'capture-rejected', projectId: 'project',
    timelineId: 'timeline', clipId: 'clip', ownerAlias: 1, generation: 1, sessionPresent: true, closed: false,
    current: true, identityPresent: 'UNKNOWN', scopeMatched: 'UNKNOWN', mountedHead: { revisionId: 'revision', publicationId: 'publication' },
    originalHead: { revisionId: 'revision', publicationId: 'publication' }, basisStatus: 'ready', gestureKind: 'trim',
    patch: { from: 3, fromState: 'present', to: 8, toState: 'present', at: 'UNKNOWN', atState: 'absent', hold: 'UNKNOWN', holdState: 'absent', speed: 'UNKNOWN', speedState: 'absent' },
    mountedClip: { from: 3, fromState: 'present', to: 8, toState: 'present', at: 0, atState: 'present', hold: 8, holdState: 'present', speed: 1, speedState: 'present' },
    sourceClip: { from: 3, fromState: 'present', to: 8, toState: 'present', at: 0, atState: 'present', hold: 8, holdState: 'present', speed: 1, speedState: 'present' },
    gestureClip: { from: 'UNKNOWN', fromState: 'UNKNOWN', to: 'UNKNOWN', toState: 'UNKNOWN', at: 'UNKNOWN', atState: 'UNKNOWN', hold: 'UNKNOWN', holdState: 'UNKNOWN', speed: 'UNKNOWN', speedState: 'UNKNOWN' },
    originalClip: { from: 3, fromState: 'present', to: 8, toState: 'present', at: 0, atState: 'present', hold: 8, holdState: 'present', speed: 1, speedState: 'present' },
    status: 'error', ownerPresent: true, recoverableOwnerCount: 1, intentsPendingCount: 'UNKNOWN', errorStage: 'capture',
    errorCode: 'capture-input-head-unavailable', errorClass: 'TimelineVersionConflictError',
  });
  assert.ok(artifact.diagnostics.records.some((record) => record.phase === 'basis-read' && record.basisStatus === 'loading'));
  assert.ok(artifact.diagnostics.records.some((record) => record.phase === 'basis-ready' && record.basisStatus === 'ready'));
  assert.ok(artifact.diagnostics.records.some((record) => record.phase === 'identity-read' && record.identityPresent === true));
  assert.ok(artifact.diagnostics.records.some((record) => record.phase === 'session-created' && record.sessionPresent === true));
  assert.doesNotMatch(readFileSync(artifactPath, 'utf8'), /must-not-enter|private primary failure/);
  assert.deepEqual(artifact.losses, { read: false, write: false, records: false });
});

test('mounted bootstrap retention keeps an early UNKNOWN artifact when the page closes or the writer fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mounted-bootstrap-unknown-'));
  const artifactPath = join(directory, 'mounted-bootstrap-lifecycle.json');
  const closedPage = { async evaluate(): Promise<never> { throw new Error('page closed'); } };
  await retainMountedBootstrapDiagnostics({ outputPath: () => artifactPath, attach: async () => {} }, closedPage, 'failed');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as { status: string; diagnostics: unknown };
  assert.equal(artifact.status, 'UNKNOWN');
  assert.equal(artifact.diagnostics, 'UNKNOWN');
  await assert.doesNotReject(() => retainMountedBootstrapDiagnostics({
    outputPath: () => { throw new Error('output unavailable'); },
    attach: async () => {},
  }, closedPage, 'failed'));
});

// The vendored fake uses event listeners and a database Map. Adapt only its
// browser API surface; all owner creation and reads use the production storage.
function browserEvents<T extends { addEventListener(name: string, listener: () => void): void }>(target: T, names: string[]): T {
  for (const name of names) Object.defineProperty(target, `on${name}`, {
    set(listener: () => void) { target.addEventListener(name, listener); },
  });
  return target;
}

function bootstrapControl(
  beforeProbe: (probe: number, storage: ReturnType<typeof createCommitOutbox>) => Promise<void>,
  options: { onEvaluate?: () => void; onInitScript?: (content: string) => void; evaluateWindow?: object } = {},
) {
  const factory = createFakeIndexedDB();
  const storage = createCommitOutbox({ indexedDB: factory, exclusiveLock: async (_name, work) => work() });
  let probes = 0;
  let opens = 0;
  let closed = false;
  const browserFactory = {
    async databases() {
      await beforeProbe(++probes, storage);
      return [...factory.databases.keys()].map((name) => ({ name }));
    },
    open(name: string) {
      opens += 1;
      const request = factory.open(name);
      request.addEventListener('success', () => {
        const db = request.result;
        const transaction = db.transaction.bind(db);
        db.transaction = (store: string, mode: string) => {
          assert.equal(mode, 'readonly');
          return browserEvents(transaction(store, mode), ['complete', 'abort']);
        };
      });
      return browserEvents(request, ['success', 'error']);
    },
  };
  const locator = { _apiName: 'Locator', _expect: async () => ({ matches: true }), first() { return this; } };
  const page = {
    on() {}, async goto() {}, locator: () => locator, getByRole: () => locator,
    async evaluate<T, A>(fn: (arg: A) => T, arg: A) {
      const prior = globalThis.indexedDB;
      const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: browserFactory });
      if (options.evaluateWindow) Object.defineProperty(globalThis, 'window', { configurable: true, value: options.evaluateWindow });
      try {
        options.onEvaluate?.();
        const result = await fn(arg);
        return options.evaluateWindow ? JSON.parse(JSON.stringify(result)) as T : result;
      }
      finally {
        Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: prior });
        if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
        else Reflect.deleteProperty(globalThis, 'window');
      }
    },
    async close() { closed = true; },
  };
  const context = {
    async addInitScript({ content }: { content: string }) { options.onInitScript?.(content); },
    async newPage() { return page as unknown as Page; },
  };
  return {
    context,
    run: () => bootstrapMountedBaseline(context as BrowserContext,
      { origin: 'https://bootstrap.test', seed: { projectId: 'project', timelineId: 'timeline', projectName: 'Project' } } as DirectHarness),
    state: () => ({ probes, opens, closed, databases: factory.databases.size }),
  };
}

test('real bootstrap stays mounted through absent, empty, other-project and dirty DB states until the production scoped claim', async () => {
  const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project', timelineId: 'timeline' };
  const control = bootstrapControl(async (probe, storage) => {
    assert.equal(control.state().closed, false);
    if (probe === 2) await storage.list(scope);
    if (probe === 4) await storage.create({ ...scope, projectId: 'other-project' }, async () => {});
    if (probe === 6) await storage.create(scope, async (box) => {
      await box.append({ edit: true }, { head: { revisionId: 'revision', publicationId: 'publication' } });
    });
    if (probe === 8) await storage.create(scope, async () => {});
  });
  const owners = await control.run();
  assert.equal(owners.filter((owner) => owner.scope.projectId === 'project' && owner.intents.length === 0).length, 1);
  assert.deepEqual(control.state(), { probes: 9, opens: 4, closed: true, databases: 1 });
});

test('real bootstrap never creates a missing database or accepts an empty fallback and closes on timeout', async () => {
  const control = bootstrapControl(async () => {});
  await assert.rejects(control.run(), MountedBootstrapError);
  assert.equal(control.state().opens, 0);
  assert.equal(control.state().databases, 0);
  assert.equal(control.state().closed, true);
  assert.deepEqual(readMountedBootstrapFailure(), { stage: 'outbox-read', code: 'mounted-bootstrap', class: 'mounted-bootstrap' });
});

test('real bootstrap preserves a rejected existence probe as a bounded outbox-read failure', async () => {
  const control = bootstrapControl(async () => { throw new Error('private database failure'); });
  await assert.rejects(control.run(), MountedBootstrapError);
  assert.equal(control.state().closed, true);
  assert.deepEqual(readMountedBootstrapFailure(), { stage: 'outbox-read', code: 'mounted-bootstrap', class: 'mounted-bootstrap' });
  assert.doesNotMatch(JSON.stringify(readMountedBootstrapFailure()), /private/);
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureDiagnosticsPreservingOutcome, emitTimelineSaveDiagnostic, markTimelineSaveRejection } from './timeline-diagnostics';

vi.mock('@playwright/test', () => ({ chromium: {}, expect: Object.assign(() => undefined, { poll: () => undefined }), test: { extend: () => ({}) } }));
vi.mock('../../../../tests/e2e/local/support/harness.ts', () => ({ DOOR_PORT: 1, startDirectHarness: vi.fn() }));
vi.mock('../../../../tests/e2e/local/mounted-readiness-safety.ts', () => ({ clearMountedBootstrapFailure: vi.fn(),
  MountedBootstrapError: class extends Error {}, recordMountedBootstrapFailure: vi.fn(), retainMountedBootstrapDiagnostics: vi.fn() }));
import { captureTerminalSaveDiagnostics } from '../../../../tests/e2e/local/support/app.ts';

describe('timeline save diagnostic projection', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('captures once after success and preserves the original assertion when capture fails', async () => {
    const captureFailure = new Error('diagnostic capture failed');
    const success = vi.fn(async () => 'success');
    const successCapture = vi.fn(async () => { throw captureFailure; });
    await expect(captureDiagnosticsPreservingOutcome(success, successCapture)).resolves.toBe('success');
    expect(successCapture).toHaveBeenCalledTimes(1);

    const assertion = new Error('original assertion');
    const order: string[] = [];
    const failure = vi.fn(async () => { order.push('work'); throw assertion; });
    const failedCapture = vi.fn(async () => { order.push('capture'); throw captureFailure; });
    await expect(captureDiagnosticsPreservingOutcome(failure, failedCapture)).rejects.toBe(assertion);
    expect(failedCapture).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['work', 'capture']);
  });

  it('requests one live snapshot, retains each bounded response and reads the capped event buffer', async () => {
    let requestCount = 0;
    const page = { isClosed: () => false, evaluate: async (operation: () => unknown) => operation() };
    const onRequest = () => {
      requestCount++;
      for (let index = 1; index <= 40; index++) {
        window.dispatchEvent(new CustomEvent('timeline:save-diagnostic', { detail: {
          phase: 'recovery-current-snapshot', ownerAlias: index, timelineId: `timeline-${index}`, recoveryReadState: 'empty',
        } }));
      }
      window.dispatchEvent(new CustomEvent('timeline:save-diagnostic', { detail: { phase: 'schedule', privateValue: 'ignored' } }));
    };
    window.addEventListener('timeline:save-diagnostic-snapshot-request', onRequest);
    (window as unknown as { __saveEvents: unknown[] }).__saveEvents = Array.from({ length: 305 }, (_, index) => index);
    try {
      const result = await captureTerminalSaveDiagnostics(page as never);
      expect(requestCount).toBe(1);
      expect(result.captureTiming).toBe('terminal-after-assertions');
      expect(result.requestedAt).toEqual(expect.any(Number));
      expect(result.snapshots).toHaveLength(32);
      expect(result.snapshots[0]).toMatchObject({ ownerAlias: 1, timelineId: 'timeline-1' });
      expect(result.snapshots[31]).toMatchObject({ ownerAlias: 32, timelineId: 'timeline-32' });
      expect(result.snapshots.every((snapshot) => snapshot.phase === 'recovery-current-snapshot')).toBe(true);
      expect(result.saveDiagnostics).toHaveLength(300);
    } finally {
      window.removeEventListener('timeline:save-diagnostic-snapshot-request', onRequest);
      delete (window as unknown as { __saveEvents?: unknown[] }).__saveEvents;
    }
  });

  it('returns fixed unavailable records for closed pages and evaluation failures', async () => {
    const closed = await captureTerminalSaveDiagnostics({ isClosed: () => true, evaluate: vi.fn() } as never);
    expect(closed).toEqual({ captureTiming: 'terminal-after-assertions', requestedAt: null,
      snapshots: [{ phase: 'unavailable', reason: 'page-unavailable' }], saveDiagnostics: [] });
    const failed = await captureTerminalSaveDiagnostics({ isClosed: () => false,
      evaluate: async () => { throw new Error('private evaluation failure'); } } as never);
    expect(failed).toEqual({ captureTiming: 'terminal-after-assertions', requestedAt: null,
      snapshots: [{ phase: 'unavailable', reason: 'capture-unavailable' }], saveDiagnostics: [] });
    expect(JSON.stringify(failed)).not.toContain('private evaluation failure');
    const statusFailed = await captureTerminalSaveDiagnostics({ isClosed: () => { throw new Error('private page status'); },
      evaluate: vi.fn() } as never);
    expect(statusFailed.snapshots).toEqual([{ phase: 'unavailable', reason: 'capture-unavailable' }]);
  });

  it('does not evaluate observations unless the browser flag is exactly true', () => {
    const read = vi.fn(() => ({}));
    const boundary = vi.fn(() => 'schedule' as const);
    for (const flag of [undefined, false, 1, 'true']) {
      vi.stubGlobal('__timelineSaveDiagnosticsEnabled', flag);
      emitTimelineSaveDiagnostic(boundary, read);
    }
    expect(read).not.toHaveBeenCalled();
    expect(boundary).not.toHaveBeenCalled();
    Object.defineProperty(window, '__timelineSaveDiagnosticsEnabled', { configurable: true, get() { throw new Error('flag'); } });
    expect(() => emitTimelineSaveDiagnostic('schedule', read)).not.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(boundary).not.toHaveBeenCalled();
  });

  it('keeps current recovery snapshots on the bounded scalar allowlist and honors opt-out', () => {
    vi.stubGlobal('__timelineSaveDiagnosticsEnabled', true);
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);
    emitTimelineSaveDiagnostic('recovery-current-snapshot', () => ({ recoveryCheckOrdinal: 2,
      recoveryReadState: 'record', recoverySkipReason: 'none', recoveryFinalizer: 'applied',
      recoveryScopeMatches: true, recoveryDataPresent: true, recoveryCancelled: false,
      recoveryCompleted: true, recoveryFinalizerApplied: true, recoveryGenerationAtCheck: 4,
      recoveryGenerationCurrent: 4, recoveryEditSeqAtCheck: 9, recoveryEditSeqCurrent: 9,
      recoveryDraft: 'private draft', recoveryKey: 'private key' }));
    const detail = (dispatch.mock.lastCall![0] as CustomEvent).detail;
    expect(detail).toMatchObject({ phase: 'recovery-current-snapshot', recoveryCheckOrdinal: 2,
      recoveryReadState: 'record', recoverySkipReason: 'none', recoveryFinalizer: 'applied',
      recoveryScopeMatches: true, recoveryDataPresent: true, recoveryCancelled: false,
      recoveryCompleted: true, recoveryFinalizerApplied: true, recoveryGenerationAtCheck: 4,
      recoveryGenerationCurrent: 4, recoveryEditSeqAtCheck: 9, recoveryEditSeqCurrent: 9 });
    expect(detail).not.toHaveProperty('recoveryDraft');
    expect(detail).not.toHaveProperty('recoveryKey');
    expect(JSON.stringify(detail)).not.toMatch(/private draft|private key/);

    vi.stubGlobal('__timelineSaveDiagnosticsEnabled', false);
    const read = vi.fn(() => ({ recoveryCheckOrdinal: 3 }));
    emitTimelineSaveDiagnostic('recovery-current-snapshot', read);
    expect(read).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('emits detached bounded scalar records with stable non-auth aliases', () => {
    vi.stubGlobal('__timelineSaveDiagnosticsEnabled', true);
    const records: Record<string, unknown>[] = [];
    const listener = (event: Event) => records.push((event as CustomEvent).detail);
    window.addEventListener('timeline:save-diagnostic', listener);
    try {
      const owner = {};
      const clip = { id: 'clip-1', from: 3, to: null, hold: Infinity, speed: 1, metadata: 'secret' };
      const source = { config: { clips: [clip] }, head: { projectId: 'project-1', headRevisionId: 'r0', headPublicationId: 'p0' }, bundle: 'secret' };
      const read = () => ({ owner, timelineId: 'timeline-1', clipId: 'clip-1', mounted: source,
        source, basis: { source }, basisStatus: 'ready', gesture: { kind: 'trim', patch: { from: 3 } },
        state: { status: 'dirty', ownerId: 'secret', recoverableOwners: ['secret'] } });
      emitTimelineSaveDiagnostic('capture-called', read);
      emitTimelineSaveDiagnostic('capture-resolved', read);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ version: 1, projectId: 'project-1', timelineId: 'timeline-1', clipId: 'clip-1',
        mountedHead: { revisionId: 'r0', publicationId: 'p0' }, originalHead: { revisionId: 'r0', publicationId: 'p0' },
        patch: { from: 3, fromState: 'present', toState: 'absent' },
        mountedClip: { from: 3, to: null, toState: 'null', hold: 'UNKNOWN', holdState: 'UNKNOWN' },
        recoverableOwnerCount: 1, intentsPendingCount: 'UNKNOWN' });
      expect(records[1].ownerAlias).toBe(records[0].ownerAlias);
      expect(Number(records[1].sequence)).toBeGreaterThan(Number(records[0].sequence));
      expect(Number(records[1].time)).toBeGreaterThanOrEqual(Number(records[0].time));
      clip.from = 9;
      expect(records[0].mountedClip).toMatchObject({ from: 3 });
      expect(Object.isFrozen(records[0])).toBe(true);
      expect(Object.isFrozen(records[0].mountedClip)).toBe(true);
      expect(JSON.stringify(records)).not.toContain('secret');
      expect(JSON.stringify(records).length).toBeLessThan(8000);
    } finally { window.removeEventListener('timeline:save-diagnostic', listener); }
  });

  it('does not invoke nested getters, deep walk arbitrary data, or propagate projection/dispatch errors', () => {
    vi.stubGlobal('__timelineSaveDiagnosticsEnabled', true);
    const getter = vi.fn(() => { throw new Error('private'); });
    const source = Object.defineProperty({}, 'config', { get: getter });
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);
    emitTimelineSaveDiagnostic('capture-rejected', () => ({ mounted: source, state: { error: new Error('secret') } }));
    expect(getter).not.toHaveBeenCalled();
    const detail = (dispatch.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toMatchObject({ errorStage: 'capture', errorCode: 'operation-rejected',
      mountedClip: { fromState: 'UNKNOWN' } });
    expect(JSON.stringify(detail)).not.toContain('secret');
    expect(() => emitTimelineSaveDiagnostic('schedule', () => { throw new Error('projection'); })).not.toThrow();
    dispatch.mockImplementation(() => { throw new Error('listener'); });
    expect(() => emitTimelineSaveDiagnostic('schedule', () => ({}))).not.toThrow();
  });

  it('limits selected clip inspection and never emits URL-shaped identifiers or unknown state strings', () => {
    vi.stubGlobal('__timelineSaveDiagnosticsEnabled', true);
    const clips = Array.from({ length: 257 }, (_, i) => ({ id: `clip-${i}`, from: i }));
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);
    emitTimelineSaveDiagnostic('schedule', () => ({ clipId: 'clip-256', timelineId: 'https://secret',
      mounted: { config: { clips } }, state: { status: 'secret' } }));
    expect((dispatch.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ timelineId: 'UNKNOWN', status: 'UNKNOWN',
      mountedClip: { from: 'UNKNOWN', fromState: 'UNKNOWN' } });
  });

  it('classifies only tagged local exceptions without reading or changing error properties', () => {
    vi.stubGlobal('__timelineSaveDiagnosticsEnabled', true);
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);
    const error = Object.freeze(new Error('private error text'));
    const descriptors = Object.getOwnPropertyDescriptors(error);
    expect(markTimelineSaveRejection(error, 'owner-identity-invalidated', 'Error')).toBe(error);
    for (const phase of ['capture-rejected', 'basis-error', 'owner-error'] as const) {
      emitTimelineSaveDiagnostic(phase, () => ({ error }));
      expect((dispatch.mock.lastCall![0] as CustomEvent).detail).toMatchObject({
        errorCode: 'owner-identity-invalidated', errorClass: 'Error' });
    }
    expect(Object.getOwnPropertyDescriptors(error)).toEqual(descriptors);
    emitTimelineSaveDiagnostic('capture-resolved', () => ({ error }));
    expect((dispatch.mock.lastCall![0] as CustomEvent).detail).toMatchObject({ errorCode: 'UNKNOWN', errorClass: 'UNKNOWN' });
    expect(JSON.stringify(dispatch.mock.calls.map(([event]) => (event as CustomEvent).detail))).not.toContain('private');
  });

  it('keeps foreign, forged, unreadable and proxy errors generic without executing traps', () => {
    vi.stubGlobal('__timelineSaveDiagnosticsEnabled', true);
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);
    const trap = vi.fn(() => { throw new Error('private'); });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const accessor = Object.defineProperties({}, { message: { get: trap }, stack: { get: trap }, name: { get: trap } });
    const hostile = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
    for (const error of [undefined, null, 'private', new Error('private'),
      { errorCode: 'gesture-basis-mismatch', errorClass: 'TimelineVersionConflictError' }, accessor, hostile, revoked.proxy]) {
      expect(() => emitTimelineSaveDiagnostic('capture-rejected', () => ({ error }))).not.toThrow();
      expect((dispatch.mock.lastCall![0] as CustomEvent).detail).toMatchObject({ errorCode: 'operation-rejected', errorClass: 'UNKNOWN' });
    }
    expect(trap).not.toHaveBeenCalled();
  });

  it('leaves exceptions unchanged when tagging is disabled or diagnostics fail', () => {
    const error = new Error('private');
    vi.stubGlobal('__timelineSaveDiagnosticsEnabled', false);
    expect(markTimelineSaveRejection(error, 'capture-owner-unavailable')).toBe(error);
    vi.stubGlobal('__timelineSaveDiagnosticsEnabled', true);
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);
    emitTimelineSaveDiagnostic('capture-rejected', () => ({ error }));
    expect((dispatch.mock.lastCall![0] as CustomEvent).detail).toMatchObject({ errorCode: 'operation-rejected', errorClass: 'UNKNOWN' });
    Object.defineProperty(window, '__timelineSaveDiagnosticsEnabled', { configurable: true, get() { throw new Error('flag'); } });
    expect(markTimelineSaveRejection(error, 'capture-owner-unavailable')).toBe(error);
  });
  it('emits only finite basis operation enums, counters and strict dependency booleans', () => {
    vi.stubGlobal('__timelineSaveDiagnosticsEnabled', true);
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);
    emitTimelineSaveDiagnostic('basis-operation', () => ({ owner: {}, generation: 0, basisReadOrdinal: 1,
      operationOrdinal: 2, operation: 'internal', operationState: 'refused', resolverChanged: false,
      providerChanged: 'true', error: new Error('private provider error') }));
    const detail = (dispatch.mock.lastCall![0] as CustomEvent).detail;
    expect(detail).toMatchObject({ phase: 'basis-operation', basisReadOrdinal: 1, operationOrdinal: 2,
      operation: 'internal', operationState: 'refused', resolverChanged: false, providerChanged: 'UNKNOWN',
      errorCode: 'UNKNOWN', errorClass: 'UNKNOWN' });
    expect(JSON.stringify(detail)).not.toContain('private');
    emitTimelineSaveDiagnostic('basis-operation', () => ({ operation: 'https://private', operationState: 'private',
      basisReadOrdinal: Infinity, operationOrdinal: -1, resolverChanged: 1 }));
    expect((dispatch.mock.lastCall![0] as CustomEvent).detail).toMatchObject({ operation: 'UNKNOWN',
      operationState: 'UNKNOWN', basisReadOrdinal: 'UNKNOWN', operationOrdinal: 'UNKNOWN', resolverChanged: 'UNKNOWN' });
  });

  it('projects persistence-path diagnostics to fixed enums, booleans and bounded counters', () => {
    vi.stubGlobal('__timelineSaveDiagnosticsEnabled', true);
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);
    emitTimelineSaveDiagnostic('schedule-disposition', () => ({
      disposition: 'interaction-active', persistenceEnabled: true, recoveryPending: false,
      recoveryActive: false, interactionActive: true, conflictExhausted: false,
      schemaIncompatible: false, sequenceNumber: 12, source: { privateValue: 'secret' },
    }));
    const detail = (dispatch.mock.lastCall![0] as CustomEvent).detail;
    expect(detail).toMatchObject({ phase: 'schedule-disposition', disposition: 'interaction-active',
      persistenceEnabled: true, recoveryPending: false, recoveryActive: false, interactionActive: true,
      conflictExhausted: false, schemaIncompatible: false, sequenceNumber: 12 });
    expect(JSON.stringify(detail)).not.toContain('secret');
    emitTimelineSaveDiagnostic('save-return', () => ({ returnReason: 'private reason', sequenceNumber: -1,
      captureStage: 'private stage', captureCode: 'private code' }));
    expect((dispatch.mock.lastCall![0] as CustomEvent).detail).toMatchObject({ returnReason: 'UNKNOWN',
      sequenceNumber: 'UNKNOWN', captureStage: 'UNKNOWN', captureCode: 'UNKNOWN' });

    const validCases = [
      ['schedule-disposition', { disposition: 'recovery-pending' }],
      ['save-return', { returnReason: 'session-invalidated' }],
      ['local-capture-start', { captureStage: 'capture-call' }],
      ['local-capture-settled', { captureStage: 'capture-set', captureCode: 'resolved' }],
      ['local-capture-error', { captureStage: 'local-capture', captureCode: 'rejected' }],
      ['mutation-error', { sequenceNumber: 7 }],
    ] as const;
    for (const [phase, observation] of validCases) {
      emitTimelineSaveDiagnostic(phase, () => observation);
      const projected = (dispatch.mock.lastCall![0] as CustomEvent).detail;
      expect(projected.phase).toBe(phase);
      for (const [key, value] of Object.entries(observation)) expect(projected[key]).toBe(value);
    }
  });

  it('projects scheduled recovery observations through frozen enums and bounded counters', () => {
    vi.stubGlobal('__timelineSaveDiagnosticsEnabled', true);
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);
    const privateGetter = vi.fn(() => 'secret draft key');
    const observation = Object.defineProperties({
      recoveryCheckOrdinal: 3,
      recoveryReadState: 'pending',
      recoverySkipReason: 'none',
      recoveryFinalizer: 'not-run',
      recoveryScopeMatches: true,
      recoveryDataPresent: false,
      recoveryCancelled: false,
      recoveryCompleted: false,
      recoveryFinalizerApplied: false,
      recoveryGenerationAtCheck: 4,
      recoveryGenerationCurrent: 4,
      recoveryEditSeqAtCheck: 8,
      recoveryEditSeqCurrent: 8,
      draft: 'private draft contents',
      recoveryKey: 'private-key',
      error: new Error('private error text'),
    }, { arbitraryUnknownField: { get: privateGetter } });
    emitTimelineSaveDiagnostic('schedule', () => observation);
    const detail = (dispatch.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toMatchObject({
      phase: 'schedule',
      recoveryCheckOrdinal: 3,
      recoveryReadState: 'pending',
      recoverySkipReason: 'none',
      recoveryFinalizer: 'not-run',
      recoveryScopeMatches: true,
      recoveryDataPresent: false,
      recoveryCancelled: false,
      recoveryCompleted: false,
      recoveryFinalizerApplied: false,
      recoveryGenerationAtCheck: 4,
      recoveryGenerationCurrent: 4,
      recoveryEditSeqAtCheck: 8,
      recoveryEditSeqCurrent: 8,
    });
    expect(Object.isFrozen(detail)).toBe(true);
    expect(privateGetter).not.toHaveBeenCalled();
    expect(JSON.stringify(detail)).not.toMatch(/private draft contents|private-key|private error text|secret draft key/);

    emitTimelineSaveDiagnostic('recovery-current-snapshot', () => ({
      recoveryCheckOrdinal: 1_000_000_001,
      recoveryReadState: 'secret state',
      recoverySkipReason: 'secret reason',
      recoveryFinalizer: 'secret finalizer',
      recoveryGenerationAtCheck: -1,
      recoveryGenerationCurrent: Infinity,
      recoveryEditSeqAtCheck: 1.5,
      recoveryEditSeqCurrent: '8',
    }));
    const bounded = (dispatch.mock.calls[1][0] as CustomEvent).detail;
    expect(bounded).toMatchObject({
      recoveryCheckOrdinal: 'UNKNOWN', recoveryReadState: 'UNKNOWN', recoverySkipReason: 'UNKNOWN',
      recoveryFinalizer: 'UNKNOWN', recoveryGenerationAtCheck: 'UNKNOWN',
      recoveryGenerationCurrent: 'UNKNOWN', recoveryEditSeqAtCheck: 'UNKNOWN', recoveryEditSeqCurrent: 'UNKNOWN',
    });
    emitTimelineSaveDiagnostic('save-entry', () => observation);
    expect((dispatch.mock.lastCall![0] as CustomEvent).detail).not.toHaveProperty('recoveryCheckOrdinal');
  });

  it('keeps untagged recovery rejections unknown without inspecting properties or prototypes', () => {
    vi.stubGlobal('__timelineSaveDiagnosticsEnabled', true);
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);
    const trap = vi.fn(() => { throw new Error('private proxy trap'); });
    const hostile = new Proxy({}, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    const accessor = Object.defineProperties({}, {
      name: { get: trap },
      message: { get: trap },
    });
    const errors: Array<[unknown, string]> = [
      [new DOMException('private DOM text'), 'unknown'],
      [new Error('private Error text'), 'unknown'],
      [{ name: 'private arbitrary name', message: 'private arbitrary message' }, 'unknown'],
      [accessor, 'unknown'],
      [hostile, 'unknown'],
    ];
    for (const [error, errorClass] of errors) {
      emitTimelineSaveDiagnostic('recovery-current-snapshot', () => ({ recoveryCheckOrdinal: 7,
        recoveryReadState: 'rejected', recoverySkipReason: 'none', recoveryFinalizer: 'not-run', error }));
      const detail = (dispatch.mock.lastCall![0] as CustomEvent).detail;
      expect(detail).toMatchObject({ recoveryCheckOrdinal: 7, recoveryReadState: 'rejected', recoveryReadErrorClass: errorClass });
      expect(JSON.stringify(detail)).not.toMatch(/private DOM text|private Error text|private arbitrary|private proxy trap/);
    }
    expect(trap).not.toHaveBeenCalled();
  });
});

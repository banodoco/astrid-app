import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitTimelineSaveDiagnostic, markTimelineSaveRejection } from './timeline-diagnostics';

describe('timeline save diagnostic projection', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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

  it('projects recovery checks through frozen enums and bounded counters without leaking unknown fields', () => {
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
    emitTimelineSaveDiagnostic('recovery-check-at-schedule', () => observation);
    const detail = (dispatch.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toMatchObject({
      phase: 'recovery-check-at-schedule',
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

    emitTimelineSaveDiagnostic('recovery-check-at-schedule', () => ({
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
      emitTimelineSaveDiagnostic('recovery-read-settled', () => ({ recoveryCheckOrdinal: 7,
        recoveryReadState: 'rejected', recoverySkipReason: 'none', recoveryFinalizer: 'not-run', error }));
      const detail = (dispatch.mock.lastCall![0] as CustomEvent).detail;
      expect(detail).toMatchObject({ recoveryCheckOrdinal: 7, recoveryReadState: 'rejected', recoveryReadErrorClass: errorClass });
      expect(JSON.stringify(detail)).not.toMatch(/private DOM text|private Error text|private arbitrary|private proxy trap/);
    }
    expect(trap).not.toHaveBeenCalled();
  });
});

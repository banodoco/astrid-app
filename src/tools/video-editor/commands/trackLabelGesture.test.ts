import { describe, expect, it, vi } from 'vitest';
import type { TimelineData } from '../lib/timeline-data.ts';
import { captureTrackLabelEdit, submitTrackLabelEdit, type TrackLabelCapturePort } from './trackLabelGesture.ts';
import type { TrackLabelArgs } from './trackLabelCapture.ts';

function setup() {
  const basis = { original: { label: { state: 'absent' } } };
  const submit = vi.fn();
  const port: TrackLabelCapturePort = {
    capture: vi.fn(() => basis),
    finish: vi.fn((_basis, args) => ({ command: { schema_version: 1, op: 'track.set', version: '1',
      select: 'parent/track:V1', args } })),
    submit,
  };
  const current = { resolvedConfig: { tracks: [{ id: 'V1', label: 'display fallback' }] } } as TimelineData;
  return { port, basis, current, submit };
}

describe('track label gesture', () => {
  it.each<TrackLabelArgs>([
    { values: { label: 'Renamed' }, clear: [] },
    { values: { label: '' }, clear: [] },
    { values: {}, clear: ['label'] },
  ])('submits the original frozen capture with explicit args %j', (args) => {
    const { port, basis, current, submit } = setup();
    const captured = captureTrackLabelEdit(port, current, 'V1');
    basis.original.label.state = 'present';
    expect(Object.isFrozen(captured.basis.original)).toBe(true);
    expect(captured.basis).toEqual({ original: { label: { state: 'absent' } } });
    submitTrackLabelEdit(captured, args);
    expect(port.capture).toHaveBeenCalledOnce();
    expect(port.finish).toHaveBeenCalledWith(captured.basis, args);
    expect(submit).toHaveBeenCalledWith({ command: { schema_version: 1, op: 'track.set', version: '1',
      select: 'parent/track:V1', args }, preview: { version: 1, operations: [
      { op: 'track.update', target: 'V1', payload: { label: 'label' in args.values ? args.values.label : 'V1' } },
    ] } });
    expect(Object.isFrozen(submit.mock.calls[0][0].command.args)).toBe(true);
  });
  it('refuses missing or ambiguous tracks before capture', () => {
    const { port, current } = setup();
    expect(() => captureTrackLabelEdit(undefined, current, 'V1')).toThrow('unavailable');
    expect(() => captureTrackLabelEdit(port, current, 'missing')).toThrow('unambiguous');
    current.resolvedConfig.tracks.push(current.resolvedConfig.tracks[0]);
    expect(() => captureTrackLabelEdit(port, current, 'V1')).toThrow('unambiguous');
    expect(port.capture).not.toHaveBeenCalled();
  });
  it('preserves typed input and original capture when the host refuses completion', () => {
    const { port, current, submit } = setup();
    const captured = captureTrackLabelEdit(port, current, 'V1');
    const args: TrackLabelArgs = { values: { label: 'keep typing' }, clear: [] };
    port.finish = () => { throw new Error('changed'); };
    expect(() => submitTrackLabelEdit(captured, args)).toThrow('changed');
    expect(args.values.label).toBe('keep typing');
    expect(captured.basis).toEqual({ original: { label: { state: 'absent' } } });
    expect(submit).not.toHaveBeenCalled();
  });
  it.each(['clip.move', 'wrong-target', 'changed-args'])('rejects an incompatible host result: %s', (failure) => {
    const { port, current, submit } = setup();
    const captured = captureTrackLabelEdit(port, current, 'V1');
    const finish = port.finish;
    port.finish = (basis, args) => {
      const result = finish(basis, args);
      if (failure === 'clip.move') result.command.op = 'clip.move';
      if (failure === 'wrong-target') result.command.select = 'occurrence:o1/track:V1';
      if (failure === 'changed-args') result.command.args = { values: { label: 'other' }, clear: [] };
      return result;
    };
    expect(() => submitTrackLabelEdit(captured, { values: { label: 'typed' }, clear: [] })).toThrow('Unsupported');
    expect(submit).not.toHaveBeenCalled();
  });
});

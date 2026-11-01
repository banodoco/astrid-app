import { describe, expect, it, vi } from 'vitest';
import type { TimelineData } from '../lib/timeline-data.ts';
import { captureClipTrimEdit, submitClipTrimEdit, type ClipTrimCapturePort } from './clipTrimGesture.ts';

function setup() {
  const basis = { original: { from: 2, to: 6, hold: 17 } };
  const preview = { version: 1 as const, source: 'clip.trim' as const, operations: [
    { op: 'clip.update' as const, target: 'x', payload: { from: 1, to: 5, hold: 4 } },
  ] };
  const port: ClipTrimCapturePort = {
    capture: vi.fn(() => basis),
    finish: vi.fn((_basis, args) => ({ command: { schema_version: 1, op: 'clip.trim', version: '1',
      select: 'parent/clip:x', args: { in_s: args.in_s ?? null, out_s: args.out_s ?? null } }, preview })),
    submit: vi.fn(),
  };
  const current = { resolvedConfig: { clips: [{ id: 'x', from: 99, to: 100, speed: 4 }] } } as TimelineData;
  return { port, basis, current };
}

describe('clip trim gesture adapter', () => {
  it('freezes the begin basis and submits source endpoints to the parent command port', () => {
    const { port, basis, current } = setup();
    const captured = captureClipTrimEdit(port, current, 'x');
    basis.original.from = 9;
    current.resolvedConfig.clips[0].from = 1000;
    submitClipTrimEdit(captured, { in_s: 1, out_s: 5 });
    expect(port.capture).toHaveBeenCalledOnce();
    expect(port.finish).toHaveBeenCalledWith(captured.basis, { in_s: 1, out_s: 5 });
    expect(captured.basis.original).toEqual({ from: 2, to: 6, hold: 17 });
    expect(Object.isFrozen(captured.basis.original)).toBe(true);
    expect(port.submit).toHaveBeenCalledOnce();
  });

  it('refuses an unavailable or ambiguous capture before contacting the port', () => {
    const { port, current } = setup();
    expect(() => captureClipTrimEdit(undefined, current, 'x')).toThrow('unavailable');
    expect(() => captureClipTrimEdit(port, current, 'missing')).toThrow('unambiguous');
    current.resolvedConfig.clips.push(current.resolvedConfig.clips[0]);
    expect(() => captureClipTrimEdit(port, current, 'x')).toThrow('unambiguous');
    expect(port.capture).not.toHaveBeenCalled();
  });

  it('rejects a non-parent command result without submitting it', () => {
    const { port, current } = setup();
    const captured = captureClipTrimEdit(port, current, 'x');
    const finish = port.finish;
    port.finish = (basis, args) => {
      const result = finish(basis, args);
      result.command.select = 'occurrence:o/clip:x';
      return result;
    };
    expect(() => submitClipTrimEdit(captured, { in_s: 1 })).toThrow('Unsupported');
    expect(port.submit).not.toHaveBeenCalled();
  });
});

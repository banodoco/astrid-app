import type { TimelinePatch } from '@/sdk/video/timeline/patch.ts';
import type { TimelineData } from '../lib/timeline-data.ts';
import type { JsonObject } from './types.ts';

/** The published clip.move v1 envelope; recorder claims stay opaque here. */
export type ClipMoveProposal = JsonObject & {
  schema_version: 1;
  op: 'clip.move';
  version: '1';
  select: string;
  args: { on: number };
};

export interface PreparedClipMove {
  command: ClipMoveProposal;
  /** Quantized global preview position, resolved by the built-in operation. */
  previewAt: number;
}

/**
 * Host seam for Agent's built-in capture and the command outbox. capture must
 * read the raw optimistic authored closure, using current only to fence its
 * display identity. finish resolves the target against that original basis.
 * submit accepts command + preview together; it must never save the preview as
 * a replacement document. A return acknowledges local acceptance, not a save.
 */
export interface ClipMoveCapturePort {
  capture(input: { clipId: string; current: TimelineData }): JsonObject;
  finish(basis: JsonObject, on: number): PreparedClipMove;
  submit(input: { command: ClipMoveProposal; preview: TimelinePatch; transactionId?: string }): void;
}

export interface CapturedClipMove {
  readonly clipId: string;
  readonly trackId: string;
  readonly basis: JsonObject;
  readonly port: ClipMoveCapturePort;
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeJson);
    Object.freeze(value);
  }
  return value;
}

export function captureClipMove(
  port: ClipMoveCapturePort | undefined,
  current: TimelineData,
  clipId: string,
): CapturedClipMove {
  if (!port) throw new Error('clip.move capture is unavailable.');
  const matches = current.resolvedConfig.clips.filter((clip) => clip.id === clipId);
  if (matches.length !== 1) throw new Error('clip.move requires an unambiguous clip identity.');
  const identity = matches[0].app?.canonical;
  if (identity && typeof identity === 'object' && 'occurrenceId' in identity
    && (!('rawClipId' in identity) || typeof identity.rawClipId !== 'string'
      || !('clipRef' in identity) || typeof identity.clipRef !== 'string')) {
    throw new Error('clip.move requires an addressable raw clip identity.');
  }
  if (current.config.pinnedShotGroups?.some((group) => group.clipIds.includes(clipId))) {
    throw new Error('clip.move v1 does not support group moves.');
  }
  // Agent owns this basis, including tagged absence and scope/provenance pins.
  // Neither pointer movement nor an ACK may refresh or mutate it.
  const basis = freezeJson(structuredClone(port.capture({ clipId, current })));
  return Object.freeze({ clipId, trackId: matches[0].track, basis, port });
}

export function submitClipMove(
  captured: CapturedClipMove,
  on: number,
  options: { trackId?: string; transactionId?: string } = {},
): void {
  if (!Number.isFinite(on) || on < 0) throw new Error('clip.move requires a nonnegative absolute time.');
  if (options.trackId !== undefined && options.trackId !== captured.trackId) {
    throw new Error('clip.move v1 does not support cross-track moves.');
  }
  const prepared = captured.port.finish(captured.basis, on);
  if (prepared.command.schema_version !== 1 || prepared.command.op !== 'clip.move'
    || prepared.command.version !== '1' || prepared.command.args.on !== on
    || !Number.isFinite(prepared.previewAt) || prepared.previewAt < 0) {
    throw new Error('Unsupported clip.move capture result.');
  }
  captured.port.submit({
    command: freezeJson(structuredClone(prepared.command)),
    preview: {
      version: 1,
      operations: [{ op: 'clip.move', target: captured.clipId, payload: { at: prepared.previewAt } }],
    },
    ...(options.transactionId ? { transactionId: options.transactionId } : {}),
  });
}

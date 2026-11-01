import type { EditCommand } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelinePatch } from '@/sdk/video/timeline/patch.ts';
import type { TimelineData } from '../lib/timeline-data.ts';
import { buildDataFromCurrentRegistry } from '../lib/timeline-save-utils.ts';
import { equal, freezeJson, has, object } from './clipMovePrimitives.ts';
import type { ClipTrimArgs } from './clipTrimCapture.ts';
import type { JsonObject } from './types.ts';

export interface ClipTrimCapturePort {
  capture(input: { clipId: string; current: TimelineData }): JsonObject;
  finish(basis: JsonObject, args: ClipTrimArgs): { command: EditCommand; preview: TimelinePatch };
  submit(input: { command: EditCommand; preview: TimelinePatch }): void;
}

export interface CapturedClipTrim {
  readonly clipId: string;
  readonly basis: JsonObject;
  readonly port: ClipTrimCapturePort;
}

/** Capture at gesture begin, or immediately before a discrete source-window edit. */
export function captureClipTrimEdit(port: ClipTrimCapturePort | undefined, current: TimelineData, clipId: string): CapturedClipTrim {
  if (!port) throw new Error('clip.trim capture is unavailable.');
  if (current.resolvedConfig.clips.filter((clip) => clip.id === clipId).length !== 1) {
    throw new Error('clip.trim requires an unambiguous clip identity.');
  }
  const basis = freezeJson(structuredClone(port.capture({ clipId, current })));
  return Object.freeze({ clipId, basis, port });
}

/** Endpoints are source seconds; the native operation owns precision and hold. */
export function submitClipTrimEdit(captured: CapturedClipTrim, args: ClipTrimArgs): void {
  const { command, preview } = captured.port.finish(captured.basis, args);
  if (command.schema_version !== 1 || command.op !== 'clip.trim' || command.version !== '1'
    || command.select !== `parent/clip:${captured.clipId}`
    || !equal(command.args, { in_s: args.in_s ?? null, out_s: args.out_s ?? null })) {
    throw new Error('Unsupported clip.trim capture result.');
  }
  captured.port.submit({ command: freezeJson(structuredClone(command)), preview: freezeJson(structuredClone(preview)) });
}

/** Row serialization loses authored source windows on held clips. Keep this preview local and narrow. */
export function projectClipTrimPreview(patch: TimelinePatch, current: TimelineData): TimelineData | undefined {
  if (patch.source !== 'clip.trim') return undefined;
  const [operation] = patch.operations;
  const payload = operation?.payload;
  if (patch.version !== 1 || patch.operations.length !== 1 || operation.op !== 'clip.update' || !object(payload)
    || !['from', 'to', 'hold'].every((key) => typeof payload[key] === 'number' && Number.isFinite(payload[key]))
    || !Object.keys(payload).every((key) => ['from', 'to', 'hold', 'speed', 'app'].includes(key))
    || (has(payload, 'speed') && payload.speed !== null
      && (typeof payload.speed !== 'number' || !Number.isFinite(payload.speed) || payload.speed <= 0))
    || (has(payload, 'app') && !object(payload.app))
    || current.config.clips.filter((clip) => clip.id === operation.target).length !== 1) {
    throw new Error('Invalid native clip.trim preview');
  }
  const config = { ...current.config, clips: current.config.clips.map((clip) => clip.id === operation.target
    ? { ...clip, ...structuredClone(payload) } : clip) };
  return buildDataFromCurrentRegistry(config, current);
}

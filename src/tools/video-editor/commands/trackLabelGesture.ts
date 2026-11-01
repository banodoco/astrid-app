import type { EditCommand } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelinePatch } from '@/sdk/video/timeline/patch.ts';
import type { TimelineData } from '../lib/timeline-data.ts';
import type { TimelineEditability } from '../lib/timeline-editability.ts';
import { equal, freezeJson } from './clipMovePrimitives.ts';
import type { TrackLabelArgs } from './trackLabelCapture.ts';
import type { JsonObject } from './types.ts';

export interface TrackLabelDraft {
  value: string;
  dirty: boolean;
  finish?: (label: string) => void;
  captureError?: string;
  error?: string;
}

export type TrackLabelEditStart = ((trackId: string) => (label: string) => void) & {
  drafts?: Map<string, TrackLabelDraft>;
};

export interface TrackLabelCapturePort {
  // Unsent input belongs to this command owner, including a refused row teardown.
  drafts?: Map<string, TrackLabelDraft>;
  // The current host policy follows this owner across management-hook remounts.
  localEditability?: { current: TimelineEditability };
  capture(input: { trackId: string; current: TimelineData }): JsonObject;
  finish(basis: JsonObject, args: TrackLabelArgs): { command: EditCommand };
  submit(input: { command: EditCommand; preview: TimelinePatch }): void;
}

export interface CapturedTrackLabelEdit {
  readonly trackId: string;
  readonly basis: JsonObject;
  readonly port: TrackLabelCapturePort;
}

/** Capture before typing; only the session can resolve a display lane to its raw owner. */
export function captureTrackLabelEdit(
  port: TrackLabelCapturePort | undefined,
  current: TimelineData,
  trackId: string,
): CapturedTrackLabelEdit {
  if (!port) throw new Error('track.set label capture is unavailable.');
  if (current.resolvedConfig.tracks.filter((track) => track.id === trackId).length !== 1) {
    throw new Error('track.set label requires an unambiguous track identity.');
  }
  const basis = freezeJson(structuredClone(port.capture({ trackId, current })));
  return Object.freeze({ trackId, basis, port });
}

export function submitTrackLabelEdit(captured: CapturedTrackLabelEdit, args: TrackLabelArgs): void {
  const { command } = captured.port.finish(captured.basis, args);
  if (command.schema_version !== 1 || command.op !== 'track.set' || command.version !== '1'
    || command.select !== `parent/track:${captured.trackId}` || !equal(command.args, args)) {
    throw new Error('Unsupported track.set label capture result.');
  }
  captured.port.submit({
    command: freezeJson(structuredClone(command)),
    preview: { version: 1, operations: [{ op: 'track.update', target: captured.trackId,
      // Missing labels use a display fallback only; the command retains the explicit clear.
      payload: { label: 'label' in args.values ? args.values.label : captured.trackId } }] },
  });
}

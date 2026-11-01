import type { EditCommand, JSON } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelinePatch } from '@/sdk/video/timeline/patch.ts';
import type { TimelineData } from '../lib/timeline-data.ts';
import {
  captureClipElement,
  captureClipElementParams,
  finishClipElement,
  finishClipElementParams,
  type ElementCaptureArgs,
  type ElementCaptureBasis as NativeElementCaptureBasis,
  type ElementParamsArgs,
  type ElementParamsBasis as NativeElementParamsBasis,
} from './elementCapture.ts';
import { AuthoredState, copy, equal, freezeJson, object } from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';
import type { OutboxBasis, OutboxHead } from './commitOutbox.ts';

export type ElementEdit =
  | { elementRef: ElementCaptureArgs; params?: never }
  | { elementRef?: never; params: ElementParamsArgs };

type ElementRefEdit = Extract<ElementEdit, { elementRef: ElementCaptureArgs }>;

function isElementRefEdit(edit: ElementEdit): edit is ElementRefEdit {
  return 'elementRef' in edit;
}

export type ElementCaptureBasis = {
  readonly clipId: string;
  readonly select: string;
  readonly edit: ElementEdit;
  readonly capture: NativeElementCaptureBasis | NativeElementParamsBasis;
  readonly before: AuthoredBundle;
  readonly localGeneration: number;
  readonly localBasis: unknown;
  readonly previewVersion: number;
};

export type PreparedElementEdit = {
  command: EditCommand;
  preview: TimelinePatch;
};

export interface ElementCapturePort {
  capture(input: { clipId: string; current: TimelineData; edit: ElementEdit }): ElementCaptureBasis;
  finish(basis: ElementCaptureBasis, edit: ElementEdit): PreparedElementEdit;
  submit(input: PreparedElementEdit): void;
}

export type ElementOverlayOperation =
  | { kind: 'create'; row: Record<string, JSON>; track?: Record<string, JSON> }
  | { kind: 'delete'; select: string };

export type ElementOverlayCaptureBasis = {
  readonly operation: ElementOverlayOperation;
  readonly bundle: AuthoredBundle;
  readonly commands: readonly EditCommand[];
  readonly head: OutboxHead;
  readonly localGeneration: number;
  readonly localBasis: OutboxBasis;
  readonly previewVersion: number;
};

export type PreparedElementOverlay = {
  commands: EditCommand[];
  preview: TimelinePatch;
};

export interface ElementOverlayCapturePort {
  capture(input: { current: TimelineData; operation: ElementOverlayOperation }): ElementOverlayCaptureBasis;
  finish(basis: ElementOverlayCaptureBasis): PreparedElementOverlay;
  submit(input: PreparedElementOverlay): void;
}

export type CapturedElementEdit = {
  readonly clipId: string;
  readonly basis: ElementCaptureBasis;
  readonly port: ElementCapturePort;
};

function selectForClip(current: TimelineData, clipId: string): string {
  const matches = current.resolvedConfig.clips.filter((clip) => clip.id === clipId);
  if (matches.length !== 1) throw new Error('Element edit requires one existing clip');
  const identity = matches[0].app?.canonical as { clipRef?: string } | undefined;
  return identity?.clipRef ?? `parent/clip:${clipId}`;
}

export function captureClipElementEdit(
  port: ElementCapturePort | undefined,
  current: TimelineData,
  clipId: string,
  edit: ElementEdit,
): CapturedElementEdit {
  if (!port) throw new Error('Element edit capture is unavailable.');
  const basis = freezeJson(port.capture({ clipId, current, edit }));
  return Object.freeze({ clipId, basis, port });
}

export function submitClipElementEdit(captured: CapturedElementEdit, edit: ElementEdit): void {
  const prepared = captured.port.finish(captured.basis, edit);
  const expected = captured.basis.edit;
  if (!equal(expected, edit)
    || prepared.command.schema_version !== 1
    || (prepared.command.op !== 'clip.set-element' && prepared.command.op !== 'clip.set-params')
    || prepared.command.version !== '1'
    || prepared.command.select !== captured.basis.select) {
    throw new Error('Unsupported existing-clip element capture result.');
  }
  captured.port.submit({
    command: freezeJson(copy(prepared.command)),
    preview: freezeJson(copy(prepared.preview)),
  });
}

export function finishElementEdit(
  basis: ElementCaptureBasis,
  edit: ElementEdit,
): { command: EditCommand; bundle: AuthoredBundle; preview: TimelinePatch } {
  if (!equal(basis.edit, edit)) throw new Error('Element edit changed after original capture');
  const result = isElementRefEdit(edit)
    ? finishClipElement(basis.capture, edit.elementRef)
    : finishClipElementParams(basis.capture, edit.params);
  const entity = new AuthoredState(result.bundle).entity(basis.select);
  const payload = isElementRefEdit(edit)
    ? { elementRef: copy(edit.elementRef.elementRef) }
    : { params: object(entity?.params) ? copy(entity.params) as Record<string, JSON> : {} };
  return {
    command: result.command,
    bundle: result.bundle,
    preview: {
      version: basis.previewVersion,
      source: 'timeline.native-existing-element',
      operations: [{ op: 'clip.update', target: basis.clipId, payload }],
    },
  };
}

export function captureElementBasis(
  bundle: AuthoredBundle,
  select: string,
  edit: ElementEdit,
): ElementCaptureBasis['capture'] {
  return isElementRefEdit(edit)
    ? captureClipElement(bundle, select, edit.elementRef)
    : captureClipElementParams(bundle, select, edit.params);
}

export { selectForClip };

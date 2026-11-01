import type { EditCommand } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelineData } from '../lib/timeline-data.ts';
import { assertFiniteJson, equal, freezeJson } from './clipMovePrimitives.ts';
import type { OccurrenceDuplicateArgs } from './occurrenceDuplicateCapture.ts';
import type { JsonObject } from './types.ts';

export interface OccurrenceDuplicateCapturePort {
  capture(input: { ownerRef: string; args: OccurrenceDuplicateArgs; current: TimelineData }): JsonObject;
  finish(basis: JsonObject): { command: EditCommand };
  submit(input: { command: EditCommand }): void;
}

export interface CapturedOccurrenceDuplicate {
  readonly ownerRef: string;
  readonly args: OccurrenceDuplicateArgs;
  readonly basis: JsonObject;
  readonly port: OccurrenceDuplicateCapturePort;
}

/** Reserve only the occurrence and shot IDs, once, before calling this adapter. */
export function captureOccurrenceDuplicateEdit(
  port: OccurrenceDuplicateCapturePort | undefined,
  current: TimelineData,
  ownerRef: string,
  args: OccurrenceDuplicateArgs,
): CapturedOccurrenceDuplicate {
  if (!port) throw new Error('occurrence.duplicate capture is unavailable.');
  assertFiniteJson(args);
  const original = freezeJson(structuredClone(args));
  const basis = freezeJson(structuredClone(port.capture({ ownerRef, args: original, current })));
  return Object.freeze({ ownerRef, args: original, basis, port });
}

export function submitOccurrenceDuplicateEdit(captured: CapturedOccurrenceDuplicate): void {
  const { command } = captured.port.finish(captured.basis);
  assertFiniteJson(command);
  if (command.schema_version !== 1 || command.op !== 'occurrence.duplicate' || command.version !== '1'
    || command.select !== captured.ownerRef || !equal(command.args, captured.args)
    || !equal(command.intent, { ownership: 'occurrence' })) {
    throw new Error('Unsupported occurrence.duplicate capture result.');
  }
  captured.port.submit({ command: freezeJson(structuredClone(command)) });
}

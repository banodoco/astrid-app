import type { CommandRecord, EditCommand } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelinePatch, TimelinePatchOperation } from '@/sdk/video/timeline/patch.ts';
import { assembleTimelineData, type TimelineData } from '../lib/timeline-data.ts';
import { captureTrackLabel, finishTrackLabel, type TrackLabelArgs } from './trackLabelCapture.ts';
import {
  captureOrdinaryMoveMember,
  executeOrdinaryMoveMember,
  finishOrdinaryMoveMember,
} from './ordinaryMoveMember.ts';
import {
  captureOrdinaryScalarMember,
  executeOrdinaryScalarMember,
  type OrdinaryScalarClear,
  type OrdinaryScalarValues,
} from './ordinaryScalarMember.ts';
import {
  captureOrdinaryTrimMember,
  executeOrdinaryTrimMember,
  finishOrdinaryTrimMember,
  type OrdinaryTrimOperation,
} from './ordinaryTrimMember.ts';
import {
  captureOrdinaryStructuralBatch,
  executeOrdinaryStructuralBatch,
} from './ordinaryStructuralMember.ts';
import {
  AuthoredState,
  ClipMoveError,
  assertFiniteJson,
  copy,
  equal,
  freezeJson,
  has,
  object,
} from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

export class GenericPatchRefusal extends Error {
  readonly intentions: Array<{ operationIndex: number; op: string; target: string; reason: string }>;

  constructor(patch: TimelinePatch, failures: Map<number, string>) {
    const intentions = patch.operations.map((operation, operationIndex) => ({
      operationIndex,
      op: operation.op,
      target: operation.target,
      reason: failures.get(operationIndex) ?? 'Not submitted because another patch member was refused',
    }));
    super(`Native patch refused: ${intentions.map((item) =>
      `${item.operationIndex} ${item.op} ${item.target}: ${item.reason}`).join('; ')}`);
    this.intentions = intentions;
  }
}

function scalarPatchArgs(operation: TimelinePatchOperation): {
  readonly values: OrdinaryScalarValues;
  readonly clear: readonly OrdinaryScalarClear[];
} | undefined {
  if (operation.op !== 'clip.update') return undefined;
  const payload = operation.payload;
  if (!object(payload) || !equal(Object.keys(payload).sort(), ['clear', 'values'])
    || !object(payload.values) || !Array.isArray(payload.clear)) return undefined;
  const values = payload.values;
  const clear = payload.clear;
  if (Object.keys(values).some((key) => key !== 'hold') || (!Object.keys(values).length && !clear.length)) return undefined;
  const hasHold = Object.prototype.hasOwnProperty.call(values, 'hold');
  const hold = values.hold;
  const typedValues: OrdinaryScalarValues = {};
  if (hasHold) {
    if (typeof hold !== 'number' || !Number.isFinite(hold) || hold <= 0) return undefined;
    typedValues.hold = hold;
  }
  const typedClear: OrdinaryScalarClear[] = [];
  for (const key of clear) {
    if (key !== 'hold' && key !== 'asset' && key !== 'transition') return undefined;
    typedClear.push(key);
  }
  if (new Set(typedClear).size !== typedClear.length || (hasHold && typedClear.includes('hold'))) return undefined;
  return {
    values: typedValues,
    clear: typedClear,
  };
}

function scalarPatchPayload(operation: TimelinePatchOperation): boolean {
  return scalarPatchArgs(operation) !== undefined;
}

function trimPayloadShape(operation: TimelinePatchOperation): boolean {
  if ((operation.op as string) !== 'clip.trim' || !object(operation.payload)) return false;
  return Object.keys(operation.payload).every((key) => key === 'in_s' || key === 'out_s');
}

function ordinaryTrimOperation(operation: TimelinePatchOperation): OrdinaryTrimOperation | undefined {
  if (!trimPayloadShape(operation) || typeof operation.target !== 'string'
    || !operation.target || operation.target.includes('/')) return undefined;
  const payload = operation.payload!;
  if (Object.keys(payload).some((key) => {
    const value = payload[key];
    return value !== null && (typeof value !== 'number' || !Number.isFinite(value));
  })) return undefined;
  return {
    op: 'clip.trim',
    target: operation.target,
    payload: payload as OrdinaryTrimOperation['payload'],
  };
}

function qualified(operation: TimelinePatchOperation): boolean {
  return (operation.op === 'clip.move' && object(operation.payload)
      && equal(Object.keys(operation.payload), ['at']))
    || (operation.op === 'clip.update' && object(operation.payload)
      && (has(operation.payload, 'values') || has(operation.payload, 'clear')))
    || trimPayloadShape(operation);
}

function structural(operation: TimelinePatchOperation): boolean {
  return operation.op === 'track.add' || operation.op === 'clip.add' || operation.op === 'clip.remove';
}

function structuralSupported(operation: TimelinePatchOperation): boolean {
  if (!structural(operation) || typeof operation.target !== 'string' || !operation.target
    || (operation.order !== undefined && !Number.isFinite(operation.order))) return false;
  return operation.op === 'clip.remove'
    ? operation.payload === undefined || (object(operation.payload) && Object.keys(operation.payload).length === 0)
    : object(operation.payload);
}

function supported(operation: TimelinePatchOperation): boolean {
  const payload = operation.payload;
  if (Object.keys(operation).some((key) => !['op', 'target', 'payload', 'order'].includes(key))
    || typeof operation.target !== 'string' || !operation.target
    || (operation.order !== undefined && !Number.isFinite(operation.order))) return false;
  if (structural(operation)) return structuralSupported(operation);
  if (!object(payload)) return false;
  if (operation.op === 'track.update') {
    return typeof payload.label === 'string' && Object.keys(payload).every((key) => key === 'label' || key === 'mode')
      && (!('mode' in payload) || payload.mode === 'merge');
  }
  if (operation.op === 'clip.move') {
    return equal(Object.keys(payload), ['at'])
      && typeof payload.at === 'number' && Number.isFinite(payload.at) && payload.at >= 0;
  }
  if (operation.op === 'clip.update' && equal(Object.keys(payload), ['hold'])) {
    return typeof payload.hold === 'number' && Number.isFinite(payload.hold) && payload.hold > 0;
  }
  if ((operation.op as string) === 'clip.trim') return ordinaryTrimOperation(operation) !== undefined;
  return operation.op === 'clip.update' && scalarPatchPayload(operation);
}

export type GenericPatchSupport = 'supported' | 'unsupported' | 'mixed';

/** Classify the complete patch before native capture or owner resolution. */
export function classifyGenericPatch(patch: TimelinePatch): GenericPatchSupport {
  const supportedCount = patch.operations.filter(supported).length;
  const qualifiedCount = patch.operations.filter(qualified).length;
  if (qualifiedCount === 0) {
    if (supportedCount === patch.operations.length) return 'supported';
    return supportedCount ? 'mixed' : 'unsupported';
  }
  return supportedCount === patch.operations.length ? 'supported' : 'mixed';
}

function ordinaryTrimPreview(operation: TimelinePatchOperation): boolean {
  return operation.op === 'clip.update' && object(operation.payload)
    && equal(Object.keys(operation.payload).sort(), ['from', 'hold', 'to'])
    && Object.values(operation.payload).every((value) => typeof value === 'number' && Number.isFinite(value));
}

function commandArgs(command: EditCommand): TrackLabelArgs {
  if (!object(command.args) || !object(command.args.values) || !Array.isArray(command.args.clear)) {
    throw new Error('Unsupported track.set command arguments');
  }
  return command.args as unknown as TrackLabelArgs;
}

function executeTrackSet(bundle: AuthoredBundle, command: EditCommand, ordinal = 0) {
  if (command.op !== 'track.set' || typeof command.select !== 'string') {
    throw new Error('Unsupported native patch member');
  }
  const result = finishTrackLabel(captureTrackLabel(bundle, command.select), commandArgs(command));
  if (!equal(result.command, command)) throw new Error('Submitted track.set does not match its captured claims');
  result.record.ordinal = ordinal;
  result.record.derived_writes.forEach((write) => { write.cause = ordinal; });
  return result;
}

export function executeGenericPatch(bundle: AuthoredBundle, commands: readonly EditCommand[]) {
  let after = copy(bundle);
  const records: CommandRecord[] = [];
  for (const [ordinal, command] of commands.entries()) {
    const result = command.op === 'track.set'
      ? executeTrackSet(after, command, ordinal)
      : command.op === 'clip.move'
        ? executeOrdinaryMoveMember(after, command, ordinal)
      : command.op === 'clip.trim'
        ? executeOrdinaryTrimMember(after, command, ordinal)
      : command.op === 'clip.set'
        ? executeOrdinaryScalarMember(after, command, ordinal)
        : ['track.create', 'clip.add', 'clip.delete'].includes(command.op)
          ? (() => {
            const result = executeOrdinaryStructuralBatch(after, [command]);
            if (result.records.length !== 1) throw new Error('structural member did not produce one record');
            const record = copy(result.records[0]);
            record.ordinal = ordinal;
            record.derived_writes.forEach((write) => { write.cause = ordinal; });
            return { bundle: result.bundle, record };
          })()
        : (() => { throw new Error('Unsupported native patch member'); })();
    after = result.bundle;
    records.push(result.record);
  }
  return { bundle: after, records };
}

/** Native ordinary members; ownership comes from the host resolver. */
export function captureGenericPatch(
  bundle: AuthoredBundle,
  patch: TimelinePatch,
  resolve: (operation: TimelinePatchOperation) => string,
) {
  assertFiniteJson(patch);
  const original = freezeJson(copy(patch));
  const failures = new Map<number, string>();
  original.operations.forEach((operation, index) => {
    if (!supported(operation)) failures.set(index, qualified(operation)
      ? operation.op === 'clip.move'
        ? 'Requires an absolute clip.move with one finite non-negative at value'
        : 'Requires clip.set-compatible values and explicit clears'
      : 'Requires a parent label-only merge or exact positive hold SET');
  });
  if (!original.operations.length || !Number.isSafeInteger(original.version) || original.version < 0) {
    throw new Error('Native patch requires operations and a non-negative integer version');
  }
  if (failures.size) throw new GenericPatchRefusal(original, failures);
  const owners = original.operations.map((operation, index) => {
    if (structural(operation)) return 'parent';
    try { return resolve(operation); }
    catch (error) {
      failures.set(index, error instanceof Error ? error.message : String(error));
      return '';
    }
  });
  if (failures.size) throw new GenericPatchRefusal(original, failures);

  const ordered = original.operations.map((operation, index) => ({ operation, index })).sort((a, b) => {
    if (a.operation.order === undefined) return b.operation.order === undefined ? a.index - b.index : 1;
    if (b.operation.order === undefined) return -1;
    return a.operation.order - b.operation.order || a.index - b.index;
  });
  let after = copy(bundle);
  const commands: EditCommand[] = [];
  const records: CommandRecord[] = [];
  const previewOperations: TimelinePatchOperation[] = [];
  for (const { operation, index } of ordered) {
    try {
      let result;
      if (operation.op === 'track.update') {
        result = finishTrackLabel(captureTrackLabel(after, owners[index]), {
          values: { label: operation.payload!.label as string }, clear: [],
        });
        previewOperations.push({ op: operation.op, target: operation.target, payload: { label: operation.payload!.label } });
      } else if (operation.op === 'clip.move') {
        const basis = captureOrdinaryMoveMember(after, operation, owners[index]);
        const move = finishOrdinaryMoveMember(basis, commands.length);
        result = move;
        previewOperations.push({ op: operation.op, target: operation.target, payload: { at: move.previewAt } });
      } else if ((operation.op as string) === 'clip.trim') {
        const trim = ordinaryTrimOperation(operation);
        if (!trim) throw new ClipMoveError('Requires a closed source-window payload', 'unsupported_timing');
        if (owners[index] !== `parent/clip:${trim.target}`) {
          throw new ClipMoveError('ordinary clip.trim target must retain its reserved parent clip identity', 'identity_conflict');
        }
        const prepared = finishOrdinaryTrimMember(
          captureOrdinaryTrimMember(after, trim),
          commands.length,
        );
        result = prepared;
        const clip = new AuthoredState(prepared.bundle).entity(owners[index]);
        if (!clip || typeof clip.from !== 'number' || typeof clip.to !== 'number' || typeof clip.hold !== 'number') {
          throw new ClipMoveError('trim preview requires authored source-window leaves', 'unsupported_timing');
        }
        previewOperations.push({ op: 'clip.update', target: operation.target, payload: {
          from: clip.from, to: clip.to, hold: clip.hold,
        } });
      } else if (structural(operation)) {
        const structural = captureOrdinaryStructuralBatch(after, { version: original.version, operations: [operation] });
        const record = copy(structural.records[0]);
        record.ordinal = commands.length;
        record.derived_writes.forEach((write) => { write.cause = commands.length; });
        result = {
          command: structural.commands[0],
          bundle: structural.bundle,
          record,
        };
        previewOperations.push({ ...operation,
          ...(operation.payload === undefined ? {} : { payload: copy(operation.payload) }) });
      } else {
        const scalar = scalarPatchArgs(operation);
        const member = scalar ?? { values: { hold: operation.payload!.hold as number }, clear: [] };
        const command = captureOrdinaryScalarMember(after, { select: owners[index], ...member });
        result = executeOrdinaryScalarMember(after, command, commands.length);
        previewOperations.push({ op: operation.op, target: operation.target, payload: scalar
          ? { values: copy(scalar.values), clear: [...scalar.clear] }
          : { hold: operation.payload!.hold } });
      }
      result.record.ordinal = commands.length;
      result.record.derived_writes.forEach((write) => { write.cause = commands.length; });
      after = result.bundle;
      commands.push(result.command);
      records.push(result.record);
    } catch (error) {
      failures.set(index, error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.size) throw new GenericPatchRefusal(original, failures);
  const preview: TimelinePatch = {
    version: 1,
    source: 'timeline.native-ordinary',
    operations: previewOperations,
  };
  return freezeJson({ patch: original, owners, commands, records, bundle: after, preview });
}

export type GenericPatchBasis = {
  readonly current: TimelineData;
  readonly capture: ReturnType<typeof captureGenericPatch>;
  readonly localGeneration: number;
  readonly localBasis: import('./commitOutbox.ts').OutboxBasis;
};

export interface GenericPatchCapturePort {
  capture(input: { patch: TimelinePatch; current: TimelineData }): GenericPatchBasis;
  finish(basis: GenericPatchBasis): { commands: EditCommand[]; preview: TimelinePatch };
  submit(input: { commands: EditCommand[]; preview: TimelinePatch }): void;
}

/** One local projection, preserving exact authored values and unrelated display state. */
export function projectGenericPatchPreview(patch: TimelinePatch, current: TimelineData): TimelineData | undefined {
  if (patch.source !== 'timeline.native-label-hold' && patch.source !== 'timeline.native-ordinary'
    && patch.source !== 'timeline.native-structural') return undefined;
  assertFiniteJson(patch);
  if (patch.version !== 1 || !patch.operations.length || patch.operations.some((operation) =>
    !supported(operation) && !ordinaryTrimPreview(operation))) {
    throw new Error('Invalid native patch preview');
  }
  const config = copy(current.config);
  const resolvedConfig = copy(current.resolvedConfig);
  for (const operation of patch.operations) {
    for (const target of [config, resolvedConfig]) {
      if (structural(operation)) {
        if (operation.op === 'track.add') {
          target.tracks ??= [];
          target.tracks.push(Object.assign(
            { id: operation.target, kind: 'visual', label: '' } satisfies NonNullable<TimelineData['config']['tracks']>[number],
            copy(operation.payload ?? {}),
          ));
        } else if (operation.op === 'clip.add') {
          target.clips ??= [];
          target.clips.push(Object.assign(
            { id: operation.target, at: 0, track: '' } satisfies TimelineData['config']['clips'][number],
            copy(operation.payload ?? {}),
          ));
        } else {
          target.clips = (target.clips ?? []).filter((row) => row.id !== operation.target);
        }
        continue;
      }
      const rows = operation.op === 'track.update' ? target.tracks ?? [] : target.clips;
      const matches = rows.filter((row) => row.id === operation.target);
      if (matches.length !== 1) throw new Error('Native patch preview requires one displayed target');
      const scalar = scalarPatchArgs(operation);
      if (scalar) {
        const clips = target.clips.filter((row) => row.id === operation.target);
        if (clips.length !== 1) throw new Error('Native patch preview requires one displayed clip target');
        const clip = clips[0];
        Object.assign(clip, copy(scalar.values));
        for (const key of scalar.clear) {
          if (key === 'hold') delete clip.hold;
          else if (key === 'asset') delete clip.asset;
          else delete clip.transition;
        }
      } else {
        Object.assign(matches[0], copy(operation.payload));
      }
    }
  }
  return { ...current, ...assembleTimelineData({ ...current, config, resolvedConfig }), dataLanes: current.dataLanes };
}

import type { CommandRecord, EditCommand, JSON } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelinePatch, TimelinePatchOperation } from '@/sdk/video/timeline/patch.ts';
import {
  ClipMoveError,
  MoveRecording,
  assertFiniteJson,
  copy,
  equal,
  freezeJson,
  has,
  object,
} from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const EXTENSION_ID = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/;
const MAX_KEY_BYTES = 256;
const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_EXTENSION_TOTAL_BYTES = 1024 * 1024;
const MAX_ENTRIES_PER_EXTENSION = 128;
const CLAIMS = ['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created'] as const;

type ProjectDataArgs = {
  target: string;
  key: string;
  value: JSON;
  mode: 'replace';
};

type ProjectDataPatchArgs = {
  key: string;
  value: JSON;
  mode?: 'merge' | 'replace';
};

type ProjectDataOperation = TimelinePatchOperation & {
  op: 'project-data.write';
  payload: ProjectDataPatchArgs;
};

export type ProjectDataMemberCapture = {
  readonly patch: TimelinePatch;
  readonly commands: EditCommand[];
  readonly records: CommandRecord[];
  readonly bundle: AuthoredBundle;
};

export class ProjectDataMemberRefusal extends ClipMoveError {
  readonly intentions: Array<{ operationIndex: number; op: string; target: string; reason: string }>;

  constructor(patch: TimelinePatch, failures: Map<number, string>) {
    const intentions = patch.operations.map((operation, operationIndex) => ({
      operationIndex,
      op: operation.op,
      target: operation.target,
      reason: failures.get(operationIndex) ?? 'Not submitted because another patch member was refused',
    }));
    super(`Native project-data patch refused: ${intentions.map((item) =>
      `${item.operationIndex} ${item.op} ${item.target}: ${item.reason}`).join('; ')}`);
    this.intentions = intentions;
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function jsonBytes(value: JSON): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new ClipMoveError('project-data.write value must be finite JSON');
  return utf8Bytes(serialized);
}

function reservedKeyPath(value: unknown, path = '$', ancestors = new Set<object>()): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  if (ancestors.has(value)) return undefined;
  ancestors.add(value);
  for (const key of Object.keys(value)) {
    const next = `${path}.${key}`;
    if (RESERVED_KEYS.has(key)) return next;
    const nested = reservedKeyPath((value as Record<string, unknown>)[key], next, ancestors);
    if (nested) return nested;
  }
  ancestors.delete(value);
  return undefined;
}

function validateTarget(target: unknown): asserts target is string {
  if (typeof target !== 'string' || target.length === 0 || target.length > 128 || !EXTENSION_ID.test(target)) {
    throw new ClipMoveError('project-data.write requires an explicit extension target');
  }
}

function validateKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key !== key.trim()) {
    throw new ClipMoveError('project-data.write requires an already-canonical project-data key');
  }
  if (utf8Bytes(key) > MAX_KEY_BYTES) {
    throw new ClipMoveError('project-data.write project-data key exceeds 256 UTF-8 bytes');
  }
  if (RESERVED_KEYS.has(key)) throw new ClipMoveError(`project-data.write project-data key ${key} is reserved`);
}

function validateValue(value: unknown): asserts value is JSON {
  assertFiniteJson(value);
  const unsafePath = reservedKeyPath(value);
  if (unsafePath) throw new ClipMoveError(`project-data.write value contains reserved object key at ${unsafePath}`);
  jsonBytes(value as JSON);
}

function validatePatchArgs(args: unknown): asserts args is ProjectDataPatchArgs {
  if (!object(args)) {
    throw new ClipMoveError('project-data.write requires target, key, value, and mode arguments');
  }
  const keys = Object.keys(args).sort();
  if (!equal(keys, ['key', 'value']) && !equal(keys, ['key', 'mode', 'value'])) {
    throw new ClipMoveError('project-data.write requires target, key, value, and mode arguments');
  }
  validateKey(args.key);
  if (args.mode !== undefined && args.mode !== 'merge' && args.mode !== 'replace') {
    throw new ClipMoveError('project-data.write mode must be "merge" or "replace"');
  }
  validateValue(args.value);
}

function validateArgs(args: unknown): asserts args is ProjectDataArgs {
  if (!object(args) || !equal(Object.keys(args).sort(), ['key', 'mode', 'target', 'value'])) {
    throw new ClipMoveError('project-data.write requires target, key, value, and mode arguments');
  }
  validateTarget(args.target);
  validateKey(args.key);
  if (args.mode !== 'replace') throw new ClipMoveError('project-data.write only supports mode "replace"');
  validateValue(args.value);
}

function validateOperation(operation: TimelinePatchOperation): asserts operation is ProjectDataOperation {
  if (Object.keys(operation).some((key) => !['op', 'target', 'payload', 'order'].includes(key)) ||
    operation.op !== 'project-data.write' || typeof operation.target !== 'string' ||
    (operation.order !== undefined && (typeof operation.order !== 'number' || !Number.isFinite(operation.order))) ||
    !object(operation.payload)) {
    throw new ClipMoveError('Only a closed project-data.write operation is supported');
  }
  validateTarget(operation.target);
  validatePatchArgs(operation.payload);
}

function pathClaim(ref: string, path: readonly string[]): string {
  const spelling = path.map((part, index) => {
    const prefix = index === 0 ? '' : '.';
    return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(part)
      ? `${prefix}${part}`
      : `[${JSON.stringify(part)}]`;
  }).join('');
  return `${ref}::${spelling}`;
}

function replaceGeneratedClaims(ctx: MoveRecording): void {
  const expect: Record<string, ReturnType<typeof ctx.state.get>> = {};
  const authorship: Record<string, 'direct'> = {};
  for (const write of ctx.record.writes) {
    const claim = pathClaim(write.ref, write.path);
    expect[claim] ??= copy(write.before);
    authorship[claim] = 'direct';
  }
  ctx.command.expect = expect;
  ctx.command.authorship = authorship;
}

function validateLimits(bundle: AuthoredBundle, args: ProjectDataArgs, projectedValue: JSON): void {
  const config = bundle.parent.config;
  if (config !== undefined && config !== null && !object(config)) {
    throw new ClipMoveError('project-data.write requires an authored parent config object');
  }
  const app = object(config) ? config.app : undefined;
  if (app !== undefined && app !== null && !object(app)) {
    throw new ClipMoveError('project-data.write requires an authored parent app object');
  }
  const namespace = object(app) ? app[args.target] : undefined;
  if (namespace !== undefined && namespace !== null && !object(namespace)) {
    throw new ClipMoveError('project-data.write requires an authored extension namespace object or null');
  }
  if (jsonBytes(args.value) > MAX_ENTRY_BYTES) {
    throw new ClipMoveError('project-data.write value exceeds the 64 KiB entry limit');
  }
  const projected = { ...(object(namespace) ? namespace : {}), [args.key]: projectedValue };
  if (!has(object(namespace) ? namespace : {}, args.key) && Object.keys(projected).length > MAX_ENTRIES_PER_EXTENSION) {
    throw new ClipMoveError('project-data.write exceeds the 128-entry extension limit');
  }
  const total = Object.values(projected).reduce<number>((sum, value) => sum + jsonBytes(value), 0);
  if (total > MAX_EXTENSION_TOTAL_BYTES) {
    throw new ClipMoveError('project-data.write exceeds the 1 MiB extension limit');
  }
}

function deepMergeObject(target: Record<string, JSON>, source: Record<string, JSON>): Record<string, JSON> {
  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = target[key];
    if (sourceValue !== null && typeof sourceValue === 'object' && !Array.isArray(sourceValue) &&
      targetValue !== null && typeof targetValue === 'object' && !Array.isArray(targetValue)) {
      target[key] = deepMergeObject(
        targetValue as Record<string, JSON>,
        sourceValue as Record<string, JSON>,
      );
    } else {
      target[key] = sourceValue;
    }
  }
  return target;
}

function lowerProjectDataValue(
  original: JSON | undefined,
  args: Pick<ProjectDataPatchArgs, 'value' | 'mode'>,
): JSON {
  if (args.mode !== 'merge' || original === undefined || original === null || typeof original !== 'object' ||
    Array.isArray(original) || args.value === null || typeof args.value !== 'object' || Array.isArray(args.value)) {
    return copy(args.value);
  }
  return deepMergeObject(copy(original) as Record<string, JSON>, args.value as Record<string, JSON>);
}

function orderedOperations(patch: TimelinePatch): Array<{ operation: ProjectDataOperation; index: number }> {
  return patch.operations
    .map((operation, index) => ({ operation: operation as ProjectDataOperation, index }))
    .sort((a, b) => {
      const aOrdered = a.operation.order !== undefined;
      const bOrdered = b.operation.order !== undefined;
      if (aOrdered && !bOrdered) return -1;
      if (!aOrdered && bOrdered) return 1;
      if (aOrdered && bOrdered && a.operation.order !== b.operation.order) {
        return a.operation.order! - b.operation.order!;
      }
      return a.index - b.index;
    });
}

function closedCommand(command: EditCommand): void {
  const allowed = ['schema_version', 'op', 'version', 'select', 'args', 'intent', 'rationale', 'group_id', ...CLAIMS];
  if (Object.keys(command).some((key) => !allowed.includes(key)) || command.schema_version !== 1 ||
    command.op !== 'project-data.write' || command.version !== '1' || command.select !== 'parent') {
    throw new ClipMoveError('project-data.write requires the closed EditCommand envelope');
  }
  if (command.intent !== undefined && !equal(command.intent, {})) {
    throw new ClipMoveError('project-data.write has no intention overrides');
  }
  validateArgs(command.args);
}

function applyProjectDataMember(
  bundle: AuthoredBundle,
  supplied: EditCommand,
  ordinal = 0,
  sourceMode: ProjectDataPatchArgs['mode'] = 'replace',
) {
  closedCommand(supplied);
  const command = { ...copy(supplied), intent: {}, resolved: [], reads: [], selections: [], expect: {},
    authorship: {}, bindings: {}, created: [] } as EditCommand;
  const args = command.args as unknown as ProjectDataArgs;
  const ctx = new MoveRecording(bundle, command);
  // project-data.write is a non-singleton parent operation in Agent's registry.
  ctx.command.resolved = [];
  ctx.object('parent', ['config']);
  ctx.object('parent', ['config', 'app']);
  ctx.object('parent', ['config', 'app', args.target]);
  const original = ctx.state.get('parent', ['config', 'app', args.target, args.key]);
  const projectedValue = lowerProjectDataValue(
    original.state === 'present' ? original.value : undefined,
    { value: args.value, mode: sourceMode },
  );
  validateLimits(bundle, args, projectedValue);
  (ctx.command.args as unknown as ProjectDataArgs).value = projectedValue;
  ctx.write('parent', ['config', 'app', args.target, args.key], projectedValue);
  replaceGeneratedClaims(ctx);
  ctx.record.ordinal = ordinal;
  ctx.record.derived_writes.forEach((write) => { write.cause = ordinal; });
  for (const claim of CLAIMS) {
    if (has(supplied, claim) && !equal(supplied[claim], ctx.command[claim])) {
      throw new ClipMoveError(`submitted ${claim} does not match original capture`, 'capture_mismatch');
    }
  }
  // Agent's project-data compatibility check treats container reads as
  // generated setup claims, not portable input reads. Keep them in the full
  // record while leaving the submitted command's optional reads claim absent.
  delete ctx.command.reads;
  return { command: ctx.command, bundle: ctx.state.bundle, record: ctx.record };
}

function unsupportedReason(operation: TimelinePatchOperation): string | undefined {
  try {
    validateOperation(operation);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Capture one ordered source/source-map project-data batch without registering it. */
export function captureProjectDataMember(bundle: AuthoredBundle, patch: TimelinePatch): ProjectDataMemberCapture {
  assertFiniteJson(bundle);
  assertFiniteJson(patch);
  const original = freezeJson(copy(patch));
  const failures = new Map<number, string>();
  original.operations.forEach((operation, index) => {
    const reason = unsupportedReason(operation);
    if (reason) failures.set(index, reason);
  });
  if (!original.operations.length) failures.set(0, 'Native project-data patch requires at least one operation');
  if (failures.size) throw new ProjectDataMemberRefusal(original, failures);

  let after = copy(bundle);
  const commands: EditCommand[] = [];
  const records: CommandRecord[] = [];
  for (const { operation, index } of orderedOperations(original)) {
    try {
      const command: EditCommand = {
        schema_version: 1,
        op: 'project-data.write',
        version: '1',
        select: 'parent',
        args: {
          target: operation.target,
          key: operation.payload.key,
          value: copy(operation.payload.value),
          mode: 'replace',
        } as unknown as Record<string, JSON>,
        intent: {},
      };
      const result = applyProjectDataMember(after, command, commands.length, operation.payload.mode ?? 'replace');
      after = result.bundle;
      commands.push(result.command);
      records.push(result.record);
    } catch (error) {
      failures.set(index, error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.size) throw new ProjectDataMemberRefusal(original, failures);
  return freezeJson({ patch: original, commands, records, bundle: after });
}

/** Re-run captured commands against an authored bundle using the same carriers. */
export function executeProjectDataMember(bundle: AuthoredBundle, commands: readonly EditCommand[]) {
  if (!commands.length) throw new ClipMoveError('project-data command batch must not be empty');
  let after = copy(bundle);
  const records: CommandRecord[] = [];
  for (const [ordinal, command] of commands.entries()) {
    const result = applyProjectDataMember(after, command, ordinal);
    after = result.bundle;
    records.push(result.record);
  }
  return { bundle: after, records };
}

export const captureProjectDataPatch = captureProjectDataMember;
export const executeProjectDataPatch = executeProjectDataMember;

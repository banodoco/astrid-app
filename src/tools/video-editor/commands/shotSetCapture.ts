import type {
  AgentBinding,
  AgentDependency,
  AgentRead,
  AgentState,
  AgentWrite,
  CommandRecord,
  EditCommand,
  JSON,
  ShotSetArgs,
} from '@/integrations/runtime/timeline-commit-types.ts';
import { copy, equal, freezeJson, type AuthoredBundle, ClipMoveError } from './clipMovePrimitives.ts';

type ObjectValue = { [key: string]: JSON };
type NameArgs = { values: { name: string }; clear: [] };
export type ExistingShotSetArgs = ShotSetArgs;
export type ShotSetBasis = { readonly bundle: AuthoredBundle; readonly command: EditCommand };
type ShotSetResult = { command: EditCommand; bundle: AuthoredBundle; record: CommandRecord };

const CLAIMS = ['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created'] as const;
const SETTING_KEYS = new Set([
  'videoControlMode', 'prompt', 'negativePrompt', 'dimensionSource', 'generationMode', 'selectedModel',
  'motionMode', 'selectedPhasePresetId', 'textBeforePrompts', 'textAfterPrompts', 'generationTypeMode',
  'batchVideoFrames', 'batchVideoSteps', 'customWidth', 'customHeight', 'guidanceScale', 'amountOfMotion',
  'enhancePrompt', 'turboMode', 'advancedMode', 'smoothContinuations', 'ltxHdResolution',
]);
const CLEAR_KEYS = new Set(['name', ...[...SETTING_KEYS].map((key) => `settings.${key}`)]);

const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const STRING_SETTINGS = new Set(['videoControlMode', 'prompt', 'negativePrompt', 'dimensionSource', 'generationMode',
  'selectedModel', 'motionMode', 'selectedPhasePresetId', 'textBeforePrompts', 'textAfterPrompts', 'generationTypeMode']);
const NUMBER_SETTINGS = new Set(['batchVideoFrames', 'batchVideoSteps', 'customWidth', 'customHeight', 'guidanceScale', 'amountOfMotion']);
const BOOLEAN_SETTINGS = new Set(['enhancePrompt', 'turboMode', 'advancedMode', 'smoothContinuations', 'ltxHdResolution']);

function state(value: unknown): AgentState {
  return value === ABSENT ? { state: 'absent' } : { state: 'present', value: copy(value as JSON) };
}
const ABSENT = Symbol('absent');

function pathValue(payload: ObjectValue, path: string[]): AgentState {
  let value: unknown = payload;
  for (const key of path) {
    if (!object(value) || !has(value, key)) return { state: 'absent' };
    value = value[key];
  }
  return state(value);
}

function occurrence(bundle: AuthoredBundle, owner: string): ObjectValue {
  const id = owner.slice('occurrence:'.length);
  const matches = bundle.placements.filter((row) => object(row) && row.occurrence_id === id);
  if (matches.length !== 1) throw new ClipMoveError('shot.set requires one explicit occurrence owner', 'identity_conflict');
  return matches[0];
}

function isAuthoredBundle(value: unknown): value is AuthoredBundle {
  if (!object(value) || !object(value.parent) || !Array.isArray(value.placements)
    || !value.placements.every((placement) => object(placement)) || !object(value.shots)) return false;
  return Object.values(value.shots).every((authored) => object(authored) && object(authored.internal_timeline));
}

function isEditCommand(value: unknown): value is EditCommand {
  return object(value) && value.schema_version === 1 && typeof value.op === 'string'
    && typeof value.version === 'string' && (value.select === null || typeof value.select === 'string')
    && object(value.args);
}

function shot(bundle: AuthoredBundle, owner: string): { occurrence: ObjectValue; shot: ObjectValue; payload: ObjectValue; source: ObjectValue } {
  const placement = occurrence(bundle, owner);
  if (typeof placement.shot_id !== 'string') throw new ClipMoveError('shot.set occurrence has no authored shot owner', 'identity_conflict');
  const authored = bundle.shots[placement.shot_id];
  if (!authored || !object(authored.payload)) throw new ClipMoveError('shot.set authored shot payload is unavailable', 'identity_conflict');
  const sourceMapping = bundle.source_mapping;
  if (!object(sourceMapping) || !object(sourceMapping.shots)) {
    throw new ClipMoveError('shot.set source pin is unavailable', 'identity_conflict');
  }
  const source = sourceMapping.shots[placement.shot_id];
  if (!source || !object(source)) throw new ClipMoveError('shot.set source pin is unavailable', 'identity_conflict');
  return { occurrence: placement, shot: authored, payload: authored.payload, source };
}

function assertSelect(select: unknown): asserts select is string {
  if (typeof select !== 'string' || !/^occurrence:(?!.*::)[^/]+\/shot$/.test(select)) {
    throw new ClipMoveError('shot.set requires an explicit occurrence shot identity');
  }
}

function assertArgs(args: unknown): asserts args is ExistingShotSetArgs {
  if (!object(args) || !object(args.values) || !Array.isArray(args.clear)
    || !equal(Object.keys(args).sort(), ['clear', 'values'])) {
    throw new ClipMoveError('shot.set requires values and clear');
  }
  const values = args.values;
  if (!equal(Object.keys(values).filter((key) => key !== 'settings').sort(), values.name === undefined ? [] : ['name'])) {
    throw new ClipMoveError('shot.set supports only name and settings values');
  }
  if (values.name !== undefined && typeof values.name !== 'string') {
    throw new ClipMoveError('shot.set name must be a string');
  }
  if (values.settings !== undefined) {
    if (!object(values.settings) || Object.keys(values.settings).length === 0
      || Object.keys(values.settings).some((key) => !SETTING_KEYS.has(key))) {
      throw new ClipMoveError('shot.set settings contains an unsupported or empty field set');
    }
    for (const [key, value] of Object.entries(values.settings as Record<string, unknown>)) {
      const valid = value === null
        || (STRING_SETTINGS.has(key) && typeof value === 'string')
        || (NUMBER_SETTINGS.has(key) && typeof value === 'number' && Number.isFinite(value))
        || (BOOLEAN_SETTINGS.has(key) && typeof value === 'boolean');
      if (!valid) throw new ClipMoveError(`shot.set setting ${key} has an invalid value`);
    }
  }
  const seen = new Set<string>();
  for (const entry of args.clear) {
    if (typeof entry !== 'string' || !CLEAR_KEYS.has(entry) || seen.has(entry)) {
      throw new ClipMoveError('shot.set clear contains an unsupported or duplicate field');
    }
    seen.add(entry);
  }
  const setPaths = new Set<string>([
    ...(values.name === undefined ? [] : ['name']),
    ...(values.settings ? Object.keys(values.settings).map((key) => `settings.${key}`) : []),
  ]);
  if ([...seen].some((entry) => setPaths.has(entry))) throw new ClipMoveError('shot.set field cannot be both set and cleared');
  if (setPaths.size === 0 && seen.size === 0) throw new ClipMoveError('shot.set requires at least one field');
}

function addRead(reads: AgentRead[], ref: string, path: string[], value: AgentState): void {
  const read = { ref, path, state: value };
  if (!reads.some((candidate) => equal(candidate, read))) reads.push(copy(read));
}

function apply(bundle: AuthoredBundle, supplied: EditCommand): ShotSetResult {
  const select = supplied.select;
  assertSelect(select);
  if (supplied.schema_version !== 1 || supplied.op !== 'shot.set' || supplied.version !== '1'
    || !equal(supplied.intent ?? {}, { ownership: 'occurrence' })) {
    throw new ClipMoveError('shot.set has an unsupported operation or intention');
  }
  assertArgs(supplied.args);
  const owner = select.slice(0, -'/shot'.length);
  const selected = shot(bundle, owner);
  const sourceId = selected.source.shot_id;
  if (typeof sourceId !== 'string') throw new ClipMoveError('shot.set source pin has no shot owner', 'identity_conflict');
  const command: EditCommand = {
    ...copy(supplied),
    resolved: [select], reads: [], selections: [], expect: {}, authorship: {},
    bindings: { 'shot.owner': owner }, created: [], intent: { ownership: 'occurrence' },
  };
  const reads = command.reads!;
  addRead(reads, owner, ['occurrence_id'], state(selected.occurrence.occurrence_id));
  addRead(reads, select, ['shot_id'], state(sourceId));
  const writes: AgentWrite[] = [];
  const dependencies: AgentDependency[] = [{ key: 'shot.source', kind: 'entity', pin: { source: copy(selected.source) }, policy: 'exact' }];
  const bindings: AgentBinding[] = [{ key: 'shot.owner', ref: owner, policy: 'fixed', dependencies: [] }];
  const next = copy(bundle);
  const nextSelected = shot(next, owner);
  const assign = (path: string[], after: AgentState) => {
    const address = `${select}::${path.join('.')}`;
    const before = pathValue(selected.payload, path.slice(1));
    command.expect![address] ??= before;
    command.authorship![address] = 'direct';
    writes.push({ ref: select, path, before, after: copy(after) });
    let target: ObjectValue = nextSelected.payload;
    for (const key of path.slice(1, -1)) {
      if (!object(target[key])) target[key] = {};
      target = target[key] as ObjectValue;
    }
    const key = path[path.length - 1];
    if (after.state === 'absent') delete target[key];
    else target[key] = copy(after.value);
  };
  if (supplied.args.values.name !== undefined) assign(['payload', 'name'], { state: 'present', value: supplied.args.values.name });
  if (supplied.args.values.settings) {
    const rawSettings = selected.payload.settings;
    if (rawSettings !== undefined && rawSettings !== null && !object(rawSettings)) {
      throw new ClipMoveError('shot.set settings root is not an object');
    }
    if (!object(rawSettings)) {
      addRead(reads, select, ['payload', 'settings'], pathValue(selected.payload, ['settings']));
      assign(['payload', 'settings'], { state: 'present', value: {} });
    }
    const settings = supplied.args.values.settings as Record<string, JSON>;
    for (const key of Object.keys(settings).sort()) {
      assign(['payload', 'settings', key], { state: 'present', value: settings[key] });
    }
  }
  for (const entry of [...supplied.args.clear].sort()) assign(['payload', ...entry.split('.')], { state: 'absent' });
  const record: CommandRecord = {
    ordinal: 0, command, writes, reads, selections: [], bindings, created: [], dependencies, derived_writes: [],
  };
  for (const key of CLAIMS) {
    if (has(supplied, key) && !equal(supplied[key], command[key])) {
      throw new ClipMoveError(`submitted ${key} does not match original capture`, 'capture_mismatch');
    }
  }
  return { command, bundle: next, record };
}

export function captureShotSet(bundle: AuthoredBundle, select: string, args: ExistingShotSetArgs = { values: { name: '' }, clear: [] }): ShotSetBasis {
  const original = copy(bundle);
  const snapshot = copy(original);
  assertSelect(select);
  assertArgs(args);
  const { command } = apply(snapshot, {
    schema_version: 1, op: 'shot.set', version: '1', select, args: copy(args), intent: { ownership: 'occurrence' },
  });
  return freezeJson({ bundle: original, command });
}

export function finishShotSet(basis: unknown, args: ExistingShotSetArgs): ShotSetResult {
  if (!object(basis)) throw new ClipMoveError('incomplete shot.set capture basis');
  const bundle = basis.bundle;
  const command = basis.command;
  if (!isAuthoredBundle(bundle) || !isEditCommand(command)
    || !CLAIMS.every((key) => has(command, key))) throw new ClipMoveError('incomplete shot.set capture basis');
  assertArgs(args);
  return apply(bundle, { ...copy(command), args: copy(args) });
}

export function executeShotSet(bundle: AuthoredBundle, command: EditCommand) {
  const result = apply(bundle, command);
  return result;
}

export type ShotSetNameArgs = NameArgs;

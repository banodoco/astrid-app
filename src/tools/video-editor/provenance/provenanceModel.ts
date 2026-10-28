import type { Generation, GenerationVariant, ManagedObject, ObjectLocation, Task } from '@/integrations/runtime/generated.ts';
import type {
  ProvenanceInput,
  ProvenanceOrigin,
  ProvenanceRecord,
  ProvenanceRecipeFact,
  ProvenanceSnapshot,
  ProvenanceVariant,
} from './types.ts';

/** Recipe keys the packs we ship write, in the order a person reads them. */
const RECIPE_KEYS = [
  'model', 'model_name', 'checkpoint', 'base_model', 'version',
  'seed', 'steps', 'cfg', 'cfg_scale', 'sampler', 'scheduler',
  'width', 'height', 'duration_seconds', 'fps', 'prompt', 'negative_prompt',
] as const;

const RECIPE_LABELS: Record<string, string> = {
  model: 'Model',
  model_name: 'Model',
  checkpoint: 'Checkpoint',
  base_model: 'Base model',
  version: 'Version',
  seed: 'Seed',
  steps: 'Steps',
  cfg: 'CFG',
  cfg_scale: 'CFG',
  sampler: 'Sampler',
  scheduler: 'Scheduler',
  width: 'Width',
  height: 'Height',
  duration_seconds: 'Duration',
  fps: 'FPS',
  prompt: 'Prompt',
  negative_prompt: 'Negative',
};

const MONO_KEYS = new Set(['seed', 'cfg', 'cfg_scale', 'steps', 'width', 'height', 'fps']);

/** Plumbing rather than recipe, so "also recorded" stays readable. */
const PLUMBING_KEYS = new Set([
  'filename', 'mime_type', 'size', 'source_task_id', 'input_object_ids', 'content_type',
  'output_name', 'output_ordinal', 'primary_policy',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function formatFact(label: string, value: unknown): ProvenanceRecipeFact | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { label, value: String(value), mono: MONO_KEYS.has(label.toLowerCase()) };
  }
  const text = asString(value);
  if (!text) return null;
  // Prompts get their own block; a 2,000-character row would break the panel.
  if (text.length > 96) return null;
  return { label, value: text, mono: MONO_KEYS.has(label.toLowerCase()) };
}

export function recipeFrom(params: Record<string, unknown>): ProvenanceRecipeFact[] {
  const facts: ProvenanceRecipeFact[] = [];
  for (const key of RECIPE_KEYS) {
    const fact = formatFact(RECIPE_LABELS[key] ?? key, params[key]);
    if (fact && !facts.some(existing => existing.label === fact.label)) facts.push(fact);
  }
  return facts;
}

/**
 * Parameters this build has no label for. Showing them is the point: a pack we
 * do not describe is exactly where the producer-schema gap becomes visible.
 */
export function unlabelledParams(params: Record<string, unknown>): ProvenanceRecipeFact[] {
  const known = new Set<string>([...RECIPE_KEYS, ...PLUMBING_KEYS]);
  return Object.keys(params)
    .filter(key => !known.has(key) && !key.startsWith('_'))
    .sort()
    .flatMap((key) => {
      const fact = formatFact(key, params[key]);
      return fact ? [fact] : [];
    })
    .slice(0, 6);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = value >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
  return `${shown} ${units[unit]}`;
}

export function shortDigest(digest: string): string {
  const hex = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest;
  return hex.length <= 16 ? hex : `${hex.slice(0, 8)}…${hex.slice(-4)}`;
}

export interface TaskOutput {
  digest: string;
  filename: string | null;
  role: string | null;
  mediaType: string | null;
  primary: boolean;
}

/** `Task.result.outputs` is the only authoritative object→task link the Runtime exposes. */
export function taskOutputs(task: Task): TaskOutput[] {
  const outputs = (task.result as Record<string, unknown> | null | undefined)?.outputs;
  if (!Array.isArray(outputs)) return [];
  return outputs.flatMap((entry) => {
    const record = asRecord(entry);
    const digest = asString(record.digest);
    if (!digest) return [];
    return [{
      digest,
      filename: asString(record.filename),
      role: asString(record.role),
      mediaType: asString(record.media_type),
      primary: record.is_primary === true || record.role === 'result',
    }];
  });
}

export interface TaskMatch {
  task: Task;
  output: TaskOutput;
}

export interface ProvenanceIndex {
  objects: Map<string, ManagedObject>;
  variantsByObject: Map<string, { generation: Generation; variant: GenerationVariant }>;
  /** Every task that produced these exact bytes, most authoritative first. */
  tasksByObject: Map<string, TaskMatch[]>;
}

/**
 * Bytes are content-addressed, so a retry — or two packs — can settle identical
 * output. Preference is explicit so the same workspace always names the same
 * producer: a primary result beats a side output, the first production beats a
 * later re-production, and the task id settles a genuine tie.
 */
function preferredFirst(left: TaskMatch, right: TaskMatch): number {
  if (left.output.primary !== right.output.primary) return left.output.primary ? -1 : 1;
  const created = (left.task.created_at ?? '').localeCompare(right.task.created_at ?? '');
  if (created !== 0) return created;
  return left.task.task_id.localeCompare(right.task.task_id);
}

export function indexProvenance(snapshot: ProvenanceSnapshot): ProvenanceIndex {
  const objects = new Map(snapshot.objects.map(object => [object.object_id, object]));
  const generations = new Map(snapshot.generations.map(generation => [generation.generation_id, generation]));

  const variantsByObject = new Map<string, { generation: Generation; variant: GenerationVariant }>();
  for (const variant of snapshot.variants) {
    const generation = generations.get(variant.generation_id);
    if (generation && variant.object_id) variantsByObject.set(variant.object_id, { generation, variant });
  }

  const tasksByObject = new Map<string, TaskMatch[]>();
  for (const task of snapshot.tasks) {
    for (const output of taskOutputs(task)) {
      const matches = tasksByObject.get(output.digest) ?? [];
      matches.push({ task, output });
      tasksByObject.set(output.digest, matches);
    }
  }
  for (const matches of tasksByObject.values()) matches.sort(preferredFirst);

  return { objects, variantsByObject, tasksByObject };
}

function declaredOrigin(generation: Generation | null): ProvenanceOrigin {
  if (!generation) return 'unknown';
  const declared = asString(asRecord(generation.metadata.provenance).origin);
  if (declared === 'generated') return 'generated';
  if (declared === 'imported') return 'imported';
  if (declared === 'rendering' || declared === 'rendered') return 'rendered';
  return 'recorded';
}

function originFor(generation: Generation | null, match: TaskMatch | null): ProvenanceOrigin {
  if (match) {
    const capability = match.task.capability_id;
    if (capability.startsWith('generation.')) return 'generated';
    if (capability.startsWith('runtime.media.import')) return 'imported';
    if (capability.startsWith('rendering.')) return 'rendered';
    const family = asString(asRecord(match.task.result).adapter_family);
    if (family === 'render') return 'rendered';
    // A task settled these bytes, but not a capability this build knows how to describe.
    return 'recorded';
  }
  return declaredOrigin(generation);
}

function inputsFor(objectIds: string[], index: ProvenanceIndex): ProvenanceInput[] {
  return objectIds.map((objectId) => {
    const object = index.objects.get(objectId);
    return {
      objectId,
      filename: object?.filename ?? null,
      mediaType: object?.media_type ?? null,
      loaded: Boolean(object),
    };
  });
}

function variantsFor(generationId: string | null, variants: GenerationVariant[]): ProvenanceVariant[] {
  if (!generationId) return [];
  return variants
    .filter(variant => variant.generation_id === generationId && variant.object_id)
    .map(variant => ({
      generationId,
      objectId: variant.object_id as string,
      viewedAt: variant.viewed_at ?? null,
    }));
}

function inputIdsFor(match: TaskMatch | null, generation: Generation | null): string[] {
  if (match?.task.input_object_ids?.length) return match.task.input_object_ids;
  return generation ? asStringArray(asRecord(generation.metadata).input_object_ids) : [];
}

export function buildProvenanceRecord(
  object: ManagedObject,
  snapshot: ProvenanceSnapshot,
  index: ProvenanceIndex = indexProvenance(snapshot),
): ProvenanceRecord {
  const match = index.tasksByObject.get(object.object_id)?.[0] ?? null;
  const linked = index.variantsByObject.get(object.object_id) ?? null;
  const generation = linked?.generation ?? null;

  const params = generation ? asRecord(asRecord(generation.metadata).params) : {};
  const recipe = recipeFrom(params);
  const origin = originFor(generation, match);

  const inputs = inputsFor(inputIdsFor(match, generation), index);
  const unloadedInputs = inputs.filter(input => !input.loaded);
  const uses = snapshot.usage.get(object.object_id) ?? [];

  const gaps: string[] = [];
  const limits: string[] = [];

  const producerBounded = Boolean(snapshot.truncated?.tasks || snapshot.truncated?.generations);
  if (!match && !generation) {
    if (producerBounded) {
      limits.push('No producer found in the tasks and generations this view reads — it stops at a page boundary, so a producer and its inputs may exist outside it.');
    } else {
      gaps.push('No producer record for this file in the workspace.');
    }
  }
  if (origin === 'imported') {
    gaps.push('Imported, not generated — no model or seed exists to show.');
  }
  if (origin === 'recorded') {
    gaps.push('A task settled these bytes, but its capability is not one this build describes, so the recipe is unlabelled.');
  }
  if (origin === 'generated' && !recipe.some(fact => fact.label === 'Model')) {
    gaps.push('The generating model is not recorded on this asset.');
  }
  if (origin === 'generated' && !recipe.some(fact => fact.label === 'Seed')) {
    gaps.push('No seed recorded, so this variant cannot be reproduced exactly.');
  }
  if (!inputs.length) {
    if (!match && !generation && producerBounded) {
      // The producer search stopped early, so absence of inputs is not a fact.
    } else {
      gaps.push('No input objects recorded.');
    }
  } else if (unloadedInputs.length) {
    limits.push(`${unloadedInputs.length} of ${inputs.length} recorded input${inputs.length === 1 ? '' : 's'} fall outside the page of objects this view loaded, so only the id is shown.`);
  }
  if (!uses.length && snapshot.truncated?.timelines) {
    limits.push('Only the first timelines of this project were read for references.');
  }

  return {
    objectId: object.object_id,
    filename: object.filename ?? shortDigest(object.digest),
    mediaType: object.media_type,
    size: object.size,
    digest: object.digest,
    createdAt: object.created_at ?? null,
    origin,
    producer: match
      ? {
        kind: 'task',
        label: match.task.capability_id,
        capability: match.task.capability_id,
        status: match.task.state,
        createdAt: match.task.created_at ?? null,
        taskId: match.task.task_id,
        runId: match.task.run_id,
        attemptId: match.task.attempt_id ?? null,
        generationId: generation?.generation_id ?? null,
      }
      : {
        kind: generation ? 'generation' : 'none',
        label: generation?.type ?? 'unknown',
        capability: null,
        status: generation?.status ?? null,
        createdAt: generation?.created_at ?? null,
        taskId: null,
        runId: null,
        attemptId: null,
        generationId: generation?.generation_id ?? null,
      },
    recipe,
    extraFields: unlabelledParams(params),
    prompt: asString(params.prompt),
    inputs,
    variants: variantsFor(generation?.generation_id ?? null, snapshot.variants),
    uses,
    gaps,
    limits,
  };
}

export function buildProvenanceRecords(snapshot: ProvenanceSnapshot): ProvenanceRecord[] {
  const index = indexProvenance(snapshot);
  return snapshot.objects
    .map(object => buildProvenanceRecord(object, snapshot, index))
    .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''));
}

/**
 * Only the facts a receipt is allowed to carry. `local_path`, account ids and
 * executor ids stay in the app: a receipt is handed to someone else.
 */
export function redactLocation(location: ObjectLocation | null | undefined) {
  if (!location) return null;
  return { storage: location.storage, size: location.size, verified: location.verified };
}

/** The exported receipt: everything the panel shows, and nothing machine-specific. */
export function receiptFor(
  record: ProvenanceRecord,
  options: { location?: ObjectLocation | null } = {},
) {
  return {
    schema: 'astrid.provenance.v1',
    asset: {
      object_id: record.objectId,
      filename: record.filename,
      media_type: record.mediaType,
      size: record.size,
      digest: record.digest,
      created_at: record.createdAt,
    },
    origin: record.origin,
    producer: record.producer,
    recipe: record.recipe,
    extra_fields: record.extraFields,
    prompt: record.prompt,
    inputs: record.inputs,
    uses: record.uses.map(use => ({ timeline_id: use.timelineId, timeline_name: use.timelineName })),
    integrity: redactLocation(options.location),
    gaps: record.gaps,
    limits: record.limits,
    exported_at: new Date().toISOString(),
  };
}

export function receiptJson(
  record: ProvenanceRecord,
  options: { location?: ObjectLocation | null } = {},
): string {
  return `${JSON.stringify(receiptFor(record, options), null, 2)}\n`;
}

export function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

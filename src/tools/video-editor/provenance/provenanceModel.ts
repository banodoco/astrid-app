import type { Generation, GenerationVariant, ManagedObject, Task } from '@/integrations/runtime/generated.ts';
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

interface TaskOutput {
  digest: string;
  filename: string | null;
  role: string | null;
  mediaType: string | null;
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
    }];
  });
}

function generationIndex(generations: Generation[], variants: GenerationVariant[]) {
  const byGeneration = new Map<string, Generation>(generations.map(entry => [entry.generation_id, entry]));
  const byObject = new Map<string, { generation: Generation; variant: GenerationVariant }>();
  for (const variant of variants) {
    const generation = byGeneration.get(variant.generation_id);
    if (generation && variant.object_id) byObject.set(variant.object_id, { generation, variant });
  }
  return { byObject, byGeneration };
}

function originFor(generation: Generation | null, task: Task | null): ProvenanceOrigin {
  if (task) {
    if (task.capability_id.startsWith('generation.')) return 'generated';
    if (task.capability_id.startsWith('runtime.media.import')) return 'imported';
    if (task.capability_id.startsWith('rendering.')) return 'rendered';
    const family = asString(asRecord(task.result).adapter_family);
    if (family === 'render') return 'rendered';
  }
  if (!generation) return 'unknown';
  const declared = asString(asRecord(generation.metadata.provenance).origin);
  if (declared === 'generated') return 'generated';
  if (declared === 'imported') return 'imported';
  return generation.type === 'render' ? 'rendered' : 'unknown';
}

function inputsFor(objectIds: string[], objects: Map<string, ManagedObject>): ProvenanceInput[] {
  return objectIds
    .filter(id => objects.has(id))
    .map(id => ({ objectId: id, filename: objects.get(id)?.filename ?? null }));
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

export function buildProvenanceRecord(
  object: ManagedObject,
  snapshot: ProvenanceSnapshot,
): ProvenanceRecord {
  const objectsById = new Map(snapshot.objects.map(entry => [entry.object_id, entry]));
  const { byObject } = generationIndex(snapshot.generations, snapshot.variants);

  const task = snapshot.tasks.find(candidate => taskOutputs(candidate).some(output => output.digest === object.object_id)) ?? null;
  const generated = byObject.get(object.object_id) ?? null;
  const generation = generated?.generation ?? null;

  const generationParams = generation ? asRecord(asRecord(generation.metadata).params) : {};
  const recipeSource = generation ? { ...generationParams } : {};
  const recipe = recipeFrom(recipeSource);

  const origin = originFor(generation, task);
  const gaps: string[] = [];
  if (origin === 'unknown') gaps.push('No producer record for this file in the workspace.');
  if (origin === 'imported') gaps.push('Imported, not generated — no model or seed exists to show.');
  if (origin === 'generated' && !recipe.some(fact => fact.label === 'Model')) gaps.push('The generating model is not recorded on this asset.');
  if (origin === 'generated' && !recipe.some(fact => fact.label === 'Seed')) gaps.push('No seed recorded, so this variant cannot be reproduced exactly.');

  const inputIds = task?.input_object_ids?.length
    ? task.input_object_ids
    : asStringArray(generation ? asRecord(generation.metadata).input_object_ids : []);
  const inputs = inputsFor(inputIds, objectsById);
  if (!inputs.length) gaps.push('No input objects recorded.');

  const uses = snapshot.usage.get(object.object_id) ?? [];

  return {
    objectId: object.object_id,
    filename: object.filename ?? shortDigest(object.digest),
    mediaType: object.media_type,
    size: object.size,
    digest: object.digest,
    createdAt: object.created_at ?? null,
    origin,
    producer: {
      kind: origin === 'rendered' ? 'render' : origin === 'generated' ? 'generation' : origin === 'imported' ? 'import' : 'unknown',
      label: task?.capability_id ?? (generation?.type ? generation.type : 'unknown'),
      status: task?.state ?? generation?.status ?? null,
      createdAt: task?.created_at ?? generation?.created_at ?? null,
      taskId: task?.task_id ?? null,
      runId: task?.run_id ?? null,
      attemptId: task?.attempt_id ?? null,
      generationId: generation?.generation_id ?? null,
    },
    recipe,
    prompt: asString(recipeSource.prompt),
    inputs,
    variants: variantsFor(generation?.generation_id ?? null, snapshot.variants),
    uses,
    gaps,
  };
}

export function buildProvenanceRecords(snapshot: ProvenanceSnapshot): ProvenanceRecord[] {
  return snapshot.objects
    .map(object => buildProvenanceRecord(object, snapshot))
    .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''));
}

/** The exported receipt: everything the panel shows, and nothing machine-specific. */
export function receiptFor(record: ProvenanceRecord) {
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
    inputs: record.inputs,
    uses: record.uses.map(use => ({ timeline_id: use.timelineId, timeline_name: use.timelineName })),
    gaps: record.gaps,
    exported_at: new Date().toISOString(),
  };
}

export function receiptJson(record: ProvenanceRecord): string {
  return `${JSON.stringify(receiptFor(record), null, 2)}\n`;
}

export function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

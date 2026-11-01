import type { BatchImageGenerationTaskParams } from '@/shared/types/imageGeneration';
import { TaskValidationError, type TaskCreationResult } from './types';
import {
  createTask,
  ingestProjectInputFromUrl,
  resolveTaskCapability,
} from './createTask';
import {
  bridgeTaskAdmissionRequestSchema,
} from '@/tools/video-editor/data/bridgeContract.ts';
import type { TaskCreationRequest } from './types';
import type { CreateTaskOptions } from './createTask';
import { astridBase } from '@/integrations/runtime/connection.ts';
import { composeDisabledReason } from '@/shared/components/RuntimeConnection/copy.ts';

export const IMAGE_GENERATION_CAPABILITY_ID = 'generation.generate_image';
export const IMAGE_I2I_CAPABILITY_ID = 'generation.generate_image_cloud_i2i';

const SUPPORTED_MODELS = new Set(['z-image', 'qwen-image-2512']);
// The registered Astrid capability is currently the cloud/provider route.
// Keep local and Codex execution fail-closed until they have distinct catalog
// identities and readiness contracts.
const SUPPORTED_EXECUTIONS = new Set(['cloud']);
const MAX_IMAGES_PER_TASK = 16;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_SEED = 2_147_483_647;
const MAX_STEPS = 1_000;
const MAX_CLOUD_I2I_SOURCE_BYTES = 512_000;
const BOUNDED_CLOUD_I2I_SIZE = '1024x1024';
const MAX_COMPOSE_RESPONSE_BYTES = 256 * 1024;

/** The hosted page's gateway does not serve the composer, so neither creator may send a request from there. */
function assertComposeAvailable(): void {
  const disabledReason = composeDisabledReason();
  if (disabledReason) throw new TaskValidationError(disabledReason, 'generation_intent');
}

export interface ImageToImageTaskOptions {
  sourceUrl: string;
  prompt: string;
  strength: number;
  count: number;
  model?: 'z-image';
  execution?: 'cloud';
  basedOn?: string;
  sourceVariantId?: string | null;
  loraCount?: number;
  enablePromptExpansion?: boolean;
  createAsGeneration?: boolean;
  toolTypeOverride?: string;
  shotId?: string;
}

export interface CompiledImageGenerationParams {
  model: string;
  mode: 't2i';
  execution: 'local' | 'cloud' | 'codex';
  prompt: string;
  count: number;
  seed?: number;
  steps?: number;
  size?: string;
}

async function composeCreativeImageAdmission(
  project: string,
  capabilityDigest: string,
  spec: CompiledImageGenerationParams,
): Promise<TaskCreationRequest> {
  let response: Response;
  try {
    response = await fetch(`${astridBase()}/generation/compose`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project,
        capability_digest: capabilityDigest,
        params: spec,
      }),
    });
  } catch (error) {
    throw new TaskValidationError(
      `Image generation composer is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      'generation_intent',
    );
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_COMPOSE_RESPONSE_BYTES) {
      throw new TaskValidationError('Image generation composer response exceeds its bounded size', 'generation_intent');
    }
  }
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_COMPOSE_RESPONSE_BYTES) {
    throw new TaskValidationError('Image generation composer response exceeds its bounded size', 'generation_intent');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new TaskValidationError('Image generation composer returned malformed JSON', 'generation_intent');
  }
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'detail' in payload
      ? String((payload as { detail?: unknown }).detail ?? '')
      : '';
    throw new TaskValidationError(
      `Image generation composer refused the request${detail ? `: ${detail}` : ''}`,
      'generation_intent',
    );
  }
  const parsed = bridgeTaskAdmissionRequestSchema.safeParse(payload);
  if (!parsed.success) {
    throw new TaskValidationError('Image generation composer returned an invalid HC-04 request', 'generation_intent');
  }
  const request = parsed.data as TaskCreationRequest;
  const returnedParams = request.spec.params;
  const expectedParamKeys = Object.keys(spec);
  const paramsMatch = expectedParamKeys.every(
    (key) => JSON.stringify(returnedParams[key]) === JSON.stringify(spec[key as keyof CompiledImageGenerationParams]),
  ) && Object.keys(returnedParams).every((key) => expectedParamKeys.includes(key));
  if (
    request.project !== project
    || request.capability_id !== IMAGE_GENERATION_CAPABILITY_ID
    || request.capability_digest !== capabilityDigest
    || request.spec.family !== IMAGE_GENERATION_CAPABILITY_ID
    || !paramsMatch
    || request.settlement_effect.effect_type !== 'generation.publish_v1'
    || request.settlement_effect.target_id !== project
    || request.settlement_effect.payload.modality !== 'image'
    || request.generation_intent === undefined
  ) {
    throw new TaskValidationError('Image generation composer returned a mismatched creative admission', 'generation_intent');
  }
  return request;
}

function requireInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TaskValidationError(`${field} must be an integer from ${min} through ${max}`, field);
  }
  return value;
}

function requireOptionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  return value === undefined ? undefined : requireInteger(value, field, min, max);
}

/** Compile one text-only UI prompt into the registered Astrid executor schema. */
export function compileImageGenerationParams(
  params: BatchImageGenerationTaskParams,
): CompiledImageGenerationParams[] {
  const model = params.model_name;
  if (!model || !SUPPORTED_MODELS.has(model)) {
    throw new TaskValidationError(
      `Image model ${model ?? '(missing)'} is not registered by Astrid; supported models: z-image, qwen-image-2512`,
      'model_name',
    );
  }
  const execution = params.execution;
  if (!execution || !SUPPORTED_EXECUTIONS.has(execution)) {
    throw new TaskValidationError('The registered Astrid image route currently supports cloud execution only', 'execution');
  }
  if (params.imagesPerPrompt === undefined) {
    throw new TaskValidationError('imagesPerPrompt is required', 'imagesPerPrompt');
  }
  const count = requireInteger(params.imagesPerPrompt, 'imagesPerPrompt', 1, MAX_IMAGES_PER_TASK);
  if (!Array.isArray(params.prompts) || params.prompts.length === 0) {
    throw new TaskValidationError('At least one image prompt is required', 'prompts');
  }
  if (params.prompts.length !== 1) {
    throw new TaskValidationError(
      'The registered Astrid image route currently admits one prompt per task; batch fan-out is not yet atomic',
      'prompts',
    );
  }

  const unsupportedMedia = [
    'style_reference_image',
    'subject_reference_image',
    'in_this_scene',
    'subject_description',
    'reference_mode',
  ] as const;
  if (unsupportedMedia.some((key) => params[key] !== undefined)) {
    throw new TaskValidationError(
      'Text-only image admission cannot carry reference media; use the B03-T05b i2i route',
      'input_object_ids',
    );
  }
  if (params.loras && params.loras.length > 0) {
    throw new TaskValidationError('LoRA controls are not yet part of the typed text-image route', 'loras');
  }
  const unsupportedControls = [
    ['shot_id', 'shot lineage'],
    ['negative_prompt', 'negative prompts'],
    ['resolution_scale', 'resolution scaling'],
    ['resolution_mode', 'resolution mode'],
    ['custom_aspect_ratio', 'custom aspect ratio'],
    ['num_inference_steps', 'inference-step alias'],
    ['hires_scale', 'hires scaling'],
    ['hires_steps', 'hires steps'],
    ['hires_denoise', 'hires denoise'],
    ['lightning_lora_strength_phase_1', 'phase-one LoRA strength'],
    ['lightning_lora_strength_phase_2', 'phase-two LoRA strength'],
    ['additional_loras', 'additional LoRAs'],
    ['style_reference_strength', 'reference strength'],
    ['subject_strength', 'reference strength'],
    ['in_this_scene_strength', 'reference strength'],
  ] as const;
  const rawParams = params as unknown as Record<string, unknown>;
  const unsupportedControl = unsupportedControls.find(([key]) => rawParams[key] !== undefined);
  if (unsupportedControl) {
    throw new TaskValidationError(
      `${unsupportedControl[1]} are not part of the typed text-image route`,
      unsupportedControl[0],
    );
  }
  const seed = requireOptionalInteger(params.seed, 'seed', 0, MAX_SEED);
  const steps = requireOptionalInteger(params.steps, 'steps', 1, MAX_STEPS);
  if (params.resolution === undefined) {
    throw new TaskValidationError('An authoritative image resolution is required', 'resolution');
  }
  const resolutionMatch = /^(\d+)x(\d+)$/.exec(params.resolution.trim());
  const width = resolutionMatch === null ? NaN : Number(resolutionMatch[1]);
  const height = resolutionMatch === null ? NaN : Number(resolutionMatch[2]);
  if (
    resolutionMatch === null
    || !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 1
    || height < 1
    || width > MAX_IMAGE_DIMENSION
    || height > MAX_IMAGE_DIMENSION
  ) {
    throw new TaskValidationError('resolution must use positive WIDTHxHEIGHT pixels', 'resolution');
  }
  const size = params.resolution.trim();

  return params.prompts.map((entry) => {
    const prompt = entry.fullPrompt.trim();
    if (!prompt) throw new TaskValidationError('Image prompt must be non-empty', 'prompts');
    return {
      model,
      mode: 't2i',
      execution,
      prompt,
      count,
      ...(seed !== undefined ? { seed } : {}),
      ...(steps !== undefined ? { steps } : {}),
      size,
    };
  });
}

export type ImageGenerationTaskOptions = CreateTaskOptions & { preparedRequest?: TaskCreationRequest };
export type ImagePlacementTarget = { ownerRef: string; lane: string; anchor: string | null };
export type ImageGenerationPlacement = {
  projectId: string;
  unavailableReason?: string;
  prepare(target: ImagePlacementTarget): Promise<ImageGenerationTaskOptions>;
};

/** Admit one prompt as one canonical task until batch admission is atomic. */
export async function createImageGenerationTasks(
  project: string,
  params: BatchImageGenerationTaskParams,
  options?: ImageGenerationTaskOptions,
): Promise<TaskCreationResult> {
  assertComposeAvailable();
  const compiled = compileImageGenerationParams(params);
  const spec = compiled[0];
  if (!spec) throw new TaskValidationError('Image generation request compiled to no task', 'prompts');
  if (options?.preparedRequest) {
    const request = options.preparedRequest;
    if (!options.reservation || request.project !== project || request.capability_id !== IMAGE_GENERATION_CAPABILITY_ID
      || Object.keys(request.spec.params).length !== Object.keys(spec).length
      || !Object.entries(spec).every(([key, value]) => request.spec.params[key] === value)) {
      throw new TaskValidationError('Saved placement task differs from this generation draft');
    }
    return createTask(request, options);
  }
  const capability = options?.client ? await options.client.catalog.get(IMAGE_GENERATION_CAPABILITY_ID)
    : await resolveTaskCapability(project, IMAGE_GENERATION_CAPABILITY_ID);
  if (capability.estimated_scratch_bytes <= 0 || capability.estimated_output_bytes <= 0) {
    throw new TaskValidationError(
      'Astrid image capability has no nonzero storage estimate; producer admission is blocked',
      'storage_estimate',
    );
  }
  const request = await composeCreativeImageAdmission(project, capability.definition_digest, spec);
  const result = options ? await createTask(request, options) : await createTask(request);
  const taskIds = result.task_ids ?? [result.task_id];
  return {
    task_id: taskIds[0] ?? '',
    task_ids: taskIds,
    status: result.status ?? 'Queued',
  };
}
/** Admit one narrow, CAS-backed z-image image-to-image task. */
export async function createImageToImageTask(
  project: string,
  options: ImageToImageTaskOptions,
): Promise<TaskCreationResult> {
  assertComposeAvailable();
  if (options.model !== undefined && options.model !== 'z-image') {
    throw new TaskValidationError('Only z-image is registered for the typed i2i route', 'model');
  }
  if (options.execution !== undefined && options.execution !== 'cloud') {
    throw new TaskValidationError('The typed i2i route currently supports cloud execution only', 'execution');
  }
  if (!options.prompt.trim()) {
    throw new TaskValidationError('Image-to-image prompt must be non-empty', 'prompt');
  }
  if (!Number.isFinite(options.strength) || options.strength < 0 || options.strength > 1) {
    throw new TaskValidationError('Image-to-image strength must be between 0 and 1', 'strength');
  }
  const count = requireInteger(options.count, 'count', 1, MAX_IMAGES_PER_TASK);
  if (count !== 1) {
    throw new TaskValidationError(
      'The bounded cloud i2i route currently admits exactly one output per task',
      'count',
    );
  }
  if ((options.loraCount ?? 0) > 0) {
    throw new TaskValidationError('LoRA controls are not part of the typed i2i route', 'loras');
  }
  if (options.enablePromptExpansion) {
    throw new TaskValidationError('Prompt expansion is not part of the typed i2i route', 'enable_prompt_expansion');
  }
  if (options.createAsGeneration || options.toolTypeOverride || options.shotId) {
    throw new TaskValidationError('Task-level legacy routing controls are not part of the typed i2i route', 'task_options');
  }
  if (options.basedOn || options.sourceVariantId) {
    throw new TaskValidationError(
      'Runtime does not yet expose an atomic generation/variant lineage effect for typed i2i tasks',
      'lineage',
    );
  }

  const capability = await resolveTaskCapability(project, IMAGE_I2I_CAPABILITY_ID);
  if (capability.estimated_scratch_bytes <= 0 || capability.estimated_output_bytes <= 0) {
    throw new TaskValidationError(
      'Astrid i2i capability has no nonzero storage estimate; producer admission is blocked',
      'storage_estimate',
    );
  }
  const source = await ingestProjectInputFromUrl(project, options.sourceUrl, {
    maxBytes: MAX_CLOUD_I2I_SOURCE_BYTES,
    requireImage: true,
  });
  if (!source.media_type.startsWith('image/')) {
    throw new TaskValidationError('Image-to-image source must be an image media type', 'sourceUrl');
  }
  if (source.size > MAX_CLOUD_I2I_SOURCE_BYTES) {
    throw new TaskValidationError(
      'Cloud i2i source exceeds the currently verified provider upload boundary',
      'sourceUrl',
    );
  }
  const result = await createTask({
    project,
    capability_id: IMAGE_I2I_CAPABILITY_ID,
    capability_digest: capability.definition_digest,
    schema_version: '1',
    input_object_ids: [source.object_id],
    spec: {
      family: IMAGE_I2I_CAPABILITY_ID,
      params: {
        model: 'z-image',
        mode: 'i2i',
        execution: 'cloud',
        prompt: options.prompt.trim(),
        count,
        size: BOUNDED_CLOUD_I2I_SIZE,
        strength: options.strength,
          image_ref: {
            digest: source.object_id,
            filename: source.filename,
            media_type: source.media_type,
          },
      },
      output_policy: {},
    },
    storage_estimate: {
      // The dedicated capability publishes a whole-task envelope that
      // already includes the bounded source, staging copies, controls, and
      // final manifest. Do not add the source a second time here.
      scratch_bytes: capability.estimated_scratch_bytes,
      output_bytes: capability.estimated_output_bytes,
    },
    settlement_effect: {
      effect_type: 'generation.create_with_variant',
      target_id: project,
      payload: {
        generation_type: 'image',
        metadata: {
          params: {
            tool_type: 'image-to-image',
            content_type: 'image',
            model: 'z-image',
            mode: 'i2i',
            prompt: options.prompt.trim(),
            strength: options.strength,
            size: BOUNDED_CLOUD_I2I_SIZE,
          },
        },
        variant_type: 'image_to_image',
        output_name: 'generated_images',
        output_ordinal: 0,
        primary_policy: 'preserve',
      },
    },
  });
  const taskIds = result.task_ids ?? [result.task_id];
  return {
    task_id: taskIds[0] ?? '',
    task_ids: taskIds,
    status: result.status ?? 'Queued',
  };
}

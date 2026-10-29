/**
 * The local Runtime wire contract (`workspace.v1`): the written-down form of
 * the shapes the editor exchanges with the Astrid Runtime. The fake Runtime
 * (`tests/e2e/fake-runtime/server.ts`, routed by `src/test/fakeRuntimeRouter.ts`)
 * is held to these schemas.
 *
 * Only the exports with an importer live here. Schemas used only inside this
 * file stay module-private.
 *
 * Keeping these parsers is what makes the cross-repo assumptions checkable
 * (CLAUDE.md's "typed contracts at service boundaries" policy).
 *
 * Two rules the parsers below exist to enforce:
 *
 * 1. **Never coerce a malformed payload into a plausible one.** A registry that
 *    fails to parse must not become `{assets: {}}`; a save would then PUT that
 *    emptied registry back at the bridge — a read-side parse quirk turning into
 *    a data-destroying write. Every parse failure throws instead, and the throw
 *    surfaces as the editor's load-error card.
 * 2. **Validate, don't rewrite.** The parsers check shape and return the caller's
 *    own value, so valid payloads reach `normalizeConfig`/`normalizeRegistry`
 *    byte-identical (extension-authored keys on clips, tracks and registry
 *    entries must survive a load/save round trip).
 */
import { z } from 'zod';

import { timelineBundleEnvelopeSchema } from '@/tools/video-editor/data/typed/timelineBundle.ts';
import { ASTRID_BRIDGE_REQUEST_TIMEOUT_MS } from '@/tools/video-editor/data/astridBridgeWire.ts';

/**
 * Transport deadline for every bridge request. A hung (as opposed to dead)
 * bridge would otherwise park the save badge on `saving` forever and disable
 * the App/Local switcher via `isSwitchBlockedBySave`. With a deadline the hang
 * becomes an ordinary transport failure and feeds the existing save backoff.
 */
export const BRIDGE_REQUEST_TIMEOUT_MS = ASTRID_BRIDGE_REQUEST_TIMEOUT_MS;

/** Error code the bridge must return (with HTTP 409) when `expected_version` is stale. */
export const BRIDGE_VERSION_CONFLICT_CODE = 'timeline_version_conflict';
/** Explicit service refusal used when its bridge protocol version differs from this App. */
export const BRIDGE_CONTRACT_VERSION_MISMATCH_CODE = 'bridge_contract_version_mismatch';

/** Thrown when a bridge response does not match this contract. */
export class BridgeContractError extends Error {
  code = 'bridge_contract_violation' as const;

  constructor(what: string, detail: string) {
    super(`Astrid bridge returned a malformed ${what}: ${detail}`);
    this.name = 'BridgeContractError';
  }
}

/** Any JSON object. Unknown keys are part of the payload, never stripped. */
const jsonObject = z.looseObject({});

/** Runtime-owned sha256 identity for CAS objects and capability definitions. */
export const runtimeSha256IdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Runtime-owned thumbnail associated with a source object. */
const runtimeThumbnailDescriptorSchema = z.looseObject({
  object_id: runtimeSha256IdSchema,
  source_object_id: runtimeSha256IdSchema,
  recipe_version: z.number().int().positive(),
});

export const runtimeManagedObjectSchema = z.strictObject({
  object_id: runtimeSha256IdSchema,
  digest: runtimeSha256IdSchema,
  media_type: z.string().regex(
    /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$/,
  ),
  size: z.number().int().nonnegative(),
  version: z.number().int().min(1),
  created_at: z.string().datetime({ offset: true }),
  filename: z.string().min(1).max(512).optional(),
  relation: z.string().min(1).optional(),
});

export const runtimeCapabilitySchema = z.strictObject({
  capability_id: z.string().min(1),
  definition_digest: runtimeSha256IdSchema,
  status: z.enum(['ready', 'unavailable', 'unsupported', 'retired']),
  required_resource_keys: z.array(z.string().min(1)).refine(
    (keys) => new Set(keys).size === keys.length,
    { message: 'required_resource_keys must contain unique values' },
  ),
  estimated_scratch_bytes: z.number().int().nonnegative(),
  estimated_output_bytes: z.number().int().nonnegative(),
  unavailable_reason: z.string().nullable().optional(),
});

export function runtimePageSchema<Schema extends z.ZodType>(item: Schema) {
  return z.strictObject({
    items: z.array(item),
    next_cursor: z.string().min(1).nullable(),
  });
}

export const runtimeMutationReceiptSchema = z.strictObject({
  receipt_id: z.string().min(1),
  command_kind: z.string().min(1),
  idempotency_key: z.string().min(1),
  request_hash: z.string().min(1),
  project_id: z.string().min(1),
  project_seq: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
  event_ids: z.array(z.string().min(1)),
  result: z.unknown().refine((value) => value !== undefined, { message: 'result is required' }),
  created_at: z.string().min(1),
});

export function runtimeMutationSchema<Schema extends z.ZodType>(data: Schema) {
  return z.strictObject({
    data,
    receipt: runtimeMutationReceiptSchema,
  });
}

const bridgeTimelineConfigSchema = z.looseObject({
  output: jsonObject.optional(),
  clips: z.array(jsonObject).optional(),
  tracks: z.array(jsonObject).optional(),
});

const bridgeAssetRegistryEntrySchema = z.looseObject({
  file: z.string().optional(),
  media_id: z.string().min(1).optional(),
  src: z.string().optional(),
  type: z.string().optional(),
  duration: z.number().optional(),
  generationId: z.string().optional(),
});

const bridgeAssetRegistrySchema = z.looseObject({
  assets: z.record(z.string(), bridgeAssetRegistryEntrySchema),
});

/**
 * `GET /projects/:slug/timelines/:ref` and the `POST …/save` response.
 *
 * dataKind V2: an optional `bundle` — the schema-versioned TimelineBundle of
 * SOURCE data items (`data/typed/timelineBundle.ts`, the single parse
 * authority) — may ride the payload. Absent is legal. Present-but-invalid
 * fails the whole parse closed: a head that declares a bundle it cannot
 * explain must never load as if lanes were empty, because the next save would
 * persist that emptiness (the same read-side-quirk-becomes-data-loss rule as
 * the registry below).
 */
export const bridgeTimelinePayloadSchema = z.looseObject({
  timeline_id: z.string().optional(),
  timeline_ulid: z.string().optional(),
  slug: z.string().optional(),
  name: z.string().optional(),
  config: bridgeTimelineConfigSchema,
  config_version: z.number().optional(),
  registry: bridgeAssetRegistrySchema.optional(),
  bundle: timelineBundleEnvelopeSchema.optional(),
});

export const bridgeTimelinesSchema = z.looseObject({
  timelines: z.array(z.looseObject({
    timeline_id: z.string(),
    timeline_ulid: z.string().optional(),
    slug: z.string().optional(),
    name: z.string(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    is_default: z.boolean().optional(),
    is_shot: z.boolean().optional(),
  })).optional(),
});

// ---------------------------------------------------------------------------
// doc-27 §4.1 route set: tasks, generations, media content. Frozen against
// the phase-b `astrid serve` implementation (`AstridTaskBridge` DTOs), which
// is the wire truth this contract mirrors.
// ---------------------------------------------------------------------------

/** Kernel task status vocabulary (`tasks.status`, lowercase kernel forms). */
const bridgeTaskStatusSchema = z.enum([
  'queued',
  'blocked',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

/** The admitted spec (`spec_json` parsed): family, provenance, output policy. */
const bridgeTaskSpecSchema = z.looseObject({
  schema_version: z.number().optional(),
  family: z.string().optional(),
  source_task_type: z.string().optional(),
  params: jsonObject.optional(),
  output_policy: jsonObject.optional(),
});

/** HC-04 typed producer spec. Unknown fields inside typed objects are owned by
 * the capability schema, but the admission envelope itself is closed. */
const bridgeTaskAdmissionSpecSchema = z.strictObject({
  family: z.string().min(1),
  params: jsonObject,
  output_policy: jsonObject,
});

const bridgeTaskStorageEstimateSchema = z.strictObject({
  scratch_bytes: z.number().int().nonnegative(),
  output_bytes: z.number().int().nonnegative(),
});

const projectUpdateSettlementEffectSchema = z.strictObject({
  effect_type: z.literal('project.update'),
  target_id: z.string().min(1),
  expected_version: z.number().int().positive(),
  payload: z.strictObject({
    name: z.string().min(1).optional(),
    metadata: z.unknown().optional(),
  }).optional(),
});

const generationVariantAppendSettlementEffectSchema = z.strictObject({
  effect_type: z.literal('generation.variant.append'),
  target_id: z.string().min(1),
  expected_version: z.number().int().positive(),
  payload: z.strictObject({
    source_variant_id: z.string().min(1),
    source_object_id: runtimeSha256IdSchema,
    variant_type: z.string().min(1).max(128),
    output_name: z.string().min(1).max(512),
    output_ordinal: z.literal(0),
    primary_policy: z.literal('preserve'),
  }),
});

const generationCreateWithVariantSettlementEffectSchema = z.strictObject({
  effect_type: z.literal('generation.create_with_variant'),
  target_id: z.string().min(1),
  payload: z.strictObject({
    generation_type: z.string().min(1).max(128),
    metadata: jsonObject,
    variant_type: z.string().min(1).max(128),
    output_name: z.string().min(1).max(512),
    output_ordinal: z.literal(0),
    primary_policy: z.literal('preserve'),
  }),
});

const generationPublishV1SettlementEffectSchema = z.strictObject({
  effect_type: z.literal('generation.publish_v1'),
  target_id: z.string().min(1),
  payload: z.strictObject({
    version: z.literal(1),
    modality: z.enum(['image', 'video', 'audio']),
    generation_type: z.string().min(1).max(128),
    metadata: jsonObject,
    partial_success_policy: z.enum(['reject', 'allow']),
    groups: z.array(z.strictObject({
      group_key: z.string().min(1).max(255),
      selectors: z.array(z.strictObject({
        selector: z.string().min(1).max(255),
        ordinal: z.number().int().nonnegative(),
        variant_key: z.string().min(1).max(255),
        output_port: z.string().min(1).max(255),
      })).min(1),
    })).min(1),
  }),
});

/** Runtime settlement effects accepted by the canonical admission envelope. */
export const bridgeTaskSettlementEffectSchema = z.union([
  z.strictObject({}),
  projectUpdateSettlementEffectSchema,
  generationVariantAppendSettlementEffectSchema,
  generationCreateWithVariantSettlementEffectSchema,
  generationPublishV1SettlementEffectSchema,
]);

/**
 * Bounded current-attempt read model — also the only extra a fence `409`
 * may carry (doc-27 §4.6: minimal resync data, never the full model).
 */
export const bridgeTaskAttemptSchema = z.looseObject({
  attempt_id: z.string(),
  attempt_no: z.number(),
  status: z.string(),
  status_version: z.number(),
  lease_id: z.string(),
  lease_expires_at: z.string(),
  heartbeat_counter: z.number(),
  last_heartbeat_at: z.string().nullable(),
});

/**
 * Detail-only executor diagnostics. `progress` is a sanitized, bounded
 * object whose keys are executor-family specific; `error` is the deliberately
 * small stable vocabulary exposed by the bridge. Keep this extension off
 * `bridgeTaskAttemptSchema`: fence responses must remain the minimal lease
 * projection and never carry executor payloads.
 */
const bridgeTaskAttemptDiagnosticsProgressSchema = z.record(z.string(), z.unknown());

const bridgeTaskAttemptDiagnosticsErrorSchema = z.strictObject({
  code: z.string().max(1_000).optional(),
  reason: z.string().max(1_000).optional(),
  type: z.string().max(1_000).optional(),
  message: z.string().max(4_000).optional(),
  retryable: z.boolean().optional(),
});

export const bridgeTaskAttemptDiagnosticsSchema = z.strictObject({
  progress: bridgeTaskAttemptDiagnosticsProgressSchema,
  error: bridgeTaskAttemptDiagnosticsErrorSchema,
});

/** Current-attempt detail projection; diagnostics are never part of a fence. */
const bridgeTaskDetailAttemptSchema = bridgeTaskAttemptSchema.extend({
  diagnostics: bridgeTaskAttemptDiagnosticsSchema,
});

/**
 * Polling task summary (`AstridTaskBridge._task_summary`): the shape returned
 * by `GET /projects/:slug/tasks[/:task_id]` and cancel's terminal replay.
 */
const bridgeTaskSummarySchema = z.looseObject({
  task_id: z.string(),
  project_id: z.string(),
  capability: z.string(),
  status: bridgeTaskStatusSchema,
  /** Runtime task version used when a cancel must be retried with a fence. */
  version: z.number().int().positive().optional(),
  spec: bridgeTaskSpecSchema.optional(),
  priority: z.number().optional(),
  max_attempts: z.number().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable().optional(),
  winning_attempt_id: z.string().nullable().optional(),
  /** Latest bounded phase progress reported by the Astrid executor. */
  progress: jsonObject.optional(),
  /** Why a queued task is not running (Runtime `waiting_reason`, e.g. an expired lease requeue). */
  waiting_reason: z.string().optional(),
  result: jsonObject.optional(),
});

/**
 * Admission response task: the kernel `TaskReadModel` — note it keys its
 * identity as `id`, unlike the polling summary's `task_id`.
 */
const bridgeAdmittedTaskSchema = z.looseObject({
  id: z.string(),
  project_id: z.string(),
  capability: z.string(),
  spec: bridgeTaskSpecSchema,
  spec_hash: z.string().optional(),
  input_manifest: z.array(jsonObject).optional(),
  status: bridgeTaskStatusSchema,
  priority: z.number().optional(),
  available_at: z.string().optional(),
  max_attempts: z.number().optional(),
  run_id: z.string().nullable().optional(),
  run_ordinal: z.number().nullable().optional(),
  winning_attempt_id: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable().optional(),
});

/** `POST /projects/:slug/tasks` request body (public HC-04 admission).
 * Idempotency is deliberately absent: it is transport metadata only. */
export const bridgeTaskAdmissionRequestSchema = z.strictObject({
  project: z.string().min(1),
  capability_id: z.string().min(1),
  capability_digest: runtimeSha256IdSchema,
  schema_version: z.literal('1'),
  input_object_ids: z.array(runtimeSha256IdSchema).refine(
    (ids) => new Set(ids).size === ids.length,
    { message: 'input_object_ids must contain unique values' },
  ),
  spec: bridgeTaskAdmissionSpecSchema,
  storage_estimate: bridgeTaskStorageEstimateSchema,
  /** Runtime-owned selector; the binding is resolved after admission. */
  execution_request: z.looseObject({
    schema_version: z.literal(1).optional(),
    target: z.looseObject({
      kind: z.enum(['default', 'profile', 'machine', 'runpod']),
    }),
    workflow: jsonObject.optional(),
    inputs: z.array(jsonObject).optional(),
    execution: jsonObject.optional(),
    retry_policy: jsonObject.optional(),
    lifecycle: jsonObject.optional(),
    limits: jsonObject.optional(),
    checks: jsonObject.optional(),
  }).optional(),
  /** Producer-validated GEN intent; Astrid App carries it without rebuilding it. */
  generation_intent: jsonObject.optional(),
  settlement_effect: bridgeTaskSettlementEffectSchema,
});

/** `201` first commit / `200` idempotent replay share this body. */
export const bridgeTaskAdmissionResponseSchema = z.looseObject({
  task: bridgeAdmittedTaskSchema,
});

// ---------------------------------------------------------------------------
// Neutral Runtime resources used by the local Astrid client.  These are kept
// beside the historical bridge DTOs while the remaining timeline-only routes
// finish their migration.  The adapter must validate these resources before it
// projects them onto the app's older task/gallery read models.
// ---------------------------------------------------------------------------

export const runtimeProjectResourceSchema = z.looseObject({
  project_id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  metadata: jsonObject,
  version: z.number().int().positive(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  archived: z.boolean(),
});

export const runtimeProjectPageSchema = runtimePageSchema(runtimeProjectResourceSchema);

const runtimeTaskStateSchema = z.enum([
  'queued',
  'blocked',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

export const runtimeTaskResourceSchema = z.looseObject({
  task_id: z.string().min(1),
  run_id: z.string().min(1),
  project_id: z.string().min(1).nullable(),
  state: runtimeTaskStateSchema,
  version: z.number().int().positive(),
  capability_id: z.string().min(1),
  capability_digest: runtimeSha256IdSchema,
  schema_version: z.string().min(1),
  input_object_ids: z.array(runtimeSha256IdSchema),
  spec: z.looseObject({}),
  idempotency_key: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  attempt_id: z.string().min(1).nullable(),
  runtime_epoch: z.number().int().positive(),
  /** Runtime resolves this selector into the canonical binding authority. */
  execution_request: z.looseObject({
    schema_version: z.literal(1).optional(),
    target: z.looseObject({ kind: z.enum(['default', 'profile', 'machine', 'runpod']) }),
  }).optional(),
  /** Issued by Runtime; consumers may verify/read it but never mint it. */
  execution_binding: z.looseObject({
    binding_id: z.string().min(1),
    task_id: z.string().min(1),
    run_id: z.string().min(1),
    session_id: z.string().min(1),
    runtime_epoch: z.number().int().positive(),
    capability_id: z.string().min(1),
    target_kind: z.string().min(1),
    resolved_target: z.looseObject({ kind: z.enum(['default', 'profile', 'machine', 'runpod']) }),
    actual_target: z.looseObject({ kind: z.enum(['default', 'profile', 'machine', 'runpod']) }).optional(),
    verification: z.looseObject({ verified: z.literal(true) }).optional(),
  }).optional(),
  /** Latest bounded phase progress reported by the Runtime attempt heartbeat. */
  progress: jsonObject.optional(),
  /** Runtime-reported reason a queued task is waiting (set when a lease expiry requeues it). */
  waiting_reason: z.string().optional(),
  generation_intent: jsonObject.optional(),
  result: jsonObject.optional(),
});

export const runtimeTaskPageSchema = runtimePageSchema(runtimeTaskResourceSchema);

const runtimeEventSchema = z.strictObject({
  event_id: z.string().min(1),
  sequence: z.number().int().positive(),
  cursor: z.string().min(1),
  event_type: z.string().min(1),
  aggregate_type: z.string().min(1),
  aggregate_id: z.string().min(1),
  payload: jsonObject,
  occurred_at: z.string().datetime({ offset: true }),
});

export const runtimeEventPageSchema = runtimePageSchema(runtimeEventSchema);

export const runtimeGenerationResourceSchema = z.looseObject({
  generation_id: z.string().min(1),
  project_id: z.string().min(1),
  source_task_id: z.string().min(1).nullable(),
  type: z.string().min(1),
  status: z.string().min(1),
  metadata: jsonObject,
  version: z.number().int().positive(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export const runtimeVariantResourceSchema = z.looseObject({
  variant_id: z.string().min(1),
  generation_id: z.string().min(1),
  object_id: runtimeSha256IdSchema.nullable(),
  variant_type: z.string().min(1),
  metadata: jsonObject,
  thumbnail: runtimeThumbnailDescriptorSchema.nullable().optional(),
  created_at: z.string().min(1),
});

export const runtimeGenerationPageSchema = runtimePageSchema(runtimeGenerationResourceSchema);
export const runtimeVariantPageSchema = runtimePageSchema(runtimeVariantResourceSchema);

/** `GET /projects/:slug/tasks?limit&offset`. */
export const bridgeTaskListSchema = z.looseObject({
  tasks: z.array(bridgeTaskSummarySchema),
  next_offset: z.number().nullable(),
});

/** One committed output row on the task detail read. */
const bridgeTaskOutputRowSchema = z.looseObject({
  ordinal: z.number(),
  role: z.string(),
  media_id: z.string(),
  is_primary: z.boolean().optional(),
  params_json: z.union([z.string(), jsonObject]).optional(),
});

/** `GET /projects/:slug/tasks/:task_id` → `{task: summary + attempts + outputs}`. */
export const bridgeTaskDetailPayloadSchema = z.looseObject({
  task: bridgeTaskSummarySchema.extend({
    attempts: z.array(bridgeTaskDetailAttemptSchema).optional(),
    outputs: z.array(bridgeTaskOutputRowSchema).optional(),
  }),
});

/**
 * `POST /projects/:slug/tasks/:task_id/cancel`. A fresh cancel returns the
 * kernel read model (`id`) plus the fenced attempt; cancelling an already
 * terminal task replays `{task: summary}` with no attempt. Either way the
 * consumer reads `status`.
 */
export const bridgeCancelRequestSchema = z.looseObject({
  attempt_id: z.string().min(1).optional(),
  lease_id: z.string().min(1).optional(),
  status_version: z.number().int().positive().optional(),
});

/** Gallery list row: primary-variant summary only (detail carries variants). */
const bridgeGenerationPrimarySchema = z.looseObject({
  media_id: z.string(),
  variant_type: z.string().nullable().optional(),
});

const bridgeGenerationSummarySchema = z.looseObject({
  generation_id: z.string(),
  name: z.string().nullable(),
  type: z.string(),
  /** Runtime generation params used by tool-scoped gallery filters. */
  params: jsonObject.optional(),
  starred: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  primary: bridgeGenerationPrimarySchema.nullable(),
  variant_count: z.number(),
});

/** `GET /projects/:slug/generations?limit&cursor&starred`. */
export const bridgeGenerationListSchema = z.looseObject({
  generations: z.array(bridgeGenerationSummarySchema),
  next_cursor: z.string().nullable().optional(),
});

const bridgeGenerationVariantSchema = z.looseObject({
  id: z.string(),
  generation_id: z.string(),
  media_id: z.string(),
  /** Runtime CAS identity when the bridge exposes lineage custody. */
  object_id: runtimeSha256IdSchema.optional(),
  thumbnail: runtimeThumbnailDescriptorSchema.nullable().optional(),
  variant_type: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  params: jsonObject.optional(),
  is_primary: z.boolean(),
  starred: z.boolean(),
  viewed_at: z.string().nullable().optional(),
  created_at: z.string(),
});

/** `GET /projects/:slug/generations/:generation_id` → `{generation: …}`. */
export const bridgeGenerationDetailPayloadSchema = z.looseObject({
  generation: z.looseObject({
    generation_id: z.string(),
    project_id: z.string(),
    task_id: z.string().nullable().optional(),
    type: z.string(),
    /** Runtime generation head used for lineage settlement CAS. */
    version: z.number().int().positive().optional(),
    name: z.string().nullable().optional(),
    based_on_generation_id: z.string().nullable().optional(),
    parent_generation_id: z.string().nullable().optional(),
    child_order: z.number().nullable().optional(),
    params: jsonObject.optional(),
    starred: z.boolean(),
    deleted_at: z.string().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    variants: z.array(bridgeGenerationVariantSchema),
    items: z.array(jsonObject).optional(),
  }),
});

/**
 * `GET|HEAD /projects/:slug/media/:media_id/content` is a byte route
 * (Range/ETag, frozen asset-serving semantics) — there is no JSON body to
 * parse, so the contract fixes only the address form.
 */
export function bridgeMediaContentUrl(baseUrl: string, projectSlug: string, mediaId: string): string {
  return `${trimTrailingSlash(baseUrl)}/projects/${encodeURIComponent(projectSlug)}/media/${encodeURIComponent(mediaId)}/content`;
}

const trimTrailingSlash =(value: string): string => value.replace(/\/+$/, '');
/**
 * The five public error categories every *new* build-facing bridge route
 * (doc-27 §4.1 set below) may answer with (doc-27 §4.6). The frozen timeline
 * codes above are preserved unchanged alongside them; internal lease/fence
 * reasons never cross the wire.
 */
export const BRIDGE_ERROR_CATEGORIES = [
  'invalid_body',
  'not_found',
  'conflict',
  'capability_unavailable',
  'payload_too_large',
] as const;

export type BridgeErrorCategory = (typeof BRIDGE_ERROR_CATEGORIES)[number];

/**
 * Error body shared by every failing route. Status-specific extras:
 * `config_version` only on `409 timeline_version_conflict` (the current head,
 * so the client can reload and retry), `limit_bytes` only on
 * `413 payload_too_large`, and `attempt` only on a fence `409 conflict`
 * carrying the bounded current-attempt read model.
 */
export const bridgeErrorEnvelopeSchema = z.looseObject({
  error: z.string().optional(),
  detail: z.string().optional(),
  next_action: z.string().optional(),
  config_version: z.number().optional(),
  limit_bytes: z.number().optional(),
  attempt: bridgeTaskAttemptSchema.optional(),
  issues: z.array(z.looseObject({
    pointer: z.string().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
  })).optional(),
});
export type BridgeTimelinePayload = z.infer<typeof bridgeTimelinePayloadSchema>;
export type RuntimeManagedObject = z.infer<typeof runtimeManagedObjectSchema>;
export type RuntimeCapability = z.infer<typeof runtimeCapabilitySchema>;
export type RuntimeMutationReceipt = z.infer<typeof runtimeMutationReceiptSchema>;
export type RuntimeTaskResource = z.infer<typeof runtimeTaskResourceSchema>;
export type RuntimeGenerationResource = z.infer<typeof runtimeGenerationResourceSchema>;
export type RuntimeVariantResource = z.infer<typeof runtimeVariantResourceSchema>;
export type BridgeTimelinesPayload = z.infer<typeof bridgeTimelinesSchema>;
/** `GET /health`: no runtime parser reads this payload, so the type is declared directly. */
export type BridgeHealthPayload = { ok: boolean; [key: string]: unknown };
/** `GET /projects`: the shape the discovery hook reads; no runtime parser reads this payload. */
export type BridgeProjectsPayload = {
  projects?: Array<{
    slug: string;
    name: string;
    project_id?: string;
    version?: number;
    created_at?: string;
    metadata?: { [key: string]: unknown };
    default_timeline_id?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type BridgeTaskSpec = z.infer<typeof bridgeTaskSpecSchema>;
export type BridgeTaskSummary = z.infer<typeof bridgeTaskSummarySchema>;
export type BridgeAdmittedTask = z.infer<typeof bridgeAdmittedTaskSchema>;
export type BridgeTaskAdmissionRequest = z.infer<typeof bridgeTaskAdmissionRequestSchema>;
export type BridgeTaskAdmissionResponse = z.infer<typeof bridgeTaskAdmissionResponseSchema>;
export type BridgeTaskList = z.infer<typeof bridgeTaskListSchema>;
export type BridgeTaskDetailPayload = z.infer<typeof bridgeTaskDetailPayloadSchema>;
export type BridgeCancelRequest = z.infer<typeof bridgeCancelRequestSchema>;
/** Cancel response: a fresh cancel returns the admitted task plus the fenced attempt; a replay returns the summary. */
export type BridgeCancelResponse = {
  task: BridgeAdmittedTask | BridgeTaskSummary;
  attempt?: z.infer<typeof bridgeTaskAttemptSchema> | null;
  [key: string]: unknown;
};
export type BridgeGenerationSummary = z.infer<typeof bridgeGenerationSummarySchema>;
export type BridgeGenerationList = z.infer<typeof bridgeGenerationListSchema>;
export type BridgeGenerationVariant = z.infer<typeof bridgeGenerationVariantSchema>;
export type BridgeGenerationDetailPayload = z.infer<typeof bridgeGenerationDetailPayloadSchema>;

const describeIssues = (issues: readonly z.core.$ZodIssue[]): string => {

  return issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
};

/**
 * Validate `value` against `schema` and hand the caller back its own value.
 *
 * The returned reference is the *input*, not zod's output, so no key is dropped
 * or defaulted on the way through — see rule 2 in the module doc comment.
 */
export function parseBridgePayload<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  what: string,
): z.infer<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BridgeContractError(what, describeIssues(result.error.issues));
  }
  return value as z.infer<Schema>;
}

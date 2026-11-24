// TimelineBundle persistence envelope: the schema-versioned
// serialization of SOURCE data items (never views/occurrences) that rides the
// existing timeline save path. When the kernel lands, this module is the
// one file to converge.
//
// Contract (L6-settled):
// - `schema_version` header; parsing fails CLOSED on unknown versions.
// - Items are `SourceFrozenDataItem`s: no `entityRef`, no timeline coords,
//   no renderer refs — the Zod item schema is strict so chrome cannot slip in.
// - The envelope itself is loose: unknown top-level fields are preserved for
//   forward compatibility (an old parser must reject via version, not strip).
//
// Identity and hashing policy:
// - Persisted source-item IDs are logical IDs supplied or deterministically
//   normalized at admission; they are not derived from content hashes.
// - Async bundle digests use WebCrypto SHA-256 over the canonical form.

import { z } from 'zod';
import type { DataCoordinateDomain, DataShape, SourceFrozenDataItem } from './envelope.ts';

/** Current bundle header version. Bump on any breaking item-vocabulary change. */
export const TIMELINE_BUNDLE_SCHEMA_VERSION = 1;

/** Wire shape of a persisted data-lane bundle. */
export interface TimelineBundleEnvelope {
  schema_version: typeof TIMELINE_BUNDLE_SCHEMA_VERSION;
  itemsBySchemaRef: Record<string, SourceFrozenDataItem[]>;
  transcriptReferences?: import('./projectTranscript.ts').TranscriptReferences;
}

// --- Vocabulary tuples -------------------------------------------------------
// Deliberately duplicated from ./envelope.ts (SDK import isolation, see
// envelopeVocabDrift.test.ts); the compile-time asserts below fail `tsc` if
// either side drifts.

const DATA_SHAPES = ['point', 'interval', 'series'] as const;
const DATA_DOMAINS = [
  'timeline_seconds',
  'source_seconds',
  'frames',
  'samples',
  'ticks',
  'ordinal',
  'char_offset',
  'token_offset',
] as const;

type AssertNever<T> = [T] extends [never] ? true : never;
const shapesExactWithEnvelope: AssertNever<
  Exclude<DataShape, (typeof DATA_SHAPES)[number]> | Exclude<(typeof DATA_SHAPES)[number], DataShape>
> = true;
const domainsExactWithEnvelope: AssertNever<
  | Exclude<DataCoordinateDomain, (typeof DATA_DOMAINS)[number]>
  | Exclude<(typeof DATA_DOMAINS)[number], DataCoordinateDomain>
> = true;
void shapesExactWithEnvelope;
void domainsExactWithEnvelope;

// --- Zod schemas -------------------------------------------------------------

const dataExtentSchema = z.object({
  start: z.number(),
  end: z.number().optional(),
});

const dataProvenanceSchema = z.object({
  adapterId: z.string().min(1),
  adapterVersion: z.string().min(1),
  recordedAt: z.string().min(1).optional(),
});

const sourceArtifactRefSchema = z.object({
  assetId: z.string().min(1),
  artifactHash: z.string().min(1).optional(),
});

/**
 * Strict on purpose: unrecognized keys (`entityRef`, `sourceItemId`, lane
 * chrome, renderer refs) are contract violations, not forward-compat — the
 * persisted `id` already IS the source id, and views are derived at assembly.
 */
export const sourceFrozenDataItemSchema = z.strictObject({
  id: z.string().min(1),
  shape: z.enum(DATA_SHAPES),
  domain: z.enum(DATA_DOMAINS),
  extent: dataExtentSchema,
  schemaRef: z.string().min(1),
  payload: z.unknown(),
  sourceArtifactRef: sourceArtifactRefSchema,
  provenance: dataProvenanceSchema,
});

// Loose on purpose: unknown top-level fields survive parse untouched so a
// newer writer's extras round-trip through an older reader of the SAME
// schema_version. Cross-version readers fail closed at the header instead.
export const timelineBundleEnvelopeSchema = z.looseObject({
  schema_version: z.literal(TIMELINE_BUNDLE_SCHEMA_VERSION),
  transcriptReferences: z.strictObject({
    schema: z.literal('media.transcript.references/v1'),
    associations: z.array(z.strictObject({
      assetId: z.string().min(1),
      documentId: z.string().min(1),
      // Optional, additive: written by the Agent's `transcripts refresh` so a
      // row can be re-resolved by media/source. Preserved, never required.
      mediaId: z.string().min(1).optional(),
      sourceId: z.string().min(1).optional(),
    })),
  }).optional(),
  itemsBySchemaRef: z.record(z.string().min(1), z.array(sourceFrozenDataItemSchema)),
});

// Compile-time guard: whatever the Zod item model infers must always satisfy
// the envelope-plane type consumers code against.
const itemTypeAligns: readonly SourceFrozenDataItem[] = [] as z.infer<typeof sourceFrozenDataItemSchema>[];
void itemTypeAligns;

// --- Parse -------------------------------------------------------------------

/** Thrown when a bundle does not parse; carries the offending header version. */
export class TimelineBundleParseError extends Error {
  /** The `schema_version` found in the value, when that was the failure. */
  readonly foundSchemaVersion?: unknown;

  constructor(message: string, options?: { foundSchemaVersion?: unknown }) {
    super(message);
    this.name = 'TimelineBundleParseError';
    this.foundSchemaVersion = options?.foundSchemaVersion;
  }
}

const describeIssues = (issues: readonly z.core.$ZodIssue[]): string =>
  issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') + ': ' : ''}${issue.message}`)
    .join('; ');

/**
 * Validate an untrusted value as a TimelineBundle, failing closed. Unknown
 * `schema_version`s throw with a diagnostic naming the found version;
 * structural violations throw with Zod issue paths. Unknown TOP-LEVEL fields
 * pass through (forward compat); unknown ITEM fields do not.
 */
export function parseTimelineBundle(value: unknown): TimelineBundleEnvelope {
  if (typeof value === 'object' && value !== null && 'schema_version' in value) {
    const found = (value as { schema_version?: unknown }).schema_version;
    if (found !== TIMELINE_BUNDLE_SCHEMA_VERSION) {
      throw new TimelineBundleParseError(
        `Unsupported TimelineBundle schema_version ${JSON.stringify(found)}; supported: ${TIMELINE_BUNDLE_SCHEMA_VERSION}. Refusing to parse (fail-closed).`,
        { foundSchemaVersion: found },
      );
    }
  }
  const parsed = timelineBundleEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new TimelineBundleParseError(`Invalid TimelineBundle: ${describeIssues(parsed.error.issues)}`);
  }
  return parsed.data as TimelineBundleEnvelope;
}

// --- Canonical stringify -----------------------------------------------------

/**
 * Deterministic JSON serialization: object keys recursively sorted ascending
 * by UTF-16 code unit, array order preserved, JSON.stringify semantics for
 * primitives (`undefined`/symbol/function properties dropped, non-finite
 * numbers dropped in objects / `null` in arrays, `-0` → `"0"`). Bigints throw.
 * This is the byte-stable input for every hash below.
 */
export function canonicalJsonStringify(value: unknown): string {
  const seen = new Set<unknown>();
  const canonicalize = (v: unknown): string | undefined => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'string':
        return JSON.stringify(v);
      case 'number':
        return Number.isFinite(v) ? String(v) : undefined;
      case 'boolean':
        return v ? 'true' : 'false';
      case 'bigint':
        throw new TypeError('canonicalJsonStringify: bigint is not JSON-serializable');
    }
    if (typeof v !== 'object') return undefined; // undefined, symbol, function
    if (seen.has(v)) throw new TypeError('canonicalJsonStringify: circular reference');
    seen.add(v);
    try {
      if (Array.isArray(v)) return `[${v.map((entry) => canonicalize(entry) ?? 'null').join(',')}]`;
      const entries = Object.entries(v)
        .map(([key, entry]) => ({ key, json: canonicalize(entry) }))
        .filter(({ json }) => json !== undefined);
      entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return `{${entries.map(({ key, json }) => `${JSON.stringify(key)}:${json}`).join(',')}}`;
    } finally {
      seen.delete(v);
    }
  };
  return canonicalize(value) ?? 'null';
}

// --- FNV-1a/64 utility (not used for source-item identity) ------------------

const FNV_1A_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_1A_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/**
 * FNV-1a over UTF-8 bytes, 64-bit (BigInt), lowercase hex padded to 16 chars.
 * Generic synchronous utility; source-item identity does not use this hash.
 * Test-pinned vectors include the public `"foobar"` → `85944171f73967e8`.
 */
export function fnv1a64Hex(input: string): string {
  let hash = FNV_1A_OFFSET_BASIS;
  const bytes = new TextEncoder().encode(input);
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * FNV_1A_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

// --- Bundle digest (async, WebCrypto SHA-256) --------------------------------

/** SHA-256 of a UTF-8 string as lowercase hex. Browser + Node ≥18 compatible. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Content digest of a bundle: SHA-256 over the canonical form of
 * `{schema_version, itemsBySchemaRef}`. Stable across key order everywhere
 * (payload objects included); ignores forward-compat extra top-level fields
 * so they never invalidate assembly caches.
 */
export async function computeTimelineBundleDigest(envelope: TimelineBundleEnvelope): Promise<string> {
  return sha256Hex(
    canonicalJsonStringify({
      schema_version: envelope.schema_version,
      itemsBySchemaRef: envelope.itemsBySchemaRef,
      ...(envelope.transcriptReferences ? {transcriptReferences:envelope.transcriptReferences}:{}),
    }),
  );
}

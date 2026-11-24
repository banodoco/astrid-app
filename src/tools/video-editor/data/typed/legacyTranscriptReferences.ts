// Read-time repair for ONE legacy shape written by Release 14's Agent
// (`transcripts refresh`): `transcriptReferences.associations` rows of exactly
// {documentId, mediaId, sourceId} (no assetId) inside a bundle that may lack
// `schema_version` / `itemsBySchemaRef`. Nothing else is repaired: any other
// shape is returned untouched so the strict parser still rejects it.

import { TIMELINE_BUNDLE_SCHEMA_VERSION } from './timelineBundle.ts';

type UnknownRecord = Record<string, unknown>;

const asObject = (value: unknown): UnknownRecord | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : undefined;

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const LEGACY_KEYS = ['documentId', 'mediaId', 'sourceId'] as const;

/** Exactly the Agent's `with_reference` row: all three keys, non-empty strings. */
const isLegacyRow = (row: UnknownRecord): boolean => {
  const keys = Object.keys(row);
  return keys.length === LEGACY_KEYS.length
    && LEGACY_KEYS.every((key) => Object.hasOwn(row, key) && nonEmpty(row[key]));
};

/** Asset ids whose identity `media_id ?? content_sha256` (own properties) equals `mediaId`. */
function resolveAssetId(assets: UnknownRecord, mediaId: string): string | undefined {
  const matches = Object.keys(assets).filter((key) => {
    const asset = asObject(assets[key]);
    if (!asset) return false;
    const identity = (Object.hasOwn(asset, 'media_id') ? asset.media_id : undefined)
      ?? (Object.hasOwn(asset, 'content_sha256') ? asset.content_sha256 : undefined);
    return identity === mediaId;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Returns a repaired copy of `bundle` when it is exactly the legacy shape and
 * every legacy row resolves to a registry asset; otherwise returns `bundle`
 * unchanged (so strict parsing reports the original problem).
 */
export function repairLegacyTranscriptReferences(bundle: unknown, registry: unknown): unknown {
  const envelope = asObject(bundle);
  const refs = asObject(envelope?.transcriptReferences);
  if (!envelope || !refs || !Array.isArray(refs.associations)) return bundle;
  if ('schema_version' in envelope && envelope.schema_version !== TIMELINE_BUNDLE_SCHEMA_VERSION) return bundle;
  if ('itemsBySchemaRef' in envelope && asObject(envelope.itemsBySchemaRef) === undefined) return bundle;

  const rows = refs.associations.map(asObject);
  if (rows.some((row) => row === undefined)) return bundle;
  if (!(rows as UnknownRecord[]).some(isLegacyRow)) return bundle;

  const assets = asObject(Object.hasOwn(asObject(registry) ?? {}, 'assets') ? asObject(registry)?.assets : undefined) ?? {};
  const repaired: UnknownRecord[] = [];
  const used = new Set<string>(
    (rows as UnknownRecord[]).filter((row) => !isLegacyRow(row)).map((row) => String(row.assetId)),
  );
  for (const row of rows as UnknownRecord[]) {
    if (!isLegacyRow(row)) {
      repaired.push(row);
      continue;
    }
    const assetId = resolveAssetId(assets, row.mediaId as string);
    if (assetId === undefined || used.has(assetId)) return bundle;
    used.add(assetId);
    repaired.push({ assetId, ...row });
  }
  return {
    ...envelope,
    schema_version: TIMELINE_BUNDLE_SCHEMA_VERSION,
    itemsBySchemaRef: envelope.itemsBySchemaRef ?? {},
    transcriptReferences: { ...refs, associations: repaired },
  };
}

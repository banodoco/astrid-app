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

const LEGACY_KEYS = new Set(['documentId', 'mediaId', 'sourceId']);

const isLegacyRow = (row: UnknownRecord): boolean =>
  nonEmpty(row.documentId)
  && !('assetId' in row)
  && (nonEmpty(row.mediaId) || nonEmpty(row.sourceId))
  && Object.keys(row).every((key) => LEGACY_KEYS.has(key))
  && (row.mediaId === undefined || nonEmpty(row.mediaId))
  && (row.sourceId === undefined || nonEmpty(row.sourceId));

/** Registry asset ids whose key, media_id or content_sha256 equals `id`. */
function resolveAssetId(assets: UnknownRecord, id: string): string | undefined {
  if (id in assets) return id;
  const matches = Object.entries(assets)
    .filter(([, asset]) => {
      const record = asObject(asset);
      return record?.media_id === id || record?.content_sha256 === id;
    })
    .map(([key]) => key);
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

  const assets = asObject(asObject(registry)?.assets) ?? {};
  const repaired: UnknownRecord[] = [];
  for (const row of rows as UnknownRecord[]) {
    if (!isLegacyRow(row)) {
      repaired.push(row);
      continue;
    }
    const assetId = [row.mediaId, row.sourceId]
      .filter(nonEmpty)
      .map((id) => resolveAssetId(assets, id))
      .find((id) => id !== undefined);
    if (assetId === undefined) return bundle;
    repaired.push({ assetId, ...row });
  }
  return {
    ...envelope,
    schema_version: TIMELINE_BUNDLE_SCHEMA_VERSION,
    itemsBySchemaRef: envelope.itemsBySchemaRef ?? {},
    transcriptReferences: { ...refs, associations: repaired },
  };
}

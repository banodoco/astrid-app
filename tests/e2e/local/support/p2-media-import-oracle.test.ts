import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  assertMediaImportSelectionIdentity,
  assertNormalizedCatalogueEntry,
  assertRawMediaImportEntry,
  mediaImportEvidence,
  mediaImportEvidenceFromProducer,
} from './p2-media-import-oracle.ts';

const file = {
  name: 'p2-mounted-image.png',
  type: 'image/png',
  bytesBase64: Buffer.from('genuine image fixture bytes').toString('base64'),
};
const source = {
  objectId: `sha256:${'a'.repeat(64)}`,
  digest: `sha256:${createHash('sha256').update(Buffer.from(file.bytesBase64, 'base64')).digest('hex')}`,
  mediaType: 'image/png',
  generationId: 'generation-actual',
  variantId: 'variant-actual',
};
const imported = {
  asset_id: source.variantId,
  generation_id: source.generationId,
  variant_id: source.variantId,
};

test('raw import oracle accepts the actual ABI and refuses the old normalized claim', () => {
  const evidence = mediaImportEvidence(file, source);
  const actualRawEntry = {
    object_id: source.objectId,
    media_type: file.type,
    size: evidence.bytes.byteLength,
    filename: file.name,
  };
  assertRawMediaImportEntry(actualRawEntry, evidence.rawEntry);
  assert.throws(
    () => assertRawMediaImportEntry({ ...actualRawEntry, content_sha256: evidence.source.digest }, evidence.rawEntry),
  );
  assert.throws(() => assertRawMediaImportEntry({ ...actualRawEntry, object_id: 'sha256:wrong-object' }, evidence.rawEntry));
  assert.throws(() => assertRawMediaImportEntry({ ...actualRawEntry, media_type: 'image/jpeg' }, evidence.rawEntry));
  assert.throws(() => assertRawMediaImportEntry({ ...actualRawEntry, size: actualRawEntry.size + 1 }, evidence.rawEntry));
  assert.throws(() => assertRawMediaImportEntry({ ...actualRawEntry, filename: 'wrong.png' }, evidence.rawEntry));
  assert.throws(() => assertRawMediaImportEntry({ ...actualRawEntry, extra: true }, evidence.rawEntry));
  const { filename: _filename, ...missingFilename } = actualRawEntry;
  assert.throws(() => assertRawMediaImportEntry(missingFilename, evidence.rawEntry));
});

test('normalized catalogue oracle preserves original identity and refuses wrong fields', () => {
  const evidence = mediaImportEvidence(file, source);
  const normalized = {
    media_id: evidence.source.objectId,
    type: 'image',
    generationId: evidence.source.generationId,
    variantId: evidence.source.variantId,
  };
  assertNormalizedCatalogueEntry(normalized, evidence.source);
  assert.throws(() => assertNormalizedCatalogueEntry(evidence.rawEntry, evidence.source));
  assert.throws(() => assertNormalizedCatalogueEntry({ ...normalized, media_id: 'sha256:wrong-object' }, evidence.source));
  assert.throws(() => assertNormalizedCatalogueEntry({ ...normalized, type: 'image/png' }, evidence.source));
  assert.throws(() => assertNormalizedCatalogueEntry({ ...normalized, generationId: 'generation-wrong' }, evidence.source));
  assert.throws(() => assertNormalizedCatalogueEntry({ ...normalized, variantId: 'variant-wrong' }, evidence.source));
  assert.throws(() => assertNormalizedCatalogueEntry({ ...normalized, generationId: normalized.variantId, variantId: normalized.generationId }, evidence.source));
  assert.throws(() => assertNormalizedCatalogueEntry({ ...normalized, content_sha256: evidence.source.digest }, evidence.source));
  const { generationId: _generationId, ...missingGeneration } = normalized;
  assert.throws(() => assertNormalizedCatalogueEntry(missingGeneration, evidence.source));
});

test('media identity oracle derives the pair from import and refuses selection drift', () => {
  const evidence = mediaImportEvidenceFromProducer(file, source, imported);
  const selected = {
    asset: imported.asset_id,
    catalog_digest: 'sha256:catalog-actual',
    generation_id: imported.generation_id,
    object_id: source.objectId,
    variant_id: imported.variant_id,
  };
  assertMediaImportSelectionIdentity(selected, imported, evidence.source);
  assert.throws(() => assertMediaImportSelectionIdentity(
    { ...selected, generation_id: selected.variant_id, variant_id: selected.generation_id },
    imported,
    evidence.source,
  ));
  const { variant_id: _variantId, ...missingVariant } = selected;
  assert.throws(() => assertMediaImportSelectionIdentity(missingVariant, imported, evidence.source));
  assert.throws(() => assertMediaImportSelectionIdentity({ ...selected, extra_id: 'unexpected' }, imported, evidence.source));
  assert.throws(() => assertMediaImportSelectionIdentity({ ...selected, object_id: 'sha256:wrong-object' }, imported, evidence.source));
});

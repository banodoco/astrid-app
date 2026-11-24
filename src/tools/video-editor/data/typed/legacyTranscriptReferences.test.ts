// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { repairLegacyTranscriptReferences } from './legacyTranscriptReferences.ts';
import { TimelineBundleParseError, parseTimelineBundle } from './timelineBundle.ts';

const MEDIA = `sha256:${'a'.repeat(64)}`;
const registry = {
  assets: {
    'asset-1': { media_id: MEDIA, file: 'a.mp4' },
    'asset-2': { content_sha256: `sha256:${'b'.repeat(64)}`, file: 'b.mp4' },
  },
};
const bundle = (associations: unknown[], extra: Record<string, unknown> = {}) => ({
  transcriptReferences: { schema: 'media.transcript.references/v1', associations },
  ...extra,
});
const load = (b: unknown, reg: unknown = registry) => parseTimelineBundle(repairLegacyTranscriptReferences(b, reg));

describe('repairLegacyTranscriptReferences (Release 14 shape)', () => {
  it('resolves assetId by mediaId and fills the missing envelope', () => {
    const parsed = load(bundle([{ documentId: 'd1', mediaId: MEDIA, sourceId: 'whisper' }]));
    expect(parsed.schema_version).toBe(1);
    expect(parsed.itemsBySchemaRef).toEqual({});
    expect(parsed.transcriptReferences!.associations).toEqual([
      { assetId: 'asset-1', documentId: 'd1', mediaId: MEDIA, sourceId: 'whisper' },
    ]);
  });
  it('resolves by content_sha256 and keeps already-valid rows and existing items', () => {
    const items = { 'astrid.transcript_segment/v1': [] };
    const parsed = load(bundle([
      { documentId: 'd2', mediaId: `sha256:${'b'.repeat(64)}`, sourceId: 's' },
      { assetId: 'asset-1', documentId: 'd1' },
    ], { schema_version: 1, itemsBySchemaRef: items }));
    expect(parsed.transcriptReferences!.associations.map((r) => r.assetId)).toEqual(['asset-2', 'asset-1']);
    expect(parsed.itemsBySchemaRef).toEqual(items);
  });
  it('still throws the strict error when nothing resolves', () => {
    expect(() => load(bundle([{ documentId: 'd', mediaId: 'sha256:nope', sourceId: 's' }]))).toThrow(TimelineBundleParseError);
    expect(() => load(bundle([{ documentId: 'd', mediaId: MEDIA, sourceId: 's' }]), { assets: {} })).toThrow(/assetId/);
  });
  it('is ambiguity-safe', () => {
    const dup = { assets: { x: { media_id: MEDIA }, y: { media_id: MEDIA } } };
    expect(() => load(bundle([{ documentId: 'd', mediaId: MEDIA }]), dup)).toThrow(TimelineBundleParseError);
  });
  it('accepts nothing else', () => {
    expect(() => load(bundle([{ documentId: 'd', mediaId: MEDIA, extra: 1 }]))).toThrow(TimelineBundleParseError);
    expect(() => load(bundle([{ documentId: 'd' }]))).toThrow(TimelineBundleParseError);
    expect(() => load(bundle([{ documentId: 'd', mediaId: MEDIA }], { schema_version: 2 }))).toThrow(/schema_version/);
    expect(() => load({ transcriptReferences: { schema: 'x', associations: [] } })).toThrow(TimelineBundleParseError);
    expect(() => load({ itemsBySchemaRef: {} })).toThrow(TimelineBundleParseError);
  });
  it('does not touch a bundle with no legacy rows', () => {
    const ok = bundle([{ assetId: 'a', documentId: 'd' }], { schema_version: 1, itemsBySchemaRef: {} });
    expect(repairLegacyTranscriptReferences(ok, registry)).toBe(ok);
  });
});

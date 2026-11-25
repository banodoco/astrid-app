// @vitest-environment node
// dataKind V2 Batch 1: TimelineBundle envelope — schema_version fail-closed
// parse, strict source-item shape, canonical stringify, FNV-1a/64 sync id
// hash, WebCrypto SHA-256 bundle digest.
import { describe, expect, it } from 'vitest';
import {
  TIMELINE_BUNDLE_SCHEMA_VERSION,
  TimelineBundleParseError,
  canonicalJsonStringify,
  computeTimelineBundleDigest,
  fnv1a64Hex,
  parseTimelineBundle,
  sha256Hex,
} from './timelineBundle.ts';

const makeItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'assetA:src:0',
  shape: 'interval',
  domain: 'source_seconds',
  extent: { start: 0, end: 1.5 },
  schemaRef: 'astrid.transcript_segment/v1',
  payload: { text: 'hello' },
  sourceArtifactRef: { assetId: 'assetA' },
  provenance: { adapterId: 'astrid.adaptTranscript', adapterVersion: '1' },
  ...overrides,
});

const makeEnvelope = (overrides: Record<string, unknown> = {}) => ({
  schema_version: TIMELINE_BUNDLE_SCHEMA_VERSION,
  itemsBySchemaRef: {
    'astrid.transcript_segment/v1': [makeItem()],
  },
  ...overrides,
});

/** Envelope whose transcript items are exactly `items` (the common case). */
const envelopeWithItems = (items: Record<string, unknown>[]) =>
  makeEnvelope({ itemsBySchemaRef: { 'astrid.transcript_segment/v1': items } });

describe('parseTimelineBundle', () => {
  it('accepts a valid envelope and preserves unknown top-level fields (forward compat)', () => {
    const parsed = parseTimelineBundle(makeEnvelope({ futureField: { nested: true } }));
    expect(parsed.schema_version).toBe(1);
    expect(parsed.itemsBySchemaRef['astrid.transcript_segment/v1']).toHaveLength(1);
    expect((parsed as Record<string, unknown>).futureField).toEqual({ nested: true });
  });

  it('fails closed on unknown schema_version, naming the found version', () => {
    const attempt = () => parseTimelineBundle(makeEnvelope({ schema_version: 2 }));
    expect(attempt).toThrow(TimelineBundleParseError);
    try {
      attempt();
    } catch (error) {
      const err = error as TimelineBundleParseError;
      expect(err.foundSchemaVersion).toBe(2);
      expect(err.message).toContain('schema_version');
      expect(err.message).toContain('2');
      expect(err.message).toContain('fail-closed');
    }
  });

  it('fails closed on a non-numeric or wrong-typed header value', () => {
    for (const bad of ['1', 'banana', null]) {
      expect(() => parseTimelineBundle(makeEnvelope({ schema_version: bad }))).toThrow(
        TimelineBundleParseError,
      );
    }
  });

  it('fails closed when schema_version is absent or the value is not an object', () => {
    const missing = makeEnvelope();
    delete (missing as Record<string, unknown>).schema_version;
    expect(() => parseTimelineBundle(missing)).toThrow(TimelineBundleParseError);
    expect(() => parseTimelineBundle('not-a-bundle')).toThrow(TimelineBundleParseError);
    expect(() => parseTimelineBundle(null)).toThrow(TimelineBundleParseError);
  });

  it('rejects items carrying occurrence/view chrome via strictObject', () => {
    const rejectsWithChrome = (chrome: Record<string, unknown>) =>
      parseTimelineBundle(envelopeWithItems([makeItem(chrome)]));

    // entityRef is assembly-derived, never persisted.
    expect(() => rejectsWithChrome({ entityRef: { kind: 'clip', id: 'clip1' } })).toThrow(/Unrecognized key/);
    // The persisted id IS the source id; a stray sourceItemId is ambiguous.
    expect(() => rejectsWithChrome({ sourceItemId: 'assetA:src:0' })).toThrow(/Unrecognized key/);
    // Renderer refs and lane chrome are view-plane only.
    expect(() => rejectsWithChrome({ render: () => undefined })).toThrow(/Unrecognized key/);
    expect(() => rejectsWithChrome({ laneId: 'lane:transcript' })).toThrow(/Unrecognized key/);
  });

  it('requires sourceArtifactRef.assetId on every item (provenance)', () => {
    const { sourceArtifactRef, ...withoutProvenance } = makeItem();
    void sourceArtifactRef;
    expect(() => parseTimelineBundle(envelopeWithItems([withoutProvenance]))).toThrow(
      TimelineBundleParseError,
    );
    expect(() => parseTimelineBundle(envelopeWithItems([makeItem({ sourceArtifactRef: {} })]))).toThrow(
      TimelineBundleParseError,
    );
    expect(() =>
      parseTimelineBundle(envelopeWithItems([makeItem({ sourceArtifactRef: { assetId: '' } })])),
    ).toThrow(TimelineBundleParseError);
  });

  it('rejects unknown domains and shapes (fail-closed vocabulary)', () => {
    expect(() =>
      parseTimelineBundle(envelopeWithItems([makeItem({ domain: 'warp_seconds' })])),
    ).toThrow(TimelineBundleParseError);
    expect(() =>
      parseTimelineBundle(envelopeWithItems([makeItem({ shape: 'hypercube' })])),
    ).toThrow(TimelineBundleParseError);
  });

  it('round-trips opaque payloads byte-faithfully through JSON serialization', () => {
    const payload = {
      text: 'héllo — "quoted" \n newline',
      counts: [3, 1, 2],
      nested: { z: 1, a: { deep: [true, false, null], zz: undefined } },
      ratio: -0,
    };
    const envelope = envelopeWithItems([makeItem({ payload })]);
    const serialized = JSON.parse(JSON.stringify(envelope)) as unknown; // provider transport
    const parsed = parseTimelineBundle(serialized);
    expect(canonicalJsonStringify(parsed.itemsBySchemaRef['astrid.transcript_segment/v1'][0].payload)).toBe(
      canonicalJsonStringify(payload),
    );
    // And determinism holds across key insertion order of an equal payload.
    const reordered = { ratio: -0, nested: { a: { zz: undefined, deep: [true, false, null] }, z: 1 }, counts: [3, 1, 2], text: payload.text };
    expect(canonicalJsonStringify(reordered)).toBe(canonicalJsonStringify(payload));
  });
});

describe('canonicalJsonStringify', () => {
  it('sorts object keys recursively by code unit; arrays keep order', () => {
    expect(
      canonicalJsonStringify({ b: 1, A: { d: 2, C: 3 }, _: ['é', 'B'], list: [3, 1, 2] }),
    ).toBe('{"A":{"C":3,"d":2},"_":["é","B"],"b":1,"list":[3,1,2]}');
  });

  it('mirrors JSON.stringify primitive semantics', () => {
    expect(canonicalJsonStringify({ dropMe: undefined, noFn: () => 1, keep: 0 })).toBe('{"keep":0}');
    expect(canonicalJsonStringify([undefined, NaN, Infinity])).toBe('[null,null,null]');
    expect(canonicalJsonStringify(-0)).toBe('0');
    expect(canonicalJsonStringify('quote"and\\slash')).toBe('"quote\\"and\\\\slash"');
    expect(() => canonicalJsonStringify({ big: 1n })).toThrow(TypeError);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => canonicalJsonStringify(circular)).toThrow(/circular/);
  });
});

describe('fnv1a64Hex (sync source-id hash)', () => {
  it('matches pinned FNV-1a/64 vectors (offset basis cbf29ce484222325)', () => {
    expect(fnv1a64Hex('')).toBe('cbf29ce484222325'); // offset basis
    expect(fnv1a64Hex('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64Hex('foobar')).toBe('85944171f73967e8'); // public test vector
  });

  it('hashes the canonical form end-to-end (sorted keys → FNV)', () => {
    const canonical = canonicalJsonStringify({ text: 'hello', start: 0, end: 1.5 });
    expect(canonical).toBe('{"end":1.5,"start":0,"text":"hello"}');
    expect(fnv1a64Hex(canonical)).toBe('92da07d1cf056bad');
  });

  it('is stable across key order and sensitive to content', () => {
    const a = fnv1a64Hex(canonicalJsonStringify({ start: 0, end: 5, text: 'x' }));
    const b = fnv1a64Hex(canonicalJsonStringify({ text: 'x', end: 5, start: 0 }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(fnv1a64Hex(canonicalJsonStringify({ text: 'y', end: 5, start: 0 }))).not.toBe(a);
  });
});

describe('computeTimelineBundleDigest', () => {
  it('uses WebCrypto SHA-256 hex (pinned empty vector)', async () => {
    await expect(sha256Hex('')).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is stable across key order everywhere in the envelope', async () => {
    const first = makeEnvelope();
    const second = {
      itemsBySchemaRef: {
        'astrid.transcript_segment/v1': [
          makeItem({
            payload: { text: 'hello' },
            provenance: { adapterVersion: '1', adapterId: 'astrid.adaptTranscript' },
            extent: { end: 1.5, start: 0 },
          }),
        ],
      },
      schema_version: TIMELINE_BUNDLE_SCHEMA_VERSION,
    };
    expect(await computeTimelineBundleDigest(first)).toBe(await computeTimelineBundleDigest(second));
    expect(await computeTimelineBundleDigest(first)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when item content changes', async () => {
    const editedText = envelopeWithItems([makeItem({ payload: { text: 'changed' } })]);
    expect(await computeTimelineBundleDigest(makeEnvelope())).not.toBe(
      await computeTimelineBundleDigest(editedText),
    );
  });

  it('ignores forward-compat extra top-level fields (cache-key stability)', async () => {
    expect(await computeTimelineBundleDigest(makeEnvelope())).toBe(
      await computeTimelineBundleDigest(makeEnvelope({ writerNote: 'added later by newer tooling' })),
    );
  });
});

describe('transcriptReferences optional mediaId/sourceId', () => {
  const refs = (associations: Record<string, unknown>[]) => ({
    schema: 'media.transcript.references/v1',
    associations,
  });
  it('accepts and preserves optional mediaId/sourceId', () => {
    const row = { assetId: 'a', documentId: 'd', mediaId: 'sha256:x', sourceId: 'whisper' };
    const plain = { assetId: 'b', documentId: 'e' };
    const parsed = parseTimelineBundle(makeEnvelope({ transcriptReferences: refs([row, plain]) }));
    expect(parsed.transcriptReferences!.associations).toEqual([row, plain]);
    expect(Object.keys(parsed.transcriptReferences!.associations[1])).not.toContain('mediaId');
  });
  it('still requires assetId and rejects unknown keys', () => {
    expect(() => parseTimelineBundle(makeEnvelope({
      transcriptReferences: refs([{ documentId: 'd', mediaId: 'm', sourceId: 's' }]),
    }))).toThrow(/assetId/);
    expect(() => parseTimelineBundle(makeEnvelope({
      transcriptReferences: refs([{ assetId: 'a', documentId: 'd', extra: 1 }]),
    }))).toThrow(/extra/);
    expect(() => parseTimelineBundle(makeEnvelope({
      transcriptReferences: refs([{ assetId: 'a', documentId: 'd', mediaId: '' }]),
    }))).toThrow(TimelineBundleParseError);
  });
  it('still requires the envelope fields', () => {
    expect(() => parseTimelineBundle({ transcriptReferences: refs([]) })).toThrow(/itemsBySchemaRef/);
    expect(() => parseTimelineBundle({ itemsBySchemaRef: {} })).toThrow(/schema_version/);
  });
});

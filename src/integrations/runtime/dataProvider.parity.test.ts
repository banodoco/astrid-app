/**
 * RuntimeDataProvider contract assertions.
 *
 * Each test here asserts the DataProvider contract against the Runtime: load defaults, registry resolution, single-publish
 * saves, stale-head conflicts, bundle passthrough, identity validation and
 * load freshness. Bridge-only mechanisms (ULID aliases, PUT /registry, File
 * System Access drops, generation materialisation) have no Runtime
 * counterpart and are not tested here.
 *
 * The shared numeric-version suite runs in
 * tools/video-editor/testing/__tests__/providerCompatibility.runtime.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { RuntimeDataProvider } from './dataProvider.ts';
import {
  TimelineBundleParseError,
  type TimelineBundleEnvelope,
} from '@/tools/video-editor/data/typed/timelineBundle.ts';
import {
  TimelineNotFoundError,
  TimelineSchemaIncompatibleError,
} from '@/tools/video-editor/data/DataProvider.ts';
import { InMemoryDataProvider } from '@/tools/video-editor/testing/InMemoryDataProvider.ts';
import {
  expectUnsupportedExtensionPersistenceDiagnostics,
} from '@/tools/video-editor/data/conformance/extensionPersistenceConformance.ts';
import type { AssetRegistry } from '@/tools/video-editor/types/index.ts';
import {
  MANAGED_OBJECT_DIGEST,
  MANAGED_OBJECT_ID,
  PROJECT_ID,
  TIMELINE_ID,
  json,
  runtimeFixture,
} from '@/test/fakeWorkspaceRuntime.ts';

const BASE_URL = 'http://runtime.test';
const OTHER_OBJECT_ID = `sha256:${'b'.repeat(64)}`;
const objectUrl = (objectId: string) => `${BASE_URL}/v1/objects/${encodeURIComponent(objectId)}`;

type Fixture = ReturnType<typeof runtimeFixture>;
type FixtureTransport = Fixture['transport'];

function publicTimelineTransport(fixture: Fixture, delegate: FixtureTransport = fixture.transport): FixtureTransport {
  const path = `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`;
  return async (method, requestPath, headers, body) => {
    if (method === 'GET' && requestPath === path) {
      try {
        return await delegate(method, requestPath, headers, body);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('retired mutable timeline GET')) throw error;
        const current = fixture.read();
        return { status: 200, headers: {}, body: json({
          project_id: PROJECT_ID,
          timeline_id: TIMELINE_ID,
          head_revision_id: current.headRevisionId,
          head_publication_id: 'publication-current',
        }) };
      }
    }
    return delegate(method, requestPath, headers, body);
  };
}

function providerFor(fixture: Fixture, transport: FixtureTransport = fixture.transport) {
  return new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: BASE_URL, token: 'fixture-token', transport: publicTimelineTransport(fixture, transport) });
}

const isPublication = (request: Fixture['requests'][number]) =>
  request.method === 'POST' && request.path.endsWith('/composition-revisions');
const publications = (fixture: Fixture) => fixture.requests.filter(isPublication);
const inspections = (fixture: Fixture) =>
  fixture.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/inspect'));

const track = { id: 'V1', kind: 'visual' as const, label: 'V1' };

function composition(
  overrides: { config?: unknown; registry?: AssetRegistry; clips?: unknown[] } = {},
) {
  return {
    config: overrides.config ?? { clips: [], tracks: [track] },
    registry: overrides.registry ?? { assets: {} },
    clips: overrides.clips ?? [],
    occurrences: [],
  };
}

function managedRegistry(assets: Record<string, { file?: string; media_id: string }>): AssetRegistry {
  return {
    assets: Object.fromEntries(Object.entries(assets).map(([key, value]) => [key, {
      type: 'video/mp4',
      ...value,
    }])),
  } as AssetRegistry;
}

/** Rewrites the JSON body of matching fixture responses, simulating a Runtime that answers for the wrong identity. */
function tamper(
  transport: FixtureTransport,
  matches: (method: string, path: string) => boolean,
  mutate: (body: Record<string, unknown>) => void,
): FixtureTransport {
  return async (method, path, headers, body) => {
    const response = await transport(method, path, headers, body);
    if (!matches(method, path)) return response;
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
    mutate(parsed);
    return { ...response, body: json(parsed) };
  };
}

describe('capability flags', () => {
  it('declares the Runtime capabilities the editor reads, with no extension persistence and no cloud sync', () => {
    const provider = providerFor(runtimeFixture());

    expect(provider.supportsDirectAssetUpload).toBe(true);
    expect(provider.persistenceEnabled).toBe(true);
    expect('syncTimeline' in provider).toBe(false);
    expect('createExtensionPersistenceService' in provider).toBe(false);
    expectUnsupportedExtensionPersistenceDiagnostics(provider, [], 'Workspace Runtime');
  });

  it('declares no direct asset upload for InMemoryDataProvider', () => {
    const provider = new InMemoryDataProvider();
    expect(provider.supportsDirectAssetUpload).toBe(false);
  });
});

describe('load and registry', () => {
  it('loads a config-only head, defaulting version, output and registry', async () => {
    const fixture = runtimeFixture({ parentComposition: { config: { clips: [], tracks: [track] }, occurrences: [] } });
    const provider = providerFor(fixture);

    const loaded = await provider.loadTimeline(TIMELINE_ID);

    expect(loaded.configVersion).toBe(1);
    expect(loaded.config.tracks).toEqual([track]);
    expect(loaded.config.output).toEqual(expect.objectContaining({ resolution: '1280x720', fps: 30, file: 'output.mp4' }));
    await expect(provider.loadAssetRegistry(TIMELINE_ID)).resolves.toEqual({ assets: {} });
  });

  it('loads unknown keys on clips, tracks and registry entries from the canonical head', async () => {
    const clips = [{ id: 'c1', track: 'V1', at: 0, hold: 1, extensionAuthored: { keep: true } }];
    const fixture = runtimeFixture({ parentComposition: composition({
      config: { clips, tracks: [{ ...track, vendorField: 7 }] },
      clips,
      registry: { assets: { 'asset-video': { file: 'clips/demo.mp4', media_id: MANAGED_OBJECT_ID, vendorField: 'kept' } } } as unknown as AssetRegistry,
    }) });
    const provider = providerFor(fixture);

    const loaded = await provider.loadTimeline(TIMELINE_ID);
    const registry = await provider.loadAssetRegistry(TIMELINE_ID);
    expect(loaded.config.clips[0]).toMatchObject({ extensionAuthored: { keep: true } });
    expect(loaded.config.tracks?.[0]).toMatchObject({ vendorField: 7 });
    expect(registry.assets['asset-video']).toMatchObject({ vendorField: 'kept' });
    expect(fixture.read().parentComposition.config.clips[0]).toMatchObject({ extensionAuthored: { keep: true } });
  });

  it('rejects a non-object config instead of coercing it', async () => {
    const fixture = runtimeFixture({ parentComposition: composition({ config: 'garbage-string' }) });

    await expect(providerFor(fixture).loadTimeline(TIMELINE_ID)).rejects.toBeInstanceOf(TimelineSchemaIncompatibleError);
  });

  it('reports a transport timeout as an unavailable Runtime', async () => {
    const provider = providerFor(runtimeFixture(), async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });

    await expect(provider.loadTimeline(TIMELINE_ID)).rejects.toMatchObject({ code: 'runtime_unavailable' });
  });

  it('reports an unreadable non-2xx body as an unavailable Runtime, not a missing timeline', async () => {
    const fixture = runtimeFixture();
    const provider = providerFor(fixture, async (method, path, headers, body) => (
      path.endsWith('/inspect')
        ? { status: 502, headers: {}, body: new TextEncoder().encode('{not-json') }
        : fixture.transport(method, path, headers, body)
    ));

    const error = await provider.loadTimeline(TIMELINE_ID).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: 'runtime_unavailable', status: 502 });
    expect(error).not.toBeInstanceOf(TimelineNotFoundError);
  });

  it('fails a malformed 2xx body closed instead of loading it', async () => {
    const fixture = runtimeFixture();
    const provider = providerFor(fixture, async (method, path, headers, body) => (
      path.endsWith('/inspect')
        ? { status: 200, headers: {}, body: new TextEncoder().encode('{not-json') }
        : fixture.transport(method, path, headers, body)
    ));

    await expect(provider.loadTimeline(TIMELINE_ID)).rejects.toThrow();
    expect(fixture.requests.some((request) => request.path.includes('/composition-revisions/'))).toBe(false);
  });

  it('passes an opaque timeline id into the request path exactly as given', async () => {
    const legacyId = '01KYPVKMW5STB4W6FE05ED8242';
    const fixture = runtimeFixture();
    const paths: string[] = [];
    const provider = providerFor(fixture, async (method, path, headers, body) => {
      if (!path.includes('/timelines/')) return fixture.transport(method, path, headers, body);
      paths.push(path);
      return { status: 404, headers: {}, body: json({ code: 'not_found', message: 'unknown timeline' }) };
    });

    await expect(provider.loadTimeline(legacyId)).rejects.toBeInstanceOf(TimelineNotFoundError);
    expect(paths).toEqual([`/v1/projects/${PROJECT_ID}/timelines/${legacyId}/inspect`]);
  });
});

describe('asset resolve', () => {
  it('resolves media_id-only entries by registry key, media_id and onResolve, and fails closed for unknown ids', async () => {
    const fixture = runtimeFixture({ parentComposition: composition({
      registry: { assets: { source_audio: { media_id: MANAGED_OBJECT_ID, type: 'audio/mpeg' } } } as unknown as AssetRegistry,
    }) });
    const provider = providerFor(fixture);
    await provider.loadAssetRegistry(TIMELINE_ID);

    await expect(provider.resolveAssetUrl('source_audio')).resolves.toBe(objectUrl(MANAGED_OBJECT_ID));
    await expect(provider.resolveAssetUrl(MANAGED_OBJECT_ID)).resolves.toBe(objectUrl(MANAGED_OBJECT_ID));
    await expect(provider.onResolve({
      file: MANAGED_OBJECT_ID,
      assetId: 'source_audio',
      entry: { media_id: MANAGED_OBJECT_ID, type: 'audio/mpeg' },
    })).resolves.toBe(objectUrl(MANAGED_OBJECT_ID));
    await expect(provider.resolveAssetUrl('unregistered-media-id')).rejects.toThrow('has no managed object for asset unregistered-media-id');
  });

  it('does not fall back to a shared file locator when the asset key is unknown', async () => {
    const fixture = runtimeFixture({ parentComposition: composition({
      registry: managedRegistry({
        stale_file_asset: { file: 'shared/file.wav', media_id: OTHER_OBJECT_ID },
        source_audio: { file: 'shared/file.wav', media_id: MANAGED_OBJECT_ID },
      }),
    }) });
    const provider = providerFor(fixture);
    await provider.loadAssetRegistry(TIMELINE_ID);

    await expect(provider.onResolve({ file: 'shared/file.wav', assetId: 'unknown_asset' }))
      .rejects.toThrow('has no managed object for asset unknown_asset');
  });

  it('prefers the explicit asset key during onResolve when files overlap', async () => {
    const fixture = runtimeFixture({ parentComposition: composition({
      registry: managedRegistry({
        'asset-a': { file: 'shared/file.mp4', media_id: OTHER_OBJECT_ID },
        'asset-b': { file: 'shared/file.mp4', media_id: MANAGED_OBJECT_ID },
      }),
    }) });
    const provider = providerFor(fixture);
    await provider.loadAssetRegistry(TIMELINE_ID);

    await expect(provider.onResolve({ file: 'shared/file.mp4', assetId: 'asset-b' })).resolves.toBe(objectUrl(MANAGED_OBJECT_ID));
    await expect(provider.onResolve({ file: 'shared/file.mp4', assetId: 'asset-a' })).resolves.toBe(objectUrl(OTHER_OBJECT_ID));
  });

  it('rejects an unregistered relative path, and passes an absolute URL through, before any registry is loaded', async () => {
    const provider = providerFor(runtimeFixture());

    await expect(provider.resolveAssetUrl('relative.mp4')).rejects.toThrow('has no managed object for asset relative.mp4');
    await expect(provider.resolveAssetUrl('https://example.test/a.mp4')).resolves.toBe('https://example.test/a.mp4');
  });

  it('loads seeded registry metadata (integrity, provenance, enrichment, extensions) from a fresh provider', async () => {
    const metadata = {
      integrity: { algorithm: 'sha256', hash: 'parser-hash', size: 5 },
      provenance: { source: 'parser-test' },
      enrichment: {
        pending: 1,
        failed: 0,
        claims: [{ claimId: 'claim-1', parserId: 'com.example.parser', field: 'description' }],
      },
      extensions: { 'com.example.parser': { parsed: true } },
    };
    const fixture = runtimeFixture({ parentComposition: composition({ registry: {
      assets: { 'asset-enriched': {
        file: `/v1/objects/${encodeURIComponent(MANAGED_OBJECT_ID)}`,
        type: 'video/mp4', duration: 4, media_id: MANAGED_OBJECT_ID,
        content_sha256: MANAGED_OBJECT_DIGEST, metadata,
      } },
    } as unknown as AssetRegistry }) });
    const fresh = await providerFor(fixture).loadAssetRegistry(TIMELINE_ID);
    expect(fresh.assets['asset-enriched'].metadata).toEqual(metadata);
  });
});

describe('uploads', () => {
  const file = () => new File(['managed creative'], 'managed-creative.mp4', { type: 'video/mp4' });

  it('leaves the registry and the timeline untouched when the media import is refused', async () => {
    const fixture = runtimeFixture();
    const provider = providerFor(fixture, async (method, path, headers, body) => (
      method === 'POST' && path.endsWith('/media-imports')
        ? { status: 403, headers: {}, body: json({ code: 'forbidden', message: 'project folder is read-only' }) }
        : fixture.transport(method, path, headers, body)
    ));

    await expect(provider.uploadAsset(file(), { timelineId: TIMELINE_ID, userId: 'user-1' })).rejects.toThrow('project folder is read-only');

    expect(publications(fixture)).toHaveLength(0);
    expect(fixture.read().documentVersion).toBe(1);
    await expect(providerFor(fixture).loadAssetRegistry(TIMELINE_ID)).resolves.toEqual({ assets: {} });
  });
});

describe('bundle passthrough', () => {
  const bundle = (text: string): TimelineBundleEnvelope => ({
    schema_version: 1,
    itemsBySchemaRef: {
      'astrid.transcript_segment/v1': [{
        id: 'assetA:src:9a03b4c1d2e4',
        shape: 'interval',
        domain: 'source_seconds',
        extent: { start: 0, end: 1.5 },
        schemaRef: 'astrid.transcript_segment/v1',
        payload: { text },
        sourceArtifactRef: { assetId: 'assetA' },
        provenance: { adapterId: 'astrid.adaptTranscript', adapterVersion: '1' },
      }],
    },
  }) as TimelineBundleEnvelope;

  it('fails the whole load closed when the head declares an unparsable bundle', async () => {
    const invalid = { ...bundle('x'), schema_version: 99 };
    const fixture = runtimeFixture({ parentComposition: composition({ config: { clips: [], tracks: [track], bundle: invalid } }) });

    await expect(providerFor(fixture).loadTimeline(TIMELINE_ID)).rejects.toBeInstanceOf(TimelineBundleParseError);
  });

  it('rejects an invalid bundle before any publication request', async () => {
    const fixture = runtimeFixture({ parentComposition: composition() });
    const provider = providerFor(fixture);
    const loaded = await provider.loadTimeline(TIMELINE_ID);
    const invalid = { ...bundle('x'), schema_version: 99 } as unknown as TimelineBundleEnvelope;

    await expect(provider.saveTimelineAtHead(TIMELINE_ID, loaded.config, loaded.head!, undefined, invalid))
      .rejects.toBeInstanceOf(TimelineBundleParseError);

    expect(publications(fixture)).toHaveLength(0);
    expect(fixture.read().documentVersion).toBe(1);
  });
});

describe('identity validation', () => {
  const inspectPath = (method: string, path: string) => method === 'POST' && path.endsWith('/inspect');
  const revisionPath = (method: string, path: string) => method === 'GET' && path.includes('/composition-revisions/');

  it('accepts a head whose project and timeline match the request', async () => {
    const fixture = runtimeFixture({ parentComposition: composition() });

    await expect(providerFor(fixture).loadTimeline(TIMELINE_ID)).resolves.toMatchObject({
      head: { projectId: PROJECT_ID, timelineId: TIMELINE_ID, headRevisionId: 'parent-r1' },
    });
  });

  it('rejects an inspection that answers for another timeline', async () => {
    const fixture = runtimeFixture({ parentComposition: composition() });
    const provider = providerFor(fixture, tamper(fixture.transport, inspectPath, (body) => { body.timeline_id = 'timeline-other'; }));

    await expect(provider.loadTimeline(TIMELINE_ID)).rejects.toThrow('belongs to timeline timeline-other, not timeline-r1');
  });

  it('rejects an inspection that answers for another project', async () => {
    const fixture = runtimeFixture({ parentComposition: composition() });
    const provider = providerFor(fixture, tamper(fixture.transport, inspectPath, (body) => { body.project_id = 'project-other'; }));

    await expect(provider.loadTimeline(TIMELINE_ID)).rejects.toThrow('belongs to project project-other, not project-r1');
  });

  it('rejects a revision payload that belongs to another project or carries another revision id', async () => {
    const fixture = runtimeFixture({ parentComposition: composition() });
    const wrongProject = providerFor(fixture, tamper(fixture.transport, revisionPath, (body) => { body.project_id = 'project-other'; }));
    const wrongRevision = providerFor(fixture, tamper(fixture.transport, revisionPath, (body) => { body.revision_id = 'parent-other'; }));

    await expect(wrongProject.loadTimeline(TIMELINE_ID)).rejects.toThrow('belongs to project project-other, not project-r1');
    await expect(wrongRevision.loadTimeline(TIMELINE_ID)).rejects.toThrow('identity mismatch: requested parent-r1, got parent-other');
  });

  it('loads the matching revision/publication pair from the authenticated public timeline read', async () => {
    const fixture = runtimeFixture({ parentComposition: composition() });
    const provider = providerFor(fixture);

    const loaded = await provider.loadTimeline(TIMELINE_ID);

    expect(loaded.head).toMatchObject({
      projectId: PROJECT_ID,
      timelineId: TIMELINE_ID,
      headRevisionId: 'parent-r1',
      headPublicationId: 'publication-current',
    });
    expect(fixture.requests.filter((request) => request.method === 'GET'
      && request.path === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`)).toHaveLength(1);
  });

  it.each(['project_id', 'timeline_id'] as const)('refuses a public head from another %s', async (field) => {
    const fixture = runtimeFixture({ parentComposition: composition() });
    const transport: FixtureTransport = async (method, path, headers, body) => {
      if (method === 'GET' && path === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`) {
        return { status: 200, headers: {}, body: json({
          project_id: field === 'project_id' ? 'project-other' : PROJECT_ID,
          timeline_id: field === 'timeline_id' ? 'timeline-other' : TIMELINE_ID,
          head_revision_id: 'parent-r1',
          head_publication_id: 'publication-current',
        }) };
      }
      return fixture.transport(method, path, headers, body);
    };

    await expect(providerFor(fixture, transport).loadTimeline(TIMELINE_ID))
      .rejects.toThrow(`belongs to ${field === 'project_id' ? 'project project-other, not project-r1' : 'timeline timeline-other, not timeline-r1'}`);
  });

  it('refuses a moving public head without reading an unmatched immutable basis', async () => {
    const fixture = runtimeFixture({ parentComposition: composition() });
    const transport: FixtureTransport = async (method, path, headers, body) => {
      if (method === 'GET' && path === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`) {
        return { status: 200, headers: {}, body: json({
          project_id: PROJECT_ID,
          timeline_id: TIMELINE_ID,
          head_revision_id: 'parent-r2',
          head_publication_id: 'publication-r2',
        }) };
      }
      if (method === 'POST' && path.endsWith('/inspect')) {
        const response = await fixture.transport(method, path, headers, body);
        const inspection = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
        inspection.revision_id = 'parent-r1';
        inspection.head_revision_id = 'parent-r1';
        return { ...response, body: json(inspection) };
      }
      return fixture.transport(method, path, headers, body);
    };
    const provider = providerFor(fixture, transport);

    await expect(provider.loadTimeline(TIMELINE_ID)).rejects.toMatchObject({
      code: 'timeline_version_conflict', message: expect.stringContaining('head moved while pairing'),
    });
    expect(fixture.requests.some((request) => request.method === 'GET'
      && request.path.includes('/composition-revisions/'))).toBe(false);
  });

  it('preserves a true legacy null publication instead of inventing one', async () => {
    const fixture = runtimeFixture({ parentComposition: composition() });
    const transport: FixtureTransport = async (method, path, headers, body) => {
      if (method === 'GET' && path === `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}`) {
        return { status: 200, headers: {}, body: json({
          project_id: PROJECT_ID,
          timeline_id: TIMELINE_ID,
          head_revision_id: 'parent-r1',
          head_publication_id: null,
        }) };
      }
      return fixture.transport(method, path, headers, body);
    };

    await expect(providerFor(fixture, transport).loadTimeline(TIMELINE_ID))
      .resolves.toMatchObject({ head: { headRevisionId: 'parent-r1', headPublicationId: null } });
  });
});

describe('load freshness', () => {
  const externalHead = () => ({
    ...composition({
      config: { clips: [], tracks: [{ ...track, label: 'External' }] },
      registry: managedRegistry({ 'asset-external': { file: 'clips/external.mp4', media_id: OTHER_OBJECT_ID } }),
    }),
  });

  it('re-reads the head on every load so polling consumers observe external changes', async () => {
    const fixture = runtimeFixture({ parentComposition: composition() });
    const provider = providerFor(fixture);

    const first = await provider.loadTimeline(TIMELINE_ID);
    expect(first.configVersion).toBe(1);

    fixture.setHead('parent-external', externalHead());
    const second = await provider.loadTimeline(TIMELINE_ID);
    expect(second.configVersion).toBe(2);
    expect(second.config.tracks?.[0]?.label).toBe('External');
    expect(second.head?.headRevisionId).toBe('parent-external');

    const registry = await provider.loadAssetRegistry(TIMELINE_ID);
    expect(Object.keys(registry.assets)).toEqual(['asset-external']);
    expect(inspections(fixture)).toHaveLength(3);
  });

  it('reads the immutable revision once when the timeline and registry load together', async () => {
    const fixture = runtimeFixture({ parentComposition: composition() });
    const provider = providerFor(fixture);

    const [loaded, registry] = await Promise.all([
      provider.loadTimeline(TIMELINE_ID),
      provider.loadAssetRegistry(TIMELINE_ID),
    ]);

    expect(loaded.head?.headRevisionId).toBe('parent-r1');
    expect(registry).toEqual({ assets: {} });
    expect(fixture.requests.filter((request) => request.method === 'GET'
      && request.path.endsWith('/composition-revisions/parent-r1'))).toHaveLength(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeDataProvider } from './dataProvider.ts';
import type { RequestBody, Transport } from './generated.ts';
import { RUNTIME_MEDIA_IMPORT_MAX_BYTES } from '@/tools/video-editor/data/AssetResolver.ts';
import {
  RUNTIME_SCHEMA_DIGEST,
  RUNTIME_TARGETED_EXECUTION_CAPABILITY,
} from './contract-metadata.ts';
import { RUNTIME_CLIENT_SCOPES } from './client.ts';

const PROJECT_ID = 'project-imports';
const ASSET_ID = `sha256:${'a'.repeat(64)}`;
const browserStorage = new Map<string, string>();
const localStorageFixture = {
  clear: () => browserStorage.clear(),
  getItem: (key: string) => browserStorage.get(key) ?? null,
  setItem: (key: string, value: string) => browserStorage.set(key, String(value)),
  removeItem: (key: string) => browserStorage.delete(key),
};

beforeEach(() => {
  browserStorage.clear();
  vi.stubGlobal('localStorage', localStorageFixture);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function receipt(key: string) {
  return {
    receipt_id: 'receipt-import',
    command_kind: 'media.import',
    idempotency_key: key,
    request_hash: 'request-hash',
    project_id: PROJECT_ID,
    project_seq: [1, 1],
    event_ids: [],
    result: {},
    created_at: '2026-09-23T00:00:00Z',
  };
}

function createTransport(options: {
  lostAck?: boolean;
  importedProject?: string;
  selection?: Partial<{
    asset: string;
    generation_id: string;
    variant_id: string;
    object_id: string;
    catalog_digest: string;
  }>;
} = {}) {
  const requests: Array<{ method: string; path: string; headers: Record<string, string>; body?: RequestBody }> = [];
  let importPostCount = 0;
  const completed = {
    provider: 'runtime' as const,
    project: options.importedProject ?? PROJECT_ID,
    import_operation_id: 'operation-import',
    status: 'completed' as const,
    task_id: 'task-import',
    generation_id: 'generation-import',
    variant_id: 'variant-import',
    asset_id: ASSET_ID,
    entry: { object_id: ASSET_ID, media_type: 'video/mp4', size: 4, filename: 'clip.mp4' },
    provenance: { source: 'external_upload', origin: 'imported' },
    actor_id: 'connector-owner',
    duration_seconds: 2.5,
  };

  const transport: Transport = async (method, path, headers, body) => {
    requests.push({ method, path, headers, body });
    if (path === '/v1/health') return { status: 200, headers: {}, body: json({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, runtime_epoch: 1, runtime_instance_id: 'runtime-instance-import' }) };
    if (path === '/v1/handshake') return { status: 200, headers: {}, body: json({ protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, session_id: 'session-import', actor_id: 'connector-owner', realm_id: 'realm-import', scopes: [...RUNTIME_CLIENT_SCOPES], capabilities: [RUNTIME_TARGETED_EXECUTION_CAPABILITY] }) };
    if (path === '/v1/realm') return { status: 200, headers: {}, body: json({ realm_id: 'realm-import', display_name: 'imports', version: 1, created_at: '2026-09-23T00:00:00Z' }) };
    if (method === 'POST' && path === `/v1/projects/${PROJECT_ID}/media-imports`) {
      importPostCount += 1;
      expect(headers['Idempotency-Key']).toBeTruthy();
      expect(headers['Content-Type']).toBe('video/mp4');
      expect(headers['X-Original-Name']).toBe('clip.mp4');
      expect(headers['X-Media-Duration-Seconds']).toBe('2.5');
      if (options.lostAck && importPostCount === 1) throw new Error('response lost after commit');
      const result = { ...completed, import_operation_id: headers['Idempotency-Key']! };
      return { status: 201, headers: {}, body: json({ data: result, receipt: receipt(headers['Idempotency-Key']!) }) };
    }
    if (method === 'GET' && path.startsWith(`/v1/projects/${PROJECT_ID}/media-imports/`)) {
      return { status: 200, headers: {}, body: json({ ...completed, import_operation_id: path.split('/').at(-1) }) };
    }
    if (method === 'GET' && path.startsWith(`/v1/projects/${PROJECT_ID}/media-selection?`)) {
      return {
        status: 200,
        headers: {},
        body: json({
          asset: ASSET_ID,
          generation_id: 'generation-import',
          variant_id: 'variant-import',
          object_id: ASSET_ID,
          catalog_digest: 'sha256:catalog-import',
          ...options.selection,
        }),
      };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };

  return { transport, requests, get importPostCount() { return importPostCount; } };
}

describe('Runtime media import adapter', () => {
  it('returns one reusable catalog descriptor for local video bytes', async () => {
    localStorage.clear();
    const fixture = createTransport();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', transport: fixture.transport });

    const prepared = await provider.prepareMediaImport(
      new File([new Uint8Array([1, 2, 3, 4])], 'clip.mp4', { type: 'video/mp4' }),
      { durationSeconds: 2.5 },
    );

    expect(prepared).toMatchObject({
      provider: 'runtime',
      project: PROJECT_ID,
      importOperationId: expect.any(String),
      generationId: 'generation-import',
      variantId: 'variant-import',
      assetId: ASSET_ID,
      entry: {
        media_id: ASSET_ID,
        content_sha256: ASSET_ID,
        type: 'video/mp4',
        duration: 2.5,
        generationId: 'generation-import',
        variantId: 'variant-import',
      },
    });
    // The import response carries object metadata; the immutable five-field
    // selection is the authority used by verified media reads.
    expect(prepared.mediaSelection).toEqual({
      asset: ASSET_ID,
      generation_id: 'generation-import',
      variant_id: 'variant-import',
      object_id: ASSET_ID,
      catalog_digest: 'sha256:catalog-import',
    });
    expect(JSON.parse(JSON.stringify(prepared.entry))).toEqual({
      file: `http://runtime.test/v1/objects/${encodeURIComponent(ASSET_ID)}`,
      media_id: ASSET_ID,
      content_sha256: ASSET_ID,
      type: 'video/mp4',
      duration: 2.5,
      generationId: 'generation-import',
      variantId: 'variant-import',
      metadata: {
        provenance: {
          sourceProvider: 'workspace-runtime',
          importOperationId: prepared.importOperationId,
          source: 'external_upload',
          origin: 'imported',
        },
        extensions: {
          originalFilename: 'clip.mp4',
          byteSize: 4,
        },
      },
    });
    expect(prepared.entry).not.toHaveProperty('catalog_digest');
    expect(Object.isFrozen(prepared.mediaSelection)).toBe(true);
    expect(fixture.requests.filter((request) => request.path.includes('/media-selection?'))).toHaveLength(1);
    expect(localStorage.getItem(`astrid.runtime.media-import.v1:${PROJECT_ID}:${prepared.importOperationId}`)).toContain(prepared.importOperationId);
    expect(fixture.requests.filter((request) => request.path.includes('/generations') || request.path.includes('/variants'))).toHaveLength(0);
  });

  it('leaves a legacy preparation unqualified without refreshing its selection', async () => {
    const fixture = createTransport();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', transport: fixture.transport });

    const prepared = await provider.prepareAsset(
      new File(['bytes'], 'clip.mp4', { type: 'video/mp4' }),
      { timelineId: 'timeline-import', userId: 'actor' },
    );

    expect(prepared.entry).not.toHaveProperty('catalog_digest');
    expect(fixture.requests.some((request) => request.path.includes('/media-selection?'))).toBe(false);
  });

  it('refuses a selection for the wrong imported object', async () => {
    const fixture = createTransport({ selection: { object_id: 'sha256:wrong-object' } });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', transport: fixture.transport });

    await expect(provider.prepareMediaImport(
      new File(['bytes'], 'clip.mp4', { type: 'video/mp4' }),
    )).rejects.toThrow('does not match the prepared import');
  });

  it('refuses a completed import returned for the wrong project', async () => {
    const fixture = createTransport({ importedProject: 'other-project' });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', transport: fixture.transport });

    await expect(provider.prepareMediaImport(
      new File(['bytes'], 'clip.mp4', { type: 'video/mp4' }),
    )).rejects.toThrow('belongs to project other-project, not project-imports');
    expect(fixture.requests.some((request) => request.path.includes('/media-selection?'))).toBe(false);
  });

  it('recovers a lost import acknowledgement by operation lookup without a new key', async () => {
    localStorage.clear();
    const fixture = createTransport({ lostAck: true });
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', transport: fixture.transport });

    const prepared = await provider.prepareMediaImport(
      new File(['bytes'], 'clip.mp4', { type: 'video/mp4' }),
    );
    const postRequests = fixture.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/media-imports'));
    const lookupRequests = fixture.requests.filter((request) => request.method === 'GET' && request.path.includes('/media-imports/'));

    expect(prepared.generationId).toBe('generation-import');
    expect(postRequests).toHaveLength(1);
    expect(lookupRequests).toHaveLength(1);
    expect(postRequests[0]?.headers['Idempotency-Key']).toBe(lookupRequests[0]?.path.split('/').at(-1));
    expect(fixture.importPostCount).toBe(1);
  });

  it('accepts the exact 5 GiB boundary and rejects larger files before operation persistence', async () => {
    localStorage.clear();
    const fixture = createTransport();
    const provider = new RuntimeDataProvider({ projectId: PROJECT_ID, baseUrl: 'http://runtime.test', transport: fixture.transport });

    expect(RUNTIME_MEDIA_IMPORT_MAX_BYTES).toBe(5 * 1024 ** 3);
    const exactBoundary = new File(['bytes'], 'clip.mp4', { type: 'video/mp4' });
    const exactBoundaryArrayBuffer = vi.fn();
    Object.defineProperty(exactBoundary, 'size', { value: RUNTIME_MEDIA_IMPORT_MAX_BYTES });
    Object.defineProperty(exactBoundary, 'arrayBuffer', { value: exactBoundaryArrayBuffer });
    const prepared = await provider.prepareMediaImport(exactBoundary);
    const importRequest = fixture.requests.find((request) => request.method === 'POST' && request.path.endsWith('/media-imports'));

    expect(importRequest?.body).toBe(exactBoundary);
    expect(exactBoundaryArrayBuffer).not.toHaveBeenCalled();
    expect(prepared.assetId).toBe(ASSET_ID);

    const oversized = new File(['bytes'], 'oversized.mp4', { type: 'video/mp4' });
    Object.defineProperty(oversized, 'size', { value: RUNTIME_MEDIA_IMPORT_MAX_BYTES + 1 });
    await expect(provider.prepareMediaImport(oversized)).rejects.toThrow(
      'oversized.mp4 exceeds the Workspace Runtime media limit of 5 GiB',
    );
    expect(fixture.importPostCount).toBe(1);
    expect(fixture.requests.some((request) => request.path.includes('oversized.mp4'))).toBe(false);

    const oversizedObject = new File(['bytes'], 'oversized-object.mp4', { type: 'video/mp4' });
    Object.defineProperty(oversizedObject, 'size', { value: RUNTIME_MEDIA_IMPORT_MAX_BYTES + 1 });
    const readBytes = vi.fn();
    Object.defineProperty(oversizedObject, 'arrayBuffer', { value: readBytes });
    await expect(provider.prepareAsset(oversizedObject, { timelineId: 'timeline-import', userId: 'actor' })).rejects.toThrow(
      'oversized-object.mp4 exceeds the Workspace Runtime media limit of 5 GiB',
    );
    expect(readBytes).not.toHaveBeenCalled();
  });
});

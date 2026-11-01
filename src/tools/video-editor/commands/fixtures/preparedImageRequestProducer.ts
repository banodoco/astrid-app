import type { CanonicalDocument, CommitRequest, MediaSelection } from '@/integrations/runtime/timeline-commit-types.ts';
import { ApiError } from '@/integrations/runtime/generated.ts';
import { buildTimelineData } from '../../lib/timeline-data.ts';
import { withDefaultTimelineOutput } from '../../lib/defaults.ts';
import { canonicalizeTimelinePair, projectTimelineTracksForDisplay } from '../../lib/timeline-domain.ts';
import { buildPlacePreparedMediaCommand } from '../../hooks/useAssetManagement.ts';
import { previewPreparedMediaCommand } from '../media.ts';
import { createCommitOutbox, toOutboxJson } from '../commitOutbox.ts';
import { createLocalSaveSession } from '../localSaveSession.ts';
import type { TimelineCommandBasis } from '../../data/DataProvider.ts';
import type { AssetRegistry, AssetRegistryEntry } from '../../types/index.ts';
import type { TimelineProvisionedAsset } from '../provisioning.ts';
import { createTimelineLocalSaveHandoff } from '../../hooks/timelineLocalSaveHandoff.ts';

const SELECTION_KEYS = ['asset', 'catalog_digest', 'generation_id', 'object_id', 'variant_id'];

type NodeProcessRuntime = { getBuiltinModule?: (id: string) => unknown };

function nodeBuiltin<T>(id: string): T {
  const runtime = (globalThis as { process?: NodeProcessRuntime }).process;
  if (typeof runtime?.getBuiltinModule !== 'function') throw new Error(`Node builtin ${id} is unavailable`);
  return runtime.getBuiltinModule(id) as T;
}

export type PreparedImageRequestInput = {
  projectId: string;
  timelineId: string;
  head: { revisionId: string; publicationId: string };
  canonicalDocument: CanonicalDocument;
  preparedAsset: {
    assetKey: string;
    mediaType: 'image';
    durationSeconds: number | null;
    entry: AssetRegistryEntry;
    source: 'registered';
    mediaSelection: MediaSelection;
  };
  placement: {
    trackId?: string;
    selectedTrackId?: string | null;
    at: number;
  };
};

export type PreparedImageRequestOutput = {
  request: CommitRequest;
  idempotency_key: string;
  request_body_sha256: `sha256:${string}`;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function validateSelection(value: unknown): asserts value is MediaSelection {
  const selection = record(value, 'preparedAsset.mediaSelection');
  if (Object.keys(selection).sort().join('\0') !== SELECTION_KEYS.join('\0')
    || !['asset', 'generation_id', 'variant_id'].every((key) => typeof selection[key] === 'string' && selection[key])) {
    throw new Error('preparedAsset.mediaSelection must be the closed Runtime five-field selection');
  }
  if (!['object_id', 'catalog_digest'].every((key) => typeof selection[key] === 'string'
    && /^sha256:[0-9a-f]{64}$/.test(selection[key] as string))) {
    throw new Error('preparedAsset.mediaSelection has malformed Runtime image digests');
  }
}

function validateInput(input: PreparedImageRequestInput): void {
  nonEmptyString(input.projectId, 'projectId');
  nonEmptyString(input.timelineId, 'timelineId');
  nonEmptyString(input.head.revisionId, 'head.revisionId');
  nonEmptyString(input.head.publicationId, 'head.publicationId');
  if (input.canonicalDocument.project_id !== input.projectId || input.canonicalDocument.timeline_id !== input.timelineId
    || input.canonicalDocument.parent_revision.revision_id !== input.head.revisionId) {
    throw new Error('canonicalDocument does not match the supplied project, timeline, and head');
  }
  nonEmptyString(input.preparedAsset.assetKey, 'preparedAsset.assetKey');
  validateSelection(input.preparedAsset.mediaSelection);
  if (input.preparedAsset.mediaSelection.asset !== input.preparedAsset.assetKey) {
    throw new Error('preparedAsset.mediaSelection.asset must match preparedAsset.assetKey');
  }
  if (input.preparedAsset.mediaType !== 'image' || !input.preparedAsset.entry.type?.startsWith('image/')) {
    throw new Error('preparedAsset must contain image metadata');
  }
  if (!Number.isFinite(input.placement.at) || input.placement.at < 0) throw new Error('placement.at must be non-negative');
}

function sha256(value: string): Promise<`sha256:${string}`> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then((digest) =>
    `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}` as `sha256:${string}`);
}

function outboxStorage() {
  const { createRequire } = nodeBuiltin<typeof import('node:module')>('node:module');
  const { createFakeIndexedDB } = createRequire(import.meta.url)('fake-indexeddb') as {
    createFakeIndexedDB: () => IDBFactory;
  };
  const held = new Set<string>();
  return createCommitOutbox({
    indexedDB: createFakeIndexedDB(),
    exclusiveLock: async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      if (held.has(name)) throw new Error('fixture outbox is already claimed');
      held.add(name);
      try {
        return await work();
      } finally {
        held.delete(name);
      }
    },
  });
}

/**
 * Test-only bridge: run the existing prepared-image command, capture, session,
 * and durable outbox path, then stop at the App send boundary.
 */
export async function producePreparedImageRequest(input: PreparedImageRequestInput): Promise<PreparedImageRequestOutput> {
  validateInput(input);
  const parent = record(input.canonicalDocument.parent_revision.payload, 'canonicalDocument.parent_revision.payload');
  const rawConfig = record(parent.config, 'canonical parent config');
  const rawClips = parent.clips;
  if (!Array.isArray(rawClips)) throw new Error('canonical parent clips must be an array');
  const registry = (parent.registry ?? { assets: {} }) as AssetRegistry;
  const config = { ...rawConfig, clips: structuredClone(rawClips) } as never;
  const head = {
    projectId: input.projectId,
    timelineId: input.timelineId,
    headRevisionId: input.head.revisionId,
    headPublicationId: input.head.publicationId,
  };
  const current = await buildTimelineData(config, registry, undefined, 1, undefined, head);
  const preparedAsset = structuredClone(input.preparedAsset) as TimelineProvisionedAsset;
  const preparedCommand = buildPlacePreparedMediaCommand({
    prepared: preparedAsset,
    trackId: input.placement.trackId,
    selectedTrackId: input.placement.selectedTrackId,
    time: input.placement.at,
    forceNewTrack: false,
    insertAtTop: false,
  });
  const preview = previewPreparedMediaCommand(current, preparedCommand);
  const detail = preview?.commandResult?.detail;
  if (!detail || typeof detail.clipId !== 'string') throw new Error('prepared image placement did not produce a clip');
  const nextConfig = record(preview.nextData.config, 'prepared image preview config');
  const nextClips = nextConfig.clips;
  if (!Array.isArray(nextClips)) throw new Error('prepared image preview clips must be an array');
  const row = nextClips.find((candidate) => record(candidate, 'prepared image preview clip').id === detail.clipId);
  if (!row) throw new Error('prepared image preview did not contain the requested clip');

  const initial: TimelineCommandBasis = {
    head: structuredClone(input.head),
    canonicalDocument: structuredClone(input.canonicalDocument),
  };
  let captured: { request: CommitRequest; key: string } | undefined;
  let resolveCapture!: (value: { request: CommitRequest; key: string }) => void;
  const capturedPromise = new Promise<{ request: CommitRequest; key: string }>((resolve) => { resolveCapture = resolve; });
  const scope = { projectId: input.projectId, timelineId: input.timelineId, realmId: 'fixture', actorId: 'fixture' };
  const { bundle: _bundle, ...sourceConfig } = rawConfig;
  const loaded = { ...sourceConfig, ...withDefaultTimelineOutput(sourceConfig as never) } as never;
  const projected = canonicalizeTimelinePair(loaded, structuredClone(registry));
  const source = { config: projectTimelineTracksForDisplay(projected.config), registry: projected.registry, head };
  const session = await createLocalSaveSession({
    scope,
    initial,
    document: toOutboxJson(input.canonicalDocument),
    outboxes: outboxStorage(),
    send: async (request, key) => {
      captured = { request, key };
      resolveCapture(captured);
      throw new ApiError(422, 'fixture_capture_stop', 'test-only capture stops before Runtime authority acceptance');
    },
    loadLatest: async () => initial,
    prepareDisplay: async () => { throw new Error('test-only producer does not accept a Runtime reply'); },
    changed: () => {},
  });
  const handoff = createTimelineLocalSaveHandoff({ initial, source, session, adopted: () => {
    throw new Error('test-only producer does not accept a Runtime reply');
  } });
  try {
    await handoff.capture({
      ...source,
      config: preview.nextData.config,
      registry: preview.nextData.registry,
    }, {
      kind: 'prepared-media', config: source.config, registry: source.registry, clipId: detail.clipId, command: preparedCommand,
    });
    try {
      await handoff.flush();
      throw new Error('test-only producer unexpectedly received Runtime acceptance');
    } catch (error) {
      if (!captured) throw error;
    }
    captured = await capturedPromise;
  } finally {
    await session.dispose();
  }
  if (!captured) throw new Error('prepared image request was not captured');
  const body = JSON.stringify(captured.request);
  return {
    request: captured.request,
    idempotency_key: captured.key,
    request_body_sha256: await sha256(body),
  };
}

export async function producePreparedImageRequestFromPaths(inputPath: string, outputPath: string): Promise<PreparedImageRequestOutput> {
  nonEmptyString(inputPath, 'input path');
  nonEmptyString(outputPath, 'output path');
  const { readFile, writeFile } = nodeBuiltin<typeof import('node:fs/promises')>('node:fs/promises');
  const input = JSON.parse(await readFile(inputPath, 'utf8')) as PreparedImageRequestInput;
  const output = await producePreparedImageRequest(input);
  await writeFile(outputPath, `${JSON.stringify(output)}\n`, { encoding: 'utf8', flag: 'wx' });
  return output;
}

if (process.argv[1] && process.argv[1].endsWith('preparedImageRequestProducer.ts')) {
  const [inputPath, outputPath, ...extra] = process.argv.slice(2);
  if (!inputPath || !outputPath || extra.length) {
    throw new Error('usage: node --import tsx preparedImageRequestProducer.ts INPUT_JSON OUTPUT_JSON');
  }
  await producePreparedImageRequestFromPaths(inputPath, outputPath);
}

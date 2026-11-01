import type {
  AssetRegistry,
  AssetRegistryEntry,
  TimelineClip,
  TimelineConfig,
} from '@/tools/video-editor/types/index.ts';
import type { MediaSelection } from '@/integrations/runtime/timeline-commit-types.ts';

export interface SilenceRegion {
  start: number;
  end: number;
}

export interface AssetProfile {
  transcript?: { segments?: Array<{ start: number; end: number; text: string }> };
  [key: string]: unknown;
}

export interface UploadAssetOptions {
  timelineId: string;
  userId: string;
  filename?: string;
}

export interface UploadedAssetResult {
  assetId: string;
  entry: AssetRegistryEntry;
}

/** One catalog settlement that can be reused by gallery and timeline paths. */
export interface PreparedMediaImport {
  provider: string;
  project: string;
  importOperationId: string;
  generationId: string;
  variantId: string;
  assetId: string;
  entry: AssetRegistryEntry;
  /** Original Runtime selection captured with this preparation, if qualified. */
  mediaSelection?: MediaSelection;
}

export interface MediaImportOptions {
  filename?: string;
  mediaType?: string;
  expectedDigest?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

/**
 * Workspace Runtime's HTTP/object boundary. Keep callers from reading the
 * whole browser file or creating an import operation when the request cannot
 * be accepted by Runtime.
 */
export const RUNTIME_MEDIA_IMPORT_MAX_BYTES = 5 * 1024 ** 3;

export function assertRuntimeMediaImportSize(file: Pick<File, 'name' | 'size'>): void {
  if (file.size <= RUNTIME_MEDIA_IMPORT_MAX_BYTES) {
    return;
  }

  throw new Error(
    `${file.name} exceeds the Workspace Runtime media limit of 5 GiB`,
  );
}

export interface AssetResolveRequest {
  file: string;
  assetId?: string;
  entry?: AssetRegistryEntry;
  clipId?: string;
  timelineId?: string;
}

export type AssetMissingReason =
  | 'missing_asset'
  | 'unresolvable_asset'
  | 'invalid_asset_url';

export interface AssetMissingRequest {
  assetId: string;
  reason: AssetMissingReason;
  clipId?: string;
  timelineId?: string;
  file?: string;
  entry?: AssetRegistryEntry;
  clip?: TimelineClip;
  config?: TimelineConfig;
  registry?: AssetRegistry;
}

export interface AssetProfileLoadRequest {
  assetId: string;
  timelineId?: string;
}

export interface AssetUploadRequest {
  file: File;
  options: UploadAssetOptions;
}

export interface AssetTranscodeRequest {
  file: File;
  timelineId: string;
  userId: string;
  intent: 'asset-upload' | 'image-generation' | 'video-generation';
}

export interface AssetResolver {
  onResolve?(request: AssetResolveRequest): Promise<string>;
  onUpload?(request: AssetUploadRequest): Promise<UploadedAssetResult>;
  onTranscode?(request: AssetTranscodeRequest): Promise<File | null | undefined>;
  onMissing?(request: AssetMissingRequest): Promise<void>;
  onProfileLoad?(request: AssetProfileLoadRequest): Promise<AssetProfile | null>;
  resolveAssetUrl(file: string): string | Promise<string>;
  registerAsset?(timelineId: string, assetId: string, entry: AssetRegistryEntry): Promise<void>;
  /** Prepare bytes and return a durable asset identity without mutating a timeline. */
  prepareAsset?(
    file: File,
    options: UploadAssetOptions,
  ): Promise<UploadedAssetResult>;
  /** Import image/video bytes into the provider's canonical media catalog. */
  prepareMediaImport?(
    file: File,
    options?: MediaImportOptions,
  ): Promise<PreparedMediaImport>;
  uploadAsset?(
    file: File,
    options: UploadAssetOptions,
  ): Promise<UploadedAssetResult>;
  loadWaveform?(assetId: string): Promise<SilenceRegion[] | null>;
  loadAssetProfile?(assetId: string): Promise<AssetProfile | null>;
}

export async function resolveAssetUrlWithResolver(
  resolver: AssetResolver,
  request: AssetResolveRequest,
): Promise<string> {
  if (resolver.onResolve) {
    return resolver.onResolve(request);
  }

  return resolver.resolveAssetUrl(request.file);
}

export async function uploadAssetWithResolver(
  resolver: AssetResolver,
  request: AssetUploadRequest,
): Promise<UploadedAssetResult> {
  if (resolver.onUpload) {
    return resolver.onUpload(request);
  }

  if (!resolver.uploadAsset) {
    throw new Error('This editor backend does not support asset uploads');
  }

  return resolver.uploadAsset(request.file, request.options);
}

export async function prepareAssetWithResolver(
  resolver: AssetResolver,
  request: AssetUploadRequest,
): Promise<UploadedAssetResult> {
  if (resolver.prepareAsset) {
    return resolver.prepareAsset(request.file, request.options);
  }

  throw new Error('This editor backend does not support write-free asset preparation');
}

export async function transcodeAssetWithResolver(
  resolver: AssetResolver,
  request: AssetTranscodeRequest,
): Promise<File> {
  if (!resolver.onTranscode) {
    return request.file;
  }

  return (await resolver.onTranscode(request)) ?? request.file;
}

export async function notifyMissingAsset(
  resolver: AssetResolver,
  request: AssetMissingRequest,
): Promise<void> {
  await resolver.onMissing?.(request);
}

export async function loadAssetProfileWithResolver(
  resolver: AssetResolver,
  request: AssetProfileLoadRequest,
): Promise<AssetProfile | null> {
  if (resolver.onProfileLoad) {
    return resolver.onProfileLoad(request);
  }

  return resolver.loadAssetProfile?.(request.assetId) ?? null;
}

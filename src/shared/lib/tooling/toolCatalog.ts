import astridToolCatalogJson from '@astrid/tools/catalog.json';
import { TOOL_IDS } from './toolIds';

export interface AstridToolCatalogEntry {
  id: string;
  canonical_id: string;
  pack_id: string;
  pack_version: string;
  target: string;
  compatibility: { host: string };
  manifest: { path: string; sha256: string; size?: number };
  entry: { path: string; sha256: string; size: number; host_entry: string };
  resources: Array<{ path: string; kind: string; sha256: string; size: number }>;
  dependencies: Record<string, string[]>;
  release_sha256: string;
}

export interface AstridToolCatalog {
  schema_version: number;
  tools: readonly AstridToolCatalogEntry[];
}

export type ToolLaunchResolution =
  | { available: true; entry: AstridToolCatalogEntry }
  | { available: false; reason: string };

export const ASTRID_TOOL_CATALOG = astridToolCatalogJson as AstridToolCatalog;

/**
 * Owners the App accepts for the Video Editor's catalog binding.
 * `rendering` is the owner the release-12 Agent (0f792afb1) serves.
 * `video_editing` is a TEMPORARY compatibility entry for the vendored Astrid catalog (ec0a9f5) and
 * older Agents. Remove it with the Plan 39 item that refreshes the vendor from the release Agent.
 */
const VIDEO_EDITOR_OWNERS = [
  { canonical_id: 'rendering.video-editor', pack_id: 'rendering' },
  { canonical_id: 'video_editing.video-editor', pack_id: 'video_editing' }, // temporary: Plan 39
] as const;

/** Resolve the catalog-bound Video Editor while leaving legacy Tool routes host-owned. */
export function resolveToolLaunch(
  catalog: AstridToolCatalog,
  toolId: string,
): ToolLaunchResolution {
  if (catalog.schema_version !== 1) {
    return { available: false, reason: 'unsupported-catalog-version' };
  }
  const matches = catalog.tools.filter((entry) => entry.id === toolId);
  if (matches.length !== 1) {
    return { available: false, reason: matches.length ? 'duplicate-catalog-entry' : 'missing-catalog-entry' };
  }

  const entry = matches[0];
  if (toolId !== TOOL_IDS.VIDEO_EDITOR
    || !VIDEO_EDITOR_OWNERS.some((owner) => owner.canonical_id === entry.canonical_id && owner.pack_id === entry.pack_id)) {
    return { available: false, reason: 'unsupported-canonical-tool-binding' };
  }
  if (entry.target !== 'astrid' || entry.compatibility?.host !== '1') {
    return { available: false, reason: 'incompatible-host' };
  }
  if (entry.entry?.host_entry !== TOOL_IDS.VIDEO_EDITOR
    || !entry.entry.path
    || !/^[a-f0-9]{64}$/.test(entry.entry.sha256)
    || !/^[a-f0-9]{64}$/.test(entry.manifest?.sha256)
    || !/^[a-f0-9]{64}$/.test(entry.release_sha256)) {
    return { available: false, reason: 'stale-or-invalid-release-binding' };
  }
  return { available: true, entry };
}

export const VIDEO_EDITOR_TOOL_LAUNCH = resolveToolLaunch(ASTRID_TOOL_CATALOG, TOOL_IDS.VIDEO_EDITOR);

export function isToolLaunchable(toolId: string): boolean {
  return resolveToolLaunch(ASTRID_TOOL_CATALOG, toolId).available;
}

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'crypto';

export type AstridSource = {
  checkout: string;
  sourceRoot: string;
};

export type ValidatedAstridToolCatalog = {
  catalogPath: string;
  catalogSha256: string;
  toolIds: string[];
};

type BoundToolFile = { path?: unknown; sha256?: unknown; size?: unknown; host_entry?: unknown };
type BoundTool = {
  id?: unknown;
  canonical_id?: unknown;
  pack_id?: unknown;
  pack_version?: unknown;
  target?: unknown;
  compatibility?: { host?: unknown };
  manifest?: BoundToolFile;
  entry?: BoundToolFile;
  resources?: BoundToolFile[];
  dependencies?: unknown;
  release_sha256?: unknown;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readBoundFile(packRoot: string, relativePath: unknown, expectedSha256: unknown): Buffer {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Astrid Tool catalog contains an unsafe resource path: ${String(relativePath)}`);
  }
  const filePath = path.resolve(packRoot, relativePath);
  if (!filePath.startsWith(`${packRoot}${path.sep}`)) {
    throw new Error(`Astrid Tool catalog resource escapes its pack: ${relativePath}`);
  }
  const realPackRoot = fs.realpathSync(packRoot);
  const realFilePath = fs.realpathSync(filePath);
  const stat = fs.lstatSync(filePath);
  if (!realFilePath.startsWith(`${realPackRoot}${path.sep}`) || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Astrid Tool catalog resource is not a regular in-pack file: ${relativePath}`);
  }
  const bytes = fs.readFileSync(filePath);
  if (typeof expectedSha256 !== 'string' || sha256(bytes) !== expectedSha256) {
    throw new Error(`Astrid Tool catalog is stale for ${relativePath}; regenerate it from the selected Astrid source`);
  }
  return bytes;
}

/** Fail the Astrid App build before the Video Editor can launch against stale Astrid inputs. */
export function validateAstridToolCatalog(sourceRoot: string): ValidatedAstridToolCatalog {
  const catalogPath = path.join(sourceRoot, 'tools', 'catalog.json');
  if (!fs.existsSync(catalogPath) || !fs.lstatSync(catalogPath).isFile() || fs.lstatSync(catalogPath).isSymbolicLink()) {
    throw new Error(`Astrid whole-Tool catalog is missing: ${catalogPath}; run scripts/gen_tool_catalog.py in the selected Astrid source`);
  }
  const catalogBytes = fs.readFileSync(catalogPath);
  let catalog: unknown;
  try {
    catalog = JSON.parse(catalogBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Astrid whole-Tool catalog is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!catalog || typeof catalog !== 'object' || !('schema_version' in catalog)
    || (catalog as { schema_version?: unknown }).schema_version !== 1
    || !Array.isArray((catalog as { tools?: unknown }).tools)) {
    throw new Error('Astrid whole-Tool catalog must have schema_version 1 and a tools array');
  }

  const tools = (catalog as { tools?: unknown }).tools as BoundTool[];
  const ids = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(tool.id)
      || typeof tool.pack_id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(tool.pack_id)) {
      throw new Error('Astrid whole-Tool catalog contains an invalid Tool identity');
    }
    if (ids.has(tool.id)) throw new Error(`Astrid whole-Tool catalog duplicates host Tool ID ${tool.id}`);
    ids.add(tool.id);
    if (tool.target !== 'astrid' || tool.compatibility?.host !== '1') {
      throw new Error(`Astrid Tool ${tool.id} is incompatible with Astrid App host 1`);
    }
    const packRoot = path.join(sourceRoot, 'packs', tool.pack_id);
    const manifestBytes = readBoundFile(packRoot, tool.manifest?.path, tool.manifest?.sha256);
    if (typeof tool.manifest?.size === 'number' && manifestBytes.length !== tool.manifest.size) {
      throw new Error(`Astrid Tool manifest size is stale for ${tool.id}`);
    }
    const entryBytes = readBoundFile(packRoot, tool.entry?.path, tool.entry?.sha256);
    if (entryBytes.length !== tool.entry?.size) throw new Error(`Astrid Tool entry size is stale for ${tool.id}`);
    let entryContract: unknown;
    try {
      entryContract = JSON.parse(entryBytes.toString('utf8'));
    } catch {
      throw new Error(`Astrid Tool entry is invalid JSON for ${tool.id}`);
    }
    if (!entryContract || typeof entryContract !== 'object'
      || (entryContract as { tool_id?: unknown }).tool_id !== tool.id
      || (entryContract as { host_entry?: unknown }).host_entry !== tool.entry?.host_entry) {
      throw new Error(`Astrid Tool entry host binding is stale for ${tool.id}`);
    }
    if (!Array.isArray(tool.resources)) throw new Error(`Astrid Tool resources are invalid for ${tool.id}`);
    for (const resource of tool.resources) {
      const bytes = readBoundFile(packRoot, resource?.path, resource?.sha256);
      if (bytes.length !== resource?.size) throw new Error(`Astrid Tool resource size is stale for ${tool.id}: ${resource?.path}`);
    }
    const { release_sha256: releaseSha256, ...releasePayload } = tool;
    if (typeof releaseSha256 !== 'string' || sha256(stableJson(releasePayload)) !== releaseSha256) {
      throw new Error(`Astrid Tool release binding is stale for ${tool.id}`);
    }
  }
  if (!ids.has('video-editor')) {
    throw new Error('Astrid whole-Tool catalog does not admit video-editor for this Astrid App host');
  }
  return { catalogPath, catalogSha256: sha256(catalogBytes), toolIds: [...ids].sort() };
}

/** Resolve an explicit checkout, or the pinned browser sources shipped with this app. */
export function resolveAstridSource(
  configuredPath = process.env.ASTRID_CHECKOUT,
  environmentName = 'ASTRID_CHECKOUT',
): AstridSource | null {
  const value = configuredPath?.trim() || (() => {
    const bundledCheckout = fileURLToPath(new URL('../../vendor/astrid-browser', import.meta.url));
    return fs.existsSync(bundledCheckout) ? bundledCheckout : '';
  })();
  if (!value) {
    return null;
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`${environmentName} must be an absolute path`);
  }

  const checkout = fs.realpathSync(value);
  const sourceRoot = path.join(checkout, 'astrid');
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw new Error(`${environmentName} is missing its canonical astrid source: ${sourceRoot}`);
  }

  return {checkout, sourceRoot};
}

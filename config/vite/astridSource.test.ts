import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAstridSource, validateAstridToolCatalog } from './astridSource';

const temporaryRoots: string[] = [];

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Astrid source binding', () => {
  it('requires an absolute checkout and preserves its canonical source root', () => {
    expect(() => resolveAstridSource('relative-checkout')).toThrow(/absolute path/);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-app-source-'));
    temporaryRoots.push(root);
    fs.mkdirSync(path.join(root, 'astrid'), { recursive: true });
    expect(resolveAstridSource(root)).toEqual({
      checkout: fs.realpathSync(root),
      sourceRoot: fs.realpathSync(path.join(root, 'astrid')),
    });
  });

  it('validates a Unicode UTF-8 resource and its canonical release digest without generating production output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-app-catalog-'));
    temporaryRoots.push(root);
    const sourceRoot = path.join(root, 'astrid');
    const packRoot = path.join(sourceRoot, 'packs', 'rendering');
    const entryPath = path.join(packRoot, 'ui/video-editor/entry.json');
    const resourcePath = path.join(packRoot, 'shared/label.txt');
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
    const manifest = 'schema_version: 3\nid: rendering\n';
    const entry = '{"schema_version":1,"tool_id":"video-editor","host_entry":"video-editor"}\n';
    const resource = 'café — UTF-8\n';
    fs.writeFileSync(path.join(packRoot, 'pack.yaml'), manifest, 'utf8');
    fs.writeFileSync(entryPath, entry, 'utf8');
    fs.writeFileSync(resourcePath, resource, 'utf8');
    const descriptor = {
      id: 'video-editor',
      canonical_id: 'rendering.video-editor',
      pack_id: 'rendering',
      pack_version: '1.0.0',
      target: 'astrid',
      compatibility: { host: '1' },
      manifest: { path: 'pack.yaml', sha256: digest(manifest) },
      entry: { path: 'ui/video-editor/entry.json', sha256: digest(entry), size: Buffer.byteLength(entry), host_entry: 'video-editor' },
      resources: [{ path: 'shared/label.txt', kind: 'documentation', sha256: digest(resource), size: Buffer.byteLength(resource) }],
      dependencies: { runtime: ['café'] },
    };
    const catalog = { schema_version: 1, tools: [{ ...descriptor, release_sha256: digest(stableJson(descriptor)) }] };
    fs.mkdirSync(path.join(sourceRoot, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'tools/catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

    expect(validateAstridToolCatalog(sourceRoot).toolIds).toEqual(['video-editor']);
  });
});

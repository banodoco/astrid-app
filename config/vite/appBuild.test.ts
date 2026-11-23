import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAppBuildPlugin, resolveAppBuildInfo, resolveEditorPackRevisions } from './appBuild';

describe('App build info', () => {
  it('keeps the App build independent and binds release to the supplied manifest', () => {
    expect(resolveAppBuildInfo({ appBuild: 'app-a', manifest: { release: 8 } })).toEqual({ app: 'app-a', release: 8 });
    expect(resolveAppBuildInfo({ appBuild: 'app-b', manifest: { release: 9 } })).toEqual({ app: 'app-b', release: 9 });
    expect(resolveAppBuildInfo({ appBuild: 'app-b', manifest: {} })).toEqual({ app: 'app-b', release: 0 });
  });

  it('emits exactly the build pair and serves it without cache in dev and preview', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'astrid-build-'));
    const manifestPath = path.join(directory, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ release: 17, runtime: { release: 2 } }));
    try {
      const plugin = createAppBuildPlugin({ appBuild: 'app-build-abc', manifestPath });
      expect(plugin.config?.({} as never, { command: 'build', mode: 'production' } as never)).toMatchObject({
        define: { __ASTRID_APP_BUILD__: '"app-build-abc"' },
      });
      const emitted: Array<{ fileName: string; source: string }> = [];
      plugin.generateBundle?.call({ emitFile: (file: { fileName: string; source: string }) => emitted.push(file) } as never, {} as never);
      expect(emitted).toEqual([{ type: 'asset', fileName: 'build.json', source: '{"app":"app-build-abc","release":17}\n' }]);

      const use = vi.fn();
      plugin.configureServer?.({ middlewares: { use } } as never);
      const handler = use.mock.calls[0]?.[0] as (request: { method: string; url: string }, response: Record<string, unknown>, next: () => void) => void;
      const headers = new Map<string, unknown>();
      const response = {
        statusCode: 0,
        setHeader: (name: string, value: unknown) => headers.set(name, value),
        end: vi.fn(),
      };
      handler({ method: 'GET', url: '/build.json' }, response, vi.fn());
      expect(response.statusCode).toBe(200);
      expect(headers.get('Content-Type')).toBe('application/json; charset=utf-8');
      expect(headers.get('Cache-Control')).toBe('no-store');
      expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({ app: 'app-build-abc', release: 17 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('snapshots vendored pack revisions only for the selected vendor source', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'astrid-provenance-'));
    const vendorRoot = path.join(directory, 'vendor');
    const alternate = path.join(directory, 'alternate');
    const manifestPath = path.join(directory, 'manifest.json');
    const provenancePath = path.join(vendorRoot, 'provenance.json');
    mkdirSync(vendorRoot);
    mkdirSync(alternate);
    mkdirSync(path.join(vendorRoot, 'astrid/tools'), { recursive: true });
    writeFileSync(path.join(vendorRoot, 'astrid/tools/catalog.json'), JSON.stringify({ tools: [{ id: 'video-editor', pack_id: 'video_editing', entry: { host_entry: 'video-editor' }, manifest: { path: 'pack.yaml' } }] }));
    writeFileSync(manifestPath, '{}');
    const commit = 'a'.repeat(40);
    const define = (selectedCheckout: string) => {
      const plugin = createAppBuildPlugin({ appBuild: 'app', manifestPath, selectedCheckout, vendorRoot });
      return plugin.config?.({} as never, { command: 'build', mode: 'production' } as never) as { define: Record<string, string> };
    };
    try {
      expect(define(vendorRoot).define.__ASTRID_EDITOR_PACK_REVISIONS__).toBe('null');
      writeFileSync(provenancePath, 'not json');
      expect(define(vendorRoot).define.__ASTRID_EDITOR_PACK_REVISIONS__).toBe('null');
      writeFileSync(provenancePath, JSON.stringify({ astrid_commit: 'invalid', files: { 'astrid/packs/video_editing/pack.yaml': 'hash' } }));
      expect(define(vendorRoot).define.__ASTRID_EDITOR_PACK_REVISIONS__).toBe('null');
      writeFileSync(provenancePath, JSON.stringify({ astrid_commit: commit, files: {
        'astrid/packs/video_editing/pack.yaml': 'hash',
        'astrid/packs/rendering/pack.yaml': 'hash',
        'LICENSE': 'hash',
      } }));
      expect(define(alternate).define.__ASTRID_EDITOR_PACK_REVISIONS__).toBe('null');
      const snapshot = createAppBuildPlugin({ appBuild: 'app', manifestPath, selectedCheckout: vendorRoot, vendorRoot });
      writeFileSync(provenancePath, '{}');
      const config = snapshot.config?.({} as never, { command: 'build', mode: 'production' } as never) as { define: Record<string, string> };
      expect(JSON.parse(config.define.__ASTRID_EDITOR_PACK_REVISIONS__)).toEqual({ video_editing: commit });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('includes the owners of element modules bundled by the editor', () => {
    const vendorRoot = path.resolve(__dirname, '../../vendor/astrid-browser');
    const { astrid_commit: commit } = JSON.parse(readFileSync(path.join(vendorRoot, 'provenance.json'), 'utf8'));
    expect(resolveEditorPackRevisions(vendorRoot, vendorRoot)).toMatchObject({
      astrid_motion: commit,
      rendering: commit,
      local: commit,
    });
  });

});

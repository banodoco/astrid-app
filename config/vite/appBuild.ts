import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

export type AppBuildInfo = { app: string; release: number };

export function resolveAppBuildInfo({ appBuild, manifest }: { appBuild?: string; manifest: unknown }): AppBuildInfo {
  const app = appBuild?.trim();
  if (!app) throw new Error('App build id must be a non-empty string');
  const rawRelease = typeof manifest === 'object' && manifest !== null ? (manifest as { release?: unknown }).release : undefined;
  if (rawRelease !== undefined && (!Number.isSafeInteger(rawRelease) || (rawRelease as number) < 0)) {
    throw new Error('Served install manifest release must be a non-negative safe integer');
  }
  const release = (rawRelease as number | undefined) ?? 0;
  return { app, release };
}

export function resolveEditorPackRevisions(selectedCheckout?: string, vendorRoot?: string): Record<string, string> | null {
  if (!selectedCheckout || !vendorRoot) return null;
  try {
    if (realpathSync(selectedCheckout) !== realpathSync(vendorRoot)) return null;
    const provenance: unknown = JSON.parse(readFileSync(path.join(vendorRoot, 'provenance.json'), 'utf8'));
    if (!provenance || typeof provenance !== 'object') return null;
    const { astrid_commit: commit, files } = provenance as { astrid_commit?: unknown; files?: unknown };
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)
      || !files || typeof files !== 'object' || Array.isArray(files)) return null;
    const catalog: unknown = JSON.parse(readFileSync(path.join(vendorRoot, 'astrid/tools/catalog.json'), 'utf8'));
    if (!catalog || typeof catalog !== 'object' || !Array.isArray((catalog as { tools?: unknown }).tools)) return null;
    const editors = ((catalog as { tools: Array<{ id?: unknown; pack_id?: unknown; entry?: { host_entry?: unknown }; manifest?: { path?: unknown } }> }).tools)
      .filter((tool) => tool?.id === 'video-editor' && tool.entry?.host_entry === 'video-editor');
    if (editors.length !== 1) return null;
    const { pack_id: packId, manifest } = editors[0];
    if (typeof packId !== 'string' || !/^[a-z][a-z0-9_]*$/.test(packId)
      || typeof manifest?.path !== 'string' || !Object.prototype.hasOwnProperty.call(files, `astrid/packs/${packId}/${manifest.path}`)) return null;
    // The editor eagerly bundles the vendored element modules through the glob
    // in astrid-element-components.tsx. Their owners can differ from the host
    // tool's pack; report only pack paths present in this build's provenance.
    const packIds = new Set([packId]);
    for (const file of Object.keys(files)) {
      if (/\.test\.(?:ts|tsx)$/.test(file)) continue;
      const match = /^astrid\/packs\/([a-z][a-z0-9_]*)\/(?:rendering\/)?elements\/.+\.(?:ts|tsx)$/.exec(file);
      if (match) packIds.add(match[1]);
    }
    return Object.fromEntries([...packIds].map((id) => [id, commit]));
  } catch {
    return null;
  }
}

export function createAppBuildPlugin({ appBuild, manifestPath, selectedCheckout, vendorRoot }: {
  appBuild?: string; manifestPath: string; selectedCheckout?: string; vendorRoot?: string;
}): Plugin {
  let gitBuild = '';
  try { gitBuild = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* Docker build contexts may not include .git. */ }
  const build = appBuild?.trim() || process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || process.env.VITE_APP_BUILD?.trim() || gitBuild || randomUUID();
  const info = resolveAppBuildInfo({ appBuild: build, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) });
  const json = `${JSON.stringify(info)}\n`;
  const editorPackRevisions = resolveEditorPackRevisions(selectedCheckout, vendorRoot);
  const serve = (request: { method?: string; url?: string }, response: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void }, next: () => void) => {
    if (request.method !== 'GET' || new URL(request.url ?? '/', 'http://localhost').pathname !== '/build.json') return next();
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(json);
  };
  return {
    name: 'astrid-app-build-info',
    config: () => ({ define: { __ASTRID_APP_BUILD__: JSON.stringify(info.app), __ASTRID_EDITOR_PACK_REVISIONS__: JSON.stringify(editorPackRevisions) } }),
    configureServer(server) { server.middlewares.use(serve); },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: json });
    },
  };
}


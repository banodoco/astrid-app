import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

export function createAppBuildPlugin({ appBuild, manifestPath }: { appBuild?: string; manifestPath: string }): Plugin {
  let gitBuild = '';
  try { gitBuild = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* Docker build contexts may not include .git. */ }
  const build = appBuild?.trim() || process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || process.env.VITE_APP_BUILD?.trim() || gitBuild || randomUUID();
  const info = resolveAppBuildInfo({ appBuild: build, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) });
  const json = `${JSON.stringify(info)}\n`;
  const serve = (request: { method?: string; url?: string }, response: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void }, next: () => void) => {
    if (request.method !== 'GET' || new URL(request.url ?? '/', 'http://localhost').pathname !== '/build.json') return next();
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(json);
  };
  return {
    name: 'astrid-app-build-info',
    config: () => ({ define: { __ASTRID_APP_BUILD__: JSON.stringify(info.app) } }),
    configureServer(server) { server.middlewares.use(serve); },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: json });
    },
  };
}


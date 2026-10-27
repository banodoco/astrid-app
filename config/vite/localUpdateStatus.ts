import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';

const execFileAsync = promisify(execFile);
const STATUS_PATH = '/__astrid/local-update-status';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function validLocalStatusRequest(method: string | undefined, url: string | undefined, host: string | undefined, origin: string | undefined, fetchSite: string | undefined, contentLength: string | undefined, transferEncoding: string | undefined, contentType: string | undefined, accept: string | undefined, port: number): boolean {
  if (method !== 'POST' || url !== STATUS_PATH || !host || !origin || (fetchSite && fetchSite !== 'same-origin') || (contentLength && contentLength !== '0') || transferEncoding || contentType !== 'application/json' || accept !== 'application/json') return false;
  let parsedOrigin: URL;
  try { parsedOrigin = new URL(origin); } catch { return false; }
  try {
    const parsedHost = new URL(`http://${host}`);
    return host === parsedHost.host && parsedHost.username === '' && parsedHost.password === '' && parsedHost.pathname === '/' && parsedHost.search === '' && parsedHost.hash === ''
      && LOOPBACK.has(parsedHost.hostname) && parsedHost.port === String(port)
      && parsedOrigin.origin === `http://${parsedHost.host}` && parsedOrigin.username === '' && parsedOrigin.password === '';
  } catch { return false; }
}

function readManifest(raw: string): { release: number; requiredRelease?: number; requiredReason?: string } {
  const manifest = JSON.parse(raw) as { release?: unknown; required?: { release?: unknown; reason?: unknown } };
  const value = manifest.release === undefined ? 0 : manifest.release;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Local install manifest has no valid release');
  const requiredRelease = manifest.required?.release;
  if (requiredRelease !== undefined && (!Number.isSafeInteger(requiredRelease) || (requiredRelease as number) < 0 || typeof manifest.required?.reason !== 'string' || !manifest.required.reason)) {
    throw new Error('Local install manifest required update was invalid');
  }
  return { release: value as number, ...(requiredRelease === undefined ? {} : { requiredRelease: requiredRelease as number, requiredReason: manifest.required?.reason as string }) };
}

export function localUpdateBehind(servedRelease: number, checkoutRelease: number, servedAppIsAncestor: boolean): boolean {
  return servedRelease > checkoutRelease || !servedAppIsAncestor;
}

async function boundedJson(url: string): Promise<{ app: string; release: number }> {
  const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Astrid update check returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > 16_384) throw new Error('Astrid update status response was too large');
  let text: string;
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 16_384) {
        await reader.cancel();
        throw new Error('Astrid update status response was too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > 16_384) throw new Error('Astrid update status response was too large');
  }
  const body = JSON.parse(text) as { app?: unknown; release?: unknown };
  if (typeof body.app !== 'string' || !/^[0-9a-f]{40}$/i.test(body.app) || !Number.isSafeInteger(body.release) || (body.release as number) < 0) throw new Error('Astrid update status response was invalid');
  return { app: body.app, release: body.release as number };
}

export function createLocalUpdateStatusPlugin({ manifestPath }: { manifestPath: string }): Plugin {
  const enabled = process.env.ASTRID_LOCAL_UPDATE_STATUS === '1';
  return {
    name: 'astrid-local-update-status',
    configurePreviewServer(server) {
      if (!enabled) return;
      server.middlewares.use((request, response, next) => {
        if ((request.url ?? '').split('?')[0] !== STATUS_PATH) return next();
        response.statusCode = 501;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ error: 'local_update_status_unsupported_in_preview', message: 'Local update status is available only from npm run dev:local.' }));
      });
    },
    configureServer(server) {
      if (!enabled) return;
      server.middlewares.use(async (request, response, next) => {
        if ((request.url ?? '').split('?')[0] !== STATUS_PATH) return next();
        if (!validLocalStatusRequest(request.method, request.url, request.headers.host, request.headers.origin, request.headers['sec-fetch-site'], request.headers['content-length'], request.headers['transfer-encoding'], request.headers['content-type'], request.headers.accept, server.config.server.port ?? 5173)) {
          response.statusCode = 403;
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify({ error: 'request_refused' }));
          return;
        }
        try {
          const served = await boundedJson('https://astrid.haus/build.json');
          const manifest = readManifest(await readFile(manifestPath, 'utf8'));
          const { stdout: localHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: server.config.root, timeout: 2000, maxBuffer: 1024 });
          const ancestry = await execFileAsync('git', ['merge-base', '--is-ancestor', served.app, 'HEAD'], { cwd: server.config.root, timeout: 2000, maxBuffer: 1024 }).then(() => true, () => false);
          const body = JSON.stringify({ app: localHead.trim(), ...manifest, servedApp: served.app, servedRelease: served.release, behind: localUpdateBehind(served.release, manifest.release, ancestry) });
          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader('Content-Length', Buffer.byteLength(body));
          response.end(body);
        } catch (error) {
          response.statusCode = 503;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'update_status_unavailable' }));
        }
      });
    },
  };
}

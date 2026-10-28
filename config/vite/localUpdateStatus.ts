import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';

const execFileAsync = promisify(execFile);
const STATUS_PATH = '/__astrid/local-update-status';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function validLocalStatusRequest(method: string | undefined, url: string | undefined, host: string | undefined, origin: string | undefined, fetchSite: string | undefined, contentLength: string | undefined, transferEncoding: string | undefined, contentType: string | undefined, accept: string | undefined, port: number, expectedPath = STATUS_PATH): boolean {
  if (method !== 'POST' || url !== expectedPath || !host || !origin || (fetchSite && fetchSite !== 'same-origin') || (contentLength && contentLength !== '0') || transferEncoding || contentType !== 'application/json' || accept !== 'application/json') return false;
  let parsedOrigin: URL;
  try { parsedOrigin = new URL(origin); } catch { return false; }
  try {
    const parsedHost = new URL(`http://${host}`);
    return host === parsedHost.host && parsedHost.username === '' && parsedHost.password === '' && parsedHost.pathname === '/' && parsedHost.search === '' && parsedHost.hash === ''
      && LOOPBACK.has(parsedHost.hostname) && parsedHost.port === String(port)
      && parsedOrigin.origin === `http://${parsedHost.host}` && parsedOrigin.username === '' && parsedOrigin.password === '';
  } catch { return false; }
}

function readLocalRelease(raw: string): number {
  const manifest = JSON.parse(raw) as { release?: unknown };
  const value = manifest.release === undefined ? 0 : manifest.release;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Local install manifest has no valid release');
  return value as number;
}

// The required update is published on astrid.haus, not in the checkout: a checkout pinned with --require
// carries required.release <= its own release, so only the served manifest can require an update.
function servedRequirement(raw: unknown, servedRelease: number): { requiredRelease?: number; requiredReason?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Astrid install manifest response was invalid');
  const manifest = raw as { release?: unknown; required?: unknown };
  const release = manifest.release === undefined ? 0 : manifest.release;
  if (release !== servedRelease) throw new Error('Astrid install manifest release does not match build.json');
  if (manifest.required === undefined) return {};
  if (!manifest.required || typeof manifest.required !== 'object' || Array.isArray(manifest.required)) throw new Error('Astrid install manifest required update was invalid');
  const required = manifest.required as { release?: unknown; reason?: unknown };
  if (!Number.isSafeInteger(required.release) || (required.release as number) < 0 || typeof required.reason !== 'string' || !required.reason) {
    throw new Error('Astrid install manifest required update was invalid');
  }
  return { requiredRelease: required.release as number, requiredReason: required.reason };
}

export function localUpdateBehind(servedRelease: number, checkoutRelease: number, servedAppIsAncestor: boolean): boolean {
  return servedRelease > checkoutRelease || !servedAppIsAncestor;
}

async function boundedJsonBody(url: string): Promise<unknown> {
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
  return JSON.parse(text) as unknown;
}

async function boundedJson(url: string): Promise<{ app: string; release: number }> {
  const body = await boundedJsonBody(url) as { app?: unknown; release?: unknown };
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
          const requirement = servedRequirement(await boundedJsonBody('https://astrid.haus/install-manifest.json'), served.release);
          const release = readLocalRelease(await readFile(manifestPath, 'utf8'));
          const { stdout: localHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: server.config.root, timeout: 2000, maxBuffer: 1024 });
          const ancestry = await execFileAsync('git', ['merge-base', '--is-ancestor', served.app, 'HEAD'], { cwd: server.config.root, timeout: 2000, maxBuffer: 1024 }).then(() => true, () => false);
          const body = JSON.stringify({ app: localHead.trim(), release, ...requirement, servedApp: served.app, servedRelease: served.release, behind: localUpdateBehind(served.release, release, ancestry) });
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

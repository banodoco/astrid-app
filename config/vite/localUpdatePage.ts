import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';
import { LOCAL_UPDATE_RECEIPT } from '../../scripts/local-update-control.mjs';
import { validLocalStatusRequest } from './localUpdateStatus.ts';

const execFileAsync = promisify(execFile);
export const PAGE_ENDPOINT_PATH = '/__astrid/local-update-page';

export interface LocalUpdatePageTarget { readonly url: string; readonly token: string }

/** Read-only view of the 0600 launcher receipt. Returns only the page url and token, and only for this editor's origin. */
export function readPageTarget(raw: string, requestOrigin: string): LocalUpdatePageTarget {
  const receipt = JSON.parse(raw) as { origin?: unknown; page?: { url?: unknown; token?: unknown } };
  const page = receipt.page;
  if (receipt.origin !== requestOrigin || !page || typeof page.url !== 'string' || typeof page.token !== 'string') throw new Error('page_update_unavailable');
  let parsed: URL;
  try { parsed = new URL(page.url); } catch { throw new Error('page_update_unavailable'); }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/page-update' || parsed.search || parsed.hash || parsed.username || parsed.password
      || !/^[0-9a-f]{64}$/.test(page.token)) throw new Error('page_update_unavailable');
  return { url: page.url, token: page.token };
}

export function createLocalUpdatePagePlugin(): Plugin {
  const enabled = process.env.ASTRID_LOCAL_UPDATE_STATUS === '1';
  return {
    name: 'astrid-local-update-page',
    configureServer(server) {
      if (!enabled) return;
      server.middlewares.use(async (request, response, next) => {
        if ((request.url ?? '').split('?')[0] !== PAGE_ENDPOINT_PATH) return next();
        response.setHeader('Cache-Control', 'no-store');
        if (!validLocalStatusRequest(request.method, request.url, request.headers.host, request.headers.origin, request.headers['sec-fetch-site'], request.headers['content-length'], request.headers['transfer-encoding'], request.headers['content-type'], request.headers.accept, server.config.server.port ?? 5173, PAGE_ENDPOINT_PATH)) {
          response.statusCode = 403;
          response.end(JSON.stringify({ error: 'request_refused' }));
          return;
        }
        try {
          const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', LOCAL_UPDATE_RECEIPT], { cwd: server.config.root, timeout: 2000, maxBuffer: 4096 });
          const target = readPageTarget(await readFile(path.resolve(server.config.root, stdout.trim()), 'utf8'), request.headers.origin as string);
          response.statusCode = 200;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify(target));
        } catch {
          response.statusCode = 503;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: 'page_update_unavailable' }));
        }
      });
    },
  };
}

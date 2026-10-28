import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalUpdatePagePlugin, PAGE_ENDPOINT_PATH, readPageTarget } from './localUpdatePage.ts';
import { validLocalStatusRequest } from './localUpdateStatus.ts';

const tempDirs: string[] = [];
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const ORIGIN = 'http://127.0.0.1:4317';
const TOKEN = 'ab'.repeat(32);
const RECEIPT = { format: 'astrid-local-update/v1', pid: 1, url: 'http://127.0.0.1:5000/update', origin: ORIGIN, token: 'cli-secret', page: { url: 'http://127.0.0.1:5000/page-update', token: TOKEN } };

describe('local update page endpoint', () => {
  it('shares the status route request rules on its own path', () => {
    const rest = ['127.0.0.1:4317', ORIGIN, 'same-origin', '0', undefined, 'application/json', 'application/json', 4317] as const;
    expect(validLocalStatusRequest('POST', '/__astrid/local-update-page', ...rest, PAGE_ENDPOINT_PATH)).toBe(true);
    expect(validLocalStatusRequest('POST', '/__astrid/local-update-status', ...rest, PAGE_ENDPOINT_PATH)).toBe(false);
    expect(validLocalStatusRequest('GET', '/__astrid/local-update-page', ...rest, PAGE_ENDPOINT_PATH)).toBe(false);
    expect(validLocalStatusRequest('POST', '/__astrid/local-update-page', rest[0], 'http://evil.test', ...rest.slice(2), PAGE_ENDPOINT_PATH)).toBe(false);
    expect(validLocalStatusRequest('POST', '/__astrid/local-update-page', rest[0], rest[1], 'cross-site', ...rest.slice(3), PAGE_ENDPOINT_PATH)).toBe(false);
  });

  it('returns only url and token, never the CLI secret, and only to the receipt origin', () => {
    expect(readPageTarget(JSON.stringify(RECEIPT), ORIGIN)).toEqual({ url: RECEIPT.page.url, token: TOKEN });
    expect(() => readPageTarget(JSON.stringify(RECEIPT), 'http://127.0.0.1:9999')).toThrow();
    expect(() => readPageTarget(JSON.stringify({ ...RECEIPT, page: undefined }), ORIGIN)).toThrow();
    expect(() => readPageTarget(JSON.stringify({ ...RECEIPT, page: { url: 'http://evil.test/page-update', token: TOKEN } }), ORIGIN)).toThrow();
    expect(() => readPageTarget(JSON.stringify({ ...RECEIPT, page: { url: RECEIPT.page.url, token: 'short' } }), ORIGIN)).toThrow();
  });

  it('serves the receipt page entry from the checkout git dir without writing it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astrid-local-page-'));
    tempDirs.push(dir);
    const checkout = path.join(dir, 'checkout');
    await mkdir(checkout);
    execFileSync('git', ['init', '-q', '-b', 'main', checkout]);
    const receiptPath = path.join(checkout, '.git', 'astrid-local-update.json');
    await writeFile(receiptPath, JSON.stringify(RECEIPT), { mode: 0o600 });
    const original = process.env.ASTRID_LOCAL_UPDATE_STATUS;
    process.env.ASTRID_LOCAL_UPDATE_STATUS = '1';
    try {
      const plugin = createLocalUpdatePagePlugin();
      let middleware!: (request: unknown, response: unknown, next: () => void) => Promise<void>;
      plugin.configureServer?.({ config: { root: checkout, server: { port: 4317 } }, middlewares: { use: (h: typeof middleware) => { middleware = h; } } } as never);
      const call = async (headers: Record<string, string>) => {
        const out: Record<string, string> = {};
        const response = { statusCode: 0, body: '', setHeader: (n: string, v: string) => { out[n.toLowerCase()] = v; }, end: (b: string) => { response.body = b; } };
        await middleware({ method: 'POST', url: '/__astrid/local-update-page', headers: { host: '127.0.0.1:4317', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-length': '0', 'content-type': 'application/json', accept: 'application/json', ...headers } }, response, () => { throw new Error('pass-through'); });
        return { response, out };
      };
      const ok = await call({});
      expect(ok.response.statusCode).toBe(200);
      expect(ok.out['cache-control']).toBe('no-store');
      expect(JSON.parse(ok.response.body)).toEqual({ url: RECEIPT.page.url, token: TOKEN });
      expect(ok.response.body).not.toContain('cli-secret');
      expect((await call({ origin: 'http://evil.test' })).response.statusCode).toBe(403);
      expect((await call({ 'sec-fetch-site': 'cross-site' })).response.statusCode).toBe(403);
      await rm(receiptPath);
      const missing = await call({});
      expect(missing.response.statusCode).toBe(503);
      expect(missing.response.body).not.toContain(TOKEN);
    } finally {
      if (original === undefined) delete process.env.ASTRID_LOCAL_UPDATE_STATUS; else process.env.ASTRID_LOCAL_UPDATE_STATUS = original;
    }
  });
});

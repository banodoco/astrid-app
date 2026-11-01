import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalUpdateStatusPlugin, localUpdateBehind, validLocalStatusRequest } from './localUpdateStatus.ts';

const tempDirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('local update status endpoint boundary', () => {
  it('accepts only an empty same-origin request to its exact loopback endpoint', () => {
    const valid = (...overrides: Parameters<typeof validLocalStatusRequest>) => validLocalStatusRequest(...overrides);
    const base = ['POST', '/__astrid/local-update-status', '127.0.0.1:4317', 'http://127.0.0.1:4317', 'same-origin', '0', undefined, 'application/json', 'application/json', 4317] as const;
    expect(valid(...base)).toBe(true);
    expect(valid('GET', ...base.slice(1))).toBe(false);
    expect(valid('POST', '/__astrid/local-update-status?x=1', ...base.slice(2))).toBe(false);
    expect(valid('POST', base[1], base[2], 'https://127.0.0.1:4317', ...base.slice(4))).toBe(false);
    expect(valid('POST', base[1], base[2], 'http://127.0.0.1:4318', ...base.slice(4))).toBe(false);
    expect(valid('POST', base[1], 'example.test:4317', 'http://example.test:4317', ...base.slice(4))).toBe(false);
    expect(valid('POST', base[1], 'user@127.0.0.1:4317', base[3], ...base.slice(4))).toBe(false);
    expect(valid('POST', base[1], base[2], base[3], 'cross-site', ...base.slice(5))).toBe(false);
    expect(valid('POST', base[1], base[2], base[3], base[4], '1', ...base.slice(6))).toBe(false);
    expect(valid('POST', base[1], base[2], base[3], base[4], base[5], 'chunked', ...base.slice(7))).toBe(false);
    expect(valid('POST', base[1], base[2], base[3], base[4], base[5], undefined, 'text/plain', base[8], base[9])).toBe(false);
  });

  it('reports backend release and App ancestry independently', () => {
    expect(localUpdateBehind(5, 4, true)).toBe(true);
    expect(localUpdateBehind(4, 4, true)).toBe(false);
    expect(localUpdateBehind(3, 4, false)).toBe(true);
    expect(localUpdateBehind(3, 4, true)).toBe(false);
  });

  it('reads required update from the served manifest and release from the local manifest', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astrid-local-update-'));
    tempDirs.push(dir);
    const checkout = path.join(dir, 'checkout');
    await mkdir(checkout);
    execFileSync('git', ['init', '-q', '-b', 'main', checkout]);
    execFileSync('git', ['-C', checkout, 'config', 'user.name', 'Update test']);
    execFileSync('git', ['-C', checkout, 'config', 'user.email', 'update-test@example.test']);
    await writeFile(path.join(checkout, 'tracked.txt'), 'local checkout');
    execFileSync('git', ['-C', checkout, 'add', 'tracked.txt']);
    execFileSync('git', ['-C', checkout, 'commit', '-qm', 'fixture']);
    const localHead = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const manifestPath = path.join(dir, 'install-manifest.json');
    await writeFile(manifestPath, JSON.stringify({ release: 3 }));
    const originalFlag = process.env.ASTRID_LOCAL_UPDATE_STATUS;
    process.env.ASTRID_LOCAL_UPDATE_STATUS = '1';
    const plugin = createLocalUpdateStatusPlugin({ manifestPath });
    let middleware!: (request: unknown, response: unknown, next: () => void) => Promise<void>;
    const server = { config: { root: checkout, server: { port: 4317 } }, middlewares: { use: (handler: typeof middleware) => { middleware = handler; } } };
    plugin.configureServer?.(server as never);
    const request = { method: 'POST', url: '/__astrid/local-update-status', headers: {
      host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'sec-fetch-site': 'same-origin', 'content-length': '0', 'content-type': 'application/json', accept: 'application/json',
    } };
    const run = async () => {
      const headers: Record<string, string> = {};
      const response = { statusCode: 0, setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; }, end: (body: string) => { (response as { body?: string }).body = body; }, body: '' };
      await middleware(request, response, () => { throw new Error('Unexpected middleware pass-through'); });
      return { response, headers, body: JSON.parse(response.body) as Record<string, unknown> };
    };
    try {
      const servedFetch = (app: string) => vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === 'https://astrid.haus/build.json') return new Response(JSON.stringify({ app, release: 5 }), { status: 200 });
        if (url === 'https://astrid.haus/install-manifest.json') return new Response(JSON.stringify({ release: 5, required: { release: 5, reason: 'Security fix' } }), { status: 200 });
        throw new Error(`Unexpected fetch ${url}`);
      });
      vi.stubGlobal('fetch', servedFetch(localHead));
      const ancestor = await run();
      expect(ancestor.response.statusCode).toBe(200);
      expect(ancestor.body).toMatchObject({ app: localHead, release: 3, servedApp: localHead, servedRelease: 5, behind: true, requiredRelease: 5, requiredReason: 'Security fix' });
      vi.stubGlobal('fetch', servedFetch('0000000000000000000000000000000000000000'));
      const notAncestor = await run();
      expect(notAncestor.body).toMatchObject({ behind: true, requiredRelease: 5 });
    } finally {
      if (originalFlag === undefined) delete process.env.ASTRID_LOCAL_UPDATE_STATUS;
      else process.env.ASTRID_LOCAL_UPDATE_STATUS = originalFlag;
    }
  });

  it('degrades safely with a stable diagnostic stage for each status lookup failure', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astrid-local-update-failure-'));
    tempDirs.push(dir);
    const checkout = path.join(dir, 'not-a-git-checkout');
    await mkdir(checkout);
    const manifestPath = path.join(dir, 'install-manifest.json');
    await writeFile(manifestPath, JSON.stringify({ release: 3 }));
    const originalFlag = process.env.ASTRID_LOCAL_UPDATE_STATUS;
    process.env.ASTRID_LOCAL_UPDATE_STATUS = '1';
    const plugin = createLocalUpdateStatusPlugin({ manifestPath });
    let middleware!: (request: unknown, response: unknown, next: () => void) => Promise<void>;
    const server = { config: { root: checkout, server: { port: 4317 } }, middlewares: { use: (handler: typeof middleware) => { middleware = handler; } } };
    plugin.configureServer?.(server as never);
    const request = { method: 'POST', url: '/__astrid/local-update-status', headers: {
      host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'sec-fetch-site': 'same-origin', 'content-length': '0', 'content-type': 'application/json', accept: 'application/json',
    } };
    const run = async () => {
      const headers: Record<string, string | number> = {};
      const response = { statusCode: 0, setHeader: (name: string, value: string | number) => { headers[name.toLowerCase()] = value; }, end: (body: string) => { (response as { body?: string }).body = body; }, body: '' };
      await middleware(request, response, () => { throw new Error('Unexpected middleware pass-through'); });
      return { response, headers, rawBody: response.body, body: JSON.parse(response.body) as Record<string, unknown> };
    };
    const unavailable = (stage: string) => expect.objectContaining({
      response: expect.objectContaining({ statusCode: 503 }),
      headers: expect.objectContaining({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }),
      body: { error: 'local_update_status_unavailable', stage },
    });
    try {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline token=very-secret-token'); }));
      const offline = await run();
      expect(offline).toEqual(unavailable('upstream_fetch'));
      expect(offline.rawBody).not.toContain('very-secret-token');

      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ app: 'not-a-commit', release: 3 }), { status: 200 })));
      expect(await run()).toEqual(unavailable('served_manifest_validation'));

      vi.stubGlobal('fetch', vi.fn(async (input: unknown) => new Response(JSON.stringify(
        String(input) === 'https://astrid.haus/build.json'
          ? { app: '0000000000000000000000000000000000000000', release: 3 }
          : { release: 3 },
      ), { status: 200 })));
      const localGit = await run();
      expect(localGit).toEqual(unavailable('local_git_ancestry_lookup'));
      expect(localGit.rawBody).not.toContain(checkout);
    } finally {
      if (originalFlag === undefined) delete process.env.ASTRID_LOCAL_UPDATE_STATUS;
      else process.env.ASTRID_LOCAL_UPDATE_STATUS = originalFlag;
    }
  });

});

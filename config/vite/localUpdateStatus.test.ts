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

  it('reads release from the local manifest and checks served App ancestry against local HEAD', async () => {
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
    await writeFile(manifestPath, JSON.stringify({ release: 4, required: { release: 5, reason: 'Security fix' } }));
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
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ app: localHead, release: 4 }), { status: 200 })));
      const ancestor = await run();
      expect(ancestor.response.statusCode).toBe(200);
      expect(ancestor.body).toMatchObject({ app: localHead, release: 4, servedApp: localHead, servedRelease: 4, behind: false, requiredRelease: 5, requiredReason: 'Security fix' });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ app: '0000000000000000000000000000000000000000', release: 3 }), { status: 200 })));
      const notAncestor = await run();
      expect(notAncestor.body.behind).toBe(true);
    } finally {
      if (originalFlag === undefined) delete process.env.ASTRID_LOCAL_UPDATE_STATUS;
      else process.env.ASTRID_LOCAL_UPDATE_STATUS = originalFlag;
    }
  });

});

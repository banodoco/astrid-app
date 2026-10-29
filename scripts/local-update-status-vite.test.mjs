import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { createLocalUpdateStatusPlugin } from '../config/vite/localUpdateStatus.ts';

const directories = [];
after(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

test('dev-local Vite serves bounded local status and preview mode refuses clearly', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astrid-local-update-vite-'));
  directories.push(directory);
  execFileSync('git', ['init', '-q', '-b', 'main', directory]);
  execFileSync('git', ['-C', directory, 'config', 'user.name', 'Update test']);
  execFileSync('git', ['-C', directory, 'config', 'user.email', 'update-test@example.test']);
  await writeFile(path.join(directory, 'tracked.txt'), 'local');
  execFileSync('git', ['-C', directory, 'add', 'tracked.txt']);
  execFileSync('git', ['-C', directory, 'commit', '-qm', 'fixture']);
  const head = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const manifestPath = path.join(directory, 'install-manifest.json');
  await writeFile(manifestPath, JSON.stringify({ release: 7 }));
  const originalFlag = process.env.ASTRID_LOCAL_UPDATE_STATUS;
  const originalFetch = globalThis.fetch;
  process.env.ASTRID_LOCAL_UPDATE_STATUS = '1';
  const plugin = createLocalUpdateStatusPlugin({ manifestPath });
  const server = await createServer({ configFile: false, root: directory, server: { host: '127.0.0.1', port: 0 }, plugins: [plugin] });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert(address && typeof address !== 'string', 'Vite did not listen on TCP');
    const origin = `http://127.0.0.1:${address.port}`;
    const served = { 'https://astrid.haus/build.json': { app: head, release: 7 }, 'https://astrid.haus/install-manifest.json': { release: 7 } };
    globalThis.fetch = (input, init) => Object.hasOwn(served, String(input))
      ? Promise.resolve(new Response(JSON.stringify(served[String(input)]), { status: 200 }))
      : originalFetch(input, init);
    const response = await originalFetch(`${origin}/__astrid/local-update-status`, {
      method: 'POST', body: '', headers: { Origin: origin, Accept: 'application/json', 'Content-Type': 'application/json' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { app: head, release: 7, servedApp: head, servedRelease: 7, behind: false });
  } finally {
    await server.close();
    globalThis.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env.ASTRID_LOCAL_UPDATE_STATUS;
    else process.env.ASTRID_LOCAL_UPDATE_STATUS = originalFlag;
  }

  process.env.ASTRID_LOCAL_UPDATE_STATUS = '1';
  const previewPlugin = createLocalUpdateStatusPlugin({ manifestPath });
  if (originalFlag === undefined) delete process.env.ASTRID_LOCAL_UPDATE_STATUS;
  else process.env.ASTRID_LOCAL_UPDATE_STATUS = originalFlag;
  let middleware;
  previewPlugin.configurePreviewServer({ middlewares: { use: (handler) => { middleware = handler; } } });
  const headers = {};
  const response = { statusCode: 0, body: '', setHeader: (name, value) => { headers[name] = value; }, end: (body) => { response.body = body; } };
  middleware({ url: '/__astrid/local-update-status' }, response, () => assert.fail('Preview must not pass through status requests'));
  assert.equal(response.statusCode, 501);
  assert.deepEqual(JSON.parse(response.body), {
    error: 'local_update_status_unsupported_in_preview',
    message: 'Local update status is available only from npm run dev:local.',
  });
  assert.equal(headers['Cache-Control'], 'no-store');
});

test('the repository Vite config used by dev-local registers the bounded local status endpoint', async () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const manifestPath = path.join(repoRoot, 'public/install-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = socket.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve) => socket.close(resolve));

  const envKeys = ['ASTRID_LOCAL_UPDATE_STATUS', 'VITE_ASTRID_LOCAL_UPDATE_STATUS', 'PORT'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, { ASTRID_LOCAL_UPDATE_STATUS: '1', VITE_ASTRID_LOCAL_UPDATE_STATUS: '1', PORT: String(port) });
  const server = await createServer({ configFile: path.join(repoRoot, 'config/vite/vite.config.ts'), configLoader: 'runner', root: repoRoot, cacheDir: path.join(tmpdir(), 'astrid-local-update-vite-cache'), optimizeDeps: { noDiscovery: true, entries: [] }, server: { host: '127.0.0.1', port } });
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${port}`;
    const served = { 'https://astrid.haus/build.json': { app: head, release: manifest.release ?? 0 }, 'https://astrid.haus/install-manifest.json': { release: manifest.release ?? 0 } };
    globalThis.fetch = (input, init) => Object.hasOwn(served, String(input))
      ? Promise.resolve(new Response(JSON.stringify(served[String(input)]), { status: 200 }))
      : originalFetch(input, init);
    const response = await originalFetch(`${origin}/__astrid/local-update-status`, {
      method: 'POST', body: '', headers: { Origin: origin, Accept: 'application/json', 'Content-Type': 'application/json' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { app: head, release: manifest.release ?? 0, servedApp: head, servedRelease: manifest.release ?? 0, behind: false });
  } finally {
    await server.close();
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

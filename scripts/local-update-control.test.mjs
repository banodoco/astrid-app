import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { controlReceiptPath, requestLocalUpdate, startLocalUpdateControl } from './local-update-control.mjs';

const execFileAsync = promisify(execFile);
async function gitRepo() {
  const cwd = await mkdtemp(join(tmpdir(), 'astrid-control-test-'));
  await execFileAsync('git', ['init', cwd]);
  return { cwd, close: () => rm(cwd, { recursive: true, force: true }) };
}
const actualRequest = ({ url, headers, body }) => new Promise((resolve, reject) => {
  const address = new URL(url);
  const request = httpRequest({ hostname: address.hostname, port: address.port, path: address.pathname, method: 'POST', headers }, (response) => {
    let raw = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { raw += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(raw) }));
  });
  request.on('error', reject);
  request.end(body);
});
const rawRequest = (receipt, overrides = {}, requestId = '0123456789abcdef0123456789abcdef') => actualRequest({
  url: receipt.url,
  headers: {
    Host: new URL(receipt.url).host,
    Origin: receipt.origin,
    Authorization: `Bearer ${receipt.token}`,
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(JSON.stringify({ requestId }))),
    ...overrides,
  },
  body: JSON.stringify({ requestId }),
});

test('control binds a loopback ephemeral port, writes a private receipt, validates origin/host/secret, and cleans the receipt', async (t) => {
  const repo = await gitRepo(); t.after(repo.close);
  const origin = 'http://127.0.0.1:4173';
  let calls = 0;
  const control = await startLocalUpdateControl({ cwd: repo.cwd, origin, update: async () => { calls += 1; return { status: 'updated' }; } });
  t.after(() => control.close());
  const receiptPath = await controlReceiptPath(repo.cwd);
  const diskReceipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(diskReceipt.token, control.receipt.token);
  assert.equal(diskReceipt.cwd, repo.cwd);
  assert.equal(new URL(diskReceipt.url).hostname, '127.0.0.1');
  assert.ok(Number(new URL(diskReceipt.url).port) > 0);
  if (process.platform !== 'win32') assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);

  const wrongOrigin = await rawRequest(control.receipt, { Origin: 'http://localhost:4173' }, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const wrongHost = await rawRequest(control.receipt, { Host: 'localhost:4173' }, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const wrongSecret = await rawRequest(control.receipt, { Authorization: 'Bearer wrong' }, 'cccccccccccccccccccccccccccccccc');
  assert.deepEqual([wrongOrigin.status, wrongHost.status, wrongSecret.status], [403, 403, 403]);
  assert.equal(calls, 0);

  const accepted = await rawRequest(control.receipt, {}, 'dddddddddddddddddddddddddddddddd');
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, { result: { status: 'updated' } });
  assert.equal(calls, 1);
  await control.close();
  await assert.rejects(readFile(receiptPath), { code: 'ENOENT' });
});

test('control rejects replay and concurrent requests with distinct receipt codes', async (t) => {
  const repo = await gitRepo(); t.after(repo.close);
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const control = await startLocalUpdateControl({ cwd: repo.cwd, origin: 'http://127.0.0.1:4173', update: async () => { calls += 1; enter(); await gate; return 'done'; } });
  t.after(() => control.close());

  const firstPromise = rawRequest(control.receipt, {}, '11111111111111111111111111111111');
  await entered;
  assert.equal(control.busy, true);
  const concurrent = await rawRequest(control.receipt, {}, '22222222222222222222222222222222');
  assert.equal(concurrent.status, 409);
  assert.equal(concurrent.body.code, 'update_busy');
  release();
  const first = await firstPromise;
  assert.equal(first.status, 200);
  assert.equal(calls, 1);
  const replay = await rawRequest(control.receipt, {}, '11111111111111111111111111111111');
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, 'replay');
});

test('start refuses non-exact origins and an already-owned receipt', async (t) => {
  const repo = await gitRepo(); t.after(repo.close);
  await assert.rejects(startLocalUpdateControl({ cwd: repo.cwd, origin: 'http://127.0.0.1:4173/path', update: async () => {} }), /exact editor origin/);
  const control = await startLocalUpdateControl({ cwd: repo.cwd, origin: 'http://127.0.0.1:4173', update: async () => {} });
  t.after(() => control.close());
  await assert.rejects(startLocalUpdateControl({ cwd: repo.cwd, origin: 'http://127.0.0.1:4173', update: async () => {} }), /still running/);
});

test('CLI request reads the receipt and sends a fresh authenticated request', async (t) => {
  const repo = await gitRepo(); t.after(repo.close);
  const control = await startLocalUpdateControl({ cwd: repo.cwd, origin: 'http://127.0.0.1:4173', update: async () => ({ ok: true }) });
  t.after(() => control.close());
  assert.deepEqual(await requestLocalUpdate({ cwd: repo.cwd }), { ok: true });
  let captured;
  const result = await requestLocalUpdate({ cwd: repo.cwd, request: async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, json: async () => ({ result: { ok: true } }) };
  } });
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.url, control.receipt.url);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.options.headers.Origin, control.receipt.origin);
  assert.equal(captured.options.headers.Authorization, `Bearer ${control.receipt.token}`);
  assert.match(captured.options.headers['Content-Length'], /^\d+$/);
  assert.match(JSON.parse(captured.options.body).requestId, /^[0-9a-f]{32}$/);
});

test('CLI request reports a clear connect-launcher error when no receipt exists', async (t) => {
  const repo = await gitRepo(); t.after(repo.close);
  await assert.rejects(requestLocalUpdate({ cwd: repo.cwd }), (error) => error.step === 'connect-launcher' && /Start Astrid/.test(error.message));
});

test('CLI request classifies malformed receipt URLs as a connect-launcher error', async (t) => {
  const repo = await gitRepo(); t.after(repo.close);
  await writeFile(await controlReceiptPath(repo.cwd), JSON.stringify({
    format: 'astrid-local-update/v1', cwd: repo.cwd, url: 'not a URL', origin: 'also not a URL', token: 'bad',
  }));
  await assert.rejects(
    requestLocalUpdate({ cwd: repo.cwd }),
    (error) => error.step === 'connect-launcher' && /receipt is invalid/i.test(error.message),
  );
});

test('C1 busy blockers and stop evidence survive the launcher control channel', async (t) => {
  const repo = await gitRepo(); t.after(repo.close);
  const details = { blockers: [{ task_id: 'task-1', kind: 'render', state: 'running', age_seconds: 17 }] };
  const control = await startLocalUpdateControl({ cwd: repo.cwd, origin: 'http://127.0.0.1:5180', update: async () => {
    throw Object.assign(new Error('Astrid is busy (1 tasks running). task-1 [render; running; 17s]'), {
      step: 'stop-runtime', details, stopRefused: true, stopCompleted: false,
    });
  } });
  t.after(() => control.close());
  await assert.rejects(requestLocalUpdate({ cwd: repo.cwd }), (error) => {
    assert.equal(error.step, 'stop-runtime');
    assert.deepEqual(error.details, details);
    assert.equal(error.stopRefused, true);
    assert.equal(error.stopCompleted, false);
    return true;
  });
});

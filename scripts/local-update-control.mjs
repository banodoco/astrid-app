import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, unlink, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export async function controlReceiptPath(cwd) {
  const { stdout } = await exec('git', ['rev-parse', '--git-path', 'astrid-local-update.json'], { cwd, encoding: 'utf8' });
  return resolve(cwd, stdout.trim());
}
const equalSecret = (left, right) => typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right)
  && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const reply = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
};

/** The running launcher is the only update coordinator. No browser-visible secret. */
export async function startLocalUpdateControl({ cwd, origin, update }) {
  if (new URL(origin).origin !== origin) throw new Error('The local updater requires an exact editor origin');
  const receiptPath = await controlReceiptPath(cwd);
  let previous;
  try { previous = JSON.parse(await readFile(receiptPath, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('The local updater receipt is unreadable; repair it before starting');
  }
  if (previous) {
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('The local updater receipt has an invalid owner');
    try { process.kill(previous.pid, 0); throw new Error('Another local updater launcher is still running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await unlink(receiptPath);
  }
  const token = randomBytes(32).toString('hex');
  let host, busy = false, closing = false, closePromise;
  const consumed = new Set();
  let active;
  const server = createServer(async (request, response) => {
    if (closing || request.method !== 'POST' || request.url !== '/update'
        || request.headers.host !== host || request.headers.origin !== origin
        || !equalSecret(request.headers.authorization, `Bearer ${token}`)
        || request.headers['content-type'] !== 'application/json'
        || request.headers['transfer-encoding'] || !/^\d+$/.test(request.headers['content-length'] ?? '')
        || Number(request.headers['content-length']) > 256) {
      request.resume(); reply(response, 403, { error: 'The local update request was refused', step: 'control-channel', code: 'request_refused' }); return;
    }
    let raw = '';
    try {
      for await (const chunk of request) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 256) throw new Error('Request too large');
      }
      const body = JSON.parse(raw);
      if (!body || Object.keys(body).length !== 1 || !/^[0-9a-f]{32}$/.test(body.requestId ?? '')) throw new Error('Invalid request');
      if (consumed.has(body.requestId) || consumed.size >= 4096) {
        reply(response, 409, { error: 'This update request was already used; retry with a fresh request', step: 'control-channel', code: 'replay' }); return;
      }
      consumed.add(body.requestId);
      if (busy) { reply(response, 409, { error: 'Another Astrid update is already running', step: 'control-channel', code: 'update_busy' }); return; }
      busy = true;
      try {
        active = Promise.resolve().then(update);
        reply(response, 200, { result: await active });
      } catch (error) {
        reply(response, 422, { error: error.message, step: error.step ?? 'update', code: error.code ?? 'update_failed',
          details: error.details, stopRefused: error.stopRefused, stopCompleted: error.stopCompleted });
      } finally { busy = false; active = undefined; }
    } catch {
      if (!response.headersSent) reply(response, 400, { error: 'Invalid update request', step: 'control-channel', code: 'invalid_request' });
    }
  });
  server.requestTimeout = 0; // Preparation may take several minutes; the transaction owns recovery.
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  host = `127.0.0.1:${server.address().port}`;
  const receipt = { format: 'astrid-local-update/v1', pid: process.pid, cwd: resolve(cwd), url: `http://${host}/update`, origin, token };
  try {
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
    await chmod(receiptPath, 0o600);
  } catch (error) { server.close(); throw error; }
  return {
    receipt,
    get busy() { return busy; },
    close() { return closePromise ??= (async () => {
      closing = true;
      await active?.catch(() => {});
      await new Promise((closed) => { server.close(closed); server.closeIdleConnections(); });
      const current = JSON.parse(await readFile(receiptPath, 'utf8').catch(() => '{}'));
      if (current.token === token) await unlink(receiptPath);
    })(); },
  };
}

export async function requestLocalUpdate({ cwd = process.cwd(), request = fetch } = {}) {
  let receipt;
  try { receipt = JSON.parse(await readFile(await controlReceiptPath(cwd), 'utf8')); }
  catch { throw Object.assign(new Error('Start Astrid with npm run dev:local, then run npm run update in this checkout.'), { step: 'connect-launcher' }); }
  let address, configuredOrigin;
  try { address = new URL(receipt.url); configuredOrigin = new URL(receipt.origin).origin; }
  catch { throw Object.assign(new Error('The local update launcher receipt is invalid. Restart Astrid.'), { step: 'connect-launcher' }); }
  if (receipt.format !== 'astrid-local-update/v1' || receipt.cwd !== resolve(cwd)
      || address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port
      || address.pathname !== '/update' || address.search || address.hash || address.username || address.password
      || !/^[0-9a-f]{64}$/.test(receipt.token ?? '') || configuredOrigin !== receipt.origin) {
    throw Object.assign(new Error('The local update launcher receipt is invalid. Restart Astrid.'), { step: 'connect-launcher' });
  }
  const body = JSON.stringify({ requestId: randomBytes(16).toString('hex') });
  const response = await request(receipt.url, { method: 'POST', redirect: 'error', headers: {
    Origin: receipt.origin, Authorization: `Bearer ${receipt.token}`, 'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
  }, body });
  const result = await response.json();
  if (!response.ok || result.error) throw Object.assign(new Error(result.error ?? `Update request failed (HTTP ${response.status})`), {
    step: result.step ?? 'control-channel', code: result.code, details: result.details,
    stopRefused: result.stopRefused, stopCompleted: result.stopCompleted,
  });
  return result.result;
}

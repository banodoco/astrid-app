import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve, join, isAbsolute } from 'node:path';

/** The C2 journal in the backend root, or null when no update has left one. */
export async function readUpdateJournal(root) {
  try { return JSON.parse(await readFile(join(root, 'update-transaction.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

/** No journal, or one whose step is terminal, leaves nothing to recover or clean up. */
export function journalSettled(journal) {
  return !journal || ['complete', 'rolled_back'].includes(journal.step);
}

/** Locate the selected installed backend; source checkouts keep their own update instructions. */
export function installedBackend(command) {
  let python;
  // Venv Python is commonly a symlink to the system interpreter. Its selected
  // path, rather than that interpreter's realpath, identifies the installation.
  try { if (isAbsolute(command)) python = resolve(command); } catch { /* explicit installed Python required */ }
  if (python) {
    let directory = dirname(python);
    while (dirname(directory) !== directory) {
      const marker = join(directory, 'install.json');
      if (existsSync(marker) && existsSync(join(directory, 'current'))) {
        const record = JSON.parse(readFileSync(marker, 'utf8'));
        if (record.owner !== 'haus.astrid.runtime') break;
        const selected = readFileSync(join(directory, 'current'), 'utf8').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(selected)) throw new Error('The installed backend selection is invalid');
        const versionRoot = join(directory, 'versions', selected);
        const version = JSON.parse(readFileSync(join(versionRoot, 'version.json'), 'utf8'));
        if (resolve(version.root) !== versionRoot || !resolve(version.python).startsWith(`${versionRoot}/`) && !resolve(version.python).startsWith(`${versionRoot}\\`)) throw new Error('The selected installed Python is invalid');
        return { root: directory, python: version.python, profile: version.profile, managedBy: record.managed_by };
      }
      directory = dirname(directory);
    }
  }
  throw Object.assign(new Error('This Astrid runs from source checkouts; update those checkouts and restart Astrid before updating the local App. An installed backend is required for npm run update.'), { step: 'select-backend' });
}

/** JSONL callbacks extend C2's transaction; no shell and no separate journal. */
export async function runBackendUpdate({ backend, action, hook, spawnProcess = spawn }) {
  if (action.action === 'recover') {
    let pending;
    try { pending = await readUpdateJournal(backend.root); }
    catch (error) { throw Object.assign(error, { step: 'recover-backend' }); }
    if (journalSettled(pending)) return { status: 'no-recovery' };
  }
  const child = spawnProcess(backend.python, ['-I', '-m', 'astrid.installer.local_update', '--root', backend.root], {
    cwd: backend.root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONPATH: '', PYTHONHOME: '' },
  });
  let result, failure, stderr = '', sequence = Promise.resolve();
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    sequence = sequence.then(async () => {
      let message;
      try { message = JSON.parse(line); } catch { throw new Error('Backend updater returned invalid protocol data'); }
      if (message.hook) {
        try { await hook(message); child.stdin.write(`${JSON.stringify({ id: message.id, ok: true })}\n`); }
        catch (error) { child.stdin.write(`${JSON.stringify({ id: message.id, ok: false, error: `${error.step ?? message.hook}: ${error.message}` })}\n`); }
      } else if (message.error) {
        failure = Object.assign(new Error(message.error), { step: message.step ?? 'backend-transaction', code: message.code,
          details: message.details, stopRefused: message.stop_refused, stopCompleted: message.stop_completed });
      } else if (message.result) result = message.result;
      else throw new Error('Backend updater returned an unknown protocol message');
    }).catch((error) => { failure = error; child.stdin.destroy(); });
  });
  child.stdin.on('error', () => {});
  const closed = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => done({ code, signal }));
  });
  child.stdin.write(`${JSON.stringify(action)}\n`);
  const { code, signal } = await closed;
  await sequence;
  if (failure) throw failure;
  if (code !== 0 || signal || !result) throw Object.assign(new Error(`The backend updater failed: ${stderr.trim() || `exit ${signal ?? code}`}. This backend must include Astrid's local updater. Install the paired local-update release, restart Astrid, then retry npm run update.`), { step: 'backend-transaction' });
  return result;
}

/** Request maintenance from Pinokio's existing authenticated process owner. */
export async function pinokioHandoff(backend, action, body = {}) {
  const receipt = JSON.parse(readFileSync(join(backend.root, 'pinokio-control.json'), 'utf8'));
  // The receipt lives in the selected private program root, never the page.
  if (!Number.isInteger(receipt.port) || receipt.port < 1 || receipt.port > 65535 || typeof receipt.token !== 'string') {
    throw new Error('The Pinokio session controller record is invalid');
  }
  const response = await fetch(`http://127.0.0.1:${receipt.port}/local-update-${action}`, {
    method: 'POST', redirect: 'error', headers: { Host: `127.0.0.1:${receipt.port}`, Authorization: `Bearer ${receipt.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(240_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Pinokio update handoff failed (HTTP ${response.status})`);
  return result;
}

/** The Pinokio session handoff the local updater drives: begin, start a Runtime version, end. */
export function pinokioSession(backend) {
  return {
    begin: () => pinokioHandoff(backend, 'begin'),
    start: (version, operationId) => pinokioHandoff(backend, 'runtime', { version: basename(version.root), operationId }),
    end: () => pinokioHandoff(backend, 'end'),
  };
}

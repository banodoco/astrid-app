#!/usr/bin/env node
/**
 * Launcher for the fake Runtime (`server.ts`). One mechanism: `server.ts` runs as a child process under
 * `node_modules/.bin/tsx --tsconfig tests/e2e/fake-runtime/tsconfig.json` and prints `FAKE_RUNTIME_READY <port>` on stdout once it is bound.
 *
 * Three faces:
 *   fakeRuntimeEnv({ port })   for Playwright configs. Plain config-time work: allocates nothing, starts nothing.
 *                              Idempotent across Playwright's config reloads in worker processes: the first call
 *                              creates the token file and exports FAKE_RUNTIME_TOKEN_FILE / FAKE_RUNTIME_PORT, every
 *                              later call reads that file and never rewrites it.
 *   startFakeRuntime({ port }) for dev:editor and the contract test. Isolated: its own token file, a free port
 *                              by default, and a close() that stops the child and removes the token directory.
 *   node launch.mjs --serve    the Playwright `webServer` command (port and token file from FAKE_RUNTIME_PORT /
 *                              FAKE_RUNTIME_TOKEN_FILE, or --port / --token-file).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAKE_RUNTIME_ACTOR_ID,
  FAKE_RUNTIME_INSTANCE_ID,
  FAKE_RUNTIME_REALM_ID,
} from '../../../src/test/fakeRuntimeIdentity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const TSCONFIG = join(ROOT, 'tests', 'e2e', 'fake-runtime', 'tsconfig.json');
const SERVER = join(ROOT, 'tests', 'e2e', 'fake-runtime', 'server.ts');
export const READY_PREFIX = 'FAKE_RUNTIME_READY';
const READY_TIMEOUT_MS = 30_000;

/** A 0600 token file in a fresh 0700 directory under the OS temp dir, never in the repo. */
export function createTokenFile() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-runtime-'));
  chmodSync(dir, 0o700);
  const tokenFile = join(dir, 'token');
  const token = randomBytes(32).toString('base64url');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  return { dir, tokenFile, token, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The environment the Vite dev server (and so the app) needs to talk to the fake Runtime. The Vite proxies
 * add the bearer token server-side; the browser never sees it. Empty strings are deliberate: they override
 * whatever the developer's shell exports so a leaked value cannot send the run to another branch.
 */
export function buildFakeRuntimeEnv({ port, tokenFile, token }) {
  return {
    VITE_WORKSPACE_RUNTIME_URL: `http://127.0.0.1:${port}`,
    WORKSPACE_RUNTIME_TOKEN_FILE: tokenFile,
    VITE_WORKSPACE_RUNTIME_EXPECTED_ACTOR_ID: FAKE_RUNTIME_ACTOR_ID,
    VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID: FAKE_RUNTIME_REALM_ID,
    VITE_WORKSPACE_RUNTIME_EXPECTED_INSTANCE_ID: FAKE_RUNTIME_INSTANCE_ID,
    // Discovery, tasks, galleries and realtime travel `/api/astrid` on /v1 paths; the chat pane's ACP reads
    // travel `/api/astrid/acp`. One fake serves all of them on one port, behind one token.
    VITE_ASTRID_BRIDGE_PORT: String(port),
    ASTRID_BRIDGE_TOKEN: token,
    VITE_ASTRID_ACP_BRIDGE_PORT: String(port),
    // Without this the ACP hop falls back to a developer's exported ACP token (.env.example) and gets 401.
    ASTRID_ACP_BRIDGE_TOKEN: token,
    // A same-origin, auto-bound Runtime build: no gateway origin (it refuses a compiled identity), no
    // deferred-cloud authority, and the normal app shell.
    VITE_RUNTIME_ORIGIN: '',
    FAKE_RUNTIME_PORT: String(port),
    FAKE_RUNTIME_TOKEN_FILE: tokenFile,
  };
}

/**
 * For Playwright configs, which are loaded again in every worker after the webServers start. The first call
 * generates the token and exports FAKE_RUNTIME_TOKEN_FILE and FAKE_RUNTIME_PORT so workers inherit them;
 * later calls (and a file named by the environment) are read, never rewritten, so the token the running fake
 * and Vite hold is the token every spec reads.
 */
export function fakeRuntimeEnv({ port = Number(process.env.FAKE_RUNTIME_PORT), tokenFile = process.env.FAKE_RUNTIME_TOKEN_FILE } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('fakeRuntimeEnv needs a port (the caller allocates it; FAKE_RUNTIME_PORT is read when it is not passed)');
  }
  let file = tokenFile;
  if (!file || !existsSync(file)) {
    const created = createTokenFile();
    process.once('exit', created.dispose);
    file = created.tokenFile;
  }
  const token = readFileSync(file, 'utf8').trim();
  process.env.FAKE_RUNTIME_TOKEN_FILE = file;
  process.env.FAKE_RUNTIME_PORT = String(port);
  return buildFakeRuntimeEnv({ port, tokenFile: file, token });
}

function spawnServer({ port, tokenFile, stdio }) {
  return spawn(TSX, ['--tsconfig', TSCONFIG, SERVER], {
    cwd: ROOT,
    env: { ...process.env, FAKE_RUNTIME_PORT: String(port), FAKE_RUNTIME_TOKEN_FILE: tokenFile },
    stdio,
  });
}

/** Start an isolated fake on `port` (0 picks a free one). Resolves once it is bound and serving. */
export async function startFakeRuntime({ port = 0 } = {}) {
  const { tokenFile, token, dispose } = createTokenFile();
  const child = spawnServer({ port, tokenFile, stdio: ['ignore', 'pipe', 'inherit'] });
  const boundPort = await new Promise((resolvePort, reject) => {
    let buffered = '';
    let ready = false;
    const timer = setTimeout(() => reject(new Error(`fake Runtime did not report ${READY_PREFIX} within ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (!ready) reject(new Error(`fake Runtime exited before it was ready (code ${code}, signal ${signal})`));
    });
    child.stdout.on('data', (chunk) => {
      if (ready) {
        process.stdout.write(chunk);
        return;
      }
      buffered += chunk.toString('utf8');
      const match = new RegExp(`^${READY_PREFIX} (\\d+)$`, 'm').exec(buffered);
      if (match) {
        ready = true;
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
  }).catch((error) => {
    child.kill('SIGKILL');
    dispose();
    throw error;
  });
  return {
    port: boundPort,
    origin: `http://127.0.0.1:${boundPort}`,
    tokenFile,
    token,
    env: buildFakeRuntimeEnv({ port: boundPort, tokenFile, token }),
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
        child.kill('SIGTERM');
        await exited;
      }
      dispose();
    },
  };
}

// `node launch.mjs --serve [--port <p>] [--token-file <f>]`: the Playwright webServer command.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--serve')) {
  const flag = (name) => {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const port = Number(flag('--port') ?? process.env.FAKE_RUNTIME_PORT);
  const tokenFile = flag('--token-file') ?? process.env.FAKE_RUNTIME_TOKEN_FILE;
  if (!Number.isInteger(port) || port < 1 || !tokenFile || !existsSync(tokenFile)) {
    console.error('[fake-runtime] --serve needs a port and an existing token file (--port/--token-file or FAKE_RUNTIME_PORT/FAKE_RUNTIME_TOKEN_FILE)');
    process.exit(2);
  }
  const child = spawnServer({ port, tokenFile, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  process.on('exit', () => { if (child.exitCode === null) child.kill('SIGKILL'); });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

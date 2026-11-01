import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import type { DirectHarness } from '../../local/support/harness';

export interface PackHostSession {
  stop(): Promise<void>;
}

const REVIEWED_HELPER_COMMIT = 'b70b9d569b2c80885d72734c61cd57e64c3715a8';
const REVIEWED_HELPER_TREE = '687f077c4771e3dbb66bfb7ff2b98f310ac054b6';
const REVIEWED_HELPER_PATH = 'tests/packs/rendering/real_pack_host.py';
const REVIEWED_HELPER_BYTES = 10_938;
const REVIEWED_HELPER_SHA256 = 'sha256:bc75d73f21c6310efad7fc41e4a3d790bfe3a8975e0eb96c08c3dec63e62961b';

function gitRevision(root: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
    }).trim();
  } catch {
    throw new Error('Reviewed Agent pack-host helper must come from its approved committed carrier');
  }
}

function assertCarrierClean(root: string, env: NodeJS.ProcessEnv): void {
  if (gitRevision(root, env, 'status', '--porcelain', '--untracked-files=all')) {
    throw new Error('Reviewed Agent pack-host helper carrier is dirty');
  }
}

async function assertImmutableCarrier(carrierRoot: string): Promise<string> {
  const paths = [carrierRoot, ...REVIEWED_HELPER_PATH.split('/').map((_, index, parts) =>
    join(carrierRoot, ...parts.slice(0, index + 1)))];
  for (const [index, path] of paths.entries()) {
    const info = await lstat(path).catch(() => null);
    const resolved = await realpath(path).catch(() => null);
    const isLeaf = index === paths.length - 1;
    if (!info || info.isSymbolicLink() || !resolved || resolved !== path
      || (isLeaf ? !info.isFile() : !info.isDirectory()) || (info.mode & 0o222) !== 0) {
      throw new Error('Reviewed Agent pack-host helper carrier must be immutable regular files and directories');
    }
  }
  return paths[paths.length - 1];
}

/** Resolve only the reviewed helper blob; normal Agent imports still come from the frozen source root. */
export async function resolveReviewedPackHostHelper(source: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const carrier = env.ASTRID_PACK_HOST_HELPER_CHECKOUT;
  if (!carrier || !isAbsolute(carrier)) {
    throw new Error('Pack-host bootstrap requires frozen absolute ASTRID_PACK_HOST_HELPER_CHECKOUT');
  }
  const carrierRoot = await realpath(carrier).catch(() => null);
  if (!carrierRoot) throw new Error('Reviewed Agent pack-host helper carrier is unavailable');
  const sourceRoot = await realpath(source).catch(() => null);
  if (!sourceRoot) throw new Error('Frozen ASTRID_CHECKOUT is unavailable');
  if (sourceRoot === carrierRoot) throw new Error('Reviewed helper carrier must remain separate from frozen ASTRID_CHECKOUT');
  assertCarrierClean(carrierRoot, env);
  const resolvedHelper = await assertImmutableCarrier(carrierRoot);
  if (relative(carrierRoot, resolvedHelper) !== REVIEWED_HELPER_PATH) {
    throw new Error('Reviewed Agent pack-host helper escaped its approved carrier or is not a regular file');
  }
  const bytes = await readFile(resolvedHelper);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (bytes.byteLength !== REVIEWED_HELPER_BYTES || digest !== REVIEWED_HELPER_SHA256) {
    throw new Error('Reviewed Agent pack-host helper bytes changed');
  }
  if (gitRevision(carrierRoot, env, 'rev-parse', 'HEAD') !== REVIEWED_HELPER_COMMIT
    || gitRevision(carrierRoot, env, 'rev-parse', 'HEAD^{tree}') !== REVIEWED_HELPER_TREE) {
    throw new Error('Reviewed Agent pack-host helper source revision changed');
  }
  return resolvedHelper;
}

interface BootstrapOptions {
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawn;
  signal?: AbortSignal;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
}

const HELPER_ERROR_TYPE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HELPER_ERROR_LOCATION = /^[A-Za-z0-9_./\\-]{1,1024}:\d+$/;

function helperFailureMessage(message: Record<string, unknown>): string {
  const errorType = message.error_type;
  const errorLocation = message.error_location;
  if (typeof errorType === 'string' && HELPER_ERROR_TYPE.test(errorType)
    && typeof errorLocation === 'string' && HELPER_ERROR_LOCATION.test(errorLocation)) {
    return `Pack-host helper reported failure (error_type=${errorType}, error_location=${errorLocation})`;
  }
  return 'Pack-host helper reported failure';
}

/** Requires an owner-approved helper in the parent's frozen ASTRID_CHECKOUT.
 * The Agent owns launch authority and host cleanup, including SIGTERM cleanup.
 * This adapter owns only its direct helper child, never a reported host PID.
 */
export async function startRealPackHost(
  harness: Pick<DirectHarness, 'tmp' | 'realmDir' | 'supportDir' | 'runtimeInstanceId'>,
  checkReady: () => Promise<unknown>,
  options: BootstrapOptions = {},
): Promise<PackHostSession> {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const runtime = env.ASTRID_RUNTIME_CHECKOUT;
  if (!runtime || !isAbsolute(runtime)) throw new Error('Pack-host bootstrap requires frozen absolute ASTRID_RUNTIME_CHECKOUT');
  const source = env.ASTRID_CHECKOUT;
  const python = env.ASTRID_PYTHON;
  if (!source || !isAbsolute(source) || !python || !isAbsolute(python)) {
    throw new Error('Pack-host bootstrap requires frozen absolute ASTRID_CHECKOUT and ASTRID_PYTHON');
  }
  const helper = await resolveReviewedPackHostHelper(source, env);
  if (options.signal?.aborted) throw new Error('Pack-host startup aborted');
  env.PYTHONPATH = [source, runtime, env.PYTHONPATH].filter(Boolean).join(delimiter);
  const startupDeadline = performance.now() + (options.startupTimeoutMs ?? 210_000);
  let child: ChildProcessWithoutNullStreams;
  const finalHelper = await resolveReviewedPackHostHelper(source, env);
  if (finalHelper !== helper) throw new Error('Reviewed Agent pack-host helper changed before spawn');
  try {
    child = (options.spawn ?? spawn)(python, [finalHelper,
      '--realm-dir', harness.realmDir, '--support-dir', harness.supportDir,
      '--discovery-file', join(harness.supportDir, 'discovery.json'),
      '--source-checkout', source, '--runtime-instance-id', harness.runtimeInstanceId,
    ], { cwd: source, env, stdio: 'pipe', detached: false }) as ChildProcessWithoutNullStreams;
  } catch {
    throw new Error('Pack-host helper could not be spawned');
  }

  const stopTimeout = options.stopTimeoutMs ?? 30_000;
  const changed = new Set<() => void>();
  const notify = () => { for (const wake of changed) wake(); };
  let failure: Error | undefined;
  let protocolFailure = false;
  let ready = false;
  let stopped = false;
  let closed = false;
  let exitCode: number | null = null;
  let hostPid: number | undefined;
  let buffer = '';
  let bytes = 0;
  let stopping: Promise<void> | undefined;
  const fail = (message: string, protocol = true) => {
    failure ??= new Error(message);
    protocolFailure ||= protocol;
    notify();
  };
  const aborted = () => fail('Pack-host startup aborted', false);
  options.signal?.addEventListener('abort', aborted, { once: true });
  // Abort could have arrived between the pre-spawn check and listener setup.
  if (options.signal?.aborted) aborted();

  child.on('error', () => fail('Pack-host helper process failed'));
  child.stdin.on('error', () => fail('Pack-host helper input failed'));
  child.stdout.on('error', () => fail('Pack-host helper output failed'));
  child.stderr.on('error', () => fail('Pack-host helper diagnostics failed'));
  child.stderr.resume(); // Drain without retaining or exposing credential-bearing diagnostics.
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 65_536) { fail('Pack-host helper output exceeded limit'); return; }
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        if (Buffer.byteLength(line) > 16_384) throw new Error();
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object') throw new Error();
        const message = value as Record<string, unknown>;
        if (message.status === 'ready' && !ready && !stopped
          && Number.isSafeInteger(message.host_pid) && Number(message.host_pid) > 0
          && message.host_status === 'ready' && Array.isArray(message.host_ready_capabilities)
          && message.host_ready_capabilities.includes('rendering.render')) {
          hostPid = Number(message.host_pid);
          ready = true;
        } else if (message.status === 'stopped' && !stopped && message.host_pid === hostPid && ready) {
          stopped = true;
        } else {
          fail(message.status === 'failed' ? helperFailureMessage(message) : 'Invalid pack-host helper status');
        }
      } catch {
        fail('Malformed pack-host helper output');
      }
      notify();
    }
    if (buffer.length > 16_384) fail('Pack-host helper line exceeded limit');
  });
  child.stdout.on('end', () => {
    if (buffer || !stopped) fail('Pack-host helper output ended before stopped acknowledgement');
  });
  child.once('close', (code: number | null) => {
    closed = true;
    exitCode = code;
    if (!ready) fail('Pack-host helper exited before ready');
    notify();
  });

  function waitUntil(done: () => boolean, deadline: number, label: string, checkFailure = true): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        changed.delete(wake);
        if (error) reject(error); else resolve();
      };
      const wake = () => {
        if (checkFailure && failure) finish(failure);
        else if (performance.now() >= deadline) finish(new Error(label));
        else if (done()) finish();
        else if (checkFailure && closed) finish(new Error('Pack-host helper exited during startup'));
      };
      const timer = setTimeout(() => finish(new Error(label)), Math.max(0, deadline - performance.now()));
      changed.add(wake);
      wake();
    });
  }

  function stop(): Promise<void> {
    stopping ??= (async () => {
      options.signal?.removeEventListener('abort', aborted);
      if (!closed) {
        try { child.stdin.end('stop\n'); } catch { fail('Pack-host helper input failed'); }
        try {
          await waitUntil(() => closed, performance.now() + stopTimeout, 'Pack-host helper cleanup timed out', false);
        } catch {
          // Only the direct helper receives this signal. The approved Agent
          // helper must clean its owned host on SIGTERM, including during launch.
          child.kill('SIGTERM');
          await waitUntil(() => closed, performance.now() + stopTimeout, 'Pack-host helper did not exit after SIGTERM', false);
          throw new Error('Pack-host helper cleanup timed out; SIGTERM was required');
        }
      }
      if (protocolFailure || !stopped || exitCode !== 0) throw new Error('Pack-host helper cleanup failed');
    })();
    return stopping;
  }

  try {
    await waitUntil(() => ready, startupDeadline, 'Pack-host helper readiness timed out');
    let catalogReady = false;
    void Promise.resolve().then(checkReady).then(() => { catalogReady = true; notify(); },
      () => fail('Runtime rendering capability readiness check failed', false));
    await waitUntil(() => catalogReady, startupDeadline, 'Runtime rendering capability readiness timed out');
    if (stopped || closed) throw new Error('Pack-host helper stopped during startup');
    options.signal?.removeEventListener('abort', aborted);
    return { stop };
  } catch (error) {
    try { await stop(); } catch {
      throw new Error(`${(error as Error).message}; pack-host startup cleanup failed`);
    }
    throw error;
  }
}

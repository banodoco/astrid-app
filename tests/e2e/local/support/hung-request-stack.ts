import { accessSync, appendFileSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export const HUNG_REQUEST_AFTER_MS = 20_000;
const DUMP_TIMEOUT_MS = 5_000;
const SAFE_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;

export type StackTarget = {
  role: string;
  pid: number;
  incarnation: string;
  runId: string;
  owned: boolean;
  supervised: boolean;
};

export type Clock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type ProcessInspector = (pid: number) => string | null;

export type DebuggerTool = { name: 'py-spy' | 'gdb'; path: string };

export type DebuggerResult = {
  status: 'completed' | 'failed' | 'timeout';
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
};

export type DebuggerRunner = (tool: DebuggerTool, args: string[], timeoutMs: number) => Promise<DebuggerResult>;
export type ToolResolver = () => Promise<DebuggerTool | null>;
export type PlaywrightPage = { on(event: string, listener: (...args: unknown[]) => void): void; off?: (event: string, listener: (...args: unknown[]) => void) => void };

type PendingRequest = {
  ordinal: number;
  source: string;
  runId: string;
  startedAt: number;
  targets: StackTarget[];
  timer: unknown;
  active: boolean;
  dumped: boolean;
};

type TargetResult = {
  role: string;
  pid: number;
  incarnation: string;
  status: 'captured' | 'unavailable' | 'failed';
  reason?: string;
  raw_file?: string;
  frames?: Array<{ file: string; line: number; function?: string }>;
};

function token(value: unknown, fallback: string): string {
  const candidate = typeof value === 'string' ? value : '';
  return SAFE_TOKEN.test(candidate) ? candidate : fallback;
}

function processIncarnation(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

export const linuxProcessInspector: ProcessInspector = processIncarnation;

function privateDirectory(directory: string): boolean {
  try {
    const info = lstatSync(directory);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function safeBasename(file: string): string {
  const basename = path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_');
  return basename.slice(-160) || 'unknown';
}

function safeFunction(value: string): string | undefined {
  const cleaned = value.replace(/[^A-Za-z0-9_.$<>:-]/g, '_').slice(0, 120);
  return cleaned || undefined;
}

/** Keep the exported summary to frame/file/line facts; raw debugger output remains private. */
export function summarizeStack(raw: string): Array<{ file: string; line: number; function?: string }> {
  const frames: Array<{ file: string; line: number; function?: string }> = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const python = line.match(/File\s+["']([^"']+)["'],\s+line\s+(\d+)(?:,\s+in\s+([^\s(]+))?/);
    const gdb = line.match(/(?:^|\s)in\s+([A-Za-z_][A-Za-z0-9_.$<>:-]{0,120}).*?\s(?:at\s+)?([^:\s]{1,240}):([0-9]+)\s*$/);
    const file = python?.[1] ?? gdb?.[2];
    const lineNumber = Number(python?.[2] ?? gdb?.[3]);
    if (!file || !Number.isSafeInteger(lineNumber) || lineNumber < 1) continue;
    const frame = { file: safeBasename(file), line: lineNumber, ...(safeFunction(python?.[3] ?? gdb?.[1] ?? '') ? { function: safeFunction(python?.[3] ?? gdb?.[1] ?? '') } : {}) };
    const key = `${frame.file}:${frame.line}:${frame.function ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    frames.push(frame);
    if (frames.length === 32) break;
  }
  return frames;
}

function commandFor(tool: DebuggerTool, pid: number): string[] {
  return tool.name === 'py-spy' ? ['dump', '--pid', String(pid)] : ['-batch', '-ex', 'py-bt', '-p', String(pid)];
}

function defaultToolResolver(): Promise<DebuggerTool | null> {
  return new Promise((resolve) => {
    execFile('which', ['py-spy'], { encoding: 'utf8', timeout: 1_000 }, (error, stdout) => {
      if (!error) {
        const candidate = stdout.trim();
        try { accessSync(candidate, fsConstants.X_OK); resolve({ name: 'py-spy', path: candidate }); return; } catch { /* inspect gdb below */ }
      }
      execFile('which', ['gdb'], { encoding: 'utf8', timeout: 1_000 }, (gdbError, gdbStdout) => {
        if (gdbError) return resolve(null);
        const candidate = gdbStdout.trim();
        try { accessSync(candidate, fsConstants.X_OK); resolve({ name: 'gdb', path: candidate }); } catch { resolve(null); }
      });
    });
  });
}

export function spawnDebugger(tool: DebuggerTool, args: string[], timeoutMs: number): Promise<DebuggerResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(tool.path, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (error) {
      resolve({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const finish = (result: DebuggerResult) => { if (!settled) { settled = true; resolve({ ...result, stdout, stderr }); } };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 250);
      finish({ status: 'timeout', error: 'debugger_timeout' });
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); finish({ status: 'failed', error: error.message }); });
    child.once('close', (code) => { clearTimeout(timer); finish(code === 0 ? { status: 'completed', exitCode: code } : { status: 'failed', exitCode: code }); });
  });
}

function failureClass(result: DebuggerResult): string {
  const text = `${result.error ?? ''}\n${result.stderr ?? ''}`.toLowerCase();
  return /permission|operation not permitted|ptrace|attach refused|not allowed/.test(text) ? 'permission_failure' : result.status === 'timeout' ? 'dump_timeout' : 'dump_failure';
}

export class HungRequestStackCapture {
  private readonly runId: string;
  private readonly evidenceDir: string;
  private readonly clock: Clock;
  private readonly inspect: ProcessInspector;
  private readonly resolveTool: ToolResolver;
  private readonly runDebugger: DebuggerRunner;
  private readonly pending = new Map<number, PendingRequest>();
  private ordinal = 0;

  constructor(options: {
    runId: string;
    evidenceDir: string;
    clock?: Clock;
    inspect?: ProcessInspector;
    resolveTool?: ToolResolver;
    runDebugger?: DebuggerRunner;
  }) {
    this.runId = token(options.runId, 'unknown-run');
    this.evidenceDir = path.resolve(options.evidenceDir);
    this.clock = options.clock ?? { now: () => Date.now(), setTimeout, clearTimeout };
    this.inspect = options.inspect ?? linuxProcessInspector;
    this.resolveTool = options.resolveTool ?? defaultToolResolver;
    this.runDebugger = options.runDebugger ?? spawnDebugger;
    if (!existsSync(this.evidenceDir)) mkdirSync(this.evidenceDir, { recursive: true, mode: 0o700 });
    if (!privateDirectory(this.evidenceDir)) throw new Error('D79 evidence directory must be a private non-symlink directory');
  }

  beginRequest(input: { source: string; targets: StackTarget[] }): number {
    const ordinal = ++this.ordinal;
    const source = token(input.source, 'runtime-request');
    const targets = Array.isArray(input.targets) ? input.targets.map((target) => ({ ...target, role: token(target.role, 'runtime'), runId: token(target.runId, 'unknown-run') })) : [];
    const request: PendingRequest = { ordinal, source, runId: this.runId, startedAt: this.clock.now(), targets, timer: undefined, active: true, dumped: false };
    request.timer = this.clock.setTimeout(() => { void this.captureIfPending(request); }, HUNG_REQUEST_AFTER_MS);
    this.pending.set(ordinal, request);
    return ordinal;
  }

  completeRequest(ordinal: number, terminal: 'response' | 'failed' | 'finished' | 'abort' = 'response'): void {
    const request = this.pending.get(ordinal);
    if (!request || !request.active) return;
    request.active = false;
    this.clock.clearTimeout(request.timer);
    this.pending.delete(ordinal);
    try {
      this.writeJson(`request-${String(ordinal).padStart(4, '0')}.terminal.json`, { schema: 1, run_id: request.runId, request_ordinal: ordinal, source: request.source, terminal, started_at_ms: request.startedAt, terminal_at_ms: this.clock.now() });
    } catch {
      // A full or unavailable evidence directory must not alter request completion.
    }
  }

  pendingCount(): number { return this.pending.size; }

  abortAll(): void {
    for (const ordinal of [...this.pending.keys()]) this.completeRequest(ordinal, 'abort');
  }

  private async captureIfPending(request: PendingRequest): Promise<void> {
    if (!request.active || request.dumped) return;
    request.dumped = true;
    const elapsed = this.clock.now() - request.startedAt;
    if (elapsed < HUNG_REQUEST_AFTER_MS) {
      request.dumped = false;
      request.timer = this.clock.setTimeout(() => { void this.captureIfPending(request); }, HUNG_REQUEST_AFTER_MS - elapsed);
      return;
    }
    let tool: DebuggerTool | null = null;
    try { tool = await this.resolveTool(); } catch { tool = null; }
    const results: TargetResult[] = [];
    const seen = new Set<string>();
    for (const target of request.targets) {
      const key = `${target.pid}:${target.incarnation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(await this.captureTarget(request, target, tool));
    }
    if (!request.targets.length) results.push({ role: 'runtime', pid: 0, incarnation: 'unknown', status: 'unavailable', reason: 'no_registered_target' });
    try {
      this.writeJson(`request-${String(request.ordinal).padStart(4, '0')}.hung.json`, {
        schema: 1, run_id: request.runId, request_ordinal: request.ordinal, source: request.source,
        no_response_after_ms: elapsed, started_at_ms: request.startedAt, captured_at_ms: this.clock.now(), tool: tool?.name ?? null, targets: results,
      });
    } catch {
      // Evidence failure is deliberately non-fatal to the request that was being observed.
    }
  }

  private async captureTarget(request: PendingRequest, target: StackTarget, tool: DebuggerTool | null): Promise<TargetResult> {
    const base = { role: target.role, pid: target.pid, incarnation: token(target.incarnation, 'unknown') };
    if (request.runId !== target.runId) return { ...base, status: 'unavailable', reason: 'run_mismatch' };
    if (!target.owned || !target.supervised) return { ...base, status: 'unavailable', reason: 'unowned_or_unsupervised' };
    if (!Number.isInteger(target.pid) || target.pid <= 1) return { ...base, status: 'unavailable', reason: 'unknown_pid' };
    const current = this.inspect(target.pid);
    if (!current) return { ...base, status: 'unavailable', reason: 'unknown_pid' };
    if (current !== target.incarnation) return { ...base, status: 'unavailable', reason: 'incarnation_changed' };
    if (!tool) return { ...base, status: 'unavailable', reason: 'debugger_unavailable' };
    const args = commandFor(tool, target.pid);
    let result: DebuggerResult;
    try { result = await this.runDebugger(tool, args, DUMP_TIMEOUT_MS); } catch (error) { result = { status: 'failed', error: error instanceof Error ? error.message : String(error) }; }
    try {
      this.appendCommand({ run_id: request.runId, request_ordinal: request.ordinal, role: target.role, pid: target.pid, tool: tool.name, args: tool.name === 'py-spy' ? ['dump', '--pid', String(target.pid)] : ['-batch', '-ex', 'py-bt', '-p', String(target.pid)] });
    } catch {
      // The raw dump is still classified below; a broken command log must not affect the request.
    }
    if (result.status !== 'completed') return { ...base, status: 'failed', reason: failureClass(result) };
    const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const rawName = `request-${String(request.ordinal).padStart(4, '0')}-${token(target.role, 'runtime')}-${target.pid}.stack.txt`;
    try {
      this.writePrivate(rawName, raw);
      return { ...base, status: 'captured', raw_file: rawName, frames: summarizeStack(raw) };
    } catch {
      return { ...base, status: 'failed', reason: 'evidence_write_failure' };
    }
  }

  private writePrivate(name: string, value: string): void {
    const file = path.join(this.evidenceDir, name);
    try { if (lstatSync(file).isSymbolicLink()) throw new Error('evidence file is a symlink'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    writeFileSync(file, value, { mode: 0o600 });
  }

  private writeJson(name: string, value: unknown): void {
    this.writePrivate(name, `${JSON.stringify(value, null, 2)}\n`);
  }

  private appendCommand(value: unknown): void {
    const file = path.join(this.evidenceDir, 'commands.jsonl');
    try { if (lstatSync(file).isSymbolicLink()) throw new Error('command evidence file is a symlink'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }
}

export function attachPlaywrightRuntimeLifecycle(options: {
  page: PlaywrightPage;
  capture: HungRequestStackCapture;
  isRuntimeRequest: (request: unknown) => boolean;
  targets: () => StackTarget[];
  source?: string;
}): () => void {
  const handles = new WeakMap<object, number>();
  const source = options.source ?? 'app-runtime';
  const begin = (request: unknown) => {
    if (!request || typeof request !== 'object') return;
    if (!options.isRuntimeRequest(request)) return;
    handles.set(request, options.capture.beginRequest({ source, targets: options.targets() }));
  };
  const finish = (request: unknown, terminal: 'response' | 'failed' | 'finished') => {
    const ordinal = request && typeof request === 'object' ? handles.get(request) : undefined;
    if (ordinal !== undefined) options.capture.completeRequest(ordinal, terminal);
  };
  const onRequest = (request: unknown) => begin(request);
  const onResponse = (response: unknown) => finish((response as { request?: () => unknown } | null)?.request?.(), 'response');
  const onFailed = (request: unknown) => finish(request, 'failed');
  const onFinished = (request: unknown) => finish(request, 'finished');
  options.page.on('request', onRequest);
  options.page.on('response', onResponse);
  options.page.on('requestfailed', onFailed);
  options.page.on('requestfinished', onFinished);
  return () => {
    options.page.off?.('request', onRequest);
    options.page.off?.('response', onResponse);
    options.page.off?.('requestfailed', onFailed);
    options.page.off?.('requestfinished', onFinished);
  };
}

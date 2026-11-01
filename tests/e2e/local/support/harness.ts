/**
 * Journey harness for the same-machine "direct" transport (Plan A, F4).
 *
 *   hosted-style HTTPS origin (production build)  ->  the Runtime's browser door  ->  real Runtime daemon (SQLite)
 *
 * The door is the Runtime's own second listener (astrid-runtime `runtime_protocol/door.py`): nothing from this repo runs
 * between the page and the Runtime.
 *
 * Everything lives in one throwaway temp directory that `stop()` removes. Child processes
 * run in their own process groups and are killed by group.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { accessSync, chmodSync, constants as fsConstants, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { DIST_DIR, RUNTIME_CHECKOUT, ffmpegUnavailableReason } from '../../../../config/testing/skipConditions.mjs';
import { EDITOR_TOUR_VERSION } from '../../../../src/shared/lib/editorTourVersion.ts';
import { loadQuickDescriptor, type QuickDescriptor } from './quick-descriptor.ts';
import { attachPlaywrightRuntimeLifecycle, HungRequestStackCapture, linuxProcessInspector, type StackTarget } from './hung-request-stack.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../../..');
const forbiddenEnvKeys = [
  'BANODOCO_LOCAL_DATA_ROOT', 'BANODOCO_LOCAL_SOURCE_MANIFEST', 'BANODOCO_RUNTIME_DATA_ROOT', 'BANODOCO_RUNTIME_SOURCE_MANIFEST',
  'ASTRID_LOCAL_DATA_ROOT', 'ASTRID_RUNTIME_DATA_ROOT', 'ASTRID_LOCAL_SOURCE_MANIFEST', 'ASTRID_RUNTIME_SOURCE_MANIFEST',
];

function cleanProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of forbiddenEnvKeys) delete clean[key];
  return clean;
}

/** The door's well-known port (Plan A D1). Override with ASTRID_APP_DIRECT_DOOR_PORT. */
export const DOOR_PORT = Number(process.env.ASTRID_APP_DIRECT_DOOR_PORT ?? 17340);
export const HOSTED_HOST = 'astrid.test';
export const OTHER_HOST = 'evil.test';
export const PRODUCT_ACTOR = 'astrid-e2e-product';
/** The second client of the three-product journey (the Astrid CLI) is its own actor, so the Runtime's history says who wrote what. */
export const ASTRID_ACTOR = 'astrid-f2';
export const PRODUCT_SCOPES = ['handshake', 'projects:read', 'projects:write', 'tasks:read', 'tasks:write', 'objects:read', 'objects:write'];
export const BIG_DOWNLOAD_BYTES = 60 * 1024 * 1024;
export const BIG_UPLOAD_BYTES = 200 * 1024 * 1024;
/** Keep the App's reference sibling clear of the retained gesture moves. */
export const THREE_PRODUCTS_REFERENCE_AT = 15;
const P2_PHASE_BOOTSTRAP_DIR = path.resolve(REPO_ROOT, 'scripts/testing');
const P2_PHASE_CAPTURE_HELPER = 'tests/helpers/p2_commit_phase_capture.py';
const D66_PHASE_CAPTURE_HELPER_ENV = 'D66_P2_COMMIT_PHASE_CAPTURE_HELPER';
const D66_PHASE_CAPTURE_HELPER_SHA256_ENV = 'D66_P2_COMMIT_PHASE_CAPTURE_HELPER_SHA256';
const ASTRID_PHASE_CAPTURE_HELPER_ENV = 'ASTRID_P2_COMMIT_PHASE_CAPTURE_HELPER';
const ASTRID_PHASE_CAPTURE_HELPER_SHA256_ENV = 'ASTRID_P2_COMMIT_PHASE_CAPTURE_HELPER_SHA256';
const D66_ELEMENT_VERIFICATION_ENV = 'D66_ELEMENT_VERIFICATION_ONLY';
export const P2_PHASE_CAPTURE_FILE = 'p2-commit-phase.jsonl';
const P2_PHASE_LAUNCH_ORDINAL_ENV = 'D66_RUNTIME_PHASE_LAUNCH_ORDINAL';
const runtimeMeasurementEnvKeys = [
  D66_ELEMENT_VERIFICATION_ENV,
  'D66_RUNTIME_LOG_DIR', P2_PHASE_LAUNCH_ORDINAL_ENV,
  'ASTRID_P2_COMMIT_PHASE_CAPTURE', 'ASTRID_P2_COMMIT_PHASE_CAPTURE_SINK',
  'ASTRID_P2_COMMIT_PHASE_CAPTURE_HELPER', 'ASTRID_P2_COMMIT_PHASE_CAPTURE_HELPER_SHA256',
  'ASTRID_P2_COMMIT_PHASE_CAPTURE_WATCHDOG_SECONDS',
] as const;

/** Selected-parameter child processes receive a private credential path, never its bearer value. */
export function selectedParamCliEnv(base: NodeJS.ProcessEnv, credentialFile: string): NodeJS.ProcessEnv {
  return { ...base, ASTRID_RUNTIME_CREDENTIAL: credentialFile };
}

/** Add selected-parameter evaluation context without replacing inherited runner state. */
export function selectedParamEvalEnv(base: NodeJS.ProcessEnv, credentialFile: string,
  context: { endpoint: string; realmId: string; actorId: string }): NodeJS.ProcessEnv {
  return {
    ...selectedParamCliEnv(base, credentialFile),
    ASTRID_TIMELINE_EVAL_ENDPOINT: context.endpoint,
    ASTRID_TIMELINE_EVAL_CREDENTIAL: credentialFile,
    ASTRID_TIMELINE_EVAL_REALM_ID: context.realmId,
    ASTRID_TIMELINE_EVAL_ACTOR_ID: context.actorId,
  };
}

export { DIST_DIR, RUNTIME_CHECKOUT };

export function runtimePython(): string | null {
  const explicit = process.env.ASTRID_RUNTIME_PYTHON;
  if (explicit) {
    const candidate = path.resolve(explicit);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* the caller receives the normal unavailable reason below */ }
    return null;
  }
  const python = path.join(RUNTIME_CHECKOUT, '.venv', 'bin', 'python');
  return existsSync(python) ? python : null;
}

export interface P2CommitPhaseCaptureConfig {
  directory: string;
  sink: string;
  helper: string;
  helperSha256: string;
}

function resolvePhaseCaptureHelper(): { path: string; sha256: string } {
  const supplied = (process.env[D66_PHASE_CAPTURE_HELPER_ENV] ?? process.env[ASTRID_PHASE_CAPTURE_HELPER_ENV])?.trim();
  const helper = supplied || path.join(RUNTIME_CHECKOUT, P2_PHASE_CAPTURE_HELPER);
  const expected = (process.env[D66_PHASE_CAPTURE_HELPER_SHA256_ENV] ?? process.env[ASTRID_PHASE_CAPTURE_HELPER_SHA256_ENV])?.trim();
  if (!path.isAbsolute(helper)) throw new Error(`D66 diagnostic helper path must be absolute: ${helper}`);
  if (!supplied) {
    if (expected) throw new Error('D66 diagnostic helper SHA256 requires an explicit helper path');
    const info = lstatSync(helper, { throwIfNoEntry: false });
    return { path: helper, sha256: info?.isFile() && !info.isSymbolicLink() ? createHash('sha256').update(readFileSync(helper)).digest('hex') : '' };
  }
  const info = lstatSync(helper, { throwIfNoEntry: false });
  if (!info || !info.isFile() || info.isSymbolicLink()) throw new Error(`D66 diagnostic helper file is unavailable: ${helper}`);
  if (supplied && !/^[0-9a-f]{64}$/.test(expected ?? '')) {
    throw new Error('D66 diagnostic helper SHA256 must be a 64-character lowercase hex digest');
  }
  const actual = createHash('sha256').update(readFileSync(helper)).digest('hex');
  if (expected && actual !== expected) throw new Error(`D66 diagnostic helper SHA256 mismatch: ${helper}`);
  return { path: helper, sha256: actual };
}

/** Resolve the private, bounded observer destination selected by D66. */
export function p2CommitPhaseCaptureConfig(runtimeLogDir: string | undefined, launchOrdinal = 1): P2CommitPhaseCaptureConfig | null {
  const raw = runtimeLogDir?.trim();
  if (!raw) return null;
  if (!path.isAbsolute(raw)) throw new Error('D66 Runtime log directory must be an absolute path under TMPDIR');
  const directory = path.resolve(raw);
  const temporary = path.resolve(tmpdir());
  const relative = path.relative(temporary, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('D66 Runtime log directory must be a private child of TMPDIR');
  if (!Number.isInteger(launchOrdinal) || launchOrdinal < 1) throw new Error('P2 Runtime phase launch ordinal must be positive');
  const suffix = launchOrdinal === 1 ? '' : `-${launchOrdinal}`;
  const helper = resolvePhaseCaptureHelper();
  return {
    directory,
    sink: path.join(directory, `${P2_PHASE_CAPTURE_FILE.slice(0, -'.jsonl'.length)}${suffix}.jsonl`),
    helper: helper.path,
    helperSha256: helper.sha256,
  };
}

function p2PhaseLaunchOrdinal(runtimeLogDir: string | undefined): number {
  if (!runtimeLogDir?.trim()) return 1;
  const raw = process.env[P2_PHASE_LAUNCH_ORDINAL_ENV]?.trim();
  if (!raw) return 1;
  const launchOrdinal = Number(raw);
  if (!Number.isInteger(launchOrdinal) || launchOrdinal < 1) throw new Error('D66 Runtime phase launch ordinal must be a positive integer');
  return launchOrdinal;
}

function prepareRuntimeLogDirectory(runtimeLogDir: string | undefined, launchOrdinal: number): string | undefined {
  const raw = runtimeLogDir?.trim();
  if (!raw) return undefined;
  if (!path.isAbsolute(raw)) throw new Error('D66 Runtime log directory must be an absolute path under TMPDIR');
  const directory = path.resolve(raw);
  const temporary = path.resolve(tmpdir());
  const relative = path.relative(temporary, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('D66 Runtime log directory must be a private child of TMPDIR');
  if (!Number.isInteger(launchOrdinal) || launchOrdinal < 1) throw new Error('P2 Runtime phase launch ordinal must be positive');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const rootDirectory = lstatSync(directory);
  if (!rootDirectory.isDirectory() || rootDirectory.isSymbolicLink()) throw new Error(`D66 Runtime log directory is not a private directory: ${directory}`);
  chmodSync(directory, 0o700);
  if (launchOrdinal === 1) return directory;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(directory, `launch-${randomUUID()}`);
    try {
      mkdirSync(candidate, { mode: 0o700 });
      const candidateStat = lstatSync(candidate);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
        throw new Error(`D66 Runtime launch directory is not a private directory: ${candidate}`);
      }
      chmodSync(candidate, 0o700);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt === 7) throw new Error('D66 Runtime launch directory allocation collided repeatedly');
    }
  }
  throw new Error('D66 Runtime launch directory allocation failed');
}

function prepareP2CommitPhaseCapture(runtimeLogDir: string | undefined, launchOrdinal: number): string | undefined {
  const config = p2CommitPhaseCaptureConfig(runtimeLogDir, launchOrdinal);
  if (!config) return undefined;
  const allocatedDirectory = prepareRuntimeLogDirectory(runtimeLogDir, launchOrdinal)!;
  const launchConfig = p2CommitPhaseCaptureConfig(allocatedDirectory, launchOrdinal);
  try {
    const sink = lstatSync(launchConfig.sink);
    throw new Error(`P2 Runtime phase sink already exists: ${launchConfig.sink} (${sink.isSymbolicLink() ? 'symlink' : 'file'})`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return allocatedDirectory;
}

function runtimeStreamLogName(stream: 'stdout' | 'stderr', launchOrdinal: number): string {
  const suffix = launchOrdinal === 1 ? '' : `-${launchOrdinal}`;
  return `runtime.${stream}${suffix}.log`;
}

/** Why the harness cannot run here, or null when it can. */
export function harnessUnavailableReason(): string | null {
  if (process.env.ASTRID_RUNTIME_PYTHON && !runtimePython()) return `ASTRID_RUNTIME_PYTHON is not an executable file: ${path.resolve(process.env.ASTRID_RUNTIME_PYTHON)}`;
  if (!runtimePython()) return `Runtime venv not found at ${RUNTIME_CHECKOUT}/.venv (set ASTRID_RUNTIME_CHECKOUT)`;
  if (!existsSync(path.join(DIST_DIR, 'index.html'))) return `no production build at ${DIST_DIR} (run npm run build, or use npm run test:e2e:direct)`;
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { return 'openssl is required to make the test certificate'; }
  return null;
}

export const sha256Hex = (data: Uint8Array) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

// ---------------------------------------------------------------------------------------------
// Process helpers

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function assertPortFree(port: number, what: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createNetServer();
    server.once('error', (error: NodeJS.ErrnoException) => reject(new Error(`${what} port ${port} is not free (${error.code}); stop whatever uses it or set ASTRID_APP_DIRECT_DOOR_PORT`)));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}

const liveGroups = new Set<number>();
function killGroupSync(pid: number) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}
process.on('exit', () => { for (const pid of liveGroups) killGroupSync(pid); });

export interface Managed {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  exited: Promise<number | null>;
  /** Resolves once the process has ended and its stdout and stderr are fully read (`exited` can come first). */
  closed: Promise<void>;
}

export interface RuntimeLifecycleObservation {
  startedAt: string;
  readyAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  launchInterpreter: string;
  launchModule: 'runtime_protocol.cli';
  launchProfile: 'neutral' | 'astrid';
  actualInterpreter?: string;
  actualModule?: 'runtime_protocol.cli';
  doorOriginEquality?: boolean;
  failure?: { code: 'startup_failed'; class: 'startup'; stage: 'spawn' | 'endpoint' | 'health' };
}

function timestamp(): string { return new Date().toISOString(); }

function actualRuntimeProcess(pid: number): Pick<RuntimeLifecycleObservation, 'actualInterpreter' | 'actualModule'> {
  try {
    const actualInterpreter = readlinkSync(`/proc/${pid}/exe`);
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    const module = argv[argv.indexOf('-m') + 1];
    return {
      actualInterpreter: actualInterpreter || undefined,
      actualModule: module === 'runtime_protocol.cli' ? module : undefined,
    };
  } catch {
    return {};
  }
}

/** Starts `command` in its own process group. `exactEnv` gives it `options.env` alone; otherwise that is laid over this process's environment. */
export function spawnGroup(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; exactEnv?: boolean }): Managed {
  const childEnv = options.exactEnv ? { ...options.env } : { ...cleanProcessEnv(), ...options.env };
  const child = spawn(command, args, { cwd: options.cwd, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!child.pid) throw new Error(`could not start ${command}`);
  liveGroups.add(child.pid);
  const managed: Managed = {
    child,
    stdout: '',
    stderr: '',
    exited: new Promise((resolve) => child.once('exit', (code) => { liveGroups.delete(child.pid!); resolve(code); })),
    closed: new Promise((resolve) => child.once('close', () => resolve())),
  };
  child.stdout!.on('data', (chunk) => { managed.stdout += chunk; });
  child.stderr!.on('data', (chunk) => { managed.stderr += chunk; });
  return managed;
}

export async function stopGroup(managed: Managed | undefined, graceMs = 8000, strict = false): Promise<void> {
  if (!managed) return;
  const { pid, exitCode } = managed.child;
  if (!pid) return;
  let forced = false;
  if (exitCode === null) {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
    const timer = setTimeout(() => { forced = true; killGroupSync(pid); }, graceMs);
    await managed.exited;
    clearTimeout(timer);
  }
  // Reap stragglers (tsx/python helper children) of the group.
  try { process.kill(-pid, 0); forced = true; } catch { /* process group is gone */ }
  killGroupSync(pid);
  if (strict) {
    let remains = false;
    try { process.kill(-pid, 0); remains = true; } catch { /* ESRCH means the App-owned process group is gone. */ }
    if (remains) throw new Error(`owned process group ${pid} remains after SIGKILL cleanup`);
  }
  liveGroups.delete(pid);
  if (strict && forced) throw new Error(`owned process group ${pid} required forced cleanup`);
}

async function waitFor<T>(label: string, probe: () => Promise<T | null | undefined | false>, timeoutMs: number, abort?: () => string | null): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    const aborted = abort?.();
    if (aborted) throw new Error(`${label}: ${aborted}`);
    if (Date.now() > deadline) throw new Error(`${label}: timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ---------------------------------------------------------------------------------------------
// Raw HTTP (so tests can control Host, Origin and Referer exactly)

export interface RawResponse { status: number; headers: IncomingHttpHeaders; body: Buffer; text: string; json: () => any }

export function rawRequest(options: { port: number; path: string; method?: string; headers?: Record<string, string>; body?: Buffer | string; host?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    // Content-Length like a browser's fetch (chunked bodies are not what the hosted page sends), one connection per request.
    const headers: Record<string, string> = { Host: options.host ?? `127.0.0.1:${options.port}`, ...(options.body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(options.body)) }), ...options.headers };
    const req = httpRequest({ hostname: '127.0.0.1', port: options.port, path: options.path, method: options.method ?? 'GET', headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, get text() { return body.toString('utf8'); }, json: () => JSON.parse(body.toString('utf8')) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

// ---------------------------------------------------------------------------------------------
// Certificate and hosted-style static server

function makeCertificate(dir: string) {
  const key = path.join(dir, 'tls.key');
  const cert = path.join(dir, 'tls.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', `/CN=${HOSTED_HOST}`,
    '-addext', `subjectAltName=DNS:${HOSTED_HOST},DNS:${OTHER_HOST}`], { stdio: 'ignore', env: cleanProcessEnv() });
  const x509 = new X509Certificate(readFileSync(cert));
  const spki = createHash('sha256').update(x509.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  return { key: readFileSync(key), cert: readFileSync(cert), spki };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wasm': 'application/wasm', '.map': 'application/json', '.txt': 'text/plain',
};

function startHostedServer(tls: { key: Buffer; cert: Buffer }, port: number): Promise<HttpsServer> {
  const root = DIST_DIR;
  const server = createHttpsServer(tls, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://placeholder.invalid');
    const send = (status: number, type: string, body: string) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
    // The hosted origin has no Runtime proxy; same-origin API paths do not exist there.
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/runtime-config/')) return send(404, 'application/json', '{"error":"no_proxy_on_hosted_origin"}');
    if (url.pathname === '/__blank.html') return send(200, 'text/html; charset=utf-8', '<!doctype html><title>blank</title><body></body>');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep) && file !== root) return send(403, 'text/plain', 'forbidden');
    const isFile = () => { try { return statSync(file).isFile(); } catch { return false; } };
    if (!isFile()) {
      if (path.extname(url.pathname)) return send(404, 'text/plain', 'not found');
      file = path.join(root, 'index.html'); // SPA fallback
    }
    const cacheable = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': statSync(file).size, 'Cache-Control': cacheable ? 'public, max-age=3600' : 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server)); });
}

// ---------------------------------------------------------------------------------------------
// Fixture media

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return ~crc >>> 0;
}

/** A real, decodable gradient PNG. */
export function makePng(width = 64, height = 48): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) { row[1 + x * 3] = (x * 255 / width) | 0; row[2 + x * 3] = (y * 255 / height) | 0; row[3 + x * 3] = 128; }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * A few-second VP8 clip (decodable in stock Chromium) when ffmpeg can make one; otherwise a repo MP4 that only
 * exercises bytes and Range. Whether ffmpeg can is the declared `direct-journey-ffmpeg` condition; once it says yes,
 * a failure to make the clip is an error, never a quiet fallback.
 */
function makeVideo(dir: string): { data: Buffer; mediaType: string; decodable: boolean } {
  if (ffmpegUnavailableReason() !== null) {
    return { data: readFileSync(path.join(REPO_ROOT, 'src/pages/Home/light-study-assets/first-light.mp4')), mediaType: 'video/mp4', decodable: false };
  }
  const out = path.join(dir, 'clip.webm');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=12', '-c:v', 'libvpx', '-b:v', '600k', '-g', '15', out], { stdio: 'ignore', timeout: 60_000, env: cleanProcessEnv() });
  return { data: readFileSync(out), mediaType: 'video/webm', decodable: true };
}

// ---------------------------------------------------------------------------------------------

export interface SeededObject { objectId: string; digest: string; size: number; mediaType: string }
export interface Seed {
  projectId: string;
  projectName: string;
  timelineId: string;
  headRevisionId: string;
  image: SeededObject;
  video: SeededObject & { decodable: boolean };
  big: SeededObject;
}

export function compositionPublication(seed: { projectId: string; timelineId: string }, expectedHead: string | null, name: string, fps: number) {
  return {
    project_id: seed.projectId,
    timeline_id: seed.timelineId,
    expected_head: expectedHead,
    parent_revision_id: randomUUID(),
    parent_composition: {
      slug: 'main',
      name,
      config: { output: { resolution: '1280x720', fps, file: 'out.mp4' }, clips: [], tracks: [{ id: 'V1', kind: 'visual', label: 'V1' }] },
      registry: { assets: {} },
      clips: [],
      occurrences: [],
    },
    shot_revisions: [],
    internal_timeline_revisions: [],
  };
}

/** One timeline that shows what the bundled pack extensions draw: a transcript lane over a media clip, and a live-scene clip. */
export interface ExtensionsSeed {
  projectSlug: string;
  timelineId: string;
  /** The transcript segments' text, in time order (the lane shows each as a chip). */
  transcriptTexts: string[];
  sceneClipId: string;
  /** The media clip that carries the transcript (its asset is the seeded video). */
  speechClipId: string;
  /** Text the scene's own page draws; the case reads it back from inside the sandboxed iframe. */
  sceneMarker: string;
  /** The live-scene package as a Runtime project object (the clip carries its inline copy). */
  scenePackage: SeededObject;
  sceneEntry: SeededObject;
}

/** One timeline whose clips are the seeded image and the seeded video, so the editor draws both through the door. */
export interface MediaSeed {
  projectSlug: string;
  timelineId: string;
  imageClipId: string;
  videoClipId: string;
}

/** The fields of `<support>/discovery.json` the journeys read (the Runtime writes more). The credential files named here are the owner's and the worker's, never the product's. */
export interface RuntimeDiscovery {
  endpoint: string;
  active_realm: string;
  runtime_instance_id: string;
  worker_credential_file: string;
  /** The actor the worker credential belongs to; an executor registered with it must carry this id. */
  worker_actor: string;
  [key: string]: unknown;
}

/** What `seedThreeProducts` made. */
export interface ThreeProductsSeed {
  projectSlug: string;
  /** The harness's own seeded timeline: the seed is published onto it, so the editor still opens the only project and timeline. */
  timelineId: string;
  /** The canonical head produced by the native Runtime commit that seeded the closure. */
  headRevisionId: string;
  appClipId: string;
  agentClipId: string;
  transitionClipId: string;
  agentClearClipId: string;
  /** The shot the agent's clips live in, and its occurrence in the parent composition (the App draws it as one block). */
  shotId: string;
  occurrenceId: string;
  /** The key the agent names for a task output (`--swap-asset f2-marker=task:T/marker#0`). It is new: the CLI refuses a key that already names other media. */
  markerAssetKey: string;
  /** Opaque data neither client models; every later revision must carry both unchanged. */
  opaque: { config: Record<string, unknown>; clip: Record<string, unknown>; shot?: Record<string, unknown> };
}

export interface QuickSeed {
  projectId: string;
  projectSlug: string;
  projectName: string;
  timelineId: string;
  headRevisionId: string;
}

export const THREE_PRODUCTS_OPAQUE = {
  config: { owner: 'f2', nested: [1, { k: 'v' }], flag: true },
  clip: { owner: 'f2', nested: [1, { k: 'v' }] },
  shot: { owner: 'f2-shot', nested: [1, { k: 'v' }], flag: true },
} as const;
export const THREE_PRODUCTS_SCENE_MARKER_EXTENSION_ID = 'haus.astrid.scene-phase-markers';
export const THREE_PRODUCTS_SCENE_MARKERS = [{ id: 'ordinary-marker-a', time: 1 }, { id: 'ordinary-marker-b', time: 6 }] as const;

/**
 * The render journey's timeline (testing plan F2 steps 3 and 4): a 6 s film whose middle two seconds are the slot an agent fills
 * with a marker clip. `placeholderGrey` is the solid grey the slot holds until then (and holds again in the revision published
 * after the render was admitted); the render must show the marker, never this grey.
 */
export interface RenderSeed {
  projectSlug: string;
  timelineId: string;
  /** The timeline's name, as the "Select timeline" combobox lists it. */
  timelineName: string;
  headRevisionId: string;
  shotId: string;
  occurrenceId: string;
  /** The clip the agent fills (film seconds 2 to 4). */
  slotClipId: string;
  /** The key the agent names for the marker clip (new: the CLI refuses a key that already names other media). */
  markerAssetKey: string;
  /** The slot's asset in the seed, which the agent swaps back to for the negative control. */
  placeholderAssetKey: string;
  /** The placeholder's object id, so the swap back can be named by digest. */
  placeholder: SeededObject;
  placeholderGrey: { r: number; g: number; b: number };
  /** The occurrence's block on the timeline (its label, which spans the block): its right edge is where the film, and so the seekable preview, ends. */
  occurrenceBlockSelector: string;
  fps: number;
  durationSeconds: number;
}

export const RENDER_TIMELINE_NAME = 'F2 Render';
const RENDER_GREY = { r: 0x80, g: 0x80, b: 0x80 };

/**
 * BT.601, limited range, said in the file. That is what VP8 is (ffmpeg reads every VP8 frame as such), and a clip that does not
 * say it is decoded by guesswork: a browser's `<video>` and its WebCodecs path guess differently for the same clip, so the
 * editor's preview and a player of the rendered film would disagree about the source before any renderer is involved.
 */
const BT601_FILTER = 'format=rgb24,scale=out_color_matrix=bt601:out_range=tv,format=yuv420p';
const BT601_TAGS = ['-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', '-color_range', 'tv'];

/** Runs ffmpeg or fails by name: this journey's media are real VP8/Opus, so there is no fallback file to use instead. */
function ffmpegOrFail(args: string[], what: string): void {
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim().slice(-400);
    throw new Error(`the render journey needs ffmpeg (with libvpx and libopus) to make ${what}: ${stderr || (error as Error).message}`);
  }
}

const SCENE_MARKER = 'journey-scene';

/** The smallest entry page the validator accepts: a `<head>` for the CSP, a `<body>` for the bridge, and `window.astridScene`. */
function sceneEntryHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>journey scene</title></head><body style="margin:0;background:#123"><div id="scene" style="color:#fff;font:16px monospace"></div><script>
window.astridScene = {
  async initialize() {},
  async render(frame) { document.getElementById('scene').textContent = '${SCENE_MARKER} t=' + frame.sourceTime.toFixed(2); },
  dispose() {},
};
</script></body></html>`;
}

export class DirectHarness {
  attachment: QuickDescriptor | null = null;
  quickSeed?: QuickSeed;
  tmp = '';
  origin = '';
  originPort = 0;
  otherOrigin = '';
  spki = '';
  runtimePort = 0;
  runtimeInstanceId = '';
  realmId = '';
  seed!: Seed;
  productToken = '';
  /** The door's loopback port: the fixed default, or the adopted Runtime's own in attachment mode. */
  doorPort = DOOR_PORT;
  private runtime?: Managed;
  private https?: HttpsServer;
  private stopped = false;
  private extensionsSeed?: ExtensionsSeed;
  private mediaSeed?: MediaSeed;
  private threeProductsSeed?: ThreeProductsSeed;
  private renderSeed?: RenderSeed;
  private timelineAuthoring = false;
  private verificationOnly = false;
  private authoringPython?: string;
  private runtimeLifecycle?: RuntimeLifecycleObservation;
  private phaseCaptureDirectory?: string;
  private phaseCaptureLaunchOrdinal = 0;
  private runtimeLogDirectory?: string;
  private runtimeLogLaunchOrdinal = 1;
  private seedInitialized = false;
  private hungStackCapture?: HungRequestStackCapture;
  private hungStackRunId?: string;
  private seedHead?: { revisionId: string; publicationId: string };

  /** The hosted site's extension release config: on by default, as deployed; a case sets 'missing' to see the closed posture. */

  get realmDir() { return path.join(this.tmp, 'realm'); }
  get supportDir() { return this.attachment ? path.dirname(this.attachment.discoveryFile) : path.join(this.tmp, 'support'); }
  get auditPath() { return path.join(this.tmp, 'door-audit.jsonl'); }
  /** The product credential the door acts with, as `astrid-runtime up` would provision it. */
  get credentialPath() { return path.join(this.tmp, 'product-credential.json'); }
  /** The App's Runtime base (`runtimeApiBase()`) under the door's origin. */
  get doorBase() { return `http://127.0.0.1:${this.doorPort}${this.doorPrefix}`; }
  get doorPrefix() { return '/api/runtime'; }

  /** Browser context options: the local-network permission is granted (the prompt itself is a manual-checklist item). */
  get contextOptions() {
    return {
      permissions: ['local-network-access'] as string[],
      // The first-run tour swaps the editor for its demo timeline while it runs, so no journey would be looking at the
      // real timeline (and nothing polls its head). Every case here is about the real editor: the tour is already seen.
      storageState: { cookies: [], origins: [{ origin: this.origin, localStorage: [{ name: `astrid-editor-tour-v${EDITOR_TOUR_VERSION}`, value: '1' }] }] },
    };
  }

  /** Chromium arguments: host mapping, a pinned test certificate, and the hosted origin treated as a public address. */
  get chromiumArgs(): string[] {
    return [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-proxy-server', // the sandbox's HTTPS_PROXY must not capture the hosted-style origin
      `--host-resolver-rules=MAP ${HOSTED_HOST} 127.0.0.1, MAP ${OTHER_HOST} 127.0.0.1, MAP *.supabase.co 127.0.0.1:1, MAP *.supabase.in 127.0.0.1:1`,
      `--ignore-certificate-errors-spki-list=${this.spki}`,
      // The hosted origin resolves to loopback here, so without this override Chromium would treat the page as
      // local and skip the public -> loopback (Private Network Access / local network) checks that production hits.
      `--ip-address-space-overrides=127.0.0.1:${this.originPort}=public`,
    ];
  }

  async start(options: { deferTimelineInitialization?: boolean } = {}): Promise<this> {
    process.on('SIGTERM', () => { void this.stop().finally(() => process.exit(143)); });
    try {
      const configuredRuntimeLogDirectory = process.env.D66_RUNTIME_LOG_DIR?.trim() || undefined;
      this.verificationOnly = process.env[D66_ELEMENT_VERIFICATION_ENV] === '1';
      this.runtimeLogLaunchOrdinal = p2PhaseLaunchOrdinal(configuredRuntimeLogDirectory);
      this.phaseCaptureLaunchOrdinal = this.runtimeLogLaunchOrdinal - 1;
      const descriptorText = process.env.ASTRID_QUICK_DESCRIPTOR;
      if (descriptorText !== undefined) this.attachment = loadQuickDescriptor(descriptorText);
      this.tmp = mkdtempSync(path.join(tmpdir(), 'astrid-direct-'));
      if (!this.attachment) await assertPortFree(this.doorPort, 'door');
      const tls = makeCertificate(this.tmp);
      this.spki = tls.spki;
      // The adopted Runtime's door already serves one hosted origin; the page must be served from exactly that.
      this.originPort = this.attachment ? Number(new URL(this.attachment.hostedOrigin).port) : Number(process.env.ASTRID_APP_DIRECT_ORIGIN_PORT ?? 0) || await freePort();
      if (this.attachment) this.doorPort = Number(new URL(this.attachment.doorEndpoint).port);
      this.https = await startHostedServer(tls, this.originPort);
      this.origin = `https://${HOSTED_HOST}:${this.originPort}`;
      this.otherOrigin = `https://${OTHER_HOST}:${this.originPort}`;

      if (this.attachment) {
        this.realmId = this.attachment.realmId;
        const discovery = this.discovery();
        if (!/^https?:\/\//.test(discovery.endpoint)) throw new Error('adopted Runtime discovery endpoint must be an absolute HTTP URL');
        if (discovery.active_realm !== this.attachment.realmId || discovery.runtime_instance_id !== this.attachment.runtimeInstanceId) throw new Error(`adopted Runtime discovery identity mismatch: realm ${discovery.active_realm}, instance ${discovery.runtime_instance_id}`);
        this.runtimePort = Number(new URL(discovery.endpoint).port);
        this.productToken = readCredentialToken(this.attachment.productCredentialFile);
        await this.assertAttachedIdentity();
        const project = await this.runtimeJson('GET', `/v1/projects/${this.attachment.projectId}`);
        if (project.status !== 200) throw new Error(`adopted project lookup failed: ${project.status} ${JSON.stringify(project.body)}`);
        const resource = project.body;
        if (resource.project_id !== this.attachment.projectId || resource.realm_id !== this.realmId || resource.slug !== this.attachment.projectSlug) throw new Error(`adopted project identity mismatch: ${JSON.stringify(resource)}`);
        const projectName = resource.name;
        this.quickSeed = { projectId: this.attachment.projectId, projectSlug: this.attachment.projectSlug, projectName, timelineId: this.attachment.timelineId, headRevisionId: this.attachment.headRevisionId };
        this.seed = { ...this.quickSeed, image: undefined, video: undefined, big: undefined } as unknown as Seed;
      } else {
        mkdirSync(this.supportDir, { recursive: true, mode: 0o700 });
        if (this.verificationOnly) {
          if (!configuredRuntimeLogDirectory) throw new Error('D66 element verification requires private Runtime stream retention');
          this.runtimeLogDirectory = prepareRuntimeLogDirectory(configuredRuntimeLogDirectory, this.runtimeLogLaunchOrdinal);
        } else {
          this.phaseCaptureDirectory = prepareP2CommitPhaseCapture(configuredRuntimeLogDirectory, this.runtimeLogLaunchOrdinal);
          this.runtimeLogDirectory = this.phaseCaptureDirectory;
        }
        this.realmId = await this.createRealm();
        const hungEvidence = process.env.D79_HUNG_STACK_EVIDENCE_DIR?.trim();
        if (hungEvidence) {
          this.hungStackRunId = process.env.D79_HUNG_STACK_RUN_ID?.trim() || path.basename(hungEvidence);
          this.hungStackCapture = new HungRequestStackCapture({ runId: this.hungStackRunId, evidenceDir: hungEvidence });
        }
        await this.startRuntime();
        // The door listens from the start and answers `runtime_unavailable` until the product credential exists.
        this.productToken = await this.provisionCredential(PRODUCT_ACTOR, path.basename(this.credentialPath));
        this.seed = await this.seedRuntime(options.deferTimelineInitialization);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
    return this;
  }

  // -- Runtime -------------------------------------------------------------------------------

  private runtimeEnv(captureSink?: string): NodeJS.ProcessEnv {
    const agent = path.resolve(process.env.ASTRID_CHECKOUT ?? path.join(REPO_ROOT, '..', 'astrid-agent'));
    const env: NodeJS.ProcessEnv = { PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', PYTHONPATH: [RUNTIME_CHECKOUT, agent].join(path.delimiter) };
    if (this.verificationOnly) {
      for (const key of runtimeMeasurementEnvKeys) env[key] = undefined;
    }
    if (captureSink && !this.verificationOnly) {
      const config = p2CommitPhaseCaptureConfig(this.phaseCaptureDirectory, this.phaseCaptureLaunchOrdinal);
      if (!config) throw new Error('P2 Runtime phase capture sink requested without its private directory');
      env.PYTHONPATH = [P2_PHASE_BOOTSTRAP_DIR, RUNTIME_CHECKOUT, agent].join(path.delimiter);
      env.ASTRID_P2_COMMIT_PHASE_CAPTURE = '1';
      env.ASTRID_P2_COMMIT_PHASE_CAPTURE_SINK = captureSink;
      env.ASTRID_P2_COMMIT_PHASE_CAPTURE_HELPER = config.helper;
      if (config.helperSha256) env.ASTRID_P2_COMMIT_PHASE_CAPTURE_HELPER_SHA256 = config.helperSha256;
      const watchdogSeconds = process.env.ASTRID_P2_COMMIT_PHASE_CAPTURE_WATCHDOG_SECONDS?.trim();
      if (watchdogSeconds) env.ASTRID_P2_COMMIT_PHASE_CAPTURE_WATCHDOG_SECONDS = watchdogSeconds;
    }
    return env;
  }

  /** Health identifies the running instance; the authenticated realm route identifies its realm. */
  private async assertAttachedIdentity(): Promise<void> {
    const healthResponse = await fetch(`${this.runtimeUrl}/v1/health`);
    if (!healthResponse.ok) throw new Error(`adopted Runtime health failed: ${healthResponse.status}`);
    const health = await healthResponse.json() as { runtime_instance_id?: string };
    const realm = await this.runtimeJson('GET', '/v1/realm');
    if (realm.status !== 200) throw new Error(`adopted realm lookup failed: ${realm.status} ${JSON.stringify(realm.body)}`);
    if (realm.body.realm_id !== this.realmId || health.runtime_instance_id !== this.attachment!.runtimeInstanceId) throw new Error(`adopted Runtime identity mismatch: realm ${realm.body.realm_id}, instance ${health.runtime_instance_id}`);
    this.runtimeInstanceId = health.runtime_instance_id;
  }

  private async createRealm(): Promise<string> {
    const output = execFileSync(runtimePython()!, ['-m', 'runtime_protocol.cli', 'create', '--root', this.realmDir, '--display-name', 'Direct Journey'], { cwd: this.tmp, env: cleanProcessEnv({ ...process.env, ...this.runtimeEnv() }), encoding: 'utf8' });
    return JSON.parse(output.trim().split('\n').pop()!).realm_id;
  }

  /**
   * Starts the daemon the way `astrid-runtime up` does: port 0, so every start gets a new port (discovery is rewritten by the
   * Runtime), and the browser door for the hosted origin on its fixed port, acting with the product credential.
   */
  /** Restart with the Agent-authoring provider used by the retained commit journeys. */
  async enableTimelineAuthoring(python: string): Promise<void> {
    if (this.timelineAuthoring) return;
    await this.stopRuntime();
    if (!existsSync(python)) throw new Error(`Authoring Python not found at ${python}`);
    this.authoringPython = python;
    this.timelineAuthoring = true;
    await this.startRuntime();
  }

  async startRuntime(port = 0): Promise<void> {
    if (this.attachment) throw new Error('App attachment cannot start an adopted Runtime');
    if (this.runtime) throw new Error('Runtime already running');
    const interpreter = this.authoringPython ?? runtimePython()!;
    const profile = this.timelineAuthoring ? 'astrid' : 'neutral';
    const lifecycle: RuntimeLifecycleObservation = {
      startedAt: timestamp(), launchInterpreter: interpreter, launchModule: 'runtime_protocol.cli', launchProfile: profile,
    };
    this.runtimeLifecycle = lifecycle;
    let captureSink: string | undefined;
    if (!this.verificationOnly && this.timelineAuthoring && this.phaseCaptureDirectory) {
      this.phaseCaptureLaunchOrdinal += 1;
      const config = p2CommitPhaseCaptureConfig(this.phaseCaptureDirectory, this.phaseCaptureLaunchOrdinal);
      captureSink = config?.sink;
    }
    let managed: Managed;
    try {
      managed = spawnGroup(interpreter, ['-m', 'runtime_protocol.cli', 'start', '--root', this.realmDir, '--support-root', this.supportDir, '--port', String(port), '--display-name', 'Direct Journey',
      '--door-origin', this.origin, '--door-port', String(this.doorPort), '--door-credential-file', this.credentialPath, '--door-audit-log', this.auditPath,
      ...(this.timelineAuthoring ? ['--authoring-profile', 'astrid'] : [])], { cwd: this.tmp, env: this.runtimeEnv(captureSink) });
    } catch {
      lifecycle.failure = { code: 'startup_failed', class: 'startup', stage: 'spawn' };
      throw new Error('Runtime start failed');
    }
    this.runtime = managed;
    void managed.exited.then((code) => { lifecycle.exitedAt = timestamp(); lifecycle.exitCode = code; });
    Object.assign(lifecycle, actualRuntimeProcess(managed.child.pid!));
    const endpoint = await waitFor<string>('Runtime start', async () => {
      const line = managed.stdout.split('\n').find((candidate) => candidate.trim().startsWith('{') && candidate.includes('"endpoint"'));
      return line ? JSON.parse(line).endpoint : null;
    }, 60_000, () => (managed.child.exitCode !== null ? 'Runtime exited before endpoint readiness' : null)).catch((error) => {
      lifecycle.failure = { code: 'startup_failed', class: 'startup', stage: 'endpoint' };
      if (managed.child.exitCode !== null) {
        return managed.closed.then(() => {
          const stderr = managed.stderr.trim();
          const detail = stderr ? stderr.slice(-4000) : '<empty>';
          throw new Error(`${error instanceof Error ? error.message : String(error)}\nRuntime stderr:\n${detail}`);
        });
      }
      throw error;
    });
    this.runtimePort = Number(new URL(endpoint).port);
    const health = await waitFor<any>('Runtime health', async () => {
      const response = await fetch(`${endpoint}/v1/health`);
      return response.ok ? response.json() : null;
    }, 30_000).catch((error) => {
      lifecycle.failure = { code: 'startup_failed', class: 'startup', stage: 'health' };
      throw error;
    });
    this.runtimeInstanceId = health.runtime_instance_id;
    lifecycle.readyAt = timestamp();
    try {
      const discovery = JSON.parse(readFileSync(path.join(this.supportDir, 'discovery.json'), 'utf8')) as { door_origin?: unknown };
      lifecycle.doorOriginEquality = typeof discovery.door_origin === 'string' && discovery.door_origin === this.origin;
    } catch {
      lifecycle.doorOriginEquality = undefined;
    }
  }

  async stopRuntime(): Promise<void> {
    if (this.attachment) return;
    await stopGroup(this.runtime);
    this.runtime = undefined;
  }

  /** Stops the daemon and starts it again on a different port, as the launcher's fresh start does. */
  async restartRuntime(): Promise<{ oldPort: number; oldInstanceId: string }> {
    const previous = { oldPort: this.runtimePort, oldInstanceId: this.runtimeInstanceId };
    await this.stopRuntime();
    let port = await freePort();
    while (port === previous.oldPort) port = await freePort();
    await this.startRuntime(port);
    return previous;
  }

  get runtimeRunning() { return Boolean(this.runtime && this.runtime.child.exitCode === null); }

  get runtimePid(): number | undefined { return this.runtime?.child.pid; }

  get hungStackTargets(): StackTarget[] {
    const pid = this.runtime?.child.pid;
    const runId = this.hungStackRunId;
    if (!pid || !runId) return [];
    const incarnation = linuxProcessInspector(pid);
    return incarnation ? [{ role: 'runtime-daemon', pid, incarnation, runId, owned: true, supervised: true }] : [];
  }

  /** Attach D79 to real Playwright request lifecycle events; no URL or request payload is retained. */
  installHungRequestCapture(page: Parameters<typeof attachPlaywrightRuntimeLifecycle>[0]['page']): () => void {
    if (!this.hungStackCapture) return () => {};
    return attachPlaywrightRuntimeLifecycle({
      page,
      capture: this.hungStackCapture,
      source: 'app-runtime',
      targets: () => this.hungStackTargets,
      isRuntimeRequest: (request) => {
        try { return new URL(request.url()).pathname.startsWith(`${this.doorPrefix}/v1/`); } catch { return false; }
      },
    });
  }

  get lifecycleObservation(): RuntimeLifecycleObservation | undefined {
    return this.runtimeLifecycle ? { ...this.runtimeLifecycle, failure: this.runtimeLifecycle.failure && { ...this.runtimeLifecycle.failure } } : undefined;
  }

  get runtimeUrl() { return this.attachment ? this.discovery().endpoint.replace(/\/$/, '') : `http://127.0.0.1:${this.runtimePort}`; }

  /** A request straight to the Runtime with the product credential (the "direct" side of every comparison). */
  async runtimeFetch(pathAndQuery: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    return fetch(`${this.runtimeUrl}${pathAndQuery}`, { ...init, headers: { Authorization: `Bearer ${this.productToken}`, ...init.headers } });
  }

  async runtimeJson<T = any>(method: string, pathAndQuery: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const response = await this.runtimeFetch(pathAndQuery, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' ? {} : { 'Idempotency-Key': randomUUID() }), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) as T };
  }

  /**
   * A credential for `actorId`, minted through the Runtime's own route with the owner credential and written to
   * `<tmp>/<file>` as the Runtime door's version 1 scoped JSON product credential, mode 0600.
   * Returns the token; it never leaves Node memory and that file, and the hosted server serves neither.
   */
  async provisionCredential(actorId: string, file: string): Promise<string> {
    const owner = readFileSync(path.join(this.supportDir, 'credentials', 'owner.token'), 'utf8').trim();
    const token = `${actorId.slice(0, 8)}-${randomBytes(24).toString('base64url')}`;
    const response = await fetch(`${this.runtimeUrl}/v1/credentials`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor_id: actorId, credential: token, scope: 'astrid' }),
    });
    if (response.status !== 201) throw new Error(`credential provisioning for ${actorId} failed: ${response.status} ${await response.text()}`);
    writeFileSync(path.join(this.tmp, file), JSON.stringify({ version: 1, scope: 'astrid', token, actor_id: actorId }), { mode: 0o600 });
    return token;
  }

  /** Initialize the common empty timeline or author the Gate-5 closure through the provider. */
  private async commitNativeSeed(payload: Record<string, unknown>): Promise<{ revisionId: string; publicationId: string }> {
    const python = this.authoringPython;
    if (!python) throw new Error('native seed requires the authoring Runtime');
    const credential = path.join(this.tmp, 'three-products-seed-credential.json');
    await this.provisionCredential(ASTRID_ACTOR, path.basename(credential));
    const script = String.raw`
import copy, hashlib, json, sys
from pathlib import Path
from astrid.sdk.client import AstridClient
from astrid.sdk.timeline.capture import capture_track_create
from astrid.sdk.timeline.commands import execute
from astrid.sdk.timeline.commit import bundle_from_document, document_from_bundle
from astrid.sdk.timeline.emitter import emit_document_commands
from astrid.sdk.timeline.native_initialize import capture_initialize
from astrid.sdk.timeline.native_occurrence_create import capture_occurrence_create
from astrid.sdk.timeline.native_occurrence_media_commands import capture_occurrence_add_media
from astrid.sdk.timeline.native_parent_media_commands import capture_clip_add_media

case = json.loads(sys.argv[1])
client = AstridClient.open(endpoint=case['endpoint'], credential=Path(case['credential']),
                           realm_id=case['realm_id'], actor_id=case['actor_id'],
                           client_name='journey-seed', client_version='1', protocol_version='workspace.v1')
opened = client.timelines.open_bundle(case['project_id'], case['timeline_id'], revision_id=case['head_revision_id'], publication_id=case['base_publication_id'])
if not opened.ok:
    raise RuntimeError(str(opened.error))
bundle = opened.data['bundle']
commands = []
verified = [item['verified'] for item in case.get('media', {}).values()]
pins = {key: item['pin'] for key, item in case.get('media', {}).items()}

def add(command):
    global bundle
    commands.append(command)
    bundle = execute(bundle, [command], verified_media=verified).bundle

if case['initialize']:
    add(capture_initialize(bundle, name='Main', slug='main', output={
        'resolution': '1280x720', 'fps': 30, 'file': 'output.mp4',
        'background': None, 'background_scale': None,
    }))
if not any(track.get('id') == 'V1' for track in bundle['parent']['config']['tracks']):
    add(capture_track_create(bundle, 'parent', {'id': 'V1', 'kind': 'visual', 'label': 'V1'}))
assert any(track.get('id') == 'V1' and track.get('kind') == 'visual' and track.get('label') == 'V1'
           for track in bundle['parent']['config']['tracks'])
if case['fixture'] == 'three-products':
    add(capture_track_create(bundle, 'parent', {'id': 'S1', 'kind': 'visual', 'label': 'S1'}))
    add(capture_clip_add_media(bundle, {
        'id': 'f2-app-clip', 'at': 0, 'track': 'V1', 'clipType': 'image',
        'asset': 'f2-app', 'hold': 3,
    }, pins['f2-app'], verified_media=verified))
    transition = {
        'id': 'f2-transition-clip', 'at': case['reference_at'], 'track': 'V1',
        'clipType': 'video', 'asset': 'f2-video', 'from': 0, 'to': 3, 'hold': 3,
        'speed': 1,
    }
    add(capture_clip_add_media(bundle, transition, pins['f2-video'], verified_media=verified))
    add(capture_occurrence_create(bundle, 'f2-occurrence', 'f2-shot', name='F2 agent shot', track='S1', on=0, duration=case['occurrence_host_window']))
    add(capture_track_create(bundle, 'occurrence:f2-occurrence', {'id': 'plate', 'kind': 'visual', 'label': 'plate'}))
    add(capture_track_create(bundle, 'occurrence:f2-occurrence', {'id': 'V2', 'kind': 'visual', 'label': 'V2'}))
    for row, key in [
        ({'id': 'f2-plate', 'at': 0, 'track': 'plate', 'clipType': 'image', 'asset': 'f2-plate', 'hold': case['occurrence_host_window']}, 'f2-plate'),
        ({'id': 'f2-agent-clip', 'at': 3, 'track': 'V2', 'clipType': 'image', 'asset': 'f2-placeholder', 'hold': 3}, 'f2-placeholder'),
        ({'id': 'f2-agent-clear-clip', 'at': 6, 'track': 'V2', 'clipType': 'image', 'asset': 'f2-clear', 'hold': 3}, 'f2-clear'),
    ]:
        row['asset'] = pins[key]['asset']
        add(capture_occurrence_add_media(bundle, 'occurrence:f2-occurrence', row, pins[key], verified_media=verified))

    def asset(source, pin):
        row = {'file': source['file'], 'type': source['type'], 'media_id': source['object_id'],
               'content_sha256': source['digest'],
               'generationId': pin['generation_id'], 'variantId': pin['variant_id']}
        return row

    image = case['image']
    video = case['video']
    parent_clips = [
        {'id': 'f2-app-clip', 'at': 0, 'track': 'V1', 'clipType': 'media', 'asset': 'f2-app', 'from': 0, 'to': 3, 'speed': 1},
        {'id': 'f2-transition-clip', 'at': case['reference_at'], 'track': 'V1', 'clipType': 'media', 'asset': 'f2-video', 'from': 0, 'to': 3, 'speed': 1, 'transition': {'type': 'crossfade', 'duration': 0.5}},
    ]
    if case['transitions'] == 'native-none':
        parent_clips[0].update(json.loads('{"opaqueClip":{"nullable":null,"ordered":[false,0,"",[],{"z":2,"a":1}]},"transition":{"type":"crossfade","duration":0.5,"revision":"native-none-unknown-revision","params":{"nullable":null,"__proto__":{"literal":true},"constructor":{"prototype":[null,false]}},"future":{"ordered":[null,0,false]},"__proto__":{"outer":true},"prototype":false}}'))
    elif case['transitions'] == 'parent-delete':
        parent_clips[1].pop('transition', None)
    parent_registry = {
        'f2-app': asset({'file': 'f2-app.png', 'type': 'image/png', 'object_id': image['object_id'], 'digest': image['digest']}, pins['f2-app']),
        'f2-video': asset({'file': video['file'], 'type': video['media_type'], 'object_id': video['object_id'], 'digest': video['digest']}, pins['f2-video']),
    }
    parent_registry['f2-video']['duration'] = 12.0
    # Retain the original authored fixture independently of the native candidate.
    expected_parent = {'slug': 'main', 'name': 'Main', 'config': {'clips': copy.deepcopy(parent_clips),
        'tracks': [
            {'id': 'V1', 'kind': 'visual', 'scale': 1, 'fit': 'contain', 'opacity': 1, 'blendMode': 'normal', 'label': 'V1'},
            {'id': 'A1', 'kind': 'audio', 'scale': 1, 'fit': 'contain', 'opacity': 1, 'blendMode': 'normal', 'label': 'A1'},
            {'id': 'S1', 'kind': 'visual', 'scale': 1, 'fit': 'contain', 'opacity': 1, 'blendMode': 'normal', 'label': 'S1'},
        ],
        'output': {'resolution': '1280x720', 'fps': 30, 'file': 'out.mp4'},
        'x_f2_opaque': case['opaque']['config'],
        'app': {'haus.astrid.scene-phase-markers': {'sceneMarkers': [{'id': 'ordinary-marker-a', 'time': 1}, {'id': 'ordinary-marker-b', 'time': 6}]}},
    },
        'clips': copy.deepcopy(parent_clips), 'registry': {'assets': parent_registry}}
    expected_shot = {'metadata': {'title': 'F2 agent shot'}, 'items': [], 'pools': [], 'selected_variants': {},
        'provenance': {}, 'generation_inputs': {}, 'audio_bindings': [], 'text_bindings': [],
        'x_f2_opaque': case['opaque']['shot']}
    expected_internal = {
        'tracks': [{'id': 'plate', 'kind': 'visual', 'label': 'plate'}, {'id': 'V2', 'kind': 'visual', 'label': 'V2'}],
        'clips': [
        {'id': 'f2-plate', 'at': 0, 'track': 'plate', 'clipType': 'media', 'asset': 'f2-plate', 'hold': case['occurrence_host_window']},
        {'id': 'f2-agent-clip', 'at': 3, 'track': 'V2', 'clipType': 'media', 'asset': 'f2-placeholder', 'hold': 3, 'app': {'f2Opaque': case['opaque']['clip']}},
        {'id': 'f2-agent-clear-clip', 'at': 6, 'track': 'V2', 'clipType': 'media', 'asset': 'f2-clear', 'hold': 3},
        ],
        'registry': {'assets': {
        key: asset({'file': key + '.png', 'type': 'image/png', 'object_id': image['object_id'], 'digest': image['digest']}, pins[key])
        for key in ('f2-plate', 'f2-placeholder', 'f2-clear')
        }},
        'effects': [], 'audio': [], 'layout': {}, 'assets': [],
    }
    expected_occurrence = {'occurrence_id': 'f2-occurrence', 'shot_id': 'f2-shot',
        'placement': {'start_ms': 0}, 'source_offset': 0, 'duration_ms': case['occurrence_host_window'] * 1000, 'speed': 1,
        'track': 'S1', 'transform': {}, 'gain': 1, 'mute': False, 'provenance': {}}
    occurrence = document_from_bundle(bundle)['parent_revision']['payload']['occurrences'][0]
    # Author occurrence fields through guarded paths, retaining provider-owned edges.
    add({'schema_version': 1, 'op': 'doc.patch', 'version': '1', 'select': None, 'args': {'changes': [
        {'op': 'set', 'ref': 'parent', 'path': ['occurrences', 'occurrence_id:f2-occurrence', key],
         'before': {'state': 'present', 'value': copy.deepcopy(occurrence[key])} if key in occurrence else {'state': 'absent'},
         'value': copy.deepcopy(value)}
        for key, value in expected_occurrence.items() if key not in ('occurrence_id', 'shot_id')
    ]}})
    before = copy.deepcopy(bundle)
    after = copy.deepcopy(bundle)
    after['parent'] = copy.deepcopy(expected_parent)
    after['shots']['f2-shot']['payload'] = copy.deepcopy(expected_shot)
    after['shots']['f2-shot']['internal_timeline'] = copy.deepcopy(expected_internal)
    patches = emit_document_commands(before, after)
    if patches:
        bundle = execute(before, patches, verified_media=verified).bundle
        commands.extend(patches)
else:
    before = copy.deepcopy(bundle)
    after = copy.deepcopy(bundle)
    # Preserve Runtime-owned bootstrap tracks, including their normalized defaults.
    expected_parent = {'slug': 'main', 'name': 'Main', 'registry': {'assets': {}}, 'clips': [],
                       'config': {'output': {'resolution': '1280x720', 'fps': 30, 'file': 'out.mp4'},
                                 'clips': [], 'tracks': copy.deepcopy(before['parent']['config']['tracks'])}}
    after['parent'] = copy.deepcopy(expected_parent)
    for command in emit_document_commands(before, after):
        add(command)

label = 'Seed three products' if case['fixture'] == 'three-products' else 'Initialize journey timeline'
scope_reads = [{'kind': 'scope', 'ref': 'timeline', 'path': []}]
steps = [{'id': 'seed-' + str(ordinal), 'label': command['op'], 'intent': label, 'tags': [],
          'command_ordinals': [ordinal],
          'patch': copy.deepcopy(command['args']['changes']) if command['op'] == 'doc.patch' else [],
          'reads': copy.deepcopy(scope_reads)} for ordinal, command in enumerate(commands)]
body = {'api_version': 1, 'project_id': case['project_id'], 'timeline_id': case['timeline_id'],
        'base_revision_id': case['head_revision_id'], 'base_publication_id': case['base_publication_id'],
        'commands': commands, 'label': label, 'steps': steps, 'merge': 'atomic',
        'reads': scope_reads, 'dry_run': False, 'source': {'via': 'python'}}
with open(case['acceptance_file'], 'w') as stream:
    json.dump({'request': body, 'idempotency_key': case['idempotency_key']}, stream)
result = client.timelines.commit(case['project_id'], case['timeline_id'], body, idempotency_key=case['idempotency_key'])
if not result.ok:
    raise RuntimeError(str(result.error))
from astrid.core.receipts.canonical import canonical_json
accepted = result.as_dict()
data, receipt = accepted['data'], accepted['receipt']
with open(case['acceptance_file'], 'w') as stream:
    json.dump({'request': body, 'idempotency_key': case['idempotency_key'], **accepted}, stream)
assert data['status'] == 'accepted', data
assert receipt['result'] == data and receipt['idempotency_key'] == case['idempotency_key']
assert data['base_revision_id'] == data['previous_revision_id'] == case['head_revision_id']
assert data['base_publication_id'] == data['previous_publication_id'] == case['base_publication_id']
assert receipt['receipt_id'] and receipt['receipt_id'] != case['base_publication_id']
assert receipt['command_kind'] == 'timeline.commit' and receipt['project_id'] == case['project_id']
assert data['publisher'] == case['actor_id'] and data['rebased_onto'] is None
invocation = {'operation': 'commitTimeline', 'path': case['commit_path'], 'publisher': case['actor_id'], 'request': body}
assert receipt['request_hash'] == hashlib.sha256(canonical_json(invocation).encode()).hexdigest()
document = data['canonical_document']
assert document['project_id'] == case['project_id'] and document['timeline_id'] == case['timeline_id']
assert document['parent_revision']['revision_id'] == data['accepted_revision_id']
assert data['document_digest'] == 'sha256:' + hashlib.sha256(canonical_json(document).encode()).hexdigest()
bundle_from_document(document)  # Verify the returned raw closure, content digests and manifest pins.
assert data['steps'] and data['commands'] and data['merge_mode'] == 'atomic'
raw_parent = copy.deepcopy(document['parent_revision']['payload'])
raw_occurrences = raw_parent.pop('occurrences')
assert canonical_json(raw_parent) == canonical_json(expected_parent), 'seed changed authored parent payload'
if case['fixture'] == 'three-products':
    assert len(raw_occurrences) == len(document['shot_revisions']) == len(document['internal_timeline_revisions']) == 1
    raw_occurrence = copy.deepcopy(raw_occurrences[0])
    raw_shot, raw_internal = document['shot_revisions'][0], document['internal_timeline_revisions'][0]
    assert raw_occurrence.pop('shot_revision_id') == raw_shot['revision_id']
    assert canonical_json(raw_occurrence) == canonical_json(expected_occurrence), 'seed changed authored occurrence'
    expected_shot_payload = {**expected_shot, 'internal_timeline_revision_id': raw_internal['revision_id']}
    assert raw_shot['shot_id'] == 'f2-shot' and raw_internal['timeline_id'] == case['timeline_id']
    assert canonical_json(raw_shot['payload']) == canonical_json(expected_shot_payload), 'seed changed authored shot payload'
    assert canonical_json(raw_internal['payload']) == canonical_json(expected_internal), 'seed changed authored internal payload'
else:
    assert raw_occurrences == document['shot_revisions'] == document['internal_timeline_revisions'] == []
print(json.dumps({'revisionId': data['accepted_revision_id'], 'publicationId': receipt['receipt_id']}))
`;
    const output = execFileSync(python, ['-c', script, JSON.stringify({ ...payload, credential, endpoint: this.runtimeUrl, realm_id: this.realmId, actor_id: ASTRID_ACTOR, commit_path: `/v1/projects/${payload.project_id}/timelines/${payload.timeline_id}/commit`, acceptance_file: path.join(this.tmp, `seed-${payload.idempotency_key}-accepted.json`) })], {
      cwd: this.tmp, env: this.runtimeEnv(), encoding: 'utf8', timeout: 120_000,
    });
    const result = JSON.parse(output.trim().split('\n').pop() ?? '{}') as { revisionId: string; publicationId: string };
    if (!result.revisionId || !result.publicationId) throw new Error(`native seed returned no head pair: ${output}`);
    return result;
  }

  /**
   * What the Runtime last published about itself (`<support>/discovery.json`, rewritten on every start). Every Astrid call
   * re-reads it, so a restarted Runtime on a new port is followed with no special case. Throws when it is absent or unparsable.
   */
  discovery(): RuntimeDiscovery {
    const parsed = JSON.parse(readFileSync(this.attachment?.discoveryFile ?? path.join(this.supportDir, 'discovery.json'), 'utf8'));
    for (const key of ['endpoint', 'active_realm', 'runtime_instance_id', 'worker_credential_file', 'worker_actor'] as const) {
      if (typeof parsed[key] !== 'string' || !parsed[key]) throw new Error(`discovery.json has no ${key}`);
    }
    return parsed as RuntimeDiscovery;
  }

  private async seedRuntime(deferTimelineInitialization = false): Promise<Seed> {
    const projectName = `Direct Journey ${randomBytes(3).toString('hex')}`;
    const project = await this.runtimeJson('POST', '/v1/projects', { name: projectName });
    if (project.status !== 201) throw new Error(`seed project: ${project.status} ${JSON.stringify(project.body)}`);
    const projectId: string = project.body.data.project_id;
    const timelineId = randomUUID();
    const python = process.env.ASTRID_PYTHON ?? path.resolve(process.env.ASTRID_CHECKOUT ?? path.join(REPO_ROOT, '..', 'astrid-agent'), '.venv/bin/python');
    await this.enableTimelineAuthoring(python);
    const created = await this.runtimeJson('POST', `/v1/projects/${projectId}/timelines`, { timeline_id: timelineId, name: 'Main' });
    if (created.status !== 201) throw new Error(`seed timeline: ${created.status} ${JSON.stringify(created.body)}`);
    const timeline = await this.runtimeJson('GET', `/v1/projects/${projectId}/timelines/${timelineId}`);
    if (timeline.status !== 200) throw new Error(`seed head: ${timeline.status} ${JSON.stringify(timeline.body)}`);
    const { head_revision_id: revisionId, head_publication_id: publicationId } = timeline.body;
    if (typeof revisionId !== 'string' || !revisionId || typeof publicationId !== 'string' || !publicationId) throw new Error('seed timeline has no Runtime head pair');
    // P3 initializes this pristine shell once with its complete authored fixture. Other callers receive the original empty config.
    const head = deferTimelineInitialization ? { revisionId, publicationId } : await this.commitNativeSeed({
      fixture: 'empty', initialize: true, project_id: projectId, timeline_id: timelineId, head_revision_id: revisionId,
      base_publication_id: publicationId, idempotency_key: randomUUID(),
    });
    this.seedInitialized = !deferTimelineInitialization;
    this.seedHead = head;
    const ingest = async (data: Buffer, mediaType: string, filename: string): Promise<SeededObject> => {
      const response = await this.runtimeFetch(`/v1/projects/${projectId}/objects`, { method: 'POST', headers: { 'Content-Type': mediaType, 'Idempotency-Key': randomUUID(), 'X-Original-Name': filename }, body: new Uint8Array(data) });
      if (response.status !== 201 && response.status !== 200) throw new Error(`seed ${filename}: ${response.status} ${await response.text()}`);
      const body = await response.json();
      if (body.data.digest !== sha256Hex(data)) throw new Error(`seed ${filename}: Runtime digest differs from local digest`);
      return { objectId: body.data.object_id, digest: body.data.digest, size: data.length, mediaType };
    };
    const video = makeVideo(this.tmp);
    const big = randomBytes(BIG_DOWNLOAD_BYTES);
    return {
      projectId, projectName, timelineId,
      headRevisionId: head.revisionId,
      image: await ingest(makePng(), 'image/png', 'gradient.png'),
      video: { ...(await ingest(video.data, video.mediaType, `clip.${video.mediaType === 'video/webm' ? 'webm' : 'mp4'}`)), decodable: video.decodable },
      big: await ingest(big, 'application/octet-stream', 'big-60mb.bin'),
    };
  }

  /**
   * A second timeline in the seeded project for the pack extensions, made on first use (after the cases that open the
   * seeded timeline, so none of them sees a second timeline): one media clip with a transcript lane over it, and one
   * live-scene clip whose package is a Runtime project object, published as one composition revision.
   */
  async seedExtensions(): Promise<ExtensionsSeed> {
    if (this.extensionsSeed) return this.extensionsSeed;
    const { projectId, video } = this.seed;
    const project = await this.runtimeJson('GET', `/v1/projects/${projectId}`);
    if (project.status !== 200) throw new Error(`seed extensions project: ${project.status} ${JSON.stringify(project.body)}`);
    const ingest = async (text: string, mediaType: string, filename: string): Promise<SeededObject & { filename: string }> => {
      const data = Buffer.from(text, 'utf8');
      const response = await this.runtimeFetch(`/v1/projects/${projectId}/objects`, { method: 'POST', headers: { 'Content-Type': mediaType, 'Idempotency-Key': randomUUID(), 'X-Original-Name': filename }, body: new Uint8Array(data) });
      if (response.status !== 201 && response.status !== 200) throw new Error(`seed ${filename}: ${response.status} ${await response.text()}`);
      const body = await response.json();
      if (body.data.digest !== sha256Hex(data)) throw new Error(`seed ${filename}: Runtime digest differs from local digest`);
      return { objectId: body.data.object_id, digest: body.data.digest, size: data.length, mediaType, filename };
    };
    const html = sceneEntryHtml();
    const entry = await ingest(html, 'text/html', 'scene.html');
    // The package object: validateScenePackage (ui/threejs-live-editor/runtime.ts) wants the manifest, the entry's object metadata and an assets array.
    const packageBody = JSON.stringify({
      manifest: { formatVersion: 1, entry: 'scene.html', duration: 5, authoredFps: 30 },
      entry: { object_id: entry.objectId, digest: entry.digest, media_type: entry.mediaType, size: entry.size, filename: entry.filename },
      assets: [],
    });
    const scenePackage = await ingest(packageBody, 'application/json', 'scene.package.json');
    const liveScene = { revision: scenePackage.digest, source: { objectId: scenePackage.objectId, revision: scenePackage.digest }, packageBody, html };

    const transcriptTexts = ['Words arrive through the door', 'then the lane draws them', 'one chip for each segment'];
    const assetKey = 'journey-speech';
    const bundle = {
      schema_version: 1,
      itemsBySchemaRef: {
        'astrid.transcript_segment/v1': transcriptTexts.map((text, index) => ({
          id: `transcript-source:${assetKey}:segment:${index}`,
          shape: 'interval', domain: 'source_seconds', extent: { start: index * 2, end: index * 2 + 2 },
          schemaRef: 'astrid.transcript_segment/v1',
          payload: { text },
          sourceArtifactRef: { assetId: assetKey },
          provenance: { adapterId: 'astrid.adaptTranscript', adapterVersion: '2' },
        })),
      },
    };
    const sceneClipId = 'journey-scene-clip';
    const speechClipId = 'journey-speech-clip';
    const clips = [
      // The scene fills the first five seconds; the media clip (the transcript's carrier) follows it on the same track.
      { id: sceneClipId, at: 0, track: 'V1', clipType: 'haus.astrid.liveScene', from: 0, to: 5, speed: 1, app: { liveScene } },
      { id: speechClipId, at: 5, track: 'V1', clipType: 'media', asset: assetKey, from: 0, to: 6, speed: 1 },
    ];
    const registry = { assets: { [assetKey]: { file: 'journey-speech.webm', type: 'video', duration: 12, media_id: video.objectId, content_sha256: video.digest } } };
    const timelineId = randomUUID();
    const publication = compositionPublication({ projectId, timelineId }, null, 'Extensions', 30);
    publication.parent_composition.config = { ...publication.parent_composition.config, clips, bundle } as typeof publication.parent_composition.config;
    publication.parent_composition.clips = clips as unknown as typeof publication.parent_composition.clips;
    publication.parent_composition.registry = registry as unknown as typeof publication.parent_composition.registry;
    const published = await this.runtimeJson('POST', `/v1/projects/${projectId}/timelines/${timelineId}/composition-revisions`, publication);
    if (published.status !== 200) throw new Error(`seed extensions timeline: ${published.status} ${JSON.stringify(published.body)}`);
    this.extensionsSeed = { projectSlug: (project.body.data ?? project.body).slug, timelineId, transcriptTexts, sceneClipId, speechClipId, sceneMarker: SCENE_MARKER, scenePackage, sceneEntry: entry };
    return this.extensionsSeed;
  }

  /**
   * A timeline in the seeded project whose two clips use the seeded image and video objects (registry `media_id`), made on first
   * use after the cases that open the seeded timeline (like `seedExtensions`, so none of them sees another timeline). The editor
   * resolves each asset to a door object URL and draws the image clip's thumbnail from it.
   */
  async seedMedia(): Promise<MediaSeed> {
    if (this.mediaSeed) return this.mediaSeed;
    const { projectId, image, video } = this.seed;
    const project = await this.runtimeJson('GET', `/v1/projects/${projectId}`);
    if (project.status !== 200) throw new Error(`seed media project: ${project.status} ${JSON.stringify(project.body)}`);
    const imageKey = 'journey-image';
    const videoKey = 'journey-video';
    const imageClipId = 'journey-image-clip';
    const videoClipId = 'journey-video-clip';
    const clips = [
      { id: imageClipId, at: 0, track: 'V1', clipType: 'media', asset: imageKey, from: 0, to: 5, speed: 1 },
      { id: videoClipId, at: 5, track: 'V1', clipType: 'media', asset: videoKey, from: 0, to: 5, speed: 1 },
    ];
    const registry = {
      assets: {
        [imageKey]: { file: 'journey-image.png', type: 'image/png', media_id: image.objectId, content_sha256: image.digest },
        [videoKey]: { file: `journey-video.${video.mediaType === 'video/webm' ? 'webm' : 'mp4'}`, type: video.mediaType, duration: 12, media_id: video.objectId, content_sha256: video.digest },
      },
    };
    const timelineId = randomUUID();
    const publication = compositionPublication({ projectId, timelineId }, null, 'Media', 30);
    publication.parent_composition.config = { ...publication.parent_composition.config, clips } as typeof publication.parent_composition.config;
    publication.parent_composition.clips = clips as unknown as typeof publication.parent_composition.clips;
    publication.parent_composition.registry = registry as unknown as typeof publication.parent_composition.registry;
    const published = await this.runtimeJson('POST', `/v1/projects/${projectId}/timelines/${timelineId}/composition-revisions`, publication);
    if (published.status !== 200) throw new Error(`seed media timeline: ${published.status} ${JSON.stringify(published.body)}`);
    this.mediaSeed = { projectSlug: (project.body.data ?? project.body).slug, timelineId, imageClipId, videoClipId };
    return this.mediaSeed;
  }

  /**
   * The three-product seed, made once on first use: the next revision of the harness's own seeded timeline (so the editor still
   * opens the only project and timeline by itself), with one clip per writer so a correct merge never touches the same clip twice,
   * and two opaque fields neither client models (`config.x_f2_opaque`, and `app.f2Opaque` on the agent's clip).
   *
   * Two kinds of clip, because the two products reach different ones. The App edits the parent composition's own clips
   * (`f2-app-clip`, `f2-transition-clip`, track `V1`, drawn as clips). The Astrid CLI addresses only clips inside a placed shot's
   * internal timeline (astrid/sdk/timeline/lookup.py `clips`), so the agent's clips (`f2-agent-clip`, `f2-agent-clear-clip`) live in
   * the shot `f2-shot` (occurrence on parent track `S1`, with the finite host window supplied to the seed), which the App draws as one block, not as its clips. The shot
   * also holds a full-length `f2-plate` so the film stays covered when the agent clears an asset (Astrid refuses to publish a gap).
   */
  async seedThreeProducts(referenceAt = THREE_PRODUCTS_REFERENCE_AT, transitions: 'ordinary' | 'native-none' | 'parent-delete' = 'ordinary', occurrenceHostWindow = 12): Promise<ThreeProductsSeed> {
    if (this.threeProductsSeed) return this.threeProductsSeed;
    const { projectId, timelineId, image, video } = this.seed;
    const project = await this.runtimeJson('GET', `/v1/projects/${projectId}`);
    if (project.status !== 200) throw new Error(`seed three products project: ${project.status} ${JSON.stringify(project.body)}`);
    const authoringPython = process.env.ASTRID_PYTHON ?? path.resolve(process.env.ASTRID_CHECKOUT ?? path.join(REPO_ROOT, '..', 'astrid-agent'), '.venv/bin/python');
    await this.enableTimelineAuthoring(authoringPython);
    const timeline = await this.runtimeJson('GET', `/v1/projects/${projectId}/timelines/${timelineId}`);
    if (timeline.status !== 200) throw new Error(`read three-products bootstrap: ${timeline.status} ${JSON.stringify(timeline.body)}`);
    const bootstrapHead = (timeline.body as any).head_revision_id;
    if (typeof bootstrapHead !== 'string' || !bootstrapHead) throw new Error(`three-products bootstrap has no canonical head: ${JSON.stringify(timeline.body)}`);
    const bootstrapPublication = (timeline.body as any).head_publication_id;
    if (typeof bootstrapPublication !== 'string' || !bootstrapPublication) throw new Error(`three-products bootstrap has no canonical publication: ${JSON.stringify(timeline.body)}`);
    if (this.seedHead?.revisionId !== bootstrapHead || this.seedHead.publicationId !== bootstrapPublication) throw new Error('three-products initialization base changed after common bootstrap');

    const importManaged = async (source: SeededObject & { decodable?: boolean }, filename: string, duration?: number) => {
      const object = await this.runtimeFetch(`/v1/objects/${encodeURIComponent(source.objectId)}`);
      if (object.status !== 200) throw new Error(`read three-products media ${filename}: ${object.status}`);
      const imported = await this.runtimeFetch(`/v1/projects/${projectId}/media-imports`, {
        method: 'POST',
        headers: { 'Content-Type': source.mediaType, 'Idempotency-Key': randomUUID(), 'X-Original-Name': filename, ...(duration === undefined ? {} : { 'X-Media-Duration-Seconds': String(duration) }) },
        body: new Uint8Array(await object.arrayBuffer()),
      });
      const importedBody = await imported.json() as any;
      if (imported.status !== 201) throw new Error(`import three-products media ${filename}: ${imported.status} ${JSON.stringify(importedBody)}`);
      const importedData = importedBody.data ?? importedBody;
      const selection = await this.runtimeJson('GET', `/v1/projects/${projectId}/media-selection?asset=${encodeURIComponent(importedData.variant_id)}&generation_id=${encodeURIComponent(importedData.generation_id)}&variant_id=${encodeURIComponent(importedData.variant_id)}`);
      if (selection.status !== 200) throw new Error(`select three-products media ${filename}: ${selection.status} ${JSON.stringify(selection.body)}`);
      const pin = (selection.body as any).data ?? selection.body;
      if (pin.object_id !== source.objectId || pin.asset !== importedData.variant_id) throw new Error(`three-products media selection changed ${filename}: ${JSON.stringify(pin)}`);
      const verified = await this.runtimeJson('GET', `/v1/projects/${projectId}/media-selection/verified?asset=${encodeURIComponent(pin.asset)}&generation_id=${encodeURIComponent(pin.generation_id)}&variant_id=${encodeURIComponent(pin.variant_id)}&object_id=${encodeURIComponent(pin.object_id)}&catalog_digest=${encodeURIComponent(pin.catalog_digest)}`);
      if (verified.status !== 200) throw new Error(`verify three-products media ${filename}: ${verified.status} ${JSON.stringify(verified.body)}`);
      return { pin, verified: (verified.body as any).data ?? verified.body };
    };
    const imageMedia = await importManaged(image, 'f2-image.png');
    const videoMedia = await importManaged(video, `f2-video.${video.mediaType === 'video/webm' ? 'webm' : 'mp4'}`, 12);
    const ids = { appClipId: 'f2-app-clip', agentClipId: 'f2-agent-clip', transitionClipId: 'f2-transition-clip', agentClearClipId: 'f2-agent-clear-clip' };
    const markerAssetKey = 'f2-marker';
    const shotId = 'f2-shot';
    const head = await this.commitNativeSeed({
      fixture: 'three-products', initialize: !this.seedInitialized,
      project_id: projectId, timeline_id: timelineId, head_revision_id: bootstrapHead,
      base_publication_id: bootstrapPublication,
      reference_at: referenceAt, transitions, occurrence_host_window: occurrenceHostWindow,
      image: { file: 'f2-image.png', type: image.mediaType, object_id: image.objectId, digest: image.digest },
      video: { file: `f2-video.${video.mediaType === 'video/webm' ? 'webm' : 'mp4'}`, media_type: video.mediaType, object_id: video.objectId, digest: video.digest },
      media: { 'f2-app': imageMedia, 'f2-plate': imageMedia, 'f2-placeholder': imageMedia, 'f2-clear': imageMedia, 'f2-video': videoMedia },
      opaque: { config: THREE_PRODUCTS_OPAQUE.config, clip: THREE_PRODUCTS_OPAQUE.clip, shot: THREE_PRODUCTS_OPAQUE.shot },
      idempotency_key: randomUUID(),
    });
    this.seedInitialized = true;
    this.seedHead = head;
    this.threeProductsSeed = {
      projectSlug: (project.body.data ?? project.body).slug, timelineId, headRevisionId: head.revisionId,
      ...ids, shotId, occurrenceId: 'f2-occurrence', markerAssetKey, opaque: { config: { ...THREE_PRODUCTS_OPAQUE.config }, clip: { ...THREE_PRODUCTS_OPAQUE.clip }, shot: { ...THREE_PRODUCTS_OPAQUE.shot } },
    };
    return this.threeProductsSeed;
  }

  /** Fresh project for the editor's first-timeline browser journey. */
  async createFreshProject(name = 'First timeline drop'): Promise<{ projectId: string; name: string }> {
    const created = await this.runtimeJson('POST', '/v1/projects', { name });
    if (created.status !== 201) throw new Error(`create fresh project: ${created.status} ${JSON.stringify(created.body)}`);
    return { projectId: created.body.data.project_id, name };
  }

  /**
   * The render journey's timeline, a second timeline in the seeded project made on first use (after the cases that open the
   * seeded timeline, so none of them sees another timeline). The editor opens it from the "Select timeline" combobox.
   *
   * Parent: a visual track `S1` that hosts one occurrence of the shot over the whole film (0 s to 6 s), and an audio track `A1`
   * with a 6 s 440 Hz Opus tone. The shot's internal timeline is one visual track `V2` of three VP8 clips, each with `from`/`to`
   * bounds: a test pattern (0 s to 2 s), the slot `f2-render-slot` on a solid grey placeholder (2 s to 4 s), and the test
   * pattern again (4 s to 6 s). The two cut frames (2 s and 4 s) declare nothing: the Runtime's seam check only advises render admission
   * (it reports in `timeline_authority.visual_seam_report` and never blocks), so the render is not held up by them. Media are real: ffmpeg is required and there is no stand-in file.
   */
  async seedRenderTimeline(): Promise<RenderSeed> {
    if (this.renderSeed) return this.renderSeed;
    const { projectId } = this.seed;
    const project = await this.runtimeJson('GET', `/v1/projects/${projectId}`);
    if (project.status !== 200) throw new Error(`seed render project: ${project.status} ${JSON.stringify(project.body)}`);
    const dir = path.join(this.tmp, 'render-media');
    mkdirSync(dir, { recursive: true });
    const pattern = path.join(dir, 'pattern.webm');
    const grey = path.join(dir, 'placeholder.webm');
    const tone = path.join(dir, 'tone.webm');
    const { r, g, b } = RENDER_GREY;
    const hex = [r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('');
    ffmpegOrFail(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=6', '-vf', BT601_FILTER, '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-b:v', '1M', '-g', '30', ...BT601_TAGS, pattern], 'the test pattern video');
    ffmpegOrFail(['-f', 'lavfi', '-i', `color=c=0x${hex}:s=640x360:r=30:d=4`, '-vf', BT601_FILTER, '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-b:v', '500k', '-g', '30', ...BT601_TAGS, grey], 'the grey placeholder video');
    ffmpegOrFail(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'libopus', tone], 'the 440 Hz tone');
    const ingest = async (file: string, mediaType: string, filename: string): Promise<SeededObject> => {
      const data = readFileSync(file);
      const response = await this.runtimeFetch(`/v1/projects/${projectId}/objects`, { method: 'POST', headers: { 'Content-Type': mediaType, 'Idempotency-Key': randomUUID(), 'X-Original-Name': filename }, body: new Uint8Array(data) });
      if (response.status !== 201 && response.status !== 200) throw new Error(`seed ${filename}: ${response.status} ${await response.text()}`);
      const body = await response.json();
      if (body.data.digest !== sha256Hex(data)) throw new Error(`seed ${filename}: Runtime digest differs from local digest`);
      return { objectId: body.data.object_id, digest: body.data.digest, size: data.length, mediaType };
    };
    const patternObject = await ingest(pattern, 'video/webm', 'f2-render-pattern.webm');
    const placeholder = await ingest(grey, 'video/webm', 'f2-render-placeholder.webm');
    const toneObject = await ingest(tone, 'audio/webm', 'f2-render-tone.webm');
    const entry = (object: SeededObject, duration: number) => ({ ...this.registryLocator(object), media_id: object.objectId, content_sha256: object.digest, type: object.mediaType, duration });

    const ids = { shotId: 'f2-render-shot', occurrenceId: 'f2-render-occurrence', slotClipId: 'f2-render-slot', markerAssetKey: 'f2-render-marker', placeholderAssetKey: 'f2-render-placeholder' };
    const timelineId = randomUUID();
    const internalRevisionId = randomUUID();
    const shotRevisionId = randomUUID();
    const clip = (id: string, at: number, asset: string, from: number, to: number) => ({ id, at, track: 'V2', clipType: 'media', asset, from, to, speed: 1 });
    const shotClips = [
      clip('f2-render-before', 0, 'f2-render-pattern', 0, 2),
      clip(ids.slotClipId, 2, ids.placeholderAssetKey, 0, 2),
      clip('f2-render-after', 4, 'f2-render-pattern', 4, 6),
    ];
    const parentClips = [{ id: 'f2-render-tone', at: 0, track: 'A1', clipType: 'media', asset: 'f2-render-tone', from: 0, to: 6, speed: 1, volume: 1 }];
    const publication = compositionPublication({ projectId, timelineId }, null, RENDER_TIMELINE_NAME, 30);
    publication.parent_composition.config = {
      ...publication.parent_composition.config,
      clips: parentClips,
      tracks: [{ id: 'S1', kind: 'visual', label: 'S1' }, { id: 'A1', kind: 'audio', label: 'A1' }],
    } as unknown as typeof publication.parent_composition.config;
    publication.parent_composition.clips = parentClips as unknown as typeof publication.parent_composition.clips;
    publication.parent_composition.registry = { assets: { 'f2-render-tone': entry(toneObject, 6) } } as unknown as typeof publication.parent_composition.registry;
    Object.assign(publication, {
      internal_timeline_revisions: [{
        timeline_id: timelineId,
        revision_id: internalRevisionId,
        payload: {
          tracks: [{ id: 'V2', kind: 'visual', label: 'V2' }],
          clips: shotClips, effects: [], audio: [], layout: {},
          registry: { assets: { 'f2-render-pattern': entry(patternObject, 6), [ids.placeholderAssetKey]: entry(placeholder, 4) } },
          assets: [],
        },
      }],
      shot_revisions: [{
        shot_id: ids.shotId,
        revision_id: shotRevisionId,
        internal_timeline_revision_id: internalRevisionId,
        payload: { metadata: { title: 'F2 render shot' }, items: [], pools: [], selected_variants: {}, provenance: {}, generation_inputs: {}, audio_bindings: [], text_bindings: [] },
      }],
    });
    (publication.parent_composition as Record<string, unknown>).occurrences = [{
      occurrence_id: ids.occurrenceId, shot_id: ids.shotId, shot_revision_id: shotRevisionId,
      placement: { start_ms: 0 }, source_offset: 0, duration_ms: 6000, speed: 1, track: 'S1', transform: {}, gain: 1, mute: false, provenance: {},
    }];
    const published = await this.runtimeJson('POST', `/v1/projects/${projectId}/timelines/${timelineId}/composition-revisions`, publication);
    if (published.status !== 200) throw new Error(`seed render timeline: ${published.status} ${JSON.stringify(published.body)}`);
    this.renderSeed = {
      projectSlug: (project.body.data ?? project.body).slug, timelineId, timelineName: RENDER_TIMELINE_NAME, headRevisionId: published.body.data.new_head,
      ...ids, placeholder, placeholderGrey: { ...RENDER_GREY }, occurrenceBlockSelector: `[data-action-id="shot-group-label"][data-shot-group-drag-anchor-clip-id="${ids.occurrenceId}"]`, fps: 30, durationSeconds: 6,
    };
    return this.renderSeed;
  }

  /** The `file` the App publishes next to an asset's identity (dataProvider `withManagedFileRoute`): the object's route, which the Runtime keeps out of the render's frozen inputs. */
  private registryLocator(object: SeededObject): { file: string } {
    return { file: `/v1/objects/${encodeURIComponent(object.objectId)}` };
  }

  // -- Door ----------------------------------------------------------------------------------

  /**
   * Takes the product credential away from the door, so it listens but is not ready (`runtime_unavailable`), as before
   * `astrid-runtime up` has provisioned it. `restoreProductCredential` gives it back; nothing restarts.
   */
  withdrawProductCredential(): void {
    renameSync(this.credentialPath, `${this.credentialPath}.withdrawn`);
  }

  restoreProductCredential(): void {
    if (existsSync(`${this.credentialPath}.withdrawn`)) renameSync(`${this.credentialPath}.withdrawn`, this.credentialPath);
  }

  /** Resident memory of the Runtime process, which serves the door, in bytes (Linux). */
  runtimeRssBytes(): number {
    try {
      const status = readFileSync(`/proc/${this.runtime?.child.pid}/status`, 'utf8');
      return Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? 0) * 1024;
    } catch { return 0; }
  }

  /** Samples the Runtime's RSS while `work` runs; returns its result and the peak growth over the starting RSS. */
  async withRssSampling<T>(work: () => Promise<T>): Promise<{ result: T; baselineBytes: number; peakBytes: number; growthBytes: number }> {
    const baselineBytes = this.runtimeRssBytes();
    let peakBytes = baselineBytes;
    const timer = setInterval(() => { peakBytes = Math.max(peakBytes, this.runtimeRssBytes()); }, 25);
    try {
      const result = await work();
      peakBytes = Math.max(peakBytes, this.runtimeRssBytes());
      return { result, baselineBytes, peakBytes, growthBytes: peakBytes - baselineBytes };
    } finally { clearInterval(timer); }
  }

  /** What the door judged and served, from its own audit log. */
  audit(): Array<{ method: string; path: string; origin: string | null; status: number; response_bytes: number }> {
    try { return readFileSync(this.auditPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
  }

  /**
   * A request to the door as the hosted page would send it (the hosted Origin, Host 127.0.0.1:<port>); nothing else is needed.
   * `pathUnderBase` is appended to the Runtime base `/api/runtime`; with `fromRoot` it is the whole path (for `/api/astrid/...` and paths outside both).
   */
  doorRequest(pathUnderBase: string, init: { method?: string; headers?: Record<string, string>; body?: Buffer | string; host?: string; origin?: string | null; fromRoot?: boolean } = {}) {
    const headers: Record<string, string> = { ...init.headers };
    if (init.origin !== null) headers.Origin = init.origin ?? this.origin;
    return rawRequest({ port: this.doorPort, path: init.fromRoot ? pathUnderBase : `${this.doorPrefix}${pathUnderBase}`, method: init.method, headers, body: init.body, host: init.host });
  }

  /** Brings the Runtime and its door back to a serving state after a test that stopped it or took its credential away. */
  async resetToHealthy(): Promise<void> {
    if (this.attachment) { await this.assertAttachedIdentity(); return; }
    this.restoreProductCredential();
    if (!this.runtimeRunning) { this.runtime = undefined; await this.startRuntime(); }
    const probe = await this.doorRequest('/v1/health').catch(() => null);
    if (!probe || probe.status !== 200) { await this.stopRuntime(); await this.startRuntime(); }
  }

  // -- Teardown ------------------------------------------------------------------------------

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    let cleanupError: unknown;
    this.hungStackCapture?.abortAll();
    const runtimeLogDir = this.runtimeLogDirectory;
    const runtime = this.runtime;
    if (!this.attachment) await stopGroup(runtime).catch((error) => { cleanupError ??= error; });
    // D66's focused element route keeps the daemon streams private so a later
    // Runtime phase candidate can be compared with the same run. Nothing from
    // these streams is exported through the manifest or browser diagnostics.
    if (runtimeLogDir && runtime) {
      try {
        await runtime.closed;
        mkdirSync(runtimeLogDir, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(runtimeLogDir, runtimeStreamLogName('stdout', this.runtimeLogLaunchOrdinal)), runtime.stdout, { flag: 'wx', mode: 0o600 });
        writeFileSync(path.join(runtimeLogDir, runtimeStreamLogName('stderr', this.runtimeLogLaunchOrdinal)), runtime.stderr, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        cleanupError = error;
      }
    }
    await new Promise<void>((resolve) => { if (!this.https) return resolve(); this.https.closeAllConnections?.(); this.https.close(() => resolve()); });
    if (this.tmp) rmSync(this.tmp, { recursive: true, force: true });
    if (cleanupError) throw cleanupError;
  }
}

export async function startDirectHarness(options: { deferTimelineInitialization?: boolean } = {}): Promise<DirectHarness> {
  return new DirectHarness().start(options);
}

function readCredentialToken(file: string): string {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed.token !== 'string' || !parsed.token) throw new Error(`credential file ${file} has no token`);
  return parsed.token;
}

import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestInfo, WorkerInfo } from '@playwright/test';

export const D21_ENVIRONMENT_FILE = 'd21-environment.json';
export const D21_ENVIRONMENT_LIMIT = 32 * 1024;

export type Observation = 'OBSERVED' | 'DECLARED' | 'UNKNOWN' | 'NOTCAPTURED';
type Fact<T> = { observation: Observation; value?: T; missingSeam?: string };

const UNKNOWN = <T = never>(missingSeam?: string): Fact<T> => ({ observation: 'UNKNOWN', ...(missingSeam ? { missingSeam } : {}) });
const NOT_CAPTURED = <T = never>(missingSeam?: string): Fact<T> => ({ observation: 'NOTCAPTURED', ...(missingSeam ? { missingSeam } : {}) });
const observed = <T>(value: T): Fact<T> => ({ observation: 'OBSERVED', value });
const declared = <T>(value: T): Fact<T> => ({ observation: 'DECLARED', value });

export interface D21EnvironmentArtifact {
  version: 1;
  kind: 'd21-environment';
  status: 'preflight' | 'ready' | 'failed';
  case: { name: 'mounted-readiness'; leaf: string; gestures: 'NOTCAPTURED' };
  stages: Array<{ name: string; startedAt: string; completedAt?: string; result: 'OBSERVED' | 'FAILED' | 'NOTRUN' }>;
  backend: {
    interpreter: { publicPath: Fact<string>; version: Fact<string> };
    start: Fact<string>;
    completion: Fact<string>;
    error: Fact<{ code: string; class: string; stage: string }>;
    exit: Fact<number | null>;
    exitAt: Fact<string>;
    launch: { module: Fact<string>; profile: Fact<string> };
    process: { interpreterPath: Fact<string>; module: Fact<string> };
    host: Fact<string>;
    port: Fact<number>;
    imports: {
      daemon: { modules: Fact<string[]>; publicPaths: Fact<string[]>; sourceCommits: Fact<string[]> };
      launcher: { modules: Fact<string[]>; publicPaths: Fact<string[]>; sourceCommits: Fact<string[]> };
      cli: { modules: Fact<string[]>; publicPaths: Fact<string[]>; sourceCommits: Fact<string[]> };
    };
  };
  door: {
    host: Fact<string>;
    port: Fact<number>;
    prefix: Fact<string>;
    authPresence: Fact<boolean>;
    allowedOriginEquality: Fact<boolean>;
  };
  editor: {
    origin: Fact<string>;
    path: Fact<string>;
    compiledRuntimeHTTPBase: Fact<{ host: string; port: number; path: string }>;
    websocket: Fact<{ used: boolean; host?: string; path?: string }>;
  };
  provider: { attached: Fact<boolean>; sourceObserved: Fact<string> };
  tools: {
    node: { publicPath: Fact<string>; version: Fact<string> };
    npm: { publicPath: Fact<string>; version: Fact<string> };
    playwright: { publicPath: Fact<string>; version: Fact<string> };
    build: { mode: Fact<string>; distPresence: Fact<boolean> };
  };
  sourceCommits: {
    actualDaemon: Fact<string[]>;
    launcher: Fact<string[]>;
    cli: Fact<string[]>;
  };
  env: Record<string, { present: boolean; publicValue?: number | string }>;
  readiness: { connected: Fact<boolean>; freshSettledOwner: Fact<boolean> };
}

function now(): string { return new Date().toISOString(); }

function emptyImports() {
  return {
    modules: UNKNOWN<string[]>('actual-daemon-import-metadata-unavailable'),
    publicPaths: UNKNOWN<string[]>('actual-daemon-import-metadata-unavailable'),
    sourceCommits: UNKNOWN<string[]>('actual-daemon-source-commit-unavailable'),
  };
}

export function createD21Environment(): D21EnvironmentArtifact {
  return {
    version: 1,
    kind: 'd21-environment',
    status: 'preflight',
    case: { name: 'mounted-readiness', leaf: 'three-products.mounted-readiness', gestures: 'NOTCAPTURED' },
    stages: [],
    backend: {
      interpreter: { publicPath: UNKNOWN('daemon interpreter path is not exposed by existing health API'), version: UNKNOWN('daemon interpreter version is not exposed by existing health API') },
      start: UNKNOWN('DirectHarness does not expose daemon start timestamp'),
      completion: UNKNOWN('DirectHarness does not expose daemon completion timestamp'),
      error: UNKNOWN('no daemon error observed'),
      exit: UNKNOWN('daemon exit is not observed before teardown'),
      exitAt: UNKNOWN('daemon exit is not observed before teardown'),
      launch: { module: UNKNOWN('daemon launch module is not exposed'), profile: UNKNOWN('daemon launch profile is not exposed') },
      process: { interpreterPath: UNKNOWN('actual daemon interpreter is not exposed'), module: UNKNOWN('actual daemon argv module is not exposed') },
      host: UNKNOWN('backend endpoint not yet observed'),
      port: UNKNOWN('backend endpoint not yet observed'),
      imports: { daemon: emptyImports(), launcher: emptyImports(), cli: emptyImports() },
    },
    door: {
      host: UNKNOWN('door endpoint not yet observed'),
      port: UNKNOWN('door endpoint not yet observed'),
      prefix: UNKNOWN('door prefix not yet observed'),
      authPresence: UNKNOWN('credential presence not yet observed'),
      allowedOriginEquality: UNKNOWN('door allowed-origin metadata unavailable'),
    },
    editor: {
      origin: UNKNOWN('editor page not yet observed'),
      path: UNKNOWN('editor page not yet observed'),
      compiledRuntimeHTTPBase: UNKNOWN('compiled runtime base is not exposed by the page'),
      websocket: NOT_CAPTURED('websocket listener is installed only when the leaf starts'),
    },
    provider: {
      attached: UNKNOWN('DirectHarness has no provider attachment API'),
      sourceObserved: UNKNOWN('provider source metadata unavailable'),
    },
    tools: {
      node: { publicPath: UNKNOWN('launcher tool metadata unavailable'), version: UNKNOWN('launcher tool metadata unavailable') },
      npm: { publicPath: UNKNOWN('npm metadata unavailable'), version: UNKNOWN('npm metadata unavailable') },
      playwright: { publicPath: UNKNOWN('Playwright metadata unavailable'), version: UNKNOWN('Playwright metadata unavailable') },
      build: { mode: UNKNOWN('build mode not observed'), distPresence: UNKNOWN('dist presence not observed') },
    },
    sourceCommits: {
      actualDaemon: UNKNOWN('actual daemon source commit is not exposed by existing health API'),
      launcher: UNKNOWN('launcher source commit not declared'),
      cli: UNKNOWN('CLI source commit not declared'),
    },
    env: {},
    readiness: { connected: UNKNOWN('connected state not yet observed'), freshSettledOwner: UNKNOWN('owner state not yet observed') },
  };
}

function bounded(value: string, max = 256): string | undefined {
  return value.length <= max ? value : undefined;
}

function safeEndpoint(raw: string, allowed: readonly string[] = ['http:', 'https:']): { host: string; port: number; path: string } | undefined {
  try {
    const url = new URL(raw);
    if (!allowed.includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    const port = url.port ? Number(url.port) : url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
    const pathname = bounded(url.pathname || '/');
    if (!pathname) return undefined;
    return { host: bounded(url.hostname, 128) ?? 'UNKNOWN', port, path: pathname };
  } catch { return undefined; }
}

function safePath(raw: string): string | undefined {
  return raw.startsWith('/') && !raw.includes('?') && !raw.includes('#') ? bounded(raw, 160) : undefined;
}

function shaList(...values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value && /^[0-9a-f]{40}$/.test(value))).slice(0, 3);
}

const SAFE_ENV_KEYS = [
  'ASTRID_QUICK_DESCRIPTOR', 'APP_DIRECT_DIST', 'DOOR_PORT', 'ORIGIN_PORT', 'NODE_PATH', 'NODE_OPTIONS', 'PYTHONPATH',
  'VITE_RUNTIME_ORIGIN', 'VITE_WORKSPACE_RUNTIME_EXPECTED_ACTOR_ID', 'VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID',
  'VITE_WORKSPACE_RUNTIME_EXPECTED_INSTANCE_ID',
] as const;

export function observeD21Harness(artifact: D21EnvironmentArtifact, input: {
  runtimeUrl: string;
  doorBase: string;
  doorPrefix: string;
  editorOrigin: string;
  productCredentialPresent: boolean;
  authoringProfile: 'astrid' | 'UNKNOWN';
  distPath?: string;
  agentCommit?: string;
  runtimeCommit?: string;
  backendInterpreterPath?: string;
  lifecycle?: {
    startedAt: string;
    readyAt?: string;
    exitedAt?: string;
    exitCode?: number | null;
    launchInterpreter: string;
    launchModule: string;
    launchProfile: string;
    actualInterpreter?: string;
    actualModule?: string;
    doorOriginEquality?: boolean;
    failure?: { code: string; class: string; stage: string };
  };
}): void {
  const backend = safeEndpoint(input.runtimeUrl);
  const door = safeEndpoint(input.doorBase);
  if (backend) {
    artifact.backend.host = observed(backend.host);
    artifact.backend.port = observed(backend.port);
  }
  if (door) {
    artifact.door.host = observed(door.host);
    artifact.door.port = observed(door.port);
    artifact.door.prefix = observed(input.doorPrefix);
  }
  artifact.door.authPresence = observed(input.productCredentialPresent);
  if (input.backendInterpreterPath) artifact.backend.interpreter.publicPath = declared(input.backendInterpreterPath);
  artifact.door.allowedOriginEquality = input.lifecycle?.doorOriginEquality === undefined
    ? UNKNOWN('door allowed-origin metadata unavailable') : observed(input.lifecycle.doorOriginEquality);
  artifact.provider.sourceObserved = input.authoringProfile === 'astrid' ? declared('runtime-launch-profile:astrid') : UNKNOWN('authoring profile unavailable');
  artifact.provider.attached = UNKNOWN('DirectHarness has no provider attachment API');
  if (input.lifecycle) {
    artifact.backend.start = observed(input.lifecycle.startedAt);
    artifact.backend.completion = input.lifecycle.readyAt ? observed(input.lifecycle.readyAt) : UNKNOWN('daemon did not reach health readiness');
    artifact.backend.launch.module = declared(input.lifecycle.launchModule);
    artifact.backend.launch.profile = declared(input.lifecycle.launchProfile);
    artifact.backend.process.interpreterPath = input.lifecycle.actualInterpreter
      ? observed(input.lifecycle.actualInterpreter) : UNKNOWN('actual daemon interpreter is not exposed');
    artifact.backend.process.module = input.lifecycle.actualModule
      ? observed(input.lifecycle.actualModule) : UNKNOWN('actual daemon argv module is not exposed');
    artifact.backend.exit = input.lifecycle.exitCode === undefined
      ? UNKNOWN('daemon exit is not observed before teardown') : observed(input.lifecycle.exitCode);
    artifact.backend.exitAt = input.lifecycle.exitedAt ? observed(input.lifecycle.exitedAt) : UNKNOWN('daemon exit is not observed before teardown');
    if (input.lifecycle.failure) artifact.backend.error = observed(input.lifecycle.failure);
  }
  artifact.sourceCommits.launcher = shaList(input.agentCommit, input.runtimeCommit).length
    ? declared(shaList(input.agentCommit, input.runtimeCommit))
    : UNKNOWN('launcher source commits not declared');
  artifact.backend.imports.launcher.sourceCommits = artifact.sourceCommits.launcher;
  artifact.backend.imports.daemon.sourceCommits = UNKNOWN('actual daemon source commit is not exposed by existing health API');
  const dist = input.distPath ? path.resolve(input.distPath) : undefined;
  const distPresent = dist ? existsSync(path.join(dist, 'index.html')) : undefined;
  artifact.tools.build.distPresence = distPresent === undefined ? UNKNOWN('dist path not exposed') : observed(distPresent);
  artifact.tools.build.mode = distPresent === true ? declared('hosted-production-dist') : UNKNOWN('build mode not observed');
  const require = createRequire(import.meta.url);
  artifact.tools.node = { publicPath: observed(process.execPath), version: observed(process.version) };
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    const npmPackagePath = path.resolve(npmExecPath, '..', '..', 'package.json');
    try {
      const npmPackage = JSON.parse(readFileSync(npmPackagePath, 'utf8')) as { version?: unknown };
      artifact.tools.npm = {
        publicPath: observed(npmExecPath),
        version: typeof npmPackage.version === 'string' ? observed(npmPackage.version) : UNKNOWN('npm package version unavailable'),
      };
    } catch {
      artifact.tools.npm = { publicPath: observed(npmExecPath), version: UNKNOWN('npm package version unavailable') };
    }
  } else {
    artifact.tools.npm = { publicPath: UNKNOWN('actual npm process path unavailable'), version: UNKNOWN('actual npm package version unavailable') };
  }
  try {
    const playwrightPath = require.resolve('@playwright/test');
    const packagePath = require.resolve('@playwright/test/package.json');
    const packageJson = require(packagePath) as { version?: unknown };
    artifact.tools.playwright = {
      publicPath: observed(playwrightPath),
      version: typeof packageJson.version === 'string' ? observed(packageJson.version) : UNKNOWN('Playwright package version unavailable'),
    };
  } catch {
    artifact.tools.playwright = { publicPath: UNKNOWN('Playwright package path unavailable'), version: UNKNOWN('Playwright package version unavailable') };
  }
  const envAliases: Record<string, readonly string[]> = {
    APP_DIRECT_DIST: ['APP_DIRECT_DIST', 'ASTRID_APP_DIRECT_DIST'],
    DOOR_PORT: ['DOOR_PORT', 'ASTRID_APP_DIRECT_DOOR_PORT'],
    ORIGIN_PORT: ['ORIGIN_PORT', 'ASTRID_APP_DIRECT_ORIGIN_PORT'],
  };
  for (const key of SAFE_ENV_KEYS) {
    const value = (envAliases[key] ?? [key]).map((candidate) => process.env[candidate]).find((candidate) => candidate !== undefined);
    const publicValue = key === 'DOOR_PORT' || key === 'ORIGIN_PORT'
      ? (value && /^\d{1,5}$/.test(value) ? Number(value) : undefined)
      : key === 'VITE_RUNTIME_ORIGIN' && value ? safeEndpoint(value)?.host ?? undefined : undefined;
    artifact.env[key] = { present: value !== undefined, ...(publicValue === undefined ? {} : { publicValue }) };
  }
}

export function observeD21Page(artifact: D21EnvironmentArtifact, input: { url: string; websocket?: string }): void {
  try {
    const url = new URL(input.url);
    const origin = url.origin;
    const pagePath = safePath(url.pathname);
    if (bounded(origin, 160)) artifact.editor.origin = observed(origin);
    if (pagePath) artifact.editor.path = observed(pagePath);
  } catch {
    artifact.editor.origin = UNKNOWN('malformed editor URL');
    artifact.editor.path = UNKNOWN('malformed editor URL');
  }
  if (input.websocket !== undefined) {
    const endpoint = safeEndpoint(input.websocket, ['ws:', 'wss:']);
    artifact.editor.websocket = endpoint ? observed({ used: true, host: endpoint.host, path: endpoint.path }) : UNKNOWN('malformed websocket URL');
  } else {
    artifact.editor.websocket = observed({ used: false });
  }
}

export function recordD21Stage(artifact: D21EnvironmentArtifact, name: string, result: 'OBSERVED' | 'FAILED' | 'NOTRUN', startedAt = now()): void {
  if (artifact.stages.length >= 8) return;
  const current = artifact.stages.find((stage) => stage.name === name);
  if (current) {
    current.completedAt = now();
    current.result = result;
    return;
  }
  artifact.stages.push({ name: bounded(name, 80) ?? 'UNKNOWN', startedAt, completedAt: now(), result });
}

export function recordD21Readiness(artifact: D21EnvironmentArtifact, connected: boolean | 'UNKNOWN', owner: boolean | 'UNKNOWN'): void {
  artifact.readiness.connected = connected === 'UNKNOWN' ? UNKNOWN('connection state unavailable') : observed(connected);
  artifact.readiness.freshSettledOwner = owner === 'UNKNOWN' ? UNKNOWN('owner predicate unavailable') : observed(owner);
  if (connected === true && owner === true) artifact.status = 'ready';
  if (connected === false || owner === false) artifact.status = 'failed';
}

export function recordD21Error(artifact: D21EnvironmentArtifact, error: { code: string; class: string; stage: string }): void {
  artifact.backend.error = observed({
    code: bounded(error.code, 48) ?? 'UNKNOWN',
    class: bounded(error.class, 48) ?? 'UNKNOWN',
    stage: bounded(error.stage, 80) ?? 'UNKNOWN',
  });
}

export function serializeD21Environment(artifact: D21EnvironmentArtifact): string {
  const text = JSON.stringify(artifact);
  if (Buffer.byteLength(text, 'utf8') > D21_ENVIRONMENT_LIMIT) throw new Error('d21-environment artifact exceeds 32KiB bound');
  return text;
}

function isTestInfo(info: TestInfo | WorkerInfo): info is TestInfo {
  return typeof (info as TestInfo).outputPath === 'function' && typeof (info as TestInfo).attach === 'function';
}

function workerArtifactPath(workerInfo: WorkerInfo): string {
  if (!Number.isSafeInteger(workerInfo.workerIndex) || workerInfo.workerIndex < 0) {
    throw new Error('Playwright worker index is not safe for an artifact path');
  }
  const outputDir = path.resolve(workerInfo.project.outputDir);
  const workerDir = path.join(outputDir, `worker-${workerInfo.workerIndex}`);
  const relativeWorkerDir = path.relative(outputDir, workerDir);
  if (relativeWorkerDir.startsWith('..') || path.isAbsolute(relativeWorkerDir)) {
    throw new Error('Playwright worker artifact path escaped the project output directory');
  }
  mkdirSync(workerDir, { recursive: true, mode: 0o700 });
  return path.join(workerDir, D21_ENVIRONMENT_FILE);
}

function writeD21Artifact(output: string, text: string): void {
  writeFileSync(output, text, { encoding: 'utf8', mode: 0o600 });
  chmodSync(output, 0o600);
}

export async function persistD21Environment(info: TestInfo | WorkerInfo, artifact: D21EnvironmentArtifact): Promise<void> {
  const text = serializeD21Environment(artifact);
  if (!isTestInfo(info)) {
    writeD21Artifact(workerArtifactPath(info), text);
    return;
  }
  const output = info.outputPath(D21_ENVIRONMENT_FILE);
  writeD21Artifact(output, text);
  await info.attach(D21_ENVIRONMENT_FILE, { path: output, contentType: 'application/json' });
}

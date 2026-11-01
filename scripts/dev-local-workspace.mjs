#!/usr/bin/env node
/**
 * Start Astrid App with the developer's neutral workspace.v1 Runtime.
 *
 * The Runtime owns its endpoint and credential; this launcher starts or attaches
 * to it and validates its published profile and product credential before passing
 * it to Vite's server-side proxy. The token is never printed or exposed as a
 * VITE_ value.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { packageManagerInvocation } from './node-package-manager.mjs';
import { terminateProcessTree } from './terminate-process-tree.mjs';
import { startLocalUpdateControl } from './local-update-control.mjs';
import { createLocalUpdater, restorePreparedResources, validateAppContext } from './local-update-runner.mjs';
import { restoreCheckout, releasePreparation, prepareUpdate, selectUpdateTarget } from './local-update-checkout.mjs';
import { installedBackend, journalSettled, pinokioSession, readUpdateJournal, runBackendUpdate } from './local-update-backend.mjs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { readGeneratedSchemaDigest, schemaDigestMismatch } from './runtime-schema-guard.mjs';
import { LEGACY_RUNTIME_SCHEMA_DIGESTS, SOURCE_SCHEMA_MISMATCH_ACTION } from '../src/integrations/runtime/runtime-update-contract.mjs';
import {
  parseDevLocalWorkspaceArgs,
  resolveRuntimeCommand,
  validatePreviewOutputDirectory,
  viteChildArgs,
  resolveWorkspaceDiscoveryPath,
  loadLocalRuntimeEnvironment,
  shellQuote,
  LOCAL_EDITOR_PORT,
} from './dev-local-workspace-options.mjs';

// What the person sees is a few friendly lines. Everything technical is behind `--verbose` (or ASTRID_VERBOSE=1), and every
// error carries one `Details:` line for an agent. Declared first: `fail()` runs before the rest of the file is evaluated.
const verbose = process.argv.includes('--verbose') || process.env.ASTRID_VERBOSE === '1';
const bold = (text) => (process.stdout.isTTY ? `\x1b[1m${text}\x1b[22m` : text);
const dim = (text) => (process.stderr.isTTY ? `\x1b[2m${text}\x1b[22m` : text);

const INSTALL_GUIDE_URL = 'https://github.com/banodoco/astrid-agent/blob/main/docs/setup/local-source-install.md';
const NOT_SET_UP = `Astrid isn't set up on this computer yet. Install guide: ${INSTALL_GUIDE_URL}`;
const PROGRAM_IN_THE_WAY = "Another program is in the way, so Astrid can't start. Close it and try again.";
const OTHER_ASTRID_RUNNING = 'Another Astrid is already running in another window. Stop it there with Ctrl+C first.';
const astridStartCommand = process.env.ASTRID_START_COMMAND;
const startCommand = astridStartCommand
  ? `${process.platform === 'win32' ? '& ' : ''}${shellQuote(astridStartCommand)}`
  : 'npm run dev:local';
const startCommandBasename = astridStartCommand?.split(/[\\/]/).at(-1)?.toLowerCase();
const pinokioManaged = process.env.ASTRID_INSTALL_MANAGED_BY === 'pinokio'
  || startCommandBasename === 'run' || startCommandBasename === 'run.cmd';
// An install may keep its Runtime behind `<install>/with-env` (next to `<install>/start`), off the person's PATH.
// Use that helper only when it exists; otherwise hints fall back to the ordinary Runtime CLI name.
const runtimeCli = (action) => {
  const withEnv = astridStartCommand && resolve(dirname(astridStartCommand), 'with-env');
  const installedCli = withEnv && existsSync(withEnv)
    ? `${process.platform === 'win32' ? '& ' : ''}${shellQuote(withEnv)} astrid-runtime`
    : 'astrid-runtime';
  return `${installedCli} ${action} --profile astrid`;
};
const runtimeUpCommand = runtimeCli('up');
const ENGINE_STOPPED = pinokioManaged
  ? "Astrid's engine isn't running. Start Astrid in Pinokio."
  : `Astrid's engine isn't running. Start it first: ${runtimeUpCommand}`;
const DEFAULT_HOSTED_ORIGIN = 'https://astrid.haus';
const engineWithoutDoor = (origin) => pinokioManaged
  ? `Astrid's engine isn't accepting ${origin}. Stop and start Astrid in Pinokio.`
  : `Astrid's engine is running without a door for ${origin}. Restart it: ${runtimeCli('restart')}${origin === DEFAULT_HOSTED_ORIGIN ? '' : ` --hosted-origin ${origin}`}`;
const BAD_HOSTED_ORIGIN = '--hosted-origin must be an https:// address, like https://astrid.haus';
const ENGINE_CHANGED = pinokioManaged
  ? 'Astrid changed on this computer. Stop and start Astrid in Pinokio.'
  : `Astrid changed on this computer. Restart its engine: ${runtimeUpCommand}`;
const CANT_START = "Astrid can't start with the setup on this computer.";

/**
 * One friendly line, then one `Details:` line with the technical message. Returns null so callers can `return fail(...)`.
 * The line says who is speaking ("Astrid: ") only when the message does not already begin with the name.
 */
function fail(friendly, details) {
  console.error(friendly.startsWith('Astrid') ? friendly : `Astrid: ${friendly}`);
  if (details) console.error(dim(`Details: ${String(details).replace(/\s*\n\s*/g, ' ')}`));
  process.exitCode = 1;
  return null;
}

class LauncherExit extends Error {
  constructor(code) { super('Launcher finished'); this.code = code; }
}
const exit = (code) => { throw new LauncherExit(code); };
const services = [];
let runtimeSettings;
let ownedRuntime;
let runtimeCliChild;
let cleanupPromise;
let interrupted = false;
let updateControl;

function spawnService(command, args, { kind = 'bridge', ...options }) {
  if (interrupted) exit(130);
  const child = spawn(command, args, { ...options, detached: process.platform !== 'win32' });
  const service = { child, kind, closed: false };
  service.done = new Promise((resolveClosed) => child.once('close', () => { service.closed = true; resolveClosed(); }));
  child.on('error', () => {}); // Callers report errors; close still releases the owned service.
  services.push(service);
  return child;
}

async function stopService(service, signal) {
  if (!service.closed && service.child.pid) {
    await terminateProcessTree(service.child, signal);
  }
  await service.done;
}

function runtimeCommand(action) {
  const { command, args, cwd } = resolveRuntimeCommand(runtimeSettings);
  return { command, cwd, args: [...args, action, '--profile', 'astrid', '--data-root', runtimeSettings.dataRoot,
    ...(runtimeSettings.sourceManifest ? ['--source-manifest', runtimeSettings.sourceManifest] : []),
    // The Runtime opens the hosted page's door itself; `off` starts it without one.
    ...(action === 'up' || action === 'restart' ? ['--hosted-origin', runtimeSettings.hostedOrigin ?? 'off'] : []),
    '--json'] };
}

async function runRuntimeCommand(action) {
  const { command, args, cwd } = runtimeCommand(action);
  const child = spawn(command, args, { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env,
    ...(runtimeSettings.astridCheckout ? { ASTRID_CHECKOUT: runtimeSettings.astridCheckout } : {}),
  } });
  runtimeCliChild = child;
  let stdout = '', stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolveClosed, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => code === 0 ? resolveClosed()
        : reject(new Error(`exited ${signal ? `with ${signal}` : `with code ${code}`}`)));
    });
    return JSON.parse(stdout);
  }
  catch (error) {
    let reported;
    try { reported = JSON.parse(stdout).error; } catch { /* not a structured CLI error */ }
    throw new Error(`Runtime ${action} failed: ${reported || stderr.trim() || error.message}`);
  }
  finally { runtimeCliChild = null; }
}

function cleanup(signal = 'SIGTERM') {
  return cleanupPromise ??= (async () => {
    await updateControl?.close();
    for (const service of services.filter(({ kind }) => kind === 'vite')) await stopService(service, signal);
    for (const service of services.filter(({ kind }) => kind !== 'vite')) await stopService(service, signal);
    if (ownedRuntime) {
      let current;
      try { current = JSON.parse(readFileSync(ownedRuntime.discoveryPath, 'utf8')); } catch { return; }
      // A replacement owner belongs to whoever started it, even at the same data root.
      if (current.runtime_instance_id === ownedRuntime.instanceId) await runRuntimeCommand('down');
    }
  })();
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (!updateControl?.busy) interrupted = true;
  if (signal === 'SIGINT' && !process.exitCode) process.exitCode = 130;
  if (cleanupPromise) return;
  // Let up complete its custody/readiness handoff before deciding whether we own
  // an owner to stop. Killing that CLI could strand a daemon before its JSON reply.
  if (!runtimeCliChild) void cleanup(signal).catch((error) => fail(CANT_START, error.message));
});

async function main() {
let launcherOptions;
try {
  loadLocalRuntimeEnvironment(process.cwd(), process.env);
  launcherOptions = parseDevLocalWorkspaceArgs(process.argv.slice(2), process.env);
}
catch (error) { fail(CANT_START, error.message); exit(1); }
const configuredAstridCheckout = launcherOptions.astridCheckout
  ? resolve(launcherOptions.astridCheckout) : process.env.ASTRID_CHECKOUT?.trim();
const siblingAstridCheckout = resolve(process.cwd(), '..', 'Astrid');
const astridCheckout = configuredAstridCheckout
  || (existsSync(resolve(siblingAstridCheckout, '.astrid-data', 'runtime', 'discovery.json'))
    ? siblingAstridCheckout
    : null);
const configuredAstridPublicCheckout = process.env.ASTRID_PUBLIC_CHECKOUT?.trim();
const selectedDataRoot = launcherOptions.dataRoot
  ? resolve(launcherOptions.dataRoot) : process.env.ASTRID_RUNTIME_DATA_ROOT?.trim();
let discoveryPath;
try {
  const rootOptions = {
    supportRoot: launcherOptions.dataRoot ? undefined : process.env.ASTRID_SUPPORT_ROOT,
    dataRoot: selectedDataRoot,
    home: homedir(),
  };
  const rootedDiscovery = resolveWorkspaceDiscoveryPath(rootOptions);
  discoveryPath = resolveWorkspaceDiscoveryPath({
    ...rootOptions,
    discovery: launcherOptions.dataRoot ? undefined : process.env.ASTRID_WORKSPACE_DISCOVERY,
  });
  if (selectedDataRoot && discoveryPath !== rootedDiscovery) {
    throw new Error('ASTRID_WORKSPACE_DISCOVERY and ASTRID_RUNTIME_DATA_ROOT select different roots');
  }
} catch (error) {
  exit(fail(CANT_START, error instanceof Error ? error.message : String(error)) ? 1 : 1);
}
const buildOnly = process.argv.includes('--build');
const port = process.env.PORT ?? LOCAL_EDITOR_PORT;
const editorUrl = `http://127.0.0.1:${port}/tools/video-editor`;
runtimeSettings = {
  dataRoot: selectedDataRoot || process.env.ASTRID_SUPPORT_ROOT?.trim()
      || (basename(dirname(discoveryPath)) === 'runtime' ? dirname(dirname(discoveryPath)) : dirname(discoveryPath)),
  runtimeCheckout: launcherOptions.runtimeCheckout || process.env.ASTRID_RUNTIME_CHECKOUT?.trim(),
  runtimePython: process.env.ASTRID_RUNTIME_PYTHON?.trim(),
  astridCheckout,
  sourceManifest: launcherOptions.sourceManifest || process.env.ASTRID_RUNTIME_SOURCE_MANIFEST?.trim(),
};
if (runtimeSettings.runtimeCheckout) runtimeSettings.runtimeCheckout = resolve(runtimeSettings.runtimeCheckout);
if (runtimeSettings.sourceManifest) runtimeSettings.sourceManifest = resolve(runtimeSettings.sourceManifest);
const checkOnly = launcherOptions.checkOnly;
if (buildOnly && launcherOptions.preview) {
  exit(fail(CANT_START, '--build and --preview are separate rebuild and launch steps') ? 1 : 1);
}
const paired = launcherOptions.paired;
const resetPairing = launcherOptions.resetPairing;
let previewDirectory = null;
const pairedRelayOrigin = process.env.ASTRID_APP_PAIRED_RELAY_ORIGIN?.trim();
const hostedOriginArgumentIndex = process.argv.indexOf('--hosted-origin');
const hostedOriginArgument = hostedOriginArgumentIndex >= 0
  ? process.argv[hostedOriginArgumentIndex + 1]?.trim()
  : undefined;
if (hostedOriginArgumentIndex >= 0 && (!hostedOriginArgument || hostedOriginArgument.startsWith('--'))) {
  fail(BAD_HOSTED_ORIGIN, '--hosted-origin requires an exact HTTPS origin');
  exit(1);
}
const hostedOriginEnvironment = process.env.ASTRID_APP_LOOPBACK_ORIGIN?.trim() || undefined;
if (hostedOriginEnvironment === 'off' && hostedOriginArgument !== undefined) {
  fail('Choose one: turn the hosted address off, or give one.', 'ASTRID_APP_LOOPBACK_ORIGIN=off and --hosted-origin cannot both be set');
  exit(1);
}
const hostedOrigin = resolveHostedOrigin({
  explicit: hostedOriginEnvironment ?? hostedOriginArgument,
  configPath: process.env.ASTRID_APP_HOSTED_ORIGIN_CONFIG?.trim() || fileURLToPath(new URL('../config/hosted-origin.json', import.meta.url)),
});
runtimeSettings.hostedOrigin = hostedOrigin;
const generatedMetadataPath = resolve(process.cwd(), 'src/integrations/runtime/generated-contract-metadata.ts');

function requireExactHttpsOrigin(value, details, friendly = BAD_HOSTED_ORIGIN) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(friendly, details);
    exit(1);
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== value) {
    fail(friendly, details);
    exit(1);
  }
  return value;
}

/**
 * The hosted page the Runtime's door serves. An explicit ASTRID_APP_LOOPBACK_ORIGIN or --hosted-origin wins, and `off` opts
 * out. Otherwise the origin in config/hosted-origin.json is the default, or null for none. A broken config stops the launch.
 */
function resolveHostedOrigin({ explicit, configPath }) {
  if (explicit === 'off') return null;
  if (explicit !== undefined) return requireExactHttpsOrigin(explicit, 'hosted origin must be an exact HTTPS origin');
  const message = `hosted origin in ${configPath} must be {"origin": "<exact HTTPS origin>"} or {"origin": null}`;
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    fail(CANT_START, `cannot read the hosted origin at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    exit(1);
  }
  const configured = config?.origin;
  if (configured === null) return null;
  if (typeof configured !== 'string') {
    fail(CANT_START, message);
    exit(1);
  }
  return requireExactHttpsOrigin(configured, message, CANT_START);
}

/**
 * The hosted page reaches this computer through the Runtime's own door (astrid-runtime `runtime_protocol/door.py`), which
 * the Runtime opens when it starts and records in discovery. Returns its port, or fails when it serves another page.
 */
function requireDoor(runtimeDiscovery, origin) {
  let endpoint = null;
  try { endpoint = new URL(String(runtimeDiscovery.door_endpoint ?? '')); } catch { /* no door */ }
  if (runtimeDiscovery.door_origin !== origin || endpoint?.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port) {
    return fail(engineWithoutDoor(origin), `the running Runtime's browser door serves ${runtimeDiscovery.door_origin ?? 'no hosted page'}`);
  }
  return endpoint.port;
}

/**
 * Who holds the app's port: another launcher's app (its Vite answers the realm it serves) for this realm (`ours`) or
 * another one (`other_astrid`), or some other program.
 */
async function appPortHolder(appPort, realmId) {
  let config = null;
  try {
    const response = await fetch(`http://127.0.0.1:${appPort}/runtime-config/v1/workspace.json`, { signal: AbortSignal.timeout(2000) });
    config = response.ok ? await response.json() : null;
  } catch { /* not an app that answers */ }
  if (typeof config?.realmId !== 'string') return 'program';
  return config.realmId === realmId ? 'ours' : 'other_astrid';
}

function printOpenBlock(origin) {
  console.log('');
  console.log(bold(`  Open ${origin}`));
  console.log('');
  console.log('Keep this window open while you work. Press Ctrl+C to stop.');
}

function readJson(path, label, friendly = CANT_START) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return fail(friendly, `cannot read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const RUNTIME_SCOPES = Object.freeze([
  'handshake',
  'projects:read',
  'projects:write',
  'objects:read',
  'objects:write',
  'tasks:read',
  'tasks:write',
]);
const FORBIDDEN_ACTORS = new Set(['owner', 'astrid-pack-host', 'admin', 'worker']);

function readProductCredential(path, label) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch (error) {
    return fail(CANT_START, `cannot read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!raw) return fail(CANT_START, `${label} at ${path} is empty`);
  if (!raw.startsWith('{')) return fail(CANT_START, `${label} at ${path} is not a scoped Astrid product credential`);

  try {
    const credential = JSON.parse(raw);
    const token = typeof credential.token === 'string' ? credential.token.trim() : '';
    const actorId = typeof credential.actor_id === 'string' ? credential.actor_id.trim() : '';
    if (credential.version !== 1 || credential.scope !== 'astrid') {
      return fail(CANT_START, `${label} at ${path} must identify the version 1 astrid product scope`);
    }
    if (!actorId || FORBIDDEN_ACTORS.has(actorId)) {
      return fail(CANT_START, `${label} at ${path} has a forbidden or missing product actor`);
    }
    if (!token) return fail(CANT_START, `${label} at ${path} has no token`);
    return { actorId, token };
  } catch (error) {
    return fail(CANT_START, `cannot read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function exactStringList(actual, expected) {
  return Array.isArray(actual)
    && actual.every((value) => typeof value === 'string')
    && actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function requireIdentity(discovery, discoveryFile, credential) {
  const runtimeInstanceId = typeof discovery.runtime_instance_id === 'string' ? discovery.runtime_instance_id.trim() : '';
  const realmId = typeof discovery.active_realm === 'string' ? discovery.active_realm.trim() : '';
  const realmRoot = typeof discovery.realm_root === 'string' ? discovery.realm_root.trim() : '';
  if (!runtimeInstanceId || !realmId || !realmRoot) {
    return fail(CANT_START, 'runtime discovery is missing its Astrid profile instance, selected realm, or realm root');
  }

  const catalog = readJson(resolve(dirname(discoveryFile), 'catalog.json'), 'Runtime profile catalog');
  if (!catalog) return null;
  if (catalog.selected_realm_id !== realmId || !Array.isArray(catalog.realms)) {
    return fail(CANT_START, 'Runtime discovery does not match the selected realm in catalog.json');
  }
  const matches = catalog.realms.filter((row) => row && row.realm_id === realmId);
  if (matches.length !== 1 || matches[0].source_profile !== 'astrid' || typeof matches[0].data_root !== 'string') {
    return fail(CANT_START, 'selected Runtime catalog row is not one Astrid profile with a data root');
  }
  try {
    const discoveredRoot = realpathSync(realmRoot);
    const catalogRoot = realpathSync(matches[0].data_root);
    if (discoveredRoot !== catalogRoot) return fail(CANT_START, 'Runtime discovery realm root does not match the selected Astrid catalog root');
  } catch (error) {
    return fail(CANT_START, `cannot resolve the selected Astrid realm root: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { actorId: credential.actorId, realmId, realmRoot, runtimeInstanceId };
}

function requireLoopbackEndpoint(raw) {
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    return fail(CANT_START, `runtime endpoint is not a valid URL: ${String(raw)}`);
  }
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    return fail(CANT_START, 'runtime endpoint must be an http loopback URL');
  }
  if (!endpoint.port || !/^\d+$/.test(endpoint.port)) {
    return fail(CANT_START, 'runtime endpoint must include an explicit port');
  }
  return endpoint;
}

const NOT_RUNNING = Symbol('Runtime is not running');
async function verifyRuntime(endpoint, token, expectedIdentity, allowStart = false) {
  let expectedSchemaDigest;
  try {
    expectedSchemaDigest = readGeneratedSchemaDigest(generatedMetadataPath);
  } catch (error) {
    return fail(CANT_START, error instanceof Error ? error.message : String(error));
  }

  try {
    const response = await fetch(new URL('/v1/health', endpoint), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return fail(ENGINE_STOPPED, `runtime health check returned HTTP ${response.status}`);
    const health = await response.json();
    const incompatible = (actual, reason) => {
      const selected = runtimeCommand('restart');
      const quote = (value) => /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
      const invocation = [selected.command, ...selected.args.filter((value) => value !== '--json')].map(quote).join(' ');
      const restart = pinokioManaged ? 'Stop and start Astrid in Pinokio' : `${selected.cwd ? `cd ${quote(selected.cwd)} && ` : ''}${invocation}`;
      console.error(`Astrid: Runtime ${actual?.protocol ?? 'unknown'} schema ${actual?.schema_digest ?? 'unknown'} is incompatible with App workspace.v1 schema ${expectedSchemaDigest}; ${reason}; ${SOURCE_SCHEMA_MISMATCH_ACTION}; restart: ${restart}`);
      process.exitCode = 1;
      return null;
    };
    if (health?.status !== 'ok' || health?.protocol !== 'workspace.v1') {
      return incompatible(health, 'runtime health check did not report workspace.v1/ok');
    }
    if (health?.runtime_instance_id !== expectedIdentity.runtimeInstanceId) {
      return fail(ENGINE_CHANGED, 'Runtime health instance does not match the selected Astrid profile');
    }
    const acceptedSchemaDigests = [expectedSchemaDigest, ...LEGACY_RUNTIME_SCHEMA_DIGESTS];
    const digestError = schemaDigestMismatch(health?.schema_digest, acceptedSchemaDigests);
    if (digestError) return incompatible(health, 'runtime schema digest mismatch');

    const handshakeResponse = await fetch(new URL('/v1/handshake', endpoint), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: 'workspace.v1',
        client_name: 'astrid-local-launcher',
        client_version: '1',
        requested_scopes: RUNTIME_SCOPES,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!handshakeResponse.ok) return fail(CANT_START, `Runtime identity handshake returned HTTP ${handshakeResponse.status}`);
    const handshake = await handshakeResponse.json();
    const handshakeDigestError = schemaDigestMismatch(handshake?.schema_digest, acceptedSchemaDigests);
    if (handshakeDigestError) return incompatible(handshake, 'Runtime handshake schema digest mismatch');
    if (handshake?.protocol !== 'workspace.v1'
      || handshake?.actor_id !== expectedIdentity.actorId
      || FORBIDDEN_ACTORS.has(handshake?.actor_id)
      || handshake?.realm_id !== expectedIdentity.realmId
      || !exactStringList(handshake?.scopes, RUNTIME_SCOPES)) {
      return incompatible(handshake, 'Runtime handshake actor, realm, protocol, or product scopes do not match the selected Astrid profile');
    }

    const realmResponse = await fetch(new URL('/v1/realm', endpoint), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!realmResponse.ok) return fail(CANT_START, `Runtime realm check returned HTTP ${realmResponse.status}`);
    const realm = await realmResponse.json();
    if (realm?.realm_id !== expectedIdentity.realmId) {
      return fail(CANT_START, 'Runtime realm does not match the selected Astrid profile');
    }
    return true;
  } catch (error) {
    if (allowStart && error.cause?.code === 'ECONNREFUSED') return NOT_RUNNING;
    const recovery = pinokioManaged ? 'Start Astrid in Pinokio' : `run ${runtimeUpCommand}`;
    return fail(ENGINE_STOPPED, `runtime is unavailable at ${endpoint.origin} (${recovery}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateDiscovery(discovery) {
  const endpoint = requireLoopbackEndpoint(discovery.endpoint);
  if (!endpoint) return null;
  const credentialPath = discovery.credential_file;
  if (typeof credentialPath !== 'string' || !credentialPath.trim()) return fail(CANT_START, 'discovery has no credential_file');
  const credential = readProductCredential(credentialPath, 'runtime credential');
  if (!credential) return null;
  const expectedIdentity = requireIdentity(discovery, discoveryPath, credential);
  return expectedIdentity ? { endpoint, credentialPath, credential, expectedIdentity } : null;
}

// Recover C2's retained App context before ordinary startup can select a
// replacement owner or reject the half-activated tree. A temporary editor
// proves the restored build; normal launcher startup follows on that tree.
if (!checkOnly && !buildOnly) {
  let backend;
  try { backend = installedBackend(resolveRuntimeCommand(runtimeSettings).command); }
  catch (error) { if (error.step !== 'select-backend') throw error; }
  if (backend && !runtimeSettings.runtimeCheckout) {
    runtimeSettings.runtimePython = backend.python;
    runtimeSettings.sourceManifest = backend.profile;
  }
  const pending = backend ? await readUpdateJournal(backend.root) : null;
  if (pending?.transaction_context?.owner === 'local-update' && !journalSettled(pending)) {
    let recoveryEditor;
    let recoverySelection;
    const pinokio = pinokioSession(backend);
    const stopRecoveryEditor = async () => {
      if (recoveryEditor) await stopService(services.find((item) => item.child === recoveryEditor), 'SIGTERM');
      recoveryEditor = undefined;
    };
    try {
      await runBackendUpdate({ backend, action: { action: 'recover' }, hook: async (message) => {
        const app = validateAppContext(message.app, process.cwd());
        switch (message.hook) {
          case 'stop-editor':
            if (pinokioManaged) await pinokio.begin();
            await stopRecoveryEditor();
            if (await waitForPort(port, 0)) throw new Error(`Recovery needs the previous editor on port ${port} to be stopped. Keep ${app.preparationRoot} and retry after stopping that editor.`);
            break;
          case 'restore-checkout':
            await restoreCheckout({ cwd: process.cwd(), state: app });
            await restorePreparedResources(app);
            break;
          case 'pinokio-start':
            await pinokio.start(message.version, message.operationId);
            break;
          case 'start-editor': {
            runtimeSettings.runtimePython = message.version.python;
            runtimeSettings.sourceManifest = message.version.profile;
            runtimeSettings.runtimeCheckout = undefined;
            recoverySelection = validateDiscovery(JSON.parse(readFileSync(discoveryPath, 'utf8')));
            if (!recoverySelection || !(await verifyRuntime(recoverySelection.endpoint, recoverySelection.credential.token, recoverySelection.expectedIdentity))) throw new Error('The restored Runtime did not pass its realm and handshake checks');
            const recoveryEnv = { ...process.env, PORT: port,
              ASTRID_RUNTIME_DATA_ROOT: runtimeSettings.dataRoot, ASTRID_SUPPORT_ROOT: runtimeSettings.dataRoot,
              ASTRID_WORKSPACE_DISCOVERY: discoveryPath, ASTRID_RUNTIME_PYTHON: message.version.python,
              ASTRID_RUNTIME_SOURCE_MANIFEST: message.version.profile,
              WORKSPACE_RUNTIME_TOKEN_FILE: recoverySelection.credentialPath,
              VITE_WORKSPACE_RUNTIME_URL: recoverySelection.endpoint.origin,
              VITE_APP_BUILD: app.oldAppBuild, RAILWAY_GIT_COMMIT_SHA: app.oldAppBuild,
            };
            const invocation = packageManagerInvocation('npm', viteChildArgs({ preview: app.previousMode === 'preview', previewDir: app.previousPreviewDirectory, quiet: true }), { env: recoveryEnv });
            recoveryEditor = spawnService(invocation.command, invocation.args, { kind: 'vite', stdio: 'ignore', env: recoveryEnv });
            if (!(await waitForPort(port, 60_000, () => recoveryEditor.exitCode !== null || recoveryEditor.signalCode !== null))) throw new Error('The restored editor did not start');
            break;
          }
          case 'verify-editor': {
            const response = await fetch(`http://127.0.0.1:${port}/build.json`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
            const build = await response.json();
            if (!response.ok || build.app !== app.oldAppBuild || build.release !== app.oldAppRelease || recoveryEditor.exitCode !== null) throw new Error('The restored App build did not pass verification');
            break;
          }
          case 'release-app':
            await stopRecoveryEditor();
            if (pinokioManaged) await pinokio.end();
            await releasePreparation({ cwd: process.cwd(), state: app });
            break;
          default: throw new Error(`Unexpected recovery callback ${message.hook}`);
        }
      } });
    } finally { await stopRecoveryEditor(); }
  }
}

// A fresh preview launch can have no active dist while a retained update
// transaction still owns the old build. Let recovery restore it before applying
// the ordinary preview-output check.
if (launcherOptions.preview) {
  try {
    previewDirectory = validatePreviewOutputDirectory(launcherOptions.previewDir);
  } catch (error) {
    exit(fail(CANT_START, error instanceof Error ? error.message : String(error)) ? 1 : 1);
  }
}

let discovery = existsSync(discoveryPath) || checkOnly || buildOnly
  ? readJson(discoveryPath, 'runtime discovery', NOT_SET_UP) : null;
if (process.exitCode) exit(1);
if (Number.isInteger(discovery?.pid) && discovery.pid > 0) {
  try { process.kill(discovery.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') discovery = null; else throw error; }
}
let selected = discovery ? validateDiscovery(discovery) : null;
if (discovery && !selected) exit(1);
let verified = selected ? await verifyRuntime(selected.endpoint, selected.credential.token, selected.expectedIdentity, !checkOnly && !buildOnly) : NOT_RUNNING;
if (interrupted) exit(130);
if (verified === NOT_RUNNING && !checkOnly && !buildOnly) {
  let result;
  try {
    result = await runRuntimeCommand('up'); // CLI publishes discovery only after its owner passes readiness.
  } catch (error) {
    // The Runtime names whatever already holds its door's port.
    const message = error instanceof Error ? error.message : String(error);
    exit(fail(/already served by another Astrid Runtime/.test(message) ? OTHER_ASTRID_RUNNING
      : /already in use by a program/.test(message) ? PROGRAM_IN_THE_WAY : CANT_START, message) ? 1 : 1);
  }
  if (!['started', 'reconnected'].includes(result.status)) throw new Error('Runtime up did not report started or reconnected');
  // Runtime publishes here after readiness; CLI output cannot redirect our data root.
  discoveryPath = resolve(runtimeSettings.dataRoot, 'runtime', 'discovery.json');
  discovery = readJson(discoveryPath, 'runtime discovery', NOT_SET_UP);
  if (result.status === 'started' && discovery?.runtime_instance_id) {
    ownedRuntime = { discoveryPath, instanceId: discovery.runtime_instance_id };
  }
  if (!discovery) exit(1);
  selected = validateDiscovery(discovery);
  if (!selected) exit(1);
  verified = await verifyRuntime(selected.endpoint, selected.credential.token, selected.expectedIdentity);
}
if (verified === NOT_RUNNING) exit(fail(NOT_SET_UP, `no live Runtime discovery at ${discoveryPath}`) ? 1 : 1);
if (!verified) exit(process.exitCode ?? 1);
if (interrupted) exit(130);
let { endpoint, credentialPath, credential, expectedIdentity } = selected;
const doorPort = hostedOrigin && !checkOnly && !buildOnly ? requireDoor(discovery, hostedOrigin) : null;
if (hostedOrigin && !checkOnly && !buildOnly && !doorPort) exit(1);
if (paired && !pairedRelayOrigin) exit(fail(CANT_START, '--paired requires ASTRID_APP_PAIRED_RELAY_ORIGIN') ? 1 : 1);

const runtimeProxyPort = process.env.VITE_ASTRID_DYNAMIC_PROXY_PORT?.trim() || '17336';
if (!/^\d+$/.test(runtimeProxyPort) || Number(runtimeProxyPort) < 1 || Number(runtimeProxyPort) > 65535) {
  exit(fail(CANT_START, 'VITE_ASTRID_DYNAMIC_PROXY_PORT must be an integer from 1 to 65535') ? 1 : 1);
}

/** Resolves true once something listens on the port, false at the deadline or when `aborted()` turns true. */
function waitForPort(portValue, timeoutMs = 3000, aborted = () => false) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveReady) => {
    const attempt = () => {
      const socket = createConnection({ host: '127.0.0.1', port: Number(portValue) });
      socket.once('connect', () => {
        socket.destroy();
        resolveReady(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (aborted() || Date.now() >= deadline) resolveReady(false);
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

const env = {
  ...process.env,
  // The agent's CLI/SDK must address the same selected workspace as the editor,
  // including when --data-root overrides an ambient/default installation.
  ASTRID_RUNTIME_DATA_ROOT: runtimeSettings.dataRoot,
  ASTRID_SUPPORT_ROOT: runtimeSettings.dataRoot,
  ASTRID_WORKSPACE_DISCOVERY: discoveryPath,
  ASTRID_LOCAL_UPDATE_STATUS: '1',
  VITE_ASTRID_LOCAL_UPDATE_STATUS: '1',
  ...(astridCheckout ? { ASTRID_CHECKOUT: astridCheckout } : {}),
  ...(configuredAstridPublicCheckout ? { ASTRID_PUBLIC_CHECKOUT: configuredAstridPublicCheckout } : {}),
  PORT: port,
  ASTRID_RUNTIME_OPERATION_ORIGIN: `http://127.0.0.1:${port}`,
  VITE_ASTRID_BRIDGE_PORT: runtimeProxyPort,
  VITE_ASTRID_ACP_BRIDGE_PORT: runtimeProxyPort,
  ASTRID_ACP_VIA_DISCOVERY_PROXY: '1',
  ASTRID_BRIDGE_TOKEN: credential.token,
  // The editor's RuntimeDataProvider talks to `/api/runtime`, which is a
  // separate Vite proxy from the historical `/api/astrid` bridge. Keep the
  // Runtime endpoint and credential server-side so the browser never sees the
  // owner token.
  VITE_WORKSPACE_RUNTIME_URL: `http://127.0.0.1:${runtimeProxyPort}`,
  WORKSPACE_RUNTIME_TOKEN_FILE: credentialPath,
  // Fallback for builds without a live workspace config endpoint. Local preview
  // refreshes these non-secret identifiers from discovery on each page load.
  VITE_WORKSPACE_RUNTIME_EXPECTED_ACTOR_ID: expectedIdentity.actorId,
  VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID: expectedIdentity.realmId,
  VITE_WORKSPACE_RUNTIME_EXPECTED_INSTANCE_ID: expectedIdentity.runtimeInstanceId,
  ASTRID_LOCAL_COMPOSE_URL: `http://127.0.0.1:${port}/api/astrid/generation/compose`,
};

const healthyLine = `workspace.v1 runtime healthy at ${endpoint.origin}; Astrid App will use ${launcherOptions.preview ? `preview output ${previewDirectory} on port ${port}` : `port ${port}`}`;
if (checkOnly) {
  if (verbose) console.log(healthyLine);
  console.log('Astrid is ready.');
  exit(0);
}

// The build retains this identity for hosted/paired fallback. Local preview
// serves a fresh discovery-backed binding on each page load.
if (buildOnly) {
  if (verbose) console.log(healthyLine);
  const buildEnv = { ...env };
  const nodeOptions = (env.NODE_OPTIONS || '').trim();
  if (!/(?:^|\s)--max-old-space-size(?:=|\s|$)/.test(nodeOptions)) {
    buildEnv.NODE_OPTIONS = [nodeOptions, '--max-old-space-size=4096'].filter(Boolean).join(' ');
  }
  const buildInvocation = packageManagerInvocation('npm', ['run', 'build'], { env: buildEnv });
  const build = spawnService(buildInvocation.command, buildInvocation.args, { kind: 'vite', stdio: 'inherit', env: buildEnv });
  build.on('error', (error) => { fail(CANT_START, `could not build Astrid App: ${error.message}`); process.exitCode = 1; });
  const [code, signal] = await new Promise((resolveExit) => build.once('close', (...result) => resolveExit(result)));
  if (code === 0 && !signal && !(await verifyRuntime(endpoint, credential.token, expectedIdentity))) process.exitCode = 1;
  else process.exitCode = process.exitCode || (code ?? 1);
} else {

const verboseCommand = `${startCommand}${startCommand === 'npm run dev:local' ? ' --' : ''} --verbose`;
const COULDNT_START = `Astrid couldn't start. Run ${verboseCommand} to see why.`;
/** How long Vite may take to listen. */
const VITE_START_TIMEOUT_MS = 60_000;

// The app's own port: if anything already listens there, Vite (`--strictPort`) cannot start. Another launcher's app for this
// realm is Astrid already running; anything else is in the way. No App services have started; cleanup releases any owned Runtime.
if (port !== '0' && await waitForPort(port, 0)) {
  const holder = await appPortHolder(port, expectedIdentity.realmId);
  if (holder === 'ours') {
    console.log('Astrid is already running in another window.');
    printOpenBlock(editorUrl);
    exit(0);
  }
  if (holder === 'other_astrid') exit(fail(OTHER_ASTRID_RUNNING, `port ${port} is in use by Astrid's app for another realm`) ? 1 : 1);
  exit(fail(PROGRAM_IN_THE_WAY, `port ${port} is in use`) ? 1 : 1);
}
if (interrupted) exit(130);

// With a hosted address, the technical lines are held back (`--verbose` prints them after the Open block). Without one
// there is no Open block, so the launcher prints what it always did.
const showTechnical = verbose || !hostedOrigin;
let opened = !hostedOrigin;
let shuttingDown = false;
const held = [];
const emit = (text, toStderr = false) => {
  if (opened) (toStderr ? process.stderr : process.stdout).write(text);
  else held.push([text, toStderr]);
};
const flushHeld = () => {
  opened = true;
  for (const [text, toStderr] of held.splice(0)) (toStderr ? process.stderr : process.stdout).write(text);
};
const technical = (line) => { if (showTechnical) emit(`${line}\n`); };

/** Reads a service's output: kept (the last few lines) for a `Details:` line, shown only for `showTechnical`. */
function watch(child, onStdoutLine) {
  const state = { tail: '', pending: '' };
  const read = (toStderr) => (chunk) => {
    const text = chunk.toString('utf8');
    state.tail = (state.tail + text).slice(-4000);
    if (!toStderr && onStdoutLine) {
      state.pending += text;
      let newline;
      while ((newline = state.pending.indexOf('\n')) >= 0) {
        onStdoutLine(state.pending.slice(0, newline));
        state.pending = state.pending.slice(newline + 1);
      }
    }
    if (showTechnical) emit(text, toStderr);
  };
  child.stdout.on('data', read(false));
  child.stderr.on('data', read(true));
  return state;
}
const lastLine = (state) => state.tail.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';
const withLast = (state) => (lastLine(state) ? `: ${lastLine(state)}` : '');
const serviceEnvironment = (extra = {}) => ({
  ...env,
  ...(process.stdout.isTTY && showTechnical ? { FORCE_COLOR: '1' } : {}),
  ...extra,
});
const piped = ['ignore', 'pipe', 'pipe'];
const npmQuiet = showTechnical ? [] : ['--silent'];

if (hostedOrigin) console.log('Starting Astrid…');
technical(healthyLine);

let connector;
// Kept for the local app: it is same-origin and reaches the Runtime through this proxy, while the Runtime's door answers
// only the hosted origin.
const runtimeProxy = spawnService(process.execPath, ['scripts/runtime-discovery-proxy.mjs'], {
  stdio: piped,
  env: serviceEnvironment({ ASTRID_RUNTIME_PROXY_PORT: runtimeProxyPort, ASTRID_WORKSPACE_DISCOVERY: discoveryPath }),
});
const proxyOutput = watch(runtimeProxy);
const proxyReady = await waitForPort(runtimeProxyPort);
if (interrupted) exit(130);
if (!proxyReady) {
  flushHeld();
  exit(fail(COULDNT_START, `runtime discovery proxy did not start on port ${runtimeProxyPort}${withLast(proxyOutput)}`) ? 1 : 1);
}
if (hostedOrigin) technical(`browser door ${discovery.door_endpoint} for ${hostedOrigin}`);
if (paired) {
  const invocation = packageManagerInvocation('npx', ['tsx', 'scripts/astrid-local-connector.ts', '--discovery', discoveryPath, '--relay-origin', pairedRelayOrigin, ...(resetPairing ? ['--reset-pairing'] : [])], { env });
  connector = spawnService(invocation.command, invocation.args, {
    stdio: 'inherit',
    env,
  });
}

const viteInvocation = packageManagerInvocation('npm', [...npmQuiet, ...viteChildArgs({
  preview: launcherOptions.preview,
  previewDir: previewDirectory,
  quiet: !showTechnical,
})], { env });
let child = spawnService(viteInvocation.command, viteInvocation.args, {
  kind: 'vite', stdio: piped,
  // The local Vite process is the connector's fixed compose/ACP destination;
  // it must not install another relay and accidentally loop back to itself.
  env: serviceEnvironment(paired ? { ASTRID_APP_PAIRED_RELAY_ENABLED: '0', ASTRID_LOCAL_COMPOSE_URL: `http://127.0.0.1:${port}/api/astrid/generation/compose` } : {}),
});
let viteOutput = watch(child);
let updatingEditor = false;
let finishLauncher;
const launcherFinished = new Promise((done) => { finishLauncher = done; });

const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  void cleanup(signal).catch((error) => fail(CANT_START, error.message)).finally(finishLauncher);
};
/** A failure: the technical output held back so far is shown, then the friendly line and its details. */
const stopWith = (friendly, details) => {
  if (shuttingDown) return;
  flushHeld();
  fail(friendly, details);
  shutdown('SIGTERM');
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
function watchEditor(instance) {
instance.on('error', (error) => { if (!updatingEditor && instance === child) stopWith(COULDNT_START, `could not start Vite: ${error.message}`); });
instance.on('exit', (code, signal) => {
  if (updatingEditor || instance !== child) return;
  if (!shuttingDown && !opened && (code ?? 1) !== 0) {
    // Vite never listened: usually the app's port is taken (`--strictPort`).
    stopWith(/already in use|EADDRINUSE/i.test(viteOutput.tail) ? PROGRAM_IN_THE_WAY : COULDNT_START, `Vite exited${signal ? ` with ${signal}` : ` with code ${code}`}${withLast(viteOutput)}`);
  }
  shutdown('SIGTERM');
  process.exitCode = process.exitCode || (code ?? 0);
});
}
watchEditor(child);

const updaterEditor = {
  mode: launcherOptions.preview ? 'preview' : 'dev',
  previewDirectory,
  async captureIdentity() {
    const response = await fetch(`http://127.0.0.1:${port}/build.json`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    const build = await response.json();
    if (!response.ok || typeof build.app !== 'string' || !Number.isSafeInteger(build.release)) throw new Error('The current App did not serve its build identity');
    return build;
  },
  async stop() {
    updatingEditor = true;
    const service = services.find((item) => item.child === child);
    if (service) await stopService(service, 'SIGTERM');
  },
  async start({ app, version, rollback }) {
    discovery = readJson(discoveryPath, 'runtime discovery', NOT_SET_UP);
    selected = discovery && validateDiscovery(discovery);
    if (!selected) throw new Error('The selected Runtime did not publish a valid discovery record');
    ({ endpoint, credentialPath, credential, expectedIdentity } = selected);
    runtimeSettings.runtimePython = version.python;
    runtimeSettings.sourceManifest = version.profile;
    runtimeSettings.runtimeCheckout = undefined;
    if (ownedRuntime) ownedRuntime.instanceId = expectedIdentity.runtimeInstanceId;
    Object.assign(env, version.env);
    if (version.env?.ASTRID_NODE_EXECUTABLE) {
      delete env.npm_execpath;
      env.npm_node_execpath = version.env.ASTRID_NODE_EXECUTABLE;
    }
    Object.assign(env, {
      ASTRID_RUNTIME_PYTHON: version.python,
      ASTRID_RUNTIME_SOURCE_MANIFEST: version.profile,
      WORKSPACE_RUNTIME_TOKEN_FILE: credentialPath,
      ASTRID_BRIDGE_TOKEN: credential.token,
      VITE_WORKSPACE_RUNTIME_EXPECTED_ACTOR_ID: expectedIdentity.actorId,
      VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID: expectedIdentity.realmId,
      VITE_WORKSPACE_RUNTIME_EXPECTED_INSTANCE_ID: expectedIdentity.runtimeInstanceId,
      VITE_APP_BUILD: rollback ? app.oldAppBuild : app.targetSha,
      RAILWAY_GIT_COMMIT_SHA: rollback ? app.oldAppBuild : app.targetSha,
    });
    await updateControl?.rotatePageToken();
    const mode = rollback ? app.previousMode : updaterEditor.mode;
    const output = rollback ? app.previousPreviewDirectory : resolve(process.cwd(), 'dist');
    const invocation = packageManagerInvocation('npm', viteChildArgs({ preview: mode === 'preview', previewDir: output, quiet: !showTechnical }), { env, execPath: env.ASTRID_NODE_EXECUTABLE || process.execPath });
    child = spawnService(invocation.command, invocation.args, { kind: 'vite', stdio: piped, env: serviceEnvironment() });
    viteOutput = watch(child);
    watchEditor(child);
    if (!(await waitForPort(port, VITE_START_TIMEOUT_MS, () => child.exitCode !== null || child.signalCode !== null))) {
      throw new Error(`The editor did not restart on port ${port}${withLast(viteOutput)}`);
    }
  },
  async verify({ app, version, rollback }) {
    if (!(await verifyRuntime(endpoint, credential.token, expectedIdentity))) throw new Error('Runtime identity, selected realm, or handshake verification failed');
    const healthResponse = await fetch(new URL('/v1/health', endpoint), { headers: { Authorization: `Bearer ${credential.token}` }, signal: AbortSignal.timeout(3000) });
    const health = await healthResponse.json();
    if (health.release !== version.identity.release || (health.managed_by ?? null) !== (version.identity.managed_by ?? null)) {
      throw new Error('The running Runtime release identity does not match the selected backend');
    }
    const buildResponse = await fetch(`http://127.0.0.1:${port}/build.json`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (!buildResponse.ok) throw new Error('The restarted App did not serve its build identity');
    const build = await buildResponse.json();
    if (build.app !== (rollback ? app.oldAppBuild : app.targetSha) || build.release !== (rollback ? app.oldAppRelease : app.release)) {
      throw new Error('The restarted App build/release does not match the selected checkout');
    }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('The restarted editor exited during verification');
    updatingEditor = false;
    updaterEditor.previewDirectory = rollback ? app.previousPreviewDirectory : resolve(process.cwd(), 'dist');
  },
};
// The secret and ephemeral control port stay in this worktree's private Git
// metadata. The CLI asks this already-running launcher to perform the update.
try {
updateControl = await startLocalUpdateControl({ cwd: process.cwd(), origin: new URL(editorUrl).origin, page: !pinokioManaged, update: async () => {
  if (shuttingDown || interrupted) throw new Error('Astrid is stopping. Start it again before updating.');
  let backend;
  try { backend = installedBackend(resolveRuntimeCommand(runtimeSettings).command); }
  catch (error) {
    if (error.step !== 'select-backend') throw error;
    const target = await selectUpdateTarget({ cwd: process.cwd() });
    if (target.upToDate) return { status: 'up-to-date', message: 'Astrid is up to date.' };
    throw error;
  }
  const update = createLocalUpdater({ cwd: process.cwd(), backend, editor: updaterEditor, backendUpdate: runBackendUpdate,
    prepare: (options) => prepareUpdate({ ...options, environment: env, execPath: env.ASTRID_NODE_EXECUTABLE || process.execPath, preparationDirectory: backend.root }),
    ...(pinokioManaged ? { session: pinokioSession(backend) } : {}),
  });
  const result = await update();
  console.log(result.message);
  return result;
} });
if (shuttingDown || interrupted) await updateControl.close();
} catch (error) {
  if (error.code !== 'ENOENT' || error.path !== 'git') throw error;
  technical('Local updates need Git. Install Git and restart Astrid to use npm run update.');
}
connector?.on('error', (error) => { fail(CANT_START, `could not start paired connector: ${error.message}`); });
// Astrid is reachable when the Runtime's door listens and the app answers. Only then does a person get the Open block.
if (hostedOrigin) {
  const aborted = () => shuttingDown;
  const reachable = await waitForPort(doorPort, 3000, aborted) && await waitForPort(port, VITE_START_TIMEOUT_MS, aborted);
  // Something answering on the app's port is not enough: it has to be our own Vite, still running. A Vite that already
  // exited (its port taken after the check above) leaves another program answering, and that is not Astrid's app.
  const viteAlive = child.exitCode === null && child.signalCode === null;
  if (shuttingDown) {
    // A service already stopped the launch and said why.
  } else if (reachable && viteAlive) {
    printOpenBlock(editorUrl);
    flushHeld();
  } else {
    stopWith(COULDNT_START, `nothing listened on 127.0.0.1:${doorPort} and 127.0.0.1:${port} in time`);
  }
} else if (await waitForPort(port, VITE_START_TIMEOUT_MS, () => shuttingDown)) {
  console.log(`Local App: ${editorUrl}`);
}
await launcherFinished;

}
}

try { await main(); }
catch (error) {
  if (error instanceof LauncherExit) process.exitCode = error.code;
  else fail(CANT_START, error.message);
} finally {
  try { await cleanup(); } catch (error) { fail(CANT_START, error.message); }
}

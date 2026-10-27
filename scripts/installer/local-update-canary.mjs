import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { packageManagerInvocation } from '../node-package-manager.mjs';

const execFileAsync = promisify(execFile);
const BUILD_URL = 'https://astrid.haus/build.json';
const PRODUCT_SCOPES = Object.freeze([
  'handshake', 'projects:read', 'projects:write', 'objects:read', 'objects:write', 'tasks:read', 'tasks:write',
]);
const SHA_RE = /^[0-9a-f]{40}$/i;

function requireValue(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${name}.`);
  return value.trim();
}

async function readBuild(url, request) {
  const response = await request(url, { headers: { Accept: 'application/json' }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  const value = await response.json();
  if (!value || !SHA_RE.test(value.app ?? '') || !Number.isSafeInteger(value.release) || value.release < 0) {
    throw new Error(`${url} did not return a valid App build identity.`);
  }
  return value;
}

async function runUpdate(cwd, { spawnProcess = spawn, platform, environment }) {
  const invocation = packageManagerInvocation('npm', ['run', 'update'], { env: environment, platform });
  const child = spawnProcess(invocation.command, invocation.args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = (chunk) => { output = (output + chunk.toString('utf8')).slice(-32_000); };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve(signal ? 1 : status));
  });
  if (code !== 0) throw new Error(`npm run update failed (exit ${code}): ${output.trim() || 'no output'}`);
  return output;
}

/**
 * Run the native local-update canary from a previously served App checkout.
 * The caller supplies a provisioned installed Runtime and an already running
 * local launcher; this function updates the checkout and verifies the new App
 * build against Runtime health and the product handshake.
 */
export async function runLocalUpdateCanary({
  cwd,
  previousSha,
  request = fetch,
  runGit,
  run = runUpdate,
  spawnProcess = spawn,
  platform = process.platform,
  environment = process.env,
  read = readFile,
} = {}) {
  const checkout = requireValue(cwd, 'canary checkout');
  const expectedPrevious = requireValue(previousSha, 'previous served App SHA').toLowerCase();
  if (!SHA_RE.test(expectedPrevious)) throw new Error('The previous served App SHA is invalid.');
  const gitHead = runGit
    ? await runGit({ cwd: checkout, args: ['rev-parse', '--verify', 'HEAD^{commit}'] })
    : await execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: checkout, encoding: 'utf8' });
  const head = String(typeof gitHead === 'string' ? gitHead : gitHead.stdout ?? '').trim().toLowerCase();
  if (head !== expectedPrevious) throw new Error(`Canary checkout HEAD ${head} is not previous served App ${expectedPrevious}.`);

  const servedBefore = await readBuild(BUILD_URL, request);
  if (servedBefore.app.toLowerCase() === expectedPrevious) throw new Error('The served App has not advanced beyond the previous canary checkout.');
  await run(checkout, { spawnProcess, platform, environment });

  const appOrigin = requireValue(environment.ASTRID_CANARY_APP_ORIGIN, 'ASTRID_CANARY_APP_ORIGIN').replace(/\/$/, '');
  const discoveryPath = requireValue(environment.ASTRID_CANARY_DISCOVERY, 'ASTRID_CANARY_DISCOVERY');
  const discovery = JSON.parse(await read(discoveryPath, 'utf8'));
  const configuredRuntime = environment.ASTRID_CANARY_RUNTIME_ENDPOINT?.trim();
  const runtimeEndpoint = requireValue(discovery.endpoint, 'Runtime endpoint in selected discovery');
  if (configuredRuntime && new URL(configuredRuntime).origin !== new URL(runtimeEndpoint).origin) {
    throw new Error('The configured Runtime endpoint does not match selected Runtime discovery.');
  }
  const expectedManager = environment.ASTRID_CANARY_EXPECTED_MANAGER === 'null'
    ? null : (environment.ASTRID_CANARY_EXPECTED_MANAGER || 'pinokio');
  const credentialPath = requireValue(discovery.credential_file, 'Runtime credential file in discovery');
  const credential = JSON.parse(await read(credentialPath, 'utf8'));
  if (credential.version !== 1 || credential.scope !== 'astrid' || typeof credential.token !== 'string' || !credential.token
    || typeof credential.actor_id !== 'string' || !credential.actor_id) throw new Error('The selected Runtime product credential is invalid.');

  const servedAfter = await readBuild(BUILD_URL, request);
  const localBuild = await readBuild(`${appOrigin}/build.json`, request);
  if (servedAfter.app.toLowerCase() !== servedBefore.app.toLowerCase() || servedAfter.release !== servedBefore.release
    || localBuild.app.toLowerCase() !== servedAfter.app.toLowerCase() || localBuild.release !== servedAfter.release) {
    throw new Error('The updated local App build does not match the served App identity.');
  }

  const configResponse = await request(`${appOrigin}/runtime-config/v1/workspace.json`, { signal: AbortSignal.timeout(5000) });
  if (!configResponse.ok) throw new Error(`Local Runtime binding returned HTTP ${configResponse.status}.`);
  const config = await configResponse.json();
  if (config.schemaVersion !== 1 || !config.runtimeInstanceId || !config.realmId) throw new Error('The local App Runtime binding is incomplete.');
  if (discovery.runtime_instance_id !== config.runtimeInstanceId || discovery.active_realm !== config.realmId) {
    throw new Error('The local App binding does not match the selected Runtime discovery identity.');
  }

  const healthResponse = await request(new URL('/v1/health', runtimeEndpoint), {
    headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(5000),
  });
  if (!healthResponse.ok) throw new Error(`Runtime health returned HTTP ${healthResponse.status}.`);
  const health = await healthResponse.json();
  if (health.status !== 'ok' || health.protocol !== 'workspace.v1' || health.runtime_instance_id !== config.runtimeInstanceId
    || health.release !== servedAfter.release || health.managed_by !== expectedManager) {
    throw new Error('Runtime health does not match the App-selected Runtime identity.');
  }

  const handshakeResponse = await request(new URL('/v1/handshake', runtimeEndpoint), {
    method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 'workspace.v1', client_name: 'astrid-local-update-canary', client_version: '1', requested_scopes: PRODUCT_SCOPES }),
    signal: AbortSignal.timeout(5000),
  });
  if (!handshakeResponse.ok) throw new Error(`Runtime identity handshake returned HTTP ${handshakeResponse.status}.`);
  const handshake = await handshakeResponse.json();
  const actualScopes = Array.isArray(handshake.scopes) ? handshake.scopes : [];
  if (handshake.protocol !== 'workspace.v1' || handshake.actor_id !== credential.actor_id
    || handshake.realm_id !== config.realmId
    || handshake.schema_digest !== health.schema_digest
    || actualScopes.length !== PRODUCT_SCOPES.length || actualScopes.some((scope) => typeof scope !== 'string')
    || JSON.stringify([...actualScopes].sort()) !== JSON.stringify([...PRODUCT_SCOPES].sort())) {
    throw new Error('Runtime handshake identity, realm, protocol, or product scopes do not match the selected App session.');
  }
  return { platform, previousApp: expectedPrevious, servedApp: servedAfter.app, release: servedAfter.release,
    runtimeInstanceId: health.runtime_instance_id, actorId: handshake.actor_id, realmId: handshake.realm_id };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runLocalUpdateCanary({ cwd: process.env.ASTRID_CANARY_CHECKOUT, previousSha: process.env.ASTRID_CANARY_PREVIOUS_APP_SHA })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(`Local update canary failed: ${error.message}`); process.exitCode = 1; });
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runLocalUpdateCanary } from './local-update-canary.mjs';

const previousSha = '1'.repeat(40);
const servedSha = '2'.repeat(40);
const scopes = ['handshake', 'projects:read', 'projects:write', 'objects:read', 'objects:write', 'tasks:read', 'tasks:write'];

function fixture(overrides = {}) {
  const calls = [];
  const health = { status: 'ok', protocol: 'workspace.v1', runtime_instance_id: 'runtime-new', release: 17, managed_by: 'pinokio', schema_digest: 'sha256:test' };
  const handshake = { protocol: 'workspace.v1', actor_id: 'actor-1', realm_id: 'realm-1', schema_digest: 'sha256:test', scopes };
  const config = { schemaVersion: 1, runtimeInstanceId: 'runtime-new', realmId: 'realm-1' };
  const environment = {
    ASTRID_CANARY_APP_ORIGIN: 'http://127.0.0.1:5180',
    ASTRID_CANARY_RUNTIME_ENDPOINT: 'http://127.0.0.1:17340',
    ASTRID_CANARY_DISCOVERY: '/selected/discovery.json',
  };
  const request = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, options });
    if (target === 'https://astrid.haus/build.json' || target === 'http://127.0.0.1:5180/build.json') {
      return { ok: true, status: 200, json: async () => ({ app: servedSha, release: 17 }) };
    }
    if (target.endsWith('/runtime-config/v1/workspace.json')) return { ok: true, status: 200, json: async () => config };
    if (target.endsWith('/v1/health')) return { ok: true, status: 200, json: async () => health };
    if (target.endsWith('/v1/handshake')) return { ok: true, status: 200, json: async () => handshake };
    throw new Error(`Unexpected canary request: ${target}`);
  };
  return {
    calls, health, handshake, config, environment,
    options: {
      cwd: '/previous-checkout', previousSha, environment,
      request,
      runGit: async ({ args }) => { assert.deepEqual(args, ['rev-parse', '--verify', 'HEAD^{commit}']); return previousSha; },
      read: async (file) => file === '/selected/discovery.json'
        ? JSON.stringify({ credential_file: '/selected/credential.json', runtime_instance_id: 'runtime-new', active_realm: 'realm-1', endpoint: 'http://127.0.0.1:17340' })
        : JSON.stringify({ version: 1, scope: 'astrid', token: 'private-token', actor_id: 'actor-1' }),
      run: async (cwd, options) => { assert.equal(cwd, '/previous-checkout'); assert.equal(options.platform, process.platform); },
    },
    ...overrides,
  };
}

test('local update canary updates the previous checkout and verifies served App, Runtime identity and handshake', async () => {
  const f = fixture();
  const result = await runLocalUpdateCanary(f.options);
  assert.deepEqual(result, { platform: process.platform, previousApp: previousSha, servedApp: servedSha,
    release: 17, runtimeInstanceId: 'runtime-new', actorId: 'actor-1', realmId: 'realm-1' });
  assert.equal(f.calls.filter((call) => call.url === 'https://astrid.haus/build.json').length, 2);
  const handshake = f.calls.find((call) => call.url.endsWith('/v1/handshake'));
  assert.equal(handshake.options.headers.Authorization, 'Bearer private-token');
  assert.deepEqual(JSON.parse(handshake.options.body).requested_scopes, scopes);
});

test('local update canary rejects a checkout that is not the previous served App commit', async () => {
  const f = fixture();
  f.options.runGit = async () => '3'.repeat(40);
  await assert.rejects(runLocalUpdateCanary(f.options), /is not previous served App/);
  assert.equal(f.calls.length, 0);
});

test('local update canary refuses a mismatched Runtime handshake', async () => {
  const f = fixture();
  f.handshake.actor_id = 'wrong-actor';
  await assert.rejects(runLocalUpdateCanary(f.options), /handshake identity/);
});

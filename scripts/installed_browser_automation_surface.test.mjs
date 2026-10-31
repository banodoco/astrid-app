import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  OWNER_MARKER,
  PROTOCOL,
  SurfaceError,
  browserUnavailableMessage,
  cleanupOwnedProfile,
  ensureProfile,
  parseLsofListenerPids,
  parseWindowsNativeObservation,
  profileChildPath,
  uniqueLsofListenerPid,
  validateInstalledIdentityObservation,
  validateInstalledProcessObservation,
  validateNativeJobObservation,
  validateEnvelope,
} from './installed_browser_automation_surface.mjs';

const sha = (character) => character.repeat(64);
const commit = (character) => character.repeat(40);

function envelope(action = 'button-update-lost-ack', payload) {
  const payloads = {
    'button-update-lost-ack': { request: 'explicit-update', draft_flush: 'pass', simulate_lost_ack: true },
    'button-unsaved-draft': { surface: 'browser', save: 'failed', request: 'explicit-update' },
    'button-update-explicit': { request: 'explicit-update', operation_id: 'a'.repeat(32) },
    cleanup: { owned_roots_only: true },
  };
  const os = 'linux';
  return {
    protocol: PROTOCOL,
    handoff_id: sha('e'),
    surface: 'browser',
    action,
    adapter_state: {
      phase: action === 'button-update-explicit' ? 'recovery-needed' : action === 'cleanup' ? 'terminal' : 'release1',
      operation_id: action === 'button-update-explicit' ? 'a'.repeat(32) : null,
      next_sequence: action === 'button-update-explicit' ? 4 : action === 'cleanup' ? 6 : 2,
    },
    prior_observations: {},
    request: {
      protocol: 'astrid-release2-boundary/v1',
      sequence: action === 'button-update-explicit' ? 4 : action === 'cleanup' ? 6 : 2,
      action,
      scenario: { scenario_id: `release2-button-direct-${os}`, channel: 'button', mode: 'direct', os, job_id: `direct-${os}` },
      inputs: {
        candidate: { app: commit('1'), agent: commit('2'), runtime: commit('3'), pinokio: commit('4') },
        stand_in: { fixture_sums_sha256: sha('5'), descriptor_sha256: sha('6'), manifest_sha256: sha('7'), release: 2, qualification_marker: 'stand-in-marker', target: { agent: commit('8'), runtime: commit('9'), schema_digest: `sha256:${sha('a')}` } },
        stand_in_marker: 'stand-in-marker',
        root: '/tmp/astrid-installed-root',
        data_root: '/tmp/astrid-installed-data',
      },
      payload: payload ?? payloads[action],
    },
  };
}

test('validates the exact browser protocol and rejects fixture/screenshot evidence', () => {
  assert.equal(validateEnvelope(envelope()).action, 'button-update-lost-ack');
  for (const extra of ['screenshot', 'fixture_json']) {
    const value = envelope();
    value[extra] = 'not accepted';
    assert.throws(() => validateEnvelope(value), SurfaceError);
  }
  const injected = envelope('button-update-lost-ack', { request: 'explicit-update', draft_flush: 'pass', simulate_lost_ack: true, screenshot: '/tmp/proof.png' });
  assert.throws(() => validateEnvelope(injected), /fields are not exact/);
  const history = envelope();
  history.prior_observations = { browser: { states: ['active'] } };
  assert.throws(() => validateEnvelope(history), /prior observations fields are not exact/);
  const adapterExtra = envelope();
  adapterExtra.adapter_state.extra = true;
  assert.throws(() => validateEnvelope(adapterExtra), /adapter state fields are not exact/);
});

test('binds explicit Update to a real operation-shaped identity', () => {
  assert.equal(validateEnvelope(envelope('button-update-explicit')).request.payload.operation_id.length, 32);
  const bad = envelope('button-update-explicit', { request: 'explicit-update', operation_id: 'not-an-operation' });
  assert.throws(() => validateEnvelope(bad), /operation ID is invalid/);
});

test('parses real lsof -Fp fields and fails closed for missing or ambiguous listeners', () => {
  const real = 'p4242\nf123\nn127.0.0.1:4173\n';
  assert.deepEqual(parseLsofListenerPids(real), ['4242']);
  assert.equal(uniqueLsofListenerPid(real), 4242);
  assert.deepEqual(parseLsofListenerPids('p\\4242\nf123\n'), []);
  assert.throws(() => uniqueLsofListenerPid('p\\4242\nf123\n'), /missing/);
  assert.throws(() => uniqueLsofListenerPid('p4242\np4343\n'), /ambiguous/);
});

test('accepts the PID emitted by the host lsof -Fp implementation', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync('lsof', ['-nP', '-a', '-p', String(process.pid), '-Fp'], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(uniqueLsofListenerPid(result.stdout), process.pid);
});

test('authenticates the serving process, origin, all candidate identities, and owner handoff', () => {
  const candidate = { app: commit('1'), agent: commit('2'), runtime: commit('3'), pinokio: commit('4') };
  const process = { pid: 42, command: '/Applications/Astrid.app/Contents/MacOS/Astrid', executable: '/Applications/Astrid.app/Contents/MacOS/Astrid', cwd: '/Applications/Astrid.app', origin: 'http://127.0.0.1:4173' };
  const observed = { build: { app: candidate.app, release: 1 }, manifest: { release: 1, agent: { sha: candidate.agent }, runtime: { sha: candidate.runtime } }, installedHandoff: { protocol: 'astrid-installed-surface-handoff/v1', owner: 'astrid-installed-product', install_root: '/Applications/Astrid.app', data_root: '/Users/test/Astrid', managed_by: null, pinokio: { sha: candidate.pinokio } } };
  const identity = validateInstalledIdentityObservation({ observed, candidate, visibleRelease: 1, visibleBuild: candidate.app, installedProcess: process, pageOrigin: process.origin, installRoot: '/Applications/Astrid.app', dataRoot: '/Users/test/Astrid', scenario: { mode: 'direct' } });
  assert.deepEqual({ app: identity.app, agent: identity.agent, runtime: identity.runtime, pinokio: identity.pinokio, managed_by: identity.managed_by, release: identity.release }, { app: candidate.app, agent: candidate.agent, runtime: candidate.runtime, pinokio: candidate.pinokio, managed_by: null, release: 1 });
  assert.throws(() => validateInstalledIdentityObservation({ observed: { ...observed, build: { app: commit('f'), release: 1 } }, candidate, visibleRelease: 1, visibleBuild: candidate.app, installedProcess: process, pageOrigin: process.origin, installRoot: '/Applications/Astrid.app', dataRoot: '/Users/test/Astrid', scenario: { mode: 'direct' } }), /differs from requested candidate/);
  assert.throws(() => validateInstalledIdentityObservation({ observed: { ...observed, manifest: { ...observed.manifest, agent: { sha: commit('f') } } }, candidate, visibleRelease: 1, visibleBuild: candidate.app, installedProcess: process, pageOrigin: process.origin, installRoot: '/Applications/Astrid.app', dataRoot: '/Users/test/Astrid', scenario: { mode: 'direct' } }), /Agent or Runtime identity/);
  assert.throws(() => validateInstalledIdentityObservation({ observed: { ...observed, installedHandoff: { ...observed.installedHandoff, pinokio: { sha: commit('f') } } }, candidate, visibleRelease: 1, visibleBuild: candidate.app, installedProcess: process, pageOrigin: process.origin, installRoot: '/Applications/Astrid.app', dataRoot: '/Users/test/Astrid', scenario: { mode: 'direct' } }), /Pinokio identity/);
  assert.throws(() => validateInstalledProcessObservation({ command: 'node node_modules/.bin/vite --host', cwd: '/source/astrid-app', executable: '/source/astrid-app/node_modules/.bin/vite', installRoot: '/source/astrid-app', platform: 'macos' }), /source\/dev server/);
  assert.throws(() => validateInstalledProcessObservation({ command: process.command, cwd: process.cwd, executable: '/tmp/replaced/Astrid', installRoot: '/Applications/Astrid.app', platform: 'macos' }), /outside/);
  assert.doesNotThrow(() => validateInstalledProcessObservation(process ? { ...process, installRoot: '/Applications/Astrid.app', platform: 'macos' } : process));
});

test('Windows native observation is strict, exact, and does not claim cwd evidence', () => {
  const output = JSON.stringify({ listener: [{ LocalAddress: '127.0.0.1', LocalPort: 4173, OwningProcess: 77 }], process: { ProcessId: 77, ExecutablePath: 'C:\\Astrid\\Astrid.exe', CommandLine: 'C:\\Astrid\\Astrid.exe --installed' } });
  const observed = parseWindowsNativeObservation(output, { port: 4173, installRoot: 'C:\\Astrid' });
  assert.equal(observed.pid, 77);
  assert.equal(observed.cwd, null);
  assert.equal(observed.cwd_evidence, 'unknown');
  assert.equal(observed.native_evidence, 'unknown');
  assert.throws(() => parseWindowsNativeObservation(JSON.stringify({ listener: [{ LocalAddress: '127.0.0.1', LocalPort: 4174, OwningProcess: 77 }], process: { ProcessId: 77, ExecutablePath: 'C:\\Astrid\\Astrid.exe', CommandLine: 'C:\\Astrid\\Astrid.exe' } }), { port: 4173, installRoot: 'C:\\Astrid' }), /exact port/);
  assert.throws(() => parseWindowsNativeObservation(JSON.stringify({ listener: [{ LocalAddress: '127.0.0.1', LocalPort: 4173, OwningProcess: 77 }, { LocalAddress: '::1', LocalPort: 4173, OwningProcess: 78 }], process: { ProcessId: 77, ExecutablePath: 'C:\\Astrid\\Astrid.exe', CommandLine: 'C:\\Astrid\\Astrid.exe' } }), { port: 4173, installRoot: 'C:\\Astrid' }), /ambiguous/);
});

test('native_jobs is accepted only from the separately authenticated native owner', () => {
  const handoffId = sha('b');
  const operationId = 'b'.repeat(32);
  const base = { protocol: 'astrid-update-platform/v1', owner: 'native-update-owner', handoff_id: handoffId, operation_id: operationId, count: 1 };
  assert.equal(validateNativeJobObservation(base, { handoffId, operationId }), 1);
  assert.throws(() => validateNativeJobObservation({ ...base, handoff_id: sha('c') }, { handoffId, operationId }), /authenticated/);
  assert.throws(() => validateNativeJobObservation({ ...base, owner: 'browser' }, { handoffId, operationId }), /authenticated/);
});

test('reports the authentic-host browser limitation without creating a profile', async () => {
  const missing = '/definitely/not/a/browser';
  assert.match(browserUnavailableMessage(missing), /does not download or install a browser/);
  const profile = await mkdtemp(join(tmpdir(), 'astrid-browser-boundary-'));
  await rm(profile, { recursive: true, force: true });
  const input = JSON.stringify(envelope());
  const child = await import('node:child_process');
  const result = child.spawnSync(process.execPath, ['./scripts/installed_browser_automation_surface.mjs', '--installed-url', 'http://127.0.0.1:9/', '--profile-root', profile, '--browser-path', missing], { input, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AUTHENTIC_HOST_LIMITATION/);
  await assert.rejects(stat(profile));
});

test('cleanup refuses an unowned profile and does not remove unrelated files', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'astrid-browser-unowned-'));
  const sentinel = join(profile, 'keep.txt');
  await writeFile(sentinel, 'unrelated');
  await assert.rejects(cleanupOwnedProfile(envelope('cleanup'), profile), /without this command owner marker/);
  assert.equal(await readFile(sentinel, 'utf8'), 'unrelated');
  await rm(profile, { recursive: true, force: true });
});

test('profile ownership uses a fresh child and cleanup never removes a pre-existing nonempty parent', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'astrid-browser-parent-'));
  await writeFile(join(profile, 'caller-owned.txt'), 'keep');
  const value = envelope();
  const owned = await ensureProfile(profile, value.request.inputs.candidate.app, value.request.scenario, { action: value.action, value: value.handoff_id }, { installRoot: value.request.inputs.root, dataRoot: value.request.inputs.data_root });
  await writeFile(join(owned.root, 'browser-state'), 'owned');
  await cleanupOwnedProfile(envelope('cleanup'), profile);
  assert.equal(await readFile(join(profile, 'caller-owned.txt'), 'utf8'), 'keep');
  await rm(profile, { recursive: true, force: true });
});

test('profile ownership rejects a parent symlink and a raced/symlinked child', async () => {
  const target = await mkdtemp(join(tmpdir(), 'astrid-browser-symlink-target-'));
  const link = join(tmpdir(), `astrid-browser-parent-link-${Date.now()}`);
  await symlink(target, link);
  const value = envelope();
  await assert.rejects(ensureProfile(link, value.request.inputs.candidate.app, value.request.scenario, { action: value.action, value: value.handoff_id }, { installRoot: value.request.inputs.root, dataRoot: value.request.inputs.data_root }), /must not be a symlink/);
  const parent = await mkdtemp(join(tmpdir(), 'astrid-browser-race-'));
  const child = profileChildPath(parent, { candidateApp: value.request.inputs.candidate.app, scenario: value.request.scenario, installRoot: value.request.inputs.root, dataRoot: value.request.inputs.data_root });
  const childTarget = await mkdtemp(join(tmpdir(), 'astrid-browser-child-target-'));
  await symlink(childTarget, child);
  await assert.rejects(ensureProfile(parent, value.request.inputs.candidate.app, value.request.scenario, { action: value.action, value: value.handoff_id }, { installRoot: value.request.inputs.root, dataRoot: value.request.inputs.data_root }), /child must not be a symlink/);
  await rm(link, { force: true });
  await rm(target, { recursive: true, force: true });
  await rm(parent, { recursive: true, force: true });
  await rm(childTarget, { recursive: true, force: true });
});

test('profile ownership rejects an existing child with a marker mismatch', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'astrid-browser-marker-mismatch-'));
  const value = envelope('cleanup');
  const child = profileChildPath(profile, { candidateApp: value.request.inputs.candidate.app, scenario: value.request.scenario, installRoot: value.request.inputs.root, dataRoot: value.request.inputs.data_root });
  await mkdir(child, { recursive: false }).catch(() => {});
  await writeFile(join(child, OWNER_MARKER), JSON.stringify({ protocol: PROTOCOL, owner: 'astrid-app-installed-browser', owner_token: 'wrong', candidate_app: commit('f'), scenario_id: value.request.scenario.scenario_id, profile_parent: profile, session_key: sha('f'), operation_id: null, handoffs: {} }));
  await assert.rejects(ensureProfile(profile, value.request.inputs.candidate.app, value.request.scenario, { action: 'button-update-lost-ack', value: value.handoff_id }, { installRoot: value.request.inputs.root, dataRoot: value.request.inputs.data_root }), /owner marker/);
  await rm(profile, { recursive: true, force: true });
});

test('cleanup removes only the exclusively owned child and preserves its parent', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'astrid-browser-owned-'));
  const value = envelope('button-update-lost-ack');
  const owned = await ensureProfile(profile, value.request.inputs.candidate.app, value.request.scenario, { action: value.action, value: value.handoff_id }, { installRoot: value.request.inputs.root, dataRoot: value.request.inputs.data_root });
  await writeFile(join(owned.root, 'browser-state'), 'owned');
  const cleanup = envelope('cleanup');
  const response = await cleanupOwnedProfile(cleanup, profile);
  assert.deepEqual(response.observation, { cleanup: 'pass' });
  assert.equal((await stat(profile)).isDirectory(), true);
  await assert.rejects(stat(owned.root));
  await rm(profile, { recursive: true, force: true });
});

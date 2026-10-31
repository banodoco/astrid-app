import assert from 'node:assert/strict';
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
  profileChildPath,
  validateInstalledIdentityObservation,
  validateInstalledProcessObservation,
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

test('authenticates origin from the observed running process, build, and manifest', () => {
  const candidateApp = commit('1');
  const observed = { build: { app: candidateApp, release: 1 }, manifest: { release: 1, agent: { sha: commit('2') }, runtime: { sha: commit('3') } } };
  assert.deepEqual(validateInstalledIdentityObservation({ observed, candidateApp, visibleRelease: 1, visibleBuild: candidateApp }), { app: candidateApp, release: 1, visible_release: 1, visible_build: candidateApp });
  assert.throws(() => validateInstalledIdentityObservation({ observed: { ...observed, build: { app: commit('f'), release: 1 } }, candidateApp, visibleRelease: 1, visibleBuild: candidateApp }), /differs from requested candidate/);
  assert.throws(() => validateInstalledIdentityObservation({ observed: { ...observed, build: { release: 1 } }, candidateApp, visibleRelease: 1, visibleBuild: candidateApp }), /authenticated App build identity/);
  assert.throws(() => validateInstalledProcessObservation({ command: 'node node_modules/.bin/vite --host', cwd: '/source/astrid-app' }), /source\/dev server/);
  assert.doesNotThrow(() => validateInstalledProcessObservation({ command: '/Applications/Astrid.app/Contents/MacOS/Astrid', cwd: '/Applications/Astrid.app' }));
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

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  OWNER_MARKER,
  PROTOCOL,
  SurfaceError,
  browserUnavailableMessage,
  cleanupOwnedProfile,
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
});

test('binds explicit Update to a real operation-shaped identity', () => {
  assert.equal(validateEnvelope(envelope('button-update-explicit')).request.payload.operation_id.length, 32);
  const bad = envelope('button-update-explicit', { request: 'explicit-update', operation_id: 'not-an-operation' });
  assert.throws(() => validateEnvelope(bad), /operation ID is invalid/);
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

test('cleanup removes only a profile carrying the exact App-owned marker identity', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'astrid-browser-owned-'));
  const value = envelope('cleanup');
  const candidate = value.request.inputs.candidate.app;
  await writeFile(join(profile, OWNER_MARKER), JSON.stringify({ protocol: PROTOCOL, owner: 'astrid-app-installed-browser', owner_token: 'owned-test', candidate_app: candidate, scenario_id: value.request.scenario.scenario_id, operation_id: 'a'.repeat(32), handoffs: {} }));
  const response = await cleanupOwnedProfile(value, profile);
  assert.deepEqual(response.observation, { cleanup: 'pass' });
  await assert.rejects(stat(profile));
});

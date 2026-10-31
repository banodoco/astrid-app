#!/usr/bin/env node

/**
 * Real installed-App browser surface for astrid-installed-browser-interface/v1.
 *
 * This command is intentionally the browser surface only.  The Agent adapter
 * owns sequencing and the installed/update surfaces own native service and job
 * observations.  This process owns one Playwright browser/profile, observes the
 * installed page's own network responses and visible Update controls, and never
 * injects a route, response, screenshot, or fixture into the page.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';

export const PROTOCOL = 'astrid-installed-browser-interface/v1';
export const SURFACE = 'browser';
export const OWNER_MARKER = '.astrid-installed-browser-owner.json';
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const OPERATION = /^[0-9a-f]{32}$/;
const DEFAULT_TIMEOUT_MS = 110_000;
const POLL_MS = 250;

export class SurfaceError extends Error {}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SurfaceError(`${label} must be an object`);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new SurfaceError(`${label} must be a non-empty string`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new SurfaceError(`${label} fields are not exact`);
}

function digest(value, label) {
  const result = text(value, label);
  if (!SHA256.test(result)) throw new SurfaceError(`${label} must be a lowercase SHA-256 digest`);
  return result;
}

function commit(value, label) {
  const result = text(value, label);
  if (!COMMIT.test(result)) throw new SurfaceError(`${label} must be a lowercase full commit SHA`);
  return result;
}

function absoluteDirectory(value, label) {
  const result = text(value, label);
  if (!isAbsolute(result)) throw new SurfaceError(`${label} must be an absolute path`);
  return result;
}

function scenarioOf(request) {
  const scenario = object(request.scenario, 'request scenario');
  exactKeys(scenario, ['scenario_id', 'channel', 'mode', 'os', 'job_id'], 'request scenario');
  if (!['macos', 'linux', 'windows'].includes(scenario.os)) throw new SurfaceError('request scenario OS is not admitted');
  if (scenario.channel !== 'button' || scenario.mode !== 'direct') throw new SurfaceError('browser surface only owns direct button scenarios');
  if (scenario.scenario_id !== `release2-button-direct-${scenario.os}`) throw new SurfaceError('request scenario identity is not admitted');
  if (scenario.job_id !== `direct-${scenario.os}`) throw new SurfaceError('request job identity is not admitted');
  return scenario;
}

function validateRequest(request, action) {
  exactKeys(request, ['protocol', 'sequence', 'action', 'scenario', 'inputs', 'payload'], 'request');
  if (request.protocol !== 'astrid-release2-boundary/v1') throw new SurfaceError('request boundary protocol differs');
  if (!Number.isInteger(request.sequence) || request.sequence < 1) throw new SurfaceError('request sequence is invalid');
  if (request.action !== action) throw new SurfaceError('request and interface action differ');
  const scenario = scenarioOf(request);
  const inputs = object(request.inputs, 'request inputs');
  exactKeys(inputs, ['candidate', 'stand_in', 'stand_in_marker', 'root', 'data_root'], 'request inputs');
  const candidate = object(inputs.candidate, 'candidate');
  exactKeys(candidate, ['app', 'agent', 'runtime', 'pinokio'], 'candidate');
  for (const [name, value] of Object.entries(candidate)) commit(value, `candidate ${name}`);
  const standIn = object(inputs.stand_in, 'stand-in');
  exactKeys(standIn, ['fixture_sums_sha256', 'descriptor_sha256', 'manifest_sha256', 'release', 'qualification_marker', 'target'], 'stand-in');
  for (const name of ['fixture_sums_sha256', 'descriptor_sha256', 'manifest_sha256']) digest(standIn[name], `stand-in ${name}`);
  if (standIn.release !== 2 || standIn.qualification_marker !== text(inputs.stand_in_marker, 'stand-in marker')) throw new SurfaceError('stand-in identity differs');
  const target = object(standIn.target, 'stand-in target');
  exactKeys(target, ['agent', 'runtime', 'schema_digest'], 'stand-in target');
  commit(target.agent, 'stand-in agent');
  commit(target.runtime, 'stand-in runtime');
  if (!/^sha256:[0-9a-f]{64}$/.test(text(target.schema_digest, 'stand-in schema digest'))) throw new SurfaceError('stand-in schema digest is invalid');
  absoluteDirectory(inputs.root, 'request install root');
  absoluteDirectory(inputs.data_root, 'request data root');
  if (inputs.root === inputs.data_root) throw new SurfaceError('install and data roots must be distinct');
  const payload = object(request.payload, 'request payload');
  const expected = {
    'button-unsaved-draft': ['surface', 'save', 'request'],
    'button-update-lost-ack': ['request', 'draft_flush', 'simulate_lost_ack'],
    'button-update-explicit': ['request', 'operation_id'],
    cleanup: ['owned_roots_only'],
  }[action];
  if (!expected) throw new SurfaceError(`browser surface does not own action ${action}`);
  exactKeys(payload, expected, `${action} payload`);
  if (action === 'button-unsaved-draft' && JSON.stringify(payload) !== JSON.stringify({ surface: 'browser', save: 'failed', request: 'explicit-update' })) throw new SurfaceError('unsaved-draft payload differs');
  if (action === 'button-update-lost-ack' && JSON.stringify(payload) !== JSON.stringify({ request: 'explicit-update', draft_flush: 'pass', simulate_lost_ack: true })) throw new SurfaceError('lost-ack payload differs');
  if (action === 'button-update-explicit') {
    if (payload.request !== 'explicit-update') throw new SurfaceError('explicit Update request differs');
    if (!OPERATION.test(text(payload.operation_id, 'explicit operation ID'))) throw new SurfaceError('explicit operation ID is invalid');
  }
  if (action === 'cleanup' && payload.owned_roots_only !== true) throw new SurfaceError('cleanup must be limited to owned roots');
  return { scenario, inputs, payload };
}

export function validateEnvelope(value) {
  const envelope = object(value, 'interface envelope');
  exactKeys(envelope, ['protocol', 'handoff_id', 'surface', 'action', 'request'], 'interface envelope');
  if (envelope.protocol !== PROTOCOL || envelope.surface !== SURFACE) throw new SurfaceError('interface protocol or surface differs');
  if (!SHA256.test(text(envelope.handoff_id, 'handoff ID'))) throw new SurfaceError('handoff ID is invalid');
  const action = text(envelope.action, 'interface action');
  if (!['button-unsaved-draft', 'button-update-lost-ack', 'button-update-explicit', 'cleanup'].includes(action)) throw new SurfaceError(`browser surface does not own action ${action}`);
  const checked = validateRequest(object(envelope.request, 'request'), action);
  return { envelope, action, request: envelope.request, ...checked };
}

function hostOs() {
  return process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : process.platform === 'win32' ? 'windows' : null;
}

function parseUrl(value) {
  const url = new URL(text(value, 'installed URL'));
  if (!['http:', 'https:'].includes(url.protocol)) throw new SurfaceError('installed URL must use HTTP or HTTPS');
  return url;
}

export function updatesUrl(value) {
  const url = parseUrl(value);
  url.searchParams.set('settings', 'updates');
  return url.toString();
}

export function browserUnavailableMessage(path) {
  return `AUTHENTIC_HOST_LIMITATION: existing Playwright browser executable is unavailable at ${path}; the installed browser command is implemented but cannot collect authentic installed-UI evidence on this host. This command does not download or install a browser.`;
}

function configuredBrowserPath(value) {
  const path = value || chromium.executablePath();
  if (!path || !existsSync(path)) throw new SurfaceError(browserUnavailableMessage(path || '(no Playwright executable path)'));
  return path;
}

async function directoryIsSafe(path, label) {
  const value = absoluteDirectory(path, label);
  if (value === '/' || value === process.cwd()) throw new SurfaceError(`${label} is too broad`);
  if (existsSync(value)) {
    if ((await lstat(value)).isSymbolicLink()) throw new SurfaceError(`${label} must not be a symlink`);
    const info = await stat(value);
    if (!info.isDirectory()) throw new SurfaceError(`${label} must be a directory`);
  }
  return value;
}

function markerFor({ candidateApp, scenario, operationId = null, handoffs = {} }) {
  return { protocol: PROTOCOL, owner: 'astrid-app-installed-browser', owner_token: randomUUID(), candidate_app: candidateApp, scenario_id: scenario.scenario_id, operation_id: operationId, handoffs };
}

async function readMarker(profileRoot) {
  const markerPath = join(profileRoot, OWNER_MARKER);
  try {
    if (existsSync(markerPath) && (await lstat(markerPath)).isSymbolicLink()) throw new SurfaceError('browser profile owner marker must not be a symlink');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    object(marker, 'browser owner marker');
    if (marker.protocol !== PROTOCOL || marker.owner !== 'astrid-app-installed-browser' || typeof marker.owner_token !== 'string') throw new SurfaceError('browser profile owner marker is invalid');
    return marker;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SurfaceError) throw error;
    throw new SurfaceError(`browser profile owner marker is unreadable: ${error.message}`);
  }
}

async function ensureProfile(profileRoot, candidateApp, scenario, handoffId) {
  const root = await directoryIsSafe(profileRoot, 'browser profile root');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const existing = await readMarker(root);
  const marker = existing || markerFor({ candidateApp, scenario });
  if (marker.candidate_app !== candidateApp || marker.scenario_id !== scenario.scenario_id) throw new SurfaceError('browser profile is bound to a different candidate or scenario');
  const handoffs = { ...(marker.handoffs || {}) };
  const prior = handoffs[handoffId.action];
  if (prior && prior !== handoffId.value) throw new SurfaceError(`${handoffId.action} is bound to a different handoff`);
  handoffs[handoffId.action] = handoffId.value;
  await writeFile(join(root, OWNER_MARKER), JSON.stringify({ ...marker, handoffs }, null, 2) + '\n', { mode: 0o600 });
  return { root, marker: { ...marker, handoffs } };
}

async function ensureCleanupOwnership(profileRoot, candidateApp, scenario) {
  const root = await directoryIsSafe(profileRoot, 'browser profile root');
  const marker = await readMarker(root);
  if (!marker) throw new SurfaceError('refusing cleanup of a profile without this command owner marker');
  if (marker.candidate_app !== candidateApp || marker.scenario_id !== scenario.scenario_id) throw new SurfaceError('browser cleanup identity differs from the owned profile');
  return root;
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function pathName(value) {
  try { return new URL(value).pathname; } catch { return ''; }
}

function observePage(page) {
  const state = {
    build: null,
    manifest: null,
    updateRequests: [],
    updateResponses: [],
    statusResponses: [],
    draftSaveResponses: [],
    pagesOpened: 1,
  };
  const jsonResponse = async (response) => {
    try { return await response.json(); } catch { return null; }
  };
  page.on('request', (request) => {
    const pathname = pathName(request.url());
    if (request.method() === 'POST' && /\/v1\/update$/.test(pathname)) state.updateRequests.push({ url: request.url(), observed: Date.now() });
  });
  page.on('response', (response) => {
    void (async () => {
      const pathname = pathName(response.url());
      const body = await jsonResponse(response);
      if (pathname === '/build.json' && response.ok() && body && typeof body === 'object') state.build = body;
      if (pathname === '/install-manifest.json' && response.ok() && body && typeof body === 'object') state.manifest = body;
      if (/\/v1\/update$/.test(pathname)) state.updateResponses.push({ status: response.status(), body });
      if (/\/v1\/update\/status$/.test(pathname) && body && typeof body === 'object') state.statusResponses.push(body);
      if (requestLooksLikeDraftSave(response.request()) || response.request().method() === 'POST' && /\/v1\/app-state\//.test(pathname)) state.draftSaveResponses.push({ status: response.status(), body });
    })().catch(() => undefined);
  });
  return state;
}

function requestLooksLikeDraftSave(request) {
  const pathname = pathName(request.url());
  return ['POST', 'PUT', 'PATCH'].includes(request.method()) && /(?:draft|document|timeline|app-state)/i.test(pathname);
}

async function waitFor(predicate, timeout, label) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new SurfaceError(`timed out waiting for ${label}`);
}

async function launchOwnedBrowser(profileRoot, browserPath, timeout) {
  try {
    const context = await chromium.launchPersistentContext(profileRoot, { executablePath: browserPath, headless: true, timeout, args: ['--no-first-run', '--no-default-browser-check'] });
    const browser = context.browser();
    const browserPid = typeof browser?.process === 'function' ? browser.process()?.pid ?? null : null;
    return { context, browser, lifecycle: { started: true, browser_pid: browserPid, profile_root: profileRoot, closed_by_command: false } };
  } catch (error) {
    throw new SurfaceError(`owned browser could not start at ${browserPath}: ${error.message}`);
  }
}

async function closeOwnedBrowser(owned) {
  if (!owned) return;
  try { await owned.context.close(); } finally { owned.lifecycle.closed_by_command = true; }
}

async function openUpdatesPage(owned, installedUrl, timeout) {
  const page = await owned.context.newPage();
  owned.lifecycle.pages_opened = (owned.lifecycle.pages_opened || 0) + 1;
  const observed = observePage(page);
  await page.goto(updatesUrl(installedUrl), { waitUntil: 'domcontentloaded', timeout });
  await page.getByRole('region', { name: 'Updates' }).waitFor({ state: 'visible', timeout });
  await waitFor(() => observed.build && observed.manifest, timeout, 'installed build and manifest responses');
  return { page, observed };
}

async function installedIdentity(page, observed) {
  const region = page.getByRole('region', { name: 'Updates' });
  const releaseRow = region.locator('dt').filter({ hasText: 'Release' }).locator('..');
  const releaseText = (await releaseRow.locator('dd').textContent())?.trim() || '';
  const buildRow = region.locator('dt').filter({ hasText: 'App build' }).locator('..');
  const buildNode = buildRow.locator('dd');
  const build = (await buildNode.getAttribute('title')) || (await buildNode.textContent())?.trim() || '';
  const release = Number((releaseText.match(/\d+/) || [])[0] || observed.manifest?.release || 0);
  const app = typeof observed.build?.app === 'string' ? observed.build.app : build;
  const manifestRelease = Number(observed.manifest?.release || 0);
  if (!Number.isInteger(release) || release !== manifestRelease || manifestRelease < 1) throw new SurfaceError(`installed UI exposed inconsistent release identity (${releaseText || 'missing'} / manifest ${manifestRelease})`);
  if (!app) throw new SurfaceError('installed UI did not expose an App build identity');
  return { app, release: manifestRelease, visible_release: release, visible_build: build };
}

async function updateButton(page, name, timeout) {
  const button = page.getByRole('button', { name, exact: true });
  await button.waitFor({ state: 'visible', timeout });
  return button;
}

function statusStates(observed) {
  const states = [];
  for (const response of observed.statusResponses) {
    if (!['active', 'recovery-needed', 'terminal'].includes(response.state)) continue;
    if (states.at(-1) !== response.state) states.push(response.state);
  }
  return states;
}

function matchingOperationId(observed) {
  const values = [];
  for (const response of [...observed.updateResponses, ...observed.statusResponses]) {
    if (response.body && typeof response.body.operation_id === 'string') values.push(response.body.operation_id);
  }
  const unique = [...new Set(values)];
  if (unique.length > 1) throw new SurfaceError(`browser observed ambiguous operation identities: ${unique.join(', ')}`);
  return unique[0] || null;
}

async function runUnsavedDraft({ page, observed, timeout, identity }) {
  if (identity.release !== 1) throw new SurfaceError(`unsaved-draft control requires installed Release 1, observed ${identity.release}`);
  const beforeRequests = observed.updateRequests.length;
  const button = await updateButton(page, 'Update now', timeout);
  await button.click();
  await waitFor(() => observed.updateRequests.length > beforeRequests || observed.draftSaveResponses.length > 0 || page.getByRole('alert').count().then((count) => count > 0), timeout, 'the real draft flush result');
  const failedDraftSave = observed.draftSaveResponses.some((response) => response.status >= 400);
  const updateRequests = observed.updateRequests.length - beforeRequests;
  if (!failedDraftSave || updateRequests !== 0) throw new SurfaceError(`installed UI did not produce an authentic failed draft flush before Update (failed_save=${failedDraftSave}, update_requests=${updateRequests})`);
  return { surface: 'browser', save: 'failed', update_requests: 0, native_jobs: 0, installed_release: identity.release };
}

async function runLostAck({ page, observed, context, timeout, identity, installedUrl, candidateApp }) {
  if (identity.release !== 1) throw new SurfaceError(`lost-ack control requires installed Release 1, observed ${identity.release}`);
  const beforeRequests = observed.updateRequests.length;
  const button = await updateButton(page, 'Update now', timeout);
  await button.click();
  await waitFor(() => observed.updateRequests.length > beforeRequests, timeout, 'the real explicit Update request');
  if (beforeRequests !== 0) throw new SurfaceError(`browser observed ${beforeRequests} automatic update requests before the explicit click`);
  // The handoff is deliberately not accepted from the POST response. Leave the
  // page, then observe the producer-owned recovery state from a fresh page in
  // the same owned profile. If the real product cannot reconcile the request,
  // this command fails rather than inventing a lost-ack receipt.
  await page.close();
  const reopened = await context.newPage();
  const reopenedObserved = observePage(reopened);
  const reopenedUrl = updatesUrl(installedUrl);
  await reopened.goto(reopenedUrl, { waitUntil: 'domcontentloaded', timeout });
  await reopened.getByRole('region', { name: 'Updates' }).waitFor({ state: 'visible', timeout });
  const reopenedIdentity = await installedIdentity(reopened, reopenedObserved);
  if (reopenedIdentity.release !== 1 || reopenedIdentity.app !== candidateApp) throw new SurfaceError('lost-ack recovery reopened a different installed candidate');
  await waitFor(() => statusStates(reopenedObserved).includes('recovery-needed'), timeout, 'producer-owned recovery-needed state');
  const states = [...statusStates(observed), ...statusStates(reopenedObserved)].filter((state, index, all) => index === 0 || state !== all[index - 1]);
  if (JSON.stringify(states.slice(-2)) !== JSON.stringify(['active', 'recovery-needed'])) throw new SurfaceError(`browser observed unexpected lost-ack lifecycle: ${JSON.stringify(states)}`);
  const operationId = matchingOperationId({
    updateResponses: [...observed.updateResponses, ...reopenedObserved.updateResponses],
    statusResponses: [...observed.statusResponses, ...reopenedObserved.statusResponses],
  });
  if (!operationId || !OPERATION.test(operationId)) throw new SurfaceError('browser did not observe a valid lost-ack operation ID');
  return { observation: { states: ['active', 'recovery-needed'], automatic_update_requests: 0, terminal_inferred: false, operation_id: operationId }, operationId };
}

async function runExplicit({ page, observed, timeout, identity, operationId, scenario }) {
  if (identity.release !== 1) throw new SurfaceError(`explicit recovery control requires installed Release 1 before Update, observed ${identity.release}`);
  const priorStates = statusStates(observed);
  if (!priorStates.includes('recovery-needed')) throw new SurfaceError('explicit Update was not preceded by an observed recovery-needed state');
  const beforeRequests = observed.updateRequests.length;
  const beforeDraftSaves = observed.draftSaveResponses.length;
  const button = await updateButton(page, 'Update', timeout);
  await button.click();
  await waitFor(() => statusStates(observed).includes('terminal'), timeout, 'terminal explicit Update state');
  const states = statusStates(observed);
  if (JSON.stringify(states.slice(-3)) !== JSON.stringify(['recovery-needed', 'active', 'terminal'])) throw new SurfaceError(`browser observed unexpected explicit Update lifecycle: ${JSON.stringify(states)}`);
  const observedOperation = matchingOperationId(observed);
  if (observedOperation !== operationId) throw new SurfaceError('explicit Update operation identity differs from the lost-ack operation');
  const updateRequests = observed.updateRequests.length - beforeRequests;
  if (updateRequests !== 1) throw new SurfaceError(`explicit Update produced ${updateRequests} observed POST requests; expected exactly one`);
  let finalIdentity = identity;
  if (scenario.os === 'linux') {
    await waitFor(() => observed.build?.app && observed.manifest?.release === 2, timeout, 'installed Release 2 identity after saved-draft Update');
    finalIdentity = await installedIdentity(page, observed);
    if (finalIdentity.release !== 2) throw new SurfaceError(`saved-draft Update did not expose installed Release 2 (observed ${finalIdentity.release})`);
  }
  const savePassed = observed.draftSaveResponses.slice(beforeDraftSaves).some((response) => response.status >= 200 && response.status < 300);
  const nativeJobs = statusStates(observed).filter((state) => state === 'active').length;
  const observation = { states: ['recovery-needed', 'active', 'terminal'], action: 'explicit-update', operation_id: operationId };
  if (scenario.os === 'linux') observation.draft_control = { surface: 'browser', save: savePassed ? 'pass' : 'failed', update_requests: updateRequests, native_jobs: nativeJobs, installed_release: finalIdentity.release };
  if (scenario.os === 'linux' && (!savePassed || nativeJobs !== 1)) throw new SurfaceError(`saved-draft control lacked actual save/job observations (save=${savePassed}, native_jobs=${nativeJobs})`);
  return observation;
}

async function runAction({ envelope, action, request, inputs, scenario, profileRoot, installedUrl, browserPath, timeout }) {
  if (hostOs() !== scenario.os) throw new SurfaceError(`request scenario OS ${scenario.os} does not match host ${hostOs() || process.platform}`);
  const candidateApp = inputs.candidate.app;
  const profile = await ensureProfile(profileRoot, candidateApp, scenario, { action, value: envelope.handoff_id });
  const browser = await launchOwnedBrowser(profile.root, browserPath, timeout);
  try {
    const { page, observed } = await openUpdatesPage(browser, installedUrl, timeout);
    const identity = await installedIdentity(page, observed);
    browser.lifecycle.installed_identity = { app: identity.app, release: identity.release };
    if (action !== 'button-update-explicit' && identity.app !== candidateApp) throw new SurfaceError(`installed App build ${identity.app} differs from requested candidate ${candidateApp}`);
    if (action === 'button-unsaved-draft') return { observation: await runUnsavedDraft({ page, observed, timeout, identity }), marker: profile.marker, lifecycle: browser.lifecycle };
    if (action === 'button-update-lost-ack') {
      const lost = await runLostAck({ page, observed, context: browser.context, timeout, identity, installedUrl, candidateApp });
      const nextMarker = { ...profile.marker, operation_id: lost.operationId };
      await writeFile(join(profile.root, OWNER_MARKER), JSON.stringify(nextMarker, null, 2) + '\n', { mode: 0o600 });
      return { observation: lost.observation, marker: nextMarker, lifecycle: browser.lifecycle };
    }
    const marker = await readMarker(profile.root);
    if (!marker?.operation_id) throw new SurfaceError('explicit Update is not bound to the previously observed operation');
    const operationId = request.payload.operation_id;
    if (marker.operation_id !== operationId) throw new SurfaceError('explicit Update operation ID differs from owned profile state');
    return { observation: await runExplicit({ page, observed, timeout, identity, operationId, scenario }), marker, lifecycle: browser.lifecycle };
  } finally {
    await closeOwnedBrowser(browser);
  }
}

function responseEnvelope(envelope, action, observation, lifecycle) {
  return { protocol: PROTOCOL, handoff_id: envelope.handoff_id, surface: SURFACE, action, status: 'pass', evidence: { kind: 'browser-process', pid: process.pid, synthetic: false, source_only: false, browser_lifecycle: lifecycle, observation_sha256: sha256(observation) }, observation };
}

export async function cleanupOwnedProfile(envelope, profileRoot) {
  const { inputs, scenario } = validateEnvelope(envelope);
  const root = await ensureCleanupOwnership(profileRoot, inputs.candidate.app, scenario);
  await rm(root, { recursive: true, force: false });
  return responseEnvelope(envelope, 'cleanup', { cleanup: 'pass' }, { started: false, browser_pid: null, profile_root: root, closed_by_command: true });
}

export async function runEnvelope(envelope, options) {
  const checked = validateEnvelope(envelope);
  if (checked.action === 'cleanup') return cleanupOwnedProfile(envelope, options.profileRoot);
  const browserPath = configuredBrowserPath(options.browserPath);
  const result = await runAction({ ...checked, ...options, browserPath, timeout: options.timeout });
  return responseEnvelope(envelope, checked.action, result.observation, result.lifecycle);
}

function args(argv) {
  const result = { timeout: DEFAULT_TIMEOUT_MS, browserPath: process.env.ASTRID_BROWSER_PATH || '', installedUrl: process.env.ASTRID_INSTALLED_APP_URL || '', profileRoot: process.env.ASTRID_BROWSER_PROFILE || '' };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    const next = () => { if (!argv[index + 1]) throw new SurfaceError(`${value} requires a value`); return argv[++index]; };
    if (value === '--help') return { help: true };
    if (value === '--installed-url' || value === '--app-url') result.installedUrl = next();
    else if (value === '--profile-root' || value === '--profile') result.profileRoot = next();
    else if (value === '--browser-path' || value === '--browser') result.browserPath = next();
    else if (value === '--timeout-ms') result.timeout = Number(next());
    else if (value === '--app-checkout') next(); // accepted for registration compatibility; installed identity is page-observed.
    else throw new SurfaceError(`unknown option ${value}`);
  }
  if (!Number.isFinite(result.timeout) || result.timeout <= 0) throw new SurfaceError('timeout-ms must be positive and finite');
  result.installedUrl = text(result.installedUrl, 'installed URL');
  result.profileRoot = text(result.profileRoot, 'browser profile root');
  return result;
}

export function help() {
  return 'Usage: installed_browser_automation_surface.mjs --installed-url URL --profile-root DIR [--browser-path EXISTING_BROWSER] [--timeout-ms N]';
}

export async function main(argv = process.argv.slice(2), input = process.stdin) {
  try {
    const options = args(argv);
    if (options.help) { console.log(help()); return 0; }
    const envelope = await new Promise((resolve, reject) => { let data = ''; input.setEncoding('utf8'); input.on('data', (chunk) => { data += chunk; }); input.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(new SurfaceError(`stdin must contain one JSON envelope: ${error.message}`)); } }); input.on('error', reject); });
    console.log(JSON.stringify(await runEnvelope(envelope, options)));
    return 0;
  } catch (error) {
    console.error(`installed_browser_automation_surface: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();

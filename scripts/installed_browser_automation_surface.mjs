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
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import process from 'node:process';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

export const PROTOCOL = 'astrid-installed-browser-interface/v1';
export const SURFACE = 'browser';
export const OWNER_MARKER = '.astrid-installed-browser-owner.json';
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const OPERATION = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_PREFIX = '.astrid-installed-browser-';
const DEFAULT_TIMEOUT_MS = 110_000;
const POLL_MS = 250;
const execFile = promisify(execFileCallback);

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
  if (!isAbsolute(result) && !/^[A-Za-z]:[\\/]/.test(result) && !/^\\\\[^\\/]+[\\/][^\\/]+/.test(result)) throw new SurfaceError(`${label} must be an absolute path`);
  return result;
}

function validateAdapterState(value) {
  const state = object(value, 'adapter state');
  exactKeys(state, ['phase', 'operation_id', 'next_sequence'], 'adapter state');
  if (!['uninspected', 'release1', 'recovery-needed', 'release2', 'terminal'].includes(state.phase)) {
    throw new SurfaceError('adapter state phase is not admitted');
  }
  if (state.operation_id !== null && !OPERATION.test(text(state.operation_id, 'adapter state operation ID'))) {
    throw new SurfaceError('adapter state operation ID is invalid');
  }
  if (!Number.isInteger(state.next_sequence) || state.next_sequence < 1) {
    throw new SurfaceError('adapter state next sequence is invalid');
  }
  return state;
}

function validatePriorObservations(value) {
  const observations = object(value, 'prior observations');
  // The browser surface is first in every route it owns.  An empty map is the
  // exact Q/Agent value; rejecting non-empty history prevents serialized state
  // from becoming an unowned authentication or hosted-result channel.
  exactKeys(observations, [], 'prior observations');
  return observations;
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
  exactKeys(envelope, ['protocol', 'handoff_id', 'surface', 'action', 'request', 'adapter_state', 'prior_observations'], 'interface envelope');
  if (envelope.protocol !== PROTOCOL || envelope.surface !== SURFACE) throw new SurfaceError('interface protocol or surface differs');
  if (!SHA256.test(text(envelope.handoff_id, 'handoff ID'))) throw new SurfaceError('handoff ID is invalid');
  validateAdapterState(envelope.adapter_state);
  validatePriorObservations(envelope.prior_observations);
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

function loopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function platformAbsolutePath(value, platform) {
  if (platform === 'windows') return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
  return isAbsolute(value);
}

function pathWithinRoot(path, root, platform) {
  const separator = platform === 'windows' ? '\\' : '/';
  const fold = (value) => normalize(value).replace(/[\\/]+/g, separator).replace(/[\\/]$/, '').toLowerCase();
  const child = fold(path);
  const parent = fold(root);
  return child === parent || child.startsWith(`${parent}${separator}`);
}

export function validateInstalledProcessObservation({ command, cwd = null, executable, installRoot, platform = hostOs() }) {
  text(command, 'installed process command');
  text(executable, 'installed process executable');
  absoluteDirectory(installRoot, 'installed process install root');
  if (!['macos', 'linux', 'windows'].includes(platform)) throw new SurfaceError('installed process observation platform is not admitted');
  if (!platformAbsolutePath(executable, platform)) throw new SurfaceError('installed process executable must be an absolute path');
  if (!pathWithinRoot(executable, installRoot, platform)) throw new SurfaceError('installed process executable is outside the requested install root');
  if (platform === 'windows') {
    if (cwd !== null && cwd !== undefined) throw new SurfaceError('Windows process observation must not claim current-directory evidence');
  } else {
    text(cwd, 'installed process working directory');
    if (!platformAbsolutePath(cwd, platform)) throw new SurfaceError('installed process working directory must be absolute');
  }
  const value = `${command}\n${cwd || ''}\n${executable}`.toLowerCase();
  if (/(?:vite|webpack|parcel|next dev|npm run dev|pnpm dev|bun run dev|dev-local-workspace|node_modules[\\/]\.bin[\\/]vite)/.test(value)) {
    throw new SurfaceError('installed App origin is a source/dev server, not an installed product process');
  }
}

export function parseLsofListenerPids(output) {
  text(output, 'lsof listener output');
  return [...new Set(output.split(/\r?\n/).filter((line) => /^p\d+$/.test(line)).map((line) => line.slice(1)))];
}

export function uniqueLsofListenerPid(output) {
  const pids = parseLsofListenerPids(output);
  if (pids.length !== 1) throw new SurfaceError(`installed App process observation is ${pids.length === 0 ? 'missing' : 'ambiguous'}`);
  return Number(pids[0]);
}

function parseLsofSingleName(output, label) {
  const names = output.split(/\r?\n/).filter((line) => line.startsWith('n')).map((line) => line.slice(1)).filter(Boolean);
  if (names.length !== 1) throw new SurfaceError(`${label} evidence is ${names.length === 0 ? 'missing' : 'ambiguous'}`);
  return names[0];
}

function commandResult(result, label) {
  if (result.stderr?.trim()) throw new SurfaceError(`${label} wrote unexpected stderr`);
  if (!result.stdout?.trim()) throw new SurfaceError(`${label} returned empty output`);
  return result.stdout;
}

function validatePort(url) {
  const port = Number(url.port || (url.protocol === 'https:' ? '443' : '80'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SurfaceError('installed URL port is invalid');
  return port;
}

export function parseWindowsNativeObservation(output, { port, installRoot }) {
  let value;
  try { value = JSON.parse(text(output, 'Windows listener/process output')); } catch (error) { throw new SurfaceError(`Windows listener/process output is invalid JSON: ${error.message}`); }
  object(value, 'Windows listener/process output');
  exactKeys(value, ['listener', 'process'], 'Windows listener/process output');
  if (!Array.isArray(value.listener) || value.listener.length === 0) throw new SurfaceError('Windows listener observation is missing');
  const listenerRows = value.listener.map((row) => {
    object(row, 'Windows listener row');
    exactKeys(row, ['LocalAddress', 'LocalPort', 'OwningProcess'], 'Windows listener row');
    if (typeof row.LocalAddress !== 'string' || !loopbackHost(row.LocalAddress) && !['0.0.0.0', '::'].includes(row.LocalAddress)) throw new SurfaceError('Windows listener address is not admitted');
    if (row.LocalPort !== port || !Number.isInteger(row.OwningProcess) || row.OwningProcess < 1) throw new SurfaceError('Windows listener row does not match the exact port/PID contract');
    return row;
  });
  const pids = [...new Set(listenerRows.map((row) => row.OwningProcess))];
  if (pids.length !== 1) throw new SurfaceError(`Windows listener observation is ambiguous for port ${port}`);
  object(value.process, 'Windows process row');
  exactKeys(value.process, ['ProcessId', 'ExecutablePath', 'CommandLine'], 'Windows process row');
  if (value.process.ProcessId !== pids[0] || typeof value.process.ExecutablePath !== 'string' || value.process.ExecutablePath.length === 0 || typeof value.process.CommandLine !== 'string' || value.process.CommandLine.length === 0) {
    throw new SurfaceError('Windows process observation does not match the exact listener PID');
  }
  validateInstalledProcessObservation({ command: value.process.CommandLine, cwd: null, executable: value.process.ExecutablePath, installRoot, platform: 'windows' });
  return { pid: pids[0], command: value.process.CommandLine, executable: value.process.ExecutablePath, cwd: null, cwd_evidence: 'unknown', native_evidence: 'unknown', port };
}

async function runningWindowsInstalledProcess(url, timeout, installRoot) {
  const port = validatePort(url);
  const script = `$ErrorActionPreference='Stop'; $rows=@(Get-NetTCPConnection -State Listen -LocalPort ${port} | Where-Object { $_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::') } | Select-Object LocalAddress,LocalPort,OwningProcess); if ($rows.Count -eq 0) { throw 'listener missing' }; $pids=@($rows | Select-Object -ExpandProperty OwningProcess -Unique); if ($pids.Count -ne 1) { throw 'listener PID ambiguous' }; $process=@(Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$pids[0]) | Select-Object ProcessId,ExecutablePath,CommandLine); if ($process.Count -ne 1) { throw 'process missing or ambiguous' }; [pscustomobject]@{ listener=$rows; process=$process[0] } | ConvertTo-Json -Compress -Depth 4`;
  let result;
  try {
    result = await execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout, maxBuffer: 128 * 1024, shell: false, windowsHide: true });
  } catch (error) {
    throw new SurfaceError(`Windows installed App process observation is unavailable: ${error.message}`);
  }
  return parseWindowsNativeObservation(commandResult(result, 'Windows listener/process observer'), { port, installRoot });
}

async function runningInstalledProcess(installedUrl, timeout, installRoot) {
  const url = parseUrl(installedUrl);
  if (!loopbackHost(url.hostname)) throw new SurfaceError('installed App origin must expose a local running installed process for boundary authentication');
  const port = validatePort(url);
  if (hostOs() === 'windows') {
    const observation = await runningWindowsInstalledProcess(url, timeout, installRoot);
    return { ...observation, origin: url.origin };
  }
  let listening;
  try {
    listening = await execFile('lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { timeout, shell: false, maxBuffer: 128 * 1024 });
  } catch (error) {
    throw new SurfaceError(`installed App process observation is unavailable: ${error.message}`);
  }
  let pid;
  try { pid = uniqueLsofListenerPid(commandResult(listening, 'lsof listener observer')); } catch (error) {
    if (error instanceof SurfaceError) throw new SurfaceError(`${error.message} for ${url.hostname}:${port}`);
    throw error;
  }
  try {
    const [processInfo, cwdInfo, executableInfo] = await Promise.all([
      execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout, shell: false, maxBuffer: 128 * 1024 }),
      execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout, shell: false, maxBuffer: 128 * 1024 }),
      execFile('lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { timeout, shell: false, maxBuffer: 128 * 1024 }),
    ]);
    const command = commandResult(processInfo, 'process command observer').trim();
    const cwd = parseLsofSingleName(commandResult(cwdInfo, 'process working-directory observer'), 'working-directory');
    const executable = parseLsofSingleName(commandResult(executableInfo, 'process executable observer'), 'executable');
    validateInstalledProcessObservation({ command, cwd, executable, installRoot, platform: hostOs() });
    return { pid, command, executable, cwd, cwd_evidence: 'observed', native_evidence: 'observed', port, origin: url.origin };
  } catch (error) {
    if (error instanceof SurfaceError) throw error;
    throw new SurfaceError(`installed App process observation is unavailable: ${error.message}`);
  }
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

function sessionKey({ candidateApp, scenario, profileRoot, installRoot, dataRoot }) {
  return createHash('sha256').update(JSON.stringify({ candidateApp, scenario_id: scenario.scenario_id, profileRoot, installRoot, dataRoot })).digest('hex');
}

export function profileChildPath(profileRoot, identity) {
  const key = sessionKey({ ...identity, profileRoot });
  return join(profileRoot, `${PROFILE_PREFIX}${key}`);
}

function markerFor({ candidateApp, scenario, profileRoot, installRoot, dataRoot, operationId = null, handoffs = {} }) {
  return {
    protocol: PROTOCOL,
    owner: 'astrid-app-installed-browser',
    owner_token: randomUUID(),
    candidate_app: candidateApp,
    scenario_id: scenario.scenario_id,
    profile_parent: profileRoot,
    session_key: sessionKey({ candidateApp, scenario, profileRoot, installRoot, dataRoot }),
    operation_id: operationId,
    handoffs,
  };
}

function validateMarker(marker, expected) {
  object(marker, 'browser owner marker');
  exactKeys(marker, ['protocol', 'owner', 'owner_token', 'candidate_app', 'scenario_id', 'profile_parent', 'session_key', 'operation_id', 'handoffs'], 'browser owner marker');
  if (marker.protocol !== PROTOCOL || marker.owner !== 'astrid-app-installed-browser' || !UUID.test(marker.owner_token)) throw new SurfaceError('browser profile owner marker is invalid');
  if (marker.candidate_app !== expected.candidateApp || marker.scenario_id !== expected.scenario.scenario_id) throw new SurfaceError('browser profile owner marker identity differs');
  if (marker.profile_parent !== expected.profileRoot || marker.session_key !== expected.sessionKey) throw new SurfaceError('browser profile owner marker session differs');
  if (marker.operation_id !== null && !OPERATION.test(marker.operation_id)) throw new SurfaceError('browser profile owner marker operation ID is invalid');
  object(marker.handoffs, 'browser owner marker handoffs');
  for (const [action, handoff] of Object.entries(marker.handoffs)) {
    if (!['button-unsaved-draft', 'button-update-lost-ack', 'button-update-explicit', 'cleanup'].includes(action) || !SHA256.test(handoff)) throw new SurfaceError('browser profile owner marker handoffs are invalid');
  }
  return marker;
}

async function readMarker(profileRoot, expected) {
  const markerPath = join(profileRoot, OWNER_MARKER);
  try {
    if (existsSync(markerPath) && (await lstat(markerPath)).isSymbolicLink()) throw new SurfaceError('browser profile owner marker must not be a symlink');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    return validateMarker(marker, expected);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SurfaceError) throw error;
    throw new SurfaceError(`browser profile owner marker is unreadable: ${error.message}`);
  }
}

async function writeMarker(profileRoot, marker, { exclusive = false } = {}) {
  const markerPath = join(profileRoot, OWNER_MARKER);
  if (!exclusive && existsSync(markerPath) && (await lstat(markerPath)).isSymbolicLink()) throw new SurfaceError('browser profile owner marker must not be a symlink');
  if (exclusive) {
    await writeFile(markerPath, JSON.stringify(marker, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return;
  }
  const temporary = join(profileRoot, `.${OWNER_MARKER}.${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify(marker, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, markerPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function ensureProfile(profileRoot, candidateApp, scenario, handoffId, context = {}) {
  const root = await directoryIsSafe(profileRoot, 'browser profile root');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const safeRoot = await directoryIsSafe(root, 'browser profile root');
  const identity = { candidateApp, scenario, profileRoot: safeRoot, installRoot: context.installRoot ?? '', dataRoot: context.dataRoot ?? '' };
  const child = profileChildPath(safeRoot, identity);
  let marker;
  try {
    await mkdir(child, { mode: 0o700 });
    marker = markerFor(identity);
    await writeMarker(child, marker, { exclusive: true });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw new SurfaceError(`could not exclusively create browser profile child: ${error.message}`);
    if ((await lstat(child)).isSymbolicLink()) throw new SurfaceError('browser profile child must not be a symlink');
    if (!(await stat(child)).isDirectory()) throw new SurfaceError('browser profile child must be a directory');
    marker = await readMarker(child, { ...identity, sessionKey: sessionKey(identity) });
  }
  validateMarker(marker, { ...identity, sessionKey: sessionKey(identity) });
  const handoffs = { ...(marker.handoffs || {}) };
  const prior = handoffs[handoffId.action];
  if (prior && prior !== handoffId.value) throw new SurfaceError(`${handoffId.action} is bound to a different handoff`);
  handoffs[handoffId.action] = handoffId.value;
  marker = { ...marker, handoffs };
  await writeMarker(child, marker);
  return { root: child, marker };
}

async function ensureCleanupOwnership(profileRoot, candidateApp, scenario, context = {}) {
  const root = await directoryIsSafe(profileRoot, 'browser profile root');
  const identity = { candidateApp, scenario, profileRoot: root, installRoot: context.installRoot ?? '', dataRoot: context.dataRoot ?? '' };
  const child = profileChildPath(root, identity);
  if (!(await lstat(child).catch((error) => { if (error?.code === 'ENOENT') return null; throw error; }))) throw new SurfaceError('refusing cleanup of a profile without this command owner marker');
  if ((await lstat(child)).isSymbolicLink()) throw new SurfaceError('browser profile child must not be a symlink');
  if (!(await stat(child)).isDirectory()) throw new SurfaceError('browser profile child must be a directory');
  const marker = await readMarker(child, { ...identity, sessionKey: sessionKey(identity) });
  validateMarker(marker, { ...identity, sessionKey: sessionKey(identity) });
  return child;
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function pathName(value) {
  try { return new URL(value).pathname; } catch { return ''; }
}

const NATIVE_HANDOFF_PROTOCOL = 'astrid-update-platform/v1';

function boundaryRecord(pageId, handoffId, kind, actionId = null, operationId = null) {
  return {
    boundary_id: randomUUID(),
    page_id: pageId,
    handoff_id: handoffId,
    action_id: actionId,
    expected_operation_id: operationId,
    operation_id: null,
    trigger: kind === 'click' ? 'user' : 'automatic',
    boundary: kind,
  };
}

function requestOperationId(request) {
  try {
    const value = request.postDataJSON?.();
    return value && typeof value === 'object' && typeof value.operation_id === 'string' ? value.operation_id : null;
  } catch {
    return null;
  }
}

function observePage(page, { handoffId }) {
  const pageId = randomUUID();
  const currentHandoff = text(handoffId, 'browser observation handoff ID');
  let activeBoundary = null;
  const requestRecords = new WeakMap();
  const state = {
    pageId,
    handoffId: currentHandoff,
    build: null,
    manifest: null,
    installedHandoff: null,
    updateRequests: [],
    updateResponses: [],
    statusResponses: [],
    draftSaveResponses: [],
    nativeJobObservations: [],
    pagesOpened: 1,
    beginNavigation(operationId = null, actionId = null) {
      activeBoundary = boundaryRecord(pageId, currentHandoff, 'navigation', actionId, operationId);
      return { ...activeBoundary };
    },
    beginAction(actionId, { operationId = null } = {}) {
      activeBoundary = boundaryRecord(pageId, currentHandoff, 'click', text(actionId, 'browser action correlation ID'), operationId);
      return { ...activeBoundary };
    },
  };
  const jsonResponse = async (response) => {
    try { return await response.json(); } catch { return null; }
  };
  page.on('request', (request) => {
    const boundary = activeBoundary ? { ...activeBoundary } : boundaryRecord(pageId, currentHandoff, 'unattributed');
    const record = { ...boundary, request_id: randomUUID(), operation_id: requestOperationId(request), method: request.method(), pathname: pathName(request.url()), url: request.url(), observed: Date.now() };
    requestRecords.set(request, record);
    if (record.method === 'POST' && /\/v1\/update$/.test(record.pathname)) state.updateRequests.push(record);
  });
  page.on('response', (response) => {
    void (async () => {
      const pathname = pathName(response.url());
      const body = await jsonResponse(response);
      const request = response.request();
      const record = requestRecords.get(request) || { ...boundaryRecord(pageId, currentHandoff, 'unattributed'), request_id: null, method: request.method(), pathname };
      if (body && typeof body === 'object' && typeof body.operation_id === 'string') record.operation_id = body.operation_id;
      if (pathname === '/build.json' && response.ok() && body && typeof body === 'object') state.build = body;
      if (pathname === '/install-manifest.json' && response.ok() && body && typeof body === 'object') {
        state.manifest = body;
        if (body.installed_surface_handoff && typeof body.installed_surface_handoff === 'object') state.installedHandoff = body.installed_surface_handoff;
      }
      if (pathname === '/v1/installed-surface/handoff' && response.ok() && body && typeof body === 'object') state.installedHandoff = body;
      if (/\/v1\/update$/.test(pathname)) state.updateResponses.push({ ...record, kind: 'update-response', status: response.status(), body });
      if (/\/v1\/update\/status$/.test(pathname) && body && typeof body === 'object') state.statusResponses.push({ ...record, kind: 'status-response', ...body });
      if (body && typeof body.native_job_observation === 'object') state.nativeJobObservations.push({ ...record, observation: body.native_job_observation });
      if (requestLooksLikeDraftSave(request) || request.method() === 'POST' && /\/v1\/app-state\//.test(pathname)) state.draftSaveResponses.push({ ...record, status: response.status(), body });
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

function validateInstalledSurfaceHandoff(handoff, { candidate, installRoot, dataRoot, scenario }) {
  object(handoff, 'installed-surface handoff');
  exactKeys(handoff, ['protocol', 'owner', 'install_root', 'data_root', 'managed_by', 'pinokio'], 'installed-surface handoff');
  if (handoff.protocol !== 'astrid-installed-surface-handoff/v1' || handoff.owner !== 'astrid-installed-product') throw new SurfaceError('installed-surface handoff owner is not approved');
  if (handoff.install_root !== installRoot || handoff.data_root !== dataRoot) throw new SurfaceError('installed-surface handoff roots differ from the request');
  if (scenario.mode !== 'direct' || handoff.managed_by !== null) throw new SurfaceError('installed-surface handoff owner mode differs from the direct scenario');
  object(handoff.pinokio, 'installed-surface Pinokio identity');
  exactKeys(handoff.pinokio, ['sha'], 'installed-surface Pinokio identity');
  if (!COMMIT.test(handoff.pinokio.sha) || handoff.pinokio.sha !== candidate.pinokio) throw new SurfaceError('installed-surface Pinokio identity differs from the candidate');
  return { managed_by: handoff.managed_by, pinokio: handoff.pinokio.sha };
}

async function openUpdatesPage(owned, installedUrl, timeout, installRoot, dataRoot, candidate, scenario, handoffId, preflightProcess) {
  const installedProcess = await runningInstalledProcess(installedUrl, timeout, installRoot);
  if (preflightProcess && (installedProcess.pid !== preflightProcess.pid || installedProcess.executable !== preflightProcess.executable)) throw new SurfaceError('installed App listener owner changed during browser handoff');
  const page = await owned.context.newPage();
  owned.lifecycle.pages_opened = (owned.lifecycle.pages_opened || 0) + 1;
  const observed = observePage(page, { handoffId });
  const navigation = observed.beginNavigation();
  await page.goto(updatesUrl(installedUrl), { waitUntil: 'domcontentloaded', timeout });
  await page.getByRole('region', { name: 'Updates' }).waitFor({ state: 'visible', timeout });
  await waitFor(() => observed.build && observed.manifest && observed.installedHandoff, timeout, 'installed build, manifest, and owner handoff responses');
  const identity = await installedIdentity(page, observed, candidate, installedProcess, installRoot, dataRoot, scenario);
  return { page, observed, installedProcess, navigation, identity };
}

export function validateInstalledIdentityObservation({ observed, candidate, candidateApp, expectedManifest, visibleRelease, visibleBuild, installedProcess, pageOrigin, installRoot, dataRoot, scenario }) {
  const expectedCandidate = candidate || { app: candidateApp };
  object(expectedCandidate, 'candidate identity');
  for (const name of ['app', 'agent', 'runtime', 'pinokio']) commit(expectedCandidate[name], `candidate ${name}`);
  const manifestIdentity = expectedManifest || { agent: expectedCandidate.agent, runtime: expectedCandidate.runtime };
  commit(manifestIdentity.agent, 'expected installed Agent identity');
  commit(manifestIdentity.runtime, 'expected installed Runtime identity');
  if (!installedProcess || installedProcess.origin !== pageOrigin) throw new SurfaceError('installed page origin is not bound to the observed listener owner');
  validateInstalledProcessObservation({ ...installedProcess, installRoot, platform: hostOs() });
  const build = observed.build;
  const app = build?.app;
  const buildRelease = build?.release;
  const manifestRelease = observed.manifest?.release;
  if (!app || !COMMIT.test(app)) throw new SurfaceError('installed UI did not expose an authenticated App build identity');
  if (app !== expectedCandidate.app) throw new SurfaceError(`installed App build ${app} differs from requested candidate ${expectedCandidate.app}`);
  if (!Number.isSafeInteger(buildRelease) || buildRelease !== manifestRelease || !Number.isSafeInteger(manifestRelease) || manifestRelease < 1) throw new SurfaceError('installed build and manifest release identities differ');
  if (observed.manifest?.agent?.sha !== manifestIdentity.agent || observed.manifest?.runtime?.sha !== manifestIdentity.runtime) throw new SurfaceError('installed manifest Agent or Runtime identity differs from the expected installed identity');
  if (visibleRelease !== manifestRelease || typeof visibleBuild !== 'string' || visibleBuild.length === 0) throw new SurfaceError('installed Updates UI disagrees with the network build/manifest observations');
  const handoff = validateInstalledSurfaceHandoff(observed.installedHandoff, { candidate: expectedCandidate, installRoot, dataRoot, scenario });
  return { app, agent: manifestIdentity.agent, runtime: manifestIdentity.runtime, pinokio: expectedCandidate.pinokio, managed_by: handoff.managed_by, release: manifestRelease, visible_release: visibleRelease, visible_build: visibleBuild, origin: pageOrigin, executable: installedProcess.executable, process_pid: installedProcess.pid, installedProcess, install_root: installRoot, data_root: dataRoot };
}

async function installedIdentity(page, observed, candidate, installedProcess, installRoot, dataRoot, scenario, expectedManifest) {
  const region = page.getByRole('region', { name: 'Updates' });
  const releaseRow = region.locator('dt').filter({ hasText: 'Release' }).locator('..');
  const releaseText = (await releaseRow.locator('dd').textContent())?.trim() || '';
  const buildRow = region.locator('dt').filter({ hasText: 'App build' }).locator('..');
  const buildNode = buildRow.locator('dd');
  const build = (await buildNode.getAttribute('title')) || (await buildNode.textContent())?.trim() || '';
  const release = Number((releaseText.match(/\d+/) || [])[0] || 0);
  return validateInstalledIdentityObservation({ observed, candidate, expectedManifest, visibleRelease: release, visibleBuild: build, installedProcess, pageOrigin: new URL(page.url()).origin, installRoot, dataRoot, scenario });
}

async function updateButton(page, name, timeout) {
  const button = page.getByRole('button', { name, exact: true });
  await button.waitFor({ state: 'visible', timeout });
  return button;
}

function statusStates(observed, boundaryIds = null) {
  const states = [];
  for (const response of observed.statusResponses) {
    if (boundaryIds && !boundaryIds.includes(response.boundary_id)) continue;
    if (!['active', 'recovery-needed', 'terminal'].includes(response.state)) continue;
    if (states.at(-1) !== response.state) states.push(response.state);
  }
  return states;
}

function matchingOperationId(observed, { pageId = observed.pageId, boundaryIds = null } = {}) {
  const values = [];
  for (const response of [...observed.updateResponses, ...observed.statusResponses]) {
    if (pageId !== null && response.page_id !== pageId || boundaryIds && !boundaryIds.includes(response.boundary_id)) continue;
    if (response.body && typeof response.body.operation_id === 'string') values.push(response.body.operation_id);
    if (typeof response.operation_id === 'string') values.push(response.operation_id);
  }
  const unique = [...new Set(values)];
  if (unique.length > 1) throw new SurfaceError(`browser observed ambiguous operation identities: ${unique.join(', ')}`);
  return unique[0] || null;
}

export function validateNativeJobObservation(observation, { handoffId, operationId }) {
  object(observation, 'native update owner observation');
  exactKeys(observation, ['protocol', 'owner', 'handoff_id', 'operation_id', 'count'], 'native update owner observation');
  if (observation.protocol !== NATIVE_HANDOFF_PROTOCOL || observation.owner !== 'native-update-owner' || observation.handoff_id !== handoffId || observation.operation_id !== (operationId ?? null) || !Number.isInteger(observation.count) || ![0, 1].includes(observation.count)) throw new SurfaceError('native update owner observation is not authenticated');
  return observation.count;
}

function authenticatedNativeJobs(observed, boundaryId, handoffId, operationId) {
  const matches = observed.nativeJobObservations.filter((record) => record.page_id === observed.pageId && record.boundary_id === boundaryId && record.handoff_id === handoffId && (record.observation?.operation_id ?? null) === (operationId ?? null));
  if (matches.length !== 1) throw new SurfaceError(`native update owner observation is ${matches.length === 0 ? 'missing' : 'ambiguous'} for the current browser boundary`);
  return validateNativeJobObservation(matches[0].observation, { handoffId, operationId });
}

function assertCurrentOperation(observed, operationId, boundaryIds) {
  for (const record of [...observed.updateRequests, ...observed.updateResponses, ...observed.statusResponses]) {
    if (record.page_id !== observed.pageId || !boundaryIds.includes(record.boundary_id)) continue;
    if (record.operation_id !== null && record.operation_id !== operationId) throw new SurfaceError('browser event operation identity differs from the current operation');
    if (record.kind === 'update-response' || record.kind === 'status-response') {
      if (record.operation_id !== operationId) throw new SurfaceError('browser response is not correlated to the current operation');
    }
  }
}

async function runUnsavedDraft({ page, observed, timeout, identity, handoffId, navigation }) {
  if (identity.release !== 1) throw new SurfaceError(`unsaved-draft control requires installed Release 1, observed ${identity.release}`);
  const action = observed.beginAction(`button-unsaved-draft:${randomUUID()}`);
  const button = await updateButton(page, 'Update now', timeout);
  await button.click();
  const currentDraftSaves = () => observed.draftSaveResponses.filter((response) => response.page_id === action.page_id && response.action_id === action.action_id);
  const currentUpdates = () => observed.updateRequests.filter((request) => request.page_id === action.page_id && request.action_id === action.action_id);
  await waitFor(() => currentUpdates().length > 0 || currentDraftSaves().length > 0 || page.getByRole('alert').count().then((count) => count > 0), timeout, 'the real draft flush result');
  const failedDraftSave = currentDraftSaves().some((response) => response.status >= 400);
  const updateRequests = currentUpdates().length;
  const automaticUpdateRequests = observed.updateRequests.filter((request) => request.page_id === observed.pageId && request.boundary_id === navigation.boundary_id && request.trigger === 'automatic').length;
  if (!failedDraftSave || updateRequests !== 0 || automaticUpdateRequests !== 0) throw new SurfaceError(`installed UI did not produce an authentic failed draft flush before Update (failed_save=${failedDraftSave}, update_requests=${updateRequests}, automatic_update_requests=${automaticUpdateRequests})`);
  const nativeJobs = authenticatedNativeJobs(observed, action.boundary_id, handoffId, null);
  if (nativeJobs !== 0) throw new SurfaceError(`native update owner observed ${nativeJobs} jobs during failed draft save`);
  return { surface: 'browser', save: 'failed', update_requests: updateRequests, native_jobs: nativeJobs, installed_release: identity.release };
}

async function runLostAck({ page, observed, context, timeout, identity, installedUrl, candidate, installRoot, dataRoot, scenario, handoffId, navigation }) {
  if (identity.release !== 1) throw new SurfaceError(`lost-ack control requires installed Release 1, observed ${identity.release}`);
  const automaticUpdateRequests = observed.updateRequests.filter((request) => request.page_id === observed.pageId && request.boundary_id === navigation.boundary_id && request.trigger === 'automatic').length;
  const actionId = `button-update-lost-ack:${randomUUID()}`;
  const action = observed.beginAction(actionId);
  const button = await updateButton(page, 'Update now', timeout);
  await button.click();
  await waitFor(() => observed.updateRequests.some((request) => request.page_id === action.page_id && request.action_id === action.action_id), timeout, 'the real explicit Update request');
  const clickRequests = observed.updateRequests.filter((request) => request.page_id === action.page_id && request.boundary_id === action.boundary_id && request.action_id === action.action_id);
  if (clickRequests.length !== 1) throw new SurfaceError(`explicit lost-ack click produced ${clickRequests.length} observed Update POST requests; expected exactly one`);
  if (automaticUpdateRequests !== 0) throw new SurfaceError(`browser observed ${automaticUpdateRequests} automatic update requests during the current page navigation`);
  // The handoff is deliberately not accepted from the POST response. Leave the
  // page, then observe the producer-owned recovery state from a fresh page in
  // the same owned profile. If the real product cannot reconcile the request,
  // this command fails rather than inventing a lost-ack receipt.
  await page.close();
  const reopened = await context.newPage();
  const reopenedObserved = observePage(reopened, { handoffId });
  const reopenedNavigation = reopenedObserved.beginNavigation(null, actionId);
  const reopenedUrl = updatesUrl(installedUrl);
  await reopened.goto(reopenedUrl, { waitUntil: 'domcontentloaded', timeout });
  await reopened.getByRole('region', { name: 'Updates' }).waitFor({ state: 'visible', timeout });
  const reopenedProcess = await runningInstalledProcess(installedUrl, timeout, installRoot);
  if (reopenedProcess.pid !== identity.process_pid || reopenedProcess.executable !== identity.executable) throw new SurfaceError('lost-ack recovery observed a replaced installed process');
  const reopenedIdentity = await installedIdentity(reopened, reopenedObserved, candidate, reopenedProcess, installRoot, dataRoot, scenario);
  if (reopenedIdentity.release !== 1 || reopenedIdentity.app !== candidate.app) throw new SurfaceError('lost-ack recovery reopened a different installed candidate');
  await waitFor(() => statusStates(reopenedObserved, [reopenedNavigation.boundary_id]).includes('recovery-needed'), timeout, 'producer-owned recovery-needed state');
  const states = [...statusStates(observed, [navigation.boundary_id, action.boundary_id]), ...statusStates(reopenedObserved, [reopenedNavigation.boundary_id])].filter((state, index, all) => index === 0 || state !== all[index - 1]);
  if (JSON.stringify(states.slice(-2)) !== JSON.stringify(['active', 'recovery-needed'])) throw new SurfaceError(`browser observed unexpected lost-ack lifecycle: ${JSON.stringify(states)}`);
  const operationId = matchingOperationId({
    updateResponses: [...observed.updateResponses, ...reopenedObserved.updateResponses],
    statusResponses: [...observed.statusResponses, ...reopenedObserved.statusResponses],
  }, { pageId: null });
  if (!operationId || !OPERATION.test(operationId)) throw new SurfaceError('browser did not observe a valid lost-ack operation ID');
  assertCurrentOperation(observed, operationId, [navigation.boundary_id, action.boundary_id]);
  assertCurrentOperation(reopenedObserved, operationId, [reopenedNavigation.boundary_id]);
  return { observation: { states: ['active', 'recovery-needed'], automatic_update_requests: automaticUpdateRequests, terminal_inferred: false, operation_id: operationId }, operationId };
}

async function runExplicit({ page, observed, timeout, identity, operationId, scenario, candidate, standInTarget, handoffId, navigation, installedUrl }) {
  if (identity.release !== 1) throw new SurfaceError(`explicit recovery control requires installed Release 1 before Update, observed ${identity.release}`);
  const priorStates = statusStates(observed, [navigation.boundary_id]);
  if (!priorStates.includes('recovery-needed')) throw new SurfaceError('explicit Update was not preceded by an observed recovery-needed state');
  const automaticUpdateRequests = observed.updateRequests.filter((request) => request.page_id === observed.pageId && request.boundary_id === navigation.boundary_id && request.trigger === 'automatic').length;
  if (automaticUpdateRequests !== 0) throw new SurfaceError(`browser observed ${automaticUpdateRequests} automatic Update POST requests before the current explicit click`);
  const action = observed.beginAction(`button-update-explicit:${randomUUID()}`, { operationId });
  const button = await updateButton(page, 'Update', timeout);
  await button.click();
  await waitFor(() => statusStates(observed, [action.boundary_id]).includes('terminal') && observed.updateResponses.some((response) => response.boundary_id === action.boundary_id), timeout, 'terminal explicit Update state and response');
  const states = [...priorStates.slice(-1), ...statusStates(observed, [action.boundary_id])].filter((state, index, all) => index === 0 || state !== all[index - 1]);
  if (JSON.stringify(states.slice(-3)) !== JSON.stringify(['recovery-needed', 'active', 'terminal'])) throw new SurfaceError(`browser observed unexpected explicit Update lifecycle: ${JSON.stringify(states)}`);
  const observedOperation = matchingOperationId(observed, { pageId: observed.pageId, boundaryIds: [navigation.boundary_id, action.boundary_id] });
  if (observedOperation !== operationId) throw new SurfaceError('explicit Update operation identity differs from the lost-ack operation');
  const updateRequests = observed.updateRequests.filter((request) => request.page_id === action.page_id && request.boundary_id === action.boundary_id && request.action_id === action.action_id);
  const updateResponses = observed.updateResponses.filter((response) => response.page_id === action.page_id && response.boundary_id === action.boundary_id && response.request_id === updateRequests[0]?.request_id);
  if (updateRequests.length !== 1 || updateResponses.length !== 1) throw new SurfaceError(`explicit Update produced ${updateRequests.length} requests and ${updateResponses.length} matching responses; expected exactly one of each`);
  assertCurrentOperation(observed, operationId, [navigation.boundary_id, action.boundary_id]);
  const currentProcess = await runningInstalledProcess(installedUrl, timeout, identity.install_root);
  let finalIdentity = identity;
  if (scenario.os === 'linux') {
    await waitFor(() => observed.build?.app && observed.manifest?.release === 2, timeout, 'installed Release 2 identity after saved-draft Update');
    finalIdentity = await installedIdentity(page, observed, candidate, currentProcess, identity.install_root, identity.data_root, scenario, { agent: standInTarget.agent, runtime: standInTarget.runtime });
    if (finalIdentity.release !== 2) throw new SurfaceError(`saved-draft Update did not expose installed Release 2 (observed ${finalIdentity.release})`);
  }
  const savePassed = observed.draftSaveResponses.some((response) => response.page_id === action.page_id && response.boundary_id === action.boundary_id && response.action_id === action.action_id && response.status >= 200 && response.status < 300);
  const observation = { states: ['recovery-needed', 'active', 'terminal'], action: 'explicit-update', operation_id: operationId };
  if (scenario.os === 'linux') observation.draft_control = { surface: 'browser', save: savePassed ? 'pass' : 'failed', update_requests: updateRequests.length, native_jobs: authenticatedNativeJobs(observed, action.boundary_id, handoffId, operationId), installed_release: finalIdentity.release };
  if (scenario.os === 'linux' && !savePassed) throw new SurfaceError('saved-draft control lacked an authentic correlated browser save response');
  return observation;
}

async function runAction({ envelope, action, request, inputs, scenario, profileRoot, installedUrl, browserPath, timeout }) {
  if (hostOs() !== scenario.os) throw new SurfaceError(`request scenario OS ${scenario.os} does not match host ${hostOs() || process.platform}`);
  const candidate = inputs.candidate;
  const preflightProcess = await runningInstalledProcess(installedUrl, timeout, inputs.root);
  const profile = await ensureProfile(profileRoot, candidate.app, scenario, { action, value: envelope.handoff_id }, { installRoot: inputs.root, dataRoot: inputs.data_root });
  const browser = await launchOwnedBrowser(profile.root, browserPath, timeout);
  try {
    const { page, observed, installedProcess, navigation, identity } = await openUpdatesPage(browser, installedUrl, timeout, inputs.root, inputs.data_root, candidate, scenario, envelope.handoff_id, preflightProcess);
    browser.lifecycle.installed_identity = { app: identity.app, agent: identity.agent, runtime: identity.runtime, pinokio: identity.pinokio, managed_by: identity.managed_by, release: identity.release, origin: identity.origin, executable: identity.executable, install_root: identity.install_root };
    browser.lifecycle.installed_process = installedProcess;
    if (action === 'button-unsaved-draft') return { observation: await runUnsavedDraft({ page, observed, timeout, identity, handoffId: envelope.handoff_id, navigation }), marker: profile.marker, lifecycle: browser.lifecycle };
    if (action === 'button-update-lost-ack') {
      const lost = await runLostAck({ page, observed, context: browser.context, timeout, identity, installedUrl, candidate, installRoot: inputs.root, dataRoot: inputs.data_root, scenario, handoffId: envelope.handoff_id, navigation });
      const nextMarker = { ...profile.marker, operation_id: lost.operationId };
      await writeMarker(profile.root, nextMarker);
      return { observation: lost.observation, marker: nextMarker, lifecycle: browser.lifecycle };
    }
    const markerIdentity = { candidateApp: candidate.app, scenario, profileRoot: profileRoot, installRoot: inputs.root, dataRoot: inputs.data_root };
    const marker = await readMarker(profile.root, { ...markerIdentity, sessionKey: sessionKey(markerIdentity) });
    if (!marker?.operation_id) throw new SurfaceError('explicit Update is not bound to the previously observed operation');
    const operationId = request.payload.operation_id;
    if (marker.operation_id !== operationId) throw new SurfaceError('explicit Update operation ID differs from owned profile state');
    return { observation: await runExplicit({ page, observed, timeout, identity, operationId, scenario, candidate, standInTarget: inputs.stand_in.target, handoffId: envelope.handoff_id, navigation, installedUrl }), marker, lifecycle: browser.lifecycle };
  } finally {
    await closeOwnedBrowser(browser);
  }
}

function responseEnvelope(envelope, action, observation, lifecycle) {
  return { protocol: PROTOCOL, handoff_id: envelope.handoff_id, surface: SURFACE, action, status: 'pass', evidence: { kind: 'browser-process', pid: process.pid, synthetic: false, source_only: false, browser_lifecycle: lifecycle, observation_sha256: sha256(observation) }, observation };
}

export async function cleanupOwnedProfile(envelope, profileRoot) {
  const { inputs, scenario } = validateEnvelope(envelope);
  const root = await ensureCleanupOwnership(profileRoot, inputs.candidate.app, scenario, { installRoot: inputs.root, dataRoot: inputs.data_root });
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

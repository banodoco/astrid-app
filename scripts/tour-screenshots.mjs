#!/usr/bin/env node
/**
 * npm run tour:screenshots -- [--devices iphone-15,ipad-mini-portrait,desktop]
 *   [--themes light,dark] [--steps act1-welcome,act1-compose,run-mode,connection,local-setup]
 *   [--out test-results/my-tour] [--base-url http://127.0.0.1:5173] [--headed]
 *
 * Defaults: all seven devices, both themes, every step; output under
 * test-results/tour-shots/<timestamp>. Filters select captures, but still walk preceding beats.
 * Uses the Playwright API, the repo's existing Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE
 * overrides it), and an isolated fake Runtime. No installs or real service requests.
 * --base-url reuses a loopback Vite server; API calls still go only to this run's fake.
 * Each device/theme owns a fresh browser process, so live scene GPU contexts cannot accumulate.
 * Owned Vite runs in test mode with a hosted origin so the run-mode screen is reachable.
 * The connection fixture returns 503 health checks to keep its install card on screen;
 * phones/tablets naturally show the phone card (no run-mode choice, no local setup).
 * On a computer, local setup is reached through Back from connection and the local run mode.
 * Skips include the app's explanation/source. Issues are design findings, not command
 * failures. Unreachable beats fail after 20 s and one retry, save evidence and continue
 * with the next device. A nonzero exit means captures failed. report.json records fixtures,
 * emulation, retries, blocked requests, both screenshot variants and their layout checks.
 * Sandboxed scene frames cannot store a theme. Playwright's service-worker blocker
 * also emits a sandbox warning there; browserErrors keeps that diagnostic.
 * The live preview keeps playing as in the app: its media/Three.js pixels and timeline
 * playhead can vary between captures despite frozen Date/randomness and reduced motion.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, devices } from '@playwright/test';
import { buildFakeRuntimeEnv } from '../tests/e2e/fake-runtime/launch.mjs';
import { terminateProcessTree } from './terminate-process-tree.mjs';
import { readTourSteps } from './tour-shot-metadata.mjs';
import { collectLayoutIssues } from './tour-shot-layout.mjs';

export const DEVICE_PROFILES = Object.fromEntries([
  ['iphone-se', 'iPhone SE (3rd gen)', 375, 667], ['iphone-15', 'iPhone 15', 393, 852],
  ['pixel-7', 'Pixel 7', 412, 915], ['ipad-mini-portrait', 'iPad Mini', 744, 1133],
  ['ipad-air-landscape', 'iPad Pro 11 landscape', 1180, 820], ['ipad-pro-portrait', 'iPad Pro 11', 1024, 1366],
  ['desktop', 'Desktop Chrome', 1440, 900],
].map(([name, descriptor, width, height]) => {
  const { defaultBrowserType, ...profile } = devices[descriptor];
  return [name, { ...profile, viewport: { width, height }, screen: { width, height } }];
}));
const STORE = '/src/shared/state/editorTourStore.ts';
const BEATS = '/src/tools/video-editor/tour/runner/tourBeats.ts';
const TIME = '2026-01-15T12:00:00.000Z';
const TIMEOUT = 20_000;
const FOLLOWUP = [{ id: 'run-mode' }, { id: 'connection' }, { id: 'local-setup' }];

export function chromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return undefined;
  const installed = process.env.PLAYWRIGHT_BROWSERS_PATH && join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium');
  return installed && existsSync(installed) && statSync(installed).isFile() ? installed : undefined;
}

export function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const [key, inline] = args[index].split('=');
    if (key === '--headed' || key === '--help') { options[key.slice(2)] = true; continue; }
    if (!['--devices', '--themes', '--steps', '--out', '--base-url'].includes(key)) throw new Error(`Unknown flag: ${key}`);
    const value = inline ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} needs a value`);
    options[key.slice(2)] = value;
  }
  options.devices = options.devices?.split(',') ?? Object.keys(DEVICE_PROFILES);
  options.themes = options.themes?.split(',') ?? ['light', 'dark'];
  for (const device of options.devices) if (!DEVICE_PROFILES[device]) throw new Error(`Unknown device: ${device}`);
  for (const theme of options.themes) if (!['light', 'dark'].includes(theme)) throw new Error(`Unknown theme: ${theme}`);
  if (new Set(options.devices).size !== options.devices.length || new Set(options.themes).size !== options.themes.length) throw new Error('Device and theme lists must not contain duplicates');
  options.steps = options.steps?.split(',');
  if (options['base-url']) {
    const url = new URL(options['base-url']);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('--base-url must be a loopback HTTP origin');
    options['base-url'] = url.origin;
  }
  return options;
}

async function within(promise, timeout, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]); }
  finally { clearTimeout(timer); }
}

export async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

export async function waitServer(url, child, stopped, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (stopped()) throw new Error('Screenshot run interrupted');
    if (child && (child.exitCode !== null || child.signalCode !== null || child.startupError)) throw new Error('Owned server exited during startup');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Still starting. */ }
    await delay(100);
  }
  throw new Error(`Server did not become ready: ${new URL(url).pathname}`);
}

export function initialize({ theme, time }) {
  const NativeDate = Date, frozen = NativeDate.parse(time);
  function FixedDate(...args) { return new.target ? new NativeDate(...(args.length ? args : [frozen])) : new NativeDate(frozen).toString(); }
  Object.setPrototypeOf(FixedDate, NativeDate);
  FixedDate.prototype = NativeDate.prototype;
  FixedDate.now = () => frozen;
  window.Date = FixedDate;
  let seed = 0x12345678;
  Math.random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  try { localStorage.setItem('theme-hour', theme === 'dark' ? '0' : '12'); }
  catch { /* Sandboxed scene frames have no storage. Date and randomness still apply. */ }
}

async function tourState(page) {
  return page.evaluate(() => window.__tourShotsStore.getEditorTourState());
}

async function settled(page, step, remaining, pending) {
  if (step.beat) {
    await page.waitForFunction(({ act, beat }) => {
      const state = window.__tourShotsStore.getEditorTourState();
      return state.status === 'running' && state.act === act && state.beat === beat && window.__tourShotsBeats.isEditorTourBeatReady(state);
    }, step, { timeout: remaining() });
    await page.locator(`[data-editor-tour-card="${step.beat}"][data-settled]`).waitFor({ timeout: remaining() });
  }
  await page.waitForFunction(() => document.fonts.status === 'loaded', null, { timeout: remaining() });
  await page.waitForFunction(() => [...document.images].every(image => !image.getBoundingClientRect().width || image.complete), null, { timeout: remaining() });
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity), null, { timeout: remaining() });
  // The runner observes sizes, not translations. A pane can finish sliding in without
  // another observer callback; wake its existing resize listener after transitions finish.
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForFunction(({ selectors, key, targetCount, compose }) => {
    const elements = selectors.map(selector => document.querySelector(selector));
    if (elements.some(element => !element || !element.getBoundingClientRect().width || !element.getBoundingClientRect().height || getComputedStyle(element).visibility === 'hidden')) return false;
    const cutouts = [...document.querySelectorAll('#editor-tour-dim rect[fill="black"]')];
    // A short phone lights fewer cutouts than the beat has targets (the row gives way to the card), so one open cutout is enough.
    if (targetCount && !cutouts.some(rect => Number(rect.getAttribute('width')) > 0 && Number(rect.getAttribute('height')) > 0)) return false;
    if (compose && getComputedStyle(document.querySelector('[data-editor-tour-shield]')).clipPath === 'none') return false;
    const animations = elements.flatMap(element => element.getAnimations({ subtree: true }));
    if (animations.some(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity)) return false;
    const boxes = elements.map(element => { const box = element.getBoundingClientRect(); return [box.x, box.y, box.width, box.height]; });
    const signature = JSON.stringify([boxes, [...document.querySelectorAll('#editor-tour-dim rect')].map(rect => ['x', 'y', 'width', 'height'].map(name => rect.getAttribute(name)))]);
    const previous = window.__tourShotsRects;
    window.__tourShotsRects = { key, signature, frames: previous?.key === key && previous.signature === signature ? previous.frames + 1 : 0 };
    return window.__tourShotsRects.frames >= 2;
  }, { selectors: step.beat ? ['[data-editor-tour-card-host]', '[data-editor-tour-shield]', ...step.targets] : ['h1'], key: step.id, targetCount: step.targets?.length ?? 0, compose: step.beat === 'compose' }, { timeout: remaining(), polling: 'raf' });
  // Require two quiet animation frames after the last fake response, not networkidle (Vite has a socket).
  while (true) {
    while (pending.size) { remaining(); await delay(25); }
    await page.waitForFunction(() => {
      window.__tourShotsQuietFrames = (window.__tourShotsQuietFrames ?? 0) + 1;
      return window.__tourShotsQuietFrames >= 3;
    }, null, { timeout: remaining(), polling: 'raf' });
    await page.evaluate(() => { window.__tourShotsQuietFrames = 0; });
    if (!pending.size) break;
    remaining();
  }
  const dark = await page.locator('html').evaluate(element => element.classList.contains('dark'));
  if (dark !== (step.theme === 'dark')) throw new Error(`App theme did not match ${step.theme}`);
}

async function activate(locator, touch, remaining) {
  const position = await locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    for (const y of [0.5, 0.25, 0.75, 0.1, 0.9]) for (const x of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      const px = box.left + box.width * x, py = box.top + box.height * y;
      if (px < 0 || px >= innerWidth || py < 0 || py >= innerHeight) continue;
      const hit = document.elementFromPoint(px, py);
      if (hit && element.contains(hit)) return { x: box.width * x, y: box.height * y };
    }
    return null;
  });
  if (touch) await locator.tap({ timeout: remaining(), ...(position ? { position } : {}) });
  else await locator.click({ timeout: remaining(), ...(position ? { position } : {}) });
}

async function advance(page, step, touch, remaining) {
  const control = step.beat === 'compose'
    ? page.locator('[data-editor-tour="chat-send"]')
    : page.locator('[data-editor-tour-card] section').getByRole('button').last();
  await activate(control, touch, remaining);
  await page.waitForFunction(({ act, beat }) => {
    const state = window.__tourShotsStore.getEditorTourState();
    return state.status !== 'running' || state.act !== act || state.beat !== beat;
  }, step, { timeout: remaining() });
}

export function renderIndex(report) {
  const escape = text => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const tables = report.themes.map(theme => `<table data-theme="${theme}" ${theme !== report.themes[0] ? 'hidden' : ''}><thead><tr><th>Step</th>${report.devices.map(device => `<th>${escape(device.name)}<br>${device.profile.viewport.width} × ${device.profile.viewport.height}</th>`).join('')}</tr></thead><tbody>${report.steps.map(step => `<tr><th>${escape(step.id)}</th>${report.devices.map(device => {
    const result = report.results.find(item => item.device === device.name && item.theme === theme && item.step === step.id);
    if (!result) return '<td>Not reached</td>';
    const label = `${result.status} · ${result.issues?.length ?? 0} issues`;
    return `<td class="${result.status}">${result.viewport ? `<a href="${escape(result.viewport)}"><img loading="lazy" src="${escape(result.viewport)}" alt="${escape(device.name + ' ' + step.id)}"></a>` : ''}<p>${escape(label)}</p>${result.fullPage ? `<a href="${escape(result.fullPage)}">Full page</a>` : ''}<p>${escape(result.reason ?? result.error ?? '')}</p><details><summary>Findings</summary><ul>${(result.issues ?? []).map(issue => `<li>${escape(issue.type)} — ${escape(issue.selector)}: ${escape(issue.text)}</li>`).join('')}</ul></details></td>`;
  }).join('')}</tr>`).join('')}</tbody></table>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Tour screenshots</title><style>body{font:14px system-ui;margin:24px;background:#eee;color:#222}button{padding:10px;margin:0 8px 16px 0}table{border-collapse:collapse;table-layout:fixed}table[hidden]{display:none}th,td{border:1px solid #aaa;padding:8px;vertical-align:top;width:220px;min-width:180px}thead th{position:sticky;top:0;background:#ddd}img{width:220px;height:240px;object-fit:contain;background:#ccc}.failed{background:#fdd}.skipped{background:#ddd}p{overflow-wrap:anywhere}details{max-width:220px}</style><h1>First-run tour</h1><p>Frozen ${escape(report.determinism.time)} · reduced motion · isolated fake Runtime · offline connection fixture. <a href="report.json">JSON report</a></p>${report.themes.map(theme => `<button data-select="${theme}">${theme}</button>`).join('')}${tables}<script>document.querySelectorAll('button').forEach(button=>button.onclick=()=>document.querySelectorAll('table').forEach(table=>table.hidden=table.dataset.theme!==button.dataset.select));</script></html>`;
}

export async function run(options) {
  const steps = [...readTourSteps(), ...FOLLOWUP];
  for (const id of options.steps ?? []) if (!steps.some(step => step.id === id)) throw new Error(`Unknown step: ${id}. Available: ${steps.map(step => step.id).join(', ')}`);
  const lastSelected = options.steps ? Math.max(...options.steps.map(id => steps.findIndex(step => step.id === id))) : steps.length - 1;
  const out = resolve(options.out ?? `test-results/tour-shots/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  if (relative(process.cwd(), out).startsWith('..') || relative(process.cwd(), out) === '') throw new Error('--out must be a subdirectory of this worktree');
  await mkdir(out, { recursive: true });
  try { await readFile(join(out, 'report.json')); throw new Error('--out already contains a report; use a fresh output directory'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const children = [];
  const privateDir = join(out, '.server');
  let browser, interrupted = false;
  const report = {
    version: 1, themes: options.themes, steps, devices: options.devices.map(name => ({ name, profile: DEVICE_PROFILES[name] })),
    determinism: { time: TIME, seed: '0x12345678', locale: 'en-US', timezone: 'UTC', reducedMotion: true, runtime: 'isolated fake', pixelIdentityLimit: 'The app autoplays live preview/video on real animation and media clocks, including in reduced motion. These pixels and the timeline playhead can differ; tour controls and styling are preserved.', spotlightRemeasure: 'Resize event after pane transitions; no geometry or style overrides', connection: '503 offline health fixture', browser: null }, results: [],
  };
  const persist = async () => {
    report.summary = report.devices.flatMap(device => report.themes.map(theme => {
      const rows = report.results.filter(row => row.device === device.name && row.theme === theme);
      const issueCounts = {};
      for (const row of rows) for (const issue of row.issues) issueCounts[issue.type] = (issueCounts[issue.type] ?? 0) + 1;
      return { device: device.name, theme, captured: rows.filter(row => row.status === 'captured').length, skipped: rows.filter(row => row.status === 'skipped').length, failed: rows.filter(row => row.status === 'failed').length, filtered: rows.filter(row => row.status === 'filtered').length, issueCounts };
    }));
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(out, 'index.html'), renderIndex(report));
  };
  const stop = () => { interrupted = true; report.interrupted = true; void browser?.close(); for (const child of children) void terminateProcessTree(child); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await mkdir(privateDir, { mode: 0o700 });
    const tokenFile = join(privateDir, 'token');
    const token = 'tour-shots-fake-runtime-only';
    await writeFile(tokenFile, token, { mode: 0o600 });
    const runtimePort = await freePort();
    const fakeEnv = buildFakeRuntimeEnv({ port: runtimePort, tokenFile, token });
    const spawnOwned = (args, env) => {
      const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: 'ignore', detached: process.platform !== 'win32' });
      child.on('error', () => { child.startupError = true; });
      children.push(child);
      return child;
    };
    const runtime = spawnOwned(['tests/e2e/fake-runtime/launch.mjs', '--serve'], fakeEnv);
    const runtimeOrigin = `http://127.0.0.1:${runtimePort}`;
    await waitServer(`${runtimeOrigin}/runtime-config/v1/workspace.json`, runtime, () => interrupted);
    const baseUrl = options['base-url'] ?? `http://127.0.0.1:${await freePort()}`;
    report.baseUrl = baseUrl;
    if (!options['base-url']) {
      const viteBoot = "import { createServer } from 'vite'; const server = await createServer(JSON.parse(process.argv[1])); await server.listen();";
      const vite = spawnOwned(['--input-type=module', '--eval', viteBoot, JSON.stringify({ configFile: 'config/vite/vite.config.ts', mode: 'test', cacheDir: join(privateDir, 'vite-cache'), server: { host: '127.0.0.1', port: Number(new URL(baseUrl).port), strictPort: true } })], {
        ...fakeEnv, VITE_RUNTIME_ORIGIN: baseUrl,
        VITE_WORKSPACE_RUNTIME_EXPECTED_ACTOR_ID: '', VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID: '', VITE_WORKSPACE_RUNTIME_EXPECTED_INSTANCE_ID: '',
      });
      await waitServer(baseUrl, vite, () => interrupted);
    } else await waitServer(baseUrl, null, () => interrupted, 10_000);
    const launchBrowser = () => chromium.launch({ timeout: TIMEOUT, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, headless: !options.headed, executablePath: chromiumExecutable(), args: ['--no-sandbox'] });
    browser = await launchBrowser();
    report.determinism.browser = browser.version();
    deviceRuns: for (const device of report.devices) for (const theme of options.themes) {
      if (interrupted) break deviceRuns;
      const directory = `${device.name}-${theme}`;
      await mkdir(join(out, directory), { recursive: true });
      let context, page;
      const pending = new Set(), blocked = new Map(), startupErrors = [];
      const rows = steps.map(step => ({ device: device.name, theme, step: step.id, status: 'pending', issues: [] }));
      report.results.push(...rows);
      let failed = false;
      let scenario;
      // Phones and tablets have no run-mode choice and no local setup: the tour leads to the connection screen's phone card.
      const phoneReason = () => ({ text: scenario.phoneReason, source: 'src/app/onboarding/WelcomeFlow.tsx (finishTour); src/shared/components/RuntimeConnection/copy.ts (phone)' });
      const localReason = text => ({ text, source: 'src/app/onboarding/WelcomeFlow.tsx (finishTour)' });
      const perform = async (step, index, prepare, move) => {
        const row = rows[index];
        const selected = !options.steps || options.steps.includes(step.id);
        const name = `${String(index + 1).padStart(2, '0')}-${step.id}`;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const deadline = Date.now() + TIMEOUT;
          const remaining = () => { const left = deadline - Date.now(); if (left <= 0) throw new Error(`Step exceeded ${TIMEOUT} ms`); return left; };
          row.attempts = attempt;
          try {
            await prepare?.(remaining);
            await settled(page, { ...step, theme }, remaining, pending);
            if (selected) {
              const checkOptions = { touch: device.profile.hasTouch, mobile: device.profile.isMobile, targets: step.targets ?? [], ...(step.beat ? {} : { cardSelector: 'welcome-card' }) };
              row.issues = await page.evaluate(collectLayoutIssues, checkOptions);
              row.viewport = `${directory}/${name}.png`;
              await page.screenshot({ path: join(out, row.viewport), fullPage: false, animations: 'disabled', caret: 'hide', timeout: remaining() });
              row.fullPage = `${directory}/${name}-full.png`;
              await settled(page, { ...step, theme }, remaining, pending);
              row.fullPageIssues = await page.evaluate(collectLayoutIssues, { ...checkOptions, fullPage: true });
              await page.screenshot({ path: join(out, row.fullPage), fullPage: true, animations: 'disabled', caret: 'hide', timeout: remaining() });
            }
            if (move) { await settled(page, { ...step, theme }, remaining, pending); await move(remaining); }
            row.status = selected ? 'captured' : 'filtered';
            console.log(`  ${step.id}: ${row.status} (${row.issues.length} issues)`);
            return true;
          } catch (error) {
            row.retries ??= [];
            row.retries.push({ attempt, error: error.message });
            row.diagnostics = await page.evaluate(() => {
              const button = document.querySelector('[data-editor-tour="chat-send"]');
              const box = button?.getBoundingClientRect();
              const shield = document.querySelector('[data-editor-tour-shield]');
              return { state: window.__tourShotsStore?.getEditorTourState(), send: box?.toJSON(), shieldClip: shield && getComputedStyle(shield).clipPath, hit: box && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.outerHTML.slice(0, 300), viewport: { width: innerWidth, height: innerHeight }, visualViewport: { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale } };
            }).catch(() => null);
            // A click may have completed before a timeout: do not click a subsequent beat on retry.
            if (attempt === 1 && step.beat) {
              const state = await tourState(page).catch(() => null);
              if (state && (state.status !== 'running' || state.act !== step.act || state.beat !== step.beat)) break;
            }
          }
        }
        row.status = 'failed';
        row.error = row.retries.at(-1).error;
        row.issues = await page.evaluate(collectLayoutIssues, { touch: device.profile.hasTouch, mobile: device.profile.isMobile, targets: step.targets ?? [] }).catch(() => []);
        row.viewport = `${directory}/${name}-failed.png`;
        await page.screenshot({ path: join(out, row.viewport), timeout: 5000, animations: 'disabled' }).catch(() => { delete row.viewport; });
        failed = true;
        return false;
      };
      try {
        console.log(`${directory}: preparing browser`);
        browser ??= await launchBrowser();
        if (interrupted) throw new Error('Screenshot run interrupted');
        context = await within(browser.newContext({ ...device.profile, locale: 'en-US', timezoneId: 'UTC', colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' }), TIMEOUT, 'Browser context setup timed out');
        await context.addInitScript(initialize, { theme, time: TIME });
        const reset = await fetch(`${runtimeOrigin}/__test/reset`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: 'empty' }), signal: AbortSignal.timeout(TIMEOUT) });
        if (!reset.ok) throw new Error('Could not reset the isolated fake Runtime');
        await reset.arrayBuffer();
        const isApi = request => /^\/api\/(runtime|astrid)(\/|$)/.test(new URL(request.url()).pathname) || new URL(request.url()).pathname === '/runtime-config/v1/workspace.json';
        context.on('request', request => { if (isApi(request)) pending.add(request); });
        context.on('requestfinished', request => pending.delete(request));
        context.on('requestfailed', request => pending.delete(request));
        await context.routeWebSocket('**/*', socket => socket.close());
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url());
          const api = /^\/api\/(runtime|astrid)(\/|$)/.test(url.pathname);
          if (api || url.pathname === '/runtime-config/v1/workspace.json') {
            // No configured proxy can send these calls to a real Runtime, even in reuse mode.
            try {
              if (/\/health(?:z)?\/?$/.test(url.pathname)) return await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"tour_shots_runtime_offline"}' });
              const path = url.pathname.replace(/^\/api\/(runtime|astrid)/, '') || '/';
              const response = await fetch(`${runtimeOrigin}${path}${url.search}`, { method: request.method(), headers: { Authorization: `Bearer ${token}`, 'Content-Type': request.headers()['content-type'] ?? 'application/json' }, body: request.postDataBuffer() ?? undefined, signal: AbortSignal.timeout(10_000) });
              const body = Buffer.from(await response.arrayBuffer());
              await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body });
            } catch { await route.abort().catch(() => {}); }
          } else if (url.origin === baseUrl && !url.pathname.startsWith('/api/')) await route.continue();
          else { const key = `${url.origin}${url.pathname}`; blocked.set(key, (blocked.get(key) ?? 0) + 1); await route.abort('blockedbyclient'); }
        });
        page = await within(context.newPage(), TIMEOUT, 'Browser page setup timed out');
        page.on('pageerror', error => startupErrors.push(error.message));
        page.on('console', message => { if (message.type() === 'error' && message.text().startsWith('Astrid failed to start')) startupErrors.push(message.text()); });
        page.on('response', response => { if (response.status() === 504) startupErrors.push(`Vite returned 504 for ${new URL(response.url()).pathname}; restart the reused server with an isolated dependency cache.`); });
        page.setDefaultTimeout(TIMEOUT);
        console.log(`${directory}: walking ${steps.length} steps`);
        // Cold Vite compilation belongs to navigation, not a beat's 20-second budget.
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await page.goto(`${baseUrl}/tools/video-editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
            await page.waitForFunction(() => document.querySelector('[data-editor-tour-card]') || [...document.querySelectorAll('h1')].some(heading => heading.textContent.includes('Astrid could not')), null, { timeout: 120_000 });
            if (!await page.locator('[data-editor-tour-card]').count()) throw new Error(startupErrors.join('\n') || 'The app displayed its startup failure card.');
            break;
          } catch (error) {
            if (attempt === 2 || interrupted) throw error;
            rows[0].startupRetries = [{ attempt, error: error.message }];
          }
        }
        scenario = await page.evaluate(async ({ store, beats }) => {
          window.__tourShotsStore = await import(/* @vite-ignore */ store);
          window.__tourShotsBeats = await import(/* @vite-ignore */ beats);
          const { detectInstallScenario } = await import('/src/pages/Home/installScenario.ts');
          const { runtimeOrigin } = await import('/src/integrations/runtime/connection.ts');
          const { RUNTIME_CONNECTION_COPY } = await import('/src/shared/components/RuntimeConnection/copy.ts');
          return { mobile: detectInstallScenario() === 'mobile', local: runtimeOrigin() === '', phoneReason: RUNTIME_CONNECTION_COPY.phone.sentence };
        }, { store: STORE, beats: BEATS });
        for (const [index, step] of steps.entries()) {
          if (!step.beat || index > lastSelected) break;
          if (!await perform(step, index, null, remaining => advance(page, step, device.profile.hasTouch, remaining))) break;
        }
        if (!failed && lastSelected >= steps.length - FOLLOWUP.length) {
          const index = steps.length - FOLLOWUP.length;
          const skip = (row, reason) => { row.status = 'skipped'; row.reason = reason.text; row.reasonSource = reason.source; };
          // run-mode: only on a computer's hosted build. Continue leads to the connection screen.
          if (scenario.mobile) skip(rows[index], phoneReason());
          else if (scenario.local) skip(rows[index], localReason('A local build has no run-mode choice: the tour leads straight to local setup.'));
          else await perform(steps[index], index, remaining => page.getByRole('heading', { name: 'How do you want to run Astrid?' }).waitFor({ timeout: remaining() }), remaining => activate(page.getByRole('button', { name: /Continue in this tab|^Continue$/ }), device.profile.hasTouch, remaining));
          // connection: the phone card on phones; the install/permission card on a computer's hosted build.
          if (!failed && lastSelected >= index + 1) {
            if (scenario.local) skip(rows[index + 1], localReason('A local build sets up locally first; connection follows local setup\'s Continue.'));
            else await perform(steps[index + 1], index + 1, remaining => page.locator('[data-testid="runtime-not-connected"] h1').waitFor({ timeout: remaining() }));
          }
          // local-setup: reached from the run-mode choice (Back from connection), or directly on a local build.
          if (!failed && lastSelected >= index + 2) {
            if (scenario.mobile) skip(rows[index + 2], phoneReason());
            else await perform(steps[index + 2], index + 2, async remaining => {
              if (await page.getByRole('heading', { name: 'Have your agent set it up', exact: true }).isVisible()) return;
              if (await page.locator('[data-testid="runtime-not-connected"]').isVisible()) await activate(page.getByRole('button', { name: 'Back', exact: true }), device.profile.hasTouch, remaining);
              await activate(page.getByText(/^Run Astrid on your computer$/), device.profile.hasTouch, remaining);
              await activate(page.getByRole('button', { name: 'Set up with your agent', exact: true }), device.profile.hasTouch, remaining);
            });
          }
        }
      } catch (error) {
        failed = true;
        const row = rows.find(row => row.status === 'pending') ?? rows[0];
        row.status = 'failed'; row.error = error.message;
        row.issues = page ? await page.evaluate(collectLayoutIssues, { touch: device.profile.hasTouch, mobile: device.profile.isMobile }).catch(() => []) : [];
        row.viewport = `${directory}/navigation-failed.png`;
        if (page) await page.screenshot({ path: join(out, row.viewport), timeout: 5000 }).catch(() => { delete row.viewport; });
        else delete row.viewport;
      } finally {
        for (const row of rows.filter(row => row.status === 'pending')) { row.status = failed ? 'skipped' : 'filtered'; row.reason = failed ? 'Earlier step failed; continuing with the next device.' : 'After the last requested capture.'; }
        report.browserErrors ??= {};
        report.browserErrors[directory] = startupErrors;
        report.blockedRequests ??= {};
        report.blockedRequests[directory] = Object.fromEntries(blocked);
        await browser?.close();
        browser = undefined;
        await persist();
        console.log(`${directory}: ${rows.filter(row => row.status === 'captured').length} captured, ${rows.filter(row => row.status === 'skipped').length} skipped, ${rows.filter(row => row.status === 'failed').length} failed`);
      }
    }
    return { out, report, failed: interrupted || report.results.some(row => row.status === 'failed') };
  } finally {
    await browser?.close();
    await Promise.all(children.map(async child => {
      if (!child.pid) return;
      const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(done => child.once('exit', done));
      await terminateProcessTree(child);
      const timer = setTimeout(() => { void terminateProcessTree(child, 'SIGKILL'); }, 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }));
    await rm(privateDir, { recursive: true, force: true });
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await persist();
    console.log(join(out, 'index.html'));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log((await readFile(fileURLToPath(import.meta.url), 'utf8')).split('/**')[1].split('*/')[0].replace(/^ \* ?/gm, ''));
    else { const result = await run(options); if (result.failed) process.exitCode = 1; }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

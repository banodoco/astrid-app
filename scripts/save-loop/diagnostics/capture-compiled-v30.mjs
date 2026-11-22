import assert from 'node:assert/strict';
import {mkdtemp, open, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFile, execFileSync, spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {publicSnapshot} from '../assert.mjs';
import {parseStat, runtimeRootForData} from '../cpu.mjs';
import {expectedFixtureIds, sameIds} from '../readiness.mjs';

const [root, manifestFile, resultFile] = process.argv.slice(2);
assert(root && manifestFile && resultFile, 'usage: capture-compiled-v30.mjs OWNED_ROOT V30_MANIFEST NEW_RESULT');
const options = process.argv.slice(5);
assert(options.length === 2 && options[0] === '--py-spy' && path.isAbsolute(options[1]),
  'usage: capture-compiled-v30.mjs OWNED_ROOT V30_MANIFEST NEW_RESULT --py-spy /absolute/path/to/py-spy');
const samplerBin = options[1];
const chromeBin = process.env.SAVE_LOOP_CHROME;
const playwrightPath = process.env.SAVE_LOOP_PLAYWRIGHT;
assert(chromeBin && path.isAbsolute(chromeBin), 'SAVE_LOOP_CHROME must be an absolute browser path');
assert(playwrightPath && path.isAbsolute(playwrightPath), 'SAVE_LOOP_PLAYWRIGHT must be an absolute Playwright module path');
const origin = 'http://127.0.0.1:2400';
assert.equal(await readFile(path.join(root, '.sl1-stack-owned'), 'utf8'), `astrid-app-sl1-stack-v1 ${root}`);
const fixture = JSON.parse(await readFile(manifestFile, 'utf8'));
const versions = JSON.parse(await readFile(path.join(root, 'results/versions.json'), 'utf8'));
const releaseCurrent = process.env.P77_RELEASE_CURRENT === '1';
assert.deepEqual(versions, releaseCurrent ? {
  app: 'e3dbad64d402724ac5a35fb6447f18e432c64b78',
  agent: '8807f820eb47d6018db723511e024a0a123fbe95',
  runtime: '3c28211f3cb7ac4867ad744d8cdeeb38dd4484c5',
} : {
  app: 'be9cc2407306eff06252c0d54be1c7f5afcacf3f',
  agent: '18adee8034973837a97fcd7392cd67f4566fa992',
  runtime: 'd7be2f0458a55c1f26e1138a125ffefe382f56f4',
});
assert.equal(fixture.media.synthetic, true);
assert.equal(fixture.measurement.clip_count, 300);
assert.equal(fixture.live_proof.restored_version, 30);
assert.equal(fixture.clips.video.primary.clip_id, 'fixture-video-0154');
assert.equal(fixture.clips.video.primary.track_id, 'V6');
assert.equal(fixture.clips.shot_occurrences.length, 10);
const expectedClips = expectedFixtureIds(fixture);
const expectedTracks = [...fixture.tracks.visual, ...fixture.tracks.audio].map(track => track.id).sort();
assert.equal(expectedClips.length, 300);
assert.equal(expectedTracks.length, 9);
const runtime = await runtimeRootForData(root, path.join(root, 'direct-data'), origin + '/api/runtime/v1/health');
const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], {encoding: 'utf8'}).trim());
assert(ticksPerSecond > 0);
const runtimeBeforeNav = async () => {
  const stat = parseStat(await readFile(`/proc/${runtime.pid}/stat`, 'utf8'));
  assert.equal(stat.start, runtime.start);
  return stat.cpu;
};
const profileRuntime = process.env.P77_PROFILE_RUNTIME === '1';
const longCurrentOpen = releaseCurrent && process.env.P77_CURRENT_LONG_OPEN === '1';
const writableBudgetMs = longCurrentOpen ? (profileRuntime ? 900000 : 600000) : 480000;
const sampleRate = longCurrentOpen ? 100 : 49;
let sampler;
let profileReceipt;
async function startRuntimeProfile() {
  await runtimeBeforeNav();
  const raw = resultFile + '.py-spy.raw';
  const log = resultFile + '.py-spy.log';
  const logFile = await open(log, 'wx', 0o600);
  const child = spawn(samplerBin, ['record', '--pid', String(runtime.pid), '--rate', String(sampleRate), '--nonblocking',
    '--full-filenames', '--format', 'raw', '--output', raw], {stdio: ['ignore', 'pipe', 'pipe']});
  let diagnostics = '';
  const receive = bytes => { if (diagnostics.length < 8192) diagnostics += bytes.toString(); };
  child.stdout.on('data', receive);
  child.stderr.on('data', receive);
  const done = new Promise(resolve => {
    child.once('error', () => resolve({code: null, signal: null, error: 'spawn'}));
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  sampler = {child, done, logFile, raw, diagnostics: () => diagnostics};
  for (let attempt = 0; attempt < 30; attempt++) {
    if (diagnostics.includes('Sampling process')) return;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Runtime sampler did not attach before opening');
}

async function stopRuntimeProfile() {
  if (!sampler) return;
  const {child, done, logFile, raw, diagnostics} = sampler;
  sampler = undefined;
  child.kill('SIGINT');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const completion = await done;
    const output = diagnostics();
    await logFile.writeFile(output);
    await logFile.sync();
    const counters = /Samples: (\d+) Errors: (\d+)/.exec(output);
    profileReceipt = {sampler: 'py-spy 0.4.1', runtime, rate_hz: sampleRate, nonblocking: true, raw,
      completion, samples: counters ? Number(counters[1]) : null, errors: counters ? Number(counters[2]) : null};
    assert(completion.code === 0 && profileReceipt.samples > 0, 'Runtime sampler did not produce active stacks');
  } finally {
    clearTimeout(timer);
    await logFile.close();
  }
}
const url = new URL('/tools/video-editor', origin);
url.search = new URLSearchParams({connect: '1', project: fixture.project_id, timeline: fixture.timeline_id});
const {chromium} = await import(pathToFileURL(playwrightPath));
const profile = await mkdtemp(path.join(tmpdir(), 'sl-p77-compiled-v30-'));
let context;
let shuttingDown = false;
const requests = [];
let started;
let navigationMs;
let firstUsableMs;
let metrics;
let pagePerformance;
let runtimeCpuSeconds;
let runtimeCpuStart;
let openingEvidence;
const dumpTimers = [];
const pendingDumps = [];
function inFlightRequests() {
  return requests.filter(entry => entry.finished_ms === undefined && entry.failed_ms === undefined).map(entry => ({...entry}));
}
function scheduleRuntimeDumps() {
  for (const seconds of [30, 120, 300]) {
    const timer = setTimeout(() => {
      pendingDumps.push((async () => {
        const prefix = resultFile + `.at-${seconds}s`;
        const sampledAt = performance.now() - started;
        let cpuTicks;
        let failure;
        try {
          cpuTicks = await runtimeBeforeNav();
          const {stdout} = await promisify(execFile)(samplerBin,
            ['dump', '--pid', String(runtime.pid), '--json', '--nonblocking', '--full-filenames'],
            {timeout: 8000, maxBuffer: 4 * 1024 * 1024});
          JSON.parse(stdout);
          await runtimeBeforeNav();
          await writeFile(prefix + '.stacks.json', stdout, {flag: 'wx', mode: 0o600});
        } catch (error) { failure = error.code ?? error.name; }
        await writeFile(prefix + '.json', JSON.stringify({
          sampled_at_ms: sampledAt, runtime, ticks_per_second: ticksPerSecond,
          runtime_cpu_ticks: cpuTicks, stack_failure: failure ?? null,
          requests_in_flight: inFlightRequests(),
        }, null, 2) + '\n', {flag: 'wx', mode: 0o600});
      })().catch(() => {}));
    }, seconds * 1000);
    dumpTimers.push(timer);
  }
}
async function captureOpeningBoundary() {
  if (!longCurrentOpen || started === undefined || openingEvidence) return;
  for (const timer of dumpTimers) clearTimeout(timer);
  const elapsed = performance.now() - started;
  const inFlight = inFlightRequests();
  const endTicks = await runtimeBeforeNav();
  openingEvidence = {
    boundary: firstUsableMs === undefined ? 'opening_stopped' : 'writable',
    elapsed_ms: elapsed, writable_budget_ms: writableBudgetMs,
    ticks_per_second: ticksPerSecond, runtime_cpu_ticks_at_navigation: runtimeCpuStart,
    runtime_cpu_ticks_at_boundary: endTicks,
    runtime_cpu_seconds_before_navigation_from_process_birth: runtimeCpuStart / ticksPerSecond,
    runtime_cpu_seconds_navigation_to_boundary: (endTicks - runtimeCpuStart) / ticksPerSecond,
    requests_in_flight: inFlight,
  };
}
let source = 'unobserved';
let terminalHead;
let terminalProofTransport;
let browserTerminalFailure;
let normalViewport;
let errorPhase;
let phase = 'browser_start';
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: chromeBin, headless: true, viewport: {width: 1700, height: 1500},
    args: ['--disable-gpu', '--disk-cache-size=1', '--media-cache-size=1', '--no-first-run'],
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.addInitScript(() => {
    const longTasks = [];
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) longTasks.push({start_ms: entry.startTime, duration_ms: entry.duration});
    }).observe({type: 'longtask', buffered: true});
    window.__astridCompiledV30LongTasks = longTasks;
  });
  const session = await context.newCDPSession(page);
  await session.send('Performance.enable');
  const entries = new Map();
  page.on('request', request => {
    if (started === undefined) return;
    const candidate = new URL(request.url());
    if (candidate.origin !== origin) return;
    const entry = {method: request.method(), kind: request.resourceType(), route: candidate.pathname, started_ms: performance.now() - started};
    if (longCurrentOpen && candidate.pathname.endsWith('/commits')) {
      entry.history_limit = candidate.searchParams.get('limit');
      entry.history_has_cursor = candidate.searchParams.has('cursor');
    }
    entries.set(request, entry);
    requests.push(entry);
  });
  page.on('response', response => {
    const entry = entries.get(response.request());
    if (entry) {
      entry.status = response.status();
      entry.headers_ms = performance.now() - started;
    }
  });
  page.on('requestfinished', request => {
    const entry = entries.get(request);
    if (entry) entry.finished_ms = performance.now() - started;
  });
  page.on('requestfailed', request => {
    const entry = entries.get(request);
    if (entry) entry.failed_ms = performance.now() - started;
  });
  if (profileRuntime) {
    phase = 'attach_runtime_sampler';
    await startRuntimeProfile();
  }
  runtimeCpuStart = await runtimeBeforeNav();
  phase = 'navigation';
  started = performance.now();
  if (longCurrentOpen && profileRuntime) scheduleRuntimeDumps();
  await page.goto(url.href, {waitUntil: 'domcontentloaded', timeout: 120000});
  navigationMs = performance.now() - started;
  phase = 'writable_editor';
  await page.waitForFunction(({project, timeline, ids, trackId, expectedTracks, clipId}) => {
    const current = new URL(location.href);
    if (current.searchParams.get('project') !== project || current.searchParams.get('timeline') !== timeline) return false;
    const rows = [...new Set([...document.querySelectorAll('[data-row-id]')].map(row => row.getAttribute('data-row-id')))].sort();
    const rootIds = new Set([...document.querySelectorAll('.clip-action[data-row-id][data-clip-id]')].map(clip => clip.dataset.clipId));
    const clip = document.querySelector(`.clip-action[data-clip-id="${CSS.escape(clipId)}"][data-row-id="${CSS.escape(trackId)}"]`);
    const input = document.querySelector(`[data-track-label][data-track-id="${CSS.escape(trackId)}"] input[aria-label="Track name"]`);
    return rows.join(',') === expectedTracks.join(',') && ids.every(id => rootIds.has(id)) &&
      clip?.getClientRects().length && clip.getAttribute('role') === 'button' && clip.tabIndex >= 0 && clip.getAttribute('aria-disabled') !== 'true' &&
      input && !input.disabled && !input.readOnly && input.getBoundingClientRect().width > 0;
  }, {project: fixture.project_id, timeline: fixture.timeline_id, ids: expectedClips,
    expectedTracks, clipId: fixture.clips.video.primary.clip_id, trackId: fixture.clips.video.primary.track_id},
    {timeout: longCurrentOpen ? Math.max(1, writableBudgetMs - Math.ceil(navigationMs)) : writableBudgetMs});
  firstUsableMs = performance.now() - started;
  runtimeCpuSeconds = ((await runtimeBeforeNav()) - runtimeCpuStart) / ticksPerSecond;
  await captureOpeningBoundary();
  if (profileRuntime) {
    phase = 'stop_runtime_sampler';
    await stopRuntimeProfile();
  }
  phase = 'bundle_identity';
  const scripts = requests.filter(entry => entry.kind === 'script' && entry.started_ms <= firstUsableMs);
  assert(scripts.some(entry => /^\/assets\/[^/]+\.js$/.test(entry.route) && entry.status === 200));
  assert(!scripts.some(entry => entry.route.startsWith('/src/') || entry.route.startsWith('/@vite/') || entry.route.startsWith('/node_modules/')));
  source = 'compiled local preview';
  const sample = await session.send('Performance.getMetrics');
  metrics = Object.fromEntries(sample.metrics.filter(({name}) => /(?:Duration|Count)$/.test(name)).map(({name, value}) => [name, value]));
  pagePerformance = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    return {dom_interactive_ms: navigation?.domInteractive, dom_content_loaded_ms: navigation?.domContentLoadedEventEnd,
      load_ms: navigation?.loadEventEnd, long_tasks: window.__astridCompiledV30LongTasks};
  });
  phase = 'persist_opening_marker';
  const marker = await open(resultFile + '.marker', 'wx', 0o600);
  try {
    await marker.writeFile(JSON.stringify({versions, source, first_usable_ms: firstUsableMs,
      runtime_cpu_seconds: runtimeCpuSeconds, scripts: scripts.length,
      navigation_observed_ms: navigationMs, terminal_public_head: 'pending'}) + '\n');
    await marker.sync();
  } finally { await marker.close(); }
  phase = 'terminal_public_head';
  let timer;
  try {
    const head = await Promise.race([publicSnapshot(page, origin, fixture),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('terminal verification deadline')), 90000); })]);
    assert(Array.isArray(head.payload.occurrences));
    const occurrenceIds = head.payload.occurrences.map(item => item.occurrence_id);
    terminalHead = {revision: head.headRevision, publication: head.publicationId, content_digest: head.content_digest,
      active_heads: head.headCount, clips: head.clipIds.length, occurrences: occurrenceIds.length};
    const pin = fixture.live_proof;
    assert.equal(head.headRevision, pin.restored_revision);
    assert.equal(head.publicationId, pin.restored_publication);
    assert.equal(head.content_digest, pin.restored_content_digest);
    assert(sameIds(head.clipIds, expectedClips));
    assert(sameIds(occurrenceIds, fixture.clips.shot_occurrences.map(item => item.occurrence_id)));
    terminalHead.verified = true;
    terminalProofTransport = 'browser';
  } finally { clearTimeout(timer); }
  if (process.env.P77_NORMAL_VIEWPORT === '1') {
    try {
      await page.setViewportSize({width: 1440, height: 900});
      await page.waitForFunction(() => innerWidth === 1440 && innerHeight === 900 &&
        Boolean(document.querySelector('.timeline-canvas-edit-area')), null, {timeout: 5000});
      normalViewport = await page.evaluate(({tracks, clipId}) => {
        const area = document.querySelector('.timeline-canvas-edit-area');
        const bounds = area.getBoundingClientRect();
        const viewportBottom = Math.min(bounds.bottom, innerHeight);
        const viewportTop = Math.max(bounds.top, 0);
        const rows = [...area.querySelectorAll('[data-row-id]:not([data-action-id]):not([data-clip-id])')]
          .filter(row => tracks.includes(row.dataset.rowId)).map(row => {
            const rect = row.getBoundingClientRect();
            const showing = Math.max(0, Math.min(rect.bottom, viewportBottom) - Math.max(rect.top, viewportTop));
            return {id: row.dataset.rowId, top: rect.top, height: rect.height, visible_height: showing};
          });
        const clip = document.querySelector(`.clip-action[data-clip-id="${CSS.escape(clipId)}"]`);
        const rect = clip?.getBoundingClientRect();
        return {viewport: [innerWidth, innerHeight], timeline_visible_height: viewportBottom - viewportTop,
          scroll_top: area.scrollTop, scroll_height: area.scrollHeight, rows,
          target_row: clip?.dataset.rowId ?? null, target_visible: Boolean(rect && rect.bottom > viewportTop && rect.top < viewportBottom)};
      }, {tracks: expectedTracks, clipId: fixture.clips.video.primary.clip_id});
    } catch { normalViewport = {state: 'unobserved'}; }
  }
  phase = 'no_commit_post';
  assert(!requests.some(entry => entry.method === 'POST' && entry.route.endsWith('/commit')));
} catch (error) {
  errorPhase = phase;
  process.exitCode = 1;
} finally {
  try { await captureOpeningBoundary(); } catch {
    errorPhase ??= 'opening_cpu_boundary';
    process.exitCode = 1;
  }
  await Promise.all(pendingDumps);
  try { await stopRuntimeProfile(); } catch {
    errorPhase ??= 'stop_runtime_sampler';
    process.exitCode = 1;
  }
  try {
    if (context) {
      await context.close();
      shuttingDown = true;
    }
  } catch {
    errorPhase ??= 'browser_close';
    process.exitCode = 1;
  } finally {
    await rm(profile, {recursive: true, force: true, maxRetries: 8, retryDelay: 100});
  }
  if (releaseCurrent && resultFile.endsWith('/release-current/compatibility/observed.json') &&
      errorPhase === 'terminal_public_head' && shuttingDown && firstUsableMs !== undefined) {
    browserTerminalFailure = errorPhase;
    const proofFile = path.join(root, 'results/terminal-public-postflight.json');
    const probe = fileURLToPath(new URL('./terminal-public-read.mjs', import.meta.url));
    try {
      execFileSync(process.execPath, [probe, root, manifestFile, proofFile], {timeout: 150000, stdio: 'ignore'});
      const proof = JSON.parse(await readFile(proofFile, 'utf8'));
      assert(proof.status === 'verified_original_head' && proof.after.active_heads === 1 &&
        proof.after.clips_match && proof.after.occurrences_match);
      assert.deepEqual(proof.runtime, runtime);
      assert(!requests.some(entry => entry.method === 'POST' && entry.route.endsWith('/commit')));
      terminalHead = {revision: proof.after.revision, publication: proof.after.publication,
        content_digest: proof.after.content_digest, active_heads: 1, clips: expectedClips.length,
        occurrences: fixture.clips.shot_occurrences.length, verified: true};
      terminalProofTransport = 'independent same-Runtime Node postflight after browser close';
      errorPhase = undefined;
      process.exitCode = 0;
    } catch { /* Retain the original browser proof failure. */ }
  }
  await writeFile(resultFile, JSON.stringify({fixture: {project_id: fixture.project_id, timeline_id: fixture.timeline_id, clips: 300, tracks: 9, shot_occurrences: 10}, versions, source, error_phase: errorPhase ?? null,
    runtime_process: runtime, runtime_profile: profileReceipt ?? null,
    ...(longCurrentOpen ? {opening_boundary: openingEvidence ?? null} : {}),
    runtime_cpu_seconds: runtimeCpuSeconds ?? null, terminal_public_head: terminalHead ?? null,
    terminal_proof_transport: terminalProofTransport ?? null, browser_terminal_failure: browserTerminalFailure ?? null,
    normal_viewport_after_timing: normalViewport ?? null,
    matched_timeline_commit_posts: requests.filter(entry => entry.method === 'POST' && entry.route.endsWith('/commit')).length,
    first_usable_ms: firstUsableMs, navigation_observed_ms: navigationMs, page_timing: pagePerformance, cdp_metrics: metrics,
    requests_before_usable: requests.filter(entry => firstUsableMs === undefined || entry.started_ms <= firstUsableMs),
    process_closed: shuttingDown, profile_removed: true,
    scope: 'Read-only local compiled preview. The timing covers navigation to the exact visible writable controls and full clip inventory. Public head verification is separate after the UI marker. Runtime CPU covers its owned host process; Chrome CDP durations overlap. No save or hosted-network figure.'}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
}

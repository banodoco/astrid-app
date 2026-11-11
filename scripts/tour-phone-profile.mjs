#!/usr/bin/env node
/**
 * node scripts/tour-phone-profile.mjs [--out test-results/tour-phone/<ts>] [--device iphone-15] [--cpu 4] [--dpr 2]
 *   [--base-url http://127.0.0.1:PORT] [--theme dark|light] [--idle 3000] [--until act2-compose|act3-land] [--watch 6000]
 *   [--net fast4g|slow4g] [--emulate reject-play,...] [--no-throttle] [--help]
 *
 * Profiles the first-run tour on an emulated phone (default iPhone 15 profile, motion ON, CDP CPU throttle 4x,
 * device pixel ratio 2 because this sandbox rasterises in software; --dpr 3 for the profile's own). Walks
 *   welcome -> OK -> compose (typing) -> Send -> respond (thinking, streaming, actions) -> Next -> act 1 land -> Next -> act 2 compose
 * and splits the walk into short phases (the first 800 ms of a transition, thinking, streaming, "until ready", and a fixed idle
 * window after each settled beat). Per phase it records:
 *   - frame cadence (rAF dt: count, p50/p95/max, frames > 33 ms and > 100 ms) and long tasks / Long Animation Frames with
 *     script attribution and the time spent in forced style/layout;
 *   - React commits (DevTools-hook probe: commits/s, summed render ms, top re-rendering components, where re-renders start);
 *   - DOM cost counters: getComputedStyle / getBoundingClientRect calls, rAF callbacks, timers, MutationObserver and
 *     ResizeObserver callbacks (the counts, not the time), per second;
 *   - CDP Performance deltas: task / script / layout / style-recalc seconds and counts;
 *   - WebGL contexts created so far (per frame) and live <canvas>/<iframe>/<video> counts.
 * With `--until act3-land` the walk goes on through step 2 (stills, gallery) to step 3's landing, and both video landings
 * (steps 1 and 3) get a picture proof: from the tap, when the poster showed, when the tour's <video> first presented a frame
 * while playing, and its `currentTime` / presented-frame count once a second for `--watch` ms. `--net fast4g|slow4g` throttles
 * the network (CDP), and `--emulate` forces a failure the tour must survive:
 *   reject-play (every play() rejects) · low-power (play() rejects unless inside a user gesture or on an element started in
 *   one) · no-webcodecs (no VideoDecoder/AudioDecoder) · audio-resume-pending (AudioContext.resume() never settles outside a
 *   gesture) · stall-video (mp4 requests never answer). Several may be joined with commas.
 * Output: report.json and report.md (+ a settled screenshot per beat). An idle tour beat should commit ~0 times per second.
 * Absolute timings are noisy in a shared 4-core software-GL sandbox: compare runs by the structural columns.
 * The dev server is Vite in test mode (unminified dev React renders several times slower than production).
 */
import { spawn } from 'node:child_process';
import { loadavg } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { buildFakeRuntimeEnv } from '../tests/e2e/fake-runtime/launch.mjs';
import { terminateProcessTree } from './terminate-process-tree.mjs';
import { DEVICE_PROFILES, chromiumExecutable, freePort, waitServer } from './tour-screenshots.mjs';

const STORE = '/src/shared/state/editorTourStore.ts';
const BEATS = '/src/tools/video-editor/tour/runner/tourBeats.ts';
const READY_CAP_MS = 45_000;

/* ------------------------------------------------------------------ in-page instrumentation (every frame) */
function installProbe() {
  const pp = (window.__pp = { on: false, t0: 0, c: {}, frames: [], loaf: [], longtasks: [], commits: [], gl: [], lastRaf: 0 });
  const bump = (k, n = 1) => { if (pp.on) pp.c[k] = (pp.c[k] ?? 0) + n; };
  const wrap = (obj, name, key) => { const orig = obj[name]; obj[name] = function (...a) { bump(key); return orig.apply(this, a); }; };
  wrap(window, 'getComputedStyle', 'getComputedStyle');
  wrap(Element.prototype, 'getBoundingClientRect', 'getBoundingClientRect');
  wrap(window, 'setTimeout', 'setTimeout');
  wrap(window, 'setInterval', 'setInterval');
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { bump('rafScheduled'); return raf((t) => { bump('rafRan'); cb(t); }); };
  const Mo = window.MutationObserver;
  window.MutationObserver = class extends Mo { constructor(cb) { super((r, o) => { bump('mutationCallbacks'); bump('mutationRecords', r.length); cb(r, o); }); } };
  const Ro = window.ResizeObserver;
  window.ResizeObserver = class extends Ro { constructor(cb) { super((e, o) => { bump('resizeCallbacks'); cb(e, o); }); } };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = getContext.call(this, type, ...rest);
    if (/webgl/.test(String(type)) && ctx) pp.gl.push({ t: Math.round(performance.now()), frame: location.pathname.slice(-40) || 'top', w: this.width, h: this.height, lost: false });
    return ctx;
  };
  const loop = (t) => {
    if (pp.on) { if (pp.lastRaf) pp.frames.push(t - pp.lastRaf); pp.lastRaf = t; } else pp.lastRaf = 0;
    raf(loop);
  };
  raf(loop);
  const entries = (type, fn) => { try { new PerformanceObserver((l) => l.getEntries().forEach((e) => pp.on && fn(e))).observe({ type, buffered: false }); } catch { /* unsupported */ } };
  entries('long-animation-frame', (e) => pp.loaf.push({
    d: Math.round(e.duration), blocking: Math.round(e.blockingDuration ?? 0), style: e.styleAndLayoutStart ? Math.round(e.startTime + e.duration - e.styleAndLayoutStart) : null,
    scripts: [...(e.scripts ?? [])].map((s) => ({ d: Math.round(s.duration), forced: Math.round(s.forcedStyleAndLayoutDuration ?? 0), inv: String(s.invoker ?? '').slice(0, 70), fn: s.sourceFunctionName || '', src: String(s.sourceURL ?? '').split('?')[0].split('/').slice(-2).join('/') })),
  }));
  entries('longtask', (e) => pp.longtasks.push(Math.round(e.duration)));
  const nameOf = (fiber) => { const t = fiber.type; return typeof t === 'function' ? t.displayName || t.name || null : t && typeof t === 'object' ? t.displayName || t.render?.displayName || t.render?.name || t.type?.name || null : null; };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(), supportsFiber: true, isDisabled: false,
    inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id; },
    checkDCE() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      if (!pp.on) return;
      const counts = {}, origins = {}, stack = [root.current];
      let n = 0;
      while (stack.length && n++ < 80000) {
        const f = stack.pop();
        if ((f.flags & 1) && f.alternate) {
          const name = nameOf(f);
          if (name) {
            counts[name] = (counts[name] ?? 0) + 1;
            let up = f.return;
            while (up && !nameOf(up)) up = up.return;
            if (!(up && (up.flags & 1))) {
              origins[name] = (origins[name] ?? 0) + 1;
              if (pp.why) {
                // Why this component rendered although its parent did not: changed props, a changed state/ref/memo hook, or context.
                const alt = f.alternate, reasons = [];
                if (alt.memoizedProps !== f.memoizedProps) reasons.push('props');
                let a = f.memoizedState, b = alt.memoizedState, i = 0;
                while (a && b && typeof a === 'object' && 'next' in a) {
                  const effect = a.memoizedState && typeof a.memoizedState === 'object' && ('create' in a.memoizedState || 'inst' in a.memoizedState);
                  if (!effect && !Object.is(a.memoizedState, b.memoizedState)) {
                    const v = a.memoizedState, p = b.memoizedState;
                    const brief = (x) => { try { return x && typeof x === 'object' ? (Array.isArray(x) ? `[${x.length}]` : `{${Object.keys(x).slice(0, 5)}}`) : typeof x === 'function' ? 'fn' : String(x).slice(0, 20); } catch { return '?'; } };
                    reasons.push(`hook${i}:${brief(p)}->${brief(v)}`);
                  }
                  a = a.next; b = b.next; i++;
                }
                if (f.dependencies?.firstContext) for (let c = f.dependencies.firstContext; c; c = c.next) { const ca = alt.dependencies?.firstContext; if (!ca || ca.memoizedValue !== c.memoizedValue) { reasons.push('context'); break; } }
                const key = `${name}: ${reasons.join(' | ') || 'parent-bailout?'}`;
                pp.whyCounts[key] = (pp.whyCounts[key] ?? 0) + 1;
              }
            }
          }
        }
        if (f.sibling) stack.push(f.sibling);
        // A fiber whose child list is the one it had last commit was bailed out: its subtree was not visited, and its
        // descendants still carry the PerformedWork flag of whenever they last rendered (counting those overstates renders).
        if (f.child && !(f.alternate && f.child === f.alternate.child)) stack.push(f.child);
      }
      if (pp.tree && pp.commits.length === 12 && !pp.treeOut) {
        const lines = [];
        const walk = (f, depth) => {
          for (let c = f; c; c = c.sibling) {
            const name = nameOf(c), did = (c.flags & 1) && c.alternate;
            if (name && did) { lines.push(`${'  '.repeat(depth)}${name}`); }
            if (c.child && !(c.alternate && c.child === c.alternate.child)) walk(c.child, name && did ? depth + 1 : depth);
          }
        };
        walk(root.current, 0);
        // The ancestor chain of the first origin named AppMainContent / TimeOfDaySky, with whether each rendered.
        const find = (f, wanted) => { for (let c = f; c; c = c.sibling) { if (nameOf(c) === wanted && c.alternate) return c; const r = c.child && find(c.child, wanted); if (r) return r; } return null; };
        for (const wanted of ['AppMainContent', 'TimeOfDaySky']) {
          const hit = find(root.current, wanted);
          if (hit) { const chain = []; for (let u = hit; u; u = u.return) chain.push(`${nameOf(u) ?? (typeof u.type === 'string' ? u.type : u.tag)}${(u.flags & 1) ? '*' : ''}`); lines.push(`chain ${wanted}: ${chain.join(' < ')}`); }
        }
        pp.treeOut = lines.join('\n');
      }
      pp.commits.push({ ms: root.current.actualDuration ?? 0, counts, origins });
    },
  };
  pp.whyCounts = {};
  pp.begin = () => { pp.treeOut = undefined; pp.whyCounts = {}; pp.c = {}; pp.frames = []; pp.loaf = []; pp.longtasks = []; pp.commits = []; pp.lastRaf = 0; pp.t0 = performance.now(); pp.on = true; };
  pp.end = () => {
    pp.on = false;
    const secs = Math.max(0.001, (performance.now() - pp.t0) / 1000);
    const sorted = [...pp.frames].sort((a, b) => a - b), q = (p) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]) : null;
    const totals = {}, origins = {};
    for (const c of pp.commits) { for (const [k, v] of Object.entries(c.counts)) totals[k] = (totals[k] ?? 0) + v; for (const [k, v] of Object.entries(c.origins)) origins[k] = (origins[k] ?? 0) + v; }
    const top = (o, k = 8) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, k);
    const byScript = {};
    let forced = 0;
    for (const l of pp.loaf) for (const s of l.scripts) { const key = `${s.src}${s.fn ? ` ${s.fn}` : ''}${s.inv ? ` [${s.inv}]` : ''}`; byScript[key] = (byScript[key] ?? 0) + s.d; forced += s.forced; }
    return {
      secs: Math.round(secs * 10) / 10,
      frames: { n: pp.frames.length, fps: Math.round(pp.frames.length / secs), p50: q(0.5), p95: q(0.95), max: q(0.999), over33: pp.frames.filter((d) => d > 33).length, over100: pp.frames.filter((d) => d > 100).length },
      longtasks: { n: pp.longtasks.length, totalMs: pp.longtasks.reduce((a, b) => a + b, 0), maxMs: Math.max(0, ...pp.longtasks) },
      loaf: { n: pp.loaf.length, totalMs: pp.loaf.reduce((a, l) => a + l.d, 0), maxMs: Math.max(0, ...pp.loaf.map((l) => l.d)), forcedLayoutMs: forced, styleLayoutMs: pp.loaf.reduce((a, l) => a + (l.style ?? 0), 0), topScripts: top(byScript, 5) },
      react: { commits: pp.commits.length, perSec: Math.round((pp.commits.length / secs) * 10) / 10, renderMs: Math.round(pp.commits.reduce((a, c) => a + c.ms, 0)), top: top(totals), origins: top(origins) },
      counters: Object.fromEntries(Object.entries(pp.c).map(([k, v]) => [k, Math.round(v / secs)])),
      glContexts: pp.gl.length,
      why: top(pp.whyCounts, 14),
      tree: pp.treeOut,
    };
  };
  pp.dom = () => ({
    canvases: document.querySelectorAll('canvas').length, iframes: document.querySelectorAll('iframe').length, videos: document.querySelectorAll('video').length,
    playingVideos: [...document.querySelectorAll('video')].filter((v) => !v.paused).length, nodes: document.getElementsByTagName('*').length,
    gl: pp.gl.length,
  });
}

/* ------------------------------------------------------------------ the tour picture: emulated failures + a sampler */
function installMediaProbe(emulate) {
  const E = new Set(emulate);
  let inGesture = false;
  for (const type of ['click', 'touchend', 'keydown']) addEventListener(type, (e) => { if (!e.isTrusted) return; inGesture = true; setTimeout(() => { inGesture = false; }, 0); }, true);
  if (E.has('no-webcodecs')) for (const k of ['VideoDecoder', 'AudioDecoder', 'EncodedVideoChunk']) { try { delete window[k]; } catch { /* ignore */ } window[k] = undefined; }
  if (E.has('audio-resume-pending') && window.AudioContext) {
    const unlocked = new WeakSet(), resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () { if (inGesture) unlocked.add(this); return unlocked.has(this) ? resume.call(this) : new Promise(() => {}); };
  }
  const mp = (window.__mp = { on: false, t0: 0, samples: [], frames: new WeakMap(), playCalls: 0, playRejected: 0 });
  if (E.has('reject-play') || E.has('low-power')) {
    const blessed = new WeakSet(), play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      mp.playCalls++;
      if (E.has('low-power') && (inGesture || blessed.has(this))) { blessed.add(this); return play.call(this); }
      mp.playRejected++;
      return Promise.reject(new DOMException('emulated autoplay refusal', 'NotAllowedError'));
    };
  }
  const tick = (t) => {
    if (mp.on) {
      const video = document.querySelector('video[data-editor-tour-video]') ?? document.querySelector('[data-editor-tour="preview"] video');
      if (video && !mp.frames.has(video) && video.requestVideoFrameCallback) {
        const counter = { n: 0 }; mp.frames.set(video, counter);
        const onFrame = () => { counter.n++; video.requestVideoFrameCallback(onFrame); };
        video.requestVideoFrameCallback(onFrame);
      }
      const picture = document.querySelector('[data-editor-tour-picture]');
      mp.samples.push({ t: Math.round(t - mp.t0), poster: Boolean(document.querySelector('[data-editor-tour-poster]')), state: picture ? `${picture.dataset.editorTourPicture}${picture.dataset.state ? `:${picture.dataset.state}` : ''}` : null,
        ct: video ? Math.round(video.currentTime * 100) / 100 : null, paused: video ? video.paused : null, ready: video ? video.readyState : null,
        presented: video ? (mp.frames.get(video)?.n ?? null) : null, decoded: video?.getVideoPlaybackQuality?.().totalVideoFrames ?? null, src: video ? video.currentSrc.split('/').pop().slice(0, 12) : null });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  mp.begin = () => { mp.samples = []; mp.t0 = performance.now(); mp.on = true; };
  mp.end = () => {
    mp.on = false;
    const S = mp.samples, first = (f) => S.find(f)?.t ?? null;
    const moving = S.find((x, i) => i > 0 && x.paused === false && x.ct > 0.03 && x.ct > S[i - 1].ct);
    const everySecond = [];
    for (let k = 0; k * 1000 <= (S.at(-1)?.t ?? 0); k++) { const x = S.find((y) => y.t >= k * 1000); if (x) everySecond.push([k, x.ct, x.presented, x.paused ? 'paused' : 'playing', x.state]); }
    const from = moving ?? S[0], last = S.at(-1);
    return { posterAtMs: first((x) => x.poster), posterGoneAtMs: S.some((x) => x.poster) ? (S.find((x, i) => !x.poster && S.slice(0, i).some((y) => y.poster))?.t ?? null) : null,
      firstMovingFrameAtMs: moving?.t ?? null, src: last?.src ?? null, end: last ? { state: last.state, poster: last.poster, currentTime: last.ct, paused: last.paused, readyState: last.ready, presentedFrames: last.presented, decodedFrames: last.decoded } : null,
      // Media seconds played per wall second after the first moving frame: 1 is real time.
      playbackRate: moving && last.t > from.t + 500 ? Math.round(((last.ct - from.ct) / ((last.t - from.t) / 1000)) * 100) / 100 : null,
      everySecond, playCalls: mp.playCalls, playRejected: mp.playRejected };
  };
}

function parseOptions(argv) {
  const o = { theme: 'dark', device: 'iphone-15', cpu: 4, dpr: 2, idle: 3000, until: 'act2-compose', watch: 6000, net: 'none', emulate: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help') o.help = true;
    else if (a === '--no-throttle') o.cpu = 1;
    else if (a === '--why') o.why = true;
    else if (a === '--cpuprof') o.cpuprof = true;
    else if (a === '--block-world') o['block-world'] = true;
    else if (a === '--tree') o.tree = true;
    else if (a.startsWith('--')) { const v = argv[++i]; o[a.slice(2)] = ['cpu', 'dpr', 'idle', 'watch'].includes(a.slice(2)) ? Number(v) : v; }
  }
  return o;
}

const fmtTop = (pairs) => pairs.map(([n, c]) => `${n} ${c}`).join(', ') || '-';

export async function run(options) {
  const profile = DEVICE_PROFILES[options.device];
  if (!profile) throw new Error(`Unknown device ${options.device}`);
  const out = resolve(options.out ?? `test-results/tour-phone/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  if (relative(process.cwd(), out).startsWith('..')) throw new Error('--out must be inside this worktree');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const privateDir = join(out, '.server');
  await mkdir(privateDir, { mode: 0o700 });
  const children = [];
  let browser;
  const report = { device: options.device, cpu: options.cpu, dpr: options.dpr, theme: options.theme, phases: [], notes: [], scene: {} };
  const spawnOwned = (args, env) => { const c = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: 'ignore', detached: true }); children.push(c); return c; };
  try {
    const token = 'tour-phone-fake-runtime-only', tokenFile = join(privateDir, 'token');
    await writeFile(tokenFile, token, { mode: 0o600 });
    const runtimePort = await freePort();
    const fakeEnv = buildFakeRuntimeEnv({ port: runtimePort, tokenFile, token });
    const runtime = spawnOwned(['tests/e2e/fake-runtime/launch.mjs', '--serve'], fakeEnv);
    const runtimeOrigin = `http://127.0.0.1:${runtimePort}`;
    await waitServer(`${runtimeOrigin}/runtime-config/v1/workspace.json`, runtime, () => false);
    const baseUrl = options['base-url'] ?? `http://127.0.0.1:${await freePort()}`;
    if (!options['base-url']) {
      const boot = "import { createServer } from 'vite'; const server = await createServer(JSON.parse(process.argv[1])); await server.listen();";
      const vite = spawnOwned(['--input-type=module', '--eval', boot, JSON.stringify({ configFile: 'config/vite/vite.config.ts', mode: 'test', cacheDir: join(privateDir, 'vite-cache'), server: { host: '127.0.0.1', port: Number(new URL(baseUrl).port), strictPort: true } })], { ...fakeEnv, VITE_RUNTIME_ORIGIN: baseUrl, VITE_WORKSPACE_RUNTIME_EXPECTED_ACTOR_ID: '', VITE_WORKSPACE_RUNTIME_EXPECTED_REALM_ID: '', VITE_WORKSPACE_RUNTIME_EXPECTED_INSTANCE_ID: '' });
      await waitServer(baseUrl, vite, () => false);
    } else await waitServer(baseUrl, null, () => false, 10_000);
    report.baseUrl = baseUrl;

    browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable(), args: ['--no-sandbox'] });
    report.browser = browser.version();
    const context = await browser.newContext({ ...profile, deviceScaleFactor: options.dpr, locale: 'en-US', timezoneId: 'UTC', colorScheme: options.theme, reducedMotion: 'no-preference', serviceWorkers: 'block' });
    await context.addInitScript(({ theme }) => { try { localStorage.setItem('theme-hour', theme === 'dark' ? '0' : '12'); } catch { /* ignore */ } }, { theme: options.theme });
    await context.addInitScript(installProbe);
    const emulate = String(options.emulate ?? '').split(',').filter(Boolean);
    await context.addInitScript(installMediaProbe, emulate);
    report.emulate = emulate; report.net = options.net; report.picture = {};
    if (options.tree) await context.addInitScript(() => { window.__pp.tree = true; });
    if (options.why) await context.addInitScript(() => { window.__pp.why = true; });
    await fetch(`${runtimeOrigin}/__test/reset`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: 'empty' }) });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    await context.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (/^\/api\/(runtime|astrid)(\/|$)/.test(url.pathname) || url.pathname === '/runtime-config/v1/workspace.json') {
        try {
          if (/\/health(?:z)?\/?$/.test(url.pathname)) return await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' });
          const path = url.pathname.replace(/^\/api\/(runtime|astrid)/, '') || '/';
          const res = await fetch(`${runtimeOrigin}${path}${url.search}`, { method: request.method(), headers: { Authorization: `Bearer ${token}`, 'Content-Type': request.headers()['content-type'] ?? 'application/json' }, body: request.postDataBuffer() ?? undefined, signal: AbortSignal.timeout(10_000) });
          await route.fulfill({ status: res.status, contentType: res.headers.get('content-type') ?? 'application/json', body: Buffer.from(await res.arrayBuffer()) });
        } catch { await route.abort().catch(() => {}); }
      } else if (options['block-world'] && /ca975b68e035d6af3aa6b828cd49acb2c99ab4bc66a0aaa83dbab8913b14c35e/.test(url.pathname)) await route.abort('blockedbyclient');
      else if (url.origin === baseUrl && !url.pathname.startsWith('/api/')) await route.continue();
      else await route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    const browserErrors = (report.browserErrors = []);
    page.on('pageerror', (e) => browserErrors.push(`pageerror: ${e.message}`.slice(0, 300)));
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && browserErrors.length < 40 && /webgl|context|gpu|memory/i.test(m.text())) browserErrors.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
    page.setDefaultTimeout(30_000);
    // Proof that the tour never loads the 3D world: every request that looks like it, and every frame that is not the page.
    const worldRequests = (report.worldRequests = []);
    const mediaRequests = (report.mediaRequests = []);
    page.on('request', (r) => {
      const u = r.url();
      if (/ca975b68e035|threejs-live-editor|SceneSurface|\/three(\.|\/|-)|node_modules\/(\.vite\/deps\/)?three/i.test(u)) worldRequests.push(u.replace(/^https?:\/\/[^/]+/, '').slice(0, 140));
      if (/\/astrid\/onboarding\//.test(u)) mediaRequests.push(`${Math.round(performance.now?.() ?? 0)} ${u.replace(/^https?:\/\/[^/]+/, '').slice(-60)}`);
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    if (options.cpuprof) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); }
    if (options.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.cpu });
    const NETWORKS = { fast4g: [165, 9], slow4g: [400, 1.6] };
    if (NETWORKS[options.net]) { await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: NETWORKS[options.net][0], downloadThroughput: NETWORKS[options.net][1] * 1024 * 1024 / 8, uploadThroughput: 1.5 * 1024 * 1024 / 8 }); }
    // A request that never answers: the worst network for a landing.
    if (emulate.includes('stall-video')) await context.route('**/*.mp4', () => {});
    await page.goto(`${baseUrl}/tools/video-editor`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await page.waitForFunction(() => document.querySelector('[data-editor-tour-card]'), null, { timeout: 180_000 });
    await page.evaluate(async ({ store, beats }) => {
      window.__ts = await import(/* @vite-ignore */ store);
      window.__tb = await import(/* @vite-ignore */ beats);
    }, { store: STORE, beats: BEATS });

    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const state = () => page.evaluate(() => { const s = window.__ts.getEditorTourState(); return { act: s.act, beat: s.beat, shown: s.shownBeat, ready: s.ready, sent: s.sent, status: s.status, beatReady: window.__tb.isEditorTourBeatReady(s) }; });
    const sceneProbe = () => page.evaluate(() => {
      const preview = document.querySelector('[data-editor-tour="preview"]');
      const r = preview?.getBoundingClientRect();
      return {
        previewBox: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
        previewVisible: preview ? Boolean(preview.offsetParent) && (r.width > 0 && r.height > 0) : false,
        liveSceneEntries: document.querySelectorAll('[data-testid="astrid-live-scene-entry"]').length,
        iframes: document.querySelectorAll('iframe').length,
        previewVideos: [...(preview?.querySelectorAll('video') ?? [])].map((v) => ({ src: v.currentSrc.slice(-24), paused: v.paused, t: Math.round(v.currentTime * 10) / 10, ready: v.readyState })),
        poster: Boolean(document.querySelector('[data-editor-tour-poster]')),
        status: [...document.querySelectorAll('[role="status"],[role="alert"]')].map((e) => e.textContent?.slice(0, 100)),
        dom: window.__pp.dom(),
      };
    });

    /** Records one window of the walk. */
    let prev = await metrics();
    const record = async (name, fn) => {
      const m0 = await metrics();
      const load0 = loadavg()[0];
      if (options.cpuprof) await cdp.send('Profiler.start');
      await page.evaluate(() => window.__pp.begin());
      const t0 = Date.now();
      await fn();
      const wall = Date.now() - t0;
      let top = null;
      if (options.cpuprof) {
        const { profile } = await cdp.send('Profiler.stop');
        const self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n]));
        profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
        const agg = new Map();
        for (const [id, us] of self) {
          const f = byId.get(id).callFrame;
          const key = `${f.functionName || '(anon)'} ${String(f.url).split('?')[0].split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
          agg.set(key, (agg.get(key) ?? 0) + us);
        }
        top = [...agg].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, us]) => [k, Math.round(us / 1000)]);
      }
      const inPage = await page.evaluate(() => { const r = window.__pp.end(); r.dbg = window.__dbg; window.__dbg = 0; return r; });
      const m1 = await metrics();
      const d = (k) => Math.round((m1[k] - m0[k]) * (k.endsWith('Duration') ? 1000 : 1));
      const phase = { name, wallMs: wall, cpuTop: top, load: Math.round(loadavg()[0] * 10) / 10, ...inPage,
        cdp: { taskMs: d('TaskDuration'), scriptMs: d('ScriptDuration'), layoutMs: d('LayoutDuration'), styleMs: d('RecalcStyleDuration'), layouts: d('LayoutCount'), styleRecalcs: d('RecalcStyleCount'), nodes: Math.round(m1.Nodes), heapMB: Math.round(m1.JSHeapUsedSize / 1e6), jsListeners: Math.round(m1.JSEventListeners) } };
      void load0; prev = m1;
      report.phases.push(phase);
      console.log(`${name.padEnd(34)} fps ${String(phase.frames.fps).padStart(3)} p95 ${String(phase.frames.p95).padStart(4)}ms  commits/s ${String(phase.react.perSec).padStart(5)}  long ${String(phase.longtasks.n).padStart(3)} (${phase.longtasks.totalMs}ms)  task ${phase.cdp.taskMs}ms/${Math.round(wall)}ms`);
      return phase;
    };
    const waitReady = async (id, cap = READY_CAP_MS) => {
      const start = Date.now();
      for (;;) {
        const s = await state();
        if (s.status === 'running' && s.beat === id.beat && s.act === id.act && s.shown === id.beat && s.beatReady) return Date.now() - start;
        if (Date.now() - start > cap) return null;
        await delay(100);
      }
    };
    const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) }).catch(() => {});
    const tap = async (locator) => { try { await locator.tap({ timeout: 10_000 }); } catch { await locator.click({ timeout: 5000, force: true }); } };
    const cardButton = () => page.locator('[data-editor-tour-card] section').getByRole('button').last();

    /** A transition: tap, then windows [0,800] + [800,end-of-minimum] + [..., ready]. */
    const transition = async (label, control, dest, windows) => {
      await page.evaluate(() => window.__pp.begin()); await page.evaluate(() => window.__pp.end());
      const tapAt = Date.now();
      let first = true;
      let readyMs = null;
      for (const [wname, until] of windows) {
        await record(`${label}: ${wname}`, async () => {
          if (first) { first = false; await tap(control()); }
          if (until === 'ready') readyMs = (await waitReady(dest)) ?? -1;
          else { const left = until - (Date.now() - tapAt); if (left > 0) await delay(left); }
        });
      }
      if (readyMs === -1) report.notes.push(`${label}: beat ${dest.act}-${dest.beat} NOT ready after ${READY_CAP_MS / 1000}s (store: ${JSON.stringify(await state())})`);
      report.phases.at(-1).readyAfterTapMs = Date.now() - tapAt;
    };
    const idle = async (label) => {
      const phase = await record(`${label}: idle ${options.idle / 1000}s`, async () => { await delay(options.idle - 200); });
      // What is still animating on an idle beat (running CSS animations/transitions keep the compositor and main thread producing frames).
      phase.animations = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').map((a) => {
        const t = a.effect?.target; const cls = (t?.getAttribute?.('class') ?? '').split(/\s+/).filter((c) => /animate|spin|pulse|blur|backdrop|transition/.test(c)).join('.');
        return `${a.animationName ?? a.transitionProperty ?? a.constructor.name} on ${t?.tagName?.toLowerCase()}${cls ? `.${cls}` : ''}${t?.id ? `#${t.id}` : ''}${t?.dataset?.editorTour ? `[${t.dataset.editorTour}]` : ''} (${a.effect?.getTiming?.().iterations === Infinity ? 'infinite' : 'finite'})`;
      }));
      phase.layers = await page.evaluate(() => ({ fixedOrWillChange: [...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return s.willChange !== 'auto' || s.backdropFilter !== 'none' || s.filter !== 'none'; }).slice(0, 12).map((e) => `${e.tagName.toLowerCase()}.${(e.getAttribute('class') ?? '').slice(0, 50)} wc=${getComputedStyle(e).willChange} bf=${getComputedStyle(e).backdropFilter !== 'none'} f=${getComputedStyle(e).filter !== 'none'}`) }));
      return phase;
    };

    // ---- welcome
    const welcome = { act: 1, beat: 'welcome' };
    await waitReady(welcome);
    await delay(1000);
    await idle('welcome');
    await shot('01-welcome');
    // ---- OK -> compose (typing)
    const compose1 = { act: 1, beat: 'compose' };
    await transition('OK->compose', cardButton, compose1, [['card move 0-800ms', 800], ['typing until done', 'ready']]);
    await shot('02-compose');
    await idle('compose1');
    // ---- Send -> respond
    const respond1 = { act: 1, beat: 'respond' };
    await transition('Send->respond', () => page.locator('[data-editor-tour="chat-send"]'), respond1, [['0-800ms', 800], ['thinking 0.8-2.6s', 2600], ['streaming+actions', 'ready']]);
    await shot('03-respond');
    await idle('respond1');
    if (options.until === "act1-respond") return await finish();
    // ---- Next -> act 1 land (scene)
    const land1 = { act: 1, beat: 'land' };
    /** A video landing with its picture proof: sampled from the tap, through ready, for `--watch` ms in all. */
    const videoLanding = async (key, label, control, dest) => {
      await page.evaluate(() => window.__mp.begin());
      const started = Date.now();
      await transition(label, control, dest, [['0-800ms', 800], ['picture until ready', 'ready']]);
      const left = options.watch - (Date.now() - started);
      if (left > 0) await delay(left);
      report.picture[key] = { ...(await page.evaluate(() => window.__mp.end())), readyAfterTapMs: report.phases.at(-1).readyAfterTapMs };
      const p = report.picture[key];
      console.log(`  picture ${key}: poster@${p.posterAtMs}ms, first moving frame@${p.firstMovingFrameAtMs}ms, rate ${p.playbackRate}, end ${JSON.stringify(p.end)}`);
    };
    await videoLanding('step1', 'Next->land1', cardButton, land1);
    report.scene.afterLand1 = await sceneProbe();
    await shot('04-land1');
    await idle('land1 (playing)');
    report.scene.afterLand1Idle = await sceneProbe();
    // ---- Next -> act 2 compose
    const compose2 = { act: 2, beat: 'compose' };
    await transition('Next->compose2', cardButton, compose2, [['0-800ms', 800], ['typing until done', 'ready']]);
    await shot('05-compose2');
    await idle('compose2');
    if (options.until === 'act3-land') {
      const send = () => page.locator('[data-editor-tour="chat-send"]');
      await transition('Send->land2', send, { act: 2, beat: 'land' }, [['0-800ms', 800], ['stills walk until ready', 'ready']]);
      await shot('06-land2');
      await idle('land2');
      await transition('Next->gallery', cardButton, { act: 2, beat: 'gallery' }, [['0-800ms', 800], ['until ready', 'ready']]);
      await shot('07-gallery');
      await idle('gallery');
      await transition('Next->compose3', cardButton, { act: 3, beat: 'compose' }, [['0-800ms', 800], ['typing until done', 'ready']]);
      await idle('compose3');
      await videoLanding('step3', 'Send->land3', send, { act: 3, beat: 'land' });
      await shot('08-land3');
      await idle('land3 (playing under the card)');
      report.picture.step3AfterIdle = await page.evaluate(() => { const v = document.querySelector('video[data-editor-tour-video]'); return v ? { currentTime: Math.round(v.currentTime * 100) / 100, paused: v.paused, ended: v.ended } : null; });
    }
    report.browserErrors = browserErrors;
    report.glContextsTop = await page.evaluate(() => window.__pp.gl.length);
    report.iframesAtEnd = await page.evaluate(() => document.querySelectorAll('iframe').length);
    return await finish();

    async function finish() {
      report.finalState = await state();
      return { out, report, failed: false };
    }
  } finally {
    await browser?.close();
    await Promise.all(children.map(async (child) => { if (child.pid) await terminateProcessTree(child).catch(() => {}); }));
    await rm(privateDir, { recursive: true, force: true });
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(out, 'report.md'), renderMarkdown(report));
    console.log(join(out, 'report.md'));
  }
}

function renderMarkdown(r) {
  const L = [`# Tour phone profile: ${r.device}, CPU ${r.cpu}x, DPR ${r.dpr}, motion on (${r.browser})`, '',
    '| phase | wall ms | fps | p95/max frame ms | >33 / >100ms frames | long tasks (n / total ms / max) | LoAF (n / ms / forced layout ms) | commits/s (render ms) | gcs/s | gbcr/s | rAF cb/s | MO cb/s | RO cb/s | task / script / layout / style ms | layouts / recalcs |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const p of r.phases) {
    const c = p.counters;
    L.push(`| ${p.name} | ${p.wallMs} | ${p.frames.fps} | ${p.frames.p95}/${p.frames.max} | ${p.frames.over33}/${p.frames.over100} | ${p.longtasks.n} / ${p.longtasks.totalMs} / ${p.longtasks.maxMs} | ${p.loaf.n} / ${p.loaf.totalMs} / ${p.loaf.forcedLayoutMs} | ${p.react.perSec} (${p.react.renderMs}) | ${c.getComputedStyle ?? 0} | ${c.getBoundingClientRect ?? 0} | ${c.rafRan ?? 0} | ${c.mutationCallbacks ?? 0} | ${c.resizeCallbacks ?? 0} | ${p.cdp.taskMs} / ${p.cdp.scriptMs} / ${p.cdp.layoutMs} / ${p.cdp.styleMs} | ${p.cdp.layouts} / ${p.cdp.styleRecalcs} |`);
  }
  L.push('', '## Per phase detail', '');
  for (const p of r.phases) {
    L.push(`### ${p.name}`, `- React: ${p.react.commits} commits; re-rendered: ${fmtTop(p.react.top)}; re-renders start in: ${fmtTop(p.react.origins)}`,
      ...(p.tree ? ['- sample commit tree:', '```', p.tree.split('\n').slice(0, 120).join('\n'), '```'] : []),
      ...(p.why?.length ? [`- why origins re-rendered: ${p.why.map(([n, c]) => `${n} x${c}`).join('; ')}`] : []),
      `- LoAF top scripts (ms): ${p.loaf.topScripts.map(([n, ms]) => `${ms} ${n}`).join('; ') || '-'}`,
      ...(p.cpuTop ? [`- CPU self time (ms): ${p.cpuTop.map(([k, ms]) => `${ms} ${k}`).join('; ')}`] : []),
      ...(p.animations ? [`- running animations: ${p.animations.join('; ') || 'none'}`, `- will-change/backdrop/filter elements: ${p.layers?.fixedOrWillChange?.join('; ') || 'none'}`] : []),
      `- timers/s: setTimeout ${p.counters.setTimeout ?? 0}, setInterval ${p.counters.setInterval ?? 0}; heap ${p.cdp.heapMB}MB; DOM nodes ${p.cdp.nodes}; WebGL contexts so far ${p.glContexts}; ready after tap ${p.readyAfterTapMs ?? '-'}ms`, '');
  }
  L.push('## The tour picture (video landings)', '', `Network: ${r.net ?? 'none'}; emulated failures: ${r.emulate?.length ? r.emulate.join(', ') : 'none'}.`, '',
    '| landing | file | poster shown (ms after tap) | first moving frame (ms after tap) | ready after tap (ms) | playback rate | end: state / currentTime / presented frames | play() calls / rejected |', '|---|---|---|---|---|---|---|---|');
  for (const key of ['step1', 'step3']) {
    const p = r.picture?.[key];
    if (p) L.push(`| ${key} | ${p.src} | ${p.posterAtMs ?? '-'} | ${p.firstMovingFrameAtMs ?? 'never'} | ${p.readyAfterTapMs ?? '-'} | ${p.playbackRate ?? '-'} | ${p.end?.state} / ${p.end?.currentTime} / ${p.end?.presentedFrames} | ${p.playCalls} / ${p.playRejected} |`);
  }
  for (const key of ['step1', 'step3']) {
    const p = r.picture?.[key];
    if (p) L.push('', `${key}, once a second (s, currentTime, presented frames, state): ${p.everySecond.map((e) => `[${e.join(', ')}]`).join(' ')}`);
  }
  if (r.picture?.step3AfterIdle) L.push('', `step 3 after its explainer has been up for the idle window: ${JSON.stringify(r.picture.step3AfterIdle)}`);
  L.push('');
  L.push('## World / media proof', '', `- requests that look like the world or Three.js code: ${r.worldRequests?.length ? r.worldRequests.join(', ') : 'none'}`, `- WebGL contexts created in the page: ${r.glContextsTop}; iframes at end: ${r.iframesAtEnd}`, `- onboarding media requests: ${(r.mediaRequests ?? []).length}`, '', '## Scene (act 1 land)', '', '```json', JSON.stringify(r.scene, null, 1), '```', '', '## Notes', '', ...(r.notes.length ? r.notes.map((n) => `- ${n}`) : ['- none']), '', '## GL/console messages', '', ...(r.browserErrors?.length ? r.browserErrors.map((n) => `- ${n}`) : ['- none']));
  return `${L.join('\n')}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) console.log(`usage: node scripts/tour-phone-profile.mjs [--out dir] [--device iphone-15|iphone-se|pixel-7] [--cpu 4] [--dpr 2] [--idle 3000] [--until act1-respond|act2-compose|act3-land] [--watch 6000] [--net fast4g|slow4g] [--emulate reject-play,low-power,no-webcodecs,audio-resume-pending,stall-video] [--no-throttle] [--base-url url]`);
  else run(options).catch((e) => { console.error(e.stack ?? e.message); process.exitCode = 1; });
}

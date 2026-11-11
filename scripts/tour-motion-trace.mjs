#!/usr/bin/env node
/**
 * node scripts/tour-motion-trace.mjs [--out test-results/tour-motion/<ts>] [--theme dark|light]
 *   [--base-url http://127.0.0.1:PORT] [--transitions act1-welcome→act1-compose,...] [--back] [--no-screencast]
 *   [--viewport 1440x900] [--help]
 *
 * Measures MOTION of the first-run tour on desktop (1440x900 unless --viewport, reducedMotion: no-preference). The sibling
 * tour-screenshots.mjs only takes settled stills with motion off; this walks the same beats with motion on and,
 * for each transition (settled beat N -> settled beat N+1), records:
 *   - an in-page requestAnimationFrame sampler (performance.now clock) of the card host/section, every spotlight
 *     cutout + ring, the beat's target elements, the store state and "Preview unavailable" text;
 *   - real pixels via CDP Page.startScreencast, written as frames/NNNN.jpg plus two ffmpeg contact sheets;
 *   - metrics + plain-language "suspects" (report.json / report.md). Jank is reported, never an exit code:
 *     the process exits non-zero only when the walk itself fails.
 * --no-screencast skips the CDP screencast (no frames/filmstrips) to see how much it costs the frame rate.
 * --back also traces: respond -> land -> Back as early as possible (before the beat is ready), and Back from every
 * settled land beat (plus the forward "return"). --transitions filters which traces are written; the walk still
 * visits every beat. Same launch machinery as tour-screenshots.mjs (isolated fake runtime, owned Vite in test mode).
 *
 * The summary table per transition is the motion contract: the card host moves in exactly one segment (two on desktop's
 * respond, its two phases), never changes destination mid-flight or reverses, cutouts start within a frame of the card,
 * no lit cutout passes through the page corner (0,0,0,0), and the new step's content is only whole near rest.
 *
 * Trust notes: screencast frames are sparse/irregular (Chrome only emits on visual change, and the screencast itself
 * costs a little time); the rAF samples are the precise record. Dates are NOT frozen here (a frozen clock would stall
 * time-based animation); Math.random is seeded.
 */
import { spawn } from 'node:child_process';
import { loadavg, cpus } from 'node:os';
import { mkdir, rm, writeFile, readFile, copyFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { buildFakeRuntimeEnv } from '../tests/e2e/fake-runtime/launch.mjs';
import { terminateProcessTree } from './terminate-process-tree.mjs';
import { readTourSteps } from './tour-shot-metadata.mjs';
import { chromiumExecutable, freePort, waitServer } from './tour-screenshots.mjs';

const STORE = '/src/shared/state/editorTourStore.ts';
const BEATS = '/src/tools/video-editor/tour/runner/tourBeats.ts';
const SETTLE_QUIET_MS = 500; // geometry unchanged this long
const CAP_MS = 90_000;
const NUDGE_MS = 25_000; // a beat still not ready after this gets one user-style Next (skip animation) // per-transition cap
const SPOT_PADDING = 6; // useSpotlightRects PADDING: cutouts are the target rect outset by this (then clipped)
const EPS = 0.5; // px per frame below which something counts as still
const STILL_GAP = 3; // still frames that split two motion segments
const FILM = { cols: 6, rows: 5, tile: 320, denseStep: 50 };

/* ------------------------------------------------------------------ in-page sampler (runs in the browser) */
function installSampler() {
  const r4 = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
  const px = (v) => parseFloat(v);
  const tm = (window.__tm = { samples: [], clicks: [], targets: [], lastChange: performance.now(), sig: '' });
  document.addEventListener('click', (e) => tm.clicks.push({ t: performance.now(), text: (e.target.closest?.('button')?.textContent ?? '').trim() }), true);
  const geometry = (el) => {
    // SVG <rect> x/y/width/height are CSS geometry properties here, so the CSS transition animates the *computed
    // style*; the attribute is just the destination. `c` = getComputedStyle (in flight), `a` = attribute (target),
    // `b` = getBBox. The run's report notes which of them actually moved during a transition.
    const s = getComputedStyle(el), bb = el.getBBox();
    // `o`: how open the cutout is (fill-opacity of a hole, stroke-opacity of a ring); a slot at 0 is closed and invisible.
    const o = el.hasAttribute('data-editor-tour-ring') ? Number(s.strokeOpacity) : Number(s.fillOpacity);
    return { a: ['x', 'y', 'width', 'height'].map((n) => Number(el.getAttribute(n))), c: [px(s.x), px(s.y), px(s.width), px(s.height)], b: [bb.x, bb.y, bb.width, bb.height], o };
  };
  const sample = () => {
    const t = performance.now(), host = document.querySelector('[data-editor-tour-card-host]');
    const card = document.querySelector('[data-editor-tour-card]'), section = card?.querySelector('section');
    const content = section?.querySelector('[data-editor-tour-card-content]');
    const state = window.__tourShotsStore?.getEditorTourState();
    const tg = {};
    for (const sel of tm.targets) tg[sel] = r4(document.querySelector(sel));
    const s = {
      t, host: r4(host), tf: host?.style.transform ?? null, tr: host?.style.transition ?? null, sec: r4(section), op: section ? Number(getComputedStyle(section).opacity) : null,
      // What the card's content shows, and how visible it is (content wrapper opacity x section opacity).
      cop: section ? Number(getComputedStyle(section).opacity) * (content ? Number(getComputedStyle(content).opacity) : 1) : null,
      card: card?.getAttribute('data-editor-tour-card') ?? null, phase: card?.getAttribute('data-editor-tour-card-phase') ?? null,
      cardSettled: card?.hasAttribute('data-settled') ?? false, arrived: card ? !card.hasAttribute('data-editor-tour-card-phase') && (card.hasAttribute('data-arrived') || !document.querySelector('[data-editor-tour-card-content]')) : false,
      st: state && { status: state.status, act: state.act, beat: state.beat, shownBeat: state.shownBeat, ready: state.ready, instant: state.instant },
      beatReady: Boolean(state && window.__tourShotsBeats.isEditorTourBeatReady(state)),
      cut: [...document.querySelectorAll('#editor-tour-dim rect[fill="black"]')].map(geometry),
      ring: [...document.querySelectorAll('[data-editor-tour-ring]')].map(geometry),
      tg, pu: Boolean(document.querySelector('[data-editor-tour="preview"]')?.textContent?.includes('Preview unavailable')),
    };
    const sig = JSON.stringify([s.host, s.cut.map((g) => g.c), tg]).replace(/-?\d+\.\d+/g, (n) => Math.round(Number(n) * 2) / 2);
    if (sig !== tm.sig) { tm.sig = sig; tm.lastChange = t; }
    tm.samples.push(s);
    if (tm.samples.length > 20000) tm.samples.splice(0, 5000);
  };
  // Long animation frames (> 120 ms) with what ran in them: the scripts that took longest, and how long style/layout and
  // rendering took. This is what says WHY a transition stalled.
  tm.loaf = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration <= 120) continue;
        const end = e.startTime + e.duration;
        tm.loaf.push({
          t: e.startTime, d: Math.round(e.duration),
          scripts: [...(e.scripts ?? [])].sort((a, b) => b.duration - a.duration).slice(0, 4).map((x) => ({ d: Math.round(x.duration), invoker: String(x.invoker ?? '').slice(0, 80), src: String(x.sourceURL ?? '').split('?')[0].split('/').slice(-2).join('/'), fn: x.sourceFunctionName || '' })),
          styleLayoutMs: e.styleAndLayoutStart ? Math.round(end - e.styleAndLayoutStart) : null,
          renderMs: e.renderStart ? Math.round(end - e.renderStart) : null,
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch { /* no Long Animation Frames API */ }
  const loop = () => { try { sample(); } catch { /* DOM mid-swap */ } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  tm.isSettled = ({ act, beat }) => {
    const last = tm.samples.at(-1);
    // The browser tour ends (status idle, card gone) when the finale's primary is pressed; treat that as the settled end state.
    if (last?.st && last.st.status !== 'running' && last.st.act === act && last.st.beat === beat) return performance.now() - tm.lastChange >= 500;
    return Boolean(last?.st && last.st.status === 'running' && last.st.act === act && last.st.beat === beat && last.st.shownBeat === beat
      && last.beatReady && last.card === beat && last.arrived && last.cardSettled && performance.now() - tm.lastChange >= 500);
  };
  tm.updateNotice = () => {
    const cuts = [...document.querySelectorAll('#editor-tour-dim rect[fill="black"]')].map((g) => ['x', 'y', 'width', 'height'].map((n) => Number(g.getAttribute(n))));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const found = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue.includes('Update available')) continue;
      const el = node.parentElement, b = el.getBoundingClientRect();
      if (!b.width || !b.height || getComputedStyle(el).visibility === 'hidden') continue;
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      found.push({ rect: [b.x, b.y, b.width, b.height], centreInCutout: cuts.some(([x, y, w, h]) => w > 0 && h > 0 && cx >= x && cx <= x + w && cy >= y && cy <= y + h) });
    }
    return found;
  };
  // Click a Back control of card `beat` the first frame a real pointer could hit it (pending cards have pointer-events: none,
  // which elementFromPoint honours), without any Playwright round trip.
  tm.clickBackWhenReachable = (beat, cap) => new Promise((done) => {
    const start = performance.now();
    const tick = () => {
      const button = [...document.querySelectorAll(`[data-editor-tour-card="${beat}"] button`)].find((b) => b.textContent.trim() === 'Back');
      if (button) {
        const b = button.getBoundingClientRect(), hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        if (hit && button.contains(hit)) { button.click(); return done(performance.now()); }
      }
      if (performance.now() - start > cap) return done(null);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

/* ------------------------------------------------------------------ analysis (node) */
const norm = (v) => Math.hypot(...v);
const round = (n, d = 1) => (n == null ? n : Math.round(n * 10 ** d) / 10 ** d);
const rr = (r) => r && r.map((n) => round(n));
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const fmtRect = (r) => (r ? `(${r.map((n) => round(n)).join(', ')})` : 'none');
const ms = (t) => `${Math.round(t)}ms`;

/** Motion statistics of a series of {t, v:[x,y,w,h]}. `dims` = how many components count as motion (2 = x,y only). */
export function analyseSeries(points, dims = 4) {
  const out = { travel: 0, segments: [], reversals: 0, maxJump: { px: 0, t: null, dt: null }, firstMoveT: null, restT: null, movedBeforeTrigger: false, frames: points.length };
  let seg = null, still = 0, prev = null;
  for (let i = 1; i < points.length; i++) {
    const d = points[i].v.slice(0, dims).map((n, k) => n - points[i - 1].v[k]);
    const mag = norm(d), pos = Math.hypot(d[0], d[1]);
    if (mag >= EPS) {
      if (points[i].t < 0) out.movedBeforeTrigger = true;
      if (seg && prev && dot(prev, d) < 0) { out.reversals++; out.segments.push(seg); seg = null; }
      seg ??= { t0: points[i - 1].t, tFirst: points[i].t, t1: points[i].t, dist: 0 };
      seg.t1 = points[i].t; seg.dist += pos; still = 0; prev = d; out.travel += pos;
      if (points[i].t >= 0) { out.firstMoveT ??= points[i].t; out.restT = points[i].t; }
      if (mag > out.maxJump.px) out.maxJump = { px: mag, t: points[i].t, dt: points[i].t - points[i - 1].t };
    } else if (seg && ++still >= STILL_GAP) { out.segments.push(seg); seg = null; prev = null; }
  }
  if (seg) out.segments.push(seg);
  out.travel = round(out.travel); out.maxJump.px = round(out.maxJump.px); out.maxJump.dt = round(out.maxJump.dt, 0);
  return out;
}

const ranges = (flags, key = 't') => {
  const list = [];
  for (const f of flags) { if (f.on) { if (list.at(-1)?.open) list.at(-1).t1 = f[key]; else list.push({ t0: f[key], t1: f[key], open: true }); } else if (list.at(-1)) list.at(-1).open = false; }
  return list.map(({ t0, t1 }) => ({ t0: round(t0, 0), t1: round(t1, 0) }));
};
const segText = (segments) => segments.map((s) => `t=${Math.round(s.t0)}–${Math.round(s.t1)}ms`).join(', ');
// A real teleport is a big move inside ONE ordinary (<= 25ms, i.e. >= 40fps) frame. A big move across a longer frame gap is
// the easing curve sampled at a low frame rate (these ease-outs cover ~45% of the distance in the first 50ms), not a teleport;
// the page's frame cadence is reported separately (frames.*). In this container the page often runs at 20-30fps, so
// teleports usually cannot be told apart from easing here.
const teleport = (m) => m.maxJump.px > 80 && m.maxJump.px > 0.4 * m.travel && m.maxJump.dt <= 25;

function degenerate(rect) { return !rect || rect[2] <= 0 || rect[3] <= 0; }

/** Everything measured for one transition, from rAF samples with t re-based so the trigger click is 0. */
export function analyseTransition(samples, { dest, source, expectMoves = 1 }) {
  const card = analyseSeries(samples.filter((s) => s.host).map((s) => ({ t: s.t, v: s.host })), 2);
  const first = samples.find((s) => s.host), last = samples.at(-1);
  const inFlight = samples.filter((s) => s.t >= (card.firstMoveT ?? Infinity) && s.t <= (card.restT ?? -Infinity));
  const sizeChanges = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].host, b = samples[i].host;
    if (a && b && (Math.abs(a[2] - b[2]) > EPS || Math.abs(a[3] - b[3]) > EPS)) sizeChanges.push({ t: round(samples[i].t, 0), from: [round(a[2]), round(a[3])], to: [round(b[2]), round(b[3])], whileMoving: samples[i].t >= (card.firstMoveT ?? Infinity) && samples[i].t <= (card.restT ?? -Infinity) });
  }
  const label = (s) => (s.card && s.phase ? `${s.card}:${s.phase}` : s.card);
  const swaps = [];
  for (let i = 1; i < samples.length; i++) if (label(samples[i]) !== label(samples[i - 1]) && last.host) {
    const h = samples[i].host;
    swaps.push({ t: round(samples[i].t, 0), from: label(samples[i - 1]), to: label(samples[i]), distanceToDestinationPx: h ? round(Math.hypot(h[0] - last.host[0], h[1] - last.host[1])) : null });
  }
  // How visible the content of the step the card ends on is, while the card is still travelling to it: the most it shows
  // more than 8 px from rest, and how far from rest it first becomes whole (>= 0.99).
  const finalLabel = label(last);
  const restXY = last.host?.slice(0, 2);
  let contentInFlight = { maxOpacityAway: 0, atDistancePx: null, atT: null, wholeAtDistancePx: null, wholeAtT: null };
  for (const s of samples) {
    if (s.t < 0 || !s.host || !restXY || label(s) !== finalLabel) continue;
    const opacity = s.cop ?? s.op ?? 1;
    const distance = Math.hypot(s.host[0] - restXY[0], s.host[1] - restXY[1]);
    if (distance > 8 && opacity > contentInFlight.maxOpacityAway) contentInFlight = { ...contentInFlight, maxOpacityAway: round(opacity, 2), atDistancePx: round(distance), atT: round(s.t, 0) };
    if (opacity >= 0.99 && contentInFlight.wholeAtT == null) contentInFlight = { ...contentInFlight, wholeAtDistancePx: round(distance), wholeAtT: round(s.t, 0) };
  }
  const dim = ranges(samples.filter((s) => s.t >= 0).map((s) => ({ t: s.t, on: s.op != null && s.op < 0.99 })));
  const ended = last.st?.status !== 'running';
  const dts = samples.slice(1).map((s, k) => s.t - samples[k].t), sorted = [...dts].sort((a, b) => a - b);
  const idle = samples.filter((s) => s.t < -50).slice(1).map((s, k, a) => s.t - (k ? a[k - 1].t : samples[0].t)).sort((a, b) => a - b);
  const worst = dts.indexOf(Math.max(...dts));
  const frames = { count: samples.length, medianDtMs: round(sorted[Math.floor(sorted.length / 2)]), p95DtMs: round(sorted[Math.floor(sorted.length * 0.95)]), maxDtMs: round(sorted.at(-1)), maxDtAtT: round(samples[worst + 1]?.t, 0), over50ms: dts.filter((d) => d > 50).length, preTriggerMedianDtMs: round(idle[Math.floor(idle.length / 2)]) };
  const xy = (tf) => (tf?.match(/-?[\d.]+px/g) ?? []).slice(0, 2).map(parseFloat);
  // Mid-flight: after the first frame of a motion segment and before its end (a second, separate move is not mid-flight).
  const flight = (t) => card.segments.some((seg) => t > seg.tFirst && t <= seg.t1);
  const retargets = [], transitionToggles = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].tf !== samples[i - 1].tf && samples[i].tf && samples[i - 1].tf) retargets.push({ t: round(samples[i].t, 0), from: xy(samples[i - 1].tf), to: xy(samples[i].tf), whileMoving: flight(samples[i].t) });
    if (samples[i].tr !== samples[i - 1].tr && samples[i].tr != null && samples[i - 1].tr != null) transitionToggles.push({ t: round(samples[i].t, 0), to: samples[i].tr.slice(0, 30) || '(empty)' });
  }
  const cardOut = {
    start: rr(first?.host), end: rr(last.host), startXY: rr(first?.host?.slice(0, 2)), endXY: rr(last.host?.slice(0, 2)),
    ...card, segments: card.segments.map((s) => ({ t0: round(s.t0, 0), t1: round(s.t1, 0), dist: round(s.dist) })),
    retargets, transitionToggles, sizeChanges, contentSwaps: swaps, opacityBelow1: dim, minOpacity: round(Math.min(...samples.filter((s) => s.t >= 0 && s.op != null).map((s) => s.op)), 2),
    contentInFlight, midFlightRetargets: retargets.filter((r) => r.whileMoving).length,
  };
  void inFlight;

  const destTargets = dest.targets ?? [];
  const slots = Math.max(...samples.map((s) => s.cut.length), 0);
  const cutouts = [];
  for (let i = 0; i < slots; i++) {
    // Only while lit: a slot that opens is first placed at its spot while invisible, and that placement is not motion.
    const pts = samples.filter((s) => s.cut[i] && (s.cut[i].o ?? 1) > 0.01).map((s) => ({ t: s.t, v: s.cut[i].c }));
    const m = analyseSeries(pts, 4);
    const startRect = pts[0]?.v, endRect = pts.at(-1)?.v;
    const moving = pts.filter((p, k) => k && norm(p.v.map((n, j) => n - pts[k - 1].v[j])) >= EPS);
    const path = moving.filter((_, k) => k % 4 === 0 || k === moving.length - 1).slice(0, 8).map((p) => ({ t: round(p.t, 0), rect: rr(p.v) }));
    const selector = destTargets[i] ?? destTargets[0];
    let chase = null;
    if (selector) {
      let worst = { px: 0, t: null }, shownAt = null;
      // Only frames where the spotlight is already meant to show the destination beat (st.shownBeat), so the gap is real chasing, not waiting.
      for (const s of samples) if (s.t >= 100 && s.st?.shownBeat === dest.beat && s.st.act === dest.act && s.cut[i] && s.tg[selector]) {
        shownAt ??= s.t;
        const [x, y, w, h] = s.cut[i].c, [tx, ty, tw, th] = s.tg[selector];
        const gap = Math.max(Math.abs(x - (tx - SPOT_PADDING)), Math.abs(y - (ty - SPOT_PADDING)), Math.abs(x + w - (tx + tw + SPOT_PADDING)), Math.abs(y + h - (ty + th + SPOT_PADDING)));
        if (gap > worst.px) worst = { px: gap, t: s.t };
      }
      const tgt = analyseSeries(samples.filter((s) => s.tg[selector]).map((s) => ({ t: s.t, v: s.tg[selector] })), 4);
      const lastT = last.tg[selector], lastC = last.cut[i]?.c;
      chase = { selector, shownAtT: round(shownAt, 0), maxGapPx: round(worst.px), atT: round(worst.t, 0), finalGapPx: lastT && lastC ? round(Math.max(Math.abs(lastC[0] - (lastT[0] - SPOT_PADDING)), Math.abs(lastC[1] - (lastT[1] - SPOT_PADDING)), Math.abs(lastC[0] + lastC[2] - (lastT[0] + lastT[2] + SPOT_PADDING)), Math.abs(lastC[1] + lastC[3] - (lastT[1] + lastT[3] + SPOT_PADDING)))) : null, targetTravelPx: tgt.travel, targetSegments: tgt.segments.length };
    }
    const cutRetargets = [];
    for (let k = 1; k < samples.length; k++) { const a = samples[k - 1].cut[i]?.a, b = samples[k].cut[i]?.a; if (a && b && a.some((n, j) => Math.abs(n - b[j]) > 0.01)) cutRetargets.push({ t: round(samples[k].t, 0), from: rr(a), to: rr(b), whileMoving: m.segments.some((seg) => samples[k].t > seg.tFirst && samples[k].t < seg.t1) }); }
    // A lit cutout (open, or with no opacity reported: older builds) at the page corner, in a slot this transition uses.
    const used = pts.some((p) => !degenerate(p.v));
    const corner = used ? samples.filter((s) => s.cut[i] && (s.cut[i].o ?? 1) > 0.01 && Math.abs(s.cut[i].c[0]) < 1 && Math.abs(s.cut[i].c[1]) < 1 && (s.cut[i].c[2] < 1 || s.cut[i].c[3] < 1)).map((s) => round(s.t, 0)) : [];
    const opened = samples.some((s, k) => k && s.cut[i] && samples[k - 1].cut[i] && (samples[k - 1].cut[i].o ?? 1) < 0.5 && (s.cut[i].o ?? 1) >= 0.5);
    const closed = samples.some((s, k) => k && s.cut[i] && samples[k - 1].cut[i] && (samples[k - 1].cut[i].o ?? 1) >= 0.5 && (s.cut[i].o ?? 1) < 0.5);
    const firstMoveFrame = m.firstMoveT == null ? null : samples.findIndex((s) => s.t >= m.firstMoveT);
    cutouts.push({ slot: i, ...m, used, cornerTouchT: corner, opened, closed, firstMoveFrame, retargets: cutRetargets, segments: m.segments.map((s) => ({ t0: round(s.t0, 0), t1: round(s.t1, 0), dist: round(s.dist) })), start: rr(startRect), end: rr(endRect), startsDegenerate: degenerate(startRect), endsDegenerate: degenerate(endRect), path, chase });
  }
  const ringCount = (s) => s.ring.length;
  const rings = samples.filter((s, k) => k && ringCount(s) !== ringCount(samples[k - 1])).map((s) => ({ t: round(s.t, 0), count: ringCount(s) }));
  const ringMotion = [];
  for (let i = 0; i < Math.max(...samples.map((s) => s.ring.length), 0); i++) {
    const m = analyseSeries(samples.filter((s) => s.ring[i]).map((s) => ({ t: s.t, v: s.ring[i].c })), 4);
    ringMotion.push({ slot: i, travel: m.travel, segments: m.segments.length, maxJump: m.maxJump });
  }
  const unavailable = samples.filter((s) => s.pu).map((s) => s.t);
  const previewUnavailable = unavailable.length ? { firstT: round(unavailable[0], 0), lastT: round(unavailable.at(-1), 0), frames: unavailable.length } : null;
  const cardFirstFrame = card.firstMoveT == null ? null : samples.findIndex((s) => s.t >= card.firstMoveT);
  const moving = cutouts.filter((k) => k.firstMoveT != null && k.firstMoveT >= 0);
  const sync = cardFirstFrame == null || !moving.length ? null : {
    maxMs: round(Math.max(...moving.map((k) => Math.abs(k.firstMoveT - card.firstMoveT))), 0),
    maxFrames: Math.max(...moving.map((k) => Math.abs(k.firstMoveFrame - cardFirstFrame))),
  };
  const result = { frames, tourEnded: ended, startSync: sync, durationMs: round(last.t, 0), cardFinalBeat: last.card, card: cardOut, cutouts, ringChanges: rings, ringMotion, previewUnavailable, geometrySourcesMoved: null };
  Object.assign(result, suspectsFor(result, source, dest, expectMoves), { expectMoves });
  return result;
}

/**
 * Plain-language findings. `suspects` break the motion contract (see the header); `notes` are the transition's timeline,
 * for reading alongside the filmstrips. `expectMoves` is how many moves the step should make (2 for desktop's respond
 * reached forward: arrive beside the reply, then contract onto its actions).
 */
function suspectsFor(m, source, dest, expectMoves = 1) {
  const out = [], notes = [], c = m.card;
  if (m.tourEnded) out.push(`tour ended (status idle, card removed) instead of showing ${dest.id}; card/cutout metrics below cover the exit only`);
  if (c.firstMoveT == null) notes.push('card never moved');
  else {
    if (c.segments.length > expectMoves) out.push(`card moved in ${c.segments.length} segments (${segText(c.segments)}), expected ${expectMoves}`);
    else notes.push(`card moved in ${c.segments.length} segment(s) (${segText(c.segments)})${expectMoves > 1 ? ' (respond: arrive, then contract)' : ''}`);
    if (c.reversals) out.push(`card reversed direction ${c.reversals}x`);
    if (teleport(c)) out.push(`card jumped ${c.maxJump.px}px in one ${c.maxJump.dt}ms frame at t=${Math.round(c.maxJump.t)}ms (total travel ${c.travel}px)`);
    if (c.firstMoveT > 300) out.push(`card started moving ${Math.round(c.firstMoveT)}ms after the trigger`);
    notes.push(`card travelled ${c.travel}px, first move t=${Math.round(c.firstMoveT)}ms, at rest t=${Math.round(c.restT)}ms`);
  }
  const destinationChanges = c.retargets.filter((r) => r.t >= 0);
  for (const r of destinationChanges) (r.whileMoving ? out : notes).push(`card destination set at t=${r.t}ms (${r.from.join(',')} -> ${r.to.join(',')})${r.whileMoving ? ' while already moving (retarget mid-flight)' : ''}`);
  if (destinationChanges.length > expectMoves) out.push(`card destination set ${destinationChanges.length}x, expected ${expectMoves}`);
  for (const r of c.transitionToggles) notes.push(`card host CSS transition ${/none/.test(r.to) ? 'switched OFF' : 'switched ON'} at t=${r.t}ms`);
  for (const s of c.sizeChanges.slice(0, 2)) notes.push(`card size ${s.from.join('x')} -> ${s.to.join('x')} from t=${s.t}ms${s.whileMoving ? ' (morphing in flight)' : ''}`);
  if (c.sizeChanges.length > 2) notes.push(`(${c.sizeChanges.length - 2} more size steps: the box morphing)`);
  for (const s of c.contentSwaps) notes.push(`card content swapped ${s.from} -> ${s.to} at t=${s.t}ms while ${s.distanceToDestinationPx}px from its destination`);
  const f = c.contentInFlight;
  if (f.maxOpacityAway > 0.9) out.push(`new content ${c.contentSwaps.at(-1)?.to ?? ''} fully visible (${f.maxOpacityAway}) ${f.atDistancePx}px from rest at t=${f.atT}ms`);
  if (f.wholeAtT != null) notes.push(`new content whole at t=${f.wholeAtT}ms, ${f.wholeAtDistancePx}px from rest (most shown >8px from rest: ${f.maxOpacityAway})`);
  if (c.opacityBelow1.length) notes.push(`card section opacity < 1 (min ${c.minOpacity}) at ${c.opacityBelow1.map((r) => `t=${r.t0}–${r.t1}ms`).join(', ')}`);
  if (m.startSync && m.startSync.maxFrames > 1) out.push(`cutouts and card did not start together: up to ${m.startSync.maxMs}ms / ${m.startSync.maxFrames} frames apart`);
  for (const k of m.cutouts) {
    const label = `cutout #${k.slot}`;
    if (k.cornerTouchT.length) out.push(`${label} passed through the page corner (0,0,0,0) while lit at t=${k.cornerTouchT.slice(0, 3).join(', ')}ms`);
    else if (k.startsDegenerate && !k.endsDegenerate && k.travel > 1) out.push(`${label} grew from ${fmtRect(k.start)}; path ${k.path.map((p) => `t=${p.t}:${fmtRect(p.rect)}`).join(' -> ')}`);
    if (k.opened) notes.push(`${label} opened in place`);
    if (k.closed) notes.push(`${label} closed in place`);
    if (k.segments.length > expectMoves) out.push(`${label} moved in ${k.segments.length} segments (${segText(k.segments)}), expected ${expectMoves}`);
    for (const r of k.retargets) if (r.whileMoving) out.push(`${label} destination changed at t=${r.t}ms ${fmtRect(r.from)} -> ${fmtRect(r.to)} while already moving (retarget mid-flight)`);
    if (k.reversals) out.push(`${label} reversed direction ${k.reversals}x`);
    if (teleport(k)) out.push(`${label} jumped ${k.maxJump.px}px in one ${k.maxJump.dt}ms frame at t=${Math.round(k.maxJump.t)}ms`);
    if (k.chase && k.chase.targetTravelPx > 2 && k.chase.maxGapPx - (k.chase.finalGapPx ?? 0) > 40) notes.push(`${label} trailed its moving target ${k.chase.selector} by up to ${k.chase.maxGapPx}px at t=${k.chase.atT}ms (resting offset ${k.chase.finalGapPx}px; target moved ${k.chase.targetTravelPx}px in ${k.chase.targetSegments} segments)`);
    if (k.restT != null && k.firstMoveT != null && c.restT != null && Math.abs(k.restT - c.restT) > 250) out.push(`${label} came to rest at t=${Math.round(k.restT)}ms but card at t=${Math.round(c.restT)}ms`);
  }
  if (m.frames.maxDtMs > 100 || m.frames.over50ms > 5) out.push(`environment: page frame cadence median ${m.frames.medianDtMs}ms, p95 ${m.frames.p95DtMs}ms, worst ${m.frames.maxDtMs}ms at t=${m.frames.maxDtAtT}ms, ${m.frames.over50ms} frames > 50ms (idle before trigger: median ${m.frames.preTriggerMedianDtMs}ms)`);
  if (m.previewUnavailable) out.push(`"Preview unavailable" text present in the preview for ${m.previewUnavailable.frames} frames, t=${m.previewUnavailable.firstT}–${m.previewUnavailable.lastT}ms`);
  void source;
  // Slots that share a line are merged: "cutout #0" + "cutout #2" -> "cutouts #0,#2".
  const merge = (lines) => {
    const merged = new Map();
    for (const line of lines) {
      const hit = /^cutout #(\d+) (.*)$/.exec(line);
      if (hit) merged.set(`c:${hit[2]}`, [...(merged.get(`c:${hit[2]}`) ?? []), hit[1]]); else merged.set(line, null);
    }
    return [...merged].map(([line, slots]) => (slots ? `cutout${slots.length > 1 ? 's' : ''} #${slots.join(',#')} ${line.slice(2)}` : line));
  };
  return { suspects: merge(out), notes: merge(notes) };
}

/* ------------------------------------------------------------------ contact sheets */
async function sheet(frames, times, file, run) {
  const dir = `${file}.parts`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [i, t] of times.entries()) {
    let pick = frames[0];
    for (const f of frames) if (f.t <= t) pick = f;
    await copyFile(pick.path, join(dir, `${String(i + 1).padStart(3, '0')}.jpg`));
  }
  const labels = times.map((t, i) => `drawtext=text='${t >= 0 ? '+' : ''}${Math.round(t)}ms':x=6:y=6:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.65:enable='eq(n\\,${i})'`);
  const chain = (withLabels) => [`scale=${FILM.tile}:-1`, ...(withLabels ? labels : []), `tile=${FILM.cols}x${FILM.rows}`].join(',');
  for (const withLabels of [true, false]) {
    const code = await run('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1', '-i', join(dir, '%03d.jpg'), '-vf', chain(withLabels), '-frames:v', '1', '-q:v', '3', file]);
    if (code === 0) break;
  }
  await rm(dir, { recursive: true, force: true });
}
const runProcess = (cmd, args) => new Promise((done) => { const p = spawn(cmd, args, { stdio: 'inherit' }); p.on('error', () => done(1)); p.on('exit', (code) => done(code ?? 1)); });

/* ------------------------------------------------------------------ run */
export function parseOptions(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const [key, inline] = args[i].split('=');
    if (key === '--back' || key === '--help' || key === '--no-screencast') { o[key.slice(2)] = true; continue; }
    if (!['--out', '--theme', '--base-url', '--transitions', '--viewport'].includes(key)) throw new Error(`Unknown flag: ${key}`);
    o[key.slice(2)] = inline ?? args[++i];
    if (!o[key.slice(2)] || o[key.slice(2)].startsWith('--')) throw new Error(`${key} needs a value`);
  }
  o.theme ??= 'dark';
  if (!['light', 'dark'].includes(o.theme)) throw new Error(`Unknown theme: ${o.theme}`);
  o.transitions = o.transitions?.split(',');
  const [width, height] = (o.viewport ?? '1440x900').split('x').map(Number);
  if (!(width >= 320 && height >= 320)) throw new Error(`--viewport needs WIDTHxHEIGHT, got ${o.viewport}`);
  o.viewport = { width, height };
  return o;
}

const fileName = (name) => name.replace(/→/g, '__to__').replace(/[^\w.-]+/g, '-');

export async function run(options) {
  const steps = readTourSteps();
  const out = resolve(options.out ?? `test-results/tour-motion/${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const rel = relative(process.cwd(), out);
  if (rel.startsWith('..') || rel === '') throw new Error('--out must be a subdirectory of this worktree');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const privateDir = join(out, '.server');
  await mkdir(privateDir, { mode: 0o700 });
  const children = [];
  let browser;
  const report = { version: 1, theme: options.theme, viewport: options.viewport ?? { width: 1440, height: 900 }, reducedMotion: 'no-preference', back: Boolean(options.back), steps: steps.map((s) => s.id), transitions: [], beats: {}, notes: [] };
  const spawnOwned = (args, env) => { const c = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: 'ignore', detached: true }); children.push(c); return c; };
  try {
    const tokenFile = join(privateDir, 'token'), token = 'tour-motion-fake-runtime-only';
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
    const context = await browser.newContext({ viewport: report.viewport, screen: report.viewport, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: options.theme, reducedMotion: 'no-preference', serviceWorkers: 'block' });
    await context.addInitScript(({ theme }) => {
      let seed = 0x12345678;
      Math.random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
      try { localStorage.setItem('theme-hour', theme === 'dark' ? '0' : '12'); } catch { /* sandboxed frame */ }
    }, { theme: options.theme });
    const reset = await fetch(`${runtimeOrigin}/__test/reset`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: 'empty' }) });
    if (!reset.ok) throw new Error('Could not reset the isolated fake Runtime');
    await context.routeWebSocket('**/*', (socket) => socket.close());
    await context.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url());
      const api = /^\/api\/(runtime|astrid)(\/|$)/.test(url.pathname);
      if (api || url.pathname === '/runtime-config/v1/workspace.json') {
        try {
          if (/\/health(?:z)?\/?$/.test(url.pathname)) return await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' });
          const path = url.pathname.replace(/^\/api\/(runtime|astrid)/, '') || '/';
          const res = await fetch(`${runtimeOrigin}${path}${url.search}`, { method: request.method(), headers: { Authorization: `Bearer ${token}`, 'Content-Type': request.headers()['content-type'] ?? 'application/json' }, body: request.postDataBuffer() ?? undefined, signal: AbortSignal.timeout(10_000) });
          await route.fulfill({ status: res.status, contentType: res.headers.get('content-type') ?? 'application/json', body: Buffer.from(await res.arrayBuffer()) });
        } catch { await route.abort().catch(() => {}); }
      } else if (url.origin === baseUrl && !url.pathname.startsWith('/api/')) await route.continue();
      else await route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    const browserErrors = (report.browserErrors = []);
    page.on('pageerror', (e) => browserErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && browserErrors.length < 30) browserErrors.push(m.text().slice(0, 300)); });
    page.setDefaultTimeout(20_000);
    await page.goto(`${baseUrl}/tools/video-editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(() => document.querySelector('[data-editor-tour-card]'), null, { timeout: 120_000 });
    await page.evaluate(async ({ store, beats }) => {
      window.__tourShotsStore = await import(/* @vite-ignore */ store);
      window.__tourShotsBeats = await import(/* @vite-ignore */ beats);
    }, { store: STORE, beats: BEATS });
    await page.evaluate(installSampler);
    const cdp = await context.newCDPSession(page);
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);

    const wanted = (name) => !options.transitions || options.transitions.includes(name) || options.transitions.includes(fileName(name));
    const stepOf = (act, beat) => steps.find((s) => s.act === act && s.beat === beat) ?? { id: `act${act}-${beat}`, act, beat, targets: [] };
    // If a beat never reports ready by itself (the act-1 live scene sometimes never paints its opening frame in
    // this container), press Next once after NUDGE_MS exactly as a user would to skip the animation, and note it.
    const nudges = (report.nudges = []);
    const waitSettled = async (dest) => {
      const start = Date.now();
      let nudged = false;
      while (!await page.evaluate((d) => window.__tm.isSettled(d), dest)) {
        if (!nudged && Date.now() - start > NUDGE_MS) {
          nudged = true;
          nudges.push({ beat: dest.id, afterMs: Date.now() - start, state: await page.evaluate(() => window.__tm.samples.at(-1)?.st),
            scene: await page.evaluate(() => [...document.querySelectorAll('[data-editor-tour="preview"] [data-testid="astrid-live-scene-entry"]')].map((e) => ({ ...e.dataset, box: [e.offsetWidth, e.offsetHeight] }))) });
          await nextButton(dest).click({ timeout: 5000 }).catch(() => {});
        }
        if (Date.now() - start > CAP_MS) throw new Error(`${dest.id} did not settle within ${CAP_MS} ms: ${JSON.stringify(await page.evaluate(() => window.__tm.samples.at(-1)?.st))}; live scene: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('[data-testid="astrid-live-scene-entry"]')].map((e) => ({ ...e.dataset }))))}; browser errors: ${JSON.stringify(browserErrors.filter((e) => !e.includes('serviceWorker')).slice(0, 5))}`);
        await delay(50);
      }
    };
    const recordBeat = async (step) => { report.beats[step.id] = { updateAvailable: await page.evaluate(() => window.__tm.updateNotice()) }; };

    /** Record samples + screencast around `action` (which returns the destination step), until the destination settles. */
    const trace = async (source, label, action, nameOverride) => {
      await page.evaluate((targets) => { window.__tm.samples.length = 0; window.__tm.clicks.length = 0; window.__tm.loaf.length = 0; window.__tm.targets = targets; }, [...new Set(steps.flatMap((s) => s.targets))]);
      const frames = [];
      const onFrame = (event) => { frames.push({ data: event.data, wall: event.metadata.timestamp * 1000 }); cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {}); };
      cdp.on('Page.screencastFrame', onFrame);
      if (!options['no-screencast']) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1, maxWidth: report.viewport.width, maxHeight: report.viewport.height });
      await delay(300);
      const load0 = loadavg()[0];
      const dest = await action();
      await waitSettled(dest);
      await delay(250);
      if (!options['no-screencast']) await cdp.send('Page.stopScreencast');
      cdp.off('Page.screencastFrame', onFrame);
      const { samples, clicks, loaf } = await page.evaluate(() => ({ samples: window.__tm.samples, clicks: window.__tm.clicks, loaf: window.__tm.loaf }));
      const name = nameOverride ?? `${source.id}→${dest.id}${label}`;
      if (!wanted(name)) return dest;
      const t0 = clicks[0]?.t ?? samples[0].t;
      const rebased = samples.map((s) => ({ ...s, t: s.t - t0 }));
      const dir = join(out, fileName(name));
      await mkdir(join(dir, 'frames'), { recursive: true });
      const shots = [];
      for (const [i, f] of frames.entries()) {
        const path = join(dir, 'frames', `${String(i).padStart(4, '0')}.jpg`);
        await writeFile(path, Buffer.from(f.data, 'base64'));
        shots.push({ path, t: f.wall - timeOrigin - t0 });
      }
      // Desktop's respond reached forward makes two moves (arrive beside the reply, contract onto its actions); by Back, one.
      const expectMoves = dest.beat === 'respond' && !/back/.test(name) ? 2 : 1;
      const analysis = analyseTransition(rebased, { dest, source, expectMoves });
      analysis.longFrames = loaf.map((f) => ({ ...f, t: round(f.t - t0, 0) })).filter((f) => f.t > -200).sort((a, b) => b.d - a.d).slice(0, 5);
      const moved = (key) => rebased.some((s, k) => k && s.cut[0] && rebased[k - 1].cut[0] && s.cut[0][key].some((n, j) => Math.abs(n - rebased[k - 1].cut[0][key][j]) > 0.01));
      analysis.geometrySourcesMoved = { computedStyle: moved('c'), getBBox: moved('b'), attribute: moved('a') };
      const lastT = rebased.at(-1).t;
      const dense = Array.from({ length: FILM.cols * FILM.rows }, (_, i) => i * FILM.denseStep);
      const start = Math.min(...shots.map((s) => s.t), 0), end = Math.max(analysis.card.restT ?? 0, ...analysis.cutouts.map((c) => c.restT ?? 0)) + 300;
      const sparse = Array.from({ length: FILM.cols * FILM.rows }, (_, i) => start + ((Math.min(end, lastT) - start) * i) / (FILM.cols * FILM.rows - 1));
      if (shots.length) { await sheet(shots, dense, join(dir, 'filmstrip-dense.jpg'), runProcess); await sheet(shots, sparse, join(dir, 'filmstrip-whole.jpg'), runProcess); }
      await writeFile(join(dir, 'samples.json'), JSON.stringify(rebased));
      const entry = { name, dir: relative(out, dir), hostLoad: { cpus: cpus().length, loadavg1AtStart: round(load0, 1), loadavg1AtEnd: round(loadavg()[0], 1) }, clicks: clicks.map((c) => ({ t: round(c.t - t0, 0), text: c.text })), screencast: { frames: shots.length, firstT: round(shots[0]?.t, 0), lastT: round(shots.at(-1)?.t, 0), medianGapMs: round(shots.map((s, k) => k && s.t - shots[k - 1].t).slice(1).sort((a, b) => a - b)[Math.floor((shots.length - 1) / 2)], 0) }, filmstrips: { dense: `${fileName(name)}/filmstrip-dense.jpg (+0..${FILM.denseStep * (FILM.cols * FILM.rows - 1)}ms every ${FILM.denseStep}ms)`, whole: `${fileName(name)}/filmstrip-whole.jpg (${Math.round(start)}..${Math.round(Math.min(end, lastT))}ms)` }, ...analysis };
      report.transitions.push(entry);
      console.log(`  ${name}: card ${analysis.card.travel}px/${analysis.card.segments.length} seg, ${shots.length} frames`);
      return dest;
    };

    const nextButton = (step) => (step.beat === 'compose' ? page.locator('[data-editor-tour="chat-send"]') : page.locator('[data-editor-tour-card] section').getByRole('button').last());
    const forward = (step, to) => async () => { await nextButton(step).click(); return to; };
    /** Press Back on a settled card; the destination is whatever beat the store moves to. */
    const back = (step) => async () => {
      await page.locator('[data-editor-tour-card] section').getByRole('button', { name: 'Back', exact: true }).click();
      await page.waitForFunction(({ act, beat }) => { const s = window.__tourShotsStore.getEditorTourState(); return s.act !== act || s.beat !== beat; }, step);
      const s = await page.evaluate(() => window.__tourShotsStore.getEditorTourState());
      return stepOf(s.act, s.beat);
    };

    await waitSettled(steps[0]);
    await recordBeat(steps[0]);
    console.log(`walking ${steps.length} beats${options.back ? ' (+back)' : ''}`);
    for (let i = 0; i + 1 < steps.length; i++) {
      const src = steps[i], dst = steps[i + 1];
      if (options.back && src.id === 'act1-respond') {
        // Forward to land, then Back the first frame a pointer could hit it (before the land beat is ready).
        await trace(src, '__back-early', async () => {
          await nextButton(src).click();
          const at = await page.evaluate(() => window.__tm.clickBackWhenReachable('land', 5000));
          if (at == null) throw new Error('Back was never reachable on act1-land');
          return stepOf(1, 'respond');
        }, 'act1-respond→act1-land→back-early→act1-respond');
        await recordBeat(src);
      }
      await trace(src, '', forward(src, dst));
      await recordBeat(dst);
      if (options.back && dst.beat === 'land') {
        const previous = await trace(dst, '__back', back(dst));
        await recordBeat(previous);
        await trace(previous, '__return', forward(previous, dst));
        await recordBeat(dst);
      }
    }
    report.notes.push('Screencast frame t = Chrome frame swap wall time - page timeOrigin - trigger click (performance.now); rAF samples are the precise record.');
    return { out, report, failed: false };
  } finally {
    await browser?.close();
    await Promise.all(children.map(async (child) => { if (child.pid) await terminateProcessTree(child).catch(() => {}); }));
    await rm(privateDir, { recursive: true, force: true });
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(out, 'report.md'), renderMarkdown(report));
    console.log(join(out, 'report.md'));
  }
}

function renderMarkdown(report) {
  const yes = (v) => (v ? 'yes' : 'no');
  const lines = [`# Tour motion trace (${report.theme}, ${report.viewport.width}x${report.viewport.height}, motion on${report.back ? ', with Back' : ''})`, '', `Browser ${report.browser ?? '?'}. t=0 is the trigger click. Frame images: \`<transition>/frames\`, filmstrips read left to right, top to bottom.`, '',
    'Contract columns: card moves (segments; expected in brackets), mid-flight destination changes, direction reversals, how far apart card and cutouts start (ms / frames), whether a lit cutout touched the page corner, and the most the NEW content shows more than 8 px from rest.', '',
    '| transition | card moves | mid-flight retargets | reversals | card first move / rest | cutout start gap | corner | new content >8px from rest | suspects |', '|---|---|---|---|---|---|---|---|---|'];
  for (const t of report.transitions) {
    const c = t.card;
    const cutoutRetargets = t.cutouts.reduce((n, k) => n + k.retargets.filter((r) => r.whileMoving).length, 0);
    lines.push(`| ${t.name} | ${c.segments.length} (${t.expectMoves}) | ${c.midFlightRetargets}${cutoutRetargets ? ` (+${cutoutRetargets} cutout)` : ''} | ${c.reversals} | ${c.firstMoveT == null ? '-' : `${Math.round(c.firstMoveT)} / ${Math.round(c.restT)}ms`} | ${t.startSync ? `${t.startSync.maxMs}ms / ${t.startSync.maxFrames}f` : '-'} | ${yes(t.cutouts.some((k) => k.cornerTouchT.length))} | ${c.contentInFlight.maxOpacityAway} | ${t.suspects.length} |`);
  }
  for (const t of report.transitions) {
    lines.push('', `## ${t.name}`, '', `Card ${fmtRect(t.card.start)} -> ${fmtRect(t.card.end)}. Clicks: ${t.clicks.map((c) => `"${c.text}" at ${c.t}ms`).join(', ') || 'none'}. Screencast: ${t.screencast.frames} frames, median gap ${t.screencast.medianGapMs}ms. Host load avg ${t.hostLoad.loadavg1AtStart}->${t.hostLoad.loadavg1AtEnd} on ${t.hostLoad.cpus} CPUs; page frames median ${t.frames.medianDtMs}ms, worst ${t.frames.maxDtMs}ms.`, '',
      `Filmstrips: ${t.filmstrips.dense}; ${t.filmstrips.whole}`, '');
    for (const c of t.cutouts) if (c.used) lines.push(`- cutout #${c.slot}: ${fmtRect(c.start)} -> ${fmtRect(c.end)}, travel ${c.travel}px, ${c.segments.length} segment(s)${c.opened ? ', opened in place' : ''}${c.closed ? ', closed in place' : ''}${c.chase ? `, max gap to ${c.chase.selector} ${c.chase.maxGapPx}px (final ${c.chase.finalGapPx}px)` : ''}`);
    lines.push('', '**Suspects**', '', ...(t.suspects.length ? t.suspects.map((s) => `- ${s}`) : ['- none']));
    lines.push('', '**Timeline**', '', ...(t.notes.length ? t.notes.map((s) => `- ${s}`) : ['- nothing moved']));
    if (t.longFrames?.length) lines.push('', '**Longest frames** (Long Animation Frames: what ran in them)', '', ...t.longFrames.map((f) => `- t=${f.t}ms ${f.d}ms (style+layout ${f.styleLayoutMs ?? '?'}ms, render ${f.renderMs ?? '?'}ms): ${f.scripts.map((x) => `${x.d}ms ${x.invoker}${x.fn ? ` ${x.fn}` : ''}${x.src ? ` @${x.src}` : ''}`).join('; ') || 'no script attribution'}`));
  }
  if (report.nudges?.length) lines.push('', '## Beats that did not become ready by themselves', '', ...report.nudges.map((n) => `- ${n.beat}: not ready after ${Math.round(n.afterMs / 1000)}s (ready=${JSON.stringify(n.state?.ready)}); the tool pressed Next once like a user skipping the animation. Its trace contains that extra click.${n.scene ? ` Live scene: ${JSON.stringify(n.scene)}` : ''}`));
  lines.push('', '## Update available notice per settled beat', '', ...Object.entries(report.beats).map(([id, b]) => `- ${id}: ${b.updateAvailable.length ? b.updateAvailable.map((u) => `${fmtRect(u.rect)} centre ${u.centreInCutout ? 'inside' : 'outside'} cutouts`).join('; ') : 'absent'}`));
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log((await readFile(fileURLToPath(import.meta.url), 'utf8')).split('/**')[1].split('*/')[0].replace(/^ \* ?/gm, ''));
    else { const result = await run(options); if (result.failed) process.exitCode = 1; }
  } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
}

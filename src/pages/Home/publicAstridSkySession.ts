import { setThemeColor } from '@/shared/lib/themeColor';
import type { PublicAstridEnvironment } from './publicAstridLifecycle';
import {
  ARC_RADIUS,
  duskTokens,
  pageDusk,
  PUBLIC_ASTRID_SKY_DEFAULT_INTENSITY,
  skyState,
  sunTimes,
  SKY_RADIUS,
  themeForDarkness,
  type PublicAstridSkyState,
  type PublicAstridSkyTheme,
  type PublicAstridSunTimes,
} from './publicAstridSkyRender';
import {
  locationForTimeZone,
  visitorLocation,
  zonedHours,
  type PublicAstridLocation,
} from './publicAstridLocation';
import { createPublicAstridSkyGeometry, type PublicAstridSkyFrame, type PublicAstridSkyGeometry, type PublicAstridSkyGeometrySnapshot } from './publicAstridSkyGeometry';
import { createPublicAstridSkyRenderer, type PublicAstridSkyRenderer } from './publicAstridSkyRenderer';

const DAY_MS = 864e5;
const CLOCK_TICK_MS = 60_000;
const AMBIENT_TICK_MS = 450;
const REVEAL_MS = 1800;
const REPLAY_DAY_MS = 9000;
const PARALLAX_MARGIN = 24;
const PARALLAX_DEPTH = { sky: 3, stars: 3, far: 6, near: 12 } as const;
const SCROLL_DEPTH = { sky: 6, stars: 6, far: 12, near: 20 } as const;
const SCROLL_DRIFT_SPAN = 1400;

/** The easter-egg day: a beat for the mink to turn, the 24 hours, then a beat to settle. */
export const PUBLIC_ASTRID_SKY_REPLAY_TURN_MS = 500;
export const PUBLIC_ASTRID_SKY_REPLAY_SETTLE_MS = 500;
export const PUBLIC_ASTRID_SKY_REPLAY_MS = PUBLIC_ASTRID_SKY_REPLAY_TURN_MS + REPLAY_DAY_MS + PUBLIC_ASTRID_SKY_REPLAY_SETTLE_MS;

/** All mutable sky controls are owned by the site session, not by a renderer. */
export interface PublicAstridSkySettings {
  enabled: boolean;
  hours: number | null;
  dayOffset: number;
  intensity: Record<PublicAstridSkyTheme, number>;
  openFrame: boolean;
  path: 'rise' | 'arc';
  size: Record<'rise' | 'arc', number>;
  lift: Record<'rise' | 'arc', number>;
  moonScale: number;
  location: string | null;
  details: { pixelMono: boolean; pixelBeta: boolean; pixelIcons: boolean };
}

export const DEFAULT_PUBLIC_ASTRID_SKY_SETTINGS: PublicAstridSkySettings = {
  enabled: true,
  hours: null,
  dayOffset: 0,
  intensity: PUBLIC_ASTRID_SKY_DEFAULT_INTENSITY,
  openFrame: true,
  path: 'arc',
  size: { rise: SKY_RADIUS, arc: ARC_RADIUS },
  lift: { rise: 0, arc: 0.08 },
  moonScale: 0.6,
  location: null,
  details: { pixelMono: true, pixelBeta: true, pixelIcons: true },
};

export interface PublicAstridSkyReplay {
  startedAt: number;
  elapsed: number;
  operation: number;
}

export interface PublicAstridSkyPalette {
  paper: string;
  dusk: number;
  ink: number;
  inkPage: number;
  firm: number;
  theme: PublicAstridSkyTheme;
  tokens: Record<string, string>;
}

export interface PublicAstridSkySceneSnapshot {
  settings: PublicAstridSkySettings;
  now: number;
  date: Date;
  location: PublicAstridLocation;
  times: PublicAstridSunTimes;
  phase: number;
  hours: number;
  cloudHours: number;
  replay: PublicAstridSkyReplay | null;
  replayOffset: number;
  state: PublicAstridSkyState;
  darkness: number;
  palette: PublicAstridSkyPalette;
  reveal: number;
  tick: number;
  parallaxX: number;
  parallaxY: number;
  visible: boolean;
  reducedMotion: boolean;
  phone: boolean;
}

export interface PublicAstridSkyControlsSnapshot {
  settings: PublicAstridSkySettings;
  palette: PublicAstridSkyPalette;
  darkness: number;
  hours: number;
  location: PublicAstridLocation;
  times: PublicAstridSunTimes;
  phase: number;
}

export interface PublicAstridSkySession {
  readonly renderer: PublicAstridSkyRenderer;
  getSnapshot: () => PublicAstridSkySceneSnapshot;
  getControlsSnapshot: () => PublicAstridSkyControlsSnapshot;
  subscribe: (listener: () => void) => () => void;
  subscribeRaster: (listener: () => void) => () => void;
  subscribeParallax: (listener: () => void) => () => void;
  subscribeControls: (listener: () => void) => () => void;
  getGeometrySnapshot: () => PublicAstridSkyGeometrySnapshot;
  subscribeGeometry: (listener: () => void) => () => void;
  setGeometryViewport: (columns: number, rows: number, frame?: PublicAstridSkyFrame) => void;
  registerGeometryRoot: (root: HTMLElement | null, selector: string, owner: string) => () => void;
  mount: () => void;
  destroy: () => void;
  setEnvironment: (environment: PublicAstridEnvironment) => void;
  setSettings: (settings: PublicAstridSkySettings) => void;
  patchSettings: (patch: Partial<PublicAstridSkySettings>) => void;
  setManualHours: (hours: number) => void;
  setNow: () => void;
  startHomeReplay: (onEnd?: () => void) => boolean;
  cancelHomeReplay: () => void;
  registerPaletteTarget: (target: HTMLElement | null, owner: string) => () => void;
}

export interface PublicAstridSkySessionOptions {
  environment: PublicAstridEnvironment;
  now?: () => number;
  performanceNow?: () => number;
}

function cloneSettings(settings: PublicAstridSkySettings): PublicAstridSkySettings {
  return {
    ...settings,
    intensity: { ...settings.intensity },
    size: { ...settings.size },
    lift: { ...settings.lift },
    details: { ...settings.details },
  };
}

function wrapHours(value: number): number {
  return ((value % 24) + 24) % 24;
}

function scrollDrift(): number {
  const locked = document.documentElement.dataset.astridScrollLockY;
  const y = locked === undefined ? window.scrollY : Number(locked);
  return -Math.min(Number.isFinite(y) ? y : window.scrollY, SCROLL_DRIFT_SPAN) / SCROLL_DRIFT_SPAN;
}

/** The place whose sky is shown: the visitor's own, or an explicit location. */
export function skyLocation(settings: PublicAstridSkySettings, at: Date): PublicAstridLocation {
  return settings.location ? locationForTimeZone(settings.location, at) : visitorLocation(at);
}

export function skyDate(settings: PublicAstridSkySettings, now: number): Date {
  return new Date(now + settings.dayOffset * DAY_MS);
}

export function replayOffsetHours(elapsed: number): number {
  const t = Math.max(0, Math.min(1, (elapsed - PUBLIC_ASTRID_SKY_REPLAY_TURN_MS) / REPLAY_DAY_MS));
  const e = 0.12;
  const cruise = 1 / (1 - e);
  let distance: number;
  if (t < e) distance = (cruise * t * t) / (2 * e);
  else if (t > 1 - e) distance = 1 - (cruise * (1 - t) ** 2) / (2 * e);
  else distance = cruise * (t - e / 2);
  return 24 * distance;
}

function effectiveHours(settings: PublicAstridSkySettings, date: Date, location: PublicAstridLocation, replayOffset: number): number {
  const base = settings.hours ?? zonedHours(date, location.timeZone);
  return wrapHours(base + replayOffset);
}

/** Pure scene derivation: settings, clock, cloud anchor, and replay are the only inputs. */
export function derivePublicAstridSkyScene(
  settings: PublicAstridSkySettings,
  now: number,
  cloudHours: number,
  replay: PublicAstridSkyReplay | null,
): Omit<PublicAstridSkySceneSnapshot, 'settings' | 'replay' | 'reveal' | 'tick' | 'parallaxX' | 'parallaxY' | 'visible' | 'reducedMotion' | 'phone'> {
  const date = skyDate(settings, now);
  const location = skyLocation(settings, date);
  const replayOffset = replay ? replayOffsetHours(replay.elapsed) : 0;
  const hours = effectiveHours(settings, date, location, replayOffset);
  const times = sunTimes(date, location);
  const state = skyState(hours, times);
  const darkness = state.night;
  const dusk = pageDusk(darkness);
  return {
    now,
    date,
    location,
    times,
    phase: moonPhaseFor(date),
    hours,
    cloudHours: settings.hours === null && settings.location === null ? wrapHours(cloudHours + replayOffset) : hours,
    replayOffset,
    state,
    darkness,
    palette: {
      ...dusk,
      theme: themeForDarkness(darkness),
      tokens: duskTokens(darkness),
    },
  };
}

// Kept local so the session's pure boundary does not depend on the React renderer module.
function moonPhaseFor(at: Date): number {
  const synodicMonthDays = 29.530588853;
  const referenceNewMoon = Date.UTC(2000, 0, 6, 18, 14);
  return ((((at.getTime() - referenceNewMoon) / DAY_MS) % synodicMonthDays) + synodicMonthDays) % synodicMonthDays / synodicMonthDays;
}

function paletteKey(palette: PublicAstridSkyPalette): string {
  return [palette.paper, palette.dusk, palette.ink, palette.inkPage, palette.firm, palette.theme, ...Object.entries(palette.tokens).flat()].join('|');
}

function settingsKey(settings: PublicAstridSkySettings): string {
  return JSON.stringify(settings);
}

function writePalette(target: HTMLElement | null, palette: PublicAstridSkyPalette) {
  document.documentElement.style.setProperty('--astrid-root-paper', palette.paper);
  setThemeColor(palette.paper);
  if (!target) return;
  target.style.setProperty('--astrid-paper', palette.paper);
  target.style.setProperty('--astrid-dusk', String(palette.dusk));
  target.style.setProperty('--astrid-dusk-ink', String(palette.ink));
  target.style.setProperty('--astrid-dusk-ink-page', String(palette.inkPage));
  target.style.setProperty('--astrid-dusk-firm', String(palette.firm));
  for (const [name, value] of Object.entries(palette.tokens)) target.style.setProperty(name, value);
  // Written here too (React renders the same value after), so a dusk wash's new image already has it.
  target.dataset.theme = palette.theme;
}

type DuskWashDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

/**
 * When the sky itself carries the page across mid-twilight, its reading palette changes in one step (see
 * pageDusk). Rather than flip within a minute, the whole page crossfades from the old palette to the new
 * one in a single slow view transition (the dusk wash in PublicAstridShell.css).
 */
function washPalette(update: () => void): void {
  const root = document.documentElement;
  const done = () => { delete root.dataset.astridDuskWash; };
  root.dataset.astridDuskWash = '';
  try {
    void (document as DuskWashDocument).startViewTransition!(update).finished.then(done, done);
  } catch {
    update();
    done();
  }
}

/**
 * One site-lifetime owner for the clock, replay, cloud anchor, parallax, and palette. The scene channel is
 * intentionally separate from the controls channel: the Site never rerenders for animation frames, and
 * retained Home does not subscribe to the active renderer's frame stream.
 */
export function createPublicAstridSkySession(options: PublicAstridSkySessionOptions): PublicAstridSkySession {
  const now = options.now ?? Date.now;
  const performanceNow = options.performanceNow ?? (() => performance.now());
  let environment = options.environment;
  let settings = cloneSettings(DEFAULT_PUBLIC_ASTRID_SKY_SETTINGS);
  let cloudHours = zonedHours(new Date(now()), visitorLocation(new Date(now())).timeZone);
  let replay: PublicAstridSkyReplay | null = null;
  let replayEnd: (() => void) | undefined;
  let mounted = false;
  let destroyed = false;
  let clockTimer: number | null = null;
  let ambientTimer: number | null = null;
  let replayFrame = 0;
  let revealFrame = 0;
  let parallaxFrame = 0;
  let visibilityTimer: number | null = null;
  let operation = 0;
  let revealOperation = 0;
  let visibilityOperation = 0;
  let reveal = environment.reducedMotion ? 1 : 0;
  let tick = 0;
  let parallaxX = 0;
  let parallaxY = 0;
  let parallaxTargetX = 0;
  let parallaxTargetY = 0;
  let paletteTarget: { element: HTMLElement; owner: string } | null = null;
  let previousSettingsKey = settingsKey(settings);
  let previousPaletteKey = '';
  let washing = false;
  const geometry: PublicAstridSkyGeometry = createPublicAstridSkyGeometry();
  const renderer = createPublicAstridSkyRenderer();
  const listeners = new Set<() => void>();
  const parallaxListeners = new Set<() => void>();
  const controlListeners = new Set<() => void>();
  const initial = derivePublicAstridSkyScene(settings, now(), cloudHours, replay);
  let snapshot: PublicAstridSkySceneSnapshot = {
    settings,
    ...initial,
    replay,
    reveal,
    tick,
    parallaxX,
    parallaxY,
    visible: environment.visible,
    reducedMotion: environment.reducedMotion,
    phone: environment.phone,
  };
  let controlsSnapshot: PublicAstridSkyControlsSnapshot = {
    settings,
    palette: snapshot.palette,
    darkness: snapshot.darkness,
    hours: snapshot.hours,
    location: snapshot.location,
    times: snapshot.times,
    phase: snapshot.phase,
  };

  const emit = (controlsChanged: boolean, rasterChanged = true) => {
    if (destroyed) return;
    const scene = derivePublicAstridSkyScene(settings, snapshot.now, cloudHours, replay);
    snapshot = {
      settings,
      ...scene,
      replay,
      reveal,
      tick,
      parallaxX,
      parallaxY,
      visible: environment.visible,
      reducedMotion: environment.reducedMotion,
      phone: environment.phone,
    };
    // While a dusk wash waits for its old image, the page keeps its old palette; the wash commits the latest.
    if (!washing) {
      // The sky's own clock crossing mid-twilight washes the page into its new palette; a replay, a chosen
      // hour or a hidden or reduced-motion page changes at once.
      const washes = paletteTarget !== null && snapshot.palette.theme !== controlsSnapshot.palette.theme && !replay
        && settings.hours === null && environment.visible && !environment.reducedMotion
        && typeof (document as DuskWashDocument).startViewTransition === 'function';
      if (washes) {
        washing = true;
        washPalette(() => {
          washing = false;
          if (!destroyed) commitControls(true);
        });
      } else {
        commitControls(controlsChanged);
      }
    }
    if (rasterChanged) listeners.forEach((listener) => listener());
  };
  function commitControls(controlsChanged: boolean) {
    const nextSettingsKey = settingsKey(settings);
    const nextPaletteKey = paletteKey(snapshot.palette);
    if (nextPaletteKey !== previousPaletteKey) writePalette(paletteTarget?.element ?? null, snapshot.palette);
    if (!controlsChanged && nextSettingsKey === previousSettingsKey && nextPaletteKey === previousPaletteKey) return;
    controlsSnapshot = {
      settings,
      palette: snapshot.palette,
      darkness: snapshot.darkness,
      hours: snapshot.hours,
      location: snapshot.location,
      times: snapshot.times,
      phase: snapshot.phase,
    };
    previousSettingsKey = nextSettingsKey;
    previousPaletteKey = nextPaletteKey;
    controlListeners.forEach((listener) => listener());
  }

  const cancelFrame = (frame: number) => { if (frame) window.cancelAnimationFrame(frame); };
  const stopReplay = (notify = true) => {
    operation += 1;
    cancelFrame(replayFrame);
    replayFrame = 0;
    replay = null;
    replayEnd = undefined;
    if (notify) emit(true);
  };
  const startReveal = () => {
    if (!mounted || environment.reducedMotion || reveal >= 1 || revealFrame) return;
    const id = ++revealOperation;
    const startedAt = performanceNow();
    const step = (time: number) => {
      if (!mounted || id !== revealOperation || !environment.visible) return;
      const progress = Math.min(1, (time - startedAt) / REVEAL_MS);
      reveal = 1 - (1 - progress) ** 3;
      emit(false);
      if (progress < 1) revealFrame = window.requestAnimationFrame(step);
      else revealFrame = 0;
    };
    revealFrame = window.requestAnimationFrame(step);
  };
  const updateParallax = () => {
    parallaxFrame = 0;
    if (!mounted || !environment.visible || environment.reducedMotion) return;
    parallaxX += (parallaxTargetX - parallaxX) * 0.06;
    parallaxY += (parallaxTargetY - parallaxY) * 0.1;
    snapshot = { ...snapshot, parallaxX, parallaxY };
    parallaxListeners.forEach((listener) => listener());
    if (Math.abs(parallaxTargetX - parallaxX) > 0.001 || Math.abs(parallaxTargetY - parallaxY) > 0.001) {
      parallaxFrame = window.requestAnimationFrame(updateParallax);
    }
  };
  const scheduleParallax = () => {
    if (!parallaxFrame) parallaxFrame = window.requestAnimationFrame(updateParallax);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!environment.visible || environment.reducedMotion || event.pointerType !== 'mouse') return;
    parallaxTargetX = -((event.clientX / window.innerWidth) * 2 - 1);
    scheduleParallax();
  };
  const onScroll = () => {
    if (!environment.visible || environment.reducedMotion || environment.phone) return;
    parallaxTargetY = scrollDrift();
    scheduleParallax();
  };
  const onVisibility = () => {
    const id = ++visibilityOperation;
    if (visibilityTimer !== null) window.clearTimeout(visibilityTimer);
    visibilityTimer = window.setTimeout(() => {
      visibilityTimer = null;
      if (destroyed || id !== visibilityOperation) return;
      setEnvironment({ ...environment, visible: !document.hidden });
    }, 0);
  };
  const onClock = () => {
    const id = visibilityOperation;
    if (!environment.visible || destroyed || id !== visibilityOperation) return;
    snapshot = { ...snapshot, now: now() };
    emit(true);
  };
  const mount = () => {
    if (mounted) return;
    // React StrictMode intentionally exercises setup → cleanup → setup. The
    // owner cleanup is reversible; operation identities still invalidate every
    // callback from the disposed generation before this new mount starts.
    destroyed = false;
    mounted = true;
    geometry.mount();
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    clockTimer = window.setInterval(onClock, CLOCK_TICK_MS);
    ambientTimer = window.setInterval(() => {
      if (environment.visible && !environment.reducedMotion && !environment.phone && settings.enabled) {
        tick += 1;
        emit(false);
      }
    }, AMBIENT_TICK_MS);
    emit(true);
    if (reveal === 0) startReveal();
  };
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    mounted = false;
    operation += 1;
    revealOperation += 1;
    visibilityOperation += 1;
    if (clockTimer !== null) window.clearInterval(clockTimer);
    if (ambientTimer !== null) window.clearInterval(ambientTimer);
    if (visibilityTimer !== null) window.clearTimeout(visibilityTimer);
    cancelFrame(replayFrame);
    cancelFrame(revealFrame);
    cancelFrame(parallaxFrame);
    geometry.destroy();
    renderer.dispose();
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', onVisibility);
    replay = null;
    replayEnd = undefined;
    listeners.clear();
    parallaxListeners.clear();
    controlListeners.clear();
    paletteTarget = null;
  };
  const setEnvironment = (next: PublicAstridEnvironment) => {
    if (destroyed) return;
    const changed = next.visible !== environment.visible || next.reducedMotion !== environment.reducedMotion || next.phone !== environment.phone;
    environment = next;
    if (!changed) return;
    visibilityOperation += 1;
    if (!next.visible || next.reducedMotion) {
      stopReplay(false);
      cancelFrame(parallaxFrame);
      parallaxFrame = 0;
      cancelFrame(revealFrame);
      revealFrame = 0;
      revealOperation += 1;
      if (next.reducedMotion) reveal = 1;
    }
    if (next.visible) {
      const current = new Date(now());
      snapshot = { ...snapshot, now: current.getTime() };
      cloudHours = zonedHours(current, visitorLocation(current).timeZone);
      parallaxTargetY = scrollDrift();
      if (!next.reducedMotion) startReveal();
    }
    emit(true);
  };
  const setSettings = (next: PublicAstridSkySettings) => {
    settings = cloneSettings(next);
    emit(true);
  };
  const patchSettings = (patch: Partial<PublicAstridSkySettings>) => setSettings({ ...settings, ...patch });
  const setManualHours = (hours: number) => {
    stopReplay(false);
    patchSettings({ hours: wrapHours(hours) });
  };
  const setNow = () => {
    stopReplay(false);
    patchSettings({ hours: null, dayOffset: 0 });
  };
  const startHomeReplay = (onEnd?: () => void) => {
    if (!mounted || !environment.visible || environment.reducedMotion || !settings.enabled) return false;
    stopReplay(false);
    const id = ++operation;
    replay = { startedAt: performanceNow(), elapsed: 0, operation: id };
    replayEnd = onEnd;
    const step = (time: number) => {
      if (!mounted || !environment.visible || operation !== id || !replay || replay.operation !== id) return;
      const elapsed = time - replay.startedAt;
      if (elapsed >= PUBLIC_ASTRID_SKY_REPLAY_MS) {
        replay = null;
        replayFrame = 0;
        const done = replayEnd;
        replayEnd = undefined;
        emit(true);
        done?.();
        return;
      }
      replay = { ...replay, elapsed };
      emit(false);
      replayFrame = window.requestAnimationFrame(step);
    };
    emit(true);
    replayFrame = window.requestAnimationFrame(step);
    return true;
  };
  const registerPaletteTarget = (target: HTMLElement | null, owner: string) => {
    if (!target) return () => {};
    paletteTarget = { element: target, owner };
    writePalette(target, snapshot.palette);
    return () => {
      if (paletteTarget?.element === target && paletteTarget.owner === owner) paletteTarget = null;
    };
  };

  const session: PublicAstridSkySession = {
    renderer,
    getSnapshot: () => snapshot,
    getControlsSnapshot: () => controlsSnapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeRaster: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeParallax: (listener) => { parallaxListeners.add(listener); return () => parallaxListeners.delete(listener); },
    subscribeControls: (listener) => { controlListeners.add(listener); return () => controlListeners.delete(listener); },
    getGeometrySnapshot: geometry.getSnapshot,
    subscribeGeometry: geometry.subscribe,
    setGeometryViewport: geometry.setViewport,
    registerGeometryRoot: geometry.registerRoot,
    mount,
    destroy,
    setEnvironment,
    setSettings,
    patchSettings,
    setManualHours,
    setNow,
    startHomeReplay,
    cancelHomeReplay: () => stopReplay(true),
    registerPaletteTarget,
  };
  return session;
}

export { PARALLAX_DEPTH, PARALLAX_MARGIN, SCROLL_DEPTH };

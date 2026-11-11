import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { SpotlightMeasurement, SpotlightRect } from './useSpotlightRects';

/** The one move between two steps: the card host, the card's box and every cutout share it. */
export const TOUR_MOVE_MS = 460;
/** easeOutCubic: a calm start that is already under way on the first frame, and a soft landing. Nothing overshoots. */
export const TOUR_MOVE_EASE = 'cubic-bezier(0.33, 1, 0.68, 1)';
/** The old card's content fades where it stands before anything moves (the wait for the new targets hides in it). */
export const TOUR_LEAVE_MS = 120;
/**
 * How long after a step begins its commit may be issued. A frame short of the leave: a commit only reaches the screen on
 * the frame after it, so the move's first frame is the one on which the old content has just gone.
 */
export const TOUR_LEAVE_GATE_MS = TOUR_LEAVE_MS - 16;
/** A measurement must hold this many frames, and at least this long, to count as still (a busy page can run frames back to back). */
const STILL_FRAMES = 2;
const STILL_MS = 48;
/** The longest a step waits for all of its targets to exist and hold still; then it commits what it has. */
export const TOUR_SETTLE_CAP_MS = 600;
/** Within a step the cutouts (and the card beside them) move again only for a change bigger than this. */
const RECT_DISTANCE = 2;

export interface SpotlightCommit {
  /** The step (run:act:beat, plus a phase within the beat) these rects were committed for: the step the tour shows. */
  key: string;
  rects: readonly SpotlightRect[];
  /** False for the first placement and for a viewport resize, which jump; true for a move. */
  animate: boolean;
  /** Bumps on every commit, including a second one within a step. */
  serial: number;
}

interface CommitOptions {
  /** The step to show next. A change always travels, however small. */
  key: string;
  /** `spotlightTargetKey` of that step's targets: a measurement for any other list is ignored. */
  targetsKey: string;
  measurement: SpotlightMeasurement;
  /** False under reduced motion: the commit then never waits for the old content to leave. */
  motion: boolean;
  /** False when nothing has to leave before the move: the step before had no card, or the next one has none (the card then fades out where it stands as the spotlight sets off). */
  leaves?: boolean;
  /** Whether the card is still on its way (its move's animations have not finished): a commit within a step waits for it. */
  moving?: () => boolean;
}

const isFar = (a: readonly SpotlightRect[], b: readonly SpotlightRect[]) => a.length !== b.length
  || a.some((r, i) => [r.x - b[i].x, r.y - b[i].y, r.width - b[i].width, r.height - b[i].height].some((d) => Math.abs(d) > RECT_DISTANCE));

/**
 * Where a step's time goes between the user's press and the move, as User Timing marks (`editor-tour:step`, `:targets`,
 * `:still`, `:commit`, each with the step's key as its detail): what `scripts/tour-motion-trace.mjs` reads its latency
 * breakdown from, and what a performance recording of a real device shows on its timings track.
 */
function mark(name: 'step' | 'targets' | 'still' | 'commit', key: string): void {
  try { performance.mark?.(`editor-tour:${name}`, { detail: key }); } catch { /* no User Timing */ }
}

const signatureOf = (m: SpotlightMeasurement) => `${m.key}|${m.complete}|${m.still ?? ''}|${m.rects.map((r) => `${r.x},${r.y},${r.width},${r.height}`).join(';')}`;

/** A height change up to this, at the same width, is a phone's URL bar or toolbar coming or going, not a resize. */
const BROWSER_CHROME_PX = 160;

/**
 * The viewport, as far as "jump, don't glide" is concerned. A phone's browser changes the window's height as its URL bar
 * collapses and returns; treating that as a resize would re-place the card unanimated in the middle of a step. Those
 * changes are left to the ordinary rule (a target that really moved is followed once it holds still).
 */
function useViewportKey(): string {
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setViewport((previous) => (
      previous.width === window.innerWidth && Math.abs(previous.height - window.innerHeight) <= BROWSER_CHROME_PX ? previous : { width: window.innerWidth, height: window.innerHeight }
    ));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return `${viewport.width}x${viewport.height}`;
}

/**
 * Decides a step's spotlight in full before anything moves, so the card and every cutout move once, together, and never
 * change destination mid-flight:
 *  - a new step commits only once a measurement of ITS targets (never the previous step's) has every target on screen and
 *    has held still, and (with motion) the old content has had its leave (`TOUR_LEAVE_GATE_MS`); after `TOUR_SETTLE_CAP_MS` it
 *    commits whatever of its targets it has;
 *  - within a step, a change of more than a couple of pixels commits again the same way, but never while the last move is
 *    still in flight;
 *  - a viewport resize commits at once, without animation.
 * Before the first commit the current measurement passes through unanimated.
 */
export function useSettledRects({ key, targetsKey, measurement, motion, moving, leaves = true }: CommitOptions): SpotlightCommit {
  const viewport = useViewportKey();
  const valid = measurement.key === targetsKey;
  const [state, setState] = useState<SpotlightCommit | null>(null);
  const committed = useRef<(SpotlightCommit & { at: number; viewport: string }) | null>(null);
  const latest = useRef({ key, valid, measurement, motion, viewport, moving, leaves });
  latest.current = { key, valid, measurement, motion, viewport, moving, leaves };
  // When this step began: the render that first saw it (inside the press's own handler), which is also when the old
  // content starts to leave. Its clocks (the leave, the cap) run from here.
  const began = useRef({ key, at: 0 });
  if (began.current.key !== key) {
    began.current = { key, at: performance.now() };
    mark('step', key);
  }
  const loop = useRef({ frame: 0, since: null as number | null, sinceKey: '', capTimer: undefined as ReturnType<typeof setTimeout> | undefined, seenTargets: '', seenStill: '', signature: '', changedAt: 0, frames: 0, jump: false });

  // `inFrame`: called from an animation frame, where the commit can render at once and so paint in this very frame (the
  // move starts a frame sooner than a scheduled render would start it).
  // `capped`: the wait ran out with the targets still moving; what is committed is where they are now, not the reading
  // React last heard of (which, during a long slide, is where the slide began).
  const commit = (animate: boolean, at: number, inFrame = false, capped = false) => {
    const { key: nextKey, measurement: m, viewport: vp } = latest.current;
    const rects = capped && !m.still ? m.latest?.() ?? m.rects : m.rects;
    const next = { key: nextKey, rects, animate, serial: (committed.current?.serial ?? 0) + 1 };
    committed.current = { ...next, at, viewport: vp };
    loop.current.since = null;
    mark('commit', nextKey);
    if (inFrame) flushSync(() => setState(next));
    else setState(next);
  };

  const tick = (now: number, inFrame = true) => {
    const run = loop.current;
    if (run.frame && !inFrame) cancelAnimationFrame(run.frame);
    run.frame = 0;
    const { key: nextKey, valid: isValid, measurement: m, motion: moves, moving: inFlight, leaves: mustLeave } = latest.current;
    const signature = signatureOf(m);
    if (signature !== run.signature) {
      run.signature = signature;
      run.changedAt = now;
      run.frames = 0;
    } else if (inFrame) run.frames += 1;
    // The measuring hook says when its rects have come to rest; measurements that carry no such word are timed here.
    const still = isValid && (m.still === true || (m.still === undefined && run.frames >= STILL_FRAMES && now - run.changedAt >= STILL_MS));
    const again = () => { run.frame = requestAnimationFrame(tick); };
    const done = committed.current;
    const newStep = !done || done.key !== nextKey;
    if (newStep && isValid && m.complete) {
      if (run.seenTargets !== nextKey) { run.seenTargets = nextKey; mark('targets', nextKey); }
      if (still && run.seenStill !== nextKey) { run.seenStill = nextKey; mark('still', nextKey); }
    }
    if (!newStep && (!isValid || !isFar(done.rects, m.rects))) {
      run.since = null; // drifted back, or never left
      if (run.jump && !still) again();
      else run.jump = false;
      return;
    }
    run.since ??= now;
    const capped = now - run.since >= TOUR_SETTLE_CAP_MS;
    if (run.jump && !newStep) {
      // A resize: the targets reflow into place after it, and follow it unanimated.
      if (isValid && (still || capped)) { run.jump = false; commit(false, -Infinity, inFrame); } else again();
      return;
    }
    const left = !moves || !mustLeave || !newStep || !done || now - run.since >= TOUR_LEAVE_GATE_MS;
    const landed = newStep || !moves || (now - done.at >= TOUR_MOVE_MS && !inFlight?.());
    if (isValid && landed && ((still && m.complete && left) || capped)) commit(!!done, now, inFrame, capped && !(still && m.complete));
    else again();
  };

  useEffect(() => {
    const run = loop.current;
    const done = committed.current;
    if (done && done.viewport !== viewport && valid) {
      run.jump = true;
      commit(false, -Infinity);
    } else if (!done && valid && measurement.complete) {
      commit(false, -Infinity);
      return;
    }
    // A new step's clock (the old content's leave, the cap) starts as the step does, not a frame later.
    if (done && done.key !== key && run.sinceKey !== key) {
      run.sinceKey = key;
      run.since = began.current.at;
      // The cap is a wall-clock bound: where frames are not coming (a throttled or stalled page) a timer still ends the wait.
      clearTimeout(run.capTimer);
      run.capTimer = setTimeout(() => tick(performance.now(), false), TOUR_SETTLE_CAP_MS + 20);
    }
    // Looked at now, not on the next frame: a measurement that has just come to rest can commit at once.
    tick(performance.now(), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, targetsKey, signatureOf(measurement), viewport, motion]);

  useEffect(() => () => {
    const run = loop.current;
    if (run.frame) cancelAnimationFrame(run.frame);
    clearTimeout(run.capTimer);
  }, []);

  return state ?? { key, rects: valid ? measurement.rects : [], animate: false, serial: 0 };
}

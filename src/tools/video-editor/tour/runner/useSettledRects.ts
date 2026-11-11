import { useEffect, useRef, useState } from 'react';
import type { SpotlightMeasurement, SpotlightRect } from './useSpotlightRects';

/** The one move between two steps: the card host, the card's box and every cutout share it. */
export const TOUR_MOVE_MS = 460;
/** easeOutCubic: a calm start that is already under way on the first frame, and a soft landing. Nothing overshoots. */
export const TOUR_MOVE_EASE = 'cubic-bezier(0.33, 1, 0.68, 1)';
/** The old card's content fades where it stands before anything moves (the wait for the new targets hides in it). */
export const TOUR_LEAVE_MS = 120;
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
  /** False when the next step keeps the card's content (a land beat's watch unfolding): nothing has to leave first. */
  leaves?: boolean;
  /** Whether the card is still on its way (its move's animations have not finished): a commit within a step waits for it. */
  moving?: () => boolean;
}

const isFar = (a: readonly SpotlightRect[], b: readonly SpotlightRect[]) => a.length !== b.length
  || a.some((r, i) => [r.x - b[i].x, r.y - b[i].y, r.width - b[i].width, r.height - b[i].height].some((d) => Math.abs(d) > RECT_DISTANCE));

const signatureOf = (m: SpotlightMeasurement) => `${m.key}|${m.complete}|${m.rects.map((r) => `${r.x},${r.y},${r.width},${r.height}`).join(';')}`;

function useViewportKey(): string {
  const read = () => `${window.innerWidth}x${window.innerHeight}`;
  const [viewport, setViewport] = useState(read);
  useEffect(() => {
    const onResize = () => setViewport(read);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return viewport;
}

/**
 * Decides a step's spotlight in full before anything moves, so the card and every cutout move once, together, and never
 * change destination mid-flight:
 *  - a new step commits only once a measurement of ITS targets (never the previous step's) has every target on screen and
 *    has held still, and (with motion) the old content has had `TOUR_LEAVE_MS` to leave; after `TOUR_SETTLE_CAP_MS` it
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
  const loop = useRef({ frame: 0, since: null as number | null, signature: '', changedAt: 0, frames: 0, jump: false });

  const commit = (animate: boolean, at: number) => {
    const { key: nextKey, measurement: m, viewport: vp } = latest.current;
    const next = { key: nextKey, rects: m.rects, animate, serial: (committed.current?.serial ?? 0) + 1 };
    committed.current = { ...next, at, viewport: vp };
    loop.current.since = null;
    setState(next);
  };

  const tick = (now: number) => {
    const run = loop.current;
    run.frame = 0;
    const { key: nextKey, valid: isValid, measurement: m, motion: moves, moving: inFlight, leaves: mustLeave } = latest.current;
    const signature = signatureOf(m);
    if (signature !== run.signature) {
      run.signature = signature;
      run.changedAt = now;
      run.frames = 0;
    } else run.frames += 1;
    const still = isValid && run.frames >= STILL_FRAMES && now - run.changedAt >= STILL_MS;
    const again = () => { run.frame = requestAnimationFrame(tick); };
    const done = committed.current;
    const newStep = !done || done.key !== nextKey;
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
      if (isValid && (still || capped)) { run.jump = false; commit(false, -Infinity); } else again();
      return;
    }
    const left = !moves || !mustLeave || !newStep || !done || now - run.since >= TOUR_LEAVE_MS;
    const landed = newStep || !moves || (now - done.at >= TOUR_MOVE_MS && !inFlight?.());
    if (isValid && landed && ((still && m.complete && left) || capped)) commit(!!done, now);
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
    if (!run.frame) run.frame = requestAnimationFrame(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, targetsKey, signatureOf(measurement), viewport, motion]);

  useEffect(() => () => { if (loop.current.frame) cancelAnimationFrame(loop.current.frame); }, []);

  return state ?? { key, rects: valid ? measurement.rects : [], animate: false, serial: 0 };
}

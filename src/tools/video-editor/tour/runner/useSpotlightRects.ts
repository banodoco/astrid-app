import { useEffect, useState } from 'react';
import { EDITOR_TOUR_ANCHOR_ATTRIBUTE, EDITOR_TOUR_ANCHORS, EDITOR_TOUR_CARD_HOST_ATTRIBUTE, EDITOR_TOUR_SHIELD_ATTRIBUTE, EDITOR_TOUR_TRACK_ATTRIBUTE } from '../anchors';
import { CLIP_BODY_SELECTOR } from '../../lib/timeline-dom';

export interface SpotlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PADDING = 6;

interface Box { left: number; top: number; right: number; bottom: number }

/**
 * The part of an element its scrolling or clipping ancestors actually show (a timeline row is wider than the timeline),
 * and where its spotlight's padding may reach (`bounds`): the viewport, and a scrolling panel's own edges, so the
 * transcript's light never spills into the chat header.
 */
function visibleBox(element: Element): { visible: Box; bounds: Box } {
  const box = element.getBoundingClientRect();
  const visible = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  const { scrolls, clips } = clipping(element);
  const bounds = scrolls
    ? { left: Math.max(0, box.left), top: Math.max(0, box.top), right: Math.min(window.innerWidth, box.right), bottom: Math.min(window.innerHeight, box.bottom) }
    : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  for (const { parent, x, y } of clips) {
    const clip = parent.getBoundingClientRect();
    if (x) {
      visible.left = Math.max(visible.left, clip.left);
      visible.right = Math.min(visible.right, clip.right);
    }
    if (y) {
      visible.top = Math.max(visible.top, clip.top);
      visible.bottom = Math.min(visible.bottom, clip.bottom);
    }
  }
  return { visible, bounds };
}

interface Clipping {
  /** The element's ancestors, as they were when the styles below were read. */
  chain: Element[];
  scrolls: boolean;
  /** The ancestors that clip, and on which axes. */
  clips: Array<{ parent: Element; x: boolean; y: boolean }>;
}

const clippingCache = new WeakMap<Element, Clipping>();

/** Forget what was read, when the page around the targets has changed (nodes added or removed, the window resized). */
function forgetClipping(elements: Iterable<Element>): void {
  for (const element of elements) clippingCache.delete(element);
}

/**
 * Which of an element's ancestors clip it. Reading every ancestor's computed style is the costly part of a measurement,
 * and it only changes when the ancestry does, so it is read once per ancestry and reused while the element is followed
 * frame by frame.
 */
function clipping(element: Element): Clipping {
  const chain: Element[] = [];
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) chain.push(parent);
  const cached = clippingCache.get(element);
  if (cached && cached.chain.length === chain.length && cached.chain.every((parent, i) => parent === chain[i])) return cached;
  const own = getComputedStyle(element);
  const clips: Clipping['clips'] = [];
  for (const parent of chain) {
    const { overflowX, overflowY } = getComputedStyle(parent);
    if (overflowX !== 'visible' || overflowY !== 'visible') clips.push({ parent, x: overflowX !== 'visible', y: overflowY !== 'visible' });
  }
  const fresh = { chain, scrolls: /auto|scroll/.test(`${own.overflowX} ${own.overflowY}`), clips };
  clippingCache.set(element, fresh);
  return fresh;
}

const TRANSCRIPT_PADDING = 12;

/**
 * Where an element's content ends, when it is shorter than the element: a track row runs the timeline's whole width but
 * its spotlight ends with its last clip, and the chat transcript's ends below its last message. The empty rest stays
 * dimmed and free for the card.
 */
function contentExtent(element: Element, box: Box): Box {
  if (element.hasAttribute(EDITOR_TOUR_TRACK_ATTRIBUTE)) {
    const clips = Array.from(element.querySelectorAll(CLIP_BODY_SELECTOR), (clip) => clip.getBoundingClientRect().right);
    return clips.length ? { ...box, right: Math.min(box.right, Math.max(...clips)) } : box;
  }
  if (element.getAttribute(EDITOR_TOUR_ANCHOR_ATTRIBUTE) === EDITOR_TOUR_ANCHORS.chatTranscript) {
    const children = Array.from(element.children, (child) => child.getBoundingClientRect()).filter((rect) => rect.height > 0);
    const end = Math.max(...children.map((rect) => rect.bottom)) + TRANSCRIPT_PADDING;
    return children.length ? { ...box, bottom: Math.max(box.top + 2 * TRANSCRIPT_PADDING, Math.min(box.bottom, end)) } : box;
  }
  return box;
}

/**
 * What the spotlight lights: a selector (its content extent, see `contentExtent`), or `{ selector, whole: true }` for the
 * element's whole visible box (a scrolling transcript while it fills up, so the light holds still).
 */
export type SpotlightTarget = string | { readonly selector: string; readonly whole: true };

const selectorOf = (target: SpotlightTarget) => (typeof target === 'string' ? target : target.selector);

/** One string per target list: a measurement carries the key of the targets it measured. */
export function spotlightTargetKey(targets: readonly SpotlightTarget[]): string {
  return targets.map((target) => (typeof target === 'string' ? target : `${target.selector}#whole`)).join('|');
}

function parseTargetKey(key: string): SpotlightTarget[] {
  return key ? key.split('|').map((part) => (part.endsWith('#whole') ? { selector: part.slice(0, -'#whole'.length), whole: true as const } : part)) : [];
}

function measure(targets: readonly SpotlightTarget[]): SpotlightRect[] {
  const rects: SpotlightRect[] = [];
  for (const target of targets) {
    const element = document.querySelector(selectorOf(target));
    if (!element) continue;
    const { visible, bounds } = visibleBox(element);
    const extent = typeof target === 'string' ? contentExtent(element, visible) : visible;
    // Only the part on screen: a pane still outside it (sliding in) has nothing to light yet.
    const box = { left: Math.max(bounds.left, extent.left), top: Math.max(bounds.top, extent.top), right: Math.min(bounds.right, extent.right), bottom: Math.min(bounds.bottom, extent.bottom) };
    if (box.right - box.left <= 0 || box.bottom - box.top <= 0) continue;
    const padded = {
      left: Math.max(bounds.left, box.left - PADDING),
      top: Math.max(bounds.top, box.top - PADDING),
      right: Math.min(bounds.right, box.right + PADDING),
      bottom: Math.min(bounds.bottom, box.bottom + PADDING),
    };
    rects.push({ x: padded.left, y: padded.top, width: padded.right - padded.left, height: padded.bottom - padded.top });
  }
  return rects;
}

function sameRects(a: readonly SpotlightRect[], b: readonly SpotlightRect[]): boolean {
  return a.length === b.length
    && a.every((r, i) => r.x === b[i].x && r.y === b[i].y && r.width === b[i].width && r.height === b[i].height);
}

/** A CSS transition or animation moving a target (the chat pane sliding in) fires none of the other events. */
const MOTION_EVENTS = ['transitionrun', 'transitionend', 'animationstart', 'animationend'] as const;

/** A measurement of one target list: `key` says which (`spotlightTargetKey`), `complete` that every target was on screen. */
export interface SpotlightMeasurement {
  key: string;
  rects: readonly SpotlightRect[];
  complete: boolean;
  /** The rects have held for a couple of frames: nothing is sliding, so whoever waits for stillness need wait no longer. */
  still?: boolean;
}

const sameMeasurement = (a: SpotlightMeasurement, b: SpotlightMeasurement) => a.key === b.key && a.complete === b.complete && sameRects(a.rects, b.rects);

/** A measurement counts as still once it has held this many frames, and at least this long (a busy page runs frames back to back). */
const STILL_FRAMES = 2;
const STILL_MS = 48;
/** How often the targets are looked at when nothing has announced a change: a shift that fired no event is still found. */
const CHECK_MS = 1000;

/** Whether what happens inside this target can change its rect without resizing it: a row's clips, the transcript's messages. */
function hasContentExtent(target: SpotlightTarget, element: Element): boolean {
  return typeof target === 'string' && (element.hasAttribute(EDITOR_TOUR_TRACK_ATTRIBUTE) || element.getAttribute(EDITOR_TOUR_ANCHOR_ATTRIBUTE) === EDITOR_TOUR_ANCHORS.chatTranscript);
}

const OWN_OVERLAY = `[${EDITOR_TOUR_CARD_HOST_ATTRIBUTE}], [${EDITOR_TOUR_SHIELD_ATTRIBUTE}]`;

/**
 * Viewport rects of the first element matching each target, tagged with the target list they were measured for: on the
 * render where the targets change, the result still carries the old key (and the old rects), so nothing downstream can
 * take the previous beat's rects for the new beat's.
 *
 * A target still moving (a pane sliding in) is followed frame by frame, but in a ref: React hears of a new target list's
 * first measurement, of a change in completeness, and then only of rects that have held still (`still`). A slide costs a
 * couple of renders, not one per frame.
 *
 * What wakes a measurement is kept to what can move a target: a target or its content resizing, a node added or removed
 * around a target (or anywhere, while a target is still missing), an ancestor scrolling, a transition or animation on a
 * target or an ancestor, the window resizing; plus a slow periodic look for anything that announced nothing. Changes
 * inside the tour's own card and shield, inside a target whose box they cannot change (the composer as the prompt is
 * typed, the transcript's box as the reply streams) or elsewhere on the page wake nothing.
 */
export function useSpotlightMeasurement(targets: readonly SpotlightTarget[]): SpotlightMeasurement {
  const key = spotlightTargetKey(targets);
  const [measurement, setMeasurement] = useState<SpotlightMeasurement>({ key: '', rects: [], complete: true, still: true });

  useEffect(() => {
    const list = parseTargetKey(key);
    const resizeObserver = new ResizeObserver(() => schedule());
    let observed = new Set<Element>();
    let found: Array<{ target: SpotlightTarget; element: Element }> = [];
    let frame = 0;
    let last: SpotlightMeasurement | null = null;
    let published: SpotlightMeasurement | null = null;
    let heldSince = 0;
    let heldFrames = 0;

    const publish = (next: SpotlightMeasurement): void => {
      published = next;
      setMeasurement((previous) => (sameMeasurement(previous, next) && !!previous.still === !!next.still ? previous : next));
    };

    function update(now: number = performance.now()) {
      frame = 0;
      found = list.flatMap((target) => { const element = document.querySelector(selectorOf(target)); return element ? [{ target, element }] : []; });
      const elements = new Set(found.map((entry) => entry.element));
      observed.forEach((el) => { if (!elements.has(el)) resizeObserver.unobserve(el); });
      elements.forEach((el) => { if (!observed.has(el)) resizeObserver.observe(el); });
      observed = elements;
      const rects = measure(list);
      const next: SpotlightMeasurement = { key, rects, complete: rects.length === list.length, still: false };
      if (last && sameMeasurement(last, next)) heldFrames += 1;
      else { heldFrames = 0; heldSince = now; }
      last = next;
      const still = heldFrames >= STILL_FRAMES && now - heldSince >= STILL_MS;
      // React hears of the first measurement, a change in completeness, and rects that have come to rest; never of a
      // frame of something sliding.
      const known = published;
      if (!known || known.complete !== next.complete) publish(next);
      if (!still) schedule();
      else if (!known?.still || !sameMeasurement(known, next)) publish({ ...next, still: true });
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }

    /** Whether something happening at `node` can move or reshape a target. */
    const concerns = (node: Node | null, kind: 'tree' | 'scroll' | 'motion'): boolean => {
      if (!(node instanceof Element)) return node === document || kind === 'tree';
      if (node.closest(OWN_OVERLAY)) return false;
      if (kind === 'tree' && found.length < list.length) return true;
      return found.some(({ target, element }) => {
        if (node === element) return kind === 'motion' || (kind === 'tree' && hasContentExtent(target, element));
        if (element.contains(node)) return kind !== 'scroll' && hasContentExtent(target, element);
        return node.contains(element);
      });
    };
    const mutationObserver = new MutationObserver((records) => {
      if (!records.some((record) => concerns(record.target, 'tree'))) return;
      forgetClipping(observed);
      schedule();
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    const onScroll = (event: Event) => { if (concerns(event.target as Node | null, 'scroll')) schedule(); };
    const onMotion = (event: Event) => { if (concerns(event.target as Node | null, 'motion')) schedule(); };
    const onResize = () => { forgetClipping(observed); schedule(); };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    MOTION_EVENTS.forEach((type) => window.addEventListener(type, onMotion, { capture: true, passive: true }));
    const check = setInterval(schedule, CHECK_MS);
    update();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      clearInterval(check);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, { capture: true });
      MOTION_EVENTS.forEach((type) => window.removeEventListener(type, onMotion, { capture: true }));
    };
  }, [key]);

  return measurement;
}

const NO_RECTS: SpotlightRect[] = [];

/** The rects alone, for the current targets only (empty until they have been measured). */
export function useSpotlightRects(targets: readonly SpotlightTarget[]): readonly SpotlightRect[] {
  const measurement = useSpotlightMeasurement(targets);
  return measurement.key === spotlightTargetKey(targets) ? measurement.rects : NO_RECTS;
}

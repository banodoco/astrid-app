import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { TOUR_LEAVE_MS, TOUR_MOVE_EASE, TOUR_MOVE_MS } from './useSettledRects';

/** The new content fades up over the last part of the move, so it is whole just as the card comes to rest. */
export const TOUR_ARRIVE_DELAY_MS = 150;
export const TOUR_ARRIVE_MS = TOUR_MOVE_MS - TOUR_ARRIVE_DELAY_MS;
/** ...and rises this far into place as it does. */
const ARRIVE_RISE_PX = 4;

const SECTION = 'section';
const CONTENT = '[data-editor-tour-card-content]';
/** The part of a land card under its counter row; `data-folded` while the result plays alone (the watch). */
const REST = '[data-editor-tour-card-rest]';
/** A watch step's key is its explainer step's key plus this. */
export const WATCH_SUFFIX = ':watch';

export interface CardSize {
  /** The step this size was measured for. */
  key: string;
  width: number;
  height: number;
}

interface CardMoveOptions {
  /** The step the card shows (the committed key). */
  key: string;
  /** Whether this step's commit travels (false for the first card and for a viewport resize). */
  animate: boolean;
  /** False under reduced motion. */
  motion: boolean;
  /** The store has moved on and the card still shows the previous step: its content leaves where it stands. */
  pending: boolean;
}

function clearStyles(element: HTMLElement | null, properties: readonly string[]) {
  if (!element) return;
  for (const property of properties) element.style.removeProperty(property);
}

/**
 * The card's side of the one move. When the store moves on, the old content fades where it stands (`TOUR_LEAVE_MS`) and its
 * box holds still. When the runner commits the next step, the new content is measured before paint (so the card's
 * destination is known from the first frame), the box morphs from the old size to the new one over `TOUR_MOVE_MS` while
 * the host travels, and the new content fades up over the last part of the move, laid out at its final width throughout
 * so no text re-wraps. `arrivedKey` turns to the step's key as the card comes to rest: the card's own entrance starts then.
 * Without motion, or for a jump, the card simply is there, arrived.
 */
/** The longest the card waits for its move's animations to report finished (a stalled page can hold them). */
const ARRIVE_CAP_MS = TOUR_MOVE_MS + 1500;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Resolves when the move has really ended: every animation on the card's host and box (its travel, its morph and the
 * content's fade) has finished. On a busy page transitions start late, so a clock alone ends the morph while the box is
 * still mid-size. Falls back to the clock where the Web Animations API is missing.
 */
async function moveFinished(elements: readonly (Element | null)[]): Promise<void> {
  const live = elements.filter((element): element is Element => !!element);
  if (live.some((element) => typeof element.getAnimations !== 'function')) {
    await new Promise((resolve) => setTimeout(resolve, TOUR_MOVE_MS));
    return;
  }
  // The host's travel starts on the render after the morph does (once the new size is known): look a frame later.
  await nextFrame();
  const animations = live.flatMap((element) => element.getAnimations());
  await Promise.race([
    Promise.allSettled(animations.map((animation) => animation.finished)),
    new Promise((resolve) => setTimeout(resolve, ARRIVE_CAP_MS)),
  ]);
}

export function useCardMove(hostRef: RefObject<HTMLElement | null>, { key, animate, motion, pending }: CardMoveOptions): { size: CardSize | null; arrivedKey: string | null; moving: () => boolean } {
  const [size, setSize] = useState<CardSize | null>(null);
  const [arrivedKey, setArrivedKey] = useState<string | null>(null);
  /** The shown card's box (border-box), the morph's starting size. */
  const box = useRef<{ width: number; height: number } | null>(null);
  const morph = useRef<{ section: HTMLElement; content: HTMLElement | null } | null>(null);
  const left = useRef<HTMLElement | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  const shownKey = useRef<string | null>(null);

  const readSize = (forKey: string) => {
    const host = hostRef.current;
    if (!host) return;
    // Read now: the updater runs at the next render, after the morph has given the box its starting size.
    const width = host.offsetWidth;
    // During a watch the card is placed for the size it will unfold to, so it then unfolds without moving.
    const height = host.offsetHeight + (host.querySelector<HTMLElement>(`${REST}[data-folded]`)?.scrollHeight ?? 0);
    setSize((previous) => (previous && previous.key === forKey && previous.width === width && previous.height === height ? previous : { key: forKey, width, height }));
  };

  const endMorph = () => {
    const current = morph.current;
    if (!current) return;
    clearStyles(current.section, ['width', 'height', 'overflow', 'transition']);
    clearStyles(current.content, ['width', 'opacity', 'transform', 'transition']);
    morph.current = null;
  };

  useLayoutEffect(() => {
    const host = hostRef.current;
    const section = host?.querySelector<HTMLElement>(SECTION) ?? null;
    endMorph();
    if (!host || !section) {
      setArrivedKey(key);
      return;
    }
    const content = section.querySelector<HTMLElement>(CONTENT);
    const from = box.current;
    const natural = { width: section.offsetWidth, height: section.offsetHeight };
    box.current = natural;
    left.current = null;
    const unfolds = shownKey.current === `${key}${WATCH_SUFFIX}`;
    shownKey.current = key;
    readSize(key);
    if (!motion || !animate || !from) {
      setArrivedKey(key);
      return;
    }
    if (unfolds) {
      // The watch is over: the same card, where it already is. Its counter row stays put; the box unfolds downward from
      // it and the rest fades up, as arriving content does.
      const rest = section.querySelector<HTMLElement>(REST);
      Object.assign(section.style, { transition: 'none', overflow: 'hidden', height: `${from.height}px` });
      if (rest) Object.assign(rest.style, { transition: 'none', opacity: '0', transform: `translateY(${ARRIVE_RISE_PX}px)` });
      void section.offsetWidth;
      Object.assign(section.style, { transition: `height ${TOUR_MOVE_MS}ms ${TOUR_MOVE_EASE}`, height: `${natural.height}px` });
      if (rest) {
        Object.assign(rest.style, {
          transition: `opacity ${TOUR_ARRIVE_MS}ms ease-out ${TOUR_ARRIVE_DELAY_MS}ms, transform ${TOUR_ARRIVE_MS}ms ${TOUR_MOVE_EASE} ${TOUR_ARRIVE_DELAY_MS}ms`,
          opacity: '1',
          transform: 'translateY(0)',
        });
      }
      const unfolding = { section, content: rest };
      morph.current = unfolding;
      void moveFinished([host, section, rest]).then(() => {
        if (morph.current !== unfolding) return;
        endMorph();
        readSize(key);
        setArrivedKey(key);
      });
      return;
    }
    const contentWidth = content?.offsetWidth ?? 0;
    // FLIP: the new box starts at the old one's size; its content starts invisible, at its final width.
    Object.assign(section.style, { transition: 'none', overflow: 'hidden', width: `${from.width}px`, height: `${from.height}px` });
    if (content) Object.assign(content.style, { transition: 'none', width: `${contentWidth}px`, opacity: '0', transform: `translateY(${ARRIVE_RISE_PX}px)` });
    void section.offsetWidth;
    Object.assign(section.style, {
      transition: `width ${TOUR_MOVE_MS}ms ${TOUR_MOVE_EASE}, height ${TOUR_MOVE_MS}ms ${TOUR_MOVE_EASE}`,
      width: `${natural.width}px`,
      height: `${natural.height}px`,
    });
    if (content) {
      Object.assign(content.style, {
        transition: `opacity ${TOUR_ARRIVE_MS}ms ease-out ${TOUR_ARRIVE_DELAY_MS}ms, transform ${TOUR_ARRIVE_MS}ms ${TOUR_MOVE_EASE} ${TOUR_ARRIVE_DELAY_MS}ms`,
        opacity: '1',
        transform: 'translateY(0)',
      });
    }
    const current = { section, content };
    morph.current = current;
    void moveFinished([host, section, content]).then(() => {
      if (morph.current !== current) return; // interrupted: a newer step, or the store moved on
      endMorph();
      readSize(key);
      setArrivedKey(key);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // The old content leaves where it stands while the next step is decided; its box freezes where it is (mid-morph too).
  useLayoutEffect(() => {
    const section = hostRef.current?.querySelector<HTMLElement>(SECTION);
    const content = section?.querySelector<HTMLElement>(CONTENT) ?? null;
    if (!section || !content) return;
    if (pending && motion) {
      const rect = section.getBoundingClientRect();
      if (morph.current) {
        morph.current = null;
        Object.assign(section.style, { transition: 'none', width: `${rect.width}px`, height: `${rect.height}px` });
      }
      box.current = { width: rect.width, height: rect.height };
      Object.assign(content.style, { transition: `opacity ${TOUR_LEAVE_MS}ms ease-out`, opacity: '0' });
      left.current = content;
    } else if (!pending && left.current === content) {
      // Back to the step it shows before anything moved: its content returns, its box to its own size.
      clearStyles(section, ['width', 'height', 'overflow', 'transition']);
      clearStyles(content, ['width', 'transform']);
      box.current = { width: section.offsetWidth, height: section.offsetHeight };
      Object.assign(content.style, { transition: `opacity ${TOUR_LEAVE_MS}ms ease-out`, opacity: '1' });
      left.current = null;
      readSize(keyRef.current);
      setArrivedKey(keyRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  // Later size changes within a step (content loading in). The morph's own frames are not one.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => {
      if (!morph.current) readSize(keyRef.current);
    });
    observer.observe(host);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => () => { morph.current = null; }, []);

  return { size, arrivedKey, moving: () => morph.current !== null };
}

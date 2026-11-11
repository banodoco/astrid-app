import { Component, createRef, type MutableRefObject, type ReactNode } from 'react';

export const CALLOUT_MOVE_MS = 720;
// Alternate connector choreography: lead, partially retract at a controlled speed,
// wait for an explicit extension time (or settled cards when entering Agent), then reconnect.
export const CALLOUT_VACUUM_LEAD_MS = 80;
// Retraction is deliberately slower than the previous 240/300ms collapse. The
// connector remains visible while the cards travel, then holds its residual stub.
export const CALLOUT_VACUUM_RETRACT_MS = 450;
export const CALLOUT_VACUUM_PHONE_RETRACT_MS = 360;
export const CALLOUT_VACUUM_EXTEND_MS = 380;
export const CALLOUT_VACUUM_PHONE_EXTEND_MS = 440;
export const CALLOUT_VACUUM_RECONNECT_STAGGER_MS = 140;
export const CALLOUT_VACUUM_SETTLE_MS = 24;
export const CALLOUT_VACUUM_POST_CONNECT_SETTLE_MS = 180;
// Keep the final control-point convergence finite so the last painted organic
// frame cannot be followed by an ungated canonical snap.
export const CALLOUT_VACUUM_CANONICALIZE_MS = 280;
export const CALLOUT_GEOMETRY_EPSILON_PX = 2;
export const CALLOUT_VACUUM_PRIME_DISTANCE_PX = 64;
export const CALLOUT_VACUUM_RESIDUAL_RATIO = 0.2;
// The organic control handoff is intentionally longer than the prime lead. The
// first painted curve must remain the exact synchronous prime, then let long
// moving connectors follow the new S-bend with a soft tail instead of taking a
// large fraction of a recomputed baseline on one compositor frame.
export const CALLOUT_CURVE_HANDOFF_MS = 480;
const CALLOUT_CONTENT_FADE_OUT_MS = 360;
export type CalloutTransitionPhase = 'retracting' | 'waiting-for-layout' | 'extending' | 'canonicalizing';
export interface CalloutMove {
  epoch: number;
  phase: CalloutTransitionPhase;
  started: number;
  settledAt?: number;
  boxes: DOMRect[];
  destinations: DOMRect[];
  curves: number[][];
  /** The exact local SVG curves painted synchronously before the new audience layout is exposed. */
  primedCurves: number[][];
  /** Last painted time per slot; controls use it for a frame-rate-independent handoff. */
  curveLastPaintedAt: Array<number | undefined>;
  paintedCurves: number[][];
  /** Control velocities (px/ms), carried through the terminal latch. */
  curveVelocities: number[][];
  canonicalizeVelocities: number[][];
  canonicalizeFrom: number[][];
  /** Exact settled canonical curve captured per slot for the terminal frame. */
  canonicalTarget: number[][];
  canonicalizeStartedAt: Array<number | undefined>;
  canonicalFramePainted: boolean[];
  extensionStartedAt: Array<number | undefined>;
  staggerIndices: number[];
  pulseEpoch: Array<number | undefined>;
  retractLengths: Array<number | undefined>;
  targetReady: boolean[];
}
interface Props {
  audience: string;
  reducedMotion: boolean;
  active: boolean;
  move: MutableRefObject<CalloutMove | null>;
  children: ReactNode;
}
/** Keep in step with the phone breakpoint in PublicAstridShell.css. */
const PHONE_QUERY = '(max-width: 640px)';
interface Snapshot {
  epoch: number;
  origin: DOMRect;
  boxes: DOMRect[];
  curves: number[][];
  content: HTMLElement[][];
  /** Static copies of each card and its connector, for a slot that fades in place instead of moving. */
  cardCopies: HTMLElement[];
  connectorCopies: SVGGElement[];
}
/** The live connector paths, never a fading copy's. */
const CONNECTOR_PATHS = ':scope > .astrid-callout-connectors:not([data-callout-ghost]) path';
const GHOST_FADE_MS = 280;
const GHOST_SCALE = .94;

function primeRetractedCurve(curve: number[]) {
  if (curve.length !== 8) return curve;
  const dx = curve[0] - curve[6];
  const dy = curve[1] - curve[7];
  const length = Math.hypot(dx, dy);
  if (!length) return curve;
  const distance = Math.min(
    Math.max(0, length - 24),
    Math.min(CALLOUT_VACUUM_PRIME_DISTANCE_PX, Math.max(32, length * 0.2)),
  );
  const progress = distance / length;
  return [curve[0], curve[1], curve[2], curve[3], curve[4], curve[5], curve[6] + dx * progress, curve[7] + dy * progress];
}

/** Capture before React changes audience attributes/layout; a layout-effect cleanup is too late.
 * Persistent slots let interrupted switches start from the actual currently painted geometry. */
export class PublicAstridCalloutLayout extends Component<Props> {
  private root = createRef<HTMLDivElement>();
  private animations: Animation[] = [];
  private transitionEpoch = 0;

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    if (previous.audience === this.props.audience || !this.props.active || this.props.reducedMotion) return null;
    const root = this.root.current!;
    const origin = root.getBoundingClientRect();
    const cards = [...root.querySelectorAll<HTMLElement>('article')];
    const epoch = ++this.transitionEpoch;
    this.props.move.current = {
      epoch,
      phase: 'retracting',
      started: performance.now(),
      boxes: cards.map(card => card.getBoundingClientRect()),
      destinations: [],
      curves: [],
      primedCurves: [],
      curveLastPaintedAt: [],
      paintedCurves: [],
      curveVelocities: [],
      canonicalizeVelocities: [],
      canonicalizeFrom: [],
      canonicalTarget: [],
      canonicalizeStartedAt: [],
      canonicalFramePainted: [],
      extensionStartedAt: cards.map(() => undefined),
      staggerIndices: [],
      pulseEpoch: cards.map(() => undefined),
      retractLengths: cards.map(() => undefined),
      targetReady: cards.map(() => false),
    };
    const snapshot: Snapshot = {
      epoch,
      origin,
      boxes: cards.map(card => card.getBoundingClientRect()),
      cardCopies: cards.map(card => card.cloneNode(true) as HTMLElement),
      connectorCopies: [...root.querySelectorAll<SVGPathElement>(CONNECTOR_PATHS)]
        .map(path => path.parentElement!.cloneNode(true) as SVGGElement),
      curves: [...root.querySelectorAll(CONNECTOR_PATHS)].map((path, index) => {
        const current = (path.getAttribute('d')?.match(/-?\d+(?:\.\d+)?/g) ?? []).map((value, coordinate) => Number(value) + (coordinate % 2 ? origin.top : origin.left));
        // A target can briefly be unavailable during a reversal. Preserve that slot's
        // last known curve so the next move still has a real retract origin.
        return current.length === 8 ? current : this.props.move.current?.curves[index] ?? [];
      }),
      // Preserve the currently painted text blend too, including an interrupted crossfade.
      content: cards.map(card => [...card.querySelectorAll<HTMLElement>(':scope > .astrid-callout-content, :scope > .astrid-callout-outgoing')].map(layer => {
        const clone = layer.cloneNode(true) as HTMLElement;
        const style = getComputedStyle(layer);
        Object.assign(clone.style, { opacity: style.opacity, translate: style.translate, width: style.width, position: 'absolute', inset: '0 auto auto 0' });
        return clone;
      })),
    };
    snapshot.curves.forEach((curve, index) => {
      const pending = this.props.move.current;
      if (pending && pending.epoch === epoch) pending.curves[index] = curve;
    });
    // A reconnect pulse belongs to the previous epoch's endpoint. Clear it before
    // React exposes the next audience so an interrupted switch cannot replay stale emphasis.
    root.querySelectorAll<SVGCircleElement>('.astrid-callout-ping').forEach((ping) => {
      ping.removeAttribute('data-astrid-reconnect-pulse');
    });
    return snapshot;
  }

  private stop = (clearMove = true) => {
    this.animations.forEach(animation => animation.cancel());
    this.animations = [];
    if (clearMove) this.props.move.current = null;
    this.root.current?.querySelectorAll<HTMLElement>('[data-layout-moving]').forEach(card => {
      card.removeAttribute('data-layout-moving');
      card.style.removeProperty('transform');
      card.style.removeProperty('translate');
      card.style.removeProperty('width');
      card.style.removeProperty('height');
      for (const property of ['left', 'top', 'right', 'bottom']) card.style.removeProperty(property);
    });
    this.root.current?.querySelectorAll('.astrid-callout-outgoing, [data-callout-ghost]').forEach(layer => layer.remove());
    this.root.current?.querySelectorAll<HTMLElement>('article > .astrid-callout-content').forEach(layer => layer.style.removeProperty('width'));
    this.root.current?.querySelectorAll<SVGCircleElement>('.astrid-callout-ping').forEach((ping) => {
      ping.removeAttribute('data-astrid-reconnect-pulse');
    });
  };

  componentDidUpdate(previous: Props, _state: unknown, snapshot: Snapshot | null) {
    if (!this.props.active || this.props.reducedMotion) { this.stop(); return; }
    if (previous.audience === this.props.audience || !snapshot) return;
    this.stop(false);
    const root = this.root.current!;
    const cards = [...root.querySelectorAll<HTMLElement>('article')];
    if (!cards.every(card => typeof card.animate === 'function')) return;
    const origin = root.getBoundingClientRect();
    const destinations = cards.map(card => card.getBoundingClientRect());
    const move = this.props.move.current;
    if (!move || move.epoch !== snapshot.epoch) return;
    // Which old card each slot morphs from. Desktop: Agent's visual order enters counterclockwise from App,
    // so App -> Agent pairs Effects -> Community, Models -> Tools, Timeline -> Workflows, and the reverse
    // keeps the established Agent -> App path.
    const phone = typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
    // Phone chips keep their place: left stays left (Effects <-> Community), right stays right
    // (Timeline <-> Tools), and the bottom chip stays below (Models <-> Workflows).
    const sourceOrder = phone && snapshot.boxes.length === 3
      ? [1, 0, 2]
      : previous.audience === 'app' && this.props.audience === 'agent'
        ? [1, 2, 0]
        : snapshot.boxes.map((_, index) => index);
    const sourceBoxes = sourceOrder.map(index => snapshot.boxes[index]);
    const above = (box: DOMRect, stage: DOMRect) => box.top + box.height / 2 < stage.top + stage.height / 2;
    const fadesInPlace = cards.map((_, index) => phone && !!sourceBoxes[index] && !!destinations[index]
      && above(sourceBoxes[index], snapshot.origin) !== above(destinations[index], origin));
    // A fading slot's connector grows out from under its new card instead of retracting across the demo.
    const sourceCurves = sourceOrder.map((index, slot) => {
      if (!fadesInPlace[slot]) return snapshot.curves[index];
      const to = destinations[slot];
      const centre = [to.left + to.width / 2, to.top + to.height / 2];
      return [...centre, ...centre, ...centre, ...centre];
    });
    const sourceContent = sourceOrder.map(index => snapshot.content[index]);
    move.boxes = sourceBoxes;
    move.destinations = destinations;
    move.curves = sourceCurves;
    move.primedCurves = cards.map(() => []);
    move.curveLastPaintedAt = cards.map(() => undefined);
    move.paintedCurves = cards.map(() => []);
    move.curveVelocities = cards.map(() => []);
    move.canonicalizeVelocities = cards.map(() => []);
    move.canonicalizeFrom = cards.map(() => []);
    move.canonicalTarget = cards.map(() => []);
    move.canonicalizeStartedAt = cards.map(() => undefined);
    move.canonicalFramePainted = cards.map(() => false);
    // A mobile audience change can shift the stage origin. Rebase the captured SVG before paint;
    // synchronously prime every path into a visibly retracted state so the new audience
    // cannot paint beside a fully extended old connector.
    root.querySelectorAll(CONNECTOR_PATHS).forEach((path, index) => {
      const curve = primeRetractedCurve(sourceCurves[index]).map((value, coordinate) => value - (coordinate % 2 ? origin.top : origin.left));
      if (curve.length !== 8) return;
      move.primedCurves[index] = curve;
      move.paintedCurves[index] = curve.slice();
      path.setAttribute('d', `M${curve[0]} ${curve[1]} C${curve.slice(2).join(' ')}`);
      path.setAttribute('data-connector-target', 'transition');
      const dots = path.parentElement!.querySelectorAll('circle[data-callout]');
      dots.forEach((dot, i) => {
        dot.setAttribute('cx', String(curve[i ? 6 : 0]));
        dot.setAttribute('cy', String(curve[i ? 7 : 1]));
      });
    });
    const ghostConnectors = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ghostConnectors.setAttribute('class', 'astrid-callout-connectors');
    ghostConnectors.setAttribute('aria-hidden', 'true');
    ghostConnectors.setAttribute('data-callout-ghost', '');
    // The copied connector was drawn against the old stage origin.
    ghostConnectors.style.translate = `${snapshot.origin.left - origin.left}px ${snapshot.origin.top - origin.top}px`;
    const fadeInPlace = (card: HTMLElement, index: number): Animation[] => {
      const from = sourceBoxes[index];
      const source = sourceOrder[index];
      const ghost = document.createElement('div');
      ghost.className = card.className;
      ghost.setAttribute('aria-hidden', 'true');
      ghost.setAttribute('inert', '');
      ghost.setAttribute('data-callout-ghost', '');
      ghost.append(...snapshot.cardCopies[source].childNodes);
      Object.assign(ghost.style, {
        left: `${from.left - origin.left}px`, top: `${from.top - origin.top}px`, right: 'auto', bottom: 'auto',
        width: `${from.width}px`, height: `${from.height}px`, margin: '0', animation: 'none', pointerEvents: 'none',
      });
      root.append(ghost);
      const connector = snapshot.connectorCopies[source];
      if (connector) {
        connector.querySelectorAll<SVGElement>('path, circle').forEach(part => { part.style.animation = 'none'; });
        ghostConnectors.append(connector);
        if (!ghostConnectors.isConnected) root.prepend(ghostConnectors);
      }
      const fadeOut = { duration: GHOST_FADE_MS, easing: 'ease-in', fill: 'forwards' } as const;
      const out = ghost.animate([{ opacity: 1, scale: '1' }, { opacity: 0, scale: `${GHOST_SCALE}` }], fadeOut);
      const outConnector = connector?.animate([{ opacity: 1 }, { opacity: 0 }], fadeOut);
      out.onfinish = () => {
        if (!this.animations.includes(out)) return;
        ghost.remove();
        connector?.remove();
        if (!ghostConnectors.childElementCount) ghostConnectors.remove();
      };
      const fadeIn = card.animate([{ opacity: 0, scale: `${GHOST_SCALE}` }, { opacity: 1, scale: '1' }], {
        duration: CALLOUT_MOVE_MS - GHOST_FADE_MS / 2, delay: GHOST_FADE_MS / 2, easing: 'cubic-bezier(.2, .6, .35, 1)', fill: 'backwards',
      });
      return outConnector ? [out, outConnector, fadeIn] : [out, fadeIn];
    };
    this.animations = cards.flatMap((card, index) => {
      if (fadesInPlace[index]) return fadeInPlace(card, index);
      const from = sourceBoxes[index];
      const to = destinations[index];
      const content = card.querySelector<HTMLElement>(':scope > .astrid-callout-content')!;
      const padding = getComputedStyle(card);
      content.style.width = `${content.getBoundingClientRect().width}px`;
      const horizontalPadding = parseFloat(padding.paddingLeft) + parseFloat(padding.paddingRight);
      const outgoingScale = Math.max(.78, Math.min(1, to.height / Math.max(1, from.height), to.width / Math.max(1, from.width)));
      const outgoing = document.createElement('div');
      outgoing.className = 'astrid-callout-outgoing';
      outgoing.setAttribute('aria-hidden', 'true');
      outgoing.setAttribute('inert', '');
      Object.assign(outgoing.style, {
        position: 'absolute',
        top: padding.paddingTop,
        left: padding.paddingLeft,
        width: `${Math.max(0, from.width - horizontalPadding)}px`,
        transformOrigin: 'top left',
        pointerEvents: 'none',
      });
      outgoing.append(...sourceContent[index]);
      card.append(outgoing);
      // Animate from the captured geometry with a FLIP transform. The cards deliberately
      // alternate between CSS `left` and `right` anchors across audiences; animating those
      // positional properties directly lets the browser re-resolve the opposite anchor and
      // produces a one-frame jump on the third card. The final CSS layout stays authoritative,
      // while transform carries the card from its old box to the new one.
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      const frame = (box: DOMRect, transform: string) => ({
        transform,
        translate: '0 0',
        width: `${box.width}px`, height: `${box.height}px`,
      });
      card.dataset.layoutMoving = 'true';
      // The destination's CSS may anchor the card from the right/bottom. Changing
      // its width/height would then move its base position as well as the FLIP
      // transform (and jump on reversals). Pin the destination's top-left for the
      // duration so only the explicit transform and dimensions own the motion.
      card.style.left = `${to.left - origin.left}px`;
      card.style.top = `${to.top - origin.top}px`;
      card.style.right = 'auto';
      card.style.bottom = 'auto';
      // Prime the captured FLIP frame synchronously. Without this, a reversal can
      // expose the destination layout for one commit before WAAPI applies frame 0.
      card.style.setProperty('transform', `translate(${dx}px, ${dy}px)`);
      card.style.setProperty('translate', '0 0');
      card.style.setProperty('width', `${from.width}px`);
      card.style.setProperty('height', `${from.height}px`);
      const animation = card.animate([
        frame(from, `translate(${dx}px, ${dy}px)`),
        frame(to, 'translate(0, 0)'),
      ], {
        duration: CALLOUT_MOVE_MS, easing: 'cubic-bezier(.4, 0, .2, 1)',
      });
      animation.onfinish = () => {
        // A reversal replaces the move; late callbacks must not settle the new transition.
        if (!this.animations.includes(animation)) return;
        card.removeAttribute('data-layout-moving');
        card.style.removeProperty('transform');
        card.style.removeProperty('translate');
        card.style.removeProperty('width');
        card.style.removeProperty('height');
        for (const property of ['left', 'top', 'right', 'bottom']) card.style.removeProperty(property);
        content.style.removeProperty('width');
        outgoing.remove();
      };
      const fadeIn = content.animate([{opacity: 0, translate: '0 4px'}, {opacity: 1, translate: '0 0'}], {duration: CALLOUT_MOVE_MS, easing: 'linear'});
      const fadeOut = outgoing.animate([
        {opacity: 1, translate: '0 0', scale: '1'},
        {opacity: 0, translate: '0 -4px', scale: `${outgoingScale}`},
      ], {duration: CALLOUT_CONTENT_FADE_OUT_MS, easing: 'ease-in', fill: 'forwards'});
      return [animation, fadeIn, fadeOut];
    });
  }

  componentWillUnmount() { this.stop(); }

  render() {
    return <div ref={this.root} className="astrid-callouts" data-audience={this.props.audience}
      aria-label={this.props.audience === 'agent' ? 'Example agent capabilities' : 'How the editor fits together'}>
      {this.props.children}
    </div>;
  }
}

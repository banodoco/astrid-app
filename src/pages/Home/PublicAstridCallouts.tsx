import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import type { PublicAstridAudience } from './publicAstridMotion';
import { RIDERS } from './publicAstridRiders';
import { readPublicAstridPlayerHeight } from './usePublicAstridPlayerHeight';
import {
  PublicAstridCalloutLayout,
  CALLOUT_CURVE_HANDOFF_MS,
  CALLOUT_MOVE_MS,
  CALLOUT_GEOMETRY_EPSILON_PX,
  CALLOUT_VACUUM_EXTEND_MS,
  CALLOUT_VACUUM_LEAD_MS,
  CALLOUT_VACUUM_PHONE_EXTEND_MS,
  CALLOUT_VACUUM_CANONICALIZE_MS,
  CALLOUT_VACUUM_POST_CONNECT_SETTLE_MS,
  CALLOUT_VACUUM_PRIME_DISTANCE_PX,
  CALLOUT_VACUUM_RECONNECT_STAGGER_MS,
  CALLOUT_VACUUM_RETRACT_MS,
  CALLOUT_VACUUM_PHONE_RETRACT_MS,
  CALLOUT_VACUUM_RESIDUAL_RATIO,
  CALLOUT_VACUUM_SETTLE_MS,
  type CalloutMove,
} from './PublicAstridCalloutLayout';

type CalloutSide = 'left' | 'right' | 'top' | 'bottom';

interface CalloutDefinition {
  id: string;
  title: string;
  body: string;
  /** Selector resolved inside the editor stage. */
  target: string;
  /** Point on the target's on-screen box, as fractions of its width and height. */
  at: readonly [number, number];
  /**
   * Pixels below the target's top edge, replacing `at`'s height fraction on desktop and tablet, for a
   * point that must stay on a fixed-height row however tall the target is drawn.
   */
  atTop?: number;
  /** Card edge the connector leaves from. */
  side: CalloutSide;
  /** Card edge the connector leaves from on phones, where cards hang over the stage's top/bottom edges. */
  phoneSide: CalloutSide;
  /** Card edge and target point on tablets and small laptops, where a card sits somewhere else. */
  tabletSide?: CalloutSide;
  tabletAt?: readonly [number, number];
  /** Target point on phones, when the target's layout differs enough there to need its own. */
  phoneAt?: readonly [number, number];
  /**
   * A more specific target on phones, where the cards sit above and below the conversation and can each
   * point at a different part of it. Until that content is measurable, use the chat surface edge.
   */
  phoneTarget?: string;
  /** Fraction along the card edge where the phone connector leaves. */
  phoneAnchor?: number;
  /**
   * On phones, leave the card at this fraction along its edge and swing in to the target from the side,
   * so the connector runs down the conversation's margin instead of across its messages.
   */
  phoneSwing?: number;
  /** A shorter title for the phone's one-line chip, which unfolds to show the body when tapped. */
  phoneTitle: string;
  /** Body copy for the unfolded phone card, when the full sentence would cover the demo. */
  phoneBody?: string;
}

/** Phone connectors into the conversation stop at its edges when the thread is scrolled. */
const PHONE_CLAMP_SELECTOR = '.astrid-chat-surface';

const AGENT_CALLOUTS: readonly CalloutDefinition[] = [
  {
    id: 'community',
    title: 'The community’s intelligence',
    body: 'Shared discoveries inform every agent decision.',
    target: '.astrid-chat-surface',
    at: [0, 0.2],
    side: 'right',
    phoneTitle: 'Community intelligence',
    // On phones: down beside the conversation window and in to the left edge of Astrid's reply.
    phoneSide: 'bottom',
    phoneTarget: '.astrid-chat-surface .justify-start > .rounded-2xl',
    phoneAt: [0, 0.5],
    phoneSwing: 0.3,
  },
  {
    id: 'workflows',
    title: 'Leverages reusable agent workflows',
    body: 'Community-built plans and tools for creative work.',
    target: '.astrid-chat-surface',
    at: [0, 0.68],
    side: 'right',
    phoneTitle: 'Reusable agent workflows',
    phoneSide: 'top',
    // On phones: the finished result, reached up the conversation's left margin.
    phoneTarget: '.astrid-chat-surface .astrid-example-result',
    phoneAt: [0, 0.5],
    phoneSwing: 0.022,
  },
  {
    id: 'tools',
    title: 'Integrated into many open-source tools',
    body: 'And you or others in the community can integrate anything.',
    target: '.astrid-chat-surface',
    at: [1, 0.42],
    side: 'left',
    phoneTitle: 'Open-source tools',
    phoneBody: 'ComfyUI, Wan2GP, HyperFrames, AI Toolkit, or anything you integrate.',
    phoneSide: 'bottom',
    // On phones: the person's request.
    phoneTarget: '.astrid-chat-surface .justify-end > .rounded-2xl',
    // Land on the top edge of the request bubble, in from its right corner.
    phoneAt: [0.8, 0],
  },
];

const INTEGRATIONS = [
  { id: 'comfyui', name: 'ComfyUI', href: 'https://github.com/Comfy-Org/ComfyUI' },
  { id: 'wan2gp', name: 'Wan2GP', href: 'https://github.com/deepbeepmeep/Wan2GP' },
  { id: 'hyperframes', name: 'HyperFrames', href: 'https://github.com/heygen-com/hyperframes' },
  { id: 'ai-toolkit', name: 'AI Toolkit', href: 'https://github.com/ostris/ai-toolkit' },
] as const;

function IntegrationLinks() {
  return (
    <ul className="astrid-integration-logos" aria-label="Open-source integrations">
      {INTEGRATIONS.map(({ id, name, href }) => (
        <li key={id}>
          <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`${name} on GitHub`} data-integration={id}>
            <img src={`/integration-logos/${id}.webp`} alt="" decoding="async" width={32} height={32} />
            <span>{name}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

const APP_CALLOUTS: readonly CalloutDefinition[] = [
  {
    id: 'effects',
    title: 'Live vibe code effects and visuals',
    body: 'Describe a look; its code is edited live.',
    // Target the whole card so the connector also works with no clip selected.
    target: '.astrid-inspector-surface',
    at: [0.5, 0.5],
    side: 'bottom',
    phoneTitle: 'Live-code effects',
    phoneSide: 'bottom',
    // On phones the inspector is a compact strip right under this chip: land on the Effects tab itself,
    // low enough in the strip to stay in view while the chip is unfolded.
    phoneTarget: '.astrid-inspector-surface [role="tablist"].grid-cols-4 > [role="tab"]:first-child',
    phoneAt: [0.84, 0.92],
    // Tablets draw the inspector small and zoomed out, with the label just above it: land on its top
    // edge there too, instead of on the clip title in the middle of the card.
    tabletAt: [0.5, 0],
  },
  {
    id: 'timeline',
    title: 'Do complex editing with your agents',
    body: "Edit by hand or with your agent's help.",
    // A fixed point on the timeline panel (where the first clip rests), not the clip itself, so the
    // connector holds still when the timeline is scrolled.
    target: '.astrid-timeline-surface',
    // The middle of the first track sits ~57px below the panel's top at every desktop and tablet size.
    at: [0.27, 0.2],
    atTop: 57,
    // On phones the chip sits top-right: its connector runs down the gutter beside the miniature and
    // turns in to the timeline's right edge, clear of the player.
    phoneAt: [1, 0.3],
    side: 'top',
    phoneTitle: 'Edit with your agents',
    phoneSide: 'bottom',
    phoneSwing: 0.93,
  },
  {
    id: 'models',
    title: 'Your agent runs your local models',
    body: 'It figures out how to get local models to do the job and gets it running on your machine.',
    target: '[data-astrid-agent-launcher]',
    at: [0.5, 0],
    // On phones the chip sits to the launcher's lower left and reaches across to its edge; on tablets
    // it rises from the label hanging below the timeline to the launcher's lower edge.
    phoneAt: [0.04, 0.6],
    phoneTitle: 'Your agent runs local models',
    tabletSide: 'top',
    tabletAt: [0.5, 1],
    side: 'bottom',
    phoneSide: 'right',
  },
];

const PARALLAX_EASE = 0.1;
const CALLOUT_RESTING_BEND_MIN_PX = 2;
const CALLOUT_RESTING_BEND_MAX_PX = 4;
const CALLOUT_RESTING_BEND_RATIO = 0.012;
// A terminal curve may be reused only while its live endpoints are effectively
// unchanged. Larger movement means the layout is still settling and the slot
// must keep its endpoints live and recanonicalize instead of freezing stale work.
const CALLOUT_CANONICAL_ENDPOINT_EPSILON_PX = 0.25;
const PARALLAX_TILT_X_DEG = 4;
const PARALLAX_TILT_Y_DEG = 5;
/** Keep in step with the phone and tablet breakpoints in PublicAstridShell.css. */
const PHONE_MEDIA_QUERY = '(max-width: 640px)';
const TABLET_MEDIA_QUERY = '(max-width: 1099px)';

function subscribePhoneLayout(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(PHONE_MEDIA_QUERY);
  query.addEventListener?.('change', onChange);
  return () => query.removeEventListener?.('change', onChange);
}

function usePhoneLayout() {
  return useSyncExternalStore(
    subscribePhoneLayout,
    () => typeof window.matchMedia === 'function' && window.matchMedia(PHONE_MEDIA_QUERY).matches,
    () => false,
  );
}

function calloutsFor(audience: PublicAstridAudience) {
  const definitions = audience === 'agent' ? AGENT_CALLOUTS : APP_CALLOUTS;
  // This is the established desktop introduction order. Phone timing below uses
  // the same source with a separate slot map for the top rail.
  const order = audience === 'agent' ? ['community', 'tools', 'workflows'] : ['timeline', 'effects', 'models'];
  return order.map(id => definitions.find(callout => callout.id === id)!);
}

const MOBILE_CALLOUT_ORDER: Record<PublicAstridAudience, readonly string[]> = {
  agent: ['community', 'tools', 'workflows'],
  app: ['effects', 'timeline', 'models'],
};

function calloutSequenceIndex(audience: PublicAstridAudience, id: string, phone: boolean) {
  const order = phone ? MOBILE_CALLOUT_ORDER[audience] : calloutsFor(audience).map(callout => callout.id);
  return Math.max(0, order.indexOf(id));
}

// One complete turn: card settles, line draws, endpoint lands, then a short breath.
// Both the card and its SVG group consume these same timings on every screen size.
function calloutTiming(index: number, audience: PublicAstridAudience, id: string): CSSProperties {
  const card = 360;
  // Let the card visibly settle before the initial connector draw begins. The draw waits
  // for the card entrance, so the first connection is visible on a real page load.
  const connector = 480;
  const endpoint = 180;
  const connectorLead = card + 40;
  const mobileIndex = calloutSequenceIndex(audience, id, true);
  // Keep the card and its connector choreography intact, but let the next
  // card enter while the previous connector is drawing instead of serializing
  // three full card→connector turns on the first page load.
  const start = 120 + index * 360;
  return {
    '--astrid-callout-index': index,
    '--astrid-mobile-callout-index': mobileIndex,
    '--astrid-callout-start': `${start}ms`,
    '--astrid-card-duration': `${card}ms`,
    '--astrid-connector-start': `${start + connectorLead}ms`,
    '--astrid-connector-duration': `${connector}ms`,
    '--astrid-endpoint-start': `${start + connectorLead + connector}ms`,
    '--astrid-endpoint-duration': `${endpoint}ms`,
  } as CSSProperties;
}

const ORDERED_AGENT_CALLOUTS = calloutsFor('agent');
const ORDERED_APP_CALLOUTS = calloutsFor('app');

interface PublicAstridCalloutsProps {
  stageRef: RefObject<HTMLDivElement>;
  audience: PublicAstridAudience;
  reducedMotion: boolean;
  active?: boolean;
}

const TRACKED_PROPERTIES = ['left', 'top', 'right', 'bottom', 'width', 'height'] as const;

/** Hands an element tracked by the frame loop back to its stylesheet position. */
function releaseTracked(element: HTMLElement | null) {
  if (!element?.dataset.astridTracked) return;
  delete element.dataset.astridTracked;
  for (const property of TRACKED_PROPERTIES) element.style.removeProperty(property);
}

function cardAnchor(card: DOMRect, side: CalloutSide, target: { x: number; y: number }, fixedFraction?: number) {
  const inset = 16;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  switch (side) {
    case 'left': return { x: card.left, y: clamp(target.y, card.top + inset, card.bottom - inset) };
    case 'right': return { x: card.right, y: clamp(target.y, card.top + inset, card.bottom - inset) };
    case 'top': return { x: fixedFraction === undefined ? clamp(target.x, card.left + inset, card.right - inset) : card.left + card.width * fixedFraction, y: card.top };
    case 'bottom': return { x: fixedFraction === undefined ? clamp(target.x, card.left + inset, card.right - inset) : card.left + card.width * fixedFraction, y: card.bottom };
  }
}

interface Point { x: number; y: number }
interface CurveControls { c1: Point; c2: Point }

function connectorControls(start: Point, end: Point, side: CalloutSide, swing?: number): CurveControls {
  const horizontal = side === 'left' || side === 'right';
  const reach = horizontal ? Math.abs(end.x - start.x) * 0.5 : Math.abs(end.y - start.y) * 0.5;
  const direction = side === 'left' || side === 'top' ? -1 : 1;
  if (swing !== undefined) {
    return {
      c1: { x: start.x, y: start.y + direction * Math.abs(end.y - start.y) * 0.9 },
      c2: { x: end.x + Math.sign(start.x - end.x) * Math.abs(end.x - start.x) * 0.9, y: end.y },
    };
  }
  return horizontal
    ? { c1: { x: start.x + direction * reach, y: start.y }, c2: { x: end.x - direction * reach, y: end.y } }
    : { c1: { x: start.x, y: start.y + direction * reach }, c2: { x: end.x, y: end.y - direction * reach } };
}

/** Add a bounded S-bend without moving either endpoint. The opposite control-point offsets
 * make the connector breathe laterally instead of translating as one rigid curve. The small
 * tangential trail makes the rear half follow the leading half like a flexible drawn stroke. */
function snakeBend(controls: CurveControls, start: Point, end: Point, amount: number, trail = 0): CurveControls {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (!amount || !length) return controls;
  const normal = { x: -dy / length, y: dx / length };
  const tangent = { x: dx / length, y: dy / length };
  return {
    c1: {
      x: controls.c1.x + normal.x * amount + tangent.x * trail,
      y: controls.c1.y + normal.y * amount + tangent.y * trail,
    },
    c2: {
      x: controls.c2.x - normal.x * amount * .72 - tangent.x * trail * .58,
      y: controls.c2.y - normal.y * amount * .72 - tangent.y * trail * .58,
    },
  };
}

function restingBendAmount(length: number) {
  return Math.min(CALLOUT_RESTING_BEND_MAX_PX,
    Math.max(CALLOUT_RESTING_BEND_MIN_PX, length * CALLOUT_RESTING_BEND_RATIO));
}

function snakeTrailAmount(length: number) {
  return Math.min(2.4, Math.max(.75, length * .004));
}

/** Gravity adds one quiet downward bow, shared by the moving and resting curves.
 * Equal control offsets keep both anchors exact and add at most 9px at midspan. */
function ropeSlack(controls: CurveControls, start: Point, end: Point): CurveControls {
  const sag = Math.min(12, Math.abs(end.x - start.x) * .06);
  return {
    c1: { x: controls.c1.x, y: controls.c1.y + sag },
    c2: { x: controls.c2.x, y: controls.c2.y + sag },
  };
}

/** A zero-at-rest bend envelope for retract/extension plus a finite post-connect settle.
 * The extension arrives at unit bend with zero velocity; the after-motion starts
 * at that same value and damps to exactly zero without moving either endpoint. */
function connectorSnakeWave(elapsed: number, retractUntil: number, extensionAt: number, extendDuration: number) {
  if (elapsed < retractUntil) {
    const progress = Math.max(0, Math.min(1, elapsed / Math.max(1, retractUntil)));
    return Math.sin(Math.PI * eased(progress));
  }
  if (Number.isFinite(extensionAt) && elapsed >= extensionAt) {
    const progress = Math.max(0, Math.min(1, (elapsed - extensionAt) / Math.max(1, extendDuration)));
    if (progress < 1) return Math.sin((Math.PI / 2) * eased(progress));
    const settleProgress = Math.max(0, Math.min(1,
      (elapsed - extensionAt - extendDuration) / CALLOUT_VACUUM_POST_CONNECT_SETTLE_MS));
    const envelope = (1 - eased(settleProgress)) * Math.exp(-4 * settleProgress * settleProgress);
    return envelope;
  }
  return 0;
}

function eased(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function resolveVisibleTarget(stage: HTMLElement, selector: string) {
  for (const element of stage.querySelectorAll<HTMLElement>(selector)) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return { element, rect };
  }
  return null;
}

function connectorGeometry(stage: HTMLElement, callout: CalloutDefinition, phone: boolean, tablet: boolean) {
  const precise = resolveVisibleTarget(stage, phone && callout.phoneTarget ? callout.phoneTarget : callout.target);
  // Chat content can mount or become measurable after the surface has landed. Its
  // readiness must not hide/restart the connector or delay the card-settle clock.
  const chatFallback = !precise && phone && callout.target === PHONE_CLAMP_SELECTOR;
  // Any other phone-only target (the Effects tab, absent while no clip is selected) falls back to its panel.
  const panelFallback = !precise && !chatFallback && phone && !!callout.phoneTarget;
  const resolved = precise ?? (chatFallback || panelFallback ? resolveVisibleTarget(stage, callout.target) : null);
  if (!resolved) return null;
  const side = phone ? callout.phoneSide : tablet ? callout.tabletSide ?? callout.side : callout.side;
  const [ax, preferredY] = panelFallback ? callout.at : phone ? callout.phoneAt ?? callout.at : tablet ? callout.tabletAt ?? callout.at : callout.at;
  const ay = chatFallback ? callout.at[1] : preferredY;
  const box = resolved.rect;
  const end = { x: box.left + box.width * ax, y: box.top + (!phone && callout.atTop !== undefined ? callout.atTop : box.height * ay) };
  // Surface-relative fallback coordinates are already inside the panel, even if
  // an empty mobile conversation has not acquired its content height yet.
  const clampBox = !chatFallback && phone && callout.phoneTarget ? resolved.element.closest(PHONE_CLAMP_SELECTOR)?.getBoundingClientRect() : undefined;
  // A message scrolled out of a short conversation keeps its connector at the conversation's edge.
  if (clampBox) end.y = Math.max(clampBox.top + 10, Math.min(clampBox.bottom - 16, end.y));
  return { end, side, swing: phone ? callout.phoneSwing : undefined };
}

/**
 * Callouts drawn flat above the tilted editor. Connectors are
 * measured from the projected on-screen boxes every frame so their end dots sit
 * on both the card and the surface they describe, including under parallax.
 */
export function PublicAstridCallouts({ stageRef, audience, reducedMotion, active = true }: PublicAstridCalloutsProps) {
  const callouts = audience === 'agent' ? ORDERED_AGENT_CALLOUTS : ORDERED_APP_CALLOUTS;
  const svgRef = useRef<SVGSVGElement>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const moveRef = useRef<CalloutMove | null>(null);
  const settledCanonicalCurves = useRef<number[][]>([]);
  const settledCanonicalEpoch = useRef<number | undefined>(undefined);
  // Phones show each card as a one-line chip; tapping one unfolds its body over the demo, one at a time.
  const phone = usePhoneLayout();
  const bodyIdPrefix = useId();
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => { setOpenId(null); }, [audience, phone]);
  useEffect(() => {
    if (!openId) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.astrid-callout')) setOpenId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenId(null); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openId]);

  // Connectors, plus the flat App controls that must follow tilted surfaces: the
  // transport rides the player, and the agent launcher sits on the conversation
  // once it has bundled itself into its corner circle.
  const appView = audience === 'app';
  // This owns the measured SVG and tracked flat controls. It must switch in the
  // layout phase: a passive effect leaves one painted frame where the new cards
  // are committed but the old audience's connector loop is still alive.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    // The stage ref belongs to the parent shell and can still be assigned after
    // this child layout effect; the committed SVG gives us the same stable owner.
    const stage = stageRef.current ?? svg?.closest<HTMLDivElement>('.astrid-editor-stage, [data-testid="stage"]');
    if (!active || !stage || !svg) return undefined;
    const stageElement: HTMLDivElement = stage;
    const svgElement: SVGSVGElement = svg;
    let frame = 0;
    let alive = true;
    let pointer: { x: number; y: number; leaving: boolean } | null = null;
    const targetTilt = { x: 0, y: 0 };
    const currentTilt = { x: 0, y: 0 };
    const phoneQuery = window.matchMedia(PHONE_MEDIA_QUERY);
    const tabletQuery = window.matchMedia(TABLET_MEDIA_QUERY);
    const schedule = () => {
      if (alive && !frame) frame = window.requestAnimationFrame(draw);
    };
    function draw() {
      if (!alive) return;
      frame = 0;
      // Read every projected box before touching styles/SVG. Writes cannot force a later read in this
      // pass. One final pass after a tilt write measures the projection at its settled transform.
      const writes: Array<() => void> = [];
      let trackedChanged = false;
      const setStyle = (element: HTMLElement, name: string, value: string) => {
        if (element.style.getPropertyValue(name) === value) return;
        trackedChanged = true;
        writes.push(() => element.style.setProperty(name, value));
      };
      const setAttribute = (element: Element, name: string, value: string) => writes.push(() => {
        if (element.getAttribute(name) !== value) element.setAttribute(name, value);
      });
      const stageRect = stageElement.getBoundingClientRect();
      const originX = stageRect.left + stageElement.clientLeft;
      const originY = stageRect.top + stageElement.clientTop;
      // On phones the cards hang over the stage's top and bottom edges, so connectors leave other edges.
      const phone = phoneQuery.matches;
      const tablet = !phone && tabletQuery.matches;
      setStyle(stageElement, '--astrid-player-height', readPublicAstridPlayerHeight(stageElement, phone));
      const tilt = stageElement.querySelector<HTMLElement>('.astrid-editor-tilt');
      if (pointer) {
        if (pointer.leaving) {
          // A View Transition overlay can take the pointer while it is still over the stage.
          if (!(pointer.x > stageRect.left && pointer.x < stageRect.right && pointer.y > stageRect.top && pointer.y < stageRect.bottom)) {
            targetTilt.x = 0;
            targetTilt.y = 0;
          }
        } else if (stageRect.width && stageRect.height) {
          targetTilt.x = Math.max(-1, Math.min(1, ((pointer.x - stageRect.left) / stageRect.width) * 2 - 1));
          targetTilt.y = Math.max(-1, Math.min(1, ((pointer.y - stageRect.top) / stageRect.height) * 2 - 1));
        }
        pointer = null;
      }
      if (phone || reducedMotion) { targetTilt.x = 0; targetTilt.y = 0; }
      currentTilt.x += (targetTilt.x - currentTilt.x) * PARALLAX_EASE;
      currentTilt.y += (targetTilt.y - currentTilt.y) * PARALLAX_EASE;
      const settled = Math.abs(targetTilt.x - currentTilt.x) < 0.001 && Math.abs(targetTilt.y - currentTilt.y) < 0.001;
      if (settled) { currentTilt.x = targetTilt.x; currentTilt.y = targetTilt.y; }
      const transform = reducedMotion || phone ? '' : `rotateX(${(currentTilt.y * -PARALLAX_TILT_X_DEG).toFixed(3)}deg) rotateY(${(currentTilt.x * PARALLAX_TILT_Y_DEG).toFixed(3)}deg)`;
      const tiltChanged = !!tilt && tilt.style.transform !== transform;
      if (tiltChanged) setStyle(tilt!, 'transform', transform);

      // Riders (the transport) are glued to their host's rendered box on every frame, in both
      // audiences: the host's CSS transition runs through the whole journey, so the sampled box is
      // the one it is painting right now. Their fade is CSS (see publicAstridRiders.ts).
      for (const rider of RIDERS) {
        const overlay = stageElement.querySelector<HTMLElement>(rider.overlay);
        const host = stageElement.querySelector<HTMLElement>(rider.host);
        if (!overlay || !host) continue;
        const box = host.getBoundingClientRect();
        const placed = rider.place({ left: box.left, top: box.top, width: box.width, height: box.height });
        setAttribute(overlay, 'data-astrid-tracked', 'true');
        setStyle(overlay, 'left', `${placed.left - originX}px`);
        setStyle(overlay, 'top', `${placed.top - originY}px`);
        setStyle(overlay, 'width', `${placed.width}px`);
        setStyle(overlay, 'height', `${placed.height}px`);
      }

      const launcher = stageElement.querySelector<HTMLElement>('[data-astrid-agent-launcher]');
      const chat = stageElement.querySelector<HTMLElement>('.astrid-chat-surface');
      const launcherAnchor = phone ? stageElement.querySelector<HTMLElement>('.astrid-timeline-surface') : chat;
      if (appView && launcher && launcherAnchor) {
        // The mobile timeline has a fixed single-row height; use its actual edge rather than the
        // hidden chat's desktop positioning box, which can move independently on resize.
        const box = launcherAnchor.getBoundingClientRect();
        const size = launcher.offsetWidth;
        // On phones it perches on the miniature's lower right corner, overhanging into the gutter.
        const left = phone ? box.right - size * .62 : box.left + box.width / 2 - size / 2;
        const top = phone ? box.bottom - size * .56 : box.top + box.height / 2 - size / 2;
        setAttribute(launcher, 'data-astrid-tracked', 'true');
        setStyle(launcher, 'left', `${left - originX}px`);
        setStyle(launcher, 'top', `${top - originY}px`);
        setStyle(launcher, 'right', 'auto');
        setStyle(launcher, 'bottom', 'auto');
      }

      const move = moveRef.current;
      if (move && settledCanonicalEpoch.current !== move.epoch) {
        // A new epoch owns a new slot order and must not inherit a terminal
        // curve from the audience that is being replaced.
        settledCanonicalCurves.current = [];
        settledCanonicalEpoch.current = move.epoch;
      }
      const elapsed = move ? performance.now() - move.started : Infinity;
      const retractUntil = phone ? CALLOUT_VACUUM_PHONE_RETRACT_MS : CALLOUT_VACUUM_RETRACT_MS;
      if (move && move.staggerIndices.length === 0) {
        // Freeze the breakpoint-aware introduction order for this epoch. A resize
        // during the move must not reorder slots halfway through reconnection.
        move.staggerIndices = callouts.map(callout => calloutSequenceIndex(audience, callout.id, phone));
      }
      const cardBoxes = callouts.map((callout) => cardRefs.current.get(callout.id)?.getBoundingClientRect() ?? null);
      // The destination cards can be effectively final before their 720ms animation
      // lifecycle ends. This gate reads card geometry only; inner chat readiness is irrelevant.
      const isEffectivelySettled = (box: DOMRect | null, destination: DOMRect) => !!box
        && Math.abs(box.left - destination.left) <= CALLOUT_GEOMETRY_EPSILON_PX
        && Math.abs(box.top - destination.top) <= CALLOUT_GEOMETRY_EPSILON_PX
        && Math.abs(box.width - destination.width) <= CALLOUT_GEOMETRY_EPSILON_PX
        && Math.abs(box.height - destination.height) <= CALLOUT_GEOMETRY_EPSILON_PX;
      const cardsEffectivelySettled = move?.destinations.length === cardBoxes.length
        && cardBoxes.every((box, index) => isEffectivelySettled(box, move.destinations[index]));
      // Entering Agent waits for the real retract and destination card geometry, not content readiness.
      const baseExtendAt = !appView && move
        ? move.settledAt === undefined ? Infinity : Math.max(retractUntil, move.settledAt - move.started + CALLOUT_VACUUM_SETTLE_MS)
        : retractUntil;
      const baseExtendDuration = phone ? CALLOUT_VACUUM_PHONE_EXTEND_MS : CALLOUT_VACUUM_EXTEND_MS;
      // Both audiences use the natural extension duration after the same
      // final-geometry gate; retraction and the residual hold remain separate.
      const extendDuration = baseExtendDuration;
      // An unfolded phone card lies over the demo. A connector whose endpoint it covers fades out
      // rather than ending underneath it.
      const openBox = phone ? stageElement.querySelector<HTMLElement>('.astrid-callout[data-open="true"]')?.getBoundingClientRect() : undefined;
      for (const [index, callout] of callouts.entries()) {
        const path = svgElement.querySelector<SVGPathElement>(`path[data-callout="${callout.id}"]`);
        const dots = svgElement.querySelectorAll<SVGCircleElement>(`circle[data-callout="${callout.id}"]`);
        const card = cardRefs.current.get(callout.id);
        const incoming = connectorGeometry(stageElement, callout, phone, tablet);
        if (!path || dots.length !== 2 || !card) continue;
        const destination = incoming;
        if (move) move.targetReady[index] = !!destination;
        const side = destination?.side ?? (phone ? callout.phoneSide : tablet ? callout.tabletSide ?? callout.side : callout.side);
        const swing = destination?.swing ?? (phone ? callout.phoneSwing : undefined);
        const cardBox = cardBoxes[index];
        if (!cardBox) continue;
        const staggerIndex = move?.staggerIndices[index] ?? calloutSequenceIndex(audience, callout.id, phone);
        const slotExtendAt = Number.isFinite(baseExtendAt)
          ? baseExtendAt + staggerIndex * CALLOUT_VACUUM_RECONNECT_STAGGER_MS
          : Infinity;
        const previous = move?.curves[index];
        const oldEnd = previous?.length === 8
          ? { x: previous[6] - originX, y: previous[7] - originY }
          : null;
        // A missing target must still pass through the retract phase. Use its last
        // endpoint as a temporary destination, then hold the retracted endpoint.
        const end = destination?.end ?? (oldEnd ? { x: oldEnd.x + originX, y: oldEnd.y + originY } : null);
        if (!end) continue;
        const anchor = (box: DOMRect, geometry: { side: CalloutSide; swing?: number; end: Point }) => geometry.swing === undefined
          ? cardAnchor(box, geometry.side, geometry.end, phone ? callout.phoneAnchor : undefined)
          : { x: box.left + box.width * geometry.swing, y: geometry.side === 'top' ? box.top : box.bottom };
        const start = anchor(cardBox, { side, swing, end });
        const sx = start.x - originX;
        const sy = start.y - originY;
        let ex = end.x - originX;
        let ey = end.y - originY;
        let slotTransitionEnd = slotExtendAt + extendDuration + CALLOUT_VACUUM_SETTLE_MS;
        if (move && !destination) slotTransitionEnd = Infinity;
        if (move && previous?.length === 8) {
          const oldEx = previous[6] - originX;
          const oldEy = previous[7] - originY;
          const currentStart = { x: sx, y: sy };
          const newEnd = { x: ex, y: ey };
          const lastEnd = { x: oldEx, y: oldEy };
          const currentLength = Math.hypot(lastEnd.x - currentStart.x, lastEnd.y - currentStart.y);
          const oldLength = move.retractLengths[index] ?? (move.retractLengths[index] = currentLength);
          const settledBox = move.destinations[index];
          const settledStart = destination && settledBox
            ? anchor(settledBox, { side, swing, end: destination.end })
            : currentStart;
          const settledStartLocal = { x: settledStart.x - originX, y: settledStart.y - originY };
          const finalDirection = destination
            ? { x: newEnd.x - settledStartLocal.x, y: newEnd.y - settledStartLocal.y }
            : { x: lastEnd.x - currentStart.x, y: lastEnd.y - currentStart.y };
          const finalLength = Math.hypot(finalDirection.x, finalDirection.y);
          const directionLength = finalLength || oldLength || 1;
          const unit = { x: finalDirection.x / directionLength, y: finalDirection.y / directionLength };
          const residualLength = (finalLength || oldLength) * CALLOUT_VACUUM_RESIDUAL_RATIO;
          const partialEndAt = (time: number) => {
            // Prime a small visible contraction before the first browser paint, then
            // move more slowly toward a residual stub rather than collapsing to zero.
            const retractClock = Math.max(0, Math.min(time, retractUntil) - CALLOUT_VACUUM_LEAD_MS);
            const residualEnd = {
              x: currentStart.x + unit.x * residualLength,
              y: currentStart.y + unit.y * residualLength,
            };
            const retractDistance = Math.hypot(residualEnd.x - lastEnd.x, residualEnd.y - lastEnd.y);
            const primeDistance = Math.min(retractDistance, CALLOUT_VACUUM_PRIME_DISTANCE_PX);
            const remainingDistance = Math.max(0, retractDistance - primeDistance);
            const retractProgress = retractUntil > CALLOUT_VACUUM_LEAD_MS
              ? retractClock / (retractUntil - CALLOUT_VACUUM_LEAD_MS)
              : 1;
            const travelled = Math.min(
              retractDistance,
              primeDistance + remainingDistance * eased(retractProgress),
            );
            const progress = retractDistance > 0 ? Math.min(1, travelled / retractDistance) : 1;
            // Retarget the residual point as the card moves. At settled geometry
            // this is exactly 20% of the final extension length from card to target.
            return {
              x: lastEnd.x + (residualEnd.x - lastEnd.x) * progress,
              y: lastEnd.y + (residualEnd.y - lastEnd.y) * progress,
            };
          };
          let effectiveEnd = lastEnd;
          if (elapsed < CALLOUT_VACUUM_LEAD_MS) {
            // Start the visible contraction in the first painted frame. The lead
            // clock still controls the speed, but never leaves the new cards
            // exposed with a fully extended connector to the old target.
            effectiveEnd = partialEndAt(elapsed);
          } else if (elapsed < slotExtendAt) {
            // Retract at the slower bounded speed, stopping at the residual stub
            // instead of sucking the connector all the way into the card.
            effectiveEnd = partialEndAt(elapsed);
          } else if (!destination) {
            // Keep this slot retracted until its target is measurable.
            effectiveEnd = partialEndAt(slotExtendAt);
          } else {
            // A target that was already measurable when its geometry gate opened
            // owns the scheduled slot clock. This keeps canonicalization aligned
            // with the actual settled layout even when the next RAF is late.
            // A genuinely late target starts now instead, so missing-target slots
            // never skip their visible extension.
            if (move.extensionStartedAt[index] === undefined) {
              // Agent entry has a real destination-geometry gate, so its
              // ready slots use the scheduled clock even if RAF observation is
              // late. App reverse transitions do not have that gate; preserve
              // their observed-frame start to avoid a first-sample curve jump.
              move.extensionStartedAt[index] = !appView && move.targetReady[index]
                ? slotExtendAt
                : elapsed;
            }
            const extensionElapsed = elapsed - move.extensionStartedAt[index]!;
            const partialEnd = partialEndAt(slotExtendAt);
            const expandProgress = eased(extensionElapsed / extendDuration);
            effectiveEnd = {
              x: partialEnd.x + (newEnd.x - partialEnd.x) * expandProgress,
              y: partialEnd.y + (newEnd.y - partialEnd.y) * expandProgress,
            };
            slotTransitionEnd = move.extensionStartedAt[index]! + extendDuration + CALLOUT_VACUUM_SETTLE_MS;
          }
          ex = effectiveEnd.x;
          ey = effectiveEnd.y;
        }
        const effectiveEnd = { x: ex, y: ey };
        const curveStart = { x: sx, y: sy };
        const baseControls = connectorControls(curveStart, effectiveEnd, side, swing);
        const extensionAt = move?.extensionStartedAt[index] ?? slotExtendAt;
        const wave = move
          ? connectorSnakeWave(elapsed, retractUntil, extensionAt, extendDuration)
          : 0;
        const curveLength = Math.hypot(effectiveEnd.x - sx, effectiveEnd.y - sy);
        // Keep the moving stroke a little more expressive than the resting curve,
        // but bound it so long vertical paths do not develop a large S-wave and
        // short horizontal paths do not look pinched. Both components share the
        // same smooth phase envelope, so position and velocity meet at every gate.
        const bendAmount = Math.min(14, Math.max(5, curveLength * .045)) * wave;
        const trailAmount = snakeTrailAmount(curveLength) * wave;
        // Keep a small shared normal offset in the resting shape. The animated
        // bend is layered on top of that same canonical curve so the connector
        // retains a little tension instead of becoming rigid at rest.
        const canonicalControls = ropeSlack(snakeBend(
          baseControls,
          curveStart,
          effectiveEnd,
          restingBendAmount(curveLength),
          snakeTrailAmount(curveLength) * .55,
        ), curveStart, effectiveEnd);
        const organicControls = snakeBend(canonicalControls, curveStart, effectiveEnd, bendAmount, trailAmount);
        const primedCurve = move?.primedCurves[index];
        const baseline = [
          curveStart.x, curveStart.y,
          organicControls.c1.x, organicControls.c1.y,
          organicControls.c2.x, organicControls.c2.y,
          effectiveEnd.x, effectiveEnd.y,
        ];
        const canonicalCurve = [
          curveStart.x, curveStart.y,
          canonicalControls.c1.x, canonicalControls.c1.y,
          canonicalControls.c2.x, canonicalControls.c2.y,
          effectiveEnd.x, effectiveEnd.y,
        ];
        const endpointDelta = (a: number[], b: number[]) => a.length === 8 && b.length === 8
          ? Math.max(...[0, 1, 6, 7].map(coordinate => Math.abs(a[coordinate] - b[coordinate])))
          : Infinity;
        const settledCurve = settledCanonicalCurves.current[index];
        // After cleanup, keep using the exact curve that completed
        // canonicalization while the live geometry agrees with its endpoints.
        // If the layout moves again, discard it and return to live geometry.
        const staticCanonical = !move && settledCurve?.length === 8
          && endpointDelta(settledCurve, canonicalCurve) <= CALLOUT_CANONICAL_ENDPOINT_EPSILON_PX
          ? settledCurve
          : canonicalCurve;
        const painted = move?.paintedCurves[index];
        // Endpoints are never handed off from a previously painted curve. The
        // card anchor and target are live geometry, so both ends stay attached
        // while a card is moving and throughout the post-connect settle. Only
        // the cubic controls may blend toward the organic curve.
        const renderedBaseline = baseline;
        const handoffFrom = painted?.length === 8
          ? painted
          : primedCurve?.length === 8 ? primedCurve : baseline;
        const firstPaint = !!move && move.curveLastPaintedAt[index] === undefined && handoffFrom.length === 8;
        const frameDelta = move && move.curveLastPaintedAt[index] !== undefined
          ? Math.max(0, elapsed - move.curveLastPaintedAt[index]!)
          : 0;
        // Critically damped controls carry velocity instead of spending 480ms
        // chasing the target and then catching up in one short terminal phase.
        // Analytic integration is stable even when a screenshot drops frames.
        const response = CALLOUT_CURVE_HANDOFF_MS / 6;
        const velocities = move?.curveVelocities[index] ?? [];
        const nextVelocities = Array(8).fill(0) as number[];
        const followingCurve = renderedBaseline.map((value, coordinate) => {
          if (!move || coordinate < 2 || coordinate > 5) return value;
          const offset = handoffFrom[coordinate] - value;
          const velocity = velocities[coordinate] ?? 0;
          const decay = Math.exp(-frameDelta / response);
          const coefficient = velocity + offset / response;
          nextVelocities[coordinate] = (velocity - coefficient * frameDelta / response) * decay;
          return value + (offset + coefficient * frameDelta) * decay;
        });
        const postSettleAt = move?.extensionStartedAt[index] === undefined
          ? Infinity
          : move.extensionStartedAt[index]! + extendDuration + CALLOUT_VACUUM_SETTLE_MS + CALLOUT_VACUUM_POST_CONNECT_SETTLE_MS;
        const canonicalizing = !!move && !!destination
          && move.extensionStartedAt[index] !== undefined
          && elapsed >= postSettleAt;
        let canonicalProgress = 0;
        let canonicalFrom = handoffFrom;
        let capturedCanonical = canonicalCurve;
        if (canonicalizing) {
          if (move!.canonicalizeStartedAt[index] === undefined) {
            // Start from the actual painted position AND velocity at its actual
            // sample time. Restarting at zero velocity makes a visible latch click.
            move!.canonicalizeStartedAt[index] = move!.curveLastPaintedAt[index] ?? elapsed;
            move!.canonicalizeVelocities[index] = velocities.slice();
            move!.canonicalizeFrom[index] = painted?.length === 8
              ? painted.slice()
              : renderedBaseline.slice();
            move!.canonicalTarget[index] = canonicalCurve.slice();
            move!.phase = 'canonicalizing';
          }
          capturedCanonical = move!.canonicalTarget[index].length === 8
            ? move!.canonicalTarget[index]
            : canonicalCurve;
          // If the target/card still moved after the post-connect delay, do not
          // freeze the previous geometry into the terminal frame. Rebase from
          // the curve actually painted and restart only this slot's finite
          // canonicalization against the new live target.
          if (endpointDelta(capturedCanonical, canonicalCurve) > CALLOUT_CANONICAL_ENDPOINT_EPSILON_PX) {
            move!.canonicalTarget[index] = canonicalCurve.slice();
            move!.canonicalizeFrom[index] = painted?.length === 8
              ? painted.slice()
              : renderedBaseline.slice();
            move!.canonicalizeStartedAt[index] = move!.curveLastPaintedAt[index] ?? elapsed;
            move!.canonicalizeVelocities[index] = velocities.slice();
            move!.canonicalFramePainted[index] = false;
            capturedCanonical = move!.canonicalTarget[index];
          }
          canonicalFrom = move!.canonicalizeFrom[index].length === 8
            ? move!.canonicalizeFrom[index]
            : renderedBaseline;
          canonicalProgress = Math.min(1, Math.max(0,
            (elapsed - move!.canonicalizeStartedAt[index]!) / CALLOUT_VACUUM_CANONICALIZE_MS));
        }
        // The captured/primed curve is a controls-only handoff source. Endpoints
        // always come from the live card anchor and target, including the first
        // post-commit frame and every reversal/post-settle frame. This keeps the
        // path attached while preserving continuity in the organic controls.
        const latchControl = (coordinate: number) => {
          const t = canonicalProgress;
          const duration = CALLOUT_VACUUM_CANONICALIZE_MS;
          const from = canonicalFrom[coordinate];
          const to = capturedCanonical[coordinate];
          const tangent = (move!.canonicalizeVelocities[index]?.[coordinate] ?? 0) * duration;
          // Cubic Hermite: the incoming velocity is preserved and the resting
          // curve is reached with exactly zero velocity, without oscillation.
          nextVelocities[coordinate] = ((to - from) * (6 * t - 6 * t * t)
            + tangent * (3 * t * t - 4 * t + 1)) / duration;
          return from + (to - from) * eased(t) + tangent * t * (1 - t) * (1 - t);
        };
        const curve = canonicalizing
          ? canonicalProgress >= 1
            ? capturedCanonical.slice()
            : canonicalCurve.map((value, coordinate) => coordinate >= 2 && coordinate <= 5
              ? latchControl(coordinate)
              : value)
          : move
            ? followingCurve
            : staticCanonical.slice();
        if (canonicalizing && canonicalProgress >= 1) move!.canonicalFramePainted[index] = true;
        // The first post-commit draw keeps the exact live endpoints and captured
        // controls. Later frames store their actual painted controls for the next
        // frame's continuous handoff.
        const exactHandoffFrame = firstPaint;
        const paintedCurve = exactHandoffFrame ? curve.slice() : curve.map(value => Number(value.toFixed(3)));
        setAttribute(path, 'data-connector-target', move && elapsed < slotTransitionEnd ? 'transition' : callout.id);
        const pathValue = exactHandoffFrame
          ? `M${paintedCurve[0]} ${paintedCurve[1]} C${paintedCurve.slice(2).join(' ')}`
          : `M${paintedCurve[0]} ${paintedCurve[1]} C${paintedCurve.slice(2).join(' ')}`;
        setAttribute(path, 'd', pathValue);
        setAttribute(dots[0], 'cx', paintedCurve[0].toFixed(1));
        setAttribute(dots[0], 'cy', paintedCurve[1].toFixed(1));
        setAttribute(dots[0], 'r', '4');
        setAttribute(dots[1], 'cx', paintedCurve[6].toFixed(1));
        setAttribute(dots[1], 'cy', paintedCurve[7].toFixed(1));
        setAttribute(dots[1], 'r', '4');
        setAttribute(dots[1], 'opacity', '1');
        if (path.parentElement) {
          const endX = paintedCurve[6] + originX;
          const endY = paintedCurve[7] + originY;
          const occluded = !!openBox && endX > openBox.left && endX < openBox.right && endY > openBox.top && endY < openBox.bottom;
          setAttribute(path.parentElement, 'data-occluded', String(occluded));
        }
        const ping = svgElement.querySelector<SVGCircleElement>(`circle[data-callout-ping="${callout.id}"]`);
        if (ping) {
          setAttribute(ping, 'cx', paintedCurve[6].toFixed(1));
          setAttribute(ping, 'cy', paintedCurve[7].toFixed(1));
          // Reuse the initial connection ring, but only after this slot has finished
          // extending. The epoch guard keeps a late frame from pulsing a stale target.
          const extensionFinished = !!move && !!destination
            && move.extensionStartedAt[index] !== undefined
            && elapsed >= move.extensionStartedAt[index]! + extendDuration;
          if (extensionFinished && move!.pulseEpoch[index] !== move!.epoch) {
            move!.pulseEpoch[index] = move!.epoch;
            setAttribute(ping, 'data-astrid-reconnect-pulse', 'true');
          }
        }
        if (move) {
          move.curveVelocities[index] = canonicalizing && canonicalProgress >= 1 ? Array(8).fill(0) : nextVelocities;
          move.paintedCurves[index] = paintedCurve;
          move.curveLastPaintedAt[index] = elapsed;
        }
      }
      // Follow only finite geometry animations, including their delays. Decorative infinite pulses
      // and opacity-only animations cannot keep the measurement loop alive.
      const moving = !reducedMotion && (stageElement.getAnimations?.({ subtree: true }) ?? []).some((animation) => {
        if (animation.playState !== 'running' && !animation.pending) return false;
        const effect = animation.effect;
        return typeof KeyframeEffect !== 'undefined' && effect instanceof KeyframeEffect && effect.target instanceof HTMLElement
          && effect.getTiming().iterations !== Infinity
          && effect.getKeyframes().some((keyframe) => ['transform', 'translate', 'scale', 'rotate', ...TRACKED_PROPERTIES].some((property) => keyframe[property] !== undefined));
      });
      // A final WAAPI frame can be missed by the geometry epsilon. Treat the end
      // of the finite card motion as the fallback settle signal, but keep sampling
      // until then so the gate cannot strand the old endpoint forever.
      if (move && !appView && move.settledAt === undefined
        && (cardsEffectivelySettled || (!moving && elapsed >= CALLOUT_MOVE_MS))) {
        move.settledAt = performance.now();
        move.phase = 'extending';
      } else if (move && !appView && move.settledAt === undefined) {
        move.phase = elapsed < retractUntil ? 'retracting' : 'waiting-for-layout';
      }
      writes.forEach((write) => write());
      const allTargetsReady = move?.targetReady.every(Boolean) ?? true;
      const allCanonicalFramesPainted = move?.canonicalFramePainted.every(Boolean) ?? true;
      const allExtensionsDone = move?.extensionStartedAt.every((startedAt, index) => startedAt !== undefined
        && move.canonicalFramePainted[index]
        && elapsed >= startedAt + extendDuration + CALLOUT_VACUUM_SETTLE_MS
          + CALLOUT_VACUUM_POST_CONNECT_SETTLE_MS + CALLOUT_VACUUM_CANONICALIZE_MS) ?? true;
      const connectorAnimating = move?.extensionStartedAt.some((startedAt, index) => startedAt !== undefined
        && !move.canonicalFramePainted[index]) ?? false;
      // Keep the RAF loop alive through the retract/hold gate even when a test
      // harness or browser reports no running WAAPI animation yet. Once a target
      // is unavailable and the partial retract is complete, Mutation/ResizeObserver
      // callbacks can wake the loop when that target actually arrives.
      const waitingForLayout = move !== null && !appView && move.settledAt === undefined;
      const lastScheduledExtensionAt = move && Number.isFinite(baseExtendAt)
        ? Math.max(...move.staggerIndices.map(index => baseExtendAt + index * CALLOUT_VACUUM_RECONNECT_STAGGER_MS))
        : baseExtendAt;
      const connectorRetracting = move !== null && elapsed < (Number.isFinite(lastScheduledExtensionAt) ? lastScheduledExtensionAt : retractUntil);
      if (move && allTargetsReady && allCanonicalFramesPainted && allExtensionsDone) {
        // Keep the exact terminal target available for subsequent static paints.
        // This prevents a post-cleanup live recomputation from changing the
        // resting bend while the settled layout is otherwise unchanged.
        settledCanonicalCurves.current = move.canonicalTarget.map(curve => curve.slice());
        settledCanonicalEpoch.current = move.epoch;
        moveRef.current = null;
      }
      if (trackedChanged || !settled || moving || waitingForLayout || connectorRetracting || connectorAnimating) schedule();
    }
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    const observeGeometry = () => {
      if (!alive) return;
      resizeObserver?.disconnect();
      resizeObserver?.observe(stageElement);
      stageElement.querySelectorAll('.astrid-editor-surfaces, .astrid-surface, .astrid-callout').forEach((element) => resizeObserver?.observe(element));
      // Content can resize inside a fixed-size chat panel after the move has ended.
      // Mutation observation handles arrival; target resize observation handles later layout.
      for (const callout of callouts) {
        const selectors = new Set([callout.target, callout.phoneTarget].filter((selector): selector is string => Boolean(selector)));
        for (const selector of selectors) {
          stageElement.querySelectorAll(selector).forEach((element) => resizeObserver?.observe(element));
        }
      }
      schedule();
    };
      // The lazy editor and conversation arrive after the callouts. Observe structure, never the
    // inline styles / SVG attributes written by draw(), so this cannot restart its own work.
    const mutationObserver = new MutationObserver(observeGeometry);
    mutationObserver.observe(stageElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-hidden', 'data-state', 'data-revealed', 'data-audience'] });
    // Paint the retracted transition state synchronously before the browser can
    // expose the newly committed audience surface/card arrangement.
    draw();
    observeGeometry();
    const onPointerMove = (event: PointerEvent) => {
      if (reducedMotion || phoneQuery.matches || event.pointerType !== 'mouse') return;
      pointer = { x: event.clientX, y: event.clientY, leaving: false };
      schedule();
    };
    const onPointerLeave = (event: PointerEvent) => {
      if (reducedMotion || phoneQuery.matches) return;
      pointer = { x: event.clientX, y: event.clientY, leaving: true };
      schedule();
    };
    stageElement.addEventListener('pointermove', onPointerMove);
    stageElement.addEventListener('pointerleave', onPointerLeave);
    stageElement.addEventListener('scroll', schedule, true);
    window.addEventListener('scroll', schedule, { passive: true });
    stageElement.addEventListener('animationstart', schedule);
    stageElement.addEventListener('animationend', schedule);
    stageElement.addEventListener('animationcancel', schedule);
    stageElement.addEventListener('transitionrun', schedule);
    stageElement.addEventListener('transitionend', schedule);
    stageElement.addEventListener('transitioncancel', schedule);
    window.addEventListener('resize', schedule);
    phoneQuery.addEventListener('change', schedule);
    tabletQuery.addEventListener('change', schedule);
    return () => {
      alive = false;
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      stageElement.removeEventListener('pointermove', onPointerMove);
      stageElement.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('scroll', schedule);
      stageElement.removeEventListener('scroll', schedule, true);
      stageElement.removeEventListener('animationstart', schedule);
      stageElement.removeEventListener('animationend', schedule);
      stageElement.removeEventListener('animationcancel', schedule);
      stageElement.removeEventListener('transitionrun', schedule);
      stageElement.removeEventListener('transitionend', schedule);
      stageElement.removeEventListener('transitioncancel', schedule);
      window.removeEventListener('resize', schedule);
      phoneQuery.removeEventListener('change', schedule);
      tabletQuery.removeEventListener('change', schedule);
      stageElement.querySelector<HTMLElement>('.astrid-editor-tilt')?.style.removeProperty('transform');
      for (const rider of RIDERS) releaseTracked(stageElement.querySelector<HTMLElement>(rider.overlay));
      // The outgoing launcher stays at its tracked box until the connector retargets.
    };
  }, [active, appView, audience, callouts, reducedMotion, stageRef]);

  return (
    <PublicAstridCalloutLayout audience={audience} reducedMotion={reducedMotion} active={active} move={moveRef}>
      <svg ref={svgRef} className="astrid-callout-connectors" aria-hidden="true">
        {callouts.map((callout, index) => (
            <g key={index} style={calloutTiming(index, audience, callout.id)}>
            <path data-callout={callout.id} pathLength={1} />
            <circle className="astrid-callout-ping" data-callout-ping={callout.id} r="0" />
            <circle className="astrid-callout-dot-start" data-callout={callout.id} r="0" />
            <circle className="astrid-callout-dot-end" data-callout={callout.id} r="0" />
          </g>
        ))}
      </svg>
      {callouts.map((callout, index) => phone ? (
        <article
          key={index}
          className="astrid-callout"
          data-callout={callout.id}
          data-compact
          data-open={openId === callout.id}
          style={calloutTiming(index, audience, callout.id)}
          ref={(element) => {
            if (element) cardRefs.current.set(callout.id, element);
            else cardRefs.current.delete(callout.id);
          }}
        >
          <div className="astrid-callout-content">
            <h2>
              <button
                type="button"
                className="astrid-callout-toggle"
                aria-expanded={openId === callout.id}
                aria-controls={`${bodyIdPrefix}${callout.id}`}
                onClick={() => setOpenId(current => current === callout.id ? null : callout.id)}
              >
                <span>{callout.phoneTitle}</span>
                <span className="astrid-callout-toggle-icon" aria-hidden="true" />
              </button>
            </h2>
            <div className="astrid-callout-body" id={`${bodyIdPrefix}${callout.id}`}>
              <div className="astrid-callout-body-inner">
                {callout.id === 'tools' && <IntegrationLinks />}
                <p>{callout.phoneBody ?? callout.body}</p>
              </div>
            </div>
          </div>
        </article>
      ) : (
        <article
          key={index}
          className="astrid-callout"
          data-callout={callout.id}
          style={calloutTiming(index, audience, callout.id)}
          ref={(element) => {
            if (element) cardRefs.current.set(callout.id, element);
            else cardRefs.current.delete(callout.id);
          }}
        >
          <div className="astrid-callout-content">
          <h2>{callout.id === 'workflows' ? <><span className="astrid-workflows-title-line">Leverages reusable</span>{' '}<span className="astrid-workflows-title-line">agent workflows</span></> : callout.title}</h2>
          {callout.id === 'tools' && <><p>For example:</p><IntegrationLinks /></>}
          <p>{callout.body}</p>
          </div>
        </article>
      ))}
    </PublicAstridCalloutLayout>
  );
}

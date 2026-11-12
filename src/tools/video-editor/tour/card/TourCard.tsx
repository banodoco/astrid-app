import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import './TourCard.css';
import { EDITOR_TOUR_SCRIPT as SCRIPT } from '../tourScript';
import { TOUR_FINALE_ENTRANCE_MS, TourStrip } from './TourStrip';
import { TourVisual } from './TourVisual';
import { TOUR_COMPARE_ENTRANCE_MS } from './TourCompare';
import { TOUR_CARD_ENTRANCE_MS, useTourCardEntrance } from './useTourCardEntrance';
import { EDITOR_TOUR_GALLERY_ACT, markEditorTourReady, useEditorTour, type EditorTourAct, type EditorTourBeat } from '@/shared/state/editorTourStore';
import { ChevronLeft, ChevronUp } from 'lucide-react';
import { DiscordMark } from '@/pages/Home/PublicAstridSocialLinks';
import { DISCORD_URL } from '@/pages/Home/publicAstridLinks';
import { Button } from '@/shared/components/ui/button.tsx';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import { detectInstallScenario } from '@/pages/Home/installScenario.ts';
import type { TimelineDeviceClass } from '../../lib/mobile-interaction-model';

export interface TourCardProps {
  /** The beat to show: the runner's settled beat, which trails the store's while the card is about to move. */
  act: EditorTourAct;
  beat: EditorTourBeat;
  /** Next, Start creating, or (while the reply plays) finish it: the runner decides, as for Enter. */
  onPrimary: () => void;
  /** Go back to the previous place the user acted. Without it the card shows no Back. */
  onBack?: () => void;
  /** Leave the tour, as Esc does. Without it the card only names the key. */
  onSkip?: () => void;
  /**
   * The editor's layout. A phone's card spans the screen and leaves the picture to the spotlit preview above it; a tablet's
   * is roomier with a larger strip in place of the picture; both size every control for a finger (44 px).
   */
  device?: TimelineDeviceClass;
  /**
   * False while the card is still travelling to this beat's spot (the runner's move): its entrance (the visual, the strip,
   * the underline, the comparison's sweep and any video) waits, held at its start, and begins as the card comes to rest.
   */
  arrived?: boolean;
  /** The card's own rise into view; off when the runner brings the content in with its move instead. */
  rise?: boolean;
  /** Respond only, while the reply is still coming in: a quiet working line, and no Next yet (Enter still finishes it). */
  working?: boolean;
}

/** What the card's parts need to know about the device: finger-sized controls, and which layout. */
interface Fit {
  touch: boolean;
  device: TimelineDeviceClass;
  showKeyboardHints: boolean;
}

const ACT_COUNT = 3;

/**
 * The tour's card, for whatever beat the store is on. It opens with Astrid's welcome; while the chat has
 * the spotlight it is a quiet line (and the Next for the reply); on each `land` it explains the act with a
 * visual and the Agent → open models → output strip; at the end it says this was one example, then asks for feedback. Presentational: the runner positions it and owns the
 * actions. It marks itself ready once its entrance has played (at once on reduced motion or a skip).
 */
export function TourCard({ act, beat, onPrimary, onBack, onSkip, device = 'desktop', arrived = true, rise = true, working = false }: TourCardProps) {
  const runId = useEditorTour((state) => state.runId);
  const live = useEditorTour((state) => state.act === act && state.beat === beat);
  const key = `${runId}:${act}:${beat}${working ? ':working' : ''}`;
  const explains = beat === 'welcome' || beat === 'land' || beat === 'gallery' || beat === 'finale' || beat === 'feedback';
  const coarse = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches);
  const fit: Fit = { device, touch: device !== 'desktop' || coarse, showKeyboardHints: detectInstallScenario() !== 'mobile' && !coarse };
  const phone = device === 'phone';
  const tablet = device === 'tablet';
  // A card still showing the previous beat never reports ready for the new one.
  // The finale's entrance runs on until its chain has lit, and act 2's until its comparison has swept to rest.
  const entranceMs = beat === 'finale' ? TOUR_FINALE_ENTRANCE_MS
    : beat === 'land' && SCRIPT.acts[act].card.visual === 'frame-to-still' ? TOUR_COMPARE_ENTRANCE_MS
    : TOUR_CARD_ENTRANCE_MS;
  const { settled, reducedMotion } = useTourCardEntrance(key, explains && live, entranceMs, arrived);
  const playing = !reducedMotion && arrived;
  // Whether a phone explainer's body shows: open to begin with, then as the user last left it, for this run.
  const [detailsFor, setDetailsFor] = useState({ runId, open: true });
  const detailsOpen = detailsFor.runId === runId ? detailsFor.open : true;
  const details: Details = { open: detailsOpen, onToggle: () => setDetailsFor({ runId, open: !detailsOpen }), animate: !reducedMotion };
  // The card is there and at rest: from now its Next acts on the first press, whatever of its entrance is still playing.
  useEffect(() => {
    if (arrived && live && !working) markEditorTourReady('arrived');
  }, [arrived, live, working, key]);

  return (
    <div
      key={key}
      data-editor-tour-card={beat}
      data-editor-tour-card-phase={working ? 'working' : undefined}
      data-settled={settled || undefined}
      data-arrived={arrived || undefined}
      className={cn('editor-tour-card', reducedMotion ? 'editor-tour-card-reduced' : !settled && cn('editor-tour-card-playing', !arrived && 'editor-tour-card-waiting'))}
    >
      <section
        aria-label={beat === 'welcome' ? SCRIPT.welcome.title : beat === 'finale' ? SCRIPT.finale.title : beat === 'feedback' ? feedbackTitle() : beat === 'gallery' ? `Tour, step ${act} of ${ACT_COUNT}, part 2 of 2` : `Tour, step ${act} of ${ACT_COUNT}`}
        className={cn(
          rise && 'editor-tour-rise',
          'relative max-w-[calc(100vw-24px)] max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain rounded-xl border border-border bg-card text-card-foreground shadow-xl',
          phone ? cn('w-[calc(100vw-24px)] rounded-2xl', beat === 'land' ? 'px-5 py-3' : explains ? 'p-5' : 'px-5 py-4') : tablet ? cn(
            beat === 'welcome' && 'w-[460px] p-7',
            (beat === 'land' || beat === 'gallery') && 'w-[580px] p-6',
            beat === 'finale' && 'w-[540px] p-7',
            beat === 'feedback' && 'w-[500px] p-7',
            !explains && 'w-[400px] px-5 py-4',
          ) : cn(
            beat === 'welcome' && 'w-[400px] p-6',
            (beat === 'land' || beat === 'gallery') && 'w-[380px] p-5',
            beat === 'finale' && 'w-[480px] p-6',
            beat === 'feedback' && 'w-[440px] p-6',
            !explains && (beat === 'respond' || (beat === 'compose' && SCRIPT.acts[act].composeHeader) ? 'w-[360px]' : 'w-[300px]') + ' px-4 py-3',
          ),
        )}
      >
        {/* The runner fades this in and out as the card travels; the section itself (the card's box) stays. */}
        <div data-editor-tour-card-content>
        {beat === 'welcome' && <Welcome onPrimary={onPrimary} onSkip={onSkip} fit={fit} />}
        {beat === 'land' && <Explainer act={act} playing={playing} entering={!reducedMotion && !settled} waiting={!arrived} details={details} onPrimary={onPrimary} onBack={onBack} onSkip={onSkip} fit={fit} />}
        {beat === 'gallery' && <GalleryExplainer act={act} onPrimary={onPrimary} onBack={onBack} onSkip={onSkip} fit={fit} />}
        {beat === 'finale' && <Finale onPrimary={onPrimary} onBack={onBack} fit={fit} />}
        {beat === 'feedback' && <Feedback onPrimary={onPrimary} onBack={onBack} fit={fit} />}
        {!explains && <Hint act={act} beat={beat} working={working} onPrimary={onPrimary} onBack={onBack} onSkip={onSkip} fit={fit} />}
        </div>
      </section>
    </div>
  );
}

/**
 * The top row of the Hint and the Explainer: "N of 3", Back right beside it, Skip on the right. On touch, Back moves to
 * the card's foot (`NavRow`), so every card keeps its controls in the same two places.
 */
function CounterRow({ act, part, onBack, onSkip, fit }: { act: EditorTourAct; part?: 1 | 2; fit: Fit } & Pick<TourCardProps, 'onBack' | 'onSkip'>) {
  return (
    <div className="flex items-center justify-between leading-none text-muted-foreground">
      <div className="flex items-center gap-3">
        <span className="text-xs tabular-nums">{act} of {ACT_COUNT}</span>
        {part && <PartDots part={part} />}
        {!fit.touch && <BackControl onBack={onBack} touch={false} />}
      </div>
      <SkipControl onSkip={onSkip} fit={fit} />
    </div>
  );
}

/** Step 2 has two parts: two small dots after the counter, the first lit on part 1 and both on part 2. Screen readers get the words. */
function PartDots({ part }: { part: 1 | 2 }) {
  return (
    <>
      <span aria-hidden="true" className="-ml-1.5 flex items-center gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-foreground/70" />
        <span className={cn('h-1.5 w-1.5 rounded-full', part === 2 ? 'bg-foreground/70' : 'bg-muted-foreground/30')} />
      </span>
      {/* Hidden by opacity, not `sr-only`: its 1px clip reads as clipped text to the screenshot walk's layout checks. */}
      <span className="pointer-events-none absolute whitespace-nowrap opacity-0">part {part} of 2</span>
    </>
  );
}

/** Touch cards' foot: the way back (or out) on the left, the one thing to do next on the right, under the thumb. */
function NavRow({ secondary, children, className }: { secondary?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('mt-5 flex items-center justify-between gap-3', className)}>
      {secondary ?? <span />}
      {children}
    </div>
  );
}

/** One heading style for every card's title on touch (Astrid's own cards keep the larger mink title). */
const TOUCH_HEADING = 'text-pretty font-serif font-theme-heading text-xl leading-tight text-foreground';

/** A phone explainer's body can be folded away; the choice is kept for the rest of the run. */
interface Details { open: boolean; onToggle: () => void; animate: boolean }

/**
 * The little tab on a phone explainer's bottom edge: an arrow pointing up while the body shows (press to fold it away,
 * leaving the title and the buttons, and the whole preview in view) and down once it is folded (press to bring it back).
 * It sits in the card's own bottom padding, between Back and Next, so it costs the card no height; its touch target is
 * 44 px all the same.
 */
function DetailsTab({ open, onToggle, animate, controls }: Details & { controls: string }) {
  return (
    <button
      type="button"
      data-editor-tour-details-tab
      aria-expanded={open}
      aria-controls={controls}
      aria-label={open ? SCRIPT.controls.hideDetails : SCRIPT.controls.showDetails}
      className="group absolute bottom-0 left-1/2 flex h-11 w-16 -translate-x-1/2 items-end justify-center rounded-sm focus-visible:outline-none"
      onClick={onToggle}
    >
      <span className="flex h-4 w-12 items-center justify-center rounded-t-md border border-b-0 border-border/70 bg-muted/60 text-muted-foreground transition-colors group-hover:text-foreground group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <ChevronUp className={cn('h-3.5 w-3.5', animate && 'transition-transform duration-300', !open && 'rotate-180')} aria-hidden />
      </span>
    </button>
  );
}

function Explainer({ act, playing, entering, waiting, details, onPrimary, onBack, onSkip, fit }: { act: EditorTourAct; playing: boolean; entering: boolean; waiting: boolean; details: Details; fit: Fit } & Omit<TourCardProps, 'act' | 'beat'>) {
  const { title, body, visual, labels } = SCRIPT.acts[act].card;
  const next = <PrimaryButton label={SCRIPT.controls.next} onPrimary={onPrimary} fit={fit} />;
  const part = act === EDITOR_TOUR_GALLERY_ACT ? 1 : undefined;
  if (!fit.touch) {
    return (
      <>
        <CounterRow act={act} part={part} onBack={onBack} onSkip={onSkip} fit={fit} />
        <div className="mt-3">
          <TourVisual visual={visual} labels={labels} playing={playing} entering={entering} waiting={waiting} />
        </div>
        <h2 className="mt-4 text-pretty font-serif font-theme-heading text-lg leading-tight text-foreground">{title}</h2>
        <p className="mt-1.5 text-pretty text-sm leading-6 text-muted-foreground">{body}</p>
        <div className="mt-4">
          <TourStrip filled={act} labels={SCRIPT.strip} />
        </div>
        <div className="mt-5 flex justify-end">{next}</div>
      </>
    );
  }
  // On touch the spotlit preview above shows this act's picture, full size. A tablet keeps the chain as a pager between
  // Back and Next. A phone's card sits above the preview: its body shows by default and folds away behind the tab on its
  // bottom edge, which leaves the compact card (title, Back, Next) and the whole preview in view.
  const tablet = fit.device === 'tablet';
  const bodyId = `editor-tour-details-${act}`;
  return (
    <>
      <CounterRow act={act} part={part} onBack={onBack} onSkip={onSkip} fit={fit} />
      <h2 className={cn(tablet ? 'mt-3' : 'mt-2', TOUCH_HEADING)}>{title}</h2>
      {tablet && <p className="mt-1.5 text-pretty text-[15px] leading-6 text-muted-foreground">{body}</p>}
      {!tablet && (
        // Rows 1fr <-> 0fr: the body's own height animates, whatever it is, and the card grows down from its fixed top.
        <div
          id={bodyId}
          data-editor-tour-details={details.open ? 'open' : 'folded'}
          className={cn('grid', details.animate && 'transition-[grid-template-rows,opacity] duration-300 ease-out', details.open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}
          {...(details.open ? {} : { inert: '' })}
        >
          <div className="min-h-0 overflow-hidden">
            <p className="pt-1.5 text-pretty text-sm leading-[1.4rem] text-muted-foreground">{body}</p>
          </div>
        </div>
      )}
      <NavRow secondary={<BackControl onBack={onBack} touch />} className={tablet ? 'items-end gap-5' : 'mt-2'}>
        {tablet && <div className="min-w-0 flex-1"><TourStrip filled={act} labels={SCRIPT.strip} size="medium" /></div>}
        {next}
      </NavRow>
      {!tablet && <DetailsTab {...details} controls={bodyId} />}
    </>
  );
}

/** Part 2 of step 2: what the Generations pane (sliding up beneath this card) holds. No picture and no strip; the pane is the visual. */
function GalleryExplainer({ act, onPrimary, onBack, onSkip, fit }: { act: EditorTourAct; fit: Fit } & Omit<TourCardProps, 'act' | 'beat'>) {
  const { title, body } = SCRIPT.gallery;
  const next = <PrimaryButton label={SCRIPT.controls.next} onPrimary={onPrimary} fit={fit} />;
  if (!fit.touch) {
    return (
      <>
        <CounterRow act={act} part={2} onBack={onBack} onSkip={onSkip} fit={fit} />
        <h2 className="mt-3 text-pretty font-serif font-theme-heading text-lg leading-tight text-foreground">{title}</h2>
        <p className="mt-1.5 text-pretty text-sm leading-6 text-muted-foreground">{body}</p>
        <div className="mt-5 flex justify-end">{next}</div>
      </>
    );
  }
  return (
    <>
      <CounterRow act={act} part={2} onBack={onBack} onSkip={onSkip} fit={fit} />
      <h2 className={cn('mt-3', TOUCH_HEADING)}>{title}</h2>
      <p className={cn('mt-1.5 text-pretty text-muted-foreground', fit.device === 'tablet' ? 'text-[15px] leading-6' : 'text-sm leading-[1.4rem]')}>{body}</p>
      <NavRow secondary={<BackControl onBack={onBack} touch />}>{next}</NavRow>
    </>
  );
}

/** Astrid speaks at the start and the end: the pixel mink, at a whole multiple of its 16px grid, beside the title. */
function MinkTitle({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <img src="/astrid-favicon.svg" alt="" className="h-8 w-8 [image-rendering:pixelated]" draggable={false} />
      <h2 className="font-serif font-theme-heading text-2xl leading-tight text-foreground">{children}</h2>
    </div>
  );
}

function Welcome({ onPrimary, onSkip, fit }: Omit<TourCardProps, 'act' | 'beat'> & { fit: Fit }) {
  return (
    <>
      <MinkTitle>{SCRIPT.welcome.title}</MinkTitle>
      <p className="mt-3 text-pretty text-[15px] leading-6 text-muted-foreground">{SCRIPT.welcome.body}</p>
      <div className="mt-6 flex items-center justify-between gap-3">
        <SkipControl onSkip={onSkip} fit={fit} />
        <PrimaryButton label={SCRIPT.welcome.action} onPrimary={onPrimary} size="default" fit={fit} />
      </div>
    </>
  );
}

/** "And this is just one example": the lit chain is the example, and the line under it opens it out. */
function Finale({ onPrimary, onBack, fit }: { onPrimary: () => void; onBack?: () => void; fit: Fit }) {
  return (
    <>
      <MinkTitle>{SCRIPT.finale.title}</MinkTitle>
      <div className="mt-6">
        <TourStrip filled={3} labels={SCRIPT.finale.recap} size="large" wrapLabels={fit.device === 'phone'} />
      </div>
      <p className="mt-6 text-pretty text-[15px] leading-6 text-muted-foreground">{SCRIPT.finale.body}</p>
      <div className="mt-6 flex items-center justify-between gap-3">
        <BackControl onBack={onBack} touch={fit.touch} />
        <PrimaryButton label={SCRIPT.finale.action} onPrimary={onPrimary} size="default" fit={fit} />
      </div>
    </>
  );
}

function Feedback({ onPrimary, onBack, fit }: { onPrimary: () => void; onBack?: () => void; fit: Fit }) {
  // On a phone or tablet the tour ends by sending Astrid to a computer, so "Start creating" would promise the wrong next screen.
  const action = detectInstallScenario() === 'mobile' ? SCRIPT.feedback.mobileAction : SCRIPT.feedback.action;
  return (
    <>
      <MinkTitle><FeedbackTitle /></MinkTitle>
      <p className="mt-3 text-pretty text-[15px] leading-6 text-muted-foreground">{fit.device === 'phone' ? SCRIPT.feedback.shortBody : SCRIPT.feedback.body}</p>
      <Button asChild variant="outline" className={cn('mt-4 gap-2', fit.touch && 'h-11')}>
        <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer">
          <DiscordMark />
          {SCRIPT.feedback.discord}
        </a>
      </Button>
      <div className="mt-6 flex items-center justify-between gap-3">
        <BackControl onBack={onBack} touch={fit.touch} />
        <PrimaryButton label={action} onPrimary={onPrimary} size="default" fit={fit} />
      </div>
    </>
  );
}

const feedbackTitle = () => [SCRIPT.feedback.title.before, SCRIPT.feedback.title.emphasis, SCRIPT.feedback.title.after].join(' ');

/**
 * "We really need your feedback", with the emphasised word underlined by a pen stroke that draws in once the card has landed
 * (TourCard.css) and then stays; at rest, under reduced motion and on Back it is simply there. The stroke hangs just under the
 * baseline, outside the line box's flow, so the title neither moves nor grows, and it stays with its word when the title wraps.
 */
function FeedbackTitle() {
  const { before, emphasis, after } = SCRIPT.feedback.title;
  return (
    <>
      {before}{' '}
      <span data-tour-emphasis className="relative whitespace-nowrap">
        {emphasis}
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute -left-[0.06em] top-[calc(100%-0.16em)] h-[0.32em] w-[calc(100%+0.12em)] overflow-visible text-primary"
          viewBox="0 0 100 10"
          preserveAspectRatio="none"
        >
          {/* A slight rise and dip, like a pen's, never a ruler's line. */}
          <path
            className="editor-tour-underline"
            style={{ '--tour-delay': '350ms' } as CSSProperties}
            d="M1 6.2 C 18 4.6, 40 4.2, 60 5 S 88 6.4, 99 4.4"
            pathLength={1}
            strokeDasharray={1}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.6}
            strokeLinecap="round"
          />
        </svg>
      </span>{' '}
      {after}
    </>
  );
}

/**
 * Compose: send the prompt (the chat's Send, or Enter). Respond (act 1 only): the reply's Next. The chat's own Send is the
 * one way to send on every device: a touch compose card has no button of its own beside Back.
 */
function Hint({ act, beat, working, onPrimary, onBack, onSkip, fit }: TourCardProps & { fit: Fit }) {
  const compose = beat === 'compose';
  const header = compose ? SCRIPT.acts[act].composeHeader : undefined;
  if (working) {
    // While the reply comes in the card only keeps the user company; the reply's own line and its Next follow it.
    return (
      <>
        <CounterRow act={act} onBack={onBack} onSkip={onSkip} fit={fit} />
        <div className={cn('flex items-center', fit.touch ? 'mt-3 min-h-11' : 'mt-2 min-h-9')}>
          <p className="text-sm text-muted-foreground">{SCRIPT.hints.respondWorking}</p>
        </div>
      </>
    );
  }
  if (fit.touch) {
    return (
      <>
        <CounterRow act={act} onBack={onBack} onSkip={onSkip} fit={fit} />
        <h2 className={cn('mt-3', TOUCH_HEADING)}>{compose ? header ?? SCRIPT.hints.composeTouch : SCRIPT.hints.respond}</h2>
        {compose && header && <p className={cn('mt-1.5 text-muted-foreground', fit.device === 'tablet' ? 'text-[15px]' : 'text-sm')}>{SCRIPT.hints.composeTouch}</p>}
        {(!compose || onBack) && (
          <NavRow secondary={<BackControl onBack={onBack} touch />} className={compose ? 'mt-2' : undefined}>
            {compose ? <span /> : <PrimaryButton label={SCRIPT.controls.next} onPrimary={onPrimary} fit={fit} />}
          </NavRow>
        )}
      </>
    );
  }
  return (
    <>
      <CounterRow act={act} onBack={onBack} onSkip={onSkip} fit={fit} />
      {header && (
        <h2 className="mt-3 text-pretty font-serif font-theme-heading text-lg leading-tight text-foreground">{header}</h2>
      )}
      <div className="mt-2 flex min-h-9 items-center justify-between gap-3">
        <p className="text-sm text-foreground">{compose ? SCRIPT.hints.compose : SCRIPT.hints.respond}</p>
        {compose ? fit.showKeyboardHints && <Kbd>↵</Kbd> : <PrimaryButton label={SCRIPT.controls.next} onPrimary={onPrimary} fit={fit} />}
      </div>
    </>
  );
}

function PrimaryButton({ label, icon, onPrimary, size = 'sm', fit }: { label: string; icon?: ReactNode; onPrimary: () => void; size?: 'sm' | 'default'; fit: Fit }) {
  return (
    <Button type="button" size={fit.touch ? 'lg' : size} className={cn('shrink-0 gap-2', fit.touch ? 'min-w-24 px-6 text-[15px]' : 'pr-2.5')} onClick={onPrimary}>
      {label}
      {icon}
      {fit.showKeyboardHints && <Kbd onPrimary>↵</Kbd>}
    </Button>
  );
}

/** Quiet text controls; on touch their hit area grows to 44 px around the same visual size. */
const QUIET_TOUCH = 'min-h-11 min-w-11 -my-3.5 justify-center text-sm';

function BackControl({ onBack, touch }: { onBack?: () => void; touch: boolean }) {
  if (!onBack) return null;
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-sm leading-none text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        touch ? cn(QUIET_TOUCH, '-mx-2 px-2') : '-mx-1 -my-1.5 px-1 py-1.5 text-xs',
      )}
      onClick={onBack}
    >
      <ChevronLeft className={touch ? 'h-4 w-4' : 'h-3 w-3'} aria-hidden />
      {SCRIPT.controls.back}
    </button>
  );
}

function SkipControl({ onSkip, fit }: { onSkip?: () => void; fit: Fit }) {
  const content = (
    <>
      {SCRIPT.controls.skip}
      {fit.showKeyboardHints && <Kbd>Esc</Kbd>}
    </>
  );
  const className = cn('inline-flex items-center gap-1.5 leading-none text-muted-foreground', fit.touch ? cn(QUIET_TOUCH, '-mx-2 px-2') : 'text-xs');
  if (!onSkip) return <span className={className}>{content}</span>;
  return (
    <button type="button" className={cn(className, 'rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')} onClick={onSkip}>
      {content}
    </button>
  );
}

function Kbd({ children, onPrimary = false }: { children: ReactNode; onPrimary?: boolean }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 font-sans text-[10px] leading-none',
        onPrimary ? 'border-primary-foreground/30 text-primary-foreground/80' : 'border-border text-muted-foreground',
      )}
    >
      {children}
    </kbd>
  );
}

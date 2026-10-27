import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronLeft, Link2 } from 'lucide-react';
import { Button } from '@/shared/components/ui/button.tsx';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import { MinkRunner } from '@/shared/components/MinkRunner/MinkRunner.tsx';
import { ToolbarPointer } from '@/shared/components/ToolbarPointer/ToolbarPointer.tsx';
import type { RuntimeConnectionPanelExit, RuntimeConnectionValue } from '@/integrations/runtime/RuntimeConnectionProvider.tsx';
import { ASTRID_HELP_URL } from '@/integrations/astrid/help.ts';
import { useSendLinkToComputer } from '@/pages/Home/useSendLinkToComputer.ts';
import { CopyFallback, CopyInstallCommand, useCopyAction } from './CopyInstallCommand.tsx';
import { CardDisclosure, EditorCard, EditorCardFoot } from './EditorCard.tsx';
import { EditorCardLayer } from './EditorCardLayer.tsx';
import { CopyRefusedInstructions } from './CopyRefusedInstructions.tsx';
import { PINOKIO_INSTALL_COPY, RUNTIME_CONNECTION_COPY as COPY, withBrowser, withOrigin } from './copy.ts';
import { detectInstallScenario } from '@/pages/Home/installScenario.ts';
import { linkForSupportedBrowser } from '@/integrations/runtime/autoConnectRequest.ts';
import { runtimeOrigin } from '@/integrations/runtime/connection.ts';
import { resolveUpdate } from '@/shared/lib/updates/resolveUpdate.ts';
import { UpdateResolutionActions } from './UpdateResolutionActions.tsx';

export interface RuntimeConnectionPanelProps {
  /** The gate's value: the screen to show (on the way out, the last one shown). */
  readonly connection: RuntimeConnectionValue;
  /** Set once Astrid has connected after this panel asked for something: it shows so, then leaves (see the gate). */
  readonly exit?: RuntimeConnectionPanelExit | null;
  /** Shown only when the caller is an onboarding flow that can return to its previous step. */
  readonly onBack?: () => void;
}

/** How long the mark is alone on the screen before the line under it fades in. */
const CONNECTING_LINE_DELAY_MS = 1000;
/** The shortest time "Connected to Astrid" is up, so it is read; the panel then waits for the editor to settle. */
export const CONNECTED_MIN_MS = 900;
/**
 * How long nothing may hold the boot before the editor counts as settled: the editor hands its hold from the
 * workspace to the timeline across a render or two, and the panel must not leave in that gap.
 */
export const SETTLED_QUIET_MS = 150;
/** The panel's way out: the card lifts away and the empty editor cross-fades into the real one. */
export const LEAVE_MS = 500;

/** The editor beneath has painted its frame: nothing in the page holds the boot (`bootLayer.ts`'s ready signal). */
function appSettled(): boolean {
  return document.querySelector('[data-boot-hold]') === null;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * On the way out: true once `holdMs` has passed (the "Connected" moment, on a screen that asked for something) and the
 * editor beneath has settled, then `exit.left` after the leaving motion.
 */
function useLeaving(exit: RuntimeConnectionPanelExit | null, holdMs: number): boolean {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!exit) {
      setLeaving(false);
      return undefined;
    }
    let observer: MutationObserver | null = null;
    let quietTimer: number | undefined;
    let leftTimer: number | undefined;
    const leave = () => {
      observer?.disconnect();
      setLeaving(true);
      leftTimer = window.setTimeout(exit.left, prefersReducedMotion() ? 0 : LEAVE_MS);
    };
    // Settled once nothing has held the boot for a quiet moment; a hold that comes back starts the wait again.
    const check = () => {
      window.clearTimeout(quietTimer);
      if (appSettled()) quietTimer = window.setTimeout(() => { if (appSettled()) leave(); }, SETTLED_QUIET_MS);
    };
    const holdTimer = window.setTimeout(() => {
      observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-boot-hold'] });
      check();
    }, holdMs);
    return () => {
      window.clearTimeout(holdTimer);
      window.clearTimeout(quietTimer);
      window.clearTimeout(leftTimer);
      observer?.disconnect();
    };
  }, [exit, holdMs]);
  return leaving;
}

/** What the card's status line shows: Astrid answered (the panel is on its way out). */
const ConnectedContext = createContext(false);

/**
 * The layer every not-connected card sits on: the empty editor under a light veil, with the card in the middle. It
 * stays mounted while the screen changes (set up, Allow, blocked), so only the card changes. On the way out, the card
 * lifts away and the layer fades, revealing the real editor that has mounted beneath it in the same places.
 */
function GateLayer({ dataState, exit, children }: { dataState: string; exit: RuntimeConnectionPanelExit | null; children: ReactNode }) {
  const leaving = useLeaving(exit, CONNECTED_MIN_MS);
  return <EditorCardLayer aria-label={COPY.panelLabel} data-testid="runtime-not-connected" data-state={dataState} data-leaving={leaving ? '' : undefined} leaving={leaving} cardKey={dataState}>
    <ConnectedContext.Provider value={Boolean(exit)}>{children}</ConnectedContext.Provider>
  </EditorCardLayer>;
}

/**
 * The card's quiet last line, along its foot: what the page is waiting for, with a live dot. When Astrid answers it
 * becomes the check and "Connected to Astrid", in the same place, before the card leaves.
 */
function StatusLine({ text, help }: { text: string; help: boolean }) {
  const connected = useContext(ConnectedContext);
  // The words after the mark keep the width they had while waiting, so the mark stays where it was as it turns into
  // the check and only the words change.
  const wordsRef = useRef<HTMLSpanElement>(null);
  const waitingWidth = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!connected && wordsRef.current) waitingWidth.current = wordsRef.current.getBoundingClientRect().width;
  });
  return (
    <EditorCardFoot>
      <span aria-hidden="true" className="relative flex h-4 w-4 shrink-0 items-center justify-center">
        <span className={cn('absolute h-2 w-2 rounded-full bg-primary transition-opacity duration-200', connected ? 'opacity-0' : 'animate-pulse')} />
        <span className={cn('absolute flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[opacity,transform] duration-300 ease-out', connected ? 'scale-100 opacity-100' : 'scale-50 opacity-0')}>
          <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
        </span>
      </span>
      <span ref={wordsRef} className="flex min-w-0 items-center gap-2" style={connected && waitingWidth.current ? { minWidth: waitingWidth.current } : undefined}>
        <p role="status" className={cn('min-w-0 text-pretty', connected && 'text-foreground')}>
          <span key={connected ? 'connected' : 'waiting'} className={connected ? 'animate-in fade-in-0 duration-300' : undefined}>{connected ? COPY.connected.sentence : text}</span>
        </p>
        {help && !connected && (
          <>
            <span aria-hidden="true">·</span>
            <a className="shrink-0 underline underline-offset-4 hover:text-foreground" href={ASTRID_HELP_URL} target="_blank" rel="noreferrer">Get help</a>
          </>
        )}
      </span>
    </EditorCardFoot>
  );
}

interface CardProps {
  readonly title: string;
  readonly sentence: string;
  /** The state's one primary action. */
  readonly action?: ReactNode;
  /** Content between the sentence and the action (the blocked state's steps). */
  readonly children?: ReactNode;
  /** The status line along the card's foot: the screen waits for something done elsewhere, then opens by itself. */
  readonly status?: string;
  /** Help in the status line, for a connection that needs attention. */
  readonly showHelp?: boolean;
  /** The word on a hand-drawn arrow, outside the card, aimed at the top left of the window: the browser's prompt is there. */
  readonly pointer?: string;
  readonly onBack?: () => void;
}

/**
 * The one card every not-connected screen shares, in the install dialog's style (same width, radius, header and
 * button): the app icon, a serif heading, one short sentence, at most one primary action, and the status line.
 */
function Card({ title, sentence, action, children, status, pointer, showHelp = false, onBack }: CardProps) {
  const connected = useContext(ConnectedContext);
  if (connected) return <div className="overflow-hidden rounded-[18px] border border-border bg-card shadow-lg"><StatusLine text={COPY.connected.sentence} help={false} /></div>;
  return <>
    <EditorCard title={title} sentence={sentence} topLeft={onBack ? <BackButton onBack={onBack} /> : undefined} foot={(status || connected) ? <StatusLine text={status ?? COPY.waiting} help={showHelp} /> : undefined}>
      {children}
      {action}
    </EditorCard>
    {pointer && !connected && <ToolbarPointer label={pointer} corner="top-left" tone="page" />}
  </>;
}

/** On a touch screen its hit area grows to 44 px (up and out, so the card's layout does not move). */
function BackButton({ onBack }: { readonly onBack: () => void }) {
  return <Button type="button" variant="ghost" className="inline-flex h-auto items-center gap-0.5 rounded-md py-1 pl-1 pr-2 text-[13px] text-muted-foreground hover:bg-muted/60 hover:text-foreground [@media(pointer:coarse)]:-mt-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:pr-3 [@media(pointer:coarse)]:text-sm" onClick={onBack}><ChevronLeft aria-hidden="true" className="h-4 w-4" />Back</Button>;
}

/**
 * The mark alone on the page background, as the boot screen shows it; the line fades in only if the wait is not short.
 * When Astrid answers it stays, as the boot screen would, until the editor beneath has settled, then fades into it:
 * nothing was asked of the person, so there is no "Connected" moment.
 */
function ConnectingPanel({ exit, onBack }: { exit: RuntimeConnectionPanelExit | null; onBack?: () => void }) {
  const [lineShown, setLineShown] = useState(false);
  const leaving = useLeaving(exit, 0);
  useEffect(() => {
    const timer = window.setTimeout(() => setLineShown(true), CONNECTING_LINE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <section
      aria-label={COPY.panelLabel}
      data-testid="runtime-not-connected"
      data-state="connecting"
      data-leaving={leaving ? '' : undefined}
      className={cn(
        'fixed inset-0 z-[100100] flex flex-col items-center justify-center gap-4 bg-background p-4 text-foreground transition-opacity duration-500 ease-out motion-reduce:transition-none',
        leaving && 'pointer-events-none opacity-0',
      )}
    >
      {onBack && !exit && <div className="absolute left-4 top-4"><BackButton onBack={onBack} /></div>}
      {/* As tall as the line below, so the mark sits at the exact centre of the page: where the boot screen drew it. */}
      <div aria-hidden="true" className="min-h-5" />
      {/* The boot screen's mink, same size and place: the boot layer hands its stride over to this one (bootLayer.ts). */}
      <MinkRunner bootSize className="text-foreground" />
      {/* Always occupies its line, so the mark does not move when the words arrive. */}
      <p className="min-h-5 text-center text-sm text-muted-foreground">
        {lineShown && <span className="animate-in fade-in duration-500">{COPY.connecting.sentence}</span>}
      </p>
    </section>
  );
}

/** A phone: Astrid runs on a computer, so the only useful thing is to send this page there. */
function PhoneCard({ onBack }: { readonly onBack?: () => void }) {
  const { phone } = COPY;
  const { copied, fallback, send } = useSendLinkToComputer(() => window.location.href);
  return (
    <Card
      title={phone.title}
      sentence={phone.sentence}
      onBack={onBack}
      action={<div className="space-y-2">
        {/* Full width under a phone's thumb; on a tablet's wider card it keeps to its content. */}
        <Button type="button" className="h-11 w-full justify-between gap-6 rounded-xl px-4 sm:mx-auto sm:flex sm:w-auto" onClick={() => void send()}>
          <span>{copied ? phone.copied : phone.button}</span>
          {copied ? <Check aria-hidden="true" className="h-4 w-4" /> : <Link2 aria-hidden="true" className="h-4 w-4" />}
        </Button>
        {fallback && <CopyFallback text={window.location.href} label={phone.button} />}
      </div>}
    />
  );
}

/** A desktop browser without local-network access: carry this tab's link to a supported browser. */
function UnsupportedCard({ onBack, updateNeeded = false }: { readonly onBack?: () => void; readonly updateNeeded?: boolean }) {
  const { unsupported } = COPY;
  const message = updateNeeded ? COPY.browserUpdateNeeded : unsupported;
  const link = linkForSupportedBrowser();
  const copy = useCopyAction(link);
  return <Card title={withBrowser(message.title)} sentence={withBrowser(message.sentence)} onBack={onBack} action={<div className="space-y-2">
    <Button type="button" className="h-11 w-full rounded-xl" onClick={() => void copy.copy()}>{copy.status === 'copied' ? unsupported.copied : unsupported.button}</Button>
    {copy.status === 'failed' && <CopyFallback text={link} label={unsupported.button} />}
  </div>} />;
}

/** The browser's local-network prompt has not been asked: nothing was sent, and Connect is what asks. */
function PermissionCard({ connection, onBack }: { connection: RuntimeConnectionValue; onBack?: () => void }) {
  const { permission } = COPY;
  if (connection.isChecking) {
    // The browser's prompt is open: nothing to press, only where to look.
    return (
      <Card
        title={withBrowser(permission.pending.title)}
        sentence={withBrowser(permission.pending.sentence)}
        pointer={permission.pending.pointer}
        onBack={onBack}
      />
    );
  }
  return (
    <Card
      title={withBrowser(permission.title)}
      sentence={withBrowser(permission.sentence)}
      onBack={onBack}
      // Connect was pressed and Chrome did not answer (dismissed, or it never asked): point at the prompt again and give
      // the site-settings route, so the button is never the only way on.
      pointer={connection.askUnanswered ? permission.pending.pointer : undefined}
      action={<div className="space-y-2">
        <Button type="button" className="h-11 w-full rounded-xl" onClick={() => connection.connect()}>{permission.connect}</Button>
        {connection.askUnanswered && <div role="status" className="space-y-2 pt-1 text-left text-sm leading-6 text-foreground">
          <p>{withBrowser(permission.unanswered.lead)}</p>
          <ol className="space-y-2">
            {COPY.blocked.steps.map((step, index) => (
              <li key={step} className="flex gap-2.5">
                <span aria-hidden="true" className="mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">{index + 1}</span>
                <span className="text-pretty">{step}</span>
              </li>
            ))}
          </ol>
        </div>}
        <CardDisclosure label={permission.allowTitle}>{permission.allowDetails}</CardDisclosure>
        <CardDisclosure label={permission.installTitle}><CopyInstallCommand mode="install" />{detectInstallScenario() === 'chromium' && <PinokioInstallHelp />}</CardDisclosure>
      </div>}
    />
  );
}

function PinokioInstallHelp() {
  return <p className="mt-3 text-sm text-muted-foreground"><a className="underline underline-offset-4 hover:text-foreground" href={PINOKIO_INSTALL_COPY.installUrl} target="_blank" rel="noreferrer">{PINOKIO_INSTALL_COPY.label}</a></p>;
}

/** Permission `denied`: the browser stopped the request, so the fix is in its site settings. */
function BlockedCard({ onBack }: { readonly onBack?: () => void }) {
  const blocked = COPY.blocked;
  return (
    // No agent button: the fix is a browser site setting, which an agent cannot change.
    <Card title={withBrowser(blocked.title)} sentence={withBrowser(blocked.sentence)} status={blocked.footer} onBack={onBack}>
      {/* Numbered as the install dialog numbers its steps. */}
      <ol className="space-y-2 text-left text-sm leading-6 text-foreground">
        {blocked.steps.map((step, index) => (
          <li key={step} className="flex gap-2.5">
            <span aria-hidden="true" className="mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">{index + 1}</span>
            <span className="text-pretty">{step}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Repeated probes went unanswered with permission granted; polling continues during install or repair. */
function NotRunningCard({ connection, onBack }: { readonly connection: RuntimeConnectionValue; readonly onBack?: () => void }) {
  const { notRunning } = COPY;
  const pinokioManaged = connection.managedByPinokio === true;
  return <Card title={notRunning.title} sentence={pinokioManaged ? notRunning.pinokioHint : notRunning.sentence} onBack={onBack} action={<div className="space-y-2">{!pinokioManaged && <CopyInstallCommand mode="install" />}<Button type="button" variant="outline" className="w-full" onClick={connection.connect}>{notRunning.retry}</Button></div>} status={COPY.waiting} showHelp />;
}

/** Astrid answered, but not this page: no install help, because Astrid is already running. Polling continues. */
function RefusedCard({ connection, onBack }: { readonly connection: RuntimeConnectionValue; readonly onBack?: () => void }) {
  const { refused } = COPY;
  return <Card title={refused.title} sentence={withOrigin(refused.sentence, window.location.origin)} onBack={onBack} status={COPY.waiting} showHelp action={<div className="space-y-2">
    <CopyRefusedInstructions />
    <Button type="button" variant="outline" className="w-full" onClick={connection.connect}>{refused.retry}</Button>
  </div>} />;
}

function UpdateNeededCard({ connection, onBack }: { readonly connection: RuntimeConnectionValue; readonly onBack?: () => void }) {
  const { updateNeeded } = COPY;
  const pinokioManaged = connection.managedByPinokio === true;
  const resolution = resolveUpdate({ compatibility: { kind: 'schema', detail: pinokioManaged ? updateNeeded.pinokioSentence : updateNeeded.sentence }, installType: pinokioManaged ? 'pinokio' : runtimeOrigin() === '' ? 'source' : 'installer' });
  return <Card title={resolution.title ?? updateNeeded.title} sentence={resolution.body ?? updateNeeded.sentence} onBack={onBack} action={<UpdateResolutionActions resolution={resolution} />} status={COPY.waiting} showHelp />;
}

/** The screen for a connection: its name (the journey and Layout tests read it) and its card. */
function screenFor(connection: RuntimeConnectionValue, onBack?: () => void): { name: string; card: ReactNode } | null {
  const { state } = connection;
  switch (state.status) {
    case 'needs_permission': return { name: connection.isChecking ? 'pending' : 'permission', card: <PermissionCard connection={connection} onBack={onBack} /> };
    case 'phone': return { name: 'phone', card: <PhoneCard onBack={onBack} /> };
    case 'unsupported': return { name: 'unsupported', card: <UnsupportedCard onBack={onBack} /> };
    case 'browser_update_needed': return { name: 'browser_update_needed', card: <UnsupportedCard updateNeeded onBack={onBack} /> };
    case 'restart': return { name: 'restart', card: <Card title={COPY.restarted.title} sentence={COPY.restarted.sentence} onBack={onBack} action={<Button type="button" className="w-full" onClick={() => window.location.reload()}>{COPY.restarted.reload}</Button>} /> };
    case 'not_running': return { name: 'not_running', card: <NotRunningCard connection={connection} onBack={onBack} /> };
    case 'refused': return { name: 'refused', card: <RefusedCard connection={connection} onBack={onBack} /> };
    case 'blocked': return { name: 'blocked', card: <BlockedCard onBack={onBack} /> };
    case 'update_needed': return { name: 'update_needed', card: <UpdateNeededCard connection={connection} onBack={onBack} /> };
    default: return null;
  }
}

/**
 * The connection panel for the hosted build, one screen per thing a person can do, over the empty editor.
 * Renders nothing once connected unless it is on its way out (`exit`). Every word comes from `copy.ts`.
 */
export function RuntimeConnectionPanel({ connection, exit = null, onBack }: RuntimeConnectionPanelProps) {
  const { state } = connection;
  if (state.status === 'connected') return null;
  if (state.status === 'connecting') return <ConnectingPanel exit={exit} onBack={onBack} />;
  const screen = screenFor(connection, onBack);
  if (!screen) return null;
  return <GateLayer dataState={screen.name} exit={exit}>{screen.card}</GateLayer>;
}

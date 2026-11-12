import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import {
  getEditorTourState,
  markEditorTourReady,
  markEditorTourSent,
  useEditorTour,
} from '@/shared/state/editorTourStore.ts';
import { useEditorTourPaneLockHold } from '@/shared/state/paneLockHolds.ts';
import { EDITOR_TOUR_ANCHOR_ATTRIBUTE, EDITOR_TOUR_ANCHORS } from '@/tools/video-editor/tour/anchors.ts';
import { notifyEditorTourGesture } from '@/tools/video-editor/tour/runner/tourBeats.ts';
import { EDITOR_TOUR_SCRIPT } from '@/tools/video-editor/tour/tourScript.ts';
import { AgentChatComposer } from './AgentChatComposer';
import { AgentChatMenu } from './AgentChatMenu';
import { AgentChatModelLine } from './AgentChatModelLine';
import { AgentIcon, agentNames } from './agentIdentity';
import { AgentChatMessage, AgentChatToolGroup } from './AgentChatMessage.tsx';
import { buildRenderedTurns, type RenderedTurn } from './buildRenderedTurns';
import { buildTourTurns, tourActStartMs, type TourChatProgress } from './tourChatTurns';
import { CHAT_VOICE_ENABLED } from '@/tools/video-editor/hooks/chatVoice.ts';
import { useChatScroll } from './useChatScroll';

const IDLE_PLACEHOLDER = CHAT_VOICE_ENABLED ? 'Type or press Cmd+Shift+R to talk...' : 'Type a message...';
const COARSE_PLACEHOLDER = CHAT_VOICE_ENABLED ? 'Type, or tap the mic to talk...' : 'Type a message...';
const BUSY_PLACEHOLDER = 'Type to queue next message...';
const NO_SESSIONS: never[] = [];
const NO_OP = () => undefined;
const NO_MODEL_CHANGE = () => Promise.resolve();
const NO_PROGRESS: TourChatProgress = { typed: 0, replyChars: 0, cards: 0 };
const NO_VOICE = { isRecording: false, onToggle: () => undefined, onCancel: () => undefined, micDisabled: true };

/**
 * The animation redraws the chat at most this often. Typing and streaming change the text at 60 Hz in principle, but each
 * redraw re-renders the composer or the streaming reply (and re-parses its markdown) on a phone's slow main thread; the
 * text is derived from elapsed time, so a coarser cadence shows the same words at the same pace, in slightly bigger bites.
 */
const TYPING_REDRAW_MS = 32;
const STREAM_REDRAW_MS = 48;

const TYPING_START_MS = 250;
const THINKING_MS = 2500;
const STREAM_STEP_MS = 16;
const STREAM_CHARS_PER_STEP = 3;
const CARD_STEP_MS = 400;

function typingDelayMs(typed: number, previous: string): number {
  const pause = /[,.?!]/.test(previous) ? 45 : previous === ' ' ? 6 : 0;
  return 11 + ((typed * 37) % 7) + pause;
}

/** What a transcript row shows, so a row whose text did not change is not rendered (or its markdown parsed) again. */
function rowSignature(item: RenderedTurn): string {
  return item.kind === 'message'
    ? `${item.turn.role}|${item.turn.timestamp}|${item.turn.content}`
    : item.pairs.map(({ call, result }) => `${call.tool_call_id}|${result?.content ?? ''}`).join('\n');
}

/** Each action card after the first fades in as it joins its group (the first comes in with the group's own row). */
const CARDS_FADE_IN = '[&_[data-agent-tool-call-id]:not(:first-child)]:animate-in [&_[data-agent-tool-call-id]:not(:first-child)]:fade-in [&_[data-agent-tool-call-id]:not(:first-child)]:duration-300';

const TourTurnRow = memo(function TourTurnRow({ item, fadeIn, revealCards = false }: { item: RenderedTurn; fadeIn: boolean; revealCards?: boolean }) {
  return (
    <div className={cn(item.kind === 'message' ? 'flex flex-col gap-2.5' : 'space-y-2', fadeIn && 'animate-in fade-in duration-300', revealCards && CARDS_FADE_IN)}>
      {item.kind === 'message'
        ? <AgentChatMessage turn={item.turn} />
        : <AgentChatToolGroup pairs={item.pairs} defaultOpen />}
    </div>
  );
}, (a, b) => a.fadeIn === b.fadeIn && a.revealCards === b.revealCards && a.item.key === b.item.key && rowSignature(a.item) === rowSignature(b.item));

/** The chat's title bar never changes during the tour: its popover menu is not re-rendered with the typing. */
const TourChatHeader = memo(function TourChatHeader() {
  return (
    <div className="relative flex min-w-0 items-center justify-between gap-2 border-b border-border/70 px-3 py-1.5">
      <div className="-ml-1.5 flex min-w-0 flex-col items-start">
        <AgentChatMenu sessions={NO_SESSIONS} activeSessionId={null} onSelectSession={NO_OP} defaultAgent="astrid" onNewChat={NO_OP} />
        <AgentChatModelLine agent="astrid" hasChat={false} modelName={null} onChangeThinkingLevel={NO_MODEL_CHANGE} onChooseAnotherModel={NO_OP} />
      </div>
    </div>
  );
});

/** The scripted chat shown in place of the real one while the first-run tour runs. */
export function TourChatPanel({ isExpanded = false }: { isExpanded?: boolean }) {
  const runId = useEditorTour((state) => state.runId);
  const act = useEditorTour((state) => state.act);
  const beat = useEditorTour((state) => state.beat);
  const sent = useEditorTour((state) => state.sent);
  const chatReady = useEditorTour((state) => state.ready.chat);
  const reducedMotion = useEditorTour((state) => state.reducedMotion);
  const instant = useEditorTour((state) => state.instant);
  const skipAnimation = useEditorTour((state) => state.skipAnimation);
  const script = EDITOR_TOUR_SCRIPT.acts[act];
  const [coarsePointer] = useState(() => window.matchMedia?.('(pointer: coarse)').matches === true);

  // The chat is the Tasks pane: held locked for the tour, then given back as the user had it.
  useEditorTourPaneLockHold();

  const [clock, setClock] = useState(() => ({ runId, ms: Date.now() }));
  if (clock.runId !== runId) setClock({ runId, ms: Date.now() });
  const baseMs = clock.ms;
  const beatKey = `${runId}:${act}:${beat}`;
  const [animation, setAnimation] = useState<{ key: string } & TourChatProgress>({ key: '', ...NO_PROGRESS });
  const finished: TourChatProgress = { typed: script.prompt.length, replyChars: script.reply.length, cards: script.toolCards.length };
  const progress = instant ? finished : animation.key === beatKey ? animation : NO_PROGRESS;
  const finishRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let frame = 0;
    const update = (patch: Partial<TourChatProgress>) => setAnimation((prev) => ({
      ...(prev.key === beatKey ? prev : { key: beatKey, ...NO_PROGRESS }), ...patch,
    }));
    const finish = (patch: Partial<TourChatProgress>) => {
      window.cancelAnimationFrame(frame); update(patch); markEditorTourReady('chat');
    };
    const play = (endMs: number, redrawMs: number, progressAt: (elapsed: number) => Partial<TourChatProgress>) => {
      const startedAt = performance.now();
      let last = '';
      let drawnAt = -Infinity;
      const tick = () => {
        const elapsed = performance.now() - startedAt;
        const done = elapsed >= endMs;
        if (done || elapsed - drawnAt >= redrawMs) {
          const next = progressAt(done ? endMs : elapsed);
          const signature = `${next.typed}:${next.replyChars}:${next.cards}`;
          if (signature !== last) {
            last = signature; drawnAt = elapsed; update(next);
            // The first action card is going in, into a group that already has its final size: the highlight sets off
            // for the group now and travels while the rest appear, instead of waiting for the last one.
            if ((next.cards ?? 0) > 0) markEditorTourReady('actions');
          }
        }
        if (done) { markEditorTourReady('chat'); return; }
        frame = window.requestAnimationFrame(tick);
      };
      frame = window.requestAnimationFrame(tick);
    };
    finishRef.current = null;
    if (beat === 'compose') {
      const { prompt } = script;
      const complete = () => finish({ typed: prompt.length });
      finishRef.current = complete;
      if (reducedMotion || instant) complete();
      else {
        const offsets: number[] = [];
        let at = TYPING_START_MS;
        for (let typed = 1; typed <= prompt.length; typed += 1) {
          offsets.push(at); at += typingDelayMs(typed, prompt[typed - 1] ?? '');
        }
        play(offsets[offsets.length - 1] ?? 0, TYPING_REDRAW_MS, (elapsed) => {
          let typed = 0;
          while (typed < offsets.length && offsets[typed] <= elapsed) typed += 1;
          return { typed };
        });
      }
    } else if (beat === 'respond') {
      const { reply, toolCards } = script;
      const complete = () => { markEditorTourReady('actions'); finish({ replyChars: reply.length, cards: toolCards.length }); };
      finishRef.current = complete;
      if (reducedMotion || instant) complete();
      else {
        const streamSteps = Math.ceil(reply.length / STREAM_CHARS_PER_STEP);
        const streamEnd = THINKING_MS + Math.max(0, streamSteps - 1) * STREAM_STEP_MS;
        const cardsStart = streamEnd + CARD_STEP_MS;
        const endMs = cardsStart + Math.max(0, toolCards.length - 1) * CARD_STEP_MS;
        play(endMs, STREAM_REDRAW_MS, (elapsed) => {
          const step = elapsed < THINKING_MS ? 0 : Math.floor((elapsed - THINKING_MS) / STREAM_STEP_MS) + 1;
          const replyChars = Math.min(reply.length, step * STREAM_CHARS_PER_STEP);
          const cards = elapsed < cardsStart ? 0 : Math.min(toolCards.length, Math.floor((elapsed - cardsStart) / CARD_STEP_MS) + 1);
          return { replyChars, cards };
        });
      }
    } else markEditorTourReady('chat');
    return () => { window.cancelAnimationFrame(frame); finishRef.current = null; };
  }, [beat, beatKey, reducedMotion, instant, script]);

  const lastSkip = useRef({ runId, skipAnimation });
  useEffect(() => {
    const last = lastSkip.current;
    lastSkip.current = { runId, skipAnimation };
    if (last.runId === runId && last.skipAnimation !== skipAnimation) finishRef.current?.();
  }, [runId, skipAnimation]);

  // The transcript depends on the reply only: typing into the composer must not rebuild (and re-render) every message.
  const replyChars = beat === 'respond' ? progress.replyChars : 0;
  const cards = beat === 'respond' ? progress.cards : 0;
  // Outside the respond beat (whose exchange the highlight is waiting for) the transcript follows the tour a render
  // behind: a press then only clears the composer, and the new messages (their markdown, their layout, the scroll to
  // the end) render right after it, not inside the press where the card and the highlight are waiting to set off.
  const live = useMemo(() => ({ act, beat, sent }), [act, beat, sent]);
  const trailing = useDeferredValue(live);
  const shown = beat === 'respond' ? live : trailing;
  const turns = useMemo(
    () => buildTourTurns(EDITOR_TOUR_SCRIPT, baseMs, shown.act, shown.beat, shown.sent, { typed: 0, replyChars, cards }),
    [baseMs, shown, replyChars, cards],
  );
  const renderedTurns = useMemo(() => buildRenderedTurns(turns), [turns]);
  const currentActStart = new Date(tourActStartMs(baseMs, shown.act)).toISOString();
  const turnAt = (item: RenderedTurn) => (item.kind === 'message' ? item.turn.timestamp : item.pairs[0].call.timestamp);
  // The act's exchange: its prompt (once sent), then the reply, then its actions. Everything before is earlier acts.
  const actFrom = renderedTurns.findIndex((item) => turnAt(item) >= currentActStart);
  const earlier = actFrom < 0 ? renderedTurns : renderedTurns.slice(0, actFrom);
  const current = actFrom < 0 ? [] : renderedTurns.slice(actFrom);
  const reply = current.filter((item) => turnAt(item) > currentActStart);
  const said = current.filter((item) => item.kind === 'message');
  const { scrollContainerRef, scrollContentRef, onScroll } = useChatScroll(`tour:${runId}`, true, renderedTurns.length);

  // The act's actions (its last tool group) carry the anchor the respond beat's highlight ends on.
  const actions = reply.filter((item) => item.kind !== 'message').at(-1);
  // The same group with every card in it: what the group is sized by while its cards are still arriving.
  const allActions = useMemo(
    () => buildRenderedTurns(buildTourTurns(EDITOR_TOUR_SCRIPT, baseMs, shown.act, 'land', true, NO_PROGRESS)).filter((item) => item.kind !== 'message').at(-1),
    [baseMs, shown.act],
  );
  const renderTurn = (item: RenderedTurn) => (
    <TourTurnRow key={item.key} item={item} fadeIn={reducedMotion && turnAt(item) >= currentActStart} />
  );

  const composerText = beat === 'compose' && !sent ? script.prompt.slice(0, progress.typed) : '';
  const busy = beat === 'respond' && !chatReady;
  // These three follow the reply's own progress, never `ready.chat`: the store's flag reaches a render on its own (a
  // store change renders at once, the progress it was set with a moment later), and for that one render "ready, but the
  // last card not in yet" would drop the reserved layout, shrink the transcript and scroll it, and then put it back: the
  // actions group, and the highlight on it, jumped as the second card came in on any screen short enough to scroll.
  const thinking = beat === 'respond' && progress.replyChars === 0;
  // From the reply's first character the actions group takes its final place and size, unseen, under the reply: the
  // transcript scrolls once, the cards are then revealed into the group, and nothing moves when they do.
  // The reserved copy stays for the whole beat: there is no moment at which taking it away could change a size.
  const reserveActions = beat === 'respond' && progress.replyChars > 0 && !!allActions;
  // The reply bubble while it is still arriving.
  const streaming = beat === 'respond' && progress.replyChars > 0 && progress.replyChars < script.reply.length ? reply.find((item) => item.kind === 'message') : undefined;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden" {...{ [EDITOR_TOUR_ANCHOR_ATTRIBUTE]: EDITOR_TOUR_ANCHORS.chatPane }}>
      <TourChatHeader />
      <div ref={scrollContainerRef} onScroll={onScroll} {...{ [EDITOR_TOUR_ANCHOR_ATTRIBUTE]: EDITOR_TOUR_ANCHORS.chatTranscript }} className="flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        {renderedTurns.length === 0 && (
          <div className="flex min-h-full flex-col items-center justify-center py-8 text-center text-sm text-muted-foreground">
            <p>✨ I can do almost anything</p>
            {CHAT_VOICE_ENABLED && (coarsePointer
              ? <p className="mt-1 text-xs">Tap the mic to talk</p>
              : <p className="mt-1 text-xs">Press <kbd className="rounded border border-border px-1 py-0.5 text-[10px]">Cmd+Shift+R</kbd> to talk</p>)}
            <p className="mt-4 flex items-center gap-1.5 rounded-md border border-border/70 px-2 py-1 text-[11px] [@media(pointer:coarse)]:text-xs">
              <AgentIcon agent="astrid" className="h-3 w-3 shrink-0" />
              {agentNames.astrid} · default model
            </p>
          </div>
        )}
        <div ref={scrollContentRef} className="flex flex-col gap-2.5">
          {earlier.map(renderTurn)}
          {(said.length > 0 || thinking) && (
            // What the spotlight holds while the agent works: the prompt with the thinking line, then with the reply.
            <div className="flex flex-col gap-2.5" {...{ [EDITOR_TOUR_ANCHOR_ATTRIBUTE]: EDITOR_TOUR_ANCHORS.chatExchange }}>
              {said.map((item) => (item.kind === 'message' && item === streaming ? (
                // The reply takes its final size from its first character: the whole text is laid out unseen under the
                // part that has arrived, so the bubble (and the spotlight around it) never grows as it streams.
                <div key={item.key} className="grid">
                  <div className="invisible col-start-1 row-start-1" aria-hidden="true">
                    <TourTurnRow item={{ ...item, turn: { ...item.turn, content: script.reply } }} fadeIn={false} />
                  </div>
                  <div className="col-start-1 row-start-1">{renderTurn(item)}</div>
                </div>
              ) : renderTurn(item)))}
              {thinking && (
                <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Thinking...
                </div>
              )}
            </div>
          )}
          {current.filter((item) => item.kind !== 'message' && item !== actions).map(renderTurn)}
          {(actions || reserveActions) && (
            <div className="grid" {...{ [EDITOR_TOUR_ANCHOR_ATTRIBUTE]: EDITOR_TOUR_ANCHORS.chatActions }}>
              {reserveActions && allActions && (
                <div className="invisible col-start-1 row-start-1" aria-hidden="true">
                  <TourTurnRow item={allActions} fadeIn={false} />
                </div>
              )}
              {actions && (
                <div className="col-start-1 row-start-1 self-start">
                  <TourTurnRow item={actions} fadeIn={(beat === 'respond' && !instant) || reducedMotion} revealCards={beat === 'respond' && !instant && !reducedMotion} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-border/70 px-3 py-3">
        <AgentChatComposer value={composerText} readOnly rows={isExpanded ? 8 : 4} placeholder={busy ? BUSY_PLACEHOLDER : coarsePointer ? COARSE_PLACEHOLDER : IDLE_PLACEHOLDER} voice={CHAT_VOICE_ENABLED ? NO_VOICE : undefined} onSend={() => { if (getEditorTourState().sent) return; notifyEditorTourGesture(); markEditorTourSent(); }} sendDisabled={sent || beat !== 'compose' || progress.typed < script.prompt.length} />
      </div>
    </div>
  );
}

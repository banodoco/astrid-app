import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import {
  getEditorTourState,
  markEditorTourReady,
  markEditorTourSent,
  useEditorTour,
} from '@/shared/state/editorTourStore.ts';
import { usePanesStore } from '@/shared/state/panesStore.ts';
import { EDITOR_TOUR_ANCHOR_ATTRIBUTE, EDITOR_TOUR_ANCHORS } from '@/tools/video-editor/tour/anchors.ts';
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

const TYPING_START_MS = 250;
const THINKING_MS = 300;
const STREAM_STEP_MS = 16;
const STREAM_CHARS_PER_STEP = 6;
const CARD_STEP_MS = 220;

function typingDelayMs(typed: number, previous: string): number {
  const pause = /[,.?!]/.test(previous) ? 45 : previous === ' ' ? 6 : 0;
  return 11 + ((typed * 37) % 7) + pause;
}

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
  const setIsTasksPaneLocked = usePanesStore((state) => state.setIsTasksPaneLocked);
  const script = EDITOR_TOUR_SCRIPT.acts[act];
  const [coarsePointer] = useState(() => window.matchMedia?.('(pointer: coarse)').matches === true);

  useEffect(() => { setIsTasksPaneLocked(true); }, [setIsTasksPaneLocked]);

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
    const play = (endMs: number, progressAt: (elapsed: number) => Partial<TourChatProgress>) => {
      const startedAt = performance.now();
      let last = '';
      const tick = () => {
        const elapsed = performance.now() - startedAt;
        const next = progressAt(elapsed);
        const signature = JSON.stringify(next);
        if (signature !== last) { last = signature; update(next); }
        if (elapsed >= endMs) { markEditorTourReady('chat'); return; }
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
        play(offsets[offsets.length - 1] ?? 0, (elapsed) => {
          let typed = 0;
          while (typed < offsets.length && offsets[typed] <= elapsed) typed += 1;
          return { typed };
        });
      }
    } else if (beat === 'respond') {
      const { reply, toolCards } = script;
      const complete = () => finish({ replyChars: reply.length, cards: toolCards.length });
      finishRef.current = complete;
      if (reducedMotion || instant) complete();
      else {
        const streamSteps = Math.ceil(reply.length / STREAM_CHARS_PER_STEP);
        const streamEnd = THINKING_MS + Math.max(0, streamSteps - 1) * STREAM_STEP_MS;
        const cardsStart = streamEnd + CARD_STEP_MS;
        const endMs = cardsStart + Math.max(0, toolCards.length - 1) * CARD_STEP_MS;
        play(endMs, (elapsed) => {
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

  const turns = useMemo(() => buildTourTurns(EDITOR_TOUR_SCRIPT, baseMs, act, beat, sent, progress), [baseMs, act, beat, sent, progress]);
  const renderedTurns = useMemo(() => buildRenderedTurns(turns), [turns]);
  const currentActStart = new Date(tourActStartMs(baseMs, act)).toISOString();
  const turnAt = (item: RenderedTurn) => (item.kind === 'message' ? item.turn.timestamp : item.pairs[0].call.timestamp);
  // The act's reply and actions come after its prompt; a phone's spotlight lights them alone.
  const replyFrom = renderedTurns.findIndex((item) => turnAt(item) > currentActStart);
  const conversation = replyFrom < 0 ? renderedTurns : renderedTurns.slice(0, replyFrom);
  const reply = replyFrom < 0 ? [] : renderedTurns.slice(replyFrom);
  const { scrollContainerRef, scrollContentRef, onScroll } = useChatScroll(`tour:${runId}`, true, renderedTurns.length);

  const renderTurn = (item: RenderedTurn) => (
    <div
      key={item.key}
      className={cn(item.kind === 'message' ? 'flex flex-col gap-2.5' : 'space-y-2', reducedMotion && turnAt(item) >= currentActStart && 'animate-in fade-in duration-300')}
    >
      {item.kind === 'message'
        ? <AgentChatMessage turn={item.turn} />
        : <AgentChatToolGroup pairs={item.pairs} defaultOpen />}
    </div>
  );

  const composerText = beat === 'compose' && !sent ? script.prompt.slice(0, progress.typed) : '';
  const busy = beat === 'respond' && !chatReady;
  const thinking = busy && progress.replyChars === 0;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="relative flex min-w-0 items-center justify-between gap-2 border-b border-border/70 px-3 py-1.5">
        <div className="-ml-1.5 flex min-w-0 flex-col items-start">
          <AgentChatMenu sessions={NO_SESSIONS} activeSessionId={null} onSelectSession={NO_OP} defaultAgent="astrid" onNewChat={NO_OP} />
          <AgentChatModelLine agent="astrid" hasChat={false} modelName={null} onChangeThinkingLevel={NO_MODEL_CHANGE} onChooseAnotherModel={NO_OP} />
        </div>
      </div>
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
          {conversation.map(renderTurn)}
          {(reply.length > 0 || thinking) && (
            <div className="flex flex-col gap-2.5" {...{ [EDITOR_TOUR_ANCHOR_ATTRIBUTE]: EDITOR_TOUR_ANCHORS.chatReply }}>
              {reply.map(renderTurn)}
              {thinking && (
                <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Thinking...
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-border/70 px-3 py-3">
        <AgentChatComposer value={composerText} readOnly rows={isExpanded ? 8 : 4} placeholder={busy ? BUSY_PLACEHOLDER : coarsePointer ? COARSE_PLACEHOLDER : IDLE_PLACEHOLDER} voice={CHAT_VOICE_ENABLED ? NO_VOICE : undefined} onSend={() => { if (!getEditorTourState().sent) markEditorTourSent(); }} sendDisabled={sent || beat !== 'compose' || progress.typed < script.prompt.length} />
      </div>
    </div>
  );
}

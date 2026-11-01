import { useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from '@/shared/components/ui/command.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover.tsx';
import type { AgentThoughtLevel, LocalAgentId } from '@/integrations/astrid/localAgents.ts';
import { AgentIcon, agentNames } from './agentIdentity.tsx';
import { ThinkingLevelOptions } from './ThinkingLevelOptions.tsx';

const LINE = 'flex h-4 min-w-0 max-w-full items-center gap-1 rounded px-1.5 text-[11px] leading-4 text-muted-foreground [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:text-xs';

interface AgentChatModelLineProps {
  agent: LocalAgentId;
  /** The chat's model, fixed when it started; null until the agent reports it. */
  modelName: string | null;
  /** The thinking control the agent advertises for this chat's model. */
  thoughtLevel?: AgentThoughtLevel | null;
  /** Thinking is part of the model option for this agent, so it is fixed with the model. */
  thoughtLevelFixed?: boolean;
  /** Without an open chat (or while one starts) the line only names the agent, with nothing to change yet. */
  hasChat: boolean;
  /** Why the thinking level can't change right now, such as a reply in progress. */
  thinkingLockedReason?: string | null;
  onChangeThinkingLevel: (value: string) => Promise<unknown>;
  /** Opens New chat on this agent's models: a chat keeps its model, so another model means another chat. */
  onChooseAnotherModel: () => void;
  onOpenChange?: (open: boolean) => void;
}

/** The chat's agent and model in small type under the chat menu; it opens the thinking level and the way to another model. */
export function AgentChatModelLine({ agent, modelName, thoughtLevel = null, thoughtLevelFixed = false, hasChat, thinkingLockedReason = null, onChangeThinkingLevel, onChooseAnotherModel, onOpenChange }: AgentChatModelLineProps) {
  const [open, setOpen] = useState(false);
  const [pendingLevel, setPendingLevel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handingOff = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const levels = thoughtLevel?.options.length ? thoughtLevel : null;
  const levelName = levels && levels.currentValue !== 'default' ? levels.options.find(option => option.value === levels.currentValue)?.name : null;
  const description = [agentNames[agent], modelName, levelName].filter(Boolean).join(' · ');

  if (!hasChat) {
    return (
      <span data-testid="agent-chat-identity" className={LINE}>
        <AgentIcon agent={agent} className="h-3 w-3 shrink-0" />
        <span className="truncate">{description}</span>
      </span>
    );
  }

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) setError(null);
    onOpenChange?.(next);
  };
  const chooseLevel = async (value: string) => {
    if (value === levels?.currentValue) { changeOpen(false); return; }
    setPendingLevel(value);
    setError(null);
    try {
      await onChangeThinkingLevel(value);
      changeOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingLevel(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-testid="agent-chat-identity" aria-label={`${description}: model and thinking level`} title="Model and thinking level"
          className={`${LINE} transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent aria-expanded:text-foreground`}>
          <AgentIcon agent={agent} className="h-3 w-3 shrink-0" />
          <span className="truncate">{description}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Model and thinking level" className="w-64 max-w-[calc(100vw-2rem)] p-0"
        initialFocus={list} finalFocus={() => !handingOff.current}>
        <div className="border-b border-border px-3 py-2">
          <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
            <AgentIcon agent={agent} className="h-3.5 w-3.5 shrink-0 text-foreground/80" />
            <span className="truncate">{[agentNames[agent], modelName].filter(Boolean).join(' · ')}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">A chat keeps its model.</p>
        </div>
        <Command ref={list} loop shouldFilter={false} defaultValue={levels && !thoughtLevelFixed ? levels.currentValue : 'another-model'} className="outline-none"
          onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); changeOpen(false); } }}>
          <CommandList className="max-h-96">
            {levels && !thoughtLevelFixed && (
              <ThinkingLevelOptions levels={levels} value={levels.currentValue} pendingValue={pendingLevel} disabled={Boolean(thinkingLockedReason) || pendingLevel !== null}
                onSelect={value => void chooseLevel(value)} />
            )}
            {levels && thoughtLevelFixed && levelName && (
              <p className="px-3 pt-2 text-[11px] text-muted-foreground">Thinking: {levelName}, fixed with the model.</p>
            )}
            {levels && !thoughtLevelFixed && thinkingLockedReason && <p className="px-3 pb-2 text-[11px] text-muted-foreground">{thinkingLockedReason}</p>}
            {error && <p role="alert" className="px-3 pb-2 text-[11px] text-destructive">Could not change the thinking level: {error}</p>}
            {levels && <CommandSeparator />}
            <CommandGroup>
              <CommandItem value="another-model" className="gap-2 text-xs [@media(pointer:coarse)]:min-h-[44px]"
                onSelect={() => {
                  handingOff.current = true;
                  changeOpen(false);
                  // After this popover lets go of focus, so the chat menu keeps it.
                  requestAnimationFrame(() => { handingOff.current = false; onChooseAnotherModel(); });
                }}>
                <span>New chat with another model</span>
                <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

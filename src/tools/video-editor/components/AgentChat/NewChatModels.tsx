import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Check, ChevronDown, ChevronLeft, Copy, Loader2 } from 'lucide-react';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList, CommandSeparator } from '@/shared/components/ui/command.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover.tsx';
import { cn } from '@/shared/components/ui/contracts/cn';
import { defaultThoughtLevel, PERSONAL_AGENT_DIRECTORIES, type AgentThoughtLevel, type LocalAgentId } from '@/integrations/astrid/localAgents.ts';
import { AGENT_CHAT_COPY } from '@/integrations/astrid/chatCopy.ts';
import { AgentIcon, agentNames } from './agentIdentity.tsx';
import { ThinkingLevelOptions } from './ThinkingLevelOptions.tsx';
import { CopyFallback, useCopyAction } from '@/shared/components/RuntimeConnection/CopyInstallCommand.tsx';
import { AstridOpenRouterKeyForm } from './AstridOpenRouterKeyForm.tsx';

/** A submenu lists this many models; its search reaches the rest. */
const SUBMENU_LIMIT = 50;

export interface NewChatModelChoice { id: string; name: string; detail?: string | null; thoughtLevel?: AgentThoughtLevel | null }

/** One agent's models for the submenu, supplied by the host as it fetches them. */
export interface NewChatAgentModels {
  agent: LocalAgentId;
  models: NewChatModelChoice[];
  /** The model selected initially when the submenu opens. */
  defaultModel?: string | null;
  loading: boolean;
  /** Shown when there is no list to offer, such as before the agent's first chat. */
  note?: string | null;
}

function SubagentHint({ agent }: { agent: LocalAgentId }) {
  const directory = PERSONAL_AGENT_DIRECTORIES[agent];
  const copy = useCopyAction(directory ?? '');
  if (!directory) return null;
  const name = agentNames[agent];
  return <div className="flex items-start gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground">
    <p className="min-w-0 flex-1">Subagents: add personal agents in <code className="select-all font-mono">{directory}</code>, or ask {name} to make one.</p>
    <button type="button" aria-label={copy.status === 'copied' ? 'Subagent folder copied' : `Copy ${directory}`} title="Copy personal subagent folder"
      className="-my-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={event => { event.stopPropagation(); void copy.copy(); }}>
      {copy.status === 'copied' ? <Check className="h-3 w-3" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
    </button>
    {copy.status === 'failed' && <CopyFallback text={directory} label="Personal subagent folder" />}
  </div>;
}

function ThinkingLevelSelector({ model, levels, value, open, onOpenChange, onSelect, returnFocus, compact }: {
  model: string;
  levels: AgentThoughtLevel;
  value: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (value: string) => void;
  returnFocus: RefObject<HTMLInputElement>;
  compact: boolean;
}) {
  const list = useRef<HTMLDivElement>(null);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`Choose a thinking level for ${model}`} title="Choose a thinking level (→ or Space)"
          className={cn(compact ? 'inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded px-1' : 'ml-auto inline-flex h-6 shrink-0 self-start items-center justify-center gap-1 rounded px-1.5', 'text-[11px] text-muted-foreground hover:bg-background/40 hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-[44px]')}
          onPointerDown={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}>
          <span>{compact ? '· ' : ''}{levels.options.find(option => option.value === value)?.name}</span>
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" aria-label={`Thinking level for ${model}`} className="w-64 max-w-[calc(100vw-2rem)] p-0" initialFocus={list} finalFocus={returnFocus}
        onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <Command ref={list} aria-label={`Thinking level for ${model}`} loop defaultValue={value} shouldFilter={false} className="outline-none"
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); onOpenChange(false); }
          }}>
          <CommandList>
            <ThinkingLevelOptions levels={levels} value={value} onSelect={level => { onSelect(level); onOpenChange(false); }} />
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The model list a New chat drills into: each model with its thinking level, and the agent's default when there is no list. */
export function NewChatModels({ agent, submenu, models, levelSelections, openLevelSelector, onLevelSelectorOpenChange, onRememberLevel, onBack, onPick, onStartNow, astridKeyConfigured, onAstridKeySaved, selectedModel, compactSelector = false, showStartButtons = false, returnFocus, footer }: {
  agent: LocalAgentId;
  submenu: NewChatAgentModels | null;
  /** The models matching the search. */
  models: NewChatModelChoice[];
  /** Remembered thinking level per model for this agent. */
  levelSelections: Record<string, string>;
  openLevelSelector: string | null;
  /** A model's thinking-level popover opens or closes; the model stays highlighted either way. */
  onLevelSelectorOpenChange: (modelId: string, open: boolean) => void;
  onRememberLevel: (modelId: string, value: string) => void;
  onBack: () => void;
  /** A model (and level) is chosen for the next chat; nothing starts. */
  onPick: (model?: string, level?: string) => void;
  /** A model's own New chat button: choose it and start a chat at once. */
  onStartNow: (model: string, level: string | undefined, modelName: string) => void;
  astridKeyConfigured?: boolean;
  onAstridKeySaved?: () => Promise<unknown> | unknown;
  /** The model the next chat will use, ticked in the list; the agent's default when none. */
  selectedModel?: string;
  /** NewChatMenu keeps the thinking control compact on the model name line. */
  compactSelector?: boolean;
  /** NewChatMenu exposes a per-model action; AgentChatMenu starts from row selection. */
  showStartButtons?: boolean;
  returnFocus: RefObject<HTMLInputElement>;
  footer?: ReactNode;
}) {
  const needsAstridKey = agent === 'astrid' && astridKeyConfigured === false;
  const [showKeyForm, setShowKeyForm] = useState(needsAstridKey);
  useEffect(() => { setShowKeyForm(needsAstridKey); }, [agent, needsAstridKey]);
  return (
    <>
      <CommandGroup>
        <CommandItem value="back" className="gap-2 text-xs text-muted-foreground" onSelect={onBack}>
          <ChevronLeft className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <AgentIcon agent={agent} className="h-3.5 w-3.5 shrink-0" />
          <span>{agentNames[agent]}</span>
        </CommandItem>
      </CommandGroup>
      <CommandSeparator />
      <CommandGroup heading="Use for new chats">
        {(!submenu || submenu.loading) && models.length === 0 && !needsAstridKey && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading models...</div>
        )}
        {models.slice(0, SUBMENU_LIMIT).map(model => {
          const isDefault = model.id === submenu?.defaultModel;
          const ticked = selectedModel ? model.id === selectedModel : isDefault;
          const levels = model.thoughtLevel?.options.length ? model.thoughtLevel : null;
          const remembered = levelSelections[model.id];
          const level = levels ? levels.options.find(option => option.value === remembered)?.value ?? defaultThoughtLevel(levels) : undefined;
          const levelName = levels?.options.find(option => option.value === level)?.name;
          return (
            <CommandItem key={model.id} value={`model:${model.id}`} aria-current={isDefault ? 'true' : undefined} className="items-center gap-2" onSelect={() => onPick(model.id, level)}>
              <Check className={cn('h-3.5 w-3.5 shrink-0', ticked ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate">{model.name}</span>
                  {levels && level !== undefined && (
                    <ThinkingLevelSelector model={model.name} levels={levels} value={level} open={openLevelSelector === model.id} returnFocus={returnFocus}
                      compact={compactSelector}
                      onOpenChange={next => onLevelSelectorOpenChange(model.id, next)}
                      onSelect={value => onRememberLevel(model.id, value)} />
                  )}
                </span>
                {model.detail && <span className="text-[11px] text-muted-foreground">{model.detail}</span>}
              </span>
              {showStartButtons && <button type="button" tabIndex={-1} aria-label={`New chat with ${model.name}${levelName ? ` · ${levelName}` : ''}`} title="Start a new chat with this model"
                className="ml-auto inline-flex h-6 shrink-0 self-start items-center rounded px-1.5 text-[11px] text-muted-foreground hover:bg-background/40 hover:text-foreground [[data-selected=true]>&]:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-8 [@media(pointer:coarse)]:min-w-8 [@media(pointer:coarse)]:justify-center"
                onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }}
                onKeyDown={event => event.stopPropagation()}
                onClick={event => { event.preventDefault(); event.stopPropagation(); onStartNow(model.id, level, model.name); }}>
                New chat
              </button>}
            </CommandItem>
          );
        })}
        {models.length > SUBMENU_LIMIT && (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">Showing {SUBMENU_LIMIT} of {models.length}. Keep typing to narrow.</p>
        )}
        {submenu && !submenu.loading && submenu.models.length === 0 && !needsAstridKey && (
          <>
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground">{submenu.note ?? AGENT_CHAT_COPY.noModels}</p>
            <CommandItem value="agent-default" className="text-xs" onSelect={() => onPick()}>
              <span>{AGENT_CHAT_COPY.useAgentDefault}</span>
            </CommandItem>
          </>
        )}
        {agent === 'astrid' && !needsAstridKey && (
          <CommandItem value="astrid-openrouter-key" aria-expanded={showKeyForm} className="text-xs text-muted-foreground" onSelect={() => setShowKeyForm(value => !value)}>
            <span>OpenRouter key</span>
          </CommandItem>
        )}
        {footer}
      </CommandGroup>
      {showKeyForm && agent === 'astrid' && (
        <div className="px-2 py-1.5">
          <AstridOpenRouterKeyForm compact keySaved={!needsAstridKey} onSaved={async () => {
            await onAstridKeySaved?.();
            setShowKeyForm(false);
          }} />
        </div>
      )}
      <SubagentHint key={agent} agent={agent} />
      {submenu && submenu.models.length > 0 && <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">No models match.</CommandEmpty>}
    </>
  );
}

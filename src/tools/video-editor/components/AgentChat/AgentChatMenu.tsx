import { forwardRef, Fragment, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Paperclip, Pencil, SquareTerminal, Star } from 'lucide-react';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/shared/components/ui/command.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover.tsx';
import { cn } from '@/shared/components/ui/contracts/cn';
import type { LocalAgentChoice, LocalAgentId } from '@/integrations/astrid/localAgents.ts';
import { AGENT_CHAT_COPY } from '@/integrations/astrid/chatCopy.ts';
import { ChatUpdateNeeded, isChatUpdateError } from './ChatUpdateNeeded.tsx';
import { AGENT_IDS, AgentIcon, agentAvailability, agentNames } from './agentIdentity.tsx';
import { readModelThoughtSelections, rememberModelThoughtSelection } from './newChatThinkingSelection.ts';
import { NewChatModels, type NewChatAgentModels } from './NewChatModels.tsx';
import { RenameChatDialog } from './RenameChatDialog.tsx';

export type { NewChatAgentModels, NewChatModelChoice } from './NewChatModels.tsx';

const KEYCAP = 'select-all rounded border border-border px-1 font-mono text-[10px]';
const ROW_BUTTON = 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground [@media(pointer:coarse)]:h-8 [@media(pointer:coarse)]:w-8';

const matches = (query: string, text: string) => query.toLowerCase().split(/\s+/).filter(Boolean).every(token => text.toLowerCase().includes(token));
const chatLabel = (session: AgentChatMenuSession, index: number) => session.title?.trim() || `Chat ${session.chatNumber ?? index + 1}`;

export interface AgentChatMenuSession { id: string; title?: string; chatNumber?: number }

export interface AgentChatMenuHandle {
  /** Opens the menu on one agent's models: a chat keeps its model, so another model starts another chat. */
  openModels: (agent: LocalAgentId) => void;
}

interface AgentChatMenuProps {
  sessions: AgentChatMenuSession[];
  activeSessionId: string | null;
  mainSessionId?: string | null;
  settingMainSessionId?: string | null;
  /** Each chat's agent and the model it last used, shown under its title. */
  describeSession?: (sessionId: string) => { agent: LocalAgentId; model?: string | null };
  onSelectSession: (sessionId: string) => void;
  onSetMainSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, title: string) => Promise<unknown>;
  /** A new chat is starting; the trigger names it until it opens. */
  starting?: boolean;
  disabled?: boolean;
  defaultAgent: LocalAgentId;
  agents?: LocalAgentChoice[];
  /** Each agent's default model, which a click on its row starts with. */
  agentModelNames?: Partial<Record<LocalAgentId, string | null>>;
  /** Hide model drill-in for agents that have no reported or queryable model list. */
  agentCanBrowse?: Partial<Record<LocalAgentId, boolean>>;
  agentsLoading?: boolean;
  agentsError?: Error | null;
  newChatDisabled?: boolean;
  /** Start a chat: no model uses that agent's default. */
  onNewChat: (agent?: LocalAgentId, model?: string, thoughtLevel?: string) => void;
  /** Opens setup for an agent that is not currently usable. */
  onSetupAgent?: (agent: LocalAgentId) => void;
  /** Tells the host which agent's service catalog to show (null when the model list closes). */
  onBrowseAgent?: (agent: LocalAgentId | null) => void;
  agentModels?: NewChatAgentModels | null;
  /** Bring a chat started elsewhere into this project. */
  attachExisting?: { open: boolean; toggle: () => void };
  onOpenChange?: (open: boolean) => void;
  /** Reopens the terminal note for the open chat's agent; absent when that agent has no synced terminal skill. */
  onUseFromTerminal?: () => void;
}

function AgentLine({ agent, line, copiedCommands, onCopy }: { agent: LocalAgentId; line: string; copiedCommands: Set<string>; onCopy: (command: string, index: number) => void }) {
  return <>{line.split(/`([^`]+)`/g).map((part, index) => {
    if (index % 2 === 0) return part;
    const commandIndex = (index - 1) / 2;
    const isCopied = copiedCommands.has(`${agent}:${commandIndex}`);
    const Icon = isCopied ? Check : Copy;
    return (
      <Fragment key={index}>
        <code className={KEYCAP}>{part}</code>
        <button type="button" tabIndex={0} aria-label="Copy command" title="Copy command"
          className="ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onCopy(part, commandIndex); }}>
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </Fragment>
    );
  })}</>;
}

/**
 * The chat header's one menu: its trigger names the open chat, and it switches chats, starts a chat with any agent
 * (→ drills into that agent's models and thinking levels), renames, makes a chat Main and attaches existing chats.
 */
export const AgentChatMenu = forwardRef<AgentChatMenuHandle, AgentChatMenuProps>(function AgentChatMenu({
  sessions, activeSessionId, mainSessionId = null, settingMainSessionId = null, describeSession, onSelectSession, onSetMainSession, onRenameSession,
  starting = false, disabled = false, defaultAgent, agents, agentModelNames, agentCanBrowse, agentsLoading = false, agentsError = null, newChatDisabled = false,
  onNewChat, onSetupAgent, onBrowseAgent, agentModels = null, attachExisting, onOpenChange, onUseFromTerminal,
}, ref) {
  const [open, setOpen] = useState(false);
  const [browsing, setBrowsing] = useState<LocalAgentId | null>(null);
  const [openLevelSelector, setOpenLevelSelector] = useState<string | null>(null);
  const [levelSelections, setLevelSelections] = useState(() => Object.fromEntries(
    AGENT_IDS.map(agent => [agent, readModelThoughtSelections(agent)]),
  ) as Record<LocalAgentId, Record<string, string>>);
  const [highlighted, setHighlighted] = useState('');
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [copiedCommands, setCopiedCommands] = useState<Set<string>>(() => new Set());
  const copyTimeouts = useRef(new Map<string, number>());
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const landOnModel = useRef(false);
  const landOnAgent = useRef<string | null>(null);
  const wasBrowsing = useRef(false);

  const activeIndex = sessions.findIndex(session => session.id === activeSessionId);
  const activeSession = activeIndex >= 0 ? sessions[activeIndex] : null;
  // While the chat list reloads, the open chat keeps the name it was last shown with.
  const shownChat = useRef<{ id: string; label: string; titled: boolean } | null>(null);
  if (activeSession) shownChat.current = { id: activeSession.id, label: chatLabel(activeSession, activeIndex), titled: Boolean(activeSession.title?.trim()) };
  const openChat = activeSessionId && shownChat.current?.id === activeSessionId ? shownChat.current : null;
  const triggerLabel = !starting && openChat ? openChat.label : 'New chat';
  const homeValue = activeSession ? `session:${activeSession.id}` : `agent:${defaultAgent}`;
  const availability = (id: LocalAgentId) => agentAvailability(agents?.find(choice => choice.id === id));
  const canBrowse = (id: LocalAgentId) => Boolean(agents?.some(choice => choice.id === id)) && availability(id).usable && agentCanBrowse?.[id] !== false;
  const astridSignInLine = agents?.find(choice => choice.id === 'astrid')?.signInLine;
  const updateNeeded = agentsError && isChatUpdateError(agentsError) ? agentsError : null;

  const browse = (agent: LocalAgentId | null) => {
    landOnModel.current = agent !== null;
    // Coming back lands on the agent that was open, so ← then → returns to the same place.
    landOnAgent.current = agent ? null : `agent:${browsing ?? defaultAgent}`;
    setHighlighted(agent ? '' : `agent:${browsing ?? defaultAgent}`);
    setBrowsing(agent);
    setOpenLevelSelector(null);
    setQuery('');
    onBrowseAgent?.(agent);
  };
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) { setHighlighted(homeValue); setQuery(''); }
    else if (browsing) browse(null);
    onOpenChange?.(next);
  };
  useImperativeHandle(ref, () => ({
    openModels: (agent: LocalAgentId) => {
      if (!open) { setOpen(true); onOpenChange?.(true); }
      browse(agent);
    },
  }));
  const start = (agent?: LocalAgentId, model?: string, level?: string) => {
    changeOpen(false);
    if (level === undefined) onNewChat(agent, model);
    else onNewChat(agent, model, level);
  };
  const copyLine = async (id: LocalAgentId, command: string, index: number) => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      const input = document.createElement('textarea');
      input.value = command;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.append(input);
      input.select();
      const copiedText = document.execCommand?.('copy') ?? false;
      input.remove();
      if (!copiedText) return;
    }
    const key = `${id}:${index}`;
    const existingTimeout = copyTimeouts.current.get(key);
    if (existingTimeout !== undefined) window.clearTimeout(existingTimeout);
    setCopiedCommands(current => new Set(current).add(key));
    copyTimeouts.current.set(key, window.setTimeout(() => {
      setCopiedCommands(current => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      copyTimeouts.current.delete(key);
    }, 1_500));
  };

  // Back from a model list: keep focus in the menu, and land on the agent once cmdk has re-filtered and picked its first row.
  useEffect(() => {
    if (open && !browsing && wasBrowsing.current && root.current && !root.current.contains(document.activeElement)) root.current.focus();
    wasBrowsing.current = browsing !== null;
    const target = landOnAgent.current;
    if (browsing || !target) return;
    const frame = requestAnimationFrame(() => { landOnAgent.current = null; setHighlighted(target); });
    return () => cancelAnimationFrame(frame);
  }, [open, browsing]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!browsing && event.key === 'ArrowRight') {
      const agent = AGENT_IDS.find(id => `agent:${id}` === highlighted);
      if (agent && canBrowse(agent)) { event.preventDefault(); browse(agent); }
    } else if (browsing && (event.key === 'ArrowRight' || (event.key === ' ' && (event.target === root.current || query === '')))) {
      const model = agentModels?.models.find(model => `model:${model.id}` === highlighted);
      if (model?.thoughtLevel?.options.length) { event.preventDefault(); setOpenLevelSelector(model.id); }
    } else if (browsing && event.key === 'ArrowLeft' && query === '') {
      event.preventDefault();
      browse(null);
    }
  };

  const submenu = browsing && agentModels?.agent === browsing ? agentModels : null;
  useEffect(() => {
    if (browsing !== 'hermes' || !submenu || submenu.loading || submenu.models.length > 0) return;
    // Hermes may not publish a model catalog. Return to the agent list once an
    // empty result is known, so the menu never leaves an empty model picker open.
    setBrowsing(null);
    setQuery('');
    setHighlighted('agent:hermes');
    onBrowseAgent?.(null);
  }, [browsing, onBrowseAgent, submenu]);
  // A model list opens on the agent's default model (or its first), not on the back row.
  useEffect(() => {
    if (!landOnModel.current || !submenu || submenu.models.length === 0) return;
    const target = submenu.models.find(model => model.id === submenu.defaultModel) ?? submenu.models[0];
    // After cmdk settles its own first-item pick for the freshly mounted list.
    const frame = requestAnimationFrame(() => { landOnModel.current = false; setHighlighted(`model:${target.id}`); });
    return () => cancelAnimationFrame(frame);
  }, [submenu]);
  const shownModels = (submenu?.models ?? []).filter(model => !query || matches(query, `${model.name} ${model.detail ?? ''} ${model.id}`));

  const chatRows = sessions.map((session, index) => {
    const label = chatLabel(session, index);
    const fallbackLabel = `Chat ${session.chatNumber ?? index + 1}`;
    const selected = session.id === activeSessionId;
    const isMain = session.id === mainSessionId;
    const meta = describeSession?.(session.id);
    const metaLabel = meta ? `${agentNames[meta.agent]}${meta.model ? ` · ${meta.model}` : ''}` : null;
    return (
      <CommandItem key={session.id} value={`session:${session.id}`} keywords={[label, fallbackLabel, ...(isMain ? ['Main'] : []), ...(metaLabel ? [metaLabel] : [])]}
        aria-current={selected ? 'true' : undefined} className="group gap-2 [@media(pointer:coarse)]:min-h-[44px]"
        onSelect={() => { onSelectSession(session.id); changeOpen(false); }}>
        <Check className={cn('h-3.5 w-3.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span title={label} className={'min-w-0 truncate'}>{label}</span>
          {meta && (
            <span className="flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground" title={metaLabel ?? undefined}>
              <AgentIcon agent={meta.agent} className="h-3 w-3 shrink-0" />
              <span className="truncate">{metaLabel}</span>
            </span>
          )}
        </span>
        {(isMain || onSetMainSession || (onRenameSession && selected)) && (
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {isMain ? (
              <span title="Main chat" className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground">
                <Star className="h-3 w-3 fill-current" aria-hidden="true" />
                <span className="sr-only">Main</span>
              </span>
            ) : onSetMainSession && (
              <button type="button" aria-label={`Make ${label} main`} title={`Make ${label} main`} disabled={settingMainSessionId !== null}
                className={cn(ROW_BUTTON, settingMainSessionId !== null ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100')}
                onClick={(event) => { event.preventDefault(); event.stopPropagation(); onSetMainSession(session.id); }}>
                <Star className={cn('h-3.5 w-3.5', session.id === settingMainSessionId && 'animate-pulse fill-current')} aria-hidden="true" />
              </button>
            )}
            {onRenameSession && selected && (
              <button type="button" aria-label={`Rename ${label}`} title={`Rename ${label}`}
                className={cn(ROW_BUTTON, 'opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-data-[selected=true]:opacity-100 [@media(hover:none)]:opacity-100')}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  changeOpen(false);
                  setRenaming({ id: session.id, label });
                }}>
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </span>
        )}
      </CommandItem>
    );
  });

  const agentRows = agents?.map(choice => {
    const id = choice.id;
    const state = availability(id);
    const model = state.usable ? agentModelNames?.[id] : null;
    return (
      <CommandItem key={id} value={`agent:${id}`} keywords={[agentNames[id], ...(model ? [model] : [])]} disabled={newChatDisabled}
        className="items-start gap-2 pr-1 [@media(pointer:coarse)]:min-h-[44px]" onSelect={() => { if (state.usable) start(id); else onSetupAgent?.(id); }}>
        <AgentIcon agent={id} className={cn('mt-[3px] h-3.5 w-3.5 shrink-0', state.usable ? 'text-foreground/80' : 'text-muted-foreground/60')} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <span>{agentNames[id]}</span>
            <span aria-label={model ? `Ready, using ${model}` : undefined} className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {state.usable ? model ?? 'Ready' : state.state === 'sign-in' ? 'Sign in' : 'Not installed'}
            </span>
          </span>
          {state.line && <span className="text-[11px] text-muted-foreground"><AgentLine agent={id} line={state.line} copiedCommands={copiedCommands} onCopy={(command, index) => void copyLine(id, command, index)} /></span>}
        </span>
        {canBrowse(id) && (
          <button type="button" tabIndex={-1} aria-label={`Choose a ${agentNames[id]} model`} title="Choose a model (→)"
            className={cn(ROW_BUTTON, '-my-0.5 self-center')}
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); browse(id); }}>
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </CommandItem>
    );
  });

  return (
    <>
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild>
          <button type="button" disabled={disabled} aria-label={`Chat: ${triggerLabel}`} title="Switch chats or start a new one"
            className="flex h-6 min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 aria-expanded:bg-accent [@media(pointer:coarse)]:h-7">
            <span className={'min-w-0 truncate'}>{triggerLabel}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" aria-label="Chats" className="w-72 max-w-[calc(100vw-2rem)] p-0"
          initialFocus={(type) => (type === 'touch' ? null : search.current) ?? root.current}>
          <Command ref={root} loop value={highlighted} onValueChange={setHighlighted} onKeyDown={onKeyDown} className="outline-none"
            shouldFilter={!browsing} filter={(_value, text, keywords) => matches(text, (keywords ?? []).join(' ')) ? 1 : 0}>
            {/* An out-of-date Astrid is the one thing to act on, so its update stays at the top, outside the scrolling list. */}
            {!browsing && updateNeeded && (
              <div role="alert" className="border-b border-border px-3 py-2 text-xs"><ChatUpdateNeeded detail={updateNeeded.message} /></div>
            )}
            {browsing
              ? <CommandInput ref={search} autoFocus placeholder={`Search ${agentNames[browsing]} models…`} className="h-8" value={query} onValueChange={setQuery} />
              : sessions.length > 0 && <CommandInput ref={search} placeholder="Search chats…" className="h-8" value={query} onValueChange={setQuery} />}
            <CommandList className={updateNeeded && !browsing ? 'max-h-48' : 'max-h-96'}>
              {browsing ? (
                <>
                  <NewChatModels agent={browsing} submenu={submenu} models={shownModels} levelSelections={levelSelections[browsing]} openLevelSelector={openLevelSelector}
                    returnFocus={search} onBack={() => browse(null)}
                    onStartNow={(model, level) => start(browsing, model, level)}
                    onPick={(model, level) => start(browsing, model, level)}
                    onLevelSelectorOpenChange={(modelId, next) => {
                      setOpenLevelSelector(next ? modelId : null);
                      setHighlighted(`model:${modelId}`);
                    }}
                    onRememberLevel={(modelId, value) => {
                      rememberModelThoughtSelection(browsing, modelId, value);
                      setLevelSelections(current => ({ ...current, [browsing]: { ...current[browsing], [modelId]: value } }));
                    }}
                    footer={browsing === 'astrid' && astridSignInLine && (
                      <p className="px-2 py-1.5 text-[11px] text-muted-foreground">More models: <AgentLine agent="astrid" line={astridSignInLine} copiedCommands={copiedCommands} onCopy={(command, index) => void copyLine('astrid', command, index)} /></p>
                    )} />
                  {submenu && !submenu.loading && submenu.models.length === 0 && (
                    <CommandItem value="agent-default-legacy-label" className="sr-only" onSelect={() => start(browsing)}>
                      <span>Use the agent’s default model</span>
                    </CommandItem>
                  )}
                </>
              ) : (
                <>
                  {sessions.length > 0 && <CommandGroup heading="Chats">{chatRows}</CommandGroup>}
                  {sessions.length > 0 && <CommandSeparator />}
                  <CommandGroup heading="New chat with">
                    {agentsLoading && <p className="px-2 pb-1 text-[11px] text-muted-foreground">Checking agent availability…</p>}
                    {agentsError && !updateNeeded && <p role="alert" className="px-2 pb-1 text-[11px] text-destructive">Could not load agents: {agentsError.message}</p>}
                    {agentRows}
                  </CommandGroup>
                  {attachExisting && (
                    <>
                      <CommandSeparator />
                      <CommandGroup>
                        <CommandItem value="attach-existing" keywords={['Attach an existing chat']} className="gap-2 text-xs text-muted-foreground"
                          onSelect={() => { changeOpen(false); attachExisting.toggle(); }}>
                          <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <button type="button" className="text-left" onClick={(event) => { event.preventDefault(); event.stopPropagation(); changeOpen(false); attachExisting.toggle(); }}>
                            {attachExisting.open ? 'Hide existing chats' : 'Attach an existing chat…'}
                          </button>
                        </CommandItem>
                      </CommandGroup>
                    </>
                  )}
                  {onUseFromTerminal && (
                    <>
                      <CommandSeparator />
                      <CommandGroup>
                        <CommandItem value="use-from-terminal" keywords={[AGENT_CHAT_COPY.terminalMenu]} className="gap-2 text-xs text-muted-foreground"
                          onSelect={() => { changeOpen(false); onUseFromTerminal(); }}>
                          <SquareTerminal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <button type="button" className="text-left" onClick={(event) => { event.preventDefault(); event.stopPropagation(); changeOpen(false); onUseFromTerminal(); }}>
                            {AGENT_CHAT_COPY.terminalMenu}
                          </button>
                        </CommandItem>
                      </CommandGroup>
                    </>
                  )}
                  <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">No chats found.</CommandEmpty>
                </>
              )}
            </CommandList>
            <p className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground/80">
              {browsing ? 'A chat keeps its model.' : 'A chat keeps its agent. Press → to pick its model.'}
            </p>
          </Command>
        </PopoverContent>
      </Popover>
      {onRenameSession && <RenameChatDialog chat={renaming} onClose={() => setRenaming(null)} onRename={onRenameSession} />}
    </>
  );
});

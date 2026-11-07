import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { requireContextValue } from '@/shared/contexts/contextGuard';
import { useToolSettings } from '@/shared/hooks/settings/useToolSettings';
import { videoEditorSettings } from '@/tools/video-editor/settings/videoEditorDefaults';
import type { AstridAgentElementContext } from '@/tools/video-editor/runtime/element-contract.ts';
import type { AstridElementOperationAdapter } from '@/tools/video-editor/runtime/element-adapter.ts';

export type AgentChatEditorContext = {
  tool: 'video-editor';
  projectId: string | null;
  projectSlug: string | null;
  /** The open project's name, for chat display only; requests never carry it. */
  projectName?: string | null;
  timelineId: string | null;
  timelineName: string | null;
  deepLink?: string | null;
  /** Compact, host-owned timeline facts for agent scope display and prompts. */
  timelineSummary?: {
    configVersion: number;
    trackCount: number;
    clipCount: number;
    assetCount: number;
    duration: number;
  };
  /** Compact, serializable Elements catalog and selected-cut context. */
  elementContext?: AstridAgentElementContext;
  /** Host-side execution boundary; deliberately omitted from serialized prompt context. */
  elementOperationAdapter?: AstridElementOperationAdapter;
  liveSceneOperationPort?: import('@/tools/video-editor/runtime/liveSceneOperationPort').LiveSceneOperationPort;
};

export type AgentChatContextValue = {
  timelineId: string | null;
  editorContext: AgentChatEditorContext | null;
  /** Queue an intent for the mounted chat composer, even when its pane is closed. */
  requestComposerPrompt?: (prompt: string) => void;
  pendingComposerPrompt?: string | null;
  clearPendingComposerPrompt?: () => void;
};

export type AgentChatRegistryOwner = string | symbol;

export type AgentChatRegistryValue = {
  /** Updates from a background owner preserve the active editor; the first owner activates itself. */
  register: (value: AgentChatContextValue, owner: AgentChatRegistryOwner) => () => void;
  unregister: (owner: AgentChatRegistryOwner) => void;
  activate: (owner: AgentChatRegistryOwner) => void;
  /** Route-selected project scope exists before a timeline editor mounts. */
  registerProject: (value: AgentChatContextValue) => void;
  unregisterProject: () => void;
};

// AgentChatPanel-side handlers that live as long as the panel is mounted.
// `markEngaged` is the v5 engagement-flag pivot: clicking the message composer button
// calls this so the auto-create-session gate can fire without writing to
// `panesStore.isTasksPaneOpen` (which would short-circuit useSlidingPane.setOpen(false)).
export type AgentChatActionsHandlers = {
  /** Chat voice: starts or stops a recording. A no-op while chat voice is switched off. */
  toggleRecording: () => void;
  focusComposer: () => void;
  markEngaged: () => void;
};

export type AgentChatActionsValue = AgentChatActionsHandlers & {
  isRecording: boolean;
  isProcessing: boolean;
  /** An agent turn is running (sent, answering, or queued behind one): the chat's "Thinking...". */
  isAgentWorking: boolean;
};

type AgentChatActionsState = Pick<AgentChatActionsValue, 'isRecording' | 'isProcessing' | 'isAgentWorking'>;

export type AgentChatActionsRegistry = {
  registerHandlers: (handlers: AgentChatActionsHandlers) => void;
  publishState: (state: AgentChatActionsState) => void;
  unregister: () => void;
};

const AgentChatContext = createContext<AgentChatContextValue | null>(null);
const AgentChatRegistryContext = createContext<AgentChatRegistryValue | null>(null);
const AgentChatActionsContext = createContext<AgentChatActionsValue | null>(null);
const AgentChatActionsRegistryContext = createContext<AgentChatActionsRegistry | null>(null);

/**
 * Single app-level provider. Holds a default (settings-based) value that can be
 * extended by route-selected project scope, then overridden by an active editor owner.
 */
export function AgentChatProvider({ children }: { children: ReactNode }) {
  const { settings: videoSettings } = useToolSettings(videoEditorSettings.id);
  const [projectScope, setProjectScope] = useState<AgentChatContextValue | null>(null);
  const [override, setOverride] = useState<AgentChatContextValue | null>(null);
  const [pendingComposerPrompt, setPendingComposerPrompt] = useState<string | null>(null);

  const requestComposerPrompt = useCallback((prompt: string) => {
    setPendingComposerPrompt(prompt);
  }, []);
  const clearPendingComposerPrompt = useCallback(() => {
    setPendingComposerPrompt(null);
  }, []);

  const defaultValue = useMemo<AgentChatContextValue>(() => ({
    timelineId: videoSettings?.lastTimelineId ?? null,
    editorContext: null,
  }), [videoSettings?.lastTimelineId]);

  const registrationsRef = useRef(new Map<AgentChatRegistryOwner, { value: AgentChatContextValue }>());
  const activeOwnerRef = useRef<AgentChatRegistryOwner | null>(null);

  const unregister = useCallback((owner: AgentChatRegistryOwner) => {
    const registrations = registrationsRef.current;
    if (!registrations.delete(owner)) return;
    if (activeOwnerRef.current === owner) {
      // Activation moves an owner to the end, so resume the most recently used
      // remaining editor when the active editor leaves.
      const remainingOwners = Array.from(registrations.keys());
      activeOwnerRef.current = remainingOwners[remainingOwners.length - 1] ?? null;
      setOverride(activeOwnerRef.current === null
        ? null
        : registrations.get(activeOwnerRef.current)?.value ?? null);
    }
  }, []);

  const activate = useCallback((owner: AgentChatRegistryOwner) => {
    const registrations = registrationsRef.current;
    const registration = registrations.get(owner);
    if (!registration) return;
    registrations.delete(owner);
    registrations.set(owner, registration);
    activeOwnerRef.current = owner;
    setOverride(registration.value);
  }, []);

  const register = useCallback((value: AgentChatContextValue, owner: AgentChatRegistryOwner) => {
    const registration = { value };
    registrationsRef.current.set(owner, registration);
    if (activeOwnerRef.current === null) {
      activate(owner);
    } else if (activeOwnerRef.current === owner) {
      setOverride(value);
    }
    // A replacement under the same owner owns its own lifetime. An earlier
    // effect's cleanup must not remove the replacement registration.
    return () => {
      if (registrationsRef.current.get(owner) === registration) unregister(owner);
    };
  }, [activate, unregister]);

  const registerProject = useCallback((value: AgentChatContextValue) => setProjectScope(value), []);
  const unregisterProject = useCallback(() => setProjectScope(null), []);
  const registry = useMemo(() => ({ register, unregister, activate, registerProject, unregisterProject }), [register, unregister, activate, registerProject, unregisterProject]);

  // Actions bridge — kept in a ref so registered handlers always invoke the latest
  // panel-side closures even after the AgentChatPanel re-renders. Reactive state
  // (isRecording/isProcessing/isAgentWorking) is the only thing that re-renders consumers.
  const handlersRef = useRef<AgentChatActionsHandlers | null>(null);
  const [reactiveState, setReactiveState] = useState<AgentChatActionsState | null>(null);

  const registerHandlers = useCallback((handlers: AgentChatActionsHandlers) => {
    handlersRef.current = handlers;
  }, []);
  const publishState = useCallback((state: AgentChatActionsState) => {
    setReactiveState((prev) => (
      prev
      && prev.isRecording === state.isRecording
      && prev.isProcessing === state.isProcessing
      && prev.isAgentWorking === state.isAgentWorking
        ? prev
        : state
    ));
  }, []);
  const unregisterActions = useCallback(() => {
    handlersRef.current = null;
    setReactiveState(null);
  }, []);

  const actionsRegistry = useMemo<AgentChatActionsRegistry>(() => ({
    registerHandlers,
    publishState,
    unregister: unregisterActions,
  }), [registerHandlers, publishState, unregisterActions]);

  const actions = useMemo<AgentChatActionsValue | null>(() => {
    if (!reactiveState) return null;
    return {
      toggleRecording: () => handlersRef.current?.toggleRecording(),
      focusComposer: () => handlersRef.current?.focusComposer(),
      markEngaged: () => handlersRef.current?.markEngaged(),
      isRecording: reactiveState.isRecording,
      isProcessing: reactiveState.isProcessing,
      isAgentWorking: reactiveState.isAgentWorking,
    };
  }, [reactiveState]);

  const contextValue = useMemo<AgentChatContextValue>(() => {
    // A previous editor must not leak its context after route project switch.
    const active = (projectScope && override?.editorContext?.projectId !== projectScope.editorContext?.projectId
      ? null : override) ?? projectScope ?? defaultValue;
    // The route knows the project's name; a timeline editor's registration for the same project does not carry it.
    const projectName = active.editorContext && !active.editorContext.projectName ? projectScope?.editorContext?.projectName : undefined;
    return {
      ...active,
      ...(active.editorContext && projectName ? { editorContext: { ...active.editorContext, projectName } } : {}),
      requestComposerPrompt,
      pendingComposerPrompt,
      clearPendingComposerPrompt,
    };
  }, [clearPendingComposerPrompt, defaultValue, override, projectScope, pendingComposerPrompt, requestComposerPrompt]);

  return (
    <AgentChatRegistryContext.Provider value={registry}>
      <AgentChatActionsRegistryContext.Provider value={actionsRegistry}>
        <AgentChatActionsContext.Provider value={actions}>
          <AgentChatContext.Provider value={contextValue}>
            {children}
          </AgentChatContext.Provider>
        </AgentChatActionsContext.Provider>
      </AgentChatActionsRegistryContext.Provider>
    </AgentChatRegistryContext.Provider>
  );
}

/** Consumed by AgentChat to read timeline state. */
export function useAgentChatBridge(): AgentChatContextValue {
  const context = useContext(AgentChatContext);
  return requireContextValue(context, 'useAgentChatBridge', 'AgentChatProvider');
}

/** Optional bridge for editor chrome that also renders in isolated host tests. */
export function useOptionalAgentChatBridge(): AgentChatContextValue | null {
  return useContext(AgentChatContext);
}

/** Route scope is optional for isolated page hosts without global chat chrome. */
export function useOptionalAgentChatRegistry(): AgentChatRegistryValue | null {
  return useContext(AgentChatRegistryContext);
}

/** Consumed by VideoEditorProvider to push timeline state into the bridge. */
export function useAgentChatRegistry(): AgentChatRegistryValue {
  const context = useContext(AgentChatRegistryContext);
  return requireContextValue(context, 'useAgentChatRegistry', 'AgentChatProvider');
}

// Returns null until AgentChatPanel mounts and publishes initial state. The one
// optional bridge surface — TasksPane reads this to decide whether to render the
// composer button. Required contexts generally throw when missing, but the
// timing of panel mount vs. TasksPane mount makes a brief null window unavoidable.
export function useAgentChatActions(): AgentChatActionsValue | null {
  return useContext(AgentChatActionsContext);
}

// Consumed by AgentChatPanel to register itself. Throws if used outside the provider.
export function useAgentChatActionsRegistry(): AgentChatActionsRegistry {
  const context = useContext(AgentChatActionsRegistryContext);
  return requireContextValue(context, 'useAgentChatActionsRegistry', 'AgentChatProvider');
}

import { Asterisk, Feather, Hexagon, Octagon, Sparkles, type LucideProps } from 'lucide-react';
import { LOCAL_AGENT_IDS, LOCAL_AGENT_TABLE, type LocalAgentChoice, type LocalAgentId } from '@/integrations/astrid/localAgents.ts';

export const AGENT_IDS = LOCAL_AGENT_IDS;

export const agentNames = Object.fromEntries(LOCAL_AGENT_IDS.map(id => [id, LOCAL_AGENT_TABLE[id].name])) as Record<LocalAgentId, string>;

const agentIcons = { astrid: Sparkles, 'claude-code': Asterisk, codex: Hexagon, hermes: Feather, octop: Octagon } as const;

/** A quiet mark that tells chats apart at a glance; the name always travels with it. */
export function AgentIcon({ agent, ...props }: { agent: LocalAgentId } & LucideProps) {
  const Icon = agentIcons[agent];
  return <Icon aria-hidden="true" {...props} />;
}

export interface AgentAvailability {
  usable: boolean;
  state: LocalAgentChoice['state'];
  line: string | null;
}

export function agentAvailability(choice: LocalAgentChoice | undefined): AgentAvailability {
  const state = choice?.signIn === 'signed-out' ? 'sign-in' : choice?.state ?? 'sign-in';
  return { usable: isAgentUsable(choice), state, line: choice?.line ?? null };
}

/** Setup requires an advertised ready row; older services omit signIn. */
export function isAgentUsable(choice: LocalAgentChoice | undefined): boolean {
  return choice?.state === 'ready' && choice.signIn !== 'signed-out';
}

import { z } from 'zod';

/** Names for local agents; install and sign-in instructions come from the service. */
export const LOCAL_AGENT_TABLE = {
  astrid: { name: 'Astrid' },
  'claude-code': { name: 'Claude Code' },
  codex: { name: 'Codex' },
  hermes: { name: 'Hermes' },
} as const;

export type LocalAgentId = keyof typeof LOCAL_AGENT_TABLE;
export const LOCAL_AGENT_IDS = Object.keys(LOCAL_AGENT_TABLE) as [LocalAgentId, ...LocalAgentId[]];
export const EXTERNAL_AGENT_IDS = LOCAL_AGENT_IDS.filter((id): id is Exclude<LocalAgentId, 'astrid'> => id !== 'astrid');
export const localAgentIdSchema = z.enum(LOCAL_AGENT_IDS);

/** Confirmed personal agent-definition folders; project-local paths are intentionally omitted. */
export const PERSONAL_AGENT_DIRECTORIES: Partial<Record<LocalAgentId, string>> = {
  astrid: '~/.omp/agent/agents',
  'claude-code': '~/.claude/agents',
  codex: '~/.codex/agents',
};

export const thoughtLevelSchema = z.object({
  configId: z.string().min(1),
  name: z.string(),
  currentValue: z.string(),
  options: z.array(z.object({ value: z.string().min(1), name: z.string(), description: z.string().nullable().optional() })),
  recommendedValue: z.string().optional(),
});
export type AgentThoughtLevel = z.infer<typeof thoughtLevelSchema>;

export function defaultThoughtLevel(level: AgentThoughtLevel): string {
  return level.recommendedValue ?? level.options.find(option => option.value === 'default')?.value ?? level.currentValue;
}

const localAgentModelSchema = z.object({
  modelId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  thoughtLevel: thoughtLevelSchema.optional(),
});
export type LocalAgentModel = z.infer<typeof localAgentModelSchema>;

export const localAgentSignInSchema = z.enum(['signed-in', 'signed-out', 'unknown']);
export type LocalAgentSignIn = z.infer<typeof localAgentSignInSchema>;

export const localAgentStepSchema = z.object({
  kind: z.enum(['install', 'sign-in']),
  command: z.string(),
  label: z.string(),
});
export type LocalAgentStep = z.infer<typeof localAgentStepSchema>;

export const localAgentTerminalSchema = z.object({
  command: z.string().min(1),
  skillSynced: z.boolean(),
  detail: z.string().optional(),
});
export type LocalAgentTerminal = z.infer<typeof localAgentTerminalSchema>;

const localAgentChoiceSchema = z.object({
  id: localAgentIdSchema,
  name: z.string(),
  state: z.enum(['ready', 'sign-in', 'not-installed']),
  line: z.string().nullable(),
  signInLine: z.string().optional(),
  models: z.array(localAgentModelSchema),
  defaultModel: z.string().nullable(),
  signIn: localAgentSignInSchema.optional(),
  steps: z.array(localAgentStepSchema).optional(),
  creditLine: z.string().optional(),
  creditUrl: z.string().optional(),
  /** What the terminal nudge shows: the command that talks to this agent, and whether Astrid's skill reached it. */
  terminal: localAgentTerminalSchema.optional(),
});
export type LocalAgentChoice = z.infer<typeof localAgentChoiceSchema>;

const localAgentCatalogResponseSchema = z.object({ agents: z.array(z.unknown()), defaultAgent: z.string() });
const reportedUnknownAgentIds = new Set<string>();

function knownLocalAgentId(id: string): id is LocalAgentId {
  return (LOCAL_AGENT_IDS as readonly string[]).includes(id);
}

function reportUnknownAgentId(id: string): void {
  if (reportedUnknownAgentIds.has(id)) return;
  reportedUnknownAgentIds.add(id);
  console.debug(`[LocalAgents] Ignoring unknown agent "${id}" from the chat service.`);
}

export const localAgentCatalogSchema = localAgentCatalogResponseSchema.transform(({ agents, defaultAgent }) => ({
  agents: agents.flatMap((row) => {
    const id = typeof row === 'object' && row !== null && 'id' in row && typeof row.id === 'string' ? row.id : null;
    if (id !== null && !knownLocalAgentId(id)) {
      reportUnknownAgentId(id);
      return [];
    }
    return [localAgentChoiceSchema.parse(row)];
  }),
  defaultAgent: knownLocalAgentId(defaultAgent) ? defaultAgent : (reportUnknownAgentId(defaultAgent), 'astrid' as const),
}));

export const localAgentModelsSchema = z.object({
  availableModels: z.array(localAgentModelSchema),
  currentModelId: z.string(),
  modelConfigId: z.string().optional(),
  /** Only the current model's advertised levels; never infer another model's support. */
  thoughtLevel: thoughtLevelSchema.optional(),
});
export type LocalAgentModels = z.infer<typeof localAgentModelsSchema>;

/** Astrid's existing opaque IDs remain unchanged; other agents have distinct stores. */
export function knownSessionAgentId(sessionId: string): LocalAgentId | null {
  for (const id of EXTERNAL_AGENT_IDS) if (isExternalAgentSession(sessionId, id)) return id;
  if (sessionId.includes(':')) return null;
  return 'astrid';
}

export function sessionAgentId(sessionId: string): LocalAgentId {
  const agent = knownSessionAgentId(sessionId);
  if (!agent) throw new Error('This chat belongs to an agent this version of Astrid does not support.');
  return agent;
}

export function isExternalAgentSession(sessionId: string, agent?: typeof EXTERNAL_AGENT_IDS[number]): boolean {
  return agent ? sessionId.startsWith(`${agent}:`) : EXTERNAL_AGENT_IDS.some(id => sessionId.startsWith(`${id}:`));
}

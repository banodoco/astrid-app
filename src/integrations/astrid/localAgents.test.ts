// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXTERNAL_AGENT_IDS, LOCAL_AGENT_IDS, isExternalAgentSession, knownSessionAgentId, localAgentCatalogSchema, sessionAgentId } from './localAgents.ts';

afterEach(() => localStorage.clear());

describe('local agent registry', () => {
  it('keeps external IDs and session routing in sync', () => {
    expect(LOCAL_AGENT_IDS).toEqual(['astrid', 'claude-code', 'codex', 'hermes', 'octop']);
    for (const agent of EXTERNAL_AGENT_IDS) {
      expect(isExternalAgentSession(`${agent}:chat-1`)).toBe(true);
      expect(sessionAgentId(`${agent}:chat-1`)).toBe(agent);
    }
    expect(sessionAgentId('opaque-astrid-chat')).toBe('astrid');
  });

  it('accepts Hermes as the service-owned default without browser storage', () => {
    const catalog = localAgentCatalogSchema.parse({ defaultAgent: 'hermes', agents: [{ id: 'hermes', name: 'Hermes', state: 'ready', line: null, models: [], defaultModel: null }] });
    expect(catalog.defaultAgent).toBe('hermes');
    expect(localStorage.length).toBe(0);
  });

  it('skips service agents this app does not know and falls back for an unknown default', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const row = { id: 'claude-code', name: 'Claude Code', state: 'ready', line: null, models: [], defaultModel: null };
    const catalog = localAgentCatalogSchema.parse({
      defaultAgent: 'new-agent',
      agents: [row, { id: 'new-agent', invalid: true }],
    });
    expect(catalog.agents).toEqual([row]);
    expect(catalog.defaultAgent).toBe('astrid');
    expect(debug).toHaveBeenCalledTimes(1);
    debug.mockRestore();
  });

  it('does not route an unknown namespaced session to Astrid', () => {
    expect(knownSessionAgentId('new-agent:chat-1')).toBeNull();
    expect(() => sessionAgentId('new-agent:chat-1')).toThrow('does not support');
  });

  it('accepts optional setup fields and drops unknown agent and model keys', () => {
    const catalog = localAgentCatalogSchema.parse({ defaultAgent: 'astrid', agents: [{
      id: 'astrid', name: 'Astrid', state: 'ready', line: null, models: [{ modelId: 'openrouter/model', name: 'Model', futureModelField: true }], defaultModel: 'openrouter/model',
      signIn: 'signed-in', steps: [{ kind: 'sign-in', command: 'run-astrid', label: 'Sign in' }],
      creditLine: 'Built on oh-my-pi', creditUrl: 'https://example.test/omp', futureAgentField: true,
    }] });
    expect(catalog.agents[0]).toMatchObject({
      signIn: 'signed-in', steps: [{ kind: 'sign-in', command: 'run-astrid', label: 'Sign in' }],
      creditLine: 'Built on oh-my-pi', creditUrl: 'https://example.test/omp',
    });
    expect(catalog.agents[0]).not.toHaveProperty('futureAgentField');
    expect(catalog.agents[0].models[0]).not.toHaveProperty('futureModelField');
  });

  it.each([
    'Install with `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`',
    'Install with `iex (irm https://hermes-agent.nousresearch.com/install.ps1)`',
    'Run `hermes setup`, then come back.',
  ])('preserves the service-provided Hermes recovery line: %s', line => {
    const catalog = localAgentCatalogSchema.parse({ defaultAgent: 'hermes', agents: [{ id: 'hermes', name: 'Hermes', state: 'sign-in', line, models: [], defaultModel: null }] });
    expect(catalog.agents[0].line).toBe(line);
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeAcp } from './acp.ts';
import { localAgentCatalogSchema } from '../../../src/integrations/astrid/localAgents.ts';

const project = '/projects/demo/chat';
const connection_id = 'local-test-connection';

test('setup catalogs meet the app contract, and control flips sign-in and installation', () => {
  const fake = createFakeAcp(['demo'], 'A');
  for (const scenario of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) {
    fake.handle('POST', '/__test/agent-setup', { scenario });
    const catalog = localAgentCatalogSchema.parse(fake.handle('GET', '/agents', null)!.body);
    assert.equal(catalog.agents.length, 5);
    for (const agent of catalog.agents) assert(agent.steps?.length);
    if (scenario === 'C' || scenario === 'D' || scenario === 'H') {
      fake.handle('POST', '/__test/agent-setup', { ready: true });
      const updated = localAgentCatalogSchema.parse(fake.handle('GET', '/agents', null)!.body);
      assert.equal(updated.agents.find(agent => agent.id === (scenario === 'C' ? 'claude-code' : scenario === 'D' ? 'hermes' : 'octop'))?.signIn, 'signed-in');
    }
  }
});

test('OpenRouter responses never echo keys and use bare catalog ids with a selector default', () => {
  const fake = createFakeAcp(['demo'], 'E');
  for (const [key, status, error] of [
    ['sk-or-test-wrong-0000000000', 400, 'invalid_key'],
    ['sk-or-test-offline-000000000', 502, 'provider_unreachable'],
    ['sk-or-test-valid-0000000000', 200, undefined],
  ] as const) {
    const result = fake.handle('POST', '/astrid/api-key', { provider: 'openrouter', key })!;
    assert.equal(result.status, status);
    assert.equal((result.body as { error?: string }).error, error);
    assert.equal(JSON.stringify(result).includes(key), false);
  }
  const models = fake.handle('GET', '/models', null)!.body as { providers: { id: string; signedIn: boolean; models: { id: string }[] }[]; currentModel: string };
  assert.equal(models.providers[0].signedIn, true);
  assert.equal(models.providers[0].models.length, 2);
  assert.equal(models.currentModel, `openrouter/${models.providers[0].models[0].id}`);
});

test('all setup error codes include a fix, and failed creates release their operation immediately', () => {
  const fake = createFakeAcp(['demo'], 'F');
  const body = { connection_id, operation_id: 'same-operation', mode: 'new' };
  for (const error of ['agent_not_installed', 'agent_sign_in_required', 'agent_runtime_missing']) {
    fake.handle('POST', '/__test/agent-setup', { createError: error });
    const result = fake.handle('POST', `${project}/sessions`, body)!;
    assert.equal(result.status, 502);
    assert.equal((result.body as { error: string }).error, error);
    assert((result.body as { next_action: string }).next_action);
  }
  fake.handle('POST', '/__test/agent-setup', { createError: null });
  assert.equal(fake.handle('POST', `${project}/sessions`, body)!.status, 200);
});

test('failed prompts retry, successful ids dedupe, and events drain assistant chunks', () => {
  const fake = createFakeAcp(['demo'], 'G');
  fake.handle('POST', '/connect', { agent: 'codex' });
  const created = fake.handle('POST', `${project}/sessions`, { connection_id, mode: 'new' })!.body as { operation_session_id: string };
  const body = { connection_id, session_id: created.operation_session_id, request_id: 'same-request', prompt: [{ type: 'text', text: 'hi' }] };
  assert.equal(fake.handle('POST', `${project}/prompt`, body)!.status, 502);
  assert.equal(fake.handle('POST', `${project}/prompt`, body)!.status, 200);
  assert.equal(fake.handle('POST', `${project}/prompt`, body)!.status, 200);
  assert.equal(fake.handle('POST', `${project}/prompt`, { ...body, prompt: [] })!.status, 409);
  const events = fake.handle('GET', `/${connection_id}/events`, null)!.body as { notifications: { params: { update: { content: { text: string } } } }[] };
  assert.equal(events.notifications.map(item => item.params.update.content.text).join(''), "Hi! I'm ready.");
  assert.deepEqual(fake.handle('GET', `/${connection_id}/events`, null)!.body, { notifications: [], disconnected: false });
});

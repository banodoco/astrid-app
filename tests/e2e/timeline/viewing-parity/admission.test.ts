import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Page, Response } from '@playwright/test';
import { waitForRenderAdmission } from './admission';

const url = 'http://127.0.0.1:17340/api/astrid/v1/tasks';

function mountedPage() {
  const events = new EventEmitter();
  let error: string | null = null;
  const page = Object.assign(events, {
    locator: () => ({ isVisible: async () => error !== null, textContent: async () => error }),
  }) as unknown as Page;
  return { page, events, refuse: (message: string) => { error = message; } };
}

function response(method = 'POST', target = url, status = 201) {
  return { request: () => ({ method: () => method }), url: () => target, status: () => status } as Response;
}

test('observes the exact POST even when admission completes during the click', async () => {
  const { page, events } = mountedPage();
  const admitted = response();
  assert.equal(await waitForRenderAdmission(page, url, async () => {
    events.emit('response', response('GET'));
    events.emit('response', response('POST', `${url}/other`));
    events.emit('response', admitted);
  }), admitted);
  assert.equal(events.listenerCount('response'), 0);
});

test('fails on a visible catalog admission refusal without waiting for a task response', async () => {
  const { page, events, refuse } = mountedPage();
  await assert.rejects(waitForRenderAdmission(page, url, async () => {
    refuse('Astrid render admission failed: capability catalog failed (404)');
  }), /refused admission: Astrid render admission failed: capability catalog failed \(404\)/);
  assert.equal(events.listenerCount('response'), 0);
});

test('returns an actual rejected POST so the caller still checks admission status', async () => {
  const { page, events } = mountedPage();
  const rejected = response('POST', url, 403);
  assert.equal((await waitForRenderAdmission(page, url, async () => {
    events.emit('response', rejected);
  })).status(), 403);
});

test('observes an admission error that becomes visible after the click returns', async () => {
  const { page, events, refuse } = mountedPage();
  const timer = setTimeout(() => refuse('Astrid render admission failed: catalog unavailable'), 5);
  try {
    await assert.rejects(waitForRenderAdmission(page, url, async () => {},
      { timeoutMs: 1_000, pollIntervalMs: 1 }), /refused admission: Astrid render admission failed/);
    assert.equal(events.listenerCount('response'), 0);
  } finally { clearTimeout(timer); }
});

test('bounds missing admission and removes its observer after click failure', async () => {
  const { page, events } = mountedPage();
  await assert.rejects(waitForRenderAdmission(page, url, async () => {},
    { timeoutMs: 5, pollIntervalMs: 1 }), /did not POST a task/);
  assert.equal(events.listenerCount('response'), 0);
  await assert.rejects(waitForRenderAdmission(page, url, async () => { throw new Error('click failed'); }), /click failed/);
  assert.equal(events.listenerCount('response'), 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentHead } from './app.ts';
import type { DirectHarness } from './harness.ts';

test('currentHead reads the timeline head rather than a history page', async () => {
  const calls: unknown[][] = [];
  const harness = {
    seed: { projectId: 'project', timelineId: 'timeline' },
    runtimeJson: async (...args: unknown[]) => {
      calls.push(args);
      return { status: 200, body: { head_revision_id: 'current-revision' } };
    },
  } as unknown as DirectHarness;
  assert.equal(await currentHead(harness), 'current-revision');
  assert.deepEqual(calls, [['GET', '/v1/projects/project/timelines/timeline']]);
});

test('currentHead rejects unsuccessful or missing head responses', async () => {
  for (const response of [
    { status: 404, body: { head_revision_id: 'stale' } },
    { status: 200, body: { head_revision_id: null } },
    { status: 200, body: { head_revision_id: '' } },
  ]) {
    const harness = {
      seed: { projectId: 'project', timelineId: 'timeline' },
      runtimeJson: async () => response,
    } as unknown as DirectHarness;
    await assert.rejects(currentHead(harness));
  }
});

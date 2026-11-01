// Old publication recordings remain useful request fixtures, but their pre-v2
// success/CAS responses must never re-enable the retired write route.
import { describe, expect, it } from 'vitest';
import { PROJECT_ID, runtimeFixture, TIMELINE_ID } from '@/test/fakeWorkspaceRuntime.ts';
import { filled } from '@/test/recordedResponses.ts';

describe('runtimeFixture rejects pre-v2 publication recordings', () => {
  it('refuses the old stale-head publish with 410 before evaluating its CAS', async () => {
    const recording = filled('publish_conflict_409');
    const fixture = runtimeFixture();
    const original = structuredClone(fixture.read());
    const response = await fixture.transport(recording.request.method,
      `/v1/projects/${PROJECT_ID}/timelines/${TIMELINE_ID}/composition-revisions`,
      { 'Idempotency-Key': 'stale-publish', 'Content-Type': 'application/json' },
      new TextEncoder().encode(JSON.stringify(recording.request.body)));
    expect(response.status).toBe(410);
    expect(JSON.parse(new TextDecoder().decode(response.body))).toMatchObject({ code: 'retired_route',
      details: { reason: 'timeline_commit_required' } });
    expect(fixture.read()).toEqual(original);
  });
});

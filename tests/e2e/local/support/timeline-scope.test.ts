import assert from 'node:assert/strict';
import test from 'node:test';
import { timelineBase, timelineFromList } from './timeline-scope.ts';

test('timeline paths keep seeded and created-project scopes explicit', () => {
  assert.equal(timelineBase({ projectId: 'seeded-project', timelineId: 'seeded-timeline' }),
    '/v1/projects/seeded-project/timelines/seeded-timeline');
  assert.equal(timelineBase({ projectId: 'created-project', timelineId: 'created-timeline' }),
    '/v1/projects/created-project/timelines/created-timeline');
});

test('timeline list lookup requires the exact selected resource', () => {
  const page = { items: [
    { timeline_id: 'other-timeline', is_shot: false },
    { timeline_id: 'created-timeline', is_shot: false },
  ] };
  assert.equal(timelineFromList(page, 'created-timeline')?.timeline_id, 'created-timeline');
  assert.equal(timelineFromList(page, 'missing-timeline'), undefined);
});

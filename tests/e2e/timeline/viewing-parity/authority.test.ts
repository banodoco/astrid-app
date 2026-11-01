import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Task } from '../../../../src/integrations/runtime/generated';
import { assertTaskAuthority } from './authority';
import type { FrameParityFixture } from './fixture';

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const fixture: FrameParityFixture = {
  projectId: 'project', timelineId: 'timeline', headRevisionId: 'parent', shotId: 'shot', occurrenceId: 'occurrence',
  shotRevisionId: 'shot-revision', internalRevisionId: 'internal-revision',
  parent: { revision_id: 'parent', content_digest: 'parent-digest', payload: {} },
  shot: { revision_id: 'shot-revision', content_digest: 'shot-digest', payload: {} },
  internal: { revision_id: 'internal-revision', content_digest: 'internal-digest', payload: {} },
  media: [{ objectId: digest('a'), digest: digest('a') }], sourceVideoMediaId: digest('a'),
  sourceVideoMetadata: { streams: [], frames: [], format: { duration: '1.5' } },
};

function admittedTask() {
  const task = {
    task_id: 'task', run_id: 'run', project_id: 'project', state: 'queued', version: 1, capability_id: 'rendering.render',
    capability_digest: digest('c'), idempotency_key: 'render-operation', created_at: '', updated_at: '', runtime_epoch: 1,
    input_object_ids: [digest('a'), digest('b')],
    spec: { spec: { inputs: { selector: 'rendering.remotion', timeline_authority: {
      authority: 'kernel', project_id: 'project', timeline_id: 'timeline', parent_revision_id: 'parent',
      parent_content_digest: 'parent-digest', snapshot_digest: digest('b'), input_object_ids: [digest('a')],
      managed_media_admissions: { [digest('a')]: digest('a') },
      dependency_digests: [
        { dependency_kind: 'shot_revision', dependency_id: 'shot-revision', content_digest: 'shot-digest' },
        { dependency_kind: 'internal_timeline_revision', dependency_id: 'internal-revision', content_digest: 'internal-digest' },
        { dependency_kind: 'media', dependency_id: digest('a'), content_digest: digest('a') },
      ],
    } }, timeline_snapshot_ref: { digest: digest('b'), project_id: 'project', timeline_id: 'timeline',
      revision_id: 'parent', revision_digest: 'parent-digest', source_kind: 'revision' } } },
  } satisfies Task;
  return task;
}

test('authority comparison accepts public pins independent of dependency ordering', () => {
  const task = admittedTask();
  const spec = task.spec.spec;
  spec.inputs.timeline_authority.dependency_digests.reverse();
  assertTaskAuthority(task, fixture, digest('c'));
});

test('authority comparison refuses a different project, head, child pin, media, snapshot or capability', () => {
  const mutations: Array<(task: ReturnType<typeof admittedTask>) => void> = [
    task => { task.project_id = 'other'; },
    task => { task.capability_digest = digest('d'); },
    task => { task.spec.spec.inputs.selector = 'other-renderer'; },
    task => { task.spec.spec.inputs.timeline_authority.parent_revision_id = 'new-head'; },
    task => { task.spec.spec.inputs.timeline_authority.parent_content_digest = 'new-digest'; },
    task => { task.spec.spec.inputs.timeline_authority.dependency_digests[0].dependency_id = 'other-shot'; },
    task => { task.spec.spec.inputs.timeline_authority.dependency_digests[1].content_digest = 'other-internal'; },
    task => { delete task.spec.spec.inputs.timeline_authority.managed_media_admissions[digest('a')]; },
    task => { task.spec.spec.inputs.timeline_authority.input_object_ids = []; },
    task => { task.spec.spec.timeline_snapshot_ref.source_kind = 'cas'; },
    task => { task.spec.spec.timeline_snapshot_ref.digest = digest('d'); },
    task => { task.input_object_ids = [digest('a')]; },
  ];
  for (const mutate of mutations) {
    const task = admittedTask();
    mutate(task);
    assert.throws(() => assertTaskAuthority(task, fixture, digest('c')), { name: 'AssertionError' });
  }
});

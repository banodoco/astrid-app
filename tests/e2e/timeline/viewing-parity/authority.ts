import assert from 'node:assert/strict';
import type { Task } from '../../../../src/integrations/runtime/generated';
import type { FrameParityFixture } from './fixture';

export function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'expected public object');
  return value as Record<string, unknown>;
}

/** Compare only public Runtime authority; never construct an admission in the test. */
export function assertTaskAuthority(task: Task, fixture: FrameParityFixture, capabilityDigest: string) {
  assert.equal(task.project_id, fixture.projectId);
  assert.equal(task.capability_id, 'rendering.render');
  assert.equal(task.capability_digest, capabilityDigest);
  const spec = record(task.spec.spec);
  const inputs = record(spec.inputs);
  assert.equal(inputs.selector, 'rendering.remotion');
  const authority = record(inputs.timeline_authority);
  assert.equal(authority.authority, 'kernel');
  assert.equal(authority.project_id, fixture.projectId);
  assert.equal(authority.timeline_id, fixture.timelineId);
  assert.equal(authority.parent_revision_id, fixture.headRevisionId);
  assert.equal(authority.parent_content_digest, fixture.parent.content_digest);
  const expectedDependencies = [
    { dependency_kind: 'shot_revision', dependency_id: fixture.shotRevisionId, content_digest: fixture.shot.content_digest },
    { dependency_kind: 'internal_timeline_revision', dependency_id: fixture.internalRevisionId, content_digest: fixture.internal.content_digest },
    ...fixture.media.map(pin => ({ dependency_kind: 'media', dependency_id: pin.objectId, content_digest: pin.digest })),
  ];
  const sorted = (items: unknown) => {
    assert.ok(Array.isArray(items));
    return [...items].sort((a, b) => String(record(a).dependency_id).localeCompare(String(record(b).dependency_id)));
  };
  assert.deepEqual(sorted(authority.dependency_digests), sorted(expectedDependencies));
  assert.deepEqual(authority.managed_media_admissions, Object.fromEntries(fixture.media.map(pin => [pin.objectId, pin.digest])));
  assert.deepEqual(new Set(authority.input_object_ids as string[]), new Set(fixture.media.map(pin => pin.objectId)));
  const snapshot = record(spec.timeline_snapshot_ref);
  assert.equal(snapshot.project_id, fixture.projectId);
  assert.equal(snapshot.timeline_id, fixture.timelineId);
  assert.equal(snapshot.revision_id, fixture.headRevisionId);
  assert.equal(snapshot.revision_digest, fixture.parent.content_digest);
  assert.equal(snapshot.source_kind, 'revision');
  assert.match(String(snapshot.digest), /^sha256:[0-9a-f]{64}$/);
  assert.equal(authority.snapshot_digest, snapshot.digest);
  assert.deepEqual(new Set(task.input_object_ids), new Set([String(snapshot.digest), ...fixture.media.map(pin => pin.objectId)]),
    'task must pin exactly the fixture media and frozen CAS snapshot');
  return { authority, snapshot };
}

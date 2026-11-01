import { createHash } from 'node:crypto';
import type { CommitAcceptedMutation, CommitRequest, HeadPin } from '../generated.ts';

// Fixture hashes use Runtime's sorted, compact canonical JSON for these JSON-only
// payloads. Production digest/semantic verification remains Runtime-owned.
export function fixtureDigest(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : item);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function acceptedCommit(
  head: HeadPin,
  base: HeadPin,
  options: { projectId?: string; timelineId?: string; children?: boolean; commands?: CommitRequest['commands'] } = {},
): CommitAcceptedMutation {
  const projectId = options.projectId ?? 'project-commit';
  const timelineId = options.timelineId ?? 'timeline-commit';
  const internalId = 'internal-r1';
  const timelineBase = { tracks: [{ id: 'V1', kind: 'visual', label: 'Picture' }] };
  const internalPayload = {
    ...timelineBase,
    clips: [{ id: 'child-title', track: 'V1', at: 0, hold: 1, text: { content: 'child' }, app: { extension: { clear: null, nested: ['keep'] } } }],
    app: { extension: { nested: { clear: null } } },
  };
  const shotPayload = {
    name: 'Shared shot',
    internal_timeline_revision_id: internalId,
    timing: { duration_ms: 1000 },
    metadata: { extension: { nested: [null, { keep: true }] } },
    assets: [],
  };
  const occurrences = options.children ? [0, 1].map((ordinal) => ({
    occurrence_id: `occ-${ordinal}`,
    shot_id: 'shot-1',
    shot_revision_id: 'shot-r1',
    placement: { start_ms: ordinal * 1000, track: 'V1', extension: { clear: null } },
    duration_ms: 1000,
    track: 'V1',
    source_offset: 0,
    speed: 1,
    extension: { occurrence: ordinal, nested: [null, { keep: true }] },
  })) : [];
  const parentPayload = {
    config: { ...timelineBase, clips: [] },
    registry: { assets: {} },
    clips: [{ id: 'x', track: 'V1', at: 7, hold: 1, text: { content: 'parent' } }],
    occurrences,
    bundle: null,
    unknown: { nested: ['value', null] },
  };
  const shot = { shot_id: 'shot-1', revision_id: 'shot-r1', internal_timeline_revision_id: internalId, content_digest: fixtureDigest(shotPayload), payload: shotPayload };
  const internal = { timeline_id: 'child-timeline', revision_id: internalId, content_digest: fixtureDigest(internalPayload), payload: internalPayload };
  const canonicalDocument = {
    schema_version: 1 as const,
    project_id: projectId,
    timeline_id: timelineId,
    parent_revision: { revision_id: head.revision_id, content_digest: fixtureDigest(parentPayload), payload: parentPayload },
    shot_revisions: options.children ? [shot] : [],
    internal_timeline_revisions: options.children ? [internal] : [],
    dependency_manifest: {
      shots: options.children ? [{ shot_id: shot.shot_id, revision_id: shot.revision_id, internal_timeline_revision_id: internalId, content_digest: shot.content_digest }] : [],
      internal_timelines: options.children ? [{ timeline_id: internal.timeline_id, revision_id: internalId, content_digest: internal.content_digest }] : [],
      media: [],
      documents: [],
    },
  };
  const commands: CommitRequest['commands'] = options.commands ?? [{ schema_version: 1, op: 'clip.move', version: '1', select: 'parent/clip:x', args: { on: 7 } }];
  const data: CommitAcceptedMutation['data'] = {
    status: 'accepted',
    base_revision_id: base.revision_id,
    base_publication_id: base.publication_id,
    previous_revision_id: base.revision_id,
    previous_publication_id: base.publication_id,
    accepted_revision_id: head.revision_id,
    rebased_onto: null,
    canonical_document: canonicalDocument,
    document_digest: fixtureDigest(canonicalDocument),
    commands,
    id_map: {},
    provider_version: 'provider-1',
    compiler_version: 'compiler-1',
    publisher: 'actor-1',
  };
  const key = `key-${head.publication_id}`;
  const request: CommitRequest = { api_version: 1, project_id: projectId, timeline_id: timelineId, base_revision_id: base.revision_id, base_publication_id: base.publication_id, commands };
  return {
    data,
    receipt: {
      receipt_id: head.publication_id,
      command_kind: 'timeline.commit',
      idempotency_key: key,
      request_hash: fixtureDigest({ operation: 'commitTimeline', path: `/v1/projects/${projectId}/timelines/${timelineId}/commit`, publisher: data.publisher, request }).slice(7),
      project_id: projectId,
      project_seq: [1, 1],
      event_ids: [`event-${head.publication_id}`],
      result: data,
      created_at: '2026-10-19T00:00:00Z',
    },
  };
}

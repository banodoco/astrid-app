import { createFakeIndexedDB } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import type { CanonicalDocument, CommitRequest } from '@/integrations/runtime/generated.ts';
import type { TimelineCommandBasis, TimelineCommitResult } from '../data/DataProvider.ts';
import { createCommitOutbox } from './commitOutbox.ts';
import { createTimelineCommandSession } from './commitSession.ts';
import { captureShotNameEdit, captureShotSettingsEdit, submitShotNameEdit, submitShotSettingsEdit } from './shotSetGesture.ts';

const scope = { projectId: 'project-1', timelineId: 'timeline-1', realmId: 'realm-1', actorId: 'actor-1' };
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;

function documentWithOpaque(opaque: unknown = { keep: true }): CanonicalDocument {
  return {
    schema_version: 1,
    project_id: scope.projectId,
    timeline_id: scope.timelineId,
    parent_revision: {
      revision_id: 'r0',
      content_digest: digest('a'),
      payload: {
        config: { tracks: [], clips: [] }, tracks: [], clips: [], registry: { assets: {} },
        occurrences: [{ occurrence_id: 'occ-1', shot_id: 'shot-1', shot_revision_id: 'shot-r1' }], opaque,
      },
    },
    shot_revisions: [{ shot_id: 'shot-1', revision_id: 'shot-r1', content_digest: digest('b'),
      internal_timeline_revision_id: 'internal-r1', payload: { name: 'Original', internal_timeline_revision_id: 'internal-r1', opaque: { sibling: true } } }],
    internal_timeline_revisions: [{ timeline_id: 'shot-1-timeline', revision_id: 'internal-r1', content_digest: digest('c'), payload: { tracks: [], clips: [] } }],
    dependency_manifest: {
      shots: [{ shot_id: 'shot-1', revision_id: 'shot-r1', content_digest: digest('b'), internal_timeline_revision_id: 'internal-r1' }],
      internal_timelines: [{ timeline_id: 'shot-1-timeline', revision_id: 'internal-r1', content_digest: digest('c') }],
      media: [], documents: [],
    },
  } as unknown as CanonicalDocument;
}

async function sessionFixture() {
  let current = documentWithOpaque();
  const initial: TimelineCommandBasis = { head: { revisionId: 'r0', publicationId: 'p0' }, canonicalDocument: current };
  const factory = createFakeIndexedDB();
  const outboxes = createCommitOutbox({ indexedDB: factory, exclusiveLock: async (_key, work) => work() });
  const commits: Array<{ key: string; command: unknown }> = [];
  const project = vi.fn(async () => {});
  const send = vi.fn(async (request: CommitRequest, key: string) => {
    commits.push({ key, command: request.commands[0] });
    return {
      accepted: { revisionId: 'r1', publicationId: 'p1' },
      canonicalDocument: current,
      graph: {},
      response: { data: { commands: request.commands, previous_revision_id: 'r0', previous_publication_id: 'p0' } },
    } as unknown as TimelineCommitResult;
  });
  const session = await createTimelineCommandSession({
    scope, initial, outboxes, send, project, preview: vi.fn(), changed: vi.fn(),
  });
  return { session, initial, outboxes, project, send, commits, setCurrent: (next: CanonicalDocument) => { current = next; } };
}

describe('native shot name session lifecycle', () => {
  it('accepts one captured command through the durable completion path', async () => {
    const fixture = await sessionFixture();
    const captured = captureShotNameEdit(fixture.session.shotSetPort, {
      projectId: scope.projectId, parentDocumentId: scope.timelineId, headRevisionId: 'r0',
    }, 'occ-1');
    const completion = submitShotNameEdit(captured, 'Renamed');
    expect(completion).toBeInstanceOf(Promise);
    await completion;
    expect(fixture.commits).toHaveLength(1);
    expect(fixture.commits[0]?.command).toMatchObject({
      op: 'shot.set', select: 'occurrence:occ-1/shot', args: { values: { name: 'Renamed' }, clear: [] },
      expect: { 'occurrence:occ-1/shot::payload.name': { state: 'present', value: 'Original' } },
    });
    await fixture.session.flush();
    expect(fixture.session.getState().status).toBe('saved');
    await fixture.session.undo();
    await fixture.session.flush();
    expect(fixture.commits[1]?.command).toMatchObject({
      op: 'timeline.inverse', args: { publications: ['p1'] },
    });
    await fixture.session.dispose();
  });

  it('accepts captured scalar settings through the same durable shot.set completion path', async () => {
    const fixture = await sessionFixture();
    const captured = captureShotSettingsEdit(fixture.session.shotSetPort, {
      projectId: scope.projectId, parentDocumentId: scope.timelineId, headRevisionId: 'r0',
    }, 'occ-1', { advancedMode: false, motionMode: 'basic' });
    const completion = submitShotSettingsEdit(captured, { advancedMode: false, motionMode: 'basic' });
    expect(completion).toBeInstanceOf(Promise);
    await completion;
    expect(fixture.commits[0]?.command).toMatchObject({
      op: 'shot.set', select: 'occurrence:occ-1/shot',
      args: { values: { settings: { advancedMode: false, motionMode: 'basic' } }, clear: [] },
      expect: { 'occurrence:occ-1/shot::payload.settings': { state: 'absent' } },
    });
    await fixture.session.dispose();
  });

  it('refuses a captured name after remote observation without merging live bytes into its payload', async () => {
    const fixture = await sessionFixture();
    const captured = captureShotNameEdit(fixture.session.shotSetPort, {
      projectId: scope.projectId, parentDocumentId: scope.timelineId, headRevisionId: 'r0',
    }, 'occ-1');
    const remote = documentWithOpaque({ remote: true });
    fixture.setCurrent(remote);
    fixture.session.observe({ head: { revisionId: 'r1', publicationId: 'p1' }, canonicalDocument: remote });
    await vi.waitFor(() => expect(fixture.project).toHaveBeenCalled());

    expect(() => submitShotNameEdit(captured, 'My draft')).toThrow('shot.set was not captured by this session');
    expect(captured.basis).toMatchObject({ command: { expect: { 'occurrence:occ-1/shot::payload.name': { value: 'Original' } } } });
    expect((await fixture.outboxes.list(scope))[0]?.intents).toHaveLength(0);
    expect(fixture.send).not.toHaveBeenCalled();
    await fixture.session.dispose();
  });
});

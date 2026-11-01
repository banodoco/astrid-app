import { vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { TimelineSaveSource } from '../../hooks/timelineLocalSaveHandoff.ts';
import { createTimelineLocalSaveHandoff } from '../../hooks/timelineLocalSaveHandoff.ts';
import type { TimelineCommandBasis, TimelineCommitResult, TimelineHeadRevision } from '../../data/DataProvider.ts';
import type { TimelineData } from '../../lib/timeline-data.ts';
import { createDefaultTimelineConfig } from '../../lib/defaults.ts';
import type { TimelineConfig } from '../../types/index.ts';
import { createCommitOutbox, toOutboxJson, type OutboxJson } from '../commitOutbox.ts';
import { createLocalSaveSession, type LocalSaveSession } from '../localSaveSession.ts';

export const scope = { realmId: 'realm', actorId: 'actor', projectId: 'project-commit', timelineId: 'timeline-commit' };
export const h0 = { revisionId: 'r0', publicationId: 'p0' };

function documentPair() {
  const config = createDefaultTimelineConfig();
  const registry = { assets: {} };
  const parent = { config, registry, clips: config.clips, tracks: config.tracks, occurrences: [] };
  const document = acceptedCommit({ revision_id: h0.revisionId, publication_id: h0.publicationId },
    { revision_id: h0.revisionId, publication_id: h0.publicationId }).data.canonical_document;
  document.parent_revision.payload = parent;
  document.parent_revision.content_digest = fixtureDigest(parent);
  const after = structuredClone(document);
  const afterParent = after.parent_revision.payload as typeof parent;
  afterParent.config.tracks[0].label = 'Native label';
  afterParent.tracks[0].label = 'Native label';
  return { document, after, config, registry };
}

function acceptedResult(document: ReturnType<typeof documentPair>['after'], head = h0) {
  // This is a protocol-shaped accepted reply only; no semantic command applier is
  // used. The canonical document is supplied as the Runtime's accepted closure.
  const response = acceptedCommit({ revision_id: head.revisionId, publication_id: head.publicationId },
    { revision_id: h0.revisionId, publication_id: h0.publicationId });
  response.data.canonical_document = structuredClone(document);
  response.data.canonical_document.parent_revision.revision_id = head.revisionId;
  response.data.canonical_document.parent_revision.content_digest = fixtureDigest(
    response.data.canonical_document.parent_revision.payload,
  );
  response.data.document_digest = fixtureDigest(response.data.canonical_document);
  return { response, accepted: head, canonicalDocument: response.data.canonical_document, graph: {}, receipt: response.receipt } as TimelineCommitResult;
}

export function environment() {
  const pair = documentPair();
  const initial: TimelineCommandBasis = { head: h0, canonicalDocument: pair.document };
  const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (_key, work) => work() });
  const send = vi.fn<(request: import('@/integrations/runtime/timeline-commit-types.ts').CommitRequest, key: string) => Promise<TimelineCommitResult>>();
  let visible: OutboxJson = toOutboxJson(pair.document);
  const sourceHead: TimelineHeadRevision = { projectId: scope.projectId, timelineId: scope.timelineId,
    headRevisionId: h0.revisionId, headPublicationId: h0.publicationId };
  const source: TimelineSaveSource = { config: pair.config as TimelineConfig,
    registry: pair.registry as TimelineSaveSource['registry'], head: sourceHead };
  const prepareDisplay = vi.fn(async (basis: TimelineCommandBasis, draft?: OutboxJson) => {
    const document = structuredClone(draft ?? toOutboxJson(basis.canonicalDocument));
    return { document, adopt() { visible = document; } };
  });
  const mount = (basis = initial) => createLocalSaveSession({ scope, initial: basis,
    document: toOutboxJson(basis.canonicalDocument), outboxes, send, loadLatest: async () => basis,
    prepareDisplay, changed: () => {} });
  const append = async (session: LocalSaveSession) => session.appendDocument({ before: pair.document, after: pair.after,
    roots: [{ ref: 'parent', revisionId: h0.revisionId, contentDigest: pair.document.parent_revision.content_digest }],
    label: 'Native label', step: { id: 'track-label-step', label: 'Native label', intent: 'Update native label', tags: [] } });
  const sourceGuard = async (session: LocalSaveSession, displayed: Pick<TimelineData, 'head' | 'editProjection'>) => {
    const projection = displayed.editProjection;
    const displayedHead = displayed.head ?? { ...sourceHead, headPublicationId: null };
    const publicationId = projection?.kind === 'accepted' ? projection.head.publicationId
      : projection?.kind === 'local' ? projection.base.publicationId : null;
    const guardedSource = { ...source, head: { projectId: displayedHead.projectId, timelineId: displayedHead.timelineId,
      headRevisionId: displayedHead.headRevisionId, headPublicationId: publicationId } } as TimelineSaveSource;
    const handoff = createTimelineLocalSaveHandoff({ initial, source: guardedSource, session,
      adopted: (basis) => ({ receipt: { configVersion: 0, head: { ...sourceHead,
        headRevisionId: basis.head.revisionId, headPublicationId: basis.head.publicationId } }, source: guardedSource }) });
    return handoff.capture(guardedSource);
  };
  return { pair, initial, outboxes, send, prepareDisplay, mount, append, sourceGuard, visible: () => visible,
    accepted: acceptedResult };
}

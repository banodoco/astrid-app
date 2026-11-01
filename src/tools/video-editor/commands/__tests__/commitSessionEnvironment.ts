import { vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import { RuntimeDataProvider } from '@/integrations/runtime/dataProvider.ts';
import { RUNTIME_SCHEMA_DIGEST } from '@/integrations/runtime/contract-metadata.ts';
import { acceptedCommit, fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import type { CanonicalDocument, CommitAcceptedMutation, CommitRequest, Transport } from '@/integrations/runtime/generated.ts';
import type { EditCommand, MediaSelection, VerifiedMedia } from '@/integrations/runtime/timeline-commit-types.ts';
import { buildTimelineData } from '../../lib/timeline-data.ts';
import { compileTimelinePatch } from '../../lib/timeline-patch.ts';
import type { TimelinePatch } from '@/sdk/video/timeline/patch.ts';
import type { TimelineCommandBasis } from '../../data/DataProvider.ts';
import { createCommitOutbox } from '../commitOutbox.ts';
import { createTimelineCommandSession } from '../commitSession.ts';
import { captureClipMove, submitClipMove } from '../semanticGestures.ts';
import { authoringBundleFromDocument } from '../authoringBundle.ts';
import { ClipMoveError, executeClipMove } from '../clipMoveCapture.ts';
import { finishTrackLabel, type TrackLabelArgs } from '../trackLabelCapture.ts';
import { executeClipSetBatch } from '../clipScalarCapture.ts';
import { executeParentClipAddMedia } from '../parentClipAddCapture.ts';

const projectId = 'project-commit', timelineId = 'timeline-commit';
export const scope = { projectId, timelineId, realmId: 'realm-1', actorId: 'actor-1' };
const h0 = { revisionId: 'r0', publicationId: 'p0' };
type EnvironmentOptions = {
  validateCommitCommands?: (commands: readonly EditCommand[]) => void;
  recoverBootstrap?: (ownerId: string) => Promise<TimelineCommandBasis>;
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
export function document(at = 1, revision = 'r0'): CanonicalDocument {
  const raw = acceptedCommit({ revision_id: revision, publication_id: 'p0' }, { revision_id: 'initial', publication_id: 'initial' }).data.canonical_document;
  const clips = [{ id: 'x', track: 'V1', at, hold: 1, text: { content: 'keep' }, app: { opaque: null } }];
  raw.parent_revision.payload = { config: { output: { fps: 30, resolution: '1920x1080' },
    tracks: [{ id: 'V1', kind: 'visual' }], clips: structuredClone(clips), bundle: null },
  tracks: [{ id: 'V1', kind: 'visual' }], registry: { assets: {} }, clips, occurrences: [], opaque: { absent: null } };
  raw.parent_revision.content_digest = fixtureDigest(raw.parent_revision.payload);
  return raw;
}
function storage() {
  const held = new Set<string>();
  const factory = createFakeIndexedDB();
  const outbox = createCommitOutbox({ indexedDB: factory, exclusiveLock: async (key, work) => {
    if (held.has(key)) throw new Error('claimed');
    held.add(key);
    try { return await work(); } finally { held.delete(key); }
  } });
  return { outbox, factory };
}
export async function environment(initialDocument = document(), options: EnvironmentOptions = {}) {
  let serverDocument = structuredClone(initialDocument);
  let serverHead = h0;
  let fault: 'lost' | 'busy' | 'conflict' | 'unavailable' | 'refused' | 'validation' | 'authorization' | null = null;
  let pause: ReturnType<typeof deferred> | null = null;
  const calls: { path: string; method: string; body?: CommitRequest; bodyText?: string; key?: string }[] = [];
  const accepted = new Map<string, CommitAcceptedMutation>();
  const previousDocuments = new Map<string, CanonicalDocument>();
  const transport: Transport = async (method, path, headers, body) => {
    const request = body ? JSON.parse(new TextDecoder().decode(body)) as CommitRequest : undefined;
    const key = headers['Idempotency-Key'];
    calls.push({ path, method, body: request, bodyText: body ? new TextDecoder().decode(body) : undefined, key });
    const ok = (value: unknown) => ({ status: 200, headers: {}, body: bytes(value) });
    if (path === '/v1/health') return ok({ status: 'ok', protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, runtime_epoch: 1, runtime_instance_id: 'instance-session' });
    if (path === '/v1/handshake') return ok({ protocol: 'workspace.v1', schema_digest: RUNTIME_SCHEMA_DIGEST, actor_id: 'actor-1', realm_id: 'realm-1', scopes: ['handshake', 'projects:read', 'projects:write', 'objects:read', 'objects:write', 'tasks:read', 'tasks:write'], capabilities: ['execution_binding.targeted.v1'] });
    if (path === '/v1/realm') return ok({ realm_id: 'realm-1' });
    if (path.endsWith('/commits?limit=50')) return ok({ items: [], next_cursor: null, head: { revision_id: serverHead.revisionId, publication_id: serverHead.publicationId } });
    if (path.includes('/composition-revisions/')) return ok({ project_id: projectId, timeline_id: timelineId,
      ...serverDocument.parent_revision, dependency_manifest: serverDocument.dependency_manifest });
    if (path.includes('/shots/') && path.includes('/revisions/')) {
      const shot = serverDocument.shot_revisions.find((image) => path.endsWith(`/shots/${image.shot_id}/revisions/${image.revision_id}`));
      if (!shot) throw new Error(`Unpinned shot read ${path}`);
      return ok({ project_id: projectId, ...shot });
    }
    if (path.includes('/timelines/') && path.includes('/revisions/')) {
      const internal = serverDocument.internal_timeline_revisions.find((image) => path.endsWith(`/timelines/${image.timeline_id}/revisions/${image.revision_id}`));
      if (!internal) throw new Error(`Unpinned internal read ${path}`);
      return ok({ project_id: projectId, ...internal });
    }
    if (!path.endsWith('/commit') || !request || !key) throw new Error(`Unexpected HTTP ${method} ${path}`);
    options.validateCommitCommands?.(request.commands);
    if (pause) await pause.promise;
    if (fault === 'busy' || fault === 'conflict' || fault === 'unavailable') return {
      status: fault === 'unavailable' ? 503 : 409, headers: {}, body: bytes({
        code: fault === 'unavailable' ? 'not_ready' : 'conflict', message: fault,
        details: { status: fault === 'conflict' ? 'conflict' : 'refused', reason: fault === 'busy' ? 'head_busy' : fault },
      }),
    };
    if (fault === 'refused' || fault === 'validation' || fault === 'authorization') return {
      status: fault === 'refused' ? 409 : fault === 'validation' ? 422 : 403, headers: {},
      body: bytes({ code: fault, message: 'conflict in request',
        details: fault === 'refused' ? { status: 'refused' } : {} }),
    };
    let response = accepted.get(key);
    if (!response) {
      const next = `r${accepted.size + 1}`, publication = `p${accepted.size + 1}`;
      response = acceptedCommit({ revision_id: next, publication_id: publication },
        { revision_id: request.base_revision_id, publication_id: request.base_publication_id }, { commands: request.commands });
      response.data.previous_revision_id = serverHead.revisionId;
      response.data.previous_publication_id = serverHead.publicationId;
      const before = structuredClone(serverDocument);
      if (request.commands[0].op === 'clip.move' || request.commands[0].op === 'track.set' || request.commands[0].op === 'clip.set') {
        let result;
        try {
          const bundle = await authoringBundleFromDocument(serverDocument);
          result = request.commands[0].op === 'clip.move' ? executeClipMove(bundle, request.commands[0])
            : request.commands[0].op === 'clip.set' ? executeClipSetBatch(bundle, request.commands)
            : finishTrackLabel({ bundle, command: request.commands[0] }, request.commands[0].args as TrackLabelArgs);
        }
        catch (error) {
          if (!(error instanceof ClipMoveError) || !['capture_mismatch', 'identity_conflict'].includes(error.kind)) throw error;
          // Guard failures cross the HTTP boundary as typed conflicts, not uncertain transport errors.
          return { status: 409, headers: {}, body: bytes({ code: 'conflict', message: error.message,
            details: { status: 'conflict', reason: error.kind } }) };
        }
        const payload = { ...result.bundle.parent, occurrences: serverDocument.parent_revision.payload.occurrences };
        const revision = fixtureDigest(payload) === serverDocument.parent_revision.content_digest ? serverDocument.parent_revision.revision_id : next;
        serverDocument = { ...serverDocument, parent_revision: { revision_id: revision, content_digest: fixtureDigest(payload), payload } };
      } else if (request.commands[0].op === 'clip.add-media') {
        const command = request.commands[0] as EditCommand;
        const selection = command.args.media as MediaSelection;
        const verified: VerifiedMedia = { selection, media_type: 'video/mp4', size: 1, duration_seconds: 1 };
        const bundle = await authoringBundleFromDocument(serverDocument);
        const result = executeParentClipAddMedia(bundle, command, [verified]);
        const payload = { ...result.bundle.parent, occurrences: serverDocument.parent_revision.payload.occurrences };
        const revision = fixtureDigest(payload) === serverDocument.parent_revision.content_digest ? serverDocument.parent_revision.revision_id : next;
        serverDocument = { ...serverDocument, parent_revision: { revision_id: revision, content_digest: fixtureDigest(payload), payload } };
      } else if (request.commands[0].op === 'timeline.inverse') {
        const publications = request.commands[0].args.publications as string[];
        const restored = structuredClone(previousDocuments.get(publications[0])!);
        restored.parent_revision.revision_id = next;
        serverDocument = restored;
      } else throw new Error(`Unsupported test command ${request.commands[0].op}`);
      previousDocuments.set(publication, before);
      response.data.accepted_revision_id = serverDocument.parent_revision.revision_id;
      response.data.canonical_document = serverDocument;
      response.data.document_digest = fixtureDigest(serverDocument);
      response.receipt.result = response.data;
      response.receipt.idempotency_key = key;
      accepted.set(key, response);
      serverHead = { revisionId: serverDocument.parent_revision.revision_id, publicationId: publication };
    }
    if (fault === 'lost') { fault = null; throw new Error('lost acknowledgement'); }
    return ok(response);
  };
  const provider = new RuntimeDataProvider({ projectId, baseUrl: `http://session-${crypto.randomUUID()}.test`, token: 'token', transport });
  const initial = await provider.loadTimelineCommandBasis(timelineId);
  let current = await buildTimelineData(serverDocument.parent_revision.payload.config as never, serverDocument.parent_revision.payload.registry as never, undefined, 1, undefined,
    { projectId, timelineId, headRevisionId: 'r0', headPublicationId: 'p0' });
  const projected: TimelineCommandBasis[] = [];
  const applyPreview = (patch: TimelinePatch) => {
    const compiled = compileTimelinePatch(patch, current);
    if (!compiled.valid || !compiled.nextData) throw new Error('Move preview is unavailable');
    current = compiled.nextData;
  };
  const previews = vi.fn(applyPreview);
  const { outbox: outboxes, factory } = storage();
  const project = vi.fn(async (basis: TimelineCommandBasis, patches: TimelinePatch[]) => {
    projected.push(basis);
    const parent = basis.canonicalDocument.parent_revision.payload;
    current = await buildTimelineData({ ...parent.config as object, clips: parent.clips } as never, { assets: {} }, undefined,
      1, undefined, { projectId, timelineId, headRevisionId: basis.head.revisionId, headPublicationId: basis.head.publicationId });
    for (const patch of patches) applyPreview(patch);
  });
  const mount = (basis = initial) => createTimelineCommandSession({ initial: basis, scope, outboxes,
    loadLatest: () => provider.loadTimelineCommandBasis(timelineId),
    send: (request, key) => provider.commitTimeline(request, key), preview: previews,
    project, changed: () => {}, recoverBootstrap: options.recoverBootstrap,
  });
  const move = (session: Awaited<ReturnType<typeof mount>>, on: number) => submitClipMove(captureClipMove(session.port, current, 'x'), on);
  return { provider, transport, initial, outboxes, factory, current: () => current, calls, projected, project, mount, move, previews,
    setFault: (value: typeof fault) => { fault = value; },
    pause: () => { pause = deferred(); return pause; },
    external: async (change: (document: CanonicalDocument) => void) => {
      change(serverDocument);
      serverDocument.parent_revision.revision_id = `external-${serverHead.revisionId}`;
      serverDocument.parent_revision.content_digest = fixtureDigest(serverDocument.parent_revision.payload);
      serverHead = { revisionId: serverDocument.parent_revision.revision_id, publicationId: `external-${serverHead.publicationId}` };
      return provider.loadTimelineCommandBasis(timelineId);
    },
    commits: () => calls.filter((call) => call.path.endsWith('/commit')) };
}

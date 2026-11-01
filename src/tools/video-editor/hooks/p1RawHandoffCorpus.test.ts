// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from 'fake-indexeddb';
import type { CanonicalDocument } from '@/integrations/runtime/timeline-commit-types.ts';
import corpus from '../../../../tests/fixtures/p1-feasibility/cases.json';
import appLabel from '../commands/fixtures/recipe_m2_app_track_label.json';
import appTrim from '../commands/fixtures/recipe_m2_clip_trim.json';
import { authoringBundleFromDocument } from '../commands/authoringBundle.ts';
import { createCommitOutbox, toOutboxJson } from '../commands/commitOutbox.ts';
import { createLocalSaveSession } from '../commands/localSaveSession.ts';
import { withDefaultTimelineOutput } from '../lib/defaults.ts';
import { canonicalizeTimelinePair } from '../lib/timeline-domain.ts';
import type { AssetRegistry, TimelineConfig } from '../types/index.ts';
import { createTimelineLocalSaveHandoff, type TimelineSaveSource } from './timelineLocalSaveHandoff.ts';

type JsonObject = Record<string, unknown>;
type CorpusCase = (typeof corpus.cases)[number];

const labelBefore = appLabel.bundle.source_mapping._runtime_document as unknown as CanonicalDocument;
const labelAfter = structuredClone(labelBefore);
Object.assign(labelAfter.parent_revision.payload, appLabel.after_bundle.parent);

const corpusCase = (id: string): CorpusCase => {
  const entry = corpus.cases.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Missing P1 corpus case ${id}`);
  return entry;
};

/** Keep the original parent payload while removing its dependent closure. */
function parentOnly(input: CanonicalDocument): CanonicalDocument {
  const document = structuredClone(input);
  const payload = document.parent_revision.payload as JsonObject;
  payload.occurrences = [];
  document.shot_revisions = [];
  document.internal_timeline_revisions = [];
  document.dependency_manifest.shots = [];
  document.dependency_manifest.internal_timelines = [];
  return document;
}

async function sourceFor(document: CanonicalDocument, head: TimelineSaveSource['head'], preserveRaw = false): Promise<TimelineSaveSource> {
  const bundle = await authoringBundleFromDocument(document);
  const parentConfig = bundle.parent.config as unknown as TimelineConfig;
  const parentRegistry = bundle.parent.registry as unknown as AssetRegistry;
  const loaded = { ...parentConfig, ...withDefaultTimelineOutput(parentConfig) };
  const projected = canonicalizeTimelinePair(loaded, parentRegistry);
  if (preserveRaw) return { config: loaded, registry: projected.registry, head };
  return { config: projected.config, registry: projected.registry, head };
}

async function captureFixture(before: CanonicalDocument, after: CanonicalDocument, expectedChanges: readonly unknown[], preserveRaw = false) {
  const head = { projectId: before.project_id, timelineId: before.timeline_id,
    headRevisionId: before.parent_revision.revision_id, headPublicationId: 'publication-p1' };
  const initial = { head: { revisionId: head.headRevisionId, publicationId: head.headPublicationId }, canonicalDocument: before };
  const scope = { realmId: 'realm-p1', actorId: 'actor-p1', projectId: head.projectId, timelineId: head.timelineId };
  const outboxes = createCommitOutbox({ indexedDB: createFakeIndexedDB(), exclusiveLock: async (_key, work) => work() });
  const send = vi.fn();
  const session = await createLocalSaveSession({ scope, initial, document: toOutboxJson(before), outboxes, send,
    loadLatest: vi.fn(async () => initial), changed: vi.fn(),
    prepareDisplay: vi.fn(async () => { throw new Error('No canonical acceptance expected in this proof slice'); }) });
  const source = await sourceFor(before, head, preserveRaw);
  const next = await sourceFor(after, head, preserveRaw);
  const handoff = createTimelineLocalSaveHandoff({ initial, source, session, adopted: vi.fn() });

  await handoff.capture(next);

  const [owner] = await outboxes.list(scope);
  expect(owner.intents).toHaveLength(1);
  expect(owner.intents[0].payload).toMatchObject({ kind: 'local-save', label: 'Edit timeline',
    documentIntent: { basis: { head: initial.head }, created: [], changes: expectedChanges } });
  const local = session.getDocument() as unknown as CanonicalDocument;
  const expected = structuredClone(after);
  expected.parent_revision.revision_id = before.parent_revision.revision_id;
  expected.parent_revision.content_digest = before.parent_revision.content_digest;
  expect(local).toEqual(expected);
  expect({ projectId: local.project_id, timelineId: local.timeline_id,
    revisionId: local.parent_revision.revision_id, contentDigest: local.parent_revision.content_digest })
    .toEqual({ projectId: before.project_id, timelineId: before.timeline_id,
      revisionId: before.parent_revision.revision_id, contentDigest: before.parent_revision.content_digest });
  expect(send).not.toHaveBeenCalled();
  await session.dispose();
}

const realParentCases = [
  {
    id: 'app-native-trim-real-document',
    before: parentOnly(appTrim.input as unknown as CanonicalDocument),
    after: parentOnly(appTrim.output as unknown as CanonicalDocument),
    expectedChanges: [
      { op: 'set', ref: 'parent', path: ['clips', 'id:clip-a', 'hold'], before: { state: 'present', value: 17 }, value: 4 },
      { op: 'remove', ref: 'parent', path: ['clips', 'id:clip-a', 'app', 'astrid', 'for'], before: { state: 'present', value: 19 } },
      { op: 'remove', ref: 'parent', path: ['clips', 'id:clip-a', 'app', 'astrid', 'until'], before: { state: 'present', value: null } },
      { op: 'set', ref: 'parent', path: ['clips', 'id:clip-a', 'from'], before: { state: 'present', value: 2 }, value: 1 },
      { op: 'set', ref: 'parent', path: ['clips', 'id:clip-a', 'to'], before: { state: 'present', value: 6 }, value: 5 },
    ],
  },
  {
    id: 'app-track-label-real-document',
    before: labelBefore,
    after: labelAfter,
    expectedChanges: [
      { op: 'set', ref: 'parent', path: ['config', 'tracks', 'id:picture', 'label'], before: { state: 'absent' }, value: 'Picture é 🎬' },
    ],
  },
] as const;

describe('P1 real parent-document handoff corpus', () => {
  it.each(realParentCases)('captures the complete authored delta for $id through the real handoff/session chain', async (fixture) => {
    const entry = corpusCase(fixture.id);
    expect(entry.kind).toBe('app-command-fixture');
    expect(fixture.before.parent_revision.payload).toBeTruthy();
    expect(fixture.after.parent_revision.payload).toBeTruthy();
    await captureFixture(fixture.before, fixture.after, fixture.expectedChanges, fixture.id === 'app-track-label-real-document');
  });

  it('keeps fixture-authored opaque, null, absent, and raw sibling values unchanged', () => {
    const before = parentOnly(appTrim.input as unknown as CanonicalDocument);
    const after = parentOnly(appTrim.output as unknown as CanonicalDocument);
    const beforePayload = before.parent_revision.payload as JsonObject;
    const afterPayload = after.parent_revision.payload as JsonObject;
    const beforeClip = (beforePayload.config.clips as JsonObject[])[0];
    const afterClip = (afterPayload.config.clips as JsonObject[])[0];

    expect(afterClip.app).toEqual({ astrid: { opaque: [null, false] }, 'org.example': { literal: 'clip-a', clear: null } });
    expect(afterClip).not.toHaveProperty('app.astrid.for');
    expect(afterClip).not.toHaveProperty('app.astrid.until');
    expect(afterClip.speed).toBe(beforeClip.speed);
    expect(afterPayload.config.output).toEqual(beforePayload.config.output);
    expect(afterPayload.config.opaque).toEqual(beforePayload.config.opaque);
    expect(afterPayload.registry).toEqual(beforePayload.registry);
    expect((afterPayload.config.clips as JsonObject[])[1]).toEqual((beforePayload.config.clips as JsonObject[])[1]);
    expect((afterPayload.clips as JsonObject[])[1]).toEqual((beforePayload.clips as JsonObject[])[1]);
  });
});

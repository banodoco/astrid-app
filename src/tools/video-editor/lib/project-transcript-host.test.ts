import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import identityFixtures from "../data/typed/projectTranscript.identity-fixtures.json";
import {
  createProjectTranscriptHost,
  type ProjectTranscriptHost,
} from "./project-transcript-host.ts";
import { buildTimelineData } from "./timeline-data.ts";
import { buildDataFromSnapshot } from "./timeline-save-utils.ts";
import { createDataKindItemsHost } from '@/tools/video-editor/data-kinds/dataKindItems.ts';
import { createTranscriptPanelAdapter } from './transcript-panel-adapter.ts';
import {
  normalizeTranscriptSource,
  TRANSCRIPT_SCHEMA_REF,
} from "../data/typed/adaptTranscript.ts";
import {
  computeHostFingerprint,
  HOST_GENERATION_PROVENANCE_VERSION,
} from "@/sdk/video/timeline/sourceMap.ts";
import { parseTimelineBundle } from "../data/typed/timelineBundle.ts";
import {
  transcriptDocumentId,
  parseProjectTranscriptDocument,
  persistedTranscriptItems,
  type ProjectTranscriptDocument,
  type ProjectTranscriptRepository,
  type ProjectTranscriptContent,
} from "../data/typed/projectTranscript.ts";
import type { TimelineConfig } from "../types/index.ts";
const media = "sha256:" + "a".repeat(64);
const hosts: ProjectTranscriptHost[] = [];
const config: TimelineConfig = {
  output: { resolution: "1920x1080", fps: 30, file: "out.mp4" },
  tracks: [],
  clips: [{ id: "c", asset: "alias", track: "t", at: 0, from: 0, to: 10 }],
};
const handoff = {
  segments: [
    {
      id: "segment-one",
      start: 1,
      end: 4,
      text: "hello world",
      speaker: "Speaker",
      words: [
        { id: "w-one", start: 1, end: 2, text: "hello" },
        { id: "w-two", start: 2, end: 4, word: "world" },
      ],
    },
  ],
};
function repository() {
  const documents = new Map<string, ProjectTranscriptDocument>();
  const r: ProjectTranscriptRepository = {
    projectId: "p",
    listAll: vi.fn(async () => [...documents.values()]),
    listForMedia: vi.fn(async (id) =>
      [...documents.values()].filter((d) => d.content.media_id === id),
    ),
    get: vi.fn(async (id) => {
      const d = documents.get(id);
      if (!d) throw Object.assign(new Error("Missing"), { status: 404 });
      return structuredClone(d);
    }),
    create: vi.fn(async (content) => {
      const id = await transcriptDocumentId(
        "p",
        content.media_id,
        content.source_id,
      );
      if (documents.has(id))
        throw Object.assign(new Error("Already exists"), { status: 409 });
      const d: ProjectTranscriptDocument = {
        document_id: id,
        project_id: "p",
        kind: "media.transcript",
        content: structuredClone(content),
        version: 1,
        created_at: "now",
        updated_at: "now",
      };
      documents.set(id, d);
      return structuredClone(d);
    }),
    update: vi.fn(async (id, content, version) => {
      const d = documents.get(id)!;
      if (d.version !== version)
        throw Object.assign(new Error("Stale document version"), {
          status: 409,
        });
      const next = {
        ...d,
        content: structuredClone(content),
        version: version + 1,
      };
      documents.set(id, next);
      return structuredClone(next);
    }),
  };
  return { r, documents };
}
async function editor(
  r?: ProjectTranscriptRepository,
  alias = "alias",
  flush = vi.fn(async () => undefined),
  withItemChannels = false,
) {
  const cfg = {
    ...config,
    clips: config.clips.map((c) => ({ ...c, asset: alias })),
  };
  const dataRef = {
    current: await buildTimelineData(
      cfg,
      {
        assets: {
          [alias]: { media_id: media, file: "video.mp4", type: "video/mp4" },
        },
      },
      (f) => f,
      7,
      undefined,
      { projectId: "p", timelineId: alias, headRevisionId: "head-1" },
    ),
  };
  const commitData = vi.fn((next) => {
    dataRef.current = next;
  });
  const items = withItemChannels ? createDataKindItemsHost({ dataRef, commitData }) : undefined;
  const host = createProjectTranscriptHost({
    repository: r,
    dataRef,
    commitData,
    items,
    flushPendingSave: flush,
  });
  hosts.push(host);
  return { host, dataRef, commitData, flush, items };
}
const docId = (receipt: { documentId?: string }) => receipt.documentId!;
const edit = (text: string) => ({
  type: "word" as const,
  sourceItemId: "segment-one",
  wordId: "w-one",
  text,
});
const transcriptExtensionId = "haus.astrid.transcript-lane";
const transcriptContributionId = "transcript-caption-foundry";
const transcriptCaptionTrack = "transcript-caption-foundry-track";
const legacyTranscriptId =
  "transcript-source:reviewed:segment:segment-one";
const canonicalTranscriptId =
  "transcript-source:alias:source:reviewed:segment:segment-one";
const transcriptWord = (id: string, text: string) => ({
  id: `${id}:word:w-one`,
  start: 1,
  end: 2,
  text,
});
const legacyTranscriptItem = () => {
  const item = normalizeTranscriptSource({
    assetId: "alias",
    sourceId: "reviewed",
    segments: [{
      id: "segment-one",
      start: 1,
      end: 4,
      text: "hello world",
      speaker: null,
      words: [{ id: "w-one", start: 1, end: 2, text: "hello" }],
    }],
  })[0];
  return {
    ...item,
    id: legacyTranscriptId,
    payload: {
      ...item.payload,
      segmentId: legacyTranscriptId,
      words: [transcriptWord(legacyTranscriptId, "hello")],
    },
  };
};
const canonicalTranscript = {
  sourceId: "reviewed",
  segments: [
    {
      id: canonicalTranscriptId,
      start: 1,
      end: 4,
      text: "hello world",
      speaker: null,
      words: [transcriptWord(canonicalTranscriptId, "hello")],
    },
    { id: "second-segment", start: 4, end: 5, text: "next" },
  ],
};
function generatedTranscriptConfig(
  data: Awaited<ReturnType<typeof editor>>["dataRef"]["current"],
  options: { collision?: boolean } = {},
) {
  const oldCaptionId = `transcript-caption-${computeHostFingerprint(
    `${legacyTranscriptId}@c`,
  ).split(":")[1]}`;
  const newCaptionId = `transcript-caption-${computeHostFingerprint(
    `${canonicalTranscriptId}@c`,
  ).split(":")[1]}`;
  const caption = {
    id: oldCaptionId,
    track: transcriptCaptionTrack,
    clipType: "text" as const,
    at: 0,
    hold: 2,
    text: { content: "Human correction" },
    app: {
      __generated__: {
        extensionId: transcriptExtensionId,
        contributionId: transcriptContributionId,
        provenance: {
          contractVersion: HOST_GENERATION_PROVENANCE_VERSION,
          sourceSchemaRef: TRANSCRIPT_SCHEMA_REF,
          sourceItemId: legacyTranscriptId,
          sourceFingerprint: "keep-source-fingerprint",
          generatorVersion: "1.3.0",
          outputFingerprint: "keep-output-fingerprint",
          conflictPolicy: "preserve-output" as const,
        },
      },
    },
  };
  const reviewKey = `transcript-source-review:${encodeURIComponent(
    legacyTranscriptId,
  )}`;
  return {
    oldCaptionId,
    newCaptionId,
    config: {
      ...data.config,
      clips: [
        ...data.config.clips,
        caption,
        ...(options.collision
          ? [{ id: newCaptionId, track: "other", clipType: "text" as const }]
          : []),
      ],
      app: {
        ...data.config.app,
        [transcriptExtensionId]: {
          ...(data.config.app?.[transcriptExtensionId] ?? {}),
          [reviewKey]: {
            schemaVersion: 1,
            sourceSchemaRef: TRANSCRIPT_SCHEMA_REF,
            sourceItemId: legacyTranscriptId,
            status: "accepted-for-source-update",
            proposedText: "Human correction",
            opaque: { keep: [null, false] },
          },
          unrelated: { keep: true },
        },
      },
    },
    reviewKey,
  };
}
beforeEach(() => localStorage.clear());
afterEach(() => {
  hosts.splice(0).forEach((h) => h.dispose());
});
describe("canonical project transcript consistency", () => {
  it('uses the memory-only item channel for document projections', async () => {
    const { r } = repository();
    const { host, dataRef, commitData, items } = await editor(r, 'alias', vi.fn(async () => undefined), true);
    await host.importTranscript({ document: handoff, associationAssetId: 'alias' });
    expect(items?.readTransient(TRANSCRIPT_SCHEMA_REF)).toHaveLength(1);
    expect(dataRef.current.sourceItemsBySchemaRef?.[TRANSCRIPT_SCHEMA_REF] ?? []).toHaveLength(0);
    expect(commitData).toHaveBeenCalledTimes(1);
    expect(commitData.mock.calls[0][1]).toMatchObject({ save: true, semantic: true });
    const result = await host.editText(edit('corrected'));
    expect(result.ok).toBe(true);
    expect((items?.readTransient(TRANSCRIPT_SCHEMA_REF)[0].payload as { words: { text: string }[] }).words[0].text).toBe('corrected');
    expect(commitData).toHaveBeenCalledTimes(1);
  });
  it("consumes the shared Python/TypeScript identity fixtures including Unicode", async () => {
    const fixture = identityFixtures;
    for (const c of fixture.cases)
      expect(
        await transcriptDocumentId(c.projectId, c.mediaId, c.sourceId),
      ).toBe(c.documentId);
  });
  it("imports rich native items once, saves only a versioned reference, and reuses them under another timeline alias", async () => {
    const { r, documents } = repository(),
      a = await editor(r),
      receipt = await a.host.importTranscript({
        document: handoff,
        associationAssetId: "alias",
      });
    expect(receipt).toMatchObject({
      associationSaved: true,
      version: 1,
      sourceId: "default",
    });
    expect(documents.size).toBe(1);
    const d = documents.get(docId(receipt))!;
    expect(d.content.segments[0]).toMatchObject({
      id: "segment-one",
      speaker: "Speaker",
      words: [
        { id: "w-one", text: "hello" },
        { id: "w-two", text: "world" },
      ],
    });
    expect(a.dataRef.current.transcriptReferences).toEqual({
      schema: "media.transcript.references/v1",
      associations: [{ assetId: "alias", documentId: d.document_id }],
    });
    expect(
      persistedTranscriptItems(a.dataRef.current.sourceItemsBySchemaRef!)[
        TRANSCRIPT_SCHEMA_REF
      ],
    ).toEqual([]);
    const b = await editor(r, "other-local-key");
    expect(await b.host.listProjectSources("other-local-key")).toEqual([
      { documentId: d.document_id, sourceId: "default", version: 1 },
    ]);
    await b.host.selectProjectSource({
      assetId: "other-local-key",
      documentId: d.document_id,
    });
    const row =
      b.dataRef.current.sourceItemsBySchemaRef![TRANSCRIPT_SCHEMA_REF][0];
    expect(row.id).toBe("segment-one");
    expect(row.sourceArtifactRef.assetId).toBe("other-local-key");
    expect((row.payload as any).words[0].id).toBe("w-one");
    expect(r.create).toHaveBeenCalledTimes(1);
  });

  it("rejects an explicit source media pin mismatch before changing the project or timeline", async () => {
    const { r, documents } = repository();
    const a = await editor(r);
    const before = structuredClone(a.dataRef.current);
    const mismatched = {
      ...handoff,
      mediaId: "sha256:" + "b".repeat(64),
    };

    await expect(
      a.host.importTranscript({
        document: mismatched,
        associationAssetId: "alias",
      }),
    ).rejects.toThrow("does not match");
    expect(documents.size).toBe(0);
    expect(a.dataRef.current).toEqual(before);
    expect(JSON.parse(JSON.stringify(a.dataRef.current))).toEqual(
      JSON.parse(JSON.stringify(before)),
    );
  });

  it("reconciles canonical IDs through the host and refuses a caption collision without losing review data", async () => {
    const { r, documents } = repository();
    const a = await editor(r);
    const fixture = generatedTranscriptConfig(a.dataRef.current, {
      collision: true,
    });
    const legacy = legacyTranscriptItem();
    const submitted = structuredClone(canonicalTranscript);
    a.dataRef.current = {
      ...a.dataRef.current,
      config: fixture.config,
      sourceItemsBySchemaRef: { [TRANSCRIPT_SCHEMA_REF]: [legacy] },
    };
    const before = structuredClone(a.dataRef.current);

    const receipt = await a.host.importTranscript({
      document: canonicalTranscript,
      associationAssetId: "alias",
    });
    const next = a.dataRef.current;
    const items = next.sourceItemsBySchemaRef![TRANSCRIPT_SCHEMA_REF];
    const extension = next.config.app![transcriptExtensionId] as Record<
      string,
      unknown
    >;

    expect(documents.get(docId(receipt))!.content.segments.map((s) => s.id)).toEqual([
      canonicalTranscriptId,
      "second-segment",
    ]);
    expect(items.map((item) => item.id)).toEqual([
      canonicalTranscriptId,
      "second-segment",
    ]);
    expect(items[0].payload).toMatchObject({ speaker: null });
    expect(items[1].payload).not.toHaveProperty("speaker");
    expect(next.config.clips.map((clip) => clip.id)).toEqual(
      before.config.clips.map((clip) => clip.id),
    );
    expect(next.config.app![transcriptExtensionId]).toMatchObject({
      [`transcript-source-review:${encodeURIComponent(canonicalTranscriptId)}`]: {
        sourceItemId: canonicalTranscriptId,
        opaque: { keep: [null, false] },
      },
      unrelated: { keep: true },
    });
    expect(extension[fixture.reviewKey]).toBeUndefined();
    expect(canonicalTranscript).toEqual(submitted);

    const replay = parseTimelineBundle({
      schema_version: 1,
      itemsBySchemaRef: persistedTranscriptItems(next.sourceItemsBySchemaRef!),
      transcriptReferences: next.transcriptReferences,
    });
    const reopened = await editor(r, "alias");
    reopened.dataRef.current = await buildTimelineData(
      next.config,
      next.registry,
      (f) => f,
      next.configVersion,
      replay.itemsBySchemaRef,
      next.head,
      replay.transcriptReferences,
    );
    await reopened.host.selectProjectSource({
      assetId: "alias",
      documentId: docId(receipt),
    });
    expect(
      reopened.dataRef.current.sourceItemsBySchemaRef![TRANSCRIPT_SCHEMA_REF].map(
        (item) => item.id,
      ),
    ).toEqual([canonicalTranscriptId, "second-segment"]);
    expect(reopened.dataRef.current.config.app![transcriptExtensionId]).toEqual(
      next.config.app![transcriptExtensionId],
    );
  });

  it("refuses to move a shared review owner while preserving source order and opaque fields", async () => {
    const { r, documents } = repository();
    const a = await editor(r);
    const fixture = generatedTranscriptConfig(a.dataRef.current);
    const legacy = legacyTranscriptItem();
    const submitted = structuredClone(canonicalTranscript);
    const shared = {
      ...legacy,
      sourceArtifactRef: { assetId: "other" },
      payload: { ...legacy.payload, opaque: { keep: [null, false, 0] } },
    };
    a.dataRef.current = {
      ...a.dataRef.current,
      config: fixture.config,
      sourceItemsBySchemaRef: {
        [TRANSCRIPT_SCHEMA_REF]: [shared, legacy],
      },
    };

    const receipt = await a.host.importTranscript({
      document: canonicalTranscript,
      associationAssetId: "alias",
    });
    const next = a.dataRef.current;
    const items = next.sourceItemsBySchemaRef![TRANSCRIPT_SCHEMA_REF];
    const extension = next.config.app![transcriptExtensionId] as Record<
      string,
      unknown
    >;

    expect(documents.get(docId(receipt))!.content.segments.map((s) => s.id)).toEqual([
      canonicalTranscriptId,
      "second-segment",
    ]);
    expect(items.map((item) => item.id)).toEqual([
      legacyTranscriptId,
      canonicalTranscriptId,
      "second-segment",
    ]);
    expect(items[0]).toMatchObject({
      sourceArtifactRef: { assetId: "other" },
      payload: { opaque: { keep: [null, false, 0] } },
    });
    expect(next.config.clips.map((clip) => clip.id)).toContain(
      fixture.newCaptionId,
    );
    expect(next.config.app![transcriptExtensionId]).toMatchObject({
      [fixture.reviewKey]: { sourceItemId: legacyTranscriptId },
    });
    expect(extension[fixture.reviewKey]).toBeDefined();
    expect(canonicalTranscript).toEqual(submitted);

    const replay = parseTimelineBundle({
      schema_version: 1,
      itemsBySchemaRef: persistedTranscriptItems(next.sourceItemsBySchemaRef!),
      transcriptReferences: next.transcriptReferences,
    });
    const reopened = await editor(r, "alias");
    reopened.dataRef.current = await buildTimelineData(
      next.config,
      next.registry,
      (f) => f,
      next.configVersion,
      replay.itemsBySchemaRef,
      next.head,
      replay.transcriptReferences,
    );
    await reopened.host.selectProjectSource({
      assetId: "alias",
      documentId: docId(receipt),
    });
    expect(
      reopened.dataRef.current.sourceItemsBySchemaRef![TRANSCRIPT_SCHEMA_REF].map(
        (item) => item.id,
      ),
    ).toEqual([
      legacyTranscriptId,
      canonicalTranscriptId,
      "second-segment",
    ]);
    expect(reopened.dataRef.current.config.app![transcriptExtensionId]).toEqual(
      next.config.app![transcriptExtensionId],
    );
  });

  it("keeps the production association planes replayable and distinguishes null from absent source fields", async () => {
    const { r, documents } = repository();
    const a = await editor(r);
    const before = structuredClone(a.dataRef.current);
    a.dataRef.current = {
      ...a.dataRef.current,
      config: {
        ...a.dataRef.current.config,
        clips: a.dataRef.current.config.clips.map((clip) => ({
          ...clip,
          app: { opaque: { keep: [null, false, 0] } },
        })),
      },
    };
    const imported = {
      sourceId: "reviewed",
      segments: [
        {
          id: "with-null-speaker",
          start: 1,
          end: 4,
          text: "hello world",
          speaker: null,
          words: [{ id: "w-one", start: 1, end: 2, text: "hello" }],
        },
        { id: "without-speaker", start: 4, end: 5, text: "next" },
      ],
    };
    const receipt = await a.host.importTranscript({
      document: imported,
      associationAssetId: "alias",
    });
    const document = documents.get(docId(receipt))!;
    const next = a.dataRef.current;
    const items = next.sourceItemsBySchemaRef![TRANSCRIPT_SCHEMA_REF];

    expect(document.content.segments).toEqual([
      {
        id: "with-null-speaker",
        start: 1,
        end: 4,
        text: "hello world",
        speaker: null,
        words: [{ id: "w-one", start: 1, end: 2, text: "hello" }],
      },
      { id: "without-speaker", start: 4, end: 5, text: "next" },
    ]);
    expect(items.map((item) => item.id)).toEqual([
      "with-null-speaker",
      "without-speaker",
    ]);
    expect(items[0].payload).toMatchObject({ speaker: null });
    expect(items[1].payload).not.toHaveProperty("speaker");
    expect(next.config.clips[0]).toMatchObject({
      app: { opaque: { keep: [null, false, 0] } },
    });
    expect(next.head).toEqual(before.head);
    expect(next.registry).toEqual(before.registry);
    expect(before.sourceItemsBySchemaRef).toBeUndefined();

    const replay = parseTimelineBundle({
      schema_version: 1,
      itemsBySchemaRef: persistedTranscriptItems(next.sourceItemsBySchemaRef!),
      transcriptReferences: next.transcriptReferences,
    });
    const reopened = await editor(r, "alias");
    reopened.dataRef.current = await buildTimelineData(
      reopened.dataRef.current.config,
      reopened.dataRef.current.registry,
      (f) => f,
      reopened.dataRef.current.configVersion,
      replay.itemsBySchemaRef,
      next.head,
      replay.transcriptReferences,
    );
    await reopened.host.selectProjectSource({
      assetId: "alias",
      documentId: document.document_id,
    });
    expect(
      reopened.dataRef.current.sourceItemsBySchemaRef![TRANSCRIPT_SCHEMA_REF].map(
        (item) => item.id,
      ),
    ).toEqual(["with-null-speaker", "without-speaker"]);
  });

  it("uses the loaded document version as the production replacement guard", async () => {
    const { r, documents } = repository();
    const a = await editor(r);
    const first = await a.host.importTranscript({
      document: handoff,
      associationAssetId: "alias",
    });
    const id = docId(first);
    const replacement = {
      ...handoff,
      segments: [{ ...handoff.segments[0], text: "replacement" }],
    };

    await a.host.importTranscript({
      document: replacement,
      associationAssetId: "alias",
    });

    expect(r.update).toHaveBeenCalledWith(
      id,
      expect.objectContaining({
        segments: [expect.objectContaining({ text: "replacement" })],
      }),
      1,
      expect.any(String),
    );
    expect(documents.get(id)!.version).toBe(2);
    expect(
      a.dataRef.current.sourceItemsBySchemaRef![TRANSCRIPT_SCHEMA_REF][0].payload,
    ).toMatchObject({ text: "replacement" });
  });
  it('looks up media inside a played shot through the supplied registry', async () => {
    const { r } = repository();
    const document = await r.create({
      schema: 'media.transcript/v1',
      media_id: media,
      source_id: 'astrid.narration',
      segments: [{ id: 'shot-segment', start: 0, end: 1, text: 'shot narration' }],
    }, 'shot-narration');
    const { host } = await editor(r);

    expect(await host.listProjectSources('shot-only', {
      assets: { 'shot-only': { media_id: media, file: 'shot.wav', type: 'audio/wav' } },
    })).toEqual([{ documentId: document.document_id, sourceId: 'astrid.narration', version: 1 }]);
    expect(r.listAll).toHaveBeenCalledOnce();
  });

  it('shares one kind listing across concurrent media choices and coalesces fallback projection', async () => {
    const { r } = repository();
    const otherMedia = 'sha256:' + 'b'.repeat(64);
    const first = await r.create({
      schema: 'media.transcript/v1', media_id: media, source_id: 'astrid.narration',
      segments: [{ id: 'first', start: 0, end: 1, text: 'first line' }],
    }, 'first');
    const second = await r.create({
      schema: 'media.transcript/v1', media_id: otherMedia, source_id: 'astrid.narration',
      segments: [{ id: 'second', start: 0, end: 1, text: 'second line' }],
    }, 'second');
    const { host, items } = await editor(r, 'alias', vi.fn(async () => undefined), true);
    const notify = vi.fn();
    host.subscribe(notify);
    const choices = await Promise.all([
      host.listProjectSources('alias'),
      host.listProjectSources('shot-only', { assets: {
        'shot-only': { media_id: otherMedia, file: 'shot.wav', type: 'audio/wav' },
      } }),
    ]);
    expect(choices).toEqual([
      [{ documentId: first.document_id, sourceId: 'astrid.narration', version: 1 }],
      [{ documentId: second.document_id, sourceId: 'astrid.narration', version: 1 }],
    ]);
    expect(r.listAll).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(items?.readTransient(TRANSCRIPT_SCHEMA_REF)).toHaveLength(2);
    await host.listProjectSources('alias');
    expect(r.listAll).toHaveBeenCalledOnce();
    await host.refreshSources();
    await host.listProjectSources('alias');
    expect(r.listAll).toHaveBeenCalledTimes(2);
    await host.importTranscript({ document: handoff, associationAssetId: 'alias' });
    await host.listProjectSources('alias');
    expect(r.listAll).toHaveBeenCalledTimes(3);
    expect((await host.editText(edit('changed'))).ok).toBe(true);
    await host.listProjectSources('alias');
    expect(r.listAll).toHaveBeenCalledTimes(4);
  });

  it('invalidates the kind snapshot when the document surface reports a write', async () => {
    const { r } = repository();
    let changed = () => {};
    r.onChange = (listener) => { changed = listener; return () => {}; };
    const { host } = await editor(r);
    host.start();
    await host.listProjectSources('alias');
    await host.listProjectSources('alias');
    expect(r.listAll).toHaveBeenCalledOnce();
    changed();
    await host.listProjectSources('alias');
    expect(r.listAll).toHaveBeenCalledTimes(2);
  });

  it("projects an unassociated narration transcript as a read-only default", async () => {
    const { r } = repository();
    const narration = await r.create(
      {
        schema: "media.transcript/v1",
        media_id: media,
        source_id: "astrid.narration",
        segments: [{ id: "narration-segment", start: 1, end: 2, text: "spoken words", words: [{ id: "narration-word", start: 1, end: 2, text: "spoken" }] }],
      },
      "narration",
    );
    await r.create(
      {
        schema: "media.transcript/v1",
        media_id: media,
        source_id: "other-source",
        segments: [{ id: "other-segment", start: 1, end: 2, text: "other words" }],
      },
      "other",
    );
    const a = await editor(r);

    expect(await a.host.listProjectSources("alias")).toHaveLength(2);
    expect(a.dataRef.current.transcriptReferences).toBeUndefined();
    expect(a.dataRef.current.sourceItemsBySchemaRef?.[TRANSCRIPT_SCHEMA_REF]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "narration-segment",
          sourceArtifactRef: { assetId: "alias" },
          payload: expect.objectContaining({
            sourceId: "astrid.narration",
            documentId: narration.document_id,
            text: "spoken words",
            words: [expect.objectContaining({ text: "spoken" })],
          }),
        }),
      ]),
    );
    expect(a.dataRef.current.sourceItemsBySchemaRef?.[TRANSCRIPT_SCHEMA_REF]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "other-segment" })]),
    );
  });
  it("source corrections converge in two timelines without timeline save/head/history changes", async () => {
    const { r } = repository(),
      a = await editor(r),
      receipt = await a.host.importTranscript({
        document: handoff,
        associationAssetId: "alias",
      }),
      b = await editor(r, "b");
    await b.host.selectProjectSource({
      assetId: "b",
      documentId: docId(receipt),
    });
    a.commitData.mockClear();
    a.flush.mockClear();
    const before = a.dataRef.current;
    expect(await a.host.editText(edit("hi"))).toEqual({
      ok: true,
      changed: true,
    });
    await b.host.refreshSources();
    expect(a.dataRef.current.config).toEqual(before.config);
    expect(a.dataRef.current.head).toEqual(before.head);
    expect(a.dataRef.current.stableSignature).toBe(before.stableSignature);
    expect(a.flush).not.toHaveBeenCalled();
    expect(a.commitData).toHaveBeenLastCalledWith(expect.anything(), {
      save: false,
      skipHistory: true,
    });
    const row =
      b.dataRef.current.sourceItemsBySchemaRef![TRANSCRIPT_SCHEMA_REF][0];
    expect((row.payload as any).text).toBe("hi world");
    expect(row.extent).toEqual({ start: 1, end: 4 });
    expect((row.payload as any).words[0]).toMatchObject({
      id: "w-one",
      start: 1,
      end: 2,
    });
    const undone = buildDataFromSnapshot(
      before.config,
      before.registry,
      a.dataRef.current,
      before.sourceItemsBySchemaRef,
    );
    expect(
      (undone.sourceItemsBySchemaRef![TRANSCRIPT_SCHEMA_REF][0].payload as any)
        .text,
    ).toBe("hi world");
  });
  it("stale client edit preserves canonical winner and recoverable draft; explicit reapply uses a fresh CAS", async () => {
    const { r, documents } = repository(),
      a = await editor(r),
      receipt = await a.host.importTranscript({
        document: handoff,
        associationAssetId: "alias",
      }),
      b = await editor(r, "b");
    const id = docId(receipt);
    await b.host.selectProjectSource({ assetId: "b", documentId: id });
    await a.host.editText(edit("winner"));
    expect(await b.host.editText(edit("loser"))).toMatchObject({
      ok: false,
      code: "source_conflict",
    });
    expect(documents.get(id)!.content.segments[0].text).toBe("winner world");
    expect(b.host.getProjectState().sources[0]).toMatchObject({
      status: "conflict",
      hasDraft: true,
      version: 2,
    });
    b.host.dispose();
    const reopened = await editor(r, "b");
    reopened.dataRef.current = {
      ...reopened.dataRef.current,
      transcriptReferences: {
        schema: "media.transcript.references/v1",
        associations: [{ assetId: "b", documentId: id }],
      },
    };
    await reopened.host.refreshSources();
    expect(reopened.host.getProjectState().sources[0]).toMatchObject({
      status: "conflict",
      hasDraft: true,
      version: 2,
    });
    expect(await reopened.host.resolveSourceConflict(id, "reapply")).toEqual({
      ok: true,
      changed: true,
    });
    expect(documents.get(id)!.content.segments[0].text).toBe("loser world");
    expect(documents.get(id)!.version).toBe(3);
  });
  it("undo/redo are source document CAS operations and cannot overwrite an unseen remote change", async () => {
    const { r, documents } = repository(),
      a = await editor(r),
      receipt = await a.host.importTranscript({
        document: handoff,
        associationAssetId: "alias",
      }),
      id = docId(receipt);
    await a.host.editText(edit("hi"));
    await a.host.undoSource(id);
    expect(documents.get(id)!.content.segments[0].text).toBe("hello world");
    await a.host.redoSource(id);
    expect(documents.get(id)!.content.segments[0].text).toBe("hi world");
    const d = documents.get(id)!;
    await r.update(
      id,
      {
        ...d.content,
        segments: d.content.segments.map((s) => ({ ...s, text: "remote" })),
      },
      d.version,
      "remote",
    );
    expect(await a.host.undoSource(id)).toMatchObject({ ok: false });
    expect(documents.get(id)!.content.segments[0].text).toBe("remote");
    expect(a.host.getProjectState().sources[0].hasDraft).toBe(true);
  });
  it("byte-identical retry reuses identity without erasing subsequent corrections, and stale reimport refuses overwrite", async () => {
    const { r, documents } = repository(),
      a = await editor(r),
      receipt = await a.host.importTranscript({
        document: handoff,
        associationAssetId: "alias",
      }),
      id = docId(receipt);
    await a.host.editText(edit("edited"));
    await a.host.importTranscript({
      document: handoff,
      associationAssetId: "alias",
    });
    expect(documents.get(id)!.content.segments[0].text).toBe("edited world");
    expect(r.create).toHaveBeenCalledTimes(1);
    const changed = {
      ...handoff,
      segments: [{ ...handoff.segments[0], text: "replacement" }],
    };
    const d = documents.get(id)!;
    await r.update(
      id,
      {
        ...d.content,
        segments: d.content.segments.map((s) => ({ ...s, text: "newer" })),
      },
      d.version,
      "external",
    );
    await expect(
      a.host.importTranscript({
        document: changed,
        associationAssetId: "alias",
      }),
    ).rejects.toThrow("Select it first");
    expect(documents.get(id)!.content.segments[0].text).toBe("newer");
  });
  it("submits replacement against the exact loaded prior version and keeps a stale refusal replayable", async () => {
    const { r, documents } = repository();
    const a = await editor(r);
    const first = await a.host.importTranscript({
      document: handoff,
      associationAssetId: "alias",
    });
    const id = docId(first);
    const current = documents.get(id)!;
    await r.update(
      id,
      {
        ...current.content,
        segments: current.content.segments.map((segment) => ({
          ...segment,
          text: "remote winner",
        })),
      },
      current.version,
      "remote-edit",
    );
    const before = structuredClone(a.dataRef.current);
    a.commitData.mockClear();
    const updateCallsBeforeImport = r.update.mock.calls.length;

    await expect(
      a.host.importTranscript({
        document: {
          ...handoff,
          segments: [
            {
              ...handoff.segments[0],
              speaker: null,
              text: "stale replacement",
            },
            { id: "second", start: 4, end: 5, text: "next" },
          ],
        },
        associationAssetId: "alias",
      }),
    ).rejects.toThrow("Select it first");

    expect(r.update.mock.calls.length).toBe(updateCallsBeforeImport);
    expect(documents.get(id)!.version).toBe(2);
    expect(documents.get(id)!.content.segments[0].text).toBe("remote winner");
    expect(a.dataRef.current.transcriptReferences).toEqual(
      before.transcriptReferences,
    );
    expect(
      a.dataRef.current.sourceItemsBySchemaRef![TRANSCRIPT_SCHEMA_REF][0].payload,
    ).toMatchObject({ documentVersion: 1 });
    expect(a.commitData.mock.calls.every(([, options]) => options?.save !== true)).toBe(
      true,
    );

    const replay = parseTimelineBundle({
      schema_version: 1,
      itemsBySchemaRef: persistedTranscriptItems(
        a.dataRef.current.sourceItemsBySchemaRef!,
      ),
      transcriptReferences: a.dataRef.current.transcriptReferences,
    });
    const reopened = await editor(r, "alias");
    reopened.dataRef.current = await buildTimelineData(
      reopened.dataRef.current.config,
      reopened.dataRef.current.registry,
      (f) => f,
      reopened.dataRef.current.configVersion,
      replay.itemsBySchemaRef,
      a.dataRef.current.head,
      replay.transcriptReferences,
    );
    await reopened.host.selectProjectSource({
      assetId: "alias",
      documentId: id,
    });
    expect(
      reopened.dataRef.current.sourceItemsBySchemaRef![TRANSCRIPT_SCHEMA_REF][0]
        .payload,
    ).toMatchObject({ text: "remote winner" });
  });
  it("reports document success/timeline association failure and safely reuses the document when retrying", async () => {
    const { r, documents } = repository(),
      flush = vi
        .fn()
        .mockRejectedValueOnce(new Error("timeline conflict"))
        .mockResolvedValue(undefined),
      a = await editor(r, "alias", flush);
    const receipt = await a.host.importTranscript({
      document: handoff,
      associationAssetId: "alias",
    });
    expect(receipt).toMatchObject({ associationSaved: false });
    expect(receipt.message).toContain("Project transcript saved");
    expect(documents.size).toBe(1);
    expect(
      a.dataRef.current.transcriptReferences?.associations[0].documentId,
    ).toBe(receipt.documentId);
    expect(
      await a.host.selectProjectSource({
        assetId: "alias",
        documentId: docId(receipt),
      }),
    ).toMatchObject({ associationSaved: true });
    expect(r.create).toHaveBeenCalledTimes(1);
  });
  it("promotes legacy opaque IDs and preserves review refs, but refuses divergent canonical overwrite", async () => {
    const { r, documents } = repository(),
      a = await editor(r);
    const legacy = normalizeTranscriptSource({
      assetId: "alias",
      sourceId: "old",
      segments: handoff.segments,
    });
    a.dataRef.current = {
      ...a.dataRef.current,
      sourceItemsBySchemaRef: { [TRANSCRIPT_SCHEMA_REF]: legacy },
    };
    const previousConfig = a.dataRef.current.config;
    const legacyId = legacy[0].id,
      receipt = await a.host.promoteSource({
        assetId: "alias",
        sourceId: "old",
      });
    expect(documents.get(docId(receipt))!.content.segments[0].id).toBe(
      legacyId,
    );
    expect(a.dataRef.current.config).toEqual(previousConfig);
    const b = await editor(r, "alias");
    b.dataRef.current = {
      ...b.dataRef.current,
      sourceItemsBySchemaRef: {
        [TRANSCRIPT_SCHEMA_REF]: normalizeTranscriptSource({
          assetId: "alias",
          sourceId: "old",
          segments: [{ ...handoff.segments[0], text: "stale legacy" }],
        }),
      },
    };
    await expect(
      b.host.promoteSource({ assetId: "alias", sourceId: "old" }),
    ).rejects.toThrow("Both are preserved");
    expect(
      (
        b.dataRef.current.sourceItemsBySchemaRef![TRANSCRIPT_SCHEMA_REF][0]
          .payload as any
      ).text,
    ).toBe("stale legacy");
    expect(documents.size).toBe(1);
  });
  it("reads canonical sources on reopen and keeps unresolved references retriable", async () => {
    const { r } = repository(),
      a = await editor(r),
      receipt = await a.host.importTranscript({
        document: handoff,
        associationAssetId: "alias",
      });
    await a.host.editText(edit("latest"));
    const bundle = parseTimelineBundle({
      schema_version: 1,
      itemsBySchemaRef: persistedTranscriptItems(
        a.dataRef.current.sourceItemsBySchemaRef!,
      ),
      transcriptReferences: a.dataRef.current.transcriptReferences,
    });
    const b = await editor(r);
    b.dataRef.current = await buildTimelineData(
      config,
      a.dataRef.current.registry,
      (f) => f,
      7,
      bundle.itemsBySchemaRef,
      a.dataRef.current.head,
      bundle.transcriptReferences,
    );
    await b.host.refreshSources();
    expect(
      (
        b.dataRef.current.sourceItemsBySchemaRef![TRANSCRIPT_SCHEMA_REF][0]
          .payload as any
      ).text,
    ).toBe("latest world");
    b.dataRef.current = {
      ...b.dataRef.current,
      transcriptReferences: {
        schema: "media.transcript.references/v1",
        associations: [{ assetId: "alias", documentId: "missing" }],
      },
    };
    await b.host.refreshSources();
    expect(b.host.getProjectState().sources[0]).toMatchObject({
      documentId: "missing",
      status: "error",
    });
    expect(
      b.dataRef.current.transcriptReferences.associations[0].documentId,
    ).toBe("missing");
  });
  it("disables project saves without repository/media identity and validates document reads", async () => {
    const a = await editor();
    expect(a.host.getProjectState().supported).toBe(false);
    await expect(
      a.host.importTranscript({
        document: handoff,
        associationAssetId: "alias",
      }),
    ).rejects.toThrow("Runtime");
    const { r } = repository(),
      b = await editor(r);
    delete b.dataRef.current.registry.assets.alias.media_id;
    await expect(
      b.host.importTranscript({
        document: handoff,
        associationAssetId: "alias",
      }),
    ).rejects.toThrow("project object identity");
    await expect(
      parseProjectTranscriptDocument({ project_id: "wrong" }, "p"),
    ).rejects.toThrow("authority");
  });
  it("fences late source selection when another source is selected or the editor is disposed", async () => {
    const { r } = repository(),
      a = await editor(r),
      first = await a.host.importTranscript({
        document: handoff,
        associationAssetId: "alias",
      }),
      second = await a.host.importTranscript({
        document: { ...handoff, sourceId: "other" },
        associationAssetId: "alias",
      });
    const original = r.get;
    let resume!: (d: ProjectTranscriptDocument) => void;
    vi.mocked(r.get).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resume = resolve;
        }),
    );
    const pending = a.host.selectProjectSource({
      assetId: "alias",
      documentId: docId(first),
    });
    await a.host.selectProjectSource({
      assetId: "alias",
      documentId: docId(second),
    });
    resume(await original(docId(first)));
    await expect(pending).rejects.toThrow("superseded");
    expect(
      a.dataRef.current.transcriptReferences!.associations[0].documentId,
    ).toBe(second.documentId);
  });
  it("keeps a typing draft at its document version across remote refresh and rejects a wrong-source edit with identical segment/word IDs", async () => {
    const { r, documents } = repository(),
      a = await editor(r),
      first = await a.host.importTranscript({
        document: handoff,
        associationAssetId: "alias",
      }),
      id = docId(first);
    expect(
      a.host.stageTextDraft({
        ...edit("typed"),
        documentId: id,
        baseVersion: 1,
        assetId: "alias",
      }),
    ).toMatchObject({ ok: true });
    const old = documents.get(id)!;
    await r.update(
      id,
      {
        ...old.content,
        segments: old.content.segments.map((s) => ({
          ...s,
          text: "remote winner",
        })),
      },
      1,
      "remote",
    );
    await a.host.refreshSources();
    expect(a.host.getProjectState().sources[0]).toMatchObject({
      hasDraft: true,
      status: "conflict",
      version: 2,
    });
    expect(
      await a.host.editText({
        ...edit("typed"),
        documentId: id,
        baseVersion: 1,
        assetId: "alias",
      }),
    ).toMatchObject({ ok: false });
    expect(documents.get(id)!.content.segments[0].text).toBe("remote winner");
    const second = await a.host.importTranscript({
      document: { ...handoff, sourceId: "second" },
      associationAssetId: "alias",
    });
    expect(second.documentId).not.toBe(id);
    expect(
      await a.host.editText({
        ...edit("wrong source"),
        documentId: id,
        baseVersion: 1,
        assetId: "alias",
      }),
    ).toMatchObject({ ok: false });
    expect(documents.get(docId(second))!.content.segments[0].text).toBe(
      "hello world",
    );
    await a.host.selectProjectSource({ assetId: "alias", documentId: id });
    expect(
      a.host.getProjectState().sources.find((s) => s.documentId === id),
    ).toMatchObject({ hasDraft: true, status: "conflict" });
    await a.host.resolveSourceConflict(id, "reapply");
    expect(documents.get(id)!.content.segments[0].text).toBe("typed world");
  });

  it("keeps the last transcript snapshot and typing draft through a temporary source disconnect, then adopts the recovered source", async () => {
    const { r, documents } = repository();
    const a = await editor(r, "alias", vi.fn(async () => undefined), true);
    const id = docId(await a.host.importTranscript({
      document: handoff,
      associationAssetId: "alias",
    }));
    const adapter = createTranscriptPanelAdapter({
      getData: () => a.dataRef.current,
      getTransientItems: () => a.items!.readTransient(TRANSCRIPT_SCHEMA_REF),
      subscribe: () => ({ dispose() {} }),
      video: { view: { getSnapshot: () => ({ playhead: { time: 0 } }) } as never, seek: () => {} },
    });
    expect(adapter.getSnapshot().sources.map((source) => source.text)).toEqual(["hello world"]);
    expect(a.host.stageTextDraft({
      ...edit("typed"),
      documentId: id,
      baseVersion: 1,
      assetId: "alias",
    })).toMatchObject({ ok: true });

    const original = documents.get(id)!;
    await r.update(id, {
      ...original.content,
      segments: original.content.segments.map((segment) => ({
        ...segment,
        text: "remote winner",
      })),
    }, 1, "remote");
    vi.mocked(r.get).mockRejectedValueOnce(new Error("Runtime disconnected"));
    await a.host.refreshSources();

    expect(adapter.getSnapshot().sources.map((source) => source.text)).toEqual(["hello world"]);
    expect(a.host.getProjectState().sources[0]).toMatchObject({
      hasDraft: true,
      status: "error",
      draftPreview: { text: "typed world" },
    });

    await a.host.refreshSources();
    expect(adapter.getSnapshot().sources.map((source) => source.text)).toEqual(["remote winner"]);
    expect(a.host.getProjectState().sources[0]).toMatchObject({
      hasDraft: true,
      status: "conflict",
      version: 2,
      draftPreview: { text: "typed world" },
    });
  });
  it.each(["reapply", "discard"] as const)("retains a first stale-base proposal for explicit %s without implicit writes", async (choice) => {
    const { r, documents } = repository();
    const a = await editor(r);
    const id = docId(await a.host.importTranscript({ document: handoff, associationAssetId: "alias" }));
    const original = documents.get(id)!;
    await r.update(id, {
      ...original.content,
      segments: original.content.segments.map((segment) => ({ ...segment, text: "hello remote", words: segment.words?.map((word) => word.id === "w-two" ? { ...word, text: "remote" } : word) })),
    }, 1, "remote");
    await a.host.refreshSources();
    expect(a.host.stageTextDraft({ ...edit("proposed"), documentId: id, baseVersion: 1, assetId: "alias" })).toMatchObject({ ok: false, code: "source_conflict" });
    expect(a.host.getProjectState().sources[0]).toMatchObject({ status: "conflict", hasDraft: true, draftPreview: { baseVersion: 1, text: "proposed remote" } });
    expect(JSON.parse(localStorage.getItem(`astrid:transcript-draft:p:${id}`)!)).toMatchObject({ baseVersion: 1, content: { segments: [{ text: "proposed remote" }] } });
    expect(documents.get(id)!.version).toBe(2);
    expect(documents.get(id)!.content.segments[0].text).toBe("hello remote");
    expect(await a.host.resolveSourceConflict(id, choice)).toMatchObject({ ok: true });
    expect(documents.get(id)!.content.segments[0].text).toBe(choice === "reapply" ? "proposed remote" : "hello remote");
    expect(a.host.getProjectState().sources[0]).toMatchObject({ status: "clean", hasDraft: false });
    const currentVersion = documents.get(id)!.version;
    expect(await a.host.editText({ ...edit("ordinary"), documentId: id, baseVersion: currentVersion, assetId: "alias" })).toMatchObject({ ok: true });
    expect(documents.get(id)!.content.segments[0].text).toBe("ordinary remote");
    expect(documents.get(id)!.content.segments[0].start).toBe(1);
    expect(documents.get(id)!.content.segments[0].end).toBe(4);
  });

  it("does not erase a newer staged correction when an earlier save completes", async () => {
    const { r, documents } = repository();
    const a = await editor(r);
    const id = docId(await a.host.importTranscript({ document: handoff, associationAssetId: "alias" }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const update = vi.mocked(r.update).getMockImplementation()!;
    vi.mocked(r.update).mockImplementationOnce(async (...args) => { await gate; return update(...args); });
    const pending = a.host.editText({ ...edit("earlier"), documentId: id, baseVersion: 1, assetId: "alias" });
    expect(a.host.stageTextDraft({ ...edit("newer"), documentId: id, baseVersion: 1, assetId: "alias" })).toMatchObject({ ok: true });
    release();
    expect(await pending).toMatchObject({ ok: true });
    expect(documents.get(id)!.content.segments[0].text).toBe("earlier world");
    expect(a.host.getProjectState().sources[0]).toMatchObject({ version: 2, status: "conflict", hasDraft: true, draftPreview: { baseVersion: 1, text: "newer world" } });
    expect(await a.host.resolveSourceConflict(id, "reapply")).toMatchObject({ ok: true });
    expect(documents.get(id)!.version).toBe(3);
    expect(documents.get(id)!.content.segments[0].text).toBe("newer world");
  });

  it("segment correction clears stale word alignment and keeps segment identity/timing/speaker", async () => {
    const { r, documents } = repository(),
      a = await editor(r),
      receipt = await a.host.importTranscript({
        document: handoff,
        associationAssetId: "alias",
      });
    expect(
      await a.host.editText({
        type: "segment",
        sourceItemId: "segment-one",
        documentId: docId(receipt),
        text: "Whole corrected sentence",
      }),
    ).toMatchObject({ ok: true });
    const segment = documents.get(docId(receipt))!.content.segments[0];
    expect(segment).toEqual({
      id: "segment-one",
      start: 1,
      end: 4,
      text: "Whole corrected sentence",
      speaker: "Speaker",
    });
  });
  it("reports a first import as in flight before a source exists, then clears it after the durable association receipt", async () => {
    const { r } = repository(),
      a = await editor(r);
    const create = r.create;
    let release!: () => void;
    vi.mocked(r.create).mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return create(...args);
    });
    const promise = a.host.importTranscript({
      document: handoff,
      associationAssetId: "alias",
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(a.host.getProjectState()).toMatchObject({
      inFlight: true,
      sources: [],
    });
    release();
    await promise;
    expect(a.host.getProjectState().inFlight).toBe(false);
  });

  it("rejects duplicate word IDs across segments before writing, preserving the supplied identity", async () => {
    const { r } = repository(),
      a = await editor(r);
    const document = {
      segments: [
        {
          id: "s1",
          start: 0,
          end: 1,
          text: "one",
          words: [{ id: "repeated", start: 0, end: 1, text: "one" }],
        },
        {
          id: "s2",
          start: 1,
          end: 2,
          text: "two",
          words: [{ id: "repeated", start: 1, end: 2, text: "two" }],
        },
      ],
    };
    await expect(
      a.host.importTranscript({ document, associationAssetId: "alias" }),
    ).rejects.toThrow("word IDs must be unique");
    expect(r.create).not.toHaveBeenCalled();
    expect(document.segments[1].words[0].id).toBe("repeated");
  });
});

import { z } from "zod";
import { sha256Hex, canonicalJsonStringify } from "./timelineBundle.ts";
import { TRANSCRIPT_SCHEMA_REF } from "./adaptTranscript.ts";
import { freezeSourceDataItem, type SourceFrozenDataItem } from "./envelope.ts";
import type { AssetRegistry } from "../../types/index.ts";

export const PROJECT_TRANSCRIPT_KIND = "media.transcript";
export const PROJECT_TRANSCRIPT_SCHEMA = "media.transcript/v1";
const time = z.number().finite().nonnegative();
const word = z
  .strictObject({
    id: z.string().min(1).max(1024),
    start: time,
    end: time,
    text: z.string().max(100000),
  })
  .refine((v) => v.end >= v.start);
const segment = z
  .strictObject({
    id: z.string().min(1).max(1024),
    start: time,
    end: time,
    text: z.string().max(100000),
    speaker: z.string().max(1024).nullable().optional(),
    words: z.array(word).max(100000).optional(),
  })
  .refine((v) => v.end >= v.start);
export const projectTranscriptSchema = z
  .strictObject({
    schema: z.literal(PROJECT_TRANSCRIPT_SCHEMA),
    media_id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    source_id: z.string().min(1).max(1024),
    segments: z.array(segment).min(1).max(100000),
  })
  .superRefine((v, ctx) => {
    const ids = new Set<string>();
    const words = new Set<string>();
    for (const s of v.segments) {
      if (ids.has(s.id))
        ctx.addIssue({ code: "custom", message: "Duplicate segment identity" });
      ids.add(s.id);
      for (const w of s.words ?? []) {
        if (words.has(w.id))
          ctx.addIssue({
            code: "custom",
            message: "Transcript word IDs must be unique within the document.",
          });
        words.add(w.id);
      }
    }
  });
export type ProjectTranscriptContent = z.infer<typeof projectTranscriptSchema>;
export interface ProjectTranscriptDocument {
  /** Existing Runtime mutation receipt is retained on create/update responses. */
  readonly receipt?: unknown;
  document_id: string;
  project_id: string;
  kind: typeof PROJECT_TRANSCRIPT_KIND;
  content: ProjectTranscriptContent;
  version: number;
  created_at: string;
  updated_at: string;
}
export interface ProjectTranscriptRepository {
  readonly projectId: string;
  onChange?(listener: () => void): () => void;
  listAll(): Promise<ProjectTranscriptDocument[]>;
  listForMedia(mediaId: string): Promise<ProjectTranscriptDocument[]>;
  get(documentId: string): Promise<ProjectTranscriptDocument>;
  create(
    content: ProjectTranscriptContent,
    idempotencyKey: string,
  ): Promise<ProjectTranscriptDocument>;
  update(
    documentId: string,
    content: ProjectTranscriptContent,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<ProjectTranscriptDocument>;
}

/** Transcript policy over the generic editor document surface. */
export function transcriptRepositoryFromDocuments(
  documents: import('@/sdk/context.ts').ProjectDocumentSurface,
  projectId: string,
): ProjectTranscriptRepository {
  const listAll = async (): Promise<ProjectTranscriptDocument[]> => {
    const found: ProjectTranscriptDocument[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await documents.list(PROJECT_TRANSCRIPT_KIND, { cursor, limit: 100 });
      for (const raw of page.items) {
        const doc = await parseProjectTranscriptDocument(raw, projectId);
        found.push(doc);
      }
      cursor = page.next_cursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error('Project transcript pagination repeated a cursor.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return found;
  };
  return {
    projectId,
    onChange: documents.onChange,
    listAll,
    async listForMedia(mediaId) {
      return (await listAll()).filter((doc) => doc.content.media_id === mediaId);
    },
    async get(id) { return parseProjectTranscriptDocument(await documents.get(id), projectId); },
    async create(content) {
      const validated = projectTranscriptSchema.parse(content);
      const id = await transcriptDocumentId(projectId, validated.media_id, validated.source_id);
      return parseProjectTranscriptDocument(await documents.create(PROJECT_TRANSCRIPT_KIND, validated, id), projectId);
    },
    async update(id, content, expectedVersion) {
      return parseProjectTranscriptDocument(await documents.update(id, projectTranscriptSchema.parse(content), expectedVersion), projectId);
    },
  };
}
export interface TranscriptReferences {
  schema: "media.transcript.references/v1";
  associations: { assetId: string; documentId: string; mediaId?: string; sourceId?: string }[];
}
export async function transcriptDocumentId(
  projectId: string,
  mediaId: string,
  sourceId = "default",
): Promise<string> {
  return (
    "transcript:" +
    (await sha256Hex(
      JSON.stringify([PROJECT_TRANSCRIPT_SCHEMA, projectId, mediaId, sourceId]),
    ))
  );
}
export async function parseProjectTranscriptDocument(
  value: unknown,
  projectId: string,
): Promise<ProjectTranscriptDocument> {
  const d = value as ProjectTranscriptDocument;
  if (
    !d ||
    d.project_id !== projectId ||
    d.kind !== PROJECT_TRANSCRIPT_KIND ||
    !Number.isSafeInteger(d.version) ||
    d.version < 1
  )
    throw new Error("Invalid project transcript document authority.");
  const content = projectTranscriptSchema.parse(d.content);
  if (
    d.document_id !==
    (await transcriptDocumentId(projectId, content.media_id, content.source_id))
  )
    throw new Error(
      "Project transcript document identity does not match its media and source.",
    );
  return { ...d, content };
}
export function transcriptMediaId(
  registry: AssetRegistry,
  assetId: string,
): string {
  return transcriptMediaIdFromAsset(registry.assets[assetId]);
}

export function transcriptMediaIdFromAsset(
  a: { media_id?: string; content_sha256?: string } | undefined,
): string {
  const id = a?.media_id ?? a?.content_sha256;
  if (typeof id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(id))
    throw Object.assign(
      new Error(
        "This media has no project object identity. Import the source media through Workspace Runtime before saving a project transcript.",
      ),
      { code: "missing_media_identity" },
    );
  return id;
}
export const sameTranscript = (
  a: ProjectTranscriptContent,
  b: ProjectTranscriptContent,
): boolean => canonicalJsonStringify(a) === canonicalJsonStringify(b);
export function projectTranscriptItems(
  d: ProjectTranscriptDocument,
  assetId: string,
): readonly SourceFrozenDataItem[] {
  return d.content.segments.map((s) =>
    freezeSourceDataItem({
      id: s.id,
      shape: "interval",
      domain: "source_seconds",
      extent: { start: s.start, end: s.end },
      schemaRef: TRANSCRIPT_SCHEMA_REF,
      sourceArtifactRef: { assetId },
      provenance: { adapterId: "astrid.projectTranscript", adapterVersion: "1" },
      payload: {
        sourceId: d.content.source_id,
        segmentId: s.id,
        text: s.text,
        ...(s.speaker !== undefined ? { speaker: s.speaker } : {}),
        ...(s.words ? { words: s.words } : {}),
        documentId: d.document_id,
        documentVersion: d.version,
      },
    }),
  );
}
/** Projections are never a second persisted source owner. */
export function persistedTranscriptItems(
  items: Readonly<Record<string, readonly SourceFrozenDataItem[]>>,
): Record<string, SourceFrozenDataItem[]> {
  return Object.fromEntries(
    Object.entries(items).map(([key, values]) => [
      key,
      values.filter(
        (i) => i.provenance.adapterId !== "astrid.projectTranscript",
      ),
    ]),
  );
}

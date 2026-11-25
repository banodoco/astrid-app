import type {
  TranscriptPanelAdapter,
  TranscriptPanelImportReceipt,
  TranscriptPanelTextEditResult,
  TranscriptProjectSourceChoice,
  TranscriptProjectState,
} from '@/sdk/video/transcript.ts';
import type { AssetRegistry } from '../types/index.ts';
import {
  TRANSCRIPT_SCHEMA_REF,
  type TranscriptSourceSegment,
} from '../data/typed/adaptTranscript.ts';
import { reconcileTranscriptReferences } from '../data/typed/reconcileTranscriptReferences.ts';
import { editTranscriptText } from '../data/typed/editTranscript.ts';
import {
  parseTranscriptDocument,
  resolveAssociatedAssetId,
  assertRegisteredTranscriptMedia,
} from '../data/typed/importTranscriptHandoff.ts';
import {
  projectTranscriptSchema,
  projectTranscriptItems,
  transcriptMediaIdFromAsset,
  transcriptDocumentId,
  sameTranscript,
  type ProjectTranscriptContent,
  type ProjectTranscriptDocument,
  type ProjectTranscriptRepository,
} from '../data/typed/projectTranscript.ts';
import { buildDataFromCurrentRegistry } from './timeline-save-utils.ts';
import type { TimelineData } from './timeline-data.ts';
import type { CommitDataOptions } from '../hooks/useTimelineCommit.ts';
import type { TimelineEditability } from './timeline-editability.ts';
import type { SourceFrozenDataItem } from '../data/typed/envelope.ts';
import type { CreativeAssetReadSurface, ExtensionPendingWorkService } from '@/sdk/context.ts';
import type { DataKindItemsHost } from '@/tools/video-editor/data-kinds/dataKindItems.ts';
import { preparePersistedDataKindItems } from '@/tools/video-editor/data-kinds/dataKindItems.ts';
import { createEditorAssetSurface } from '@/tools/video-editor/runtime/editorAssetSurface.ts';

// Narrow document invalidation between mounted transcript hosts; polling covers other tabs.
const observers = new Set<(id: string) => void>();
type Draft = { baseVersion: number; content: ProjectTranscriptContent };
type Entry = {
  document?: ProjectTranscriptDocument;
  assetId: string;
  /** Read-only default source projected for an unassociated asset. */
  fallback?: boolean;
  status: 'clean' | 'saving' | 'conflict' | 'error';
  message?: string;
  draft?: Draft;
  undo: ProjectTranscriptContent[];
  redo: ProjectTranscriptContent[];
};
export interface ProjectTranscriptHostInput {
  dataRef: { current: TimelineData | null };
  commitData(next: TimelineData, options?: CommitDataOptions): void;
  repository?: ProjectTranscriptRepository;
  assets?: CreativeAssetReadSurface;
  items?: DataKindItemsHost;
  pendingWork?: ExtensionPendingWorkService;
  flushPendingSave?: () => Promise<unknown>;
  editability?: TimelineEditability;
  getTimelineLaneVisible?: () => boolean;
  setTimelineLaneVisible?: (visible: boolean) => void;
}
export type ProjectTranscriptHost = Required<
  Pick<
    TranscriptPanelAdapter,
    | 'getTimelineLaneVisible'
    | 'setTimelineLaneVisible'
    | 'stageTextDraft'
    | 'editText'
    | 'importTranscript'
    | 'getProjectState'
    | 'selectProjectSource'
    | 'promoteSource'
    | 'undoSource'
    | 'redoSource'
    | 'resolveSourceConflict'
    | 'refreshSources'
  >
> & {
  /** `playedRegistry` resolves media that only plays inside placed shots; the timeline's own registry wins. */
  listProjectSources(
    assetId: string,
    playedRegistry?: AssetRegistry,
  ): Promise<readonly TranscriptProjectSourceChoice[]>;
  subscribe(listener: () => void): () => void;
  start(): void;
  dispose(): void;
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fail = (code: string, text: string): TranscriptPanelTextEditResult => ({
  ok: false,
  code,
  message: text,
});
const payloadOf = (i: SourceFrozenDataItem) =>
  i.payload as {
    sourceId?: string;
    text: string;
    speaker?: string | null;
    words?: { id: string; start: number; end: number; text: string }[];
  };
function contentFromItems(
  mediaId: string,
  sourceId: string,
  items: readonly SourceFrozenDataItem[],
): ProjectTranscriptContent {
  return projectTranscriptSchema.parse({
    schema: 'media.transcript/v1',
    media_id: mediaId,
    source_id: sourceId,
    segments: items.map((i) => ({
      id: i.id,
      start: i.extent.start,
      end: i.extent.end ?? i.extent.start,
      text: payloadOf(i).text,
      ...(payloadOf(i).speaker !== undefined
        ? { speaker: payloadOf(i).speaker }
        : {}),
      ...(payloadOf(i).words ? { words: payloadOf(i).words } : {}),
    })),
  });
}
function importedContent(
  mediaId: string,
  sourceId: string,
  segments: readonly TranscriptSourceSegment[],
): ProjectTranscriptContent {
  const ids = new Set<string>();
  const unique = (raw: string, used: Set<string>): string => {
    let id = raw,
      n = 2;
    while (used.has(id)) id = `${raw}~${n++}`;
    used.add(id);
    return id;
  };
  return projectTranscriptSchema.parse({
    schema: 'media.transcript/v1',
    media_id: mediaId,
    source_id: sourceId,
    segments: segments.map((s, index) => {
      const words = new Set<string>();
      return {
        ...s,
        id: unique(s.id ?? `segment-${index}`, ids),
        ...(s.words
          ? {
              words: s.words.map((w, i) => ({
                id: unique(w.id ?? `word-${i}`, words),
                start: w.start,
                end: w.end,
                text: w.text ?? w.word,
              })),
            }
          : {}),
      };
    }),
  });
}
export function createProjectTranscriptHost(
  input: ProjectTranscriptHostInput,
): ProjectTranscriptHost {
  const entries = new Map<string, Entry>(),
    listeners = new Set<() => void>();
  const repo = input.repository;
  const assets = input.assets ?? createEditorAssetSurface(() => input.dataRef.current);
  const mediaId = (assetId: string): string => transcriptMediaIdFromAsset(assets.get(assetId));
  let pendingOperations = 0;
  let generation = 0;
  let disposed = false,
    refreshing = false,
    selection = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopDocuments: (() => void) | undefined;
  let documentIndex: ReadonlyMap<string, readonly ProjectTranscriptDocument[]> | undefined;
  let documentListing: Promise<ReadonlyMap<string, readonly ProjectTranscriptDocument[]>> | undefined;
  let documentEpoch = 0;
  const invalidateDocuments = () => {
    documentEpoch++;
    documentIndex = undefined;
    documentListing = undefined;
  };
  const documentsForMedia = async (mediaId: string): Promise<readonly ProjectTranscriptDocument[]> => {
    for (;;) {
      if (documentIndex) return documentIndex.get(mediaId) ?? [];
      const epoch = documentEpoch;
      if (!documentListing) {
        const listing = repo!.listAll().then((documents) => {
          const index = new Map<string, ProjectTranscriptDocument[]>();
          for (const document of documents) {
            const id = document.content.media_id;
            const group = index.get(id) ?? [];
            group.push(document);
            index.set(id, group);
          }
          if (epoch === documentEpoch) documentIndex = index;
          return index;
        });
        documentListing = listing;
        void listing.finally(() => {
          if (documentListing === listing) documentListing = undefined;
        }).catch(() => undefined);
      }
      const index = await documentListing;
      if (epoch === documentEpoch) return index.get(mediaId) ?? [];
    }
  };
  const fallbackProjections = new Set<string>();
  let fallbackProjectionQueued = false;
  const queueFallbackProjection = (id: string) => {
    fallbackProjections.add(id);
    if (fallbackProjectionQueued) return;
    fallbackProjectionQueued = true;
    queueMicrotask(() => {
      fallbackProjectionQueued = false;
      if (disposed) return;
      const ids = [...fallbackProjections];
      fallbackProjections.clear();
      if (input.items) {
        if (ids.length) project(ids[0]); // This channel projects all current entries together.
      } else {
        for (const fallbackId of ids) project(fallbackId);
      }
      emit();
    });
  };
  let state: TranscriptProjectState = {
    supported: !!repo,
    ...(!repo
      ? {
          reason:
            'Project transcript saving requires Workspace Runtime. Open this project through its Runtime connector and import project-owned media.',
        }
      : {}),
    sources: [],
  };
  const emit = () => {
    if (disposed) return;
    state = {
      ...state,
      inFlight: pendingOperations > 0,
      sources: [...entries].flatMap(([id, e]) => {
        const refs =
          input.dataRef.current?.transcriptReferences?.associations.filter(
            (r) => r.documentId === id,
          ) ?? [];
        return (refs.length ? refs : [{ assetId: e.assetId }]).map((ref) => ({
          documentId: id,
          assetId: ref.assetId,
          sourceId: e.document?.content.source_id ?? '',
          version: e.document?.version ?? 0,
          status: e.status,
          ...(e.message ? { message: e.message } : {}),
          canUndo: e.undo.length > 0 && e.status === 'clean',
          canRedo: e.redo.length > 0 && e.status === 'clean',
          hasDraft: !!e.draft,
          ...(e.draft
            ? {
                draftPreview: {
                  baseVersion: e.draft.baseVersion,
                  text: e.draft.content.segments.map((s) => s.text).join(' '),
                },
              }
            : {}),
        }));
      }),
    };
    input.pendingWork?.report({
      writing: !!state.inFlight || state.sources.some((source) => source.status === 'saving'),
      unsaved: state.sources.some((source) => source.hasDraft || source.status === 'conflict'),
    });
    for (const l of listeners) l();
  };
  const key = (id: string) => `astrid:transcript-draft:${repo?.projectId}:${id}`;
  const persistDraft = (id: string, e: Entry) => {
    try {
      if (e.draft) localStorage.setItem(key(id), JSON.stringify(e.draft));
      else localStorage.removeItem(key(id));
    } catch {
      /* Keep in-memory draft if browser storage is unavailable. */
    }
  };
  const readDraft = (id: string): Draft | undefined => {
    try {
      const raw = localStorage.getItem(key(id));
      if (!raw) return;
      const v = JSON.parse(raw);
      if (!Number.isSafeInteger(v.baseVersion)) return;
      return {
        baseVersion: v.baseVersion,
        content: projectTranscriptSchema.parse(v.content),
      };
    } catch {
      return;
    }
  };
  const current = () => {
    if (disposed)
      throw new Error('This transcript editor is no longer active.');
    const data = input.dataRef.current;
    if (!data) throw new Error('Wait for the timeline to finish loading.');
    return data;
  };
  const supported = () => {
    current();
    if (!repo) throw new Error(state.reason);
    if (
      input.editability?.checkTimeline &&
      !input.editability.checkTimeline().allowed
    )
      throw new Error(
        'This timeline is read-only. Reopen with editing access to save a project transcript.',
      );
    return repo;
  };
  const resolveEditItem = (
    edit: Parameters<NonNullable<TranscriptPanelAdapter['stageTextDraft']>>[0],
  ) => {
    const matches = (
      input.items
        ? [...input.items.readTransient(TRANSCRIPT_SCHEMA_REF), ...input.items.readPersisted(TRANSCRIPT_SCHEMA_REF)]
        : current().sourceItemsBySchemaRef?.[TRANSCRIPT_SCHEMA_REF] ?? []
    ).filter(
      (i) =>
        i.id === edit.sourceItemId &&
        (!edit.assetId || i.sourceArtifactRef.assetId === edit.assetId) &&
        (!edit.documentId ||
          (i.payload as { documentId?: string }).documentId ===
            edit.documentId),
    );
    if (matches.length > 1)
      throw new Error(
        'This segment identity exists in multiple sources. Select its exact project document and media before editing.',
      );
    return matches[0];
  };
  const project = (id: string) => {
    if (disposed) return;
    const data = input.dataRef.current,
      e = entries.get(id);
    if (!data || !e?.document) return;
    if (input.items) {
      const projected = [...entries].flatMap(([documentId, entry]) => {
        if (!entry.document) return [];
        const refs = data.transcriptReferences?.associations ?? [];
        const assetIds = refs.filter((ref) => ref.documentId === documentId).map((ref) => ref.assetId);
        if (!assetIds.length && entry.fallback && !refs.some((ref) => ref.assetId === entry.assetId)) assetIds.push(entry.assetId);
        return assetIds.flatMap((assetId) => projectTranscriptItems(entry.document!, assetId));
      });
      input.items.replaceTransient(TRANSCRIPT_SCHEMA_REF, projected);
      return;
    }
    const refs = data.transcriptReferences?.associations ?? [];
    const assetIds = new Set(
      refs.filter((r) => r.documentId === id).map((r) => r.assetId),
    );
    if (
      !assetIds.size &&
      e.fallback &&
      !refs.some((r) => r.assetId === e.assetId)
    )
      assetIds.add(e.assetId);
    if (!assetIds.size) return;
    const existing = data.sourceItemsBySchemaRef?.[TRANSCRIPT_SCHEMA_REF] ?? [];
    // All source rows for an associated asset are supplied by the chosen document.
    const items = [
      ...existing.filter(
        (i) =>
          !assetIds.has(i.sourceArtifactRef.assetId) ||
          (i.provenance.adapterId !== 'astrid.projectTranscript' &&
            payloadOf(i).sourceId !== e.document!.content.source_id),
      ),
      ...[...assetIds].flatMap((assetId) =>
        projectTranscriptItems(e.document!, assetId),
      ),
    ];
    if (JSON.stringify(existing) === JSON.stringify(items)) return;
    const next = buildDataFromCurrentRegistry(data.config, data, {
      sourceItemsBySchemaRef: {
        ...data.sourceItemsBySchemaRef,
        [TRANSCRIPT_SCHEMA_REF]: items,
      },
    });
    // Source projection is transient and cannot alter timeline save identity/history.
    input.commitData(
      { ...next, stableSignature: data.stableSignature },
      { save: false, skipHistory: true },
    );
  };
  const adopt = (
    id: string,
    document: ProjectTranscriptDocument,
    assetId: string,
  ): Entry => {
    let e = entries.get(id);
    if (!e) {
      e = {
        assetId,
        status: 'clean',
        undo: [],
        redo: [],
        draft: readDraft(id),
      };
      entries.set(id, e);
    }
    if (
      document.content.media_id !==
      mediaId(assetId)
    )
      throw new Error(
        'Project transcript does not belong to the selected source media.',
      );
    if (e.status === 'saving') return e;
    if (e.status === 'error') {
      e.status = e.draft ? 'conflict' : 'clean';
      e.message = e.draft
        ? 'The source connection is restored. Your draft is retained. Reapply or discard it.'
        : undefined;
    }
    if (e.document && document.version < e.document.version) return e;
    if (e.document?.version !== document.version) {
      if (e.draft) {
        e.status = 'conflict';
        e.message =
          'A saved source draft is available. Compare the current project transcript, then explicitly reapply or discard the draft.';
      } else if (e.document) {
        e.undo = [];
        e.redo = [];
        e.status = 'clean';
        e.message = undefined;
      }
      e.document = document;
    }
    e.assetId = assetId;
    e.fallback = false;
    project(id);
    emit();
    return e;
  };
  const load = async (id: string, assetId: string) => {
    const session = generation;
    const document = await repo!.get(id);
    if (session !== generation)
      throw new Error('Transcript editor session changed while loading.');
    if (
      !input.dataRef.current?.transcriptReferences?.associations.some(
        (r) => r.documentId === id && r.assetId === assetId,
      )
    )
      throw new Error('Transcript association changed while loading.');
    if (disposed)
      throw new Error('Transcript selection changed while loading.');
    return adopt(id, document, assetId);
  };
  const refreshSources = async () => {
    invalidateDocuments();
    if (disposed || !repo || refreshing) return;
    refreshing = true;
    try {
      const refs =
        input.dataRef.current?.transcriptReferences?.associations ?? [];
      const active = new Set(refs.map((r) => r.documentId));
      for (const [id, entry] of entries)
        if (!active.has(id) && !entry.fallback) entries.delete(id);
      if (input.items && entries.size === 0) input.items.replaceTransient(TRANSCRIPT_SCHEMA_REF, []);
      await Promise.all(
        refs.map(async (r) => {
          try {
            const e = entries.get(r.documentId);
            if (e?.status === 'saving') return;
            await load(r.documentId, r.assetId);
          } catch (error) {
            if (
              disposed ||
              !input.dataRef.current?.transcriptReferences?.associations.some(
                (a) => a.documentId === r.documentId && a.assetId === r.assetId,
              )
            )
              return;
            const e = entries.get(r.documentId) ?? {
              assetId: r.assetId,
              status: 'error' as const,
              undo: [],
              redo: [],
            };
            e.status = 'error';
            e.message = `Unable to refresh project transcript: ${message(error)} Retry Refresh.`;
            entries.set(r.documentId, e);
            emit();
          }
        }),
      );
    } finally {
      refreshing = false;
    }
  };
  const write = async (
    id: string,
    content: ProjectTranscriptContent,
    history: 'edit' | 'undo' | 'redo' = 'edit',
  ): Promise<TranscriptPanelTextEditResult> => {
    let e: Entry | undefined;
    const session = generation;
    try {
      const r = supported();
      e = entries.get(id);
      if (!e?.document)
        return fail(
          'source_not_loaded',
          'Select the project transcript and wait for it to load.',
        );
      if (e.status === 'saving')
        return fail(
          'source_busy',
          'The project source is saving. Wait for its receipt.',
        );
      if (e.status === 'error')
        return fail(
          'source_unavailable',
          'Refresh the project transcript successfully before saving. Your draft is retained.',
        );
      if (e.status === 'conflict')
        return fail(
          'source_conflict',
          'A newer project transcript is available. Resolve the saved draft before retrying.',
        );
      const before = e.document;
      if (sameTranscript(before.content, content)) {
        e.draft = undefined;
        e.status = 'clean';
        e.message = undefined;
        persistDraft(id, e);
        emit();
        return { ok: true, changed: false };
      }
      const submittedDraft = { baseVersion: before.version, content };
      e.draft = submittedDraft;
      persistDraft(id, e);
      e.status = 'saving';
      e.message = undefined;
      emit();
      const result = await r.update(
        id,
        content,
        before.version,
        crypto.randomUUID(),
      );
      invalidateDocuments();
      if (disposed || session !== generation)
        return fail(
          'source_session_changed',
          'The source saved, but this editor session changed. Reopen the transcript to see the receipt.',
        );
      if (history === 'edit') {
        e.undo.push(before.content);
        e.redo = [];
      } else if (history === 'undo') {
        e.undo.pop();
        e.redo.push(before.content);
      } else {
        e.redo.pop();
        e.undo.push(before.content);
      }
      e.document = result;
      // A receipt acknowledges only its submitted content. Typing that happened
      // while it was pending owns a newer local draft and must survive.
      if (!e.draft || e.draft === submittedDraft || sameTranscript(e.draft.content, result.content)) {
        e.draft = undefined;
        e.status = 'clean';
        e.message = undefined;
      } else {
        e.status = 'conflict';
        e.message = 'The earlier correction was saved. Your newer proposed text is retained locally; explicitly reapply or discard it.';
      }
      persistDraft(id, e);
      project(id);
      emit();
      for (const o of observers) o(id);
      return { ok: true, changed: true };
    } catch (error) {
      if (e && !disposed && session === generation) {
        e.status = 'conflict';
        e.message = `The project source was not saved: ${message(error)} Your draft is retained. Refresh and choose whether to reapply it.`;
        try {
          const latest = await repo!.get(id);
          if (!disposed && session === generation) {
            e.document = latest;
            project(id);
          }
        } catch {
          /* Retain reference and draft, never trust cached content as authority. */
        }
        emit();
      }
      return fail('source_conflict', message(error));
    }
  };
  const associate = async (
    document: ProjectTranscriptDocument,
    assetId: string,
    previousItems?: readonly SourceFrozenDataItem[],
  ): Promise<TranscriptPanelImportReceipt> => {
    const data = current();
    if (mediaId(assetId) !== document.content.media_id)
      throw new Error(
        'The selected transcript belongs to different source media.',
      );
    const old = data.sourceItemsBySchemaRef?.[TRANSCRIPT_SCHEMA_REF] ?? [];
    const replaced = old.filter(
      (i) => i.sourceArtifactRef.assetId === assetId,
    ).length;
    const previousRow = (data.transcriptReferences?.associations ?? []).find(
      (r) => r.assetId === assetId,
    );
    const associations = [
      ...(data.transcriptReferences?.associations ?? []).filter(
        (r) => r.assetId !== assetId,
      ),
      {
        assetId,
        documentId: document.document_id,
        // Keep the optional Agent-written ids only on a row that had them,
        // refreshed to the newly selected document; never invent them.
        ...(previousRow?.mediaId !== undefined
          ? { mediaId: document.content.media_id }
          : {}),
        ...(previousRow?.sourceId !== undefined
          ? { sourceId: document.content.source_id }
          : {}),
      },
    ];
    const projected = projectTranscriptItems(document, assetId);
    const config = reconcileTranscriptReferences(
      data.config,
      previousItems ?? old,
      projected,
      assetId,
      document.content.source_id,
    );
    const next = input.items ? preparePersistedDataKindItems(data, TRANSCRIPT_SCHEMA_REF,
      old.filter((item) => item.sourceArtifactRef.assetId !== assetId ||
        (item.provenance.adapterId !== 'astrid.projectTranscript' && payloadOf(item).sourceId !== document.content.source_id)), {
        config,
        transcriptReferences: { schema: 'media.transcript.references/v1', associations },
      }) : buildDataFromCurrentRegistry(config, data, {
      transcriptReferences: {
        schema: 'media.transcript.references/v1',
        associations,
      },
      sourceItemsBySchemaRef: {
        ...data.sourceItemsBySchemaRef,
        [TRANSCRIPT_SCHEMA_REF]: [
          ...old.filter(
            (i) =>
              i.sourceArtifactRef.assetId !== assetId ||
              (i.provenance.adapterId !== 'astrid.projectTranscript' &&
                payloadOf(i).sourceId !== document.content.source_id),
          ),
          ...projected,
        ],
      },
    });
    input.commitData(next, { save: true, semantic: true });
    adopt(document.document_id, document, assetId);
    let associationSaved = false,
      reason: string | undefined;
    try {
      if (!input.flushPendingSave)
        throw new Error('Timeline save acknowledgement unavailable.');
      await input.flushPendingSave();
      associationSaved = true;
    } catch (e) {
      reason = `Project transcript saved. Timeline association is still unsaved: ${message(e)} Retry selecting this project source after resolving the timeline save.`;
    }
    return {
      assetId,
      sourceId: document.content.source_id,
      documentId: document.document_id,
      version: document.version,
      importedSegments: document.content.segments.length,
      replacedSegments: replaced,
      replacedExistingSource: replaced > 0,
      associationSaved,
      ...(reason ? { message: reason } : {}),
    };
  };
  const invalidation = (id: string) => {
    if (entries.has(id)) void refreshSources();
  };
  const host: ProjectTranscriptHost = {
    start: () => {
      disposed = false;
      observers.add(invalidation);
      stopDocuments = repo?.onChange?.(() => void refreshSources());
      if (!timer) timer = setInterval(() => void refreshSources(), 2000);
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    dispose: () => {
      disposed = true;
      invalidateDocuments();
      generation++;
      selection++;
      clearInterval(timer);
      timer = undefined;
      observers.delete(invalidation);
      stopDocuments?.();
      stopDocuments = undefined;
      input.items?.replaceTransient(TRANSCRIPT_SCHEMA_REF, []);
      input.pendingWork?.report({ writing: false, unsaved: false });
      listeners.clear();
    },
    getTimelineLaneVisible: () => input.getTimelineLaneVisible?.() ?? false,
    setTimelineLaneVisible: (visible) => {
      input.setTimelineLaneVisible?.(visible);
      emit();
    },
    getProjectState: () => state,
    refreshSources,
    listProjectSources: async (assetId, playedRegistry) => {
      supported();
      const media = transcriptMediaIdFromAsset(assets.get(assetId) ?? playedRegistry?.assets[assetId]);
      const documents = await documentsForMedia(media);
      const associated = (current().transcriptReferences?.associations ?? []).some(
        (ref) => ref.assetId === assetId,
      );
      if (!associated) {
        const fallback =
          documents.find((d) => d.content.source_id === 'astrid.narration') ??
          (documents.length === 1 ? documents[0] : undefined);
        if (fallback) {
          let entry = entries.get(fallback.document_id);
          if (!entry) {
            entry = {
              assetId,
              fallback: true,
              document: fallback,
              status: 'clean',
              undo: [],
              redo: [],
            };
            entries.set(fallback.document_id, entry);
          } else {
            entry.fallback = true;
            entry.assetId = assetId;
            entry.document = fallback;
          }
          queueFallbackProjection(fallback.document_id);
        }
      }
      return documents.map((d) => ({
        documentId: d.document_id,
        sourceId: d.content.source_id,
        version: d.version,
      }));
    },
    selectProjectSource: async ({ assetId, documentId }) => {
      const operation = ++selection;
      const r = supported();
      const d = await r.get(documentId);
      current();
      if (operation !== selection)
        throw new Error('Source selection was superseded.');
      return associate(d, assetId);
    },
    importTranscript: async ({ document, associationAssetId }) => {
      const operation = ++selection;
      const r = supported(),
        data = current(),
        parsed = parseTranscriptDocument(document);
      const assetId = resolveAssociatedAssetId(
        parsed.assetId,
        associationAssetId,
      );
      assertRegisteredTranscriptMedia(data, assetId);
      const media = mediaId(assetId);
      if (parsed.mediaId && parsed.mediaId !== media)
        throw new Error(
          'Transcript media_id does not match the selected project source media.',
        );
      const content = importedContent(
          media,
          parsed.sourceId ?? 'default',
          parsed.segments,
        ),
        id = await transcriptDocumentId(r.projectId, media, content.source_id);
      const loaded = entries.get(id)?.document;
      let existing: ProjectTranscriptDocument | undefined;
      try {
        existing = await r.get(id);
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
      current();
      if (operation !== selection)
        throw new Error('Transcript import was superseded.');
      let d: ProjectTranscriptDocument;
      let importedBefore = false;
      try {
        importedBefore =
          localStorage.getItem(key(id) + ':import') === JSON.stringify(content);
      } catch {
        /* Browser storage may be disabled; in-memory source state remains available. */
      }
      if (existing) {
        if (sameTranscript(existing.content, content) || importedBefore)
          d = existing;
        else {
          if (!loaded || loaded.version !== existing.version)
            throw new Error(
              'This project transcript already exists with different content. Select it first, inspect the current version, then explicitly reimport to replace it.',
            );
          const result = await write(id, content);
          if (!result.ok) throw new Error(result.message);
          d = entries.get(id)!.document!;
        }
      } else {
        d = await r.create(content, `astrid.transcript-create.${id.slice('transcript:'.length)}`);
        invalidateDocuments();
        current();
      }
      if (operation !== selection)
        throw new Error(
          'Transcript import saved to the project, but its timeline selection was superseded.',
        );
      try {
        localStorage.setItem(key(id) + ':import', JSON.stringify(content));
      } catch {
        /* Browser storage may be disabled; in-memory source state remains available. */
      }
      return associate(
        d,
        assetId,
        input.items?.readPersisted(TRANSCRIPT_SCHEMA_REF) ?? data.sourceItemsBySchemaRef?.[TRANSCRIPT_SCHEMA_REF],
      );
    },
    promoteSource: async ({ assetId, sourceId }) => {
      const operation = ++selection;
      const r = supported(),
        data = current(),
        media = mediaId(assetId);
      const items = (
        input.items?.readPersisted(TRANSCRIPT_SCHEMA_REF) ?? data.sourceItemsBySchemaRef?.[TRANSCRIPT_SCHEMA_REF] ?? []
      ).filter(
        (i) =>
          i.sourceArtifactRef.assetId === assetId &&
          payloadOf(i).sourceId === sourceId,
      );
      const content = contentFromItems(media, sourceId, items),
        id = await transcriptDocumentId(r.projectId, media, sourceId);
      let d: ProjectTranscriptDocument;
      try {
        d = await r.get(id);
        if (!sameTranscript(d.content, content))
          throw new Error(
            'Project transcript differs from this timeline-local source. Both are preserved. Select the project source to reuse it, or import with a different explicit source ID to keep both.',
          );
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        d = await r.create(content, `astrid.transcript-create.${id.slice('transcript:'.length)}`);
      }
      current();
      if (operation !== selection)
        throw new Error(
          'Transcript promotion was superseded; any saved project document remains available.',
        );
      return associate(d, assetId);
    },
    stageTextDraft: (edit) => {
      try {
        supported();
        const item = resolveEditItem(edit);
        const id = (item?.payload as { documentId?: string })?.documentId;
        if (!id || (edit.documentId && edit.documentId !== id))
          return fail(
            'source_identity_changed',
            'The selected source changed. Keep this draft and select its original project transcript.',
          );
        const e = entries.get(id);
        if (!e?.document)
          return fail(
            'source_not_loaded',
            'Refresh the project source before editing.',
          );
        const staleBase = edit.baseVersion !== undefined && edit.baseVersion !== e.document.version;
        const result = editTranscriptText(
          {
            [TRANSCRIPT_SCHEMA_REF]: projectTranscriptItems(
              e.document,
              e.assetId,
            ),
          },
          edit,
        );
        if (!result.ok) return result;
        e.draft = {
          // A stale proposal is recoverable, but never silently adopts the new
          // version as permission to save. Reapply remains an explicit action.
          baseVersion: edit.baseVersion ?? e.document.version,
          content: contentFromItems(
            e.document.content.media_id,
            e.document.content.source_id,
            result.sourceItemsBySchemaRef[TRANSCRIPT_SCHEMA_REF],
          ),
        };
        persistDraft(id, e);
        if (staleBase) {
          e.status = 'conflict';
          e.message = 'The project source changed while you were drafting. Your proposed text is saved locally. Compare it and explicitly reapply or discard the draft.';
          emit();
          return fail('source_conflict', e.message);
        }
        emit();
        return { ok: true, changed: result.changed };
      } catch (e) {
        return fail('source_unavailable', message(e));
      }
    },
    editText: async (edit) => {
      try {
        supported();
        const item = resolveEditItem(edit);
        const id = (item?.payload as { documentId?: string })?.documentId;
        if (edit.documentId && edit.documentId !== id)
          return fail(
            'source_identity_changed',
            'The selected project source changed. Keep your draft and select its original source.',
          );
        if (!id)
          return fail(
            'source_local',
            'This is a timeline-local transcript. Save it to the project before correcting shared source text.',
          );
        const e = entries.get(id);
        if (!e?.document)
          return fail(
            'source_not_loaded',
            'Refresh this project transcript before editing.',
          );
        if (
          edit.baseVersion !== undefined &&
          edit.baseVersion !== e.document.version
        )
          return fail(
            'source_conflict',
            'This draft belongs to an older source version. Refresh and explicitly reapply or discard it.',
          );
        const result = editTranscriptText(
          {
            [TRANSCRIPT_SCHEMA_REF]: projectTranscriptItems(
              e.document,
              e.assetId,
            ),
          },
          edit,
        );
        if (!result.ok) return result;
        if (!result.changed) return { ok: true, changed: false };
        return write(
          id,
          contentFromItems(
            e.document.content.media_id,
            e.document.content.source_id,
            result.sourceItemsBySchemaRef[TRANSCRIPT_SCHEMA_REF],
          ),
        );
      } catch (e) {
        return fail('source_unavailable', message(e));
      }
    },
    undoSource: async (id) => {
      const e = entries.get(id);
      return e?.undo.length
        ? write(id, e.undo[e.undo.length - 1], 'undo')
        : { ok: true, changed: false };
    },
    redoSource: async (id) => {
      const e = entries.get(id);
      return e?.redo.length
        ? write(id, e.redo[e.redo.length - 1], 'redo')
        : { ok: true, changed: false };
    },
    resolveSourceConflict: async (id, choice) => {
      const e = entries.get(id);
      if (!e?.draft || !e.document)
        return fail('source_no_draft', 'No saved source draft is available.');
      if (choice === 'discard') {
        const wasConflict = e.status === 'conflict';
        e.draft = undefined;
        e.status = 'clean';
        e.message = undefined;
        if (wasConflict) {
          e.undo = [];
          e.redo = [];
        }
        persistDraft(id, e);
        project(id);
        emit();
        return { ok: true, changed: false };
      }
      const draft = e.draft;
      e.status = 'clean';
      return write(id, draft.content);
    },
  };
  const tracked =
    <Args extends unknown[], Result>(fn: (...args: Args) => Result) =>
    async (...args: Args): Promise<Awaited<Result>> => {
      pendingOperations++;
      emit();
      try {
        return await fn(...args);
      } finally {
        pendingOperations--;
        emit();
      }
    };
  return {
    ...host,
    importTranscript: tracked(host.importTranscript),
    selectProjectSource: tracked(host.selectProjectSource),
    promoteSource: tracked(host.promoteSource),
  };
}

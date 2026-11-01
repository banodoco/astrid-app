/**
 * A compact trusted panel example using the public transcript and project-object contracts.
 * Hosts still own persistence and source-time validation; this adapter keeps the extension side
 * typed against the versioned SDK surface.
 */
import type {
  ImmutableProjectPackageDescriptor,
  PanelClipDragProps,
  PanelClipSpec,
  PanelFrameAnchor,
  PanelPreviewService,
  PanelRenderProps,
  PanelVideoAdapter,
  ProjectObjectMetadata,
  ProjectObjectStorage,
  TranscriptMediaChoice,
  TranscriptOccurrence,
  TranscriptPanelAdapter,
  TranscriptPanelImportReceipt,
  TranscriptPanelSnapshot,
  TranscriptPanelTextEdit,
  TranscriptPanelTextEditResult,
  TranscriptPlaybackState,
  TranscriptProjectSourceChoice,
  TranscriptProjectSourceState,
  TranscriptProjectState,
  TranscriptSeekResult,
  TranscriptSelection,
  TranscriptSourceIdentity,
  TranscriptSourceRow,
  TranscriptSourceWordView,
  TranscriptWordProjection,
} from '@astrid/editor-sdk';

const sourceWord: TranscriptSourceWordView = {
  id: 'word-1',
  text: 'Hello',
  start: 0,
  end: 0.5,
};

const sourceRow: TranscriptSourceRow = {
  sourceItemId: 'source-item-1',
  sourceId: 'transcript:asset-1',
  assetId: 'asset-1',
  documentId: 'transcript-document-1',
  documentVersion: 1,
  start: 0,
  end: 1,
  text: 'Hello there',
  speaker: 'Speaker 1',
  words: [sourceWord],
};

const wordProjection: TranscriptWordProjection = {
  ...sourceWord,
  timing: 'word',
  timelineStart: 2,
  timelineEnd: 2.5,
};

const occurrence: TranscriptOccurrence = {
  id: 'occurrence-1',
  sourceItemId: sourceRow.sourceItemId,
  sourceId: sourceRow.sourceId,
  assetId: sourceRow.assetId,
  clipId: 'clip-1',
  timelineStart: 2,
  timelineEnd: 3,
  words: [wordProjection],
};

const mediaChoice: TranscriptMediaChoice = {
  assetId: sourceRow.assetId,
  label: 'Interview audio',
  kind: 'audio',
};

const sourceChoice: TranscriptProjectSourceChoice = {
  documentId: sourceRow.documentId!,
  sourceId: sourceRow.sourceId,
  version: sourceRow.documentVersion!,
};

const projectSource: TranscriptProjectSourceState = {
  ...sourceChoice,
  assetId: sourceRow.assetId,
  status: 'clean',
  canUndo: false,
  canRedo: false,
  hasDraft: false,
};

const projectState: TranscriptProjectState = {
  supported: true,
  sources: [projectSource],
};

const snapshot: TranscriptPanelSnapshot = {
  sources: [sourceRow],
  occurrences: [occurrence],
};

export function createTranscriptPanelExampleAdapter(): TranscriptPanelAdapter {
  let laneVisible = true;
  const projectSources: readonly TranscriptProjectSourceChoice[] = [sourceChoice];
  const receipt: TranscriptPanelImportReceipt = {
    assetId: sourceRow.assetId,
    sourceId: sourceRow.sourceId,
    importedSegments: 1,
    replacedSegments: 0,
    replacedExistingSource: false,
    documentId: sourceChoice.documentId,
    version: sourceChoice.version,
    associationSaved: true,
  };
  const unchanged: TranscriptPanelTextEditResult = { ok: true, changed: false };
  const playback: TranscriptPlaybackState = {
    playing: [occurrence],
    focused: occurrence,
    assetId: sourceRow.assetId,
    sourceId: sourceRow.sourceId,
    playingWordIds: [sourceWord.id],
  };

  const adapter: TranscriptPanelAdapter = {
    getTimelineLaneVisible: () => laneVisible,
    setTimelineLaneVisible: (visible) => { laneVisible = visible; },
    stageTextDraft: (edit: TranscriptPanelTextEdit) => ({ ok: true, changed: edit.text !== sourceRow.text }),
    getProjectState: () => projectState,
    listProjectSources: async (assetId) => assetId === sourceRow.assetId ? projectSources : [],
    selectProjectSource: async () => receipt,
    promoteSource: async () => receipt,
    undoSource: async () => unchanged,
    redoSource: async () => unchanged,
    resolveSourceConflict: async (_documentId, _choice) => unchanged,
    refreshSources: async () => undefined,
    getMediaChoices: () => [mediaChoice],
    editText: () => unchanged,
    importTranscript: async () => receipt,
    getSnapshot: () => snapshot,
    subscribe: () => ({ dispose: () => undefined }),
    getPlayback: (_selection: TranscriptSelection) => playback,
    selectSource: (selection: TranscriptSelection, _source: TranscriptSourceIdentity) => selection,
    seek: (_target): TranscriptSeekResult => ({ ok: true, seconds: wordProjection.timelineStart!, timing: 'word' }),
  };
  return adapter;
}

/** A panel renderer reads the host-provided adapter and leaves playback mutation to the host. */
export function readTranscriptPanelExample(props: PanelRenderProps): TranscriptPanelSnapshot | undefined {
  const video: PanelVideoAdapter | undefined = props.video;
  return video?.transcript?.getSnapshot();
}

/** Start a word preview on hover; the caller invokes the returned cleanup on leave or teardown. */
export function previewTranscriptWordOnHover(
  props: PanelRenderProps,
  word: TranscriptWordProjection,
  target: Pick<HTMLElement, 'getBoundingClientRect'>,
): (() => void) | undefined {
  const preview: PanelPreviewService | undefined = props.video?.preview;
  if (
    !props.visible
    || !preview
    || word.timing !== 'word'
    || word.timelineStart === null
    || !Number.isFinite(word.timelineStart)
    || word.timelineStart < 0
  ) {
    return undefined;
  }

  const rect = target.getBoundingClientRect();
  const anchor: PanelFrameAnchor = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  const handle = preview.showFrame({ seconds: word.timelineStart, anchor });
  return () => { handle.dispose(); };
}

/** Show a host-rendered frame while visible; dispose the returned handle when the hover ends. */
export function previewTranscriptFrame(props: PanelRenderProps, seconds: number, anchor: PanelFrameAnchor) {
  if (!props.visible) return undefined;
  const preview: PanelPreviewService | undefined = props.video?.preview;
  return preview?.showFrame({ seconds, anchor });
}

/** Import a transcript package through immutable host storage and keep its digest as the revision. */
export async function ingestTranscriptPackage(
  storage: ProjectObjectStorage,
  bytes: Uint8Array,
): Promise<ImmutableProjectPackageDescriptor> {
  const entry: ProjectObjectMetadata = await storage.ingest(bytes, 'application/json', 'transcript.json');
  return {
    revision: entry.digest,
    manifest: { kind: 'transcript-example', version: 1 },
    entry,
    assets: [],
  };
}

/**
 * Make an element a timeline drag source: spread the result on it. Dropping on the timeline inserts the
 * clip at the drop time and track. Null means nothing can be dragged (invalid spec, a clip type this
 * extension does not own, or a host without a timeline).
 */
export function clipDragProps(props: PanelRenderProps, spec: PanelClipSpec): PanelClipDragProps | null {
  return props.video?.dragSource?.(spec) ?? null;
}

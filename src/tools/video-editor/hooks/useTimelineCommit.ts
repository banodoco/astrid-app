import {
  useCallback,
  useEffect,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { TimelineGestureReadBasis } from './timelineLocalSaveHandoff.ts';
import { VideoEditorRuntimeContext } from '@/tools/video-editor/contexts/VideoEditorRuntimeContext.tsx';
import {
  editorClearTimelineSelection,
  editorSelectTimelineClip,
  editorSetSelectedTrackId,
  useTimelineSelectionStore,
} from '@/shared/state/selectionStore.ts';
import { TimelineEventBus } from '@/tools/video-editor/hooks/useTimelineEventBus.ts';
import { buildTrackClipOrder } from '@/tools/video-editor/lib/coordinate-utils.ts';
import { migrateToFlatTracks } from '@/tools/video-editor/lib/migrate.ts';
import { serializeResolvedTimelineEdit, withHeldClipSourceFields, TIMELINE_CLIP_FIELDS } from '@/tools/video-editor/lib/serialize.ts';
import { getConfigSignature } from '@/tools/video-editor/lib/config-utils.ts';
import { buildDataFromCurrentRegistry } from '@/tools/video-editor/lib/timeline-save-utils.ts';
import { buildAssetReferenceMap, getAssetMediaId, getAssetResolutionToken, getAssetSourceForLocalEdit } from '@/tools/video-editor/lib/asset-registry.ts';
import {
  assembleTimelineData,
  preserveUploadingClips,
  rowsToConfig,
  type ClipMeta,
  type ClipOrderMap,
  type TimelineData,
} from '@/tools/video-editor/lib/timeline-data.ts';
import type {
  TimelineCommandHistoryMetadata,
  TimelineCommandTransaction,
} from '@/tools/video-editor/commands/index.ts';
import {
  applyPreparedMediaCommand,
  type PlacePreparedMediaCommand,
} from '@/tools/video-editor/commands/media.ts';
import type { TimelineRow } from '@/tools/video-editor/types/timeline-canvas.ts';
import type { AssetRegistryEntry } from '@/tools/video-editor/types/index.ts';
import type { TimelineEditability } from '@/tools/video-editor/lib/timeline-editability.ts';

export type CommandHistoryCommitMetadata = {
  transaction: TimelineCommandTransaction;
  history: TimelineCommandHistoryMetadata;
};

export type CommitHistoryOptions = {
  transactionId?: string;
  semantic?: boolean;
  commandHistory?: CommandHistoryCommitMetadata;
};

export type CommitDataOptions = {
  gestureBasis?: TimelineGestureReadBasis;
  save?: boolean;
  selectedClipId?: string | null;
  selectedTrackId?: string | null;
  updateLastSavedSignature?: boolean;
  transactionId?: string;
  semantic?: boolean;
  skipHistory?: boolean;
  commandHistory?: CommandHistoryCommitMetadata;
};

export type ScheduleSaveFn = (
  nextData: TimelineData,
  options?: { preserveStatus?: boolean; gestureBasis?: TimelineGestureReadBasis },
) => void;

/**
 * The one mutation vocabulary every timeline edit passes through (`applyEdit`).
 *
 * Pick the variant by *what you already know*, not by size of change:
 *
 * @example Move a single clip in time — a `'rows'` edit, the shape the drag
 * machine commits (`useClipDrag.helpers.ts`):
 * ```ts
 * const nextRows = rows.map((row) => (row.id === clip.track
 *   ? { ...row, actions: row.actions.map((a) => (a.id === clipId
 *       ? { ...a, start: nextStart, end: nextStart + (a.end - a.start) }
 *       : a)) }
 *   : row));
 *
 * applyEdit(
 *   { type: 'rows', rows: nextRows, metaUpdates: { [clipId]: { track: clip.track } } },
 *   { transactionId, selectedClipId: clipId },
 * );
 * ```
 */
export type TimelineEditMutation =
  /**
   * Bulk declarative edit in row shape: hand over the rows you want, plus any
   * per-clip metadata to merge (`metaUpdates`) or drop (`metaDeletes`). This is
   * what multi-drag, group moves and single-clip moves/trims all use — the
   * commit layer diffs it into the timeline. `clipOrderOverride` pins per-track
   * ordering when the geometry alone would be ambiguous.
   */
  | {
      type: 'rows';
      rows: TimelineRow[];
      metaUpdates?: Record<string, Partial<ClipMeta>>;
      metaDeletes?: string[];
      clipOrderOverride?: ClipOrderMap;
      pinnedShotGroupsOverride?: TimelineData['config']['pinnedShotGroups'];
      registryOverride?: TimelineData['registry'];
    }
  /**
   * Full `resolvedConfig` replacement — the big hammer. For edits that are not
   * expressible as rows (imports, whole-timeline transforms, track structure
   * changes). Everything downstream re-derives from the new config.
   */
  | {
      type: 'config';
      resolvedConfig: TimelineData['resolvedConfig'];
      pinnedShotGroupsOverride?: TimelineData['config']['pinnedShotGroups'];
    }
  /** Pinned shot groups only; clips and rows are left exactly as they are. */
  | {
      type: 'pinnedShotGroups';
      pinnedShotGroups: NonNullable<TimelineData['config']['pinnedShotGroups']>;
    }
  | {
      type: 'prepared-media';
      command: PlacePreparedMediaCommand;
    };

export type ApplyEditOptions = {
  gestureBasis?: TimelineGestureReadBasis;
  /**
   * Persist this edit (default: the commit layer's own scheduling). Set `false`
   * for intermediate states you do not want written back — e.g. a step inside a
   * gesture that a later commit in the same transaction will supersede.
   */
  save?: boolean;
  /** Selection to apply alongside the edit, so selection and data land in one commit. */
  selectedClipId?: string | null;
  /** Selected track to apply alongside the edit. */
  selectedTrackId?: string | null;
  /**
   * Coalescing key for undo history: every edit sharing a `transactionId`
   * collapses into one undo step. A drag emits many `applyEdit` calls under one
   * id, so ⌘Z undoes the drag, not its last frame.
   */
  transactionId?: string;
  /**
   * Marks a *user-meaningful* edit (a deliberate action) rather than a
   * mechanical/derived one. Semantic edits are what history records and what
   * undo lands on; non-semantic ones ride along with the surrounding step.
   */
  semantic?: boolean;
  /**
   * Suppress the undo entry for this commit while still saving it. For
   * background/system repairs that are not user edits (e.g. pinned-group
   * sync): the change persists, but ⌘Z will not land on it — undoing a
   * repair the user never made reads as "undo did nothing".
   */
  skipHistory?: boolean;
  /** Explicit command-history metadata when the caller is the command layer. */
  commandHistory?: CommandHistoryCommitMetadata;
};

interface UseTimelineCommitOptions {
  eventBus: TimelineEventBus;
  lastSavedSignatureRef: MutableRefObject<string>;
  editability?: TimelineEditability;
  initialData?: TimelineData;
  resolveAssetUrl?: (reference: string) => Promise<string>;
}

export type OwnedRegistryMutation = Readonly<{ assetId: string; editSeq: number }>;

export interface UseTimelineCommitResult {
  data: TimelineData | null;
  dataRef: MutableRefObject<TimelineData | null>;
  selectedClipId: string | null;
  selectedTrackId: string | null;
  setSelectedTrackId: Dispatch<SetStateAction<string | null>>;
  applyEdit: (mutation: TimelineEditMutation, options?: ApplyEditOptions) => void;
  patchRegistry: (assetId: string, entry: AssetRegistryEntry, src?: string) => void;
  unpatchRegistry: (assetId: string) => void;
  patchRegistryOwned: (assetId: string, entry: AssetRegistryEntry, src?: string) => OwnedRegistryMutation;
  ownsRegistryMutation: (receipt: OwnedRegistryMutation) => boolean;
  canRollbackRegistryMutation: (receipt: OwnedRegistryMutation) => boolean;
  rollbackRegistryMutation: (receipt: OwnedRegistryMutation) => boolean;
  commitData: (nextData: TimelineData, options?: CommitDataOptions) => void;
  materializeData: (
    current: TimelineData,
    rows: TimelineRow[],
    meta: Record<string, ClipMeta>,
    clipOrder: ClipOrderMap,
  ) => TimelineData;
  editSeqRef: MutableRefObject<number>;
  pendingOpsRef: MutableRefObject<number>;
  selectedClipIdRef: MutableRefObject<string | null>;
  selectedTrackIdRef: MutableRefObject<string | null>;
}

const TIMELINE_CLIP_FIELD_SET = new Set<string>(TIMELINE_CLIP_FIELDS);

/**
 * Rows are a display projection. A rows edit must overlay its canonical fields
 * on the authored clip while carrying forward source-owned extension fields
 * that are intentionally outside the editor's closed clip schema.
 */
const preserveAuthoredClipExtensions = (
  authoredConfig: TimelineData['config'],
  materializedConfig: TimelineData['config'],
): TimelineData['config'] => {
  const authoredClips = new Map(authoredConfig.clips.map((clip) => [clip.id, clip] as const));
  return {
    ...materializedConfig,
    clips: materializedConfig.clips.map((clip) => {
      const authored = authoredClips.get(clip.id);
      if (!authored) return clip;
      const extensions = Object.fromEntries(
        Object.entries(structuredClone(authored)).filter(([key]) => !TIMELINE_CLIP_FIELD_SET.has(key)),
      );
      return { ...extensions, ...clip };
    }),
  };
};

export function useTimelineCommit({
  eventBus,
  lastSavedSignatureRef,
  editability,
  initialData,
  resolveAssetUrl,
}: UseTimelineCommitOptions): UseTimelineCommitResult {
  const registryOwnersRef = useRef(new Map<string, OwnedRegistryMutation>());
  const registryReceiptsRef = useRef(new WeakMap<OwnedRegistryMutation, {
    entry: AssetRegistryEntry;
    signature: string;
    src: string;
    previousEntry: AssetRegistryEntry | undefined;
    previousResolved: TimelineData['resolvedConfig']['registry'][string] | undefined;
  }>());
  const selectionOwner = useContext(VideoEditorRuntimeContext)?.agentSelectionOwner;
  const editSeqRef = useRef(0);
  const pendingOpsRef = useRef(0);
  const dataRef = useRef<TimelineData | null>(initialData ?? null);
  const selectedClipIdRef = useRef<string | null>(null);
  const selectedTrackIdRef = useRef<string | null>(null);
  const [data, setData] = useState<TimelineData | null>(() => initialData ?? null);
  const initialSelectionSeededRef = useRef(false);
  const {
    selectedClipId,
    selectedTrackId,
  } = useTimelineSelectionStore(selectionOwner);
  const setSelectedTrackId = useCallback<Dispatch<SetStateAction<string | null>>>((updater) => {
    const nextTrackId = typeof updater === 'function'
      ? updater(selectedTrackIdRef.current)
      : updater;
    editorSetSelectedTrackId(nextTrackId, selectionOwner);
  }, [selectionOwner]);

  useLayoutEffect(() => {
    dataRef.current = data;
    selectedClipIdRef.current = selectedClipId;
    selectedTrackIdRef.current = selectedTrackId;
  }, [data, selectedClipId, selectedTrackId]);

  useLayoutEffect(() => {
    if (!initialData || initialSelectionSeededRef.current) return;
    initialSelectionSeededRef.current = true;
    eventBus.emit('pruneSelection', new Set(Object.keys(initialData.meta)));
    const firstTrackId = initialData.tracks[0]?.id ?? null;
    selectedTrackIdRef.current = firstTrackId;
    editorSetSelectedTrackId(firstTrackId, selectionOwner);
  }, [eventBus, initialData, selectionOwner]);

  useEffect(() => {
    if (!data || !resolveAssetUrl) return;
    const unresolved = Object.entries(data.registry.assets).filter(([assetId, entry]) => {
      const resolved = data.resolvedConfig.registry[assetId];
      return getAssetResolutionToken(entry)
        && (!resolved?.src || resolved.src === getAssetMediaId(entry)
          || getAssetResolutionToken(resolved) !== getAssetResolutionToken(entry));
    });
    if (unresolved.length === 0) return;
    let cancelled = false;
    void Promise.all(unresolved.map(async ([assetId, entry]) => {
      try {
        const src = await resolveAssetUrl(getAssetResolutionToken(entry)!);
        return src && src !== getAssetMediaId(entry) ? [assetId, { ...entry, src }] as const : null;
      } catch {
        return null;
      }
    })).then((results) => {
      // A later edit/reload owns its own resolution pass. Never attach a
      // response to a replaced asset or resurrect an older timeline snapshot.
      if (cancelled || dataRef.current !== data) return;
      const resolved = results.filter((item) => item !== null);
      if (resolved.length === 0) return;
      const registry = { ...data.resolvedConfig.registry, ...Object.fromEntries(resolved) };
      const next = {
        ...data,
        resolvedConfig: {
          ...data.resolvedConfig,
          registry,
          clips: data.resolvedConfig.clips.map((clip) => ({
            ...clip, assetEntry: clip.asset ? registry[clip.asset] : undefined,
          })),
        },
      };
      // Preview hydration is not a document edit: no save, history, or draft
      // mutation, and the persisted registry keeps its managed identities.
      next.signature = getConfigSignature(next.resolvedConfig);
      dataRef.current = next;
      setData(next);
    });
    return () => { cancelled = true; };
  }, [data, resolveAssetUrl]);

  const withPinnedShotGroups = useCallback((
    config: TimelineData['config'],
    pinnedShotGroups: TimelineData['config']['pinnedShotGroups'],
  ): TimelineData['config'] => ({
    ...config,
    pinnedShotGroups: pinnedShotGroups && pinnedShotGroups.length > 0
      ? pinnedShotGroups
      : undefined,
  }), []);

  const materializeData = useCallback((
    current: TimelineData,
    rows: TimelineRow[],
    meta: Record<string, ClipMeta>,
    clipOrder: ClipOrderMap,
    registryOverride?: TimelineData['registry'],
  ) => {
    // Soft-tag model: cohesion is a property of edit operations, not data shape.
    // rowsToConfig receives the untouched pinnedShotGroups from the current config;
    // callers that need to update group membership must pass `pinnedShotGroupsOverride`
    // explicitly on the mutation, which `applyEdit` handles below.
    const materializedConfig = withHeldClipSourceFields(rowsToConfig(
      rows,
      meta,
      current.output,
      clipOrder,
      current.tracks,
      current.config.pinnedShotGroups,
      current.config,
    ), meta);
    const config = preserveAuthoredClipExtensions(current.config, materializedConfig);

    const registry = registryOverride ?? current.registry;
    const resolvedRegistry = Object.fromEntries(
      Object.entries(registry.assets ?? {}).flatMap(([assetId, entry]) => {
        const src = getAssetSourceForLocalEdit(entry, current.resolvedConfig.registry[assetId]);
        return src ? [[assetId, { ...entry, src }] as const] : [];
      }),
    );

    return preserveUploadingClips(
      { ...current, rows, meta } as TimelineData,
      buildDataFromCurrentRegistry(config, current, { registry, resolvedRegistry }),
    );
  }, []);

  const commitData = useCallback((
    nextData: TimelineData,
    options?: CommitDataOptions,
  ) => {
    const shouldSave = options?.save ?? true;
    const currentData = dataRef.current;
    if (options?.skipHistory && options?.updateLastSavedSignature) registryOwnersRef.current.clear();
    for (const [assetId, receipt] of registryOwnersRef.current) {
      const owned = registryReceiptsRef.current.get(receipt);
      if (!owned || nextData.registry.assets[assetId] !== owned.entry) registryOwnersRef.current.delete(assetId);
    }

    if (shouldSave && !options?.skipHistory && currentData) {
      eventBus.emit('beforeCommit', currentData, {
        transactionId: options?.transactionId,
        semantic: options?.semantic,
        commandHistory: options?.commandHistory,
      });
    }

    // `skipHistory` + `updateLastSavedSignature` is the signature of a
    // server-authoritative replacement (poll acceptance, conflict reload,
    // registry refresh) — every such call site passes both. Announce it so
    // history can drop undo entries that would resurrect pre-remote state.
    if (options?.skipHistory && options?.updateLastSavedSignature && currentData) {
      eventBus.emit('remoteCommit', currentData, nextData);
    }

    dataRef.current = nextData;
    setData(nextData);

    if (options?.selectedClipId !== undefined) {
      selectedClipIdRef.current = options.selectedClipId;
      if (options.selectedClipId === null) {
        editorClearTimelineSelection(selectionOwner);
      } else {
        editorSelectTimelineClip(options.selectedClipId, selectionOwner);
      }
    } else if (selectedClipIdRef.current && !nextData.meta[selectedClipIdRef.current]) {
      selectedClipIdRef.current = null;
      editorClearTimelineSelection(selectionOwner);
    }

    eventBus.emit('pruneSelection', new Set(Object.keys(nextData.meta)));

    if (options?.selectedTrackId !== undefined) {
      selectedTrackIdRef.current = options.selectedTrackId;
      editorSetSelectedTrackId(options.selectedTrackId, selectionOwner);
    } else {
      const fallbackTrackId = selectedTrackIdRef.current
        && nextData.tracks.some((track) => track.id === selectedTrackIdRef.current)
        ? selectedTrackIdRef.current
        : nextData.tracks[0]?.id ?? null;
      selectedTrackIdRef.current = fallbackTrackId;
      editorSetSelectedTrackId(fallbackTrackId, selectionOwner);
    }

    if (options?.updateLastSavedSignature) {
      lastSavedSignatureRef.current = nextData.stableSignature;
    }

    if (shouldSave) {
      editSeqRef.current += 1;
      eventBus.emit('localCommit', currentData, nextData);
      if (options?.gestureBasis) eventBus.emit('scheduleSave', nextData, { gestureBasis: options.gestureBasis });
      else eventBus.emit('scheduleSave', nextData);
    }
  }, [eventBus, lastSavedSignatureRef, selectionOwner]);

  const applyEdit = useCallback((
    mutation: TimelineEditMutation,
    options?: ApplyEditOptions,
  ) => {
    // Re-check runtime permission at the shared commit boundary. Gesture/UI
    // checks can go stale while a canonical shot head is being adopted.
    if (editability?.checkTimeline && !editability.checkTimeline().allowed) {
      return;
    }

    const current = dataRef.current;
    if (!current) {
      // The timeline isn't loaded yet. Emit a lost-edit event rather than
      // dropping the user's edit silently, so the write-ack watchdog can make
      // the loss visible.
      eventBus.emit('lostEdit');
      return;
    }

    if (mutation.type === 'prepared-media') {
      const prepared = applyPreparedMediaCommand(current, mutation.command);
      if (!prepared) {
        eventBus.emit('lostEdit');
        return;
      }

      commitData(prepared.nextData, {
        ...(!current.registry.assets[mutation.command.payload.asset.assetKey]
          || (mutation.command.payload.afterClipId && mutation.command.payload.asset.mediaType === 'video') ? {
          gestureBasis: { kind: 'prepared-media' as const, config: current.config, registry: current.registry,
            clipId: prepared.commandResult!.detail!.clipId as string, command: mutation.command },
        } : {}),
        save: options?.save,
        selectedClipId: options?.selectedClipId,
        selectedTrackId: options?.selectedTrackId,
        transactionId: options?.transactionId,
        semantic: options?.semantic,
        skipHistory: options?.skipHistory,
        commandHistory: {
          transaction: { commands: [mutation.command] },
          history: prepared.history,
        },
      });
      return;
    }

    if (mutation.type === 'pinnedShotGroups') {
      // Membership/metadata-only mutation. Soft-tag model: no projection; the
      // clips are unchanged, only the group entries' clipIds/mode/etc. update.
      commitData(
        preserveUploadingClips(
          current,
          buildDataFromCurrentRegistry(
            withPinnedShotGroups(current.config, mutation.pinnedShotGroups),
            current,
          ),
        ),
        {
          save: options?.save,
          selectedClipId: options?.selectedClipId,
          selectedTrackId: options?.selectedTrackId,
          transactionId: options?.transactionId,
          semantic: options?.semantic,
          skipHistory: options?.skipHistory,
          commandHistory: options?.commandHistory,
          gestureBasis: options?.gestureBasis,
        },
      );
      return;
    }

    if (mutation.type === 'rows') {
      const nextMeta: Record<string, ClipMeta> = { ...current.meta };

      if (mutation.metaUpdates) {
        for (const [clipId, patch] of Object.entries(mutation.metaUpdates)) {
          nextMeta[clipId] = nextMeta[clipId]
            ? { ...nextMeta[clipId], ...patch }
            : (patch as ClipMeta);
        }
      }

      if (mutation.metaDeletes) {
        for (const clipId of mutation.metaDeletes) {
          delete nextMeta[clipId];
        }
      }

      const baseNextData = materializeData(
        current,
        mutation.rows,
        nextMeta,
        mutation.clipOrderOverride ?? buildTrackClipOrder(current.tracks, current.clipOrder, mutation.metaDeletes),
        mutation.registryOverride,
      );
      const nextData = mutation.pinnedShotGroupsOverride === undefined
        ? baseNextData
        : preserveUploadingClips(
            { ...current, rows: mutation.rows, meta: nextMeta } as TimelineData,
            buildDataFromCurrentRegistry(
              withPinnedShotGroups(baseNextData.config, mutation.pinnedShotGroupsOverride),
              current,
              {
                registry: baseNextData.registry,
                resolvedRegistry: baseNextData.resolvedConfig.registry,
              },
            ),
          );

      commitData(
        nextData,
        {
          save: options?.save,
          selectedClipId: options?.selectedClipId,
          selectedTrackId: options?.selectedTrackId,
          transactionId: options?.transactionId,
          semantic: options?.semantic,
          skipHistory: options?.skipHistory,
          commandHistory: options?.commandHistory,
          gestureBasis: options?.gestureBasis,
        },
      );
      return;
    }

    commitData(
      preserveUploadingClips(
        current,
        buildDataFromCurrentRegistry(
          serializeResolvedTimelineEdit(
            mutation.resolvedConfig,
            mutation.pinnedShotGroupsOverride ?? current.config.pinnedShotGroups,
            current.config,
            undefined,
            current.resolvedConfig,
          ),
          current,
        ),
      ),
      {
        save: options?.save,
        selectedClipId: options?.selectedClipId,
        selectedTrackId: options?.selectedTrackId,
        transactionId: options?.transactionId,
        semantic: options?.semantic,
        skipHistory: options?.skipHistory,
        commandHistory: options?.commandHistory,
        gestureBasis: options?.gestureBasis,
      },
    );
  }, [commitData, materializeData, withPinnedShotGroups, eventBus, editability]);

  const patchRegistry = useCallback((assetId: string, entry: AssetRegistryEntry, src?: string) => {
    registryOwnersRef.current.delete(assetId);
    if (editability?.checkTimeline && !editability.checkTimeline().allowed) return;
    const current = dataRef.current;
    if (!current) {
      eventBus.emit('lostEdit');
      return;
    }

    const nextRegistry = {
      ...current.registry,
      assets: {
        ...current.registry.assets,
        [assetId]: entry,
      },
    };
    const resolvedSource = src ?? getAssetSourceForLocalEdit(entry, current.resolvedConfig.registry[assetId]);
    if (!resolvedSource && !(resolveAssetUrl && getAssetResolutionToken(entry))) {
      console.error(`[timeline] Cannot patch asset '${assetId}' without a file locator or media identity`);
      eventBus.emit('lostEdit');
      return;
    }
    const nextResolvedRegistry = { ...current.resolvedConfig.registry };
    if (resolvedSource) nextResolvedRegistry[assetId] = { ...entry, src: resolvedSource };
    else delete nextResolvedRegistry[assetId];
    const nextConfig = { ...current.config };
    const migratedConfig = migrateToFlatTracks(nextConfig);
    migratedConfig.tracks = migratedConfig.tracks ?? [];

    const nextData = assembleTimelineData({
      config: migratedConfig,
      configVersion: current.configVersion,
      head: current.head,
      registry: nextRegistry,
      sourceItemsBySchemaRef: current.sourceItemsBySchemaRef,
      resolvedConfig: {
        output: { ...migratedConfig.output },
        tracks: migratedConfig.tracks,
        clips: migratedConfig.clips.map((clip) => ({
          ...clip,
          assetEntry: clip.asset ? nextResolvedRegistry[clip.asset] : undefined,
        })),
        // Reuse resolved entries for unchanged assets and patch the current asset in-place.
        registry: nextResolvedRegistry,
        ...(migratedConfig.theme !== undefined ? { theme: migratedConfig.theme } : {}),
        ...(migratedConfig.theme_overrides !== undefined ? { theme_overrides: migratedConfig.theme_overrides } : {}),
        ...(migratedConfig.generation_defaults !== undefined ? { generation_defaults: migratedConfig.generation_defaults } : {}),
      },
      assetMap: buildAssetReferenceMap(nextRegistry),
      output: { ...migratedConfig.output },
    });

    commitData(preserveUploadingClips(current, nextData), {
      // Registry enrichment is a document edit. It must go through the same
      // save owner as config/clip changes so it is dirty, draft-backed, and
      // represented by an undo snapshot.
      save: true,
      selectedClipId: selectedClipIdRef.current,
      selectedTrackId: selectedTrackIdRef.current,
      semantic: true,
    });
  }, [commitData, editability, eventBus, resolveAssetUrl]);

  const unpatchRegistry = useCallback((assetId: string) => {
    registryOwnersRef.current.delete(assetId);
    if (editability?.checkTimeline && !editability.checkTimeline().allowed) return;
    const current = dataRef.current;
    if (!current) {
      eventBus.emit('lostEdit');
      return;
    }

    // A failed preparation/registration must never remove an asset that has
    // already become referenced by a live clip or pinned group.
    const isReferenced = current.config.clips.some((clip) => clip.asset === assetId)
      || current.config.pinnedShotGroups?.some((group) => group.videoAssetKey === assetId) === true;
    if (isReferenced) {
      return;
    }

    const { [assetId]: removedAsset, ...remainingAssets } = current.registry.assets ?? {};
    void removedAsset;
    const nextRegistry = {
      ...current.registry,
      assets: remainingAssets,
    };
    const { [assetId]: removedResolvedAsset, ...remainingResolvedRegistry } = current.resolvedConfig.registry;
    void removedResolvedAsset;
    const nextConfig = { ...current.config };
    const migratedConfig = migrateToFlatTracks(nextConfig);
    migratedConfig.tracks = migratedConfig.tracks ?? [];

    const nextData = assembleTimelineData({
      config: migratedConfig,
      configVersion: current.configVersion,
      head: current.head,
      registry: nextRegistry,
      sourceItemsBySchemaRef: current.sourceItemsBySchemaRef,
      resolvedConfig: {
        output: { ...migratedConfig.output },
        tracks: migratedConfig.tracks,
        clips: migratedConfig.clips.map((clip) => ({
          ...clip,
          assetEntry: clip.asset ? remainingResolvedRegistry[clip.asset] : undefined,
        })),
        registry: remainingResolvedRegistry,
        ...(migratedConfig.theme !== undefined ? { theme: migratedConfig.theme } : {}),
        ...(migratedConfig.theme_overrides !== undefined ? { theme_overrides: migratedConfig.theme_overrides } : {}),
        ...(migratedConfig.generation_defaults !== undefined ? { generation_defaults: migratedConfig.generation_defaults } : {}),
      },
      assetMap: buildAssetReferenceMap({ assets: remainingAssets }),
      output: { ...migratedConfig.output },
    });

    commitData(nextData, {
      save: true,
      selectedClipId: selectedClipIdRef.current,
      selectedTrackId: selectedTrackIdRef.current,
      semantic: true,
    });
  }, [commitData, editability, eventBus]);

  const patchRegistryOwned = useCallback((assetId: string, entry: AssetRegistryEntry, src?: string): OwnedRegistryMutation => {
    const previous = dataRef.current;
    const seq = editSeqRef.current;
    const ownedEntry = structuredClone(entry);
    patchRegistry(assetId, ownedEntry, src);
    const current = dataRef.current;
    if (!current || editSeqRef.current !== seq + 1 || current.registry.assets[assetId] !== ownedEntry) {
      throw new Error('Asset registration mutation was not accepted by the mounted timeline owner');
    }
    const receipt = Object.freeze({ assetId, editSeq: editSeqRef.current });
    registryReceiptsRef.current.set(receipt, {
      entry: ownedEntry,
      signature: JSON.stringify(ownedEntry),
      src: current.resolvedConfig.registry[assetId].src,
      previousEntry: previous?.registry.assets[assetId],
      previousResolved: previous?.resolvedConfig.registry[assetId],
    });
    registryOwnersRef.current.set(assetId, receipt);
    return receipt;
  }, [patchRegistry]);

  const ownsRegistryMutation = useCallback((receipt: OwnedRegistryMutation) => {
    const owned = registryReceiptsRef.current.get(receipt);
    const current = dataRef.current;
    return Boolean(owned && current && registryOwnersRef.current.get(receipt.assetId) === receipt
      && current.registry.assets[receipt.assetId] === owned.entry
      && JSON.stringify(owned.entry) === owned.signature
      && current.resolvedConfig.registry[receipt.assetId]?.src === owned.src);
  }, []);

  const canRollbackRegistryMutation = useCallback((receipt: OwnedRegistryMutation) => {
    const current = dataRef.current;
    return Boolean(ownsRegistryMutation(receipt) && current
      && !current.config.clips.some((clip) => clip.asset === receipt.assetId)
      && !current.config.pinnedShotGroups?.some((group) => group.videoAssetKey === receipt.assetId
        || group.imageClipSnapshot?.some((clip) => clip.assetKey === receipt.assetId)));
  }, [ownsRegistryMutation]);

  const rollbackRegistryMutation = useCallback((receipt: OwnedRegistryMutation) => {
    if (!canRollbackRegistryMutation(receipt)) return false;
    const current = dataRef.current!;
    const owned = registryReceiptsRef.current.get(receipt)!;
    const assets = { ...current.registry.assets };
    const resolvedRegistry = { ...current.resolvedConfig.registry };
    if (owned.previousEntry) assets[receipt.assetId] = owned.previousEntry;
    else delete assets[receipt.assetId];
    if (owned.previousResolved) resolvedRegistry[receipt.assetId] = owned.previousResolved;
    else delete resolvedRegistry[receipt.assetId];
    const registry = { ...current.registry, assets };
    const next = assembleTimelineData({
      config: current.config,
      configVersion: current.configVersion,
      head: current.head,
      registry,
      resolvedConfig: {
        ...current.resolvedConfig,
        registry: resolvedRegistry,
        clips: current.resolvedConfig.clips.map((clip) => ({
          ...clip, assetEntry: clip.asset ? resolvedRegistry[clip.asset] : undefined,
        })),
      },
      assetMap: buildAssetReferenceMap(registry),
      sourceItemsBySchemaRef: current.sourceItemsBySchemaRef,
      output: current.output,
    });
    registryOwnersRef.current.delete(receipt.assetId);
    commitData(preserveUploadingClips(current, next), { save: true, skipHistory: true });
    return true;
  }, [canRollbackRegistryMutation, commitData]);

  return {
    data,
    dataRef,
    selectedClipId,
    selectedTrackId,
    setSelectedTrackId,
    applyEdit,
    patchRegistry,
    unpatchRegistry,
    patchRegistryOwned,
    ownsRegistryMutation,
    canRollbackRegistryMutation,
    rollbackRegistryMutation,
    commitData,
    materializeData,
    editSeqRef,
    pendingOpsRef,
    selectedClipIdRef,
    selectedTrackIdRef,
  };
}

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
import { RuntimeDataProvider } from '@/integrations/runtime/dataProvider.ts';
import { resolveTimelineConfig } from '@/tools/video-editor/lib/config-utils.ts';
import type { AssetRegistry } from '@/tools/video-editor/types/index.ts';
import { bridgeMediaUrl } from '@/shared/lib/media/bridgeMediaUrl.ts';
import { ShotsContextProvider } from '@/shared/contexts/ShotsContext.tsx';
import { shotListLocation, shotLocation } from '@/shared/lib/tooling/toolRoutes.ts';
import { ShotListDisplay } from '../components/VideoGallery/ShotListDisplay.tsx';
import { ShotEditorView } from './ShotEditorView.tsx';
import type { Shot } from '@/domains/generation/types';
import {
  selectCanonicalShotOccurrences,
  selectCanonicalShotModels,
} from './localTimelineShotModel.ts';
import {
  createShotCompositionAdapter,
  type PreparedShotComposition,
  type ShotCompositionAdapter,
  type ShotCompositionPort,
} from '@/tools/video-editor/data/shotCompositionAdapter.ts';
import type {
  CanonicalShotTimelineDraft,
  CanonicalShotTimelinePublication,
  CanonicalShotTimelineScope,
} from '@/tools/video-editor/runtime/ports.ts';

type LocalTimelineShotBrowserProps = {
  projectSlug: string;
  projectId?: string;
  timelineRef: string;
  shotCompositionPort?: ShotCompositionPort;
  /** Reuse an already prepared canonical adapter from the parent editor. */
  shotCompositionAdapter?: ShotCompositionAdapter;
  /** Opens one canonical shot without changing the parent route. */
  shotRef?: string | null;
  /** Optional parent-held graph that survives an embedded popup unmount. */
  initialComposition?: PreparedShotComposition;
  onClose?: () => void;
  /** Receives the latest graph after an embedded shot edit is published. */
  onCanonicalCompositionPublished?: (
    composition: PreparedShotComposition,
    publication?: CanonicalShotTimelinePublication,
  ) => void;
  onCanonicalDraftSessionChange?: (scope: CanonicalShotTimelineScope, active: boolean) => void;
  onCanonicalDraftProjectionChange?: (draft: CanonicalShotTimelineDraft) => void;
  onCanonicalDraftProjectionClear?: (scope: CanonicalShotTimelineScope, generation: number) => void;
  /** Retained parent-editor ports until the A2/A3 save funnel replaces the popup surface. */
  shotSetPort?: unknown;
  mediaProvider?: unknown;
};

type LocalTimelineDocument = {
  registry: AssetRegistry;
  composition: Awaited<ReturnType<ReturnType<typeof createShotCompositionAdapter>['load']>>;
  compositionAdapter: ReturnType<typeof createShotCompositionAdapter>;
};

function localTimelineShotBrowserQueryKey(
  identityProjectId: string,
  timelineRef: string,
  shotCompositionPort?: ShotCompositionPort,
  shotCompositionAdapter?: ShotCompositionAdapter,
) {
  return [
    'canonical-local-timeline-shot-browser',
    identityProjectId,
    timelineRef,
    shotCompositionPort,
    shotCompositionAdapter,
  ] as const;
}

function useLocalTimelineDocument(
  projectSlug: string,
  projectId: string | undefined,
  timelineRef: string,
  shotCompositionPort?: ShotCompositionPort,
  shotCompositionAdapter?: ShotCompositionAdapter,
) {
  // Runtime is the only local data path; an embedded caller without a
  // Runtime project id surfaces as a load error instead of a second backend.
  const provider = useMemo(
    () => (projectId ? new RuntimeDataProvider({ projectId }) : null),
    [projectId],
  );
  const identityProjectId = projectId ?? projectSlug;
  const canonicalPort = shotCompositionPort ?? provider?.shotComposition;
  const compositionAdapter = useMemo(
    () => shotCompositionAdapter ?? (canonicalPort ? createShotCompositionAdapter(canonicalPort) : null),
    [canonicalPort, shotCompositionAdapter],
  );
  const queryKey = useMemo(
    () => localTimelineShotBrowserQueryKey(
      identityProjectId,
      timelineRef,
      shotCompositionPort,
      shotCompositionAdapter,
    ),
    [identityProjectId, shotCompositionAdapter, shotCompositionPort, timelineRef],
  );

  const query = useQuery<LocalTimelineDocument>({
    queryKey,
    // An embedded shot editor is a short-lived view over a mutable canonical
    // graph. Do not let an unmounted popup seed the next open with its old
    // composition while the Runtime read is catching up.
    gcTime: 0,
    refetchOnMount: 'always',
    // Runtime has no public event cursor yet; its immutable composition read
    // is the bounded catch-up path for standalone nested/player views too.
    refetchInterval: provider?.refreshIntervalMs ?? false,
    refetchOnReconnect: true,
    queryFn: async () => {
      if (!provider) {
        throw new Error('Workspace Runtime project is unavailable for this timeline.');
      }
      if (!compositionAdapter) {
        throw new Error('Canonical shot-composition provider is unavailable for this timeline.');
      }
      const [timeline, registry] = await Promise.all([
        provider.loadTimeline(timelineRef),
        provider.loadAssetRegistry(timelineRef),
      ]);
      // Resolve the registry through the same provider used by the editor so
      // managed media gets a Runtime object URL when no thumbnail is stored.
      const resolved = await resolveTimelineConfig(
        timeline.config,
        registry,
        (file, entry, assetId) => provider.onResolve({
          file,
          entry,
          assetId,
          timelineId: timelineRef,
        }),
      );
      return {
        registry: {
          assets: Object.fromEntries(Object.entries(resolved.registry).map(([key, entry]) => [key, entry])),
        },
        composition: await compositionAdapter.load({ projectId: identityProjectId, parentDocumentId: timelineRef }),
        compositionAdapter,
      };
    },
  });

  return { queryKey, provider, compositionAdapter, ...query };
}

function isCompositionForDocument(
  composition: PreparedShotComposition | null | undefined,
  projectId: string,
  parentDocumentId: string,
): composition is PreparedShotComposition {
  return composition?.projectId === projectId
    && composition.parentDocumentId === parentDocumentId
    && composition.occurrences.length > 0;
}

export function LocalTimelineShotBrowser({ projectSlug, projectId, timelineRef, shotCompositionPort, shotCompositionAdapter, shotRef, initialComposition, onClose, onCanonicalCompositionPublished, onCanonicalDraftSessionChange, onCanonicalDraftProjectionChange, onCanonicalDraftProjectionClear }: LocalTimelineShotBrowserProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const identityProjectId = projectId ?? projectSlug;
  const documentQuery = useLocalTimelineDocument(projectSlug, projectId, timelineRef, shotCompositionPort, shotCompositionAdapter);
  const [compositionOverride, setCompositionOverride] = useState<PreparedShotComposition | null>(() => (
    isCompositionForDocument(initialComposition, identityProjectId, timelineRef) ? initialComposition : null
  ));
  const [canonicalDraftDirty, setCanonicalDraftDirty] = useState(false);
  const loadedComposition = documentQuery.data?.composition;
  useEffect(() => {
    if (!loadedComposition) return;
    setCompositionOverride((current) => {
      if (!current || current.headRevisionId === loadedComposition.headRevisionId) {
        return null;
      }
      // Keep a freshly published parent graph visible while a late Runtime
      // read still returns the previous head revision.
      return current;
    });
  }, [loadedComposition]);
  useEffect(() => {
    if (isCompositionForDocument(initialComposition, identityProjectId, timelineRef)) {
      // The parent host polls for external head changes. Preserve the pinned
      // mounted graph while a nested editor has unsaved work; its CAS publish
      // will explicitly advance this override after acknowledgement.
      if (canonicalDraftDirty) return;
      setCompositionOverride(initialComposition);
    } else {
      setCompositionOverride(null);
    }
  }, [canonicalDraftDirty, identityProjectId, initialComposition, timelineRef]);
  const composition = compositionOverride ?? loadedComposition;
  const hasPreparedComposition = isCompositionForDocument(composition, identityProjectId, timelineRef);
  const shots = useMemo(
    () => selectCanonicalShotOccurrences(composition, documentQuery.data?.registry, identityProjectId),
    [composition, documentQuery.data?.registry, identityProjectId],
  );
  const shotModels = useMemo(
    () => selectCanonicalShotModels(composition, documentQuery.data?.registry, identityProjectId),
    [composition, documentQuery.data?.registry, identityProjectId],
  );
  const hashShotId = useMemo(() => {
    if (shotRef) return shotRef;
    const encoded = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    try {
      const decoded = decodeURIComponent(encoded).trim();
      return decoded || null;
    } catch {
      return null;
    }
  }, [location.hash, shotRef]);
  const shotRefOccurrenceId = useMemo(() => {
    if (!hashShotId) return null;
    const match = hashShotId.match(/\/occurrence\/([^/]+)$/);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }, [hashShotId]);
  const selectedShot = useMemo(
    () => shots.find((shot) => shot.occurrenceId === hashShotId || shot.stableDeepLink === hashShotId || shot.occurrenceId === shotRefOccurrenceId),
    [hashShotId, shotRefOccurrenceId, shots],
  );
  const selectedShotModel = useMemo(
    () => selectedShot ? shotModels.find((shot) => shot.id === selectedShot.id) : undefined,
    [selectedShot, shotModels],
  );
  const handleCanonicalCompositionPublished = useCallback((
    nextComposition: PreparedShotComposition,
    publication?: CanonicalShotTimelinePublication,
  ) => {
    setCompositionOverride(nextComposition);
    queryClient.setQueryData<LocalTimelineDocument>(documentQuery.queryKey, (current) => current
      ? { ...current, composition: nextComposition }
      : current);
    onCanonicalCompositionPublished?.(nextComposition, publication);
  }, [documentQuery.queryKey, onCanonicalCompositionPublished, queryClient]);

  useEffect(() => {
    // A stale or malformed deep link should land safely on the overview once
    // the document is available. Keep the local project/timeline query intact.
    if (shotRef || documentQuery.isLoading || documentQuery.error || !location.hash || selectedShot) return;
    navigate(shotListLocation(location.pathname, location.search), { replace: true });
  }, [documentQuery.error, documentQuery.isLoading, location.hash, location.pathname, location.search, navigate, selectedShot, shotRef]);

  const selectShot = (shot: Shot & { stableDeepLink?: string }) => {
    if (!shot.stableDeepLink) return;
    // The hash is the canonical occurrence deep link, not a reusable shot id.
    navigate(shotLocation(location.pathname, location.search, shot.stableDeepLink), {
      state: {
        fromShotClick: true,
        shotData: { id: shot.stableDeepLink, name: shot.name, settings: {}, images: [] },
      },
    });
  };

  if (!hasPreparedComposition && documentQuery.isLoading) {
    return <div className="p-6 text-center text-sm text-muted-foreground" role="status">Loading timeline shots…</div>;
  }
  if (!hasPreparedComposition && documentQuery.error) {
    return (
      <div className="mx-auto flex max-w-xl items-center gap-2 p-6 text-sm text-destructive" role="alert">
        <AlertCircle className="h-4 w-4 shrink-0" />
        Unable to load this Astrid timeline: {documentQuery.error instanceof Error ? documentQuery.error.message : 'Unknown error'}
      </div>
    );
  }
  if (shots.length === 0) {
    return (
      <div className="mx-auto max-w-xl p-8 text-center text-sm text-muted-foreground">
        This timeline has no document shot groups yet.
      </div>
    );
  }

  const shotsContext = {
    shots: shotModels,
    isLoading: false,
    error: null,
    refetchShots: () => undefined,
    allImagesCount: shotModels.reduce((total, shot) => total + (shot.images?.length ?? 0), 0),
    noShotImagesCount: 0,
  };

  return (
    <ShotsContextProvider value={shotsContext}>
      {selectedShot && selectedShotModel ? (
        <ShotEditorView
          shotToEdit={selectedShotModel}
          canonicalOccurrence={selectedShotModel}
          canonicalShotComposition={documentQuery.compositionAdapter ?? documentQuery.data?.compositionAdapter ?? shotCompositionAdapter}
          timelineDataProvider={documentQuery.provider ?? undefined}
          canonicalComposition={composition}
          selectedProjectId={projectSlug}
          isNewlyCreatedShot={false}
          shotFromState={undefined}
          shots={shotModels}
          shotSortMode="ordered"
          onClose={onClose}
          onCanonicalCompositionPublished={handleCanonicalCompositionPublished}
          onCanonicalDraftSessionChange={onCanonicalDraftSessionChange}
          onCanonicalDraftProjectionChange={onCanonicalDraftProjectionChange}
          onCanonicalDraftProjectionClear={onCanonicalDraftProjectionClear}
          onCanonicalDraftStateChange={setCanonicalDraftDirty}
        />
      ) : (
        <section className="mx-auto w-full max-w-7xl" aria-label="Timeline shots">
          <div className="flex items-baseline justify-between gap-3 px-4 pt-5">
            <div>
              <h1 className="text-lg font-semibold">Timeline shots</h1>
              <p className="text-xs text-muted-foreground">Astrid document · {shotModels.length} shot{shotModels.length === 1 ? '' : 's'}</p>
            </div>
            <span className="rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground">Local timeline</span>
          </div>
          <ShotListDisplay
            readOnly
            shots={shotModels}
            onSelectShot={selectShot}
            sortMode="ordered"
          />
        </section>
      )}
    </ShotsContextProvider>
  );
}

export function localTimelineMediaUrl(projectSlug: string, mediaId: string): string {
  return bridgeMediaUrl(projectSlug, mediaId);
}

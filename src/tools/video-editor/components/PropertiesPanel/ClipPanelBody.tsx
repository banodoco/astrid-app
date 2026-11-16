import { intrinsicMediaSize, resolveClipPlacement } from '@banodoco/timeline-composition';
import { getEffectiveClipVolume } from '@/tools/video-editor/lib/clip-volume.ts';
import { useMemo, useRef, useState, type ComponentType } from 'react';
import { RefreshCw, Trash2, Volume2, X } from 'lucide-react';
import { Button } from '@/shared/components/ui/button.tsx';
import { cn } from '@/shared/components/ui/contracts/cn.ts';
import { Input } from '@/shared/components/ui/input.tsx';
import type { EditorVariantPicker } from '@/tools/video-editor/runtime/editorHostObservations.ts';
import type { EffectCreatorPanelProps } from '@/tools/video-editor/components/EffectCreatorPanel.tsx';
import type { GenerationVariant } from '@/shared/hooks/variants/useVariants.ts';
import { NumberInput } from '@/shared/components/ui/number-input.tsx';
import { Slider } from '@/shared/components/ui/slider.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs.tsx';
import { Textarea } from '@/shared/components/ui/textarea.tsx';
import {
  getRegisteredClipTypeDescriptor,
  getClipTypeOverlayBehavior,
  getDefaultBoxForClipType,
  isClipTypeCommandAvailable,
} from '@/tools/video-editor/clip-types/index.ts';
import { isSequenceParamsSchema } from '@/tools/video-editor/clip-types/defineClipType.ts';
import type { EffectResource, VideoEditorEffectCatalog } from '@/tools/video-editor/lib/effect-catalog.ts';
import type { ClipTab } from '@/tools/video-editor/hooks/useEditorPreferences.ts';
import type { ClipMeta } from '@/tools/video-editor/lib/timeline-data.ts';
import { getVisibleClipTabs } from '@/tools/video-editor/lib/clip-inspector.ts';
import type { TimelineDeviceClass } from '@/tools/video-editor/lib/mobile-interaction-model.ts';
import { resolveAvailableClipType } from '@/tools/video-editor/sequences/registry.ts';
import type {
  ResolvedTimelineClip,
  ResolvedTimelineConfig,
  TrackDefinition,
} from '@/tools/video-editor/types/index.ts';
import { useOptionalClipTypeRegistryContext } from '@/tools/video-editor/clip-types/ClipTypeRegistryContext.tsx';
import type { ClipTypeRegistryRecord } from '@/tools/video-editor/clip-types/ClipTypeRegistry.ts';
import { FieldLabel, TAB_COLUMNS_CLASS } from './clip-panel-primitives.tsx';
import { getEffectDisplayLabel } from './clip-effect-helpers.tsx';
import { ClipEffectsTab } from './ClipEffectsTab.tsx';
import { ClipExtensionInspectorSection } from './ClipExtensionInspectorSection.tsx';
import { ClipInspectorActions } from './ClipInspectorActions.tsx';

/** The shortest a media clip can be made from its Duration field. */
const MIN_MEDIA_DURATION_SECONDS = 0.05;
const roundToThousandths = (value: number) => Math.round(value * 1000) / 1000;
const TOUCH_TAB_CLASS = '[@media(pointer:coarse)]:h-11';

export { getVisibleClipTabs } from '@/tools/video-editor/lib/clip-inspector.ts';
export { FieldLabel, NO_EFFECT, NO_TRANSITION, TAB_COLUMNS_CLASS } from './clip-panel-primitives.tsx';

export interface ClipPanelProps {
  readOnly?: boolean;
  clip: ResolvedTimelineClip | null;
  track: TrackDefinition | null;
  deviceClass: TimelineDeviceClass;
  hasPredecessor: boolean;
  onChange: (patch: Partial<ClipMeta> & { at?: number }) => void;
  onResetPosition: () => void;
  onClose: () => void;
  onDelete?: () => void;
  onToggleMute: () => void;
  onDetachAudio?: () => void;
  onSplitAtPlayhead: () => void;
  /** Absent when there is no track of the clip's kind above it. */
  onMoveTrackUp?: () => void;
  /** Absent when there is no track of the clip's kind below it. */
  onMoveTrackDown?: () => void;
  onSetInteractionMode: (mode: 'move' | 'trim') => void;
  compositionWidth: number;
  compositionHeight: number;
  registry: ResolvedTimelineConfig['registry'];
  /** Saved executable element registry from the current timeline config.app. */
  elementRegistry?: unknown;
  activeTab: ClipTab;
  setActiveTab: (tab: ClipTab) => void;
  isVariantStale?: boolean;
  onUpdateVariant?: () => void;
  onDismissStale?: () => void;
  onApplyVariant?: (variant: GenerationVariant) => void | Promise<void>;
  onAddVariantAsGeneration?: (variant: GenerationVariant) => void | Promise<void>;
  isAddingVariantAsGeneration?: (variantId: string) => boolean;
  timelineFps?: number;
  /** Current playhead time in seconds, used by KeyframeInspector. */
  currentTime?: number;
}

export interface ClipPanelBodyProps extends ClipPanelProps {
  effectResources: VideoEditorEffectCatalog;
  VariantPicker?: EditorVariantPicker;
  EffectCreator?: ComponentType<EffectCreatorPanelProps>;
  /** True only when ClipPanel will render a matching editable Astrid schema form. */
  hasActiveAstridElementParams?: boolean;
}

export function ClipPanelBody({
  readOnly = false,
  effectResources,
  VariantPicker,
  EffectCreator,
  hasActiveAstridElementParams = false,
  clip,
  track,
  deviceClass,
  onChange,
  onResetPosition,
  onClose,
  onDelete,
  onToggleMute,
  onDetachAudio,
  onSplitAtPlayhead,
  onMoveTrackUp,
  onMoveTrackDown,
  onSetInteractionMode,
  compositionWidth,
  compositionHeight,
  registry,
  elementRegistry,
  activeTab,
  setActiveTab,
  isVariantStale,
  onUpdateVariant,
  onDismissStale,
  onApplyVariant,
  onAddVariantAsGeneration,
  isAddingVariantAsGeneration,
  timelineFps,
  currentTime = 0,
}: ClipPanelBodyProps) {
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [editingEffect, setEditingEffect] = useState<EffectResource | null>(null);
  const visibleTabs = useMemo(() => getVisibleClipTabs(clip, track), [clip, track]);
  const clipDescriptor = clip
    ? getRegisteredClipTypeDescriptor(clip.clipType)
    : undefined;
  const holdTiming = clipDescriptor?.hold;
  const holdDefaultSeconds = holdTiming && holdTiming.kind !== 'unsupported' ? holdTiming.defaultSeconds : undefined;
  type TimingField = 'at' | 'hold' | 'speed' | 'from' | 'to';
  const timingValuesRef = useRef<Record<TimingField, number>>({
    at: clip?.at ?? 0,
    hold: clip?.hold ?? holdDefaultSeconds ?? 0,
    speed: clip?.speed ?? 1,
    from: clip?.from ?? 0,
    to: clip?.to ?? clip?.assetEntry?.duration ?? 5,
  });
  // Track the controlled values as well as live input changes. NumberField can
  // keep its typed text visible while focused even if an external timeline
  // refresh replaces the controlled value. Reapply that final value on blur
  // only when the timeline no longer contains it.
  timingValuesRef.current = {
    at: clip?.at ?? 0,
    hold: clip?.hold ?? holdDefaultSeconds ?? 0,
    speed: clip?.speed ?? 1,
    from: clip?.from ?? 0,
    to: clip?.to ?? clip?.assetEntry?.duration ?? 5,
  };
  const handleTimingValueChange = (field: TimingField, value: number | null) => {
    if (value === null) return;
    timingValuesRef.current[field] = value;
    onChange({ [field]: value });
  };
  const handleTimingValueCommitted = (field: TimingField, value: number | null) => {
    if (value === null || timingValuesRef.current[field] === value) return;
    timingValuesRef.current[field] = value;
    onChange({ [field]: value });
  };
  const clipTypeResolution = resolveAvailableClipType(clip?.clipType);
  const isEffectLayer = clipDescriptor?.renderCapabilities.previewRoute === 'effect-layer';
  const isSequenceClip = Boolean(clipDescriptor && isSequenceParamsSchema(clipDescriptor.paramsSchema));
  const overlayBehavior = getClipTypeOverlayBehavior(clipDescriptor);
  const supportsInlineTextEdit = overlayBehavior.supportsInlineTextEdit;
  // Position fallbacks come from the clip-type descriptor — the same canonical
  // box the renderer draws and the gizmo shows for a position-less clip. The
  // panel must not invent its own (0,0,compW,compH) fallback, which would disagree with
  // both other surfaces for text clips.
  const defaultBox = getDefaultBoxForClipType(clip?.clipType, compositionWidth, compositionHeight);
  const commandContext = useMemo(() => (
    clip
      ? { clip, track, selectedClipIds: [clip.id] }
      : { clip, track, selectedClipIds: [] }
  ), [clip, track]);
  const canSplit = Boolean(
    clipDescriptor && isClipTypeCommandAvailable(clipDescriptor, 'split', commandContext),
  );
  const canMoveTrack = Boolean(
    clipDescriptor && isClipTypeCommandAvailable(clipDescriptor, 'move-track-up', commandContext),
  );
  const canToggleMute = Boolean(
    clipDescriptor && isClipTypeCommandAvailable(clipDescriptor, 'toggle-mute', commandContext),
  );
  const canDetachAudio = Boolean(
    clipDescriptor && isClipTypeCommandAvailable(clipDescriptor, 'detach-audio', commandContext),
  );
  const showInspectorActions = !readOnly && deviceClass !== 'desktop';
  // Touch keeps the header's delete and close at the 44px minimum.
  const headerButtonSize = deviceClass === 'desktop' ? 'h-8 w-8' : 'h-11 w-11';

  // Extension-provided clip inspector section
  const clipTypeRegistryContext = useOptionalClipTypeRegistryContext();
  const clipTypeRegistryRecord: ClipTypeRegistryRecord | undefined = useMemo(() => {
    if (!clip?.clipType || !clipTypeRegistryContext) return undefined;
    return clipTypeRegistryContext.snapshot.get(clip.clipType);
  }, [clip?.clipType, clipTypeRegistryContext]);

  if (!clip) {
    // Touch: the Inspector tab is already the frame, so a quiet line rather than a box in it.
    return deviceClass === 'desktop' ? (
      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        Select a clip to edit timing, position, audio, text, or effects.
      </div>
    ) : (
      <p className="flex h-full min-h-24 items-center justify-center px-4 text-center text-sm text-muted-foreground">
        Tap a clip, or a track's name, to edit it.
      </p>
    );
  }

  // A media clip's length on the timeline is its source span at its speed. Duration edits the
  // span's end (Source Out), never past the end of the media.
  const mediaSpeed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const mediaSourceIn = clip.from ?? 0;
  const mediaSourceEnd = clip.assetEntry?.duration && clip.assetEntry.duration > 0 ? clip.assetEntry.duration : undefined;
  const mediaDuration = ((clip.to ?? mediaSourceEnd ?? 5) - mediaSourceIn) / mediaSpeed;
  const mediaSourceOutFor = (duration: number | null): number | null => {
    if (duration === null) return null;
    const sourceOut = mediaSourceIn + Math.max(duration, MIN_MEDIA_DURATION_SECONDS) * mediaSpeed;
    return roundToThousandths(mediaSourceEnd === undefined ? sourceOut : Math.min(sourceOut, mediaSourceEnd));
  };

  return (
    <div className="space-y-3" data-clip-inspector-read-only={readOnly ? 'true' : undefined}>
      {/* Touch: the header is a plain row inside the Inspector tab, not a card within it. */}
      <div className={cn('flex justify-between gap-3', deviceClass === 'desktop' ? 'items-start rounded-xl border border-border bg-card/70 p-3' : 'items-center')}>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {isEffectLayer
              ? (getEffectDisplayLabel(clip.continuous?.type, effectResources.effects) ?? 'Effect Layer')
              : isSequenceClip
                ? (clipDescriptor?.label ?? clip.clipType ?? clip.id)
                : supportsInlineTextEdit
                  ? (clip.text?.content || clipDescriptor?.label || clip.id)
                  : (clip.label || clip.asset || clipDescriptor?.label || clip.id)}
          </div>
          <div className="mt-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            {clip.clipType ?? 'media'} · {track?.label ?? clip.track}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {readOnly && <span className="rounded-full border px-2 py-1 text-[10px] text-muted-foreground">Read only</span>}
          {!readOnly && VariantPicker && clip.assetEntry?.generationId && (
            <VariantPicker
              generationId={clip.assetEntry.generationId}
              currentVariantId={clip.assetEntry.variantId ?? null}
              onVariantApplied={onApplyVariant}
              onAddVariantAsGeneration={onAddVariantAsGeneration}
              isAddingVariantAsGeneration={isAddingVariantAsGeneration}
              inline
              defaultMediaKind={clip.assetEntry.type?.startsWith('video') ? 'video' : 'image'}
            />
          )}
          {!readOnly && onDelete && (
            <Button type="button" variant="ghost" size="icon" className={cn('astrid-public-inspector-delete text-destructive hover:text-destructive', headerButtonSize)} onClick={onDelete} aria-label="Delete clip" title="Delete clip">
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button type="button" variant="ghost" size="icon" className={headerButtonSize} onClick={onClose} aria-label="Close clip" title="Close clip">
            ×
          </Button>
        </div>
      </div>

      {isVariantStale && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          <RefreshCw className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">Variant outdated</span>
          {onUpdateVariant && (
            <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs text-amber-200 hover:bg-amber-500/20 hover:text-amber-100" onClick={onUpdateVariant}>
              Update
            </Button>
          )}
          {onDismissStale && (
            <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-amber-200/60 hover:bg-amber-500/20 hover:text-amber-100" onClick={onDismissStale}>
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}

      {showInspectorActions && (
        <ClipInspectorActions
          muted={getEffectiveClipVolume(clip) <= 0}
          canMoveTrack={canMoveTrack}
          canSplit={canSplit}
          canToggleMute={canToggleMute}
          setActiveTab={setActiveTab}
          onSetInteractionMode={onSetInteractionMode}
          onMoveTrackUp={onMoveTrackUp}
          onMoveTrackDown={onMoveTrackDown}
          onSplitAtPlayhead={onSplitAtPlayhead}
          onToggleMute={onToggleMute}
        />
      )}

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ClipTab)}>
        {/* On touch the tabs are 44px targets. */}
        <TabsList className={cn('grid w-full bg-muted/60 [@media(pointer:coarse)]:h-[3.25rem]', TAB_COLUMNS_CLASS[visibleTabs.length as keyof typeof TAB_COLUMNS_CLASS] ?? 'grid-cols-4')}>
          {visibleTabs.includes('effects') && <TabsTrigger className={TOUCH_TAB_CLASS} value="effects">{isSequenceClip ? 'Sequence' : 'Effects'}</TabsTrigger>}
          {visibleTabs.includes('timing') && <TabsTrigger className={TOUCH_TAB_CLASS} value="timing">Timing</TabsTrigger>}
          {visibleTabs.includes('position') && <TabsTrigger className={TOUCH_TAB_CLASS} value="position">Position</TabsTrigger>}
          {visibleTabs.includes('audio') && <TabsTrigger className={TOUCH_TAB_CLASS} value="audio">Audio</TabsTrigger>}
          {visibleTabs.includes('text') && <TabsTrigger className={TOUCH_TAB_CLASS} value="text">Text</TabsTrigger>}
        </TabsList>

        <fieldset disabled={readOnly} aria-label="Clip inspector values" className="m-0 min-w-0 border-0 p-0">

        {visibleTabs.includes('effects') && (
          <TabsContent value="effects" className="space-y-3">
            <ClipEffectsTab
              clip={clip}
              onChange={onChange}
              effectResources={effectResources}
              clipDescriptor={clipDescriptor}
              isClipTypeRegistered={Boolean(clipDescriptor || clipTypeRegistryRecord)}
              clipTypeResolution={clipTypeResolution}
              isEffectLayer={isEffectLayer}
              isSequenceClip={isSequenceClip}
              hasActiveAstridElementParams={hasActiveAstridElementParams}
              registry={registry}
              elementRegistry={elementRegistry}
              timelineFps={timelineFps}
              currentTime={currentTime}
              creatorOpen={creatorOpen}
              setCreatorOpen={setCreatorOpen}
              editingEffect={editingEffect}
              setEditingEffect={setEditingEffect}
              EffectCreator={EffectCreator}
            />
          </TabsContent>
        )}

        {visibleTabs.includes('timing') && (
          <TabsContent value="timing" className="space-y-3">
            {/* Start and Duration first, side by side at every width: the two numbers a
                clip's place on the timeline is. Start has no negative values, so a phone
                offers its number pad rather than the full keyboard. */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <FieldLabel>Start (seconds)</FieldLabel>
                <NumberInput
                  value={clip.at}
                  min={0}
                  step={0.1}
                  onChange={(value) => handleTimingValueChange('at', value)}
                  onValueCommitted={(value) => handleTimingValueCommitted('at', value)}
                />
              </div>
              {holdTiming && holdTiming.kind !== 'unsupported' ? (
                <div className="space-y-2">
                  <FieldLabel>Duration (seconds)</FieldLabel>
                  <NumberInput
                    value={clip.hold ?? holdTiming.defaultSeconds}
                    min={holdTiming.minSeconds}
                    max={holdTiming.maxSeconds}
                    step={holdTiming.stepSeconds}
                    onChange={(value) => handleTimingValueChange('hold', value)}
                    onValueCommitted={(value) => handleTimingValueCommitted('hold', value)}
                  />
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <FieldLabel>Duration (seconds)</FieldLabel>
                    <NumberInput
                      value={roundToThousandths(mediaDuration)}
                      min={MIN_MEDIA_DURATION_SECONDS}
                      step={0.1}
                      onChange={(value) => handleTimingValueChange('to', mediaSourceOutFor(value))}
                      onValueCommitted={(value) => handleTimingValueCommitted('to', mediaSourceOutFor(value))}
                    />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel>Source In</FieldLabel>
                    <NumberInput
                      value={clip.from ?? 0}
                      min={0}
                      step={0.1}
                      onChange={(value) => handleTimingValueChange('from', value)}
                      onValueCommitted={(value) => handleTimingValueCommitted('from', value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel>Source Out</FieldLabel>
                    <NumberInput
                      value={clip.to ?? clip.assetEntry?.duration ?? 5}
                      min={0}
                      step={0.1}
                      onChange={(value) => handleTimingValueChange('to', value)}
                      onValueCommitted={(value) => handleTimingValueCommitted('to', value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel>Speed</FieldLabel>
                    <NumberInput
                      value={clip.speed ?? 1}
                      min={0.1}
                      step={0.1}
                      onChange={(value) => handleTimingValueChange('speed', value)}
                      onValueCommitted={(value) => handleTimingValueCommitted('speed', value)}
                    />
                  </div>
                </>
              )}
            </div>
          </TabsContent>
        )}

        {visibleTabs.includes('position') && (
          <TabsContent value="position" className="space-y-3">
            {clip.assetEntry && track && (() => {
              const intrinsic = intrinsicMediaSize(clip.assetEntry);
              const placement = Number.isFinite(intrinsic.width) && Number.isFinite(intrinsic.height)
                ? resolveClipPlacement({clip, track, canvas: {width: compositionWidth, height: compositionHeight}, intrinsic}) : null;
              const provenance = placement?.provenance as Record<string, string> | undefined;
              return <div className="space-y-2">
                <label htmlFor="clip-fit">Fit</label>
                <select id="clip-fit" value={clip.fit ?? ''} disabled={readOnly} onChange={event => { if (!readOnly) onChange({fit: (event.target.value || undefined) as ClipMeta['fit']}); }}>
                  <option value="">Inherit</option><option value="contain">Fit</option><option value="cover">Fill</option>
                </select>
                <span>{placement ? `${placement.fit === 'cover' ? 'Fill' : 'Fit'} (${placement.provenance.fit})` : 'Effective fit unavailable until media size is known'}</span>
                {placement && <p>Track scale {placement.scale} ({placement.provenance.scale}); track opacity {placement.opacity.track} ({placement.provenance.trackOpacity}). Box {placement.local.full.x}, {placement.local.full.y}, {placement.local.full.width} × {placement.local.full.height} (x: {provenance?.x}, y: {provenance?.y}, width: {provenance?.width}, height: {provenance?.height}). Canvas {compositionWidth} × {compositionHeight}; media {intrinsic.width} × {intrinsic.height}.</p>}
                {placement && <p>Crop sources: Top {provenance?.cropTop}, Right {provenance?.cropRight}, Bottom {provenance?.cropBottom}, Left {provenance?.cropLeft}.</p>}
                {(['cropTop', 'cropRight', 'cropBottom', 'cropLeft'] as const).map(edge => <label key={edge}>{edge.slice(4)}
                  <NumberInput disabled={readOnly} value={clip[edge] ?? 0} min={0} max={1} step={0.01} onChange={value => { if (!readOnly && value !== null) onChange({[edge]: value}); }} />
                </label>)}
              </div>;
            })()}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <FieldLabel>X</FieldLabel>
                <NumberInput value={clip.x ?? defaultBox.x} onChange={(value) => { if (value !== null) onChange({ x: value }); }} />
              </div>
              <div className="space-y-2">
                <FieldLabel>Y</FieldLabel>
                <NumberInput value={clip.y ?? defaultBox.y} onChange={(value) => { if (value !== null) onChange({ y: value }); }} />
              </div>
              <div className="space-y-2">
                <FieldLabel>Width</FieldLabel>
                <NumberInput value={clip.width ?? defaultBox.width} min={0} max={compositionWidth} onChange={(value) => { if (value !== null) onChange({ width: value }); }} />
              </div>
              <div className="space-y-2">
                <FieldLabel>Height</FieldLabel>
                <NumberInput value={clip.height ?? defaultBox.height} min={0} max={compositionHeight} onChange={(value) => { if (value !== null) onChange({ height: value }); }} />
              </div>
            </div>
            <div className="space-y-2">
              <FieldLabel>Opacity</FieldLabel>
              <Slider
                value={[clip.opacity ?? 1]}
                min={0}
                max={1}
                step={0.05}
                onValueChange={(value) => onChange({ opacity: value })}
              />
            </div>
            <Button type="button" variant="outline" size="sm" onClick={onResetPosition}>
              Reset position
            </Button>
          </TabsContent>
        )}

        {visibleTabs.includes('audio') && (
          <TabsContent value="audio" className="space-y-3">
            <div className="rounded-lg border border-border bg-card/70 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm text-foreground">
                <Volume2 className="h-4 w-4" />
                Volume
              </div>
              <Slider
                value={[getEffectiveClipVolume(clip)]}
                min={0}
                max={1}
                step={0.05}
                onValueChange={(value) => onChange({ volume: value })}
              />
              {!readOnly && <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={onToggleMute} disabled={!canToggleMute}>
                Toggle mute
              </Button>}
              {!readOnly && canDetachAudio && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={onDetachAudio}
                  disabled={!onDetachAudio}
                >
                  Detach audio
                </Button>
              )}
            </div>
          </TabsContent>
        )}

        {visibleTabs.includes('text') && (
          <TabsContent value="text" className="space-y-3">
            {supportsInlineTextEdit ? (
              <>
                <Textarea
                  aria-label="Text"
                  value={clip.text?.content ?? ''}
                  onChange={(event) => onChange({ text: { ...(clip.text ?? { content: '' }), content: event.target.value } })}
                  // A new text clip's placeholder words are there to be replaced: typing does.
                  onFocus={(event) => {
                    if (clip.text?.content === clipDescriptor?.defaults.clip.text?.content) event.currentTarget.select();
                  }}
                  rows={3}
                />
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <FieldLabel>Font size</FieldLabel>
                    <NumberInput
                      value={clip.text?.fontSize ?? 64}
                      min={1}
                      step={1}
                      onChange={(value) => {
                        if (value !== null) {
                          onChange({ text: { ...(clip.text ?? { content: '' }), fontSize: value } });
                        }
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel>Color</FieldLabel>
                    <Input
                      type="color"
                      value={clip.text?.color ?? '#ffffff'}
                      onChange={(event) => onChange({ text: { ...(clip.text ?? { content: '' }), color: event.target.value } })}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                The selected clip is not a text clip.
              </div>
            )}
          </TabsContent>
        )}
        </fieldset>
      </Tabs>

      {/* Extension-provided clip inspector section after host controls */}
      {clipTypeRegistryRecord?.inspector && (
        <ClipExtensionInspectorSection
          clip={clip}
          onChange={onChange}
          clipTypeRegistryRecord={clipTypeRegistryRecord}
        />
      )}
    </div>
  );
}

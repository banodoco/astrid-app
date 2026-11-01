import type { TimelineHeadRevision } from '@/tools/video-editor/data/DataProvider.ts';
import type { AssetRegistry, TimelineClip, TimelineConfig } from '@/tools/video-editor/types/index.ts';
import { getClipTimelineDuration } from '@/tools/video-editor/lib/config-utils.ts';
import {
  assertValidAstridElementOperation,
  type AstridAgentElementContext,
  type AstridElementCatalogEntry,
  type AstridElementOperation,
  type AstridElementRef,
} from './element-contract.ts';
import type { TimelineBundleEnvelope } from '@/tools/video-editor/data/typed/timelineBundle.ts';
import { refreshAdmittedElements, refreshAdmittedElementRef, admittedCatalogEntries } from './admitted-elements';

type TimelineDocument = {
  config: unknown;
  registry: unknown;
  config_version: number;
  head?: TimelineHeadRevision;
  bundle?: TimelineBundleEnvelope | null;
};

export type AstridElementOperationResult = {
  operation: AstridElementOperation['name'];
  config_version?: number;
  head?: TimelineHeadRevision;
  placements?: readonly {clip_id:string;at:number;duration:number;track:string;element:AstridElementRef;params?:Record<string,unknown>}[];
  element?: AstridElementCatalogEntry;
  elements?: readonly AstridElementCatalogEntry[];
  draft?: AstridElementCatalogEntry;
  config?: TimelineConfig;
  registry?: AssetRegistry;
  validation?: {
    valid: boolean;
    diagnostics: readonly { severity: 'error' | 'warning' | 'info'; path: string; message: string }[];
    capabilities: {
      browserPreview: 'supported' | 'blocked' | 'unknown';
      astridExport: 'supported' | 'blocked' | 'unknown';
      workerExport: 'supported' | 'blocked' | 'unknown';
    };
  };
};

export type ElementTimelineDocument = {
  config: unknown;
  registry: unknown;
  config_version: number;
  head?: TimelineHeadRevision;
  bundle?: TimelineBundleEnvelope | null;
};

export type ElementTimelineRoutes = {
  get(timelineId: string): Promise<ElementTimelineDocument>;
  getGeneration?(): string;
  save(
    timelineId: string,
    input: { config: unknown; registry: unknown; expectedVersion: number; expectedHead?: TimelineHeadRevision; bundle?: TimelineBundleEnvelope | null; original?: ElementTimelineDocument; operation?: TimelineElementOperation; context?: AstridAgentElementContext; assertAuthority?: () => void },
  ): Promise<ElementTimelineDocument>;
};

/** Bind the registered adapter to the mounted editor's current save owner. */
export function createElementTimelineRoutes(
  owner: ElementTimelineRoutes,
  assertAuthority: () => void = () => {},
): ElementTimelineRoutes {
  return {
    getGeneration: owner.getGeneration,
    async get(timelineId) {
      assertAuthority();
      const document = await owner.get(timelineId);
      assertAuthority();
      return document;
    },
    async save(timelineId, input) {
      assertAuthority();
      return owner.save(timelineId, { ...input, assertAuthority });
    },
  };
}

export type TimelineElementOperation = Extract<AstridElementOperation, { name: `timeline.${string}` }>;

export class AstridElementOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AstridElementOperationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asTimelineConfig(value: unknown): TimelineConfig {
  if (!isRecord(value) || !Array.isArray(value.clips)) {
    throw new AstridElementOperationError('Astrid returned a timeline without a clips array');
  }
  return value as unknown as TimelineConfig;
}

function asAssetRegistry(value: unknown): AssetRegistry {
  return (isRecord(value) ? value : {}) as AssetRegistry;
}

function findElement(
  context: AstridAgentElementContext,
  ref: AstridElementRef,
  options: { allowDraft?: boolean } = {},
): AstridElementCatalogEntry {
  const entry = context.catalog.find((candidate) => candidate.id === ref.id && candidate.kind === ref.kind
    && candidate.packId === ref.packId && candidate.revision === ref.revision);
  if (!entry || !entry.admitted || entry.legacy || !ref.packId) {
    throw new AstridElementOperationError(`Element is not registered in the Astrid catalog: ${ref.kind}/${ref.id}`);
  }
  if (entry.revision !== ref.revision) {
    throw new AstridElementOperationError(
      `Element revision is stale for ${ref.id}: expected ${entry.revision}, received ${ref.revision}`,
    );
  }
  if (!options.allowDraft && entry.publication !== 'published') {
    throw new AstridElementOperationError(`Element ${ref.id} is not published for timeline use`);
  }
  return entry;
}

function requireClip(config: TimelineConfig, clipId: string): TimelineClip {
  const clip = config.clips.find((candidate) => candidate.id === clipId);
  if (!clip) throw new AstridElementOperationError(`Timeline clip not found: ${clipId}`);
  return clip;
}

function replaceClip(config: TimelineConfig, clipId: string, update: (clip: TimelineClip) => TimelineClip): TimelineConfig {
  let found = false;
  const clips = config.clips.map((clip) => {
    if (clip.id !== clipId) return clip;
    found = true;
    return update(clip);
  });
  if (!found) throw new AstridElementOperationError(`Timeline clip not found: ${clipId}`);
  return { ...config, clips };
}

function nextAdjacentClip(config: TimelineConfig, fromClipId: string, toClipId?: string): TimelineClip {
  const from = requireClip(config, fromClipId);
  if (toClipId) {
    const explicit = requireClip(config, toClipId);
    if (explicit.track !== from.track || Math.abs((from.at + clipDuration(from)) - explicit.at) >= 0.001) {
      throw new AstridElementOperationError('Transitions require adjacent clips on the same track');
    }
    return explicit;
  }
  const candidates = config.clips
    .filter((clip) => clip.track === from.track && clip.id !== from.id)
    .sort((left, right) => left.at - right.at);
  const next = candidates.find((clip) => Math.abs((from.at + clipDuration(from)) - clip.at) < 0.001);
  if (!next) throw new AstridElementOperationError(`No adjacent clip follows ${fromClipId}`);
  return next;
}

function visualTrackId(config: TimelineConfig, preferred?: string): string {
  if (preferred && config.tracks?.some((track) => track.id === preferred)) return preferred;
  return config.tracks?.find((track) => track.kind === 'visual')?.id
    ?? config.tracks?.[0]?.id
    ?? 'elements';
}

function uniqueElementClipId(config: TimelineConfig, elementId: string, at: number): string {
  const base = `element-${elementId}-${Math.round(at * 1000)}`;
  if (!config.clips.some((clip) => clip.id === base)) return base;
  let suffix = 2;
  while (config.clips.some((clip) => clip.id === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function clipDuration(clip: TimelineClip): number {
  return getClipTimelineDuration(clip);
}

function transitionType(id: string): string {
  // Persist the Astrid catalog identity. The browser renderer accepts the
  // historical `crossfade` alias at its resolution boundary, but the timeline
  // must retain the stable Astrid spelling for export and revision pinning.
  return id;
}

function transitionDurationFrames(
  entry: AstridElementCatalogEntry,
  requested: number | undefined,
): number {
  const defaultFrames = entry.defaults?.durationFrames;
  const frames = requested
    ?? (typeof defaultFrames === 'number' && Number.isInteger(defaultFrames) ? defaultFrames : 8);
  if (!Number.isInteger(frames) || frames <= 0) {
    throw new AstridElementOperationError('Transition duration must be a positive integer number of frames');
  }
  return frames;
}

function assertTransitionFits(
  from: TimelineClip,
  to: TimelineClip,
  durationFrames: number,
  fps: number,
): void {
  const shortestClipFrames = Math.min(clipDuration(from), clipDuration(to)) * fps;
  if (shortestClipFrames <= 0 || durationFrames > shortestClipFrames + 0.0001) {
    throw new AstridElementOperationError(
      `Transition duration ${durationFrames} frames exceeds the shorter adjacent clip (${Math.max(0, Math.floor(shortestClipFrames))} frames)`,
    );
  }
}

export function applyTimelineOperation(
  context: AstridAgentElementContext,
  config: TimelineConfig,
  operation: Extract<AstridElementOperation, { name: `timeline.${string}` }>,
): TimelineConfig {
  switch (operation.name) {
    case 'timeline.apply_element': {
      const entry = findElement(context, operation.element, { allowDraft: true });
      if (operation.placement === 'between-clips' || entry.kind === 'transition') {
        if (entry.kind !== 'transition' || operation.placement !== 'between-clips') {
          throw new AstridElementOperationError('Transitions must use placement between-clips and timeline.apply_transition');
        }
        throw new AstridElementOperationError('Use timeline.apply_transition for a between-clips element');
      }
      if (operation.placement === 'clip') {
        if (!operation.clip_id) throw new AstridElementOperationError('Clip placement requires clip_id');
        return replaceClip(config, operation.clip_id, (clip) => {
          return {
            ...clip,
            elementRef: operation.element,
            ...(entry.kind === 'animation'
              ? {
                  // Astrid's canonical timeline schema carries animation
                  // refs in the phase slots. Applying an animation from the
                  // library uses entrance as the ergonomic default.
                  entrance: {
                    type: operation.element.id,
                    // Match TimelineRenderer's established fallback when the
                    // operation does not provide an explicit entrance span.
                    duration: 0.4,
                    ...(operation.params ? { params: operation.params } : {}),
                  },
                }
              : {}),
            ...(operation.params ? { params: { ...(clip.params ?? {}), ...operation.params } } : {}),
          };
        });
      }

      const target = operation.clip_id ? requireClip(config, operation.clip_id) : undefined;
      const at = operation.at ?? target?.at ?? 0;
      const duration = operation.duration ?? (target ? clipDuration(target) : 1);
      if (!Number.isFinite(at) || at < 0) throw new AstridElementOperationError('Overlay placement requires a non-negative at');
      if (!Number.isFinite(duration) || duration <= 0) throw new AstridElementOperationError('Overlay placement requires a positive duration');
      const overlay: TimelineClip = {
        id: uniqueElementClipId(config, operation.element.id, at),
        at,
        track: visualTrackId(config, target?.track),
        // Keep the Astrid element id in the ordinary visual dispatch path.
        // `effect-layer` is the legacy Astrid App wrapper and cannot carry a
        // revision-pinned Astrid component by itself.
        clipType: entry.kind === 'effect' ? entry.id : 'effect-layer',
        hold: duration,
        elementRef: operation.element,
        ...(operation.params ? { params: operation.params } : {}),
      };
      return { ...config, clips: [...config.clips, overlay] };
    }
    case 'timeline.update_element':
      if (operation.element) findElement(context, operation.element, { allowDraft: true });
      return replaceClip(config, operation.clip_id, (clip) => {
        const effectiveRef=operation.element??clip.elementRef;
        if(!effectiveRef)throw new AstridElementOperationError('Element update requires an admitted exact ref');
        findElement(context,effectiveRef);
        if (operation.duration !== undefined && (
          !clip.elementRef || effectiveRef.kind !== 'effect' || effectiveRef.id !== clip.elementRef.id || clip.elementRef.kind !== 'effect'
          || clip.clipType !== clip.elementRef.id || typeof clip.hold !== 'number'
          || ['asset', 'file', 'src', 'source', 'from', 'to'].some((field) => field in clip)
        )) throw new AstridElementOperationError('Duration updates require an existing strictly pinned generated hold effect without media trim fields');
        return {
          ...clip,
          ...(operation.element ? { elementRef: operation.element } : {}),
          ...(operation.duration !== undefined ? { hold: operation.duration } : {}),
          ...(operation.params ? { params: { ...(clip.params ?? {}), ...operation.params } } : {}),
        };
      });
    case 'timeline.remove_element':
      return replaceClip(config, operation.clip_id, (clip) => {
        const { elementRef: _elementRef, ...withoutElement } = clip;
        const removedId = clip.elementRef?.id;
        const entrance = withoutElement.entrance;
        const nextEntrance = removedId && entrance?.type === removedId
          ? undefined
          : entrance;
        return {
          ...withoutElement,
          ...(nextEntrance ? { entrance: nextEntrance } : { entrance: undefined }),
        };
      });
    case 'timeline.set_clip_fade':
      return replaceClip(config, operation.clip_id, (clip) => ({
        ...clip,
        ...(Array.isArray(clip.effects)
          ? { effects: clip.effects }
          : clip.effects || operation.fade_in !== undefined || operation.fade_out !== undefined
            ? {
                effects: {
                  ...(clip.effects ?? {}),
                  ...(operation.fade_in === undefined ? {} : { fade_in: operation.fade_in }),
                  ...(operation.fade_out === undefined ? {} : { fade_out: operation.fade_out }),
                },
              }
            : {}),
        ...(operation.fade_in === undefined ? {} : { entrance: { type: 'fade', duration: operation.fade_in } }),
        ...(operation.fade_out === undefined ? {} : { exit: { type: 'fade-out', duration: operation.fade_out } }),
      }));
    case 'timeline.apply_transition': {
      const transitionEntry = findElement(context, operation.transition, { allowDraft: true });
      if (transitionEntry.kind !== 'transition') {
        throw new AstridElementOperationError(`${operation.transition.id} is not a transition`);
      }
      const from = requireClip(config, operation.from_clip);
      const to = nextAdjacentClip(config, operation.from_clip, operation.to_clip);
      if (from.track !== to.track || Math.abs((from.at + clipDuration(from)) - to.at) >= 0.001) {
        throw new AstridElementOperationError('Transitions require adjacent clips on the same track');
      }
      const fps = config.output?.fps ?? 30;
      const durationFrames = transitionDurationFrames(transitionEntry, operation.duration_frames);
      assertTransitionFits(from, to, durationFrames, fps);
      return replaceClip(config, to.id, (clip) => ({
        ...clip,
        elementRef: operation.transition,
        transition: {
          type: transitionType(operation.transition.id),
          duration: durationFrames / fps,
          revision: operation.transition.revision,
          ...(operation.params ? { params: operation.params } : {}),
        },
      }));
    }
    case 'timeline.update_transition': {
      const to = nextAdjacentClip(config, operation.from_clip, operation.to_clip);
      const from = requireClip(config, operation.from_clip);
      const transitionEntry = operation.transition
        ? findElement(context, operation.transition, { allowDraft: true })
        : undefined;
      if (transitionEntry && transitionEntry.kind !== 'transition') {
        throw new AstridElementOperationError(`${operation.transition?.id} is not a transition`);
      }
      return replaceClip(config, to.id, (clip) => {
        if (!clip.transition && !operation.transition) {
          throw new AstridElementOperationError(`No transition is applied to ${to.id}`);
        }
        const fps = config.output?.fps ?? 30;
        const durationFrames = transitionDurationFrames(
          transitionEntry ?? context.catalog.find((candidate) => candidate.id === clip.transition?.type && candidate.kind === 'transition') ?? {
            id: clip.transition?.type ?? 'transition',
            label: clip.transition?.type ?? 'transition',
            kind: 'transition',
            placement: 'between-clips',
            revision: clip.transition?.revision ?? 'legacy',
            capabilities: { browserPreview: 'supported', astridExport: 'unknown', workerExport: 'unknown' },
            publication: 'published',
          },
          operation.duration_frames,
        );
        assertTransitionFits(from, to, durationFrames, fps);
        return {
          ...clip,
          ...(operation.transition ? { elementRef: operation.transition } : {}),
          transition: {
            ...(clip.transition ?? { type: transitionType(operation.transition?.id ?? 'cross-fade'), duration: 8 / fps }),
            ...(operation.transition ? { type: transitionType(operation.transition.id), revision: operation.transition.revision } : {}),
            duration: durationFrames / fps,
            ...(operation.params ? { params: operation.params } : {}),
          },
        };
      });
    }
    case 'timeline.remove_transition':
      return replaceClip(config, nextAdjacentClip(config, operation.from_clip).id, (clip) => {
        const { transition: _transition, elementRef: _elementRef, ...withoutTransition } = clip;
        return withoutTransition;
      });
  }
}

/**
 * The one execution boundary for Elements mutations.
 *
 * Every mutation reads the mounted document and uses its current save owner.
 * Runtime acceptance, merge and refusal follow the ordinary persisted outbox.
 */
export class AstridElementOperationAdapter {
  private acknowledgedHead?: TimelineHeadRevision;
  private capturedGeneration?: string;

  constructor(
    private context: AstridAgentElementContext,
    private readonly routes: ElementTimelineRoutes,
    private readonly projectSlug: string,
    private readonly authority?: { timelineId: string; assertAuthority: () => void; getHead?: () => TimelineHeadRevision | undefined; capturedHead?: TimelineHeadRevision },
  ) {}

  captureForTurn(): AstridElementOperationAdapter {
    const head = this.authority?.getHead?.() ?? this.authority?.capturedHead;
    const captured = new AstridElementOperationAdapter(this.context, this.routes, this.projectSlug,
      this.authority ? { ...this.authority, capturedHead: head ? { ...head } : undefined } : undefined);
    captured.capturedGeneration = this.routes.getGeneration?.();
    return captured;
  }

  updateContext(context: AstridAgentElementContext): void {
    this.context = context;
  }

  async execute(rawOperation: unknown): Promise<AstridElementOperationResult> {
    assertValidAstridElementOperation(rawOperation);
    const operation = rawOperation;
    // Read-only catalog inspection remains available; draft creation,
    // validation/publication and timeline writes require the captured owner.
    if (operation.name !== 'elements.list' && operation.name !== 'elements.describe') {
      this.authority?.assertAuthority();
    }
    if ('timeline' in operation && this.authority && operation.timeline !== this.authority.timelineId) {
      throw new AstridElementOperationError(`Element operation timeline ${operation.timeline} does not match ${this.authority.timelineId}`);
    }

    if ('project' in operation && operation.project !== this.projectSlug) {
      throw new AstridElementOperationError(
        `Element operation project ${operation.project} does not match ${this.projectSlug}`,
      );
    }

    const requested = 'element' in operation ? operation.element : 'transition' in operation ? operation.transition : undefined;
    if(requested) await refreshAdmittedElementRef(requested);
    else await refreshAdmittedElements();
    this.authority?.assertAuthority();
    const admitted = admittedCatalogEntries();
    this.context = { ...this.context, catalog: [...admitted, ...this.context.catalog.filter(entry => !admitted.some(candidate => candidate.id === entry.id && candidate.kind === entry.kind && candidate.packId === entry.packId && candidate.revision === entry.revision))] };
    switch (operation.name) {
      case 'elements.create_draft':
      case 'elements.validate':
      case 'elements.publish':
        throw new AstridElementOperationError('Custom element source must live in a project pack. Inspect/init the project-pack, edit its ordinary files, then validate/admit and apply an owner-qualified revision. Embedded source authoring is not supported.');
      case 'elements.list':
        return { operation: operation.name, elements: this.context.catalog };
      case 'elements.describe': {
        const choices = this.context.catalog.filter(entry => entry.id === operation.element_id
          && (!operation.element || (entry.kind === operation.element.kind && entry.packId === operation.element.packId && entry.revision === operation.element.revision)));
        if (choices.length !== 1) throw new AstridElementOperationError(choices.length ? 'Element identity is ambiguous; provide exact owner/kind/id/revision' : 'Element is not registered');
        // Only path/ref/schema metadata. Read ordinary files through native tools; never return JSX through chat.
        return { operation: operation.name, element: choices[0] };
      }
      default: return this.executeTimelineMutation(operation);
    }
  }

  private async executeTimelineMutation(
    operation: Extract<AstridElementOperation, { name: `timeline.${string}` }>,
  ): Promise<AstridElementOperationResult> {
    const generation = this.routes.getGeneration?.();
    if (this.capturedGeneration !== undefined && generation !== this.capturedGeneration) {
      throw new AstridElementOperationError('The captured local timeline changed. Inspect the current timeline before recovering this operation.');
    }
    const document = await this.routes.get(operation.timeline) as TimelineDocument;
    if (document.head) {
      const capturedHead = this.acknowledgedHead ?? this.authority?.capturedHead;
      if (!capturedHead || capturedHead.projectId !== document.head.projectId || capturedHead.timelineId !== document.head.timelineId
        || capturedHead.headRevisionId !== document.head.headRevisionId
        || capturedHead.headPublicationId !== document.head.headPublicationId) {
        throw new AstridElementOperationError('The captured timeline head changed or is missing. Inspect the current timeline before recovering this operation.');
      }
    }
    if (document.config_version !== operation.expected_version) {
      throw new AstridElementOperationError(
        `Stale timeline version: expected ${operation.expected_version}, received ${document.config_version}`,
      );
    }
    const nextConfig = applyTimelineOperation(
      this.context,
      asTimelineConfig(document.config),
      operation,
    );
    const saved = await this.routes.save(operation.timeline, {
      config: nextConfig,
      registry: asAssetRegistry(document.registry),
      expectedVersion: operation.expected_version,
      expectedHead: document.head,
      bundle: document.bundle,
      original: document, operation, context: this.context,
    }) as TimelineDocument;
    this.capturedGeneration = this.routes.getGeneration?.();
    if (saved.head) this.acknowledgedHead = { ...saved.head };
    return {
      operation: operation.name,
      config_version: saved.config_version,
      head: saved.head,
      config: asTimelineConfig(saved.config),
      registry: asAssetRegistry(saved.registry),
    };
  }

}

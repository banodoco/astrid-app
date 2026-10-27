import { createContext } from 'react';
import type { CanonicalDocument, CommitRequest, EditCommand, HistoryPage } from '@/integrations/runtime/timeline-commit-types.ts';
import type { LocalSaveSession } from '../commands/localSaveSession.ts';
import { toOutboxJson, type OutboxJson } from '../commands/commitOutbox.ts';
import { canonicalJsonStringify, type TimelineBundleEnvelope } from '../data/typed/timelineBundle.ts';
import { authoringBundleFromDocument, type AuthoringBundle } from '../commands/authoringBundle.ts';
import { TimelineSaveError, TimelineVersionConflictError, type DataProvider, type TimelineCommandBasis, type TimelineHeadRevision, type TimelineSaveReceipt } from '../data/DataProvider.ts';
import type { AssetRegistry, TimelineConfig } from '../types/index.ts';
import { canonicalizeTimelinePair, projectTimelineTracksForDisplay } from '../lib/timeline-domain.ts';
import { findEnclosingPinnedGroup } from '../lib/pinned-group-projection.ts';
import { withDefaultTimelineOutput } from '../lib/defaults.ts';
import { markTimelineSaveRejection, type TimelineSaveRejectionCode } from '../lib/timeline-diagnostics.ts';
import { applyTimelineOperation, type TimelineElementOperation } from '../runtime/element-adapter.ts';
import type { AstridAgentElementContext } from '../runtime/element-contract.ts';
import { documentPatchIntent } from '../commands/documentPatchIntent.ts';
import type { PlacePreparedMediaCommand } from '../commands/media.ts';

export interface TimelineSaveSource {
  config: TimelineConfig;
  registry: AssetRegistry;
  bundle?: TimelineBundleEnvelope | null;
  head?: TimelineHeadRevision;
}

/** Known gesture callers snapshot their input before authoring the local transform. */
export type TimelineGestureReadBasis = {
  config: TimelineConfig;
  registry: AssetRegistry;
  clipId: string;
} & ({ kind: 'split'; timeSeconds: number } | { kind: 'move'; trackId: string } | {
  kind: 'trim'; patch: Partial<Pick<TimelineConfig['clips'][number], 'from' | 'to' | 'hold' | 'speed'>>;
} | { kind: 'transition-clear'; clipIds: string[] } | { kind: 'prepared-media'; command: PlacePreparedMediaCommand;
  additionalPlacements?: Array<{ command: PlacePreparedMediaCommand; clipId: string }> }
  | { kind: 'element'; operation: TimelineElementOperation; context: AstridAgentElementContext });

/** Assembly supplies the ORIGINAL verified read, not loadTimelineCommandBasis at save time. */
export interface TimelineLocalSaveHandoff {
  capture(source: TimelineSaveSource, gestureBasis?: TimelineGestureReadBasis): Promise<void>;
  flush(): Promise<TimelineSaveReceipt>;
  /** True only when the durable owner is settled and has an accepted target. */
  remoteHistoryAvailable(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

/** Scoped editors supply their own verified physical-image join and durable owner. */
export type TimelinePersistenceHandoff = Pick<TimelineLocalSaveHandoff, 'capture' | 'flush'>;
export interface TimelinePersistenceBinding {
  readonly provider: DataProvider;
  readonly timelineId: string;
}
const persistenceBindings = new WeakMap<TimelinePersistenceBinding, TimelinePersistenceHandoff>();
export const TimelinePersistenceHandoffContext = createContext<TimelinePersistenceBinding | undefined>(undefined);

/** Assembly issues a capability for one provider and one mounted editor scope. */
export function bindTimelinePersistenceHandoff(
  provider: DataProvider, timelineId: string, handoff: TimelinePersistenceHandoff,
): TimelinePersistenceBinding {
  const binding = Object.freeze({ provider, timelineId });
  persistenceBindings.set(binding, handoff);
  return binding;
}

const invalidPersistenceBinding: TimelinePersistenceHandoff = {
  async capture() { throw new TimelineSaveError('Scoped timeline save binding is unavailable; draft retained'); },
  async flush() { throw new TimelineSaveError('Scoped timeline save binding is unavailable; draft retained'); },
};
export function resolveTimelinePersistenceHandoff(
  binding: TimelinePersistenceBinding | undefined, provider: DataProvider, timelineId: string,
): TimelinePersistenceHandoff | undefined {
  if (binding === undefined) return undefined;
  return binding.provider === provider && binding.timelineId === timelineId
    ? persistenceBindings.get(binding) ?? invalidPersistenceBinding : invalidPersistenceBinding;
}

const same = (a: unknown, b: unknown) => a === undefined || b === undefined
  ? a === b : canonicalJsonStringify(a) === canonicalJsonStringify(b);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const field = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;

// Upstream config builders include optional undefined fields. Object omission
// also preserves the editor's explicit transition-clear action as a removal.
function authoredJson(value: unknown): OutboxJson {
  if (Array.isArray(value)) return value.map(authoredJson);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, authoredJson(item)]));
  }
  return toOutboxJson(value);
}

function refuse(message: string, reason?: TimelineSaveRejectionCode): never {
  const error = new TimelineSaveError(`Local document save retained: ${message}`);
  throw reason ? markTimelineSaveRejection(error, reason, 'TimelineSaveError') : error;
}
function checkHead(initial: TimelineCommandBasis, value: TimelineSaveSource,
  reason: TimelineSaveRejectionCode = 'original-head-unavailable') {
  if (!initial.head.revisionId || !initial.head.publicationId
    || initial.canonicalDocument.parent_revision.revision_id !== initial.head.revisionId
    || value.head?.projectId !== initial.canonicalDocument.project_id
    || value.head.timelineId !== initial.canonicalDocument.timeline_id
    || value.head.headRevisionId !== initial.head.revisionId
    || value.head.headPublicationId !== initial.head.publicationId) {
    if (value.head?.projectId === initial.canonicalDocument.project_id
      && value.head.timelineId === initial.canonicalDocument.timeline_id
      && value.head.headRevisionId && value.head.headPublicationId
      && (value.head.headRevisionId !== initial.head.revisionId || value.head.headPublicationId !== initial.head.publicationId)) {
      throw markTimelineSaveRejection(new TimelineVersionConflictError('Local document save retained: original verified authoring head is unavailable'), reason);
    }
    refuse('original verified authoring head is unavailable', reason);
  }
}
function checkSource(initial: TimelineCommandBasis, source: TimelineSaveSource) {
  const parent = initial.canonicalDocument.parent_revision.payload;
  if (!object(parent.config) || !object(parent.registry)) refuse('authored parent config/registry is unavailable', 'source-parent-unavailable');
  const { bundle: _bundle, ...config } = structuredClone(parent.config);
  const loaded = { ...config, ...withDefaultTimelineOutput(config as unknown as TimelineConfig) } as unknown as TimelineConfig;
  const projected = canonicalizeTimelinePair(loaded, structuredClone(parent.registry) as unknown as AssetRegistry);
  // Runtime also loads an explicitly authored top-level parent clip list when
  // config has no clip list. This is a physical parent binding, never children.
  const parentClips = !Object.prototype.hasOwnProperty.call(parent.config, 'clips') && Array.isArray(parent.clips)
    ? canonicalizeTimelinePair({ ...loaded, clips: structuredClone(parent.clips) } as TimelineConfig,
      structuredClone(parent.registry) as unknown as AssetRegistry) : undefined;
  // Accept the original raw view or main's actual load/build view. No arbitrary
  // display snapshot can establish an authored entity binding.
  if ((!same(authoredJson(source.config), authoredJson(loaded))
    && !same(authoredJson(source.config), authoredJson(projected.config))
    && !same(authoredJson(source.config), authoredJson(projectTimelineTracksForDisplay(projected.config)))
    && !(parentClips && same(authoredJson(source.config), authoredJson(projectTimelineTracksForDisplay(parentClips.config)))))
    || !same(authoredJson(source.registry), authoredJson(projected.registry))) {
    refuse('upstream source differs from the verified authored parent', 'source-parent-mismatch');
  }
  for (const key of ['clips', 'tracks'] as const) {
    const raw = parent.config[key];
    const view = source.config[key];
    if (Array.isArray(raw) && (!Array.isArray(view) || raw.length !== view.length
      || raw.some((row, index) => !object(row) || row.id !== view[index].id)
      || new Set(raw.map((row) => (row as Record<string, unknown>).id)).size !== raw.length)) {
      refuse(`authored ${key} identity changed in projection`, key === 'clips' ? 'source-clip-identity' : 'source-track-identity');
    }
  }
  if (source.bundle !== undefined && !same(parent.config.bundle, source.bundle)) refuse('original authored bundle differs', 'source-bundle-mismatch');
}

export interface TimelineOriginalSaveBasis {
  initial: TimelineCommandBasis;
  source: TimelineSaveSource;
  authoringBundle: AuthoringBundle;
}

/** Read during assembly only; a newer head cannot substitute for the displayed original. */
export async function readTimelineOriginalSaveBasis(
  provider: DataProvider, timelineId: string, input: TimelineSaveSource,
): Promise<TimelineOriginalSaveBasis> {
  const source = structuredClone(input);
  if (!provider.loadTimelineCommandBasis || source.head?.timelineId !== timelineId) {
    refuse('original verified authoring read is unavailable', 'original-read-unavailable');
  }
  const initial = structuredClone(await provider.loadTimelineCommandBasis(timelineId));
  checkHead(initial, source);
  // The existing carrier binds raw physical images and occurrence ownership.
  // It neither executes edits nor invents successor pins.
  const authoringBundle = await authoringBundleFromDocument(initial.canonicalDocument);
  checkSource(initial, source);
  return { initial, source, authoringBundle };
}

/** Parent-only upstream save mapping. Child edits need their own authored assembly join. */
export function createTimelineLocalSaveHandoff(options: {
  initial: TimelineCommandBasis;
  source: TimelineSaveSource;
  session: LocalSaveSession;
  /** Read the upstream assembly after the session has adopted the complete canonical result. */
  loadHistory?(): Promise<TimelineCommandBasis>;
  adopted(basis: TimelineCommandBasis): { receipt: TimelineSaveReceipt; source: TimelineSaveSource };
}): TimelineLocalSaveHandoff {
  checkHead(options.initial, options.source);
  let initial = structuredClone(options.initial);
  let source = structuredClone(options.source);
  let authoringSource = structuredClone(options.source);
  let document = structuredClone(options.initial.canonicalDocument);
  let sourceChecked = false;
  let targets = historyTargets(options.initial.history, options.initial.head);
  let inversePending = false;

  async function appendInverse(kind: 'undo' | 'redo'): Promise<void> {
    if (!remoteHistoryAvailable()) refuse('durable timeline history is not settled');
    const target = targets[kind].at(-1);
    if (!target) refuse(`no persisted ${kind} target is available`);
    inversePending = true;
    try {
      const before = options.session.getDocument();
      const command: EditCommand = {
        schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
        args: { publications: [target] },
      };
      // Native inverse guards come from authenticated publications, with no
      // additional caller reads beyond the target operand.
      await options.session.append({ before, after: before,
        label: `${kind === 'undo' ? 'Undo' : 'Redo'} timeline`, commands: [command], reads: [] });
      await handoff.flush();
    } finally {
      inversePending = false;
    }
  }

  function remoteHistoryAvailable(): boolean {
    return !inversePending && options.session.getState().status === 'saved';
  }
  function changes(raw: unknown, previous: unknown, next: unknown, path: string[], element = false): unknown {
    if (same(previous, next)) return structuredClone(raw);
    if (Array.isArray(previous) && Array.isArray(next) && path.length === 2
      && path[0] === 'config' && ['clips', 'tracks'].includes(path[1])) {
      if (!Array.isArray(raw)) refuse(`authored collection is unavailable: ${path.join('/')}`, 'authored-collection-unavailable');
      const oldRows = new Map(previous.map((row) => [row.id, row]));
      const rawRows = new Map(raw.map((row) => [row.id, row]));
      if (oldRows.size !== previous.length || new Set(next.map((row) => row.id)).size !== next.length
        || previous.some((row) => typeof row.id !== 'string' || !rawRows.has(row.id))
        || rawRows.size !== previous.length) refuse('authored parent entity binding is ambiguous', 'authored-binding-ambiguous');
      return next.map((row) => {
        if (!object(row) || typeof row.id !== 'string' || !row.id) refuse('authored entity identity is unavailable', 'authored-identity-unavailable');
        return oldRows.has(row.id)
          ? changes(rawRows.get(row.id), oldRows.get(row.id), row, [...path, row.id], element) : authoredJson(row);
      });
    }
    if (object(previous) && object(next)) {
      if (!object(raw)) refuse(`changed display container has no authored binding: ${path.join('/')}`, 'display-container-unbound');
      const result = structuredClone(raw);
      // The app extension is projected verbatim. Trim removes these authored
      // leaves from an explicitly supplied namespace; other omissions stay partial.
      if (path.length === 5 && path[0] === 'config' && path[1] === 'clips'
        && path[3] === 'app' && path[4] === 'astrid') {
        for (const key of ['for', 'until']) {
          if (!Object.prototype.hasOwnProperty.call(previous, key) || Object.prototype.hasOwnProperty.call(next, key)) continue;
          if (!same(field(raw, key), field(previous, key))) refuse(`trim intent has no exact authored binding: ${[...path, key].join('/')}`, 'trim-binding-mismatch');
          delete result[key];
        }
      }
      if (element && path.length === 3 && path[0] === 'config' && path[1] === 'clips') {
        for (const key of ['elementRef', 'entrance', 'transition']) {
          if (Object.prototype.hasOwnProperty.call(previous, key) && next[key] === undefined
            && !same(previous[key], next[key])) delete result[key];
        }
      }
      // Omission is a partial editor view, not an explicit clear. An unchanged
      // default/undefined never overwrites the raw own key (including null).
      for (const [key, value] of Object.entries(next)) {
        if (same(field(previous, key), value)) continue;
        if (value === undefined) {
          if ((!(element && ['elementRef', 'entrance'].includes(key)) && key !== 'transition') || path.length !== 3 || path[0] !== 'config' || path[1] !== 'clips') {
            refuse(`explicit clear is unavailable: ${[...path, key].join('/')}`, 'explicit-clear-unavailable');
          }
          delete result[key];
        } else {
          Object.defineProperty(result, key, { value: changes(field(raw, key), field(previous, key), value, [...path, key], element),
            enumerable: true, writable: true, configurable: true });
        }
      }
      return result;
    }
    if ((Array.isArray(next) || object(next)) && raw !== undefined && !same(raw, previous)) {
      refuse(`changed display value has no exact authored binding: ${path.join('/')}`, 'display-value-unbound');
    }
    return authoredJson(next);
  }
  const handoff: TimelineLocalSaveHandoff = {
    capture(input, gestureBasis) {
      try {
        const next = structuredClone(input);
        checkHead(initial, source, 'capture-source-head-unavailable');
        checkHead(initial, next, 'capture-input-head-unavailable');
        const before = options.session.getDocument() as unknown as CanonicalDocument;
        const parent = before.parent_revision.payload;
        const hasChildren = before.shot_revisions.length || before.internal_timeline_revisions.length
          || (Array.isArray(parent.occurrences) && parent.occurrences.length);
        const parentGesture = gestureBasis?.kind === 'move' || gestureBasis?.kind === 'transition-clear';
        if (hasChildren && !parentGesture && gestureBasis?.kind !== 'prepared-media' && gestureBasis?.kind !== 'element') refuse('child ownership/fork mapping is unavailable', 'child-ownership-unavailable');
        if (!sourceChecked) { checkSource(initial, source); sourceChecked = true; }
        if (!same(before, document)) refuse('local authored document changed outside this handoff', 'local-document-changed');
        authoredJson(next); // Reject non-finite editor values before mutating the chain.
        const after = structuredClone(before);
        const payload = after.parent_revision.payload;
        const topLevelClips = (parentGesture || gestureBasis?.kind === 'prepared-media' || gestureBasis?.kind === 'element') && object(parent.config)
          && !Object.prototype.hasOwnProperty.call(parent.config, 'clips') && Array.isArray(parent.clips);
        const configBefore = topLevelClips ? { ...parent.config as Record<string, OutboxJson>, clips: parent.clips } : parent.config;
        const configSource = topLevelClips && !source.config.clips.length
          ? { ...source.config, clips: parent.clips } : source.config;
        if (gestureBasis?.kind === 'element' && topLevelClips && !source.config.clips.length
          && Array.isArray(parent.clips) && parent.clips.length) refuse('element parent clips are not present in the mounted source');
        payload.config = changes(configBefore, configSource, next.config, ['config'], gestureBasis?.kind === 'element') as Record<string, OutboxJson>;
        if (gestureBasis?.kind === 'prepared-media') {
          const selectedAssets = [gestureBasis.command, ...(gestureBasis.additionalPlacements ?? []).map(item => item.command)]
            .map(command => command.payload.asset);
          const entries = Object.fromEntries(selectedAssets.map(asset => [asset.assetKey, asset.entry]));
          if (!object(parent.registry) || (parent.registry.assets !== undefined && !object(parent.registry.assets))
            || !same(authoredJson(next.registry), authoredJson({ ...source.registry,
              assets: { ...source.registry.assets, ...entries } }))) {
            refuse('prepared media registry changes exceed the selected assets; draft retained');
          }
          // Bootstrap registry is {}, while the editor displays { assets: {} }.
          payload.registry = { ...parent.registry, assets: { ...(parent.registry.assets ?? {}),
            ...authoredJson(entries) as Record<string, OutboxJson> } };
        } else {
          payload.registry = changes(parent.registry, source.registry, next.registry, ['registry']) as Record<string, OutboxJson>;
        }
        if (next.bundle !== undefined && !same(source.bundle, next.bundle)) {
          (payload.config as Record<string, OutboxJson>).bundle = authoredJson(next.bundle);
        }
        for (const key of ['clips', 'tracks'] as const) {
          if (!Object.prototype.hasOwnProperty.call(parent, key)) continue;
          if (key === 'clips' && topLevelClips) { payload.clips = (payload.config as Record<string, OutboxJson>).clips; continue; }
          if (!same(parent[key], (parent.config as Record<string, unknown>)[key])) refuse(`contradictory parent ${key} mirror`, 'parent-mirror-mismatch');
          payload[key] = (payload.config as Record<string, OutboxJson>)[key];
        }
        let reads: OutboxJson[] | undefined;
        if (gestureBasis) {
          // The drop's transient skeleton can assemble its newly created track
          // before the media gesture. Bind every other input to the original;
          // the prepared-media guard below proves the one new track exactly.
          const gestureConfig = gestureBasis.kind === 'prepared-media'
            ? { ...gestureBasis.config, tracks: authoringSource.config.tracks } : gestureBasis.config;
          if (!['split', 'trim', 'move', 'transition-clear', 'prepared-media', 'element'].includes(gestureBasis.kind)
            || !same(authoredJson(gestureConfig), authoredJson(authoringSource.config))
            || !same(authoredJson(gestureBasis.registry), authoredJson(authoringSource.registry))) {
            refuse('gesture read basis differs from the original local authoring input', 'gesture-basis-mismatch');
          }
        }
        // Authority comes from the original parent selection and causal input,
        // never from observing that a flattened diff happens to touch one field.
        if (parentGesture) {
          const ids = gestureBasis.kind === 'move' ? [gestureBasis.clipId] : gestureBasis.clipIds;
          if (!ids.length || ids[0] !== gestureBasis.clipId || new Set(ids).size !== ids.length
            || ids.some(id => authoringSource.config.clips.filter(clip => clip.id === id).length !== 1
              || findEnclosingPinnedGroup(authoringSource.config, id))) {
            refuse('gesture selected clip has no unique authored parent binding', 'gesture-clip-ambiguous');
          }
          const expected = structuredClone(authoringSource);
          for (const id of ids) {
            const clip = expected.config.clips.find(clip => clip.id === id)!;
            const selected = next.config.clips.filter(clip => clip.id === id);
            if (selected.length !== 1) refuse('gesture selected clip has no unique authored parent binding', 'gesture-clip-ambiguous');
            if (gestureBasis.kind === 'move') {
              if (!Number.isFinite(selected[0].at) || selected[0].at < 0) refuse('parent move time is unavailable');
              clip.at = selected[0].at;
            } else {
              if (selected[0].transition !== undefined) refuse('parent transition clear is unavailable');
              delete clip.transition;
            }
          }
          if (!same(authoredJson(expected.config), authoredJson(next.config))
            || !same(authoredJson(expected.registry), authoredJson(next.registry))
            || !same(expected.bundle, next.bundle)) refuse('parent gesture changes more than its selected fields');
          if (gestureBasis.kind === 'transition-clear') {
            // The rows builder omits undefined. The explicit causal clear still
            // removes the selected raw own key, including an authored null.
            const clips = (payload.config as Record<string, OutboxJson>).clips;
            if (!Array.isArray(clips)) refuse('parent transition clips are unavailable');
            for (const clip of clips) {
              if (object(clip) && ids.includes(clip.id as string)) delete clip.transition;
            }
          }
        }
        if (gestureBasis?.kind === 'element') {
          if (!same(next.registry, authoringSource.registry) || !same(next.bundle, authoringSource.bundle)
            || !same(authoredJson(next.config), authoredJson(applyTimelineOperation(gestureBasis.context,
              gestureBasis.config, gestureBasis.operation)))) refuse('element operation differs from its original causal input');
          const config = configBefore as Record<string, OutboxJson>;
          if (!Array.isArray(config.clips)) refuse('element parent clips are unavailable');
          const clips = config.clips as Record<string, OutboxJson>[];
          const order = clips.map(row => row.id as string);
          const clipPath = topLevelClips ? ['clips'] : ['config', 'clips'];
          reads = [{ kind: 'collection', ref: 'parent', path: clipPath, members: [...order].sort(), order }];
          const read = (row: Record<string, OutboxJson>, key: string, path: string[]) => reads!.push({
            kind: 'field', ref: 'parent', path: [...path, key], state: Object.prototype.hasOwnProperty.call(row, key)
              ? { state: 'present', value: row[key] } : { state: 'absent' },
          });
          const op = gestureBasis.operation;
          const selectedId = 'from_clip' in op ? op.from_clip : op.clip_id;
          const selected = clips.find(row => row.id === selectedId);
          const transition = ['timeline.apply_transition', 'timeline.update_transition', 'timeline.remove_transition'].includes(op.name);
          for (const row of clips) {
            // Lookup/allocation consults IDs; adjacency additionally routes and sorts.
            const keys = new Set(['id']);
            if (transition) { keys.add('track'); keys.add('at'); }
            if (row === selected || transition) {
              if (transition || (op.name === 'timeline.apply_element' && op.placement === 'overlay' && op.duration === undefined)) {
                for (const key of ['clipType', 'hold', 'from', 'to', 'speed']) keys.add(key);
              }
              if (op.name === 'timeline.apply_element') {
                if (op.placement === 'overlay') { keys.add('track'); if (op.at === undefined) keys.add('at'); }
                else if (op.params) keys.add('params');
              } else if (op.name === 'timeline.update_element') {
                keys.add('elementRef'); if (op.params) keys.add('params');
                if (op.duration !== undefined) for (const key of ['clipType', 'hold', 'asset', 'file', 'src', 'source', 'from', 'to']) keys.add(key);
              } else if (op.name === 'timeline.remove_element') { keys.add('elementRef'); keys.add('entrance'); }
              else if (op.name === 'timeline.set_clip_fade') keys.add('effects');
              else if (op.name === 'timeline.update_transition') keys.add('transition');
            }
            for (const key of keys) read(row, key, [...clipPath, `id:${row.id}`]);
          }
          if (op.name === 'timeline.apply_element' && op.placement === 'overlay') read(config, 'tracks', ['config']);
          if (transition) {
            // output.fps is defaulted from the theme by the upstream loader.
            read(config, 'output', ['config']);
            read(config, 'theme', ['config']); read(config, 'theme_overrides', ['config']);
          }
        }
        let commands: EditCommand[] | undefined;
        let mediaReads: CommitRequest['reads'];
        let mediaSteps: CommitRequest['steps'];
        let mediaLabel = 'Add media';
        if (gestureBasis?.kind === 'prepared-media') {
          if (gestureBasis.command.type !== 'place-prepared-media') refuse('prepared media command is unavailable');
          const extraPlacements = gestureBasis.additionalPlacements ?? [];
          if (extraPlacements.length) {
            const placements = [
              { command: gestureBasis.command, clipId: gestureBasis.clipId },
              ...extraPlacements,
            ];
            if (placements.some(({ command, clipId }) => command.type !== 'place-prepared-media' || !clipId)
              || new Set(placements.map(({ clipId }) => clipId)).size !== placements.length) {
              refuse('prepared media batch has duplicate or missing clip bindings');
            }
            const config = configBefore as Record<string, OutboxJson>;
            const nextConfig = payload.config as Record<string, OutboxJson>;
            const clips = config.clips;
            const nextClips = nextConfig.clips;
            const tracks = config.tracks;
            const nextTracks = nextConfig.tracks;
            if (!Array.isArray(clips) || !Array.isArray(nextClips) || !Array.isArray(tracks) || !Array.isArray(nextTracks)) {
              refuse('prepared media batch collections are unavailable');
            }
            const placementRows = placements.map(({ command, clipId }) => {
              const prepared = command.payload;
              const media = prepared.asset.mediaSelection;
              const keys = ['asset', 'generation_id', 'variant_id', 'object_id', 'catalog_digest'];
              if (!media || Object.keys(media).length !== keys.length
                || keys.some(key => typeof media[key as keyof typeof media] !== 'string' || !media[key as keyof typeof media])
                || (prepared.removeClipId !== undefined && !prepared.removeClipId.startsWith('uploading-'))
                || prepared.afterClipId || prepared.replaceClipId || prepared.removeClipIds?.length || prepared.pinnedShotGroupsOverride
                || !['image', 'video'].includes(prepared.asset.mediaType)
                || prepared.asset.assetKey !== media.asset) {
                refuse('prepared media batch requires ordinary Runtime image/video adds with exact project selections');
              }
              const matches = nextClips.filter(clip => object(clip) && clip.id === clipId);
              if (matches.length !== 1 || clips.some(clip => object(clip) && clip.id === clipId)) {
                refuse('prepared media batch clip has no unique added parent binding');
              }
              const row = matches[0] as Record<string, OutboxJson>;
              if (row.asset !== prepared.asset.assetKey) refuse('prepared media batch clip does not match its selected asset');
              return { prepared, media, row };
            });
            const placementIds = new Set(placements.map(({ clipId }) => clipId));
            const addedRows = nextClips.filter(clip => object(clip) && placementIds.has(String(clip.id)));
            if (addedRows.length !== placements.length
              || nextClips.length !== clips.length + placements.length
              || !same(nextClips.filter(clip => !object(clip) || !placementIds.has(String(clip.id))), clips)) {
              refuse('prepared media batch changes more than its selected parent clips');
            }
            const addedTrackIds = new Set(nextTracks.filter(track => object(track)
              && !tracks.some(old => object(old) && old.id === track.id)).map(track => String((track as Record<string, unknown>).id)));
            const referencedNewTracks = new Set(placementRows.map(({ row }) => String(row.track))
              .filter(trackId => addedTrackIds.has(trackId)));
            if (referencedNewTracks.size !== addedTrackIds.size
              || !same(nextTracks.filter(track => !object(track) || !addedTrackIds.has(String(track.id))), tracks)
              || (!same(authoredJson(gestureBasis.config.tracks), authoredJson(authoringSource.config.tracks))
                && !same(authoredJson(gestureBasis.config.tracks), authoredJson(nextConfig.tracks)))) {
              refuse('prepared media batch changes more than its selected parent tracks');
            }
            placementRows.forEach(({ prepared, row }) => {
              const matches = nextTracks.filter(track => object(track) && track.id === row.track);
              const expectedKind = prepared.asset.mediaType === 'image' || prepared.asset.mediaType === 'video' ? 'visual' : 'audio';
              if (matches.length !== 1 || !object(matches[0]) || matches[0].kind !== expectedKind
                || (matches[0].role ?? 'output') !== 'output') {
                refuse('prepared media batch placement needs a compatible output track');
              }
            });
            if (!same({ ...nextConfig, clips, tracks }, config)) {
              refuse('prepared media batch changes unrelated parent config');
            }
            const occurrences = parent.occurrences;
            if (Array.isArray(occurrences) && placementRows.some(({ row }) => occurrences.some(occurrence => object(occurrence)
              && (occurrence.track === row.track || (object(occurrence.placement) && occurrence.placement.track === row.track))))) {
              refuse('child ownership/fork mapping is unavailable', 'child-ownership-unavailable');
            }
            const assets = new Map<string, { entry: unknown; media: unknown }>();
            for (const { prepared, media } of placementRows) {
              if (assets.has(prepared.asset.assetKey) && !same(assets.get(prepared.asset.assetKey),
                { entry: authoredJson(prepared.asset.entry), media: authoredJson(media) })) refuse('prepared media batch repeats an inconsistent asset identity');
              assets.set(prepared.asset.assetKey, { entry: authoredJson(prepared.asset.entry), media: authoredJson(media) });
            }
            const expectedAssets = { ...(parent.registry && object(parent.registry) && object(parent.registry.assets) ? parent.registry.assets : {}) };
            for (const [assetKey, { entry }] of assets) expectedAssets[assetKey] = entry as OutboxJson;
            if (!object(parent.registry) || (parent.registry.assets !== undefined && !object(parent.registry.assets))
              || !same(payload.registry, { ...parent.registry, assets: expectedAssets })) {
              refuse('prepared media batch registry changes exceed the selected assets; draft retained');
            }
            const newTracks = nextTracks.filter(track => object(track) && addedTrackIds.has(String(track.id)));
            commands = [
              ...newTracks.map(track => ({ schema_version: 1, op: 'track.create', version: '1', select: 'parent',
                args: { row: authoredJson(track) }, intent: {}, created: [`parent/track:${(track as Record<string, unknown>).id}`] } as EditCommand)),
            ];
            const trackCommandCount = commands.length;
            const createdAssets = new Set(Object.keys(object(parent.registry) && object(parent.registry.assets) ? parent.registry.assets : {}));
            for (let index = 0; index < placementRows.length; index += 1) {
              const { prepared, media, row } = placementRows[index];
              commands.push({ schema_version: 1, op: 'clip.add-media', version: '1', select: 'parent',
                args: { row: authoredJson(row), media: authoredJson(media) }, intent: {}, created: [
                  ...(createdAssets.has(prepared.asset.assetKey) ? [] : [`parent/asset:${prepared.asset.assetKey}`]),
                  `parent/clip:${placements[index].clipId}`,
                ] });
              createdAssets.add(prepared.asset.assetKey);
            }
            if (newTracks.length && !same(nextTracks, [...tracks, ...newTracks])) {
              const appended = structuredClone(before);
              const appendedPayload = appended.parent_revision.payload;
              (appendedPayload.config as Record<string, OutboxJson>).tracks = [...tracks, ...newTracks];
              if (Object.prototype.hasOwnProperty.call(parent, 'tracks')) appendedPayload.tracks = [...tracks, ...newTracks];
              const reordered = structuredClone(appended);
              (reordered.parent_revision.payload.config as Record<string, OutboxJson>).tracks = nextTracks;
              if (Object.prototype.hasOwnProperty.call(parent, 'tracks')) reordered.parent_revision.payload.tracks = nextTracks;
              const patch = documentPatchIntent({ before: appended, after: reordered, basis: { head: initial.head },
                roots: [{ ref: 'parent', revisionId: before.parent_revision.revision_id, contentDigest: before.parent_revision.content_digest }],
                label: mediaLabel, step: { id: crypto.randomUUID(), label: 'Position new tracks', intent: 'Keep the dropped track positions', tags: [] }, reads: [] }) as Record<string, OutboxJson>;
              commands.splice(trackCommandCount, 0, { schema_version: 1, op: 'doc.patch', version: '1', select: null,
                args: { changes: patch.changes }, created: patch.created as string[] });
              mediaReads = [];
              mediaSteps = commands.map((_, index) => index === trackCommandCount
                ? { ...patch.step as NonNullable<CommitRequest['steps']>[number], command_ordinals: [index], patch: patch.changes as NonNullable<CommitRequest['steps']>[number]['patch'] }
                : { id: crypto.randomUUID(), label: mediaLabel, intent: mediaLabel, tags: [], command_ordinals: [index], patch: [] });
            }
          } else {
            const prepared = gestureBasis.command.payload;
            const media = prepared.asset.mediaSelection;
            const keys = ['asset', 'generation_id', 'variant_id', 'object_id', 'catalog_digest'];
            if (!media || Object.keys(media).length !== keys.length
              || keys.some(key => typeof media[key as keyof typeof media] !== 'string' || !media[key as keyof typeof media])) {
              refuse('prepared media needs the Runtime project media selection. Draft retained; reload the timeline, then import the media again');
            }
            const duplicateVideo = Boolean(prepared.afterClipId && prepared.asset.mediaType === 'video');
            // File drops may remove only their transient uploading action. The
            // command caller separately proves that the action exists locally;
            // this handoff still refuses authored IDs and non-drop removals.
            if ((prepared.removeClipId !== undefined
              && (duplicateVideo || !prepared.removeClipId.startsWith('uploading-')))
              || (!duplicateVideo && prepared.afterClipId) || prepared.replaceClipId || prepared.removeClipIds?.length
              || prepared.pinnedShotGroupsOverride
              || (!duplicateVideo && !['image', 'video'].includes(prepared.asset.mediaType))) {
              refuse('prepared media currently supports an ordinary image/video add on a visual track. Draft retained; reload the timeline, then choose Add media');
            }
            const config = configBefore as Record<string, OutboxJson>;
            const nextConfig = payload.config as Record<string, OutboxJson>;
            const clips = config.clips;
            const nextClips = nextConfig.clips;
            if (!Array.isArray(clips) || !Array.isArray(nextClips)) refuse('prepared media clip collection is unavailable');
            if (prepared.removeClipId !== undefined && clips.some(clip => object(clip) && clip.id === prepared.removeClipId)) {
              refuse('prepared media cannot remove an authored parent clip. Draft retained; reload the timeline, then choose Add media');
            }
            const row = duplicateVideo ? nextClips.find(clip => object(clip) && clip.id === gestureBasis.clipId) : nextClips.at(-1);
            const tracks = config.tracks;
            const nextTracks = nextConfig.tracks;
            const newTrack = object(row) && Array.isArray(tracks) && Array.isArray(nextTracks)
              && !tracks.some(track => object(track) && track.id === row.track)
              ? nextTracks.find(track => object(track) && track.id === row.track) : undefined;
            const visualTrack = object(row) && Array.isArray(nextTracks)
              && nextTracks.filter(track => object(track) && track.id === row.track);
            if (!object(row) || row.id !== gestureBasis.clipId || row.asset !== prepared.asset.assetKey
              || clips.some(clip => object(clip) && clip.id === row.id)
              || (!duplicateVideo && !same(nextClips.slice(0, -1), clips))
              || !Array.isArray(tracks) || !Array.isArray(nextTracks)
              || (!same(authoredJson(gestureBasis.config.tracks), authoredJson(authoringSource.config.tracks))
                && (!newTrack || !same(authoredJson(gestureBasis.config.tracks), authoredJson(next.config.tracks))))
              || !same({ ...nextConfig, clips, tracks }, config)
              || (newTrack ? duplicateVideo || !same(nextTracks.filter(track => track !== newTrack), tracks)
                : !same(nextTracks, tracks))
              || !visualTrack || visualTrack.length !== 1 || !object(visualTrack[0])
              || visualTrack[0].kind !== 'visual' || (visualTrack[0].role ?? 'output') !== 'output') {
              refuse('prepared media changes more than one ordinary parent clip. Draft retained; reload the timeline, then choose an existing visual track');
            }
            if (Array.isArray(parent.occurrences) && parent.occurrences.some(occurrence => object(occurrence)
              && (occurrence.track === row.track || (object(occurrence.placement) && occurrence.placement.track === row.track)))) {
              refuse('child ownership/fork mapping is unavailable', 'child-ownership-unavailable');
            }
            if (!object(parent.registry) || (parent.registry.assets !== undefined && !object(parent.registry.assets))
              || !same(payload.registry, { ...parent.registry, assets: { ...(parent.registry.assets ?? {}),
                [prepared.asset.assetKey]: authoredJson(prepared.asset.entry) } })) {
              refuse('prepared media registry changes exceed the selected asset; draft retained');
            }
            if (duplicateVideo) {
              mediaLabel = 'Add video after clip';
              const old = prepared.oldMediaSelection;
              const anchorIndex = clips.findIndex(clip => object(clip) && clip.id === prepared.afterClipId);
              const anchor = clips[anchorIndex];
              if (!old || Object.keys(old).length !== keys.length
                || keys.some(key => typeof old[key as keyof typeof old] !== 'string' || !old[key as keyof typeof old])
                || !object(anchor) || anchor.asset !== old.asset || row.asset !== media.asset) {
                refuse('video duplication needs both exact Runtime project media selections. Draft retained; reload the timeline, then import the media again');
              }
              // Bound the consumer to the upstream parent duplicate preview. Timing
              // and metadata normalization remain the provider's responsibility.
              const retained = nextClips.filter(clip => object(clip) && clip.id !== row.id);
              if (nextClips.length !== clips.length + 1 || !same(nextClips.map(clip => object(clip) ? clip.id : null),
                [...clips.slice(0, anchorIndex + 1).map(clip => object(clip) ? clip.id : null), row.id,
                  ...clips.slice(anchorIndex + 1).map(clip => object(clip) ? clip.id : null)])
                || row.track !== anchor.track || clips.some((clip, index) => {
                  const nextClip = retained[index];
                  if (!object(clip) || !object(nextClip)) return true;
                  return index <= anchorIndex || clip.track !== anchor.track ? !same(clip, nextClip)
                    : !same({ ...nextClip, at: clip.at }, clip);
                })) refuse('video duplication exceeds one parent after-anchor preview; draft retained');
              commands = [{ schema_version: 1, op: 'clip.duplicate-media', version: '1',
                select: `parent/clip:${prepared.afterClipId}`, args: { id: row.id, old_media: authoredJson(old), media: authoredJson(media) },
                intent: { ownership: 'parent' }, created: [
                  ...(Object.prototype.hasOwnProperty.call(parent.registry.assets, media.asset) ? [] : [`parent/asset:${media.asset}`]),
                  `parent/clip:${row.id}`,
                ] }];
              const order = clips.map(clip => (clip as Record<string, OutboxJson>).id as string);
              mediaReads = [{ kind: 'collection', ref: 'parent', path: ['config', 'clips'], members: [...order].sort(), order }];
              mediaSteps = [{ id: crypto.randomUUID(), label: 'Add video after clip', intent: 'Duplicate selected parent video', tags: [],
                command_ordinals: [0], patch: [], reads: [{ kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${prepared.afterClipId}`],
                  state: { state: 'present', value: authoredJson(anchor) } }] }];
            } else {
              commands = [
                ...(newTrack ? [{ schema_version: 1, op: 'track.create', version: '1', select: 'parent',
                  args: { row: authoredJson(newTrack) }, intent: {}, created: [`parent/track:${row.track}`] } as EditCommand] : []),
                { schema_version: 1, op: 'clip.add-media', version: '1', select: 'parent',
                args: { row: authoredJson(row), media: authoredJson(media) }, intent: {}, created: [
                  ...(Object.prototype.hasOwnProperty.call(parent.registry.assets ?? {}, row.asset) ? [] : [`parent/asset:${row.asset}`]),
                  `parent/clip:${row.id}`,
                ] }];
            }
            // track.create appends. Preserve a drop at the top in the same
            // atomic commit, using the normal document-patch encoder for order.
            if (newTrack && nextTracks.at(-1) !== newTrack) {
              const appended = structuredClone(before);
              const appendedPayload = appended.parent_revision.payload;
              (appendedPayload.config as Record<string, OutboxJson>).tracks = [...tracks, newTrack];
              if (Object.prototype.hasOwnProperty.call(parent, 'tracks')) appendedPayload.tracks = [...tracks, newTrack];
              const reordered = structuredClone(appended);
              (reordered.parent_revision.payload.config as Record<string, OutboxJson>).tracks = nextTracks;
              if (Object.prototype.hasOwnProperty.call(parent, 'tracks')) reordered.parent_revision.payload.tracks = nextTracks;
              const patch = documentPatchIntent({ before: appended, after: reordered, basis: { head: initial.head },
                roots: [{ ref: 'parent', revisionId: before.parent_revision.revision_id, contentDigest: before.parent_revision.content_digest }],
                label: mediaLabel, step: { id: crypto.randomUUID(), label: 'Position new track', intent: 'Keep the dropped track position', tags: [] },
                reads: [] }) as Record<string, OutboxJson>;
              commands!.splice(1, 0, { schema_version: 1, op: 'doc.patch', version: '1', select: null,
                args: { changes: patch.changes }, created: patch.created as string[] });
              mediaReads = [];
              mediaSteps = commands!.map((_, index) => index === 1
                ? { ...patch.step as NonNullable<CommitRequest['steps']>[number], command_ordinals: [index], patch: patch.changes as NonNullable<CommitRequest['steps']>[number]['patch'] }
                : { id: crypto.randomUUID(), label: mediaLabel, intent: mediaLabel, tags: [], command_ordinals: [index], patch: [] });
            }
          }
        }
        // Verified parent recipes preserve the complete child closure cloned above.
        if (hasChildren && !parentGesture && !commands && gestureBasis?.kind !== 'element') refuse('child ownership/fork mapping is unavailable', 'child-ownership-unavailable');
        if (topLevelClips) delete (payload.config as Record<string, OutboxJson>).clips;
        if (!commands) {
          const clips = (payload.config as Record<string, OutboxJson>).clips;
          const previous = (parent.config as Record<string, OutboxJson>).clips;
          const assets = object(parent.registry) && object(parent.registry.assets) ? parent.registry.assets : {};
          const nextAssets = object(payload.registry) && object(payload.registry.assets) ? payload.registry.assets : {};
          if (Array.isArray(clips) && clips.some(clip => object(clip) && typeof clip.asset === 'string'
            && !Object.prototype.hasOwnProperty.call(assets, clip.asset)
            && (Object.prototype.hasOwnProperty.call(nextAssets, clip.asset) || !Array.isArray(previous)
              || !previous.some(old => object(old) && old.id === clip.id && old.asset === clip.asset)))) {
            refuse('new media needs its original Runtime project media selection. Draft retained; reload the timeline, then import the media again');
          }
        }
        if (gestureBasis?.kind === 'transition-clear') {
          const clips = (configBefore as Record<string, OutboxJson>).clips;
          if (!Array.isArray(clips)) refuse('gesture clip read has no authored collection', 'gesture-clips-unavailable');
          const clipPath = topLevelClips ? ['clips'] : ['config', 'clips'];
          reads = gestureBasis.clipIds.flatMap(id => {
            const selected = clips.filter(clip => object(clip) && clip.id === id);
            if (selected.length !== 1) refuse('gesture selected clip has no unique authored binding', 'gesture-clip-ambiguous');
            const clip = selected[0] as Record<string, OutboxJson>;
            return ['id', 'transition'].map(key => {
              const state: OutboxJson = Object.prototype.hasOwnProperty.call(clip, key)
                ? { state: 'present', value: clip[key] } : { state: 'absent' };
              return { kind: 'field', ref: 'parent', path: [...clipPath, `id:${id}`, key], state };
            });
          });
          reads.push({ kind: 'field', ref: 'parent', path: ['config', 'pinnedShotGroups'],
            state: Object.prototype.hasOwnProperty.call(configBefore, 'pinnedShotGroups')
              ? { state: 'present', value: (configBefore as Record<string, OutboxJson>).pinnedShotGroups } : { state: 'absent' } });
        }
        if (gestureBasis && gestureBasis.kind !== 'prepared-media' && gestureBasis.kind !== 'element' && gestureBasis.kind !== 'transition-clear') {
          const config = parent.config as Record<string, unknown>;
          const clips = (configBefore as Record<string, unknown>).clips;
          const clipPath = topLevelClips ? ['clips'] : ['config', 'clips'];
          if (!Array.isArray(clips)) refuse('gesture clip read has no authored collection', 'gesture-clips-unavailable');
          const selected = clips.filter((clip) => object(clip) && clip.id === gestureBasis.clipId);
          if (selected.length !== 1) refuse('gesture selected clip has no unique authored binding', 'gesture-clip-ambiguous');
          const clip = selected[0] as Record<string, unknown>;
          const read = (value: Record<string, unknown>, key: string, path: string[]): OutboxJson => ({
            kind: 'field', ref: 'parent', path: [...path, key],
            state: Object.prototype.hasOwnProperty.call(value, key)
              ? { state: 'present', value: authoredJson(value[key]) } : { state: 'absent' },
          });
          // Read the nearest missing/null ancestor as such, rather than inventing
          // a leaf under it. Raw defaults stay absent, null and opaque verbatim.
          const readPath = (value: Record<string, unknown>, keys: string[], path: string[]): OutboxJson => {
            const [key, ...rest] = keys;
            return rest.length && object(value[key]) ? readPath(value[key], rest, [...path, key]) : read(value, key, path);
          };
          // recalcActionEnd/getClipTimelineDuration consult these selected fields.
          // Serializing copied rows/tracks is not a read of their entire contents.
          const timingReads = (item: Record<string, unknown>) => ['id', 'track', 'at', 'clipType', 'hold', 'from', 'to', 'speed', 'asset']
            .map((key) => read(item, key, [...clipPath, `id:${item.id}`]));
          reads = timingReads(clip);
          reads.push(readPath(config, ['output', 'fps'], ['config']));
          if (!object(config.output) || config.output.fps == null) {
            // withDefaultTimelineOutput falls back to the selected theme canvas.
            reads.push(read(config, 'theme', ['config']), readPath(config, ['theme_overrides', 'visual', 'canvas', 'fps'], ['config']));
          }
          const assetRead = (item: Record<string, unknown>) => {
            if (typeof item.asset !== 'string') return;
            if (!object(parent.registry)) refuse('gesture registry read has no authored registry', 'gesture-registry-unavailable');
            // Runtime/provider normalize parent/registry to config/registry and
            // resolve that path to the top-level raw registry when no mirror exists.
            if (Object.prototype.hasOwnProperty.call(config, 'registry')
              && (!object(config.registry) || !same(config.registry, parent.registry))) refuse('contradictory parent registry mirror', 'registry-mirror-mismatch');
            reads!.push(readPath(parent.registry, ['assets', item.asset], ['config', 'registry']));
          };
          assetRead(clip);
          if (gestureBasis.kind === 'split') {
            if (!Number.isFinite(gestureBasis.timeSeconds)) refuse('split time is unavailable', 'split-time-unavailable');
            // splitClipAtPlayhead uses order for insertion and every ID for allocation;
            // its pinned-group check reads this id-less list, not neighbor contents.
            const order = clips.map((item) => item.id as string);
            reads.push({ kind: 'collection', ref: 'parent', path: clipPath, members: [...order].sort(), order },
              read(config, 'pinnedShotGroups', ['config']));
          } else if (gestureBasis.kind === 'move') {
            if (clip.track !== gestureBasis.trackId) refuse('move is not on its original track', 'move-track-mismatch');
            const tracks = config.tracks;
            if (!Array.isArray(tracks)) refuse('move track read has no authored collection', 'move-tracks-unavailable');
            const track = tracks.filter((item) => object(item) && item.id === gestureBasis.trackId);
            if (track.length !== 1) refuse('move track has no unique authored binding', 'move-track-ambiguous');
            reads.push(read(track[0], 'kind', ['config', 'tracks', `id:${gestureBasis.trackId}`]),
              read(config, 'pinnedShotGroups', ['config']));
            // Both snap planners select siblings by track. Guard membership and
            // routing, then timing only for the siblings actually consulted.
            const order = clips.map((item) => item.id as string);
            reads.push({ kind: 'collection', ref: 'parent', path: clipPath, members: [...order].sort(), order });
            for (const item of clips) {
              if (!object(item)) refuse('move clip routing is unavailable', 'move-routing-unavailable');
              if (item.id === clip.id) continue;
              reads.push(read(item, 'track', [...clipPath, `id:${item.id}`]));
              if (item.track === gestureBasis.trackId) { reads.push(...timingReads(item)); assetRead(item); }
            }
          } else if (!Object.keys(gestureBasis.patch).length
            || Object.keys(gestureBasis.patch).some((key) => !['from', 'to', 'hold', 'speed'].includes(key))) {
            refuse('trim operands are unavailable', 'trim-operands-unavailable');
          }
        }
        // The encoder supplies guards and created IDs; these bytes are never a wire DTO.
        const pending = commands ? options.session.append({ before: toOutboxJson(before), after: toOutboxJson(after),
          label: mediaLabel, commands,
          ...(mediaReads && mediaSteps ? { reads: mediaReads, steps: mediaSteps,
            rationale: mediaSteps[0].intent, group_id: mediaSteps[0].id } : {}) }) : options.session.appendDocument({ before, after,
          roots: [{ ref: 'parent', revisionId: before.parent_revision.revision_id, contentDigest: before.parent_revision.content_digest }],
          ...(reads === undefined ? {} : { reads, merge: gestureBasis?.kind === 'element' ? 'atomic' as const : 'fields' as const }),
          label: 'Edit timeline', step: { id: crypto.randomUUID(), label: 'Edit timeline', intent: gestureBasis ? (gestureBasis.kind === 'split'
            ? `Split ${gestureBasis.clipId} at ${gestureBasis.timeSeconds}`
            : gestureBasis.kind === 'move' ? `Move ${gestureBasis.clipId} on ${gestureBasis.trackId}`
              : gestureBasis.kind === 'transition-clear' ? `Clear transitions: ${gestureBasis.clipIds.join(', ')}`
              : gestureBasis.kind === 'trim' ? `Trim ${gestureBasis.clipId}: ${canonicalJsonStringify(gestureBasis.patch)}`
                : gestureBasis.kind === 'element' ? gestureBasis.operation.name : 'Add media') : 'Save local editor changes', tags: [], ...(gestureBasis?.kind === 'element' || parentGesture ? { reads } : {}) } });
        source = { ...next,
          config: changes(source.config, source.config, next.config, ['config'], gestureBasis?.kind === 'element') as TimelineConfig,
          registry: changes(source.registry, source.registry, next.registry, ['registry']) as AssetRegistry,
          ...(next.bundle === undefined && source.bundle !== undefined ? { bundle: source.bundle } : {}),
        };
        if (gestureBasis?.kind === 'transition-clear') {
          for (const clip of source.config.clips) {
            if (gestureBasis.clipIds.includes(clip.id)) delete clip.transition;
          }
        }
        authoringSource = structuredClone(next);
        document = structuredClone(after);
        return pending;
      } catch (error) {
        const rejection = error instanceof TimelineVersionConflictError || error instanceof TimelineSaveError ? error
          : new TimelineSaveError(`Local document save retained: ${error instanceof Error ? error.message : String(error)}`);
        return Promise.reject(rejection);
      }
    },
    async flush() {
      try {
        const basis = await options.session.flush();
        const adopted = options.adopted(basis);
        const head = adopted.receipt.head;
        if (head.projectId !== initial.canonicalDocument.project_id || head.timelineId !== initial.canonicalDocument.timeline_id
          || head.headRevisionId !== basis.head.revisionId || head.headPublicationId !== basis.head.publicationId
          || !same(adopted.source.head, head)) refuse('canonical assembly did not adopt the accepted head');
        initial = structuredClone(basis);
        source = structuredClone(adopted.source);
        authoringSource = structuredClone(adopted.source);
        document = structuredClone(basis.canonicalDocument);
        sourceChecked = false;
        targets = historyTargets(basis.history, basis.head);
        if (options.loadHistory) {
          const latest = await options.loadHistory();
          targets = historyTargets(same(latest.head, basis.head) ? latest.history : undefined, basis.head);
        }
        return adopted.receipt;
      }
      catch (error) {
        const state = options.session.getState();
        const message = object(state.error) && typeof state.error.message === 'string' ? state.error.message
          : error instanceof Error ? error.message : String(error);
        if (state.status === 'conflict') throw new TimelineVersionConflictError(message);
        if (['blocked', 'error', 'recovery'].includes(state.status)) refuse(message);
        throw error;
      }
    },
    remoteHistoryAvailable,
    canUndo: () => remoteHistoryAvailable() && targets.undo.length > 0,
    canRedo: () => remoteHistoryAvailable() && targets.redo.length > 0,
    undo: () => appendInverse('undo'),
    redo: () => appendInverse('redo'),
  };
  return handoff;
}

function historyTargets(history: HistoryPage | undefined, head: TimelineCommandBasis['head']): { undo: string[]; redo: string[] } {
  if (!history?.items?.length || history.next_cursor !== null
    || history.head.revision_id !== head.revisionId || history.head.publication_id !== head.publicationId) return { undo: [], redo: [] };
  // Follow the authoritative ancestry so pagination/display ordering cannot
  // change the target. Unknown and partial-step entries are history barriers.
  const entries = new Map(history.items.map((entry) => [entry.publication_id, entry]));
  const ordered = [];
  const seen = new Set<string>();
  let publication: string | undefined = history.head.publication_id;
  while (publication) {
    if (seen.has(publication)) return { undo: [], redo: [] };
    seen.add(publication);
    const entry = entries.get(publication);
    if (!entry) return { undo: [], redo: [] };
    ordered.push(entry);
    publication = entry.previous?.publication_id;
  }
  const undo: string[] = [];
  const redo: string[] = [];
  for (const entry of ordered.reverse()) {
    if (entry.intent !== 'recorded' || !entry.records || entry.records.undo_steps != null) {
      undo.length = 0;
      redo.length = 0;
      continue;
    }
    const targets = entry.records.undo_of;
    if (!targets.length) {
      undo.push(entry.publication_id);
      redo.length = 0;
    } else if (targets.every((target) => undo.includes(target))) {
      for (const target of targets) undo.splice(undo.lastIndexOf(target), 1);
      redo.push(entry.publication_id);
    } else if (targets.every((target) => redo.includes(target))) {
      for (const target of targets) redo.splice(redo.lastIndexOf(target), 1);
      undo.push(entry.publication_id);
    } else {
      undo.length = 0;
      redo.length = 0;
    }
  }
  return { undo, redo };
}

import { createContext } from 'react';
import { normalizeClipPlacementWithFindings } from '@banodoco/timeline-composition';
import type { CanonicalDocument, CommitRequest, EditCommand, HistoryPage } from '@/integrations/runtime/timeline-commit-types.ts';
import { LocalSaveDeclined, type LocalSaveSession, type LocalSaveState, type RejectedSaveReceipt } from '../commands/localSaveSession.ts';
import { toOutboxJson, type OutboxJson } from '../commands/commitOutbox.ts';
import { canonicalJsonStringify, type TimelineBundleEnvelope } from '../data/typed/timelineBundle.ts';
import { authoringBundleFromDocument, type AuthoringBundle } from '../commands/authoringBundle.ts';
import { TimelineSaveError, TimelineVersionConflictError, type DataProvider, type TimelineCommandBasis, type TimelineHeadRevision, type TimelineSaveReceipt } from '../data/DataProvider.ts';
import type { AssetRegistry, TimelineConfig } from '../types/index.ts';
import { canonicalizeTimelinePair, projectTimelineTracksForDisplay } from '../lib/timeline-domain.ts';
import { findEnclosingPinnedGroup } from '../lib/pinned-group-projection.ts';
import { withDefaultTimelineOutput } from '../lib/defaults.ts';
import { materializeAuthoredOutput } from '../lib/timeline-data.ts';
import { markTimelineSaveRejection, type TimelineSaveRejectionCode } from '../lib/timeline-diagnostics.ts';
import { recordTimelineSaveMark } from '../lib/timeline-save-marks.ts';
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
} & ({ kind: 'track-label'; trackId: string; label: string } | ({ clipId: string } & ({ kind: 'split'; timeSeconds: number } | { kind: 'move'; trackId: string } | {
  kind: 'trim'; patch: Partial<Pick<TimelineConfig['clips'][number], 'from' | 'to' | 'hold' | 'speed'>>;
} | { kind: 'transition-clear'; clipIds: string[] } | { kind: 'prepared-media'; command: PlacePreparedMediaCommand } | { kind: 'element'; operation: TimelineElementOperation; context: AstridAgentElementContext })));

/** Assembly supplies the ORIGINAL verified read, not loadTimelineCommandBasis at save time. */
export interface TimelineLocalSaveHandoff {
  capture(source: TimelineSaveSource, gestureBasis?: TimelineGestureReadBasis): Promise<void>;
  /** Optional in-memory correlation for save latency diagnostics only. */
  flush(traceId?: string): Promise<TimelineSaveReceipt>;
  /** The durable local save session's state, when the owner has one. */
  status?(): string | undefined;
  ownerId?(): string | undefined;
  writeRecoveryDraft?: LocalSaveSession['writeRecoveryDraft'];
  subscribeState?(listener: (state: LocalSaveState) => void): () => void;
  exportRejectedChange?(): ReturnType<LocalSaveSession['exportRejectedChange']>;
  /**
   * Leave a refused save. `latest` drops the rejected change and its dependants; `keep` resends them on the
   * latest head. Resolves once the owner is saved and the next edit can save; throws if it is not.
   */
  discharge?(mode: 'latest' | 'keep', exported?: RejectedSaveReceipt, stillCurrent?: () => boolean): Promise<TimelineSaveReceipt | void>;
  /** True only when the durable owner is settled and has an accepted target. */
  remoteHistoryAvailable(): boolean;
  canRequestHistory?(displayHead?: TimelineHeadRevision): boolean;
  refreshHistory?(): Promise<void>;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

/** Scoped editors supply their own verified physical-image join and durable owner. */
export type TimelinePersistenceHandoff = Pick<TimelineLocalSaveHandoff, 'capture' | 'flush' | 'status' | 'ownerId'
  | 'writeRecoveryDraft' | 'subscribeState' | 'exportRejectedChange' | 'discharge'>;
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
const rowId = (row: unknown) => object(row) ? String(row.id ?? '') : '';
const byRowId = (rows: unknown[]) => [...rows].sort((a, b) => rowId(a) < rowId(b) ? -1 : rowId(a) > rowId(b) ? 1 : 0);
const sameRowsById = (a: unknown[], b: unknown[]) => a.length === b.length && same(byRowId(a), byRowId(b));
const field = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
const changedField = (previous: Record<string, unknown>, next: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(next, key) && !same(field(previous, key), field(next, key));

// The editor writes clips grouped by track, so row order is serialisation, not meaning. A gesture
// is checked by the rows it names (by id), never by where the editor happened to put them.
const configById = (config: TimelineConfig): unknown => ({ ...config,
  ...(Array.isArray(config.clips) ? { clips: byRowId(config.clips) } : {}),
  ...(Array.isArray(config.tracks) ? { tracks: byRowId(config.tracks) } : {}) });
const sameConfig = (a: TimelineConfig, b: TimelineConfig) => same(authoredJson(configById(a)), authoredJson(configById(b)));

/**
 * Why an edit that names no gesture cannot be saved on a document with shots, or undefined when it can.
 * The write only touches the parent's config and registry (the shot closure is cloned untouched), so the
 * edit must stay on rows the parent alone owns: clips outside pinned shot groups on tracks that hold no shots,
 * additive registry changes, and no change to the rest of the config. Anything else stays refused.
 */
function unnamedEditRefusal(document: CanonicalDocument, before: TimelineSaveSource, next: TimelineSaveSource): string | undefined {
  const parent = document.parent_revision.payload;
  const config = parent.config;
  if (!object(config) || !Array.isArray(config.clips) || !Array.isArray(config.tracks)
    || !Array.isArray(before.config.clips) || !Array.isArray(next.config.clips)
    || !Array.isArray(before.config.tracks) || !Array.isArray(next.config.tracks)) {
    return "This edit can't be saved yet because this timeline's clips are stored in a form we can't match to the editor. Reload the timeline and try again.";
  }
  // Everything outside the clip and track lists (pinned groups, output, theme, bundle) is left as it was.
  const rest = (value: TimelineConfig) => { const { clips: _clips, tracks: _tracks, ...others } = value; return authoredJson(others); };
  if (!same(rest(before.config), rest(next.config)) || !same(authoredJson(before.bundle ?? null), authoredJson(next.bundle ?? null))) {
    return "This change to the timeline's settings can't be saved yet because the timeline has shots.";
  }
  // What the shots depend on in the parent, by membership in the document's own shot data. Occupied tracks hold
  // the shots themselves (occurrences, pinned groups): clips may not change on or onto them. Shared lanes are
  // parent tracks a shot's child content plays on: the lane itself (removal, a clashing new id) is what the
  // shot relies on, but its settings and the parent clips layered over it are the user's to change.
  const occurrences = Array.isArray(parent.occurrences) ? parent.occurrences.filter(object) : [];
  const occupiedTracks = new Set<string>();
  const sharedLanes = new Set<string>();
  for (const occurrence of occurrences) {
    for (const track of [occurrence.track, object(occurrence.placement) ? occurrence.placement.track : undefined]) {
      if (typeof track === 'string') occupiedTracks.add(track);
    }
  }
  for (const group of before.config.pinnedShotGroups ?? []) occupiedTracks.add(group.trackId);
  const internals = new Map(document.internal_timeline_revisions.map(item => [item.revision_id, item.payload]));
  const shotsByRevision = new Map(document.shot_revisions.map(item => [`${item.shot_id}/${item.revision_id}`, item.internal_timeline_revision_id]));
  const shotAssets = new Set<string>();
  const shotClipIds = new Set<string>();
  const childTimelines = (items: unknown): Record<string, unknown>[] => (Array.isArray(items) ? items.filter(object) : []);
  for (const payload of internals.values()) {
    if (!object(payload)) continue;
    for (const track of childTimelines(payload.tracks)) {
      if (track.kind === 'audio' && typeof track.id === 'string') sharedLanes.add(track.id);
    }
    for (const clip of childTimelines(payload.clips)) {
      if (typeof clip.track === 'string') sharedLanes.add(clip.track);
      if (typeof clip.asset === 'string') shotAssets.add(clip.asset);
    }
  }
  for (const occurrence of occurrences) {
    const internal = internals.get(shotsByRevision.get(`${String(occurrence.shot_id)}/${String(occurrence.shot_revision_id)}`) as string);
    for (const clip of object(internal) ? childTimelines(internal.clips) : []) {
      if (typeof clip.id === 'string') shotClipIds.add(`${String(occurrence.occurrence_id)}:${clip.id}`);
    }
  }
  const beforeTracks = new Map(before.config.tracks.map(track => [track.id, track]));
  const nextTracks = new Map(next.config.tracks.map(track => [track.id, track]));
  const beforeClips = new Map(before.config.clips.map(clip => [clip.id, clip]));
  const nextClips = new Map(next.config.clips.map(clip => [clip.id, clip]));
  for (const id of new Set([...beforeClips.keys(), ...nextClips.keys()])) {
    const was = beforeClips.get(id);
    const now = nextClips.get(id);
    if (was && now && same(authoredJson(was), authoredJson(now))) continue;
    if (findEnclosingPinnedGroup(before.config, id)) {
      return "Can't change a clip that belongs to a pinned shot group yet. Edit a clip outside the group.";
    }
    // A shot placeholder, or a copy of one of a shot's own clips, is not the parent's to edit.
    const canonical = !was && now?.app && typeof now.app === 'object' ? (now.app as Record<string, unknown>).canonical : undefined;
    if ([was, now].some(clip => clip?.clipType === 'shot') || (!was && (shotClipIds.has(id) || canonical !== undefined))) {
      return "Can't change a shot's own clips from here yet. Edit a clip you added to the timeline.";
    }
    if ([was, now].some(clip => clip && occupiedTracks.has(clip.track))) {
      return "Can't change a clip on, or move one onto, a track that holds shots yet. Use another track.";
    }
    if (now && !nextTracks.has(now.track)) {
      return "Can't place a clip on a track that doesn't exist. Put it on one of the timeline's tracks.";
    }
  }
  // Tracks: a new track may appear and a track without shots or clips may go; kept tracks keep their kind and order.
  for (const [id, track] of beforeTracks) {
    const kept = nextTracks.get(id);
    if (!kept) {
      if (occupiedTracks.has(id)) return "Can't remove a track that holds shots yet.";
      if (sharedLanes.has(id)) return "Can't remove a track that a shot plays on yet.";
      if (next.config.clips.some(clip => clip.track === id)) return "Can't remove a track that still has clips on it. Move or delete its clips first.";
    } else if (kept.kind !== track.kind) {
      // Settings (label, mute, volume) are the user's to change on any track, a shot's included; what a track is stays.
      return "Can't change what kind of track this is on a timeline with shots yet.";
    }
  }
  for (const id of nextTracks.keys()) {
    if (!beforeTracks.has(id) && (occupiedTracks.has(id) || sharedLanes.has(id))) return "Can't add that track because a shot already uses its name. Add a different track.";
  }
  if (!same(before.config.tracks.filter(track => nextTracks.has(track.id)).map(track => track.id),
    next.config.tracks.filter(track => beforeTracks.has(track.id)).map(track => track.id))) {
    return "Can't reorder tracks on a timeline with shots yet.";
  }
  // Registry: new assets may appear (unless a shot clip already uses that key); what is there stays as it was.
  const assets = (registry: AssetRegistry) => (registry.assets ?? {}) as Record<string, unknown>;
  const { assets: _a, ...otherBefore } = before.registry; const { assets: _b, ...otherNext } = next.registry;
  if (!same(authoredJson(otherBefore), authoredJson(otherNext))
    || Object.entries(assets(before.registry)).some(([key, entry]) => !Object.prototype.hasOwnProperty.call(assets(next.registry), key)
      || !same(authoredJson(entry), authoredJson(assets(next.registry)[key])))) {
    return "Can't remove or change project media on a timeline with shots yet.";
  }
  if (Object.keys(assets(next.registry)).some(key => !Object.prototype.hasOwnProperty.call(assets(before.registry), key) && shotAssets.has(key))) {
    return "Can't add media under a name a shot already uses. Import the media again.";
  }
  return undefined;
}

/** The editor's rows in the stored order: stored rows first, then each new row after its editor predecessor. */
function inStoredOrder(stored: unknown[], edited: unknown[], appendNew = false): unknown[] {
  const editedById = new Map(edited.map(row => [rowId(row), row]));
  if (stored.some(row => !editedById.has(rowId(row)))) return edited;
  const storedIds = new Set(stored.map(rowId));
  const result = stored.map(row => editedById.get(rowId(row)));
  if (appendNew) return [...result, ...edited.filter(row => !storedIds.has(rowId(row)))];
  edited.forEach((row, index) => {
    if (storedIds.has(rowId(row))) return;
    const before = edited.slice(0, index).reverse().find(item => storedIds.has(rowId(item)));
    result.splice(before ? result.findIndex(item => rowId(item) === rowId(before)) + 1 : 0, 0, row);
  });
  return result;
}

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

// Refusals of one edit by this handoff's authoring guards, before that edit
// entered the outbox. Owner, conflict and transport failures are not listed.
const authoringRefusals = new WeakSet<object>();
/** True when the handoff refused exactly one edit before it reached the outbox. */
export function isTimelineAuthoringRefusal(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && authoringRefusals.has(error));
}

function refuse(message: string, reason?: TimelineSaveRejectionCode, edit = false): never {
  const error = new TimelineSaveError(`Local document save retained: ${message}`);
  if (edit) authoringRefusals.add(error);
  throw reason ? markTimelineSaveRejection(error, reason, 'TimelineSaveError') : error;
}
/** Refuses this one edit because of what the edit does (not the session or document); the caller may undo it. */
function refuseEdit(message: string, reason?: TimelineSaveRejectionCode): never {
  return refuse(message, reason, true);
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
  // Same output rule as buildTimelineData (the editor's source view); other defaults as before.
  const loaded = { ...config, ...withDefaultTimelineOutput(config as unknown as TimelineConfig),
    output: materializeAuthoredOutput(config as unknown as TimelineConfig).output } as unknown as TimelineConfig;
  const projected = canonicalizeTimelinePair(loaded, structuredClone(parent.registry) as unknown as AssetRegistry);
  // Runtime also loads an explicitly authored top-level parent clip list when
  // config has no clip list. This is a physical parent binding, never children.
  const parentClips = !Object.prototype.hasOwnProperty.call(parent.config, 'clips') && Array.isArray(parent.clips)
    ? canonicalizeTimelinePair({ ...loaded, clips: structuredClone(parent.clips) } as TimelineConfig,
      structuredClone(parent.registry) as unknown as AssetRegistry) : undefined;
  // Derive the provider-defaulted view from the verified parent only when
  // the ordinary views did not match. Preserve physical top-level clips.
  const matchesProviderView = () => {
    const candidates = [config as unknown as TimelineConfig];
    if (!Object.prototype.hasOwnProperty.call(parent.config, 'clips') && Array.isArray(parent.clips)) {
      candidates.push({ ...config, clips: structuredClone(parent.clips) } as TimelineConfig);
    }
    return candidates.some(candidate => {
      const defaulted = { ...candidate, ...withDefaultTimelineOutput(candidate) } as TimelineConfig;
      const view = canonicalizeTimelinePair(defaulted, structuredClone(parent.registry) as unknown as AssetRegistry);
      return same(authoredJson(source.config), authoredJson(projectTimelineTracksForDisplay(view.config)));
    });
  };
  // Accept the original raw view or main's actual load/build view. No arbitrary
  // display snapshot can establish an authored entity binding.
  if ((!same(authoredJson(source.config), authoredJson(loaded))
    && !same(authoredJson(source.config), authoredJson(projected.config))
    && !same(authoredJson(source.config), authoredJson(projectTimelineTracksForDisplay(projected.config)))
    && !(parentClips && same(authoredJson(source.config), authoredJson(projectTimelineTracksForDisplay(parentClips.config))))
    && !matchesProviderView())
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
  let targets = historyTargets(options.initial.history, options.initial.head, options.session.actorId);
  let historyLoaded = completeHistory(options.initial.history, options.initial.head);
  let historyEpoch = 0;
  const legacyHistory = options.initial.history !== undefined;
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
    return historyLoaded && !inversePending && options.session.getState().status === 'saved';
  }
  function canRequestHistory(displayHead?: TimelineHeadRevision): boolean {
    return !historyLoaded && Boolean(options.loadHistory) && !inversePending && options.session.getState().status === 'saved'
      && same(options.session.getBasis().head, initial.head) && same(options.session.getDocument(), document)
      && (!displayHead || (displayHead.projectId === initial.canonicalDocument.project_id
        && displayHead.timelineId === initial.canonicalDocument.timeline_id && displayHead.headRevisionId === initial.head.revisionId
        && displayHead.headPublicationId === initial.head.publicationId));
  }
  async function refreshHistory(): Promise<void> {
    if (!options.loadHistory || options.session.getState().status !== 'saved') return;
    const epoch = historyEpoch;
    const basis = options.session.getBasis();
    const snapshot = structuredClone(options.session.getDocument());
    const latest = await options.loadHistory();
    if (historyEpoch !== epoch || options.session.getState().status !== 'saved' || !same(options.session.getBasis().head, basis.head)
      || !same(options.session.getDocument(), snapshot) || !same(latest.head, basis.head)) return;
    historyLoaded = completeHistory(latest.history, basis.head);
    targets = historyTargets(latest.history, basis.head, options.session.actorId);
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
      if (!object(raw)) refuseEdit('This change touches a part of the timeline that cannot be saved from here. Make the change another way.', 'display-container-unbound');
      const result = structuredClone(raw);
      // The app extension is projected verbatim. Trim removes these authored
      // leaves from an explicitly supplied namespace; other omissions stay partial.
      if (path.length === 5 && path[0] === 'config' && path[1] === 'clips'
        && path[3] === 'app' && path[4] === 'astrid') {
        for (const key of ['for', 'until']) {
          if (!Object.prototype.hasOwnProperty.call(previous, key) || Object.prototype.hasOwnProperty.call(next, key)) continue;
          if (!same(field(raw, key), field(previous, key))) refuseEdit('This trim does not match what is stored for the clip. Try trimming it again.', 'trim-binding-mismatch');
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
        if (!changedField(previous, next, key)) continue;
        if (value === undefined) {
          if ((!(element && ['elementRef', 'entrance'].includes(key)) && key !== 'transition') || path.length !== 3 || path[0] !== 'config' || path[1] !== 'clips') {
            refuseEdit('Clearing this value cannot be saved yet. Set a new value instead.', 'explicit-clear-unavailable');
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
      refuseEdit('This value comes from a part of the timeline that cannot be saved from here. Edit it where it is defined.', 'display-value-unbound');
    }
    return authoredJson(next);
  }
  // Recompute only package-owned placement leaves from the verified physical parent.
  // Applying them before the user delta preserves inherited fit across reloads.
  function placementBaseline(raw: unknown, displayed: TimelineConfig): unknown {
    if (!object(raw) || !Array.isArray(raw.clips) || !Array.isArray(raw.tracks))
      refuse('placement migration has no authored clips and tracks');
    const resolution = displayed.output?.resolution?.match(/^(\d+)x(\d+)$/i);
    const fps = displayed.output?.fps;
    const legacyCanvas = resolution && typeof fps === 'number' && Number.isFinite(fps) && fps > 0
      ? { width: Number(resolution[1]), height: Number(resolution[2]), fps, source: 'app-resolved' as const } : undefined;
    const result = normalizeClipPlacementWithFindings(structuredClone(raw) as Parameters<typeof normalizeClipPlacementWithFindings>[0],
      legacyCanvas ? { legacyCanvas } : undefined);
    if (result.findings.some(finding => finding.kind === 'scale-bake')
      && result.findings.some(finding => finding.kind === 'canvas' && finding.source === 'app-resolved')) {
      refuse('legacy scale migration needs an authored timeline canvas before this appearance edit');
    }
    const baseline = structuredClone(raw);
    const clips = baseline.clips as Record<string, unknown>[];
    const tracks = baseline.tracks as Record<string, unknown>[];
    const normalized = result.config;
    const unique = (rows: Record<string, unknown>[], id: string | undefined) => {
      const matching = rows.filter(row => object(row) && row.id === id);
      if (!id || matching.length !== 1) refuse('placement migration has no unique authored binding');
      return matching[0];
    };
    for (const finding of result.findings) {
      if (finding.kind === 'canvas' || finding.kind === 'canvas-not-required') continue;
      if (finding.kind === 'markers') {
        const row = unique(tracks, finding.trackId);
        const expected = normalized.tracks?.find(track => track.id === finding.trackId);
        const view = displayed.tracks?.find(track => track.id === finding.trackId);
        if (!expected || !view || !object(expected.app) || !object(view.app)) refuse('placement migration track is unavailable');
        const app = object(row.app) ? structuredClone(row.app) : {};
        for (const key of ['scaleAppliesToPositionedClips', 'clipPlacementVersion'] as const) {
          if (!same(expected.app[key], view.app[key])) refuse('placement migration differs from verified display');
          app[key] = expected.app[key];
        }
        row.app = app;
      } else if (finding.kind === 'scale-bake' || finding.kind === 'explicit-fit') {
        const row = unique(clips, finding.clipId);
        const expected = normalized.clips.find(clip => clip.id === finding.clipId && clip.track === finding.trackId);
        const view = displayed.clips.find(clip => clip.id === finding.clipId && clip.track === finding.trackId);
        if (!expected || !view || row.track !== finding.trackId) refuse('placement migration clip is unavailable');
        const keys = finding.kind === 'scale-bake' ? ['x', 'y', 'width', 'height'] as const : ['fit'] as const;
        for (const key of keys) {
          if (!same(expected[key], view[key])) refuse('placement migration differs from verified display');
          row[key] = expected[key];
        }
      } else {
        refuse('unsupported placement migration finding');
      }
    }
    return baseline;
  }
  const handoff: TimelineLocalSaveHandoff = {
    capture(input, gestureBasis) {
      historyEpoch++;
      historyLoaded = false;
      try {
        const next = structuredClone(input);
        checkHead(initial, source, 'capture-source-head-unavailable');
        checkHead(initial, next, 'capture-input-head-unavailable');
        const before = options.session.getDocument() as unknown as CanonicalDocument;
        const parent = before.parent_revision.payload;
        const hasChildren = before.shot_revisions.length || before.internal_timeline_revisions.length
          || (Array.isArray(parent.occurrences) && parent.occurrences.length);
        const parentGesture = gestureBasis?.kind === 'move' || gestureBasis?.kind === 'transition-clear';
        const trackLabelGesture = gestureBasis?.kind === 'track-label';
        // Trim and split edit one parent clip row; like move they prove that by an expected diff below.
        const clipGesture = gestureBasis?.kind === 'trim' || gestureBasis?.kind === 'split';
        if (!sourceChecked) { checkSource(initial, source); sourceChecked = true; }
        if (!same(before, document)) refuse('local authored document changed outside this handoff', 'local-document-changed');
        authoredJson(next); // Reject non-finite editor values before mutating the chain.
        // A gesture proves its own effect below; an edit that names none must stay on rows the parent alone owns.
        const unnamedRefusal = hasChildren && gestureBasis === undefined
          ? unnamedEditRefusal(before, authoringSource, next) : undefined;
        if (unnamedRefusal) refuseEdit(unnamedRefusal, 'child-ownership-unavailable');
        const after = structuredClone(before);
        const payload = after.parent_revision.payload;
        // A document that stores its clips only at the top level is edited there, whichever gesture it is.
        // An edit that names no gesture on such a document stays refused (its two clip lists may contradict),
        // except a placement-appearance edit, which is verified against the recomputed baseline below.
        const appearanceChanged = !gestureBasis && (next.config.clips.some(clip => {
          const previous = source.config.clips.find(item => item.id === clip.id);
          return previous && ['x', 'y', 'width', 'height', 'fit', 'cropTop', 'cropRight', 'cropBottom', 'cropLeft'].some(
            key => changedField(previous, clip, key));
        }) || (next.config.tracks ?? []).some(track => {
          const previous = source.config.tracks?.find(item => item.id === track.id);
          return previous && ['scale', 'fit'].some(key => changedField(previous, track, key));
        }));
        const topLevelClips = (gestureBasis !== undefined || appearanceChanged) && object(parent.config)
          && !Object.prototype.hasOwnProperty.call(parent.config, 'clips') && Array.isArray(parent.clips);
        const configBefore = topLevelClips ? { ...parent.config as Record<string, OutboxJson>, clips: parent.clips } : parent.config;
        const configSource = topLevelClips && !source.config.clips.length
          ? { ...source.config, clips: parent.clips } : source.config;
        // Whatever the gesture, a mounted source without the parent's clips would write them away.
        if (topLevelClips && !source.config.clips.length
          && Array.isArray(parent.clips) && parent.clips.length) refuse('parent clips are not present in the mounted source');
        const baseline = appearanceChanged ? placementBaseline(configBefore, configSource as TimelineConfig) : configBefore;
        payload.config = changes(baseline, configSource, next.config, ['config'], gestureBasis?.kind === 'element') as Record<string, OutboxJson>;
        // A gesture never reorders rows: write them in the stored order. A dropped clip goes last (the
        // Runtime appends it); a new track keeps the position the editor gave it.
        const editorTracks = (payload.config as Record<string, OutboxJson>).tracks;
        if (gestureBasis) {
          const written = payload.config as Record<string, OutboxJson>;
          const stored = configBefore as Record<string, OutboxJson>;
          for (const key of ['clips', 'tracks'] as const) {
            if (Array.isArray(written[key]) && Array.isArray(stored[key])) {
              written[key] = inStoredOrder(stored[key] as unknown[], written[key] as unknown[],
                gestureBasis.kind === 'prepared-media' && key === 'clips') as OutboxJson;
            }
          }
        }
        if (gestureBasis?.kind === 'prepared-media') {
          const asset = gestureBasis.command.payload.asset;
          if (!object(parent.registry) || (parent.registry.assets !== undefined && !object(parent.registry.assets))
            || !same(authoredJson(next.registry), authoredJson({ ...source.registry,
              assets: { ...source.registry.assets, [asset.assetKey]: asset.entry } }))) {
            refuseEdit('This media change would alter more than the asset you picked. Try adding it again.');
          }
          // Bootstrap registry is {}, while the editor displays { assets: {} }.
          payload.registry = { ...parent.registry, assets: { ...(parent.registry.assets ?? {}),
            [asset.assetKey]: authoredJson(asset.entry) } };
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
          if (!['split', 'trim', 'move', 'transition-clear', 'prepared-media', 'element', 'track-label'].includes(gestureBasis.kind)
            || !sameConfig(gestureConfig, authoringSource.config)
            || !same(authoredJson(gestureBasis.registry), authoredJson(authoringSource.registry))) {
            refuseEdit('The timeline changed while you were editing. Try the change again.', 'gesture-basis-mismatch');
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
              if (!Number.isFinite(selected[0].at) || selected[0].at < 0) refuseEdit('The clip has no usable start time. Set its start time and try again.');
              clip.at = selected[0].at;
            } else {
              if (selected[0].transition !== undefined) refuseEdit('Clearing this transition cannot be saved yet. Set a new transition instead.');
              delete clip.transition;
            }
          }
          if (!sameConfig(expected.config, next.config)
            || !same(authoredJson(expected.registry), authoredJson(next.registry))
            || !same(expected.bundle, next.bundle)) refuseEdit('This edit would change more than the clip you selected. Try it again.');
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
        if (gestureBasis?.kind === 'track-label') {
          const matches = authoringSource.config.tracks.filter(track => track.id === gestureBasis.trackId);
          if (matches.length !== 1 || typeof gestureBasis.label !== 'string') refuse('track label binds no unique authored track', 'track-label-ambiguous');
          const expected = structuredClone(authoringSource);
          expected.config.tracks.find(track => track.id === gestureBasis.trackId)!.label = gestureBasis.label;
          if (!sameConfig(expected.config, next.config)
            || !same(authoredJson(expected.registry), authoredJson(next.registry))
            || !same(expected.bundle, next.bundle)) refuseEdit('Renaming this track would change more than its name. Try it again.');
        }
        if (clipGesture) {
          // Expected = the original document plus the selected clip as the editor edited it (and, for a split,
          // the one clip it created beside it). Nothing else may differ, whatever order the editor wrote rows in.
          const id = gestureBasis.clipId;
          const known = new Set(authoringSource.config.clips.map(clip => clip.id));
          const origin = authoringSource.config.clips.filter(clip => clip.id === id);
          const edited = next.config.clips.filter(clip => clip.id === id);
          const created = next.config.clips.filter(clip => !known.has(clip.id));
          if (origin.length !== 1 || edited.length !== 1) refuse('gesture selected clip has no unique authored binding', 'gesture-clip-ambiguous');
          // A clip that belongs to a pinned shot group is owned by the shots it pins; which of them a trim or
          // split reaches is not mapped, so that case is refused. Every other clip row is the parent's alone.
          if (hasChildren && findEnclosingPinnedGroup(authoringSource.config, id)) {
            refuseEdit("Can't trim or split a clip that belongs to a pinned shot group yet.", 'child-ownership-unavailable');
          }
          if (created.length !== (gestureBasis.kind === 'split' ? 1 : 0)
            || edited[0].track !== origin[0].track || edited[0].asset !== origin[0].asset
            || created.some(clip => clip.track !== origin[0].track || clip.asset !== origin[0].asset)) {
            refuseEdit(`This ${gestureBasis.kind} would change more than the clip you selected. Try it again.`);
          }
          // The selected clip may change only timing: a trim its patch keys, `at` (start edge) and the end the editor
          // re-derives from the new length (`to`/`hold`, see rowsToConfig); a split the timing keys on both halves
          // (the created half also has its own id). Nothing else on the clip (volume, text, params...) may differ.
          const timingKeys = ['at', 'from', 'to', 'hold', 'speed'];
          const allowed = new Set(gestureBasis.kind === 'trim' ? ['at', 'to', 'hold', ...Object.keys(gestureBasis.patch)] : timingKeys);
          const changedKeys = (clip: object) => [...new Set([...Object.keys(clip), ...Object.keys(origin[0])])]
            .filter(key => !same((clip as Record<string, unknown>)[key], (origin[0] as Record<string, unknown>)[key]));
          if (changedKeys(edited[0]).some(key => !allowed.has(key))
            || created.some(clip => changedKeys(clip).some(key => key !== 'id' && !allowed.has(key)))) {
            refuseEdit(`This ${gestureBasis.kind} would change more than the clip you selected. Try it again.`);
          }
          const expected = structuredClone(authoringSource);
          // A single-clip trim changes only its own clip: `resolveOverlaps` (lib/resolve-overlaps.ts), which the
          // drag-trim path runs, treats siblings as fixed and shortens the trimmed clip itself.
          expected.config.clips = [...expected.config.clips.map(clip => clip.id === id ? edited[0] : clip), ...created];
          if (!sameConfig(expected.config, next.config)
            || !same(authoredJson(expected.registry), authoredJson(next.registry))
            || !same(expected.bundle, next.bundle)) refuseEdit(`This ${gestureBasis.kind} would change more than the clip you selected. Try it again.`);
        }
        if (gestureBasis?.kind === 'element') {
          if (!same(next.registry, authoringSource.registry) || !same(next.bundle, authoringSource.bundle)
            || !sameConfig(next.config, applyTimelineOperation(gestureBasis.context,
              gestureBasis.config, gestureBasis.operation))) refuseEdit('The effect settings changed while you were editing. Try the change again.');
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
          if (gestureBasis.command.type !== 'place-prepared-media') refuseEdit('This media cannot be placed. Use Add media instead.');
          const prepared = gestureBasis.command.payload;
          const media = prepared.asset.mediaSelection;
          const keys = ['asset', 'generation_id', 'variant_id', 'object_id', 'catalog_digest'];
          if (!media || Object.keys(media).length !== keys.length
            || keys.some(key => typeof media[key as keyof typeof media] !== 'string' || !media[key as keyof typeof media])) {
            refuseEdit("This media was not picked from the project's media, so it cannot be placed. Import the media again.");
          }
          const duplicateVideo = Boolean(prepared.afterClipId && prepared.asset.mediaType === 'video');
          // File drops may remove only their transient uploading action. The
          // command caller separately proves that the action exists locally;
          // this handoff still refuses authored IDs and non-drop removals.
          if ((prepared.removeClipId !== undefined
            && (duplicateVideo || !prepared.removeClipId.startsWith('uploading-')))
            || (!duplicateVideo && prepared.afterClipId) || prepared.replaceClipId || prepared.removeClipIds?.length
            || prepared.pinnedShotGroupsOverride
            || (!duplicateVideo && prepared.asset.mediaType !== 'image')) {
            refuseEdit('Only an image can be added to a visual track this way. Use Add media instead.');
          }
          const config = configBefore as Record<string, OutboxJson>;
          const nextConfig = payload.config as Record<string, OutboxJson>;
          const clips = config.clips;
          const nextClips = nextConfig.clips;
          if (!Array.isArray(clips) || !Array.isArray(nextClips)) refuse('prepared media clip collection is unavailable');
          if (prepared.removeClipId !== undefined && clips.some(clip => object(clip) && clip.id === prepared.removeClipId)) {
            refuseEdit('Adding media cannot remove a clip you already placed. Use Add media instead.');
          }
          // The editor serializes clips grouped by track, so the new clip is not necessarily last.
          // Find it by its command id; the Runtime appends it, and the retained rows keep stored order.
          const row = nextClips.find(clip => object(clip) && clip.id === gestureBasis.clipId);
          const retainedRows = duplicateVideo ? nextClips : nextClips.filter(clip => clip !== row);
          const tracks = config.tracks;
          const nextTracks = nextConfig.tracks;
          const newTrack = object(row) && Array.isArray(tracks) && Array.isArray(nextTracks)
            && !tracks.some(track => object(track) && track.id === row.track)
            ? nextTracks.find(track => object(track) && track.id === row.track) : undefined;
          const visualTrack = object(row) && Array.isArray(nextTracks)
            && nextTracks.filter(track => object(track) && track.id === row.track);
          if (!object(row) || row.id !== gestureBasis.clipId || row.asset !== prepared.asset.assetKey
            || clips.some(clip => object(clip) && clip.id === row.id)
            || (!duplicateVideo && !sameRowsById(retainedRows, clips))
            || !Array.isArray(tracks) || !Array.isArray(nextTracks)
            || (!same(authoredJson(gestureBasis.config.tracks), authoredJson(authoringSource.config.tracks))
              && (!newTrack || !same(authoredJson(gestureBasis.config.tracks), authoredJson(next.config.tracks))))
            || !same({ ...nextConfig, clips, tracks }, config)
            || (newTrack ? duplicateVideo || !sameRowsById(nextTracks.filter(track => track !== newTrack), tracks)
              : !sameRowsById(nextTracks, tracks))
            || !visualTrack || visualTrack.length !== 1 || !object(visualTrack[0])
            || visualTrack[0].kind !== 'visual' || (visualTrack[0].role ?? 'output') !== 'output') {
            refuseEdit('Adding media would change more than one clip. Choose an existing visual track and try again.');
          }
          if (Array.isArray(parent.occurrences) && parent.occurrences.some(occurrence => object(occurrence)
            && (occurrence.track === row.track || (object(occurrence.placement) && occurrence.placement.track === row.track)))) {
            refuseEdit("Can't drop onto a track that holds shots yet. Drop it on another visual track.", 'child-ownership-unavailable');
          }
          if (newTrack && Array.isArray(editorTracks)) {
            // The new track keeps the position the editor gave it; the old tracks were just proven unchanged.
            nextConfig.tracks = editorTracks;
            if (Object.prototype.hasOwnProperty.call(parent, 'tracks')) payload.tracks = editorTracks;
          }
          if (!object(parent.registry) || (parent.registry.assets !== undefined && !object(parent.registry.assets))
            || !same(payload.registry, { ...parent.registry, assets: { ...(parent.registry.assets ?? {}),
              [prepared.asset.assetKey]: authoredJson(prepared.asset.entry) } })) {
            refuseEdit('This media change would alter more than the asset you picked. Try adding it again.');
          }
          if (duplicateVideo) {
            mediaLabel = 'Add video after clip';
            const old = prepared.oldMediaSelection;
            const anchorIndex = clips.findIndex(clip => object(clip) && clip.id === prepared.afterClipId);
            const anchor = clips[anchorIndex];
            if (!old || Object.keys(old).length !== keys.length
              || keys.some(key => typeof old[key as keyof typeof old] !== 'string' || !old[key as keyof typeof old])
              || !object(anchor) || anchor.asset !== old.asset || row.asset !== media.asset) {
              refuseEdit('Duplicating this video needs both of its project media picks, and one is missing. Import the media again.');
            }
            // Bound the consumer to the upstream parent duplicate preview, by id: the stored rows in stored
            // order with the new row right after its anchor. Clips after the anchor on its track may ripple
            // their `at`; every other row is unchanged. Timing and metadata normalization stay the provider's.
            const editedById = new Map(nextClips.map(clip => [object(clip) ? clip.id : null, clip]));
            const placed = [...clips.slice(0, anchorIndex + 1), row, ...clips.slice(anchorIndex + 1)];
            if (nextClips.length !== clips.length + 1 || editedById.size !== nextClips.length
              || row.track !== anchor.track || clips.some((clip, index) => {
                const nextClip = object(clip) ? editedById.get(clip.id) : undefined;
                if (!object(clip) || !object(nextClip)) return true;
                return index <= anchorIndex || clip.track !== anchor.track ? !same(clip, nextClip)
                  : !same({ ...nextClip, at: clip.at }, clip);
              })) refuseEdit('Duplicating this video would change more than the copy itself. Try duplicating it again.');
            nextConfig.clips = placed.map(clip => object(clip) && clip.id !== row.id ? editedById.get(clip.id) as OutboxJson : clip as OutboxJson);
            if (Object.prototype.hasOwnProperty.call(parent, 'clips')) payload.clips = nextConfig.clips;
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
          if (newTrack && (editorTracks as unknown[]).at(-1) !== newTrack) {
            const appended = structuredClone(before);
            const appendedPayload = appended.parent_revision.payload;
            (appendedPayload.config as Record<string, OutboxJson>).tracks = [...tracks, newTrack];
            if (Object.prototype.hasOwnProperty.call(parent, 'tracks')) appendedPayload.tracks = [...tracks, newTrack];
            const reordered = structuredClone(appended);
            (reordered.parent_revision.payload.config as Record<string, OutboxJson>).tracks = editorTracks;
            if (Object.prototype.hasOwnProperty.call(parent, 'tracks')) reordered.parent_revision.payload.tracks = editorTracks;
            const patch = documentPatchIntent({ before: appended, after: reordered, basis: { head: initial.head },
              roots: [{ ref: 'parent', revisionId: before.parent_revision.revision_id, contentDigest: before.parent_revision.content_digest }],
              label: mediaLabel, step: { id: crypto.randomUUID(), label: 'Position new track', intent: 'Keep the dropped track position', tags: [] },
              reads: [] }) as Record<string, OutboxJson>;
            commands!.splice(1, 0, { schema_version: 1, op: 'doc.patch', version: '1', select: null,
              args: { changes: patch.changes }, created: patch.created as string[] });
            mediaReads = [];
            const mappedSteps = commands!.map<NonNullable<CommitRequest['steps']>[number]>((_, index) => index === 1
              ? { ...patch.step as NonNullable<CommitRequest['steps']>[number], command_ordinals: [index], patch: patch.changes as NonNullable<CommitRequest['steps']>[number]['patch'] }
              : { id: crypto.randomUUID(), label: mediaLabel, intent: mediaLabel, tags: [], command_ordinals: [index], patch: [] });
            const [firstStep, ...remainingSteps] = mappedSteps;
            if (!firstStep) refuseEdit('There was nothing to place for this media. Use Add media instead.');
            mediaSteps = [firstStep, ...remainingSteps];
          }
        }
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
            refuseEdit("This media was not picked from the project's media, so it cannot be placed. Import the media again.");
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
        if (gestureBasis && gestureBasis.kind !== 'prepared-media' && gestureBasis.kind !== 'element' && gestureBasis.kind !== 'transition-clear' && gestureBasis.kind !== 'track-label') {
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
            // The edit consults only the asset's source duration (getClipTimelineDuration -> registry duration), or
            // that the entry exists. Reading the whole entry would conflict whenever the Runtime holds it in a
            // different form than this optimistic copy (e.g. written by a queued predecessor and then normalised).
            reads!.push(readPath(parent.registry, ['assets', item.asset, 'duration'], ['config', 'registry']));
          };
          assetRead(clip);
          if (gestureBasis.kind === 'split') {
            if (!Number.isFinite(gestureBasis.timeSeconds)) refuseEdit('The split point is missing. Move the playhead onto the clip and split again.', 'split-time-unavailable');
            // splitClipAtPlayhead uses order for insertion and every ID for allocation;
            // its pinned-group check reads this id-less list, not neighbor contents.
            const order = clips.map((item) => item.id as string);
            reads.push({ kind: 'collection', ref: 'parent', path: clipPath, members: [...order].sort(), order },
              read(config, 'pinnedShotGroups', ['config']));
          } else if (gestureBasis.kind === 'move') {
            if (clip.track !== gestureBasis.trackId) refuseEdit('The clip is no longer on the track you dragged it from. Try the move again.', 'move-track-mismatch');
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
          } else {
            if (!Object.keys(gestureBasis.patch).length
              || Object.keys(gestureBasis.patch).some((key) => !['from', 'to', 'hold', 'speed'].includes(key))) {
              refuseEdit('This trim is missing the clip or its neighbours. Try trimming again.', 'trim-operands-unavailable');
            }
            // resolveOverlaps consults the same-track siblings, so a concurrent move of one must conflict.
            const order = clips.map((item) => item.id as string);
            reads.push({ kind: 'collection', ref: 'parent', path: clipPath, members: [...order].sort(), order });
            for (const item of clips) {
              if (!object(item)) refuse('trim clip routing is unavailable', 'move-routing-unavailable');
              if (item.id === clip.id) continue;
              reads.push(read(item, 'track', [...clipPath, `id:${item.id}`]));
              if (item.track === clip.track) { reads.push(...timingReads(item)); assetRead(item); }
            }
          }
        }
        // The encoder supplies guards and created IDs; these bytes are never a wire DTO.
        const firstCommand = commands?.[0];
        if (commands && !firstCommand) refuseEdit('There was nothing to place for this media. Use Add media instead.');
        const pending = commands && firstCommand ? options.session.append({ before: toOutboxJson(before), after: toOutboxJson(after),
          label: mediaLabel, commands: [firstCommand, ...commands.slice(1)],
          ...(mediaReads && mediaSteps ? { reads: mediaReads, steps: mediaSteps,
            rationale: mediaSteps[0].intent, group_id: mediaSteps[0].id } : {}) }) : options.session.appendDocument({ before, after,
          roots: [{ ref: 'parent', revisionId: before.parent_revision.revision_id, contentDigest: before.parent_revision.content_digest }],
          ...(reads === undefined ? (appearanceChanged ? { merge: 'atomic' as const } : {}) : { reads, merge: gestureBasis?.kind === 'element' ? 'atomic' as const : 'fields' as const }),
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
        // Only refuseEdit registers; unexpected errors and session or conflict errors stay unregistered.
        const rejection = error instanceof TimelineVersionConflictError || error instanceof TimelineSaveError ? error
          : new TimelineSaveError(`Local document save retained: ${error instanceof Error ? error.message : String(error)}`);
        // A declined edit (earlier saves unresolved or replaying) never entered the queue: undo it on screen
        // and say why, rather than leaving a failure that blocks every later save.
        if (error instanceof LocalSaveDeclined) authoringRefusals.add(rejection);
        return Promise.reject(rejection);
      }
    },
    async flush(traceId) {
      historyEpoch++;
      try {
        recordTimelineSaveMark(traceId, 'handoff-flush-start');
        const basis = await options.session.flush(traceId);
        recordTimelineSaveMark(traceId, 'handoff-adopted-read-start');
        const adopted = options.adopted(basis);
        recordTimelineSaveMark(traceId, 'handoff-adopted-read-end');
        const head = adopted.receipt.head;
        if (head.projectId !== initial.canonicalDocument.project_id || head.timelineId !== initial.canonicalDocument.timeline_id
          || head.headRevisionId !== basis.head.revisionId || head.headPublicationId !== basis.head.publicationId
          || !same(adopted.source.head, head)) refuse('canonical assembly did not adopt the accepted head');
        recordTimelineSaveMark(traceId, 'handoff-copy-start');
        initial = structuredClone(basis);
        source = structuredClone(adopted.source);
        authoringSource = structuredClone(adopted.source);
        document = structuredClone(basis.canonicalDocument);
        recordTimelineSaveMark(traceId, 'handoff-copy-end');
        sourceChecked = false;
        targets = historyTargets(basis.history, basis.head, options.session.actorId);
        historyLoaded = completeHistory(basis.history, basis.head);
        if (legacyHistory && options.loadHistory) await refreshHistory();
        recordTimelineSaveMark(traceId, 'handoff-flush-end');
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
    async discharge(mode, exported, stillCurrent) {
      historyEpoch++;
      let failure: unknown;
      try { await options.session.discharge(mode, exported, stillCurrent); }
      catch (error) { if (exported) throw error; failure = error; }
      const state = options.session.getState();
      if (state.status !== 'saved') {
        const message = object(state.error) && typeof state.error.message === 'string' ? state.error.message
          : failure instanceof Error ? failure.message : 'The change is still not saved';
        if (state.status === 'conflict') throw new TimelineVersionConflictError(message);
        refuse(message);
      }
      // After the creator discards or a conflict saves successfully, both
      // the session and editor must author subsequent gestures from the new
      // authenticated head. Reusing the original pre-discharge source would
      // silently attach them to an obsolete revision.
      const basis = options.session.getBasis();
      const adopted = options.adopted(basis);
      const head = adopted.receipt.head;
      if (head.projectId !== basis.canonicalDocument.project_id || head.timelineId !== basis.canonicalDocument.timeline_id
        || head.headRevisionId !== basis.head.revisionId || head.headPublicationId !== basis.head.publicationId
        || !same(adopted.source.head, head)) refuse('canonical assembly did not adopt the discharged head');
      initial = structuredClone(basis);
      source = structuredClone(adopted.source);
      authoringSource = structuredClone(adopted.source);
      document = structuredClone(basis.canonicalDocument);
      sourceChecked = false;
      targets = historyTargets(basis.history, basis.head, options.session.actorId);
      historyLoaded = completeHistory(basis.history, basis.head);
      return adopted.receipt;
    },
    remoteHistoryAvailable,
    canRequestHistory,
    refreshHistory,
    canUndo: () => remoteHistoryAvailable() && targets.undo.length > 0,
    canRedo: () => remoteHistoryAvailable() && targets.redo.length > 0,
    undo: () => appendInverse('undo'),
    redo: () => appendInverse('redo'),
  };
  return handoff;
}

function completeHistory(history: HistoryPage | undefined, head: TimelineCommandBasis['head']): boolean {
  return Boolean(history && Array.isArray(history.items) && history.next_cursor === null
    && history.head?.revision_id === head.revisionId && history.head?.publication_id === head.publicationId);
}

function historyTargets(history: HistoryPage | undefined, head: TimelineCommandBasis['head'], actorId: string): { undo: string[]; redo: string[] } {
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
    // Undo/Redo only ever revert this actor's own edits; another actor's
    // recorded publication is neither a target nor a barrier (guards still
    // refuse the inverse if it conflicts with that later edit).
    if (entry.publisher !== actorId) continue;
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

import type { CanonicalDocument, JSON } from '@/integrations/runtime/timeline-commit-types.ts';

type ObjectValue = { [key: string]: JSON };
type ShotSource = ObjectValue & {
  shot_id: string;
  revision_id: string;
  content_digest: string;
  internal_timeline_id: string;
  internal_timeline_revision_id: string;
  internal_timeline_content_digest: string;
  item_id_map: Record<string, string>;
};

// Main's local authoring state, structurally consumable by clipMovePrimitives.AuthoredBundle.
export type AuthoringBundle = ObjectValue & {
  schema_version: 1;
  project_id: string;
  timeline_id: string;
  base_parent: { revision_id: string; content_digest: string };
  base_parent_payload: ObjectValue;
  base_placements: Record<string, ObjectValue>;
  parent: ObjectValue;
  placements: ObjectValue[];
  shots: Record<string, ObjectValue & {
    shot_id: string;
    base_payload: ObjectValue;
    payload: ObjectValue;
    base_internal_timeline: ObjectValue;
    internal_timeline: ObjectValue;
  }>;
  source_mapping: {
    placements: Record<string, ObjectValue>;
    shots: Record<string, ShotSource>;
    _runtime_document: ObjectValue;
  };
};

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid authoring closure: ${message}`);
}

function object(value: unknown): ObjectValue {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
  return value as ObjectValue;
}

function rows(value: unknown): ObjectValue[] {
  requireValue(Array.isArray(value), 'expected array');
  return value.map(object);
}

function id(value: unknown): string {
  requireValue(typeof value === 'string' && value.length > 0, 'missing identity');
  return value;
}

function unique<T>(values: T[], key: (value: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    requireValue(!result.has(identity), `duplicate identity ${identity}`);
    result.set(identity, value);
  }
  return result;
}

// Python _identity hashes kind + NUL-separated canonical JSON STRING parts.
// No payload numbers/digests are reserialized or verified in the browser.
async function identity(kind: string, ...parts: string[]): Promise<string> {
  const encoded = new TextEncoder().encode([kind, ...parts.map((part) => JSON.stringify(part))].join('\0'));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return `${kind}-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function remapItems(payload: ObjectValue, remap: Map<string, string>): ObjectValue {
  const result = structuredClone(payload);
  for (const item of rows('items' in result ? result.items : [])) {
    const identity = id('item_id' in item ? item.item_id : item.id);
    for (const field of ['item_id', 'id']) {
      if (field in item && item[field] === identity) {
        item[field] = remap.get(identity) ?? identity;
      }
    }
    // Match Agent's shot dependency codec: metadata owns source links when
    // it is an object; otherwise the item does. Other namespaces are opaque.
    const metadata = item.metadata;
    const descriptor = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata : item;
    for (const field of ['source_item_id', 'source_item']) {
      const source = descriptor[field];
      if (typeof source === 'string') descriptor[field] = remap.get(source) ?? source;
    }
  }
  return result;
}

function validateEntities(payload: ObjectValue): void {
  for (const key of ['clips', 'tracks']) {
    if (key in payload) unique(rows(payload[key]), (row) => id(row.id));
  }
}

/**
 * Open an authenticated Runtime closure as main open_authoring_bundle state.
 * Await once at load/ACK before capture; this reads no heads and accepts nothing.
 * Runtime owns payload digest verification. Original images/pins remain provenance.
 */
export async function authoringBundleFromDocument(input: CanonicalDocument): Promise<AuthoringBundle> {
  // Snapshot before the first await, including the lossless compiler basis retained by Python.
  const document = structuredClone(input);
  requireValue(document.schema_version === 1, 'unsupported schema');
  const project = id(document.project_id);
  const timeline = id(document.timeline_id);
  const parentImage = document.parent_revision;
  id(parentImage.revision_id);
  id(parentImage.content_digest);
  const parent = structuredClone(object(parentImage.payload));
  const occurrences = rows(parent.occurrences);
  unique(occurrences, (row) => id(row.occurrence_id));
  validateEntities(parent);
  if ('config' in parent) validateEntities(object(parent.config));
  delete parent.occurrences;

  const shots = unique(document.shot_revisions, (shot) => id(shot.revision_id));
  const internals = unique(document.internal_timeline_revisions, (internal) => id(internal.revision_id));
  const counts = new Map<string, number>();
  for (const occurrence of occurrences) {
    const source = id(occurrence.shot_id);
    counts.set(source, (counts.get(source) ?? 0) + 1);
    const shot = shots.get(id(occurrence.shot_revision_id));
    requireValue(shot?.shot_id === source, 'missing exact occurrence shot revision');
  }
  requireValue(new Set(occurrences.map((row) => row.shot_revision_id)).size === shots.size, 'orphan shot image');
  for (const shot of shots.values()) {
    const payload = object(shot.payload);
    const revision = id(shot.internal_timeline_revision_id);
    requireValue(!('internal_timeline_revision_id' in payload) || payload.internal_timeline_revision_id === revision,
      'shot internal revision link mismatch');
    requireValue(internals.has(revision), 'missing exact internal timeline');
  }
  requireValue(new Set([...shots.values()].map((shot) => shot.internal_timeline_revision_id)).size === internals.size,
    'orphan internal image');
  const manifest = document.dependency_manifest;
  const shotPins = unique(manifest.shots, (pin) => id(pin.revision_id));
  const internalPins = unique(manifest.internal_timelines, (pin) => id(pin.revision_id));
  requireValue(shotPins.size === shots.size && internalPins.size === internals.size, 'manifest image mismatch');
  for (const shot of shots.values()) {
    const pin = shotPins.get(shot.revision_id);
    requireValue(pin?.shot_id === shot.shot_id && pin?.content_digest === shot.content_digest &&
      pin?.internal_timeline_revision_id === shot.internal_timeline_revision_id, 'shot manifest pin mismatch');
  }
  for (const internal of internals.values()) {
    const pin = internalPins.get(internal.revision_id);
    requireValue(pin?.timeline_id === internal.timeline_id && pin?.content_digest === internal.content_digest,
      'internal manifest pin mismatch');
  }

  const placements: ObjectValue[] = [];
  const authoredShots = new Map<string, AuthoringBundle['shots'][string]>();
  const sources = new Map<string, ShotSource>();
  const seenItems = new Set<string>();
  for (const raw of occurrences) {
    const occurrence = structuredClone(raw);
    const occurrenceId = id(occurrence.occurrence_id);
    const sourceId = id(occurrence.shot_id);
    const shot = shots.get(id(occurrence.shot_revision_id))!;
    const internal = internals.get(shot.internal_timeline_revision_id)!;
    const owner = counts.get(sourceId)! > 1
      ? await identity('shot-placement', project, timeline, occurrenceId, sourceId) : sourceId;
    requireValue(!authoredShots.has(owner), `independent shot identity collision ${owner}`);
    let payload = structuredClone(object(shot.payload));
    const items = rows('items' in payload ? payload.items : []);
    const itemId = (item: ObjectValue) => id('item_id' in item ? item.item_id : item.id);
    unique(items, itemId);
    const remap = new Map<string, string>();
    if (owner !== sourceId) {
      for (const item of items) {
        const sourceItem = itemId(item);
        remap.set(sourceItem, await identity('shot-item-placement', project, timeline, occurrenceId, owner, sourceItem));
      }
      payload = remapItems(payload, remap);
    }
    for (const item of rows('items' in payload ? payload.items : [])) {
      const key = itemId(item);
      requireValue(!seenItems.has(key), `authoring shot item identity collision ${key}`);
      seenItems.add(key);
    }
    const internalPayload = object(internal.payload);
    validateEntities(internalPayload);
    authoredShots.set(owner, {
      shot_id: owner,
      base_payload: structuredClone(payload),
      payload: structuredClone(payload),
      base_internal_timeline: structuredClone(internalPayload),
      internal_timeline: structuredClone(internalPayload),
    });
    sources.set(owner, {
      shot_id: sourceId,
      revision_id: shot.revision_id,
      content_digest: id(shot.content_digest),
      internal_timeline_id: id(internal.timeline_id),
      internal_timeline_revision_id: internal.revision_id,
      internal_timeline_content_digest: id(internal.content_digest),
      item_id_map: Object.fromEntries(remap),
    });
    delete occurrence.shot_revision_id;
    delete occurrence.revision_id;
    occurrence.shot_id = owner;
    placements.push(occurrence);
  }
  const basePlacements = Object.fromEntries(placements.map((row) => [id(row.occurrence_id), structuredClone(row)]));
  return {
    schema_version: 1,
    project_id: project,
    timeline_id: timeline,
    base_parent: { revision_id: parentImage.revision_id, content_digest: parentImage.content_digest },
    base_parent_payload: structuredClone(parent),
    base_placements: structuredClone(basePlacements),
    parent,
    placements,
    shots: Object.fromEntries(authoredShots),
    source_mapping: { placements: basePlacements, shots: Object.fromEntries(sources), _runtime_document: object(document) },
  };
}

import type { CanonicalDocument } from '@/integrations/runtime/timeline-commit-types.ts';
import { toOutboxJson, type OutboxBasis, type OutboxJson } from './commitOutbox.ts';

type ObjectValue = { [key: string]: OutboxJson };

/** Local mapping supplied from a verified closure, never sent as provider binding facts. */
export interface PhysicalRootBinding {
  ref: 'parent' | `shot-revision:${string}` | `internal-revision:${string}`;
  revisionId: string;
  contentDigest: string;
}

interface Input {
  basis: Exclude<OutboxBasis, { create: true }>;
  before: CanonicalDocument;
  after: CanonicalDocument;
  roots: PhysicalRootBinding[];
  label: string;
  step: { id: string; label: string; intent: string; tags: string[]; reads?: OutboxJson[] };
  merge?: 'fields' | 'atomic';
  reads?: OutboxJson[];
}

const own = (value: ObjectValue, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value: OutboxJson | undefined): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a: OutboxJson | undefined, b: OutboxJson | undefined): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => own(b, key) && same(a[key], b[key]));
};
const present = (value: OutboxJson): ObjectValue => ({ state: 'present', value });
const absent = (): ObjectValue => ({ state: 'absent' });
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Cannot encode document patch: ${message}`);
}
function object(value: OutboxJson): ObjectValue {
  requireValue(isObject(value), 'expected an authored object');
  return value;
}

function images(document: CanonicalDocument) {
  return [
    { ref: 'parent', image: document.parent_revision },
    ...document.shot_revisions.map((image) => ({ ref: `shot-revision:${image.revision_id}`, image })),
    ...document.internal_timeline_revisions.map((image) => ({ ref: `internal-revision:${image.revision_id}`, image })),
  ];
}

function envelope(document: CanonicalDocument): OutboxJson {
  const copy = structuredClone(document);
  for (const { image } of images(copy)) image.payload = {};
  return toOutboxJson(copy);
}

function rows(value: OutboxJson, key: string): Map<string, ObjectValue> {
  requireValue(Array.isArray(value), `expected ${key} collection`);
  const result = new Map<string, ObjectValue>();
  for (const item of value) {
    const row = object(item);
    const id = row[key];
    requireValue(typeof id === 'string' && id.length > 0 && !result.has(id), `missing/duplicate ${key}`);
    result.set(id, row);
  }
  return result;
}

// Check exact pins/reachability, not payload hashes. Authenticating the input remains Runtime's job.
function checkClosure(document: CanonicalDocument) {
  const parent = object(toOutboxJson(document.parent_revision.payload));
  const occurrences = rows(own(parent, 'occurrences') ? parent.occurrences : [], 'occurrence_id');
  const all = images(document);
  requireValue(new Set(all.map(({ ref }) => ref)).size === all.length, 'duplicate physical root');
  for (const { image } of all) {
    requireValue(image.revision_id.length > 0 && image.content_digest.length > 0, 'missing physical pin');
  }
  for (const shot of document.shot_revisions) {
    requireValue([...occurrences.values()].some((row) => row.shot_revision_id === shot.revision_id && row.shot_id === shot.shot_id),
      'shot outside verified closure');
    const pins = document.dependency_manifest.shots.filter((pin) => pin.revision_id === shot.revision_id);
    requireValue(pins.length === 1 && pins[0].shot_id === shot.shot_id && pins[0].content_digest === shot.content_digest
      && pins[0].internal_timeline_revision_id === shot.internal_timeline_revision_id, 'shot manifest mismatch');
    const payload = object(toOutboxJson(shot.payload));
    requireValue(!own(payload, 'internal_timeline_revision_id') || payload.internal_timeline_revision_id === shot.internal_timeline_revision_id,
      'shot internal pin mismatch');
    requireValue(document.internal_timeline_revisions.filter((image) => image.revision_id === shot.internal_timeline_revision_id).length === 1,
      'missing exact internal image');
  }
  for (const internal of document.internal_timeline_revisions) {
    const pins = document.dependency_manifest.internal_timelines.filter((pin) => pin.revision_id === internal.revision_id);
    requireValue(document.shot_revisions.some((shot) => shot.internal_timeline_revision_id === internal.revision_id)
      && pins.length === 1 && pins[0].timeline_id === internal.timeline_id && pins[0].content_digest === internal.content_digest,
    'internal image outside verified closure or manifest mismatch');
  }
  for (const row of occurrences.values()) {
    requireValue(document.shot_revisions.filter((shot) => shot.revision_id === row.shot_revision_id && shot.shot_id === row.shot_id).length === 1,
      'missing exact occurrence shot image');
  }
}

/**
 * Pure, unsent intent. Both documents contain authored payloads under the SAME original
 * Runtime wrappers; no successor pins/digests are invented for local edits. The caller
 * must map upstream local views back to physical roots before calling this function.
 * The generated v2 transport join must build/validate commands and steps later.
 */
export function documentPatchIntent(input: Input): OutboxJson | null {
  const before = structuredClone(input.before);
  const after = structuredClone(input.after);
  // Validate finite JSON before walking it, preserving own keys such as __proto__.
  const beforeJson = toOutboxJson(before);
  const afterJson = toOutboxJson(after);
  requireValue(same(envelope(before), envelope(after)), 'image wrappers/closure membership changed');
  checkClosure(before);
  requireValue(before.schema_version === 1, 'unsupported canonical schema');
  requireValue(('head' in input.basis && input.basis.head.revisionId === before.parent_revision.revision_id
    && input.basis.head.publicationId.length > 0) || ('after' in input.basis && input.basis.after.length > 0),
  'missing or mismatched authoring basis');
  requireValue(input.label.trim() && input.step.id && input.step.label.trim(), 'missing label or step identity');
  const bindings = new Map<string, PhysicalRootBinding>();
  const originalImages = new Map(images(before).map((entry) => [entry.ref, entry.image]));
  for (const binding of input.roots) {
    const image = originalImages.get(binding.ref);
    requireValue(!bindings.has(binding.ref) && image && image.revision_id === binding.revisionId
      && image.content_digest === binding.contentDigest, `unverified physical binding ${binding.ref}`);
    bindings.set(binding.ref, binding);
  }
  const changes: OutboxJson[] = [];
  const created: string[] = [];
  for (const { ref, image: afterImage } of images(after)) {
    const a = object(toOutboxJson(originalImages.get(ref)!.payload));
    const b = object(toOutboxJson(afterImage.payload));
    if (same(a, b)) continue;
    requireValue(bindings.has(ref), `changed root lacks explicit physical binding ${ref}`);
    if (ref.startsWith('shot-revision:')) {
      requireValue(same(a.internal_timeline_revision_id, b.internal_timeline_revision_id), 'managed shot internal edge');
    }
    if (ref === 'parent') {
      const oldRows = rows(own(a, 'occurrences') ? a.occurrences : [], 'occurrence_id');
      const newRows = rows(own(b, 'occurrences') ? b.occurrences : [], 'occurrence_id');
      requireValue(oldRows.size === newRows.size, 'managed occurrence membership');
      for (const [id, row] of oldRows) {
        const next = newRows.get(id);
        requireValue(next && ['shot_id', 'shot_revision_id', 'revision_id'].every((key) => same(row[key], next[key])),
          'managed occurrence edge or identity');
      }
    }
    // Main mirrors clips (and sometimes registries). Submit one logical address only.
    const mirrors = new Set<string>();
    for (const key of ref === 'parent' ? ['clips', 'tracks', 'registry'] : []) {
      const ac = isObject(a.config) ? a.config : {};
      const bc = isObject(b.config) ? b.config : {};
      if ((own(a, key) && own(ac, key)) || (own(b, key) && own(bc, key))) {
        requireValue(own(a, key) && own(ac, key) && own(b, key) && own(bc, key)
          && same(a[key], ac[key]) && same(b[key], bc[key]), `contradictory or changed ${key} mirror layout`);
        mirrors.add(key);
      }
    }
    function identityKey(path: string[]): string | undefined {
      if (ref === 'parent' && path.length === 1 && path[0] === 'occurrences') return 'occurrence_id';
      if (!ref.startsWith('shot-revision:') && (path.length === 1 || (ref === 'parent' && path.length === 2 && path[0] === 'config'))
        && ['clips', 'tracks'].includes(path[path.length - 1])) return 'id';
    }
    function diff(old: OutboxJson | undefined, next: OutboxJson | undefined, path: string[]) {
      if (path.length === 2 && path[0] === 'config' && mirrors.has(path[1])) return;
      const identity = identityKey(path);
      if (identity) {
        requireValue(Array.isArray(old) && Array.isArray(next), `unsupported collection replacement ${ref}/${path.join('/')}`);
        const oldRows = rows(old, identity);
        const newRows = rows(next, identity);
        if (same(old, next)) return;
        let order = [...oldRows.keys()];
        for (const [id, value] of oldRows) {
          if (newRows.has(id)) continue;
          changes.push({ op: 'list.remove', ref, path, id, before: present(value), order_before: [...order] });
          order = order.filter((entry) => entry !== id);
        }
        let anchor: string | null = null;
        for (const [id, value] of newRows) {
          if (!oldRows.has(id)) {
            requireValue(ref === 'parent' && identity === 'id', 'child entity creation needs an explicit allocation join');
            created.push(`parent/${path[path.length - 1] === 'clips' ? 'clip' : 'track'}:${id}`);
            changes.push({ op: 'list.insert', ref, path, id, before: absent(), value,
              order_before: [...order], after_id: anchor });
            order.splice(anchor === null ? 0 : order.indexOf(anchor) + 1, 0, id);
          } else if (order[anchor === null ? 0 : order.indexOf(anchor) + 1] !== id) {
            changes.push({ op: 'list.move', ref, path, id, before: present(oldRows.get(id)!),
              order_before: [...order], after_id: anchor });
            order = order.filter((entry) => entry !== id);
            order.splice(anchor === null ? 0 : order.indexOf(anchor) + 1, 0, id);
          }
          anchor = id;
        }
        for (const [id, value] of newRows) {
          if (oldRows.has(id)) diff(oldRows.get(id)!, value, [...path, `${identity}:${id}`]);
        }
        return;
      }
      if (same(old, next)) return;
      if (isObject(old) && isObject(next)) {
        for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
          diff(own(old, key) ? old[key] : undefined, own(next, key) ? next[key] : undefined, [...path, key]);
        }
        return;
      }
      // Do not hide entity allocation or mirror edits inside a config replacement.
      requireValue(!(ref === 'parent' && path.length === 1 && path[0] === 'config'), 'unsupported config replacement');
      requireValue(path.length > 0, 'whole-root replacement');
      changes.push(next === undefined ? { op: 'remove', ref, path, before: present(old!) }
        : { op: 'set', ref, path, before: old === undefined ? absent() : present(old), value: next });
    }
    diff(a, b, []);
  }
  if (!changes.length) return null;
  // This is local persistence data, not CommitRequest/EditCommand or an executable schema.
  // In particular, omitted reads stays omitted: the provider must use atomic fallback.
  return toOutboxJson({ kind: 'document-patch-intent', basis: input.basis, before: beforeJson, after: afterJson,
    roots: input.roots, label: input.label, step: input.step, changes, created,
    ...(input.merge === undefined ? {} : { merge: input.merge }),
    ...(input.reads === undefined ? {} : { reads: input.reads }) });
}

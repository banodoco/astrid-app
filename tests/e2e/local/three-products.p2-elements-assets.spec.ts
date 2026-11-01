import { expect, type Locator, type Page, type Request, type Response } from '@playwright/test';
import { sha256Hex, THREE_PRODUCTS_REFERENCE_AT, type DirectHarness, type ThreeProductsSeed } from './support/harness.ts';
import { ASTRID_PYTHON } from './support/astrid.ts';
import { dropFileOnTimeline, openEmbeddedCanonicalShot, test as appTest, timelineFileDropClientX } from './support/app.ts';
import { assertSemanticAddMediaRequest, expectedImageDropRow } from './support/p2-semantic-oracle.ts';
import {
  assertMediaImportSelectionIdentity,
  assertNormalizedCatalogueEntry,
  assertRawMediaImportEntry,
  mediaImportEvidenceFromProducer,
} from './support/p2-media-import-oracle.ts';
import type {
  CanonicalDocument,
  CommitAcceptedMutation,
  CommitRequest,
  HeadPin,
  HistoryEntry,
  HistoryPage,
} from '../../../src/integrations/runtime/timeline-commit-types.ts';

/**
 * P2/A3's real mounted asset/element slice.  The existing P2 tour owns the
 * parent move and transition cases; this file owns the remaining mounted
 * element, registry and child-placement paths.
 */
const COMMITS = /\/v1\/projects\/[^/]+\/timelines\/[^/]+\/commit$/;
const LEGACY_WRITES = /\/timelines\/[^/]+\/(?:composition-revisions|saves)$/;
const CEILING = { timeout: 90_000 };
type JsonObject = Record<string, unknown>;

interface CommitPost {
  request: Request;
  response: Response;
  body: CommitRequest;
  json: unknown;
  key: string;
}

interface Wire {
  posts: CommitPost[];
  legacy: string[];
}

const test = appTest.extend<object, { seed3: ThreeProductsSeed }>({
  seed3: [async ({ harness }, use) => {
    await use(await harness.seedThreeProducts(THREE_PRODUCTS_REFERENCE_AT, 'native-none'));
  }, { scope: 'worker', timeout: 240_000 }],
});

const placementTest = appTest.extend<object, { seed3: ThreeProductsSeed }>({
  seed3: [async ({ harness }, use) => {
    await use(await harness.seedThreeProducts(THREE_PRODUCTS_REFERENCE_AT, 'native-none', 14));
  }, { scope: 'worker', timeout: 240_000 }],
});

test.describe.configure({ mode: 'serial' });

function object(value: unknown, label: string): JsonObject {
  expect(value, label).toBeTruthy();
  expect(typeof value, label).toBe('object');
  expect(Array.isArray(value), label).toBe(false);
  return value as JsonObject;
}

function exactKeys(value: unknown, keys: string[], label: string): JsonObject {
  const result = object(value, label);
  expect(Object.keys(result).sort(), `${label} keys`).toEqual([...keys].sort());
  return result;
}

interface NativeUndoContext {
  before: CanonicalDocument;
  restored: CanonicalDocument;
  targetPublication: string;
  priorHistory: HistoryPage;
  history: HistoryPage;
  readback: CanonicalDocument;
}

function nativeImages(document: CanonicalDocument): Record<string, JsonObject> {
  return Object.fromEntries([
    ['parent', document.parent_revision],
    ...document.shot_revisions.map((image) => [`shot-revision:${image.revision_id}`, image]),
    ...document.internal_timeline_revisions.map((image) => [`internal-revision:${image.revision_id}`, image]),
  ]) as Record<string, JsonObject>;
}

function nativeChild(document: CanonicalDocument, owner: string): { row: JsonObject; shot: JsonObject; child: JsonObject } {
  const rows = document.parent_revision.payload.occurrences as unknown as JsonObject[];
  const row = rows.find((item) => `occurrence:${item.occurrence_id}` === owner);
  expect(row, `independent canonical owner ${owner}`).toBeTruthy();
  const shot = document.shot_revisions.find((image) => image.revision_id === row!.shot_revision_id)!;
  const child = document.internal_timeline_revisions.find((image) => image.revision_id === shot.internal_timeline_revision_id)!;
  expect(shot).toBeTruthy();
  expect(child).toBeTruthy();
  return { row: row!, shot: shot as unknown as JsonObject, child: child as unknown as JsonObject };
}

function nativeState(value: unknown, path: string[] = []): JsonObject {
  for (const token of path) {
    if (Array.isArray(value) && /^(id|occurrence_id):/.test(token)) {
      const split = token.indexOf(':');
      value = value.find((row) => row[token.slice(0, split)] === token.slice(split + 1));
    } else if (value !== null && typeof value === 'object' && Object.hasOwn(value, token)) {
      value = (value as JsonObject)[token];
    } else return { state: 'absent' };
  }
  return value === undefined ? { state: 'absent' } : { state: 'present', value: structuredClone(value) };
}

function nativeConfig(document: CanonicalDocument, owner: string): JsonObject {
  return owner === 'parent' ? document.parent_revision.payload.config as JsonObject
    : nativeChild(document, owner).child.payload as JsonObject;
}

function nativeRows(document: CanonicalDocument, owner: string, kind: string): JsonObject[] {
  const parent = document.parent_revision.payload as unknown as JsonObject;
  if (kind === 'occurrence') {
    expect(owner).toBe('parent');
    return parent.occurrences as JsonObject[];
  }
  if (!['clip', 'track'].includes(kind)) throw new Error(`P2 native oracle scope question: collection ${kind}`);
  const config = nativeConfig(document, owner);
  const primary = parent.clips;
  return (owner === 'parent' && kind === 'clip' && Array.isArray(primary)
    && (primary.length || !Array.isArray(config.clips) || !config.clips.length)
    ? primary : config[`${kind}s`]) as JsonObject[];
}

// Agent _command_state.State.get / _collections.shape: native captures are not CommitRead DTOs.
function nativeValue(document: CanonicalDocument, ref: string, path: string[]): JsonObject {
  const parent = document.parent_revision.payload as unknown as JsonObject;
  const [owner, entity] = ref.split('/');
  const config = nativeConfig(document, owner!);
  if (entity?.startsWith('collection:')) {
    expect(path).toEqual([]);
    const kind = entity.slice('collection:'.length);
    const tagged = (obj: unknown, key: string): JsonObject => {
      const state = nativeState(obj, [key]);
      if (Array.isArray(state.value)) state.value = [];
      else if (state.value !== null && typeof state.value === 'object') state.value = {};
      return state;
    };
    let shape: JsonObject;
    if (kind === 'occurrence') shape = { container: 'array' };
    else if (kind === 'asset') shape = Object.fromEntries((owner === 'parent' ? [parent, config] : [config]).map((obj, index) => [String(index), {
      registry: tagged(obj, 'registry'), assets: tagged(obj.registry, 'assets'),
    }]));
    else {
      if (!['clip', 'track'].includes(kind)) throw new Error(`P2 native oracle scope question: shape ${ref}`);
      shape = { members: tagged(config, `${kind}s`), ...(owner === 'parent' ? {
        config: tagged(parent, 'config'), ...(kind === 'clip' ? { payload_members: tagged(parent, 'clips') } : {}),
      } : {}) };
    }
    return nativeState(shape);
  }
  if (ref === 'parent') return nativeState(parent, path);
  if (entity === 'source') return nativeState(config, path);
  if (entity === 'shot' && path[0] === 'shot_id') return nativeState(nativeChild(document, owner!).shot, path);
  if (entity?.startsWith('clip:') || entity?.startsWith('track:')) {
    const [kind, id] = entity.split(':');
    return nativeState(nativeRows(document, owner!, kind!).find((row) => row.id === id), path);
  }
  if (entity?.startsWith('asset:')) {
    const registry = owner === 'parent' && Object.hasOwn(parent, 'registry') ? parent.registry : config.registry;
    return nativeState(registry, ['assets', entity.slice('asset:'.length), ...path]);
  }
  if (owner?.startsWith('occurrence:') && !entity && path[0] !== 'shot_id') return nativeState(nativeChild(document, owner).row, path);
  throw new Error(`P2 native oracle scope question: native read ${ref} ${JSON.stringify(path)}`);
}

// Agent _commit_patch.canonical_site, restricted to the native sites these four Undo cases use.
function nativeSite(document: CanonicalDocument, ref: string, path: string[]): { ref: string; path: string[] } {
  if (ref === 'parent') return { ref, path: ['clips', 'registry'].includes(path[0]!) ? ['config', ...path] : path };
  const [owner, entity] = ref.split('/');
  if (entity?.startsWith('collection:')) {
    const kind = entity.slice('collection:'.length);
    return nativeSite(document, owner === 'parent' ? owner : `${owner}/source`,
      ['clip', 'track', 'occurrence'].includes(kind)
        ? [...(owner === 'parent' && kind !== 'occurrence' ? ['config'] : []), kind === 'occurrence' ? 'occurrences' : `${kind}s`] : []);
  }
  if (owner === 'parent') {
    if (entity === 'source') return { ref: 'parent', path: ['config', ...path] };
    if (entity?.startsWith('clip:') || entity?.startsWith('track:')) {
      const [kind, id] = entity.split(':');
      return { ref: 'parent', path: ['config', `${kind}s`, `id:${id}`, ...path] };
    }
    if (entity?.startsWith('asset:')) return { ref: 'parent', path: ['config', 'registry', 'assets', entity.slice(6), ...path] };
  } else if (owner?.startsWith('occurrence:')) {
    const { row, shot, child } = nativeChild(document, owner);
    if (!entity || entity === 'shot') return { ref: 'parent', path: ['occurrences', `occurrence_id:${row.occurrence_id}`, ...path] };
    const physical = `internal-revision:${child.revision_id}`;
    if (entity === 'source') return { ref: physical, path };
    if (entity?.startsWith('clip:') || entity?.startsWith('track:')) {
      const [kind, id] = entity.split(':');
      return { ref: physical, path: [`${kind}s`, `id:${id}`, ...path] };
    }
    if (entity?.startsWith('asset:')) return { ref: physical, path: ['registry', 'assets', entity.slice(6), ...path] };
    expect(shot).toBeTruthy();
  }
  throw new Error(`P2 native oracle scope question: physical site ${ref} ${JSON.stringify(path)}`);
}

// Agent _commit_patch.native_asset_reads: asset collection reads retain both
// physical parent registry fields, including an absent config mirror.
function nativeAssetReads(document: CanonicalDocument): JsonObject[] {
  const config = document.parent_revision.payload.config as unknown as JsonObject;
  const paths = [
    ['registry'],
    config && typeof config === 'object' ? ['config', 'registry'] : ['config'],
  ];
  return paths.map((path) => ({ kind: 'field', ref: 'parent', path, state: nativeValue(document, 'parent', path) }));
}

function nativeSelection(document: CanonicalDocument, key: string, owner: string): JsonObject {
  let members: string[];
  let boundaries: string[];
  if (key.startsWith('collection.') || key === 'track.create') {
    const kind = key === 'track.create' ? 'track' : key.slice('collection.'.length, -1);
    members = nativeRows(document, owner, kind).map((row) => kind === 'occurrence' ? `occurrence:${row.occurrence_id}` : `${owner}/${kind}:${row.id}`);
    boundaries = members;
  } else if (key === 'placement.owners') {
    const { row } = nativeChild(document, owner);
    members = (document.parent_revision.payload.occurrences as unknown as JsonObject[])
      .filter((item) => item.shot_id === row.shot_id).map((item) => `occurrence:${item.occurrence_id}`);
    boundaries = [`shot:${row.shot_id}`];
  } else throw new Error(`P2 native oracle scope question: selection ${key}`);
  return { key, query_version: 1, owner, members, order: [...members], boundaries: [...boundaries], policy: 'guard-membership' };
}

function nativeBinding(document: CanonicalDocument, ref: string, physical: string, boundary: JsonObject): JsonObject {
  const image = nativeImages(document)[physical]!;
  expect(image, `binding image ${physical}`).toBeTruthy();
  const owners = physical === 'parent' ? [] : (document.parent_revision.payload.occurrences as unknown as JsonObject[]).filter((row) => {
    const { shot, child } = nativeChild(document, `occurrence:${row.occurrence_id}`);
    return physical === `shot-revision:${shot.revision_id}` || physical === `internal-revision:${child.revision_id}`;
  }).map((row) => `occurrence:${row.occurrence_id}/shot`);
  return { ref, physical_ref: physical, revision_id: image.revision_id, content_digest: image.content_digest,
    boundary, ...(physical === 'parent' ? {} : { owners }) };
}

// Complete effect projection from independent endpoints, following Agent _commit_patch.effect_diff.
function nativeEffects(before: CanonicalDocument, restored: CanonicalDocument): JsonObject[] {
  const old = nativeImages(before), next = nativeImages(restored), effects: JsonObject[] = [];
  const walk = (ref: string, path: string[], a: JsonObject, b: JsonObject): void => {
    if (digest(a) === digest(b)) return;
    const left = a.value, right = b.value;
    if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) walk(ref, [...path, key], nativeState(left, [key]), nativeState(right, [key]));
      return;
    }
    const key = ref === 'parent' && path.join('.') === 'occurrences' ? 'occurrence_id'
      : (ref === 'parent' && ['config.clips', 'config.tracks'].includes(path.join('.'))
        || ref.startsWith('internal-revision:') && ['clips', 'tracks'].includes(path.join('.'))) ? 'id' : null;
    if (key && Array.isArray(left) && Array.isArray(right) && digest(left.map((row) => row[key])) === digest(right.map((row) => row[key]))) {
      for (let i = 0; i < left.length; i++) walk(ref, [...path, `${key}:${left[i][key]}`], nativeState(left[i]), nativeState(right[i]));
      return;
    }
    effects.push({ op: b.state === 'absent' ? 'remove' : 'set', ref, path, before: a, ...(b.state === 'absent' ? {} : { value: right }) });
  };
  for (const prefix of ['internal-revision:', 'shot-revision:']) for (const ref of Object.keys(next).filter((ref) => !old[ref] && ref.startsWith(prefix)).sort()) {
    effects.push({ op: 'set', ref, path: [], before: { state: 'absent' }, value: next[ref]!.payload });
  }
  const logical = (image: JsonObject): JsonObject => {
    const payload = structuredClone(image.payload) as JsonObject;
    for (const mirror of ['clips', 'registry']) if (Object.hasOwn(payload, mirror)) {
      const config = payload.config as JsonObject;
      let value = payload[mirror];
      if (Object.hasOwn(config, mirror) && digest(config[mirror]) !== digest(value)) {
        expect(mirror).toBe('clips');
        expect(config[mirror] === null && Array.isArray(value) || value === null && Array.isArray(config[mirror])).toBe(true);
        if (Array.isArray(config[mirror])) value = config[mirror];
      }
      config[mirror] = value;
      delete payload[mirror];
    }
    return payload;
  };
  const topology = (image: JsonObject) => ['clips', 'registry'].map((key) => [Object.hasOwn(image.payload as object, key), Object.hasOwn((image.payload as JsonObject).config as object, key)]);
  if (digest(topology(old.parent!)) !== digest(topology(next.parent!))) effects.push({ op: 'set', ref: 'parent', path: [], before: nativeState(old.parent!.payload), value: next.parent!.payload });
  else walk('parent', [], nativeState(logical(old.parent!)), nativeState(logical(next.parent!)));
  for (const ref of Object.keys(old).filter((ref) => ref !== 'parent' && next[ref]).sort()) walk(ref, [], nativeState(old[ref]!.payload), nativeState(next[ref]!.payload));
  for (const prefix of ['shot-revision:', 'internal-revision:']) for (const ref of Object.keys(old).filter((ref) => !next[ref] && ref.startsWith(prefix)).sort()) {
    effects.push({ op: 'remove', ref, path: [], before: nativeState(old[ref]!.payload) });
  }
  return effects;
}

async function nativeUndoContext(harness: DirectHarness, seed: ThreeProductsSeed, before: CanonicalDocument,
  restored: CanonicalDocument, priorHistory: HistoryPage, targetPublication: string): Promise<NativeUndoContext> {
  const current = await history(harness, seed);
  const readback = await canonicalAt(harness, seed, current.head.revision_id);
  assertClosure(readback, harness, seed);
  return { before, restored, priorHistory, targetPublication, history: current, readback };
}

function nativeUndoExpected(post: CommitPost, context: NativeUndoContext): { data: JsonObject; records: JsonObject } {
  const { before, restored, targetPublication, priorHistory } = context;
  const target = priorHistory.items.find((entry) => entry.publication_id === targetPublication)!;
  expect(target, 'authenticated target history captured before Undo').toBeTruthy();
  expect(target.intent).toBe('recorded');
  expect(target.receipt.receipt_id).toBe(targetPublication);
  expect(object(target.receipt.result, 'authenticated target result').accepted_revision_id).toBe(target.revision_id);
  expect(target.records!.steps).toHaveLength(1);
  const sources = target.records!.commands as unknown as JsonObject[];
  const sourceStep = target.records!.steps![0]!;
  const base = { revision_id: post.body.base_revision_id, publication_id: post.body.base_publication_id };
  expect(priorHistory.head).toEqual(base);
  expect(before.parent_revision.revision_id).toBe(base.revision_id);
  const submitted = post.body.steps![0]!;
  const boundary = { base_revision_id: base.revision_id, base_publication_id: base.publication_id,
    evaluated_head: base, step_id: submitted.id, command_ordinal: 0, phase: 'input' };
  const reads: JsonObject[] = [], selections: JsonObject[] = [], bindings: JsonObject[] = [];
  const unique = (items: JsonObject[], value: JsonObject) => { if (!items.some((item) => digest(item) === digest(value))) items.push(value); };
  const read = (ref: string, path: string[]) => unique(reads, { ref, path, state: nativeValue(before, ref, path) });
  const select = (key: string, owner: string) => {
    const selected = nativeSelection(before, key, owner);
    if (selections.some((item) => digest(item) === digest(selected))) return;
    if (key.startsWith('collection.')) {
      const kind = key.slice('collection.'.length, -1);
      read(`${owner}/collection:${kind}`, []);
      if (owner !== 'parent') {
        read(owner, ['occurrence_id']); read(`${owner}/shot`, ['shot_id']);
        const site = nativeSite(before, owner, []);
        bindings.push({ key: `collection.owner:${key}`, policy: 'fixed', dependencies: [],
          ...nativeBinding(before, owner, site.ref, boundary), path: site.path });
      }
    }
    selections.push(selected);
  };
  // inverse.apply_inverse first captures restoration-order selections, then all historical reads/selections.
  const collections = sources.flatMap((source) => (source.writes as JsonObject[]).filter((write) => !(write.path as string[]).length
    && /\/(clip|track):/.test(String(write.ref))).map((write) => String(write.ref).slice(0, String(write.ref).indexOf(':', String(write.ref).indexOf('/') + 1))));
  for (const collection of [...new Set(collections)].sort()) {
    const split = collection.lastIndexOf('/');
    select(`collection.${collection.slice(split + 1)}s`, collection.slice(0, split));
  }
  for (const source of sources) {
    for (const item of source.reads as JsonObject[]) read(item.ref as string, item.path as string[]);
    for (const item of source.selections as JsonObject[]) select((item.key as string).replace(/\.after$/, ''), item.owner as string);
  }
  const writes = [...sources].reverse().flatMap((source) => [...source.writes as JsonObject[]].reverse().map((write) => ({
    ref: write.ref, path: write.path, before: structuredClone(write.after), after: structuredClone(write.before),
  })));
  expect(writes.length).toBeGreaterThan(0);
  for (const write of writes) {
    read(write.ref as string, write.path as string[]);
    // These four cases restore existing fields or remove creations, never recreate a removed root.
    if (!(write.path as string[]).length && (write.before as JsonObject).state === 'absent') throw new Error('P2 native oracle scope question: inverse recreation needs allocation provenance');
  }
  const derived: JsonObject[] = [];
  const clipWrites = writes.filter((write) => String(write.ref).startsWith('parent/clip:'));
  const parent = before.parent_revision.payload as unknown as JsonObject;
  if (Array.isArray(parent.clips) && digest(parent.clips) === digest((parent.config as JsonObject).clips) && clipWrites.length) {
    // Each mounted target has one native parent clip write. Multiple sequential mirror stages require additional independent boundaries.
    expect(clipWrites, 'P2 native oracle scope: one parent clip write per mounted target').toHaveLength(1);
    const first = nativeValue(before, 'parent', ['config', 'clips']), last = nativeValue(restored, 'parent', ['config', 'clips']);
    if (digest(first) !== digest(last)) derived.push({ ref: 'parent', path: ['config', 'clips'], before: first, after: last, cause: 0 });
  }
  const guards: JsonObject = {}, authorship: JsonObject = {};
  for (const write of writes) {
    const path = (write.path as string[]).map((token, i) => /^[A-Za-z_][\w-]*$/.test(token) ? `${i ? '.' : ''}${token}` : `[${JSON.stringify(token)}]`).join('');
    guards[`${write.ref}::${path}`] = nativeValue(before, write.ref as string, write.path as string[]);
    authorship[`${write.ref}::${path}`] = 'direct';
  }
  const command = { schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
    args: { publications: [targetPublication] }, intent: {}, resolved: [], expect: guards, authorship,
    reads, selections, bindings: Object.fromEntries(bindings.map((binding) => [binding.key, binding.ref])), created: [] };
  const dependencies: JsonObject[] = [];
  for (const item of reads) {
    if (item.ref === 'parent/collection:asset' && !item.path.length) {
      for (const dependency of nativeAssetReads(before)) unique(dependencies, dependency);
      continue;
    }
    const site = nativeSite(before, item.ref as string, item.path as string[]);
    if (String(item.ref).includes('/collection:')) {
      const image = nativeImages(before)[site.ref]!;
      const value = nativeState(image.payload, site.path).value;
      const ids = Array.isArray(value) ? value.map((row) => row.id ?? row.occurrence_id) as string[] : null;
      unique(dependencies, ids ? { kind: 'collection', ...site, members: [...ids].sort(), order: ids } : { kind: 'scope', ref: site.ref, path: [] });
    } else unique(dependencies, !site.path.length ? { kind: 'scope', ...site } : { kind: 'field', ...site, state: item.state });
  }
  const effects = nativeEffects(before, restored);
  const step = { ...submitted, patch: effects, dependencies };
  bindings.push({ key: 'inverse.stage', ref: 'parent', policy: 'fixed', dependencies: [], boundary: {
    publication_id: targetPublication, step_id: sourceStep.id, command_ordinals: sourceStep.command_ordinals,
    native_write_range: [0, writes.length], effect_range: [0, effects.length],
  } });
  for (const [index, effect] of effects.entries()) for (const [side, document] of [['before', before], ['after', restored]] as const) {
    const ref = effect.ref as string;
    if (nativeImages(document)[ref]) bindings.push({ ...nativeBinding(document, ref, ref, { ...boundary, phase: 'effect', side }),
      key: 'commit.effect', policy: 'fixed', dependencies: [], path: effect.path, step_id: submitted.id, effect_ordinal: index });
  }
  // _hydrate loads retained exact pins in manifest order; Recording.compile_inputs records them for an inverse.
  const pins = before.dependency_manifest.documents.filter((pin) => restored.dependency_manifest.documents.some((item) => digest(item) === digest(pin)));
  expect(pins).toEqual(restored.dependency_manifest.documents);
  const compilerInputs = pins.map((pin) => ({ key: `compile.document:${digest(pin)}`,
    kind: pin.document_id.startsWith('transcript:') ? 'transcript' : 'source', pin, policy: 'exact' }));
  const record = { ordinal: 0, command, writes, reads, selections, bindings, created: [], dependencies: compilerInputs, derived_writes: derived };
  return {
    data: { status: 'accepted', base_revision_id: base.revision_id, base_publication_id: base.publication_id,
      previous_revision_id: base.revision_id, previous_publication_id: base.publication_id,
      accepted_revision_id: restored.parent_revision.revision_id, rebased_onto: null, canonical_document: restored,
      document_digest: digest(restored), commands: [command], id_map: {}, provider_version: target.provider_version,
      compiler_version: target.compiler_version, publisher: target.publisher, label: 'Undo timeline', source: { via: 'app' },
      merge_mode: 'fields', steps: [step] },
    records: { schema_version: 1, commands: [record], undo_of: [targetPublication], restored_from: null,
      label: 'Undo timeline', steps: [step], merge_mode: 'fields', undo_steps: null },
  };
}

function digest(value: unknown): string {
  const json = JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item);
  return sha256Hex(new TextEncoder().encode(json));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : item);
}

function materializedIdentity(kind: string, ...parts: unknown[]): string {
  const encoded = [kind, ...parts.map((part) => canonicalJson(part))].join('\0');
  return `${kind}-${sha256Hex(new TextEncoder().encode(encoded)).slice('sha256:'.length)}`;
}

async function revisionBody(harness: DirectHarness, seed: ThreeProductsSeed, revisionId: string): Promise<JsonObject> {
  const response = await harness.runtimeJson<JsonObject>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/composition-revisions/${revisionId}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

async function canonicalAt(harness: DirectHarness, seed: ThreeProductsSeed, revisionId: string): Promise<CanonicalDocument> {
  const parent = await revisionBody(harness, seed, revisionId);
  const manifest = object(parent.dependency_manifest, 'canonical dependency manifest');
  const shots = await Promise.all((manifest.shots as Array<JsonObject>).map(async (pin) => {
    const response = await harness.runtimeJson<JsonObject>('GET', `/v1/projects/${harness.seed.projectId}/shots/${String(pin.shot_id)}/revisions/${String(pin.revision_id)}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { ...pin, payload: response.body.payload };
  }));
  const internals = await Promise.all((manifest.internal_timelines as Array<JsonObject>).map(async (pin) => {
    const response = await harness.runtimeJson<JsonObject>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/revisions/${String(pin.revision_id)}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return { ...pin, payload: response.body.payload };
  }));
  return {
    schema_version: 1,
    project_id: harness.seed.projectId,
    timeline_id: seed.timelineId,
    parent_revision: { revision_id: String(parent.revision_id), content_digest: String(parent.content_digest), payload: parent.payload as CanonicalDocument['parent_revision']['payload'] },
    shot_revisions: shots as CanonicalDocument['shot_revisions'],
    internal_timeline_revisions: internals as CanonicalDocument['internal_timeline_revisions'],
    dependency_manifest: manifest as CanonicalDocument['dependency_manifest'],
  };
}

async function history(harness: DirectHarness, seed: ThreeProductsSeed): Promise<HistoryPage> {
  const items: HistoryEntry[] = [];
  let cursor: string | null = null;
  let head: HeadPin | undefined;
  do {
    const response: { status: number; body: HistoryPage } = await harness.runtimeJson<HistoryPage>('GET', `/v1/projects/${harness.seed.projectId}/timelines/${seed.timelineId}/commits?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    head ??= response.body.head;
    expect(response.body.head).toEqual(head);
    items.push(...response.body.items);
    cursor = response.body.next_cursor;
  } while (cursor);
  expect(head).toBeTruthy();
  return { items, head: head!, next_cursor: null };
}

function clip(document: CanonicalDocument, id: string): JsonObject {
  const payload = document.parent_revision.payload as unknown as JsonObject;
  const row = (payload.clips as Array<JsonObject>).find((candidate) => candidate.id === id);
  expect(row, `parent clip ${id}`).toBeTruthy();
  return row!;
}

function internal(document: CanonicalDocument): JsonObject {
  expect(document.internal_timeline_revisions).toHaveLength(1);
  return document.internal_timeline_revisions[0]!.payload as JsonObject;
}

function assertClosure(document: CanonicalDocument, harness: DirectHarness, seed: ThreeProductsSeed): void {
  expect(document.schema_version).toBe(1);
  expect(document.project_id).toBe(harness.seed.projectId);
  expect(document.timeline_id).toBe(seed.timelineId);
  expect(document.parent_revision.content_digest).toBe(digest(document.parent_revision.payload));
  for (const shot of document.shot_revisions) expect(shot.content_digest).toBe(digest(shot.payload));
  for (const timeline of document.internal_timeline_revisions) expect(timeline.content_digest).toBe(digest(timeline.payload));
  for (const pin of document.dependency_manifest.shots) {
    const shot = document.shot_revisions.find((candidate) => candidate.revision_id === pin.revision_id);
    expect(shot, `manifest shot ${pin.revision_id}`).toBeTruthy();
    expect(pin.content_digest).toBe(shot!.content_digest);
  }
  for (const pin of document.dependency_manifest.internal_timelines) {
    const timeline = document.internal_timeline_revisions.find((candidate) => candidate.revision_id === pin.revision_id);
    expect(timeline, `manifest internal ${pin.revision_id}`).toBeTruthy();
    expect(pin.content_digest).toBe(timeline!.content_digest);
  }
}

function wireFor(page: Page): Wire {
  const wire: Wire = { posts: [], legacy: [] };
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (!['GET', 'HEAD'].includes(request.method()) && (LEGACY_WRITES.test(pathname) || pathname.includes('/composition-revisions') || pathname.includes('/doorlog'))) {
      wire.legacy.push(`${request.method()} ${pathname}`);
    }
  });
  return wire;
}

async function commitFromGesture(page: Page, wire: Wire, gesture: () => Promise<void>): Promise<CommitPost> {
  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && COMMITS.test(new URL(response.url()).pathname), CEILING);
  await gesture();
  const response = await responsePromise;
  const request = response.request();
  const post: CommitPost = {
    request,
    response,
    body: request.postDataJSON() as CommitRequest,
    json: await response.json(),
    key: request.headers()['idempotency-key'] ?? '',
  };
  wire.posts.push(post);
  return post;
}

async function openTimeline(page: Page, harness: DirectHarness, seed: ThreeProductsSeed): Promise<void> {
  await harness.enableTimelineAuthoring(ASTRID_PYTHON);
  await page.goto(`${harness.origin}/tools/video-editor`);
  await expect(page.locator('[data-testid="runtime-connection-status"]')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByRole('combobox', { name: 'Select project' })).toContainText(harness.seed.projectName);
  await expect(page.getByRole('textbox', { name: 'Track name' }).first()).toBeVisible();
  expect(seed.timelineId).toBe(harness.seed.timelineId);
}

function assertRequestV2(post: CommitPost, before: HeadPin, scope: { project_id: string; timeline_id: string }, targetPublication?: string): void {
  expect(post.key).toMatch(/\S/);
  if (post.body.commands[0]?.op === 'timeline.inverse') {
    if (!targetPublication) throw new Error('Native Undo request requires its independently captured target publication');
    expect(post.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Object.keys(post.body).sort()).toEqual([
      'api_version', 'base_publication_id', 'base_revision_id', 'commands', 'dry_run',
      'label', 'merge', 'project_id', 'reads', 'source', 'steps', 'timeline_id',
    ].sort());
    expect(post.body.api_version).toBe(1);
    expect(post.body.project_id).toBe(scope.project_id);
    expect(post.body.timeline_id).toBe(scope.timeline_id);
    expect(post.body.base_revision_id).toBe(before.revision_id);
    expect(post.body.base_publication_id).toBe(before.publication_id);
    expect(post.body.label).toBe('Undo timeline');
    expect(post.body.merge).toBe('fields');
    expect(post.body.reads).toEqual([]);
    expect(post.body.dry_run).toBe(false);
    expect(post.body.source).toEqual({ via: 'app' });
    expect(post.body.commands).toHaveLength(1);
    const command = object(post.body.commands[0], 'native inverse command');
    expect(Object.keys(command).sort()).toEqual(['args', 'op', 'schema_version', 'select', 'version'].sort());
    expect(command).toEqual({
      schema_version: 1,
      op: 'timeline.inverse',
      version: '1',
      select: null,
      args: { publications: [targetPublication] },
    });
    expect(post.body.steps).toHaveLength(1);
    const step = object(post.body.steps![0], 'native inverse step');
    expect(Object.keys(step).sort()).toEqual(['command_ordinals', 'id', 'intent', 'label', 'patch', 'tags'].sort());
    expect(step.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(step.id).not.toBe(post.key);
    expect(step.label).toBe('Undo timeline');
    expect(step.intent).toBe('Undo timeline');
    expect(step.tags).toEqual([]);
    expect(step.command_ordinals).toEqual([0]);
    expect(step.patch).toEqual([]);
    return;
  }
  expect(post.body.api_version).toBe(1);
  expect(post.body.project_id).toBe(scope.project_id);
  expect(post.body.timeline_id).toBe(scope.timeline_id);
  expect(post.body.base_revision_id).toBe(before.revision_id);
  expect(post.body.base_publication_id).toBe(before.publication_id);
  expect(Array.isArray(post.body.commands)).toBe(true);
  expect(typeof post.body.label).toBe('string');
  expect(Array.isArray(post.body.steps)).toBe(true);
  expect(post.body.merge).toBe('atomic');
  expect(post.body.dry_run).toBe(false);
  expect(post.body.source).toEqual({ via: 'app' });
  expect(Object.hasOwn(post.body, 'reads')).toBe(false);
  expect(post.body.commands.length).toBeGreaterThan(0);
  for (const key of ['rationale', 'group_id'] as const) {
    if (Object.hasOwn(post.body, key)) expect(post.body[key]).toEqual(expect.any(String));
  }
  expect(post.body.steps!.length).toBeGreaterThan(0);
  for (const step of post.body.steps!) {
    expect(step.id).toEqual(expect.any(String));
    expect(step.label).toEqual(expect.any(String));
    expect(step.intent).toEqual(expect.any(String));
    expect(step.tags).toEqual(expect.any(Array));
    expect(step.command_ordinals.length).toBeGreaterThan(0);
    expect(step.patch).toEqual(expect.any(Array));
    expect(step.patch.length).toBeGreaterThan(0);
    expect(Object.hasOwn(step, 'reads')).toBe(false);
  }
}

function assertAcceptedReply(post: CommitPost, before: HeadPin, native?: NativeUndoContext): CommitAcceptedMutation {
  if (post.body.commands[0]?.op === 'timeline.inverse') {
    if (!native) throw new Error('Native Undo requires independent before/target/restored/history/readback inputs');
    return assertNativeAcceptedReply(post, before, native);
  }
  expect(post.response.status(), JSON.stringify(post.json)).toBe(200);
  const envelope = object(post.json, 'commit envelope');
  const data = object(envelope.data, 'commit data');
  expect(['accepted', 'merged', 'rebased']).toContain(data.status);
  expect(data.base_revision_id).toBe(before.revision_id);
  expect(data.base_publication_id).toBe(before.publication_id);
  expect(data.previous_revision_id).toBe(before.revision_id);
  expect(data.previous_publication_id).toBe(before.publication_id);
  expect(data.accepted_revision_id).toEqual(expect.any(String));
  expect(data.canonical_document).toEqual(expect.any(Object));
  expect(data.document_digest).toEqual(expect.any(String));
  expect(data.commands).toEqual(expect.any(Array));
  expect(data.commands).toHaveLength(post.body.commands.length);
  for (const [ordinal, submitted] of post.body.commands.entries()) {
    const accepted = (data.commands as Array<JsonObject>)[ordinal]!;
    for (const [key, value] of Object.entries(submitted as unknown as JsonObject)) expect(accepted[key], `normalized command ${ordinal}.${key}`).toEqual(value);
  }
  expect(data.label).toBe(post.body.label);
  for (const key of ['rationale', 'group_id'] as const) {
    if (Object.hasOwn(post.body, key)) expect(data[key]).toEqual(post.body[key]);
  }
  expect(data.id_map).toEqual(expect.any(Object));
  expect(data.provider_version).toEqual(expect.any(String));
  expect(data.compiler_version).toEqual(expect.any(String));
  expect(data.publisher).toEqual(expect.any(String));
  expect(data.merge_mode).toBe(post.body.merge);
  expect(data.steps).toEqual(expect.any(Array));
  expect(data.steps).toHaveLength(post.body.steps!.length);
  for (const [ordinal, submitted] of post.body.steps!.entries()) {
    expect((data.steps as Array<JsonObject>)[ordinal]).toMatchObject({
      id: submitted.id,
      label: submitted.label,
      intent: submitted.intent,
      tags: submitted.tags,
      command_ordinals: submitted.command_ordinals,
    });
  }
  expect(data.source).toEqual(post.body.source);
  const receipt = object(envelope.receipt, 'commit receipt');
  expect(receipt.receipt_id).toEqual(expect.any(String));
  expect(receipt.receipt_id).not.toBe(post.key);
  expect(receipt.idempotency_key).toBe(post.key);
  expect(receipt.result).toEqual(envelope.data);
  expect(Object.keys(receipt).sort()).toEqual(['command_kind', 'created_at', 'event_ids', 'idempotency_key', 'project_id', 'project_seq', 'receipt_id', 'request_hash', 'result'].sort());
  return envelope as unknown as CommitAcceptedMutation;
}

function assertNativeAcceptedReply(post: CommitPost, before: HeadPin, context: NativeUndoContext): CommitAcceptedMutation {
  assertRequestV2(post, before, { project_id: context.before.project_id, timeline_id: context.before.timeline_id }, context.targetPublication);
  expect(post.response.status(), JSON.stringify(post.json)).toBe(200);
  const expected = nativeUndoExpected(post, context);
  const envelope = exactKeys(post.json, ['data', 'receipt'], 'native commit envelope');
  expect(envelope.data).toEqual(expected.data);
  expect(context.readback).toEqual(context.restored);
  expect((envelope.data as JsonObject).canonical_document).toEqual(context.readback);
  expect((envelope.data as JsonObject).document_digest).toBe(digest(context.readback));
  const entry = context.history.items.find((item) => item.receipt.idempotency_key === post.key)!;
  expect(entry, 'independent authenticated history read for this request key').toBeTruthy();
  const receipt = exactKeys(envelope.receipt, ['command_kind', 'created_at', 'event_ids', 'idempotency_key',
    'project_id', 'project_seq', 'receipt_id', 'request_hash', 'result'], 'native commit receipt');
  expect(receipt).toEqual(entry.receipt);
  expect(receipt.result).toEqual(expected.data);
  expect(receipt.command_kind).toBe('timeline.commit');
  expect(receipt.project_id).toBe(context.before.project_id);
  expect(receipt.idempotency_key).toBe(post.key);
  expect(receipt.receipt_id).toBe(context.history.head.publication_id);
  expect(receipt.receipt_id).not.toBe(post.key);
  expect(context.priorHistory.items.some((item) => item.publication_id === receipt.receipt_id)).toBe(false);
  expect(receipt.request_hash).toBe(digest({ operation: 'commitTimeline',
    path: `/v1/projects/${post.body.project_id}/timelines/${post.body.timeline_id}/commit`,
    publisher: expected.data.publisher, request: post.body }).slice('sha256:'.length));
  expect(receipt.event_ids).toHaveLength(1);
  const seq = receipt.project_seq as number[];
  expect(seq).toEqual([seq[0], seq[0]]);
  expect(seq[0]).toBeGreaterThan(Math.max(...context.priorHistory.items.map((item) => item.receipt.project_seq[1])));
  assertNativeHistoryEntry(context.history, post, envelope as unknown as CommitAcceptedMutation, context);
  return envelope as unknown as CommitAcceptedMutation;
}

function acceptedMutation(post: CommitPost): CommitAcceptedMutation {
  return post.json as CommitAcceptedMutation;
}

function publicationId(post: CommitPost): string {
  return acceptedMutation(post).receipt.receipt_id;
}

function assertCanonicalResult(result: CommitAcceptedMutation, actual: CanonicalDocument, harness: DirectHarness, seed: ThreeProductsSeed): void {
  const document = result.data.canonical_document;
  assertClosure(document, harness, seed);
  expect(document.parent_revision.revision_id).toBe(result.data.accepted_revision_id);
  expect(result.data.document_digest).toBe(digest(document));
  expect(actual).toEqual(document);
}

function assertHistoryEntry(page: HistoryPage, post: CommitPost, result: CommitAcceptedMutation, native?: NativeUndoContext): void {
  if (post.body.commands[0]?.op === 'timeline.inverse') {
    if (!native) throw new Error('Native history requires independently captured Undo inputs');
    assertNativeHistoryEntry(page, post, result, native);
    return;
  }
  const publication = result.receipt.receipt_id;
  expect(publication).not.toBe(post.key);
  expect(page.head).toEqual({ revision_id: result.data.accepted_revision_id, publication_id: publication });
  const entry = page.items.find((candidate) => candidate.publication_id === publication);
  expect(entry, 'commit is recorded in /commits').toBeTruthy();
  expect(entry!.intent).toBe('recorded');
  expect(entry!.records).not.toBeNull();
  expect(entry!.publication_id).toBe(publication);
  expect(entry!.revision_id).toBe(result.data.accepted_revision_id);
  expect(entry!.receipt).toEqual(result.receipt);
  expect(entry!.label).toBe(post.body.label);
  expect(entry!.merge_mode).toBe(result.data.merge_mode);
  expect(entry!.source).toEqual(post.body.source);
  expect(entry!.steps).toEqual(result.data.steps);
  expect(entry!.records!.commands.map((record) => record.command)).toEqual(result.data.commands);
  expect(entry!.records!.undo_steps).toBeDefined();
  for (const step of entry!.records!.steps ?? []) {
    expect(step.patch.length).toBeGreaterThan(0);
    expect(step.dependencies?.length).toBeGreaterThan(0);
  }
  for (const record of entry!.records!.commands) {
    expect(record.writes.length).toBeGreaterThan(0);
    expect(record.reads.length).toBeGreaterThan(0);
    expect(record.bindings.length).toBeGreaterThan(0);
    expect(record.dependencies).toEqual(expect.any(Array));
    expect(record.derived_writes).toEqual(expect.any(Array));
  }
}

function assertNativeHistoryEntry(page: HistoryPage, post: CommitPost, result: CommitAcceptedMutation, context: NativeUndoContext): void {
  const expected = nativeUndoExpected(post, context);
  const publication = result.receipt.receipt_id;
  const previous = context.priorHistory.head;
  expect(page.head).toEqual({ revision_id: context.restored.parent_revision.revision_id, publication_id: publication });
  expect(page.next_cursor).toBeNull();
  expect(page.items.filter((item) => item.publication_id !== publication)).toEqual(context.priorHistory.items);
  expect(page.items).toHaveLength(context.priorHistory.items.length + 1);
  const entry = page.items.find((item) => item.publication_id === publication);
  expect(entry).toEqual({ publication_id: publication, revision_id: context.restored.parent_revision.revision_id,
    previous, receipt: result.receipt, intent: 'recorded', records: expected.records,
    provider_version: expected.data.provider_version, compiler_version: expected.data.compiler_version,
    publisher: expected.data.publisher, source: { via: 'app' }, label: 'Undo timeline', merge: 'fields',
    merge_mode: 'fields', reads: [], steps: expected.data.steps, recorder_abi: 2 });
}

function assertUndoHistoryEntry(page: HistoryPage, undo: CommitPost, target: CommitPost, context: NativeUndoContext): void {
  expect(context.targetPublication).toBe(publicationId(target));
  const original = context.priorHistory.items.find((entry) => entry.publication_id === context.targetPublication)!;
  expect(original.receipt).toEqual(acceptedMutation(target).receipt);
  expect(original.receipt.idempotency_key).toBe(target.key);
  const result = assertNativeAcceptedReply(undo, context.priorHistory.head, context);
  assertNativeHistoryEntry(page, undo, result, context);
}

function assertNoLegacy(wire: Wire): void {
  expect(wire.legacy, 'mounted edits do not write old routes').toEqual([]);
}

function assertParentListIsolation(
  before: CanonicalDocument,
  after: CanonicalDocument,
  newId?: string,
  changedId?: string,
  changedField?: string,
  changedConfigKeys: string[] = [],
): void {
  const beforeParent = before.parent_revision.payload as unknown as JsonObject;
  const afterParent = after.parent_revision.payload as unknown as JsonObject;
  const beforeClips = beforeParent.clips as Array<JsonObject>;
  const afterClips = afterParent.clips as Array<JsonObject>;
  expect(afterClips.map((row) => row.id).filter((id) => id !== newId)).toEqual(beforeClips.map((row) => row.id));
  for (const row of beforeClips) {
    const next = afterClips.find((candidate) => candidate.id === row.id)!;
    if (row.id === changedId && changedField) {
      expect({ ...next, [changedField]: undefined }).toEqual({ ...row, [changedField]: undefined });
    } else expect(next).toEqual(row);
  }
  const beforeConfig = object(beforeParent.config, 'parent config');
  const afterConfig = object(afterParent.config, 'updated parent config');
  expect(afterConfig.clips).toEqual(afterClips);
  expect(Object.fromEntries(Object.entries(afterConfig).filter(([key]) => key !== 'clips' && !changedConfigKeys.includes(key))))
    .toEqual(Object.fromEntries(Object.entries(beforeConfig).filter(([key]) => key !== 'clips' && !changedConfigKeys.includes(key))));
}

// C0 §2: occurrence.add-media materializes one complete physical closure. The
// expected closure is derived from the original document, intended row/media,
// and the native provider's deterministic identity rules, never from `after`.
function assertOccurrenceParentProjection(
  before: CanonicalDocument,
  after: CanonicalDocument,
  result: CommitAcceptedMutation,
  occurrenceId: string,
  intendedRow: JsonObject,
  source: { objectId: string; digest: string; mediaType: string; generationId: string; variantId: string },
): void {
  const beforeParent = before.parent_revision.payload as unknown as JsonObject;
  const afterParent = after.parent_revision.payload as unknown as JsonObject;
  const beforeOccurrences = beforeParent.occurrences as Array<JsonObject>;
  const beforeOccurrence = beforeOccurrences.filter((candidate) => candidate.occurrence_id === occurrenceId);
  expect(beforeOccurrence).toHaveLength(1);
  const originalOccurrence = beforeOccurrence[0]!;
  expect(typeof originalOccurrence.shot_id).toBe('string');
  expect(typeof originalOccurrence.shot_revision_id).toBe('string');
  expect(beforeOccurrences.filter((candidate) => candidate.shot_id === originalOccurrence.shot_id)).toHaveLength(1);
  expect(intendedRow.id).toEqual(expect.any(String));
  expect(intendedRow.asset).toEqual(expect.any(String));
  expect(intendedRow.id).not.toBe('');
  expect(intendedRow.asset).not.toBe('');
  expect(source.objectId).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(source.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  const mediaKind = source.mediaType.split('/')[0];
  expect(['image', 'video']).toContain(mediaKind);

  const beforeShot = before.shot_revisions.filter((image) => image.revision_id === originalOccurrence.shot_revision_id);
  expect(beforeShot).toHaveLength(1);
  const originalShot = beforeShot[0]!;
  expect(originalShot.shot_id).toBe(originalOccurrence.shot_id);
  const beforeChild = before.internal_timeline_revisions.filter(
    (image) => image.revision_id === originalShot.internal_timeline_revision_id,
  );
  expect(beforeChild).toHaveLength(1);
  const originalChild = beforeChild[0]!;
  expect(originalShot.payload.internal_timeline_revision_id).toBe(originalChild.revision_id);
  expect(originalChild.timeline_id).toBe(before.timeline_id);

  const expectedChildPayload = structuredClone(originalChild.payload) as unknown as JsonObject;
  const originalRows = expectedChildPayload.clips;
  expect(Array.isArray(originalRows)).toBe(true);
  expect((originalRows as Array<JsonObject>).some((candidate) => candidate.id === intendedRow.id)).toBe(false);
  (expectedChildPayload.clips as Array<JsonObject>).push(structuredClone(intendedRow));
  const registry = object(expectedChildPayload.registry, 'original child registry');
  const assets = object(registry.assets, 'original child assets');
  expect(Object.hasOwn(assets, intendedRow.asset as string)).toBe(false);
  const normalizedMedia = {
    media_id: source.objectId,
    type: mediaKind,
    generationId: source.generationId,
    variantId: source.variantId,
  };
  expectedChildPayload.registry = { ...registry, assets: { ...assets, [intendedRow.asset as string]: normalizedMedia } };

  const expectedInternalRevisionId = materializedIdentity(
    'authoring-timeline-revision', before.project_id, before.timeline_id, originalShot.shot_id, expectedChildPayload,
  );
  const expectedShotPayload = { ...structuredClone(originalShot.payload) as unknown as JsonObject,
    internal_timeline_revision_id: expectedInternalRevisionId };
  const expectedShotRevisionId = materializedIdentity(
    'authoring-shot-revision', before.project_id, originalShot.shot_id, expectedShotPayload,
  );
  const expectedChild = { ...originalChild, revision_id: expectedInternalRevisionId,
    payload: expectedChildPayload, content_digest: digest(expectedChildPayload) };
  const expectedShot = { ...originalShot, revision_id: expectedShotRevisionId,
    internal_timeline_revision_id: expectedInternalRevisionId, payload: expectedShotPayload,
    content_digest: digest(expectedShotPayload) };
  expect(expectedShotRevisionId).not.toBe(originalShot.revision_id);
  expect(expectedInternalRevisionId).not.toBe(originalChild.revision_id);

  const expectedParent = structuredClone(beforeParent);
  const expectedOccurrence = (expectedParent.occurrences as Array<JsonObject>)
    .find((candidate) => candidate.occurrence_id === occurrenceId)!;
  expectedOccurrence.shot_revision_id = expectedShotRevisionId;
  expect(afterParent).toEqual(expectedParent);
  expect(after.parent_revision.payload).toEqual(expectedParent);

  const replace = <T extends JsonObject>(items: T[], oldId: string, replacement: T): T[] => {
    expect(items.filter((item) => item.revision_id === oldId)).toHaveLength(1);
    return items.map((item) => item.revision_id === oldId ? replacement : item);
  };
  const expectedShots = replace(before.shot_revisions as unknown as JsonObject[], originalShot.revision_id, expectedShot as unknown as JsonObject);
  const expectedChildren = replace(before.internal_timeline_revisions as unknown as JsonObject[], originalChild.revision_id, expectedChild as unknown as JsonObject);
  expect(after.shot_revisions).toEqual(expectedShots);
  expect(after.internal_timeline_revisions).toEqual(expectedChildren);
  expect(after.shot_revisions.filter((image) => image.revision_id === expectedShotRevisionId)).toHaveLength(1);
  expect(after.internal_timeline_revisions.filter((image) => image.revision_id === expectedInternalRevisionId)).toHaveLength(1);
  expect(after.shot_revisions.filter((image) => image.shot_id === originalShot.shot_id)).toHaveLength(1);
  expect(after.internal_timeline_revisions.filter((image) => image.timeline_id === originalChild.timeline_id)).toHaveLength(1);

  const expectedPatch = [
    { op: 'set', ref: `internal-revision:${expectedInternalRevisionId}`, path: [], before: { state: 'absent' }, value: expectedChildPayload },
    { op: 'set', ref: `shot-revision:${expectedShotRevisionId}`, path: [], before: { state: 'absent' }, value: expectedShotPayload },
    { op: 'set', ref: 'parent', path: ['occurrences', `occurrence_id:${occurrenceId}`, 'shot_revision_id'],
      before: { state: 'present', value: originalShot.revision_id }, value: expectedShotRevisionId },
    { op: 'remove', ref: `shot-revision:${originalShot.revision_id}`, path: [], before: { state: 'present', value: originalShot.payload } },
    { op: 'remove', ref: `internal-revision:${originalChild.revision_id}`, path: [], before: { state: 'present', value: originalChild.payload } },
  ];
  expect(result.data.steps).toHaveLength(1);
  expect(result.data.steps![0]!.patch).toEqual(expectedPatch);
  expect(result.data.canonical_document).toEqual(after);
  expect(result.data.document_digest).toBe(digest(after));
  expect(result.data.accepted_revision_id).toBe(after.parent_revision.revision_id);

  const beforeManifest = object(before.dependency_manifest, 'original dependency manifest');
  const afterManifest = object(after.dependency_manifest, 'updated dependency manifest');
  expect(afterManifest).toEqual({
    ...beforeManifest,
    shots: expectedShots.map((image) => ({ shot_id: image.shot_id, revision_id: image.revision_id,
      internal_timeline_revision_id: image.internal_timeline_revision_id, content_digest: image.content_digest })),
    internal_timelines: expectedChildren.map((image) => ({ timeline_id: image.timeline_id, revision_id: image.revision_id,
      content_digest: image.content_digest })),
  });
  expect(afterManifest.media).toEqual(beforeManifest.media);
  expect(afterManifest.media).toContainEqual({ media_id: source.objectId, content_digest: source.digest });
  expect(after.parent_revision.content_digest).toBe(digest(expectedParent));
  for (const image of after.shot_revisions) expect(image.content_digest).toBe(digest(image.payload));
  for (const image of after.internal_timeline_revisions) expect(image.content_digest).toBe(digest(image.payload));
}

async function seedImageFile(harness: DirectHarness): Promise<{ name: string; type: string; bytesBase64: string }> {
  const response = await harness.runtimeFetch(`/v1/objects/${encodeURIComponent(harness.seed.image.objectId)}`);
  expect(response.status).toBe(200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(bytes.byteLength).toBe(harness.seed.image.size);
  expect(sha256Hex(bytes)).toBe(harness.seed.image.digest);
  return { name: 'p2-mounted-image.png', type: harness.seed.image.mediaType, bytesBase64: Buffer.from(bytes).toString('base64') };
}

function assertMediaManifestIdentity(
  before: CanonicalDocument,
  after: CanonicalDocument,
  source: { objectId: string; digest: string },
): void {
  const beforeManifest = object(before.dependency_manifest, 'original dependency manifest');
  const afterManifest = object(after.dependency_manifest, 'updated dependency manifest');
  const beforeMedia = beforeManifest.media as Array<JsonObject>;
  expect(afterManifest.media).toEqual(beforeMedia);
  expect((afterManifest.media as Array<JsonObject>)).toContainEqual({
    media_id: source.objectId,
    content_digest: source.digest,
  });
}

function projectedPlacementClipId(occurrenceId: string, rawClipId: unknown): string {
  expect(occurrenceId).toEqual(expect.any(String));
  expect(rawClipId).toEqual(expect.any(String));
  expect(rawClipId).not.toBe('');
  return `${occurrenceId}:${String(rawClipId)}`;
}

function projectedPlacementClipIdForRow(occurrenceId: string, row: JsonObject): string {
  expect(row.id).toEqual(expect.any(String));
  return projectedPlacementClipId(occurrenceId, row.id);
}

interface MountedPlacementIdentity {
  clipId: string;
  occurrenceId: string;
  rawClipId: string;
  physicalRef: string;
  payloadDigest: string;
}

function assertMountedPlacementIdentity(
  mounted: MountedPlacementIdentity[],
  occurrenceId: string,
  rawClipId: string,
  payloadDigest: string,
  present: boolean,
): void {
  const expected = {
    clipId: projectedPlacementClipId(occurrenceId, rawClipId),
    occurrenceId,
    rawClipId,
    physicalRef: `occurrence:${occurrenceId}`,
    payloadDigest,
  };
  const rawMatches = mounted.filter((candidate) => candidate.rawClipId === rawClipId);
  expect(rawMatches).toHaveLength(present ? 1 : 0);
  if (present) {
    expect(rawMatches[0]).toEqual(expected);
    expect(mounted.filter((candidate) => candidate.clipId === expected.clipId)).toHaveLength(1);
  } else {
    expect(mounted.filter((candidate) => candidate.clipId === expected.clipId)).toHaveLength(0);
  }
}

async function dropFileIn(scope: Locator, file: { name: string; type: string; bytesBase64: string }, occurrenceId: string, clipId: string, referenceId: string, from: number, referenceAt: number, time: number): Promise<void> {
  const clipLocator = scope.locator(`.clip-action[data-clip-id="${occurrenceId}:${clipId}"]`).first();
  const referenceLocator = scope.locator(`.clip-action[data-clip-id="${occurrenceId}:${referenceId}"]`).first();
  const wrapper = scope.locator('.timeline-wrapper').first();
  await expect(clipLocator).toBeVisible();
  await expect(referenceLocator).toBeVisible();
  const [clipBox, referenceBox, wrapperBox] = await Promise.all([clipLocator.boundingBox(), referenceLocator.boundingBox(), wrapper.boundingBox()]);
  if (!clipBox || !referenceBox || !wrapperBox) throw new Error('child timeline is not measurable');
  const pixelsPerSecond = (referenceBox.x - clipBox.x) / (referenceAt - from);
  const clientX = timelineFileDropClientX({ clipLeft: clipBox.x, from, time, pixelsPerSecond });
  const clientY = clipBox.y + clipBox.height / 2;
  expect(clientX).toBeGreaterThanOrEqual(wrapperBox.x);
  expect(clientX).toBeLessThanOrEqual(wrapperBox.x + wrapperBox.width);
  await wrapper.evaluate((target, input) => {
    const binary = atob(input.bytesBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], input.name, { type: input.type }));
    for (const eventType of ['dragover', 'drop'] as const) {
      target.dispatchEvent(new DragEvent(eventType, { bubbles: true, cancelable: true, clientX: input.clientX, clientY: input.clientY, dataTransfer: transfer }));
    }
  }, { ...file, clientX, clientY });
}

async function assertReload(
  page: Page,
  harness: DirectHarness,
  seed: ThreeProductsSeed,
  revisionId: string,
  expected: CanonicalDocument,
  assertMounted: () => Promise<void>,
): Promise<void> {
  await page.reload();
  await expect(page.locator('[data-testid="runtime-connection-status"]')).toHaveAttribute('data-state', 'connected');
  await expect(page.getByRole('textbox', { name: 'Track name' }).first()).toBeVisible();
  await expect(page.getByTestId('preview-revision-label').filter({ hasText: `Committed ${revisionId}` }).first()).toBeVisible(CEILING);
  const current = await history(harness, seed);
  expect(current.head.revision_id).toBe(revisionId);
  const reread = await canonicalAt(harness, seed, current.head.revision_id);
  assertClosure(reread, harness, seed);
  expect(reread).toEqual(expected);
  await assertMounted();
}

test('P2 mounted element edit: real catalog apply, exact params patch, reload and guarded Undo', async ({ page, harness, seed3 }) => {
  await openTimeline(page, harness, seed3);
  const wire = wireFor(page);
  const beforeHistory = await history(harness, seed3);
  const original = await canonicalAt(harness, seed3, beforeHistory.head.revision_id);
  await page.locator(`.clip-action[data-clip-id="${seed3.appClipId}"]`).first().click();

  const apply = await commitFromGesture(page, wire, async () => {
    await page.getByRole('button', { name: 'Elements', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('Search elements').fill('am-burst');
    await expect(dialog.getByText('AM Burst', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('applied');
  });
  assertRequestV2(apply, beforeHistory.head, { project_id: harness.seed.projectId, timeline_id: seed3.timelineId });
  expect(apply.body.commands[0]!.op).toBe('doc.patch');
  expect((apply.body.commands[0]!.args.changes as Array<JsonObject>).some((change) => change.op === 'list.insert')).toBe(true);
  const applied = assertAcceptedReply(apply, beforeHistory.head);
  const appliedDocument = applied.data.canonical_document;
  const actualApplied = await canonicalAt(harness, seed3, applied.data.accepted_revision_id);
  assertCanonicalResult(applied, actualApplied, harness, seed3);
  assertClosure(appliedDocument, harness, seed3);
  const newElementClip = (appliedDocument.parent_revision.payload as unknown as JsonObject).clips as Array<JsonObject>;
  const originalIds = new Set(((original.parent_revision.payload as unknown as JsonObject).clips as Array<JsonObject>).map((row) => String(row.id)));
  const addedId = newElementClip.find((row) => !originalIds.has(String(row.id)))?.id as string | undefined;
  expect(addedId, 'catalog apply creates a mounted clip').toEqual(expect.any(String));
  expect(clip(appliedDocument, addedId!)).toMatchObject({ elementRef: { id: 'am-burst', kind: 'effect', packId: 'astrid_motion' } });
  assertParentListIsolation(original, appliedDocument, addedId);
  const appliedHistory = await history(harness, seed3);
  assertHistoryEntry(appliedHistory, apply, applied);
  assertNoLegacy(wire);

  const beforeParams = await history(harness, seed3);
  const paramsBase = await canonicalAt(harness, seed3, beforeParams.head.revision_id);
  await page.locator(`.clip-action[data-clip-id="${addedId}"]`).first().click();
  await expect(page.getByTestId('astrid-element-params')).toBeVisible();
  const bob = page.getByRole('spinbutton').first();
  await expect(bob).toBeVisible();
  const paramsCommit = await commitFromGesture(page, wire, async () => {
    await bob.fill('12');
    await bob.press('Enter');
    await bob.blur();
  });
  assertRequestV2(paramsCommit, beforeParams.head, { project_id: harness.seed.projectId, timeline_id: seed3.timelineId });
  expect(paramsCommit.body.commands[0]!.op).toBe('doc.patch');
  const paramsChanges = paramsCommit.body.commands[0]!.args.changes as Array<JsonObject>;
  expect(paramsChanges).toHaveLength(1);
  expect(paramsChanges[0]).toMatchObject({ op: 'set', ref: 'parent', path: ['clips', `id:${addedId}`, 'params'] });
  const paramsResult = assertAcceptedReply(paramsCommit, beforeParams.head);
  const paramsDocument = paramsResult.data.canonical_document;
  assertCanonicalResult(paramsResult, await canonicalAt(harness, seed3, paramsResult.data.accepted_revision_id), harness, seed3);
  assertParentListIsolation(paramsBase, paramsDocument, undefined, addedId, 'params');
  expect((clip(paramsDocument, addedId!).params as JsonObject).bob).toBe(12);
  const paramsHistory = await history(harness, seed3);
  assertHistoryEntry(paramsHistory, paramsCommit, paramsResult);
  await assertReload(page, harness, seed3, paramsResult.data.accepted_revision_id, paramsDocument, async () => {
    await page.locator(`.clip-action[data-clip-id="${addedId}"]`).first().click();
    await expect(page.getByTestId('astrid-element-params')).toBeVisible();
    await expect(page.getByRole('spinbutton').first()).toHaveValue('12');
  });

  const undo = await commitFromGesture(page, wire, async () => {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
  });
  assertRequestV2(undo, { revision_id: paramsResult.data.accepted_revision_id, publication_id: paramsResult.receipt.receipt_id }, { project_id: harness.seed.projectId, timeline_id: seed3.timelineId }, publicationId(paramsCommit));
  expect(undo.body.commands[0]).toEqual({ schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: [paramsResult.receipt.receipt_id] } });
  const paramsUndoContext = await nativeUndoContext(harness, seed3, paramsDocument, paramsBase, paramsHistory, paramsResult.receipt.receipt_id);
  const undoneParams = assertAcceptedReply(undo, paramsHistory.head, paramsUndoContext);
  assertCanonicalResult(undoneParams, paramsUndoContext.readback, harness, seed3);
  expect(undoneParams.data.canonical_document.parent_revision.payload).toEqual(paramsBase.parent_revision.payload);
  assertNoLegacy(wire);
  assertUndoHistoryEntry(paramsUndoContext.history, undo, paramsCommit, paramsUndoContext);
  const restoredBob = (clip(paramsBase, addedId!).params as JsonObject).bob;
  await assertReload(page, harness, seed3, undoneParams.data.accepted_revision_id, paramsBase, async () => {
    await page.locator(`.clip-action[data-clip-id="${addedId}"]`).first().click();
    await expect(page.getByTestId('astrid-element-params')).toBeVisible();
    await expect(page.getByRole('spinbutton').first()).toHaveValue(String(restoredBob));
  });

  const undoApply = await commitFromGesture(page, wire, async () => {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
  });
  const applyUndoContext = await nativeUndoContext(harness, seed3, paramsUndoContext.readback, original, paramsUndoContext.history, applied.receipt.receipt_id);
  const undoneApply = assertAcceptedReply(undoApply, paramsUndoContext.history.head, applyUndoContext);
  assertCanonicalResult(undoneApply, applyUndoContext.readback, harness, seed3);
  expect(undoneApply.data.canonical_document.parent_revision.payload).toEqual(original.parent_revision.payload);
  assertNoLegacy(wire);
  assertUndoHistoryEntry(applyUndoContext.history, undoApply, apply, applyUndoContext);
  await assertReload(page, harness, seed3, undoneApply.data.accepted_revision_id, original, async () => {
    await expect(page.locator(`.clip-action[data-clip-id="${addedId}"]`)).toHaveCount(0);
  });
});

test('P2 mounted registerAsset save: real file drop, exact media/registry fields, reload and guarded Undo', async ({ page, harness, seed3 }) => {
  await openTimeline(page, harness, seed3);
  const wire = wireFor(page);
  const before = await history(harness, seed3);
  const original = await canonicalAt(harness, seed3, before.head.revision_id);
  const file = await seedImageFile(harness);
  const importResponse = page.waitForResponse((response) => response.request().method() === 'POST' && /\/media-imports$/.test(new URL(response.url()).pathname), CEILING);
  const selectionResponse = page.waitForResponse((response) => response.request().method() === 'GET' && /\/media-selection\?/.test(new URL(response.url()).pathname + new URL(response.url()).search), CEILING);
  const post = await commitFromGesture(page, wire, () => dropFileOnTimeline(page, file, seed3.appClipId, seed3.transitionClipId, 0, THREE_PRODUCTS_REFERENCE_AT, 5));
  const imported = object((await (await importResponse).json()).data, 'registered media import');
  const mediaEvidence = mediaImportEvidenceFromProducer(file, {
    objectId: harness.seed.image.objectId,
    digest: harness.seed.image.digest,
    mediaType: harness.seed.image.mediaType,
  }, imported);
  const selected = await selectionResponse.then((response) => response.json()) as JsonObject;
  assertMediaImportSelectionIdentity(selected, imported, mediaEvidence.source);
  const expectedRow = await expectedImageDropRow(original, 'parent', String(selected.asset), 'V1', 5);
  assertSemanticAddMediaRequest(post, before.head, original, {
    op: 'clip.add-media', owner: 'parent', select: 'parent', label: 'Add media', row: expectedRow, media: selected,
  });
  const command = post.body.commands[0]!;
  expect(command.op).toBe('clip.add-media');
  expect(command.select).toBe('parent');
  expect(command.intent).toEqual({});
  expect(command.args.media).toEqual(selected);
  expect(selected.object_id).toBe(harness.seed.image.objectId);
  assertRawMediaImportEntry(imported.entry, mediaEvidence.rawEntry);
  const row = command.args.row as JsonObject;
  expect(row).toStrictEqual(expectedRow);
  expect(row.asset).toEqual(expect.any(String));
  expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['asset_id', 'media_id', 'object_id', 'clip_type', 'source', 'sourceURL', 'sourceUrl', 'source_url']));
  const result = assertAcceptedReply(post, before.head);
  const after = result.data.canonical_document;
  assertCanonicalResult(result, await canonicalAt(harness, seed3, result.data.accepted_revision_id), harness, seed3);
  assertParentListIsolation(original, after, row.id as string);
  const afterParent = after.parent_revision.payload as unknown as JsonObject;
  const beforeParent = original.parent_revision.payload as unknown as JsonObject;
  const beforeConfig = object(beforeParent.config, 'original config');
  const afterConfig = object(afterParent.config, 'updated config');
  expect(Object.hasOwn(beforeConfig, 'registry')).toBe(false);
  expect(Object.hasOwn(afterConfig, 'registry')).toBe(false);
  const beforeRegistry = object(beforeParent.registry, 'original parent registry');
  const afterRegistry = object(afterParent.registry, 'updated parent registry');
  const beforeAssets = object(beforeRegistry.assets, 'original assets');
  const afterAssets = object(afterRegistry.assets, 'updated assets');
  expect(Object.keys(afterAssets).filter((key) => !Object.hasOwn(beforeAssets, key))).toEqual([row.asset]);
  assertNormalizedCatalogueEntry(afterAssets[row.asset as string], mediaEvidence.source);
  expect(Object.fromEntries(Object.entries(afterAssets).filter(([key]) => Object.hasOwn(beforeAssets, key)))).toEqual(beforeAssets);
  expect(afterRegistry).toEqual({ ...beforeRegistry, assets: afterAssets });
  assertMediaManifestIdentity(original, after, mediaEvidence.source);
  const committed = await history(harness, seed3);
  assertHistoryEntry(committed, post, result);
  assertNoLegacy(wire);
  await assertReload(page, harness, seed3, result.data.accepted_revision_id, after, async () => {
    await expect(page.locator(`.clip-action[data-clip-id="${row.id as string}"]`)).toBeVisible();
  });
  const undo = await commitFromGesture(page, wire, async () => { await page.getByRole('button', { name: 'Undo', exact: true }).click(); });
  assertRequestV2(undo, { revision_id: result.data.accepted_revision_id, publication_id: result.receipt.receipt_id }, { project_id: harness.seed.projectId, timeline_id: seed3.timelineId }, publicationId(post));
  expect(undo.body.commands[0]).toEqual({ schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: [result.receipt.receipt_id] } });
  const undoContext = await nativeUndoContext(harness, seed3, after, original, committed, result.receipt.receipt_id);
  const undone = assertAcceptedReply(undo, committed.head, undoContext);
  assertCanonicalResult(undone, undoContext.readback, harness, seed3);
  expect(undone.data.canonical_document.parent_revision.payload).toEqual(original.parent_revision.payload);
  assertNoLegacy(wire);
  assertUndoHistoryEntry(undoContext.history, undo, post, undoContext);
  await assertReload(page, harness, seed3, undone.data.accepted_revision_id, original, async () => {
    await expect(page.locator(`.clip-action[data-clip-id="${row.id as string}"]`)).toHaveCount(0);
    await expect(page.locator(`.clip-action[data-clip-id="${seed3.appClipId}"]`).first()).toBeVisible();
  });
});

function placementPublicationId(post: CommitPost): string {
  const envelope = object(post.json, 'placement commit envelope');
  const receipt = object(envelope.receipt, 'placement commit receipt');
  expect(receipt.receipt_id).toEqual(expect.any(String));
  expect(receipt.receipt_id).not.toBe(post.key);
  expect(receipt.idempotency_key).toBe(post.key);
  return receipt.receipt_id as string;
}

placementTest('P2 mounted automatic child placement: embedded shot file gesture, occurrence command, closure and guarded Undo', async ({ page, harness, seed3 }) => {
  await openTimeline(page, harness, seed3);
  const wire = wireFor(page);
  const before = await history(harness, seed3);
  const original = await canonicalAt(harness, seed3, before.head.revision_id);
  const file = await seedImageFile(harness);
  const dialog = await openEmbeddedCanonicalShot(page, seed3.occurrenceId, 'F2 agent shot');
  const importResponse = page.waitForResponse((response) => response.request().method() === 'POST' && /\/media-imports$/.test(new URL(response.url()).pathname), CEILING);
  const selectionResponse = page.waitForResponse((response) => response.request().method() === 'GET' && /\/media-selection\?/.test(new URL(response.url()).pathname + new URL(response.url()).search), CEILING);
  const post = await commitFromGesture(page, wire, () => dropFileIn(dialog, file, seed3.occurrenceId, seed3.agentClipId, seed3.agentClearClipId, 3, 6, 4.5));
  const imported = object((await (await importResponse).json()).data, 'child media import');
  const mediaEvidence = mediaImportEvidenceFromProducer(file, {
    objectId: harness.seed.image.objectId,
    digest: harness.seed.image.digest,
    mediaType: harness.seed.image.mediaType,
  }, imported);
  const selected = await selectionResponse.then((response) => response.json()) as JsonObject;
  assertMediaImportSelectionIdentity(selected, imported, mediaEvidence.source);
  const expectedRow = await expectedImageDropRow(original, `occurrence:${seed3.occurrenceId}`, String(selected.asset), 'V2', 4.5);
  assertSemanticAddMediaRequest(post, before.head, original, {
    op: 'occurrence.add-media', owner: `occurrence:${seed3.occurrenceId}`, select: `occurrence:${seed3.occurrenceId}`,
    label: 'Edit shot timeline', row: expectedRow, media: selected,
  });
  const command = post.body.commands[0]!;
  expect(command.op).toBe('occurrence.add-media');
  expect(command.select).toBe(`occurrence:${seed3.occurrenceId}`);
  expect(command.intent).toEqual({ ownership: 'occurrence' });
  expect(command.args.media).toEqual(selected);
  expect(selected.object_id).toBe(harness.seed.image.objectId);
  assertRawMediaImportEntry(imported.entry, mediaEvidence.rawEntry);
  const row = command.args.row as JsonObject;
  expect(row).toStrictEqual(expectedRow);
  const result = assertAcceptedReply(post, before.head);
  const placementPublication = placementPublicationId(post);
  const after = result.data.canonical_document;
  assertCanonicalResult(result, await canonicalAt(harness, seed3, result.data.accepted_revision_id), harness, seed3);
  const beforeInternal = internal(original);
  const afterInternal = internal(after);
  const beforeRows = beforeInternal.clips as Array<JsonObject>;
  const afterRows = afterInternal.clips as Array<JsonObject>;
  expect(afterRows.filter((candidate) => !beforeRows.some((known) => known.id === candidate.id))).toEqual([expect.objectContaining(row)]);
  for (const known of beforeRows) expect(afterRows.find((candidate) => candidate.id === known.id)).toEqual(known);
  expect(afterRows.map((candidate) => candidate.id)).toEqual([...beforeRows.map((candidate) => candidate.id), row.id]);
  assertOccurrenceParentProjection(original, after, result, seed3.occurrenceId, row, mediaEvidence.source);
  const beforeChildRegistry = object(beforeInternal.registry, 'original child registry');
  const afterChildRegistry = object(afterInternal.registry, 'child registry');
  const beforeChildAssets = object(beforeChildRegistry.assets, 'original child assets');
  const childRegistry = object(afterChildRegistry.assets, 'child assets');
  expect(Object.keys(childRegistry).filter((key) => !Object.hasOwn(beforeChildAssets, key))).toEqual([row.asset]);
  expect(Object.fromEntries(Object.entries(childRegistry).filter(([key]) => Object.hasOwn(beforeChildAssets, key)))).toEqual(beforeChildAssets);
  assertNormalizedCatalogueEntry(childRegistry[row.asset as string], mediaEvidence.source);
  expect(afterChildRegistry).toEqual({ ...beforeChildRegistry, assets: childRegistry });
  assertMediaManifestIdentity(original, after, mediaEvidence.source);
  // The mounted child projection scopes an authored clip id to its selected physical occurrence.
  // Derive this expected identity from the canonical placement row, independently of the DOM.
  const projectedPlacementClipId = projectedPlacementClipIdForRow(seed3.occurrenceId, row);
  const committed = await history(harness, seed3);
  assertHistoryEntry(committed, post, result);
  assertNoLegacy(wire);
  await assertReload(page, harness, seed3, result.data.accepted_revision_id, after, async () => {
    const reloadedDialog = await openEmbeddedCanonicalShot(page, seed3.occurrenceId, 'F2 agent shot');
    await expect(reloadedDialog.locator(`.clip-action[data-clip-id="${projectedPlacementClipId}"]`)).toHaveCount(1);
    await expect(reloadedDialog.locator(`.clip-action[data-clip-id="${row.id as string}"]`)).toHaveCount(0);
    await reloadedDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(reloadedDialog).toHaveCount(0);
  });
  const undo = await commitFromGesture(page, wire, async () => { await page.getByRole('button', { name: 'Undo', exact: true }).click(); });
  assertRequestV2(undo, { revision_id: result.data.accepted_revision_id, publication_id: placementPublication }, { project_id: harness.seed.projectId, timeline_id: seed3.timelineId }, publicationId(post));
  expect(undo.body.commands[0]).toEqual({ schema_version: 1, op: 'timeline.inverse', version: '1', select: null, args: { publications: [placementPublication] } });
  const undoContext = await nativeUndoContext(harness, seed3, after, original, committed, placementPublication);
  const placementExpectedRecords = (post: CommitPost, context: NativeUndoContext, expected: { data: JsonObject; records: JsonObject }): JsonObject => {
    const target = context.priorHistory.items.find((item) => item.publication_id === context.targetPublication)!;
    const materializations = target.records!.commands.flatMap((record) => record.bindings)
      .filter((binding) => binding.key === 'commit.materialization');
    expect(materializations).toHaveLength(2);
    const sourceChild = nativeChild(context.restored, `occurrence:${seed3.occurrenceId}`);
    const successorChild = nativeChild(context.before, `occurrence:${seed3.occurrenceId}`);
    const sourceShot = `shot-revision:${sourceChild.shot.revision_id}`;
    const successorShot = `shot-revision:${successorChild.shot.revision_id}`;
    const sourceInternal = `internal-revision:${sourceChild.child.revision_id}`;
    const successorInternal = `internal-revision:${successorChild.child.revision_id}`;
    const base = { revision_id: post.body.base_revision_id, publication_id: post.body.base_publication_id };
    const submitted = post.body.steps![0]!;
    const boundary = { base_revision_id: base.revision_id, base_publication_id: base.publication_id,
      evaluated_head: base, step_id: submitted.id, command_ordinal: 0, phase: 'input' };
    const owner = `occurrence:${seed3.occurrenceId}/shot`;
    const bindings = [
      { ...nativeBinding(context.before, successorShot, successorShot, boundary), key: 'commit.materialization', policy: 'fixed', dependencies: [],
        successor: sourceShot, owner, edge_before: successorInternal, edge_after: sourceInternal, step_id: submitted.id },
      { ...nativeBinding(context.before, successorInternal, successorInternal, boundary), key: 'commit.materialization', policy: 'fixed', dependencies: [],
        successor: sourceInternal, owner, edge_before: successorShot, edge_after: sourceShot, step_id: submitted.id },
    ];
    expect(bindings).toHaveLength(2);
    const command = expected.records.commands[0]!;
    return { ...expected.records, commands: [{ ...command, bindings: [...command.bindings, ...bindings] }] };
  };
  const assertPlacementNativeHistoryEntry = (page: HistoryPage, post: CommitPost, result: CommitAcceptedMutation, context: NativeUndoContext): void => {
    const expected = nativeUndoExpected(post, context);
    const publication = result.receipt.receipt_id;
    const previous = context.priorHistory.head;
    expect(page.head).toEqual({ revision_id: context.restored.parent_revision.revision_id, publication_id: publication });
    expect(page.next_cursor).toBeNull();
    expect(page.items.filter((item) => item.publication_id !== publication)).toEqual(context.priorHistory.items);
    expect(page.items).toHaveLength(context.priorHistory.items.length + 1);
    const entry = page.items.find((item) => item.publication_id === publication);
    expect(entry).toEqual({ publication_id: publication, revision_id: context.restored.parent_revision.revision_id,
      previous, receipt: result.receipt, intent: 'recorded', records: placementExpectedRecords(post, context, expected),
      provider_version: expected.data.provider_version, compiler_version: expected.data.compiler_version,
      publisher: expected.data.publisher, source: { via: 'app' }, label: 'Undo timeline', merge: 'fields',
      merge_mode: 'fields', reads: [], steps: expected.data.steps, recorder_abi: 2 });
  };
  const assertPlacementNativeAcceptedReply = (post: CommitPost, before: HeadPin, context: NativeUndoContext): CommitAcceptedMutation => {
    assertRequestV2(post, before, { project_id: context.before.project_id, timeline_id: context.before.timeline_id }, context.targetPublication);
    expect(post.response.status(), JSON.stringify(post.json)).toBe(200);
    const expected = nativeUndoExpected(post, context);
    const envelope = exactKeys(post.json, ['data', 'receipt'], 'native commit envelope');
    expect(envelope.data).toEqual(expected.data);
    expect(context.readback).toEqual(context.restored);
    expect((envelope.data as JsonObject).canonical_document).toEqual(context.readback);
    expect((envelope.data as JsonObject).document_digest).toBe(digest(context.readback));
    const entry = context.history.items.find((item) => item.receipt.idempotency_key === post.key)!;
    expect(entry, 'independent authenticated history read for this request key').toBeTruthy();
    const receipt = exactKeys(envelope.receipt, ['command_kind', 'created_at', 'event_ids', 'idempotency_key',
      'project_id', 'project_seq', 'receipt_id', 'request_hash', 'result'], 'native commit receipt');
    expect(receipt).toEqual(entry.receipt);
    expect(receipt.result).toEqual(expected.data);
    expect(receipt.command_kind).toBe('timeline.commit');
    expect(receipt.project_id).toBe(context.before.project_id);
    expect(receipt.idempotency_key).toBe(post.key);
    expect(receipt.receipt_id).toBe(context.history.head.publication_id);
    expect(receipt.receipt_id).not.toBe(post.key);
    expect(context.priorHistory.items.some((item) => item.publication_id === receipt.receipt_id)).toBe(false);
    expect(receipt.request_hash).toBe(digest({ operation: 'commitTimeline',
      path: `/v1/projects/${post.body.project_id}/timelines/${post.body.timeline_id}/commit`,
      publisher: expected.data.publisher, request: post.body }).slice('sha256:'.length));
    expect(receipt.event_ids).toHaveLength(1);
    const seq = receipt.project_seq as number[];
    expect(seq).toEqual([seq[0], seq[0]]);
    expect(seq[0]).toBeGreaterThan(Math.max(...context.priorHistory.items.map((item) => item.receipt.project_seq[1])));
    assertPlacementNativeHistoryEntry(context.history, post, envelope as unknown as CommitAcceptedMutation, context);
    return envelope as unknown as CommitAcceptedMutation;
  };
  const assertPlacementUndoHistoryEntry = (page: HistoryPage, undo: CommitPost, target: CommitPost, context: NativeUndoContext): void => {
    expect(context.targetPublication).toBe(publicationId(target));
    const original = context.priorHistory.items.find((entry) => entry.publication_id === context.targetPublication)!;
    expect(original.receipt).toEqual(acceptedMutation(target).receipt);
    expect(original.receipt.idempotency_key).toBe(target.key);
    const result = assertPlacementNativeAcceptedReply(undo, context.priorHistory.head, context);
    assertPlacementNativeHistoryEntry(page, undo, result, context);
  };
  const undone = assertPlacementNativeAcceptedReply(undo, committed.head, undoContext);
  assertCanonicalResult(undone, undoContext.readback, harness, seed3);
  expect(undone.data.canonical_document.parent_revision.payload).toEqual(original.parent_revision.payload);
  expect(undone.data.canonical_document.shot_revisions).toEqual(original.shot_revisions);
  expect(undone.data.canonical_document.internal_timeline_revisions).toEqual(original.internal_timeline_revisions);
  assertNoLegacy(wire);
  assertPlacementUndoHistoryEntry(undoContext.history, undo, post, undoContext);
  await assertReload(page, harness, seed3, undone.data.accepted_revision_id, original, async () => {
    const reloadedDialog = await openEmbeddedCanonicalShot(page, seed3.occurrenceId, 'F2 agent shot');
    await expect(reloadedDialog.locator(`.clip-action[data-clip-id="${projectedPlacementClipId}"]`)).toHaveCount(0);
  });
});

import type { AgentDependency, AgentState, CommandRecord, EditCommand, JSON } from '@/integrations/runtime/timeline-commit-types.ts';

type ObjectValue = { [key: string]: JSON };

// Internal main authoring_bundle shape, not a Runtime wire document or a display projection.
export type AuthoredBundle = ObjectValue & {
  parent: ObjectValue;
  placements: ObjectValue[];
  shots: Record<string, ObjectValue & { internal_timeline: ObjectValue }>;
};

export class ClipMoveError extends Error {
  constructor(message: string, readonly kind = 'invalid_edit_command') {
    super(message);
  }
}
export const copy = <T>(value: T): T => structuredClone(value);
export const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
export const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function assertFiniteJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) {
    throw new ClipMoveError('capture values must be finite JSON');
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== null && Object.getPrototypeOf(prototype) !== null) {
    throw new ClipMoveError('capture values must be finite JSON');
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) assertFiniteJson(value[index], ancestors);
  } else {
    for (const child of Object.values(value)) assertFiniteJson(child, ancestors);
  }
  ancestors.delete(value);
}

export function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeJson);
    Object.freeze(value);
  }
  return value;
}
const active = (row: ObjectValue): boolean => row.enabled !== false && row.active !== false &&
  !['disabled', 'hidden', 'deleted'].some((key) => row[key] === true);
const AUDIO_KINDS = new Set(['audio', 'vo', 'music', 'sfx', 'voice', 'voiceover']);

// The synchronous gesture port needs main's SHA-256 authoring IDs before drop.
// WebCrypto is asynchronous; this hashes only the small identity/pin strings.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const rotate = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

function sha256(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, bytes.length * 8);
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15], b = words[i - 2];
      words[i] = words[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + words[i - 7] +
        (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const first = h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + words[i];
      const second = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      [a, b, c, d, e, f, g, h] = [(first + second) >>> 0, a, b, c, (d + first) >>> 0, e, f, g];
    }
    [a, b, c, d, e, f, g, h].forEach((value, i) => { hash[i] = (hash[i] + value) >>> 0; });
  }
  return hash.map((value) => value.toString(16).padStart(8, '0')).join('');
}

export function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  }
  if (object(a) && object(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
      keys.every((key) => has(b, key) && equal(a[key], b[key]));
  }
  return a === b;
}

function one(rows: JSON, key: string, id: string, optional = false): ObjectValue | undefined {
  if (!Array.isArray(rows)) throw new ClipMoveError('entity collection must be an array');
  const matches = rows.filter((row): row is ObjectValue => object(row) && row[key] === id);
  if (matches.length === 1) return matches[0];
  if (optional && matches.length === 0) return undefined;
  throw new ClipMoveError(`missing or ambiguous identity ${id}`, 'identity_conflict');
}

export class AuthoredState {
  constructor(readonly bundle: AuthoredBundle) {}

  isolatedOwner(owner: string, source: string): string {
    return 'shot-placement-' + sha256(
      ['shot-placement', ...[this.bundle.project_id, this.bundle.timeline_id, this.occurrence(owner).occurrence_id, source]
        .map((part) => JSON.stringify(part))].join('\0'));
  }

  occurrence(owner: string): ObjectValue {
    return one(this.bundle.placements, 'occurrence_id', owner.slice('occurrence:'.length))!;
  }

  config(owner: string): ObjectValue {
    if (owner === 'parent') return this.bundle.parent.config as ObjectValue ?? {};
    const row = this.occurrence(owner);
    const shot = this.bundle.shots[String(row.shot_id)];
    if (!shot || !object(shot.internal_timeline)) throw new ClipMoveError('missing authored owner');
    return shot.internal_timeline;
  }

  entity(ref: string, optional = false): ObjectValue | undefined {
    if (ref.includes('/asset:')) {
      const [owner, identity] = ref.split('/asset:');
      const registry = this.config(owner).registry;
      if (!object(registry) || !object(registry.assets)) throw new ClipMoveError('asset collection must be an object');
      const entry = has(registry.assets, identity) ? registry.assets[identity] : undefined;
      if (entry === undefined && optional) return undefined;
      if (!object(entry)) throw new ClipMoveError('missing or invalid asset binding', 'identity_conflict');
      return entry;
    }
    if (ref.includes('/clip:') || ref.includes('/track:')) {
      const slash = ref.lastIndexOf('/');
      const owner = ref.slice(0, slash);
      const entity = ref.slice(slash + 1);
      const colon = entity.indexOf(':');
      const kind = entity.slice(0, colon);
      const id = entity.slice(colon + 1);
      const direct = this.bundle.parent.clips;
      const rows = owner === 'parent' && kind === 'clip'
        ? (Array.isArray(direct) && direct.length ? direct : this.config(owner).clips ?? direct ?? [])
        : this.config(owner)[`${kind}s`] ?? [];
      return one(rows, 'id', id, optional);
    }
    if (ref === 'parent') return this.bundle.parent;
    if (ref.endsWith('/registry')) {
      const owner = ref.slice(0, -'/registry'.length);
      const nested = this.config(owner).registry;
      if (owner !== 'parent') return nested as ObjectValue ?? {};
      const direct = this.bundle.parent.registry;
      for (const registry of [direct, nested]) {
        if (registry != null && (!object(registry) ||
          (has(registry, 'assets') && !object(registry.assets)))) {
          throw new ClipMoveError('invalid parent registry');
        }
      }
      if (direct != null && nested != null && !equal(direct, nested)) {
        throw new ClipMoveError('parent.registry conflicts with parent.config.registry');
      }
      return (direct ?? nested ?? { assets: {} }) as ObjectValue;
    }
    if (ref.endsWith('/source')) return this.config(ref.slice(0, -'/source'.length));
    if (ref.endsWith('/shot')) {
      const row = this.occurrence(ref.slice(0, -'/shot'.length));
      const mapping = this.bundle.source_mapping as ObjectValue;
      const sources = mapping.shots as ObjectValue;
      const source = (sources[String(row.shot_id)] as ObjectValue).shot_id;
      if (typeof source !== 'string') throw new ClipMoveError('missing occurrence source identity');
      const identity = this.isolatedOwner(ref.slice(0, -'/shot'.length), source);
      if (row.shot_id !== source && row.shot_id !== identity) {
        throw new ClipMoveError('occurrence authoring owner changed', 'identity_conflict');
      }
      return { shot_id: source };
    }
    if (ref.startsWith('occurrence:') && !ref.includes('/')) return this.occurrence(ref);
    throw new ClipMoveError(`unsupported entity reference ${ref}`);
  }

  get(ref: string, path: string[]): AgentState {
    if (ref.includes('/collection:')) {
      const [owner, kind] = ref.split('/collection:');
      if (path.length) throw new ClipMoveError('collection shape requires the whole guard');
      if (kind === 'occurrence' && owner === 'parent') return { state: 'present', value: { container: 'array' } };
      if (owner === 'parent' || !['clip', 'track'].includes(kind)) throw new ClipMoveError('unsupported collection shape');
      const config = this.config(owner);
      const field = `${kind}s`;
      return { state: 'present', value: { members: !has(config, field) ? { state: 'absent' }
        : { state: 'present', value: Array.isArray(config[field]) ? [] : object(config[field]) ? {} : config[field] } } };
    }
    const entity = this.entity(ref, true);
    if (entity === undefined) return { state: 'absent' };
    let value: JSON = entity;
    for (const key of path) {
      if (object(value) && has(value, key)) value = value[key];
      else if (Array.isArray(value) && /^\d+$/.test(key) && Number(key) < value.length) value = value[Number(key)];
      else return { state: 'absent' };
    }
    return { state: 'present', value: copy(value) };
  }

  matches(ref: string, path: string[], expected: AgentState): boolean {
    const actual = this.get(ref, path);
    if (equal(actual, expected)) return true;
    return ref.endsWith('/shot') && equal(path, ['shot_id']) && expected.state === 'present' &&
      actual.state === 'present' && typeof expected.value === 'string' &&
      actual.value === this.isolatedOwner(ref.slice(0, -'/shot'.length), expected.value);
  }

  set(ref: string, path: string[], state: AgentState): void {
    if (!path.length && (ref.includes('/asset:') || ref.includes('/clip:'))) {
      const slash = ref.lastIndexOf('/');
      const owner = ref.slice(0, slash);
      const entity = ref.slice(slash + 1);
      const colon = entity.indexOf(':');
      const kind = entity.slice(0, colon), identity = entity.slice(colon + 1);
      if (kind === 'asset') {
        const assets = (this.config(owner).registry as ObjectValue).assets as ObjectValue;
        if (state.state === 'absent') delete assets[identity];
        else if (object(state.value)) Object.defineProperty(assets, identity, { value: copy(state.value), enumerable: true, configurable: true, writable: true });
        else throw new ClipMoveError('asset binding must be an object');
      } else {
        const rows = this.config(owner).clips as ObjectValue[];
        const index = rows.findIndex((row) => row.id === identity);
        if (state.state === 'present') {
          if (!object(state.value) || state.value.id !== identity) throw new ClipMoveError('row identity differs from its reference');
          if (index < 0) rows.push(copy(state.value));
          else rows[index] = copy(state.value);
        } else if (index >= 0) rows.splice(index, 1);
      }
      return;
    }
    let target = this.entity(ref)!;
    for (const key of path.slice(0, -1)) {
      if (!has(target, key) || !object(target[key])) throw new ClipMoveError('write requires recorded container creation');
      target = target[key];
    }
    const key = path[path.length - 1];
    if (state.state === 'absent') delete target[key];
    else Object.defineProperty(target, key, {
      value: copy(state.value), enumerable: true, configurable: true, writable: true,
    });
  }
}

// These are the built-in Recording/selection primitives in Agent _recording.py.
// Metadata comes from executed reads/writes, including absent and unchanged writes.
export class MoveRecording {
  readonly state: AuthoredState;
  readonly command: EditCommand;
  readonly record: CommandRecord;

  constructor(bundle: AuthoredBundle, command: EditCommand) {
    this.state = new AuthoredState(copy(bundle));
    this.command = { ...copy(command), resolved: [command.select!], reads: [], selections: [],
      expect: {}, authorship: {}, bindings: {}, created: [] };
    this.record = { ordinal: 0, command: this.command, writes: [], reads: this.command.reads!,
      selections: this.command.selections!, bindings: [], created: [], dependencies: [], derived_writes: [] };
  }

  read(ref: string, path: string[]): JSON | undefined {
    const state = this.state.get(ref, path);
    const read = { ref, path, state };
    if (!this.command.reads!.some((other) => equal(read, other))) this.command.reads!.push(copy(read));
    return state.state === 'present' ? copy(state.value) : undefined;
  }

  select(key: 'move.target' | 'move.blockers' | 'collection.clips' | 'collection.tracks' | 'collection.occurrences' | 'placement.owners', owner: string, members: string[] = []): string[] {
    let result: string[];
    if (!['move.target', 'move.blockers', 'collection.clips', 'collection.tracks', 'collection.occurrences', 'placement.owners'].includes(key)) {
      throw new ClipMoveError('unsupported recorded query');
    }
    if (key.startsWith('collection.') || key === 'placement.owners') {
      const kind = key === 'collection.clips' ? 'clip' : key === 'collection.tracks' ? 'track' : 'occurrence';
      const rows = kind === 'occurrence' ? this.state.bundle.placements : this.state.config(owner)[`${kind}s`];
      if (!Array.isArray(rows) || rows.some((row) => !object(row))) throw new ClipMoveError('invalid authored collection');
      const identities = (rows as ObjectValue[]).map((row) => row[kind === 'occurrence' ? 'occurrence_id' : 'id']);
      if (new Set(identities).size !== identities.length || identities.some((id) => typeof id !== 'string' || !id || id.includes('/') || id.includes('::'))) {
        throw new ClipMoveError('missing or ambiguous collection identity', 'identity_conflict');
      }
      result = (rows as ObjectValue[]).filter((row) => key !== 'placement.owners' || row.shot_id === this.state.occurrence(owner).shot_id)
        .map((row) => kind === 'occurrence' ? `occurrence:${row.occurrence_id}` : `${owner}/${kind}:${row.id}`);
      const selected = { key, query_version: 1, owner, members: result, order: [...result],
        boundaries: key === 'placement.owners' ? ['shot:' + this.state.occurrence(owner).shot_id] : [...result], policy: 'guard-membership' as const };
      if (!this.command.selections!.some((other) => equal(other, selected))) {
        if (key.startsWith('collection.')) {
          this.read(owner + '/collection:' + kind, []);
          if (owner !== 'parent') {
            this.read(owner, ['occurrence_id']);
            this.read(owner + '/shot', ['shot_id']);
            this.bind('collection.owner:' + key, owner);
          }
        }
        this.command.selections!.push(selected);
      }
      return result;
    }
    if (key === 'move.target') result = members.filter((ref) => this.state.entity(ref, true) !== undefined);
    else {
      const row = this.state.occurrence(owner);
      const lane = object(row.placement) && has(row.placement, 'track') ? row.placement.track : row.track;
      const track = typeof lane === 'string' ? this.state.entity(`parent/track:${lane}`, true) : undefined;
      const output = !track || (!AUDIO_KINDS.has(String(track.kind)) && !AUDIO_KINDS.has(String(track.role)) && active(track));
      result = this.state.bundle.placements.filter((other) => {
        const otherLane = object(other.placement) && has(other.placement, 'track')
          ? other.placement.track : other.track;
        return output && active(other) && equal(lane, otherLane);
      }).map((other) => `occurrence:${other.occurrence_id}`);
    }
    this.command.selections!.push({ key, query_version: 1, owner, members: [...result],
      order: [...result], boundaries: [...result], policy: 'guard-membership' });
    return result;
  }

  bind(key: string, ref: string, dependencies: string[] = []): void {
    if (ref.includes('/clip:') || ref.includes('/track:') || (ref.startsWith('occurrence:') && !ref.includes('/'))) {
      this.command.bindings![key] = ref;
    }
    this.record.bindings.push({ key, ref, policy: 'fixed', dependencies });
  }

  dependency(key: string, kind: AgentDependency['kind'], pin: ObjectValue): void {
    this.record.dependencies.push({ key, kind, pin: copy(pin), policy: 'exact' });
  }

  create(owner: string, kind: 'clip' | 'asset', identity: string, value: ObjectValue): void {
    this.read(owner, ['occurrence_id']);
    this.read(owner + '/shot', ['shot_id']);
    if (kind === 'clip') {
      this.bind('create.owner', owner);
      this.select('collection.clips', owner);
    }
    const ref = `${owner}/${kind}:${identity}`;
    if (this.state.get(ref, []).state !== 'absent') throw new ClipMoveError('created identity is occupied', 'identity_collision');
    this.read(ref, []);
    this.write(ref, [], value);
    this.command.created!.push(ref);
    this.record.created.push({ ref, kind, owner });
  }

  compile(): void {
    const mapping = this.state.bundle.source_mapping as ObjectValue | undefined;
    const document = mapping?._runtime_document as ObjectValue | undefined;
    const manifest = document?.dependency_manifest as ObjectValue | undefined;
    const retained = manifest?.documents as JSON[] | undefined ?? [];
    for (const capture of mapping?.pinned_documents as ObjectValue[] | undefined ?? []) {
      const pin = capture.pin as ObjectValue;
      if (retained.some((other) => equal(pin, other))) {
        const canonical = JSON.stringify({ content_digest: pin.content_digest, document_id: pin.document_id, version: pin.version });
        this.dependency('compile.document:sha256:' + sha256(canonical),
          (capture.document as ObjectValue).kind === 'media.transcript' ? 'transcript' : 'source', pin);
      }
    }
    const parent = this.state.bundle.parent;
    const config = this.state.config('parent');
    if (Array.isArray(parent.clips) && parent.clips.length && Array.isArray(config.clips) && config.clips.length) {
      const before = this.state.get('parent', ['config', 'clips']);
      const after: AgentState = { state: 'present', value: copy(parent.clips) };
      if (!equal(before, after)) {
        this.record.derived_writes.push({ ref: 'parent', path: ['config', 'clips'], before, after, cause: 0 });
        this.state.set('parent', ['config', 'clips'], after);
      }
    }
  }

  assign(ref: string, path: string[], after: AgentState): void {
    const address = `${ref}::${path.join('.')}`;
    if (!has(this.command.expect!, address)) this.command.expect![address] = this.state.get(ref, path);
    this.command.authorship![address] = 'direct';
    this.record.writes.push({ ref, path: [...path], before: this.state.get(ref, path), after: copy(after) });
    this.state.set(ref, path, after);
  }

  write(ref: string, path: string[], value: JSON): void {
    this.assign(ref, path, { state: 'present', value });
  }

  clear(ref: string, path: string[]): void {
    this.assign(ref, path, { state: 'absent' });
  }

  object(ref: string, path: string[]): void {
    const state = this.state.get(ref, path);
    if (state.state === 'present' && object(state.value)) return;
    this.read(ref, path);
    if (state.state === 'present' && state.value !== null) throw new ClipMoveError('intent container must be object or null');
    this.write(ref, path, {});
  }
}

import type { AgentState, EditCommand, JSON } from '@/integrations/runtime/timeline-commit-types.ts';
import { stableOccurrenceDeepLink, stableOutputIdentity } from '../data/shotComposition.ts';
import { remapItems } from './authoringBundle.ts';
import {
  assertFiniteJson, ClipMoveError, copy, equal, freezeJson, has, MoveRecording, object,
  type AuthoredBundle,
} from './clipMovePrimitives.ts';

type ObjectValue = { [key: string]: JSON };
export type OccurrenceDuplicateArgs = { occurrence_id: string; shot_id: string };
export type OccurrenceDuplicateBasis = { readonly bundle: AuthoredBundle; readonly command: EditCommand };
const CLAIMS = ['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created'] as const;
const stableId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && !value.includes('/') && !value.includes('::');

// Keep this capture unit compatible with the refreshed base, whose shared
// primitive intentionally does not expose its synchronous authoring hash.
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

function canonicalJson(value: JSON): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function authoringIdentity(kind: string, ...parts: JSON[]): string {
  return `${kind}-${sha256([kind, ...parts.map(canonicalJson)].join('\0'))}`;
}

function destinationShotRevisionId(bundle: AuthoredBundle, shotId: string, value: ObjectValue): string {
  const internal = value.internal_timeline as JSON;
  const internalRevisionId = authoringIdentity(
    'authoring-timeline-revision', bundle.project_id, bundle.timeline_id, shotId, internal,
  );
  return authoringIdentity(
    'authoring-shot-revision', bundle.project_id, shotId,
    { ...(value.payload as ObjectValue), internal_timeline_revision_id: internalRevisionId },
  );
}

function installStateCompatibility(ctx: MoveRecording): void {
  const state = ctx.state;
  const baseGet = state.get.bind(state);
  state.get = (ref, path): AgentState => {
    if (/^occurrence:(?!.*::)[^/]+\/collection:(clip|track)$/.test(ref)) {
      if (path.length) throw new ClipMoveError('collection shape requires the whole guard');
      const [owner, kind] = ref.split('/collection:');
      if (!state.entity(owner, true)) return { state: 'absent' };
      const config = state.config(owner);
      const key = `${kind}s`;
      const value = config[key];
      const members: AgentState = has(config, key)
        ? { state: 'present', value: Array.isArray(value) ? [] : object(value) ? {} : value }
        : { state: 'absent' };
      return { state: 'present', value: { members } };
    }
    if (/^shot:(?!.*::)[^/]+$/.test(ref)) {
      const shot = state.bundle.shots[ref.slice(5)];
      return shot ? { state: 'present', value: { payload: copy(shot.payload), internal_timeline: copy(shot.internal_timeline) } }
        : { state: 'absent' };
    }
    if (/^occurrence:(?!.*::)[^/]+$/.test(ref)) {
      const occurrence = state.bundle.placements.find((row) => row.occurrence_id === ref.slice('occurrence:'.length));
      if (!occurrence) return { state: 'absent' };
      let current: JSON = occurrence;
      for (const key of path) {
        if (object(current) && has(current, key)) current = current[key];
        else return { state: 'absent' };
      }
      return { state: 'present', value: copy(current) };
    }
    if (ref.endsWith('/shot') && path[0] === 'payload') {
      const shot = String(state.occurrence(ref.slice(0, -5)).shot_id);
      const sources = (state.bundle.source_mapping as ObjectValue).shots as ObjectValue;
      const mapping = (sources[shot] as ObjectValue)?.item_id_map as ObjectValue ?? {};
      const value = { payload: remapItems(state.bundle.shots[shot].payload as ObjectValue,
        new Map(Object.entries(mapping).map(([source, destination]) => [String(destination), source]))) };
      let current: JSON = value;
      for (const key of path) {
        if (object(current) && has(current, key)) current = current[key];
        else return { state: 'absent' };
      }
      return { state: 'present', value: copy(current) };
    }
    return baseGet(ref, path);
  };
}

function apply(bundle: AuthoredBundle, supplied: EditCommand) {
  const allowed = ['schema_version', 'op', 'version', 'select', 'args', 'intent', 'rationale', 'group_id', ...CLAIMS];
  if (Object.keys(supplied).some((key) => !allowed.includes(key))
    || supplied.schema_version !== 1 || supplied.op !== 'occurrence.duplicate' || supplied.version !== '1'
    || typeof supplied.select !== 'string' || !/^occurrence:(?!.*::)[^/]+$/.test(supplied.select)
    || !equal(supplied.intent, { ownership: 'occurrence' })
    || !object(supplied.args) || !equal(Object.keys(supplied.args).sort(), ['occurrence_id', 'shot_id'])
    || !stableId(supplied.args.occurrence_id) || !stableId(supplied.args.shot_id)
    || (has(supplied, 'rationale') && typeof supplied.rationale !== 'string')
    || (has(supplied, 'group_id') && (typeof supplied.group_id !== 'string' || !supplied.group_id))) {
    throw new ClipMoveError('duplicate requires one explicit occurrence and two reserved identities');
  }
  const owner = supplied.select;
  const { occurrence_id: occurrenceId, shot_id: shotId } = supplied.args as OccurrenceDuplicateArgs;
  const ctx = new MoveRecording(bundle, supplied);
  installStateCompatibility(ctx);
  const groups = ctx.read('parent', ['config', 'pinnedShotGroups']);
  if (groups !== undefined && groups !== null && !equal(groups, [])) {
    throw new ClipMoveError('legacy groups require recorded migration', 'migration_needed');
  }
  const row = ctx.read(owner, []);
  if (!object(row)) throw new ClipMoveError('duplicate source disappeared', 'identity_conflict');
  const sourceShot = ctx.read(`${owner}/shot`, ['shot_id']);
  for (const kind of ['clip', 'track']) {
    const rows = ctx.state.config(owner)[`${kind}s`];
    if (!Array.isArray(rows) || !rows.every((row) => object(row) && stableId(row.id))) {
      throw new ClipMoveError('missing or ambiguous collection identity', 'identity_conflict');
    }
    const members = rows.map((row) => `${owner}/${kind}:${(row as ObjectValue).id}`);
    if (new Set(members).size !== members.length) throw new ClipMoveError('ambiguous collection identity', 'identity_conflict');
    ctx.read(`${owner}/collection:${kind}`, []);
    ctx.read(owner, ['occurrence_id']);
    ctx.read(`${owner}/shot`, ['shot_id']);
    ctx.bind(`collection.owner:collection.${kind}s`, owner);
    ctx.command.selections!.push({ key: `collection.${kind}s`, query_version: 1, owner,
      members, order: [...members], boundaries: [...members], policy: 'guard-membership' });
  }
  const internal = ctx.read(`${owner}/source`, []);
  const payload = ctx.read(`${owner}/shot`, ['payload']);
  if (!object(internal) || !object(payload)) throw new ClipMoveError('missing authored source', 'identity_conflict');
  if (occurrenceId === row.occurrence_id || shotId === sourceShot) {
    throw new ClipMoveError('duplicate requires reserved identities distinct from the source', 'identity_collision');
  }
  const remap = new Map<string, string>();
  const items = has(payload, 'items') ? payload.items : [];
  if (!Array.isArray(items)) throw new ClipMoveError('shot payload.items must be a list');
  for (const item of items) {
    const id = object(item) ? has(item, 'item_id') ? item.item_id : item.id : undefined;
    if (typeof id !== 'string' || !id || remap.has(id)) throw new ClipMoveError('missing or ambiguous shot item identity');
    remap.set(id, 'shot-item-placement-' + sha256(['shot-item-placement',
      ...[bundle.project_id, bundle.timeline_id, occurrenceId, shotId, id].map((part) => JSON.stringify(part))].join('\0')));
  }
  const occupied = new Set(Object.values(bundle.shots).flatMap((shot) =>
    ((shot.payload as ObjectValue).items as ObjectValue[] ?? []).map((item) => item.item_id ?? item.id)));
  if ([...remap.values()].some((id) => occupied.has(id))) throw new ClipMoveError('duplicate item identity is occupied', 'identity_collision');
  ctx.bind('duplicate.owner', owner);
  const created = copy(row);
  delete created.shot_revision_id;
  delete created.revision_id;
  Object.assign(created, { occurrence_id: occurrenceId, shot_id: shotId });
  const shotValue = {
    payload: remapItems(payload, remap), internal_timeline: copy(internal),
  };
  const destinationRevisionId = destinationShotRevisionId(bundle, shotId, shotValue);
  const projectId = bundle.project_id;
  if (typeof projectId !== 'string') {
    throw new ClipMoveError('missing authored project identity', 'identity_conflict');
  }
  const timelineId = bundle.timeline_id;
  if (typeof timelineId !== 'string') {
    throw new ClipMoveError('missing authored document identity', 'identity_conflict');
  }
  const parentDocumentId = created.parent_document_id;
  const documentId = typeof parentDocumentId === 'string' && parentDocumentId.length
    ? parentDocumentId : timelineId;
  if (has(created, 'stable_deep_link')) {
    created.stable_deep_link = stableOccurrenceDeepLink(
      projectId, documentId, shotId, destinationRevisionId, occurrenceId,
    );
  }
  if (has(created, 'output_identity')) {
    created.output_identity = stableOutputIdentity(projectId, documentId, occurrenceId);
  }
  const document = (bundle.source_mapping as ObjectValue)._runtime_document as ObjectValue | undefined;
  const mapping = bundle.source_mapping as ObjectValue;
  for (const [kind, id, value] of [
    ['shot', shotId, shotValue],
    ['occurrence', occurrenceId, created],
  ] as const) {
    const ref = `${kind}:${id}`;
    const retained = document ? kind === 'shot'
      ? (document.shot_revisions as ObjectValue[]).some((row) => row.shot_id === id)
      : (((document.parent_revision as ObjectValue).payload as ObjectValue).occurrences as ObjectValue[])
        .some((row) => row.occurrence_id === id)
      : kind === 'shot' ? Object.values(mapping.shots as ObjectValue).some((row) => (row as ObjectValue).shot_id === id)
        : has(mapping.placements as ObjectValue, id);
    if (retained || ctx.state.get(ref, []).state !== 'absent') throw new ClipMoveError('created identity is occupied', 'identity_collision');
    ctx.read(ref, []);
    const before = { state: 'absent' as const };
    const after = { state: 'present' as const, value: copy(value) };
    ctx.command.expect![`${ref}::`] = before;
    ctx.command.authorship![`${ref}::`] = 'direct';
    ctx.command.created!.push(ref);
    ctx.record.writes.push({ ref, path: [], before, after });
    ctx.record.created.push({ ref, kind, owner: kind === 'shot' ? null : 'parent' });
    if (kind === 'shot') Object.defineProperty(ctx.state.bundle.shots, id, { value: {
      shot_id: id, ...copy(value), _created: true,
    }, enumerable: true, writable: true, configurable: true });
    else ctx.state.bundle.placements.push(copy(value));
  }
  ctx.compile();
  for (const key of CLAIMS) {
    if (has(supplied, key) && !equal(supplied[key], ctx.command[key])) {
      throw new ClipMoveError(`submitted ${key} does not match original capture`, 'capture_mismatch');
    }
  }
  // Compiled revision IDs and the two root identity fields belong to Agent's compiler.
  return { command: ctx.command, bundle: ctx.state.bundle, record: ctx.record };
}

export function executeOccurrenceDuplicate(bundle: AuthoredBundle, command: EditCommand) {
  assertFiniteJson(bundle);
  assertFiniteJson(command);
  return apply(bundle, command);
}

export function captureOccurrenceDuplicate(bundle: AuthoredBundle, ownerRef: string, args: OccurrenceDuplicateArgs): OccurrenceDuplicateBasis {
  const snapshot = copy(bundle);
  const result = executeOccurrenceDuplicate(snapshot, {
    schema_version: 1, op: 'occurrence.duplicate', version: '1', select: ownerRef,
    args: copy(args), intent: { ownership: 'occurrence' },
  });
  return freezeJson({ bundle: snapshot, command: result.command });
}

export function finishOccurrenceDuplicate(basis: unknown) {
  assertFiniteJson(basis);
  if (!object(basis) || !object(basis.bundle) || !object(basis.command)
    || !CLAIMS.every((key) => has(basis.command as object, key))) throw new ClipMoveError('incomplete duplicate basis');
  return executeOccurrenceDuplicate(basis.bundle as AuthoredBundle, basis.command as EditCommand);
}

import { createHash } from 'node:crypto';
type JsonObject = Record<string, unknown>;

export interface Gate5ResetPreconditionInput {
  request: unknown;
  requestIdentity: unknown;
  responseRequest: unknown;
  requestIdempotencyKey: unknown;
  responseStatus: number | undefined;
  responseBody: unknown;
  expectedBase: { revisionId: string; publicationId: string };
  expectedScope: { projectId: string; timelineId: string };
  expectedOwnerId: string;
  expectedOwnerScope: { realmId: string; actorId: string; projectId: string; timelineId: string };
  // Captured producer metadata, never inferred from the submitted request. The
  // mounted move uses appendDocument, which supplies neither annotation.
  expectedRequestAnnotations?: { rationale?: string; group_id?: string };
  authoritativeHistory: unknown;
  preGestureDocument: unknown;
  clipId: string;
  expectedTrackId: string;
  expectedPreviousPosition: number;
  expectedPosition: number;
  settledOutboxes: readonly unknown[];
  authoritativeHead: unknown;
  authoritativeRevision: unknown;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Gate5 precondition ${label} is missing`);
  return value as JsonObject;
}

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Gate5 precondition ${label} is missing`);
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Gate5 precondition ${label} is missing`);
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function keys(value: JsonObject, expected: string[], label: string): void {
  if (!sameJson(Object.keys(value).sort(), [...expected].sort())) throw new Error(`Gate5 precondition ${label} keys mismatch`);
}

function exact(value: unknown, expected: unknown, label: string): void {
  if (!sameJson(value, expected)) throw new Error(`Gate5 precondition ${label} mismatch`);
}

/**
 * Reconstruct the move planner's ordered reads from the immutable pre-gesture
 * parent. The submitted request is deliberately not an input to this oracle.
 */
export function expectedGate5MoveReads(input: {
  preGestureDocument: unknown;
  clipId: string;
  expectedTrackId: string;
}): unknown[] {
  const document = object(input.preGestureDocument, 'pre-gesture document');
  const parentRevision = object(document.parent_revision, 'pre-gesture parent revision');
  const payload = object(parentRevision.payload, 'pre-gesture parent payload');
  const config = object(payload.config, 'pre-gesture config');
  const topLevelClips = !Object.prototype.hasOwnProperty.call(config, 'clips') && Array.isArray(payload.clips);
  const clipPath = topLevelClips ? ['clips'] : ['config', 'clips'];
  const clips = topLevelClips ? payload.clips : config.clips;
  if (!Array.isArray(clips)) throw new Error('Gate5 precondition pre-gesture clips are missing');
  const selected = clips.filter((candidate): candidate is JsonObject => isRecord(candidate) && candidate.id === input.clipId);
  if (selected.length !== 1) throw new Error('Gate5 precondition pre-gesture clip is ambiguous');
  const selectedClip = selected[0];
  const reads: unknown[] = [];
  const read = (value: JsonObject, key: string, path: string[]) => reads.push({
    kind: 'field', ref: 'parent', path: [...path, key],
    state: Object.prototype.hasOwnProperty.call(value, key)
      ? { state: 'present', value: structuredClone(value[key]) } : { state: 'absent' },
  });
  const readPath = (value: JsonObject, keys: string[], path: string[]) => {
    const [key, ...rest] = keys;
    if (rest.length && isRecord(value[key])) return readPath(value[key], rest, [...path, key]);
    read(value, key, path);
  };
  const timingReads = (item: JsonObject) => {
    for (const key of ['id', 'track', 'at', 'clipType', 'hold', 'from', 'to', 'speed', 'asset']) {
      read(item, key, [...clipPath, `id:${String(item.id)}`]);
    }
  };
  const registry = object(payload.registry, 'pre-gesture registry');
  const assetRead = (item: JsonObject) => {
    if (typeof item.asset !== 'string') return;
    readPath(registry, ['assets', item.asset], ['config', 'registry']);
  };

  timingReads(selectedClip);
  readPath(config, ['output', 'fps'], ['config']);
  if (!isRecord(config.output) || config.output.fps == null) {
    read(config, 'theme', ['config']);
    readPath(config, ['theme_overrides', 'visual', 'canvas', 'fps'], ['config']);
  }
  assetRead(selectedClip);
  const tracks = config.tracks;
  if (!Array.isArray(tracks)) throw new Error('Gate5 precondition pre-gesture tracks are missing');
  const track = tracks.filter((candidate): candidate is JsonObject => isRecord(candidate) && candidate.id === input.expectedTrackId);
  if (track.length !== 1) throw new Error('Gate5 precondition pre-gesture track is ambiguous');
  if (selectedClip.track !== input.expectedTrackId) throw new Error('Gate5 precondition pre-gesture track mismatch');
  read(track[0], 'kind', ['config', 'tracks', `id:${input.expectedTrackId}`]);
  read(config, 'pinnedShotGroups', ['config']);
  const order = clips.map((candidate) => isRecord(candidate) ? candidate.id : undefined);
  if (order.some((id) => typeof id !== 'string')) throw new Error('Gate5 precondition pre-gesture clip identity is missing');
  reads.push({ kind: 'collection', ref: 'parent', path: clipPath, members: [...order].sort(), order });
  for (const candidate of clips) {
    if (!isRecord(candidate)) throw new Error('Gate5 precondition pre-gesture clip is malformed');
    const item = candidate;
    if (item.id === input.clipId) continue;
    read(item, 'track', [...clipPath, `id:${String(item.id)}`]);
    if (item.track === input.expectedTrackId) {
      timingReads(item);
      assetRead(item);
    }
  }
  return reads;
}

/**
 * Validate the real mounted 0→5 commit before Gate5 issues its original 5→0 reset.
 * This is deliberately transport- and product-agnostic so the offline control can exercise every fail-closed edge.
 */
export function assertGate5ResetPrecondition(input: Gate5ResetPreconditionInput): void {
  if (input.responseRequest !== input.requestIdentity) throw new Error('Gate5 precondition response is not for the setup request');
  if (input.responseStatus !== 200) throw new Error(`Gate5 precondition response status ${String(input.responseStatus)}`);

  const request = object(input.request, 'request');
  const annotations = input.expectedRequestAnnotations ?? {};
  for (const [key, value] of Object.entries(annotations)) {
    if (!['rationale', 'group_id'].includes(key) || typeof value !== 'string' || (key === 'group_id' && !value)) {
      throw new Error('Gate5 precondition producer annotations mismatch');
    }
  }
  keys(request, ['api_version', 'project_id', 'timeline_id', 'base_revision_id', 'base_publication_id',
    'commands', 'label', 'steps', 'merge', 'reads', 'dry_run', 'source', ...Object.keys(annotations)], 'request');
  for (const [key, value] of Object.entries(annotations)) exact(request[key], value, `request ${key}`);
  if (request.api_version !== 1) throw new Error('Gate5 precondition request version mismatch');
  if (request.project_id !== input.expectedScope.projectId) throw new Error('Gate5 precondition project scope mismatch');
  if (request.timeline_id !== input.expectedScope.timelineId) throw new Error('Gate5 precondition timeline scope mismatch');
  if (request.base_revision_id !== input.expectedBase.revisionId) throw new Error('Gate5 precondition base revision mismatch');
  if (request.base_publication_id !== input.expectedBase.publicationId) throw new Error('Gate5 precondition base publication mismatch');
  if (request.label !== 'Edit timeline') throw new Error('Gate5 precondition label mismatch');
  if (request.merge !== 'fields') throw new Error('Gate5 precondition merge mismatch');
  if (request.dry_run !== false) throw new Error('Gate5 precondition dry-run mismatch');
  if (!sameJson(request.source, { via: 'app' })) throw new Error('Gate5 precondition source mismatch');
  const expectedReads = expectedGate5MoveReads({
    preGestureDocument: input.preGestureDocument, clipId: input.clipId, expectedTrackId: input.expectedTrackId,
  });
  if (!sameJson(request.reads, expectedReads)) throw new Error('Gate5 precondition move read dependencies mismatch');
  const commands = request.commands;
  if (!Array.isArray(commands) || commands.length !== 1) throw new Error('Gate5 precondition command is missing');
  const command = object(commands[0], 'command');
  keys(command, ['schema_version', 'op', 'version', 'select', 'created', 'args'], 'command');
  if (command.schema_version !== 1 || command.op !== 'doc.patch' || command.version !== '1' || command.select !== null) {
    throw new Error('Gate5 precondition is not the mounted document patch');
  }
  if (!Array.isArray(command.created) || command.created.length !== 0) throw new Error('Gate5 precondition created claims mismatch');
  const args = object(command.args, 'command arguments');
  keys(args, ['changes'], 'command arguments');
  const changes = args.changes;
  if (!Array.isArray(changes) || changes.length !== 1) throw new Error('Gate5 precondition patch is missing');
  const change = object(changes[0], 'change');
  keys(change, ['op', 'ref', 'path', 'before', 'value'], 'change');
  if (change.op !== 'set' || change.ref !== 'parent'
    || !sameJson(change.path, ['clips', `id:${input.clipId}`, 'at'])) throw new Error('Gate5 precondition clip mismatch');
  if (!sameJson(change.before, { state: 'present', value: input.expectedPreviousPosition })) {
    throw new Error('Gate5 precondition previous position mismatch');
  }
  if (change.value !== input.expectedPosition) throw new Error('Gate5 precondition requested position mismatch');
  const steps = request.steps;
  if (!Array.isArray(steps) || steps.length !== 1) throw new Error('Gate5 precondition step is missing');
  const step = object(steps[0], 'step');
  keys(step, ['id', 'label', 'intent', 'tags', 'command_ordinals', 'patch', 'reads'], 'step');
  if (typeof step.id !== 'string' || !step.id || step.label !== 'Edit timeline'
    || step.intent !== `Move ${input.clipId} on ${input.expectedTrackId}` || !sameJson(step.tags, [])
    || !sameJson(step.command_ordinals, [0]) || !sameJson(step.patch, changes)
    || !sameJson(step.reads, request.reads)) throw new Error('Gate5 precondition step claims mismatch');

  const envelope = object(input.responseBody, 'response');
  object(envelope.receipt, 'receipt');
  keys(envelope, ['data', 'receipt'], 'response');
  const data = object(envelope.data, 'response data');
  keys(data, ['status', 'base_revision_id', 'base_publication_id', 'previous_revision_id', 'previous_publication_id',
    'accepted_revision_id', 'rebased_onto', 'commands', 'document_digest', 'canonical_document', 'id_map',
    'provider_version', 'compiler_version', 'publisher', 'merge_mode', 'label', 'source', 'steps', ...Object.keys(annotations)], 'response data');
  for (const [key, value] of Object.entries(annotations)) exact(data[key], value, `response ${key}`);
  if (string(data.status, 'response status') !== 'accepted') throw new Error('Gate5 precondition was not accepted');
  if (data.base_revision_id !== request.base_revision_id || data.base_publication_id !== request.base_publication_id) {
    throw new Error('Gate5 precondition response base mismatch');
  }
  if (data.previous_revision_id !== input.expectedBase.revisionId || data.previous_publication_id !== input.expectedBase.publicationId) {
    throw new Error('Gate5 precondition response previous head mismatch');
  }
  if (data.rebased_onto !== null) throw new Error('Gate5 precondition response rebase mismatch');
  const acceptedRevisionId = string(data.accepted_revision_id, 'accepted revision');
  const responseCommands = data.commands;
  if (!Array.isArray(responseCommands) || responseCommands.length !== 1) throw new Error('Gate5 precondition response command mismatch');
  const responseCommand = object(responseCommands[0], 'response command');
  for (const key of ['schema_version', 'op', 'version', 'select', 'args', 'created']) {
    if (!sameJson(responseCommand[key], command[key])) throw new Error('Gate5 precondition response command mismatch');
  }
  // commands.py + _doc_patch.patch + Recording.finish: the only native authored
  // read/write is the selected parent's at field. Declared reads stay in records.
  const nativeRef = `parent/clip:${input.clipId}`;
  const before = { state: 'present', value: input.expectedPreviousPosition };
  const nativeRead = { ref: nativeRef, path: ['at'], state: before };
  const expectedCommand = { ...command, intent: {}, resolved: [], expect: { [`${nativeRef}::at`]: before },
    authorship: { [`${nativeRef}::at`]: 'direct' }, reads: [nativeRead], selections: [], bindings: {} };
  exact(responseCommand, expectedCommand, 'response command claims');
  if (typeof data.document_digest !== 'string' || !data.document_digest
    || !object(data.id_map, 'id map') || data.provider_version !== 'astrid-v1' || data.compiler_version !== 'authoring-bundle-1'
    || string(data.publisher, 'publisher') === '' || data.merge_mode !== 'fields'
    || data.label !== request.label || !sameJson(data.source, request.source)) {
    throw new Error('Gate5 precondition response metadata mismatch');
  }
  const responseSteps = data.steps;
  if (!Array.isArray(responseSteps) || responseSteps.length !== 1) throw new Error('Gate5 precondition response steps missing');
  const responseStep = object(responseSteps[0], 'response step');
  const normalizedReads = expectedReads.map((read) => {
    const value = object(read, 'expected read');
    const path = value.path as string[];
    return { ...value, path: ['clips', 'registry'].includes(path[0]) ? ['config', ...path] : path };
  });
  // CommitPatch.before captures batch and step dependencies independently (including duplicates).
  const dependencies = [...normalizedReads, ...normalizedReads];
  const authoredDependency = { kind: 'field', ref: 'parent', path: ['config', 'clips', `id:${input.clipId}`, 'at'], state: before };
  if (!dependencies.some((read) => sameJson(read, authoredDependency))) dependencies.push(authoredDependency);
  const expectedStep = { ...step, patch: [{ ...change, path: ['config', ...(change.path as string[])] }], dependencies };
  exact(responseStep, expectedStep, 'response step claims');
  const receipt = object(envelope.receipt, 'receipt');
  keys(receipt, ['receipt_id', 'command_kind', 'idempotency_key', 'request_hash', 'project_id', 'project_seq',
    'event_ids', 'result', 'created_at'], 'receipt');
  string(receipt.receipt_id, 'receipt id');
  if (string(input.requestIdempotencyKey, 'request idempotency key') !== receipt.idempotency_key) {
    throw new Error('Gate5 precondition receipt idempotency mismatch');
  }
  if (receipt.command_kind !== 'timeline.commit') throw new Error('Gate5 precondition receipt command mismatch');
  if (receipt.project_id !== input.expectedScope.projectId) throw new Error('Gate5 precondition receipt project mismatch');
  if (!sameJson(receipt.result, data)) throw new Error('Gate5 precondition receipt does not match response data');
  const ownerScope = object(input.expectedOwnerScope, 'fresh owner scope');
  for (const field of ['realmId', 'actorId', 'projectId', 'timelineId']) string(ownerScope[field], `fresh owner ${field}`);
  if (ownerScope.projectId !== input.expectedScope.projectId || ownerScope.timelineId !== input.expectedScope.timelineId) {
    throw new Error('Gate5 precondition fresh owner scope mismatch');
  }
  if (data.publisher !== ownerScope.actorId) throw new Error('Gate5 precondition publisher mismatch');
  const requestHash = digest({ operation: 'commitTimeline',
    path: `/v1/projects/${encodeURIComponent(input.expectedScope.projectId)}/timelines/${encodeURIComponent(input.expectedScope.timelineId)}/commit`,
    publisher: ownerScope.actorId, request }).slice(7);
  exact(receipt.request_hash, requestHash, 'receipt request hash');
  if (typeof receipt.created_at !== 'string' || !Number.isFinite(Date.parse(receipt.created_at))
    || !Array.isArray(receipt.project_seq) || receipt.project_seq.length !== 2
    || !receipt.project_seq.every((seq) => Number.isSafeInteger(seq) && seq > 0)
    || receipt.project_seq[0] > receipt.project_seq[1]
    || !Array.isArray(receipt.event_ids) || !receipt.event_ids.length
    || !receipt.event_ids.every((id) => typeof id === 'string' && !!id)
    || new Set(receipt.event_ids).size !== receipt.event_ids.length) throw new Error('Gate5 precondition receipt correlation mismatch');

  const document = object(data.canonical_document, 'canonical document');
  if (document.project_id !== input.expectedScope.projectId || document.timeline_id !== input.expectedScope.timelineId) {
    throw new Error('Gate5 precondition canonical scope mismatch');
  }
  const parentRevision = object(document.parent_revision, 'parent revision');
  if (parentRevision.revision_id !== acceptedRevisionId) throw new Error('Gate5 precondition canonical revision mismatch');
  const payload = object(parentRevision.payload, 'parent payload');
  const clips = payload.clips ?? object(payload.config, 'canonical config').clips;
  if (!Array.isArray(clips)) throw new Error('Gate5 precondition canonical clips are missing');
  const clip = clips.find((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    && (candidate as JsonObject).id === input.clipId);
  if (!clip) throw new Error('Gate5 precondition canonical clip is missing');
  if (number((clip as JsonObject).at, 'canonical position') !== input.expectedPosition) {
    throw new Error('Gate5 precondition canonical position mismatch');
  }
  const original = object(input.preGestureDocument, 'pre-gesture document');
  const expectedDocument = structuredClone(original);
  const expectedParent = object(expectedDocument.parent_revision, 'pre-gesture parent revision');
  const expectedPayload = object(expectedParent.payload, 'pre-gesture payload');
  const expectedConfig = object(expectedPayload.config, 'pre-gesture config');
  for (const rows of [expectedPayload.clips, expectedConfig.clips]) {
    if (!Array.isArray(rows)) continue;
    const selected = rows.filter((row) => isRecord(row) && row.id === input.clipId);
    if (selected.length !== 1 || selected[0].at !== input.expectedPreviousPosition) throw new Error('Gate5 precondition pre-gesture position mismatch');
    selected[0].at = input.expectedPosition;
  }
  expectedParent.revision_id = acceptedRevisionId;
  expectedParent.content_digest = digest(expectedPayload);
  exact(document, expectedDocument, 'canonical closure');
  exact(data.document_digest, digest(expectedDocument), 'document digest');
  exact(data.id_map, {}, 'id map');

  const authoritativeHead = object(input.authoritativeHead, 'authoritative head');
  if (authoritativeHead.revision_id !== acceptedRevisionId || authoritativeHead.publication_id !== receipt.receipt_id) {
    throw new Error('Gate5 precondition authoritative head mismatch');
  }
  const authoritativeRevision = object(input.authoritativeRevision, 'authoritative revision');
  if (authoritativeRevision.project_id !== input.expectedScope.projectId
    || authoritativeRevision.timeline_id !== input.expectedScope.timelineId
    || authoritativeRevision.revision_id !== acceptedRevisionId) {
    throw new Error('Gate5 precondition authoritative revision scope mismatch');
  }
  const authoritativePayload = object(authoritativeRevision.payload, 'authoritative payload');
  const authoritativeClips = authoritativePayload.clips ?? object(authoritativePayload.config, 'authoritative config').clips;
  if (!Array.isArray(authoritativeClips)) throw new Error('Gate5 precondition authoritative clips are missing');
  const authoritativeClip = authoritativeClips.find((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    && (candidate as JsonObject).id === input.clipId);
  if (!authoritativeClip) throw new Error('Gate5 precondition authoritative clip is missing');
  if (number((authoritativeClip as JsonObject).at, 'authoritative position') !== input.expectedPosition) {
    throw new Error('Gate5 precondition authoritative position mismatch');
  }
  exact(authoritativePayload, expectedPayload, 'authoritative payload');

  // History is the documented location of records and undo metadata; these are
  // not acceptance-data fields. Reconstruct this single parent patch's recorder
  // from the captured input, using _commit_patch.capture and _recording.read.
  const originalParent = object(original.parent_revision, 'original parent');
  const originalPayload = object(originalParent.payload, 'original payload');
  const originalConfig = object(originalPayload.config, 'original config');
  const boundary = { base_revision_id: input.expectedBase.revisionId, base_publication_id: input.expectedBase.publicationId,
    evaluated_head: { revision_id: input.expectedBase.revisionId, publication_id: input.expectedBase.publicationId },
    step_id: step.id, command_ordinal: 0, phase: 'input' };
  const bindings: JsonObject[] = [];
  const recordReads: JsonObject[] = [];
  const addRead = (read: JsonObject) => {
    if (!recordReads.some((prior) => sameJson(prior, read))) recordReads.push(read);
  };
  for (const phase of ['batch-read', 'input']) {
    for (const read of normalizedReads) {
      bindings.push({ ref: 'parent', physical_ref: 'parent', revision_id: originalParent.revision_id,
        content_digest: originalParent.content_digest, boundary: { ...boundary, phase }, key: 'commit.read',
        policy: 'fixed', dependencies: [], path: read.path, dependency: read });
      if (read.kind === 'collection') continue;
      const path = read.path as string[];
      if (path[0] === 'config' && ['clips', 'tracks'].includes(path[1]) && path[2]?.startsWith('id:')) {
        addRead({ ref: `parent/${path[1] === 'clips' ? 'clip' : 'track'}:${path[2].slice(3)}`, path: path.slice(3), state: read.state });
      } else if (path[0] === 'config' && path[1] === 'registry') {
        if (Object.hasOwn(originalPayload, 'registry')) addRead({ ref: 'parent', path: path.slice(1), state: read.state });
        if (Object.hasOwn(originalConfig, 'registry')) addRead({ ref: 'parent', path, state: read.state });
      } else addRead({ ref: 'parent', path, state: read.state });
    }
  }
  addRead(nativeRead);
  bindings.push({ ref: 'parent', physical_ref: 'parent', revision_id: originalParent.revision_id,
    content_digest: originalParent.content_digest, boundary: { ...boundary, change_ordinal: 0 },
    key: 'doc.patch:0', policy: 'fixed', dependencies: [], path: authoredDependency.path, change, write_range: [0, 1] });
  for (const [side, image] of [['before', originalParent], ['after', expectedParent]] as const) {
    bindings.push({ ref: 'parent', physical_ref: 'parent', revision_id: image.revision_id, content_digest: image.content_digest,
      boundary: { ...boundary, phase: 'effect', side }, key: 'commit.effect', policy: 'fixed', dependencies: [],
      path: authoredDependency.path, step_id: step.id, effect_ordinal: 0 });
  }
  const manifest = object(original.dependency_manifest, 'pre-gesture manifest');
  // The original Gate5 fixture has no consumed document pins or timing anchors.
  // A different fixture needs its own compiler-input oracle, never copied claims.
  exact(manifest.documents, [], 'pre-gesture document dependencies');
  const derivedWrites = Array.isArray(originalConfig.clips) && Array.isArray(originalPayload.clips)
    ? [{ ref: 'parent', path: ['config', 'clips'], before: { state: 'present', value: originalConfig.clips },
      after: { state: 'present', value: expectedConfig.clips }, cause: 0 }] : [];
  const record = { ordinal: 0, command: expectedCommand,
    writes: [{ ref: nativeRef, path: ['at'], before, after: { state: 'present', value: input.expectedPosition } }],
    reads: recordReads, selections: [], bindings, created: [], dependencies: [], derived_writes: derivedWrites };
  // C0 history attribution is part of the authoritative record, and D62 freezes
  // recorder_abi at acceptance. The mounted record has physical_ref bindings,
  // so Runtime 8b32 classifies this current recorder as ABI 2; response data
  // intentionally remains free of this history-only field.
  exact(input.authoritativeHistory, {
    publication_id: receipt.receipt_id, revision_id: acceptedRevisionId,
    previous: { revision_id: input.expectedBase.revisionId, publication_id: input.expectedBase.publicationId },
    receipt, intent: 'recorded', provider_version: data.provider_version, compiler_version: data.compiler_version,
    recorder_abi: 2, publisher: ownerScope.actorId, source: { via: 'app' }, label: 'Edit timeline', ...annotations, merge: 'fields', merge_mode: 'fields',
    reads: expectedReads, steps: [expectedStep], records: { schema_version: 1, commands: [record], undo_of: [],
      restored_from: null, undo_steps: null, label: 'Edit timeline', merge_mode: 'fields', steps: [expectedStep] },
  }, 'authoritative history');

  if (input.settledOutboxes.length !== 1) throw new Error('Gate5 precondition owner is missing or ambiguous');
  const outbox = object(input.settledOutboxes[0], 'outbox');
  const scope = object(outbox.scope, 'outbox scope');
  if (scope.projectId !== input.expectedScope.projectId || scope.timelineId !== input.expectedScope.timelineId) {
    throw new Error('Gate5 precondition owner scope mismatch');
  }
  if (outbox.ownerId !== input.expectedOwnerId) throw new Error('Gate5 precondition owner identity mismatch');
  exact(scope, ownerScope, 'owner scope');
  if (outbox.pending) throw new Error('Gate5 precondition owner is still pending');
  const intents = outbox.intents;
  if (!Array.isArray(intents) || intents.length !== 0) throw new Error('Gate5 precondition owner is not settled');
  const accepted = object(outbox.accepted, 'accepted owner result');
  const acceptedHead = object(accepted.head, 'accepted owner head');
  if (acceptedHead.revisionId !== acceptedRevisionId || acceptedHead.publicationId !== receipt.receipt_id) {
    throw new Error('Gate5 precondition owner head mismatch');
  }
  exact(acceptedHead, { revisionId: acceptedRevisionId, publicationId: receipt.receipt_id }, 'owner head');
  const acceptedValue = object(accepted.value, 'accepted owner value');
  const acceptedIdentity = object(acceptedValue.accepted, 'accepted owner identity');
  if (acceptedIdentity.revisionId !== acceptedRevisionId || acceptedIdentity.publicationId !== receipt.receipt_id) {
    throw new Error('Gate5 precondition owner accepted identity mismatch');
  }
  exact(acceptedIdentity, acceptedHead, 'owner accepted identity');
  const acceptedReceipt = object(acceptedValue.receipt, 'accepted owner receipt');
  if (!sameJson(acceptedValue.response, input.responseBody)
    || !sameJson(acceptedValue.canonicalDocument, document)
    || !sameJson(acceptedReceipt, receipt)
    || acceptedReceipt.idempotency_key !== input.requestIdempotencyKey) {
    throw new Error('Gate5 precondition owner receipt or canonical result mismatch');
  }
}

import { describe, expect, it } from 'vitest';
import type { EditCommand, JSON, MediaSelection, VerifiedMedia } from '@/integrations/runtime/timeline-commit-types.ts';
import {
  captureOccurrenceAddMedia, executeOccurrenceAddMedia, finishOccurrenceAddMedia,
} from './occurrenceMediaCapture.ts';
import { AuthoredState, copy, type AuthoredBundle } from './clipMovePrimitives.ts';

const owner = 'occurrence:occ-a';
const sourceShot = 'shot-placement-17545afbc02f243b9327cabff19dacf2c3bc6ee5e2abd3a4c4a0415124093e9f';
const siblingShot = 'shot-placement-sibling';
const media: MediaSelection = {
  asset: 'reserved-new', generation_id: 'generation-new', variant_id: 'variant-new',
  object_id: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  catalog_digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};
const verified: VerifiedMedia = { selection: media, media_type: 'video/fixture', size: 123, duration_seconds: 6 };
const row: Record<string, JSON> = {
  id: 'reserved-child', clipType: 'video', asset: 'reserved-new', track: 'picture', at: 0.125, hold: 4,
  from: 2, to: 6, speed: 2, params: null, opaque: [null, false, {}],
};
const existingClip = (id: string, at: number): Record<string, JSON> => ({
  id, track: 'picture', asset: 'picture', clipType: 'media', at, hold: 2,
  app: { 'org.example': { literal: 'clip-a', clear: null } },
});

function bundle(): AuthoredBundle {
  const internal = {
    output: { fps: { numerator: 30000, denominator: 1001 } },
    tracks: [{ id: 'picture', kind: 'visual' }],
    clips: [
      { ...existingClip('clip-a', 1), from: 2, to: 6, hold: 4, speed: 2 },
      existingClip('clip-b', 5),
    ],
    registry: {
      opaque: { keep: [null, false, {}] },
      assets: { picture: { media_id: 'sha256:1111111111111111111111111111111111111111111111111111111111111111', type: 'video' } },
    },
    opaque: { timestamp: 'authored timestamp', v: [null, false, 0] },
  } as Record<string, JSON>;
  const makeShot = (shotId: string) => ({ shot_id: shotId, internal_timeline: copy(internal) });
  return {
    schema_version: 1, project_id: 'project-1', timeline_id: 'film',
    parent: {
      config: { output: { fps: { numerator: 30000, denominator: 1001 } }, opaque: { parent: true } },
    },
    placements: [
      { occurrence_id: 'occ-a', shot_id: sourceShot, placement: { start_ms: 8000, track: 'picture' },
        duration_ms: 10000, source_offset: 0, speed: 1, track: 'picture', opaque: { occurrence: 'a' } },
      { occurrence_id: 'occ-b', shot_id: siblingShot, placement: { start_ms: 10000, track: 'picture' },
        duration_ms: 10000, source_offset: 0, speed: 1, track: 'picture', opaque: { occurrence: 'b' } },
    ],
    shots: { [sourceShot]: makeShot(sourceShot), [siblingShot]: makeShot(siblingShot) },
    source_mapping: {
      placements: {},
      shots: { [sourceShot]: { shot_id: 'chapter-shot' }, [siblingShot]: { shot_id: 'sibling-shot' } },
      _runtime_document: {},
    },
  } as AuthoredBundle;
}

const agentCommand: EditCommand = {
  schema_version: 1, op: 'occurrence.add-media', version: '1', select: owner,
  args: { media, row }, intent: { ownership: 'occurrence' }, resolved: [owner],
  bindings: {
    'collection.owner:collection.clips': owner, 'collection.owner:collection.tracks': owner,
    'create.owner': owner, 'media.owner': owner, 'media.track': `${owner}/track:picture`,
  },
  created: [`${owner}/asset:reserved-new`, `${owner}/clip:reserved-child`],
  expect: {
    [`${owner}/asset:reserved-new::`]: { state: 'absent' },
    [`${owner}/clip:reserved-child::`]: { state: 'absent' },
  },
  authorship: {
    [`${owner}/asset:reserved-new::`]: 'direct', [`${owner}/clip:reserved-child::`]: 'direct',
  },
  reads: [
    { ref: 'parent/collection:occurrence', path: [], state: { state: 'present', value: { container: 'array' } } },
    { ref: owner, path: ['occurrence_id'], state: { state: 'present', value: 'occ-a' } },
    { ref: `${owner}/shot`, path: ['shot_id'], state: { state: 'present', value: 'chapter-shot' } },
    { ref: owner, path: ['placement', 'start_ms'], state: { state: 'present', value: 8000 } },
    { ref: owner, path: ['at_ms'], state: { state: 'absent' } },
    { ref: owner, path: ['duration_ms'], state: { state: 'present', value: 10000 } },
    { ref: owner, path: ['source_offset'], state: { state: 'present', value: 0 } },
    { ref: owner, path: ['speed'], state: { state: 'present', value: 1 } },
    { ref: owner, path: ['track'], state: { state: 'present', value: 'picture' } },
    { ref: owner, path: ['placement', 'track'], state: { state: 'present', value: 'picture' } },
    ...(['time_map', 'timeMap', 'enabled', 'active', 'disabled', 'hidden', 'deleted'] as string[]).map((path) => ({
      ref: owner, path: [path], state: { state: 'absent' as const },
    })),
    { ref: 'parent', path: ['config', 'output', 'fps'], state: { state: 'present', value: { numerator: 30000, denominator: 1001 } } },
    { ref: `${owner}/source`, path: ['output', 'fps'], state: { state: 'present', value: { numerator: 30000, denominator: 1001 } } },
    { ref: `${owner}/source`, path: ['source_window'], state: { state: 'absent' } },
    { ref: `${owner}/source`, path: ['app', 'astrid', 'pool'], state: { state: 'absent' } },
    { ref: 'parent', path: ['config', 'pinnedShotGroups'], state: { state: 'absent' } },
    { ref: `${owner}/collection:clip`, path: [], state: { state: 'present', value: { members: { state: 'present', value: [] } } } },
    { ref: `${owner}/collection:track`, path: [], state: { state: 'present', value: { members: { state: 'present', value: [] } } } },
    { ref: `${owner}/track:picture`, path: [], state: { state: 'present', value: { id: 'picture', kind: 'visual' } } },
    { ref: `${owner}/asset:reserved-new`, path: [], state: { state: 'absent' } },
    { ref: `${owner}/clip:reserved-child`, path: [], state: { state: 'absent' } },
  ],
  selections: [
    { key: 'collection.occurrences', query_version: 1, owner: 'parent', members: ['occurrence:occ-a', 'occurrence:occ-b'],
      order: ['occurrence:occ-a', 'occurrence:occ-b'], boundaries: ['occurrence:occ-a', 'occurrence:occ-b'], policy: 'guard-membership' },
    { key: 'placement.owners', query_version: 1, owner, members: [owner], order: [owner], boundaries: [`shot:${sourceShot}`], policy: 'guard-membership' },
    { key: 'collection.clips', query_version: 1, owner, members: [`${owner}/clip:clip-a`, `${owner}/clip:clip-b`],
      order: [`${owner}/clip:clip-a`, `${owner}/clip:clip-b`], boundaries: [`${owner}/clip:clip-a`, `${owner}/clip:clip-b`], policy: 'guard-membership' },
    { key: 'collection.tracks', query_version: 1, owner, members: [`${owner}/track:picture`],
      order: [`${owner}/track:picture`], boundaries: [`${owner}/track:picture`], policy: 'guard-membership' },
  ],
};

const agentRecord = {
  ordinal: 0, command: agentCommand, reads: agentCommand.reads, selections: agentCommand.selections,
  bindings: [
    { key: 'media.owner', ref: owner, policy: 'fixed', dependencies: [] },
    { key: 'collection.owner:collection.clips', ref: owner, policy: 'fixed', dependencies: [] },
    { key: 'collection.owner:collection.tracks', ref: owner, policy: 'fixed', dependencies: [] },
    { key: 'media.track', ref: `${owner}/track:picture`, policy: 'fixed', dependencies: [] },
    { key: 'create.owner', ref: owner, policy: 'fixed', dependencies: [] },
  ],
  created: [
    { ref: `${owner}/asset:reserved-new`, kind: 'asset', owner },
    { ref: `${owner}/clip:reserved-child`, kind: 'clip', owner },
  ],
  dependencies: [{ key: 'media.new', kind: 'media', pin: media, policy: 'exact' }],
  derived_writes: [],
  writes: [
    { ref: `${owner}/asset:reserved-new`, path: [], before: { state: 'absent' }, after: { state: 'present', value: {
      generationId: 'generation-new', media_id: media.object_id, type: 'video', variantId: 'variant-new',
    } } },
    { ref: `${owner}/clip:reserved-child`, path: [], before: { state: 'absent' }, after: { state: 'present', value: row } },
  ],
};

describe('dormant native occurrence.add-media capture', () => {
  it('matches frozen Agent6ef command and complete record on a compact source fixture', () => {
    const input = bundle();
    const basis = captureOccurrenceAddMedia(input, owner, row, media, [verified]);
    const result = finishOccurrenceAddMedia(basis);

    expect(result.command).toEqual(agentCommand);
    expect(result.record).toEqual(agentRecord);
    expect(input).toEqual(bundle());
    expect(result.bundle.parent).toEqual(input.parent);
    expect(result.bundle.placements).toEqual(input.placements);
    expect((result.bundle.shots[sourceShot].internal_timeline.clips as JSON[]).at(-1)).toEqual(row);
    expect((result.bundle.shots[sourceShot].internal_timeline.registry as Record<string, JSON>).assets)
      .toEqual(expect.objectContaining({ picture: expect.anything(), 'reserved-new': expect.anything() }));
    expect(result.bundle.shots[siblingShot]).toEqual(input.shots[siblingShot]);
    expect(Object.isFrozen(basis.command.args)).toBe(true);
  });

  it('replays serialized custody and refuses direct guard damage without mutating input', () => {
    const original = bundle();
    const basis = captureOccurrenceAddMedia(original, owner, row, media, [verified]);
    expect(finishOccurrenceAddMedia(JSON.parse(JSON.stringify(basis)))).toEqual(finishOccurrenceAddMedia(basis));

    const cases: Array<[string, (input: AuthoredBundle, command: EditCommand, inputs: VerifiedMedia[]) => void]> = [
      ['missing verified media', (_input, _command, inputs) => inputs.splice(0)],
      ['wrong owner', (_input, command) => { command.select = 'parent'; }],
      ['display child owner', (_input, command) => { command.select = `${owner}/clip:display-id`; }],
      ['changed source map', (input) => { (input.placements[0] as Record<string, JSON>).source_offset = 1; }],
      ['inactive raw track', (input) => { (input.shots[sourceShot].internal_timeline.tracks as JSON[])[0] = { id: 'picture', kind: 'visual', hidden: true }; }],
      ['changed membership', (input) => { (input.shots[sourceShot].internal_timeline.clips as JSON[]).push({ id: 'other' }); }],
      ['changed order', (input) => { (input.shots[sourceShot].internal_timeline.clips as JSON[]).reverse(); }],
      ['occupied reserved alias', (input) => { ((input.shots[sourceShot].internal_timeline.registry as Record<string, JSON>).assets as Record<string, JSON>)['reserved-new'] = { opaque: null }; }],
      ['forged birth claims', (_input, command) => { command.created = []; }],
    ];
    for (const [label, damage] of cases) {
      const input = copy(original), command = copy(basis.command), inputs = copy([verified]);
      damage(input, command, inputs);
      const before = copy(input);
      expect(() => executeOccurrenceAddMedia(input, command, inputs), label).toThrow();
      expect(input).toEqual(before);
    }
  });

  it('matches frozen occurrence-start and boolean map refusals', () => {
    const nullPlacement = bundle();
    nullPlacement.placements[0].placement = null;
    expect(() => captureOccurrenceAddMedia(nullPlacement, owner, row, media, [verified])).toThrow(
      'occurrence placement must be an object',
    );

    const contradictoryStart = bundle();
    contradictoryStart.placements[0].at_ms = 9000;
    expect(() => captureOccurrenceAddMedia(contradictoryStart, owner, row, media, [verified])).toThrow(
      'contradictory occurrence start codecs',
    );

    const largeTimestampWithinRelativeTolerance = bundle();
    largeTimestampWithinRelativeTolerance.placements[0].placement = {
      ...(largeTimestampWithinRelativeTolerance.placements[0].placement as Record<string, JSON>), start_ms: 1e9,
    };
    largeTimestampWithinRelativeTolerance.placements[0].at_ms = 1e9 + 0.5;
    expect(() => captureOccurrenceAddMedia(
      largeTimestampWithinRelativeTolerance, owner, row, media, [verified],
    )).not.toThrow();

    const largeTimestampContradiction = bundle();
    largeTimestampContradiction.placements[0].placement = {
      ...(largeTimestampContradiction.placements[0].placement as Record<string, JSON>), start_ms: 1e9,
    };
    largeTimestampContradiction.placements[0].at_ms = 1e9 + 1.5;
    expect(() => captureOccurrenceAddMedia(
      largeTimestampContradiction, owner, row, media, [verified],
    )).toThrow('contradictory occurrence start codecs');

    const booleanSpeed = bundle();
    booleanSpeed.placements[0].speed = true;
    expect(() => captureOccurrenceAddMedia(booleanSpeed, owner, row, media, [verified])).toThrow();

    const booleanSourceOffset = bundle();
    booleanSourceOffset.placements[0].source_offset = false;
    expect(() => captureOccurrenceAddMedia(booleanSourceOffset, owner, row, media, [verified])).toThrow();
  });

  it('does not infer owner from a display child identity', () => {
    expect(() => captureOccurrenceAddMedia(bundle(), `${owner}/clip:occ-a:clip-a`, row, media, [verified])).toThrow(
      'explicit occurrence/raw child ownership',
    );
    const state = new AuthoredState(bundle());
    expect(state.occurrence(owner).occurrence_id).toBe('occ-a');
  });

  it('refuses a missing occurrence owner with an identity conflict', () => {
    const input = bundle();
    input.placements = input.placements.slice(1);

    expect(() => captureOccurrenceAddMedia(input, owner, row, media, [verified])).toThrowError(
      expect.objectContaining({ kind: 'identity_conflict' }),
    );
  });
});

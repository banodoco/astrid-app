import { describe, expect, it } from 'vitest';
import type { AgentState, JSON } from '@/integrations/runtime/timeline-commit-types.ts';
import { captureTrackLabel, finishTrackLabel } from './trackLabelCapture.ts';
import type { TrackLabelArgs } from './trackLabelCapture.ts';
import { AuthoredState, copy, freezeJson } from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';
import fixture from './fixtures/recipe_m2_app_track_label.json';

// Byte-exact Agent 77b1f0f7177174571edd7b13b3c010377432597d conformance golden.
const original = fixture.bundle as AuthoredBundle;
const ref = fixture.input.target_ref;
const address = `${ref}::label`;
const set = (label: string): TrackLabelArgs => ({ values: { label }, clear: [] });
const clear: TrackLabelArgs = { values: {}, clear: ['label'] };
const roundtrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const track = (bundle: AuthoredBundle) => new AuthoredState(bundle).entity(ref)!;

describe('portable parent track label capture', () => {
  it('matches the exact native command and after-bundle golden', () => {
    const input = freezeJson(copy(original));
    const basis = captureTrackLabel(input, ref);
    const result = finishTrackLabel(basis, set(fixture.input.label));
    expect(result.command).toEqual(fixture.command);
    expect(result.bundle).toEqual(fixture.after_bundle);
    expect(result.record.command).toEqual(fixture.command);
    expect(result.record.writes).toEqual([{ ref, path: ['label'], before: fixture.before, after: fixture.after }]);
    expect(result.record.bindings).toEqual([
      { key: 'scalar.target', ref, policy: 'fixed', dependencies: ['scalar.images'] },
    ]);
    expect(result.record.dependencies).toEqual([
      { key: 'scalar.images', kind: 'entity', pin: { parent: original.base_parent }, policy: 'exact' },
    ]);
    expect(input).toEqual(original);
    const jsonBasis: { [key: string]: JSON } = basis;
    expect(finishTrackLabel(freezeJson(copy(jsonBasis)), set(fixture.input.label))).toEqual(result);
    expect(finishTrackLabel(freezeJson(roundtrip(jsonBasis)), set(fixture.input.label))).toEqual(result);
    expect(Object.isFrozen(basis)).toBe(true);
    expect(Object.isFrozen(track(basis.bundle))).toBe(true);
    expect(Object.isFrozen(basis.command.expect![address])).toBe(true);
  });

  const beforeStates: AgentState[] = [
    { state: 'absent' }, { state: 'present', value: null },
    { state: 'present', value: '' }, { state: 'present', value: 'Old' },
  ];
  for (const before of beforeStates) {
    for (const args of [set('New é 🎬'), set(''), set('Old'), clear]) {
      it(`preserves ${JSON.stringify(before)} for ${JSON.stringify(args)}`, () => {
        const input = copy(original);
        if (before.state === 'present') track(input).label = copy(before.value);
        const snapshot = copy(input);
        const basis = captureTrackLabel(freezeJson(input), ref);
        const captured = copy(basis);
        const result = finishTrackLabel(freezeJson(roundtrip(basis)), args);
        const after: AgentState = 'label' in args.values
          ? { state: 'present', value: args.values.label } : { state: 'absent' };
        const expected = copy(snapshot);
        if (after.state === 'present') track(expected).label = after.value;
        else delete track(expected).label;
        expect(result.bundle).toEqual(expected);
        expect(result.command.args).toEqual(args);
        expect(result.command.expect).toEqual({ [address]: before });
        expect(result.command.authorship).toEqual({ [address]: 'direct' });
        expect(result.record.writes).toEqual([{ ref, path: ['label'], before, after }]);
        expect(input).toEqual(snapshot);
        expect(basis).toEqual(captured);
      });
    }
  }

  it('retains same-value writes and clearing an absent value as direct intent', () => {
    for (const args of [set(''), clear]) {
      const input = copy(original);
      if ('label' in args.values) track(input).label = args.values.label;
      const result = finishTrackLabel(captureTrackLabel(input, ref), args);
      expect(result.bundle).toEqual(input);
      expect(result.record.writes).toHaveLength(1);
      expect(result.record.writes[0].before).toEqual(result.record.writes[0].after);
      expect(result.command.authorship).toEqual({ [address]: 'direct' });
    }
  });

  it('keeps original reads across repeated previews and later input or result mutations', () => {
    const input = copy(original);
    const basis = captureTrackLabel(input, ref);
    const snapshot = copy(basis);
    track(input).label = 'Refreshed after ACK';
    const preview = finishTrackLabel(basis, set('Preview'));
    track(preview.bundle).label = 'Display mutation';
    preview.command.reads!.length = 0;
    preview.record.writes[0].before = { state: 'present', value: 'Changed' };
    const result = finishTrackLabel(freezeJson(roundtrip(basis)), set(fixture.input.label));
    expect(result.command).toEqual(fixture.command);
    expect(result.bundle).toEqual(fixture.after_bundle);
    expect(basis).toEqual(snapshot);
    expect(finishTrackLabel(basis, clear).command.expect).toEqual(fixture.command.expect);
  });

  it('captures dependent edits from the previous local authored result', () => {
    const a = finishTrackLabel(captureTrackLabel(original, ref), set('A'));
    const bBasis = freezeJson(roundtrip(captureTrackLabel(a.bundle, ref)));
    track(a.bundle).label = 'Later refresh';
    const b = finishTrackLabel(bBasis, set('B'));
    expect(b.command.expect).toEqual({ [address]: { state: 'present', value: 'A' } });
    expect(track(b.bundle).label).toBe('B');
    expect(b.bundle.source_mapping).toEqual(original.source_mapping);
    expect(b.bundle.base_parent).toEqual(original.base_parent);
  });

  it('preserves opaque fields, ordering, raw source windows and source pins without timing guards', () => {
    const input = copy(original);
    const config = input.parent.config as Record<string, JSON>;
    config.tracks = [
      { id: 'unrelated', label: null, order: 9, extension: { opaque: [null, false, {}] } },
      { ...track(input), order: 1, label: null, hidden: true, extension: { absent: null } },
    ];
    // A scalar preview must not normalize even contradictory opaque/legacy clip mirrors.
    input.parent.clips = [{ id: 'source', from: 1.125, to: 3.25, timeMap: { keep: [null] } }];
    config.clips = [{ id: 'different-mirror', from_ms: 100, to_ms: 500, speed: null }];
    input.placements = [{ occurrence_id: 'o', shot_id: 's', source_offset: 4.25, speed: 2 }];
    input.shots = { s: { internal_timeline: { tracks: [{ id: 'picture', label: 'Child' }] } } };
    const snapshot = copy(input);
    const basis = captureTrackLabel(freezeJson(input), ref);
    const result = finishTrackLabel(basis, set('Parent'));
    const expected = copy(snapshot);
    track(expected).label = 'Parent';
    expect(result.bundle).toEqual(expected);
    expect(result.command.reads).toEqual(fixture.command.reads);
    expect(result.command.selections).toEqual([]);
    expect(result.command.created).toEqual([]);
    expect(result.record.derived_writes).toEqual([]);
    expect(result.bundle.source_mapping).toEqual(snapshot.source_mapping);
    expect(result.bundle.base_parent_payload).toEqual(snapshot.base_parent_payload);
    expect(input).toEqual(snapshot);
  });

  it.each(['lane:é 🎬', 'with spaces', '0', '__proto__', 'dotted.id[0]'])('uses raw stable identity %s', (id) => {
    const input = copy(original);
    track(input).id = id;
    const target = `parent/track:${id}`;
    const result = finishTrackLabel(captureTrackLabel(input, target), set('Label'));
    expect(result.command.select).toBe(target);
    expect(result.command.bindings).toEqual({ 'scalar.target': target });
    expect(result.command.reads).toEqual([{ ref: target, path: ['id'], state: { state: 'present', value: id } }]);
    expect(result.command.expect).toEqual({ [`${target}::label`]: { state: 'absent' } });
  });

  it.each([
    'track:picture', 'picture', 'parent', 'parent/clip:picture', 'parent/track:',
    'occurrence:o/track:picture', 'shot:s/track:picture', 'shared:s/track:picture',
    'parent/track:picture::label', 'parent/track:picture/child', 'parent/track:picture,track:other',
  ])('refuses unsupported or missing target %s', (target) => {
    expect(() => captureTrackLabel(original, target)).toThrow();
  });

  it.each(['missing', 'duplicate', 'non-array', 'missing-config', 'missing-source-pin'])('refuses %s authored input', (damage) => {
    const input = copy(original);
    const config = input.parent.config as Record<string, JSON>;
    if (damage === 'missing') config.tracks = [{ id: 'other', label: 'Picture' }];
    if (damage === 'duplicate') (config.tracks as JSON[]).push(copy(track(input)));
    if (damage === 'non-array') config.tracks = { picture: track(input) };
    if (damage === 'missing-config') delete input.parent.config;
    if (damage === 'missing-source-pin') delete input.base_parent;
    const snapshot = copy(input);
    expect(() => captureTrackLabel(input, ref)).toThrow();
    expect(input).toEqual(snapshot);
  });

  it.each([
    undefined, null, '', { label: 'Wrong shape' }, { values: { label: 'A' } }, { clear: ['label'] },
    { values: {}, clear: [] }, { values: { label: null }, clear: [] },
    { values: { label: undefined }, clear: [] }, { values: { label: false }, clear: [] },
    { values: { label: 0 }, clear: [] }, { values: { label: {} }, clear: [] },
    { values: { label: 'A' }, clear: ['label'] }, { values: {}, clear: ['label', 'label'] },
    { values: {}, clear: ['name'] }, { values: { name: 'A' }, clear: [] },
    { values: { label: 'A', id: 'new' }, clear: [] }, { values: { label: 'A' }, clear: [], extra: null },
  ])('refuses invalid label args %j without coercion', (args) => {
    const basis = captureTrackLabel(original, ref);
    const snapshot = copy(basis);
    expect(() => finishTrackLabel(basis, args as TrackLabelArgs)).toThrow();
    expect(basis).toEqual(snapshot);
  });

  it('refuses refreshed original values and identities rather than recapturing them', () => {
    for (const damage of ['label', 'id', 'duplicate']) {
      const basis = roundtrip(captureTrackLabel(original, ref));
      if (damage === 'label') track(basis.bundle).label = null;
      if (damage === 'id') track(basis.bundle).id = 'replacement';
      if (damage === 'duplicate') {
        const tracks = (basis.bundle.parent.config as Record<string, JSON>).tracks as JSON[];
        tracks.push(copy(track(basis.bundle)));
      }
      const snapshot = copy(basis);
      expect(() => finishTrackLabel(freezeJson(basis), set('New'))).toThrow();
      expect(basis).toEqual(snapshot);
    }
  });

  it('refuses missing or forged capture claims', () => {
    const fields = ['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created'] as const;
    for (const key of fields) {
      const incomplete = roundtrip(captureTrackLabel(original, ref));
      delete incomplete.command[key];
      expect(() => finishTrackLabel(incomplete, set('A')), key).toThrow('incomplete track label basis');
      const forged = roundtrip(captureTrackLabel(original, ref));
      Object.assign(forged.command, { [key]: key === 'expect' || key === 'authorship' || key === 'bindings'
        ? { forged: 'value' } : ['forged'] });
      expect(() => finishTrackLabel(forged, set('A')), key).toThrow('original capture');
    }
    expect(() => finishTrackLabel({}, set('A'))).toThrow('incomplete track label basis');
  });

  it.each([
    { op: 'clip.set-params' }, { version: '2' }, { schema_version: 2 },
    { select: 'occurrence:o/track:picture' }, { intent: { ownership: 'shared' } },
  ])('refuses changed operation or scope %j', (change) => {
    const basis = roundtrip(captureTrackLabel(original, ref));
    Object.assign(basis.command, change);
    expect(() => finishTrackLabel(basis, set('A'))).toThrow();
  });

  it.each([undefined, NaN, Infinity, new Date(), new Map(), () => 'x'])('refuses non-JSON authored input %s', (value) => {
    const input = copy(original);
    Object.assign(input.parent, { invalid: value });
    expect(() => captureTrackLabel(input, ref)).toThrow('finite JSON');
  });
});

import { describe, expect, it } from 'vitest';
import type { CommandRecord, EditCommand, JSON as JsonValue } from '@/integrations/runtime/timeline-commit-types.ts';
import { captureClipMove, executeClipMove, finishClipMove } from './clipMoveCapture.ts';
import type { AuthoredBundle } from './clipMoveCapture.ts';
import { AuthoredState } from './clipMovePrimitives.ts';
import fixture from './fixtures/recipe_m1_move.json';

/* Inputs: Agent tests/editing_conformance/fixtures/recipe_m1_{move,occurrence,shared}.json,
 * plus sequential/container/shared-materialization cases using its real authored bundle.
 * Check from App's root (append --update to regenerate from the retained inputs):
 * PYTHONPATH=/home/user/work/wt/agt-m1-core-integration-fix /home/user/work/venv-agent/bin/python src/tools/video-editor/commands/fixtures/clip_move_parity.py
 */
type Golden = {
  name: string;
  bundle: AuthoredBundle;
  select: string;
  on: number;
  command: EditCommand;
  after_bundle: AuthoredBundle;
  record: CommandRecord;
  head_bundle?: AuthoredBundle;
  rebased_bundle?: AuthoredBundle;
  rebased_record?: CommandRecord;
};
const goldens = [fixture, ...fixture.cases] as unknown as Golden[];
const named = (name: string) => goldens.find((golden) => golden.name === name)!;
const detached = <T>(value: T): T => structuredClone(value);
const roundtrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const clip = (bundle: AuthoredBundle, ref: string = fixture.select) => new AuthoredState(bundle).entity(ref)!;

describe('Agent built-in clip.move capture parity', () => {
  for (const golden of goldens) {
    it(`matches exact command, authored bundle and recorder: ${golden.name}`, () => {
      const input = detached(golden.bundle);
      const basis = captureClipMove(input, golden.select);
      const result = finishClipMove(basis, golden.on);
      expect(result.command).toEqual(golden.command);
      expect(result.bundle).toEqual(golden.after_bundle);
      expect(result.record).toEqual(golden.record);
      expect(input).toEqual(golden.bundle);
      expect(executeClipMove(input, golden.command)).toEqual(result);
      // The real UI port clones and freezes the finite JSON returned by capture.
      const jsonBasis: { [key: string]: JsonValue } = basis;
      expect(finishClipMove(freeze(detached(jsonBasis)), golden.on)).toEqual(result);
      expect(finishClipMove(freeze(roundtrip(jsonBasis)), golden.on)).toEqual(result);
    });
  }

  it('captures before preview and keeps the original basis across repeated finish and input mutation', () => {
    const input = detached(fixture.bundle) as AuthoredBundle;
    const basis = captureClipMove(input, fixture.select);
    const portable = freeze(roundtrip(detached(basis)));
    expect(Object.isFrozen(basis)).toBe(true);
    expect(Object.isFrozen(clip(basis.bundle))).toBe(true);
    expect(Object.isFrozen(basis.command.reads![0].state)).toBe(true);
    const preview = finishClipMove(portable, 5);
    clip(input).at = 999;
    clip(preview.bundle).at = 999;
    preview.command.reads!.length = 0;
    const drop = finishClipMove(portable, fixture.on);
    expect(drop.command).toEqual(fixture.command);
    expect(drop.bundle).toEqual(fixture.after_bundle);
    expect(() => finishClipMove({}, 4)).toThrow('incomplete clip move basis');
  });

  it('does not turn a portable original capture into a refreshed basis or recapture missing claims', () => {
    const basis = captureClipMove(fixture.bundle as AuthoredBundle, fixture.select);
    const refreshed = roundtrip(basis);
    clip(refreshed.bundle).at = 99;
    expect(() => finishClipMove(freeze(refreshed), fixture.on)).toThrow('original capture');
    for (const field of ['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created']) {
      const incomplete = roundtrip(basis);
      delete (incomplete.command as Record<string, unknown>)[field];
      expect(() => finishClipMove(incomplete, fixture.on), field).toThrow('incomplete clip move basis');
    }
  });

  it('captures unacknowledged B7 from the authored A5 result, with A5 guards intact', () => {
    const aGolden = named('sequential_A5');
    const a = finishClipMove(freeze(roundtrip(captureClipMove(aGolden.bundle, aGolden.select))), 5);
    expect(a.bundle).toEqual(aGolden.after_bundle);
    const bBasis = freeze(detached(captureClipMove(a.bundle, aGolden.select)));
    clip(a.bundle, aGolden.select).at = 999;
    const b = finishClipMove(bBasis, 7);
    expect(b.command).toEqual(named('sequential_B7').command);
    expect(b.bundle).toEqual(named('sequential_B7').after_bundle);
    expect(b.command.expect![`${aGolden.select}::at`]).toEqual({ state: 'present', value: 5 });
    expect(b.command.expect![`${aGolden.select}::app.astrid.on`]).toEqual({ state: 'absent' });
    expect(clip(b.bundle, aGolden.select).at).toBe(7);
    expect(() => executeClipMove(aGolden.bundle, b.command)).toThrow('original capture');
  });

  it('keeps unchanged writes and absent clears while preserving opaque app fields', () => {
    const golden = named('same_value');
    const result = finishClipMove(captureClipMove(golden.bundle, golden.select), golden.on);
    expect(result.bundle).toEqual(golden.bundle);
    expect(result.record.writes).toContainEqual({ ref: golden.select, path: ['at'],
      before: { state: 'present', value: 5 }, after: { state: 'present', value: 5 } });
    expect(result.record.writes).toContainEqual({ ref: golden.select, path: ['app', 'on'],
      before: { state: 'absent' }, after: { state: 'absent' } });
    expect(clip(result.bundle).app).toMatchObject({ opaque: { keep: true }, astrid: { fixed_start: true, for: 2 } });
  });

  it('isolates repeated shared children and retains semantic guards across first materialization', () => {
    const aGolden = named('repeated_shared_A');
    const a = finishClipMove(captureClipMove(aGolden.bundle, aGolden.select), aGolden.on);
    const sibling = 'occurrence:o2/clip:c';
    expect(clip(a.bundle, sibling)).toEqual(clip(aGolden.bundle, sibling));
    const b = finishClipMove(captureClipMove(a.bundle, aGolden.select), 14);
    const materialized = named('disjoint_same_child_first_materialization_B');
    expect(b.command).toEqual(named('repeated_shared_B').command);
    const applied = executeClipMove(materialized.bundle, b.command);
    expect(applied.command).toEqual(b.command);
    expect(applied.bundle).toEqual(materialized.after_bundle);
    expect(clip(applied.bundle, aGolden.select).opaque_disjoint).toEqual({ keep: true });
    expect(applied.record.dependencies.find((dependency) => dependency.key === 'move.images'))
      .not.toEqual(b.record.dependencies.find((dependency) => dependency.key === 'move.images'));
    expect(b.command.reads!.some((read) => read.path.some((key) => key.includes('revision') || key.includes('digest')))).toBe(false);
  });

  it('retains original source claims when a shared sibling materializes through main', () => {
    const golden = named('canonical_shared_owner');
    const basis = freeze(roundtrip(captureClipMove(golden.bundle, golden.select)));
    const captured = finishClipMove(basis, golden.on);
    const applied = executeClipMove(golden.head_bundle!, captured.command);
    expect(applied.command).toEqual(captured.command);
    expect(applied.bundle).toEqual(golden.rebased_bundle);
    expect(applied.record).toEqual(golden.rebased_record);
    expect(finishClipMove(basis, golden.on)).toEqual(captured);
    const changed = detached(golden.head_bundle!);
    const row = changed.placements.find((row) => `occurrence:${row.occurrence_id}` === golden.select.split('/')[0])!;
    const sources = (changed.source_mapping as Record<string, unknown>).shots as Record<string, { shot_id: string }>;
    sources[String(row.shot_id)].shot_id = 'shot-placement-forged-source';
    expect(() => executeClipMove(changed, captured.command)).toThrow();
  });

  it('uses occurrence ownership only for occurrence targets', () => {
    const parent = finishClipMove(captureClipMove(fixture.bundle as AuthoredBundle, fixture.select), fixture.on);
    expect(parent.command.intent).toEqual({ ripple: 'none', anchor: 'fixed', position: 'absolute' });
    expect(() => executeClipMove(fixture.bundle as AuthoredBundle, {
      ...parent.command, intent: { ...parent.command.intent, ownership: 'occurrence' },
    })).toThrow('intention');
    expect(named('repeated_shared_A').command.intent?.ownership).toBe('occurrence');
  });

  it('distinguishes absent/null and boolean/number guards', () => {
    const golden = named('sequential_B7');
    const changed = detached(golden.bundle);
    (clip(changed).app as Record<string, unknown>).on = null;
    expect(() => executeClipMove(changed, golden.command)).toThrow('original capture');
    const forged = detached(golden.command);
    forged.expect![`${golden.select}::app.astrid.fixed_start`] = { state: 'present', value: 1 };
    expect(() => executeClipMove(golden.bundle, forged)).toThrow('original capture');
  });

  it.each([
    ['negative', -1], ['nan', NaN], ['infinite', Infinity], ['boolean', true],
  ])('refuses invalid target %s', (_label, on) => {
    expect(() => finishClipMove(captureClipMove(fixture.bundle as AuthoredBundle, fixture.select), on as number)).toThrow();
  });

  it.each([
    ['undefined', undefined], ['NaN', NaN], ['infinity', Infinity], ['negative infinity', -Infinity],
    ['bigint', 1n], ['date', new Date(0)], ['map', new Map()], ['set', new Set()],
    ['undefined element', [undefined]], ['sparse array', Array(1)],
  ])('refuses non-JSON capture data %s instead of losing presence on roundtrip', (_name, value) => {
    const input = detached(fixture.bundle) as AuthoredBundle;
    (clip(input) as Record<string, unknown>).opaque = value;
    expect(() => captureClipMove(input, fixture.select)).toThrow('finite JSON');
    const basis = roundtrip(captureClipMove(fixture.bundle as AuthoredBundle, fixture.select));
    (clip(basis.bundle) as Record<string, unknown>).opaque = value;
    expect(() => finishClipMove(basis, fixture.on)).toThrow('finite JSON');
  });

  it('refuses cyclic capture data', () => {
    const input = detached(fixture.bundle) as AuthoredBundle;
    clip(input).opaque = input;
    expect(() => captureClipMove(input, fixture.select)).toThrow('finite JSON');
  });

  it.each([
    ['speed', 0], ['speed', -1], ['speed', { numerator: 1, denominator: 1 }],
    ['time_map', {}], ['timeMap', {}], ['children', []], ['clips', []],
    ['from_ms', 0], ['to_ms', 1000], ['duration', 99], ['at_ms', 99999],
  ])('refuses unsupported clip timing %s=%j', (key, value) => {
    const input = detached(fixture.bundle) as AuthoredBundle;
    clip(input)[key] = value;
    expect(() => captureClipMove(input, fixture.select)).toThrow();
  });

  it.each(['sequence', 'sequence_index', 'sequence_fit', 'formulas'])('refuses %s timing', (key) => {
    const input = detached(fixture.bundle) as AuthoredBundle;
    (clip(input).app as Record<string, unknown>)[key] = 'unsupported';
    expect(() => captureClipMove(input, fixture.select)).toThrow();
  });

  it.each([
    ['source_offset', 1], ['source_offset', { start: 0 }], ['speed', true],
    ['speed', 2], ['speed', { numerator: 1, denominator: 1 }], ['time_map', {}],
  ])('refuses unsupported occurrence mapping %s=%j', (key, value) => {
    const golden = named('repeated_shared_A');
    const input = detached(golden.bundle);
    input.placements[0][key] = value;
    expect(() => captureClipMove(input, golden.select)).toThrow('translation-only');
  });

  it('refuses intervals before the occurrence or crossing its next blocker, with a half-open end', () => {
    const golden = named('repeated_shared_A');
    const input = detached(golden.bundle);
    input.parent.config = { ...(input.parent.config as Record<string, never>), output: { fps: 30 } };
    const basis = captureClipMove(input, golden.select);
    expect(() => finishClipMove(basis, 9)).toThrow('precedes');
    expect(() => finishClipMove(basis, 18.1)).toThrow('crosses');
    expect(() => finishClipMove(basis, 20)).toThrow('crosses');
    expect(finishClipMove(basis, 18).previewAt).toBe(18);
  });

  it('refuses missing/ambiguous stable identities and never interprets projected IDs', () => {
    for (const ref of ['parent/clip:missing', 'o:c', 'shot:s/clip:c']) {
      expect(() => captureClipMove(fixture.bundle as AuthoredBundle, ref)).toThrow();
    }
    const input = detached(fixture.bundle) as AuthoredBundle;
    (input.parent.clips as unknown[]).push(detached(clip(input)));
    expect(() => captureClipMove(input, fixture.select)).toThrow('ambiguous');
  });

  it('rejects changed source/rate/owner/selection and forged incomplete claims', () => {
    const golden = named('repeated_shared_A');
    const command = golden.command;
    for (const change of ['rate', 'owner', 'blocker', 'order', 'source']) {
      const input = detached(golden.bundle);
      if (change === 'rate') (input.parent.config as Record<string, unknown>).output = { fps: 25 };
      if (change === 'owner') input.placements[0].shot_id = input.placements[1].shot_id;
      if (change === 'blocker') input.placements.push({ ...detached(input.placements[1]), occurrence_id: 'new' });
      if (change === 'order') input.placements.reverse();
      if (change === 'source') clip(input, golden.select).asset = 'other-source';
      expect(() => executeClipMove(input, command), change).toThrow();
    }
    expect(() => executeClipMove(golden.bundle, { ...command, reads: [] })).toThrow('original capture');
  });

  it('guards consumed media identity while retaining revision-image pins only as provenance', () => {
    const golden = named('registry_source');
    const changed = detached(golden.bundle);
    const registry = changed.parent.registry as { assets: { source: { media_id: string } } };
    registry.assets.source.media_id = 'sha256:other';
    expect(() => executeClipMove(changed, golden.command)).toThrow('original capture');
    const disjoint = detached(golden.bundle);
    disjoint.base_parent = { revision_id: 'new-parent', content_digest: 'sha256:new-image' };
    expect(executeClipMove(disjoint, golden.command).command).toEqual(golden.command);
  });

  it('records compiler synchronization of the nonempty config clip mirror', () => {
    const input = detached(fixture.bundle) as AuthoredBundle;
    (input.parent.config as Record<string, unknown>).clips = [{ id: 'legacy', at: 88 }];
    const result = finishClipMove(captureClipMove(input, fixture.select), 4);
    expect((result.bundle.parent.config as Record<string, unknown>).clips).toEqual(result.bundle.parent.clips);
    expect(result.record.derived_writes).toEqual([{ ref: 'parent', path: ['config', 'clips'],
      before: { state: 'present', value: [{ id: 'legacy', at: 88 }] },
      after: { state: 'present', value: result.bundle.parent.clips }, cause: 0 }]);
    expect((input.parent.config as Record<string, unknown>).clips).toEqual([{ id: 'legacy', at: 88 }]);
  });

  it('fails closed on clipped negative starts, contradictory occurrence codecs and unequal child fps', () => {
    const golden = named('repeated_shared_A');
    const input = detached(golden.bundle);
    clip(input, golden.select).at = -0.001;
    expect(() => captureClipMove(input, golden.select)).toThrow();
    const codecs = detached(golden.bundle);
    codecs.placements[0].at_ms = 10001;
    expect(() => captureClipMove(codecs, golden.select)).toThrow('contradictory occurrence');
    const rate = detached(golden.bundle);
    new AuthoredState(rate).config('occurrence:o').output = { fps: 25 };
    expect(() => captureClipMove(rate, golden.select)).toThrow('parent and child fps differ');
  });
});

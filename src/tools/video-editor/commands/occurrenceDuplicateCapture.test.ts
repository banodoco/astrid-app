import { describe, expect, it } from 'vitest';
import type { CanonicalDocument, CommandRecord, EditCommand, JSON } from '@/integrations/runtime/timeline-commit-types.ts';
import { stableOccurrenceDeepLink, stableOutputIdentity } from '../data/shotComposition.ts';
import { authoringBundleFromDocument } from './authoringBundle.ts';
import { AuthoredState, copy, freezeJson, type AuthoredBundle } from './clipMovePrimitives.ts';
import { captureOccurrenceDuplicate, executeOccurrenceDuplicate, finishOccurrenceDuplicate } from './occurrenceDuplicateCapture.ts';
import fixture from './fixtures/recipe_m2_app_occurrence_duplicate.json';

const golden = fixture as unknown as {
  bundle: AuthoredBundle; command: EditCommand; after_bundle: AuthoredBundle;
  records: CommandRecord[]; after_document: CanonicalDocument;
};
type ObjectValue = { [key: string]: JSON };
const clips = (bundle: AuthoredBundle, ref = owner) => new AuthoredState(bundle).config(ref).clips as ObjectValue[];
const args = { occurrence_id: 'occ-copy', shot_id: 'shot-copy' };
const owner = 'occurrence:occ-0';
const capture = (input = golden.bundle) => captureOccurrenceDuplicate(input, owner, args);

describe('staged native independent occurrence duplicate capture', () => {
  it('matches the authoritative Agent capture, writes, and authoring state exactly', () => {
    const input = freezeJson(copy(golden.bundle));
    const basis = capture(input);
    const result = finishOccurrenceDuplicate(basis);
    expect(result.command).toEqual(golden.command);
    expect(result.record).toEqual(golden.records[0]);
    expect(result.bundle).toEqual(golden.after_bundle);
    expect(input).toEqual(golden.bundle);
    expect(Object.isFrozen(basis.command.args)).toBe(true);
    expect(result.record.writes.map((write) => write.ref)).toEqual(['shot:shot-copy', 'occurrence:occ-copy']);
  });

  it('replays the serialized original basis and never changes reserved IDs', () => {
    const basis = capture();
    expect(finishOccurrenceDuplicate(JSON.parse(JSON.stringify(basis)))).toEqual(finishOccurrenceDuplicate(basis));
    const forged = copy(basis);
    forged.command.args.occurrence_id = 'replacement';
    expect(() => finishOccurrenceDuplicate(forged)).toThrow('capture');
  });

  it('preserves shared source owners and isolates exactly one independent copy', () => {
    const result = finishOccurrenceDuplicate(capture());
    expect(result.bundle.parent.config).toEqual(golden.bundle.parent.config);
    expect(result.bundle.placements.slice(0, -1)).toEqual(golden.bundle.placements);
    for (const [id, shot] of Object.entries(golden.bundle.shots)) expect(result.bundle.shots[id]).toEqual(shot);
    const state = new AuthoredState(result.bundle);
    expect(state.config('occurrence:occ-copy')).toEqual(new AuthoredState(golden.bundle).config(owner));
    clips(result.bundle, 'occurrence:occ-copy')[0].hold = 99;
    expect(clips(result.bundle)[0].hold).toBe(2);
    expect(clips(result.bundle, 'occurrence:occ-1')[0].hold).toBe(2);
  });

  it('records destination roots before compiled projection can normalize them', () => {
    const result = finishOccurrenceDuplicate(capture());
    const raw = result.record.writes.find((write) => write.ref === 'occurrence:occ-copy')!.after;
    const expected = fixture.after_document.parent_revision.payload.occurrences
      .find((row) => row.occurrence_id === 'occ-copy')!;
    expect(raw).toEqual({ state: 'present', value: result.bundle.placements.at(-1) });
    expect((raw.value as ObjectValue).stable_deep_link).toBe(expected.stable_deep_link);
    expect((raw.value as ObjectValue).output_identity).toBe(expected.output_identity);
  });

  it('checks RAW compiled root identities and exact immutable shot/internal closure from Agent', async () => {
    const document = fixture.after_document;
    const rows = document.parent_revision.payload.occurrences;
    const source = rows.find((row) => row.occurrence_id === 'occ-0')!;
    const copied = rows.find((row) => row.occurrence_id === 'occ-copy')!;
    expect(copied.stable_deep_link).toBe(stableOccurrenceDeepLink('project-1', 'doc /é', 'shot-copy', copied.shot_revision_id, 'occ-copy'));
    expect(copied.output_identity).toBe(stableOutputIdentity('project-1', 'doc /é', 'occ-copy'));
    expect(copied.stable_deep_link).not.toBe(source.stable_deep_link);
    expect(copied.output_identity).not.toBe(source.output_identity);
    const exceptRoots = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) =>
      !['occurrence_id', 'shot_id', 'shot_revision_id', 'stable_deep_link', 'output_identity'].includes(key)));
    expect(exceptRoots(copied)).toEqual(exceptRoots(source));
    expect(copied.output_records).toEqual(source.output_records);
    expect(copied.metadata).toEqual(source.metadata);
    const shot = document.shot_revisions.find((row) => row.shot_id === copied.shot_id && row.revision_id === copied.shot_revision_id)!;
    expect(shot).toBeDefined();
    expect(document.internal_timeline_revisions.some((row) => row.revision_id === shot.internal_timeline_revision_id)).toBe(true);
    const sourceShot = document.shot_revisions.find((row) => row.shot_id === source.shot_id && row.revision_id === source.shot_revision_id)!;
    const sourceInternal = document.internal_timeline_revisions.find((row) => row.revision_id === sourceShot.internal_timeline_revision_id)!;
    const copiedInternal = document.internal_timeline_revisions.find((row) => row.revision_id === shot.internal_timeline_revision_id)!;
    expect(shot.shot_revision_id).not.toBe(source.shot_revision_id);
    expect(shot.internal_timeline_revision_id).not.toBe(sourceShot.internal_timeline_revision_id);
    expect(copiedInternal.payload).toEqual(sourceInternal.payload);
    // Opening the accepted closure retains the raw values; the App does not repair them on read.
    const opened = await authoringBundleFromDocument(copy(document) as unknown as CanonicalDocument);
    expect(opened.placements.find((row) => row.occurrence_id === 'occ-copy')!.stable_deep_link).toBe(copied.stable_deep_link);
    expect(opened.source_mapping._runtime_document).toEqual(document);
    expect(golden.after_bundle.placements.at(-1)!.stable_deep_link).toBe(copied.stable_deep_link);
  });

  it('keeps linked source reuse while assigning the copy its own shot revision', () => {
    const result = finishOccurrenceDuplicate(capture());
    const source = result.bundle.placements.find((row) => row.occurrence_id === 'occ-0')!;
    const copied = result.bundle.placements.find((row) => row.occurrence_id === 'occ-copy')!;

    expect(new AuthoredState(result.bundle).config('occurrence:occ-1'))
      .toEqual(new AuthoredState(result.bundle).config('occurrence:occ-0'));
    expect(copied.shot_id).toBe('shot-copy');
    expect(copied.shot_id).not.toBe(source.shot_id);
    expect(copied.stable_deep_link).not.toBe(source.stable_deep_link);
  });

  it.each(['parent', 'shot:chapter-shot', 'occ-0', 'occurrence:missing', 'occurrence:occ-0/clip:clip-a'])('refuses unknown or non-occurrence owner %s', (ref) => {
    expect(() => captureOccurrenceDuplicate(golden.bundle, ref, args)).toThrow();
  });

  it.each([
    { intent: { ownership: 'shared' } }, { version: '2' },
    { args: { ...args, shared: true } }, { args: { ...args, shot_id: 'bad/id' } },
    { args: { ...args, occurrence_id: 'bad::id' } },
    { args: { ...args, shot_id: 'chapter-shot' } },
    { args: { ...args, occurrence_id: 'occ-0' } },
  ])('refuses unsupported scope or reservations %j atomically', (overrides) => {
    const input = copy(golden.bundle);
    expect(() => executeOccurrenceDuplicate(input, { ...golden.command, ...overrides } as EditCommand)).toThrow();
    expect(input).toEqual(golden.bundle);
  });

  it.each(['shot', 'occurrence', 'derived-item', 'published-shot', 'legacy-group'])('refuses %s destination or ownership collision', (kind) => {
    const input = copy(golden.bundle);
    if (kind === 'shot') input.shots['shot-copy'] = copy(Object.values(input.shots)[0]);
    if (kind === 'occurrence') input.placements.push({ ...copy(input.placements[0]), occurrence_id: 'occ-copy' });
    if (kind === 'derived-item') {
      const items = (Object.values(input.shots)[1].payload as ObjectValue).items as JSON[];
      items.push(copy(((golden.after_bundle.shots['shot-copy'].payload as ObjectValue).items as JSON[])[0]));
    }
    if (kind === 'published-shot') {
      const document = (input.source_mapping as ObjectValue)._runtime_document as unknown as CanonicalDocument;
      document.shot_revisions[0].shot_id = 'shot-copy';
    }
    if (kind === 'legacy-group') (input.parent.config as ObjectValue).pinnedShotGroups = [{ opaque: 'group' }];
    const before = copy(input);
    expect(() => capture(input)).toThrow(/occupied|migration/);
    expect(input).toEqual(before);
  });

  it.each(['row', 'payload', 'internal', 'selection'])('retains original %s guards on replay', (kind) => {
    const input = copy(golden.bundle);
    const shot = input.shots[String(input.placements[0].shot_id)];
    if (kind === 'row') input.placements[0].task_id = 'different';
    if (kind === 'payload') (shot.payload as ObjectValue).unknown = null;
    if (kind === 'internal') clips(input)[0].hold = 4;
    if (kind === 'selection') clips(input).reverse();
    expect(() => executeOccurrenceDuplicate(input, golden.command)).toThrow('capture');
  });

  it('keeps absent root identities absent and preserves identity-like nested values', () => {
    const input = copy(golden.bundle);
    delete input.placements[0].stable_deep_link;
    delete input.placements[0].output_identity;
    const result = finishOccurrenceDuplicate(capture(input));
    expect(result.bundle.placements.at(-1)).toEqual({ ...input.placements[0], ...args });
    expect(result.bundle.placements.at(-1)).not.toHaveProperty('output_identity');
  });

  it.each(['resolved', 'expect', 'authorship', 'reads', 'selections', 'bindings', 'created'] as const)('refuses missing or forged %s', (key) => {
    const incomplete = copy(capture());
    delete incomplete.command[key];
    expect(() => finishOccurrenceDuplicate(incomplete)).toThrow('incomplete');
    const forged = copy(capture());
    forged.command[key] = (Array.isArray(forged.command[key]) ? [] : {}) as never;
    expect(() => finishOccurrenceDuplicate(forged)).toThrow('capture');
  });
});

import { describe, expect, it } from 'vitest';
import type { TimelinePatch } from '@/sdk/video/timeline/patch.ts';
import { authoringBundleFromDocument } from './authoringBundle.ts';
import {
  captureOrdinaryStructuralBatch,
  executeOrdinaryStructuralBatch,
  OrdinaryStructuralRefusal,
  projectOrdinaryStructuralPreview,
} from './ordinaryStructuralMember.ts';
import { copy, freezeJson } from './clipMovePrimitives.ts';
import { environment } from './__tests__/commitSessionEnvironment.ts';

const structuralPatch = (): TimelinePatch => ({ version: 1, operations: [
  { op: 'track.add', target: 'ordinary-track', payload: { kind: 'visual', role: 'output', label: 'Ordinary' }, order: 0 },
  { op: 'clip.add', target: 'ordinary-clip', payload: {
    track: 'ordinary-track', at: 1.25, hold: 2.5, clipType: 'hold', app: { opaque: { keep: [null, false] } },
  }, order: 1 },
  { op: 'clip.remove', target: 'ordinary-clip', order: 2 },
] });

describe('ordinary structural native batch member', () => {
  it('captures track birth plus non-media add/remove in one ordered command array', async () => {
    const env = await environment();
    const bundle = await authoringBundleFromDocument(env.initial.canonicalDocument);
    const original = freezeJson(copy(bundle));
    const patch = structuralPatch();
    const captured = captureOrdinaryStructuralBatch(bundle, patch);

    expect(captured.commands.map((command) => command.op)).toEqual(['track.create', 'clip.add', 'clip.delete']);
    expect(captured.commands.map((command) => command.created)).toEqual([
      ['parent/track:ordinary-track'],
      ['parent/clip:ordinary-clip'],
      [],
    ]);
    expect(captured.records.map((record) => record.ordinal)).toEqual([0, 1, 2]);
    expect(captured.commands[0].selections?.[0].order).toEqual(['parent/track:V1']);
    expect(captured.commands[1].selections?.[0].order).toEqual(['parent/clip:x']);
    expect(captured.commands[2].expect?.['parent/clip:ordinary-clip::']).toMatchObject({ state: 'present' });
    expect(executeOrdinaryStructuralBatch(original, captured.commands)).toEqual({
      bundle: captured.bundle,
      records: captured.records,
    });
    expect(bundle).toEqual(original);
    expect(Object.isFrozen(captured.patch.operations[0].payload)).toBe(true);
    expect(Object.isFrozen(captured.commands[1].args.row)).toBe(true);
  });

  it('replays a frozen capture with the same raw rows, claims, and opaque fields', async () => {
    const env = await environment();
    const bundle = await authoringBundleFromDocument(env.initial.canonicalDocument);
    const patch = structuralPatch();
    const basis = captureOrdinaryStructuralBatch(bundle, patch);
    const replayed = captureOrdinaryStructuralBatch(bundle, freezeJson(copy(patch)));

    expect(replayed.commands).toEqual(basis.commands);
    expect(replayed.records).toEqual(basis.records);
    expect(replayed.bundle).toEqual(basis.bundle);
    expect(replayed.commands[1].args.row.app).toEqual({ opaque: { keep: [null, false] } });
  });

  it('refuses collisions and media aliases atomically without mutating the authored bundle', async () => {
    const env = await environment();
    const bundle = await authoringBundleFromDocument(env.initial.canonicalDocument);
    const before = copy(bundle);
    const collision: TimelinePatch = { version: 1, operations: [
      { op: 'track.add', target: 'V1', payload: { kind: 'visual' } },
      { op: 'clip.add', target: 'not-submitted', payload: { track: 'V1', at: 0, hold: 1, clipType: 'hold' } },
    ] };
    expect(() => captureOrdinaryStructuralBatch(bundle, collision)).toThrow(OrdinaryStructuralRefusal);
    expect(bundle).toEqual(before);

    const media: TimelinePatch = { version: 1, operations: [
      { op: 'clip.add', target: 'media', payload: { track: 'V1', at: 0, hold: 1, clipType: 'video', asset: 'alias' } },
    ] };
    expect(() => captureOrdinaryStructuralBatch(bundle, media)).toThrow(OrdinaryStructuralRefusal);
    expect(bundle).toEqual(before);
  });

  it('projects only structural collections and leaves the displayed data lanes untouched', async () => {
    const env = await environment();
    const current = env.current();
    const before = copy(current);
    const patch: TimelinePatch = {
      ...structuralPatch(), source: 'timeline.native-structural',
      operations: structuralPatch().operations.slice(0, 2),
    };
    const next = projectOrdinaryStructuralPreview(patch, current);

    expect(next.config.tracks?.some((track) => track.id === 'ordinary-track')).toBe(true);
    expect(next.config.clips?.some((clip) => clip.id === 'ordinary-clip')).toBe(true);
    expect(next.dataLanes).toBe(current.dataLanes);
    expect(current).toEqual(before);
  });
});

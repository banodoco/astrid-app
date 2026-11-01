import { describe, expect, it } from 'vitest';
import type { TimelinePatch } from '@/sdk/video/timeline/patch.ts';
import { authoringBundleFromDocument } from './authoringBundle.ts';
import trimFixture from './fixtures/recipe_m2_clip_trim.json';
import {
  captureGenericPatch,
  classifyGenericPatch,
  executeGenericPatch,
  GenericPatchRefusal,
  projectGenericPatchPreview,
} from './genericPatchCapture.ts';
import { AuthoredState, copy, freezeJson } from './clipMovePrimitives.ts';
import { environment } from './__tests__/commitSessionEnvironment.ts';

const nativePatch = (hold = 1.25): TimelinePatch => ({ version: 1, operations: [
  { op: 'track.update', target: 'V1', payload: { label: '', mode: 'merge' }, order: 2 },
  { op: 'clip.update', target: 'x', payload: { hold }, order: 1 },
] });

const trimOperation = (target = 'clip-a', payload: Record<string, unknown> = { in_s: 1, out_s: 5 }, order?: number) => ({
  op: 'clip.trim', target, payload, ...(order === undefined ? {} : { order }),
} as unknown as TimelinePatch['operations'][number]);

async function authoredBundle() {
  const env = await environment();
  return { env, bundle: await authoringBundleFromDocument(env.initial.canonicalDocument) };
}

describe('bounded native generic patch capture', () => {
  it('classifies the complete patch before native capture', () => {
    expect(classifyGenericPatch({ version: 1, operations: [
      { op: 'track.update', target: 'V1', payload: { label: 'Native' } },
      { op: 'clip.update', target: 'x', payload: { hold: 1.25 } },
    ] })).toBe('supported');
    expect(classifyGenericPatch({ version: 1, operations: [
      { op: 'track.update', target: 'V1', payload: { label: 'Native' } },
      { op: 'project-data.write', target: 'extension', payload: { value: 1 } },
    ] })).toBe('mixed');
    expect(classifyGenericPatch({ version: 1, operations: [
      { op: 'project-data.write', target: 'extension', payload: { value: 1 } },
    ] })).toBe('unsupported');
    expect(classifyGenericPatch({ version: 1, operations: [
      { op: 'clip.move', target: 'x', payload: { track: 'A1', at: 2 } },
    ] })).toBe('unsupported');
    expect(classifyGenericPatch({ version: 1, operations: [
      { op: 'clip.move', target: 'x', payload: { at: 2 } },
      { op: 'clip.move', target: 'y', payload: { track: 'A1', at: 3 } },
    ] })).toBe('mixed');
    expect(classifyGenericPatch({ version: 1, operations: [
      { op: 'clip.move', target: 'x', payload: { at: 2 } },
      { op: 'clip.update', target: 'x', payload: { values: { hold: 3 }, clear: [] } },
      { op: 'clip.move', target: 'y', payload: { at: 6 } },
      { op: 'clip.update', target: 'y', payload: { values: { hold: 4 }, clear: [] } },
    ] })).toBe('supported');
  });

  it('captures one ordered command list against one sequential authored bundle', async () => {
    const { bundle } = await authoredBundle();
    const input = nativePatch(1.23456789);
    const originalBundle = freezeJson(copy(bundle));
    const originalPatch = copy(input);
    const result = captureGenericPatch(bundle, input, (operation) =>
      operation.op === 'track.update' ? 'parent/track:V1' : 'parent/clip:x');

    expect(result.commands.map((command) => command.op)).toEqual(['clip.set', 'track.set']);
    expect(result.commands[0].args).toEqual({ values: { hold: 1.23456789 }, clear: [] });
    expect(result.commands[1].args).toEqual({ values: { label: '' }, clear: [] });
    expect(result.commands[0].expect?.['parent/clip:x::hold']).toEqual({ state: 'present', value: 1 });
    expect(result.commands[1].expect?.['parent/track:V1::label']).toEqual({ state: 'absent' });
    expect(result.records.map((record) => record.ordinal)).toEqual([0, 1]);
    expect(executeGenericPatch(originalBundle, result.commands)).toEqual({
      bundle: result.bundle,
      records: result.records,
    });
    expect(bundle).toEqual(originalBundle);
    expect(input).toEqual(originalPatch);
    expect(Object.isFrozen(result.patch.operations[0].payload)).toBe(true);
    expect(Object.isFrozen(result.commands[0].expect)).toBe(true);
  });

  it('dispatches a supported trim member through the native command and record builders', async () => {
    const bundle = await authoringBundleFromDocument(structuredClone(trimFixture.input));
    const result = captureGenericPatch(bundle, {
      version: 1,
      operations: [trimOperation()],
    }, () => 'parent/clip:clip-a');

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({ op: 'clip.trim', select: 'parent/clip:clip-a',
      args: { in_s: 1, out_s: 5 } });
    expect(result.records[0]).toEqual(expect.objectContaining({ ordinal: 0,
      command: result.commands[0], writes: expect.arrayContaining([
        expect.objectContaining({ path: ['from'] }),
        expect.objectContaining({ path: ['to'] }),
        expect.objectContaining({ path: ['hold'] }),
      ]) }));
    expect(executeGenericPatch(structuredClone(bundle), result.commands)).toEqual({
      bundle: result.bundle, records: result.records,
    });
  });

  it('refuses a mixed unsupported batch before owner resolution or any authored write', async () => {
    const { bundle } = await authoredBundle();
    const patch: TimelinePatch = { version: 1, operations: [
      trimOperation('x', { in_s: 1, out_s: 5 }),
      { op: 'project-data.write', target: 'extension', payload: { value: 1 } },
    ] };
    const before = copy(bundle);
    let resolved = false;

    expect(classifyGenericPatch(patch)).toBe('mixed');
    expect(() => captureGenericPatch(bundle, patch, () => {
      resolved = true;
      return 'parent/clip:x';
    })).toThrow(GenericPatchRefusal);
    expect(resolved).toBe(false);
    expect(bundle).toEqual(before);
  });

  it('composes hold/clear, label, and absolute move into one replayable batch', async () => {
    const { bundle: source } = await authoredBundle();
    const bundle = copy(source);
    (bundle.parent.clips[0] as Record<string, unknown>).transition = { type: 'wipe' };
    const patch: TimelinePatch = { version: 1, operations: [
      { op: 'clip.update', target: 'x', payload: { values: { hold: 4 }, clear: ['transition'] }, order: 0 },
      { op: 'track.update', target: 'V1', payload: { label: 'Picture' }, order: 1 },
      { op: 'clip.move', target: 'x', payload: { at: 4 }, order: 2 },
    ] };
    const result = captureGenericPatch(bundle, patch, (operation) => operation.op === 'track.update'
      ? 'parent/track:V1' : 'parent/clip:x');

    expect(result.commands.map((command) => command.op)).toEqual(['clip.set', 'track.set', 'clip.move']);
    expect(result.records.map((record) => record.ordinal)).toEqual([0, 1, 2]);
    expect(result.preview.operations).toEqual([
      { op: 'clip.update', target: 'x', payload: { values: { hold: 4 }, clear: ['transition'] } },
      { op: 'track.update', target: 'V1', payload: { label: 'Picture' } },
      { op: 'clip.move', target: 'x', payload: { at: 4 } },
    ]);
    const replay = executeGenericPatch(copy(bundle), result.commands);
    expect(replay).toEqual({ bundle: result.bundle, records: result.records });
    expect(result.bundle.parent.clips[0]).toMatchObject({ hold: 4, at: 4 });
    expect(result.bundle.parent.clips[0]).not.toHaveProperty('transition');
  });

  it('carries a matching move-derived static duration through the producer hold member', async () => {
    const { bundle: source } = await authoredBundle();
    const bundle = copy(source);
    const clip = new AuthoredState(bundle).entity('parent/clip:x')!;
    clip.app = { opaque: { keep: [null, false] }, astrid: { for: 1 } };
    const patch: TimelinePatch = { version: 1, source: 'timeline.native-ordinary', operations: [
      { op: 'clip.move', target: 'x', payload: { at: 4 }, order: 0 },
      { op: 'clip.update', target: 'x', payload: { values: { hold: 5 }, clear: [] }, order: 1 },
    ] };

    const result = captureGenericPatch(bundle, patch, () => 'parent/clip:x');

    expect(result.commands.map((command) => command.op)).toEqual(['clip.move', 'clip.set']);
    expect(result.records[1]!.writes).toEqual([
      { ref: 'parent/clip:x', path: ['app', 'astrid', 'for'], before: { state: 'present', value: 1 }, after: { state: 'present', value: 5 } },
      { ref: 'parent/clip:x', path: ['hold'], before: { state: 'present', value: 1 }, after: { state: 'present', value: 5 } },
    ]);
    expect(new AuthoredState(result.bundle).entity('parent/clip:x')).toMatchObject({
      at: 4, hold: 5, app: { opaque: { keep: [null, false] }, astrid: { for: 5, fixed_start: true } },
    });

    const replay = executeGenericPatch(copy(bundle), result.commands);
    expect(replay).toEqual({ bundle: result.bundle, records: result.records });
  });

  it('captures an exact hold member while retaining an existing transition', async () => {
    const { bundle: source } = await authoredBundle();
    const bundle = copy(source);
    const clip = new AuthoredState(bundle).entity('parent/clip:x')!;
    clip.transition = { type: 'crossfade', duration: 0.5 };
    const patch: TimelinePatch = { version: 1, operations: [
      { op: 'clip.move', target: 'x', payload: { at: 4 }, order: 0 },
      { op: 'clip.update', target: 'x', payload: { hold: 5 }, order: 1 },
    ] };

    const result = captureGenericPatch(bundle, patch, () => 'parent/clip:x');

    expect(result.commands.map((command) => command.op)).toEqual(['clip.move', 'clip.set']);
    expect(result.bundle.parent.clips[0]).toMatchObject({
      at: 4,
      hold: 5,
      transition: { type: 'crossfade', duration: 0.5 },
    });
  });

  it('refuses an independent static duration atomically after a move', async () => {
    const { bundle: source } = await authoredBundle();
    const bundle = copy(source);
    const moved = executeGenericPatch(bundle, [{
      schema_version: 1, op: 'clip.move', version: '1', select: 'parent/clip:x',
      args: { on: 4 }, intent: { ripple: 'none', anchor: 'fixed', position: 'absolute' },
    }]).bundle;
    const clip = new AuthoredState(moved).entity('parent/clip:x')!;
    clip.app = { opaque: null, astrid: { for: 2 } };
    const patch: TimelinePatch = { version: 1, operations: [
      { op: 'clip.update', target: 'x', payload: { values: { hold: 5 }, clear: [] } },
    ] };
    const before = copy(moved);

    expect(() => captureGenericPatch(moved, patch, () => 'parent/clip:x')).toThrow(GenericPatchRefusal);
    expect(moved).toEqual(before);
  });

  it('composes structural birth and dependent add/remove with existing generic members', async () => {
    const { env, bundle: source } = await authoredBundle();
    const bundle = copy(source);
    const patch: TimelinePatch = { version: 1, operations: [
      { op: 'track.add', target: 'ordinary-track', payload: { kind: 'visual', role: 'output' }, order: 0 },
      { op: 'clip.add', target: 'ordinary-clip', payload: {
        track: 'ordinary-track', at: 1.25, hold: 2.5, clipType: 'hold',
      }, order: 1 },
      { op: 'clip.remove', target: 'ordinary-clip', order: 2 },
      { op: 'clip.update', target: 'x', payload: { values: { hold: 2 }, clear: [] }, order: 3 },
      { op: 'track.update', target: 'V1', payload: { label: 'Picture' }, order: 4 },
      { op: 'clip.move', target: 'x', payload: { at: 4 }, order: 5 },
    ] };
    const result = captureGenericPatch(bundle, patch, (operation) => operation.op === 'track.update'
      ? 'parent/track:V1' : 'parent/clip:x');

    expect(result.commands.map((command) => command.op)).toEqual([
      'track.create', 'clip.add', 'clip.delete', 'clip.set', 'track.set', 'clip.move',
    ]);
    expect(result.commands.slice(0, 3).map((command) => command.created)).toEqual([
      ['parent/track:ordinary-track'], ['parent/clip:ordinary-clip'], [],
    ]);
    expect(result.records.map((record) => record.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.preview.operations.slice(0, 3)).toEqual(patch.operations.slice(0, 3));
    expect(executeGenericPatch(copy(bundle), result.commands)).toEqual({
      bundle: result.bundle,
      records: result.records,
    });

    const current = env.current();
    const before = copy(current);
    const projected = projectGenericPatchPreview({ ...result.preview, source: 'timeline.native-ordinary' }, current)!;
    expect(projected.config.tracks?.some((track) => track.id === 'ordinary-track')).toBe(true);
    expect(projected.config.clips?.some((clip) => clip.id === 'ordinary-clip')).toBe(false);
    expect(projected.config.clips?.find((clip) => clip.id === 'x')).toMatchObject({ hold: 2, at: 4 });
    expect(projected.config.tracks?.find((track) => track.id === 'V1')?.label).toBe('Picture');
    expect(projected.dataLanes).toBe(current.dataLanes);
    expect(current).toEqual(before);
  });

  it('refuses the complete batch before resolving any owner or executing a member', async () => {
    const { bundle } = await authoredBundle();
    const patch: TimelinePatch = {
      version: 1,
      operations: [
        { op: 'track.update', target: 'V1', payload: { label: 'kept' } },
        { op: 'project-data.write', target: 'extension', payload: { value: 1 } },
        { op: 'clip.update', target: 'x', payload: { hold: 2 } },
      ],
    };
    let resolved = false;
    expect(() => captureGenericPatch(bundle, patch, () => {
      resolved = true;
      return 'parent/track:V1';
    })).toThrow(GenericPatchRefusal);
    try {
      captureGenericPatch(bundle, patch, () => 'parent/track:V1');
    } catch (error) {
      expect((error as GenericPatchRefusal).intentions).toEqual([
        expect.objectContaining({ operationIndex: 0, reason: expect.stringContaining('another patch member') }),
        expect.objectContaining({ operationIndex: 1, op: 'project-data.write', target: 'extension' }),
        expect.objectContaining({ operationIndex: 2, reason: expect.stringContaining('another patch member') }),
      ]);
    }
    expect(resolved).toBe(false);
  });

  it('refuses a legacy cross-track move before resolving an owner', async () => {
    const { bundle } = await authoredBundle();
    let resolved = false;
    expect(() => captureGenericPatch(bundle, {
      version: 1,
      operations: [{ op: 'clip.move', target: 'x', payload: { track: 'A1', at: 2 } }],
    }, () => {
      resolved = true;
      return 'parent/clip:x';
    })).toThrow(GenericPatchRefusal);
    expect(resolved).toBe(false);
  });

  it('routes malformed qualified move and scalar shapes to visible native refusal', async () => {
    const { bundle } = await authoredBundle();
    expect(classifyGenericPatch({ version: 1, operations: [
      { op: 'clip.move', target: 'x', payload: { at: -1 } },
    ] })).toBe('mixed');
    expect(classifyGenericPatch({ version: 1, operations: [
      { op: 'clip.update', target: 'x', payload: { values: { asset: 'bad' }, clear: [] } },
    ] })).toBe('mixed');
    expect(classifyGenericPatch({ version: 1, operations: [
      { op: 'clip.update', target: 'x', payload: { values: { hold: 0 }, clear: [] } },
    ] })).toBe('mixed');
    let resolved = false;
    expect(() => captureGenericPatch(bundle, {
      version: 1,
      operations: [{ op: 'clip.move', target: 'x', payload: { at: -1 } }],
    }, () => {
      resolved = true;
      return 'parent/clip:x';
    })).toThrow(GenericPatchRefusal);
    expect(resolved).toBe(false);
  });

  it.each([
    { op: 'clip.update', target: 'x', payload: { hold: 0 } },
    { op: 'clip.update', target: 'x', payload: { hold: 2 }, clear: ['asset'] },
    { op: 'track.update', target: 'V1', payload: { label: 'x', mode: 'replace' } },
    { op: 'project-data.write', target: 'extension', payload: { value: 1 } },
    { op: 'extension.noop', target: 'extension', payload: {} },
  ])('does not map unsupported operation %j', async (operation) => {
    const { bundle } = await authoredBundle();
    const patch = { version: 1, operations: [operation] } as TimelinePatch;
    expect(() => captureGenericPatch(bundle, patch, () => 'unreachable')).toThrow(GenericPatchRefusal);
  });

  it('projects the native local diff without mutating the displayed state', async () => {
    const { env } = await authoredBundle();
    const current = env.current();
    const before = copy(current);
    const patch: TimelinePatch = {
      version: 1,
      source: 'timeline.native-label-hold',
      operations: [
        { op: 'track.update', target: 'V1', payload: { label: '' } },
        { op: 'clip.update', target: 'x', payload: { hold: 1.123456789 } },
      ],
    };
    const next = projectGenericPatchPreview(patch, current)!;
    expect(next.config.tracks![0].label).toBe('');
    expect(next.resolvedConfig.tracks[0].label).toBe('');
    expect(next.config.clips[0].hold).toBe(1.123456789);
    expect(next.resolvedConfig.clips[0].hold).toBe(1.123456789);
    expect(next.config.clips[0].text).toEqual(before.config.clips[0].text);
    expect(next.config.clips[0].app).toEqual(before.config.clips[0].app);
    expect(next.dataLanes).toBe(current.dataLanes);
    expect(current).toEqual(before);
    expect(() => projectGenericPatchPreview({ ...patch, operations: [
      ...patch.operations, { op: 'clip.update', target: 'missing', payload: { hold: 1 } },
    ] }, current)).toThrow('one displayed target');
  });
});

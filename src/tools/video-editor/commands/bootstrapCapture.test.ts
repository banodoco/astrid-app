import { describe, expect, it } from 'vitest';
import { DEFAULT_OUTPUT, DEFAULT_VIDEO_TRACKS } from '../lib/defaults.ts';
import { captureBootstrap } from './bootstrapCapture.ts';
import { copy, freezeJson, type AuthoredBundle } from './clipMovePrimitives.ts';
import fixture from './fixtures/recipe_m2_app_bootstrap.json';

const defaults = { name: 'Main', slug: 'main', output: DEFAULT_OUTPUT, tracks: DEFAULT_VIDEO_TRACKS };
const original = fixture.bundle as AuthoredBundle;

describe('native App bootstrap capture', () => {
  it('matches native sequential init/V1/A1 commands, full records and authored result exactly', () => {
    const input = freezeJson(copy(original));
    const result = captureBootstrap(input, defaults);
    expect(result.commands).toEqual(fixture.commands);
    expect(result.records).toEqual(fixture.records);
    expect(result.bundle).toEqual(fixture.after_bundle);
    expect(input).toEqual(original);
    expect(result.commands[2].selections![0].order).toEqual(['parent/track:V1']);
    expect(result.commands[0].expect!['parent::config.output']).toEqual({ state: 'absent' });
    expect(result.commands[0].reads).toEqual([
      { ref: 'parent', path: [], state: { state: 'present', value: original.parent } },
      { ref: 'parent', path: ['config', 'output'], state: { state: 'absent' } },
      { ref: 'parent', path: ['name'], state: { state: 'absent' } },
      { ref: 'parent', path: ['slug'], state: { state: 'absent' } },
      { ref: 'parent', path: ['registry', 'assets'], state: { state: 'absent' } },
    ]);
    expect(result.commands[0].expect!['parent::registry.assets']).toEqual({ state: 'absent' });
    expect(result.records[0].writes.at(-1)).toEqual({ ref: 'parent', path: ['registry', 'assets'],
      before: { state: 'absent' }, after: { state: 'present', value: {} } });
    expect(result.bundle.parent.config).not.toHaveProperty('theme');
    expect((result.bundle.parent.config as any).output).toEqual({
      resolution: '1280x720', fps: 30, file: 'output.mp4', background: null, background_scale: null,
    });
  });

  it.each([['Timeline 2', 'timeline-2'], ['!!!', 'timeline'], ['', 'timeline'], ['   ', 'timeline'],
    ['  Authored Cut  ', 'authored-cut'], ['x'.repeat(121), 'x'.repeat(121)]])('retains authored name %s and slug %s', (name, slug) => {
    const result = captureBootstrap(original, { ...defaults, name, slug });
    expect(result.commands[0].args).toEqual({ name, slug, output: DEFAULT_OUTPUT });
    expect(result.bundle.parent.name).toBe(name);
    expect(result.bundle.parent.slug).toBe(slug);
    expect(result.commands.slice(1)).toEqual(fixture.commands.slice(1));
  });

  it.each(['opaque', '__proto__', 'constructor', 'prototype'])('refuses opaque own key %s without changing authored input', (key) => {
    const input = copy(original);
    Object.defineProperty(input.parent, key, { enumerable: true, writable: true, configurable: true, value: [null, false, [3, 1, 2]] });
    const before = copy(input);
    expect(() => captureBootstrap(input, defaults)).toThrow('pristine');
    expect(input).toEqual(before);
  });

  it.each([
    { config: { clips: [], tracks: [], theme: null } },
    { registry: { assets: {} } },
    { name: null },
    { slug: '' },
    { config: { clips: [], tracks: [], output: null } },
    { registry: { opaque: [null, false] } },
    { config: { clips: [], tracks: [DEFAULT_VIDEO_TRACKS[0]] } },
  ])('refuses authored state, including explicit null, instead of treating it as absent: %j', (change) => {
    const input = copy(original);
    Object.assign(input.parent, change);
    const before = copy(input);
    expect(() => captureBootstrap(input, defaults)).toThrow('pristine');
    expect(input).toEqual(before);
  });

  it('refuses unsupported output, row order, child data and nonfinite values', () => {
    for (const output of [{ ...DEFAULT_OUTPUT, fps: 29.97 }, { ...DEFAULT_OUTPUT, fps: { numerator: 30, denominator: 1 } },
      { resolution: '1280x720', fps: 30, file: 'output.mp4' }]) {
      expect(() => captureBootstrap(original, { ...defaults, output })).toThrow('supported');
    }
    expect(() => captureBootstrap(original, { ...defaults, tracks: [...DEFAULT_VIDEO_TRACKS].reverse() })).toThrow('supported');
    const input = copy(original);
    input.placements.push({ opaque: null });
    expect(() => captureBootstrap(input, defaults)).toThrow('pristine');
    expect(() => captureBootstrap(original, { ...defaults, output: Infinity })).toThrow('finite JSON');
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CanonicalDocument, CommandRecord, EditCommand, JSON as JsonValue } from '@/integrations/runtime/timeline-commit-types.ts';
import { fixtureDigest } from '@/integrations/runtime/__tests__/timelineCommitFixture.ts';
import { authoringBundleFromDocument } from './authoringBundle.ts';
import {
  captureClipTrim,
  executeClipTrim,
} from './clipTrimCapture.ts';
import type { AuthoredBundle } from './clipTrimCapture.ts';
import fixture from './fixtures/recipe_m2_clip_trim.json';
import boundaries from './fixtures/recipe_m2_clip_trim_boundaries.json';

type TrimFixture = {
  input: CanonicalDocument;
  commands: EditCommand[];
  records: CommandRecord[];
  output: CanonicalDocument;
};

const golden = fixture as TrimFixture;
const ref = 'parent/clip:clip-a';
const detached = <T>(value: T): T => structuredClone(value);

async function bundle(): Promise<AuthoredBundle> {
  return authoringBundleFromDocument(detached(golden.input));
}

function clip(value: AuthoredBundle, identity = ref): Record<string, JsonValue> {
  const owner = identity.slice(0, identity.lastIndexOf('/'));
  const id = identity.slice(identity.lastIndexOf(':') + 1);
  const rows = owner === 'parent' ? value.parent.clips : value.shots[owner].internal_timeline.clips;
  return (rows as Record<string, JsonValue>[]).find((row) => row.id === id)!;
}

describe('Agent built-in clip.trim capture parity', () => {
  it('matches the frozen source-unit command, recorder, and authored output exactly', async () => {
    const input = await bundle();
    const result = executeClipTrim(input, detached(golden.commands[0]));

    expect(result.command).toEqual(golden.records[0].command);
    expect(result.record).toEqual(golden.records[0]);
    expect(clip(result.bundle)).toEqual(golden.output.parent_revision.payload.clips[0]);
    const outputPayload = golden.output.parent_revision.payload as Record<string, JsonValue>;
    expect((result.bundle.parent.config as Record<string, JsonValue>).clips).toEqual(
      (outputPayload.config as Record<string, JsonValue>).clips,
    );
    expect(result.bundle.placements).toEqual(input.placements);
  });

  it('captures the original basis and preserves opaque fields while applying source-time hold', async () => {
    const input = await bundle();
    const original = detached(input);
    const basis = captureClipTrim(input, ref, { in_s: 1, out_s: 5 });
    const result = executeClipTrim(basis.bundle, basis.command);

    expect(basis.bundle).toEqual(original);
    expect(basis.command).toEqual(golden.records[0].command);
    expect(clip(result.bundle).hold).toBe(4);
    expect(clip(result.bundle).speed).toBe(2);
    expect(clip(result.bundle).app).toEqual({
      astrid: { opaque: [null, false] },
      'org.example': { literal: 'clip-a', clear: null },
    });
    expect(result.bundle.placements).toEqual(original.placements);
  });

  it.each([
    ['absent', undefined, undefined],
    ['null', null, undefined],
    ['empty', {}, undefined],
    ['null namespace', { astrid: null }, undefined],
    ['legacy flat intent', { for: 3, until: null }, undefined],
    ['nested null intent', { astrid: { for: null, until: null } }, undefined],
    ['opaque legacy namespaces', {
      for: 8,
      until: null,
      astrid: { for: 9, until: null, opaque: false },
      opaque: 0,
    }, { for: 8, astrid: { until: null, opaque: false }, opaque: 0 }],
  ])('matches sequential legacy intent cleanup: %s', async (_name, app, expected) => {
    const input = await bundle();
    if (app === undefined) delete clip(input).app;
    else clip(input).app = app;
    const result = executeClipTrim(input, detached(golden.commands[0]));
    expect(clip(result.bundle).app).toEqual(expected);
  });

  it.each([
    ['negative in', { in_s: -1 }],
    ['past source', { out_s: 11 }],
    ['collapsed', { in_s: 6, out_s: 6 }],
    ['wrong type', { out_s: '4' }],
    ['unsupported intent', { in_s: 1, out_s: 5, intent: { anchor: 'follow' } }],
  ])('refuses malformed window or intent: %s', async (_name, args) => {
    const input = await bundle();
    const before = detached(input);
    const command = {
      ...detached(golden.commands[0]),
      args: { in_s: null, out_s: null, ...args },
      ...(args.intent ? { intent: args.intent } : {}),
    } as unknown as EditCommand;
    expect(() => executeClipTrim(input, command)).toThrow();
    expect(input).toEqual(before);
  });

  it.each([
    ['speed zero', { speed: 0 }],
    ['speed negative', { speed: -1 }],
    ['speed boolean', { speed: true }],
    ['mapped source', { source_window: { start: 0, end: 10 } }],
    ['timing map', { time_map: {} }],
    ['unsupported params', { params: { keyframes: [] } }],
    ['text clip', { clipType: 'text' }],
    ['alias asset', { asset_id: 'picture' }],
  ])('refuses unsupported authored shape without mutation: %s', async (_name, changes) => {
    const input = await bundle();
    const before = detached(input);
    Object.assign(clip(input), changes);
    const changed = detached(input);
    expect(() => captureClipTrim(input, ref, { in_s: 1, out_s: 5 })).toThrow();
    expect(input).toEqual(changed);
    expect(changed).not.toEqual(before);
  });

  it.each([
    'occurrence:occ-a/clip:clip-a',
    'shot:chapter-shot/clip:clip-a',
    'parent/clip:missing',
    'parent/clip:clip-a::at',
  ])('refuses non-literal parent identity: %s', async (identity) => {
    const input = await bundle();
    expect(() => captureClipTrim(input, identity, { in_s: 1, out_s: 5 })).toThrow();
  });

  it('keeps authored decimal source timing and rational-fps metadata unquantized', async () => {
    const input = await bundle();
    const result = executeClipTrim(input, {
      ...detached(golden.commands[0]),
      args: { in_s: 9.8999, out_s: 10 },
    });
    expect(clip(result.bundle).at).toBe(1);
    expect(clip(result.bundle).from).toBe(9.8999);
    expect(clip(result.bundle).to).toBe(10);
    expect(clip(result.bundle).hold).toBe(0.1001);
    expect((result.bundle.parent.config as Record<string, JsonValue>).output).toEqual({
      fps: { numerator: 30000, denominator: 1001 },
    });
  });
});

describe('trim retained source and opaque controls', () => {
  it('preserves prototype-looking own fields, order, registry and unrelated clips literally', async () => {
    const input = await bundle();
    const opaque = JSON.parse('{"__proto__":{"literal":"parent/clip:clip-a"},"constructor":null,"prototype":[false,0]}');
    clip(input).opaque = detached(opaque);
    (clip(input).app as Record<string, JsonValue>)['org.opaque'] = detached(opaque);
    const original = detached(input);
    const result = executeClipTrim(input, detached(golden.commands[0]));
    expect(clip(result.bundle).opaque).toEqual(opaque);
    expect(Object.prototype.hasOwnProperty.call(clip(result.bundle).opaque, '__proto__')).toBe(true);
    expect((clip(result.bundle).app as Record<string, JsonValue>)['org.opaque']).toEqual(opaque);
    expect(result.bundle.parent.registry).toEqual(original.parent.registry);
    expect((result.bundle.parent.clips as Array<Record<string, JsonValue>>).map((row) => row.id))
      .toEqual((original.parent.clips as Array<Record<string, JsonValue>>).map((row) => row.id));
    expect((result.bundle.parent.clips as JsonValue[]).slice(1)).toEqual((original.parent.clips as JsonValue[]).slice(1));
    expect(input).toEqual(original);
    expect(Object.getPrototypeOf(clip(result.bundle).opaque)).toBe(Object.prototype);
  });

  it.each([undefined, null, 0, '10'])('refuses a nonauthoritative source duration %j without using another duration field', async (duration) => {
    const input = await bundle();
    const registry = input.parent.registry as { assets: Record<string, Record<string, JsonValue>> };
    if (duration === undefined) delete registry.assets.picture.duration;
    else registry.assets.picture.duration = duration;
    registry.assets.picture.duration_ms = 10000;
    registry.assets.picture.duration_seconds = 10;
    const original = detached(input);
    expect(() => captureClipTrim(input, ref, { out_s: 5 })).toThrow('registry source duration');
    expect(input).toEqual(original);
  });

  it.each(['duration', 'media_id'] as const)('retains original %s read guards without recapturing at finish', async (key) => {
    const input = await bundle();
    const captured = captureClipTrim(input, ref);
    const current = detached(input);
    const registry = current.parent.registry as { assets: Record<string, Record<string, JsonValue>> };
    registry.assets.picture[key] = key === 'duration' ? 11 : 'different-media';
    expect(() => executeClipTrim(current, { ...detached(captured.command), args: { in_s: 1, out_s: 5 } }))
      .toThrow('original capture');
  });
});

describe('Agent exact binary64 trim precision contract', () => {
  it.each(boundaries.cases)('$id', async (vector) => {
    const document = detached(golden.input);
    const registry = document.parent_revision.payload.registry as { assets: Record<string, Record<string, JsonValue>> };
    registry.assets.picture.duration = vector.duration;
    document.parent_revision.content_digest = fixtureDigest(document.parent_revision.payload);
    const input = await authoringBundleFromDocument(document);
    const before = detached(input);
    const command = { ...detached(golden.commands[0]), args: vector.args };

    if (vector.error) {
      expect(() => captureClipTrim(input, ref, vector.args)).toThrow(vector.error);
      expect(() => executeClipTrim(input, command)).toThrow(vector.error);
    } else {
      const basis = captureClipTrim(input, ref, vector.args);
      const result = executeClipTrim(basis.bundle, basis.command);
      expect(result).toEqual(executeClipTrim(input, command));
      expect(executeClipTrim(input, result.command)).toEqual(result);
      expect(clip(result.bundle)).toEqual({ ...golden.output.parent_revision.payload.clips[0], ...vector.applied });
      expect(clip(result.bundle).to).toBeLessThanOrEqual(vector.duration);
      const config = result.bundle.parent.config as Record<string, JsonValue>;
      expect((config.clips as Record<string, JsonValue>[]).find((row) => row.id === 'clip-a'))
        .toEqual(clip(result.bundle));
      expect(config.output).toEqual({ fps: { numerator: 30000, denominator: 1001 } });
      expect(result.bundle.parent.registry).toEqual(before.parent.registry);
      expect(result.bundle.placements).toEqual(before.placements);
      expect(result.bundle.shots).toEqual(before.shots);
      expect(result.bundle.source_mapping).toEqual(before.source_mapping);
      expect((result.bundle.parent.clips as JsonValue[]).slice(1)).toEqual((before.parent.clips as JsonValue[]).slice(1));
    }
    expect(input).toEqual(before);
  });

  it.each([undefined, null])('resolves %j endpoints before rounding the raw file end', async (endpoint) => {
    const input = await bundle();
    const registry = input.parent.registry as { assets: Record<string, Record<string, JsonValue>> };
    registry.assets.picture.duration = 9.9999999;
    for (const key of ['from', 'to']) {
      if (endpoint === undefined) delete clip(input)[key];
      else clip(input)[key] = endpoint;
    }
    const before = detached(input);
    const result = executeClipTrim(input, {
      ...detached(golden.commands[0]), args: endpoint === undefined ? {} : { in_s: null, out_s: null },
    });
    expect(clip(result.bundle)).toMatchObject({ from: 0, to: 9.999999, hold: 9.999999, speed: 2 });
    expect(input).toEqual(before);
  });

  it.each([NaN, Infinity, -Infinity])('refuses nonfinite raw input %s before mutation', async (value) => {
    const input = await bundle();
    const before = detached(input);
    for (const key of ['in_s', 'out_s']) {
      expect(() => executeClipTrim(input, {
        ...detached(golden.commands[0]), args: { in_s: 0, out_s: 5, [key]: value },
      })).toThrow('finite');
    }
    expect(input).toEqual(before);
    (input.parent.registry as { assets: Record<string, Record<string, JsonValue>> }).assets.picture.duration = value;
    const invalid = detached(input);
    expect(() => captureClipTrim(input, ref)).toThrow('finite');
    expect(input).toEqual(invalid);
  });
});

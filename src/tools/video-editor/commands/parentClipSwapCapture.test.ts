// @vitest-environment node
import { writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { EditCommand, JSON, MediaSelection, VerifiedMedia } from '@/integrations/runtime/timeline-commit-types.ts';
import {
  executeParentClipSwapMedia,
  parentClipMediaSelection,
} from './parentClipAddCapture.ts';
import {
  captureParentClipSwapMedia,
  finishParentClipSwapMedia,
} from './parentClipSwapCapture.ts';
import { ClipMoveError, copy } from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

const oldMedia: MediaSelection = {
  asset: 'reserved-old',
  generation_id: 'generation-old',
  variant_id: 'variant-old',
  object_id: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  catalog_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};
const newMedia: MediaSelection = {
  asset: 'reserved-new',
  generation_id: 'generation-new',
  variant_id: 'variant-new',
  object_id: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  catalog_digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};
const oldVerified: VerifiedMedia = { selection: oldMedia, media_type: 'video/fixture', size: 122, duration_seconds: 8 };
const verified: VerifiedMedia = { selection: newMedia, media_type: 'video/fixture', size: 123, duration_seconds: 8 };
const inputs = [oldVerified, verified];
// Optional export is consumed by fixtures/parent_clip_swap_parity.py with the
// actual private014 Agent on PYTHONPATH; normal Vitest needs no Python install.
const parity: unknown[] = [];
afterAll(() => {
  if (process.env.PARENT_SWAP_PARITY_OUTPUT) writeFileSync(process.env.PARENT_SWAP_PARITY_OUTPUT, JSON.stringify(parity));
});

function binding(media: MediaSelection) {
  return {
    media_id: media.object_id,
    type: 'video',
    generationId: media.generation_id,
    variantId: media.variant_id,
    catalog_digest: media.catalog_digest,
    opaque: { keep: [null, false, 0] },
  } as Record<string, JSON>;
}

function bundle(): AuthoredBundle {
  const clips: JSON[] = [{
    id: 'clip-a', track: 'overlay', at: 3.003, hold: 4, from: 2, to: 6, speed: 2,
    clipType: 'video', asset: oldMedia.asset, opaque: { keep: [null, false, 0] },
  }, { id: 'clip-b', track: 'overlay', at: 9, hold: 1, from: 0, to: 1,
    clipType: 'video', asset: oldMedia.asset, opaque: { peer: true } }];
  const registry = { assets: { [oldMedia.asset]: binding(oldMedia) } } as Record<string, JSON>;
  const config = {
    output: { fps: 30 },
    tracks: [{ id: 'overlay', kind: 'visual', role: 'output', opaque: { lane: true } }],
    clips: copy(clips),
    registry: copy(registry),
  } as Record<string, JSON>;
  return {
    schema_version: 1,
    project_id: 'project-1',
    timeline_id: 'film',
    parent: { config, clips, registry: copy(registry) },
    placements: [],
    shots: {},
  } as AuthoredBundle;
}

describe('native parent clip.swap-media capture', () => {
  it('matches the exact private014 operation and records a raw-only replacement', () => {
    const input = bundle(), before = copy(input);
    const basis = captureParentClipSwapMedia(input, 'clip-a', newMedia);
    const result = finishParentClipSwapMedia(basis, inputs);
    const clip = result.bundle.parent.clips[0] as Record<string, JSON>;

    expect(result.command).toMatchObject({
      schema_version: 1,
      op: 'clip.swap-media',
      version: '1',
      select: 'parent/clip:clip-a',
      args: { old_media: oldMedia, media: newMedia },
      intent: { ownership: 'parent' },
      resolved: ['parent/clip:clip-a'],
      bindings: { 'media.target': 'parent/clip:clip-a' },
    });
    expect(result.record.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'media.owner', ref: 'parent', policy: 'fixed' }),
      expect.objectContaining({ key: 'media.track', ref: 'parent/track:overlay', policy: 'fixed' }),
      expect.objectContaining({ key: 'media.target', ref: 'parent/clip:clip-a', policy: 'fixed' }),
    ]));
    expect(result.record.dependencies).toEqual([
      { key: 'media.old', kind: 'media', pin: oldMedia, policy: 'exact' },
      { key: 'media.new', kind: 'media', pin: newMedia, policy: 'exact' },
    ]);
    expect(result.record.writes).toHaveLength(2);
    expect(result.command.reads!.map((read) => read.ref)).toEqual([
      'parent/collection:clip', 'parent/clip:clip-a', 'parent/collection:track', 'parent/track:overlay',
      'parent/collection:asset', 'parent/asset:reserved-old', 'parent/asset:reserved-new',
    ]);
    expect(result.command.selections!.map((selection) => selection.key)).toEqual(['collection.clips', 'collection.tracks']);
    expect(result.record.reads[5].state).toEqual({ state: 'present', value: binding(oldMedia) });
    parity.push({ inputs, ...result, original: input });
    expect(clip).toEqual({ ...before.parent.clips[0] as Record<string, JSON>, asset: newMedia.asset });
    expect((result.bundle.parent.config as Record<string, JSON>).clips).toEqual(result.bundle.parent.clips);
    expect(input).toEqual(before);
    expect(executeParentClipSwapMedia(input, result.command, inputs)).toEqual(result);
  });

  it('keeps the old selection, target and verified media exact across JSON replay', () => {
    const basis = captureParentClipSwapMedia(bundle(), 'clip-a', copy(newMedia));
    const replayed = finishParentClipSwapMedia(JSON.parse(JSON.stringify(basis)), copy(inputs));
    const changed = copy(newMedia);
    changed.catalog_digest = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

    expect(replayed.command.args).toEqual({ old_media: oldMedia, media: newMedia });
    expect(() => finishParentClipSwapMedia(basis, [oldVerified, { ...verified, selection: changed }]))
      .toThrow(ClipMoveError);
    expect(finishParentClipSwapMedia(basis, inputs)).toEqual(replayed);
  });

  it('preserves an untrimmed raw video carrier and its opaque fields', () => {
    const input = bundle();
    const clip = input.parent.clips[0] as Record<string, JSON>;
    const mirror = ((input.parent.config as Record<string, JSON>).clips as JSON[])[0] as Record<string, JSON>;
    delete clip.from;
    delete clip.to;
    delete mirror.from;
    delete mirror.to;

    const result = finishParentClipSwapMedia(captureParentClipSwapMedia(input, 'clip-a', newMedia), inputs);
    const replaced = result.bundle.parent.clips[0] as Record<string, JSON>;
    expect(replaced).not.toHaveProperty('from');
    expect(replaced).not.toHaveProperty('to');
    expect(replaced).toMatchObject({ hold: 4, speed: 2, asset: newMedia.asset, opaque: { keep: [null, false, 0] } });
  });

  it('refuses a changed original media guard without mutating the candidate', () => {
    const original = bundle();
    const basis = captureParentClipSwapMedia(original, 'clip-a', newMedia);
    const changed = copy(original);
    const assets = (changed.parent.registry as Record<string, JSON>).assets as Record<string, JSON>;
    (assets[oldMedia.asset] as Record<string, JSON>).media_id = 'sha256:3333333333333333333333333333333333333333333333333333333333333333';
    (changed.parent.config as Record<string, JSON>).registry = copy(changed.parent.registry);
    const before = copy(changed);

    expect(() => executeParentClipSwapMedia(changed, basis.command as EditCommand, inputs))
      .toThrow(ClipMoveError);
    expect(changed).toEqual(before);
    const wrongSelection = copy(basis.command);
    (wrongSelection.args.old_media as Record<string, JSON>).catalog_digest = 'sha256:' + 'c'.repeat(64);
    expect(() => executeParentClipSwapMedia(original, wrongSelection, inputs)).toThrow('exact Runtime-verified media input');
    expect(parentClipMediaSelection(original, 'clip-a')).toEqual(oldMedia);
  });

  it('preserves incoming transitions, absent/null holds and null speed on raw video', () => {
    const candidates = [bundle(), bundle()];
    for (const [index, input] of candidates.entries()) {
      const row = input.parent.clips[0] as Record<string, JSON>;
      if (index === 0) delete row.hold;
      else row.hold = null;
      row.speed = null;
      row.transition = { type: 'dissolve', duration: .25 };
      (input.parent.config as Record<string, JSON>).clips = copy(input.parent.clips);
      const result = finishParentClipSwapMedia(captureParentClipSwapMedia(input, 'clip-a', newMedia), inputs);
      expect(result.bundle.parent.clips[0]).toEqual({ ...row, asset: newMedia.asset });
      parity.push({ inputs, ...result, original: input });
    }
  });

  it('uses an exact old Runtime selection with main four-field bindings and no occurrence read', () => {
    const input = bundle();
    const registry = input.parent.registry as Record<string, JSON>;
    const entry = (registry.assets as Record<string, JSON>)[oldMedia.asset] as Record<string, JSON>;
    delete entry.catalog_digest;
    delete entry.opaque;
    (input.parent.config as Record<string, JSON>).registry = copy(registry);
    input.placements = [{ occurrence_id: 'occ-a', placement: { track: 'overlay' } }];
    expect(() => captureParentClipSwapMedia(input, 'clip-a', newMedia)).toThrow('five-field selection');
    const result = finishParentClipSwapMedia(captureParentClipSwapMedia(input, 'clip-a', newMedia, oldMedia), inputs);
    parity.push({ inputs, ...result, original: input });
    expect(result.command.args.old_media).toEqual(oldMedia);
    expect(result.bundle.placements).toEqual(input.placements);
    expect(result.record.reads.some((read) => read.ref.includes('occurrence'))).toBe(false);
  });

  it('requires both verified sources and refuses an occupied new alias without rebinding peers', () => {
    const input = bundle();
    const basis = captureParentClipSwapMedia(input, 'clip-a', newMedia);
    const before = copy(input);
    expect(() => finishParentClipSwapMedia(basis, [verified])).toThrow('exact Runtime-verified media input');
    expect(() => finishParentClipSwapMedia(basis, [{ ...oldVerified, duration_seconds: 5 }, verified]))
      .toThrow('exceeds media');
    const sameAlias = { ...newMedia, asset: oldMedia.asset };
    const sameBasis = captureParentClipSwapMedia(input, 'clip-a', sameAlias);
    expect(() => finishParentClipSwapMedia(sameBasis, [oldVerified, { ...verified, selection: sameAlias }]))
      .toThrow('registry binding differs');
    expect(input).toEqual(before);
  });

  it('refuses unsupported standins and conflicting registry mirrors without mutating the draft', () => {
    const input = bundle();
    const row = input.parent.clips[0] as Record<string, JSON>;
    row.app = { astrid: { standin: { keep: true } } };
    (input.parent.config as Record<string, JSON>).clips = copy(input.parent.clips);
    const before = copy(input);
    expect(() => finishParentClipSwapMedia(captureParentClipSwapMedia(input, 'clip-a', newMedia), inputs))
      .toThrow('literal child timing');
    expect(input).toEqual(before);
    (input.parent.config as Record<string, JSON>).registry = { assets: {} };
    expect(() => captureParentClipSwapMedia(input, 'clip-a', newMedia)).toThrow('conflicts');
  });
});

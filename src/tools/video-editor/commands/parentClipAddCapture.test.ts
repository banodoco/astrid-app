import { describe, expect, it } from 'vitest';
import type { EditCommand, JSON, MediaSelection, VerifiedMedia } from '@/integrations/runtime/timeline-commit-types.ts';
import {
  captureParentClipAddMedia,
  executeParentClipAddMedia,
  finishParentClipAddMedia,
} from './parentClipAddCapture.ts';
import { ClipMoveError, copy } from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

const media: MediaSelection = {
  asset: 'reserved-new',
  generation_id: 'generation-new',
  variant_id: 'variant-new',
  object_id: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  catalog_digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};
const verified: VerifiedMedia = { selection: media, media_type: 'video/fixture', size: 123, duration_seconds: 6 };
const row: Record<string, JSON> = {
  id: 'born', clipType: 'video', asset: 'reserved-new', track: 'overlay', at: 3.003, hold: 4,
  from: 2, to: 6, speed: 2, opaque: { keep: [null, false, 0] },
};

function bundle(options: { emptyClips?: boolean; opaqueRegistries?: boolean } = {}): AuthoredBundle {
  const existing = { id: 'clip-a', track: 'picture', at: 0, hold: 1, clipType: 'video', asset: 'picture', opaque: { keep: true } } as Record<string, JSON>;
  const clips = options.emptyClips ? [] : [existing];
  const registry = options.opaqueRegistries ? { opaque: { keep: [null, false, {}] } } : {
    assets: { picture: { media_id: 'sha256:1111111111111111111111111111111111111111111111111111111111111111', type: 'video' } },
  };
  const config = {
    output: { fps: 30 },
    tracks: [
      { id: 'picture', kind: 'visual', role: 'output' },
      { id: 'overlay', kind: 'visual', role: 'output', opaque: { lane: true } },
    ],
    clips: copy(clips),
    registry: copy(registry),
  } as Record<string, JSON>;
  return {
    schema_version: 1,
    project_id: 'project-1',
    timeline_id: 'film',
    parent: { config, clips, registry: copy(registry) },
    placements: [
      { occurrence_id: 'occ-a', track: 'picture', placement: { track: 'picture' } },
      { occurrence_id: 'occ-b', track: 'picture', placement: { track: 'picture' } },
    ],
    shots: {},
  } as AuthoredBundle;
}

function capture(input = bundle(), selectedMedia = media, inputVerified: readonly VerifiedMedia[] = [verified]) {
  return captureParentClipAddMedia(input, row, selectedMedia, inputVerified);
}

describe('native parent clip.add-media capture', () => {
  it('matches the native birth claims and preserves raw opaque data and order', () => {
    const input = bundle(), before = copy(input);
    const result = finishParentClipAddMedia(capture(input));

    expect(result.command).toMatchObject({
      schema_version: 1, op: 'clip.add-media', version: '1', select: 'parent',
      args: { row, media }, intent: {}, resolved: [],
      bindings: { 'media.track': 'parent/track:overlay' },
      created: ['parent/asset:reserved-new', 'parent/clip:born'],
    });
    expect(result.record.bindings).toEqual([
      { key: 'media.owner', ref: 'parent', policy: 'fixed', dependencies: [] },
      { key: 'media.track', ref: 'parent/track:overlay', policy: 'fixed', dependencies: [] },
    ]);
    expect(result.record.dependencies).toEqual([{ key: 'media.new', kind: 'media', pin: media, policy: 'exact' }]);
    expect(result.record.writes.slice(0, 2)).toEqual([
      { ref: 'parent/asset:reserved-new', path: [], before: { state: 'absent' }, after: { state: 'present', value: {
        media_id: media.object_id, type: 'video', generationId: media.generation_id, variantId: media.variant_id,
      } } },
      { ref: 'parent/clip:born', path: [], before: { state: 'absent' }, after: { state: 'present', value: row } },
    ]);
    expect(result.bundle.parent.clips).toEqual([...(input.parent.clips as JSON[]), row]);
    expect((result.bundle.parent.config as Record<string, JSON>).clips).toEqual(result.bundle.parent.clips);
    expect((result.bundle.parent.registry as Record<string, JSON>).assets).toMatchObject({ picture: expect.anything(), 'reserved-new': expect.anything() });
    expect(input).toEqual(before);
    expect(executeParentClipAddMedia(input, result.command, [verified])).toEqual(result);
  });

  it('retains detached selection and verified response for exact retry after caller mutation and JSON reload', () => {
    const selected = copy(media), response = copy(verified);
    const basis = capture(bundle(), selected, [response]);
    const first = finishParentClipAddMedia(basis);
    selected.catalog_digest = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    response.selection = selected;
    response.duration_seconds = 99;
    expect(finishParentClipAddMedia(JSON.parse(JSON.stringify(basis)))).toEqual(first);
    expect(basis.command.args.media).toEqual(media);
    expect(basis.verifiedMedia).toEqual([verified]);
  });

  it('repairs equal opaque registry mirrors with one effective binding and keeps unknown fields', () => {
    const result = finishParentClipAddMedia(capture(bundle({ opaqueRegistries: true })));
    const expected = {
      opaque: { keep: [null, false, {}] },
      assets: { 'reserved-new': {
        media_id: media.object_id, type: 'video', generationId: media.generation_id, variantId: media.variant_id,
      } },
    };
    expect(result.bundle.parent.registry).toEqual(expected);
    expect((result.bundle.parent.config as Record<string, JSON>).registry).toEqual(expected);
    expect(result.record.writes.slice(0, 2)).toEqual([
      { ref: 'parent', path: ['registry', 'assets'], before: { state: 'absent' }, after: { state: 'present', value: {} } },
      { ref: 'parent/asset:reserved-new', path: [], before: { state: 'absent' }, after: { state: 'present', value: expected.assets['reserved-new'] } },
    ]);
  });

  it('repairs equal empty clip mirrors with the authoritative derived write', () => {
    const result = finishParentClipAddMedia(capture(bundle({ emptyClips: true })));
    expect((result.bundle.parent.config as Record<string, JSON>).clips).toEqual(result.bundle.parent.clips);
    expect(result.record.derived_writes).toEqual([{
      ref: 'parent', path: ['config', 'clips'], before: { state: 'present', value: [] },
      after: { state: 'present', value: [row] }, cause: 0,
    }]);
  });

  it('refuses stale track, occurrence owner, and changed selection without mutation', () => {
    const original = bundle(), basis = capture(original);
    for (const change of ['track', 'owner', 'selection'] as const) {
      const changed = copy(original), command = copy(basis.command) as EditCommand;
      if (change === 'track') {
        ((changed.parent.config as Record<string, JSON>).tracks as JSON[]).push({ id: 'new-track', kind: 'visual' });
      } else if (change === 'owner') {
        (changed.placements[0] as Record<string, JSON>).placement = { track: 'overlay' };
      } else {
        (command.args.media as Record<string, JSON>).catalog_digest =
          'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
      }
      const before = copy(changed);
      expect(() => executeParentClipAddMedia(changed, command, [verified])).toThrowError(ClipMoveError);
      expect(changed).toEqual(before);
    }
  });

  it('refuses fabricated or incomplete media provenance before mutation', () => {
    const input = bundle(), before = copy(input);
    expect(() => capture(input, { asset: media.asset, generation_id: media.generation_id } as MediaSelection, [verified]))
      .toThrow('five-field selection');
    expect(() => capture(input, media, [{ ...verified, selection: { ...media, catalog_digest: 'not-a-digest' } }]))
      .toThrow('exact Runtime-verified media input');
    expect(input).toEqual(before);
  });

  it.each([
    ['present-null hold', { hold: null }],
    ['other speed', { speed: 2 }],
    ['nonfinite from', { from: Number.POSITIVE_INFINITY }],
    ['nonfinite to', { to: Number.POSITIVE_INFINITY }],
    ['zero-length window', { from: 0, to: 0 }],
    ['negative window', { from: 2, to: 1 }],
  ])('retains refusal for newborn carrier candidate with %s', (_label, patch) => {
    const candidate = { ...row, clipType: 'media', from: 0, to: 5, speed: 1 } as Record<string, JSON>;
    delete candidate.hold;
    Object.assign(candidate, patch);
    expect(() => captureParentClipAddMedia(bundle(), candidate, media, [verified])).toThrow();
  });
});

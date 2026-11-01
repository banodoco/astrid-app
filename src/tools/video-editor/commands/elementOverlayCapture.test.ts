import { describe, expect, it } from 'vitest';
import {
  captureElementOverlay,
  captureElementOverlayDelete,
  executeElementOverlay,
  finishElementOverlay,
} from './elementOverlayCapture.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

const bundle = (): AuthoredBundle => ({
  project_id: 'project',
  timeline_id: 'film',
  base_parent: { revision_id: 'parent', content_digest: 'sha256:parent' },
  parent: {
    clips: [{
      id: 'base', clipType: 'media', track: 'picture', at: 0, hold: 4,
      opaque: { sibling: [null, false, 'keep'] },
    }],
    config: {
      clips: [{
        id: 'base', clipType: 'media', track: 'picture', at: 0, hold: 4,
        opaque: { sibling: [null, false, 'keep'] },
      }],
      tracks: [{ id: 'picture', kind: 'visual', role: 'output', unknown: { keep: true } }],
      opaque: { parent: ['keep', null] },
    },
  },
  placements: [],
  shots: {},
  source_mapping: {},
});

const overlay = {
  id: 'overlay-1',
  clipType: 'glow',
  track: 'picture',
  at: 0.5,
  hold: 1.25,
  elementRef: { id: 'glow', kind: 'effect', revision: 'sha256:literal' },
  params: { amount: 0.7, clearable: null },
  opaque: { foreign: ['overlay', null] },
};

describe('bounded literal element overlay capture', () => {
  it('creates and removes one complete overlay while preserving siblings, opaque fields, and mirrors', () => {
    const original = bundle();
    const basis = captureElementOverlay(original, { row: overlay });
    expect(original.parent.clips).toHaveLength(1);
    expect(basis.commands).toHaveLength(1);
    expect(basis.commands[0]).toMatchObject({
      op: 'clip.add', select: 'parent', args: { row: overlay },
    });

    const created = finishElementOverlay(basis);
    expect(created.bundle.parent.clips).toEqual([original.parent.clips[0], overlay]);
    expect(created.bundle.parent.config.clips).toEqual(created.bundle.parent.clips);
    expect(created.records[0]?.created).toEqual([{ ref: 'parent/clip:overlay-1', kind: 'clip', owner: 'parent' }]);

    const removed = executeElementOverlay(created.bundle, [
      captureElementOverlayDelete(created.bundle, 'parent/clip:overlay-1').commands[0]!,
    ]);
    expect(removed.bundle).toEqual(original);
    expect(removed.records[0]?.writes[0]).toMatchObject({
      ref: 'parent/clip:overlay-1', path: [], after: { state: 'absent' },
    });
  });

  it('refuses a missing destination without mutating the draft', () => {
    const input = bundle();
    const snapshot = structuredClone(input);
    expect(() => captureElementOverlay(input, {
      row: { ...overlay, track: 'missing' },
    })).toThrow(/destination track is missing/);
    expect(input).toEqual(snapshot);
  });

  it('keeps selected-pack capture gated on the authenticated Agent authority tuple', () => {
    const input = bundle();
    const snapshot = structuredClone(input);
    expect(() => captureElementOverlay(input, {
      row: { ...overlay, elementRef: { ...overlay.elementRef, packId: 'project-pack' } },
    })).toThrow(/authoritative Agent schema capture/);
    expect(input).toEqual(snapshot);
  });
});

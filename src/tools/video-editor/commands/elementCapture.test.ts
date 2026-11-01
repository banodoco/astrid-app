import { describe, expect, it } from 'vitest';
import type { EditCommand } from '@/integrations/runtime/timeline-commit-types.ts';
import {
  captureClipElement,
  captureClipElementParams,
  executeClipElement,
  finishClipElement,
  finishClipElementParams,
} from './elementCapture.ts';
import { AuthoredState } from './clipMovePrimitives.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

const pin = { document_id: 'document:pack', version: 3, content_digest: 'sha256:pack' } as const;

const bundle = (): AuthoredBundle => ({
  project_id: 'project',
  timeline_id: 'film',
  base_parent: { revision_id: 'parent', content_digest: 'sha256:parent' },
  parent: {
    clips: [{
      id: 'effect',
      clipType: 'effect',
      elementRef: { id: 'effect', kind: 'effect', revision: 'draft-1' },
      params: { keep: { nested: [null, false, 'opaque'] }, value: 1 },
      at: 0,
      hold: 2,
      track: 'picture',
    }],
    config: { clips: [], tracks: [{ id: 'picture', kind: 'visual' }] },
  },
  placements: [],
  shots: {},
  source_mapping: {},
});

const selectedBundle = (): AuthoredBundle => {
  const value = bundle();
  const clip = value.parent.clips[0] as Record<string, unknown>;
  clip.elementRef = { id: 'effect', kind: 'effect', packId: 'pack', revision: 'sha256:old' };
  return value;
};

const assetBackedBundle = (): AuthoredBundle => {
  const value = bundle();
  value.parent.clips = [];
  value.placements = [{ occurrence_id: 'occurrence', shot_id: 'shot', track: 'picture' }];
  value.shots = {
    shot: {
      internal_timeline: {
        clips: [{
          id: 'effect', clipType: 'effect', asset: 'old-picture',
          elementRef: { id: 'effect', kind: 'effect', revision: 'draft-1' },
          params: { value: 1, opaque: { keep: true } }, at: 0, hold: 2, track: 'picture',
        }],
        tracks: [{ id: 'picture', kind: 'visual' }],
        registry: {
          assets: {
            'old-picture': {
              media_id: 'media-id', object_id: 'object-id', digest: 'digest', content_digest: 'content-digest',
              opaque: { keep: true },
            },
          },
        },
      },
    },
  };
  value.source_mapping = { shots: { shot: { shot_id: 'shot' } } };
  return value;
};

const clip = (value: AuthoredBundle, ref = 'parent/clip:effect') => new AuthoredState(value).entity(ref)!;

describe('bounded native existing-clip element capture', () => {
  it('captures a revision and literal params without replacing unknown clip fields', () => {
    const input = bundle();
    const basis = captureClipElement(input, 'parent/clip:effect', {
      elementRef: { id: 'effect', kind: 'effect', revision: 'draft-2' },
    });
    const revision = finishClipElement(basis, {
      elementRef: { id: 'effect', kind: 'effect', revision: 'draft-2' },
    });
    expect(revision.command).toMatchObject({
      op: 'clip.set-element',
      select: 'parent/clip:effect',
      args: { elementRef: { id: 'effect', kind: 'effect', revision: 'draft-2' } },
    });
    expect(clip(revision.bundle).elementRef).toEqual({ id: 'effect', kind: 'effect', revision: 'draft-2' });

    const paramsBasis = captureClipElementParams(revision.bundle, 'parent/clip:effect', {
      values: { value: 2, unknown: { keep: true } }, clear: ['missing'],
    });
    expect(paramsBasis.command.op).toBe('clip.set-params');
    expect((paramsBasis.command.args.values as Record<string, unknown>).unknown).toEqual({ keep: true });
    const params = finishClipElementParams(paramsBasis, {
      values: { value: 2, unknown: { keep: true } }, clear: ['missing'],
    });
    expect(clip(params.bundle).params).toEqual({
      keep: { nested: [null, false, 'opaque'] }, value: 2, unknown: { keep: true },
    });
  });

  it('refuses selected-pack capture without Agent authority and preserves the draft', () => {
    const input = selectedBundle();
    const snapshot = structuredClone(input);
    const args = {
      elementRef: { id: 'effect', kind: 'effect', packId: 'pack', revision: 'sha256:new' },
      schema_source: pin,
    } as const;
    expect(() => captureClipElement(input, 'parent/clip:effect', args))
      .toThrow(/authoritative Agent schema capture/);
    expect(input).toEqual(snapshot);
    expect(() => captureClipElementParams(input, 'parent/clip:effect', {
      values: { literal: { unknown: [null, false] } }, clear: ['value'], schema_source: pin,
    })).toThrow(/authoritative Agent schema capture/);
    expect(input).toEqual(snapshot);
  });

  it('refuses fabricated or missing authority and non-element commands', () => {
    const input = selectedBundle();
    expect(() => captureClipElement(input, 'parent/clip:effect', {
      elementRef: { id: 'effect', kind: 'effect', packId: 'pack', revision: 'sha256:new' },
    })).toThrow(/authoritative Agent schema capture/);
    expect(() => captureClipElement(input, 'parent/clip:effect', {
      elementRef: { id: 'other', kind: 'effect', packId: 'pack', revision: 'sha256:new' },
      schema_source: pin,
    })).toThrow(/keep the element id/);
    expect(() => executeClipElement(input, {
      schema_version: 1, op: 'timeline.apply_element', version: '1', select: 'parent/clip:effect', args: {},
    } as EditCommand)).toThrow(/unsupported clip.set-element/);
  });

  it('captures asset-backed PARAMs in native identity and registry order', () => {
    const input = assetBackedBundle();
    const select = 'occurrence:occurrence/clip:effect';
    const args = { values: { value: 2 }, clear: ['missing'] };
    const basis = captureClipElementParams(input, select, args);
    const result = finishClipElementParams(basis, args);

    expect(result.command.reads!.map((read) => `${read.ref}:${read.path.join('.')}`)).toEqual([
      `${select}:id`,
      'occurrence:occurrence:occurrence_id',
      'occurrence:occurrence/shot:shot_id',
      `${select}:clipType`,
      `${select}:clip_type`,
      `${select}:asset`,
      `${select}:asset_id`,
      `${select}:media_id`,
      `${select}:object_id`,
      `${select}:elementRef`,
      `${select}:element_ref`,
      'occurrence:occurrence/registry:assets.old-picture.media_id',
      'occurrence:occurrence/registry:assets.old-picture.object_id',
      'occurrence:occurrence/registry:assets.old-picture.digest',
      'occurrence:occurrence/registry:assets.old-picture.content_digest',
    ]);
    expect(result.command.reads!.some((read) => read.path.join('.') === 'params')).toBe(false);
    expect(result.record.writes).toContainEqual({
      ref: select, path: ['params', 'value'],
      before: { state: 'present', value: 1 }, after: { state: 'present', value: 2 },
    });
    expect(result.record.writes).toContainEqual({
      ref: select, path: ['params', 'missing'],
      before: { state: 'absent' }, after: { state: 'absent' },
    });
    expect(new AuthoredState(result.bundle).entity(select)!.params).toEqual({
      value: 2, opaque: { keep: true },
    });

    const unchangedArgs = { values: { value: 1 }, clear: [] };
    const unchanged = finishClipElementParams(
      captureClipElementParams(input, select, unchangedArgs), unchangedArgs,
    );
    expect(unchanged.record.writes).toContainEqual({
      ref: select, path: ['params', 'value'],
      before: { state: 'present', value: 1 }, after: { state: 'present', value: 1 },
    });

    const changedRegistry = structuredClone(basis);
    const registry = new AuthoredState(changedRegistry.bundle).entity('occurrence:occurrence/registry')!;
    (registry.assets as Record<string, Record<string, unknown>>)['old-picture'].media_id = 'changed-media';
    expect(() => finishClipElementParams(changedRegistry, args)).toThrow('original capture');
  });
});

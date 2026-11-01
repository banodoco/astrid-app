import { describe, expect, it } from 'vitest';
import type { AuthoredBundle } from './clipMovePrimitives.ts';
import { captureShotSet, finishShotSet } from './shotSetCapture.ts';

function bundle(): AuthoredBundle {
  return {
    schema_version: 1,
    project_id: 'project-1',
    timeline_id: 'timeline-1',
    base_parent: { revision_id: 'parent-1', content_digest: 'sha256:parent' },
    base_parent_payload: { opaque: { preserve: true } },
    base_placements: { 'occ-1': { occurrence_id: 'occ-1', shot_id: 'shot-1' } },
    parent: { config: { tracks: [] }, opaque_parent: { preserve: true } },
    placements: [{ occurrence_id: 'occ-1', shot_id: 'shot-1', placement_opaque: [1, null] }],
    shots: {
      'shot-1': {
        shot_id: 'shot-1',
        base_payload: { name: 'Opening' },
        payload: {
          name: 'Opening',
          settings: { prompt: 'Old', x_unknown: { keep: [null, false] } },
          provenance: { name: 'Legacy', untouched: true },
          opaque: { keep: true },
        },
        base_internal_timeline: {},
        internal_timeline: {},
      },
    },
    source_mapping: {
      placements: { 'occ-1': { occurrence_id: 'occ-1', shot_id: 'shot-1' } },
      shots: {
        'shot-1': {
          shot_id: 'source-shot-1', revision_id: 'shot-rev-1', content_digest: 'sha256:shot',
          internal_timeline_id: 'internal-1', internal_timeline_revision_id: 'internal-rev-1',
          internal_timeline_content_digest: 'sha256:internal', item_id_map: {},
        },
      },
      _runtime_document: {},
    },
  } as AuthoredBundle;
}

describe('portable occurrence-owned shot.set name capture', () => {
  it('keeps the original raw basis, source pin, root name and opaque siblings', () => {
    const original = bundle();
    const basis = captureShotSet(original, 'occurrence:occ-1/shot', { values: { name: 'Opening' }, clear: [] });
    const result = finishShotSet(basis, { values: { name: 'Renamed' }, clear: [] });

    expect(original.shots['shot-1'].payload).toMatchObject({
      name: 'Opening',
      settings: { prompt: 'Old', x_unknown: { keep: [null, false] } },
      provenance: { name: 'Legacy', untouched: true },
    });
    expect(result.bundle.shots['shot-1'].payload).toMatchObject({
      name: 'Renamed',
      settings: { prompt: 'Old', x_unknown: { keep: [null, false] } },
      provenance: { name: 'Legacy', untouched: true },
      opaque: { keep: true },
    });
    expect(result.command).toMatchObject({
      schema_version: 1,
      op: 'shot.set',
      version: '1',
      select: 'occurrence:occ-1/shot',
      intent: { ownership: 'occurrence' },
      bindings: { 'shot.owner': 'occurrence:occ-1' },
      args: { values: { name: 'Renamed' }, clear: [] },
      expect: { 'occurrence:occ-1/shot::payload.name': { state: 'present', value: 'Opening' } },
    });
    expect(result.record.dependencies).toEqual([expect.objectContaining({
      key: 'shot.source', kind: 'entity', policy: 'exact',
      pin: { source: expect.objectContaining({ shot_id: 'source-shot-1', revision_id: 'shot-rev-1' }) },
    })]);
  });

  it('accepts the native empty string while the UI remains responsible for non-empty normalization', () => {
    const result = finishShotSet(
      captureShotSet(bundle(), 'occurrence:occ-1/shot'),
      { values: { name: '' }, clear: [] },
    );
    expect(result.bundle.shots['shot-1'].payload.name).toBe('');
  });

  it('retains native scalar settings semantics without replacing the settings root', () => {
    const result = finishShotSet(
      captureShotSet(bundle(), 'occurrence:occ-1/shot', {
        values: { name: 'Renamed', settings: { prompt: 'Old', turboMode: false } },
        clear: ['settings.negativePrompt'],
      }),
      { values: { name: 'Renamed', settings: { prompt: 'New', turboMode: false } }, clear: ['settings.negativePrompt'] },
    );
    expect(result.bundle.shots['shot-1'].payload).toMatchObject({
      name: 'Renamed',
      settings: { turboMode: false, x_unknown: { keep: [null, false] } },
      provenance: { name: 'Legacy' },
    });
    expect(result.command.authorship).toMatchObject({
      'occurrence:occ-1/shot::payload.name': 'direct',
      'occurrence:occ-1/shot::payload.settings.prompt': 'direct',
    });
  });

  it.each([
    ['a string', 'Revised prompt'],
    ['an explicit null', null],
  ] as const)('preserves %s prompt value and raw siblings', (_label, prompt) => {
    const result = finishShotSet(
      captureShotSet(bundle(), 'occurrence:occ-1/shot', { values: { settings: { prompt: 'Old' } }, clear: [] }),
      { values: { settings: { prompt } }, clear: [] },
    );

    expect(result.bundle.shots['shot-1'].payload.settings).toEqual({
      prompt,
      x_unknown: { keep: [null, false] },
    });
    expect(result.record.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ['payload', 'settings', 'prompt'],
        before: { state: 'present', value: 'Old' },
        after: { state: 'present', value: prompt },
      }),
    ]));
  });

  it('clears prompt presence without replacing other raw settings', () => {
    const result = finishShotSet(
      captureShotSet(bundle(), 'occurrence:occ-1/shot', { values: { settings: { prompt: 'Old' } }, clear: [] }),
      { values: {}, clear: ['settings.prompt'] },
    );

    expect(Object.hasOwn(result.bundle.shots['shot-1'].payload.settings as object, 'prompt')).toBe(false);
    expect(result.bundle.shots['shot-1'].payload.settings).toEqual({
      x_unknown: { keep: [null, false] },
    });
    expect(result.record.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ['payload', 'settings', 'prompt'],
        before: { state: 'present', value: 'Old' },
        after: { state: 'absent' },
      }),
    ]));
  });

  it.each([
    'shot:source', 'parent/shot', 'occurrence:occ-1/shot::name',
  ])('refuses non-occurrence identity %s', (select) => {
    expect(() => captureShotSet(bundle(), select, { values: { name: 'N' }, clear: [] })).toThrow();
  });
});

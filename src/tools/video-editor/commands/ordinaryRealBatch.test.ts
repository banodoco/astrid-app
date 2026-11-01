import { expect, it } from 'vitest';
import fixture from './fixtures/ordinary_real_batch.json';
import { authoringBundleFromDocument } from './authoringBundle.ts';
import { captureGenericPatch } from './genericPatchCapture.ts';
import { AuthoredState } from './clipMovePrimitives.ts';
import type { CanonicalDocument } from '@/integrations/runtime/timeline-commit-types.ts';
import type { TimelinePatch } from '@/sdk/video/timeline/patch.ts';

it('captures the real ordinary five-member move/hold batch on one original closure', async () => {
  const bundle = await authoringBundleFromDocument(fixture.document as CanonicalDocument);
  const before = structuredClone(bundle);
  const captured = captureGenericPatch(bundle, fixture.patch as TimelinePatch, (operation) => operation.target);
  expect(captured.commands).toHaveLength(10);
  expect(captured.commands.map(({ op, select, args }) => ({ op, select, args }))).toEqual(
    fixture.patch.operations.map((operation) => ({
      op: operation.op === 'clip.move' ? 'clip.move' : 'clip.set',
      select: operation.target,
      args: operation.op === 'clip.move' ? { on: operation.payload.at }
        : { values: { hold: operation.payload.hold }, clear: [] },
    })),
  );
  const owner = 'occurrence:f2-occurrence';
  const mapPaths = [
    ['placement', 'start_ms'], ['at_ms'], ['duration_ms'], ['source_offset'],
    ['speed'], ['track'], ['placement', 'track'], ['time_map'], ['timeMap'],
    ['enabled'], ['active'], ['disabled'], ['hidden'], ['deleted'],
  ];
  for (const ordinal of [5, 7, 9]) {
    const command = captured.commands[ordinal];
    const reads = command.reads!;
    const start = reads.findIndex((read) => read.ref === owner && read.path.join('.') === 'placement.start_ms');
    expect(start).toBe(71);
    expect(reads.slice(start, start + mapPaths.length).map((read) => read.path)).toEqual(mapPaths);
    expect(captured.records[ordinal].reads).toEqual(reads);
    expect(captured.records[ordinal].dependencies).toContainEqual({
      key: 'scalar.images', kind: 'entity', policy: 'exact',
      pin: { parent: before.base_parent, source: before.source_mapping.shots['f2-shot'] },
    });
  }
  expect(captured.records.map((record) => record.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(captured.commands.every((command) => command.created?.length === 0)).toBe(true);
  expect(captured.bundle.base_parent_payload).toEqual(before.base_parent_payload);
  expect(captured.bundle.base_placements).toEqual(before.base_placements);
  expect(captured.bundle.source_mapping).toEqual(before.source_mapping);
  const state = new AuthoredState(captured.bundle);
  expect(state.entity('parent/clip:f2-transition-clip')?.transition)
    .toEqual(fixture.document.parent_revision.payload.clips[1].transition);
  expect(state.entity(`${owner}/clip:f2-agent-clip`)).toMatchObject({
    app: { f2Opaque: fixture.document.internal_timeline_revisions[0].payload.clips[1].app?.f2Opaque },
  });
  expect(bundle).toEqual(before);
});

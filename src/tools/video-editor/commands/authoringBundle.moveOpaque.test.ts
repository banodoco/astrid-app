// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CanonicalDocument, CommandRecord, EditCommand, JSON as JsonValue } from '@/integrations/runtime/timeline-commit-types.ts';
import { authoringBundleFromDocument, type AuthoringBundle } from './authoringBundle.ts';
import { captureClipMove, executeClipMove, finishClipMove } from './clipMoveCapture.ts';
import fixture from './fixtures/authoringBundleMoveOpaque.json';

// Native originals are from a610cd3's opaque_film (all three codecs), with separate
// descriptor boundary cases. Export/check: fixtures/authoring_bundle_move_opaque.py.
// This proves offline authored execution, not Runtime/browser acceptance or undo.
type Golden = {
  name: string;
  document: CanonicalDocument;
  bundle: AuthoringBundle;
  select: string;
  on: number;
  capture_command: EditCommand;
  command: EditCommand;
  record: CommandRecord;
  after_bundle: AuthoringBundle;
};
type ObjectValue = { [key: string]: JsonValue };
const goldens = fixture.cases as unknown as Golden[];
const opaque = { 'org.example.notes/v1': {
  foreign_item_id: 'item-1', foreign_item_ids: ['item-2', null, 'item-1'],
  item_id: 'item-1', item_ids: ['item-1', 'item-2'], literal: 'item-1', 'item-1': null,
  nested: [{ selected_item_id: 'item-2', parent_item_id: 'item-1' }, null],
} };

function assertOpaque(row: ObjectValue) {
  for (const field of ['data', 'app', 'opaque']) {
    // Only app.astrid timing values are declared move writes.
    expect(Object.fromEntries(Object.entries(row[field] as ObjectValue)
      .filter(([key]) => key !== 'astrid'))).toEqual(opaque);
  }
}

describe('permanent Agent opaque fixture → App loader → real clip move', () => {
  for (const golden of goldens) {
    it(`matches the complete native capture, command, record and result: ${golden.name}`, async () => {
      const input = structuredClone(golden.document);
      const bundle = await authoringBundleFromDocument(input);
      expect(bundle).toEqual(golden.bundle);
      const basis = captureClipMove(bundle, golden.select);
      expect(basis.command).toEqual(golden.capture_command);
      // Exercise the JSON boundary used by the UI capture port before drop.
      const result = finishClipMove(JSON.parse(JSON.stringify(basis)), golden.on);
      expect(result).toEqual({ command: golden.command, record: golden.record,
        bundle: golden.after_bundle, previewAt: golden.on });
      expect(executeClipMove(bundle, golden.command)).toEqual(result);
      expect(finishClipMove(basis, golden.on)).toEqual(result);
      expect(input).toEqual(golden.document);
      expect(bundle).toEqual(golden.bundle);
      expect(basis.bundle).toEqual(golden.bundle);
    });

    it(`preserves namespaces, item codecs, sources and shared siblings through the move: ${golden.name}`, async () => {
      const input = structuredClone(golden.document);
      const bundle = await authoringBundleFromDocument(input);
      const result = finishClipMove(captureClipMove(bundle, golden.select), golden.on);
      const moved = result.bundle as AuthoringBundle;
      const occurrence = moved.placements[0];
      const shot = moved.shots[occurrence.shot_id as string];
      const source = input.shot_revisions.find((row) => row.revision_id === 'opaque-shot')!.payload;
      const remap = bundle.source_mapping.shots[shot.shot_id].item_id_map;
      const sourceItems = source.items as ObjectValue[];
      const items = shot.payload.items as ObjectValue[];
      expect(items).toHaveLength(2);
      for (const [index, item] of items.entries()) {
        const original = sourceItems[index];
        const originalId = (original.item_id ?? original.id) as string;
        const expected = structuredClone(original);
        const identity = 'item_id' in original ? 'item_id' : 'id';
        expected[identity] = remap[originalId];
        expect(remap[originalId]).not.toBe(originalId);
        if ('item_id' in original && original.id === originalId) expected.id = remap[originalId];
        const metadata = original.metadata;
        const objectMetadata = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata);
        const descriptor = objectMetadata ? expected.metadata as ObjectValue : expected;
        descriptor.source_item_id = remap['item-1'];
        descriptor.source_item = remap['item-2'];
        // Whole-record equality also checks absence, null, list order, nested item-like
        // keys and a different secondary id, including shadowed root source fields.
        expect(item).toEqual(expected);
        if (objectMetadata) expect((item.metadata as ObjectValue).data).toEqual(opaque);
        assertOpaque(item);
      }
      assertOpaque(shot.payload);
      const config = moved.parent.config as ObjectValue;
      const internal = shot.internal_timeline;
      for (const row of [moved.parent, config, (config.tracks as ObjectValue[])[0],
        (moved.parent.clips as ObjectValue[])[0], occurrence, internal,
        (internal.tracks as ObjectValue[])[0], (internal.clips as ObjectValue[])[0]]) assertOpaque(row);
      expect((internal.clips as ObjectValue[])[0].at).toBe(golden.on);
      expect(shot.payload).toEqual(bundle.shots[shot.shot_id].payload);
      for (const sibling of bundle.placements.slice(1)) {
        expect(moved.shots[sibling.shot_id as string]).toEqual(bundle.shots[sibling.shot_id as string]);
      }
      expect(moved.parent).toEqual(bundle.parent);
      expect(moved.placements).toEqual(bundle.placements);
      expect(moved.base_parent_payload).toEqual(bundle.base_parent_payload);
      expect(moved.base_placements).toEqual(bundle.base_placements);
      expect(moved.source_mapping).toEqual(bundle.source_mapping);
      expect(shot.base_payload).toEqual(bundle.shots[shot.shot_id].base_payload);
      expect(shot.base_internal_timeline).toEqual(bundle.shots[shot.shot_id].base_internal_timeline);
      expect(result.record.writes.every((write) => write.ref === golden.select &&
        !write.path.includes('data') && !write.path.includes('opaque'))).toBe(true);
      // Mutating local output cannot mutate its source image or shared occurrence.
      items[0].data = null;
      (internal.clips as ObjectValue[])[0].opaque = null;
      expect(bundle).toEqual(golden.bundle);
      expect(input).toEqual(golden.document);
      expect(moved.source_mapping._runtime_document).toEqual(golden.document);
      const siblingOwner = bundle.placements[1].shot_id as string;
      expect(moved.shots[siblingOwner]).toEqual(golden.bundle.shots[siblingOwner]);
    });
  }
});

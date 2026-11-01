// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CanonicalDocument, EditCommand } from '@/integrations/runtime/timeline-commit-types.ts';
import { authoringBundleFromDocument } from './authoringBundle.ts';
import fixture from './fixtures/recipe_m2_clip_trim.json';
import {
  captureOrdinaryTrimMember,
  executeOrdinaryTrimMember,
  finishOrdinaryTrimMember,
  type OrdinaryTrimOperation,
} from './ordinaryTrimMember.ts';
import type { AuthoredBundle } from './clipMovePrimitives.ts';

type TrimFixture = {
  input: CanonicalDocument;
  records: Array<{ ordinal: number; command: EditCommand; [key: string]: unknown }>;
  output: CanonicalDocument;
};

const golden = fixture as TrimFixture;
const operation = (payload: OrdinaryTrimOperation['payload'] = { in_s: 1, out_s: 5 }): OrdinaryTrimOperation => ({
  op: 'clip.trim', target: 'clip-a', payload,
});

async function bundle(): Promise<AuthoredBundle> {
  return authoringBundleFromDocument(structuredClone(golden.input));
}

describe('ordinary clip.trim patch member', () => {
  it('reuses native capture for the exact command, record, and authored result', async () => {
    const input = await bundle();
    const basis = captureOrdinaryTrimMember(input, operation());
    const prepared = finishOrdinaryTrimMember(basis);
    const outputPayload = golden.output.parent_revision.payload as Record<string, unknown>;

    expect(prepared.command).toEqual(golden.records[0].command);
    expect(prepared.record).toEqual(golden.records[0]);
    expect((prepared.bundle.parent.clips as Array<Record<string, unknown>>)[0])
      .toEqual((outputPayload.clips as Array<Record<string, unknown>>)[0]);
    expect((prepared.bundle.parent.clips as Array<Record<string, unknown>>)[0]).toMatchObject({ speed: 2 });
    expect(Object.isFrozen(basis)).toBe(true);
  });

  it('keeps source-second args and replay guards without mutating input', async () => {
    const input = await bundle();
    const before = structuredClone(input);
    const prepared = finishOrdinaryTrimMember(captureOrdinaryTrimMember(input, operation({ in_s: 9.8999, out_s: 10 })));
    const replay = executeOrdinaryTrimMember(input, prepared.command, 4);

    expect(input).toEqual(before);
    expect(new Set(prepared.record.writes.map((write) => write.path.join('.'))))
      .toEqual(new Set(['from', 'to', 'hold', 'app']));
    expect(replay.command).toEqual(prepared.command);
    expect(replay.bundle).toEqual(prepared.bundle);
  });

  it('rejects malformed, occurrence-owned, and unsupported members before a write', async () => {
    const input = await bundle();
    const before = structuredClone(input);

    expect(() => captureOrdinaryTrimMember(input, operation({ in_s: 'bad' } as never))).toThrow();
    expect(() => finishOrdinaryTrimMember({
      ...captureOrdinaryTrimMember(input, operation()), select: 'occurrence:occ/clip:clip-a',
    })).toThrow('reserved parent clip identity');
    (input.parent.clips[0] as Record<string, unknown>).source_window = { start: 0, end: 10 };
    expect(() => captureOrdinaryTrimMember(input, operation())).toThrow();
    expect(input).toEqual({ ...before, parent: { ...before.parent,
      clips: [{ ...before.parent.clips[0], source_window: { start: 0, end: 10 } }, ...before.parent.clips.slice(1)] } });
  });
});

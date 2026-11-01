import { describe, expect, it } from 'vitest';
import type { EditCommand } from '@/integrations/runtime/timeline-commit-types.ts';
import { selectedParamsCommand } from './clipParamsCapture.ts';

const pin = { document_id: 'pack-doc', version: 3, content_digest: `sha256:${'a'.repeat(64)}` };

describe('selected native PARAM command recipe', () => {
  it('preserves the exact selected values and original schema pin', () => {
    const args = { values: { amount: 0.75 }, clear: [], schema_source: pin };
    expect(selectedParamsCommand('parent/clip:fx-1', args)).toEqual({
      schema_version: 1,
      op: 'clip.set-params',
      version: '1',
      select: 'parent/clip:fx-1',
      args,
    } satisfies EditCommand);
  });

  it.each([
    ['unaddressable select', 'parent/clip:fx-1::forged', { values: {}, clear: [], schema_source: pin }],
    ['missing source pin', 'parent/clip:fx-1', { values: {}, clear: [] }],
    ['non-finite value', 'parent/clip:fx-1', { values: { amount: Number.NaN }, clear: [], schema_source: pin }],
  ])('refuses %s before producing a command', (_name, select, args) => {
    expect(() => selectedParamsCommand(select, args as never)).toThrow();
  });
});

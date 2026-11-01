import { describe, expect, it } from 'vitest';
import type { TimelineCommandBasis } from '../data/DataProvider.ts';
import { createSelectedParamPort, type SelectedParamLiveBasis } from './selectedParamPort.ts';

function live(revisionId: string, generation: number): SelectedParamLiveBasis {
  const basis = {
    head: { revisionId, publicationId: `publication-${revisionId}` },
    canonicalDocument: {} as TimelineCommandBasis['canonicalDocument'],
    history: { items: [], next_cursor: null, head: { revision_id: revisionId, publication_id: `publication-${revisionId}` } },
  } as TimelineCommandBasis;
  return { basis, head: basis.head, generation };
}

describe('selected PARAM live basis port', () => {
  it('refuses a normal accepted-commit basis change during async scope resolution', async () => {
    let current = live('accepted-before', 1);
    const port = createSelectedParamPort(() => current);
    const capture = port.capture({ select: 'parent/clip:effect', rawClip: { id: 'effect' } });
    const originalBasis = capture.live.basis;

    const resolution = port.resolveAsync(capture, async (input) => {
      expect(input.rawClip).toEqual({ id: 'effect' });
      current = live('accepted-after', 2);
      await Promise.resolve();
      return originalBasis;
    });

    await expect(resolution).rejects.toThrow('basis changed; draft preserved');
  });

  it('accepts an unchanged original scope after async resolution', async () => {
    const current = live('accepted', 1);
    const port = createSelectedParamPort(() => current);
    const rawClip = { id: 'effect', params: { value: 4 } };
    const capture = port.capture({ select: 'parent/clip:effect', rawClip });
    rawClip.params.value = 16;

    await expect(port.resolveAsync(capture, async (input) => {
      expect(input.rawClip).toEqual({ id: 'effect', params: { value: 4 } });
      return 'resolved';
    })).resolves.toBe('resolved');
  });
});
